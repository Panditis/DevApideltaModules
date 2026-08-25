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
const { calcularAlmacen, pisoMinimo } = require('./distribucion');
const comprasModulo = require('./compras_modulo');
const prediccionConsumo = require('./prediccion_consumo');
const preciosProv = require('./precios_proveedores');
const preciosHistorico = require('./precios_historico');
const pdfParse = require('pdf-parse');
const { calcularPesables } = require('./pesables');
const { universoLista, universoPesables } = require('./listas_universo');   // membresía de lista (qué PLUs entran a cada tab)
const { calcularFaltantesFraccionado } = require('./fraccionado_faltantes');
const { resolverProductoCarga, analizarNombreCarga, pesoTokenKg, sqlNombresPorPlu } = require('./producto_carga');
const { validarLineasFraccionado, normalizarLineasFraccionado, totalesOrdenFraccionado,
        progresoOrdenFraccionado, marcarLineaOrden, editarLineaOrden, validarLineasNoRepetidas,
        plusEnOrdenesActivas } = require('./ordenes_fraccionado');
const { computeA8020, calcularRankingPorSucursal, calcularRankingGlobal, roundDec, aplicarManualA8020, asegurarBrechaMinS,
        calcularConsumoReal, RUBRO_ALMACEN_BULTO } = require('./a8020');
const analisisVentas = require('./analisis_ventas');
const familiasManuales = require('./familias_manuales');
const productividad = require('./productividad');
const resumenesLegacy = require('./resumenes_legacy');
const historialSala = require('./historial_sala');
const cuentasCorrientes = require('./cuentas_corrientes');
const cruceTerminales = require('./cruce_terminales');
const rrhhRopa = require('./rrhh_ropa');
const { migrarReservas, saldoLedger, itemsSinReservar, reservadoPorMovimiento, ordenesDeMovimiento, conciliarPorMovimiento, depositosProduccion, lineasAjusteMovimiento, lineasDiferenciasProduccion, ordenesProducidasDeReserva, motivoBloqueoProduccion, sanearSellosReserva } = require('./reservas_movimiento');
const { validarLineasReserva, normalizarLineasReserva, validarClienteReserva,
        validarCarritoUnCliente, nuevaReserva, anularReserva } = require('./reservas_mercaderia');
