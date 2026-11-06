'use strict';
// Piso de los pack/bulto vinculados a presentaciones minoristas de Fraccionado: nunca por debajo del pack mayorista
// más barato del granel + colchón (margenes.mayorista.pisoVinculadoPct, default 2).
const test = require('node:test');
const assert = require('node:assert');
const E = require('../lib/precios_esquema');
const L = require('../lib/precios_listado_esquema');
const FC = require('../lib/precios_fraccionado_costo');
const cfgEsq = require('../lib/precios_config_esquema');
const { CFG, T } = require('./precios_esquema_fixture');

const CFGP = { ivaVentaPct: 21, toleranciaPct: 5, redondeo: { packNeto: 50, packIva: 50, bultoNeto: 50, bultoIva: 50 } };
const pack = (precio = 2450) => ({ plu: '5K', mayorista: true, mayoristaTipo: 'pack', pesoG: 5000, mayoristas: [],
  sugeridos: { sistema: { minorista: { precio }, mayoristas: [] } } });
const minorista = ({ neto = 950, unidades = 0.4, vigente = 950 } = {}) => ({ plu: '400', mayorista: false, mayoristaTipo: null, pesoG: 400,
  costos: { sistema: 1500 }, mayoristas: [{ plu: 'B400', tipo: 'bulto', unidades, vigente }],
  sugeridos: { sistema: { minorista: { precio: 3000 }, mayoristas: [{ plu: 'B400', faltante: null, neto, conIva: 1150 }] } } });
const vinc = p => p.sugeridos.sistema.mayoristas[0];

test('descuentosMayorista: pisoVinculadoPct default 2, válido, inválido, 0', () => {
  assert.strictEqual(E.DESC_MAYORISTA_DEFAULT.pisoVinculadoPct, 2);
  assert.strictEqual(E.descuentosMayorista(undefined).pisoVinculadoPct, 2);
  assert.strictEqual(E.descuentosMayorista({ pisoVinculadoPct: 3.5 }).pisoVinculadoPct, 3.5);
  for (const v of [-1, 51, 'abc', null, NaN]) assert.strictEqual(E.descuentosMayorista({ pisoVinculadoPct: v }).pisoVinculadoPct, 2, String(v));
  assert.strictEqual(E.descuentosMayorista({ pisoVinculadoPct: 0 }).pisoVinculadoPct, 0);
});

test('validarMargenes: pisoVinculadoPct 0..50, opcional, inválido tira, ausente conserva el guardado', () => {
  const body = { minorista: T, pack: T, bulto: T };
  const may = piso => cfgEsq.validarMargenes({ ...body, mayorista: { descPackPct: 10, descBultoPct: 10, pisoVinculadoPct: piso } }, {}, 'fraccionado').mayorista;
  assert.strictEqual(may(2.5).pisoVinculadoPct, 2.5);
  assert.strictEqual(may(50).pisoVinculadoPct, 50);
  assert.strictEqual(may(0).pisoVinculadoPct, 0);
  for (const v of [-1, 51, 'abc']) assert.throws(() => may(v), /mayorista\.pisoVinculadoPct/, String(v));
  const guardado = { mayorista: { descPackPct: 10, descBultoPct: 10, pisoVinculadoPct: 4 } };
  assert.strictEqual(cfgEsq.validarMargenes({ ...body, mayorista: { descPackPct: 5, descBultoPct: 5 } }, guardado, 'fraccionado').mayorista.pisoVinculadoPct, 4);
  assert.strictEqual('pisoVinculadoPct' in cfgEsq.validarMargenes({ ...body, mayorista: { descPackPct: 5, descBultoPct: 5 } }, {}, 'fraccionado').mayorista, false);
  assert.strictEqual(cfgEsq.configEsquemaDe({ fraccionado: { margenes: { ...body, ...guardado } } }, 'fraccionado').margenes.mayorista.pisoVinculadoPct, 4);
});

