'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { cfgProarmet, buscarDeposito, validarMovimiento, chequearLineas } = require('../lib/proarmet');

test('cfg: defaults y central desde reserva', () => {
  assert.deepStrictEqual(cfgProarmet(undefined, 1), { idSucursal: 1, idDeposito: 'DepositoProarmet', idDepositoCentral: 1, idTipoMovimiento: 'REC-SUC' });
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
