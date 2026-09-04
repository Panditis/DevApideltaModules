'use strict';
const express = require('express');
const preciosFacturador = require('./precios_facturador');

// ── Rutas del Facturador auxiliar ─────────────────────────────────────────────
// Extraídas de server.js sin cambios de comportamiento: mismas rutas y mismas
// queries. El bloque quedó separado en dos tramos en server.js porque
// LISTA_PRECIOS_VENTA y PRECIOS_FACTURADOR_DIR estaban físicamente en medio,
// igual que ya le pasó al cotizador (ver rutas_cotizador.js): esas dos
// constantes no son del facturador, las comparte con otros módulos, así que se
// quedan en server.js con su comentario donde estaban y entran por deps.
// precios_facturador.js es lógica pura sin estado: se requiere directo. PORT
// también entra por deps: sólo lo usa /api/facturador/catalogo para el campo
// "origen" de diagnóstico.
module.exports = function crearRutasFacturador(deps) {
  const { apiRoute, query, LISTA_PRECIOS_VENTA, PRECIOS_FACTURADOR_DIR, PORT } = deps;
  const router = express.Router();

// ── Facturador auxiliar (HTML suelto) ──────────────────────────────────────────
// Catálogo plano de precios para el facturador que corre como archivo local. No lleva
// sesión a propósito: el HTML se abre con file:// y no puede loguearse. El guard de IP
// de LAN (más arriba) ya limita quién llega hasta acá.
router.get('/api/facturador/catalogo', apiRoute(async req => {
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

router.get('/api/facturador/catalogo-archivo', apiRoute(async () =>
  preciosFacturador.catalogoDeDirectorio(PRECIOS_FACTURADOR_DIR)));

  return router;
};
