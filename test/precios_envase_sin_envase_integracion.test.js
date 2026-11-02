'use strict';
// Contrato front↔back de "quitar peso con productos" (sinEnvase): los cuerpos que arma cuerpoCambiosEnvaseFr
// (public/js/precios_config_envase.js, cargado en un vm) van al PUT /envase REAL (routes/rutas_precios_fraccionado.js)
// y se mira lo guardado en costeo.fraccionado.envasePorPeso y lo que devuelven GET / y GET /costeo.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const crearRutas = require('../routes/rutas_precios_fraccionado');
const { crearGuardPrecios } = require('../lib/precios_permisos');
const { costearPresentacion, normalizarCosteoFraccionado } = require('../lib/precios_fraccionado_costo');

const BASE = '/api/precios/config/esquema/fraccionado';
const numOrNull = v => { const s = String(v ?? '').trim(); if (s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
const ctx = vm.createContext({ module: { exports: {} }, numOrNull });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/precios_config_envase.js'), 'utf8'), ctx);
const cuerpo = (...a) => JSON.parse(JSON.stringify(vm.runInContext('cuerpoCambiosEnvaseFr', ctx)(...a)) ?? 'null');

function appCon(costeo, { sinConfig = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fracc-sinenv-'));
  const archivo = path.join(dir, 'costeo.json');
  fs.writeFileSync(archivo, JSON.stringify(costeo));
  const leerJSON = (p, def) => { try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : def; } catch { return def; } };
  const guardarJSON = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2));
  const apiRoute = fn => async (req, res) => { try { res.json(await fn(req)); } catch (err) { res.status(500).json({ error: err.message }); } };
  const app = express();
  app.use(express.json());
  if (sinConfig != null) app.use(crearGuardPrecios({ tienePermiso: () => !sinConfig }));
  app.use(crearRutas({ apiRoute, query: async () => [], leerJSON, guardarJSON, DATA_DIR: dir, LISTA_PRECIOS_VENTA: 0, FORMULA_ACTIVA_SQL: '1=1', SIN_FORMULA_GENERICO_SQL: '1=1' }));
  let server;
  const pedir = async (metodo, ruta, body) => {
    if (!server) server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const res = await fetch(`http://127.0.0.1:${server.address().port}${ruta}`,
      { method: metodo, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, ...(await res.json()) };
  };
  return { pedir, epp: () => JSON.parse(fs.readFileSync(archivo, 'utf8')).fraccionado.envasePorPeso, cerrar: () => server && server.close() };
}
const FRACC = epp => ({ fraccionado: { costoHora: 6000, maquinas: [], envasePorPeso: epp } });
// pesos = cfFr.pesos (500 y 250 con productos; 750 sin)
const PESOS = [{ pesoG: 250, presentaciones: 3 }, { pesoG: 500, presentaciones: 34 }];
const fila = (pesoG, plu = '', g = '') => ({ pesoG, plu, g });

test('front→router real: quitar con productos = sinEnvase:true; GET / y /costeo lo devuelven', async () => {
  const a = appCon(FRACC({ 500: { bolsaPlu: '900', bobinaG: 8 }, 250: { bolsaPlu: '901' } }));
  try {
    const epp = { 500: { bolsaPlu: '900', bobinaG: 8 }, 250: { bolsaPlu: '901' } };
    const body = cuerpo('', [fila(250, '901')], null, epp, PESOS);
    assert.deepStrictEqual(body, { pesos: { 500: { sinEnvase: true } } });
    const r = await a.pedir('PUT', `${BASE}/envase`, body);
    assert.ok(r.status === 200 && !r.error, r.error);
    assert.deepStrictEqual(a.epp(), { 250: { bolsaPlu: '901' }, 500: { sinEnvase: true } });
    assert.deepStrictEqual((await a.pedir('GET', BASE)).envasePorPeso[500], { sinEnvase: true });
    const c = await a.pedir('GET', `${BASE}/costeo`);
    assert.strictEqual(c.envasePorPeso[500].sinEnvase, true);
    assert.ok(!('bolsaPlu' in c.envasePorPeso[500]) && !('bobinaG' in c.envasePorPeso[500]));
  } finally { a.cerrar(); }
});

test('front→router real: quitar sin productos = null/null borra; volver a poner con bolsa y vacío; mezcla en un PUT', async () => {
  const a = appCon(FRACC({ 750: { bobinaG: 10 }, 500: { sinEnvase: true }, 250: { sinEnvase: true } }));
  try {
    const epp = { 750: { bobinaG: 10 }, 500: { sinEnvase: true }, 250: { sinEnvase: true } };
    // 750 quitado (sin productos), 500 vuelto a poner con bolsa 902, 250 vuelto a poner vacío
    const body = cuerpo('', [fila(250), fila(500, '902')], null, epp, PESOS);
    assert.deepStrictEqual(body, { pesos: {
      250: { sinEnvase: false, bolsaPlu: null, bobinaG: null },
      500: { sinEnvase: false, bolsaPlu: '902', bobinaG: null },
      750: { bolsaPlu: null, bobinaG: null } } });
    const r = await a.pedir('PUT', `${BASE}/envase`, body);
    assert.ok(r.status === 200 && !r.error, r.error);
    assert.deepStrictEqual(a.epp(), { 500: { bolsaPlu: '902' } }); // 250 queda sin entrada: vuelve a avisar sinBolsa
  } finally { a.cerrar(); }
});

test('PUT envase por HTTP: sinEnvase+bolsa, tipo inválido u otro peso inválido → { error } y no escribe nada', async () => {
  const inicial = { 500: { bolsaPlu: '900' } };
  const a = appCon(FRACC(inicial));
  try {
    for (const [pesos, re] of [
      [{ 500: { sinEnvase: true, bolsaPlu: '900' } }, /sinEnvase no puede ir junto/],
      [{ 500: { sinEnvase: true, bobinaG: 8 } }, /sinEnvase no puede ir junto/],
      [{ 500: { sinEnvase: 'si' } }, /sinEnvase debe ser true, false o null/],
      [{ 500: { sinEnvase: 1 } }, /sinEnvase debe ser true, false o null/],
      [{ 250: { sinEnvase: true }, 0: { bolsaPlu: '1' } }, /peso inválido/],
      [{ 250: { sinEnvase: true }, 750: { bolsaPlu: 'abc' } }, /bolsaPlu/]]) {
      const r = await a.pedir('PUT', `${BASE}/envase`, { pesos });
      assert.strictEqual(r.status, 200, JSON.stringify(pesos)); // convención del router: error de validación = 200 + { error }
      assert.match(r.error, re);
      assert.deepStrictEqual(a.epp(), inicial);
    }
    // sinEnvase con bolsa/bobina vacías vale (como manda un front que limpia los campos)
    assert.strictEqual((await a.pedir('PUT', `${BASE}/envase`, { pesos: { 500: { sinEnvase: true, bolsaPlu: null, bobinaG: '' } } })).error, undefined);
    assert.deepStrictEqual(a.epp(), { 500: { sinEnvase: true } });
    // cargar bolsa sin mandar sinEnvase lo des-marca; {} no toca
    assert.strictEqual((await a.pedir('PUT', `${BASE}/envase`, { pesos: { 500: {} } })).status, 200);
    assert.deepStrictEqual(a.epp(), { 500: { sinEnvase: true } });
    await a.pedir('PUT', `${BASE}/envase`, { pesos: { 500: { bolsaPlu: '903' } } });
    assert.deepStrictEqual(a.epp(), { 500: { bolsaPlu: '903' } });
  } finally { a.cerrar(); }
});

test('sin permiso precios-config: PUT envase con sinEnvase da 403 y no escribe', async () => {
  const a = appCon(FRACC({ 500: { bolsaPlu: '900' } }), { sinConfig: true });
  try {
    assert.strictEqual((await a.pedir('PUT', `${BASE}/envase`, { pesos: { 500: { sinEnvase: true } } })).status, 403);
    assert.deepStrictEqual(a.epp(), { 500: { bolsaPlu: '900' } });
  } finally { a.cerrar(); }
});

test('costeo con lo que guardó el router: peso sinEnvase sale sin aviso de envase y con porUnidad; vecino sin entrada sí avisa', () => {
  const cf = normalizarCosteoFraccionado({ costoHora: 6000, maquinas: [], porGranel: { 100: { minKg: 2 } }, envasePorPeso: { 500: { sinEnvase: true } } });
  const sin = costearPresentacion({ pesoG: 500, granel: { plu: '100' }, cf });
  assert.deepStrictEqual([sin.avisos.filter(x => /^sinBo/.test(x)), sin.porUnidad != null, sin.lineas.some(l => l.rol === 'insumo')], [[], true, false]);
  const otro = costearPresentacion({ pesoG: 250, granel: { plu: '100' }, cf });
  assert.ok(otro.avisos.includes('sinBolsa'));
  // entrada corrupta con flag Y bolsa: gana la bolsa (el flag no puede esconder un envase cargado)
  const mixto = normalizarCosteoFraccionado({ envasePorPeso: { 500: { sinEnvase: true, bolsaPlu: '900' } } });
  assert.deepStrictEqual(mixto.envasePorPeso[500], { bolsaPlu: '900' });
});
