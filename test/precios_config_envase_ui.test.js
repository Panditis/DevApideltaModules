'use strict';
// Configuración › Costeo Fraccionado › tarjeta Envase (public/js/precios_config_envase.js): bolsa (PLU de SIGA) y bobina (gramos × $/kg)
// por peso, editables en la fila, con UN Guardar (PUT /envase sólo con lo cambiado). Puros con require; HTML con cheerio; el DOM con los
// dos scripts cargados en un vm (clásicos, comparten globales) y elementos de mentira.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cheerio = require('cheerio');

const RUTA_CFG = path.join(__dirname, '../public/js/precios_config_fraccionado.js');
const RUTA = path.join(__dirname, '../public/js/precios_config_envase.js');
const { errorEnvaseFr, errorCostoBobinaFr, erroresEnvaseFr, filasPesosFr, pesoCortoFr, productosFr, costoBobinaUnidadFr,
  infoBolsaFr, estadoEnvaseFr } = require(RUTA);

// ── Puros ──
test('errorEnvaseFr: PLU sólo dígitos (hasta 12, con trim) y gramos > 0 hasta 1000; vacíos valen; dice qué campo', () => {
  assert.deepStrictEqual([errorEnvaseFr('900', '8'), errorEnvaseFr(' 900 ', ''), errorEnvaseFr('', ''), errorEnvaseFr('', '1000'), errorEnvaseFr('', '0.5')],
    [null, null, null, null, null]);
  for (const plu of ['abc', '12a', '9.5', '1234567890123']) assert.strictEqual(errorEnvaseFr(plu, '').campo, 'bolsaPlu', plu);
  for (const g of ['0', '-1', 'x', '1001']) assert.strictEqual(errorEnvaseFr('', g).campo, 'bobinaG', g);
  assert.match(errorEnvaseFr('abc', '').mensaje, /sólo dígitos/);
  assert.match(errorEnvaseFr('', '0').mensaje, /mayor que 0/);
});

test('errorCostoBobinaFr: vacío vale (sin cargar); 0, negativo, texto o más de 1e7 no', () => {
  assert.deepStrictEqual(['', ' ', '6000', '0.5', '10000000'].map(errorCostoBobinaFr), [null, null, null, null, null]);
  for (const malo of ['0', '-1', 'x', '10000001']) assert.match(errorCostoBobinaFr(malo), /mayor que 0/, malo);
});

test('erroresEnvaseFr: todos los errores en orden de pantalla; PLU y gramos de una fila por separado', () => {
  assert.deepStrictEqual(erroresEnvaseFr('6000', [{ pesoG: 250, plu: '900', g: '8' }]), []);
  const e = erroresEnvaseFr('0', [{ pesoG: 250, plu: 'a', g: '0' }, { pesoG: 500, plu: '', g: '2000' }]);
  assert.deepStrictEqual(e.map(x => [x.campo, x.pesoG]), [['costoBobinaKg', undefined], ['bolsaPlu', 250], ['bobinaG', 250], ['bobinaG', 500]]);
});

test('filasPesosFr: un peso por fila ascendente con su envase; también los configurados sin productos; no muta', () => {
  const pesos = [{ pesoG: 250, presentaciones: 34 }, { pesoG: 1000, presentaciones: 2 }];
  const epp = { 1000: { bolsaPlu: '900', bolsaNombre: 'Bolsa', bolsaCosto: 20 }, 500: { bobinaG: 8, bolsaNombre: null, bolsaCosto: null } };
  assert.deepStrictEqual(filasPesosFr(pesos, epp), [{ pesoG: 250, presentaciones: 34 },
    { pesoG: 500, presentaciones: 0, bobinaG: 8, bolsaNombre: null, bolsaCosto: null }, { pesoG: 1000, presentaciones: 2, bolsaPlu: '900', bolsaNombre: 'Bolsa', bolsaCosto: 20 }]);
  assert.deepStrictEqual(filasPesosFr(undefined, undefined), []);
  assert.strictEqual(pesos.length, 2);
});

