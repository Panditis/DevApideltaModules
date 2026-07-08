'use strict';
// Valida calcularRankingPorSucursal: orden por facturación desc, empate por volumen desc,
// score = percentil de posición (1.0 primero, 0 último, n=1 → 1).
// Uso: node validar_ranking.js
const assert = require('assert');
const { calcularRankingPorSucursal } = require('./a8020');

// Sucursal 'a' (idSucursal=1): plu2 y plu1 empatan en facturación (100), plu2 tiene más volumen → va primero.
// plu3 tiene menos facturación (50) → último, score 0.
// Sucursal 'c' (idSucursal=3): sin filas en metricPorSuc (sin facturación en la ventana) pero con
// statRows → igual entra al ranking, desempatado solo por volumen (fact=0 para ambos).
// idSucursal=4: tiene filas en metricPorSuc y statRows pero NO está en sucById (sucursal dada de
// baja) → debe descartarse del todo, sin dejar una clave 'undefined' en el resultado.
const metricPorSuc = {
  1: { '1': 100, '2': 100, '3': 50 },
  2: { '9': 30 },
  4: { '30': 999 },
};
const statRows = [
  { idSucursal: 1, plu: 1, sumQ: 5, sumQ2: 25, dcv: 5 },
  { idSucursal: 1, plu: 2, sumQ: 10, sumQ2: 100, dcv: 5 },
  { idSucursal: 1, plu: 3, sumQ: 1, sumQ2: 1, dcv: 1 },
  { idSucursal: 2, plu: 9, sumQ: 7, sumQ2: 49, dcv: 3 },
  { idSucursal: 3, plu: 20, sumQ: 8, sumQ2: 64, dcv: 4 },
  { idSucursal: 3, plu: 21, sumQ: 3, sumQ2: 9, dcv: 2 },
  { idSucursal: 4, plu: 30, sumQ: 1, sumQ2: 1, dcv: 1 },
];
const sucById = { 1: 'a', 2: 'b', 3: 'c' };

const ranking = calcularRankingPorSucursal(metricPorSuc, statRows, sucById);

assert.strictEqual(ranking.a[2], 1, `plu2 (mayor volumen en empate) debería ser 1, dio ${ranking.a[2]}`);
assert.strictEqual(ranking.a[1], 0.5, `plu1 (empate, menor volumen) debería ser 0.5, dio ${ranking.a[1]}`);
assert.strictEqual(ranking.a[3], 0, `plu3 (menor facturación) debería ser 0, dio ${ranking.a[3]}`);
assert.strictEqual(ranking.b[9], 1, `único plu de la sucursal b debería ser 1, dio ${ranking.b[9]}`);
assert.strictEqual(ranking.a[999], undefined, 'plu inexistente no debería tener score');
assert.strictEqual(ranking.c[20], 1, `sucursal sin facturación: mayor volumen debería ser 1, dio ${ranking.c[20]}`);
assert.strictEqual(ranking.c[21], 0, `sucursal sin facturación: menor volumen debería ser 0, dio ${ranking.c[21]}`);
assert.ok(!('undefined' in ranking), 'idSucursal fuera de sucById no debería generar una clave undefined');

console.log('OK: calcularRankingPorSucursal ordena por facturación, desempata por volumen y da percentil correcto.');
