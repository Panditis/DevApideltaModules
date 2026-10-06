'use strict';
// Márgenes propios → curva, gradual (spec 2026-10-02-precios-costo-neto-iva-curva-design.md, Parte E.1). Puro: sin fs/SQL.
// Por cada ganancia propia (margenPorProducto[plu] y presentacionesTemporales[granel][].gananciaPct), con el mismo costo,
// compara el precio final exacto (antes del redondeo a $50) con la propia (P_o) y con la standard curva + conceptos (P_s):
//   |P_s ÷ P_o − 1| ≤ tope → se borra la propia (pasa al standard);
//   si no → se reemplaza por la ganancia que da P_o × (1 ± tope) en dirección a P_s (inversa exacta: markupParaPrecio →
//   gananciaDesdeMarkup). Repetirlo otro día sigue acercando hasta converger.
// Sin costo o sin standard calculable no se toca (se cuenta).
const {
  desglosePrecio, markupDesdeGanancia, gananciaDesdeMarkup, markupParaPrecio, gananciaPorCurva, gananciaStandard,
  totalConceptosGanancia, conceptosGananciaDe, conceptosPrecioFinalDe, ivaVentaPctDe, curvasGananciaConDefault, redondear2,
} = require('./precios_costeo');
const { gastosVentaPctTipo } = require('./precios_costos');

const TOPE_DEFAULT_PCT = 5;
const TOPE_RANGO_PCT = [0.5, 50];
const TOP_MAX = 50;
const TIPOS = ['almacen', 'fraccionado', 'produccion'];
// Un PLU que aparece en más de un listado (ej. presentación de Producción con rubro Almacen) se toma de uno solo.
const PRIORIDAD = { produccion: 0, fraccionado: 1, almacen: 2 };
// Cortes (en %) de la distribución de Δ precio.
const CORTES_DELTA = [-10, -5, -2, -0.5, 0.5, 2, 5, 10];
const EPS = 1e-9;
const esNumero = v => typeof v === 'number' && Number.isFinite(v);

function validarTopePct(v) {
  if (v == null) return TOPE_DEFAULT_PCT;
  const [min, max] = TOPE_RANGO_PCT;
  if (!esNumero(v) || v < min || v > max) throw new Error(`topePct: debe ser un número entre ${min} y ${max}`);
  return v;
}

// Contexto de precio por tipo con la config: gastos G (null = desconocidos), IVA de venta, conceptos sobre precio final,
// curva y conceptos de ganancia (K).
function contextoPorTipo(costeo) {
  const cfg = costeo || {};
  const curvas = curvasGananciaConDefault(cfg.curvaGanancia);
  const comun = {
    ivaPct: ivaVentaPctDe(cfg), conceptosFinal: conceptosPrecioFinalDe(cfg),
    finalPct: totalConceptosGanancia(conceptosPrecioFinalDe(cfg)), K: totalConceptosGanancia(conceptosGananciaDe(cfg)),
  };
  return Object.fromEntries(TIPOS.map(t => [t, { ...comun, curva: curvas[t], gastosPct: gastosVentaPctTipo(cfg, t) }]));
}

// Precio final exacto (con IVA y conceptos sobre precio final, antes del redondeo a $50) con ganancia g: la fórmula de
// desglosePrecio. null si los gastos son desconocidos.
function precioExacto(costo, gananciaPct, ctx) {
  const markupPct = markupDesdeGanancia(gananciaPct, ctx.gastosPct);
  if (markupPct == null) return null;
  return desglosePrecio({ costo, markupPct, ivaPct: ctx.ivaPct, conceptosFinal: ctx.conceptosFinal }).precioFinalExacto;
}

// Un paso para un ítem { costo, costoCurva, pesoG, gananciaPropia }: { accion: 'standard'|'acercar'|'sinCosto'|'sinStandard',
// gananciaNueva (null = borrar la propia), precioActual, precioStandard, precioNuevo, deltaPct }.
function pasoMargenPropio(item, ctx, topePct) {
  const costo = Number(item.costo);
  if (item.costo == null || !(costo > 0) || !esNumero(item.gananciaPropia)) return { accion: 'sinCosto' };
  const curva = gananciaPorCurva(ctx.curva, item.costoCurva ?? costo, item.pesoG ?? null);
  const gananciaStd = gananciaStandard(curva, ctx.K);
  const Po = precioExacto(costo, item.gananciaPropia, ctx);
  const Ps = gananciaStd == null ? null : precioExacto(costo, gananciaStd, ctx);
  if (!(Po > 0) || !(Ps > 0)) return { accion: 'sinStandard' };
  const t = topePct / 100;
  const r = Ps / Po - 1;
  const fin = (accion, gananciaNueva, Pn) => ({
    accion, gananciaNueva, precioActual: Po, precioStandard: Ps, precioNuevo: Pn, deltaPct: +((Pn / Po - 1) * 100).toFixed(2),
  });
  if (Math.abs(r) <= t + EPS) return fin('standard', null, Ps);
  const objetivo = Po * (1 + Math.sign(r) * t);
  const g = gananciaDesdeMarkup(markupParaPrecio(costo, objetivo, ctx.ivaPct, ctx.finalPct), ctx.gastosPct);
  return fin('acercar', g, precioExacto(costo, g, ctx));
}

