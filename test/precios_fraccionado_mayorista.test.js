'use strict';
// Presentaciones mayoristas de Fraccionado (spec precios_fraccionado_mayorista_activar, pieza A): clasificación, config,
// regresión de precios (la variante 'mayorista' hoy da lo mismo) y PUT/GET mayorista.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const FC = require('../lib/precios_fraccionado_costo');
const CF = require('../lib/precios_config_fraccionado');
const E = require('../lib/precios_esquema');
const L = require('../lib/precios_listado_esquema');
const cfgEsq = require('../lib/precios_config_esquema');
const { CFG, T } = require('./precios_esquema_fixture');
const crearRutas = require('../routes/rutas_precios_fraccionado');

const es = (pesoG, plu, cfg) => FC.esMayoristaPresentacion(pesoG, plu, cfg);

test('clasificación: límite exacto, debajo, sin peso, umbral null y marcas manuales', () => {
  const cfg = { pesoMinG: 5000, porPlu: { 10: false, 20: true, 30: 'pack', 40: 'bulto' } };
  const no = { mayorista: false, origen: null, tipo: null };
  assert.deepStrictEqual(es(5000, '1', cfg), { mayorista: true, origen: 'peso', tipo: 'bulto' }); // automático por peso = bulto
  assert.deepStrictEqual(es(4999, '1', cfg), no);
  assert.deepStrictEqual(es(null, '1', cfg), no);
  assert.deepStrictEqual(es(10000, '10', cfg), { mayorista: false, origen: 'manual', tipo: null }); // false fuerza minorista
  assert.deepStrictEqual(es(100, '20', cfg), { mayorista: true, origen: 'manual', tipo: 'bulto' }); // true ≡ bulto
  assert.deepStrictEqual(es(null, '20', cfg), { mayorista: true, origen: 'manual', tipo: 'bulto' });
  assert.deepStrictEqual(es(10000, '30', cfg), { mayorista: true, origen: 'manual', tipo: 'pack' }); // la marca gana al peso
  assert.deepStrictEqual(es(100, '40', cfg), { mayorista: true, origen: 'manual', tipo: 'bulto' });
  assert.deepStrictEqual(es(100, '50', { porPlu: { 50: 'otro' } }), no);
  const sinUmbral = { pesoMinG: null, porPlu: { 20: true } };
  assert.deepStrictEqual(es(100000, '1', sinUmbral), no);
  assert.deepStrictEqual(es(100, '20', sinUmbral), { mayorista: true, origen: 'manual', tipo: 'bulto' });
  assert.deepStrictEqual(es(100000, '1', undefined), no);
});

test('normalizar: sin clave queda igual que hoy; basura se descarta; vacío no crea la clave', () => {
  assert.strictEqual('mayorista' in FC.normalizarCosteoFraccionado({}), false);
  assert.strictEqual('mayorista' in FC.normalizarCosteoFraccionado({ mayorista: { pesoMinG: -1, porPlu: { x: true, 5: 'si' } } }), false);
  assert.deepStrictEqual(FC.normalizarCosteoFraccionado({ mayorista: { pesoMinG: 2.5, porPlu: { 5: true, 6: 'pack', 7: false, 8: 'x', abc: false } } }).mayorista,
    { pesoMinG: null, porPlu: { 5: 'bulto', 6: 'pack', 7: false } });
});

