'use strict';
// Configuración › Márgenes (public/js/precios_config_esquema.js): tabla manual de Fraccionado (corte y margen por fila, agregar/quitar,
// "en adelante" al final). El script se carga en un vm con document/sessionStorage de mentira; el HTML se mira con cheerio y las
// tarjetas se leen con un adaptador chico sobre cheerio (hasAttribute/querySelector/querySelectorAll: lo único que usan los lectores).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cheerio = require('cheerio');
const PreciosEsquema = require('../lib/precios_esquema');
const { validarMargenes } = require('../lib/precios_config_esquema');

const RUTA = path.join(__dirname, '../public/js/precios_config_esquema.js');
// Copias de public/js/precios_comun.js y public/js/precios_config.js.
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtMoney = n => n == null ? '—' : new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const numOrNull = v => { const s = String(v ?? '').trim(); if (s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
const campoU = (input, u, { pre = false, w = 'w-28' } = {}) =>
  `<span class="campo-u ${w}">${pre ? `<span class="u pre" aria-hidden="true">${u}</span>` : ''}${input}${pre ? '' : `<span class="u" aria-hidden="true">${u}</span>`}</span>`;

const ctx = vm.createContext({ module: { exports: {} }, esc, fmtMoney, numOrNull, campoU, PreciosEsquema,
  sessionStorage: { getItem: () => null, setItem() {} },
  document: { getElementById: () => ({ addEventListener() {}, classList: { toggle() {} } }), querySelectorAll: () => [] } });
vm.runInContext(fs.readFileSync(RUTA, 'utf8'), ctx, { filename: RUTA });
const { htmlTablaMargenEsq, htmlFilaMargenEsq, htmlFilasMargenEsq, filasDeTablaEsq, filasConNuevaEsq, filasSinEsq, ordenarFilasEsq,
  textoManualesEsq, esManualEsq, leerFilasEsq, leerGeneradorEsq, leerTablaEsq } = ctx.module.exports;
const plano = x => JSON.parse(JSON.stringify(x)); // objetos del vm → del realm del test (deepStrictEqual compara prototipos)

const GEN = { minPct: 20, maxPct: 50, escalones: 3, rango: { desde: 100, hasta: 10000 } };
const FILAS = [{ hasta: 500, margenPct: 45 }, { hasta: 2000, margenPct: 35 }, { hasta: null, margenPct: 25 }];

// Adaptador DOM mínimo sobre cheerio.
function nodo($, el) {
  return {
    hasAttribute: a => $(el).attr(a) !== undefined,
    querySelector: s => { const x = $(el).find(s).first(); return x.length ? { value: x.attr('value') ?? '' } : null; },
    querySelectorAll: s => $(el).find(s).toArray().map(e => nodo($, e)),
  };
}
const tarjeta = html => { const $ = cheerio.load(html); return { $, card: nodo($, $('[data-canal]').get(0)) }; };
// Cambia el value de un input de la tarjeta (como si el usuario lo hubiera escrito).
const tipear = ($, sel, i, v) => $($(sel).get(i)).attr('value', v);

// ── HTML ──
test('tarjeta editable sin filas: filas del motor, sin chip ni data-manual ni aviso; última "en adelante" sin input de corte', () => {
  const { $ } = tarjeta(htmlTablaMargenEsq('minorista', GEN, true));
  const qs = PreciosEsquema.quiebres(GEN);
  assert.strictEqual($('.esq-fila').length, qs.length);
  assert.strictEqual($('[data-manual]').length, 0);
  assert.strictEqual($('.esq-chip-manual').text(), '');
  assert.strictEqual($('.esq-aviso-manual').text(), '');
  assert.deepStrictEqual($('[data-f="margenPct"]').toArray().map(e => Number($(e).attr('value'))), qs.map(q => q.margenPct));
  assert.deepStrictEqual($('[data-f="hasta"]').toArray().map(e => Number($(e).attr('value'))), qs.slice(0, -1).map(q => q.hasta));
  const ultima = $('.esq-fila').last();
  assert.strictEqual(ultima.find('[data-f="hasta"]').length, 0);
  assert.match(ultima.text(), /en adelante/);
  assert.strictEqual($('.esq-quiebres').length, 0);
  for (const c of ['.esq-agregar-fila', '.esq-generar', '.esq-error', '[data-k="maxPct"]', '[data-k="desde"]']) assert.strictEqual($(c).length, 1, c);
});

test('tarjeta editable con filas: chip "Tabla manual", data-manual, aviso y las filas guardadas tal cual', () => {
  const { $ } = tarjeta(htmlTablaMargenEsq('pack', { ...GEN, filas: FILAS }, true));
  assert.strictEqual($('[data-canal="pack"][data-manual]').length, 1);
  assert.match($('.esq-chip-manual').text(), /Tabla manual/);
  assert.match($('.esq-aviso-manual').text(), /Generar las reemplaza/);
  assert.deepStrictEqual($('[data-f="hasta"]').toArray().map(e => $(e).attr('value')), ['500', '2000']);
  assert.deepStrictEqual($('[data-f="margenPct"]').toArray().map(e => $(e).attr('value')), ['45', '35', '25']);
  assert.match($('[data-f="hasta"]').first().attr('aria-label'), /Mayorista pack, fila 1/);
});

test('htmlTablaMargenEsq sin editable (Reventa/Producción): generador + grilla .esq-quiebres, sin filas ni chip aunque venga filas', () => {
  for (const t of [GEN, { ...GEN, filas: FILAS }]) {
    const { $ } = tarjeta(htmlTablaMargenEsq('bulto', t));
    assert.strictEqual($('.esq-quiebres').length, 1);
    for (const c of ['.esq-fila', '.esq-chip-manual', '[data-manual]', '.esq-agregar-fila', '.esq-generar', '[data-f]']) assert.strictEqual($(c).length, 0, c);
    assert.strictEqual($('[data-k]').length, 5);
  }
});

test('htmlTablaMargenEsq: sinConfigurar y rangoEstimado siguen con su chip y data-rango-estimado', () => {
  const { $ } = tarjeta(htmlTablaMargenEsq('minorista', { ...GEN, sinConfigurar: true, rangoEstimado: true }, true));
  assert.strictEqual($('[data-rango-estimado]').length, 1);
  assert.match($('h4').text(), /sin configurar/);
  assert.match($('h4').text(), /rango estimado/);
});

test('htmlFilaMargenEsq: única fila sin corte y con Quitar deshabilitado; escapa valores', () => {
  const $ = cheerio.load(`<table>${htmlFilaMargenEsq({ hasta: null, margenPct: 30 }, 0, 1, 'minorista')}</table>`);
  assert.strictEqual($('[data-f="hasta"]').length, 0);
  assert.strictEqual($('.esq-quitar-fila').attr('disabled'), 'disabled');
  const $2 = cheerio.load(`<table>${htmlFilaMargenEsq({ hasta: '"><x>', margenPct: null }, 0, 2, 'minorista')}</table>`);
  assert.strictEqual($2('x').length, 0);
  assert.strictEqual($2('[data-f="margenPct"]').attr('value'), '');
  assert.strictEqual($2('.esq-quitar-fila').attr('disabled'), undefined);
  assert.strictEqual(cheerio.load(`<table>${htmlFilasMargenEsq('pack', FILAS)}</table>`)('.esq-fila').length, 3);
});

// ── Puros ──
test('filasDeTablaEsq: filas guardadas; sin filas, las del motor; generador inválido → una fila vacía "en adelante"', () => {
  assert.deepStrictEqual(plano(filasDeTablaEsq({ ...GEN, filas: FILAS })), FILAS);
  assert.deepStrictEqual(plano(filasDeTablaEsq(GEN)), plano(PreciosEsquema.quiebres(GEN)));
  assert.deepStrictEqual(plano(filasDeTablaEsq({ ...GEN, minPct: 90 })), [{ hasta: null, margenPct: null }]);
  assert.deepStrictEqual(plano(filasDeTablaEsq({})), [{ hasta: null, margenPct: null }]);
});

test('filasConNuevaEsq: agrega antes de la última, con su margen y corte vacío; no muta', () => {
  const orig = plano(FILAS);
  assert.deepStrictEqual(plano(filasConNuevaEsq(FILAS)), [FILAS[0], FILAS[1], { hasta: null, margenPct: 25 }, FILAS[2]]);
  assert.deepStrictEqual(plano(filasConNuevaEsq([{ hasta: null, margenPct: 30 }])), [{ hasta: null, margenPct: 30 }, { hasta: null, margenPct: 30 }]);
  assert.deepStrictEqual(FILAS, orig);
});

test('filasSinEsq: no quita la única; quitar la última pasa la anterior a "en adelante"; quitar una del medio', () => {
  const una = [{ hasta: null, margenPct: 30 }];
  assert.strictEqual(filasSinEsq(una, 0), una);
  assert.deepStrictEqual(plano(filasSinEsq(FILAS, 2)), [FILAS[0], { hasta: null, margenPct: 35 }]);
  assert.deepStrictEqual(plano(filasSinEsq(FILAS, 1)), [FILAS[0], FILAS[2]]);
  assert.deepStrictEqual(plano(filasSinEsq(FILAS, 0)), [FILAS[1], FILAS[2]]);
  assert.strictEqual(FILAS[1].hasta, 2000);
});

test('ordenarFilasEsq: ascendente por corte, los vacíos al final de los que tienen corte, la última fija; no muta', () => {
  const f = [{ hasta: 2000, margenPct: 1 }, { hasta: null, margenPct: 2 }, { hasta: 500, margenPct: 3 }, { hasta: 10, margenPct: 4 }];
  assert.deepStrictEqual(plano(ordenarFilasEsq(f)).map(x => x.margenPct), [3, 1, 2, 4]);
  assert.strictEqual(f[0].hasta, 2000);
  assert.deepStrictEqual(plano(ordenarFilasEsq([{ hasta: null, margenPct: 9 }])), [{ hasta: null, margenPct: 9 }]);
});

test('textoManualesEsq: vacío sin manuales; con nombres, los lista', () => {
  assert.strictEqual(textoManualesEsq([]), '');
  assert.match(textoManualesEsq(['Minorista', 'Mayorista pack']), /Tabla manual en Minorista, Mayorista pack/);
});

// ── Lectores de tarjeta ──
test('leerTablaEsq automática: body como hoy (minPct, maxPct, escalones, rango, rangoEstimado), sin filas', () => {
  const { card } = tarjeta(htmlTablaMargenEsq('minorista', { ...GEN, rangoEstimado: true }, true));
  assert.strictEqual(esManualEsq(card), false);
  assert.deepStrictEqual(plano(leerTablaEsq(card)), { ...GEN, rangoEstimado: true });
  assert.deepStrictEqual(plano(leerGeneradorEsq(card)), { ...GEN, rangoEstimado: true });
  const { card: reventa } = tarjeta(htmlTablaMargenEsq('minorista', { ...GEN, filas: FILAS }));
  assert.deepStrictEqual(plano(leerTablaEsq(reventa)), GEN);
});

test('leerTablaEsq manual: manda filas ordenadas por corte, última hasta null; vacío o texto → null', () => {
  const { $, card } = tarjeta(htmlTablaMargenEsq('minorista', { ...GEN, filas: FILAS }, true));
  assert.strictEqual(esManualEsq(card), true);
  tipear($, '[data-f="hasta"]', 0, '3000');
  assert.deepStrictEqual(plano(leerTablaEsq(card)), { ...GEN, filas: [{ hasta: 2000, margenPct: 35 }, { hasta: 3000, margenPct: 45 }, { hasta: null, margenPct: 25 }] });
  tipear($, '[data-f="hasta"]', 0, '');
  tipear($, '[data-f="margenPct"]', 1, 'x');
  assert.deepStrictEqual(plano(leerFilasEsq(card)), [{ hasta: null, margenPct: 45 }, { hasta: 2000, margenPct: null }, { hasta: null, margenPct: 25 }]);
});

// ── Integración front → validadores reales ──
test('lo que arma leerTablaEsq de una tarjeta manual pasa validarTablaMargen y validarMargenes(…, fraccionado)', () => {
  const body = Object.fromEntries(['minorista', 'pack', 'bulto'].map(c => [c, plano(leerTablaEsq(tarjeta(htmlTablaMargenEsq(c, { ...GEN, filas: FILAS }, true)).card))]));
  assert.strictEqual(PreciosEsquema.validarTablaMargen(body.minorista), null);
  const r = validarMargenes(body, {}, 'fraccionado');
  assert.deepStrictEqual(r.pack.filas, FILAS);
  // Automática: sin filas, también válida.
  const auto = plano(leerTablaEsq(tarjeta(htmlTablaMargenEsq('minorista', GEN, true)).card));
  assert.strictEqual(validarMargenes({ ...body, minorista: auto }, {}, 'fraccionado').minorista.filas, undefined);
});

test('fila inválida leída de la tarjeta: validarTablaMargen da el error y validarMargenes tira con canal y fila', () => {
  const { $, card } = tarjeta(htmlTablaMargenEsq('bulto', { ...GEN, filas: FILAS }, true));
  tipear($, '[data-f="margenPct"]', 1, '');
  const t = plano(leerTablaEsq(card));
  assert.match(PreciosEsquema.validarTablaMargen(t), /Fila 2/);
  const ok = { ...GEN, filas: FILAS };
  assert.throws(() => validarMargenes({ minorista: ok, pack: ok, bulto: t }, {}, 'fraccionado'), /bulto: .*Fila 2/);
});
