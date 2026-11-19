'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validarLista, limpiarLista, mover, quitar } = require('../public/js/tickets_responsables.js');

test('validarLista acepta una lista válida', () => {
  assert.deepStrictEqual(validarLista(['Juan', 'Ana']), []);
});

test('validarLista rechaza lista vacía y más de 30 opciones', () => {
  assert.strictEqual(validarLista([])[0].i, null);
  const muchas = Array.from({ length: 31 }, (_, i) => `R${i}`);
  assert.ok(validarLista(muchas).some(e => e.i === null));
  assert.deepStrictEqual(validarLista(muchas.slice(0, 30)), []);
});

test('validarLista marca filas vacías, largas y repetidas (sin distinguir mayúsculas)', () => {
  const e = validarLista(['Juan', '  ', 'x'.repeat(81), ' JUAN ']);
  assert.deepStrictEqual(e.map(x => x.i), [1, 2, 3]);
  assert.deepStrictEqual(validarLista(['x'.repeat(80)]), []);
});

test('mover y quitar no mutan y respetan los bordes', () => {
  const l = ['a', 'b', 'c'];
  assert.deepStrictEqual(mover(l, 1, -1), ['b', 'a', 'c']);
  assert.deepStrictEqual(mover(l, 1, 1), ['a', 'c', 'b']);
  assert.deepStrictEqual(mover(l, 0, -1), ['a', 'b', 'c']);
  assert.deepStrictEqual(mover(l, 2, 1), ['a', 'b', 'c']);
  assert.deepStrictEqual(quitar(l, 1), ['a', 'c']);
  assert.deepStrictEqual(l, ['a', 'b', 'c']);
});

test('limpiarLista recorta espacios', () => {
  assert.deepStrictEqual(limpiarLista([' a ', 'b']), ['a', 'b']);
});
