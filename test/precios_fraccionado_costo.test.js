'use strict';
const test = require('node:test');
const assert = require('node:assert');
const FC = require('../lib/precios_fraccionado_costo');

// Subrubro 7: 2 min/kg. Tramos: hasta 500 g +3, hasta 1000 g (base) 0, más -5.
const CF = FC.normalizarCosteoFraccionado({
  costoHora: 6000,
  maquinas: [{ id: 'env', nombre: 'Envasadora', costoHora: 3000 }],
  tramosTiempo: [{ hastaG: 500, minKg: 3 }, { hastaG: 1000, minKg: 0 }, { hastaG: 5000, minKg: -5 }],
  subrubros: { 7: { minKg: 2 } },
  insumosPorPeso: { 500: [{ plu: '900', cantidad: 1 }] },
});
const costoDe = plu => ({ 900: { costo: 20, nombre: 'Bolsa' } }[plu] || null);
const GRANEL = { plu: '100', subrubroId: '7' };
const costear = (pesoG, cf = CF, granel = GRANEL) => FC.costearPresentacion({ pesoG, granel, cf, costoDe });
const redondear = n => Math.round(n * 1e6) / 1e6;

test('normalizarCosteoFraccionado: defaults y mapas vacíos', () => {
  assert.deepStrictEqual(FC.normalizarCosteoFraccionado(undefined), {
    costoHora: null, maquinas: [], tramosTiempo: [], subrubros: {}, insumosPorPeso: {}, porGranel: {},
  });
});

test('normalizarCosteoFraccionado: los campos viejos se ignoran (escalas, facilidad, tramos y máquina del subrubro)', () => {
  const n = FC.normalizarCosteoFraccionado({
    escalas: { facilidad: { facil: 1 } }, factorFacilidad: 2, facilidades: { medio: 1.3 },
    subrubros: { 7: { maquinaId: 'env', tramos: [{ hastaG: 500, minutos: 1 }], facilidad: 'normal', tiempo: 'lento' }, 8: { minKg: 1.5, facilidad: 'facil' }, 9: { minKg: -1 } },
    porGranel: { 100: { maquinaId: 'env', facilidad: 'medio' }, 200: { minKg: 0 }, 300: { maquinaId: null }, 400: { minKg: 'x' } },
    tramosTiempo: [{ hastaG: 500, minKg: -2 }, { hastaG: 0, minKg: 1 }, { hastaG: 700 }],
    insumosPorPeso: { 500: [{ plu: '900', cantidad: 1 }], 0: [], abc: [], '0250': [], 250: 'x' },
  });
  assert.deepStrictEqual(n.subrubros, { 8: { minKg: 1.5 } });
  assert.deepStrictEqual(n.porGranel, { 100: { maquinaId: 'env' }, 200: { minKg: 0 } });
  assert.deepStrictEqual(n.tramosTiempo, [{ hastaG: 500, minKg: -2 }]);
  assert.deepStrictEqual(n.insumosPorPeso, { 500: [{ plu: '900', cantidad: 1 }] });
  assert.deepStrictEqual(['escalas' in n, 'factorFacilidad' in n], [false, false]);
});

test('tramoDe / ajusteDe: primer tramo que cubre el peso, arriba del último el último; tabla vacía → 0', () => {
  assert.deepStrictEqual([FC.ajusteDe(CF.tramosTiempo, 250), FC.ajusteDe(CF.tramosTiempo, 1000), FC.ajusteDe(CF.tramosTiempo, 9000)], [3, 0, -5]);
  assert.deepStrictEqual([FC.ajusteDe([], 500), FC.tramoDe(CF.tramosTiempo, null), FC.BASE_G], [0, null, 1000]);
});

test('pesoGDe: gramos enteros del peso del nombre; sin peso null', () => {
  assert.deepStrictEqual([FC.pesoGDe('Almendra 500G'), FC.pesoGDe('Nuez 1Kg'), FC.pesoGDe('Sal granel')], [500, 1000, null]);
});

test('costearPresentacion: (2 + 3) × 0,5 kg = 2,5 min; MO + insumos del peso, sin máquina ni aviso de máquina', () => {
  const r = costear(500);
  assert.deepStrictEqual([r.minKg, r.minKgOrigen, r.ajusteMinKg, r.minutos], [2, 'subrubro', 3, 2.5]);
  // MO 2,5 × 6000/60 = 250; bolsa 20
  assert.deepStrictEqual(r.lineas.map(l => [l.plu, l.rol, l.importe]), [['900', 'insumo', 20], ['_manoObra', 'mo', 250]]);
  assert.deepStrictEqual([r.porUnidad, r.extraKg, r.avisos, r.faltantes], [270, 540, [], []]);
  assert.strictEqual(r.extraKg, r.porUnidad / 0.5);
});

