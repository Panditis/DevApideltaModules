'use strict';
// UI de Configuración › Costeo Fraccionado (public/js/precios_config_fraccionado.js): las funciones puras y el HTML de las tarjetas,
// con el script cargado como en el navegador (clásico, comparte globales) y las tarjetas leídas con cheerio.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cheerio = require('cheerio');

const RUTA = path.join(__dirname, '../public/js/precios_config_fraccionado.js');
const { conTramoFr, indiceBaseFr, errorTramosFr, subrubrosSinMinKgFr, cambiosSubrubrosFr, errorSubrubrosFr, cuentaProductosFr, textoUsosFr,
  coincideFr, subrubrosListaFr, conInsumosFr, errorInsumosFr, costoUnidadFr, filasPesosFr, textoPesoFr, pesoCortoFr, estadoPesosFr,
  estadoConfigFr, textoAjustesPesoFr, textoTramosTiempoFr } = require(RUTA);

// ── Puros ──
test('conTramoFr: 250 g el primero, después el doble del último, sin ajuste cargado; no muta', () => {
  assert.deepStrictEqual(conTramoFr([]), [{ hastaG: 250, minKg: null }]);
  const ts = [{ hastaG: 300, minKg: 1 }];
  assert.deepStrictEqual(conTramoFr(ts)[1], { hastaG: 600, minKg: null });
  assert.strictEqual(ts.length, 1);
});

test('indiceBaseFr: la base es el primer tramo que cubre 1 kg; si ninguno llega, el último; sin tramos, -1', () => {
  assert.strictEqual(indiceBaseFr([250, 500, 1000, 2000]), 2);
  assert.strictEqual(indiceBaseFr([250, 500, 1500]), 2);
  assert.strictEqual(indiceBaseFr([999, 1000]), 1);
  assert.strictEqual(indiceBaseFr([1000]), 0);
  assert.strictEqual(indiceBaseFr([100, 500]), 1);
  assert.strictEqual(indiceBaseFr([]), -1);
});

test('errorTramosFr: tabla vacía y tablas bien armadas no dan error', () => {
  assert.strictEqual(errorTramosFr([]), null);
  assert.strictEqual(errorTramosFr([{ hastaG: 250, minKg: 3 }, { hastaG: 500, minKg: -2.5 }, { hastaG: 1000, minKg: 0 }, { hastaG: 2000, minKg: -600 }]), null);
  assert.strictEqual(errorTramosFr([{ hastaG: 100, minKg: 600 }, { hastaG: 500, minKg: 0 }]), null); // ninguno llega a 1 kg: la base es el último
});

test('errorTramosFr: "hasta" entero y ascendente; avisa en qué fila y campo', () => {
  const e = errorTramosFr([{ hastaG: 250, minKg: 1 }, { hastaG: 250, minKg: 2 }, { hastaG: 1000, minKg: 0 }]);
  assert.deepStrictEqual([e.fila, e.campo], [1, 'hastaG']);
  assert.match(e.mensaje, /Tramo 2/);
  assert.deepStrictEqual(errorTramosFr([{ hastaG: 500.5, minKg: 1 }]).campo, 'hastaG');
  assert.deepStrictEqual(errorTramosFr([{ hastaG: null, minKg: 1 }]).campo, 'hastaG');
  assert.deepStrictEqual(errorTramosFr([{ hastaG: 0, minKg: 0 }]).campo, 'hastaG');
  assert.deepStrictEqual(errorTramosFr([{ hastaG: 500, minKg: 1 }, { hastaG: 400, minKg: 0 }]).fila, 1);
});

test('errorTramosFr: el ajuste es un número de -600 a 600 (el vacío no vale)', () => {
  assert.deepStrictEqual(errorTramosFr([{ hastaG: 250, minKg: 601 }, { hastaG: 1000, minKg: 0 }]), { fila: 0, campo: 'minKg', mensaje: errorTramosFr([{ hastaG: 250, minKg: 601 }]).mensaje });
  assert.strictEqual(errorTramosFr([{ hastaG: 250, minKg: -601 }]).campo, 'minKg');
  assert.strictEqual(errorTramosFr([{ hastaG: 250, minKg: null }, { hastaG: 1000, minKg: 0 }]).campo, 'minKg');
  assert.strictEqual(errorTramosFr([{ hastaG: 250, minKg: NaN }]).campo, 'minKg');
});

