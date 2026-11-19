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
    assert.strictEqual(data.soloUsuarios, false); // /tickets sigue aceptando externos
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
    assert.deepStrictEqual(meta.data.areas, ['Mantenimiento', 'Sistemas']);
    assert.strictEqual(meta.data.puedeCrear, false);

    // Sin permiso de gestión no se da de alta (crearSoloGestion) y no se toca el archivo.
    assert.strictEqual((await pedir(base, 'POST', '', { ...NUEVO, area: 'Sistemas' })).status, 403);
    assert.ok(!fs.existsSync(path.join(ctx.dir, 'mantenimiento.json')));

    ctx.sesion.permiso = true; // tienePermiso sólo acepta 'mantenimiento-gestion'
    assert.strictEqual((await pedir(base, 'GET', '/meta')).data.puedeCrear, true);
    assert.strictEqual((await pedir(base, 'POST', '', { ...NUEVO, area: 'Sistemas' })).status, 201);
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

test('instancia con `usuarios` propios: destinatarios y "yo" salen de esa lista y SIGA no se consulta', async () => {
  const cuentas = [{ usuario: 'SucursalUrquiza', nombre: 'Urquiza' }, { usuario: 'Mantenimiento', nombre: 'Mantenimiento' }];
  const ctx = await montar({ config: { usuarios: () => cuentas } });
  const { base } = ctx;
  try {
    ctx.sesion.user = { usuario: 'sucursalurquiza', nombre: 'Urquiza' };
    const meta = await pedir(base, 'GET', '/meta');
    assert.deepStrictEqual(meta.data.usuarios, cuentas);
    assert.strictEqual(meta.data.soloUsuarios, true);
    assert.strictEqual(meta.data.yo, 'SucursalUrquiza');
    const ok = await pedir(base, 'POST', '', { ...NUEVO, destinatarios: ['SucursalUrquiza'] });
    assert.strictEqual(ok.status, 201);
    assert.deepStrictEqual(ok.data.destinatarios, ['SucursalUrquiza']);
    assert.strictEqual(ctx.sql.llamadas, 0);
  } finally { cerrar(ctx); }
});

test('PERMISOS_EXTRA trae mantenimiento-gestion colgado de sucursales', () => {
  const p = require('../lib/auth').PERMISOS_EXTRA.find(x => x.ref === 'mantenimiento-gestion');
  assert.deepStrictEqual(p, { ref: 'mantenimiento-gestion', titulo: 'Mantenimiento · Gestión', modulo: 'sucursales' });
});

// ── Adjuntos ────────────────────────────────────────────────────────────────
// multipart real: FormData/Blob globales de Node. `archivos` = [{ nombre, datos }]; `campos` = campos de texto.
async function subir(base, metodo, url, archivos, campos = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(campos)) fd.append(k, v);
  for (const a of archivos) fd.append('archivos', new Blob([a.datos || 'x']), a.nombre);
  const r = await fetch(base + url, { method: metodo, body: fd });
  return { status: r.status, data: await r.json() };
}
const PNG = { nombre: 'captura.png', datos: Buffer.from([0x89, 0x50, 0x4e, 0x47]) };
const archivosEn = (ctx, carpeta = 'tickets_adjuntos') => {
  const d = path.join(ctx.dir, carpeta);
  return fs.existsSync(d) ? fs.readdirSync(d) : [];
};

