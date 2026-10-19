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
function montar({ ttlMs } = {}) {
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
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { usuario: 'adriel', nombre: 'Adriel S.' } }; next(); });
  app.use(require('../routes/rutas_tickets')({ leerJSON, guardarJSON, DATA_DIR: dir, query, ttlMs }));
  return new Promise(ok => {
    const server = app.listen(0, () => ok({ server, dir, sql, base: `http://127.0.0.1:${server.address().port}/api/tickets` }));
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

    const invalido = await pedir(base, 'POST', '', { ...NUEVO, destinatarios: ['viejo'] });
    assert.strictEqual(invalido.status, 400);
    assert.match(invalido.data.error, /viejo/);

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
