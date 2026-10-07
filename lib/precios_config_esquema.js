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

// ── Migración aditiva (spec §4) ──────────────────────────────────────────────────────────────────────────
// Agrega lo que falta y no borra claves viejas (las borra la fase 5). Idempotente: cada pieza se agrega sólo si no
// está; sobre un archivo ya migrado devuelve null.
const ID_FINANCIEROS_MINORISTA = 'costos-financieros-minorista';
const todosLosTipos = () => ({ almacen: true, fraccionado: true, produccion: true });
const ESCALONES_INICIALES = 10;
// Sin SIGA no hay costos reales: rango de arranque amplio y rangoEstimado hasta "Recalcular rango". (Derivarlo de la
// curva vieja daba rangos absurdos: con techo = a, Fraccionado arrancaba en $1 y Producción terminaba en 3·10¹⁴.)
const RANGO_INICIAL = Object.freeze({ desde: 100, hasta: 100000 });
const MARGEN_RESPALDO = Object.freeze({ minPct: 30, maxPct: 50 });
const [MARGEN_MIN, MARGEN_MAX] = [-50, 300]; // los de validarTablaMargen
const acotar = v => Math.min(MARGEN_MAX, Math.max(MARGEN_MIN, E.r2(v)));

// Tabla minorista de arranque: mín/máx = piso/techo de la curva vieja del tipo (respaldo si es inválida).
function tablaInicial(curva) {
  const c = objeto(curva);
  const ok = esNum(c.pisoPct) && esNum(c.techoPct) && c.pisoPct <= c.techoPct;
  return {
    minPct: ok ? acotar(c.pisoPct) : MARGEN_RESPALDO.minPct,
    maxPct: ok ? acotar(c.techoPct) : MARGEN_RESPALDO.maxPct,
    escalones: ESCALONES_INICIALES, rango: { ...RANGO_INICIAL }, rangoEstimado: true,
  };
}

// Pack y bulto arrancan como copia del minorista, marcados "sin configurar" hasta que se guarde el tipo.
function margenesIniciales(curvaGanancia) {
  const cg = objeto(curvaGanancia);
  return Object.fromEntries(TIPOS.map(tipo => {
    const min = tablaInicial(cg[tipo]);
    const tablas = { minorista: min, pack: { ...min, sinConfigurar: true }, bulto: { ...min, sinConfigurar: true } };
    const aj = tipo === 'fraccionado' ? objeto(cg.fraccionado).ajustesPeso : null;
    return [tipo, aj && Array.isArray(aj.tramosG) && Array.isArray(aj.puntos)
      ? { ...tablas, ajustesPeso: { tramosG: [...aj.tramosG], puntos: [...aj.puntos] } } : tablas];
  }));
}

// decisiones { plu: { fuente, fecha } } desde marcadosExportar (fecha) + la fuente de costo de cada marcado:
// costo manual > última compra elegida > sistema. Un fuenteCosto sin marcado no es una decisión.
function decisionesIniciales(c) {
  const manual = objeto(c.costoPorProducto), fuente = objeto(c.fuenteCosto);
  return Object.fromEntries(Object.entries(objeto(c.marcadosExportar)).map(([plu, fecha]) => [plu, {
    fuente: esNum(manual[plu]) && manual[plu] > 0 ? 'manual' : fuente[plu] === 'ultimaCompra' ? 'ultimaCompra' : 'sistema',
    fecha: typeof fecha === 'string' ? fecha : null,
  }]));
}

// → { costeo, claves } (claves = lo que se agregó/cambió) o null si ya estaba migrado. No muta la entrada.
function migrarEsquemaCanales(costeo) {
  const c = objeto(costeo);
  const agregar = {};
  if (!MODOS_GASTOS.includes(c.modoGastos)) agregar.modoGastos = 'costo';
  const gastos = Array.isArray(c.gastosVenta) ? c.gastosVenta : [];
  // "Costos Financieros Minorista" sale de los gastos: lo reemplaza la tabla de extras minoristas.
  if (gastos.some(g => !g || g.id === ID_FINANCIEROS_MINORISTA || !g.tipos)) {
    agregar.gastosVenta = gastos.filter(g => g && g.id !== ID_FINANCIEROS_MINORISTA).map(g => (g.tipos ? g : { ...g, tipos: todosLosTipos() }));
  }
  if (!Array.isArray(c.extrasMinorista)) {
    agregar.extrasMinorista = (Array.isArray(c.conceptosPrecioFinal) ? c.conceptosPrecioFinal : [])
      .map(({ id, concepto, pct }) => ({ id, concepto, pct, tipos: todosLosTipos() }));
  }
  if (!c.margenes) agregar.margenes = margenesIniciales(c.curvaGanancia);
  if (!c.redondeo) agregar.redondeo = { ...REDONDEO_DEFAULT };
  if (!c.decisiones) agregar.decisiones = decisionesIniciales(c);
  const claves = Object.keys(agregar);
  return claves.length ? { costeo: { ...c, ...agregar }, claves } : null;
}

module.exports = {
  TIPOS, CANALES, REDONDEO_DEFAULT,
  configEsquemaDe, validarCostos, validarMargenesTipo, validarPrecio, migrarEsquemaCanales,
};
