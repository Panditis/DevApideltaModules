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
  textoManualesEsq, esManualEsq, leerFilasEsq, leerGeneradorEsq, leerTablaEsq,
  pctDeTextoEsq, mayoristaEfectivoEsq, validarMayoristaEsq, leerMayoristaEsq, htmlMayoristaEsq,
  escalaDefEsq, validarEscalaEsq, escalaQuiebresEsq, leerEscalaEsq, htmlEscalaEsq } = ctx.module.exports;
const plano = x => JSON.parse(JSON.stringify(x)); // objetos del vm → del realm del test (deepStrictEqual compara prototipos)

const GEN = { minPct: 20, maxPct: 50, escalones: 3, rango: { desde: 100, hasta: 10000 } };
const FILAS = [{ hasta: 500, margenPct: 45 }, { hasta: 2000, margenPct: 35 }, { hasta: null, margenPct: 25 }];

// Adaptador DOM mínimo sobre cheerio.
function nodo($, el) {
  return {
    hasAttribute: a => $(el).attr(a) !== undefined,
    querySelector: s => { const x = $(el).find(s).first(); return x.length ? { ...nodo($, x.get(0)), value: x.attr('value') ?? '', checked: x.attr('checked') !== undefined } : null; },
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

// ── Mayorista: descuentos (Fraccionado) ──
test('pctDeTextoEsq: coma o punto; vacío o inválido es null', () => {
  assert.strictEqual(pctDeTextoEsq('10,5'), 10.5);
  assert.strictEqual(pctDeTextoEsq(' 7.25 '), 7.25);
  assert.strictEqual(pctDeTextoEsq('0'), 0);
  for (const x of ['', '  ', 'abc', '-1', '1e2', '1,2,3', null]) assert.strictEqual(pctDeTextoEsq(x), null, String(x));
});
test('mayoristaEfectivoEsq: ausente o incompleto = 10, 10 y piso 2', () => {
  assert.deepStrictEqual(plano(mayoristaEfectivoEsq(undefined)), { descPackPct: 10, descBultoPct: 10, pisoVinculadoPct: 2 });
  assert.deepStrictEqual(plano(mayoristaEfectivoEsq({ descPackPct: 5 })), { descPackPct: 5, descBultoPct: 10, pisoVinculadoPct: 2 });
  assert.strictEqual(mayoristaEfectivoEsq({ pisoVinculadoPct: 0 }).pisoVinculadoPct, 0); // 0 = piso sin colchón, no cae al default
});
test('validarMayoristaEsq: 0 <= x < 100', () => {
  assert.strictEqual(validarMayoristaEsq({ descPackPct: 0, descBultoPct: 99.9, pisoVinculadoPct: 2 }), '');
  assert.match(validarMayoristaEsq({ descPackPct: 100, descBultoPct: 10, pisoVinculadoPct: 2 }), /pack.*menor a 100/);
  assert.match(validarMayoristaEsq({ descPackPct: 10, descBultoPct: null, pisoVinculadoPct: 2 }), /bulto.*número/);
});
test('validarMayoristaEsq: piso de vinculados 0..50 (inclusive), número obligatorio', () => {
  const v = piso => ({ descPackPct: 10, descBultoPct: 10, pisoVinculadoPct: piso });
  for (const ok of [0, 2, 2.5, 50]) assert.strictEqual(validarMayoristaEsq(v(ok)), '', String(ok));
  for (const mal of [-1, 50.1, 100]) assert.match(validarMayoristaEsq(v(mal)), /Piso de vinculados.*entre 0 y 50/, String(mal));
  assert.match(validarMayoristaEsq(v(null)), /Piso de vinculados.*número/);
});
test('tarjeta mayorista: renderiza valores con coma y se lee como números', () => {
  const $ = cheerio.load(htmlMayoristaEsq({ descPackPct: 12.5, descBultoPct: 10 }));
  assert.strictEqual($('#esqMay-descPackPct').attr('value'), '12,5');
  assert.match($('#esqMayAyuda').text(), /Pack = precio por kg minorista sin IVA menos el descuento pack. Bulto = precio pack menos el descuento bulto. Aplica a las presentaciones mayoristas y a los productos pack y bulto vinculados/);
  const card = nodo($, $('[data-mayorista]').get(0));
  assert.strictEqual($('#esqMay-pisoVinculadoPct').attr('value'), '2'); // sin dato en la respuesta: default 2
  assert.match($('#esqMayPisoAyuda').text(), /nunca sale más barato por kg que el pack mayorista más barato del granel más este %\. 0 = igual al pack, sin colchón\./);
  assert.deepStrictEqual(plano(leerMayoristaEsq(card)), { descPackPct: 12.5, descBultoPct: 10, pisoVinculadoPct: 2, escalaPack: null, escalaBulto: null });
  $('#esqMay-descBultoPct').attr('value', 'x');
  assert.deepStrictEqual(plano(leerMayoristaEsq(card)), { descPackPct: 12.5, descBultoPct: null, pisoVinculadoPct: 2, escalaPack: null, escalaBulto: null });
  $('#esqMay-pisoVinculadoPct').attr('value', '3,5');
  assert.strictEqual(leerMayoristaEsq(card).pisoVinculadoPct, 3.5);
  assert.strictEqual(cheerio.load(htmlMayoristaEsq({ pisoVinculadoPct: 0 }))('#esqMay-pisoVinculadoPct').attr('value'), '0');
});

// ── Fraccionado sin tablas pack/bulto; Reventa/Producción con las tres ──
function cargarEsq(tipoGuardado) {
  const c = vm.createContext({ module: { exports: {} }, esc, fmtMoney, numOrNull, campoU, PreciosEsquema,
    sessionStorage: { getItem: () => tipoGuardado, setItem() {} },
    document: { getElementById: () => ({ addEventListener() {}, classList: { toggle() {} } }), querySelectorAll: () => [] } });
  vm.runInContext(fs.readFileSync(RUTA, 'utf8'), c, { filename: RUTA });
  return c.module.exports;
}
const MARGENES = { minorista: { ...GEN }, pack: { ...GEN }, bulto: { ...GEN }, mayorista: { descPackPct: 10, descBultoPct: 10 } };
test('Márgenes de Fraccionado: sólo la tabla de minorista (sin pack ni bulto), con la tarjeta de descuentos y su explicación', () => {
  const E = cargarEsq('fraccionado');
  const $ = cheerio.load(E.htmlMargenesEsq(MARGENES, {}));
  assert.deepStrictEqual($('[data-canal]').toArray().map(e => $(e).attr('data-canal')), ['minorista']);
  assert.doesNotMatch($.text(), /Mayorista pack|Mayorista bulto/);
  assert.strictEqual($('[data-mayorista]').length, 1);
  assert.match($('#esqMayAyuda').text(), /Pack = precio por kg minorista sin IVA menos el descuento pack/);
  assert.strictEqual($('#esqDtoDistrib').length, 0); // el descuento al distribuidor sigue siendo sólo de Reventa
  assert.deepStrictEqual(plano(E.canalesMargenEsq()), ['minorista']);
});
test('Márgenes de Reventa/Producción: siguen las tres tablas (minorista, pack y bulto) y el descuento al distribuidor, sin tarjeta mayorista', () => {
  const E = cargarEsq('almacen');
  const $ = cheerio.load(E.htmlMargenesEsq(MARGENES, { fraccionadoMigrado: true }));
  assert.deepStrictEqual($('[data-canal]').toArray().map(e => $(e).attr('data-canal')), ['minorista', 'pack', 'bulto']);
  assert.strictEqual($('#esqDtoDistrib').length, 1);
  assert.strictEqual($('[data-mayorista]').length, 0);
  assert.deepStrictEqual(plano(E.canalesMargenEsq()), ['minorista', 'pack', 'bulto']);
});
test('validarMargenes(fraccionado): pack y bulto son opcionales (sólo minorista y mayorista no es error)', () => {
  const t = plano(leerTablaEsq(tarjeta(htmlTablaMargenEsq('minorista', { ...GEN, filas: FILAS }, true)).card));
  assert.doesNotThrow(() => validarMargenes({ minorista: t, mayorista: { descPackPct: 10, descBultoPct: 10 } }, {}, 'fraccionado'));
});

// ── Escalas del descuento mayorista por costo (pack y bulto) ──
const ESC = { minPct: 0, maxPct: 20, escalones: 4, rango: { desde: 1000, hasta: 16000 } };
const FILAS_ESC = [{ hasta: 3000, descPct: 2 }, { hasta: 9000, descPct: 6 }, { hasta: null, descPct: 12 }];
const bloqueEsc = (clave, escala, fijo = 10) => { const $ = cheerio.load(htmlEscalaEsq(clave, escala, fijo)); return { $, b: nodo($, $('[data-escala]').get(0)) }; };

test('escalaDefEsq: defaults al prender (0, fijo x2 o 10 si es 0, 5 escalones, 1000..20000)', () => {
  assert.deepStrictEqual(plano(escalaDefEsq(12.5)), { minPct: 0, maxPct: 25, escalones: 5, rango: { desde: 1000, hasta: 20000 } });
  assert.strictEqual(escalaDefEsq(0).maxPct, 10);
  assert.strictEqual(escalaDefEsq(null).maxPct, 10);
  assert.ok(escalaDefEsq(80).maxPct < 100);
});
test('escalaQuiebresEsq: cortes logarítmicos, el tramo barato lleva el mínimo y el caro el máximo; última en adelante', () => {
  const q = plano(escalaQuiebresEsq(ESC));
  assert.deepStrictEqual(q.map(x => x.hasta), [2000, 4000, 8000, null]); // 1000 * 16^(i/4), i = 1..3
  assert.deepStrictEqual(q.map(x => x.descPct), [0, 6.67, 13.33, 20]);
  assert.strictEqual(q[0].descPct, ESC.minPct);
  assert.strictEqual(q[q.length - 1].descPct, ESC.maxPct);
  assert.deepStrictEqual(plano(escalaQuiebresEsq({ ...ESC, escalones: 1 })), [{ hasta: null, descPct: 0 }]);
  assert.deepStrictEqual(plano(escalaQuiebresEsq({ ...ESC, filas: FILAS_ESC })), FILAS_ESC);
});
test('validarEscalaEsq: pct 0..<100, mín<=máx, escalones 1..30, rango y filas, con el rótulo en el mensaje', () => {
  const v = (x, r = 'Escala del pack') => validarEscalaEsq({ ...ESC, ...x }, r);
  assert.strictEqual(v({}), '');
  assert.strictEqual(v({ minPct: 0, maxPct: 99.9 }), '');
  for (const mal of [{ minPct: -1 }, { maxPct: 100 }, { minPct: null }, { maxPct: null }]) assert.match(v(mal), /^Escala del pack: .*menores a 100/, JSON.stringify(mal));
  assert.match(v({ minPct: 30 }), /^Escala del pack: el descuento mínimo no puede superar/);
  for (const mal of [0, 31, 2.5, null]) assert.match(v({ escalones: mal }), /escalones deben ser un entero entre 1 y 30/, String(mal));
  assert.match(v({ rango: { desde: 0, hasta: 10 } }), /desde mayor a 0/);
  assert.match(v({ rango: { desde: 100, hasta: 100 } }), /hasta mayor que desde/);
  assert.match(v({ rango: { desde: null, hasta: 100 } }), /desde mayor a 0/);
  assert.match(v({ filas: [] }), /entre 1 y 30 filas/);
  assert.match(v({ filas: [{ hasta: 5, descPct: 1 }, { hasta: 5, descPct: 2 }, { hasta: null, descPct: 3 }] }), /fila 2: el corte debe ser mayor al de la fila anterior/);
  assert.match(v({ filas: [{ hasta: 5, descPct: 1 }, { hasta: 9, descPct: 2 }] }), /fila 2: la última fila no lleva corte/);
  assert.match(v({ filas: [{ hasta: null, descPct: 100 }] }), /fila 1: el descuento debe ser mayor o igual a 0 y menor a 100/);
  assert.match(v({ filas: [{ hasta: null, descPct: null }] }), /fila 1: el descuento/);
  assert.match(v({ filas: [{ hasta: null, descPct: 1 }, { hasta: null, descPct: 1 }] }, 'Escala del bulto'), /^Escala del bulto, fila 1: el corte debe ser un número mayor a 0/);
  assert.strictEqual(v({ filas: FILAS_ESC }), '');
  assert.match(validarMayoristaEsq({ descPackPct: 10, descBultoPct: 10, pisoVinculadoPct: 2, escalaPack: null, escalaBulto: { ...ESC, minPct: 50 } }), /^Escala del bulto: el descuento mínimo no puede superar/);
  assert.match(validarMayoristaEsq({ descPackPct: 200, descBultoPct: 10, pisoVinculadoPct: 2, escalaPack: { ...ESC, minPct: 50 } }), /^Descuento precio pack/); // primero los fijos
});
test('htmlEscalaEsq sin escala: check apagado, cuerpo oculto, defaults según el % fijo y filas del generador', () => {
  const { $, b } = bloqueEsc('escalaPack', undefined, 12);
  assert.strictEqual($('[data-escala-on]').attr('checked'), undefined);
  assert.notStrictEqual($('.esq-esc-cuerpo').attr('hidden'), undefined);
  assert.strictEqual($('[data-escala]').attr('data-manual'), undefined);
  assert.strictEqual($('[data-e="maxPct"]').attr('value'), '24');
  assert.strictEqual($('[data-e="escalones"]').attr('value'), '5');
  assert.strictEqual($('[data-e="desde"]').attr('value'), '1000');
  assert.strictEqual($('.esq-esc-fila').length, 5);
  assert.match($('label').first().text(), /Escala del descuento del pack por costo/);
  assert.match($('.cfg-ayuda').text(), /Más caro el producto, más descuento\. El costo es el costo por kg de la presentación\./);
  assert.strictEqual(leerEscalaEsq(b), null);
});
test('htmlEscalaEsq con escala: check prendido, valores con coma, filas del generador; con filas guardadas = manual con aviso', () => {
  const auto = bloqueEsc('escalaBulto', { ...ESC, maxPct: 12.5 });
  assert.strictEqual(auto.$('[data-escala-on]').attr('checked'), 'checked');
  assert.strictEqual(auto.$('.esq-esc-cuerpo').attr('hidden'), undefined);
  assert.strictEqual(auto.$('[data-e="maxPct"]').attr('value'), '12,5');
  assert.strictEqual(auto.$('.esq-esc-fila').length, 4);
  assert.strictEqual(auto.$('[data-escala]').attr('data-manual'), undefined);
  assert.strictEqual(auto.$('.esq-esc-fila').last().find('[data-f="hasta"]').length, 0);
  assert.deepStrictEqual(plano(leerEscalaEsq(auto.b)), { minPct: 0, maxPct: 12.5, escalones: 4, rango: { desde: 1000, hasta: 16000 } }); // automática: sin filas
  const man = bloqueEsc('escalaBulto', { ...ESC, filas: FILAS_ESC });
  assert.strictEqual(man.$('[data-escala]').attr('data-manual'), '');
  assert.match(man.$('.esq-esc-aviso').text(), /Tabla manual: estos valores no cambian las filas\. Generar las reemplaza\./);
  assert.strictEqual(man.$('.esq-esc-fila').length, 3);
  assert.deepStrictEqual(plano(leerEscalaEsq(man.b)).filas, FILAS_ESC);
});
test('leerEscalaEsq manual: filas ordenadas por corte, con coma, y lo inválido queda null', () => {
  const { $, b } = bloqueEsc('escalaPack', { ...ESC, filas: FILAS_ESC });
  tipear($, '[data-f="hasta"]', 0, '9500'); tipear($, '[data-f="hasta"]', 1, '3000'); tipear($, '[data-f="descPct"]', 2, '12,5');
  const f = plano(leerEscalaEsq(b)).filas;
  assert.deepStrictEqual(f.map(x => x.hasta), [3000, 9500, null]);
  assert.strictEqual(f[2].descPct, 12.5);
  tipear($, '[data-f="descPct"]', 0, 'x');
  assert.ok(plano(leerEscalaEsq(b)).filas.some(x => x.descPct == null)); // la validación lo rechaza
});
test('tarjeta mayorista con escalas: payload manda SIEMPRE las dos claves (null con check apagado, objeto con check prendido)', () => {
  const $ = cheerio.load(htmlMayoristaEsq({ descPackPct: 10, descBultoPct: 8, escalaPack: ESC }));
  const card = nodo($, $('[data-mayorista]').get(0));
  const r = plano(leerMayoristaEsq(card));
  assert.deepStrictEqual(Object.keys(r).sort(), ['descBultoPct', 'descPackPct', 'escalaBulto', 'escalaPack', 'pisoVinculadoPct']);
  assert.deepStrictEqual(r.escalaPack, ESC);
  assert.strictEqual(r.escalaBulto, null);
  assert.strictEqual(r.descPackPct, 10); // el fijo se sigue guardando con la escala prendida
  assert.strictEqual(validarMayoristaEsq(r), '');
  $('[data-escala="escalaPack"] [data-escala-on]').removeAttr('checked');
  assert.strictEqual(leerMayoristaEsq(card).escalaPack, null);
});
test('tarjeta mayorista: nota "se usa solo si no hay escala" visible sólo con la escala del campo fijo prendida', () => {
  const $ = cheerio.load(htmlMayoristaEsq({ descPackPct: 10, descBultoPct: 8, escalaBulto: ESC }));
  assert.notStrictEqual($('[data-nota-fijo="descPackPct"]').attr('hidden'), undefined);
  assert.strictEqual($('[data-nota-fijo="descBultoPct"]').attr('hidden'), undefined);
  assert.match($('[data-nota-fijo="descBultoPct"]').text(), /Se usa solo si no hay escala\./);
  assert.strictEqual($('[data-nota-fijo="pisoVinculadoPct"]').length, 0);
  assert.strictEqual($('[data-escala]').length, 2);
});
test('filasConNuevaEsq con columna descPct hereda el descuento de la última fila', () => {
  assert.deepStrictEqual(plano(filasConNuevaEsq(FILAS_ESC, 'descPct')), [FILAS_ESC[0], FILAS_ESC[1], { hasta: null, descPct: 12 }, FILAS_ESC[2]]);
  assert.deepStrictEqual(plano(filasConNuevaEsq(FILAS)), [FILAS[0], FILAS[1], { hasta: null, margenPct: 25 }, FILAS[2]]);
});
