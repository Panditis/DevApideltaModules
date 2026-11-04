'use strict';
// Publicar por FTP con cliente falso (nunca se conecta a un servidor real).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const PASS = 'S3cr3t0!';

function clienteFalso({ fallaAccess, tamanoMal, renameFalla, demora = 0 } = {}) {
  const log = [], remoto = new Map();
  const c = {
    log,
    access: async () => { log.push('access'); if (demora) await new Promise(r => setTimeout(r, demora)); if (fallaAccess) throw fallaAccess; },
    cd: async d => log.push(`cd ${d}`),
    uploadFrom: async (local, nombre) => { log.push(`up ${nombre}`); remoto.set(nombre, fs.statSync(local).size); },
    size: async n => (tamanoMal ? 1 : remoto.get(n)),
    rename: async (a, b) => { log.push(`mv ${a} ${b}`); if (renameFalla && remoto.has(b)) throw new Error('existe'); remoto.set(b, remoto.get(a)); remoto.delete(a); },
    remove: async n => { log.push(`rm ${n}`); remoto.delete(n); },
    close: () => log.push('close'),
  };
  return c;
}

function montar({ cliente, permiso = true, ftp, crear } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotmay-p-'));
  const v = path.join(dir, 'cotizador_publicaciones', 'v001');
  fs.mkdirSync(v, { recursive: true });
  fs.writeFileSync(path.join(v, 'catalogo.csv'), 'cod,nombre\n1,a\n');
  fs.writeFileSync(path.join(v, 'version.json'), '{"version":1}\n');
  fs.writeFileSync(path.join(v, 'meta.json'), JSON.stringify({ version: 1, generado: 'x', diff: {} }));
  if (ftp !== undefined) fs.writeFileSync(path.join(dir, 'cotizador_ftp.json'), JSON.stringify(ftp));
  const apiRoute = fn => async (req, res) => { try { res.json(await fn(req)); } catch (err) { res.status(500).json({ error: err.message }); } };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { id: 1, usuario: 'tester' } }; next(); });
  app.use(require('../routes/rutas_cotizador_mayorista')({ apiRoute, DATA_DIR: dir, tienePermiso: () => permiso,
    listadosVigentes: async () => ({}), crearClienteFtp: crear || (() => cliente || clienteFalso()) }));
  return new Promise(ok => { const server = app.listen(0, () => ok({ server, dir, base: `http://127.0.0.1:${server.address().port}/api/cotizador-mayorista` })); });
}
const cerrar = ({ server, dir }) => { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); };
const publicar = (ctx, v = 1) => fetch(`${ctx.base}/publicaciones/${v}/publicar`, { method: 'POST' });
const metaDe = ctx => JSON.parse(fs.readFileSync(path.join(ctx.dir, 'cotizador_publicaciones', 'v001', 'meta.json'), 'utf8'));
const conPass = { host: 'ftp.ejemplo.test', usuario: 'userx', password: PASS, rutaRemota: '/web/cotizador' };

test('publicar: csv antes que json, con .tmp + rename, y meta.json actualizado', async () => {
  const cliente = clienteFalso();
  const ctx = await montar({ cliente, ftp: conPass });
  try {
    const r = await (await publicar(ctx)).json();
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(r.subidos, ['catalogo.csv', 'version.json']);
    assert.deepStrictEqual(cliente.log, ['access', 'cd /web/cotizador', 'up catalogo.csv.tmp', 'mv catalogo.csv.tmp catalogo.csv',
      'up version.json.tmp', 'mv version.json.tmp version.json', 'close']);
    const m = metaDe(ctx);
    assert.strictEqual(m.publicado.ok, true);
    assert.ok(!JSON.stringify(m).includes(PASS));
    const h = await (await fetch(`${ctx.base}/historial`)).json();
    assert.strictEqual(h[0].publicado.ok, true);
  } finally { cerrar(ctx); }
});

