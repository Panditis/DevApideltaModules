'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

// Router real sobre un express efímero, DATA_DIR temporal y un `query` falso que imita la
// tabla Usuarios de SIGA. La sesión se simula con un middleware que fija req.session.user.
const FILAS_SIGA = [
  { Id: 'Adriel ', Nombre: ' Adriel Sanabria' },
  { Id: 'beto', Nombre: null },
];

// sql.falla = true hace que la próxima query reviente (SIGA caído).
// sesion.user y sesion.permiso se pueden cambiar entre pedidos (otro usuario / sin permiso de gestión).
// config: opciones extra de la factory (instancia de Mantenimiento); config.permiso es el ref que acepta tienePermiso.
function montar({ ttlMs, permiso = true, config = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-'));
  const leerJSON = (p, def) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : def);
  const guardarJSON = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2));
  const sql = { falla: false, llamadas: 0 };
  const query = async q => {
    sql.llamadas++;
    assert.match(q, /SELECT Id, Nombre FROM Usuarios WHERE Activo = 1/);
    if (sql.falla) throw new Error('SIGA caído');
    return FILAS_SIGA;
  };
  const sesion = { user: { usuario: 'adriel', nombre: 'Adriel S.' }, permiso };
  const refGestion = config.permiso || 'tickets-gestion';
  const tienePermiso = (user, ref) => !!user && ref === refGestion && sesion.permiso;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = sesion.user ? { user: sesion.user } : {}; next(); });
  app.use(require('../routes/rutas_tickets')({ leerJSON, guardarJSON, DATA_DIR: dir, query, ttlMs, tienePermiso, ...config }));
  return new Promise(ok => {
    const server = app.listen(0, () => ok({ server, dir, sql, sesion, base: `http://127.0.0.1:${server.address().port}${config.api || '/api/tickets'}` }));
  });
}

