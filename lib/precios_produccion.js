'use strict';
// Módulo puro de costeo — Precios, Producción (recetas, variantes, presentaciones). Spec 2026-10-07 §2.1 (fase 4):
// costo = Σ materias primas ÷ (rendimiento × (1 − merma)) × kg por unidad; sin MO, máquinas, insumos ni corrección.
// Sin fs/SQL/Express: costoDe(plu) → { costo, fuente, nombre? } | null lo inyecta la ruta (el costo de cada materia prima
// en su tab, lib/precios_listado_esquema costoEnSuTab). "Nunca optimista": una materia prima sin costo va a faltantes.
// Los precios NO se calculan acá: salen del motor del esquema (lib/precios_esquema) en los routers.
const { redondear2 } = require('./precios_costeo');

// Campos que una variante hereda de su base salvo que los pise.
const HEREDABLES = ['rendimientoKg', 'mermaPct'];
const NOMBRE_MAX = 60;
const UNIDADES = ['kg', 'u'];

const claveDe = it => (it.plu != null ? String(it.plu) : it.manualId);

// Costo utilizable: número > 0. Un 0 de SIGA es dato faltante, no "gratis" (nunca cero implícito).
function costoValido(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

// Receta con la variante resuelta: materias primas = base + extras, campos heredados salvo override.
// Un solo nivel: la base de una variante no puede ser a su vez variante. validado nunca se hereda.
// Rendimiento de la variante (kg por tanda): el explícito si lo tiene; si no, el de la base + Σ kg
// de extras (los extras en 'u' no suman). La merma heredada se aplica sobre ese rendimiento total,
// igual que en la base — no hay merma separada para los extras.
function recetaEfectiva(receta, recetasDelProducto) {
  if (!receta.varianteDe) return { ...receta, materiasPrimas: receta.materiasPrimas || [] };
  const base = (recetasDelProducto || {})[receta.varianteDe];
  if (!base) throw new Error(`varianteDe: la receta base "${receta.varianteDe}" no existe`);
  if (base.varianteDe) throw new Error('varianteDe: una variante no puede ser base de otra variante');
  const extras = receta.extras || [];
  const heredados = Object.fromEntries(HEREDABLES.map(k => [k, receta[k] != null ? receta[k] : base[k]]));
  const kgExtras = extras.filter(e => (e.unidad || 'kg') === 'kg').reduce((s, e) => s + (Number(e.cantidad) || 0), 0);
  const rendimientoKg = receta.rendimientoKg != null ? receta.rendimientoKg : Number(base.rendimientoKg) + kgExtras;
  return { ...receta, ...heredados, rendimientoKg, materiasPrimas: [...(base.materiasPrimas || []), ...extras] };
}

// Línea de costo de una materia prima × cantidad. Sin costo → costoUnit/importe null.
function lineaItem(it, costoDe) {
  const c = costoDe(claveDe(it));
  const costoUnit = costoValido(c && c.costo);
  return {
    plu: claveDe(it), nombre: (c && c.nombre) || null, cantidad: it.cantidad, costoUnit,
    importe: costoUnit == null ? null : redondear2(costoUnit * it.cantidad), fuente: (c && c.fuente) || null,
  };
}

// Acumula líneas en { componentes, costos (snapshot comparable), faltantes }. costos guarda el
// costo unitario, que es lo que se compara al detectar cambios.
function acumular(lineas) {
  return {
    componentes: lineas,
    costos: Object.fromEntries(lineas.map(l => [l.plu, l.costoUnit])),
    faltantes: lineas.filter(l => l.importe == null).map(l => l.plu),
  };
}

const sumaImportes = lineas => redondear2(lineas.reduce((s, l) => s + l.importe, 0));

// Costeo de una receta (o variante) por batch y por kg neto de merma:
// costoKg = costoBatch / (rendimientoKg × (1 − mermaPct/100)), costoBatch = Σ materias primas.
function costearReceta({ receta, recetasDelProducto, costoDe } = {}) {
  const ef = recetaEfectiva(receta, recetasDelProducto);
  const { componentes, costos, faltantes } = acumular(ef.materiasPrimas.map(mp => lineaItem(mp, costoDe)));
  const rend = Number(ef.rendimientoKg);
  const merma = Number(ef.mermaPct) || 0;
  if (!(rend > 0)) faltantes.push('rendimientoKg');
  if (merma < 0 || merma >= 100) faltantes.push('mermaPct');
  const costoBatch = faltantes.length ? null : sumaImportes(componentes);
  const costoKg = costoBatch == null ? null : redondear2(costoBatch / (rend * (1 - merma / 100)));
  // Variedad: cuánto suman los ingredientes de la base (fila fija "Receta base" en su tabla de extras).
  const nBase = ef.varianteDe ? (((recetasDelProducto || {})[ef.varianteDe] || {}).materiasPrimas || []).length : 0;
  const deBase = componentes.slice(0, nBase);
  const baseIng = ef.varianteDe ? { costoBaseIngredientes: deBase.some(l => l.importe == null) ? null : sumaImportes(deBase) } : {};
  // Variedad: desglose del producto terminado por tanda para la UI (los extras son para una tanda de la
  // base y suman peso; los extras en 'u' no suman). Sólo datos: la cuenta de costo no cambia.
  const kg3 = n => Math.round(n * 1000) / 1000;
  const extras = receta.extras || [];
  const desglose = ef.varianteDe ? { desglose: {
    baseKg: Number(((recetasDelProducto || {})[ef.varianteDe] || {}).rendimientoKg) || null,
    extrasKg: kg3(extras.filter(e => (e.unidad || 'kg') === 'kg').reduce((t, e) => t + (Number(e.cantidad) || 0), 0)),
    extrasEnUnidades: extras.some(e => e.unidad === 'u'),
    totalKg: rend > 0 ? rend : null, rendimientoPropio: receta.rendimientoKg != null,
    mermaPct: merma, utilKg: rend > 0 ? kg3(rend * (1 - merma / 100)) : null,
  } } : {};
  return {
    ...baseIng, ...desglose,
    nombre: ef.nombre, varianteDe: ef.varianteDe || null,
    rendimientoKg: rend > 0 ? rend : null, costoBatch, costoKg, componentes, costos, faltantes,
  };
}

// Costeo de una presentación (PLU vendible): kg de receta × costo/kg de la receta. Hereda los faltantes de su receta.
// Snapshot = el de la receta: una materia prima que sube marca la receta Y cada presentación que la usa.
function costearPresentacion({ plu, nombre = null, presentacion, recetaCosteada } = {}) {
  const p = presentacion || {};
  const kg = Number(p.kgPorUnidad);
  const costoKg = recetaCosteada ? recetaCosteada.costoKg : null;
  const receta = {
    plu: '_receta', nombre: recetaCosteada ? recetaCosteada.nombre : null, cantidad: kg, costoUnit: costoKg,
    importe: costoKg == null || !(kg > 0) ? null : redondear2(costoKg * kg), fuente: 'receta',
  };
  const faltantes = [...new Set([...(recetaCosteada ? recetaCosteada.faltantes : ['receta']), ...(kg > 0 ? [] : ['kgPorUnidad'])])];
  return {
    plu, nombre, recetaId: p.recetaId, costoUnidad: faltantes.length ? null : receta.importe, componentes: [receta],
    costos: { ...(recetaCosteada ? recetaCosteada.costos : {}) }, faltantes,
  };
}

// Δ% de antes → ahora, 1 decimal (como compararConVigente). null si falta uno solo o antes es 0.
function deltaPct(antes, ahora) {
  if (antes == null || ahora == null) return antes == ahora ? 0 : null; // eslint-disable-line eqeqeq
  if (antes === ahora) return 0;
  if (antes === 0) return null;
  return +(((ahora - antes) / antes) * 100).toFixed(1);
}

// Compara los costos actuales contra el snapshot validado (pull, no eventos). 'cambio' si algún
// componente se movió más que toleranciaPct (el borde es ok), pasó a faltar, o se agregó/quitó.
// deltaPct = variación del costo total validado (costoKg o costoUnidad) contra costoActual.
function detectarCambios({ validado, costosActuales, costoActual = null, toleranciaPct } = {}) {
  if (!validado || !validado.costos) return { estado: 'sin-validar', deltaPct: null, componentes: [], nuevos: [], quitados: [] };
  const antes = validado.costos;
  const ahora = costosActuales || {};
  const tol = Number(toleranciaPct) || 0;
  const nuevos = Object.keys(ahora).filter(k => !Object.hasOwn(antes, k));
  const quitados = Object.keys(antes).filter(k => !Object.hasOwn(ahora, k));
  const componentes = Object.keys(ahora).filter(k => Object.hasOwn(antes, k))
    .map(k => ({ plu: k, antes: antes[k], ahora: ahora[k], deltaPct: deltaPct(antes[k], ahora[k]) }))
    .filter(c => c.deltaPct === null || Math.abs(c.deltaPct) > tol);
  const hayCambio = componentes.length || nuevos.length || quitados.length;
  const costoValidado = validado.costoKg !== undefined ? validado.costoKg : validado.costoUnidad;
  return { estado: hayCambio ? 'cambio' : 'ok', deltaPct: deltaPct(costoValidado, costoActual), componentes, nuevos, quitados };
}

// Snapshot a guardar como `validado` de una receta (costoKg) o presentación (costoUnidad).
function snapshotDe(costeo, fecha) {
  const total = costeo.costoKg !== undefined ? { costoKg: costeo.costoKg } : { costoUnidad: costeo.costoUnidad };
  return { fecha, ...total, costos: { ...costeo.costos } };
}

function conEstado(costeo, validado, toleranciaPct, costoActual) {
  const cambios = detectarCambios({ validado, costosActuales: costeo.costos, costoActual, toleranciaPct });
  return { ...costeo, estado: cambios.estado, cambios };
}

// "A revisar" (spec §2.1): materias primas cuyo costo se movió desde la última validación, con nombre, costo anterior y
// nuevo (agregadas: antes null; quitadas: ahora null). antes/ahora = costos del snapshot validado y actuales. Sin
// estado 'cambio' → null.
function revisionDe(cambios, antes = {}, ahora = {}, nombres = {}) {
  if (!cambios || cambios.estado !== 'cambio') return null;
  return [...cambios.componentes.map(c => c.plu), ...cambios.nuevos, ...cambios.quitados]
    .map(plu => ({ plu, nombre: nombres[plu] || null, antes: antes[plu] ?? null, ahora: ahora[plu] ?? null }));
}

const mapValores = (obj, fn) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, fn(v, k)]));