test('aplicarMayorista: mezcla, null saca, vacío borra la config, inválidos tiran, no muta', () => {
  const previo = { pesoMinG: 5000, porPlu: { 1: true } };
  assert.deepStrictEqual(CF.aplicarMayorista(previo, { porPlu: { 2: false } }), { mayorista: { pesoMinG: 5000, porPlu: { 1: true, 2: false } } });
  assert.deepStrictEqual(CF.aplicarMayorista(previo, { porPlu: { 2: 'pack', 3: true, 4: 'bulto' } }).mayorista.porPlu, { 1: true, 2: 'pack', 3: 'bulto', 4: 'bulto' });
  assert.deepStrictEqual(CF.aplicarMayorista(previo, { pesoMinG: null }), { mayorista: { pesoMinG: null, porPlu: { 1: true } } });
  assert.deepStrictEqual(CF.aplicarMayorista(previo, { pesoMinG: '', porPlu: { 1: null } }), { mayorista: undefined });
  assert.deepStrictEqual(CF.aplicarMayorista(undefined, { pesoMinG: 1000000 }), { mayorista: { pesoMinG: 1000000, porPlu: {} } });
  for (const body of [{}, null, { pesoMinG: 0 }, { pesoMinG: -5 }, { pesoMinG: 2.5 }, { pesoMinG: 1000001 }, { pesoMinG: '500' },
    { porPlu: [] }, { porPlu: { abc: true } }, { porPlu: { 1234567890123: true } }, { porPlu: { 1: 'si' } }, { porPlu: { 1: 'PACK' } }, { porPlu: { 1: 1 } }]) {
    assert.throws(() => CF.aplicarMayorista(previo, body), Error, JSON.stringify(body));
  }
  const muchos = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [String(i + 1), true]));
  assert.throws(() => CF.aplicarMayorista(undefined, { porPlu: muchos }), /máximo 1000/);
  assert.deepStrictEqual(previo, { pesoMinG: 5000, porPlu: { 1: true } });
});

test('margenes.mayorista: descuentos validados, ausente conserva lo guardado o default, null = default, Reventa lo ignora', () => {
  const body = { minorista: T, pack: T, bulto: T };
  const guardado = cfgEsq.validarMargenes({ ...body, mayorista: { descPackPct: 12.5, descBultoPct: 0 } }, {}, 'fraccionado');
  assert.deepStrictEqual(guardado.mayorista, { descPackPct: 12.5, descBultoPct: 0 });
  assert.deepStrictEqual(cfgEsq.validarMargenes(body, guardado, 'fraccionado').mayorista, guardado.mayorista);
  assert.deepStrictEqual(cfgEsq.validarMargenes(body, {}, 'fraccionado').mayorista, { descPackPct: 10, descBultoPct: 10 });
  assert.deepStrictEqual(cfgEsq.validarMargenes({ ...body, mayorista: null }, guardado, 'fraccionado').mayorista, { descPackPct: 10, descBultoPct: 10 });
  assert.strictEqual('mayorista' in cfgEsq.validarMargenes({ ...body, mayorista: { descPackPct: 5, descBultoPct: 5 } }, {}, 'almacen'), false);
  for (const v of [-1, 100, NaN, Infinity, '10', null]) {
    assert.throws(() => cfgEsq.validarMargenes({ ...body, mayorista: { descPackPct: v, descBultoPct: 10 } }, {}, 'fraccionado'), /mayorista\.descPackPct/, String(v));
    assert.throws(() => cfgEsq.validarMargenes({ ...body, mayorista: { descPackPct: 10, descBultoPct: v } }, {}, 'fraccionado'), /mayorista\.descBultoPct/, String(v));
  }
  assert.throws(() => cfgEsq.validarMargenes({ ...body, mayorista: [] }, {}, 'fraccionado'), /mayorista/);
  // Tablas pack/bulto opcionales en Fraccionado: sin ellas no es error; si estaban guardadas se conservan; si vienen se validan.
  const soloMin = cfgEsq.validarMargenes({ minorista: T }, {}, 'fraccionado');
  assert.deepStrictEqual(['pack' in soloMin, 'bulto' in soloMin, 'minorista' in soloMin], [false, false, true]);
  assert.deepStrictEqual(cfgEsq.validarMargenes({ minorista: T }, guardado, 'fraccionado').pack, guardado.pack);
  assert.throws(() => cfgEsq.validarMargenes({ minorista: T, pack: { minPct: 1 } }, {}, 'fraccionado'), /pack/);
  assert.throws(() => cfgEsq.validarMargenes({ pack: T, bulto: T }, {}, 'fraccionado'), /minorista/);
  assert.throws(() => cfgEsq.validarMargenes({ minorista: T }, {}, 'almacen'), /pack/); // Reventa: siguen obligatorias
  assert.deepStrictEqual(cfgEsq.configEsquemaDe({ fraccionado: { margenes: body } }, 'fraccionado').margenes.mayorista, { descPackPct: 10, descBultoPct: 10 });
});

