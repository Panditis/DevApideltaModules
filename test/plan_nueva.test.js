'use strict';
const test = require('node:test');
const assert = require('node:assert');
const pn = require('../lib/plan_nueva');

// ── Catálogo ────────────────────────────────────────────────────────────────────────────────
const CATS = [{ id: 'a', nombre: 'Almendras', plus: ['100', '101'], creado: '2026-10-01T00:00:00.000Z' }];
const CTX = { id: 'b', ahora: '2026-10-22T10:00:00.000Z' };
const es = status => e => e.status === status;

test('normalizar quita acentos, mayúsculas y espacios de los bordes', () => {
  assert.strictEqual(pn.normalizar('  Maní CROCANTE '), 'mani crocante');
  assert.strictEqual(pn.normalizar(null), '');
});

test('esPlu sólo acepta dígitos', () => {
  assert.strictEqual(pn.esPlu('2183'), true);
  assert.strictEqual(pn.esPlu(2183), true);
  assert.strictEqual(pn.esPlu('12a'), false);
  assert.strictEqual(pn.esPlu(''), false);
});

test('agregarCategoria: nombre recortado, PLU como texto sin repetir, lista nueva sin mutar', () => {
  const r = pn.agregarCategoria(CATS, { nombre: ' Nueces ', plus: ['200', 200, ' 201 '] }, CTX);
  assert.deepStrictEqual(r.categoria, { id: 'b', nombre: 'Nueces', plus: ['200', '201'], creado: CTX.ahora });
  assert.strictEqual(r.categorias.length, 2);
  assert.strictEqual(CATS.length, 1);
});

test('agregarCategoria: se permite una categoría sin presentaciones', () => {
  assert.deepStrictEqual(pn.agregarCategoria(CATS, { nombre: 'Pasas', plus: [] }, CTX).categoria.plus, []);
});

test('agregarCategoria: nombre vacío → 400', () => {
  assert.throws(() => pn.agregarCategoria(CATS, { nombre: '   ', plus: [] }, CTX), e => e.status === 400 && /vacío/.test(e.message));
  assert.throws(() => pn.agregarCategoria(CATS, undefined, CTX), es(400));
});

test('agregarCategoria: nombre repetido sin mayúsculas/acentos → 409', () => {
  assert.throws(() => pn.agregarCategoria([{ ...CATS[0], nombre: 'Maní' }], { nombre: 'MANI', plus: [] }, CTX), es(409));
});

test('agregarCategoria: plus que no es lista o PLU no numérico → 400', () => {
  assert.throws(() => pn.agregarCategoria(CATS, { nombre: 'Nueces', plus: '200' }, CTX), es(400));
  assert.throws(() => pn.agregarCategoria(CATS, { nombre: 'Nueces', plus: ['12a'] }, CTX), es(400));
  assert.throws(() => pn.agregarCategoria(CATS, { nombre: 'Nueces', plus: [''] }, CTX), es(400));
});

test('agregarCategoria: PLU que ya está en otra categoría → 409 con su nombre', () => {
  assert.throws(() => pn.agregarCategoria(CATS, { nombre: 'Nueces', plus: ['101'] }, CTX), e => e.status === 409 && /Almendras/.test(e.message));
});

test('editarCategoria: renombra (puede repetir su propio nombre) y cambia PLU sin mutar', () => {
  const r = pn.editarCategoria(CATS, 'a', { nombre: 'ALMENDRAS', plus: ['101', '102'] });
  assert.deepStrictEqual(r.categoria, { id: 'a', nombre: 'ALMENDRAS', plus: ['101', '102'], creado: CATS[0].creado });
  assert.deepStrictEqual(r.categorias, [r.categoria]);
  assert.deepStrictEqual(CATS[0].plus, ['100', '101']);
});

test('editarCategoria: id inexistente → 404', () => {
  assert.throws(() => pn.editarCategoria(CATS, 'zz', { nombre: 'X', plus: [] }), es(404));
});

test('borrarCategoria: devuelve la lista sin ella; inexistente → 404', () => {
  assert.deepStrictEqual(pn.borrarCategoria(CATS, 'a'), []);
  assert.strictEqual(CATS.length, 1);
  assert.throws(() => pn.borrarCategoria(CATS, 'zz'), es(404));
});
