'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const { cfgProarmet, buscarDeposito, validarMovimiento, chequearLineas } = require('../lib/proarmet');

// ── Depósito Proarmet ─────────────────────────────────────────────────────────
// Stock del depósito Proarmet y traslados entre depósitos elegidos de la misma sucursal.
// Config en config.json "proarmet" (se relee en cada request). idDeposito puede ser el número o
// el nombre del depósito en SucursalesDepositos; el central default es reserva.depositoPrincipal.
module.exports = function crearRutasProarmet(deps) {
  const {
    apiRoute, query, depositosActivos, cfgReserva, getPoolStock,
    trasladarStock, ejecutarYRegistrar, conLogError, TIPOS_MOVIMIENTO_STOCK_PERMITIDOS,
  } = deps;
  const router = express.Router();

  function leerCfg() {
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')).proarmet || {}; } catch { raw = {}; }
    return cfgProarmet(raw, cfgReserva().depositoPrincipal);
  }

  // Depósitos activos de la sucursal + defaults. Nunca falla por no resolver el Proarmet: default null.
  async function contexto() {
    const c = leerCfg();
    const lista = await depositosActivos(c.idSucursal);
    const id = d => (d ? Number(d.IdDeposito) : null);
    return {
      c, lista,
      depositos: lista.map(d => ({ idDeposito: Number(d.IdDeposito), nombre: String(d.NombreDeposito || '').trim() })),
      defaultControlado: id(buscarDeposito(lista, c.idDeposito)),
      defaultCentral: id(buscarDeposito(lista, c.idDepositoCentral)),
    };
  }

  // ponytail: id entero y perteneciente a depositosActivos -> seguro de interpolar (query() no recibe params).
  const depValido = (ctx, v) => {
    const n = Number(v);
    return Number.isInteger(n) && ctx.depositos.some(d => d.idDeposito === n) ? n : null;
  };

  router.get('/deposito-proarmet', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'deposito_proarmet.html')));

  router.get('/api/proarmet/depositos', apiRoute(async () => {
    const ctx = await contexto();
    return { idSucursal: ctx.c.idSucursal, tipoMovimiento: ctx.c.idTipoMovimiento, depositos: ctx.depositos, defaultControlado: ctx.defaultControlado, defaultCentral: ctx.defaultCentral };
  }));

  router.get('/api/proarmet/stock', apiRoute(async req => {
    const ctx = await contexto();
    const pedido = req.query.idDeposito;
    const tieneParam = pedido !== undefined && pedido !== '';
    const idDep = tieneParam ? depValido(ctx, pedido) : ctx.defaultControlado;
    if (tieneParam && idDep === null) return { error: `El depósito ${pedido} no está activo en la sucursal ${ctx.c.idSucursal}` };
    if (idDep === null) return { deposito: null, tipoMovimiento: ctx.c.idTipoMovimiento, productos: [] };
    const d = ctx.depositos.find(x => x.idDeposito === idDep);
    const productos = await query(`SELECT RTRIM(pd.IdProducto) AS idProducto, RTRIM(p.NombreProducto) AS descripcion, SUM(pd.Stock) AS stock
      FROM ProductosDepositos pd INNER JOIN Productos p ON p.IdProducto = pd.IdProducto
      WHERE pd.IdSucursal = ${ctx.c.idSucursal} AND pd.IdDeposito = ${idDep}
      GROUP BY pd.IdProducto, p.NombreProducto HAVING SUM(pd.Stock) <> 0
      ORDER BY p.NombreProducto`);
    return { deposito: { idSucursal: ctx.c.idSucursal, ...d }, tipoMovimiento: ctx.c.idTipoMovimiento, productos };
  }));

  const stockSub = (suc, dep) => `COALESCE((SELECT SUM(pd.Stock) FROM ProductosDepositos pd WHERE pd.IdProducto = p.IdProducto AND pd.IdSucursal = ${suc} AND pd.IdDeposito = ${dep}), 0)`;
  const sqlProductos = (suc, origen, destino, filtro) => `SELECT RTRIM(p.IdProducto) AS idProducto, RTRIM(p.NombreProducto) AS descripcion, p.Activo AS activo,
      ${stockSub(suc, origen)} AS stockOrigen, ${stockSub(suc, destino)} AS stockDestino
    FROM Productos p WHERE ${filtro} ORDER BY p.NombreProducto`;

  router.get('/api/proarmet/productos', apiRoute(async req => {
    const ctx = await contexto();
    const origen = depValido(ctx, req.query.origen), destino = depValido(ctx, req.query.destino);
    if (origen === null || destino === null) return { error: `origen y destino deben ser depósitos activos de la sucursal ${ctx.c.idSucursal}` };
    const filas = await query(sqlProductos(ctx.c.idSucursal, origen, destino, 'p.Activo = 1'));
    return { productos: filas.map(f => ({ idProducto: f.idProducto, descripcion: f.descripcion, stockOrigen: Number(f.stockOrigen), stockDestino: Number(f.stockDestino) })) };
  }));

  router.post('/api/proarmet/movimiento', apiRoute(async req => {
    const ctx = await contexto();
    const v = validarMovimiento(req.body, ctx.depositos.map(d => d.idDeposito));
    if (v.error) return v;
    const idTipoMovimiento = ctx.c.idTipoMovimiento;
    if (!TIPOS_MOVIMIENTO_STOCK_PERMITIDOS.includes(idTipoMovimiento)) {
      return { error: `proarmet.idTipoMovimiento inválido. Permitidos: ${TIPOS_MOVIMIENTO_STOCK_PERMITIDOS.join(', ')}` };
    }
    // PLUs saneados (solo alfanuméricos) antes de interpolarlos en el IN.
    const ids = v.lineas.map(l => l.idProducto);
    if (ids.some(id => !/^[A-Za-z0-9_-]+$/.test(id))) return { error: 'idProducto con caracteres inválidos' };
    const filas = await query(sqlProductos(ctx.c.idSucursal, v.depOrigen, v.depDestino, `p.IdProducto IN (${ids.map(id => `'${id}'`).join(',')})`));
    const productos = new Map(filas.map(f => [String(f.idProducto).trim(), { activo: !!f.activo, stockOrigen: Number(f.stockOrigen) }]));
    const err = chequearLineas(v.lineas, productos);
    if (err) return { error: err };

    const cr = cfgReserva();
    const mov = {
      idSucursal: ctx.c.idSucursal, depOrigen: v.depOrigen, depDestino: v.depDestino, idTipoMovimiento,
      usuario: cr.usuario, observacion: v.descripcion, idEmpleado: cr.idEmpleado,
    };
    const poolW = await getPoolStock();
    const res = await ejecutarYRegistrar({
      origen: 'traslado', plan: null, itemId: null, ...mov,
      lineas: v.lineas.map(l => ({ plu: l.idProducto, nombre: null, cantidad: l.cantidad })),
    }, () => trasladarStock(poolW, { ...mov, lineas: v.lineas }));
    return conLogError({ ok: true, numeroMovimiento: res.numeroMovimiento, idRegistro: res.idRegistro }, res.logError);
  }));

  return router;
};
