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
  // Transferencias internas: también por id de categoría, no sólo por nombre.
  assert.match(w, /ISNULL\(c\.IdCategoria, 0\) != 5/);
});

test('whereVentas excluye la categoría Sucursal también en el alcance de casa central', () => {
  const w = whereVentas({ ...P, sucIdsCsv: '1' });
  assert.match(w, /v\.IdSucursal IN \(1\)/);
  assert.match(w, /UPPER\(ISNULL\(cat\.NombreCategoria,''\)\) != 'SUCURSAL'/);
  assert.match(w, /ISNULL\(c\.IdCategoria, 0\) != 5/);
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

// Envase, granel de depósito e insumos de apiario: nada de eso es venta de mostrador, así
// que no puede sumar unidades, entrar en los tops ni contar como artículo del ticket.
test('las consultas de renglón excluyen los rubros que no son venta', () => {
  const { sqlUnidadesPorSucursal, sqlArticulosHistograma, sqlArticulosPorSucursal } = require('../analisis_ventas');
  const consultas = [
    sqlResumenRenglon(P), sqlTopProductos(P, 'unidades', 20), sqlUnidadesPorSucursal(P, ''),
    sqlArticulosHistograma(P), sqlArticulosPorSucursal(P),
  ];
  consultas.forEach(s => {
    assert.match(s, /NOT EXISTS \(SELECT 1 FROM Productos pExc/);
    assert.match(s, /pExc\.IdProducto = vp\.IdProducto/);
    assert.match(s, /IN \('Bultos\/Cajas', 'AlmacenBultos\/Cajas', 'PesablesDeposito', 'Apicultura'\)/);
  });
});

// El nombre se compara sin espacios y con collation CI_AI: "Bultos / Cajas" y "Pesables
// Depósito" (con tilde) caen igual.
test('SIN_RUBROS_EXCLUIDOS normaliza el nombre del rubro antes de comparar', () => {
  const { SIN_RUBROS_EXCLUIDOS, RUBROS_EXCLUIDOS } = require('../analisis_ventas');
  assert.deepStrictEqual(RUBROS_EXCLUIDOS,
    ['Bultos/Cajas', 'Almacen Bultos/Cajas', 'Pesables Deposito', 'Apicultura']);
  assert.match(SIN_RUBROS_EXCLUIDOS, /REPLACE\(COALESCE\(rExc\.NombreRubro,''\),' ',''\) COLLATE Latin1_General_CI_AI/);
});

// El granel de depósito se excluye de las ventas, pero "Pesables Fraccionado" sigue siendo
// el rubro que marca a un producto como pesable para el umbral de quiebre.
test('la exclusión de Pesables Deposito no toca el rubro de pesables fraccionado', () => {
  const { sqlPesables, RUBROS_EXCLUIDOS } = require('../analisis_ventas');
  assert.match(sqlPesables(''), /NombreRubro = 'Pesables Fraccionado'/);
  assert.ok(!RUBROS_EXCLUIDOS.includes('Pesables Fraccionado'));
});

// La facturación y los tickets salen de la cabecera del comprobante: no hay renglón que
// filtrar ahí, así que estas consultas no llevan la exclusión.
test('las consultas de cabecera no arrastran el filtro de rubros', () => {
  [sqlComparativa(P), sqlTendencia(P), sqlDiaSemana(P), sqlHora(P)].forEach(s => {
    assert.doesNotMatch(s, /pExc/);
  });
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
  sqlMetaClasificacion, clasificacionesDisponibles, filtroSinInsumos,
} = require('../analisis_ventas');

// Esquema sintético: lo que devolvería INFORMATION_SCHEMA.COLUMNS en una base completa.
const META_COMPLETA = [
  { TABLE_NAME: 'Productos',  COLUMN_NAME: 'IdProducto' },
  { TABLE_NAME: 'Productos',  COLUMN_NAME: 'NombreProducto' },
  { TABLE_NAME: 'Productos',  COLUMN_NAME: 'IdRubro' },
  { TABLE_NAME: 'Productos',  COLUMN_NAME: 'IdSubRubro' },
  { TABLE_NAME: 'Productos',  COLUMN_NAME: 'IdMarca' },
  { TABLE_NAME: 'Rubros',     COLUMN_NAME: 'IdRubro' },
  { TABLE_NAME: 'Rubros',     COLUMN_NAME: 'NombreRubro' },
  { TABLE_NAME: 'SubRubros',  COLUMN_NAME: 'IdRubro' },
  { TABLE_NAME: 'SubRubros',  COLUMN_NAME: 'IdSubRubro' },
  { TABLE_NAME: 'SubRubros',  COLUMN_NAME: 'NombreSubRubro' },
  { TABLE_NAME: 'Marcas',     COLUMN_NAME: 'IdMarca' },
  { TABLE_NAME: 'Marcas',     COLUMN_NAME: 'NombreMarca' },
];

test('sqlMetaClasificacion consulta las tablas de clasificación y Productos', () => {
  const s = sqlMetaClasificacion();
  assert.match(s, /INFORMATION_SCHEMA\.COLUMNS/);
  ['Productos', 'Rubros', 'SubRubros', 'Marcas'].forEach(t => assert.match(s, new RegExp(`'${t}'`)));
});

test('clasificacionesDisponibles arma rubro, subrubro y marca con sus claves', () => {
  const disp = clasificacionesDisponibles(META_COMPLETA);
  assert.deepStrictEqual(disp.map(c => c.tabla), ['Rubros', 'SubRubros', 'Marcas']);
  assert.deepStrictEqual(disp[1].claves, ['IdRubro', 'IdSubRubro']);
});

test('clasificacionesDisponibles descarta tablas ausentes o sin clave común', () => {
  const sinMarcas = META_COMPLETA.filter(r => r.TABLE_NAME !== 'Marcas');
  assert.deepStrictEqual(clasificacionesDisponibles(sinMarcas).map(c => c.tabla), ['Rubros', 'SubRubros']);
  // Sin IdRubro/IdSubRubro en Productos no hay forma de correlacionar esas dos tablas.
  const huerfano = META_COMPLETA.filter(r => !(r.TABLE_NAME === 'Productos' && /^Id(Sub)?Rubro$/.test(r.COLUMN_NAME)));
  assert.deepStrictEqual(clasificacionesDisponibles(huerfano).map(c => c.tabla), ['Marcas']);
  assert.deepStrictEqual(clasificacionesDisponibles([]), []);
  assert.deepStrictEqual(clasificacionesDisponibles(null), []);
});

test('filtroSinInsumos excluye por nombre y por cada clasificación con NOT EXISTS', () => {
  const f = filtroSinInsumos(clasificacionesDisponibles(META_COMPLETA));
  assert.match(f, /UPPER\(COALESCE\(p\.NombreProducto,''\)\) NOT LIKE '%INSUMO%'/);
  assert.strictEqual((f.match(/NOT EXISTS/g) || []).length, 3);
  assert.match(f, /FROM Rubros rIns\s+WHERE rIns\.IdRubro = p\.IdRubro/);
  assert.match(f, /srIns\.IdRubro = p\.IdRubro AND srIns\.IdSubRubro = p\.IdSubRubro/);
  assert.match(f, /UPPER\(COALESCE\(mIns\.NombreMarca,''\)\) LIKE '%INSUMO%'/);
});

test('filtroSinInsumos sin clasificaciones filtra sólo por nombre de producto', () => {
  const f = filtroSinInsumos([]);
  assert.match(f, /NOT LIKE '%INSUMO%'/);
  assert.doesNotMatch(f, /NOT EXISTS/);
});

test('sqlTopProductos suma el filtro de insumos al WHERE y sin él queda igual', () => {
  const filtro = filtroSinInsumos(clasificacionesDisponibles(META_COMPLETA));
  const con = sqlTopProductos(P, 'unidades', 1000, filtro);
  assert.match(con, /AND UPPER\(COALESCE\(p\.NombreProducto,''\)\) NOT LIKE '%INSUMO%'/);
  assert.match(con, /GROUP BY vp\.IdProducto, p\.NombreProducto/);
  assert.strictEqual(sqlTopProductos(P, 'unidades', 1000, ''), sqlTopProductos(P, 'unidades', 1000));
});

const {
  idsCsvSeguro, sqlPesables, sqlStockPorSucursal, sqlNetoDiarioStock, sqlUnidadesPorSucursal,
  mesesDelRango, umbralQuiebre, diasEnQuiebre, serieStockDiaria,
  diasEvaluados, porcentajeQuiebre,
} = require('../analisis_ventas');

test('diasEvaluados excluye los domingos de la base del porcentaje', () => {
  const serie = serieStockDiaria({
    stockActual: 0, netosPorFecha: {},
    desde: '2026-07-04', hasta: '2026-07-06', hoy: '2026-07-06', umbral: 4,
  });
  assert.strictEqual(serie.length, 3);        // 04, 05 (domingo) y 06
  assert.strictEqual(diasEvaluados(serie), 2);
});

test('porcentajeQuiebre divide sobre la base y tolera base cero', () => {
  assert.strictEqual(porcentajeQuiebre(2, 8), 25);
  assert.strictEqual(porcentajeQuiebre(0, 26), 0);
  assert.strictEqual(porcentajeQuiebre(5, 0), 0);
});

test('idsCsvSeguro entrecomilla los ids, sin repetidos ni vacíos', () => {
  // IdProducto es varchar en SIGA: los códigos no numéricos deben sobrevivir.
  assert.strictEqual(idsCsvSeguro([12, '34', 12, 'O', null, '']), "'12','34','O'");
  assert.strictEqual(idsCsvSeguro([]), '');
  assert.strictEqual(idsCsvSeguro(null), '');
});

test('idsCsvSeguro duplica las comillas simples (escape de SQL Server)', () => {
  assert.strictEqual(idsCsvSeguro(["56'; DROP TABLE Productos --"]), "'56''; DROP TABLE Productos --'");
});

test('sqlPesables filtra por el rubro Pesables Fraccionado', () => {
  const csv = idsCsvSeguro([1, 2]);
  assert.match(sqlPesables(csv), /NombreRubro = 'Pesables Fraccionado'/);
  assert.match(sqlPesables(csv), /p\.IdProducto IN \('1','2'\)/);
  assert.doesNotMatch(sqlPesables(''), /IdProducto IN/);
});

test('sqlStockPorSucursal suma los depósitos de cada sucursal', () => {
  const s = sqlStockPorSucursal(idsCsvSeguro([7]), '2,3');
  assert.match(s, /SUM\(pd\.Stock\) AS Stock/);
  assert.match(s, /sd\.IdDeposito = pd\.IdDeposito AND sd\.IdSucursal = pd\.IdSucursal/);
  assert.match(s, /pd\.IdSucursal IN \(2,3\)/);
});

test('sqlNetoDiarioStock suma la cantidad ya firmada, sin coeficiente', () => {
  const s = sqlNetoDiarioStock('2026-07-01', '2', idsCsvSeguro([9]));
  assert.match(s, /SUM\(mp\.Cantidad\) AS Neto/);
  // Entradas aparte: el neto no alcanza para saber si ese día se repuso.
  assert.match(s, /SUM\(CASE WHEN mp\.Cantidad > 0 THEN mp\.Cantidad ELSE 0 END\) AS Entradas/);
  // El signo lo trae mp.Cantidad: tocar TiposMovimientos lo duplicaría o lo anularía.
  assert.doesNotMatch(s, /CoeficienteStock/);
  assert.doesNotMatch(s, /TiposMovimientos/);
  assert.match(s, /m\.FechaMovimiento >= '2026-07-01 00:00:00'/);
  assert.match(s, /GROUP BY mp\.IdProducto, m\.IdSucursal, CAST\(m\.FechaMovimiento AS DATE\)/);
});

test('sqlUnidadesPorSucursal abre las ventas por sucursal', () => {
  const s = sqlUnidadesPorSucursal(P, idsCsvSeguro([9]));
  assert.match(s, /GROUP BY vp\.IdProducto, vp\.IdSucursal/);
  assert.match(s, /vp\.IdProducto IN \('9'\)/);
  assert.match(s, /UPPER\(ISNULL\(cat\.NombreCategoria,''\)\) != 'SUCURSAL'/);
});

test('mesesDelRango cuenta sólo días hábiles y nunca da cero', () => {
  // 01 al 30 de julio 2026: 30 días menos 4 domingos (5, 12, 19 y 26) = 26 hábiles = 1 mes.
  assert.strictEqual(mesesDelRango('2026-07-01', '2026-07-30'), 1);
  assert.strictEqual(mesesDelRango('2026-07-01', '2026-07-01'), 1 / 26);
  // Un rango que cae entero en domingo igual da el piso de un día, no cero.
  assert.strictEqual(mesesDelRango('2026-07-05', '2026-07-05'), 1 / 26);
});

test('umbralQuiebre: pesable es 5% de la venta mensual, sin tope', () => {
  assert.strictEqual(umbralQuiebre(600, 2, true), 15);   // 300/mes -> 15
});

test('umbralQuiebre: no pesable topea ese 5% en 4 unidades', () => {
  assert.strictEqual(umbralQuiebre(600, 2, false), 4);   // 15 -> tope 4
  assert.strictEqual(umbralQuiebre(40, 1, false), 2);    // 5% de 40 = 2, por debajo del tope
  assert.strictEqual(umbralQuiebre(0, 1, false), 0);
});

test('diasEnQuiebre cuenta todos los días bajo el umbral, no rachas', () => {
  // cierre(03)=0; el 03 entraron 10 -> cierre(02)=-10 y cierre(01)=-10.
  const dias = diasEnQuiebre({
    stockActual: 0, netosPorFecha: { '2026-07-03': 10 },
    desde: '2026-07-01', hasta: '2026-07-03', hoy: '2026-07-03', umbral: 0,
  });
  assert.strictEqual(dias, 3);
});

test('diasEnQuiebre mira la apertura, no el cierre', () => {
  // El 03 abre en 20 -> no cuenta. El 02 entraron 18: cierra en 20 pero abrió en 2 -> cuenta.
  // El 01 cierra en 2 y no tuvo movimiento -> abrió en 2 -> cuenta.
  const dias = diasEnQuiebre({
    stockActual: 20, netosPorFecha: { '2026-07-02': 18 },
    desde: '2026-07-01', hasta: '2026-07-03', hoy: '2026-07-03', umbral: 4,
  });
  assert.strictEqual(dias, 2);
});

test('diasEnQuiebre no cuenta el día que abrió abastecido y cayó por sus propias ventas', () => {
  // Abrió en 30 y vendió 28: cierra bajo el umbral, pero estuvo abastecido toda la jornada.
  const serie = serieStockDiaria({
    stockActual: 2, netosPorFecha: { '2026-07-02': -28 },
    desde: '2026-07-02', hasta: '2026-07-02', hoy: '2026-07-02', umbral: 4,
  });
  assert.deepStrictEqual(serie, [
    { fecha: '2026-07-02', apertura: 30, cierre: 2, neto: -28, entrada: 0, domingo: false, quiebre: false },
  ]);
});

test('diasEnQuiebre no cuenta el día que recibió mercadería, aunque abriera corto', () => {
  // Abre en 0 (bajo umbral) pero ese día entraron 50: el faltante se resolvió.
  const serie = serieStockDiaria({
    stockActual: 20, netosPorFecha: { '2026-07-02': 20 }, entradasPorFecha: { '2026-07-02': 50 },
    desde: '2026-07-02', hasta: '2026-07-02', hoy: '2026-07-02', umbral: 4,
  });
  assert.strictEqual(serie[0].apertura, 0);
  assert.strictEqual(serie[0].quiebre, false);
});

test('diasEnQuiebre detecta la reposición aunque el neto del día quede negativo', () => {
  // Entraron 10 y se vendieron 30: neto -20, pero hubo mercadería -> no es quiebre.
  const serie = serieStockDiaria({
    stockActual: 0, netosPorFecha: { '2026-07-02': -20 }, entradasPorFecha: { '2026-07-02': 10 },
    desde: '2026-07-02', hasta: '2026-07-02', hoy: '2026-07-02', umbral: 4,
  });
  assert.strictEqual(serie[0].apertura, 20);
  assert.strictEqual(serie[0].quiebre, false);
});

test('diasEnQuiebre no cuenta los domingos, pero arrastra su stock', () => {
  const args = {
    stockActual: 0, netosPorFecha: {},
    desde: '2026-07-05', hasta: '2026-07-06', hoy: '2026-07-06', umbral: 4,
  };
  // 2026-07-05 es domingo; el 06 (lunes) abre igual de corto y sí cuenta.
  assert.deepStrictEqual(serieStockDiaria(args).map(d => [d.fecha, d.domingo, d.quiebre]), [
    ['2026-07-05', true, false],
    ['2026-07-06', false, true],
  ]);
  assert.strictEqual(diasEnQuiebre(args), 1);
});

test('diasEnQuiebre ignora los días posteriores al rango pero arrastra su stock', () => {
  // hoy=05 con stock 0; el 05 entraron 10 -> el 04 cerró en -10, y el rango termina el 04.
  const dias = diasEnQuiebre({
    stockActual: 0, netosPorFecha: { '2026-07-05': 10 },
    desde: '2026-07-04', hasta: '2026-07-04', hoy: '2026-07-05', umbral: 0,
  });
  assert.strictEqual(dias, 1);
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

test('familiaNombre junta todas las mieles Apidelta en una sola familia', () => {
  ['Miel Acacia Apidelta 10Kg', 'Miel Acacia Apidelta 10Kg Bulto', 'MIEL EUCALIPTO APIDELTA 500G',
   'Miel Milflores Apidelta 1Kg Pack'].forEach(n => {
    assert.strictEqual(familiaNombre(n), 'MIEL APIDELTA');
  });
});

test('familiaNombre deja fuera de MIEL APIDELTA lo que sólo menciona miel', () => {
  // El artículo suelto, sin marca, se sigue analizando por su cuenta.
  assert.strictEqual(familiaNombre('MIEL'), 'MIEL');
  assert.strictEqual(familiaNombre('MIEL 1KG'), 'MIEL');
  // Derivados: la miel es un ingrediente, no el producto.
  assert.strictEqual(familiaNombre('Aritos Con Miel 500G'), 'Aritos Con Miel');
  assert.strictEqual(familiaNombre('Merm Apidelta Frutilla Miel 330G'), 'Merm Apidelta Frutilla Miel');
  assert.strictEqual(familiaNombre('Jugo Arandanos Apidelta Con Miel 1Lt'), 'Jugo Arandanos Apidelta Con Miel');
  // Sin variedad en el medio no responde a la nomenclatura "Miel <variedad> Apidelta".
  assert.strictEqual(familiaNombre('Miel Apidelta 500G'), 'Miel Apidelta');
});

test('agruparFamilias colapsa variedades y presentaciones de miel Apidelta en una fila', () => {
  const rows = [
    { IdProducto: 1, Nombre: 'Miel Acacia Apidelta 10Kg',    Unidades: 2, Facturacion: 500 },
    { IdProducto: 2, Nombre: 'Miel Eucalipto Apidelta 500G', Unidades: 5, Facturacion: 300 },
    { IdProducto: 3, Nombre: 'MIEL 1KG',                     Unidades: 1, Facturacion: 100 },
  ];
  const fams = agruparFamilias(rows, 10);
  assert.strictEqual(fams.length, 2);
  assert.strictEqual(fams[0].familia, 'MIEL APIDELTA');
  assert.strictEqual(fams[0].unidades, 7);
  assert.strictEqual(fams[0].facturacion, 800);
  assert.strictEqual(fams[0].presentaciones.length, 2);
  assert.strictEqual(fams[1].familia, 'MIEL');
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
