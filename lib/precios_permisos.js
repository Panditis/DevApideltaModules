'use strict';
// ── Precios · permiso de Configuración (ref 'precios-config', lib/auth PERMISOS_EXTRA) ──────────────
// Quien hace precios sin este permiso no ve la estructura de costos (gastos variables, departamentos, conceptos de
// ganancia, curvas, costo real, ganancia). Tres piezas, todas acá:
//  1. guardPrecios (montado en server.js antes de los routers de precios): 403 a las rutas de RUTAS_CONFIG y marca
//     req.preciosSinConfig en todo /api/precios; además saca de sus respuestas las claves de CLAVES_OCULTAS.
//  2. proyectarCosteo: la config "vista sin estructura" con la que los routers calculan listados/detalles para ese
//     usuario: gastos 0, sin conceptos de ganancia, la curva del tipo pasada a MARKUP s/ costo neto y las ganancias
//     propias pasadas a markup. Los precios salen iguales (markup = (1 + g + C) ÷ (1 − G) − 1 es afín en g: la curva
//     clamp(a − b·ln c) mapea a otra curva del mismo tipo) y "ganancia" pasa a significar markup s/ costo neto, que ya
//     se deduce de costo neto y precio neto (visibles). G, C y la curva real no se pueden separar de ahí.
//  3. markups ↔ ganancias en las escrituras de ese usuario (margen propio y temporales): manda markup, se guarda ganancia.
const preciosCosteo = require('./precios_costeo');
const preciosCostos = require('./precios_costos');

const PERMISO_CONFIG = 'precios-config';

// Rutas de configuración (lectura o escritura de la estructura de costos/ganancia): 403 sin el permiso, cualquier
// método. Path ya normalizado (minúsculas, sin %xx). /api/precios/config/publica queda afuera a propósito.
const RUTAS_CONFIG = [
  /^\/api\/precios\/config\/?$/,                          // GET config completa
  /^\/api\/precios\/config\/(?!publica\/?$).+/,           // PUT config/general|ganancia|iva-venta|gastos-venta|departamentos|curva-ganancia/:tipo|pack-bulto
  /^\/api\/precios\/costos(\/|$)/,                        // POST costos/venta-base/actualizar (no toca costos-extra: otro segmento)
  /^\/api\/precios\/curva-ganancia(\/|$)/,                // POST curva-ganancia/ajustar/:tipo (incluye produccion)
  /^\/api\/precios\/alinear-siga(\/|$)/,                  // POST alinear-siga
  /^\/api\/precios\/margenes-propios(\/|$)/,              // GET margenes-propios, POST previsualizar|aplicar
  /^\/api\/precios\/pack-bulto\/alinear-siga(\/|$)/,      // POST pack-bulto/alinear-siga
  /^\/api\/precios\/produccion\/categorias-maquina(\/|$)/, // GET/PUT Máquinas ($/hora por categoría)
];

// Claves que nunca salen hacia un usuario sin permiso (cualquier profundidad). Con la vista proyectada ya valen 0 /
// costo neto / el markup, pero no se mandan igual: no son información para ese usuario.
const CLAVES_OCULTAS = new Set([
  'costoReal', 'gastosVentaPct', 'gananciaCurva', 'gananciaCurvaPct',
  'variables', 'variablesPct', 'departamentos', 'departamentosPct',
  'conceptos', 'conceptosPct', 'conceptosImporte', 'conceptosGanancia', 'conceptosGananciaPct',
  'curvaGanancia', 'estructuraCostos', 'ventaBase', 'gastosVenta',
]);

function normalizarRuta(p) {
  let ruta = String(p || '');
  try { ruta = decodeURIComponent(ruta); } catch { /* %xx inválido: queda crudo (Express tampoco lo enruta) */ }
  return ruta.toLowerCase().replace(/\/{2,}/g, '/');
}
const esRutaPrecios = ruta => /^\/api\/precios(\/|$)/.test(ruta);
const esRutaConfig = p => RUTAS_CONFIG.some(re => re.test(normalizarRuta(p)));

function sinClavesOcultas(v) {
  if (Array.isArray(v)) return v.map(sinClavesOcultas);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => !CLAVES_OCULTAS.has(k)).map(([k, x]) => [k, sinClavesOcultas(x)]));
}

// tienePermiso(user, ref) = lib/auth. Sin sesión (módulo precios público) → sin permiso.
function crearGuardPrecios({ tienePermiso }) {
  return function guardPrecios(req, res, next) {
    const ruta = normalizarRuta(req.path);
    if (!esRutaPrecios(ruta)) return next();
    const puede = tienePermiso(req.session && req.session.user, PERMISO_CONFIG);
    req.preciosSinConfig = !puede;
    if (puede) return next();
    if (esRutaConfig(ruta)) return res.status(403).json({ error: 'Sin permiso para la configuración de precios' });
    const json = res.json.bind(res);
    res.json = cuerpo => json(sinClavesOcultas(cuerpo));
    return next();
  };
}

// ── Vista sin estructura ──────────────────────────────────────────────────────────────────────────────
const TIPOS = preciosCosteo.TIPOS_CURVA;
const CURVA_NULA = Object.freeze({ a: null, b: null, pisoPct: null, techoPct: null });
const IMPUESTOS_FINAL = 'Impuestos s/ precio final';