test('adjuntos de la descripción: subir, listar sin ruta interna, descargar y quitar', async () => {
  const ctx = await montar();
  const { base } = ctx;
  try {
    await pedir(base, 'POST', '', NUEVO);
    const subido = await subir(base, 'POST', '/1/adjuntos', [PNG, { nombre: 'señal Ñandú.pdf', datos: '%PDF-1' }]);
    assert.strictEqual(subido.status, 201);
    assert.deepStrictEqual(subido.data.adjuntos.map(a => [a.id, a.nombre, a.mime, a.subidoPor]), [
      [1, 'captura.png', 'image/png', 'adriel'],
      [2, 'señal Ñandú.pdf', 'application/pdf', 'adriel'],
    ]);
    assert.ok(subido.data.adjuntos.every(a => !('archivo' in a)));
    assert.strictEqual(subido.data.historial.at(-1).tipo, 'adjunto');
    assert.strictEqual(archivosEn(ctx).length, 2);
    assert.ok((await pedir(base, 'GET', '')).data[0].adjuntos.every(a => !('archivo' in a)));

    const png = await fetch(`${base}/1/adjuntos/1`);
    assert.strictEqual(png.status, 200);
    assert.strictEqual(png.headers.get('content-type'), 'image/png');
    assert.strictEqual(png.headers.get('content-disposition'), 'inline; filename="captura.png"'); // inline, pero con nombre
    assert.strictEqual(png.headers.get('x-content-type-options'), 'nosniff');
    assert.deepStrictEqual([...new Uint8Array(await png.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47]);
    const pdf = await fetch(`${base}/1/adjuntos/2`);
    assert.match(pdf.headers.get('content-disposition'), /^attachment;/);
    // Express: un nombre solo-Latin-1 va en `filename` (header en latin1); `filename*` aparece recién con caracteres fuera de Latin-1.
    assert.strictEqual(pdf.headers.get('content-disposition'), 'attachment; filename="señal Ñandú.pdf"');
    await pdf.arrayBuffer();

    const quitado = await pedir(base, 'DELETE', '/1/adjuntos/1');
    assert.strictEqual(quitado.status, 200);
    assert.deepStrictEqual(quitado.data.adjuntos.map(a => a.id), [2]);
    assert.strictEqual(archivosEn(ctx).length, 1);
    assert.strictEqual((await fetch(`${base}/1/adjuntos/1`)).status, 404);
    assert.strictEqual((await pedir(base, 'DELETE', '/1/adjuntos/1')).status, 404);
  } finally { cerrar(ctx); }
});

test('adjuntos: rechaza extensión no permitida, más de 5, más de 10 MB y pedidos sin archivos', async () => {
  const ctx = await montar();
  const { base } = ctx;
  try {
    await pedir(base, 'POST', '', NUEVO);
    const exe = await subir(base, 'POST', '/1/adjuntos', [{ nombre: 'virus.exe', datos: 'MZ' }]);
    assert.strictEqual(exe.status, 400);
    assert.match(exe.data.error, /virus\.exe/);
    const seis = await subir(base, 'POST', '/1/adjuntos', Array.from({ length: 6 }, (_, i) => ({ nombre: `a${i}.png`, datos: 'x' })));
    assert.strictEqual(seis.status, 400);
    assert.match(seis.data.error, /5 archivos/);
    const pesado = await subir(base, 'POST', '/1/adjuntos', [{ nombre: 'grande.pdf', datos: Buffer.alloc(10 * 1024 * 1024 + 1) }]);
    assert.strictEqual(pesado.status, 400);
    assert.match(pesado.data.error, /10 MB/);
    assert.strictEqual((await subir(base, 'POST', '/1/adjuntos', [])).status, 400);
    assert.strictEqual((await pedir(base, 'POST', '/1/adjuntos', {})).status, 400); // JSON sin archivos
    assert.strictEqual((await subir(base, 'POST', '/1/adjuntos', [PNG], { nota: 'abc' })).status, 400);
    assert.strictEqual((await subir(base, 'POST', '/99/adjuntos', [PNG])).status, 404);
    assert.strictEqual(archivosEn(ctx).length, 0); // nada quedó en disco
  } finally { cerrar(ctx); }
});

test('PATCH multipart: nota con archivo (con o sin texto), rollback si la nota es inválida e ignora adjuntos falsos del JSON', async () => {
  const ctx = await montar();
  const { base } = ctx;
  try {
    await pedir(base, 'POST', '', NUEVO);
    const conTexto = await subir(base, 'PATCH', '/1', [PNG], { nota: 'adjunto la captura' });
    assert.strictEqual(conTexto.status, 200);
    const evento = conTexto.data.historial.at(-1);
    assert.strictEqual(evento.nota, 'adjunto la captura');
    assert.deepStrictEqual(evento.adjuntos.map(a => [a.id, a.nombre]), [[1, 'captura.png']]);
    assert.ok(!('archivo' in evento.adjuntos[0]));

    const soloArchivo = await subir(base, 'PATCH', '/1', [PNG], {});
    assert.strictEqual(soloArchivo.status, 200);
    assert.strictEqual(soloArchivo.data.historial.at(-1).nota, '');
    assert.strictEqual(archivosEn(ctx).length, 2);

    const largo = await subir(base, 'PATCH', '/1', [PNG], { nota: 'x'.repeat(2001) });
    assert.strictEqual(largo.status, 400);
    assert.strictEqual(archivosEn(ctx).length, 2); // el archivo de la nota rechazada no queda en disco

    const sinArchivos = await pedir(base, 'PATCH', '/1', { nota: 'sin archivos' });
    assert.strictEqual(sinArchivos.status, 200);
    assert.strictEqual(sinArchivos.data.historial.at(-1).adjuntos, undefined);

    const falso = await pedir(base, 'PATCH', '/1', { nota: 'x', adjuntos: [{ nombre: 'a.png', archivo: '../../etc/passwd' }] });
    assert.strictEqual(falso.status, 200);
    assert.strictEqual(falso.data.historial.at(-1).adjuntos, undefined); // el cliente no puede inyectar metadatos
  } finally { cerrar(ctx); }
});

test('adjuntos: descripción para creador o gestión; nota para su autor o gestión; descargar, cualquiera', async () => {
  const ctx = await montar();
  const { base, sesion } = ctx;
  try {
    await pedir(base, 'POST', '', NUEVO); // creador: adriel
    sesion.user = { usuario: 'beto' };
    sesion.permiso = false;
    assert.strictEqual((await subir(base, 'POST', '/1/adjuntos', [PNG])).status, 403);
    const nota = await subir(base, 'PATCH', '/1', [PNG], { nota: 'mirá' }); // notas: cualquiera con el módulo
    assert.strictEqual(nota.status, 200);
    const idxNota = nota.data.historial.findIndex(h => h.tipo === 'nota');
    assert.strictEqual(idxNota, 1);
    assert.strictEqual((await subir(base, 'POST', '/1/adjuntos', [PNG], { nota: String(idxNota) })).status, 201); // su autor

    sesion.user = { usuario: 'caro' };
    assert.strictEqual((await subir(base, 'POST', '/1/adjuntos', [PNG], { nota: String(idxNota) })).status, 403);
    assert.strictEqual((await pedir(base, 'DELETE', '/1/adjuntos/1')).status, 403);
    const descarga = await fetch(`${base}/1/adjuntos/1`);
    assert.strictEqual(descarga.status, 200);
    await descarga.arrayBuffer();

    sesion.permiso = true; // gestión
    assert.strictEqual((await pedir(base, 'DELETE', '/1/adjuntos/1')).status, 200);
    assert.strictEqual((await subir(base, 'POST', '/1/adjuntos', [PNG])).status, 201);
  } finally { cerrar(ctx); }
});

test('la instancia de Mantenimiento guarda sus adjuntos en mantenimiento_adjuntos', async () => {
  const ctx = await montar({ config: {
    api: '/api/sucursales/mantenimiento', pagina: '/sucursales/mantenimiento', archivo: 'mantenimiento.json',
    permiso: 'mantenimiento-gestion', etiqueta: 'mantenimiento',
  } });
  try {
    await pedir(ctx.base, 'POST', '', NUEVO);
    assert.strictEqual((await subir(ctx.base, 'POST', '/1/adjuntos', [PNG])).status, 201);
    assert.strictEqual(archivosEn(ctx, 'mantenimiento_adjuntos').length, 1);
    assert.strictEqual(archivosEn(ctx).length, 0);
  } finally { cerrar(ctx); }
});

test('sirve el JS de adjuntos del front', async () => {
  const ctx = await montar();
  try {
    const r = await fetch(`${ctx.base.replace('/api/tickets', '')}/js/tickets_adjuntos.js`);
    assert.strictEqual(r.status, 200);
    await r.text();
  } finally { cerrar(ctx); }
});

test('adjuntos: si guardarJSON falla, los archivos recién escritos se borran del disco (POST y PATCH multipart)', async () => {
  let discoLleno = false;
  const guardarJSON = (p, d) => {
    if (discoLleno) throw new Error('disco lleno');
    fs.writeFileSync(p, JSON.stringify(d, null, 2));
  };
  const ctx = await montar({ config: { guardarJSON } });
  const { base } = ctx;
  const consolaError = console.error;
  console.error = () => {}; // el router loguea el 500; acá es lo esperado
  try {
    await pedir(base, 'POST', '', NUEVO);
    discoLleno = true;
    const post = await subir(base, 'POST', '/1/adjuntos', [PNG, { nombre: 'b.pdf', datos: '%PDF-1' }]);
    assert.strictEqual(post.status, 500);
    assert.strictEqual(archivosEn(ctx).length, 0);
    const patch = await subir(base, 'PATCH', '/1', [PNG], { nota: 'con archivo' });
    assert.strictEqual(patch.status, 500);
    assert.strictEqual(archivosEn(ctx).length, 0);

    discoLleno = false; // el ticket quedó como estaba: sin adjuntos ni eventos nuevos
    const [ticket] = (await pedir(base, 'GET', '')).data;
    assert.deepStrictEqual(ticket.adjuntos, []);
    assert.strictEqual(ticket.historial.length, 1);
  } finally { console.error = consolaError; cerrar(ctx); }
});

test('GET de un adjunto cuyo archivo ya no está en disco → 404 con mensaje claro', async () => {
  const ctx = await montar();
  const { base } = ctx;
  try {
    await pedir(base, 'POST', '', NUEVO);
    await subir(base, 'POST', '/1/adjuntos', [PNG, { nombre: 'a.pdf', datos: '%PDF-1' }]);
    for (const f of archivosEn(ctx)) fs.rmSync(path.join(ctx.dir, 'tickets_adjuntos', f)); // alguien limpió la carpeta a mano
    for (const adjId of [1, 2]) { // imagen (inline) y no imagen (attachment)
      const r = await fetch(`${base}/1/adjuntos/${adjId}`);
      assert.strictEqual(r.status, 404);
      assert.deepStrictEqual(await r.json(), { error: 'El archivo ya no está en el servidor.' });
    }
    // El metadato sigue: quitarlo con el archivo ya perdido anda igual (force: true en el borrado).
    assert.strictEqual((await pedir(base, 'DELETE', '/1/adjuntos/1')).status, 200);
  } finally { cerrar(ctx); }
});

test('adjuntos con nombre fuera de Latin-1 (emoji, raya larga): suben bien y la descarga trae filename*=UTF-8', async () => {
  const ctx = await montar();
  const { base } = ctx;
  try {
    await pedir(base, 'POST', '', NUEVO);
    const subido = await subir(base, 'POST', '/1/adjuntos', [
      { nombre: 'emoji 😀.png', datos: Buffer.from([0x89, 0x50]) },
      { nombre: 'título —.pdf', datos: '%PDF-1' },
      { nombre: 'emoji 😀.txt', datos: 'hola' },
    ]);
    assert.strictEqual(subido.status, 201);
    assert.deepStrictEqual(subido.data.adjuntos.map(a => a.nombre), ['emoji 😀.png', 'título —.pdf', 'emoji 😀.txt']);
    assert.strictEqual(archivosEn(ctx).length, 3);

    const pdf = await fetch(`${base}/1/adjuntos/2`);
    assert.strictEqual(pdf.status, 200);
    assert.match(pdf.headers.get('content-disposition'), /^attachment; /);
    assert.match(pdf.headers.get('content-disposition'), /filename\*=UTF-8''t%C3%ADtulo%20%E2%80%94\.pdf$/);
    await pdf.arrayBuffer();
    const txt = await fetch(`${base}/1/adjuntos/3`);
    assert.match(txt.headers.get('content-disposition'), /filename\*=UTF-8''emoji%20%F0%9F%98%80\.txt$/);
    assert.strictEqual(await txt.text(), 'hola');
    const png = await fetch(`${base}/1/adjuntos/1`); // las imágenes van inline, con el nombre igual (guardar como)
    assert.strictEqual(png.status, 200);
    assert.match(png.headers.get('content-disposition'), /^inline; .*filename\*=UTF-8''emoji%20%F0%9F%98%80\.png$/);
    await png.arrayBuffer();
  } finally { cerrar(ctx); }
});

test('PATCH multipart con estado o prioridad: sin gestión y sin ser el creador → 403 y nada queda en disco', async () => {
  const ctx = await montar();
  const { base, sesion } = ctx;
  try {
    await pedir(base, 'POST', '', NUEVO); // creador: adriel
    sesion.user = { usuario: 'beto' };
    sesion.permiso = false;
    const estado = await subir(base, 'PATCH', '/1', [PNG], { estado: 'en_proceso', nota: 'x' });
    assert.strictEqual(estado.status, 403);
    const prioridad = await subir(base, 'PATCH', '/1', [PNG], { prioridad: 'alta' });
    assert.strictEqual(prioridad.status, 403);
    assert.strictEqual(archivosEn(ctx).length, 0);
    const [intacto] = (await pedir(base, 'GET', '')).data;
    assert.deepStrictEqual([intacto.estado, intacto.prioridad, intacto.historial.length], ['pendiente', 'media', 1]);

    // El creador sin gestión sí cambia la prioridad (con archivo), pero no el estado.
    sesion.user = { usuario: 'adriel' };
    assert.strictEqual((await subir(base, 'PATCH', '/1', [PNG], { estado: 'en_proceso' })).status, 403);
    assert.strictEqual(archivosEn(ctx).length, 0);
    const propia = await subir(base, 'PATCH', '/1', [PNG], { prioridad: 'alta' });
    assert.strictEqual(propia.status, 200);
    assert.strictEqual(propia.data.prioridad, 'alta');
    assert.strictEqual(archivosEn(ctx).length, 1);
  } finally { cerrar(ctx); }
});

test('adjuntos: el creador sin gestión quita los de la descripción; los de una nota ajena no', async () => {
  const ctx = await montar({ permiso: false });
  const { base, sesion } = ctx;
  try {
    await pedir(base, 'POST', '', NUEVO); // creador: adriel, sin permiso de gestión
    assert.strictEqual((await subir(base, 'POST', '/1/adjuntos', [PNG])).status, 201);
    assert.strictEqual(archivosEn(ctx).length, 1);

    sesion.user = { usuario: 'beto' }; // ni creador ni gestión
    assert.strictEqual((await pedir(base, 'DELETE', '/1/adjuntos/1')).status, 403);
    assert.strictEqual(archivosEn(ctx).length, 1);
    const nota = await subir(base, 'PATCH', '/1', [PNG], { nota: 'de beto' }); // adjunto 2, en la nota del índice 2
    assert.strictEqual(nota.status, 200);

    sesion.user = { usuario: 'adriel' };
    assert.strictEqual((await pedir(base, 'DELETE', '/1/adjuntos/2')).status, 403); // ser creador no da derechos sobre la nota de otro
    const quitado = await pedir(base, 'DELETE', '/1/adjuntos/1');
    assert.strictEqual(quitado.status, 200);
    assert.deepStrictEqual(quitado.data.adjuntos, []);
    assert.strictEqual(quitado.data.historial.at(-1).accion, 'quitado');
    assert.strictEqual(archivosEn(ctx).length, 1); // solo queda el de la nota de beto
  } finally { cerrar(ctx); }
});

// ── Endurecimiento de la subida ─────────────────────────────────────────────
const sinCarpeta = ctx => !fs.existsSync(path.join(ctx.dir, 'tickets_adjuntos'));

test('multipart con campos de más (3 campos, nombre largo, valor de 20 KB) → 400 y nada en disco; la subida legítima sigue andando', async () => {
  const ctx = await montar();
  const { base } = ctx;
  try {
    await pedir(base, 'POST', '', NUEVO);
    const tres = await subir(base, 'POST', '/1/adjuntos', [PNG], { a: '1', b: '2', c: '3' });
    assert.strictEqual(tres.status, 400);
    assert.match(tres.data.error, /pedido no es válido/);
    for (const campo of ['a[4294967294]', 'a[1234567]']) { // el patrón del advisory de multer y uno de 10 caracteres (tope: 9)
      const nombreLargo = await subir(base, 'POST', '/1/adjuntos', [PNG], { [campo]: 'x' });
      assert.strictEqual(nombreLargo.status, 400, campo);
      assert.match(nombreLargo.data.error, /pedido no es válido/);
    }
    const grande = await subir(base, 'PATCH', '/1', [PNG], { nota: 'x'.repeat(20 * 1024) });
    assert.strictEqual(grande.status, 400);
    assert.match(grande.data.error, /pedido no es válido/);
    assert.ok(sinCarpeta(ctx), 'ningún pedido rechazado escribió en disco');

    const conNota = await subir(base, 'PATCH', '/1', [PNG], { nota: 'va con archivo' }); // nota + archivo
    assert.strictEqual(conNota.status, 200);
    const idx = conNota.data.historial.findIndex(h => h.tipo === 'nota');
    assert.strictEqual((await subir(base, 'POST', '/1/adjuntos', [PNG], { nota: String(idx) })).status, 201); // índice de nota + archivo
    assert.strictEqual(archivosEn(ctx).length, 2);
  } finally { cerrar(ctx); }
});

test('los 500 devuelven un mensaje genérico, sin rutas ni nombres del servidor (POST, PATCH y descarga)', async () => {
  const roto = { guardar: false, leer: false };
  const leerJSON = (p, def) => {
    if (roto.leer) throw new Error(`EPERM: operation not permitted, open '${p}'`);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : def;
  };
  const guardarJSON = (p, d) => {
    if (roto.guardar) throw new Error(`ENOSPC: no space left on device, write '${p}'`);
    fs.writeFileSync(p, JSON.stringify(d, null, 2));
  };
  const ctx = await montar({ config: { leerJSON, guardarJSON } });
  const { base } = ctx;
  const consolaError = console.error;
  console.error = () => {}; // el router loguea el detalle; acá es lo esperado
  try {
    await pedir(base, 'POST', '', NUEVO);
    await subir(base, 'POST', '/1/adjuntos', [PNG]);
    const GENERICO = { error: 'Error interno del servidor.' };

    roto.guardar = true;
    const post = await subir(base, 'POST', '/1/adjuntos', [PNG]);
    assert.strictEqual(post.status, 500);
    assert.deepStrictEqual(post.data, GENERICO);
    const patch = await pedir(base, 'PATCH', '/1', { nota: 'x' });
    assert.strictEqual(patch.status, 500);
    assert.deepStrictEqual(patch.data, GENERICO);
    roto.guardar = false;

    roto.leer = true;
    const descarga = await pedir(base, 'GET', '/1/adjuntos/1');
    assert.strictEqual(descarga.status, 500);
    assert.deepStrictEqual(descarga.data, GENERICO);
    assert.ok(![post, patch, descarga].some(r => JSON.stringify(r.data).includes(ctx.dir)));
  } finally { console.error = consolaError; cerrar(ctx); }
});

test('descarga: Cache-Control privado, CSP que bloquea todo, imagen inline con nombre y 404 de archivo faltante como JSON', async () => {
  const ctx = await montar();
  const { base } = ctx;
  try {
    await pedir(base, 'POST', '', NUEVO);
    await subir(base, 'POST', '/1/adjuntos', [PNG, { nombre: 'a.pdf', datos: '%PDF-1' }]);
    const png = await fetch(`${base}/1/adjuntos/1`);
    const pdf = await fetch(`${base}/1/adjuntos/2`);
    for (const r of [png, pdf]) {
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.headers.get('cache-control'), 'private, no-cache');
      assert.strictEqual(r.headers.get('content-security-policy'), "default-src 'none'; sandbox");
      assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
      await r.arrayBuffer();
    }
    assert.match(png.headers.get('content-disposition'), /^inline; filename="captura\.png"$/);
    assert.match(pdf.headers.get('content-disposition'), /^attachment; filename="a\.pdf"$/);

    for (const f of archivosEn(ctx)) fs.rmSync(path.join(ctx.dir, 'tickets_adjuntos', f));
    for (const adjId of [1, 2]) {
      const r = await fetch(`${base}/1/adjuntos/${adjId}`);
      assert.strictEqual(r.status, 404);
      assert.match(r.headers.get('content-type'), /^application\/json/);
      assert.strictEqual(r.headers.get('content-disposition'), null);
      assert.deepStrictEqual(await r.json(), { error: 'El archivo ya no está en el servidor.' });
    }
  } finally { cerrar(ctx); }
});