test('publicar: rename sobre existente falla → borra destino y renombra', async () => {
  const cliente = clienteFalso({ renameFalla: true });
  const ctx = await montar({ cliente, ftp: conPass });
  try {
    await publicar(ctx); // primera: crea destinos
    const r = await (await publicar(ctx)).json();
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok(cliente.log.includes('rm catalogo.csv'));
  } finally { cerrar(ctx); }
});

test('publicar: tamaño remoto distinto → error, no renombra ni sube version.json', async () => {
  const cliente = clienteFalso({ tamanoMal: true });
  const ctx = await montar({ cliente, ftp: conPass });
  try {
    const r = await (await publicar(ctx)).json();
    assert.match(r.error, /tamaño/);
    assert.ok(!cliente.log.some(l => l.startsWith('mv') || l === 'up version.json.tmp'));
    assert.ok(cliente.log.includes('rm catalogo.csv.tmp'), 'limpia el .tmp remoto');
    assert.strictEqual(metaDe(ctx).publicado.ok, false);
  } finally { cerrar(ctx); }
});

test('publicar: rename falla tras el upload → borra el .tmp remoto y conserva el error original', async () => {
  const cliente = clienteFalso();
  cliente.rename = async () => { cliente.log.push('mv'); throw Object.assign(new Error('550 denied'), { code: 550 }); };
  cliente.remove = async n => { cliente.log.push(`rm ${n}`); if (n.endsWith('.tmp')) throw new Error('rm falla también'); };
  const ctx = await montar({ cliente, ftp: conPass });
  const orig = console.error;
  console.error = () => {};
  try {
    const r = await (await publicar(ctx)).json();
    assert.ok(r.error && !/rm falla/.test(r.error), JSON.stringify(r));
    assert.ok(cliente.log.includes('rm catalogo.csv.tmp'));
    assert.strictEqual(cliente.log.at(-1), 'close');
  } finally { console.error = orig; cerrar(ctx); }
});

test('publicar: si crear el cliente FTP tira, el lock se libera y el siguiente publicar anda', async () => {
  let tirar = true;
  const ctx = await montar({ ftp: conPass, crear: () => { if (tirar) throw new Error('boom'); return clienteFalso(); } });
  const orig = console.error;
  console.error = () => {};
  try {
    const r1 = await publicar(ctx);
    assert.strictEqual(r1.status, 200);
    assert.ok((await r1.json()).error);
    tirar = false;
    const r2 = await (await publicar(ctx)).json();
    assert.strictEqual(r2.ok, true, JSON.stringify(r2));
  } finally { console.error = orig; cerrar(ctx); }
});

test('publicar: sin archivo de config lo crea sin password y avisa; no conecta', async () => {
  const cliente = clienteFalso();
  const ctx = await montar({ cliente });
  try {
    const r = await (await publicar(ctx)).json();
    assert.match(r.error, /contraseña/);
    assert.deepStrictEqual(cliente.log, []);
    const cfg = JSON.parse(fs.readFileSync(path.join(ctx.dir, 'cotizador_ftp.json'), 'utf8'));
    assert.strictEqual(cfg.password, '');
    assert.strictEqual(cfg.puerto, 21);
  } finally { cerrar(ctx); }
});

test('publicar: login rechazado → mensaje claro sin credenciales', async () => {
  const err = Object.assign(new Error(`530 Login incorrect for userx ${PASS} @ ftp.ejemplo.test`), { code: 530 });
  const ctx = await montar({ cliente: clienteFalso({ fallaAccess: err }), ftp: conPass });
  const errores = [];
  const orig = console.error;
  console.error = (...a) => errores.push(a.join(' '));
  try {
    const r = await (await publicar(ctx)).json();
    assert.match(r.error, /rechazó/);
    const todo = JSON.stringify(r) + JSON.stringify(metaDe(ctx)) + errores.join('\n');
    for (const s of [PASS, 'userx', 'ftp.ejemplo.test']) assert.ok(!todo.includes(s), s);
  } finally { console.error = orig; cerrar(ctx); }
});

