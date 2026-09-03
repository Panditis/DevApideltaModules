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
const crypto     = require('crypto');

const session  = require('express-session');
const multer   = require('multer');
const XLSX     = require('xlsx');
const auth     = require('./auth');
const compras = require('./compras');
const preciosProv = require('./precios_proveedores');
const preciosFacturador = require('./precios_facturador');
const comprasImport = require('./compras_import');
const pdfParse = require('pdf-parse');
const { calcularFaltantesFraccionado } = require('./fraccionado_faltantes');
const { resolverProductoCarga, analizarNombreCarga, pesoTokenKg, sqlNombresPorPlu } = require('./producto_carga');
const { validarLineasFraccionado, normalizarLineasFraccionado, totalesOrdenFraccionado,
        progresoOrdenFraccionado, marcarLineaOrden, editarLineaOrden, validarLineasNoRepetidas,
        plusEnOrdenesActivas } = require('./ordenes_fraccionado');
const analisisVentas = require('./analisis_ventas');
const productividad = require('./productividad');
const resumenesLegacy = require('./resumenes_legacy');
const historialSala = require('./historial_sala');
const cruceTerminales = require('./cruce_terminales');
const rrhhRopa = require('./rrhh_ropa');
const rrhhAusencias = require('./rrhh_ausencias');
const { migrarReservas, saldoLedger, itemsSinReservar, reservadoPorMovimiento, ordenesDeMovimiento, conciliarPorMovimiento, depositosProduccion, lineasAjusteMovimiento, lineasDiferenciasProduccion, lineasProduccionDesdeConciliacion, terminadosPorPluDeConciliacion, ordenesProducidasDeReserva, motivoBloqueoProduccion, sanearSellosReserva } = require('./reservas_movimiento');
const { validarLineasReserva, normalizarLineasReserva, validarClienteReserva,
        validarCarritoUnCliente, nuevaReserva, anularReserva } = require('./reservas_mercaderia');
const { lineaAApartar, validarLineaPesable, granelReservadoPorPlu,
        partirConsumoMayorista, granelReservadoNeto, restanteMayoristaPorReserva,
        lineasADevolverMayorista, restantePedidoPorReserva, agruparRestante,
        basesEntregaMayorista, imputarEntregaMayorista,
        lineasTerminadoADevolverMayorista, filasSaldoMayorista } = require('./reservas_pesables');

const cfg      = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const PORT     = cfg.puerto   || 8080;
const HOSTNAME = cfg.hostname || 'apidelta';

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

// Un producto puede tener varias fórmulas en ProductosComponentes (columna IdFormula);
// la vigente es Productos.IdFormula. Sin este filtro se mezclan componentes de fórmulas
// viejas (ej. "Formula generico") con los de la activa.
// Fallback: si la fórmula activa no tiene componentes (o IdFormula es NULL) se usa la de
// menor IdFormula, para que ningún producto quede sin fórmula.
const FORMULA_ACTIVA_SQL = `pc.IdFormula = COALESCE(
    (SELECT TOP 1 fa.IdFormula FROM dbo.ProductosComponentes fa
       INNER JOIN dbo.Productos fp ON fp.IdProducto = fa.IdProducto
      WHERE fa.IdProducto = pc.IdProducto AND fa.IdFormula = fp.IdFormula),
    (SELECT MIN(fb.IdFormula) FROM dbo.ProductosComponentes fb WHERE fb.IdProducto = pc.IdProducto))`;

// La regla de fórmula activa escrita sobre otro alias. Se deriva de FORMULA_ACTIVA_SQL en vez
// de reescribirla para que siga habiendo una sola definición: la usa el segundo nivel del BOM.
const formulaActivaPara = alias => FORMULA_ACTIVA_SQL.replace(/\bpc\./g, `${alias}.`);

// "Formula generico" es un placeholder de SIGA, nunca un insumo real: se oculta siempre.
// Asume que el producto componente está aliasado como `p` en la query.
const SIN_FORMULA_GENERICO_SQL = `p.NombreProducto NOT LIKE '%FORMULA GENERICO%'
    AND p.NombreProducto NOT LIKE '%FORMULA GENÉRICO%'`;

// Clasifica un componente de fórmula como envase o tapa mirando su rubro y su nombre.
// Es la única definición de la regla: la usan /api/plan/packaging (para ofrecer el envase
// y la tapa de la fórmula en la planificación) y componentesDePlan (para saber a qué
// componente reemplaza lo elegido en el plan). Devuelve 'tapa' | 'envase' | null.
// La tapa se evalúa primero porque su rubro puede mencionar también el embalaje.
// Un mismo componente puede matchear las dos reglas a la vez (p. ej. "Tapa Grande" con rubro
// "ENVASES"), así que se devuelven ambos flags y cada consumidor decide qué hacer.
function tiposPackaging(nombre, rubro) {
  const ru  = String(rubro || '').toUpperCase();
  const nom = String(nombre || '');
  return {
    esTapa:   ru.includes('TAPA') || /^tapas?\s/i.test(nom),
    esEnvase: ru.includes('EMBALA') || ru.includes('ENVASE') || /^envase\s/i.test(nom)
  };
}
// Tipo único de un componente, con la tapa como prioridad. Lo usa componentesDePlan para
// saber a qué componente de la fórmula reemplaza lo elegido en el plan.
function clasificarPackaging(nombre, rubro) {
  const t = tiposPackaging(nombre, rubro);
  return t.esTapa ? 'tapa' : t.esEnvase ? 'envase' : null;
}

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
// Los pesables suelen tener la fórmula activa en dos niveles: "Adobo Para Pizza 1Kg" no apunta
// al granel sino a "Adobo Para Pizza PEDIDOS" (rubro Producción), y recién ese resuelve a
// "Adobo Para Pizza DEPOSITO GRANEL". Cuando el componente de la fórmula activa es uno de esos
// intermedios se baja un nivel más y se multiplican las cantidades de los dos saltos.
// El intermedio se detecta por nombre de rubro (igual que el resto del archivo con BULTO/CAJA),
// así entran tanto "Produccion" como "Pesables Produccion".
const RUBRO_INTERMEDIO_SQL = `UPPER(COALESCE(rInt.NombreRubro,'')) LIKE '%PRODUCCION%'`;

// BOM de componentes granel según la fórmula activa. El segundo nivel es un fallback: solo se
// usa para los productos que no resuelven granel en el primer nivel (NOT EXISTS), así los que
// ya andaban devuelven exactamente las mismas filas. No hay recursión más allá del segundo
// nivel: si ahí tampoco aparece un granel, el producto queda sin granel.
// Un mismo granel puede llegar por dos intermedios distintos (ej. "Yogurt … c Frutilla 370G"
// usa gelatina vía la mermelada y vía el yogur), así que el segundo nivel agrupa y suma en vez
// de devolver una fila por camino.
// `filtroPadre` acota por PLU y aplica a los dos niveles porque en ambos `pc` es el nivel 1.
function sqlBOMGranel(rubros, filtroPadre = '') {
  return `SELECT pc.IdProducto, pc.IdProductoComponente, p.NombreProducto AS NombreComponente,
       p.IdRubro AS RubroComponente, pc.Cantidad AS CantPorUnidad
FROM ProductosComponentes pc INNER JOIN Productos p ON p.IdProducto=pc.IdProductoComponente
WHERE p.IdRubro IN (${rubros}) AND ${FORMULA_ACTIVA_SQL} AND ${SIN_FORMULA_GENERICO_SQL}${filtroPadre}
UNION ALL
SELECT pc.IdProducto, pc2.IdProductoComponente, p.NombreProducto AS NombreComponente,
       p.IdRubro AS RubroComponente,
       CAST(SUM(pc.Cantidad * pc2.Cantidad) AS DECIMAL(18,6)) AS CantPorUnidad
FROM ProductosComponentes pc
INNER JOIN Productos pInt ON pInt.IdProducto=pc.IdProductoComponente
LEFT  JOIN Rubros    rInt ON rInt.IdRubro=pInt.IdRubro
INNER JOIN ProductosComponentes pc2 ON pc2.IdProducto=pc.IdProductoComponente
INNER JOIN Productos p ON p.IdProducto=pc2.IdProductoComponente
WHERE ${RUBRO_INTERMEDIO_SQL} AND ${FORMULA_ACTIVA_SQL} AND ${formulaActivaPara('pc2')}
  AND p.IdRubro IN (${rubros}) AND ${SIN_FORMULA_GENERICO_SQL}${filtroPadre}
  AND NOT EXISTS (SELECT 1 FROM ProductosComponentes n1
                  INNER JOIN Productos np ON np.IdProducto=n1.IdProductoComponente
                  WHERE n1.IdProducto=pc.IdProducto AND np.IdRubro IN (${rubros})
                    AND ${formulaActivaPara('n1')})
GROUP BY pc.IdProducto, pc2.IdProductoComponente, p.NombreProducto, p.IdRubro`;
}

// Un escalón más abajo cuando el "granel" que resolvió sqlBOMGranel es en realidad una
// PRESENTACIÓN FRACCIONADA.
//
// `rubrosGranel` de config.json trae los dos rubros pesables juntos (el depósito y el
// fraccionado), así que un bulto cuya fórmula activa baja a una presentación —"Mani Casc 200G
// Bulto" → "Mani Casc 200G"— resuelve ahí y corta: la rama de dos niveles de sqlBOMGranel no
// llega a mirarlo porque su NOT EXISTS ve que el primer nivel ya dio un rubro granel.
// Resultado: la reserva apartaba la presentación fraccionada en vez del granel.
//
// Estos bultos son presentaciones especiales para mayorista y su cadena real es
// bulto fraccionado → presentación fraccionada → granel, sin el "X Pedido" del medio.
// Se consulta a partir de la lista de presentaciones YA resueltas (`pc.IdProducto IN (...)`, que
// es el índice de la tabla) y no bajando dos niveles desde el bulto: la versión con dos JOIN
// sobre ProductosComponentes más las subconsultas de fórmula activa no terminaba nunca.
// @param {Array<string>} presentaciones PLU de las presentaciones fraccionadas a resolver
function sqlGranelBajoFraccionado(rubros, presentaciones) {
  return `SELECT CAST(pc.IdProducto AS VARCHAR)          AS IdPresentacion,
       CAST(pc.IdProductoComponente AS VARCHAR)          AS IdGranel,
       p.NombreProducto                                  AS NombreGranel,
       pc.Cantidad                                       AS CantPorUnidad
FROM ProductosComponentes pc
INNER JOIN Productos p ON p.IdProducto = pc.IdProductoComponente
LEFT  JOIN Rubros    r ON r.IdRubro = p.IdRubro
WHERE pc.IdProducto IN (${presentaciones.map(x => `'${x}'`).join(',')})
  AND p.IdRubro IN (${rubros})
  AND UPPER(COALESCE(r.NombreRubro,'')) NOT LIKE '%FRACCIONAD%'
  AND ${FORMULA_ACTIVA_SQL} AND ${SIN_FORMULA_GENERICO_SQL}`;
}

// El intermedio "X Pedido" de un pesable: el componente de rubro PRODUCCION que baja al granel.
// Es el `pluCarga` del trío pedido→carga→granel.
//
// NO sale de ComponentePrimario: ese CTE exige que el rubro del PADRE sea BULTO o CAJA, y un
// pesable de venta directa (rubro "Pesables Venta Directa", ej. "Azucar Impalpable 5Kg") no
// entra. Como el granel sí resolvía por otro camino, el front marcaba la línea como pesable con
// el producto de carga en blanco y el POST de reserva la rechazaba con 400.
//
// Se resuelve acá y no dentro de sqlBOMGranel a propósito: la rama de dos niveles de esa query
// AGRUPA Y SUMA los caminos que llegan al mismo granel (ver su comentario), así que meter el
// intermedio en su GROUP BY partiría esa suma y cambiaría los kg por unidad.
// Devuelve también el granel al que baja, para poder quedarse sólo con el intermedio que lleva
// al granel que efectivamente se eligió.
function sqlIntermedioGranel(filtroPadre = '') {
  return `SELECT CAST(pc.IdProducto AS VARCHAR)            AS IdProducto,
       CAST(pc.IdProductoComponente AS VARCHAR)            AS IdIntermedio,
       p.NombreProducto                                    AS NombreIntermedio,
       CAST(pc2.IdProductoComponente AS VARCHAR)           AS IdGranel
FROM ProductosComponentes pc
INNER JOIN Productos p    ON p.IdProducto = pc.IdProductoComponente
LEFT  JOIN Rubros    rInt ON rInt.IdRubro = p.IdRubro
INNER JOIN ProductosComponentes pc2 ON pc2.IdProducto = pc.IdProductoComponente
WHERE ${RUBRO_INTERMEDIO_SQL} AND ${FORMULA_ACTIVA_SQL} AND ${formulaActivaPara('pc2')}
  AND ${SIN_FORMULA_GENERICO_SQL}${filtroPadre}`;
}

function sqlStockPorPlu(pluList) {
  // IdProducto es char en Siga: se cita igual que en sqlStockDistribucion. Sin comillas,
  // un PLU no numérico fuerza la conversión de la columna y rompe la query entera; y acá
  // entran tanto el universo de compras de un proveedor como los ids de /api/stock/plus.
  const inList = pluList.map(p => `'${String(p).replace(/'/g, "''")}'`).join(',');
  return `SELECT pd.IdProducto, COALESCE(SUM(pd.Stock),0) AS StockActual FROM ProductosDepositos pd
INNER JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal
INNER JOIN Sucursales s ON s.IdSucursal=pd.IdSucursal
WHERE s.SoyLaCentral=1 AND sd.DisponibleVenta=1 AND pd.IdProducto IN (${inList}) GROUP BY pd.IdProducto`;
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
// Redes admitidas: loopback, LAN privada y la tailnet de Tailscale.
// El rango de Tailscale es CGNAT 100.64.0.0/10, o sea 100.64.x.x a 100.127.x.x: se acota
// con esa forma a propósito, porque "100." a secas dejaría entrar direcciones públicas
// ruteables como 100.20.x.x. Los nodos de la tailnet ya vienen autenticados por Tailscale.
const REDES_PERMITIDAS = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|fd7a:115c:a1e0[:.])/i;
app.use((req, res, next) => {
  const clean = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!REDES_PERMITIDAS.test(clean) && clean !== '::1') {
    console.warn(`[bloqueado] ${clean}`); return res.status(403).send('Acceso restringido.');
  }
  next();
});
app.use((req, _res, next) => { console.log(`${new Date().toLocaleTimeString('es-AR')}  ${req.method} ${req.path}`); next(); });

// ── Autenticación ────────────────────────────────────────────────────────────────
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 }, // 8 h
}));

// Rutas siempre públicas (login, favicons, health, whoami).
const AUTH_PUBLIC = new Set([
  '/login', '/api/login', '/api/session',
  '/favicon.png', '/favicon.ico', '/favicon.svg', '/api/health',
]);
function authDenegar(req, res, code) {
  if (req.path.startsWith('/api/')) {
    return res.status(code).json({ error: code === 401 ? 'No autenticado' : 'Sin permiso' });
  }
  if (code === 401) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl || req.path));
  return res.redirect('/?error=permiso'); // 403 → al hub con aviso de sin permiso
}
app.use((req, res, next) => {
  if (AUTH_PUBLIC.has(req.path)) return next();
  const user = req.session && req.session.user;
  const ref = auth.moduloDeRuta(req.path);
  if (ref) {
    const mod = auth.moduloEstado(ref);
    if (mod && mod.soloAdmin) {
      if (!user) return authDenegar(req, res, 401);
      if (!user.esAdmin) return authDenegar(req, res, 403);
      return next();
    }
    if (mod && mod.activo === false) {
      if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Módulo no disponible' });
      return res.redirect('/');
    }
    if (mod && mod.requiereAuth === false) return next(); // módulo público
    if (!user) return authDenegar(req, res, 401);
    if (!auth.puedeAcceder(user, ref)) return authDenegar(req, res, 403);
    return next();
  }
  // Rutas sin módulo asociado (hub, endpoints compartidos): públicas.
  // El login se exige sólo al entrar a un módulo marcado con requiereAuth.
  return next();
});

// ── Rutas HTML ─────────────────────────────────────────────────────────────────
app.get('/favicon.png',   (_req, res) => res.sendFile(path.join(__dirname, 'favicon.png')));
app.get('/favicon.ico',   (_req, res) => res.redirect('/favicon.png'));
app.get('/',              (_req, res) => res.sendFile(path.join(__dirname, 'inicio.html')));
app.get('/pedidos',       (_req, res) => res.sendFile(path.join(__dirname, 'pedidos_web.html')));
app.get('/planificacion', (_req, res) => res.sendFile(path.join(__dirname, 'planificacion.html')));
app.get('/insumos',       (_req, res) => res.sendFile(path.join(__dirname, 'insumos.html')));
// El cálculo de la agenda de bloques corre igual en el server (validación) y en el browser
// (recálculo en vivo). El proyecto no usa express.static: el asset lleva su propia ruta.
app.get('/bloques_tareas.js', (_req, res) => res.sendFile(path.join(__dirname, 'bloques_tareas.js')));
app.get('/diagnostico-quiebre', (_req, res) => res.sendFile(path.join(__dirname, 'diagnostico_quiebre.html')));

// ── Persistencia JSON ──────────────────────────────────────────────────────────
const DATA_DIR       = path.join(__dirname, 'data');
const ORDENES_PATH   = path.join(DATA_DIR, 'ordenes.json');
const REGISTROS_PATH = path.join(DATA_DIR, 'registros.json');
const PLANES_PATH    = path.join(DATA_DIR, 'planes.json');
const CATALOGO_PATH  = path.join(DATA_DIR, 'catalogo.json');
const GRUPOS_CFG_PATH = path.join(DATA_DIR, 'grupos_config.json');
// cfg entry puede ser: true|false  o  {activo:bool, granelPlu:string, mpManual:[], granelDirecto:bool}
function cfgActivo(cfg, ref) { const v=cfg[ref]; if(v===undefined)return true; if(typeof v==='boolean')return v; return v.activo!==false; }
function cfgGranelPlu(cfg, ref) { const v=cfg[ref]; return (v&&typeof v==='object')?String(v.granelPlu||'').trim():''; }
// Un grupo puede tener varios graneles (uno por variedad de masa). granelPlu queda como el
// primero de la lista para el resto del sistema, que trabaja con un único granel por grupo.
function cfgGranelPlus(cfg, ref) {
  const v = cfg[ref];
  if (!v || typeof v !== 'object') return [];
  const arr = Array.isArray(v.granelPlus) ? v.granelPlus : [];
  const lista = arr.map(x => String(x || '').trim()).filter(Boolean);
  const uno = String(v.granelPlu || '').trim();
  return lista.length ? lista : (uno ? [uno] : []);
}
// Override por grupo del modo "producir como granel". null = sin override (usa default de config.json gruposGranel).
function cfgGranelOverride(cfg, ref) { const v=cfg[ref]; return (v&&typeof v==='object'&&typeof v.granelDirecto==='boolean')?v.granelDirecto:null; }
function cfgEsGranel(cfg, ref, defaultList) { const o=cfgGranelOverride(cfg, ref); return o!==null?o:(defaultList||[]).includes(ref); }
function cfgMpManual(cfg, ref)  { const v=cfg[ref]; return (v&&typeof v==='object'&&Array.isArray(v.mpManual))?v.mpManual:[]; }
// Override por grupo de "es variedad de miel" (habilita tambor + sección Mieles). null = sin override.
function cfgEsMiel(cfg, ref)    { const v=cfg[ref]; return (v&&typeof v==='object'&&typeof v.esMiel==='boolean')?v.esMiel:null; }
// El grupo se hace en presentaciones pero antes hay que fabricar el granel (ej. pepas → masa).
function cfgReqGranel(cfg, ref) { const v=cfg[ref]; return !!(v&&typeof v==='object'&&v.reqGranel===true); }
// Serie mensual de consumo (24 meses) para la predicción de compra. Se recalcula
// bajo demanda: es una consulta pesada y el dato cambia una vez por día como mucho.
const CONSUMO_MENSUAL_PATH = path.join(DATA_DIR, 'consumo_mensual.json');

// Foto de los promedios de sala sobre el archivo entero. Es la vara contra la que los gráficos
// del historial comparan lo que se está mirando, así que se guarda y sólo cambia cuando se pide
// recalcularla: si se recalculara sola, la referencia se movería junto con lo medido.
const REF_SALA_PATH = path.join(DATA_DIR, 'referencia_sala.json');
// Misma foto, pero de la sala de producción medida con los registros nuevos: son dos archivos
// distintos y cada tablero compara contra el suyo.
const REF_PROD_PATH = path.join(DATA_DIR, 'referencia_produccion.json');

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
// El resumen alimenta la tabla con el boton de reserva. Ademas del componente de un nivel
// (que usa el Almacen Bulto/Caja de venta directa), se anexa el granel resuelto a dos niveles:
// es lo unico con stock real en un pesable, y es lo que hay que apartar.
app.get('/api/resumen', apiRoute(async req => {
  const p = params(req);
  const filas = await getResumen(p.desde, p.hasta, p.localidades, p.clientes, p.pedidos, p.estados);
  if (!filas.length) return filas;
  const bom = await bomGranelPorPlu(filas.map(f => f.IdProducto));
  return filas.map(f => {
    const g = bom.get(String(f.IdProducto));
    if (!g) return f;
    // CargaPlu es el intermedio "X Pedido". Se publica aparte de IdComponente (que sale del CTE
    // ComponentePrimario, ciego a los pesables de venta directa por su filtro BULTO/CAJA): sin
    // él, el front armaba una línea pesable sin producto de carga.
    // Lo que se aparta es el granel REAL. Cuando la fórmula del bulto baja a una presentación
    // fraccionada ("Mani Casc 200G Bulto" → "Mani Casc 200G" → "Mani Casc DEPOSITO GRANEL"), el
    // granel es el del final de la cadena y la presentación pasa a ser el producto de carga: es
    // el equivalente del "X Pedido" para estas presentaciones especiales de mayorista.
    // Reservar la presentación apartaba un producto fraccionado que la sala todavía no armó.
    const bajaAFraccionado = !!g.granelRealPlu;
    // GranelCount: con más de un granel la fórmula es una receta y el producto se reserva
    // entero, por su propio código, en vez de apartar uno solo de sus ingredientes.
    return { ...f,
             GranelPlu:    bajaAFraccionado ? g.granelRealPlu    : g.granelPlu,
             GranelNombre: bajaAFraccionado ? g.granelRealNombre : g.granelNombre,
             KgPorUnidad:  bajaAFraccionado ? g.cantPorUnidadReal : g.cantPorUnidad,
             CargaPlu:     bajaAFraccionado ? g.granelPlu    : (g.cargaPlu || ''),
             CargaNombre:  bajaAFraccionado ? g.granelNombre : (g.cargaNombre || ''),
             GranelCount: g.granelCount || 1 };
  });
}));

// ── Mayoristas: órdenes de fraccionado ─────────────────────────────────────────
// Detecta productos con faltante de stock fraccionado que sí tienen granel disponible.
// Los pendientes salen de getResumen (por cliente+producto, mismos filtros que la tab),
// el granel de sqlBOMGranel (fórmula activa, dos niveles) y el stock de los depósitos GRANEL
// de la central. El cálculo en sí vive en fraccionado_faltantes.js (puro, testeado).

// Resuelve, para un conjunto de PLU de bultos mayoristas, cual es su granel y cuantos kg de
// ese granel consume una unidad del bulto. sqlBOMGranel baja dos niveles, asi que sirve tanto
// para el Almacen Bulto/Caja de venta directa como para el pesable, que pasa por el intermedio
// "X Pedido". Un producto puede devolver mas de un granel: se toma el de mayor CantPorUnidad,
// que es el ingrediente principal (el resto son trazas).
// @param {Array<string>} plus PLU de los bultos
// @returns {Promise<Map<string, {granelPlu:string, granelNombre:string, cantPorUnidad:number,
//   granelCount:number, cargaPlu:string, cargaNombre:string}>>} cargaPlu es el intermedio
//   "X Pedido" y queda en '' cuando el granel cuelga directo del padre; granelCount dice cuántos
//   graneles distintos tiene la fórmula (más de uno = receta, no se descompone)
async function bomGranelPorPlu(plus) {
  const lista = [...new Set((plus || []).map(String))].filter(p => /^\d+$/.test(p));
  const mapa = new Map();
  if (!lista.length) return mapa;

  // Se relee config.json por request igual que /api/stock/granel y /api/bom, los otros
  // consumidores de rubrosGranel: asi editar la config no deja este helper desalineado con
  // ellos hasta el proximo reinicio.
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  const filtroPadre = ` AND pc.IdProducto IN (${lista.map(p => `'${p}'`).join(',')})`;
  const filas = await query(sqlBOMGranel(c.rubrosGranel.join(','), filtroPadre));

  // Cuántos graneles DISTINTOS tiene cada producto. Con más de uno la fórmula es una receta
  // (ej. 7477 "G. Crunch", 17 graneles) y quedarse con el mayor —que es lo que hace el mapa de
  // abajo— apartaría avena por una granola. Quien reserva necesita saberlo para no descomponer
  // el producto; los otros consumidores del mapa siguen recibiendo lo mismo que antes.
  const granelesPorPlu = new Map();
  for (const b of filas) {
    const plu = String(b.IdProducto);
    if (!granelesPorPlu.has(plu)) granelesPorPlu.set(plu, new Set());
    granelesPorPlu.get(plu).add(String(b.IdProductoComponente));
  }
  for (const b of filas) {
    const plu = String(b.IdProducto);
    const cand = {
      granelPlu: String(b.IdProductoComponente),
      granelNombre: b.NombreComponente || '',
      cantPorUnidad: Number(b.CantPorUnidad) || 0,
      granelCount: granelesPorPlu.get(plu).size,
      // Para saber si lo que ganó es una presentación fraccionada (y hay que bajar un nivel más).
      granelRubro: Number(b.RubroComponente) || 0,
      // El intermedio se completa abajo: se elige DESPUÉS de saber qué granel gana, porque un
      // producto puede tener varios y sólo sirve el que baja a ese granel.
      cargaPlu: '', cargaNombre: '',
    };
    const prev = mapa.get(plu);
    if (!prev || cand.cantPorUnidad > prev.cantPorUnidad) mapa.set(plu, cand);
  }

  // Los bultos cuya fórmula activa baja a una PRESENTACIÓN fraccionada y de ahí al granel. Se
  // agregan como campos aparte (granelRealPlu…) en vez de pisar granelPlu: el detector de
  // faltantes de fraccionado usa este mismo mapa y espera la presentación, que es contra lo que
  // compara su stock. Quien reserva usa el real, que es lo que hay que apartar.
  //
  // Sin ningún granel resuelto no hay nada más que consultar: se corta antes de las dos queries
  // que siguen.
  if (!mapa.size) return mapa;

  // Cuáles de los rubros granel son "fraccionado": config los trae juntos (el depósito y el
  // fraccionado) y sólo el segundo tiene un granel debajo. Se mira el nombre, igual que el resto
  // del archivo con BULTO/CAJA y PRODUCCION.
  const rubrosFrac = new Set((await query(
    `SELECT IdRubro FROM Rubros WHERE IdRubro IN (${c.rubrosGranel.join(',')})
       AND UPPER(COALESCE(NombreRubro,'')) LIKE '%FRACCIONAD%'`)).map(r => Number(r.IdRubro)));
  const presentaciones = [...new Set([...mapa.values()]
    .filter(e => rubrosFrac.has(e.granelRubro)).map(e => e.granelPlu))]
    .filter(p => /^\d+$/.test(p));
  if (presentaciones.length) {
    const bajo = new Map();
    for (const r of await query(sqlGranelBajoFraccionado(c.rubrosGranel.join(','), presentaciones))) {
      // Con varios candidatos gana el de mayor cantidad, mismo criterio que el mapa de arriba.
      const k = String(r.IdPresentacion), cant = Number(r.CantPorUnidad) || 0;
      const prev = bajo.get(k);
      if (!prev || cant > prev.cant) bajo.set(k, { plu: String(r.IdGranel), nombre: r.NombreGranel || '', cant });
    }
    for (const e of mapa.values()) {
      const b = bajo.get(e.granelPlu);
      if (!b) continue;
      e.granelRealPlu = b.plu;
      e.granelRealNombre = b.nombre;
      // Los dos saltos se multiplican: bulto→presentación por presentación→granel.
      e.cantPorUnidadReal = redondear4(e.cantPorUnidad * b.cant);
    }
  }

  // El intermedio "X Pedido" que hace de puente hasta el granel elegido. Va en su propia
  // consulta (ver sqlIntermedioGranel) y NO sale de ComponentePrimario, que se saltea los
  // pesables de venta directa por su filtro de rubro BULTO/CAJA.
  // Sin esto el front marcaba la línea como pesable con el producto de carga vacío y el POST de
  // reserva la rechazaba con 400 ("La linea pesable no tiene el producto de carga").
  for (const r of await query(sqlIntermedioGranel(filtroPadre))) {
    const e = mapa.get(String(r.IdProducto));
    // Sólo el intermedio que lleva al granel que ganó: atar otro sería apartar kg de un granel
    // y comprometer unidades de un pedido que no lo consume.
    if (!e || e.cargaPlu || String(r.IdGranel) !== e.granelPlu) continue;
    e.cargaPlu = String(r.IdIntermedio);
    e.cargaNombre = r.NombreIntermedio || '';
  }
  return mapa;
}