test('404 temprano: ticket o nota inexistente no escribe nada en disco (ni crea la carpeta)', async () => {
  const ctx = await montar();
  const { base, sesion } = ctx;
  try {
    await pedir(base, 'POST', '', NUEVO);
    assert.strictEqual((await subir(base, 'POST', '/99/adjuntos', [PNG])).status, 404);
    assert.strictEqual((await subir(base, 'POST', '/1/adjuntos', [PNG], { nota: '9' })).status, 404); // fuera de rango
    assert.strictEqual((await subir(base, 'POST', '/1/adjuntos', [PNG], { nota: '0' })).status, 404); // el evento 0 es "creado", no una nota
    assert.strictEqual((await subir(base, 'PATCH', '/99', [PNG], { nota: 'x' })).status, 404);
    sesion.user = { usuario: 'beto' };
    sesion.permiso = false;
    assert.strictEqual((await subir(base, 'POST', '/1/adjuntos', [PNG], { nota: '9' })).status, 404); // sin permisos tampoco cambia
    assert.ok(sinCarpeta(ctx));
  } finally { cerrar(ctx); }
});

test('multipart con Sec-Fetch-Site de otro origen → 403 sin escribir; same-origin y sin el header pasan', async () => {
  const ctx = await montar();
  const { base } = ctx;
  const enviar = async (metodo, url, sitio, campos = {}) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(campos)) fd.append(k, v);
    fd.append('archivos', new Blob(['x']), 'a.png');
    const r = await fetch(base + url, { method: metodo, body: fd, headers: sitio ? { 'Sec-Fetch-Site': sitio } : {} });
    return { status: r.status, data: await r.json() };
  };
  try {
    await pedir(base, 'POST', '', NUEVO);
    for (const sitio of ['cross-site', 'same-site', 'none']) {
      const post = await enviar('POST', '/1/adjuntos', sitio);
      assert.strictEqual(post.status, 403, `POST con ${sitio}`);
      assert.deepStrictEqual(post.data, { error: 'Pedido de otro origen rechazado.' });
      assert.strictEqual((await enviar('PATCH', '/1', sitio, { nota: 'x' })).status, 403, `PATCH con ${sitio}`);
    }
    assert.ok(sinCarpeta(ctx));
    assert.strictEqual((await enviar('POST', '/1/adjuntos', 'same-origin')).status, 201);
    assert.strictEqual((await enviar('PATCH', '/1', 'same-origin', { nota: 'x' })).status, 200);
    assert.strictEqual((await enviar('POST', '/1/adjuntos', null)).status, 201);
    assert.strictEqual(archivosEn(ctx).length, 3);
  } finally { cerrar(ctx); }
});