// Todo el producto costeado + estado de cambio y "a revisar" de cada receta/presentación. Una sola función para
// selector, detalle, listado y toast: nunca muestran cosas distintas.
function costearProducto({ producto, costoDe, toleranciaPct } = {}) {
  const recetasIn = producto.recetas || {};
  const costeadas = mapValores(recetasIn, (r, id) => {
    const c = costearReceta({ receta: r, recetasDelProducto: recetasIn, costoDe });
    return conEstado({ id, ...c }, r.validado, toleranciaPct, c.costoKg);
  });
  const nombres = Object.fromEntries(Object.values(costeadas).flatMap(r => r.componentes.map(l => [l.plu, l.nombre])).filter(([, n]) => n));
  const conRevision = (f, validado) => ({ ...f, revisar: revisionDe(f.cambios, (validado || {}).costos, f.costos, nombres) });
  const recetas = mapValores(costeadas, (r, id) => conRevision(r, recetasIn[id].validado));
  const presentaciones = mapValores(producto.presentaciones, (p, plu) => {
    const c = costearPresentacion({ plu, nombre: p.nombre || null, presentacion: p, recetaCosteada: recetas[p.recetaId] });
    // Dato viejo: presentación sobre una receta base (decisión 14 pide una variedad). Se costea igual y avisa.
    const receta = recetasIn[p.recetaId];
    const avisos = receta && !receta.varianteDe ? ['variedad'] : [];
    return { ...conRevision(conEstado(c, p.validado, toleranciaPct, c.costoUnidad), p.validado), avisos, formulaSiga: formulaParaSiga(producto, plu) };
  });
  const filas = [...Object.values(recetas), ...Object.values(presentaciones)];
  return {
    nombre: producto.nombre, recetas, presentaciones,
    resumen: { alertas: filas.filter(f => f.estado === 'cambio').length, faltantes: filas.filter(f => f.faltantes.length).length },
  };
}

