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

test('generarAjustesPeso: cortes log con extremos exactos, % lineal a 1 decimal', () => {
  const g = E.generarAjustesPeso({ desdeG: 100, hastaG: 5000, tramos: 6, livianoPct: 15, pesadoPct: -10 });
  assert.deepStrictEqual(g, { tramosG: [100, 220, 480, 1050, 2300, 5000], puntos: [15, 10, 5, 0, -5, -10] });
  const h = E.generarAjustesPeso({ desdeG: 100, hastaG: 200, tramos: 20, livianoPct: 15, pesadoPct: -10 });
  assert.strictEqual(h.tramosG.length, 20);
  assert.ok(h.tramosG.every((t, i) => i === 0 || t > h.tramosG[i - 1]), 'ascendentes y únicos');
  assert.deepStrictEqual([h.tramosG[0], h.tramosG[19], h.puntos[0], h.puntos[19], h.puntos[1]], [100, 200, 15, -10, 13.7]);
  assert.ok(h.puntos.every(p => Number.isInteger(p * 10)));
});

test('generarAjustesPeso: entrada inválida → null', () => {
  const ok = { desdeG: 100, hastaG: 5000, tramos: 6, livianoPct: 15, pesadoPct: -10 };
  [{ desdeG: 0 }, { hastaG: 100 }, { tramos: 1 }, { tramos: 21 }, { tramos: 2.5 }, { livianoPct: 101 }, { pesadoPct: NaN },
    { desdeG: '100' }, { desdeG: 1, hastaG: 3, tramos: 10 }].forEach(m => assert.strictEqual(E.generarAjustesPeso({ ...ok, ...m }), null, JSON.stringify(m)));
  assert.strictEqual(E.generarAjustesPeso(), null);
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
  assert.match(E.validarTablaMargen({ ...TABLA, maxPct: 'x' }), /mayor a −100 %/);
  assert.match(E.validarTablaMargen({ ...TABLA, minPct: NaN }), /mayor a −100 %/);
  assert.match(E.validarTablaMargen({ ...TABLA, minPct: -100 }), /mayor a −100 %/);
  assert.match(E.validarTablaMargen({ ...TABLA, minPct: -150, maxPct: -120 }), /mayor a −100 %/);
  // Sin tope superior y con piso estricto en −100: −60 y 400 ya valen, −99,9 y 5000 también.
  assert.strictEqual(E.validarTablaMargen({ ...TABLA, minPct: -60, maxPct: 400 }), null);
  assert.strictEqual(E.validarTablaMargen({ ...TABLA, minPct: -99.9, maxPct: 5000 }), null);
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
  margenes: { minorista: tabla(30, 60), pack: tabla(20, 40), bulto: tabla(10, 30),
    ajustesPeso: { tramosG: [100, 1000], puntos: [10, 0] } },
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
  const otraMin = { ...CFG, margenes: { ...CFG.margenes, minorista: tabla(80, 90) } };
  const p = E.preciosCanales({ tipo: 'almacen', costo: 2000, unidades: { pack: 6 }, cfg: otraMin });
  assert.notStrictEqual(p.minorista.precio, base.minorista.precio);
  assert.deepStrictEqual(p.pack, base.pack);
});

test('preciosCanales: alinea con el vigente SIGA si difiere menos de $0,50 (pack/bulto: contra el neto)', () => {
  const vigPack = E.r2(E.preciosCanales({ tipo: 'almacen', costo: 2000, unidades: { pack: 6 }, cfg: CFG }).pack.exactoNeto + 0.3);
  const p = E.preciosCanales({ tipo: 'almacen', costo: 2000, unidades: { pack: 6 },
    vigentes: { minorista: 3913, pack: vigPack }, cfg: CFG });
  assert.strictEqual(p.minorista.precio, 3913);
  assert.strictEqual(p.pack.neto, vigPack);
});

test('preciosCanales Fraccionado: escalón por costo/kg del granel + ajuste por peso', () => {
  // costoMargen 2000 $/kg → minorista 40 % + ajuste tramo ≤100 g (+10) = 50 %
  const p = E.preciosCanales({ tipo: 'fraccionado', costo: 200, costoMargen: 2000, pesoG: 100, cfg: CFG });
  assert.strictEqual(p.minorista.margenPct, 50);
  assert.strictEqual(p.costoConGastos, 220);
  assert.strictEqual(p.minorista.neto, 330);
});