test('PATCH multipart sin archivos (solo la nota) con Sec-Fetch-Site de otro origen → 403; el mismo pedido same-origin anda', async () => {
  const ctx = await montar();
  const { base } = ctx;
  const patch = async sitio => {
    const fd = new FormData();
    fd.append('nota', 'sin archivos');
    const r = await fetch(`${base}/1`, { method: 'PATCH', body: fd, headers: { 'Sec-Fetch-Site': sitio } });
    return { status: r.status, data: await r.json() };
  };
  try {
    await pedir(base, 'POST', '', NUEVO);
    for (const sitio of ['cross-site', 'same-site']) {
      const r = await patch(sitio);
      assert.strictEqual(r.status, 403, sitio);
      assert.deepStrictEqual(r.data, { error: 'Pedido de otro origen rechazado.' });
    }
    assert.strictEqual((await pedir(base, 'GET', '')).data[0].historial.length, 1); // la nota rechazada no se guardó
    const ok = await patch('same-origin');
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.data.historial.at(-1).nota, 'sin archivos');
    assert.strictEqual(ok.data.historial.at(-1).adjuntos, undefined);
  } finally { cerrar(ctx); }
});

test('DELETE de adjuntos: ticket o adjunto inexistente → 404 (también sin permisos), id inválido → 400, nada cambia', async () => {
  const ctx = await montar({ permiso: false });
  const { base, sesion } = ctx;
  try {
    await pedir(base, 'POST', '', NUEVO); // creador: adriel
    assert.strictEqual((await subir(base, 'POST', '/1/adjuntos', [PNG])).status, 201);
    assert.strictEqual((await pedir(base, 'DELETE', '/99/adjuntos/1')).status, 404);
    assert.strictEqual((await pedir(base, 'DELETE', '/1/adjuntos/99')).status, 404);
    for (const url of ['/1/adjuntos/abc', '/1/adjuntos/0', '/x/adjuntos/1']) {
      assert.strictEqual((await pedir(base, 'DELETE', url)).status, 400, url);
    }
    sesion.user = { usuario: 'beto' }; // ni creador ni gestión: lo inexistente es 404, no 403
    assert.strictEqual((await pedir(base, 'DELETE', '/99/adjuntos/1')).status, 404);
    assert.strictEqual((await pedir(base, 'DELETE', '/1/adjuntos/99')).status, 404);
    assert.strictEqual((await pedir(base, 'DELETE', '/1/adjuntos/1')).status, 403);
    const [ticket] = (await pedir(base, 'GET', '')).data;
    assert.deepStrictEqual([ticket.adjuntos.length, ticket.historial.length, archivosEn(ctx).length], [1, 2, 1]);
  } finally { cerrar(ctx); }
});

