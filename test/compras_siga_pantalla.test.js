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

test('esc() escapa & < > " y la comilla simple', () => {
  const m = /const esc = (s => [^\n]*);\n/.exec(JS);
  assert.ok(m, 'no se encontró esc() en compras_siga.js');
  const esc = vm.runInNewContext(`(${m[1]})`);
  assert.strictEqual(esc(`<a href='x' title="y">&</a>`), '&lt;a href=&#39;x&#39; title=&quot;y&quot;&gt;&amp;&lt;/a&gt;');
  assert.strictEqual(esc(null), '');
});

test('si se corta la red al grabar, Grabar queda trabado hasta recargar (sin reintento)', () => {
  assert.match(JS, /estado\.incierto = true;/);
  assert.match(JS, /\$\('#btnGrabar'\)\.disabled = [^;]*estado\.incierto/);
  assert.match(JS, /No se sabe si se grabó: revisá en SiGA antes de reintentar y recargá la página\./);
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
    "repo: require('./lib/siga_compras/repo')({ sql, getPool, getPoolStock })",
    "grabacionHabilitada: process.env.COMPRAS_SIGA_GRABAR === '1'"]) {
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

test('grabación deshabilitada en el servidor: Grabar queda trabado y se avisa que es vista previa', () => {
  for (const trozo of [
    'estado.grabacionHabilitada = datos.grabacionHabilitada === true;',
    "$('#btnGrabar').disabled = !estado.grabacionHabilitada ||",
    "$('#avisoVistaPrevia').style.display = estado.grabacionHabilitada ? 'none' : '';",
  ]) assert.ok(JS.includes(trozo), `falta en compras_siga.js: ${trozo}`);
  assert.match(HTML, /id="avisoVistaPrevia"[^>]*>Vista previa: la grabación en SIGA está deshabilitada en este servidor\.</);
});

test('nota de precios: A sin IVA, B/C con IVA y comprobante sin impuestos sin hablar de letra', () => {
  for (const trozo of [
    "'Precios SIN IVA: letra A, proveedor y empresa discriminan IVA.'",
    "r.incluyeIVA ? 'Precios CON IVA incluido: letra B/C, no se discrimina IVA.'",
    "'Precios tal como los cargás (comprobante sin discriminación de IVA).'",
  ]) assert.ok(JS.includes(trozo), `falta en compras_siga.js: ${trozo}`);
});
