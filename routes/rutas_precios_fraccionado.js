'use strict';
const express = require('express');
const path = require('path');
const { crearConsultasPrecios } = require('../lib/precios_consultas');
const cfgEsq = require('../lib/precios_config_esquema');
const { costoEnSuTab } = require('../lib/precios_listado_esquema');
const FC = require('../lib/precios_fraccionado_costo');
const CF = require('../lib/precios_config_fraccionado');

// ── Precios · Configuración › Costeo Fraccionado (spec 2026-10-21-precios-fraccionado-costeo-design §2.5) ──────────────
// Máquinas, tiempos por peso + facilidades, insumos por subrubro, y por granel (facilidad, máquina) / presentación (insumos
// propios). Todo bajo /api/precios/config/ → permiso precios-config por RUTAS_CONFIG (lib/precios_permisos), sin tocar el
// guard. Escribe sólo dentro de costeo.fraccionado (lo crea scripts/migrar_config_fraccionado.js, Plan A).
const BASE = '/api/precios/config/esquema/fraccionado';

module.exports = function crearRutasPreciosFraccionado(deps) {
  const { apiRoute, leerJSON, guardarJSON, DATA_DIR } = deps;
  const router = express.Router();
  const COSTEO_PATH = path.join(DATA_DIR, 'costeo.json');
  const consultas = crearConsultasPrecios(deps);
  const leerCosteo = () => leerJSON(COSTEO_PATH, {}) || {};
  const cuerpo = req => (req.body && typeof req.body === 'object' ? req.body : {});
  const pluDe = req => String(req.params.plu || '').trim();

  // Lo que pinta la UI (sin SIGA): secciones con defaults y cuántos graneles usan cada máquina.
  function vista(f) {
    const cf = FC.normalizarCosteoFraccionado(f);
    const usos = CF.usosMaquinas(cf.porGranel);
    return { ...cf, maquinas: cf.maquinas.map(m => ({ ...m, usos: usos[m.id] || 0 })) };
  }

  // calcular(req, cf) → cambios para costeo.fraccionado (o tira). Sin await entre leer y escribir. Devuelve la vista nueva.
  const guardarFracc = calcular => apiRoute(async (req) => {
    const costeo = leerCosteo();
    if (!cfgEsq.fraccionadoMigrado(costeo)) return { error: cfgEsq.SIN_MIGRAR_FRACCIONADO };
    let cambios;
    try { cambios = calcular(req, FC.normalizarCosteoFraccionado(costeo.fraccionado)); } catch (err) { return { error: err.message }; }
    const fraccionado = { ...costeo.fraccionado, ...cambios };
    guardarJSON(COSTEO_PATH, { ...costeo, fraccionado });
    return { migrado: true, ...vista(fraccionado) };
  });

  // Liviano (sin SIGA): el modal del granel lo usa para el select de máquinas.
  router.get(BASE, apiRoute(async () => {
    const costeo = leerCosteo();
    return { migrado: cfgEsq.fraccionadoMigrado(costeo), ...vista(costeo.fraccionado) };
  }));

  // Panel completo: secciones + subrubros de los graneles (SIGA) + nombre y costo en su tab de cada insumo usado.
  router.get(`${BASE}/costeo`, apiRoute(async () => {
    const costeo = leerCosteo();
    const v = vista(costeo.fraccionado);
    const [subrubros, filas] = await Promise.all([consultas.subrubrosGraneles(), consultas.costosPorPlu(FC.plusInsumos(v))]);
    const insumos = Object.fromEntries([...filas].map(([plu, row]) => [plu, { nombre: row.nombre, costo: costoEnSuTab(row, costeo, plu).costo }]));
    return { migrado: cfgEsq.fraccionadoMigrado(costeo), ...v, subrubros, insumos };
  }));

  router.put(`${BASE}/maquinas`, guardarFracc((req, cf) => CF.validarMaquinas(cuerpo(req), cf)));
  router.put(`${BASE}/tiempos`, guardarFracc(req => CF.validarTiempos(cuerpo(req))));
  router.put(`${BASE}/insumos-subrubro`, guardarFracc(req => CF.validarInsumosSubrubro(cuerpo(req))));
  // ponytail: no se valida que el PLU sea un granel del listado (sería pedir SIGA); una entrada de un PLU que no está no costea nada.
  router.put(`${BASE}/granel/:plu`, guardarFracc((req, cf) => ({ porGranel: CF.aplicarGranel(cf.porGranel, pluDe(req), cuerpo(req), cf.maquinas) })));
  router.put(`${BASE}/insumos-presentacion/:plu`, guardarFracc((req, cf) =>
    ({ insumosPresentacion: CF.aplicarInsumosPresentacion(cf.insumosPresentacion, pluDe(req), cuerpo(req)) })));

  return router;
};
