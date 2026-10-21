'use strict';
const test = require('node:test');
const assert = require('node:assert');
const FC = require('../lib/precios_fraccionado_costo');

const CF = FC.normalizarCosteoFraccionado({
  costoHora: 6000,
  maquinas: [{ id: 'env', nombre: 'Envasadora', costoHora: 3000 }, { id: 'sel', nombre: 'Selladora', costoHora: 1200 }],
  subrubros: { 7: { maquinaId: 'env', tramos: [{ hastaG: 250, minutos: 0.5 }, { hastaG: 1000, minutos: 1 }] } },
  presentaciones: { 101: { facilidad: 'normal', tiempo: 'lento', insumos: [{ plu: '900', cantidad: 1 }] } },
});
const costoDe = plu => ({ 900: { costo: 20, nombre: 'Bolsa' } }[plu] || null);
const GRANEL = { plu: '100', subrubroId: '7' };

test('normalizarCosteoFraccionado: defaults de escalas y mapas vacíos', () => {
  assert.deepStrictEqual(FC.normalizarCosteoFraccionado(undefined), {
    costoHora: null, maquinas: [],
    escalas: { facilidad: { facil: 1, normal: 1.25, dificil: 1.5 }, tiempo: { rapido: 0.75, normal: 1, lento: 1.5 } },
    subrubros: {}, presentaciones: {}, porGranel: {},
  });
});

test('normalizarCosteoFraccionado: lee la forma vieja (facilidades con medio, insumosPresentacion, facilidad por granel) sin perder datos', () => {
  const n = FC.normalizarCosteoFraccionado({ facilidades: { facil: 1, medio: 1.3, dificil: 2 }, tiempos: [{ hastaG: 500, minutos: 1 }],
    insumosSubrubro: { 7: [] }, insumosPresentacion: { 101: [{ plu: '900', cantidad: 2 }], 102: [] },
    porGranel: { 100: { facilidad: 'medio', maquinaId: 'env' }, 200: { facilidad: 'facil', maquinaId: null } } });
  assert.deepStrictEqual(n.escalas.facilidad, { facil: 1, normal: 1.3, dificil: 2 });
  assert.deepStrictEqual(n.presentaciones, { 101: { insumos: [{ plu: '900', cantidad: 2 }] } });
  assert.deepStrictEqual(n.porGranel, { 100: { maquinaId: 'env' } });
  assert.deepStrictEqual(n.subrubros, {});
  // la forma nueva gana sobre la vieja
  assert.strictEqual(FC.normalizarCosteoFraccionado({ facilidades: { medio: 1.3 }, escalas: { facilidad: { normal: 1.1 } } }).escalas.facilidad.normal, 1.1);
});

test('normalizarCosteoFraccionado: escalas sólo con los ids conocidos y números > 0; el resto cae al default (o a lo viejo)', () => {
  const e = FC.normalizarCosteoFraccionado({ escalas: { facilidad: { facil: '2', normal: 0, dificil: -1, medio: 3, otro: 1 }, tiempo: { rapido: NaN, normal: null, lento: 2 } } }).escalas;
  assert.deepStrictEqual(e, { facilidad: { facil: 1, normal: 1.25, dificil: 1.5 }, tiempo: { rapido: 0.75, normal: 1, lento: 2 } });
  assert.deepStrictEqual(Object.keys(e.facilidad), ['facil', 'normal', 'dificil']);
  // la forma vieja inválida tampoco pasa; la válida sí, y la nueva inválida cae a la vieja válida
  const v = FC.normalizarCosteoFraccionado({ facilidades: { facil: 'x', medio: 1.3, dificil: Infinity }, escalas: { facilidad: { normal: -2 } } }).escalas.facilidad;
  assert.deepStrictEqual(v, { facil: 1, normal: 1.3, dificil: 1.5 });
});

test('tramoDe: primer tramo que cubre el peso, arriba del último el último; sin tramos o sin peso null', () => {
  const ts = [{ hastaG: 250, minutos: 0.5 }, { hastaG: 1000, minutos: 1 }];
  assert.deepStrictEqual([FC.tramoDe(ts, 250).minutos, FC.tramoDe(ts, 251).minutos, FC.tramoDe(ts, 5000).minutos], [0.5, 1, 1]);
  assert.deepStrictEqual([FC.tramoDe([], 100), FC.tramoDe(ts, null)], [null, null]);
});

test('costearPresentacion: minutos = tramo del subrubro × tiempo × facilidad; MO + máquina del subrubro + insumos, en $/kg', () => {
  const r = FC.costearPresentacion({ plu: '101', pesoG: 500, granel: GRANEL, cf: CF, costoDe });
  // 1 × 1,5 (lento) × 1,25 (normal) = 1,875 min; MO 1,875 × 6000/60 = 187,5; máquina 1,875 × 3000/60 = 93,75; bolsa 20
  assert.deepStrictEqual([r.minutosBase, r.factorTiempo, r.factorFacilidad, r.minutos], [1, 1.5, 1.25, 1.875]);
  assert.deepStrictEqual([r.facilidad, r.tiempo], ['normal', 'lento']);
  assert.deepStrictEqual(r.lineas.map(l => [l.plu, l.rol, l.importe]), [['900', 'insumo', 20], ['_manoObra', 'mo', 187.5], ['_maquina', 'maquina', 93.75]]);
  assert.deepStrictEqual([r.porUnidad, r.extraKg, r.avisos, r.faltantes], [301.25, 602.5, [], []]);
});

