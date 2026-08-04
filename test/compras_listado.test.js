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

const { consumoPromedioMensual } = require('../compras_modulo');

test('consumoPromedioMensual suma sucursales y divide por la ventana', () => {
  const consumo = { 100: { riv: 120, urq: 60 } };
  assert.strictEqual(consumoPromedioMensual(consumo, '100', 12), 15);
});

test('consumoPromedioMensual devuelve null si no hay dato del PLU', () => {
  assert.strictEqual(consumoPromedioMensual({}, '100', 12), null);
  assert.strictEqual(consumoPromedioMensual(null, '100', 12), null);
});

test('consumoPromedioMensual cae a 12 meses si la ventana es inválida', () => {
  assert.strictEqual(consumoPromedioMensual({ 100: { riv: 24 } }, '100', 0), 2);
  assert.strictEqual(consumoPromedioMensual({ 100: { riv: 24 } }, '100', null), 2);
});

test('consumoPromedioMensual redondea a 2 decimales', () => {
  assert.strictEqual(consumoPromedioMensual({ 100: { riv: 10 } }, '100', 12), 0.83);
});
