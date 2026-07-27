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
  assert.match(w, /UPPER\(ISNULL\(cat\.NombreCategoria,''\)\) != 'SUCURSAL'/);
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

const {
  sqlArticulosHistograma, sqlArticulosPorSucursal, bucketsArticulos, promedioArticulos,
} = require('../analisis_ventas');

test('sqlArticulosHistograma cuenta renglones por comprobante y agrupa por ese N', () => {
  const s = sqlArticulosHistograma(P);
  assert.match(s, /GROUP BY vp\.IdSucursal, vp\.IdTipoComprobante, vp\.Letra, vp\.CentroEmisor, vp\.NumeroComprobante/);
  assert.match(s, /GROUP BY t\.Articulos/);
  assert.match(s, /ORDER BY t\.Articulos/);
});

test('sqlArticulosPorSucursal promedia artículos/ticket por sucursal', () => {
  const s = sqlArticulosPorSucursal(P);
  assert.match(s, /CAST\(SUM\(t\.Articulos\) AS FLOAT\) \/ COUNT\(\*\) AS Promedio/);
  assert.match(s, /LEFT JOIN Sucursales s ON s\.IdSucursal = t\.IdSucursal/);
  assert.match(s, /ORDER BY Promedio DESC/);
});

test('sqlArticulosPorSucursal calcula tickets diarios sobre los días con ventas', () => {
  const s = sqlArticulosPorSucursal(P);
  assert.match(s, /MIN\(CAST\(v\.Fecha AS DATE\)\) AS Fecha/);
  assert.match(s, /COUNT\(DISTINCT t\.Fecha\) AS Dias/);
  assert.match(s, /CAST\(COUNT\(\*\) AS FLOAT\) \/ NULLIF\(COUNT\(DISTINCT t\.Fecha\), 0\) AS TicketsDia/);
});

test('bucketsArticulos colapsa el histograma exacto en los buckets fijos', () => {
  const hist = [
    { Articulos: 1, Tickets: 10 }, { Articulos: 2, Tickets: 5 },
    { Articulos: 7, Tickets: 3 }, { Articulos: 9, Tickets: 2 },
    { Articulos: 15, Tickets: 4 },
  ];
  const b = bucketsArticulos(hist);
  assert.deepStrictEqual(b.map(x => x.label), ['1-3','4-5','6-7','8-9','+10']);
  assert.strictEqual(b.find(x => x.label === '1-3').tickets, 15); // 10 + 5
  assert.strictEqual(b.find(x => x.label === '6-7').tickets, 3);
  assert.strictEqual(b.find(x => x.label === '8-9').tickets, 2);
  assert.strictEqual(b.find(x => x.label === '+10').tickets, 4);
  assert.strictEqual(b.find(x => x.label === '4-5').tickets, 0);
});

test('bucketsArticulos tolera entrada vacía o nula', () => {
  assert.strictEqual(bucketsArticulos([]).reduce((a, x) => a + x.tickets, 0), 0);
  assert.strictEqual(bucketsArticulos(null).length, 5);
});

const { familiaNombre, claveFamilia, agruparFamilias } = require('../analisis_ventas');

test('familiaNombre recorta presentación, múltiplo y variantes pack/bulto', () => {
  assert.strictEqual(familiaNombre('MIEL PURA 500G'), 'MIEL PURA');
  assert.strictEqual(familiaNombre('MIEL PURA 1KG'), 'MIEL PURA');
  assert.strictEqual(familiaNombre('MIEL PURA PACK 6'), 'MIEL PURA');
  assert.strictEqual(familiaNombre('ALMENDRA TOSTADA X 1 KG'), 'ALMENDRA TOSTADA');
  assert.strictEqual(familiaNombre('ALMENDRA TOSTADA X12'), 'ALMENDRA TOSTADA');
});

test('familiaNombre deja intacto lo que no tiene presentación y no devuelve vacío', () => {
  assert.strictEqual(familiaNombre('NUEZ MARIPOSA'), 'NUEZ MARIPOSA');
  assert.strictEqual(familiaNombre('1KG'), '1KG'); // dato sucio: no puede desaparecer
  assert.strictEqual(familiaNombre(null), '');
});

test('claveFamilia ignora acentos, mayúsculas y espacios de más', () => {
  assert.strictEqual(claveFamilia('Miel  Púra'), claveFamilia('MIEL PURA'));
});

test('agruparFamilias suma presentaciones y ordena por facturación', () => {
  const rows = [
    { IdProducto: 1, Nombre: 'MIEL PURA 500G', Unidades: 10, Facturacion: 1000 },
    { IdProducto: 2, Nombre: 'Miel Pura 1Kg',  Unidades: 5,  Facturacion: 1500 },
    { IdProducto: 3, Nombre: 'NUEZ MARIPOSA',  Unidades: 2,  Facturacion: 800 },
  ];
  const fams = agruparFamilias(rows, 10);
  assert.strictEqual(fams.length, 2);
  assert.strictEqual(fams[0].familia, 'MIEL PURA');
  assert.strictEqual(fams[0].unidades, 15);
  assert.strictEqual(fams[0].facturacion, 2500);
  assert.strictEqual(fams[0].presentaciones.length, 2);
  assert.strictEqual(fams[0].presentaciones[0].nombre, 'Miel Pura 1Kg'); // mayor facturación
  assert.strictEqual(fams[1].familia, 'NUEZ MARIPOSA');
});

test('agruparFamilias respeta topN, descarta nombres vacíos y tolera nulo', () => {
  const rows = [
    { IdProducto: 1, Nombre: 'A 1KG', Unidades: 1, Facturacion: 300 },
    { IdProducto: 2, Nombre: 'B 1KG', Unidades: 1, Facturacion: 200 },
    { IdProducto: 3, Nombre: '',      Unidades: 9, Facturacion: 999 },
  ];
  const fams = agruparFamilias(rows, 1);
  assert.strictEqual(fams.length, 1);
  assert.strictEqual(fams[0].familia, 'A');
  assert.deepStrictEqual(agruparFamilias(null, 5), []);
});

test('promedioArticulos divide artículos totales por tickets totales', () => {
  const porSuc = [
    { Tickets: 4, Articulos: 12 }, { Tickets: 1, Articulos: 3 },
  ];
  assert.strictEqual(promedioArticulos(porSuc), 3); // 15 / 5
  assert.strictEqual(promedioArticulos([]), 0);
});