const bloquesTareas = require('./bloques_tareas');

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
function sqlBOM(rubros) {
  return sqlBOMGranel(rubros);
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

// Rubro que nunca aparece en el buscador manual del plan del día (bultos/cajas de almacén).
const RUBRO_MANUAL_EXCLUIDO_RE = /almacen\s*bultos\s*\/?\s*cajas/i;
// SAVONA son productos especiales: pasan por encima de la exclusion de rubro (igual que /api/productos/buscar).
const PRODUCTO_SAVONA_RE = /savona/i;

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
  if (params.q) {
    const q = String(params.q).toLowerCase();
    // El buscador manual del plan del día no ofrece "Almacen Bultos/Cajas": no se producen por unidad.
    out = out.filter(r => PRODUCTO_SAVONA_RE.test(String(r.producto || '')) || !RUBRO_MANUAL_EXCLUIDO_RE.test(String(r.rubro || '')));
    out = out.filter(r => r.producto.toLowerCase().includes(q) || r.rubro.toLowerCase().includes(q));
  }
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
  return sqlBOMGranel(rubrosG, `\n  AND pc.IdProducto IN (${pluList.join(',')})`);
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
  const [consumoRows, pendientesRows, stockRows, stockTodosRows, stockSucRows, bomRows, granelRows, customGranelNomRows, facturRows] = await Promise.all([
    queryEnLotes(l => sqlConsumoCatalogo(l, ventana)), queryEnLotes(l => sqlPendientesPorPlu(l)),
    queryEnLotes(l => sqlStockPorPlu(l)), queryEnLotes(l => sqlStockTodosDepositos(l)),
    queryEnLotes(l => sqlStockSucursales(l)),
    queryEnLotes(l => sqlBOMPorPlu(l, rubrosG)), query(sqlStockGranel(rubrosG)),
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
  // Stock del granel: se suman todos los depósitos de la central, sin filtrar por nombre de
  // depósito. El LIKE '%GRANEL%' de sqlStockGranel devuelve siempre 0 (ningún depósito de Siga se
  // llama así), así que ese valor solo sirve de fallback. El granel ya es un producto propio
  // ("X DEPOSITO GRANEL"): alcanza con acotar por PLU, igual que fraccionado y pesables.
  const granelMap  = new Map(granelRows.map(r => [String(r.IdProducto), parseFloat(r.StockGranel)]));
  const granelPlusUsados = [...new Set([...customGranelPlus, ...bomRows.map(b => String(b.IdProductoComponente))])].filter(p => /^\d+$/.test(p));
  for (let i = 0; i < granelPlusUsados.length; i += 1000) {
    const rows = await query(sqlStockTodosDepositos(granelPlusUsados.slice(i, i + 1000)));
    for (const r of rows) granelMap.set(String(r.IdProducto), parseFloat(r.StockActual) || 0);
  }
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
  // Granel del grupo: PLU cargado a mano en el catálogo (grupos_config.granelPlu) y, si no hay,
  // el componente granel de la fórmula activa de sus bases (el de mayor CantPorUnidad = principal).
  function resolverGranelGrupo(refInfo) {
    const custom = cfgGranelPlu(gruposCfg, refInfo.productoRef);
    if (custom) return { id: custom, nombre: customGranelNomMap.get(custom) || custom };
    let mejor = null;
    for (const bInfo of refInfo.bases.values()) {
      if (!bInfo.pluBase) continue;
      const bom = bomRaw.get(String(bInfo.pluBase));
      if (!bom) continue;
      const cant = parseFloat(bom.CantPorUnidad || 0);
      if (!mejor || cant > mejor.cant) mejor = { id: String(bom.IdProductoComponente), nombre: bom.NombreComponente || '', cant };
    }
    return mejor ? { id: mejor.id, nombre: mejor.nombre } : null;
  }
  const grupos = [];
  for (const [refId, refInfo] of refMap) {
    // Stock del granel del grupo (se necesita ANTES de calcular consumo para elegir denominador)
    const esGranelCheck = cfgEsGranel(gruposCfg, refInfo.productoRef, c.gruposGranel);
    let granelStockGrupo = 0, nombreGranelGrupo = '', granelIdGrupo = '';
    const granelRef = resolverGranelGrupo(refInfo);
    if (granelRef) {
      // Sin fila de stock del granel → 0 (quiebre real), no el stock de los terminados.
      granelIdGrupo     = granelRef.id;
      nombreGranelGrupo = granelRef.nombre;
      granelStockGrupo  = Math.round((granelMap.get(granelRef.id) || 0) * 100) / 100;
    } else if (esGranelCheck) {
      let base10 = null;
      for (const [base, bInfo] of refInfo.bases) { if (/10\s*kg/i.test(base) && bInfo.pluBase) { base10 = base; granelIdGrupo = String(bInfo.pluBase); break; } }
      if (base10) { granelStockGrupo = stockBaseAll.get(base10) || 0; nombreGranelGrupo = base10; }
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
      totalSugerido, esGranel: false, granelStockGrupo, nombreGranelGrupo, granelId: granelIdGrupo,
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
app.get('/produccion',    (_req, res) => res.sendFile(path.join(__dirname, cfg.produccionHtml || 'apidelta_produccion_dia.html')));
app.get('/planificacion', (_req, res) => res.sendFile(path.join(__dirname, 'planificacion.html')));
app.get('/productividad',  (_req, res) => res.sendFile(path.join(__dirname, 'productividad.html')));
app.get('/compras',       (_req, res) => res.sendFile(path.join(__dirname, 'compras_modulo.html')));
app.get('/consumo',       (_req, res) => res.sendFile(path.join(__dirname, 'dashboard_consumo.html')));
// Ruta histórica del módulo de reposición: ahora Compras es un solo módulo servido en /compras.
app.get('/compras-modulo', (_req, res) => res.redirect(301, '/compras'));
// Análisis de ventas: una sola página con pestañas (Sucursales / Casa Central). Las dos
// rutas históricas siguen vivas porque cada una es el guard de su módulo de permiso; el
// front abre la pestaña que corresponde al path por el que se entró.
app.get(['/analisis-ventas', '/analisis-central'], (_req, res) => res.sendFile(path.join(__dirname, 'analisis.html')));
// El CSS y el JS del módulo van aparte para no repetirlos en cada pestaña. El proyecto no
// usa express.static: cada asset se declara con su propia ruta.
app.get('/analisis.css', (_req, res) => res.sendFile(path.join(__dirname, 'analisis.css')));
app.get('/analisis_graficos.js', (_req, res) => res.sendFile(path.join(__dirname, 'analisis_graficos.js')));
app.get('/analisis_familias_manuales.js', (_req, res) => res.sendFile(path.join(__dirname, 'analisis_familias_manuales.js')));
app.get('/analisis_front.js', (_req, res) => res.sendFile(path.join(__dirname, 'analisis_front.js')));
// El cálculo de la agenda de bloques corre igual en el server (validación) y en el browser
// (recálculo en vivo). El proyecto no usa express.static: el asset lleva su propia ruta.
app.get('/bloques_tareas.js', (_req, res) => res.sendFile(path.join(__dirname, 'bloques_tareas.js')));
app.get('/diagnostico-quiebre', (_req, res) => res.sendFile(path.join(__dirname, 'diagnostico_quiebre.html')));
app.get('/cruce-terminales', (_req, res) => res.sendFile(path.join(__dirname, 'cruce_terminales.html')));
app.get('/precios-historico', (_req, res) => res.sendFile(path.join(__dirname, 'precios_historico.html')));
app.get('/cuentas-corrientes', (_req, res) => res.sendFile(path.join(__dirname, 'cuentas_corrientes.html')));
// RRHH: sub-hub con los módulos del área y, colgando de él, cada submódulo.
app.get('/rrhh',                    (_req, res) => res.sendFile(path.join(__dirname, 'rrhh.html')));
app.get('/rrhh/relevamiento-ropa',  (_req, res) => res.sendFile(path.join(__dirname, 'rrhh_relevamiento_ropa.html')));
app.get('/rrhh_relevamiento_ropa.js', (_req, res) => res.sendFile(path.join(__dirname, 'rrhh_relevamiento_ropa.js')));
app.get('/login',         (_req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/admin',         (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// ── API de autenticación / sesión ───────────────────────────────────────────────
// Throttle simple en memoria contra fuerza bruta (por IP).
const loginIntentos = new Map(); // ip -> { count, hasta }
const LOGIN_MAX = 8;
const LOGIN_BLOQUEO_MS = 15 * 60 * 1000;
app.post('/api/login', (req, res) => {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const ahora = Date.now();
  const reg = loginIntentos.get(ip);
  if (reg && reg.hasta > ahora && reg.count >= LOGIN_MAX) {
    return res.status(429).json({ error: 'Demasiados intentos fallidos. Esperá unos minutos.' });
  }
  const { usuario, password } = req.body || {};
  const user = auth.autenticar(usuario, password);
  if (!user) {
    const enVentana = reg && reg.hasta > ahora;
    loginIntentos.set(ip, enVentana ? { count: reg.count + 1, hasta: reg.hasta } : { count: 1, hasta: ahora + LOGIN_BLOQUEO_MS });
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }
  loginIntentos.delete(ip);
  // Regenerar la sesión al autenticar evita fijación de sesión.
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'No se pudo iniciar sesión.' });
    req.session.user = user;
    res.json({ ok: true, user });
  });
});
app.post('/api/logout', (req, res) => {
  if (req.session) return req.session.destroy(() => res.json({ ok: true }));
  res.json({ ok: true });
});
app.get('/api/session', (req, res) => {
  res.json({ user: (req.session && req.session.user) || null });
});
// Módulos del hub: todos los activos no-admin. Cada uno trae `permitido` (si el
// usuario actual puede entrar) para que el front muestre los bloqueados igual.
app.get('/api/modulos', (req, res) => {
  const user = req.session && req.session.user;
  const lista = auth.leerModulos()
    .filter(m => m.activo && !m.soloAdmin)
    .map(m => ({ ...m, permitido: m.requiereAuth === false || auth.puedeAcceder(user, m.ref) }));
  res.json(lista);
});

// ── API del Centro de control (protegida por requireAuth: sólo admin) ────────────
app.get('/api/admin/usuarios', (_req, res) => res.json(auth.listarUsuarios()));
app.post('/api/admin/usuarios', (req, res) => {
  try { res.json({ ok: true, user: auth.crearUsuario(req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/admin/usuarios/:id', (req, res) => {
  try { res.json({ ok: true, user: auth.actualizarUsuario(req.params.id, req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/admin/usuarios/:id', (req, res) => {
  try { auth.eliminarUsuario(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/admin/modulos', (_req, res) => res.json(auth.leerModulos()));
app.put('/api/admin/modulos', (req, res) => {
  try { res.json({ ok: true, modulos: auth.guardarModulos(req.body || []) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Persistencia JSON ──────────────────────────────────────────────────────────
const DATA_DIR       = path.join(__dirname, 'data');
const ORDENES_PATH   = path.join(DATA_DIR, 'ordenes.json');
const REGISTROS_PATH = path.join(DATA_DIR, 'registros.json');
const PLANES_PATH    = path.join(DATA_DIR, 'planes.json');
const RESP_PATH      = path.join(DATA_DIR, 'responsables.json');
const CATALOGO_PATH  = path.join(DATA_DIR, 'catalogo.json');
const GRUPOS_CFG_PATH = path.join(DATA_DIR, 'grupos_config.json');
const ENVASES_REG_PATH = path.join(DATA_DIR, 'envases_registro.json'); // [{codigo,nombre,stock}]
const TAPAS_REG_PATH   = path.join(DATA_DIR, 'tapas_registro.json');    // [{codigo,nombre,stock}]
const CLIENTES_PATH    = path.join(DATA_DIR, 'clientes.json');          // [{id,nombre}]
const FORMULAS_PATH  = path.join(DATA_DIR, 'formulas.json'); // { "plu": [{plu,nombre,cantPorUnidad}] }
const TRACKING_PRODUCCION_PATH = path.join(DATA_DIR, 'tracking_produccion.json'); // [{plu,nombre}]
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
const COMPRAS_PROD_PATH  = path.join(DATA_DIR, 'compras_productos.json');
const PRESENTACIONES_COMPRA_PATH = path.join(DATA_DIR, 'presentaciones_compra.json');
// NOTA: no se reusa ORDENES_PATH (data/ordenes.json) porque ya está en uso por /api/ordenes y
// /api/ordenes-produccion (órdenes de producción, dominio no relacionado) — archivo dedicado para no mezclar datos.
const ORDENES_COMPRA_PATH = path.join(DATA_DIR, 'ordenes_compra.json');
// Lead time por proveedor en días: { "_default": 14, "<NOMBRE PROVEEDOR>": 4 }. Se usa
// al pasar la orden a ENVIADA para estimar la fecha de llegada. Si el archivo no existe,
// compras_modulo cae al default (14 días), así que no hace falta crearlo a mano.
const LEAD_TIMES_PATH = path.join(DATA_DIR, 'lead_times.json');
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
// Qué tareas lleva cada producto o rubro y cuánto dura cada una. Va en su propio archivo y no
// dentro del plan: las plantillas son la receta, valen para todos los días y no se pisan al
// cambiar de fecha.
const PLANTILLAS_TAREAS_PATH = path.join(DATA_DIR, 'plantillas_tareas.json');

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

// ── Mayoristas: órdenes de fraccionado ─────────────────────────────────────────
// Detecta productos con faltante de stock fraccionado que sí tienen granel disponible.
// Los pendientes salen de getResumen (por cliente+producto, mismos filtros que la tab),
// el granel de sqlBOMGranel (fórmula activa, dos niveles) y el stock de los depósitos GRANEL
// de la central. El cálculo en sí vive en fraccionado_faltantes.js (puro, testeado).
async function getFaltantesFraccionado(desde, hasta, localidades, clientes, pedidos, estados) {
  const filasResumen = await getResumen(desde, hasta, localidades, clientes, pedidos, estados);
  if (!filasResumen.length) return [];

  // Agregado por PLU conservando el desglose de clientes (getResumen viene por cliente+producto).
  const porPlu = new Map();
  for (const r of filasResumen) {
    const plu = String(r.IdProducto);
    if (!porPlu.has(plu)) {
      porPlu.set(plu, {
        plu, nombre: r.NombreProducto, rubro: r.NombreRubro || '',
        pendiente: 0, stockCentral: Number(r.StockCentral) || 0, clientes: [],
      });
    }
    const acc = porPlu.get(plu);
    const pend = Number(r.TotalUnidades) || 0;
    acc.pendiente += pend;
    acc.clientes.push({ idCliente: r.IdCliente, nombre: r.NombreCliente, pendiente: pend });
  }

  // Se relee config.json por request igual que /api/stock/granel y /api/bom, los otros dos
  // consumidores de rubrosGranel: así editar la config no deja este endpoint desalineado
  // con ellos hasta el próximo reinicio. Local `c` para no pisar el `cfg` global del módulo.
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  const rubrosG = c.rubrosGranel.join(',');
  const plus = [...porPlu.keys()].filter(p => /^\d+$/.test(p));
  if (!plus.length) return [];
  const filtroPadre = ` AND pc.IdProducto IN (${plus.map(p => `'${p}'`).join(',')})`;

  const bomRows = await query(sqlBOMGranel(rubrosG, filtroPadre));
  const bomGranel = new Map();
  for (const b of bomRows) {
    const plu = String(b.IdProducto);
    // sqlBOMGranel puede devolver más de un componente granel por producto; nos quedamos con
    // el de mayor CantPorUnidad, que es el ingrediente principal (el resto son trazas).
    const cand = { granelPlu: String(b.IdProductoComponente), granelNombre: b.NombreComponente || '',
                   cantPorUnidad: Number(b.CantPorUnidad) || 0 };
    const prev = bomGranel.get(plu);
    if (!prev || cand.cantPorUnidad > prev.cantPorUnidad) bomGranel.set(plu, cand);
  }
  if (!bomGranel.size) return [];

  // Stock del granel: se suman todos los depósitos de la central, sin filtrar por nombre de
  // depósito. El filtro LIKE '%GRANEL%' no sirve acá (ningún depósito se llama así en Siga: el
  // preexistente /api/stock/granel devuelve StockGranel=0 con StockTotal>0 por ese mismo motivo).
  // El granel ya es un producto propio ("X DEPOSITO GRANEL"), así que alcanza con acotar por PLU,
  // igual que hace el módulo de pesables al resolver su columna de granel.
  const granelCodes = [...new Set([...bomGranel.values()].map(b => b.granelPlu))].filter(g => /^\d+$/.test(g));
  const granelRows = granelCodes.length ? await query(`
    SELECT pd.IdProducto, COALESCE(SUM(pd.Stock),0) AS Stock
    FROM ProductosDepositos pd
    INNER JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal
    INNER JOIN Sucursales s ON s.IdSucursal=pd.IdSucursal
    WHERE s.SoyLaCentral=1
      AND pd.IdProducto IN (${granelCodes.map(g => `'${g}'`).join(',')})
    GROUP BY pd.IdProducto`) : [];
  const stockGranel = new Map(granelRows.map(r => [String(r.IdProducto), Number(r.Stock) || 0]));

  return calcularFaltantesFraccionado([...porPlu.values()], bomGranel, stockGranel);
}

app.get('/api/mayoristas/fraccionado-faltantes', apiRoute(async req => {
  const p = params(req);
  return getFaltantesFraccionado(p.desde, p.hasta, p.localidades, p.clientes, p.pedidos, p.estados);
}));

// Escapa un texto para usarlo como prefijo de un LIKE: además de duplicar la comilla simple
// (mismo criterio que el resto del archivo), neutraliza los comodines de SQL Server con la
// notación de corchetes, así un nombre con "%" o "_" no se convierte en un patrón abierto.
function escaparLikePrefijo(s) {
  return String(s || '').replace(/'/g, "''").replace(/[%_\[]/g, c => `[${c}]`);
}

// Producto contra el cual la encargada carga la producción de una línea mayorista.
// No es el producto de la línea ni el componente del BOM: la regla es por nombre y vive en
// producto_carga.js (puro, testeado). Acá sólo se arma el catálogo de candidatos.
app.get('/api/mayoristas/producto-carga', apiRoute(async req => {
  const plu = String(req.query.plu || '').trim();
  // Siempre 200 con `motivo`: la UI tiene que poder avisar "no se pudo resolver" y seguir
  // trabajando, no romper la pantalla de carga con un 500.
  if (!/^\d+$/.test(plu)) return { plu: null, motivo: 'PLU inválido' };

  const filas = await query(
    `SELECT TOP 1 IdProducto, NombreProducto FROM dbo.Productos WHERE IdProducto='${plu}'`);
  if (!filas.length) return { plu: null, motivo: `No existe el producto ${plu}` };
  const nombreMayorista = String(filas[0].NombreProducto || '');

  const info = analizarNombreCarga(nombreMayorista);
  if (!info.base) return { plu: null, nombreMayorista, motivo: 'No se pudo derivar el nombre base' };

  // Se acota por prefijo del nombre base en vez de traer los ~20k productos: tanto el minorista
  // ("Mix Europeo 200G") como el PEDIDOS ("Mix Europeo PEDIDOS") empiezan con ese base. El TOP
  // es un tope de seguridad para bases muy cortas; el orden lo hace determinista.
  const candidatos = await query(
    `SELECT TOP 300 IdProducto, NombreProducto FROM dbo.Productos
     WHERE Activo=1 AND NombreProducto LIKE '${escaparLikePrefijo(info.base)}%'
     ORDER BY NombreProducto`);

  const destino = resolverProductoCarga(nombreMayorista,
    candidatos.map(r => ({ plu: String(r.IdProducto), nombre: r.NombreProducto })));
  if (!destino) {
    const esperado = info.presentacionKg != null && info.presentacionKg <= 1
      ? `${info.base} de ${info.presentacionKg} kg` : `${info.base} PEDIDOS`;
    return { plu: null, nombreMayorista, base: info.base, presentacionKg: info.presentacionKg,
             motivo: `No se encontró el producto de carga (${esperado})` };
  }

  // Granel del destino: la pantalla de carga lo necesita para mostrar los kg que consume cada
  // unidad. Es informativo, así que si el destino no tiene fórmula activa se devuelve igual.
  let granel = null;
  if (/^\d+$/.test(destino.plu)) {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

    // Destino con UN solo componente directo: ese componente ES el producto que se descuenta.
    // Es el caso de las mezclas que se envasan desde un granel que no está en rubrosGranel
    // ("G. KETO PEDIDOS" → "G. KETO 10Kg (Precio por kilo)", cantidad 1). sqlBOMGranel no lo ve
    // por el rubro, baja un nivel más y devuelve un ingrediente suelto de la mezcla
    // (Nuez Cuartillo 0.224), que no es lo que se consume al fraccionar.
    const directos = await query(`
      SELECT pc.IdProductoComponente, p.NombreProducto AS NombreComponente, pc.Cantidad AS CantPorUnidad
      FROM ProductosComponentes pc INNER JOIN Productos p ON p.IdProducto=pc.IdProductoComponente
      WHERE pc.IdProducto='${destino.plu}' AND ${FORMULA_ACTIVA_SQL} AND ${SIN_FORMULA_GENERICO_SQL}`);
    if (directos.length === 1) {
      const d = directos[0];
      return { ...destino, nombreMayorista, base: info.base,
               granelPlu: String(d.IdProductoComponente), granelNombre: d.NombreComponente || '',
               cantPorUnidad: Number(d.CantPorUnidad) || 0 };
    }

    const bomRows = await query(
      sqlBOMGranel(c.rubrosGranel.join(','), ` AND pc.IdProducto IN ('${destino.plu}')`));
    for (const b of bomRows) {
      const cand = { granelPlu: String(b.IdProductoComponente), granelNombre: b.NombreComponente || '',
                     cantPorUnidad: Number(b.CantPorUnidad) || 0 };
      // Mismo criterio que getFaltantesFraccionado: el componente principal es el de mayor
      // CantPorUnidad, el resto son trazas.
      if (!granel || cand.cantPorUnidad > granel.cantPorUnidad) granel = cand;
    }
  }

  return { ...destino, nombreMayorista, base: info.base, ...(granel || {}) };
}));

const ORD_FRACC_PATH = path.join(DATA_DIR, 'ordenes_fraccionado.json');

// La validación, la normalización y los totales viven en ordenes_fraccionado.js (puro, testeado):
// el granel es opcional porque el armado manual de órdenes incluye productos sin granel resoluble.

// El progreso por línea se calcula al vuelo en cada respuesta y NO se persiste: así no puede
// quedar desincronizado de `lineas` si una orden se edita por otra vía.
const conProgreso = orden => ({ ...orden, progreso: progresoOrdenFraccionado(orden.lineas) });

app.get('/api/mayoristas/ordenes-fraccionado', apiRoute(async () =>
  leerJSON(ORD_FRACC_PATH, []).slice().sort((a, b) => b.id - a.id).map(conProgreso)));

// Los cuatro handlers que siguen van con (req, res) crudo y NO con apiRoute: apiRoute hace
// `res.json(await fn(req))`, sin forma de setear el status, así que envolverlos convertiría
// los 400 de validación y los 404 en respuestas 200. Es el mismo criterio que el resto de las
// rutas de escritura del archivo (ver /api/admin/modulos).
// Va ANTES de :id (Express matchea por orden de registro y 'plus-activos' caería en el handler
// de arriba). Es la lista de PLU que el carrito no puede volver a agregar: la usa pedidos_web.html
// para bloquear el alta en el momento, sin bajarse todas las órdenes con sus líneas.
app.get('/api/mayoristas/ordenes-fraccionado/plus-activos', apiRoute(async () =>
  [...plusEnOrdenesActivas(leerJSON(ORD_FRACC_PATH, []))]));

// También ANTES de :id, por lo mismo que plus-activos. Endpoint liviano de polling: Distribución
// pregunta cada tanto si hay órdenes nuevas o editadas, así que devuelve sólo los sellos de tiempo
// y la cantidad de líneas, nunca las líneas enteras.
app.get('/api/mayoristas/ordenes-fraccionado/novedades', apiRoute(async () =>
  leerJSON(ORD_FRACC_PATH, [])
    .filter(o => o && o.estado === 'pendiente')
    .map(o => {
      // Las órdenes guardadas antes de estos campos no los tienen, pero el id ES un Date.now():
      // alcanza para que el polling detecte un alta vieja sin tener que migrar el archivo.
      const creadoEn = Number(o.creadoEn) || Number(o.id) || 0;
      return {
        id: o.id, fecha: o.fecha, estado: o.estado,
        creadoEn, actualizadoEn: Number(o.actualizadoEn) || creadoEn,
        lineas: Array.isArray(o.lineas) ? o.lineas.length : 0,
      };
    })));

app.get('/api/mayoristas/ordenes-fraccionado/:id', (req, res) => {
  const orden = leerJSON(ORD_FRACC_PATH, []).find(o => String(o.id) === String(req.params.id));
  if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });
  res.json(conProgreso(orden));
});

app.post('/api/mayoristas/ordenes-fraccionado', (req, res) => {
  const error = validarLineasFraccionado(req.body && req.body.lineas);
  if (error) return res.status(400).json({ error });
  const arr = leerJSON(ORD_FRACC_PATH, []);
  // Un artículo se manda a fraccionar una sola vez: si ya está en una orden sin anular (o repetido
  // dentro del mismo body) se rechaza la orden entera. 409 y no 400 porque el body es válido: lo
  // que choca es el estado del archivo, y el frontend lo distingue para avisar de otra manera.
  const repetido = validarLineasNoRepetidas(req.body.lineas, arr);
  if (repetido) return res.status(409).json({ error: repetido });
  const lineas = normalizarLineasFraccionado(req.body.lineas);
  // Un solo Date.now() para los dos: una orden recién creada nunca puede figurar como editada.
  const ahora = Date.now();
  const orden = {
    id: ahora,
    fecha: new Date().toISOString().slice(0, 10),
    // Sellos que consulta el polling de /novedades: alta y última modificación de la orden.
    creadoEn: ahora,
    actualizadoEn: ahora,
    origen: 'mayorista',
    estado: 'pendiente',
    usuario: String((req.body && req.body.usuario) || ''),
    filtros: (req.body && req.body.filtros) || {},
    lineas,
    totales: totalesOrdenFraccionado(lineas),
  };
  arr.push(orden);
  guardarJSON(ORD_FRACC_PATH, arr);
  res.json(conProgreso(orden));
});

// Va ANTES del PUT /:id sólo por claridad: Express no necesita el orden acá porque `:id` no matchea
// barras, así que /:id/lineas/:plu nunca cae en el handler de arriba ni al revés.
app.put('/api/mayoristas/ordenes-fraccionado/:id/lineas/:plu', (req, res) => {
  const arr = leerJSON(ORD_FRACC_PATH, []);
  const i = arr.findIndex(o => String(o.id) === String(req.params.id));
  if (i < 0) return res.status(404).json({ error: 'Orden no encontrada' });
  const body = req.body || {};
  // La fecha y la hora las pone el server: el cliente no puede antedatar una carga de producción.
  // Las dos salen del MISMO Date y en hora local, no UTC: con toISOString() una carga hecha
  // después de las 21:00 ART quedaba fechada al día siguiente, y la hora habría salido corrida.
  const ahora = new Date();
  const dosDig = n => String(n).padStart(2, '0');
  const { orden, error } = marcarLineaOrden(arr[i], req.params.plu, {
    estado: body.estado,
    cargadoCant: body.cargadoCant,
    fecha: `${ahora.getFullYear()}-${dosDig(ahora.getMonth() + 1)}-${dosDig(ahora.getDate())}`,
    hora: `${dosDig(ahora.getHours())}:${dosDig(ahora.getMinutes())}`,
  });
  if (error) return res.status(400).json({ error });
  arr[i] = orden;
  guardarJSON(ORD_FRACC_PATH, arr);
  res.json(conProgreso(orden));
});

// Corrección de la cantidad pedida de UNA línea, desde Pedidos mayoristas. Aparte del PUT de
// /lineas/:plu (que es el avance de la sala) porque son dos permisos y dos reglas distintas:
// editar sólo se puede mientras la línea siga pendiente.
app.put('/api/mayoristas/ordenes-fraccionado/:id/lineas/:plu/cantidad', (req, res) => {
  const arr = leerJSON(ORD_FRACC_PATH, []);
  const i = arr.findIndex(o => String(o.id) === String(req.params.id));
  if (i < 0) return res.status(404).json({ error: 'Orden no encontrada' });
  const body = req.body || {};
  // Igual que en el PUT de arriba: fecha y hora las pone el server, del MISMO Date y en hora
  // local (con toISOString() una edición después de las 21:00 ART quedaría fechada al día siguiente).
  const ahora = new Date();
  const dosDig = n => String(n).padStart(2, '0');
  const { orden, error } = editarLineaOrden(arr[i], req.params.plu, {
    cantidad: body.cantidad,
    nota: body.nota,
    fecha: `${ahora.getFullYear()}-${dosDig(ahora.getMonth() + 1)}-${dosDig(ahora.getDate())}`,
    hora: `${dosDig(ahora.getHours())}:${dosDig(ahora.getMinutes())}`,
  });
  if (error) return res.status(400).json({ error });
  // Los totales cambian con la cantidad, así que se recalculan siempre acá y no en el módulo puro.
  arr[i] = { ...orden, actualizadoEn: ahora.getTime(),
             totales: totalesOrdenFraccionado(orden.lineas) };
  guardarJSON(ORD_FRACC_PATH, arr);
  res.json(conProgreso(arr[i]));
});

app.put('/api/mayoristas/ordenes-fraccionado/:id', (req, res) => {
  const arr = leerJSON(ORD_FRACC_PATH, []);
  const i = arr.findIndex(o => String(o.id) === String(req.params.id));
  if (i < 0) return res.status(404).json({ error: 'Orden no encontrada' });
  const cambios = req.body || {};
  const ESTADOS = ['pendiente', 'aplicada', 'anulada'];
  if (cambios.estado !== undefined && !ESTADOS.includes(cambios.estado)) {
    return res.status(400).json({ error: `Estado inválido: ${cambios.estado}` });
  }
  let lineas = arr[i].lineas;
  if (cambios.lineas !== undefined) {
    const error = validarLineasFraccionado(cambios.lineas);
    if (error) return res.status(400).json({ error });
    lineas = normalizarLineasFraccionado(cambios.lineas);
  }
  // id y fecha no se pisan desde el body: son la identidad de la orden. `progreso` se descarta
  // (JSON.stringify saltea undefined) para que el que devuelve el GET nunca termine persistido
  // si el cliente reenvía la orden entera.
  arr[i] = { ...arr[i], ...cambios, id: arr[i].id, fecha: arr[i].fecha,
             lineas, totales: totalesOrdenFraccionado(lineas), progreso: undefined };
  guardarJSON(ORD_FRACC_PATH, arr);
  res.json(conProgreso(arr[i]));
});

app.delete('/api/mayoristas/ordenes-fraccionado/:id', (req, res) => {
  const arr = leerJSON(ORD_FRACC_PATH, []);
  const nuevo = arr.filter(o => String(o.id) !== String(req.params.id));
  if (nuevo.length === arr.length) return res.status(404).json({ error: 'Orden no encontrada' });
  guardarJSON(ORD_FRACC_PATH, nuevo);
  res.json({ ok: true });
});

// ── Reservas de mercaderia mayorista ──────────────────────────────────────────
// Apartan producto TERMINADO en SiGA para un cliente: un movimiento del deposito principal al
// de reserva. A diferencia de la reserva de planificacion NO se explota formula. Una reserva
// es de UN cliente y sale en UN movimiento: por eso no existe la falla parcial.
const RESERVAS_MERC_PATH = path.join(DATA_DIR, 'reservas_mercaderia.json');

app.get('/api/mayoristas/reservas', apiRoute(async () =>
  leerJSON(RESERVAS_MERC_PATH, []).slice().sort((a, b) => b.id - a.id)));

app.get('/api/mayoristas/reservas/:id', (req, res) => {
  const reserva = leerJSON(RESERVAS_MERC_PATH, []).find(r => String(r.id) === String(req.params.id));
  if (!reserva) return res.status(404).json({ error: 'Reserva no encontrada' });
  res.json(reserva);
});

// POST: un cliente, un movimiento. El orden de operaciones esta pensado para que un error
// temprano no deje nada a medias: primero se valida TODO (cliente, lineas, depositos, choques,
// stock) y recien al final se toca SiGA y se escribe el archivo.
// Va con (req, res) crudo y NO con apiRoute: apiRoute hace `res.json(await fn(req))`, sin forma
// de setear el status, asi que los 400 de validacion y el 409 saldrian como 200. Mismo criterio
// que el CRUD de ordenes-fraccionado.
app.post('/api/mayoristas/reservas', async (req, res) => {
  try {
    const b = req.body || {};

    const errCliente = validarClienteReserva(b.idCliente, b.nombreCliente);
    if (errCliente) return res.status(400).json({ error: errCliente });
    const errLineas = validarLineasReserva(b.lineas);
    if (errLineas) return res.status(400).json({ error: errLineas });
    const errMezcla = validarCarritoUnCliente(b.lineas, b.idCliente);
    if (errMezcla) return res.status(400).json({ error: errMezcla });

    const s = await resolverSucursal(b.idSucursal);
    if (s.error) return res.status(400).json({ error: s.error });
    const cr = s.cr;

    // Un deposito que viene en el body pero es invalido NO cae al config: se avisa, para no
    // reservar en el lugar equivocado. Mismo criterio que POST /api/plan/:fecha/reservar.
    const vinoOrigen  = b.depOrigen  !== undefined && b.depOrigen  !== null && b.depOrigen  !== '';
    const vinoDestino = b.depDestino !== undefined && b.depDestino !== null && b.depDestino !== '';
    const depOrigen   = vinoOrigen  ? Number(b.depOrigen)  : cr.depositoPrincipal;
    const depDestino  = vinoDestino ? Number(b.depDestino) : cr.depositoReserva;
    if (!vinoDestino && !cr.depositoReserva) {
      return res.status(400).json({ error: ERR_RESERVA_SIN_CONFIG });
    }
    if (!esIdDeposito(depOrigen) || !esIdDeposito(depDestino) || depOrigen === depDestino) {
      return res.status(400).json({ error: ERR_RESERVA_DEPOSITOS });
    }
    const activos = new Set((await depositosActivos(cr.idSucursal)).map(d => Number(d.IdDeposito)));
    if (!activos.has(depOrigen)) {
      return res.status(400).json({ error: `El deposito de origen ${depOrigen} no existe o no esta activo en la sucursal ${cr.idSucursal}` });
    }
    if (!activos.has(depDestino)) {
      return res.status(400).json({ error: `El deposito de destino ${depDestino} no existe o no esta activo en la sucursal ${cr.idSucursal}` });
    }

    const lineas = normalizarLineasReserva(b.lineas);

    // stockDeComponentes consulta ProductosDepositos por PLU, asi que sirve igual para
    // terminados y para componentes de formula: no sabe ni le importa que es cada uno.
    // Se suma por plu porque dos registros distintos pueden apartar el mismo componente y
    // el stock que hay que tener alcanza para los dos juntos, no para cada uno por separado.
    const stock = await stockDeComponentes(cr, lineas.map(l => l.plu), depOrigen, depDestino);
    const necesarioPorPlu = new Map();
    for (const l of lineas) necesarioPorPlu.set(l.plu, (necesarioPorPlu.get(l.plu) || 0) + l.cantidad);
    const faltantes = [...necesarioPorPlu.entries()].map(([plu, necesario]) => {
      const e = stock.get(plu) || { origen: 0, destino: 0 };
      const nombre = (lineas.find(l => l.plu === plu) || {}).nombre;
      return { plu, nombre, necesario: redondear4(necesario),
               stockOrigen: redondear4(e.origen), faltante: redondear4(Math.max(0, necesario - e.origen)) };
    }).filter(f => f.faltante > 0);
    // Con permitirFaltante se reserva igual la cantidad completa (el origen puede quedar en
    // negativo); sin el no se mueve nada.
    if (faltantes.length && b.permitirFaltante !== true) {
      return res.status(400).json({ error: 'Hay productos sin stock suficiente en el deposito de origen', faltantes });
    }

    // UN MOVIMIENTO POR REGISTRO: cada producto que el operador selecciono sale con su propio
    // comprobante de SiGA y su propia entrada en el archivo, para que cada uno se pueda anular
    // por separado. Si uno falla se corta ahi: lo ya emitido queda guardado y se informa cual
    // fallo, asi el operador reintenta solo eso en vez de duplicar lo que ya salio.
    const poolW = await getPoolStock();
    const arr = leerJSON(RESERVAS_MERC_PATH, []);
    const emitidas = [];
    let errorParcial = null;
    for (const l of lineas) {
      const observacion = `RESERVA MAY ${b.nombreCliente} ${l.nombre} ${depOrigen}>${depDestino}`.slice(0, 200);
      const movimiento = {
        idSucursal: cr.idSucursal, depOrigen, depDestino,
        idTipoMovimiento: cr.idTipoMovimiento, usuario: cr.usuario, idEmpleado: cr.idEmpleado,
        observacion,
      };
      let r;
      try {
        r = await ejecutarYRegistrar({
          origen: 'reserva-mayorista', plan: null, itemId: null, ...movimiento,
          lineas: [{ plu: l.plu, nombre: l.nombre, cantidad: l.cantidad }],
        }, () => trasladarStock(poolW, {
          ...movimiento,
          lineas: [{ idProducto: l.plu, cantidad: l.cantidad }],
        }));
      } catch (e) {
        errorParcial = { plu: l.plu, pluPedido: l.pluPedido, nombre: l.nombre, error: e.message };
        break;
      }
      emitidas.push(nuevaReserva({
        // El id lleva el indice: dos registros de la misma tanda caerian en el mismo Date.now().
        id: Date.now() * 100 + emitidas.length,
        fecha: new Date().toISOString(),
        idCliente: b.idCliente, nombreCliente: b.nombreCliente,
        idSucursal: cr.idSucursal, depOrigen, depDestino,
        numeroMovimiento: r.numeroMovimiento, idRegistro: r.idRegistro ?? null,
        usuario: cr.usuario,
        pluPedido: l.pluPedido, nombrePedido: l.nombrePedido,
        lineas: [{ plu: l.plu, nombre: l.nombre, cantidad: l.cantidad }],
      }));
    }

    if (emitidas.length) {
      guardarJSON(RESERVAS_MERC_PATH, [...arr, ...emitidas]);
    }
    if (errorParcial) {
      // 207: parte salio y parte no. El frontend saca del carrito solo lo emitido.
      return res.status(emitidas.length ? 207 : 500).json({
        error: `No se pudo reservar ${errorParcial.nombre}: ${errorParcial.error}`,
        emitidas, fallo: errorParcial,
      });
    }
    res.json({ ok: true, emitidas });
  } catch (e) {
    // Error ANTES del primer movimiento (validacion, SiGA caido al pedir depositos): no se
    // escribio nada, el carrito del navegador queda intacto y reintentar es seguro. Los
    // errores a mitad de la tanda los maneja el 207 de arriba.
    res.status(500).json({ error: e.message });
  }
});

// Anular: el movimiento inverso, deposito de reserva -> principal, con las mismas lineas y un
// solo comprobante. La sucursal y los depositos salen de la reserva, NO del config ni del body:
// cambiar de sucursal en la pantalla no puede hacer que la devolucion mueva stock en otro lado.
app.post('/api/mayoristas/reservas/:id/anular', async (req, res) => {
  try {
    const arr = leerJSON(RESERVAS_MERC_PATH, []);
    const i = arr.findIndex(r => String(r.id) === String(req.params.id));
    if (i < 0) return res.status(404).json({ error: 'Reserva no encontrada' });
    const reserva = arr[i];
    if (reserva.estado === 'anulada') {
      return res.status(409).json({ error: `La reserva #${reserva.id} ya esta anulada` });
    }

    const cr = cfgReserva();
    const poolW = await getPoolStock();
    const observacion = `ANULA RESERVA MAY ${reserva.nombreCliente} #${reserva.numeroMovimiento}`.slice(0, 200);
    const mov = {
      idSucursal: reserva.idSucursal, depOrigen: reserva.depDestino, depDestino: reserva.depOrigen,
      idTipoMovimiento: cr.idTipoMovimiento, usuario: cr.usuario, idEmpleado: cr.idEmpleado,
      observacion,
    };
    const r = await ejecutarYRegistrar({
      origen: 'devolucion', plan: null, itemId: null,
      ...mov,
      lineas: reserva.lineas.map(l => ({ plu: l.plu, nombre: l.nombre, cantidad: l.cantidad })),
    }, () => trasladarStock(poolW, {
      ...mov,
      lineas: reserva.lineas.map(l => ({ idProducto: l.plu, cantidad: l.cantidad })),
    }));

    const { reserva: anulada, error } = anularReserva(reserva, {
      numeroMovimiento: r.numeroMovimiento, idRegistro: r.idRegistro ?? null,
      fecha: new Date().toISOString(),
    });
    if (error) return res.status(409).json({ error });
    arr[i] = anulada;
    guardarJSON(RESERVAS_MERC_PATH, arr);
    res.json(conLogError(anulada, r.logError));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
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
    granelPlus:   cfgGranelPlus(gruposCfg, g.productoRef),
    mpManual:     cfgMpManual(gruposCfg, g.productoRef),
    esGranel:        cfgEsGranel(gruposCfg, g.productoRef, cCfg.gruposGranel),
    granelDirecto:   cfgGranelOverride(gruposCfg, g.productoRef),
    esMiel:          cfgEsMiel(gruposCfg, g.productoRef),
    reqGranel:       cfgReqGranel(gruposCfg, g.productoRef)
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
      // Lista de graneles; granelPlu se mantiene sincronizado con el primero.
      const gl = [...new Set((Array.isArray(v.granelPlus) ? v.granelPlus : [])
        .map(x => String(x || '').trim()).filter(Boolean))];
      const g = gl[0] || String(v.granelPlu||'').trim();
      const mp = Array.isArray(v.mpManual) ? v.mpManual.filter(x => x && x.nombre) : [];
      const gd = (typeof v.granelDirecto === 'boolean') ? v.granelDirecto : undefined;
      const em = (typeof v.esMiel === 'boolean') ? v.esMiel : undefined;
      const rg = (v.reqGranel === true) ? true : undefined;
      if (!g && !mp.length && gd === undefined && em === undefined && rg === undefined) { normalizado[k] = a; }
      else { normalizado[k] = {activo:a, ...(g?{granelPlu:g}:{}), ...(gl.length>1?{granelPlus:gl}:{}), ...(mp.length?{mpManual:mp}:{}), ...(gd!==undefined?{granelDirecto:gd}:{}), ...(em!==undefined?{esMiel:em}:{}), ...(rg?{reqGranel:true}:{})}; }
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
  // El barrido del token de peso vive en producto_carga.js: lo comparten esta función y la
  // resolución del producto de carga, y tener dos regex iguales en dos archivos ya nos había
  // dejado criterios divergiendo. La diferencia entre ambos usos es sólo el atajo "por kilo"
  // de arriba, que acá aplica (peso de la bolsa) y allá no (tamaño del envase).
  const kgToken = pesoTokenKg(n);
  if (kgToken != null) return kgToken;
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
// Sucursal (clave de a8020_calc.detalle) → clave del nivel S en a8020.json (formato legacy).
const SUC_A_CLAVE_S = { riv: 'SRiv', urq: 'SUrq', nacion: 'SNacion', chaca: 'SChaca',
  pergamino: 'SPergamino', sanpedro: 'SSanPedro', ramallo: 'SVRamallo' };

// μ diaria por (plu, clave S) desde a8020_calc.detalle → define qué producto "rota poco" en cada
// sucursal para la regla caro-y-lento del motor de distribución.
function muPorPluDesdeDetalle(detalle) {
  const out = {};
  for (const [plu, d] of Object.entries(detalle || {})) {
    const m = {};
    for (const [suc, s] of Object.entries(d)) {
      const sk = SUC_A_CLAVE_S[suc];
      if (sk) m[sk] = Number(s.mu) || 0;
    }
    out[plu] = m;
  }
  return out;
}

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
  // Regla caro-y-lento: μ real por sucursal + config del umbral y los pisos. Sin la clave de config
  // el motor no la aplica (paridad con el comportamiento histórico).
  const muPorPlu = muPorPluDesdeDetalle(a8020Calc.detalle || {});
  const sinEmpujeCaroLento = (distCfg.empujeDeposito || {}).sinEmpujeCaroLento || null;
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
  // Piso de reposición del producto nuevo: por defecto el de un clase B (min 4 / S 8).
  const pisosNuevo = { min: nuevoCfg.pisoMin != null ? nuevoCfg.pisoMin : 4,
                       S:   nuevoCfg.pisoS   != null ? nuevoCfg.pisoS   : 8 };
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
  // Producto nuevo = primera COMPRA dentro de nuevo.dias. Única definición del sistema: el A8020
  // marca su badge con el mismo criterio. Da el piso de reposición y el de importancia.
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
  const filas = calcularAlmacen(productos, a8020, listas, { corregirBugs: true, empujePresencia, empujePresenciaFactorS, presenciaPorClase, abcPorPlu, muPorPlu, sinEmpujeCaroLento, importancia: importanciaCfg, umbralMicroEnvio, pesosRacionado: distCfg.pesosRacionado, esNuevoSet, pisosNuevo, factGatePorPlu });
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
app.get('/docs/pesables-calculo.html', (_req, res) => res.sendFile(path.join(__dirname, 'docs', 'pesables-calculo.html')));
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
  const ocultosLista = aplicarOcultar ? ed.ocultarPesable : [];   // checkbox "Ocultar códigos" en Pesables
  const distLis = { noEnvasa: ed.noEnvasa, restringidos: ed.restringidos, importanciaMinorista: impViva };
  const rubroRows = await query(`SELECT CAST(p.IdProducto AS VARCHAR) AS IdProducto, r.NombreRubro
    FROM Productos p JOIN Rubros r ON r.IdRubro=p.IdRubro
    WHERE p.Activo=1 AND r.NombreRubro='Pesables Fraccionado'`);
  const rubroMapP = new Map(rubroRows.map(r => [r.IdProducto, r.NombreRubro]));
  const basePlus = rubroRows.map(r => r.IdProducto);
  const plus = universoPesables(basePlus, ed.siemprePesable, ed.noEnvasa, ocultosLista);
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
  const a8020CalcP = leerJSON(A8020_CALC_PATH, {}) || {};
  const abcPorPluP = a8020CalcP.abc || {};   // clase ABC por PLU (presencia escalada)
  // μ diaria TOTAL del PLU (suma de las 7 sucursales que reparten) → base de la cobertura de
  // depósito. Se restringe a esas claves: 'detalle' también trae logia/sucu11, inactivas en Siga.
  const SUC_MU = Object.keys(SUC_A_CLAVE_S);
  const muPorPluP = {};
  for (const [plu, d] of Object.entries(a8020CalcP.detalle || {}))
    muPorPluP[plu] = SUC_MU.reduce((s, k) => s + ((d[k] && Number(d[k].mu)) || 0), 0);
  const presPorPlu = {};
  for (const plu of plus) presPorPlu[String(plu)] = pesoPresentacionKg(nombreMap.get(String(plu)) || '', (formulas[String(plu)] || {}).cantFormula);
  const filas = calcularPesables(productos, a8020, pesLis, distLis,
    { corregirBugs: true, prioPesos: pesParams.prioPesos, granelCap: pesParams.granelCap,
      empujePresencia: empPes.presencia, empujePresenciaFactorS: empPes.presenciaFactorS,
      presenciaPorClase: empPes.presenciaPorClase, presenciaPorPresentacion: empPes.presenciaPorPresentacion, abcPorPlu: abcPorPluP, presPorPlu,
      coberturaDeposito: distCfgP.coberturaDepositoPesables, muPorPlu: muPorPluP });
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
      J: f.J, D: f.D, G: f.G, objDep: f.objDep, BL: f.BL, prioridad, prioridadSala,
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

// Set de IdProducto(String) marcados en SIGA como "Es de compras" y activos.
// El listado de compras solo muestra estos: lo que no se compra no se repone por orden de compra.
async function _productosDeCompra() {
  const rows = await query(`SELECT IdProducto FROM Productos WHERE EsDeCompras = 1 AND Activo = 1`).catch(() => null);
  if (!rows) return null; // sin acceso a SIGA no se filtra, para no vaciar el listado
  return new Set(rows.map(r => String(r.IdProducto)));
}

// Unifica productos rubro Almacen (calcularDistribucionAlmacen) + Pesables Fraccionado (calcularDistribucionPesables),
// enriquece con proveedor/costo/última compra y calcula las 3 señales de compra.
async function calcularListadoCompras() {
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  const pisoCfg = c.comprasPisoCentral || { tramos: [{ hastaS: null, pct: 0.25 }], pisoAbsoluto: 0 };
  const [almacen, pesables, provMap, compraSet] = await Promise.all([
    calcularDistribucionAlmacen(),
    calcularDistribucionPesables().catch(() => []),
    _provMapCompras(),
    _productosDeCompra(),
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

  // Importancia y consumo salen del caché de A8020: no se recalcula nada acá.
  // Si el caché no existe todavía, las columnas quedan en null y la UI muestra '·'.
  const a8020Cache = leerJSON(A8020_CALC_PATH, {}) || {};
  const rankingGeneral = a8020Cache.rankingGeneral || {};
  const consumoA8020 = a8020Cache.consumo || {};
  const ventanaMeses = a8020Cache.ventanaMeses || 12;
  const gruposGranel = comprasModulo.agruparPesablesPorGranel(pesables);

  const filaComun = (plu, nombre, tipo, central, stkSuc, pideTotal, enviarMicro, extra) => {
    const prov = provMap.get(String(plu)) || {};
    const sig = comprasModulo.sugeridoCompra({ pideTotal, central, enviarMicro, tramos: pisoCfg.tramos, pisoAbsoluto: pisoCfg.pisoAbsoluto });
    const consolidado = (central || 0) + Object.values(stkSuc || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    return {
      plu: String(plu), nombre, tipo, // 'almacen' | 'pesable'
      central: central || 0, stkSuc: stkSuc || {}, consolidado,
      importancia: rankingGeneral[String(plu)] ?? null,
      consumoMensual: comprasModulo.consumoPromedioMensual(consumoA8020, plu, ventanaMeses),
      deficitReposicion: sig.deficitReposicion, deficitMicro: sig.deficitMicro, faltanteReal: sig.faltanteReal, sugerido: sig.sugerido,
      proveedor: prov.proveedor || null, costo: prov.precio || null,
      ultimaCompraFecha: prov.ultimaFecha || prov.fecha || null, ultimaCompraCantidad: prov.ultimaCantidad || null,
      ...extra,
    };
  };

  const esDeCompra = plu => !compraSet || compraSet.has(String(plu));

  const rows = [];
  for (const f of almacen) {
    if (!esDeCompra(f.plu)) continue;
    const pideTotal = Object.values(f.ideal || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    rows.push(filaComun(f.plu, f.nombre, 'almacen', f.central, f.stkSuc, pideTotal, f.enviarMicro, {
      granelCentral: null, granelPlu: null, nombreGranel: '', fraccionado: null,
    }));
  }
  // Una fila por granel: es el producto que se compra. Las presentaciones viajan
  // en el detalle para poder auditar de dónde sale el pedido.
  for (const g of gruposGranel) {
    const pluGranel = String(g.granel);
    if (!esDeCompra(pluGranel)) continue;
    const central = granelMap.get(pluGranel) || 0;
    rows.push(filaComun(pluGranel, g.nombreGranel || pluGranel, 'pesable', central, {}, g.pideTotalGranel, {}, {
      granelCentral: central, granelPlu: g.granel, nombreGranel: g.nombreGranel || '',
      fraccionado: g.stockPresentacionesKg,
      presentaciones: g.presentaciones,
    }));
  }
  rows.sort((a, b) => b.sugerido - a.sugerido);
  return { productos: rows, fechaCalculo: new Date().toISOString(), total: rows.length };
}
app.get('/api/compras-modulo/listado', apiRoute(async () => calcularListadoCompras()));

// Qué códigos alimentan el consumo de un PLU y con qué multiplicador. Es la
// respuesta a "de dónde sale este número": sin esto el sugerido es una caja negra.
app.get('/api/compras-modulo/detalle-plu/:plu', apiRoute(async (req) => {
  const plu = String(req.params.plu || '').trim();
  const cache = leerJSON(A8020_CALC_PATH, {}) || {};
  const pesLis = leerJSON(PESABLES_LISTAS_PATH, {});
  const formulas = pesLis.formulas || {};
  // Candidatas a presentación: todo lo que pesables_listas mapea contra este granel.
  // Ese archivo es un mapeo histórico y no se depura, así que arrastra productos dados de
  // baja en SIGA (ej. 1389 "Pasa Uva Rubia 100G", Activo=0): se filtran más abajo.
  const candidatas = Object.entries(formulas)
    .filter(([, f]) => String(f.granel) === plu)
    .map(([pluFrac, f]) => ({
      plu: pluFrac,
      cantFormula: Number(f.cantFormula) > 0 ? Number(f.cantFormula) : 1,
      consumoMensual: comprasModulo.consumoPromedioMensual(cache.consumo || {}, pluFrac, cache.ventanaMeses || 12),
    }));
  // Otros productos (mixes, granolas, elaborados) que llevan este artículo en su fórmula
  // activa. Va aparte de `presentaciones`: eso es el mismo artículo en otro envase, esto es
  // consumo dentro de otro producto distinto.
  // Las presentaciones fraccionadas también son padres en ProductosComponentes, así que sin
  // este descarte cada 250G/500G/1Kg saldría listado dos veces, una en cada sección.
  const yaEsPresentacion = new Set(candidatas.map(p => String(p.plu)));
  const padres = (await productosQueUsanComponente(plu)).filter(p => !yaEsPresentacion.has(String(p.plu)));
  // Un solo viaje a SIGA para el artículo, sus candidatas a presentación y los padres:
  // resuelve los nombres que el caché de A8020 no tiene y el estado activo/inactivo.
  const infoSIGA = await datosProductosSIGA([plu, ...candidatas.map(p => p.plu), ...padres.map(p => p.plu)]);
  const usadoEn = padres.map(p => {
    const siga = infoSIGA.get(String(p.plu)) || {};
    return {
      ...p,
      nombre: p.nombre || siga.nombre || '',
      rubro: p.rubro || siga.rubro || '',
      consumoMensual: comprasModulo.consumoPromedioMensual(cache.consumo || {}, p.plu, cache.ventanaMeses || 12),
    };
  });
  // Criterio de filtrado: se descartan sólo las presentaciones que SIGA marca como INACTIVAS.
  // No se exige que la fórmula activa siga llevando el granel porque en SIGA los productos
  // discontinuados conservan la fórmula (1389 sigue apuntando a 7354 aunque esté de baja):
  // el único dato que distingue "presentación real" de "resto histórico" es Productos.Activo.
  // Si SIGA no devuelve la fila (o falla la consulta) se conserva la presentación, para no
  // ocultar información por un problema de conexión.
  const presentaciones = candidatas
    .filter(p => (infoSIGA.get(String(p.plu)) || {}).activo !== false)
    .map(p => {
      const siga = infoSIGA.get(String(p.plu)) || {};
      return {
        ...p,
        nombre: (cache.nombres || {})[p.plu] || siga.nombre || '',
        rubro: (cache.rubros || {})[p.plu] || siga.rubro || '',
      };
    });
  const infoPropia = infoSIGA.get(String(plu)) || {};
  return {
    plu,
    nombre: (cache.nombres || {})[plu] || infoPropia.nombre || '',
    rubro: (cache.rubros || {})[plu] || infoPropia.rubro || '',
    importancia: (cache.rankingGeneral || {})[plu] ?? null,
    abc: (cache.abc || {})[plu] || null,
    ventanaMeses: cache.ventanaMeses || 12,
    consumoPorSucursal: (cache.consumo || {})[plu] || {},
    consumoOrigen: (cache.consumoOrigen || {})[plu] || {},
    consumoMensual: comprasModulo.consumoPromedioMensual(cache.consumo || {}, plu, cache.ventanaMeses || 12),
    presentaciones,
    usadoEn,
  };
}));

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
    WHERE pv.NombreProveedor LIKE '%${like}%' AND pv.Activo = 1 AND p.Activo = 1 AND pp.UltimoPrecioCompra > 0
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

// Productos que el usuario sigue en la pestaña Producción del módulo Compras.
function leerTrackingProduccion() {
  const d = leerJSON(TRACKING_PRODUCCION_PATH, []);
  return Array.isArray(d) ? d.filter(x => x && x.plu).map(x => ({ plu: String(x.plu), nombre: String(x.nombre || x.plu) })) : [];
}

// Componentes de la fórmula ACTIVA (SIGA) de los productos en tracking, sumarizados:
// cada componente aparece una sola vez, con el consumo acumulado y los productos que lo usan.
async function calcularProduccionDeficit() {
  const tracking = leerTrackingProduccion();
  if (!tracking.length) return { productos: [], componentes: [], total: 0 };
  const inPadres = tracking.map(t => `'${t.plu.replace(/'/g, "''")}'`).join(',');
  const compRows = await query(`SELECT pc.IdProducto, pc.IdProductoComponente,
      CAST(pc.Cantidad AS FLOAT) AS Cantidad, p.NombreProducto
    FROM dbo.ProductosComponentes pc
    JOIN dbo.Productos p ON p.IdProducto = pc.IdProductoComponente
    WHERE pc.IdProducto IN (${inPadres}) AND ${FORMULA_ACTIVA_SQL} AND ${SIN_FORMULA_GENERICO_SQL}`);
  // Sin catch: si SIGA falla, el error tiene que verse en la pantalla y no confundirse
  // con "este producto no tiene componentes".

  const nombrePadre = new Map(tracking.map(t => [t.plu, t.nombre]));
  const consumoPorComp = new Map();   // plu -> { plu, nombre, consumo, usadoPor:Set }
  for (const r of compRows) {
    const plu = String(r.IdProductoComponente);
    if (!consumoPorComp.has(plu)) consumoPorComp.set(plu, { plu, nombre: r.NombreProducto || plu, consumo: 0, usadoPor: new Set() });
    const rec = consumoPorComp.get(plu);
    rec.consumo += Number(r.Cantidad) || 0;   // consumo por unidad producida, sumado entre los productos seguidos
    rec.usadoPor.add(nombrePadre.get(String(r.IdProducto)) || String(r.IdProducto));
  }
  const plus = [...consumoPorComp.keys()];
  if (!plus.length) return { productos: tracking, componentes: [], total: 0 };
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
  }).sort((a, b) => b.deficit - a.deficit || a.nombre.localeCompare(b.nombre));
  return { productos: tracking, componentes: comps, total: comps.length };
}
app.get('/api/compras-modulo/produccion-deficit', apiRoute(async () => calcularProduccionDeficit()));

// Buscador de productos con fórmula (los que se producen), para sumarlos al tracking.
app.get('/api/compras-modulo/productos-producibles', apiRoute(async (req) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return { productos: [] };
  const like = q.replace(/'/g, "''");
  // Se busca por nombre y por PLU: en pantalla el producto se identifica por su IdProducto,
  // así que tipear el código tiene que encontrarlo igual que tipear el nombre.
  const rows = await query(`SELECT TOP 50 p.IdProducto, p.NombreProducto
    FROM dbo.Productos p
    WHERE p.Activo = 1
      AND (p.NombreProducto LIKE '%${like}%' OR CAST(p.IdProducto AS varchar(50)) LIKE '${like}%')
      AND EXISTS (SELECT 1 FROM dbo.ProductosComponentes pc WHERE pc.IdProducto = p.IdProducto)
    ORDER BY CASE WHEN CAST(p.IdProducto AS varchar(50)) = '${like}' THEN 0 ELSE 1 END, p.NombreProducto`);
  return { productos: rows.map(r => ({ plu: String(r.IdProducto), nombre: r.NombreProducto })) };
}));

app.post('/api/compras-modulo/tracking-produccion', (req, res) => {
  const b = req.body || {};
  const plu = String(b.plu || '').trim();
  if (!plu) return res.status(400).json({ error: 'plu requerido' });
  const actual = leerTrackingProduccion();
  if (actual.some(t => t.plu === plu)) return res.json({ ok: true, productos: actual });
  const productos = [...actual, { plu, nombre: String(b.nombre || plu).trim() }];
  guardarJSON(TRACKING_PRODUCCION_PATH, productos);
  res.json({ ok: true, productos });
});

app.delete('/api/compras-modulo/tracking-produccion/:plu', (req, res) => {
  const plu = String(req.params.plu);
  const productos = leerTrackingProduccion().filter(t => t.plu !== plu);
  guardarJSON(TRACKING_PRODUCCION_PATH, productos);
  res.json({ ok: true, productos });
});

// ?estado=ENVIADA filtra; sin query devuelve todas, de la más nueva a la más vieja.
// El sort va sobre una copia: el array que devuelve leerJSON no se reordena in place.
app.get('/api/compras-modulo/ordenes', apiRoute(async (req) => {
  const estado = String((req.query && req.query.estado) || '').trim().toUpperCase();
  const arr = leerJSON(ORDENES_COMPRA_PATH, []);
  const filtradas = estado ? arr.filter(o => o.estado === estado) : arr;
  return [...filtradas].sort((a, b) => (b.id || 0) - (a.id || 0));
}));
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

// Cambio de estado con validación de la máquina de estados. La UI esconde los botones
// que no corresponden, pero la regla se aplica acá: un salto inválido es 400.
app.put('/api/compras-modulo/ordenes/:id/estado', (req, res) => {
  const id = Number(req.params.id);
  const nuevoEstado = String((req.body && req.body.estado) || '').trim().toUpperCase();
  if (!comprasModulo.ESTADOS_ORDEN.includes(nuevoEstado)) {
    return res.status(400).json({ error: `Estado inválido: ${nuevoEstado}` });
  }
  const arr = leerJSON(ORDENES_COMPRA_PATH, []);
  const i = arr.findIndex(o => Number(o.id) === id);
  if (i < 0) return res.status(404).json({ error: 'Orden no encontrada' });
  const ahora = new Date();
  try {
    // El módulo es puro: el reloj, el usuario y los lead times se inyectan desde acá.
    const actualizada = comprasModulo.aplicarTransicion(arr[i], nuevoEstado, {
      ts: ahora.toISOString(),
      fechaISO: ahora.toISOString().slice(0, 10),
      usuario: (req.session && req.session.user && req.session.user.usuario) || null,
      nota: req.body && req.body.nota,
      leadTimes: leerJSON(LEAD_TIMES_PATH, {}),
    });
    // Copia del array y reemplazo del índice: no se muta lo leído del disco.
    const copia = [...arr];
    copia[i] = actualizada;
    guardarJSON(ORDENES_COMPRA_PATH, copia);
    res.json({ ok: true, orden: actualizada });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Lo pedido y no recibido, por PLU. Lo consume la predicción de compra.
app.get('/api/compras-modulo/ordenes/pendiente-plu', apiRoute(async () =>
  comprasModulo.pendientePorPlu(leerJSON(ORDENES_COMPRA_PATH, []))));

// ── A8020 autónomo: puntos de pedido order-up-to calculados desde Siga ──────────
// Spec: docs/superpowers/specs/2026-06-10-a8020-orderupto-design.md
const DISTRIB_CONFIG_PATH = path.join(DATA_DIR, 'distribucion_config.json');
const DISTRIB_OVERRIDES_PATH = path.join(DATA_DIR, 'distribucion_overrides.json');
const A8020_CALC_PATH = path.join(DATA_DIR, 'a8020_calc.json');
// Ajustes manuales de S/min por (plu, sucursal). Persisten al recalcular: el cálculo
// escribe lo suyo en detalle[plu][suc].S/.min y estos valores pisan mins/sLevels.
const A8020_MANUAL_PATH = path.join(DATA_DIR, 'a8020_manual.json');

// Escribe data/a8020.json en formato legacy (pesables.js / almacen.js / distribucion.js) desde el caché.
//   minX = punto de pedido (gatillo) · SX = order-up-to (objetivo al que se repone).
const LEGACY_KEY = { riv:'minRiv', urq:'minUrq', nacion:'minNacion', chaca:'minChaca',
  pergamino:'minPergamino', sanpedro:'minSanPedro', logia:'minLogia',
  ramallo:'minVRamallo', sucu11:'minVConst' };
const LEGACY_KEY_S = { riv:'SRiv', urq:'SUrq', nacion:'SNacion', chaca:'SChaca',
  pergamino:'SPergamino', sanpedro:'SSanPedro', logia:'SLogia',
  ramallo:'SVRamallo', sucu11:'SVConst' };
// Ranking por sucursal (percentil 0-1 de importancia del PLU dentro de esa sucursal) → distribucion.js
// lo usa para ponderar la importancia del envío por sucursal en vez del BB global plano.
const LEGACY_KEY_RANK = { riv:'rankRiv', urq:'rankUrq', nacion:'rankNacion', chaca:'rankChaca',
  pergamino:'rankPergamino', sanpedro:'rankSanPedro', ramallo:'rankVRamallo' };
function escribirA8020Legacy(cache) {
  const a8020Legacy = {};
  for (const [plu, sucData] of Object.entries(cache.mins || {})) {
    a8020Legacy[plu] = {};
    for (const [sucKey, m] of Object.entries(sucData)) {
      const lk = LEGACY_KEY[sucKey]; if (lk) a8020Legacy[plu][lk] = m;
      const sk = LEGACY_KEY_S[sucKey]; const sv = ((cache.sLevels || {})[plu] || {})[sucKey];
      if (sk && sv != null) a8020Legacy[plu][sk] = sv;
    }
  }
  for (const [plu, cls] of Object.entries(cache.abc || {})) {
    if (cls === 'F') (a8020Legacy[plu] = a8020Legacy[plu] || {}).claseF = true;
  }
  // Cachés previos a los ajustes manuales no traen rankingPorSucursal: se reconstruye desde detalle
  // para no borrar los rankXxx del legacy al fijar un valor sin recalcular desde Siga.
  let rankSuc = cache.rankingPorSucursal;
  if (!rankSuc) {
    rankSuc = {};
    for (const [plu, porSuc] of Object.entries(cache.detalle || {})) {
      for (const [suc, d] of Object.entries(porSuc)) {
        if (d.ranking != null) (rankSuc[suc] = rankSuc[suc] || {})[plu] = d.ranking;
      }
    }
  }
  for (const [sucKey, porPlu] of Object.entries(rankSuc)) {
    const rk = LEGACY_KEY_RANK[sucKey]; if (!rk) continue;
    for (const [plu, score] of Object.entries(porPlu)) {
      (a8020Legacy[plu] = a8020Legacy[plu] || {})[rk] = score;
    }
  }
  // Ranking general (mismo 0-1, todo el catálogo) → fallback en distribucion.js cuando el PLU no tiene
  // rank en NINGUNA sucursal. Reemplaza el fallback a BB crudo (facturación en miles/millones) que
  // mezclaba escalas con los rankXxx (0-1) y disparaba la importancia de esos PLUs muy por encima del resto.
  for (const [plu, score] of Object.entries(cache.rankingGeneral || {})) {
    (a8020Legacy[plu] = a8020Legacy[plu] || {}).rankGeneral = score;
  }
  guardarJSON(A8020_PATH, a8020Legacy);
  return a8020Legacy;
}
// Reaplica los ajustes manuales sobre el caché ya calculado y reescribe el legacy.
// Evita tener que recalcular desde Siga (que tarda minutos) al fijar/quitar un valor.
function reaplicarManualA8020() {
  const cache = leerJSON(A8020_CALC_PATH, null);
  if (!cache || cache.vacio || !cache.detalle) return null;
  // Sin pesablesSet en vivo (esto a propósito no consulta Siga): aplicarManualA8020 cae al
  // cache.pesables que dejó el último recálculo y, si tampoco está, al rubro del caché.
  // En los dos casos almacén queda en enteros.
  aplicarManualA8020(cache, leerJSON(A8020_MANUAL_PATH, {}));
  guardarJSON(A8020_CALC_PATH, cache);
  escribirA8020Legacy(cache);
  return cache;
}
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
// Consumo real por (sucursal, producto): la imputación vive en a8020.js (pura y testeable);
// acá sólo se resuelven las fórmulas activas de los bultos con venta, que salen de Siga.
async function consumoRealA8020(statRows, sucById, rubroDePlu, formulasPesables) {
  const norm = (v) => String(v == null ? '' : v).trim();
  const bultos = [...new Set(statRows.filter(r => rubroDePlu[norm(r.plu)] === RUBRO_ALMACEN_BULTO).map(r => norm(r.plu)))];
  let compsPorBulto = new Map();
  if (bultos.length) {
    try { compsPorBulto = await componentesFormulaPorPadre(bultos); }
    catch (e) { console.error('[a8020/consumo] fórmulas de bultos:', e.message); }
  }
  return calcularConsumoReal(statRows, sucById, rubroDePlu, formulasPesables, compsPorBulto);
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
    const S = TL <= 0 ? 0 : roundDec(Math.min(Math.max((mu * TL + zc * sigma * Math.sqrt(TL)) * mult, 0), techo), dec);
    const min = S <= 0 ? 0 : roundDec(Math.min(Math.max(S * k, piso), S), dec);
    // El redondeo (S=1 → min=round(0.5)=1) y el pisoManual pueden dejar min == S: sin brecha el
    // envío teórico es 0 y la sucursal gatilla sin reponer nada. asegurarBrechaMinS sube S.
    return asegurarBrechaMinS(min, S, dec);
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

  // ── Clasificación: Nuevo y F ──────────────────────────────────────────────────
  //   Nuevo → primera COMPRA dentro de nuevo.dias. Única definición de "producto nuevo" en todo el
  //           sistema: la misma que usa distribución para el piso de reposición y de importancia.
  //   F     → cero ventas + movimientos no-compra anteriores al umbral de meses → stock muerto
  //           (min/S=0, sin empuje). Ser Nuevo gana sobre F.
  const salesSet = new Set(statRows.map(r => String(r.plu)));
  const compraTipos = config.tiposMovimientoCompra || ['COMPRA', 'COMPRA-NC'];
  const umbralNuevo = config.antiguedadMesesNuevo ?? 3;
  const nuevoDias = (config.nuevo || {}).dias || 30;
  const compraInNuevos = compraTipos.map(t => `'${t}'`).join(',') || `''`;
  // HAVING sobre la primera compra: devuelve sólo los recién incorporados, no todo el catálogo.
  const nuevosSet = new Set();
  {
    const rows = await query(`SELECT mp.IdProducto
      FROM MovimientosStockProductos mp
      INNER JOIN MovimientosStock m ON m.IdSucursal=mp.IdSucursal AND m.IdTipoMovimiento=mp.IdTipoMovimiento AND m.NumeroMovimiento=mp.NumeroMovimiento
      WHERE mp.IdTipoMovimiento IN (${compraInNuevos})
      GROUP BY mp.IdProducto
      HAVING MIN(m.FechaMovimiento) >= DATEADD(DAY, -${nuevoDias}, CAST(GETDATE() AS DATE))`);
    for (const r of rows) nuevosSet.add(String(r.IdProducto));
  }
  const candNoVenta = [...bootstrapSet].map(String).filter(p => !salesSet.has(p) && !nuevosSet.has(p));
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
  const nuevos = [], viejos = [];
  for (const plu of nuevosSet) {
    if (!mins[plu]) continue;   // sin niveles calculados no aparece en la tabla
    nuevos.push(Number(plu));
    for (const sk of Object.keys(detalle[plu] || {})) detalle[plu][sk].nuevo = true;
  }
  for (const plu of candNoVenta) {
    if (!esViejo.has(plu)) continue;
    viejos.push(Number(plu)); abc[plu] = 'F';   // escribirA8020Legacy deriva claseF de abc
    if (mins[plu]) for (const sk of Object.keys(mins[plu])) mins[plu][sk] = 0;
    if (sLevels[plu]) for (const sk of Object.keys(sLevels[plu])) sLevels[plu][sk] = 0;
    if (detalle[plu]) for (const sk of Object.keys(detalle[plu])) { detalle[plu][sk].S = 0; detalle[plu][sk].min = 0; detalle[plu][sk].viejo = true; }
    bootstrapped.delete(plu);
  }

  // Consumo real (informativo): rastrea la venta hasta el producto que sale del stock —
  // bultos → componentes de la fórmula, fraccionado → kg del granel.
  const { consumo, consumoOrigen } = await consumoRealA8020(statRows, sucById, rubroDePlu, pesLis.formulas || {});
  // Un granel puede recibir consumo sin tener niveles propios (no se vende suelto en ninguna
  // sucursal): igual entra en `plus` para que la tabla le arme la fila y muestre su nombre.
  const plus = [...new Set([...Object.keys(mins), ...Object.keys(consumo)])];
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
    // Qué PLUs admiten decimales, para que reaplicarManualA8020 pueda redondear sin volver a Siga.
    pesables: [...pesablesSet],
    consumo, consumoOrigen,
    rankingGeneral, rankingPorSucursal: ranking };
  // Ajustes manuales: se aplican SIEMPRE al final, así el recálculo nunca los pisa. El
  // pesablesSet en vivo garantiza el redondeo: almacén entero, pesables con un decimal.
  aplicarManualA8020(cache, leerJSON(A8020_MANUAL_PATH, {}), pesablesSet);
  guardarJSON(A8020_CALC_PATH, cache);
  escribirA8020Legacy(cache);

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

// ── Serie mensual de consumo (predicción de compra) ────────────────────────────
// Ventas por (mes, sucursal, producto). Mismos filtros que el resto del sistema:
// sin comprobantes anulados y sin clientes categoría SUCURSAL (transferencias internas).
function sqlVentasMensuales(idList, meses) {
  return `SELECT CONVERT(varchar(7), v.Fecha, 126) AS Mes, v.IdSucursal, vp.IdProducto,
      SUM(vp.Cantidad) AS Cant
    FROM VentasProductos vp ${_ventasJoin}
    WHERE ${_ventasWhere(idList, meses)}
    GROUP BY CONVERT(varchar(7), v.Fecha, 126), v.IdSucursal, vp.IdProducto`;
}

// Consumo de componentes por producción, por mes. En el movimiento de producción el
// consumo se registra NEGATIVO y el alta de terminados POSITIVO (ver
// lineasProduccionDesdeConciliacion): por eso sólo cuentan las líneas negativas.
// Salvedad conocida: el sobrante devuelto al depósito de diferencias también es
// positivo y no se descuenta, así que el consumo por producción queda apenas
// sobreestimado cuando hubo devolución.
// tipoMovimiento acepta uno o varios tipos: la producción se registró históricamente como
// BIENESUSO y desde el cambio de tipos va como REC-SUC, así que la ventana de 24 meses tiene
// que mirar los dos o el histórico desaparece de la serie.
function sqlProduccionMensual(tipoMovimiento, meses) {
  const tipos = (Array.isArray(tipoMovimiento) ? tipoMovimiento : [tipoMovimiento])
    .map(t => String(t || '').trim())
    .filter(Boolean)
    .map(t => `'${t.replace(/'/g, "''")}'`);
  if (!tipos.length) throw new Error('sqlProduccionMensual requiere al menos un tipo de movimiento');
  return `SELECT CONVERT(varchar(7), m.FechaMovimiento, 126) AS Mes, mp.IdProducto,
      SUM(CASE WHEN mp.Cantidad < 0 THEN -mp.Cantidad ELSE 0 END) AS Cant
    FROM MovimientosStockProductos mp
    INNER JOIN MovimientosStock m ON m.IdSucursal=mp.IdSucursal
      AND m.IdTipoMovimiento=mp.IdTipoMovimiento AND m.NumeroMovimiento=mp.NumeroMovimiento
    WHERE mp.IdTipoMovimiento IN (${tipos.join(', ')})
      AND m.FechaMovimiento >= DATEADD(MONTH,-${meses},CAST(GETDATE() AS DATE))
      AND m.FechaMovimiento < CAST(GETDATE() AS DATE)
    GROUP BY CONVERT(varchar(7), m.FechaMovimiento, 126), mp.IdProducto`;
}

// Serie mensual imputada al producto que realmente sale del stock. Reusa la misma
// imputación que A8020 (bulto → componentes, fraccionado → granel), aplicada mes a mes.
async function recalcularConsumoMensual() {
  const config = leerJSON(DISTRIB_CONFIG_PATH, {});
  const pesLis = leerJSON(PESABLES_LISTAS_PATH, {});
  const sucs = config.sucursales || {};
  const idList = Object.values(sucs).map(s => s.idSucursal).join(',');
  if (!idList) throw new Error('Falta data/distribucion_config.json (sucursales).');
  const meses = 24;
  const sucById = {};
  for (const [key, c] of Object.entries(sucs)) sucById[c.idSucursal] = key;

  const rubroRows = await query(`SELECT CAST(p.IdProducto AS VARCHAR) AS IdProducto, r.NombreRubro
    FROM Productos p LEFT JOIN Rubros r ON r.IdRubro=p.IdRubro`);
  const rubroDePlu = {};
  for (const r of rubroRows) rubroDePlu[String(r.IdProducto).trim()] = r.NombreRubro || null;

  const tipoProd  = (leerJSON(path.join(__dirname, 'config.json'), {}).produccion || {}).idTipoMovimiento || 'BIENESUSO';
  // BIENESUSO siempre se incluye: es el tipo con el que se registró la producción hasta el
  // cambio a REC-SUC y sigue siendo el único dato de los meses anteriores.
  const tiposProd = [...new Set([tipoProd, 'BIENESUSO'])];
  const [ventasRows, prodRows] = await Promise.all([
    query(sqlVentasMensuales(idList, meses)),
    query(sqlProduccionMensual(tiposProd, meses)).catch((e) => {
      console.error('[consumo-mensual] producción:', e.message);
      return [];
    }),
  ]);

  // Ventas: se imputan mes a mes con la misma regla que A8020.
  const porMes = {};            // mes → statRows para calcularConsumoReal
  const ventasPorSucursal = {}; // plu → mes → suc → cantidad (crudo, sin imputar)
  for (const r of ventasRows) {
    const mes = String(r.Mes);
    (porMes[mes] = porMes[mes] || []).push({ idSucursal: r.IdSucursal, plu: r.IdProducto, sumQ: Number(r.Cant) || 0 });
    const plu = String(r.IdProducto).trim();
    const suc = sucById[r.IdSucursal];
    if (!suc) continue;
    const porPlu = ventasPorSucursal[plu] = ventasPorSucursal[plu] || {};
    (porPlu[mes] = porPlu[mes] || {})[suc] = Number(r.Cant) || 0;
  }

  // Fórmulas de los bultos con venta en cualquier mes: una sola consulta para todos.
  const bultos = [...new Set(ventasRows
    .filter(r => rubroDePlu[String(r.IdProducto).trim()] === RUBRO_ALMACEN_BULTO)
    .map(r => String(r.IdProducto).trim()))];
  let compsPorBulto = new Map();
  if (bultos.length) {
    try { compsPorBulto = await componentesFormulaPorPadre(bultos); }
    catch (e) { console.error('[consumo-mensual] fórmulas de bultos:', e.message); }
  }

  const consumoMensual = {};
  const anotar = (plu, mes, campo, cantidad) => {
    if (!(cantidad > 0)) return;
    const p = String(plu).trim();
    const porPlu = consumoMensual[p] = consumoMensual[p] || {};
    const celda = porPlu[mes] = porPlu[mes] || { ventas: 0, produccion: 0, total: 0 };
    celda[campo] = Math.round((celda[campo] + cantidad) * 100) / 100;
    celda.total = Math.round((celda.ventas + celda.produccion) * 100) / 100;
  };
  for (const [mes, filas] of Object.entries(porMes)) {
    const { consumo } = calcularConsumoReal(filas, sucById, rubroDePlu, pesLis.formulas || {}, compsPorBulto);
    for (const [plu, porSuc] of Object.entries(consumo)) {
      anotar(plu, mes, 'ventas', Object.values(porSuc).reduce((s, v) => s + (Number(v) || 0), 0));
    }
  }
  for (const r of prodRows) anotar(r.IdProducto, String(r.Mes), 'produccion', Number(r.Cant) || 0);

  const cache = { timestamp: new Date().toISOString(), ventanaMeses: meses,
    tipoMovimientoProduccion: tipoProd, consumoMensual, ventasPorSucursal };
  guardarJSON(CONSUMO_MENSUAL_PATH, cache);
  return { timestamp: cache.timestamp, ventanaMeses: meses,
    productos: Object.keys(consumoMensual).length,
    mesesConDatos: [...new Set(Object.values(consumoMensual).flatMap(p => Object.keys(p)))].sort() };
}

app.get('/api/compras-modulo/consumo-mensual/recalcular', apiRoute(async () => recalcularConsumoMensual()));
app.get('/api/compras-modulo/consumo-mensual', apiRoute(async () => leerJSON(CONSUMO_MENSUAL_PATH, { vacio: true })));

// Recomendación de compra a un horizonte elegible. Cruza la serie mensual con el
// stock del listado y lo pendiente de recibir de las órdenes abiertas.
app.get('/api/compras-modulo/prediccion', apiRoute(async (req) => {
  const dias = Math.max(1, Math.min(Number(req.query.dias) || 30, 365));
  const serie = leerJSON(CONSUMO_MENSUAL_PATH, null);
  if (!serie || serie.vacio || !serie.consumoMensual) {
    return { vacio: true, mensaje: 'Sin serie mensual. Recalculá el consumo mensual primero.', dias };
  }
  const listado = await calcularListadoCompras();
  const pendiente = comprasModulo.pendientePorPlu(leerJSON(ORDENES_COMPRA_PATH, []));
  const leadTimes = leerJSON(LEAD_TIMES_PATH, {});
  const zPorClase = leerJSON(DISTRIB_CONFIG_PATH, {}).servicio || { A: 2.05, B: 1.645, C: 1.28 };
  const abcPorPlu = (leerJSON(A8020_CALC_PATH, {}) || {}).abc || {};
  const mesActual = new Date().toISOString().slice(0, 7);

  const productos = (listado.productos || []).map(p => {
    // La serie guarda { ventas, produccion, total }: la proyección usa el total.
    const porMes = serie.consumoMensual[String(p.plu)] || {};
    const totales = {};
    for (const [mes, v] of Object.entries(porMes)) totales[mes] = Number(v.total) || 0;
    const clase = abcPorPlu[String(p.plu)] || 'C';
    const z = zPorClase[clase] != null ? zPorClase[clase] : zPorClase.C;
    const leadTimeDias = comprasModulo.leadTimeDeProveedor(leadTimes, p.proveedor);
    const pr = prediccionConsumo.proyectar(totales, { mesActual, dias, z });
    const stock = (Number(p.central) || 0)
      + Object.values(p.stkSuc || {}).reduce((s, v) => s + (Number(v) || 0), 0)
      + (Number(p.fraccionado) || 0);
    const pend = Number(pendiente[String(p.plu)]) || 0;
    const rec = prediccionConsumo.recomendar({
      proyeccion: pr.proyeccion, seguridad: pr.seguridad, stock, pendiente: pend,
      muDiario: pr.muDiario, leadTimeDias,
    });
    return { ...p, ...pr, stock, pendiente: pend, leadTimeDias, abc: clase,
      necesidad: rec.necesidad, estado: rec.estado };
  });
  const orden = { CRITICO: 0, COMPRAR: 1, OK: 2, EXCESO: 3 };
  productos.sort((a, b) => (orden[a.estado] - orden[b.estado]) || (b.necesidad - a.necesidad));
  return { dias, mesActual, timestampSerie: serie.timestamp, total: productos.length, productos };
}));

// ── Ajustes manuales de S/min por (plu, sucursal) ──────────────────────────────
const MANUAL_MAX = 100000;
function validarValorManual(v, campo) {
  if (v === '' || v == null) return null;            // null = sin fijar (usa el calculado)
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > MANUAL_MAX) throw new Error(`Valor inválido para ${campo}`);
  return roundDec(n, 2);
}
// Lista los ajustes con su valor calculado al lado, para la vista rápida de la UI.
app.get('/api/distribucion/a8020/manual', (_req, res) => {
  const manual = leerJSON(A8020_MANUAL_PATH, {});
  const cache = leerJSON(A8020_CALC_PATH, {}) || {};
  const items = [];
  for (const [plu, porSuc] of Object.entries(manual)) {
    for (const [sucursal, m] of Object.entries(porSuc)) {
      const d = ((cache.detalle || {})[plu] || {})[sucursal] || {};
      items.push({ plu: Number(plu), sucursal, S: m.S ?? null, min: m.min ?? null,
        nota: m.nota || '', ts: m.ts || null, usuario: m.usuario || null,
        nombre: (cache.nombres || {})[plu] || '', calcS: d.S ?? null, calcMin: d.min ?? null });
    }
  }
  items.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || '') || a.sucursal.localeCompare(b.sucursal));
  res.json({ items });
});
app.post('/api/distribucion/a8020/manual', (req, res) => {
  try {
    const body = req.body || {};
    const plu = String(body.plu || '').trim();
    const sucursal = String(body.sucursal || '').trim();
    if (!plu) throw new Error('Falta plu');
    const sucs = (leerJSON(DISTRIB_CONFIG_PATH, {}).sucursales) || {};
    if (!sucs[sucursal]) throw new Error(`Sucursal desconocida: ${sucursal}`);
    const S = validarValorManual(body.S, 'S');
    const min = validarValorManual(body.min, 'min');
    if (S == null && min == null) throw new Error('Indicá al menos S o min');
    // S tiene que quedar SIEMPRE por encima del min: con S == min el envío teórico es 0.
    if (S != null && min != null && min >= S) throw new Error('El S tiene que ser mayor que el min');
    // Fijar uno solo también puede empatar contra el calculado del otro nivel.
    if (S == null || min == null) {
      const d = ((leerJSON(A8020_CALC_PATH, {}).detalle || {})[plu] || {})[sucursal] || {};
      const minEf = min != null ? min : d.min, sEf = S != null ? S : d.S;
      if (minEf != null && sEf != null && minEf >= sEf) {
        throw new Error(`El S tiene que ser mayor que el min (quedaría min=${minEf} y S=${sEf})`);
      }
    }
    const manual = leerJSON(A8020_MANUAL_PATH, {});
    const prev = (manual[plu] || {})[sucursal] || {};
    const entry = { ts: new Date().toISOString() };
    if (S != null) entry.S = S;
    if (min != null) entry.min = min;
    if (body.nota != null) entry.nota = String(body.nota).slice(0, 200);
    else if (prev.nota) entry.nota = prev.nota;
    const usuario = req.session && req.session.user && req.session.user.usuario;
    if (usuario) entry.usuario = usuario;
    manual[plu] = { ...(manual[plu] || {}), [sucursal]: entry };
    guardarJSON(A8020_MANUAL_PATH, manual);
    reaplicarManualA8020();
    res.json({ ok: true, plu: Number(plu), sucursal, ...entry });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/distribucion/a8020/manual/:plu/:sucursal', (req, res) => {
  try {
    const { plu, sucursal } = req.params;
    const manual = leerJSON(A8020_MANUAL_PATH, {});
    if (manual[plu]) {
      const { [sucursal]: _quitado, ...resto } = manual[plu];
      if (Object.keys(resto).length) manual[plu] = resto; else delete manual[plu];
      guardarJSON(A8020_MANUAL_PATH, manual);
      reaplicarManualA8020();
    }
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
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
    // Sólo la fórmula vigente: sin este filtro entraban los componentes de todas las
    // fórmulas del producto y el MAX() se quedaba con la cantidad más grande entre ellas,
    // así que la carga de producción y la distribución consumían insumos de fórmulas viejas.
    // El componente se aliasa `p` porque es lo que espera SIN_FORMULA_GENERICO_SQL.
    const rows = await query(`
      SELECT pc.IdProductoComponente AS plu, p.NombreProducto AS nombre,
             CAST(MAX(pc.Cantidad) AS FLOAT) AS cantidad
      FROM ProductosComponentes pc
      INNER JOIN Productos p ON p.IdProducto = pc.IdProductoComponente
      WHERE pc.IdProducto = ${plu} AND ${FORMULA_ACTIVA_SQL} AND ${SIN_FORMULA_GENERICO_SQL}
      GROUP BY pc.IdProductoComponente, p.NombreProducto`);
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
app.get('/api/produccion/registros', apiRoute(async () => leerJSON(PROD_REG_PATH, [])));
// Historial: registros ya conciliados/archivados (fuera de Terminados). Filtro opcional por fecha.
app.get('/api/produccion/historial', apiRoute(async req => {
  const fecha = req.query.fecha ? safeDate(req.query.fecha) : null;
  const hist = leerJSON(PROD_HIST_PATH, []);
  return fecha ? hist.filter(r => r && r.fecha === fecha) : hist;
}));
// Presentación deducida del nombre del producto ("MIEL APIDELTA 500G" → "500g"), o '' si el
// nombre no la trae. La carga manual no viene de una orden planificada, así que no tiene
// presentación cargada: sin esto la columna quedaba vacía en Terminados y en el historial.
function presentacionDeNombre(nombre) {
  const m = String(nombre || '').match(/(\d+(?:[.,]\d+)?)\s*(kg|g|ml|lt|l|cc)\b/i);
  return m ? m[1].replace(',', '.') + m[2].toLowerCase() : '';
}

app.post('/api/produccion/registros', (req, res) => {
  const b = req.body || {};
  if (b.plu == null || b.cantFraccionada == null) return res.status(400).json({ error: 'faltan campos' });
  const arr = leerJSON(PROD_REG_PATH, []);
  const presentacion = String(b.presentacion || '').trim() || presentacionDeNombre(b.nombre || b.producto);
  // Date.now() solo repetía id si entraban dos registros en el mismo ms (varias presentaciones
  // de una misma orden): con id repetido, borrar uno borraba los dos.
  let id = Date.now();
  while (arr.some(x => x && x.id === id)) id++;
  arr.push({ ...b, presentacion, id });
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
    sucursalesSiga(),
  ]);
  const nomMap = new Map(nombres.map(r => [String(r.IdProducto), r.NombreProducto]));
  const sucursales = sucs.map(sucursalPublica);
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
           p.NombreProducto        AS nombre,
           pc.Cantidad             AS cantPorUnidad
    FROM ProductosComponentes pc
    INNER JOIN Productos p ON p.IdProducto = pc.IdProductoComponente
    WHERE pc.IdProducto = ${plu} AND ${FORMULA_ACTIVA_SQL} AND ${SIN_FORMULA_GENERICO_SQL}
    ORDER BY p.NombreProducto`);
}));
app.get('/api/plan/sugerencias',        apiRoute(async req => calcularSugerencias(req.query)));
app.get('/api/plan/sugerencias-grupos', apiRoute(async req => calcularSugerenciasCatalogo(req.query)));
app.get('/api/plan/packaging', apiRoute(async req => {
  const plus = String(req.query.plus || '').split(',').map(s => s.replace(/\D/g, '')).filter(Boolean);
  if (!plus.length) return {};
  const rows = await query(`
    SELECT pc.IdProducto AS padre, pc.IdProductoComponente AS codigo,
           p.NombreProducto AS nombre, COALESCE(r.NombreRubro,'') AS rubro
    FROM ProductosComponentes pc
    INNER JOIN Productos p ON p.IdProducto = pc.IdProductoComponente
    LEFT  JOIN Rubros    r ON r.IdRubro   = p.IdRubro
    WHERE pc.IdProducto IN (${plus.join(',')}) AND ${FORMULA_ACTIVA_SQL} AND ${SIN_FORMULA_GENERICO_SQL}
    ORDER BY p.NombreProducto`);
  const out = {};
  for (const plu of plus) out[plu] = { envase: null, tapa: null };
  for (const r of rows) {
    const padre = String(r.padre);
    const t     = tiposPackaging(r.nombre, r.rubro);
    if (!out[padre]) out[padre] = { envase: null, tapa: null };
    const item = { codigo: String(r.codigo), nombre: String(r.nombre || '') };
    // Se queda con el primer componente que matchea de cada tipo y descarta los siguientes.
    // El else-if importa: un componente que matchea tapa pero llega con la tapa ya ocupada
    // cae a envase si también matchea esa regla (caso "Envase 1kg" con rubro "TAPAS").
    if      (!out[padre].tapa   && t.esTapa)   out[padre].tapa   = item;
    else if (!out[padre].envase && t.esEnvase) out[padre].envase = item;
  }
  return out;
}));
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
app.get('/api/tapas-registro', (_req, res) => res.json(leerJSON(TAPAS_REG_PATH, [])));
app.post('/api/tapas-registro', apiRoute(async req => {
  const codigo = ((req.body && req.body.codigo) || '').toString().trim();
  if (!codigo) return { error: 'Falta código' };
  const e = await envaseLookup(codigo);
  if (!e) return { error: 'Producto no encontrado en Siga' };
  const arr = leerJSON(TAPAS_REG_PATH, []);
  const i = arr.findIndex(x => String(x.codigo) === String(e.codigo));
  if (i >= 0) arr[i] = e; else arr.push(e);
  guardarJSON(TAPAS_REG_PATH, arr);
  return { ok: true, tapa: e };
}));
app.post('/api/tapas-registro/refrescar', apiRoute(async () => {
  const arr = leerJSON(TAPAS_REG_PATH, []);
  for (const x of arr) { const e = await envaseLookup(x.codigo); if (e) { x.nombre = e.nombre; x.stock = e.stock; } }
  guardarJSON(TAPAS_REG_PATH, arr);
  return { ok: true, tapas: arr };
}));
app.delete('/api/tapas-registro/:codigo', (req, res) => {
  const cod = String(req.params.codigo);
  guardarJSON(TAPAS_REG_PATH, leerJSON(TAPAS_REG_PATH, []).filter(x => String(x.codigo) !== cod));
  res.json({ ok: true });
});
app.get('/api/tapa-lookup', apiRoute(async req => {
  const codigo = (req.query.codigo || '').trim();
  if (!codigo) return { error: 'Falta código' };
  return (await envaseLookup(codigo)) || { error: 'Producto no encontrado' };
}));
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
// Con saneo de sellos: la UI dibuja el candado y deshabilita el ✕ mirando reservaMovimiento,
// así que tiene que ver lo mismo que las guardas de PUT y DELETE.
app.get('/api/plan/:fecha', (req, res) => { const fecha = safeDate(req.params.fecha); const { plan } = leerPlanReservas(fecha); res.json(plan || { fecha, notas: '', items: [] }); });

// ── Productividad de la sala ───────────────────────────────────────────────────
// Resúmenes exportados por el sistema viejo de sala, previos a los registros en JSON.
const RESUMENES_DIR = path.join(DATA_DIR, 'resumenes');
// Sólo lectura: junta lo que ya existe (plan, órdenes y cargas) y delega el cálculo en
// Familia de cada carga. Mandan las familias manuales (las arma el usuario por código en
// el módulo de análisis); lo que no está en ninguna cae en la familia deducida del nombre,
// mismo criterio que análisis de ventas: MIEL 500G y MIEL 1KG son una sola familia.
function familiaDeCarga() {
  const familiasPorPlu = new Map();
  for (const f of familiasManuales.familiasSanitizadas(leerJSON(FAMILIAS_MANUALES_PATH, []))) {
    for (const p of f.productos || []) if (p && p.id) familiasPorPlu.set(String(p.id), f.nombre);
  }
  return c => familiasPorPlu.get(String(c && c.plu))
    || analisisVentas.familiaNombre(c && c.nombre);
}

// productividad.js. Las cargas viven en tres lugares a la vez —el archivo vivo, el historial
// de conciliadas y el snapshot de cierre del día—, así que se unen por id antes de medir.
app.get('/api/productividad', apiRoute(async req => {
  const desde = req.query.desde ? safeDate(req.query.desde) : null;
  const hasta = req.query.hasta ? safeDate(req.query.hasta) : null;
  const enRango = f => productividad.enRango(f, desde, hasta);

  const planes = leerJSON(PLANES_PATH, {});
  const planItems = Object.keys(planes)
    .filter(enRango)
    .flatMap(fecha => (planes[fecha].items || []).map(it => ({ ...it, fecha })));

  const snapshots = leerRegistros();
  const nuevasProd = productividad
    .unirPorId(leerJSON(PROD_REG_PATH, []), leerJSON(PROD_HIST_PATH, []),
               snapshots.flatMap(s => (s && s.cargas) || []))
    .filter(c => enRango(c && c.fecha));

  // Fraccionado: el archivo vivo se vacía al cerrar el día, y lo cerrado queda dentro de cada
  // snapshot de historial_distribucion.json en su campo `produccion`.
  const nuevasFrac = productividad
    .unirPorId(leerJSON(FRAC_REG_PATH, []),
               leerJSON(HISTORIAL_PATH, []).flatMap(h => (h && h.produccion) || []))
    .filter(c => enRango(c && c.fecha));

  // Resúmenes viejos (data/resumenes/*.xlsx): son la producción anterior a estos JSON y salen
  // enteros de la sala de producción, más allá de lo que diga su columna "Sala". Las jornadas
  // que ya están cargadas en el sistema nuevo mandan, para no contarlas dos veces.
  const legacy = resumenesLegacy.leerCarpeta(RESUMENES_DIR);
  const legacyEnRango = legacy.cargas.filter(c => c && enRango(c.fecha));
  const cargasProd = [...nuevasProd, ...resumenesLegacy.sinFechasCubiertas(legacyEnRango, nuevasProd)];
  const cargasFrac = nuevasFrac;
  // Tareas necesarias que no producen unidades (limpieza, preparación): van contadas aparte.
  const tareas = legacy.tareas.filter(t => t && enRango(t.fecha));

  const familiaDe = familiaDeCarga();

  const ordenes = productividad.unirPorId(leerOrdenes(), snapshots.flatMap(s => (s && s.ordenes) || []));
  const { filas, sinPlan } = productividad.resumenOrdenes(planItems, cargasProd, ordenes);

  return {
    desde, hasta,
    produccion: {
      totales: productividad.totales(cargasProd),
      dias: productividad.resumenPorDia(planItems, cargasProd, ordenes),
      ordenes: filas,
      sinPlan,
      personas: productividad.resumenPersonas(cargasProd),
      productos: productividad.resumenProductos(cargasProd, familiaDe),
      familias: productividad.resumenFamilias(cargasProd, familiaDe),
      porDia: productividad.resumenPeriodos(cargasProd, 'dia', tareas, familiaDe),
      porSemana: productividad.resumenPeriodos(cargasProd, 'semana', tareas, familiaDe),
      porMes: productividad.resumenPeriodos(cargasProd, 'mes', tareas, familiaDe),
      tareas,
    },
    fraccionado: {
      totales: productividad.totales(cargasFrac),
      productos: productividad.resumenProductos(cargasFrac, familiaDe),
      familias: productividad.resumenFamilias(cargasFrac, familiaDe),
      personas: productividad.resumenPersonas(cargasFrac),
      porDia: productividad.resumenPeriodos(cargasFrac, 'dia', null, familiaDe),
      porSemana: productividad.resumenPeriodos(cargasFrac, 'semana', null, familiaDe),
      porMes: productividad.resumenPeriodos(cargasFrac, 'mes', null, familiaDe),
      tareas: [],
      registros: cargasFrac.map(c => ({
        id: c.id, fecha: c.fecha, plu: String(c.plu == null ? '' : c.plu), producto: c.nombre || '',
        persona: productividad.nombreLindo((productividad.personasDeCarga(c)[0] || {}).nombre || ''),
        unidades: Number(c.cantFraccionada) || 0, kilos: productividad.kilosDeCarga(c),
        desde: c.desde || '', hasta: c.hasta || '',
      })),
    },
  };
}));

// Historial de sala: los resúmenes viejos enteros, sin el filtro de fechas del dashboard y sin
// descartar las jornadas que también están en los JSON nuevos. Es la vista del archivo tal cual
// quedó, con el dato que sólo él tiene: quién hizo envasado, etiquetado y empaquetado, y cuánto
// tardó cada tarea. Endpoint aparte porque es pesado (156 xlsx) y se pide sólo al abrir la tab.
// Precios de venta de lista para valorizar lo producido. Misma lista y sucursal que usa el
// facturador, así el número coincide con lo que se cobra en el mostrador. Se cachean unos
// minutos: son 8 meses de lotes contra el catálogo entero y los precios no cambian por hora.
const PRECIOS_TTL_MS = 5 * 60 * 1000;
let cachePrecios = { sello: 0, mapa: new Map() };

async function preciosDeVenta() {
  if (Date.now() - cachePrecios.sello < PRECIOS_TTL_MS) return cachePrecios.mapa;
  const rows = await query(`
    SELECT p.IdProducto, CAST(psp.PrecioVenta AS FLOAT) AS PrecioVenta
    FROM Productos p
    JOIN ProductosSucursalesPrecios psp
      ON psp.IdProducto = p.IdProducto
     AND psp.IdSucursal = 1
     AND psp.IdListaPrecios = ${LISTA_PRECIOS_VENTA}
    WHERE psp.PrecioVenta > 0
  `);   // LISTA_PRECIOS_VENTA se declara más abajo: para cuando entra un request ya existe.
  const mapa = new Map();
  for (const r of rows) mapa.set(String(r.IdProducto).trim(), Number(r.PrecioVenta) || 0);
  cachePrecios = { sello: Date.now(), mapa };
  return mapa;
}

// `desde`/`hasta`, `plu` y `persona` acotan la medición: el tablero entero se recalcula sobre
// ese subconjunto, no se esconden filas de un total ya sumado. Sin fechas se mide todo el
// archivo; `rangoTotal` de la respuesta dice cuál es ese máximo.
app.get('/api/productividad/historial', apiRoute(async req => {
  const legacy = resumenesLegacy.leerCarpeta(RESUMENES_DIR);
  // Sin base de datos el tablero sigue sirviendo: pierde la columna de plata, no el resto.
  let precios = new Map();
  try { precios = await preciosDeVenta(); } catch (e) { console.error('precios de venta:', e.message); }
  const r = historialSala.resumen(legacy, {
    desde: req.query.desde ? safeDate(req.query.desde) : null,
    hasta: req.query.hasta ? safeDate(req.query.hasta) : null,
    plu: String(req.query.plu || '').trim(),
    persona: String(req.query.persona || '').trim(),
  }, precios);
  // La referencia viaja con el tablero: es contra lo que se dibujan las líneas de los gráficos.
  // La primera vez se calcula y se guarda sola — sin ella no habría contra qué comparar, y no
  // tiene por qué ser el usuario el que descubra que hay que sembrarla.
  let referencia = leerJSON(REF_SALA_PATH, null);
  if (!referencia) {
    referencia = historialSala.referencia(legacy, precios, new Date().toISOString());
    guardarJSON(REF_SALA_PATH, referencia);
  }
  return { ...r, referencia };
}));

// Mismo tablero que el historial de sala pero sobre los registros nuevos de producción, que
// desde que se cargan por el sistema traen las tres tareas con su encargado y su horario igual
// que los xlsx viejos: por eso lo mide el mismo módulo. Acá NO entran los resúmenes legacy —
// esta vista es la de lo que se viene cargando, el archivo viejo tiene su propia tab.
function cargasProduccionNuevas() {
  const snapshots = leerRegistros();
  return productividad.unirPorId(leerJSON(PROD_REG_PATH, []), leerJSON(PROD_HIST_PATH, []),
                                 snapshots.flatMap(s => (s && s.cargas) || []));
}

app.get('/api/productividad/historial-produccion', apiRoute(async req => {
  const cargas = cargasProduccionNuevas();
  let precios = new Map();
  try { precios = await preciosDeVenta(); } catch (e) { console.error('precios de venta:', e.message); }
  const r = historialSala.resumen({ cargas, tareas: [] }, {
    desde: req.query.desde ? safeDate(req.query.desde) : null,
    hasta: req.query.hasta ? safeDate(req.query.hasta) : null,
    plu: String(req.query.plu || '').trim(),
    persona: String(req.query.persona || '').trim(),
  }, precios);
  let referencia = leerJSON(REF_PROD_PATH, null);
  if (!referencia) {
    referencia = historialSala.referencia({ cargas }, precios, new Date().toISOString());
    guardarJSON(REF_PROD_PATH, referencia);
  }
  return { ...r, referencia };
}));

app.post('/api/productividad/historial-produccion/referencia', apiRoute(async () => {
  let precios = new Map();
  try { precios = await preciosDeVenta(); } catch (e) { console.error('precios de venta:', e.message); }
  const referencia = historialSala.referencia({ cargas: cargasProduccionNuevas() }, precios,
                                              new Date().toISOString());
  guardarJSON(REF_PROD_PATH, referencia);
  return referencia;
}));

// Recalcular la referencia: se lee el archivo entero de nuevo y la foto nueva pisa a la vieja.
// Va por POST y a pedido porque mueve la vara con la que se mide todo lo demás.
app.post('/api/productividad/historial/referencia', apiRoute(async () => {
  const legacy = resumenesLegacy.leerCarpeta(RESUMENES_DIR);
  let precios = new Map();
  try { precios = await preciosDeVenta(); } catch (e) { console.error('precios de venta:', e.message); }
  const referencia = historialSala.referencia(legacy, precios, new Date().toISOString());
  guardarJSON(REF_SALA_PATH, referencia);
  return referencia;
}));

app.post('/api/plan/:fecha', (req, res) => {
  const fecha = safeDate(req.params.fecha), planes = leerJSON(PLANES_PATH, {});
  const prev = planes[fecha];
  // Las notas se pisan con cualquier string, incluido '' (borrarlas): con `||` una nota vacía
  // caía al valor anterior y el texto viejo volvía al recargar.
  const notas = typeof req.body.notas === 'string' ? req.body.notas : (prev?.notas || '');
  // Los ítems solo se reemplazan si el cuerpo los trae. Guardar una nota mandaba el cache del
  // navegador y pisaba los ítems (con sus sellos de reserva/producción) por una versión vieja.
  const items = Array.isArray(req.body.items) ? req.body.items : (prev?.items || []);
  // `...prev` conserva el resto del plan (plan.reserva, el ledger de reservas), que antes se
  // perdía porque el objeto se reconstruía desde cero en cada guardado de notas.
  planes[fecha] = { ...prev, fecha, notas, creado: prev?.creado || new Date().toISOString(), items };
  guardarJSON(PLANES_PATH, planes); res.json(planes[fecha]);
});

// ── Agenda de bloques de tareas ────────────────────────────────────────────────
// Plantillas: qué tareas lleva cada producto o rubro y cuánto dura cada una. Se guarda la
// lista entera de una: la edita un planificador por vez desde el modal, no hay concurrencia.
app.get('/api/plantillas-tareas', (_req, res) => res.json(leerJSON(PLANTILLAS_TAREAS_PATH, [])));

app.post('/api/plantillas-tareas', (req, res) => {
  // Se valida antes de tocar el disco: un body roto no puede dejar el archivo de recetas a
  // medias, porque después la agenda de todos los días se genera desde acá.
  const errores = bloquesTareas.validarPlantillas(req.body);
  if (errores.length) return res.status(400).json({ error: errores[0], errores });
  const lista = bloquesTareas.normalizarPlantillas(req.body);
  guardarJSON(PLANTILLAS_TAREAS_PATH, lista);
  res.json(lista);
});

// Los bloques viven dentro del plan del día, pero NO se pueden guardar por POST /api/plan/:fecha:
// ese handler arma el plan como { ...prev, fecha, notas, creado, items } y descarta cualquier
// campo extra del body. Endpoint aparte, que además sólo toca jornadaInicio y bloques: los
// items y el ledger de reservas quedan intactos aunque el navegador tenga un cache viejo.
app.post('/api/plan/:fecha/bloques', (req, res) => {
  const fecha = safeDate(req.params.fecha);
  const errores = bloquesTareas.validarBloquesBody(req.body);
  if (errores.length) return res.status(400).json({ error: errores[0], errores });
  const planes = leerJSON(PLANES_PATH, {});
  const prev = planes[fecha];
  // Sin plan del día no hay items contra los que colgar los bloques: crear el plan acá dejaría
  // una agenda huérfana que no se ve en ninguna pantalla.
  if (!prev) return res.status(404).json({ error: 'No hay plan cargado para esa fecha.' });
  // Una jornadaInicio ausente o vacía no borra la que ya estaba guardada: el front puede mandar
  // sólo los bloques y el arranque del día se conserva.
  const jornadaInicio = bloquesTareas.minutosDeHora(req.body.jornadaInicio) == null
    ? (prev.jornadaInicio || '08:00')
    : String(req.body.jornadaInicio).trim();
  planes[fecha] = { ...prev, jornadaInicio, bloques: bloquesTareas.normalizarBloques(req.body.bloques) };
  guardarJSON(PLANES_PATH, planes);
  res.json({ jornadaInicio, bloques: planes[fecha].bloques });
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
app.put('/api/plan/:fecha/item/:id', apiRoute(async req => {
  const fecha = safeDate(req.params.fecha), id = parseInt(req.params.id);
  // Igual que al eliminar: se lee con saneo de sellos para no bloquear por una reserva muerta.
  const { planes, plan } = leerPlanReservas(fecha);
  if (!plan) return { error: 'Plan no encontrado' };
  const idx = (plan.items || []).findIndex(i => i.id === id); if (idx === -1) return { error: 'Ítem no encontrado' };
  const actual = plan.items[idx], body = req.body || {};
  // Ya trabajado en producción: no se modifica (la página pudo quedar desactualizada).
  if (actual.produccionMovimiento && actual.produccionMovimiento.numeroMovimiento != null) {
    return { error: `La orden ya fue trabajada en producción (movimiento #${actual.produccionMovimiento.numeroMovimiento}). Recargá la planificación: no se puede modificar.`, yaProducido: true };
  }
  // Reservada: no se cambian cantidades ni producto (desincronizaría la reserva). El cambio de
  // estado (que dispara la devolución al terminar) sí se permite.
  if (actual.reservaMovimiento && actual.reservaMovimiento.numeroMovimiento != null) {
    // envase/tapa entran acá porque sustituyen a los de la fórmula al calcular la reserva:
    // cambiarlos con la reserva sellada dejaría apartado un packaging que ya no corresponde.
    const cambiaContenido = ['cantConfirmada','cantSugerida','idProducto','producto','presentaciones','cantidad','idGranel','envase','tapa']
      .some(k => k in body && JSON.stringify(body[k]) !== JSON.stringify(actual[k]));
    if (cambiaContenido) {
      return { error: `La orden está reservada (movimiento #${actual.reservaMovimiento.numeroMovimiento}). Anulá la reserva antes de modificar cantidades o producto.`, yaReservado: true };
    }
  }
  const pasaAListo = body.estado === 'listo' && actual.estado !== 'listo';
  plan.items[idx] = { ...plan.items[idx], ...req.body, id };

  // Devolución automática: al terminar un ítem vuelve al depósito principal sólo su
  // porción de la reserva. Si el traslado falla el cambio de estado NO se pierde: se
  // guarda igual y el error viaja en reservaError para que la UI lo muestre.
  let reservaError = null, logError = null;
  if (pasaAListo && plan.reserva && plan.reserva.estado === 'activa' && saldoItemReserva(plan.reserva, id).length) {
    try {
      const r = await ejecutarDevolucionReserva(plan, id);
      if (r.error) reservaError = r.error;
      else {
        logError = r.logError || null;
        plan.reserva = r.reserva;
        plan.items[idx] = { ...plan.items[idx], reservaDevuelta: { numeroMovimiento: r.numeroMovimiento, fecha: new Date().toISOString(), idRegistro: r.idRegistro ?? null, depOrigen: r.depOrigen, depDestino: r.depDestino } };
      }
    } catch (e) { reservaError = e.message; }
  }

  guardarJSON(PLANES_PATH, { ...planes, [fecha]: plan });
  const item = reservaError ? { ...plan.items[idx], reservaError } : plan.items[idx];
  return conLogError(item, logError);
}));
app.delete('/api/plan/:fecha/item/:id', (req, res) => {
  const fecha = safeDate(req.params.fecha), id = parseInt(req.params.id);
  // leerPlanReservas (y no leerJSON pelado) porque de paso suelta los sellos huérfanos: si el
  // movimiento que reservaba la orden ya se revirtió, la guarda de abajo no tiene que frenarla.
  const { planes, plan } = leerPlanReservas(fecha);
  if (!plan) return res.status(404).json({ error: 'Plan no encontrado' });
  const itemBloq = (plan.items || []).find(it => String(it.id) === String(id));
  if (itemBloq && itemBloq.produccionMovimiento && itemBloq.produccionMovimiento.numeroMovimiento != null) {
    return res.status(409).json({ error: `La orden ya fue trabajada en producción (movimiento #${itemBloq.produccionMovimiento.numeroMovimiento}). Recargá la planificación: no se puede eliminar.` });
  }
  if (itemBloq && itemBloq.reservaMovimiento && itemBloq.reservaMovimiento.numeroMovimiento != null) {
    return res.status(409).json({ error: `La orden está reservada (movimiento #${itemBloq.reservaMovimiento.numeroMovimiento}) y no se puede eliminar. Anulá esa reserva primero.` });
  }
  const items = (plan.items || []).filter(i => i.id !== id);
  guardarJSON(PLANES_PATH, { ...planes, [fecha]: { ...plan, items } });
  res.json({ ok: true });
});
app.delete('/api/plan/:fecha', (req, res) => {
  const fecha = safeDate(req.params.fecha), planes = leerJSON(PLANES_PATH, {});
  let conservadas = 0, porReserva = 0, porProduccion = 0;
  if (planes[fecha]) {
    // No se borran ni las órdenes reservadas ni las ya recepcionadas: las primeras tienen
    // mercadería apartada en SiGA y las segundas ya cerraron su circuito. Borrarlas dejaría
    // movimientos vivos apuntando a un ítem inexistente. Se elimina sólo el resto.
    // Antes sólo se miraba reservaMovimiento, así que un ítem recepcionado SIN reserva viva
    // (producido sin reservar, o con su reserva revertida desde el historial) se borraba.
    const items = planes[fecha].items || [];
    const tieneMov = (it, campo) => !!(it && it[campo] && it[campo].numeroMovimiento != null);
    const conservar = items.filter(it => tieneMov(it, 'reservaMovimiento') || tieneMov(it, 'produccionMovimiento'));
    porReserva    = conservar.filter(it => tieneMov(it, 'reservaMovimiento')).length;
    porProduccion = conservar.filter(it => tieneMov(it, 'produccionMovimiento') && !tieneMov(it, 'reservaMovimiento')).length;
    conservadas = conservar.length;
    planes[fecha].items = conservar;
    guardarJSON(PLANES_PATH, planes);
  }
  const partes = [];
  if (porReserva)    partes.push(`${porReserva} reservada(s): anulá su reserva para poder eliminarlas`);
  if (porProduccion) partes.push(`${porProduccion} ya recepcionada(s): su circuito ya cerró y no se pueden eliminar`);
  res.json({ ok: true, conservadas, porReserva, porProduccion,
    ...(conservadas ? { aviso: `Se conservaron ${conservadas} orden(es) — ${partes.join('; ')}.` } : {}) });
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
    // Cada orden hereda los números de movimiento de reserva de los ítems del plan que la
    // componen: granel es 1 ítem por orden (match por producto); fraccionado agrupa varios
    // ítems por rubro (match por rubro, con fallback a producto si no hay rubro explícito) —
    // misma clave que arma construirOrdenes() en planificacion.html. Cache por fecha para no
    // releer planes.json por cada orden del envío.
    const planItemsPorFecha = new Map();
    const itemsDeOrden = n => {
      if (!planItemsPorFecha.has(n.fecha)) {
        const { plan } = leerPlanReservas(n.fecha);
        planItemsPorFecha.set(n.fecha, (plan && plan.items) || []);
      }
      return planItemsPorFecha.get(n.fecha).filter(it =>
        it && (it.producto === n.producto || (it.rubro || it.producto) === n.producto));
    };
    const movimientosDeOrden = n => [...new Set(itemsDeOrden(n)
      .filter(it => it.reservaMovimiento && it.reservaMovimiento.numeroMovimiento != null)
      .map(it => it.reservaMovimiento.numeroMovimiento))];
    // Un ítem con produccionMovimiento ya se produjo Y se recepcionó como artículo final: su
    // circuito cerró y la orden no se puede volver a enviar.
    // ordenesTrabajadas NO alcanza para detectarlo: al conciliar, los registros se mueven de
    // produccion_registros.json a produccion_historial.json, así que el Set queda vacío para
    // esas órdenes y volvían a ser re-enviables justo después de conciliar.
    const numeroRecepcion = n => {
      const it = itemsDeOrden(n).find(x =>
        x.produccionMovimiento && x.produccionMovimiento.numeroMovimiento != null);
      return it ? it.produccionMovimiento.numeroMovimiento : null;
    };
    // Órdenes ya trabajadas (con algún registro de producción cargado): no se pisan aunque
    // todavía no estén en 'listo'/terminado, para no borrar lo que producción ya cargó.
    const ordenesTrabajadas = new Set(leerJSON(PROD_REG_PATH, []).map(r => String(r && r.ordenId)).filter(v => v && v !== 'undefined'));
    let sobre = 0, nue = 0, completas = 0;
    const recepcionadas = [];
    for (const n of nuevas) {
      // Se corta ANTES del alta o la sobreescritura: la orden ya cerró su circuito en SiGA.
      const numRecep = numeroRecepcion(n);
      if (numRecep != null) {
        recepcionadas.push({ producto: n.producto, numeroMovimiento: numRecep });
        continue;
      }
      const k = keyOf(n), i = idx.get(k);
      const reservaMovimientos = movimientosDeOrden(n);
      if (i != null) {
        const prev = arr[i];
        // Si la orden previa ya está completa o fue trabajada en producción, se mantiene:
        // no se sobreescribe (preserva registro cargado, estado 'listo' y terminado).
        if (prev.terminado === true || prev.estado === 'listo' || ordenesTrabajadas.has(String(prev.id))) { completas++; continue; }
        arr[i] = { ...n, id: prev.id, estado: prev.estado, terminado: prev.terminado, criticidad: prev.criticidad === 'Urgente' ? 'Urgente' : n.criticidad, reservaMovimientos };
        sobre++;
      } else {
        arr.push({ ...n, reservaMovimientos }); idx.set(k, arr.length - 1); nue++;
      }
    }
    guardarOrdenes(arr);
    res.json({ ok: true, enviadas: nuevas.length, sobrescritas: sobre, nuevas: nue,
               completasOmitidas: completas, recepcionadasOmitidas: recepcionadas });
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

// ── Facturador auxiliar (HTML suelto) ──────────────────────────────────────────
// Catálogo plano de precios para el facturador que corre como archivo local. No lleva
// sesión a propósito: el HTML se abre con file:// y no puede loguearse. El guard de IP
// de LAN (más arriba) ya limita quién llega hasta acá.
// IdListaPrecios 0 es "Lista de precios SUCURSALES". La lista 1 se llama, textual,
// "Lista de precios NO USAR": sin este filtro cada producto sale duplicado y con el
// precio de la lista equivocada la mitad de las veces.
const LISTA_PRECIOS_VENTA = 0;

app.get('/api/facturador/catalogo', apiRoute(async req => {
  const sucursal = Math.max(1, Math.min(parseInt(req.query.sucursal, 10) || 1, 99));
  const rows = await query(`
    SELECT p.IdProducto, p.NombreProducto, p.CodigoDeBarras, p.ModalidadCodigoDeBarras,
           p.IdUnidadDeMedida, CAST(psp.PrecioVenta AS FLOAT) AS PrecioVenta
    FROM Productos p
    JOIN ProductosSucursalesPrecios psp
      ON psp.IdProducto = p.IdProducto
     AND psp.IdSucursal = ${sucursal}
     AND psp.IdListaPrecios = ${LISTA_PRECIOS_VENTA}
    WHERE p.Activo = 1 AND psp.PrecioVenta > 0
    ORDER BY p.NombreProducto
  `);
  return {
    generado: new Date().toISOString(),
    origen: `server:${PORT} suc ${sucursal}`,
    sucursal,
    productos: rows.map(r => {
      // Los códigos "0", "1" o de 2-3 dígitos que abundan en la base no son códigos de
      // barra reales: son restos de carga. Se descartan para que no generen falsos
      // positivos al escanear.
      const barra = String(r.CodigoDeBarras || '').replace(/\D/g, '');
      const modalidad = String(r.ModalidadCodigoDeBarras || '').trim().toUpperCase();
      return {
        plu: String(r.IdProducto).trim(),
        nombre: r.NombreProducto,
        precio: Math.round(Number(r.PrecioVenta) * 100) / 100,
        barra: barra.length >= 7 ? barra : '',
        modalidad: modalidad === 'PESO' || modalidad === 'PRECIO' ? modalidad : null,
        unidad: String(r.IdUnidadDeMedida || '').trim(),
      };
    }),
  };
}));

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

// ── Análisis de Ventas por Sucursal ──────────────────────────────────────────
// Días en quiebre por producto, sumando las sucursales del filtro. El umbral se calcula
// por producto+sucursal (las ventas de una sucursal no fijan el mínimo de otra) y la serie
// diaria de stock se reconstruye hacia atrás desde el stock de hoy, porque SIGA no guarda
// foto histórica. Devuelve Map idProducto -> días.
async function quiebresPorProducto(p, idProductos) {
  const idsCsv = analisisVentas.idsCsvSeguro(idProductos);
  if (!idsCsv) return new Map();
  const hoy = new Date().toISOString().slice(0, 10);
  const [pesablesRows, stockRows, netoRows, unidadesRows] = await Promise.all([
    query(analisisVentas.sqlPesables(idsCsv)),
    query(analisisVentas.sqlStockPorSucursal(idsCsv, p.sucIdsCsv)),
    query(analisisVentas.sqlNetoDiarioStock(p.desde, p.sucIdsCsv, idsCsv)),
    query(analisisVentas.sqlUnidadesPorSucursal(p, idsCsv)),
  ]);

  const pesables = new Set(pesablesRows.map(r => String(r.IdProducto)));
  const meses = analisisVentas.mesesDelRango(p.desde, p.hasta);
  const clave = (prod, suc) => `${prod}|${suc}`;
  const stock = new Map(stockRows.map(r => [clave(r.IdProducto, r.IdSucursal), Number(r.Stock || 0)]));
  const unidades = new Map(unidadesRows.map(r => [clave(r.IdProducto, r.IdSucursal), Number(r.Unidades || 0)]));
  // Netos y entradas indexados por producto+sucursal y, adentro, por fecha ISO.
  const netos = new Map();
  const entradas = new Map();
  for (const r of netoRows) {
    const k = clave(r.IdProducto, r.IdSucursal);
    if (!netos.has(k)) { netos.set(k, {}); entradas.set(k, {}); }
    const fecha = r.Fecha instanceof Date ? r.Fecha.toISOString().slice(0, 10) : String(r.Fecha).slice(0, 10);
    netos.get(k)[fecha] = Number(r.Neto || 0);
    entradas.get(k)[fecha] = Number(r.Entradas || 0);
  }

  // Una sucursal cuenta para un producto sólo si tuvo ventas o stock: si nunca lo trabajó,
  // sus días vacíos no son un quiebre suyo. La base del porcentaje acompaña ese criterio:
  // suma los días evaluables de cada sucursal que sí entró, así 8 días sobre 2 sucursales
  // se leen contra 52 día-sucursal y no contra 26.
  const acumulado = new Map();
  for (const k of new Set([...stock.keys(), ...unidades.keys()])) {
    const prod = k.split('|')[0];
    const umbral = analisisVentas.umbralQuiebre(unidades.get(k) || 0, meses, pesables.has(prod));
    const serie = analisisVentas.serieStockDiaria({
      stockActual: stock.get(k) || 0, netosPorFecha: netos.get(k), entradasPorFecha: entradas.get(k),
      desde: p.desde, hasta: p.hasta, hoy, umbral,
    });
    const previo = acumulado.get(prod) || { dias: 0, base: 0 };
    acumulado.set(prod, {
      dias: previo.dias + serie.filter(d => d.quiebre).length,
      base: previo.base + analisisVentas.diasEvaluados(serie),
    });
  }
  return acumulado;
}

// Qué tablas de clasificación (rubro/subrubro/marca) tiene esta base es fijo mientras el
// proceso vive: se sondea una vez y se reusa la condición armada. Si el sondeo falla, se
// cae al filtro por nombre de producto en vez de romper el reporte entero.
let condicionInsumos = null;
async function sinInsumosSQL() {
  if (condicionInsumos === null) {
    const meta = await query(analisisVentas.sqlMetaClasificacion()).catch(() => []);
    condicionInsumos = analisisVentas.filtroSinInsumos(analisisVentas.clasificacionesDisponibles(meta));
  }
  return condicionInsumos;
}

app.get('/api/analisis-ventas', apiRoute(async req => {
  const desde = safeDate(req.query.desde);
  const hasta = safeDate(req.query.hasta);
  const sucIds = analisisVentas.sucIdsSeguras(req.query.sucursales);
  const sucIdsCsv = sucIds.join(',');
  const topN = analisisVentas.clampTopN(req.query.top);
  const p = { desde, hasta, sucIdsCsv };
  // Los insumos (por nombre, rubro, subrubro o marca) no son productos de venta: quedan
  // fuera de las dos tablas de top productos y, por arrastre, de las familias.
  const sinInsumos = await sinInsumosSQL();

  const [comparativa, resumenArr, tendencia, diaSemana, horas, productosUnidades,
         artHistograma, artPorSucursal, productosFacturacion] =
    await Promise.all([
      query(analisisVentas.sqlComparativa(p)),
      query(analisisVentas.sqlResumenRenglon(p)),
      query(analisisVentas.sqlTendencia(p)),
      query(analisisVentas.sqlDiaSemana(p)),
      query(analisisVentas.sqlHora(p)),
      query(analisisVentas.sqlTopProductos(p, 'unidades', analisisVentas.LIMITE_FAMILIAS, sinInsumos)),
      query(analisisVentas.sqlArticulosHistograma(p)),
      query(analisisVentas.sqlArticulosPorSucursal(p)),
      // Una sola consulta amplia por facturación alimenta dos vistas: la tabla de productos
      // (paginada y con buscador, necesita todos los registros del rango) y las familias,
      // que se arman en JS sobre el nombre y se sesgarían si sólo se agrupara el top N.
      query(analisisVentas.sqlTopProductos(p, 'facturacion', analisisVentas.LIMITE_FAMILIAS, sinInsumos)),
    ]);

  const resumen = resumenArr[0] || { Unidades: 0, ProductosDistintos: 0 };
  const articulosProm = analisisVentas.promedioArticulos(artPorSucursal);
  // Reconstruir la serie diaria de stock cuesta cuatro consultas más y un recorrido día a
  // día por cada producto y sucursal: con varias sucursales el reporte se vuelve inusable.
  // Por eso los quiebres se calculan sólo cuando el filtro quedó en una sola sucursal.
  const conQuiebres = sucIds.length === 1;
  // Va después del Promise.all: necesita los ids de los productos que se van a listar.
  const quiebres = conQuiebres
    ? await quiebresPorProducto(p, productosFacturacion.map(r => r.IdProducto))
    : new Map();

  return {
    rango: { desde, hasta },
    sucursales: sucIds,
    // El front necesita distinguir "cero quiebres" de "no se calcularon".
    quiebresDisponibles: conQuiebres,
    kpis: { ...analisisVentas.kpisGlobales(comparativa, resumen), articulosProm },
    comparativa: comparativa.map(r => ({
      idSuc: r.IdSucursal, nombre: r.Nombre || `Suc. ${r.IdSucursal}`,
      facturacion: Number(r.Facturacion || 0), tickets: Number(r.Tickets || 0),
      ticketProm: analisisVentas.ticketProm(Number(r.Facturacion || 0), Number(r.Tickets || 0)),
    })),
    tendencia: tendencia.map(r => ({
      fecha: r.Fecha instanceof Date ? r.Fecha.toISOString().slice(0, 10) : String(r.Fecha).slice(0, 10),
      facturacion: Number(r.Facturacion || 0), tickets: Number(r.Tickets || 0),
    })),
    diaSemana: diaSemana.map(r => ({
      dow: Number(r.Dow), nombre: analisisVentas.mapDiaSemana(Number(r.Dow)),
      facturacion: Number(r.Facturacion || 0), tickets: Number(r.Tickets || 0),
    })),
    horas: horas.map(r => ({
      hora: Number(r.Hora), facturacion: Number(r.Facturacion || 0), tickets: Number(r.Tickets || 0),
    })),
    // Listas completas (no un top acotado): el front las pagina y filtra en memoria.
    topUnidades: productosUnidades.map(r => ({
      idProd: r.IdProducto, nombre: r.Nombre,
      unidades: Number(r.Unidades || 0), facturacion: Number(r.Facturacion || 0),
    })),
    topFacturacion: productosFacturacion.map(r => {
      const q = quiebres.get(String(r.IdProducto)) || { dias: 0, base: 0 };
      return {
        idProd: r.IdProducto, nombre: r.Nombre,
        unidades: Number(r.Unidades || 0), facturacion: Number(r.Facturacion || 0),
        // null (y no 0) cuando el cálculo no corrió: son cosas distintas para el que lee.
        quiebres: conQuiebres ? q.dias : null,
        // Base en día-sucursal: los días evaluables sumados de cada sucursal del filtro.
        quiebresBase: conQuiebres ? q.base : null,
        quiebresPorc: conQuiebres ? analisisVentas.porcentajeQuiebre(q.dias, q.base) : null,
      };
    }),
    // Familias del nombre + grupos manuales en una sola tabla. Los productos asignados a un
    // grupo se listan sólo ahí: ver familiasYGrupos.
    familias: analisisVentas.familiasYGrupos(productosFacturacion,
      familiasManuales.familiasSanitizadas(leerJSON(FAMILIAS_MANUALES_PATH, [])), topN),
    articulosPorTicket: {
      promedio: articulosProm,
      histograma: analisisVentas.bucketsArticulos(artHistograma),
      porSucursal: artPorSucursal.map(r => ({
        idSuc: r.IdSucursal, nombre: r.Nombre || `Suc. ${r.IdSucursal}`,
        tickets: Number(r.Tickets || 0), articulos: Number(r.Articulos || 0),
        promedio: Number(r.Promedio || 0),
        dias: Number(r.Dias || 0), ticketsDia: Number(r.TicketsDia || 0),
      })),
    },
  };
}));

// ── Análisis de ventas de casa central ──────────────────────────────────────
// Mismo análisis que el módulo por sucursal pero con alcance fijo en la central, así
// que reusa los mismos builders de SQL. Sin comparativa entre sucursales (hay una sola)
// y sin artículos por ticket: eso vive en el módulo de sucursales.
app.get('/api/analisis-central', apiRoute(async req => {
  const desde = safeDate(req.query.desde);
  const hasta = safeDate(req.query.hasta);
  const topN = analisisVentas.clampTopN(req.query.top);
  // excProdCsv sólo acá: son códigos que salen por la caja de la central pero no son
  // venta real. El análisis por sucursales no lo manda y queda como estaba.
  const p = {
    desde, hasta, sucIdsCsv: String(analisisVentas.SUCURSAL_CENTRAL),
    excProdCsv: analisisVentas.idsCsvSeguro(analisisVentas.PRODUCTOS_EXCLUIDOS_CENTRAL),
    // En la central lo único que no es venta de mostrador es el apiario: bultos, packs y
    // granel de depósito sí se venden y quedaban afuera del análisis.
    rubrosExcluidos: analisisVentas.RUBROS_EXCLUIDOS_CENTRAL,
  };
  const sinInsumos = await sinInsumosSQL();

  // Los productos se piden una sola vez: la tabla del front ordena por facturación o por
  // unidades en memoria, así que no hace falta traer el mismo listado dos veces.
  const [totales, resumenArr, tendencia, diaSemana, horas, productos, ventasCliente] =
    await Promise.all([
      // Una sola fila (la central), pero da facturación y tickets para los KPIs.
      query(analisisVentas.sqlComparativa(p)),
      query(analisisVentas.sqlResumenRenglon(p)),
      query(analisisVentas.sqlTendencia(p)),
      query(analisisVentas.sqlDiaSemana(p)),
      query(analisisVentas.sqlHora(p)),
      query(analisisVentas.sqlTopProductos(p, 'facturacion', analisisVentas.LIMITE_FAMILIAS, sinInsumos)),
      query(analisisVentas.sqlVentasPorClienteProducto(p)),
    ]);

  const resumen = resumenArr[0] || { Unidades: 0, ProductosDistintos: 0 };
  return {
    rango: { desde, hasta },
    kpis: analisisVentas.kpisGlobales(totales, resumen),
    tendencia: tendencia.map(r => ({
      fecha: r.Fecha instanceof Date ? r.Fecha.toISOString().slice(0, 10) : String(r.Fecha).slice(0, 10),
      facturacion: Number(r.Facturacion || 0), tickets: Number(r.Tickets || 0),
    })),
    diaSemana: diaSemana.map(r => ({
      dow: Number(r.Dow), nombre: analisisVentas.mapDiaSemana(Number(r.Dow)),
      facturacion: Number(r.Facturacion || 0), tickets: Number(r.Tickets || 0),
    })),
    horas: horas.map(r => ({
      hora: Number(r.Hora), facturacion: Number(r.Facturacion || 0), tickets: Number(r.Tickets || 0),
    })),
    topProductos: productos.map(r => ({
      idProd: r.IdProducto, nombre: r.Nombre,
      unidades: Number(r.Unidades || 0), facturacion: Number(r.Facturacion || 0),
    })),
    familias: analisisVentas.agruparFamilias(productos, topN),
    clientes: analisisVentas.agruparClientes(ventasCliente, topN),
  };
}));

// ── Familias de producto consolidadas (casa central + sucursales) ────────────
// Cada alcance se consulta por separado porque tienen filtros propios —la central excluye
// apicultura, los códigos que no son venta real y los clientes categoría sucursal— y recién
// después se fusionan por producto. Agrupar sobre la unión y no sobre dos agrupaciones
// sumadas es lo que hace que una familia con presentaciones en los dos lados dé bien.
// Muestra los datos de la central, así que exige los dos permisos, no uno.
function puedeVerFamilias(req, res, next) {
  const user = req.session && req.session.user;
  const ok = auth.puedeAcceder(user, 'analisis-ventas') && auth.puedeAcceder(user, 'analisis-central');
  if (!ok) return res.status(user ? 403 : 401).json({ error: user ? 'Sin permiso' : 'No autenticado' });
  return next();
}

app.get('/api/analisis-familias', puedeVerFamilias, apiRoute(async req => {
  const desde = safeDate(req.query.desde);
  const hasta = safeDate(req.query.hasta);
  // Vacío ≠ ausente: destildar todos los chips deja el listado sólo con la central.
  const sucIds = analisisVentas.sucIdsFamilias(req.query.sucursales);
  // La central entra salvo que se la destilde explícitamente (central=0).
  const conCentral = req.query.central !== '0';
  if (!sucIds.length && !conCentral) {
    return { rango: { desde, hasta }, sucursales: [], conCentral, totales: { unidades: 0, facturacion: 0 }, familias: [] };
  }
  const sinInsumos = await sinInsumosSQL();

  const consultas = [];
  if (sucIds.length) {
    consultas.push(query(analisisVentas.sqlTopProductos(
      { desde, hasta, sucIdsCsv: sucIds.join(',') },
      'facturacion', analisisVentas.LIMITE_FAMILIAS, sinInsumos)));
  }
  if (conCentral) {
    consultas.push(query(analisisVentas.sqlTopProductos({
      desde, hasta, sucIdsCsv: String(analisisVentas.SUCURSAL_CENTRAL),
      excProdCsv: analisisVentas.idsCsvSeguro(analisisVentas.PRODUCTOS_EXCLUIDOS_CENTRAL),
      rubrosExcluidos: analisisVentas.RUBROS_EXCLUIDOS_CENTRAL,
    }, 'facturacion', analisisVentas.LIMITE_FAMILIAS, sinInsumos)));
  }
  const listas = await Promise.all(consultas);
  const productos = analisisVentas.fusionarProductos(...listas);

  // Sin tope: se listan todas las familias y el front las pagina de a 20. El tope de 20 del
  // resto de las vistas dejaría afuera justo la cola que esta pestaña quiere mostrar.
  const familias = analisisVentas.agruparFamilias(productos, Infinity);
  return {
    rango: { desde, hasta },
    sucursales: sucIds,
    conCentral,
    totales: {
      unidades: productos.reduce((a, r) => a + Number(r.Unidades || 0), 0),
      facturacion: productos.reduce((a, r) => a + Number(r.Facturacion || 0), 0),
      productos: productos.length,
    },
    familias,
  };
}));

// ── Familias manuales de producto ────────────────────────────────────────────
// Grupos que arma el usuario a mano para comparar entre sucursales el pedazo de catálogo
// que le interesa. La definición vive en un JSON (no en SIGA) y las ventas se consultan
// contra los códigos que tenga cargados. Alcance: sucursales, sin casa central — por eso
// alcanza con el permiso de analisis-ventas.
const FAMILIAS_MANUALES_PATH = path.join(DATA_DIR, 'familias_manuales.json');

function puedeVerAnalisis(req, res, next) {
  const user = req.session && req.session.user;
  if (!auth.puedeAcceder(user, 'analisis-ventas')) {
    return res.status(user ? 403 : 401).json({ error: user ? 'Sin permiso' : 'No autenticado' });
  }
  return next();
}

app.get('/api/familias-manuales', puedeVerAnalisis, (_req, res) => {
  res.json(familiasManuales.familiasSanitizadas(leerJSON(FAMILIAS_MANUALES_PATH, [])));
});

// Se guarda la lista entera de una: son pocas familias y editarlas es una operación de
// pantalla completa, así que un PUT del conjunto evita inventar ids y sincronizarlos.
app.put('/api/familias-manuales', puedeVerAnalisis, (req, res) => {
  const familias = familiasManuales.familiasSanitizadas(req.body);
  guardarJSON(FAMILIAS_MANUALES_PATH, familias);
  res.json(familias);
});

app.get('/api/familias-manuales/ventas', puedeVerAnalisis, apiRoute(async req => {
  const desde = safeDate(req.query.desde);
  const hasta = safeDate(req.query.hasta);
  const sucIds = analisisVentas.sucIdsSeguras(req.query.sucursales);
  // Las promos se facturan a una cuenta propia por sucursal: acá se pueden mirar aparte
  // (solo), sacar del total (sin) o dejarlas adentro (todas, que es como abre el tablero).
  const promo = analisisVentas.modoPromoSeguro(req.query.promo) || 'todas';
  const familias = familiasManuales.familiasSanitizadas(leerJSON(FAMILIAS_MANUALES_PATH, []));
  const idsCsv = analisisVentas.idsCsvSeguro(familiasManuales.idsDeFamilias(familias));
  // Sin familias o sin productos asignados no hay nada que consultar: el IN () vacío sería
  // SQL inválido y la respuesta igual tiene que traer la estructura para que el front pinte.
  const rows = idsCsv
    ? await query(analisisVentas.sqlVentasPorProductoSucursal(
        { desde, hasta, sucIdsCsv: sucIds.join(','), promo }, idsCsv))
    : [];
  const grupos = familiasManuales.agruparVentas(rows, familias, sucIds);
  return {
    rango: { desde, hasta },
    sucursales: sucIds,
    promo,
    familias: grupos,
    porSucursal: familiasManuales.totalesPorSucursal(grupos, sucIds),
    totales: {
      facturacion: grupos.reduce((a, g) => a + g.total.facturacion, 0),
      unidades: grupos.reduce((a, g) => a + g.total.unidades, 0),
      productos: familiasManuales.idsDeFamilias(familias).length,
    },
  };
}));

// ── Cuentas Corrientes de Clientes ───────────────────────────────────────────
// Saldo vivo por cliente + detalle de comprobantes. Clientes.SaldoPendiente está
// en 0 en toda la base, así que el saldo se recalcula sumando CuentasCorrientes.
app.get('/api/cuentas-corrientes', apiRoute(async req => {
  const csv = cuentasCorrientes.catIdsCsv(cuentasCorrientes.catIdsSeguras(req.query.categorias));
  // Antigüedad de mora opcional: null = sin filtro (saldo total, comportamiento default).
  const vencidoDias = cuentasCorrientes.vencidoDiasSeguro(req.query.vencidoDias);
  const p = { csv, vencidoDias };

  const [clientes, comprobantes] = await Promise.all([
    query(cuentasCorrientes.sqlClientesConSaldo(p)),
    query(cuentasCorrientes.sqlComprobantes(p)),
  ]);

  // IdCliente y NumeroComprobante son bigint: el driver los devuelve como string.
  return {
    generado: new Date().toISOString(),
    filtros: { vencidoDias },
    totales: cuentasCorrientes.totales(clientes),
    clientes: clientes.map(r => ({
      IdCliente: Number(r.IdCliente),
      NombreCliente: r.NombreCliente || '',
      Categoria: r.Categoria || '',
      // Saldo = el que se muestra según el filtro de mora; SaldoTotal = el completo.
      Saldo: Number(r.Saldo || 0),
      SaldoSinVencer: Number(r.SaldoSinVencer || 0),
      SaldoTotal: Number(r.SaldoTotal || 0),
      Comprobantes: Number(r.Comprobantes || 0),
      UltimaFecha: cuentasCorrientes.fechaISO(r.UltimaFecha),
    })),
    comprobantes: comprobantes.map(r => ({
      IdCliente: Number(r.IdCliente),
      NombreCliente: r.NombreCliente || '',
      Categoria: r.Categoria || '',
      IdSucursal: Number(r.IdSucursal || 0),
      IdTipoComprobante: r.IdTipoComprobante || '',
      Letra: r.Letra || '',
      CentroEmisor: Number(r.CentroEmisor || 0),
      NumeroComprobante: Number(r.NumeroComprobante || 0),
      Fecha: cuentasCorrientes.fechaISO(r.Fecha),
      FechaVencimiento: cuentasCorrientes.fechaISO(r.FechaVencimiento),
      ImporteTotal: Number(r.ImporteTotal || 0),
      Saldo: Number(r.Saldo || 0),
      Observacion: r.Observacion || '',
      IdEstadoComprobante: r.IdEstadoComprobante || '',
    })),
  };
}));

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

app.get('/api/sucursales', apiRoute(async () =>
  (await sucursalesSiga()).filter(s => s.activa).map(sucursalPublica)));

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

// Diagnóstico de solo lectura: qué tipos de movimiento usa SiGA y con qué frecuencia.
// Sirve para elegir el IdTipoMovimiento correcto antes de habilitarlo para escritura
// (hoy solo BIENESUSO está permitido). No modifica nada.
app.get('/api/stock/tipos-movimiento', apiRoute(async req => {
  const s = await resolverSucursal(req.query.idSucursal);
  if (s.error) return { error: s.error };
  const suc = s.idSucursal;
  const [tipos, conSignoMixto] = await Promise.all([
    query(`SELECT TOP 40 ms.IdTipoMovimiento, COUNT(*) AS Comprobantes,
                  MAX(ms.FechaMovimiento) AS Ultimo
             FROM MovimientosStock ms WHERE ms.IdSucursal=${suc}
            GROUP BY ms.IdTipoMovimiento ORDER BY COUNT(*) DESC`),
    // Patrón de producción: un mismo comprobante con líneas positivas y negativas a la vez
    // (consume componentes y genera el terminado). Es lo que hoy NO cubre trasladarStock.
    query(`SELECT TOP 20 d.IdTipoMovimiento,
                  COUNT(DISTINCT d.NumeroMovimiento) AS Comprobantes,
                  SUM(CASE WHEN d.Cantidad > 0 THEN 1 ELSE 0 END) AS LineasPositivas,
                  SUM(CASE WHEN d.Cantidad < 0 THEN 1 ELSE 0 END) AS LineasNegativas
             FROM MovimientosStockProductos d WHERE d.IdSucursal=${suc}
            GROUP BY d.IdTipoMovimiento
           HAVING SUM(CASE WHEN d.Cantidad > 0 THEN 1 ELSE 0 END) > 0
              AND SUM(CASE WHEN d.Cantidad < 0 THEN 1 ELSE 0 END) > 0
            ORDER BY COUNT(DISTINCT d.NumeroMovimiento) DESC`)
  ]);
  return { permitidosParaEscritura: TIPOS_MOVIMIENTO_STOCK_PERMITIDOS, tipos, conSignoMixto };
}));

// Depósitos activos de una sucursal. Los nombres en SiGA vienen con espacios adelante,
// por eso el RTRIM (el LTRIM lo hace el trim de cada consumidor si hace falta).
async function depositosActivos(idSucursal) {
  const suc = Number(idSucursal);
  if (!Number.isInteger(suc) || suc <= 0) return [];
  return query(`SELECT IdDeposito, IdSucursal, RTRIM(NombreDeposito) AS NombreDeposito, TipoDeposito, DisponibleVenta
    FROM SucursalesDepositos WHERE IdSucursal=${suc} AND Activo=1 ORDER BY IdDeposito`);
}

// A diferencia del resto, acá idSucursal sigue siendo obligatorio (es un endpoint de
// diagnóstico y pedir depósitos "de la sucursal que sea" no tiene sentido); lo que se suma
// es la validación contra Sucursales para no devolver una lista vacía ante un id inexistente.
app.get('/api/stock/depositos', apiRoute(async req => {
  const idSucursal = Number(req.query.idSucursal);
  if (!Number.isInteger(idSucursal) || idSucursal <= 0) return { error: 'Falta idSucursal (entero positivo)' };
  const s = await resolverSucursal(idSucursal);
  if (s.error) return { error: s.error };
  return depositosActivos(s.idSucursal);
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
  // Sin usuario en el body se firma con el de config.json (reserva.usuario): así el usuario
  // de los movimientos se cambia en un solo lugar. Recortado por USUARIO_MOV_MAX.
  const usuario          = String(b.usuario || cfgReserva().usuario || '').trim().slice(0, USUARIO_MOV_MAX);
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
  // Movimiento de una sola línea y sin depósito destino: en el log va depDestino en null.
  const r = await ejecutarYRegistrar({
    origen: 'movimiento', plan: null, itemId: null,
    idSucursal, depOrigen: idDeposito, depDestino: null, idUbicacion, idEmpleado,
    idTipoMovimiento, usuario, observacion,
    lineas: [{ plu: idProducto, nombre: null, cantidad }]
  }, () => registrarMovimientoStock(poolW, {
    idSucursal, idDeposito, idUbicacion, idEmpleado, cantidad,
    idTipoMovimiento, idProducto, usuario, observacion
  }));
  return conLogError({ ok: true, numeroMovimiento: r.numeroMovimiento, idTipoMovimiento, idSucursal, idRegistro: r.idRegistro }, r.logError);
}));

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
// 'reserva' es la de planificacion (componentes de formula del plan del dia); 'reserva-mayorista'
// es la de Pedidos mayoristas (producto terminado apartado para UN cliente). Son dos flujos
// distintos y hay que poder filtrarlos por separado en /api/stock/movimientos.
const MOV_LOG_ORIGENES     = ['reserva', 'reserva-mayorista', 'ajuste', 'devolucion', 'traslado', 'movimiento', 'produccion'];
const MOV_LOG_LIMIT_DEF    = 100;
const MOV_LOG_LIMIT_MAX    = 500;

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

app.get('/api/stock/movimientos', apiRoute(async req => {
  const q      = req.query || {};
  const plan   = String(q.plan   || '').trim();
  const origen = String(q.origen || '').trim();
  const estado = String(q.estado || '').trim();
  const limit  = Math.min(Math.max(parseInt(q.limit) || MOV_LOG_LIMIT_DEF, 1), MOV_LOG_LIMIT_MAX);
  if (origen && !MOV_LOG_ORIGENES.includes(origen)) {
    return { error: `origen inválido. Permitidos: ${MOV_LOG_ORIGENES.join(', ')}` };
  }
  // Filtro por sucursal: cada registro del log ya guarda su idSucursal. Se valida sólo el
  // formato (no se consulta SiGA): sin el parámetro se devuelven todas, como hasta ahora.
  const filtraSuc  = String(q.idSucursal ?? '').trim() !== '';
  const idSucursal = filtraSuc ? Number(q.idSucursal) : null;
  if (filtraSuc && (!Number.isInteger(idSucursal) || idSucursal <= 0)) return { error: ERR_SUCURSAL_INVALIDA };
  return leerMovLog()
    .filter(r => r && (!plan || r.plan === plan) && (!origen || r.origen === origen) && (!estado || r.estado === estado)
              && (!filtraSuc || Number(r.idSucursal) === idSucursal))
    .slice()
    .reverse()   // el log se escribe con el más nuevo al final; acá se devuelve al revés
    .slice(0, limit);
}));

app.get('/api/stock/movimientos/:id', apiRoute(async req => {
  const id = String(req.params.id || '').trim();
  return leerMovLog().find(r => r && r.id === id) || { error: 'Movimiento no encontrado' };
}));

// Revierte un movimiento ya confirmado generando OTRO movimiento con los depósitos
// invertidos (o la cantidad en negativo, para los movimientos de una sola línea).
// IMPORTANTE: revertir desde el log NO toca plan.reserva. El estado del plan y este log son
// dos registros distintos: el camino normal para deshacer una reserva es "Anular reserva"
// (POST /api/plan/:fecha/reserva/devolver), que además actualiza el plan. Revertir desde acá
// es la salida de emergencia para cuando el plan ya no existe o quedó inconsistente.
app.post('/api/stock/movimientos/:id/revertir', apiRoute(async req => {
  const id  = String(req.params.id || '').trim();
  const b   = req.body || {};
  const log = leerMovLog();
  const original = log.find(r => r && r.id === id);
  if (!original) return { error: 'Movimiento no encontrado' };

  if (original.estado === 'pendiente') {
    return { error: 'El movimiento quedó en estado pendiente: no se sabe si llegó a ejecutarse en SiGA. Verificalo a mano en SiGA antes de revertirlo.' };
  }
  if (original.estado === 'fallido') {
    return { error: 'El movimiento falló y no llegó a mover stock: no hay nada que revertir.' };
  }
  if (original.estado === 'revertido' || original.revertidoPor) {
    return { error: `El movimiento ya fue revertido por el registro ${original.revertidoPor || '(desconocido)'}.` };
  }
  if (original.estado !== 'confirmado') {
    return { error: `Sólo se pueden revertir movimientos confirmados (estado actual: ${original.estado}).` };
  }
  const lineas = (original.lineas || []).filter(l => Number(l.cantidad));
  if (!lineas.length) return { error: 'El movimiento no tiene líneas con cantidad para revertir' };

  // Misma guarda que "Anular reserva" y que modificar/eliminar una orden: una reserva cuyas
  // órdenes ya se produjeron y recepcionaron no se puede revertir, porque sus componentes ya
  // salieron del depósito de reserva. Va ANTES de escribir nada en SiGA.
  if ((original.origen === 'reserva' || original.origen === 'ajuste') && original.plan) {
    const { plan: planRev } = leerPlanReservas(original.plan);
    // El ajuste no tiene entrada en el ledger: sus órdenes son las que quedaron selladas con
    // su comprobante.
    const entrada = original.origen === 'ajuste'
      ? { ordenes: ((planRev && planRev.items) || [])
            .filter(it => it.reservaMovimiento && String(it.reservaMovimiento.numeroMovimiento) === String(original.numeroMovimiento))
            .map(it => it.id) }
      : planRev && (planRev.reservas || []).find(rr => rr &&
          (rr.idRegistro === original.id ||
           (rr.numeroMovimiento != null && rr.numeroMovimiento === original.numeroMovimiento)));
    const producidas = ordenesProducidasDeReserva(entrada, planRev && planRev.items);
    if (producidas.length) {
      return { error: motivoBloqueoProduccion(producidas, 'revertir este movimiento'), yaProducido: true };
    }
  }

  const cr          = cfgReserva();
  // Se firma con el usuario vigente de config.json, no con el del movimiento original: la
  // reversión la hace quien opera hoy. El usuario original queda igual en su propio registro.
  const usuario     = String(b.usuario || cr.usuario || '').trim().slice(0, USUARIO_MOV_MAX);
  const observacion = String(b.observacion || `Reversion de ${original.numeroMovimiento} (${original.origen})`).trim().slice(0, 200);
  const idEmpleado  = Number.isInteger(original.idEmpleado) && original.idEmpleado > 0 ? original.idEmpleado : cr.idEmpleado;
  if (!usuario) return { error: 'Falta usuario para registrar la reversión' };

  const poolW = await getPoolStock();
  // Tres formas distintas de revertir, según cómo se escribió el movimiento original:
  //  · multi-depósito (producción): cada línea tiene su propio depósito y su propio signo, y
  //    la cabecera depOrigen/depDestino es sólo referencia. Invertir los depósitos de la
  //    cabecera —como en un traslado— dejaría el stock en el lugar equivocado, así que la
  //    reversión invierte el SIGNO de cada línea y la deja en SU MISMO depósito.
  //  · sin depósito destino: movimiento de una sola línea, se repite con la cantidad negada.
  //  · el resto: traslado, se repite con los depósitos invertidos.
  const esMultiDeposito    = lineas.some(l => l && l.idDeposito != null);
  const esMovimientoSimple = !esMultiDeposito && original.depDestino == null;
  const lineasReversion = esMultiDeposito
    ? lineas.map(l => ({ ...l, cantidad: -Number(l.cantidad) }))
    : esMovimientoSimple
    ? [{ ...lineas[0], cantidad: -Number(lineas[0].cantidad) }]
    : lineas.map(l => ({ ...l, cantidad: Number(l.cantidad) }));

  const r = await ejecutarYRegistrar({
    origen: original.origen, plan: original.plan, itemId: original.itemId,
    idSucursal: original.idSucursal,
    depOrigen:  esMultiDeposito ? original.depOrigen : esMovimientoSimple ? original.depOrigen : original.depDestino,
    depDestino: esMultiDeposito ? original.depDestino : esMovimientoSimple ? null : original.depOrigen,
    idUbicacion: original.idUbicacion, idEmpleado,
    idTipoMovimiento: original.idTipoMovimiento, usuario, observacion,
    lineas: lineasReversion, revierteA: original.id
  }, () => esMultiDeposito
    ? registrarMovimientoMultilinea(poolW, {
        idSucursal: original.idSucursal, idTipoMovimiento: original.idTipoMovimiento,
        usuario, idEmpleado, observacion,
        lineas: lineasReversion.map(l => ({ idProducto: l.plu, idDeposito: l.idDeposito, cantidad: l.cantidad }))
      })
    : esMovimientoSimple
    ? registrarMovimientoStock(poolW, {
        idSucursal: original.idSucursal, idDeposito: original.depOrigen,
        idUbicacion: Number.isInteger(original.idUbicacion) && original.idUbicacion > 0 ? original.idUbicacion : 1,
        idEmpleado, cantidad: lineasReversion[0].cantidad,
        idTipoMovimiento: original.idTipoMovimiento, idProducto: lineasReversion[0].plu,
        usuario, observacion
      })
    : trasladarStock(poolW, {
        idSucursal: original.idSucursal, depOrigen: original.depDestino, depDestino: original.depOrigen,
        idTipoMovimiento: original.idTipoMovimiento, usuario, observacion, idEmpleado,
        lineas: lineasReversion.map(l => ({ idProducto: l.plu, cantidad: l.cantidad }))
      })
  );

  // Fase de enlace: se marca el original como revertido y se enlaza con su reversión.
  // Va ANTES de sincronizar el plan: el saldo según el log sólo descuenta la reversión una
  // vez que el par quedó enlazado.
  let errEnlace = null;
  try {
    const actual = leerMovLog();
    const copia  = actual.map(reg => {
      if (!reg) return reg;
      if (reg.id === original.id) return { ...reg, estado: 'revertido', revertidoPor: r.idRegistro };
      return reg;
    });
    guardarMovLog(copia);
  } catch (e) { errEnlace = `No se pudo enlazar la reversión ${r.idRegistro} con el original ${original.id}: ${e.message}`; }

  // Revertir el alta de producción tiene que dejar el plan como para poder volver a
  // registrarla: se borra la marca y, si la reserva se había cerrado justamente porque ese
  // movimiento consumió todo lo apartado, vuelve a quedar activa (la reversión devolvió los
  // componentes al depósito de reserva). Va ANTES de sincronizar el plan: sincronizarPlanConLog
  // sólo mira reservas activas.
  const errMarcaProduccion = original.origen === 'produccion' && original.plan
    ? limpiarProduccionRegistrada(original.plan, original.id)
    : null;

  // El plan y el log son registros distintos, así que acá se pone el plan al día con lo que
  // dice el log: si ya no queda nada en el depósito de reserva la reserva se anula sola, y
  // si quedó saldo parcial se avisa (no se puede recalcular a qué ítem le corresponde).
  let planSincronizado = null, advertencia = null, errPlan = null;
  if (original.plan) {
    try {
      const { motivo } = sincronizarPlanConLog(original.plan);
      if (motivo === 'anulada' || motivo === 'parcial') planSincronizado = motivo;
      if (motivo === 'parcial') {
        advertencia = `La reserva del plan ${original.plan} quedó con saldo parcial: según el log todavía hay componentes en el depósito de reserva, pero ya no coinciden con lo que dice el plan. Revisá la reserva y anulala antes de seguir.`;
      }
    } catch (e) { errPlan = `No se pudo sincronizar el plan ${original.plan} con el log: ${e.message}`; }
  }

  // Revertir una reserva libera sus órdenes: se anula la entrada del ledger (plan.reservas)
  // que corresponde a este movimiento y se limpia el sello reservaMovimiento de los ítems
  // que cubría, re-habilitándolos para volver a reservarse. Va DESPUÉS de sincronizarPlanConLog
  // (que sólo mira el plan.reserva viejo, único, agregado de todo el depósito) para que esta
  // actualización puntual por movimiento sea la que quede como estado final.
  // Los ajustes entran por el mismo camino: no tienen entrada propia en el ledger (el .map de
  // abajo no matchea ninguna), pero sí sellan ítems y hay que soltarlos igual.
  let errLedgerReserva = null;
  if ((original.origen === 'reserva' || original.origen === 'ajuste') && original.plan) {
    try {
      const { planes: planesReserva, plan: planReserva } = leerPlanReservas(original.plan);
      if (planReserva) {
        const reservas = (planReserva.reservas || []).map(rr =>
          (rr.idRegistro === original.id || (rr.numeroMovimiento != null && rr.numeroMovimiento === original.numeroMovimiento))
            ? { ...rr, estado: 'anulada' } : rr);
        const items = (planReserva.items || []).map(it =>
          (it.reservaMovimiento && it.reservaMovimiento.numeroMovimiento === original.numeroMovimiento)
            ? { ...it, reservaMovimiento: null } : it);
        // Compat: si plan.reserva (single, formato viejo) apuntaba a este movimiento, marcarlo anulado.
        const reservaCompat = (planReserva.reserva && planReserva.reserva.numeroMovimiento === original.numeroMovimiento)
          ? { ...planReserva.reserva, estado: 'anulada' } : planReserva.reserva;
        const planActualizado = { ...planReserva, reservas, items, reserva: reservaCompat };
        guardarJSON(PLANES_PATH, { ...planesReserva, [original.plan]: planActualizado });
      }
    } catch (e) { errLedgerReserva = `No se pudo anular la reserva del ledger para el plan ${original.plan}: ${e.message}`; }
  }

  // La advertencia queda también en el registro de la reversión, para que se entienda
  // después por qué el plan quedó marcado.
  const errAdv = advertencia ? actualizarMovLog(r.idRegistro, reg => ({ ...reg, advertencia })) : null;

  const resp = { ok: true, numeroMovimiento: r.numeroMovimiento, id: r.idRegistro, revierteA: original.id };
  const conPlan = planSincronizado ? { ...resp, planSincronizado } : resp;
  return conLogError(advertencia ? { ...conPlan, advertencia } : conPlan,
    r.logError, errEnlace, errPlan, errAdv, errMarcaProduccion, errLedgerReserva);
}));

app.post('/api/stock/traslado', apiRoute(async req => {
  const b = req.body || {};
  const idSucursal       = Number(b.idSucursal);
  const depOrigen        = Number(b.depOrigen);
  const depDestino       = Number(b.depDestino);
  const idEmpleado       = Number(b.idEmpleado);
  const idTipoMovimiento = String(b.idTipoMovimiento || '').trim().toUpperCase();
  // Sin usuario en el body se firma con el de config.json (reserva.usuario): así el usuario
  // de los movimientos se cambia en un solo lugar. Recortado además porque la columna
  // MovimientosStock.Usuario es corta y un valor largo hace fallar todo el INSERT con
  // "String or binary data would be truncated" (ver USUARIO_MOV_MAX).
  const usuario          = String(b.usuario || cfgReserva().usuario || '').trim().slice(0, USUARIO_MOV_MAX);
  const observacion      = String(b.observacion || '').trim().slice(0, 200);
  const lineas           = Array.isArray(b.lineas) ? b.lineas : [];

  if (!TIPOS_MOVIMIENTO_STOCK_PERMITIDOS.includes(idTipoMovimiento)) {
    return { error: `idTipoMovimiento inválido. Permitidos: ${TIPOS_MOVIMIENTO_STOCK_PERMITIDOS.join(', ')}` };
  }
  if (![idSucursal, depOrigen, depDestino, idEmpleado].every(n => Number.isInteger(n) && n > 0)) {
    return { error: 'idSucursal, depOrigen, depDestino e idEmpleado deben ser enteros positivos' };
  }
  if (depOrigen === depDestino) return { error: 'depOrigen y depDestino deben ser distintos' };
  if (!usuario)       return { error: 'Falta usuario' };
  if (!lineas.length) return { error: 'Falta lineas (al menos un producto a trasladar)' };
  for (const l of lineas) {
    const cantidad = Number(l && l.cantidad);
    if (!String((l && l.idProducto) || '').trim()) return { error: 'Cada línea debe tener idProducto' };
    if (!Number.isFinite(cantidad) || cantidad <= 0) return { error: `Cantidad inválida para el producto ${l.idProducto}: debe ser un número mayor a 0` };
  }

  const poolW   = await getPoolStock();
  const limpias = lineas.map(l => ({ idProducto: String(l.idProducto).trim(), cantidad: Number(l.cantidad) }));
  const r = await ejecutarYRegistrar({
    origen: 'traslado', plan: null, itemId: null,
    idSucursal, depOrigen, depDestino, idTipoMovimiento, usuario, observacion, idEmpleado,
    lineas: limpias.map(l => ({ plu: l.idProducto, nombre: null, cantidad: l.cantidad }))
  }, () => trasladarStock(poolW, {
    idSucursal, depOrigen, depDestino, idTipoMovimiento, usuario, observacion, idEmpleado,
    lineas: limpias
  }));
  return conLogError({ ok: true, numeroMovimiento: r.numeroMovimiento, idRegistro: r.idRegistro }, r.logError);
}));

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

// Nombre, rubro y estado (activo/inactivo) desde SIGA para un lote de PLU, en UNA sola query.
// Hace falta porque el caché de A8020 (a8020_calc.json → nombres/rubros) sólo cubre los
// artículos que entraron en el último recálculo: los productos dados de baja y algunos rubros
// internos (ej. "Produccion") no están, y sin este fallback aparecen en pantalla sin nombre.
// Si SIGA falla se devuelve un Map vacío: es un dato accesorio y no puede romper el detalle.
async function datosProductosSIGA(plus) {
  const ids = [...new Set((plus || []).map(p => String(p ?? '').trim()).filter(Boolean))];
  if (!ids.length) return new Map();
  const inList = ids.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
  try {
    const rows = await query(`
      SELECT p.IdProducto, p.NombreProducto, p.Activo, COALESCE(r.NombreRubro,'') AS rubro
      FROM dbo.Productos p
      LEFT JOIN dbo.Rubros r ON r.IdRubro = p.IdRubro
      WHERE p.IdProducto IN (${inList})`);
    return new Map(rows.map(r => [String(r.IdProducto).trim(), {
      nombre: String(r.NombreProducto || '').trim(),
      rubro:  String(r.rubro || '').trim(),
      activo: r.Activo === true || Number(r.Activo) === 1,
    }]));
  } catch (e) {
    console.error('[detalle-plu] no se pudieron leer datos de productos desde SIGA:', e.message);
    return new Map();
  }
}

// componente → [{plu, nombre, rubro, cantPorUnidad}]: el camino INVERSO de
// componentesFormulaPorPadre. Hace falta porque el detalle de consumo de un artículo tiene que
// mostrar todo lo que lo consume, y un granel no sólo se fracciona en presentaciones (eso sale
// de pesables_listas.formulas): también entra como ingrediente de mixes, granolas y otros
// productos elaborados, y esa relación sólo vive en ProductosComponentes.
// El filtro de fórmula activa es obligatorio: sin él la consulta devuelve una fila por cada
// versión histórica de la fórmula, e inventa padres que hoy ya no llevan el artículo.
// Si SIGA falla se devuelve lista vacía: es un dato accesorio y no puede romper el detalle.
async function productosQueUsanComponente(plu) {
  const id = String(plu ?? '').trim();
  if (!id) return [];
  const safeId = id.replace(/'/g, "''");
  try {
    const rows = await query(`
      SELECT pc.IdProducto AS padre, p.NombreProducto AS nombre,
             COALESCE(r.NombreRubro,'') AS rubro,
             CAST(pc.Cantidad AS FLOAT) AS cantPorUnidad
      FROM ProductosComponentes pc
      INNER JOIN Productos p ON p.IdProducto = pc.IdProducto
      LEFT  JOIN Rubros    r ON r.IdRubro   = p.IdRubro
      WHERE pc.IdProductoComponente = '${safeId}'
        AND p.Activo = 1
        AND ${FORMULA_ACTIVA_SQL}
        AND ${SIN_FORMULA_GENERICO_SQL}
      ORDER BY p.NombreProducto`);
    return rows.map(r => ({
      plu: String(r.padre).trim(),
      nombre: String(r.nombre || '').trim(),
      rubro: String(r.rubro || '').trim(),
      cantPorUnidad: Number(r.cantPorUnidad) || 0
    }));
  } catch (e) {
    console.error(`[detalle-plu] no se pudieron leer los productos que usan ${id}:`, e.message);
    return [];
  }
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

  const componentes = [], conUso = new Set();
  for (const u of consumo.componentes.values()) {
    if (u.plu) conUso.add(u.plu);
    componentes.push(filaComponente(u.plu, u.nombre, u.tipo, u.plu ? (reservado.get(u.plu) || 0) : 0, u.usado));
  }
  // Reservado y no usado: sobra entero, hay que devolverlo al depósito principal.
  for (const l of saldo) {
    const plu = String(l.plu);
    if (conUso.has(plu)) continue;
    componentes.push(filaComponente(plu, l.nombre, tipoComponentePorNombre(l.nombre), l.cantidad, 0));
  }
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
  const cr = cfgReserva();
  const cp = cfgProduccion();
  let depositos = [];
  try { depositos = await depositosActivos(sucursalPedida || cr.idSucursal); }
  catch (e) { avisos.push(`No se pudieron consultar los depósitos en SiGA (${e.message}): elegilos a mano antes de registrar.`); }
  const activos   = new Set(depositos.map(d => Number(d.IdDeposito)));
  const depValido = v => {
    const n = Number(v);
    if (!esIdDeposito(n)) return null;
    return (depositos.length && !activos.has(n)) ? null : n;
  };

  // Desglose por movimiento de reserva (para conciliar por orden y por movimiento). Sólo las
  // reservas todavía sin recepción: las conciliadas ya no tienen nada que mover.
  const _gruposMov = reservadoPorMovimiento(reservasVivas);
  const _usadoPorPlu = new Map([...consumo.componentes.values()]
    .filter(u => u.plu).map(u => [String(u.plu), u.usado]));
  const porMovimiento = conciliarPorMovimiento(_gruposMov, _usadoPorPlu);
  const depsPropuestos = depositosProduccion(cp, cr, reserva, {});

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

// Líneas del comprobante de producción a partir de la conciliación. Cada línea lleva su
// signo y su depósito:
//   · terminados     → +cantidad en el depósito de RECEPCIÓN (los excluidos no se dan de alta)
//   · consumo        → −usado contra lo que había reservado (depósito de reserva, que es donde
//                      la mercadería está físicamente) y, para lo que NO tenía reserva, contra
//                      el depósito de SALIDA.
// Lo que se desvía de lo reservado (excedente y sobrante) NO sale por acá: va en su propio
// comprobante de ajuste por diferencias (ver lineasDiferenciasProduccion), para poder
// identificarlo en SiGA por la observación.
// Los componentes sin PLU resoluble no se pueden mover y salen aparte en `sinPlu`.
// Función pura: no toca SQL ni archivos.
function lineasProduccionDesdeConciliacion(c, deps, opts) {
  // incluirReserva:false arma sólo el comprobante "resto" (terminados + consumo que salió de
  // FUERA de la reserva). El consumo contra la reserva y el sobrante se registran aparte, un
  // comprobante por movimiento de reserva (ver lineasAjusteMovimiento). Default true = comportamiento viejo.
  const incluirReserva = !opts || opts.incluirReserva !== false;
  const lineas = [], sinPlu = [];
  let terminados = 0, componentes = 0, ajustes = 0;

  for (const p of (c.productos || [])) {
    // Excluidos no se dan de alta; los ya registrados tampoco (no se vuelven a mover). Los
    // parciales llegan con `cantidad` = sólo lo pendiente, así que se registran normal.
    if (p.excluido || p.yaRegistrado) continue;
    const cantidad = redondear4(p.cantidad);
    if (!(cantidad > 0)) continue;
    if (!p.plu) { sinPlu.push({ tipo: 'producto', nombre: p.nombre || p.pluTexto || 'sin nombre', cantidad }); continue; }
    lineas.push({ idProducto: String(p.plu), nombre: p.nombre || '', idDeposito: deps.recepcion, cantidad, concepto: 'terminado' });
    terminados++;
  }

  for (const comp of (c.componentes || [])) {
    const usado = redondear4(comp.usado), reservado = redondear4(comp.reservado);
    if (!(usado > 0) && !(reservado > 0)) continue;
    if (!comp.plu) { sinPlu.push({ tipo: 'componente', nombre: comp.nombre || 'sin nombre', cantidad: usado }); continue; }
    const base        = { idProducto: String(comp.plu), nombre: comp.nombre || '' };
    const deReserva = redondear4(Math.min(usado, reservado));        // consumido contra lo apartado
    const excedente = redondear4(Math.max(0, usado - reservado));    // usado de más respecto de lo reservado
    const sobrante  = redondear4(Math.max(0, reservado - usado));    // apartado de más
    // Sin nada reservado no hay diferencia: todo el consumo es común y sale del depósito de
    // salida. Con reserva detrás, el desvío (excedente/sobrante) se registra en el comprobante
    // de ajuste por diferencias, no acá.
    const deSalida  = reservado > 0 ? 0 : excedente;

    if (incluirReserva && deReserva > 0) { lineas.push({ ...base, idDeposito: deps.reserva, cantidad: -deReserva, concepto: 'consumo-reserva' }); componentes++; }
    if (deSalida  > 0) { lineas.push({ ...base, idDeposito: deps.salida,  cantidad: -deSalida,  concepto: 'consumo-salida'  }); componentes++; }
    if (incluirReserva && (sobrante > 0 || (reservado > 0 && excedente > 0))) ajustes++;
  }

  // Carga manual: sin reserva detrás, el circuito entero ocurre en el depósito de RECEPCIÓN —
  // ahí se descuentan los componentes y ahí mismo entra el terminado, igual que si se armara
  // en el mostrador. Nunca toca el de reserva ni el de salida, y no depende de esos combos.
  // Va siempre en el comprobante de producción, con reserva o sin ella.
  for (const comp of (c.componentesManual || [])) {
    const usado = redondear4(comp.usado);
    if (!(usado > 0)) continue;
    if (!comp.plu) { sinPlu.push({ tipo: 'componente', nombre: comp.nombre || 'sin nombre', cantidad: usado }); continue; }
    lineas.push({ idProducto: String(comp.plu), nombre: comp.nombre || '', idDeposito: deps.recepcion, cantidad: -usado, concepto: 'consumo-manual' });
    componentes++;
  }
  return { lineas, sinPlu, resumen: { terminados, componentes, ajustes } };
}

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
  const resto     = lineasProduccionDesdeConciliacion(c, deps, { incluirReserva: false });
  const ajustesMov = (c.porMovimiento || [])
    .map(m => ({ numeroMovimiento: m.numeroMovimiento, ordenes: m.ordenes || [], conciliado: !!m.conciliado, lineas: lineasAjusteMovimiento(m.componentes, deps) }))
    // Los movimientos ya conciliados no se re-registran (idempotencia ante reintentos parciales).
    .filter(m => !m.conciliado && m.lineas.length);
  // Ajuste por diferencias: un único comprobante con todo lo que se desvió de lo reservado
  // (excedente y sobrante), calculado sobre el agregado por PLU de las reservas todavía vivas.
  const difs = lineasDiferenciasProduccion(c.componentes, deps);
  // Reservas que cubre ese comprobante: sirven de marca de idempotencia. Si un reintento llega
  // con las mismas reservas todavía sin conciliar, las diferencias ya se escribieron.
  const movimientosACubrir = ajustesMov.map(m => m.numeroMovimiento);
  const diferenciasYaRegistradas = ((planPrevio && planPrevio.ajustesDiferencias) || []).some(a =>
    Array.isArray(a && a.reservas) && a.reservas.length === movimientosACubrir.length
    && a.reservas.every(n => movimientosACubrir.includes(n)));

  const sinPlu = resto.sinPlu;
  const todasLasLineas = [...resto.lineas, ...difs, ...ajustesMov.flatMap(m => m.lineas)];

  // Defensa contra doble conteo: el reservado agregado (que usa el "resto" para el consumo-salida)
  // debe coincidir con la suma por movimiento. Sólo diferirían si una reserva quedara net-negativa
  // por PLU dentro de sí misma (devoluciones > líneas): hoy no ocurre, pero se corta por las dudas.
  const reservadoAgg = new Map((c.componentes || []).filter(x => x.plu).map(x => [String(x.plu), redondear4(x.reservado)]));
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
      idRegistro: rc.idRegistro, usuario: cr.usuario, idSucursal: cr.idSucursal, registros: idsRegistrados
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
    if (resto.lineas.length) {
      // Este es el comprobante de PRODUCCIÓN propiamente dicho: da de alta los terminados y
      // descuenta el consumo que NO salió del depósito de reserva (fórmulas sin reservar,
      // excedentes y carga manual). Los que cierran cada reserva se rotulan CONCILIACION.
      const rResto = await escribirComprobante(resto.lineas, obsBase.slice(0, 200), deps.reserva || deps.salida, deps.recepcion);
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

// ── Cruce de terminales ────────────────────────────────────────────────────────
// Las bajadas de Payway y QR se procesan en memoria (no se guardan): lo único que
// persiste es el mapa terminal→sucursal que sale del xlsx de distribución, para no
// tener que resubirlo en cada cruce.
const TERMINALES_MAP_PATH = path.join(DATA_DIR, 'terminales_sucursal.json');
const uploadCruce = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 12 } });

// Los reportes bancarios bajan en Windows-1252: si se leen como UTF-8, los acentos
// llegan como U+FFFD. Se prueba UTF-8 y se cae a latin1 cuando aparece basura.
function textoDeBuffer(buffer) {
  const utf8 = buffer.toString('utf8');
  return utf8.includes('�') ? buffer.toString('latin1') : utf8;
}

function mapaDesdeXlsx(buffer, nombreArchivo) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('El xlsx no tiene ninguna hoja');
  const grilla = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  return { ...cruceTerminales.parseMapaTerminales(grilla), actualizado: new Date().toISOString(), archivo: nombreArchivo || '' };
}

function mapaGuardado() {
  return leerJSON(TERMINALES_MAP_PATH, null);
}

// El detalle del último cruce queda en memoria para poder exportarlo sin resubir los
// CSV. Se guarda uno por usuario (o 'anonimo' si el módulo está abierto) y se pisa en
// cada proceso, así no crece sin control.
const ultimoCruce = new Map();
function claveCruce(req) {
  return String((req.session && req.session.user && req.session.user.usuario) || 'anonimo');
}

app.get('/api/cruce-terminales/mapa', apiRoute(async () => {
  const mapa = mapaGuardado();
  if (!mapa) return { cargado: false, sucursales: [], terminales: 0 };
  return {
    cargado: true,
    actualizado: mapa.actualizado || null,
    archivo: mapa.archivo || '',
    sucursales: mapa.sucursales || [],
    terminales: Object.keys(mapa.terminales || {}).length,
  };
}));

app.post('/api/cruce-terminales/mapa', uploadCruce.single('mapa'), (req, res) => {
  try {
    if (!req.file) return res.status(422).json({ error: 'Falta el xlsx de distribución (campo "mapa")' });
    const mapa = mapaDesdeXlsx(req.file.buffer, req.file.originalname);
    guardarJSON(TERMINALES_MAP_PATH, mapa);
    res.json({ ok: true, actualizado: mapa.actualizado, archivo: mapa.archivo, sucursales: mapa.sucursales, terminales: Object.keys(mapa.terminales).length });
  } catch (err) { console.error(err.message); res.status(422).json({ error: err.message }); }
});

app.post('/api/cruce-terminales/procesar', uploadCruce.fields([{ name: 'archivos', maxCount: 10 }, { name: 'mapa', maxCount: 1 }]), (req, res) => {
  try {
    const csvs = (req.files?.archivos || []);
    if (!csvs.length) return res.status(422).json({ error: 'No subiste ningún .csv de las plataformas' });

    // El xlsx es opcional: si viene, reemplaza el mapa guardado; si no, se usa el último.
    let mapa = null;
    if (req.files?.mapa?.[0]) {
      mapa = mapaDesdeXlsx(req.files.mapa[0].buffer, req.files.mapa[0].originalname);
      guardarJSON(TERMINALES_MAP_PATH, mapa);
    } else {
      mapa = mapaGuardado();
      if (!mapa) return res.status(422).json({ error: 'Todavía no cargaste el xlsx "Distribucion Terminales por sucursal": subilo junto con los CSV.' });
    }

    const resultado = cruceTerminales.procesarArchivos(
      csvs.map(f => ({ nombre: f.originalname, texto: textoDeBuffer(f.buffer) })),
      mapa,
    );
    ultimoCruce.set(claveCruce(req), resultado);
    // El detalle completo puede ser de miles de filas: al front va sólo lo que se
    // muestra; el detalle entero se baja en el xlsx.
    res.json({
      archivos: resultado.archivos,
      resumen: resultado.resumen,
      totales: resultado.totales,
      rango: resultado.rango,
      desconocidas: resultado.desconocidas,
      mapa: { actualizado: mapa.actualizado || null, archivo: mapa.archivo || '', sucursales: mapa.sucursales || [] },
      muestra: resultado.detalle.slice(0, 200),
    });
  } catch (err) { console.error(err.message); res.status(422).json({ error: err.message }); }
});

const COLUMNAS_DETALLE = [
  ['fecha', 'Fecha'], ['sucursalId', 'Sucursal ID'], ['sucursal', 'Sucursal'],
  ['plataforma', 'Plataforma'], ['terminal', 'Terminal'], ['establecimiento', 'Establecimiento'],
  ['medio', 'Medio de pago'], ['tarjeta', 'Tarjeta'], ['cuotas', 'Cuotas'],
  ['comprobante', 'Comprobante'], ['autorizacion', 'Autorización'],
  ['monto', 'Monto'], ['estado', 'Estado'], ['aprobadoTxt', 'Aprobado'],
  ['origenSucursal', 'Asignada por'], ['archivo', 'Archivo'],
];

function hojaDetalle(detalle) {
  const filas = detalle.map(c => {
    const fila = {};
    for (const [campo, titulo] of COLUMNAS_DETALLE) {
      fila[titulo] = campo === 'aprobadoTxt' ? (c.aprobado ? 'SÍ' : 'NO') : (c[campo] ?? '');
    }
    return fila;
  });
  return XLSX.utils.json_to_sheet(filas, { header: COLUMNAS_DETALLE.map(([, t]) => t) });
}

function hojaResumen(resumen, totales) {
  const filas = resumen.map(s => ({
    'Sucursal ID': s.sucursalId ?? '',
    'Sucursal': s.sucursal,
    'Aprobados (cant.)': s.aprobados.cantidad,
    'Aprobados ($)': s.aprobados.monto,
    'No aprobados (cant.)': s.noAprobados.cantidad,
    'No aprobados ($)': s.noAprobados.monto,
    'Total (cant.)': s.total.cantidad,
    'Total ($)': s.total.monto,
  }));
  filas.push({
    'Sucursal ID': '', 'Sucursal': 'TOTAL',
    'Aprobados (cant.)': totales.aprobados.cantidad, 'Aprobados ($)': totales.aprobados.monto,
    'No aprobados (cant.)': totales.noAprobados.cantidad, 'No aprobados ($)': totales.noAprobados.monto,
    'Total (cant.)': totales.comprobantes,
    'Total ($)': Math.round((totales.aprobados.monto + totales.noAprobados.monto) * 100) / 100,
  });
  return XLSX.utils.json_to_sheet(filas);
}

app.get('/api/cruce-terminales/exportar', (req, res) => {
  try {
    const resultado = ultimoCruce.get(claveCruce(req));
    if (!resultado) return res.status(409).json({ error: 'No hay un cruce procesado en esta sesión: subí los archivos de nuevo.' });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, hojaResumen(resultado.resumen, resultado.totales), 'Resumen');
    XLSX.utils.book_append_sheet(wb, hojaDetalle(resultado.detalle), 'Detalle');
    XLSX.utils.book_append_sheet(wb, hojaDetalle(resultado.detalle.filter(c => c.aprobado)), 'Aprobados');
    XLSX.utils.book_append_sheet(wb, hojaDetalle(resultado.detalle.filter(c => !c.aprobado)), 'No aprobados');
    if (resultado.desconocidas.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(resultado.desconocidas.map(t => ({
        'Terminal': t.terminal, 'Establecimiento': t.establecimiento, 'Plataforma': t.plataforma,
        'Comprobantes': t.cantidad, 'Monto': t.monto,
      }))), 'Sin identificar');
    }

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const sufijo = [resultado.rango.desde, resultado.rango.hasta].filter(Boolean).join('_a_') || 'sin-fecha';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="cruce_terminales_${sufijo}.xlsx"`);
    res.send(buffer);
  } catch (err) { console.error(err.message); res.status(500).json({ error: err.message }); }
});

// ── Precios históricos ─────────────────────────────────────────────────────────
// Qué precio tenía cada producto cada día del mes pedido. HistorialPrecios guarda un
// registro por CAMBIO de precio, así que van dos consultas: el precio vigente al
// arrancar el mes (baseline, que se arrastra hasta el primer cambio) y los cambios de
// adentro del mes. Traer el historial entero y filtrar en JS serían ~124k filas por la
// red para el mismo resultado.
// Sucursal 1 + lista 0 ("Lista de precios SUCURSALES"): el mismo precio de mostrador
// que usan el facturador y la valorización de producción, así los números coinciden.
const SUCURSAL_PRECIOS_HIST = 1;

async function grillaPreciosHistorico(anioRaw, mesRaw) {
  const { anio, mes } = preciosHistorico.validarPeriodo(anioRaw, mesRaw);
  const desde = preciosHistorico.primerDia(anio, mes);
  const hasta = preciosHistorico.primerDiaSiguiente(anio, mes);
  const filtro = `IdSucursal = ${SUCURSAL_PRECIOS_HIST} AND IdListaPrecios = ${LISTA_PRECIOS_VENTA} AND PrecioVenta IS NOT NULL`;

  const [baseline, cambios, vigentes, prods] = await Promise.all([
    query(`
      WITH ult AS (
        SELECT IdProducto, PrecioVenta,
               ROW_NUMBER() OVER (PARTITION BY IdProducto
                                  ORDER BY FechaHora DESC, IdHistorialPrecios DESC) AS rn
        FROM HistorialPrecios
        WHERE ${filtro} AND FechaHora < '${desde}'
      )
      SELECT IdProducto, CAST(PrecioVenta AS FLOAT) AS Precio FROM ult WHERE rn = 1`),
    query(`
      SELECT IdProducto, CONVERT(varchar(10), FechaHora, 23) AS Dia,
             CAST(PrecioVenta AS FLOAT) AS Precio
      FROM HistorialPrecios
      WHERE ${filtro} AND FechaHora >= '${desde}' AND FechaHora < '${hasta}'
      ORDER BY IdProducto, FechaHora, IdHistorialPrecios`),
    // Lista de precios completa de la sucursal: el último valor conocido de cada
    // producto. La planilla trae TODOS los códigos, haya habido cambios o no, y esta
    // consulta es la que cubre al que nunca cambió de precio (a muchos el historial les
    // registró sólo el costo). Sin filtro de precio > 0: un producto en 0 es un código
    // más y tiene que figurar.
    query(`
      SELECT IdProducto, CAST(PrecioVenta AS FLOAT) AS Precio
      FROM ProductosSucursalesPrecios
      WHERE IdSucursal = ${SUCURSAL_PRECIOS_HIST} AND IdListaPrecios = ${LISTA_PRECIOS_VENTA}`),
    // Sin filtro de Activo: un producto dado de baja igual tuvo precio en el mes.
    query(`SELECT IdProducto, NombreProducto FROM Productos`),
  ]);

  const nombres = new Map(prods.map(p => [String(p.IdProducto).trim(), String(p.NombreProducto || '').trim()]));
  return preciosHistorico.armarGrilla({
    anio, mes, nombres,
    baseline: baseline.map(r => ({ plu: String(r.IdProducto).trim(), precio: r.Precio })),
    cambios: cambios.map(r => ({ plu: String(r.IdProducto).trim(), dia: r.Dia, precio: r.Precio })),
    vigentes: vigentes.map(r => ({ plu: String(r.IdProducto).trim(), precio: r.Precio })),
    hoy: new Date().toISOString().slice(0, 10),
  });
}

app.get('/api/precios-historico', apiRoute(async req => grillaPreciosHistorico(req.query.anio, req.query.mes)));

app.get('/api/precios-historico/xlsx', async (req, res) => {
  try {
    const grilla = await grillaPreciosHistorico(req.query.anio, req.query.mes);
    // Layout fijo pedido por quien consume la planilla: A=PLU, B=producto, C y D
    // vacías, precios de E a AJ. El detalle vive en precios_historico.hojaMatriz.
    const ws = XLSX.utils.aoa_to_sheet(preciosHistorico.hojaMatriz(grilla));
    ws['!cols'] = preciosHistorico.anchosHoja();
    // Sin panel congelado: xlsx (community) ignora '!freeze' al escribir, así que no se
    // deja código muerto pretendiendo que lo hace.
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, grilla.periodo.slice(0, 31));
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${preciosHistorico.nombreArchivo(grilla)}"`);
    res.send(buffer);
  } catch (err) { console.error(err.message); res.status(500).json({ error: err.message }); }
});

// ── RRHH · Relevamiento de ropa de trabajo ─────────────────────────────────────
// Un único JSON con el catálogo de prendas y la ficha de cada empleado. Toda
// escritura pasa por rrhh_ropa.normalizarDocumento (trust boundary) antes de
// persistir, así el archivo nunca queda con empleados desalineados del catálogo.
const RRHH_ROPA_PATH = path.join(DATA_DIR, 'relevamientoRopa', 'relevamiento_ropa.json');

function leerRopa() {
  return rrhhRopa.normalizarDocumento(leerJSON(RRHH_ROPA_PATH, { prendas: [], empleados: [] }));
}
function guardarRopa(doc) {
  const limpio = rrhhRopa.normalizarDocumento(doc);
  fs.mkdirSync(path.dirname(RRHH_ROPA_PATH), { recursive: true });
  guardarJSON(RRHH_ROPA_PATH, limpio);
  return limpio;
}
// El front siempre recibe el documento completo + su resumen: es chico (decenas
// de empleados) y así no hay que reconciliar estado parcial después de cada ABM.
function conResumen(doc) {
  return { ...doc, resumen: rrhhRopa.resumen(doc) };
}
// Lo que tira el módulo puro son errores de validación del input → 400, no 500.
function rutaRopa(fn) {
  return (req, res) => {
    try { res.json(conResumen(fn(req))); }
    catch (err) { console.error(err.message); res.status(400).json({ error: err.message }); }
  };
}
function buscarIndice(lista, id, queEs) {
  const i = lista.findIndex(x => x.id === id);
  if (i < 0) throw new Error(`No existe ${queEs} con id "${id}".`);
  return i;
}

app.get('/api/rrhh/ropa', rutaRopa(() => leerRopa()));

app.post('/api/rrhh/ropa/empleados', rutaRopa(req => {
  const doc = leerRopa();
  const nuevo = rrhhRopa.normalizarEmpleado(req.body || {}, doc.prendas);
  nuevo.id = rrhhRopa.siguienteIdEmpleado(doc.empleados);
  return guardarRopa({ ...doc, empleados: [...doc.empleados, nuevo] });
}));

app.put('/api/rrhh/ropa/empleados/:id', rutaRopa(req => {
  const doc = leerRopa();
  const i = buscarIndice(doc.empleados, req.params.id, 'el empleado');
  const editado = { ...rrhhRopa.normalizarEmpleado(req.body || {}, doc.prendas), id: doc.empleados[i].id };
  return guardarRopa({ ...doc, empleados: doc.empleados.map((e, j) => (j === i ? editado : e)) });
}));

app.delete('/api/rrhh/ropa/empleados/:id', rutaRopa(req => {
  const doc = leerRopa();
  buscarIndice(doc.empleados, req.params.id, 'el empleado');
  return guardarRopa({ ...doc, empleados: doc.empleados.filter(e => e.id !== req.params.id) });
}));

app.post('/api/rrhh/ropa/prendas', rutaRopa(req => {
  const doc = leerRopa();
  const nueva = rrhhRopa.normalizarPrenda({ nombre: (req.body || {}).nombre }, doc.prendas.map(p => p.id));
  // normalizarDocumento le agrega la prenda vacía a cada empleado.
  return guardarRopa({ ...doc, prendas: [...doc.prendas, nueva] });
}));

app.put('/api/rrhh/ropa/prendas/:id', rutaRopa(req => {
  const doc = leerRopa();
  const i = buscarIndice(doc.prendas, req.params.id, 'la prenda');
  // Sólo se renombra: cambiar el id dejaría huérfanas las fichas de los empleados.
  const editada = rrhhRopa.normalizarPrenda({ id: doc.prendas[i].id, nombre: (req.body || {}).nombre });
  return guardarRopa({ ...doc, prendas: doc.prendas.map((p, j) => (j === i ? editada : p)) });
}));

app.delete('/api/rrhh/ropa/prendas/:id', rutaRopa(req => {
  const doc = leerRopa();
  buscarIndice(doc.prendas, req.params.id, 'la prenda');
  return guardarRopa({ ...doc, prendas: doc.prendas.filter(p => p.id !== req.params.id) });
}));

// ── Inicio ─────────────────────────────────────────────────────────────────────
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
