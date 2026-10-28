'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
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
// pagina, api, archivo, permiso, areas, etiqueta (logs) y usuarios (destinatarios propios, sin SIGA); los defaults son los
// de /tickets. El html es siempre tickets.html.
// Adjuntos: los archivos van a data/<archivo sin .json>_adjuntos/<uuid>.<ext> (la instancia de Mantenimiento tiene los suyos) y el
// JSON guarda solo metadatos. multer en memoria; validación y reglas en lib/tickets.js. Subir/quitar en la descripción lo hace el
// creador o quien gestiona; en una nota, su autor o quien gestiona. Descargar, cualquiera con el módulo.
const MB = 1024 * 1024;
const MENSAJES_MULTER = {
  LIMIT_FILE_SIZE: `Cada archivo puede pesar hasta ${tickets.MAX_ADJUNTO_BYTES / MB} MB.`,
  LIMIT_FILE_COUNT: `Se pueden adjuntar hasta ${tickets.MAX_ADJUNTOS_PEDIDO} archivos por vez.`,
  LIMIT_UNEXPECTED_FILE: `Se pueden adjuntar hasta ${tickets.MAX_ADJUNTOS_PEDIDO} archivos por vez.`,
  LIMIT_FIELD_COUNT: 'El pedido no es válido.',
  LIMIT_FIELD_VALUE: 'El pedido no es válido.',
  LIMIT_FIELD_KEY: 'El pedido no es válido.',
  LIMIT_PART_COUNT: 'El pedido no es válido.',
};
// defParamCharset utf8: sin esto multer decodifica el nombre del archivo como latin1 y rompe tildes y eñes.
// Límites de campos de texto (sin ellos, cientos de campos de 1 MB tumban el proceso). fieldNameSize: 9 = largo de «prioridad», el
// nombre legítimo más largo que puede llegar en un PATCH multipart (el front manda solo `nota` y `archivos`); corta los nombres tipo
// `a[4294967294]` del advisory de multer 2.1.1 (con 9 caracteres el índice entre corchetes no pasa de 6 dígitos).
const upload = multer({
  storage: multer.memoryStorage(),
  defParamCharset: 'utf8',
  limits: { fileSize: tickets.MAX_ADJUNTO_BYTES, files: tickets.MAX_ADJUNTOS_PEDIDO, fields: 2, fieldSize: 16 * 1024, fieldNameSize: 9, parts: 8 },
});

const USUARIOS_TTL_MS = 5 * 60 * 1000;
const SQL_USUARIOS = 'SELECT Id, Nombre FROM Usuarios WHERE Activo = 1 ORDER BY Nombre';

