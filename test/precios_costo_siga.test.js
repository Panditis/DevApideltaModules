'use strict';
// Costo NETO (factura y cotización: PrecioNeto; sistema: PrecioCosto ÷ (1 + alícuota)) + IVA de venta al final
// (spec 2026-10-02-precios-costo-neto-iva-curva, Parte A). Antes: plan 2026-09-30-precios-costo-siga-fijo.
const test = require('node:test');
const assert = require('node:assert');
const {
  costearAlmacen, markupParaPrecio, migrarMargenesBaseCosto, migrarCosteoBaseCosto,
} = require('../lib/precios_costeo');
const { costoLineaCompra, filaCostos } = require('../lib/precios_consultas');

// ── Costo neto de una línea de compra ────────────────────────────────────────

test('costoLineaCompra: factura → PrecioNeto SIN sumar su IVA', () => {
  assert.strictEqual(costoLineaCompra({ tipo: 'FACTCOM', precioNeto: 1000, porcentajeIVA: 21 }), 1000);
  assert.strictEqual(costoLineaCompra({ tipo: 'FACTCOM', precioNeto: 1000, porcentajeIVA: 10.5 }), 1000);
  assert.strictEqual(costoLineaCompra({ tipo: 'FACTCOM', precioNeto: 5785.123 }), 5785.12);
});

test('costoLineaCompra: cotización → PrecioNeto tal cual (también neto)', () => {
  assert.strictEqual(costoLineaCompra({ tipo: 'COTIZACIONCOM', precioNeto: 6800, porcentajeIVA: 21 }), 6800);
  assert.strictEqual(costoLineaCompra({ tipo: ' cotizacion ', precioNeto: 6800, porcentajeIVA: null }), 6800);
});

test('costoLineaCompra: notas de crédito y líneas sin precio → null', () => {
  assert.strictEqual(costoLineaCompra({ tipo: 'NCREDCOM', precioNeto: 1000, porcentajeIVA: 21 }), null);
  assert.strictEqual(costoLineaCompra({ tipo: 'COTIZACIONNCCOM', precioNeto: 1000, porcentajeIVA: 0 }), null);
  assert.strictEqual(costoLineaCompra({ tipo: 'FACTCOM', precioNeto: 0, porcentajeIVA: 21 }), null);
  assert.strictEqual(costoLineaCompra({ tipo: 'FACTCOM', precioNeto: null, porcentajeIVA: 21 }), null);
});

// ── Costo de sistema neto ────────────────────────────────────────────────────

test('filaCostos: costo de sistema = PrecioCosto ÷ (1 + alícuota del producto); con IVA queda aparte', () => {
  const f = filaCostos({
    IdProducto: 90270, NombreProducto: 'X', CostoSistema: 6630, IvaCompraPct: 10.5,
    UcPrecioNeto: 5785.12, UcPorcentajeIVA: 21, UcTipo: 'FACTCOM', Proveedor: 'Prov', FechaCompraTxt: '2026-09-20',
  });
  assert.strictEqual(f.costoSistema, 6000); // 6630 ÷ 1,105
  assert.strictEqual(f.costoSistemaConIva, 6630);
  assert.strictEqual(f.ivaCompraPct, 10.5);
  assert.strictEqual(f.ivaCompraSupuesto, false);
  assert.strictEqual(f.costoMercaderia, 5785.12); // factura: neto, sin su IVA
  assert.strictEqual(f.tipoComprobanteUltimaCompra, 'factura');
  assert.strictEqual(f.fechaUltimaCompra, '2026-09-20');
});

test('filaCostos: alícuota faltante → se divide por 1,21 y queda ivaCompraSupuesto', () => {
  const f = filaCostos({ IdProducto: 3, CostoSistema: 1210, IvaCompraPct: null });
  assert.strictEqual(f.costoSistema, 1000);
  assert.strictEqual(f.ivaCompraSupuesto, true);
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

// ── Precio final con el IVA del producto ─────────────────────────────────────

test('costo de sistema: el precio final queda igual que antes (Ccon × (1 + m) = Cneto × (1 + m) × (1 + IVA))', () => {
  const precioCosto = 8228; // con IVA
  const antes = Math.round(precioCosto * 1.4 / 50) * 50; // regla 2026-09-30: costo tal cual × (1 + markup)
  const neto = filaCostos({ IdProducto: 1, CostoSistema: precioCosto, IvaCompraPct: 21 }).costoSistema; // 6800
  const r = costearAlmacen({ costoMercaderia: neto, markupPct: 40, ivaPct: 21 });
  assert.strictEqual(neto, 6800);
  assert.strictEqual(r.precioNeto, 9520);
  assert.strictEqual(r.precioConIvaExacto, 11519.2); // 9520 + IVA 1999,20
  assert.strictEqual(r.precioConIva, antes); // 11500
});

test('cotización: el neto lleva IVA de venta → el sugerido sube 21 % contra la regla vieja', () => {
  const r = costearAlmacen({ costoMercaderia: 6800, markupPct: 40, ivaPct: 21 });
  assert.strictEqual(r.precioConIva, 11500); // antes 9500 (6800 × 1,4 sin IVA)
});

test('markupParaPrecio: precio ÷ (1 + alícuota) ÷ costo neto − 1', () => {
  assert.strictEqual(markupParaPrecio(1000, 1210), 0);
  assert.strictEqual(markupParaPrecio(6800, 11519.2), 40);
  assert.strictEqual(markupParaPrecio(1000, 1105, 10.5), 0);
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
  const inicial = { toleranciaPct: 10, margenPorProducto: { 100: 40, 999: 25 }, metodoGanancia: 'curva', margenPropio: 'ganancia', precioFinalConceptos: 'conceptos' }; // ya en curva y ganancia: sólo esta migración
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
  const ya = routerParaMigrar(t, { baseCosto: 'siga', margenPorProducto: { 100: 40 }, metodoGanancia: 'curva', margenPropio: 'ganancia', precioFinalConceptos: 'conceptos' });
  await correrMigracion(t);
  assert.deepStrictEqual(ya.guardados, []);
  t.mock.timers.reset();
  const roto = routerParaMigrar(t, undefined);
  await correrMigracion(t);
  assert.deepStrictEqual(roto.guardados, []);
});
