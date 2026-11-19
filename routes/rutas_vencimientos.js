'use strict';
const express = require('express');
const path = require('path');
const { semaforo, diasParaVencer, pendiente, estadoSucursal, ofertaEstado, vencidoEstado, baseVencido, vistaLote, SUCURSALES_SIN_OFERTA, esSucursalSinOferta, validarFecha, hoyLocal } = require('../lib/vencimientos');
const { esSucursalReal } = require('../lib/sucursales_no_reales');
const { cruzarLote, consultarMovimientos, consultarMovimientosClase, marcarAsignados } = require('../lib/vencimientos_siga');
const { consultarVentas, calcularVentas } = require('../lib/vencimientos_ventas');
const { armarCentroControl, sinLoteDeSucursal } = require('../lib/vencimientos_centro');
const CACHE_SIN_LOTE_MS = 60 * 1000;

// ── Rutas del Control de vencimientos (Sucursales), Etapa 1 ───────────────────
// Listado compartido de lotes; cada usuario escribe solo en la columna de su sucursal
// (admin en cualquiera). El permiso 'sucursales' lo exige el guard por prefijo de lib/auth.js.
// SIGA se lee solo para buscar productos, con consulta parametrizada.
const SIN_SUCURSAL = 'Tu usuario no tiene sucursal asignada. Pedile al administrador que la configure.';
const ID_LOTE_RE = /^[0-9a-f-]{36}$/i;
const TOPE_PRODUCTOS = 30;
// Rubros que entran al buscador (mismos nombres que lib/a8020.js y rutas_carteles_pesables.js).
const RUBROS_BUSCADOR = ['Almacen', 'Pesables Fraccionado'];

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
  const { store, idSucursalDe, actualizarUsuario, getPool, tienePermiso = () => false, sucursalesSiga } = deps;
  // Sin sucursalesSiga inyectado (tests), las sucursales salen de las columnas de los lotes.
  const listarSucursales = async () => sucursalesSiga ? sucursalesSiga()
    : [...new Set((await store.listarLotes()).flatMap(l => Object.keys(l.sucursales).map(Number)))].map(id => ({ id }));
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
        sucursales[suc] = { unidades: col.unidades, oferta: col.oferta, vendido: col.vendido, vencido: col.vencido || 0, pendiente: pendiente(col), estado: estadoSucursal(col), ofertasSistema: col.ofertasSistema || [], ofertaEstado: ofertaEstado(col), vencidosSistema: col.vencidosSistema || [], vencidoEstado: vencidoEstado(col), vencidoBase: baseVencido(col), devuelto: col.devuelto || 0, origenSistema: !!col.origenSistema };
      }
      const totalUnidades = Object.values(sucursales).reduce((t, c) => t + c.unidades, 0);
      return { id: l.id, idProducto: l.idProducto, nombre: l.nombre || null, codigo: l.codigo || null, vencimiento: l.vencimiento,
        creado: l.creado, dias: diasParaVencer(l.vencimiento, hoy), semaforo: semaforo(l.vencimiento, hoy, umbrales), totalUnidades, sucursales };
    }).sort((a, b) => a.vencimiento.localeCompare(b.vencimiento));
    return { lotes: filas, sucursales: [...columnas].sort((a, b) => a - b), umbrales, usuario: { idSucursal: ctx.idSucursal, esAdmin: ctx.esAdmin, sinOferta: esSucursalSinOferta(ctx.idSucursal) }, sucursalesSinOferta: [...SUCURSALES_SIN_OFERTA] };
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

  // Sucursales sin oferta (7, 9, 10): anotan lo devuelto a Central; no se cruza con SIGA.
  router.post('/api/vencimientos/lotes/:id/devuelto-central', api(async req => {
    const ctx = contexto(req);
    const b = req.body || {};
    const id = idLote(req);
    const idSucursal = sucursalObjetivo(ctx, b.idSucursal, true);
    return vistaLote(await store.devolverCentral({ idLote: id, idSucursal, cantidad: enteroPositivo(b.cantidad, 'cantidad'), usuario: ctx.user.usuario }));
  }));

  const exigirConOferta = (clase, idSucursal) => {
    if (clase === 'oferta' && esSucursalSinOferta(idSucursal)) throw httpError(400, `La sucursal ${idSucursal} no trabaja con ofertas.`);
  };
  const nombreClase = (clase, idSucursal) => (clase === 'vencido' && esSucursalSinOferta(idSucursal) ? 'VENCIDO' : CLASES[clase].nombre);

  // Movimientos de SIGA (solo lectura) de un producto en la sucursal efectiva, por clase:
  // 'oferta' = PARA OFERTA, 'vencido' = OFERTA VENCIDO. Si SIGA falla: 502 (la UI distingue "no hay" de "falló").
  const CLASES = { oferta: { dias: 'diasMaxOferta', nombre: 'PARA OFERTA' }, vencido: { dias: 'diasMaxVencido', nombre: 'OFERTA VENCIDO' } };
  const leerMovimientosSiga = async (clase, idProducto, idSucursal) => {
    const config = await store.leerConfig();
    try {
      return { config, movimientos: await consultarMovimientosClase(getPool, { clase, idProducto, idSucursal, config, hoy: hoyLocal() }) };
    } catch (err) {
      console.error(`[vencimientos] movimientos ${clase} SIGA falló`, { idProducto, idSucursal }, err);
      throw httpError(502, 'No se pudieron leer los movimientos de SIGA');
    }
  };

  // Sucursal para lectura: la propia; admin puede pedir otra. 400 si no hay o es ficticia.
  const sucursalLectura = (ctx, pedida) => {
    const hayPedida = ctx.esAdmin && pedida !== undefined && pedida !== null && pedida !== '';
    const idSucursal = hayPedida ? enteroPositivo(pedida, 'idSucursal') : ctx.idSucursal;
    if (!idSucursal) throw httpError(400, ctx.esAdmin ? 'Indicá idSucursal.' : SIN_SUCURSAL);
    if (!esSucursalReal(idSucursal)) throw httpError(400, `La sucursal ${idSucursal} no es una sucursal real.`);
    return idSucursal;
  };

  for (const [clase, { dias }] of Object.entries(CLASES)) {
    router.get(`/api/vencimientos/movimientos-${clase}`, api(async req => {
      const ctx = contexto(req);
      const idSucursal = sucursalLectura(ctx, req.query.idSucursal);
      exigirConOferta(clase, idSucursal);
      const idProducto = enteroPositivo(req.query.idProducto, 'idProducto');
      const [{ config, movimientos }, lotes] = await Promise.all([leerMovimientosSiga(clase, idProducto, idSucursal), store.listarLotes()]);
      return { idSucursal, diasMax: config[dias], movimientos: marcarAsignados(movimientos, lotes, idProducto, idSucursal, clase) };
    }));

    router.post(`/api/vencimientos/lotes/:id/${clase}`, api(async req => {
      const ctx = contexto(req);
      const b = req.body || {};
      const id = idLote(req);
      const idSucursal = sucursalObjetivo(ctx, b.idSucursal, true);
      exigirConOferta(clase, idSucursal);
      // Body viejo { numeroMovimiento } = lote de uno.
      const crudos = b.numerosMovimiento !== undefined ? b.numerosMovimiento : (b.numeroMovimiento !== undefined ? [b.numeroMovimiento] : []);
      if (!Array.isArray(crudos) || !crudos.length) throw httpError(400, 'Indicá al menos un movimiento en numerosMovimiento.');
      const numeros = crudos.map(n => enteroPositivo(n, 'numerosMovimiento'));
      if (new Set(numeros).size !== numeros.length) throw httpError(400, 'numerosMovimiento tiene valores repetidos.');
      const lote = (await store.listarLotes()).find(l => l.id === id);
      if (!lote) throw httpError(404, 'Lote inexistente');
      if (!lote.sucursales[idSucursal]) throw httpError(404, `La sucursal ${idSucursal} no tiene unidades en este lote`);
      const { movimientos } = await leerMovimientosSiga(clase, lote.idProducto, idSucursal);
      const elegidos = numeros.map(n => {
        const m = movimientos.find(x => x.numeroMovimiento === n);
        if (!m) throw httpError(400, `El movimiento ${n} no es un ${nombreClase(clase, idSucursal)} de este producto en la sucursal dentro de la ventana.`);
        return m;
      });
      // El store vuelve a chequear asignaciones dentro de la cola (409 si alguno es de otro registro; nada se guarda).
      return vistaLote(await store.asignarSistema(clase, { idLote: id, idSucursal, movimientos: elegidos, confirmacion: b.confirmacion, usuario: ctx.user.usuario }));
    }));

    router.put(`/api/vencimientos/lotes/:id/${clase}/confirmacion`, api(async req => {
      const ctx = contexto(req);
      const b = req.body || {};
      const id = idLote(req);
      const idSucursal = sucursalObjetivo(ctx, b.idSucursal, true);
      exigirConOferta(clase, idSucursal);
      return vistaLote(await store.confirmarSistema(clase, { idLote: id, idSucursal, confirmacion: b.confirmacion, usuario: ctx.user.usuario }));
    }));

    router.delete(`/api/vencimientos/lotes/:id/${clase}`, api(async req => {
      const ctx = contexto(req);
      const id = idLote(req);
      const idSucursal = sucursalObjetivo(ctx, req.query.idSucursal, true);
      exigirConOferta(clase, idSucursal);
      const q = req.query.numeroMovimiento;
      const numeroMovimiento = q === undefined || q === '' ? undefined : enteroPositivo(q, 'numeroMovimiento');
      return vistaLote(await store.quitarSistema(clase, { idLote: id, idSucursal, numeroMovimiento, usuario: ctx.user.usuario }));
    }));
  }

  // Movimientos de SIGA (oferta y vencido) de la sucursal que no están asignados a ningún registro,
  // sin los productos que ya tienen un registro activo (esos van por el flujo normal). Solo lectura.
  router.get('/api/vencimientos/sin-lote', api(async req => {
    const ctx = contexto(req);
    const idSucursal = sucursalLectura(ctx, req.query.idSucursal);
    const [config, lotes] = await Promise.all([store.leerConfig(), store.listarLotes()]);
    const hoy = hoyLocal();
    let movimientos;
    try {
      movimientos = await sinLoteDeSucursal(getPool, { lotes, config, hoy, idSucursal, rubros: RUBROS_BUSCADOR });
    } catch (err) {
      console.error('[vencimientos] sin-lote SIGA falló', { idSucursal }, err);
      throw httpError(502, 'No se pudieron leer los movimientos de SIGA');
    }
    return { idSucursal, diasMaxOferta: config.diasMaxOferta, diasMaxVencido: config.diasMaxVencido, movimientos };
  }));

  // Centro de control (todas las sucursales reales). Permiso fino 'vencimientos-control' (admin siempre).
  // Si SIGA falla, 200 con sinLote.disponible=false. El bloque sin lote se cachea 60 s (N sucursales x 2 consultas).
  let cacheSinLote = { hasta: 0, valor: null };
  const leerSinLoteTodas = async (lotes, config, hoy) => {
    if (cacheSinLote.valor && Date.now() < cacheSinLote.hasta) return cacheSinLote.valor;
    try {
      const ids = (await listarSucursales()).filter(s => s.activa !== false && esSucursalReal(s.id)).map(s => s.id);
      const listas = await Promise.all(ids.map(idSucursal => sinLoteDeSucursal(getPool, { lotes, config, hoy, idSucursal, rubros: RUBROS_BUSCADOR })));
      const valor = Object.fromEntries(ids.map((id, i) => [id, listas[i]]));
      cacheSinLote = { hasta: Date.now() + CACHE_SIN_LOTE_MS, valor };
      return valor;
    } catch (err) {
      console.error('[vencimientos] centro-control SIGA falló', err);
      return null;
    }
  };
  // Nombres para la vista; si SIGA falla quedan 'Sucursal N'.
  const nombresSucursales = async () => {
    try { return Object.fromEntries((await listarSucursales()).filter(s => s.nombre).map(s => [s.id, String(s.nombre).trim()])); }
    catch (err) { console.error('[vencimientos] centro-control nombres de sucursal', err); return {}; }
  };
  const exigirControl = req => {
    const ctx = contexto(req);
    if (!tienePermiso(ctx.user, 'vencimientos-control')) throw httpError(403, 'No tenés permiso para el centro de control de vencimientos.');
    return ctx;
  };
  const paginaControl = archivo => (req, res) => {
    if (!tienePermiso(req.session && req.session.user, 'vencimientos-control')) return res.status(403).send('Sin permiso para el centro de control de vencimientos.');
    res.sendFile(archivo, err => { if (err && !res.headersSent) res.status(404).send('No encontrado'); });
  };
  router.get('/vencimientos-control', paginaControl(path.join(__dirname, '..', 'public', 'vencimientos_control.html')));
  router.get('/js/vencimientos_control.js', paginaControl(path.join(__dirname, '..', 'public', 'js', 'vencimientos_control.js')));
  router.get('/js/vencimientos_control_mock.js', paginaControl(path.join(__dirname, '..', 'public', 'js', 'vencimientos_control_mock.js')));
  router.get('/api/vencimientos/centro-control', api(async req => {
    exigirControl(req);
    const [config, lotes] = await Promise.all([store.leerConfig(), store.listarLotes()]);
    const hoy = hoyLocal();
    const [sinLote, nombres] = await Promise.all([leerSinLoteTodas(lotes, config, hoy), nombresSucursales()]);
    return armarCentroControl(lotes, config, hoy, sinLote, nombres);
  }));

  // Da de alta un registro desde un movimiento sin lote y lo deja asignado.
  // oferta: unidades y vencimiento del usuario (si no suman, queda a confirmar). vencido: directo al historial.
  router.post('/api/vencimientos/sin-lote/alta', api(async req => {
    const ctx = contexto(req);
    const b = req.body || {};
    const hayPedida = b.idSucursal !== undefined && b.idSucursal !== null && b.idSucursal !== '';
    if (!ctx.esAdmin && hayPedida && Number(b.idSucursal) !== ctx.idSucursal) throw httpError(403, 'Solo podés modificar datos de tu sucursal.');
    const idSucursal = sucursalLectura(ctx, b.idSucursal);
    if (!CLASES[b.clase]) throw httpError(400, "clase debe ser 'oferta' o 'vencido'.");
    exigirConOferta(b.clase, idSucursal);
    const numeroMovimiento = enteroPositivo(b.numeroMovimiento, 'numeroMovimiento');
    const idProducto = enteroPositivo(b.idProducto, 'idProducto');
    const esOferta = b.clase === 'oferta';
    // Oferta: vencimiento y unidades obligatorios (puede ser pasada). Vencido: opcional, default = fecha del movimiento.
    const hayVenc = b.vencimiento !== undefined && b.vencimiento !== null && b.vencimiento !== '';
    const vencPedido = esOferta || hayVenc ? validarFecha(b.vencimiento, 'vencimiento') : null;
    const unidades = esOferta ? enteroPositivo(b.unidades, 'unidades') : undefined;
    const config = await store.leerConfig();
    let movimientos;
    try {
      movimientos = await consultarMovimientosClase(getPool, { clase: b.clase, idProducto, idSucursal, config, hoy: hoyLocal(), rubros: RUBROS_BUSCADOR });
    } catch (err) {
      console.error('[vencimientos] sin-lote alta SIGA falló', { idProducto, idSucursal, numeroMovimiento }, err);
      throw httpError(502, 'No se pudieron leer los movimientos de SIGA');
    }
    const m = movimientos.find(x => x.numeroMovimiento === numeroMovimiento);
    if (!m) throw httpError(400, `El movimiento ${numeroMovimiento} no es un ${nombreClase(b.clase, idSucursal)} de este producto en la sucursal dentro de la ventana.`);
    if (!esOferta && !Number.isSafeInteger(m.cantidad)) throw httpError(400, 'La cantidad del movimiento no es un número entero');
    const vencimiento = vencPedido || String(m.fecha).slice(0, 10);
    // El store chequea asignado/duplicado dentro de la cola (409) y hace alta + asignación en un solo paso.
    return vistaLote(await store.altaDesdeMovimiento({ clase: b.clase, idProducto, vencimiento, unidades, idSucursal, usuario: ctx.user.usuario,
      nombre: m.nombre || undefined, codigo: m.codigo || undefined, movimiento: { numeroMovimiento: m.numeroMovimiento, fecha: m.fecha, cantidad: m.cantidad } }));
  }));

  // Elimina el registro de UNA sucursal (historial incluido); el lote se borra si era la única.
  router.delete('/api/vencimientos/lotes/:id/registro', api(async req => {
    const ctx = contexto(req);
    const id = idLote(req);
    const pedida = req.query.idSucursal;
    const hayPedida = pedida !== undefined && pedida !== '';
    if (!ctx.esAdmin && hayPedida && Number(pedida) !== ctx.idSucursal) throw httpError(403, 'Solo podés eliminar registros de tu sucursal.');
    if (!(ctx.esAdmin && hayPedida) && !ctx.idSucursal) throw httpError(400, ctx.esAdmin ? 'Indicá idSucursal.' : SIN_SUCURSAL);
    const idSucursal = ctx.esAdmin && hayPedida ? enteroPositivo(pedida, 'idSucursal') : ctx.idSucursal;
    const r = await store.eliminarRegistro({ idLote: id, idSucursal });
    console.log('[vencimientos] registro eliminado', { idLote: r.idLote, idProducto: r.idProducto, idSucursal: r.idSucursal, usuario: ctx.user.usuario, movimientos: r.movimientos, loteEliminado: r.loteEliminado });
    return { ok: true, idSucursal: r.idSucursal, loteEliminado: r.loteEliminado };
  }));

  router.delete('/api/vencimientos/lotes/:id', api(async req => {
    soloAdmin(contexto(req));
    const lote = await store.bajaLote(idLote(req));
    return { ok: true, id: lote.id };
  }));

  // Cada usuario cambia solo su propia sucursal (id de la sesión, nunca del body). Vacío/null desasigna.
  router.put('/api/vencimientos/mi-sucursal', api(async req => {
    const ctx = contexto(req);
    const v = (req.body || {}).idSucursal;
    const idSucursal = v === undefined || v === null || String(v).trim() === '' ? null : enteroPositivo(v, 'idSucursal');
    if (idSucursal !== null && !esSucursalReal(idSucursal)) throw httpError(400, `La sucursal ${idSucursal} no es una sucursal real.`);
    await actualizarUsuario(ctx.user.id, { idSucursal });
    return { ok: true, idSucursal };
  }));

  router.get('/api/vencimientos/config', api(async req => { contexto(req); return store.leerConfig(); }));

  router.put('/api/vencimientos/config', api(async req => {
    soloAdmin(contexto(req));
    const b = req.body || {};
    // Compatibilidad: { rojo, amarillo } plano sigue valiendo como umbrales.
    const umbrales = b.umbrales || (b.rojo !== undefined || b.amarillo !== undefined ? { rojo: b.rojo, amarillo: b.amarillo } : undefined);
    const { tipoOferta, tipoNoVendido, depositoMovimientos, diasAviso, margenDias, diasMaxOferta, tipoOfertaVencida, diasMaxVencido, diasAntesVencimientoOferta } = b;
    return store.guardarConfig({ umbrales, tipoOferta, tipoNoVendido, depositoMovimientos, diasAviso, margenDias, diasMaxOferta, tipoOfertaVencida, diasMaxVencido, diasAntesVencimientoOferta });
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

  // Ventas de SIGA de UNA sucursal (la del usuario; un admin puede pedir ?idSucursal) para todos los lotes.
  // Sin sucursal o ficticia: 200 sin consultar. Si SIGA falla, 200 con ventasDisponible:false.
  router.get('/api/vencimientos/ventas', api(async req => {
    const ctx = contexto(req);
    const pedida = req.query.idSucursal;
    const hayPedida = ctx.esAdmin && pedida !== undefined && pedida !== '';
    const idSucursal = hayPedida ? enteroPositivo(pedida, 'idSucursal') : ctx.idSucursal;
    if (hayPedida && !esSucursalReal(idSucursal)) throw httpError(400, 'idSucursal no válida.');
    if (!idSucursal) return { ventasDisponible: true, idSucursal: null, mensaje: 'Sin sucursal asignada', ventas: {} };
    if (!esSucursalReal(idSucursal)) return { ventasDisponible: true, idSucursal, mensaje: 'Sucursal no válida', ventas: {} };
    const lotes = await store.listarLotes();
    if (!lotes.length) return { ventasDisponible: true, idSucursal, ventas: {} };
    const hoy = hoyLocal();
    let filas;
    try {
      filas = await consultarVentas(getPool, lotes, hoy, idSucursal);
    } catch (err) {
      console.error('[vencimientos] ventas SIGA falló', { idSucursal, lotes: lotes.length, hoy }, err);
      return { ventasDisponible: false, idSucursal, mensaje: 'Ventas no disponibles', ventas: {} };
    }
    return { ventasDisponible: true, idSucursal, ventas: calcularVentas(lotes, filas, hoy, idSucursal) };
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
    RUBROS_BUSCADOR.forEach((rubro, i) => request.input(`rubro${i}`, rubro));
    const cond = palabras.map((_, i) => `p.NombreProducto LIKE @w${i}`).join(' AND ');
    const rubros = RUBROS_BUSCADOR.map((_, i) => `@rubro${i}`).join(', ');
    const r = await request.query(`SELECT TOP ${TOPE_PRODUCTOS} p.IdProducto, p.CodigoDeBarras, p.NombreProducto
      FROM dbo.Productos p
      INNER JOIN Rubros r ON r.IdRubro = p.IdRubro
      WHERE p.Activo = 1 AND r.NombreRubro IN (${rubros}) AND ((${cond}) OR p.CodigoDeBarras = @codigo${porId ? ' OR p.IdProducto = @idProducto' : ''})
      ORDER BY p.NombreProducto`);
    return (r.recordset || []).map(f => ({ idProducto: String(f.IdProducto).trim(), codigo: f.CodigoDeBarras ? String(f.CodigoDeBarras).trim() : null, nombre: f.NombreProducto }));
  }));

  return router;
};
