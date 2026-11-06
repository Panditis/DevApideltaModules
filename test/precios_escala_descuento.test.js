'use strict';
// Escalas de descuento por costo para pack/bulto de Fraccionado (margenes.mayorista.escalaPack / escalaBulto):
// más caro → más descuento; filas manuales ganan; sin escalas = descuentos fijos de siempre.
const test = require('node:test');
const assert = require('node:assert');
const E = require('../lib/precios_esquema');
const L = require('../lib/precios_listado_esquema');
const FC = require('../lib/precios_fraccionado_costo');
const cfgEsq = require('../lib/precios_config_esquema');
const { CFG, T } = require('./precios_esquema_fixture');

const ESC = { minPct: 2, maxPct: 12, escalones: 3, rango: { desde: 1000, hasta: 8000 } }; // cortes 2000 / 4000
const MAN = { ...ESC, filas: [{ hasta: 1500, descPct: 1 }, { hasta: 3000, descPct: 4 }, { hasta: null, descPct: 9 }] };

test('validarEscalaDescuento: válidas y cada error', () => {
  assert.strictEqual(E.validarEscalaDescuento(ESC), null);
  assert.strictEqual(E.validarEscalaDescuento(MAN), null);
  assert.strictEqual(E.validarEscalaDescuento({ ...ESC, minPct: 0, maxPct: 99.9 }), null);
  const malas = [
    [{ ...ESC, minPct: 13 }, /mínimo no puede superar/],
    [{ ...ESC, maxPct: 100 }, /descuento/], [{ ...ESC, minPct: -1 }, /descuento/],
    [{ ...ESC, escalones: 0 }, /escalones/], [{ ...ESC, escalones: 31 }, /escalones/], [{ ...ESC, escalones: 2.5 }, /escalones/],
    [{ ...ESC, rango: { desde: 0, hasta: 10 } }, /rango/], [{ ...ESC, rango: { desde: 10, hasta: 10 } }, /rango/], [{ ...ESC, rango: null }, /rango/],
    [{ ...ESC, filas: [{ hasta: 3000, descPct: 1 }, { hasta: 2000, descPct: 2 }, { hasta: null, descPct: 3 }] }, /Fila 2: el corte debe ser mayor/],
    [{ ...ESC, filas: [{ hasta: 3000, descPct: 1 }, { hasta: 4000, descPct: 2 }] }, /Fila 2: la última fila no lleva corte/],
    [{ ...ESC, filas: [] }, /entre 1 y 30 filas/],
    [{ ...ESC, filas: [{ hasta: null, descPct: 100 }] }, /Fila 1: El descuento/],
    [null, /Falta/],
  ];
  for (const [t, re] of malas) assert.match(E.validarEscalaDescuento(t) || '', re, JSON.stringify(t));
});

test('regresión: filas null no tiran (validar, descuentosMayorista, PUT)', () => {
  const base = { minPct: 1, maxPct: 2, escalones: 2, rango: { desde: 1, hasta: 2 } };
  const soloNull = { ...base, filas: [null] };
  const nullMedio = { ...base, filas: [{ hasta: 1, descPct: 1 }, null, { hasta: null, descPct: 2 }] };
  assert.match(E.validarEscalaDescuento(soloNull), /^Fila 1: /);
  assert.match(E.validarEscalaDescuento(nullMedio), /^Fila 2: /);
  assert.match(E.validarEscalaDescuento({ ...base, filas: [{ hasta: 'x', descPct: 1 }, { hasta: null, descPct: 2 }] }), /^Fila 1: /);
  assert.match(E.validarEscalaDescuento({ ...base, filas: 'x' }), /filas/);
  const d = E.descuentosMayorista({ descPackPct: 5, descBultoPct: 10, escalaPack: soloNull, escalaBulto: nullMedio });
  assert.deepStrictEqual(['escalaPack' in d, 'escalaBulto' in d], [false, false]);
  const r = E.preciosCanales({ tipo: 'fraccionado', costo: 1000, unidades: { pack: 1 }, cfg: { ...CFG, margenes: { ...CFG.margenes, mayorista: { descPackPct: 5, escalaPack: soloNull } } } });
  assert.strictEqual(r.pack.descuentoMayoristaPct, 5);
  const put = escalaPack => () => cfgEsq.validarMargenes({ minorista: T, pack: T, bulto: T, mayorista: { descPackPct: 5, descBultoPct: 10, escalaPack } }, {}, 'fraccionado');
  for (const e of [soloNull, nullMedio]) {
    assert.throws(put(e), err => !(err instanceof TypeError) && /^mayorista\.escalaPack: Fila \d: /.test(err.message));
  }
});

