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
