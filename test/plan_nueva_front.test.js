'use strict';
const test = require('node:test');
const assert = require('node:assert');
// Script del navegador con export condicional al final (typeof module): se requiere directo, sin DOM.
const f = require('../public/js/plan_nueva_comun.js');

test('esc escapa HTML, comillas incluidas', () => {
  assert.strictEqual(f.esc(`<b a="1">'x'&</b>`), '&lt;b a=&quot;1&quot;&gt;&#39;x&#39;&amp;&lt;/b&gt;');
  assert.strictEqual(f.esc(null), '');
});

test('normalizarTexto quita acentos y mayúsculas', () => {
  assert.strictEqual(f.normalizarTexto('  Maní ÑANDÚ '), 'mani nandu');
});

test('fmtNum: null/undefined → —; números en es-AR', () => {
  assert.strictEqual(f.fmtNum(null), '—');
  assert.strictEqual(f.fmtNum(undefined), '—');
  assert.strictEqual(f.fmtNum(0), '0');
  assert.strictEqual(f.fmtNum(1234.5), '1.234,5');
});

test('duenioPlu: nombre de otra categoría que ya tiene el PLU, ignorando la propia', () => {
  const cats = [{ id: 'a', nombre: 'Almendras', plus: ['1'] }, { id: 'b', nombre: 'Nueces', plus: ['2'] }];
  assert.strictEqual(f.duenioPlu(cats, 1), 'Almendras');
  assert.strictEqual(f.duenioPlu(cats, '1', 'a'), null);
  assert.strictEqual(f.duenioPlu(cats, '9'), null);
});
