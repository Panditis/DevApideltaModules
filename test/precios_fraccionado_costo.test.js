'use strict';
const test = require('node:test');
const assert = require('node:assert');
const FC = require('../lib/precios_fraccionado_costo');

const CF = FC.normalizarCosteoFraccionado({
  costoHora: 6000,
  maquinas: [{ id: 'env', nombre: 'Envasadora', costoHora: 3000 }, { id: 'sel', nombre: 'Selladora', costoHora: 1200 }],
  subrubros: { 7: { maquinaId: 'env', tramos: [{ hastaG: 250, minutos: 0.5 }, { hastaG: 1000, minutos: 1 }], facilidad: 'normal', tiempo: 'lento' } },
  insumosPorPeso: { 500: [{ plu: '900', cantidad: 1 }] },
});
// subrubro 7 sin facilidad elegida
const SIN_ELEGIR = { ...CF, subrubros: { 7: { ...CF.subrubros[7], facilidad: undefined } } };
const costoDe = plu => ({ 900: { costo: 20, nombre: 'Bolsa' } }[plu] || null);
const GRANEL = { plu: '100', subrubroId: '7' };

test('normalizarCosteoFraccionado: defaults de escalas y mapas vacíos', () => {
  assert.deepStrictEqual(FC.normalizarCosteoFraccionado(undefined), {
    costoHora: null, maquinas: [],
    escalas: { facilidad: { facil: 1, normal: 1.25, dificil: 1.5 } },
    subrubros: {}, insumosPorPeso: {}, porGranel: {},
  });
});

test('normalizarCosteoFraccionado: insumosPorPeso sólo con gramos enteros > 0 y listas; subrubros sólo con facilidad válida (el tiempo viejo se ignora)', () => {
  const n = FC.normalizarCosteoFraccionado({
    insumosPorPeso: { 500: [{ plu: '900', cantidad: 1 }], 0: [{ plu: '1', cantidad: 1 }], abc: [], 1234567: [], '0250': [], 250: 'x', 1000: [] },
    subrubros: { 7: { maquinaId: 'env', tramos: [], facilidad: 'dificil', tiempo: 'rapido' }, 8: { tramos: [], facilidad: 'medio', tiempo: 5 } },
  });
  assert.deepStrictEqual(n.insumosPorPeso, { 500: [{ plu: '900', cantidad: 1 }], 1000: [] });
  assert.deepStrictEqual(n.subrubros, { 7: { maquinaId: 'env', tramos: [], facilidad: 'dificil' }, 8: { maquinaId: null, tramos: [] } });
});

test('normalizarCosteoFraccionado: lee la forma vieja (facilidades con medio, facilidad por granel); presentaciones / insumosPresentacion se descartan', () => {
  const n = FC.normalizarCosteoFraccionado({ facilidades: { facil: 1, medio: 1.3, dificil: 2 }, tiempos: [{ hastaG: 500, minutos: 1 }],
    insumosSubrubro: { 7: [] }, insumosPresentacion: { 101: [{ plu: '900', cantidad: 2 }], 102: [] }, presentaciones: { 101: { facilidad: 'facil' } },
    porGranel: { 100: { facilidad: 'medio', maquinaId: 'env' }, 200: { facilidad: 'facil', maquinaId: null } } });
  assert.deepStrictEqual(n.escalas.facilidad, { facil: 1, normal: 1.3, dificil: 2 });
  assert.deepStrictEqual([n.insumosPorPeso, 'presentaciones' in n], [{}, false]);
  assert.deepStrictEqual(n.porGranel, { 100: { maquinaId: 'env' } });
  assert.deepStrictEqual(n.subrubros, {});
  // la forma nueva gana sobre la vieja
  assert.strictEqual(FC.normalizarCosteoFraccionado({ facilidades: { medio: 1.3 }, escalas: { facilidad: { normal: 1.1 } } }).escalas.facilidad.normal, 1.1);
});

