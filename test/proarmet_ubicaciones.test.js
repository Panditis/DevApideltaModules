'use strict';
// Ubicaciones Proarmet: lógica pura + rutas con SIGA falso y JSON en tmp dir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const u = require('../lib/proarmet_ubicaciones');
const crearRutas = require('../routes/rutas_proarmet');

const V = { ubicaciones: [], asignaciones: [] };

test('crear/editar: nombre obligatorio, ≤40, único CI por depósito', () => {
  assert.match(u.crear(V, 7, { nombre: '  ' }, 'a', 't').error, /obligatorio/);
  assert.match(u.crear(V, 7, { nombre: 'x'.repeat(41) }, 'a', 't').error, /40/);
  const d1 = u.crear(V, 7, { nombre: ' Estante A ', descripcion: 'izq' }, 'a', 't').datos;
  assert.deepStrictEqual(d1.ubicaciones[0], { id: 'a', idDeposito: 7, nombre: 'Estante A', descripcion: 'izq', creada: 't' });
  assert.match(u.crear(d1, 7, { nombre: 'estante a' }, 'b', 't').error, /Ya existe/);
  assert.ok(u.crear(d1, 8, { nombre: 'estante a' }, 'b', 't').datos);
  const d2 = u.crear(d1, 7, { nombre: 'B' }, 'b', 't').datos;
  assert.match(u.editar(d2, 'b', { nombre: 'ESTANTE A' }).error, /Ya existe/);
  assert.strictEqual(u.editar(d2, 'a', { nombre: 'estante a' }).datos.ubicaciones[0].nombre, 'estante a');
  assert.match(u.editar(d2, 'zz', { nombre: 'q' }).error, /no existe/);
  assert.strictEqual(V.ubicaciones.length, 0); // no muta
});

test('validarAsignacion', () => {
  assert.ok(u.validarAsignacion({ idProducto: "1'; --", cantidad: 1 }).error);
  assert.ok(u.validarAsignacion({ idProducto: '1', cantidad: -1 }).error);
  assert.ok(u.validarAsignacion({ idProducto: '1', cantidad: '' }).error);
  assert.ok(u.validarAsignacion({ idProducto: '1', cantidad: Infinity }).error);
  assert.deepStrictEqual(u.validarAsignacion({ idProducto: 12, cantidad: '1.5' }), { idProducto: '12', cantidad: 1.5 });
});

test('asignar: suma por depósito ≤ stock, 0 quita, borrar con forzar', () => {
  let d = u.crear(V, 7, { nombre: 'A' }, 'a', 't').datos;
  d = u.crear(d, 7, { nombre: 'B' }, 'b', 't').datos;
  d = u.crear(d, 8, { nombre: 'C' }, 'c', 't').datos;
  let r = u.asignar(d, 'a', 'P1', 6, 10);
  assert.strictEqual(r.disponible, 4);
  d = r.datos;
  d = u.asignar(d, 'c', 'P1', 9, 10).datos; // otro depósito: no suma
  assert.match(u.asignar(d, 'b', 'P1', 5, 10).error, /disponible 4/);
  r = u.asignar(d, 'b', 'P1', 4, 10);
  assert.strictEqual(r.disponible, 0);
  d = u.asignar(r.datos, 'a', 'P1', 2.5, 10).datos; // upsert
  assert.strictEqual(d.asignaciones.find(x => x.idUbicacion === 'a').cantidad, 2.5);
  d = u.asignar(d, 'a', 'P1', 0, 0).datos;
  assert.ok(!d.asignaciones.some(x => x.idUbicacion === 'a'));
  assert.match(u.borrar(d, 'b', false).error, /1 producto/);
  const sin = u.borrar(d, 'b', true).datos;
  assert.ok(!sin.ubicaciones.some(x => x.id === 'b') && !sin.asignaciones.some(x => x.idUbicacion === 'b'));
});

