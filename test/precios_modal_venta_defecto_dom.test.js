'use strict';
// Rótulo del modo de venta de pack/bulto pesables: sólo cuando viene por defecto (sin config explícita).
const test = require('node:test');
const assert = require('node:assert');
const { rotuloVentaMd } = require('../public/js/precios_modal_esquema.js');

test('rotuloVentaMd: paquete por defecto, kilo por defecto, y nada con config explícita o sin venta', () => {
  assert.strictEqual(rotuloVentaMd({ modo: 'paquete', pesoKg: 0.1, porDefecto: true }), 'Por paquete (peso de la presentación)');
  assert.strictEqual(rotuloVentaMd({ modo: 'kg', pesoKg: null, porDefecto: true }), 'Por kilo');
  assert.strictEqual(rotuloVentaMd({ modo: 'paquete', pesoKg: 0.1, porDefecto: false }), '');
  assert.strictEqual(rotuloVentaMd(null), '');
});

// Con el default de paquete en presentaciones no mayoristas, "Por kg" debe guardarse explícito (PUT), no borrar la config.
test('ventaPayload: "Por kg" se guarda explícito (PUT { modo: kg }, nunca DELETE)', () => {
  const { ventaPayload } = require('../public/js/precios_modal_esquema.js');
  assert.deepStrictEqual(ventaPayload('kg', null), { metodo: 'PUT', body: { modo: 'kg' } });
});
