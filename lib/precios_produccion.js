'use strict';
// Módulo puro de costeo — Precios, Fase 3: Producción (recetas, variantes, presentaciones).
// Sin fs/SQL/Express: costoDe(clave) → { costo, fuente, nombre? } | null lo inyecta la ruta
// (clave = PLU SIGA o id de insumo manual). Mismo criterio "nunca optimista" que
// precios_costeo.js: un componente sin costo va a faltantes y no hay costo total ni precio.

const { resolverBanda, aplicarMarkup, conIva, redondearPrecioVenta, redondear2, markupDesdeGanancia } = require('./precios_costeo');

// Campos que una variante hereda de su base salvo que los pise.
const HEREDABLES = ['rendimientoKg', 'mermaPct', 'minutosElaboracion', 'categoriaMaquinaId'];
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

// Línea de costo de un ítem (materia prima o insumo) × cantidad. Sin costo → costoUnit/importe null.
function lineaItem(it, costoDe) {
  const c = costoDe(claveDe(it));
  const costoUnit = costoValido(c && c.costo);
  return {
    plu: claveDe(it), nombre: (c && c.nombre) || null, cantidad: it.cantidad, costoUnit,
    importe: costoUnit == null ? null : redondear2(costoUnit * it.cantidad), fuente: (c && c.fuente) || null,
  };
}

// Línea por minutos a un costo/hora (mano de obra o máquina): costoHora/60 × minutos.
function lineaMinutos(clave, nombre, minutos, costoHora, fuente) {
  const hora = costoValido(costoHora);
  const costoUnit = hora == null ? null : hora / 60;
  return { plu: clave, nombre, cantidad: minutos, costoUnit, importe: hora == null ? null : redondear2(costoUnit * minutos), fuente };
}

// Acumula líneas en { componentes, costos (snapshot comparable), faltantes }. costos guarda el
// costo unitario (o costo/hora para _costoHora/_maquina), que es lo que se compara al detectar cambios.
function acumular(lineas, costoSnapshot = l => l.costoUnit) {
  return {
    componentes: lineas,
    costos: Object.fromEntries(lineas.map(l => [l.plu, costoSnapshot(l)])),
    faltantes: lineas.filter(l => l.importe == null).map(l => l.plu),
  };
}

const costoHoraDe = l => (l.costoUnit == null ? null : redondear2(l.costoUnit * 60));
const snapshotLinea = l => (l.plu === '_costoHora' || l.plu === '_maquina' ? costoHoraDe(l) : l.costoUnit);
const sumaImportes = lineas => redondear2(lineas.reduce((s, l) => s + l.importe, 0));

// Mano de obra + máquina de un batch. Sin categoría de máquina (o inexistente) → 0 + aviso, no faltante.
function lineasElaboracion(ef, costoHora, categoriasMaquina) {
  const minutos = Number(ef.minutosElaboracion) || 0;
  if (minutos <= 0) return { lineas: [], avisos: [] };
  const lineas = [lineaMinutos('_costoHora', 'Mano de obra', minutos, costoHora, 'config')];
  const cat = (categoriasMaquina || []).find(c => c && c.id === ef.categoriaMaquinaId);
  if (!cat || costoValido(cat.costoHora) == null) {
    return { lineas, avisos: ['Sin categoría de máquina con costo/hora: costo de máquina 0'] };
  }
  return { lineas: [...lineas, lineaMinutos('_maquina', cat.nombre || cat.id, minutos, cat.costoHora, 'config')], avisos: [] };
}

// Costeo de una receta (o variante) por batch y por kg neto de merma:
// costoKg = costoBatch / (rendimientoKg × (1 − mermaPct/100)).
function costearReceta({ receta, recetasDelProducto, costoDe, costoHora, categoriasMaquina } = {}) {
  const ef = recetaEfectiva(receta, recetasDelProducto);
  const elab = lineasElaboracion(ef, costoHora, categoriasMaquina);
  const lineas = [...ef.materiasPrimas.map(mp => lineaItem(mp, costoDe)), ...elab.lineas];
  const { componentes, costos, faltantes } = acumular(lineas, snapshotLinea);
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
    rendimientoKg: rend > 0 ? rend : null, costoBatch, costoKg, componentes, costos, faltantes, avisos: elab.avisos,
  };
}

// Corrección por presentación (Excel: ×1,05): costo de receta × correccionPct/100, como línea aparte
// para que el desglose la muestre. Es config, no costo: fuera del snapshot, editarla no alerta.
function lineaCorreccion(receta, correccionPct) {
  const pct = Number(correccionPct) || 0;
  if (!pct) return [];
  const importe = receta.importe == null ? null : redondear2(receta.costoUnit * receta.cantidad * pct / 100);
  return [{ plu: '_correccion', nombre: `Corrección ${pct}%`, cantidad: pct, costoUnit: null, importe, fuente: 'config' }];
}

