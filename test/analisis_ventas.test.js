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

// ── Productos excluidos de casa central ──────────────────────────────────────
// Ventas que no son reales (cargas internas que salen por la caja de la central).
// El alcance es sólo el módulo de casa central: se activa pasando excProdCsv.
const { PRODUCTOS_EXCLUIDOS_CENTRAL, idsCsvSeguro: csvSeguroCentral } = require('../analisis_ventas');
const P_CENTRAL = {
  desde: '2026-07-01', hasta: '2026-07-17', sucIdsCsv: '1',
  excProdCsv: csvSeguroCentral(PRODUCTOS_EXCLUIDOS_CENTRAL),
};

// 302158: carga interna. 1 ("A Articulos Varios"): comodín administrativo.
test('los códigos que no son venta real están excluidos de casa central', () => {
  assert.deepStrictEqual(PRODUCTOS_EXCLUIDOS_CENTRAL, ['302158', '1']);
});

test('sin excProdCsv las consultas quedan iguales que antes (sucursales no cambian)', () => {
  [sqlComparativa(P), sqlTendencia(P), sqlDiaSemana(P), sqlHora(P)].forEach(s => {
    assert.match(s, /SUM\(v\.ImporteTotal\) AS Facturacion/);
    assert.match(s, /COUNT\(\*\) AS Tickets/);
    assert.doesNotMatch(s, /302158/);
  });
  [sqlResumenRenglon(P), sqlTopProductos(P, 'unidades', 20)].forEach(s => {
    assert.doesNotMatch(s, /302158/);
  });
});

