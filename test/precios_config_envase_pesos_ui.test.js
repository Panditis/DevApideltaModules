'use strict';
// Configuración › Costeo Fraccionado › tarjeta Envase: AGREGAR y QUITAR pesos y el modal con los productos de cada peso (public/js/precios_config_envase.js). Puros con require;
// HTML con cheerio; el DOM (agregar / quitar / vaciar / guardar) con los scripts cargados en un vm y una tarjeta de mentira.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cheerio = require('cheerio');

const RUTA_CFG = path.join(__dirname, '../public/js/precios_config_fraccionado.js');
const RUTA = path.join(__dirname, '../public/js/precios_config_envase.js');
const { errorPesoNuevoFr, errorNuevoSinEnvaseFr, erroresEnvaseFr, pesosQuitadosFr, textoQuitadosFr } = require(RUTA);

// ── Puros ──
test('errorPesoNuevoFr: obligatorio, gramos enteros de 1 a 999999 y que no esté en la lista', () => {
  const ya = new Set([250, 500]);
  assert.strictEqual(errorPesoNuevoFr('750', ya), null);
  assert.strictEqual(errorPesoNuevoFr(' 999999 ', ya), null);
  assert.deepStrictEqual(errorPesoNuevoFr('  ', ya), { campo: 'pesoG', mensaje: 'Escribí el peso, en gramos' });
  for (const malo of ['0', '1000000', '12.5', '-3', 'x']) assert.deepStrictEqual(errorPesoNuevoFr(malo, ya), { campo: 'pesoG', mensaje: 'Gramos enteros, de 1 a 999999' }, malo);
  assert.deepStrictEqual(errorPesoNuevoFr('250', ya), { campo: 'pesoG', mensaje: 'Ese peso ya está en la lista' });
});