test('pesoCortoFr / productosFr / costoBobinaUnidadFr', () => {
  assert.deepStrictEqual([pesoCortoFr(250), pesoCortoFr(2000), pesoCortoFr(1500)], ['250 g', '2 kg', '1500 g']);
  assert.deepStrictEqual([productosFr(0), productosFr(1), productosFr(34)], ['sin productos', '1 producto', '34 productos']);
  assert.strictEqual(costoBobinaUnidadFr(8, 6000), 48);
  assert.deepStrictEqual([costoBobinaUnidadFr(8, null), costoBobinaUnidadFr(null, 6000), costoBobinaUnidadFr(0, 6000), costoBobinaUnidadFr(8, 0)], [null, null, null, null]);
});

test('infoBolsaFr: vacía, ok, sinCosto, noSiga y nueva (con el nombre elegido en el buscador)', () => {
  const f = { bolsaPlu: '900', bolsaNombre: 'Bolsa', bolsaCosto: 20 };
  assert.deepStrictEqual(infoBolsaFr(' ', f), { tipo: 'vacia' });
  assert.deepStrictEqual(infoBolsaFr('900', f), { tipo: 'ok', nombre: 'Bolsa', costo: 20 });
  assert.deepStrictEqual(infoBolsaFr('900', { ...f, bolsaCosto: null }), { tipo: 'sinCosto', nombre: 'Bolsa', costo: null });
  assert.deepStrictEqual(infoBolsaFr('900', { bolsaPlu: '900', bolsaNombre: null }), { tipo: 'noSiga' });
  assert.deepStrictEqual(infoBolsaFr('77', f, { 77: 'Zipper' }), { tipo: 'nueva', nombre: 'Zipper' });
  assert.deepStrictEqual(infoBolsaFr('77', {}), { tipo: 'nueva', nombre: null });
});

test('estadoEnvaseFr: el primero que aplique de los 5 casos, con singular y plural', () => {
  assert.deepStrictEqual(estadoEnvaseFr([], 6000), { texto: 'sin pesos', estado: 'info' });
  assert.deepStrictEqual(estadoEnvaseFr([{ bobinaG: 8 }, { bolsaPlu: '9', bolsaCosto: null }], null), { texto: 'falta costo de bobina', estado: 'falta' });
  assert.deepStrictEqual(estadoEnvaseFr([{ bolsaPlu: '9', bolsaCosto: null }, {}], null), { texto: '1 bolsa sin costo', estado: 'falta' });
  assert.deepStrictEqual(estadoEnvaseFr([{ bolsaPlu: '9', bolsaCosto: null }, { bolsaPlu: '8', bolsaCosto: null }], 6000), { texto: '2 bolsas sin costo', estado: 'falta' });
  assert.deepStrictEqual(estadoEnvaseFr([{ bolsaPlu: '9', bolsaCosto: 5 }, {}], null), { texto: '1 sin bolsa ni bobina', estado: 'info' });
  assert.deepStrictEqual(estadoEnvaseFr([{ bolsaPlu: '9', bolsaCosto: 5 }, { bobinaG: 8 }], 6000), { texto: 'todos con envase', estado: 'ok' });
});

test('estadoEnvaseFr con pesos quitados (oculto): sólo cuentan las filas visibles; si todos están quitados, info "todos sin envase"', () => {
  const quitado = { sinEnvase: true, oculto: true, presentaciones: 4 };
  // un peso quitado a propósito no es "sin bolsa ni bobina"
  assert.deepStrictEqual(estadoEnvaseFr([{ bolsaPlu: '9', bolsaCosto: 5 }, quitado], null), { texto: 'todos con envase', estado: 'ok' });
  assert.deepStrictEqual(estadoEnvaseFr([{ bolsaPlu: '9', bolsaCosto: 5 }, quitado, {}], null), { texto: '1 sin bolsa ni bobina', estado: 'info' });
  assert.deepStrictEqual(estadoEnvaseFr([{ bolsaPlu: '9', bolsaCosto: null }, quitado], 6000), { texto: '1 bolsa sin costo', estado: 'falta' });
  assert.deepStrictEqual(estadoEnvaseFr([{ bobinaG: 8 }, quitado], null), { texto: 'falta costo de bobina', estado: 'falta' });
  // ninguna fila visible pero hay pesos quitados: no es "sin pesos"
  assert.deepStrictEqual(estadoEnvaseFr([quitado], null), { texto: 'todos sin envase', estado: 'info' });
  assert.deepStrictEqual(estadoEnvaseFr([quitado, { ...quitado, presentaciones: 0 }], 6000), { texto: 'todos sin envase', estado: 'info' });
  assert.deepStrictEqual(estadoEnvaseFr([], null), { texto: 'sin pesos', estado: 'info' });
});

