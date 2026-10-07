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
