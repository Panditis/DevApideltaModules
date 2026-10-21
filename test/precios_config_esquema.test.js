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
  const m = C.configEsquemaDe({ margenes: { minorista: {} }, modoGastos: 'precio', ivaVentaPct: 10.5, redondeo: { minorista: 10 } });
  assert.deepStrictEqual([m.migrado, m.modoGastos, m.ivaVentaPct, m.redondeo.minorista, m.redondeo.packIva], [true, 'precio', 10.5, 10, 50]);
  assert.strictEqual(C.configEsquemaDe({ margenes: { almacen: { minorista: {} } } }).migrado, false); // por tipo: falta colapsar
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

test('validarMargenes: 3 tablas por canal, descarta sinConfigurar y claves de más, conserva rangoEstimado; ajuste por peso opcional', () => {
  const r = C.validarMargenes({ minorista: { ...TABLA, rangoEstimado: true }, pack: { ...TABLA, sinConfigurar: true }, bulto: TABLA, almacen: {} });
  assert.deepStrictEqual(r, { minorista: { ...TABLA, rangoEstimado: true }, pack: TABLA, bulto: TABLA });
  const f = C.validarMargenes({ minorista: TABLA, pack: TABLA, bulto: TABLA, ajustesPeso: { tramosG: [100, 500], puntos: [10, -5] } });
  assert.deepStrictEqual(f.ajustesPeso, { tramosG: [100, 500], puntos: [10, -5] });
});

test('validarMargenes: errores con canal y campo', () => {
  const tres = { minorista: TABLA, pack: TABLA, bulto: TABLA };
  assert.throws(() => C.validarMargenes({ ...tres, pack: { ...TABLA, minPct: 70 } }), /pack: El margen mínimo no puede superar/);
  assert.throws(() => C.validarMargenes({ ...tres, bulto: { ...TABLA, minPct: -100 } }), /bulto: El margen debe ser mayor a −100 %/);
  assert.doesNotThrow(() => C.validarMargenes({ ...tres, bulto: { ...TABLA, minPct: -99.9, maxPct: 5000 } })); // sin tope superior
  assert.throws(() => C.validarMargenes({ minorista: TABLA, pack: TABLA }), /bulto: Falta la tabla/);
  assert.throws(() => C.validarMargenes({ ...tres, ajustesPeso: { tramosG: [500, 100], puntos: [1, 2] } }), /tramosG\[1\]/);
  assert.throws(() => C.validarMargenes({ ...tres, ajustesPeso: { tramosG: [100], puntos: [200] } }), /puntos/);
});

