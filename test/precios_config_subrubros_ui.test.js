'use strict';
// Configuración › Costeo Fraccionado › tarjeta Subrubros (public/js/precios_config_fraccionado.js): min/kg por producto dentro de cada
// subrubro, "Usar en todos" del historial y el Guardar único (PUT /subrubros { subrubros?, graneles? }). Puros con require; el DOM con el
// script cargado en un vm (clásico, comparte globales) y elementos de mentira.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cheerio = require('cheerio');

const RUTA = path.join(__dirname, '../public/js/precios_config_fraccionado.js');
const { minKgGranelFr, cambiosGranelesFr, errorGranelesFr, cuerpoSubrubrosFr, textoHeredadoFr, pisadosFr, textoPisarFr, textoCompletadosFr } = require(RUTA);

// ── Puros ──
test('minKgGranelFr: el min/kg propio guardado; sin entrada o sólo con máquina → null; 0 es un valor', () => {
  const pg = { 1: { minKg: 0 }, 2: { maquinaId: 'env' }, 3: { minKg: 4, envase: 'bobina' } };
  assert.deepStrictEqual(['1', '2', '3', '9'].map(p => minKgGranelFr(pg, p)), [0, null, 4, null]);
  assert.strictEqual(minKgGranelFr(undefined, '1'), null);
});

test('cambiosGranelesFr: sólo lo cambiado; vaciar un propio guardado → null; vacío sin propio no cambia; 0 sobre nada sí', () => {
  const pg = { 1: { minKg: 4 }, 2: { minKg: 5, maquinaId: 'env' }, 4: { maquinaId: 'env' } };
  const filas = [{ plu: '1', valor: 4 }, { plu: '2', valor: null }, { plu: '3', valor: null }, { plu: '4', valor: 0 }, { plu: '5', valor: 7.5 }];
  assert.deepStrictEqual(cambiosGranelesFr(filas, pg), { 2: null, 4: 0, 5: 7.5 });
  assert.deepStrictEqual(cambiosGranelesFr([], undefined), {});
  assert.ok(Number.isNaN(cambiosGranelesFr([{ plu: '1', valor: NaN }], pg)[1])); // texto roto viaja como NaN para que lo frene errorGranelesFr
});

test('errorGranelesFr: 0..600 o null vale; nombra al culpable (o "Producto <plu>"); NaN no vale; más de 1000 pide dos tandas', () => {
  assert.strictEqual(errorGranelesFr({ 1: 0, 2: 600, 3: null }), null);
  assert.match(errorGranelesFr({ 1: 601 }, { 1: 'Almendra (Frutos secos)' }), /^Almendra \(Frutos secos\): el min por kg es un número de 0 a 600/);
  assert.match(errorGranelesFr({ 7: -1 }), /^Producto 7:/);
  assert.match(errorGranelesFr({ 7: NaN }), /Producto 7/);
  const mil = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [String(i + 1), 1]));
  assert.strictEqual(errorGranelesFr(mil), null);
  assert.match(errorGranelesFr({ ...mil, 1001: 1 }), /hasta 1000 productos/);
});

test('cuerpoSubrubrosFr: sólo las partes con cambios (sin claves vacías)', () => {
  assert.deepStrictEqual(cuerpoSubrubrosFr({}, {}), {});
  assert.deepStrictEqual(cuerpoSubrubrosFr({ 7: 2 }, {}), { subrubros: { 7: 2 } });
  assert.deepStrictEqual(cuerpoSubrubrosFr({}, { 100: null }), { graneles: { 100: null } });
  assert.deepStrictEqual(cuerpoSubrubrosFr({ 7: 2 }, { 100: 0 }), { subrubros: { 7: 2 }, graneles: { 100: 0 } });
});

test('textoHeredadoFr: "8,5 · del subrubro", 0 también, sin valor del subrubro → "sin valor"', () => {
  assert.deepStrictEqual([textoHeredadoFr(8.5), textoHeredadoFr(0), textoHeredadoFr(null)], ['8,5 · del subrubro', '0 · del subrubro', 'sin valor']);
});

