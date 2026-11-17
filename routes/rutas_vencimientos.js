'use strict';
const express = require('express');
const path = require('path');
const { semaforo, diasParaVencer, pendiente, estadoSucursal, hoyLocal } = require('../lib/vencimientos');
const { esSucursalReal } = require('../lib/sucursales_no_reales');
const { cruzarLote, consultarMovimientos } = require('../lib/vencimientos_siga');

// ── Rutas del Control de vencimientos (Sucursales), Etapa 1 ───────────────────
// Listado compartido de lotes; cada usuario escribe solo en la columna de su sucursal
// (admin en cualquiera). El permiso 'sucursales' lo exige el guard por prefijo de lib/auth.js.
// SIGA se lee solo para buscar productos, con consulta parametrizada.
const SIN_SUCURSAL = 'Tu usuario no tiene sucursal asignada. Pedile al administrador que la configure.';
const ID_LOTE_RE = /^[0-9a-f-]{36}$/i;
const TOPE_PRODUCTOS = 30;

function httpError(status, mensaje) {
  return Object.assign(new Error(mensaje), { status });
}

function enteroPositivo(valor, campo) {
  const texto = String(valor ?? '').trim();
  const n = Number(texto);
  if (!/^\d+$/.test(texto) || !Number.isSafeInteger(n) || n <= 0) throw httpError(400, `${campo} tiene que ser un entero positivo.`);
  return n;
}

