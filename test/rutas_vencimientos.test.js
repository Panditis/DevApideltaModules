'use strict';
// Rutas de vencimientos: store real sobre tmp dir, sesión y SIGA falsos.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { crearStore } = require('../lib/vencimientos');
const crearRutas = require('../routes/rutas_vencimientos');

const USUARIOS = {
  ana: { id: 1, usuario: 'ana', esAdmin: false, idSucursal: 1 },
  beto: { id: 2, usuario: 'beto', esAdmin: false, idSucursal: 2 },
  sin: { id: 3, usuario: 'sin', esAdmin: false },
  admin: { id: 4, usuario: 'admin', esAdmin: true },
};

function armar({ filas = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venc-rutas-'));
  const store = crearStore({ rutaDatos: path.join(dir, 'v.json'), rutaConfig: path.join(dir, 'c.json') });
  const sql = { query: null, inputs: {} };
  const getPool = async () => ({ request() {
    const r = { input(k, v) { sql.inputs[k] = v; return r; }, async query(q) { sql.query = q; return { recordset: filas }; } };
    return r;
  } });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: USUARIOS[req.get('x-user')] }; next(); });
  app.use(crearRutas({ store, getPool, idSucursalDe: u => u.idSucursal || null }));
  let server;
  const pedir = async (user, metodo, ruta, body) => {
    if (!server) server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const res = await fetch(`http://127.0.0.1:${server.address().port}${ruta}`, {
      method: metodo, headers: { 'x-user': user, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { pedir, sql, cerrar: () => { if (server) { server.closeAllConnections(); server.close(); } } };
}

const ALTA = { idProducto: 10, vencimiento: '2030-12-31', unidades: 20, nombre: 'Yerba', codigo: '779' };

test('alta propia + otra sucursal suma columna; listado compartido', async () => {
  const a = armar();
  try {
    const r1 = await a.pedir('ana', 'POST', '/api/vencimientos/lotes', { ...ALTA, idSucursal: 5 });
    assert.strictEqual(r1.status, 200);
    assert.deepStrictEqual(Object.keys(r1.body.sucursales), ['1'], 'ignora idSucursal del body');
    assert.strictEqual(r1.body.nombre, 'Yerba');
    await a.pedir('beto', 'POST', '/api/vencimientos/lotes', { ...ALTA, unidades: 5 });
    const l = await a.pedir('ana', 'GET', '/api/vencimientos/lotes');
    assert.strictEqual(l.body.lotes.length, 1);
    assert.deepStrictEqual(l.body.sucursales, [1, 2]);
    assert.strictEqual(l.body.lotes[0].totalUnidades, 25);
    assert.strictEqual(l.body.lotes[0].semaforo, 'verde');
    assert.deepStrictEqual(l.body.usuario, { idSucursal: 1, esAdmin: false });
    assert.deepStrictEqual(l.body.umbrales, { rojo: 15, amarillo: 45 });
  } finally { a.cerrar(); }
});

test('usuario sin sucursal: 403 con mensaje; admin elige sucursal', async () => {
  const a = armar();
  try {
    const r = await a.pedir('sin', 'POST', '/api/vencimientos/lotes', ALTA);
    assert.strictEqual(r.status, 403);
    assert.match(r.body.error, /no tiene sucursal asignada/);
    const ad = await a.pedir('admin', 'POST', '/api/vencimientos/lotes', { ...ALTA, idSucursal: 3 });
    assert.deepStrictEqual(Object.keys(ad.body.sucursales), ['3']);
  } finally { a.cerrar(); }
});

test('editar otra sucursal: 403 aunque mande idSucursal; propia ok; admin ok', async () => {
  const a = armar();
  try {
    const { body: lote } = await a.pedir('ana', 'POST', '/api/vencimientos/lotes', ALTA);
    await a.pedir('beto', 'POST', '/api/vencimientos/lotes', ALTA);
    const u = `/api/vencimientos/lotes/${lote.id}`;
    assert.strictEqual((await a.pedir('ana', 'PUT', `${u}/unidades`, { unidades: 3, idSucursal: 2 })).status, 403);
    assert.strictEqual((await a.pedir('ana', 'POST', `${u}/movimientos`, { tipo: 'oferta', cantidad: 1, idSucursal: 2 })).status, 403);
    const ok = await a.pedir('ana', 'PUT', `${u}/unidades`, { unidades: 15 });
    assert.strictEqual(ok.body.sucursales['1'].unidades, 15);
    const mov = await a.pedir('admin', 'POST', `${u}/movimientos`, { tipo: 'vendido', cantidad: 2, idSucursal: 2 });
    assert.strictEqual(mov.body.sucursales['2'].vendido, 2);
    const h = await a.pedir('ana', 'GET', '/api/vencimientos/historial?idSucursal=2');
    assert.strictEqual(h.body.idSucursal, 1, 'no admin no elige sucursal en historial');
    assert.deepStrictEqual(h.body.movimientos.map(m => m.tipo), ['correccion', 'alta']);
  } finally { a.cerrar(); }
});

test('DELETE y PUT config solo admin', async () => {
  const a = armar();
  try {
    const { body: lote } = await a.pedir('ana', 'POST', '/api/vencimientos/lotes', ALTA);
    assert.strictEqual((await a.pedir('ana', 'DELETE', `/api/vencimientos/lotes/${lote.id}`)).status, 403);
    assert.strictEqual((await a.pedir('admin', 'DELETE', `/api/vencimientos/lotes/${lote.id}`)).status, 200);
    assert.strictEqual((await a.pedir('ana', 'PUT', '/api/vencimientos/config', { umbrales: { rojo: 5, amarillo: 10 } })).status, 403);
    assert.strictEqual((await a.pedir('admin', 'PUT', '/api/vencimientos/config', { umbrales: { rojo: 20, amarillo: 10 } })).status, 400);
    const ok = await a.pedir('admin', 'PUT', '/api/vencimientos/config', { umbrales: { rojo: 5, amarillo: 10 } });
    assert.deepStrictEqual(ok.body, { umbrales: { rojo: 5, amarillo: 10 } });
    assert.deepStrictEqual((await a.pedir('ana', 'GET', '/api/vencimientos/config')).body, ok.body);
  } finally { a.cerrar(); }
});

test('validaciones en el borde', async () => {
  const a = armar();
  try {
    for (const b of [{ ...ALTA, idProducto: 'x' }, { ...ALTA, unidades: 0 }, { ...ALTA, unidades: 1.5 }, { ...ALTA, vencimiento: '31/12/2030' }]) {
      assert.strictEqual((await a.pedir('ana', 'POST', '/api/vencimientos/lotes', b)).status, 400, JSON.stringify(b));
    }
    assert.strictEqual((await a.pedir('ana', 'PUT', '/api/vencimientos/lotes/abc/unidades', { unidades: 1 })).status, 400);
    const { body: lote } = await a.pedir('ana', 'POST', '/api/vencimientos/lotes', ALTA);
    assert.strictEqual((await a.pedir('ana', 'POST', `/api/vencimientos/lotes/${lote.id}/movimientos`, { tipo: 'oferta', cantidad: 21 })).status, 400);
    assert.strictEqual((await a.pedir('ana', 'POST', `/api/vencimientos/lotes/${lote.id}/movimientos`, { tipo: 'robo', cantidad: 1 })).status, 400);
    assert.strictEqual((await a.pedir('ana', 'POST', `/api/vencimientos/lotes/00000000-0000-0000-0000-000000000000/movimientos`, { tipo: 'oferta', cantidad: 1 })).status, 404);
  } finally { a.cerrar(); }
});

test('productos: mínimo 2 caracteres; SQL inyectado va como parámetro', async () => {
  const a = armar({ filas: [{ IdProducto: ' 10 ', CodigoDeBarras: '779', NombreProducto: 'Yerba' }] });
  try {
    assert.strictEqual((await a.pedir('ana', 'GET', '/api/vencimientos/productos?q=y')).status, 400);
    const evil = "'; DROP TABLE Productos--";
    const r = await a.pedir('ana', 'GET', `/api/vencimientos/productos?q=${encodeURIComponent(evil)}`);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, [{ idProducto: '10', codigo: '779', nombre: 'Yerba' }]);
    assert.ok(!a.sql.query.includes('DROP'));
    assert.match(a.sql.query, /TOP 30/);
    assert.strictEqual(a.sql.inputs.codigo, evil);
    assert.ok(!('idProducto' in a.sql.inputs), 'texto inyectado no va como IdProducto');
    assert.ok(!a.sql.query.includes('p.IdProducto ='));
  } finally { a.cerrar(); }
});

test('productos: por nombre no compara IdProducto; numérico sí, como entero', async () => {
  const a = armar();
  try {
    assert.strictEqual((await a.pedir('ana', 'GET', '/api/vencimientos/productos?q=leche')).status, 200);
    assert.ok(!('idProducto' in a.sql.inputs));
    assert.ok(!a.sql.query.includes('p.IdProducto ='));
    assert.strictEqual(a.sql.inputs.codigo, 'leche');
  } finally { a.cerrar(); }
  const b = armar();
  try {
    assert.strictEqual((await b.pedir('ana', 'GET', '/api/vencimientos/productos?q=1234')).status, 200);
    assert.strictEqual(b.sql.inputs.idProducto, 1234);
    assert.strictEqual(b.sql.inputs.codigo, '1234');
    assert.match(b.sql.query, /p\.IdProducto = @idProducto/);
  } finally { b.cerrar(); }
  const c = armar();
  try {
    await c.pedir('ana', 'GET', '/api/vencimientos/productos?q=99999999999999999999');
    assert.ok(!('idProducto' in c.sql.inputs), 'fuera de rango seguro no va como entero');
  } finally { c.cerrar(); }
});

test('PUT unidades: null, vacío o booleano no se toman como 0/1 (regresión)', async () => {
  const a = armar();
  try {
    const { body: lote } = await a.pedir('ana', 'POST', '/api/vencimientos/lotes', ALTA);
    for (const unidades of [null, '', true, ' ', '1e1']) {
      assert.strictEqual((await a.pedir('ana', 'PUT', `/api/vencimientos/lotes/${lote.id}/unidades`, { unidades })).status, 400, JSON.stringify(unidades));
    }
    const ok = await a.pedir('ana', 'PUT', `/api/vencimientos/lotes/${lote.id}/unidades`, { unidades: 0 });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.sucursales['1'].unidades, 0);
  } finally { a.cerrar(); }
});

test('no admin: historial ignora idSucursal ajeno; alta ignora idSucursal ajeno', async () => {
  const a = armar();
  try {
    const { body: lote } = await a.pedir('ana', 'POST', '/api/vencimientos/lotes', { ...ALTA, idSucursal: 2 });
    assert.deepStrictEqual(Object.keys(lote.sucursales), ['1']);
    const h = await a.pedir('beto', 'GET', '/api/vencimientos/historial?idSucursal=1');
    assert.strictEqual(h.body.idSucursal, 2);
    assert.strictEqual(h.body.movimientos.length, 0);
    assert.strictEqual((await a.pedir('ana', 'DELETE', `/api/vencimientos/lotes/${lote.id}`)).status, 403);
  } finally { a.cerrar(); }
});

test('altas simultáneas por HTTP de varias sucursales no pierden columnas', async () => {
  const a = armar();
  try {
    await a.pedir('ana', 'GET', '/api/vencimientos/config'); // levanta el server antes (armar lo crea lazy)
    const rs = await Promise.all([a.pedir('ana', 'POST', '/api/vencimientos/lotes', ALTA), a.pedir('beto', 'POST', '/api/vencimientos/lotes', ALTA),
      a.pedir('admin', 'POST', '/api/vencimientos/lotes', { ...ALTA, idSucursal: 3 })]);
    rs.forEach(r => assert.strictEqual(r.status, 200));
    const { body } = await a.pedir('ana', 'GET', '/api/vencimientos/lotes');
    assert.strictEqual(body.lotes.length, 1);
    assert.deepStrictEqual(Object.keys(body.lotes[0].sucursales).sort(), ['1', '2', '3']);
  } finally { a.cerrar(); }
});

test('sin sesión: 401; /vencimientos y /js/vencimientos.js se sirven', async () => {
  const a = armar();
  const app = express();
  app.use(crearRutas({ store: null, getPool: null, idSucursalDe: () => null }));
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    assert.strictEqual((await a.pedir('nadie', 'GET', '/api/vencimientos/lotes')).status, 401);
    const base = `http://127.0.0.1:${srv.address().port}`;
    const js = await fetch(base + '/js/vencimientos.js');
    assert.strictEqual(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.match(await js.text(), /\/api\/vencimientos/);
    const html = await fetch(base + '/vencimientos');
    assert.strictEqual(html.status, 200);
    assert.match(await html.text(), /\/js\/vencimientos\.js/);
  } finally { a.cerrar(); srv.closeAllConnections(); srv.close(); }
});