// Costeo de una presentación (PLU vendible): kg de receta + insumos + MO de empaquetado,
// markup por banda de producción (u override por PLU) y redondeo a $50 como en Almacén (sin ×1,21, ver IVA_VENTA).
// Hereda los faltantes de su receta: sin costo de receta no hay precio.
function costearPresentacion({ plu, nombre = null, presentacion, recetaCosteada, costoDe, costoHora, bandas, overridePct, gastosVentaPct = 0 } = {}) {
  const p = presentacion || {};
  const kg = Number(p.kgPorUnidad);
  const costoKg = recetaCosteada ? recetaCosteada.costoKg : null;
  const receta = {
    plu: '_receta', nombre: recetaCosteada ? recetaCosteada.nombre : null, cantidad: kg, costoUnit: costoKg,
    importe: costoKg == null || !(kg > 0) ? null : redondear2(costoKg * kg), fuente: 'receta',
  };
  const minutos = Number(p.minutosEmpaquetado) || 0;
  const lineas = [
    ...(p.insumos || []).map(it => lineaItem(it, costoDe)),
    ...(minutos > 0 ? [lineaMinutos('_costoHora', 'Mano de obra empaquetado', minutos, costoHora, 'config')] : []),
  ];
  const acc = acumular(lineas, snapshotLinea);
  // El snapshot incluye los componentes de la receta efectiva (MP base + extras, _costoHora, _maquina):
  // un ingrediente que sube marca la receta Y cada presentación que la usa. Clave repetida
  // (_costoHora de elaboración y de empaquetado) = mismo costo/hora global, una sola entrada.
  const costos = { ...(recetaCosteada ? recetaCosteada.costos : {}), ...acc.costos };
  const faltantes = [
    ...(recetaCosteada ? recetaCosteada.faltantes : ['receta']),
    ...(kg > 0 ? [] : ['kgPorUnidad']),
    ...acc.faltantes,
  ];
  const componentes = [receta, ...lineaCorreccion(receta, p.correccionPct), ...acc.componentes];
  const costoUnidad = faltantes.length ? null : sumaImportes(componentes);
  return { plu, nombre, recetaId: p.recetaId, costoUnidad, componentes, costos, ...precioDe(costoUnidad, bandas, overridePct, faltantes, gastosVentaPct) };
}

// La banda de producción guarda ganancia: se convierte a markup total con los gastos sobre venta
// (gananciaPct la expone). El override por PLU ya es markup total: no se convierte (gananciaPct null).
function precioDe(costoUnidad, bandas, overridePct, faltantesPrevios, gastosVentaPct = 0) {
  const vacio = { markupPct: null, gananciaPct: null, banda: null, precioNeto: null, precioConIva: null, precioConIvaExacto: null };
  if (costoUnidad == null) return { ...vacio, faltantes: [...new Set(faltantesPrevios)] };
  const r = resolverBanda(costoUnidad, bandas, overridePct);
  const gananciaPct = r.banda === 'override' ? null : r.markupPct;
  const markupPct = gananciaPct == null ? r.markupPct : markupDesdeGanancia(gananciaPct, gastosVentaPct);
  if (markupPct == null) return { ...vacio, faltantes: [...faltantesPrevios, 'markupPct'] };
  const precioNeto = redondear2(aplicarMarkup(costoUnidad, markupPct));
  return {
    markupPct, gananciaPct, banda: r.banda, precioNeto,
    precioConIva: redondearPrecioVenta(conIva(precioNeto)),
    precioConIvaExacto: redondear2(conIva(precioNeto)),
    faltantes: [],
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

const mapValores = (obj, fn) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, fn(v, k)]));

// Todo el producto costeado + estado de cambio de cada receta/presentación. Una sola función para
// selector, detalle y toast: nunca muestran cosas distintas.
function costearProducto({ producto, costoDe, costoHora, categoriasMaquina, bandas, margenPorProducto, toleranciaPct, gastosVentaPct = 0 } = {}) {
  const recetasIn = producto.recetas || {};
  const recetas = mapValores(recetasIn, (r, id) => {
    const c = costearReceta({ receta: r, recetasDelProducto: recetasIn, costoDe, costoHora, categoriasMaquina });
    return conEstado({ id, ...c }, r.validado, toleranciaPct, c.costoKg);
  });
  const presentaciones = mapValores(producto.presentaciones, (p, plu) => {
    const c = costearPresentacion({
      plu, nombre: p.nombre || null, presentacion: p, recetaCosteada: recetas[p.recetaId], costoDe, costoHora,
      bandas, overridePct: (margenPorProducto || {})[plu], gastosVentaPct,
    });
    // Dato viejo: presentación sobre una receta base (decisión 14 pide una variedad). Se costea igual y avisa.
    const receta = (recetasIn || {})[p.recetaId];
    const avisos = receta && !receta.varianteDe ? ['variedad'] : [];
    return { ...conEstado(c, p.validado, toleranciaPct, c.costoUnidad), avisos, formulaSiga: formulaParaSiga(producto, plu) };
  });
  const insumos = insumosCosteados(producto, costoDe);
  const filas = [...Object.values(recetas), ...Object.values(presentaciones)];
  return {
    nombre: producto.nombre, recetas, presentaciones, insumos,
    resumen: { alertas: filas.filter(f => f.estado === 'cambio').length, faltantes: filas.filter(f => f.faltantes.length).length },
  };
}

