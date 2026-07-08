'use strict';
// Valida calcularRankingPorSucursal: orden por facturación desc, empate por volumen desc,
// score = percentil de posición (1.0 primero, 0 último, n=1 → 1).
// Uso: node validar_ranking.js
const assert = require('assert');
const { calcularRankingPorSucursal } = require('./a8020');

// Sucursal 'a' (idSucursal=1): plu2 y plu1 empatan en facturación (100), plu2 tiene más volumen → va primero.
// plu3 tiene menos facturación (50) → último, score 0.
const metricPorSuc = {
  1: { '1': 100, '2': 100, '3': 50 },
  2: { '9': 30 },
};
const statRows = [
  { idSucursal: 1, plu: 1, sumQ: 5, sumQ2: 25, dcv: 5 },
  { idSucursal: 1, plu: 2, sumQ: 10, sumQ2: 100, dcv: 5 },
  { idSucursal: 1, plu: 3, sumQ: 1, sumQ2: 1, dcv: 1 },
  { idSucursal: 2, plu: 9, sumQ: 7, sumQ2: 49, dcv: 3 },
];
const sucById = { 1: 'a', 2: 'b' };

const ranking = calcularRankingPorSucursal(metricPorSuc, statRows, sucById);

assert.strictEqual(ranking.a[2], 1, `plu2 (mayor volumen en empate) debería ser 1, dio ${ranking.a[2]}`);
assert.strictEqual(ranking.a[1], 0.5, `plu1 (empate, menor volumen) debería ser 0.5, dio ${ranking.a[1]}`);
assert.strictEqual(ranking.a[3], 0, `plu3 (menor facturación) debería ser 0, dio ${ranking.a[3]}`);
assert.strictEqual(ranking.b[9], 1, `único plu de la sucursal b debería ser 1, dio ${ranking.b[9]}`);
assert.strictEqual(ranking.a[999], undefined, 'plu inexistente no debería tener score');

console.log('OK: calcularRankingPorSucursal ordena por facturación, desempata por volumen y da percentil correcto.');
