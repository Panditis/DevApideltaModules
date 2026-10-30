'use strict';
const express = require('express');
const path = require('path');
const { crearConsultasPrecios } = require('../lib/precios_consultas');
const cfgEsq = require('../lib/precios_config_esquema');
const { agruparPorGranel, crearCostoDe } = require('../lib/precios_listado_esquema');
const { formulasPesables } = require('../lib/formulas_pesables');
const FC = require('../lib/precios_fraccionado_costo');
const CF = require('../lib/precios_config_fraccionado');
const HIST = require('../lib/precios_fraccionado_historial');

// ── Precios · costeo de Fraccionado (spec 2026-10-21-precios-fraccionado-costeo-design §9; 2026-10-23-…-peso-subrubro §4) ──
// Todo bajo /api/precios/config/ (permiso precios-config por RUTAS_CONFIG): máquinas, ajuste ± min/kg por tramo de peso,
// min/kg por subrubro, min/kg y máquina por granel y el envase por peso (spec 2026-10-29-…-tiempos-historial). Escribe sólo dentro de
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

  // Lo que pinta Configuración (sin SIGA): máquinas con cuántos graneles las usan, tramos de tiempo, min/kg por subrubro, min/kg
  // y máquina (y envase) por granel, envase por peso (crudo: { [pesoG]: { bolsaPlu?, bobinaG? } }), $/kg de bobina y el ajuste por peso del margen.
  // activoGranel: estado en el listado fijado a mano (costeo.activoGranel, top-level; ausente = automático).
  function vista(f, activoGranel) {
    const cf = FC.normalizarCosteoFraccionado(f);
    const usos = CF.usosMaquinas(cf);
    const margenes = (f && f.margenes) || {};
    return { costoHora: cf.costoHora, tramosTiempo: cf.tramosTiempo, subrubros: cf.subrubros, porGranel: cf.porGranel, envasePorPeso: cf.envasePorPeso,
      costoBobinaKg: cf.costoBobinaKg, activoGranel: activoGranel || {},
      maquinas: cf.maquinas.map(m => ({ ...m, usos: usos[m.id] || { graneles: 0 } })), ajustesPeso: margenes.ajustesPeso || null };
  }

  // calcular(req, cf, f) → cambios para costeo.fraccionado (o tira); f = el bloque tal cual. Sin await entre leer y escribir.
  // activos(req, costeo) opcional → costeo.activoGranel nuevo (o tira): misma escritura, todo o nada. Responde la vista.
  const guardarFracc = (calcular, activos) => apiRoute(async (req) => {
    const costeo = leerCosteo();
    if (!cfgEsq.fraccionadoMigrado(costeo)) return { error: cfgEsq.SIN_MIGRAR_FRACCIONADO };
    let cambios, activoGranel = costeo.activoGranel;
    try {
      cambios = calcular(req, FC.normalizarCosteoFraccionado(costeo.fraccionado), costeo.fraccionado);
      if (activos) activoGranel = activos(req, costeo);
    } catch (err) { return { error: err.message }; }
    const fraccionado = CF.fraccionadoConCambios(costeo.fraccionado, cambios);
    guardarJSON(COSTEO_PATH, { ...costeo, fraccionado, ...(activoGranel === undefined ? {} : { activoGranel }) });
    return { migrado: true, ...vista(fraccionado, activoGranel) };
  });

  // Liviano (sin SIGA): el modal del granel lo usa para el select de máquinas.
  router.get(BASE, apiRoute(async () => {
    const costeo = leerCosteo();
    return { migrado: cfgEsq.fraccionadoMigrado(costeo), ...vista(costeo.fraccionado, costeo.activoGranel) };
  }));

  // Panel completo: lo de arriba + los productos (graneles con sus presentaciones y su peso) de cada subrubro de SIGA, los pesos
  // del universo y el envase por peso con nombre y costo de la bolsa en su tab (el mismo costo que usa el listado).
  // ponytail: arma el universo de Fraccionado entero (como el listado) para agrupar; una consulta propia si se pone lento.
  router.get(`${BASE}/costeo`, apiRoute(async () => {
    const costeo = leerCosteo();
    const cf = FC.normalizarCosteoFraccionado(costeo.fraccionado);
    const formulas = await formulasVigentes();
    const { graneles, presentaciones, costos } = await consultas.universoFraccionado(formulas, FC.plusInsumos(cf));
    const grupos = agruparPorGranel({ graneles, presentaciones, formulas, costos });
    return { migrado: cfgEsq.fraccionadoMigrado(costeo), ...vista(costeo.fraccionado, costeo.activoGranel), ...CF.productosPorSubrubro(grupos),
      envasePorPeso: CF.envaseConCosto(cf.envasePorPeso, crearCostoDe(costos, costeo)) };
  }));

  // Sugerido de min/kg desde el historial (E2). Sólo lectura: no escribe nada ni cachea (ponytail: ≈2 MB + una consulta;
  // cache por mtime del archivo + tabla guardada si pasa de 1 s).
  router.get(`${BASE}/historial`, apiRoute(async () => {
    const dias = leerJSON(path.join(DATA_DIR, 'historial_distribucion.json'), []);
    if (!Array.isArray(dias)) throw new Error('historial_distribucion.json no es una lista de días');
    let graneles;
    try { graneles = await consultas.granelesConSubrubro(); } catch (err) {
      console.error('[precios] historial fraccionado: graneles de SIGA', err);
      throw new Error('No se pudieron leer los graneles de SIGA');
    }
    const formulas = (leerJSON(path.join(DATA_DIR, 'pesables_listas.json'), {}) || {}).formulas;
    return HIST.estadisticasHistorial({ cargas: dias.flatMap(d => (d && d.produccion) || []), graneles, formulas,
      tramos: FC.normalizarCosteoFraccionado(leerCosteo().fraccionado).tramosTiempo });
  }));

  router.put(`${BASE}/maquinas`, guardarFracc((req, cf) => CF.validarMaquinas(cuerpo(req), cf)));
  router.put(`${BASE}/tramos-tiempo`, guardarFracc(req => CF.validarTramosTiempo(cuerpo(req))));
  // ponytail: no se valida que el PLU sea un granel del listado (sería pedir SIGA); una entrada de un PLU que no está no costea nada.
  // body { subrubros?, graneles?, activos? }: activos es el estado en el listado (costeo.activoGranel).
  router.put(`${BASE}/subrubros`, guardarFracc((req, cf) => CF.aplicarTiempos(cf, cuerpo(req)),
    (req, costeo) => CF.aplicarActivos(costeo.activoGranel, cuerpo(req))));
  router.put(`${BASE}/granel/:plu`, guardarFracc((req, cf) => ({ porGranel: CF.aplicarGranel(cf.porGranel, pluDe(req), cuerpo(req), cf.maquinas) })));
  // ponytail: tampoco se valida que el peso tenga presentaciones (sería pedir SIGA); Configuración lo marca "sin presentaciones".
  router.put(`${BASE}/envase`, guardarFracc((req, cf) => CF.aplicarEnvase(cf, cuerpo(req))));
  // Ajuste por peso del margen (antes en Márgenes): body { ajustesPeso: { tramosG, puntos } | null }. Va en margenes.ajustesPeso
  // del bloque, donde lo lee el motor; las tablas por canal no se tocan.
  router.put(`${BASE}/ajustes-peso`, guardarFracc((req, _cf, f) => ({ margenes: cfgEsq.margenesConAjustePeso(f.margenes, cuerpo(req)) })));

  return router;
};
