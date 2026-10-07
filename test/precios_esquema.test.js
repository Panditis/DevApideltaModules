'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../lib/precios_esquema');

// ── Redondeos ────────────────────────────────────────────────────────────────

test('r2: 2 decimales sin ruido de punto flotante', () => {
  assert.strictEqual(E.r2(24.999750000000002), 25);
  assert.strictEqual(E.r2(1233.456), 1233.46);
  assert.strictEqual(E.r2(0), 0);
});

test('redondearMultiplo: múltiplo más cercano; paso 0 → 2 decimales', () => {
  assert.strictEqual(E.redondearMultiplo(1724.99, 50), 1700);
  assert.strictEqual(E.redondearMultiplo(1725, 50), 1750);
  assert.strictEqual(E.redondearMultiplo(1233.456, 0), 1233.46);
  assert.strictEqual(E.redondearMultiplo(1233.456, 10), 1230);
});

test('alinear: respeta el vigente si el exacto está a menos de $0,50', () => {
  assert.strictEqual(E.alinear(1733.2, 1733, 50), 1733);
  assert.strictEqual(E.alinear(1733.6, 1733, 50), 1750);
  assert.strictEqual(E.alinear(1733.2, 0, 50), 1750);
  assert.strictEqual(E.alinear(1733.2, null, 0), 1733.2);
});

// ── Gastos variables ─────────────────────────────────────────────────────────

const GASTOS = [
  { id: 'flete', concepto: 'Flete', pct: 1, tipos: { almacen: true, fraccionado: true, produccion: false } },
  { id: 'pop', concepto: 'Material POP', pct: 0.5, tipos: { almacen: true, fraccionado: false, produccion: true } },
  { id: 'roto', concepto: 'Sin tipos', pct: 9 },
];

test('pctItems: suma solo los ítems tildados para el tipo', () => {
  assert.strictEqual(E.pctItems(GASTOS, 'almacen'), 1.5);
  assert.strictEqual(E.pctItems(GASTOS, 'fraccionado'), 1);
  assert.strictEqual(E.pctItems(GASTOS, 'produccion'), 0.5);
  assert.strictEqual(E.pctItems([], 'almacen'), 0);
  assert.strictEqual(E.pctItems(undefined, 'almacen'), 0);
});

test('costoConGastos modo costo: costo × (1 + g)', () => {
  assert.strictEqual(E.costoConGastos(1000, 5, 'costo'), 1050);
  assert.strictEqual(E.costoConGastos(1000, 0, 'costo'), 1000);
});

test('costoConGastos modo precio: costo ÷ (1 − g)', () => {
  assert.strictEqual(E.costoConGastos(1000, 20, 'precio'), 1250);
  assert.strictEqual(E.costoConGastos(1000, 100, 'precio'), null);
});

test('costoConGastos: modo desconocido se trata como "costo"', () => {
  assert.strictEqual(E.costoConGastos(1000, 5, undefined), 1050);
});
