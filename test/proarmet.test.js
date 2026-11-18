'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { cfgProarmet, buscarDeposito, validarMovimiento, chequearLineas, historialMovimientos, usuarioMovimiento } = require('../lib/proarmet');

test('cfg: defaults y central desde reserva', () => {
  assert.deepStrictEqual(cfgProarmet(undefined, 1), { idSucursal: 1, idDeposito: 'DepositoProarmet', idDepositoCentral: 1, idTipoMovimiento: 'BIENESUSO' });
  assert.strictEqual(cfgProarmet({ idTipoMovimiento: 'bienesuso' }, 1).idTipoMovimiento, 'BIENESUSO');
});

test('buscarDeposito por id y por nombre', () => {
  const d = [{ IdDeposito: 1, NombreDeposito: ' Principal' }, { IdDeposito: 7, NombreDeposito: '  Deposito Proarmet' }];
  assert.strictEqual(buscarDeposito(d, 7).IdDeposito, 7);
  assert.strictEqual(buscarDeposito(d, 'DepositoProarmet').IdDeposito, 7);
  assert.strictEqual(buscarDeposito(d, 'proarmet').IdDeposito, 7);
  assert.strictEqual(buscarDeposito(d, 'otro'), null);
});

test('validarMovimiento', () => {
  const ok = [1, 7];
  const base = { depOrigen: 1, depDestino: 7, descripcion: 'd' };
  assert.ok(validarMovimiento({ ...base, depOrigen: 'x' }, ok).error);
  assert.match(validarMovimiento({ ...base, depDestino: 1 }, ok).error, /mismo/);
  assert.match(validarMovimiento({ ...base, depDestino: 9 }, ok).error, /destino 9/);
  assert.ok(validarMovimiento({ ...base, descripcion: '  ', lineas: [{}] }, ok).error);
  assert.ok(validarMovimiento({ ...base, descripcion: 'a'.repeat(201), lineas: [{}] }, ok).error);
  assert.ok(validarMovimiento({ ...base, lineas: [] }, ok).error);
  assert.ok(validarMovimiento({ ...base, lineas: [{ idProducto: '1', cantidad: 0 }] }, ok).error);
  assert.deepStrictEqual(
    validarMovimiento({ depOrigen: '7', depDestino: 1, descripcion: ' d ', lineas: [{ idProducto: 1, cantidad: 2 }, { idProducto: '1', cantidad: '3' }] }, ok),
    { depOrigen: 7, depDestino: 1, descripcion: 'd', lineas: [{ idProducto: '1', cantidad: 5 }] });
});

test('chequearLineas', () => {
  const p = new Map([['1', { activo: true, stockOrigen: 4 }], ['2', { activo: false, stockOrigen: 10 }]]);
  assert.match(chequearLineas([{ idProducto: '9', cantidad: 1 }], p), /no existe/);
  assert.match(chequearLineas([{ idProducto: '2', cantidad: 1 }], p), /inactivo/);
  assert.match(chequearLineas([{ idProducto: '1', cantidad: 5 }], p), /hay 4/);
  assert.strictEqual(chequearLineas([{ idProducto: '1', cantidad: 4 }], p), null);
});

test('historialMovimientos: filtra, ordena, normaliza', () => {
  const log = [
    { id: 'a', origen: 'traslado', idSucursal: 1, depOrigen: 1, depDestino: 4, fechaHora: 't1', estado: 'confirmado', observacion: 'ida', lineas: [{ plu: '10', nombre: null, cantidad: 2 }] },
    { id: 'b', origen: 'reserva', idSucursal: 1, depOrigen: 1, depDestino: 4, lineas: [] },
    { id: 'c', origen: 'traslado', idSucursal: 2, depOrigen: 4, depDestino: 1, lineas: [] },
    { id: 'd', origen: 'traslado', idSucursal: 1, depOrigen: 4, depDestino: 9, revertidoPor: 'z', lineas: [] },
    { id: 'e', origen: 'traslado', idSucursal: 1, depOrigen: 1, depDestino: 2, lineas: [] },
  ];
  const r = historialMovimientos(log, { idSucursal: 1, idDeposito: 4, limit: 10, nombres: new Map([[1, 'Principal'], [4, 'Proarmet']]) });
  assert.deepStrictEqual(r.map(m => m.id), ['d', 'a']);
  assert.strictEqual(r[0].tipo, 'salida');
  assert.strictEqual(r[0].depDestinoNombre, null);
  assert.strictEqual(r[0].revertidoPor, 'z');
  assert.deepStrictEqual(r[1], { id: 'a', fecha: 't1', numeroMovimiento: null, estado: 'confirmado', tipo: 'ingreso', depOrigen: 1, depDestino: 4,
    depOrigenNombre: 'Principal', depDestinoNombre: 'Proarmet', usuario: null, descripcion: 'ida',
    lineas: [{ idProducto: '10', descripcion: null, cantidad: 2 }], revertidoPor: null });
  assert.strictEqual(historialMovimientos(log, { idSucursal: 1, idDeposito: 4, limit: 1, nombres: new Map() }).length, 1);
});

test('usuarioMovimiento: graba el id, valida contra activos y no trunca', () => {
  const us = [{ id: '3', nombre: 'Juan Perez Gomez' }, { id: '7', nombre: 'Ana' }, { id: 'ABCDEFGHIJK', nombre: 'Largo' }];
  assert.deepStrictEqual(usuarioMovimiento(us, 7, 10), { usuario: '7' });
  assert.deepStrictEqual(usuarioMovimiento(us, ' 3 ', 10), { usuario: '3' });
  for (const v of ['9', undefined, '']) assert.ok(usuarioMovimiento(us, v, 10).error);
  assert.match(usuarioMovimiento(us, 'ABCDEFGHIJK', 10).error, /supera los 10/);
});

test('historialMovimientos: resuelve id de usuario a nombre, deja tal cual lo viejo', () => {
  const log = ['3', 'Juan Viejo', null].map((usuario, i) => ({ id: String(i), origen: 'traslado', idSucursal: 1, depOrigen: 1, depDestino: 4, usuario, lineas: [] }));
  const r = historialMovimientos(log, { idSucursal: 1, idDeposito: 4, limit: 10, nombres: new Map(), usuarios: new Map([['3', 'Juan Perez Gomez']]) });
  assert.deepStrictEqual(r.map(m => m.usuario), [null, 'Juan Viejo', 'Juan Perez Gomez']);
});
