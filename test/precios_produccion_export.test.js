'use strict';
// Helpers puros de exportar/marcar presentaciones de Producción
// (public/js/precios_produccion_export.js): script de browser que sin
// `document` sólo exportan sus helpers.
const test = require('node:test');
const assert = require('node:assert');
const ex = require('../public/js/precios_produccion_export.js');

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

test('filasPlanasProd: todas las presentaciones con su producto; busca por presentación/producto/PLU; "a revisar" = subir/bajar', () => {
  const lista = [
    { id: 'p-granola', nombre: 'Granola', exportables: [pres('6319', { semaforo: 'ok', deltaPct: 1 }), pres('6320', { nombre: 'Granola Ñandú', semaforo: 'subir', deltaPct: -3 })] },
    { id: 'p-pepas', nombre: 'Pepas', exportables: [pres('8104', { semaforo: 'bajar', deltaPct: 12 }), pres('8105', { deltaPct: null })] },
    { id: 'p-viejo', nombre: 'Viejo' },
  ];
  const todas = ex.filasPlanasProd(lista);
  // Sin orden elegido: diferencia absoluta desc, sin diferencia al final.
  assert.deepStrictEqual(todas.map(f => f.plu), ['8104', '6320', '6319', '8105']);
  assert.deepStrictEqual([todas[0].productoId, todas[0].producto], ['p-pepas', 'Pepas']);
  assert.deepStrictEqual(ex.filasPlanasProd(lista, { q: 'nandu' }).map(f => f.plu), ['6320']);
  assert.deepStrictEqual(ex.filasPlanasProd(lista, { q: 'PEPAS' }).map(f => f.plu), ['8104', '8105']);
  assert.deepStrictEqual(ex.filasPlanasProd(lista, { q: '631' }).map(f => f.plu), ['6319']);
  assert.deepStrictEqual(ex.filasPlanasProd(lista, { soloRevisar: true }).map(f => f.plu), ['8104', '6320']);
  assert.deepStrictEqual(ex.filasPlanasProd(null), []);
  assert.strictEqual(lista[0].exportables[0].producto, undefined); // sin mutar
});
