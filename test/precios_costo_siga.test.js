'use strict';
// Costo "tal cual SIGA / comprobante" y precio final sin ×1,21 (plan 2026-09-30-precios-costo-siga-fijo).
const test = require('node:test');
const assert = require('node:assert');
const {
  IVA_VENTA, conIva, costearAlmacen, markupParaPrecio, migrarMargenesBaseCosto, migrarCosteoBaseCosto,
} = require('../lib/precios_costeo');
const { costoLineaCompra, filaCostos } = require('../lib/precios_consultas');

// ── Valorización de una línea de compra ──────────────────────────────────────

test('costoLineaCompra: factura → PrecioNeto + su IVA', () => {
  assert.strictEqual(costoLineaCompra({ tipo: 'FACTCOM', precioNeto: 1000, porcentajeIVA: 21 }), 1210);
  assert.strictEqual(costoLineaCompra({ tipo: 'FACTCOM', precioNeto: 1000, porcentajeIVA: 10.5 }), 1105);
  // 5785.12 × 1,21 = 6999.9952 → 7000 (caso PLU 90270: última compra 7.000)
  assert.strictEqual(costoLineaCompra({ tipo: 'FACTCOM', precioNeto: 5785.12, porcentajeIVA: 21 }), 7000);
});

test('costoLineaCompra: cotización → PrecioNeto tal cual (sin IVA aunque la línea traiga %)', () => {
  assert.strictEqual(costoLineaCompra({ tipo: 'COTIZACIONCOM', precioNeto: 6800, porcentajeIVA: 21 }), 6800);
  assert.strictEqual(costoLineaCompra({ tipo: ' cotizacion ', precioNeto: 6800, porcentajeIVA: null }), 6800);
});

test('costoLineaCompra: factura sin PorcentajeIVA → IVA 0 (ISNULL(...,0))', () => {
  assert.strictEqual(costoLineaCompra({ tipo: 'FACTCOM', precioNeto: 500, porcentajeIVA: null }), 500);
});

test('costoLineaCompra: notas de crédito y líneas sin precio → null', () => {
  assert.strictEqual(costoLineaCompra({ tipo: 'NCREDCOM', precioNeto: 1000, porcentajeIVA: 21 }), null);
  assert.strictEqual(costoLineaCompra({ tipo: 'COTIZACIONNCCOM', precioNeto: 1000, porcentajeIVA: 0 }), null);
  assert.strictEqual(costoLineaCompra({ tipo: 'FACTCOM', precioNeto: 0, porcentajeIVA: 21 }), null);
  assert.strictEqual(costoLineaCompra({ tipo: 'FACTCOM', precioNeto: null, porcentajeIVA: 21 }), null);
});

// ── Costo de sistema tal cual ────────────────────────────────────────────────

test('filaCostos: costo de sistema = PrecioCosto de SIGA tal cual (no se divide por la alícuota)', () => {
  const f = filaCostos({
    IdProducto: 90270, NombreProducto: 'X', CostoSistema: 6800, IvaCompraPct: 10.5,
    UcPrecioNeto: 5785.12, UcPorcentajeIVA: 21, UcTipo: 'FACTCOM', Proveedor: 'Prov', FechaCompraTxt: '2026-09-20',
  });
  assert.strictEqual(f.costoSistema, 6800);
  assert.strictEqual(f.costoSistemaConIva, 6800);
  assert.strictEqual(f.ivaCompraPct, 10.5);
  assert.strictEqual(f.costoMercaderia, 7000);
  assert.strictEqual(f.tipoComprobanteUltimaCompra, 'factura');
  assert.strictEqual(f.fechaUltimaCompra, '2026-09-20');
});

test('filaCostos: última compra por cotización → neto tal cual, tipo "cotización"; sin compra → null', () => {
  const f = filaCostos({ IdProducto: 1, CostoSistema: null, UcPrecioNeto: 900, UcPorcentajeIVA: 21, UcTipo: 'COTIZACIONCOM' });
  assert.strictEqual(f.costoSistema, null);
  assert.strictEqual(f.costoMercaderia, 900);
  assert.strictEqual(f.tipoComprobanteUltimaCompra, 'cotización');
  const g = filaCostos({ IdProducto: 2, CostoSistema: 100 });
  assert.strictEqual(g.costoMercaderia, null);
  assert.strictEqual(g.tipoComprobanteUltimaCompra, null);
});