test('descuentoDeEscala: automático barato→min, caro→max, bordes y tramo medio', () => {
  assert.deepStrictEqual(E.quiebresEscala(ESC), [{ hasta: 2000, descPct: 2 }, { hasta: 4000, descPct: 7 }, { hasta: null, descPct: 12 }]);
  assert.strictEqual(E.descuentoDeEscala(ESC, 10), 2); // costo < primer corte
  assert.strictEqual(E.descuentoDeEscala(ESC, 1999.99), 2);
  assert.strictEqual(E.descuentoDeEscala(ESC, 2000), 7); // borde: el corte es exclusivo
  assert.strictEqual(E.descuentoDeEscala(ESC, 3999), 7);
  assert.strictEqual(E.descuentoDeEscala(ESC, 4000), 12);
  assert.strictEqual(E.descuentoDeEscala(ESC, 1e9), 12); // ≥ último
  assert.strictEqual(E.descuentoDeEscala({ ...ESC, escalones: 1 }, 5000), 2);
});

test('descuentoDeEscala: manual gana sobre el automático', () => {
  assert.deepStrictEqual([100, 1500, 2999, 3000, 1e6].map(c => E.descuentoDeEscala(MAN, c)), [1, 4, 4, 9, 9]);
});

test('descuentosMayorista: escalas válidas viajan, inválidas se ignoran', () => {
  const d = E.descuentosMayorista({ descPackPct: 5, descBultoPct: 10, escalaPack: ESC, escalaBulto: { ...ESC, minPct: 50 } });
  assert.deepStrictEqual(d.escalaPack, ESC);
  assert.strictEqual('escalaBulto' in d, false);
  assert.strictEqual('escalaPack' in E.descuentosMayorista(undefined), false);
});

test('config: objeto se valida y guarda limpio, null borra, ausente conserva, inválido tira', () => {
  const body = { minorista: T, pack: T, bulto: T };
  const may = (m, actuales = {}) => cfgEsq.validarMargenes({ ...body, mayorista: { descPackPct: 5, descBultoPct: 10, ...m } }, actuales, 'fraccionado').mayorista;
  assert.deepStrictEqual(may({ escalaPack: { ...MAN, basura: 1 } }).escalaPack, MAN);
  assert.deepStrictEqual(may({ escalaBulto: ESC }).escalaBulto, ESC);
  const guardado = { mayorista: { descPackPct: 5, descBultoPct: 10, escalaPack: ESC, escalaBulto: MAN } };
  const conservado = may({}, guardado);
  assert.deepStrictEqual([conservado.escalaPack, conservado.escalaBulto], [ESC, MAN]);
  const borrado = may({ escalaPack: null }, guardado);
  assert.strictEqual('escalaPack' in borrado, false);
  assert.deepStrictEqual(borrado.escalaBulto, MAN);
  assert.throws(() => may({ escalaPack: { ...ESC, minPct: 20 } }), /mayorista\.escalaPack: El descuento mínimo/);
  assert.throws(() => may({ escalaBulto: 'x' }), /mayorista\.escalaBulto/);
  // GET: configEsquemaDe devuelve las escalas guardadas.
  assert.deepStrictEqual(cfgEsq.configEsquemaDe({ fraccionado: { margenes: { ...body, ...guardado } } }, 'fraccionado').margenes.mayorista.escalaPack, ESC);
});

const cfgCon = mayorista => ({ ...CFG, margenes: { ...CFG.margenes, mayorista: { descPackPct: 5, descBultoPct: 10, pisoVinculadoPct: 2, ...mayorista } } });
const canales = (cfg, costo, extra = {}) => E.preciosCanales({ tipo: 'fraccionado', costo, unidades: { pack: 0.5, bulto: 0.5 }, cfg, ...extra });

