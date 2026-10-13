'use strict';
const express = require('express');
const path = require('path');
const cfgEsq = require('../lib/precios_config_esquema');
const { rangoDesdeCostos } = require('../lib/precios_esquema');
const L = require('../lib/precios_listado_esquema');
const { crearConsultasPrecios } = require('../lib/precios_consultas');
// Costeo de Producción (sin el router): costo por unidad de cada presentación.
const { costearTodos, plusUsados, normalizarDatos } = require('./rutas_precios_produccion');

// ── Precios · esquema por canal (spec 2026-10-07-precios-esquema-canales-design) ────────────────────────────
// Configuración nueva (Costos, Márgenes, Precio, rango desde SIGA); en la fase 3 también listados, detalle, decisión
// y export. Router propio: rutas_precios.js ya pasa las 800 líneas (se achica en la fase 5). /api/precios/config/esquema/*
// queda detrás del permiso precios-config por RUTAS_CONFIG (lib/precios_permisos), sin tocar el guard.
module.exports = function crearRutasPreciosEsquema(deps) {
  const { apiRoute, leerJSON, guardarJSON, DATA_DIR } = deps;
  const router = express.Router();
  const COSTEO_PATH = path.join(DATA_DIR, 'costeo.json');
  const RECETAS_PATH = path.join(DATA_DIR, 'recetas_produccion.json');
  const consultas = crearConsultasPrecios(deps);
  const leerCosteo = () => leerJSON(COSTEO_PATH, {}) || {};
  const cuerpo = req => (req.body && typeof req.body === 'object' ? req.body : {});
  const formulasPesables = () => ((leerJSON(path.join(DATA_DIR, 'pesables_listas.json'), {}) || {}).formulas) || {};
  // Costeo sin las decisiones vencidas (SIGA cambió el precio decidido, spec §3); las poda del archivo una vez por carga.
  // ponytail: repite la consulta de vigentes que después hace contexto(); compartirla si pesa.
  const costeoVigente = () => L.leerCosteoVigente({ leerCosteo, guardarCosteo: c => guardarJSON(COSTEO_PATH, c), preciosVigentes: consultas.preciosVigentesAlmacen });
  const usuarioDe = req => (req.session && req.session.user && req.session.user.usuario) || null;

  // Presentaciones de Producción con su costo por unidad y "a revisar" (el mismo costearTodos que la tab Producción).
  // Cada PLU de una variedad envasada es una presentación más, marcada tipoProduccion 'envasado', con granel + insumos y su
  // familia › variedad (grupo del listado).
  async function presentacionesProduccion(costeo) {
    const datos = normalizarDatos(leerJSON(RECETAS_PATH, {}));
    const costos = await consultas.costosPorPlu(plusUsados(datos.productos));
    const costeados = costearTodos({ productos: datos.productos, costos, costeo });
    return Object.entries(costeados).flatMap(([productoId, c]) => Object.entries(c.presentaciones || {})
      .map(([plu, p]) => ({ productoId, plu, nombre: p.nombre || c.nombre, costoUnidad: p.costoUnidad, aRevisar: p.revisar,
        margenExtra: datos.productos[productoId].margenEspecial || null,
        ...(c.tipo === 'envasado' ? { tipoProduccion: 'envasado', componentesCosto: p.componentes, familia: datos.productos[productoId].familia || '', variedad: c.nombre } : {}) })));
  }

  // Valida con validar(req) → cambios y guarda { ...costeo, ...cambios } releído (sin await entre leer y escribir).
  // Devuelve la vista nueva para que la UI redibuje con lo guardado.
  const guardarCon = validar => apiRoute(async (req) => {
    let cambios;
    try { cambios = validar(req); } catch (err) { return { error: err.message }; }
    const nuevo = { ...leerCosteo(), ...cambios };
    guardarJSON(COSTEO_PATH, nuevo);
    return cfgEsq.configEsquemaDe(nuevo);
  });

  router.get('/api/precios/config/esquema', apiRoute(async () => cfgEsq.configEsquemaDe(leerCosteo())));
  router.put('/api/precios/config/esquema/costos', guardarCon(req => cfgEsq.validarCostos(cuerpo(req))));
  router.put('/api/precios/config/esquema/precio', guardarCon(req => cfgEsq.validarPrecio(cuerpo(req))));
  // Las 3 tablas por canal (+ ajuste por peso de Fraccionado) reemplazan a margenes entero.
  router.put('/api/precios/config/esquema/margenes', guardarCon(req => ({ margenes: cfgEsq.validarMargenes(cuerpo(req)) })));

  const TIPOS_LISTADO = cfgEsq.TIPOS;
  const sinConfig = req => !!(req && req.preciosSinConfig === true); // lo marca guardPrecios (server.js)

  // Lo común a los tres listados: config del motor, vigentes (lista 0) y vínculos pack/bulto con sus unidades.
  async function contexto(costeo) {
    const pb = costeo.packBulto || {};
    const [vigentes, { vinculos }] = await Promise.all([consultas.preciosVigentesAlmacen(), consultas.vinculosPackBulto(pb.vinculosManuales || {})]);
    return { cfg: cfgEsq.configEsquemaDe(costeo), vigentes, mayoristasDe: L.crearMayoristasDe({ vinculos, vigentes, ventaPesable: pb.ventaPesable || {} }) };
  }

  // Filas completas (con desglose) de un tipo. ponytail: el export arma los tres y cada uno repite vigentes y vínculos
  // (dos consultas de más por tipo); compartir el contexto si el export se pone lento.
  async function listado(tipo, costeo) {
    if (tipo === 'almacen') {
      const [ctx, universo] = await Promise.all([contexto(costeo), consultas.universoAlmacen()]);
      return L.listadoReventa({ universo, costeo, ...ctx });
    }
    if (tipo === 'fraccionado') {
      const formulas = formulasPesables();
      const [ctx, { graneles, presentaciones, costos }] = await Promise.all([contexto(costeo), consultas.universoFraccionado(formulas)]);
      return L.listadoFraccionado({ grupos: L.agruparPorGranel({ graneles, presentaciones, formulas, costos }), costos, costeo, ...ctx });
    }
    const [ctx, presentaciones] = await Promise.all([contexto(costeo), presentacionesProduccion(costeo)]);
    return L.listadoProduccion({ presentaciones, costeo, ...ctx });
  }

  // Propuesta de rango (percentiles 5–95, rangoDesdeCostos) sobre los costos de sistema (+ costos extra) de los TRES
  // tipos, porque las tablas son por canal: Reventa por producto, Fraccionado $/kg por granel, Producción por
  // presentación. NO guarda: la UI la carga en las tres tablas y se guarda con Márgenes.
  router.post('/api/precios/config/esquema/rango', apiRoute(async () => {
    const costeo = await costeoVigente();
    const listados = await Promise.all(cfgEsq.TIPOS.map(t => listado(t, costeo)));
    const costos = listados.flat().map(f => f.costos.sistema).filter(c => c > 0);
    const rango = rangoDesdeCostos(costos);
    return rango ? { rango, n: costos.length } : { error: 'No hay suficientes costos de sistema para calcular el rango' };
  }));

  router.get('/api/precios/esquema/listado', apiRoute(async (req) => {
    const tipo = String(req.query.tipo || '');
    if (!TIPOS_LISTADO.includes(tipo)) return { error: `tipo inválido (${TIPOS_LISTADO.join(', ')})` };
    const costeo = await costeoVigente();
    const filas = await listado(tipo, costeo);
    const { migrado, toleranciaPct } = cfgEsq.configEsquemaDe(costeo);
    return { migrado, toleranciaPct, filas: filas.map(f => L.filaPublica(f)) };
  }));

  // Una fila (Fraccionado: un granel con sus presentaciones). Desglose y costos extra sólo con el permiso.
  // ponytail: arma el listado entero para devolver una fila, como el detalle viejo.
  router.get('/api/precios/esquema/detalle/:plu', apiRoute(async (req) => {
    const tipo = String(req.query.tipo || '');
    if (!TIPOS_LISTADO.includes(tipo)) return { error: `tipo inválido (${TIPOS_LISTADO.join(', ')})` };
    const plu = String(req.params.plu || '').trim();
    const fila = (await listado(tipo, await costeoVigente())).find(f => f.plu === plu);
    return fila ? L.filaPublica(fila, !sinConfig(req)) : { error: `PLU ${plu} no encontrado en ${tipo}` };
  }));

  // body { fuente: 'sistema' | 'ultimaCompra' | 'manual' | null } (null quita). Cualquier usuario del módulo. La decisión
  // guarda quién la tomó (se borra cuando ese usuario recarga /precios) y la foto de los vigentes de la fila (vence si
  // SIGA los cambia), spec §3.
  router.put('/api/precios/decision/:plu', apiRoute(async (req) => {
    const plu = String(req.params.plu || '').trim();
    const body = cuerpo(req);
    if (!('fuente' in body)) return { error: 'falta fuente (sistema, ultimaCompra, manual o null)' };
    let error = L.validarDecision(plu, body.fuente, leerCosteo());
    let vigente = null;
    if (!error && body.fuente != null) { // ponytail: arma los tres listados; si pesa, buscar sólo en el tipo del PLU
      const costeo = await costeoVigente();
      const [almacen, fraccionado, produccion] = await Promise.all(TIPOS_LISTADO.map(t => listado(t, costeo)));
      error = L.validarDecisionContraFilas({ almacen, fraccionado, produccion }, plu, body.fuente);
      if (!error) vigente = L.vigentesDeFila([...almacen, ...produccion, ...fraccionado].find(f => f.plu === plu));
    }
    if (error) return { error };
    const costeo = leerCosteo(); // releído tras los await: sin await entre leer y escribir
    const decisiones = L.aplicarDecision(costeo.decisiones, plu, body.fuente, hoyISO(), { usuario: usuarioDe(req), vigente });
    guardarJSON(COSTEO_PATH, { ...costeo, decisiones });
    return { plu, decision: decisiones[plu] || null };
  }));

  router.delete('/api/precios/decisiones', apiRoute(async () => {
    guardarJSON(COSTEO_PATH, { ...leerCosteo(), decisiones: {} });
    return { decisiones: {} };
  }));

  // Al cargar /precios el front borra las decisiones del usuario de la sesión (las de otros usuarios quedan), spec §3.
  router.delete('/api/precios/decisiones/mias', apiRoute(async (req) => {
    const usuario = usuarioDe(req);
    const costeo = leerCosteo();
    const decisiones = Object.fromEntries(Object.entries(costeo.decisiones || {}).filter(([, d]) => ((d && d.usuario) || null) !== usuario));
    const borradas = Object.keys(costeo.decisiones || {}).length - Object.keys(decisiones).length;
    if (borradas) guardarJSON(COSTEO_PATH, { ...costeo, decisiones });
    return { borradas };
  }));

  // Las 5 listas (minorista, pack/bulto sin y con IVA) de los productos decididos; el front escribe un archivo por lista.
  router.get('/api/precios/esquema/export', apiRoute(async () => {
    const costeo = await costeoVigente();
    const [almacen, fraccionado, produccion] = await Promise.all(TIPOS_LISTADO.map(t => listado(t, costeo)));
    const { items, omitidos } = L.itemsDecididos({ almacen, fraccionado, produccion });
    return { listas: L.listasExport(items, cfgEsq.configEsquemaDe(costeo).ivaVentaPct), omitidos };
  }));

  return router;
};

function hoyISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
