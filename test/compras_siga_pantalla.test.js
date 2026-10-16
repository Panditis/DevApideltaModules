'use strict';
// Pantalla "Importar a SIGA" (public/compras_siga.html + public/js/compras_siga.js) y su cableado en server.js.
// Chequeos estáticos: server.js NO se requiere (arranca el bootstrap con SQL) y el front no se ejecuta.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const leer = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const HTML = leer('public/compras_siga.html');
const JS = leer('public/js/compras_siga.js');
const SERVER = leer('server.js');

test('compras_siga.js parsea y la pantalla no usa alert/confirm/prompt', () => {
  assert.doesNotThrow(() => new vm.Script(JS, { filename: 'compras_siga.js' }));
  for (const [nombre, src] of [['html', HTML], ['js', JS]]) {
    assert.doesNotMatch(src, /\b(alert|confirm|prompt)\s*\(/, `${nombre} usa un diálogo nativo`);
  }
});

test('cada #id que usa compras_siga.js existe en compras_siga.html', () => {
  const ids = new Set([...JS.matchAll(/'#([A-Za-z][\w-]*)'/g)].map(m => m[1]));
  const faltan = [...ids].filter(id => !HTML.includes(`id="${id}"`));
  assert.ok(ids.size > 20, 'no se encontraron ids en el JS');
  assert.deepStrictEqual(faltan, []);
});

test('importes con type=number y sin innerHTML con datos sin escapar del servidor', () => {
  assert.match(HTML, /id="cDescGral" type="number" step="0\.01"/);
  // Los mensajes del servidor van por textContent/replaceChildren; innerHTML solo con plantillas que pasan por esc().
  assert.doesNotMatch(JS, /innerHTML\s*=\s*[^;]*datos\./, 'innerHTML con la respuesta del servidor');
  assert.doesNotMatch(JS, /innerHTML\s*=\s*[^;`]*\+/, 'innerHTML armado por concatenación');
});

test('server.js sirve /js/compras_siga.js y registra el router con repo de lib/siga_compras/repo', () => {
  assert.match(SERVER, /app\.get\('\/js\/compras_siga\.js', \(_req, res\) => res\.sendFile\(path\.join\(__dirname, 'public', 'js', 'compras_siga\.js'\)\)\);/);
  const registro = /app\.use\(require\('\.\/routes\/rutas_compras_siga'\)\(\{([\s\S]*?)\}\)\);/.exec(SERVER);
  assert.ok(registro, 'falta registrar routes/rutas_compras_siga');
  const deps = registro[1];
  for (const d of ['DATA_DIR', 'leerPedidosCompra', 'usuarioCompras: comprasRouter.usuarioCompras',
    "repo: require('./lib/siga_compras/repo')({ sql, getPool, getPoolStock })"]) {
    assert.ok(deps.includes(d), `falta ${d} en las deps del router`);
  }
  // Va después de que se declaran DATA_DIR (const) y comprasRouter.
  assert.ok(registro.index > SERVER.indexOf('const comprasRouter ='), 'el router se registra antes de comprasRouter');
});

test('compras.html: botón "Importar a SIGA" en el seguimiento, abre /compras/siga?pedido=…', () => {
  const compras = leer('public/compras.html');
  assert.match(compras, /id="btnImportarSiga"/);
  assert.match(compras, /btnImportarSiga: \(\) => \{ location\.href = '\/compras\/siga\?pedido=' \+ encodeURIComponent\(pedidoSel\.numero\); \}/);
  assert.match(compras, /\$\('#btnImportarSiga'\)\.disabled = c\.pedido > 0 \|\| segDirty \|\| pedidoSel\.estado === 'ANULADO'/);
});
