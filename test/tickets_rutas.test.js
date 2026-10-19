'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

// Router real sobre un express efímero, DATA_DIR temporal y usuarios falsos. La sesión
// se simula con un middleware que fija req.session.user.
const USUARIOS = [
  { id: 1, usuario: 'ana', nombre: 'Ana', esAdmin: true, activo: true },
  { id: 2, usuario: 'beto', nombre: 'Beto', activo: true },
  { id: 3, usuario: 'viejo', nombre: 'Viejo', activo: false },
];

function montar() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-'));
  const leerJSON = (p, def) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : def);
  const guardarJSON = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { usuario: 'ana', nombre: 'Ana' } }; next(); });
  app.use(require('../routes/rutas_tickets')({ leerJSON, guardarJSON, DATA_DIR: dir, listarUsuarios: () => USUARIOS }));
  return new Promise(ok => {
    const server = app.listen(0, () => ok({ server, dir, base: `http://127.0.0.1:${server.address().port}/api/tickets` }));
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

test('meta devuelve catálogos, usuarios activos y el usuario de sesión', async () => {
  const ctx = await montar();
  try {
    const { status, data } = await pedir(ctx.base, 'GET', '/meta');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(data.usuarios, [{ usuario: 'ana', nombre: 'Ana' }, { usuario: 'beto', nombre: 'Beto' }]);
    assert.strictEqual(data.yo, 'ana');
    assert.strictEqual(data.prioridades.length, 4);
    assert.strictEqual(data.estados.length, 6);
    assert.ok(data.areas.includes('Compras'));
  } finally { cerrar(ctx); }
});

test('alta, listado, PATCH de estado + nota y errores', async () => {
  const ctx = await montar();
  const { base } = ctx;
  try {
    assert.deepStrictEqual((await pedir(base, 'GET', '')).data, []);

    const alta = await pedir(base, 'POST', '', NUEVO);
    assert.strictEqual(alta.status, 201);
    assert.strictEqual(alta.data.id, 1);
    assert.strictEqual(alta.data.creadoPor, 'ana');

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
