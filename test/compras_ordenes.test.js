const test = require('node:test');
const assert = require('node:assert');
const { transicionValida, ESTADOS_ORDEN } = require('../compras_modulo');

test('ESTADOS_ORDEN son los cuatro del spec', () => {
  assert.deepStrictEqual(ESTADOS_ORDEN, ['GENERADA', 'ENVIADA', 'RECIBIDA', 'ANULADA']);
});

test('transiciones válidas desde GENERADA', () => {
  assert.strictEqual(transicionValida('GENERADA', 'ENVIADA'), true);
  assert.strictEqual(transicionValida('GENERADA', 'ANULADA'), true);
});

test('transiciones válidas desde ENVIADA', () => {
  assert.strictEqual(transicionValida('ENVIADA', 'RECIBIDA'), true);
  assert.strictEqual(transicionValida('ENVIADA', 'ANULADA'), true);
});

test('no se puede saltear ENVIADA', () => {
  assert.strictEqual(transicionValida('GENERADA', 'RECIBIDA'), false);
});

test('no se puede retroceder', () => {
  assert.strictEqual(transicionValida('ENVIADA', 'GENERADA'), false);
});

test('RECIBIDA y ANULADA son finales', () => {
  for (const destino of ESTADOS_ORDEN) {
    assert.strictEqual(transicionValida('RECIBIDA', destino), false);
    assert.strictEqual(transicionValida('ANULADA', destino), false);
  }
});

test('estado desconocido o vacío nunca es válido', () => {
  assert.strictEqual(transicionValida('INVENTADO', 'ENVIADA'), false);
  assert.strictEqual(transicionValida('GENERADA', 'INVENTADO'), false);
  assert.strictEqual(transicionValida(null, 'ENVIADA'), false);
  assert.strictEqual(transicionValida('GENERADA', ''), false);
});
