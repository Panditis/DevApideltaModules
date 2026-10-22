'use strict';
const express = require('express');
const path = require('path');
const { armarTablero } = require('../lib/plan_tablero');
const { metaDeEntrada, metaDeGranel, aplicarMetaGranel, granelPlusDe } = require('../lib/plan_catalogo_meta');
const { validarDiasObjetivo, resolverDiasObjetivo } = require('../lib/plan_params');
const { sqlConsumoCatalogo, sqlStockTodosDepositos, sqlStockSucursales, sqlFacturacionPorPlu } = require('../lib/plan_sql');

// ── Tablero de planificación y graneles base ─────────────────────────────────
// Spec docs/superpowers/specs/2026-10-22-planificacion-centro-design.md §1.2 y §3. Se monta ANTES
// que rutas_plan.js: GET /api/plan/:fecha capturaría /api/plan/tablero y /api/plan/graneles-base.
// sqlStockPorPlu y sqlBOMGranel viven en server.js (los usan otros routers) y entran por deps;
// config.json también, por leerConfig (en los tests no existe).
module.exports = function crearRutasPlanTablero(deps) {
  const {
    apiRoute, leerJSON, guardarJSON, query, leerConfig, DATA_DIR,
    CATALOGO_PATH, GRUPOS_CFG_PATH, sqlStockPorPlu, sqlBOMGranel,
  } = deps;
  const router = express.Router();
  const GRANELES_PATH = path.join(DATA_DIR, 'graneles_base.json');
  const PLAN_PARAMS_PATH = path.join(DATA_DIR, 'planificacion_params.json');
  const RESP_PATH = path.join(DATA_DIR, 'responsables.json');
  const CLIENTES_PATH = path.join(DATA_DIR, 'clientes.json');
  const LOTE = 1000;
  const esPlu = p => /^\d+$/.test(p);

  async function enLotes(plus, sqlFn) {
    const out = [];
    for (let i = 0; i < plus.length; i += LOTE) out.push(...await query(sqlFn(plus.slice(i, i + LOTE))));
    return out;
  }
  const mapa = (rows, col) => new Map(rows.map(r => [String(r.IdProducto).trim(), parseFloat(r[col]) || 0]));

  // Nombres de SIGA para mostrar graneles sin nombre propio. Si SIGA falla se muestra "PLU n".
  async function nombresSiga(plus) {
    const lista = plus.filter(esPlu);
    if (!lista.length) return new Map();
    try {
      const rows = await enLotes(lista, l => `SELECT CAST(IdProducto AS VARCHAR) AS IdProducto, NombreProducto FROM Productos WHERE CAST(IdProducto AS VARCHAR) IN (${l.map(p => `'${p}'`).join(',')})`);
      return new Map(rows.map(r => [String(r.IdProducto).trim(), r.NombreProducto]));
    } catch (err) {
      console.error('[graneles-base] nombres SIGA:', err.message);
      return new Map();
    }
  }

  router.get('/api/plan/tablero', apiRoute(async req => {
    const c = leerConfig();
    const catalogo = leerJSON(CATALOGO_PATH, []);
    if (!catalogo.length) throw new Error('Catálogo vacío. Importalo desde la pestaña Catálogo.');
    const gruposCfg = leerJSON(GRUPOS_CFG_PATH, {});
    const granelesBase = leerJSON(GRANELES_PATH, {});
    const ventana = parseInt(c.ventanaConsumoDias, 10) || 120;
    const dias = validarDiasObjetivo(req.query.dias) ?? resolverDiasObjetivo(leerJSON(PLAN_PARAMS_PATH, {}), c);
    const vivos = catalogo.filter(it => metaDeEntrada(gruposCfg[it.productoRef]).estado !== 'discontinuado');
    const plus = [...new Set(vivos.map(it => String(it.plu)))].filter(esPlu);
    const granelPlus = [...new Set([...Object.keys(granelesBase), ...Object.values(gruposCfg).flatMap(granelPlusDe)])].filter(esPlu);
    const rubrosG = (c.rubrosGranel || []).join(',');
    const [ventas, factur, stockC, stockS, bom, stockG, nombres] = await Promise.all([
      enLotes(plus, l => sqlConsumoCatalogo(l, ventana)),
      enLotes(plus, l => sqlFacturacionPorPlu(l, ventana)),
      enLotes(plus, sqlStockPorPlu),
      enLotes(plus, sqlStockSucursales),
      rubrosG ? enLotes(plus, l => sqlBOMGranel(rubrosG, `\n  AND pc.IdProducto IN (${l.join(',')})`)) : [],
      enLotes(granelPlus, sqlStockTodosDepositos),
      nombresSiga(granelPlus),
    ]);
    const bomGranel = new Map();
    for (const b of bom) {
      const k = String(b.IdProducto).trim();
      bomGranel.set(k, [...(bomGranel.get(k) || []), { granelPlu: String(b.IdProductoComponente).trim(), cantPorUnidad: parseFloat(b.CantPorUnidad) || 0 }]);
    }
    return armarTablero({
      catalogo: vivos, gruposCfg, granelesBase, enKgRefs: new Set(c.gruposGranelEnKg || []),
      ventas: mapa(ventas, 'UnidVendidas'), factur: mapa(factur, 'TotalFacturado'),
      stockCentral: mapa(stockC, 'StockActual'), stockSuc: mapa(stockS, 'StockActual'), stockGranel: mapa(stockG, 'StockActual'),
      bomGranel, nombres, clientes: leerJSON(CLIENTES_PATH, []),
    }, { dias, ventana, urgenciaDias: c.urgenciaDias });
  }));

  // ── Graneles base (data/graneles_base.json) ──────────────────────────────────
  const leerGraneles = () => leerJSON(GRANELES_PATH, {});
  const ctxMeta = () => ({ responsables: leerJSON(RESP_PATH, []) });
  function granelPublico(plu, v, gruposCfg, nombres) {
    const m = metaDeGranel(v);
    const variedades = Object.entries(gruposCfg)
      .filter(([, g]) => metaDeEntrada(g).tipo === 'granel' && granelPlusDe(g).includes(plu))
      .map(([ref]) => ref).sort();
    return { plu, ...m, nombre: m.nombre || nombres.get(plu) || `PLU ${plu}`, variedades };
  }
  async function responderGranel(res, plu, entrada) {
    const nombres = await nombresSiga(metaDeGranel(entrada).nombre ? [] : [plu]);
    res.json(granelPublico(plu, entrada, leerJSON(GRUPOS_CFG_PATH, {}), nombres));
  }

  router.get('/api/plan/graneles-base', apiRoute(async () => {
    const graneles = leerGraneles();
    const gruposCfg = leerJSON(GRUPOS_CFG_PATH, {});
    const nombres = await nombresSiga(Object.keys(graneles).filter(p => !metaDeGranel(graneles[p]).nombre));
    return Object.entries(graneles).map(([plu, v]) => granelPublico(plu, v, gruposCfg, nombres)).sort((a, b) => a.nombre.localeCompare(b.nombre));
  }));

  router.post('/api/plan/graneles-base', async (req, res) => {
    const body = req.body || {};
    const plu = String(body.plu || '').trim();
    if (!esPlu(plu)) return res.status(400).json({ error: 'PLU inválido' });
    const graneles = leerGraneles();
    if (Object.hasOwn(graneles, plu)) return res.status(409).json({ error: `El granel ${plu} ya existe` });
    try {
      const nuevo = aplicarMetaGranel({}, { nombre: String(body.nombre || '') }, ctxMeta());
      guardarJSON(GRANELES_PATH, { ...graneles, [plu]: nuevo });
      await responderGranel(res, plu, nuevo);
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });

  router.patch('/api/plan/graneles-base/:plu', async (req, res) => {
    const plu = String(req.params.plu);
    const graneles = leerGraneles();
    if (!esPlu(plu) || !Object.hasOwn(graneles, plu)) return res.status(404).json({ error: `No existe el granel ${plu}` });
    try {
      const nuevo = aplicarMetaGranel(graneles[plu], req.body, ctxMeta());
      guardarJSON(GRANELES_PATH, { ...graneles, [plu]: nuevo });
      await responderGranel(res, plu, nuevo);
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });

  return router;
};