test('preciosCanales: las mismas 3 tablas (una por canal) para los tres tipos; ajuste por peso sólo en Fraccionado', () => {
  const sinGastos = { ...CFG, gastosVenta: [], extrasMinorista: [] };
  const alm = E.preciosCanales({ tipo: 'almacen', costo: 2000, pesoG: 100, unidades: { pack: 1 }, cfg: sinGastos });
  const prod = E.preciosCanales({ tipo: 'produccion', costo: 2000, pesoG: 100, unidades: { pack: 1 }, cfg: sinGastos });
  assert.deepStrictEqual(prod, alm);
  assert.deepStrictEqual([alm.minorista.margenPct, alm.pack.margenPct], [40, 26.67]);
  assert.strictEqual(E.preciosCanales({ tipo: 'fraccionado', costo: 2000, pesoG: 100, cfg: sinGastos }).minorista.margenPct, 50);
});

test('preciosCanales: margenExtra (margen especial de Producción) se suma al margen de cada canal y viaja aparte', () => {
  const sinGastos = { ...CFG, gastosVenta: [], extrasMinorista: [] };
  const base = E.preciosCanales({ tipo: 'produccion', costo: 2000, unidades: { pack: 1, bulto: 1 }, cfg: sinGastos });
  const p = E.preciosCanales({ tipo: 'produccion', costo: 2000, unidades: { pack: 1, bulto: 1 }, cfg: sinGastos,
    margenExtra: { minorista: 5, pack: -2.5 } });
  assert.deepStrictEqual([p.minorista.margenPct, p.pack.margenPct, p.bulto.margenPct],
    [base.minorista.margenPct + 5, E.r2(base.pack.margenPct - 2.5), base.bulto.margenPct]);
  assert.deepStrictEqual([p.minorista.margenEspecialPct, p.pack.margenEspecialPct, 'margenEspecialPct' in p.bulto], [5, -2.5, false]);
  assert.strictEqual(p.minorista.neto, 2000 * 1.45);
  // Sin margenExtra (o null): igual que siempre, sin margenEspecialPct.
  assert.deepStrictEqual(E.preciosCanales({ tipo: 'produccion', costo: 2000, unidades: { pack: 1, bulto: 1 }, cfg: sinGastos, margenExtra: null }), base);
  assert.ok(!('margenEspecialPct' in base.minorista));
});

test('preciosCanales: margenProducto modo ajuste (o sin modo, dato viejo) suma puntos encima; modo fijo reemplaza el margen del canal', () => {
  const sinGastos = { ...CFG, gastosVenta: [], extrasMinorista: [] };
  const canales = (tipo, extra = {}) => E.preciosCanales({ tipo, costo: 2000, pesoG: 100, unidades: { pack: 1, bulto: 1 }, cfg: sinGastos, ...extra });
  const base = canales('almacen');
  // Ajuste (con o sin modo): +10 en minorista, informa modo y puntos.
  for (const mp of [{ minorista: 10 }, { modo: 'ajuste', minorista: 10 }]) {
    const a = canales('almacen', { margenProducto: mp });
    assert.deepStrictEqual([a.minorista.margenPct, a.minorista.margenProductoPct, a.minorista.margenProductoModo], [base.minorista.margenPct + 10, 10, 'ajuste']);
    assert.ok(!('margenProductoModo' in a.pack));
  }
  // Fijo: el valor ES el margen (0 vale); canal vacío → margen general; informa el general reemplazado.
  const f = canales('almacen', { margenProducto: { modo: 'fijo', minorista: 55, bulto: 0 } });
  assert.deepStrictEqual([f.minorista.margenPct, f.minorista.margenProductoPct, f.minorista.margenProductoModo, f.minorista.margenGeneralPct],
    [55, 55, 'fijo', base.minorista.margenPct]);
  assert.deepStrictEqual([f.bulto.margenPct, f.bulto.margenProductoModo, f.bulto.margenGeneralPct], [0, 'fijo', base.bulto.margenPct]);
  assert.deepStrictEqual(f.pack, base.pack); // vacío: el general, sin marcas
  assert.strictEqual(f.minorista.neto, 2000 * 1.55);
  // Fraccionado: el fijo ignora el ajuste por peso (100 g → +10 en el general).
  const fr = canales('fraccionado', { margenProducto: { modo: 'fijo', minorista: 55 } });
  assert.deepStrictEqual([fr.minorista.margenPct, fr.minorista.margenGeneralPct], [55, 50]);
  // Producción: el fijo ignora el margen especial (no informa margenEspecialPct en ese canal); el general lo incluye.
  const pr = canales('produccion', { margenExtra: { minorista: 5, pack: 5 }, margenProducto: { modo: 'fijo', minorista: 55 } });
  assert.deepStrictEqual([pr.minorista.margenPct, pr.minorista.margenGeneralPct, 'margenEspecialPct' in pr.minorista], [55, base.minorista.margenPct + 5, false]);
  assert.deepStrictEqual([pr.pack.margenPct, pr.pack.margenEspecialPct], [E.r2(base.pack.margenPct + 5), 5]);
});

