'use strict';
// Módulo puro de costeo — Precios, Producción (recetas, variantes, presentaciones). Spec 2026-10-07 §2.1 (fase 4):
// costo = Σ materias primas ÷ (rendimiento × (1 − merma)) × kg por unidad; sin MO, máquinas, insumos ni corrección.
// Sin fs/SQL/Express: costoDe(plu) → { costo, fuente, nombre? } | null lo inyecta la ruta (el costo de cada materia prima
// en su tab, lib/precios_listado_esquema costoEnSuTab). "Nunca optimista": una materia prima sin costo va a faltantes.
// Los precios NO se calculan acá: salen del motor del esquema (lib/precios_esquema) en los routers.
const { redondear2 } = require('./precios_costeo');
const { ERROR_MARGEN, esMargenValido } = require('./precios_esquema');

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
    rendimientoKg: rend > 0 ? rend : null, kgUtiles: rend > 0 && merma >= 0 && merma < 100 ? rend * (1 - merma / 100) : null,
    costoBatch, costoKg, componentes, costos, faltantes,
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
  // Materias primas de la receta llevadas a UNA unidad (× kg por unidad ÷ kg útiles de la tanda): el "Ver detalle" del
  // modal de precios. Sólo para mostrar: el costo sigue saliendo de costo/kg × kg (la suma puede diferir por redondeo).
  const f = recetaCosteada && recetaCosteada.kgUtiles > 0 && kg > 0 ? kg / recetaCosteada.kgUtiles : null;
  const materiasPrimas = f == null ? [] : recetaCosteada.componentes.map(l => ({
    ...l, cantidad: redondear4(l.cantidad * f), importe: l.importe == null ? null : redondear2(l.importe * f), rol: 'mp' }));
  return {
    plu, nombre, recetaId: p.recetaId, costoUnidad: faltantes.length ? null : receta.importe, componentes: [receta], materiasPrimas,
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

// ── Envasado Apidelta (ej. mieles): Familia › Variedad › PLUs ──
// Un producto envasado = una VARIEDAD: { tipo: 'envasado', familia, nombre (variedad), granelPlu, presentaciones: { plu:
// { kgPorUnidad, componentes: [{ plu, cantidad }], validado? } }, margenEspecial?, creado }. Cada PLU de venta = granel de
// la variedad × su kg por unidad + sus insumos (envase, tapa, etiqueta…). Excepción a "sólo mercadería": los insumos SÍ
// suman. Cada componente con el costo de su tab (costoDe, igual que las materias primas de una receta). Sin rendimiento ni
// merma. Sin costo → faltante con su PLU (nunca 0).
// costearEnvasado costea UN PLU (vista plana { plu, nombre, familia, granelPlu, kgPorUnidad, componentes }).
// costoKgFamilia = precio de materia prima de la familia ($/kg, recetas_produccion.json familias): si está, reemplaza el
// $/kg del granel (fuente 'familia'; el snapshot guarda ese $/kg en el PLU del granel, así cambiarlo marca "a revisar").
function costearEnvasado({ producto, costoDe, costoKgFamilia = null } = {}) {
  const p = producto || {};
  const kg = Number(p.kgPorUnidad);
  const deFamilia = costoValido(costoKgFamilia);
  const familia = deFamilia == null ? {} : { costoUnit: deFamilia, importe: redondear2(deFamilia * kg), fuente: 'familia', familia: p.familia || null };
  const granel = { ...lineaItem({ plu: p.granelPlu, cantidad: kg }, costoDe), ...familia, rol: 'granel' };
  const empaque = (p.componentes || []).map(it => ({ ...lineaItem(it, costoDe), rol: 'empaque' }));
  const { componentes, costos, faltantes } = acumular([granel, ...empaque]);
  const falta = [...faltantes, ...(kg > 0 ? [] : ['kgPorUnidad'])];
  return { plu: p.plu, nombre: p.nombre || null, costoUnidad: falta.length ? null : sumaImportes(componentes), componentes, costos, faltantes: falta };
}

// Variedad envasada con la forma de costearProducto: cada PLU es una presentación (listado, alertas, toast y validar la
// tratan igual que a una presentación de receta), con su snapshot validado en la presentación.
function costearProductoEnvasado({ producto, costoDe, toleranciaPct, costoKgFamilia }) {
  const presentaciones = mapValores(producto.presentaciones, (pr, plu) => {
    const c = costearEnvasado({ producto: { ...pr, plu, familia: producto.familia, granelPlu: producto.granelPlu }, costoDe, costoKgFamilia });
    const conCambios = conEstado(c, pr.validado, toleranciaPct, c.costoUnidad);
    const nombres = Object.fromEntries(c.componentes.filter(l => l.nombre).map(l => [l.plu, l.nombre]));
    return { ...conCambios, revisar: revisionDe(conCambios.cambios, (pr.validado || {}).costos, c.costos, nombres), avisos: [] };
  });
  const filas = Object.values(presentaciones);
  return {
    nombre: producto.nombre, tipo: 'envasado', recetas: {}, presentaciones,
    resumen: { alertas: filas.filter(f => f.estado === 'cambio').length, faltantes: filas.filter(f => f.faltantes.length).length },
  };
}

// Migración perezosa (al leer): un envasado viejo de UN PLU ({ nombre, plu, kgPorUnidad, componentes, validado? }) pasa a
// variedad con ese PLU como única presentación; familia = primera palabra del nombre, la variedad = el resto ("Miel Pradera
// 10Kg" → Miel › "Pradera 10Kg"; una sola palabra queda de nombre, sin familia). Ya migrado u otro tipo → el mismo objeto.
function normalizarEnvasado(p) {
  if (!p || p.tipo !== 'envasado' || p.presentaciones || p.plu == null) return p;
  const { plu, kgPorUnidad, componentes, validado, ...resto } = p;
  const [primera, ...demas] = String(p.nombre || '').trim().split(/\s+/);
  const [familia, nombre] = demas.length ? [primera, demas.join(' ')] : ['', p.nombre];
  return { ...resto, familia, nombre, presentaciones: { [plu]: { kgPorUnidad, componentes: componentes || [], ...(validado ? { validado } : {}) } } };
}

// PLUs de venta de Producción (presentaciones de recetas y PLUs envasados): se venden con el precio de Producción, así que
// no se listan en Reventa. Materias primas, granel e insumos no entran (siguen en su tab).
function plusVentaProduccion(productos) {
  return new Set(Object.values(productos || {}).flatMap(p => Object.keys((normalizarEnvasado(p) || {}).presentaciones || {})));
}

// Todo el producto costeado + estado de cambio y "a revisar" de cada receta/presentación. Una sola función para
// selector, detalle, listado y toast: nunca muestran cosas distintas.
// costoKgFamilia: sólo para un envasado (precio de materia prima de su familia, costoFamiliaDe).
function costearProducto({ producto, costoDe, toleranciaPct, costoKgFamilia = null } = {}) {
  if (producto.tipo === 'envasado') return costearProductoEnvasado({ producto, costoDe, toleranciaPct, costoKgFamilia });
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

// Margen especial del producto: puntos % por canal que se suman al margen general del canal en todas sus presentaciones.
// Cada canal es opcional (null / 0 = sin especial), misma regla que las tablas de margen (> −100, sin tope). Vacío → null (se borra).
const CANALES_MARGEN = ['minorista', 'pack', 'bulto'];
function validarMargenEspecial(body) {
  const b = objeto(body);
  const ajena = Object.keys(b).find(k => !CANALES_MARGEN.includes(k));
  if (ajena) throw new Error(`margenEspecial: canal desconocido "${ajena}" (${CANALES_MARGEN.join(', ')})`);
  const limpio = Object.fromEntries(CANALES_MARGEN.filter(c => b[c] != null && b[c] !== 0).map(c => {
    const v = b[c];
    if (!esMargenValido(v)) throw new Error(`margenEspecial.${c}: ${ERROR_MARGEN}`);
    return [c, v];
  }));
  return Object.keys(limpio).length ? limpio : null;
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

// Nombre de un producto para mensajes y listas: una variedad envasada va con su familia ("Miel Pradera").
const nombreProducto = p => (p.tipo === 'envasado' ? `${p.familia || ''} ${p.nombre}`.trim() : p.nombre);

// Un PLU de venta pertenece a un solo producto: presentación de una receta o PLU de una variedad envasada.
function duenioDelPlu(todosLosProductos, plu, productoId) {
  const otro = Object.entries(todosLosProductos || {}).find(([id, p]) => id !== productoId && p && p.presentaciones && Object.hasOwn(p.presentaciones, plu));
  if (otro) throw new Error(`plu: la presentación ${plu} ya pertenece al producto "${nombreProducto(otro[1])}"`);
}

// Insumos de un PLU envasado: [{ plu, cantidad > 0 }] sin repetir, ni el granel ni el propio PLU.
const COMPONENTES_MAX = 100;
function validarInsumosEnvasado(lista, { plu, granelPlu, campo }) {
  const l = lista == null ? [] : lista;
  if (!Array.isArray(l) || l.length > COMPONENTES_MAX) throw new Error(`${campo}: debe ser una lista de hasta ${COMPONENTES_MAX}`);
  const componentes = l.map((it, i) => {
    const c = objeto(it);
    return { plu: pluValido(c.plu, `${campo}[${i}].plu`), cantidad: positivo(c.cantidad, `${campo}[${i}].cantidad`) };
  });
  const vistos = new Set();
  for (const c of componentes) {
    if (c.plu === granelPlu) throw new Error(`${campo}: el PLU ${c.plu} ya es el granel`);
    if (c.plu === plu) throw new Error(`${campo}: el PLU ${c.plu} es el mismo PLU que se vende`);
    if (vistos.has(c.plu)) throw new Error(`${campo}: PLU ${c.plu} repetido`);
    vistos.add(c.plu);
  }
  return componentes;
}

// Body limpio de una variedad envasada (sólo claves conocidas; validado, creado y margenEspecial los conserva la ruta).
// Sin PLUs vale (alta de la variedad: los PLUs se agregan después). Familia: texto libre, puede ir vacía.
const PRESENTACIONES_MAX = 100;
function validarEnvasado(body, todosLosProductos, { productoId } = {}) {
  const b = objeto(body);
  const familia = typeof b.familia === 'string' ? b.familia.trim() : '';
  if (familia.length > NOMBRE_MAX) throw new Error(`familia: texto de hasta ${NOMBRE_MAX} caracteres`);
  const nombre = texto(b.nombre, 'nombre');
  const granelPlu = pluValido(b.granelPlu, 'granelPlu');
  const pres = b.presentaciones == null ? {} : b.presentaciones;
  if (typeof pres !== 'object' || Array.isArray(pres) || Object.keys(pres).length > PRESENTACIONES_MAX) {
    throw new Error(`presentaciones: debe ser un objeto { plu: { kgPorUnidad, componentes } } de hasta ${PRESENTACIONES_MAX}`);
  }
  const presentaciones = Object.fromEntries(Object.entries(pres).map(([clave, v]) => {
    const plu = pluValido(clave, 'presentaciones: plu');
    if (plu === granelPlu) throw new Error(`presentaciones: el PLU ${plu} es el granel de la variedad`);
    const pr = objeto(v);
    const campo = `presentaciones.${plu}`;
    duenioDelPlu(todosLosProductos, plu, productoId);
    return [plu, { kgPorUnidad: positivo(pr.kgPorUnidad, `${campo}.kgPorUnidad`), componentes: validarInsumosEnvasado(pr.componentes, { plu, granelPlu, campo: `${campo}.componentes` }) }];
  }));
  return { tipo: 'envasado', familia, nombre, granelPlu, presentaciones };
}

// Precio de materia prima por familia: familias = { [nombreFamilia]: { costoKg } } en la raíz de recetas_produccion.json.
// La familia se compara sin mayúsculas ni espacios de más (lo que se tipea en el editor no siempre coincide en mayúsculas).
const claveFamilia = s => String(s || '').trim().toLowerCase();
function costoFamiliaDe(familias, familia) {
  const k = claveFamilia(familia);
  if (!k) return null;
  const v = Object.entries(objeto(familias)).find(([nombre]) => claveFamilia(nombre) === k);
  return v ? costoValido(objeto(v[1]).costoKg) : null;
}
// familias nuevas (no muta): la familia queda con su nombre tal cual; costoKg null la borra (y cualquier variante de mayúsculas).
function conCostoFamilia(familias, familia, costoKg) {
  const k = claveFamilia(familia);
  const resto = Object.fromEntries(Object.entries(objeto(familias)).filter(([nombre]) => claveFamilia(nombre) !== k));
  return costoKg == null ? resto : { ...resto, [familia]: { costoKg } };
}
// PUT de la familia: costoKg número finito > 0; null / vacío = sin precio de familia (vuelve al costo de cada granel).
function validarCostoFamilia(familia, body) {
  const f = texto(familia, 'familia');
  const v = objeto(body).costoKg;
  return { familia: f, costoKg: v == null || v === '' ? null : positivo(v, 'costoKg') };
}

function validarPresentacion(body, producto, todosLosProductos, { plu, productoId } = {}) {
  const b = objeto(body);
  const prod = objeto(producto);
  const pluOk = clavePresentacion(plu);
  const provisoria = CLAVE_PROVISORIA.test(pluOk);
  duenioDelPlu(todosLosProductos, pluOk, productoId);
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

// Limpieza de recetas_produccion.json (fase 5): sin insumos, máquinas, MO ni corrección; los snapshots validados quedan
// sólo con las materias primas del producto (sin _costoHora/_maquina/_correccion ni insumos) y sin el costo total viejo,
// así "a revisar" compara MP contra MP. → { datos, quitadas } o null si no había nada que sacar. No muta.
// ponytail: una MP quitada de la receta después de validar también se poda del snapshot (no avisa "quitada" esa vez).
const CLAVES_MUERTAS_RECETA = ['minutosElaboracion', 'categoriaMaquinaId'];
const CLAVES_MUERTAS_PRESENTACION = ['minutosEmpaquetado', 'correccionPct', 'insumos'];
// El costo total de los snapshots viejos incluía MO/máquina/insumos: se descarta y el Δ% queda null hasta revalidar.
// Corre una vez tras la migración: re-correrla después de revalidar también descartaría los totales nuevos (sólo se pierde el Δ%).
const COSTOS_TOTALES_VALIDADO = ['costoKg', 'costoUnidad'];
function limpiarRecetas(datos) {
  const d = objeto(datos);
  const quitadas = new Set();
  const sacar = (o, claves, donde) => Object.fromEntries(Object.entries(o).filter(([k]) => {
    if (!claves.includes(k)) return true;
    quitadas.add(`${donde}.${k}`);
    return false;
  }));
  const podarValidado = (o, mps, donde) => {
    if (!o.validado) return o;
    const v = sacar(o.validado, COSTOS_TOTALES_VALIDADO, `${donde}.validado`);
    const costos = v.costos;
    const solo = costos && Object.fromEntries(Object.entries(costos).filter(([k]) => mps.has(k)));
    if (costos && Object.keys(solo).length !== Object.keys(costos).length) quitadas.add(`${donde}.validado.costos`);
    return { ...o, validado: costos ? { ...v, costos: solo } : v };
  };
  const productos = Object.fromEntries(Object.entries(objeto(d.productos)).map(([id, p]) => {
    if (p && p.tipo === 'envasado') return [id, p]; // sus snapshots tienen granel e insumos: no es lo de la fase 5
    const recetasIn = objeto(p.recetas);
    const mps = new Set(Object.values(recetasIn).flatMap(r => [...(r.materiasPrimas || []), ...(r.extras || [])]).map(it => String(it.plu)));
    const recetas = Object.fromEntries(Object.entries(recetasIn).map(([rid, r]) => [rid, podarValidado(sacar(r, CLAVES_MUERTAS_RECETA, 'receta'), mps, 'receta')]));
    const presentaciones = Object.fromEntries(Object.entries(objeto(p.presentaciones))
      .map(([plu, pr]) => [plu, podarValidado(sacar(pr, CLAVES_MUERTAS_PRESENTACION, 'presentacion'), mps, 'presentacion')]));
    return [id, { ...sacar(p, ['insumos'], 'producto'), recetas, presentaciones }];
  }));
  const resto = sacar(d, ['insumosManuales', 'categoriasMaquina'], 'archivo');
  return quitadas.size ? { datos: { ...resto, productos }, quitadas: [...quitadas] } : null;
}

module.exports = {
  recetaEfectiva, costearReceta, costearPresentacion, costearProducto, detectarCambios, revisionDe, resumenAlertas, snapshotDe,
  validarProducto, validarMargenEspecial, validarReceta, validarPresentacion, validarBorrarReceta, escalarVariantes,
  formulaParaSiga, CLAVE_PROVISORIA, limpiarRecetas, costearEnvasado, validarEnvasado, normalizarEnvasado, nombreProducto, plusVentaProduccion,
  validarCostoFamilia, costoFamiliaDe, conCostoFamilia,
};
