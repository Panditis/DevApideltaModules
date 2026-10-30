'use strict';
// Configuración › Costeo Fraccionado › tarjeta Envase: AGREGAR y QUITAR pesos (public/js/precios_config_envase.js). Puros con require;
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