test('validarMargenes: descuentoDistribuidorPct opcional (número ≥ 0 y < 100); null/vacío = sin descuento', () => {
  const tres = { minorista: TABLA, pack: TABLA, bulto: TABLA };
  assert.deepStrictEqual(C.validarMargenes({ ...tres, descuentoDistribuidorPct: 5 }), { ...tres, descuentoDistribuidorPct: 5 });
  assert.deepStrictEqual(C.validarMargenes({ ...tres, descuentoDistribuidorPct: 0 }), { ...tres, descuentoDistribuidorPct: 0 });
  for (const v of [null, '', undefined]) assert.deepStrictEqual(C.validarMargenes({ ...tres, descuentoDistribuidorPct: v }), tres);
  for (const v of [-1, 100, '5', NaN]) assert.throws(() => C.validarMargenes({ ...tres, descuentoDistribuidorPct: v }), /descuentoDistribuidorPct/);
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

test('migrarEsquemaCanales: 3 tablas por canal desde piso/techo de la curva de Reventa, 10 escalones, rango estimado; pack/bulto sin configurar', () => {
  const { margenes } = C.migrarEsquemaCanales(VIEJO).costeo;
  const rango = { desde: 100, hasta: 100000 };
  assert.deepStrictEqual(Object.keys(margenes).sort(), ['ajustesPeso', 'bulto', 'minorista', 'pack']);
  assert.deepStrictEqual(margenes.minorista, { minPct: 33.65, maxPct: 47.81, escalones: 10, rango, rangoEstimado: true });
  assert.deepStrictEqual(margenes.pack, { ...margenes.minorista, sinConfigurar: true });
  assert.deepStrictEqual(margenes.bulto, { ...margenes.minorista, sinConfigurar: true });
  assert.deepStrictEqual(margenes.ajustesPeso, { tramosG: [100, 1000], puntos: [8, 0] });
  const { validarTablaMargen } = require('../lib/precios_esquema');
  for (const canal of C.CANALES) assert.strictEqual(validarTablaMargen(margenes[canal]), null, canal);
});

test('migrarEsquemaCanales: colapsa márgenes por tipo (migración anterior) a las tablas de Reventa + ajuste de Fraccionado; idempotente', () => {
  const T = { minPct: 20, maxPct: 40, escalones: 5, rango: { desde: 50, hasta: 5000 } };
  const aj = { tramosG: [100], puntos: [5] };
  const porTipo = { almacen: { minorista: T, pack: { ...T, sinConfigurar: true }, bulto: T },
    fraccionado: { minorista: { ...T, minPct: 1 }, pack: T, bulto: T, ajustesPeso: aj }, produccion: { minorista: T, pack: T, bulto: T } };
  const viejo = { ...C.migrarEsquemaCanales({}).costeo, margenes: porTipo };
  const r = C.migrarEsquemaCanales(viejo);
  assert.deepStrictEqual(r.claves, ['margenes']);
  assert.deepStrictEqual(r.costeo.margenes, { minorista: T, pack: { ...T, sinConfigurar: true }, bulto: T, ajustesPeso: aj });
  assert.strictEqual(C.migrarEsquemaCanales(r.costeo), null);
  assert.deepStrictEqual(viejo.margenes, porTipo); // no muta
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
  assert.strictEqual(costeo.margenes.ajustesPeso, undefined);
  assert.strictEqual(costeo.margenes.minorista.minPct, 30);
});

test('limpiarCosteo: saca las claves muertas, los descuentos pack/bulto y listas de los gastos; conserva lo vivo; idempotente', () => {
  const vivo = { toleranciaPct: 3, ivaVentaPct: 21, modoGastos: 'costo', extrasMinorista: [], margenes: {}, redondeo: {},
    costoPorProducto: { 1: 9 }, costosExtraFraccionado: {}, decisiones: {}, costoHora: 4500, // costoHora volvió (MO de Producción, 2026-10-13)
    margenProducto: { 1: { minorista: 5 } } }; // ajuste de margen por producto (2026-10-14)
  const viejo = { ...vivo, margenPorProducto: { 1: 20 }, fuenteCosto: { 1: 'ultimaCompra' }, marcadosExportar: {},
    curvaGanancia: {}, metodoGanancia: 'curva', departamentos: [], ventaBase: {}, conceptosGanancia: [], conceptosPrecioFinal: [],
    presentacionesTemporales: {}, recetas: {},
    gastosVenta: [{ id: 'flete', concepto: 'Flete', pct: 1, listas: ['sucursal'], tipos: { almacen: true, fraccionado: true, produccion: true } }],
    packBulto: { descPackPct: 9.7, descBultoPct: 14.7, descPorProducto: { 50: 10 }, vinculosManuales: { 60: { basePlu: '1', tipo: 'pack' } }, ventaPesable: {} } };
  const r = C.limpiarCosteo(viejo);
  assert.deepStrictEqual(r.datos, { ...vivo,
    gastosVenta: [{ id: 'flete', concepto: 'Flete', pct: 1, tipos: { almacen: true, fraccionado: true, produccion: true } }],
    packBulto: { vinculosManuales: { 60: { basePlu: '1', tipo: 'pack' } }, ventaPesable: {} } });
  assert.ok(!r.quitadas.includes('costoHora') && r.quitadas.includes('packBulto.descPorProducto') && r.quitadas.includes('gastosVenta[].listas'));
  assert.strictEqual(C.limpiarCosteo(r.datos), null);
  assert.strictEqual(viejo.costoHora, 4500); // no muta
});

// ── Configuración por tipo (spec 2026-10-21-precios-fraccionado-costeo-design §2) ──
const SOLO_FRACC = { almacen: false, fraccionado: true, produccion: false };
const RAIZ = { ivaVentaPct: 21, toleranciaPct: 3, modoGastos: 'costo', costoHora: 8000,
  gastosVenta: [{ id: 'op', concepto: 'Op', pct: 7, tipos: TODOS }], extrasMinorista: [],
  margenes: { minorista: TABLA, pack: TABLA, bulto: TABLA }, redondeo: { minorista: 10 } };

test('configEsquemaDe: Reventa/Producción leen la raíz y dicen si Fraccionado ya tiene la suya', () => {
  const r = C.configEsquemaDe(RAIZ);
  assert.deepStrictEqual([r.ivaVentaPct, r.costoHora, r.fraccionadoMigrado, 'maquinas' in r], [21, 8000, false, false]);
  assert.deepStrictEqual(C.configEsquemaDe(RAIZ, 'produccion'), r);
  assert.strictEqual(C.configEsquemaDe({ ...RAIZ, fraccionado: {} }, 'almacen').fraccionadoMigrado, true);
});

test('configEsquemaDe fraccionado: sin migrar → la raíz (como antes) + defaults de lo propio; migrado → su bloque con tilde sólo Fraccionado', () => {
  const sin = C.configEsquemaDe(RAIZ, 'fraccionado');
  assert.deepStrictEqual([sin.fraccionadoMigrado, sin.ivaVentaPct, sin.gastosVenta], [false, 21, RAIZ.gastosVenta]);
  assert.deepStrictEqual([sin.maquinas, sin.tiempos, sin.insumosSubrubro, sin.porGranel, sin.insumosPresentacion], [[], [], {}, {}, {}]);
  assert.deepStrictEqual(sin.facilidades, { facil: 1, medio: 1.25, dificil: 1.5 });
  const fracc = { ivaVentaPct: 10.5, costoHora: 5000, modoGastos: 'precio', gastosVenta: [{ id: 'fl', concepto: 'Flete', pct: 2 }],
    extrasMinorista: [{ id: 'ib', concepto: 'IIBB', pct: 5 }], margenes: { minorista: TABLA }, redondeo: { minorista: 0 },
    maquinas: [{ id: 'm1', nombre: 'Envasadora', costoHora: 900 }], facilidades: { medio: 1.3 } };
  const f = C.configEsquemaDe({ ...RAIZ, fraccionado: fracc }, 'fraccionado');
  assert.deepStrictEqual([f.fraccionadoMigrado, f.migrado, f.ivaVentaPct, f.costoHora, f.modoGastos, f.redondeo.minorista, f.redondeo.packIva],
    [true, true, 10.5, 5000, 'precio', 0, 50]);
  assert.deepStrictEqual(f.gastosVenta, [{ id: 'fl', concepto: 'Flete', pct: 2, tipos: SOLO_FRACC }]);
  assert.deepStrictEqual(f.extrasMinorista, [{ id: 'ib', concepto: 'IIBB', pct: 5, tipos: SOLO_FRACC }]);
  assert.deepStrictEqual(f.maquinas, fracc.maquinas);
  assert.deepStrictEqual(f.facilidades, { facil: 1, medio: 1.3, dificil: 1.5 });
});

test('tipoConfig: almacen por defecto, fraccionado, cualquier otro → null', () => {
  assert.deepStrictEqual([C.tipoConfig(undefined), C.tipoConfig(''), C.tipoConfig('almacen'), C.tipoConfig('fraccionado'), C.tipoConfig('produccion'), C.tipoConfig('x')],
    ['almacen', 'almacen', 'almacen', 'fraccionado', null, null]);
});

// validarGastosVenta devuelve `listas` (todas por defecto): se descarta como en Reventa.
test('validarCostos fraccionado: gastos y extras sin tildes ni listas (la tabla ya es sólo de Fraccionado)', () => {
  const r = C.validarCostos({ modoGastos: 'costo',
    gastosVenta: [{ concepto: 'Flete', pct: 2, tipos: SOLO_FRACC }],
    extrasMinorista: [{ concepto: 'IIBB', pct: 5 }] }, 'fraccionado');
  assert.deepStrictEqual(r, { modoGastos: 'costo', gastosVenta: [{ id: 'flete', concepto: 'Flete', pct: 2 }],
    extrasMinorista: [{ id: 'iibb', concepto: 'IIBB', pct: 5 }] });
  assert.throws(() => C.validarCostos({ modoGastos: 'costo', gastosVenta: [{ concepto: 'A', pct: 100 }], extrasMinorista: [] }, 'fraccionado'), /gastosVenta/);
});
