'use strict';
const express = require('express');
const path = require('path');

// ── Rutas del Dashboard Ventas por Hora ───────────────────────────────────────
// Módulo propio en data/modulos.json ("ventas-hora", hoy con activo:false), con
// su página y su permiso. Son dos consultas crudas a Ventas —el total y los
// tickets por hora y sucursal, y la lista de sucursales con ventas— sin una sola
// función de analisis_ventas.js: por eso no viajó con el router de análisis.
//
// Extraídas de server.js sin cambios de comportamiento: mismas rutas, mismo orden
// relativo y mismas queries. El bloque movido conserva la indentación original a
// propósito: reindentar cambiaría el texto de los SQL multilínea, que son
// template literals.
//
// No se mudó ningún helper ni constante: el bloque no tenía.
module.exports = function crearRutasVentasHora(deps) {
  const { apiRoute, query, safeDate } = deps;
  const router = express.Router();

// ── Dashboard Ventas por Hora ──────────────────────────────────────────────────
router.get('/ventas-hora', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'ventas_hora.html')));

router.get('/api/ventas-hora', apiRoute(async req => {
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

router.get('/api/ventas-hora/sucursales', apiRoute(async () => {
  return query(`
    SELECT DISTINCT v.IdSucursal, s.Nombre AS NombreSucursal
    FROM Ventas v
    LEFT JOIN Sucursales s ON s.IdSucursal = v.IdSucursal
    WHERE s.Nombre IS NOT NULL
    ORDER BY v.IdSucursal
  `);
}));

  return router;
};
