'use strict';
// Card "Precio fijo" (quinta del selector de costo de Reventa) sobre el DOM mínimo con los scripts del front cargados como en el navegador.
// ponytail: crearContexto/abrir copian los de precios_modal_fraccionado_dom.test.js (lo edita otra rama); unificar en un helper al integrar.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const L = require('../lib/precios_listado_esquema');
const { CFG } = require('./precios_esquema_fixture');

const clases = ini => {
  const s = new Set(ini);
  return { add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c), toggle: (c, on = !s.has(c)) => { if (on) s.add(c); else s.delete(c); return on; } };
};
function crearContexto() {
  const elementos = new Map();
  const el = id => {
    if (!elementos.has(id)) {
      elementos.set(id, { id, innerHTML: '', textContent: '', value: '', options: [], hidden: false, open: false,
        classList: clases(id === 'mDetCaja' ? ['max-w-2xl'] : id === 'mDet' || id === 'mDetDer' ? ['hidden'] : []),
        focus() {}, setAttribute() {}, removeAttribute() {}, addEventListener() {}, scrollIntoView() {}, insertAdjacentHTML() {},
        querySelector: () => el(`${id}>*`), querySelectorAll: () => [] });
    }
    return elementos.get(id);
  };
  const FIJOS = ['mDet', 'mDetPar', 'mDetCaja', 'mDetTitulo', 'mDetSub', 'mDetBody', 'mDetX', 'mDetDer', 'mDetDerTitulo', 'mDetDerSub', 'mDetDerBody'];
  const cuerpo = () => el('mDetBody').innerHTML;
  const ids = () => [...(cuerpo() + el('mDetDerBody').innerHTML).matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  const document = {
    activeElement: null, contains: () => true,
    getElementById: id => (FIJOS.includes(id) || ids().includes(id) ? el(id) : null),
    querySelector: sel => { const m = /^#mDetBody \.([\w-]+)$/.exec(sel); return m && cuerpo().includes(`class="${m[1]}`) ? el(`.${m[1]}`) : null; },
    querySelectorAll: () => [],
  };
  const llamadas = [];
  const ctx = vm.createContext({
    document, CSS: { escape: s => s }, console, Intl,
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    campoU: input => input,
    guardarDecision: (...a) => { llamadas.push(['guardarDecision', ...a]); return Promise.resolve(null); },
    renderListado() {}, cargarListado() {}, refrescarAlertasProduccion() {}, salirDeProduccion() {}, activarTab() {},
    guardarTipoProveedor: () => Promise.resolve(),
  });
  ctx.self = ctx;
  for (const f of ['../../lib/precios_esquema.js', 'precios_comun.js', 'precios_modal_esquema.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js', f), 'utf8'), ctx, { filename: path.basename(f) });
  }
  return { ctx, el, ids, cuerpo, correr: src => vm.runInContext(src, ctx), llamadas };
}
const abrir = (dom, tipo, fila, { sinConfig = false } = {}) => {
  dom.ctx.__fila = fila;
  dom.correr(`preciosSinConfig = ${sinConfig}; mdEsq = { tipo: ${JSON.stringify(tipo)}, fila: __fila }; mdFuente = 'sistema'; mdDetalle = false; mdMpModo = 'fijo';`);
  dom.correr('pintarModalEsquema()');
};

const VINCULO_BULTO = [{ plu: '50', nombre: 'Arroz Bulto x6', basePlu: '1', cantidad: 6, tipo: 'bulto' }];
const reventa = (precioFijo, { conDesglose = true, extra = {}, vinculos = [], vigentes = new Map(), costeo = {} } = {}) => L.filaPublica(L.listadoReventa({
  universo: [{ plu: '1', nombre: 'Arroz', costoSistema: 1000, ...extra }], vigentes, mayoristasDe: L.crearMayoristasDe({ vinculos, vigentes }),
  costeo: { ...(precioFijo ? { precioFijo: { 1: precioFijo } } : {}), ...costeo }, cfg: CFG })[0], conDesglose);