test('pisadosFr / textoPisarFr / textoCompletadosFr: cuenta sólo propios guardados distintos; singular y plural', () => {
  const pg = { 1: { minKg: 4 }, 2: { minKg: 7.5 }, 3: { maquinaId: 'env' }, 4: { minKg: 0 } };
  assert.strictEqual(pisadosFr(['1', '2', '3', '4', '5'], pg, 7.5), 2); // 1 y 4; el 2 ya vale 7,5 y el 3 sólo tiene máquina
  assert.strictEqual(pisadosFr([], pg, 1), 0);
  assert.match(textoPisarFr(1, 'Frutos', 7.5), /^1 producto tiene un min\/kg propio guardado en Frutos y se reemplaza por 7,5 min\/kg/);
  assert.match(textoPisarFr(3, 'Frutos', 2), /^3 productos tienen .* se reemplazan por 2 min\/kg/);
  assert.match(textoPisarFr(3, 'Frutos', 2), /¿Usar en todos\?$/);
  assert.deepStrictEqual([textoCompletadosFr(0, 7.5), textoCompletadosFr(1, 7.5), textoCompletadosFr(12, 7.5)], [
    'Se completó el valor del subrubro con 7,5 min/kg: revisá y guardá',
    'Se completaron 1 producto con 7,5 min/kg: revisá y guardá',
    'Se completaron 12 productos con 7,5 min/kg: revisá y guardá']);
});