// Decisión 12: los extras de una variedad son "por tanda de la base". Si la base cambia su kg por
// tanda, sus variedades escalan extras (y su rendimientoKg explícito, si lo tienen) por el mismo factor,
// a 4 decimales. `validado` no se toca: si el costo por kg se mueve, queda visible como 'cambio'.
const redondear4 = n => Math.round(n * 1e4) / 1e4;
function escalarVariantes(recetas, baseId, factor) {
  if (!(Number(factor) > 0) || factor === 1) return recetas;
  return Object.fromEntries(Object.entries(recetas || {}).map(([id, r]) => {
    if (!r || r.varianteDe !== baseId) return [id, r];
    const extras = (r.extras || []).map(e => ({ ...e, cantidad: redondear4(Number(e.cantidad) * factor) }));
    const rend = r.rendimientoKg != null ? { rendimientoKg: redondear4(Number(r.rendimientoKg) * factor) } : {};
    return [id, { ...r, extras, ...rend }];
  }));
}

// Decisión 13: el módulo NO escribe en SIGA. Para que el usuario cargue la fórmula a mano: componentes
// por UNIDAD vendida. Ingredientes de la variedad (base + extras) por unidad vendida (sin insumos: fase 4) =
// cantidad / rendimiento efectivo × kgPorUnidad (4 decimales, su unidad).
function formulaParaSiga(producto, clave) {
  const pres = ((producto && producto.presentaciones) || {})[clave];
  const receta = pres && (producto.recetas || {})[pres.recetaId];
  if (!receta) return [];
  let ef;
  try { ef = recetaEfectiva(receta, producto.recetas); } catch { return []; }
  const rend = Number(ef.rendimientoKg), kg = Number(pres.kgPorUnidad);
  const ingredientes = rend > 0 && kg > 0 ? ef.materiasPrimas.map(mp => ({
    plu: String(mp.plu), cantidad: redondear4(Number(mp.cantidad) / rend * kg), unidad: mp.unidad || 'kg', origen: 'ingrediente',
  })) : [];
  return ingredientes;
}