test('los multipart que arma el front en su tope (5 archivos, nota vacía, nota de 2000 caracteres de 3 bytes, índice de nota) no chocan con los límites de multer', async () => {
  const ctx = await montar();
  const { base } = ctx;
  try {
    await pedir(base, 'POST', '', NUEVO);
    const cinco = prefijo => Array.from({ length: 5 }, (_, i) => ({ nombre: `${prefijo}${i}.png`, datos: 'x' }));
    const alta = await subir(base, 'POST', '/1/adjuntos', cinco('alta')); // alta: solo `archivos` x5
    assert.strictEqual(alta.status, 201);
    const soloArchivos = await subir(base, 'PATCH', '/1', cinco('nota'), { nota: '' }); // nota solo con archivos: `nota` vacía + x5
    assert.strictEqual(soloArchivos.status, 200);
    assert.strictEqual(soloArchivos.data.historial.at(-1).adjuntos.length, 5);
    const larga = await subir(base, 'PATCH', '/1', [PNG], { nota: '€'.repeat(2000) }); // 6000 bytes en UTF-8
    assert.strictEqual(larga.status, 200);
    assert.strictEqual(larga.data.historial.at(-1).nota.length, 2000);
    const idx = soloArchivos.data.historial.findIndex(h => h.tipo === 'nota');
    const aNota = await subir(base, 'POST', '/1/adjuntos', cinco('extra'), { nota: String(idx) }); // adjuntar a una nota: `nota` (índice) + x5
    assert.strictEqual(aNota.status, 201);
    assert.strictEqual(archivosEn(ctx).length, 16);
  } finally { cerrar(ctx); }
});

