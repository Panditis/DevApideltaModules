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
      AND UPPER(ISNULL(cat.NombreCategoria,'')) != 'SUCURSAL'
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
  return `SELECT TOP ${topN} vp.IdProducto AS IdProducto, p.NombreProducto AS Nombre,
      SUM(vp.Cantidad) AS Unidades, SUM(vp.ImporteTotalNeto) AS Facturacion
    FROM VentasProductos vp
    ${JOIN_CLAVE5}
    ${JOIN_CLIENTE_CAT}
    INNER JOIN Productos p ON p.IdProducto = vp.IdProducto
    WHERE ${whereVentas(p)}
    GROUP BY vp.IdProducto, p.NombreProducto
    ORDER BY ${col} DESC`;
}

// ── Artículos por ticket ─────────────────────────────────────────────────────
// "Artículos" = renglones (líneas) del comprobante: cuántos ítems distintos se
// llevó cada cliente. Se cuenta agrupando VentasProductos por la clave de 5
// columnas del comprobante (mismo criterio que el JOIN cabecera→renglón).
const GROUP_TICKET = `vp.IdSucursal, vp.IdTipoComprobante, vp.Letra, vp.CentroEmisor, vp.NumeroComprobante`;

// Histograma: para cada N (cantidad de artículos del ticket), cuántos tickets tuvieron ese N.
function sqlArticulosHistograma(p) {
  return `SELECT t.Articulos AS Articulos, COUNT(*) AS Tickets FROM (
      SELECT COUNT(*) AS Articulos
      FROM VentasProductos vp
      ${JOIN_CLAVE5}
      ${JOIN_CLIENTE_CAT}
      WHERE ${whereVentas(p)}
      GROUP BY ${GROUP_TICKET}
    ) t
    GROUP BY t.Articulos
    ORDER BY t.Articulos`;
}

// Promedio de artículos por ticket, por sucursal.
function sqlArticulosPorSucursal(p) {
  return `SELECT t.IdSucursal AS IdSucursal, s.Nombre AS Nombre,
      COUNT(*) AS Tickets, SUM(t.Articulos) AS Articulos,
      CAST(SUM(t.Articulos) AS FLOAT) / COUNT(*) AS Promedio
    FROM (
      SELECT vp.IdSucursal AS IdSucursal, COUNT(*) AS Articulos
      FROM VentasProductos vp
      ${JOIN_CLAVE5}
      ${JOIN_CLIENTE_CAT}
      WHERE ${whereVentas(p)}
      GROUP BY ${GROUP_TICKET}
    ) t
    LEFT JOIN Sucursales s ON s.IdSucursal = t.IdSucursal
    GROUP BY t.IdSucursal, s.Nombre
    ORDER BY Promedio DESC`;
}

// Buckets fijos para el histograma. Los N chicos (1..5) van sueltos y el resto se
// agrupa para que la barra de "carritos grandes" no quede pulverizada en la cola.
const BUCKETS_ARTICULOS = [
  { label: '1', min: 1, max: 1 },
  { label: '2', min: 2, max: 2 },
  { label: '3', min: 3, max: 3 },
  { label: '4', min: 4, max: 4 },
  { label: '5', min: 5, max: 5 },
  { label: '6-10', min: 6, max: 10 },
  { label: '11+', min: 11, max: Infinity },
];

// Colapsa el histograma exacto (filas {Articulos, Tickets}) en los buckets fijos.
function bucketsArticulos(histRows) {
  return BUCKETS_ARTICULOS.map(b => {
    const tickets = (histRows || []).reduce((a, r) => {
      const n = Number(r.Articulos || 0);
      return n >= b.min && n <= b.max ? a + Number(r.Tickets || 0) : a;
    }, 0);
    return { label: b.label, tickets };
  });
}

// Promedio global de artículos/ticket a partir del desglose por sucursal.
function promedioArticulos(porSucursal) {
  const tickets   = (porSucursal || []).reduce((a, r) => a + Number(r.Tickets || 0), 0);
  const articulos = (porSucursal || []).reduce((a, r) => a + Number(r.Articulos || 0), 0);
  return tickets > 0 ? articulos / tickets : 0;
}

module.exports = {
  SUCURSALES_ANALISIS, NOMBRE_DIA, TOP_N_DEFAULT, BUCKETS_ARTICULOS,
  sucIdsSeguras, clampTopN, ticketProm, mapDiaSemana, kpisGlobales,
  whereVentas, sqlComparativa, sqlResumenRenglon,
  sqlTendencia, sqlDiaSemana, sqlHora, sqlTopProductos,
  sqlArticulosHistograma, sqlArticulosPorSucursal, bucketsArticulos, promedioArticulos,
};