test('publicar: segundo pedido simultáneo → 409', async () => {
  const ctx = await montar({ cliente: clienteFalso({ demora: 100 }), ftp: conPass });
  try {
    const [a, b] = await Promise.all([publicar(ctx), new Promise(r => setTimeout(r, 20)).then(() => publicar(ctx))]);
    assert.deepStrictEqual([a.status, b.status].sort(), [200, 409]);
  } finally { cerrar(ctx); }
});

test('publicar: 403 sin permiso, 404 versión inexistente', async () => {
  const ctx = await montar({ permiso: false, ftp: conPass });
  try { assert.strictEqual((await publicar(ctx)).status, 403); } finally { cerrar(ctx); }
  const ctx2 = await montar({ ftp: conPass });
  try { assert.strictEqual((await publicar(ctx2, 9)).status, 404); } finally { cerrar(ctx2); }
});

test('GET publicar/config no devuelve la password', async () => {
  const ctx = await montar({ ftp: conPass });
  try {
    const r = await (await fetch(`${ctx.base}/publicar/config`)).json();
    assert.deepStrictEqual(r, { host: 'ftp.ejemplo.test', puerto: 21, usuario: 'userx', rutaRemota: '/web/cotizador', secure: false, tienePassword: true });
  } finally { cerrar(ctx); }
});

test('historial: meta.json corrupto no rompe', async () => {
  const ctx = await montar({ ftp: conPass });
  const orig = console.error;
  console.error = () => {};
  try {
    fs.writeFileSync(path.join(ctx.dir, 'cotizador_publicaciones', 'v001', 'meta.json'), '{roto');
    const r = await fetch(`${ctx.base}/historial`);
    assert.strictEqual(r.status, 200);
    const h = await r.json();
    assert.strictEqual(h[0].metaIlegible, true);
  } finally { console.error = orig; cerrar(ctx); }
});

test('publicar: tras fallar la conexión se libera el lock y se cierra el cliente', async () => {
  const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const cliente = clienteFalso();
  const accessBueno = cliente.access;
  cliente.access = async () => { cliente.log.push('access'); throw err; };
  const ctx = await montar({ cliente, ftp: conPass });
  const orig = console.error;
  console.error = () => {};
  try {
    const r1 = await (await publicar(ctx)).json();
    assert.match(r1.error, /No se pudo conectar/);
    assert.deepStrictEqual(cliente.log, ['access', 'close']);
    cliente.access = accessBueno;
    const r2 = await (await publicar(ctx)).json();
    assert.strictEqual(r2.ok, true, JSON.stringify(r2));
  } finally { console.error = orig; cerrar(ctx); }
});

test('publicar: versión no numérica o con traversal → 400 o 404, nunca sube', async () => {
  const cliente = clienteFalso();
  const ctx = await montar({ cliente, ftp: conPass });
  try {
    for (const v of ['abc', '0', '-1', '1.5', '..%2F..%2Fx']) {
      const s = (await publicar(ctx, v)).status;
      assert.ok(s === 400 || s === 404, `${v} → ${s}`);
    }
    assert.deepStrictEqual(cliente.log, []);
  } finally { cerrar(ctx); }
});

test('mensajeFtp: timeout y error desconocido no reenvían el texto crudo', () => {
  const C = require('../lib/cotizador_mayorista');
  assert.match(C.mensajeFtp(new Error('Timeout (control socket)')), /No se pudo conectar/);
  assert.ok(!C.mensajeFtp(new Error(`raro ${PASS}`)).includes(PASS));
  assert.strictEqual(C.redactar(`a ${PASS} userx b`, { password: PASS, usuario: 'userx', host: '' }), 'a *** *** b');
});

test('server.js sirve todos los scripts /js/ que carga cotizador_mayorista.html', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'cotizador_mayorista.html'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const faltan = [...html.matchAll(/src="(\/js\/cotizador_mayorista_[\w]+\.js)"/g)].map(m => m[1])
    .filter(src => !server.includes(`app.get('${src}'`));
  assert.deepStrictEqual(faltan, []);
});