// Alertas para el toast: sólo estado 'cambio' (sin-validar no avisa). Mayor |Δ%| primero.
// productosCosteados = { productoId: costearProducto(...) }.
function resumenAlertas(productosCosteados) {
  const items = Object.entries(productosCosteados || {}).flatMap(([productoId, p]) =>
    [['receta', p.recetas], ['presentacion', p.presentaciones]].flatMap(([tipo, filas]) =>
      Object.entries(filas || {}).filter(([, f]) => f.estado === 'cambio').map(([id, f]) => ({
        productoId, producto: p.nombre, tipo, id, nombre: f.nombre || id, deltaPct: f.cambios.deltaPct, componentes: f.revisar || [],
      }))));
  const orden = i => Math.abs(i.deltaPct == null ? 0 : i.deltaPct);
  return { total: items.length, items: [...items].sort((a, b) => orden(b) - orden(a)) };
}

// ── Validadores (rechazo fuerte con throw, mismo patrón que validarCostosExtra) ──

function objeto(b) { return b && typeof b === 'object' ? b : {}; }

function texto(v, campo) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > NOMBRE_MAX) throw new Error(`${campo}: texto de 1 a ${NOMBRE_MAX} caracteres`);
  return s;
}

function pluValido(v, campo) {
  const s = v == null ? '' : String(v).trim();
  if (!/^\d+$/.test(s)) throw new Error(`${campo}: debe ser un PLU numérico`);
  return s;
}

function positivo(v, campo) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`${campo}: debe ser un número mayor a 0`);
  return v;
}

function mermaValida(v, campo) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v >= 100) throw new Error(`${campo}: debe ser un % de 0 a menos de 100`);
  return v;
}

const opcional =(b, k, fn) => (b[k] == null ? {} : { [k]: fn(b[k], k) });

function validarProducto(body) {
  return { nombre: texto(objeto(body).nombre, 'nombre') };
}

function validarMateriasPrimas(lista, campo) {
  if (!Array.isArray(lista)) throw new Error(`${campo}: debe ser una lista`);
  return lista.map((it, i) => {
    if (!it || typeof it !== 'object') throw new Error(`${campo}[${i}]: ítem inválido`);
    const unidad = it.unidad == null ? 'kg' : it.unidad;
    if (!UNIDADES.includes(unidad)) throw new Error(`${campo}[${i}].unidad: debe ser ${UNIDADES.join(' o ')}`);
    return { plu: pluValido(it.plu, `${campo}[${i}].plu`), cantidad: positivo(it.cantidad, `${campo}[${i}].cantidad`), unidad };
  });
}

// Variante: un solo nivel, base existente del mismo producto, y la receta que se guarda no puede
// ser base de otras variantes (quedaría variante de variante).
function validarVariante(b, recetas, recetaId) {
  if (b.varianteDe === recetaId) throw new Error('varianteDe: una receta no puede ser variante de sí misma');
  const base = recetas[b.varianteDe];
  if (!base) throw new Error(`varianteDe: la receta base "${b.varianteDe}" no existe`);
  if (base.varianteDe) throw new Error('varianteDe: no se puede crear una variante de una variante');
  if (Object.values(recetas).some(r => r && r.varianteDe === recetaId)) {
    throw new Error(`varianteDe: "${recetaId}" tiene variantes, no puede pasar a ser variante`);
  }
  return {
    varianteDe: b.varianteDe, extras: validarMateriasPrimas(b.extras || [], 'extras'),
    ...opcional(b, 'rendimientoKg', positivo),
  };
}

