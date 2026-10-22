'use strict';
const express = require('express');
const path = require('path');
const tickets = require('../lib/tickets');

// ── Rutas del módulo Tickets de Desarrollo ──────────────────────────────────
// Persistencia en data/tickets.json (array). Cada escritura es leer-modificar-guardar
// síncrono dentro del handler, sin await en el medio: en Node eso es atómico. Lo único
// async (usuarios de SIGA) se resuelve ANTES de leer el JSON.
// Los destinatarios son usuarios activos de SIGA (tabla Usuarios; el Id se normaliza) o nombres
// libres de externos; `query` entra por deps (en server.js es el pool de lectura) para poder testear el router sin SQL.
// Permisos: con el módulo se ve todo, se crea y se agregan notas. Cambiar el estado pide el permiso fino
// 'tickets-gestion' (tienePermiso entra por deps, es auth.tienePermiso); destinatarios y prioridad los cambia el
// creador del ticket o quien tenga ese permiso. Las etapas (alta, cambio, baja) también piden 'tickets-gestion'.
// La misma factory monta otras instancias con datos propios (p. ej. Mantenimiento de sucursales): deps acepta
// pagina, api, archivo, permiso, areas y etiqueta (logs); los defaults son los de /tickets. El html es siempre tickets.html.
const USUARIOS_TTL_MS = 5 * 60 * 1000;
const SQL_USUARIOS = 'SELECT Id, Nombre FROM Usuarios WHERE Activo = 1 ORDER BY Nombre';