// ── Reservas de mercaderia mayorista ──────────────────────────────────────────
// Apartan producto TERMINADO en SiGA para un cliente: un movimiento del deposito principal al
// de reserva. A diferencia de la reserva de planificacion NO se explota formula. Una reserva
// es de UN cliente y sale en UN movimiento: por eso no existe la falla parcial.
const RESERVAS_MERC_PATH = path.join(DATA_DIR, 'reservas_mercaderia.json');

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
// Nombre de producto tal cual SiGA, por PLU. Los CSV de produccion salian con el nombre que
// se tipeo al cargar la orden ("tutuca maiz"), que no siempre coincide con el del sistema.
app.get('/api/productos/nombres', apiRoute(async req => {
  const sql = sqlNombresPorPlu(String(req.query.plus || '').split(','));
  if (!sql) return {};
  const rows = await query(sql);
  return Object.fromEntries(rows.map(r => [String(r.IdProducto), r.NombreProducto]));
}));
app.get('/api/productos/buscar', apiRoute(async req => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return [];
  const words = q.split(/\s+/).filter(w => w.length > 0).map(w => w.replace(/'/g, "''"));
  const nameConditions = words.map(w => `NombreProducto LIKE '%${w}%'`).join(' AND ');
  const nameCond  = words.map(w => `p.NombreProducto LIKE '%${w}%'`).join(' AND ');
  const codeMatch = words.length === 1 ? `OR p.IdProducto LIKE '%${words[0]}%'` : '';
  // excluirRubros: nombres de rubro separados por coma que NO se quieren en el resultado (la
  // carga manual de producción no produce bultos ni cajas: son reempaques de un terminado).
  // Es opcional para no cambiarle el universo al armado de grupos del módulo de análisis.
  const excluidos = String(req.query.excluirRubros || '').split(',').map(s => s.trim()).filter(Boolean);
  const filtroRubro = excluidos.length
    ? `AND COALESCE(r.NombreRubro,'') NOT IN (${excluidos.map(n => `'${n.replace(/'/g, "''")}'`).join(',')})`
    : '';
  // excluirMarcas: igual que excluirRubros pero por marca (la carga manual de producción no
  // trabaja lo de Administración: son artículos de pedidos/reventa, no producidos acá).
  const marcasFuera = String(req.query.excluirMarcas || '').split(',').map(s => s.trim()).filter(Boolean);
  const filtroMarca = marcasFuera.length
    ? `AND COALESCE(m.NombreMarca,'') NOT IN (${marcasFuera.map(n => `'${n.replace(/'/g, "''")}'`).join(',')})`
    : '';
  // SAVONA son productos especiales: pasan por encima de cualquier exclusión de rubro o marca.
  const esSavona = `p.NombreProducto LIKE 'SAVONA%'`;
  const filtros = [filtroRubro, filtroMarca].filter(Boolean).map(f => f.replace(/^AND /, '')).join(' AND ');
  const exclusiones = filtros ? `AND (${esSavona} OR (${filtros}))` : '';
  // Los que empiezan con lo buscado van primero: con un tope chico ("SAVONA…") quedaban afuera
  // del TOP a favor de nombres que sólo contienen el término en el medio.
  const prefijo = `'${words[0]}%'`;
  return await query(`SELECT TOP 40 p.IdProducto AS codigo, p.NombreProducto AS nombre, COALESCE(r.NombreRubro,'') AS rubro
    FROM dbo.Productos p
    LEFT JOIN dbo.Rubros r ON r.IdRubro = p.IdRubro
    LEFT JOIN dbo.Marcas m ON m.IdMarca = p.IdMarca
    WHERE ((${nameCond}) ${codeMatch}) AND p.Activo = 1 ${exclusiones}
    ORDER BY CASE WHEN ${esSavona} THEN 0 WHEN p.NombreProducto LIKE ${prefijo} THEN 1 ELSE 2 END, p.NombreProducto`);
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
           COALESCE(r.NombreRubro,'') AS Rubro,
           pc.Cantidad AS CantPorUnidad,
           CAST(pc.Cantidad * ${cantidad} AS DECIMAL(18,3)) AS CantTotal,
           COALESCE(p.IdUnidadDeMedida,'') AS Unidad,
           COALESCE((SELECT SUM(pd2.Stock) FROM dbo.ProductosDepositos pd2 JOIN dbo.SucursalesDepositos sd2 ON sd2.IdDeposito=pd2.IdDeposito AND sd2.IdSucursal=pd2.IdSucursal WHERE pd2.IdProducto=pc.IdProductoComponente AND UPPER(sd2.NombreDeposito) LIKE '%GRANEL%'),0) AS StockGranel,
           COALESCE((SELECT SUM(pd3.Stock) FROM dbo.ProductosDepositos pd3 WHERE pd3.IdProducto=pc.IdProductoComponente),0) AS StockTotal
    FROM dbo.ProductosComponentes pc JOIN dbo.Productos p ON p.IdProducto=pc.IdProductoComponente
    LEFT JOIN dbo.Rubros r ON r.IdRubro=p.IdRubro
    WHERE pc.IdProducto='${safeId}' AND ${FORMULA_ACTIVA_SQL} AND ${SIN_FORMULA_GENERICO_SQL}
    ORDER BY p.NombreProducto`);
  return { producto: nombre, idProducto: idProd, cantidad, componentes: rows };
}));

// ── Rutas API órdenes ──────────────────────────────────────────────────────────
// Un movimiento de reserva está "sin conciliar" mientras su entrada del ledger siga activa y
// no tenga ajuste.conciliado. La orden queda marcada si alguno de sus movimientos lo está.
app.get('/api/ordenes',        (_req, res) => {
  const sinConciliarPorFecha = new Map();
  const movsSinConciliar = fecha => {
    if (!fecha) return new Set();
    if (!sinConciliarPorFecha.has(fecha)) {
      const { plan } = leerPlanReservas(fecha);
      const set = new Set((plan && plan.reservas || [])
        .filter(rr => rr && rr.estado === 'activa' && !(rr.ajuste && rr.ajuste.conciliado))
        .map(rr => rr.numeroMovimiento).filter(n => n != null));
      sinConciliarPorFecha.set(fecha, set);
    }
    return sinConciliarPorFecha.get(fecha);
  };
  const ordenes = leerOrdenes().map(o => ({
    ...o,
    sinConciliar: (o.reservaMovimientos || []).some(n => movsSinConciliar(o.fecha).has(n)),
  }));
  res.json(ordenes);
});
app.post('/api/ordenes',       (req, res)  => { const o = req.body; if (!o || !o.id) return res.status(400).json({ error: 'Falta orden' }); const arr = leerOrdenes().filter(x => x.id !== o.id); arr.push(o); guardarOrdenes(arr); res.json(o); });
app.put('/api/ordenes/:id',    (req, res)  => { const id = parseInt(req.params.id), arr = leerOrdenes(), idx = arr.findIndex(o => o.id === id); if (idx < 0) return res.status(404).json({ error: 'No encontrado' }); arr[idx] = { ...arr[idx], ...req.body }; guardarOrdenes(arr); res.json(arr[idx]); });
// Borrar una orden con reserva activa dejaría mercadería apartada en SiGA sin dueño: se corta
// con 409 y se pide anular la reserva primero (mismo criterio que DELETE /api/plan/:fecha/item).
app.delete('/api/ordenes/:id', (req, res) => {
  const id  = parseInt(req.params.id);
  const arr = leerOrdenes();
  const orden = arr.find(o => o.id === id);
  const reservas = orden ? reservasActivasDeOrden(orden) : [];
  if (reservas.length) {
    return res.status(409).json({
      error: `La orden tiene reserva activa (movimiento${reservas.length > 1 ? 's' : ''} #${reservas.join(', #')}) `
           + 'y no se puede eliminar. Anulá o devolvé esa reserva primero.',
      reservas
    });
  }
  guardarOrdenes(arr.filter(o => o.id !== id));
  res.json({ ok: true });
});

// "Limpiar todo" conserva las órdenes con reserva activa y avisa cuántas quedaron, en vez de
// fallar entero: el resto del día sí se puede limpiar.
app.delete('/api/ordenes', (_req, res) => {
  const arr = leerOrdenes();
  const cache = new Map();
  const conservar = arr.filter(o => reservasActivasDeOrden(o, cache).length > 0);
  guardarOrdenes(conservar);
  res.json({
    ok: true, conservadas: conservar.length, eliminadas: arr.length - conservar.length,
    ...(conservar.length ? { aviso: `Se conservaron ${conservar.length} orden(es) con reserva activa: `
                                  + 'anulá o devolvé su reserva para poder eliminarlas.' } : {})
  });
});

// Arma los snapshots de cierre (uno por día presente en las cargas) y los deja al frente de
// registros.json, que es lo que lista el Historial. Lo usan los DOS caminos que cierran
// producción —el botón "Cerrar día" y la conciliación— para que el resultado sea idéntico.
// Guarda SÓLO los productos cargados: las órdenes no se archivan, viven en ordenes.json.
// No limpia nada: de eso se encarga quien llama, que sabe qué corresponde drenar.
function crearSnapshotsCierre(cargasACerrar) {
  const ahora = new Date().toISOString();
  const fechas = [...new Set(cargasACerrar.map(c => c.fecha))];
  const arr = leerRegistros();
  const creados = [];
  fechas.sort().forEach((fecha, i) => {
    const registro = { id: Date.now() + i, fecha, fechaHora: ahora, cargas: cargasACerrar.filter(c => c.fecha === fecha) };
    arr.unshift(registro);
    creados.push(registro);
  });
  guardarRegistros(arr);
  return creados;
}