test('costearPresentacion / maquinaDe: la máquina del granel (excepción) pisa la del subrubro', () => {
  const cf = { ...CF, porGranel: { 100: { maquinaId: 'sel' } } };
  const r = FC.costearPresentacion({ plu: '101', pesoG: 500, granel: GRANEL, cf, costoDe });
  assert.deepStrictEqual([r.lineas[2].nombre, r.lineas[2].importe, r.porUnidad], ['Selladora', 37.5, 245]);
  assert.deepStrictEqual(FC.maquinaDe(cf, GRANEL), { maquina: CF.maquinas[1], origen: 'granel' });
  assert.deepStrictEqual(FC.maquinaDe(CF, GRANEL), { maquina: CF.maquinas[0], origen: 'subrubro' });
  assert.deepStrictEqual(FC.maquinaDe(CF, { plu: '1', subrubroId: null }), { maquina: null, origen: null });
});

test('costearPresentacion: sin facilidad ni tiempo → factor 1 con aviso; sin insumos → aviso', () => {
  const r = FC.costearPresentacion({ plu: '102', pesoG: 1000, granel: GRANEL, cf: CF, costoDe });
  assert.deepStrictEqual([r.minutos, r.porUnidad, r.avisos], [1, 150, ['sinTiempo', 'sinFacilidad', 'sinInsumos']]); // 100 MO + 50 máquina
});

test('costearPresentacion: granel sin subrubro → sin minutos (aviso sinSubrubro); los insumos de la presentación igual suman', () => {
  const r = FC.costearPresentacion({ plu: '101', pesoG: 500, granel: { plu: '100', subrubroId: null }, cf: CF, costoDe });
  assert.deepStrictEqual([r.minutos, r.porUnidad, r.extraKg, r.avisos], [0, 20, 40, ['sinSubrubro']]); // sin minutos no avisa tiempo/facilidad/máquina
  const sin = FC.costearPresentacion({ plu: '102', pesoG: 500, granel: { plu: '100', subrubroId: null }, cf: CF, costoDe });
  assert.deepStrictEqual(sin.avisos, ['sinSubrubro', 'sinInsumos']);
});

test('costearPresentacion: subrubro sin tramos → aviso sinTramos; sin costo hora → aviso costoHora (MO en 0)', () => {
  const sinTramos = { ...CF, subrubros: { 7: { maquinaId: 'env', tramos: [] } } };
  assert.deepStrictEqual(FC.costearPresentacion({ plu: '101', pesoG: 500, granel: GRANEL, cf: sinTramos, costoDe }).avisos, ['sinTramos']);
  // sin tramo no hay minutos: tampoco se avisa el tiempo / la facilidad / la máquina que faltan (ruido)
  const sinNada = FC.costearPresentacion({ plu: '102', pesoG: 500, granel: GRANEL, cf: { ...sinTramos, subrubros: { 7: { tramos: [] } } }, costoDe });
  assert.deepStrictEqual(sinNada.avisos, ['sinTramos', 'sinInsumos']);
  const r = FC.costearPresentacion({ plu: '101', pesoG: 500, granel: GRANEL, cf: { ...CF, costoHora: null }, costoDe });
  assert.deepStrictEqual([r.avisos, r.lineas[1].importe], [['costoHora'], 0]);
});

test('costearPresentacion: insumo sin costo → faltante y sin costo (nunca 0); sin peso → sólo mercadería', () => {
  const cf = { ...CF, presentaciones: { 101: { insumos: [{ plu: '901', cantidad: 1 }] } } };
  const r = FC.costearPresentacion({ plu: '101', pesoG: 500, granel: GRANEL, cf, costoDe });
  assert.deepStrictEqual([r.faltantes, r.porUnidad, r.extraKg], [['901'], null, null]);
  const s = FC.costearPresentacion({ plu: '101', pesoG: null, granel: GRANEL, cf: CF, costoDe });
  assert.deepStrictEqual([s.extraKg, s.avisos, s.facilidad, s.tiempo], [0, ['sinPeso'], 'normal', 'lento']);
});

test('costearPresentacion: el $/kg sale de la suma sin redondear (presentación de 10 g)', () => {
  const cf = { ...CF, presentaciones: { 101: { facilidad: 'facil', tiempo: 'rapido', insumos: [{ plu: '900', cantidad: 1 }] } } };
  const r = FC.costearPresentacion({ plu: '101', pesoG: 10, granel: GRANEL, cf, costoDe });
  // 0,5 × 0,75 × 1 = 0,375 min; MO 37,5; máquina 18,75; bolsa 20 → 76,25 ÷ 0,01 kg
  assert.deepStrictEqual([r.minutos, r.porUnidad, r.extraKg], [0.375, 76.25, 7625]);
});

test('plusInsumos: PLUs de los insumos de las presentaciones, sin repetir', () => {
  const cf = FC.normalizarCosteoFraccionado({ presentaciones: { 1: { insumos: [{ plu: '900', cantidad: 1 }] },
    2: { insumos: [{ plu: 900, cantidad: 2 }, { plu: '901', cantidad: 1 }] }, 3: { facilidad: 'facil' } } });
  assert.deepStrictEqual(FC.plusInsumos(cf), ['900', '901']);
});

test('sumarExtraKg: suma a cada fuente; sin costo o extra null → null', () => {
  assert.deepStrictEqual(FC.sumarExtraKg({ sistema: 1000, ultimaCompra: null }, 240), { sistema: 1240, ultimaCompra: null });
  assert.deepStrictEqual(FC.sumarExtraKg({ sistema: 1000 }, null), { sistema: null });
});
