'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  ApideltaSubSystem — servidor unificado
//  Pedidos + Planificación + Producción Día
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const express    = require('express');
const sql        = require('mssql/msnodesqlv8');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');

const multer   = require('multer');
const XLSX     = require('xlsx');
const { calcularAlmacen, pisoMinimo } = require('./distribucion');
const comprasModulo = require('./compras_modulo');
const preciosProv = require('./precios_proveedores');
const pdfParse = require('pdf-parse');
const { calcularPesables } = require('./pesables');
const { computeA8020, calcularRankingPorSucursal, calcularRankingGlobal, roundDec } = require('./a8020');

const cfg      = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const PORT     = cfg.puerto   || 8080;
const HOSTNAME = cfg.hostname || 'pedidos';

// ── Conexión SQL Server ────────────────────────────────────────────────────────
const SIGA_SERVER = process.env.SIGA_DB_SERVER || 'servidorapidelta\\SQLSTANDARD';
const SIGA_DBNAME = process.env.SIGA_DB_NAME   || 'Siga';

const DB_CONFIG = {
  connectionString:
    'Driver={ODBC Driver 17 for SQL Server};' +
    `Server=${SIGA_SERVER};`                   +
    `Database=${SIGA_DBNAME};`                 +
    `UID=${process.env.SIGA_READ_UID || 'apidelta'};` +
    `PWD=${process.env.SIGA_READ_PWD || 'apd706'};`   +
    'TrustServerCertificate=yes;',
  requestTimeout: 120000   // recálculo A8020 corre queries pesadas; techo alto (no afecta queries rápidas)
};

// Pool de escritura: usuario acotado (INSERT/UPDATE solo en tablas de movimientos de stock).
// Ver pruebas_stock_claude/_crear_usuario_stock.sql para el detalle de permisos.
const DB_CONFIG_STOCK = {
  connectionString:
    'Driver={ODBC Driver 17 for SQL Server};' +
    `Server=${SIGA_SERVER};`                   +
    `Database=${SIGA_DBNAME};`                 +
    `UID=${process.env.SIGA_STOCK_UID};`       +
    `PWD=${process.env.SIGA_STOCK_PWD};`       +
    'TrustServerCertificate=yes;',
  requestTimeout: 30000
};

let pool = null;
async function getPool() {
  if (pool && pool.connected) return pool;
  pool = await sql.connect(DB_CONFIG);
  pool.on('error', () => { pool = null; });
  return pool;
}
async function query(q) {
  const p = await getPool();
  const r = await p.request().query(q);
  return r.recordset;
}

let poolStock = null;
async function getPoolStock() {
  if (poolStock && poolStock.connected) return poolStock;
  if (!process.env.SIGA_STOCK_UID || !process.env.SIGA_STOCK_PWD) {
    throw new Error('Faltan SIGA_STOCK_UID / SIGA_STOCK_PWD en .env (ver .env.example)');
  }
  poolStock = await new sql.ConnectionPool(DB_CONFIG_STOCK).connect();
  poolStock.on('error', () => { poolStock = null; });
  return poolStock;
}

// ── Helpers de seguridad ───────────────────────────────────────────────────────
function safeDate(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : new Date().toISOString().slice(0, 10);
}
function safeIntList(v) {
  if (!v) return null;
  const parts = String(v).split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s));
  return parts.length ? parts.join(',') : null;
}
const ESTADOS_ALLOWED = ['PENDIENTE','EN PROCESO','RESERVAR','PRODUCCION','ENTREGADO','ANULADO','RECHAZADO','FINALIZADO'];
const ESTADOS_DEFAULT  = "'PENDIENTE','EN PROCESO','RESERVAR'";
function safeEstadoList(v) {
  if (!v) return ESTADOS_DEFAULT;
  const parts = String(v).split(',').map(s => s.trim().toUpperCase()).filter(s => ESTADOS_ALLOWED.includes(s));
  return parts.length ? parts.map(s => `'${s}'`).join(',') : ESTADOS_DEFAULT;
}
function safeEstadoListRaw(v) {
  if (!v) return '';
  const parts = String(v).split(',').map(s => s.trim().toUpperCase()).filter(s => ESTADOS_ALLOWED.includes(s));
  return parts.join(',');
}

// ── Estado compartido pedidos ──────────────────────────────────────────────────
let sharedState = {
  desde:       new Date().toISOString().slice(0, 10),
  hasta:        new Date().toISOString().slice(0, 10),
  localidades: '',
  clientes:    '',
  pedidos:     '',
  estados:     ''
};

// ── CTEs SQL ───────────────────────────────────────────────────────────────────
const ULT_ESTADO_CTE = `
  UltimoEstado AS (
    SELECT pe.IdSucursal, pe.NumeroPedido, pe.IdProducto, pe.Orden,
      CASE
        WHEN MAX(CASE WHEN pe.IdEstado='PENDIENTE'  THEN 1 ELSE 0 END)=1 THEN 'PENDIENTE'
        WHEN MAX(CASE WHEN pe.IdEstado='EN PROCESO' THEN 1 ELSE 0 END)=1 THEN 'EN PROCESO'
        WHEN MAX(CASE WHEN pe.IdEstado='RESERVAR'   THEN 1 ELSE 0 END)=1 THEN 'RESERVAR'
        WHEN MAX(CASE WHEN pe.IdEstado='PRODUCCION' THEN 1 ELSE 0 END)=1 THEN 'PRODUCCION'
        WHEN MAX(CASE WHEN pe.IdEstado='ENTREGADO'  THEN 1 ELSE 0 END)=1 THEN 'ENTREGADO'
        WHEN MAX(CASE WHEN pe.IdEstado='FINALIZADO' THEN 1 ELSE 0 END)=1 THEN 'FINALIZADO'
        ELSE MAX(pe.IdEstado)
      END AS IdEstado
    FROM PedidosEstados pe
    GROUP BY pe.IdSucursal, pe.NumeroPedido, pe.IdProducto, pe.Orden)`;

const STOCK_CENTRAL_CTE = `
  StockCentral AS (
    SELECT pd.IdProducto, SUM(pd.Stock) AS Stock
    FROM ProductosDepositos pd
    INNER JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal
    INNER JOIN Sucursales s ON s.IdSucursal=pd.IdSucursal
    WHERE s.SoyLaCentral=1 AND sd.DisponibleVenta=1
    GROUP BY pd.IdProducto),
  ComponentePrimario AS (
    SELECT pc.IdProducto,
           MIN(pc.IdProductoComponente) AS IdProductoComponente,
           MIN(pc.Cantidad)             AS Cantidad
    FROM ProductosComponentes pc
    INNER JOIN Productos prodPadre ON pc.IdProducto = prodPadre.IdProducto
    INNER JOIN Rubros    rPadre    ON prodPadre.IdRubro = rPadre.IdRubro
    INNER JOIN Productos prodComp  ON pc.IdProductoComponente = prodComp.IdProducto
    LEFT  JOIN Rubros    rComp     ON prodComp.IdRubro = rComp.IdRubro
    WHERE (rPadre.NombreRubro LIKE '%BULTO%' OR rPadre.NombreRubro LIKE '%CAJA%')
      AND prodComp.NombreProducto NOT LIKE '%FORMULA GENERICO%'
      AND prodComp.NombreProducto NOT LIKE '%FORMULA GENÉRICO%'
      AND COALESCE(rComp.NombreRubro,'') NOT LIKE '%EMBALAJ%'
      AND COALESCE(rComp.NombreRubro,'') NOT LIKE '%TAPA%'
      AND COALESCE(rComp.NombreRubro,'') NOT LIKE '%ETIQUET%'
      AND COALESCE(rComp.NombreRubro,'') NOT LIKE '%ENVASE%'
      AND COALESCE(rComp.NombreRubro,'') NOT LIKE '%BOLSA%'
      AND COALESCE(rComp.NombreRubro,'') NOT LIKE '%FILM%'
      AND COALESCE(rComp.NombreRubro,'') NOT LIKE '%CARTON%'
      AND COALESCE(rComp.NombreRubro,'') NOT LIKE '%PAPEL%'
      AND COALESCE(rComp.NombreRubro,'') NOT LIKE '%PRECINTO%'
      AND prodComp.NombreProducto NOT LIKE 'Tapa %'
      AND prodComp.NombreProducto NOT LIKE 'Tapas %'
      AND prodComp.NombreProducto NOT LIKE 'Etiqueta%'
      AND prodComp.NombreProducto NOT LIKE 'Envase %'
      AND prodComp.NombreProducto NOT LIKE 'Bolsa %'
      AND prodComp.NombreProducto NOT LIKE 'Bolsas %'
      AND prodComp.NombreProducto NOT LIKE 'Film %'
      AND prodComp.NombreProducto NOT LIKE 'Precinto%'
      AND prodComp.NombreProducto NOT LIKE 'Caja %'
      AND prodComp.NombreProducto NOT LIKE 'Cinta %'
    GROUP BY pc.IdProducto)`;

// ── Queries pedidos ────────────────────────────────────────────────────────────
async function getLocalidades(desde, hasta, estados) {
  return query(`
    ;WITH Ult AS (
      SELECT pe.IdSucursal,pe.NumeroPedido,pe.IdProducto,pe.Orden,pe.IdEstado
      FROM PedidosEstados pe
      WHERE pe.FechaEstado=(SELECT MAX(x.FechaEstado) FROM PedidosEstados x
          WHERE x.IdSucursal=pe.IdSucursal AND x.NumeroPedido=pe.NumeroPedido
            AND x.IdProducto=pe.IdProducto AND x.Orden=pe.Orden))
    SELECT DISTINCT l.IdLocalidad, l.NombreLocalidad
    FROM Pedidos p
    INNER JOIN Clientes c ON p.IdCliente=c.IdCliente
    INNER JOIN Localidades l ON c.IdLocalidad=l.IdLocalidad
    INNER JOIN PedidosProductos pp ON pp.IdSucursal=p.IdSucursal AND pp.NumeroPedido=p.NumeroPedido
    INNER JOIN Ult ue ON ue.IdSucursal=pp.IdSucursal AND ue.NumeroPedido=pp.NumeroPedido
                     AND ue.IdProducto=pp.IdProducto AND ue.Orden=pp.Orden
    WHERE CAST(p.FechaPedido AS DATE) BETWEEN '${desde}' AND '${hasta}'
      AND ue.IdEstado IN (${estados})
    ORDER BY l.NombreLocalidad`);
}

async function getEstados() {
  return query(`SELECT IdEstado, COUNT(*) AS Cant FROM PedidosEstados GROUP BY IdEstado ORDER BY Cant DESC`);
}

async function getClientes(desde, hasta, localidades, estados) {
  const wLoc = localidades ? `AND c.IdLocalidad IN (${localidades})` : '';
  return query(`
    ;WITH ${ULT_ESTADO_CTE}
    SELECT DISTINCT c.IdCliente, c.NombreCliente
    FROM Pedidos p
    INNER JOIN Clientes c ON p.IdCliente=c.IdCliente
    INNER JOIN PedidosProductos pp ON pp.IdSucursal=p.IdSucursal AND pp.NumeroPedido=p.NumeroPedido
    INNER JOIN UltimoEstado ue ON ue.IdSucursal=pp.IdSucursal AND ue.NumeroPedido=pp.NumeroPedido
                              AND ue.IdProducto=pp.IdProducto AND ue.Orden=pp.Orden
    WHERE CAST(p.FechaPedido AS DATE) BETWEEN '${desde}' AND '${hasta}'
      AND ue.IdEstado IN (${estados})
      ${wLoc}
    ORDER BY c.NombreCliente`);
}

async function getPedidos(desde, hasta, localidades, clientes, estados) {
  const wLoc = localidades ? `AND c.IdLocalidad IN (${localidades})` : '';
  const wCli = clientes    ? `AND p.IdCliente IN (${clientes})`      : '';
  return query(`
    ;WITH Ult AS (
      SELECT pe.IdSucursal,pe.NumeroPedido,pe.IdProducto,pe.Orden,pe.IdEstado
      FROM PedidosEstados pe
      WHERE pe.FechaEstado=(SELECT MAX(x.FechaEstado) FROM PedidosEstados x
          WHERE x.IdSucursal=pe.IdSucursal AND x.NumeroPedido=pe.NumeroPedido
            AND x.IdProducto=pe.IdProducto AND x.Orden=pe.Orden)),
    PedidosElegibles AS (
      SELECT DISTINCT pp.IdSucursal, pp.NumeroPedido
      FROM PedidosProductos pp
      INNER JOIN Pedidos p  ON p.IdSucursal=pp.IdSucursal AND p.NumeroPedido=pp.NumeroPedido
      INNER JOIN Clientes c ON p.IdCliente=c.IdCliente
      INNER JOIN Ult ue     ON ue.IdSucursal=pp.IdSucursal AND ue.NumeroPedido=pp.NumeroPedido
                           AND ue.IdProducto=pp.IdProducto AND ue.Orden=pp.Orden
      WHERE CAST(p.FechaPedido AS DATE) BETWEEN '${desde}' AND '${hasta}'
        AND ue.IdEstado IN (${estados})
        ${wLoc} ${wCli}
    )
    SELECT p.IdSucursal, p.NumeroPedido,
           CONVERT(varchar,p.FechaPedido,120) AS FechaPedido,
           c.IdCliente, c.NombreCliente, l.NombreLocalidad, cat.NombreCategoria,
           SUM(pp.ImporteTotalConImpuestos) AS TotalImporte,
           COUNT(DISTINCT pp.IdProducto)    AS CantProductos,
           SUM(CASE WHEN ue.IdEstado='PENDIENTE'  THEN 1 ELSE 0 END) AS LineasPendiente,
           SUM(CASE WHEN ue.IdEstado='EN PROCESO' THEN 1 ELSE 0 END) AS LineasEnProceso,
           SUM(CASE WHEN ue.IdEstado='RESERVAR'   THEN 1 ELSE 0 END) AS LineasReservar,
           SUM(CASE WHEN ue.IdEstado='ENTREGADO'  THEN 1 ELSE 0 END) AS LineasFacturado,
           SUM(CASE WHEN ue.IdEstado IS NULL
                         OR ue.IdEstado NOT IN ('PENDIENTE','EN PROCESO','RESERVAR','ENTREGADO')
                    THEN 1 ELSE 0 END) AS LineasOtros,
           SUM(CASE WHEN ue.IdEstado='EN PROCESO' THEN pp.CantPendiente ELSE 0 END) AS UnidEnProceso,
           SUM(CASE WHEN ue.IdEstado='ENTREGADO'  THEN pp.Cantidad      ELSE 0 END) AS UnidFacturadas,
           SUM(CASE WHEN ue.IdEstado IN ('PENDIENTE','EN PROCESO','RESERVAR')
                    THEN pp.ImporteTotalConImpuestos ELSE 0 END) AS ImportePendiente,
           SUM(CASE WHEN ue.IdEstado='ENTREGADO'
                    THEN pp.ImporteTotalConImpuestos ELSE 0 END) AS ImporteFacturado,
           CASE
             WHEN SUM(CASE WHEN ue.IdEstado='PENDIENTE'  THEN 1 ELSE 0 END) > 0 THEN 'PENDIENTE'
             WHEN SUM(CASE WHEN ue.IdEstado='EN PROCESO' THEN 1 ELSE 0 END) > 0 THEN 'EN PROCESO'
             WHEN SUM(CASE WHEN ue.IdEstado='RESERVAR'   THEN 1 ELSE 0 END) > 0 THEN 'RESERVAR'
             WHEN SUM(CASE WHEN ue.IdEstado='ENTREGADO'  THEN 1 ELSE 0 END) > 0 THEN 'ENTREGADO'
             ELSE 'OTROS'
           END AS Estado
    FROM Pedidos p
    INNER JOIN PedidosElegibles pe ON pe.IdSucursal=p.IdSucursal AND pe.NumeroPedido=p.NumeroPedido
    INNER JOIN Clientes c     ON p.IdCliente=c.IdCliente
    INNER JOIN Localidades l  ON c.IdLocalidad=l.IdLocalidad
    INNER JOIN Categorias cat ON c.IdCategoria=cat.IdCategoria
    INNER JOIN PedidosProductos pp ON pp.IdSucursal=p.IdSucursal AND pp.NumeroPedido=p.NumeroPedido
    LEFT  JOIN Ult ue ON ue.IdSucursal=pp.IdSucursal AND ue.NumeroPedido=pp.NumeroPedido
                     AND ue.IdProducto=pp.IdProducto AND ue.Orden=pp.Orden
    GROUP BY p.IdSucursal,p.NumeroPedido,p.FechaPedido,c.IdCliente,c.NombreCliente,
             l.NombreLocalidad,cat.NombreCategoria
    ORDER BY p.FechaPedido, p.NumeroPedido`);
}

async function getProductos(desde, hasta, localidades, clientes, pedidos, estados) {
  const wLoc = localidades ? `AND c.IdLocalidad IN (${localidades})` : '';
  const wCli = clientes    ? `AND p.IdCliente IN (${clientes})`      : '';
  const wPed = pedidos     ? `AND p.NumeroPedido IN (${pedidos})`    : '';
  return query(`
    ;WITH ${ULT_ESTADO_CTE},
    ${STOCK_CENTRAL_CTE}
    SELECT
      pp.IdProducto,
      prod.NombreProducto,
      r.NombreRubro,
      SUM(pp.CantPendiente)            AS TotalUnidades,
      CASE
        WHEN MAX(cp.IdProductoComponente) IS NOT NULL THEN COALESCE(MAX(scComp.Stock), 0)
        WHEN MAX(r.NombreRubro) LIKE '%BULTO%' OR MAX(r.NombreRubro) LIKE '%CAJA%' THEN 0
        ELSE COALESCE(MAX(scSelf.Stock), 0)
      END                              AS StockCentral,
      MAX(cp.Cantidad)                 AS CantidadPorBulto,
      MAX(prodComp.NombreProducto)     AS NombreComponente,
      MAX(cp.IdProductoComponente)     AS IdComponente,
      SUM(pp.ImporteTotalConImpuestos) AS TotalImporte
    FROM PedidosProductos pp
    INNER JOIN Pedidos p  ON p.IdSucursal=pp.IdSucursal AND p.NumeroPedido=pp.NumeroPedido
    INNER JOIN Clientes c ON p.IdCliente=c.IdCliente
    INNER JOIN UltimoEstado ue ON ue.IdSucursal=pp.IdSucursal AND ue.NumeroPedido=pp.NumeroPedido
                              AND ue.IdProducto=pp.IdProducto AND ue.Orden=pp.Orden
    INNER JOIN Productos prod  ON pp.IdProducto = prod.IdProducto
    LEFT  JOIN Rubros r        ON prod.IdRubro = r.IdRubro
    LEFT  JOIN ComponentePrimario cp ON cp.IdProducto = pp.IdProducto
    LEFT  JOIN Productos prodComp    ON prodComp.IdProducto = cp.IdProductoComponente
    LEFT  JOIN StockCentral scSelf   ON scSelf.IdProducto = pp.IdProducto
    LEFT  JOIN StockCentral scComp   ON scComp.IdProducto = cp.IdProductoComponente
    WHERE ue.IdEstado IN (${estados})
      AND CAST(p.FechaPedido AS DATE) BETWEEN '${desde}' AND '${hasta}'
      AND pp.CantPendiente > 0
      ${wLoc} ${wCli} ${wPed}
    GROUP BY pp.IdProducto, prod.NombreProducto, r.NombreRubro
    HAVING SUM(pp.CantPendiente) > 0
    ORDER BY TotalUnidades DESC`);
}

async function getFacturasDePedido(idSucursal, numeroPedido) {
  const idSuc = parseInt(idSucursal, 10) || 1;
  const np    = parseInt(numeroPedido, 10);
  if (!np) return { comprobantes: [], productos: [] };

  const comprobantes = await query(`
    SELECT DISTINCT
      pe.IdSucursalFact AS IdSucursal, pe.IdTipoComprobanteFact AS IdTipoComprobante,
      pe.LetraFact AS Letra, pe.CentroEmisorFact AS CentroEmisor,
      pe.NumeroComprobanteFact AS NumeroComprobante,
      CONVERT(varchar, v.Fecha, 120) AS Fecha,
      v.ImporteTotal, v.SubTotal, v.DescuentoRecargo, v.CAE,
      v.IdEstadoComprobante, v.Observacion, v.IdCliente,
      cl.NombreCliente, tc.Descripcion AS NombreTipoComprobante
    FROM PedidosEstados pe
    INNER JOIN Ventas v        ON v.IdSucursal=pe.IdSucursalFact AND v.IdTipoComprobante=pe.IdTipoComprobanteFact
                              AND v.Letra=pe.LetraFact AND v.CentroEmisor=pe.CentroEmisorFact
                              AND v.NumeroComprobante=pe.NumeroComprobanteFact
    LEFT  JOIN TiposComprobantes tc ON tc.IdTipoComprobante=v.IdTipoComprobante
    LEFT  JOIN Clientes cl     ON cl.IdCliente=v.IdCliente
    WHERE pe.IdSucursal=${idSuc} AND pe.NumeroPedido=${np}
      AND pe.IdEstado='ENTREGADO' AND pe.NumeroComprobanteFact IS NOT NULL
    ORDER BY Fecha DESC, NumeroComprobante`);

  if (!comprobantes.length) return { comprobantes: [], productos: [] };

  const vals = comprobantes.map(c =>
    `(${c.IdSucursal},'${(c.IdTipoComprobante||'').replace(/'/g,"''")}','${(c.Letra||'').replace(/'/g,"''")}',${c.CentroEmisor},${c.NumeroComprobante})`
  ).join(',');

  const productos = await query(`
    SELECT vp.IdSucursal, vp.IdTipoComprobante, vp.Letra, vp.CentroEmisor, vp.NumeroComprobante,
           vp.IdProducto, vp.NombreProducto, vp.Cantidad, vp.Precio, vp.PrecioNeto,
           vp.ImporteTotal, vp.ImporteTotalNeto, vp.AlicuotaImpuesto, vp.ImporteImpuesto, vp.Orden
    FROM VentasProductos vp
    INNER JOIN (VALUES ${vals}) AS f(IdSucursal, IdTipoComprobante, Letra, CentroEmisor, NumeroComprobante)
      ON vp.IdSucursal=f.IdSucursal AND vp.IdTipoComprobante=f.IdTipoComprobante
      AND vp.Letra=f.Letra AND vp.CentroEmisor=f.CentroEmisor AND vp.NumeroComprobante=f.NumeroComprobante
    ORDER BY vp.NumeroComprobante, vp.Orden`);

  return { comprobantes, productos };
}

async function getResumen(desde, hasta, localidades, clientes, pedidos, estados) {
  const wLoc = localidades ? `AND c.IdLocalidad IN (${localidades})` : '';
  const wCli = clientes    ? `AND p.IdCliente IN (${clientes})`      : '';
  const wPed = pedidos     ? `AND p.NumeroPedido IN (${pedidos})`    : '';
  return query(`
    ;WITH ${ULT_ESTADO_CTE},
    ${STOCK_CENTRAL_CTE}
    SELECT c.IdCliente, c.NombreCliente, pp.IdProducto, prod.NombreProducto, r.NombreRubro,
      SUM(pp.CantPendiente) AS TotalUnidades,
      CASE
        WHEN MAX(cp.IdProductoComponente) IS NOT NULL THEN COALESCE(MAX(scComp.Stock), 0)
        WHEN MAX(r.NombreRubro) LIKE '%BULTO%' OR MAX(r.NombreRubro) LIKE '%CAJA%' THEN 0
        ELSE COALESCE(MAX(scSelf.Stock), 0)
      END AS StockCentral,
      MAX(cp.Cantidad) AS CantidadPorBulto,
      MAX(prodComp.NombreProducto) AS NombreComponente,
      MAX(cp.IdProductoComponente) AS IdComponente
    FROM PedidosProductos pp
    INNER JOIN Pedidos p  ON p.IdSucursal=pp.IdSucursal AND p.NumeroPedido=pp.NumeroPedido
    INNER JOIN Clientes c ON p.IdCliente=c.IdCliente
    INNER JOIN UltimoEstado ue ON ue.IdSucursal=pp.IdSucursal AND ue.NumeroPedido=pp.NumeroPedido
                              AND ue.IdProducto=pp.IdProducto AND ue.Orden=pp.Orden
    INNER JOIN Productos prod  ON pp.IdProducto = prod.IdProducto
    LEFT  JOIN Rubros r        ON prod.IdRubro = r.IdRubro
    LEFT  JOIN ComponentePrimario cp ON cp.IdProducto = pp.IdProducto
    LEFT  JOIN Productos prodComp    ON prodComp.IdProducto = cp.IdProductoComponente
    LEFT  JOIN StockCentral scSelf   ON scSelf.IdProducto = pp.IdProducto
    LEFT  JOIN StockCentral scComp   ON scComp.IdProducto = cp.IdProductoComponente
    WHERE ue.IdEstado IN (${estados})
      AND CAST(p.FechaPedido AS DATE) BETWEEN '${desde}' AND '${hasta}'
      AND pp.CantPendiente > 0
      ${wLoc} ${wCli} ${wPed}
    GROUP BY c.IdCliente, c.NombreCliente, pp.IdProducto, prod.NombreProducto, r.NombreRubro
    HAVING SUM(pp.CantPendiente) > 0
    ORDER BY c.NombreCliente, TotalUnidades DESC`);
}

// ── Queries planificación ──────────────────────────────────────────────────────
function sqlStockTerminados(rubros) {
  return `;WITH StockCentral AS (
  SELECT pd.IdProducto, SUM(pd.Stock) AS Stock
  FROM ProductosDepositos pd
  INNER JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal
  INNER JOIN Sucursales s ON s.IdSucursal=pd.IdSucursal
  WHERE s.SoyLaCentral=1 AND sd.DisponibleVenta=1
  GROUP BY pd.IdProducto)
SELECT p.IdProducto, p.NombreProducto, r.NombreRubro, COALESCE(sc.Stock,0) AS StockActual, p.EsCompuesto
FROM Productos p INNER JOIN Rubros r ON r.IdRubro=p.IdRubro
LEFT  JOIN StockCentral sc ON sc.IdProducto=p.IdProducto
WHERE p.Activo=1 ${rubros ? `AND p.IdRubro IN (${rubros})` : ''} ORDER BY p.NombreProducto`;
}
function sqlConsumo(ventana, rubros) {
  return `SELECT vp.IdProducto, SUM(vp.Cantidad) AS UnidVendidas,
       CAST(SUM(vp.Cantidad) AS DECIMAL(18,4)) / ${ventana} AS PromDiario
FROM VentasProductos vp
INNER JOIN Ventas v ON v.IdSucursal=vp.IdSucursal AND v.IdTipoComprobante=vp.IdTipoComprobante
  AND v.Letra=vp.Letra AND v.CentroEmisor=vp.CentroEmisor AND v.NumeroComprobante=vp.NumeroComprobante
INNER JOIN Sucursales s ON s.IdSucursal=v.IdSucursal
INNER JOIN Productos p ON p.IdProducto=vp.IdProducto
WHERE v.Fecha >= DATEADD(DAY,-${ventana},CAST(GETDATE() AS DATE)) AND v.Fecha < CAST(GETDATE() AS DATE)
  AND s.SoyLaCentral=1 AND ISNULL(v.IdEstadoComprobante,'') != 'ANULADO' ${rubros ? `AND p.IdRubro IN (${rubros})` : ''}
GROUP BY vp.IdProducto`;
}
function sqlPendientes() {
  return `SELECT pp.IdProducto, SUM(pp.CantPendiente) AS UnidPendientes
FROM PedidosProductos pp INNER JOIN Pedidos ped ON ped.IdSucursal=pp.IdSucursal AND ped.NumeroPedido=pp.NumeroPedido
WHERE pp.CantPendiente>0 AND ped.FechaPedido >= DATEADD(DAY,-7,CAST(GETDATE() AS DATE))
GROUP BY pp.IdProducto`;
}
function sqlStockGranel(rubros) {
  return `SELECT p.IdProducto, p.NombreProducto, r.NombreRubro,
       COALESCE(SUM(CASE WHEN UPPER(sd.NombreDeposito) LIKE '%GRANEL%' THEN pd.Stock ELSE 0 END),0) AS StockGranel,
       COALESCE(SUM(pd.Stock),0) AS StockTotal
FROM Productos p INNER JOIN Rubros r ON r.IdRubro=p.IdRubro
LEFT  JOIN ProductosDepositos pd ON pd.IdProducto=p.IdProducto
LEFT  JOIN SucursalesDepositos sd ON sd.IdDeposito=pd.IdDeposito AND sd.IdSucursal=pd.IdSucursal
WHERE p.Activo=1 AND p.IdRubro IN (${rubros})
GROUP BY p.IdProducto, p.NombreProducto, p.IdRubro, r.NombreRubro ORDER BY p.NombreProducto`;
}
function sqlBOM(rubros) {
  return `SELECT pc.IdProducto, pc.IdProductoComponente, comp.NombreProducto AS NombreComponente,
       comp.IdRubro AS RubroComponente, pc.Cantidad AS CantPorUnidad
FROM ProductosComponentes pc INNER JOIN Productos comp ON comp.IdProducto=pc.IdProductoComponente
WHERE comp.IdRubro IN (${rubros})`;
}

// ── Dashboard de compras: consumo por ventas (presentaciones) vs producción (componente) ──
const COMPRAS_EXCL_TC = "'DEV-COTIZACION','eNCRED','eNCRED-Web','eNCCE-Web','ePRE-NCRED','PRESUP','ePRE-FACT','ePRE-FACTX','ePRE-NDEBCHEQR','REMITOTRANSP','NCFICHAS','NCRED','LIQUIDACION'";