app.get('/api/registros',  (_req, res) => res.json(leerRegistros()));
app.post('/api/registros', (req, res)  => {
  const ordenes = leerOrdenes();
  const todasCargas = leerJSON(PROD_REG_PATH, []);
  // ?fecha=YYYY-MM-DD archiva un solo día ("sin-fecha" = cargas sin fecha); sin el parámetro
  // se archiva todo, que es lo que hace el botón "Cerrar día".
  const fecha = req.query.fecha;
  const esDelDia = c => fecha === 'sin-fecha' ? !c.fecha : c.fecha === fecha;
  const cargas = fecha ? todasCargas.filter(esDelDia) : todasCargas;
  // El historial guarda productos: sin cargas no hay nada que archivar.
  if (!cargas.length) return res.status(400).json({ error: fecha ? 'No hay producción cargada para ese día' : 'No hay producción cargada para registrar' });
  const creados = crearSnapshotsCierre(cargas);
  if (req.query.limpiar === '1') {
    // Quitar las órdenes completadas; las pendientes siguen en ordenes.json. Drenar las cargas archivadas.
    if (fecha) {
      const idsDia = new Set(cargas.map(c => String(c.ordenId)));
      guardarOrdenes(ordenes.filter(o => !(o.estado === 'listo' && idsDia.has(String(o.id)))));
      guardarJSON(PROD_REG_PATH, todasCargas.filter(c => !esDelDia(c)));
    } else {
      guardarOrdenes(ordenes.filter(o => o.estado !== 'listo'));
      guardarJSON(PROD_REG_PATH, []);
    }
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


// Estos const quedan acá (no viajan enteros a rutas_distribucion.js) porque otros routers
// también los reciben por deps: PESABLES_LISTAS_PATH/sqlStockDistribucion/DISTRIB_CONFIG_PATH/
// A8020_CALC_PATH/_ventasJoin los usa además rutas_compras.js, y FRAC_REG_PATH/HISTORIAL_PATH
// además rutas_productividad.js (se registran ambos routers más abajo).
const PESABLES_LISTAS_PATH = path.join(DATA_DIR, 'pesables_listas.json');
function sqlStockDistribucion(plus) {
  const inList = plus.map(p => `'${p}'`).join(',');   // IdProducto es varchar en Siga → citar
  return `SELECT pd.IdSucursal, pd.IdProducto, COALESCE(SUM(pd.Stock),0) AS Stock
FROM ProductosDepositos pd
INNER JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal
WHERE sd.DisponibleVenta=1 AND pd.IdProducto IN (${inList})
GROUP BY pd.IdSucursal, pd.IdProducto`;
}
// ── Módulo Compras: pedidos en disco ─────────────────────────────────────────
// Las rutas del módulo viven en rutas_compras.js (se registran más abajo). Estos
// helpers quedan acá porque el control de compras también lee pedidos_compra.json;
// el router los recibe por deps.
const PEDIDOS_COMPRA_PATH = path.join(DATA_DIR, 'pedidos_compra.json');

function leerPedidosCompra()          { return leerJSON(PEDIDOS_COMPRA_PATH, { pedidos: [] }).pedidos || []; }
function guardarPedidosCompra(lista)  { guardarJSON(PEDIDOS_COMPRA_PATH, { pedidos: lista }); }
const DISTRIB_CONFIG_PATH = path.join(DATA_DIR, 'distribucion_config.json');
const A8020_CALC_PATH = path.join(DATA_DIR, 'a8020_calc.json');
const _ventasJoin = `INNER JOIN Ventas v ON v.IdSucursal=vp.IdSucursal AND v.IdTipoComprobante=vp.IdTipoComprobante
    AND v.Letra=vp.Letra AND v.CentroEmisor=vp.CentroEmisor AND v.NumeroComprobante=vp.NumeroComprobante
  LEFT JOIN Clientes c ON c.IdCliente=v.IdCliente LEFT JOIN Categorias cat ON cat.IdCategoria=c.IdCategoria`;
const FRAC_REG_PATH = path.join(DATA_DIR, 'fraccionado_registros.json');
const HISTORIAL_PATH = path.join(DATA_DIR, 'historial_distribucion.json');
// ── Producción: registros de cargas (archivo separado de distribución) ──────────
const PROD_REG_PATH = path.join(DATA_DIR, 'produccion_registros.json');
// Historial: los registros ya conciliados (dados de alta en producción) se mueven acá y salen
// del listado de Terminados. Es un archivo, no un borrado: quedan para consulta.
const PROD_HIST_PATH = path.join(DATA_DIR, 'produccion_historial.json');
// Mueve los registros indicados de produccion_registros.json a produccion_historial.json.
function archivarRegistros(ids, meta) {
  const idset = new Set((ids || []).map(String));
  if (!idset.size) return 0;
  const registros = leerJSON(PROD_REG_PATH, []);
  const aMover = registros.filter(r => r && idset.has(String(r.id)));
  if (!aMover.length) return 0;
  const quedan = registros.filter(r => !(r && idset.has(String(r.id))));
  const hist = leerJSON(PROD_HIST_PATH, []);
  const sellados = aMover.map(r => ({ ...r, archivado: { ...(meta || {}), fecha: new Date().toISOString() } }));
  guardarJSON(PROD_HIST_PATH, [...hist, ...sellados]);
  guardarJSON(PROD_REG_PATH, quedan);

  // Conciliar cierra el día igual que el botón "Cerrar día": las cargas conciliadas se
  // convierten en un snapshot de registros.json —que es lo que lista el Historial— y las
  // órdenes que quedaron listas salen de ordenes.json. Sin esto las cargas se iban de
  // Terminados a produccion_historial.json, que ninguna pantalla muestra: parecían borradas.
  const ordenes = leerOrdenes();
  const idsOrden = new Set(aMover.map(r => r && r.ordenId).filter(v => v != null).map(String));
  crearSnapshotsCierre(aMover);
  if (idsOrden.size) {
    // Sólo las órdenes de ESTE cierre y sólo si están listas: las pendientes siguen vivas.
    guardarOrdenes(ordenes.filter(o => !(idsOrden.has(String(o.id)) && o.estado === 'listo')));
  }
  return aMover.length;
}

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
// Auditoría del cálculo de quiebres para UN producto en UNA sucursal: devuelve el umbral
// con sus insumos y la serie diaria de stock reconstruida, día por día. Sirve para
// contrastar contra SIGA cuando un número de la tabla no cierra.
app.get('/api/diag/quiebre', apiRoute(async req => {
  const desde = safeDate(req.query.desde);
  const hasta = safeDate(req.query.hasta);
  const suc = String(parseInt(req.query.suc, 10) || 0);
  const idsCsv = analisisVentas.idsCsvSeguro([req.query.plu]);
  if (!idsCsv || suc === '0') return { error: 'Faltan plu y/o suc.' };
  const p = { desde, hasta, sucIdsCsv: suc };
  const hoy = new Date().toISOString().slice(0, 10);

  const [nombreRows, pesablesRows, stockRows, netoRows, unidadesRows, movimientos] = await Promise.all([
    query(`SELECT p.NombreProducto, r.NombreRubro FROM Productos p
      LEFT JOIN Rubros r ON r.IdRubro = p.IdRubro WHERE p.IdProducto IN (${idsCsv})`),
    query(analisisVentas.sqlPesables(idsCsv)),
    query(analisisVentas.sqlStockPorSucursal(idsCsv, suc)),
    query(analisisVentas.sqlNetoDiarioStock(desde, suc, idsCsv)),
    query(analisisVentas.sqlUnidadesPorSucursal(p, idsCsv)),
    query(analisisVentas.sqlMovimientosProducto(desde, suc, idsCsv)),
  ]);

  const netosPorFecha = {}, entradasPorFecha = {};
  for (const r of netoRows) {
    const f = r.Fecha instanceof Date ? r.Fecha.toISOString().slice(0, 10) : String(r.Fecha).slice(0, 10);
    netosPorFecha[f] = Number(r.Neto || 0);
    entradasPorFecha[f] = Number(r.Entradas || 0);
  }
  const esPesable = pesablesRows.length > 0;
  const unidades = Number((unidadesRows[0] || {}).Unidades || 0);
  const stockActual = Number((stockRows[0] || {}).Stock || 0);
  const meses = analisisVentas.mesesDelRango(desde, hasta);
  const umbral = analisisVentas.umbralQuiebre(unidades, meses, esPesable);
  const serie = analisisVentas.serieStockDiaria({
    stockActual, netosPorFecha, entradasPorFecha, desde, hasta, hoy, umbral,
  });

  return {
    producto: (nombreRows[0] || {}).NombreProducto || null,
    rubro: (nombreRows[0] || {}).NombreRubro || null,
    plu: req.query.plu, sucursal: Number(suc), rango: { desde, hasta }, hoy,
    umbral: {
      esPesable, unidadesRango: unidades, meses,
      ventasMes: meses > 0 ? unidades / meses : 0,
      porcentaje: analisisVentas.UMBRAL_PORC_VENTAS,
      topeUnidades: esPesable ? null : analisisVentas.UMBRAL_TOPE_UNIDADES,
      valor: umbral,
    },
    // stockActual es el de HOY: la serie se reconstruye hacia atrás desde ahí.
    stockActual,
    sinFilaDeStock: stockRows.length === 0,
    diasEnQuiebre: serie.filter(d => d.quiebre).length,
    // Base del porcentaje: días del rango sin domingos (los que podrían haber sido quiebre).
    diasEvaluados: analisisVentas.diasEvaluados(serie),
    porcentaje: analisisVentas.porcentajeQuiebre(
      serie.filter(d => d.quiebre).length, analisisVentas.diasEvaluados(serie)),
    serie,
    movimientos: movimientos.map(r => ({
      fecha: r.Fecha, tipo: r.Tipo, numero: r.Numero, cantidad: Number(r.Cantidad || 0),
    })),
  };
}));




// IdListaPrecios 0 es "Lista de precios SUCURSALES". La lista 1 se llama, textual,
// "Lista de precios NO USAR": sin este filtro cada producto sale duplicado y con el
// precio de la lista equivocada la mitad de las veces.
const LISTA_PRECIOS_VENTA = 0;

// Segunda fuente del facturador: la planilla de precios que vive en una carpeta compartida
// de la red. Cubre el caso de SQL caído (o del server corriendo sin acceso a SiGA) sin
// obligar a nadie a cargar el archivo a mano en cada caja.
// La ruta se fija por env y NUNCA por query: esta ruta no lleva sesión (el facturador se
// abre con file:// y no puede loguearse), así que aceptar una ruta del cliente sería dejar
// leer cualquier archivo del servidor.
const PRECIOS_FACTURADOR_DIR = process.env.PRECIOS_FACTURADOR_DIR ||
  '\\\\192.168.1.26\\Apidelta\\7- SISTEMA\\1-Precios\\PreciosFacturador';




// ── Familias manuales de producto ────────────────────────────────────────────
// Grupos que arma el usuario a mano para comparar entre sucursales el pedazo de catálogo
// que le interesa. La definición vive en un JSON (no en SIGA) y las ventas se consultan
// contra los códigos que tenga cargados. Alcance: sucursales, sin casa central — por eso
// alcanza con el permiso de analisis-ventas.
const FAMILIAS_MANUALES_PATH = path.join(DATA_DIR, 'familias_manuales.json');


// ── Sucursales ─────────────────────────────────────────────────────────────────
// El sistema puede operar sobre cualquier sucursal, no sólo la de config.json: los
// endpoints de stock y de reserva aceptan idSucursal (query en los GET, body en los POST)
// y, si no viene, usan reserva.idSucursal del config (comportamiento histórico).
const ERR_SUCURSAL_INVALIDA = 'Sucursal inválida';

// La columna Activo no existe en todas las versiones de SiGA y nombrarla cuando no está
// rompe la consulta entera, así que se detecta una sola vez y se cachea. Si la detección
// falla (por permisos sobre sys.columns) se asume que todas las sucursales están activas,
// que es exactamente lo que hacía el código antes de esta validación.
let sucursalesTieneColumnaActivo = null;
async function detectarColumnaActivoSucursales() {
  if (sucursalesTieneColumnaActivo === null) {
    try {
      const r = await query(`SELECT COUNT(*) AS Tiene FROM sys.columns
        WHERE object_id = OBJECT_ID('dbo.Sucursales') AND name = 'Activo'`);
      sucursalesTieneColumnaActivo = Number(r[0] && r[0].Tiene) > 0;
    } catch { sucursalesTieneColumnaActivo = false; }
  }
  return sucursalesTieneColumnaActivo;
}

// Sucursales de SiGA con la central primero. Consulta única para todos los consumidores:
// el selector de sucursal, el detalle de stock por sucursal y la validación de idSucursal.
async function sucursalesSiga() {
  const conActivo = await detectarColumnaActivoSucursales();
  const rows = await query(`SELECT IdSucursal, Nombre, SoyLaCentral, ${conActivo ? 'Activo' : '1'} AS Activa
    FROM Sucursales ORDER BY SoyLaCentral DESC, IdSucursal`);
  return rows.map(s => ({
    id: Number(s.IdSucursal), nombre: s.Nombre, central: !!s.SoyLaCentral,
    activa: s.Activa == null ? true : !!s.Activa
  }));
}

// Forma pública: es lo que ya devolvía /api/plan/stock-detalle, así que no cambia.
function sucursalPublica(s) { return { id: s.id, nombre: s.nombre, central: s.central }; }

// Sucursal efectiva de una request. Sin idSucursal se usa la de config.json y NO se
// consulta SiGA: así todo lo que hoy llama sin el parámetro se comporta igual que siempre.
// Con idSucursal se valida que exista y esté activa. Devuelve { idSucursal, cr } —cr es la
// config de reserva apuntando a esa sucursal— o { error }.
async function resolverSucursal(valor) {
  const cr = cfgReserva();
  if (valor === undefined || valor === null || String(valor).trim() === '') {
    return { idSucursal: cr.idSucursal, cr };
  }
  const id = Number(valor);
  if (!Number.isInteger(id) || id <= 0) return { error: ERR_SUCURSAL_INVALIDA };
  const suc = (await sucursalesSiga()).find(s => s.id === id);
  if (!suc || !suc.activa) return { error: ERR_SUCURSAL_INVALIDA };
  return { idSucursal: id, cr: { ...cr, idSucursal: id } };
}

// La sucursal con la que se ejecutan los movimientos de una reserva queda CONGELADA en la
// reserva, igual que depOrigen/depDestino: cambiar de sucursal en la pantalla no puede
// hacer que una devolución mueva stock en una sucursal distinta a la que lo reservó.
// El config sólo es fallback para reservas viejas, guardadas antes de que se guardara.
function sucursalDeReserva(reserva) {
  const n = Number(reserva && reserva.idSucursal);
  return Number.isInteger(n) && n > 0 ? n : cfgReserva().idSucursal;
}

// Devuelve null si la reserva se puede operar desde la sucursal pedida, o el mensaje de
// error si la reserva activa es de otra (en ese caso no se ejecuta ningún movimiento).
function chequearSucursalReserva(reserva, idSucursal) {
  if (!reserva || reserva.estado !== 'activa') return null;
  const deLaReserva = sucursalDeReserva(reserva);
  if (deLaReserva === Number(idSucursal)) return null;
  return `La reserva activa de este plan es de la sucursal ${deLaReserva}. Cambiá a esa sucursal para operarla.`;
}

// ── Movimientos de stock (Siga) ────────────────────────────────────────────────
// Movimiento simple (1 línea) tipo BIENESUSO, con INSERT del renglón de stock si
// el depósito/ubicación destino todavía no tiene fila para el producto.
// Ver pruebas_stock_claude/README.md para el mecanismo completo investigado.
// BIENESUSO cubre el apartado de mercadería y su devolución/anulación (principal ↔ depósito de
// reserva); REC-SUC, el alta de producción, los sobrantes y los ajustes ±, para poder separarlos
// en SiGA por tipo y no sólo por la observación.
// Un tipo sólo sirve acá si además de existir en TiposMovimientos tiene su fila de numerador en
// MovimientosNumeros para CADA sucursal que lo use; si falta, el movimiento aborta con
// "No hay numerador en MovimientosNumeros para sucursal X / tipo Y". Por eso se usan tipos ya
// operativos de SiGA en vez de tipos nuevos.
const TIPOS_MOVIMIENTO_STOCK_PERMITIDOS = ['BIENESUSO', 'REC-SUC'];

// Depósitos activos de una sucursal. Los nombres en SiGA vienen con espacios adelante,
// por eso el RTRIM (el LTRIM lo hace el trim de cada consumidor si hace falta).
async function depositosActivos(idSucursal) {
  const suc = Number(idSucursal);
  if (!Number.isInteger(suc) || suc <= 0) return [];
  return query(`SELECT IdDeposito, IdSucursal, RTRIM(NombreDeposito) AS NombreDeposito, TipoDeposito, DisponibleVenta
    FROM SucursalesDepositos WHERE IdSucursal=${suc} AND Activo=1 ORDER BY IdDeposito`);
}

// ── Traslados de stock entre depósitos (Siga) ──────────────────────────────────
// Un traslado es UN comprobante con DOS líneas por producto: origen −Q y destino +Q.
// Ver pruebas_stock_claude/README.md y pruebas_stock_claude/_traslado_REAL.js.

// Ubicación activa del depósito (SiGA exige IdUbicacion en cada renglón). Fallback: 1.
async function ubicacionDeDeposito(rq, idSucursal, idDeposito) {
  const r = await rq()
    .input('sucursal', sql.Int, idSucursal)
    .input('deposito', sql.Int, idDeposito)
    .query(`SELECT TOP 1 IdUbicacion FROM SucursalesUbicaciones
            WHERE IdSucursal=@sucursal AND IdDeposito=@deposito AND Activo=1 ORDER BY IdUbicacion`);
  return r.recordset.length ? Number(r.recordset[0].IdUbicacion) : 1;
}

// Renglón de MovimientosStockProductos (la cantidad ya viene con signo).
async function insertarLineaTraslado(rq, l) {
  await rq()
    .input('sucursal', sql.Int, l.idSucursal)
    .input('deposito', sql.Int, l.idDeposito)
    .input('ubicacion', sql.Int, l.idUbicacion)
    .input('tipo', sql.VarChar, l.idTipoMovimiento)
    .input('numero', sql.Int, l.numero)
    .input('producto', sql.VarChar, l.idProducto)
    .input('cantidad', sql.Decimal(18, 4), l.cantidad)
    .input('orden', sql.Int, l.orden)
    .query(`INSERT INTO MovimientosStockProductos
      (IdSucursal, IdDeposito, IdUbicacion, IdTipoMovimiento, NumeroMovimiento, IdProducto, Cantidad, Cantidad2, Precio, Orden)
      VALUES (@sucursal, @deposito, @ubicacion, @tipo, @numero, @producto, @cantidad, 0, 0, @orden)`);
}

// Aplica el delta en las dos tablas de stock (INSERT si el producto no tiene fila).
async function aplicarDeltaStock(rq, l) {
  await rq()
    .input('sucursal', sql.Int, l.idSucursal)
    .input('deposito', sql.Int, l.idDeposito)
    .input('producto', sql.VarChar, l.idProducto)
    .input('delta', sql.Decimal(18, 4), l.cantidad)
    .query(`IF EXISTS (SELECT 1 FROM ProductosDepositos WHERE IdProducto=@producto AND IdSucursal=@sucursal AND IdDeposito=@deposito)
              UPDATE ProductosDepositos SET Stock = Stock + @delta
              WHERE IdProducto=@producto AND IdSucursal=@sucursal AND IdDeposito=@deposito;
            ELSE
              INSERT INTO ProductosDepositos (IdProducto, IdSucursal, IdDeposito, Stock, Stock2)
              VALUES (@producto, @sucursal, @deposito, @delta, 0);`);
  await rq()
    .input('sucursal', sql.Int, l.idSucursal)
    .input('deposito', sql.Int, l.idDeposito)
    .input('ubicacion', sql.Int, l.idUbicacion)
    .input('producto', sql.VarChar, l.idProducto)
    .input('delta', sql.Decimal(18, 4), l.cantidad)
    .query(`IF EXISTS (SELECT 1 FROM ProductosUbicaciones WHERE IdProducto=@producto AND IdSucursal=@sucursal AND IdDeposito=@deposito AND IdUbicacion=@ubicacion)
              UPDATE ProductosUbicaciones SET Stock = Stock + @delta
              WHERE IdProducto=@producto AND IdSucursal=@sucursal AND IdDeposito=@deposito AND IdUbicacion=@ubicacion;
            ELSE
              INSERT INTO ProductosUbicaciones (IdProducto, IdSucursal, IdDeposito, IdUbicacion, Stock, Stock2)
              VALUES (@producto, @sucursal, @deposito, @ubicacion, @delta, 0);`);
}

// Traslado de N productos entre dos depósitos, todo en una transacción y en un
// único comprobante. t = { idSucursal, depOrigen, depDestino, idTipoMovimiento,
//                          lineas:[{idProducto,cantidad}], usuario, observacion, idEmpleado }
// Cabecera del comprobante: reserva el número en MovimientosNumeros e inserta la fila de
// MovimientosStock. Es idéntica para un traslado y para un movimiento multi-línea, así que
// vive una sola vez acá. Devuelve el NumeroMovimiento con el que van los renglones.
async function crearComprobanteStock(rq, m) {
  const numRs = await rq()
    .input('sucursal', sql.Int, m.idSucursal)
    .input('tipo', sql.VarChar, m.idTipoMovimiento)
    .query(`UPDATE MovimientosNumeros SET Numero = Numero + 1
            OUTPUT inserted.Numero AS Numero
            WHERE IdSucursal=@sucursal AND IdTipoMovimiento=@tipo`);
  if (!numRs.recordset.length) {
    throw new Error(`No hay numerador en MovimientosNumeros para sucursal ${m.idSucursal} / tipo ${m.idTipoMovimiento}`);
  }
  const numero = numRs.recordset[0].Numero;

  await rq()
    .input('sucursal', sql.Int, m.idSucursal)
    .input('tipo', sql.VarChar, m.idTipoMovimiento)
    .input('numero', sql.Int, numero)
    .input('usuario', sql.NVarChar, m.usuario)
    .input('observacion', sql.NVarChar, m.observacion || '')
    .input('empleado', sql.Int, m.idEmpleado)
    .query(`INSERT INTO MovimientosStock
      (IdSucursal, IdTipoMovimiento, NumeroMovimiento, FechaMovimiento, Neto, Total, PorcentajeIVA,
       Usuario, Observacion, IdEmpleado, PercepcionIVA, PercepcionIB, PercepcionGanancias, PercepcionVarias, ImpuestosInternos)
      VALUES (@sucursal, @tipo, @numero, GETDATE(), 0, 0, 0, @usuario, @observacion, @empleado, 0, 0, 0, 0, 0)`);
  return numero;
}

async function trasladarStock(pool, t) {
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const rq = () => new sql.Request(tx);
    const ubicOrigen  = await ubicacionDeDeposito(rq, t.idSucursal, t.depOrigen);
    const ubicDestino = await ubicacionDeDeposito(rq, t.idSucursal, t.depDestino);

    const numero = await crearComprobanteStock(rq, t);

    // A diferencia de registrarMovimientoStock (una sola línea), acá NO se multiplica por
    // CoeficienteStock: el traslado lleva el signo explícito en cada renglón (−origen /
    // +destino) y el neto del comprobante es cero, así que el coeficiente del tipo de
    // movimiento no aplica.
    let orden = 1;
    for (const l of t.lineas) {
      const cantidad   = Number(l.cantidad);
      const idProducto = String(l.idProducto);
      const base = { idSucursal: t.idSucursal, idTipoMovimiento: t.idTipoMovimiento, numero, idProducto };
      await insertarLineaTraslado(rq, { ...base, idDeposito: t.depOrigen,  idUbicacion: ubicOrigen,  cantidad: -cantidad, orden: orden++ });
      await insertarLineaTraslado(rq, { ...base, idDeposito: t.depDestino, idUbicacion: ubicDestino, cantidad:  cantidad, orden: orden++ });
      await aplicarDeltaStock(rq, { ...base, idDeposito: t.depOrigen,  idUbicacion: ubicOrigen,  cantidad: -cantidad });
      await aplicarDeltaStock(rq, { ...base, idDeposito: t.depDestino, idUbicacion: ubicDestino, cantidad:  cantidad });
    }

    await tx.commit();
    return numero;
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}

// Movimiento de N líneas con signo y depósito PROPIOS, todo en un único comprobante.
// trasladarStock no sirve para esto: asume neto cero y un par −origen/+destino del mismo
// producto. Una producción, en cambio, da de alta el terminado en un depósito y da de baja
// cada componente en el suyo (reserva o principal), así que las líneas son independientes.
// m = { idSucursal, idTipoMovimiento, usuario, idEmpleado, observacion,
//       lineas: [{ idProducto, idDeposito, cantidad }] }  ← cantidad CON SIGNO (+ alta, − baja)
async function registrarMovimientoMultilinea(pool, m) {
  const lineas = m.lineas || [];
  if (!lineas.length) throw new Error('El movimiento no tiene líneas');
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const rq = () => new sql.Request(tx);
    // Una consulta de ubicación por depósito distinto, no por línea: varios componentes
    // salen del mismo depósito y la ubicación no cambia entre ellos.
    const ubicaciones = new Map();
    for (const l of lineas) {
      const dep = Number(l.idDeposito);
      if (!ubicaciones.has(dep)) ubicaciones.set(dep, await ubicacionDeDeposito(rq, m.idSucursal, dep));
    }

    const numero = await crearComprobanteStock(rq, m);

    // Igual que en trasladarStock, acá NO se multiplica por CoeficienteStock: cada renglón
    // ya trae su signo explícito. El coeficiente del tipo de movimiento sólo tiene sentido
    // cuando la cantidad viene sin signo (registrarMovimientoStock, una sola línea).
    let orden = 1;
    for (const l of lineas) {
      const idDeposito = Number(l.idDeposito);
      const linea = {
        idSucursal: m.idSucursal, idTipoMovimiento: m.idTipoMovimiento, numero,
        idProducto: String(l.idProducto), idDeposito,
        idUbicacion: ubicaciones.get(idDeposito), cantidad: Number(l.cantidad)
      };
      await insertarLineaTraslado(rq, { ...linea, orden: orden++ });
      await aplicarDeltaStock(rq, linea);
    }

    await tx.commit();
    return numero;
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}

// ── Log persistente de movimientos de stock ────────────────────────────────────
// Todo movimiento que toca stock en SiGA (reserva, ajuste, devolución, traslado
// manual o movimiento suelto) deja acá su propio registro, independiente del plan.
// Sirve para dos cosas: que el rastro sobreviva al borrado del plan del día
// (DELETE /api/plan/:fecha vacía los ítems) y poder revertir un movimiento que se
// hizo por error desde POST /api/stock/movimientos/:id/revertir.
const MOVIMIENTOS_LOG_PATH = path.join(DATA_DIR, 'movimientos_stock.json');

// Id único sin Math.random: milisegundos + un contador que sólo avanza dentro del
// mismo milisegundo. Dos procesos distintos no pueden arrancar en el mismo ms.
let movLogUltimoMs = 0, movLogSeq = 0;
function nuevoIdMovLog() {
  const ms = Date.now();
  if (ms === movLogUltimoMs) movLogSeq++; else { movLogUltimoMs = ms; movLogSeq = 0; }
  return `mov-${ms}-${String(movLogSeq).padStart(3, '0')}`;
}

function leerMovLog() { const d = leerJSON(MOVIMIENTOS_LOG_PATH, []); return Array.isArray(d) ? d : []; }
function guardarMovLog(arr) { guardarJSON(MOVIMIENTOS_LOG_PATH, arr); }

// El registro guarda todo lo necesario para reconstruir (y por lo tanto revertir) el
// movimiento sin volver a consultar SiGA: depósitos, tipo, empleado y líneas.
// depDestino/idUbicacion quedan en null según el tipo: un traslado tiene dos depósitos
// y ninguna ubicación explícita, un movimiento suelto tiene un depósito y una ubicación.
function registroMovimiento(d) {
  return {
    id: nuevoIdMovLog(),
    fechaHora: new Date().toISOString(),
    origen: d.origen,
    plan: d.plan || null,
    itemId: d.itemId == null ? null : Number(d.itemId),
    idSucursal: Number(d.idSucursal),
    depOrigen: Number(d.depOrigen),
    depDestino: d.depDestino == null ? null : Number(d.depDestino),
    idUbicacion: d.idUbicacion == null ? null : Number(d.idUbicacion),
    idEmpleado: d.idEmpleado == null ? null : Number(d.idEmpleado),
    idTipoMovimiento: String(d.idTipoMovimiento || ''),
    usuario: String(d.usuario || ''),
    observacion: String(d.observacion || ''),
    numeroMovimiento: null,
    lineas: (d.lineas || []).map(l => ({
      plu: String(l.plu), nombre: l.nombre == null ? null : String(l.nombre), cantidad: Number(l.cantidad),
      // Sólo los movimientos multi-depósito (producción) guardan el depósito EN LA LÍNEA: en
      // un traslado el depósito está en la cabecera (depOrigen/depDestino) y repetirlo sería
      // redundante. Su presencia es lo que después distingue a un registro multi-depósito
      // para calcular saldos y para revertirlo.
      ...(l.idDeposito == null ? {} : { idDeposito: Number(l.idDeposito) })
    })),
    estado: 'pendiente',
    error: null,
    revierteA: d.revierteA || null,
    revertidoPor: null
  };
}

// Las escrituras del log NUNCA deben tumbar un endpoint: el traslado ya ejecutado en SiGA
// tiene prioridad sobre el archivo. Por eso devuelven el mensaje de error en vez de tirarlo,
// y quien llama lo propaga a la respuesta como logError.
function agregarMovLog(registro) {
  try {
    const log = leerMovLog();
    guardarMovLog([...log, registro]);
    return null;
  } catch (e) { return `No se pudo guardar el movimiento ${registro.id} en el log: ${e.message}`; }
}

function actualizarMovLog(id, fn) {
  try {
    const log = leerMovLog();
    const i = log.findIndex(r => r && r.id === id);
    if (i === -1) return `No se encontró el movimiento ${id} en el log para actualizarlo`;
    const copia = log.slice();
    copia[i] = fn(copia[i]);
    guardarMovLog(copia);
    return null;
  } catch (e) { return `No se pudo actualizar el movimiento ${id} del log: ${e.message}`; }
}

// MovimientosStock.Usuario tiene una FK contra dbo.Usuarios.Id: si el usuario configurado
// no existe en SiGA, TODO movimiento falla con el mismo error crudo de ODBC. Se traduce una
// sola vez acá (lo usan todos los endpoints a través de ejecutarYRegistrar) para que el
// mensaje diga qué hay que corregir y no quede sólo el texto del driver en el log.
const ERR_SQL_FK_USUARIO = 'FK_MovimientosStock_Usuarios';
function traducirErrorMovimiento(mensaje, usuario) {
  const txt = String(mensaje || '');
  if (!txt.includes(ERR_SQL_FK_USUARIO)) return txt;
  return `El usuario '${String(usuario || '').trim() || '(vacío)'}' no existe en SiGA (tabla Usuarios). `
       + 'Cambiá reserva.usuario en config.json por un usuario válido del sistema.';
}

// Ejecución en dos fases: primero se deja el registro 'pendiente', después se toca SQL y
// recién ahí se marca 'confirmado' o 'fallido'.
// IMPORTANTE: un registro que queda en 'pendiente' significa que el proceso murió entre el
// COMMIT de SQL y el guardado del JSON. No hay reconciliación automática: hay que verificar
// A MANO en SiGA si el movimiento existe (buscando por observación, usuario y fecha) antes
// de hacer nada con él; por eso tampoco se puede revertir un registro 'pendiente'.
// fn() debe devolver el número de movimiento. El error se re-lanza tal cual para no cambiar
// el comportamiento actual de los endpoints.
async function ejecutarYRegistrar(datos, fn) {
  const registro  = registroMovimiento(datos);
  const errAlta   = agregarMovLog(registro);
  let numero;
  try {
    numero = await fn();
  } catch (e) {
    // El error traducido va tanto al log como a la respuesta del endpoint: el registro
    // fallido tiene que poder leerse sin conocer los nombres de las constraints de SiGA.
    const mensaje = traducirErrorMovimiento(e.message, datos.usuario);
    actualizarMovLog(registro.id, r => ({ ...r, estado: 'fallido', error: mensaje }));
    throw mensaje === e.message ? e : new Error(mensaje);
  }
  const errCierre = actualizarMovLog(registro.id, r => ({ ...r, estado: 'confirmado', numeroMovimiento: numero }));
  return { numeroMovimiento: numero, idRegistro: registro.id, logError: errAlta || errCierre || null };
}

// Agrega logError a la respuesta sólo si alguna escritura del log falló.
function conLogError(respuesta, ...errores) {
  const err = errores.filter(Boolean).join(' | ');
  return err ? { ...respuesta, logError: err } : respuesta;
}

// ── Reserva de mercadería del plan de producción ───────────────────────────────
// Al reservar se trasladan al depósito de reserva TODOS los componentes de la fórmula
// activa (granel + envase + tapa + etiquetas + lo que haya) de cada ítem del plan.
// Al marcar un ítem como 'listo' se devuelve automáticamente su porción al principal.
// MovimientosStock.Usuario es una columna corta: 'PLANIFICACION' (13 chars) hace fallar el
// INSERT con "String or binary data would be truncated" (verificado en la prueba real del
// producto 1010, movimiento 17097), mientras que 'Adriel' (6) entra sin problema.
// Por eso el default es corto y además se trunca a USUARIO_MOV_MAX antes de insertar.
const USUARIO_MOV_MAX = 10;
const RESERVA_DEFAULTS = {
  idSucursal: 1, depositoPrincipal: 1, depositoReserva: null,
  idTipoMovimiento: 'BIENESUSO', usuario: 'Adriel', idEmpleado: 1
};

// Se relee config.json en cada llamada: el código del depósito de reserva se define
// recién cuando el depósito exista en SiGA y no debe requerir reiniciar el servidor.
function cfgReserva() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).reserva || {}; } catch { raw = {}; }
  const c = { ...RESERVA_DEFAULTS, ...raw };
  const depReserva = Number(c.depositoReserva);
  return {
    idSucursal:        Number(c.idSucursal)        || RESERVA_DEFAULTS.idSucursal,
    depositoPrincipal: Number(c.depositoPrincipal) || RESERVA_DEFAULTS.depositoPrincipal,
    depositoReserva:   Number.isInteger(depReserva) && depReserva > 0 ? depReserva : null,
    idTipoMovimiento:  String(c.idTipoMovimiento || RESERVA_DEFAULTS.idTipoMovimiento).trim().toUpperCase(),
    usuario:           String(c.usuario || RESERVA_DEFAULTS.usuario).trim().slice(0, USUARIO_MOV_MAX),
    idEmpleado:        Number(c.idEmpleado) || RESERVA_DEFAULTS.idEmpleado
  };
}

// ── Alta de producción ─────────────────────────────────────────────────────────
// El movimiento que registra la producción del día usa su propio bloque de config para no
// mezclarse con el de la reserva: el tipo es REC-SUC (la reserva usa BIENESUSO) y la
// OBSERVACIÓN sigue siendo lo que permite reconocer a qué plan pertenece cada comprobante.
// Cubre el alta de producción, los sobrantes y los ajustes ± de una reserva viva; el apartado
// y su devolución/anulación van con BIENESUSO.
const PRODUCCION_DEFAULTS = {
  idTipoMovimiento: 'REC-SUC', observacion: 'PLAN', depositoTerminados: null
};

// Se relee config.json en cada llamada, igual que cfgReserva: cambiar la observación o el
// depósito de terminados no debe requerir reiniciar el servidor.
function cfgProduccion() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).produccion || {}; } catch { raw = {}; }
  const c   = { ...PRODUCCION_DEFAULTS, ...raw };
  const dep = Number(c.depositoTerminados);
  return {
    idTipoMovimiento:   String(c.idTipoMovimiento || PRODUCCION_DEFAULTS.idTipoMovimiento).trim().toUpperCase(),
    observacion:        String(c.observacion || PRODUCCION_DEFAULTS.observacion).trim(),
    // null = el terminado entra al mismo depósito principal del que salen los componentes.
    depositoTerminados: Number.isInteger(dep) && dep > 0 ? dep : null
  };
}

// Tipo con el que se registran los AJUSTES de una reserva ya hecha (los dos sentidos de
// /reserva/actualizar): el mismo que la producción. La reserva y su devolución/anulación van
// con el tipo de reserva; el ajuste no, porque no abre ni cierra un apartado sino que corrige
// uno vivo y conviene poder separarlo en SiGA.
function tipoMovimientoAjusteReserva() {
  return cfgProduccion().idTipoMovimiento;
}

const ERR_RESERVA_SIN_CONFIG = 'Falta configurar el depósito de reserva (reserva.depositoReserva en config.json)';
const ERR_RESERVA_DEPOSITOS  = 'Elegí un depósito de origen y uno de destino distintos';
function redondear4(n) { return Math.round((Number(n) || 0) * 1e4) / 1e4; }

// Los depósitos de la reserva ahora se eligen en el modal, así que hay que validarlos
// en cada punto de entrada en vez de confiar en config.json.
function esIdDeposito(n) { return Number.isInteger(n) && n > 0; }
function idDepositoODefault(valor, porDefecto) {
  const n = Number(valor);
  return esIdDeposito(n) ? n : porDefecto;
}

// El envase y la tapa elegidos en la planificación llegan como PLU en string, pero pueden
// venir vacíos ('') o directamente ausentes (undefined): en esos casos manda la fórmula.
function pluSeleccionado(valor) { return String(valor ?? '').replace(/\D/g, ''); }

// Aplica a los componentes de fórmula de un ítem el envase y la tapa elegidos en el plan:
// cada elegido reemplaza al PRIMER componente de su tipo (el mismo que elegiría
// /api/plan/packaging) conservando su cantPorUnidad; si la fórmula no tiene ninguno de ese
// tipo, el elegido se agrega con cantPorUnidad 1. Si la fórmula tuviera más de un
// componente del mismo tipo, los demás quedan como están.
// No muta los componentes recibidos. Devuelve { lista, sustituciones }.
function aplicarSeleccionPackaging(comps, seleccion, infoElegidos) {
  const lista = comps.map(c => ({ ...c, origen: 'formula', reemplazaA: [] }));
  const sustituciones = [];
  const indices = { envase: -1, tapa: -1 };
  comps.forEach((c, i) => {
    const tipo = clasificarPackaging(c.nombre, c.rubro);
    if (tipo && indices[tipo] < 0) indices[tipo] = i;
  });

  for (const tipo of ['envase', 'tapa']) {
    const plu = seleccion[tipo];
    if (!plu) continue;
    const i    = indices[tipo];
    const info = infoElegidos.get(plu) || {};
    const deFormula = i >= 0 ? { plu: comps[i].plu, nombre: comps[i].nombre } : null;
    // Elegir exactamente lo que ya dice la fórmula no es una sustitución: se deja igual.
    if (deFormula && deFormula.plu === plu) continue;
    const elegido = {
      plu,
      nombre: String(info.nombre || `PLU ${plu}`),
      rubro: String(info.rubro || ''),
      cantPorUnidad: i >= 0 ? comps[i].cantPorUnidad : 1,
      origen: 'seleccion',
      reemplazaA: deFormula ? [deFormula] : []
    };
    if (i >= 0) lista[i] = elegido; else lista.push(elegido);
    sustituciones.push({ tipo, deFormula, elegido: { plu: elegido.plu, nombre: elegido.nombre } });
  }
  return { lista, sustituciones };
}

// Nombre y rubro de los PLU elegidos en la planificación. Hace falta consultarlos aparte
// porque un envase o una tapa elegidos pueden no estar en ninguna fórmula del plan.
async function infoProductosElegidos(plus) {
  const lista = [...new Set((plus || []).map(p => String(p).replace(/\D/g, '')).filter(Boolean))];
  const mapa = new Map();
  if (!lista.length) return mapa;
  const rows = await query(`
    SELECT p.IdProducto AS plu, p.NombreProducto AS nombre, COALESCE(r.NombreRubro,'') AS rubro
    FROM Productos p
    LEFT JOIN Rubros r ON r.IdRubro = p.IdRubro
    WHERE p.IdProducto IN (${lista.map(p => `'${p}'`).join(',')})`);
  for (const r of rows) {
    mapa.set(String(r.plu).trim(), { nombre: String(r.nombre || '').trim(), rubro: String(r.rubro || '').trim() });
  }
  return mapa;
}

// padre → [{plu, nombre, rubro, cantPorUnidad}] según la fórmula ACTIVA de cada producto.
// Única definición de la consulta de fórmula por lote de PLU: la usan componentesDePlan
// (para calcular la reserva) y la conciliación de producción (para resolver la etiqueta y
// los graneles cargados sin PLU). El filtro de fórmula activa es obligatorio: sin él la
// misma consulta devuelve una fila por cada versión histórica de la fórmula.
async function componentesFormulaPorPadre(plus) {
  const lista = [...new Set((plus || []).map(p => String(p ?? '').replace(/\D/g, '')).filter(Boolean))];
  const porPadre = new Map();
  if (!lista.length) return porPadre;
  const rows = await query(`
    SELECT pc.IdProducto AS padre, pc.IdProductoComponente AS plu,
           p.NombreProducto AS nombre, COALESCE(r.NombreRubro,'') AS rubro,
           CAST(pc.Cantidad AS FLOAT) AS cantPorUnidad
    FROM ProductosComponentes pc
    INNER JOIN Productos p ON p.IdProducto = pc.IdProductoComponente
    LEFT  JOIN Rubros    r ON r.IdRubro   = p.IdRubro
    WHERE pc.IdProducto IN (${lista.join(',')}) AND ${FORMULA_ACTIVA_SQL} AND ${SIN_FORMULA_GENERICO_SQL}
    ORDER BY p.NombreProducto`);
  for (const r of rows) {
    const padre = String(r.padre).trim();
    if (!porPadre.has(padre)) porPadre.set(padre, []);
    porPadre.get(padre).push({
      plu: String(r.plu).trim(), nombre: String(r.nombre || '').trim(),
      rubro: String(r.rubro || '').trim(), cantPorUnidad: Number(r.cantPorUnidad) || 0
    });
  }
  return porPadre;
}

