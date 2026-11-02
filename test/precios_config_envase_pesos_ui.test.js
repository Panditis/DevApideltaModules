'use strict';
// Configuración › Costeo Fraccionado › tarjeta Envase: AGREGAR y QUITAR pesos (también los que tienen productos: quedan quitados en la tira "Pesos quitados de la tabla"),
// la casilla "No necesita bolsa ni bobina" de cada fila (sinEnvase visible, sin oculto), "Volver a poner" y el modal con los productos de cada peso
// (public/js/precios_config_envase.js). Puros con require; HTML con cheerio; el DOM (agregar / quitar / volver a poner / casilla / guardar) con los scripts
// cargados en un vm y una tarjeta de mentira.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cheerio = require('cheerio');

const RUTA_CFG = path.join(__dirname, '../public/js/precios_config_fraccionado.js');
const RUTA = path.join(__dirname, '../public/js/precios_config_envase.js');
const { errorPesoNuevoFr, errorNuevoSinEnvaseFr, erroresEnvaseFr, pesosQuitadosFr, pesosSinEnvaseFr, textoQuitadosFr, filasPesosFr } = require(RUTA);

// ── Puros ──
test('errorPesoNuevoFr: obligatorio, gramos enteros de 1 a 999999 y que no esté en la lista', () => {
  const ya = new Set([250, 500]);
  assert.strictEqual(errorPesoNuevoFr('750', ya), null);
  assert.strictEqual(errorPesoNuevoFr(' 999999 ', ya), null);
  assert.deepStrictEqual(errorPesoNuevoFr('  ', ya), { campo: 'pesoG', mensaje: 'Escribí el peso, en gramos' });
  for (const malo of ['0', '1000000', '12.5', '-3', 'x']) assert.deepStrictEqual(errorPesoNuevoFr(malo, ya), { campo: 'pesoG', mensaje: 'Gramos enteros, de 1 a 999999' }, malo);
  assert.deepStrictEqual(errorPesoNuevoFr('250', ya), { campo: 'pesoG', mensaje: 'Ese peso ya está en la lista' });
});

test('errorPesoNuevoFr con la tira "Pesos quitados de la tabla": un peso de la tira no se agrega (usá "Volver a poner"); el de la tabla sigue "ya está"', () => {
  const ya = new Set([250]), tira = new Set([500]);
  assert.deepStrictEqual(errorPesoNuevoFr('500', ya, tira), { campo: 'pesoG', mensaje: 'Ese peso está en «Pesos quitados de la tabla»: usá «Volver a poner»' });
  assert.strictEqual(errorPesoNuevoFr('250', ya, tira).mensaje, 'Ese peso ya está en la lista');
  assert.strictEqual(errorPesoNuevoFr('750', ya, tira), null);
  assert.strictEqual(errorPesoNuevoFr('500', ya), null); // sin tira, como antes
});

test('errorNuevoSinEnvaseFr: la fila nueva necesita bolsa, bobina o la casilla "No necesita bolsa ni bobina"; marca el PLU', () => {
  assert.deepStrictEqual(errorNuevoSinEnvaseFr({ plu: ' ', g: '' }),
    { campo: 'bolsaPlu', mensaje: 'Cargá la bolsa o la bobina de este peso, tildá «No necesita bolsa ni bobina», o quitá la fila' });
  assert.strictEqual(errorNuevoSinEnvaseFr({ plu: '900', g: '' }), null);
  assert.strictEqual(errorNuevoSinEnvaseFr({ plu: '', g: '8' }), null);
  assert.strictEqual(errorNuevoSinEnvaseFr({ plu: '', g: '', sin: true }), null); // la casilla lo resuelve
  assert.strictEqual(errorNuevoSinEnvaseFr({ plu: '', g: '', sin: false }).campo, 'bolsaPlu');
});

test('erroresEnvaseFr con la casilla marcada: no valida el PLU ni los gramos tipeados (están deshabilitados y no se mandan); el peso de una fila nueva sí', () => {
  const e = erroresEnvaseFr('6000', [{ pesoG: 250, plu: 'abc', g: '9999', sin: true }, { pesoG: 500, plu: 'abc', g: '9999', sin: false },
    { nuevo: 'n1', pesoG: '800', plu: '', g: '', sin: true }, { nuevo: 'n2', pesoG: '12.5', plu: '', g: '', sin: true }]);
  assert.deepStrictEqual(e.map(x => [x.pesoG, x.campo]), [[500, 'bolsaPlu'], [500, 'bobinaG'], ['12.5', 'pesoG']]);
});

test('erroresEnvaseFr con filas nuevas: obligatorio, inválido, repetido (tabla y otra nueva) y sin envase, con nuevo', () => {
  const tabla = [{ pesoG: 250, plu: '900', g: '' }];
  const e = erroresEnvaseFr('6000', [...tabla,
    { nuevo: 'n1', pesoG: '', plu: '', g: '' },        // obligatorio (sin envase no se marca: el peso todavía no vale)
    { nuevo: 'n2', pesoG: '12.5', plu: '9', g: '' },   // inválido
    { nuevo: 'n3', pesoG: '250', plu: '9', g: '' },    // repetido contra la tabla
    { nuevo: 'n4', pesoG: '800', plu: '', g: '' },     // válido pero sin envase
    { nuevo: 'n5', pesoG: '800', plu: '9', g: '' }]);  // repetido contra otra nueva
  assert.deepStrictEqual(e.map(x => [x.nuevo, x.campo, x.mensaje.slice(0, 12)]), [
    ['n1', 'pesoG', 'Escribí el p'], ['n2', 'pesoG', 'Gramos enter'], ['n3', 'pesoG', 'Ese peso ya '], ['n4', 'bolsaPlu', 'Cargá la bol'], ['n5', 'pesoG', 'Ese peso ya ']]);
  assert.deepStrictEqual(erroresEnvaseFr('6000', [{ nuevo: 'n1', pesoG: '250', plu: '9', g: '' }]), []); // el 250 quitado (sin fila) no cuenta: reemplazo
});

test('erroresEnvaseFr con la tira: la fila nueva con un peso sin envase marca el error en el peso; el resto sigue igual', () => {
  const e = erroresEnvaseFr('6000', [{ pesoG: 250, plu: '900', g: '' }, { nuevo: 'n1', pesoG: '500', plu: '9', g: '' }, { nuevo: 'n2', pesoG: '750', plu: '9', g: '' }], new Set([500]));
  assert.deepStrictEqual(e.map(x => [x.nuevo, x.campo, x.mensaje.slice(0, 18)]), [['n1', 'pesoG', 'Ese peso está en «']]);
});

test('pesosQuitadosFr: los guardados sin fila, ascendente; la fila nueva con ese peso lo vuelve reemplazo', () => {
  const epp = { 1500: { bobinaG: 10 }, 300: { bobinaG: 5 }, 250: { bolsaPlu: '9' } };
  assert.deepStrictEqual(pesosQuitadosFr([{ pesoG: 250 }], epp), [300, 1500]);
  assert.deepStrictEqual(pesosQuitadosFr([{ pesoG: 250 }, { nuevo: 'n1', pesoG: '300' }], epp), [1500]);
  assert.deepStrictEqual(pesosQuitadosFr([], undefined), []);
});

test('pesosQuitadosFr con pesos: también los que tienen productos y ya no tienen fila; los guardados quitados (oculto) no son un quitado nuevo, los de la casilla sí', () => {
  const pesos = [{ pesoG: 250, presentaciones: 3 }, { pesoG: 500, presentaciones: 1 }, { pesoG: 1000, presentaciones: 2 }, { pesoG: 2000, presentaciones: 0 }];
  const epp = { 250: { bolsaPlu: '9' }, 500: { sinEnvase: true, oculto: true }, 300: { bobinaG: 5 } };
  assert.deepStrictEqual(pesosQuitadosFr([{ pesoG: 2000 }], epp, pesos), [250, 300, 1000]); // 500 ya está guardado quitado; 2000 sin productos y sin envase no es nada
  assert.deepStrictEqual(pesosQuitadosFr([{ pesoG: 250 }, { pesoG: 1000 }], epp, pesos), [300]);
  assert.deepStrictEqual(pesosQuitadosFr([{ pesoG: 250 }], { 250: { bolsaPlu: '9' } }, undefined), []);
  // 500 guardado con la casilla (sinEnvase visible): sacarlo de la tabla es un quitado nuevo
  assert.deepStrictEqual(pesosQuitadosFr([{ pesoG: 250 }, { pesoG: 1000 }], { 250: { bolsaPlu: '9' }, 500: { sinEnvase: true } }, pesos), [500]);
});

test('pesosSinEnvaseFr: los guardados quitados (oculto) + los de productos sin fila; una fila NUEVA no cuenta; sin productos ni oculto no entra (la casilla tampoco)', () => {
  const guardadas = filasPesosFr([{ pesoG: 250, presentaciones: 3 }, { pesoG: 500, presentaciones: 1 }, { pesoG: 1000, presentaciones: 2 }],
    { 250: { bolsaPlu: '9' }, 500: { sinEnvase: true, oculto: true }, 300: { bobinaG: 5 }, 1500: { sinEnvase: true, oculto: true }, 2000: { sinEnvase: true } });
  assert.deepStrictEqual(pesosSinEnvaseFr([{ pesoG: 250 }, { pesoG: 1000 }, { pesoG: 300 }], guardadas), [
    { pesoG: 500, presentaciones: 1, guardado: true }, { pesoG: 1500, presentaciones: 0, guardado: true }]); // 2000 (casilla, sin productos) sin fila: se borra al guardar, no va a la tira
  assert.deepStrictEqual(pesosSinEnvaseFr([{ pesoG: 300 }, { pesoG: 2000 }], guardadas).map(x => [x.pesoG, x.guardado]), [[250, false], [500, true], [1000, false], [1500, true]]); // 250 y 1000 quitados, sin guardar
  assert.deepStrictEqual(pesosSinEnvaseFr([{ pesoG: 250 }, { pesoG: 1000 }, { nuevo: 'n1', pesoG: '500' }], guardadas).map(x => x.pesoG), [500, 1500]); // la fila nueva no lo saca de la tira
  assert.deepStrictEqual(pesosSinEnvaseFr([], []), []);
});

test('filasPesosFr: los flags sinEnvase y oculto llegan a la fila (sólo cuando el servidor los manda)', () => {
  const f = filasPesosFr([{ pesoG: 500, presentaciones: 4 }, { pesoG: 250, presentaciones: 1 }, { pesoG: 750, presentaciones: 2 }], { 500: { sinEnvase: true, oculto: true }, 750: { sinEnvase: true } });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(f)), [{ pesoG: 250, presentaciones: 1 }, { pesoG: 500, presentaciones: 4, sinEnvase: true, oculto: true },
    { pesoG: 750, presentaciones: 2, sinEnvase: true }]);
});

