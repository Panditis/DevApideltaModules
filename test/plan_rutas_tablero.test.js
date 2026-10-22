'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

// Router real del tablero con DATA_DIR temporal y un query falso que responde según el SQL.
function montar({ filasSql = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-tablero-'));
  const leerJSON = (p, def) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : def);
  const guardarJSON = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2));
  const CATALOGO_PATH = path.join(dir, 'catalogo.json');
  const GRUPOS_CFG_PATH = path.join(dir, 'grupos_config.json');
  guardarJSON(CATALOGO_PATH, [
    { plu: 5, producto: 'Mix 1Kg', baseNombre: 'Mix 1Kg', presentacion: '1Kg', esVariante: false, refId: 1, productoRef: 'Mix' },
    { plu: 1, producto: 'Pepas 250G', baseNombre: 'Pepas 250G', presentacion: '250G', esVariante: false, refId: 2, productoRef: 'Pepas' },
  ]);
  guardarJSON(GRUPOS_CFG_PATH, { Pepas: { tipo: 'granel', granelPlu: '100', estado: 'activo', reqGranel: true }, Mix: true });
  guardarJSON(path.join(dir, 'graneles_base.json'), { 100: { nombre: '', estado: 'activo' } });
  guardarJSON(path.join(dir, 'responsables.json'), [{ nombre: 'Ana', corto: 'ANA' }]);
  const sqls = [];
  const query = async sql => {
    sqls.push(sql);
    for (const [clave, filas] of Object.entries(filasSql)) if (sql.includes(clave)) return filas;
    return [];
  };
  const app = express();
  app.use(express.json());
  app.use(require('../routes/rutas_plan_tablero')({
    apiRoute: fn => async (req, res) => { try { res.json(await fn(req)); } catch (e) { res.status(500).json({ error: e.message }); } },
    leerJSON, guardarJSON, query, DATA_DIR: dir, CATALOGO_PATH, GRUPOS_CFG_PATH,
    leerConfig: () => ({ ventanaConsumoDias: 120, diasObjetivo: 30, rubrosGranel: [22, 23], gruposGranelEnKg: [] }),
    sqlStockPorPlu: l => `STOCKCENTRAL ${l.join(',')}`,
    sqlBOMGranel: (r, f) => `BOMGRANEL ${r}${f}`,
  }));
  return new Promise(ok => {
    const server = app.listen(0, () => ok({ server, dir, sqls, base: `http://127.0.0.1:${server.address().port}`, leer: f => leerJSON(path.join(dir, f), null) }));
  });
}
async function pedir(base, metodo, url, body) {
  const r = await fetch(base + url, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json() };
}
function cerrar({ server, dir }) {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

test('GET /api/plan/tablero: arma filas con las queries y usa ?dias', async () => {
  const ctx = await montar({ filasSql: {
    UnidVendidas: [{ IdProducto: '5', UnidVendidas: 360 }, { IdProducto: '1', UnidVendidas: 1200 }],
    STOCKCENTRAL: [{ IdProducto: '5', StockActual: 30 }],
    NombreProducto: [{ IdProducto: '100', NombreProducto: 'MASA PEPAS' }],
  } });
  try {
    const r = await pedir(ctx.base, 'GET', '/api/plan/tablero?dias=10');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.dias, 10);
    const mix = r.data.filas.find(f => f.productoRef === 'Mix');
    assert.strictEqual(mix.ventaDiaKg, 3);
    assert.strictEqual(mix.estimadoKg, 0); // 3×10 − 30
    const granel = r.data.filas.find(f => f.nivel === 'granel');
    assert.strictEqual(granel.nombre, 'MASA PEPAS');
    assert.strictEqual(granel.variedades[0].productoRef, 'Pepas');
    assert.ok(ctx.sqls.some(s => s.startsWith('BOMGRANEL 22,23')));
  } finally { cerrar(ctx); }
});

test('GET /api/plan/tablero: catálogo vacío → 500 con mensaje', async () => {
  const ctx = await montar();
  try {
    fs.writeFileSync(path.join(ctx.dir, 'catalogo.json'), '[]');
    const r = await pedir(ctx.base, 'GET', '/api/plan/tablero');
    assert.strictEqual(r.status, 500);
    assert.match(r.data.error, /Catálogo vacío/);
  } finally { cerrar(ctx); }
});

test('graneles base: GET con variedades y nombre de SIGA, POST alta, PATCH meta', async () => {
  const ctx = await montar({ filasSql: { NombreProducto: [{ IdProducto: '100', NombreProducto: 'MASA PEPAS' }] } });
  try {
    const lista = await pedir(ctx.base, 'GET', '/api/plan/graneles-base');
    assert.deepStrictEqual(lista.data.map(g => [g.plu, g.nombre, g.variedades]), [['100', 'MASA PEPAS', ['Pepas']]]);
    assert.strictEqual((await pedir(ctx.base, 'POST', '/api/plan/graneles-base', { plu: 'x' })).status, 400);
    assert.strictEqual((await pedir(ctx.base, 'POST', '/api/plan/graneles-base', { plu: '100' })).status, 409);
    const alta = await pedir(ctx.base, 'POST', '/api/plan/graneles-base', { plu: '300', nombre: 'Masa yogur' });
    assert.strictEqual(alta.status, 200);
    assert.strictEqual(alta.data.nombre, 'Masa yogur');
    assert.ok(ctx.leer('graneles_base.json')['300']);
    const p = await pedir(ctx.base, 'PATCH', '/api/plan/graneles-base/100', { estado: 'pausado', motivo: 'Sin harina', responsables: ['Ana'] });
    assert.strictEqual(p.status, 200);
    assert.strictEqual(p.data.estado, 'pausado');
    assert.deepStrictEqual(ctx.leer('graneles_base.json')['100'].responsables, ['Ana']);
    assert.strictEqual((await pedir(ctx.base, 'PATCH', '/api/plan/graneles-base/100', { estado: 'pausado', motivo: '' })).status, 400);
    assert.strictEqual((await pedir(ctx.base, 'PATCH', '/api/plan/graneles-base/999', { estado: 'activo' })).status, 404);
  } finally { cerrar(ctx); }
});

test('graneles base: claves heredadas (constructor, __proto__) no cuentan como existentes', async () => {
  const ctx = await montar();
  try {
    const p = await pedir(ctx.base, 'PATCH', '/api/plan/graneles-base/constructor', { estado: 'activo' });
    assert.strictEqual(p.status, 404);
    assert.ok(!Object.hasOwn(ctx.leer('graneles_base.json'), 'constructor'));
    assert.strictEqual((await pedir(ctx.base, 'PATCH', '/api/plan/graneles-base/__proto__', { estado: 'activo' })).status, 404);
  } finally { cerrar(ctx); }
});
