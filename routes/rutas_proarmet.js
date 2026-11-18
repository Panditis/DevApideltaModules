'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ubic = require('../lib/proarmet_ubicaciones');
const { cfgProarmet, buscarDeposito, validarMovimiento, chequearLineas, historialMovimientos, nombreUsuario } = require('../lib/proarmet');
const { SQL_USUARIOS } = require('./rutas_tickets');

const USUARIOS_TTL_MS = 5 * 60 * 1000;

// ── Depósito Proarmet ─────────────────────────────────────────────────────────
// Stock del depósito Proarmet y traslados entre depósitos elegidos de la misma sucursal.
// Config en config.json "proarmet" (se relee en cada request). idDeposito puede ser el número o
// el nombre del depósito en SucursalesDepositos; el central default es reserva.depositoPrincipal.
module.exports = function crearRutasProarmet(deps) {
  const {
    apiRoute, query, depositosActivos, cfgReserva, getPoolStock,
    trasladarStock, ejecutarYRegistrar, conLogError, TIPOS_MOVIMIENTO_STOCK_PERMITIDOS, leerMovLog, USUARIO_MOV_MAX = 10,
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

  // ponytail: caché 5 min como tickets (misma query); si SIGA falla se sirve la vieja; sin caché, error (500 vía apiRoute).
  let cacheUsuarios = null; // { lista, ts }
  async function usuariosActivos() {
    if (cacheUsuarios && Date.now() - cacheUsuarios.ts < USUARIOS_TTL_MS) return cacheUsuarios.lista;
    try {
      const lista = (await query(SQL_USUARIOS) || [])
        .map(f => ({ id: String(f.Id ?? '').trim(), nombre: String(f.Nombre || '').trim() }))
        .filter(u => u.id)
        .map(u => ({ id: u.id, nombre: u.nombre || u.id }));
      cacheUsuarios = { lista, ts: Date.now() };
      return lista;
    } catch (e) {
      console.error('[proarmet] usuarios SIGA:', e);
      if (cacheUsuarios) return cacheUsuarios.lista;
      throw new Error('No se pudieron leer los usuarios de SIGA.');
    }
  }

  router.get('/deposito-proarmet', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'deposito_proarmet.html')));

  router.get('/api/proarmet/depositos', apiRoute(async () => {
    const ctx = await contexto();
    return { idSucursal: ctx.c.idSucursal, tipoMovimiento: ctx.c.idTipoMovimiento, depositos: ctx.depositos, defaultControlado: ctx.defaultControlado, defaultCentral: ctx.defaultCentral };
  }));

  router.get('/api/proarmet/usuarios', apiRoute(async () => ({ usuarios: await usuariosActivos() })));

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

  router.get('/api/proarmet/movimientos', apiRoute(async req => {
    const ctx = await contexto();
    const pedido = req.query.idDeposito;
    const tieneParam = pedido !== undefined && pedido !== '';
    const idDep = tieneParam ? depValido(ctx, pedido) : ctx.defaultControlado;
    if (tieneParam && idDep === null) return { error: `El depósito ${pedido} no está activo en la sucursal ${ctx.c.idSucursal}` };
    if (idDep === null) return { movimientos: [] };
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 500);
    const nombres = new Map(ctx.depositos.map(d => [d.idDeposito, d.nombre]));
    const movimientos = historialMovimientos(leerMovLog(), { idSucursal: ctx.c.idSucursal, idDeposito: idDep, limit, nombres });
    // El log de Proarmet guarda nombre null: una sola query IN completa las descripciones (PLUs saneados).
    const faltan = [...new Set(movimientos.flatMap(m => m.lineas).filter(l => l.descripcion == null).map(l => l.idProducto))]
      .filter(id => /^[A-Za-z0-9_-]+$/.test(id));
    if (!faltan.length) return { movimientos };
    const filas = await query(`SELECT RTRIM(IdProducto) AS idProducto, RTRIM(NombreProducto) AS descripcion FROM Productos WHERE IdProducto IN (${faltan.map(id => `'${id}'`).join(',')})`);
    const desc = new Map(filas.map(f => [String(f.idProducto).trim(), f.descripcion]));
    return { movimientos: movimientos.map(m => ({ ...m, lineas: m.lineas.map(l => (l.descripcion == null ? { ...l, descripcion: desc.get(l.idProducto) ?? null } : l)) })) };
  }));

  router.post('/api/proarmet/movimiento', apiRoute(async req => {
    const ctx = await contexto();
    const v = validarMovimiento(req.body, ctx.depositos.map(d => d.idDeposito));
    if (v.error) return v;
    const usuario = nombreUsuario(await usuariosActivos(), req.body && req.body.idUsuario, USUARIO_MOV_MAX);
    if (!usuario) return { error: 'Elegí el usuario responsable' };
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
      usuario, observacion: v.descripcion, idEmpleado: cr.idEmpleado,
    };
    const poolW = await getPoolStock();
    const res = await ejecutarYRegistrar({
      origen: 'traslado', plan: null, itemId: null, ...mov,
      lineas: v.lineas.map(l => ({ plu: l.idProducto, nombre: null, cantidad: l.cantidad })),
    }, () => trasladarStock(poolW, { ...mov, lineas: v.lineas }));
    return conLogError({ ok: true, numeroMovimiento: res.numeroMovimiento, idRegistro: res.idRegistro }, res.logError);
  }));

  // ── Ubicaciones (secciones físicas del depósito) ─ persistencia propia en JSON, no toca SIGA.
  const UBIC_PATH = path.join(deps.DATA_DIR || path.join(__dirname, '..', 'data'), 'proarmet_ubicaciones.json');
  const stockDeposito = (suc, dep, filtro = '') => query(`SELECT RTRIM(pd.IdProducto) AS idProducto, RTRIM(p.NombreProducto) AS descripcion, SUM(pd.Stock) AS stock
      FROM ProductosDepositos pd INNER JOIN Productos p ON p.IdProducto = pd.IdProducto
      WHERE pd.IdSucursal = ${suc} AND pd.IdDeposito = ${dep}${filtro}
      GROUP BY pd.IdProducto, p.NombreProducto`);

  router.get('/api/proarmet/ubicaciones', apiRoute(async req => {
    const ctx = await contexto();
    const pedido = req.query.idDeposito;
    const tieneParam = pedido !== undefined && pedido !== '';
    const idDep = tieneParam ? depValido(ctx, pedido) : ctx.defaultControlado;
    if (tieneParam && idDep === null) return { error: `El depósito ${pedido} no está activo en la sucursal ${ctx.c.idSucursal}` };
    if (idDep === null) return { ubicaciones: [], sinUbicar: [] };
    const datos = await ubic.leer(UBIC_PATH);
    const stock = await stockDeposito(ctx.c.idSucursal, idDep);
    const conStock = new Set(stock.map(s => String(s.idProducto).trim()));
    const faltan = ubic.idsAsignados(datos, idDep).filter(id => !conStock.has(id) && ubic.PLU_RE.test(id));
    const filas = faltan.length
      ? await query(`SELECT RTRIM(IdProducto) AS idProducto, RTRIM(NombreProducto) AS descripcion FROM Productos WHERE IdProducto IN (${faltan.map(id => `'${id}'`).join(',')})`)
      : [];
    return ubic.vista(datos, idDep, stock, new Map(filas.map(f => [String(f.idProducto).trim(), f.descripcion])));
  }));

  router.post('/api/proarmet/ubicacion', apiRoute(async req => {
    const ctx = await contexto();
    const idDep = depValido(ctx, req.body && req.body.idDeposito);
    if (idDep === null) return { error: `idDeposito debe ser un depósito activo de la sucursal ${ctx.c.idSucursal}` };
    const id = crypto.randomUUID();
    const r = await ubic.modificar(UBIC_PATH, d => ubic.crear(d, idDep, req.body, id, new Date().toISOString()));
    return r.error ? { error: r.error } : { ok: true, id };
  }));

  router.put('/api/proarmet/ubicacion/:id', apiRoute(async req => {
    const r = await ubic.modificar(UBIC_PATH, d => ubic.editar(d, req.params.id, req.body));
    return r.error ? { error: r.error } : { ok: true };
  }));

  router.delete('/api/proarmet/ubicacion/:id', apiRoute(async req => {
    const r = await ubic.modificar(UBIC_PATH, d => ubic.borrar(d, req.params.id, req.query.forzar === '1'));
    return r.error ? { error: r.error } : { ok: true };
  }));

  router.put('/api/proarmet/ubicacion/:id/producto', apiRoute(async req => {
    const v = ubic.validarAsignacion(req.body);
    if (v.error) return v;
    const u = (await ubic.leer(UBIC_PATH)).ubicaciones.find(x => x.id === req.params.id);
    if (!u) return { error: 'La ubicación no existe' };
    const ctx = await contexto();
    if (depValido(ctx, u.idDeposito) === null) return { error: `El depósito ${u.idDeposito} de la ubicación ya no está activo` };
    let stock = 0;
    if (v.cantidad > 0) {
      const filas = await stockDeposito(ctx.c.idSucursal, u.idDeposito, ` AND pd.IdProducto = '${v.idProducto}'`);
      stock = filas.length ? Number(filas[0].stock) || 0 : 0;
    }
    // ponytail: stock leído fuera de la cola; el chequeo de suma sí corre dentro (sin carreras entre asignaciones).
    const r = await ubic.modificar(UBIC_PATH, d => ubic.asignar(d, req.params.id, v.idProducto, v.cantidad, stock));
    return r.error ? { error: r.error } : { ok: true, disponible: r.disponible };
  }));

  return router;
};
