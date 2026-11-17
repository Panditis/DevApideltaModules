'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const { cfgProarmet, buscarDeposito, validarMovimiento, chequearLineas } = require('../lib/proarmet');

// ── Depósito Proarmet ─────────────────────────────────────────────────────────
// Stock del depósito Proarmet y traslados internos casa central <-> Proarmet (misma sucursal).
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

  // Resuelve ambos depósitos contra SIGA. Devuelve { c, deposito, central } o { error }.
  async function resolver() {
    const c = leerCfg();
    const deps = await depositosActivos(c.idSucursal);
    const dep = buscarDeposito(deps, c.idDeposito);
    const cen = buscarDeposito(deps, c.idDepositoCentral);
    if (!dep) return { error: `No encontré el depósito Proarmet ("${c.idDeposito}") activo en la sucursal ${c.idSucursal}. Configurá proarmet.idDeposito en config.json.` };
    if (!cen) return { error: `No encontré el depósito central ${c.idDepositoCentral} activo en la sucursal ${c.idSucursal}.` };
    if (Number(dep.IdDeposito) === Number(cen.IdDeposito)) return { error: 'El depósito Proarmet y el central no pueden ser el mismo' };
    const forma = d => ({ idSucursal: c.idSucursal, idDeposito: Number(d.IdDeposito), nombre: String(d.NombreDeposito || '').trim() });
    return { c, deposito: forma(dep), central: forma(cen) };
  }

  router.get('/deposito-proarmet', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'deposito_proarmet.html')));

  router.get('/api/proarmet/stock', apiRoute(async () => {
    const r = await resolver();
    if (r.error) return r;
    const productos = await query(`SELECT RTRIM(pd.IdProducto) AS idProducto, RTRIM(p.NombreProducto) AS descripcion, SUM(pd.Stock) AS stock
      FROM ProductosDepositos pd INNER JOIN Productos p ON p.IdProducto = pd.IdProducto
      WHERE pd.IdSucursal = ${r.deposito.idSucursal} AND pd.IdDeposito = ${r.deposito.idDeposito}
      GROUP BY pd.IdProducto, p.NombreProducto HAVING SUM(pd.Stock) <> 0
      ORDER BY p.NombreProducto`);
    return { deposito: r.deposito, central: r.central, tipoMovimiento: r.c.idTipoMovimiento, productos };
  }));

  // ponytail: ids enteros ya validados por resolver(); interpolados como el resto del repo (query() no recibe params).
  const sqlProductos = (r, filtroIds) => `SELECT RTRIM(p.IdProducto) AS idProducto, RTRIM(p.NombreProducto) AS descripcion, p.Activo AS activo,
      COALESCE((SELECT SUM(pd.Stock) FROM ProductosDepositos pd WHERE pd.IdProducto = p.IdProducto AND pd.IdSucursal = ${r.central.idSucursal} AND pd.IdDeposito = ${r.central.idDeposito}), 0) AS stockCentral,
      COALESCE((SELECT SUM(pd.Stock) FROM ProductosDepositos pd WHERE pd.IdProducto = p.IdProducto AND pd.IdSucursal = ${r.deposito.idSucursal} AND pd.IdDeposito = ${r.deposito.idDeposito}), 0) AS stockDeposito
    FROM Productos p WHERE ${filtroIds} ORDER BY p.NombreProducto`;

  router.get('/api/proarmet/productos', apiRoute(async () => {
    const r = await resolver();
    if (r.error) return r;
    const filas = await query(sqlProductos(r, 'p.Activo = 1'));
    return { productos: filas.map(f => ({ idProducto: f.idProducto, descripcion: f.descripcion, stockCentral: Number(f.stockCentral), stockDeposito: Number(f.stockDeposito) })) };
  }));

  router.post('/api/proarmet/movimiento', apiRoute(async req => {
    const v = validarMovimiento(req.body);
    if (v.error) return v;
    const r = await resolver();
    if (r.error) return r;
    const idTipoMovimiento = r.c.idTipoMovimiento;
    if (!TIPOS_MOVIMIENTO_STOCK_PERMITIDOS.includes(idTipoMovimiento)) {
      return { error: `proarmet.idTipoMovimiento inválido. Permitidos: ${TIPOS_MOVIMIENTO_STOCK_PERMITIDOS.join(', ')}` };
    }
    // PLUs saneados (solo alfanuméricos) antes de interpolarlos en el IN.
    const ids = v.lineas.map(l => l.idProducto);
    if (ids.some(id => !/^[A-Za-z0-9_-]+$/.test(id))) return { error: 'idProducto con caracteres inválidos' };
    const filas = await query(sqlProductos(r, `p.IdProducto IN (${ids.map(id => `'${id}'`).join(',')})`));
    const productos = new Map(filas.map(f => [String(f.idProducto).trim(), { activo: !!f.activo, stockDeposito: Number(f.stockDeposito) }]));
    const err = chequearLineas(v.sentido, v.lineas, productos);
    if (err) return { error: err };

    const cr = cfgReserva();
    const [depOrigen, depDestino] = v.sentido === 'ida'
      ? [r.central.idDeposito, r.deposito.idDeposito]
      : [r.deposito.idDeposito, r.central.idDeposito];
    const mov = {
      idSucursal: r.c.idSucursal, depOrigen, depDestino, idTipoMovimiento,
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