test('errorTramosFr: el tramo de 1 kg es la base y tiene que valer 0; máximo 20 tramos', () => {
  const base = errorTramosFr([{ hastaG: 500, minKg: 1 }, { hastaG: 1200, minKg: 2 }]);
  assert.deepStrictEqual([base.fila, base.campo], [1, 'minKg']);
  assert.match(base.mensaje, /base/);
  assert.match(base.mensaje, /1200/);
  const veintiuno = Array.from({ length: 21 }, (_, i) => ({ hastaG: (i + 1) * 10, minKg: 0 }));
  assert.strictEqual(errorTramosFr(veintiuno.slice(0, 20)), null);
  assert.match(errorTramosFr(veintiuno).mensaje, /20/);
});

test('subrubrosSinMinKgFr: los de la lista que no tienen min/kg guardado (0 cuenta como valor)', () => {
  const lista = [{ id: '1' }, { id: '2' }, { id: '3' }];
  assert.deepStrictEqual(subrubrosSinMinKgFr(lista, { 1: { minKg: 8 }, 2: { minKg: 0 } }).map(s => s.id), ['3']);
  assert.strictEqual(subrubrosSinMinKgFr(lista, undefined).length, 3);
});

test('cambiosSubrubrosFr: sólo lo que cambió; vaciar un subrubro con valor manda null; un vacío sin valor no manda nada', () => {
  const guardados = { 1: { minKg: 8 }, 2: { minKg: 0 } };
  const filas = [{ id: '1', valor: 8 }, { id: '2', valor: 3 }, { id: '3', valor: 1.5 }, { id: '4', valor: null }, { id: '5', valor: 0 }];
  assert.deepStrictEqual(cambiosSubrubrosFr(filas, guardados), { 2: 3, 3: 1.5, 5: 0 });
  assert.deepStrictEqual(cambiosSubrubrosFr([{ id: '1', valor: null }], guardados), { 1: null });
  assert.deepStrictEqual(cambiosSubrubrosFr([{ id: '2', valor: 0 }], guardados), {}); // 0 guardado y 0 tipeado: sin cambio
  assert.deepStrictEqual(cambiosSubrubrosFr([], undefined), {});
});

test('errorSubrubrosFr: min/kg de 0 a 600; null (sacar) vale; nombra el subrubro', () => {
  assert.strictEqual(errorSubrubrosFr({ 1: 0, 2: 600, 3: null }), null);
  assert.match(errorSubrubrosFr({ 1: 601 }, { 1: 'Frutos secos' }), /Frutos secos/);
  assert.match(errorSubrubrosFr({ 7: -1 }), /Subrubro 7/);
  assert.notStrictEqual(errorSubrubrosFr({ 1: NaN }), null);
});

test('cuentaProductosFr / textoUsosFr: textos de la lista de productos y de "Usada en" de la máquina', () => {
  assert.strictEqual(cuentaProductosFr({ graneles: [{ presentaciones: [1, 2] }, { presentaciones: [] }] }), '2 productos · 2 presentaciones');
  assert.strictEqual(cuentaProductosFr({ graneles: [{ presentaciones: [1] }] }), '1 producto · 1 presentación');
  assert.strictEqual(textoUsosFr({ graneles: 1 }), 'en uso por 1 granel');
  assert.strictEqual(textoUsosFr({ graneles: 3 }), 'en uso por 3 graneles');
  assert.strictEqual(textoUsosFr({ graneles: 0 }), 'sin uso');
  assert.strictEqual(textoUsosFr(undefined), 'sin uso');
});

test('coincideFr: todas las palabras, sin importar mayúsculas ni tildes; vacío coincide con todo', () => {
  assert.strictEqual(coincideFr('Almendra Pelada (Almendra 500G)', 'ALMENDRA 500'), true);
  assert.strictEqual(coincideFr('Maní tostado', 'mani'), true);
  assert.strictEqual(coincideFr('Maní tostado', 'mani sal'), false);
  assert.strictEqual(coincideFr('Maní tostado', '  '), true);
});