module.exports = function crearRutasTickets(deps) {
  const {
    leerJSON, guardarJSON, DATA_DIR, query, tienePermiso, ttlMs = USUARIOS_TTL_MS,
    pagina = '/tickets', api = '/api/tickets', archivo = 'tickets.json', permiso = 'tickets-gestion',
    areas = tickets.AREAS, etiqueta = 'tickets',
  } = deps;
  const router = express.Router();
  const TICKETS_PATH = path.join(DATA_DIR, archivo);
  const PERMISO_GESTION = permiso;

  const leerTickets = () => leerJSON(TICKETS_PATH, []);
  const usuarioSesion = req => (req.session && req.session.user && req.session.user.usuario) || 'anonimo';
  const userSesion = req => (req.session && req.session.user) || null;
  // Sin sesión (o sin tienePermiso inyectado) → sin permiso.
  const puedeGestionar = req => !!(userSesion(req) && tienePermiso && tienePermiso(userSesion(req), PERMISO_GESTION));
  const prohibido = msg => Object.assign(new Error(msg), { status: 403 });

  // 403 si el body pide algo que la sesión no puede hacer sobre `ticket`. Ticket inexistente: lo resuelve actualizarTicket (404).
  function autorizarCambios(req, ticket, cambios) {
    if (!ticket || puedeGestionar(req)) return;
    if (cambios.estado !== undefined) throw prohibido('No tenés permiso para cambiar el estado de los tickets.');
    const login = String((userSesion(req) || {}).usuario || '').toLowerCase();
    if (login && String(ticket.creadoPor || '').toLowerCase() === login) return;
    if (cambios.destinatarios !== undefined) {
      throw prohibido('Solo el creador del ticket o quien tenga el permiso de gestión puede cambiar los destinatarios.');
    }
    if (cambios.prioridad !== undefined) {
      throw prohibido('Solo el creador del ticket o quien tenga el permiso de gestión puede cambiar la prioridad.');
    }
  }

  function idValido(valor, que) {
    const id = Number(valor);
    if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error(`Id de ${que} inválido.`), { status: 400 });
    return id;
  }

  // ponytail: caché en memoria de 5 min: un alta/baja en SIGA tarda hasta 5 min en verse.
  // Si SIGA no responde se sirve la caché vieja; sin caché, 503.
  let cache = null; // { lista, ts }
  async function usuariosSiga() {
    if (cache && Date.now() - cache.ts < ttlMs) return cache.lista;
    try {
      const filas = await query(SQL_USUARIOS);
      const lista = (filas || [])
        .map(f => ({ usuario: String(f.Id || '').trim(), nombre: String(f.Nombre || '').trim() }))
        .filter(u => u.usuario)
        .map(u => ({ usuario: u.usuario, nombre: u.nombre || u.usuario }));
      cache = { lista, ts: Date.now() };
      return lista;
    } catch (e) {
      console.error(`[${etiqueta}] usuarios SIGA:`, e);
      if (cache) return cache.lista;
      throw Object.assign(new Error('No se pudieron leer los usuarios de SIGA.'), { status: 503 });
    }
  }

  // Corre `fn` (sync o async) y responde; los errores con e.status (400/404/503) salen tal cual.
  const manejar = (fn, ok = 200) => async (req, res) => {
    try { res.status(ok).json(await fn(req)); }
    catch (e) {
      if (!e.status) console.error(`[${etiqueta}]`, e);
      res.status(e.status || 500).json({ error: e.message });
    }
  };

  router.get(pagina, (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'tickets.html')));
  router.get('/js/tickets.js', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'js', 'tickets.js')));

  router.get(api, manejar(() => leerTickets()));

  router.get(`${api}/meta`, manejar(async req => {
    const usuarios = await usuariosSiga();
    const user = (req.session && req.session.user) || {};
    const login = String(user.usuario || '').toLowerCase();
    const yo = login ? usuarios.find(u => u.usuario.toLowerCase() === login) : null;
    return {
      prioridades: tickets.PRIORIDADES,
      estados: tickets.ESTADOS,
      estadosEtapa: tickets.ESTADOS_ETAPA,
      areas,
      usuarios,
      yo: yo ? yo.usuario : null,
      yoNombre: user.nombre || user.usuario || null,
      login: user.usuario || null,
      puedeGestionar: puedeGestionar(req),
    };
  }));

  router.post(api, manejar(async req => {
    const validos = (await usuariosSiga()).map(u => u.usuario);
    // Desde acá sincrónico: leer → modificar → guardar.
    const { lista, ticket } = tickets.crearTicket(leerTickets(), req.body, usuarioSesion(req), validos, new Date().toISOString());
    guardarJSON(TICKETS_PATH, lista);
    return ticket;
  }, 201));

  router.patch(`${api}/:id`, manejar(async req => {
    const id = idValido(req.params.id, 'ticket');
    const validos = (await usuariosSiga()).map(u => u.usuario);
    // Desde acá sincrónico: leer → modificar → guardar.
    const actuales = leerTickets();
    autorizarCambios(req, actuales.find(t => Number(t.id) === id), req.body || {});
    const { lista, ticket } = tickets.actualizarTicket(actuales, id, req.body, usuarioSesion(req), validos, new Date().toISOString());
    guardarJSON(TICKETS_PATH, lista);
    return ticket;
  }));

  // Etapas: sin SIGA de por medio, todo sincrónico (leer → modificar → guardar). Responden el ticket completo.
  const operarEtapa = (fn, ok) => manejar(req => {
    if (!puedeGestionar(req)) throw prohibido('No tenés permiso para gestionar etapas.');
    const id = idValido(req.params.id, 'ticket');
    const etapaId = req.params.etapaId === undefined ? null : idValido(req.params.etapaId, 'etapa');
    const { lista, ticket } = fn(leerTickets(), id, etapaId, req.body || {}, usuarioSesion(req), new Date().toISOString());
    guardarJSON(TICKETS_PATH, lista);
    return ticket;
  }, ok);
  router.post(`${api}/:id/etapas`, operarEtapa((l, id, _e, body, u, ahora) => tickets.agregarEtapa(l, id, body, u, ahora), 201));
  router.patch(`${api}/:id/etapas/:etapaId`, operarEtapa((l, id, e, body, u, ahora) => tickets.actualizarEtapa(l, id, e, body, u, ahora)));
  router.delete(`${api}/:id/etapas/:etapaId`, operarEtapa((l, id, e, _b, u, ahora) => tickets.eliminarEtapa(l, id, e, u, ahora)));

  return router;
};