const tarjetas = html => [...html.matchAll(/<input type="radio" name="mdCosto" value="([^"]*)"/g)].map(m => m[1]);
const canalesCampo = html => [...html.matchAll(/id="mdPf-(\w+)"/g)].map(m => m[1]);
const repetidos = ids => ids.filter((id, i) => ids.indexOf(id) !== i);

test('Reventa: "Precio fijo" es la quinta card, con un campo por canal con vínculo y Usar; sin precio guardado no hay Quitar y la card queda sin elegir', () => {
  const dom = crearContexto();
  abrir(dom, 'almacen', reventa(null));
  const html = dom.cuerpo();
  assert.deepStrictEqual(tarjetas(html), ['', 'sistema', 'ultimaCompra', 'manual', 'precio']);
  assert.match(html, /id="mdCostos" class="md-opcs" style="--n:5"/);
  assert.deepStrictEqual(canalesCampo(html), ['minorista']); // sin pack/bulto vinculados
  assert.match(html, /id="mdPfUsar"/);
  assert.doesNotMatch(html, /id="mdPfQuitar"/);
  assert.match(html, /Sin precio fijo/);
  assert.deepStrictEqual(repetidos(dom.ids()), []);
});

test('Reventa con precio fijo y bulto vinculado: campos con lo guardado, Quitar, precio nuevo y margen con el costo de referencia (con permiso)', () => {
  const dom = crearContexto();
  abrir(dom, 'almacen', reventa({ minorista: 3999, bulto: 2000 }, { vinculos: VINCULO_BULTO, vigentes: new Map([['1', 1800], ['50', 1430]]) }));
  const html = dom.cuerpo();
  assert.deepStrictEqual(canalesCampo(html), ['minorista', 'bulto']);
  assert.match(html, /id="mdPf-minorista"[^>]*value="3999"/);
  assert.match(html, /id="mdPf-bulto"[^>]*value="2000"/);
  assert.match(html, /id="mdPfQuitar"/);
  assert.match(html, /Precio nuevo<\/div><div class="md-opc-precio">\$ 3\.999/);
  assert.match(html, /Margen <b class="tabular-nums">186,14 %<\/b> <span class="md-sub">con costo sistema<\/span>/);
  assert.deepStrictEqual(repetidos(dom.ids()), []);
});

test('Reventa sin precios-config: la card muestra el precio fijo y el precio nuevo, sin margen (ni en la card ni al tipear)', () => {
  const dom = crearContexto();
  abrir(dom, 'almacen', reventa({ minorista: 3999 }, { conDesglose: false }), { sinConfig: true });
  const html = dom.cuerpo();
  assert.match(html, /id="mdPf-minorista"[^>]*value="3999"/);
  assert.match(html, /\$ 3\.999/);
  assert.doesNotMatch(html, /Margen <b|mdPfMargen-|186,14/);
  // pintarModalEsquema ya conectó la card (conectarPrecioFijoMd): no tira sin los spans de margen; tipear no pinta nada.
  dom.el('mdPf-minorista').value = '1830';
  dom.el('mdPf-minorista').oninput();
  assert.strictEqual(dom.el('mdPfMargen-minorista').textContent, '');
});

