'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Cada getElementById('x') de public/js/plan_nueva_*.js tiene su id="x" en planificacion_nueva.html, y cada
// <script src="/js/plan_nueva_*.js"> existe en disco y está en la whitelist de server.js (no hay express.static).
const RAIZ = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(RAIZ, 'public', 'planificacion_nueva.html'), 'utf8');
const JS_DIR = path.join(RAIZ, 'public', 'js');
const SCRIPTS = fs.readdirSync(JS_DIR).filter(f => /^plan_nueva_.*\.js$/.test(f));

test('los ids que usan los scripts existen en el HTML', () => {
  const faltan = [];
  for (const archivo of SCRIPTS) {
    const src = fs.readFileSync(path.join(JS_DIR, archivo), 'utf8');
    for (const [, id] of src.matchAll(/getElementById\('([^']+)'\)/g)) {
      if (!HTML.includes(`id="${id}"`)) faltan.push(`${archivo}: ${id}`);
    }
  }
  assert.deepStrictEqual(faltan, []);
});

test('cada script del HTML existe y está en la whitelist de server.js', () => {
  const server = fs.readFileSync(path.join(RAIZ, 'server.js'), 'utf8');
  const lista = (server.match(/for \(const n of \[([^\]]*)\]\) \{\n {2}app\.get\(`\/js\/plan_nueva_/) || [])[1] || '';
  const usados = [...HTML.matchAll(/<script src="\/js\/plan_nueva_(\w+)\.js"><\/script>/g)].map(m => m[1]);
  assert.ok(usados.length > 0, 'el HTML no carga ningún plan_nueva_*.js');
  for (const n of usados) {
    assert.ok(SCRIPTS.includes(`plan_nueva_${n}.js`), `falta public/js/plan_nueva_${n}.js`);
    assert.ok(lista.includes(`'${n}'`), `falta '${n}' en la whitelist de server.js`);
  }
});
