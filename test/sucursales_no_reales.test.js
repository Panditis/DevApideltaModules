const test = require('node:test');
const assert = require('node:assert');
const { SUCURSALES_NO_REALES, esSucursalReal, filtrarSucursalesReales, sqlExcluirSucursales } = require('../lib/sucursales_no_reales');

test('SUCURSALES_NO_REALES: las sucursales 6, 8 y 11 de SiGA, solo números', () => {
  assert.deepStrictEqual([...SUCURSALES_NO_REALES], [6, 8, 11]);
  assert.ok(SUCURSALES_NO_REALES.every(Number.isInteger));
  assert.ok(Object.isFrozen(SUCURSALES_NO_REALES));
});

test('esSucursalReal: false para 6, 8 y 11 (también como texto), true para el resto', () => {
  for (const id of [6, 8, 11, '6', '8', '11']) assert.strictEqual(esSucursalReal(id), false, String(id));
  for (const id of [1, 2, 3, 7, 10, 12, 60, '1', '16']) assert.strictEqual(esSucursalReal(id), true, String(id));
});

test('filtrarSucursalesReales: saca las no reales y conserva el orden y el resto de los campos', () => {
  const lista = [{ id: 1, nombre: 'Central', central: true }, { id: 6, nombre: 'X' }, { id: 2, nombre: 'Norte' }, { id: '11', nombre: 'Y' }, { id: 8, nombre: 'Z' }];
  assert.deepStrictEqual(filtrarSucursalesReales(lista), [{ id: 1, nombre: 'Central', central: true }, { id: 2, nombre: 'Norte' }]);
  assert.deepStrictEqual(filtrarSucursalesReales([]), []);
  assert.deepStrictEqual(filtrarSucursalesReales(undefined), []);
});

test('sqlExcluirSucursales: fragmento NOT IN con la lista; rechaza columnas que no sean un identificador', () => {
  assert.strictEqual(sqlExcluirSucursales('v.IdSucursal'), 'v.IdSucursal NOT IN (6,8,11)');
  assert.strictEqual(sqlExcluirSucursales('IdSucursal'), 'IdSucursal NOT IN (6,8,11)');
  for (const mala of ['', 'x; DROP TABLE y', "a' OR '1'='1", 'a b', null, undefined, 5]) {
    assert.throws(() => sqlExcluirSucursales(mala), /columna/, String(mala));
  }
});

const { sqlExcluirCentral } = require('../lib/sucursales_no_reales');

test('sqlExcluirCentral: excluye las ventas hechas por la sucursal central; rechaza columnas que no sean un identificador', () => {
  assert.strictEqual(sqlExcluirCentral('v.IdSucursal'), 'v.IdSucursal NOT IN (SELECT IdSucursal FROM Sucursales WHERE SoyLaCentral=1)');
  assert.strictEqual(sqlExcluirCentral('IdSucursal'), 'IdSucursal NOT IN (SELECT IdSucursal FROM Sucursales WHERE SoyLaCentral=1)');
  for (const mala of ['', 'x; DROP TABLE y', "a' OR '1'='1", 'a b', null, undefined, 5]) {
    assert.throws(() => sqlExcluirCentral(mala), /columna/, String(mala));
  }
});
