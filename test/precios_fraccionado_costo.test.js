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
  envasePorPeso: { 500: { bolsaPlu: '900' } },
});
const costoDe = plu => ({ 900: { costo: 20, nombre: 'Bolsa' } }[plu] || null);
const GRANEL = { plu: '100', subrubroId: '7' };
const costear = (pesoG, cf = CF, granel = GRANEL) => FC.costearPresentacion({ pesoG, granel, cf, costoDe });
const redondear = n => Math.round(n * 1e6) / 1e6;

test('normalizarCosteoFraccionado: defaults y mapas vacíos', () => {
  assert.deepStrictEqual(FC.normalizarCosteoFraccionado(undefined), {
    costoHora: null, maquinas: [], tramosTiempo: [], subrubros: {}, envasePorPeso: {}, costoBobinaKg: null, porGranel: {},
  });
});

test('normalizarCosteoFraccionado: los campos viejos se ignoran (escalas, facilidad, tramos y máquina del subrubro)', () => {
  const n = FC.normalizarCosteoFraccionado({
    escalas: { facilidad: { facil: 1 } }, factorFacilidad: 2, facilidades: { medio: 1.3 },
    subrubros: { 7: { maquinaId: 'env', tramos: [{ hastaG: 500, minutos: 1 }], facilidad: 'normal', tiempo: 'lento' }, 8: { minKg: 1.5, facilidad: 'facil' }, 9: { minKg: -1 } },
    porGranel: { 100: { maquinaId: 'env', facilidad: 'medio' }, 200: { minKg: 0 }, 300: { maquinaId: null }, 400: { minKg: 'x' } },
    tramosTiempo: [{ hastaG: 500, minKg: -2 }, { hastaG: 0, minKg: 1 }, { hastaG: 700 }],
    envasePorPeso: { 500: { bolsaPlu: 900, bobinaG: 8 }, 0: { bolsaPlu: '1' }, abc: { bobinaG: 1 }, '0250': { bolsaPlu: '1' }, 250: 'x', 750: { bolsaPlu: 'abc', bobinaG: 0 } },
    insumosPorPeso: { 500: [{ plu: '900', cantidad: 1 }] }, costoBobinaKg: 0,
  });
  assert.deepStrictEqual(n.subrubros, { 8: { minKg: 1.5 } });
  assert.deepStrictEqual(n.porGranel, { 100: { maquinaId: 'env' }, 200: { minKg: 0 } });
  assert.deepStrictEqual(n.tramosTiempo, [{ hastaG: 500, minKg: -2 }]);
  assert.deepStrictEqual([n.envasePorPeso, n.costoBobinaKg, 'insumosPorPeso' in n], [{ 500: { bolsaPlu: '900', bobinaG: 8 } }, null, false]);
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
  assert.deepStrictEqual(costear(250, CF, { plu: '1', subrubroId: null }).avisos, ['sinMinutos', 'sinBolsa']);
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

test('costearPresentacion: bolsa sin costo → faltante y sin costo (nunca 0); sin peso → sólo mercadería', () => {
  const r = costear(500, { ...CF, envasePorPeso: { 500: { bolsaPlu: '901' } } });
  assert.deepStrictEqual([r.faltantes, r.porUnidad, r.extraKg], [['901'], null, null]);
  const s = costear(null);
  assert.deepStrictEqual([s.extraKg, s.minutos, s.avisos, s.minKg], [0, 0, ['sinPeso'], 2]);
});

test('costearPresentacion: el $/kg sale de la suma sin redondear (presentación de 10 g)', () => {
  const r = costear(10, { ...CF, envasePorPeso: { 10: { bolsaPlu: '900' } } });
  // (2+3) × 0,01 = 0,05 min; MO 5; bolsa 20 → 25 ÷ 0,01 kg
  assert.deepStrictEqual([r.minutos, r.porUnidad, r.extraKg], [0.05, 25, 2500]);
});

test('plusInsumos: sólo los PLU de bolsa de cada peso, sin repetir (la bobina no va a SIGA)', () => {
  const cf = FC.normalizarCosteoFraccionado({ envasePorPeso: { 250: { bolsaPlu: '900' }, 500: { bolsaPlu: 900, bobinaG: 8 },
    750: { bolsaPlu: '901' }, 1000: { bobinaG: 10 } } });
  assert.deepStrictEqual(FC.plusInsumos(cf), ['900', '901']);
  assert.deepStrictEqual(FC.plusInsumos(FC.normalizarCosteoFraccionado({})), []);
});

// ── Envase: bolsa (PLU) o bobina (g × $/kg) ──
const ENV = FC.normalizarCosteoFraccionado({ costoHora: 6000, subrubros: { 7: { minKg: 2 } }, costoBobinaKg: 6000,
  envasePorPeso: { 500: { bolsaPlu: '900', bobinaG: 8 }, 250: { bobinaG: 5 }, 1000: { bolsaPlu: '900' } } });
const costoDe100 = plu => ({ 900: { costo: 100, nombre: 'Bolsa 500' } }[plu] || null);
const costearEnv = (pesoG, cf, envase) => FC.costearPresentacion({ pesoG, cf: { ...cf, porGranel: envase ? { 100: { envase } } : {} }, granel: GRANEL, costoDe: costoDe100 });

test('envase bolsa: línea Bolsa $100 origen bolsa; porUnidad = 100 + MO; extraKg = porUnidad ÷ 0,5', () => {
  const r = costearEnv(500, ENV);
  assert.deepStrictEqual(r.lineas[0], { plu: '900', nombre: 'Bolsa 500', rol: 'insumo', origen: 'bolsa', cantidad: 1, costoUnit: 100, importe: 100 });
  assert.deepStrictEqual([r.porUnidad, r.extraKg, r.avisos, r.faltantes], [200, 400, [], []]); // MO 1 min × 100
});

test('envase bobina: 8 g × $6000/kg = $48 y la bolsa del mismo peso se ignora', () => {
  const r = costearEnv(500, ENV, 'bobina');
  assert.deepStrictEqual(r.lineas[0], { plu: FC.CLAVE_BOBINA, nombre: 'Bobina', rol: 'insumo', origen: 'bobina', cantidad: 0.008, costoUnit: 6000, importe: 48 });
  assert.deepStrictEqual([r.lineas.filter(l => l.rol === 'insumo').length, r.porUnidad, r.extraKg], [1, 148, 296]);
});

test('envase: producto sin elegir (o con envase raro) = bolsa; envaseDe', () => {
  assert.strictEqual(FC.envaseDe(ENV, GRANEL), 'bolsa');
  assert.strictEqual(FC.envaseDe({ ...ENV, porGranel: { 100: { envase: 'bobina' } } }, GRANEL), 'bobina');
  assert.deepStrictEqual(FC.normalizarCosteoFraccionado({ porGranel: { 100: { envase: 'otra' }, 200: { envase: 'bobina' } } }).porGranel, { 200: { envase: 'bobina' } });
});

test('envase: peso sin bolsa → sinBolsa; sin peso de bolsa → sinBobina; cuestan sin envase', () => {
  const b = costearEnv(250, ENV);
  assert.deepStrictEqual([b.avisos, b.lineas.map(l => l.rol), b.faltantes, b.porUnidad], [['sinBolsa'], ['mo'], [], 50]);
  const o = costearEnv(1000, ENV, 'bobina');
  assert.deepStrictEqual([o.avisos, o.lineas.map(l => l.rol), o.porUnidad], [['sinBobina'], ['mo'], 200]);
});

test('envase sinEnvase: bolsa y bobina sin línea ni aviso, mismo costo; normaliza solo true y sin envase', () => {
  const sin = { ...ENV, envasePorPeso: { ...ENV.envasePorPeso, 250: { sinEnvase: true }, 1000: { sinEnvase: true } } };
  const b = costearEnv(250, sin);
  assert.deepStrictEqual([b.avisos, b.lineas.map(l => l.rol), b.porUnidad], [[], ['mo'], 50]);
  const o = costearEnv(1000, sin, 'bobina');
  assert.deepStrictEqual([o.avisos, o.lineas.map(l => l.rol), o.porUnidad], [[], ['mo'], 200]);
  assert.deepStrictEqual(FC.normalizarCosteoFraccionado({ envasePorPeso: { 1: { sinEnvase: true }, 2: { sinEnvase: 'si' },
    3: { sinEnvase: true, bolsaPlu: '9' } } }).envasePorPeso, { 1: { sinEnvase: true }, 3: { bolsaPlu: '9' } });
});

test('envase faltante: bolsa sin costo o bobina sin $/kg → faltante, porUnidad y extraKg null (nunca 0)', () => {
  const b = FC.costearPresentacion({ pesoG: 500, cf: ENV, granel: GRANEL, costoDe: () => ({ costo: 0, nombre: 'x' }) });
  assert.deepStrictEqual([b.faltantes, b.porUnidad, b.extraKg], [['900'], null, null]);
  const o = costearEnv(500, { ...ENV, costoBobinaKg: null }, 'bobina');
  assert.deepStrictEqual([o.faltantes, o.porUnidad, o.extraKg, o.lineas[0].importe], [['_bobina'], null, null, null]);
});

test('envase: sin peso en el nombre → sinPeso sin envase; cambiar costoBobinaKg mueve el costo', () => {
  assert.deepStrictEqual(costearEnv(null, ENV, 'bobina').avisos, ['sinPeso']);
  assert.strictEqual(costearEnv(500, { ...ENV, costoBobinaKg: 3000 }, 'bobina').lineas[0].importe, 24);
});

test('sumarExtraKg: suma a cada fuente; sin costo o extra null → null', () => {
  assert.deepStrictEqual(FC.sumarExtraKg({ sistema: 1000, ultimaCompra: null }, 240), { sistema: 1240, ultimaCompra: null });
  assert.deepStrictEqual(FC.sumarExtraKg({ sistema: 1000 }, null), { sistema: null });
});