// Ejemplo de control de la spec: costoCG 1000, margen 40 %, extras 0, IVA 21 %, redondeo 50.
const T40 = { minPct: 40, maxPct: 40, escalones: 1, rango: { desde: 1, hasta: 2 } };
const CFG_CTRL = { ivaVentaPct: 21, toleranciaPct: 5, modoGastos: 'costo', gastosVenta: [], extrasMinorista: [],
  margenes: { minorista: T40, pack: T40, bulto: T40 }, redondeo: { minorista: 50, packNeto: 50, packIva: 50, bultoNeto: 50, bultoIva: 50 } };
const ctrl = (extra = {}) => E.preciosCanales({ tipo: 'fraccionado', costo: 1000, unidades: { pack: 25, bulto: 25 }, cfg: CFG_CTRL, variante: 'mayorista', ...extra });

test('preciosCanales mayorista: ejemplo de control (defaults 10/10), cadena pack→bulto y redondeo', () => {
  const r = ctrl();
  assert.strictEqual(r.minorista.conExtras, 1400);
  // La presentación mayorista vale el bulto $/kg SIN IVA: 1400 × 0,9 × 0,9 = 1134 → paso 50 → 1150; pack 1260 → 1250 (con IVA 1500).
  assert.deepStrictEqual([r.minorista.exacto, r.minorista.precio, r.minorista.margenPct, r.minorista.sinIva], [1134, 1150, 13.4, true]);
  assert.deepStrictEqual(r.minorista.minoristaOriginal, { margenPct: 40, exacto: 1694, precio: 1700, neto: 1404.96 });
  const { pack: pk, bulto: bu } = r.minorista.mayorista;
  assert.deepStrictEqual([pk.neto, pk.precio, pk.conIva, pk.margenPct], [1260, 1250, 1500, 26]);
  assert.deepStrictEqual([bu.neto, bu.precio, bu.exactoIva, bu.conIva], [1134, 1150, 1372.14, 1350]);
  // Alinea contra el vigente pasado a neto: 1391,5 / 1,21 = 1150 → queda 1150; Δ% en el listado, ver abajo.
  assert.strictEqual(ctrl({ vigentes: { minorista: 1391.5 } }).minorista.vigenteNeto, 1150);
  assert.deepStrictEqual([r.pack.netoUnidad, r.pack.exactoNeto, r.pack.neto, r.pack.exactoIva, r.pack.conIva], [1260, 31500, 31500, 38115, 38100]);
  assert.deepStrictEqual([r.bulto.netoUnidad, r.bulto.exactoNeto, r.bulto.neto, r.bulto.exactoIva, r.bulto.conIva], [1134, 28350, 28350, 34303.5, 34300]);
  assert.strictEqual(r.pack.margenPct, 26);
  assert.strictEqual(r.pack.descuentoMayoristaPct, 10);
  const m = d => ({ cfg: { ...CFG_CTRL, margenes: { ...CFG_CTRL.margenes, mayorista: d } } });
  const r15 = ctrl(m({ descPackPct: 15, descBultoPct: 10 }));
  assert.strictEqual(r15.pack.netoUnidad, 1190);
  assert.strictEqual(r15.bulto.netoUnidad, 1071); // 1400 × 0,85 × 0,9: del pack exacto
  assert.strictEqual(ctrl(m({ descPackPct: 0, descBultoPct: 0 })).pack.netoUnidad, 1400);
  assert.strictEqual(r.minorista.tipoMayorista, 'bulto'); // variante 'mayorista' (vieja) ≡ bulto
  const { margenPct: _m, exacto: _e, precio: _p, descuentoMayoristaPct: _d, calculoMayorista: _c, minoristaOriginal: _o, mayorista: _y, sinIva: _s, vigenteNeto: _v, tipoMayorista: _t, ...resto } = r.minorista;
  const { margenPct: _m2, exacto: _e2, precio: _p2, ...restoMin } = E.preciosCanales({ tipo: 'fraccionado', costo: 1000, cfg: CFG_CTRL }).minorista;
  assert.deepStrictEqual(resto, restoMin); // la base (neto, extras) es la del minorista
});

