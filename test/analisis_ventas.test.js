const test = require('node:test');
const assert = require('node:assert');
const {
  SUCURSALES_ANALISIS, NOMBRE_DIA,
  sucIdsSeguras, clampTopN, ticketProm, kpisGlobales, mapDiaSemana,
} = require('../analisis_ventas');

test('SUCURSALES_ANALISIS es la whitelist fija', () => {
  assert.deepStrictEqual(SUCURSALES_ANALISIS, [2, 3, 4, 5, 7, 9, 10]);
});

test('sucIdsSeguras filtra a la whitelist e ignora ids ajenos', () => {
  assert.deepStrictEqual(sucIdsSeguras('2,3,999,1'), [2, 3]); // 999 y 1 (central) fuera
});

test('sucIdsSeguras sin input devuelve whitelist completa', () => {
  assert.deepStrictEqual(sucIdsSeguras(undefined), [2, 3, 4, 5, 7, 9, 10]);
  assert.deepStrictEqual(sucIdsSeguras(''), [2, 3, 4, 5, 7, 9, 10]);
});

test('sucIdsSeguras con solo ids inválidos cae a whitelist completa', () => {
  assert.deepStrictEqual(sucIdsSeguras('1,999'), [2, 3, 4, 5, 7, 9, 10]);
});

test('clampTopN limita a 1..100 con default 20', () => {
  assert.strictEqual(clampTopN(undefined), 20);
  assert.strictEqual(clampTopN('50'), 50);
  assert.strictEqual(clampTopN('0'), 1);
  assert.strictEqual(clampTopN('9999'), 100);
  assert.strictEqual(clampTopN('abc'), 20);
});

test('ticketProm divide y evita división por cero', () => {
  assert.strictEqual(ticketProm(1000, 4), 250);
  assert.strictEqual(ticketProm(1000, 0), 0);
});

test('mapDiaSemana mapea 0=Lunes .. 6=Domingo', () => {
  assert.strictEqual(mapDiaSemana(0), 'Lunes');
  assert.strictEqual(mapDiaSemana(6), 'Domingo');
});

test('kpisGlobales agrega comparativa y suma resumen de renglón', () => {
  const comparativa = [
    { IdSucursal: 2, Nombre: 'Urquiza', Facturacion: 600, Tickets: 3 },
    { IdSucursal: 3, Nombre: 'Nación',  Facturacion: 400, Tickets: 1 },
  ];
  const resumen = { Unidades: 120, ProductosDistintos: 45 };
  const k = kpisGlobales(comparativa, resumen);
  assert.strictEqual(k.facturacion, 1000);
  assert.strictEqual(k.tickets, 4);
  assert.strictEqual(k.ticketProm, 250);
  assert.strictEqual(k.unidades, 120);
  assert.strictEqual(k.productosDistintos, 45);
});

const {
  whereVentas, sqlComparativa, sqlResumenRenglon,
  sqlTendencia, sqlDiaSemana, sqlHora, sqlTopProductos,
} = require('../analisis_ventas');

const P = { desde: '2026-07-01', hasta: '2026-07-17', sucIdsCsv: '2,3,4,5,7,9,10' };

test('whereVentas incluye los filtros comunes obligatorios', () => {
  const w = whereVentas(P);
  assert.match(w, /v\.Fecha >= '2026-07-01 00:00:00'/);
  assert.match(w, /v\.Fecha <= '2026-07-17 23:59:59'/);
  assert.match(w, /IdEstadoComprobante,''\) != 'ANULADO'/);
  assert.match(w, /v\.IdSucursal IN \(2,3,4,5,7,9,10\)/);
  assert.match(w, /NombreCategoria,''\) != 'SUCURSAL'/);
});

test('sqlComparativa agrupa por sucursal a nivel cabecera (sin VentasProductos)', () => {
  const s = sqlComparativa(P);
  assert.match(s, /FROM Ventas v/);
  assert.doesNotMatch(s, /VentasProductos/);
  assert.match(s, /SUM\(v\.ImporteTotal\) AS Facturacion/);
  assert.match(s, /COUNT\(\*\) AS Tickets/);
  assert.match(s, /GROUP BY v\.IdSucursal, s\.Nombre/);
});

test('sqlResumenRenglon suma unidades y cuenta productos distintos', () => {
  const s = sqlResumenRenglon(P);
  assert.match(s, /FROM VentasProductos vp/);
  assert.match(s, /SUM\(vp\.Cantidad\) AS Unidades/);
  assert.match(s, /COUNT\(DISTINCT vp\.IdProducto\) AS ProductosDistintos/);
});

test('sqlTendencia agrupa por día calendario', () => {
  assert.match(sqlTendencia(P), /GROUP BY CAST\(v\.Fecha AS DATE\)/);
});

test('sqlDiaSemana normaliza el día independiente de DATEFIRST (0=Lunes)', () => {
  assert.match(sqlDiaSemana(P), /\(DATEPART\(WEEKDAY, v\.Fecha\) \+ @@DATEFIRST - 2\) % 7/);
});

test('sqlHora agrupa por hora del día', () => {
  assert.match(sqlHora(P), /DATEPART\(HOUR, v\.Fecha\)/);
});

test('sqlTopProductos ordena por la métrica y limita con TOP', () => {
  const u = sqlTopProductos(P, 'unidades', 20);
  assert.match(u, /SELECT TOP 20/);
  assert.match(u, /ORDER BY Unidades DESC/);
  const f = sqlTopProductos(P, 'facturacion', 10);
  assert.match(f, /SELECT TOP 10/);
  assert.match(f, /ORDER BY Facturacion DESC/);
  assert.match(f, /INNER JOIN Productos p ON p\.IdProducto = vp\.IdProducto/);
});