test('textoQuitadosFr: nada, 1, 2 y 3+ pesos con ListFormat es', () => {
  assert.strictEqual(textoQuitadosFr([]), '');
  assert.strictEqual(textoQuitadosFr([300]), 'Quitaste 300 g: se saca de la lista al guardar.');
  assert.strictEqual(textoQuitadosFr([300, 2000]), 'Quitaste 300 g y 2 kg: se sacan de la lista al guardar.');
  assert.strictEqual(textoQuitadosFr([300, 750, 1500]), 'Quitaste 300 g, 750 g y 1500 g: se sacan de la lista al guardar.');
});

test('textoQuitadosFr con productos: dice el efecto real (sin envase y sin aviso), singular/plural, varios pesos sumados y las dos clases por separado', () => {
  const n = { 500: 34, 750: 1, 1000: 5 };
  assert.strictEqual(textoQuitadosFr([500], n), 'Quitaste 500 g: sus 34 productos se costean sin envase y sin aviso al guardar.');
  assert.strictEqual(textoQuitadosFr([750], n), 'Quitaste 750 g: su producto se costea sin envase y sin aviso al guardar.');
  assert.strictEqual(textoQuitadosFr([500, 1000], n), 'Quitaste 500 g y 1 kg: sus 39 productos se costean sin envase y sin aviso al guardar.');
  assert.strictEqual(textoQuitadosFr([300, 500], n), 'Quitaste 500 g: sus 34 productos se costean sin envase y sin aviso al guardar. Quitaste 300 g: se saca de la lista al guardar.');
  assert.strictEqual(textoQuitadosFr([300, 750, 2000], { 300: 0 }), 'Quitaste 300 g, 750 g y 2 kg: se sacan de la lista al guardar.'); // 0 o desconocido = sin productos
});