// margenParaPrecio: el margen fijo que, puesto en margenProducto, hace que el precio del canal sea el vigente de SIGA.
test('margenParaPrecio: ida y vuelta — el margen fijo devuelto reproduce el vigente en minorista, pack y bulto', () => {
  const vigentes = { minorista: 3990, pack: 21000, bulto: 39530 }; // ninguno es múltiplo "natural" del redondeo
  const unidades = { pack: 6, bulto: 12 };
  for (const tipo of ['almacen', 'fraccionado', 'produccion']) {
    const mp = { modo: 'fijo' };
    for (const canal of ['minorista', 'pack', 'bulto']) {
      mp[canal] = E.margenParaPrecio({ tipo, canal, costo: 2000, precioObjetivo: vigentes[canal], unidades: unidades[canal], cfg: CFG });
      assert.ok(typeof mp[canal] === 'number', `${tipo} ${canal}`);
    }
    const p = E.preciosCanales({ tipo, costo: 2000, pesoG: 100, unidades, vigentes, cfg: CFG, margenExtra: { minorista: 7 }, margenProducto: mp });
    assert.deepStrictEqual([p.minorista.precio, p.pack.neto, p.bulto.neto], [3990, 21000, 39530], tipo); // pack/bulto: vigente SIN IVA
  }
  // 2 decimales cuando alcanza (costo 2200 con gastos, extras 5 %, IVA 21 %).
  assert.strictEqual(E.margenParaPrecio({ tipo: 'almacen', canal: 'minorista', costo: 2000, precioObjetivo: 3913.14, cfg: CFG }), 40);
});

test('margenParaPrecio: precios altos (más decimales si 2 no alcanzan) y gastos en modo "precio"', () => {
  const vig = 987654;
  const m = E.margenParaPrecio({ tipo: 'almacen', canal: 'minorista', costo: 2000, precioObjetivo: vig, cfg: CFG });
  const p = E.preciosCanales({ tipo: 'almacen', costo: 2000, vigentes: { minorista: vig }, cfg: CFG, margenProducto: { modo: 'fijo', minorista: m } });
  assert.strictEqual(p.minorista.precio, vig);
  const cfgP = { ...CFG, modoGastos: 'precio' };
  const mp = E.margenParaPrecio({ tipo: 'almacen', canal: 'pack', costo: 2000, precioObjetivo: 20010, unidades: 6, cfg: cfgP });
  const pp = E.preciosCanales({ tipo: 'almacen', costo: 2000, unidades: { pack: 6 }, vigentes: { pack: 20010 }, cfg: cfgP, margenProducto: { modo: 'fijo', pack: mp } });
  assert.strictEqual(pp.costoConGastos, 2222.22);
  assert.strictEqual(pp.pack.neto, 20010);
});

