'use strict';
// ── Precios · configuración del esquema por canal (spec 2026-10-07-precios-esquema-canales-design §3.3 y §4) ──
// Pura, sin I/O: la vista de config que consume el motor (lib/precios_esquema) y la pantalla, la validación de lo que
// guarda Configuración (Costos, Márgenes, Precio) y la migración aditiva del costeo.json viejo
// (la corre a mano scripts/migrar_esquema_canales.js).
const E = require('./precios_esquema');
const { validarGastosVenta } = require('./precios_costeo');

const TIPOS = ['almacen', 'fraccionado', 'produccion'];
const CANALES = ['minorista', 'pack', 'bulto'];
const MODOS_GASTOS = ['costo', 'precio'];
const REDONDEO_DEFAULT = Object.freeze({ minorista: 50, packNeto: 0, packIva: 50, bultoNeto: 0, bultoIva: 50 });
const LISTAS_REDONDEO = Object.keys(REDONDEO_DEFAULT);
const REDONDEO_MAX = 10000;
const IVA_DEFAULT_PCT = 21;
const TOLERANCIA_DEFAULT_PCT = 10;
const PCT_MAX = 100;
const AJUSTE_PESO_RANGO = [-100, 100];
const AJUSTES_PESO_MAX = 20;

const esNum = v => typeof v === 'number' && Number.isFinite(v);
const objeto = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// Lo guardado con defaults para lo escalar. Sin margenes (archivo sin migrar) → migrado: false: el motor devuelve
// error 'margen' y la UI pide correr la migración.
function configEsquemaDe(costeo) {
  const c = objeto(costeo);
  return {
    migrado: !!c.margenes,
    ivaVentaPct: esNum(c.ivaVentaPct) ? c.ivaVentaPct : IVA_DEFAULT_PCT,
    toleranciaPct: esNum(c.toleranciaPct) ? c.toleranciaPct : TOLERANCIA_DEFAULT_PCT,
    modoGastos: MODOS_GASTOS.includes(c.modoGastos) ? c.modoGastos : 'costo',
    gastosVenta: Array.isArray(c.gastosVenta) ? c.gastosVenta : [],
    extrasMinorista: Array.isArray(c.extrasMinorista) ? c.extrasMinorista : [],
    margenes: objeto(c.margenes),
    redondeo: { ...REDONDEO_DEFAULT, ...objeto(c.redondeo) },
  };
}

function validarTipos(t, campo) {
  const o = objeto(t);
  if (!TIPOS.every(k => typeof o[k] === 'boolean')) throw new Error(`${campo}: tildes almacen, fraccionado y produccion (true/false)`);
  return { almacen: o.almacen, fraccionado: o.fraccionado, produccion: o.produccion };
}

// Gastos variables o extras minoristas: [{ id?, concepto, pct, tipos }]. Concepto, pct, ids y total < 100 % con la
// validación de siempre (validarGastosVenta). Los gastos conservan `listas` porque el cálculo viejo la lee hasta la fase 5.
function validarItemsConTipos(items, nombre, conListas) {
  let base;
  try { base = validarGastosVenta(items); } catch (err) { throw new Error(`${nombre}: ${err.message}`); }
  return base.map((g, i) => {
    const { listas, ...resto } = g;
    return { ...resto, ...(conListas ? { listas } : {}), tipos: validarTipos(items[i].tipos, `${nombre}[${i}].tipos`) };
  });
}

// Body de PUT /api/precios/config/esquema/costos → { modoGastos, gastosVenta, extrasMinorista } o throw.
function validarCostos(body) {
  const b = objeto(body);
  if (!MODOS_GASTOS.includes(b.modoGastos)) throw new Error("modoGastos: debe ser 'costo' o 'precio'");
  return {
    modoGastos: b.modoGastos,
    gastosVenta: validarItemsConTipos(b.gastosVenta, 'gastosVenta', true),
    extrasMinorista: validarItemsConTipos(b.extrasMinorista, 'extrasMinorista', false),
  };
}

function validarTabla(t, campo) {
  const err = E.validarTablaMargen(t);
  if (err) throw new Error(`${campo}: ${err}`);
  const limpia = { minPct: t.minPct, maxPct: t.maxPct, escalones: t.escalones, rango: { desde: t.rango.desde, hasta: t.rango.hasta } };
  return t.rangoEstimado === true ? { ...limpia, rangoEstimado: true } : limpia;
}

// ponytail: copia chica de validarAjustesPeso de precios_costeo (esa se borra con la curva en la fase 5).
function validarAjustesPeso(aj) {
  if (aj == null) return null;
  const { tramosG, puntos } = objeto(aj);
  if (!Array.isArray(tramosG) || !tramosG.length || tramosG.length > AJUSTES_PESO_MAX) {
    throw new Error(`ajustesPeso.tramosG: lista de 1 a ${AJUSTES_PESO_MAX} pesos`);
  }
  tramosG.forEach((t, i) => {
    if (!esNum(t) || t <= 0 || (i > 0 && t <= tramosG[i - 1])) throw new Error(`ajustesPeso.tramosG[${i}]: pesos en gramos, positivos y ascendentes`);
  });
  const [lo, hi] = AJUSTE_PESO_RANGO;
  if (!Array.isArray(puntos) || puntos.length !== tramosG.length || !puntos.every(p => esNum(p) && p >= lo && p <= hi)) {
    throw new Error(`ajustesPeso.puntos: ${tramosG.length} valores entre ${lo} y ${hi}`);
  }
  return { tramosG: [...tramosG], puntos: [...puntos] };
}

// Body de PUT /api/precios/config/esquema/margenes/:tipo → { minorista, pack, bulto[, ajustesPeso] } o throw.
// sinConfigurar no pasa: guardar el tipo = configurarlo. rangoEstimado sí (lo saca "Recalcular rango").
function validarMargenesTipo(tipo, body) {
  if (!TIPOS.includes(tipo)) throw new Error(`tipo inválido (${TIPOS.join(', ')})`);
  const b = objeto(body);
  const tablas = Object.fromEntries(CANALES.map(c => [c, validarTabla(b[c], `${tipo}.${c}`)]));
  if (tipo !== 'fraccionado') return tablas;
  const aj = validarAjustesPeso(b.ajustesPeso);
  return aj ? { ...tablas, ajustesPeso: aj } : tablas;
}

function validarPctGeneral(v, campo) {
  if (!esNum(v) || v < 0 || v > PCT_MAX) throw new Error(`${campo}: número entre 0 y ${PCT_MAX}`);
  return v;
}

// Body de PUT /api/precios/config/esquema/precio → { ivaVentaPct, toleranciaPct, redondeo } o throw.
function validarPrecio(body) {
  const b = objeto(body);
  const r = objeto(b.redondeo);
  const redondeo = Object.fromEntries(LISTAS_REDONDEO.map(k => {
    if (!esNum(r[k]) || r[k] < 0 || r[k] > REDONDEO_MAX) throw new Error(`redondeo.${k}: múltiplo entre 0 y ${REDONDEO_MAX} (0 = exacto)`);
    return [k, r[k]];
  }));
  return { ivaVentaPct: validarPctGeneral(b.ivaVentaPct, 'ivaVentaPct'), toleranciaPct: validarPctGeneral(b.toleranciaPct, 'toleranciaPct'), redondeo };
}

module.exports = {
  TIPOS, CANALES, REDONDEO_DEFAULT,
  configEsquemaDe, validarCostos, validarMargenesTipo, validarPrecio,
};
