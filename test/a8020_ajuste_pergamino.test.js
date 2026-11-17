'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { computeA8020 } = require('../lib/a8020');

const config = {
  abc: { corteA: 0.8, corteB: 0.95 },
  servicio: { A: 0, B: 0, C: 0 },
  minFraccion: { A: 0.7, B: 0.7, C: 0.7 },
  sucursales: { riv: { idSucursal: 1, T: 10, L: 0 }, pergamino: { idSucursal: 5, T: 10, L: 0 } },
};

function filaDe(idSucursal, config2) {
  const stats = [{ idSucursal, plu: 1, sumQ: 100, sumQ2: 1000 }];   // mu = 1/día → S = 10
  const { filas } = computeA8020(stats, { 1: 100, 5: 100 }, { 1: 1 }, config2 || config, new Set(), {}, null);
  return filas[0];
}

test('sucursal sin ajuste: S=10, min=7', () => {
  const f = filaDe(1);
  assert.deepStrictEqual([f.S, f.min], [10, 7]);
});

test('Pergamino: min +50% supera S → S +50%', () => {
  const f = filaDe(5);   // min 7 → 10.5 → 11 > S=10 → S = 15
  assert.strictEqual(f.S, 15);
  assert.strictEqual(f.min, 11);
});

test('Pergamino: min ajustado que no supera S deja S intacto', () => {
  const cfg = { ...config, minFraccion: { A: 0.5, B: 0.5, C: 0.5 } };   // min 5 → 7.5 → 8 ≤ 10
  const f = filaDe(5, cfg);
  assert.strictEqual(f.S, 10);
  assert.strictEqual(f.min, 8);
});