test('vista: totales, excedido y sinUbicar', () => {
  let d = u.crear(V, 7, { nombre: 'A' }, 'a', 't').datos;
  d = u.asignar(d, 'a', 'P1', 3, 10).datos;
  d = u.asignar(d, 'a', 'P2', 5, 5).datos;
  const v = u.vista(d, 7, [{ idProducto: 'P1', descripcion: 'Uno', stock: 10 }, { idProducto: 'P2', descripcion: 'Dos', stock: 2 }, { idProducto: 'P3', descripcion: 'Tres', stock: 0 }]);
  assert.strictEqual(v.ubicaciones[0].totalProductos, 2);
  assert.strictEqual(v.ubicaciones[0].totalUnidades, 8);
  assert.deepStrictEqual(v.ubicaciones[0].productos, [
    { idProducto: 'P1', descripcion: 'Uno', cantidad: 3 },
    { idProducto: 'P2', descripcion: 'Dos', cantidad: 5, excedido: true }]);
  assert.deepStrictEqual(v.sinUbicar, [{ idProducto: 'P1', descripcion: 'Uno', stock: 10, asignado: 3, pendiente: 7 }]);
});

test('sanear descarta basura y asignaciones huérfanas', () => {
  const s = u.sanear({ ubicaciones: [{ id: 'a', idDeposito: 7, nombre: 'A' }, { id: 1 }], asignaciones: [{ idUbicacion: 'a', idProducto: 'P', cantidad: 1 }, { idUbicacion: 'x', idProducto: 'P', cantidad: 1 }, { idUbicacion: 'a', idProducto: 'P', cantidad: 0 }] });
  assert.strictEqual(s.ubicaciones.length, 1);
  assert.strictEqual(s.asignaciones.length, 1);
});

test('rutas: CRUD y asignación contra SIGA falso', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proarmet-ubic-'));
  const sqls = [];
  const query = async q => {
    sqls.push(q);
    if (q.includes('ProductosDepositos')) return q.includes("IdProducto = 'P1'") || !q.includes("pd.IdProducto = '") ? [{ idProducto: 'P1', descripcion: 'Uno', stock: 5 }] : [];
    return [];
  };
  const app = express();
  app.use(express.json());
  app.use(crearRutas({
    apiRoute: fn => async (req, res) => { try { res.json(await fn(req)); } catch (e) { res.status(500).json({ error: e.message }); } },
    query, DATA_DIR: dir, cfgReserva: () => ({ depositoPrincipal: 1 }),
    depositosActivos: async () => [{ IdDeposito: 1, NombreDeposito: 'Principal' }, { IdDeposito: 7, NombreDeposito: 'Deposito Proarmet' }],
  }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const pedir = async (metodo, ruta, body) => (await fetch(`http://127.0.0.1:${server.address().port}${ruta}`, {
    method: metodo, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) })).json();
  try {
    assert.match((await pedir('POST', '/api/proarmet/ubicacion', { idDeposito: 99, nombre: 'A' })).error, /activo/);
    const { ok, id } = await pedir('POST', '/api/proarmet/ubicacion', { idDeposito: 7, nombre: 'A' });
    assert.ok(ok && id);
    assert.match((await pedir('POST', '/api/proarmet/ubicacion', { idDeposito: 7, nombre: 'a' })).error, /Ya existe/);
    assert.deepStrictEqual(await pedir('PUT', `/api/proarmet/ubicacion/${id}`, { nombre: 'Estante', descripcion: 'd' }), { ok: true });
    assert.match((await pedir('PUT', `/api/proarmet/ubicacion/${id}/producto`, { idProducto: 'P1', cantidad: 6 })).error, /disponible 5/);
    assert.deepStrictEqual(await pedir('PUT', `/api/proarmet/ubicacion/${id}/producto`, { idProducto: 'P1', cantidad: 2 }), { ok: true, disponible: 3 });
    const v = await pedir('GET', '/api/proarmet/ubicaciones?idDeposito=7');
    assert.strictEqual(v.ubicaciones[0].nombre, 'Estante');
    assert.deepStrictEqual(v.sinUbicar, [{ idProducto: 'P1', descripcion: 'Uno', stock: 5, asignado: 2, pendiente: 3 }]);
    assert.match((await pedir('GET', '/api/proarmet/ubicaciones?idDeposito=99')).error, /activo/);
    assert.match((await pedir('DELETE', `/api/proarmet/ubicacion/${id}`)).error, /asignado/);
    assert.deepStrictEqual(await pedir('DELETE', `/api/proarmet/ubicacion/${id}?forzar=1`), { ok: true });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'proarmet_ubicaciones.json'), 'utf8')), V);
  } finally { server.closeAllConnections(); server.close(); }
});
