'use strict';
// Consumo real por (sucursal, producto): la venta de un PLU se imputa al producto que
// realmente sale del stock (bulto → componentes, fraccionado → granel).
const assert = require('assert');
const { calcularConsumoReal } = require('../a8020');

const SUC = { 5: 'riv', 2: 'urq' };
let ok = 0, fail = 0;
function test(nombre, fn) {
  try { fn(); ok++; console.log(`  ✓ ${nombre}`); }
  catch (e) { fail++; console.log(`  ✗ ${nombre}\n     ${e.message}`); }
}

console.log('\ncalcularConsumoReal');

test('almacén suelto: la venta es consumo propio', () => {
  const { consumo, consumoOrigen } = calcularConsumoReal(
    [{ idSucursal: 5, plu: 100, sumQ: 12 }], SUC, { 100: 'Almacen' }, {}, new Map());
  assert.strictEqual(consumo['100'].riv, 12);
  assert.strictEqual(consumoOrigen['100'].riv.propio, 12);
});

test('bulto mayorista: la venta consume los componentes de su fórmula', () => {
  const comps = new Map([['200', [{ plu: '100', cantPorUnidad: 12 }]]]);
  const { consumo, consumoOrigen } = calcularConsumoReal(
    [{ idSucursal: 5, plu: 200, sumQ: 3 }], SUC, { 200: 'Almacen Bultos/Cajas' }, {}, comps);
  assert.strictEqual(consumo['100'].riv, 36);
  assert.strictEqual(consumoOrigen['100'].riv.bulto, 36);
  assert.strictEqual(consumo['200'], undefined, 'el bulto no consume por sí mismo');
});

test('bulto con varios componentes: reparte por cantPorUnidad', () => {
  const comps = new Map([['200', [{ plu: '100', cantPorUnidad: 6 }, { plu: '101', cantPorUnidad: 2 }]]]);
  const { consumo } = calcularConsumoReal(
    [{ idSucursal: 5, plu: 200, sumQ: 5 }], SUC, { 200: 'Almacen Bultos/Cajas' }, {}, comps);
  assert.strictEqual(consumo['100'].riv, 30);
  assert.strictEqual(consumo['101'].riv, 10);
});

test('bulto sin fórmula activa: el consumo no se pierde, queda en el propio PLU', () => {
  const { consumo, consumoOrigen } = calcularConsumoReal(
    [{ idSucursal: 5, plu: 200, sumQ: 4 }], SUC, { 200: 'Almacen Bultos/Cajas' }, {}, new Map());
  assert.strictEqual(consumo['200'].riv, 4);
  assert.strictEqual(consumoOrigen['200'].riv.propio, 4);
});

test('fraccionado: la venta consume kg del granel según cantFormula', () => {
  const { consumo, consumoOrigen } = calcularConsumoReal(
    [{ idSucursal: 5, plu: 42, sumQ: 8 }], SUC, { 42: 'Pesables Fraccionado' },
    { 42: { granel: 30055, cantFormula: 0.25 } }, new Map());
  assert.strictEqual(consumo['30055'].riv, 2);
  assert.strictEqual(consumoOrigen['30055'].riv.fraccionado, 2);
  assert.strictEqual(consumo['42'], undefined, 'el fraccionado no consume por sí mismo');
});

test('fraccionado sin granel mapeado: queda como consumo propio', () => {
  const { consumo, consumoOrigen } = calcularConsumoReal(
    [{ idSucursal: 5, plu: 43, sumQ: 7 }], SUC, { 43: 'Pesables Venta Directa' }, {}, new Map());
  assert.strictEqual(consumo['43'].riv, 7);
  assert.strictEqual(consumoOrigen['43'].riv.propio, 7);
});

test('el granel acumula varios fraccionados y separa el origen del propio', () => {
  const rows = [
    { idSucursal: 5, plu: 42, sumQ: 8 },      // 0.25 kg → 2 kg
    { idSucursal: 5, plu: 44, sumQ: 3 },      // 1 kg    → 3 kg
    { idSucursal: 5, plu: 30055, sumQ: 1.5 }, // el granel también se vende suelto
  ];
  const { consumo, consumoOrigen } = calcularConsumoReal(rows, SUC,
    { 42: 'Pesables Fraccionado', 44: 'Pesables Fraccionado', 30055: 'Pesables Deposito' },
    { 42: { granel: 30055, cantFormula: 0.25 }, 44: { granel: 30055, cantFormula: 1 } }, new Map());
  assert.strictEqual(consumo['30055'].riv, 6.5);
  assert.strictEqual(consumoOrigen['30055'].riv.fraccionado, 5);
  assert.strictEqual(consumoOrigen['30055'].riv.propio, 1.5);
});

test('el consumo se separa por sucursal', () => {
  const rows = [{ idSucursal: 5, plu: 100, sumQ: 10 }, { idSucursal: 2, plu: 100, sumQ: 4 }];
  const { consumo } = calcularConsumoReal(rows, SUC, { 100: 'Almacen' }, {}, new Map());
  assert.strictEqual(consumo['100'].riv, 10);
  assert.strictEqual(consumo['100'].urq, 4);
});

test('ignora sucursales fuera de config y ventas no positivas', () => {
  const rows = [{ idSucursal: 99, plu: 100, sumQ: 10 }, { idSucursal: 5, plu: 100, sumQ: 0 },
                { idSucursal: 5, plu: 101, sumQ: -3 }];
  const { consumo } = calcularConsumoReal(rows, SUC, { 100: 'Almacen', 101: 'Almacen' }, {}, new Map());
  assert.deepStrictEqual(consumo, {});
});

test('sin rubro conocido y sin granel: cae a consumo propio', () => {
  const { consumo } = calcularConsumoReal(
    [{ idSucursal: 5, plu: 999, sumQ: 2 }], SUC, {}, {}, new Map());
  assert.strictEqual(consumo['999'].riv, 2);
});

test('redondea a 2 decimales', () => {
  const { consumo } = calcularConsumoReal(
    [{ idSucursal: 5, plu: 42, sumQ: 7 }], SUC, { 42: 'Pesables Fraccionado' },
    { 42: { granel: 30055, cantFormula: 0.333 } }, new Map());
  assert.strictEqual(consumo['30055'].riv, 2.33);
});

console.log(`\n${ok} ok, ${fail} fallidos\n`);
process.exit(fail ? 1 : 0);