test('aplicarPisoVinculados: caso Lenteja 400G bulto 950 → 1000 (piso 2499/kg)', () => {
  const entrada = [pack(), minorista()];
  const copia = JSON.parse(JSON.stringify(entrada));
  const [p5, p400] = L.aplicarPisoVinculados(entrada, { colchonPct: 2, cfg: CFGP });
  const c = vinc(p400);
  assert.deepStrictEqual([c.pisoAplicado, c.pisoKg, c.neto, c.netoSinPiso, c.conIvaSinPiso], [true, 2499, 1000, 950, 1150]);
  assert.ok(c.neto / 0.4 >= 2499);
  assert.strictEqual(c.conIva, E.redondearMultiplo(1210, 50));
  assert.strictEqual(c.margenTotalNetoPct, E.r2((1000 / 600 - 1) * 100)); // costo 1500 × 0,4
  assert.strictEqual(c.deltaPct != null, true);
  assert.strictEqual(p5, entrada[0]); // la mayorista no se toca
  assert.deepStrictEqual(entrada, copia); // no muta
});

test('aplicarPisoVinculados: sin pack mayorista, ya por encima, colchón 0 y modo kg', () => {
  const sinPack = [{ ...pack(), mayoristaTipo: 'bulto' }, minorista()];
  assert.deepStrictEqual(L.aplicarPisoVinculados(sinPack, { colchonPct: 2, cfg: CFGP }), sinPack);
  const arriba = [pack(), minorista({ neto: 1100 })];
  assert.deepStrictEqual(vinc(L.aplicarPisoVinculados(arriba, { colchonPct: 2, cfg: CFGP })[1]), vinc(arriba[1]));
  // colchón 0: piso = pack exacto (2450/kg = 980 por 400 g); 970 queda debajo → 980 → paso 50 hacia arriba = 1000; 980 justo no cambia.
  assert.strictEqual(vinc(L.aplicarPisoVinculados([pack(), minorista({ neto: 970 })], { colchonPct: 0, cfg: CFGP })[1]).neto, 1000);
  assert.strictEqual(vinc(L.aplicarPisoVinculados([pack(), minorista({ neto: 980 })], { colchonPct: 0, cfg: CFGP })[1]).pisoAplicado, undefined);
  // modo kg (unidades 1): neto ya es $/kg → 2300 < 2499 → 2500
  const kg = vinc(L.aplicarPisoVinculados([pack(), minorista({ neto: 2300, unidades: 1 })], { colchonPct: 2, cfg: CFGP })[1]);
  assert.deepStrictEqual([kg.neto, kg.pisoAplicado, kg.netoSinPiso], [2500, true, 2300]);
});

test('listadoFraccionado de punta a punta: piso aplicado al vinculado de la minorista y sale así en el export', () => {
  const presentaciones = [{ plu: '701', nombre: 'Chia 500G' }, { plu: '702', nombre: 'Chia 5Kg' }];
  const costos = new Map([['700', { nombre: 'Chia granel', costoSistema: 1000 }]]);
  const grupos = [{ plu: '700', nombre: 'Chia granel', subrubroId: null, subrubro: null, presentaciones }];
  const vinculos = [{ plu: '91', nombre: 'Chia 500G Bulto', basePlu: '701', cantidad: 1, tipo: 'bulto' }];
  const mayoristasDe = L.crearMayoristasDe({ vinculos, vigentes: new Map() });
  const cfg = { ...CFG, margenes: { ...CFG.margenes, mayorista: { descPackPct: 10, descBultoPct: 10, pisoVinculadoPct: 50 } } };
  const [fila] = L.listadoFraccionado({ grupos, costos, vigentes: new Map(), costeo: { decisiones: { 700: { fuente: 'sistema' } } }, cfg,
    costeoF: FC.normalizarCosteoFraccionado({ costoHora: 6000, mayorista: { pesoMinG: null, porPlu: { 702: 'pack' } } }), mayoristasDe });
  const p701 = fila.presentaciones.find(p => p.plu === '701'), p702 = fila.presentaciones.find(p => p.plu === '702');
  const c = p701.sugeridos.sistema.mayoristas[0];
  const pisoKg = E.r2(p702.sugeridos.sistema.minorista.precio * 1.5);
  assert.deepStrictEqual([c.pisoAplicado, c.pisoKg], [true, pisoKg]);
  assert.ok(c.neto / 0.5 >= pisoKg && c.netoSinPiso < c.neto);
  const { items } = L.itemsDecididos({ fraccionado: [{ ...fila, decision: { fuente: 'sistema' } }] });
  const exp = items.flatMap(i => i.mayoristas).find(m => m.plu === '91');
  assert.deepStrictEqual([exp.neto, exp.conIva], [c.neto, c.conIva]);
});