test('costearPresentacion: el min/kg propio del granel gana (y 0 también); vacío hereda', () => {
  const propio = { ...CF, porGranel: { 100: { minKg: 4 } } };
  assert.deepStrictEqual([costear(500, propio).minutos, costear(500, propio).minKgOrigen], [3.5, 'granel']); // (4+3)×0,5
  const cero = costear(500, { ...CF, porGranel: { 100: { minKg: 0 } } });
  assert.deepStrictEqual([cero.minKg, cero.minKgOrigen, cero.minutos], [0, 'granel', 1.5]); // max(0, 0+3)×0,5
  assert.strictEqual(costear(500, { ...CF, porGranel: { 100: { maquinaId: 'env' } } }).minKgOrigen, 'subrubro');
});

test('costearPresentacion: 4 bolsas de 250 g con +3 suman +3 min sobre la de 1 kg; ajuste negativo nunca baja de 0', () => {
  assert.strictEqual(redondear(4 * costear(250).minutos - costear(1000).minutos), 3);
  assert.strictEqual(costear(2000).minutos, 0); // max(0, 2 - 5)
});

test('costearPresentacion: sin min/kg → 0 min, sin líneas MO/máquina, aviso sinMinutos (el ajuste solo no genera minutos)', () => {
  const cf = { ...CF, porGranel: { 100: { maquinaId: 'env' } } };
  const r = costear(500, cf, { plu: '100', subrubroId: '99' });
  assert.deepStrictEqual([r.minKg, r.minutos, r.lineas.map(l => l.rol), r.avisos], [null, 0, ['insumo'], ['sinMinutos']]);
  assert.deepStrictEqual(costear(250, CF, { plu: '1', subrubroId: null }).avisos, ['sinMinutos', 'sinInsumos']);
});

test('costearPresentacion / maquinaDe: con máquina del granel, mismos minutos × costoHora ÷ 60', () => {
  const cf = { ...CF, porGranel: { 100: { maquinaId: 'env' } } };
  const r = costear(500, cf);
  assert.deepStrictEqual(r.lineas[2], { plu: '_maquina', nombre: 'Envasadora', rol: 'maquina', cantidad: 2.5, costoUnit: 3000, importe: 125 });
  assert.deepStrictEqual([r.porUnidad, r.avisos], [395, []]);
  assert.deepStrictEqual([FC.maquinaDe(cf, GRANEL), FC.maquinaDe(CF, GRANEL)], [CF.maquinas[0], null]);
  assert.strictEqual(FC.maquinaDe({ ...CF, porGranel: { 100: { maquinaId: 'otra' } } }, GRANEL), null);
});

test('costearPresentacion: sin costo hora → aviso costoHora (MO en 0)', () => {
  const r = costear(500, { ...CF, costoHora: null });
  assert.deepStrictEqual([r.avisos, r.lineas[1].importe], [['costoHora'], 0]);
});

test('costearPresentacion: insumo sin costo → faltante y sin costo (nunca 0); sin peso → sólo mercadería', () => {
  const r = costear(500, { ...CF, insumosPorPeso: { 500: [{ plu: '901', cantidad: 1 }] } });
  assert.deepStrictEqual([r.faltantes, r.porUnidad, r.extraKg], [['901'], null, null]);
  const s = costear(null);
  assert.deepStrictEqual([s.extraKg, s.minutos, s.avisos, s.minKg], [0, 0, ['sinPeso'], 2]);
});

test('costearPresentacion: el $/kg sale de la suma sin redondear (presentación de 10 g)', () => {
  const r = costear(10, { ...CF, insumosPorPeso: { 10: [{ plu: '900', cantidad: 1 }] } });
  // (2+3) × 0,01 = 0,05 min; MO 5; bolsa 20 → 25 ÷ 0,01 kg
  assert.deepStrictEqual([r.minutos, r.porUnidad, r.extraKg], [0.05, 25, 2500]);
});

test('plusInsumos: PLUs de los insumos por peso, sin repetir', () => {
  const cf = FC.normalizarCosteoFraccionado({ insumosPorPeso: { 250: [{ plu: '900', cantidad: 1 }],
    500: [{ plu: 900, cantidad: 2 }, { plu: '901', cantidad: 1 }] } });
  assert.deepStrictEqual(FC.plusInsumos(cf), ['900', '901']);
});

test('sumarExtraKg: suma a cada fuente; sin costo o extra null → null', () => {
  assert.deepStrictEqual(FC.sumarExtraKg({ sistema: 1000, ultimaCompra: null }, 240), { sistema: 1240, ultimaCompra: null });
  assert.deepStrictEqual(FC.sumarExtraKg({ sistema: 1000 }, null), { sistema: null });
});
