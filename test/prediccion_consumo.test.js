const test = require('node:test');
const assert = require('node:assert');
const { mesesDeVentana, diasDelMes, mesAnterior } = require('../prediccion_consumo');

test('diasDelMes contempla bisiestos', () => {
  assert.strictEqual(diasDelMes('2026-01'), 31);
  assert.strictEqual(diasDelMes('2026-02'), 28);
  assert.strictEqual(diasDelMes('2024-02'), 29);
  assert.strictEqual(diasDelMes('2026-04'), 30);
});

test('diasDelMes con mes inválido devuelve null', () => {
  assert.strictEqual(diasDelMes('no-es-mes'), null);
  assert.strictEqual(diasDelMes(null), null);
});

test('mesAnterior retrocede y cruza el año', () => {
  assert.strictEqual(mesAnterior('2026-08', 1), '2026-07');
  assert.strictEqual(mesAnterior('2026-01', 1), '2025-12');
  assert.strictEqual(mesAnterior('2026-08', 12), '2025-08');
});

test('mesesDeVentana lista los N meses cerrados, sin el mes en curso', () => {
  // El mes en curso está incompleto: incluirlo aplasta el promedio justo en el dato que más pesa.
  assert.deepStrictEqual(mesesDeVentana('2026-08', 3), ['2026-05', '2026-06', '2026-07']);
});

test('mesesDeVentana devuelve orden cronológico ascendente', () => {
  const r = mesesDeVentana('2026-03', 4);
  assert.deepStrictEqual(r, ['2025-11', '2025-12', '2026-01', '2026-02']);
});
