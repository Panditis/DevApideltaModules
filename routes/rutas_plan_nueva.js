'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pn = require('../lib/plan_nueva');
const { sqlConsumoCatalogo } = require('../lib/plan_sql');

// ── Planificación nueva (/planificacion-nueva) ─────────────────────────────────────────────────
// Spec docs/superpowers/specs/2026-10-22-planificacion-nueva-design.md §5. Datos propios en
// data/plan_nueva_{catalogo,params,ordenes}.json; responsables de data/responsables.json (el mismo de
// /planificacion). Cálculos y validaciones en lib/plan_nueva.js; acá sólo I/O.
module.exports = function crearRutasPlanNueva(deps) {
  // sqlStockPorPlu vive en server.js (lo usan otros routers) y entra por deps, como en rutas_plan_tablero.js.
  const { leerJSON, guardarJSON, query, DATA_DIR, sqlStockPorPlu } = deps;
  const router = express.Router();
  const CATALOGO_PATH = path.join(DATA_DIR, 'plan_nueva_catalogo.json');
  const PARAMS_PATH = path.join(DATA_DIR, 'plan_nueva_params.json');
  const ORDENES_PATH = path.join(DATA_DIR, 'plan_nueva_ordenes.json');
  const RESP_PATH = path.join(DATA_DIR, 'responsables.json');
  const LOTE = 1000;

  // Catálogo y órdenes son datos de producción sin copia: leerJSON de server.js devuelve el default ante un
  // JSON roto y el próximo guardado pisaría todo. Acá un archivo ausente es lista vacía, pero uno que existe
  // y no se puede leer tira (500 con el motivo) y no se escribe nada. Se escribe a un temporal y se renombra.
  function leerLista(archivo, clave) {
    if (!fs.existsSync(archivo)) return [];
    try {
      const lista = JSON.parse(fs.readFileSync(archivo, 'utf8'))[clave];
      if (!Array.isArray(lista)) throw new Error(`falta la lista "${clave}"`);
      return lista;
    } catch (err) {
      throw new Error(`No se pudo leer ${path.basename(archivo)}: ${err.message}`);
    }
  }
  function guardarLista(archivo, clave, lista) {
    const tmp = `${archivo}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ [clave]: lista }, null, 2), 'utf8');
    try { fs.renameSync(tmp, archivo); } catch (err) { fs.rmSync(tmp, { force: true }); throw err; } // el original queda intacto
  }

  const leerCategorias = () => leerLista(CATALOGO_PATH, 'categorias');
  const guardarCategorias = categorias => guardarLista(CATALOGO_PATH, 'categorias', categorias);

  // Como apiRoute de server.js, pero respeta err.status (400/404/409 de lib/plan_nueva.js).
  const ruta = fn => async (req, res) => {
    try { res.json(await fn(req)); } catch (err) {
      if (!err.status) console.error('[plan-nueva]', err.message);
      res.status(err.status || 500).json({ error: err.message });
    }
  };

  // Un fallo de SIGA se loguea con su detalle y se responde 503 genérico (el mensaje del driver no sale al cliente).
  async function consultarSiga(sql) {
    try { return await query(sql); } catch (err) {
      console.error('[plan-nueva] SIGA:', err.message);
      throw pn.errorHttp(503, 'SIGA no disponible');
    }
  }

  async function enLotes(plus, sqlFn) {
    const out = [];
    for (let i = 0; i < plus.length; i += LOTE) out.push(...await consultarSiga(sqlFn(plus.slice(i, i + LOTE))));
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
    catch (err) { if (err.status !== 503) throw err; } // SIGA caído (ya logueado): se edita igual, con "PLU n"
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

  // ── Parámetros, tablero y responsables ──
  router.get('/api/plan-nueva/params', ruta(async () => pn.leerParams(leerJSON(PARAMS_PATH, {}))));
  router.put('/api/plan-nueva/params', ruta(async req => {
    const params = pn.validarParams(req.body);
    guardarJSON(PARAMS_PATH, params);
    return params;
  }));

  // Ventas: sqlConsumoCatalogo (lib/plan_sql.js) ya deja afuera Casa Central y las sucursales no reales 6, 8 y 11
  // (lib/sucursales_no_reales.js); se usa su UnidVendidas ÷ N, no PromDiarioPorDia. Stock: sqlStockPorPlu de
  // server.js (Casa Central, depósitos disponibles para venta), el mismo del tablero de /planificacion.
  const mapa = (rows, col) => new Map(rows.map(r => [String(r.IdProducto).trim(), parseFloat(r[col]) || 0]));
  router.get('/api/plan-nueva/tablero', ruta(async () => {
    const params = pn.leerParams(leerJSON(PARAMS_PATH, {}));
    const categorias = leerCategorias();
    const plus = [...new Set(categorias.flatMap(c => c.plus))];
    const [ventas, stock, nombres] = await Promise.all([
      enLotes(plus, l => sqlConsumoCatalogo(l, params.diasConsumo)),
      enLotes(plus, sqlStockPorPlu),
      nombresSiga(plus),
    ]);
    return pn.armarTablero({ categorias, nombres, ventas: mapa(ventas, 'UnidVendidas'), stock: mapa(stock, 'StockActual') }, params);
  }));

  router.get('/api/plan-nueva/responsables', ruta(async () => pn.nombresResponsables(leerJSON(RESP_PATH, []))));

  // ── Órdenes ──
  const leerOrdenes = () => leerLista(ORDENES_PATH, 'ordenes');
  const guardarOrdenes = ordenes => guardarLista(ORDENES_PATH, 'ordenes', ordenes);
  const usuarioSesion = req => (req.session && req.session.user && req.session.user.usuario) || 'anonimo';

  router.get('/api/plan-nueva/ordenes', ruta(async () => pn.ordenesRecientes(leerOrdenes())));

  router.post('/api/plan-nueva/ordenes', ruta(async req => {
    const datos = pn.validarOrden(req.body, { categorias: leerCategorias(), responsables: leerJSON(RESP_PATH, []) });
    const r = pn.crearOrden(leerOrdenes(), datos, { id: crypto.randomUUID(), ahora: new Date().toISOString(), usuario: usuarioSesion(req) });
    guardarOrdenes(r.ordenes);
    return r.orden;
  }));

  router.put('/api/plan-nueva/ordenes/:id/anular', ruta(async req => {
    const r = pn.anularOrden(leerOrdenes(), String(req.params.id));
    guardarOrdenes(r.ordenes);
    return r.orden;
  }));

  return router;
};
