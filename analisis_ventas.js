'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Análisis de Ventas por Sucursal — módulo puro (sin I/O ni SQL exec)
//  Sanitización de params, builders de SQL y derivaciones de KPIs.
// ─────────────────────────────────────────────────────────────────────────────

// Sucursales en alcance (la central id=1 se excluye siempre).
const SUCURSALES_ANALISIS = [2, 3, 4, 5, 7, 9, 10];
const NOMBRE_DIA = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const TOP_N_DEFAULT = 20;

// Intersección de los ids pedidos con la whitelist. Vacío/ inválido -> whitelist completa.
function sucIdsSeguras(raw) {
  if (!raw) return [...SUCURSALES_ANALISIS];
  const pedidos = String(raw).split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isInteger(n));
  const filtradas = pedidos.filter(n => SUCURSALES_ANALISIS.includes(n));
  return filtradas.length ? filtradas : [...SUCURSALES_ANALISIS];
}

function clampTopN(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n)) return TOP_N_DEFAULT;
  return Math.min(100, Math.max(1, n));
}

function ticketProm(facturacion, tickets) {
  return tickets > 0 ? facturacion / tickets : 0;
}

function mapDiaSemana(dow) {
  return NOMBRE_DIA[dow] ?? String(dow);
}

function kpisGlobales(comparativa, resumen) {
  const facturacion = comparativa.reduce((a, r) => a + Number(r.Facturacion || 0), 0);
  const tickets     = comparativa.reduce((a, r) => a + Number(r.Tickets || 0), 0);
  return {
    facturacion,
    tickets,
    ticketProm: ticketProm(facturacion, tickets),
    unidades: Number(resumen?.Unidades || 0),
    productosDistintos: Number(resumen?.ProductosDistintos || 0),
  };
}

// Join cabecera→renglón por la clave compuesta de 5 columnas de SIGA.
const JOIN_CLAVE5 = `INNER JOIN Ventas v
    ON  v.IdSucursal=vp.IdSucursal AND v.IdTipoComprobante=vp.IdTipoComprobante
    AND v.Letra=vp.Letra AND v.CentroEmisor=vp.CentroEmisor
    AND v.NumeroComprobante=vp.NumeroComprobante`;

// Joins a Clientes/Categorias para excluir transferencias internas (categoría SUCURSAL).
const JOIN_CLIENTE_CAT = `LEFT JOIN Clientes c ON c.IdCliente = v.IdCliente
    LEFT JOIN Categorias cat ON cat.IdCategoria = c.IdCategoria`;

// Cláusula WHERE con los filtros comunes. desde/hasta/sucIdsCsv YA saneados por el endpoint.
function whereVentas({ desde, hasta, sucIdsCsv }) {
  return `v.Fecha >= '${desde} 00:00:00' AND v.Fecha <= '${hasta} 23:59:59'
      AND ISNULL(v.IdEstadoComprobante,'') != 'ANULADO'
      AND v.IdSucursal IN (${sucIdsCsv})
      AND ISNULL(cat.NombreCategoria,'') != 'SUCURSAL'
      AND v.ImporteTotal > 0`;
}

// KPIs + comparativa: nivel cabecera (Ventas), 1 fila por comprobante.
function sqlComparativa(p) {
  return `SELECT v.IdSucursal, s.Nombre AS Nombre,
      SUM(v.ImporteTotal) AS Facturacion, COUNT(*) AS Tickets
    FROM Ventas v
    LEFT JOIN Sucursales s ON s.IdSucursal = v.IdSucursal
    ${JOIN_CLIENTE_CAT}
    WHERE ${whereVentas(p)}
    GROUP BY v.IdSucursal, s.Nombre
    ORDER BY Facturacion DESC`;
}

// Totales de unidades y productos distintos: nivel renglón (VentasProductos).
function sqlResumenRenglon(p) {
  return `SELECT SUM(vp.Cantidad) AS Unidades, COUNT(DISTINCT vp.IdProducto) AS ProductosDistintos
    FROM VentasProductos vp
    ${JOIN_CLAVE5}
    ${JOIN_CLIENTE_CAT}
    WHERE ${whereVentas(p)}`;
}

function sqlTendencia(p) {
  return `SELECT CAST(v.Fecha AS DATE) AS Fecha,
      SUM(v.ImporteTotal) AS Facturacion, COUNT(*) AS Tickets
    FROM Ventas v
    ${JOIN_CLIENTE_CAT}
    WHERE ${whereVentas(p)}
    GROUP BY CAST(v.Fecha AS DATE)
    ORDER BY Fecha`;
}

function sqlDiaSemana(p) {
  return `SELECT (DATEPART(WEEKDAY, v.Fecha) + @@DATEFIRST - 2) % 7 AS Dow,
      SUM(v.ImporteTotal) AS Facturacion, COUNT(*) AS Tickets
    FROM Ventas v
    ${JOIN_CLIENTE_CAT}
    WHERE ${whereVentas(p)}
    GROUP BY (DATEPART(WEEKDAY, v.Fecha) + @@DATEFIRST - 2) % 7
    ORDER BY Dow`;
}

function sqlHora(p) {
  return `SELECT DATEPART(HOUR, v.Fecha) AS Hora,
      SUM(v.ImporteTotal) AS Facturacion, COUNT(*) AS Tickets
    FROM Ventas v
    ${JOIN_CLIENTE_CAT}
    WHERE ${whereVentas(p)}
    GROUP BY DATEPART(HOUR, v.Fecha)
    ORDER BY Hora`;
}

// Top productos por 'unidades' o 'facturacion'. topN ya clampeado a entero.
function sqlTopProductos(p, orden, topN) {
  const col = orden === 'unidades' ? 'Unidades' : 'Facturacion';
  return `SELECT TOP ${topN} vp.IdProducto AS IdProducto, p.Nombre AS Nombre,
      SUM(vp.Cantidad) AS Unidades, SUM(vp.ImporteTotalNeto) AS Facturacion
    FROM VentasProductos vp
    ${JOIN_CLAVE5}
    ${JOIN_CLIENTE_CAT}
    INNER JOIN Productos p ON p.IdProducto = vp.IdProducto
    WHERE ${whereVentas(p)}
    GROUP BY vp.IdProducto, p.Nombre
    ORDER BY ${col} DESC`;
}

module.exports = {
  SUCURSALES_ANALISIS, NOMBRE_DIA, TOP_N_DEFAULT,
  sucIdsSeguras, clampTopN, ticketProm, mapDiaSemana, kpisGlobales,
  whereVentas, sqlComparativa, sqlResumenRenglon,
  sqlTendencia, sqlDiaSemana, sqlHora, sqlTopProductos,
};
