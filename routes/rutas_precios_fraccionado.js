'use strict';
const express = require('express');
const path = require('path');
const { crearConsultasPrecios } = require('../lib/precios_consultas');
const cfgEsq = require('../lib/precios_config_esquema');
const { agruparPorGranel } = require('../lib/precios_listado_esquema');
const { formulasPesables } = require('../lib/formulas_pesables');
const FC = require('../lib/precios_fraccionado_costo');
const CF = require('../lib/precios_config_fraccionado');

// ── Precios · costeo de Fraccionado (spec 2026-10-21-precios-fraccionado-costeo-design §9) ──────────────────────────────────
// Configuración (bajo /api/precios/config/ → permiso precios-config por RUTAS_CONFIG): máquinas, escalas de facilidad y tiempo,
// máquina + tramos por subrubro y la excepción de máquina por granel. Trabajo (/api/precios/fraccionado/…, cualquiera con
// acceso a Precios): facilidad, tiempo e insumos de las presentaciones. Escribe sólo dentro de costeo.fraccionado (lo crea
// scripts/migrar_config_fraccionado.js), siempre con la forma nueva (CF.fraccionadoConCambios).
const BASE = '/api/precios/config/esquema/fraccionado';
const API_PRESENTACIONES = '/api/precios/fraccionado/presentaciones';

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

  // Lo que pinta Configuración (sin SIGA): máquinas con quién las usa, escalas, subrubros y excepciones por granel.
  function vista(f) {
    const cf = FC.normalizarCosteoFraccionado(f);
    const usos = CF.usosMaquinas(cf);
    return { costoHora: cf.costoHora, escalas: cf.escalas, subrubros: cf.subrubros, porGranel: cf.porGranel,
      maquinas: cf.maquinas.map(m => ({ ...m, usos: usos[m.id] || { graneles: 0, subrubros: 0 } })) };
  }

  // calcular(req, cf, contexto) → cambios para costeo.fraccionado (o tira). Sin await entre leer y escribir. responder(fraccionado
  // nuevo). preparar() (opcional, async: pide algo a SIGA) corre antes de leer el archivo, y sólo si ya está migrado; su
  // resultado es el contexto de calcular. Si falla sube como error del servidor y no se escribe nada.
  const sinMigrar = costeo => !cfgEsq.fraccionadoMigrado(costeo);
  const guardarFracc = (calcular, responder = f => ({ migrado: true, ...vista(f) }), preparar = null) => apiRoute(async (req) => {
    if (preparar && sinMigrar(leerCosteo())) return { error: cfgEsq.SIN_MIGRAR_FRACCIONADO };
    const contexto = preparar ? await preparar() : null;
    const costeo = leerCosteo();
    if (sinMigrar(costeo)) return { error: cfgEsq.SIN_MIGRAR_FRACCIONADO };
    let cambios;
    try { cambios = calcular(req, FC.normalizarCosteoFraccionado(costeo.fraccionado), contexto); } catch (err) { return { error: err.message }; }
    const fraccionado = CF.fraccionadoConCambios(costeo.fraccionado, cambios);
    guardarJSON(COSTEO_PATH, { ...costeo, fraccionado });
    return responder(fraccionado);
  });

  // Liviano (sin SIGA): el modal del granel lo usa para el select de máquinas.
  router.get(BASE, apiRoute(async () => {
    const costeo = leerCosteo();
    return { migrado: cfgEsq.fraccionadoMigrado(costeo), ...vista(costeo.fraccionado) };
  }));

  // Panel completo: lo de arriba + los productos (graneles con sus presentaciones) de cada subrubro de SIGA.
  // ponytail: arma el universo de Fraccionado entero (como el listado) para agrupar; una consulta propia si se pone lento.
  router.get(`${BASE}/costeo`, apiRoute(async () => {
    const costeo = leerCosteo();
    const formulas = await formulasVigentes();
    const { graneles, presentaciones, costos } = await consultas.universoFraccionado(formulas);
    const grupos = agruparPorGranel({ graneles, presentaciones, formulas, costos });
    return { migrado: cfgEsq.fraccionadoMigrado(costeo), ...vista(costeo.fraccionado), ...CF.productosPorSubrubro(grupos) };
  }));

  router.put(`${BASE}/maquinas`, guardarFracc((req, cf) => CF.validarMaquinas(cuerpo(req), cf)));
  router.put(`${BASE}/escalas`, guardarFracc(req => CF.validarEscalas(cuerpo(req))));
  router.put(`${BASE}/subrubros/:id`, guardarFracc((req, cf) => ({ subrubros: CF.aplicarSubrubro(cf.subrubros, idDe(req), cuerpo(req), cf.maquinas) })));
  // ponytail: no se valida que el PLU sea un granel del listado (sería pedir SIGA); una entrada de un PLU que no está no costea nada.
  router.put(`${BASE}/granel/:plu`, guardarFracc((req, cf) => ({ porGranel: CF.aplicarGranel(cf.porGranel, pluDe(req), cuerpo(req), cf.maquinas) })));
  // Trabajo: responde sólo ok (sin la configuración: lo usa quien no tiene precios-config). Cualquier usuario de Precios la usa:
  // cada PLU tiene que ser una presentación del universo de Fraccionado (el mismo del listado), el lote entero se rechaza si no.
  // ponytail: arma el universo entero (con costos) sólo para tener los PLUs; una consulta liviana de presentaciones si pesa.
  const plusPresentaciones = async () => {
    const { presentaciones } = await consultas.universoFraccionado(await formulasVigentes());
    return new Set(presentaciones.map(p => String(p.plu)));
  };
  router.put(API_PRESENTACIONES, guardarFracc((req, cf, permitidos) => ({ presentaciones: CF.aplicarPresentaciones(cf.presentaciones, cuerpo(req), permitidos) }),
    () => ({ ok: true }), plusPresentaciones));

  return router;
};
