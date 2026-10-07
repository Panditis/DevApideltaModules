'use strict';
// Simulador (public/js/precios_simulador.js): el mismo motor que el server (lib/precios_esquema), por unidad.
const test = require('node:test');
const assert = require('node:assert');
const E = require('../lib/precios_esquema');
const { simularCanales } = require('../public/js/precios_simulador.js');
const { CFG } = require('./precios_esquema_fixture');

test('simularCanales: los 5 precios del motor con pack y bulto por unidad', () => {
  const s = simularCanales(CFG, { costo: 1000, tipo: 'almacen' });
  assert.deepStrictEqual(s.faltantes, []);
  assert.deepStrictEqual(s.r, E.preciosCanales({ tipo: 'almacen', costo: 1000, pesoG: null, unidades: { pack: 1, bulto: 1 }, cfg: CFG }));
  assert.deepStrictEqual([s.r.minorista.precio, s.r.pack.neto, s.r.pack.conIva, s.r.bulto.conIva], [1800, 1430, 1750, 1750]);
});

test('simularCanales: costo con IVA de compra → neto; Fraccionado usa el peso para el ajuste', () => {
  const s = simularCanales(CFG, { costo: 1210, tipo: 'almacen', conIva: true, ivaCompraPct: 21 });
  assert.deepStrictEqual([s.costoNeto, s.ivaCompra, s.r.minorista.precio], [1000, 210, 1800]);
  assert.strictEqual(simularCanales(CFG, { costo: 1000, tipo: 'fraccionado', pesoG: 500 }).r.minorista.precio, 1950);
});

test('simularCanales: faltantes de entrada y errores del motor como texto', () => {
  assert.match(simularCanales(CFG, { costo: 0 }).faltantes[0], /costo/);
  assert.match(simularCanales(CFG, { costo: 100, conIva: true, ivaCompraPct: 150 }).faltantes[0], /alícuota/);
  assert.match(simularCanales(CFG, { costo: 100, tipo: 'fraccionado', pesoG: 0 }).faltantes[0], /peso/);
  assert.match(simularCanales({ ...CFG, margenes: {} }, { costo: 100 }).faltantes[0], /Márgenes/);
});