test('Reventa sin ningún costo: "Usar" queda deshabilitado con su motivo', () => {
  const dom = crearContexto();
  abrir(dom, 'almacen', reventa({ minorista: 3999 }, { extra: { costoSistema: null } }));
  assert.match(dom.cuerpo(), /id="mdPfUsar" class="cfg-btn2" disabled title="Sin costo cargado/);
});

test('Producción y Fraccionado no tienen la card Precio fijo (sus tarjetas no cambian)', () => {
  const dom = crearContexto();
  abrir(dom, 'produccion', reventa({ minorista: 3999 }));
  assert.deepStrictEqual(tarjetas(dom.cuerpo()), ['', 'sistema']);
  assert.doesNotMatch(dom.cuerpo(), /mdPf|Precio fijo/);
});

test('Card Precio fijo: "Usar" guarda el precio fijo y elige la decisión "precio"; vacío avisa sin pedir; "Quitar" borra sin decidir', async () => {
  const dom = crearContexto();
  const pedidos = [];
  // pedirJson es un const de precios_comun.js (no se puede pisar desde afuera): se simula el fetch que usa.
  dom.ctx.fetch = (url, opc) => { pedidos.push([opc.method, url, JSON.parse(opc.body)]); return Promise.resolve({ json: () => Promise.resolve({}) }); };
  dom.correr('abrirModalEsquema = () => Promise.resolve()'); // la recarga del modal no es lo que se prueba
  abrir(dom, 'almacen', reventa({ minorista: 3999 })); // pintarModalEsquema conecta la card (conectarPrecioFijoMd)
  dom.el('mdPf-minorista').value = '4100';
  await dom.el('mdPfUsar').onclick();
  assert.deepStrictEqual(pedidos, [['PUT', '/api/precios/precio-fijo/1', { minorista: 4100, pack: null, bulto: null }]]);
  assert.deepStrictEqual(dom.llamadas, [['guardarDecision', '1', 'precio']]);
  pedidos.length = 0; dom.llamadas.length = 0;
  dom.el('mdPf-minorista').value = '';
  await dom.el('mdPfUsar').onclick();
  assert.deepStrictEqual([pedidos.length, dom.llamadas.length], [0, 0]);
  assert.match(dom.el('mdDecMsg').innerHTML, /al menos un precio/);
  await dom.el('mdPfQuitar').onclick();
  assert.deepStrictEqual(pedidos, [['PUT', '/api/precios/precio-fijo/1', { minorista: null, pack: null, bulto: null }]]);
  assert.deepStrictEqual(dom.llamadas, []); // quitar no decide
});

test('Card Precio fijo: un error del server no elige la decisión y se muestra debajo de las tarjetas', async () => {
  const dom = crearContexto();
  dom.ctx.fetch = () => Promise.resolve({ json: () => Promise.resolve({ error: 'precioFijo.minorista: El precio debe ser mayor a 0 y tener hasta 2 decimales' }) });
  dom.correr('abrirModalEsquema = () => Promise.resolve()');
  abrir(dom, 'almacen', reventa(null));
  dom.el('mdPf-minorista').value = '0';
  await dom.el('mdPfUsar').onclick();
  assert.deepStrictEqual(dom.llamadas, []);
  assert.match(dom.el('mdDecMsg').innerHTML, /El precio debe ser mayor a 0/);
});

test('Card Precio fijo: el margen se recalcula al tipear con el costo de referencia, igual que el motor', () => {
  const dom = crearContexto();
  abrir(dom, 'almacen', reventa(null));
  assert.strictEqual(dom.el('mdPfMargen-minorista').textContent, ''); // sin precio: sin margen
  dom.el('mdPf-minorista').value = '1830';
  dom.el('mdPf-minorista').oninput();
  const esperado = reventa({ minorista: 1830 }).sugeridos.precio.desglose.minorista.margenPct;
  assert.strictEqual(dom.el('mdPfMargen-minorista').textContent, dom.correr(`'Margen ' + pctMd(${esperado})`));
});

test('Teclado: las flechas sólo saltan entre radios; dentro de un campo de precio fijo no cambian de tarjeta', () => {
  const dom = crearContexto();
  abrir(dom, 'almacen', reventa({ minorista: 3999 }));
  const foco = [];
  const radio = v => ({ value: v, checked: false, focus() { foco.push(v); }, click() {} });
  const radios = [radio('sistema'), radio('precio')];
  const campo = dom.el('mdPf-minorista');
  // DOM mínimo: el grupo responde como el navegador al selector (con el viejo 'input:not(:disabled)' el campo entraba en la lista).
  dom.el('mdCostos').querySelectorAll = sel => (sel.includes('[type="radio"]') ? radios : [radios[0], campo, radios[1]]);
  const tecla = (key, activo) => { dom.ctx.document.activeElement = activo; dom.el('mdCostos').onkeydown({ key, preventDefault() {} }); };
  tecla('ArrowRight', campo);
  assert.deepStrictEqual(foco, []); // la flecha mueve el cursor del campo, no el foco
  tecla('ArrowRight', radios[0]);
  assert.deepStrictEqual(foco, ['precio']);
});