// Ítems de margen propio desde los listados ya costeados (rutas): filas de Reventa (calcularFilaAlmacen), grupos de
// Fraccionado (armarGruposFraccionado, presentaciones + temporales) y presentaciones de Producción
// [{ plu, nombre, costoUnidad }]. costo = el del precio; costoCurva = el que busca la curva (como en cada listado).
function itemsDesdeListados({ filas = [], grupos = [], produccion = [] } = {}) {
  return [
    ...filas.map(f => ({ tipo: 'almacen', plu: String(f.plu), nombre: f.nombre, costo: f.costoTotal, costoCurva: f.costoBase })),
    ...grupos.flatMap(g => [
      ...(g.presentaciones || []).map(p => ({ tipo: 'fraccionado', plu: String(p.plu), nombre: p.nombre, costo: p.costoKg,
        costoCurva: g.costoBase, pesoG: p.pesoG })),
      ...(g.granelPlu == null ? [] : g.temporales || []).map(t => ({ tipo: 'fraccionado', granelPlu: String(g.granelPlu), id: t.id,
        nombre: t.nombre || `${g.granelNombre} ${t.presentacion} (temporal)`, costo: t.costoKg, costoCurva: g.costoBase, pesoG: t.pesoG })),
    ]),
    ...produccion.map(p => ({ tipo: 'produccion', plu: String(p.plu), nombre: p.nombre, costo: p.costoUnidad, costoCurva: p.costoUnidad })),
  ];
}

// Ganancias propias guardadas: [{ clave, plu | granelPlu+id, gananciaPropia }].
function propiasGuardadas(costeo) {
  const c = costeo || {};
  return [
    ...Object.entries(c.margenPorProducto || {}).filter(([, v]) => esNumero(v))
      .map(([plu, v]) => ({ clave: `p:${plu}`, plu, gananciaPropia: v })),
    ...Object.entries(c.presentacionesTemporales || {}).flatMap(([granelPlu, lista]) => (Array.isArray(lista) ? lista : [])
      .filter(t => t && esNumero(t.gananciaPct)).map(t => ({ clave: `t:${granelPlu}:${t.id}`, granelPlu, id: t.id, gananciaPropia: t.gananciaPct }))),
  ];
}

const claveItem = it => (it.id != null ? `t:${it.granelPlu}:${it.id}` : `p:${it.plu}`);

function distribucion(deltas) {
  // Rangos [desde, hasta) de Δ %; null = sin límite.
  const b = [-Infinity, ...CORTES_DELTA, Infinity];
  return b.slice(0, -1).map((desde, i) => ({
    desde: Number.isFinite(desde) ? desde : null, hasta: Number.isFinite(b[i + 1]) ? b[i + 1] : null,
    n: deltas.filter(d => d >= desde && d < b[i + 1]).length,
  }));
}

