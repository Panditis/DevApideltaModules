'use strict';
const express = require('express');
const path = require('path');

// ── Rutas del módulo Precios (costeo sugerido) ───────────────────────────────
// Fase 0: sólo esqueleto. La pantalla y el endpoint de config general, sin
// lógica de cálculo — eso llega en fases posteriores con lib/precios_costeo.js.
//
// data/costeo.json ya nace con el schema completo (bandasMarkup, recetas,
// insumosPorProducto, etc.) para que las fases siguientes no tengan que migrar
// el archivo, pero /api/precios/config expone sólo costoHora y toleranciaPct:
// el resto no tiene todavía lógica que lo use ni UI que lo edite.
//
// query, guardarJSON y LISTA_PRECIOS_VENTA no se usan en esta fase (no hay
// listado/detalle ni escritura de config todavía) pero ya viajan por deps
// porque las fases siguientes los necesitan: evita tener que tocar el
// registro en server.js de nuevo por cada fase.
module.exports = function crearRutasPrecios(deps) {
  const { apiRoute, leerJSON, DATA_DIR } = deps;
  const router = express.Router();

  const COSTEO_PATH = path.join(DATA_DIR, 'costeo.json');
  const COSTEO_DEFAULT = { costoHora: 4500, toleranciaPct: 10 };

  router.get('/precios', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'precios.html')));

  router.get('/api/precios/config', apiRoute(async () => {
    const costeo = leerJSON(COSTEO_PATH, COSTEO_DEFAULT);
    return { costoHora: costeo.costoHora, toleranciaPct: costeo.toleranciaPct };
  }));

  return router;
};
