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
  for (const d of ['DATA_DIR', 'leerPedidosCompra', 'guardarPedidosCompra', 'usuarioCompras: comprasRouter.usuarioCompras',
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
    "'Precios tal como los cargás. IVA 0 (comprobante sin libro de IVA).'",
  ]) assert.ok(JS.includes(trozo), `falta en compras_siga.js: ${trozo}`);
});

test('numeración automática: emisor y número habilitados, número propuesto con ayuda y sin tocar viaja vacío', () => {
  assert.doesNotMatch(JS, /\$\(id\)\.disabled = automatico/, 'emisor/número no se deshabilitan en automático');
  assert.match(HTML, /<label class="campo col-span-2">Número<input id="cNumero"[^>]*><span id="ayudaNumero"/);
  assert.ok(JS.includes('`Próximo número libre: ${proximo} (se recalcula al grabar)`'));
  // Sin tocar (igual al propuesto) → null: grabar asigna el siguiente libre con lock.
  assert.ok(JS.includes('numeroComprobante: numero === estado.proximoNumero ? null : numero,'));
});

test('punto de venta: datalist con los CentroEmisor de la sucursal que tienen el tipo habilitado (texto libre)', () => {
  assert.match(HTML, /<input id="cEmisor" type="number" min="1" max="32767" step="1" list="dlPuntosVenta">/);
  assert.match(HTML, /<datalist id="dlPuntosVenta"><\/datalist>/);
  const m = /function puntosVentaDe\([\s\S]*?\n  }\n/.exec(JS);
  assert.ok(m, 'no se encontró puntosVentaDe() en compras_siga.js');
  const puntosVentaDe = vm.runInNewContext(`(${m[0]})`);
  const impresoras = [
    { idSucursal: 1, idImpresora: 'FISCAL1', centroEmisor: 3, comprobantesHabilitados: ['FACTCOM', 'COTIZACIONCOM'] },
    { idSucursal: 1, idImpresora: 'FISCAL2', centroEmisor: 3, comprobantesHabilitados: ['COTIZACIONCOM'] },
    { idSucursal: 1, idImpresora: 'MANUAL', centroEmisor: 7, comprobantesHabilitados: ['COTIZACIONCOM'] },
    { idSucursal: 2, idImpresora: 'OTRA', centroEmisor: 9, comprobantesHabilitados: ['COTIZACIONCOM'] },
  ];
  assert.deepStrictEqual(JSON.parse(JSON.stringify(puntosVentaDe(impresoras, 1, 'COTIZACIONCOM'))), [[3, 'FISCAL1'], [7, 'MANUAL']]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(puntosVentaDe(impresoras, 1, 'FACTCOM'))), [[3, 'FISCAL1']]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(puntosVentaDe(undefined, 1, 'FACTCOM'))), []);
});

