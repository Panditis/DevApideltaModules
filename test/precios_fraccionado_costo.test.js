'use strict';
const test = require('node:test');
const assert = require('node:assert');
const FC = require('../lib/precios_fraccionado_costo');

// Costo hora 6000 ($100/min), envasadora 3000 ($50/min). Granel 100 "medio" (× 1,25) con la envasadora, subrubro 7.
const CF = FC.normalizarCosteoFraccionado({
  costoHora: 6000,
  maquinas: [{ id: 'envasadora', nombre: 'Envasadora', costoHora: 3000 }],
  tiempos: [{ hastaG: 250, minutos: 0.5 }, { hastaG: 1000, minutos: 1 }],
  insumosSubrubro: { 7: [
    { hastaG: 500, insumos: [{ plu: '900', cantidad: 1 }] },
    { hastaG: 5000, insumos: [{ plu: '901', cantidad: 1 }, { plu: '902', cantidad: 2 }] },
  ] },
  porGranel: { 100: { facilidad: 'medio', maquinaId: 'envasadora' } },
  insumosPresentacion: { 103: [{ plu: '902', cantidad: 3 }] },
});
const COSTOS = { 900: 20, 901: 40, 902: 5 };
const costoDe = plu => (plu in COSTOS ? { costo: COSTOS[plu], nombre: `Insumo ${plu}` } : null);
const GRANEL = { plu: '100', subrubroId: '7' };

test('normalizarCosteoFraccionado: sin dato → listas vacías, costo hora null y facilidades por defecto', () => {
  assert.deepStrictEqual(FC.normalizarCosteoFraccionado(undefined), {
    costoHora: null, maquinas: [], tiempos: [], facilidades: { facil: 1, medio: 1.25, dificil: 1.5 },
    insumosSubrubro: {}, porGranel: {}, insumosPresentacion: {},
  });
  assert.strictEqual(FC.normalizarCosteoFraccionado({ facilidades: { medio: 2 } }).facilidades.medio, 2);
});

test('tramoDe: primer tramo que cubre el peso (borde incluido), arriba del último → el último, sin tramos o peso → null', () => {
  const ts = [{ hastaG: 250 }, { hastaG: 1000 }];
  assert.strictEqual(FC.tramoDe(ts, 250).hastaG, 250);
  assert.strictEqual(FC.tramoDe(ts, 251).hastaG, 1000);
  assert.strictEqual(FC.tramoDe(ts, 5000).hastaG, 1000);
  assert.strictEqual(FC.tramoDe([], 500), null);
  assert.strictEqual(FC.tramoDe(ts, null), null);
});

test('costearPresentacion: 500 g → insumos de la regla + MO + máquina con minutos × factor, a $/kg', () => {
  const r = FC.costearPresentacion({ plu: '101', pesoG: 500, granel: GRANEL, cf: CF, costoDe });
  // minutos = 1 (tramo 1000 g) × 1,25 = 1,25 → MO 125, máquina 62,5; insumo 900 = 20 → 207,5 por unidad ÷ 0,5 kg = 415
  assert.strictEqual(r.minutos, 1.25);
  assert.deepStrictEqual([r.minutosBase, r.factor], [1, 1.25]); // minutos = base del tramo × factor de la facilidad
  assert.deepStrictEqual(r.lineas.map(l => [l.plu, l.rol, l.importe]), [['900', 'insumo', 20], ['_manoObra', 'mo', 125], ['_maquina', 'maquina', 62.5]]);
  assert.deepStrictEqual([r.porUnidad, r.extraKg, r.origenInsumos, r.avisos, r.faltantes], [207.5, 415, 'regla', [], []]);
});

test('costearPresentacion: pesos chicos y grandes toman su tramo de tiempo y de insumos', () => {
  // 50 g: 0,5 min × 1,25 = 0,625 → MO 62,5 + máquina 31,25 + insumo 20 = 113,75 ÷ 0,05 kg = 2275
  assert.deepStrictEqual(FC.costearPresentacion({ plu: '104', pesoG: 50, granel: GRANEL, cf: CF, costoDe }).extraKg, 2275);
  // 2000 g: tiempo del último tramo (1 min × 1,25); insumos del tramo 5000 g: 40 + 2 × 5 = 50 → 125 + 62,5 + 50 = 237,5
  const r = FC.costearPresentacion({ plu: '105', pesoG: 2000, granel: GRANEL, cf: CF, costoDe });
  assert.deepStrictEqual([r.porUnidad, r.extraKg], [237.5, 118.75]);
});

test('costearPresentacion: los insumos propios de la presentación REEMPLAZAN a la regla', () => {
  const r = FC.costearPresentacion({ plu: '103', pesoG: 1000, granel: GRANEL, cf: CF, costoDe });
  assert.deepStrictEqual(r.lineas.filter(l => l.rol === 'insumo').map(l => [l.plu, l.cantidad, l.importe]), [['902', 3, 15]]);
  assert.deepStrictEqual([r.origenInsumos, r.porUnidad], ['propios', 202.5]);
});

