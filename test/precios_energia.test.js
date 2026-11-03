'use strict';
// Consumo eléctrico de máquinas de Fraccionado y valor de la energía (spec docs/specs/precios_maquinas_consumo_energia.md):
// motor, validadores, rutas HTTP reales con costeo.json temporal y SIGA falso, y UI (vm + cheerio).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const cheerio = require('cheerio');
const FC = require('../lib/precios_fraccionado_costo');
const CF = require('../lib/precios_config_fraccionado');
const cfgEsq = require('../lib/precios_config_esquema');

// ── Motor ──
// 2 min/kg × 0,5 kg = 1 min (sin tramos), MO 6000 $/h, máquina 3000 $/h con 2,5 kWh/h.
const cfDe = (maq = {}, extra = {}) => FC.normalizarCosteoFraccionado({ costoHora: 6000, subrubros: { 7: { minKg: 2 } },
  maquinas: [{ id: 'env', nombre: 'Envasadora', costoHora: 3000, ...maq }], porGranel: { 100: { maquinaId: 'env' } }, ...extra });
const costear = cf => FC.costearPresentacion({ pesoG: 500, granel: { plu: '100', subrubroId: '7' }, cf });

test('motor: 2,5 kWh/h × $120 × 1 min → línea energia costoUnit 300, importe 5, después de la máquina; suma a porUnidad y extraKg', () => {
  const sin = costear(cfDe());
  const c = costear(cfDe({ consumoKwhHora: 2.5 }, { valorEnergiaKwh: 120 }));
  assert.strictEqual(c.minutos, 1);
  assert.deepStrictEqual(c.lineas.map(l => l.rol), ['mo', 'maquina', 'energia']);
  const e = c.lineas[2];
  assert.deepStrictEqual([e.plu, e.nombre, e.cantidad, e.costoUnit, e.importe], [FC.CLAVE_ENERGIA, 'Energía', 1, 300, 5]);
  assert.strictEqual(Math.round((c.porUnidad - sin.porUnidad) * 100) / 100, 5);
  assert.strictEqual(Math.round((c.extraKg - sin.extraKg) * 100) / 100, 10);
  assert.ok(!c.avisos.includes('valorEnergia'));
});

test('motor: consumo sin valor → aviso valorEnergia, sin línea, mismo costo; valor 0 → línea en 0 sin aviso', () => {
  const sin = costear(cfDe());
  const s = costear(cfDe({ consumoKwhHora: 2.5 }));
  assert.deepStrictEqual([s.avisos.filter(x => x !== 'sinBolsa'), s.lineas.some(l => l.rol === 'energia'), s.porUnidad], [['valorEnergia'], false, sin.porUnidad]);
  const cero = costear(cfDe({ consumoKwhHora: 2.5 }, { valorEnergiaKwh: 0 }));
  assert.deepStrictEqual([cero.lineas.find(l => l.rol === 'energia').importe, cero.avisos.includes('valorEnergia'), cero.porUnidad], [0, false, sin.porUnidad]);
});

test('motor: consumo 0, sin consumo, sin máquina o sin minutos → sin línea ni aviso (el valor solo no cambia nada)', () => {
  const sin = costear(cfDe());
  for (const cf of [cfDe({ consumoKwhHora: 0 }), cfDe({}, { valorEnergiaKwh: 120 }), cfDe({ consumoKwhHora: 0 }, { valorEnergiaKwh: 120 })]) {
    const c = costear(cf);
    assert.deepStrictEqual([c.lineas.some(l => l.rol === 'energia'), c.avisos.includes('valorEnergia'), c.porUnidad], [false, false, sin.porUnidad]);
  }
  const sinMaq = costear(cfDe({ consumoKwhHora: 2.5 }, { valorEnergiaKwh: 120, porGranel: {} }));
  assert.ok(!sinMaq.lineas.some(l => l.rol === 'energia'));
  const sinMin = costear(cfDe({ consumoKwhHora: 2.5 }, { subrubros: {} }));
  assert.deepStrictEqual([sinMin.lineas.length, sinMin.avisos.includes('valorEnergia')], [0, false]);
});