test('productos editables: cantidad y precio type=number, ✕ con el modal propio y cuerpo() manda lineas', () => {
  const m = /function pintarLineas\(\) \{[\s\S]*?\n {2}\}\n/.exec(JS);
  assert.ok(m, 'no se encontró pintarLineas() en compras_siga.js');
  const fila = m[0];
  assert.match(fila, /<input type="number" step="any" min="0" data-k="cantidad"/);
  assert.match(fila, /<input type="number" step="0\.01" min="0" data-k="precio"/);
  assert.match(fila, /data-quitar-linea="\$\{i\}"[^>]*>✕</);
  // Todo lo interpolado en el innerHTML de la tabla pasa por esc() (salvo el índice de la fila).
  const sinEscapar = [...fila.matchAll(/\$\{([^}]*)\}/g)].map(x => x[1]).filter(x => !/^esc\(/.test(x) && x !== 'i');
  assert.deepStrictEqual(sinEscapar, []);
  assert.match(JS, /await confirmar\(\{\s*titulo: 'Quitar producto'/);
  assert.match(JS, /lineas: estado\.lineas\.map\(\(\{ plu, cantidad, precio \}\) => \(\{ plu, cantidad, precio \}\)\)/);
  assert.doesNotMatch(JS, /precios/, 'el body ya no manda precios');
  assert.match(JS, /estado\.lineas = datos\.borrador\.lineas\.map\(/);
  assert.ok(JS.includes("'Producto repetido en otra línea'"), 'falta el aviso de PLU repetido');
});

test('agregar producto: botón, buscador con soloCompras=1 y resultados por textContent', () => {
  assert.match(HTML, /<button type="button" id="btnAgregarProducto" class="btn[^"]*">\+ Agregar producto<\/button>/);
  assert.match(HTML, /<input id="buscarProducto" type="search"/);
  assert.match(HTML, /<ul id="resultadosBuscar"/);
  assert.ok(JS.includes('`/api/compras-import/buscar-producto?q=${encodeURIComponent(q)}&soloCompras=1`'));
  const m = /function mostrarResultados\([\s\S]*?\n {2}\}\n/.exec(JS);
  assert.ok(m, 'no se encontró mostrarResultados() en compras_siga.js');
  assert.doesNotMatch(m[0], /innerHTML/, 'los resultados del buscador van por textContent');
  assert.match(JS, /cantidad: 1, precio: p\.costoSistema \?\? null/);
});

test('el permiso del módulo compras cubre el buscador de productos (/api/compras-import)', () => {
  const auth = leer('lib/auth.js');
  assert.match(auth, /ref: 'compras',[^\n]*apiPrefijos: \[[^\]]*'\/api\/compras-import'/);
});

test('mientras graba: tabla, buscador y cabecera quedan deshabilitados y una respuesta vieja no se pinta', () => {
  assert.match(HTML, /<fieldset id="fsEdicion"[^>]*>[\s\S]*id="cTipo"[\s\S]*id="buscarProducto"[\s\S]*id="tLineas"[\s\S]*id="tbPercep"[\s\S]*<\/fieldset>/);
  const m = /async function grabar\(\) \{[\s\S]*?\n {2}\}\n/.exec(JS);
  assert.ok(m, 'no se encontró grabar()');
  assert.ok(m[0].includes("$('#fsEdicion').disabled = true;"), 'grabar no deshabilita la edición');
  assert.ok(m[0].includes("$('#fsEdicion').disabled = estado.grabado;"), 'grabar no rehabilita la edición al terminar');
  assert.ok(m[0].includes('if (yo === estado.secuencia) pintarResultado(datos);'), 'grabar pinta sin chequear la secuencia');
});

test('los avisos "dato" del borrador no quedan fijos: los errores por línea los da /validar', () => {
  assert.ok(JS.includes("datos.borrador.bloqueos.filter(b => b.tipo !== 'dato')"));
});

test('nombre de la fila: el de SIGA; si SIGA no lo tiene (viene el PLU), el del buscador o el pedido; aria-label al día', () => {
  const m = /const nombreAMostrar = ([^\n]*);\n/.exec(JS);
  assert.ok(m, 'no se encontró nombreAMostrar en compras_siga.js');
  const nombreAMostrar = vm.runInNewContext(`(${m[1]})`);
  const l = { plu: '2001', nombre: 'Azúcar del buscador' };
  assert.strictEqual(nombreAMostrar('AZUCAR X 50', l), 'AZUCAR X 50');
  assert.strictEqual(nombreAMostrar('2001', l), 'Azúcar del buscador');
  assert.strictEqual(nombreAMostrar(undefined, l), 'Azúcar del buscador');
  for (const trozo of ["setAttribute('aria-label', `Cantidad de ${nombre}`)", "setAttribute('aria-label', `Precio de ${nombre}`)", "setAttribute('aria-label', `Quitar ${nombre}`)"]) {
    assert.ok(JS.includes(trozo), `falta: ${trozo}`);
  }
});