test('subrubrosListaFr: los de SIGA + los configurados que SIGA ya no trae (para poder sacarles el valor)', () => {
  const siga = [{ id: '7', nombre: 'Frutos secos', graneles: [{ presentaciones: [] }] }];
  assert.deepStrictEqual(subrubrosListaFr(siga, { 7: {}, 9: {} }).map(s => [s.id, s.nombre, s.graneles.length]),
    [['7', 'Frutos secos', 1], ['9', 'Subrubro 9 (ya no tiene productos en SIGA)', 0]]);
  assert.strictEqual(subrubrosListaFr(siga, undefined).length, 1);
  assert.strictEqual(siga.length, 1); // no muta
});

test('conInsumosFr: agrega los elegidos con cantidad 1 sin repetir', () => {
  assert.deepStrictEqual(conInsumosFr([{ plu: '900', nombre: 'Bolsa', cantidad: 2 }], [{ plu: 900, nombre: 'Bolsa' }, { plu: '901', nombre: 'Etiqueta' }]),
    [{ plu: '900', nombre: 'Bolsa', cantidad: 2 }, { plu: '901', nombre: 'Etiqueta', cantidad: 1 }]);
});

test('errorInsumosFr: cantidad mayor que 0 en cada insumo', () => {
  assert.strictEqual(errorInsumosFr([{ plu: '900', nombre: 'Bolsa', cantidad: 2 }]), null);
  assert.strictEqual(errorInsumosFr([]), null);
  assert.match(errorInsumosFr([{ plu: '900', nombre: 'Bolsa "A"', cantidad: null }]), /Bolsa "A"/);
  assert.notStrictEqual(errorInsumosFr([{ plu: '900', cantidad: 0 }]), null);
  assert.notStrictEqual(errorInsumosFr([{ plu: '900', cantidad: -1 }]), null);
});

test('costoUnidadFr: suma cantidad × costo de cada insumo; null si alguno no tiene costo', () => {
  assert.strictEqual(costoUnidadFr([{ cantidad: 1, costo: 20 }, { cantidad: 2, costo: 1.255 }]), 22.51);
  assert.strictEqual(costoUnidadFr([{ cantidad: 1, costo: 20 }, { cantidad: 1, costo: null }]), null);
  assert.strictEqual(costoUnidadFr([]), 0);
  assert.strictEqual(costoUnidadFr(undefined), 0);
});

test('filasPesosFr: un peso por fila, ascendente, con sus insumos; también los configurados que ya no tienen presentaciones', () => {
  const pesos = [{ pesoG: 250, presentaciones: 34 }, { pesoG: 1000, presentaciones: 2 }];
  const ipp = { 1000: [{ plu: '900', cantidad: 1, nombre: 'Bolsa', costo: 20 }], 500: [{ plu: '901', cantidad: 1, nombre: 'Etiqueta', costo: 5 }] };
  assert.deepStrictEqual(filasPesosFr(pesos, ipp), [
    { pesoG: 250, presentaciones: 34, insumos: [] },
    { pesoG: 500, presentaciones: 0, insumos: ipp[500] },
    { pesoG: 1000, presentaciones: 2, insumos: ipp[1000] },
  ]);
  assert.deepStrictEqual(filasPesosFr(undefined, undefined), []);
  assert.strictEqual(pesos.length, 2); // no muta
});

test('textoPesoFr / pesoCortoFr: "250 g · 34 presentaciones", kilos enteros en kg, sin presentaciones marcado', () => {
  assert.strictEqual(textoPesoFr({ pesoG: 250, presentaciones: 34 }), '250 g · 34 presentaciones');
  assert.strictEqual(textoPesoFr({ pesoG: 1000, presentaciones: 1 }), '1 kg · 1 presentación');
  assert.strictEqual(textoPesoFr({ pesoG: 1500, presentaciones: 0 }), '1500 g · sin presentaciones');
  assert.deepStrictEqual([pesoCortoFr(250), pesoCortoFr(2000), pesoCortoFr(1500)], ['250 g', '2 kg', '1500 g']);
});

