'use strict';
// Helpers puros de exportar/marcar presentaciones de Producción y de la tab Máquinas
// (public/js/precios_produccion_export.js, public/js/precios_maquinas.js): scripts de browser que sin
// `document` sólo exportan sus helpers.
const test = require('node:test');
const assert = require('node:assert');
const ex = require('../public/js/precios_produccion_export.js');
const maq = require('../public/js/precios_maquinas.js');

const pres = (plu, extra = {}) => ({ plu, nombre: `P${plu}`, costoTotal: 480, precioConIva: 850, faltantes: [], ivaPct: 21, marcado: false, ...extra });
const LISTA = [
  { id: 'p-granola', exportables: [pres('6319', { marcado: true }), pres('6320', { faltantes: ['markupPct'], precioConIva: null, marcado: true })] },
  { id: 'p-pepas', exportables: [pres('8104')] },
  { id: 'p-viejo' }, // fila sin exportables (server viejo): no rompe
];

test('esMarcableProd: PLU de SIGA, sin faltantes y con precio', () => {
  assert.strictEqual(ex.esMarcableProd(pres('6319')), true);
  assert.strictEqual(ex.esMarcableProd(pres('n-granola-800')), false);
  assert.strictEqual(ex.esMarcableProd(pres('6319', { faltantes: ['6334'] })), false);
  assert.strictEqual(ex.esMarcableProd(pres('6319', { precioConIva: null })), false);
});

test('marcadasProd: las marcadas de todos los productos, con las columnas de exportación', () => {
  assert.deepStrictEqual(ex.marcadasProd(LISTA).map(p => p.plu), ['6319', '6320']);
  assert.deepStrictEqual(ex.marcadasProd(LISTA)[0], { plu: '6319', nombre: 'P6319', costoTotal: 480, precioConIva: 850, faltantes: [], ivaPct: 21 });
  assert.deepStrictEqual(ex.marcadasProd(null), []);
});

test('aplicarMarcadosProd: marca según el set de PLUs sin mutar la lista', () => {
  const nueva = ex.aplicarMarcadosProd(LISTA, new Set(['8104']));
  assert.deepStrictEqual(nueva.flatMap(f => (f.exportables || []).filter(p => p.marcado).map(p => p.plu)), ['8104']);
  assert.strictEqual(LISTA[0].exportables[0].marcado, true);
  assert.strictEqual(nueva[2], LISTA[2]);
});

test('unicosPorPlu: un PLU aparece una sola vez; gana la última fuente (Producción va al final)', () => {
  const r = ex.unicosPorPlu([{ plu: '1', nombre: 'almacen' }, { plu: '2', nombre: 'b' }, { plu: '1', nombre: 'produccion' }]);
  assert.deepStrictEqual(r, [{ plu: '1', nombre: 'produccion' }, { plu: '2', nombre: 'b' }]);
});

test('plusMarcarTodas: marcables de un producto; si ya están todas marcadas, el mismo set (para desmarcar)', () => {
  const det = { a: pres('1', { marcado: true }), b: pres('2'), c: pres('n-x'), d: pres('3', { faltantes: ['x'] }) };
  assert.deepStrictEqual(ex.plusMarcarTodas(det), { plus: ['1', '2'], marcado: true });
  assert.deepStrictEqual(ex.plusMarcarTodas({ a: pres('1', { marcado: true }) }), { plus: ['1'], marcado: false });
  assert.deepStrictEqual(ex.plusMarcarTodas({ c: pres('n-x') }), { plus: [], marcado: true });
});

test('textoUsosCategoria: productos con sus recetas; vacío → sin uso', () => {
  assert.strictEqual(maq.textoUsosCategoria([{ id: 'p-g', nombre: 'Granola', recetas: ['Base', 'Con miel'] }, { id: 'p-p', nombre: 'Pepas', recetas: ['Masa'] }]),
    'Granola (Base, Con miel) · Pepas (Masa)');
  assert.strictEqual(maq.textoUsosCategoria([]), '');
});

test('listaParaGuardar: sólo { id, nombre, costoHora } (sin usos) y reemplazo/quita por id sin mutar', () => {
  const cats = [{ id: 'horno', nombre: 'Horno', costoHora: 5000, usos: [] }, { id: 'mez', nombre: 'Mez', costoHora: 1, usos: [] }];
  assert.deepStrictEqual(maq.listaParaGuardar(cats), [{ id: 'horno', nombre: 'Horno', costoHora: 5000 }, { id: 'mez', nombre: 'Mez', costoHora: 1 }]);
  assert.deepStrictEqual(maq.conCambio(cats, 'horno', { costoHora: 6000 })[0], { id: 'horno', nombre: 'Horno', costoHora: 6000, usos: [] });
  assert.deepStrictEqual(maq.sinCategoria(cats, 'horno').map(c => c.id), ['mez']);
  assert.strictEqual(cats[0].costoHora, 5000);
});
