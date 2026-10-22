'use strict';
// SQL de ventas/stock/facturación por PLU del catálogo de planificación. Movidas desde
// routes/rutas_plan.js sin cambios de texto: las usan el tablero (rutas_plan_tablero.js) y,
// hasta el Task 10, calcularSugerenciasCatalogo. Los PLU llegan validados como dígitos.
const { sqlExcluirSucursales, sqlExcluirCentral } = require('./sucursales_no_reales');

function sqlConsumoCatalogo(pluList, ventana) {
  // PromDiario usa días con ventas como denominador (no ventana fija)
  // Evita que stockouts depriman el promedio: si vendiste 551kg en 20/30 días → 551/20*30 = 826 real
  return `SELECT vp.IdProducto,
       SUM(vp.Cantidad) AS UnidVendidas,
       COUNT(DISTINCT CAST(v.Fecha AS DATE)) AS DiasConVenta,
       CAST(SUM(vp.Cantidad) AS DECIMAL(18,4))
         / NULLIF(COUNT(DISTINCT CAST(v.Fecha AS DATE)), 0) AS PromDiarioPorDia
FROM VentasProductos vp INNER JOIN Ventas v ON v.IdSucursal=vp.IdSucursal AND v.IdTipoComprobante=vp.IdTipoComprobante
  AND v.Letra=vp.Letra AND v.CentroEmisor=vp.CentroEmisor AND v.NumeroComprobante=vp.NumeroComprobante
LEFT  JOIN Clientes c ON c.IdCliente=v.IdCliente LEFT  JOIN Categorias cat ON cat.IdCategoria=c.IdCategoria
WHERE v.Fecha >= DATEADD(DAY,-${ventana},CAST(GETDATE() AS DATE)) AND v.Fecha < CAST(GETDATE() AS DATE)
  AND ${sqlExcluirSucursales('v.IdSucursal')} AND ${sqlExcluirCentral('v.IdSucursal')}
  AND ISNULL(v.IdEstadoComprobante,'') != 'ANULADO' AND UPPER(ISNULL(cat.NombreCategoria,'')) != 'SUCURSAL'
  AND vp.IdProducto IN (${pluList.join(',')}) GROUP BY vp.IdProducto`;
}
function sqlStockTodosDepositos(pluList) {
  return `SELECT pd.IdProducto, COALESCE(SUM(pd.Stock),0) AS StockActual FROM ProductosDepositos pd
INNER JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal
INNER JOIN Sucursales s ON s.IdSucursal=pd.IdSucursal
WHERE s.SoyLaCentral=1 AND ${sqlExcluirSucursales('pd.IdSucursal')} AND pd.IdProducto IN (${pluList.join(',')}) GROUP BY pd.IdProducto`;
}
function sqlStockSucursales(pluList) {
  // Stock en sucursales (todas menos Casa Central): SoyLaCentral=0
  return `SELECT pd.IdProducto, COALESCE(SUM(pd.Stock),0) AS StockActual FROM ProductosDepositos pd
INNER JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal
INNER JOIN Sucursales s ON s.IdSucursal=pd.IdSucursal
WHERE s.SoyLaCentral=0 AND ${sqlExcluirSucursales('pd.IdSucursal')} AND sd.DisponibleVenta=1 AND pd.IdProducto IN (${pluList.join(',')}) GROUP BY pd.IdProducto`;
}
function sqlFacturacionPorPlu(pluList, ventana) {
  return `SELECT vp.IdProducto, SUM(vp.ImporteTotal) AS TotalFacturado
FROM VentasProductos vp INNER JOIN Ventas v ON v.IdSucursal=vp.IdSucursal AND v.IdTipoComprobante=vp.IdTipoComprobante
  AND v.Letra=vp.Letra AND v.CentroEmisor=vp.CentroEmisor AND v.NumeroComprobante=vp.NumeroComprobante
LEFT JOIN Clientes c ON c.IdCliente=v.IdCliente LEFT JOIN Categorias cat ON cat.IdCategoria=c.IdCategoria
WHERE v.Fecha >= DATEADD(DAY,-${ventana},CAST(GETDATE() AS DATE)) AND v.Fecha < CAST(GETDATE() AS DATE)
  AND ${sqlExcluirSucursales('v.IdSucursal')} AND ${sqlExcluirCentral('v.IdSucursal')}
  AND ISNULL(v.IdEstadoComprobante,'') != 'ANULADO' AND UPPER(ISNULL(cat.NombreCategoria,'')) != 'SUCURSAL'
  AND vp.IdProducto IN (${pluList.join(',')}) GROUP BY vp.IdProducto`;
}

module.exports = { sqlConsumoCatalogo, sqlStockTodosDepositos, sqlStockSucursales, sqlFacturacionPorPlu };
