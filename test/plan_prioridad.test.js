const test = require('node:test');
const assert = require('node:assert');
const { puntajePrioridad } = require('../lib/plan_prioridad');
test('puntajePrioridad: Σx²/Σx, ignora no numéricos y negativos, 0 sin ventas', () => {
  assert.strictEqual(puntajePrioridad([100, 10, 10]), 85);
  assert.strictEqual(puntajePrioridad([50]), 50);
  assert.strictEqual(puntajePrioridad([]), 0);
  assert.strictEqual(puntajePrioridad([0, 0]), 0);
  assert.strictEqual(puntajePrioridad([10, null, 'x', -5, 10]), 10);
  assert.strictEqual(puntajePrioridad([1, 2]), 1.67);
});

const { clasesABC, nivelUrgencia, compararUrgencia } = require('../lib/plan_prioridad');

test('clasesABC: Pareto 80/15/5 sobre el puntaje, el que cruza el 80% queda en A', () => {
  assert.deepStrictEqual(clasesABC([80, 15, 5]), ['A', 'B', 'C']);
  assert.deepStrictEqual(clasesABC([5, 80, 15]), ['C', 'A', 'B']);          // respeta el orden de entrada
  assert.deepStrictEqual(clasesABC([50, 40, 6, 4]), ['A', 'A', 'B', 'C']);   // 50 → 90%: el 2º cruza el 80% y es A
  assert.deepStrictEqual(clasesABC([100]), ['A']);
});

test('clasesABC: puntaje 0, inválido o negativo es C; sin puntaje total todo es C; vacío', () => {
  assert.deepStrictEqual(clasesABC([0, 0]), ['C', 'C']);
  assert.deepStrictEqual(clasesABC([90, 0, null, 'x', -3, 10]), ['A', 'C', 'C', 'C', 'C', 'B']);
  assert.deepStrictEqual(clasesABC([]), []);
  assert.deepStrictEqual(clasesABC(undefined), []);
});

test('clasesABC: los empates comparten clase aunque crucen un corte', () => {
  assert.deepStrictEqual(clasesABC([1, 1, 1, 1, 1]), ['A', 'A', 'A', 'A', 'A']);
  assert.deepStrictEqual(clasesABC([60, 10, 10, 10, 10]), ['A', 'A', 'A', 'A', 'A']);   // el bloque empatado arranca en 60% (< 80%): va entero a A
  assert.deepStrictEqual(clasesABC([85, 5, 5, 5]), ['A', 'B', 'B', 'B']);             // el bloque arranca en 85%: entero a B aunque cruce el 95%
});

test('nivelUrgencia: < umbral URGENTE, < 2×umbral PRONTO, si no OK; umbral por clase', () => {
  const u = { A: 7, B: 5, C: 3 };
  assert.strictEqual(nivelUrgencia(6.9, 'A', u), 'URGENTE');
  assert.strictEqual(nivelUrgencia(7, 'A', u), 'PRONTO');
  assert.strictEqual(nivelUrgencia(13.9, 'A', u), 'PRONTO');
  assert.strictEqual(nivelUrgencia(14, 'A', u), 'OK');
  assert.strictEqual(nivelUrgencia(4, 'B', u), 'URGENTE');
  assert.strictEqual(nivelUrgencia(4, 'C', u), 'PRONTO');
  assert.strictEqual(nivelUrgencia(0, 'C', u), 'URGENTE');
  assert.strictEqual(nivelUrgencia(-2, 'C', u), 'URGENTE');      // stock negativo en SiGA
});

test('nivelUrgencia: sin cobertura (sin ventas) es OK; umbrales faltantes o inválidos caen al default 7/5/3', () => {
  assert.strictEqual(nivelUrgencia(null, 'A'), 'OK');
  assert.strictEqual(nivelUrgencia(undefined, 'A'), 'OK');
  assert.strictEqual(nivelUrgencia(Infinity, 'A'), 'OK');
  assert.strictEqual(nivelUrgencia(NaN, 'A'), 'OK');
  assert.strictEqual(nivelUrgencia(6, 'A'), 'URGENTE');
  assert.strictEqual(nivelUrgencia(6, 'A', { A: 'x' }), 'URGENTE');
  assert.strictEqual(nivelUrgencia(6, 'A', { A: 10 }), 'URGENTE');
  assert.strictEqual(nivelUrgencia(6, 'B', { A: 10 }), 'PRONTO');      // B sin configurar → default 5
  assert.strictEqual(nivelUrgencia(4, 'Z'), 'PRONTO');                 // clase desconocida se trata como C
});

test('compararUrgencia: urgencia (URGENTE > PRONTO > OK), después rankingPos; sin rankingPos, más facturación primero', () => {
  const g = (urgencia, rankingPos, facturacionMensual) => ({ urgencia, rankingPos, facturacionMensual });
  const orden = lista => [...lista].sort(compararUrgencia).map(x => `${x.urgencia}${x.rankingPos ?? '-'}`);
  assert.deepStrictEqual(
    orden([g('OK', 1), g('PRONTO', 5), g('URGENTE', 9), g('URGENTE', 2), g('PRONTO', 3)]),
    ['URGENTE2', 'URGENTE9', 'PRONTO3', 'PRONTO5', 'OK1']);
  assert.deepStrictEqual(orden([g('OK', undefined), g('OK', 4), g('OK', 2)]), ['OK2', 'OK4', 'OK-']);
  const pres = [g('PRONTO', undefined, 10), g('PRONTO', undefined, 500), g('URGENTE', undefined, 1)];
  assert.deepStrictEqual([...pres].sort(compararUrgencia).map(p => p.facturacionMensual), [1, 500, 10]);
  assert.strictEqual(compararUrgencia(g('OK', 3), g('OK', 3)), 0);
});
