'use strict';
// Valida calcularRankingPorSucursal y calcularRankingGlobal: score = (facturación/máxima)^0.2, NO
// percentil de posición — un percentil de posición reparte SIEMPRE ~10% de items por decil sin
// importar el sesgo real de los datos; con facturación (Pareto, pocos productos explican casi toda
// la plata) eso pintaba como "importante" a productos que no lo son. Uso: node test/validar_ranking.js
const assert = require('assert');
const { calcularRankingPorSucursal, calcularRankingGlobal, roundDec } = require('../a8020');

// Sucursal 'a' (idSucursal=1): maxFact=100 → esos PLUs dan score 1. plu3 (fact=50, la mitad del líder)
// da bastante menos que 1 pero no crushed a 0 (curva de potencia<1, no lineal).
// idSucursal=4 no está en sucById (sucursal dada de baja) → se descarta sin dejar clave 'undefined'.
// idSucursal=3 no aparece en metricPorSuc (sin facturación en la ventana) → no genera entrada.
const metricPorSuc = {
  1: { '1': 100, '2': 100, '3': 50 },
  2: { '9': 30 },
  4: { '30': 999 },
};
const sucById = { 1: 'a', 2: 'b' };

const ranking = calcularRankingPorSucursal(metricPorSuc, sucById);

assert.strictEqual(ranking.a['1'], 1, `plu1 (max facturación de la sucursal) debería ser 1, dio ${ranking.a['1']}`);
assert.strictEqual(ranking.a['2'], 1, `plu2 (empata en max) debería ser 1, dio ${ranking.a['2']}`);
const esperadoPlu3 = roundDec(Math.pow(50 / 100, 0.2), 4);
assert.strictEqual(ranking.a['3'], esperadoPlu3, `plu3 (mitad de facturación) debería ser ${esperadoPlu3}, dio ${ranking.a['3']}`);
assert.ok(ranking.a['3'] > 0.8 && ranking.a['3'] < 1, 'facturar la mitad del líder no debería crushear el score a cerca de 0');
assert.strictEqual(ranking.b['9'], 1, `único plu de la sucursal b debería ser 1, dio ${ranking.b['9']}`);
assert.strictEqual(ranking.c, undefined, 'sucursal sin facturación en la ventana no debería generar entrada');
assert.strictEqual(ranking.a['999'], undefined, 'plu inexistente no debería tener score');
assert.ok(!('undefined' in ranking), 'idSucursal fuera de sucById no debería generar una clave undefined');

// calcularRankingGlobal: mismo criterio, sin agrupar por sucursal.
const metricByPlu = { '1': 100, '2': 10, '3': 1 };
const rg = calcularRankingGlobal(metricByPlu);
assert.strictEqual(rg['1'], 1, `plu de mayor facturación global debería ser 1, dio ${rg['1']}`);
assert.ok(rg['2'] > rg['3'], `mayor facturación debería dar mayor score (${rg['2']} vs ${rg['3']})`);
assert.ok(rg['2'] < 0.7, `facturar 10x menos que el líder debería aplastar bastante el score, dio ${rg['2']}`);
assert.ok(rg['3'] > 0 && rg['3'] < rg['2'], 'facturación baja pero no nula debería dar score bajo pero positivo, no cero');

console.log('OK: calcularRankingPorSucursal y calcularRankingGlobal usan score=(facturación/máxima)^0.2 — Pareto real, no percentil de posición uniforme.');
