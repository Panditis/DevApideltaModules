'use strict';
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const pn = require('../lib/plan_nueva');

// ── Planificación nueva (/planificacion-nueva) ─────────────────────────────────────────────────
// Spec docs/superpowers/specs/2026-10-22-planificacion-nueva-design.md §5. Datos propios en
// data/plan_nueva_{catalogo,params,ordenes}.json; responsables de data/responsables.json (el mismo de
// /planificacion). Cálculos y validaciones en lib/plan_nueva.js; acá sólo I/O.
module.exports = function crearRutasPlanNueva(deps) {
  const { leerJSON, guardarJSON, query, DATA_DIR } = deps;
  const router = express.Router();
  const CATALOGO_PATH = path.join(DATA_DIR, 'plan_nueva_catalogo.json');
  const PARAMS_PATH = path.join(DATA_DIR, 'plan_nueva_params.json');
  const ORDENES_PATH = path.join(DATA_DIR, 'plan_nueva_ordenes.json');
  const RESP_PATH = path.join(DATA_DIR, 'responsables.json');
  const LOTE = 1000;

  const leerCategorias = () => leerJSON(CATALOGO_PATH, { categorias: [] }).categorias || [];
  const guardarCategorias = categorias => guardarJSON(CATALOGO_PATH, { categorias });

  // Como apiRoute de server.js, pero respeta err.status (400/404/409 de lib/plan_nueva.js).
  const ruta = fn => async (req, res) => {
    try { res.json(await fn(req)); } catch (err) {
      if (!err.status) console.error('[plan-nueva]', err.message);
      res.status(err.status || 500).json({ error: err.message });
    }
  };

  async function enLotes(plus, sqlFn) {
    const out = [];
    for (let i = 0; i < plus.length; i += LOTE) out.push(...await query(sqlFn(plus.slice(i, i + LOTE))));
    return out;
  }

  // PLU → NombreProducto de SIGA (misma consulta que nombresSiga de rutas_plan_tablero.js). Los PLU llegan
  // validados como dígitos por lib/plan_nueva.js. Un PLU ausente del Map no existe en SIGA.
  async function nombresSiga(plus) {
    const rows = await enLotes(plus, l => `SELECT CAST(IdProducto AS VARCHAR) AS IdProducto, NombreProducto FROM Productos WHERE CAST(IdProducto AS VARCHAR) IN (${l.map(p => `'${p}'`).join(',')})`);
    return new Map(rows.map(r => [String(r.IdProducto).trim(), String(r.NombreProducto || '').trim()]));
  }
  // Nombres de `plus`, exigiendo que los `nuevos` existan en SIGA (un PLU ya cargado que SIGA dio de baja no
  // bloquea editar la categoría).
  async function nombresExigidos(plus, nuevos) {
    const nombres = await nombresSiga(plus);
    const faltan = nuevos.filter(p => !nombres.has(p));
    if (faltan.length) throw pn.errorHttp(400, `PLU inexistente en SIGA: ${faltan.join(', ')}`);
    return nombres;
  }
  const conPresentaciones = (c, nombres) => ({
    ...c,
    presentaciones: c.plus.map(plu => ({ plu, nombre: nombres.get(plu) || `PLU ${plu}` })),
  });

  // ── Catálogo ──
  router.get('/api/plan-nueva/catalogo', ruta(async () => {
    const categorias = leerCategorias();
    let nombres = new Map();
    try { nombres = await nombresSiga(categorias.flatMap(c => c.plus)); }
    catch (err) { console.error('[plan-nueva] nombres SIGA:', err.message); } // sin SIGA se edita igual, con "PLU n"
    return { categorias: categorias.map(c => conPresentaciones(c, nombres)) };
  }));

  // Se valida, se consulta SIGA y recién después se relee y guarda: lo que otro request guardó durante el
  // await no se pisa (y la validación se repite contra lo releído).
  router.post('/api/plan-nueva/catalogo', ruta(async req => {
    const { plus } = pn.validarCategoria(req.body, leerCategorias());
    const nombres = await nombresExigidos(plus, plus);
    const r = pn.agregarCategoria(leerCategorias(), req.body, { id: crypto.randomUUID(), ahora: new Date().toISOString() });
    guardarCategorias(r.categorias);
    return conPresentaciones(r.categoria, nombres);
  }));

  router.put('/api/plan-nueva/catalogo/:id', ruta(async req => {
    const id = String(req.params.id);
    const previa = leerCategorias().find(c => c.id === id);
    if (!previa) throw pn.errorHttp(404, 'No existe la categoría');
    const { plus } = pn.validarCategoria(req.body, leerCategorias(), id);
    const nombres = await nombresExigidos(plus, plus.filter(p => !previa.plus.includes(p)));
    const r = pn.editarCategoria(leerCategorias(), id, req.body);
    guardarCategorias(r.categorias);
    return conPresentaciones(r.categoria, nombres);
  }));

  router.delete('/api/plan-nueva/catalogo/:id', ruta(async req => {
    guardarCategorias(pn.borrarCategoria(leerCategorias(), String(req.params.id)));
    return { ok: true };
  }));

  return router;
};
