'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/siga_compras/constantes');
const {
  redondear, sinRuido, letrasDe, discriminaIVA, precioIncluyeIVA, letraSugerida, validarLetra, calcularLinea,
} = require('../lib/siga_compras/lineas');

const cerca = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} no es ${b}`);

test('constantes fijas de SiGA', () => {
  assert.strictEqual(C.PORCENTAJE_IVA_CABECERA, 21);
  assert.strictEqual(C.METODO_GRABACION, 'M');
  assert.strictEqual(C.ID_FUNCION, 'MovimientosDeComprasV2');
  assert.deepStrictEqual(C.TIPOS_PERCEPCION, ['PIIBB', 'PGANA', 'PIVA', 'PVAR', 'IMINT']);
  assert.strictEqual(C.TIPO_TIPO_IMPUESTO.IMINT, 'INTERNO');
  assert.strictEqual(C.SUCURSAL_DEFAULT, 1);
});

test('redondear replica decimal.Round de .NET (al par en el punto medio)', () => {
  assert.strictEqual(redondear(0.125, 2), 0.12);
  assert.strictEqual(redondear(0.135, 2), 0.14);
  assert.strictEqual(redondear(2.675, 2), 2.68);
  assert.strictEqual(redondear(1.005, 2), 1);
  assert.strictEqual(redondear(-2.5, 0), -2);
  assert.strictEqual(redondear(6686.3244, 2), 6686.32);
  assert.strictEqual(redondear(0.30000000000000004, 2), 0.3);
  assert.strictEqual(sinRuido(955.19 * 0.92), 878.7748);
});

test('redondear: importes grandes no confunden un valor cercano con el punto medio', () => {
  assert.strictEqual(redondear(500000.31 * 21 / 100, 2), 105000.07);
  assert.strictEqual(redondear(105000.0651, 2), 105000.07);
  assert.strictEqual(redondear(123456.7851, 2), 123456.79);
  assert.strictEqual(redondear(10000000.127, 2), 10000000.13);
  assert.strictEqual(sinRuido(1000.0000014), 1000.000001);
});

test('letrasDe acepta string, array y separadores', () => {
  assert.deepStrictEqual(letrasDe('ABCEIM'), ['A', 'B', 'C', 'E', 'I', 'M']);
  assert.deepStrictEqual(letrasDe('a, b'), ['A', 'B']);
  assert.deepStrictEqual(letrasDe(['X']), ['X']);
  assert.deepStrictEqual(letrasDe(null), []);
});

test('discriminaIVA y precioIncluyeIVA (letra A vs B/C)', () => {
  const ri = { ivaDiscriminado: true, utilizaImpuestos: true };
  const mono = { ivaDiscriminado: false, utilizaImpuestos: true };
  const tipo = { utilizaImpuestos: true };
  assert.strictEqual(discriminaIVA({ proveedor: ri, empresa: ri, tipo }), true);
  assert.strictEqual(precioIncluyeIVA({ proveedor: ri, empresa: ri, tipo }), false);
  assert.strictEqual(discriminaIVA({ proveedor: mono, empresa: ri, tipo }), false);
  assert.strictEqual(precioIncluyeIVA({ proveedor: mono, empresa: ri, tipo }), true);
  assert.strictEqual(discriminaIVA({ proveedor: ri, empresa: ri, tipo: { utilizaImpuestos: false } }), false);
  assert.strictEqual(precioIncluyeIVA({ proveedor: mono, empresa: ri, tipo: { utilizaImpuestos: false } }), false);
});

test('letraSugerida: una sola letra habilitada gana; si no, la del proveedor', () => {
  assert.strictEqual(letraSugerida({ letrasHabilitadas: 'X', letraProveedor: 'A' }), 'X');
  assert.strictEqual(letraSugerida({ letrasHabilitadas: 'ABCEIM', letraProveedor: 'c' }), 'C');
  assert.strictEqual(letraSugerida({ letrasHabilitadas: 'ABC', letraProveedor: '' }), null);
});

test('validarLetra con los mensajes literales de SiGA', () => {
  const base = { letrasHabilitadas: 'ABCEIM', letraProveedor: 'A', porcentajesIVA: [21, 0] };
  assert.deepStrictEqual(validarLetra({ ...base, letra: 'A' }), []);
  assert.deepStrictEqual(validarLetra({ ...base, letra: '' }),
    [{ campo: 'letra', mensaje: 'Falta cargar el tipo de letra del comprobante.' }]);
  assert.deepStrictEqual(validarLetra({ ...base, letra: 'X' }),
    [{ campo: 'letra', mensaje: 'Este comprobante no esta habilitado para esta Letra Fiscal' }]);
  assert.deepStrictEqual(validarLetra({ ...base, letra: 'C' }),
    [{ campo: 'letra', mensaje: "La Letra 'C' NO coincide con la del Proveedor 'A'" }]);
  assert.deepStrictEqual(validarLetra({ ...base, letra: 'B' }),
    [{ campo: 'letra', mensaje: 'El porcentaje de IVA no puede ser distinto 0% ' }]);
  assert.deepStrictEqual(validarLetra({ ...base, letra: 'B', porcentajesIVA: [0, 0] }), []);
  assert.deepStrictEqual(validarLetra({ letra: 'X', letrasHabilitadas: 'X', letraProveedor: 'A' }), []);
});

test('calcularLinea: FACTCOM A sin descuentos (Precio sin IVA, IVA sin redondear)', () => {
  const l = calcularLinea({ cantidad: 1, precio: 31839.64, porcentajeIVA: 21, discrimina: true });
  assert.strictEqual(l.importeTotal, 31839.64);
  assert.strictEqual(l.precioNeto, 31839.64);
  assert.strictEqual(l.importeTotalNeto, 31839.64);
  assert.strictEqual(l.descRecGeneral, 0);
  assert.strictEqual(l.porcentajeIVA, 21);
  cerca(l.iva, 6686.3244);
});

test('calcularLinea: descuento general -10% → PrecioNeto neto de descuentos', () => {
  const l = calcularLinea({ cantidad: 3, precio: 100, porcentajeIVA: 21, porcDescRecGeneral: -10, discrimina: true });
  assert.strictEqual(l.importeTotal, 300);
  assert.strictEqual(l.descRecGeneral, -30);
  assert.strictEqual(l.descRecGeneralProducto, -10);
  assert.strictEqual(l.precioNeto, 90);
  assert.strictEqual(l.importeTotalNeto, 270);
  cerca(l.iva, 56.7);
});

test('calcularLinea: sin discriminación el IVA de la línea es 0 y el importe se redondea a 2', () => {
  const l = calcularLinea({ cantidad: 3, precio: 33.333, porcentajeIVA: 21, discrimina: false });
  assert.strictEqual(l.importeTotal, 100);
  assert.strictEqual(l.porcentajeIVA, 0);
  assert.strictEqual(l.iva, 0);
  assert.strictEqual(l.precioNeto, 33.33);
});
