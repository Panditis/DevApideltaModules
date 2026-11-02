'use strict';
// Planificación › modal de grupo del catálogo: "Mín. unidades para urgente" por presentación
// (public/js/planificacion_catalogo.js). Se carga el script en un vm con un DOM de mentira.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const RUTA = path.join(__dirname, '../public/js/planificacion_catalogo.js');

function cargar() {
  const els = {};
  const el = id => els[id] ||= { id, innerHTML: '', textContent: '', value: '', disabled: false, listeners: {}, classList: { add() {}, remove() {} },
    addEventListener(t, f) { this.listeners[t] = f; } };
  const puts = [];
  const ctx = vm.createContext({
    document: { getElementById: el, querySelector: () => ({ scrollIntoView() {}, focus() {} }) },
    escHtml: s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
    toast() {}, confirmarModalAsync: async () => true, cargarCatalogo() {},
    cfgGetGranelDirecto: () => false, cfgGetVentaPorUnidad: () => false, cfgSet() {}, cfgSetEsMiel() {},
    granelesData: [], mpManualData: [], gruposCfgLocal: {}, gruposCatCache: [],
    guardarGruposCfg: async () => {}, guardarFormulasGrupo: async () => {},
    api: async (m, url, body) => { if (m === 'PUT') puts.push({ url, body }); return []; },
    setTimeout, clearTimeout,
  });
  vm.runInContext(fs.readFileSync(RUTA, 'utf8'), ctx, { filename: RUTA });
  return { run: c => vm.runInContext(c, ctx), el, puts };
}

const ITEMS = [
  { plu: 1, producto: 'Mani 500G', presentacion: '500G', refId: 'r1', productoRef: 'Mani' },
  { plu: 2, producto: 'Mani 500G B', presentacion: '500G', urgenciaMinUnidades: 25, refId: 'r1', productoRef: 'Mani' },
  { plu: 3, producto: 'Mani 1Kg', presentacion: '1KG', refId: 'r1', productoRef: 'Mani' },
  { plu: 4, producto: 'Mani 250G', presentacion: '250G', urgenciaMinUnidades: 0, refId: 'r1', productoRef: 'Mani' },
];

async function abrirYGuardar(t, tocar) {
  t.run(`editarGrupoRef = 'Mani'; editarGrupoRefId = 'r1'; editarGrupoEsNuevo = false; renderModalGrupoBody(${JSON.stringify(ITEMS)})`);
  if (tocar) tocar(t);
  await t.run('guardarGrupo()');
  return JSON.parse(JSON.stringify(t.puts[0].body)); // fuera del vm (mismos prototipos)
}

test('minUrgenciaValido: entero >= 0 o null', () => {
  const t = cargar();
  for (const [v, r] of [['10', 10], [' 0 ', 0], ['', null], ['-1', null], ['2.5', null], ['x', null], [undefined, null], [7, 7]])
    assert.strictEqual(t.run(`minUrgenciaValido(${JSON.stringify(v)})`), r, String(v));
});

test('al abrir el modal carga el valor del primer item con valor (0 incluido) y la tarjeta muestra el input', () => {
  const t = cargar();
  t.run(`renderModalGrupoBody(${JSON.stringify(ITEMS)})`);
  assert.deepStrictEqual(JSON.parse(t.run('JSON.stringify(presModal.map(p => [p.nombre, p.minUrgencia]))')), [['1KG', ''], ['250G', '0'], ['500G', '25']]);
  const html = t.el('editarGrupoBody').innerHTML;
  assert.match(html, /Mín\. unidades para urgente/);
  assert.match(html, /placeholder="10 \(por defecto\)"/);
  assert.match(html, /value="25"/);
});

test('al guardar escribe el valor en TODOS los items de la presentación; vacío no manda el campo', async () => {
  const t = cargar();
  const items = await abrirYGuardar(t);
  const min = plu => items.find(i => i.plu === plu).urgenciaMinUnidades;
  assert.strictEqual(min(1), 25);   // heredado: el item sin valor de la misma presentación
  assert.strictEqual(min(2), 25);
  assert.strictEqual(min(4), 0);    // 0 = sin mínimo, se manda
  assert.ok(!('urgenciaMinUnidades' in items.find(i => i.plu === 3))); // vacío: sin campo
});

test('editar el input actualiza todos los items; vaciarlo o dejarlo inválido borra el campo; item nuevo hereda', async () => {
  const t = cargar();
  let items = await abrirYGuardar(t, tt => tt.el('editarGrupoBody').listeners.input({ target: { classList: { contains: c => c === 'pres-min-urg-input' }, dataset: { i: '2' }, value: '40' } }));
  assert.deepStrictEqual(items.filter(i => i.presentacion === '500G').map(i => i.urgenciaMinUnidades), [40, 40]);

  const t2 = cargar();
  items = await abrirYGuardar(t2, tt => {
    tt.el('editarGrupoBody').listeners.input({ target: { classList: { contains: c => c === 'pres-min-urg-input' }, dataset: { i: '2' }, value: '' } });
    tt.run(`cambiarCodigos(2, cs => [...cs, { plu: 9, producto: 'Nuevo', esMayorista: false }])`);
  });
  assert.ok(items.filter(i => i.presentacion === '500G').every(i => !('urgenciaMinUnidades' in i)));
  assert.strictEqual(items.filter(i => i.presentacion === '500G').length, 3);

  const t3 = cargar();
  items = await abrirYGuardar(t3, tt => tt.run(`cambiarCodigos(2, cs => [...cs, { plu: 9, producto: 'Nuevo', esMayorista: false }])`));
  assert.strictEqual(items.find(i => i.plu === 9).urgenciaMinUnidades, 25); // hereda de la presentación existente
});

test('renombrar o crear presentaciones conserva / inicializa el valor', () => {
  const t = cargar();
  t.run(`renderModalGrupoBody(${JSON.stringify(ITEMS)}); presEditando = 2; confirmarRenombre(2, '500 G')`);
  assert.strictEqual(t.run(`presModal.find(p => p.nombre === '500 G').minUrgencia`), '25');
  t.el('inputNuevaPres').value = '2KG';
  t.run('crearPresentacion()');
  assert.strictEqual(t.run(`presModal.find(p => p.nombre === '2KG').minUrgencia`), '');
});