// ── vm ──
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const campoU = (input, u) => `<span class="campo-u">${input}<span class="u">${u}</span></span>`;
const numOrNull = v => { const s = String(v ?? '').trim(); if (s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
const CFG = {
  migrado: true, maquinas: [{ id: 'env', nombre: 'Envasadora', costoHora: 1 }], tramosTiempo: [], ajustesPeso: null, pesos: [], envasePorPeso: {}, costoBobinaKg: null,
  subrubros: { 7: { minKg: 8 } },
  porGranel: { 100: { minKg: 4, maquinaId: 'env' }, 101: { envase: 'bobina' } },
  subrubrosSiga: [{ id: '7', nombre: 'Frutos <secos>', graneles: [
    { plu: '100', nombre: 'Almendra', presentaciones: [{ plu: '1001', nombre: 'Almendra 500G', pesoG: 500 }] },
    { plu: '101', nombre: 'Nuez "<img src=x onerror=alert(1)>"', presentaciones: [] }] }],
  sinSubrubro: [{ plu: '200', nombre: 'Sal', presentaciones: [] }] };

function cargar(extra = {}) {
  const ev = { usarEnInputHf: [], msg: [], sucio: [] };
  const ctx = vm.createContext({ module: { exports: {} }, esc, campoU, numOrNull, fmtMoney: String, PreciosEsquema: { AJUSTES_PESO_MAX: 12 }, CSS: { escape: s => s },
    historialHf: () => null, htmlHistProductoHf: (_h, plu) => `<span class="fr-prod-hist" data-hf-prod="${esc(plu)}"></span>`,
    usarEnInputHf: (i, v) => { ev.usarEnInputHf.push([i, v]); i.value = String(v); },
    msgEsq: (_el, t, c) => ev.msg.push([t, c]), limpiarSucio: () => ev.sucio.push('limpio'), esFraccCfg: () => true,
    document: { activeElement: null, getElementById: () => null, querySelector: () => null }, ...extra });
  vm.runInContext(fs.readFileSync(RUTA, 'utf8'), ctx, { filename: RUTA });
  vm.runInContext(`cfFr = ${JSON.stringify(CFG)}`, ctx);
  return { run: code => vm.runInContext(code, ctx), ev };
}
const $de = h => cheerio.load(`<div id="raiz">${h}</div>`)('#raiz');

test('htmlProductoFr: input por producto con el valor propio o el heredado de placeholder; máquina propia; XSS en nombres', () => {
  const { run } = cargar();
  const $ = $de(run('htmlSubrubrosCardFr()'));
  const [alm, nuez] = $.find('input[data-plu]').toArray().map(i => $.find(i));
  assert.deepStrictEqual([alm.attr('value'), alm.attr('placeholder'), alm.attr('min'), alm.attr('max')], ['4', '8 · del subrubro', '0', '600']);
  assert.deepStrictEqual([nuez.attr('value'), nuez.attr('placeholder')], ['', '8 · del subrubro']);
  assert.match(alm.attr('aria-label'), /Almendra \(subrubro Frutos <secos>\); vacío usa el del subrubro/);
  assert.match($.find('li[data-plu="100"]').text(), /máquina propia: Envasadora/);
  assert.strictEqual($.find('img,secos').length, 0);
  assert.strictEqual($.find('td[data-hf-sub="7"]').attr('data-hf-n'), '2');
  const sinValor = $de(run('cfFr.subrubros = {}; htmlSubrubrosCardFr()'));
  assert.strictEqual(sinValor.find('input[data-plu="101"]').attr('placeholder'), 'sin valor');
  assert.match(sinValor.text(), /1 producto sin subrubro/); // los sin subrubro siguen de sólo lectura: sin input
  assert.strictEqual(sinValor.find('input[data-plu="200"]').length, 0);
});

// Fila de un subrubro de mentira: su input, los de sus productos, la lista y el aviso.
function filaSub({ guardado = '8', productos = [['100', '4'], ['101', '']], buscar = '' } = {}) {
  const tr = { aviso: { textContent: '' } };
  const sub = { dataset: { id: '7' }, value: guardado, validity: {}, closest: () => tr };
  const prods = productos.map(([plu, value]) => ({ dataset: { plu }, value, validity: {} }));
  const det = { open: false, querySelectorAll: () => [], querySelector: () => ({ classList: { toggle() {} } }) };
  const busc = { value: buscar };
  Object.assign(tr, { querySelectorAll: s => (s === 'input[data-plu]' ? prods : []),
    querySelector: s => ({ 'details[data-prods]': det, '.fr-buscar': busc, '.fr-aviso': tr.aviso }[s]) });
  const msg = {}, boton = { disabled: false };
  const card = { querySelector: s => (s.startsWith('input[data-id=') ? sub : s === '.esq-msg' ? msg : s === '.fr-guardar' ? boton : null),
    querySelectorAll: s => (s === 'input[data-id]' ? [sub] : s === 'input[data-plu]' ? prods : []) };
  return { card, tr, sub, prods, det, busc };
}

test('usarEnTodosFr: sin propios guardados distintos no pregunta; rellena productos y subrubro sin guardar, abre la lista y limpia el buscador', async () => {
  const preguntas = [], pedidos = [];
  const { run, ev } = cargar({ confirmar: async t => { preguntas.push(t); return true; }, pedirEsq: async (...a) => { pedidos.push(a); } });
  const f = filaSub({ productos: [['100', '4'], ['101', '']], buscar: 'alm' });
  await run('usarEnTodosFr')(f.card, '7', 4, 'Frutos');
  assert.deepStrictEqual([preguntas.length, pedidos.length], [0, 0]); // el 100 ya vale 4: no se pisa nada
  assert.deepStrictEqual(f.prods.map(p => p.value), ['4', '4']);
  assert.deepStrictEqual([f.sub.value, ev.usarEnInputHf.length, f.det.open, f.busc.value], ['4', 1, true, '']);
  assert.strictEqual(run('abiertosFr.has("7")'), true);
  assert.strictEqual(f.tr.aviso.textContent, 'Se completaron 2 productos con 4 min/kg: revisá y guardá');
});

test('usarEnTodosFr: si pisa propios guardados distintos confirma con el conteo; cancelar no cambia nada', async () => {
  const preguntas = [];
  let respuesta = false;
  const { run, ev } = cargar({ confirmar: async (t, o) => { preguntas.push([t, o.textoOk]); return respuesta; } });
  const f = filaSub();
  await run('usarEnTodosFr')(f.card, '7', 7.5, 'Frutos');
  assert.match(preguntas[0][0], /^1 producto tiene un min\/kg propio guardado en Frutos/);
  assert.strictEqual(preguntas[0][1], 'Usar en todos');
  assert.deepStrictEqual([f.prods.map(p => p.value), f.sub.value, ev.usarEnInputHf.length, f.det.open], [['4', ''], '8', 0, false]);
  respuesta = true;
  await run('usarEnTodosFr')(f.card, '7', 7.5, 'Frutos');
  assert.deepStrictEqual([f.prods.map(p => p.value), f.sub.value], [['7.5', '7.5'], '7.5']);
});

test('usarEnTodosFr: un subrubro sin productos (SIGA ya no los trae) sólo completa su valor', async () => {
  const { run } = cargar({ confirmar: async () => true });
  const f = filaSub({ productos: [] });
  await run('usarEnTodosFr')(f.card, '7', 3, 'Viejo');
  assert.deepStrictEqual([f.sub.value, f.tr.aviso.textContent], ['3', 'Se completó el valor del subrubro con 3 min/kg: revisá y guardá']);
});

test('guardarSubrubrosFr: UN PUT con sólo lo cambiado (null al vaciar un propio); sin cambios no hay PUT; error de validación no hay PUT', async () => {
  const pedidos = [];
  const { run, ev } = cargar({ pedirEsq: async (m, u, b) => { pedidos.push(JSON.parse(JSON.stringify([m, u.split('/').pop(), b]))); return { migrado: true, envasePorPeso: { 1: {} } }; },
    document: { activeElement: null, querySelector: () => null, getElementById: id => (id === 'cfgFraccAviso' ? { classList: { toggle() {} } } : null) } });
  const sinCambios = filaSub();
  await run('guardarSubrubrosFr')(sinCambios.card);
  assert.deepStrictEqual([pedidos.length, ev.msg.at(-1)[0], ev.sucio.length], [0, 'No hay cambios para guardar', 1]);

  const mal = filaSub({ productos: [['100', '601'], ['101', '']] });
  await run('guardarSubrubrosFr')(mal.card);
  assert.deepStrictEqual([pedidos.length, ev.msg.at(-1)[1]], [0, 'text-crit']);
  assert.match(ev.msg.at(-1)[0], /^Almendra \(Frutos <secos>\): el min por kg es un número de 0 a 600/);
  const roto = filaSub({ productos: [['100', '4'], ['101', '']] });
  roto.prods[1].validity = { badInput: true }; // "1e" en un number: value '' pero no es vaciar
  await run('guardarSubrubrosFr')(roto.card);
  assert.deepStrictEqual([pedidos.length, ev.msg.at(-1)[1]], [0, 'text-crit']);

  const ok = filaSub({ guardado: '', productos: [['100', ''], ['101', '0']] });
  await run('guardarSubrubrosFr')(ok.card);
  assert.deepStrictEqual(pedidos, [['PUT', 'subrubros', { subrubros: { 7: null }, graneles: { 100: null, 101: 0 } }]]);
  assert.strictEqual(run('cfFr.envasePorPeso[1]'), undefined); // el envasePorPeso crudo de la respuesta no se mezcla
});

test('fijarProductoFr: repinta sólo el renglón del producto con el heredado tipeado en el subrubro (lo tipeado en otros queda)', async () => {
  let renglon = '';
  const otro = { value: '9' };
  const li = { set outerHTML(v) { renglon = v; }, closest: () => ({ querySelector: () => ({ value: '' }) }) };
  const { run } = cargar({ pedirEsq: async () => ({ migrado: true, porGranel: { 100: { minKg: 6, maquinaId: 'env' }, 101: { envase: 'bobina' } } }),
    document: { querySelector: s => (s === '#frSubrubros li[data-plu="100"]' ? li : null) } });
  await run('fijarProductoFr')('100', 6);
  assert.match(renglon, /data-plu="100" value="6" placeholder="sin valor"/);
  assert.match(renglon, /máquina propia: Envasadora/); // no pierde la máquina
  assert.strictEqual(otro.value, '9');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(run('cfFr.porGranel[101]'))), { envase: 'bobina' });
});

test('conectarSubrubrosFr: el "Usar en todos" del historial llega a usarEnTodosFr de la tarjeta; tipear el subrubro cambia el placeholder heredado', async () => {
  let acciones = null;
  const { run } = cargar({ conectarSubrubrosHf: (_c, a) => { acciones = a; }, confirmar: async () => true });
  const f = filaSub();
  const solo = { checked: false };
  f.card.querySelector = (orig => s => (s === '#frSoloFalta' ? solo : s === '.fr-guardar' ? {} : orig(s)))(f.card.querySelector);
  run('conectarSubrubrosFr')(f.card);
  assert.strictEqual(acciones.actual('7'), 8);
  await acciones.usarEnTodos('7', 4, 'Frutos');
  assert.deepStrictEqual(f.prods.map(p => p.value), ['4', '4']);
  const sub = { value: '2,5'.replace(',', '.'), matches: s => s === 'input[data-id]', closest: () => ({ querySelectorAll: () => f.prods }) };
  f.card.oninput({ target: sub });
  assert.deepStrictEqual(f.prods.map(p => p.placeholder), ['2,5 · del subrubro', '2,5 · del subrubro']);
});