// ── Precio final sin IVA de venta ────────────────────────────────────────────

test('precio final = costo × (1 + markup), redondeo a $50; IVA_VENTA = 1', () => {
  assert.strictEqual(IVA_VENTA, 1);
  assert.strictEqual(conIva(1442), 1442);
  const r = costearAlmacen({ costoMercaderia: 6800, markupPct: 40 });
  assert.strictEqual(r.precioNeto, 9520); // 6800 × 1,4
  assert.strictEqual(r.precioConIvaExacto, 9520);
  assert.strictEqual(r.precioConIva, 9500); // 9520 → múltiplo de 50 más cercano
});

test('markupParaPrecio: precio / costo − 1, sin /1,21', () => {
  assert.strictEqual(markupParaPrecio(1000, 1210), 21);
  assert.strictEqual(markupParaPrecio(6800, 9520), 40);
  assert.strictEqual(markupParaPrecio(1000, 1000), 0);
});

// ── Migración de márgenes propios ────────────────────────────────────────────

test('migrarMargenesBaseCosto: alícuota 21 % → margen igual; 10,5 % → (1+m)·1,21/1,105 − 1', () => {
  const alic = new Map([['a21', 21], ['a105', 10.5], ['frac', 10.5]]);
  const { margenPorProducto, ajustados } = migrarMargenesBaseCosto({ a21: 40, a105: 40, frac: 60.3 }, alic);
  assert.strictEqual(margenPorProducto.a21, 40);
  // (1,40 × 1,21 ÷ 1,105 − 1) × 100 = 53,303167...
  assert.strictEqual(margenPorProducto.a105, 53.303167);
  // presentación de Fraccionado con la alícuota del granel: (1,603 × 1,21 ÷ 1,105 − 1) × 100 = 75,532127...
  assert.strictEqual(margenPorProducto.frac, 75.532127);
  assert.strictEqual(ajustados, 2);
});

test('migrarMargenesBaseCosto: el precio viejo se mantiene con el costo nuevo', () => {
  const precioCosto = 1105, m = 40;
  const viejo = (precioCosto / 1.105) * (1 + m / 100) * 1.21; // 1694
  const { margenPorProducto } = migrarMargenesBaseCosto({ p: m }, new Map([['p', 10.5]]));
  const nuevo = precioCosto * (1 + margenPorProducto.p / 100);
  assert.ok(Math.abs(nuevo - viejo) < 0.01);
});

test('migrarMargenesBaseCosto: fuera del mapa, alícuota null o costo que no cambia (0 %)', () => {
  const alic = new Map([['nulo', null], ['manual', 0]]);
  const { margenPorProducto, ajustados } = migrarMargenesBaseCosto({ prod: 30, nulo: 30, manual: 30 }, alic);
  assert.strictEqual(margenPorProducto.prod, 30); // Producción u otro: sin cambio
  assert.strictEqual(margenPorProducto.nulo, 30); // desconocida → 21 % → igual
  assert.strictEqual(margenPorProducto.manual, 57.3); // 1,30 × 1,21 − 1 (costo manual no cambia)
  assert.strictEqual(ajustados, 1);
});

test('migrarMargenesBaseCosto: no muta la entrada', () => {
  const entrada = { p: 40 };
  migrarMargenesBaseCosto(entrada, new Map([['p', 10.5]]));
  assert.deepStrictEqual(entrada, { p: 40 });
});

test('migrarCosteoBaseCosto: marca baseCosto "siga" y es idempotente', () => {
  const costeo = { toleranciaPct: 10, margenPorProducto: { p: 40 } };
  const r = migrarCosteoBaseCosto(costeo, new Map([['p', 10.5]]));
  assert.strictEqual(r.costeo.baseCosto, 'siga');
  assert.strictEqual(r.costeo.toleranciaPct, 10);
  assert.strictEqual(r.costeo.margenPorProducto.p, 53.303167);
  assert.strictEqual(r.ajustados, 1);
  assert.strictEqual(migrarCosteoBaseCosto(r.costeo, new Map([['p', 10.5]])), null);
  assert.strictEqual(costeo.baseCosto, undefined);
});