test('costearPresentacion: insumo sin costo → faltante, sin costo por unidad ni $/kg (nunca 0)', () => {
  const r = FC.costearPresentacion({ plu: '101', pesoG: 500, granel: GRANEL, cf: CF, costoDe: () => null });
  assert.deepStrictEqual([r.faltantes, r.porUnidad, r.extraKg], [['900'], null, null]);
});

test('costearPresentacion: lo que falta en el granel o en la config va en 0 con su aviso', () => {
  // Granel 200 sin facilidad ni máquina, subrubro 8 sin regla: factor 1 → 1 min → sólo MO 100
  const r = FC.costearPresentacion({ plu: '201', pesoG: 500, granel: { plu: '200', subrubroId: '8' }, cf: CF, costoDe });
  assert.deepStrictEqual([r.avisos, r.porUnidad, r.extraKg], [['sinFacilidad', 'sinMaquina', 'sinInsumos'], 100, 200]);
  assert.deepStrictEqual([r.minutosBase, r.factor], [1, 1]); // sin facilidad: factor 1
  // Config vacía: sin tiempos no hay minutos (ni MO ni máquina ni aviso de costo hora)
  const vacia = FC.costearPresentacion({ plu: '201', pesoG: 500, granel: GRANEL, cf: FC.normalizarCosteoFraccionado({}), costoDe });
  assert.deepStrictEqual([vacia.avisos, vacia.porUnidad], [['sinFacilidad', 'sinTiempos', 'sinMaquina', 'sinInsumos'], 0]);
  assert.deepStrictEqual([vacia.minutosBase, vacia.factor, vacia.minutos], [0, 1, 0]);
  // Con tiempos y sin costo hora: MO en 0 + aviso costoHora
  const sinHora = FC.costearPresentacion({ plu: '101', pesoG: 500, granel: GRANEL, cf: { ...CF, costoHora: null }, costoDe });
  assert.ok(sinHora.avisos.includes('costoHora'));
  assert.strictEqual(sinHora.lineas.find(l => l.rol === 'mo').importe, 0);
});

test('costearPresentacion: sin peso en el nombre → sólo mercadería (extra 0) con aviso sinPeso', () => {
  const r = FC.costearPresentacion({ plu: '106', pesoG: null, granel: GRANEL, cf: CF, costoDe });
  assert.deepStrictEqual([r.avisos, r.lineas, r.extraKg], [['sinPeso'], [], 0]);
  assert.deepStrictEqual([r.minutosBase, r.factor], [0, 1]);
});

test('sumarExtraKg: suma el extra a cada fuente con costo; extra null (faltante) → ninguna', () => {
  assert.deepStrictEqual(FC.sumarExtraKg({ sistema: 1000, ultimaCompra: null, manual: 1200 }, 415), { sistema: 1415, ultimaCompra: null, manual: 1615 });
  assert.deepStrictEqual(FC.sumarExtraKg({ sistema: 1000, ultimaCompra: 900, manual: null }, null), { sistema: null, ultimaCompra: null, manual: null });
});

test('plusInsumos: PLUs de reglas y de propios, sin repetir', () => {
  assert.deepStrictEqual(FC.plusInsumos(CF).sort(), ['900', '901', '902']);
});

test('costearPresentacion: extraKg sale de la suma SIN redondear (presentaciones chicas no amplifican el redondeo)', () => {
  // 10 g, insumo 1,234: sin redondear = 1,234 + MO 62,5 + máquina 31,25 = 94,984 → ÷ 0,01 kg = 9498,4 (con redondeo previo daba 9498)
  const r = FC.costearPresentacion({ plu: '107', pesoG: 10, granel: GRANEL, cf: CF, costoDe: plu => (plu === '900' ? { costo: 1.234, nombre: 'Bolsita' } : null) });
  assert.deepStrictEqual([r.porUnidad, r.extraKg], [94.98, 9498.4]);
  assert.strictEqual(r.lineas[0].importe, 1.23);
});

test('costearPresentacion: costo de insumo que llega como texto se convierte; no numérico o ≤ 0 → faltante', () => {
  const con = costo => FC.costearPresentacion({ plu: '101', pesoG: 500, granel: GRANEL, cf: CF, costoDe: () => ({ costo, nombre: 'X' }) });
  const ok = con('20');
  assert.strictEqual(ok.lineas[0].costoUnit, 20);
  assert.deepStrictEqual([ok.lineas[0].importe, ok.porUnidad], [20, 207.5]);
  for (const malo of ['abc', '', null, 0, '0', -5, Infinity]) assert.deepStrictEqual([con(malo).faltantes, con(malo).extraKg], [['900'], null], `costo ${String(malo)}`);
});