test('POST /reordenar y /:id/destacar: permisos, errores y JSON guardado', async () => {
  const ctx = await montar();
  const { base, dir } = ctx;
  const leer = () => JSON.parse(fs.readFileSync(path.join(dir, 'tickets.json'), 'utf8'));
  try {
    for (const p of ['media', 'media', 'alta']) await pedir(base, 'POST', '', { ...NUEVO, prioridad: p });
    const antes = leer();
    const r = await pedir(base, 'POST', '/reordenar', { id: 2, antesDe: 1 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.length, 3);
    const guardado = leer();
    assert.deepStrictEqual(guardado.map(t => [t.id, t.orden]), [[1, 2], [2, 1], [3, 3]]);
    assert.deepStrictEqual(guardado.map(t => t.historial), antes.map(t => t.historial));
    assert.strictEqual((await pedir(base, 'POST', '/reordenar', { id: 1, antesDe: null })).status, 200);
    assert.strictEqual((await pedir(base, 'POST', '/reordenar', { id: 1, antesDe: 3 })).status, 400);
    assert.strictEqual((await pedir(base, 'POST', '/reordenar', { id: 9, antesDe: null })).status, 404);
    assert.strictEqual((await pedir(base, 'POST', '/reordenar', { id: 'x' })).status, 400);

    const d = await pedir(base, 'POST', '/1/destacar', { destacado: true });
    assert.strictEqual(d.status, 200);
    assert.strictEqual(d.data.destacado, true);
    const t1 = leer().find(t => t.id === 1);
    const a1 = antes.find(t => t.id === 1);
    assert.strictEqual(t1.destacado, true);
    assert.strictEqual(t1.actualizadoEn, a1.actualizadoEn);
    assert.deepStrictEqual(t1.historial, a1.historial);
    assert.strictEqual((await pedir(base, 'POST', '/1/destacar', { destacado: 'si' })).status, 400);
    assert.strictEqual((await pedir(base, 'POST', '/9/destacar', { destacado: true })).status, 404);

    ctx.sesion.permiso = false;
    const p1 = await pedir(base, 'POST', '/reordenar', { id: 2, antesDe: null });
    assert.strictEqual(p1.status, 403);
    assert.match(p1.data.error, /reordenar/);
    const p2 = await pedir(base, 'POST', '/1/destacar', { destacado: false });
    assert.strictEqual(p2.status, 403);
    assert.match(p2.data.error, /destacar/);
  } finally { cerrar(ctx); }
});

test('Mantenimiento con areaCerrada y calendario: meta, área fuera de lista 400 y POST /:id/fecha', async () => {
  const { AREAS_MANTENIMIENTO } = require('../lib/tickets');
  const ctx = await montar({ config: {
    api: '/api/sucursales/mantenimiento', archivo: 'mantenimiento.json', permiso: 'mantenimiento-gestion',
    areas: AREAS_MANTENIMIENTO, crearSoloGestion: true, areaCerrada: true, calendario: true,
  } });
  const { base } = ctx;
  const leer = () => JSON.parse(fs.readFileSync(path.join(ctx.dir, 'mantenimiento.json'), 'utf8'));
  try {
    const meta = (await pedir(base, 'GET', '/meta')).data;
    assert.strictEqual(meta.areaCerrada, true);
    assert.strictEqual(meta.calendario, true);
    const mal = await pedir(base, 'POST', '', { ...NUEVO, area: 'Plomería' });
    assert.strictEqual(mal.status, 400);
    assert.match(mal.data.error, /área/);
    const ok = await pedir(base, 'POST', '', { ...NUEVO, area: 'Mantenimiento' });
    assert.strictEqual(ok.status, 201);
    assert.strictEqual(ok.data.fecha, null);
    assert.strictEqual((await pedir(base, 'POST', '', { ...NUEVO, area: 'Sistemas' })).status, 201);

    const f = await pedir(base, 'POST', '/1/fecha', { fecha: '2026-12-01' });
    assert.strictEqual(f.status, 200);
    assert.strictEqual(f.data.fecha, '2026-12-01');
    assert.strictEqual(f.data.id, 1);
    assert.strictEqual(leer()[0].fecha, '2026-12-01');
    assert.strictEqual((await pedir(base, 'POST', '/1/fecha', { fecha: '2026-02-30' })).status, 400);
    assert.strictEqual((await pedir(base, 'POST', '/9/fecha', { fecha: null })).status, 404);
    assert.strictEqual((await pedir(base, 'POST', '/1/fecha', { fecha: null })).data.fecha, null);

    ctx.sesion.permiso = false;
    const p = await pedir(base, 'POST', '/1/fecha', { fecha: '2026-12-01' });
    assert.strictEqual(p.status, 403);
    assert.match(p.data.error, /fechas/);
  } finally { cerrar(ctx); }
});

test('/tickets sin calendario: meta false, POST /:id/fecha 404 y área libre', async () => {
  const ctx = await montar();
  try {
    const meta = (await pedir(ctx.base, 'GET', '/meta')).data;
    assert.strictEqual(meta.areaCerrada, false);
    assert.strictEqual(meta.calendario, false);
    assert.strictEqual((await pedir(ctx.base, 'POST', '', { ...NUEVO, area: 'Cualquier cosa' })).status, 201);
    assert.strictEqual((await pedir(ctx.base, 'POST', '/1/fecha', { fecha: '2026-12-01' })).status, 404);
  } finally { cerrar(ctx); }
});

test('PUT /responsables (Mantenimiento): 200 guarda pares, meta con etiquetas, alta contra etiquetas vigentes, 400, 403 y ticket viejo intacto', async () => {
  const { AREAS_MANTENIMIENTO } = require('../lib/tickets');
  const ctx = await montar({ config: {
    api: '/api/sucursales/mantenimiento', archivo: 'mantenimiento.json', permiso: 'mantenimiento-gestion',
    areas: AREAS_MANTENIMIENTO, crearSoloGestion: true, areaCerrada: true, calendario: true,
  } });
  const { base } = ctx;
  try {
    let meta = (await pedir(base, 'GET', '/meta')).data;
    assert.deepStrictEqual(meta.areas, ['Mantenimiento', 'Sistemas']); // sin archivo: semilla (legados)
    assert.deepStrictEqual(meta.responsables, [
      { usuario: null, area: 'Mantenimiento', etiqueta: 'Mantenimiento' },
      { usuario: null, area: 'Sistemas', etiqueta: 'Sistemas' },
    ]);
    assert.strictEqual(meta.puedeConfigurarAreas, true);
    assert.strictEqual((await pedir(base, 'POST', '', { ...NUEVO, area: 'Sistemas' })).status, 201);

    const put = await pedir(base, 'PUT', '/responsables',
      { responsables: [{ usuario: 'ADRIEL', area: ' Sistema (Soporte) ' }, { usuario: 'beto', area: 'Plomería' }] });
    assert.strictEqual(put.status, 200);
    const esperados = [
      { usuario: 'Adriel', area: 'Sistema (Soporte)', etiqueta: 'Adriel Sanabria / Sistema (Soporte)' },
      { usuario: 'beto', area: 'Plomería', etiqueta: 'beto / Plomería' },
    ];
    assert.deepStrictEqual(put.data, { responsables: esperados, areas: esperados.map(r => r.etiqueta) });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(ctx.dir, 'mantenimiento_areas.json'), 'utf8')),
      [{ usuario: 'Adriel', area: 'Sistema (Soporte)' }, { usuario: 'beto', area: 'Plomería' }]);
    meta = (await pedir(base, 'GET', '/meta')).data;
    assert.deepStrictEqual(meta.responsables, esperados);
    assert.deepStrictEqual(meta.areas, esperados.map(r => r.etiqueta));

    assert.strictEqual((await pedir(base, 'POST', '', { ...NUEVO, area: 'Sistemas' })).status, 400); // quitada
    assert.strictEqual((await pedir(base, 'POST', '', { ...NUEVO, area: 'beto / Plomería' })).status, 201);
    const lista = (await pedir(base, 'GET', '')).data;
    assert.strictEqual(lista.find(t => t.id === 1).area, 'Sistemas'); // el viejo conserva su valor

    const mal = await pedir(base, 'PUT', '/responsables', { responsables: [{ usuario: 'beto', area: 'A' }, { usuario: 'BETO', area: 'a' }] });
    assert.strictEqual(mal.status, 400);
    assert.match(mal.data.error, /repetidos/);
    const inex = await pedir(base, 'PUT', '/responsables', { responsables: [{ usuario: 'nadie', area: 'A' }] });
    assert.strictEqual(inex.status, 400);
    assert.match(inex.data.error, /usuario/);
    assert.strictEqual((await pedir(base, 'PUT', '/responsables', { responsables: ['Sistemas'] })).status, 400); // string legado no
    assert.strictEqual((await pedir(base, 'PUT', '/responsables', {})).status, 400);

    ctx.sesion.permiso = false;
    const p = await pedir(base, 'PUT', '/responsables', { responsables: [{ usuario: 'beto', area: 'X' }] });
    assert.strictEqual(p.status, 403);
    assert.match(p.data.error, /responsables/);
    assert.strictEqual((await pedir(base, 'GET', '/meta')).data.puedeConfigurarAreas, false);
    assert.deepStrictEqual((await pedir(base, 'GET', '/meta')).data.areas, esperados.map(r => r.etiqueta));
  } finally { cerrar(ctx); }
});

