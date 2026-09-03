'use strict';
const express = require('express');
const path = require('path');
const cuentasCorrientes = require('./cuentas_corrientes');

// ── Rutas del módulo Cuentas Corrientes ───────────────────────────────────────
// Saldo vivo por cliente + detalle de comprobantes, contra SIGA. Es un módulo
// propio en data/modulos.json, con su página y su permiso. Extraídas de server.js
// sin cambios de comportamiento: mismas rutas y mismas queries. El bloque movido
// conserva la indentación original a propósito.
//
// cuentas_corrientes.js es lógica pura sin estado: se requiere directo. Sólo
// entran por deps apiRoute y query.
//
// El grupo con el que venía este router traía además cuatro prefijos que NO son
// de este módulo y se quedan en server.js:
//   · /api/clientes y /api/localidades — son dos de las cinco rutas del bloque
//     "Rutas API pedidos" (getClientes/getLocalidades sobre params(req)).
//   · /api/clientes-registro — data/clientes.json, el registro de nombres que
//     usa planificacion.html; es el mismo patrón que envases y tapas registro.
//   · /api/sucursales — la lista de SIGA que alimenta sucursalesSiga y
//     resolverSucursal, que es infraestructura de stock y reservas y ya viaja
//     por deps a rutas_mayoristas.
module.exports = function crearRutasCuentasCorrientes(deps) {
  const { apiRoute, query } = deps;
  const router = express.Router();

router.get('/cuentas-corrientes', (_req, res) => res.sendFile(path.join(__dirname, 'cuentas_corrientes.html')));

// ── Cuentas Corrientes de Clientes ───────────────────────────────────────────
// Saldo vivo por cliente + detalle de comprobantes. Clientes.SaldoPendiente está
// en 0 en toda la base, así que el saldo se recalcula sumando CuentasCorrientes.
router.get('/api/cuentas-corrientes', apiRoute(async req => {
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

  return router;
};