test('preciosCanales mayorista: margenProducto fijo del canal gana; minorista/otro tipo no cambian', () => {
  const r = ctrl({ margenProducto: { modo: 'fijo', pack: 50 } });
  assert.strictEqual(r.pack.netoUnidad, 1500);
  assert.strictEqual(r.bulto.netoUnidad, 1134);
  const base = { tipo: 'fraccionado', costo: 1000, unidades: { pack: 25, bulto: 25 }, cfg: CFG_CTRL };
  // Fraccionado minorista: los vinculados también salen por descuento (tablas pack/bulto ya no se usan).
  assert.strictEqual(E.preciosCanales(base).pack.netoUnidad, 1260);
  assert.strictEqual(E.preciosCanales(base).bulto.netoUnidad, 1134);
  assert.deepStrictEqual(E.preciosCanales({ ...base, tipo: 'almacen', variante: 'mayorista' }), E.preciosCanales({ ...base, tipo: 'almacen' }));
});

test('preciosCanales tipo pack vs bulto: el sugerido es el pack o el bulto sin IVA; ambos informativos', () => {
  const pk = ctrl({ variante: 'pack' }).minorista, bu = ctrl({ variante: 'bulto' }).minorista;
  assert.deepStrictEqual([pk.tipoMayorista, pk.exacto, pk.precio, pk.margenPct, pk.descuentoMayoristaPct, pk.sinIva], ['pack', 1260, 1250, 26, 10, true]);
  assert.deepStrictEqual([bu.tipoMayorista, bu.exacto, bu.precio, bu.margenPct], ['bulto', 1134, 1150, 13.4]);
  assert.deepStrictEqual(pk.mayorista, bu.mayorista);
  assert.deepStrictEqual(ctrl({ variante: 'mayorista' }).minorista, bu);
  assert.strictEqual(ctrl({ variante: 'minorista' }).minorista.tipoMayorista, undefined);
  assert.strictEqual(ctrl({ variante: 'pack', vigentes: { minorista: 1512.5 } }).minorista.precio, 1250); // alinea al vigente neto
});

test('Fraccionado sin tablas pack/bulto: calcula igual (descuentos × unidades); Reventa sin cambios', () => {
  const sin = { ...CFG_CTRL, margenes: { minorista: T40 } };
  const r = E.preciosCanales({ tipo: 'fraccionado', costo: 1000, unidades: { pack: 1, bulto: 3 }, cfg: sin });
  assert.strictEqual(r.error, null);
  // caso de control: base 1400, pack 1260/kg, bulto 1134/kg, × unidades
  assert.deepStrictEqual([r.minorista.conExtras, r.pack.netoUnidad, r.bulto.netoUnidad, r.bulto.exactoNeto], [1400, 1260, 1134, 3402]);
  assert.deepStrictEqual(E.preciosCanales({ tipo: 'fraccionado', costo: 1000, unidades: { pack: 1 }, cfg: CFG_CTRL }).pack,
    E.preciosCanales({ tipo: 'fraccionado', costo: 1000, unidades: { pack: 1 }, cfg: sin }).pack); // la tabla guardada no influye
  assert.strictEqual(E.preciosCanales({ tipo: 'almacen', costo: 1000, cfg: sin }).error, 'margen');
  assert.strictEqual(E.preciosCanales({ tipo: 'almacen', costo: 1000, unidades: { pack: 1 }, cfg: CFG_CTRL }).pack.netoUnidad, 1400);
  assert.strictEqual(E.preciosCanales({ tipo: 'fraccionado', costo: 1000, cfg: { ...sin, margenes: { minorista: T40, pack: { minPct: 1 } } } }).error, 'margen');
});