test('estadoEnvaseFr con la casilla "No necesita bolsa ni bobina" (sinEnvase visible): resuelta, no suma a nada; "todos resueltos" si el resto está bien; "todos sin envase" si todas', () => {
  const casilla = { sinEnvase: true, presentaciones: 4 }, quitado = { sinEnvase: true, oculto: true, presentaciones: 2 };
  assert.deepStrictEqual(estadoEnvaseFr([{ bolsaPlu: '9', bolsaCosto: 5 }, casilla], null), { texto: 'todos resueltos', estado: 'ok' });
  assert.deepStrictEqual(estadoEnvaseFr([{ bolsaPlu: '9', bolsaCosto: 5 }, casilla, quitado], null), { texto: 'todos resueltos', estado: 'ok' });
  assert.deepStrictEqual(estadoEnvaseFr([{ bolsaPlu: '9', bolsaCosto: 5 }, quitado], null), { texto: 'todos con envase', estado: 'ok' }); // sólo quitados: como siempre
  assert.deepStrictEqual(estadoEnvaseFr([{ bolsaPlu: '9', bolsaCosto: 5 }, casilla, {}], null), { texto: '1 sin bolsa ni bobina', estado: 'info' });
  assert.deepStrictEqual(estadoEnvaseFr([{ bolsaPlu: '9', bolsaCosto: null }, casilla], 6000), { texto: '1 bolsa sin costo', estado: 'falta' });
  assert.deepStrictEqual(estadoEnvaseFr([{ bobinaG: 8 }, casilla], null), { texto: 'falta costo de bobina', estado: 'falta' });
  assert.deepStrictEqual(estadoEnvaseFr([casilla], null), { texto: 'todos sin envase', estado: 'info' });
  assert.deepStrictEqual(estadoEnvaseFr([casilla, { ...casilla, presentaciones: 0 }, quitado], 6000), { texto: 'todos sin envase', estado: 'info' });
});