async function analizarConsumoCompras(target, meses) {
  const tgt = String(target).replace(/[^0-9A-Za-z_-]/g, '');
  if (!tgt) throw new Error('Producto inválido');
  const M = Math.min(Math.max(parseInt(meses) || 24, 1), 60);

  const info = await query(`
    SELECT TOP 1 p.IdProducto, p.NombreProducto,
      COALESCE((SELECT SUM(pd.Stock) FROM ProductosDepositos pd
                INNER JOIN Sucursales s ON s.IdSucursal=pd.IdSucursal
                WHERE s.SoyLaCentral=1 AND pd.IdProducto=p.IdProducto),0) AS StockCentral
    FROM Productos p WHERE p.IdProducto='${tgt}'`);
  if (!info.length) throw new Error('Producto no encontrado');

  const reach = await query(`
    ;WITH R AS (
      SELECT DISTINCT IdProducto FROM ProductosComponentes WHERE IdProductoComponente='${tgt}'
      UNION ALL
      SELECT pc.IdProducto FROM ProductosComponentes pc JOIN R ON pc.IdProductoComponente=R.IdProducto
    )
    SELECT DISTINCT IdProducto FROM R OPTION (MAXRECURSION 32)`);
  const idSet = new Set(reach.map(r => String(r.IdProducto)));
  idSet.add(tgt);
  if (idSet.size <= 1) {
    return { producto: { id: tgt, nombre: info[0].NombreProducto }, stockCentral: +info[0].StockCentral,
             meses: M, resumen: { ventasKgMes: 0, produccionKgMes: 0, totalKgMes: 0, coberturaMeses: null, compraSugerida: 0 },
             mensual: [], detalle: { ventas: [], produccion: [] } };
  }
  const inList = [...idSet].map(s => `'${s.replace(/'/g, "''")}'`).join(',');

  const [edges, prods] = await Promise.all([
    query(`SELECT pc.IdProducto, pc.IdFormula, pc.IdProductoComponente, CAST(pc.Cantidad AS FLOAT) AS Cantidad
           FROM ProductosComponentes pc WHERE pc.IdProducto IN (${inList})`),
    query(`SELECT p.IdProducto, p.NombreProducto, p.IdFormula, CAST(ps.PrecioCosto AS FLOAT) AS PrecioCosto
           FROM Productos p LEFT JOIN ProductosSucursales ps ON ps.IdProducto=p.IdProducto AND ps.IdSucursal=1
           WHERE p.IdProducto IN (${inList})`)
  ]);
  const nombre = new Map(prods.map(p => [String(p.IdProducto), p.NombreProducto]));
  const activa = new Map(prods.map(p => [String(p.IdProducto), p.IdFormula == null ? null : Number(p.IdFormula)]));
  const costoMap = new Map(prods.map(p => [String(p.IdProducto), p.PrecioCosto == null ? null : Number(p.PrecioCosto)]));
  const formulas = new Map();
  for (const e of edges) {
    const p = String(e.IdProducto), f = Number(e.IdFormula);
    if (!formulas.has(p)) formulas.set(p, new Map());
    const fm = formulas.get(p);
    if (!fm.has(f)) fm.set(f, []);
    fm.get(f).push({ id: String(e.IdProductoComponente), qty: Number(e.Cantidad) });
  }

  const reachMemo = new Map();
  function reaches(p, stack) {
    if (p === tgt) return true;
    if (reachMemo.has(p)) return reachMemo.get(p);
    if (stack.has(p)) return false;
    stack.add(p);
    let r = false; const fm = formulas.get(p);
    if (fm) for (const comps of fm.values()) { if (comps.some(c => reaches(c.id, stack))) { r = true; break; } }
    stack.delete(p); reachMemo.set(p, r); return r;
  }
  const solveMemo = new Map();
  function solve(p, stack) {
    if (p === tgt) return { content: 1, tipo: null };
    if (solveMemo.has(p)) return solveMemo.get(p);
    if (stack.has(p)) return { content: 0, tipo: null };
    stack.add(p);
    let res = { content: 0, tipo: null };
    const fm = formulas.get(p);
    if (fm) {
      const cand = [...fm.entries()].filter(([f, comps]) => comps.some(c => reaches(c.id, new Set())));
      if (cand.length) {
        const chosen = cand.find(([f, comps]) => comps.some(c => c.id === tgt))
                    || cand.find(([f]) => f === activa.get(p)) || cand[0];
        const comps = chosen[1];
        const directComp = comps.find(c => c.id === tgt);
        let content = 0, tipo = null;
        for (const c of comps) { const r = solve(c.id, stack); if (r.content > 0) { content += c.qty * r.content; if (r.tipo) tipo = r.tipo; } }
        if (directComp) tipo = (comps.length === 1) ? 'Presentacion' : 'Componente';
        res = { content, tipo };
      }
    }
    stack.delete(p); solveMemo.set(p, res); return res;
  }

  const ventas = await query(`
    SELECT vp.IdProducto, YEAR(v.Fecha) AS Anio, MONTH(v.Fecha) AS Mes, SUM(vp.Cantidad) AS U
    FROM VentasProductos vp
    JOIN Ventas v ON v.IdSucursal=vp.IdSucursal AND v.IdTipoComprobante=vp.IdTipoComprobante
                 AND v.Letra=vp.Letra AND v.CentroEmisor=vp.CentroEmisor AND v.NumeroComprobante=vp.NumeroComprobante
    WHERE v.Fecha >= DATEADD(MONTH,-${M},GETDATE()) AND v.Fecha < GETDATE()
      AND (v.IdEstadoComprobante IS NULL OR v.IdEstadoComprobante NOT IN ('ANULADO'))
      AND (v.IdCategoria IS NULL OR v.IdCategoria != 5)
      AND v.IdTipoComprobante NOT IN (${COMPRAS_EXCL_TC})
      AND vp.IdProducto IN (${inList})
    GROUP BY vp.IdProducto, YEAR(v.Fecha), MONTH(v.Fecha)`);

  const det = new Map();
  const mensualMap = new Map();
  let presTot = 0, compTot = 0;
  for (const v of ventas) {
    const p = String(v.IdProducto), u = Number(v.U) || 0;
    const r = (p === tgt) ? { content: 1, tipo: 'Presentacion' } : solve(p, new Set());
    if (r.content <= 0 || !r.tipo) continue;
    const kg = u * r.content;
    if (r.tipo === 'Presentacion') presTot += kg; else compTot += kg;
    const ym = `${v.Anio}-${String(v.Mes).padStart(2, '0')}`;
    if (!mensualMap.has(ym)) mensualMap.set(ym, { ventas: 0, produccion: 0 });
    const m = mensualMap.get(ym);
    if (r.tipo === 'Presentacion') m.ventas += kg; else m.produccion += kg;
    if (!det.has(p)) det.set(p, { id: p, nombre: nombre.get(p) || p, tipo: r.tipo, factor: +r.content.toFixed(5), unid: 0, kg: 0 });
    const d = det.get(p); d.unid += u; d.kg += kg;
  }

  const mensual = [...mensualMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([ym, x]) => ({ ym, ventas: +x.ventas.toFixed(1), produccion: +x.produccion.toFixed(1), total: +(x.ventas + x.produccion).toFixed(1) }));
  const detalle = { ventas: [], produccion: [] };
  for (const d of det.values()) {
    const row = { id: d.id, nombre: d.nombre, factor: d.factor, unid: +d.unid.toFixed(2), kg: +d.kg.toFixed(1), kgMes: +(d.kg / M).toFixed(1) };
    (d.tipo === 'Presentacion' ? detalle.ventas : detalle.produccion).push(row);
  }
  detalle.ventas.sort((a, b) => b.kg - a.kg);
  detalle.produccion.sort((a, b) => b.kg - a.kg);

  const ventasKgMes = +(presTot / M).toFixed(1), produccionKgMes = +(compTot / M).toFixed(1);
  const totalKgMes = +(ventasKgMes + produccionKgMes).toFixed(1);
  const stockCentral = +Number(info[0].StockCentral).toFixed(1);
  const coberturaMeses = totalKgMes > 0 ? +(stockCentral / totalKgMes).toFixed(1) : null;

  const LEAD = cfg.comprasLeadTimeDias != null ? cfg.comprasLeadTimeDias : 7;
  const SEGP = (cfg.comprasStockSeguridadPct != null ? cfg.comprasStockSeguridadPct : 20) / 100;
  const COBM = cfg.comprasCoberturaMeses != null ? cfg.comprasCoberturaMeses : 1;
  const stockSeguridad = +(totalKgMes * SEGP).toFixed(1);
  const demandaLead = totalKgMes / 30 * LEAD;
  const nivelObjetivo = totalKgMes * COBM + stockSeguridad + demandaLead;
  const compraSugerida = Math.max(0, Math.round(nivelObjetivo - stockCentral));
  const criticidad = totalKgMes > 0 ? Math.max(1, Math.min(100, Math.round(100 * (1 - stockCentral / nivelObjetivo)))) : 0;

  let costoKg = null;
  const ownCost = costoMap.get(tgt);
  if (ownCost != null && ownCost > 100) costoKg = ownCost;
  else {
    let bestDiff = Infinity;
    for (const d of detalle.ventas) {
      const c = costoMap.get(d.id);
      if (c != null && c > 100 && d.factor > 0) {
        const diff = Math.abs(d.factor - 1);
        if (diff < bestDiff) { bestDiff = diff; costoKg = c / d.factor; }
      }
    }
  }
  costoKg = costoKg == null ? null : +costoKg.toFixed(2);
  const valorMensual = costoKg == null ? null : Math.round(costoKg * totalKgMes);
  const compraSugeridaValor = costoKg == null ? null : Math.round(costoKg * compraSugerida);
  const stockValor = costoKg == null ? null : Math.round(costoKg * stockCentral);

  return {
    producto: { id: tgt, nombre: info[0].NombreProducto },
    stockCentral, meses: M, costoKg,
    resumen: { ventasKgMes, produccionKgMes, totalKgMes, coberturaMeses, criticidad,
               stockSeguridad, leadDias: LEAD, compraSugerida,
               valorMensual, compraSugeridaValor, stockValor },
    mensual, detalle
  };
}

async function calcularSugerencias(params) {
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  const ventana = parseInt(params.ventana) || c.ventanaConsumoDias;
  const diasObj = parseInt(params.diasObjetivo) || c.diasObjetivo;
  const incStock = (typeof c.incidenciaStockPlanif === 'number') ? c.incidenciaStockPlanif : 1; // % del stock que cuenta en el sugerido
  const rubrosP = c.rubrosPlanificables.join(','), rubrosG = c.rubrosGranel.join(',');
  // Búsqueda manual del modal (params.q) trae TODOS los productos activos, no sólo
  // los rubros planificables (bulto/caja). El sembrado automático sigue acotado a rubrosP.
  const rubrosTerm = params.q ? null : rubrosP;

  const [terminados, consumo, pendientes, granel, bom] = await Promise.all([
    query(sqlStockTerminados(rubrosTerm)), query(sqlConsumo(ventana, rubrosTerm)),
    query(sqlPendientes()), query(sqlStockGranel(rubrosG)), query(sqlBOM(rubrosG))
  ]);

  const consumoMap = new Map(consumo.map(r    => [String(r.IdProducto), parseFloat(r.PromDiario)]));
  const pendMap    = new Map(pendientes.map(r => [String(r.IdProducto), parseFloat(r.UnidPendientes)]));
  const granelMap  = new Map(granel.map(r     => [String(r.IdProducto), parseFloat(r.StockGranel)]));
  const bomMap     = new Map();
  for (const b of bom) { const k = String(b.IdProducto); if (!bomMap.has(k)) bomMap.set(k, b); }

  const resultado = [];
  for (const t of terminados) {
    const id = String(t.IdProducto), prom = consumoMap.get(id) || 0, pend = pendMap.get(id) || 0;
    const stock = parseFloat(t.StockActual || 0), b = bomMap.get(id);
    const stockEfectivo = Math.round(stock * incStock * 100) / 100;
    const idGranel = b ? String(b.IdProductoComponente) : '', nombreGranel = b ? b.NombreComponente : '';
    const cantPU   = b ? parseFloat(b.CantPorUnidad || 0) : 0;
    let diasStock  = prom > 0 ? stock / prom : (stock > 0 ? Infinity : 0);
    const semaforo = diasStock < c.umbralRojo ? 'RED' : diasStock < c.umbralAmarillo ? 'YELLOW' : 'GREEN';
    let cantSugerida = 0;
    if (diasStock < c.minDiasParaSugerir || pend > 0) cantSugerida = Math.max(0, Math.ceil((prom * diasObj) - stockEfectivo + pend));
    const granelNec  = Math.round(cantSugerida * cantPU * 100) / 100;
    const granelDisp = idGranel ? (granelMap.get(idGranel) || 0) : null;
    const granelOk   = granelNec === 0 || granelDisp === null || granelDisp >= granelNec;
    const urgencia   = (isFinite(diasStock) ? -diasStock : 0) + (pend / Math.max(prom, 0.001))
                     + (semaforo === 'RED' ? 1000 : semaforo === 'YELLOW' ? 100 : 0) + (!granelOk ? 50 : 0);
    resultado.push({ idProducto: id, producto: t.NombreProducto, rubro: t.NombreRubro,
      stockActual: stock, promDiario: Math.round(prom * 100) / 100,
      diasStock: isFinite(diasStock) ? Math.round(diasStock * 10) / 10 : 9999,
      semaforo, pendientes: pend, cantSugerida, idGranel, nombreGranel, cantPorUnidad: cantPU,
      granelNecesario: granelNec, granelDisponible: granelDisp !== null ? Math.round(granelDisp * 100) / 100 : null,
      granelOk, urgencia });
  }
  resultado.sort((a, b) => b.urgencia - a.urgencia);
  let out = resultado;
  if (params.soloRojos === '1') out = out.filter(r => r.semaforo === 'RED');
  if (params.q) { const q = String(params.q).toLowerCase(); out = out.filter(r => r.producto.toLowerCase().includes(q) || r.rubro.toLowerCase().includes(q)); }
  return out;
}

function pesoEnKg(presentacion) {
  const m = String(presentacion).match(/(\d+(?:[.,]\d+)?)\s*(G|g|Kg|kg|KG)\b/);
  if (!m) return null;
  return m[2].toLowerCase() === 'g' ? parseFloat(m[1].replace(',', '.')) / 1000 : parseFloat(m[1].replace(',', '.'));
}
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
  AND ISNULL(v.IdEstadoComprobante,'') != 'ANULADO' AND UPPER(ISNULL(cat.NombreCategoria,'')) != 'SUCURSAL'
  AND vp.IdProducto IN (${pluList.join(',')}) GROUP BY vp.IdProducto`;
}
function sqlStockPorPlu(pluList) {
  return `SELECT pd.IdProducto, COALESCE(SUM(pd.Stock),0) AS StockActual FROM ProductosDepositos pd
INNER JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal
INNER JOIN Sucursales s ON s.IdSucursal=pd.IdSucursal
WHERE s.SoyLaCentral=1 AND sd.DisponibleVenta=1 AND pd.IdProducto IN (${pluList.join(',')}) GROUP BY pd.IdProducto`;
}
function sqlStockTodosDepositos(pluList) {
  return `SELECT pd.IdProducto, COALESCE(SUM(pd.Stock),0) AS StockActual FROM ProductosDepositos pd
INNER JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal
INNER JOIN Sucursales s ON s.IdSucursal=pd.IdSucursal
WHERE s.SoyLaCentral=1 AND pd.IdProducto IN (${pluList.join(',')}) GROUP BY pd.IdProducto`;
}
function sqlStockSucursales(pluList) {
  // Stock en sucursales (todas menos Casa Central): SoyLaCentral=0
  return `SELECT pd.IdProducto, COALESCE(SUM(pd.Stock),0) AS StockActual FROM ProductosDepositos pd
INNER JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal
INNER JOIN Sucursales s ON s.IdSucursal=pd.IdSucursal
WHERE s.SoyLaCentral=0 AND sd.DisponibleVenta=1 AND pd.IdProducto IN (${pluList.join(',')}) GROUP BY pd.IdProducto`;
}
function sqlPendientesPorPlu(pluList) {
  return `SELECT pp.IdProducto, SUM(pp.CantPendiente) AS UnidPendientes FROM PedidosProductos pp
INNER JOIN Pedidos ped ON ped.IdSucursal=pp.IdSucursal AND ped.NumeroPedido=pp.NumeroPedido
WHERE pp.CantPendiente>0 AND ped.FechaPedido >= DATEADD(DAY,-7,CAST(GETDATE() AS DATE))
  AND pp.IdProducto IN (${pluList.join(',')}) GROUP BY pp.IdProducto`;
}
function sqlFacturacionPorPlu(pluList, ventana) {
  return `SELECT vp.IdProducto, SUM(vp.ImporteTotal) AS TotalFacturado
FROM VentasProductos vp INNER JOIN Ventas v ON v.IdSucursal=vp.IdSucursal AND v.IdTipoComprobante=vp.IdTipoComprobante
  AND v.Letra=vp.Letra AND v.CentroEmisor=vp.CentroEmisor AND v.NumeroComprobante=vp.NumeroComprobante
LEFT JOIN Clientes c ON c.IdCliente=v.IdCliente LEFT JOIN Categorias cat ON cat.IdCategoria=c.IdCategoria
WHERE v.Fecha >= DATEADD(DAY,-${ventana},CAST(GETDATE() AS DATE)) AND v.Fecha < CAST(GETDATE() AS DATE)
  AND ISNULL(v.IdEstadoComprobante,'') != 'ANULADO' AND UPPER(ISNULL(cat.NombreCategoria,'')) != 'SUCURSAL'
  AND vp.IdProducto IN (${pluList.join(',')}) GROUP BY vp.IdProducto`;
}
function sqlBOMPorPlu(pluList, rubrosG) {
  return `SELECT pc.IdProducto, pc.IdProductoComponente, comp.NombreProducto AS NombreComponente, pc.Cantidad AS CantPorUnidad
