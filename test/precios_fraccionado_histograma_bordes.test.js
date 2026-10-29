'use strict';
// Bordes de la bucketización del histograma "Ver distribución" (public/js/precios_fraccionado_historial.js): valores en un borde,
// punto flotante, entradas inválidas, conservación del total, mismos rangos en barras/eje/tabla y cantidad de barras.
const test = require('node:test');
const assert = require('node:assert');
globalThis.esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const H = require('../public/js/precios_fraccionado_historial.js');

const suma = h => h.barras.reduce((s, b) => s + b.n, 0);
const COLA = /\d[.,]\d*(0000|9999)\d/;
const rango = (a, b, paso) => Array.from({ length: Math.round((b - a) / paso) + 1 }, (_, i) => Math.round((a + i * paso) * 100) / 100); // como llegan del servidor: 2 decimales

test('valor justo en un borde va a la barra de la derecha; el máximo del eje queda en la última', () => {
  const h = H.histogramaHf([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);
  assert.strictEqual(h.eje.paso, 0.1);
  assert.deepStrictEqual(h.barras.map(b => b.n), [1, 1, 1, 1, 1, 1, 2]);
  assert.strictEqual(h.barras.at(-1).hasta, 0.7);
});

test('pasos 0,1/0,05/0,01 y rangos grandes: sin colas de punto flotante en barras, marcas, aria ni tabla', () => {
  for (const v of [rango(0, 0.6, 0.1), rango(0.34, 0.6, 0.02), [0.31, 0.33, 0.35, 0.37, 0.38], rango(0, 400, 7.3), rango(0, 53.73, 1.37), [0.3, 0.3, 0.7, 1.1]]) {
    const h = H.histogramaHf(v);
    const html = H.htmlDistribucionHf({ lista: v.map((minKg, i) => ({ plu: String(i), nombre: 'p', n: 1, minKg })), mediana: v[0], actual: v.at(-1), pocosDatos: false, minMuestras: 5 });
    assert.ok(!COLA.test(JSON.stringify(h.barras) + JSON.stringify(H.marcasEjeHf(h)) + html), JSON.stringify(v));
    assert.strictEqual(suma(h), v.length);
  }
});

test('entradas inválidas se ignoran; vacía, un valor, todos iguales, IQR 0', () => {
  assert.deepStrictEqual(H.histogramaHf([]).barras, []);
  assert.strictEqual(suma(H.histogramaHf([NaN, Infinity, -Infinity, null, '3', undefined, 2, 4])), 2);
  const uno = H.histogramaHf([5]);
  assert.ok(uno.uno); assert.strictEqual(uno.barras.length, 1);
  assert.strictEqual(H.histogramaHf([7, 7, 7]).barras[0].n, 3);
  const iqr0 = H.histogramaHf([1, 1, 1, 1, 1, 1, 50]); // IQR 0: no agrupa, todo entra en barras comunes
  assert.strictEqual(H.topeAtipicosHf([1, 1, 1, 1, 1, 1, 50]), null);
  assert.ok(!iqr0.barras.at(-1).mas); assert.strictEqual(suma(iqr0), 7);
  const neg = H.histogramaHf([-2, -1, 0, 1, 2]);
  assert.strictEqual(suma(neg), 5); assert.ok(neg.eje.desde <= -2);
});

test('con barra agrupada: nada se pierde ni se cuenta dos veces, incluido un valor justo en su borde', () => {
  const base = rango(1, 2, 0.1);
  const h0 = H.histogramaHf([...base, 40]);
  assert.ok(h0.barras.at(-1).mas);
  const h = H.histogramaHf([...base, h0.eje.hasta, 40]); // el nuevo valor mueve los cuartiles: el eje puede crecer
  assert.strictEqual(suma(h), base.length + 2);
  assert.ok(h.barras.at(-1).mas); assert.strictEqual(h.barras.at(-1).max, 40);
  const enBorde = H.histogramaHf([...base, 40, 40]); // dos en la agrupada, uno justo en su borde si coincide
  assert.strictEqual(suma(enBorde), base.length + 2); assert.strictEqual(enBorde.barras.at(-1).n, 2);
});

test('barras, marcas del eje y tabla usan los mismos bordes', () => {
  const h = H.histogramaHf([0.4, 0.9, 1.3, 2.2, 2.6, 3.1, 3.3, 30]);
  const bordes = [...h.barras.map(b => b.desde), ...(h.barras.at(-1).mas ? [] : [h.barras.at(-1).hasta])];
  const fmt = x => H.fmtMinHf(x);
  const marcas = H.marcasEjeHf(h).map(m => m.texto.replace('≥ ', ''));
  for (const m of marcas) assert.ok(bordes.some(b => b.toLocaleString('es-AR', { minimumFractionDigits: h.eje.dec, maximumFractionDigits: h.eje.dec }) === m), m);
  for (let i = 1; i < h.barras.length; i++) assert.strictEqual(h.barras[i].desde, h.barras[i - 1].hasta ?? h.barras[i].desde);
  const html = H.htmlDistribucionHf({ lista: [0.4, 0.9, 1.3, 2.2, 2.6, 3.1, 3.3, 30].map((minKg, i) => ({ plu: String(i), n: 1, minKg })), mediana: 2.4, actual: null, pocosDatos: false, minMuestras: 5 });
  for (const b of h.barras) assert.ok(html.includes(b.mas ? `${fmt(b.desde)} o más` : `${fmt(b.desde)} a ${fmt(b.hasta)}`), JSON.stringify(b));
});

test('posición de mediana/actual: dentro, en el borde, fuera y en la agrupada', () => {
  const h = H.histogramaHf(rango(0, 1, 0.1));
  assert.deepStrictEqual(H.posicionHf(h.eje.desde, h), { pct: 0, fuera: false });
  assert.deepStrictEqual(H.posicionHf(h.eje.hasta, h), { pct: 100, fuera: false });
  assert.deepStrictEqual(H.posicionHf(-1, h), { pct: 0, fuera: true });
  assert.deepStrictEqual(H.posicionHf(9, h), { pct: 100, fuera: true });
  const m = H.histogramaHf([...rango(1, 2, 0.1), 40]);
  assert.strictEqual(H.posicionHf(999, m).fuera, false);
});

test('cantidad de barras entre 6 y 12 (salvo un valor) en rangos variados', () => {
  for (const [a, b, p] of [[0, 0.6, 0.1], [0.34, 0.6, 0.02], [0, 400, 3], [0, 53.73, 0.5], [1, 1.07, 0.01], [10, 11, 0.05], [0, 1e5, 999]]) {
    const n = H.histogramaHf(rango(a, b, p)).barras.length;
    assert.ok(n >= 6 && n <= 12, `${a}-${b}: ${n}`);
  }
});