test('preciosCanales mayorista: margen fijo del minorista gana (sin descuento); ajuste por peso entra en la base', () => {
  const fijo = ctrl({ margenProducto: { modo: 'fijo', minorista: 50 } }).minorista;
  assert.strictEqual(fijo.mayorista, undefined);
  assert.strictEqual(fijo.margenPct, 50);
  const ap = { ...CFG_CTRL, margenes: { ...CFG_CTRL.margenes, ajustesPeso: { tramosG: [100, 1000], puntos: [10, 10] } } };
  const r = E.preciosCanales({ tipo: 'fraccionado', costo: 1000, pesoG: 500, cfg: ap, variante: 'mayorista' }).minorista;
  assert.strictEqual(r.mayorista.base, r.conExtras);
  assert.strictEqual(r.mayorista.bulto.neto, Math.round(r.conExtras * 0.81 * 100) / 100);
  assert.notStrictEqual(r.conExtras, 1400); // el ajuste entró
});

test('fila mayorista: Δ% contra el vigente sin IVA', () => {
  const fila = L.filaProducto({ plu: '1', nombre: 'X 25Kg', tipo: 'fraccionado', costos: { sistema: 1000, ultimaCompra: null, manual: null },
    vigente: 1210, cfg: CFG_CTRL, variante: 'mayorista' });
  const m = fila.sugeridos.sistema.minorista;
  assert.strictEqual(m.vigenteNeto, 1000);
  assert.strictEqual(m.precio, 1150);
  assert.strictEqual(m.deltaPct, 15); // 1150 vs 1000, no vs 1210
});

test('listadoFraccionado: con config mayorista los precios son idénticos; la fila trae mayorista/mayoristaOrigen', () => {
  const presentaciones = [{ plu: '701', nombre: 'Chia 500G' }, { plu: '702', nombre: 'Chia 5Kg' }, { plu: '703', nombre: 'Chia suelta' }, { plu: '704', nombre: 'Chia 10Kg' }];
  const costos = new Map([['700', { nombre: 'Chia granel', costoSistema: 1000 }]]);
  const grupos = [{ plu: '700', nombre: 'Chia granel', subrubroId: null, subrubro: null, presentaciones }];
  const mayoristasDe = L.crearMayoristasDe({ vinculos: [], vigentes: new Map() });
  const listar = f => L.listadoFraccionado({ grupos, costos, vigentes: new Map(), costeo: {}, cfg: CFG,
    costeoF: f ? FC.normalizarCosteoFraccionado(f) : null, mayoristasDe })[0];
  const antes = listar({ costoHora: 6000 });
  const despues = listar({ costoHora: 6000, mayorista: { pesoMinG: 5000, porPlu: { 704: false } } });
  const sinCampos = fila => fila.presentaciones.map(({ mayorista: _m, mayoristaOrigen: _o, ...p }) => p);
  // Regresión: sin umbral ni marcas en true, precios idénticos a hoy.
  assert.deepStrictEqual(sinCampos(listar({ costoHora: 6000, mayorista: { pesoMinG: null, porPlu: { 704: false } } })), sinCampos(antes));
  // Las minoristas no cambian; la mayorista (702) pasa a bulto sin IVA, con pack/bulto y minoristaOriginal.
  const por = (fila, plu) => fila.presentaciones.find(p => p.plu === plu);
  for (const plu of ['701', '703', '704']) assert.deepStrictEqual(por(despues, plu).sugeridos, por(antes, plu).sugeridos);
  const m702 = por(despues, '702').sugeridos.sistema.minorista;
  assert.strictEqual(m702.minoristaOriginal, por(antes, '702').sugeridos.sistema.minorista.precio);
  assert.ok(m702.sinIva && m702.precio === m702.bulto.neto && m702.precio < m702.minoristaOriginalNeto && m702.pack.neto > m702.precio);
  assert.ok(despues.presentaciones.some(p => p.sugeridos.sistema)); // hay precios que comparar
  const porPlu = Object.fromEntries(despues.presentaciones.map(p => [p.plu, [p.mayorista, p.mayoristaOrigen]]));
  assert.deepStrictEqual(porPlu, { 701: [false, null], 702: [true, 'peso'], 703: [false, null], 704: [false, 'manual'] });
  assert.ok(antes.presentaciones.every(p => p.mayorista === false && p.mayoristaOrigen === null));
  assert.ok(listar(null).presentaciones.every(p => p.mayorista === false && p.mayoristaOrigen === null)); // sin migrar
  assert.strictEqual(L.filaPublica(despues).presentaciones.find(p => p.plu === '702').mayorista, true); // viaja público
});