// Body limpio de una receta (sólo claves conocidas). `validado` no se toca: editar la receta
// no re-valida (lo conserva la ruta).
function validarReceta(body, producto, recetaId) {
  const b = objeto(body);
  const recetas = (producto && producto.recetas) || {};
  const nucleo = b.varianteDe != null ? validarVariante(b, recetas, recetaId) : validarBase(b);
  return {
    nombre: texto(b.nombre, 'nombre'), ...nucleo,
    ...opcional(b, 'mermaPct', mermaValida),
  };
}

function validarBase(b) {
  const materiasPrimas = validarMateriasPrimas(b.materiasPrimas, 'materiasPrimas');
  if (!materiasPrimas.length) throw new Error('materiasPrimas: la receta base necesita al menos una materia prima');
  return { rendimientoKg: positivo(b.rendimientoKg, 'rendimientoKg'), materiasPrimas };
}

// Una receta no se borra si es base de variantes o la usa alguna presentación.
function validarBorrarReceta(producto, recetaId) {
  const p = objeto(producto);
  const variantes = Object.entries(p.recetas || {}).filter(([, r]) => r && r.varianteDe === recetaId).map(([id]) => id);
  if (variantes.length) throw new Error(`no se puede borrar: tiene variantes (${variantes.join(', ')})`);
  const usos = Object.entries(p.presentaciones || {}).filter(([, pr]) => pr && pr.recetaId === recetaId).map(([plu]) => plu);
  if (usos.length) throw new Error(`no se puede borrar: la usan las presentaciones ${usos.join(', ')}`);
}

// Body limpio de una presentación. Un PLU de presentación pertenece a un solo producto.
// Clave de presentación: PLU de SIGA o provisoria "n-<slug>" (todavía no está en SIGA; decisión 13).
const CLAVE_PROVISORIA = /^n-[a-z0-9-]{1,40}$/;
function clavePresentacion(v) {
  const s = v == null ? '' : String(v).trim();
  if (CLAVE_PROVISORIA.test(s)) return s;
  return pluValido(s, 'plu');
}

function validarPresentacion(body, producto, todosLosProductos, { plu, productoId } = {}) {
  const b = objeto(body);
  const prod = objeto(producto);
  const pluOk = clavePresentacion(plu);
  const provisoria = CLAVE_PROVISORIA.test(pluOk);
  const otro = Object.entries(todosLosProductos || {})
    .find(([id, p]) => id !== productoId && p && p.presentaciones && Object.hasOwn(p.presentaciones, pluOk));
  if (otro) throw new Error(`plu: la presentación ${pluOk} ya pertenece al producto "${otro[1].nombre}"`);
  if (typeof b.recetaId !== 'string' || !Object.hasOwn(prod.recetas || {}, b.recetaId)) {
    throw new Error('recetaId: la receta no existe en este producto');
  }
  if (!prod.recetas[b.recetaId].varianteDe) {
    throw new Error('recetaId: elegí una variedad, no la receta base (si el producto no tiene sabores, creá una variedad sin extras)');
  }
  if (provisoria && b.nombre == null) throw new Error('nombre: una presentación que todavía no está en SIGA necesita nombre');
  return {
    recetaId: b.recetaId, kgPorUnidad: positivo(b.kgPorUnidad, 'kgPorUnidad'),
    ...opcional(b, 'nombre', v => texto(v, 'nombre')),
  };
}

// PLUs SIGA que muestra la tab Producción: claves de presentaciones con PLU (las provisorias n-… no están
// en SIGA) + los pack/bulto vinculados a ellas (vinculos de vinculosPackBulto, las sub-filas del detalle).
// Sólo dígitos: seguros para interpolar en SQL. Sin vinculos (sin SIGA) sólo las presentaciones.
const PLU_SIGA = /^\d{1,12}$/;
function plusProduccion(datos, vinculos = []) {
  const pres = new Set(Object.values(objeto(objeto(datos).productos))
    .flatMap(p => Object.keys(objeto(objeto(p).presentaciones)).map(k => k.trim()))
    .filter(k => PLU_SIGA.test(k)));
  const pb = (vinculos || []).filter(v => v && pres.has(String(v.basePlu).trim()))
    .map(v => String(v.plu).trim()).filter(k => PLU_SIGA.test(k));
  return [...new Set([...pres, ...pb])].sort((a, b) => Number(a) - Number(b));
}

module.exports = {
  plusProduccion,
  recetaEfectiva, costearReceta, costearPresentacion, costearProducto, detectarCambios, revisionDe, resumenAlertas, snapshotDe,
  validarProducto, validarReceta, validarPresentacion, validarBorrarReceta, escalarVariantes,
  formulaParaSiga, CLAVE_PROVISORIA,
};