test('preciosCanales: sin escalas igual a los fijos; con escalas cambian según el costo', () => {
  const sin = canales(cfgCon({}), 1000);
  assert.deepStrictEqual([sin.pack.descuentoMayoristaPct, sin.bulto.descuentoMayoristaPct], [5, 10]);
  // Una escala que da lo mismo que el fijo deja los precios idénticos.
  const igual = canales(cfgCon({ escalaPack: { ...ESC, minPct: 5, maxPct: 5 }, escalaBulto: { ...ESC, minPct: 10, maxPct: 10 } }), 1000);
  assert.deepStrictEqual([igual.pack, igual.bulto], [sin.pack, sin.bulto]);
  const cfg = cfgCon({ escalaPack: ESC, escalaBulto: MAN });
  const barato = canales(cfg, 500), caro = canales(cfg, 9000);
  assert.deepStrictEqual([barato.pack.descuentoMayoristaPct, barato.bulto.descuentoMayoristaPct], [2, 1]);
  assert.deepStrictEqual([caro.pack.descuentoMayoristaPct, caro.bulto.descuentoMayoristaPct], [12, 9]);
  const base = caro.minorista.conExtras;
  assert.strictEqual(caro.pack.netoUnidad, E.r2(base * 0.88));
  assert.strictEqual(caro.bulto.netoUnidad, E.r2(base * 0.88 * 0.91));
  // costoMargen manda sobre costo como en las tablas de margen.
  assert.strictEqual(canales(cfg, 9000, { costoMargen: 500 }).pack.descuentoMayoristaPct, 2);
});

test('preciosCanales: sólo una escala → la otra usa el fijo; mayorista.escala en la presentación mayorista', () => {
  const cfg = cfgCon({ escalaBulto: ESC });
  const r = canales(cfg, 9000, { variante: 'pack' });
  assert.deepStrictEqual([r.pack.descuentoMayoristaPct, r.bulto.descuentoMayoristaPct], [5, 12]);
  assert.deepStrictEqual(r.minorista.mayorista.escala, { pack: false, bulto: true });
  assert.deepStrictEqual([r.minorista.mayorista.descPackPct, r.minorista.mayorista.descBultoPct], [5, 12]);
  assert.strictEqual(r.minorista.descuentoMayoristaPct, 5);
  const b = canales(cfg, 9000, { variante: 'bulto' });
  assert.strictEqual(b.minorista.descuentoMayoristaPct, 12);
  assert.strictEqual(b.minorista.precio, E.alinear(E.r2(b.minorista.mayorista.base * 0.95 * 0.88), null, CFG.redondeo.minorista));
  assert.deepStrictEqual(canales(cfgCon({}), 9000, { variante: 'pack' }).minorista.mayorista.escala, { pack: false, bulto: false });
});

test('listadoFraccionado: escala + piso de vinculados conviven', () => {
  const presentaciones = [{ plu: '701', nombre: 'Chia 500G' }, { plu: '702', nombre: 'Chia 5Kg' }];
  const costos = new Map([['700', { nombre: 'Chia granel', costoSistema: 1000 }]]);
  const grupos = [{ plu: '700', nombre: 'Chia granel', subrubroId: null, subrubro: null, presentaciones }];
  const vinculos = [{ plu: '91', nombre: 'Chia 500G Bulto', basePlu: '701', cantidad: 1, tipo: 'bulto' }];
  const mayoristasDe = L.crearMayoristasDe({ vinculos, vigentes: new Map() });
  const cfg = cfgCon({ pisoVinculadoPct: 50, escalaPack: { ...ESC, minPct: 20, maxPct: 20 }, escalaBulto: { ...ESC, minPct: 30, maxPct: 30 } });
  const [fila] = L.listadoFraccionado({ grupos, costos, vigentes: new Map(), costeo: { decisiones: { 700: { fuente: 'sistema' } } }, cfg,
    costeoF: FC.normalizarCosteoFraccionado({ costoHora: 6000, mayorista: { pesoMinG: null, porPlu: { 702: 'pack' } } }), mayoristasDe });
  const p701 = fila.presentaciones.find(p => p.plu === '701'), p702 = fila.presentaciones.find(p => p.plu === '702');
  const motor = p702.sugeridos.sistema.desglose.minorista;
  assert.deepStrictEqual([motor.descuentoMayoristaPct, motor.mayorista.descBultoPct], [20, 30]);
  assert.deepStrictEqual(motor.mayorista.escala, { pack: true, bulto: true });
  const c = p701.sugeridos.sistema.mayoristas[0];
  const pisoKg = E.r2(p702.sugeridos.sistema.minorista.precio * 1.5);
  assert.deepStrictEqual([c.pisoAplicado, c.pisoKg], [true, pisoKg]);
  assert.ok(c.neto / 0.5 >= pisoKg && c.netoSinPiso < c.neto);
});
