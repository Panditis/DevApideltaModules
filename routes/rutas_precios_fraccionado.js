'use strict';
const express = require('express');
const path = require('path');
const { crearConsultasPrecios } = require('../lib/precios_consultas');
const cfgEsq = require('../lib/precios_config_esquema');
const { agruparPorGranel, crearCostoDe } = require('../lib/precios_listado_esquema');
const { formulasPesables } = require('../lib/formulas_pesables');
const FC = require('../lib/precios_fraccionado_costo');
const CF = require('../lib/precios_config_fraccionado');

// ── Precios · costeo de Fraccionado (spec 2026-10-21-precios-fraccionado-costeo-design §9; 2026-10-23-…-peso-subrubro §4) ──
// Todo bajo /api/precios/config/ (permiso precios-config por RUTAS_CONFIG): máquinas, escalas de facilidad y tiempo, máquina +
// tramos + facilidad + tiempo por subrubro, la excepción de máquina por granel y los insumos por peso. Escribe sólo dentro de
// costeo.fraccionado (lo crea scripts/migrar_config_fraccionado.js), siempre con la forma nueva (CF.fraccionadoConCambios).
const BASE = '/api/precios/config/esquema/fraccionado';

module.exports = function crearRutasPreciosFraccionado(deps) {
  const { apiRoute, leerJSON, guardarJSON, DATA_DIR } = deps;
  const router = express.Router();
  const COSTEO_PATH = path.join(DATA_DIR, 'costeo.json');
  const consultas = crearConsultasPrecios(deps);
  const leerCosteo = () => leerJSON(COSTEO_PATH, {}) || {};
  const formulasVigentes = () => formulasPesables({ query: deps.query, FORMULA_ACTIVA_SQL: deps.FORMULA_ACTIVA_SQL,
    respaldo: (leerJSON(path.join(DATA_DIR, 'pesables_listas.json'), {}) || {}).formulas });
  const cuerpo = req => (req.body && typeof req.body === 'object' ? req.body : {});
  const pluDe = req => String(req.params.plu || '').trim();
  const idDe = req => String(req.params.id || '').trim();
  const pesoDe = req => String(req.params.pesoG || '').trim();

  // Lo que pinta Configuración (sin SIGA): máquinas con quién las usa, escalas, subrubros, excepciones por granel, insumos
  // por peso (crudos: { [pesoG]: [{ plu, cantidad }] }) y el ajuste por peso del margen (margenes.ajustesPeso o null).
  function vista(f) {
    const cf = FC.normalizarCosteoFraccionado(f);
    const usos = CF.usosMaquinas(cf);
    const margenes = (f && f.margenes) || {};
    return { costoHora: cf.costoHora, escalas: cf.escalas, subrubros: cf.subrubros, porGranel: cf.porGranel, insumosPorPeso: cf.insumosPorPeso,
      maquinas: cf.maquinas.map(m => ({ ...m, usos: usos[m.id] || { graneles: 0, subrubros: 0 } })), ajustesPeso: margenes.ajustesPeso || null };
  }

  // calcular(req, cf, f) → cambios para costeo.fraccionado (o tira); f = el bloque tal cual. Sin await entre leer y escribir.
  // Responde la vista.
  const guardarFracc = calcular => apiRoute(async (req) => {
    const costeo = leerCosteo();
    if (!cfgEsq.fraccionadoMigrado(costeo)) return { error: cfgEsq.SIN_MIGRAR_FRACCIONADO };
    let cambios;
    try { cambios = calcular(req, FC.normalizarCosteoFraccionado(costeo.fraccionado), costeo.fraccionado); } catch (err) { return { error: err.message }; }
    const fraccionado = CF.fraccionadoConCambios(costeo.fraccionado, cambios);
    guardarJSON(COSTEO_PATH, { ...costeo, fraccionado });
    return { migrado: true, ...vista(fraccionado) };
  });

  // Liviano (sin SIGA): el modal del granel lo usa para el select de máquinas.
  router.get(BASE, apiRoute(async () => {
    const costeo = leerCosteo();
    return { migrado: cfgEsq.fraccionadoMigrado(costeo), ...vista(costeo.fraccionado) };
  }));

  // Panel completo: lo de arriba + los productos (graneles con sus presentaciones y su peso) de cada subrubro de SIGA, los pesos
  // del universo y los insumos por peso con nombre y costo en su tab (el mismo costo que usa el listado).
  // ponytail: arma el universo de Fraccionado entero (como el listado) para agrupar; una consulta propia si se pone lento.
  router.get(`${BASE}/costeo`, apiRoute(async () => {
    const costeo = leerCosteo();
    const cf = FC.normalizarCosteoFraccionado(costeo.fraccionado);
    const formulas = await formulasVigentes();
    const { graneles, presentaciones, costos } = await consultas.universoFraccionado(formulas, FC.plusInsumos(cf));
    const grupos = agruparPorGranel({ graneles, presentaciones, formulas, costos });
    return { migrado: cfgEsq.fraccionadoMigrado(costeo), ...vista(costeo.fraccionado), ...CF.productosPorSubrubro(grupos),
      insumosPorPeso: CF.insumosConCosto(cf.insumosPorPeso, crearCostoDe(costos, costeo)) };
  }));

  router.put(`${BASE}/maquinas`, guardarFracc((req, cf) => CF.validarMaquinas(cuerpo(req), cf)));
  router.put(`${BASE}/escalas`, guardarFracc(req => CF.validarEscalas(cuerpo(req))));
  router.put(`${BASE}/subrubros/:id`, guardarFracc((req, cf) => ({ subrubros: CF.aplicarSubrubro(cf.subrubros, idDe(req), cuerpo(req), cf.maquinas) })));
  // ponytail: no se valida que el PLU sea un granel del listado (sería pedir SIGA); una entrada de un PLU que no está no costea nada.
  router.put(`${BASE}/granel/:plu`, guardarFracc((req, cf) => ({ porGranel: CF.aplicarGranel(cf.porGranel, pluDe(req), cuerpo(req), cf.maquinas) })));
  // ponytail: tampoco se valida que el peso tenga presentaciones (sería pedir SIGA); Configuración lo marca "sin presentaciones".
  router.put(`${BASE}/insumos-peso/:pesoG`, guardarFracc((req, cf) => ({ insumosPorPeso: CF.aplicarInsumosPeso(cf.insumosPorPeso, pesoDe(req), cuerpo(req)) })));
  // Ajuste por peso del margen (antes en Márgenes): body { ajustesPeso: { tramosG, puntos } | null }. Va en margenes.ajustesPeso
  // del bloque, donde lo lee el motor; las tablas por canal no se tocan.
  router.put(`${BASE}/ajustes-peso`, guardarFracc((req, _cf, f) => ({ margenes: cfgEsq.margenesConAjustePeso(f.margenes, cuerpo(req)) })));

  return router;
};
