const test = require('node:test');
const assert = require('node:assert');
const { a8020Vencido, A8020_RECALCULAR_CADA_DIAS_DEFAULT } = require('../lib/a8020');

const AHORA = new Date('2026-09-30T12:00:00Z');

test('a8020Vencido: vence cuando el último cálculo tiene N días o más', () => {
  assert.strictEqual(a8020Vencido('2026-09-23T12:00:00Z', 7, AHORA), true);
  assert.strictEqual(a8020Vencido('2026-09-23T12:00:01Z', 7, AHORA), false);
  assert.strictEqual(a8020Vencido('2026-09-04T11:27:20Z', 7, AHORA), true);
});

test('a8020Vencido: sin cálculo previo (o fecha inválida) está vencido', () => {
  assert.strictEqual(a8020Vencido(null, 7, AHORA), true);
  assert.strictEqual(a8020Vencido('basura', 7, AHORA), true);
});

test('a8020Vencido: días 0 o inválidos desactivan el recálculo automático; sin valor usa el default', () => {
  assert.strictEqual(a8020Vencido('2020-01-01T00:00:00Z', 0, AHORA), false);
  assert.strictEqual(a8020Vencido('2020-01-01T00:00:00Z', -3, AHORA), false);
  assert.strictEqual(A8020_RECALCULAR_CADA_DIAS_DEFAULT, 7);
  assert.strictEqual(a8020Vencido('2026-09-25T12:00:00Z', undefined, AHORA), false);
  assert.strictEqual(a8020Vencido('2026-09-22T12:00:00Z', undefined, AHORA), true);
});
