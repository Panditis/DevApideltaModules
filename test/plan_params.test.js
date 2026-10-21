const test = require('node:test');
const assert = require('node:assert');
const { DIAS_A_CUBRIR_DEFAULT, validarDiasObjetivo, resolverDiasObjetivo } = require('../lib/plan_params');

test('validarDiasObjetivo: entero de 1 a 180 (número o texto numérico); si no, null', () => {
  assert.strictEqual(validarDiasObjetivo(30), 30);
  assert.strictEqual(validarDiasObjetivo('45'), 45);
  assert.strictEqual(validarDiasObjetivo(1), 1);
  assert.strictEqual(validarDiasObjetivo(180), 180);
  for (const malo of [0, -5, 181, 3.5, '3.5', '', '  ', 'x', null, undefined, NaN, Infinity, true, [], {}, '1e2', '0x10']) {
    assert.strictEqual(validarDiasObjetivo(malo), null, JSON.stringify(malo) + '/' + String(malo));
  }
});

test('resolverDiasObjetivo: lo guardado, si no el de config.json, si no 30; lo inválido se salta', () => {
  assert.strictEqual(DIAS_A_CUBRIR_DEFAULT, 30);
  assert.strictEqual(resolverDiasObjetivo({ diasObjetivo: 20 }, { diasObjetivo: 15 }), 20);
  assert.strictEqual(resolverDiasObjetivo({}, { diasObjetivo: 15 }), 15);
  assert.strictEqual(resolverDiasObjetivo(null, { diasObjetivo: 15 }), 15);
  assert.strictEqual(resolverDiasObjetivo({ diasObjetivo: 999 }, { diasObjetivo: 15 }), 15);   // archivo corrupto/viejo
  assert.strictEqual(resolverDiasObjetivo({ diasObjetivo: 'x' }, { diasObjetivo: 0 }), 30);
  assert.strictEqual(resolverDiasObjetivo(undefined, undefined), 30);
});