module.exports = function crearRutasVencimientos(deps) {
  const { store, idSucursalDe, getPool } = deps;
  const router = express.Router();

  // Igual que apiRoute pero respeta err.status; los 500 se loguean y no filtran detalles.
  const api = fn => async (req, res) => {
    try { res.json(await fn(req)); } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error('[vencimientos]', req.method, req.originalUrl, err);
      res.status(status).json({ error: status === 500 ? 'Error interno en control de vencimientos.' : err.message });
    }
  };

  const contexto = req => {
    const user = req.session && req.session.user;
    if (!user) throw httpError(401, 'Sesión requerida.');
    const idSucursal = idSucursalDe(user);
    return { user, esAdmin: !!user.esAdmin, idSucursal: idSucursal ? Number(idSucursal) : null };
  };

  // Sucursal sobre la que opera el pedido. No admin: siempre la propia; si manda otra, 403
  // cuando `rechazarAjena` (edición) o se ignora (alta).
  const sucursalObjetivo = (ctx, pedida, rechazarAjena) => {
    const hayPedida = pedida !== undefined && pedida !== null && pedida !== '';
    if (ctx.esAdmin && hayPedida) return enteroPositivo(pedida, 'idSucursal');
    if (!ctx.idSucursal) throw httpError(403, ctx.esAdmin ? 'Indicá idSucursal.' : SIN_SUCURSAL);
    if (rechazarAjena && hayPedida && Number(pedida) !== ctx.idSucursal) throw httpError(403, 'Solo podés modificar datos de tu sucursal.');
    return ctx.idSucursal;
  };

  const idLote = req => {
    if (!ID_LOTE_RE.test(req.params.id)) throw httpError(400, 'id de lote inválido.');
    return req.params.id;
  };

  const soloAdmin = ctx => { if (!ctx.esAdmin) throw httpError(403, 'Solo un administrador puede hacer esto.'); };

  router.get('/vencimientos', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'vencimientos.html')));
  router.get('/js/vencimientos.js', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'js', 'vencimientos.js')));

  router.get('/api/vencimientos/lotes', api(async req => {
    const ctx = contexto(req);
    const [lotes, { umbrales }] = await Promise.all([store.listarLotes(), store.leerConfig()]);
    const hoy = hoyLocal();
    const columnas = new Set();
    const filas = lotes.map(l => {
      const sucursales = {};
      for (const [suc, col] of Object.entries(l.sucursales)) {
        if (!esSucursalReal(suc)) continue;
        columnas.add(Number(suc));
        sucursales[suc] = { unidades: col.unidades, oferta: col.oferta, vendido: col.vendido, pendiente: pendiente(col), estado: estadoSucursal(col) };
      }
      const totalUnidades = Object.values(sucursales).reduce((t, c) => t + c.unidades, 0);
      return { id: l.id, idProducto: l.idProducto, nombre: l.nombre || null, codigo: l.codigo || null, vencimiento: l.vencimiento,
        creado: l.creado, dias: diasParaVencer(l.vencimiento, hoy), semaforo: semaforo(l.vencimiento, hoy, umbrales), totalUnidades, sucursales };
    }).sort((a, b) => a.vencimiento.localeCompare(b.vencimiento));
    return { lotes: filas, sucursales: [...columnas].sort((a, b) => a - b), umbrales, usuario: { idSucursal: ctx.idSucursal, esAdmin: ctx.esAdmin } };
  }));

  router.post('/api/vencimientos/lotes', api(async req => {
    const ctx = contexto(req);
    const b = req.body || {};
    const idSucursal = sucursalObjetivo(ctx, ctx.esAdmin ? b.idSucursal : undefined, false);
    return store.altaLote({ idProducto: enteroPositivo(b.idProducto, 'idProducto'), vencimiento: b.vencimiento, idSucursal,
      unidades: enteroPositivo(b.unidades, 'unidades'), usuario: ctx.user.usuario, nombre: b.nombre, codigo: b.codigo });
  }));

  router.put('/api/vencimientos/lotes/:id/unidades', api(async req => {
    const ctx = contexto(req);
    const b = req.body || {};
    const id = idLote(req);
    const idSucursal = sucursalObjetivo(ctx, b.idSucursal, true);
    const unidades = Number(b.unidades);
    if (!/^\d+$/.test(String(b.unidades ?? '').trim()) || !Number.isSafeInteger(unidades)) throw httpError(400, 'unidades tiene que ser un entero mayor o igual a 0.');
    return store.corregirUnidades({ idLote: id, idSucursal, unidades, usuario: ctx.user.usuario });
  }));

  router.post('/api/vencimientos/lotes/:id/movimientos', api(async req => {
    const ctx = contexto(req);
    const b = req.body || {};
    const id = idLote(req);
    const idSucursal = sucursalObjetivo(ctx, b.idSucursal, true);
    return store.registrarMovimiento({ idLote: id, idSucursal, tipo: b.tipo, cantidad: enteroPositivo(b.cantidad, 'cantidad'), usuario: ctx.user.usuario });
  }));

  router.delete('/api/vencimientos/lotes/:id', api(async req => {
    soloAdmin(contexto(req));
    const lote = await store.bajaLote(idLote(req));
    return { ok: true, id: lote.id };
  }));

  router.get('/api/vencimientos/config', api(async req => { contexto(req); return store.leerConfig(); }));

  router.put('/api/vencimientos/config', api(async req => {
    soloAdmin(contexto(req));
    const b = req.body || {};
    // Compatibilidad: { rojo, amarillo } plano sigue valiendo como umbrales.
    const umbrales = b.umbrales || (b.rojo !== undefined || b.amarillo !== undefined ? { rojo: b.rojo, amarillo: b.amarillo } : undefined);
    const { tipoOferta, tipoNoVendido, depositoMovimientos, diasAviso, margenDias } = b;
    return store.guardarConfig({ umbrales, tipoOferta, tipoNoVendido, depositoMovimientos, diasAviso, margenDias });
  }));

  // Cruce de solo lectura contra SIGA. Si SIGA falla, 200 con cruceDisponible:false: el listado sigue andando.
  router.get('/api/vencimientos/cruce', api(async req => {
    contexto(req);
    const [lotes, config] = await Promise.all([store.listarLotes(), store.leerConfig()]);
    const hoy = hoyLocal();
    let filas;
    try {
      filas = await consultarMovimientos(getPool, lotes, config, hoy);
    } catch (err) {
      console.error('[vencimientos] cruce SIGA falló', { lotes: lotes.length, deposito: config.depositoMovimientos, hoy }, err);
      return { cruceDisponible: false, mensaje: 'Cruce no disponible', cruce: {}, huerfanos: [], avisos: [], config };
    }
    const { porLote, huerfanos } = cruzarLote(lotes, filas, config, hoy);
    const avisos = Object.entries(porLote).flatMap(([idLote, sucs]) =>
      Object.values(sucs).filter(r => r.aviso).map(r => ({ idLote, idSucursal: r.idSucursal, aviso: r.aviso })));
    return { cruceDisponible: true, cruce: porLote, huerfanos, avisos, config };
  }));

  router.get('/api/vencimientos/historial', api(async req => {
    const ctx = contexto(req);
    const suc = String(sucursalObjetivo(ctx, ctx.esAdmin ? req.query.idSucursal : undefined, false));
    const lotes = await store.listarLotes();
    const movimientos = lotes.flatMap(l => {
      const col = l.sucursales[suc];
      if (!col) return [];
      return col.movimientos.map(m => ({ idLote: l.id, idProducto: l.idProducto, nombre: l.nombre || null, codigo: l.codigo || null, vencimiento: l.vencimiento, ...m }));
    }).sort((a, b) => b.fecha.localeCompare(a.fecha));
    return { idSucursal: Number(suc), movimientos };
  }));

  // Búsqueda por palabras en el nombre (todas) o por IdProducto; solo lectura y parametrizada.
  router.get('/api/vencimientos/productos', api(async req => {
    contexto(req);
    const q = String(req.query.q || '').trim();
    if (q.length < 2) throw httpError(400, 'Escribí al menos 2 caracteres.');
    const palabras = q.split(/\s+/).slice(0, 5);
    const request = (await getPool()).request();
    palabras.forEach((w, i) => request.input(`w${i}`, `%${w}%`));
    request.input('codigo', q);
    // IdProducto es int: compararlo con texto ("leche") rompe la conversión en SQL Server.
    const id = /^\d+$/.test(q) ? Number(q) : NaN;
    const porId = Number.isSafeInteger(id);
    if (porId) request.input('idProducto', id); // number entero → mssql lo infiere Int
    const cond = palabras.map((_, i) => `p.NombreProducto LIKE @w${i}`).join(' AND ');
    const r = await request.query(`SELECT TOP ${TOPE_PRODUCTOS} p.IdProducto, p.CodigoDeBarras, p.NombreProducto
      FROM dbo.Productos p
      WHERE p.Activo = 1 AND ((${cond}) OR p.CodigoDeBarras = @codigo${porId ? ' OR p.IdProducto = @idProducto' : ''})
      ORDER BY p.NombreProducto`);
    return (r.recordset || []).map(f => ({ idProducto: String(f.IdProducto).trim(), codigo: f.CodigoDeBarras ? String(f.CodigoDeBarras).trim() : null, nombre: f.NombreProducto }));
  }));

  return router;
};