// ── vm ──
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const campoU = (input, u) => `<span class="campo-u">${input}<span class="u">${u}</span></span>`;
const numOrNull = v => { const s = String(v ?? '').trim(); if (s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
const CFG = { migrado: true, maquinas: [], tramosTiempo: [], subrubros: {}, porGranel: {}, subrubrosSiga: [], sinSubrubro: [], ajustesPeso: null, costoBobinaKg: 6000,
  pesos: [{ pesoG: 250, presentaciones: 3 }, { pesoG: 500, presentaciones: 1 }, { pesoG: 1000, presentaciones: 2 }],
  envasePorPeso: { 250: { bolsaPlu: '900', bolsaNombre: '<img src=x onerror=alert(1)>', bolsaCosto: 20, bobinaG: 8 }, 500: { bolsaPlu: '901', bolsaNombre: null, bolsaCosto: null },
    1500: { bobinaG: 10, bolsaNombre: null, bolsaCosto: null } } };

function cargar(extra = {}, cfg = CFG) {
  const ev = { msg: [], sucio: 0 };
  const ctx = vm.createContext({ module: { exports: {} }, esc, campoU, numOrNull, fmtMoney: String, PreciosEsquema: { AJUSTES_PESO_MAX: 12 }, CSS: { escape: s => s },
    Event: class { constructor(type, o = {}) { this.type = type; this.bubbles = !!o.bubbles; } },
    msgEsq: (_el, t, c) => ev.msg.push([t, c]), limpiarSucio: () => { ev.sucio += 1; }, esFraccCfg: () => true,
    document: { activeElement: null, getElementById: () => null, querySelector: () => null }, ...extra });
  vm.runInContext(fs.readFileSync(RUTA_CFG, 'utf8'), ctx, { filename: RUTA_CFG });
  vm.runInContext(fs.readFileSync(RUTA, 'utf8'), ctx, { filename: RUTA });
  vm.runInContext(`cfFr = ${JSON.stringify(cfg)}`, ctx);
  return { run: code => vm.runInContext(code, ctx), ev };
}
const $de = h => cheerio.load(`<div id="raiz">${h}</div>`)('#raiz');

test('htmlPesosFr: todos los pesos (también configurados sin productos), dos columnas independientes con ambas cargadas, un Guardar, accesible', () => {
  const $ = $de(cargar().run('htmlPesosFr()'));
  assert.deepStrictEqual($.find('#evTabla tbody tr').toArray().map(tr => $.find(tr).attr('data-peso')), ['250', '500', '1000', '1500']);
  const f250 = $.find('tr[data-peso="250"]');
  assert.deepStrictEqual([f250.find('[data-k="bolsaPlu"]').attr('value'), f250.find('[data-k="bobinaG"]').attr('value')], ['900', '8']);
  assert.strictEqual($.find('#evTabla input[disabled]').length, 0); // con las dos cargadas ninguna se desactiva
  assert.strictEqual($.find('#frBobinaKg').attr('value'), '6000');
  assert.deepStrictEqual([$.find('.fr-guardar').length, $.find('.ev-buscar').length, $.find('form').length], [1, 4, 0]);
  $.find('th').each((_, th) => assert.ok($.find(th).attr('scope'), 'th sin scope'));
  $.find('input').each((_, i) => assert.ok($.find(i).attr('aria-label'), 'input sin aria-label'));
  assert.match($.find('tr[data-peso="1500"]').text(), /sin productos/);
  const t = $.text().replace(/\s+/g, ' ');
  assert.match(t, /costo/);
  assert.match(t, /antes de calcular los precios/);
  assert.strictEqual($.find('img').length, 0); // nombre de bolsa de SIGA escapado
  assert.match(f250.find('.ev-nota').text(), /<img src=x onerror=alert\(1\)> · \$ 20/);
  assert.match($.find('tr[data-peso="500"] .ev-nota').text(), /no está en SIGA/);
  assert.strictEqual($.find('#evTabla thead th').length, 4); // columna de acción: ✕ (quitar)
  assert.deepStrictEqual($.find('#evTabla tbody tr').toArray().map(tr => $.find(tr).find('.ev-acc button').length), [1, 1, 1, 1]);
});

test('costo de bobina por unidad: gramos × $/kg en la fila; sin costo "falta el costo de bobina"; sin gramos "—"', () => {
  const $ = $de(cargar().run('htmlTablaPesosFr()'));
  assert.match($.find('tr[data-peso="250"] .ev-bob').text(), /\$ 48 por unidad/);
  assert.match($.find('tr[data-peso="1500"] .ev-bob').text(), /\$ 60 por unidad/);
  assert.strictEqual($.find('tr[data-peso="1000"] .ev-bob').text(), '—');
  const sin = $de(cargar({}, { ...CFG, costoBobinaKg: null }).run('htmlTablaPesosFr()'));
  assert.match(sin.find('tr[data-peso="250"] .ev-bob').text(), /falta el costo de bobina/);
  const vacio = $de(cargar({}, { ...CFG, pesos: [], envasePorPeso: {} }).run('htmlTablaPesosFr()'));
  assert.strictEqual(vacio.find('#evTabla tbody').html(), ''); // la tabla va igual (la fila nueva necesita dónde ir), tbody sin espacios
  assert.match(vacio.find('p.fr-vacio').text(), /No hay pesos en la tabla/);
});

test('refrescarFilaFr: al tipear recalcula en vivo el costo por unidad (con el $/kg tipeado arriba) y la nota de la bolsa', () => {
  const costo = { value: '5000' };
  const { run } = cargar({ document: { getElementById: id => (id === 'frBobinaKg' ? costo : null) } });
  const celdas = { '.ev-nota': { innerHTML: '' }, '.ev-bob': { innerHTML: '' }, '[data-k="bolsaPlu"]': { value: '77' }, '[data-k="bobinaG"]': { value: '10' }, '.ev-sin-chk': { checked: false } };
  const tr = { dataset: { peso: '250' }, querySelector: s => celdas[s] };
  run('refrescarFilaFr')(tr);
  assert.match(celdas['.ev-bob'].innerHTML, /\$ 50/);
  assert.match(celdas['.ev-nota'].innerHTML, /Se busca en SIGA al guardar/);
  costo.value = '';
  run('refrescarFilaFr')(tr);
  assert.match(celdas['.ev-bob'].innerHTML, /falta el costo de bobina/);
  celdas['.ev-sin-chk'].checked = true; // con la casilla "No necesita bolsa ni bobina": sin nota de bolsa ni costo, aunque haya algo tipeado
  run('refrescarFilaFr')(tr);
  assert.deepStrictEqual([celdas['.ev-nota'].innerHTML, celdas['.ev-bob'].innerHTML], ['Sin envase', '<span class="text-gris">—</span>']);
});

// Tarjeta de mentira: el costo arriba y una fila por peso con sus dos inputs, cada uno con su .ev-err.
function campo(value, extra = {}) {
  const err = { textContent: '', hidden: true };
  const i = { value, validity: {}, attrs: {}, err, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
    focus() { tarjetaEnFoco.el = this; }, closest: () => ({ querySelector: () => err }), ...extra };
  return i;
}
const tarjetaEnFoco = { el: null };
function tarjetaEnv(costo, filas) {
  const costoI = campo(costo);
  const trs = filas.map(([peso, plu, g]) => {
    const inputs = { bolsaPlu: campo(plu), bobinaG: campo(g) }, chk = { checked: false };
    return { dataset: { peso: String(peso) }, inputs, chk, querySelector: s => (s === '.ev-sin-chk' ? chk : inputs[(s.match(/data-k="(\w+)"/) || [])[1]]) };
  });
  const msg = {}, boton = { disabled: false };
  const card = { trs, costoI, querySelector: s => {
    if (s === '#frBobinaKg') return costoI;
    if (s === '.esq-msg') return msg;
    if (s === '.fr-guardar') return boton;
    const m = s.match(/^tr\[data-peso="(\d+)"\] \[data-k="(\w+)"\]$/);
    return m ? trs.find(t => t.dataset.peso === m[1]).inputs[m[2]] : null;
  }, querySelectorAll: s => (s === '#evTabla tbody tr' ? trs : s === '[aria-invalid]' ? [costoI, ...trs.flatMap(t => Object.values(t.inputs))].filter(i => i.attrs['aria-invalid']) : []) };
  return card;
}
const FILAS_OK = [[250, '900', '8'], [500, '901', ''], [1000, '', ''], [1500, '', '10']];

test('guardarEnvaseFr: errores sin PUT, con aria-invalid en cada campo y foco al primero; al corregir se limpian', async () => {
  const pedidos = [];
  const { run, ev } = cargar({ pedirEsq: async (...a) => { pedidos.push(a); return {}; } });
  const card = tarjetaEnv('0', [[250, 'abc', '8'], [500, '901', '2000'], [1000, '', ''], [1500, '', '10']]);
  await run('guardarEnvaseFr')(card);
  assert.strictEqual(pedidos.length, 0);
  assert.deepStrictEqual([card.costoI.attrs['aria-invalid'], card.trs[0].inputs.bolsaPlu.attrs['aria-invalid'], card.trs[1].inputs.bobinaG.attrs['aria-invalid'],
    card.trs[0].inputs.bobinaG.attrs['aria-invalid']], ['true', 'true', 'true', undefined]);
  assert.match(card.trs[0].inputs.bolsaPlu.err.textContent, /sólo dígitos/);
  assert.strictEqual(card.trs[0].inputs.bolsaPlu.err.hidden, false);
  assert.strictEqual(tarjetaEnFoco.el, card.costoI);
  assert.deepStrictEqual(ev.msg.at(-1), ['Hay 3 campos para corregir (marcados en rojo)', 'text-crit']);
  card.costoI.value = '6000'; card.trs[0].inputs.bolsaPlu.value = '900'; card.trs[1].inputs.bobinaG.value = '';
  card.trs[0].inputs.bobinaG.validity = { badInput: true }; // texto roto en un number: no se confunde con vacío
  await run('guardarEnvaseFr')(card);
  assert.deepStrictEqual([pedidos.length, card.costoI.attrs['aria-invalid'], card.trs[0].inputs.bolsaPlu.attrs['aria-invalid'], card.trs[0].inputs.bobinaG.attrs['aria-invalid']],
    [0, undefined, undefined, 'true']);
});

test('guardarEnvaseFr: sin cambios no hay PUT y la tarjeta queda limpia', async () => {
  const pedidos = [];
  const { run, ev } = cargar({ pedirEsq: async (...a) => { pedidos.push(a); return {}; } });
  await run('guardarEnvaseFr')(tarjetaEnv('6000', FILAS_OK));
  assert.deepStrictEqual([pedidos.length, ev.sucio, ev.msg.at(-1)[0]], [0, 1, 'No hay cambios para guardar']);
});

test('guardarEnvaseFr: UN PUT /envase sólo con lo cambiado; el envase crudo del PUT no pisa el enriquecido; recarga del GET y repinta', async () => {
  const pedidos = [];
  let repintado = '';
  const nuevo = { querySelector: () => ({ focus() {} }), set outerHTML(v) { repintado = v; } };
  const enriquecido = { 250: { bolsaPlu: '902', bolsaNombre: 'Zipper', bolsaCosto: 30, bobinaG: 8 }, 500: { bolsaPlu: '901', bolsaNombre: null, bolsaCosto: null } };
  const { run, ev } = cargar({
    pedirEsq: async (m, u, b) => {
      pedidos.push(JSON.parse(JSON.stringify([m, u.split('/').pop(), b ?? null])));
      return m === 'PUT' ? { migrado: true, costoBobinaKg: 7000, envasePorPeso: { 250: { bolsaPlu: '902' } } } : { pesos: CFG.pesos, envasePorPeso: enriquecido };
    },
    document: { activeElement: null, querySelector: () => null, getElementById: id => (id === 'frPesos' ? nuevo : id === 'cfgFraccAviso' ? { classList: { toggle() {} } } : null) } });
  const card = tarjetaEnv('7000', [[250, ' 902 ', '8'], [500, '901', ''], [1000, '', ''], [1500, '', '']]);
  await run('guardarEnvaseFr')(card);
  assert.deepStrictEqual(pedidos, [['PUT', 'envase', { costoBobinaKg: 7000, pesos: { 250: { bolsaPlu: '902', bobinaG: 8 }, 1500: { bolsaPlu: null, bobinaG: null } } }],
    ['GET', 'costeo', null]]);
  assert.deepStrictEqual([run('cfFr.costoBobinaKg'), run('cfFr.envasePorPeso[250].bolsaNombre')], [7000, 'Zipper']);
  assert.match(repintado, /id="frPesos"/);
  assert.match(repintado, /Zipper/);
  assert.deepStrictEqual(ev.msg.at(-1), ['Guardado', 'text-ok']);
});

test('guardarEnvaseFr: si la recarga del GET falla avisa "Se guardó, pero…" y no repinta', async () => {
  let repintado = '';
  const { run, ev } = cargar({
    pedirEsq: async m => { if (m === 'GET') throw new Error('SIGA caído'); return { migrado: true, costoBobinaKg: 7000 }; },
    document: { activeElement: null, querySelector: () => null, getElementById: id => (id === 'frPesos' ? { set outerHTML(v) { repintado = v; } } : id === 'cfgFraccAviso' ? { classList: { toggle() {} } } : null) } });
  await run('guardarEnvaseFr')(tarjetaEnv('7000', FILAS_OK));
  assert.strictEqual(repintado, '');
  assert.match(ev.msg.at(-1)[0], /^Se guardó, pero no se pudieron recargar los nombres y costos de las bolsas: SIGA caído/);
  assert.strictEqual(ev.msg.at(-1)[1], 'text-crit');
});

test('conectarPesosFr: sólo input y click (Enter no guarda); tipear limpia el error del campo y recalcula su fila', () => {
  const { run } = cargar({ document: { getElementById: () => ({ value: '6000' }) } });
  const card = tarjetaEnv('6000', FILAS_OK);
  card.querySelector = (orig => s => (s === '.fr-guardar' ? {} : orig(s)))(card.querySelector);
  run('conectarPesosFr')(card);
  assert.deepStrictEqual([typeof card.oninput, typeof card.onclick, card.onkeydown, card.onsubmit], ['function', 'function', undefined, undefined]);
  const celdas = { '.ev-nota': { innerHTML: '' }, '.ev-bob': { innerHTML: '' }, '[data-k="bolsaPlu"]': { value: '' }, '[data-k="bobinaG"]': { value: '2' }, '.ev-sin-chk': { checked: false } };
  const i = campo('2', { matches: s => s === 'input[data-k]', id: '' });
  i.attrs['aria-invalid'] = 'true';
  i.closest = s => (s === 'tr' ? { dataset: { peso: '250' }, querySelector: x => celdas[x] } : { querySelector: () => i.err });
  card.oninput({ target: i });
  assert.strictEqual(i.attrs['aria-invalid'], undefined);
  assert.match(celdas['.ev-bob'].innerHTML, /\$ 12/);
});

test('abrirBuscadorBolsaFr: elegir llena el PLU, avisa input (ensucia y repinta la nota) y cierra; Cancelar no cambia nada', () => {
  let elegir = null, alCerrar = null;
  const plu = { value: '900', eventos: [], dispatchEvent(e) { this.eventos.push([e.type, e.bubbles]); }, focus() { this.enfocado = true; } };
  const titulo = { textContent: '' }, bus = { innerHTML: '' }, cancelar = {};
  const d = { abierto: false, showModal() { this.abierto = true; }, close() { this.abierto = false; if (alCerrar) alCerrar(); },
    addEventListener: (_e, fn) => { alCerrar = fn; },
    querySelector: s => ({ '.fp-dlg-titulo': titulo, '.fp-dlg-bus': bus, '.fp-dlg-cancelar': cancelar, '#fpDlgBus': { setAttribute() {}, focus() {} } }[s]) };
  const { run } = cargar({ document: { getElementById: id => (id === 'dlgFP' ? d : null) }, htmlBuscadorSiga: () => '<input id="fpDlgBus">',
    conectarBuscadorSiga: (_id, fn) => { elegir = fn; } });
  const tr = { dataset: { peso: '1000' }, querySelector: () => plu };
  run('abrirBuscadorBolsaFr')(tr);
  assert.deepStrictEqual([d.abierto, titulo.textContent], [true, 'Buscar la bolsa de 1 kg']);
  cancelar.onclick();
  assert.deepStrictEqual([d.abierto, plu.value, plu.eventos.length, plu.enfocado], [false, '900', 0, true]);
  run('abrirBuscadorBolsaFr')(tr);
  elegir({ plu: '902', nombre: 'Bolsa 1kg' });
  assert.deepStrictEqual([plu.value, plu.eventos, d.abierto, run('elegidosFr[902]')], ['902', [['input', true]], false, 'Bolsa 1kg']);
});

test('barra de estado: el chip Envase sale de lo guardado (estadoEnvaseActualFr), sin contar los pesos guardados quitados (oculto)', () => {
  const { run } = cargar();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(run('estadoEnvaseActualFr()'))), { texto: '1 bolsa sin costo', estado: 'falta' });
  const q = { sinEnvase: true, oculto: true };
  const todos = cargar({}, { ...CFG, envasePorPeso: { 250: q, 500: q, 1000: q } });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(todos.run('estadoEnvaseActualFr()'))), { texto: 'todos sin envase', estado: 'info' });
  const uno = cargar({}, { ...CFG, envasePorPeso: { 250: { bolsaPlu: '900', bolsaCosto: 20, bolsaNombre: 'B', bobinaG: 8 }, 500: q, 1000: { bobinaG: 5 } } });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(uno.run('estadoEnvaseActualFr()'))), { texto: 'todos con envase', estado: 'ok' });
});

