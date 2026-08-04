const test = require('node:test');
const assert = require('node:assert');
const { agruparPesablesPorGranel } = require('../compras_modulo');

const fila = (plu, granel, cantFormula, ideal, stkSuc) => ({
  plu, granel, nombreGranel: 'GRANEL YERBA', cantFormula, ideal, stkSuc, nombre: 'Yerba ' + plu,
});

test('convierte el ideal de cada fraccionado a kg de granel y los suma', () => {
  // 20 paquetes de 0,5kg = 10kg · 8 paquetes de 1kg = 8kg → 18kg
  const r = agruparPesablesPorGranel([
    fila('10', 4409, 0.5, { riv: 12, urq: 8 }, { riv: 2 }),
    fila('11', 4409, 1,   { riv: 8 },          { urq: 3 }),
  ]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].granel, 4409);
  assert.strictEqual(r[0].pideTotalGranel, 18);
});

test('lista los fraccionados que aportan, con su multiplicador', () => {
  const r = agruparPesablesPorGranel([
    fila('10', 4409, 0.5, { riv: 12 }, {}),
    fila('11', 4409, 1,   { riv: 8 },  {}),
  ]);
  assert.deepStrictEqual(r[0].presentaciones.map(p => [p.plu, p.cantFormula]), [['10', 0.5], ['11', 1]]);
});

test('separa graneles distintos', () => {
  const r = agruparPesablesPorGranel([
    fila('10', 4409, 1, { riv: 5 }, {}),
    fila('20', 7001, 1, { riv: 3 }, {}),
  ]);
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(r.map(x => x.granel).sort(), [4409, 7001]);
});

test('ignora fraccionados sin granel', () => {
  const r = agruparPesablesPorGranel([fila('10', null, 1, { riv: 5 }, {})]);
  assert.deepStrictEqual(r, []);
});

test('cantFormula ausente o inválida cuenta como 1', () => {
  const r = agruparPesablesPorGranel([
    fila('10', 4409, undefined, { riv: 4 }, {}),
    fila('11', 4409, 0,         { riv: 6 }, {}),
  ]);
  assert.strictEqual(r[0].pideTotalGranel, 10);
});

test('tolera entradas vacías', () => {
  assert.deepStrictEqual(agruparPesablesPorGranel([]), []);
  assert.deepStrictEqual(agruparPesablesPorGranel(null), []);
});

test('suma el stock de las presentaciones convertido a kg', () => {
  // 4 paquetes de 0,5kg = 2kg equivalentes
  const r = agruparPesablesPorGranel([fila('10', 4409, 0.5, {}, { riv: 3, urq: 1 })]);
  assert.strictEqual(r[0].stockPresentacionesKg, 2);
});