test('estadoPesosFr: pesos con insumos y pesos con algún insumo sin costo', () => {
  const filas = [{ pesoG: 250, insumos: [] }, { pesoG: 500, insumos: [{ cantidad: 1, costo: 5 }] }, { pesoG: 1000, insumos: [{ cantidad: 1, costo: null }] }];
  assert.deepStrictEqual(estadoPesosFr(filas), { total: 3, conInsumos: 2, sinCosto: 1 });
  assert.deepStrictEqual(estadoPesosFr([]), { total: 0, conInsumos: 0, sinCosto: 0 });
});

test('textoAjustesPesoFr / textoTramosTiempoFr: cuántos tramos tiene cada tabla; null o sin tramos → sin ajuste', () => {
  assert.strictEqual(textoAjustesPesoFr(null), 'sin ajuste');
  assert.strictEqual(textoAjustesPesoFr(undefined), 'sin ajuste');
  assert.strictEqual(textoAjustesPesoFr({ tramosG: [], puntos: [] }), 'sin ajuste');
  assert.strictEqual(textoAjustesPesoFr({ tramosG: [1000], puntos: [0] }), '1 tramo');
  assert.strictEqual(textoAjustesPesoFr({ tramosG: [100, 1000], puntos: [8, 0] }), '2 tramos');
  assert.strictEqual(textoTramosTiempoFr([]), 'sin ajuste');
  assert.strictEqual(textoTramosTiempoFr(undefined), 'sin ajuste');
  assert.strictEqual(textoTramosTiempoFr([{ hastaG: 1000, minKg: 0 }]), '1 tramo');
  assert.strictEqual(textoTramosTiempoFr([{ hastaG: 250, minKg: 3 }, { hastaG: 1000, minKg: 0 }]), '2 tramos');
});

test('estadoConfigFr: tramos, máquinas, subrubros, insumos por peso y margen por peso con su estado (ok | falta | info)', () => {
  const filas = [{ pesoG: 250, insumos: [{ cantidad: 1, costo: 5 }] }, { pesoG: 500, insumos: [] }];
  const e = estadoConfigFr([{ id: 'env' }], [{ id: '1' }, { id: '2' }], { 1: { minKg: 8 } }, filas, { tramosG: [100, 1000], puntos: [8, 0] },
    [{ hastaG: 250, minKg: 3 }, { hastaG: 1000, minKg: 0 }]);
  assert.deepStrictEqual(e.map(p => [p.id, p.texto, p.estado]), [
    ['frTramos', '2 tramos', 'info'], ['frMaquinas', '1 cargada', 'ok'], ['frSubrubrosCard', '1 de 2 con min/kg', 'falta'],
    ['frPesos', '1 de 2 pesos con insumos', 'info'], ['frAjustes', '2 tramos', 'info']]);
  // sin nada cargado: ninguna máquina no es un faltante (la máquina es opcional)
  const vacio = estadoConfigFr([], [], {}, [], null, []);
  assert.deepStrictEqual(vacio.map(p => [p.texto, p.estado]),
    [['sin ajuste', 'info'], ['ninguna cargada', 'info'], ['sin subrubros', 'info'], ['sin pesos', 'info'], ['sin ajuste', 'info']]);
  assert.deepStrictEqual(estadoConfigFr([{}, {}], [{ id: '1' }], { 1: { minKg: 0 } }, [{ pesoG: 250, insumos: [{ cantidad: 1, costo: null }] }], null).map(p => [p.texto, p.estado]),
    [['sin ajuste', 'info'], ['2 cargadas', 'ok'], ['1 de 1 con min/kg', 'ok'], ['1 sin costo', 'falta'], ['sin ajuste', 'info']]);
});

// ── HTML de las tarjetas (el script cargado en un contexto con los globales de precios_comun.js / precios_config.js) ──
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const campoU = (input, u, { pre = false, w = 'w-28' } = {}) =>
  `<span class="campo-u ${w}">${pre ? `<span class="u pre" aria-hidden="true">${u}</span>` : ''}${input}${pre ? '' : `<span class="u" aria-hidden="true">${u}</span>`}</span>`;