test('filasPesosFr expone sinEnvase y oculto en la fila; htmlTablaPesosFr muestra la sinEnvase (casilla marcada) y deja la oculto para la tira', () => {
  const f = filasPesosFr([{ pesoG: 250, presentaciones: 3 }, { pesoG: 500, presentaciones: 1 }, { pesoG: 1000, presentaciones: 2 }], { 500: { sinEnvase: true, oculto: true }, 1000: { sinEnvase: true } });
  assert.deepStrictEqual([f[0].sinEnvase, f[1].sinEnvase, f[1].oculto, f[2].sinEnvase, f[2].oculto, f[1].presentaciones], [undefined, true, true, true, undefined, 1]);
  const $ = $de(cargar({}, { ...CFG, envasePorPeso: { 500: { sinEnvase: true, oculto: true }, 1000: { sinEnvase: true } } }).run('htmlPesosFr()'));
  assert.deepStrictEqual([$.find('#evTabla tbody tr').toArray().map(tr => $.find(tr).attr('data-peso')), $.find('#evSinEnvase .ev-sin-item b').text(),
    $.find('tr[data-peso="1000"] .ev-sin-chk').attr('checked') !== undefined], [['250', '1000'], '500 g', true]);
  // una entrada vieja { sinEnvase: true } (guardada antes de la casilla, sin oculto) ahora se ve como fila visible marcada
  const vieja = $de(cargar({}, { ...CFG, envasePorPeso: { 500: { sinEnvase: true } } }).run('htmlPesosFr()'));
  assert.deepStrictEqual([vieja.find('#evTabla tbody tr').toArray().map(tr => vieja.find(tr).attr('data-peso')), vieja.find('#evSinEnvase').attr('hidden') !== undefined,
    vieja.find('tr[data-peso="500"] .ev-sin-chk').attr('checked') !== undefined], [['250', '500', '1000'], true, true]);
});