test('las consultas de cabecera de casa central restan el importe del renglón excluido', () => {
  [sqlComparativa(P_CENTRAL), sqlTendencia(P_CENTRAL), sqlDiaSemana(P_CENTRAL), sqlHora(P_CENTRAL)]
    .forEach(s => {
      // El descuento sale de un derivado por comprobante, no de un JOIN a renglones (que
      // multiplicaría filas de cabecera y duplicaría la facturación).
      assert.match(s, /LEFT JOIN \(\s*SELECT vpe\.IdSucursal/);
      assert.match(s, /vpe\.IdProducto IN \('302158','1'\)/);
      assert.match(s, /SUM\(v\.ImporteTotal - ISNULL\(exc\.Importe, 0\)\) AS Facturacion/);
      // Un comprobante que sólo tenía el producto excluido queda en cero: no es un ticket.
      assert.match(s, /SUM\(CASE WHEN v\.ImporteTotal - ISNULL\(exc\.Importe, 0\) > 0 THEN 1 ELSE 0 END\) AS Tickets/);
    });
});

test('las consultas de renglón de casa central descartan el producto excluido', () => {
  const { sqlUnidadesPorSucursal, sqlArticulosHistograma, sqlArticulosPorSucursal } = require('../analisis_ventas');
  const consultas = [
    sqlResumenRenglon(P_CENTRAL), sqlTopProductos(P_CENTRAL, 'unidades', 20),
    sqlUnidadesPorSucursal(P_CENTRAL, ''), sqlArticulosHistograma(P_CENTRAL),
    sqlArticulosPorSucursal(P_CENTRAL),
  ];
  consultas.forEach(s => {
    assert.match(s, /vp\.IdProducto NOT IN \('302158','1'\)/);
  });
});

// El importe se resta con el neto del renglón más sus impuestos, la misma base que
// v.ImporteTotal de la cabecera. Con vp.ImporteTotal (sin IVA) el descuento quedaría corto.
// ── Rubros: casa central tiene su propio criterio ────────────────────────────
// "Almacen Bultos/Cajas" son 873 productos de venta real por bulto/pack, y el granel de
// depósito también se vende: excluirlos por rubro escondía ventas enteras del listado.
test('casa central sólo excluye Apicultura por rubro', () => {
  const { RUBROS_EXCLUIDOS_CENTRAL } = require('../analisis_ventas');
  assert.deepStrictEqual(RUBROS_EXCLUIDOS_CENTRAL, ['Apicultura']);
  const s = sqlTopProductos({ ...P_CENTRAL, rubrosExcluidos: RUBROS_EXCLUIDOS_CENTRAL }, 'facturacion', 20);
  assert.match(s, /IN \('Apicultura'\)/);
  assert.doesNotMatch(s, /AlmacenBultos\/Cajas/);
  assert.doesNotMatch(s, /PesablesDeposito/);
});

test('sin lista propia se usa el criterio de sucursales, que no cambia', () => {
  const s = sqlTopProductos(P, 'facturacion', 20);
  assert.match(s, /IN \('Bultos\/Cajas', 'AlmacenBultos\/Cajas', 'PesablesDeposito', 'Apicultura'\)/);
});

test('el descuento de casa central usa la misma base de importe que la cabecera', () => {
  const s = sqlComparativa(P_CENTRAL);
  assert.match(s, /SUM\(\(vpe\.ImporteTotalNeto \+ ISNULL\(vpe\.ImporteImpuesto, 0\) \+ ISNULL\(vpe\.ImporteImpuestoInterno, 0\)\)\) AS Importe/);
  // vpe.ImporteTotal es el neto sin IVA: restarlo dejaba corto el descuento del comprobante.
  assert.doesNotMatch(s, /SUM\(vpe\.ImporteTotal\)/);
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

// La facturación del renglón es el neto final más los impuestos, igual que v.ImporteTotal
// de la cabecera. vp.ImporteTotal es Precio × Cantidad SIN IVA: con esa columna el código
// 2544 (500 unidades) mostraba 1.638.430 contra 1.883.375 facturados en SIGA.
const EXPR_IMPORTE_RENGLON =
  /SUM\(\(vp\.ImporteTotalNeto \+ ISNULL\(vp\.ImporteImpuesto, 0\) \+ ISNULL\(vp\.ImporteImpuestoInterno, 0\)\)\) AS Facturacion/;

test('sqlTopProductos factura por el neto más impuestos, no por vp.ImporteTotal', () => {
  const f = sqlTopProductos(P, 'facturacion', 10);
  assert.match(f, EXPR_IMPORTE_RENGLON);
  assert.doesNotMatch(f, /SUM\(vp\.ImporteTotal\)/);
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

// ── Miel a granel en tambor ──────────────────────────────────────────────────
// Son 14 variedades ("Miel Granel En Tambor Acacia", "... Trebol", etc.) que sueltas
// arman 14 familias de una fila cada una. Van todas a MIEL APIDELTA, salvo el tambor
// de Arroyo (9712), que es de la línea Pago De Los Arroyos.
test('la miel en tambor entra en MIEL APIDELTA', () => {
  assert.strictEqual(familiaNombre('Miel Granel En Tambor Acacia', 9700), 'MIEL APIDELTA');
  assert.strictEqual(familiaNombre('Miel Granel En Tambor Trebol', 9711), 'MIEL APIDELTA');
  assert.strictEqual(familiaNombre('Miel Granel En Tambor De Sauce', 91204), 'MIEL APIDELTA');
  // Sin el id igual aplica: la excepción es por código, la regla general por nombre.
  assert.strictEqual(familiaNombre('Miel Granel En Tambor Monte'), 'MIEL APIDELTA');
});

// Pago De Los Arroyos es la otra línea de miel de la casa y se reporta junto con Apidelta:
// una sola familia de miel propia, en todas las tablas.
test('la línea Pago De Los Arroyos entra en MIEL APIDELTA', () => {
  assert.strictEqual(familiaNombre('Miel Pago De Los Arroyos 250G', 2324), 'MIEL APIDELTA');
  assert.strictEqual(familiaNombre('Miel Pago De Los Arroyos 250G Bulto', 2325), 'MIEL APIDELTA');
  // El tambor de Arroyo (9712) era la excepción de la regla del tambor: ya no lo es.
  assert.strictEqual(familiaNombre('Miel Granel En Tambor Arroyo', 9712), 'MIEL APIDELTA');
  assert.strictEqual(familiaNombre('Miel Granel En Tambor Arroyo', '9712'), 'MIEL APIDELTA');
  // Envasados y tambores de las dos líneas caen en la misma clave.
  assert.strictEqual(claveFamilia(familiaNombre('Miel Granel En Tambor Arroyo', 9712)),
    claveFamilia(familiaNombre('Miel Pago De Los Arroyos 250G', 2324)));
});

// La regla mira "miel ... tambor", no la palabra tambor suelta: en la base hay tambores
// vacíos (Apicultura) y otros granel que no son miel.
test('la regla del tambor no arrastra productos que no son miel', () => {
  assert.strictEqual(familiaNombre('Aceite Oliva Apidelta Tambor GRANEL', 3), 'Aceite Oliva Apidelta Tambor GRANEL');
  assert.strictEqual(familiaNombre('Tambores Usados ( 1 Uso)', 4863), 'Tambores Usados ( 1 Uso)');
  assert.strictEqual(familiaNombre('Vinagre Sidra Manzana Apidelta Tambor GRANEL', 91200),
    'Vinagre Sidra Manzana Apidelta Tambor GRANEL');
});

test('agruparFamilias junta los tambores y la línea Arroyos en una sola familia', () => {
  const rows = [
    { IdProducto: 9700, Nombre: 'Miel Granel En Tambor Acacia', Unidades: 2, Facturacion: 500 },
    { IdProducto: 9711, Nombre: 'Miel Granel En Tambor Trebol', Unidades: 1, Facturacion: 300 },
    { IdProducto: 9712, Nombre: 'Miel Granel En Tambor Arroyo', Unidades: 3, Facturacion: 100 },
    { IdProducto: 2324, Nombre: 'Miel Pago De Los Arroyos 250G', Unidades: 4, Facturacion: 200 },
  ];
  const fams = agruparFamilias(rows, 10);
  assert.strictEqual(fams.length, 1);
  assert.strictEqual(fams[0].familia, 'MIEL APIDELTA');
  assert.strictEqual(fams[0].unidades, 10);
  assert.strictEqual(fams[0].presentaciones.length, 4);
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

// ── Equivalente físico de la familia ─────────────────────────────────────────
// Sumar unidades entre presentaciones distintas no da una magnitud real: 2 tambores de
// 28Kg + 12 frascos de 1Kg no son "14" de nada. El equivalente en kilos sí es sumable.
const { pesoPresentacion } = require('../analisis_ventas');

test('pesoPresentacion lee la presentación del nombre y la lleva a kg o litros', () => {
  assert.deepStrictEqual(pesoPresentacion('Miel Alfalfa Apidelta 28Kg Granel'), { cantidad: 28, unidad: 'kg' });
  assert.deepStrictEqual(pesoPresentacion('Miel Alfalfa Apidelta 250G'), { cantidad: 0.25, unidad: 'kg' });
  assert.deepStrictEqual(pesoPresentacion('G. Chocolate Gold 40G'), { cantidad: 0.04, unidad: 'kg' });
  assert.deepStrictEqual(pesoPresentacion('Jugo Apidelta 900ML'), { cantidad: 0.9, unidad: 'l' });
  assert.deepStrictEqual(pesoPresentacion('Agua 2Lt'), { cantidad: 2, unidad: 'l' });
  // Coma decimal: "1,5Kg" es 1,5 y no 15.
  assert.deepStrictEqual(pesoPresentacion('Mix 1,5Kg'), { cantidad: 1.5, unidad: 'kg' });
});

test('pesoPresentacion toma la presentación y no el múltiplo del pack', () => {
  // El "x14u" es cuántas unidades trae el pack, no cuánto pesa cada una.
  assert.deepStrictEqual(pesoPresentacion('G. Chocolate Gold 250G Pack (x14u Precio x Unidad)'),
    { cantidad: 0.25, unidad: 'kg' });
  assert.deepStrictEqual(pesoPresentacion('Mix Cervecero 200G Bulto'), { cantidad: 0.2, unidad: 'kg' });
});

test('pesoPresentacion devuelve null cuando el nombre no dice peso ni volumen', () => {
  assert.strictEqual(pesoPresentacion('A Articulos Varios'), null);
  assert.strictEqual(pesoPresentacion('Pañales X 30 U'), null);
  assert.strictEqual(pesoPresentacion(''), null);
  assert.strictEqual(pesoPresentacion(null), null);
});

test('agruparFamilias suma el equivalente en kilos además de las unidades', () => {
  const rows = [
    { IdProducto: 1, Nombre: 'Miel Trebol Apidelta 28Kg Granel', Rubro: 'Almacen Bultos/Cajas', Unidades: 2,  Facturacion: 5000 },
    { IdProducto: 2, Nombre: 'Miel Eucaliptus Apidelta 1Kg',     Rubro: 'Almacen Bultos/Cajas', Unidades: 12, Facturacion: 3000 },
    { IdProducto: 3, Nombre: 'Miel Pradera Apidelta 10Kg',       Rubro: 'Almacen Bultos/Cajas', Unidades: 2,  Facturacion: 2000 },
  ];
  const [fam] = agruparFamilias(rows, 10);
  assert.strictEqual(fam.familia, 'MIEL APIDELTA');
  // 2×28 + 12×1 + 2×10 = 88 kg. Las unidades crudas (16) siguen ahí como dato secundario.
  assert.strictEqual(fam.kilos, 88);
  assert.strictEqual(fam.unidades, 16);
  assert.strictEqual(fam.litros, 0);
  // Cada presentación trae su propio equivalente para el detalle desplegable.
  const tambor = fam.presentaciones.find(p => /28Kg/.test(p.nombre));
  assert.strictEqual(tambor.kilos, 56);
});

// El fraccionado se vende por peso: la cantidad del renglón ya son kilos, se lea o no la
// presentación en el nombre.
test('agruparFamilias toma la cantidad como kilos en todo lo que se vende por peso', () => {
  const rows = [
    { IdProducto: 1, Nombre: 'Granola Suelta 1Kg', Rubro: 'Pesables Fraccionado', Unidades: 3, Facturacion: 900 },
    { IdProducto: 2, Nombre: 'Granola Suelta',     Rubro: 'Pesables Fraccionado', Unidades: 7, Facturacion: 100 },
  ];
  const [fam] = agruparFamilias(rows, 10);
  // 3 + 7: las dos son ventas por peso, así que la cantidad ya está en kilos.
  assert.strictEqual(fam.kilos, 10);
  assert.strictEqual(fam.unidades, 10);
  const suelta = fam.presentaciones.find(p => p.nombre === 'Granola Suelta');
  assert.strictEqual(suelta.kilos, 7);
});

test('agruparFamilias separa litros de kilos en vez de mezclarlos', () => {
  const rows = [
    { IdProducto: 1, Nombre: 'Jugo Apidelta 900ML', Rubro: 'Almacen Bultos/Cajas', Unidades: 10, Facturacion: 500 },
    { IdProducto: 2, Nombre: 'Jugo Apidelta 2Lt',   Rubro: 'Almacen Bultos/Cajas', Unidades: 3,  Facturacion: 400 },
  ];
  const [fam] = agruparFamilias(rows, 10);
  assert.strictEqual(fam.litros, 15); // 10×0,9 + 3×2
  assert.strictEqual(fam.kilos, 0);
});

// ── Top por cliente ──────────────────────────────────────────────────────────
// Una sola consulta a nivel cliente×producto: el total del cliente sale de sumar su
// detalle, así la fila y su desplegable no pueden discrepar.
const { sqlVentasPorClienteProducto, agruparClientes } = require('../analisis_ventas');

test('sqlVentasPorClienteProducto agrupa por cliente y producto con los filtros del módulo', () => {
  const s = sqlVentasPorClienteProducto({ ...P_CENTRAL, rubrosExcluidos: ['Apicultura'] });
  assert.match(s, /GROUP BY v\.IdCliente, LTRIM\(RTRIM\(ISNULL\(c\.NombreCliente,''\)\)\), vp\.IdProducto, p\.NombreProducto/);
  assert.match(s, /SUM\(vp\.Cantidad\) AS Unidades/);
  // Facturación por neto más impuestos, igual que el resto del módulo.
  assert.match(s, EXPR_IMPORTE_RENGLON);
  assert.doesNotMatch(s, /SUM\(vp\.ImporteTotal\)/);
  // Los tres filtros que definen el alcance de casa central.
  assert.match(s, /ISNULL\(c\.IdCategoria, 0\) != 5/);
  assert.match(s, /IN \('Apicultura'\)/);
  assert.match(s, /vp\.IdProducto NOT IN \('302158','1'\)/);
  // La marca viaja con el renglón: sin ella no se puede decir si el producto es propio.
  assert.match(s, /ISNULL\(mp\.NombreMarca,''\) AS Marca/);
  assert.match(s, /LEFT JOIN Marcas mp ON mp\.IdMarca = p\.IdMarca/);
});

// ── Marca propia ─────────────────────────────────────────────────────────────
// Ni la marca ni el nombre alcanzan solos: hay productos de la marca Apidelta que no la
// nombran (las mieles en tambor) y productos Apidelta cargados bajo marcas genéricas.
test('esProductoPropio reconoce la marca, sus variantes y el nombre', () => {
  const { esProductoPropio } = require('../analisis_ventas');
  // Por marca, incluidas las variantes de la línea.
  assert.strictEqual(esProductoPropio('Miel Granel En Tambor Acacia', 'Apidelta'), true);
  assert.strictEqual(esProductoPropio('Yerba Compuesta 1Kg', 'Apidelta Yerba'), true);
  // Por nombre, aunque la marca sea genérica.
  assert.strictEqual(esProductoPropio('Merm Apidelta Frutilla 420G', 'Mermeladas y Untables'), true);
  // La otra línea propia de la casa.
  assert.strictEqual(esProductoPropio('Miel Pago De Los Arroyos 250G', 'Generica'), true);
  // Reventa: ni la marca ni el nombre son propios.
  assert.strictEqual(esProductoPropio('Galletitas Surtidas 300G', 'Galletitas y Bizcochos'), false);
  // "Apidelta" tiene que ser el comienzo de la marca, no una coincidencia en el medio.
  assert.strictEqual(esProductoPropio('Frasco Vacio', 'Insumos Apidelta Terceros'), false);
  assert.strictEqual(esProductoPropio('', ''), false);
});

// Las granolas propias no dicen Apidelta: se cargan como "G." + variedad. La marca
// "Granolas" no alcanza porque ahí también están las de terceros.
test('esProductoPropio reconoce las granolas propias por el prefijo G.', () => {
  const { esProductoPropio } = require('../analisis_ventas');
  assert.strictEqual(esProductoPropio('G. Crunch 500G Caja 8u', 'Granolas'), true);
  assert.strictEqual(esProductoPropio('G. Chocolate Gold 40G', 'Granolas'), true);
  assert.strictEqual(esProductoPropio('G. KETO 250G Bulto (x14 Precio x Unidad)', 'Granolas'), true);
  assert.strictEqual(esProductoPropio('G. Crocante PEDIDOS', 'ADMINISTRACION'), true);
  // Granolas de terceros dentro de la misma marca: no son propias.
  assert.strictEqual(esProductoPropio('Granola Horneada Canela Natural Candy 250G', 'Granolas'), false);
  assert.strictEqual(esProductoPropio('Galletitas Granola Almendras Granix 145G', 'Galletitas y Bizcochos'), false);
  // El prefijo exige punto y una letra detrás: una G suelta no alcanza.
  assert.strictEqual(esProductoPropio('Gaseosa Cola 2Lt', 'Bebidas'), false);
  assert.strictEqual(esProductoPropio('G. 500G', 'Granolas'), false);
});

// Los mix de armado propio son seis variedades concretas. Ni la palabra "mix" ni la marca
// alcanzan: hay mix de reventa y las presentaciones de un mismo mix se reparten entre las
// marcas "Apidelta" y "Mix Frutos Secos" sin criterio.
test('esProductoPropio reconoce las seis variedades de mix propio', () => {
  const { esProductoPropio } = require('../analisis_ventas');
  assert.strictEqual(esProductoPropio('Mix Europeo 100Gs Bulto', 'Mix Frutos Secos'), true);
  assert.strictEqual(esProductoPropio('Mix Cervecero Pote 350G', 'Mix Frutos Secos'), true);
  assert.strictEqual(esProductoPropio('Mix Cerv. Prem. 200G Unidad Pack', 'Mix Frutos Secos'), true);
  assert.strictEqual(esProductoPropio('Mix Tropic. Pote 180G', 'Mix Frutos Secos'), true);
  // El catálogo escribe F.S y F.S., con uno o dos espacios: las tres formas son la misma.
  assert.strictEqual(esProductoPropio('Mix F.S Sin Pasas 500G', 'Apidelta'), true);
  assert.strictEqual(esProductoPropio('Mix F.S. Sin Pasas 10Kg Pack', 'Mix Frutos Secos'), true);
  assert.strictEqual(esProductoPropio('Mix F.S N&P 1Kg', 'Apidelta'), true);
  assert.strictEqual(esProductoPropio('Mix F.S  N&P 5Kg', 'Mix Frutos Secos'), true);
  assert.strictEqual(esProductoPropio('Mix F.S. N&P 10Kg Bulto', 'Mix Frutos Secos'), true);
  // "Tropic." no puede comerse "Tropical": el Iqf es fruta congelada de reventa.
  assert.strictEqual(esProductoPropio('Mix Tropical Iqf 1Kg', 'Frutos Congelados'), false);
  // Mix de reventa que no están en la lista de variedades propias.
  assert.strictEqual(esProductoPropio('Mix Chantilly Keuken 800G', 'Almacen Varios'), false);
  assert.strictEqual(esProductoPropio('Mix Costa De Mar Ruedo 65G', 'Condimentos'), false);
  assert.strictEqual(esProductoPropio('Mix Clasico Pote 400G', 'Navideños'), false);
});

test('agruparClientes cuenta familias propias distintas y marca los productos', () => {
  const rows = [
    // Dos presentaciones de la misma línea: una sola familia.
    { IdCliente: 'A', Cliente: 'Distri', IdProducto: 1, Nombre: 'Miel Eucalipto Apidelta 1Kg',  Marca: 'Apidelta Miel', Unidades: 2, Facturacion: 400 },
    { IdCliente: 'A', Cliente: 'Distri', IdProducto: 2, Nombre: 'Miel Acacia Apidelta 500G',    Marca: 'Apidelta Miel', Unidades: 4, Facturacion: 300 },
    // Otra familia propia, reconocida por nombre pese a la marca genérica.
    { IdCliente: 'A', Cliente: 'Distri', IdProducto: 3, Nombre: 'Merm Apidelta Frutilla 420G',  Marca: 'Mermeladas y Untables', Unidades: 5, Facturacion: 200 },
    // Reventa: no suma familias ni facturación propia.
    { IdCliente: 'A', Cliente: 'Distri', IdProducto: 4, Nombre: 'Galletitas Surtidas 300G',     Marca: 'Galletitas y Bizcochos', Unidades: 9, Facturacion: 100 },
  ];
  const [c] = agruparClientes(rows, 10);
  assert.strictEqual(c.familiasPropias, 2);
  assert.strictEqual(c.facturacionPropia, 900);
  assert.strictEqual(c.facturacion, 1000);
  const propios = c.productos.filter(p => p.propio).map(p => p.idProd);
  assert.deepStrictEqual(propios.sort(), [1, 2, 3]);
  // La familia viaja en el detalle para poder auditar el conteo desde el desplegable.
  assert.strictEqual(c.productos.find(p => p.idProd === 1).familia, 'MIEL APIDELTA');
  // El Set interno no se filtra al front.
  assert.strictEqual(c._famPropias, undefined);
});

test('agruparClientes deja en cero las familias propias de un cliente de pura reventa', () => {
  const rows = [
    { IdCliente: 'B', Cliente: 'Kiosco', IdProducto: 9, Nombre: 'Galletitas 300G', Marca: 'Galletitas y Bizcochos', Unidades: 1, Facturacion: 50 },
  ];
  const [c] = agruparClientes(rows, 10);
  assert.strictEqual(c.familiasPropias, 0);
  assert.strictEqual(c.facturacionPropia, 0);
  assert.strictEqual(c.productos[0].propio, false);
});

test('agruparClientes colapsa el detalle en clientes y ordena por facturación', () => {
  const rows = [
    { IdCliente: 'A', Cliente: 'Distribuidora Sur', IdProducto: 1, Nombre: 'Miel Pura 1Kg',  Unidades: 10, Facturacion: 1000 },
    { IdCliente: 'A', Cliente: 'Distribuidora Sur', IdProducto: 2, Nombre: 'Miel Pura 250G', Unidades: 4,  Facturacion: 200 },
    { IdCliente: 'B', Cliente: 'Kiosco Centro',     IdProducto: 1, Nombre: 'Miel Pura 1Kg',  Unidades: 3,  Facturacion: 300 },
  ];
  const cli = agruparClientes(rows, 10);
  assert.strictEqual(cli.length, 2);
  assert.strictEqual(cli[0].cliente, 'Distribuidora Sur');
  assert.strictEqual(cli[0].facturacion, 1200);
  assert.strictEqual(cli[0].unidades, 14);
  // Equivalente físico, mismo criterio que las familias: 10×1kg + 4×0,25kg.
  assert.strictEqual(cli[0].kilos, 11);
  assert.strictEqual(cli[0].productos.length, 2);
  // Detalle ordenado por facturación, como el desplegable de familias.
  assert.strictEqual(cli[0].productos[0].nombre, 'Miel Pura 1Kg');
  assert.strictEqual(cli[1].cliente, 'Kiosco Centro');
});

test('agruparClientes respeta topN, tolera nulo y agrupa el cliente sin nombre', () => {
  const rows = [
    { IdCliente: 'A', Cliente: 'Uno',  IdProducto: 1, Nombre: 'X 1Kg', Unidades: 1, Facturacion: 900 },
    { IdCliente: 'B', Cliente: 'Dos',  IdProducto: 1, Nombre: 'X 1Kg', Unidades: 1, Facturacion: 100 },
    { IdCliente: 'C', Cliente: '',     IdProducto: 1, Nombre: 'X 1Kg', Unidades: 5, Facturacion: 50 },
  ];
  assert.strictEqual(agruparClientes(rows, 1).length, 1);
  assert.deepStrictEqual(agruparClientes(null, 5), []);
  // Sin nombre no se descarta la venta: se muestra con una etiqueta para poder rastrearla.
  const sinNombre = agruparClientes(rows, 10).find(c => c.idCliente === 'C');
  assert.strictEqual(sinNombre.cliente, 'Sin cliente');
});

test('promedioArticulos divide artículos totales por tickets totales', () => {
  const porSuc = [
    { Tickets: 4, Articulos: 12 }, { Tickets: 1, Articulos: 3 },
  ];
  assert.strictEqual(promedioArticulos(porSuc), 3); // 15 / 5
  assert.strictEqual(promedioArticulos([]), 0);
});

// ── Familias consolidadas: central + sucursales en una sola tabla ────────────
const { sucIdsFamilias, fusionarProductos } = require('../analisis_ventas');

test('sucIdsFamilias distingue "no vino el filtro" de "ninguna sucursal"', () => {
  // Sin el parámetro entran todas: es el default de la pestaña al abrirse.
  assert.deepStrictEqual(sucIdsFamilias(undefined), [2, 3, 4, 5, 7, 9, 10]);
  // Vacío es una elección del usuario (destildó todos los chips), no un default.
  assert.deepStrictEqual(sucIdsFamilias(''), []);
  assert.deepStrictEqual(sucIdsFamilias('3,5'), [3, 5]);
});

test('sucIdsFamilias descarta ids fuera de la whitelist y basura', () => {
  // La central (1) no entra por acá: se pide con su propio flag.
  assert.deepStrictEqual(sucIdsFamilias('1,3,99'), [3]);
  assert.deepStrictEqual(sucIdsFamilias('abc'), []);
  assert.deepStrictEqual(sucIdsFamilias('3,3,5'), [3, 5]);
});

test('fusionarProductos suma el mismo producto vendido en los dos alcances', () => {
  const central = [{ IdProducto: '10', Nombre: 'MIEL PURA 500G', Unidades: 4, Facturacion: 1000 }];
  const sucursales = [{ IdProducto: '10', Nombre: 'MIEL PURA 500G', Unidades: 6, Facturacion: 1500 }];
  const fusionado = fusionarProductos(central, sucursales);
  assert.strictEqual(fusionado.length, 1);
  assert.strictEqual(fusionado[0].Unidades, 10);
  assert.strictEqual(fusionado[0].Facturacion, 2500);
});

test('fusionarProductos compara ids como string (bigint del driver vs número)', () => {
  const fusionado = fusionarProductos(
    [{ IdProducto: 10, Nombre: 'MIEL PURA 500G', Unidades: 1, Facturacion: 100 }],
    [{ IdProducto: '10', Nombre: 'MIEL PURA 500G', Unidades: 2, Facturacion: 200 }],
  );
  assert.strictEqual(fusionado.length, 1);
  assert.strictEqual(fusionado[0].Unidades, 3);
});

test('fusionarProductos mantiene separados los productos distintos y tolera listas vacías', () => {
  const fusionado = fusionarProductos(
    [{ IdProducto: '10', Nombre: 'MIEL PURA 500G', Unidades: 1, Facturacion: 100 }],
    [{ IdProducto: '11', Nombre: 'MIEL PURA 1KG', Unidades: 1, Facturacion: 300 }],
  );
  assert.strictEqual(fusionado.length, 2);
  assert.deepStrictEqual(fusionarProductos(), []);
  assert.deepStrictEqual(fusionarProductos(null, []), []);
});

test('agruparFamilias sin tope devuelve todas las familias, no las primeras 20', () => {
  // 25 familias distintas: con el tope por defecto quedarían 20.
  const rows = Array.from({ length: 25 }, (_, i) => ({
    IdProducto: String(i + 1), Nombre: `PRODUCTO${i} 500G`, Unidades: 1, Facturacion: 100 - i,
  }));
  assert.strictEqual(agruparFamilias(rows, 20).length, 20);
  assert.strictEqual(agruparFamilias(rows, Infinity).length, 25);
});

// ── Equivalente en kilos ─────────────────────────────────────────────────────
// Dos formas de vender la misma mercadería y por eso dos cuentas distintas:
//  · Bulto: paquete cerrado. Se venden N paquetes, así que los kilos salen de multiplicar
//    el contenido declarado en el nombre por la cantidad de paquetes.
//  · Todo lo demás: se vende por peso, así que la cantidad del renglón YA está en kilos.
// La columna suma las dos: son los kilos que salieron de la familia, vengan como vengan.
const FRACC = 'Pesables Fraccionado', BULTO = 'Almacen Bultos/Cajas';

test('agruparFamilias: MIX TROPIC suma los kilos de sucursales y los bultos de central', () => {
  const rows = [
    // Sucursales: se venden por peso, la cantidad ya son kilos.
    { IdProducto: '1', Nombre: 'MIX TROPIC 500G', Rubro: FRACC, Unidades: 10, Facturacion: 1000 },
    { IdProducto: '2', Nombre: 'MIX TROPIC 1KG',  Rubro: FRACC, Unidades: 4,  Facturacion: 800 },
    // Casa central: paquetes cerrados, hay que pesarlos.
    { IdProducto: '3', Nombre: 'MIX TROPIC 200G BULTO', Rubro: BULTO, Unidades: 6, Facturacion: 600 },
    { IdProducto: '4', Nombre: 'MIX TROPIC 1KG BULTO',  Rubro: BULTO, Unidades: 3, Facturacion: 900 },
  ];
  const [fam] = agruparFamilias(rows, 10);
  assert.strictEqual(fam.familia, 'MIX TROPIC');
  // 10 + 4 (por peso) + 6x0,2 = 1,2 + 3x1 = 3  ->  18,2 kg
  assert.strictEqual(fam.kilos, 18.2);
  // Las unidades son la suma cruda de lo vendido, sin convertir nada.
  assert.strictEqual(fam.unidades, 23);
});

test('agruparFamilias pesa el bulto por su contenido y el resto por la cantidad', () => {
  const [porPeso] = agruparFamilias([
    { IdProducto: '1', Nombre: 'ALMENDRA 500G', Rubro: FRACC, Unidades: 7.5, Facturacion: 100 },
  ], 10);
  // Se vende por peso: 7,5 es 7,5 kg. Multiplicar por el 0,5 del nombre sería inventar.
  assert.strictEqual(porPeso.kilos, 7.5);

  const [porPaquete] = agruparFamilias([
    { IdProducto: '2', Nombre: 'ALMENDRA 500G BULTO', Rubro: BULTO, Unidades: 7, Facturacion: 100 },
  ], 10);
  assert.strictEqual(porPaquete.kilos, 3.5); // 7 paquetes x 0,5 kg
});

test('agruparFamilias suma un bulto sin peso legible como la cantidad vendida', () => {
  const [fam] = agruparFamilias([
    { IdProducto: '1', Nombre: 'NUEZ SURTIDA BULTO', Rubro: BULTO, Unidades: 9, Facturacion: 100 },
  ], 10);
  // Sin contenido declarado no hay con qué multiplicar: queda la cantidad cruda.
  assert.strictEqual(fam.kilos, 9);
});

test('agruparFamilias no calcula equivalente para familias de otros rubros', () => {
  const [f] = agruparFamilias([
    { IdProducto: '1', Nombre: 'YERBA 500G', Rubro: 'Almacen', Unidades: 6, Facturacion: 100 },
  ], 10);
  assert.strictEqual(f.kilos, 0);
  assert.strictEqual(f.equivalenteAplica, false);
});

test('agruparFamilias separa litros de kilos también en los bultos', () => {
  const [fam] = agruparFamilias([
    { IdProducto: '1', Nombre: 'JUGO 900ML BULTO', Rubro: BULTO, Unidades: 10, Facturacion: 500 },
  ], 10);
  assert.strictEqual(fam.litros, 9);
  assert.strictEqual(fam.kilos, 0);
});

test('agruparFamilias compara el rubro sin espacios ni acentos', () => {
  const [f] = agruparFamilias([
    { IdProducto: '1', Nombre: 'ALMENDRA 500G BULTO', Rubro: 'almacen bultos / cajas', Unidades: 2, Facturacion: 100 },
  ], 10);
  assert.strictEqual(f.kilos, 1);
});

test('agruparFamilias sin rubro no mide: el producto no declara cómo se vende', () => {
  const [f] = agruparFamilias([
    { IdProducto: '1', Nombre: 'NUEZ 500G', Unidades: 2, Facturacion: 100 },
  ], 10);
  assert.strictEqual(f.equivalenteAplica, false);
  assert.strictEqual(f.kilos, 0);
});

// El rubro es la señal principal, pero no siempre está bien cargado: "Mix Tropic. 200G
// Unidad Bulto" se vende por paquete y aparecía con 98 unidades = 98 kg en vez de 19,6.
// Cuando el nombre declara que es bulto o pack, se pesa igual que si el rubro lo dijera.
test('agruparFamilias pesa por paquete cuando el nombre dice Bulto aunque el rubro no', () => {
  const [f] = agruparFamilias([
    { IdProducto: '1', Nombre: 'Mix Tropic. 200G Unidad Bulto', Rubro: FRACC, Unidades: 98, Facturacion: 100 },
  ], 10);
  assert.strictEqual(f.kilos, 19.6); // 98 paquetes x 0,2 kg
});

test('agruparFamilias pesa por paquete los nombres con Pack', () => {
  const [f] = agruparFamilias([
    { IdProducto: '1', Nombre: 'MIX TROPIC 500G PACK 6', Rubro: FRACC, Unidades: 4, Facturacion: 100 },
  ], 10);
  assert.strictEqual(f.kilos, 2); // 4 packs x 0,5 kg
});

test('agruparFamilias no confunde con bulto lo que se vende por peso', () => {
  const [f] = agruparFamilias([
    { IdProducto: '1', Nombre: 'MIX TROPIC 500G', Rubro: FRACC, Unidades: 12.5, Facturacion: 100 },
  ], 10);
  assert.strictEqual(f.kilos, 12.5); // la cantidad ya está en kilos
});

// "Unidad" en el nombre es la otra forma en que SIGA marca que el renglón cuenta paquetes
// y no kilos: Mix Cerv.Prem es un pesable cuyas ventas son todas de bultos, y sin esto sus
// paquetes se contaban como kilos.
test('agruparFamilias pesa por paquete los nombres con Unidad', () => {
  const [f] = agruparFamilias([
    { IdProducto: '1', Nombre: 'Mix Cerv.Prem. 200G Unidad', Rubro: FRACC, Unidades: 98, Facturacion: 100 },
  ], 10);
  assert.strictEqual(f.kilos, 19.6); // 98 paquetes x 0,2 kg
});

test('agruparFamilias mezcla paquetes y venta por peso en la misma familia', () => {
  const [f] = agruparFamilias([
    { IdProducto: '1', Nombre: 'MIX CERV PREM 200G Unidad', Rubro: FRACC, Unidades: 10,  Facturacion: 100 },
    { IdProducto: '2', Nombre: 'MIX CERV PREM 500G',        Rubro: FRACC, Unidades: 3.5, Facturacion: 100 },
  ], 10);
  // 10 paquetes x 0,2 = 2 kg, más 3,5 kg vendidos sueltos.
  assert.strictEqual(f.kilos, 5.5);
});

// ── Línea Molens ─────────────────────────────────────────────────────────────
// Toda la línea lleva "Molens" en el nombre, en cualquier posición, así que alcanza con
// buscar la palabra: sin esto cada sabor y cada presentación arma su propia familia.
test('los productos Molens arman una sola familia', () => {
  assert.strictEqual(familiaNombre('Galletitas Molens Vainilla 300G', 100), 'MOLENS');
  assert.strictEqual(familiaNombre('MOLENS CHOCOLATE 1KG', 101), 'MOLENS');
  assert.strictEqual(familiaNombre('Budin Molens', 102), 'MOLENS');
  // Con apóstrofo también: la marca aparece escrita de las dos formas.
  assert.strictEqual(familiaNombre("Galletitas Molen's Limon 300G", 103), 'MOLENS');
});

test('Molens no arrastra palabras que sólo lo contienen', () => {
  assert.strictEqual(familiaNombre('Molensina Harina 1KG', 104), 'Molensina Harina');
  assert.strictEqual(familiaNombre('Premolens Mix', 105), 'Premolens Mix');
});

test('agruparFamilias junta toda la línea Molens en una fila', () => {
  const fams = agruparFamilias([
    { IdProducto: '1', Nombre: 'Galletitas Molens Vainilla 300G', Unidades: 5, Facturacion: 500 },
    { IdProducto: '2', Nombre: 'Galletitas Molens Limon 300G',    Unidades: 3, Facturacion: 300 },
    { IdProducto: '3', Nombre: 'Budin Molens 400G',               Unidades: 2, Facturacion: 200 },
  ], 10);
  assert.strictEqual(fams.length, 1);
  assert.strictEqual(fams[0].familia, 'MOLENS');
  assert.strictEqual(fams[0].presentaciones.length, 3);
  assert.strictEqual(fams[0].unidades, 10);
});

// ── Litros vs kilos en la venta por volumen ──────────────────────────────────
// Lo que se vende por volumen trae la cantidad del renglón ya en litros. Antes se volcaba
// a kilos sin mirar la unidad del nombre y los aceites de oliva sumaban como si pesaran.
test('el aceite vendido por volumen suma litros, no kilos', () => {
  const [f] = agruparFamilias([
    { IdProducto: '1', Nombre: 'Aceite Oliva Apidelta 5L', Rubro: FRACC, Unidades: 20, Facturacion: 100 },
  ], 10);
  assert.strictEqual(f.litros, 20);
  assert.strictEqual(f.kilos, 0);
});

test('"Lt", "ML" y "cc" también marcan volumen', () => {
  const casos = [['Aceite Oliva Apidelta 5 Lt', 3], ['Aceite Oliva 500ML', 4], ['Esencia Vainilla 250cc', 6]];
  casos.forEach(([nombre, cant]) => {
    const [f] = agruparFamilias([{ IdProducto: '1', Nombre: nombre, Rubro: FRACC, Unidades: cant, Facturacion: 100 }], 10);
    assert.strictEqual(f.litros, cant, nombre);
    assert.strictEqual(f.kilos, 0, nombre);
  });
});

test('el bulto por volumen se pesa por su contenido en litros', () => {
  const [f] = agruparFamilias([
    { IdProducto: '1', Nombre: 'Aceite Oliva 500ML Unidad', Rubro: FRACC, Unidades: 12, Facturacion: 100 },
  ], 10);
  assert.strictEqual(f.litros, 6); // 12 envases x 0,5 L
  assert.strictEqual(f.kilos, 0);
});

test('una familia con volumen y peso los mantiene separados', () => {
  const [f] = agruparFamilias([
    { IdProducto: '1', Nombre: 'Aceite Oliva Apidelta 5L',  Rubro: FRACC, Unidades: 20, Facturacion: 300 },
    { IdProducto: '2', Nombre: 'Aceite Oliva Apidelta 1KG', Rubro: FRACC, Unidades: 4,  Facturacion: 200 },
  ], 10);
  assert.strictEqual(f.litros, 20);
  assert.strictEqual(f.kilos, 4);
});

test('sin unidad en el nombre la cantidad sigue contando como kilos', () => {
  const [f] = agruparFamilias([
    { IdProducto: '1', Nombre: 'Granola Suelta', Rubro: FRACC, Unidades: 7, Facturacion: 100 },
  ], 10);
  assert.strictEqual(f.kilos, 7);
  assert.strictEqual(f.litros, 0);
});