// Componentes necesarios para todo el plan, sumados por componente, con el envase y la
// tapa elegidos en la planificación ya sustituidos sobre la fórmula activa.
// Devuelve { componentes: [{plu,nombre,rubro,necesario,porItem,reemplazaA,origen}],
//            itemsSinFormula, sustituciones }.
async function componentesDePlan(items) {
  const validos = [], itemsSinFormula = [];
  for (const it of (items || [])) {
    // Un ítem ya producido y recepcionado como artículo final (produccionMovimiento) salió
    // del circuito: su stock ya se movió con el alta de producción. No vuelve a aportar
    // componentes en ningún consumidor (preview, reservar, actualizar), para no re-reservar
    // mercadería que ya se consumió. El sello se pone en /registrar-movimiento y sólo se
    // quita al revertir ese alta (limpiarProduccionRegistrada). Si el mismo producto se
    // necesita de nuevo se agrega como ítem NUEVO (id distinto, sin este sello).
    if (it && it.produccionMovimiento) continue;
    // Los productos que se producen como granel no tienen idProducto (es una presentación
    // terminada lo que lleva código): su fórmula vive bajo idGranel. Sin este respaldo, el
    // ítem caía en itemsSinFormula aunque el granel sí tenga fórmula activa (ej. PLU 7482).
    const plu  = String(it.idProducto ?? it.idGranel ?? '').replace(/\D/g, '');
    const cant = Number(it.cantConfirmada ?? it.cantSugerida ?? 0);
    if (!plu || !Number.isFinite(cant) || cant <= 0) {
      itemsSinFormula.push({ id: it.id, idProducto: it.idProducto ?? null, producto: it.producto || '' });
      continue;
    }
    validos.push({
      id: it.id, plu, cant, producto: it.producto || '',
      seleccion: { envase: pluSeleccionado(it.envase), tapa: pluSeleccionado(it.tapa) }
    });
  }
  if (!validos.length) return { componentes: [], itemsSinFormula, sustituciones: [] };

  const porPadre = await componentesFormulaPorPadre(validos.map(v => v.plu));

  const infoElegidos = await infoProductosElegidos(validos.flatMap(v => [v.seleccion.envase, v.seleccion.tapa]));

  const acum = new Map();
  const sustituciones = [];
  for (const v of validos) {
    const comps = porPadre.get(v.plu) || [];
    // Sin fórmula activa no hay nada que sustituir: el ítem se reporta como está hoy.
    if (!comps.length) {
      itemsSinFormula.push({ id: v.id, idProducto: v.plu, producto: v.producto });
      continue;
    }
    const { lista, sustituciones: subs } = aplicarSeleccionPackaging(comps, v.seleccion, infoElegidos);
    for (const s of subs) sustituciones.push({ itemId: v.id, producto: v.producto, ...s });

    for (const c of lista) {
      const cantidad = redondear4(c.cantPorUnidad * v.cant);
      if (cantidad <= 0) continue;
      const e = acum.get(c.plu) || { plu: c.plu, nombre: c.nombre, rubro: c.rubro, necesario: 0, porItem: {}, origenes: new Set(), reemplazaA: [] };
      e.necesario     = redondear4(e.necesario + cantidad);
      e.porItem[v.id] = redondear4((e.porItem[v.id] || 0) + cantidad);
      e.origenes.add(c.origen);
      // Un mismo PLU puede desplazar componentes distintos según el ítem: se acumulan sin repetir.
      for (const d of c.reemplazaA) if (!e.reemplazaA.some(x => x.plu === d.plu)) e.reemplazaA.push(d);
      acum.set(c.plu, e);
    }
  }
  return {
    // origen 'mixto': ese PLU llegó por fórmula en un ítem y por selección en otro.
    componentes: [...acum.values()]
      .map(({ origenes, ...c }) => ({ ...c, origen: origenes.size > 1 ? 'mixto' : ([...origenes][0] || 'formula') }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre)),
    itemsSinFormula,
    sustituciones
  };
}

// plu → { origen, destino } leyendo ProductosDepositos de los depósitos elegidos.
// depDestino puede venir en null (todavía no se eligió): el destino queda en 0.
async function stockDeComponentes(cr, plus, depOrigen, depDestino) {
  const lista = [...new Set((plus || []).map(p => String(p).replace(/\D/g, '')).filter(Boolean))];
  const mapa = new Map();
  if (!lista.length) return mapa;
  const idOrigen  = esIdDeposito(Number(depOrigen))  ? Number(depOrigen)  : null;
  const idDestino = esIdDeposito(Number(depDestino)) ? Number(depDestino) : null;
  const deps = [...new Set([idOrigen, idDestino].filter(d => d != null))];
  if (!deps.length) return mapa;
  const rows = await query(`SELECT IdProducto, IdDeposito, CAST(Stock AS FLOAT) AS Stock
    FROM ProductosDepositos
    WHERE IdSucursal=${cr.idSucursal} AND IdDeposito IN (${deps.join(',')})
      AND IdProducto IN (${lista.map(p => `'${p}'`).join(',')})`);
  for (const r of rows) {
    const plu   = String(r.IdProducto).trim();
    const idDep = Number(r.IdDeposito);
    const e = mapa.get(plu) || { origen: 0, destino: 0 };
    if (idDep === idOrigen)  e.origen  += Number(r.Stock) || 0;
    if (idDep === idDestino) e.destino += Number(r.Stock) || 0;
    mapa.set(plu, e);
  }
  return mapa;
}

// Cantidad ya devuelta por componente; con itemId filtra las devoluciones de ese ítem.
function devueltoPorComponente(reserva, itemId) {
  const m = new Map();
  for (const d of ((reserva && reserva.devoluciones) || [])) {
    if (itemId != null && String(d.itemId) !== String(itemId)) continue;
    for (const l of (d.lineas || [])) {
      const plu = String(l.plu);
      m.set(plu, redondear4((m.get(plu) || 0) + (Number(l.cantidad) || 0)));
    }
  }
  return m;
}

// Saldo pendiente de devolución de toda la reserva.
function saldoReserva(reserva) {
  const dev = devueltoPorComponente(reserva, null);
  return ((reserva && reserva.lineas) || [])
    .map(l => ({ plu: String(l.plu), nombre: l.nombre, cantidad: redondear4((Number(l.cantidad) || 0) - (dev.get(String(l.plu)) || 0)) }))
    .filter(l => l.cantidad > 0);
}

// Números de movimiento del log, para validar los sellos reservaMovimiento de un plan:
// `vivos` son los confirmados DE ESE plan, `conocidos` todos los que el log registró.
function movsDelLog(fecha) {
  const vivos = new Set(), conocidos = new Set();
  for (const m of leerMovLog()) {
    if (!m || m.numeroMovimiento == null) continue;
    const n = String(m.numeroMovimiento);
    conocidos.add(n);
    if (m.plan === fecha && m.estado === 'confirmado') vivos.add(n);
  }
  return { vivos, conocidos };
}

// Lee planes.json y garantiza que cada plan tenga reservas[] (migra el formato viejo en
// memoria; no reescribe el archivo salvo que el caller guarde). Devuelve { planes, plan }.
// De paso se sueltan los sellos de reserva huérfanos (ver sanearSellosReserva): el log manda
// sobre el plan, así que un movimiento revertido o de otro día no deja la orden trabada.
function leerPlanReservas(fecha) {
  const planes = leerJSON(PLANES_PATH, {});
  if (!planes[fecha]) return { planes, plan: null };
  const migrado = migrarReservas(planes[fecha]);
  const { vivos, conocidos } = movsDelLog(fecha);
  return { planes, plan: sanearSellosReserva(migrado, vivos, conocidos) };
}

// Comprobantes de reserva ACTIVA que respaldan una orden de producción. Una orden con
// mercadería apartada en SiGA no se puede borrar: la reserva quedaría viva apuntando a una
// orden que ya no existe y nadie podría devolverla ni conciliarla.
// Se mira el sello reservaMovimientos que la orden guarda al enviarse Y, como red, los ítems
// del plan que la componen — las órdenes viejas no tienen el sello, y el sello tampoco se
// actualiza si la reserva se hizo después del envío.
// cache: Map fecha → plan ya migrado, para no releer planes.json por cada orden del lote.
function reservasActivasDeOrden(orden, cache) {
  if (!orden || !orden.fecha) return [];
  let plan;
  if (cache && cache.has(orden.fecha)) plan = cache.get(orden.fecha);
  else {
    plan = leerPlanReservas(orden.fecha).plan;
    if (cache) cache.set(orden.fecha, plan);
  }
  if (!plan) return [];
  const activas = new Set((plan.reservas || [])
    .filter(r => r && r.estado === 'activa' && r.numeroMovimiento != null)
    .map(r => String(r.numeroMovimiento)));
  if (!activas.size) return [];

  const nums = new Set((Array.isArray(orden.reservaMovimientos) ? orden.reservaMovimientos : []).map(String));
  // Mismo criterio de match que enviar-produccion: granel matchea por producto y fraccionado
  // por rubro (con fallback a producto cuando el ítem no trae rubro).
  for (const it of (plan.items || [])) {
    if (!it || !it.reservaMovimiento || it.reservaMovimiento.numeroMovimiento == null) continue;
    if (it.producto === orden.producto || (it.rubro || it.producto) === orden.producto) {
      nums.add(String(it.reservaMovimiento.numeroMovimiento));
    }
  }
  return [...nums].filter(n => activas.has(n));
}

// Saldo total reservado del plan sobre el ledger reservas[]. Los callers viejos que pasan
// una reserva única siguen usando saldoReserva; los nuevos pasan el plan entero.
function saldoReservaPlan(plan) {
  return saldoLedger(migrarReservas(plan).reservas);
}

// Saldo pendiente de la porción de un ítem, acotado al saldo global del componente
// (si antes se anuló la reserva completa, el ítem ya no tiene nada que devolver).
function saldoItemReserva(reserva, itemId) {
  const devTotal = devueltoPorComponente(reserva, null);
  const devItem  = devueltoPorComponente(reserva, itemId);
  const out = [];
  for (const l of ((reserva && reserva.lineas) || [])) {
    const plu      = String(l.plu);
    const asignado = Number((l.porItem || {})[itemId]) || 0;
    if (asignado <= 0) continue;
    const pendItem   = asignado - (devItem.get(plu) || 0);
    const pendGlobal = (Number(l.cantidad) || 0) - (devTotal.get(plu) || 0);
    const cantidad   = redondear4(Math.min(pendItem, pendGlobal));
    if (cantidad > 0) out.push({ plu, nombre: l.nombre, cantidad });
  }
  return out;
}

// ── Sincronización de la reserva contra el log de movimientos ──────────────────
// El plan y el log son dos registros distintos: revertir un movimiento desde el historial
// (POST /api/stock/movimientos/:id/revertir) mueve el stock en SiGA pero no toca
// plan.reserva, así que el plan puede quedar diciendo "reservado" cuando físicamente no
// queda nada en el depósito de reserva. Estos helpers recalculan el saldo real a partir
// del log y ponen el estado del plan al día.

// Saldo neto por PLU en el depósito de reserva, según los movimientos del log.
// Un movimiento y su reversión se cancelan entre sí, así que el par entero se descarta:
// se excluye tanto al registro revertido como a la reversión que lo deshizo. Se excluye
// por PAREJA (y no por "tiene revierteA") para que una reversión de una reversión —o una
// reversión cuyo enlace no se pudo escribir— siga contando: lo que importa es qué quedó
// físicamente en el depósito.
function saldoReservaSegunLog(fecha, reserva) {
  const saldo      = new Map();
  const depReserva = Number(reserva && reserva.depDestino);
  if (!fecha || !esIdDeposito(depReserva)) return saldo;

  const log = leerMovLog();
  const anulados = new Set();
  for (const reg of log) {
    if (reg && reg.revertidoPor) { anulados.add(reg.id); anulados.add(reg.revertidoPor); }
  }

  for (const reg of log) {
    if (!reg || reg.plan !== fecha || reg.estado !== 'confirmado' || anulados.has(reg.id)) continue;
    const lineas = reg.lineas || [];
    // Movimiento multi-depósito (el alta de producción): la cabecera no dice de dónde salió
    // cada cosa, cada línea trae su depósito y su signo. Sólo suman al saldo las líneas del
    // depósito de reserva, y suman tal cual (negativas = salieron de la reserva).
    if (lineas.some(l => l && l.idDeposito != null)) {
      for (const l of lineas) {
        if (Number(l.idDeposito) !== depReserva) continue;
        const plu = String(l.plu);
        saldo.set(plu, redondear4((saldo.get(plu) || 0) + (Number(l.cantidad) || 0)));
      }
      continue;
    }
    const signo = Number(reg.depDestino) === depReserva ?  1
                : Number(reg.depOrigen)  === depReserva ? -1 : 0;
    if (!signo) continue;
    for (const l of lineas) {
      const plu = String(l.plu);
      saldo.set(plu, redondear4((saldo.get(plu) || 0) + signo * (Number(l.cantidad) || 0)));
    }
  }
  return saldo;
}

// Pone el estado de la reserva al día contra el log. NO persiste: devuelve
// { plan, cambio, motivo } y guarda quien llama.
// motivo ∈ 'anulada' (el log dice que ya no queda nada reservado)
//        | 'parcial'  (queda saldo pero no es el que dice la reserva)
//        | 'sincronizada' (volvió a coincidir: se limpia la marca anterior).
function sincronizarReservaConLog(fecha, plan) {
  const reserva = plan && plan.reserva;
  if (!reserva || reserva.estado !== 'activa') return { plan, cambio: false };
  // Sin depósito de destino no se puede calcular el saldo: el log no dice a qué depósito
  // mirar y el saldo saldría vacío, lo que anularía la reserva por falta de datos en vez
  // de por evidencia. Ante la duda no se toca nada.
  if (!esIdDeposito(Number(reserva.depDestino))) return { plan, cambio: false };

  const saldoLog = saldoReservaSegunLog(fecha, reserva);
  const conSaldo = [...saldoLog.entries()]
    .filter(([, cant]) => cant > 0)
    .sort((a, b) => a[0].localeCompare(b[0]));
  const ahora = new Date().toISOString();

  // Nada con saldo positivo: los movimientos de la reserva se deshicieron. Se anula la
  // reserva y se borra el sello de los ítems, que ya no está respaldado por ningún
  // movimiento vivo en SiGA.
  if (!conSaldo.length) {
    const items = (plan.items || []).map(it => {
      if (!it || !it.reservaMovimiento) return it;
      const copia = { ...it };
      delete copia.reservaMovimiento;
      return copia;
    });
    // Un caso NO es una reversión: el alta de producción consume lo reservado y devuelve el
    // sobrante, así que también deja el depósito de reserva en cero. Se distingue con
    // porProduccion para que el motivo no mienta y para poder reactivar la reserva si después
    // se revierte ese alta (ver limpiarProduccionRegistrada).
    const porProduccion = !!(plan && plan.produccionRegistrada);
    const anulada = {
      ...reserva,
      estado: 'anulada',
      anuladaPorLog: {
        fecha: ahora,
        porProduccion,
        motivo: porProduccion
          ? 'El alta de producción consumió lo reservado y devolvió el sobrante al depósito principal'
          : 'Los movimientos de esta reserva fueron revertidos desde el historial'
      }
    };
    return { plan: { ...plan, items, reserva: anulada }, cambio: true, motivo: 'anulada' };
  }

  // Se compara contra el saldo pendiente de la reserva (líneas menos devoluciones), que es
  // justamente lo que debería quedar físicamente en el depósito de reserva: comparar contra
  // las líneas crudas marcaría como desincronizada a cualquier reserva con devoluciones.
  const esperado = new Map(saldoReserva(reserva).map(l => [String(l.plu), redondear4(l.cantidad)]));
  const coincide = conSaldo.length === esperado.size && conSaldo.every(([plu, cant]) => esperado.get(plu) === cant);

  if (coincide) {
    if (!reserva.desincronizada) return { plan, cambio: false };
    const limpia = { ...reserva };
    delete limpia.desincronizada;
    return { plan: { ...plan, reserva: limpia }, cambio: true, motivo: 'sincronizada' };
  }

  // Saldo parcial: NO se recalcula el porItem (no hay forma de saber a qué ítem le quedó
  // cada cosa). Se deja la reserva activa pero marcada para que la UI obligue a revisarla.
  const nombres = new Map(((reserva.lineas) || []).map(l => [String(l.plu), String(l.nombre || '')]));
  const saldoSegunLog = conSaldo.map(([plu, cantidad]) => ({ plu, nombre: nombres.get(plu) || '', cantidad }));
  return {
    plan: { ...plan, reserva: { ...reserva, desincronizada: { fecha: ahora, saldoSegunLog } } },
    cambio: true, motivo: 'parcial'
  };
}

// Sincroniza el plan de una fecha y lo persiste si cambió. Devuelve { plan, motivo }:
// plan es el vigente (sincronizado o no) y motivo el de sincronizarReservaConLog.
function sincronizarPlanConLog(fecha) {
  const planes = leerJSON(PLANES_PATH, {});
  const plan   = planes[fecha];
  if (!plan) return { plan: null, motivo: null };
  const sync = sincronizarReservaConLog(fecha, plan);
  if (!sync.cambio) return { plan, motivo: null };
  guardarJSON(PLANES_PATH, { ...planes, [fecha]: sync.plan });
  return { plan: sync.plan, motivo: sync.motivo || null };
}

// Borra la marca de "producción ya registrada" de un plan cuando se revierte el movimiento
// que la puso, para que se pueda volver a registrar. Si la reserva había quedado anulada
// justamente por ese consumo, vuelve a activa: la reversión devolvió los componentes al
// depósito de reserva. Los sellos por ítem (reservaMovimiento) no se reconstruyen —son
// informativos y no participan del cálculo del saldo, que sale de reserva.lineas.
// La marca de producción registrada guarda UN asiento por cada movimiento (una fecha se puede
// registrar en varias tandas: se carga producción nueva ese mismo día y se registra aparte).
// Forma nueva: plan.produccionRegistrada = { ...últimoAsiento, asientos: [{ numeroMovimiento,
// fecha, idRegistro, usuario, idSucursal, registros: [<id de produccion_registros.json>] }] }.
// Los campos sueltos duplican el ÚLTIMO asiento para no romper a quien todavía lee
// produccionRegistrada.numeroMovimiento directo (el front y el resumen de la conciliación).
// Marca vieja (objeto suelto sin `asientos`): se normaliza a un único asiento sin lista de
// registros; sin lista, el asiento cubre TODA la fecha (el bloqueo total que había antes).
function asientosProduccion(plan) {
  const m = plan && plan.produccionRegistrada;
  if (!m) return [];
  if (Array.isArray(m.asientos)) return m.asientos;
  return [{
    numeroMovimiento: m.numeroMovimiento ?? null, fecha: m.fecha ?? null,
    idRegistro: m.idRegistro ?? null, usuario: m.usuario ?? null, idSucursal: m.idSucursal ?? null,
    registros: Array.isArray(m.registros) ? m.registros : []
  }];
}

// Set (ids en string) de los registros de producción de la fecha que ya fueron asentados. Un
// asiento sin lista de registros (marca vieja) cubre todos los registros de la fecha.
function registrosYaRegistrados(plan, registrosFecha) {
  const set = new Set();
  for (const a of asientosProduccion(plan)) {
    const lista = (Array.isArray(a.registros) && a.registros.length) ? a.registros : registrosFecha.map(r => r.id);
    for (const rid of lista) set.add(String(rid));
  }
  return set;
}

// idRegistro acota la limpieza al asiento de ESE movimiento: quita sólo ese asiento y deja los
// demás intactos (sus registros vuelven a "pendiente de registrar" al desaparecer de la lista).
// Si era el único asiento, el campo queda como antes de cualquier registro. Sin idRegistro se
// borra la marca entera (compatibilidad con reversiones viejas). Devuelve null o el error.
function limpiarProduccionRegistrada(fecha, idRegistro) {
  try {
    const planes = leerJSON(PLANES_PATH, {});
    const plan   = planes[fecha];
    const marca  = plan && plan.produccionRegistrada;
    if (!marca) return null;
    const asientos  = asientosProduccion(plan);
    const restantes = idRegistro
      ? asientos.filter(a => String(a.idRegistro) !== String(idRegistro))
      : [];
    // El idRegistro no correspondía a ningún asiento de este plan: no se toca nada.
    if (idRegistro && restantes.length === asientos.length) return null;
    const copia = { ...plan };
    if (!restantes.length) {
      delete copia.produccionRegistrada;
    } else {
      const ultimo = restantes[restantes.length - 1];
      copia.produccionRegistrada = { ...ultimo, asientos: restantes };
    }
    // Se levanta el estado terminal de los ítems sellados por el movimiento revertido: con
    // idRegistro sólo los de ESE asiento; sin idRegistro (reversión vieja que borra la marca
    // entera) todos. Al perder produccionMovimiento vuelven a aportar componentes y a poder
    // reservarse. El match es por el mismo idRegistro con el que se selló en /registrar-movimiento.
    copia.items = (plan.items || []).map(it => {
      if (!it || !it.produccionMovimiento) return it;
      const delAsiento = idRegistro == null || String(it.produccionMovimiento.idRegistro) === String(idRegistro);
      if (!delAsiento) return it;
      const limpio = { ...it };
      delete limpio.produccionMovimiento;
      return limpio;
    });
    // La reserva sólo se reactiva cuando ya no queda ningún asiento (se revirtió toda la
    // producción que la había consumido). Con asientos restantes, sigue anulada.
    const r = copia.reserva;
    if (!restantes.length && r && r.estado === 'anulada' && r.anuladaPorLog && r.anuladaPorLog.porProduccion) {
      const reactivada = { ...r, estado: 'activa' };
      delete reactivada.anuladaPorLog;
      copia.reserva = reactivada;
    }
    guardarJSON(PLANES_PATH, { ...planes, [fecha]: copia });
    return null;
  } catch (e) {
    return `No se pudo borrar la marca de producción registrada del plan ${fecha}: ${e.message}`;
  }
}

// ── Firma de las órdenes del plan y detección de cambios ───────────────────────
// "Las órdenes del plan" son los ítems con cantidad > 0: id, producto, cantidad efectiva
// y el packaging elegido. El estado NO forma parte de la orden: que un ítem pase a
// 'listo' no es un cambio de plan (sólo dispara la devolución de su porción).
function itemsFirmables(items) {
  return (items || [])
    // Los ítems ya producidos y recepcionados (produccionMovimiento) salieron del circuito:
    // no forman parte de las órdenes a reservar, así que tampoco cuentan para la firma. Sin
    // esto, sellar un ítem al registrar producción cambiaría la firma y dispararía un falso
    // "el plan cambió" (el guard de reserva 'activa' lo tapa en el flujo normal, pero la
    // firma tiene que ser coherente de todos modos).
    .filter(it => !(it && it.produccionMovimiento))
    .map(it => ({
      id: it.id,
      idProducto: String(it.idProducto ?? '').replace(/\D/g, ''),
      producto: String(it.producto || ''),
      cantidad: redondear4(it.cantConfirmada ?? it.cantSugerida ?? 0),
      envase: pluSeleccionado(it.envase),
      tapa: pluSeleccionado(it.tapa)
    }))
    .filter(it => it.cantidad > 0)
    // Orden estable por id: el orden del array (drag & drop de prioridades) no debe
    // cambiar la firma.
    .sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0) || String(a.id).localeCompare(String(b.id)));
}

// Hash corto y estable de las órdenes del plan.
function firmaPlanReserva(items) {
  const base = itemsFirmables(items).map(it => [it.id, it.idProducto, it.cantidad, it.envase, it.tapa]);
  return crypto.createHash('sha1').update(JSON.stringify(base)).digest('hex').slice(0, 12);
}

function descripcionPackaging(envase, tapa) {
  return `envase ${envase || '—'} / tapa ${tapa || '—'}`;
}

// Compara las órdenes de hoy contra el snapshot guardado al reservar.
// tipo ∈ 'agregado' | 'quitado' | 'cantidad' | 'packaging'.
function cambiosDelPlan(items, reserva) {
  if (!reserva || reserva.estado !== 'activa') return { hayCambios: false, detalle: [] };
  // Reserva vieja, guardada antes de que existiera la firma: no hay con qué comparar.
  // Se considera cambiada para no dejar el plan bloqueado para siempre.
  if (!reserva.firma || !Array.isArray(reserva.items)) return { hayCambios: true, detalle: [] };

  const actual = itemsFirmables(items);
  if (reserva.firma === firmaPlanReserva(items)) return { hayCambios: false, detalle: [] };

  const antesPorId = new Map(reserva.items.map(it => [String(it.id), it]));
  const detalle = [];
  for (const a of actual) {
    const p = antesPorId.get(String(a.id));
    if (!p) {
      detalle.push({ tipo: 'agregado', itemId: a.id, producto: a.producto, antes: null, ahora: a.cantidad });
      continue;
    }
    const cantAntes = redondear4(p.cantidad);
    if (cantAntes !== a.cantidad) {
      detalle.push({ tipo: 'cantidad', itemId: a.id, producto: a.producto, antes: cantAntes, ahora: a.cantidad });
    }
    const envAntes = pluSeleccionado(p.envase), tapaAntes = pluSeleccionado(p.tapa);
    if (envAntes !== a.envase || tapaAntes !== a.tapa) {
      detalle.push({ tipo: 'packaging', itemId: a.id, producto: a.producto,
                     antes: descripcionPackaging(envAntes, tapaAntes), ahora: descripcionPackaging(a.envase, a.tapa) });
    }
  }
  const idsActuales = new Set(actual.map(a => String(a.id)));
  // Un ítem que se produjo y recepcionó después de reservar (produccionMovimiento) desaparece
  // de `actual` (itemsFirmables lo excluye), pero eso NO es "quitar una orden": el ítem cerró
  // su circuito. No debe reportarse como cambio para no pedir actualizar la reserva por algo
  // que ya se consumió.
  const sellados = new Set((items || []).filter(it => it && it.produccionMovimiento).map(it => String(it.id)));
  for (const p of reserva.items) {
    if (idsActuales.has(String(p.id)) || sellados.has(String(p.id))) continue;
    detalle.push({ tipo: 'quitado', itemId: p.id, producto: String(p.producto || ''), antes: redondear4(p.cantidad), ahora: null });
  }
  // hayCambios sale del detalle, no de la firma: cuando la firma difiere SÓLO porque se
  // excluyó un ítem ya producido (itemsFirmables lo saca), el detalle queda vacío y no hay
  // nada real que actualizar. Sin esto, sellar un ítem con la reserva aún activa dispararía
  // un falso "el plan cambió".
  return { hayCambios: detalle.length > 0, detalle };
}

// Componentes que todavía deben estar en el depósito de reserva: se descuenta la porción
// de los ítems en estado 'listo', que ya se devolvieron al origen y no se re-reservan.
function componentesPendientes(componentes, items) {
  const listos = new Set((items || []).filter(it => it.estado === 'listo').map(it => String(it.id)));
  const out = [];
  for (const c of (componentes || [])) {
    const porItem = {};
    let necesario = 0;
    for (const [id, cant] of Object.entries(c.porItem || {})) {
      if (listos.has(String(id))) continue;
      const n = redondear4(cant);
      if (n <= 0) continue;
      porItem[id] = n;
      necesario = redondear4(necesario + n);
    }
    if (necesario > 0) out.push({ ...c, necesario, porItem });
  }
  return out;
}

// Diferencia entre lo que hoy hay reservado y lo que el plan necesita.
// delta > 0 → mover origen → destino; delta < 0 → devolver destino → origen.
function deltaReserva(componentesObjetivo, reserva) {
  const dev      = devueltoPorComponente(reserva, null);
  const objetivo = new Map((componentesObjetivo || []).map(c => [String(c.plu), c]));
  const lineas   = new Map(((reserva && reserva.lineas) || []).map(l => [String(l.plu), l]));
  const out = [];
  for (const plu of new Set([...objetivo.keys(), ...lineas.keys()])) {
    const c = objetivo.get(plu), l = lineas.get(plu);
    const obj   = redondear4(c ? c.necesario : 0);
    const res   = redondear4((Number(l && l.cantidad) || 0) - (dev.get(plu) || 0));
    const delta = redondear4(obj - res);
    if (delta === 0) continue;
    out.push({ plu, nombre: (c && c.nombre) || (l && l.nombre) || '', reservado: res, objetivo: obj, delta });
  }
  return out.sort((a, b) => a.nombre.localeCompare(b.nombre));
}