test('cuerpoCambiosEnvaseFr: sólo pesos cambiados (vacíos → null, PLU recortado), costo sólo si cambió; nada → null', () => {
  const run = cargar().run; // usa numOrNull global (precios_comun.js): en el vm
  const cuerpoCambiosEnvaseFr = (...a) => JSON.parse(JSON.stringify(run('cuerpoCambiosEnvaseFr')(...a)) ?? 'null');
  const epp = { 250: { bolsaPlu: '900', bolsaNombre: 'B', bolsaCosto: 2 }, 500: { bobinaG: 8 } };
  const iguales = [{ pesoG: 250, plu: '900', g: '' }, { pesoG: 500, plu: '', g: '8' }, { pesoG: 1000, plu: '', g: '' }];
  assert.strictEqual(cuerpoCambiosEnvaseFr('6000', iguales, 6000, epp), null);
  assert.strictEqual(cuerpoCambiosEnvaseFr('', [], null, undefined), null);
  assert.deepStrictEqual(cuerpoCambiosEnvaseFr('', [{ pesoG: 250, plu: ' 901 ', g: '3' }, { pesoG: 500, plu: '', g: '' }, iguales[2]], 6000, epp),
    { costoBobinaKg: null, pesos: { 250: { bolsaPlu: '901', bobinaG: 3 }, 500: { bolsaPlu: null, bobinaG: null } } });
  assert.deepStrictEqual(cuerpoCambiosEnvaseFr('7000', iguales, 6000, epp), { costoBobinaKg: 7000 });
});

test('no hay diálogos nativos ni console en el script del envase', () => {
  assert.doesNotMatch(fs.readFileSync(RUTA, 'utf8'), /(alert|confirm|prompt)\s*\(|console\./);
});