test('listadoFraccionado con vínculos: TODOS los pack/bulto vinculados usan los descuentos; tipo pack/bulto por presentación', () => {
  const presentaciones = [{ plu: '701', nombre: 'Chia 500G' }, { plu: '702', nombre: 'Chia 5Kg' }];
  const costos = new Map([['700', { nombre: 'Chia granel', costoSistema: 1000 }]]);
  const grupos = [{ plu: '700', nombre: 'Chia granel', subrubroId: null, subrubro: null, presentaciones }];
  const vinculos = ['700', '701', '702'].map((b, i) => ({ plu: `9${i}`, nombre: `Pack ${b}`, basePlu: b, cantidad: 1, tipo: 'pack' }));
  const mayoristasDe = L.crearMayoristasDe({ vinculos, vigentes: new Map() });
  const listar = may => L.listadoFraccionado({ grupos, costos, vigentes: new Map(), costeo: {}, cfg: CFG,
    costeoF: FC.normalizarCosteoFraccionado({ costoHora: 6000, ...(may ? { mayorista: may } : {}) }), mayoristasDe })[0];
  const antes = listar(null), despues = listar({ pesoMinG: 5000, porPlu: {} });
  const sug = (fila, plu) => (plu === '700' ? fila : fila.presentaciones.find(p => p.plu === plu)).sugeridos.sistema;
  assert.deepStrictEqual(sug(despues, '700'), sug(antes, '700')); // vinculado al granel: igual
  assert.deepStrictEqual(sug(despues, '701'), sug(antes, '701')); // presentación minorista: igual
  for (const [b, v] of [['700', '90'], ['701', '91']]) { // vinculados al granel y a una minorista: también por descuento
    const s = sug(antes, b);
    assert.strictEqual(s.desglose.porVinculo[v].descuentoMayoristaPct, 10);
    assert.strictEqual(s.desglose.porVinculo[v].netoUnidad, Math.round(s.desglose.minorista.conExtras * 0.9 * 100) / 100);
  }
  const d = sug(despues, '702');
  assert.strictEqual(d.minorista.minoristaOriginal, sug(antes, '702').minorista.precio);
  const pack = d.desglose.porVinculo['92'];
  assert.strictEqual(pack.descuentoMayoristaPct, 10);
  assert.strictEqual(pack.netoUnidad, Math.round(d.desglose.minorista.conExtras * 0.9 * 100) / 100);
  assert.deepStrictEqual(d.mayoristas, sug(antes, '702').mayoristas); // el vinculado no depende de la marca de su base
  assert.strictEqual(despues.presentaciones.find(p => p.plu === '702').mayoristaTipo, 'bulto');
  const conPack = listar({ pesoMinG: null, porPlu: { 702: 'pack' } });
  const p702 = conPack.presentaciones.find(p => p.plu === '702');
  assert.strictEqual(p702.mayoristaTipo, 'pack');
  assert.strictEqual(p702.sugeridos.sistema.minorista.tipoMayorista, 'pack');
  assert.strictEqual(p702.sugeridos.sistema.minorista.precio, p702.sugeridos.sistema.minorista.pack.neto);
  assert.strictEqual(L.filaPublica(conPack).presentaciones.find(p => p.plu === '702').mayoristaTipo, 'pack');
  assert.strictEqual(antes.presentaciones.find(p => p.plu === '702').mayoristaTipo, null);
});

