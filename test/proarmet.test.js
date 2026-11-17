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
  assert.ok(validarMovimiento({ sentido: 'x' }).error);
  assert.ok(validarMovimiento({ sentido: 'ida', descripcion: '  ', lineas: [] }).error);
  assert.ok(validarMovimiento({ sentido: 'ida', descripcion: 'a'.repeat(201), lineas: [{}] }).error);
  assert.ok(validarMovimiento({ sentido: 'ida', descripcion: 'd', lineas: [] }).error);
  assert.ok(validarMovimiento({ sentido: 'ida', descripcion: 'd', lineas: [{ idProducto: '1', cantidad: 0 }] }).error);
  assert.deepStrictEqual(
    validarMovimiento({ sentido: 'vuelta', descripcion: ' d ', lineas: [{ idProducto: 1, cantidad: 2 }, { idProducto: '1', cantidad: '3' }] }),
    { sentido: 'vuelta', descripcion: 'd', lineas: [{ idProducto: '1', cantidad: 5 }] });
});

test('chequearLineas', () => {
  const p = new Map([['1', { activo: true, stockDeposito: 4 }], ['2', { activo: false, stockDeposito: 10 }]]);
  assert.match(chequearLineas('ida', [{ idProducto: '9', cantidad: 1 }], p), /no existe/);
  assert.match(chequearLineas('ida', [{ idProducto: '2', cantidad: 1 }], p), /inactivo/);
  assert.match(chequearLineas('vuelta', [{ idProducto: '1', cantidad: 5 }], p), /hay 4/);
  assert.strictEqual(chequearLineas('vuelta', [{ idProducto: '1', cantidad: 4 }, { idProducto: '2', cantidad: 1 }], p), null);
});
