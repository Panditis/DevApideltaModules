'use strict';
const express = require('express');
const path = require('path');
const { armarCartel } = require('../lib/carteles_pesables');

// ── Rutas del módulo Carteles Pesables ────────────────────────────────────────
// Página que arma e imprime los carteles de precio de los pesables fraccionados de una
// sucursal (réplica de la planilla Excel). SIGA se consulta sólo de lectura: es la misma
// consulta del Power Query original y el cálculo del precio de la bolsa vive en
// lib/carteles_pesables.js. Nada se guarda: la selección de carteles vive en el navegador.
module.exports = function crearRutasCartelesPesables(deps) {
  const { apiRoute, query, LISTA_PRECIOS_VENTA } = deps;
  const router = express.Router();

  router.get('/carteles-pesables', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'carteles_pesables.html')));

  // Rubro de SIGA por tipo de cartel. Lista cerrada: el rubro va al SQL sólo desde acá, nunca del cliente.
  const RUBRO_POR_TIPO = Object.freeze({ pesables: 'Pesables Fraccionado', almacen: 'Almacen' });

  // query() no admite parámetros: la sucursal va al SQL sólo después de validarla como entero positivo.
  function validarSucursal(req, res, next) {
    const texto = String(req.query.idSucursal ?? '').trim();
    const id = Number(texto);
    if (!/^\d+$/.test(texto) || !Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'idSucursal tiene que ser un entero positivo.' });
    }
    req.idSucursal = id;
    const tipo = String(req.query.tipo ?? 'pesables');
    if (!Object.hasOwn(RUBRO_POR_TIPO, tipo)) return res.status(400).json({ error: 'tipo tiene que ser pesables o almacen.' });
    req.tipo = tipo;
    return next();
  }

  // IdProducto es varchar en SIGA: se compara y devuelve como texto, sin castear.
  router.get('/api/carteles-pesables', validarSucursal, apiRoute(async req => {
    const filas = await query(`
      SELECT p.IdProducto, p.NombreProducto, p.CodigoDeBarras, ps.Stock,
             psp.PrecioVenta, psp.FechaActualizacion
        FROM ProductosSucursales ps
        JOIN Productos p ON p.IdProducto = ps.IdProducto
        JOIN Rubros r ON r.IdRubro = p.IdRubro
        JOIN ProductosSucursalesPrecios psp
          ON psp.IdProducto = ps.IdProducto AND psp.IdSucursal = ps.IdSucursal
         AND psp.IdListaPrecios = ${Number(LISTA_PRECIOS_VENTA)}
       WHERE p.Activo = 1
         AND ps.IdSucursal = ${req.idSucursal}
         AND r.NombreRubro = '${RUBRO_POR_TIPO[req.tipo]}'
         AND ps.Stock > -10000
       ORDER BY p.NombreProducto`);
    return filas.map(f => armarCartel(f, req.tipo));
  }));

  return router;
};
