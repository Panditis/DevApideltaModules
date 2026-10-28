'use strict';
const test = require('node:test');
const assert = require('node:assert');

// public/js/apd-dialogo.js con un DOM mínimo de mentira: createElement, appendChild, eventos,
// showModal/close/remove. innerHTML tira error para asegurar que el mensaje va por textContent.
function nodo(tag) {
  const oyentes = {};
  const n = {
    tag, hijos: [], style: {}, textContent: '', value: '', type: '', abierto: false, enDom: false,
    set innerHTML(_v) { throw new Error('no usar innerHTML'); },
    appendChild(h) { n.hijos.push(h); return h; },
    addEventListener(ev, fn) { (oyentes[ev] ||= []).push(fn); },
    disparar(ev, e = {}) { (oyentes[ev] || []).forEach(fn => fn(e)); },
    focus() { global.document.activo = n; },
    showModal() { n.abierto = true; },
    close() { if (!n.abierto) return; n.abierto = false; n.disparar('close'); },
    remove() { n.enDom = false; },
  };
  return n;
}
global.document = {
  activo: null,
  createElement: nodo,
  body: { hijos: [], appendChild(h) { h.enDom = true; this.hijos.push(h); return h; } },
};
const { apdAvisar, apdConfirmar, apdPedir } = require('../public/js/apd-dialogo.js');

const ultimo = () => document.body.hijos[document.body.hijos.length - 1];
const todos = (n, tag) => [n, ...n.hijos.flatMap(h => todos(h, tag))].filter(x => x.tag === tag);
const boton = (d, texto) => todos(d, 'button').find(b => b.textContent === texto);

test('apdConfirmar: Aceptar → true; Cancelar → false; el mensaje va por textContent y el dialog se borra', async () => {
  const p = apdConfirmar('¿Borrar <b>todo</b>?\nNo vuelve.', { titulo: 'Borrar', aceptar: 'Borrar', peligro: true });
  const d = ultimo();
  assert.strictEqual(d.tag, 'dialog');
  assert.ok(d.abierto);
  assert.strictEqual(todos(d, 'p')[0].textContent, '¿Borrar <b>todo</b>?\nNo vuelve.');
  assert.strictEqual(document.activo, boton(d, 'Borrar'));
  boton(d, 'Borrar').disparar('click');
  assert.strictEqual(await p, true);
  assert.strictEqual(d.enDom, false);

  const p2 = apdConfirmar('¿Seguro?');
  boton(ultimo(), 'Cancelar').disparar('click');
  assert.strictEqual(await p2, false);

  const p3 = apdConfirmar('¿Seguro?');
  ultimo().close(); // Esc: el dialog nativo cierra sin pasar por los botones
  assert.strictEqual(await p3, false);
});

test('apdPedir: Aceptar/Enter → valor escrito; Cancelar/Esc → null; tipo password', async () => {
  const p = apdPedir('Nueva contraseña:', '', { tipo: 'password' });
  const input = todos(ultimo(), 'input')[0];
  assert.strictEqual(input.type, 'password');
  assert.strictEqual(document.activo, input);
  input.value = 'secreta';
  input.disparar('keydown', { key: 'Enter', preventDefault() {} });
  assert.strictEqual(await p, 'secreta');

  const p2 = apdPedir('URL:', 'https://');
  assert.strictEqual(todos(ultimo(), 'input')[0].value, 'https://');
  boton(ultimo(), 'Aceptar').disparar('click');
  assert.strictEqual(await p2, 'https://');

  const p3 = apdPedir('URL:', 'x');
  boton(ultimo(), 'Cancelar').disparar('click');
  assert.strictEqual(await p3, null);

  const p4 = apdPedir('URL:', 'x');
  ultimo().close();
  assert.strictEqual(await p4, null);
});

test('apdAvisar: un solo botón, resuelve undefined al cerrar', async () => {
  const p = apdAvisar('No hay carteles seleccionados.');
  assert.deepStrictEqual(todos(ultimo(), 'button').map(b => b.textContent), ['Aceptar']);
  boton(ultimo(), 'Aceptar').disparar('click');
  assert.strictEqual(await p, undefined);
});
