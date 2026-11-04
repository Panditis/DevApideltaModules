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
  const cfg = { pesoMinG: 5000, porPlu: { 10: false, 20: true } };
  assert.deepStrictEqual(es(5000, '1', cfg), { mayorista: true, origen: 'peso' });
  assert.deepStrictEqual(es(4999, '1', cfg), { mayorista: false, origen: null });
  assert.deepStrictEqual(es(null, '1', cfg), { mayorista: false, origen: null });
  assert.deepStrictEqual(es(10000, '10', cfg), { mayorista: false, origen: 'manual' });
  assert.deepStrictEqual(es(100, '20', cfg), { mayorista: true, origen: 'manual' });
  assert.deepStrictEqual(es(null, '20', cfg), { mayorista: true, origen: 'manual' });
  const sinUmbral = { pesoMinG: null, porPlu: { 20: true } };
  assert.deepStrictEqual(es(100000, '1', sinUmbral), { mayorista: false, origen: null });
  assert.deepStrictEqual(es(100, '20', sinUmbral), { mayorista: true, origen: 'manual' });
  assert.deepStrictEqual(es(100000, '1', undefined), { mayorista: false, origen: null });
});

test('normalizar: sin clave queda igual que hoy; basura se descarta; vacío no crea la clave', () => {
  assert.strictEqual('mayorista' in FC.normalizarCosteoFraccionado({}), false);
  assert.strictEqual('mayorista' in FC.normalizarCosteoFraccionado({ mayorista: { pesoMinG: -1, porPlu: { x: true, 5: 'si' } } }), false);
  assert.deepStrictEqual(FC.normalizarCosteoFraccionado({ mayorista: { pesoMinG: 2.5, porPlu: { 5: true, abc: false } } }).mayorista,
    { pesoMinG: null, porPlu: { 5: true } });
});

test('aplicarMayorista: mezcla, null saca, vacío borra la config, inválidos tiran, no muta', () => {
  const previo = { pesoMinG: 5000, porPlu: { 1: true } };
  assert.deepStrictEqual(CF.aplicarMayorista(previo, { porPlu: { 2: false } }), { mayorista: { pesoMinG: 5000, porPlu: { 1: true, 2: false } } });
  assert.deepStrictEqual(CF.aplicarMayorista(previo, { pesoMinG: null }), { mayorista: { pesoMinG: null, porPlu: { 1: true } } });
  assert.deepStrictEqual(CF.aplicarMayorista(previo, { pesoMinG: '', porPlu: { 1: null } }), { mayorista: undefined });
  assert.deepStrictEqual(CF.aplicarMayorista(undefined, { pesoMinG: 1000000 }), { mayorista: { pesoMinG: 1000000, porPlu: {} } });
  for (const body of [{}, null, { pesoMinG: 0 }, { pesoMinG: -5 }, { pesoMinG: 2.5 }, { pesoMinG: 1000001 }, { pesoMinG: '500' },
    { porPlu: [] }, { porPlu: { abc: true } }, { porPlu: { 1234567890123: true } }, { porPlu: { 1: 'si' } }]) {
    assert.throws(() => CF.aplicarMayorista(previo, body), Error, JSON.stringify(body));
  }
  const muchos = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [String(i + 1), true]));
  assert.throws(() => CF.aplicarMayorista(undefined, { porPlu: muchos }), /máximo 1000/);
  assert.deepStrictEqual(previo, { pesoMinG: 5000, porPlu: { 1: true } });
});

test('margenes.mayorista: reservado; se valida si viene, ausente conserva lo guardado, null saca; Reventa lo ignora', () => {
  const body = { minorista: T, pack: T, bulto: T };
  const guardado = cfgEsq.validarMargenes({ ...body, mayorista: { minorista: T } }, {}, 'fraccionado');
  assert.deepStrictEqual(guardado.mayorista, { minorista: { minPct: 30, maxPct: 30, escalones: 1, rango: { desde: 1, hasta: 2 } } });
  assert.deepStrictEqual(cfgEsq.validarMargenes(body, guardado, 'fraccionado').mayorista, guardado.mayorista);
  assert.strictEqual('mayorista' in cfgEsq.validarMargenes({ ...body, mayorista: null }, guardado, 'fraccionado'), false);
  assert.strictEqual('mayorista' in cfgEsq.validarMargenes({ ...body, mayorista: { minorista: T } }, {}, 'almacen'), false);
  assert.throws(() => cfgEsq.validarMargenes({ ...body, mayorista: { minorista: { minPct: 'x' } } }, {}, 'fraccionado'), /mayorista\.minorista/);
  assert.throws(() => cfgEsq.validarMargenes({ ...body, mayorista: { otro: T } }, {}, 'fraccionado'), /canal otro/);
});

test('preciosCanales: variante mayorista da exactamente lo mismo que minorista (y que sin variante)', () => {
  const cfg = { ...CFG, margenes: { ...CFG.margenes, ajustesPeso: { tramosG: [500, 5000], puntos: [5, -3] } } };
  for (const pesoG of [null, 250, 500, 5000, 25000]) {
    const base = { tipo: 'fraccionado', costo: 1234.5, pesoG, unidades: { pack: 10, bulto: 25 }, vigentes: { minorista: 2000 }, cfg };
    const sin = E.preciosCanales(base);
    assert.deepStrictEqual(E.preciosCanales({ ...base, variante: 'mayorista' }), sin);
    assert.deepStrictEqual(E.preciosCanales({ ...base, variante: 'minorista' }), sin);
  }
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
  assert.deepStrictEqual(sinCampos(despues), sinCampos(antes));
  assert.ok(despues.presentaciones.some(p => p.sugeridos.sistema)); // hay precios que comparar
  const porPlu = Object.fromEntries(despues.presentaciones.map(p => [p.plu, [p.mayorista, p.mayoristaOrigen]]));
  assert.deepStrictEqual(porPlu, { 701: [false, null], 702: [true, 'peso'], 703: [false, null], 704: [false, 'manual'] });
  assert.ok(antes.presentaciones.every(p => p.mayorista === false && p.mayoristaOrigen === null));
  assert.ok(listar(null).presentaciones.every(p => p.mayorista === false && p.mayoristaOrigen === null)); // sin migrar
  assert.strictEqual(L.filaPublica(despues).presentaciones.find(p => p.plu === '702').mayorista, true); // viaja público
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
    assert.deepStrictEqual(r.mayorista, { pesoMinG: 5000, porPlu: { 701: true } });
    assert.deepStrictEqual(a.leer().fraccionado.mayorista, { pesoMinG: 5000, porPlu: { 701: true } });
    assert.deepStrictEqual(a.leer().fraccionado.porGranel, { 100: { minKg: 2 } });
    const antes = a.leer();
    assert.match((await a.pedir('PUT', `${BASE}/mayorista`, { pesoMinG: 5, porPlu: { abc: true } })).error, /PLU/);
    assert.match((await a.pedir('PUT', `${BASE}/mayorista`, { pesoMinG: -1 })).error, /pesoMinG/);
    assert.deepStrictEqual(a.leer(), antes);
    assert.deepStrictEqual((await a.pedir('GET', BASE)).mayorista, { pesoMinG: 5000, porPlu: { 701: true } });
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