test('Mantenimiento: archivo con strings legados mezclados se lee como pares sin usuario', async () => {
  const { AREAS_MANTENIMIENTO } = require('../lib/tickets');
  const ctx = await montar({ config: {
    api: '/api/sucursales/mantenimiento', archivo: 'mantenimiento.json', permiso: 'mantenimiento-gestion',
    areas: AREAS_MANTENIMIENTO, crearSoloGestion: true, areaCerrada: true,
  } });
  try {
    fs.writeFileSync(path.join(ctx.dir, 'mantenimiento_areas.json'), JSON.stringify(['Plomería', { usuario: 'beto', area: 'Gas' }]));
    const meta = (await pedir(ctx.base, 'GET', '/meta')).data;
    assert.deepStrictEqual(meta.responsables, [
      { usuario: null, area: 'Plomería', etiqueta: 'Plomería' },
      { usuario: 'beto', area: 'Gas', etiqueta: 'beto / Gas' },
    ]);
    assert.deepStrictEqual(meta.areas, ['Plomería', 'beto / Gas']);
    assert.strictEqual((await pedir(ctx.base, 'POST', '', { ...NUEVO, area: 'Plomería' })).status, 201);
  } finally { cerrar(ctx); }
});

test('/tickets sin areaCerrada: PUT /responsables 404, meta con áreas fijas, sin responsables y puedeConfigurarAreas false', async () => {
  const { AREAS } = require('../lib/tickets');
  const ctx = await montar();
  try {
    const r = await pedir(ctx.base, 'PUT', '/responsables', { responsables: [{ usuario: 'beto', area: 'X' }] });
    assert.strictEqual(r.status, 404);
    assert.ok(!fs.existsSync(path.join(ctx.dir, 'tickets_areas.json')));
    const meta = (await pedir(ctx.base, 'GET', '/meta')).data;
    assert.deepStrictEqual(meta.areas, AREAS);
    assert.strictEqual(meta.responsables, undefined);
    assert.strictEqual(meta.puedeConfigurarAreas, false);
    assert.strictEqual((await pedir(ctx.base, 'POST', '', { ...NUEVO, area: 'Libre' })).status, 201);
  } finally { cerrar(ctx); }
});

