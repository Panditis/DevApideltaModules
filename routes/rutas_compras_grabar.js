'use strict';
const express = require('express');

// ── Grabación de compras en SIGA ─────────────────────────────────────────────
// Plomería nada más: esto conecta el router al resto del sistema (deps.getPool,
// deps.sql, deps.comprasImport, y armarVistaCompra/resolverProductosCompra/
// usuarioCompras que vienen del módulo Compras, rutas_compras.js) para que la
// transacción real de 12 tablas se pueda escribir acá después sin tener que
// reconectar nada. Esa lógica de negocio es harina de otra tarea — hoy no hay
// ninguna ruta real, sólo un placeholder para confirmar que el archivo se monta.
module.exports = function crearRutasComprasGrabar(deps) {
  const { apiRoute, getPool, sql, comprasImport, armarVistaCompra, resolverProductosCompra, usuarioCompras } = deps;
  const router = express.Router();

  router.get('/api/compras/grabar/_status', apiRoute(async () => ({ ok: true })));

  return router;
};