function appCon(costeo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fracc-mayorista-'));
  const archivo = path.join(dir, 'costeo.json');
  fs.writeFileSync(archivo, JSON.stringify(costeo));
  const leerJSON = (p, def) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; } };
  const guardarJSON = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2));
  const apiRoute = fn => async (req, res) => { try { res.json(await fn(req)); } catch (err) { res.status(500).json({ error: err.message }); } };
  const app = express();
  app.use(express.json());
  app.use(crearRutas({ apiRoute, query: async () => [], leerJSON, guardarJSON, DATA_DIR: dir, LISTA_PRECIOS_VENTA: 0, FORMULA_ACTIVA_SQL: '1=1', SIN_FORMULA_GENERICO_SQL: '1=1' }));
  const server = app.listen(0);
  const pedir = async (metodo, ruta, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${ruta}`,
      { method: metodo, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return res.json();
  };
  return { pedir, leer: () => JSON.parse(fs.readFileSync(archivo, 'utf8')), cerrar: () => server.close() };
}
const BASE = '/api/precios/config/esquema/fraccionado';

test('PUT/GET mayorista: guarda, la vista lo trae, inválido no escribe, vacío saca la clave, el resto queda', async () => {
  const a = appCon({ fraccionado: { costoHora: 6000, maquinas: [], porGranel: { 100: { minKg: 2 } } } });
  try {
    assert.deepStrictEqual((await a.pedir('GET', BASE)).mayorista, { pesoMinG: null, porPlu: {} });
    const r = await a.pedir('PUT', `${BASE}/mayorista`, { pesoMinG: 5000, porPlu: { 701: true } });
    assert.deepStrictEqual(r.mayorista, { pesoMinG: 5000, porPlu: { 701: 'bulto' } }); // true se guarda 'bulto'
    assert.deepStrictEqual(a.leer().fraccionado.mayorista, { pesoMinG: 5000, porPlu: { 701: 'bulto' } });
    const r2 = await a.pedir('PUT', `${BASE}/mayorista`, { porPlu: { 702: 'pack', 703: false } });
    assert.deepStrictEqual(r2.mayorista, { pesoMinG: 5000, porPlu: { 701: 'bulto', 702: 'pack', 703: false } });
    await a.pedir('PUT', `${BASE}/mayorista`, { porPlu: { 702: null, 703: null } }); // null = automático
    assert.deepStrictEqual(a.leer().fraccionado.porGranel, { 100: { minKg: 2 } });
    const antes = a.leer();
    assert.match((await a.pedir('PUT', `${BASE}/mayorista`, { pesoMinG: 5, porPlu: { abc: true } })).error, /PLU/);
    assert.match((await a.pedir('PUT', `${BASE}/mayorista`, { pesoMinG: -1 })).error, /pesoMinG/);
    assert.deepStrictEqual(a.leer(), antes);
    assert.match((await a.pedir('PUT', `${BASE}/mayorista`, { porPlu: { 701: 'caja' } })).error, /pack/);
    assert.deepStrictEqual(a.leer(), antes);
    assert.deepStrictEqual((await a.pedir('GET', BASE)).mayorista, { pesoMinG: 5000, porPlu: { 701: 'bulto' } });
    await a.pedir('PUT', `${BASE}/mayorista`, { pesoMinG: null, porPlu: { 701: null } });
    assert.strictEqual('mayorista' in a.leer().fraccionado, false);
  } finally { a.cerrar(); }
});

test('PUT mayorista sin migrar: error y no escribe', async () => {
  const a = appCon({ ivaVentaPct: 21 });
  try {
    assert.match((await a.pedir('PUT', `${BASE}/mayorista`, { pesoMinG: 5000 })).error, /migrar_config_fraccionado/);
    assert.strictEqual(a.leer().fraccionado, undefined);
  } finally { a.cerrar(); }
});