// Curva de ganancia g(c) = clamp(a − b·ln c, piso, techo) + ajuste → curva de markup m = α(100 + g + C) − 100, con
// α = 1 ÷ (1 − G): misma forma con a' = αa + β, b' = αb, piso/techo' = α·x + β, ajustes' = α·ajuste (β = α(100 + C) − 100).
// G null (falta venta base) → curva inválida: sin standard, igual que el cálculo real.
function proyectarCurva(curva, G, C) {
  if (G == null || !curva) return { ...CURVA_NULA };
  const alfa = 1 / (1 - G / 100);
  const beta = alfa * (100 + C) - 100;
  const af = x => (typeof x === 'number' && Number.isFinite(x) ? alfa * x + beta : x);
  const aj = curva.ajustesPeso;
  return {
    a: af(curva.a), b: typeof curva.b === 'number' ? alfa * curva.b : curva.b, pisoPct: af(curva.pisoPct), techoPct: af(curva.techoPct),
    ...(aj && Array.isArray(aj.puntos) ? { ajustesPeso: { tramosG: aj.tramosG, puntos: aj.puntos.map(p => alfa * (Number(p) || 0)) } } : {}),
  };
}

const gastosDe = (costeo, tipo) => preciosCostos.gastosVentaPctTipo(costeo, tipo);
const conceptosDe = costeo => preciosCosteo.totalConceptosGanancia(preciosCosteo.conceptosGananciaDe(costeo));
const finalAgregado = costeo => {
  const pct = preciosCosteo.totalConceptosGanancia(preciosCosteo.conceptosPrecioFinalDe(costeo));
  return pct ? [{ id: 'impuestos-final', concepto: IMPUESTOS_FINAL, pct }] : [];
};
const markupDe = (g, G) => (typeof g === 'number' && Number.isFinite(g) ? preciosCosteo.markupDesdeGanancia(g, G) : null);
const mapaMarkups = (mapa, G) => Object.fromEntries(Object.entries(mapa || {})
  .map(([plu, g]) => [plu, markupDe(g, G)]).filter(([, m]) => m != null));

// Config con la que se calcula para un usuario sin permiso, para el tipo cuyo listado/detalle se arma (cada tipo
// aplica sus gastos: las ganancias propias se pasan a markup con los del tipo que se calcula).
function proyectarCosteo(costeo, tipo) {
  const c = costeo || {};
  const G = gastosDe(c, tipo);
  const curvas = preciosCosteo.curvasGananciaConDefault(c.curvaGanancia);
  const { departamentos: _d, gastosVenta: _g, conceptosGanancia: _c, curvaGanancia: _cg, ventaBase: _v, ...resto } = c;
  return {
    ...resto,
    gastosVenta: [], departamentos: [], conceptosGanancia: [],
    conceptosPrecioFinal: finalAgregado(c),
    curvaGanancia: Object.fromEntries(TIPOS.map(t => [t, t === tipo ? proyectarCurva(curvas[t], G, conceptosDe(c)) : { ...CURVA_NULA }])),
    margenPorProducto: mapaMarkups(c.margenPorProducto, G),
    presentacionesTemporales: tipo !== 'fraccionado' ? {} : Object.fromEntries(Object.entries(c.presentacionesTemporales || {})
      .map(([granel, lista]) => [granel, (Array.isArray(lista) ? lista : []).map(t => temporalAMarkup(t, G))])),
  };
}

function temporalAMarkup(t, G) {
  if (!t || t.gananciaPct == null) return t;
  const m = markupDe(t.gananciaPct, G);
  const { gananciaPct: _g, ...resto } = t;
  return m == null ? resto : { ...resto, gananciaPct: m };
}

// Config para el front de un usuario sin permiso (GET /api/precios/config/publica): la misma vista proyectada de los
// tres tipos, con las claves que leen los modales (gastos 0 o null si falta la venta base del tipo).
function configPublicaSinEstructura(costeo) {
  const c = costeo || {};
  const C = conceptosDe(c);
  const curvas = preciosCosteo.curvasGananciaConDefault(c.curvaGanancia);
  const G = Object.fromEntries(TIPOS.map(t => [t, gastosDe(c, t)]));
  return {
    gastosVentaPct: 0,
    gastosVentaPctPorTipo: Object.fromEntries(TIPOS.map(t => [t, G[t] == null ? null : 0])),
    conceptosGanancia: [],
    conceptosPrecioFinal: finalAgregado(c),
    curvaMarkup: Object.fromEntries(TIPOS.map(t => [t, proyectarCurva(curvas[t], G[t], C)])),
  };
}

// Markup s/ costo neto (lo que manda el usuario sin permiso) → ganancia s/ costo real del tipo, para guardar.
function gananciaDesdeMarkupTipo(costeo, tipo, markupPct) {
  const G = gastosDe(costeo, tipo);
  if (G == null) throw new Error('faltan los gastos de este tipo (venta base): pedí que completen la configuración');
  return preciosCosteo.gananciaDesdeMarkup(markupPct, G);
}

module.exports = {
  PERMISO_CONFIG, RUTAS_CONFIG, CLAVES_OCULTAS,
  normalizarRuta, esRutaConfig, sinClavesOcultas, crearGuardPrecios,
  proyectarCurva, proyectarCosteo, configPublicaSinEstructura, gananciaDesdeMarkupTipo, temporalAMarkup,
};
