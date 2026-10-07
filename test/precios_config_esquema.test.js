'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/precios_config_esquema');

const TODOS = { almacen: true, fraccionado: true, produccion: true };
const TABLA = { minPct: 30, maxPct: 60, escalones: 4, rango: { desde: 100, hasta: 10000 } };

test('configEsquemaDe: defaults para lo escalar; sin margenes → migrado false', () => {
  const c = C.configEsquemaDe({});
  assert.strictEqual(c.migrado, false);
  assert.strictEqual(c.modoGastos, 'costo');
  assert.strictEqual(c.ivaVentaPct, 21);
  assert.deepStrictEqual(c.redondeo, { minorista: 50, packNeto: 0, packIva: 50, bultoNeto: 0, bultoIva: 50 });
  assert.deepStrictEqual([c.gastosVenta, c.extrasMinorista, c.margenes], [[], [], {}]);
  const m = C.configEsquemaDe({ margenes: { almacen: {} }, modoGastos: 'precio', ivaVentaPct: 10.5, redondeo: { minorista: 10 } });
  assert.deepStrictEqual([m.migrado, m.modoGastos, m.ivaVentaPct, m.redondeo.minorista, m.redondeo.packIva], [true, 'precio', 10.5, 10, 50]);
});

test('validarCostos: gastos con listas y tildes, extras sin listas; ids por slug', () => {
  const r = C.validarCostos({
    modoGastos: 'precio',
    gastosVenta: [{ concepto: 'Flete', pct: 1, tipos: { almacen: true, fraccionado: true, produccion: false } }],
    extrasMinorista: [{ id: 'ingresos-brutos', concepto: 'Ingresos Brutos', pct: 5, tipos: TODOS }],
  });
  assert.strictEqual(r.modoGastos, 'precio');
  assert.deepStrictEqual(r.gastosVenta, [{ id: 'flete', concepto: 'Flete', pct: 1, listas: ['sucursal'], tipos: { almacen: true, fraccionado: true, produccion: false } }]);
  assert.deepStrictEqual(r.extrasMinorista, [{ id: 'ingresos-brutos', concepto: 'Ingresos Brutos', pct: 5, tipos: TODOS }]);
});

test('validarCostos: rechaza modo, tildes incompletos, pct fuera de rango, total ≥ 100 y no-lista', () => {
  const ok = { modoGastos: 'costo', gastosVenta: [], extrasMinorista: [] };
  assert.throws(() => C.validarCostos({ ...ok, modoGastos: 'otro' }), /modoGastos/);
  assert.throws(() => C.validarCostos({ ...ok, gastosVenta: [{ concepto: 'X', pct: 1, tipos: { almacen: true } }] }), /gastosVenta\[0\]\.tipos/);
  assert.throws(() => C.validarCostos({ ...ok, extrasMinorista: [{ concepto: 'X', pct: 120, tipos: TODOS }] }), /extrasMinorista: .*pct/);
  assert.throws(() => C.validarCostos({ ...ok, gastosVenta: [{ concepto: 'A', pct: 60, tipos: TODOS }, { concepto: 'B', pct: 40, tipos: TODOS }] }), /menor a 100/);
  assert.throws(() => C.validarCostos({ ...ok, gastosVenta: 'x' }), /gastosVenta: items: debe ser una lista/);
});

test('validarMargenesTipo: 3 tablas, descarta sinConfigurar, conserva rangoEstimado; ajuste por peso sólo en Fraccionado', () => {
  const r = C.validarMargenesTipo('almacen', { minorista: { ...TABLA, rangoEstimado: true }, pack: { ...TABLA, sinConfigurar: true }, bulto: TABLA,
    ajustesPeso: { tramosG: [500], puntos: [5] } });
  assert.deepStrictEqual(r, { minorista: { ...TABLA, rangoEstimado: true }, pack: TABLA, bulto: TABLA });
  const f = C.validarMargenesTipo('fraccionado', { minorista: TABLA, pack: TABLA, bulto: TABLA, ajustesPeso: { tramosG: [100, 500], puntos: [10, -5] } });
  assert.deepStrictEqual(f.ajustesPeso, { tramosG: [100, 500], puntos: [10, -5] });
  assert.strictEqual('ajustesPeso' in C.validarMargenesTipo('fraccionado', { minorista: TABLA, pack: TABLA, bulto: TABLA }), false);
});

test('validarMargenesTipo: errores con tipo, canal y campo', () => {
  const tres = { minorista: TABLA, pack: TABLA, bulto: TABLA };
  assert.throws(() => C.validarMargenesTipo('otro', tres), /tipo inválido/);
  assert.throws(() => C.validarMargenesTipo('almacen', { ...tres, pack: { ...TABLA, minPct: 70 } }), /almacen\.pack: El margen mínimo no puede superar/);
  assert.throws(() => C.validarMargenesTipo('almacen', { minorista: TABLA, pack: TABLA }), /almacen\.bulto: Falta la tabla/);
  assert.throws(() => C.validarMargenesTipo('fraccionado', { ...tres, ajustesPeso: { tramosG: [500, 100], puntos: [1, 2] } }), /tramosG\[1\]/);
  assert.throws(() => C.validarMargenesTipo('fraccionado', { ...tres, ajustesPeso: { tramosG: [100], puntos: [200] } }), /puntos/);
});

test('validarPrecio: IVA, tolerancia y los 5 redondeos (descarta claves de más)', () => {
  const red = { minorista: 50, packNeto: 0, packIva: 50, bultoNeto: 0, bultoIva: 100 };
  assert.deepStrictEqual(C.validarPrecio({ ivaVentaPct: 21, toleranciaPct: 3, redondeo: red, otro: 1 }), { ivaVentaPct: 21, toleranciaPct: 3, redondeo: red });
  assert.throws(() => C.validarPrecio({ ivaVentaPct: 120, toleranciaPct: 3, redondeo: red }), /ivaVentaPct/);
  assert.throws(() => C.validarPrecio({ ivaVentaPct: 21, toleranciaPct: 3, redondeo: { ...red, bultoIva: -1 } }), /redondeo\.bultoIva/);
  assert.throws(() => C.validarPrecio({ ivaVentaPct: 21, toleranciaPct: 3, redondeo: { minorista: 50 } }), /redondeo\.packNeto/);
});