// Reserva reescrita después de un ajuste. IMPORTANTE: saldoReserva()/saldoItemReserva()
// calculan el saldo como lineas[].cantidad − devoluciones. Las líneas nuevas ya vienen
// netas (el objetivo excluye a los ítems listos, que son justamente los que generaron las
// devoluciones), así que si se dejaran las devoluciones viejas se restarían dos veces.
// Por eso se archivan en devolucionesPrevias y devoluciones arranca vacío: tras el ajuste
// lineas[].cantidad es exactamente lo que quedó físicamente en el depósito de reserva.
function reservaAjustada(reserva, { lineas, firma, items, ajustes }) {
  return {
    ...reserva,
    lineas,
    devoluciones: [],
    devolucionesPrevias: [...(reserva.devolucionesPrevias || []), ...(reserva.devoluciones || [])],
    ajustes: [...(reserva.ajustes || []), ...(ajustes || [])],
    firma, items,
    // Sin líneas no queda nada reservado: la reserva se cierra sola.
    estado: lineas.length ? 'activa' : 'anulada'
  };
}

// ── Sello del comprobante en cada línea del plan ───────────────────────────────
// El número de comprobante de SiGA ya se guarda a nivel reserva; el sello lo baja al ítem
// para poder mostrar con qué movimiento se cubrió cada línea del plan.
// IMPORTANTE: 'reservaMovimiento' y 'reservaDevuelta' NO entran en itemsFirmables(), así
// que sellar un ítem no altera firmaPlanReserva() ni dispara cambiosDelPlan().

// Ítems que aportaron al menos un componente (los que aparecen en algún porItem).
// Sirve tanto para los componentes del plan como para las líneas guardadas en la reserva.
function itemsDeComponentes(lineas) {
  const ids = new Set();
  for (const l of (lineas || [])) {
    for (const [id, cant] of Object.entries((l && l.porItem) || {})) {
      if ((Number(cant) || 0) > 0) ids.add(String(id));
    }
  }
  return ids;
}

// Escribe el sello en los ítems indicados. `campo` es 'reservaMovimiento' (salida hacia el
// depósito de reserva) o 'reservaDevuelta' (vuelta al principal). Devuelve un array nuevo:
// los ítems no sellados se conservan tal cual y nunca se muta el original.
function sellarItems(items, ids, campo, sello, { limpiarDevuelta = false } = {}) {
  const buscados = new Set([...(ids || [])].map(String));
  if (!buscados.size) return items || [];
  return (items || []).map(it => {
    if (!buscados.has(String(it.id))) return it;
    const sellado = { ...it, [campo]: sello };
    // Si el ítem se vuelve a reservar, la devolución previa ya no aplica.
    if (limpiarDevuelta) delete sellado.reservaDevuelta;
    return sellado;
  });
}

// Detalle por línea del plan: qué componentes le tocan de la reserva vigente y con qué
// comprobante se movieron. Incluye a los ítems ya sellados aunque no les quede porción
// (por ejemplo los que pasaron a 'listo' y devolvieron lo suyo).
function detalleItemsReserva(items, reserva) {
  const lineas = (reserva && reserva.lineas) || [];
  const out = [];
  for (const it of (items || [])) {
    const id = String(it.id);
    const componentes = lineas
      .map(l => ({ plu: String(l.plu), nombre: String(l.nombre || ''), cantidad: redondear4(Number((l.porItem || {})[id]) || 0) }))
      .filter(c => c.cantidad > 0);
    if (!componentes.length && !it.reservaMovimiento && !it.reservaDevuelta) continue;
    out.push({
      itemId: it.id,
      producto: String(it.producto || ''),
      reservaMovimiento: it.reservaMovimiento || null,
      reservaDevuelta: it.reservaDevuelta || null,
      componentes
    });
  }
  return out;
}

// Devuelve al depósito principal el saldo de la reserva (todo, o la porción de un ítem).
// No persiste: retorna la reserva actualizada para que la guarde quien llama.
async function ejecutarDevolucionReserva(plan, itemId) {
  const cr = cfgReserva();
  const reserva = plan && plan.reserva;
  if (!reserva || reserva.estado !== 'activa') return { error: 'El plan no tiene una reserva activa' };

  // Sin itemId se devuelve la reserva entera, así que alcanza con que UNA de sus órdenes esté
  // producida para que la devolución quede mal; con itemId sólo importa ese ítem.
  const producidas = ordenesProducidasDeReserva(
    itemId == null ? reserva : { ordenes: [itemId] }, plan && plan.items);
  if (producidas.length) {
    return { error: motivoBloqueoProduccion(producidas, 'devolver la reserva'), yaProducido: true };
  }

  // La devolución invierte los depósitos con los que se hizo la reserva. El config sólo
  // sirve de fallback para reservas viejas guardadas antes de poder elegirlos en el modal.
  // La sucursal sale del mismo lugar: la de la reserva, NUNCA la que diga config.json hoy
  // (si se cambió de sucursal después de reservar, devolver con la de config movería el
  // stock en la sucursal equivocada).
  const idSucursal = sucursalDeReserva(reserva);
  const depOrigen  = idDepositoODefault(reserva.depDestino, cr.depositoReserva);
  const depDestino = idDepositoODefault(reserva.depOrigen,  cr.depositoPrincipal);
  if (!esIdDeposito(depOrigen) || !esIdDeposito(depDestino)) return { error: ERR_RESERVA_SIN_CONFIG };

  const lineas = itemId == null ? saldoReserva(reserva) : saldoItemReserva(reserva, itemId);
  if (!lineas.length) {
    return { error: itemId == null ? 'La reserva no tiene saldo pendiente de devolución'
                                   : 'El ítem no tiene saldo pendiente de devolución' };
  }

  const poolW = await getPoolStock();
  // La devolución es la contracara del apartado, así que va con el MISMO tipo que la reserva:
  // el par apartado/devuelto queda emparejado en SiGA bajo BIENESUSO y el depósito de reserva
  // cierra en cero con comprobantes del mismo tipo.
  const idTipoMovimiento = cr.idTipoMovimiento;
  const observacion = `PLAN ${plan.fecha || ''} DEVOL ${depOrigen}>${depDestino}${itemId == null ? '' : ` item ${itemId}`}`.trim().slice(0, 200);
  const r = await ejecutarYRegistrar({
    origen: 'devolucion', plan: plan.fecha || null, itemId,
    idSucursal, depOrigen, depDestino, idEmpleado: cr.idEmpleado,
    idTipoMovimiento, usuario: cr.usuario, observacion, lineas
  }, () => trasladarStock(poolW, {
    idSucursal, depOrigen, depDestino,
    idTipoMovimiento, usuario: cr.usuario, idEmpleado: cr.idEmpleado,
    observacion,
    lineas: lineas.map(l => ({ idProducto: l.plu, cantidad: l.cantidad }))
  }));
  const numero = r.numeroMovimiento;

  const fecha = new Date().toISOString();
  const devoluciones = [...(reserva.devoluciones || []), { numeroMovimiento: numero, fecha, itemId: itemId == null ? null : itemId, lineas }];
  const conDevolucion = { ...reserva, devoluciones };
  // Sin itemId es una anulación explícita; con itemId se cierra sola cuando no queda saldo.
  const estado = (itemId == null || !saldoReserva(conDevolucion).length) ? 'anulada' : 'activa';
  // depOrigen/depDestino son los de ESTA devolución (los de la reserva invertidos): quien
  // llama los necesita para sellar el ítem con el movimiento completo.
  return { numeroMovimiento: numero, lineas, reserva: { ...conDevolucion, estado },
           depOrigen, depDestino, idRegistro: r.idRegistro, logError: r.logError };
}

app.get('/api/plan/:fecha/reserva', apiRoute(async req => {
  const fecha = safeDate(req.params.fecha);
  const s     = await resolverSucursal(req.query.idSucursal);
  if (s.error) return { error: s.error };
  const cr    = s.cr;
  // Auto-reparación: antes de armar la respuesta se contrasta la reserva contra el log de
  // movimientos y, si hace falta, se corrige y se persiste el plan. Así un plan que quedó
  // marcado como reservado después de revertir sus movimientos desde el historial se
  // arregla solo al abrir el modal, sin tocar el JSON a mano.
  // LIMITACIÓN CONOCIDA: planes.json está indexado SÓLO por fecha, no por fecha+sucursal.
  // Hay un único plan por día para todas las sucursales, así que cambiar de sucursal no
  // cambia el plan que se lee acá: lo único que distingue una sucursal de otra es la
  // reserva, que congela la suya en reserva.idSucursal (ver sucursalDeReserva). Indexar por
  // fecha+sucursal sería una migración del archivo y queda fuera de este cambio.
  const plan  = sincronizarPlanConLog(fecha).plan || { fecha, notas: '', items: [] };
  const { componentes, itemsSinFormula, sustituciones } = await componentesDePlan(plan.items || []);

  // Depósitos efectivos del preview: los del query si son válidos, si no los de config.
  // El destino puede quedar en null (config sin depósito de reserva y sin elección todavía).
  const depOrigen  = idDepositoODefault(req.query.depOrigen,  cr.depositoPrincipal);
  const depDestino = idDepositoODefault(req.query.depDestino, cr.depositoReserva);

  const depositos = await depositosActivos(cr.idSucursal);
  const stock     = await stockDeComponentes(cr, componentes.map(c => c.plu), depOrigen, depDestino);

  const depReservaCfg = depositos.find(d => Number(d.IdDeposito) === cr.depositoReserva);
  const nombreDepositoReserva = depReservaCfg ? String(depReservaCfg.NombreDeposito || '').trim() : null;

  // Estado de la reserva frente a las órdenes de hoy: firma, qué cambió y qué habría que
  // mover para poner la reserva al día.
  const reservaActiva = !!(plan.reserva && plan.reserva.estado === 'activa');
  const cambios = cambiosDelPlan(plan.items || [], plan.reserva);
  const delta   = reservaActiva
    ? deltaReserva(componentesPendientes(componentes, plan.items || []), plan.reserva)
    : [];

  // La reserva activa puede ser de otra sucursal. Acá NO se falla (es sólo lectura): se
  // informa para que la pantalla avise antes de intentar reservar, actualizar o devolver.
  const sucReserva = reservaActiva ? sucursalDeReserva(plan.reserva) : null;
  const sucursalDistinta = reservaActiva && sucReserva !== cr.idSucursal
    ? { deLaReserva: sucReserva, pedida: cr.idSucursal } : null;

  // Los IDs de depósito son POR sucursal: el preseleccionado de config puede no existir en
  // la sucursal pedida. En ese caso la selección vuelve a null en vez de exponer un ID que
  // no se puede usar.
  const activos   = new Set(depositos.map(d => Number(d.IdDeposito)));
  const depValido = d => (esIdDeposito(d) && activos.has(d) ? d : null);

  return {
    firma: {
      actual:    firmaPlanReserva(plan.items || []),
      reservada: reservaActiva ? (plan.reserva.firma || null) : null,
      hayCambios: cambios.hayCambios
    },
    cambios: cambios.detalle,
    delta,
    config: {
      idSucursal: cr.idSucursal, depositoPrincipal: cr.depositoPrincipal,
      depositoReserva: cr.depositoReserva, configurado: cr.depositoReserva != null, nombreDepositoReserva
    },
    depositos: depositos.map(d => ({
      idDeposito: Number(d.IdDeposito), nombre: String(d.NombreDeposito || '').trim(),
      tipoDeposito: d.TipoDeposito, disponibleVenta: d.DisponibleVenta
    })),
    seleccion: { depOrigen: depValido(depOrigen), depDestino: depValido(depDestino) },
    // Presente sólo cuando la reserva activa es de otra sucursal (si no, null).
    sucursalDistinta,
    componentes: componentes.map(c => {
      const s = stock.get(c.plu) || { origen: 0, destino: 0 };
      return {
        plu: c.plu, nombre: c.nombre, rubro: c.rubro, necesario: c.necesario,
        stockOrigen: redondear4(s.origen), stockDestino: redondear4(s.destino),
        faltante: redondear4(Math.max(0, c.necesario - s.origen)), porItem: c.porItem,
        origen: c.origen, reemplazaA: c.reemplazaA
      };
    }),
    reserva: plan.reserva || null,
    // Qué se movió por cada línea del plan y con qué comprobante de SiGA.
    porItem: detalleItemsReserva(plan.items || [], plan.reserva),
    itemsSinFormula,
    // Envases y tapas elegidos en la planificación que reemplazaron (o agregaron) componentes.
    sustituciones
  };
}));

app.get('/api/plan/:fecha/reservas-resumen', apiRoute(async req => {
  const fecha = safeDate(req.params.fecha);
  const { plan } = leerPlanReservas(fecha);
  if (!plan) return { fecha, reservas: [] };
  const porItem = new Map((plan.items || []).map(it => [String(it.id), it]));

  // Los ajustes de reserva NO dejan entrada en plan.reservas (viven en reserva.ajustes), pero
  // sí sellan ítems: si no se listan acá el sello queda sin botón para revertirlo y la orden
  // no se puede borrar más. Se arman con el mismo shape que una reserva del ledger.
  const ajustes = leerMovLog()
    .filter(m => m && m.plan === fecha && m.origen === 'ajuste' && m.estado === 'confirmado' && m.numeroMovimiento != null)
    .map(m => {
      const ordenes = (plan.items || [])
        .filter(it => it.reservaMovimiento && String(it.reservaMovimiento.numeroMovimiento) === String(m.numeroMovimiento))
        .map(it => it.id);
      return { m, ordenes };
    })
    .filter(({ ordenes }) => ordenes.length)
    .map(({ m, ordenes }) => {
      const producidas = ordenesProducidasDeReserva({ ordenes }, plan.items);
      const producidasPorId = new Map(producidas.map(p => [String(p.id), p.numeroMovimiento]));
      return {
        numeroMovimiento: m.numeroMovimiento, estado: 'activa', fecha: m.fechaHora,
        fechaPlanificacion: m.fechaHora, idRegistro: m.id, origen: 'ajuste',
        ordenes: ordenes.map(id => {
          const it = porItem.get(String(id));
          return { id, producto: it ? (it.producto || it.nombre || '') : '',
                   produccionMovimiento: producidasPorId.get(String(id)) ?? null };
        }),
        bloqueoProduccion: motivoBloqueoProduccion(producidas, 'revertir este movimiento'),
        productos: (m.lineas || []).map(l => ({ plu: String(l.plu), nombre: l.nombre || '', cantidad: l.cantidad })),
      };
    });

  return {
    fecha,
    reservas: (plan.reservas || []).map(r => {
      // bloqueoProduccion viaja al frontend para que el botón Revertir salga deshabilitado con
      // el motivo a la vista, en vez de dejar clickear y fallar recién contra el servidor.
      const producidas = ordenesProducidasDeReserva(r, plan.items);
      const producidasPorId = new Map(producidas.map(p => [String(p.id), p.numeroMovimiento]));
      return {
        numeroMovimiento: r.numeroMovimiento, estado: r.estado, fecha: r.fecha,
        fechaPlanificacion: r.fechaPlanificacion, idRegistro: r.idRegistro,
        ordenes: (Array.isArray(r.ordenes) ? r.ordenes : []).map(id => {
          const it = porItem.get(String(id));
          return { id, producto: it ? (it.producto || it.nombre || '') : '',
                   produccionMovimiento: producidasPorId.get(String(id)) ?? null };
        }),
        bloqueoProduccion: motivoBloqueoProduccion(producidas, 'revertir este movimiento'),
        productos: (r.lineas || []).map(l => ({ plu: String(l.plu), nombre: l.nombre || '', cantidad: l.cantidad })),
        origen: 'reserva',
      };
    }).concat(ajustes),
  };
}));

app.post('/api/plan/:fecha/reservar', apiRoute(async req => {
  const fecha = safeDate(req.params.fecha);
  const b     = req.body || {};
  const s     = await resolverSucursal(b.idSucursal);
  if (s.error) return { error: s.error };
  const cr    = s.cr;

  // Depósitos elegidos en el modal; si no vienen se usan los de config. Si vienen pero
  // son inválidos NO se cae al config: se avisa para no reservar en el depósito equivocado.
  const vinoOrigen  = b.depOrigen  !== undefined && b.depOrigen  !== null && b.depOrigen  !== '';
  const vinoDestino = b.depDestino !== undefined && b.depDestino !== null && b.depDestino !== '';
  const depOrigen   = vinoOrigen  ? Number(b.depOrigen)  : cr.depositoPrincipal;
  const depDestino  = vinoDestino ? Number(b.depDestino) : cr.depositoReserva;
  if (!vinoDestino && !cr.depositoReserva) return { error: ERR_RESERVA_SIN_CONFIG };
  if (!esIdDeposito(depOrigen) || !esIdDeposito(depDestino) || depOrigen === depDestino) {
    return { error: ERR_RESERVA_DEPOSITOS };
  }

  const activos = new Set((await depositosActivos(cr.idSucursal)).map(d => Number(d.IdDeposito)));
  if (!activos.has(depOrigen))  return { error: `El depósito de origen ${depOrigen} no existe o no está activo en la sucursal ${cr.idSucursal}` };
  if (!activos.has(depDestino)) return { error: `El depósito de destino ${depDestino} no existe o no está activo en la sucursal ${cr.idSucursal}` };

  // planes.json está indexado sólo por fecha (un plan por día para TODAS las sucursales,
  // ver el comentario en GET /api/plan/:fecha/reserva): lo único que ata el plan a una
  // sucursal es su reserva.
  const planes   = leerJSON(PLANES_PATH, {});
  const guardado = planes[fecha];
  if (!guardado || !(guardado.items || []).length) return { error: 'El plan no tiene ítems para reservar' };
  // Auto-reparación antes de decidir si ya hay una reserva activa: si los movimientos de la
  // reserva anterior se revirtieron desde el historial, acá queda 'anulada' y se puede
  // volver a reservar.
  const sync = sincronizarReservaConLog(fecha, guardado);
  if (sync.cambio) { planes[fecha] = sync.plan; guardarJSON(PLANES_PATH, planes); }
  let plan = planes[fecha];
  // Una reserva activa de otra sucursal bloquea todo: no se ejecuta ningún movimiento.
  // Los depósitos y el stock son por sucursal, así que operar acá dejaría la mercadería
  // en el lugar equivocado.
  const errSucursal = chequearSucursalReserva(plan.reserva, cr.idSucursal);
  if (errSucursal) return { error: errSucursal };
  // Con reserva activa no se vuelve a reservar, salvo que hayan cambiado las órdenes del
  // plan del día: en ese caso se ofrece actualizar la reserva moviendo sólo la diferencia.
  // Reserva incremental: sólo las órdenes que todavía no tienen sello de movimiento.
  const sinReservar = itemsSinReservar(plan.items);
  if (!sinReservar.length) {
    return { error: 'Todas las órdenes del plan ya están reservadas. Agregá productos nuevos para reservar.', yaReservado: true };
  }
  const { componentes } = await componentesDePlan(sinReservar);
  if (!componentes.length) {
    // Sin componentes puede ser porque el plan no tiene fórmulas, o porque TODOS los ítems
    // con fórmula ya fueron producidos y recepcionados (produccionMovimiento). Se distingue
    // recomputando los componentes de los ítems sellados sin el sello: si ahí sí hay
    // componentes, el plan no está vacío, simplemente ya se produjo todo.
    const producidos = (plan.items || []).filter(it => it && it.produccionMovimiento);
    if (producidos.length) {
      const sinSello = producidos.map(it => { const c = { ...it }; delete c.produccionMovimiento; return c; });
      const { componentes: hip } = await componentesDePlan(sinSello);
      if (hip.length) {
        const num = (plan.produccionRegistrada && plan.produccionRegistrada.numeroMovimiento)
          ?? producidos[0].produccionMovimiento.numeroMovimiento;
        return { error: `Todos los productos del plan ya fueron producidos y recepcionados (movimiento #${num}). Agregá productos nuevos al plan para reservar.`,
                 todoProducido: true };
      }
    }
    return { error: 'Ningún ítem del plan tiene componentes de fórmula para reservar' };
  }

  const stock = await stockDeComponentes(cr, componentes.map(c => c.plu), depOrigen, depDestino);
  // stockPrincipal se mantiene como alias de stockOrigen para no romper la UI vieja.
  const faltantes = componentes.map(c => {
    const s = stock.get(c.plu) || { origen: 0, destino: 0 };
    return { plu: c.plu, nombre: c.nombre, necesario: c.necesario,
             stockOrigen: redondear4(s.origen), stockPrincipal: redondear4(s.origen),
             faltante: redondear4(Math.max(0, c.necesario - s.origen)) };
  }).filter(f => f.faltante > 0);
  // Con permitirFaltante se reserva igual la cantidad necesaria completa (el depósito
  // de origen puede quedar en negativo); sin él no se escribe nada.
  if (faltantes.length && b.permitirFaltante !== true) {
    return { error: 'Hay componentes sin stock suficiente en el depósito de origen', faltantes };
  }

  const poolW = await getPoolStock();
  const observacion = `PLAN ${fecha} RESERVA ${depOrigen}>${depDestino}`.slice(0, 200);
  const r = await ejecutarYRegistrar({
    origen: 'reserva', plan: fecha, itemId: null,
    idSucursal: cr.idSucursal, depOrigen, depDestino, idEmpleado: cr.idEmpleado,
    idTipoMovimiento: cr.idTipoMovimiento, usuario: cr.usuario, observacion,
    lineas: componentes.map(c => ({ plu: c.plu, nombre: c.nombre, cantidad: c.necesario }))
  }, () => trasladarStock(poolW, {
    idSucursal: cr.idSucursal, depOrigen, depDestino,
    idTipoMovimiento: cr.idTipoMovimiento, usuario: cr.usuario, idEmpleado: cr.idEmpleado,
    observacion,
    lineas: componentes.map(c => ({ idProducto: c.plu, cantidad: c.necesario }))
  }));
  const numero = r.numeroMovimiento;

  const lineas = componentes.map(c => ({ plu: c.plu, nombre: c.nombre, cantidad: c.necesario, porItem: c.porItem }));
  plan = migrarReservas(plan);
  const ahora = new Date().toISOString();
  const nueva = {
    numeroMovimiento: numero, idRegistro: r.idRegistro ?? null, estado: 'activa',
    fecha: ahora, fechaPlanificacion: fecha,
    idSucursal: cr.idSucursal, depOrigen, depDestino,
    ordenes: [...itemsDeComponentes(componentes)],
    lineas, devoluciones: [],
  };
  plan.reservas = [...plan.reservas, nueva];
  plan.items = sellarItems(plan.items, itemsDeComponentes(componentes), 'reservaMovimiento',
    { numeroMovimiento: numero, fecha: ahora, idRegistro: r.idRegistro ?? null, depOrigen, depDestino },
    { limpiarDevuelta: true });
  // Compat: mantener plan.reserva apuntando a la última reserva activa para el código viejo.
  plan.reserva = { ...nueva, usuario: cr.usuario, firma: firmaPlanReserva(plan.items), items: itemsFirmables(plan.items), ajustes: [] };
  planes[fecha] = plan;
  guardarJSON(PLANES_PATH, planes);
  return conLogError({ ok: true, numeroMovimiento: numero, idSucursal: cr.idSucursal, depOrigen, depDestino, lineas, idRegistro: r.idRegistro }, r.logError);
}));

