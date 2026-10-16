'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { armarFormulas, formulasPesables } = require('../lib/formulas_pesables');

test('Siga resuelve un PLU que el respaldo no tiene (alta nueva)', () => {
  const f = armarFormulas([{ Plu: '5952  ', Granel: '5953 ', Cant: 1 }], { 10: { granel: 4409, cantFormula: 1 } });
  assert.deepStrictEqual(f['5952'], { granel: 5953, cantFormula: 1 });
  assert.deepStrictEqual(f['10'], { granel: 4409, cantFormula: 1 });
});

test('Siga pisa al respaldo cuando la fórmula cambió', () => {
  const f = armarFormulas([{ Plu: '32', Granel: '9712', Cant: 0.25 }], { 32: { granel: 9648, cantFormula: 1 } });
  assert.deepStrictEqual(f['32'], { granel: 9712, cantFormula: 0.25 });
});

test('un mix (varios graneles) no recibe granel de Siga', () => {
  const f = armarFormulas([{ Plu: '6171', Granel: '1', Cant: 0.1 }, { Plu: '6171', Granel: '2', Cant: 0.2 }], {});
  assert.strictEqual(f['6171'], undefined);
});

test('si Siga falla devuelve el respaldo', async () => {
  const f = await formulasPesables({ query: async () => { throw new Error('caída'); }, FORMULA_ACTIVA_SQL: '1=1', respaldo: { 5: { granel: 6, cantFormula: 1 } } });
  assert.deepStrictEqual(f, { 5: { granel: 6, cantFormula: 1 } });
});
