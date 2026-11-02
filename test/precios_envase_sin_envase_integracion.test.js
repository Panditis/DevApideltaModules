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

test('front→router real: quitar con productos = sinEnvase+oculto; GET / y /costeo lo devuelven', async () => {
  const a = appCon(FRACC({ 500: { bolsaPlu: '900', bobinaG: 8 }, 250: { bolsaPlu: '901' } }));
  try {
    const epp = { 500: { bolsaPlu: '900', bobinaG: 8 }, 250: { bolsaPlu: '901' } };
    const body = cuerpo('', [fila(250, '901')], null, epp, PESOS);
    assert.deepStrictEqual(body, { pesos: { 500: { sinEnvase: true, oculto: true } } });
    const r = await a.pedir('PUT', `${BASE}/envase`, body);
    assert.ok(r.status === 200 && !r.error, r.error);
    assert.deepStrictEqual(a.epp(), { 250: { bolsaPlu: '901' }, 500: { sinEnvase: true, oculto: true } });
    assert.deepStrictEqual((await a.pedir('GET', BASE)).envasePorPeso[500], { sinEnvase: true, oculto: true });
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

test('PUT envase oculto: marcar, conservar, sacar, errores, atomicidad, GET y 403', async () => {
  const a = appCon(FRACC({ 500: { sinEnvase: true }, 250: { bolsaPlu: '901' } }));
  const put = async pesos => (await a.pedir('PUT', `${BASE}/envase`, { pesos })).error;
  try {
    assert.strictEqual(await put({ 500: { oculto: true } }), undefined);
    assert.deepStrictEqual(a.epp()[500], { sinEnvase: true, oculto: true });
    assert.deepStrictEqual((await a.pedir('GET', BASE)).envasePorPeso[500], { sinEnvase: true, oculto: true });
    assert.strictEqual((await a.pedir('GET', `${BASE}/costeo`)).envasePorPeso[500].oculto, true);
    // sinEnvase: true sin oculto conserva el oculto que tenía
    await put({ 500: { sinEnvase: true } });
    assert.deepStrictEqual(a.epp()[500], { sinEnvase: true, oculto: true });
    // oculto false solo: vuelve a la tabla marcada
    await put({ 500: { oculto: null } });
    assert.deepStrictEqual(a.epp()[500], { sinEnvase: true });
    await put({ 500: { sinEnvase: true, oculto: true } });
    // errores: todo o nada
    const antes = a.epp();
    for (const [pesos, re] of [
      [{ 250: { oculto: true } }, /peso 250: oculto solo vale junto con sinEnvase/],
      [{ 500: { sinEnvase: false, oculto: true } }, /oculto solo vale junto con sinEnvase/],
      [{ 500: { oculto: 'si' } }, /peso 500: oculto debe ser true, false o null/],
      [{ 500: { oculto: false }, 0: { bolsaPlu: '1' } }, /peso inválido/]]) {
      assert.match(await put(pesos), re);
      assert.deepStrictEqual(a.epp(), antes);
    }
    // sinEnvase false saca ambos; cargar bolsa saca ambos; null/null borra la entrada
    await put({ 500: { sinEnvase: false } });
    assert.ok(!(500 in a.epp()));
    await put({ 500: { sinEnvase: true, oculto: true } });
    await put({ 500: { bolsaPlu: '905' } });
    assert.deepStrictEqual(a.epp()[500], { bolsaPlu: '905' });
    await put({ 500: { sinEnvase: true, oculto: true } });
    await put({ 500: { bolsaPlu: null, bobinaG: null } });
    assert.ok(!(500 in a.epp()));
  } finally { a.cerrar(); }
  const b = appCon(FRACC({ 500: { sinEnvase: true } }), { sinConfig: true });
  try {
    assert.strictEqual((await b.pedir('PUT', `${BASE}/envase`, { pesos: { 500: { oculto: true } } })).status, 403);
    assert.deepStrictEqual(b.epp(), { 500: { sinEnvase: true } });
  } finally { b.cerrar(); }
});

test('normalización y costeo con oculto: se descarta sin sinEnvase; costeo igual con y sin oculto', () => {
  const n = epp => normalizarCosteoFraccionado({ costoHora: 6000, maquinas: [], porGranel: { 100: { minKg: 2 } }, envasePorPeso: epp });
  assert.deepStrictEqual(n({ 500: { oculto: true }, 250: { bolsaPlu: '9', oculto: true }, 750: { sinEnvase: true, oculto: 'si' } }).envasePorPeso,
    { 250: { bolsaPlu: '9' }, 750: { sinEnvase: true } });
  const con = costearPresentacion({ pesoG: 500, granel: { plu: '100' }, cf: n({ 500: { sinEnvase: true, oculto: true } }) });
  const sin = costearPresentacion({ pesoG: 500, granel: { plu: '100' }, cf: n({ 500: { sinEnvase: true } }) });
  assert.deepStrictEqual(con, sin);
});

test('front→router real con la casilla: marcar, destildar, ✕, volver a poner marcado, fila nueva y mezcla; GET devuelve los flags', async () => {
  const inicial = { 100: { bolsaPlu: '900' }, 250: { sinEnvase: true }, 500: { sinEnvase: true, oculto: true }, 750: { bobinaG: 10 } };
  const a = appCon(FRACC(inicial));
  const P = [{ pesoG: 100, presentaciones: 1 }, ...PESOS];
  const conSin = (f, sin = true) => ({ ...f, sin });
  try {
    // 100 con bolsa → casilla (la bolsa se borra); 250 casilla destildada con bolsa nueva; 500 quitado vuelto a poner y marcado;
    // 750 sin productos quitado con ✕; 300 fila nueva con casilla
    const body = cuerpo('', [conSin(fila(100, '900')), conSin(fila(250, '904'), false), conSin(fila(500)),
      { nuevo: 'n1', ...conSin(fila('300')) }], null, inicial, P);
    assert.deepStrictEqual(body, { pesos: {
      100: { sinEnvase: true }, 250: { sinEnvase: false, bolsaPlu: '904', bobinaG: null },
      300: { sinEnvase: true }, 500: { sinEnvase: true, oculto: false }, 750: { bolsaPlu: null, bobinaG: null } } });
    const r = await a.pedir('PUT', `${BASE}/envase`, body);
    assert.ok(r.status === 200 && !r.error, r.error);
    const esperado = { 100: { sinEnvase: true }, 250: { bolsaPlu: '904' }, 300: { sinEnvase: true }, 500: { sinEnvase: true } };
    assert.deepStrictEqual(a.epp(), esperado);
    const g = (await a.pedir('GET', BASE)).envasePorPeso;
    assert.deepStrictEqual([g[100], g[500], g[750]], [{ sinEnvase: true }, { sinEnvase: true }, undefined]);
    // ✕ de 100 (con productos, casilla guardada) → { sinEnvase, oculto }; casilla sin cambios en 500 no se manda
    const body2 = cuerpo('', [fila(250, '904'), conSin(fila(300)), conSin(fila(500))], null, esperado, P);
    assert.deepStrictEqual(body2, { pesos: { 100: { sinEnvase: true, oculto: true } } });
    assert.strictEqual((await a.pedir('PUT', `${BASE}/envase`, body2)).error, undefined);
    assert.deepStrictEqual(a.epp()[100], { sinEnvase: true, oculto: true });
    const c = (await a.pedir('GET', `${BASE}/costeo`)).envasePorPeso;
    assert.deepStrictEqual([c[100].oculto, c[500].oculto, c[500].sinEnvase], [true, undefined, true]);
  } finally { a.cerrar(); }
});
