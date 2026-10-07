'use strict';
const express = require('express');
const path = require('path');
const cfgEsq = require('../lib/precios_config_esquema');
const { rangoDesdeCostos } = require('../lib/precios_esquema');
const { aplicarCostosExtra } = require('../lib/precios_costeo');
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

  // Presentaciones de Producción con su costo por unidad: el mismo costearTodos que la tab Producción (en la fase 3
  // el costo de Producción no cambia; sólo la cadena de precio pasa al esquema).
  async function presentacionesProduccion(costeo) {
    const datos = normalizarDatos(leerJSON(RECETAS_PATH, {}));
    const costos = await consultas.costosPorPlu(plusUsados(datos.productos));
    const costeados = costearTodos({ productos: datos.productos, costos, costeo, datos });
    return Object.entries(costeados).flatMap(([productoId, c]) => Object.entries(c.presentaciones || {})
      .map(([plu, p]) => ({ productoId, plu, nombre: p.nombre || c.nombre, costoUnidad: p.costoUnidad })));
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
  router.put('/api/precios/config/esquema/margenes/:tipo', guardarCon(req => {
    const tipo = String(req.params.tipo || '');
    const tablas = cfgEsq.validarMargenesTipo(tipo, cuerpo(req));
    return { margenes: { ...(leerCosteo().margenes || {}), [tipo]: tablas } };
  }));

  // Costos de sistema (+ costos extra) del tipo, para "Recalcular rango". Reventa: cada producto; Fraccionado: $/kg de
  // cada granel; Producción: costo por unidad de cada presentación. (La fase 3 lo pasa a usar los listados.)
  async function costosDelTipo(tipo, costeo) {
    const conExtras = (plu, costo) => aplicarCostosExtra(costo, ((costeo.costosExtraFraccionado || {})[plu]) || []).costoTotal;
    if (tipo === 'almacen') return (await consultas.universoAlmacen()).map(p => conExtras(p.plu, p.costoSistema));
    if (tipo === 'fraccionado') {
      const { graneles, costos } = await consultas.universoFraccionado(formulasPesables());
      return graneles.map(g => conExtras(g.plu, (costos.get(g.plu) || {}).costoSistema ?? null));
    }
    return (await presentacionesProduccion(costeo)).map(p => p.costoUnidad);
  }

  // Propuesta de rango (percentiles 5–95, rangoDesdeCostos). NO guarda: la UI la carga en las tres tablas del tipo y se
  // guarda con Márgenes.
  router.post('/api/precios/config/esquema/rango/:tipo', apiRoute(async (req) => {
    const tipo = String(req.params.tipo || '');
    if (!cfgEsq.TIPOS.includes(tipo)) return { error: `tipo inválido (${cfgEsq.TIPOS.join(', ')})` };
    const costos = (await costosDelTipo(tipo, leerCosteo())).filter(c => c > 0);
    const rango = rangoDesdeCostos(costos);
    return rango ? { rango, n: costos.length } : { error: 'No hay suficientes costos de sistema para calcular el rango' };
  }));

  return router;
};