FROM ProductosComponentes pc INNER JOIN Productos comp ON comp.IdProducto=pc.IdProductoComponente
WHERE comp.IdRubro IN (${rubrosG}) AND pc.IdProducto IN (${pluList.join(',')})`;
}
function buildCatalogoMaps(catalogo) {
  const pluToBase = new Map(), baseMap = new Map(), refMap = new Map();
  for (const item of catalogo) {
    const plu = String(item.plu), base = item.baseNombre, refId = String(item.refId);
    pluToBase.set(plu, base);
    if (!baseMap.has(base)) baseMap.set(base, { refId, productoRef: item.productoRef, presentacion: item.presentacion, pluBase: null, plusVariantes: [] });
    if (item.esVariante) baseMap.get(base).plusVariantes.push(plu); else baseMap.get(base).pluBase = plu;
    if (!refMap.has(refId)) refMap.set(refId, { productoRef: item.productoRef, bases: new Map() });
    if (!refMap.get(refId).bases.has(base)) refMap.get(refId).bases.set(base, baseMap.get(base));
  }
  return { pluToBase, baseMap, refMap };
}
async function calcularSugerenciasCatalogo(params) {
  const catalogoCompleto = leerJSON(CATALOGO_PATH, []);
  if (!catalogoCompleto.length) throw new Error('Catálogo vacío. Importar Excel desde planificación.');
  const gruposCfg = leerJSON(GRUPOS_CFG_PATH, {});
  const catalogo  = catalogoCompleto.filter(item => cfgActivo(gruposCfg, item.productoRef));
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  const ventana = parseInt(params.ventana) || c.ventanaConsumoDias;
  const diasObj = parseInt(params.diasObjetivo) || c.diasObjetivo;
  const incStock = (typeof c.incidenciaStockPlanif === 'number') ? c.incidenciaStockPlanif : 1; // % del stock que cuenta en el sugerido (0.6 = 60%)
  const rubrosG = c.rubrosGranel.join(',');
  const { pluToBase, baseMap, refMap } = buildCatalogoMaps(catalogo);
  const todosLosPlu = catalogo.map(i => String(i.plu));
  async function queryEnLotes(sqlFn) {
    const LOTE = 1000;
    if (todosLosPlu.length <= LOTE) return query(sqlFn(todosLosPlu));
    const res = [];
    for (let i = 0; i < todosLosPlu.length; i += LOTE) res.push(...await query(sqlFn(todosLosPlu.slice(i, i + LOTE))));
    return res;
  }
  // PLUs de granel asignados manualmente en grupos_config
  const customGranelPlus = [...new Set(Object.keys(gruposCfg).map(r=>cfgGranelPlu(gruposCfg,r)).filter(Boolean))];
  const quotedGP = customGranelPlus.map(p => `'${p}'`).join(',');
  const [consumoRows, pendientesRows, stockRows, stockTodosRows, stockSucRows, bomRows, granelRows, customGranelStockRows, customGranelNomRows, facturRows] = await Promise.all([
    queryEnLotes(l => sqlConsumoCatalogo(l, ventana)), queryEnLotes(l => sqlPendientesPorPlu(l)),
    queryEnLotes(l => sqlStockPorPlu(l)), queryEnLotes(l => sqlStockTodosDepositos(l)),
    queryEnLotes(l => sqlStockSucursales(l)),
    queryEnLotes(l => sqlBOMPorPlu(l, rubrosG)), query(sqlStockGranel(rubrosG)),
    customGranelPlus.length ? query(`SELECT pd.IdProducto, COALESCE(SUM(pd.Stock),0) AS Stock FROM ProductosDepositos pd JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal JOIN Sucursales s ON s.IdSucursal=pd.IdSucursal WHERE s.SoyLaCentral=1 AND pd.IdProducto IN (${customGranelPlus.join(',')}) GROUP BY pd.IdProducto`) : Promise.resolve([]),
    customGranelPlus.length ? query(`SELECT CAST(IdProducto AS VARCHAR) AS IdProducto, NombreProducto FROM Productos WHERE CAST(IdProducto AS VARCHAR) IN (${quotedGP})`) : Promise.resolve([]),
    queryEnLotes(l => sqlFacturacionPorPlu(l, ventana)),
  ]);
  // Por PLU guardamos total vendido y días con venta. El denominador se decide por grupo:
  // ÷ventana (demanda real) por defecto; ÷días-con-venta solo si el granel del grupo está sin stock (quiebre).
  const consumoTotalRaw = new Map(consumoRows.map(r => [String(r.IdProducto), parseFloat(r.UnidVendidas) || 0]));
  const consumoDiasRaw  = new Map(consumoRows.map(r => [String(r.IdProducto), parseInt(r.DiasConVenta) || 0]));
  const pendRaw    = new Map(pendientesRows.map(r => [String(r.IdProducto), parseFloat(r.UnidPendientes)]));
  const stockRaw   = new Map(stockRows.map(r => [String(r.IdProducto), parseFloat(r.StockActual)]));
  const stockTodosRaw = new Map(stockTodosRows.map(r => [String(r.IdProducto), parseFloat(r.StockActual)]));
  const stockSucRaw   = new Map(stockSucRows.map(r => [String(r.IdProducto), parseFloat(r.StockActual)]));
  const bomRaw     = new Map();
  for (const b of bomRows) { const k = String(b.IdProducto); if (!bomRaw.has(k)) bomRaw.set(k, b); }
  const granelMap  = new Map(granelRows.map(r => [String(r.IdProducto), parseFloat(r.StockGranel)]));
  for (const r of customGranelStockRows) if (!granelMap.has(String(r.IdProducto))) granelMap.set(String(r.IdProducto), parseFloat(r.Stock));
  const customGranelNomMap = new Map(customGranelNomRows.map(r=>[String(r.IdProducto), r.NombreProducto]));
  const facturRaw = new Map(facturRows.map(r => [String(r.IdProducto), parseFloat(r.TotalFacturado) || 0]));
  // Variantes ≤200g de grupos NO enKg (mixes/FS): Cantidad SQL en unidades → convertir a kg
  const pluMetaMap = new Map(catalogo.map(i => [String(i.plu), i]));
  const enKgRefIds = new Set([...refMap.entries()].filter(([,ri]) => (c.gruposGranelEnKg||[]).includes(ri.productoRef)).map(([id]) => id));
  const consumoBaseVentana = new Map(), consumoBasePorDia = new Map();
  const stockBase = new Map(), stockBaseAll = new Map(), stockSucBase = new Map(), pendBase = new Map(), facturBase = new Map();
  for (const [plu, base] of pluToBase) {
    let total = consumoTotalRaw.get(plu) || 0;
    const dias = consumoDiasRaw.get(plu) || 0;
    const meta  = pluMetaMap.get(plu);
    const bInfo = baseMap.get(base);
    if (meta && meta.esVariante && bInfo && !enKgRefIds.has(bInfo.refId)) {
      const w = pesoEnKg(meta.presentacion);
      if (w !== null && w <= 0.2) total = total * w;
    }
    const rateVentana = ventana > 0 ? total / ventana : 0;   // demanda real diaria
    const ratePorDia  = dias    > 0 ? total / dias    : 0;   // intensidad (días que vendió)
    consumoBaseVentana.set(base, (consumoBaseVentana.get(base) || 0) + rateVentana);
    consumoBasePorDia.set(base,  (consumoBasePorDia.get(base)  || 0) + ratePorDia);
    // Stock SOLO de artículos base (sin check de variante). Las variantes no suman stock.
    const esVar = !!(meta && meta.esVariante);
    pendBase.set(base,     (pendBase.get(base)     || 0) + (pendRaw.get(plu)         || 0));
    stockBase.set(base,    (stockBase.get(base)    || 0) + (esVar ? 0 : (stockRaw.get(plu)      || 0)));
    stockBaseAll.set(base, (stockBaseAll.get(base) || 0) + (esVar ? 0 : (stockTodosRaw.get(plu) || 0)));
    stockSucBase.set(base, (stockSucBase.get(base) || 0) + (esVar ? 0 : (stockSucRaw.get(plu)   || 0)));
    facturBase.set(base,   (facturBase.get(base)   || 0) + (facturRaw.get(plu)       || 0));
  }
  const grupos = [];
  for (const [refId, refInfo] of refMap) {
    // Stock del granel del grupo (se necesita ANTES de calcular consumo para elegir denominador)
    const esGranelCheck = cfgEsGranel(gruposCfg, refInfo.productoRef, c.gruposGranel);
    let granelStockGrupo = 0, nombreGranelGrupo = '', granelResuelto = false, granelIdGrupo = '';
    if (esGranelCheck) {
      let base10 = null;
      for (const [base, bInfo] of refInfo.bases) { if (/10\s*kg/i.test(base) && bInfo.pluBase) { base10 = base; granelIdGrupo = String(bInfo.pluBase); break; } }
      if (base10) { granelStockGrupo = stockBaseAll.get(base10) || 0; nombreGranelGrupo = base10; granelResuelto = true; }
    } else {
      granelStockGrupo = Math.round([...refInfo.bases.keys()].reduce((s, base) => s + (stockBase.get(base) || 0), 0) * 100) / 100;
    }
    // Denominador: ÷ventana (demanda real) salvo que el producto esté sin stock → ÷días-con-venta (quiebre de stock)
    const usarPorDia = granelStockGrupo <= 0;
    const consumoBaseUse = usarPorDia ? consumoBasePorDia : consumoBaseVentana;
    const presentaciones = [];
    for (const [base, bInfo] of refInfo.bases) {
      if (!bInfo.pluBase) continue; // solo mostrar productos base (esVariante=false)
      const pluBase = bInfo.pluBase;
      const prom = consumoBaseUse.get(base) || 0, pend = pendBase.get(base) || 0, stock = stockBase.get(base) || 0;
      const stockSucursales = Math.round((stockSucBase.get(base) || 0) * 100) / 100; // stock en sucursales (no central)
      const stockEfectivo = Math.round(stock * incStock * 100) / 100; // stock que cuenta en el sugerido (incidencia config)
      const bom = pluBase ? bomRaw.get(pluBase) : null;
      const customGPlu = cfgGranelPlu(gruposCfg, refInfo.productoRef);
      const idGranel   = bom ? String(bom.IdProductoComponente) : customGPlu;
      const nomGranel  = bom ? bom.NombreComponente : (customGPlu ? (customGranelNomMap.get(customGPlu)||customGPlu) : '');
      const cantPU     = bom ? parseFloat(bom.CantPorUnidad || 0) : 0;
      let diasStock  = prom > 0 ? stock / prom : (stock > 0 ? Infinity : 0);
      const semaforo = diasStock < c.umbralRojo ? 'RED' : diasStock < c.umbralAmarillo ? 'YELLOW' : 'GREEN';
      let cantSugerida = 0;
      if (diasStock < c.minDiasParaSugerir || pend > 0) cantSugerida = Math.max(0, Math.ceil((prom * diasObj) - stockEfectivo + pend));
      const granelNec = Math.round(cantSugerida * cantPU * 100) / 100;
      const granelDisp = idGranel ? (granelMap.get(idGranel) || 0) : null;
      const granelOk  = granelNec === 0 || granelDisp === null || granelDisp >= granelNec;
      const urgencia  = (isFinite(diasStock) ? -diasStock : 0) + (pend / Math.max(prom, 0.001))
                      + (semaforo === 'RED' ? 1000 : semaforo === 'YELLOW' ? 100 : 0) + (!granelOk ? 50 : 0);
      presentaciones.push({ plu: pluBase, baseNombre: base, presentacion: bInfo.presentacion,
        stockActual: stock, stockEfectivo, stockSucursales, promDiario: Math.round(prom * 100) / 100, promMes: Math.round(prom * 30 * 10) / 10,
        diasStock: isFinite(diasStock) ? Math.round(diasStock * 10) / 10 : 9999,
        semaforo, pendientes: pend, cantSugerida, idGranel, nombreGranel: nomGranel, cantPorUnidad: cantPU,
        granelNecesario: granelNec, granelDisponible: granelDisp !== null ? Math.round(granelDisp * 100) / 100 : null,
        granelOk, urgencia });
    }
    if (!presentaciones.length) continue;
    const mergeMap = new Map();
    for (const p of presentaciones) {
      const key = p.presentacion;
      if (!mergeMap.has(key)) { mergeMap.set(key, { ...p }); } else {
        const m = mergeMap.get(key);
        m.stockActual += p.stockActual; m.stockEfectivo = Math.round((m.stockEfectivo + p.stockEfectivo) * 100) / 100;
        m.stockSucursales = Math.round((m.stockSucursales + p.stockSucursales) * 100) / 100;
        m.promDiario = Math.round((m.promDiario + p.promDiario) * 100) / 100;
        m.promMes = Math.round((m.promMes + p.promMes) * 10) / 10; m.pendientes += p.pendientes;
        m.cantSugerida += p.cantSugerida; m.granelNecesario += p.granelNecesario;
        const ds = m.promDiario > 0 ? m.stockActual / m.promDiario : (m.stockActual > 0 ? Infinity : 0);
        m.diasStock = isFinite(ds) ? Math.round(ds * 10) / 10 : 9999;
        m.semaforo = (m.semaforo === 'RED' || p.semaforo === 'RED') ? 'RED' : (m.semaforo === 'YELLOW' || p.semaforo === 'YELLOW') ? 'YELLOW' : 'GREEN';
        m.granelOk = m.granelOk && p.granelOk; m.urgencia = Math.max(m.urgencia, p.urgencia);
      }
    }
    const presFinal = [...mergeMap.values()].sort((a, b) => a.presentacion.localeCompare(b.presentacion));
    const presConDemanda = presFinal.filter(p => p.promDiario > 0 || p.pendientes > 0);
    if (!presFinal.length) continue; // sin presentaciones reales → saltar
    const presRef = presConDemanda.length ? presConDemanda : presFinal;
    const semaforoGrupo = presRef.some(p => p.semaforo === 'RED') ? 'RED' : presRef.some(p => p.semaforo === 'YELLOW') ? 'YELLOW' : 'GREEN';
    const urgenciaGrupo = presConDemanda.length ? Math.max(...presConDemanda.map(p => p.urgencia)) : 0;
    const esGranel = esGranelCheck;
    if (esGranel) {
      const enKg = (c.gruposGranelEnKg || []).includes(refInfo.productoRef);
      let totalPromMes, totalPend;
      // Toda Cantidad en SQL está en kg (corregido en aggregación para pack/bulto ≤200g)
      totalPromMes = Math.round(presRef.reduce((s, p) => s + p.promMes, 0) * 10) / 10;
      totalPend    = Math.round(presRef.reduce((s, p) => s + p.pendientes, 0) * 100) / 100;
      const promDiarioTotal = totalPromMes / 30;
      const totalSugerido   = Math.max(0, Math.ceil((promDiarioTotal * diasObj) - granelStockGrupo + totalPend));
      const facturGrupoG = [...refInfo.bases.keys()].reduce((s, base) => s + (facturBase.get(base) || 0), 0);
      const facturMensualG = Math.round(facturGrupoG * (30 / ventana) * 100) / 100;
      const stockSucGrupo = Math.round([...refInfo.bases.keys()].reduce((s, base) => s + (stockSucBase.get(base) || 0), 0) * 100) / 100;
      const plusGrupo = [...refInfo.bases.values()].map(b => b.pluBase).filter(Boolean).map(String);
      grupos.push({ refId, productoRef: refInfo.productoRef, semaforo: semaforoGrupo, urgencia: urgenciaGrupo,
        totalSugerido, esGranel: true, enKg, totalPromMes, totalPend, granelStockGrupo, nombreGranelGrupo, stockSucGrupo,
        plus: plusGrupo, granelId: granelIdGrupo,
        facturacionMensual: facturMensualG, presentaciones: [] });
      continue;
    }
    const totalSugerido = presFinal.reduce((s, p) => s + p.cantSugerida, 0);
    const facturGrupo  = [...refInfo.bases.keys()].reduce((s, base) => s + (facturBase.get(base) || 0), 0);
    const facturMensual = Math.round(facturGrupo * (30 / ventana) * 100) / 100;
    grupos.push({ refId, productoRef: refInfo.productoRef, semaforo: semaforoGrupo, urgencia: urgenciaGrupo,
      totalSugerido, esGranel: false, granelStockGrupo, nombreGranelGrupo,
      facturacionMensual: facturMensual, presentaciones: presFinal });
  }
  // Ranking: score = 0.6*facturNorm + 0.4*cantNorm (facturación + cantidad vendida mensual)
  const maxFact = Math.max(...grupos.map(g => g.facturacionMensual || 0), 1);
  const maxProm = Math.max(...grupos.map(g => g.totalPromMes || 0), 1);
  for (const g of grupos) {
    const fNorm = (g.facturacionMensual || 0) / maxFact;
    const cNorm = (g.totalPromMes       || 0) / maxProm;
    g.rankingScore = Math.round((0.6 * fNorm + 0.4 * cNorm) * 1000) / 1000;
  }
  const byRanking = [...grupos].sort((a, b) => b.rankingScore - a.rankingScore);
  byRanking.forEach((g, i) => { g.rankingPos = i + 1; });
  grupos.sort((a, b) => b.urgencia - a.urgencia);
  let out = grupos;
  if (params.soloRojos === '1') out = out.filter(g => g.semaforo === 'RED');
  if (params.q) { const q = String(params.q).toLowerCase(); out = out.filter(g => g.productoRef.toLowerCase().includes(q) || g.presentaciones.some(p => p.baseNombre.toLowerCase().includes(q))); }
  return out;
}

// ── Express app ────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});
app.use((req, res, next) => {
  const clean = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(clean) && clean !== '::1') {
    console.warn(`[bloqueado] ${clean}`); return res.status(403).send('Acceso restringido.');
  }
  next();
});
app.use((req, _res, next) => { console.log(`${new Date().toLocaleTimeString('es-AR')}  ${req.method} ${req.path}`); next(); });

// ── Rutas HTML ─────────────────────────────────────────────────────────────────
app.get('/favicon.png',   (_req, res) => res.sendFile(path.join(__dirname, 'favicon.png')));
app.get('/favicon.ico',   (_req, res) => res.redirect('/favicon.png'));
app.get('/',              (_req, res) => res.sendFile(path.join(__dirname, 'inicio.html')));
app.get('/pedidos',       (_req, res) => res.sendFile(path.join(__dirname, 'pedidos_web.html')));
app.get('/produccion',    (_req, res) => res.sendFile(path.join(__dirname, cfg.produccionHtml || 'apidelta_produccion_dia.html')));
app.get('/planificacion', (_req, res) => res.sendFile(path.join(__dirname, 'planificacion.html')));
app.get('/compras',       (_req, res) => res.sendFile(path.join(__dirname, 'dashboard_compras.html')));
app.get('/consumo',       (_req, res) => res.sendFile(path.join(__dirname, 'dashboard_consumo.html')));
app.get('/compras-modulo', (_req, res) => res.sendFile(path.join(__dirname, 'compras_modulo.html')));

// ── Persistencia JSON ──────────────────────────────────────────────────────────
const DATA_DIR       = path.join(__dirname, 'data');
const ORDENES_PATH   = path.join(DATA_DIR, 'ordenes.json');
const REGISTROS_PATH = path.join(DATA_DIR, 'registros.json');
const PLANES_PATH    = path.join(DATA_DIR, 'planes.json');
const RESP_PATH      = path.join(DATA_DIR, 'responsables.json');
const CATALOGO_PATH  = path.join(DATA_DIR, 'catalogo.json');
const GRUPOS_CFG_PATH = path.join(DATA_DIR, 'grupos_config.json');
const ENVASES_REG_PATH = path.join(DATA_DIR, 'envases_registro.json'); // [{codigo,nombre,stock}]
const CLIENTES_PATH    = path.join(DATA_DIR, 'clientes.json');          // [{id,nombre}]
const FORMULAS_PATH  = path.join(DATA_DIR, 'formulas.json'); // { "plu": [{plu,nombre,cantPorUnidad}] }
// cfg entry puede ser: true|false  o  {activo:bool, granelPlu:string, mpManual:[], granelDirecto:bool}
function cfgActivo(cfg, ref) { const v=cfg[ref]; if(v===undefined)return true; if(typeof v==='boolean')return v; return v.activo!==false; }
function cfgGranelPlu(cfg, ref) { const v=cfg[ref]; return (v&&typeof v==='object')?String(v.granelPlu||'').trim():''; }
// Override por grupo del modo "producir como granel". null = sin override (usa default de config.json gruposGranel).
function cfgGranelOverride(cfg, ref) { const v=cfg[ref]; return (v&&typeof v==='object'&&typeof v.granelDirecto==='boolean')?v.granelDirecto:null; }
function cfgEsGranel(cfg, ref, defaultList) { const o=cfgGranelOverride(cfg, ref); return o!==null?o:(defaultList||[]).includes(ref); }
function cfgMpManual(cfg, ref)  { const v=cfg[ref]; return (v&&typeof v==='object'&&Array.isArray(v.mpManual))?v.mpManual:[]; }
// Override por grupo de "es variedad de miel" (habilita tambor + sección Mieles). null = sin override.
function cfgEsMiel(cfg, ref)    { const v=cfg[ref]; return (v&&typeof v==='object'&&typeof v.esMiel==='boolean')?v.esMiel:null; }
const COMPRAS_PROD_PATH  = path.join(DATA_DIR, 'compras_productos.json');
const LEAD_TIMES_PATH    = path.join(DATA_DIR, 'lead_times.json');
const PRESENTACIONES_COMPRA_PATH = path.join(DATA_DIR, 'presentaciones_compra.json');
// NOTA: no se reusa ORDENES_PATH (data/ordenes.json) porque ya está en uso por /api/ordenes y
// /api/ordenes-produccion (órdenes de producción, dominio no relacionado) — archivo dedicado para no mezclar datos.
const ORDENES_COMPRA_PATH = path.join(DATA_DIR, 'ordenes_compra.json');

function leerJSON(p, def) { try { if (!fs.existsSync(p)) return def; return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; } }
function guardarJSON(p, data) { fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8'); }
function leerOrdenes()         { return leerJSON(ORDENES_PATH, []); }
function guardarOrdenes(arr)   { guardarJSON(ORDENES_PATH, arr); }
function leerRegistros()       { return leerJSON(REGISTROS_PATH, []); }
function guardarRegistros(arr) { guardarJSON(REGISTROS_PATH, arr); }

function params(req) {
  const q = req.query;
  return { desde: safeDate(q.desde), hasta: safeDate(q.hasta), localidades: safeIntList(q.localidades),
           clientes: safeIntList(q.clientes), pedidos: safeIntList(q.pedidos), estados: safeEstadoList(q.estados) };
}
function apiRoute(fn) {
  return async (req, res) => { try { res.json(await fn(req)); } catch (err) { console.error(err.message); res.status(500).json({ error: err.message }); } };
}

// ── Rutas API pedidos ──────────────────────────────────────────────────────────
app.get('/api/localidades', apiRoute(async req => { const p = params(req); return getLocalidades(p.desde, p.hasta, p.estados); }));
app.get('/api/estados',     apiRoute(async () => getEstados()));
app.get('/api/clientes',    apiRoute(async req => { const p = params(req); return getClientes(p.desde, p.hasta, p.localidades, p.estados); }));
app.get('/api/pedidos',     apiRoute(async req => { const p = params(req); return getPedidos(p.desde, p.hasta, p.localidades, p.clientes, p.estados); }));
app.get('/api/productos',   apiRoute(async req => { const p = params(req); return getProductos(p.desde, p.hasta, p.localidades, p.clientes, p.pedidos, p.estados); }));
app.get('/api/resumen',     apiRoute(async req => { const p = params(req); return getResumen(p.desde, p.hasta, p.localidades, p.clientes, p.pedidos, p.estados); }));
app.get('/api/facturas',    apiRoute(async req => {
  if (!req.query.numeroPedido) return { error: 'Falta el parámetro numeroPedido' };
  return getFacturasDePedido(req.query.idSucursal || 1, req.query.numeroPedido);
}));
app.route('/api/state')
  .get((_req, res) => res.json(sharedState))
  .post((req, res) => {
    const s = req.body || {};
    if (s.desde && /^\d{4}-\d{2}-\d{2}$/.test(s.desde)) sharedState.desde = s.desde;
    if (s.hasta  && /^\d{4}-\d{2}-\d{2}$/.test(s.hasta))  sharedState.hasta  = s.hasta;
    sharedState.localidades = safeIntList(s.localidades) || '';
    sharedState.clientes    = safeIntList(s.clientes)    || '';
    sharedState.pedidos     = safeIntList(s.pedidos)     || '';
    sharedState.estados     = safeEstadoListRaw(s.estados) || '';
    res.json(sharedState);
  });

app.get('/api/producto', apiRoute(async req => {
  const codigo = (req.query.codigo || '').trim();
  if (!codigo) return { error: 'Falta código' };
  const rows = await query(`SELECT TOP 1 p.IdProducto, p.NombreProducto, COALESCE(p.IdUnidadDeMedida,'') AS Unidad, p.EsCompuesto FROM dbo.Productos p WHERE p.IdProducto = '${codigo.replace(/'/g,"''")}' AND p.Activo = 1`);
  return rows.length ? rows[0] : { error: 'Producto no encontrado' };
}));
app.get('/api/productos/buscar', apiRoute(async req => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return [];
  const words = q.split(/\s+/).filter(w => w.length > 0).map(w => w.replace(/'/g, "''"));
  const nameConditions = words.map(w => `NombreProducto LIKE '%${w}%'`).join(' AND ');
  const codeMatch = words.length === 1 ? `OR IdProducto LIKE '%${words[0]}%'` : '';
  return await query(`SELECT TOP 15 IdProducto AS codigo, NombreProducto AS nombre FROM dbo.Productos WHERE ((${nameConditions}) ${codeMatch}) AND Activo = 1 ORDER BY NombreProducto`);
}));

app.get('/api/formula/schema', apiRoute(async req => {
  const codigo = (req.query.codigo || '').trim();
  const cols   = await query(`SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'ProductosFormulas' ORDER BY ORDINAL_POSITION`);
  const sample = codigo ? await query(`SELECT TOP 3 * FROM dbo.ProductosFormulas WHERE IdProducto = '${codigo.replace(/'/g,"''")}' `) : await query(`SELECT TOP 3 * FROM dbo.ProductosFormulas`);
  return { columnas: cols, muestra: sample };
}));
app.get('/api/formula', apiRoute(async req => {
  const codigo = (req.query.codigo || '').trim(), nombre = (req.query.producto || '').trim();
  const cantidad = parseFloat(req.query.cantidad) || 1;
  if (!codigo && !nombre) return { error: 'Falta código o nombre de producto' };
  let idProd = codigo;
  if (!idProd) {
    const safe = nombre.replace(/'/g, "''");
    const idRows = await query(`SELECT TOP 1 IdProducto FROM dbo.Productos WHERE NombreProducto = '${safe}' AND Activo = 1 UNION ALL SELECT TOP 1 IdProducto FROM dbo.Productos WHERE NombreProducto LIKE '%${safe}%' AND Activo = 1`);
    if (!idRows.length) return { producto: nombre, componentes: [], aviso: 'Producto no encontrado en SIGA' };
    idProd = idRows[0].IdProducto;
  }
  const safeId = String(idProd).replace(/'/g, "''");
  const rows = await query(`
    SELECT pc.IdProductoComponente AS IdComponente,
           p.NombreProducto AS Componente,
           pc.Cantidad AS CantPorUnidad,
           CAST(pc.Cantidad * ${cantidad} AS DECIMAL(18,3)) AS CantTotal,
           COALESCE(p.IdUnidadDeMedida,'') AS Unidad,
           COALESCE((SELECT SUM(pd2.Stock) FROM dbo.ProductosDepositos pd2 JOIN dbo.SucursalesDepositos sd2 ON sd2.IdDeposito=pd2.IdDeposito AND sd2.IdSucursal=pd2.IdSucursal WHERE pd2.IdProducto=pc.IdProductoComponente AND UPPER(sd2.NombreDeposito) LIKE '%GRANEL%'),0) AS StockGranel,
           COALESCE((SELECT SUM(pd3.Stock) FROM dbo.ProductosDepositos pd3 WHERE pd3.IdProducto=pc.IdProductoComponente),0) AS StockTotal
    FROM dbo.ProductosComponentes pc JOIN dbo.Productos p ON p.IdProducto=pc.IdProductoComponente
    WHERE pc.IdProducto='${safeId}'
    ORDER BY p.NombreProducto`);
  return { producto: nombre, idProducto: idProd, cantidad, componentes: rows };
}));

// ── Rutas API dashboard de compras ───────────────────────────────────────────────
app.get('/api/compras/consumo', apiRoute(async req => {
  const id = (req.query.id || '').trim();
  if (!id) return { error: 'Falta el parámetro id' };
  return analizarConsumoCompras(id, req.query.meses);
}));
app.get('/api/compras/urgencias', apiRoute(async req => {
  const meses = req.query.meses;
  const lista = leerJSON(COMPRAS_PROD_PATH, []);
  const CONC = 5;
  const out = [];
  for (let i = 0; i < lista.length; i += CONC) {
    const chunk = lista.slice(i, i + CONC);
    const res = await Promise.all(chunk.map(async p => {
      try {
        const r = await analizarConsumoCompras(p.id, meses);
        return {
          id: r.producto.id, nombre: r.producto.nombre, stock: r.stockCentral, costoKg: r.costoKg,
          ventasKgMes: r.resumen.ventasKgMes, produccionKgMes: r.resumen.produccionKgMes,
          totalKgMes: r.resumen.totalKgMes, cobertura: r.resumen.coberturaMeses,
          criticidad: r.resumen.criticidad, stockSeguridad: r.resumen.stockSeguridad,
          compra: r.resumen.compraSugerida,
          valorMensual: r.resumen.valorMensual, compraValor: r.resumen.compraSugeridaValor, stockValor: r.resumen.stockValor
        };
      } catch (e) { return { id: String(p.id), nombre: p.nombre, error: e.message }; }
    }));
    out.push(...res);
  }
  const usarValor = out.some(x => x.valorMensual != null);
  const peso = x => usarValor ? (x.valorMensual || 0) : (x.totalKgMes || 0);
  const totalPeso = out.reduce((s, x) => s + peso(x), 0) || 1;
  const porPeso = [...out].sort((a, b) => peso(b) - peso(a));
  let acum = 0;
  for (const x of porPeso) {
    x.shareConsumo = +(100 * peso(x) / totalPeso).toFixed(1);
    acum += peso(x);
    const acumShare = 100 * acum / totalPeso;
    x.clase = peso(x) <= 0 ? '-' : acumShare <= 80 ? 'A' : acumShare <= 95 ? 'B' : 'C';
  }
  const factorImp = { A: 1, B: 0.65, C: 0.4, '-': 0.2 };
  out.forEach(x => {
    const f = factorImp[x.clase] != null ? factorImp[x.clase] : 0.2;
    x.prioridad = (x.totalKgMes > 0) ? Math.max(1, Math.min(100, Math.round((x.criticidad || 0) * f))) : 0;
  });
  const clasif = x => x.error ? 'error' : x.totalKgMes <= 0 ? 'sin' : x.prioridad >= 67 ? 'critico' : x.prioridad >= 34 ? 'atencion' : 'ok';
  out.forEach(x => { x.estado = clasif(x); });
  out.sort((a, b) => ((b.prioridad || 0) - (a.prioridad || 0)) || (peso(b) - peso(a)));
  const conteo = { critico: 0, atencion: 0, ok: 0, sin: 0, error: 0, A: 0, B: 0, C: 0 };
  out.forEach(x => { conteo[x.estado]++; if (x.clase === 'A' || x.clase === 'B' || x.clase === 'C') conteo[x.clase]++; });
  const totalCompraValor = out.reduce((s, x) => s + (x.compraValor || 0), 0);
  const totalValorMensual = out.reduce((s, x) => s + (x.valorMensual || 0), 0);
  return { meses: Math.min(Math.max(parseInt(meses) || 24, 1), 60), usarValor, conteo, totalCompraValor, totalValorMensual, productos: out };
}));
app.get('/api/compras/buscar', apiRoute(async req => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return [];
  const safe = q.replace(/'/g, "''");
  const porId = /^\d+$/.test(q) ? `p.IdProducto='${safe}' OR ` : '';
  return query(`SELECT TOP 25 p.IdProducto, p.NombreProducto, COALESCE(r.NombreRubro,'') AS NombreRubro
    FROM Productos p LEFT JOIN Rubros r ON r.IdRubro=p.IdRubro
    WHERE (${porId}p.NombreProducto LIKE '%${safe}%') AND p.Activo=1
    ORDER BY CASE WHEN p.IdProducto='${safe}' THEN 0 ELSE 1 END, p.NombreProducto`);
}));
app.get('/api/compras/productos', (_req, res) => res.json(leerJSON(COMPRAS_PROD_PATH, [])));
app.post('/api/compras/productos', (req, res) => {
  const o = req.body || {};
  if (!o.id) return res.status(400).json({ error: 'Falta id' });
  const id = String(o.id).trim();
  const arr = leerJSON(COMPRAS_PROD_PATH, []).filter(x => String(x.id) !== id);
  arr.push({ id, nombre: o.nombre || id });
  guardarJSON(COMPRAS_PROD_PATH, arr);
  res.json(arr);
});
app.delete('/api/compras/productos/:id', (req, res) => {
  const arr = leerJSON(COMPRAS_PROD_PATH, []).filter(x => String(x.id) !== String(req.params.id));
  guardarJSON(COMPRAS_PROD_PATH, arr);
  res.json(arr);
});

// ── Panel de compras (estadístico, por proveedor) ─────────────────────────────
const PANEL_Z          = 1.65;   // Z normal al 90%
const PANEL_COB_OBJ    = 45;     // días de cobertura objetivo

function calcConsumoStats(entries, currentY, currentM) {
  const lk = {};
  for (const { Y, M, Q } of entries) {
    const k = `${Y}_${M}`; lk[k] = (lk[k] || 0) + Q;
  }
  const last12 = [];
  for (let i = 1; i <= 12; i++) {
    let Y = currentY, M = currentM - i;
    while (M <= 0) { M += 12; Y--; }
    last12.push(lk[`${Y}_${M}`] || 0);
  }
  const total12m = last12.reduce((s, v) => s + v, 0);
  const avg = total12m / 12;
  const variance = last12.length > 1
    ? last12.reduce((s, v) => s + (v - avg) ** 2, 0) / (last12.length - 1) : 0;
  const stdDev = Math.sqrt(Math.max(0, variance));
  let nextM = currentM + 1, nextY = currentY;
  if (nextM > 12) { nextM = 1; nextY++; }
  const smpy = lk[`${nextY - 1}_${nextM}`] || 0;
  const seasonalIdx = avg > 0 && smpy > 0 ? Math.min(3, Math.max(0.1, smpy / avg)) : 1;
  return { avg, stdDev, total12m, seasonalIdx };
}

async function calcularPanelCompras() {
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  const ltDefault = c.comprasLeadTimeDias || 14;
  const cobObjDias = PANEL_COB_OBJ;
  const leadTimes = leerJSON(LEAD_TIMES_PATH, {});
  const getLT = prov => {
    if (!prov) return ltDefault;
    const key = prov.toUpperCase().trim();
    for (const [k, v] of Object.entries(leadTimes)) {
      if (!k.startsWith('_') && k.toUpperCase() === key) return Number(v) || ltDefault;
    }
    return leadTimes._default != null ? Number(leadTimes._default) : ltDefault;
  };

  const today = new Date();
  const currentY = today.getFullYear(), currentM = today.getMonth() + 1;

  const [consumoRows, stockRows, provRows, pedidoRows] = await Promise.all([
    query(`
      SELECT vp.IdProducto, p.NombreProducto,
        CASE WHEN UPPER(ISNULL(cat.NombreCategoria,'')) LIKE '%MAYOR%' THEN 'Mayorista' ELSE 'Minorista' END AS Canal,
        YEAR(v.Fecha) AS Anio, MONTH(v.Fecha) AS Mes, SUM(vp.Cantidad) AS Cantidad
      FROM VentasProductos vp
      JOIN Ventas v ON v.IdSucursal=vp.IdSucursal AND v.IdTipoComprobante=vp.IdTipoComprobante
                   AND v.Letra=vp.Letra AND v.CentroEmisor=vp.CentroEmisor AND v.NumeroComprobante=vp.NumeroComprobante
      JOIN Productos p ON p.IdProducto=vp.IdProducto
      LEFT JOIN Categorias cat ON cat.IdCategoria=v.IdCategoria
      WHERE v.Fecha >= DATEADD(MONTH,-13,CAST(GETDATE() AS DATE))
        AND v.Fecha < CAST(GETDATE() AS DATE)
        AND ISNULL(v.IdEstadoComprobante,'') != 'ANULADO'
        AND v.IdTipoComprobante NOT IN (${COMPRAS_EXCL_TC})
        AND (v.IdCategoria IS NULL OR v.IdCategoria != 5)
        AND p.Activo=1
      GROUP BY vp.IdProducto, p.NombreProducto,
        CASE WHEN UPPER(ISNULL(cat.NombreCategoria,'')) LIKE '%MAYOR%' THEN 'Mayorista' ELSE 'Minorista' END,
        YEAR(v.Fecha), MONTH(v.Fecha)`),
    query(`
      SELECT pd.IdProducto,
        SUM(CASE WHEN s.SoyLaCentral=1 THEN pd.Stock ELSE 0 END) AS StockCC,
        SUM(CASE WHEN s.SoyLaCentral=0 THEN pd.Stock ELSE 0 END) AS StockSuc
      FROM ProductosDepositos pd
      INNER JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal
      INNER JOIN Sucursales s ON s.IdSucursal=pd.IdSucursal
      GROUP BY pd.IdProducto HAVING SUM(pd.Stock) > 0`),
    query(`
      SELECT pp.IdProducto, p.NombreProducto, pv.NombreProveedor,
        CAST(pp.UltimoPrecioCompra AS FLOAT) AS Precio,
        CONVERT(varchar(10),pp.UltimaFechaCompra,23) AS FechaPrecio
      FROM ProductosProveedores pp
      JOIN Proveedores pv ON pv.IdProveedor=pp.IdProveedor
      JOIN Productos p ON p.IdProducto=pp.IdProducto
      WHERE pp.UltimoPrecioCompra > 0 AND p.Activo=1
      ORDER BY pp.IdProducto, pp.UltimaFechaCompra DESC`),
    query(`
      SELECT ppp.IdProducto, SUM(ppp.CantPendiente) AS EnPedido
      FROM PedidosProductosProveedores ppp
      WHERE ppp.CantPendiente > 0
        AND EXISTS (
          SELECT 1 FROM PedidosEstadosProveedores pes
          WHERE pes.IdSucursal=ppp.IdSucursal AND pes.IdTipoComprobante=ppp.IdTipoComprobante
            AND pes.NumeroPedido=ppp.NumeroPedido AND pes.IdProducto=ppp.IdProducto AND pes.Orden=ppp.Orden
            AND pes.IdEstado IN ('PENDIENTE','EN PROCESO','RESERVADO','EN AGUA')
            AND pes.FechaEstado=(SELECT MAX(pes2.FechaEstado) FROM PedidosEstadosProveedores pes2
              WHERE pes2.IdSucursal=pes.IdSucursal AND pes2.IdTipoComprobante=pes.IdTipoComprobante
                AND pes2.NumeroPedido=pes.NumeroPedido AND pes2.IdProducto=pes.IdProducto AND pes2.Orden=pes.Orden)
        )
      GROUP BY ppp.IdProducto HAVING SUM(ppp.CantPendiente) > 0`).catch(() => [])
  ]);

  // Build lookup maps
  const nombresMap = new Map(), consumoMap = new Map();
  for (const r of consumoRows) {
    const id = String(r.IdProducto);
    nombresMap.set(id, r.NombreProducto);
    if (!consumoMap.has(id)) consumoMap.set(id, new Map());
    const canales = consumoMap.get(id);
    if (!canales.has(r.Canal)) canales.set(r.Canal, []);
    canales.get(r.Canal).push({ Y: r.Anio, M: r.Mes, Q: Number(r.Cantidad) });
  }
  const stockMap = new Map();
  for (const r of stockRows) {
    stockMap.set(String(r.IdProducto), { stCC: Number(r.StockCC || 0), stSuc: Number(r.StockSuc || 0) });
  }
  const provMap = new Map();
  for (const r of provRows) {
    const id = String(r.IdProducto);
    nombresMap.set(id, r.NombreProducto);
    if (!provMap.has(id)) provMap.set(id, { nombre: r.NombreProveedor, precio: Number(r.Precio || 0), fecha: r.FechaPrecio || '' });
  }
  const enPedidoMap = new Map();
  for (const r of pedidoRows) enPedidoMap.set(String(r.IdProducto), Number(r.EnPedido || 0));

  // Only products with a provider entry (to keep panel focused and avoid noise)
  const allIds = new Set([...provMap.keys()]);

  const panel = [];
  for (const id of allIds) {
    const nombre = nombresMap.get(id) || id;
    const prov = provMap.get(id);
    const st = stockMap.get(id) || { stCC: 0, stSuc: 0 };
    const stTotal = st.stCC + st.stSuc;
    const enPed = enPedidoMap.get(id) || 0;
    const lt = getLT(prov.nombre);

    const canales = consumoMap.get(id) || new Map();
    const sMin = calcConsumoStats(canales.get('Minorista') || [], currentY, currentM);
    const sMay = calcConsumoStats(canales.get('Mayorista') || [], currentY, currentM);
    const avgTot = sMin.avg + sMay.avg;

    if (avgTot === 0 && stTotal === 0) continue;

    const ltM = Math.max(0.1, lt / 30);
    const ssMin = Math.ceil(PANEL_Z * sMin.stdDev * Math.sqrt(ltM));
    const ssMay = Math.ceil(PANEL_Z * sMay.stdDev * Math.sqrt(ltM));
    const demMin = Math.max(0, sMin.avg * sMin.seasonalIdx);
    const demMay = Math.max(0, sMay.avg * sMay.seasonalIdx);
    const demTot = demMin + demMay;

    const cobDias = demTot > 0 ? +(((stTotal + enPed) / demTot * 30)).toFixed(1) : 999;

    const partMin = avgTot > 0 ? sMin.avg / avgTot : 0.5;
    const partMay = 1 - partMin;
    const sugMin = Math.max(0, Math.ceil(demMin * (cobObjDias / 30) + ssMin - stTotal * partMin - enPed * partMin));
    const sugMay = Math.max(0, Math.ceil(demMay * (cobObjDias / 30) + ssMay - stTotal * partMay - enPed * partMay));
    const sugTot = sugMin + sugMay;

    const semaforo = cobDias <= lt ? 'CRITICO' : cobDias <= 30 ? 'ALERTA' : cobDias <= cobObjDias ? 'REVISAR' : 'OK';

    panel.push({
      id, nombre,
      proveedor: prov.nombre, precio: +prov.precio.toFixed(2), fechaPrecio: prov.fecha,
      stockCC: +st.stCC.toFixed(2), stockSuc: +st.stSuc.toFixed(2), stockTotal: +stTotal.toFixed(2),
      enPedido: +enPed.toFixed(2), leadTime: lt,
      consumoMin: +sMin.avg.toFixed(2), consumoMay: +sMay.avg.toFixed(2), consumoTotal: +avgTot.toFixed(2),
      indEstMin: +sMin.seasonalIdx.toFixed(2), indEstMay: +sMay.seasonalIdx.toFixed(2),
      stockSegMin: ssMin, stockSegMay: ssMay, stockSegTotal: ssMin + ssMay,
      demandaMin: +demMin.toFixed(2), demandaMay: +demMay.toFixed(2),
      coberturaActual: cobDias,
      sugeridoMin: sugMin, sugeridoMay: sugMay, sugeridoTotal: sugTot,
      importeSugerido: Math.round(sugTot * prov.precio),
      semaforo
    });
  }

  const sOrd = { CRITICO: 0, ALERTA: 1, REVISAR: 2, OK: 3 };
  panel.sort((a, b) => (sOrd[a.semaforo] - sOrd[b.semaforo]) || (b.importeSugerido - a.importeSugerido));

  const conteo = { CRITICO: 0, ALERTA: 0, REVISAR: 0, OK: 0 };
  let totalImporte = 0;
  for (const p of panel) { conteo[p.semaforo]++; totalImporte += p.importeSugerido; }

  return { productos: panel, conteo, totalImporte, total: panel.length,
           fechaCalculo: new Date().toISOString() };
}

app.get('/api/panel/datos', apiRoute(async () => calcularPanelCompras()));
app.get('/api/panel/lead-times', (_req, res) => {
  const lt = leerJSON(LEAD_TIMES_PATH, {});
  const items = Object.entries(lt).filter(([k]) => !k.startsWith('_'))
    .map(([proveedor, leadTime]) => ({ proveedor, leadTime: Number(leadTime) }))
    .sort((a, b) => a.proveedor.localeCompare(b.proveedor));
  res.json({ items, default: lt._default != null ? Number(lt._default) : 14 });
});
app.post('/api/panel/lead-times', (req, res) => {
  const { items, default: def } = req.body || {};
  const obj = { _default: Number(def) || 14 };
  if (Array.isArray(items)) for (const { proveedor, leadTime } of items) if (proveedor) obj[String(proveedor).trim()] = Number(leadTime) || 14;
  guardarJSON(LEAD_TIMES_PATH, obj);
  res.json({ ok: true });
});

// ── Rutas API órdenes ──────────────────────────────────────────────────────────
app.get('/api/ordenes',        (_req, res) => res.json(leerOrdenes()));
app.post('/api/ordenes',       (req, res)  => { const o = req.body; if (!o || !o.id) return res.status(400).json({ error: 'Falta orden' }); const arr = leerOrdenes().filter(x => x.id !== o.id); arr.push(o); guardarOrdenes(arr); res.json(o); });
app.put('/api/ordenes/:id',    (req, res)  => { const id = parseInt(req.params.id), arr = leerOrdenes(), idx = arr.findIndex(o => o.id === id); if (idx < 0) return res.status(404).json({ error: 'No encontrado' }); arr[idx] = { ...arr[idx], ...req.body }; guardarOrdenes(arr); res.json(arr[idx]); });
app.delete('/api/ordenes/:id', (req, res)  => { guardarOrdenes(leerOrdenes().filter(o => o.id !== parseInt(req.params.id))); res.json({ ok: true }); });
app.delete('/api/ordenes',     (_req, res) => { guardarOrdenes([]); res.json({ ok: true }); });

app.get('/api/registros',  (_req, res) => res.json(leerRegistros()));
app.post('/api/registros', (req, res)  => {
  const ordenes = leerOrdenes();
  const todasCargas = leerJSON(PROD_REG_PATH, []);
  if (!ordenes.length && !todasCargas.length) return res.status(400).json({ error: 'No hay producción ni órdenes para registrar' });
  // Mapa ordenId -> fecha de su carga, para ubicar cada orden en el snapshot de su día.
  const ordenFecha = {};
  todasCargas.forEach(c => { if (c.ordenId != null) ordenFecha[String(c.ordenId)] = c.fecha; });
  const hoy = new Date().toISOString().slice(0, 10);
  const ahora = new Date().toISOString();
  // Fechas a archivar: las presentes en cargas; si no hay cargas pero sí órdenes, el día de hoy.
  const fechas = [...new Set(todasCargas.map(c => c.fecha))];
  if (!fechas.length && ordenes.length) fechas.push(hoy);
  const buildResumen = (ords) => {
    const total = ords.length, comp = ords.filter(o => o.estado === 'listo').length;
    const enProc = ords.filter(o => o.estado === 'en_proceso').length, pend = ords.filter(o => o.estado === 'pendiente').length;
    const totUnid = ords.reduce((s, o) => s + (parseInt(o.cantidad) || 0), 0);
    const compUnid = ords.filter(o => o.estado === 'listo').reduce((s, o) => s + (parseInt(o.cantidad) || 0), 0);
    const secMap = {};
    ords.forEach(o => { if (!secMap[o.seccion]) secMap[o.seccion] = { total: 0, completadas: 0, unidades: 0 }; secMap[o.seccion].total++; secMap[o.seccion].unidades += parseInt(o.cantidad) || 0; if (o.estado === 'listo') secMap[o.seccion].completadas++; });
    return { total, completadas: comp, enProceso: enProc, pendientes: pend, pctCompletado: total ? Math.round((comp / total) * 100) : 0,
             totalUnidades: totUnid, unidadesCompletadas: compUnid, porSeccion: Object.entries(secMap).map(([seccion, v]) => ({ seccion, ...v })) };
  };
  const arr = leerRegistros();
  const creados = [];
  fechas.sort().forEach((fecha, i) => {
    const cargas = todasCargas.filter(c => c.fecha === fecha);
    const ords = ordenes.filter(o => ordenFecha[String(o.id)] === fecha);
    const registro = { id: Date.now() + i, fecha, fechaHora: ahora, ordenes: ords, cargas, resumen: buildResumen(ords) };
    arr.unshift(registro);
    creados.push(registro);
  });
  guardarRegistros(arr);
  if (req.query.limpiar === '1') {
    // Quitar las órdenes completadas; las pendientes siguen en ordenes.json. Drenar TODAS las cargas archivadas.
    guardarOrdenes(ordenes.filter(o => o.estado !== 'listo'));
    guardarJSON(PROD_REG_PATH, []);
  }
  res.json({ ok: true, snapshots: creados.length, registros: creados });
});
app.delete('/api/registros/:id', (req, res) => {
  const id = Number(req.params.id);
  const arr = leerRegistros();
  const nuevo = arr.filter(x => x.id !== id);
  if (nuevo.length === arr.length) return res.status(404).json({ error: 'no encontrado' });
  guardarRegistros(nuevo);
  res.json({ ok: true });
});

// ── Rutas API planificación ────────────────────────────────────────────────────
app.get('/api/health',       apiRoute(async () => { await getPool(); return { ok: true, db: true, fecha: new Date().toISOString().slice(0, 10) }; }));
app.get('/api/config',       (_req, res) => res.json(JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'))));
app.get('/api/catalogo',     (_req, res) => res.json(leerJSON(CATALOGO_PATH, [])));

// ── Grupos del catálogo con config de activos ────────────────────────────────
app.get('/api/catalogo/grupos', (_req, res) => {
  const catalogo  = leerJSON(CATALOGO_PATH, []);
  const gruposCfg = leerJSON(GRUPOS_CFG_PATH, {});
  const cCfg      = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  const mapa = new Map();
  for (const item of catalogo) {
    const ref = item.productoRef || '';
    if (!mapa.has(ref)) mapa.set(ref, { productoRef: ref, total: 0, variantes: 0, bases: new Set() });
    const g = mapa.get(ref);
    g.total++;
    if (item.esVariante) g.variantes++; else g.bases.add(item.baseNombre);
  }
  const grupos = [...mapa.values()].sort((a, b) => a.productoRef.localeCompare(b.productoRef)).map(g => ({
    productoRef:  g.productoRef,
    totalPlu:     g.total,
    presentaciones: g.bases.size,
    variantes:    g.variantes,
    activo:       cfgActivo(gruposCfg, g.productoRef),
    granelPlu:    cfgGranelPlu(gruposCfg, g.productoRef),
    mpManual:     cfgMpManual(gruposCfg, g.productoRef),
    esGranel:        cfgEsGranel(gruposCfg, g.productoRef, cCfg.gruposGranel),
    granelDirecto:   cfgGranelOverride(gruposCfg, g.productoRef),
    esMiel:          cfgEsMiel(gruposCfg, g.productoRef)
  }));
  res.json(grupos);
});

app.post('/api/catalogo/grupos-config', (req, res) => {
  const cfg = req.body;
  if (typeof cfg !== 'object' || Array.isArray(cfg))
    return res.status(400).json({ error: 'Se esperaba un objeto' });
  // Normalizar: si un entry es {activo:true, granelPlu:''} → true (compactar)
  const normalizado = {};
  for (const [k,v] of Object.entries(cfg)) {
    if (v && typeof v === 'object') {
      const a = v.activo !== false;
      const g = String(v.granelPlu||'').trim();
      const mp = Array.isArray(v.mpManual) ? v.mpManual.filter(x => x && x.nombre) : [];
      const gd = (typeof v.granelDirecto === 'boolean') ? v.granelDirecto : undefined;
      const em = (typeof v.esMiel === 'boolean') ? v.esMiel : undefined;
      if (!g && !mp.length && gd === undefined && em === undefined) { normalizado[k] = a; }
      else { normalizado[k] = {activo:a, ...(g?{granelPlu:g}:{}), ...(mp.length?{mpManual:mp}:{}), ...(gd!==undefined?{granelDirecto:gd}:{}), ...(em!==undefined?{esMiel:em}:{})}; }
    } else { normalizado[k] = v; }
  }
  guardarJSON(GRUPOS_CFG_PATH, normalizado);
  res.json({ ok: true });
});

app.get('/api/siga/buscar', apiRoute(async req => {
  const q = (req.query.q || '').trim().replace(/'/g, "''");
  if (q.length < 2) return [];
  const esNumero = /^\d+$/.test(q);
  const rows = await query(`
    SELECT TOP 30
      CAST(p.IdProducto AS VARCHAR) AS plu,
      p.NombreProducto AS producto,
      COALESCE(r.NombreRubro, '') AS rubro
    FROM Productos p
    LEFT JOIN Rubros r ON r.IdRubro = p.IdRubro
    WHERE p.Activo = 1
      AND (${esNumero ? `CAST(p.IdProducto AS VARCHAR) LIKE '${q}%'` : `p.NombreProducto LIKE '%${q}%'`})
    ORDER BY p.NombreProducto`);
  return rows;
}));

app.get('/api/catalogo/grupo/:ref', (req, res) => {
  const ref      = decodeURIComponent(req.params.ref);
  const catalogo = leerJSON(CATALOGO_PATH, []);
  const items    = catalogo.filter(i => i.productoRef === ref);
  res.json(items);
});

app.put('/api/catalogo/grupo/:ref', (req, res) => {
  const ref      = decodeURIComponent(req.params.ref);
  const nuevos   = req.body;
  if (!Array.isArray(nuevos)) return res.status(400).json({ error: 'Se esperaba un array' });
  const catalogo = leerJSON(CATALOGO_PATH, []);
  const otros    = catalogo.filter(i => i.productoRef !== ref);
  // refId debe ser 1:1 con productoRef (clave de agrupación en buildCatalogoMaps).
  // El editor manda refId stale/null en grupos nuevos → no confiar en el del cliente:
  // reutilizar el refId existente de este grupo, o asignar uno único (máx + 1).
  let refId = catalogo.find(i => i.productoRef === ref && i.refId != null)?.refId;
  if (refId == null) {
    const maxRef = catalogo.reduce((m, i) => Math.max(m, Number(i.refId) || 0), 0);
    refId = maxRef + 1;
  }
  const normalizados = nuevos.map(i => ({ ...i, refId, productoRef: ref }));
  guardarJSON(CATALOGO_PATH, [...otros, ...normalizados]);
  res.json({ ok: true, productos: normalizados.length });
});

// ── Importar catálogo desde Excel ─────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function normalizarNombre(nombre) {
  let n = nombre.trim();
  n = n.replace(/\s+pack\b.*$/i,  '').trim();
  n = n.replace(/\s+bulto\b.*$/i, '').trim();
  n = n.replace(/\bvid\s+/i,      '').trim();
  n = n.replace(/\s+vid$/i,       '').trim();
  return n.trim();
}
const PRES_RE = /(\d+(?:[.,]\d+)?\s*(?:G|Kg|Ml|L|g|kg|ml|l))(?:\s+\w+)*$/i;
function extraerPresentacion(base) {
  const m = PRES_RE.exec(base);
  if (!m) return base;
  return m[0].trim().replace(/\bkg\b/i, 'Kg').replace(/\bg\b/i, 'G');
}

app.post('/api/catalogo/importar', upload.single('archivo'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Falta el archivo Excel' });
    const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    const filas = [];
    for (let i = 1; i < rows.length; i++) {
      const [plu, producto, refId, productoRef] = rows[i];
      if (plu == null || producto == null) continue;
      const pluInt = parseInt(plu);
      if (isNaN(pluInt)) continue;
      const nombreOrig   = String(producto).trim();
      const base         = normalizarNombre(nombreOrig);
      const presentacion = extraerPresentacion(base);
      const esVariante   = /\b(pack|bulto|vid)\b/i.test(nombreOrig);
      filas.push({
        plu: pluInt, producto: nombreOrig, baseNombre: base, presentacion, esVariante,
        refId: refId != null ? parseInt(refId) : null,
        productoRef: productoRef != null ? String(productoRef).trim() : ''
      });
    }
    guardarJSON(CATALOGO_PATH, filas);
    res.json({ ok: true, productos: filas.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get('/api/formulas',          (_req, res) => res.json(leerJSON(FORMULAS_PATH, {})));
app.get('/api/formulas/:plu',     (req, res) => { const f = leerJSON(FORMULAS_PATH, {}); res.json(f[String(req.params.plu)] || []); });
app.post('/api/formulas/:plu',    (req, res) => { const f = leerJSON(FORMULAS_PATH, {}); const plu = String(req.params.plu); if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Se esperaba array' }); if (req.body.length) f[plu] = req.body; else delete f[plu]; guardarJSON(FORMULAS_PATH, f); res.json({ ok: true }); });
app.get('/api/responsables', (_req, res) => res.json(leerJSON(RESP_PATH, [])));
app.post('/api/responsables', (req, res) => { guardarJSON(RESP_PATH, req.body); res.json(req.body); });
app.get('/api/stock/terminados', apiRoute(async () => { const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); return query(sqlStockTerminados(c.rubrosPlanificables.join(','))); }));
app.get('/api/stock/granel',     apiRoute(async () => { const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); return query(sqlStockGranel(c.rubrosGranel.join(','))); }));
app.get('/api/stock/plus',       apiRoute(async req => { const ids = String(req.query.ids||'').split(',').map(s=>s.trim()).filter(Boolean); if (!ids.length) return []; return query(sqlStockPorPlu(ids)); }));

// ── Distribución a sucursales (réplica hoja "Almacen") ──────────────────────────
const A8020_PATH           = path.join(DATA_DIR, 'a8020.json');
const DISTRIB_LISTAS_PATH  = path.join(DATA_DIR, 'distribucion_listas.json');
const PESABLES_LISTAS_PATH = path.join(DATA_DIR, 'pesables_listas.json');
const ENVIOS_MANUALES_PATH = path.join(DATA_DIR, 'envios_manuales.json');
// IdSucursal Siga → clave de stock del motor (6=Savio no se usa en Almacen). VERIFICAR con /api/distribucion/sucursales.
const DISTRIB_SUC_MAP = { 2:'urq', 3:'nacion', 4:'chaca', 5:'riv', 7:'sanpedro', 8:'sucu8', 9:'sucu9', 10:'pergamino', 11:'sucu11' };   // central resuelta por idCentral (config)
// Peso de la presentación (bolsa) en kg. Prioridad: (1) marcador "por kilo"/"x kg" → 1kg suelto
// (gana aunque el nombre tenga un número de bulto, ej "10Kg (Por Kilo)"); (2) último token de peso
// del nombre (250G→0.25, 1Kg→1, 500Gr→0.5); (3) cantFormula del componente; (4) 1kg.
function pesoPresentacionKg(nombre, cantFormula) {
  const n = String(nombre || '');
  if (/(por\s*kilo|x\s*kilo|x\s*kg|precio\s*x\s*kilo|por\s*kg)\b/i.test(n)) return 1;
  const re = /(\d+(?:[.,]\d+)?)\s*(kgs?|gramos|grs?|gr|g)\b/gi;
  let m, last = null;
  while ((m = re.exec(n)) !== null) last = m;
  if (last) {
    const val = parseFloat(last[1].replace(',', '.'));
    const u = last[2].toLowerCase();
    if (val > 0) {
      const kg = (u === 'kg' || u === 'kgs') ? val : val / 1000;   // g/gr/grs/gramos → kg
      if (kg > 0) return Math.round(kg * 1000) / 1000;
    }
  }
  const cf = Number(cantFormula);
  return (cf > 0) ? cf : 1;
}
function sqlStockDistribucion(plus) {
  const inList = plus.map(p => `'${p}'`).join(',');   // IdProducto es varchar en Siga → citar
  return `SELECT pd.IdSucursal, pd.IdProducto, COALESCE(SUM(pd.Stock),0) AS Stock
FROM ProductosDepositos pd
INNER JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal
WHERE sd.DisponibleVenta=1 AND pd.IdProducto IN (${inList})
GROUP BY pd.IdSucursal, pd.IdProducto`;
}
// enviar-key del motor Almacen → clave canónica de Fact
const ALM_FACT_KEY = { riv:'riv', urq:'urq', nacion:'nacion', chaca:'chaca', pergamino:'pergamino', sanPedro:'sanpedro', sucursal9:'ramallo', sucursal11:'sucu11' };
async function calcularDistribucionAlmacen() {
  const a8020  = leerJSON(A8020_PATH, {});
  const distCfg = leerJSON(DISTRIB_CONFIG_PATH, {});
  const empujePresencia = (distCfg.empujeDeposito || {}).presencia || 0;
  const empujePresenciaFactorS = (distCfg.empujeDeposito || {}).presenciaFactorS || 2;
  const presenciaPorClase = (distCfg.empujeDeposito || {}).presenciaPorClase || null;   // { A, B, C } → presencia según ABC; si falta, usa presencia plana
  const importanciaCfg = distCfg.importancia || {};
  const umbralMicroEnvio = distCfg.umbralMicroEnvio || { tramos: [{ hastaS: null, pct: 0.20 }], pisoAbsoluto: 1 };
  const a8020Calc = leerJSON(A8020_CALC_PATH, {}) || {};
  const impViva = a8020Calc.impFacturacion || {};
  const abcPorPlu = a8020Calc.abc || {};   // clase ABC por PLU (para presencia escalada por importancia)
  const ed = leerListasDistrib();
  const rubroRows = await query(`SELECT CAST(p.IdProducto AS VARCHAR) AS IdProducto
    FROM Productos p JOIN Rubros r ON r.IdRubro=p.IdRubro
    WHERE p.Activo=1 AND r.NombreRubro='Almacen'`);
  const basePlus = rubroRows.map(r => r.IdProducto);
  const plus = universoLista(basePlus, ed.siempreAlmacen, ed.noEnvasa);
  if (!plus.length) throw new Error('Sin productos activos de rubro "Almacen" en Siga.');
  const listas = { noEnvasa: ed.noEnvasa, restringidos: ed.restringidos, productosAlmacen: {}, importanciaMinorista: impViva };
  const inList = plus.map(p => `'${p}'`).join(',');   // IdProducto es varchar en Siga → citar
  const nuevoCfg = distCfg.nuevo || {};
  const nuevoDias = nuevoCfg.dias || 30;
  const pisoImportancia = nuevoCfg.pisoImportancia || 0.8;
  const compraTipos = (distCfg.tiposMovimientoCompra || ['COMPRA', 'COMPRA-NC']).map(t => `'${t}'`).join(',');
  const [stockRows, nombres, fact, primeraCompraRows] = await Promise.all([
    query(sqlStockDistribucion(plus)),
    query(`SELECT p.IdProducto, p.NombreProducto, r.NombreRubro FROM Productos p LEFT JOIN Rubros r ON r.IdRubro=p.IdRubro WHERE p.IdProducto IN (${inList})`),
    calcularFactLive(),
    query(`SELECT mp.IdProducto, MIN(m.FechaMovimiento) AS Primera
      FROM MovimientosStockProductos mp
      JOIN MovimientosStock m ON m.IdSucursal=mp.IdSucursal AND m.IdTipoMovimiento=mp.IdTipoMovimiento AND m.NumeroMovimiento=mp.NumeroMovimiento
      WHERE mp.IdProducto IN (${inList}) AND mp.IdTipoMovimiento IN (${compraTipos})
      GROUP BY mp.IdProducto`),
  ]);
  const primeraCompraMap = new Map(primeraCompraRows.map(r => [String(r.IdProducto), r.Primera]));
  const umbralNuevo = new Date(Date.now() - nuevoDias * 24 * 60 * 60 * 1000);
  const esNuevoSet = new Set([...primeraCompraMap.entries()]
    .filter(([, fecha]) => new Date(fecha) >= umbralNuevo)
    .map(([plu]) => plu));
  const nombreMap = new Map(nombres.map(r => [String(r.IdProducto), r.NombreProducto]));
  const rubroMapA = new Map(nombres.map(r => [String(r.IdProducto), r.NombreRubro || '']));
  const idCentralA = distCfg.idCentral || 1;   // sucursal central (SoyLaCentral=1), configurable
  const stocks = new Map();
  for (const r of stockRows) {
    const key = r.IdSucursal === idCentralA ? 'central' : DISTRIB_SUC_MAP[r.IdSucursal]; if (!key) continue;
    const plu = String(r.IdProducto);
    if (!stocks.has(plu)) stocks.set(plu, {});
    const s = stocks.get(plu); s[key] = (s[key] || 0) + parseFloat(r.Stock || 0);
  }
  const productos = plus.map(plu => ({ plu, stocks: stocks.get(plu) || {} }));
  // Fact en vivo por sucursal, ANTES del cálculo: el racionamiento tiene que excluir del
  // pool compartido a las sucursales que van a salir 'Fact' (no consumen stock real), si
  // no le comen cupo al resto (ver spec 2026-07-07... / fix PLU 2121).
  const ALM_FACT_KEY_INTERNO = { riv: 'riv', urq: 'urq', nacion: 'nacion', chaca: 'chaca', pergamino: 'pergamino', sanPedro: 'sanpedro', sucursal9: 'sucu9', sucursal11: 'sucu11' };
  const factGatePorPlu = new Map();
  for (const plu of plus) {
    const set = new Set();
    for (const [ek, fk] of Object.entries(ALM_FACT_KEY))
      if (fact.factByKey[fk] && fact.factByKey[fk].has(Number(plu))) set.add(ALM_FACT_KEY_INTERNO[ek]);
    if (set.size) factGatePorPlu.set(plu, set);
  }
  const filas = calcularAlmacen(productos, a8020, listas, { corregirBugs: true, empujePresencia, empujePresenciaFactorS, presenciaPorClase, abcPorPlu, importancia: importanciaCfg, umbralMicroEnvio, pesosRacionado: distCfg.pesosRacionado, esNuevoSet, factGatePorPlu });
  // Fact en vivo: lo ya facturado a la sucursal desde su última recepción no se reenvía (enviar→0).
  for (const f of filas) {
    f.factSucs = [];
    for (const [ek, fk] of Object.entries(ALM_FACT_KEY))
      if (fact.factByKey[fk] && fact.factByKey[fk].has(Number(f.plu))) { f.enviar[ek] = 'Fact'; f.factSucs.push(ek); }
  }
  const almOvr = (leerJSON(ENVIOS_MANUALES_PATH, {})).almacen || {};
  for (const f of filas) {
    const ovr = almOvr[String(f.plu)]; if (!ovr) continue;
    f.enviarOverride = {};
    for (const [suc, val] of Object.entries(ovr))
      if (f.enviar[suc] !== 'Fact') { f.enviar[suc] = val; f.enviarOverride[suc] = true; }
  }
  // Prioridad compuesta: facturación (impNorm ya normalizado) + urgencia de stock por
  // sucursal (cuán por debajo del mínimo) + cantidad total a enviar. Ver spec
  // 2026-07-07-prioridad-unificada-design.md.
  const SUC_KEYS_ALM = ['riv', 'urq', 'nacion', 'chaca', 'pergamino', 'sanpedro', 'sucu8', 'sucu9', 'sucu11'];
  let maxCantidad = 0;
  const cantidadPorPlu = new Map();
  for (const f of filas) {
    const total = Object.values(f.ideal || {}).reduce((s, v) => s + (v || 0), 0);
    cantidadPorPlu.set(f.plu, total);
    if (total > maxCantidad) maxCantidad = total;
  }
  for (const f of filas) {
    const rawStk = stocks.get(String(f.plu)) || {};
    const urgencias = SUC_KEYS_ALM.map(k => {
      const min = (f.mins || {})[k];
      if (!(min > 0)) return null;
      return Math.max(0, 1 - (rawStk[k] || 0) / min);
    }).filter(x => x != null);
    const urgenciaStock = urgencias.length ? urgencias.reduce((s, x) => s + x, 0) / urgencias.length : 0;
    const cantidadN = maxCantidad > 0 ? cantidadPorPlu.get(f.plu) / maxCantidad : 0;
    f.impNorm = 0.6 * f.impNorm + 0.25 * urgenciaStock + 0.15 * cantidadN;
  }
  return filas.map(f => {
    const rawStk = stocks.get(String(f.plu)) || {};
    const stkSuc = { riv: rawStk.riv||0, urq: rawStk.urq||0, nacion: rawStk.nacion||0,
      chaca: rawStk.chaca||0, pergamino: rawStk.pergamino||0,
      sanPedro: rawStk.sanpedro||0, sucursal9: rawStk.sucu9||0 };
    const mnA = f.mins || {}, slA = f.sLevels || {};
    const minSuc = { riv: mnA.riv||0, urq: mnA.urq||0, nacion: mnA.nacion||0, chaca: mnA.chaca||0,
      pergamino: mnA.pergamino||0, sanPedro: mnA.sanpedro||0, sucursal9: mnA.sucu9||0 };
    const sSuc = { riv: slA.riv||0, urq: slA.urq||0, nacion: slA.nacion||0, chaca: slA.chaca||0,
      pergamino: slA.pergamino||0, sanPedro: slA.sanpedro||0, sucursal9: slA.sucu9||0 };
    const esNuevo = esNuevoSet.has(String(f.plu));
    const impNorm = esNuevo ? (pisoImportancia + f.impNorm) : f.impNorm;
    const primera = primeraCompraMap.get(String(f.plu));
    return { plu: f.plu, nombre: nombreMap.get(String(f.plu)) || '', rubro: rubroMapA.get(String(f.plu)) || '', central: f.central,
      enviar: f.enviar, enviarOverride: f.enviarOverride || {}, enviarTexto: f.enviarTexto, enviarMicro: f.enviarMicro, ideal: f.ideal, factSucs: f.factSucs, pideTotal: f.pideTotal, importancia: f.importancia, impSuc: f.impSuc, impNorm, meses: f.meses, stkSuc, minSuc, sSuc,
      esNuevo, primeraCompra: primera ? new Date(primera).toISOString().slice(0, 10) : null };
  });
}
app.get('/distribucion', (_req, res) => res.sendFile(path.join(__dirname, 'distribucion.html')));
app.get('/docs/plan-distribucion.html', (_req, res) => res.sendFile(path.join(__dirname, 'docs', 'plan-distribucion.html')));
app.get('/docs/guia-distribucion.html', (_req, res) => res.sendFile(path.join(__dirname, 'docs', 'guia-distribucion.html')));
app.get('/docs/analisis-distribucion.html', (_req, res) => res.sendFile(path.join(__dirname, 'docs', 'analisis-distribucion.html')));
app.get('/api/distribucion/almacen', apiRoute(async () => calcularDistribucionAlmacen()));
app.get('/api/distribucion/sucursales', apiRoute(async () =>
  query('SELECT IdSucursal, Nombre, SoyLaCentral FROM Sucursales ORDER BY IdSucursal')));

// ── Distribución de pesables/granel (réplica hoja "Pesables") ───────────────────
// IdSucursal Siga → clave motor pesables. Logia(8) SÍ se reparte en pesables; Savio(6) no.
const PES_SUC_MAP = { 5:'riv', 2:'urq', 3:'nacion', 4:'chaca', 10:'pergamino', 7:'sanpedro', 8:'logia', 9:'ramallo', 11:'sucu11' };   // central resuelta por idCentral (config)
async function calcularDistribucionPesables(aplicarOcultar = true) {
  const a8020   = leerJSON(A8020_PATH, {});
  const pesLis  = leerJSON(PESABLES_LISTAS_PATH, {});
  const ed = leerListasDistrib();
  const impViva = (leerJSON(A8020_CALC_PATH, {}) || {}).impFacturacion || {};
  const formulas = pesLis.formulas || {};
  const ocultos = new Set(aplicarOcultar ? ed.ocultarPesable.map(String) : []);   // checkbox "Ocultar códigos" en Pesables
  const distLis = { noEnvasa: ed.noEnvasa, restringidos: ed.restringidos, importanciaMinorista: impViva };
  const rubroRows = await query(`SELECT CAST(p.IdProducto AS VARCHAR) AS IdProducto, r.NombreRubro
    FROM Productos p JOIN Rubros r ON r.IdRubro=p.IdRubro
    WHERE p.Activo=1 AND r.NombreRubro='Pesables Fraccionado'`);
  const rubroMapP = new Map(rubroRows.map(r => [r.IdProducto, r.NombreRubro]));
  const basePlus = rubroRows.map(r => r.IdProducto);
  const plus = universoLista(basePlus, ed.siemprePesable, ed.noEnvasa)
    .filter(p => !ocultos.has(String(p)));
  if (!plus.length) throw new Error('Sin productos activos de rubro "Pesables Fraccionado" en Siga.');
  const quote = arr => arr.map(p => `'${String(p).replace(/'/g, "''")}'`).join(',');
  // Códigos granel únicos (stock central de granel sale del depósito GRANEL, por código componente).
  const granelCodes = [...new Set(plus.map(p => (formulas[p] || {}).granel).filter(g => g != null).map(String))];
  const distCfgP = leerJSON(DISTRIB_CONFIG_PATH, {});
  const nuevoCfgP = distCfgP.nuevo || {};
  const nuevoDiasP = nuevoCfgP.dias || 30;
  const pisoImportanciaP = nuevoCfgP.pisoImportancia || 0.8;
  const compraTiposP = (distCfgP.tiposMovimientoCompra || ['COMPRA', 'COMPRA-NC']).map(t => `'${t}'`).join(',');
  const [stockRows, granelRows, nombres, fact, primeraCompraRows] = await Promise.all([
    query(sqlStockDistribucion(plus)),   // producto terminado: DisponibleVenta=1 por IdSucursal (central + sucursales)
    granelCodes.length ? query(`SELECT pd.IdProducto, COALESCE(SUM(pd.Stock),0) AS Stock
       FROM ProductosDepositos pd
       INNER JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal
       INNER JOIN Sucursales s ON s.IdSucursal=pd.IdSucursal
       WHERE s.SoyLaCentral=1 AND pd.IdProducto IN (${quote(granelCodes)})
       GROUP BY pd.IdProducto`) : Promise.resolve([]),
    query(`SELECT IdProducto, NombreProducto FROM Productos WHERE IdProducto IN (${quote([...new Set([...plus, ...granelCodes])])})`),
    calcularFactLive(),
    query(`SELECT mp.IdProducto, MIN(m.FechaMovimiento) AS Primera
      FROM MovimientosStockProductos mp
      JOIN MovimientosStock m ON m.IdSucursal=mp.IdSucursal AND m.IdTipoMovimiento=mp.IdTipoMovimiento AND m.NumeroMovimiento=mp.NumeroMovimiento
      WHERE mp.IdProducto IN (${quote(plus)}) AND mp.IdTipoMovimiento IN (${compraTiposP})
      GROUP BY mp.IdProducto`),
  ]);
  const primeraCompraMapP = new Map(primeraCompraRows.map(r => [String(r.IdProducto), r.Primera]));
  const umbralNuevoP = new Date(Date.now() - nuevoDiasP * 24 * 60 * 60 * 1000);
  const esNuevoSetP = new Set([...primeraCompraMapP.entries()]
    .filter(([, fecha]) => new Date(fecha) >= umbralNuevoP)
    .map(([plu]) => plu));
  const nombreMap = new Map(nombres.map(r => [String(r.IdProducto), r.NombreProducto]));
  const granelMap = new Map(granelRows.map(r => [String(r.IdProducto), parseFloat(r.Stock || 0)]));
  const idCentralP = distCfgP.idCentral || 1;   // sucursal central (SoyLaCentral=1), configurable
  const stocks = new Map();
  for (const r of stockRows) {
    const key = r.IdSucursal === idCentralP ? 'central' : PES_SUC_MAP[r.IdSucursal]; if (!key) continue;
    const plu = String(r.IdProducto);
    if (!stocks.has(plu)) stocks.set(plu, {});
    const s = stocks.get(plu); s[key] = (s[key] || 0) + parseFloat(r.Stock || 0);
  }
  const sinGranelSet = new Set(ed.siemprePesableSinGranel.map(String));
  const productos = plus.map(plu => {
    const st = stocks.get(plu) || {};
    const granel = (formulas[plu] || {}).granel;
    st.granel = (granel != null && !sinGranelSet.has(String(plu))) ? (granelMap.get(String(granel)) || 0) : 0;
    return { plu, stocks: st };
  });
  const pesParams = leerJSON(PESABLES_PARAMS_PATH, {});   // pesos de prioridad editables (opcional)
  const empPes = distCfgP.empujeDepositoPesables || {};
  const abcPorPluP = (leerJSON(A8020_CALC_PATH, {}) || {}).abc || {};   // clase ABC por PLU (presencia escalada)
  const presPorPlu = {};
  for (const plu of plus) presPorPlu[String(plu)] = pesoPresentacionKg(nombreMap.get(String(plu)) || '', (formulas[String(plu)] || {}).cantFormula);
  const filas = calcularPesables(productos, a8020, pesLis, distLis,
    { corregirBugs: true, prioPesos: pesParams.prioPesos, granelCap: pesParams.granelCap,
      empujePresencia: empPes.presencia, empujePresenciaFactorS: empPes.presenciaFactorS,
      presenciaPorClase: empPes.presenciaPorClase, presenciaPorPresentacion: empPes.presenciaPorPresentacion, abcPorPlu: abcPorPluP, presPorPlu });
  // Fact en vivo: lo ya facturado a la sucursal desde su última recepción no se reenvía.
  for (const f of filas) for (const [k, set] of Object.entries(fact.factByKey))
    if (f.enviar[k] !== undefined && set.has(Number(f.plu))) f.enviar[k] = 'Fact';
  const pesOvr = (leerJSON(ENVIOS_MANUALES_PATH, {})).pesable || {};
  for (const f of filas) {
    const ovr = pesOvr[String(f.plu)]; if (!ovr) continue;
    f.enviarOverride = {};
    for (const [suc, val] of Object.entries(ovr))
      if (f.enviar[suc] !== 'Fact') { f.enviar[suc] = val; f.enviarOverride[suc] = true; }
  }
  return filas.map(f => {
    const esNuevo = esNuevoSetP.has(String(f.plu));
    const primera = primeraCompraMapP.get(String(f.plu));
    const prioridad = esNuevo ? Math.max(f.prioridad, pisoImportanciaP) : f.prioridad;
    const prioridadSala = esNuevo ? Math.max(f.prioridadSala, pisoImportanciaP) : f.prioridadSala;
    return { plu: f.plu, nombre: nombreMap.get(String(f.plu)) || '', rubro: rubroMapP.get(String(f.plu)) || '',
      granel: f.granel, nombreGranel: f.granel != null ? (nombreMap.get(String(f.granel)) || '') : '',
      cantFormula: (formulas[String(f.plu)] || {}).cantFormula ?? 1,
      peso: f.peso, F: f.F, H: f.H, BG: f.BG, enviar: f.enviar, enviarOverride: f.enviarOverride || {}, ideal: f.teorico, CG: f.CG, mins: f.mins, sLev: f.sLev,
      J: f.J, D: f.D, G: f.G, BL: f.BL, prioridad, prioridadSala,
      granelRatio: f.granelRatio, stkSuc: stocks.get(String(f.plu)) || {},
      esNuevo, primeraCompra: primera ? new Date(primera).toISOString().slice(0, 10) : null };
  });
}
app.get('/api/distribucion/pesables', apiRoute(async (req) => calcularDistribucionPesables(req.query.ocultar !== '0')));
app.get('/api/distribucion/envios-manuales', apiRoute(async () => leerJSON(ENVIOS_MANUALES_PATH, { almacen: {}, pesable: {} })));
app.post('/api/distribucion/envio-override', (req, res) => {
  const { tipo, plu, suc, valor } = req.body || {};
  if (!tipo || !plu || !suc) return res.status(400).json({ error: 'faltan campos' });
  const d = leerJSON(ENVIOS_MANUALES_PATH, { almacen: {}, pesable: {} });
  if (!d[tipo]) d[tipo] = {};
  if (valor === null || valor === undefined) {
    if (d[tipo][String(plu)]) { delete d[tipo][String(plu)][suc]; if (!Object.keys(d[tipo][String(plu)]).length) delete d[tipo][String(plu)]; }
  } else {
    if (!d[tipo][String(plu)]) d[tipo][String(plu)] = {};
    d[tipo][String(plu)][suc] = Number(valor);
  }
  guardarJSON(ENVIOS_MANUALES_PATH, d);
  res.json({ ok: true });
});
app.delete('/api/distribucion/envios-manuales', (req, res) => {
  const { tipo } = req.body || {};
  const d = leerJSON(ENVIOS_MANUALES_PATH, { almacen: {}, pesable: {} });
  if (!tipo || tipo === 'todos') guardarJSON(ENVIOS_MANUALES_PATH, { almacen: {}, pesable: {} });
  else { d[tipo] = {}; guardarJSON(ENVIOS_MANUALES_PATH, d); }
  res.json({ ok: true });
});

// ── Módulo Compras ───────────────────────────────────────────────────────────
// Mapa IdProducto(String) -> { proveedor, precio, fecha, ultimaCantidad, ultimaFecha } desde SIGA.
async function _provMapCompras() {
  const distCfg = leerJSON(DISTRIB_CONFIG_PATH, {});
  const compraTipos = (distCfg.tiposMovimientoCompra || ['COMPRA', 'COMPRA-NC']).map(t => `'${t}'`).join(',');
  const [provRows, movRows] = await Promise.all([
    query(`SELECT pp.IdProducto, pv.NombreProveedor,
                  CAST(pp.UltimoPrecioCompra AS FLOAT) AS Precio,
                  CONVERT(varchar(10), pp.UltimaFechaCompra, 23) AS FechaPrecio
           FROM ProductosProveedores pp
           JOIN Proveedores pv ON pv.IdProveedor = pp.IdProveedor
           JOIN Productos p ON p.IdProducto = pp.IdProducto
           WHERE pp.UltimoPrecioCompra > 0 AND p.Activo = 1
           ORDER BY pp.IdProducto, pp.UltimaFechaCompra DESC`),
    query(`SELECT mp.IdProducto,
                  CONVERT(varchar(10), MAX(m.FechaMovimiento), 23) AS UltimaFecha,
                  SUM(mp.Cantidad) AS CantTotal, COUNT(*) AS N
           FROM MovimientosStockProductos mp
           JOIN MovimientosStock m ON m.IdSucursal=mp.IdSucursal AND m.IdTipoMovimiento=mp.IdTipoMovimiento AND m.NumeroMovimiento=mp.NumeroMovimiento
           WHERE mp.IdTipoMovimiento IN (${compraTipos})
           GROUP BY mp.IdProducto`).catch(() => []),
  ]);
  const map = new Map();
  for (const r of provRows) {
    const id = String(r.IdProducto);
    if (!map.has(id)) map.set(id, { proveedor: r.NombreProveedor, precio: r.Precio, fecha: r.FechaPrecio, ultimaCantidad: null, ultimaFecha: null });
  }
  for (const r of movRows) {
    const id = String(r.IdProducto);
    const cant = r.N > 0 ? Math.round((r.CantTotal || 0) / r.N) : null; // promedio por movimiento de compra
    if (!map.has(id)) map.set(id, { proveedor: null, precio: null, fecha: null, ultimaCantidad: cant, ultimaFecha: r.UltimaFecha });
    else { const m = map.get(id); m.ultimaCantidad = cant; m.ultimaFecha = r.UltimaFecha; }
  }
  return map;
}

// Unifica productos rubro Almacen (calcularDistribucionAlmacen) + Pesables Fraccionado (calcularDistribucionPesables),
// enriquece con proveedor/costo/última compra y calcula las 3 señales de compra.
async function calcularListadoCompras() {
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  const pisoCfg = c.comprasPisoCentral || { tramos: [{ hastaS: null, pct: 0.25 }], pisoAbsoluto: 0 };
  const [almacen, pesables, provMap] = await Promise.all([
    calcularDistribucionAlmacen(),
    calcularDistribucionPesables().catch(() => []),
    _provMapCompras(),
  ]);
  // Stock central del granel por código (para columna granel de fraccionables)
  const granelCodes = [...new Set(pesables.map(f => f.granel).filter(g => g != null).map(String))];
  const granelMap = new Map();
  if (granelCodes.length) {
    const q = granelCodes.map(g => `'${String(g).replace(/'/g, "''")}'`).join(',');
    const rows = await query(`SELECT pd.IdProducto, COALESCE(SUM(pd.Stock),0) AS Stock
      FROM ProductosDepositos pd
      INNER JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal
      INNER JOIN Sucursales s ON s.IdSucursal=pd.IdSucursal
      WHERE s.SoyLaCentral=1 AND pd.IdProducto IN (${q}) GROUP BY pd.IdProducto`).catch(() => []);
    for (const r of rows) granelMap.set(String(r.IdProducto), parseFloat(r.Stock || 0));
  }

  const filaComun = (plu, nombre, tipo, central, stkSuc, pideTotal, enviarMicro, extra) => {
    const prov = provMap.get(String(plu)) || {};
    const sig = comprasModulo.sugeridoCompra({ pideTotal, central, enviarMicro, tramos: pisoCfg.tramos, pisoAbsoluto: pisoCfg.pisoAbsoluto });
    const consolidado = (central || 0) + Object.values(stkSuc || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    return {
      plu: String(plu), nombre, tipo, // 'almacen' | 'fraccionable'
      central: central || 0, stkSuc: stkSuc || {}, consolidado,
      deficitReposicion: sig.deficitReposicion, deficitMicro: sig.deficitMicro, faltanteReal: sig.faltanteReal, sugerido: sig.sugerido,
      proveedor: prov.proveedor || null, costo: prov.precio || null,
      ultimaCompraFecha: prov.ultimaFecha || prov.fecha || null, ultimaCompraCantidad: prov.ultimaCantidad || null,
      ...extra,
    };
  };

  const rows = [];
  for (const f of almacen) {
    const pideTotal = Object.values(f.ideal || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    rows.push(filaComun(f.plu, f.nombre, 'almacen', f.central, f.stkSuc, pideTotal, f.enviarMicro, {
      granelCentral: null, granelPlu: null, nombreGranel: '', fraccionado: null,
    }));
  }
  for (const f of pesables) {
    const pideTotal = Object.values(f.ideal || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    const fraccionado = Object.values(f.stkSuc || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    const granelCentral = f.granel != null ? (granelMap.get(String(f.granel)) || 0) : null;
    // Pesables no expone central del terminado como Almacén; se usa 0 (el stock relevante es granel + sucursales).
    rows.push(filaComun(f.plu, f.nombre, 'fraccionable', 0, f.stkSuc, pideTotal, {}, {
      granelCentral, granelPlu: f.granel || null, nombreGranel: f.nombreGranel || '', fraccionado,
    }));
  }
  rows.sort((a, b) => b.sugerido - a.sugerido);
  return { productos: rows, fechaCalculo: new Date().toISOString(), total: rows.length };
}
app.get('/api/compras-modulo/listado', apiRoute(async () => calcularListadoCompras()));

// Busca proveedores por nombre parcial y devuelve los productos que maneja con último precio/fecha.
app.get('/api/compras-modulo/proveedores/buscar', apiRoute(async (req) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return { proveedores: [] };
  const like = q.replace(/'/g, "''");
  const rows = await query(`SELECT pv.NombreProveedor, pp.IdProducto, p.NombreProducto,
      CAST(pp.UltimoPrecioCompra AS FLOAT) AS Precio,
      CONVERT(varchar(10), pp.UltimaFechaCompra, 23) AS Fecha
    FROM ProductosProveedores pp
    JOIN Proveedores pv ON pv.IdProveedor = pp.IdProveedor
    JOIN Productos p ON p.IdProducto = pp.IdProducto
    WHERE pv.NombreProveedor LIKE '%${like}%' AND p.Activo = 1 AND pp.UltimoPrecioCompra > 0
    ORDER BY pv.NombreProveedor, p.NombreProducto`);
  const porProv = new Map();
  for (const r of rows) {
    const nom = r.NombreProveedor;
    if (!porProv.has(nom)) porProv.set(nom, { proveedor: nom, productos: [] });
    porProv.get(nom).productos.push({ plu: String(r.IdProducto), nombre: r.NombreProducto, precio: r.Precio, fecha: r.Fecha });
  }
  return { proveedores: [...porProv.values()].map(p => ({ ...p, cantProductos: p.productos.length })) };
}));

// Recibe { items:[{plu,cantidad,proveedor,costoUnit}] } y devuelve cobertura agrupada por proveedor.
app.post('/api/compras-modulo/carrito/cobertura', (req, res) => {
  const items = (req.body && req.body.items) || [];
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items debe ser array' });
  res.json({ cobertura: comprasModulo.coberturaPorProveedor(items) });
});

// Presentaciones de compra: { [plu]: { unidadesPorBulto:Number, nombreBulto?:String } }
app.get('/api/compras-modulo/presentaciones', apiRoute(async () => leerJSON(PRESENTACIONES_COMPRA_PATH, {})));
app.post('/api/compras-modulo/presentaciones', (req, res) => {
  const b = req.body || {};
  const plu = String(b.plu || '').trim();
  const uxb = Number(b.unidadesPorBulto);
  if (!plu || !(uxb > 0)) return res.status(400).json({ error: 'plu y unidadesPorBulto (>0) requeridos' });
  const d = leerJSON(PRESENTACIONES_COMPRA_PATH, {});
  d[plu] = { unidadesPorBulto: uxb, nombreBulto: (b.nombreBulto || '').trim() || undefined };
  guardarJSON(PRESENTACIONES_COMPRA_PATH, d);
  res.json({ ok: true, presentaciones: d });
});
app.delete('/api/compras-modulo/presentaciones/:plu', (req, res) => {
  const d = leerJSON(PRESENTACIONES_COMPRA_PATH, {});
  delete d[String(req.params.plu)];
  guardarJSON(PRESENTACIONES_COMPRA_PATH, d);
  res.json({ ok: true, presentaciones: d });
});

// Componentes de producción (formulas.json) con déficit de stock central.
async function calcularProduccionDeficit() {
  const formulas = leerJSON(path.join(DATA_DIR, 'formulas.json'), {});
  const consumoPorComp = new Map();   // plu -> { plu, nombre, consumo, usadoPor:Set }
  for (const [padre, comps] of Object.entries(formulas)) {
    for (const c of (comps || [])) {
      const plu = String(c.plu);
      if (!consumoPorComp.has(plu)) consumoPorComp.set(plu, { plu, nombre: c.nombre || plu, consumo: 0, usadoPor: new Set() });
      const rec = consumoPorComp.get(plu);
      rec.consumo += Number(c.cantPorUnidad) || 0;   // proxy: suma de coeficientes (consumo por unidad producida)
      rec.usadoPor.add(String(padre));
    }
  }
  const plus = [...consumoPorComp.keys()];
  if (!plus.length) return { componentes: [], total: 0 };
  const q = plus.map(p => `'${String(p).replace(/'/g, "''")}'`).join(',');
  const stockRows = await query(`SELECT pd.IdProducto, COALESCE(SUM(pd.Stock),0) AS Stock
    FROM ProductosDepositos pd
    INNER JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal
    INNER JOIN Sucursales s ON s.IdSucursal=pd.IdSucursal
    WHERE s.SoyLaCentral=1 AND pd.IdProducto IN (${q}) GROUP BY pd.IdProducto`).catch(() => []);
  const stockMap = new Map(stockRows.map(r => [String(r.IdProducto), parseFloat(r.Stock || 0)]));
  const provMap = await _provMapCompras();
  const comps = plus.map(plu => {
    const rec = consumoPorComp.get(plu);
    const stock = stockMap.get(plu) || 0;
    const deficit = Math.max(rec.consumo - stock, 0);
    const prov = provMap.get(plu) || {};
    return { plu, nombre: rec.nombre, stock, consumoProyectado: Math.round(rec.consumo * 100) / 100,
      deficit: Math.round(deficit * 100) / 100, usadoPor: [...rec.usadoPor],
      proveedor: prov.proveedor || null, costo: prov.precio || null };
  }).filter(x => x.deficit > 0)
    .sort((a, b) => b.deficit - a.deficit);
  return { componentes: comps, total: comps.length };
}
app.get('/api/compras-modulo/produccion-deficit', apiRoute(async () => calcularProduccionDeficit()));

app.get('/api/compras-modulo/ordenes', apiRoute(async () => leerJSON(ORDENES_COMPRA_PATH, [])));
app.post('/api/compras-modulo/ordenes', (req, res) => {
  const b = req.body || {};
  try {
    const orden = comprasModulo.construirOrden({
      id: Date.now(),
      fechaISO: new Date().toISOString().slice(0, 10),
      proveedor: b.proveedor,
      items: b.items,
    });
    const arr = leerJSON(ORDENES_COMPRA_PATH, []);
    arr.push(orden);
    guardarJSON(ORDENES_COMPRA_PATH, arr);
    res.json({ ok: true, orden });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── A8020 autónomo: puntos de pedido order-up-to calculados desde Siga ──────────
// Spec: docs/superpowers/specs/2026-06-10-a8020-orderupto-design.md
const DISTRIB_CONFIG_PATH = path.join(DATA_DIR, 'distribucion_config.json');
const DISTRIB_OVERRIDES_PATH = path.join(DATA_DIR, 'distribucion_overrides.json');
const A8020_CALC_PATH = path.join(DATA_DIR, 'a8020_calc.json');
// Filtros comunes: venta al cliente final por sucursal (excluye ANULADO y comprobantes a clientes categoría SUCURSAL).
function _ventasWhere(idList, meses) {
  return `v.Fecha >= DATEADD(MONTH,-${meses},CAST(GETDATE() AS DATE)) AND v.Fecha < CAST(GETDATE() AS DATE)
    AND ISNULL(v.IdEstadoComprobante,'') != 'ANULADO' AND v.IdSucursal IN (${idList})
    AND UPPER(ISNULL(cat.NombreCategoria,'')) != 'SUCURSAL'`;
}
const _ventasJoin = `INNER JOIN Ventas v ON v.IdSucursal=vp.IdSucursal AND v.IdTipoComprobante=vp.IdTipoComprobante
    AND v.Letra=vp.Letra AND v.CentroEmisor=vp.CentroEmisor AND v.NumeroComprobante=vp.NumeroComprobante
  LEFT JOIN Clientes c ON c.IdCliente=v.IdCliente LEFT JOIN Categorias cat ON cat.IdCategoria=c.IdCategoria`;
function sqlVentasStats(idList, meses) {   // μ,σ: agrega a día, luego Σq y Σq² por (sucursal, producto)
  return `;WITH vd AS (
    SELECT v.IdSucursal, vp.IdProducto, CAST(v.Fecha AS DATE) AS Dia, SUM(vp.Cantidad) AS QDia
    FROM VentasProductos vp ${_ventasJoin}
    WHERE ${_ventasWhere(idList, meses)}
    GROUP BY v.IdSucursal, vp.IdProducto, CAST(v.Fecha AS DATE))
  SELECT IdSucursal, IdProducto, COUNT(*) AS DiasConVenta, MIN(Dia) AS PrimeraVenta, SUM(QDia) AS SumQ, SUM(QDia*QDia) AS SumQ2
  FROM vd GROUP BY IdSucursal, IdProducto`;
}
function sqlDiasOperativos(idList, meses) {   // días con algún comprobante por sucursal (denominador N)
  return `SELECT v.IdSucursal, COUNT(DISTINCT CAST(v.Fecha AS DATE)) AS DiasOperativos
  FROM Ventas v
  LEFT JOIN Clientes c ON c.IdCliente=v.IdCliente LEFT JOIN Categorias cat ON cat.IdCategoria=c.IdCategoria
  WHERE ${_ventasWhere(idList, meses)}
  GROUP BY v.IdSucursal`;
}
function sqlAbcMetric(idList, meses, metrica) {   // métrica ABC por PLU (facturación o unidades)
  const col = metrica === 'unidades' ? 'vp.Cantidad' : 'vp.ImporteTotalNeto';
  return `SELECT vp.IdProducto, SUM(${col}) AS Metric
  FROM VentasProductos vp ${_ventasJoin}
  WHERE ${_ventasWhere(idList, meses)}
  GROUP BY vp.IdProducto`;
}
function sqlAbcMetricPorSucursal(idList, meses, metrica) {   // métrica ABC por (sucursal, PLU) — ranking local
  const col = metrica === 'unidades' ? 'vp.Cantidad' : 'vp.ImporteTotalNeto';
  return `SELECT vp.IdSucursal, vp.IdProducto, SUM(${col}) AS Metric
  FROM VentasProductos vp ${_ventasJoin}
  WHERE ${_ventasWhere(idList, meses)}
  GROUP BY vp.IdSucursal, vp.IdProducto`;
}
async function recalcularA8020() {
  const config = leerJSON(DISTRIB_CONFIG_PATH, {});
  const pesLis = leerJSON(PESABLES_LISTAS_PATH, {});
  const overrides = leerJSON(DISTRIB_OVERRIDES_PATH, {});
  const sucs = config.sucursales || {};
  const idList = Object.values(sucs).map(s => s.idSucursal).join(',');
  if (!idList) throw new Error('Falta data/distribucion_config.json (sucursales).');
  const meses = config.ventanaMeses || 12;
  const metrica = (config.abc || {}).metrica || 'facturacion';
  const [stats, ops, abcRows, abcRowsPorSuc] = await Promise.all([
    query(sqlVentasStats(idList, meses)),
    query(sqlDiasOperativos(idList, meses)),
    query(sqlAbcMetric(idList, meses, metrica)),
    query(sqlAbcMetricPorSucursal(idList, meses, metrica)),
  ]);
  const opsDays = {}; for (const r of ops) opsDays[r.IdSucursal] = Number(r.DiasOperativos) || 0;
  const metricByPlu = {}; for (const r of abcRows) metricByPlu[String(r.IdProducto)] = Number(r.Metric) || 0;
  const metricPorSuc = {};
  for (const r of abcRowsPorSuc) {
    (metricPorSuc[r.IdSucursal] = metricPorSuc[r.IdSucursal] || {})[String(r.IdProducto)] = Number(r.Metric) || 0;
  }
  const sucById = {};
  for (const [key, c] of Object.entries(sucs)) sucById[c.idSucursal] = key;
  // Denominador 'desde_alta': días operativos de la sucursal escalados a la fracción de ventana en que el
  // producto ya existía (desde su 1ª venta). Maduros → fracción≈1 → ≈ operativos; nuevos → dividido por su vida real.
  const denomMode = (config.demanda || {}).denominador || 'operativos';
  const MS_DIA = 86400000;
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const winStart = new Date(hoy); winStart.setMonth(winStart.getMonth() - meses);
  const winDias = Math.max(1, Math.round((hoy - winStart) / MS_DIA));
  const statRows = stats.map(r => {
    const dcv = Number(r.DiasConVenta) || 0;
    const row = { idSucursal: r.IdSucursal, plu: r.IdProducto,
      sumQ: Number(r.SumQ) || 0, sumQ2: Number(r.SumQ2) || 0, dcv,
      opsEff: opsDays[r.IdSucursal] || 0 };
    if (denomMode === 'desde_alta' && r.PrimeraVenta) {
      const pv = new Date(r.PrimeraVenta); pv.setHours(0, 0, 0, 0);
      const ini = pv < winStart ? winStart : pv;
      const frac = Math.min(1, Math.max(1, Math.round((hoy - ini) / MS_DIA)) / winDias);
      // opsEff nunca por debajo de dcv: los días-con-venta son subconjunto de los operativos. En sucursales
      // nuevas (opsDays chico) la fracción-calendario subestima y dispara μ→∞, σ→0; el piso en dcv lo corrige.
      row.opsEff = Math.max(dcv, 1, Math.round((opsDays[r.IdSucursal] || 0) * frac));
    }
    return row;
  });
  const dcvMap = {};
  for (const r of stats) {
    if (!dcvMap[r.IdSucursal]) dcvMap[r.IdSucursal] = {};
    dcvMap[r.IdSucursal][r.IdProducto] = Number(r.DiasConVenta) || 0;
  }
  const edAlm = leerListasDistrib();
  // Universo bootstrap = TODOS los productos activos de Siga (cualquier rubro), en vivo.
  // Antes se derivaba de archivos estáticos (distribucion_listas/pesables_listas): productos nuevos o
  // sin ventas en la ventana quedaban invisibles en a8020 aunque distribución sí los mostrara (p.ej. PLU 5738,
  // rubro Almacen sin ventas + ausente del snapshot viejo → no aparecía ni recalculando).
  const activosRows = await query(`SELECT CAST(p.IdProducto AS VARCHAR) AS IdProducto, r.NombreRubro
    FROM Productos p LEFT JOIN Rubros r ON r.IdRubro=p.IdRubro
    WHERE p.Activo=1`);
  const rubroActivo = {};   // plu → rubro Siga (semilla de rubroDePlu; evita re-consultar todo el universo)
  for (const r of activosRows) rubroActivo[String(r.IdProducto)] = r.NombreRubro || null;
  // Pesables (para decimales fraccionarios en min/S): rubro 'Pesables Fraccionado' en vivo + lista manual siemprePesable.
  const pesablesSet = new Set([
    ...activosRows.filter(r => r.NombreRubro === 'Pesables Fraccionado').map(r => Number(r.IdProducto)),
    ...(edAlm.siemprePesable || []).map(Number),
  ]);
  const bootstrapSet = new Set(activosRows.map(r => Number(r.IdProducto)));
  const { abc, filas } = computeA8020(statRows, opsDays, metricByPlu, config, pesablesSet, overrides);
  const ranking = calcularRankingPorSucursal(metricPorSuc, sucById);
  const rankingGeneral = calcularRankingGlobal(metricByPlu);   // importancia general del producto (0-1, todo el catálogo, sin distinguir sucursal)

  // Índice de crudos por (idSucursal, plu) para exponer volumen/denominador en el detalle (diagnóstico).
  const statIdx = {};
  for (const r of statRows) (statIdx[r.idSucursal] = statIdx[r.idSucursal] || {})[r.plu] = r;
  const mins = {}, sLevels = {}, detalle = {};
  for (const f of filas) {
    (mins[f.plu] = mins[f.plu] || {})[f.sucursal] = f.min;
    (sLevels[f.plu] = sLevels[f.plu] || {})[f.sucursal] = f.S;
    const rk = (ranking[f.sucursal] || {})[String(f.plu)];
    const sr = (statIdx[f.idSucursal] || {})[f.plu];
    (detalle[f.plu] = detalle[f.plu] || {})[f.sucursal] =
      { mu: Math.round(f.mu * 1000) / 1000, sigma: Math.round(f.sigma * 1000) / 1000, S: f.S, min: f.min,
        ...(rk != null ? { ranking: rk } : {}),
        ...(sr ? { sumQ: sr.sumQ, dcv: sr.dcv, opsEff: sr.opsEff } : {}),
        ...(f.propBase ? { propBase: f.propBase, propSoloBase: !!f.propSoloBase } : {}) };
  }
  // ── Bootstrap: PLUs pesables sin historial → interpola μ/σ por rubro ─────────
  const prodPesInfo = pesLis.productosPesables || {};
  // Rubro por producto (desde Siga) → habilita el promedio-por-rubro también en ALMACÉN, no sólo pesables.
  const rubroDePlu = { ...rubroActivo };   // ya trae el rubro de TODO el universo activo (una sola query arriba)
  // Sólo falta el rubro de PLUs con ventas pero inactivos (no vienen en activosRows): consulta acotada.
  const plusRubroFaltante = [...new Set(filas.map(f => String(f.plu)))].filter(p => !(p in rubroDePlu));
  if (plusRubroFaltante.length) {
    const inL = plusRubroFaltante.map(p => `'${p}'`).join(',');
    const rr = await query(`SELECT p.IdProducto, r.NombreRubro FROM Productos p LEFT JOIN Rubros r ON r.IdRubro=p.IdRubro WHERE p.IdProducto IN (${inL})`);
    for (const x of rr) rubroDePlu[String(x.IdProducto)] = x.NombreRubro || null;
  }
  const rubroOf = (plu) => rubroDePlu[String(plu)] || (prodPesInfo[String(plu)] || {}).rubro || null;
  // Índice rubro → sucKey → {sumMu, sumSigma, n} a partir de filas ya calculadas
  const rubroIdx = {};
  for (const f of filas) {
    const rubro = rubroOf(f.plu);
    if (!rubro) continue;
    if (!rubroIdx[rubro]) rubroIdx[rubro] = {};
    const rs = rubroIdx[rubro][f.sucursal] = rubroIdx[rubro][f.sucursal] || { sumMu: 0, sumSigma: 0, n: 0 };
    rs.sumMu += f.mu; rs.sumSigma += f.sigma; rs.n++;
  }
  // Índice sucursal → plu → {mu, sigma} para baseSucursal
  const filaSucPlu = {};
  for (const f of filas) {
    if (!filaSucPlu[f.sucursal]) filaSucPlu[f.sucursal] = {};
    filaSucPlu[f.sucursal][f.plu] = { mu: f.mu, sigma: f.sigma };
  }
  const bootstrapped = new Set();
  const sucConf = config.sucursales || {};
  const zConf = config.servicio || { A: 2.05, B: 1.645, C: 1.28 };
  const techoDefault = config.techoDefault || 10000;
  const kFrac = config.minFraccion || { A: 0.7, B: 0.5, C: 0.35 };
  // Calcula ambos niveles {min, S}. S = order-up-to; min = S·k[clase] (gatillo). min ≤ S.
  const levelsOf = (sc, mu, sigma, cls, plu) => {
    const TL = (sc.T || 0) + (sc.L || 0);
    const zc = zConf[cls || 'C'] ?? zConf.C;
    const o = overrides[String(plu)] || {};
    const mult = o.mult ?? 1, piso = o.pisoManual ?? 0, techo = o.techo ?? techoDefault;
    const dec = pesablesSet.has(Number(plu)) ? 1 : 0;
    const k = kFrac[cls || 'C'] ?? kFrac.C ?? 0.35;
    let S = TL <= 0 ? 0 : roundDec(Math.min(Math.max((mu * TL + zc * sigma * Math.sqrt(TL)) * mult, 0), techo), dec);
    let min = S <= 0 ? 0 : roundDec(Math.min(Math.max(S * k, piso), S), dec);
    return { S, min };
  };
  // ── Nivelación: sucursales con pocos días-con-venta → mezcla con base sucursal o promedio rubro ──
  const nivelCfg = config.nivelacion || {};
  const nivelMinDias = nivelCfg.minDiasConVenta || 0;
  const nivelSucs = nivelCfg.sucursales ? new Set(nivelCfg.sucursales) : new Set(Object.keys(sucConf));
  const baseSucursal = nivelCfg.baseSucursal || {};
  if (nivelMinDias > 0 || Object.keys(baseSucursal).length > 0) {
    for (const f of filas) {
      if (!nivelSucs.has(f.sucursal)) continue;
      const baseKey = baseSucursal[f.sucursal];
      const dcv = (dcvMap[f.idSucursal] || {})[f.plu] || 0;
      if (!baseKey && dcv >= nivelMinDias) continue;
      const w = baseKey ? 1 : (1 - dcv / nivelMinDias);
      let mu_base, sig_base, baseLabel;
      if (baseKey && filaSucPlu[baseKey] && filaSucPlu[baseKey][f.plu]) {
        const bf = filaSucPlu[baseKey][f.plu];
        mu_base = bf.mu; sig_base = bf.sigma; baseLabel = baseKey;
      } else {
        const rubro = rubroOf(f.plu);
        const rs = rubro && rubroIdx[rubro] && rubroIdx[rubro][f.sucursal];
        if (!rs || rs.n === 0) continue;
        mu_base = rs.sumMu / rs.n; sig_base = rs.sumSigma / rs.n; baseLabel = 'rubro';
      }
      const mu_new = (1 - w) * f.mu + w * mu_base;
      const sig_new = (1 - w) * f.sigma + w * sig_base;
      const sc = sucConf[f.sucursal] || {};
      const TL = (sc.T || 0) + (sc.L || 0);
      if (TL <= 0) continue;
      const { S: S_new, min: min_new } = levelsOf(sc, mu_new, sig_new, abc[String(f.plu)], f.plu);
      f.mu = mu_new; f.sigma = sig_new; f.S = S_new; f.min = min_new;
      mins[f.plu][f.sucursal] = min_new;
      sLevels[f.plu][f.sucursal] = S_new;
      detalle[f.plu][f.sucursal] = { mu: roundDec(mu_new, 3), sigma: roundDec(sig_new, 3), S: S_new, min: min_new, nivelado: true, dcv, w: roundDec(w, 2), base: baseLabel };
    }
  }
  for (const plu of bootstrapSet) {
    const rubro = rubroOf(plu);
    if (!rubro || !rubroIdx[rubro]) continue;
    const rubroSucs = rubroIdx[rubro];
    const yaTenia = !!mins[String(plu)];   // tenía datos reales/nivelados en alguna sucursal
    let anyS = false;
    for (const [sucKey, sucCfg] of Object.entries(sucConf)) {
      if ((mins[String(plu)] || {})[sucKey] != null) continue;   // esta sucursal ya tiene (real o nivelado) → no pisar
      const baseK = baseSucursal[sucKey];
      const rs = (baseK && rubroSucs[baseK]) ? rubroSucs[baseK] : rubroSucs[sucKey];
      if (!rs || rs.n === 0) continue;
      const mu = rs.sumMu / rs.n;
      const sigma = rs.sumSigma / rs.n;
      const TL = (sucCfg.T || 0) + (sucCfg.L || 0);
      if (TL <= 0) continue;
      const { S, min } = levelsOf(sucCfg, mu, sigma, 'C', plu);
      (mins[String(plu)] = mins[String(plu)] || {})[sucKey] = min;
      (sLevels[String(plu)] = sLevels[String(plu)] || {})[sucKey] = S;
      (detalle[String(plu)] = detalle[String(plu)] || {})[sucKey] =
        { mu: Math.round(mu * 1000) / 1000, sigma: Math.round(sigma * 1000) / 1000, S, min, bootstrap: true, base: baseK || 'rubro' };
      anyS = true;
    }
    // Sin datos previos → producto nuevo: clase C + marca bootstrap. Con datos previos (relleno parcial)
    // conserva su clasificación; las sucursales rellenadas quedan marcadas bootstrap en detalle.
    if (anyS && !yaTenia) { abc[String(plu)] = 'C'; bootstrapped.add(String(plu)); }
  }
  // Fill-in: PLUs con datos en otras suc pero sin S en sucursales con baseSucursal
  for (const [sucKey, baseKey] of Object.entries(baseSucursal)) {
    const sc = sucConf[sucKey]; if (!sc) continue;
    const TL = (sc.T || 0) + (sc.L || 0); if (TL <= 0) continue;
    for (const [plu, sucs] of Object.entries(mins)) {
      if (sucs[sucKey] != null) continue;
      const bf = (filaSucPlu[baseKey] || {})[Number(plu)];
      if (!bf) continue;
      const { mu, sigma } = bf;
      const { S, min } = levelsOf(sc, mu, sigma, abc[plu], plu);
      sucs[sucKey] = min;
      (sLevels[plu] = sLevels[plu] || {})[sucKey] = S;
      (detalle[plu] = detalle[plu] || {})[sucKey] = { mu: roundDec(mu, 3), sigma: roundDec(sigma, 3), S, min, fillIn: true, base: baseKey };
    }
  }

  // ── Clasificación por historial de movimientos (productos SIN ventas): Nuevo vs F ──
  //   Nuevo  → sin movimientos, sólo compras, o primer movimiento reciente (< umbral meses) → badge "Nuevo".
  //   F      → tiene movimientos no-compra repartidos por ≥ umbral meses y cero ventas → stock muerto (min/S=0, sin empuje).
  const salesSet = new Set(statRows.map(r => String(r.plu)));
  const compraTipos = config.tiposMovimientoCompra || ['COMPRA', 'COMPRA-NC'];
  const umbralNuevo = config.antiguedadMesesNuevo ?? 3;
  const candNoVenta = [...bootstrapSet].map(String).filter(p => !salesSet.has(p));
  // F = existe un movimiento NO-compra anterior al umbral (actividad vieja sin ventas). Resto = Nuevo.
  // Existence check con filtro de fecha+tipo: mucho más liviano que agregar MIN sobre toda la tabla.
  const esViejo = new Set();
  if (candNoVenta.length) {
    const compraIn = compraTipos.map(t => `'${t}'`).join(',') || `''`;
    const CH = 1000;
    for (let i = 0; i < candNoVenta.length; i += CH) {
      const chunk = candNoVenta.slice(i, i + CH).map(p => `'${p}'`).join(',');
      // MovimientosStockProductos: detalle con IdProducto; la fecha vive en el header MovimientosStock.
      const rows = await query(`SELECT DISTINCT mp.IdProducto
        FROM MovimientosStockProductos mp
        INNER JOIN MovimientosStock m ON m.IdSucursal=mp.IdSucursal AND m.IdTipoMovimiento=mp.IdTipoMovimiento AND m.NumeroMovimiento=mp.NumeroMovimiento
        WHERE mp.IdProducto IN (${chunk})
          AND mp.IdTipoMovimiento NOT IN (${compraIn})
          AND m.FechaMovimiento < DATEADD(MONTH, -${umbralNuevo}, CAST(GETDATE() AS DATE))`);
      for (const r of rows) esViejo.add(String(r.IdProducto));
    }
  }
  const nuevos = [], viejos = [], claseF = new Set();
  for (const plu of candNoVenta) {
    if (esViejo.has(plu)) {
      claseF.add(plu); viejos.push(Number(plu)); abc[plu] = 'F';
      if (mins[plu]) for (const sk of Object.keys(mins[plu])) mins[plu][sk] = 0;
      if (sLevels[plu]) for (const sk of Object.keys(sLevels[plu])) sLevels[plu][sk] = 0;
      if (detalle[plu]) for (const sk of Object.keys(detalle[plu])) { detalle[plu][sk].S = 0; detalle[plu][sk].min = 0; detalle[plu][sk].viejo = true; }
      bootstrapped.delete(plu);
    } else {
      nuevos.push(Number(plu));
      if (detalle[plu]) for (const sk of Object.keys(detalle[plu])) detalle[plu][sk].nuevo = true;
    }
  }

  const plus = [...new Set([...Object.keys(mins)])];
  const nombres = {};
  if (plus.length) {
    const inList = plus.map(p => `'${p}'`).join(',');
    const rows = await query(`SELECT IdProducto, NombreProducto FROM Productos WHERE IdProducto IN (${inList})`);
    for (const r of rows) nombres[String(r.IdProducto)] = r.NombreProducto;
  }
  // Ranking por sucursal: mergear al final. Nivelación/bootstrap/fillIn (arriba) reconstruyen
  // detalle[plu][sucursal] desde cero y pisan el merge inicial hecho junto con `filas` — sin este
  // segundo pase, cualquier PLU nivelado/bootstrapped pierde su ranking en la UI aunque exista.
  for (const [sucKey, porPlu] of Object.entries(ranking)) {
    for (const [plu, score] of Object.entries(porPlu)) {
      if (detalle[plu] && detalle[plu][sucKey]) detalle[plu][sucKey].ranking = score;
    }
  }
  const cache = { timestamp: new Date().toISOString(), ventanaMeses: meses,
    metricaABC: (config.abc || {}).metrica || 'facturacion', opsDays, abc, mins, sLevels, detalle, nombres,
    bootstrapped: [...bootstrapped], nuevos, viejos, rubros: rubroDePlu, impFacturacion: metricByPlu,
    rankingGeneral };
  guardarJSON(A8020_CALC_PATH, cache);
  // Escribir a8020.json en formato legacy para pesables.js y almacen.js.
  //   minX = punto de pedido (gatillo) · SX = order-up-to (objetivo al que se repone).
  const LEGACY_KEY = { riv:'minRiv', urq:'minUrq', nacion:'minNacion', chaca:'minChaca',
    pergamino:'minPergamino', sanpedro:'minSanPedro', logia:'minLogia',
    ramallo:'minVRamallo', sucu11:'minVConst' };
  const LEGACY_KEY_S = { riv:'SRiv', urq:'SUrq', nacion:'SNacion', chaca:'SChaca',
    pergamino:'SPergamino', sanpedro:'SSanPedro', logia:'SLogia',
    ramallo:'SVRamallo', sucu11:'SVConst' };
  const a8020Legacy = {};
  for (const [plu, sucData] of Object.entries(mins)) {
    a8020Legacy[plu] = {};
    for (const [sucKey, m] of Object.entries(sucData)) {
      const lk = LEGACY_KEY[sucKey]; if (lk) a8020Legacy[plu][lk] = m;
      const sk = LEGACY_KEY_S[sucKey]; const sv = (sLevels[plu] || {})[sucKey];
      if (sk && sv != null) a8020Legacy[plu][sk] = sv;
    }
  }
  for (const plu of claseF) { (a8020Legacy[plu] = a8020Legacy[plu] || {}).claseF = true; }
  // Ranking por sucursal (percentil 0-1 de importancia del PLU dentro de esa sucursal) → distribucion.js
  // lo usa para ponderar la importancia del envío por sucursal en vez del BB global plano.
  const LEGACY_KEY_RANK = { riv:'rankRiv', urq:'rankUrq', nacion:'rankNacion', chaca:'rankChaca',
    pergamino:'rankPergamino', sanpedro:'rankSanPedro', ramallo:'rankVRamallo' };
  for (const [sucKey, porPlu] of Object.entries(ranking)) {
    const rk = LEGACY_KEY_RANK[sucKey]; if (!rk) continue;
    for (const [plu, score] of Object.entries(porPlu)) {
      (a8020Legacy[plu] = a8020Legacy[plu] || {})[rk] = score;
    }
  }
  // Ranking general (mismo 0-1, todo el catálogo) → fallback en distribucion.js cuando el PLU no tiene
  // rank en NINGUNA sucursal. Reemplaza el fallback a BB crudo (facturación en miles/millones) que
  // mezclaba escalas con los rankXxx (0-1) y disparaba la importancia de esos PLUs muy por encima del resto.
  for (const [plu, score] of Object.entries(rankingGeneral)) {
    (a8020Legacy[plu] = a8020Legacy[plu] || {}).rankGeneral = score;
  }
  guardarJSON(A8020_PATH, a8020Legacy);

  // Resumen para la respuesta (no vuelca todo)
  const distAbc = { A: 0, B: 0, C: 0 };
  for (const v of Object.values(abc)) distAbc[v] = (distAbc[v] || 0) + 1;
  const conS = filas.filter(f => f.S > 0).length;
  const ejemplos = Object.entries(detalle).slice(0, 6).map(([plu, suc]) => ({ plu: Number(plu), suc }));
  return { timestamp: cache.timestamp, ventanaMeses: meses, opsDays,
    productos: Object.keys(mins).length, paresSucursalProducto: filas.length, conEnvioPosible: conS,
    distribucionABC: distAbc, ejemplos };
}
app.get('/api/distribucion/a8020/recalcular', apiRoute(async () => recalcularA8020()));
app.get('/api/distribucion/a8020', apiRoute(async () => leerJSON(A8020_CALC_PATH, { vacio: true })));
app.get('/distribucion/a8020', (_req, res) => res.sendFile(path.join(__dirname, 'a8020.html')));
app.get('/cotizador',         (_req, res) => res.sendFile(path.join(__dirname, 'cotizador.html')));

// ── Listas editables de distribución (excluir / siempre-Almacen / siempre-Pesable) ──
const LISTAS_DISTRIB_PATH = path.join(DATA_DIR, 'listas_distribucion.json');
const RESTR_SUCURSALES = ['rivadavia', 'urquiza', 'chacabuco', 'nacion', 'pergamino', 'sanPedro', 'villaRamallo'];
function leerListasDistrib() {
  let l = leerJSON(LISTAS_DISTRIB_PATH, null);
  if (!l) {   // seed: noEnvasa + restringidos del snapshot de la planilla; siempre* vacíos
    const snap = leerJSON(DISTRIB_LISTAS_PATH, {});
    const restrSnap = snap.restringidos || {};
    l = { noEnvasa: (snap.noEnvasa || []).map(Number).sort((a, b) => a - b), siempreAlmacen: [], siemprePesable: [], siemprePesableSinGranel: [], ocultarPesable: [],
      restringidos: Object.fromEntries(RESTR_SUCURSALES.map(k => [k, (restrSnap[k] || []).map(Number).sort((a, b) => a - b)])) };
    guardarJSON(LISTAS_DISTRIB_PATH, l);
  }
  l.noEnvasa = (l.noEnvasa || []).map(Number);
  l.siempreAlmacen = (l.siempreAlmacen || []).map(Number);
  l.siemprePesable = (l.siemprePesable || []).map(Number);
  l.siemprePesableSinGranel = (l.siemprePesableSinGranel || []).map(Number);
  l.ocultarPesable = (l.ocultarPesable || []).map(Number);   // ocultos solo en Pesables
  l.restringidos = l.restringidos || {};
  for (const k of RESTR_SUCURSALES) l.restringidos[k] = (l.restringidos[k] || []).map(Number);
  return l;
}
// Universo de PLUs: base ∪ siempre, menos los excluidos (noEnvasa) salvo que estén en "siempre".
function universoLista(basePlus, siempre, excluir) {
  const sSet = new Set(siempre.map(String)), exc = new Set(excluir.map(String));
  const set = new Set(basePlus.filter(p => /^\d+$/.test(p)));
  for (const p of siempre) set.add(String(p));
  return [...set].filter(p => !exc.has(p) || sSet.has(p));
}

// ── Fact en vivo: productos facturados a cada sucursal desde su última recepción (REC-SUC) ──
async function calcularFactLive() {
  const config = leerJSON(DISTRIB_CONFIG_PATH, {});
  const sucs = config.sucursales || {};
  const idSuc2key = {}, idCli2key = {}, idSucs = [], idClis = [];
  for (const [key, c] of Object.entries(sucs)) {
    if (c.idSucursal) { idSuc2key[c.idSucursal] = key; idSucs.push(c.idSucursal); }
    if (c.idCliente) { idCli2key[c.idCliente] = key; idClis.push(c.idCliente); }
  }
  const recByKey = {};
  if (idSucs.length) {
    // CONVERT(varchar,120) returns 'YYYY-MM-DD HH:MM:SS' string — no JS Date/timezone conversion
    const recRows = await query(`SELECT IdSucursal, CONVERT(varchar(19), MAX(FechaMovimiento), 120) AS Ult FROM MovimientosStock
      WHERE IdTipoMovimiento='REC-SUC' AND IdSucursal IN (${idSucs.join(',')}) GROUP BY IdSucursal`);
    for (const r of recRows) { const k = idSuc2key[r.IdSucursal]; if (k && r.Ult) recByKey[k] = r.Ult; }
  }
  const factByKey = {};
  if (idClis.length) {
    const key2cli = {};
    for (const [key, c] of Object.entries(sucs)) { if (c.idCliente) key2cli[key] = c.idCliente; }
    const cliConds = Object.entries(recByKey)
      .filter(([key]) => key2cli[key])
      .map(([key, ultStr]) => `(v.IdCliente = ${key2cli[key]} AND v.Fecha > '${ultStr}')`);
    if (cliConds.length) {
      const ventas = await query(`SELECT DISTINCT v.IdCliente, vp.IdProducto
        FROM VentasProductos vp
        INNER JOIN Ventas v ON v.IdSucursal=vp.IdSucursal AND v.IdTipoComprobante=vp.IdTipoComprobante
          AND v.Letra=vp.Letra AND v.CentroEmisor=vp.CentroEmisor AND v.NumeroComprobante=vp.NumeroComprobante
        WHERE ISNULL(v.IdEstadoComprobante,'')!='ANULADO'
          AND (${cliConds.join(' OR ')})`);
      for (const r of ventas) {
        const k = idCli2key[r.IdCliente]; if (!k) continue;
        (factByKey[k] = factByKey[k] || new Set()).add(Number(r.IdProducto));
      }
    }
  }
  return { recByKey, factByKey };
}

app.get('/api/distribucion/recepcion', apiRoute(async () => {
  const { recByKey } = await calcularFactLive();
  const out = {}; for (const [k, d] of Object.entries(recByKey)) out[k] = d;
  return out;
}));
app.get('/api/distribucion/fact-ventas-debug', apiRoute(async (req) => {
  const { plu, idCli, desde } = req.query;
  if (!idCli || !desde) return { error: 'Params: idCli, desde (YYYY-MM-DD HH:MM:SS), plu opcional' };
  const pluFilter = plu ? `AND vp.IdProducto='${Number(plu)}'` : '';
  return await query(`SELECT TOP 30 v.IdCliente, v.IdSucursal, CONVERT(varchar(19),v.Fecha,120) AS Fecha,
    v.IdEstadoComprobante, v.IdTipoComprobante, v.NumeroComprobante, vp.IdProducto, vp.Cantidad
    FROM VentasProductos vp
    INNER JOIN Ventas v ON v.IdSucursal=vp.IdSucursal AND v.IdTipoComprobante=vp.IdTipoComprobante
      AND v.Letra=vp.Letra AND v.CentroEmisor=vp.CentroEmisor AND v.NumeroComprobante=vp.NumeroComprobante
    WHERE v.IdCliente=${Number(idCli)} AND v.Fecha > '${desde}'
      AND ISNULL(v.IdEstadoComprobante,'') != 'ANULADO'
    ${pluFilter}
    ORDER BY v.Fecha DESC`);
}));
app.get('/api/distribucion/plu-debug', apiRoute(async (req) => {
  const { plu } = req.query;
  if (!plu) return { error: 'param: plu' };
  const rows = await calcularDistribucionPesables();
  const row = rows.find(r => String(r.plu) === String(plu));
  return row ? { plu: row.plu, nombre: row.nombre, enviar: row.enviar } : { notFound: true };
}));
app.get('/api/distribucion/fact-set-debug', apiRoute(async () => {
  const { factByKey } = await calcularFactLive();
  const out = {};
  for (const [k, set] of Object.entries(factByKey)) out[k] = [...set].sort((a,b) => a-b);
  return out;
}));
app.get('/api/distribucion/fact-debug', apiRoute(async () => {
  const config = leerJSON(DISTRIB_CONFIG_PATH, {});
  const sucs = config.sucursales || {};
  const idSuc2key = {}, key2cli = {}, idSucs = [];
  for (const [key, c] of Object.entries(sucs)) {
    if (c.idSucursal) { idSuc2key[c.idSucursal] = key; idSucs.push(c.idSucursal); }
    if (c.idCliente) key2cli[key] = c.idCliente;
  }
  const recByKey = {};
  if (idSucs.length) {
    const rows = await query(`SELECT IdSucursal, CONVERT(varchar(19), MAX(FechaMovimiento), 120) AS Ult FROM MovimientosStock
      WHERE IdTipoMovimiento='REC-SUC' AND IdSucursal IN (${idSucs.join(',')}) GROUP BY IdSucursal`);
    for (const r of rows) { const k = idSuc2key[r.IdSucursal]; if (k && r.Ult) recByKey[k] = r.Ult; }
  }
  const cliConds = Object.entries(recByKey)
    .filter(([key]) => key2cli[key])
    .map(([key, ultStr]) => `(v.IdCliente = ${key2cli[key]} AND v.Fecha > '${ultStr}')`);
  const sql = cliConds.length
    ? `SELECT DISTINCT v.IdCliente, vp.IdProducto FROM VentasProductos vp INNER JOIN Ventas v ON ... WHERE ISNULL(v.IdEstadoComprobante,'')!='ANULADO' AND (${cliConds.join(' OR ')})`
    : 'NO CONDITIONS';
  return { recByKey, conditions: cliConds, sqlPreview: sql };
}));
app.get('/api/distribucion/listas', apiRoute(async () => {
  const l = leerListasDistrib();
  const all = [...new Set([...l.noEnvasa, ...l.siempreAlmacen, ...l.siemprePesable, ...l.siemprePesableSinGranel, ...l.ocultarPesable,
    ...Object.values(l.restringidos).flat()])];
  const nombres = {};
  if (all.length) {
    const inList = all.map(p => `'${p}'`).join(',');   // IdProducto es varchar en Siga
    const rows = await query(`SELECT IdProducto, NombreProducto FROM Productos WHERE IdProducto IN (${inList})`);
    for (const r of rows) nombres[String(r.IdProducto)] = r.NombreProducto;
  }
  return { ...l, nombres };
}));
app.post('/api/distribucion/listas', (req, res) => {
  const cur = leerListasDistrib();
  const { lista, accion, plu, sucursal } = req.body || {};
  if (!['add', 'remove'].includes(accion) || !Number.isFinite(Number(plu)))
    return res.status(400).json({ error: 'parámetros inválidos' });
  if (lista === 'restringidos') {
    if (!RESTR_SUCURSALES.includes(sucursal))
      return res.status(400).json({ error: 'sucursal inválida' });
    const set = new Set(cur.restringidos[sucursal]);
    if (accion === 'add') set.add(Number(plu)); else set.delete(Number(plu));
    cur.restringidos[sucursal] = [...set].sort((a, b) => a - b);
    guardarJSON(LISTAS_DISTRIB_PATH, cur);
    return res.json({ ok: true, lista, sucursal, count: cur.restringidos[sucursal].length });
  }
  if (!['noEnvasa', 'siempreAlmacen', 'siemprePesable', 'siemprePesableSinGranel', 'ocultarPesable'].includes(lista))
    return res.status(400).json({ error: 'parámetros inválidos' });
  const set = new Set(cur[lista]);
  if (accion === 'add') set.add(Number(plu)); else set.delete(Number(plu));
  cur[lista] = [...set].sort((a, b) => a - b);
  guardarJSON(LISTAS_DISTRIB_PATH, cur);
  res.json({ ok: true, lista, count: cur[lista].length });
});
app.get('/api/distribucion/buscar', apiRoute(async req => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return [];
  if (/^\d+$/.test(q))
    return query(`SELECT TOP 25 IdProducto, NombreProducto FROM Productos WHERE CAST(IdProducto AS VARCHAR) LIKE '${q}%' ORDER BY IdProducto`);
  const safe = q.replace(/'/g, "''");
  return query(`SELECT TOP 25 IdProducto, NombreProducto FROM Productos WHERE NombreProducto LIKE '%${safe}%' AND Activo=1 ORDER BY NombreProducto`);
}));
// ── Distribución: registros de producción fraccionado ───────────────────────────
const FRAC_REG_PATH = path.join(DATA_DIR, 'fraccionado_registros.json');
app.get('/api/distribucion/fraccionado-registros', apiRoute(async () => leerJSON(FRAC_REG_PATH, [])));
const ALMACEN_TIPO_PATH = path.join(DATA_DIR, 'almacen_tipo.json');
app.get('/api/distribucion/almacen-tipo', apiRoute(async () => leerJSON(ALMACEN_TIPO_PATH, {})));
app.post('/api/distribucion/almacen-tipo', (req, res) => {
  const { plu, tipo } = req.body || {};
  if (!plu) return res.status(400).json({ error: 'falta plu' });
  const d = leerJSON(ALMACEN_TIPO_PATH, {});
  if (!tipo) delete d[String(plu)]; else d[String(plu)] = tipo;
  guardarJSON(ALMACEN_TIPO_PATH, d);
  res.json({ ok: true });
});

app.post('/api/distribucion/fraccionado-registros', (req, res) => {
  const b = req.body || {};
  if (b.plu == null || b.cantFraccionada == null) return res.status(400).json({ error: 'faltan campos' });
  // Se guarda el cuerpo completo (incluye observacion, ordenId, seccion y graneles[]).
  const arr = leerJSON(FRAC_REG_PATH, []);
  arr.push({ ...b, id: Date.now() });
  guardarJSON(FRAC_REG_PATH, arr);
  res.json({ ok: true });
});
app.get('/api/distribucion/pedidos', apiRoute(async () => {
  const rows = await query(`SELECT p.IdProducto, p.NombreProducto, ISNULL(r.NombreRubro,'') AS Rubro, p.EsCompuesto
    FROM Productos p LEFT JOIN Rubros r ON r.IdRubro = p.IdRubro
    WHERE p.NombreProducto LIKE '%PEDIDO%' AND p.Activo = 1 ORDER BY p.NombreProducto`);
  return rows.map(r => ({ plu: r.IdProducto, nombre: r.NombreProducto, rubro: r.Rubro, esCompuesto: !!r.EsCompuesto }));
}));
app.get('/api/distribucion/pedido-formula/:plu', async (req, res) => {
  try {
    const plu = parseInt(req.params.plu, 10);
    if (isNaN(plu)) return res.status(400).json({ error: 'PLU inválido' });
    const rows = await query(`
      SELECT pc.IdProductoComponente AS plu, comp.NombreProducto AS nombre,
             CAST(MAX(pc.Cantidad) AS FLOAT) AS cantidad
      FROM ProductosComponentes pc
      INNER JOIN Productos comp ON comp.IdProducto = pc.IdProductoComponente
      WHERE pc.IdProducto = ${plu}
      GROUP BY pc.IdProductoComponente, comp.NombreProducto`);
    console.log(`[pedido-formula] PLU=${plu} result=${rows.length}`);
    res.json(rows.map(r => ({ plu: String(r.plu), nombre: r.nombre, cantidad: r.cantidad })));
  } catch(e) { console.error('[pedido-formula]', e.message); res.status(500).json({ error: e.message }); }
});
app.delete('/api/distribucion/fraccionado-registros-fecha', (req, res) => {
  const { fecha } = req.query;
  const arr = leerJSON(FRAC_REG_PATH, []);
  const nuevo = fecha ? arr.filter(x => x.fecha !== fecha) : [];
  guardarJSON(FRAC_REG_PATH, nuevo);
  res.json({ ok: true, eliminados: arr.length - nuevo.length });
});
const HISTORIAL_PATH = path.join(DATA_DIR, 'historial_distribucion.json');
app.get('/api/distribucion/historial', apiRoute(async () => leerJSON(HISTORIAL_PATH, [])));
app.post('/api/distribucion/historial', (req, res) => {
  const b = req.body || {};
  if (!b.fecha) return res.status(400).json({ error: 'falta fecha' });
  // Guarda el cuerpo completo (incluye ordenes, completadas, pctCompletadas, totalOrdenes).
  const arr = leerJSON(HISTORIAL_PATH, []);
  arr.unshift({ ...b, produccion: b.produccion || [], pesables: b.pesables || [], id: Date.now(), exportadoEn: new Date().toISOString() });
  guardarJSON(HISTORIAL_PATH, arr);
  res.json({ ok: true });
});
app.delete('/api/distribucion/historial/:id', (req, res) => {
  const id = Number(req.params.id);
  const arr = leerJSON(HISTORIAL_PATH, []);
  const nuevo = arr.filter(x => x.id !== id);
  if (nuevo.length === arr.length) return res.status(404).json({ error: 'no encontrado' });
  guardarJSON(HISTORIAL_PATH, nuevo);
  res.json({ ok: true });
});
app.delete('/api/distribucion/fraccionado-registros/:id', (req, res) => {
  const id = Number(req.params.id);
  const arr = leerJSON(FRAC_REG_PATH, []);
  const nuevo = arr.filter(x => x.id !== id);
  if (nuevo.length === arr.length) return res.status(404).json({ error: 'no encontrado' });
  guardarJSON(FRAC_REG_PATH, nuevo);
  res.json({ ok: true });
});
app.put('/api/distribucion/fraccionado-registros/:id', (req, res) => {
  const id = Number(req.params.id);
  const arr = leerJSON(FRAC_REG_PATH, []);
  const idx = arr.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ error: 'no encontrado' });
  arr[idx] = { ...arr[idx], ...req.body, id };
  guardarJSON(FRAC_REG_PATH, arr);
  res.json({ ok: true });
});

// ── Producción: registros de cargas (archivo separado de distribución) ──────────
const PROD_REG_PATH = path.join(DATA_DIR, 'produccion_registros.json');
app.get('/api/produccion/registros', apiRoute(async () => leerJSON(PROD_REG_PATH, [])));
app.post('/api/produccion/registros', (req, res) => {
  const b = req.body || {};
  if (b.plu == null || b.cantFraccionada == null) return res.status(400).json({ error: 'faltan campos' });
  const arr = leerJSON(PROD_REG_PATH, []);
  arr.push({ ...b, id: Date.now() });
  guardarJSON(PROD_REG_PATH, arr);
  res.json({ ok: true });
});
app.delete('/api/produccion/registros-fecha', (req, res) => {
  const { fecha } = req.query;
  const arr = leerJSON(PROD_REG_PATH, []);
  const nuevo = fecha ? arr.filter(x => x.fecha !== fecha) : [];
  guardarJSON(PROD_REG_PATH, nuevo);
  res.json({ ok: true, eliminados: arr.length - nuevo.length });
});
app.delete('/api/produccion/registros/:id', (req, res) => {
  const id = Number(req.params.id);
  const arr = leerJSON(PROD_REG_PATH, []);
  const nuevo = arr.filter(x => x.id !== id);
  if (nuevo.length === arr.length) return res.status(404).json({ error: 'no encontrado' });
  guardarJSON(PROD_REG_PATH, nuevo);
  res.json({ ok: true });
});
app.put('/api/produccion/registros/:id', (req, res) => {
  const id = Number(req.params.id);
  const arr = leerJSON(PROD_REG_PATH, []);
  const idx = arr.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ error: 'no encontrado' });
  arr[idx] = { ...arr[idx], ...req.body, id };
  guardarJSON(PROD_REG_PATH, arr);
  res.json({ ok: true });
});

// ── Distribución: parámetros pesables (config motor) ────────────────────────────
const PESABLES_PARAMS_PATH = path.join(DATA_DIR, 'pesables_params.json');
app.get('/api/distribucion/pesables-params', apiRoute(async () => leerJSON(PESABLES_PARAMS_PATH, {})));
app.post('/api/distribucion/pesables-params', (req, res) => {
  const params = req.body;
  if (!params || typeof params !== 'object') return res.status(400).json({ error: 'body inválido' });
  guardarJSON(PESABLES_PARAMS_PATH, params);
  res.json({ ok: true });
});

// ── Distribución: asignaciones de empleados a órdenes fraccionado ───────────────
const FRACCIONADO_ASIG_PATH = path.join(DATA_DIR, 'fraccionado_asignaciones.json');
app.get('/api/distribucion/fraccionado-asignaciones', apiRoute(async () => leerJSON(FRACCIONADO_ASIG_PATH, {})));
app.post('/api/distribucion/fraccionado-asignaciones', (req, res) => {
  const { plu, empleados } = req.body || {};
  if (!plu) return res.status(400).json({ error: 'falta plu' });
  const cur = leerJSON(FRACCIONADO_ASIG_PATH, {});
  if (!empleados || empleados.length === 0) delete cur[String(plu)];
  else cur[String(plu)] = empleados;
  guardarJSON(FRACCIONADO_ASIG_PATH, cur);
  res.json({ ok: true });
});

// ── Distribución: clasificación envasado propio vs externo ──────────────────────
const ENVASADO_CLAS_PATH = path.join(DATA_DIR, 'envasado_clasificacion.json');
app.get('/api/distribucion/envasado', apiRoute(async () => {
  const data = leerJSON(ENVASADO_CLAS_PATH, { apidelta: [], externo: [], nombres: {} });
  return data;
}));
app.post('/api/distribucion/envasado', (req, res) => {
  const { accion, tipo, plu, nombre } = req.body || {};
  if (!accion || !tipo || !plu) return res.status(400).json({ error: 'faltan campos' });
  const cur = leerJSON(ENVASADO_CLAS_PATH, { apidelta: [], externo: [], nombres: {} });
  const id = Number(plu);
  if (accion === 'add') {
    if (!cur[tipo]) cur[tipo] = [];
    if (!cur[tipo].includes(id)) cur[tipo].push(id);
    if (nombre) cur.nombres[id] = nombre;
  } else if (accion === 'remove') {
    ['apidelta', 'externo'].forEach(t => { cur[t] = (cur[t] || []).filter(x => x !== id); });
    delete cur.nombres[id];
  } else if (accion === 'move') {
    const otro = tipo === 'apidelta' ? 'externo' : 'apidelta';
    cur[otro] = (cur[otro] || []).filter(x => x !== id);
    if (!cur[tipo]) cur[tipo] = [];
    if (!cur[tipo].includes(id)) cur[tipo].push(id);
  }
  guardarJSON(ENVASADO_CLAS_PATH, cur);
  res.json({ ok: true });
});
app.get('/api/distribucion/buscar-rubro', apiRoute(async req => {
  const rubro = String(req.query.rubro || '').trim();
  if (!rubro) return [];
  const safe = rubro.replace(/'/g, "''");
  return query(`SELECT TOP 200 p.IdProducto, p.NombreProducto, r.NombreRubro
    FROM Productos p
    LEFT JOIN Rubros r ON r.IdRubro=p.IdRubro
    WHERE r.NombreRubro LIKE '%${safe}%' AND p.Activo=1
    ORDER BY r.NombreRubro, p.NombreProducto`);
}));
app.get('/api/distribucion/buscar-marca', apiRoute(async req => {
  const marca = String(req.query.marca || '').trim();
  if (!marca) return [];
  const safe = marca.replace(/'/g, "''");
  try {
    return await query(`SELECT TOP 200 p.IdProducto, p.NombreProducto, r.NombreRubro
      FROM Productos p
      LEFT JOIN Rubros r ON r.IdRubro=p.IdRubro
      INNER JOIN Marcas m ON m.IdMarca=p.IdMarca
      WHERE m.NombreMarca LIKE '%${safe}%' AND p.Activo=1
      ORDER BY m.NombreMarca, p.NombreProducto`);
  } catch {
    return [];
  }
}));
app.get('/api/distribucion/rubros-lista', apiRoute(async () =>
  query(`SELECT DISTINCT NombreRubro FROM Rubros WHERE NombreRubro IS NOT NULL AND NombreRubro != '' ORDER BY NombreRubro`)
));

// Detalle de stock por sucursal: presentaciones (depósitos de venta) + granel (depósitos LIKE %GRANEL%)
app.get('/api/plan/stock-detalle', apiRoute(async req => {
  const norm = s => String(s||'').split(',').map(x=>x.trim()).filter(Boolean);
  const plus = norm(req.query.plus), graneles = norm(req.query.graneles);
  const all = [...new Set([...plus, ...graneles])];
  if (!all.length) return { sucursales: [], presentaciones: [], graneles: [] };
  const quote = arr => arr.map(p => `'${String(p).replace(/'/g, "''")}'`).join(',');
  const [nombres, sucs] = await Promise.all([
    query(`SELECT CAST(IdProducto AS VARCHAR) AS IdProducto, NombreProducto FROM Productos WHERE CAST(IdProducto AS VARCHAR) IN (${quote(all)})`),
    query(`SELECT IdSucursal, Nombre, SoyLaCentral FROM Sucursales ORDER BY SoyLaCentral DESC, IdSucursal`),
  ]);
  const nomMap = new Map(nombres.map(r => [String(r.IdProducto), r.NombreProducto]));
  const sucursales = sucs.map(s => ({ id: s.IdSucursal, nombre: s.Nombre, central: !!s.SoyLaCentral }));
  const stockPorSuc = async (ids, soloGranel) => ids.length ? query(`
    SELECT CAST(pd.IdProducto AS VARCHAR) AS IdProducto, pd.IdSucursal, COALESCE(SUM(pd.Stock),0) AS Stock
    FROM ProductosDepositos pd
    INNER JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal
    WHERE ${soloGranel ? `UPPER(sd.NombreDeposito) LIKE '%GRANEL%'` : `sd.DisponibleVenta=1`}
      AND CAST(pd.IdProducto AS VARCHAR) IN (${quote(ids)})
    GROUP BY pd.IdProducto, pd.IdSucursal`) : [];
  const [presRows, granRows] = await Promise.all([stockPorSuc(plus, false), stockPorSuc(graneles, true)]);
  const build = (ids, rows) => ids.map(plu => {
    const porSuc = {}; let total = 0;
    for (const r of rows) if (String(r.IdProducto) === plu) {
      const v = Math.round((parseFloat(r.Stock) || 0) * 100) / 100;
      porSuc[r.IdSucursal] = v; total += v;
    }
    return { plu, nombre: nomMap.get(plu) || plu, porSuc, total: Math.round(total * 100) / 100 };
  });
  return { sucursales, presentaciones: build(plus, presRows), graneles: build(graneles, granRows) };
}));
app.get('/api/consumo',          apiRoute(async req => { const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); return query(sqlConsumo(parseInt(req.query.ventana) || c.ventanaConsumoDias, c.rubrosPlanificables.join(','))); }));
app.get('/api/pendientes',       apiRoute(async () => query(sqlPendientes())));
app.get('/api/bom',              apiRoute(async () => { const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); return query(sqlBOM(c.rubrosGranel.join(','))); }));
app.get('/api/bom/producto/:plu', apiRoute(async req => {
  const plu = String(req.params.plu).replace(/\D/g, '');
  if (!plu) return [];
  return query(`
    SELECT pc.IdProductoComponente AS plu,
           comp.NombreProducto     AS nombre,
           pc.Cantidad             AS cantPorUnidad
    FROM ProductosComponentes pc
    INNER JOIN Productos comp ON comp.IdProducto = pc.IdProductoComponente
    WHERE pc.IdProducto = ${plu}
    ORDER BY comp.NombreProducto`);
}));
app.get('/api/plan/sugerencias',        apiRoute(async req => calcularSugerencias(req.query)));
app.get('/api/plan/sugerencias-grupos', apiRoute(async req => calcularSugerenciasCatalogo(req.query)));
app.get('/api/envases', apiRoute(async () => query(`
SELECT p.IdProducto, p.NombreProducto, r.NombreRubro, COALESCE(SUM(pd.Stock),0) AS StockActual
FROM Productos p INNER JOIN Rubros r ON r.IdRubro=p.IdRubro
LEFT  JOIN ProductosDepositos pd ON pd.IdProducto=p.IdProducto
LEFT  JOIN SucursalesDepositos sd ON sd.IdDeposito=pd.IdDeposito AND sd.IdSucursal=pd.IdSucursal
LEFT  JOIN Sucursales s ON s.IdSucursal=pd.IdSucursal AND s.SoyLaCentral=1
WHERE p.Activo=1 AND UPPER(r.NombreRubro) LIKE '%EMBALA%'
GROUP BY p.IdProducto, p.NombreProducto, r.NombreRubro ORDER BY p.NombreProducto`)));

// ── Registro de envases (código de sistema → nombre + stock desde Siga) ──
async function envaseLookup(codigo) {
  const safe = String(codigo).replace(/'/g, "''");
  const rows = await query(`SELECT TOP 1 p.IdProducto, p.NombreProducto,
      COALESCE((SELECT SUM(pd.Stock) FROM dbo.ProductosDepositos pd WHERE pd.IdProducto = p.IdProducto), 0) AS StockActual
    FROM dbo.Productos p WHERE p.IdProducto = '${safe}' AND p.Activo = 1`);
  return rows.length ? { codigo: String(rows[0].IdProducto), nombre: rows[0].NombreProducto, stock: Number(rows[0].StockActual) || 0 } : null;
}
app.get('/api/envase-lookup', apiRoute(async req => {
  const codigo = (req.query.codigo || '').trim();
  if (!codigo) return { error: 'Falta código' };
  return (await envaseLookup(codigo)) || { error: 'Producto no encontrado' };
}));
app.get('/api/envases-registro', (_req, res) => res.json(leerJSON(ENVASES_REG_PATH, [])));
app.post('/api/envases-registro', apiRoute(async req => {
  const codigo = ((req.body && req.body.codigo) || '').toString().trim();
  if (!codigo) return { error: 'Falta código' };
  const e = await envaseLookup(codigo);
  if (!e) return { error: 'Producto no encontrado en Siga' };
  const arr = leerJSON(ENVASES_REG_PATH, []);
  const i = arr.findIndex(x => String(x.codigo) === String(e.codigo));
  if (i >= 0) arr[i] = e; else arr.push(e);
  guardarJSON(ENVASES_REG_PATH, arr);
  return { ok: true, envase: e };
}));
app.post('/api/envases-registro/refrescar', apiRoute(async () => {
  const arr = leerJSON(ENVASES_REG_PATH, []);
  for (const x of arr) { const e = await envaseLookup(x.codigo); if (e) { x.nombre = e.nombre; x.stock = e.stock; } }
  guardarJSON(ENVASES_REG_PATH, arr);
  return { ok: true, envases: arr };
}));
app.delete('/api/envases-registro/:codigo', (req, res) => {
  const cod = String(req.params.codigo);
  guardarJSON(ENVASES_REG_PATH, leerJSON(ENVASES_REG_PATH, []).filter(x => String(x.codigo) !== cod));
  res.json({ ok: true });
});
app.get('/api/clientes-registro', (_req, res) => res.json(leerJSON(CLIENTES_PATH, [])));
app.post('/api/clientes-registro', apiRoute(async req => {
  const nombre = ((req.body && req.body.nombre) || '').toString().trim();
  if (!nombre) return { error: 'Falta nombre' };
  const arr = leerJSON(CLIENTES_PATH, []);
  const id = Date.now();
  arr.push({ id, nombre });
  guardarJSON(CLIENTES_PATH, arr);
  return { ok: true, cliente: { id, nombre } };
}));
app.delete('/api/clientes-registro/:id', (req, res) => {
  const id = Number(req.params.id);
  guardarJSON(CLIENTES_PATH, leerJSON(CLIENTES_PATH, []).filter(x => x.id !== id));
  res.json({ ok: true });
});
app.get('/api/diag/estados-venta',       apiRoute(async () => query('SELECT DISTINCT IdEstadoComprobante FROM Ventas ORDER BY IdEstadoComprobante')));
app.get('/api/diag/categorias-clientes', apiRoute(async () => { const tablas = await query(`SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME LIKE '%Categ%' OR TABLE_NAME LIKE '%Clie%' ORDER BY TABLE_NAME`); const cats = await query(`SELECT TOP 5 * FROM Clientes`).catch(() => []); return { tablas: tablas.map(t => t.TABLE_NAME), muestraClientes: cats }; }));
app.get('/api/diag/consumo-grupo', apiRoute(async req => {
  const ref = req.query.ref || 'Mix F.S N&P';
  const ventana = parseInt(req.query.ventana) || 30;
  const cat = leerJSON(CATALOGO_PATH, []).filter(i => i.productoRef === ref);
  if (!cat.length) return { error: 'grupo no encontrado' };
  const plus = cat.map(i => String(i.plu));
  const rows = await query(`SELECT vp.IdProducto, p.NombreProducto,
    SUM(vp.Cantidad) AS TotalVendido,
    COUNT(DISTINCT CAST(v.Fecha AS DATE)) AS DiasConVenta,
    CAST(SUM(vp.Cantidad) AS DECIMAL(18,4))/NULLIF(COUNT(DISTINCT CAST(v.Fecha AS DATE)),0) AS PromDia
  FROM VentasProductos vp
  INNER JOIN Ventas v ON v.IdSucursal=vp.IdSucursal AND v.IdTipoComprobante=vp.IdTipoComprobante
    AND v.Letra=vp.Letra AND v.CentroEmisor=vp.CentroEmisor AND v.NumeroComprobante=vp.NumeroComprobante
  INNER JOIN Productos p ON p.IdProducto=vp.IdProducto
  LEFT JOIN Clientes c ON c.IdCliente=v.IdCliente
  LEFT JOIN Categorias cat ON cat.IdCategoria=c.IdCategoria
  WHERE v.Fecha >= DATEADD(DAY,-${ventana},CAST(GETDATE() AS DATE)) AND v.Fecha < CAST(GETDATE() AS DATE)
    AND ISNULL(v.IdEstadoComprobante,'') != 'ANULADO' AND UPPER(ISNULL(cat.NombreCategoria,'')) != 'SUCURSAL'
    AND vp.IdProducto IN (${plus.join(',')})
  GROUP BY vp.IdProducto, p.NombreProducto ORDER BY TotalVendido DESC`);
  return cat.map(i => {
    const r = rows.find(x => String(x.IdProducto) === String(i.plu));
    return { plu: i.plu, base: i.baseNombre, pres: i.presentacion, esVariante: i.esVariante,
      totalVendido: r ? parseFloat(r.TotalVendido) : 0,
      diasConVenta: r ? r.DiasConVenta : 0,
      promDia: r ? parseFloat(r.PromDia) : 0,
      promMes: r ? Math.round(parseFloat(r.PromDia)*30*10)/10 : 0 };
  });
}));
app.get('/api/diag/ventas-test', apiRoute(async () => {
  const [vpCount, vCount, joinTest, colsVP] = await Promise.all([
    query(`SELECT COUNT(*) AS Total FROM VentasProductos WHERE IdProducto IN (4039,4042,4054)`),
    query(`SELECT COUNT(*) AS Total FROM Ventas WHERE Fecha >= DATEADD(DAY,-30,CAST(GETDATE() AS DATE)) AND IdEstadoComprobante IN ('FACTURADO','INVOCO')`),
    query(`SELECT TOP 3 vp.IdProducto, SUM(vp.Cantidad) AS Total FROM VentasProductos vp INNER JOIN Ventas v ON v.IdSucursal=vp.IdSucursal AND v.IdTipoComprobante=vp.IdTipoComprobante AND v.Letra=vp.Letra AND v.CentroEmisor=vp.CentroEmisor AND v.NumeroComprobante=vp.NumeroComprobante WHERE v.Fecha >= DATEADD(DAY,-30,CAST(GETDATE() AS DATE)) AND ISNULL(v.IdEstadoComprobante,'') != 'ANULADO' GROUP BY vp.IdProducto`),
    query(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='VentasProductos' ORDER BY ORDINAL_POSITION`)
  ]);
  return { vpConPlu: vpCount[0].Total, ventasRecientes: vCount[0].Total, joinTop3: joinTest, columnasVP: colsVP.map(c => c.COLUMN_NAME) };
}));
app.get('/api/diag/plu-detalle', apiRoute(async req => {
  const plu = parseInt(req.query.plu);
  const ventana = parseInt(req.query.ventana) || 30;
  const lineas = await query(`SELECT TOP 50 v.Fecha, vp.Cantidad, vp.ImporteTotal
    FROM VentasProductos vp
    INNER JOIN Ventas v ON v.IdSucursal=vp.IdSucursal AND v.IdTipoComprobante=vp.IdTipoComprobante
      AND v.Letra=vp.Letra AND v.CentroEmisor=vp.CentroEmisor AND v.NumeroComprobante=vp.NumeroComprobante
    LEFT JOIN Clientes c ON c.IdCliente=v.IdCliente
    LEFT JOIN Categorias cat ON cat.IdCategoria=c.IdCategoria
    WHERE v.Fecha >= DATEADD(DAY,-${ventana},CAST(GETDATE() AS DATE)) AND v.Fecha < CAST(GETDATE() AS DATE)
      AND ISNULL(v.IdEstadoComprobante,'') != 'ANULADO' AND UPPER(ISNULL(cat.NombreCategoria,'')) != 'SUCURSAL'
      AND vp.IdProducto=${plu} ORDER BY v.Fecha DESC`);
  const resumen = await query(`SELECT SUM(vp.Cantidad) AS TotalCant, SUM(vp.ImporteTotal) AS TotalImporte
    FROM VentasProductos vp
    INNER JOIN Ventas v ON v.IdSucursal=vp.IdSucursal AND v.IdTipoComprobante=vp.IdTipoComprobante
      AND v.Letra=vp.Letra AND v.CentroEmisor=vp.CentroEmisor AND v.NumeroComprobante=vp.NumeroComprobante
    LEFT JOIN Clientes c ON c.IdCliente=v.IdCliente
    LEFT JOIN Categorias cat ON cat.IdCategoria=c.IdCategoria
    WHERE v.Fecha >= DATEADD(DAY,-${ventana},CAST(GETDATE() AS DATE)) AND v.Fecha < CAST(GETDATE() AS DATE)
      AND ISNULL(v.IdEstadoComprobante,'') != 'ANULADO' AND UPPER(ISNULL(cat.NombreCategoria,'')) != 'SUCURSAL'
      AND vp.IdProducto=${plu}`);
  const r = resumen[0] || {};
  const tc = parseFloat(r.TotalCant) || 0, ti = parseFloat(r.TotalImporte) || 0;
  return { plu, resumen: { totalCant: tc, totalImporte: ti, precioProm: tc ? Math.round(ti/tc*100)/100 : 0 },
    lineas: lineas.map(l => ({ fecha: l.Fecha, cant: parseFloat(l.Cantidad), importe: parseFloat(l.ImporteTotal),
      precioUnit: parseFloat(l.Cantidad) ? Math.round(parseFloat(l.ImporteTotal)/parseFloat(l.Cantidad)*100)/100 : 0 })) };
}));
app.get('/api/diag/bom-source', apiRoute(async () => {
  const [comp, tablaFormulas] = await Promise.all([
    query(`SELECT COUNT(*) AS Total FROM ProductosComponentes pc INNER JOIN Productos comp ON comp.IdProducto=pc.IdProductoComponente WHERE comp.IdRubro IN (22,23)`),
    query(`SELECT COUNT(*) AS Total FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ProductosFormulas'`)
  ]);
  return { ProductosComponentes: comp[0].Total, tieneProductosFormulas: tablaFormulas[0].Total > 0 };
}));

// ── Planes ─────────────────────────────────────────────────────────────────────
app.get('/api/planes', (_req, res) => {
  const planes = leerJSON(PLANES_PATH, {});
  res.json(Object.keys(planes).sort().reverse().map(fecha => ({ fecha, totalItems: planes[fecha].items.length, totalUnidades: planes[fecha].items.reduce((s, i) => s + (i.cantConfirmada ?? i.cantSugerida ?? 0), 0), creado: planes[fecha].creado })));
});
app.get('/api/plan/:fecha', (req, res) => { const fecha = safeDate(req.params.fecha), planes = leerJSON(PLANES_PATH, {}); res.json(planes[fecha] || { fecha, notas: '', items: [] }); });
app.post('/api/plan/:fecha', (req, res) => {
  const fecha = safeDate(req.params.fecha), planes = leerJSON(PLANES_PATH, {});
  planes[fecha] = { fecha, notas: req.body.notas || planes[fecha]?.notas || '', creado: planes[fecha]?.creado || new Date().toISOString(), items: req.body.items || [] };
  guardarJSON(PLANES_PATH, planes); res.json(planes[fecha]);
});
app.post('/api/plan/:fecha/desde-sugerencias', apiRoute(async req => {
  const fecha = safeDate(req.params.fecha), sugs = await calcularSugerencias({});
  const ts = Date.now();
  const items = sugs.filter(s => (s.semaforo === 'RED' || s.semaforo === 'YELLOW') && s.cantSugerida > 0).map((s, i) => ({
    id: ts + i, idProducto: s.idProducto, producto: s.producto, rubro: s.rubro, stockActual: s.stockActual,
    promDiario: s.promDiario, diasStock: s.diasStock, semaforo: s.semaforo, pendientes: s.pendientes,
    cantSugerida: s.cantSugerida, cantConfirmada: s.cantSugerida, responsable: '', prioridad: i + 1, estado: 'pendiente',
    idGranel: s.idGranel, nombreGranel: s.nombreGranel, cantPorUnidad: s.cantPorUnidad,
    granelNecesario: s.granelNecesario, granelDisponible: s.granelDisponible, granelOk: s.granelOk
  }));
  const planes = leerJSON(PLANES_PATH, {});
  planes[fecha] = { fecha, notas: planes[fecha]?.notas || '', creado: planes[fecha]?.creado || new Date().toISOString(), items };
  guardarJSON(PLANES_PATH, planes); return planes[fecha];
}));
app.post('/api/plan/:fecha/desde-sugerencias-catalogo', apiRoute(async req => {
  const fecha = safeDate(req.params.fecha), grupos = await calcularSugerenciasCatalogo({});
  const ts = Date.now(); let idx = 0; const items = [];
  for (const g of grupos) {
    if (g.semaforo === 'GREEN') continue;
    for (const p of g.presentaciones) {
      if (p.cantSugerida <= 0) continue;
      items.push({ id: ts + idx++, idProducto: p.plu, producto: p.baseNombre, rubro: g.productoRef, stockActual: p.stockActual,
        promDiario: p.promDiario, diasStock: p.diasStock, semaforo: p.semaforo, pendientes: p.pendientes,
        cantSugerida: p.cantSugerida, cantConfirmada: p.cantSugerida, responsable: '', prioridad: idx, estado: 'pendiente',
        idGranel: p.idGranel, nombreGranel: p.nombreGranel, cantPorUnidad: p.cantPorUnidad,
        granelNecesario: p.granelNecesario, granelDisponible: p.granelDisponible, granelOk: p.granelOk });
    }
  }
  const planes = leerJSON(PLANES_PATH, {});
  planes[fecha] = { fecha, notas: planes[fecha]?.notas || '', creado: planes[fecha]?.creado || new Date().toISOString(), items };
  guardarJSON(PLANES_PATH, planes); return planes[fecha];
}));
app.post('/api/plan/:fecha/item', apiRoute(async req => {
  const fecha = safeDate(req.params.fecha), planes = leerJSON(PLANES_PATH, {});
  if (!planes[fecha]) planes[fecha] = { fecha, notas: '', creado: new Date().toISOString(), items: [] };
  const nuevoItem = { responsable: '', estado: 'pendiente', ...req.body, id: Date.now(), cantConfirmada: req.body.cantConfirmada ?? req.body.cantSugerida ?? 0, prioridad: planes[fecha].items.length + 1 };
  planes[fecha].items.push(nuevoItem); guardarJSON(PLANES_PATH, planes); return nuevoItem;
}));
app.put('/api/plan/:fecha/item/:id', (req, res) => {
  const fecha = safeDate(req.params.fecha), id = parseInt(req.params.id), planes = leerJSON(PLANES_PATH, {});
  const plan = planes[fecha]; if (!plan) return res.status(404).json({ error: 'Plan no encontrado' });
  const idx = plan.items.findIndex(i => i.id === id); if (idx === -1) return res.status(404).json({ error: 'Ítem no encontrado' });
  plan.items[idx] = { ...plan.items[idx], ...req.body, id }; guardarJSON(PLANES_PATH, planes); res.json(plan.items[idx]);
});
app.delete('/api/plan/:fecha/item/:id', (req, res) => {
  const fecha = safeDate(req.params.fecha), id = parseInt(req.params.id), planes = leerJSON(PLANES_PATH, {});
  const plan = planes[fecha]; if (!plan) return res.status(404).json({ error: 'Plan no encontrado' });
  plan.items = plan.items.filter(i => i.id !== id); guardarJSON(PLANES_PATH, planes); res.json({ ok: true });
});
app.delete('/api/plan/:fecha', (req, res) => {
  const fecha = safeDate(req.params.fecha), planes = leerJSON(PLANES_PATH, {});
  if (planes[fecha]) { planes[fecha].items = []; guardarJSON(PLANES_PATH, planes); }
  res.json({ ok: true });
});
app.get('/api/calendario', (req, res) => {
  const desde = safeDate(req.query.desde), dias = Math.min(parseInt(req.query.dias) || 7, 42);
  const planes = leerJSON(PLANES_PATH, {}), result = {}, base = new Date(desde + 'T00:00:00');
  for (let i = 0; i < dias; i++) {
    const d = new Date(base); d.setDate(d.getDate() + i);
    const f = d.toISOString().slice(0, 10), plan = planes[f] || { items: [] };
    result[f] = { totalItems: plan.items.length, totalUnidades: plan.items.reduce((s, it) => s + (it.cantConfirmada ?? it.cantSugerida ?? 0), 0), tieneRiesgoGranel: plan.items.some(it => it.granelOk === false), items: plan.items };
  }
  res.json(result);
});
app.post('/api/enviar-produccion', (req, res) => {
  const nuevas = req.body;
  if (!Array.isArray(nuevas) || !nuevas.length) return res.status(400).json({ error: 'Sin órdenes' });
  try {
    // Dedup por (fecha + producto): si ya existe la orden ese día se sobreescriben
    // los datos con los nuevos, preservando id (link con lo cargado), estado y la
    // escalada manual a 'Urgente'. Las que no existen se agregan al final.
    const arr = leerOrdenes();
    const keyOf = o => `${o.fecha || ''}|${(o.producto || '').trim().toLowerCase()}`;
    const idx = new Map(arr.map((o, i) => [keyOf(o), i]));
    let sobre = 0, nue = 0, completas = 0;
    for (const n of nuevas) {
      const k = keyOf(n), i = idx.get(k);
      if (i != null) {
        const prev = arr[i];
        // Si la orden previa ya está completa, se verifica y se mantiene oculta:
        // no se sobreescribe (preserva registro cargado, estado 'listo' y terminado).
        if (prev.terminado === true || prev.estado === 'listo') { completas++; continue; }
        arr[i] = { ...n, id: prev.id, estado: prev.estado, terminado: prev.terminado, criticidad: prev.criticidad === 'Urgente' ? 'Urgente' : n.criticidad };
        sobre++;
      } else {
        arr.push(n); idx.set(k, arr.length - 1); nue++;
      }
    }
    guardarOrdenes(arr);
    res.json({ ok: true, enviadas: nuevas.length, sobrescritas: sobre, nuevas: nue, completasOmitidas: completas });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/ordenes-produccion', (_req, res) => res.json(leerOrdenes()));
app.post('/api/ordenes-produccion/reordenar', (req, res) => {
  const ids = req.body && req.body.ids;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'Falta ids[]' });
  try {
    const arr = leerOrdenes();
    const pos = new Map(ids.map((id, i) => [String(id), i]));
    arr.sort((a, b) => (pos.has(String(a.id)) ? pos.get(String(a.id)) : 1e9) - (pos.has(String(b.id)) ? pos.get(String(b.id)) : 1e9));
    guardarOrdenes(arr);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Cotizador Mercado Libre ───────────────────────────────────────────────────
const COMISIONES_PATH = path.join(__dirname, 'data', 'comisiones_mercadolibre.json');
const VINCULACIONES_PATH = path.join(__dirname, 'data', 'vinculaciones_mercadolibre.json');

app.get('/api/cotizador/comisiones', (_req, res) => {
  const comisiones = leerJSON(COMISIONES_PATH, { provincias: {} });
  res.json(comisiones);
});

app.get('/api/cotizador/vinculaciones', (_req, res) => {
  const vinculaciones = leerJSON(VINCULACIONES_PATH, []);
  res.json(vinculaciones);
});

app.post('/api/cotizador/vinculaciones', (req, res) => {
  try {
    const datos = Array.isArray(req.body) ? req.body : [req.body];
    guardarJSON(VINCULACIONES_PATH, datos);
    res.json({ ok: true, guardadas: datos.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function calcularPrecioML(precioVentaSIGA, comisionPct, iva, cuotasPct = 0, costoEnvio = 0) {
  // Precio ML para que neto después de comisión+cuotas+IVA+envío = precioVentaSIGA
  const descuentoTotal = comisionPct / 100 + cuotasPct / 100;
  const precioML = (precioVentaSIGA + costoEnvio) / ((1 - descuentoTotal) * (1 - iva / 100));
  const comisionMonto = precioML * (comisionPct / 100);
  const cuotasMonto = precioML * (cuotasPct / 100);
  const ivaMonto = (precioML - comisionMonto - cuotasMonto) * (iva / 100);
  return { precioML, comisionMonto, cuotasMonto, ivaMonto };
}

app.post('/api/cotizador/calcular', apiRoute(async req => {
  const { idProductoSIGA, categoriaMercadoLibre, provincia, cuotasPct = 0, costoEnvio = 0 } = req.body;
  if (!idProductoSIGA || !categoriaMercadoLibre || !provincia) {
    throw new Error('Faltan parámetros: idProductoSIGA, categoriaMercadoLibre, provincia');
  }

  const rows = await query(`
    SELECT TOP 1 p.IdProducto, p.NombreProducto, psp.PrecioVenta, ps.PrecioCosto
    FROM Productos p
    LEFT JOIN ProductosSucursalesPrecios psp ON psp.IdProducto=p.IdProducto AND psp.IdSucursal=1
    LEFT JOIN ProductosSucursales ps ON ps.IdProducto=p.IdProducto AND ps.IdSucursal=1
    WHERE p.IdProducto='${idProductoSIGA.replace(/'/g, "''")}'
  `);

  if (!rows.length) throw new Error('Producto no encontrado: ' + idProductoSIGA);

  const producto = rows[0];
  const precioVentaSIGA = producto.PrecioVenta || 0;

  const comisiones = leerJSON(COMISIONES_PATH, { provincias: {} });
  const provinciaData = comisiones.provincias[provincia] || comisiones.provincias.DEFAULT;
  const comisionPct = provinciaData[categoriaMercadoLibre] || provinciaData.DEFAULT || 14.80;
  const iva = comisiones.metadata?.iva_aplicable || 21;

  const { precioML, comisionMonto, cuotasMonto, ivaMonto } = calcularPrecioML(precioVentaSIGA, comisionPct, iva, cuotasPct, costoEnvio);

  return {
    idProductoSIGA,
    nombreProducto: producto.NombreProducto,
    precioVentaSIGA: parseFloat(precioVentaSIGA.toFixed(2)),
    categoriaMercadoLibre,
    provincia,
    comisionPct: parseFloat(comisionPct.toFixed(2)),
    comisionMonto: parseFloat(comisionMonto.toFixed(2)),
    cuotasPct: parseFloat(cuotasPct),
    cuotasMonto: parseFloat(cuotasMonto.toFixed(2)),
    costoEnvio: parseFloat(costoEnvio),
    ivaAplicable: iva,
    ivaMonto: parseFloat(ivaMonto.toFixed(2)),
    precioFinalMercadoLibre: parseFloat(precioML.toFixed(2))
  };
}));

app.get('/api/cotizador/calcular-todos', apiRoute(async () => {
  const vinculaciones = leerJSON(VINCULACIONES_PATH, []);
  const activas = vinculaciones.filter(v => v.activo && v.idProductoSIGA);
  if (!activas.length) return [];

  const ids = activas.map(v => `'${v.idProductoSIGA.replace(/'/g, "''")}'`).join(',');
  const rows = await query(`
    SELECT p.IdProducto, p.NombreProducto, psp.PrecioVenta
    FROM Productos p
    LEFT JOIN ProductosSucursalesPrecios psp ON psp.IdProducto=p.IdProducto AND psp.IdSucursal=1
    WHERE p.IdProducto IN (${ids})
  `);

  const preciosMap = new Map(rows.map(r => [String(r.IdProducto), r]));
  const comisiones = leerJSON(COMISIONES_PATH, { provincias: {} });
  const iva = comisiones.metadata?.iva_aplicable || 21;

  return activas.map(v => {
    const prod = preciosMap.get(String(v.idProductoSIGA));
    const precioVentaSIGA = prod?.PrecioVenta || 0;
    const provinciaData = comisiones.provincias[v.provincia] || comisiones.provincias.DEFAULT;
    const comisionPct = provinciaData[v.categoriaMercadoLibre] || provinciaData.DEFAULT || 14.80;
    const cuotasPct = parseFloat(v.cuotasPct) || 0;
    const costoEnvio = parseFloat(v.costoEnvio) || 0;
    const { precioML, comisionMonto, cuotasMonto, ivaMonto } = calcularPrecioML(precioVentaSIGA, comisionPct, iva, cuotasPct, costoEnvio);

    return {
      skuMercadoLibre: v.skuMercadoLibre,
      idProductoSIGA: v.idProductoSIGA,
      nombreProducto: prod?.NombreProducto || v.nombreProducto,
      categoriaMercadoLibre: v.categoriaMercadoLibre,
      provincia: v.provincia,
      precioVentaSIGA: parseFloat(precioVentaSIGA.toFixed(2)),
      comisionPct: parseFloat(comisionPct.toFixed(2)),
      comisionMonto: parseFloat(comisionMonto.toFixed(2)),
      cuotasPct,
      cuotasMonto: parseFloat(cuotasMonto.toFixed(2)),
      costoEnvio,
      ivaAplicable: iva,
      ivaMonto: parseFloat(ivaMonto.toFixed(2)),
      precioFinalMercadoLibre: parseFloat(precioML.toFixed(2))
    };
  });
}));

app.post('/api/cotizador/importar', multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }).single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Sin archivo' });

    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const datos = XLSX.utils.sheet_to_json(ws);

    const vinculaciones = leerJSON(VINCULACIONES_PATH, []);
    let agregadas = 0;

    datos.forEach(row => {
      const sku = String(row['SKU'] || row['sku'] || row['Código'] || '').trim();
      const nombre = String(row['Nombre'] || row['nombre'] || '').trim();
      const categoria = String(row['Categoría'] || row['categoria'] || 'Alimentos y Bebidas').trim();
      const provincia = String(row['Provincia'] || row['provincia'] || 'Buenos Aires').trim();

      if (!sku) return;

      const existe = vinculaciones.find(v => v.skuMercadoLibre === sku);
      if (!existe) {
        vinculaciones.push({
          skuMercadoLibre: sku,
          idProductoSIGA: '',
          nombreProducto: nombre,
          categoriaMercadoLibre: categoria,
          provincia,
          activo: true,
          ultimaActualizacion: new Date().toISOString()
        });
        agregadas++;
      }
    });

    guardarJSON(VINCULACIONES_PATH, vinculaciones);
    res.json({ ok: true, agregadas, total: vinculaciones.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Dashboard Ventas por Hora ──────────────────────────────────────────────────
app.get('/ventas-hora', (_req, res) => res.sendFile(path.join(__dirname, 'ventas_hora.html')));

app.get('/api/ventas-hora', apiRoute(async req => {
  const desde  = safeDate(req.query.desde);
  const hasta  = safeDate(req.query.hasta);
  const sucIds = req.query.sucursales
    ? req.query.sucursales.split(',').map(Number).filter(n => !isNaN(n))
    : [];

  const sucFilter = sucIds.length
    ? `AND v.IdSucursal IN (${sucIds.join(',')})`
    : '';

  return query(`
    SELECT
      v.IdSucursal,
      s.Nombre AS NombreSucursal,
      DATEPART(HOUR, v.Fecha) AS Hora,
      SUM(v.ImporteTotal) AS Total,
      COUNT(DISTINCT v.NumeroComprobante) AS CantTickets
    FROM Ventas v
    LEFT JOIN Sucursales s ON s.IdSucursal = v.IdSucursal
    WHERE v.Fecha >= '${desde} 00:00:00'
      AND v.Fecha <= '${hasta} 23:59:59'
      AND v.ImporteTotal > 0
      ${sucFilter}
    GROUP BY v.IdSucursal, s.Nombre, DATEPART(HOUR, v.Fecha)
    ORDER BY v.IdSucursal, Hora
  `);
}));

app.get('/api/ventas-hora/sucursales', apiRoute(async () => {
  return query(`
    SELECT DISTINCT v.IdSucursal, s.Nombre AS NombreSucursal
    FROM Ventas v
    LEFT JOIN Sucursales s ON s.IdSucursal = v.IdSucursal
    WHERE s.Nombre IS NOT NULL
    ORDER BY v.IdSucursal
  `);
}));

// ── Movimientos de stock (Siga) ────────────────────────────────────────────────
// Movimiento simple (1 línea) tipo BIENESUSO, con INSERT del renglón de stock si
// el depósito/ubicación destino todavía no tiene fila para el producto.
// Ver pruebas_stock_claude/README.md para el mecanismo completo investigado.
const TIPOS_MOVIMIENTO_STOCK_PERMITIDOS = ['BIENESUSO'];

app.get('/api/stock/depositos', apiRoute(async req => {
  const idSucursal = Number(req.query.idSucursal);
  if (!Number.isInteger(idSucursal) || idSucursal <= 0) return { error: 'Falta idSucursal (entero positivo)' };
  return query(`SELECT IdDeposito, IdSucursal, RTRIM(NombreDeposito) AS NombreDeposito, TipoDeposito, DisponibleVenta
    FROM SucursalesDepositos WHERE IdSucursal=${idSucursal} AND Activo=1 ORDER BY IdDeposito`);
}));

async function registrarMovimientoStock(pool, m) {
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const rq = () => new sql.Request(tx);
    const delta = (await rq()
      .input('tipo', sql.VarChar, m.idTipoMovimiento)
      .query(`SELECT CoeficienteStock FROM TiposMovimientos WHERE IdTipoMovimiento=@tipo`)
    ).recordset[0]?.CoeficienteStock;
    if (delta === undefined) throw new Error(`Tipo de movimiento desconocido: ${m.idTipoMovimiento}`);
    const cantidadStock = m.cantidad * delta;

    const numero = (await rq()
      .input('sucursal', sql.Int, m.idSucursal)
      .input('tipo', sql.VarChar, m.idTipoMovimiento)
      .query(`UPDATE MovimientosNumeros SET Numero = Numero + 1
              OUTPUT inserted.Numero AS Numero
              WHERE IdSucursal=@sucursal AND IdTipoMovimiento=@tipo`)
    ).recordset[0].Numero;

    await rq()
      .input('sucursal', sql.Int, m.idSucursal)
      .input('tipo', sql.VarChar, m.idTipoMovimiento)
      .input('numero', sql.Int, numero)
      .input('usuario', sql.NVarChar, m.usuario)
      .input('observacion', sql.NVarChar, m.observacion)
      .input('empleado', sql.Int, m.idEmpleado)
      .query(`INSERT INTO MovimientosStock
        (IdSucursal, IdTipoMovimiento, NumeroMovimiento, FechaMovimiento, Neto, Total, PorcentajeIVA,
         Usuario, Observacion, IdEmpleado, PercepcionIVA, PercepcionIB, PercepcionGanancias, PercepcionVarias, ImpuestosInternos)
        VALUES (@sucursal, @tipo, @numero, GETDATE(), 0, 0, 0, @usuario, @observacion, @empleado, 0, 0, 0, 0, 0)`);

    await rq()
      .input('sucursal', sql.Int, m.idSucursal)
      .input('deposito', sql.Int, m.idDeposito)
      .input('ubicacion', sql.Int, m.idUbicacion)
      .input('tipo', sql.VarChar, m.idTipoMovimiento)
      .input('numero', sql.Int, numero)
      .input('producto', sql.VarChar, m.idProducto)
      .input('cantidad', sql.Decimal(18, 4), m.cantidad)
      .query(`INSERT INTO MovimientosStockProductos
        (IdSucursal, IdDeposito, IdUbicacion, IdTipoMovimiento, NumeroMovimiento, IdProducto, Cantidad, Cantidad2, Precio, Orden)
        VALUES (@sucursal, @deposito, @ubicacion, @tipo, @numero, @producto, @cantidad, 0, 0, 1)`);

    await rq()
      .input('sucursal', sql.Int, m.idSucursal)
      .input('deposito', sql.Int, m.idDeposito)
      .input('producto', sql.VarChar, m.idProducto)
      .input('delta', sql.Decimal(18, 4), cantidadStock)
      .query(`IF EXISTS (SELECT 1 FROM ProductosDepositos WHERE IdProducto=@producto AND IdSucursal=@sucursal AND IdDeposito=@deposito)
                UPDATE ProductosDepositos SET Stock = Stock + @delta
                WHERE IdProducto=@producto AND IdSucursal=@sucursal AND IdDeposito=@deposito;
              ELSE
                INSERT INTO ProductosDepositos (IdProducto, IdSucursal, IdDeposito, Stock, Stock2)
                VALUES (@producto, @sucursal, @deposito, @delta, 0);`);

    await rq()
      .input('sucursal', sql.Int, m.idSucursal)
      .input('deposito', sql.Int, m.idDeposito)
      .input('ubicacion', sql.Int, m.idUbicacion)
      .input('producto', sql.VarChar, m.idProducto)
      .input('delta', sql.Decimal(18, 4), cantidadStock)
      .query(`IF EXISTS (SELECT 1 FROM ProductosUbicaciones WHERE IdProducto=@producto AND IdSucursal=@sucursal AND IdDeposito=@deposito AND IdUbicacion=@ubicacion)
                UPDATE ProductosUbicaciones SET Stock = Stock + @delta
                WHERE IdProducto=@producto AND IdSucursal=@sucursal AND IdDeposito=@deposito AND IdUbicacion=@ubicacion;
              ELSE
                INSERT INTO ProductosUbicaciones (IdProducto, IdSucursal, IdDeposito, IdUbicacion, Stock, Stock2)
                VALUES (@producto, @sucursal, @deposito, @ubicacion, @delta, 0);`);

    await tx.commit();
    return numero;
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}

app.post('/api/stock/movimiento', apiRoute(async req => {
  const b = req.body || {};
  const idSucursal      = Number(b.idSucursal);
  const idDeposito       = Number(b.idDeposito);
  const idUbicacion      = Number(b.idUbicacion);
  const idEmpleado       = Number(b.idEmpleado);
  const cantidad         = Number(b.cantidad);
  const idTipoMovimiento = String(b.idTipoMovimiento || '').trim().toUpperCase();
  const idProducto       = String(b.idProducto || '').trim();
  const usuario          = String(b.usuario || '').trim();
  const observacion      = String(b.observacion || '').trim().slice(0, 200);

  if (!TIPOS_MOVIMIENTO_STOCK_PERMITIDOS.includes(idTipoMovimiento)) {
    return { error: `idTipoMovimiento inválido. Permitidos: ${TIPOS_MOVIMIENTO_STOCK_PERMITIDOS.join(', ')}` };
  }
  if (![idSucursal, idDeposito, idUbicacion, idEmpleado].every(n => Number.isInteger(n) && n > 0)) {
    return { error: 'idSucursal, idDeposito, idUbicacion e idEmpleado deben ser enteros positivos' };
  }
  if (!Number.isFinite(cantidad) || cantidad === 0) {
    return { error: 'cantidad debe ser un número distinto de 0' };
  }
  if (!idProducto) return { error: 'Falta idProducto' };
  if (!usuario)    return { error: 'Falta usuario' };

  const poolW = await getPoolStock();
  const numero = await registrarMovimientoStock(poolW, {
    idSucursal, idDeposito, idUbicacion, idEmpleado, cantidad,
    idTipoMovimiento, idProducto, usuario, observacion
  });
  return { ok: true, numeroMovimiento: numero, idTipoMovimiento, idSucursal };
}));

// ── Precios de Proveedores ─────────────────────────────────────────────────────
const PRECIOS_PROV_PATH = path.join(DATA_DIR, 'precios_proveedores.json');
const PRECIOS_PROV_DEF = { toleranciaPct: 2, proveedores: [] };
function leerPreciosProv() { return leerJSON(PRECIOS_PROV_PATH, PRECIOS_PROV_DEF); }
function guardarPreciosProv(d) { guardarJSON(PRECIOS_PROV_PATH, d); }

// Universo paraCompra (EsDeCompras=1, Activo=1) + costo actual de la central + código de barras.
async function universoParaCompra() {
  const rows = await query(`
    SELECT p.IdProducto, p.NombreProducto, p.CodigoDeBarras,
           CAST(ps.PrecioCosto AS FLOAT) AS PrecioCosto
    FROM Productos p
    LEFT JOIN ProductosSucursales ps ON ps.IdProducto = p.IdProducto
      AND ps.IdSucursal = (SELECT MIN(IdSucursal) FROM Sucursales WHERE SoyLaCentral = 1)
    WHERE p.EsDeCompras = 1 AND p.Activo = 1`);
  return rows.map(r => ({
    plu: String(r.IdProducto), nombre: r.NombreProducto,
    barras: String(r.CodigoDeBarras || '').trim(),
    costo: r.PrecioCosto != null ? +r.PrecioCosto : null,
  }));
}

// plu → { proveedor, precio, fecha } del proveedor con última fecha de compra.
async function ultimoProveedorPorProducto() {
  const rows = await query(`
    SELECT pp.IdProducto, pv.NombreProveedor, CAST(pp.UltimoPrecioCompra AS FLOAT) AS Precio,
           CONVERT(varchar(10), pp.UltimaFechaCompra, 23) AS Fecha
    FROM ProductosProveedores pp
    JOIN Proveedores pv ON pv.IdProveedor = pp.IdProveedor
    WHERE pp.UltimaFechaCompra IS NOT NULL
    ORDER BY pp.IdProducto, pp.UltimaFechaCompra DESC`);
  const map = new Map();
  for (const r of rows) {
    const id = String(r.IdProducto);
    if (!map.has(id)) map.set(id, { proveedor: r.NombreProveedor, precio: r.Precio, fecha: r.Fecha });
  }
  return map;
}

// plu → [{proveedor, fecha (última), precio (de la última compra), cantidad (total)}] del año en curso.
// Excluye COTIZACIONCOM/etc.: en SIGA las cotizaciones de compra no llevan NumeroComprobante único
// (mismo IdSucursal/Letra/CentroEmisor/Numero se repite en decenas de cotizaciones distintas), lo que
// multiplicaba el JOIN y devolvía cientos de "proveedores" falsos por producto.
async function historialComprasAnio() {
  const inicio = `${new Date().getFullYear()}-01-01`;
  const rows = await query(`
    SELECT cp.IdProducto, pv.NombreProveedor,
           CONVERT(varchar(10), c.Fecha, 23) AS Fecha,
           CAST(cp.Precio AS FLOAT) AS Precio, CAST(cp.Cantidad AS FLOAT) AS Cantidad
    FROM ComprasProductos cp
    JOIN Compras c ON c.IdSucursal = cp.IdSucursal AND c.IdTipoComprobante = cp.IdTipoComprobante
      AND c.Letra = cp.Letra AND c.CentroEmisor = cp.CentroEmisor AND c.NumeroComprobante = cp.NumeroComprobante
    JOIN Proveedores pv ON pv.IdProveedor = c.IdProveedor
    WHERE c.Fecha >= '${inicio}' AND c.IdTipoComprobante NOT LIKE 'COTIZACION%'
    ORDER BY cp.IdProducto, c.Fecha DESC`);
  const map = new Map();
  for (const r of rows) {
    const id = String(r.IdProducto);
    if (!map.has(id)) map.set(id, new Map());
    const prov = map.get(id);
    if (!prov.has(r.NombreProveedor)) {
      prov.set(r.NombreProveedor, { proveedor: r.NombreProveedor, fecha: r.Fecha, precio: r.Precio, cantidad: r.Cantidad || 0 });
    } else {
      prov.get(r.NombreProveedor).cantidad += r.Cantidad || 0;
    }
  }
  const out = new Map();
  for (const [id, provs] of map) out.set(id, [...provs.values()]);
  return out;
}

app.get('/precios-proveedores', (_req, res) => res.sendFile(path.join(__dirname, 'precios_proveedores.html')));

app.get('/api/precios-proveedores/listado', apiRoute(async () => {
  const [universo, ultimo, historial] = await Promise.all([
    universoParaCompra(), ultimoProveedorPorProducto(), historialComprasAnio(),
  ]);
  const productos = universo.map(p => {
    const u = ultimo.get(p.plu) || {};
    return {
      plu: p.plu, nombre: p.nombre, costo: p.costo,
      ultimoProveedor: u.proveedor || null, ultimoPrecio: u.precio || null, ultimaFecha: u.fecha || null,
      proveedoresAnio: historial.get(p.plu) || [],
    };
  });
  return { productos, total: productos.length, fechaCalculo: new Date().toISOString() };
}));

app.get('/api/precios-proveedores/proveedores', apiRoute(async () => leerPreciosProv()));

app.get('/api/precios-proveedores/proveedores-siga', apiRoute(async (req) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return { proveedores: [] };
  const like = q.replace(/'/g, "''");
  const rows = await query(`SELECT IdProveedor, NombreProveedor FROM Proveedores
    WHERE NombreProveedor LIKE '%${like}%' ORDER BY NombreProveedor`);
  return { proveedores: rows.map(r => ({ idProveedorSiga: Number(r.IdProveedor), nombre: r.NombreProveedor })) };
}));

app.post('/api/precios-proveedores/proveedores', apiRoute(async (req) => {
  const { idProveedorSiga, nombre, url } = req.body || {};
  const idNum = Number(idProveedorSiga);
  if (!Number.isFinite(idNum) || idNum <= 0 || !nombre) throw new Error('Proveedor inválido: falta idProveedorSiga o nombre');
  const data = leerPreciosProv();
  const id = `prov-${idNum}`;
  if (data.proveedores.some(p => p.id === id)) throw new Error('El proveedor ya tiene tab');
  const nuevo = { id, idProveedorSiga: idNum, nombre: String(nombre), url: url ? String(url) : '', listaVigente: null, matcheosManuales: {} };
  guardarPreciosProv({ ...data, proveedores: [...data.proveedores, nuevo] });
  return nuevo;
}));

app.delete('/api/precios-proveedores/proveedores/:id', apiRoute(async (req) => {
  const data = leerPreciosProv();
  const quedan = data.proveedores.filter(p => p.id !== req.params.id);
  if (quedan.length === data.proveedores.length) throw new Error('Proveedor no encontrado');
  guardarPreciosProv({ ...data, proveedores: quedan });
  return { ok: true };
}));

// Contexto para matchearItems: códigos del proveedor en SIGA + barras + catálogo del universo.
async function contextoMatching(idProveedorSiga, matcheosManuales) {
  const universo = await universoParaCompra();
  const catalogo = universo.map(p => ({ plu: p.plu, nombre: p.nombre }));
  const barras = new Map(universo.filter(p => p.barras).map(p => [p.barras, p.plu]));
  const codigosProveedor = new Map();
  const idNum = Number(idProveedorSiga);
  if (Number.isFinite(idNum) && idNum > 0) {
    const rows = await query(`SELECT IdProducto, CodigoProductoProveedor FROM ProductosProveedores
      WHERE IdProveedor = ${idNum} AND LTRIM(RTRIM(ISNULL(CodigoProductoProveedor,''))) <> ''`);
    for (const r of rows) codigosProveedor.set(String(r.CodigoProductoProveedor).trim(), String(r.IdProducto));
  }
  return { matcheosManuales: matcheosManuales || {}, codigosProveedor, barras, catalogo };
}

const IPV4_PRIVADA = /^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^0\.|^169\.254\./;

// "::ffff:7f00:1" (forma que usa el parser URL de Node) → "127.0.0.1", o null si no matchea.
function ipv4DesdeMapeadaV6(h) {
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h);
  if (!m) return null;
  const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

// Solo http/https públicas — bloquea localhost, rangos privados IPv4/IPv6 y metadata de nube (SSRF).
function urlPermitida(u) {
  let parsed;
  try { parsed = new URL(String(u)); } catch { return false; }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  let h = parsed.hostname.toLowerCase();
  if (h === 'localhost') return false;
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1); // literal IPv6
  if (IPV4_PRIVADA.test(h)) return false;
  const v4Mapeada = ipv4DesdeMapeadaV6(h);
  if (v4Mapeada && IPV4_PRIVADA.test(v4Mapeada)) return false;
  if (h === '::1' || h === '::' || /^fe80:/.test(h) || /^f[cd][0-9a-f]{2}:/.test(h)) return false; // loopback/link-local/ULA IPv6
  return true;
}

// fetch con seguimiento manual de redirects, revalidando cada salto contra urlPermitida (evita bypass de SSRF vía 3xx).
async function fetchConRedirectSeguro(url, opts, maxRedirects = 3) {
  let actual = url;
  for (let i = 0; i <= maxRedirects; i++) {
    if (!urlPermitida(actual)) throw new Error('Redirect hacia una URL no permitida');
    const resp = await fetch(actual, { ...opts, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const loc = resp.headers.get('location');
      if (!loc) throw new Error('Redirect sin encabezado Location');
      actual = new URL(loc, actual).toString();
      continue;
    }
    return resp;
  }
  throw new Error('Demasiados redirects');
}

const uploadPreciosPdf = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.post('/api/precios-proveedores/parse-pdf', uploadPreciosPdf.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(422).json({ error: 'Falta el archivo PDF (campo "pdf")' });
    const data = leerPreciosProv();
    const prov = data.proveedores.find(p => p.id === String(req.body.id || ''));
    if (!prov) return res.status(422).json({ error: 'Proveedor no encontrado' });
    let texto = '';
    try { texto = (await pdfParse(req.file.buffer)).text || ''; }
    catch { return res.status(422).json({ error: 'PDF corrupto o ilegible' }); }
    if (!texto.trim()) return res.status(422).json({ error: 'PDF sin texto extraíble (¿escaneado? OCR fuera de alcance)' });
    const { items, descartadas } = preciosProv.parsearTextoPdf(texto);
    if (!items.length) return res.status(422).json({ error: 'No se detectaron líneas con precio en el PDF', descartadas });
    const ctx = await contextoMatching(prov.idProveedorSiga, prov.matcheosManuales);
    res.json({ items: preciosProv.matchearItems(items, ctx), descartadas });
  } catch (err) { console.error(err.message); res.status(500).json({ error: err.message }); }
});

app.post('/api/precios-proveedores/parse-url', async (req, res) => {
  try {
    const { url, id } = req.body || {};
    if (!urlPermitida(url)) return res.status(422).json({ error: 'URL inválida (solo http/https públicas)' });
    const data = leerPreciosProv();
    const prov = data.proveedores.find(p => p.id === String(id || ''));
    if (!prov) return res.status(422).json({ error: 'Proveedor no encontrado' });
    let html = '';
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const resp = await fetchConRedirectSeguro(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (ApideltaSubSystem)' } });
      clearTimeout(t);
      if (!resp.ok) return res.status(422).json({ error: `La página respondió ${resp.status}` });
      html = await resp.text();
    } catch { return res.status(422).json({ error: 'No se pudo acceder a la URL (timeout o red)' }); }
    const { items, descartadas } = preciosProv.parsearHtml(html);
    if (!items.length) return res.status(422).json({ error: 'No se encontraron tablas con precios en la página', descartadas });
    const ctx = await contextoMatching(prov.idProveedorSiga, prov.matcheosManuales);
    res.json({ items: preciosProv.matchearItems(items, ctx), descartadas });
  } catch (err) { console.error(err.message); res.status(500).json({ error: err.message }); }
});

const MATCH_TIPOS_VALIDOS = new Set(['manual', 'codigo', 'barras', 'nombre']);

app.put('/api/precios-proveedores/proveedores/:id/lista', apiRoute(async (req) => {
  const { origen, items, matcheosManuales } = req.body || {};
  if (!['pdf', 'url', 'manual'].includes(origen)) throw new Error('Origen inválido (pdf|url|manual)');
  if (!Array.isArray(items) || !items.length) throw new Error('La lista no tiene items');
  const limpios = items.map(it => {
    const precio = Number(it.precio);
    if (!Number.isFinite(precio) || precio <= 0) throw new Error(`Precio inválido en "${it.descripcion || it.codigoProveedor || '?'}"`);
    if (!it.descripcion) throw new Error('Item sin descripción');
    return {
      codigoProveedor: String(it.codigoProveedor || ''), descripcion: String(it.descripcion),
      precio, plu: it.plu != null && it.plu !== '' ? String(it.plu) : null,
      matchTipo: MATCH_TIPOS_VALIDOS.has(it.matchTipo) ? it.matchTipo : null, matchScore: Number(it.matchScore) || 0,
    };
  });
  const data = leerPreciosProv();
  const i = data.proveedores.findIndex(p => p.id === req.params.id);
  if (i < 0) throw new Error('Proveedor no encontrado');
  const prov = data.proveedores[i];
  const manuales = { ...prov.matcheosManuales };
  if (matcheosManuales && typeof matcheosManuales === 'object') {
    for (const [cod, plu] of Object.entries(matcheosManuales)) if (cod && plu) manuales[String(cod)] = String(plu);
  }
  const actualizado = {
    ...prov, matcheosManuales: manuales,
    listaVigente: { fechaCarga: new Date().toISOString(), origen, items: limpios },
  };
  guardarPreciosProv({ ...data, proveedores: data.proveedores.map((p, j) => (j === i ? actualizado : p)) });
  return actualizado;
}));

app.get('/api/precios-proveedores/proveedores/:id/comparacion', apiRoute(async (req) => {
  const data = leerPreciosProv();
  const prov = data.proveedores.find(p => p.id === req.params.id);
  if (!prov) throw new Error('Proveedor no encontrado');
  if (!prov.listaVigente) return { proveedor: prov.nombre, fechaCarga: null, origen: null, filas: [], sinMatchear: [] };
  const [universo, ultimo] = await Promise.all([universoParaCompra(), ultimoProveedorPorProducto()]);
  const porPlu = new Map(universo.map(p => [p.plu, p]));
  const filas = [], sinMatchear = [];
  for (const it of prov.listaVigente.items) {
    if (!it.plu || !porPlu.has(it.plu)) { sinMatchear.push(it); continue; }
    const p = porPlu.get(it.plu), u = ultimo.get(it.plu) || {};
    const cmp = preciosProv.compararItem({ precioLista: it.precio, costoActual: p.costo, toleranciaPct: data.toleranciaPct });
    filas.push({ ...it, nombreSiga: p.nombre, costoActual: p.costo, ultimoPagado: u.precio || null, ...cmp });
  }
  return { proveedor: prov.nombre, fechaCarga: prov.listaVigente.fechaCarga, origen: prov.listaVigente.origen, filas, sinMatchear };
}));

// ── Inicio ─────────────────────────────────────────────────────────────────────
async function start() {
  console.log('Conectando a SQL Server...');
  try { await getPool(); console.log('  ✓ SQL Server conectado'); }
  catch (err) { console.error('  ✗ Error SQL:', err.message); process.exit(1); }

  app.listen(PORT, '0.0.0.0', () => {
    const env = PORT === 8080 ? 'PRODUCCIÓN' : 'DEV';
    console.log(`\n  ╔══════════════════════════════════════════════╗`);
    console.log(`  ║   ApideltaSubSystem — ${env.padEnd(22)}   ║`);
    console.log(`  ╠══════════════════════════════════════════════╣`);
    console.log(`  ║   /              → Pedidos                   ║`);
    console.log(`  ║   /produccion    → Producción Día            ║`);
    console.log(`  ║   /planificacion → Planificación             ║`);
    console.log(`  ║   /compras → Compras                         ║`);
    console.log(`  ╠══════════════════════════════════════════════╣`);
    console.log(`  ║   http://${HOSTNAME}.local:${PORT}`.padEnd(49) + '║');
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets))
      for (const net of nets[name])
        if (net.family === 'IPv4' && !net.internal)
          console.log(`  ║   http://${net.address}:${PORT}`.padEnd(49) + '║');
    console.log(`  ║   http://localhost:${PORT}`.padEnd(49) + '║');
    console.log(`  ╚══════════════════════════════════════════════╝\n`);

    const shutdown = () => { process.exit(0); };
    process.on('SIGINT',  shutdown);
    process.on('SIGTERM', shutdown);
  });
}

start();
