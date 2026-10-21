'use strict';
// ── Precios · permiso de Configuración (ref 'precios-config', lib/auth PERMISOS_EXTRA) ──────────────
// guardPrecios (server.js, antes de los routers de precios): 403 a las rutas de RUTAS_CONFIG sin el permiso, marca
// req.preciosSinConfig en todo /api/precios (los routers deciden qué mandar: el detalle del esquema y el de Producción
// van sin desglose) y saca de las respuestas de ese usuario las claves de CLAVES_OCULTAS (defensa extra: la estructura
// del esquema — gastos, extras, márgenes — nunca sale hacia él).
const PERMISO_CONFIG = 'precios-config';

// Path ya normalizado (minúsculas, sin %xx). /api/precios/config/publica queda afuera a propósito.
const RUTAS_CONFIG = [
  /^\/api\/precios\/config\/?$/,
  /^\/api\/precios\/config\/(?!publica\/?$).+/, // config/esquema (GET) y config/esquema/costos|precio|margenes|rango
  /^\/api\/precios\/produccion\/productos\/[^/]+\/margen-especial\/?$/, // margen especial de un producto de Producción
  /^\/api\/precios\/costos-extra\/[^/]+\/?$/, // costos extra de un producto o granel (2026-10-21: sólo con el permiso)
];

// 'desglose' no entra: Producción manda con ese nombre los kg por tanda de una variedad (no es estructura de costos); el
// desglose de precios del esquema ya lo saca filaPublica. margenEspecial = el de un producto de Producción (definicion);
// margenProducto = margen de un producto (fila del listado/detalle); margenProductoPct / margenProductoModo / margenGeneralPct
// su parte en el desglose; descuentoDistribuidorPct = el descuento al margen de un distribuidor (Configuración › Márgenes).
// maquinas, escalas y porGranel = Configuración › Costeo Fraccionado; costeoGranel = subrubro y máquina del granel en el listado.
// fraccPresentacion (facilidad, tiempo e insumos de una presentación) NO va: lo ve y lo edita el operario en la tab Fraccionado.
// NO 'fraccionado': el filtro es recursivo y borraría tipos.fraccionado; ese bloque sólo sale por /api/precios/config/* (403 sin el permiso).
const CLAVES_OCULTAS = new Set(['gastosVenta', 'extrasMinorista', 'margenes', 'margenEspecial', 'margenProducto', 'margenProductoPct',
  'margenProductoModo', 'margenGeneralPct', 'descuentoDistribuidorPct',
  'maquinas', 'escalas', 'porGranel', 'costeoGranel']);

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

module.exports = { PERMISO_CONFIG, RUTAS_CONFIG, CLAVES_OCULTAS, normalizarRuta, esRutaConfig, sinClavesOcultas, crearGuardPrecios };