// Pone la reserva al día cuando cambiaron las órdenes del plan: mueve sólo la diferencia
// entre lo reservado y lo que el plan necesita ahora (puede salir un comprobante de
// reserva y otro de devolución en la misma llamada).
app.post('/api/plan/:fecha/reserva/actualizar', apiRoute(async req => {
  const fecha  = safeDate(req.params.fecha);
  const b      = req.body || {};
  const s      = await resolverSucursal(b.idSucursal);
  if (s.error) return { error: s.error };
  const cr     = s.cr;
  const planes = leerJSON(PLANES_PATH, {});
  const plan   = planes[fecha];
  if (!plan) return { error: 'Plan no encontrado' };

  const reserva = plan.reserva;
  if (!reserva || reserva.estado !== 'activa') {
    return { error: 'El plan no tiene una reserva activa; usá Reservar para crearla' };
  }
  // Igual que al reservar: si la reserva es de otra sucursal no se mueve nada.
  const errSucursal = chequearSucursalReserva(reserva, cr.idSucursal);
  if (errSucursal) return { error: errSucursal };
  // Los dos comprobantes del ajuste salen en la sucursal congelada en la reserva.
  const crReserva = { ...cr, idSucursal: sucursalDeReserva(reserva) };
  const n = reserva.numeroMovimiento;
  const { hayCambios } = cambiosDelPlan(plan.items || [], reserva);
  if (!hayCambios) {
    return { error: `Este plan ya tiene la reserva #${n} hecha. Para volver a reservar, modificá las órdenes del plan del día.`,
             yaReservado: true, numeroMovimiento: n };
  }

  // Los depósitos son los de la reserva original; el config sólo es fallback de reservas
  // viejas guardadas antes de poder elegirlos en el modal.
  const depOrigen  = idDepositoODefault(reserva.depOrigen,  cr.depositoPrincipal);
  const depDestino = idDepositoODefault(reserva.depDestino, cr.depositoReserva);
  if (!esIdDeposito(depOrigen) || !esIdDeposito(depDestino) || depOrigen === depDestino) {
    return { error: ERR_RESERVA_DEPOSITOS };
  }

  const { componentes } = await componentesDePlan(plan.items || []);
  const objetivo = componentesPendientes(componentes, plan.items || []);
  const delta    = deltaReserva(objetivo, reserva);

  const nuevasLineas = objetivo.map(c => ({ plu: c.plu, nombre: c.nombre, cantidad: c.necesario, porItem: c.porItem }));
  const firma = firmaPlanReserva(plan.items || []);
  const items = itemsFirmables(plan.items || []);

  if (!delta.length) {
    // El plan cambió de una forma que no altera los componentes (por ejemplo se eligió un
    // envase que otro ítem ya usaba): no hay nada que mover, pero igual se refresca la
    // firma para dejar de avisar por un cambio que la reserva ya contempla.
    plan.reserva = reservaAjustada(reserva, { lineas: nuevasLineas, firma, items, ajustes: [] });
    guardarJSON(PLANES_PATH, planes);
    return { error: 'No hay diferencias que mover: la reserva ya coincide con el plan' };
  }

  const positivos = delta.filter(d => d.delta > 0);
  const negativos = delta.filter(d => d.delta < 0);

  if (positivos.length) {
    const stock = await stockDeComponentes(crReserva, positivos.map(d => d.plu), depOrigen, depDestino);
    const faltantes = positivos.map(d => {
      const s = stock.get(d.plu) || { origen: 0, destino: 0 };
      return { plu: d.plu, nombre: d.nombre, necesario: d.delta,
               stockOrigen: redondear4(s.origen), stockPrincipal: redondear4(s.origen),
               faltante: redondear4(Math.max(0, d.delta - s.origen)) };
    }).filter(f => f.faltante > 0);
    if (faltantes.length && b.permitirFaltante !== true) {
      return { error: 'Hay componentes sin stock suficiente en el depósito de origen', faltantes };
    }
  }

  const poolW  = await getPoolStock();
  // Los dos sentidos del ajuste corrigen una reserva ya hecha, así que van con el tipo de
  // producción (REC-SUC), no con el del apartado y su devolución (BIENESUSO).
  const tipoAjuste = tipoMovimientoAjusteReserva();
  const base   = { idSucursal: crReserva.idSucursal, idTipoMovimiento: tipoAjuste, usuario: cr.usuario, idEmpleado: cr.idEmpleado };
  const ahora  = new Date().toISOString();
  const movimientos = [], ajustes = [], logErrores = [];

  // Ítems que participan de cada sentido del ajuste. Los que suman salen por el comprobante
  // de reserva; los que sólo intervienen en el sentido inverso quedan con el de devolución.
  // Para el sentido inverso se miran también las líneas viejas: un componente puede bajar
  // justamente porque el ítem que lo pedía ya no está en el objetivo.
  const plusPositivos = new Set(positivos.map(d => String(d.plu)));
  const plusNegativos = new Set(negativos.map(d => String(d.plu)));
  const idsReserva    = itemsDeComponentes(objetivo.filter(c => plusPositivos.has(String(c.plu))));
  const idsDevolucion = new Set([
    ...itemsDeComponentes((reserva.lineas || []).filter(l => plusNegativos.has(String(l.plu)))),
    ...itemsDeComponentes(objetivo.filter(c => plusNegativos.has(String(c.plu))))
  ].filter(id => !idsReserva.has(id)));

  // Los dos sentidos del ajuste salen como dos comprobantes distintos y por lo tanto dejan
  // dos registros separados en el log, ambos con origen 'ajuste' (el sentido se distingue
  // por los depósitos: el de devolución los lleva invertidos).
  if (positivos.length) {
    const lineasMov   = positivos.map(d => ({ plu: d.plu, nombre: d.nombre, cantidad: d.delta }));
    const observacion = `PLAN ${fecha} AJUSTE+ ${depOrigen}>${depDestino}`.slice(0, 200);
    const r = await ejecutarYRegistrar({
      origen: 'ajuste', plan: fecha, itemId: null,
      idSucursal: crReserva.idSucursal, depOrigen, depDestino, idEmpleado: cr.idEmpleado,
      idTipoMovimiento: tipoAjuste, usuario: cr.usuario, observacion, lineas: lineasMov
    }, () => trasladarStock(poolW, {
      ...base, depOrigen, depDestino, observacion,
      lineas: lineasMov.map(l => ({ idProducto: l.plu, cantidad: l.cantidad }))
    }));
    logErrores.push(r.logError);
    movimientos.push({ numeroMovimiento: r.numeroMovimiento, sentido: 'reserva', idRegistro: r.idRegistro });
    ajustes.push({ numeroMovimiento: r.numeroMovimiento, fecha: ahora, sentido: 'reserva', lineas: lineasMov });
    // El ítem guarda el ÚLTIMO movimiento que lo cubre; el histórico completo queda en
    // reserva.ajustes y en el log de movimientos.
    plan.items = sellarItems(plan.items, idsReserva, 'reservaMovimiento',
      { numeroMovimiento: r.numeroMovimiento, fecha: ahora, idRegistro: r.idRegistro ?? null, depOrigen, depDestino },
      { limpiarDevuelta: true });
  }

  if (negativos.length) {
    const lineasMov   = negativos.map(d => ({ plu: d.plu, nombre: d.nombre, cantidad: redondear4(Math.abs(d.delta)) }));
    const observacion = `PLAN ${fecha} AJUSTE- ${depDestino}>${depOrigen}`.slice(0, 200);
    const r = await ejecutarYRegistrar({
      origen: 'ajuste', plan: fecha, itemId: null,
      idSucursal: crReserva.idSucursal, depOrigen: depDestino, depDestino: depOrigen, idEmpleado: cr.idEmpleado,
      idTipoMovimiento: tipoAjuste, usuario: cr.usuario, observacion, lineas: lineasMov
    }, () => trasladarStock(poolW, {
      ...base, depOrigen: depDestino, depDestino: depOrigen, observacion,
      lineas: lineasMov.map(l => ({ idProducto: l.plu, cantidad: l.cantidad }))
    }));
    logErrores.push(r.logError);
    movimientos.push({ numeroMovimiento: r.numeroMovimiento, sentido: 'devolucion', idRegistro: r.idRegistro });
    ajustes.push({ numeroMovimiento: r.numeroMovimiento, fecha: ahora, sentido: 'devolucion', lineas: lineasMov });
    // Ítems que sólo intervinieron en este sentido: no recibieron nada, así que se sellan
    // con el comprobante del ajuste pero conservan su devolución previa si la tenían.
    plan.items = sellarItems(plan.items, idsDevolucion, 'reservaMovimiento',
      { numeroMovimiento: r.numeroMovimiento, fecha: ahora, idRegistro: r.idRegistro ?? null, depOrigen: depDestino, depDestino: depOrigen });
  }

  plan.reserva = reservaAjustada(reserva, { lineas: nuevasLineas, firma, items, ajustes });
  guardarJSON(PLANES_PATH, planes);
  return conLogError({ ok: true, movimientos, delta }, ...logErrores);
}));

app.post('/api/plan/:fecha/reserva/devolver', apiRoute(async req => {
  const fecha  = safeDate(req.params.fecha);
  const planes = leerJSON(PLANES_PATH, {});
  const plan   = planes[fecha];
  if (!plan) return { error: 'Plan no encontrado' };

  const b = req.body || {};
  const itemId = b.itemId == null || b.itemId === '' ? null : parseInt(b.itemId);
  if (itemId != null && !Number.isInteger(itemId)) return { error: 'itemId inválido' };

  const s = await resolverSucursal(b.idSucursal);
  if (s.error) return { error: s.error };
  // La devolución se ejecuta con la sucursal de la reserva (ver ejecutarDevolucionReserva);
  // si la pantalla está parada en otra, no se mueve nada y se avisa.
  const errSucursal = chequearSucursalReserva(plan.reserva, s.idSucursal);
  if (errSucursal) return { error: errSucursal };

  // El saldo por ítem se calcula ANTES de la devolución: después ya está todo devuelto.
  const reservaPrevia = plan.reserva;
  const r = await ejecutarDevolucionReserva(plan, itemId);
  if (r.error) return { error: r.error };
  plan.reserva = r.reserva;

  // Anulación total: se sella la devolución en todos los ítems que tenían saldo.
  // Con itemId el sello lo escribe quien dispara la devolución de ese ítem.
  if (itemId == null) {
    const conSaldo = (plan.items || []).filter(it => saldoItemReserva(reservaPrevia, it.id).length).map(it => it.id);
    plan.items = sellarItems(plan.items, conSaldo, 'reservaDevuelta',
      { numeroMovimiento: r.numeroMovimiento, fecha: new Date().toISOString(), idRegistro: r.idRegistro ?? null,
        depOrigen: r.depOrigen, depDestino: r.depDestino });
  }
  guardarJSON(PLANES_PATH, planes);
  return conLogError({ ok: true, numeroMovimiento: r.numeroMovimiento, lineas: r.lineas, idRegistro: r.idRegistro }, r.logError);
}));

// ── Conciliación: producción cargada vs reserva del día ────────────────────────
// Pantalla de verificación previa al alta de producción. Cruza tres registros que hoy
// viven separados: lo que se reservó (plan.reserva), lo que efectivamente se movió
// (movimientos_stock.json) y lo que el operario declaró haber producido y consumido
// (produccion_registros.json), para que las diferencias se vean ANTES de tocar stock.
// ES SÓLO LECTURA: no ejecuta ningún movimiento. Lo único que escribe es la
// sincronización de la reserva con el log, igual que GET /api/plan/:fecha/reserva.

const RE_ROL_ENVASADO    = /envasad/i;
const RE_NOMBRE_ETIQUETA = /^\s*etiquetas?\b/i;

// Un registro puede traer varios PLU juntos ("2892, 2891"): se separan y se sanitizan.
// 'ACT' (tarea extra) no tiene dígitos, así que devuelve [].
function plusDeRegistro(valor) {
  return String(valor ?? '').split(',').map(s => s.replace(/\D/g, '')).filter(Boolean);
}

// Mismo criterio que el CSV de producción (exportTerminadosCSV): el rol tiene que ser
// de envasado Y tener a alguien cargado. roles es la clave nueva; responsables, la vieja.
function tieneRolEnvasado(reg) {
  const roles = Array.isArray(reg && reg.roles) ? reg.roles
              : (Array.isArray(reg && reg.responsables) ? reg.responsables : []);
  return roles.some(x => RE_ROL_ENVASADO.test((x && x.rol) || '') && String((x && x.nombre) || '').trim());
}

// Carga manual: producción que se cargó a mano, sin orden del plan detrás (ordenId null). Por
// motivos externos no se planifica, así que no hay reserva contra la cual conciliarla: se
// resuelve entera en el depósito de recepción y queda fuera del cuadro reserva-vs-producción.
function esRegistroManual(reg) {
  return !reg || reg.ordenId === null || reg.ordenId === undefined || reg.ordenId === '';
}

// Motivo por el que un registro NO entra al alta de producción, o null si entra.
function motivoExclusionRegistro(reg) {
  if (String((reg && reg.plu) || '').trim().toUpperCase() === 'ACT') return 'tarea-extra';
  if (!tieneRolEnvasado(reg)) return 'sin-rol-envasado';
  return null;
}

// graneles es la clave nueva (varios por registro); si viene vacía manda el par suelto
// granel/nombreGranel/granelConsumido, que es como se cargaban antes.
function granelesDeRegistro(reg) {
  if (Array.isArray(reg && reg.graneles) && reg.graneles.length) return reg.graneles;
  if (reg && reg.nombreGranel) {
    return [{ granel: reg.granel || null, nombreGranel: reg.nombreGranel, granelConsumido: reg.granelConsumido }];
  }
  return [];
}

// Un granel cargado sin PLU sólo se puede resolver por nombre contra la fórmula del
// producto. Se compara sin distinguir mayúsculas ni espacios de más.
function pluComponentePorNombre(comps, nombre) {
  const buscado = String(nombre || '').trim().toLowerCase();
  if (!buscado) return '';
  const c = (comps || []).find(x => String(x.nombre || '').trim().toLowerCase() === buscado);
  return c ? c.plu : '';
}

// Etiqueta de la fórmula, con la misma regla que usa el CSV: rubro que contenga ETIQUET
// o nombre que empiece con "Etiqueta".
function etiquetaDeFormula(comps) {
  return (comps || []).find(c =>
    String(c.rubro || '').toUpperCase().includes('ETIQUET') || RE_NOMBRE_ETIQUETA.test(String(c.nombre || ''))
  ) || null;
}

// Tipo de un componente que quedó reservado y no se usó: no pasó por ningún registro de
// producción, así que sólo se lo puede clasificar por el nombre. null = no se pudo.
function tipoComponentePorNombre(nombre) {
  const t = tiposPackaging(nombre, '');
  if (t.esTapa)   return 'tapa';
  if (t.esEnvase) return 'envase';
  if (RE_NOMBRE_ETIQUETA.test(String(nombre || '')) || String(nombre || '').toUpperCase().includes('ETIQUET')) return 'etiqueta';
  return null;
}

function filaComponente(plu, nombre, tipo, reservado, usado) {
  const res = redondear4(reservado), uso = redondear4(usado);
  const diferencia = redondear4(uso - res);
  return { plu: plu || null, nombre: String(nombre || ''), tipo,
           reservado: res, usado: uso, diferencia,
           falta: diferencia > 0, sobra: diferencia < 0 };
}

// Consumo real declarado por los registros que entran al alta, agregado por componente.
// formulas es el Map padre → componentes de fórmula activa (puede venir vacío si SiGA no
// respondió: en ese caso no hay etiquetas y los graneles sin PLU quedan sin resolver).
// Devuelve { componentes: Map, avisos: [] }.
function consumoRealDeRegistros(incluidos, formulas) {
  const usados = new Map(), avisos = [];
  const sumar = (plu, nombre, tipo, cantidad) => {
    // Cantidad 0 (o negativa) no se acumula: es un componente que el operario puso en cero,
    // el mismo criterio con el que el CSV lo omite.
    if (!(cantidad > 0)) return;
    const clave = plu ? `plu:${plu}` : `nombre:${String(nombre || '').trim().toLowerCase()}`;
    const e = usados.get(clave) || { plu: plu || null, nombre: String(nombre || ''), tipo, usado: 0 };
    e.usado = redondear4(e.usado + cantidad);
    if (!e.nombre) e.nombre = String(nombre || '');
    usados.set(clave, e);
  };

  for (const reg of incluidos) {
    const cant     = Number(reg.cantFraccionada) || 0;
    const pluProd  = plusDeRegistro(reg.plu)[0] || null;
    const comps    = (pluProd && formulas.get(pluProd)) || [];
    const etiqueta = String(reg.nombre || reg.plu || 'sin nombre');

    for (const g of granelesDeRegistro(reg)) {
      const consumido    = Number(g && g.granelConsumido) || 0;
      const nombreGranel = String((g && g.nombreGranel) || '').trim();
      if (!consumido) continue;
      const pluGranel = String((g && g.granel) ?? '').replace(/\D/g, '') || pluComponentePorNombre(comps, nombreGranel);
      if (!pluGranel) {
        avisos.push(`Granel sin PLU: "${nombreGranel || 'sin nombre'}" (${consumido}) en ${etiqueta}. `
                  + 'No se puede dar de baja hasta identificarlo.');
      }
      sumar(pluGranel || null, nombreGranel || 'Granel sin identificar', 'granel', consumido);
    }

    // Envase y tapa se eligen al cargar la producción: 1 por unidad producida.
    if (reg.envase) sumar(String(reg.envase).replace(/\D/g, '') || null, reg.envaseNombre || `PLU ${reg.envase}`, 'envase', cant);
    if (reg.tapa)   sumar(String(reg.tapa).replace(/\D/g, '')   || null, reg.tapaNombre   || `PLU ${reg.tapa}`,   'tapa',   cant);

    const et = etiquetaDeFormula(comps);
    if (et) sumar(et.plu, et.nombre, 'etiqueta', redondear4(cant * (Number(et.cantPorUnidad) || 1)));
    else if (comps.length) avisos.push(`La fórmula de ${etiqueta} no tiene etiqueta: no se descuenta ninguna.`);
  }
  return { componentes: usados, avisos };
}

// Productos de la fecha agrupados para el alta. Los excluidos NO se esconden: se
// devuelven marcados con su motivo para que la pantalla muestre qué queda afuera.
// La clave incluye el motivo: un mismo PLU con registros incluidos y excluidos da dos
// filas, porque sólo una de las dos cantidades se va a dar de alta.
function productosDeConciliacion(registros) {
  const grupos = new Map();
  for (const reg of registros) {
    const pluTexto = String(reg.plu ?? '').trim();
    const plus     = plusDeRegistro(pluTexto);
    const excluido = motivoExclusionRegistro(reg);
    // La carga manual también parte la clave: un mismo PLU cargado a mano y por orden da dos
    // filas, porque sólo una de las dos se concilia contra la reserva.
    const manual   = esRegistroManual(reg);
    const clave    = `${pluTexto || `sin-plu-${reg.id}`}|${excluido || 'alta'}|${manual ? 'man' : 'plan'}`;
    const g = grupos.get(clave) || {
      plu: plus[0] || null, pluTexto, plus, nombre: String(reg.nombre || '').trim(),
      cantidad: 0, registros: 0, excluido, manual, detalle: []
    };
    if (!g.nombre) g.nombre = String(reg.nombre || '').trim();
    g.cantidad  = redondear4(g.cantidad + (Number(reg.cantFraccionada) || 0));
    g.registros += 1;
    // Detalle por registro individual (id + cantidad): sirve para separar lo ya registrado
    // de lo pendiente cuando una misma fecha se registra en varias tandas.
    g.detalle.push({ id: reg.id, cant: Number(reg.cantFraccionada) || 0 });
    grupos.set(clave, g);
  }
  return [...grupos.values()].sort((a, b) => a.nombre.localeCompare(b.nombre));
}

