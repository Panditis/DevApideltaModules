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

test('validarAsignacion: solo PLU saneado', () => {
  assert.ok(u.validarAsignacion({ idProducto: "1'; --" }).error);
  assert.ok(u.validarAsignacion({ idProducto: '' }).error);
  assert.deepStrictEqual(u.validarAsignacion({ idProducto: 12, cantidad: 5 }), { idProducto: '12' });
});

test('asignar/quitar: idempotente, mismo PLU en varias ubicaciones, borrar con forzar', () => {
  let d = u.crear(V, 7, { nombre: 'A' }, 'a', 't').datos;
  d = u.crear(d, 7, { nombre: 'B' }, 'b', 't').datos;
  d = u.asignar(d, 'a', 'P1').datos;
  d = u.asignar(d, 'b', 'P1').datos;
  d = u.asignar(d, 'a', 'P1').datos; // idempotente
  assert.deepStrictEqual(d.asignaciones, [{ idUbicacion: 'a', idProducto: 'P1' }, { idUbicacion: 'b', idProducto: 'P1' }]);
  assert.match(u.asignar(d, 'zz', 'P1').error, /no existe/);
  assert.match(u.quitar(d, 'zz', 'P1').error, /no existe/);
  d = u.quitar(d, 'a', 'P1').datos;
  assert.ok(!d.asignaciones.some(x => x.idUbicacion === 'a'));
  assert.strictEqual(u.quitar(d, 'a', 'P1').datos.asignaciones.length, 1); // ok aunque no esté
  assert.match(u.borrar(d, 'b', false).error, /1 producto/);
  const sin = u.borrar(d, 'b', true).datos;
  assert.ok(!sin.ubicaciones.some(x => x.id === 'b') && !sin.asignaciones.some(x => x.idUbicacion === 'b'));
});

test('vista: totales, descripciones y orden por nombre', () => {
  let d = u.crear(V, 7, { nombre: 'B' }, 'b', 't').datos;
  d = u.crear(d, 7, { nombre: 'A' }, 'a', 't').datos;
  d = u.crear(d, 8, { nombre: 'C' }, 'c', 't').datos;
  d = u.asignar(d, 'a', 'P2').datos;
  d = u.asignar(d, 'a', 'P10').datos;
  d = u.asignar(d, 'a', 'P1').datos;
  d = u.asignar(d, 'b', 'P1').datos;
  const v = u.vista(d, 7, new Map([['P1', 'Uno']]));
  assert.deepStrictEqual(Object.keys(v), ['ubicaciones']);
  assert.deepStrictEqual(v.ubicaciones.map(x => x.nombre), ['A', 'B']);
  assert.strictEqual(v.ubicaciones[0].totalProductos, 3);
  assert.ok(!('totalUnidades' in v.ubicaciones[0]));
  assert.deepStrictEqual(v.ubicaciones[0].productos, [
    { idProducto: 'P1', descripcion: 'Uno' }, { idProducto: 'P2', descripcion: null }, { idProducto: 'P10', descripcion: null }]);
});

test('sanear descarta basura y asignaciones huérfanas', () => {
  const s = u.sanear({ ubicaciones: [{ id: 'a', idDeposito: 7, nombre: 'A' }, { id: 1 }], asignaciones: [{ idUbicacion: 'a', idProducto: 'P', cantidad: 1 }, { idUbicacion: 'x', idProducto: 'P', cantidad: 1 }, { idUbicacion: 'a', idProducto: 'P', cantidad: 0 }] });
  assert.strictEqual(s.ubicaciones.length, 1);
  assert.deepStrictEqual(s.asignaciones, [{ idUbicacion: 'a', idProducto: 'P' }]);
});

test('sanear: datos viejos con cantidad se ignoran y deduplican', () => {
  const s = u.sanear({ ubicaciones: [{ id: 'a', idDeposito: 7, nombre: 'A' }], asignaciones: [{ idUbicacion: 'a', idProducto: 'P', cantidad: 3 }, { idUbicacion: 'a', idProducto: 'P', cantidad: 2 }, { idUbicacion: 'a', idProducto: 'Q' }] });
  assert.deepStrictEqual(s.asignaciones, [{ idUbicacion: 'a', idProducto: 'P' }, { idUbicacion: 'a', idProducto: 'Q' }]);
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
    assert.match((await pedir('PUT', `/api/proarmet/ubicacion/${id}/producto`, { idProducto: 'P2' })).error, /no existe/);
    assert.match((await pedir('PUT', `/api/proarmet/ubicacion/${id}/producto`, { idProducto: 'P9' })).error, /inactivo/);
    assert.deepStrictEqual(await pedir('PUT', `/api/proarmet/ubicacion/${id}/producto`, { idProducto: 'P1' }), { ok: true });
    assert.deepStrictEqual(await pedir('PUT', `/api/proarmet/ubicacion/${id}/producto`, { idProducto: 'P1' }), { ok: true }); // idempotente
    const v = await pedir('GET', '/api/proarmet/ubicaciones?idDeposito=7');
    assert.strictEqual(v.ubicaciones[0].nombre, 'Estante');
    assert.deepStrictEqual(v, { ubicaciones: [{ id, nombre: 'Estante', descripcion: 'd', totalProductos: 1, productos: [{ idProducto: 'P1', descripcion: 'Uno' }] }] });
    assert.deepStrictEqual(await pedir('DELETE', '/api/proarmet/ubicacion/zz/producto/P1'), { error: 'La ubicación no existe' });
    assert.ok(!sqls.some(q => q.includes('ProductosDepositos')));
    assert.match((await pedir('GET', '/api/proarmet/ubicaciones?idDeposito=99')).error, /activo/);
    assert.match((await pedir('DELETE', `/api/proarmet/ubicacion/${id}`)).error, /asignado/);
    assert.deepStrictEqual(await pedir('DELETE', `/api/proarmet/ubicacion/${id}/producto/P1`), { ok: true });
    assert.deepStrictEqual(await pedir('DELETE', `/api/proarmet/ubicacion/${id}/producto/P1`), { ok: true });
    assert.deepStrictEqual(await pedir('PUT', `/api/proarmet/ubicacion/${id}/producto`, { idProducto: 'P1' }), { ok: true });
    assert.deepStrictEqual(await pedir('DELETE', `/api/proarmet/ubicacion/${id}?forzar=1`), { ok: true });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'proarmet_ubicaciones.json'), 'utf8')), V);
  } finally { server.closeAllConnections(); server.close(); }
});