async function pedir(base, metodo, url, body) {
  const r = await fetch(base + url, {
    method: metodo, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json() };
}

function cerrar({ server, dir }) {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

const NUEVO = { tarea: 'Exportar xlsx', prioridad: 'media', area: 'Precios', descripcion: '', destinatarios: ['beto'] };

test('meta mapea usuarios de SIGA (trim, Nombre||Id) y resuelve yo case-insensitive', async () => {
  const ctx = await montar();
  try {
    const { status, data } = await pedir(ctx.base, 'GET', '/meta');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(data.usuarios, [
      { usuario: 'Adriel', nombre: 'Adriel Sanabria' },
      { usuario: 'beto', nombre: 'beto' },
    ]);
    assert.strictEqual(data.yo, 'Adriel');
    assert.strictEqual(data.yoNombre, 'Adriel S.');
    assert.strictEqual(data.prioridades.length, 4);
    assert.strictEqual(data.estados.length, 6);
    assert.ok(data.areas.includes('Compras'));
    assert.strictEqual(data.puedeCrear, true); // /tickets: crear no pide gestión
    // Segunda llamada dentro del TTL: no vuelve a consultar SIGA.
    await pedir(ctx.base, 'GET', '/meta');
    assert.strictEqual(ctx.sql.llamadas, 1);
  } finally { cerrar(ctx); }
});

test('alta, listado, PATCH de estado + nota y errores', async () => {
  const ctx = await montar();
  const { base } = ctx;
  try {
    assert.deepStrictEqual((await pedir(base, 'GET', '')).data, []);

    const alta = await pedir(base, 'POST', '', { ...NUEVO, destinatarios: ['beto', 'Adriel'] });
    assert.strictEqual(alta.status, 201);
    assert.strictEqual(alta.data.id, 1);
    assert.strictEqual(alta.data.creadoPor, 'adriel');

    const invalido = await pedir(base, 'POST', '', { ...NUEVO, destinatarios: [] });
    assert.strictEqual(invalido.status, 400);
    assert.match(invalido.data.error, /destinatario/);

    const patch = await pedir(base, 'PATCH', '/1', { estado: 'terminado', nota: 'listo' });
    assert.strictEqual(patch.status, 200);
    assert.strictEqual(patch.data.estado, 'terminado');
    assert.deepStrictEqual(patch.data.historial.map(h => h.tipo), ['creado', 'estado', 'nota']);

    const lista = (await pedir(base, 'GET', '')).data;
    assert.strictEqual(lista.length, 1);
    assert.strictEqual(lista[0].estado, 'terminado');

    assert.strictEqual((await pedir(base, 'PATCH', '/99', { estado: 'terminado' })).status, 404);
    assert.strictEqual((await pedir(base, 'PATCH', '/abc', { estado: 'terminado' })).status, 400);
    assert.strictEqual((await pedir(base, 'PATCH', '/0', { estado: 'terminado' })).status, 400);
  } finally { cerrar(ctx); }
});

test('SIGA caído sin caché → 503 en meta y POST, sin escribir tickets', async () => {
  const ctx = await montar();
  ctx.sql.falla = true;
  try {
    const meta = await pedir(ctx.base, 'GET', '/meta');
    assert.strictEqual(meta.status, 503);
    assert.strictEqual(meta.data.error, 'No se pudieron leer los usuarios de SIGA.');
    assert.strictEqual((await pedir(ctx.base, 'POST', '', NUEVO)).status, 503);
    assert.deepStrictEqual((await pedir(ctx.base, 'GET', '')).data, []);
  } finally { cerrar(ctx); }
});

test('SIGA caído con caché vieja → usa la caché', async () => {
  const ctx = await montar({ ttlMs: 0 }); // TTL 0: cada pedido intenta SIGA de nuevo
  try {
    assert.strictEqual((await pedir(ctx.base, 'GET', '/meta')).status, 200);
    ctx.sql.falla = true;
    const meta = await pedir(ctx.base, 'GET', '/meta');
    assert.strictEqual(meta.status, 200);
    assert.strictEqual(meta.data.usuarios.length, 2);
    assert.strictEqual((await pedir(ctx.base, 'POST', '', NUEVO)).status, 201);
    assert.strictEqual(ctx.sql.llamadas, 3);
  } finally { cerrar(ctx); }
});

test('PERMISOS_EXTRA trae tickets-gestion asignable desde /admin', () => {
  const p = require('../lib/auth').PERMISOS_EXTRA.find(x => x.ref === 'tickets-gestion');
  assert.deepStrictEqual(p, { ref: 'tickets-gestion', titulo: 'Tickets · Gestión', modulo: 'tickets' });
});

test('meta informa puedeGestionar y login de la sesión', async () => {
  const ctx = await montar({ permiso: false });
  try {
    let { data } = await pedir(ctx.base, 'GET', '/meta');
    assert.strictEqual(data.puedeGestionar, false);
    assert.strictEqual(data.login, 'adriel');
    ctx.sesion.permiso = true;
    ({ data } = await pedir(ctx.base, 'GET', '/meta'));
    assert.strictEqual(data.puedeGestionar, true);
    ctx.sesion.user = null; // sin sesión: sin permiso aunque el fake diría que sí
    ({ data } = await pedir(ctx.base, 'GET', '/meta'));
    assert.strictEqual(data.puedeGestionar, false);
    assert.strictEqual(data.login, null);
  } finally { cerrar(ctx); }
});

test('sin permiso de gestión: no cambia estado; destinatarios solo el creador; notas sí', async () => {
  const ctx = await montar({ permiso: false });
  const { base } = ctx;
  const leer = () => JSON.parse(fs.readFileSync(path.join(ctx.dir, 'tickets.json'), 'utf8'))[0];
  try {
    assert.strictEqual((await pedir(base, 'POST', '', NUEVO)).status, 201); // creado por 'adriel'

    const est = await pedir(base, 'PATCH', '/1', { estado: 'terminado', nota: 'listo' });
    assert.strictEqual(est.status, 403);
    assert.strictEqual(est.data.error, 'No tenés permiso para cambiar el estado de los tickets.');
    assert.strictEqual(leer().estado, 'pendiente');
    assert.strictEqual(leer().historial.length, 1); // ni la nota del mismo body se guardó

    ctx.sesion.user = { usuario: 'ADRIEL' }; // el creador, con otra capitalización
    const propio = await pedir(base, 'PATCH', '/1', { destinatarios: ['Adriel'] });
    assert.strictEqual(propio.status, 200);
    assert.deepStrictEqual(propio.data.destinatarios, ['Adriel']);

    ctx.sesion.user = { usuario: 'beto' };
    const ajeno = await pedir(base, 'PATCH', '/1', { destinatarios: ['beto'] });
    assert.strictEqual(ajeno.status, 403);
    assert.strictEqual(ajeno.data.error, 'Solo el creador del ticket o quien tenga el permiso de gestión puede cambiar los destinatarios.');
    assert.deepStrictEqual(leer().destinatarios, ['Adriel']);

    const nota = await pedir(base, 'PATCH', '/1', { nota: 'una duda' });
    assert.strictEqual(nota.status, 200);
    assert.strictEqual((await pedir(base, 'PATCH', '/99', { estado: 'terminado' })).status, 404);

    ctx.sesion.permiso = true; // con permiso: estado y destinatarios de un ticket ajeno
    const gestion = await pedir(base, 'PATCH', '/1', { estado: 'en_proceso', destinatarios: ['beto'] });
    assert.strictEqual(gestion.status, 200);
    assert.strictEqual(gestion.data.estado, 'en_proceso');
    assert.deepStrictEqual(gestion.data.destinatarios, ['beto']);
  } finally { cerrar(ctx); }
});

test('destinatarios: Id de SIGA sin distinguir mayúsculas se normaliza y un nombre libre se acepta como externo', async () => {
  const ctx = await montar();
  try {
    const alta = await pedir(ctx.base, 'POST', '', { ...NUEVO, destinatarios: ['BETO', ' Proveedor X '] });
    assert.strictEqual(alta.status, 201);
    assert.deepStrictEqual(alta.data.destinatarios, ['beto', 'Proveedor X']);
    const rep = await pedir(ctx.base, 'POST', '', { ...NUEVO, destinatarios: ['Pepe', 'pepe'] });
    assert.strictEqual(rep.status, 400);
    assert.match(rep.data.error, /repetido/i);
  } finally { cerrar(ctx); }
});

test('meta trae los estados de etapa', async () => {
  const ctx = await montar();
  try {
    const { data } = await pedir(ctx.base, 'GET', '/meta');
    assert.deepStrictEqual(data.estadosEtapa, [
      { valor: 'pendiente', etiqueta: 'Pendiente' },
      { valor: 'en_proceso', etiqueta: 'En proceso' },
      { valor: 'terminado', etiqueta: 'Terminado' },
    ]);
  } finally { cerrar(ctx); }
});

test('etapas: alta 201, cambio 200, auto falta_aprobacion, bloqueo manual 400, reapertura, baja 200 y 404', async () => {
  const ctx = await montar();
  const { base } = ctx;
  try {
    assert.strictEqual((await pedir(base, 'POST', '', NUEVO)).status, 201);
    const a = await pedir(base, 'POST', '/1/etapas', { nombre: 'Relevar' });
    assert.strictEqual(a.status, 201);
    assert.deepStrictEqual(a.data.etapas.map(e => [e.id, e.nombre, e.estado]), [[1, 'Relevar', 'pendiente']]);
    assert.strictEqual((await pedir(base, 'POST', '/1/etapas', { nombre: 'Programar' })).status, 201);

    const manual = await pedir(base, 'PATCH', '/1', { estado: 'terminado' });
    assert.strictEqual(manual.status, 400);
    assert.strictEqual(manual.data.error, 'Faltan 2 etapas por terminar.');

    const e1 = await pedir(base, 'PATCH', '/1/etapas/1', { estado: 'terminado' });
    assert.strictEqual(e1.status, 200);
    assert.strictEqual(e1.data.estado, 'pendiente');
    const e2 = await pedir(base, 'PATCH', '/1/etapas/2', { estado: 'terminado', nombre: 'Programar y probar' });
    assert.strictEqual(e2.status, 200);
    assert.strictEqual(e2.data.estado, 'falta_aprobacion');
    assert.strictEqual(e2.data.etapas[1].nombre, 'Programar y probar');
    const auto = e2.data.historial[e2.data.historial.length - 1];
    assert.deepStrictEqual([auto.tipo, auto.de, auto.a, auto.auto, auto.usuario], ['estado', 'pendiente', 'falta_aprobacion', true, 'adriel']);

    const reabre = await pedir(base, 'PATCH', '/1/etapas/2', { estado: 'en_proceso' });
    assert.strictEqual(reabre.data.estado, 'en_proceso');
    const sinCambio = await pedir(base, 'PATCH', '/1/etapas/2', { estado: 'en_proceso' });
    assert.strictEqual(sinCambio.status, 400);

    const baja = await pedir(base, 'DELETE', '/1/etapas/2');
    assert.strictEqual(baja.status, 200);
    assert.strictEqual(baja.data.estado, 'falta_aprobacion'); // quedó sólo la terminada
    assert.deepStrictEqual(baja.data.etapas.map(e => e.id), [1]);

    assert.strictEqual((await pedir(base, 'PATCH', '/1/etapas/2', { estado: 'terminado' })).status, 404);
    assert.strictEqual((await pedir(base, 'DELETE', '/1/etapas/2')).status, 404);
    assert.strictEqual((await pedir(base, 'POST', '/9/etapas', { nombre: 'X' })).status, 404);
    assert.strictEqual((await pedir(base, 'PATCH', '/1/etapas/abc', { estado: 'terminado' })).status, 400);
    assert.strictEqual((await pedir(base, 'POST', '/1/etapas', { nombre: ' ' })).status, 400);

    // Persistido en disco.
    const disco = JSON.parse(fs.readFileSync(path.join(ctx.dir, 'tickets.json'), 'utf8'))[0];
    assert.strictEqual(disco.estado, 'falta_aprobacion');
    assert.strictEqual(disco.etapas.length, 1);

    // Ticket cerrado: no se agregan ni cambian etapas.
    assert.strictEqual((await pedir(base, 'PATCH', '/1', { estado: 'terminado' })).status, 200);
    const cerrado = await pedir(base, 'POST', '/1/etapas', { nombre: 'Tarde' });
    assert.strictEqual(cerrado.status, 400);
    assert.match(cerrado.data.error, /terminado/i);
    assert.strictEqual((await pedir(base, 'PATCH', '/1/etapas/1', { estado: 'pendiente' })).status, 400);
  } finally { cerrar(ctx); }
});

test('etapas sin permiso de gestión → 403 y nada se escribe', async () => {
  const ctx = await montar();
  const { base } = ctx;
  try {
    assert.strictEqual((await pedir(base, 'POST', '', NUEVO)).status, 201);
    assert.strictEqual((await pedir(base, 'POST', '/1/etapas', { nombre: 'Relevar' })).status, 201);
    ctx.sesion.permiso = false;
    const msg = 'No tenés permiso para gestionar etapas.';
    for (const [metodo, url, body] of [['POST', '/1/etapas', { nombre: 'X' }], ['PATCH', '/1/etapas/1', { estado: 'terminado' }], ['DELETE', '/1/etapas/1'], ['POST', '/9/etapas', { nombre: 'X' }]]) {
      const r = await pedir(base, metodo, url, body);
      assert.strictEqual(r.status, 403, `${metodo} ${url}`);
      assert.strictEqual(r.data.error, msg);
    }
    const disco = JSON.parse(fs.readFileSync(path.join(ctx.dir, 'tickets.json'), 'utf8'))[0];
    assert.deepStrictEqual(disco.etapas.map(e => [e.nombre, e.estado]), [['Relevar', 'pendiente']]);
  } finally { cerrar(ctx); }
});

test('prioridad: el creador sin permiso la cambia (case-insensitive); otro sin permiso 403 sin escribir; con permiso 200', async () => {
  const ctx = await montar({ permiso: false });
  const { base } = ctx;
  const leer = () => JSON.parse(fs.readFileSync(path.join(ctx.dir, 'tickets.json'), 'utf8'))[0];
  try {
    assert.strictEqual((await pedir(base, 'POST', '', NUEVO)).status, 201); // creado por 'adriel', prioridad media

    ctx.sesion.user = { usuario: 'ADRIEL' };
    const propio = await pedir(base, 'PATCH', '/1', { prioridad: 'urgente' });
    assert.strictEqual(propio.status, 200);
    assert.strictEqual(propio.data.prioridad, 'urgente');
    const h = propio.data.historial[propio.data.historial.length - 1];
    assert.deepStrictEqual([h.tipo, h.de, h.a, h.usuario], ['prioridad', 'media', 'urgente', 'ADRIEL']);

    ctx.sesion.user = { usuario: 'beto' };
    const ajeno = await pedir(base, 'PATCH', '/1', { prioridad: 'baja', nota: 'de paso' });
    assert.strictEqual(ajeno.status, 403);
    assert.strictEqual(ajeno.data.error, 'Solo el creador del ticket o quien tenga el permiso de gestión puede cambiar la prioridad.');
    assert.strictEqual(leer().prioridad, 'urgente');
    assert.strictEqual(leer().historial.length, 2); // ni la nota del mismo body se guardó

    ctx.sesion.permiso = true;
    const gestion = await pedir(base, 'PATCH', '/1', { prioridad: 'baja' });
    assert.strictEqual(gestion.status, 200);
    assert.strictEqual(leer().prioridad, 'baja');
    assert.strictEqual((await pedir(base, 'PATCH', '/1', { prioridad: 'baja' })).status, 400); // misma: sin cambios
    const invalida = await pedir(base, 'PATCH', '/1', { prioridad: 'altísima' });
    assert.strictEqual(invalida.status, 400);
    assert.match(invalida.data.error, /prioridad/);
  } finally { cerrar(ctx); }
});

test('instancia de Mantenimiento: datos en mantenimiento.json, sus áreas y su permiso de gestión', async () => {
  const { AREAS_MANTENIMIENTO } = require('../lib/tickets');
  const ctx = await montar({ permiso: false, config: {
    api: '/api/sucursales/mantenimiento', archivo: 'mantenimiento.json', permiso: 'mantenimiento-gestion',
    areas: AREAS_MANTENIMIENTO, etiqueta: 'mantenimiento', crearSoloGestion: true,
  } });
  const { base } = ctx;
  try {
    const meta = await pedir(base, 'GET', '/meta');
    assert.strictEqual(meta.status, 200);
    assert.deepStrictEqual(meta.data.areas, AREAS_MANTENIMIENTO);
    assert.ok(meta.data.areas.includes('Plomería'));
    assert.strictEqual(meta.data.puedeCrear, false);

    // Sin permiso de gestión no se da de alta (crearSoloGestion) y no se toca el archivo.
    assert.strictEqual((await pedir(base, 'POST', '', { ...NUEVO, area: 'Plomería' })).status, 403);
    assert.ok(!fs.existsSync(path.join(ctx.dir, 'mantenimiento.json')));

    ctx.sesion.permiso = true; // tienePermiso sólo acepta 'mantenimiento-gestion'
    assert.strictEqual((await pedir(base, 'GET', '/meta')).data.puedeCrear, true);
    assert.strictEqual((await pedir(base, 'POST', '', { ...NUEVO, area: 'Plomería' })).status, 201);
    assert.ok(fs.existsSync(path.join(ctx.dir, 'mantenimiento.json')));
    assert.ok(!fs.existsSync(path.join(ctx.dir, 'tickets.json')));

    ctx.sesion.permiso = false;
    assert.strictEqual((await pedir(base, 'PATCH', '/1', { estado: 'en_proceso' })).status, 403);
    ctx.sesion.permiso = true;
    const ok = await pedir(base, 'PATCH', '/1', { estado: 'en_proceso' });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(ctx.dir, 'mantenimiento.json'), 'utf8'))[0].estado, 'en_proceso');
  } finally { cerrar(ctx); }
});

test('PERMISOS_EXTRA trae mantenimiento-gestion colgado de sucursales', () => {
  const p = require('../lib/auth').PERMISOS_EXTRA.find(x => x.ref === 'mantenimiento-gestion');
  assert.deepStrictEqual(p, { ref: 'mantenimiento-gestion', titulo: 'Mantenimiento · Gestión', modulo: 'sucursales' });
});
