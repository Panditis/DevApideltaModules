'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validarLista, limpiarLista, mover, quitar, etiqueta, aFila } = require('../public/js/tickets_responsables.js');

const usuarios = [{ usuario: 'adriel', nombre: 'Adriel' }, { usuario: 'ana', nombre: 'Ana' }];
const par = (usuario, area) => ({ usuario, area, legado: false });

test('etiqueta arma "nombre / área" con el nombre del usuario', () => {
  assert.strictEqual(etiqueta(usuarios, par('adriel', ' Sistema (Soporte) ')), 'Adriel / Sistema (Soporte)');
  assert.strictEqual(etiqueta(usuarios, par('otro', 'X')), 'otro / X'); // usuario fuera de meta: usa el login
  assert.strictEqual(etiqueta(usuarios, par('', 'Mantenimiento')), 'Mantenimiento');
});

test('validarLista acepta pares válidos', () => {
  assert.deepStrictEqual(validarLista([par('adriel', 'Sistema'), par('adriel', 'Soporte'), par('ana', 'Sistema')], usuarios), []);
});

test('validarLista rechaza lista vacía y más de 30 filas', () => {
  assert.strictEqual(validarLista([], usuarios)[0].i, null);
  const muchas = Array.from({ length: 31 }, (_, i) => par('adriel', `A${i}`));
  assert.ok(validarLista(muchas, usuarios).some(e => e.i === null));
  assert.deepStrictEqual(validarLista(muchas.slice(0, 30), usuarios), []);
});

test('validarLista marca usuario faltante, área vacía y área larga', () => {
  const e = validarLista([par('', 'Sistema'), par('ana', '  '), par('ana', 'x'.repeat(81))], usuarios);
  assert.deepStrictEqual(e.map(x => [x.i, x.campo]), [[0, 'usuario'], [1, 'area'], [2, 'area']]);
  assert.deepStrictEqual(validarLista([par('ana', 'x'.repeat(80))], usuarios), []);
});

test('validarLista marca pares repetidos sin distinguir mayúsculas', () => {
  const e = validarLista([par('adriel', 'Sistema'), par('ana', 'Sistema'), par('adriel', ' SISTEMA ')], usuarios);
  assert.deepStrictEqual(e.map(x => x.i), [2]);
  assert.match(e[0].msg, /fila 1/);
});

test('validarLista marca etiquetas repetidas de usuarios distintos con el mismo nombre', () => {
  const dup = [{ usuario: 'a1', nombre: 'Juan' }, { usuario: 'a2', nombre: 'juan' }];
  assert.deepStrictEqual(validarLista([par('a1', 'Taller'), par('a2', 'Taller')], dup).map(x => x.i), [1]);
});

test('fila legada sin usuario pide elegir usuario y conserva la etiqueta vieja como área', () => {
  const f = aFila({ usuario: null, area: 'Mantenimiento', etiqueta: 'Mantenimiento' });
  assert.deepStrictEqual(f, { usuario: '', area: 'Mantenimiento', legado: true });
  const e = validarLista([f], usuarios);
  assert.deepStrictEqual(e.map(x => [x.i, x.campo, x.msg]), [[0, 'usuario', 'Falta elegir usuario.']]);
  assert.deepStrictEqual(validarLista([{ ...f, usuario: 'ana' }], usuarios), []);
});

test('login dado de baja (no está en la lista) queda legado sin usuario y validarLista lo bloquea', () => {
  const f = aFila({ usuario: 'baja', area: 'Taller' }, usuarios);
  assert.deepStrictEqual(f, { usuario: '', area: 'Taller', legado: true });
  assert.deepStrictEqual(validarLista([f], usuarios).map(x => [x.i, x.campo, x.msg]), [[0, 'usuario', 'Falta elegir usuario.']]);
});

test('login se compara sin mayúsculas y se normaliza al de la lista', () => {
  const f = aFila({ usuario: 'ANA', area: 'Taller' }, usuarios);
  assert.deepStrictEqual(f, { usuario: 'ana', area: 'Taller', legado: false });
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

test('limpiarLista deja solo {usuario, area} recortada', () => {
  assert.deepStrictEqual(limpiarLista([{ usuario: 'ana', area: ' X ', legado: true }]), [{ usuario: 'ana', area: 'X' }]);
});
