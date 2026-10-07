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
  assert.deepStrictEqual(c.redondeo, { minorista: 50, packNeto: 50, packIva: 50, bultoNeto: 50, bultoIva: 50 });
  assert.deepStrictEqual([c.gastosVenta, c.extrasMinorista, c.margenes], [[], [], {}]);
  const m = C.configEsquemaDe({ margenes: { almacen: {} }, modoGastos: 'precio', ivaVentaPct: 10.5, redondeo: { minorista: 10 } });
  assert.deepStrictEqual([m.migrado, m.modoGastos, m.ivaVentaPct, m.redondeo.minorista, m.redondeo.packIva], [true, 'precio', 10.5, 10, 50]);
});

test('validarCostos: gastos y extras con tildes, sin listas; ids por slug', () => {
  const r = C.validarCostos({
    modoGastos: 'precio',
    gastosVenta: [{ concepto: 'Flete', pct: 1, tipos: { almacen: true, fraccionado: true, produccion: false } }],
    extrasMinorista: [{ id: 'ingresos-brutos', concepto: 'Ingresos Brutos', pct: 5, tipos: TODOS }],
  });
  assert.strictEqual(r.modoGastos, 'precio');
  assert.deepStrictEqual(r.gastosVenta, [{ id: 'flete', concepto: 'Flete', pct: 1, tipos: { almacen: true, fraccionado: true, produccion: false } }]);
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

// ── Migración ────────────────────────────────────────────────────────────────

// costeo.json como el de hoy (2026-10-07): curvas, conceptos sobre precio final, marcados y fuentes de costo.
const VIEJO = {
  toleranciaPct: 3, ivaVentaPct: 21,
  gastosVenta: [
    { id: 'costos-financieros-minorista', concepto: 'Costos Financieros Minorista', pct: 2.3, listas: ['sucursal'] },
    { id: 'flete', concepto: 'Flete', pct: 1, listas: ['sucursal'] },
  ],
  conceptosPrecioFinal: [{ id: 'ingresos-brutos', concepto: 'Ingresos Brutos', pct: 5 }, { id: 'impuesto-deb-cred', concepto: 'Impuesto Deb.Cred', pct: 0.79 }],
  curvaGanancia: {
    almacen: { a: 59, b: 2.3, pisoPct: 33.6515, techoPct: 47.8142 },
    fraccionado: { a: 78, b: 3.5, pisoPct: 30.9723, techoPct: 78, ajustesPeso: { tramosG: [100, 1000], puntos: [8, 0] } },
    produccion: { a: 90, b: 1, pisoPct: 400, techoPct: 90 }, // inválida (piso > techo) → respaldo
  },
  marcadosExportar: { 10: '2026-09-30', 11: '2026-10-01', 12: '2026-10-02' },
  fuenteCosto: { 11: 'ultimaCompra', 99: 'ultimaCompra' },
  costoPorProducto: { 12: 500 },
};

test('migrarEsquemaCanales: agrega todo lo nuevo sin borrar claves viejas', () => {
  const { costeo, claves } = C.migrarEsquemaCanales(VIEJO);
  assert.deepStrictEqual([...claves].sort(), ['decisiones', 'extrasMinorista', 'gastosVenta', 'margenes', 'modoGastos', 'redondeo']);
  for (const k of Object.keys(VIEJO)) assert.ok(k in costeo, `conserva ${k}`);
  assert.strictEqual(costeo.modoGastos, 'costo');
  assert.deepStrictEqual(costeo.gastosVenta, [{ id: 'flete', concepto: 'Flete', pct: 1, listas: ['sucursal'], tipos: TODOS }]);
  assert.deepStrictEqual(costeo.extrasMinorista, [
    { id: 'ingresos-brutos', concepto: 'Ingresos Brutos', pct: 5, tipos: TODOS },
    { id: 'impuesto-deb-cred', concepto: 'Impuesto Deb.Cred', pct: 0.79, tipos: TODOS }]);
  assert.deepStrictEqual(costeo.redondeo, { minorista: 50, packNeto: 50, packIva: 50, bultoNeto: 50, bultoIva: 50 });
  assert.deepStrictEqual(costeo.decisiones, {
    10: { fuente: 'sistema', fecha: '2026-09-30' },
    11: { fuente: 'ultimaCompra', fecha: '2026-10-01' },
    12: { fuente: 'manual', fecha: '2026-10-02' },
  });
});

test('migrarEsquemaCanales: márgenes desde piso/techo de la curva, 10 escalones, rango estimado; pack/bulto sin configurar', () => {
  const { margenes } = C.migrarEsquemaCanales(VIEJO).costeo;
  const rango = { desde: 100, hasta: 100000 };
  assert.deepStrictEqual(margenes.almacen.minorista, { minPct: 33.65, maxPct: 47.81, escalones: 10, rango, rangoEstimado: true });
  assert.deepStrictEqual(margenes.almacen.pack, { ...margenes.almacen.minorista, sinConfigurar: true });
  assert.deepStrictEqual(margenes.almacen.bulto, { ...margenes.almacen.minorista, sinConfigurar: true });
  assert.deepStrictEqual(margenes.fraccionado.ajustesPeso, { tramosG: [100, 1000], puntos: [8, 0] });
  assert.deepStrictEqual(margenes.produccion.minorista, { minPct: 30, maxPct: 50, escalones: 10, rango, rangoEstimado: true });
  const { validarTablaMargen } = require('../lib/precios_esquema');
  for (const tipo of C.TIPOS) for (const canal of C.CANALES) assert.strictEqual(validarTablaMargen(margenes[tipo][canal]), null, `${tipo}.${canal}`);
});

test('migrarEsquemaCanales: idempotente (lo migrado devuelve null) y no muta la entrada', () => {
  const copia = JSON.parse(JSON.stringify(VIEJO));
  const { costeo } = C.migrarEsquemaCanales(VIEJO);
  assert.deepStrictEqual(VIEJO, copia);
  assert.strictEqual(C.migrarEsquemaCanales(costeo), null);
});

test('migrarEsquemaCanales: archivo mínimo → márgenes de respaldo, listas vacías, sin ajuste por peso', () => {
  const { costeo } = C.migrarEsquemaCanales({});
  assert.deepStrictEqual([costeo.extrasMinorista, costeo.decisiones], [[], {}]);
  assert.strictEqual(costeo.margenes.fraccionado.ajustesPeso, undefined);
  assert.strictEqual(costeo.margenes.almacen.minorista.minPct, 30);
});

test('limpiarCosteo: saca las claves muertas, los descuentos pack/bulto y listas de los gastos; conserva lo vivo; idempotente', () => {
  const vivo = { toleranciaPct: 3, ivaVentaPct: 21, modoGastos: 'costo', extrasMinorista: [], margenes: {}, redondeo: {},
    costoPorProducto: { 1: 9 }, costosExtraFraccionado: {}, decisiones: {} };
  const viejo = { ...vivo, costoHora: 4500, margenPorProducto: { 1: 20 }, fuenteCosto: { 1: 'ultimaCompra' }, marcadosExportar: {},
    curvaGanancia: {}, metodoGanancia: 'curva', departamentos: [], ventaBase: {}, conceptosGanancia: [], conceptosPrecioFinal: [],
    presentacionesTemporales: {}, recetas: {},
    gastosVenta: [{ id: 'flete', concepto: 'Flete', pct: 1, listas: ['sucursal'], tipos: { almacen: true, fraccionado: true, produccion: true } }],
    packBulto: { descPackPct: 9.7, descBultoPct: 14.7, descPorProducto: { 50: 10 }, vinculosManuales: { 60: { basePlu: '1', tipo: 'pack' } }, ventaPesable: {} } };
  const r = C.limpiarCosteo(viejo);
  assert.deepStrictEqual(r.datos, { ...vivo,
    gastosVenta: [{ id: 'flete', concepto: 'Flete', pct: 1, tipos: { almacen: true, fraccionado: true, produccion: true } }],
    packBulto: { vinculosManuales: { 60: { basePlu: '1', tipo: 'pack' } }, ventaPesable: {} } });
  assert.ok(r.quitadas.includes('costoHora') && r.quitadas.includes('packBulto.descPorProducto') && r.quitadas.includes('gastosVenta[].listas'));
  assert.strictEqual(C.limpiarCosteo(r.datos), null);
  assert.strictEqual(viejo.costoHora, 4500); // no muta
});