test('Mantenimiento: mantenimiento_areas.json con forma inválida ({}, "x", [], [1]) → meta da la semilla y el alta 201, no 500', async () => {
  const { AREAS_MANTENIMIENTO } = require('../lib/tickets');
  for (const contenido of [{}, 'x', [], [1], [null], [{ area: 'X' }]]) {
    const ctx = await montar({ config: {
      api: '/api/sucursales/mantenimiento', archivo: 'mantenimiento.json', permiso: 'mantenimiento-gestion',
      areas: AREAS_MANTENIMIENTO, crearSoloGestion: true, areaCerrada: true,
    } });
    const caso = JSON.stringify(contenido);
    try {
      fs.writeFileSync(path.join(ctx.dir, 'mantenimiento_areas.json'), caso);
      const meta = await pedir(ctx.base, 'GET', '/meta');
      assert.strictEqual(meta.status, 200, caso);
      assert.deepStrictEqual(meta.data.areas, AREAS_MANTENIMIENTO, caso);
      const alta = await pedir(ctx.base, 'POST', '', { ...NUEVO, area: AREAS_MANTENIMIENTO[0] });
      assert.strictEqual(alta.status, 201, `${caso}: ${JSON.stringify(alta.data)}`);
    } finally { cerrar(ctx); }
  }
});