// idSucursal es la sucursal en la que está parada la pantalla: la conciliación es sólo
// lectura, así que no filtra nada, pero avisa si la reserva del día es de otra sucursal
// (planes.json tiene un único plan por fecha para todas: ver GET /api/plan/:fecha/reserva).
async function conciliacionProduccion(fecha, idSucursal) {
  const avisos    = [];
  const registros = leerJSON(PROD_REG_PATH, []).filter(r => r && r.fecha === fecha);
  if (!registros.length) avisos.push(`No hay producción cargada para el ${fecha}.`);

  // Asientos ya registrados de esta fecha: mapa registroId → { numeroMovimiento, fecha } para
  // marcar los productos y NO volver a descontar sus componentes. Se lee el plan una sola vez
  // acá (la reserva se sincroniza más abajo con la MISMA referencia).
  const planes = leerJSON(PLANES_PATH, {});
  let plan     = planes[fecha] || null;
  const regInfo = new Map();
  for (const a of asientosProduccion(plan)) {
    const lista = (Array.isArray(a.registros) && a.registros.length) ? a.registros : registros.map(r => r.id);
    for (const rid of lista) if (!regInfo.has(String(rid))) regInfo.set(String(rid), { numeroMovimiento: a.numeroMovimiento ?? null, fecha: a.fecha ?? null });
  }
  const estaRegistrado = r => regInfo.has(String(r.id));

  const productos = productosDeConciliacion(registros);
  // Marca de cada producto según sus registros: si TODOS están asentados → yaRegistrado; si sólo
  // algunos → parcial (y la cantidad pasa a ser sólo lo pendiente). Los ya registrados no
  // vuelven a aportar cantidad al alta ni sus componentes al descuento.
  for (const p of productos) {
    if (p.excluido) continue;
    const det = Array.isArray(p.detalle) ? p.detalle : [];
    const reg = det.filter(d => regInfo.has(String(d.id)));
    const pen = det.filter(d => !regInfo.has(String(d.id)));
    if (!reg.length) continue;
    const info = regInfo.get(String(reg[0].id)) || {};
    const asiento = { numeroMovimiento: info.numeroMovimiento ?? null, fecha: info.fecha ?? null };
    if (!pen.length) {
      p.yaRegistrado = asiento;
    } else {
      p.parcial = { ...asiento, cantidadRegistrada: redondear4(reg.reduce((s, d) => s + d.cant, 0)), registros: reg.length };
      p.cantidad  = redondear4(pen.reduce((s, d) => s + d.cant, 0));
      p.registros = pen.length;
    }
  }

  const incluidos = registros.filter(r => !motivoExclusionRegistro(r) && !estaRegistrado(r));
  const extras    = registros.filter(r => motivoExclusionRegistro(r) === 'tarea-extra').length;
  const sinRol    = registros.filter(r => motivoExclusionRegistro(r) === 'sin-rol-envasado').length;
  if (extras) avisos.push(`${extras} registro(s) son tareas extra (ACT): no dan de alta ningún producto.`);
  if (sinRol) avisos.push(`${sinRol} registro(s) no tienen el rol Envasado cargado y quedan fuera del alta.`);
  for (const p of productos) {
    if (p.plus.length > 1) {
      avisos.push(`El producto "${p.nombre || p.pluTexto}" tiene varios PLU cargados (${p.pluTexto}): `
                + `se usa ${p.plu} para la fórmula. Verificá cuál corresponde antes de dar el alta.`);
    } else if (!p.plu && !p.excluido) {
      avisos.push(`El producto "${p.nombre || p.pluTexto || 'sin nombre'}" no tiene un PLU numérico: no se puede dar de alta.`);
    }
  }

  // Fórmula activa de los productos que sí entran al alta: de ahí salen la etiqueta y el
  // PLU de los graneles cargados sólo por nombre. Si SiGA no responde la pantalla igual
  // se arma, con un aviso: el resto de la conciliación no depende de la base.
  let formulas = new Map();
  const plusFormula = [...new Set(incluidos.map(r => plusDeRegistro(r.plu)[0]).filter(Boolean))];
  if (plusFormula.length) {
    try { formulas = await componentesFormulaPorPadre(plusFormula); }
    catch (e) { avisos.push(`No se pudo consultar la fórmula en SiGA (${e.message}): las etiquetas quedaron fuera de la conciliación.`); }
  }

  // El consumo se parte en dos: lo planificado (se concilia contra la reserva) y la carga
  // manual (no tiene reserva detrás: se resuelve en el depósito de recepción). Si se mezclaran,
  // el consumo manual se comería la reserva de las órdenes planificadas del mismo PLU.
  const incluidosPlan   = incluidos.filter(r => !esRegistroManual(r));
  const incluidosManual = incluidos.filter(r =>  esRegistroManual(r));
  const consumo       = consumoRealDeRegistros(incluidosPlan, formulas);
  const consumoManual = consumoRealDeRegistros(incluidosManual, formulas);
  avisos.push(...consumo.avisos, ...consumoManual.avisos);
  if (incluidosManual.length) {
    avisos.push(`${incluidosManual.length} registro(s) son de carga manual (sin orden planificada): sus componentes `
              + 'se descuentan del depósito de recepción, donde también entra el terminado, y quedan fuera '
              + 'del cuadro de reserva vs. producción.');
  }

  // La reserva se pone al día contra el log antes de comparar: si los movimientos se
  // revirtieron desde el historial, el saldo que muestra el plan no es el real. (plan/planes
  // ya se leyeron arriba para la marca de producción registrada.)
  let reserva  = plan && plan.reserva ? plan.reserva : null;
  if (plan) {
    const sync = sincronizarReservaConLog(fecha, plan);
    if (sync.cambio) {
      guardarJSON(PLANES_PATH, { ...planes, [fecha]: sync.plan });
      plan    = sync.plan;
      reserva = sync.plan.reserva || null;
    }
  }
  if (!plan)         avisos.push(`No hay plan cargado para el ${fecha}: no hay reserva contra la cual conciliar.`);
  else if (!reserva) avisos.push(`El plan del ${fecha} no tiene reserva: todo el consumo figura como no reservado.`);
  else if (reserva.estado !== 'activa') {
    avisos.push(`La reserva del ${fecha} está ${reserva.estado}: no queda nada reservado y todo el consumo figura como no reservado.`);
  }
  if (reserva && reserva.desincronizada) {
    avisos.push('La reserva está desincronizada con el log de movimientos: revisá el saldo antes de dar de alta la producción.');
  }
  const sucReserva = reserva ? sucursalDeReserva(reserva) : null;
  const sucursalPedida = Number(idSucursal) || null;
  const sucursalDistinta = reserva && reserva.estado === 'activa' && sucursalPedida != null && sucReserva !== sucursalPedida
    ? { deLaReserva: sucReserva, pedida: sucursalPedida } : null;
  if (sucursalDistinta) {
    avisos.push(`La reserva del ${fecha} es de la sucursal ${sucReserva} y estás trabajando sobre la sucursal ${sucursalPedida}: `
              + 'cambiá a esa sucursal para devolver o ajustar lo reservado.');
  }

  // Sólo una reserva activa tiene stock realmente apartado en el depósito de reserva.
  // Saldo agregado sobre las reservas activas del ledger (no sólo plan.reserva, que es la
  // última reserva): así `reservado` coincide con el desglose por movimiento (porMovimiento)
  // y el comprobante "resto" no doble-cuenta el consumo cuando hay varias reservas en el día.
  // Las reservas YA CONCILIADAS (su ajuste de producción se registró: la mercadería ya se
  // recepcionó) salieron del circuito y quedan fuera de la conciliación. Si siguieran contando
  // aparecerían como sobrante fantasma —reservado > 0 y usado 0, porque sus registros de
  // producción ya están asentados— y se mezclarían con las reservas nuevas.
  const _pLedger    = migrarReservas(plan || {});
  const esConciliada = r => !!(r && r.ajuste && r.ajuste.conciliado);
  const reservasVivas = (_pLedger.reservas || []).filter(r => !esConciliada(r));
  // Comprobantes de las reservas ya conciliadas: sirven para marcarlas en el listado de
  // movimientos del día y que no se confundan con las que todavía esperan conciliación.
  const numsConciliados = new Set((_pLedger.reservas || [])
    .filter(r => esConciliada(r) && r.numeroMovimiento != null)
    .map(r => String(r.numeroMovimiento)));
  const saldo     = saldoLedger(reservasVivas);
  const reservado = new Map(saldo.map(l => [String(l.plu), redondear4(l.cantidad)]));
  if (numsConciliados.size) {
    avisos.push(`${numsConciliados.size} reserva(s) ya recepcionada(s) (movimiento${numsConciliados.size > 1 ? 's' : ''} `
              + `#${[...numsConciliados].join(', #')}) quedan fuera del resumen: su circuito ya cerró.`);
  }

  // Al reservado del plan se le suma el de las reservas MAYORISTAS vivas del mismo PLU: ese
  // stock ya esta fisicamente en el deposito de reserva. Sin esto la sala descontaria del
  // deposito principal algo que no esta ahi, y el principal quedaria en negativo por esa
  // cantidad. El aporte se publica aparte (reservadoMayorista) porque NO es un sobrante
  // devolvible ni figura en porMovimiento: quien arma el movimiento tiene que poder restarlo.
  // Solo cuentan las reservas de ESTA sucursal y de ESTE deposito de reserva: los IDs de
  // deposito son por sucursal, y lo apartado en otro deposito no esta donde la sala descuenta.
  const cr = cfgReserva();
  const cp = cfgProduccion();
  const depsPropuestos = depositosProduccion(cp, cr, reserva, {});
  const sucursalConciliada = Number(sucursalPedida || cr.idSucursal);
  const depReservaProd = Number(depsPropuestos.reserva);
  const mercSucursal = leerJSON(RESERVAS_MERC_PATH, [])
    .filter(r => r && r.estado === 'activa' && Number(r.idSucursal) === sucursalConciliada);
  // Lo apartado se lee NETO de lo que la produccion ya consumio: cada asiento anota contra que
  // reserva salio el granel del deposito de reserva (consumoMayorista). Se miran los asientos de
  // TODAS las fechas, no solo la de hoy: una reserva vive varios dias y lo que consumio la
  // produccion de ayer no puede volver a descontarse hoy. Los asientos viejos no traen el campo
  // y se leen como cero consumido, que es el comportamiento de siempre.
  const asientosTodos = Object.values(planes).flatMap(p => asientosProduccion(p));
  const mercReserva = mercSucursal.filter(r => Number(r.depDestino) === depReservaProd);
  const restanteMayorista = restanteMayoristaPorReserva(mercReserva, asientosTodos);
  // Y lo mismo para el intermedio "X Pedido": cuantas unidades le faltan entrar al deposito de
  // reserva a cada reserva viva. Lo que ya entro esta anotado en los asientos.
  const restantePedido = restantePedidoPorReserva(mercReserva, asientosTodos);
  const granelMayorista = granelReservadoNeto(mercReserva, asientosTodos);
  if (granelMayorista.size) {
    avisos.push(`Hay stock apartado por ${granelMayorista.size} producto(s) con reserva mayorista viva: `
              + 'ese consumo se descuenta del depósito de reserva.');
  }
  // Lo apartado en OTRO deposito no se cuenta (los IDs son por sucursal y ahi no es donde la
  // sala descuenta), pero callarlo seria peor: su consumo va a salir del deposito principal y
  // puede dejarlo en negativo. Pasa siempre que el dia no tiene reserva del plan, porque el
  // deposito de reserva cae al de config y ahi puede no haber ninguno configurado.
  for (const dep of new Set(mercSucursal.filter(r => Number(r.depDestino) !== depReservaProd).map(r => Number(r.depDestino)))) {
    const total = [...granelReservadoPorPlu(mercSucursal.filter(r => Number(r.depDestino) === dep)).values()]
      .reduce((s2, v) => redondear4(s2 + v), 0);
    avisos.push(`Hay ${total} unidad(es) apartadas por reservas mayoristas en el depósito ${dep}, distinto del `
              + `depósito de reserva de esta producción (${esIdDeposito(depReservaProd) ? depReservaProd : 'sin configurar'}): `
              + 'NO cuentan como reservado y su consumo se va a descontar del depósito principal.');
  }
  const mayoristaDe = plu => (plu ? (granelMayorista.get(String(plu)) || 0) : 0);

  const componentes = [], conUso = new Set();
  for (const u of consumo.componentes.values()) {
    if (u.plu) conUso.add(u.plu);
    componentes.push(filaComponente(u.plu, u.nombre, u.tipo,
      (u.plu ? (reservado.get(u.plu) || 0) : 0) + mayoristaDe(u.plu), u.usado));
  }
  // Reservado y no usado: sobra entero, hay que devolverlo al depósito principal.
  for (const l of saldo) {
    const plu = String(l.plu);
    if (conUso.has(plu)) continue;
    componentes.push(filaComponente(plu, l.nombre, tipoComponentePorNombre(l.nombre), l.cantidad + mayoristaDe(plu), 0));
  }
  // Los PLU que SOLO tienen reserva mayorista (sin reserva del plan ni consumo) no se agregan
  // como componente: no participan del movimiento y aparecerian como sobrante a devolver al
  // deposito principal, que es justo lo que hay que evitar.
  componentes.sort((a, b) => String(a.tipo || 'zz').localeCompare(String(b.tipo || 'zz')) || a.nombre.localeCompare(b.nombre));

  // Componentes de la carga manual: van aparte, siempre con reservado 0 (no hay nada apartado
  // para ellos) y se descuentan del depósito de recepción al registrar el movimiento.
  const componentesManual = [...consumoManual.componentes.values()]
    .map(u => filaComponente(u.plu, u.nombre, u.tipo, 0, u.usado))
    .sort((a, b) => String(a.tipo || 'zz').localeCompare(String(b.tipo || 'zz')) || a.nombre.localeCompare(b.nombre));

  const movimientos = leerMovLog()
    .filter(r => r && r.plan === fecha)
    .map(r => ({
      id: r.id, numeroMovimiento: r.numeroMovimiento ?? null, origen: r.origen,
      fechaHora: r.fechaHora, estado: r.estado,
      // Claves del comprobante en SiGA: con ellas la pantalla puede pedir su detalle real.
      idSucursal: r.idSucursal ?? null, idTipoMovimiento: r.idTipoMovimiento || null,
      depOrigen: r.depOrigen ?? null, depDestino: r.depDestino ?? null,
      lineas: (r.lineas || []).map(l => ({
        plu: String(l.plu), nombre: l.nombre == null ? '' : String(l.nombre), cantidad: redondear4(l.cantidad)
      })),
      // Una reversión se registra con el MISMO origen que el movimiento que deshace, así que
      // sin revierteA/revertidoPor es indistinguible de una reserva normal en el listado.
      // Se mandan los dos IDs para poder mostrar el par ("revertido por #32" / "reversión de #31").
      revertido: !!r.revertidoPor, revertidoPor: r.revertidoPor || null, revierteA: r.revierteA || null,
      // Marcas para no mezclar en el listado lo que ya cerró con lo que falta conciliar:
      //  · esRecepcion → el movimiento ES el alta de producción (terminados que entraron).
      //  · conciliado  → es una reserva cuyo ajuste de producción ya se registró.
      esRecepcion: r.origen === 'produccion',
      conciliado: r.numeroMovimiento != null && numsConciliados.has(String(r.numeroMovimiento))
    }))
    .reverse();   // el log se escribe con el más nuevo al final
  const pendientes = movimientos.filter(m => m.estado === 'pendiente').length;
  const fallidos   = movimientos.filter(m => m.estado === 'fallido').length;
  if (pendientes) {
    avisos.push(`Hay ${pendientes} movimiento(s) en estado pendiente para esta fecha: verificá a mano en SiGA si se ejecutaron antes de seguir.`);
  }
  if (fallidos) avisos.push(`Hay ${fallidos} movimiento(s) fallidos en el log de esta fecha (informativo: no movieron stock).`);

  const sinReservar = componentes.filter(c => c.reservado === 0 && c.usado > 0).length;
  if (sinReservar) avisos.push(`${sinReservar} componente(s) se consumieron sin estar reservados.`);

  // Productos ya registrados (total o parcialmente): se avisa cuántos y con qué comprobante,
  // y se calcula si queda algo pendiente de registrar (para bloquear exportar/registrar).
  const yaRegistrados = productos.filter(p => !p.excluido && p.yaRegistrado);
  const parciales     = productos.filter(p => !p.excluido && p.parcial);
  if (yaRegistrados.length || parciales.length) {
    const nums = [...new Set([...yaRegistrados.map(p => p.yaRegistrado.numeroMovimiento),
                              ...parciales.map(p => p.parcial.numeroMovimiento)].filter(n => n != null))];
    const compTxt = nums.length ? ` (movimiento${nums.length > 1 ? 's' : ''} #${nums.join(', #')})` : '';
    if (yaRegistrados.length) avisos.push(`${yaRegistrados.length} producto(s) ya fueron registrados${compTxt} y no se vuelven a descontar.`);
    if (parciales.length)     avisos.push(`${parciales.length} producto(s) tienen parte ya registrada${compTxt}: sólo se registrará lo pendiente.`);
  }
  // Hay algo pendiente si algún producto NO excluido todavía no quedó totalmente registrado.
  const pendienteDeRegistrar = productos.some(p => !p.excluido && !p.yaRegistrado);

  // Depósitos de la sucursal en la que está parada la pantalla: el modal elige de dónde salen
  // los componentes no reservados (y a dónde vuelve el sobrante) y a dónde entran los
  // terminados. Los IDs son POR sucursal, así que un default de config que no exista en esta
  // sucursal se descarta en vez de exponer un ID que no se puede usar. Si SiGA no responde la
  // lista queda vacía y los defaults se devuelven igual: la conciliación no depende de esto.
  // (cr/cp/depsPropuestos ya se resolvieron arriba, para el aporte de las reservas mayoristas.)
  let depositos = [];
  try { depositos = await depositosActivos(sucursalPedida || cr.idSucursal); }
  catch (e) { avisos.push(`No se pudieron consultar los depósitos en SiGA (${e.message}): elegilos a mano antes de registrar.`); }
  const activos   = new Set(depositos.map(d => Number(d.IdDeposito)));
  const depValido = v => {
    const n = Number(v);
    if (!esIdDeposito(n)) return null;
    return (depositos.length && !activos.has(n)) ? null : n;
  };

  // ── Entrega mayorista: UNA sola imputación gobierna las dos patas ────────────
  // Las unidades de "X Pedido" que entran al depósito de reserva y los kg de granel que salen
  // de ahí para fabricarlas son el mismo hecho contado de dos maneras. Se calculan juntos y acá
  // (no en el registro) para que la pantalla muestre exactamente los números que se van a
  // mover: primero cuántas unidades del pedido cubre la producción PENDIENTE, y de ahí se
  // deriva el granel que se le cobra a cada reserva.
  const terminadosPendientes = terminadosPorPluDeConciliacion(productos);
  const entrega = imputarEntregaMayorista(
    basesEntregaMayorista(mercReserva, asientosTodos),
    terminadosPendientes,
    new Map(componentes.filter(x => x.plu).map(x => [String(x.plu), x.usado])));
  const granelMayoristaCobrado = agruparRestante(entrega.consumoMayorista.map(x => ({ plu: x.plu, restante: x.kg })));
  // La entrega se recorta sola cuando el granel no alcanza (apartado ya consumido, o consumo
  // declarado menor al que pide la fórmula). Callarlo haría que el operador viera menos unidades
  // en el depósito de reserva de las que espera y no supiera por qué.
  for (const [plu, falta] of agruparRestante(restantePedido)) {
    const sinEntregar = redondear4(Math.min(falta, terminadosPendientes.get(plu) || 0)
                                 - (entrega.unidadesPorPlu.get(plu) || 0));
    if (sinEntregar <= 0) continue;
    avisos.push(`${sinEntregar} unidad(es) del producto ${plu} que una reserva mayorista espera NO entran al `
              + 'depósito de reserva: el granel que quedaba apartado no alcanza para cubrirlas. '
              + 'Entran a recepción como producción normal.');
  }

  // Desglose por movimiento de reserva (para conciliar por orden y por movimiento). Sólo las
  // reservas todavía sin recepción: las conciliadas ya no tienen nada que mover.
  const _gruposMov = reservadoPorMovimiento(reservasVivas);
  // El granel que se le cobra al mayorista NO lo consumió el plan: si el reparto por movimiento
  // lo siguiera contando, el ajuste del plan sacaría del depósito de reserva kg que ya salieron
  // por la pata mayorista y las diferencias los devolverían una segunda vez.
  const _usadoPorPlu = new Map([...consumo.componentes.values()]
    .filter(u => u.plu).map(u => [String(u.plu),
      redondear4(Math.max(0, u.usado - (granelMayoristaCobrado.get(String(u.plu)) || 0)))]));
  const porMovimiento = conciliarPorMovimiento(_gruposMov, _usadoPorPlu);

  return {
    fecha,
    idSucursal: sucursalPedida,
    // Presente sólo cuando la reserva activa es de otra sucursal (si no, null).
    sucursalDistinta,
    reserva: {
      existe: !!reserva,
      estado: reserva ? reserva.estado : null,
      numeroMovimiento: reserva ? (reserva.numeroMovimiento ?? null) : null,
      idSucursal: sucReserva,
      depOrigen:  reserva ? (reserva.depOrigen  ?? null) : null,
      depDestino: reserva ? (reserva.depDestino ?? null) : null,
      desincronizada: (reserva && reserva.desincronizada) || null,
      movimientos,
      saldo: saldo.map(l => ({ plu: String(l.plu), nombre: String(l.nombre || ''), cantidad: redondear4(l.cantidad) }))
    },
    productos,
    componentes,
    // Parte de componentes[].reservado que viene de reservas MAYORISTAS vivas, por PLU. Objeto
    // plano (no Map) porque la conciliacion se serializa a JSON. Se publica para poder separar
    // lo apartado por el plan (devolvible, y presente en porMovimiento) de lo apartado por el
    // mayorista, que tiene que quedarse en el deposito de reserva.
    reservadoMayorista: Object.fromEntries(granelMayorista),
    // Base de imputacion: cuanto le queda apartado a CADA reserva. Es lo que necesita
    // /registrar-movimiento para anotar en el asiento contra que reserva sale cada kg
    // consumido, sin volver a leer ni filtrar reservas_mercaderia.json por su cuenta.
    restanteMayorista,
    // Unidades de "X Pedido" que cada reserva todavia espera: con eso el alta del terminado
    // sabe que parte entra al deposito de reserva en vez del de recepcion.
    restantePedido,
    // Las DOS patas de la entrega mayorista de esta produccion pendiente, ya imputadas contra
    // cada reserva por imputarEntregaMayorista. /registrar-movimiento las consume tal cual: no
    // vuelve a calcular ninguna de las dos, que es lo que las dejaba desfasadas entre si.
    //  · terminado      → unidades de "X Pedido" que entran al deposito de reserva, por reserva.
    //  · consumo        → kg de granel que se le cobran a esa reserva por esas unidades.
    //  · unidadesPorPlu → el agregado que rutea el alta del terminado (objeto plano: viaja a JSON).
    //  · granelPorPlu   → el agregado que descuenta el consumo del deposito de reserva.
    entregaMayorista: {
      terminado: entrega.terminadoMayorista,
      consumo: entrega.consumoMayorista,
      unidadesPorPlu: Object.fromEntries(entrega.unidadesPorPlu),
      granelPorPlu: Object.fromEntries(granelMayoristaCobrado),
    },
    // Consumo de la carga manual, fuera del cuadro reserva-vs-producción: no hay reserva contra
    // la cual conciliarlo. Se registra íntegro contra el depósito de recepción.
    componentesManual,
    // Desglose reservado-vs-usado por movimiento de reserva (misma info que "componentes",
    // recortada por movimiento en vez de agregada por PLU).
    porMovimiento,
    // Depósitos elegibles de la sucursal + la preselección que propone el servidor.
    depositos: depositos.map(d => ({
      idDeposito: Number(d.IdDeposito), nombre: String(d.NombreDeposito || '').trim(),
      tipoDeposito: d.TipoDeposito, disponibleVenta: d.DisponibleVenta
    })),
    // La preselección la calcula la MISMA función que resuelve los depósitos del movimiento
    // real, así la pantalla no puede mostrar una elección distinta de la que se va a escribir.
    seleccion: {
      depSalida:      depValido(depsPropuestos.salida),
      depRecepcion:   depValido(depsPropuestos.recepcion),
      // A dónde vuelve la diferencia entre lo reservado y lo realmente consumido.
      depDiferencias: depValido(depsPropuestos.diferencias),
      // El depósito donde la mercadería está físicamente apartada: no se elige, sale de la
      // reserva del plan (o de config si todavía no hay reserva). Puede ser null.
      depReserva:     depsPropuestos.reserva,
      // true = hay reserva activa, así que salida y diferencias las fija su depOrigen y la
      // pantalla tiene que mostrarlos como fijos, no como elegibles.
      forzadosPorReserva: depsPropuestos.forzadosPorReserva
    },
    // Marca del alta de producción de esta fecha (o null): con esto la pantalla deshabilita
    // el botón de registrar el movimiento y muestra con qué comprobante se registró.
    produccionRegistrada: (plan && plan.produccionRegistrada) || null,
    // false = todo lo de la fecha ya fue registrado: la pantalla bloquea exportar y registrar.
    pendienteDeRegistrar,
    totales: {
      productos:          productos.filter(p => !p.excluido).length,
      productosExcluidos: productos.filter(p =>  p.excluido).length,
      componentes:        componentes.length,
      conDiferencia:      componentes.filter(c => c.diferencia !== 0).length,
      sinReservar,
      // Reservas que ya se recepcionaron y por eso NO entran en el resumen ni se vuelven a mover.
      reservasConciliadas: numsConciliados.size,
      // Producción cargada a mano: no se concilia contra reserva.
      productosManuales:   productos.filter(p => !p.excluido && p.manual).length,
      componentesManuales: componentesManual.length
    },
    avisos
  };
}

// Qué quedó realmente escrito en SiGA para un comprobante de stock: cabecera + renglones.
// Sólo lectura (pool de lectura, nunca el de escritura). La conciliación lo usa para poder
// auditar un movimiento del log contra la base sin salir de la pantalla.
// GET /api/movimientos/siga/:numero?idSucursal=1&idTipoMovimiento=BIENESUSO
app.get('/api/movimientos/siga/:numero', apiRoute(async req => {
  // query() no toma parámetros (interpola el string), así que lo que viene de la URL se valida
  // a mano antes de tocar el SQL: dos enteros y un tipo de movimiento alfanumérico.
  const numero = Number(req.params.numero);
  const suc    = Number(req.query.idSucursal);
  const tipo   = String(req.query.idTipoMovimiento || '').trim();
  if (!Number.isInteger(numero) || numero <= 0) return { error: 'Número de movimiento inválido' };
  if (!Number.isInteger(suc)    || suc    <= 0) return { error: 'Sucursal inválida' };
  if (!/^[A-Z0-9_]{1,20}$/i.test(tipo))         return { error: 'Tipo de movimiento inválido' };

  const filtro = `IdSucursal=${suc} AND IdTipoMovimiento='${tipo}' AND NumeroMovimiento=${numero}`;
  const [cab] = await query(`SELECT TOP 1 CONVERT(varchar(19), FechaMovimiento, 120) AS Fecha,
      Usuario, Observacion, IdEmpleado, Neto, Total
    FROM MovimientosStock WHERE ${filtro}`);
  if (!cab) {
    return { encontrado: false, numeroMovimiento: numero, idSucursal: suc, idTipoMovimiento: tipo,
             lineas: [], aviso: 'El comprobante no existe en SiGA con esa sucursal y tipo de movimiento.' };
  }
  const lineas = await query(`SELECT mp.Orden, mp.IdProducto, p.NombreProducto, mp.Cantidad,
      mp.IdDeposito, sd.NombreDeposito
    FROM MovimientosStockProductos mp
    LEFT JOIN Productos p ON p.IdProducto=mp.IdProducto
    LEFT JOIN SucursalesDepositos sd ON sd.IdDeposito=mp.IdDeposito AND sd.IdSucursal=mp.IdSucursal
    WHERE mp.IdSucursal=${suc} AND mp.IdTipoMovimiento='${tipo}' AND mp.NumeroMovimiento=${numero}
    ORDER BY mp.Orden`);

  return {
    encontrado: true,
    numeroMovimiento: numero, idSucursal: suc, idTipoMovimiento: tipo,
    cabecera: {
      fecha: cab.Fecha || null, usuario: String(cab.Usuario || '').trim(),
      observacion: String(cab.Observacion || '').trim(),
      idEmpleado: cab.IdEmpleado ?? null,
      neto: Number(cab.Neto) || 0, total: Number(cab.Total) || 0
    },
    lineas: lineas.map(l => ({
      orden: l.Orden ?? null,
      plu: String(l.IdProducto ?? ''),
      nombre: String(l.NombreProducto || '').trim(),
      cantidad: redondear4(l.Cantidad),
      idDeposito: l.IdDeposito ?? null,
      nombreDeposito: String(l.NombreDeposito || '').trim()
    }))
  };
}));

// Estas dos rutas /api/produccion/:fecha/* se quedan en server.js a proposito: van con el bloque de reservas/movimientos SIGA, no con rutas_produccion.js.
app.get('/api/produccion/:fecha/conciliacion', apiRoute(async req => {
  const s = await resolverSucursal(req.query.idSucursal);
  if (s.error) return { error: s.error };
  return conciliacionProduccion(safeDate(req.params.fecha), s.idSucursal);
}));

// ── Alta de producción: el movimiento de stock ─────────────────────────────────
// Los depósitos del circuito los resuelve depositosProduccion (módulo reservas_movimiento):
//   · salida      → de dónde salen los componentes que NO cubre la reserva.
//   · recepcion   → dónde ENTRAN los productos terminados. Lo elige el operador.
//   · diferencias → a dónde vuelve el sobrante entre lo reservado y lo consumido.
//   · reserva     → dónde está físicamente lo apartado (depDestino de la reserva del plan).
// Con una reserva activa, salida y diferencias NO son elegibles: los fija el depOrigen de esa
// reserva, porque el excedente salió del principal y el sobrante tiene que volver ahí.
// Las lineas del comprobante las arma lineasProduccionDesdeConciliacion (mismo modulo puro).

