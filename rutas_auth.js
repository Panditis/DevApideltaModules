'use strict';
const express = require('express');
const path = require('path');
const auth = require('./lib/auth');

// ── Rutas de auth y Centro de control ─────────────────────────────────────────
// Login/logout, sesión, cambio de contraseña propia, listado de módulos del hub y
// el ABM de usuarios/módulos del admin. Extraídas de server.js sin cambios de
// comportamiento: mismas rutas, mismo orden relativo y mismo texto.
//
// El middleware de sesión y el guard de control de acceso NO viven acá: son
// infraestructura del server (corren antes que cualquier router) y se quedan en
// server.js.
//
// auth.js es un módulo propio sin estado inyectado: se requiere directo, igual que
// lo hace server.js. El throttle de login (loginIntentos) sólo lo usa /api/login,
// así que se muda con la ruta.
module.exports = function crearRutasAuth() {
  const router = express.Router();

router.get('/login',         (_req, res) => res.sendFile(path.join(__dirname, 'login.html')));
router.get('/admin',         (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
// ── API de autenticación / sesión ───────────────────────────────────────────────
// Throttle simple en memoria contra fuerza bruta (por IP).
const loginIntentos = new Map(); // ip -> { count, hasta }
const LOGIN_MAX = 8;
const LOGIN_BLOQUEO_MS = 15 * 60 * 1000;
router.post('/api/login', (req, res) => {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const ahora = Date.now();
  const reg = loginIntentos.get(ip);
  if (reg && reg.hasta > ahora && reg.count >= LOGIN_MAX) {
    return res.status(429).json({ error: 'Demasiados intentos fallidos. Esperá unos minutos.' });
  }
  const { usuario, password } = req.body || {};
  const user = auth.autenticar(usuario, password);
  if (!user) {
    const enVentana = reg && reg.hasta > ahora;
    loginIntentos.set(ip, enVentana ? { count: reg.count + 1, hasta: reg.hasta } : { count: 1, hasta: ahora + LOGIN_BLOQUEO_MS });
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }
  loginIntentos.delete(ip);
  // Regenerar la sesión al autenticar evita fijación de sesión.
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'No se pudo iniciar sesión.' });
    req.session.user = user;
    res.json({ ok: true, user });
  });
});
router.post('/api/logout', (req, res) => {
  if (req.session) return req.session.destroy(() => res.json({ ok: true }));
  res.json({ ok: true });
});
// Cambio de contraseña propio: cualquier usuario logueado, sin pasar por el
// Centro de control. La ruta no pertenece a ningún módulo, así que el guard
// general la deja pasar: el chequeo de sesión va acá.
router.post('/api/password', (req, res) => {
  const user = req.session && req.session.user;
  if (!user) return res.status(401).json({ error: 'No autenticado' });
  const { actual, nueva } = req.body || {};
  try {
    auth.cambiarPasswordPropia(user.usuario, actual, nueva);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/api/session', (req, res) => {
  res.json({ user: (req.session && req.session.user) || null });
});
// Módulos del hub: todos los activos no-admin. Cada uno trae `permitido` (si el
// usuario actual puede entrar) para que el front muestre los bloqueados igual.
router.get('/api/modulos', (req, res) => {
  const user = req.session && req.session.user;
  const lista = auth.leerModulos()
    .filter(m => m.activo && !m.soloAdmin)
    .map(m => ({ ...m, permitido: m.requiereAuth === false || auth.puedeAcceder(user, m.ref) }));
  res.json(lista);
});

// ── API del Centro de control (protegida por requireAuth: sólo admin) ────────────
router.get('/api/admin/usuarios', (_req, res) => res.json(auth.listarUsuarios()));
router.post('/api/admin/usuarios', (req, res) => {
  try { res.json({ ok: true, user: auth.crearUsuario(req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/api/admin/usuarios/:id', (req, res) => {
  try { res.json({ ok: true, user: auth.actualizarUsuario(req.params.id, req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/api/admin/usuarios/:id', (req, res) => {
  try { auth.eliminarUsuario(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/api/admin/modulos', (_req, res) => res.json(auth.leerModulos()));
router.put('/api/admin/modulos', (req, res) => {
  try { res.json({ ok: true, modulos: auth.guardarModulos(req.body || []) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

  return router;
};
