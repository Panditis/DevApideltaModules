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

// ── preciosCanales ───────────────────────────────────────────────────────────

const tabla = (minPct, maxPct) => ({ minPct, maxPct, escalones: 4, rango: { desde: 100, hasta: 10000 } });
const CFG = {
  ivaVentaPct: 21,
  modoGastos: 'costo',
  gastosVenta: [{ id: 'g', concepto: 'Flete', pct: 10, tipos: { almacen: true, fraccionado: true, produccion: true } }],
  extrasMinorista: [{ id: 'iibb', concepto: 'IIBB', pct: 5, tipos: { almacen: true, fraccionado: true, produccion: true } }],
  margenes: {
    almacen: { minorista: tabla(30, 60), pack: tabla(20, 40), bulto: tabla(10, 30) },
    fraccionado: { minorista: tabla(30, 60), pack: tabla(20, 40), bulto: tabla(10, 30),
      ajustesPeso: { tramosG: [100, 1000], puntos: [10, 0] } },
    produccion: { minorista: tabla(30, 60), pack: tabla(20, 40), bulto: tabla(10, 30) },
  },
  redondeo: { minorista: 50, packNeto: 0, packIva: 50, bultoNeto: 0, bultoIva: 50 },
};

test('preciosCanales Reventa: minorista con extras antes del IVA y redondeo a 50', () => {
  // costo 2000 → escalón índice 2 (≥1000, <3162.28): minorista 40 %, pack 26.67 %
  const p = E.preciosCanales({ tipo: 'almacen', costo: 2000, unidades: { pack: 6 }, cfg: CFG });
  assert.strictEqual(p.error, null);
  assert.strictEqual(p.gastosPct, 10);
  assert.strictEqual(p.costoConGastos, 2200);
  assert.deepStrictEqual(p.minorista, {
    margenPct: 40, neto: 3080, extrasPct: 5, conExtras: 3234, ivaPct: 21, exacto: 3913.14, precio: 3900,
  });
  assert.deepStrictEqual(p.pack, {
    margenPct: 26.67, netoUnidad: 2786.74, unidades: 6, exactoNeto: 16720.44, neto: 16720.44,
    exactoIva: 20231.73, conIva: 20250,
  });
  assert.strictEqual(p.bulto, null);
});

test('preciosCanales: pack y bulto NO dependen del precio minorista (solo comparten costo + gastos)', () => {
  const base = E.preciosCanales({ tipo: 'almacen', costo: 2000, unidades: { pack: 6 }, cfg: CFG });
  const otraMin = { ...CFG, margenes: { ...CFG.margenes, almacen: { ...CFG.margenes.almacen, minorista: tabla(80, 90) } } };
  const p = E.preciosCanales({ tipo: 'almacen', costo: 2000, unidades: { pack: 6 }, cfg: otraMin });
  assert.notStrictEqual(p.minorista.precio, base.minorista.precio);
  assert.deepStrictEqual(p.pack, base.pack);
});

test('preciosCanales: alinea con el vigente SIGA si difiere menos de $0,50', () => {
  const p = E.preciosCanales({ tipo: 'almacen', costo: 2000, unidades: { pack: 6 },
    vigentes: { minorista: 3913, pack: 20231.5 }, cfg: CFG });
  assert.strictEqual(p.minorista.precio, 3913);
  assert.strictEqual(p.pack.conIva, 20231.5);
});

test('preciosCanales Fraccionado: escalón por costo/kg del granel + ajuste por peso', () => {
  // costoMargen 2000 $/kg → minorista 40 % + ajuste tramo ≤100 g (+10) = 50 %
  const p = E.preciosCanales({ tipo: 'fraccionado', costo: 200, costoMargen: 2000, pesoG: 100, cfg: CFG });
  assert.strictEqual(p.minorista.margenPct, 50);
  assert.strictEqual(p.costoConGastos, 220);
  assert.strictEqual(p.minorista.neto, 330);
});

test('preciosCanales: gastos solo del tipo y modo "precio"', () => {
  const cfg = { ...CFG, modoGastos: 'precio',
    gastosVenta: [{ id: 'g', concepto: 'x', pct: 20, tipos: { almacen: false, produccion: true } }] };
  assert.strictEqual(E.preciosCanales({ tipo: 'almacen', costo: 2000, cfg }).costoConGastos, 2000);
  assert.strictEqual(E.preciosCanales({ tipo: 'produccion', costo: 2000, cfg }).costoConGastos, 2500);
});

test('preciosCanales: errores de costo, gastos y tabla inválida', () => {
  assert.strictEqual(E.preciosCanales({ tipo: 'almacen', costo: 0, cfg: CFG }).error, 'costo');
  assert.strictEqual(E.preciosCanales({ tipo: 'almacen', costo: null, cfg: CFG }).error, 'costo');
  const g100 = { ...CFG, modoGastos: 'precio',
    gastosVenta: [{ id: 'g', concepto: 'x', pct: 100, tipos: { almacen: true } }] };
  assert.strictEqual(E.preciosCanales({ tipo: 'almacen', costo: 2000, cfg: g100 }).error, 'gastos');
  const rota = { ...CFG, margenes: { ...CFG.margenes, almacen: { ...CFG.margenes.almacen, bulto: { minPct: 1 } } } };
  const r = E.preciosCanales({ tipo: 'almacen', costo: 2000, cfg: rota });
  assert.strictEqual(r.error, 'margen');
  assert.strictEqual(r.minorista, null);
});

test('UMD: sin module, se publica como global PreciosEsquema', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const src = fs.readFileSync(path.join(__dirname, '../lib/precios_esquema.js'), 'utf8');
  const ctx = { self: {} };
  vm.runInNewContext(src, ctx);
  assert.strictEqual(typeof ctx.self.PreciosEsquema.preciosCanales, 'function');
});