// ── Mapa de alícuotas y disparo de la migración (routes/rutas_precios.js) ────

test('alicuotasParaMigrar: Almacén con la suya, Fraccionado con la del granel, 0 si el costo no cambia', () => {
  const { alicuotasParaMigrar } = require('../routes/rutas_precios');
  const filas = [
    { plu: 'a', costoFuente: 'sistema', ivaCompraPct: 10.5 },
    { plu: 'm', costoFuente: 'manual', ivaCompraPct: 10.5 },
    { plu: 'c', costoFuente: 'ultimaCompra', ivaCompraPct: 10.5, tipoComprobanteUltimaCompra: 'cotización' },
    { plu: 'f', costoFuente: 'ultimaCompra', ivaCompraPct: 10.5, tipoComprobanteUltimaCompra: 'factura' },
    { plu: 'n', costoFuente: 'sistema', ivaCompraPct: null },
  ];
  const grupos = [
    { granelPlu: '4409', costoFuente: 'sistema', ivaCompraPct: 10.5, presentaciones: [{ plu: '11' }, { plu: '12' }] },
    { granelPlu: null, costoFuente: null, ivaCompraPct: null, presentaciones: [{ plu: '31' }] }, // sin granel
  ];
  const m = alicuotasParaMigrar(filas, grupos);
  assert.deepStrictEqual(Object.fromEntries(m), { a: 10.5, m: 0, c: 0, f: 10.5, n: null, 11: 10.5, 12: 10.5, 31: null });
});

// Router con SIGA simulado: un producto Almacén (alícuota 10,5 %) con margen propio 40 y uno de Producción (sin fila).
function routerParaMigrar(t, costeoInicial) {
  const crearRutasPrecios = require('../routes/rutas_precios');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const guardados = [];
  let costeo = costeoInicial;
  const query = async (sql) => (sql.includes("NombreRubro = 'Almacen'")
    ? [{ IdProducto: '100', NombreProducto: 'X', CostoSistema: 1105, IvaCompraPct: 10.5 }] : []);
  crearRutasPrecios({
    apiRoute: fn => fn, query, DATA_DIR: '/tmp', LISTA_PRECIOS_VENTA: 1, FORMULA_ACTIVA_SQL: '1=1', SIN_FORMULA_GENERICO_SQL: '1=1',
    leerJSON: (p, def) => (costeo === undefined ? def : costeo),
    guardarJSON: (p, d) => { guardados.push([p, d]); if (!p.endsWith('.bak-base-costo')) costeo = d; },
  });
  return { guardados };
}
const esperar = () => new Promise(r => setImmediate(r));
async function correrMigracion(t) { t.mock.timers.tick(30000); for (let i = 0; i < 10; i++) await esperar(); }

test('migración al arrancar: backup, márgenes ajustados, flag; la segunda vez no hace nada', async (t) => {
  const inicial = { toleranciaPct: 10, margenPorProducto: { 100: 40, 999: 25 } };
  const { guardados } = routerParaMigrar(t, inicial);
  await correrMigracion(t);
  assert.strictEqual(guardados.length, 2);
  const [[pBak, bak], [pCosteo, nuevo]] = guardados;
  assert.match(pBak, /costeo\.json\.bak-base-costo$/);
  assert.deepStrictEqual(bak, inicial);
  assert.match(pCosteo, /costeo\.json$/);
  assert.strictEqual(nuevo.baseCosto, 'siga');
  assert.strictEqual(nuevo.margenPorProducto['100'], 53.303167); // (1,40 × 1,21 ÷ 1,105 − 1)
  assert.strictEqual(nuevo.margenPorProducto['999'], 25);        // fuera de Almacén/Fraccionado: igual
});

test('migración: ya migrado o costeo.json ausente/roto (leerJSON devuelve el default) → no escribe', async (t) => {
  const ya = routerParaMigrar(t, { baseCosto: 'siga', margenPorProducto: { 100: 40 } });
  await correrMigracion(t);
  assert.deepStrictEqual(ya.guardados, []);
  t.mock.timers.reset();
  const roto = routerParaMigrar(t, undefined);
  await correrMigracion(t);
  assert.deepStrictEqual(roto.guardados, []);
});