test('errorNuevoSinEnvaseFr: la fila nueva necesita bolsa o bobina; marca el PLU', () => {
  assert.deepStrictEqual(errorNuevoSinEnvaseFr({ plu: ' ', g: '' }), { campo: 'bolsaPlu', mensaje: 'Cargá la bolsa o la bobina de este peso, o quitá la fila' });
  assert.strictEqual(errorNuevoSinEnvaseFr({ plu: '900', g: '' }), null);
  assert.strictEqual(errorNuevoSinEnvaseFr({ plu: '', g: '8' }), null);
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

test('pesosQuitadosFr: los guardados sin fila, ascendente; la fila nueva con ese peso lo vuelve reemplazo', () => {
  const epp = { 1500: { bobinaG: 10 }, 300: { bobinaG: 5 }, 250: { bolsaPlu: '9' } };
  assert.deepStrictEqual(pesosQuitadosFr([{ pesoG: 250 }], epp), [300, 1500]);
  assert.deepStrictEqual(pesosQuitadosFr([{ pesoG: 250 }, { nuevo: 'n1', pesoG: '300' }], epp), [1500]);
  assert.deepStrictEqual(pesosQuitadosFr([], undefined), []);
});

test('textoQuitadosFr: nada, 1, 2 y 3+ pesos con ListFormat es', () => {
  assert.strictEqual(textoQuitadosFr([]), '');
  assert.strictEqual(textoQuitadosFr([300]), 'Quitaste 300 g: se saca de la lista al guardar.');
  assert.strictEqual(textoQuitadosFr([300, 2000]), 'Quitaste 300 g y 2 kg: se sacan de la lista al guardar.');
  assert.strictEqual(textoQuitadosFr([300, 750, 1500]), 'Quitaste 300 g, 750 g y 1500 g: se sacan de la lista al guardar.');
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

test('htmlPesosFr: botón por fila (Vaciar con productos, ✕ sin), th con scope, aria-label con el peso, sin HTML inyectado', () => {
  const $ = $de(cargar().run('htmlPesosFr()'));
  const acc = p => $.find(`tr[data-peso="${p}"] .ev-acc button`);
  assert.deepStrictEqual([acc(250).text(), acc(250).attr('disabled'), acc(1000).text(), acc(1000).attr('disabled'), acc(300).text(), acc(1500).hasClass('ev-quitar')],
    ['Vaciar', undefined, 'Vaciar', 'disabled', '✕', true]);
  assert.strictEqual(acc(250).attr('aria-label'), 'Vaciar el envase del peso 250 g');
  assert.match(acc(250).attr('title'), /sale de 3 productos: no se puede sacar/);
  assert.strictEqual(acc(1500).attr('aria-label'), 'Quitar el peso 1500 g');
  $.find('th').each((_, th) => assert.ok($.find(th).attr('scope'), 'th sin scope'));
  assert.strictEqual($.find('.ev-agregar').text(), '+ Agregar peso');
  assert.match($.find('#evQuitados').attr('role'), /status/);
  assert.strictEqual($.find('#evTabla b b').length, 0); // nombre de bolsa escapado
});

test('htmlTablaPesosFr vacía: tabla con tbody vacío y texto de vacío; htmlPesosFr igual trae "+ Agregar peso"', () => {
  const { run } = cargar({}, { ...CFG, pesos: [], envasePorPeso: {} });
  const $ = $de(run('htmlPesosFr()'));
  assert.deepStrictEqual([$.find('#evTabla').length, $.find('#evTabla tbody').html(), $.find('.ev-agregar').length], [1, '', 1]);
  assert.match($.find('p.fr-vacio').text(), /Todavía no hay pesos/);
});

test('htmlFilaPesoFr de fila nueva: input de peso con aria-label, chip nuevo, data-nuevo y ✕ "Quitar la fila nueva"', () => {
  const $ = $de(`<table><tbody>${cargar().run("htmlFilaPesoFr({ nuevo: 'n7', presentaciones: 0 })")}</tbody></table>`);
  const tr = $.find('tr[data-nuevo="n7"]');
  assert.strictEqual(tr.find('[data-k="pesoG"]').attr('aria-label'), 'Peso en gramos de la fila nueva');
  assert.strictEqual(tr.find('[data-k="pesoG"]').attr('aria-describedby'), 'evErrPeso-n7');
  assert.deepStrictEqual([tr.find('.ev-chip-nuevo').text(), tr.find('.ev-quitar').attr('aria-label'), tr.attr('data-peso')], ['nuevo', 'Quitar la fila nueva', undefined]);
  assert.match(tr.find('.ev-buscar').attr('aria-label'), /la fila nueva/);
});

// Tarjeta de mentira con filas reales y nuevas: [peso, plu, g] o { nuevo, pesoG, plu, g }. Los inputs avisan input a card.oninput.
const enFoco = { el: null };
function tarjeta(costo, filas) {
  const card = {};
  const campo = (value, k, tr) => {
    const err = { textContent: '', hidden: true };
    return { value, validity: {}, attrs: {}, err, id: '', setAttribute(a, v) { this.attrs[a] = v; }, removeAttribute(a) { delete this.attrs[a]; },
      focus() { enFoco.el = this; }, matches: s => s === 'input[data-k]' || s === `[data-k="${k}"]`,
      closest: s => (s === 'tr' ? tr : { querySelector: () => err }), dispatchEvent(e) { if (card.oninput && e.type === 'input') card.oninput({ target: this }); } };
  };
  const fila = d => {
    const tr = { dataset: {}, celdas: { '.ev-nota': { innerHTML: '' }, '.ev-bob': { innerHTML: '' } } };
    const [peso, plu, g] = Array.isArray(d) ? d : [null, d.plu, d.g];
    tr.inputs = { bolsaPlu: campo(plu, 'bolsaPlu', tr), bobinaG: campo(g, 'bobinaG', tr) };
    if (Array.isArray(d)) tr.dataset.peso = String(peso); else { tr.dataset.nuevo = d.nuevo; tr.inputs.pesoG = campo(d.pesoG, 'pesoG', tr); }
    tr.boton = { disabled: false, focus() { enFoco.el = this; } };
    tr.querySelector = s => {
      const k = (s.match(/data-k="(\w+)"/) || [])[1];
      if (k) return tr.inputs[k] || null;
      if (s === '.ev-vaciar') return tr.vaciar || null;
      if (s === '.ev-acc button:not(:disabled)') return tr.boton.disabled ? null : tr.boton;
      return tr.celdas[s];
    };
    Object.defineProperty(tr, 'nextElementSibling', { get: () => card.trs[card.trs.indexOf(tr) + 1] || null });
    Object.defineProperty(tr, 'previousElementSibling', { get: () => card.trs[card.trs.indexOf(tr) - 1] || null });
    tr.remove = () => card.trs.splice(card.trs.indexOf(tr), 1);
    return tr;
  };
  const todos = () => [card.costoI, ...card.trs.flatMap(t => Object.values(t.inputs))];
  const msg = {}, quitados = { textContent: '' }, agregar = { focus() { enFoco.el = this; } };
  const cuerpo = { insertAdjacentHTML(_p, html) { const id = html.match(/data-nuevo="(\w+)"/)[1]; card.html.push(html); card.trs.push(fila({ nuevo: id, pesoG: '', plu: '', g: '' })); },
    get lastElementChild() { return card.trs.at(-1); } };
  Object.assign(card, { html: [], trs: [], costoI: campo(costo, 'costoBobinaKg', null), quitados, agregar,
    querySelector: s => {
      const m = s.match(/^tr\[data-(peso|nuevo)="(\w+)"\] \[data-k="(\w+)"\]$/);
      if (m) return card.trs.find(t => t.dataset[m[1]] === m[2]).inputs[m[3]];
      return { '#frBobinaKg': card.costoI, '.esq-msg': msg, '.fr-guardar': {}, '#evQuitados': quitados, '.ev-agregar': agregar, '#evTabla tbody': cuerpo }[s] || null;
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
  const { run } = cargar({}, { ...CFG, envasePorPeso: { 250: { bolsaPlu: '900' }, 300: { bobinaG: 5 } } });
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

test('vaciarPesoFr: limpia bolsa y bobina, avisa input (Vaciar se deshabilita) y deja el foco en el PLU', () => {
  const { run } = cargar({ document: { getElementById: () => ({ value: '6000' }) } });
  const card = tarjeta('6000', FILAS);
  const tr = card.trs[0];
  tr.vaciar = { disabled: false };
  run('conectarPesosFr')(card);
  run('vaciarPesoFr')(tr);
  assert.deepStrictEqual([tr.inputs.bolsaPlu.value, tr.inputs.bobinaG.value, tr.vaciar.disabled, enFoco.el === tr.inputs.bolsaPlu], ['', '', true, true]);
  tr.inputs.bobinaG.value = '3';
  tr.inputs.bobinaG.dispatchEvent({ type: 'input' });
  assert.strictEqual(tr.vaciar.disabled, false);
  tr.inputs.bobinaG.value = ''; tr.inputs.bobinaG.validity = { badInput: true }; // texto roto: hay algo que vaciar
  tr.inputs.bobinaG.dispatchEvent({ type: 'input' });
  assert.strictEqual(tr.vaciar.disabled, false);
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