test('normalizarCosteoFraccionado: valorEnergiaKwh negativo o texto → null; 0 vale', () => {
  assert.deepStrictEqual([-1, 'x', null, 0, 120.5].map(v => FC.normalizarCosteoFraccionado({ valorEnergiaKwh: v }).valorEnergiaKwh), [null, null, null, 0, 120.5]);
});

test('limpiarCosteo y fraccionadoConCambios no pierden valorEnergiaKwh; propiasFraccionado lo expone', () => {
  const costeo = { fraccionado: { costoHora: 1, valorEnergiaKwh: 120, maquinas: [] } };
  const l = cfgEsq.limpiarCosteo(costeo);
  assert.strictEqual((l ? l.datos : costeo).fraccionado.valorEnergiaKwh, 120);
  assert.strictEqual(cfgEsq.configEsquemaDe(costeo, 'fraccionado').valorEnergiaKwh, 120);
  assert.strictEqual(cfgEsq.configEsquemaDe({ fraccionado: {} }, 'fraccionado').valorEnergiaKwh, null);
});

// ── Validadores ──
const MSG_CONSUMO = i => `maquinas[${i}].consumoKwhHora: número de 0 a 1000 (kWh por hora de trabajo)`;
test('validarMaquinas: copia consumoKwhHora 0..1000; vacío/null/ausente no lo guarda; −1, 1001, texto, NaN → error con índice', () => {
  const v = maqs => CF.validarMaquinas({ maquinas: maqs }).maquinas;
  assert.deepStrictEqual(v([{ nombre: 'A', costoHora: 1, consumoKwhHora: 2.5 }, { nombre: 'B', costoHora: 1, consumoKwhHora: 0 }, { nombre: 'C', costoHora: 1, consumoKwhHora: 1000 }])
    .map(m => m.consumoKwhHora), [2.5, 0, 1000]);
  for (const c of ['', null, undefined]) assert.ok(!('consumoKwhHora' in v([{ nombre: 'A', costoHora: 1, consumoKwhHora: c }])[0]));
  assert.ok(!('consumoKwhHora' in v([{ nombre: 'A', costoHora: 1 }])[0]));
  for (const c of [-1, 1001, 'abc', '2', NaN, Infinity]) {
    assert.throws(() => v([{ nombre: 'A', costoHora: 1 }, { nombre: 'B', costoHora: 1, consumoKwhHora: c }]), { message: MSG_CONSUMO(1) }, String(c));
  }
});

const MSG_VALOR = 'valorEnergiaKwh: número de 0 a 100000 ($ por kWh)';
const COSTOS = { modoGastos: 'costo', gastosVenta: [], extrasMinorista: [] };
test('validarCostos: valorEnergiaKwh sólo en Fraccionado; ausente no aparece; ""/null → null; rangos', () => {
  const f = v => cfgEsq.validarCostos({ ...COSTOS, valorEnergiaKwh: v }, 'fraccionado');
  assert.deepStrictEqual([0, 120.5, 100000].map(x => f(x).valorEnergiaKwh), [0, 120.5, 100000]);
  assert.deepStrictEqual(['', null].map(x => f(x).valorEnergiaKwh), [null, null]);
  assert.ok(!('valorEnergiaKwh' in cfgEsq.validarCostos(COSTOS, 'fraccionado')));
  for (const x of [-1, 100001, 'abc', NaN]) assert.throws(() => f(x), { message: MSG_VALOR }, String(x));
  // Reventa (sin tipo) lo ignora, aun inválido.
  assert.ok(!('valorEnergiaKwh' in cfgEsq.validarCostos({ ...COSTOS, valorEnergiaKwh: 120 })));
  assert.ok(!('valorEnergiaKwh' in cfgEsq.validarCostos({ ...COSTOS, valorEnergiaKwh: -5 }, 'almacen')));
});

