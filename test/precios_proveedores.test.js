const test = require('node:test');
const assert = require('node:assert');
const { parsearPrecioAR, parsearTextoPdf } = require('../precios_proveedores');

test('parsearPrecioAR formatos argentinos', () => {
  assert.strictEqual(parsearPrecioAR('1.234,56'), 1234.56);
  assert.strictEqual(parsearPrecioAR('1234.56'), 1234.56);
  assert.strictEqual(parsearPrecioAR('$ 1.234'), 1234);
  assert.strictEqual(parsearPrecioAR('2,50'), 2.5);
  assert.strictEqual(parsearPrecioAR('1.234.567'), 1234567);
  assert.strictEqual(parsearPrecioAR('abc'), null);
  assert.strictEqual(parsearPrecioAR(''), null);
});

test('parsearTextoPdf detecta código, descripción y precio', () => {
  const texto = [
    'LISTA DE PRECIOS JULIO 2026',
    'ALM-100 Almendras Nonpareil x 1kg 12.500,00',
    'Nueces peladas extra light 9.800,50',
    'CODIGO DESCRIPCION PRECIO',
    '',
  ].join('\n');
  const r = parsearTextoPdf(texto);
  assert.strictEqual(r.items.length, 2);
  assert.deepStrictEqual(r.items[0], { codigoProveedor: 'ALM-100', descripcion: 'Almendras Nonpareil x 1kg', precio: 12500 });
  assert.deepStrictEqual(r.items[1], { codigoProveedor: '', descripcion: 'Nueces peladas extra light', precio: 9800.5 });
  assert.strictEqual(r.descartadas, 2);
});

test('parsearTextoPdf no confunde años con precios', () => {
  const r = parsearTextoPdf('Vigencia desde enero 2026\nMIEL-1 Miel pura x 500g 4.200,00');
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].precio, 4200);
});
