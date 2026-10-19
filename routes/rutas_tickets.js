'use strict';
const express = require('express');
const path = require('path');
const tickets = require('../lib/tickets');

// ── Rutas del módulo Tickets de Desarrollo ──────────────────────────────────
// Persistencia en data/tickets.json (array). Cada escritura es leer-modificar-guardar
// síncrono dentro del handler, sin await en el medio: en Node eso es atómico.
// listarUsuarios entra por deps (en server.js es auth.listarUsuarios) para poder
// testear el router sin tocar data/usuarios.json.
module.exports = function crearRutasTickets(deps) {
  const { leerJSON, guardarJSON, DATA_DIR, listarUsuarios } = deps;
  const router = express.Router();
  const TICKETS_PATH = path.join(DATA_DIR, 'tickets.json');

  const leerTickets = () => leerJSON(TICKETS_PATH, []);
  const usuariosActivos = () => listarUsuarios().filter(u => u && u.activo !== false);
  const usuarioSesion = req => (req.session && req.session.user && req.session.user.usuario) || 'anonimo';

  // Corre `fn` y responde; los errores con e.status (400/404 de lib/tickets) salen tal cual.
  const manejar = (fn, ok = 200) => (req, res) => {
    try { res.status(ok).json(fn(req)); }
    catch (e) {
      if (!e.status) console.error('[tickets]', e);
      res.status(e.status || 500).json({ error: e.message });
    }
  };

  router.get('/tickets', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'tickets.html')));
  router.get('/js/tickets.js', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'js', 'tickets.js')));

  router.get('/api/tickets', manejar(() => leerTickets()));

  router.get('/api/tickets/meta', manejar(req => ({
    prioridades: tickets.PRIORIDADES,
    estados: tickets.ESTADOS,
    areas: tickets.AREAS,
    usuarios: usuariosActivos().map(u => ({ usuario: u.usuario, nombre: u.nombre })),
    yo: (req.session && req.session.user && req.session.user.usuario) || null,
  })));

  router.post('/api/tickets', manejar(req => {
    const validos = usuariosActivos().map(u => u.usuario);
    const { lista, ticket } = tickets.crearTicket(leerTickets(), req.body, usuarioSesion(req), validos, new Date().toISOString());
    guardarJSON(TICKETS_PATH, lista);
    return ticket;
  }, 201));

  router.patch('/api/tickets/:id', manejar(req => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('Id de ticket inválido.'), { status: 400 });
    const validos = usuariosActivos().map(u => u.usuario);
    const { lista, ticket } = tickets.actualizarTicket(leerTickets(), id, req.body, usuarioSesion(req), validos, new Date().toISOString());
    guardarJSON(TICKETS_PATH, lista);
    return ticket;
  }));

  return router;
};