test('margenParaPrecio: entrada inválida → null', () => {
  const ok = { tipo: 'almacen', canal: 'minorista', costo: 2000, precioObjetivo: 3990, cfg: CFG };
  assert.strictEqual(E.margenParaPrecio({ ...ok, costo: 0 }), null);
  assert.strictEqual(E.margenParaPrecio({ ...ok, precioObjetivo: null }), null);
  assert.strictEqual(E.margenParaPrecio({ ...ok, precioObjetivo: -5 }), null);
  assert.strictEqual(E.margenParaPrecio({ ...ok, canal: 'otro' }), null);
  assert.strictEqual(E.margenParaPrecio({ ...ok, canal: 'pack' }), null); // sin unidades
  const g100 = { ...CFG, modoGastos: 'precio', gastosVenta: [{ id: 'g', concepto: 'x', pct: 100, tipos: { almacen: true } }] };
  assert.strictEqual(E.margenParaPrecio({ ...ok, cfg: g100 }), null);
  assert.strictEqual(E.margenParaPrecio(), null);
});

test('preciosCanales: gastos solo del tipo y modo "precio"', () => {
  const cfg = { ...CFG, modoGastos: 'precio',
    gastosVenta: [{ id: 'g', concepto: 'x', pct: 20, tipos: { almacen: false, produccion: true } }] };
  assert.strictEqual(E.preciosCanales({ tipo: 'almacen', costo: 2000, cfg }).costoConGastos, 2000);
  assert.strictEqual(E.preciosCanales({ tipo: 'produccion', costo: 2000, cfg }).costoConGastos, 2500);
});