// Registra la producción de una fecha como UN comprobante de stock en SiGA: da de alta los
// terminados y de baja los componentes realmente consumidos, según la conciliación.
// El tipo es BIENESUSO (el único habilitado para escritura) y no es el tipo semánticamente
// correcto para una producción: lo que identifica estos comprobantes es la OBSERVACIÓN
// (produccion.observacion en config.json + la fecha), que es por donde se los filtra en SiGA.
// Body: { idSucursal?, confirmar: true, omitirSinPlu?: true, depSalida?, depRecepcion?, depDiferencias? }
app.post('/api/produccion/:fecha/registrar-movimiento', apiRoute(async req => {
  const fecha = safeDate(req.params.fecha);
  const b     = req.body || {};
  // Doble confirmación explícita: este endpoint escribe stock real y no es idempotente.
  if (b.confirmar !== true) return { error: 'Falta confirmar el movimiento' };

  const s = await resolverSucursal(b.idSucursal);
  if (s.error) return { error: s.error };
  const cr = s.cr;
  const cp = cfgProduccion();
  if (!TIPOS_MOVIMIENTO_STOCK_PERMITIDOS.includes(cp.idTipoMovimiento)) {
    return { error: `idTipoMovimiento inválido (produccion.idTipoMovimiento en config.json). `
                  + `Permitidos: ${TIPOS_MOVIMIENTO_STOCK_PERMITIDOS.join(', ')}` };
  }

  // El plan previo se usa para la reserva; el bloqueo por "ya registrado" pasó a evaluarse
  // sobre la conciliación (per-registro), porque una carga nueva del mismo día debe poder
  // registrarse aunque la fecha ya tenga un asiento previo.
  const planPrevio = leerJSON(PLANES_PATH, {})[fecha] || null;
  // Una reserva activa de otra sucursal bloquea todo: los depósitos y el stock son por
  // sucursal y el consumo saldría del lugar equivocado.
  const errSucursal = chequearSucursalReserva(planPrevio && planPrevio.reserva, cr.idSucursal);
  if (errSucursal) return { error: errSucursal };

  // Depósitos elegidos en la pantalla. Se validan contra la sucursal ANTES de calcular o
  // escribir nada: los IDs son por sucursal y un depósito de otra movería stock donde no va.
  // Si no vienen se usan los defaults de siempre (config + reserva del plan).
  const vino = v => v !== undefined && v !== null && v !== '';
  const elegidos = { depSalida: b.depSalida, depRecepcion: b.depRecepcion, depDiferencias: b.depDiferencias };
  if (vino(b.depSalida) || vino(b.depRecepcion) || vino(b.depDiferencias)) {
    const activos = new Set((await depositosActivos(cr.idSucursal)).map(d => Number(d.IdDeposito)));
    const valido  = v => esIdDeposito(Number(v)) && activos.has(Number(v));
    if (vino(b.depSalida)      && !valido(b.depSalida))      return { error: 'Depósito de salida inválido' };
    if (vino(b.depRecepcion)   && !valido(b.depRecepcion))   return { error: 'Depósito de recepción inválido' };
    if (vino(b.depDiferencias) && !valido(b.depDiferencias)) return { error: 'Depósito de diferencias inválido' };
  }

  const c = await conciliacionProduccion(fecha, cr.idSucursal);
  const hayProductos = (c.productos || []).some(p => !p.excluido);
  if (!hayProductos && !(c.componentes || []).length) {
    return { error: `No hay producción cargada para el ${fecha}: no hay nada que registrar` };
  }
  // Trabajo pendiente = producción sin registrar O ajustes de reserva sin conciliar. Con la
  // conciliación por movimiento, una fecha "ya registrada" en terminados puede tener todavía
  // ajustes de reserva pendientes (p. ej. un reintento tras una falla parcial): en ese caso NO
  // se bloquea, se retoma sólo lo que falta.
  const hayAjustesPendientes = (c.porMovimiento || [])
    .some(m => !m.conciliado && (m.componentes || []).some(x => (x.usado > 0) || (x.sobrante > 0)));
  if (c.pendienteDeRegistrar === false && !hayAjustesPendientes) {
    const num = c.produccionRegistrada ? (c.produccionRegistrada.numeroMovimiento ?? null) : null;
    return { error: `Toda la producción del ${fecha} ya fue registrada${num != null ? ` (movimiento #${num})` : ''}`,
             yaRegistrado: true, numeroMovimiento: num };
  }
  // Registros de producción que aporta ESTE movimiento: los pendientes de la fecha, con rol de
  // envasado y PLU resoluble (los sin PLU se omiten y quedan pendientes para corregirlos). Se
  // guardan en el asiento para que la reversión devuelva sólo estos a "pendiente".
  const registrosFecha  = leerJSON(PROD_REG_PATH, []).filter(r => r && r.fecha === fecha);
  const yaAsentados     = registrosYaRegistrados(planPrevio, registrosFecha);
  const idsRegistrados  = registrosFecha
    .filter(r => !motivoExclusionRegistro(r) && !yaAsentados.has(String(r.id)) && plusDeRegistro(r.plu)[0])
    .map(r => r.id);
  // Un movimiento en 'pendiente' significa que no se sabe si llegó a ejecutarse en SiGA:
  // registrar encima duplicaría el consumo.
  const pendientes = ((c.reserva && c.reserva.movimientos) || []).filter(m => m.estado === 'pendiente');
  if (pendientes.length) {
    return { error: `Hay ${pendientes.length} movimiento(s) en estado pendiente para el ${fecha}: `
                  + 'verificá a mano en SiGA si se ejecutaron y resolvelos antes de registrar la producción.',
             pendientes: pendientes.map(m => m.id) };
  }

  const deps = depositosProduccion(cp, cr, c.reserva, elegidos);
  // Un ajuste SiGA POR movimiento de reserva (trazabilidad 1:1 reserva→ajuste):
  //  · "resto"    → terminados (alta de producto) + consumo que salió de FUERA de la reserva.
  //  · por cada movimiento de reserva NO conciliado → consumo contra lo apartado + sobrante.
  // Lo apartado por reservas MAYORISTAS viaja dentro de componentes[].reservado (para que el
  // consumo no se cargue al deposito principal) pero NO es del plan. Se parte ANTES de armar
  // nada: `componentesPlan` es la vista que consumen TODOS los pasos de abajo (el comprobante
  // de produccion, las diferencias y el corte antidoble-conteo). Si alguno mirara el
  // componente crudo, el consumo que excede plan+mayorista no saldria de ningun deposito.
  // Las dos patas de la entrega mayorista vienen YA imputadas de la conciliacion
  // (imputarEntregaMayorista) y no se recalculan acá. Salen del mismo reparto, así que las
  // unidades que entran al depósito de reserva y el granel que se le cobra a cada reserva no
  // pueden desfasarse. Cuando se calculaban por separado, un día normal (el plan consume justo
  // lo que reservó) entregaba el producto sin cobrar el granel: el depósito de reserva quedaba
  // con la materia prima Y el terminado del mismo pedido, y ningún ledger reconciliaba al otro.
  const em = c.entregaMayorista || {};
  // Contra qué reserva mayorista sale cada kg que la sala consumió del depósito de reserva. Se
  // guarda en el asiento de producción (misma escritura que el sello) y es lo que hace que el
  // lote siguiente vea el apartado que QUEDA en vez del original. No se toca
  // reservas_mercaderia.json: mover uno solo de los dos datos abre una ventana en la que un
  // reintento recalcularía el mismo consumo contra un apartado ya achicado.
  const consumoMayorista   = em.consumo   || [];
  // Contra qué reserva entró cada unidad de "X Pedido", con la misma escritura y la misma
  // reversión que el consumo de granel de arriba.
  const terminadoMayorista = em.terminado || [];
  const { componentesPlan, lineasMayorista } =
    partirConsumoMayorista(c.componentes, c.reservadoMayorista, deps.reserva, em.granelPorPlu);
  // El terminado que cubre una reserva mayorista viva entra al deposito de reserva, no al de
  // recepcion. `unidadesPorPlu` ya viene neto de lo que los asientos anteriores metieron y
  // topeado por el granel que la reserva todavia tiene apartado.
  const resto     = lineasProduccionDesdeConciliacion({ ...c, componentes: componentesPlan }, deps,
    { incluirReserva: false, reservadoPorTerminado: new Map(Object.entries(em.unidadesPorPlu || {})) });
  const ajustesMov = (c.porMovimiento || [])
    .map(m => ({ numeroMovimiento: m.numeroMovimiento, ordenes: m.ordenes || [], conciliado: !!m.conciliado, lineas: lineasAjusteMovimiento(m.componentes, deps) }))
    // Los movimientos ya conciliados no se re-registran (idempotencia ante reintentos parciales).
    .filter(m => !m.conciliado && m.lineas.length);
  // El consumo del apartado mayorista va en el comprobante de produccion, junto al resto del
  // consumo de fuera de la reserva del plan: asi queda cubierto por la misma marca de
  // idempotencia y no necesita comprobante nuevo.
  const lineasResto = [...resto.lineas, ...lineasMayorista];
  // Ajuste por diferencias: un único comprobante con todo lo que se desvió de lo reservado
  // (excedente y sobrante), calculado sobre el agregado por PLU de las reservas todavía vivas.
  const difs = lineasDiferenciasProduccion(componentesPlan, deps);
  // Reservas que cubre ese comprobante: sirven de marca de idempotencia. Si un reintento llega
  // con las mismas reservas todavía sin conciliar, las diferencias ya se escribieron.
  const movimientosACubrir = ajustesMov.map(m => m.numeroMovimiento);
  const diferenciasYaRegistradas = ((planPrevio && planPrevio.ajustesDiferencias) || []).some(a =>
    Array.isArray(a && a.reservas) && a.reservas.length === movimientosACubrir.length
    && a.reservas.every(n => movimientosACubrir.includes(n)));

  const sinPlu = resto.sinPlu;
  const todasLasLineas = [...lineasResto, ...difs, ...ajustesMov.flatMap(m => m.lineas)];

  // Defensa contra doble conteo: el reservado agregado (que usa el "resto" para el consumo-salida)
  // debe coincidir con la suma por movimiento. Sólo diferirían si una reserva quedara net-negativa
  // por PLU dentro de sí misma (devoluciones > líneas): hoy no ocurre, pero se corta por las dudas.
  // Se compara contra componentesPlan: el aporte mayorista no esta en porMovimiento (es de otro
  // circuito) y haria saltar el corte por una diferencia legitima.
  const reservadoAgg = new Map(componentesPlan.filter(x => x.plu).map(x => [String(x.plu), redondear4(x.reservado)]));
  const reservadoMov = new Map();
  for (const m of (c.porMovimiento || [])) for (const x of (m.componentes || [])) {
    reservadoMov.set(String(x.plu), redondear4((reservadoMov.get(String(x.plu)) || 0) + (Number(x.reservado) || 0)));
  }
  const descuadre = [...reservadoMov.entries()].filter(([plu, v]) => Math.abs(v - (reservadoAgg.get(plu) || 0)) > 1e-4);
  if (descuadre.length) {
    return { error: 'La reserva agregada no coincide con la suma por movimiento (posible reserva con devoluciones '
                  + 'inconsistentes). Revisá las reservas del plan antes de registrar la producción.',
             descuadre: descuadre.map(([plu]) => plu) };
  }

  // Sin PLU no hay forma de mover el stock: o se aborta, o el operador acepta explícitamente
  // dejarlos afuera (y se informan en la respuesta para corregirlos después).
  if (sinPlu.length && b.omitirSinPlu !== true) {
    return { error: `Hay ${sinPlu.length} componente(s)/producto(s) sin PLU: no se pueden mover. `
                  + 'Corregilos o volvé a enviar con omitirSinPlu para dejarlos afuera.',
             sinPlu };
  }
  if (!todasLasLineas.length) return { error: 'No quedó ninguna línea para mover' };
  // Defensa: sin depósito de reserva configurado ni reserva viva, una línea de consumo
  // reservado quedaría sin depósito. Antes de escribir, todas las líneas tienen que tenerlo.
  const sinDeposito = todasLasLineas.filter(l => !esIdDeposito(Number(l.idDeposito)));
  if (sinDeposito.length) {
    return { error: 'No se pudo determinar el depósito de todas las líneas '
                  + '(elegí el depósito de salida y el de recepción, y revisá reserva.depositoReserva en config.json)',
             sinDeposito: sinDeposito.map(l => ({ plu: l.idProducto, concepto: l.concepto })) };
  }

  // La observación es la marca que identifica estos comprobantes en SiGA: el prefijo
  // (produccion.observacion + fecha) es común a todos, y después cada uno dice qué es —
  // mismo patrón que la reserva, que escribe "<obs> <fecha> RESERVA <dep>><dep>".
  const obsPrefijo = `${cp.observacion} ${fecha}`.trim();
  const obsBase    = `${obsPrefijo} PRODUCCION`;
  const poolW = await getPoolStock();
  const comprobantes = [], logErrores = [];
  let errMarca = null, avisoMarca = null, errEscritura = null;
  let r = { numeroMovimiento: null, idRegistro: null };

  // opts.tipo/opts.origen permiten que el ajuste por diferencias salga con SU tipo de movimiento
  // (el de la reserva) y quede rotulado aparte en el log; el resto usa el de producción.
  const escribirComprobante = async (lineasComp, observacion, depOrigen, depDestino, opts) => {
    const tipo   = (opts && opts.tipo)   || cp.idTipoMovimiento;
    const origen = (opts && opts.origen) || 'produccion';
    return ejecutarYRegistrar({
      origen, plan: fecha, itemId: null, idSucursal: cr.idSucursal,
      // La cabecera de un movimiento multi-depósito es sólo referencia: el depósito real de
      // cada renglón va EN LA LÍNEA.
      depOrigen, depDestino, idUbicacion: null, idEmpleado: cr.idEmpleado,
      idTipoMovimiento: tipo, usuario: cr.usuario, observacion,
      lineas: lineasComp.map(l => ({ plu: l.idProducto, nombre: l.nombre || null, cantidad: l.cantidad, idDeposito: l.idDeposito }))
    }, () => registrarMovimientoMultilinea(poolW, {
      idSucursal: cr.idSucursal, idTipoMovimiento: tipo,
      usuario: cr.usuario, idEmpleado: cr.idEmpleado, observacion,
      lineas: lineasComp.map(l => ({ idProducto: l.idProducto, idDeposito: l.idDeposito, cantidad: l.cantidad }))
    }));
  };

  // Aplica un cambio al plan y lo persiste de inmediato (re-lee para no pisar escrituras
  // concurrentes). Se llama DESPUÉS de cada comprobante confirmado para que un reintento tras
  // una falla parcial salte lo ya registrado (idempotencia). Devuelve {aviso} si no hay plan.
  const aplicarAlPlan = (mutador) => {
    const planes = leerJSON(PLANES_PATH, {});
    // Producción 100% de carga manual: la fecha no tiene plan, pero la marca del asiento igual
    // tiene que persistir. Sin ella la pantalla nunca veía la producción como registrada (el
    // botón de registrar movimiento quedaba habilitado, con riesgo de duplicar el descuento) y
    // los registros no se archivaban al historial. Se crea un plan mínimo: sin ítems ni reserva,
    // sólo sostén de la marca.
    const planActual = planes[fecha]
      || { fecha, notas: '', items: [], creado: new Date().toISOString(), soloProduccionManual: true };
    guardarJSON(PLANES_PATH, { ...planes, [fecha]: mutador(planActual) });
    return { ok: true };
  };

  // Marca del asiento de producción (terminados) + sello por ítem. Se persiste apenas confirma
  // el comprobante "resto": un reintento verá esos registros como yaRegistrados y no los repite.
  const marcarProduccion = (planActual, rc) => {
    const asientoNuevo = {
      numeroMovimiento: rc.numeroMovimiento, fecha: new Date().toISOString(),
      idRegistro: rc.idRegistro, usuario: cr.usuario, idSucursal: cr.idSucursal, registros: idsRegistrados,
      // Granel del apartado mayorista que consumio ESTE movimiento, por reserva. Revertir el
      // movimiento borra el asiento (limpiarProduccionRegistrada) y con el este consumo, asi
      // que el apartado vuelve solo. Sin consumo mayorista el campo no se escribe: los asientos
      // que no lo tienen se leen como cero consumido.
      ...(consumoMayorista.length ? { consumoMayorista } : {}),
      // Unidades de "X Pedido" que ESTE movimiento metio al deposito de reserva, por reserva.
      // Misma escritura y misma reversion que el resto del asiento.
      ...(terminadoMayorista.length ? { terminadoMayorista } : {})
    };
    const asientos = [...asientosProduccion(planActual), asientoNuevo];
    const produccionRegistrada = { ...asientoNuevo, asientos };
    const registrosDelAsiento = registrosFecha.filter(rr => idsRegistrados.includes(rr.id));
    const plusProducidos = new Set(registrosDelAsiento.flatMap(rr => plusDeRegistro(rr.plu)));
    const sello = { numeroMovimiento: rc.numeroMovimiento, fecha: asientoNuevo.fecha, idRegistro: rc.idRegistro };
    const items = (planActual.items || []).map(it => {
      if (!it || it.produccionMovimiento) return it;
      const plu = String(it.idProducto ?? it.idGranel ?? '').replace(/\D/g, '');
      if (!plu || !plusProducidos.has(plu)) return it;
      return { ...it, produccionMovimiento: sello };
    });
    return { ...planActual, produccionRegistrada, items };
  };

  try {
    // 1) Comprobante "resto" (terminados + consumo no reservado). Puede no tener líneas si todo
    //    el consumo fue contra reservas y no hay alta de producto pendiente.
    if (lineasResto.length) {
      // Este es el comprobante de PRODUCCIÓN propiamente dicho: da de alta los terminados y
      // descuenta el consumo que NO salió de una reserva del plan (fórmulas sin reservar,
      // excedentes, carga manual y lo consumido del apartado mayorista, que sí sale del
      // depósito de reserva). Los que cierran cada reserva se rotulan CONCILIACION.
      const rResto = await escribirComprobante(lineasResto, obsBase.slice(0, 200), deps.reserva || deps.salida, deps.recepcion);
      logErrores.push(rResto.logError);
      comprobantes.push({ tipo: 'resto', numeroMovimiento: rResto.numeroMovimiento, idRegistro: rResto.idRegistro });
      r = rResto;
      const res = aplicarAlPlan(planActual => marcarProduccion(planActual, rResto));
      if (res.aviso) avisoMarca = res.aviso;
    }

    // 2) Ajuste por diferencias: TODO lo que se desvió de lo reservado, en un comprobante propio
    //    y con el tipo de la reserva (BIENESUSO), para poder identificarlo en SiGA por la
    //    observación en vez de que quede mezclado con el alta de producción.
    //    Va ANTES de los ajustes por movimiento: esos cierran las reservas y, una vez cerradas,
    //    el reservado deja de contar y la diferencia ya no se podría calcular.
    if (difs.length && !diferenciasYaRegistradas) {
      const observacion = `${obsPrefijo} AJUSTE POR DIFERENCIAS`.slice(0, 200);
      const rd = await escribirComprobante(difs, observacion, deps.reserva, deps.diferencias,
        { tipo: cr.idTipoMovimiento, origen: 'ajuste' });
      logErrores.push(rd.logError);
      comprobantes.push({ tipo: 'diferencias', numeroMovimiento: rd.numeroMovimiento, idRegistro: rd.idRegistro });
      if (r.numeroMovimiento == null) r = rd;
      // Marca de idempotencia: si un ajuste posterior falla, el reintento no vuelve a escribir
      // las mismas diferencias (las reservas siguen vivas y se recalcularían iguales).
      const res = aplicarAlPlan(planActual => ({
        ...planActual,
        ajustesDiferencias: [...(planActual.ajustesDiferencias || []), {
          numeroMovimiento: rd.numeroMovimiento, idRegistro: rd.idRegistro ?? null,
          fecha: new Date().toISOString(), reservas: movimientosACubrir
        }]
      }));
      if (res.aviso && !avisoMarca) avisoMarca = res.aviso;
    }

    // 3) Un comprobante de ajuste por movimiento de reserva. Cada uno sella SU reserva apenas
    //    confirma, así un fallo intermedio no obliga a repetir los anteriores.
    for (const m of ajustesMov) {
      // Cada ajuste cierra UNA reserva: la observación lo dice y nombra el comprobante de
      // reserva que concilia, para poder seguir el par reserva → conciliación desde SiGA.
      const observacion = `${obsPrefijo} CONCILIACION RESERVA #${m.numeroMovimiento ?? '—'}`.slice(0, 200);
      const rm = await escribirComprobante(m.lineas, observacion, deps.reserva, deps.diferencias || deps.reserva);
      logErrores.push(rm.logError);
      comprobantes.push({ tipo: 'ajuste', numeroMovimientoReserva: m.numeroMovimiento, numeroMovimiento: rm.numeroMovimiento, idRegistro: rm.idRegistro });
      if (r.numeroMovimiento == null) r = rm;   // sin resto, el principal es el primer ajuste
      const res = aplicarAlPlan(planActual => ({
        ...planActual,
        reservas: migrarReservas(planActual).reservas.map(rr =>
          rr.numeroMovimiento === m.numeroMovimiento
            ? { ...rr, ajuste: { numeroMovimiento: rm.numeroMovimiento, idRegistro: rm.idRegistro, fecha: new Date().toISOString(), conciliado: true } }
            : rr),
      }));
      if (res.aviso && !avisoMarca) avisoMarca = res.aviso;
    }
  } catch (e) {
    // ejecutarYRegistrar re-lanza si el comprobante falló en SiGA. Cada comprobante es su propia
    // transacción, así que lo ya escrito quedó firme y marcado; se corta acá y se avisa para
    // reintentar (el reintento salta lo confirmado).
    errEscritura = `Se registraron ${comprobantes.length} comprobante(s); el siguiente falló: ${e.message}. `
                 + 'Reintentá el registro: los comprobantes ya hechos no se repiten.';
  }

  // Registros conciliados → historial: salen del listado de Terminados (quedan archivados para
  // consulta). Sólo si la marca del plan se persistió (los ítems quedaron dados de alta).
  let archivados = 0;
  if (idsRegistrados.length && !errMarca && !avisoMarca) {
    try { archivados = archivarRegistros(idsRegistrados, { numeroMovimiento: r.numeroMovimiento, planFecha: fecha }); }
    catch (e) { errMarca = `No se pudieron archivar los registros conciliados: ${e.message}`; }
  }

  const resp = {
    ok: !errEscritura, numeroMovimiento: r.numeroMovimiento, idRegistro: r.idRegistro, archivados,
    comprobantes, idSucursal: cr.idSucursal, observacion: obsBase.slice(0, 200), depositos: deps,
    lineas: todasLasLineas, resumen: { ...resto.resumen, ajustesMovimiento: ajustesMov.length },
    ...(errEscritura ? { parcial: true } : {}),
    ...(sinPlu.length ? { omitidosSinPlu: sinPlu } : {}),
    ...(avisoMarca ? { aviso: avisoMarca } : {})
  };
  return conLogError(resp, ...logErrores, errMarca, errEscritura);
}));


// ── Inicio ─────────────────────────────────────────────────────────────────────

// El router de compras se registra acá, al final, y no donde estaban sus rutas:
// recibe deps que son `const` declarados bastante después del punto donde estaban
// (_ventasJoin, PESABLES_LISTAS_PATH, DISTRIB_CONFIG_PATH, A8020_CALC_PATH…) y los
// const no se hoistean. No hay catch-all ni middleware de 404, y ninguna ruta que quedó en
// server.js solapa con las del router, así que el orden de registro no cambia
// a qué handler llega cada request.
app.use(require('./rutas_compras')({
  apiRoute, leerJSON, query, getPool,
  sqlStockPorPlu, sqlStockDistribucion, _ventasJoin,
  leerPedidosCompra, guardarPedidosCompra,
  PESABLES_LISTAS_PATH, DISTRIB_CONFIG_PATH, CONSUMO_MENSUAL_PATH, A8020_CALC_PATH,
}));

// Dashboard de consumo: apiRoute, leerJSON, guardarJSON y query son funciones y se
// hoistean, y cfg/DATA_DIR son const declarados bien antes de donde estaban estas
// rutas, así que el registro podría ir donde estaban. Va igual al final, con el de
// los demás routers: no hay catch-all ni middleware de 404 y ninguna ruta que quedó
// en server.js solapa con las de este router, así que el orden de registro no
// cambia a qué handler llega cada request.
app.use(require('./rutas_consumo')({ apiRoute, leerJSON, guardarJSON, query, cfg, DATA_DIR }));

// Distribución: el bloque más grande, mismo motivo que compras — sus deps (sqlStockDistribucion,
// DISTRIB_CONFIG_PATH, A8020_CALC_PATH, _ventasJoin, FRAC_REG_PATH, HISTORIAL_PATH…) son const
// declarados bastante después de donde estaban sus rutas. FRAC_REG_PATH y HISTORIAL_PATH también
// los recibe rutas_productividad.js (arriba); componentesFormulaPorPadre está declarada miles de
// líneas después, así que este router también tiene que ir acá al final.
app.use(require('./rutas_distribucion')({
  apiRoute, query, leerJSON, guardarJSON, cfg, DATA_DIR,
  PESABLES_LISTAS_PATH, sqlStockDistribucion, DISTRIB_CONFIG_PATH, A8020_CALC_PATH,
  _ventasJoin, FORMULA_ACTIVA_SQL, SIN_FORMULA_GENERICO_SQL, componentesFormulaPorPadre,
  CONSUMO_MENSUAL_PATH, FRAC_REG_PATH, HISTORIAL_PATH,
}));

// Mismo criterio para el cruce de terminales: sus deps (leerJSON, guardarJSON,
// DATA_DIR) son const declarados después del punto donde estaban las rutas.
app.use(require('./rutas_cruce_terminales')({ apiRoute, leerJSON, guardarJSON, DATA_DIR }));

// Productividad también va al final: FRAC_REG_PATH, HISTORIAL_PATH, PROD_REG_PATH,
// PROD_HIST_PATH, FAMILIAS_MANUALES_PATH y LISTA_PRECIOS_VENTA son const declarados
// después del punto donde estaban estas rutas.
app.use(require('./rutas_productividad')({
  apiRoute, query, leerJSON, guardarJSON, safeDate,
  leerRegistros, leerOrdenes,
  DATA_DIR, PLANES_PATH, CATALOGO_PATH, PROD_REG_PATH, PROD_HIST_PATH,
  FRAC_REG_PATH, HISTORIAL_PATH, FAMILIAS_MANUALES_PATH,
  REF_SALA_PATH, REF_PROD_PATH, LISTA_PRECIOS_VENTA,
}));

// Precios de proveedores: mismo criterio, DATA_DIR es un const que no se hoistea.
app.use(require('./rutas_precios_proveedores')({ apiRoute, query, leerJSON, guardarJSON, DATA_DIR }));

// RRHH (relevamiento de ropa + ausencias): mismo motivo, DATA_DIR es un const.
app.use(require('./rutas_rrhh')({ leerJSON, guardarJSON, DATA_DIR }));

// Mayoristas es el que más deps recibe y el que más las necesita al final: resolverSucursal,
// depositosActivos, trasladarStock, ejecutarYRegistrar, cfgReserva, cfgProduccion,
// stockDeComponentes y asientosProduccion son const declarados miles de líneas DESPUÉS del
// punto donde estaban estas rutas. bomGranelPorPlu y RESERVAS_MERC_PATH se quedaron en
// server.js porque los usan /api/resumen y el tablero de almacén, y viajan por acá.
app.use(require('./rutas_mayoristas')({
  apiRoute, params, query, getPoolStock, getResumen,
  leerJSON, guardarJSON, DATA_DIR, PLANES_PATH,
  FORMULA_ACTIVA_SQL, SIN_FORMULA_GENERICO_SQL, sqlBOMGranel,
  bomGranelPorPlu, RESERVAS_MERC_PATH,
  resolverSucursal, depositosActivos, trasladarStock, ejecutarYRegistrar, conLogError,
  cfgReserva, cfgProduccion, ERR_RESERVA_SIN_CONFIG, ERR_RESERVA_DEPOSITOS,
  redondear4, esIdDeposito, stockDeComponentes, asientosProduccion,
}));

// Stock es el otro módulo que más deps recibe, por el mismo motivo que mayoristas:
// resolverSucursal, depositosActivos, trasladarStock, ejecutarYRegistrar, conLogError,
// cfgReserva y el resto son const/function declarados miles de líneas después del punto
// donde estaban estas rutas. registrarMovimientoStock y las tres constantes del log
// (MOV_LOG_ORIGENES, MOV_LOG_LIMIT_DEF, MOV_LOG_LIMIT_MAX) sí se movieron enteras al
// router: no las usa nada más. GET /api/movimientos/siga/:numero y las rutas de
// reservas/plan/producción se quedan en server.js (motivo detallado al principio de
// rutas_stock.js).
app.use(require('./rutas_stock')({
  apiRoute, query,
  sucursalesSiga, resolverSucursal, sucursalPublica,
  sqlStockTerminados, sqlStockGranel, sqlStockPorPlu,
  TIPOS_MOVIMIENTO_STOCK_PERMITIDOS, depositosActivos,
  cfgReserva, USUARIO_MOV_MAX, getPoolStock,
  ejecutarYRegistrar, conLogError, trasladarStock, registrarMovimientoMultilinea,
  ERR_SUCURSAL_INVALIDA, leerMovLog, guardarMovLog, actualizarMovLog,
  leerPlanReservas, ordenesProducidasDeReserva, motivoBloqueoProduccion,
  sincronizarPlanConLog, limpiarProduccionRegistrada,
  guardarJSON, PLANES_PATH,
}));

// Catálogo de grupos: los helpers cfg* y los dos paths son const declarados después
// del punto donde estaban estas rutas, así que el registro también va al final.
app.use(require('./rutas_catalogo')({
  leerJSON, guardarJSON, CATALOGO_PATH, GRUPOS_CFG_PATH,
  cfgActivo, cfgGranelPlu, cfgGranelPlus, cfgMpManual,
  cfgEsGranel, cfgGranelOverride, cfgEsMiel, cfgReqGranel,
}));


// Envases y tapas: DATA_DIR es un const que no se hoistea, así que el registro va
// al final como el de los demás routers.
app.use(require('./rutas_envases_tapas')({ apiRoute, query, leerJSON, guardarJSON, DATA_DIR }));


// Cotizador: sus cuatro deps son funciones y se hoistean, así que el registro podría ir
// donde estaban las rutas. Va igual al final, con el de los demás routers: no hay catch-all
// ni middleware de 404 y ninguna ruta que quedó en server.js solapa con las del router, así
// que el orden de registro no cambia a qué handler llega cada request.
app.use(require('./rutas_cotizador')({ apiRoute, query, leerJSON, guardarJSON }));


// Análisis de ventas: FAMILIAS_MANUALES_PATH es un const declarado miles de líneas después
// del punto donde estaban las páginas del módulo, así que el registro va al final. El
// middleware de acceso por módulo sigue registrado antes (app.use de más arriba), de modo que
// la protección de /analisis-ventas y /analisis-central no cambia.
app.use(require('./rutas_analisis')({
  apiRoute, query, leerJSON, guardarJSON, safeDate, auth, FAMILIAS_MANUALES_PATH,
}));


// Cuentas corrientes: apiRoute y query son funciones y se hoistean, así que el registro
// podría ir donde estaba la ruta. Va al final con el de los demás routers, y no cambia nada:
// no hay catch-all ni middleware de 404 y ninguna ruta que quedó en server.js solapa con las
// del router. El middleware de acceso por módulo sigue registrado antes.
app.use(require('./rutas_cuentas_corrientes')({ apiRoute, query }));


// Ventas por hora: sus tres deps son funciones y se hoistean, así que el registro podría ir
// donde estaban las rutas. Va al final con el de los demás routers. El middleware de acceso
// por módulo sigue registrado antes, así que el permiso de ventas-hora no cambia.
app.use(require('./rutas_ventas_hora')({ apiRoute, query, safeDate }));


// Precios históricos: LISTA_PRECIOS_VENTA es un const declarado miles de líneas después del
// punto donde estaba la página del módulo, así que el registro va al final como los demás.
app.use(require('./rutas_precios_historico')({ apiRoute, query, LISTA_PRECIOS_VENTA }));

// Facturador auxiliar: apiRoute, query y PORT son funciones/const que se hoistean o se
// declaran bien antes, así que el registro podría ir donde estaban las rutas. Va igual al
// final, con el de los demás routers. LISTA_PRECIOS_VENTA y PRECIOS_FACTURADOR_DIR también
// las recibe este router: son las mismas constantes que ya viajan por deps a precios
// históricos (arriba) y a productividad, no una copia — un solo 0 y un solo directorio.
app.use(require('./rutas_facturador')({ apiRoute, query, LISTA_PRECIOS_VENTA, PRECIOS_FACTURADOR_DIR, PORT }));

// Control de compras: DATA_DIR es un const que no se hoistea, así que el registro va al
// final como el de los demás routers. leerPedidosCompra viaja por deps porque también lo
// usa el módulo Compras y se queda en server.js. Ninguna ruta que quedó en server.js
// solapa con /compras/control ni con /api/compras/control/*.
app.use(require('./rutas_compras_control')({
  apiRoute, leerJSON, guardarJSON, getPool, sql, DATA_DIR, leerPedidosCompra,
}));

// Produccion: va al final porque PROD_REG_PATH y PROD_HIST_PATH son const declarados
// despues del punto donde estaban estas rutas. /api/produccion/:fecha/conciliacion y
// :fecha/registrar-movimiento quedaron en server.js y se declaran antes, pero no capturan
// nada de este router: exigen 3 segmentos con un literal fijo detras.
app.use(require('./rutas_produccion')({
  apiRoute, leerJSON, guardarJSON, safeDate, cfg,
  PROD_REG_PATH, PROD_HIST_PATH, leerOrdenes, guardarOrdenes,
}));

// Planificación: va al final porque sucursalesSiga, sucursalPublica, leerPlanReservas,
// saldoItemReserva, ejecutarDevolucionReserva y conLogError son const/function declarados
// miles de líneas después de donde estaban estas rutas. Las rutas de reservas del plan
// (/api/plan/:fecha/reserva*, reservar, reserva/actualizar, reserva/devolver) quedaron en
// server.js: exigen un segmento extra fijo detrás de :fecha, así que ninguna ruta de este
// router las captura y el orden de registro no cambia a qué handler llega cada request.
app.use(require('./rutas_plan')({
  apiRoute, leerJSON, guardarJSON, query, DATA_DIR,
  PLANES_PATH, PROD_REG_PATH, CATALOGO_PATH, GRUPOS_CFG_PATH,
  safeDate, leerPlanReservas, saldoItemReserva, ejecutarDevolucionReserva,
  leerOrdenes, guardarOrdenes, conLogError,
  tiposPackaging, FORMULA_ACTIVA_SQL, SIN_FORMULA_GENERICO_SQL,
  sqlStockTerminados, sqlStockGranel, sqlBOMGranel, sqlStockPorPlu,
  buildCatalogoMaps, cfgActivo, cfgGranelPlu, cfgEsGranel,
  sucursalesSiga, sucursalPublica,
}));

// Auth y Centro de control: no lleva deps — auth.js y path se requieren directo.
// Ninguna ruta que quedó en server.js solapa con /login, /admin ni /api/admin/*.
app.use(require('./rutas_auth')());


async function start() {
  auth.seedAdminSiVacio(); // crea admin inicial si data/usuarios.json está vacío
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