// ── Rutas HTTP (routers reales) ──
const COSTOS_FALSOS = { 1: ['Arroz', 1000], 50: ['Almendra granel', 10000] };
const sigaFalso = async (sql) => {
  if (sql.includes("NombreRubro = 'Almacen'")) return [{ IdProducto: '1', NombreProducto: 'Arroz', CostoSistema: 1000, IvaCompraPct: 21 }];
  if (sql.includes("NombreRubro = 'Pesables Deposito'")) return [{ IdProducto: '50', NombreProducto: 'Almendra granel' }];
  if (sql.includes("NombreRubro = 'Pesables Fraccionado'")) return [{ IdProducto: '51', NombreProducto: 'Almendra 500G' }];
  const ids = (sql.match(/p\.IdProducto IN \(([^)]*)\)/) || [])[1];
  if (ids) return ids.match(/\w+/g).filter(id => COSTOS_FALSOS[id]).map(id => ({ IdProducto: id, NombreProducto: COSTOS_FALSOS[id][0], CostoSistema: COSTOS_FALSOS[id][1], IvaCompraPct: 21 }));
  return [];
};
function appCon(costeo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'energia-rutas-'));
  const archivo = path.join(dir, 'costeo.json');
  fs.writeFileSync(archivo, JSON.stringify(costeo));
  fs.writeFileSync(path.join(dir, 'pesables_listas.json'), JSON.stringify({ formulas: { 51: { granel: '50' } } }));
  const leerJSON = (p, def) => { try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : def; } catch { return def; } };
  let escrituras = 0;
  const guardarJSON = (p, d) => { escrituras++; fs.writeFileSync(p, JSON.stringify(d, null, 2)); };
  const apiRoute = fn => async (req, res) => { try { res.json(await fn(req)); } catch (err) { res.status(500).json({ error: err.message }); } };
  const deps = { apiRoute, query: sigaFalso, leerJSON, guardarJSON, DATA_DIR: dir, LISTA_PRECIOS_VENTA: 0, FORMULA_ACTIVA_SQL: '1=1', SIN_FORMULA_GENERICO_SQL: '1=1' };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.preciosSinConfig = false; next(); });
  app.use(require('../routes/rutas_precios_esquema')(deps));
  app.use(require('../routes/rutas_precios_fraccionado')(deps));
  let server;
  const pedir = async (metodo, ruta, body) => {
    if (!server) server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const res = await fetch(`http://127.0.0.1:${server.address().port}${ruta}`,
      { method: metodo, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return res.json();
  };
  return { pedir, leer: () => JSON.parse(fs.readFileSync(archivo, 'utf8')), escrituras: () => escrituras, cerrar: () => server && server.close() };
}
const BASE_F = '/api/precios/config/esquema/fraccionado';
const URL_COSTOS = '/api/precios/config/esquema/costos';
const MIGRADO = cfgEsq.migrarConfigFraccionado(cfgEsq.migrarEsquemaCanales({ gastosVenta: [{ id: 'flete', concepto: 'Flete', pct: 1, listas: ['sucursal'] }] }).costeo).costeo;
const conMaquina = (consumo, extra = {}) => ({ ...MIGRADO, fraccionado: { ...MIGRADO.fraccionado, costoHora: 6000, ...extra,
  maquinas: [{ id: 'env', nombre: 'Envasadora', costoHora: 3000, ...(consumo == null ? {} : { consumoKwhHora: consumo }) }],
  porGranel: { 50: { minKg: 2, maquinaId: 'env' } } } });

test('HTTP: PUT costos?tipo=fraccionado guarda el valor; GET esquema, GET fraccionado y GET fraccionado/costeo lo devuelven con consumoKwhHora', async () => {
  const a = appCon(conMaquina(2.5));
  try {
    const gv = a.leer().fraccionado.gastosVenta;
    const j = await a.pedir('PUT', `${URL_COSTOS}?tipo=fraccionado`, { modoGastos: 'costo', gastosVenta: gv, extrasMinorista: [], valorEnergiaKwh: 120.5 });
    assert.strictEqual(j.valorEnergiaKwh, 120.5);
    assert.deepStrictEqual([a.leer().fraccionado.valorEnergiaKwh, a.leer().fraccionado.gastosVenta], [120.5, gv]);
    assert.strictEqual((await a.pedir('GET', '/api/precios/config/esquema?tipo=fraccionado')).valorEnergiaKwh, 120.5);
    for (const ruta of [BASE_F, `${BASE_F}/costeo`]) {
      const g = await a.pedir('GET', ruta);
      assert.deepStrictEqual([g.valorEnergiaKwh, g.maquinas[0].consumoKwhHora], [120.5, 2.5], ruta);
    }
  } finally { a.cerrar(); }
});

test('HTTP: PUT costos sin la clave no toca el valor; vacío lo pone en null; inválido no escribe; sin ?tipo no lo guarda', async () => {
  const a = appCon(conMaquina(2.5, { valorEnergiaKwh: 100 }));
  try {
    await a.pedir('PUT', `${URL_COSTOS}?tipo=fraccionado`, COSTOS);
    assert.strictEqual(a.leer().fraccionado.valorEnergiaKwh, 100);
    const n = a.escrituras();
    assert.strictEqual((await a.pedir('PUT', `${URL_COSTOS}?tipo=fraccionado`, { ...COSTOS, valorEnergiaKwh: -1 })).error, MSG_VALOR);
    assert.deepStrictEqual([a.escrituras(), a.leer().fraccionado.valorEnergiaKwh], [n, 100]);
    await a.pedir('PUT', URL_COSTOS, { ...COSTOS, valorEnergiaKwh: 999 });
    const c = a.leer();
    assert.deepStrictEqual(['valorEnergiaKwh' in c, c.fraccionado.valorEnergiaKwh], [false, 100]);
    await a.pedir('PUT', `${URL_COSTOS}?tipo=fraccionado`, { ...COSTOS, valorEnergiaKwh: '' });
    assert.strictEqual(a.leer().fraccionado.valorEnergiaKwh, null);
  } finally { a.cerrar(); }
});

test('HTTP: PUT maquinas guarda el consumo (vacío sin campo); inválido da error con índice y no escribe', async () => {
  const a = appCon(conMaquina(null));
  try {
    const j = await a.pedir('PUT', `${BASE_F}/maquinas`, { maquinas: [{ id: 'env', nombre: 'Envasadora', costoHora: 3000, consumoKwhHora: 2.5 }, { nombre: 'Sel', costoHora: 1, consumoKwhHora: '' }] });
    assert.deepStrictEqual(j.maquinas.map(m => m.consumoKwhHora), [2.5, undefined]);
    assert.deepStrictEqual(a.leer().fraccionado.maquinas.map(m => 'consumoKwhHora' in m), [true, false]);
    const n = a.escrituras();
    assert.strictEqual((await a.pedir('PUT', `${BASE_F}/maquinas`, { maquinas: [{ id: 'env', nombre: 'Envasadora', costoHora: 3000, consumoKwhHora: 1001 }] })).error, MSG_CONSUMO(0));
    assert.deepStrictEqual([a.escrituras(), a.leer().fraccionado.maquinas[0].consumoKwhHora], [n, 2.5]);
  } finally { a.cerrar(); }
});

test('HTTP: listado y detalle de Fraccionado suben con la energía (y avisan sin valor); Reventa no cambia', async () => {
  const a = appCon(conMaquina(2.5));
  const pres = async () => (await a.pedir('GET', '/api/precios/esquema/listado?tipo=fraccionado')).filas[0].presentaciones[0];
  const detalle = async (tipo, plu) => {
    const f = await a.pedir('GET', `/api/precios/esquema/detalle/${plu}?tipo=${tipo}`);
    return (f.presentaciones ? f.presentaciones[0] : f).sugeridos.sistema.minorista.precio;
  };
  try {
    const p0 = await pres();
    assert.ok(p0.avisosCosto.includes('valorEnergia'), JSON.stringify(p0.avisosCosto));
    const antes = { lista: p0.sugeridos.sistema.minorista.precio, fracc: await detalle('fraccionado', '50'), reventa: await detalle('almacen', '1') };
    await a.pedir('PUT', `${URL_COSTOS}?tipo=fraccionado`, { ...COSTOS, gastosVenta: a.leer().fraccionado.gastosVenta, valorEnergiaKwh: 100000 });
    const p1 = await pres();
    assert.ok(!p1.avisosCosto.includes('valorEnergia'));
    assert.ok(p1.sugeridos.sistema.minorista.precio > antes.lista, `${p1.sugeridos.sistema.minorista.precio} > ${antes.lista}`);
    assert.ok(await detalle('fraccionado', '50') > antes.fracc);
    assert.strictEqual(await detalle('almacen', '1'), antes.reventa);
  } finally { a.cerrar(); }
});

// ── UI ──
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const numOrNull = v => { const s = String(v ?? '').trim(); if (s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
const campoU = (input, u, { w = 'w-28' } = {}) => `<span class="campo-u ${w}">${input}<span class="u" aria-hidden="true">${u}</span></span>`;
const $de = html => cheerio.load(`<div id="raiz">${html}</div>`)('#raiz');

function cargarFr(cfg) {
  const noop = () => null;
  const ctx = vm.createContext({ module: { exports: {} }, esc, campoU, numOrNull, fmtMoney: String, PreciosEsquema: { AJUSTES_PESO_MAX: 12 },
    ...Object.fromEntries(['conectarSubrubrosHf', 'conectarTramosHf', 'pintarSubrubrosHf', 'pintarTramosHf', 'pintarEstadoHf', 'cargarHistorialHf',
      'invalidarHistorialHf', 'usarEnInputHf', 'historialHf', 'htmlHistProductoHf'].map(n => [n, noop])) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/precios_config_fraccionado.js'), 'utf8'), ctx);
  vm.runInContext(`cfFr = ${JSON.stringify(cfg)}`, ctx);
  return ctx;
}
const MAQS = [{ id: 'env', nombre: 'Envasadora', costoHora: 5000, consumoKwhHora: 2.5, usos: { graneles: 1 } }, { id: 'sel', nombre: 'Selladora', costoHora: 1000, usos: { graneles: 0 } }];

test('UI máquinas: columna Consumo (kWh/h, max 1000) con el valor guardado; leyenda sólo con consumo y sin valor', () => {
  const html = v => $de(vm.runInContext('htmlMaquinasFr()', Object.assign(cargarFr({ maquinas: MAQS, valorEnergiaKwh: v }))));
  const $ = html(null);
  assert.deepStrictEqual($.find('thead th').toArray().map(th => $.find(th).text()), ['Nombre', 'Costo hora', 'Consumo', 'Usada en', 'Quitar']);
  const ins = $.find('#frMaquinas [data-k="consumoKwhHora"]');
  assert.deepStrictEqual([ins.length, ins.eq(0).attr('value'), ins.eq(1).attr('value'), ins.eq(0).attr('max')], [2, '2.5', '', '1000']);
  assert.match($.find('#frMaquinas').text(), /kWh\/h/);
  assert.match($.find('.fr-aviso-energia').text(), /falta el valor de la energía/);
  assert.strictEqual(html(0).find('.fr-aviso-energia').text(), '');
  assert.strictEqual(html(120).find('.fr-aviso-energia').text(), '');
});

test('UI máquinas: avisoEnergiaFr y errorConsumoFr', () => {
  const { avisoEnergiaFr, errorConsumoFr, TXT_SIN_ENERGIA_FR, CONSUMO_MAX_FR } = cargarFr({ maquinas: [] }).module.exports;
  assert.strictEqual(CONSUMO_MAX_FR, 1000);
  assert.deepStrictEqual([avisoEnergiaFr([{ consumoKwhHora: 1 }], null), avisoEnergiaFr([{ consumoKwhHora: 1 }], undefined), avisoEnergiaFr([{ consumoKwhHora: 1 }], 0),
    avisoEnergiaFr([{ consumoKwhHora: 0 }, {}], null), avisoEnergiaFr(null, null)], [TXT_SIN_ENERGIA_FR, TXT_SIN_ENERGIA_FR, '', '', '']);
  assert.strictEqual(errorConsumoFr([{ nombre: 'A' }, { nombre: 'B', consumoKwhHora: 0 }, { nombre: 'C', consumoKwhHora: 1000 }]), null);
  assert.match(errorConsumoFr([{ nombre: 'A', consumoKwhHora: 1 }, { nombre: 'B', consumoKwhHora: 1001 }]), /^B: el consumo es un número de 0 a 1000/);
  assert.match(errorConsumoFr([{ nombre: '', consumoKwhHora: NaN }]), /^Máquina 1: /);
  assert.match(errorConsumoFr([{ nombre: 'X', consumoKwhHora: -1 }]), /^X: /);
});

function cargarEsq(tipo) {
  const ctx = vm.createContext({ module: { exports: {} }, esc, fmtMoney: String, numOrNull, campoU, PreciosEsquema: require('../lib/precios_esquema'), API_ESQ: '/api/precios/config/esquema',
    sessionStorage: { getItem: () => (tipo === 'fraccionado' ? 'fraccionado' : null), setItem() {} },
    document: { getElementById: () => ({ addEventListener() {}, classList: { toggle() {} } }), querySelectorAll: () => [] } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/precios_config_esquema.js'), 'utf8'), ctx);
  const enviados = [];
  Object.assign(ctx, { conectarCostoHoraEsq() {}, pintarTotalesEsq() {}, leerItemsEsq: () => [], htmlCostoHoraEsq: () => '',
    guardarBloqueEsq: (_b, url, body) => enviados.push({ url, body }) });
  vm.runInContext('conectarCostoHoraEsq = globalThis.conectarCostoHoraEsq; pintarTotalesEsq = globalThis.pintarTotalesEsq; leerItemsEsq = globalThis.leerItemsEsq; htmlCostoHoraEsq = globalThis.htmlCostoHoraEsq; guardarBloqueEsq = globalThis.guardarBloqueEsq;', ctx);
  return { ctx, enviados };
}
function pintarCostos(tipo, valorTipeado) {
  const { ctx, enviados } = cargarEsq(tipo);
  const guardar = {};
  const bloque = { querySelectorAll: () => [], addEventListener() {},
    querySelector: s => (s === '.esq-guardar' ? guardar : s === '#esqValorEnergia' ? { value: valorTipeado } : s.startsWith('[data-modo]') ? { dataset: { modo: 'costo' } } : {}) };
  const panel = { innerHTML: '', querySelector: () => bloque };
  ctx.pintarCostosEsq(panel, { modoGastos: 'costo', gastosVenta: [], extrasMinorista: [], valorEnergiaKwh: 120.5 });
  guardar.onclick();
  return { $: $de(panel.innerHTML), enviados };
}

test('UI costos: "Valor de la energía" sólo con el switch en Fraccionado, dentro de Gastos variables; Guardar costos lo manda (vacío → null)', () => {
  const f = pintarCostos('fraccionado', '130');
  const campo = f.$.find('[data-lista="gastosVenta"] #esqValorEnergia');
  assert.deepStrictEqual([campo.length, campo.attr('value'), f.$.find('[data-lista="extrasMinorista"] #esqValorEnergia').length], [1, '120.5', 0]);
  assert.match(f.$.find('[data-lista="gastosVenta"]').text(), /Valor de la energía \(\$\/kWh\)/);
  assert.deepStrictEqual([f.enviados[0].url, f.enviados[0].body.valorEnergiaKwh], ['/api/precios/config/esquema/costos?tipo=fraccionado', 130]);
  assert.strictEqual(pintarCostos('fraccionado', '').enviados[0].body.valorEnergiaKwh, null);
  const r = pintarCostos('almacen', '130');
  assert.strictEqual(r.$.find('#esqValorEnergia').length, 0);
  assert.deepStrictEqual([r.enviados[0].url, 'valorEnergiaKwh' in r.enviados[0].body], ['/api/precios/config/esquema/costos', false]);
});

test('UI costos: htmlValorEnergiaEsq escapa y deja vacío sin valor', () => {
  const { htmlValorEnergiaEsq } = cargarEsq('fraccionado').ctx.module.exports;
  assert.strictEqual($de(htmlValorEnergiaEsq(null)).find('#esqValorEnergia').attr('value'), '');
  assert.strictEqual($de(htmlValorEnergiaEsq(0)).find('#esqValorEnergia').attr('value'), '0');
  assert.doesNotMatch(htmlValorEnergiaEsq('"><b>'), /"><b>/);
});

// ── Modal y listado ──
const { filasCostoPresFraccMd } = require('../public/js/precios_modal_fraccionado.js');
const pres = (lineas, avisos = [], porUnidad = 908) => ({ plu: '101', nombre: 'Almendra 500G', pesoG: 500, costos: { sistema: porUnidad * 2 },
  costeoPresentacion: { minutos: 1, minKg: 2, minKgOrigen: 'subrubro', ajusteMinKg: 0, porUnidad, extraKg: porUnidad * 2 - 1000 }, avisosCosto: avisos,
  componentesCosto: [{ plu: '_manoObra', rol: 'mo', cantidad: 1, costoUnit: 6000, importe: 100 }, { plu: '_maquina', rol: 'maquina', nombre: 'Envasadora', cantidad: 1, costoUnit: 3000, importe: 50 }, ...lineas] });

test('modal: fila Energía después de la máquina y la cuenta cierra contra Costo real por unidad', () => {
  const filas = filasCostoPresFraccMd(pres([{ plu: '_energia', rol: 'energia', nombre: 'Energía', cantidad: 1, costoUnit: 300, importe: 5 }], [], 655), 'sistema', { sistema: 1000 });
  const txt = filas.map(r => r.txt);
  assert.ok(txt.indexOf('Energía') === txt.indexOf('Máquina Envasadora') + 1, txt.join(' | '));
  const e = filas.find(r => r.txt === 'Energía');
  assert.deepStrictEqual([e.op, e.v], ['+', 5]);
  const suma = filas.slice(0, filas.findIndex(r => r.txt === 'Costo real por unidad')).filter(r => r.tipo !== 'sub' && r.v != null).reduce((s, r) => s + r.v, 0);
  assert.strictEqual(suma, filas.find(r => r.txt === 'Costo real por unidad').v);
});

test('modal: sin valor de energía → renglón gris con el motivo; sin consumo → sin fila', () => {
  const nd = filasCostoPresFraccMd(pres([], ['valorEnergia']), 'sistema', { sistema: 1000 }).find(r => r.txt === 'Energía');
  assert.deepStrictEqual([nd.tipo, nd.v], ['nd', 0]);
  assert.match(nd.det, /falta el valor de la energía/);
  assert.ok(!filasCostoPresFraccMd(pres([]), 'sistema', { sistema: 1000 }).some(r => r.txt === 'Energía'));
});

test('listado: el aviso valorEnergia tiene su texto', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/precios_listados.js'), 'utf8');
  assert.match(src, /valorEnergia: 'máquina con consumo y sin valor de energía: el costo no incluye la energía'/);
});