const numOrNull = v => { const s = String(v ?? '').trim(); if (s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null; };

const CFG = {
  migrado: true,
  maquinas: [{ id: 'env', nombre: 'Envasadora', costoHora: 5000, usos: { graneles: 2 } }, { id: 'sel', nombre: 'Selladora', costoHora: 1000, usos: { graneles: 0 } }],
  tramosTiempo: [{ hastaG: 250, minKg: 3 }, { hastaG: 500, minKg: 1 }, { hastaG: 1000, minKg: 0 }, { hastaG: 2000, minKg: -1 }],
  subrubros: { 1: { minKg: 8.5 }, 9: { minKg: 2 } },
  porGranel: { 900: { minKg: 4, maquinaId: 'env' } },
  subrubrosSiga: [
    { id: '1', nombre: 'Frutos secos', graneles: [{ plu: '900', nombre: 'Almendra', presentaciones: [{ plu: '901', nombre: 'Almendra 250g', pesoG: 250 }] }] },
    { id: '2', nombre: 'Harinas', graneles: [] }],
  sinSubrubro: [{ plu: '950', nombre: 'Suelto', presentaciones: [] }], pesos: [], insumosPorPeso: {}, ajustesPeso: null };

// Las funciones del historial (public/js/precios_fraccionado_historial.js, con su propio test) se reemplazan por espías: acá sólo se prueba cómo se las conecta.
const espiasHf = eventos => Object.fromEntries(['conectarSubrubrosHf', 'conectarTramosHf', 'pintarSubrubrosHf', 'pintarTramosHf', 'pintarEstadoHf', 'cargarHistorialHf',
  'invalidarHistorialHf'].map(n => [n, (...a) => { eventos.push(n); return a; }]));
function cargar(cfg = CFG, extra = {}) {
  const ctx = vm.createContext({ module: { exports: {} }, esc, campoU, numOrNull, fmtMoney: n => String(n), PreciosEsquema: { AJUSTES_PESO_MAX: 12 }, ...espiasHf([]), ...extra });
  vm.runInContext(fs.readFileSync(RUTA, 'utf8'), ctx);
  vm.runInContext(`cfFr = ${JSON.stringify(cfg)}`, ctx);
  return code => vm.runInContext(code, ctx);
}
const tarjeta = (html) => cheerio.load(`<div id="raiz">${html}</div>`)('#raiz');

test('tarjeta de tramos: la base (primer tramo ≥ 1 kg) va fija en 0, deshabilitada y rotulada; los demás se editan', () => {
  const $ = tarjeta(cargar()('htmlTramosFr()'));
  const filas = $.find('tbody tr');
  assert.strictEqual(filas.length, 4);
  const valores = filas.toArray().map(tr => [$.find(tr).find('[data-k="hastaG"]').attr('value'), $.find(tr).find('[data-k="minKg"]').attr('value'),
    $.find(tr).find('[data-k="minKg"]').is('[disabled]')]);
  assert.deepStrictEqual(valores, [['250', '3', false], ['500', '1', false], ['1000', '0', true], ['2000', '-1', false]]);
  assert.strictEqual($.find('.fp-chip').length, 1);
  assert.match($.find('tbody tr').eq(2).text(), /base/);
  assert.match($.find('tbody tr').eq(1).find('[data-k="minKg"]').attr('min'), /-600/);
  assert.strictEqual($.find('[data-k="minKg"]').attr('max'), '600');
});

test('tarjeta de tramos: sin tramos hay tabla vacía y texto; con ninguno ≥ 1 kg la base es el último', () => {
  const vacia = tarjeta(cargar({ ...CFG, tramosTiempo: [] })('htmlTramosFr()'));
  assert.strictEqual(vacia.find('tbody').children().length, 0);
  assert.strictEqual(vacia.find('tbody').html(), ''); // vacío de verdad: el CSS del "todavía no hay" depende de tbody:empty
  assert.ok(vacia.find('.fr-vacio').length);
  const livianos = tarjeta(cargar({ ...CFG, tramosTiempo: [{ hastaG: 100, minKg: 5 }, { hastaG: 500, minKg: 0 }] })('htmlTramosFr()'));
  assert.deepStrictEqual(livianos.find('[data-k="minKg"]').toArray().map(i => livianos.find(i).is('[disabled]')), [false, true]);
});

test('tarjeta de tramos: un solo Guardar, encabezados con scope, inputs con nombre accesible y card guardable', () => {
  const $ = tarjeta(cargar()('htmlTramosFr()'));
  assert.strictEqual($.find('.fr-guardar').length, 1);
  assert.strictEqual($.find('[role="status"][aria-live="polite"]').length, 1);
  assert.ok($.find('th').length >= 2);
  $.find('th').each((_, th) => assert.ok($.find(th).attr('scope'), 'th sin scope'));
  $.find('input').each((_, i) => assert.ok($.find(i).attr('aria-label'), 'input sin aria-label'));
  assert.ok($.find('#frTramos[data-guardable]').length);
  assert.ok($.find('.fr-agregar').length);
});

test('tarjeta de tramos: el texto explica que el ajuste es por kilo y cómo se usa', () => {
  const t = tarjeta(cargar()('htmlTramosFr()')).text();
  assert.match(t, /por kilo/i);
  assert.match(t, /250 g/);
  assert.match(t, /\+3 min/);
  assert.match(t, /base/);
  assert.match(t, /\(min\/kg \+ ajuste del tramo\) × kg de la presentación/);
});

test('tarjeta de subrubros: una fila por subrubro (también el que SIGA ya no trae) con UN input "Min por kg" y un solo Guardar', () => {
  const $ = tarjeta(cargar()('htmlSubrubrosCardFr()'));
  const entradas = $.find('input[data-id]');
  assert.deepStrictEqual(entradas.toArray().map(i => [$.find(i).attr('data-id'), $.find(i).attr('value') || '']), [['1', '8.5'], ['2', ''], ['9', '2']]);
  assert.strictEqual($.find('tbody tr').length, 3);
  assert.strictEqual($.find('select').length, 0);
  assert.strictEqual($.find('[data-k="hastaG"],[data-k="minutos"]').length, 0);
  assert.strictEqual($.find('.fr-guardar').length, 1);
  assert.ok($.find('#frSubrubrosCard[data-guardable]').length);
  assert.match($.find('input[data-id="1"]').attr('aria-label'), /Frutos secos/);
  assert.strictEqual($.find('input[data-id]').attr('min'), '0');
  assert.strictEqual($.find('input[data-id]').attr('max'), '600');
  $.find('th').each((_, th) => assert.ok($.find(th).attr('scope'), 'th sin scope'));
  assert.deepStrictEqual($.find('thead th').toArray().map(th => $.find(th).text().trim()).slice(0, 3), ['Subrubro', 'Productos', 'Min por kg']);
});

test('tarjeta de subrubros: marca los que no tienen valor, cuenta los que faltan y lista los productos con su min/kg propio', () => {
  const $ = tarjeta(cargar()('htmlSubrubrosCardFr()'));
  assert.deepStrictEqual($.find('tbody tr').toArray().map(tr => $.find(tr).attr('data-falta')), ['0', '1', '0']);
  assert.strictEqual($.find('#frFaltan').text(), '1');
  assert.match($.find('tbody tr').eq(1).text(), /sin valor/);
  const prod = $.find('li[data-q]').first().text();
  assert.match(prod, /Almendra/);
  assert.match(prod, /propio: 4 min\/kg/);
  assert.match(prod, /Envasadora/); // máquina propia del granel
  assert.match($.text(), /1 producto sin subrubro/);
});

test('tarjeta de subrubros: con el filtro "solo los que faltan" encendido las filas con valor salen ocultas', () => {
  const $ = tarjeta(cargar()('soloFaltaFr = true; htmlSubrubrosCardFr()'));
  assert.ok($.find('#frSoloFalta').is('[checked]'));
  assert.deepStrictEqual($.find('tbody tr').toArray().map(tr => $.find(tr).hasClass('hidden')), [true, false, true]);
});

test('tarjeta de máquinas: "usada en" cuenta graneles y la que está en uso no se puede quitar', () => {
  const $ = tarjeta(cargar()('htmlMaquinasFr()'));
  assert.deepStrictEqual($.find('.fr-usos').toArray().map(td => $.find(td).text()), ['en uso por 2 graneles', 'sin uso']);
  assert.deepStrictEqual($.find('.fr-quitar').toArray().map(b => $.find(b).is('[disabled]')), [true, false]);
  assert.doesNotMatch($.text(), /subrubro/i);
});

test('barra de estado: tramos, máquinas, subrubros, insumos y margen, cada una con su ancla', () => {
  const $ = tarjeta(cargar()('htmlEstadoFr()'));
  assert.deepStrictEqual($.find('[data-ancla]').toArray().map(b => $.find(b).attr('data-ancla')), ['frTramos', 'frMaquinas', 'frSubrubrosCard', 'frPesos', 'frAjustes']);
});

test('ningún texto menciona facilidad, factor ni escalas: ni el script ni el HTML de la configuración', () => {
  const src = fs.readFileSync(RUTA, 'utf8');
  assert.doesNotMatch(src, /facilidad|escalas|factor/i);
  const run = cargar();
  const html = [run('CABECERA_FR'), run('htmlEstadoFr()'), run('htmlTramosFr()'), run('htmlMaquinasFr()'), run('htmlSubrubrosCardFr()')].join('');
  assert.doesNotMatch(html, /facilidad|escalas|factor/i);
  assert.match(tarjeta(run('CABECERA_FR')).text(), /\(min\/kg \+ ajuste del tramo\) × kg de la presentación/);
});

test('la cabecera da el orden de uso: tramos, después subrubros, después pisar productos', () => {
  const t = tarjeta(cargar()('CABECERA_FR')).text();
  assert.match(t, /primero la tabla de tramos.*después.*subrubros.*producto/s);
});

// ── Sugerido del historial: cómo se conecta (la lógica está en precios_fraccionado_historial.js) ──
test('tarjeta de subrubros: cada fila trae su celda "Historial" con el id y el nombre, la tarjeta arranca sin la columna y el input no cambia', () => {
  const $ = tarjeta(cargar()('htmlSubrubrosCardFr()'));
  assert.deepStrictEqual($.find('td[data-hf-sub]').toArray().map(td => [$.find(td).attr('data-hf-sub'), $.find(td).attr('data-hf-nombre')]),
    [['1', 'Frutos secos'], ['2', 'Harinas'], ['9', 'Subrubro 9 (ya no tiene productos en SIGA)']]);
  assert.ok($.find('#frSubrubrosCard').hasClass('hf-sin')); // hasta que llega el historial la columna no se muestra
  assert.strictEqual($.find('th.hf-col').text(), 'Historial (por 1 kg)');
  assert.strictEqual($.find('input[data-id]').length, 3);
  assert.strictEqual($.find('.hf-usar,.hf-chip').length, 0); // los chips los pinta el módulo del historial al llegar los datos
  assert.deepStrictEqual($.find('thead th').toArray().map(th => $.find(th).text().trim()), ['Subrubro', 'Productos', 'Min por kg', 'Historial (por 1 kg)', 'Estado']);
});

test('tarjeta de tramos: cada fila (también las agregadas) trae su celda del historial; la tarjeta arranca sin la columna', () => {
  const run = cargar();
  const $ = tarjeta(run('htmlTramosFr()'));
  assert.strictEqual($.find('tbody tr').length, 4);
  assert.strictEqual($.find('tbody td[data-hf-tramo]').length, 4);
  assert.ok($.find('#frTramos').hasClass('hf-sin'));
  assert.strictEqual($.find('thead th.hf-col').text(), 'Historial');
  assert.strictEqual($.find('thead th').length, 4); // hasta, ± min/kg, historial, quitar
  assert.strictEqual(tarjeta(`<table><tbody>${run('htmlFilaTramoFr({ hastaG: 4000, minKg: null })')}</tbody></table>`).find('td[data-hf-tramo]').length, 1);
});

test('la lista de productos de un subrubro marca cada renglón con su PLU (para reflejar lo que se fija)', () => {
  const $ = tarjeta(cargar()('htmlSubrubrosCardFr()'));
  assert.strictEqual($.find('li[data-plu="900"]').length, 1);
});

test('fijarProductoFr: PUT granel/:plu sólo con { minKg }, mezcla la config nueva sin pisar los insumos y reescribe el renglón del producto', async () => {
  const llamadas = [];
  let renglon = '';
  const li = { set outerHTML(v) { renglon = v; } };
  const run = cargar(CFG, {
    CSS: { escape: s => s },
    pedirEsq: async (m, u, b) => { llamadas.push([m, u, b]); return { migrado: true, porGranel: { 900: { minKg: 6.4, maquinaId: 'env' } }, insumosPorPeso: { 250: [{ plu: '1', cantidad: 1 }] } }; },
    document: { querySelector: sel => (sel === '#frSubrubros li[data-plu="900"]' ? li : null) },
  });
  run('cfFr.insumosPorPeso = { 500: [{ plu: "7", cantidad: 2, nombre: "Bolsa", costo: 10 }] }');
  await run('fijarProductoFr("900", 6.4)');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(llamadas)), [['PUT', '/api/precios/config/esquema/fraccionado/granel/900', { minKg: 6.4 }]]); // JSON: objetos de otro contexto
  assert.match(renglon, /propio: 6,4 min\/kg/);
  assert.match(renglon, /data-plu="900"/);
  assert.strictEqual(run('cfFr.porGranel[900].minKg'), 6.4);
  assert.strictEqual(run('cfFr.insumosPorPeso[500][0].nombre'), 'Bolsa'); // el insumosPorPeso crudo de la respuesta no pisa el del GET (con nombre y costo)
  assert.strictEqual(run('cfFr.subrubrosSiga.length'), 2);
  await assert.rejects(cargar(CFG, { CSS: { escape: s => s }, pedirEsq: async () => { throw new Error('minKg: número de 0 a 600 (min/kg)'); }, document: {} })('fijarProductoFr("900", 9999)'), /número de 0 a 600/);
});

