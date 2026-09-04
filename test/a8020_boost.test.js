'use strict';
// Boost de productos propios: los PLUs de la casa (marca/nombre Apidelta + mixes propios)
// llevan +30% sobre el nivel calculado S; el min (= S·k) sube en la misma proporción.
const assert = require('assert');
const { computeA8020, esProductoApidelta, BOOST_APIDELTA_DEFAULT } = require('../lib/a8020');

let ok = 0, fail = 0;
function test(nombre, fn) {
  try { fn(); ok++; console.log(`  ✓ ${nombre}`); }
  catch (e) { fail++; console.log(`  ✗ ${nombre}\n     ${e.message}`); }
}

console.log('\nesProductoApidelta');

const PROPIOS = [
  ['Aceite Oliva Apidelta 1Lt', null],
  ['Miel 500G', 'APIDELTA'],
  ['Mix Europeo 100G', null],
  ['Mix F.S N&P 1Kg', null],
  ['Mix F.S Sin Pasas 200G', null],
  ['Mix Cerv. 1Kg', null],
  ['Mix Cerv. Prem. 100G', null],
];
const AJENOS = [
  ['Mix Barbacoa 50G', null],
  ['Cereal Mix PEDIDOS', null],
  ['Cerveza Corona Cero 0.0 Sin Alcohol 473Ml', null],
  ['Galletas De Arroz Rodez Con Mix Legumbres 75G', 'Rodez'],
  ['Mix Cereales Legumbres 1Kg', null],
];

test('reconoce nombre, marca y los mixes de la casa', () => {
  for (const [n, m] of PROPIOS) assert.strictEqual(esProductoApidelta(n, m), true, n);
});

test('no marca productos ajenos con "mix" o "cerveza" en el nombre', () => {
  for (const [n, m] of AJENOS) assert.strictEqual(esProductoApidelta(n, m), false, n);
});

console.log('\ncomputeA8020 · boost');

// Config mínima: una sucursal, T+L=7, sin overrides ni proporción de base.
const CONFIG = {
  sucursales: { riv: { idSucursal: 5, T: 5, L: 2 } },
  servicio: { A: 2.05, B: 1.645, C: 1.28 },
  minFraccion: { A: 0.7, B: 0.5, C: 0.35 },
  abc: { corteA: 0.8, corteB: 0.95 },
  techoDefault: 100000,
};
const STATS = [{ idSucursal: 5, plu: 100, sumQ: 300, sumQ2: 1200 }];
const OPS = { 5: 100 };
const METRIC = { 100: 1000 };
// Mismo insumo siempre: la única variable entre corridas es el boost.
const correr = (boostSet, extraCfg) =>
  computeA8020(STATS, OPS, METRIC, { ...CONFIG, ...extraCfg }, new Set(), {}, boostSet).filas[0];

test('sin boostSet el cálculo queda igual que antes', () => {
  const f = correr(undefined);
  assert.ok(f.S > 0);
  assert.strictEqual(f.min, Math.round(f.S * CONFIG.minFraccion[f.abc]));
});

test('el PLU propio sube +30% en S y en min', () => {
  const base = correr(undefined), boosted = correr(new Set([100]));
  assert.strictEqual(boosted.S, Math.round(base.S * BOOST_APIDELTA_DEFAULT), 'S del propio');
  assert.strictEqual(boosted.min, Math.round(boosted.S * CONFIG.minFraccion[boosted.abc]), 'min sigue a S');
  assert.ok(boosted.min > base.min, 'el min del propio sube');
});

test('un PLU que no está en el boostSet no se toca', () => {
  assert.strictEqual(correr(new Set([999])).S, correr(undefined).S);
});

test('el factor es configurable desde config.boostApidelta', () => {
  const base = correr(undefined);
  assert.strictEqual(correr(new Set([100]), { boostApidelta: 2 }).S, Math.round(base.S * 2));
});

test('el techo sigue mandando por encima del boost', () => {
  assert.strictEqual(correr(new Set([100]), { techoDefault: 10 }).S, 10);
});

console.log(`
${ok} ok, ${fail} fail`);
if (fail) process.exit(1);
