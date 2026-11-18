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
  assert.match(u.validarAsignacion({ idProducto: '1', cantidad: 1.2345 }).error, /3 decimales/);
  assert.strictEqual(u.validarAsignacion({ idProducto: '1', cantidad: 1.234 }).cantidad, 1.234);
  assert.deepStrictEqual(u.validarAsignacion({ idProducto: 12, cantidad: '1.5' }), { idProducto: '12', cantidad: 1.5 });
});

test('asignar: sin tope, mismo producto en varias ubicaciones, 0 quita, borrar con forzar', () => {
  let d = u.crear(V, 7, { nombre: 'A' }, 'a', 't').datos;
  d = u.crear(d, 7, { nombre: 'B' }, 'b', 't').datos;
  d = u.asignar(d, 'a', 'P1', 600).datos;
  d = u.asignar(d, 'b', 'P1', 4).datos;
  assert.deepStrictEqual(d.asignaciones, [{ idUbicacion: 'a', idProducto: 'P1', cantidad: 600 }, { idUbicacion: 'b', idProducto: 'P1', cantidad: 4 }]);
  d = u.asignar(d, 'a', 'P1', 2.5).datos; // upsert
  assert.strictEqual(d.asignaciones.find(x => x.idUbicacion === 'a').cantidad, 2.5);
  assert.match(u.asignar(d, 'zz', 'P1', 1).error, /no existe/);
  d = u.asignar(d, 'a', 'P1', 0).datos;
  assert.ok(!d.asignaciones.some(x => x.idUbicacion === 'a'));
  assert.match(u.borrar(d, 'b', false).error, /1 producto/);
  const sin = u.borrar(d, 'b', true).datos;
  assert.ok(!sin.ubicaciones.some(x => x.id === 'b') && !sin.asignaciones.some(x => x.idUbicacion === 'b'));
});

test('vista: totales, descripciones y orden por nombre', () => {
  let d = u.crear(V, 7, { nombre: 'B' }, 'b', 't').datos;
  d = u.crear(d, 7, { nombre: 'A' }, 'a', 't').datos;
  d = u.crear(d, 8, { nombre: 'C' }, 'c', 't').datos;
  d = u.asignar(d, 'a', 'P1', 3).datos;
  d = u.asignar(d, 'a', 'P2', 5).datos;
  d = u.asignar(d, 'b', 'P1', 1).datos;
  const v = u.vista(d, 7, new Map([['P1', 'Uno']]));
  assert.deepStrictEqual(Object.keys(v), ['ubicaciones']);
  assert.deepStrictEqual(v.ubicaciones.map(x => x.nombre), ['A', 'B']);
  assert.strictEqual(v.ubicaciones[0].totalProductos, 2);
  assert.strictEqual(v.ubicaciones[0].totalUnidades, 8);
  assert.deepStrictEqual(v.ubicaciones[0].productos, [
    { idProducto: 'P1', descripcion: 'Uno', cantidad: 3 },
    { idProducto: 'P2', descripcion: null, cantidad: 5 }]);
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
    if (q.includes('Activo')) return q.includes("'P1'") ? [{ activo: 1 }] : q.includes("'P9'") ? [{ activo: 0 }] : [];
    if (q.includes('IdProducto IN')) return [{ idProducto: 'P1', descripcion: 'Uno' }];
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
    assert.match((await pedir('PUT', `/api/proarmet/ubicacion/${id}/producto`, { idProducto: 'P2', cantidad: 1 })).error, /no existe/);
    assert.match((await pedir('PUT', `/api/proarmet/ubicacion/${id}/producto`, { idProducto: 'P9', cantidad: 1 })).error, /inactivo/);
    assert.deepStrictEqual(await pedir('PUT', `/api/proarmet/ubicacion/${id}/producto`, { idProducto: 'P1', cantidad: 999 }), { ok: true }); // sin stock: OK
    const v = await pedir('GET', '/api/proarmet/ubicaciones?idDeposito=7');
    assert.strictEqual(v.ubicaciones[0].nombre, 'Estante');
    assert.deepStrictEqual(v, { ubicaciones: [{ id, nombre: 'Estante', descripcion: 'd', totalProductos: 1, totalUnidades: 999, productos: [{ idProducto: 'P1', descripcion: 'Uno', cantidad: 999 }] }] });
    assert.ok(!sqls.some(q => q.includes('ProductosDepositos')));
    assert.match((await pedir('GET', '/api/proarmet/ubicaciones?idDeposito=99')).error, /activo/);
    assert.match((await pedir('DELETE', `/api/proarmet/ubicacion/${id}`)).error, /asignado/);
    assert.deepStrictEqual(await pedir('DELETE', `/api/proarmet/ubicacion/${id}?forzar=1`), { ok: true });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'proarmet_ubicaciones.json'), 'utf8')), V);
  } finally { server.closeAllConnections(); server.close(); }
});