test('normalizarCosteoFraccionado: escalas sólo con los ids conocidos y números > 0; el resto cae al default (o a lo viejo); escalas.tiempo viejo se ignora', () => {
  const e = FC.normalizarCosteoFraccionado({ escalas: { facilidad: { facil: '2', normal: 0, dificil: -1, medio: 3, otro: 1 }, tiempo: { rapido: NaN, normal: null, lento: 2 } } }).escalas;
  assert.deepStrictEqual(e, { facilidad: { facil: 1, normal: 1.25, dificil: 1.5 } });
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

test('pesoGDe: gramos enteros del peso del nombre; sin peso null', () => {
  assert.deepStrictEqual([FC.pesoGDe('Almendra 500G'), FC.pesoGDe('Nuez 1Kg'), FC.pesoGDe('Sal granel')], [500, 1000, null]);
});

test('costearPresentacion: minutos = tramo × facilidad del subrubro (el tiempo viejo no multiplica); MO + máquina del subrubro + insumos de su peso, en $/kg', () => {
  const r = FC.costearPresentacion({ plu: '101', pesoG: 500, granel: GRANEL, cf: CF, costoDe });
  // 1 × 1,25 (normal) = 1,25 min (el tiempo: 'lento' guardado no cuenta); MO 1,25 × 6000/60 = 125; máquina 1,25 × 3000/60 = 62,5; bolsa 20
  assert.deepStrictEqual([r.minutosBase, r.factorFacilidad, r.minutos], [1, 1.25, 1.25]);
  assert.deepStrictEqual([r.facilidad, 'tiempo' in r, 'factorTiempo' in r], ['normal', false, false]);
  assert.deepStrictEqual(r.lineas.map(l => [l.plu, l.rol, l.importe]), [['900', 'insumo', 20], ['_manoObra', 'mo', 125], ['_maquina', 'maquina', 62.5]]);
  assert.deepStrictEqual([r.porUnidad, r.extraKg, r.avisos, r.faltantes], [207.5, 415, [], []]);
});

test('costearPresentacion / maquinaDe: la máquina del granel (excepción) pisa la del subrubro', () => {
  const cf = { ...CF, porGranel: { 100: { maquinaId: 'sel' } } };
  const r = FC.costearPresentacion({ plu: '101', pesoG: 500, granel: GRANEL, cf, costoDe });
  assert.deepStrictEqual([r.lineas[2].nombre, r.lineas[2].importe, r.porUnidad], ['Selladora', 25, 170]);
  assert.deepStrictEqual(FC.maquinaDe(cf, GRANEL), { maquina: CF.maquinas[1], origen: 'granel' });
  assert.deepStrictEqual(FC.maquinaDe(CF, GRANEL), { maquina: CF.maquinas[0], origen: 'subrubro' });
  assert.deepStrictEqual(FC.maquinaDe(CF, { plu: '1', subrubroId: null }), { maquina: null, origen: null });
});

test('costearPresentacion: subrubro sin facilidad → factor 1 con aviso; peso sin insumos → aviso', () => {
  const r = FC.costearPresentacion({ plu: '102', pesoG: 1000, granel: GRANEL, cf: SIN_ELEGIR, costoDe });
  assert.deepStrictEqual([r.minutos, r.porUnidad, r.facilidad, r.avisos], [1, 150, null, ['sinFacilidad', 'sinInsumos']]); // 100 MO + 50 máquina
  // los insumos son los del peso, sea cual sea la presentación
  assert.deepStrictEqual(FC.costearPresentacion({ plu: '777', pesoG: 500, granel: GRANEL, cf: CF, costoDe }).lineas[0].plu, '900');
});

test('costearPresentacion: granel sin subrubro → sin minutos (aviso sinSubrubro); los insumos de su peso igual suman', () => {
  const r = FC.costearPresentacion({ plu: '101', pesoG: 500, granel: { plu: '100', subrubroId: null }, cf: CF, costoDe });
  assert.deepStrictEqual([r.minutos, r.porUnidad, r.extraKg, r.avisos, r.facilidad], [0, 20, 40, ['sinSubrubro'], null]); // sin minutos no avisa facilidad/máquina
  const sin = FC.costearPresentacion({ plu: '102', pesoG: 250, granel: { plu: '100', subrubroId: null }, cf: CF, costoDe });
  assert.deepStrictEqual(sin.avisos, ['sinSubrubro', 'sinInsumos']);
});

test('costearPresentacion: subrubro sin tramos → aviso sinTramos; sin costo hora → aviso costoHora (MO en 0)', () => {
  const sinTramos = { ...CF, subrubros: { 7: { maquinaId: 'env', tramos: [] } } };
  assert.deepStrictEqual(FC.costearPresentacion({ plu: '101', pesoG: 500, granel: GRANEL, cf: sinTramos, costoDe }).avisos, ['sinTramos']);
  // sin tramo no hay minutos: tampoco se avisa la facilidad / la máquina que faltan (ruido)
  const sinNada = FC.costearPresentacion({ plu: '102', pesoG: 250, granel: GRANEL, cf: { ...sinTramos, subrubros: { 7: { tramos: [] } } }, costoDe });
  assert.deepStrictEqual(sinNada.avisos, ['sinTramos', 'sinInsumos']);
  const r = FC.costearPresentacion({ plu: '101', pesoG: 500, granel: GRANEL, cf: { ...CF, costoHora: null }, costoDe });
  assert.deepStrictEqual([r.avisos, r.lineas[1].importe], [['costoHora'], 0]);
});

test('costearPresentacion: insumo sin costo → faltante y sin costo (nunca 0); sin peso → sólo mercadería', () => {
  const cf = { ...CF, insumosPorPeso: { 500: [{ plu: '901', cantidad: 1 }] } };
  const r = FC.costearPresentacion({ plu: '101', pesoG: 500, granel: GRANEL, cf, costoDe });
  assert.deepStrictEqual([r.faltantes, r.porUnidad, r.extraKg], [['901'], null, null]);
  const s = FC.costearPresentacion({ plu: '101', pesoG: null, granel: GRANEL, cf: CF, costoDe });
  assert.deepStrictEqual([s.extraKg, s.avisos, s.facilidad, 'tiempo' in s, 'factorTiempo' in s], [0, ['sinPeso'], 'normal', false, false]);
});

test('costearPresentacion: el $/kg sale de la suma sin redondear (presentación de 10 g)', () => {
  const cf = { ...CF, subrubros: { 7: { ...CF.subrubros[7], facilidad: 'dificil' } }, insumosPorPeso: { 10: [{ plu: '900', cantidad: 1 }] } };
  const r = FC.costearPresentacion({ plu: '101', pesoG: 10, granel: GRANEL, cf, costoDe });
  // 0,5 × 1,5 = 0,75 min; MO 75; máquina 37,5; bolsa 20 → 132,5 ÷ 0,01 kg
  assert.deepStrictEqual([r.minutos, r.porUnidad, r.extraKg], [0.75, 132.5, 13250]);
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
