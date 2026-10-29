'use strict';
// Sugerido de min/kg desde el historial, lado front (public/js/precios_fraccionado_historial.js): chips y textos, histograma, los productos que más
// se alejan, el HTML del panel "Ver distribución", el cache de la carga y que "Usar" sólo rellena el campo (no guarda). El script es clásico
// (globales del navegador): se cargan acá los que usa y se prueba con el módulo exportado.
const test = require('node:test');
const assert = require('node:assert');
const cheerio = require('cheerio');

const llamadas = [];
globalThis.esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
globalThis.numOrNull = v => { const s = String(v ?? '').trim(); if (s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
globalThis.msgEsq = (el, txt, cls) => { if (el) { el.textContent = txt; el.cls = cls; } };
globalThis.getJson = url => { llamadas.push(url); return globalThis.__respuesta(); };
const H = require('../public/js/precios_fraccionado_historial.js');

const html = s => cheerio.load(`<div id="raiz">${s}</div>`)('#raiz');
const HIST = H.normalizarHistorialHf({
  cargas: { total: 3016, usadas: 2037, descartes: { act: 10, duracion: 20, sinKilos: 30, sinGranel: 40, sinPeso: 654 } }, minMuestras: 5,
  productos: { 100: { n: 12, mediana: 6.4, p25: 5, p75: 8, subrubroId: '7', pocosDatos: false }, 101: { n: 2, mediana: null, p25: null, p75: null, subrubroId: '7', pocosDatos: true } },
  subrubros: { 7: { n: 31, productos: 4, mediana: 8.2, p25: 7, p75: 9.5, pocosDatos: false }, 8: { n: 3, productos: 1, mediana: null, p25: null, p75: null, pocosDatos: true },
    9: { n: 0, productos: 0, mediana: null, p25: null, p75: null, pocosDatos: true } },
  tramos: [{ hastaG: 100, base: false, n: 5, mediana: 3.1, p25: 2, p75: 4, pocosDatos: false }, { hastaG: 250, base: false, n: 2, mediana: null, p25: null, p75: null, pocosDatos: true },
    { hastaG: 500, base: false, n: 9, mediana: -1.25, p25: -2, p75: 0, pocosDatos: false }, { hastaG: 1000, base: true, n: 40, mediana: 0, p25: 0, p75: 0, pocosDatos: false }],
  distribucion: { 7: [{ plu: '100', nombre: 'Almendra granel', n: 12, minKg: 6.4 }, { plu: '102', nombre: 'Nuez <b>', n: 9, minKg: 8.2 }, { plu: '103', nombre: null, n: 6, minKg: 20 }], 8: [{ plu: '110', nombre: 'Maní', n: 3, minKg: 4 }] },
});

// ── Respuesta del servidor ──
test('normalizarHistorialHf: completa lo que falte y no confía en la forma de la respuesta', () => {
  for (const mala of [null, undefined, {}, { cargas: 5, productos: [], tramos: 'x' }]) {
    const h = H.normalizarHistorialHf(mala);
    assert.deepStrictEqual([h.cargas.total, h.cargas.usadas, h.minMuestras, h.productos, h.subrubros, h.tramos, h.distribucion], [0, 0, 5, {}, {}, [], {}]);
    assert.deepStrictEqual(Object.keys(h.cargas.descartes), ['act', 'duracion', 'sinKilos', 'sinGranel', 'sinPeso']);
  }
  assert.strictEqual(HIST.cargas.descartes.sinPeso, 654);
});

// ── Formatos ──
test('formatos: es-AR a 2 decimales, signo explícito en los tramos y plurales', () => {
  assert.strictEqual(H.fmtMinHf(8.2), '8,2');
  assert.strictEqual(H.fmtMinHf(2037), '2.037');
  assert.strictEqual(H.fmtSignoHf(3.1), '+3,1');
  assert.strictEqual(H.fmtSignoHf(-1.25), '-1,25');
  assert.strictEqual(H.fmtSignoHf(0), '0');
  assert.strictEqual(H.fmtSignoHf(-0), '0');
  assert.deepStrictEqual([H.textoCargasHf(1), H.textoCargasHf(31), H.textoProductosHf(1), H.textoProductosHf(4)], ['1 carga', '31 cargas', '1 producto', '4 productos']);
});

// ── Chips ──
test('chipSubrubroHf: mediana, cargas y productos; con pocos datos sin valor ni "Usar"; sin entrada no hay chip', () => {
  const c = H.chipSubrubroHf(HIST, '7');
  assert.strictEqual(c.texto, 'Historial: 8,2 · 31 cargas · 4 productos');
  assert.strictEqual(c.usar, 8.2);
  assert.match(c.titulo, /1 kg/);
  assert.match(c.titulo, /7 a 9,5/);
  for (const id of ['8', '9']) assert.deepStrictEqual([H.chipSubrubroHf(HIST, id).texto, H.chipSubrubroHf(HIST, id).usar], ['pocos datos', null]);
  assert.strictEqual(H.chipSubrubroHf(HIST, '99'), null);
  assert.strictEqual(H.chipSubrubroHf(null, '7'), null);
  assert.strictEqual(H.chipSubrubroHf(HIST, 'constructor'), null);
});

test('chipTramoHf: diferencia con signo y productos; la base no lleva sugerencia; pocos datos sin valor', () => {
  assert.deepStrictEqual([H.chipTramoHf(HIST, 100, 100).texto, H.chipTramoHf(HIST, 100, 100).usar], ['Historial: +3,1 · 5 productos', 3.1]);
  assert.deepStrictEqual([H.chipTramoHf(HIST, 500, 500).texto, H.chipTramoHf(HIST, 500, 500).usar], ['Historial: -1,25 · 9 productos', -1.25]);
  assert.strictEqual(H.chipTramoHf(HIST, 1000, 1000), null);
  assert.deepStrictEqual([H.chipTramoHf(HIST, 250, 250).texto, H.chipTramoHf(HIST, 250, 250).usar], ['pocos datos', null]);
});

test('chipTramoHf: un "hasta" editado sin guardar o una fila nueva ya no es un tramo del historial', () => {
  assert.strictEqual(H.chipTramoHf(HIST, 500, 100), null); // 100 → 500 sin guardar: no hereda la sugerencia del 500 que ya existe
  assert.strictEqual(H.chipTramoHf(HIST, 100, null), null); // fila agregada
  assert.strictEqual(H.chipTramoHf(HIST, null, 100), null); // vaciado
  assert.strictEqual(H.chipTramoHf(HIST, 300, 300), null); // el guardado no está en el historial
  assert.strictEqual(H.chipTramoHf(null, 100, 100), null);
});

test('chipProductoHf: valor por 1 kg y cargas; con pocos datos sin valor; sin entrada no muestra nada; el PLU puede venir como número', () => {
  assert.deepStrictEqual([H.chipProductoHf(HIST, '100').texto, H.chipProductoHf(HIST, 100).usar], ['Historial: 6,4 por 1 kg · 12 cargas', 6.4]);
  assert.deepStrictEqual([H.chipProductoHf(HIST, '101').texto, H.chipProductoHf(HIST, '101').usar], ['pocos datos', null]);
  assert.strictEqual(H.chipProductoHf(HIST, '999'), null);
  assert.strictEqual(H.chipProductoHf(null, '100'), null);
});

test('HTML de los chips: "Usar" lleva el valor y un nombre accesible; pocos datos no tiene botón; todo texto del servidor va escapado', () => {
  const sub = html(H.htmlSubrubroHf(HIST, '7', 'Frutos <secos>'));
  assert.strictEqual(sub.find('.hf-chip').text(), 'Historial: 8,2 · 31 cargas · 4 productos');
  assert.strictEqual(sub.find('.hf-usar').attr('data-hf-valor'), '8.2');
  assert.strictEqual(sub.find('.hf-usar').attr('aria-label'), 'Usar 8,2 min/kg en Frutos <secos>');
  assert.strictEqual(sub.find('.hf-usar').attr('type'), 'button');
  assert.strictEqual(sub.find('.hf-ver').attr('data-hf-nombre'), 'Frutos <secos>');
  assert.strictEqual(sub.find('script,secos').length, 0);
  const poco = html(H.htmlSubrubroHf(HIST, '9', 'Harinas'));
  assert.deepStrictEqual([poco.find('.hf-poco').text(), poco.find('.hf-usar').length, poco.find('.hf-ver').length], ['pocos datos', 0, 0]); // n 0: tampoco hay qué distribuir
  assert.strictEqual(H.htmlSubrubroHf(HIST, '99', 'Otro'), '');
  assert.strictEqual(html(H.htmlSubrubroHf(HIST, '8', 'Maní')).find('.hf-ver').length, 1); // pocos datos pero con productos: se puede mirar
  const tramo = html(H.htmlTramoHf(HIST, 100, 100));
  assert.strictEqual(tramo.find('.hf-usar').attr('data-hf-valor'), '3.1');
  assert.strictEqual(H.htmlTramoHf(HIST, 1000, 1000), '');
  const prod = html(H.htmlProductoHf(HIST, '100'));
  assert.strictEqual(prod.find('.hf-chip').text(), 'Historial: 6,4 por 1 kg · 12 cargas');
  assert.strictEqual(H.htmlProductoHf(HIST, '999'), '');
});

// ── Histograma ──
test('histogramaHf: vacío, un solo valor y todos iguales dan una sola barra; sin datos no hay barras', () => {
  assert.deepStrictEqual(H.histogramaHf([]), { min: null, max: null, barras: [] });
  assert.deepStrictEqual(H.histogramaHf([5]), { min: 5, max: 5, barras: [{ desde: 5, hasta: 5, n: 1 }] });
  assert.deepStrictEqual(H.histogramaHf([5, 5, 5]).barras, [{ desde: 5, hasta: 5, n: 3 }]);
  assert.deepStrictEqual(H.histogramaHf([NaN, null, undefined, 'x', Infinity]).barras, []);
});

test('histogramaHf: 10 grupos de ancho parejo entre el mínimo y el máximo; el máximo cae en el último; ninguno se pierde', () => {
  const h = H.histogramaHf([0, 1, 1.5, 5, 9.99, 10]);
  assert.strictEqual(h.barras.length, 10);
  assert.deepStrictEqual([h.min, h.max], [0, 10]);
  assert.deepStrictEqual(h.barras.map(b => b.n), [1, 2, 0, 0, 0, 1, 0, 0, 0, 2]);
  assert.strictEqual(h.barras.reduce((s, b) => s + b.n, 0), 6);
  h.barras.forEach((b, i) => { assert.ok(Math.abs(b.desde - i) < 1e-9); assert.ok(Math.abs(b.hasta - (i + 1)) < 1e-9); });
  assert.deepStrictEqual(H.histogramaHf([2, 8], 4).barras.map(b => b.n), [1, 0, 0, 1]);
});

test('histogramaHf: no muta la lista de entrada y acepta valores desordenados', () => {
  const v = [9, 1, 5, 3];
  const h = H.histogramaHf(v);
  assert.deepStrictEqual(v, [9, 1, 5, 3]);
  assert.strictEqual(h.barras.reduce((s, b) => s + b.n, 0), 4);
});

test('posicionHf: porcentaje dentro del rango, recortado a los bordes si queda fuera, y 50 si no hay rango', () => {
  const r = { min: 2, max: 12 };
  assert.deepStrictEqual(H.posicionHf(7, r), { pct: 50, fuera: false });
  assert.deepStrictEqual(H.posicionHf(2, r), { pct: 0, fuera: false });
  assert.deepStrictEqual(H.posicionHf(12, r), { pct: 100, fuera: false });
  assert.deepStrictEqual(H.posicionHf(30, r), { pct: 100, fuera: true });
  assert.deepStrictEqual(H.posicionHf(0, r), { pct: 0, fuera: true });
  assert.deepStrictEqual(H.posicionHf(4, { min: 4, max: 4 }), { pct: 50, fuera: false });
  assert.deepStrictEqual(H.posicionHf(5, { min: 4, max: 4 }), { pct: 50, fuera: true });
});

test('medianaHf: impar, par (a 2 decimales), vacío y no muta', () => {
  const v = [9, 1, 5];
  assert.strictEqual(H.medianaHf(v), 5);
  assert.deepStrictEqual(v, [9, 1, 5]);
  assert.strictEqual(H.medianaHf([1, 2, 4, 8.33]), 3);
  assert.strictEqual(H.medianaHf([1, 2]), 1.5);
  assert.strictEqual(H.medianaHf([]), null);
});

test('masAlejadosHf: los 5 de mayor distancia absoluta a la mediana; empate por más cargas; los que están en la mediana no cuentan; no muta', () => {
  const lista = [{ plu: 'a', n: 5, minKg: 8 }, { plu: 'b', n: 9, minKg: 4 }, { plu: 'c', n: 7, minKg: 12 }, { plu: 'd', n: 2, minKg: 8.1 },
    { plu: 'e', n: 3, minKg: 8.5 }, { plu: 'f', n: 4, minKg: 7 }, { plu: 'g', n: 6, minKg: 9 }];
  const copia = JSON.parse(JSON.stringify(lista));
  const r = H.masAlejadosHf(lista, 8);
  assert.deepStrictEqual(r.map(p => p.plu), ['b', 'c', 'g', 'f', 'e']); // b -4, c +4 (empate: b tiene más cargas), g +1 y f -1 (g más cargas), e +0.5; a (0) fuera
  assert.deepStrictEqual(r.map(p => p.dif), [-4, 4, 1, -1, 0.5]);
  assert.deepStrictEqual(lista, copia);
  assert.deepStrictEqual(H.masAlejadosHf(lista, 8, 2).map(p => p.plu), ['b', 'c']);
  assert.deepStrictEqual(H.masAlejadosHf([{ plu: 'x', n: 1, minKg: 3 }, { plu: 'y', n: 1, minKg: 3 }], 3), []);
  assert.deepStrictEqual(H.masAlejadosHf([], 3), []);
});

// ── Panel "Ver distribución" ──
const modelo = (extra = {}) => ({ ...H.modeloDistribucionHf(HIST, '7', 7), ...extra });

test('modeloDistribucionHf: la mediana del servidor manda; con pocos datos se usa la de los productos mostrados y se avisa', () => {
  assert.deepStrictEqual([modelo().mediana, modelo().actual, modelo().pocosDatos, modelo().lista.length], [8.2, 7, false, 3]);
  const poco = H.modeloDistribucionHf(HIST, '8', null);
  assert.deepStrictEqual([poco.mediana, poco.actual, poco.pocosDatos], [4, null, true]);
  assert.deepStrictEqual(H.modeloDistribucionHf(HIST, '99', 3).lista, []);
});

test('panel de distribución: cada barra con rango y cantidad de productos en aria-label y title, y los mismos datos en una tabla', () => {
  const $ = html(H.htmlDistribucionHf(modelo()));
  const barras = $.find('.hf-barra[role="img"]');
  assert.ok(barras.length >= 1);
  barras.each((_, b) => {
    const t = $.find(b).attr('aria-label');
    assert.match(t, /^De [\d,]+ a [\d,]+ min\/kg: \d+ productos?$/);
    assert.strictEqual($.find(b).attr('title'), t);
  });
  assert.strictEqual($.find('.hf-barras').children().length, 10);
  assert.strictEqual($.find('.hf-pista').attr('role'), 'group');
  assert.match($.find('.hf-pista').attr('aria-label'), /3 productos.*Mediana 8,2.*Valor actual 7/);
  const filas = $.find('.hf-tabla tbody tr');
  assert.strictEqual(filas.length, 10); // todos los grupos, también los vacíos
  assert.strictEqual(filas.toArray().reduce((s, tr) => s + Number($.find(tr).find('td').text()), 0), 3);
  assert.strictEqual($.find('.hf-tabla table caption').length, 1);
  $.find('.hf-tabla th').each((_, th) => assert.ok($.find(th).attr('scope')));
});

test('panel de distribución: mediana y valor actual rotulados con texto (no sólo color) y ubicados sobre el eje', () => {
  const $ = html(H.htmlDistribucionHf(modelo()));
  assert.strictEqual($.find('.hf-mediana .hf-tag').text(), 'Mediana 8,2');
  assert.strictEqual($.find('.hf-actual .hf-tag').text(), 'Valor actual 7');
  // valores 6.4, 8.2 y 20: el rango va de 6,4 a 20 → la mediana (8,2) queda al 13,24 % y el actual (7) al 4,41 %
  assert.strictEqual($.find('.hf-mediana').attr('style'), 'left:13.24%');
  assert.strictEqual($.find('.hf-actual').attr('style'), 'left:4.41%');
  assert.match($.text(), /Valor actual guardado: 7 min\/kg/);
  assert.match($.text(), /Mediana: 8,2 min\/kg/);
  const fuera = html(H.htmlDistribucionHf(modelo({ actual: 50 })));
  assert.match(fuera.find('.hf-actual .hf-tag').text(), /Valor actual 50 \(fuera del rango\)/);
  assert.match(fuera.find('.hf-actual').attr('style'), /left:100%/);
  const izq = html(H.htmlDistribucionHf(modelo({ actual: 6 })));
  assert.match(izq.find('.hf-actual .hf-tag').text(), /Valor actual 6 \(fuera del rango\)/);
  assert.match(izq.find('.hf-actual').attr('style'), /left:0%/);
  assert.ok(izq.find('.hf-actual').hasClass('hf-izq'));
  const sin = html(H.htmlDistribucionHf(modelo({ actual: null })));
  assert.strictEqual(sin.find('.hf-actual').length, 0);
  assert.match(sin.text(), /Valor actual guardado: sin valor/);
});

test('panel de distribución: aclara que el valor es por 1 kg, que no incluye el ajuste del tramo y que Fijar guarda en el momento', () => {
  const t = html(H.htmlDistribucionHf(modelo())).text();
  assert.match(t, /por 1 kg/);
  assert.match(t, /no incluyen el ajuste del tramo de peso, que se suma por presentación/);
  assert.match(t, /Fijar.*min\/kg propio.*se guarda en el momento/s);
  assert.doesNotMatch(t, /facilidad|escalas|factor/i);
});

test('panel de distribución: los productos más alejados con su cargas, su min/kg y un "Fijar" propio con su valor; nombres escapados', () => {
  const $ = html(H.htmlDistribucionHf(modelo()));
  const filas = $.find('.hf-alejados tbody tr');
  assert.deepStrictEqual(filas.toArray().map(tr => $.find(tr).attr('data-plu')), ['103', '100']); // el 102 está justo en la mediana (8,2)
  const f = $.find('.hf-alejados tbody tr').first();
  assert.match(f.text(), /PLU 103/); // sin nombre: se ve el PLU
  assert.deepStrictEqual(f.find('td').toArray().map(td => $.find(td).text().trim()).slice(0, 3), ['6', '20', '+11,8']);
  assert.strictEqual(f.find('.hf-fijar').attr('data-hf-valor'), '20');
  assert.strictEqual(f.find('.hf-fijar').attr('data-plu'), '103');
  assert.strictEqual($.find('.hf-fijar').length, 2);
  assert.match($.find('.hf-fijar').eq(1).attr('aria-label'), /^Fijar 6,4 min\/kg como propio de Almendra granel$/);
  const raros = html(H.htmlDistribucionHf(modelo({ lista: [{ plu: '1', nombre: 'Nuez <b>"x"</b>', n: 5, minKg: 30 }, { plu: '2', nombre: 'Otra', n: 5, minKg: 1 }], mediana: 10 })));
  assert.strictEqual(raros.find('.hf-alejados b').length, 0);
  assert.match(raros.find('.hf-alejados tbody tr').first().text(), /Nuez <b>"x"<\/b>/);
  $.find('.hf-alejados th').each((_, th) => assert.ok($.find(th).attr('scope')));
});

test('panel de distribución: un solo producto, o todos en la mediana, no rompe ni ofrece Fijar', () => {
  const uno = html(H.htmlDistribucionHf(modelo({ lista: [{ plu: '1', nombre: 'Solo', n: 7, minKg: 5 }], mediana: 5, actual: 5 })));
  assert.strictEqual(uno.find('.hf-barras').children().length, 1);
  assert.strictEqual(uno.find('.hf-barras').hasClass('hf-uno'), true);
  assert.match(uno.find('.hf-barra').attr('aria-label'), /^5 min\/kg: 1 producto$/);
  assert.match(uno.find('.hf-mediana').attr('style'), /left:50%/);
  assert.strictEqual(uno.find('.hf-fijar').length, 0);
  assert.match(uno.text(), /Todos los productos están en la mediana/);
  const vacio = html(H.htmlDistribucionHf(modelo({ lista: [], mediana: null })));
  assert.strictEqual(vacio.find('.hf-barra').length, 0);
  assert.match(vacio.text(), /Sin productos/);
});

test('panel de distribución: con pocos datos avisa que no se sugiere valor para el subrubro', () => {
  const t = html(H.htmlDistribucionHf(H.modeloDistribucionHf(HIST, '8', 3))).text();
  assert.match(t, /pocos datos/i);
  assert.match(t, /Mediana: 4 min\/kg/);
});

// ── Estado y textos de ayuda ──
test('estado: cargando, error con "Reintentar" (la configuración sigue andando) y ok con "usadas X de Y cargas" y el detalle de descartes', () => {
  const cargando = html(H.htmlEstadoHf({ fase: 'cargando', datos: null, error: null }));
  assert.match(cargando.find('.hf-linea').text(), /Leyendo el historial/);
  const err = html(H.htmlEstadoHf({ fase: 'error', datos: null, error: 'No se pudieron leer los graneles de SIGA' }));
  assert.match(err.find('.hf-linea').text(), /No se pudo leer el historial \(No se pudieron leer los graneles de SIGA\).*sigue andando.*sin sugeridos/);
  assert.strictEqual(err.find('.hf-recargar').text(), 'Reintentar');
  const ok = html(H.htmlEstadoHf({ fase: 'ok', datos: HIST, error: null }));
  assert.match(ok.find('.hf-linea').text(), /usadas 2\.037 de 3\.016 cargas/);
  assert.strictEqual(ok.find('.hf-recargar').text(), 'Actualizar');
  const motivos = ok.find('.hf-desc li').toArray().map(li => ok.find(li).text());
  assert.strictEqual(motivos.length, 5);
  assert.match(motivos[4], /sin peso en el nombre.*654/);
  assert.match(motivos[0], /ACT.*10/);
  const vacio = html(H.htmlEstadoHf({ fase: 'ok', datos: H.normalizarHistorialHf({}), error: null }));
  assert.match(vacio.find('.hf-linea').text(), /todavía no hay cargas/i);
});

test('estado: el error del servidor se escapa y los de red o de formato se dicen en castellano', () => {
  assert.match(H.htmlEstadoHf({ fase: 'error', error: '<img src=x>' }), /&lt;img src=x&gt;/);
  assert.strictEqual(H.mensajeErrorHf(new Error('Sin permiso para la configuración de precios')), 'Sin permiso para la configuración de precios');
  assert.match(H.mensajeErrorHf(new TypeError('Failed to fetch')), /conectar/);
  assert.match(H.mensajeErrorHf(new SyntaxError('Unexpected token <')), /conectar/);
});

test('ayuda: mediana por 1 kg sin el ajuste guardado, "Usar" no guarda, recalcula al guardar tramos y los pedidos no entran', () => {
  const t = html(H.htmlEstadoHf({ fase: 'ok', datos: HIST, error: null })).find('.hf-ayuda').text();
  assert.match(t, /mediana del tiempo por 1 kg/);
  assert.match(t, /ajuste de la tabla de tramos guardada/);
  assert.match(t, /"Usar" completa el campo sin guardar/);
  assert.match(t, /si cambiás la tabla de tramos y la guardás, los sugeridos se recalculan/i);
  assert.match(t, /tramos, subrubros y, al final, pisar productos/);
  assert.match(t, /pedidos/i);
  assert.match(t, /sin peso en el nombre no se puede ubicar el tramo/);
});

// ── Carga y cache ──
const respuesta = (valor, falla) => { globalThis.__respuesta = () => (falla ? Promise.reject(falla) : Promise.resolve(valor)); llamadas.length = 0; H.invalidarHistorialHf(); };

test('cargarHistorialHf: una sola petición para todo el módulo (cache); el estado pasa de cargando a ok', async () => {
  respuesta({ cargas: { total: 4, usadas: 3 }, subrubros: { 1: { n: 9, productos: 2, mediana: 3, p25: 2, p75: 4, pocosDatos: false } } });
  const cambios = [];
  const a = H.cargarHistorialHf(() => cambios.push(H.estadoHistorialHf().fase));
  assert.strictEqual(H.estadoHistorialHf().fase, 'cargando');
  await a;
  await H.cargarHistorialHf(() => cambios.push('2º'));
  await H.cargarHistorialHf();
  assert.strictEqual(llamadas.length, 1);
  assert.deepStrictEqual(llamadas, ['/api/precios/config/esquema/fraccionado/historial']);
  assert.deepStrictEqual(cambios, ['cargando', 'ok', '2º']);
  assert.strictEqual(H.historialHf().subrubros[1].mediana, 3);
});

test('cargarHistorialHf: si falla queda el error (con su mensaje), sin chips, y la próxima vez se reintenta', async () => {
  respuesta(null, new Error('No se pudieron leer los graneles de SIGA'));
  await H.cargarHistorialHf();
  assert.deepStrictEqual([H.estadoHistorialHf().fase, H.estadoHistorialHf().error, H.historialHf()], ['error', 'No se pudieron leer los graneles de SIGA', null]);
  respuesta({});
  await H.cargarHistorialHf();
  assert.strictEqual(H.estadoHistorialHf().fase, 'ok');
});

test('invalidarHistorialHf: tras guardar los tramos se vuelve a pedir y una respuesta vieja que llega tarde no pisa la nueva', async () => {
  const pendientes = [];
  respuesta({});
  globalThis.__respuesta = () => new Promise(res => pendientes.push(res));
  const vieja = H.cargarHistorialHf();
  H.invalidarHistorialHf();
  assert.strictEqual(H.historialHf(), null);
  const nueva = H.cargarHistorialHf();
  assert.strictEqual(llamadas.length, 2);
  pendientes[1]({ subrubros: { 1: { n: 9, productos: 2, mediana: 7, p25: 6, p75: 8, pocosDatos: false } } });
  await nueva;
  pendientes[0]({ subrubros: { 1: { n: 9, productos: 2, mediana: 99, p25: 6, p75: 8, pocosDatos: false } } });
  await vieja;
  assert.strictEqual(H.historialHf().subrubros[1].mediana, 7);
});

// ── "Usar" ──
test('usarEnInputHf: rellena el campo y avisa como si se hubiera tipeado; no pide ni guarda nada', () => {
  respuesta({});
  const eventos = [];
  const input = { value: '', focus() { this.enfocado = true; }, dispatchEvent(e) { eventos.push([e.type, e.bubbles]); } };
  H.usarEnInputHf(input, 8.2);
  assert.strictEqual(input.value, '8.2'); // punto: es un input number
  assert.deepStrictEqual(eventos, [['input', true]]);
  assert.strictEqual(input.enfocado, true);
  H.usarEnInputHf(input, -1.25);
  assert.strictEqual(input.value, '-1.25');
  assert.deepStrictEqual(llamadas, []);
});

// ── DOM de las tarjetas (con elementos de mentira) ──
const clases = () => { const s = new Set(); return { toggle: (c, on) => (on ? s.add(c) : s.delete(c)), contains: c => s.has(c) }; };
const celda = (dataset, extra = {}) => ({ dataset, innerHTML: '', ...extra });

test('pintarSubrubrosHf: sin historial la columna queda oculta y vacía; con historial cada fila trae su chip', async () => {
  respuesta({ subrubros: { 7: { n: 31, productos: 4, mediana: 8.2, p25: 7, p75: 9.5, pocosDatos: false } } });
  const celdas = [celda({ hfSub: '7', hfNombre: 'Frutos' }), celda({ hfSub: '8', hfNombre: 'Harinas' })];
  const card = { classList: clases(), querySelectorAll: () => celdas };
  H.pintarSubrubrosHf(card);
  assert.strictEqual(card.classList.contains('hf-sin'), true);
  assert.deepStrictEqual(celdas.map(c => c.innerHTML), ['', '']);
  await H.cargarHistorialHf();
  H.pintarSubrubrosHf(card);
  assert.strictEqual(card.classList.contains('hf-sin'), false);
  assert.match(celdas[0].innerHTML, /Historial: 8,2 · 31 cargas · 4 productos/);
  assert.strictEqual(celdas[1].innerHTML, ''); // sin entrada: sin chip
  H.pintarSubrubrosHf(null); // el panel se recargó mientras tanto
});

test('pintarTramosHf: cada fila usa su "hasta" actual contra el guardado; el editado sin guardar y la fila nueva quedan sin chip', async () => {
  respuesta({ tramos: [{ hastaG: 100, base: false, n: 5, mediana: 3.1, p25: 2, p75: 4, pocosDatos: false }, { hastaG: 1000, base: true, n: 9, mediana: 0, p25: 0, p75: 0, pocosDatos: false }] });
  await H.cargarHistorialHf();
  const fila = (hasta, guardado) => { const slot = { innerHTML: '' }; return { dataset: guardado === undefined ? {} : { guardado }, slot,
    querySelector: sel => (sel === '[data-k="hastaG"]' ? { value: hasta } : sel === '[data-hf-tramo]' ? slot : null) }; };
  const filas = [fila('100', '100'), fila('150', '100'), fila('500'), fila('1000', '1000')];
  H.pintarTramosHf({ classList: clases(), querySelectorAll: () => filas });
  assert.match(filas[0].slot.innerHTML, /Historial: \+3,1 · 5 productos/);
  assert.deepStrictEqual(filas.slice(1).map(f => f.slot.innerHTML), ['', '', '']); // editado, nueva y base
});

test('conectarSubrubrosHf: "Usar" rellena el input de su fila y avisa que falta guardar; nunca hace una petición', async () => {
  respuesta({ subrubros: { 7: { n: 31, productos: 4, mediana: 8.2, p25: 7, p75: 9.5, pocosDatos: false } } });
  await H.cargarHistorialHf();
  const input = { value: '3', focus() {}, dispatchEvent() { input.disparado = true; } };
  const fila = { querySelector: sel => (sel.includes('input[data-id]') ? input : null) };
  const msg = {};
  const card = { classList: clases(), querySelectorAll: () => [], querySelector: sel => (sel === '.esq-msg' ? msg : null) };
  H.conectarSubrubrosHf(card, {});
  const usar = { dataset: { hfValor: '8.2' }, closest: s => (s === '.hf-usar' ? usar : s === 'tr' ? fila : null) };
  llamadas.length = 0;
  card.onclick({ target: { closest: s => (s === '.hf-usar' ? usar : null) } });
  assert.strictEqual(input.value, '8.2');
  assert.strictEqual(input.disparado, true);
  assert.match(msg.textContent, /falta guardar/);
  assert.deepStrictEqual(llamadas, []);
});

test('Fijar: guarda con lo que pasó el panel, deja el botón en "Fijado" y avisa; si falla avisa y deja reintentar', async () => {
  const msg = { textContent: '', className: '' };
  globalThis.document = { getElementById: id => (id === 'hfDistMsg' ? msg : null) };
  const atributos = {};
  const marcas = [];
  const boton = { dataset: { plu: '103', hfValor: '20', hfNombre: 'Almendra' }, disabled: false, textContent: 'Fijar', setAttribute: (k, v) => { atributos[k] = v; }, classList: { add: c => marcas.push(c) } };
  const pedidos = [];
  await H.fijarDesdeHf(boton, async (plu, minKg) => { pedidos.push([plu, minKg]); });
  assert.deepStrictEqual(pedidos, [['103', 20]]);
  assert.deepStrictEqual([boton.disabled, boton.textContent], [true, '✓ Fijado']);
  assert.match(msg.textContent, /Almendra quedó con 20 min\/kg propio/);
  assert.match(msg.textContent, /por 1 kg/);
  assert.match(atributos['aria-label'], /Fijado/);
  assert.deepStrictEqual(marcas, ['hf-fijado']);
  const mal = { dataset: { plu: '9', hfValor: '3', hfNombre: 'Maní' }, disabled: false, textContent: 'Fijar', setAttribute() {} };
  await H.fijarDesdeHf(mal, async () => { throw new Error('minKg: número de 0 a 600 (min/kg)'); });
  assert.deepStrictEqual([mal.disabled, mal.textContent], [false, 'Fijar']);
  assert.match(msg.textContent, /No se pudo fijar: minKg: número de 0 a 600/);
  assert.match(msg.className, /text-crit/);
  delete globalThis.document;
});

test('el módulo no usa diálogos nativos ni console', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/js/precios_fraccionado_historial.js'), 'utf8');
  assert.doesNotMatch(src, /\b(alert|confirm|prompt)\s*\(|console\./);
  assert.ok(src.split('\n').length < 800);
});