module.exports = function crearRutasTickets(deps) {
  const {
    leerJSON, guardarJSON, DATA_DIR, query, tienePermiso, ttlMs = USUARIOS_TTL_MS,
    pagina = '/tickets', api = '/api/tickets', archivo = 'tickets.json', permiso = 'tickets-gestion',
    areas = tickets.AREAS, etiqueta = 'tickets',
    crearSoloGestion = false, // true: dar de alta también pide el permiso de gestión (Mantenimiento)
    usuarios: fuenteUsuarios, // () => [{ usuario, nombre }] (sync o async): destinatarios propios en vez de los de SIGA
  } = deps;
  const router = express.Router();
  const TICKETS_PATH = path.join(DATA_DIR, archivo);
  const DIR_ADJUNTOS = path.join(DATA_DIR, `${archivo.replace(/\.json$/i, '')}_adjuntos`);
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

  // Descripción: creador del ticket o gestión. Nota: autor de la nota o gestión. Antes hay que haber verificado que el ticket y la
  // nota existen (tickets.verificarDestino; en DELETE, tickets.ubicarAdjunto).
  function autorizarAdjuntos(req, ticket, duenio) {
    if (puedeGestionar(req)) return;
    const login = String((userSesion(req) || {}).usuario || '').toLowerCase();
    const enNota = duenio.nota !== undefined;
    const responsable = enNota ? ticket.historial[duenio.nota].usuario : ticket.creadoPor;
    if (login && String(responsable || '').toLowerCase() === login) return;
    throw prohibido(enNota
      ? 'Solo el autor de la nota o quien tenga el permiso de gestión puede cambiar sus adjuntos.'
      : 'Solo el creador del ticket o quien tenga el permiso de gestión puede cambiar los adjuntos de la descripción.');
  }

  // El campo `nota` (texto, porque va en multipart) es el índice del evento nota; sin él, el archivo va a la descripción.
  function duenioDeAdjuntos(body) {
    const crudo = body && body.nota;
    if (crudo === undefined || crudo === '') return {};
    const n = Number(crudo);
    if (!Number.isInteger(n) || n < 0) throw Object.assign(new Error('Índice de nota inválido.'), { status: 400 });
    return { nota: n };
  }

  // multipart: hasta MAX archivos en `archivos[]` + campos de texto. Un pedido JSON pasa de largo. Errores de multer → 400 JSON.
  // CSRF: un multipart es un "simple request" (un formulario de otro puerto del mismo host lo manda sin preflight). Si el navegador
  // declara `Sec-Fetch-Site` y no es same-origin, 403; sin el header (clientes que no son navegador) pasa.
  const recibirArchivos = (req, res, next) => {
    const sitio = req.get('Sec-Fetch-Site');
    if (sitio && sitio !== 'same-origin' && req.is('multipart/form-data')) {
      return res.status(403).json({ error: 'Pedido de otro origen rechazado.' });
    }
    return upload.array('archivos', tickets.MAX_ADJUNTOS_PEDIDO)(req, res, err => {
      if (!err) return next();
      return res.status(400).json({ error: MENSAJES_MULTER[err.code] || `No se pudieron leer los archivos: ${err.message}` });
    });
  };

  function borrarArchivos(nombres) {
    nombres.forEach(n => {
      try { fs.rmSync(path.join(DIR_ADJUNTOS, path.basename(n)), { force: true }); }
      catch (e) { console.error(`[${etiqueta}] no se pudo borrar el adjunto ${n}:`, e); }
    });
  }

  // Escribe cada archivo con nombre propio (uuid + extensión) y devuelve los metadatos listos para el ticket.
  function guardarArchivos(req, validados, ahora) {
    fs.mkdirSync(DIR_ADJUNTOS, { recursive: true });
    const escritos = [];
    try {
      return validados.map((v, i) => {
        const enDisco = `${crypto.randomUUID()}.${v.ext}`;
        escritos.push(enDisco); // antes de escribir: si falla a mitad (disco lleno) el rollback también borra el archivo truncado
        fs.writeFileSync(path.join(DIR_ADJUNTOS, enDisco), req.files[i].buffer);
        return { nombre: v.nombre, mime: v.mime, tamano: v.tamano, subidoPor: usuarioSesion(req), subidoEn: ahora, archivo: enDisco };
      });
    } catch (e) { borrarArchivos(escritos); throw e; }
  }

  // Valida y guarda los archivos del pedido, corre `operar(metas)` (sincrónico: lib + guardarJSON) y, si algo falla, borra lo escrito.
  function conArchivos(req, ahora, operar) {
    const metas = guardarArchivos(req, tickets.validarArchivos(req.files), ahora);
    try { return operar(metas); }
    catch (e) { borrarArchivos(metas.map(m => m.archivo)); throw e; }
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

  // Destinatarios válidos: los que inyecta la instancia (Mantenimiento: cuentas de la app) o, si no, los de SIGA.
  const listarUsuarios = async () => (fuenteUsuarios ? fuenteUsuarios() : usuariosSiga());

  // Los errores con e.status (400/403/404/503) son nuestros y salen tal cual; el resto (fs, JSON) se loguea y al cliente va un
  // mensaje genérico (e.message de fs trae rutas absolutas y nombres de archivo).
  const mensajeSeguro = e => (e.status ? e.message : 'Error interno del servidor.');

  // Corre `fn` (sync o async) y responde.
  const manejar = (fn, ok = 200) => async (req, res) => {
    try { res.status(ok).json(tickets.ocultarRutas(await fn(req))); }
    catch (e) {
      if (!e.status) console.error(`[${etiqueta}]`, e);
      res.status(e.status || 500).json({ error: mensajeSeguro(e) });
    }
  };

  router.get(pagina, (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'tickets.html')));
  router.get('/js/tickets.js', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'js', 'tickets.js')));
  router.get('/js/tickets_adjuntos.js', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'js', 'tickets_adjuntos.js')));

  router.get(api, manejar(() => leerTickets()));

  router.get(`${api}/meta`, manejar(async req => {
    const usuarios = await listarUsuarios();
    const user = (req.session && req.session.user) || {};
    const login = String(user.usuario || '').toLowerCase();
    const yo = login ? usuarios.find(u => u.usuario.toLowerCase() === login) : null;
    return {
      prioridades: tickets.PRIORIDADES,
      estados: tickets.ESTADOS,
      estadosEtapa: tickets.ESTADOS_ETAPA,
      areas,
      usuarios,
      soloUsuarios: !!fuenteUsuarios, // true: sólo se eligen cuentas de la lista (sin externos ni nombres libres en la UI)
      yo: yo ? yo.usuario : null,
      yoNombre: user.nombre || user.usuario || null,
      login: user.usuario || null,
      puedeGestionar: puedeGestionar(req),
      puedeCrear: !crearSoloGestion || puedeGestionar(req),
    };
  }));

  router.post(api, manejar(async req => {
    if (crearSoloGestion && !puedeGestionar(req)) throw prohibido('No tenés permiso para crear tickets.');
    const validos = (await listarUsuarios()).map(u => u.usuario);
    // Desde acá sincrónico: leer → modificar → guardar.
    const { lista, ticket } = tickets.crearTicket(leerTickets(), req.body, usuarioSesion(req), validos, new Date().toISOString());
    guardarJSON(TICKETS_PATH, lista);
    return ticket;
  }, 201));

  router.patch(`${api}/:id`, recibirArchivos, manejar(async req => {
    const id = idValido(req.params.id, 'ticket');
    const validos = (await listarUsuarios()).map(u => u.usuario);
    // Desde acá sincrónico: leer → modificar → guardar. `adjuntos` del cuerpo se descarta: solo vale lo que guardó este router.
    const { adjuntos: _descartado, ...pedido } = req.body || {};
    const actuales = leerTickets();
    tickets.verificarDestino(actuales, id, {}); // 404 antes de escribir archivos
    autorizarCambios(req, actuales.find(t => Number(t.id) === id), pedido);
    const ahora = new Date().toISOString();
    const aplicar = adjuntos => {
      const cambios = adjuntos ? { ...pedido, adjuntos } : pedido;
      const { lista, ticket } = tickets.actualizarTicket(actuales, id, cambios, usuarioSesion(req), validos, ahora);
      guardarJSON(TICKETS_PATH, lista);
      return ticket;
    };
    return req.files && req.files.length ? conArchivos(req, ahora, aplicar) : aplicar();
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

  // Adjuntos: la descripción (sin campo `nota`) o una nota (campo `nota` = índice en el historial). Responden el ticket completo.
  router.post(`${api}/:id/adjuntos`, recibirArchivos, manejar(req => {
    const id = idValido(req.params.id, 'ticket');
    const duenio = duenioDeAdjuntos(req.body);
    const actuales = leerTickets();
    tickets.verificarDestino(actuales, id, duenio); // 404 (ticket o nota) antes de escribir archivos
    autorizarAdjuntos(req, actuales.find(t => Number(t.id) === id), duenio);
    const ahora = new Date().toISOString();
    return conArchivos(req, ahora, metas => {
      const { lista, ticket } = tickets.agregarAdjuntos(actuales, id, duenio, metas, usuarioSesion(req), ahora);
      guardarJSON(TICKETS_PATH, lista);
      return ticket;
    });
  }, 201));

  router.delete(`${api}/:id/adjuntos/:adjId`, manejar(req => {
    const id = idValido(req.params.id, 'ticket');
    const adjId = idValido(req.params.adjId, 'adjunto');
    const actuales = leerTickets();
    const existente = actuales.find(t => Number(t.id) === id);
    if (existente) autorizarAdjuntos(req, existente, { nota: tickets.ubicarAdjunto(existente, adjId).nota });
    const { lista, ticket, adjunto } = tickets.quitarAdjunto(actuales, id, adjId, usuarioSesion(req), new Date().toISOString());
    guardarJSON(TICKETS_PATH, lista);
    borrarArchivos([adjunto.archivo]);
    return ticket;
  }));

  // Descarga: imágenes inline (vista previa, con nombre para "guardar como"), el resto como descarga. nosniff, CSP que bloquea todo
  // (si abren el archivo directo no ejecuta nada) y sin caché compartida; sin SVG (no está en la lista blanca).
  router.get(`${api}/:id/adjuntos/:adjId`, (req, res) => {
    try {
      const id = idValido(req.params.id, 'ticket');
      const adjId = idValido(req.params.adjId, 'adjunto');
      const ticket = leerTickets().find(t => Number(t.id) === id);
      if (!ticket) throw Object.assign(new Error(`No existe el ticket ${id}.`), { status: 404 });
      const { adjunto } = tickets.ubicarAdjunto(ticket, adjId);
      res.set({
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-cache',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      });
      res.attachment(adjunto.nombre);
      if (adjunto.mime.startsWith('image/')) res.set('Content-Disposition', res.get('Content-Disposition').replace(/^attachment/, 'inline'));
      res.type(adjunto.mime);
      res.sendFile(path.join(DIR_ADJUNTOS, path.basename(adjunto.archivo)), err => {
        if (!err || res.headersSent) return;
        res.removeHeader('Content-Disposition'); // el 404 es JSON: sin descarga ni el mime del adjunto
        res.type('json');
        res.status(404).json({ error: 'El archivo ya no está en el servidor.' });
      });
    } catch (e) {
      if (!e.status) console.error(`[${etiqueta}]`, e);
      res.status(e.status || 500).json({ error: mensajeSeguro(e) });
    }
  });

  return router;
};
