'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../lib/precios_esquema');

// ── Redondeos ────────────────────────────────────────────────────────────────

test('r2: 2 decimales sin ruido de punto flotante', () => {
  assert.strictEqual(E.r2(24.999750000000002), 25);
  assert.strictEqual(E.r2(1233.456), 1233.46);
  assert.strictEqual(E.r2(0), 0);
});

test('redondearMultiplo: múltiplo más cercano; paso 0 → 2 decimales', () => {
  assert.strictEqual(E.redondearMultiplo(1724.99, 50), 1700);
  assert.strictEqual(E.redondearMultiplo(1725, 50), 1750);
  assert.strictEqual(E.redondearMultiplo(1233.456, 0), 1233.46);
  assert.strictEqual(E.redondearMultiplo(1233.456, 10), 1230);
});

test('alinear: respeta el vigente si el exacto está a menos de $0,50', () => {
  assert.strictEqual(E.alinear(1733.2, 1733, 50), 1733);
  assert.strictEqual(E.alinear(1733.6, 1733, 50), 1750);
  assert.strictEqual(E.alinear(1733.2, 0, 50), 1750);
  assert.strictEqual(E.alinear(1733.2, null, 0), 1733.2);
});

// ── Gastos variables ─────────────────────────────────────────────────────────

const GASTOS = [
  { id: 'flete', concepto: 'Flete', pct: 1, tipos: { almacen: true, fraccionado: true, produccion: false } },
  { id: 'pop', concepto: 'Material POP', pct: 0.5, tipos: { almacen: true, fraccionado: false, produccion: true } },
  { id: 'roto', concepto: 'Sin tipos', pct: 9 },
];

test('pctItems: suma solo los ítems tildados para el tipo', () => {
  assert.strictEqual(E.pctItems(GASTOS, 'almacen'), 1.5);
  assert.strictEqual(E.pctItems(GASTOS, 'fraccionado'), 1);
  assert.strictEqual(E.pctItems(GASTOS, 'produccion'), 0.5);
  assert.strictEqual(E.pctItems([], 'almacen'), 0);
  assert.strictEqual(E.pctItems(undefined, 'almacen'), 0);
});

test('costoConGastos modo costo: costo × (1 + g)', () => {
  assert.strictEqual(E.costoConGastos(1000, 5, 'costo'), 1050);
  assert.strictEqual(E.costoConGastos(1000, 0, 'costo'), 1000);
});

test('costoConGastos modo precio: costo ÷ (1 − g)', () => {
  assert.strictEqual(E.costoConGastos(1000, 20, 'precio'), 1250);
  assert.strictEqual(E.costoConGastos(1000, 100, 'precio'), null);
});

test('costoConGastos: modo desconocido se trata como "costo"', () => {
  assert.strictEqual(E.costoConGastos(1000, 5, undefined), 1050);
});

// ── Tablas de margen ─────────────────────────────────────────────────────────

const TABLA = { minPct: 30, maxPct: 60, escalones: 4, rango: { desde: 100, hasta: 10000 } };

test('quiebres: cortes logarítmicos y margen lineal de máx a mín', () => {
  // (10000/100)^(1/4) = 3.1623 → cortes 316.23, 1000, 3162.28
  assert.deepStrictEqual(E.quiebres(TABLA), [
    { hasta: 316.23, margenPct: 60 },
    { hasta: 1000, margenPct: 50 },
    { hasta: 3162.28, margenPct: 40 },
    { hasta: null, margenPct: 30 },
  ]);
});

test('quiebres: un solo escalón → todo al máximo', () => {
  assert.deepStrictEqual(E.quiebres({ ...TABLA, escalones: 1 }), [{ hasta: null, margenPct: 60 }]);
});

test('margenDe: busca el escalón por costo; fuera de rango va a los extremos', () => {
  assert.strictEqual(E.margenDe(TABLA, 5), 60);
  assert.strictEqual(E.margenDe(TABLA, 316.22), 60);
  assert.strictEqual(E.margenDe(TABLA, 316.23), 50);
  assert.strictEqual(E.margenDe(TABLA, 2000), 40);
  assert.strictEqual(E.margenDe(TABLA, 999999), 30);
});

test('ajustePesoPct: tramo por peso, sin peso = 1 kg, más pesado = último', () => {
  const aj = { tramosG: [100, 500, 1000, 5000], puntos: [10, 5, 0, -5] };
  assert.strictEqual(E.ajustePesoPct(aj, 80), 10);
  assert.strictEqual(E.ajustePesoPct(aj, 100), 10);
  assert.strictEqual(E.ajustePesoPct(aj, 250), 5);
  assert.strictEqual(E.ajustePesoPct(aj, null), 0);
  assert.strictEqual(E.ajustePesoPct(aj, 20000), -5);
  assert.strictEqual(E.ajustePesoPct(null, 250), 0);
  assert.strictEqual(E.ajustePesoPct({ tramosG: [], puntos: [] }, 250), 0);
});

test('rangoDesdeCostos: percentiles 5 y 95 (nearest-rank) de costos positivos', () => {
  const costos = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  assert.deepStrictEqual(E.rangoDesdeCostos(costos), { desde: 5, hasta: 95 });
  assert.deepStrictEqual(E.rangoDesdeCostos([0, -3, null, 'x', 10, 20]), { desde: 10, hasta: 20 });
  assert.strictEqual(E.rangoDesdeCostos([10]), null);
  assert.strictEqual(E.rangoDesdeCostos([7, 7, 7]), null); // desde == hasta: no hay rango
  assert.strictEqual(E.rangoDesdeCostos([]), null);
});

test('validarTablaMargen: acepta válida y rechaza cada caso inválido', () => {
  assert.strictEqual(E.validarTablaMargen(TABLA), null);
  assert.match(E.validarTablaMargen({ ...TABLA, minPct: 70 }), /mínimo/);
  assert.match(E.validarTablaMargen({ ...TABLA, maxPct: 'x' }), /máximo/);
  assert.match(E.validarTablaMargen({ ...TABLA, minPct: -60 }), /mínimo/);
  assert.match(E.validarTablaMargen({ ...TABLA, maxPct: 400 }), /máximo/);
  assert.match(E.validarTablaMargen({ ...TABLA, escalones: 0 }), /escalones/);
  assert.match(E.validarTablaMargen({ ...TABLA, escalones: 2.5 }), /escalones/);
  assert.match(E.validarTablaMargen({ ...TABLA, escalones: 31 }), /escalones/);
  assert.match(E.validarTablaMargen({ ...TABLA, rango: { desde: 0, hasta: 10 } }), /rango/);
  assert.match(E.validarTablaMargen({ ...TABLA, rango: { desde: 50, hasta: 50 } }), /rango/);
  assert.match(E.validarTablaMargen({ ...TABLA, rango: null }), /rango/);
  assert.match(E.validarTablaMargen(null), /tabla/);
});
