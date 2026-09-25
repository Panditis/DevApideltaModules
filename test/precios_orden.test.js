'use strict';
// Orden de tablas de Precios (public/precios_orden.js): helpers puros, sin DOM.
const test = require('node:test');
const assert = require('node:assert');
const o = require('../public/precios_orden.js');

const plus = filas => filas.map(f => f.plu);

test('ordenarFilas con extractor: Δ% negativos como número, null al final en asc y desc', () => {
  const filas = [{ plu: 'a', d: -5 }, { plu: 'b', d: null }, { plu: 'c', d: 12.5 }, { plu: 'd', d: -20 }];
  const ext = (f) => f.d;
  assert.deepStrictEqual(plus(o.ordenarFilas(filas, 'delta', 'asc', ext)), ['d', 'a', 'c', 'b']);
  assert.deepStrictEqual(plus(o.ordenarFilas(filas, 'delta', 'desc', ext)), ['c', 'a', 'd', 'b']);
  assert.deepStrictEqual(plus(o.ordenarFilas(filas, 'delta', null, ext)), ['a', 'b', 'c', 'd']);
});

test('columnasAlmacen: estado por severidad (subir, bajar, ok, sin vigente, sin precio), no alfabético', () => {
  const estadoDe = f => (f.faltantes.length ? 'sinPrecio' : f.precioVigente == null ? 'sinVigente' : f.semaforo);
  const fila = (plu, extra) => ({ plu, faltantes: [], precioVigente: 100, semaforo: 'ok', precioConIva: 100, ...extra });
  const filas = [fila('ok'), fila('sinPrecio', { faltantes: ['costoMercaderia'], precioConIva: null }), fila('bajar', { semaforo: 'bajar' }),
    fila('sinVig', { precioVigente: null, semaforo: null }), fila('subir', { semaforo: 'subir' })];
  const cols = o.columnasAlmacen(estadoDe);
  assert.deepStrictEqual(plus(o.ordenarCon(filas, { clave: 'estado', dir: 'asc' }, cols)), ['subir', 'bajar', 'ok', 'sinVig', 'sinPrecio']);
  assert.deepStrictEqual(plus(o.ordenarCon(filas, { clave: 'estado', dir: 'desc' }, cols)), ['sinPrecio', 'sinVig', 'ok', 'bajar', 'subir']);
  // Sugerido: sin precio (faltantes) va al final aunque tenga un número viejo.
  assert.strictEqual(cols.sugerido({ faltantes: ['x'], precioConIva: 5 }), null);
  assert.deepStrictEqual(o.ordenarCon(filas, null, cols), filas); // sin orden = original
});

test('columnasAlmacen: código numérico (PLU) y nombre con acentos', () => {
  const cols = o.columnasAlmacen(() => 'ok');
  const filas = [{ plu: '6051', nombre: 'Ñoquis' }, { plu: '100', nombre: 'arroz' }, { plu: '91031', nombre: 'Azúcar' }];
  assert.deepStrictEqual(plus(o.ordenarCon(filas, { clave: 'plu', dir: 'asc' }, cols)), ['100', '6051', '91031']);
  assert.deepStrictEqual(plus(o.ordenarCon(filas, { clave: 'nombre', dir: 'asc' }, cols)), ['100', '91031', '6051']);
});

test('columnasFracc: precio mínimo del grupo, #presentaciones, costo null si no hay costo base', () => {
  const cols = o.columnasFracc({ estadoGrupo: () => 'ok', peorPresentacion: g => g.presentaciones[0] || null });
  const g = { granelPlu: '1', costoBase: null, costoTotal: 5, presentaciones: [{ precioConIva: 900, deltaPct: -3 }, { precioConIva: null }, { precioConIva: 700 }] };
  assert.strictEqual(cols.sugerido(g), 700);
  assert.strictEqual(cols.presentaciones(g), 3);
  assert.strictEqual(cols.costo(g), null);
  assert.strictEqual(cols.delta(g), -3);
  assert.strictEqual(cols.sugerido({ presentaciones: [] }), null);
  assert.strictEqual(cols.delta({ presentaciones: [] }), undefined);
});

test('columnasSelectorProd: estado = más alertas primero, sin alertas al final', () => {
  const filas = [{ plu: 'a', alertas: 0, faltantes: 0 }, { plu: 'b', alertas: 1, faltantes: 0 }, { plu: 'c', alertas: 0, faltantes: 2 }, { plu: 'd', alertas: 3, faltantes: 0 }];
  assert.deepStrictEqual(plus(o.ordenarCon(filas, { clave: 'estado', dir: 'asc' }, o.columnasSelectorProd())), ['d', 'b', 'c', 'a']);
});

test('columnasPresProd: estado de Producción por severidad y columnas derivadas', () => {
  const cols = o.columnasPresProd({ estadoFila: p => p.e, nombreVariedad: p => p.v, kgDe: p => p.kg, empaqueDe: () => null });
  const filas = [{ plu: '1', e: 'ok' }, { plu: '2', e: 'faltantes' }, { plu: '3', e: 'sin-validar' }, { plu: '4', e: 'cambio' }];
  assert.deepStrictEqual(plus(o.ordenarCon(filas, { clave: 'estado', dir: 'asc' }, cols)), ['2', '4', '3', '1']);
  assert.strictEqual(cols.variedad({ v: 'Clásica' }), 'Clásica');
  assert.strictEqual(cols.empaque({}), null);
});
