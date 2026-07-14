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

const { parsearHtml } = require('../precios_proveedores');

test('parsearHtml extrae tabla con código/descripción/precio', () => {
  const html = `<html><body><table>
    <tr><th>Código</th><th>Descripción</th><th>Precio</th></tr>
    <tr><td>ALM-100</td><td>Almendras x 1kg</td><td>$ 12.500,00</td></tr>
    <tr><td></td><td>Nueces peladas</td><td>9.800,50</td></tr>
  </table></body></html>`;
  const r = parsearHtml(html);
  assert.strictEqual(r.items.length, 2);
  assert.deepStrictEqual(r.items[0], { codigoProveedor: 'ALM-100', descripcion: 'Almendras x 1kg', precio: 12500 });
  assert.strictEqual(r.items[1].codigoProveedor, '');
  assert.strictEqual(r.items[1].precio, 9800.5);
});

test('parsearHtml sin tablas devuelve vacío', () => {
  const r = parsearHtml('<html><body><p>Sin tablas acá</p></body></html>');
  assert.strictEqual(r.items.length, 0);
});

const { matchearItems, scoreNombre, normalizarNombre } = require('../precios_proveedores');

test('normalizarNombre saca acentos y símbolos', () => {
  assert.strictEqual(normalizarNombre('Almendra Ñandú x 1kg (Prem.)'), 'almendra nandu x 1kg prem');
});

test('matchearItems prioriza manual > codigo > barras > nombre', () => {
  const items = [
    { codigoProveedor: 'A1', descripcion: 'Cualquiera', precio: 10 },
    { codigoProveedor: 'B2', descripcion: 'Otra cosa', precio: 20 },
    { codigoProveedor: '7791234567890', descripcion: 'Con barras', precio: 30 },
    { codigoProveedor: '', descripcion: 'Almendras Nonpareil 1kg', precio: 40 },
    { codigoProveedor: '', descripcion: 'Producto desconocido xyz', precio: 50 },
  ];
  const ctx = {
    matcheosManuales: { A1: '100' },
    codigosProveedor: new Map([['A1', '999'], ['B2', '200']]),
    barras: new Map([['7791234567890', '300']]),
    catalogo: [{ plu: '400', nombre: 'Almendras Nonpareil x 1kg' }, { plu: '500', nombre: 'Miel pura' }],
  };
  const r = matchearItems(items, ctx);
  assert.deepStrictEqual(r.map(x => [x.plu, x.matchTipo]), [
    ['100', 'manual'], ['200', 'codigo'], ['300', 'barras'], ['400', 'nombre'], [null, null],
  ]);
  assert.ok(r[3].matchScore >= 0.6);
});
