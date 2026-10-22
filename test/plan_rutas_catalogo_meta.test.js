'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

function montar() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-cat-meta-'));
  const leerJSON = (p, def) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : def);
  const guardarJSON = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2));
  const CATALOGO_PATH = path.join(dir, 'catalogo.json');
  const GRUPOS_CFG_PATH = path.join(dir, 'grupos_config.json');
  guardarJSON(CATALOGO_PATH, [{ plu: 1, producto: 'Pepas 250G', baseNombre: 'Pepas 250G', presentacion: '250G', esVariante: false, refId: 1, productoRef: 'Pepas' }]);
  guardarJSON(GRUPOS_CFG_PATH, { Pepas: { activo: true, granelPlu: '100', reqGranel: true, esMiel: false } });
  guardarJSON(path.join(dir, 'clientes.json'), [{ id: 7, nombre: 'Melar' }]);
  guardarJSON(path.join(dir, 'responsables.json'), [{ nombre: 'Ana', corto: 'ANA' }]);
  const v = (cfg, ref) => cfg[ref];
  const app = express();
  app.use(express.json());
  app.use(require('../routes/rutas_catalogo')({
    leerJSON, guardarJSON, CATALOGO_PATH, GRUPOS_CFG_PATH,
    cfgActivo: (cfg, ref) => !v(cfg, ref) || v(cfg, ref).activo !== false,
    cfgGranelPlu: (cfg, ref) => String((v(cfg, ref) || {}).granelPlu || ''),
    cfgGranelPlus: (cfg, ref) => ((v(cfg, ref) || {}).granelPlu ? [String(v(cfg, ref).granelPlu)] : []),
    cfgMpManual: () => [], cfgEsGranel: () => false, cfgGranelOverride: () => null, cfgEsMiel: () => null,
    cfgReqGranel: (cfg, ref) => !!(v(cfg, ref) || {}).reqGranel,
  }));
  return new Promise(ok => {
    const server = app.listen(0, () => ok({ server, dir, base: `http://127.0.0.1:${server.address().port}`, cfg: () => leerJSON(GRUPOS_CFG_PATH, {}) }));
  });
}
async function pedir(base, metodo, url, body) {
  const r = await fetch(base + url, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json() };
}
function cerrar({ server, dir }) {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

test('PATCH meta: guarda, conserva campos viejos y devuelve la meta', async () => {
  const ctx = await montar();
  try {
    const r = await pedir(ctx.base, 'PATCH', `/api/catalogo/grupo/${encodeURIComponent('Pepas')}/meta`,
      { estado: 'pausado', motivo: 'Falta MP', clienteId: 7, responsables: ['Ana'], proximaFecha: '2026-10-30' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.data, {
      productoRef: 'Pepas', tipo: 'granel', estado: 'pausado', motivo: 'Falta MP', clienteId: 7,
      responsables: ['Ana'], proximaFecha: '2026-10-30', granelPlus: ['100'], activo: true,
    });
    const g = ctx.cfg().Pepas;
    assert.strictEqual(g.esMiel, false);
    assert.strictEqual(g.reqGranel, true);
    assert.strictEqual(g.granelPlu, '100');
  } finally { cerrar(ctx); }
});

test('PATCH meta: 400 inválido (sin escribir), 404 grupo inexistente', async () => {
  const ctx = await montar();
  try {
    const antes = ctx.cfg();
    const r = await pedir(ctx.base, 'PATCH', '/api/catalogo/grupo/Pepas/meta', { estado: 'pausado' });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /motivo/);
    assert.deepStrictEqual(ctx.cfg(), antes);
    assert.strictEqual((await pedir(ctx.base, 'PATCH', '/api/catalogo/grupo/Nada/meta', { estado: 'activo' })).status, 404);
  } finally { cerrar(ctx); }
});

test('GET /api/catalogo/grupos: incluye tipo, estado, motivo, clienteId, responsables, proximaFecha', async () => {
  const ctx = await montar();
  try {
    const r = await pedir(ctx.base, 'GET', '/api/catalogo/grupos');
    assert.strictEqual(r.status, 200);
    const g = r.data[0];
    assert.strictEqual(g.productoRef, 'Pepas');
    assert.strictEqual(g.tipo, 'granel');
    assert.strictEqual(g.estado, 'activo');
    assert.deepStrictEqual(g.responsables, []);
    assert.strictEqual(g.proximaFecha, null);
    assert.strictEqual(g.clienteId, null);
  } finally { cerrar(ctx); }
});

test('PATCH meta: grupo con % en el nombre (el param ya llega decodificado)', async () => {
  const ctx = await montar();
  try {
    const cat = path.join(ctx.dir, 'catalogo.json');
    const items = JSON.parse(fs.readFileSync(cat, 'utf8'));
    fs.writeFileSync(cat, JSON.stringify([...items, { plu: 2, producto: 'Cacao 50% 1Kg', baseNombre: 'Cacao 50% 1Kg', presentacion: '1Kg', esVariante: false, refId: 2, productoRef: '50% cacao' }]));
    const url = `/api/catalogo/grupo/${encodeURIComponent('50% cacao')}`;
    const r = await pedir(ctx.base, 'PATCH', `${url}/meta`, { estado: 'activo', responsables: ['Ana'] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.productoRef, '50% cacao');
    assert.deepStrictEqual(ctx.cfg()['50% cacao'].responsables, ['Ana']);
    const g = await pedir(ctx.base, 'GET', url);
    assert.strictEqual(g.status, 200);
    assert.strictEqual(g.data.length, 1);
  } finally { cerrar(ctx); }
});