// Plan completo (no escribe): resumen por tipo y totales (standard / acercar / sinCambio, con motivo), distribución de
// Δ precio, top 50 por |Δ| y los cambios a aplicar [{ clave, plu|granelPlu+id, antes, despues (null = borrar) }].
function planMargenesPropios({ costeo, items, topePct = TOPE_DEFAULT_PCT }) {
  const ctx = contextoPorTipo(costeo);
  const porClave = new Map();
  for (const it of items || []) {
    const k = claveItem(it), prev = porClave.get(k);
    if (!prev || PRIORIDAD[it.tipo] < PRIORIDAD[prev.tipo]) porClave.set(k, it);
  }
  const vacio = () => ({ standard: 0, acercar: 0, sinCambio: 0 });
  const porTipo = Object.fromEntries([...TIPOS, 'sinListado'].map(t => [t, vacio()]));
  const motivos = { sinCosto: 0, sinStandard: 0, sinListado: 0 };
  const filas = [], cambios = [];
  for (const g of propiasGuardadas(costeo)) {
    const it = porClave.get(g.clave);
    if (!it) { porTipo.sinListado.sinCambio++; motivos.sinListado++; continue; }
    const r = pasoMargenPropio({ ...it, gananciaPropia: g.gananciaPropia }, ctx[it.tipo], topePct);
    if (r.accion === 'sinCosto' || r.accion === 'sinStandard') { porTipo[it.tipo].sinCambio++; motivos[r.accion]++; continue; }
    porTipo[it.tipo][r.accion]++;
    cambios.push({ clave: g.clave, plu: g.plu ?? null, granelPlu: g.granelPlu ?? null, id: g.id ?? null, antes: g.gananciaPropia, despues: r.gananciaNueva });
    filas.push({ plu: g.plu ?? null, nombre: it.nombre ?? null, tipo: it.tipo, temporal: g.id != null, accion: r.accion,
      precioActual: redondear2(r.precioActual), precioStandard: redondear2(r.precioStandard), precioNuevo: redondear2(r.precioNuevo),
      deltaPct: r.deltaPct, brechaPct: +((r.precioStandard / r.precioActual - 1) * 100).toFixed(2),
      gananciaActual: g.gananciaPropia, gananciaNueva: r.gananciaNueva });
  }
  const totales = Object.values(porTipo).reduce((s, x) => ({ standard: s.standard + x.standard, acercar: s.acercar + x.acercar,
    sinCambio: s.sinCambio + x.sinCambio }), vacio());
  return {
    topePct, total: totales.standard + totales.acercar + totales.sinCambio, totales, porTipo, motivosSinCambio: motivos,
    distribucion: distribucion(filas.map(f => f.deltaPct)),
    // Por |Δ|; empate (casi todos ± tope) → los más lejos del standard (brecha = P_s ÷ P_o − 1).
    top: [...filas].sort((a, b) => (Math.abs(b.deltaPct) - Math.abs(a.deltaPct)) || (Math.abs(b.brechaPct) - Math.abs(a.brechaPct))).slice(0, TOP_MAX),
    cambios,
  };
}

// Aplica los cambios del plan sobre costeo (copia nueva). Sólo toca las entradas que siguen valiendo `antes` (si alguien
// la editó entre el cálculo y la escritura, se respeta lo suyo): devuelve { costeo, aplicados, omitidos }.
function aplicarPlanMargenes(costeo, cambios) {
  const c = costeo || {};
  const margen = { ...(c.margenPorProducto || {}) };
  const temporales = Object.fromEntries(Object.entries(c.presentacionesTemporales || {}).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]));
  let aplicados = 0, omitidos = 0;
  for (const x of cambios || []) {
    if (x.id == null) {
      if (margen[x.plu] !== x.antes) { omitidos++; continue; }
      if (x.despues == null) delete margen[x.plu]; else margen[x.plu] = x.despues;
    } else {
      const lista = temporales[x.granelPlu];
      const i = Array.isArray(lista) ? lista.findIndex(t => t && t.id === x.id && t.gananciaPct === x.antes) : -1;
      if (i < 0) { omitidos++; continue; }
      lista[i] = { ...lista[i], gananciaPct: x.despues };
    }
    aplicados++;
  }
  return {
    costeo: { ...c, margenPorProducto: margen, ...(c.presentacionesTemporales ? { presentacionesTemporales: temporales } : {}) },
    aplicados, omitidos,
  };
}

// Cantidad de ganancias propias por tipo (tipoDePlu, sin SIGA) para la tarjeta; temporales = Fraccionado.
function contarMargenesPropios(costeo, tipoDePlu = () => 'almacen') {
  const porTipo = Object.fromEntries(TIPOS.map(t => [t, 0]));
  for (const g of propiasGuardadas(costeo)) porTipo[g.id != null ? 'fraccionado' : (tipoDePlu(g.plu) || 'almacen')]++;
  return { porTipo, total: Object.values(porTipo).reduce((s, n) => s + n, 0) };
}

// Sufijo AAAAMMDD-HHMM (hora local) del backup de "Aplicar".
const pad2 = n => String(n).padStart(2, '0');
const sufijoBackup = (d = new Date()) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;

module.exports = {
  TOPE_DEFAULT_PCT, TOPE_RANGO_PCT, validarTopePct, contextoPorTipo, precioExacto, pasoMargenPropio, itemsDesdeListados,
  planMargenesPropios, aplicarPlanMargenes, contarMargenesPropios, sufijoBackup,
};
