'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validar, formatoTamano, esImagen } = require('../public/js/tickets_adjuntos.js');

const f = (name, size = 10) => ({ name, size });

test('formatoTamano: B, KB y MB con coma decimal', () => {
  assert.strictEqual(formatoTamano(500), '500 B');
  assert.strictEqual(formatoTamano(2048), '2 KB');
  assert.strictEqual(formatoTamano(1536 * 1024), '1,5 MB');
});

test('esImagen distingue por extensión sin importar mayúsculas', () => {
  assert.strictEqual(esImagen('a.PNG'), true);
  assert.strictEqual(esImagen('a.pdf'), false);
  assert.strictEqual(esImagen('sin_extension'), false);
});

test('validar: acepta la lista blanca y rechaza tipo, vacío y pesado con un mensaje por archivo', () => {
  const r = validar([f('a.PNG'), f('b.exe'), f('c.pdf', 0), f('d.pdf', 11 * 1024 * 1024), f('e.xlsx')]);
  assert.deepStrictEqual(r.validos.map(x => x.name), ['a.PNG', 'e.xlsx']);
  assert.strictEqual(r.errores.length, 3);
  assert.match(r.errores[0], /b\.exe/);
  assert.match(r.errores[1], /c\.pdf.*vacío/);
  assert.match(r.errores[2], /d\.pdf.*10 MB/);
});

test('validar respeta el máximo de 5 entre los ya elegidos y los nuevos', () => {
  const r = validar([f('x.png'), f('y.png')], [f('1.png'), f('2.png'), f('3.png'), f('4.png')]);
  assert.deepStrictEqual(r.validos.map(x => x.name), ['x.png']);
  assert.match(r.errores[0], /Máximo 5/);
});