// ── vm ──
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const campoU = (input, u) => `<span class="campo-u">${input}<span class="u">${u}</span></span>`;
const numOrNull = v => { const s = String(v ?? '').trim(); if (s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
const CFG = { migrado: true, maquinas: [], tramosTiempo: [], subrubros: {}, porGranel: {}, subrubrosSiga: [], sinSubrubro: [], ajustesPeso: null, costoBobinaKg: 6000,
  pesos: [{ pesoG: 250, presentaciones: 3 }, { pesoG: 500, presentaciones: 1 }, { pesoG: 1000, presentaciones: 2 }],
  envasePorPeso: { 250: { bolsaPlu: '900', bolsaNombre: '<b>x</b>', bolsaCosto: 20, bobinaG: 8 }, 300: { bobinaG: 5 }, 500: { bolsaPlu: '901', bolsaNombre: null, bolsaCosto: null },
    1500: { bobinaG: 10, bolsaNombre: null, bolsaCosto: null } } };

function cargar(extra = {}, cfg = CFG) {
  const ev = { msg: [], sucio: 0, marcados: 0 };
  const ctx = vm.createContext({ module: { exports: {} }, esc, campoU, numOrNull, fmtMoney: String, PreciosEsquema: { AJUSTES_PESO_MAX: 12 }, CSS: { escape: s => s },
    Event: class { constructor(type, o = {}) { this.type = type; this.bubbles = !!o.bubbles; } }, Intl,
    msgEsq: (_el, t, c) => ev.msg.push([t, c]), limpiarSucio: () => { ev.sucio += 1; }, marcarSucio: () => { ev.marcados += 1; }, esFraccCfg: () => true,
    document: { activeElement: null, getElementById: () => null, querySelector: () => null }, ...extra });
  vm.runInContext(fs.readFileSync(RUTA_CFG, 'utf8'), ctx, { filename: RUTA_CFG });
  vm.runInContext(fs.readFileSync(RUTA, 'utf8'), ctx, { filename: RUTA });
  vm.runInContext(`cfFr = ${JSON.stringify(cfg)}`, ctx);
  return { run: code => vm.runInContext(code, ctx), ev };
}
const $de = h => cheerio.load(`<div id="raiz">${h}</div>`)('#raiz');

test('htmlPesosFr: ✕ en TODAS las filas (con productos dice el efecto), sin "Vaciar", th con scope, aria-label con el peso, sin HTML inyectado', () => {
  const $ = $de(cargar().run('htmlPesosFr()'));
  const acc = p => $.find(`tr[data-peso="${p}"] .ev-acc button`);
  assert.deepStrictEqual([acc(250).text(), acc(250).attr('disabled'), acc(1000).text(), acc(1000).attr('disabled'), acc(300).text(), acc(1500).hasClass('ev-quitar'), $.find('.ev-vaciar').length],
    ['✕', undefined, '✕', undefined, '✕', true, 0]);
  assert.strictEqual(acc(250).attr('aria-label'), 'Quitar el peso 250 g: sus 3 productos se costean sin envase');
  assert.strictEqual(acc(500).attr('aria-label'), 'Quitar el peso 500 g: su producto se costea sin envase'); // singular
  assert.match(acc(250).attr('title'), /^Quitar este peso: sus 3 productos se costean sin envase y sin aviso. Después lo podés volver a poner$/);
  assert.strictEqual(acc(1500).attr('aria-label'), 'Quitar el peso 1500 g'); // sin productos: como antes
  assert.match(acc(1500).attr('title'), /al guardar se borra su envase/);
  $.find('th').each((_, th) => assert.ok($.find(th).attr('scope'), 'th sin scope'));
  assert.strictEqual($.find('.ev-agregar').text(), '+ Agregar peso');
  assert.match($.find('#evQuitados').attr('role'), /status/);
  assert.strictEqual($.find('#evTabla b b').length, 0); // nombre de bolsa escapado
});

test('htmlTablaPesosFr vacía: tabla con tbody vacío y texto de vacío; htmlPesosFr igual trae "+ Agregar peso"', () => {
  const { run } = cargar({}, { ...CFG, pesos: [], envasePorPeso: {} });
  const $ = $de(run('htmlPesosFr()'));
  assert.deepStrictEqual([$.find('#evTabla').length, $.find('#evTabla tbody').html(), $.find('.ev-agregar').length], [1, '', 1]);
  assert.match($.find('p.fr-vacio').text(), /No hay pesos en la tabla/);
});

test('htmlFilaPesoFr de fila nueva: input de peso con aria-label, chip nuevo, data-nuevo y ✕ "Quitar la fila nueva"', () => {
  const $ = $de(`<table><tbody>${cargar().run("htmlFilaPesoFr({ nuevo: 'n7', presentaciones: 0 })")}</tbody></table>`);
  const tr = $.find('tr[data-nuevo="n7"]');
  assert.strictEqual(tr.find('[data-k="pesoG"]').attr('aria-label'), 'Peso en gramos de la fila nueva');
  assert.strictEqual(tr.find('[data-k="pesoG"]').attr('aria-describedby'), 'evErrPeso-n7');
  assert.deepStrictEqual([tr.find('.ev-chip-nuevo').text(), tr.find('.ev-quitar').attr('aria-label'), tr.attr('data-peso')], ['nuevo', 'Quitar la fila nueva', undefined]);
  assert.match(tr.find('.ev-buscar').attr('aria-label'), /la fila nueva/);
});

// Tarjeta de mentira con filas reales y nuevas: [peso, plu, g, sin?] o { nuevo, pesoG, plu, g, sin? } (sin = casilla "No necesita bolsa ni bobina" marcada).
// Los inputs avisan input a card.oninput; la casilla también (dispatchEvent) y guarda disabled en los inputs, el Buscar y la casilla de su fila.
const enFoco = { el: null };
function tarjeta(costo, filas) {
  const card = {};
  const campo = (value, k, tr) => {
    const err = { textContent: '', hidden: true };
    return { value, validity: {}, attrs: {}, err, id: '', disabled: false, setAttribute(a, v) { this.attrs[a] = v; }, removeAttribute(a) { delete this.attrs[a]; },
      focus() { enFoco.el = this; }, matches: s => s === 'input[data-k]' || s === `[data-k="${k}"]`,
      closest: s => (s === 'tr' ? tr : { querySelector: () => err }), dispatchEvent(e) { if (card.oninput && e.type === 'input') card.oninput({ target: this }); } };
  };
  const filaDeHtml = html => { // la fila que arma htmlFilaPesoFr: nueva (data-nuevo) o de un peso (data-peso, con lo que lleva en sus inputs y su casilla)
    const nuevo = (html.match(/data-nuevo="(\w+)"/) || [])[1], v = k => (html.match(new RegExp(`data-k="${k}" value="([^"]*)"`)) || [])[1] ?? '';
    const sin = /class="ev-sin-chk"[^>]*\schecked/.test(html);
    return nuevo ? fila({ nuevo, pesoG: '', plu: '', g: '', sin }) : fila([html.match(/data-peso="(\d+)"/)[1], v('bolsaPlu'), v('bobinaG'), sin]);
  };
  const fila = d => {
    const tr = { dataset: {}, celdas: { '.ev-nota': { innerHTML: '' }, '.ev-bob': { innerHTML: '' } } };
    const [peso, plu, g, sin] = Array.isArray(d) ? d : [null, d.plu, d.g, d.sin];
    tr.inputs = { bolsaPlu: campo(plu, 'bolsaPlu', tr), bobinaG: campo(g, 'bobinaG', tr) };
    tr.buscar = { disabled: !!sin };
    tr.chk = { checked: !!sin, attrs: {}, matches: s => s === '.ev-sin-chk', closest: s => (s === 'tr' ? tr : null), focus() { enFoco.el = this; },
      dispatchEvent(e) { if (card.oninput && e.type === 'input') card.oninput({ target: this }); } };
    if (sin) { tr.inputs.bolsaPlu.disabled = true; tr.inputs.bobinaG.disabled = true; }
    if (Array.isArray(d)) tr.dataset.peso = String(peso); else { tr.dataset.nuevo = d.nuevo; tr.inputs.pesoG = campo(d.pesoG, 'pesoG', tr); }
    tr.boton = { disabled: false, focus() { enFoco.el = this; } };
    tr.querySelector = s => {
      const k = (s.match(/data-k="(\w+)"/) || [])[1];
      if (k) return tr.inputs[k] || null;
      if (s === '.ev-vaciar') return tr.vaciar || null;
      if (s === '.ev-sin-chk') return tr.chk;
      if (s === '.ev-buscar') return tr.buscar;
      if (s === '.ev-acc button:not(:disabled)') return tr.boton.disabled ? null : tr.boton;
      return tr.celdas[s];
    };
    Object.defineProperty(tr, 'nextElementSibling', { get: () => card.trs[card.trs.indexOf(tr) + 1] || null });
    Object.defineProperty(tr, 'previousElementSibling', { get: () => card.trs[card.trs.indexOf(tr) - 1] || null });
    tr.remove = () => card.trs.splice(card.trs.indexOf(tr), 1);
    tr.insertAdjacentHTML = (_p, html) => { card.html.push(html); card.trs.splice(card.trs.indexOf(tr), 0, filaDeHtml(html)); }; // 'beforebegin'
    return tr;
  };
  const todos = () => [card.costoI, ...card.trs.flatMap(t => Object.values(t.inputs))];
  const msg = {}, quitados = { textContent: '' }, agregar = { focus() { enFoco.el = this; } }, tira = { innerHTML: '', hidden: true };
  const cuerpo = { insertAdjacentHTML(_p, html) { card.html.push(html); card.trs.push(filaDeHtml(html)); }, // 'beforeend'
    get children() { return card.trs; }, get lastElementChild() { return card.trs.at(-1); } };
  Object.assign(card, { html: [], trs: [], costoI: campo(costo, 'costoBobinaKg', null), quitados, agregar, tira,
    querySelector: s => {
      const m = s.match(/^tr\[data-(peso|nuevo)="(\w+)"\] \[data-k="(\w+)"\]$/);
      if (m) return card.trs.find(t => t.dataset[m[1]] === m[2]).inputs[m[3]];
      return { '#frBobinaKg': card.costoI, '.esq-msg': msg, '.fr-guardar': {}, '#evQuitados': quitados, '#evSinEnvase': tira, '.ev-agregar': agregar, '#evTabla tbody': cuerpo }[s] || null;
    },
    querySelectorAll: s => {
      if (s === '#evTabla tbody tr') return [...card.trs];
      if (s === '[aria-invalid]') return todos().filter(i => i.attrs['aria-invalid']);
      if (s === '[data-k="pesoG"][aria-invalid]') return card.trs.map(t => t.inputs.pesoG).filter(i => i && i.attrs['aria-invalid']);
      return [];
    } });
  card.costoI.closest = () => ({ querySelector: () => card.costoI.err });
  card.trs = filas.map(fila);
  return card;
}
const FILAS = [[250, '900', '8'], [300, '', '5'], [500, '901', ''], [1000, '', ''], [1500, '', '10']];

test('agregarPesoFr: fila nueva al final con id propio (n1, n2…), foco en su peso y sin reordenar', () => {
  const { run, ev } = cargar();
  const card = tarjeta('6000', FILAS);
  run('agregarPesoFr')(card);
  run('agregarPesoFr')(card);
  assert.deepStrictEqual(card.trs.slice(-2).map(t => t.dataset.nuevo), ['n1', 'n2']);
  assert.strictEqual(card.trs.length, 7);
  assert.strictEqual(enFoco.el, card.trs.at(-1).inputs.pesoG);
  assert.match(card.html[0], /data-nuevo="n1"[\s\S]*aria-label="Peso en gramos de la fila nueva"/);
  assert.deepStrictEqual(ev.msg.at(-1), ['', undefined]);
});

test('quitarPesoFr: saca la fila, ensucia, avisa lo quitado (role=status) y pasa el foco a la vecina o a "+ Agregar peso"', () => {
  const { run, ev } = cargar();
  const card = tarjeta('6000', FILAS);
  run('quitarPesoFr')(card, card.trs[1]); // 300
  assert.deepStrictEqual(card.trs.map(t => t.dataset.peso), ['250', '500', '1000', '1500']);
  assert.strictEqual(card.quitados.textContent, 'Quitaste 300 g: se saca de la lista al guardar.');
  assert.strictEqual(enFoco.el, card.trs[1].boton); // la del 500, que quedó en su lugar
  assert.strictEqual(ev.marcados, 1);
  run('quitarPesoFr')(card, card.trs[3]); // 1500: última, el foco va a la de arriba
  const solo = tarjeta('6000', [[1500, '', '10']]);
  solo.trs[0].boton.disabled = false;
  run('quitarPesoFr')(solo, solo.trs[0]);
  assert.strictEqual(enFoco.el, solo.agregar);
  assert.strictEqual(card.quitados.textContent, 'Quitaste 300 g y 1500 g: se sacan de la lista al guardar.');
});

test('quitarPesoFr: tipear el peso quitado en una fila nueva lo saca del aviso y limpia el "ya está en la lista" viejo', () => {
  const { run } = cargar({}, { ...CFG, pesos: [{ pesoG: 250, presentaciones: 3 }], envasePorPeso: { 250: { bolsaPlu: '900' }, 300: { bobinaG: 5 } } });
  const card = tarjeta('6000', [[250, '900', '8'], { nuevo: 'n1', pesoG: '300', plu: '', g: '6' }, { nuevo: 'n2', pesoG: '300', plu: '', g: '' }]);
  run('marcarErrorFr')(card.trs[2].inputs.pesoG, 'Ese peso ya está en la lista');
  run('quitarPesoFr')(card, card.trs[1]);
  assert.strictEqual(card.trs[1].inputs.pesoG.attrs['aria-invalid'], undefined);
  assert.strictEqual(card.quitados.textContent, ''); // el 300 sigue en la tabla (fila nueva n2): reemplazo, nada quitado
});

test('fila nueva agregada y quitada antes de guardar no manda nada', async () => {
  const pedidos = [];
  const { run, ev } = cargar({ pedirEsq: async (...a) => { pedidos.push(a); return {}; } });
  const card = tarjeta('6000', FILAS);
  run('agregarPesoFr')(card);
  card.trs.at(-1).inputs.pesoG.value = '800';
  run('quitarPesoFr')(card, card.trs.at(-1));
  await run('guardarEnvaseFr')(card);
  assert.deepStrictEqual([pedidos.length, ev.msg.at(-1)[0]], [0, 'No hay cambios para guardar']);
});

// CFG con el 500 ya guardado quitado (tira) y el 1000 con envase: filas de la tabla = 250, 300, 1000 y 1500 (sin 500).
const CFG_SIN = { ...CFG, envasePorPeso: { 250: { bolsaPlu: '900', bolsaNombre: 'Z', bolsaCosto: 20, bobinaG: 8 }, 300: { bobinaG: 5 }, 500: { sinEnvase: true, oculto: true },
  1000: { bolsaPlu: '905', bolsaNombre: 'Y', bolsaCosto: 9 }, 1500: { bobinaG: 10 } } };
const FILAS_SIN = [[250, '900', '8'], [300, '', '5'], [1000, '905', ''], [1500, '', '10']];
const nombresTira = card => { const $ = $de(card.tira.innerHTML); return $.find('.ev-sin-item b').toArray().map(b => $.find(b).text()); };

test('quitarPesoFr de un peso CON productos: sale de la tabla, el aviso dice que se costean sin envase y sin aviso, pasa a la tira y el foco va a la vecina', () => {
  const { run, ev } = cargar();
  const card = tarjeta('6000', FILAS);
  run('quitarPesoFr')(card, card.trs[0]); // 250 (3 productos)
  assert.deepStrictEqual(card.trs.map(t => t.dataset.peso), ['300', '500', '1000', '1500']);
  assert.strictEqual(card.quitados.textContent, 'Quitaste 250 g: sus 3 productos se costean sin envase y sin aviso al guardar.');
  const $ = $de(card.tira.innerHTML);
  assert.deepStrictEqual([card.tira.hidden, nombresTira(card), $.find('.ev-poner').attr('aria-label')], [false, ['250 g'], 'Volver a poner el peso 250 g']);
  assert.strictEqual(enFoco.el, card.trs[0].boton); // la del 300, que quedó primera
  assert.strictEqual(ev.marcados, 1);
  run('quitarPesoFr')(card, card.trs[0]); // 300: sin productos, con envase guardado
  run('quitarPesoFr')(card, card.trs[0]); // 500: 1 producto
  assert.strictEqual(card.quitados.textContent, 'Quitaste 250 g y 500 g: sus 4 productos se costean sin envase y sin aviso al guardar. Quitaste 300 g: se saca de la lista al guardar.');
  assert.deepStrictEqual(nombresTira(card), ['250 g', '500 g']); // el 300 no tiene productos: no va a la tira
});

test('quitar TODAS las filas: el foco va a "+ Agregar peso" y todos los pesos con productos quedan en la tira', () => {
  const { run } = cargar({}, { ...CFG, envasePorPeso: {} });
  const card = tarjeta('', [[250, '', ''], [500, '', ''], [1000, '', '']]);
  card.trs.slice().forEach(tr => run('quitarPesoFr')(card, tr));
  assert.deepStrictEqual([card.trs.length, enFoco.el === card.agregar, card.tira.hidden, nombresTira(card)], [0, true, false, ['250 g', '500 g', '1 kg']]);
  assert.strictEqual(card.quitados.textContent, 'Quitaste 250 g, 500 g y 1 kg: sus 6 productos se costean sin envase y sin aviso al guardar.');
});

test('la tira: oculta sin pesos quitados; con ellos, título, ayuda, productos como botón (abre el modal) y "Volver a poner" accesible; sin HTML inyectado', () => {
  const sin = $de(cargar().run('htmlPesosFr()')).find('#evSinEnvase');
  assert.deepStrictEqual([sin.length, sin.attr('hidden') !== undefined, sin.find('.ev-sin-item').length], [1, true, 0]);
  const $ = $de(cargar({}, CFG_SIN).run('htmlPesosFr()')), tira = $.find('#evSinEnvase');
  assert.deepStrictEqual([tira.attr('hidden'), tira.find('.ev-sin-t').text(), $.find('#evTabla tbody tr').toArray().map(tr => $.find(tr).attr('data-peso'))],
    [undefined, 'Pesos quitados de la tabla', ['250', '300', '1000', '1500']]);
  assert.strictEqual(tira.find('.ev-sin-ayuda').text(), 'Estos pesos no suman costo de envase y no avisan. Volvé a ponerlos para cargarles bolsa o bobina.');
  assert.strictEqual(tira.attr('aria-labelledby'), tira.find('.ev-sin-t').attr('id'));
  const item = tira.find('.ev-sin-item'), ver = item.find('.ev-prod-ver'), poner = item.find('.ev-poner');
  assert.deepStrictEqual([item.length, item.find('b').text(), ver.text(), ver.attr('data-prod-peso'), ver.attr('data-sin-envase'), ver.attr('aria-label')],
    [1, '500 g', '1 producto', '500', '', 'Ver el producto de 500 g']);
  assert.deepStrictEqual([poner.text(), poner.attr('data-poner'), poner.attr('aria-label'), poner.attr('type')], ['Volver a poner', '500', 'Volver a poner el peso 500 g', 'button']);
  assert.strictEqual($.find('#evTabla .ev-prod-ver[data-sin-envase]').length, 0); // los botones de la tabla no llevan la marca
  const malo = cargar().run('htmlSinEnvaseFr')([{ pesoG: '"><img src=x onerror=alert(1)>', presentaciones: 0, guardado: true }]);
  assert.strictEqual($de(malo).find('img').length, 0);
});

test('la tira muestra un peso guardado quitado y sin productos con texto plano (no botón), y la tabla queda vacía', () => {
  const $ = $de(cargar({}, { ...CFG, pesos: [], envasePorPeso: { 750: { sinEnvase: true, oculto: true } } }).run('htmlPesosFr()'));
  assert.deepStrictEqual([$.find('#evTabla tbody').html(), $.find('#evSinEnvase .ev-prod-ver').length, $.find('#evSinEnvase .ev-sin-prod').text()], ['', 0, 'sin productos']);
});

test('ponerPesoFr: la fila vuelve en su lugar (ascendente), vacía si estaba guardado sin envase, con foco en su PLU; ensucia y repinta la tira', () => {
  const { run, ev } = cargar({}, CFG_SIN);
  const card = tarjeta('6000', FILAS_SIN);
  run('ponerPesoFr')(card, 500);
  assert.deepStrictEqual(card.trs.map(t => t.dataset.peso), ['250', '300', '500', '1000', '1500']);
  assert.deepStrictEqual([card.trs[2].inputs.bolsaPlu.value, card.trs[2].inputs.bobinaG.value, enFoco.el === card.trs[2].inputs.bolsaPlu, ev.marcados], ['', '', true, 1]);
  assert.match(card.html.at(-1), /data-peso="500"[\s\S]*Quitar el peso 500 g: su producto se costea sin envase/);
  assert.deepStrictEqual([card.tira.hidden, card.quitados.textContent], [true, '']);
  run('ponerPesoFr')(card, 7777); // un peso que no existe: nada
  assert.strictEqual(card.trs.length, 5);
  const ultimo = tarjeta('6000', [[250, '900', '8']]);
  run('ponerPesoFr')(ultimo, 500); // sin ninguna fila mayor: al final
  assert.deepStrictEqual(ultimo.trs.map(t => t.dataset.peso), ['250', '500']);
});

test('ponerPesoFr de un peso recién quitado (sin guardar) restaura lo guardado: es deshacer y guardar no manda nada', async () => {
  const pedidos = [];
  const { run, ev } = cargar({ pedirEsq: async (...a) => { pedidos.push(a); return {}; } }, CFG_SIN);
  const card = tarjeta('6000', FILAS_SIN);
  run('quitarPesoFr')(card, card.trs[2]); // 1000 (envase guardado: bolsa 905)
  assert.deepStrictEqual(nombresTira(card), ['500 g', '1 kg']);
  run('ponerPesoFr')(card, 1000);
  assert.deepStrictEqual([card.trs.map(t => t.dataset.peso), card.trs[2].inputs.bolsaPlu.value, card.quitados.textContent], [['250', '300', '1000', '1500'], '905', '']);
  await run('guardarEnvaseFr')(card);
  assert.deepStrictEqual([pedidos.length, ev.msg.at(-1)[0]], [0, 'No hay cambios para guardar']);
});

test('conectarPesosFr: el clic en "Volver a poner" re-agrega la fila; en "N productos" de la tira abre el modal "sin envase"', () => {
  const d = dialogo(), { run } = cargar({ document: { getElementById: () => d } }, CFG_SIN);
  const card = tarjeta('6000', FILAS_SIN);
  run('conectarPesosFr')(card);
  card.onclick({ target: { closest: () => ({ matches: s => s === '.ev-poner', dataset: { poner: '500' } }) } });
  assert.deepStrictEqual(card.trs.map(t => t.dataset.peso), ['250', '300', '500', '1000', '1500']);
  const btn = { dataset: { prodPeso: '1000', sinEnvase: '' }, matches: s => s === '.ev-prod-ver', focus() { enFoco.el = this; } };
  card.onclick({ target: { closest: () => btn } });
  assert.strictEqual(d.querySelector('.ev-prod-envase').textContent, 'Sin envase: no suma costo ni avisa'); // un peso quitado sin guardar también
});

function servidor(pedidos, enriquecido) {
  let repintado = '';
  const nuevo = { querySelector: () => ({ focus() {} }), set outerHTML(v) { repintado = v; } };
  return {
    repintado: () => repintado,
    extra: {
      pedirEsq: async (m, u, b) => {
        pedidos.push(JSON.parse(JSON.stringify([m, u.split('/').pop(), b ?? null])));
        return m === 'PUT' ? { migrado: true, costoBobinaKg: 6000, envasePorPeso: { 800: { bobinaG: 6 } } } : { pesos: CFG.pesos, envasePorPeso: enriquecido };
      },
      document: { activeElement: null, querySelector: () => null, getElementById: id => (id === 'frPesos' ? nuevo : id === 'cfgFraccAviso' ? { classList: { toggle() {} } } : null) } } };
}

test('guardarEnvaseFr lote mixto: quitar 300, vaciar 500, reemplazar 1500 y agregar 800 en UN PUT; repinta ordenado sin aviso de quitados', async () => {
  const pedidos = [];
  const enriquecido = { 250: { bolsaPlu: '900', bolsaNombre: 'Bolsa', bolsaCosto: 20, bobinaG: 8 }, 800: { bobinaG: 6 }, 1500: { bolsaPlu: '903', bolsaNombre: 'Zipper', bolsaCosto: 9 } };
  const srv = servidor(pedidos, enriquecido);
  const { run, ev } = cargar(srv.extra);
  const card = tarjeta('6000', FILAS);
  run('quitarPesoFr')(card, card.trs[1]);              // 300
  card.trs[1].inputs.bolsaPlu.value = '';               // 500 vaciado
  run('quitarPesoFr')(card, card.trs.at(-1));          // 1500
  run('agregarPesoFr')(card);
  card.trs.at(-1).inputs.pesoG.value = '1500'; card.trs.at(-1).inputs.bolsaPlu.value = '903';
  run('agregarPesoFr')(card);
  card.trs.at(-1).inputs.pesoG.value = '800'; card.trs.at(-1).inputs.bobinaG.value = '6';
  await run('guardarEnvaseFr')(card);
  assert.deepStrictEqual(pedidos, [['PUT', 'envase', { pesos: {
    300: { bolsaPlu: null, bobinaG: null }, 500: { bolsaPlu: null, bobinaG: null }, 800: { bolsaPlu: null, bobinaG: 6 }, 1500: { bolsaPlu: '903', bobinaG: null } } }],
  ['GET', 'costeo', null]]);
  assert.strictEqual(run('cfFr.envasePorPeso[1500].bolsaNombre'), 'Zipper'); // regresión: el envase crudo del PUT no pisa el enriquecido
  const $ = $de(srv.repintado());
  assert.deepStrictEqual($.find('#evTabla tbody tr').toArray().map(tr => $.find(tr).attr('data-peso')), ['250', '500', '800', '1000', '1500']);
  assert.deepStrictEqual([$.find('tr[data-nuevo]').length, $.find('#evQuitados').text()], [0, '']);
  assert.deepStrictEqual(ev.msg.at(-1), ['Guardado', 'text-ok']);
});

test('guardarEnvaseFr: errores de filas nuevas sin PUT, foco al primero y "Hay N campos para corregir"', async () => {
  const pedidos = [];
  const { run, ev } = cargar({ pedirEsq: async (...a) => { pedidos.push(a); return {}; } });
  const card = tarjeta('6000', [[250, '900', '8'], { nuevo: 'n1', pesoG: '250', plu: '9', g: '' }, { nuevo: 'n2', pesoG: '700', plu: '', g: '' }]);
  card.trs[1].inputs.pesoG.validity = {};
  await run('guardarEnvaseFr')(card);
  assert.strictEqual(pedidos.length, 0);
  assert.deepStrictEqual([card.trs[1].inputs.pesoG.err.textContent, card.trs[2].inputs.bolsaPlu.err.textContent.slice(0, 5)], ['Ese peso ya está en la lista', 'Cargá']);
  assert.strictEqual(enFoco.el, card.trs[1].inputs.pesoG);
  assert.deepStrictEqual(ev.msg.at(-1), ['Hay 2 campos para corregir (marcados en rojo)', 'text-crit']);
  card.trs[1].inputs.pesoG.value = ''; card.trs[1].inputs.pesoG.validity = { badInput: true }; // texto roto en el peso
  await run('guardarEnvaseFr')(card);
  assert.strictEqual(card.trs[1].inputs.pesoG.err.textContent, 'Gramos enteros, de 1 a 999999');
});

test('guardarEnvaseFr: si el PUT falla no pierde lo tipeado ni repinta', async () => {
  let repintado = '';
  const { run, ev } = cargar({ pedirEsq: async () => { throw new Error('envase por peso: máximo 200 pesos'); },
    document: { activeElement: null, querySelector: () => null, getElementById: id => (id === 'frPesos' ? { set outerHTML(v) { repintado = v; } } : null) } });
  const card = tarjeta('6000', [[250, '900', '8'], { nuevo: 'n1', pesoG: '800', plu: '', g: '6' }]);
  await run('guardarEnvaseFr')(card);
  assert.strictEqual(repintado, '');
  assert.deepStrictEqual([card.trs.length, card.trs[1].inputs.pesoG.value, card.trs[1].inputs.bobinaG.value], [2, '800', '6']);
  assert.match(ev.msg.at(-1)[0], /máximo 200 pesos/);
});

test('pesoDeFilaFr / abrir buscador en fila nueva: usa el peso tipeado o "la fila nueva"', () => {
  const { run } = cargar();
  const tr = v => ({ dataset: {}, querySelector: () => ({ value: v }) });
  assert.deepStrictEqual([run('pesoDeFilaFr')(tr('750')), Number.isNaN(run('pesoDeFilaFr')(tr(''))), run('pesoDeFilaFr')({ dataset: { peso: '250' } })], [750, false, 250]);
});

test('cuerpoCambiosEnvaseFr con pesos agregados y quitados: nuevos con su envase, quitados y vaciados null/null, reemplazo sin null/null', () => {
  const run = cargar().run;
  const cuerpo = (...a) => JSON.parse(JSON.stringify(run('cuerpoCambiosEnvaseFr')(...a)) ?? 'null');
  const epp = { 250: { bolsaPlu: '900' }, 300: { bobinaG: 5 }, 500: { bobinaG: 8 } };
  assert.deepStrictEqual(cuerpo('', [{ pesoG: 250, plu: '900', g: '' }, { pesoG: 500, plu: '', g: '' }, { nuevo: 'n1', pesoG: '800', plu: ' 7 ', g: '' }], null, epp),
    { pesos: { 300: { bolsaPlu: null, bobinaG: null }, 500: { bolsaPlu: null, bobinaG: null }, 800: { bolsaPlu: '7', bobinaG: null } } });
  assert.deepStrictEqual(cuerpo('', [{ pesoG: 250, plu: '900', g: '' }, { pesoG: 500, plu: '', g: '8' }, { nuevo: 'n1', pesoG: '300', plu: '', g: '6' }], null, epp),
    { pesos: { 300: { bolsaPlu: null, bobinaG: 6 } } });
  assert.strictEqual(cuerpo('', [{ pesoG: 250, plu: '900', g: '' }, { pesoG: 500, plu: '', g: '8' }, { nuevo: 'n1', pesoG: '300', plu: '', g: '5' }], null, epp), null);
});

// ── Modal "Productos de N g": el botón de la celda del peso, la lista de un peso desde cfFr, el filtro y el DOM del modal ──
const { productosDePesoFr, textoEnvasePesoFr } = require(RUTA);
const { productosPorSubrubro } = require('../lib/precios_config_fraccionado');
const plano = x => JSON.parse(JSON.stringify(x)); // los arrays del vm tienen otro prototipo: se comparan como JSON
const pr = (plu, nombre, pesoG) => ({ plu, nombre, pesoG });
const CF_PROD = { ...CFG, envasePorPeso: { 500: { bolsaPlu: '901', bolsaNombre: 'Zipper 500', bolsaCosto: 9, bobinaG: 8 } },
  pesos: [{ pesoG: 250, presentaciones: 1 }, { pesoG: 500, presentaciones: 4 }],
  subrubrosSiga: [
    { id: 1, nombre: 'Frutos secos', graneles: [
      { plu: '100', nombre: 'ALMENDRAS GRANEL', presentaciones: [pr('101', 'ALMENDRAS 500G', 500), pr('102', 'ALMENDRAS 250G', 250), pr('103', 'ALMENDRAS ESPECIAL', null)] },
      { plu: '110', nombre: 'NUEZ PELADA', presentaciones: [pr('111', 'NUEZ PELADA 500G', 500)] }] },
    { id: 2, nombre: 'Semillas', graneles: [{ plu: '200', nombre: 'CHÍA', presentaciones: [pr('201', 'CHÍA 500G', 500)] }] }],
  sinSubrubro: [{ plu: '300', nombre: 'ZZ SUELTO', presentaciones: [pr('301', 'ÁVENA <img src=x onerror=alert(1)> 500G', 500)] }],
  porGranel: { 110: { envase: 'bobina' }, 100: { envase: 'bolsa' }, 200: {} } };

test('productosDePesoFr: junta graneles de varios subrubros y sin subrubro, ordena por nombre (es) y trae el envase de su granel (bolsa si no eligió)', () => {
  assert.deepStrictEqual(productosDePesoFr(CF_PROD, 500).map(p => [p.plu, p.granelPlu, p.granelNombre, p.envase]), [
    ['101', '100', 'ALMENDRAS GRANEL', 'bolsa'], ['301', '300', 'ZZ SUELTO', 'bolsa'], ['201', '200', 'CHÍA', 'bolsa'], ['111', '110', 'NUEZ PELADA', 'bobina']]);
  assert.deepStrictEqual(productosDePesoFr(CF_PROD, 250), [{ plu: '102', nombre: 'ALMENDRAS 250G', granelPlu: '100', granelNombre: 'ALMENDRAS GRANEL', envase: 'bolsa' }]);
  assert.deepStrictEqual([productosDePesoFr(CF_PROD, 750), productosDePesoFr({}, 500), productosDePesoFr({ subrubrosSiga: [{ graneles: [{ plu: '1' }] }] }, 500)], [[], [], []]);
  assert.strictEqual(CF_PROD.subrubrosSiga[0].graneles[0].presentaciones.length, 3); // no muta
});

test('productosDePesoFr cuenta lo mismo que cfFr.pesos (productosPorSubrubro): un granel sin PLU no entra ni en la lista ni en el conteo', () => {
  const grupos = [
    { plu: '100', nombre: 'ALMENDRAS', subrubroId: 1, subrubro: 'Frutos secos', presentaciones: [{ plu: '101', nombre: 'ALMENDRAS 500G' }, { plu: '102', nombre: 'ALMENDRAS 250G' }, { plu: '103', nombre: 'ALMENDRAS ESPECIAL' }] },
    { plu: '300', nombre: 'AVENA', subrubroId: null, presentaciones: [{ plu: '301', nombre: 'AVENA 500G' }, { plu: '302', nombre: 'AVENA 500G ZIPPER' }] },
    { plu: null, nombre: 'SIN GRANEL', subrubroId: null, presentaciones: [{ plu: '901', nombre: 'HUERFANO 500G' }] }];
  const cf = productosPorSubrubro(grupos);
  assert.deepStrictEqual(cf.pesos, [{ pesoG: 250, presentaciones: 1 }, { pesoG: 500, presentaciones: 3 }]);
  cf.pesos.forEach(({ pesoG, presentaciones }) => assert.strictEqual(productosDePesoFr(cf, pesoG).length, presentaciones, `${pesoG} g`));
});

test('textoEnvasePesoFr: bolsa con o sin nombre, bobina, las dos, y "Sin envase cargado"', () => {
  assert.strictEqual(textoEnvasePesoFr({ bolsaPlu: '4521', bolsaNombre: 'Zipper', bobinaG: 8 }), 'Bolsa PLU 4521 (Zipper) · Bobina 8 g');
  assert.strictEqual(textoEnvasePesoFr({ bolsaPlu: '4521', bolsaNombre: null }), 'Bolsa PLU 4521');
  assert.strictEqual(textoEnvasePesoFr({ bobinaG: 8.5 }), 'Bobina 8,5 g');
  assert.deepStrictEqual([textoEnvasePesoFr(undefined), textoEnvasePesoFr({}), textoEnvasePesoFr({ bolsaNombre: 'x', bobinaG: 0 })], ['Sin envase cargado', 'Sin envase cargado', 'Sin envase cargado']);
});

test('filtrarProductosPesoFr: sin mayúsculas ni tildes, por nombre, PLU, granel y PLU del granel; varias palabras; vacío = todos; sin coincidencias = []', () => {
  const { run } = cargar();
  const lista = productosDePesoFr(CF_PROD, 500), f = t => plano(run('filtrarProductosPesoFr')(lista, t)).map(p => p.plu);
  assert.deepStrictEqual([f('chia'), f('CHÍA'), f('avena'), f('111'), f('suelto'), f('110'), f('nuez 500'), f('500 nuez')], [['201'], ['201'], ['301'], ['111'], ['301'], ['111'], ['111'], ['111']]);
  assert.deepStrictEqual([f(''), f('   ')], [['101', '301', '201', '111'], ['101', '301', '201', '111']]);
  assert.deepStrictEqual([f('zzz'), f('nuez avena')], [[], []]);
});

test('htmlPesosFr: "N productos" es un botón accesible que abre el modal; "sin productos" y la fila nueva, texto plano', () => {
  const { run } = cargar();
  const $ = $de(run('htmlPesosFr()'));
  const b = $.find('tr[data-peso="250"] .fr-peso button');
  assert.deepStrictEqual([b.length, b.text(), b.attr('type'), b.attr('aria-haspopup'), b.attr('aria-label'), b.attr('data-prod-peso'), b.hasClass('ev-prod-ver')],
    [1, '3 productos', 'button', 'dialog', 'Ver los 3 productos de 250 g', '250', true]);
  assert.strictEqual($.find('tr[data-peso="500"] .fr-peso button').attr('aria-label'), 'Ver el producto de 500 g'); // singular
  assert.deepStrictEqual([$.find('tr[data-peso="1500"] .fr-peso button').length, $.find('tr[data-peso="1500"] .fr-peso span').text()], [0, 'sin productos']);
  const nueva = $de(`<table><tbody>${run("htmlFilaPesoFr({ nuevo: 'n1', presentaciones: 0 })")}</tbody></table>`);
  assert.strictEqual(nueva.find('.ev-prod-ver').length, 0);
});

// <dialog> de mentira: los elementos de adentro se crean al pedirlos; close() dispara los listeners de 'close' (una vez, como { once: true }).
function dialogo() {
  const els = {}, d = { open: false, oyentes: [], showModal() { d.open = true; },
    querySelector: s => els[s] || (els[s] = { textContent: '', innerHTML: '', value: '', scrollTop: 0, focus() { enFoco.el = this; } }),
    addEventListener(t, f) { d.oyentes.push([t, f]); },
    close() { d.open = false; d.oyentes.splice(0).forEach(([t, f]) => t === 'close' && f()); } };
  return d;
}

test('abrirProductosPesoFr: título, envase de hoy, foco al buscador, filtra al tipear con contador, avisa sin coincidencias y Cerrar devuelve el foco', () => {
  const d = dialogo(), { run } = cargar({ document: { getElementById: id => (id === 'dlgEvProductos' ? d : null) } }, CF_PROD), q = s => d.querySelector(s);
  const opener = { focus() { enFoco.el = this; } };
  run('abrirProductosPesoFr')(500, opener);
  assert.deepStrictEqual([d.open, q('.ev-prod-titulo').textContent, q('.ev-prod-envase').textContent, q('.ev-prod-cuenta').textContent, enFoco.el === q('.ev-prod-bus')],
    [true, 'Productos de 500 g', 'Envase: Bolsa PLU 901 (Zipper 500) · Bobina 8 g', 'Mostrando 4 de 4', true]);
  const lista = $de(q('.ev-prod-cuerpo').innerHTML);
  assert.deepStrictEqual(lista.find('li b').toArray().map(b => lista.find(b).text().slice(0, 5)), ['ALMEN', 'ÁVENA', 'CHÍA ', 'NUEZ ']); // por nombre
  assert.strictEqual(lista.find('li').eq(0).find('span').text(), 'PLU 101 · Granel: ALMENDRAS GRANEL · Usa: Bolsa');
  assert.match(lista.find('li').eq(3).find('span').text(), /Usa: Bobina$/);
  assert.strictEqual(lista.find('img').length, 0); // el nombre con <img onerror> de SIGA va escapado
  assert.match(lista.find('li').eq(1).find('b').text(), /<img src=x onerror=alert\(1\)>/);

  q('.ev-prod-bus').value = 'nuez'; q('.ev-prod-bus').oninput();
  assert.deepStrictEqual([q('.ev-prod-cuenta').textContent, $de(q('.ev-prod-cuerpo').innerHTML).find('li').length], ['Mostrando 1 de 4', 1]);
  q('.ev-prod-bus').value = ' <b>zzz '; q('.ev-prod-bus').oninput();
  const vacio = $de(q('.ev-prod-cuerpo').innerHTML);
  assert.deepStrictEqual([q('.ev-prod-cuenta').textContent, vacio.find('li').length, vacio.find('b').length, vacio.find('p').text()], ['Mostrando 0 de 4', 0, 0, 'Ningún producto coincide con «<b>zzz»']);
  q('.ev-prod-bus').value = ''; q('.ev-prod-bus').oninput();
  assert.strictEqual(q('.ev-prod-cuenta').textContent, 'Mostrando 4 de 4');

  q('.ev-prod-cerrar').onclick();
  assert.deepStrictEqual([d.open, enFoco.el === opener], [false, true]);
  run('abrirProductosPesoFr')(250, opener); // reabrir: buscador vacío, otro peso, sin envase
  assert.deepStrictEqual([q('.ev-prod-bus').value, q('.ev-prod-titulo').textContent, q('.ev-prod-envase').textContent, q('.ev-prod-cuenta').textContent],
    ['', 'Productos de 250 g', 'Envase: Sin envase cargado', 'Mostrando 1 de 1']);
  d.close();
  assert.strictEqual(enFoco.el, opener); // también al cerrar con Esc (evento close)
});

test('conectarPesosFr: el clic en "N productos" abre el modal de ese peso y el foco vuelve a ese botón', () => {
  const d = dialogo(), { run } = cargar({ document: { getElementById: () => d } }, CF_PROD);
  const card = tarjeta('6000', FILAS);
  run('conectarPesosFr')(card);
  const btn = { dataset: { prodPeso: '250' }, matches: s => s === '.ev-prod-ver', focus() { enFoco.el = this; } };
  card.onclick({ target: { closest: () => btn } });
  assert.deepStrictEqual([d.open, d.querySelector('.ev-prod-titulo').textContent], [true, 'Productos de 250 g']);
  d.close();
  assert.strictEqual(enFoco.el, btn);
});

test('vistaProductosPesoFr: escapa nombre, PLU y granel de SIGA y el texto buscado; caracteres de regex no rompen; 300 productos', () => {
  const { run } = cargar();
  const malo = [{ plu: '<i>1</i>', nombre: 'A & "B" <img src=x onerror=alert(1)>', granelPlu: 9, granelNombre: '<b>G</b>', envase: 'bobina' }];
  const v = run(`vistaProductosPesoFr(${JSON.stringify(malo)}, '')`);
  const $ = $de(v.html);
  assert.deepStrictEqual([$.find('img').length, $.find('i').length, $.find('span b').length, v.cuenta], [0, 0, 0, 'Mostrando 1 de 1']);
  assert.match($.find('li span').text(), /Usa: Bobina$/);
  const simple = [{ plu: 7, nombre: 'Maní (pelado) 500 g', granelPlu: 9, granelNombre: 'Maní', envase: 'bolsa' }];
  const cuenta = t => run(`vistaProductosPesoFr(${JSON.stringify(simple)}, ${JSON.stringify(t)})`).cuenta;
  for (const t of ['*', '\\', '  [a-  ', '.*']) assert.strictEqual(cuenta(t), 'Mostrando 0 de 1', t); // literal, no regex
  assert.strictEqual(cuenta('  (PELADO)  mani '), 'Mostrando 1 de 1');
  assert.strictEqual($de(run(`vistaProductosPesoFr([], '<script>x</script>')`).html).find('script').length, 0);
  const muchos = Array.from({ length: 300 }, (_, i) => ({ plu: i, nombre: `Prod ${i}`, granelPlu: 1, granelNombre: 'G', envase: 'bolsa' }));
  assert.strictEqual(run(`vistaProductosPesoFr(${JSON.stringify(muchos)}, '  ')`).cuenta, 'Mostrando 300 de 300');
});

// ── Pesos quitados y casilla "No necesita bolsa ni bobina": cuerpo del PUT, guardar, agregar un peso de la tira, errores del servidor y el modal ──
test('cuerpoCambiosEnvaseFr con pesos quitados: quitado con productos → sinEnvase:true + oculto:true, sin productos → null/null, volver a poner → sinEnvase:false, sin tocar → nada', () => {
  const run = cargar().run;
  const cuerpo = (...a) => JSON.parse(JSON.stringify(run('cuerpoCambiosEnvaseFr')(...a)) ?? 'null');
  const pesos = [{ pesoG: 250, presentaciones: 3 }, { pesoG: 500, presentaciones: 1 }, { pesoG: 1000, presentaciones: 2 }];
  const epp = { 250: { bolsaPlu: '900' }, 500: { sinEnvase: true, oculto: true }, 300: { bobinaG: 5 } };
  // 250 (con productos y envase) y 1000 (con productos, sin envase cargado) sin fila: sinEnvase:true + oculto:true; 300 (sin productos): null/null; el 500 ya está así: no se manda
  assert.deepStrictEqual(cuerpo('', [], null, epp, pesos), { pesos: { 250: { sinEnvase: true, oculto: true }, 300: { bolsaPlu: null, bobinaG: null }, 1000: { sinEnvase: true, oculto: true } } });
  const filas = (extra = []) => [{ pesoG: 250, plu: '900', g: '' }, { pesoG: 300, plu: '', g: '5' }, { pesoG: 1000, plu: '', g: '' }, ...extra];
  assert.strictEqual(cuerpo('', filas(), null, epp, pesos), null); // el 500 sin fila y sin tocar no se manda
  assert.deepStrictEqual(cuerpo('', filas([{ pesoG: 500, plu: ' 77 ', g: '' }]), null, epp, pesos), { pesos: { 500: { sinEnvase: false, bolsaPlu: '77', bobinaG: null } } });
  assert.deepStrictEqual(cuerpo('', filas([{ pesoG: 500, plu: '', g: '6' }]), null, epp, pesos), { pesos: { 500: { sinEnvase: false, bolsaPlu: null, bobinaG: 6 } } });
  assert.deepStrictEqual(cuerpo('', filas([{ pesoG: 500, plu: '', g: '' }]), null, epp, pesos), { pesos: { 500: { sinEnvase: false, bolsaPlu: null, bobinaG: null } } }); // vuelto a poner, vacío
  assert.deepStrictEqual(cuerpo('', [{ pesoG: 250, plu: '900', g: '' }, { pesoG: 1000, plu: '', g: '' }], null, { 250: { bolsaPlu: '900' } }, pesos), { pesos: { 500: { sinEnvase: true, oculto: true } } }); // 500 con productos y sin fila
  assert.strictEqual(cuerpo('', [{ pesoG: 250, plu: '900', g: '' }], null, { 250: { bolsaPlu: '900' } }, [{ pesoG: 250, presentaciones: 3 }]), null); // sin más pesos con productos: nada
  assert.deepStrictEqual(cuerpo('', [], null, { 300: { bobinaG: 5 } }, undefined), { pesos: { 300: { bolsaPlu: null, bobinaG: null } } }); // sin la lista de pesos: como antes
  assert.deepStrictEqual(cuerpo('7000', filas(), 6000, epp, pesos), { costoBobinaKg: 7000 });
});

test('guardarEnvaseFr: quitar un peso con productos manda UNA entrada { sinEnvase: true, oculto: true } (sin bolsa ni bobina) y repinta la tabla sin ese peso y la tira con él', async () => {
  const pedidos = [];
  const enriquecido = { 250: { bolsaPlu: '900', bolsaNombre: 'Bolsa', bolsaCosto: 20, bobinaG: 8 }, 300: { bobinaG: 5 }, 500: { bolsaPlu: '901', bolsaNombre: null, bolsaCosto: null },
    1000: { sinEnvase: true, oculto: true }, 1500: { bobinaG: 10 } };
  const srv = servidor(pedidos, enriquecido);
  const { run, ev } = cargar(srv.extra);
  const card = tarjeta('6000', FILAS);
  run('quitarPesoFr')(card, card.trs[3]); // 1000: 2 productos
  assert.strictEqual(card.quitados.textContent, 'Quitaste 1 kg: sus 2 productos se costean sin envase y sin aviso al guardar.');
  await run('guardarEnvaseFr')(card);
  assert.deepStrictEqual(pedidos[0], ['PUT', 'envase', { pesos: { 1000: { sinEnvase: true, oculto: true } } }]);
  assert.deepStrictEqual(Object.keys(pedidos[0][2].pesos[1000]), ['sinEnvase', 'oculto']); // sin bolsaPlu ni bobinaG
  const $ = $de(srv.repintado());
  assert.deepStrictEqual($.find('#evTabla tbody tr').toArray().map(tr => $.find(tr).attr('data-peso')), ['250', '300', '500', '1500']);
  assert.deepStrictEqual([$.find('#evSinEnvase').attr('hidden'), $.find('#evSinEnvase .ev-sin-item b').text(), $.find('#evQuitados').text(), ev.msg.at(-1)[0]], [undefined, '1 kg', '', 'Guardado']);
  assert.deepStrictEqual(run('estadoEnvaseActualFr()').texto, '1 bolsa sin costo'); // el chip cuenta sólo las filas visibles (el 1 kg sin envase no es "sin bolsa ni bobina")
});

test('guardarEnvaseFr: volver a poner un peso guardado sin envase manda { sinEnvase: false, bolsaPlu, bobinaG } con lo tipeado; si no se toca, no se manda', async () => {
  const pedidos = [];
  const srv = servidor(pedidos, { 500: { bolsaPlu: '77', bolsaNombre: 'Z', bolsaCosto: 3 } });
  const { run } = cargar(srv.extra, CFG_SIN);
  const card = tarjeta('6000', FILAS_SIN);
  run('ponerPesoFr')(card, 500);
  card.trs[2].inputs.bolsaPlu.value = '77';
  await run('guardarEnvaseFr')(card);
  assert.deepStrictEqual(pedidos[0], ['PUT', 'envase', { pesos: { 500: { sinEnvase: false, bolsaPlu: '77', bobinaG: null } } }]);
  const sin = [];
  const { run: run2 } = cargar({ pedirEsq: async (...a) => { sin.push(a); return {}; } }, CFG_SIN);
  await run2('guardarEnvaseFr')(tarjeta('6000', FILAS_SIN)); // el 500 sigue sin envase y no se tocó
  assert.strictEqual(sin.length, 0);
});

test('guardarEnvaseFr: un peso de la tira agregado a mano con "+ Agregar peso" es un error junto al campo y no hay PUT; el de la tabla sigue "ya está en la lista"', async () => {
  const pedidos = [];
  const { run, ev } = cargar({ pedirEsq: async (...a) => { pedidos.push(a); return {}; } }, CFG_SIN);
  const card = tarjeta('6000', [...FILAS_SIN, { nuevo: 'n1', pesoG: '500', plu: '9', g: '' }, { nuevo: 'n2', pesoG: '250', plu: '9', g: '' }, { nuevo: 'n3', pesoG: '750', plu: '9', g: '' }]);
  await run('guardarEnvaseFr')(card);
  assert.strictEqual(pedidos.length, 0);
  assert.deepStrictEqual([card.trs[4].inputs.pesoG.err.textContent, card.trs[5].inputs.pesoG.err.textContent, card.trs[6].inputs.pesoG.attrs['aria-invalid']],
    ['Ese peso está en «Pesos quitados de la tabla»: usá «Volver a poner»', 'Ese peso ya está en la lista', undefined]);
  assert.strictEqual(enFoco.el, card.trs[4].inputs.pesoG);
  assert.deepStrictEqual(ev.msg.at(-1), ['Hay 2 campos para corregir (marcados en rojo)', 'text-crit']);
  run('ponerPesoFr')(card, 500); // al volver a poner el 500 el aviso "está en Pesos quitados de la tabla" ya no vale y se limpia
  assert.strictEqual(card.trs.find(t => t.dataset.nuevo === 'n1').inputs.pesoG.attrs['aria-invalid'], undefined);
  assert.strictEqual(card.trs.find(t => t.dataset.nuevo === 'n2').inputs.pesoG.attrs['aria-invalid'], undefined); // cualquier cambio de la lista limpia los avisos de peso repetido (vuelven al guardar)
});

test('guardarEnvaseFr: si el PUT falla con un peso quitado, la tabla, la tira y el aviso quedan como estaban (nada se pierde)', async () => {
  let repintado = '';
  const { run, ev } = cargar({ pedirEsq: async () => { throw new Error('envase por peso: sinEnvase no admite bolsaPlu'); },
    document: { activeElement: null, querySelector: () => null, getElementById: id => (id === 'frPesos' ? { set outerHTML(v) { repintado = v; } } : null) } });
  const card = tarjeta('6000', FILAS);
  run('quitarPesoFr')(card, card.trs[3]); // 1000
  await run('guardarEnvaseFr')(card);
  assert.strictEqual(repintado, '');
  assert.deepStrictEqual([card.trs.map(t => t.dataset.peso), card.tira.hidden, card.quitados.textContent.slice(0, 20)], [['250', '300', '500', '1500'], false, 'Quitaste 1 kg: sus 2']);
  assert.match(ev.msg.at(-1)[0], /no admite bolsaPlu/);
  assert.strictEqual(ev.msg.at(-1)[1], 'text-crit');
});

test('textoEnvasePesoFr / abrirProductosPesoFr de un peso sin envase: "Sin envase: no suma costo ni avisa" y sus productos sin la línea "Usa"', () => {
  assert.strictEqual(textoEnvasePesoFr({ sinEnvase: true }), 'Sin envase: no suma costo ni avisa');
  const cf = { ...CF_PROD, envasePorPeso: { 500: { sinEnvase: true } } }; // casilla marcada (visible): el modal dice lo mismo que para un quitado
  const d = dialogo(), { run } = cargar({ document: { getElementById: id => (id === 'dlgEvProductos' ? d : null) } }, cf), q = s => d.querySelector(s);
  run('abrirProductosPesoFr')(500, { focus() {} });
  assert.strictEqual(q('.ev-prod-envase').textContent, 'Sin envase: no suma costo ni avisa');
  const lista = $de(q('.ev-prod-cuerpo').innerHTML);
  assert.deepStrictEqual([lista.find('li').length, lista.find('span').toArray().filter(x => /Usa:/.test(lista.find(x).text())).length], [4, 0]);
  assert.strictEqual(lista.find('li').eq(0).find('span').text(), 'PLU 101 · Granel: ALMENDRAS GRANEL');
  run('abrirProductosPesoFr')(250, { focus() {} }, true); // desde la tira, aunque todavía no esté guardado
  assert.deepStrictEqual([q('.ev-prod-envase').textContent, q('.ev-prod-cuenta').textContent], ['Sin envase: no suma costo ni avisa', 'Mostrando 1 de 1']);
  run('abrirProductosPesoFr')(250, { focus() {} }); // sin la marca y sin sinEnvase guardado: la línea de siempre
  assert.strictEqual(q('.ev-prod-envase').textContent, 'Envase: Sin envase cargado');
});

// ── Casilla "No necesita bolsa ni bobina" (sinEnvase visible: la fila se queda en la tabla) ──
// 250 guardado con la casilla; 750 también pero sin productos; el resto como CFG. Filas de la tabla: 250, 300, 500, 750, 1000, 1500.
const CFG_CAS = { ...CFG, envasePorPeso: { 250: { sinEnvase: true }, 300: { bobinaG: 5 }, 500: { bolsaPlu: '901', bolsaNombre: 'Z', bolsaCosto: 9 }, 750: { sinEnvase: true },
  1500: { bobinaG: 10 } } };
const FILAS_CAS = [[250, '', '', true], [300, '', '5'], [500, '901', ''], [750, '', '', true], [1000, '', ''], [1500, '', '10']];
const cuerpoDe = (run, ...a) => JSON.parse(JSON.stringify(run('cuerpoCambiosEnvaseFr')(...a)) ?? 'null');

test('htmlPesosFr: cada fila trae la casilla "No necesita bolsa ni bobina" (label real, aria-label con el peso); sin marcar nada queda deshabilitado', () => {
  const { run } = cargar();
  const $ = $de(run('htmlPesosFr()'));
  const l = $.find('tr[data-peso="250"] label.ev-sin-chk-l'), c = l.find('input[type=checkbox].ev-sin-chk');
  assert.deepStrictEqual([l.text().trim(), c.length, c.attr('checked'), c.attr('aria-label')], ['No necesita bolsa ni bobina', 1, undefined, 'No necesita bolsa ni bobina: 250 g']);
  assert.deepStrictEqual([$.find('#evTabla tbody .ev-sin-chk').length, $.find('#evTabla input[disabled], #evTabla button[disabled]').length], [5, 0]);
  const nueva = $de(`<table><tbody>${run("htmlFilaPesoFr({ nuevo: 'n3', presentaciones: 0 })")}</tbody></table>`).find('tr[data-nuevo="n3"]');
  assert.deepStrictEqual([nueva.find('.ev-sin-chk').attr('aria-label'), nueva.find('.ev-sin-chk').attr('checked'), nueva.find('label.ev-sin-chk-l').text().trim()],
    ['No necesita bolsa ni bobina: la fila nueva', undefined, 'No necesita bolsa ni bobina']);
});

test('htmlPesosFr con pesos guardados con la casilla: siguen en la tabla marcados, con PLU, Buscar y gramos deshabilitados, "Sin envase" y "—"; la tira no los muestra', () => {
  const { run } = cargar({}, CFG_CAS);
  const $ = $de(run('htmlPesosFr()'));
  assert.deepStrictEqual($.find('#evTabla tbody tr').toArray().map(tr => $.find(tr).attr('data-peso')), ['250', '300', '500', '750', '1000', '1500']);
  for (const g of ['250', '750']) {
    const tr = $.find(`tr[data-peso="${g}"]`);
    assert.deepStrictEqual([tr.find('.ev-sin-chk').attr('checked') !== undefined, tr.find('[data-k="bolsaPlu"]').attr('disabled') !== undefined, tr.find('.ev-buscar').attr('disabled') !== undefined,
      tr.find('[data-k="bobinaG"]').attr('disabled') !== undefined, tr.find('[data-k="bolsaPlu"]').attr('value'), tr.find('.ev-nota').text(), tr.find('.ev-bob').text(),
      tr.find('.ev-quitar').attr('disabled')], [true, true, true, true, '', 'Sin envase', '—', undefined], g);
  }
  assert.deepStrictEqual([$.find('tr[data-peso="300"] [data-k="bolsaPlu"]').attr('disabled'), $.find('tr[data-peso="300"] .ev-sin-chk').attr('checked')], [undefined, undefined]);
  assert.deepStrictEqual([$.find('#evSinEnvase').attr('hidden') !== undefined, $.find('#evSinEnvase .ev-sin-item').length], [true, 0]);
  assert.strictEqual($.find('tr[data-peso="250"] .ev-prod-ver').text(), '3 productos'); // el botón del modal sigue
});

test('estadoEnvaseActualFr con la casilla: una fila marcada cuenta como resuelta; "todos resueltos" si hay marcadas y el resto está bien; "todos sin envase" si todas', () => {
  const chip = cfg => JSON.parse(JSON.stringify(cargar({}, cfg).run('estadoEnvaseActualFr()')));
  assert.deepStrictEqual(chip({ ...CFG, envasePorPeso: { 250: { sinEnvase: true }, 500: { bolsaPlu: '901', bolsaNombre: 'Z', bolsaCosto: 9 }, 1000: { bobinaG: 5 } } }), { texto: 'todos resueltos', estado: 'ok' });
  assert.deepStrictEqual(chip({ ...CFG, envasePorPeso: { 250: { sinEnvase: true }, 500: { sinEnvase: true }, 1000: { sinEnvase: true } } }), { texto: 'todos sin envase', estado: 'info' });
  assert.deepStrictEqual(chip({ ...CFG, envasePorPeso: { 250: { sinEnvase: true }, 500: { sinEnvase: true, oculto: true }, 1000: { bobinaG: 5 } } }), { texto: 'todos resueltos', estado: 'ok' });
  assert.deepStrictEqual(chip({ ...CFG, envasePorPeso: { 250: { sinEnvase: true }, 500: { bolsaPlu: '901', bolsaNombre: 'Z', bolsaCosto: null }, 1000: { bobinaG: 5 } } }), { texto: '1 bolsa sin costo', estado: 'falta' });
  assert.strictEqual(chip({ ...CFG, envasePorPeso: { 250: { sinEnvase: true } } }).texto, '2 sin bolsa ni bobina'); // 500 y 1000 sin nada; el 250 marcado no cuenta
});

test('la casilla: tildar deshabilita PLU, Buscar y gramos conservando lo tipeado, saca sus errores y pone "Sin envase" y "—"; destildar los habilita y recalcula; el foco queda en la casilla', () => {
  const { run, ev } = cargar({ document: { getElementById: () => ({ value: '6000' }) } });
  const card = tarjeta('6000', FILAS), tr = card.trs[0], plu = tr.inputs.bolsaPlu, g = tr.inputs.bobinaG, otra = card.trs[1].inputs.bobinaG;
  run('conectarPesosFr')(card);
  run('marcarErrorFr')(plu, 'El PLU lleva sólo dígitos'); run('marcarErrorFr')(g, 'Los gramos son un número');
  otra.value = '7'; // lo tipeado en otra fila no se toca
  tr.chk.checked = true; enFoco.el = tr.chk;
  tr.chk.dispatchEvent({ type: 'input' });
  assert.deepStrictEqual([plu.disabled, g.disabled, tr.buscar.disabled, plu.value, g.value, plu.attrs['aria-invalid'], g.attrs['aria-invalid'], plu.err.textContent, g.err.hidden],
    [true, true, true, '900', '8', undefined, undefined, '', true]);
  assert.deepStrictEqual([tr.celdas['.ev-nota'].innerHTML, tr.celdas['.ev-bob'].innerHTML, enFoco.el === tr.chk, otra.value, otra.disabled, ev.msg.at(-1)],
    ['Sin envase', '<span class="text-gris">—</span>', true, '7', false, ['', undefined]]);
  tr.chk.checked = false;
  tr.chk.dispatchEvent({ type: 'input' });
  assert.deepStrictEqual([plu.disabled, g.disabled, tr.buscar.disabled, plu.value, g.value], [false, false, false, '900', '8']); // lo tipeado vuelve
  assert.match(tr.celdas['.ev-bob'].innerHTML, /\$ 48<\/b> <span[^>]*>por unidad/);
  assert.match(tr.celdas['.ev-nota'].innerHTML, /\$ 20/);
});

test('cuerpoCambiosEnvaseFr con la casilla: marcada → { sinEnvase: true } sin bolsa ni bobina; guardada y sin tocar → nada; destildada → { sinEnvase: false, bolsaPlu, bobinaG }', () => {
  const { run } = cargar(), pesos = CFG_CAS.pesos, epp = CFG_CAS.envasePorPeso;
  const filas = (cambios = {}) => FILAS_CAS.map(([pesoG, plu, g, sin]) => ({ pesoG, plu, g, sin: !!sin, ...cambios[pesoG] }));
  assert.strictEqual(cuerpoDe(run, '6000', filas(), 6000, epp, pesos), null); // todo como está guardado
  // marcar un peso con envase (aunque tenga bolsa/bobina tipeada) y uno sin nada: sólo { sinEnvase: true }
  assert.deepStrictEqual(cuerpoDe(run, '6000', filas({ 500: { sin: true }, 1000: { sin: true, plu: '77', g: '9' } }), 6000, epp, pesos),
    { pesos: { 500: { sinEnvase: true }, 1000: { sinEnvase: true } } });
  // destildar el 250 (guardado con la casilla) con lo que tengan los inputs: vacíos → null, o con valores
  assert.deepStrictEqual(cuerpoDe(run, '6000', filas({ 250: { sin: false } }), 6000, epp, pesos), { pesos: { 250: { sinEnvase: false, bolsaPlu: null, bobinaG: null } } });
  assert.deepStrictEqual(cuerpoDe(run, '6000', filas({ 750: { sin: false, plu: ' 77 ', g: '6' } }), 6000, epp, pesos), { pesos: { 750: { sinEnvase: false, bolsaPlu: '77', bobinaG: 6 } } });
  // lo tipeado en los inputs de una fila marcada guardada no cuenta (están deshabilitados)
  assert.strictEqual(cuerpoDe(run, '6000', filas({ 250: { plu: '5', g: '2' } }), 6000, epp, pesos), null);
  // fila nueva con la casilla: { sinEnvase: true }
  assert.deepStrictEqual(cuerpoDe(run, '6000', [...filas(), { nuevo: 'n1', pesoG: '800', plu: '', g: '', sin: true }], 6000, epp, pesos), { pesos: { 800: { sinEnvase: true } } });
  // quitar con ✕ una fila marcada: con productos → quitado, sin productos → se borra
  assert.deepStrictEqual(cuerpoDe(run, '6000', filas().filter(f => f.pesoG !== 250 && f.pesoG !== 750), 6000, epp, pesos),
    { pesos: { 250: { sinEnvase: true, oculto: true }, 750: { bolsaPlu: null, bobinaG: null } } });
  // un quitado guardado (oculto) que vuelve a la tabla: marcado → oculto: false; sin marcar → sinEnvase: false
  const eppOculto = { ...epp, 500: { sinEnvase: true, oculto: true } };
  const sin500 = filas().filter(f => f.pesoG !== 500);
  assert.strictEqual(cuerpoDe(run, '6000', sin500, 6000, eppOculto, pesos), null);
  assert.deepStrictEqual(cuerpoDe(run, '6000', [...sin500, { pesoG: 500, plu: '', g: '', sin: true }], 6000, eppOculto, pesos), { pesos: { 500: { sinEnvase: true, oculto: false } } });
  assert.deepStrictEqual(cuerpoDe(run, '6000', [...sin500, { pesoG: 500, plu: '', g: '', sin: false }], 6000, eppOculto, pesos), { pesos: { 500: { sinEnvase: false, bolsaPlu: null, bobinaG: null } } });
});

test('guardarEnvaseFr: marcar la casilla manda { sinEnvase: true } sin bolsa ni bobina (aunque lo tipeado sea inválido); la fila sigue en la tabla marcada, el chip la cuenta resuelta', async () => {
  const pedidos = [];
  const srv = servidor(pedidos, { 250: { sinEnvase: true }, 300: { bobinaG: 5 }, 500: { bolsaPlu: '901', bolsaNombre: 'Z', bolsaCosto: 9 }, 1500: { bobinaG: 10 } });
  const { run, ev } = cargar(srv.extra);
  const card = tarjeta('6000', FILAS);
  card.trs[0].inputs.bolsaPlu.value = 'abc'; card.trs[0].inputs.bobinaG.value = '9999'; // inválidos, pero con la casilla no cuentan
  card.trs[0].chk.checked = true;
  await run('guardarEnvaseFr')(card);
  assert.deepStrictEqual(pedidos[0], ['PUT', 'envase', { pesos: { 250: { sinEnvase: true } } }]);
  assert.deepStrictEqual(Object.keys(pedidos[0][2].pesos[250]), ['sinEnvase']);
  const $ = $de(srv.repintado()), tr = $.find('tr[data-peso="250"]');
  assert.deepStrictEqual([$.find('#evTabla tbody tr').length, tr.find('.ev-sin-chk').attr('checked') !== undefined, tr.find('[data-k="bolsaPlu"]').attr('disabled') !== undefined,
    $.find('#evSinEnvase').attr('hidden') !== undefined, ev.msg.at(-1)[0], run('estadoEnvaseActualFr()').texto], [5, true, true, true, 'Guardado', '1 sin bolsa ni bobina']);
});

test('guardarEnvaseFr: una fila guardada con la casilla y sin tocar no manda nada; destildarla y cargar una bolsa manda { sinEnvase: false, bolsaPlu, bobinaG }', async () => {
  const sin = [];
  const { run: run0 } = cargar({ pedirEsq: async (...a) => { sin.push(a); return {}; } }, CFG_CAS);
  await run0('guardarEnvaseFr')(tarjeta('6000', FILAS_CAS));
  assert.strictEqual(sin.length, 0);
  const pedidos = [];
  const srv = servidor(pedidos, { 250: { bolsaPlu: '77', bolsaNombre: 'Z', bolsaCosto: 3 } });
  const { run } = cargar(srv.extra, CFG_CAS);
  const card = tarjeta('6000', FILAS_CAS);
  card.trs[0].chk.checked = false; card.trs[0].inputs.bolsaPlu.value = '77';
  await run('guardarEnvaseFr')(card);
  assert.deepStrictEqual(pedidos[0], ['PUT', 'envase', { pesos: { 250: { sinEnvase: false, bolsaPlu: '77', bobinaG: null } } }]);
});

test('"+ Agregar peso" con la casilla marcada: el peso vale sin bolsa ni bobina y se guarda { sinEnvase: true }; sin casilla y vacío sigue siendo error', async () => {
  const pedidos = [];
  const srv = servidor(pedidos, { 250: { bolsaPlu: '900', bolsaNombre: 'Z', bolsaCosto: 20, bobinaG: 8 }, 800: { sinEnvase: true } });
  const { run } = cargar(srv.extra);
  const card = tarjeta('6000', FILAS);
  run('agregarPesoFr')(card);
  card.trs.at(-1).inputs.pesoG.value = '800';
  await run('guardarEnvaseFr')(card);
  assert.strictEqual(pedidos.length, 0);
  assert.match(card.trs.at(-1).inputs.bolsaPlu.err.textContent, /tildá «No necesita bolsa ni bobina»/);
  card.trs.at(-1).chk.checked = true;
  await run('guardarEnvaseFr')(card);
  assert.deepStrictEqual(pedidos[0], ['PUT', 'envase', { pesos: { 800: { sinEnvase: true } } }]);
});

test('ponerPesoFr: un peso guardado quitado (oculto) vuelve con la casilla SIN marcar y vacío; si lo marcan se guarda { sinEnvase: true, oculto: false }; uno con la casilla quitado sin guardar vuelve marcado', async () => {
  const pedidos = [];
  const srv = servidor(pedidos, { 500: { sinEnvase: true } });
  const { run } = cargar(srv.extra, CFG_SIN);
  const card = tarjeta('6000', FILAS_SIN);
  run('ponerPesoFr')(card, 500);
  assert.deepStrictEqual([card.trs[2].chk.checked, card.trs[2].inputs.bolsaPlu.disabled, card.trs[2].inputs.bolsaPlu.value], [false, false, '']);
  card.trs[2].chk.checked = true;
  await run('guardarEnvaseFr')(card);
  assert.deepStrictEqual(pedidos[0], ['PUT', 'envase', { pesos: { 500: { sinEnvase: true, oculto: false } } }]);
  // deshacer: el 250 estaba guardado con la casilla, lo quitan (va a la tira) y lo vuelven a poner → marcado y deshabilitado, y guardar no manda nada
  const sin = [];
  const { run: run2 } = cargar({ pedirEsq: async (...a) => { sin.push(a); return {}; } }, CFG_CAS);
  const c2 = tarjeta('6000', FILAS_CAS);
  run2('quitarPesoFr')(c2, c2.trs[0]);
  assert.deepStrictEqual([nombresTira(c2), c2.quitados.textContent.slice(0, 19)], [['250 g'], 'Quitaste 250 g: sus']);
  run2('ponerPesoFr')(c2, 250);
  assert.deepStrictEqual([c2.trs[0].chk.checked, c2.trs[0].inputs.bolsaPlu.disabled, c2.trs[0].inputs.bobinaG.disabled, c2.trs[0].buscar.disabled], [true, true, true, true]);
  assert.strictEqual(enFoco.el, c2.trs[0].chk); // el PLU está deshabilitado: el foco va a la casilla
  await run2('guardarEnvaseFr')(c2);
  assert.strictEqual(sin.length, 0);
});

test('quitar con ✕ una fila guardada con la casilla: con productos va a la tira y manda { sinEnvase: true, oculto: true }; sin productos se borra (null/null)', async () => {
  const pedidos = [];
  const srv = servidor(pedidos, { 250: { sinEnvase: true, oculto: true }, 300: { bobinaG: 5 }, 500: { bolsaPlu: '901', bolsaNombre: 'Z', bolsaCosto: 9 }, 1500: { bobinaG: 10 } });
  const { run } = cargar(srv.extra, CFG_CAS);
  const card = tarjeta('6000', FILAS_CAS);
  run('quitarPesoFr')(card, card.trs[0]); // 250: 3 productos
  run('quitarPesoFr')(card, card.trs[2]); // 750 (el 250 ya no está): sin productos
  assert.deepStrictEqual([nombresTira(card), card.quitados.textContent], [['250 g'],
    'Quitaste 250 g: sus 3 productos se costean sin envase y sin aviso al guardar. Quitaste 750 g: se saca de la lista al guardar.']);
  await run('guardarEnvaseFr')(card);
  assert.deepStrictEqual(pedidos[0], ['PUT', 'envase', { pesos: { 250: { sinEnvase: true, oculto: true }, 750: { bolsaPlu: null, bobinaG: null } } }]);
  const $ = $de(srv.repintado());
  assert.deepStrictEqual([$.find('#evTabla tbody tr').toArray().map(t => $.find(t).attr('data-peso')), $.find('#evSinEnvase .ev-sin-item b').text()], [['300', '500', '1000', '1500'], '250 g']);
});

test('abrirProductosPesoFr de un peso con la casilla (sinEnvase visible): "Sin envase: no suma costo ni avisa" y sus productos sin la línea "Usa"', () => {
  const d = dialogo(), { run } = cargar({ document: { getElementById: id => (id === 'dlgEvProductos' ? d : null) } }, { ...CF_PROD, envasePorPeso: { 500: { sinEnvase: true } } });
  run('abrirProductosPesoFr')(500, { focus() {} }); // abierto desde la tabla (sin la marca de la tira)
  const lista = $de(d.querySelector('.ev-prod-cuerpo').innerHTML);
  assert.deepStrictEqual([d.querySelector('.ev-prod-envase').textContent, lista.find('li').length, /Usa:/.test(lista.text())], ['Sin envase: no suma costo ni avisa', 4, false]);
});