test('conexión: al pintar la configuración se pide el historial; al guardar los tramos se invalida ANTES de repintar y se pide de nuevo', async () => {
  const eventos = [];
  const nodo = () => ({ classList: { toggle() {}, add() {}, remove() {} }, querySelector: () => nodo(), querySelectorAll: () => [], dataset: {} });
  const panel = nodo();
  const run = cargar(CFG, { ...espiasHf(eventos) });
  run('pintarCosteoFracc')(panel);
  assert.match(panel.innerHTML, /id="frHistorial"/);
  assert.deepStrictEqual(eventos.filter(e => /Historial|Hf/.test(e)).sort(), ['cargarHistorialHf', 'conectarSubrubrosHf', 'conectarTramosHf']);
  assert.ok(panel.innerHTML.indexOf('id="frHistorial"') < panel.innerHTML.indexOf('id="frEstado"') && panel.innerHTML.indexOf('id="frEstado"') < panel.innerHTML.indexOf('id="frTramos"'));

  eventos.length = 0;
  const filas = [['500', '2'], ['1000', '0']].map(([h, m]) => ({ querySelector: sel => ({ value: sel.includes('hastaG') ? h : m }) }));
  const msg = {}, boton = { disabled: false }, nuevo = nodo();
  const card = { querySelectorAll: () => filas, querySelector: sel => (sel === '.esq-msg' ? msg : sel === '.fr-guardar' ? boton : null) };
  const run2 = cargar(CFG, {
    ...espiasHf(eventos), msgEsq() {}, limpiarSucio() {}, esFraccCfg: () => true,
    pedirEsq: async (m, u, b) => { eventos.push(`${m} ${u.split('/').pop()} ${JSON.stringify(b.tramos)}`); return { migrado: true, tramosTiempo: b.tramos, insumosPorPeso: {} }; },
    document: { activeElement: null, getElementById: id => (id === 'frTramos' ? nuevo : id === 'cfgFraccAviso' ? nodo() : null) },
  });
  await run2('guardarTramosFr')(card);
  assert.deepStrictEqual(eventos.filter(e => !/^conectarSub/.test(e)), ['PUT tramos-tiempo [{"hastaG":500,"minKg":2},{"hastaG":1000,"minKg":0}]', 'invalidarHistorialHf', 'conectarTramosHf', 'cargarHistorialHf']);
});

test('no hay diálogos nativos ni console en el script de la configuración', () => {
  assert.doesNotMatch(fs.readFileSync(RUTA, 'utf8'), /(alert|confirm|prompt)\s*\(|console\./);
});