// Insumos del producto (decisión 11): la lista del producto; cada presentación elige de ahí.
// Migración suave: un producto sin `insumos` (datos del ajuste anterior) la deriva de sus presentaciones;
// el primer PUT de insumos la persiste.
function insumosDelProducto(producto) {
  const p = producto || {};
  if (Array.isArray(p.insumos)) return p.insumos;
  const vistos = new Map();
  for (const pr of Object.values(p.presentaciones || {})) {
    for (const it of (pr && pr.insumos) || []) {
      if (!vistos.has(claveDe(it))) vistos.set(claveDe(it), it.plu != null ? { plu: String(it.plu) } : { manualId: it.manualId });
    }
  }
  return [...vistos.values()];
}

// Lista del producto con costo actual y en qué presentaciones de este producto se usa.
function insumosCosteados(producto, costoDe) {
  const pres = Object.entries(producto.presentaciones || {});
  return insumosDelProducto(producto).map(it => {
    const clave = claveDe(it);
    const c = costoDe(clave);
    const usadoEn = pres.filter(([, pr]) => ((pr && pr.insumos) || []).some(x => claveDe(x) === clave)).map(([plu]) => plu);
    return { ...it, clave, nombre: (c && c.nombre) || null, costo: costoValido(c && c.costo), fuente: (c && c.fuente) || null, usadoEn };
  });
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
// por UNIDAD vendida. Ingredientes de la variedad (base + extras) = cantidad / rendimiento efectivo ×
// kgPorUnidad (4 decimales, su unidad); insumos con su cantidad por unidad ('u'; el manual sin PLU).
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
  const insumos = (pres.insumos || []).map(it => (it.plu != null
    ? { plu: String(it.plu), cantidad: it.cantidad, unidad: 'u', origen: 'insumo' }
    : { plu: null, manualId: it.manualId, cantidad: it.cantidad, unidad: 'u', origen: 'insumo' }));
  return [...ingredientes, ...insumos];
}

// Alertas para el toast: sólo estado 'cambio' (sin-validar no avisa). Mayor |Δ%| primero.
// productosCosteados = { productoId: costearProducto(...) }.
function resumenAlertas(productosCosteados) {
  const items = Object.entries(productosCosteados || {}).flatMap(([productoId, p]) =>
    [['receta', p.recetas], ['presentacion', p.presentaciones]].flatMap(([tipo, filas]) =>
      Object.entries(filas || {}).filter(([, f]) => f.estado === 'cambio').map(([id, f]) => ({
        productoId, producto: p.nombre, tipo, id, nombre: f.nombre || id, deltaPct: f.cambios.deltaPct,
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

function noNegativo(v, campo) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`${campo}: debe ser un número mayor o igual a 0`);
  return v;
}

function mermaValida(v, campo) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v >= 100) throw new Error(`${campo}: debe ser un % de 0 a menos de 100`);
  return v;
}

function correccionValida(v, campo) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= -50 || v >= 100) throw new Error(`${campo}: debe ser un % mayor a -50 y menor a 100`);
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
    ...opcional(b, 'minutosElaboracion', noNegativo),
    ...opcional(b, 'categoriaMaquinaId', v => texto(v, 'categoriaMaquinaId')),
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

// Insumos de la presentación: sólo de la lista del producto (decisión 11), sin repetidos.
function validarInsumosPresentacion(lista, producto) {
  if (!Array.isArray(lista)) throw new Error('insumos: debe ser una lista');
  const delProducto = new Set(insumosDelProducto(producto).map(claveDe));
  const insumos = lista.map((it, i) => {
    if (!it || typeof it !== 'object') throw new Error(`insumos[${i}]: ítem inválido`);
    const ref = it.plu != null ? { plu: pluValido(it.plu, `insumos[${i}].plu`) } : { manualId: texto(it.manualId, `insumos[${i}].manualId`) };
    if (!delProducto.has(claveDe(ref))) throw new Error(`insumos[${i}]: "${claveDe(ref)}" no está en los insumos del producto`);
    return { ...ref, cantidad: positivo(it.cantidad, `insumos[${i}].cantidad`) };
  });
  const claves = insumos.map(claveDe);
  const repetido = claves.find((c, i) => claves.indexOf(c) !== i);
  if (repetido) throw new Error(`insumos: "${repetido}" está repetido`);
  return insumos;
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
    ...opcional(b, 'minutosEmpaquetado', noNegativo),
    ...opcional(b, 'correccionPct', correccionValida),
    ...opcional(b, 'nombre', v => texto(v, 'nombre')),
    insumos: validarInsumosPresentacion(b.insumos || [], prod),
  };
}

module.exports = {
  recetaEfectiva, costearReceta, costearPresentacion, costearProducto, detectarCambios, resumenAlertas, snapshotDe,
  validarProducto, validarReceta, validarPresentacion, validarBorrarReceta, insumosDelProducto, escalarVariantes,
  formulaParaSiga, CLAVE_PROVISORIA,
};