test('preciosCanales: errores de costo, gastos y tabla inválida', () => {
  assert.strictEqual(E.preciosCanales({ tipo: 'almacen', costo: 0, cfg: CFG }).error, 'costo');
  assert.strictEqual(E.preciosCanales({ tipo: 'almacen', costo: 2000 }).error, 'margen'); // sin cfg: error, no TypeError
  assert.strictEqual(E.preciosCanales({ tipo: 'almacen', costo: null, cfg: CFG }).error, 'costo');
  const g100 = { ...CFG, modoGastos: 'precio',
    gastosVenta: [{ id: 'g', concepto: 'x', pct: 100, tipos: { almacen: true } }] };
  assert.strictEqual(E.preciosCanales({ tipo: 'almacen', costo: 2000, cfg: g100 }).error, 'gastos');
  const rota = { ...CFG, margenes: { ...CFG.margenes, bulto: { minPct: 1 } } };
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

// ── Descuento al margen para distribuidores (cfg.margenes.descuentoDistribuidorPct) ──
// Fixture común: margen plano 30 % en los 3 canales, gastos 10 % (costo 1000 → con gastos 1100).
const FIX = require('./precios_esquema_fixture').CFG;
test('preciosCanales: descuento distribuidor resta puntos al margen de los 3 canales, sólo Reventa con distribuidor', () => {
  const cfg = { ...FIX, margenes: { ...FIX.margenes, descuentoDistribuidorPct: 5 } };
  const canales = (extra = {}) => E.preciosCanales({ tipo: 'almacen', costo: 1000, unidades: { pack: 1, bulto: 1 }, cfg, ...extra });
  const d = canales({ distribuidor: true });
  for (const c of ['minorista', 'pack', 'bulto']) assert.deepStrictEqual([d[c].margenPct, d[c].descuentoDistribuidorPct], [25, 5], c);
  assert.strictEqual(d.minorista.neto, 1375); // 1100 × 1,25: después siguen extras, IVA y redondeo
  // Directo / sin clasificar, u otros tipos con distribuidor: sin descuento ni marca.
  for (const p of [canales(), canales({ distribuidor: false }),
    E.preciosCanales({ tipo: 'fraccionado', costo: 1000, pesoG: 1000, unidades: { pack: 1 }, cfg, distribuidor: true }),
    E.preciosCanales({ tipo: 'produccion', costo: 1000, unidades: { pack: 1 }, cfg, distribuidor: true })]) {
    assert.deepStrictEqual([p.minorista.margenPct, 'descuentoDistribuidorPct' in p.minorista, 'descuentoDistribuidorPct' in p.pack], [30, false, false]);
  }
  // Sin descuento configurado (o 0): nada cambia.
  assert.deepStrictEqual(E.preciosCanales({ tipo: 'almacen', costo: 1000, cfg: FIX, distribuidor: true }), E.preciosCanales({ tipo: 'almacen', costo: 1000, cfg: FIX }));
});

test('preciosCanales: descuento distribuidor después del ajuste del producto; el fijo no lo lleva; margen resultante ≤ −100 → error margen', () => {
  const cfg = { ...FIX, margenes: { ...FIX.margenes, descuentoDistribuidorPct: 5 } };
  const p = E.preciosCanales({ tipo: 'almacen', costo: 1000, unidades: { pack: 1 }, cfg, distribuidor: true,
    margenProducto: { modo: 'ajuste', minorista: 20, pack: -3 } });
  assert.deepStrictEqual([p.minorista.margenPct, p.minorista.margenProductoPct, p.minorista.descuentoDistribuidorPct], [45, 20, 5]);
  assert.strictEqual(p.pack.margenPct, 22);
  const f = E.preciosCanales({ tipo: 'almacen', costo: 1000, unidades: { pack: 1 }, cfg, distribuidor: true, margenProducto: { modo: 'fijo', minorista: 50 } });
  assert.deepStrictEqual([f.minorista.margenPct, 'descuentoDistribuidorPct' in f.minorista, f.minorista.margenGeneralPct], [50, false, 30]);
  assert.deepStrictEqual([f.pack.margenPct, f.pack.descuentoDistribuidorPct], [25, 5]); // canal sin fijo: general − descuento
  const malo = E.preciosCanales({ tipo: 'almacen', costo: 1000, cfg: { ...FIX, margenes: { ...FIX.margenes, descuentoDistribuidorPct: 130 } }, distribuidor: true });
  assert.strictEqual(malo.error, 'margen');
});

test('margenParaPrecio: el fijo de "Igualar a SIGA" reproduce el vigente también en un distribuidor (el fijo no lleva descuento)', () => {
  const cfg = { ...FIX, margenes: { ...FIX.margenes, descuentoDistribuidorPct: 5 } };
  const vigentes = { minorista: 3990, pack: 21000, bulto: 39530 };
  const unidades = { pack: 6, bulto: 12 };
  const mp = { modo: 'fijo' };
  for (const canal of ['minorista', 'pack', 'bulto']) mp[canal] = E.margenParaPrecio({ tipo: 'almacen', canal, costo: 2000, precioObjetivo: vigentes[canal], unidades: unidades[canal], cfg });
  const p = E.preciosCanales({ tipo: 'almacen', costo: 2000, unidades, vigentes, cfg, distribuidor: true, margenProducto: mp });
  assert.deepStrictEqual([p.minorista.precio, p.pack.neto, p.bulto.neto], [3990, 21000, 39530]);
});

// El vigente de SIGA de pack/bulto es el precio SIN IVA: el neto se alinea con él y el con IVA sólo se redondea.
// Fixture: costo 1000 → neto 1430 (sin redondeo comercial) / con IVA exacto 1730,30 (paso 50 → 1750).
test('preciosCanales: el vigente de pack/bulto alinea el neto (no el con IVA)', () => {
  const base = { tipo: 'almacen', costo: 1000, unidades: { bulto: 1 }, cfg: FIX };
  const sinIva = E.preciosCanales({ ...base, vigentes: { bulto: 1430.3 } }).bulto;
  assert.deepStrictEqual([sinIva.neto, sinIva.conIva], [1430.3, 1750]);
  const cercaDelConIva = E.preciosCanales({ ...base, vigentes: { bulto: 1730.3 } }).bulto; // ya no alinea el con IVA
  assert.deepStrictEqual([cercaDelConIva.neto, cercaDelConIva.conIva], [1430, 1750]);
});

test('margenParaPrecio pack/bulto: el objetivo es el precio SIN IVA (ida y vuelta contra el neto)', () => {
  const m = E.margenParaPrecio({ tipo: 'almacen', canal: 'pack', costo: 1000, precioObjetivo: 8580, unidades: 6, cfg: FIX });
  assert.strictEqual(m, 30); // 1100 × 1,30 × 6 = 8580 sin IVA
});
