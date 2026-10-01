'use strict';
// Orden de tablas de Precios (public/js/precios_orden.js): helpers puros, sin DOM.
const test = require('node:test');
const assert = require('node:assert');
const o = require('../public/js/precios_orden.js');

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
  // El precio sugerido ya no es columna del listado general (sigue en el modal y en el export).
  assert.strictEqual(cols.sugerido, undefined);
  assert.deepStrictEqual(o.ordenarCon(filas, null, cols), filas); // sin orden = original
});

test('columnasAlmacen: código numérico (PLU) y nombre con acentos', () => {
  const cols = o.columnasAlmacen(() => 'ok');
  const filas = [{ plu: '6051', nombre: 'Ñoquis' }, { plu: '100', nombre: 'arroz' }, { plu: '91031', nombre: 'Azúcar' }];
  assert.deepStrictEqual(plus(o.ordenarCon(filas, { clave: 'plu', dir: 'asc' }, cols)), ['100', '6051', '91031']);
  assert.deepStrictEqual(plus(o.ordenarCon(filas, { clave: 'nombre', dir: 'asc' }, cols)), ['100', '91031', '6051']);
});

test('columnasFracc: #presentaciones, costo null si no hay costo base, sin columna sugerido', () => {
  const cols = o.columnasFracc({ estadoGrupo: () => 'ok', peorPresentacion: g => g.presentaciones[0] || null });
  const g = { granelPlu: '1', costoBase: null, costoTotal: 5, presentaciones: [{ precioConIva: 900, deltaPct: -3 }, { precioConIva: null }, { precioConIva: 700 }] };
  assert.strictEqual(cols.sugerido, undefined);
  assert.strictEqual(cols.presentaciones(g), 3);
  assert.strictEqual(cols.costo(g), null);
  assert.strictEqual(cols.delta(g), -3);
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

// ── Fecha de actualización del precio (HistorialPrecios) ──────────────────────
test('fmtFechaPrecio: YYYY-MM-DD → dd/mm/aaaa; null o basura → —', () => {
  assert.strictEqual(o.fmtFechaPrecio('2026-03-07'), '07/03/2026');
  assert.strictEqual(o.fmtFechaPrecio(null), '—');
  assert.strictEqual(o.fmtFechaPrecio(''), '—');
  assert.strictEqual(o.fmtFechaPrecio('x'), '—');
});

test('esPrecioViejo: más de DIAS_PRECIO_VIEJO días contra hoy; null no es viejo', () => {
  const hoy = new Date(2026, 8, 29); // 29/09/2026
  assert.strictEqual(o.DIAS_PRECIO_VIEJO, 90);
  assert.strictEqual(o.esPrecioViejo('2026-07-01', hoy), false); // 90 días justos
  assert.strictEqual(o.esPrecioViejo('2026-06-30', hoy), true);  // 91
  assert.strictEqual(o.esPrecioViejo('2026-09-29', hoy), false);
  assert.strictEqual(o.esPrecioViejo(null, hoy), false);
});

test('rangoFechas: más antigua y más reciente ignorando nulls; sin fechas → null', () => {
  assert.deepStrictEqual(o.rangoFechas(['2026-05-01', null, '2025-12-31', '2026-09-01']), { min: '2025-12-31', max: '2026-09-01' });
  assert.deepStrictEqual(o.rangoFechas(['2026-05-01']), { min: '2026-05-01', max: '2026-05-01' });
  assert.strictEqual(o.rangoFechas([null, undefined]), null);
  assert.strictEqual(o.rangoFechas([]), null);
});

test('columna fecha ordenable en todas las tablas: por producto y por grupo (la más antigua)', () => {
  const asc = { clave: 'fecha', dir: 'asc' };
  const filas = [{ plu: 'a', fechaPrecio: '2026-05-01' }, { plu: 'b', fechaPrecio: null }, { plu: 'c', fechaPrecio: '2025-01-10' }];
  assert.deepStrictEqual(plus(o.ordenarCon(filas, asc, o.columnasAlmacen(() => 'ok'))), ['c', 'a', 'b']);
  assert.deepStrictEqual(plus(o.ordenarCon(filas, asc, o.columnasPresFracc(() => 'ok'))), ['c', 'a', 'b']);
  const presProd = o.columnasPresProd({ estadoFila: () => 'ok', nombreVariedad: () => '', kgDe: () => 0, empaqueDe: () => 0 });
  assert.deepStrictEqual(plus(o.ordenarCon(filas, asc, presProd)), ['c', 'a', 'b']);
  const fracc = o.columnasFracc({ estadoGrupo: () => 'ok', peorPresentacion: () => null });
  assert.strictEqual(fracc.fecha({ presentaciones: [{ fechaPrecio: '2026-05-01' }, { fechaPrecio: '2024-02-02' }, { fechaPrecio: null }] }), '2024-02-02');
  assert.strictEqual(fracc.fecha({ presentaciones: [] }), null);
  const selector = o.columnasSelectorProd();
  assert.strictEqual(selector.fecha({ exportables: [{ fechaPrecio: '2026-01-02' }, { fechaPrecio: '2025-06-30' }] }), '2025-06-30');
  assert.strictEqual(selector.fecha({}), null);
});

// ── Aviso "Factura hoy" (compra cargada hoy vs. la anterior) ────────────────────
test('textoCompraHoy: sube → rojo con ▲ y la compra anterior; tooltip con proveedor, comprobante y fechas', () => {
  const a = o.textoCompraHoy({ costo: 1234, proveedor: 'Prov SA', comprobante: 'A-0003-00012345',
    costoAnterior: 1137.3, fechaAnterior: '2026-09-12', deltaPct: 8.5, tendencia: 'sube' });
  assert.strictEqual(a.texto, 'Factura hoy $ 1.234 ▲ +8,5% (antes $ 1.137 · 12/09)');
  assert.strictEqual(a.tipo, 'sube');
  assert.match(a.tip, /Prov SA/);
  assert.match(a.tip, /A-0003-00012345/);
  assert.match(a.tip, /12\/09\/2026/);
  assert.match(a.tip, /factura: neto \+ IVA; cotización: tal cual/);
  // compra de hoy por cotización (ahora entra): el aviso lo dice
  assert.match(o.textoCompraHoy({ costo: 500, tipoComprobante: 'cotización', tendencia: 'sin-anterior' }).texto, /^Cotización hoy \$ 500/);
});

test('textoCompraHoy: baja ▼, igual sin flecha de color, sin anterior; costos chicos con centavos', () => {
  const baja = o.textoCompraHoy({ costo: 95.5, costoAnterior: 100, fechaAnterior: '2026-01-02', deltaPct: -4.5, tendencia: 'baja' });
  assert.strictEqual(baja.texto, 'Factura hoy $ 95,50 ▼ -4,5% (antes $ 100 · 02/01)');
  assert.strictEqual(baja.tipo, 'baja');
  const igual = o.textoCompraHoy({ costo: 1000, costoAnterior: 1000, fechaAnterior: '2026-09-01', deltaPct: 0, tendencia: 'igual' });
  assert.strictEqual(igual.texto, 'Factura hoy $ 1.000 = 0,0% (antes $ 1.000 · 01/09)');
  const sin = o.textoCompraHoy({ costo: 500, costoAnterior: null, fechaAnterior: null, deltaPct: null, tendencia: 'sin-anterior' });
  assert.strictEqual(sin.texto, 'Factura hoy $ 500 · sin compra anterior');
  assert.strictEqual(sin.tipo, 'sin-anterior');
  assert.match(sin.tip, /Proveedor: —/);
});

// ── Columnas "Costo sistema" y "Costo última compra" (Almacén y granel de Fraccionado) ──
const CH = { costo: 1100, proveedor: 'Prov SA', comprobante: 'A-0003-00012345', costoAnterior: 1000, fechaAnterior: '2026-09-12', deltaPct: 10, tendencia: 'sube' };

// Costos tal cual del server (ya valorizados: factura + IVA, cotización tal cual), sin × alícuota en el front.
test('ultimaCompraDe: la compra de hoy manda; si no, la última compra (valores tal cual); sin nada → null', () => {
  const hoy = o.ultimaCompraDe({ compraHoy: CH, precioUltimaCompra: 900, fechaUltimaCompra: '01/09/2026', proveedor: 'Otro' });
  assert.deepStrictEqual(hoy, { costo: 1100, hoy: true, tipo: null, proveedor: 'Prov SA', comprobante: 'A-0003-00012345', fecha: null,
    costoAnterior: 1000, fechaAnterior: '2026-09-12' });
  const vieja = o.ultimaCompraDe({ compraHoy: null, precioUltimaCompra: 900, fechaUltimaCompra: '01/09/2026', proveedor: 'Otro' });
  assert.deepStrictEqual(vieja, { costo: 900, hoy: false, tipo: null, proveedor: 'Otro', comprobante: null, fecha: '01/09/2026',
    costoAnterior: null, fechaAnterior: null });
  assert.strictEqual(o.ultimaCompraDe({ precioUltimaCompra: null }), null);
});

test('deltaUltimaVsSistema y tendenciaCosto: Δ% contra el costo de sistema con la tolerancia global', () => {
  assert.strictEqual(o.deltaUltimaVsSistema({ costoSistema: 1000, compraHoy: CH }), 10);
  assert.strictEqual(o.deltaUltimaVsSistema({ costoSistema: 1000, precioUltimaCompra: 955 }), -4.5);
  assert.strictEqual(o.deltaUltimaVsSistema({ costoSistema: null, precioUltimaCompra: 955 }), null);
  assert.strictEqual(o.deltaUltimaVsSistema({ costoSistema: 1000 }), null);
  assert.strictEqual(o.tendenciaCosto(10, 5), 'sube');
  assert.strictEqual(o.tendenciaCosto(-6, 5), 'baja');
  assert.strictEqual(o.tendenciaCosto(5, 5), 'igual');
  assert.strictEqual(o.tendenciaCosto(null, 5), null);
});

test('tipUltimaCompra: proveedor, comprobante y "antes" si es de hoy; fecha si es una compra vieja', () => {
  const tHoy = o.tipUltimaCompra(o.ultimaCompraDe({ compraHoy: CH }));
  assert.match(tHoy, /Prov SA/);
  assert.match(tHoy, /A-0003-00012345/);
  assert.match(tHoy, /hoy/);
  assert.match(tHoy, /antes \$ 1\.000 \(12\/09\/2026\)/);
  const tVieja = o.tipUltimaCompra(o.ultimaCompraDe({ precioUltimaCompra: 900, fechaUltimaCompra: '01/09/2026', proveedor: 'Otro' }));
  assert.match(tVieja, /Otro/);
  assert.match(tVieja, /01\/09\/2026/);
  assert.doesNotMatch(tVieja, /antes|Comprobante/);
});

test('columnas sistema y ultima ordenables en Almacén y Fraccionado', () => {
  const filas = [{ plu: 'a', costoSistema: 500, precioUltimaCompra: 700 }, { plu: 'b', costoSistema: null, precioUltimaCompra: null },
    { plu: 'c', costoSistema: 300, compraHoy: { costo: 900 }, precioUltimaCompra: 100 }];
  const alm = o.columnasAlmacen(() => 'ok');
  assert.deepStrictEqual(plus(o.ordenarCon(filas, { clave: 'sistema', dir: 'asc' }, alm)), ['c', 'a', 'b']);
  assert.deepStrictEqual(plus(o.ordenarCon(filas, { clave: 'ultima', dir: 'desc' }, alm)), ['c', 'a', 'b']);
  const fr = o.columnasFracc({ estadoGrupo: () => 'ok', peorPresentacion: () => null });
  assert.strictEqual(fr.sistema({ costoSistemaConIva: 42 }), 42);
  assert.strictEqual(fr.ultima({ precioUltimaCompra: 100 }), 100); // ya viene valorizada del server
});

test('ordenarPorUltimaCompra: mayor suba de la última compra vs. sistema primero, sin dato al final', () => {
  const filas = [{ plu: 'a', costoSistema: 1000, precioUltimaCompra: 1050 }, { plu: 'b', costoSistema: 1000 },
    { plu: 'c', costoSistema: 1000, compraHoy: { costo: 1200 } }, { plu: 'd', costoSistema: 1000, precioUltimaCompra: 900 }];
  assert.deepStrictEqual(plus(o.ordenarPorUltimaCompra(filas)), ['c', 'a', 'd', 'b']);
});

// Regla 2026-09-30: el server manda los costos tal cual (sistema = PrecioCosto; compra = factura + IVA o
// cotización tal cual) y las columnas muestran ese mismo valor, sin convertir por alícuota.
test('columnas de costo: sistema y última compra tal cual vienen del server (sin × alícuota)', () => {
  const f = { costoSistema: 1210, costoSistemaConIva: 1210, ivaCompraPct: 10.5, precioUltimaCompra: 1331, tipoComprobanteUltimaCompra: 'factura' };
  assert.strictEqual(o.costoSistemaDe(f), 1210);
  assert.strictEqual(o.costoSistemaDe({ costoSistemaConIva: 42 }), 42);
  assert.strictEqual(o.costoSistemaDe({ costoSistema: null }), null);
  assert.strictEqual(o.ultimaCompraDe(f).costo, 1331);
  assert.strictEqual(o.ultimaCompraDe(f).tipo, 'factura');
  const hoy = o.ultimaCompraDe({ ivaCompraPct: 10.5, compraHoy: { costo: 200, costoAnterior: 100, tipoComprobante: 'cotización' } });
  assert.deepStrictEqual([hoy.costo, hoy.costoAnterior, hoy.tipo], [200, 100, 'cotización']);
  assert.strictEqual(o.deltaUltimaVsSistema(f), 10); // (1331 − 1210) / 1210
  assert.match(o.tipUltimaCompra(o.ultimaCompraDe(f)), /Última compra \(factura\) · neto \+ IVA/);
  assert.match(o.tipUltimaCompra(hoy), /Cotización cargada hoy en SIGA · tal cual/);
});

// Paridad cliente = lib: el precio final del front (detalle Almacén / presentaciones Fraccionado) es el mismo
// que costearAlmacen/costearFraccionado + la regla "alineado exacto" de calcularFilaAlmacen.
test('precioFinalCli: igual que lib/precios_costeo (sin ×1,21, redondeo a $50, respeta el vigente exacto)', () => {
  const { costearAlmacen } = require('../lib/precios_costeo');
  for (const [costo, markup] of [[515, 40], [2297, 68.32], [1024.99, 33.3], [6800, 0], [100, -10]]) {
    const lib = costearAlmacen({ costoMercaderia: costo, markupPct: markup });
    const cli = o.precioFinalCli(lib.precioNeto, null);
    assert.deepStrictEqual([cli.exacto, cli.precio], [lib.precioConIvaExacto, lib.precioConIva], `${costo} × ${markup}`);
  }
  assert.deepStrictEqual(o.precioFinalCli(721, null), { exacto: 721, precio: 700 }); // 515 × 1,4
  assert.deepStrictEqual(o.precioFinalCli(3866.31, 3866), { exacto: 3866.31, precio: 3866 }); // alineado exacto
  assert.deepStrictEqual(o.precioFinalCli(3866.31, 4700), { exacto: 3866.31, precio: 3850 });
});
