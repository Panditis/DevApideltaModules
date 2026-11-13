'use strict';
// Bordes del cotizador mayorista (QA 2026-11-03): normalizarCantidad, CSV con caracteres especiales y contrato con el
// cotizador web real (si está en el escritorio), pct con antes 0, descargas con versión/archivo hostil, exportaciones
// simultáneas y 403 en todas las escrituras.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const express = require('express');
const C = require('../lib/cotizador_mayorista');

test('normalizarCantidad: bordes', () => {
  const ok = { '1 caja x 12u': '12u', 'x12': '12u', '12 U': '12u', '1,5kg': '1.5kg', '1.5kg': '1.5kg',
    '12\u00a0u': '12u', '  ': '', '1000000': '1000000u', 'CAJA X 8U': '8u', '--': '' };
  for (const [e, s] of Object.entries(ok)) assert.strictEqual(C.normalizarCantidad(e).valor, s, e);
  for (const e of ['0u', '-5u', '0kg', '12 unidades', '500g', '1.000u', 'abc']) {
    const r = C.normalizarCantidad(e);
    assert.strictEqual(r.valor, null, e);
    assert.ok(r.aviso, e);
  }
  assert.strictEqual(C.normalizarCantidad(null).valor, '');
  assert.strictEqual(C.normalizarCantidad(undefined).valor, '');
});

test('diffCatalogo: pct null si antes es 0, vacío o no numérico', () => {
  const d = C.diffCatalogo(
    [{ cod: '1', pack_price: '0' }, { cod: '2', pack_price: '' }, { cod: '3', bulto_price: 'x' }],
    [{ cod: '1', pack_price: 100 }, { cod: '2', pack_price: 100 }, { cod: '3', bulto_price: 50 }]);
  assert.strictEqual(d.cambiados.length, 3);
  for (const c of d.cambiados) assert.strictEqual(c.pct, null);
});

function cargarCotizador() {
  const ruta = 'C:/Users/Adriel/Desktop/cotizador/js/catalogo.js';
  if (!fs.existsSync(ruta)) return null;
  const window = { CONFIG: { COLUMNAS_CSV: C.COLUMNAS, SECCIONES_APIDELTA: [], SECCION_MIELES: 'MIELES', CODS_SIN_VARIEDAD: [] } };
  vm.runInNewContext(fs.readFileSync(ruta, 'utf8'), { window });
  const sync = 'C:/Users/Adriel/Desktop/cotizador/js/catalogo_sync.js';
  if (fs.existsSync(sync)) vm.runInNewContext(fs.readFileSync(sync, 'utf8'), { window });
  return window;
}

const especiales = [
  { cod: '1', seccion: 'Mieles', nombre: 'Miel, "pet" 1/2', pack_qty: '12u', pack_price: 2760, bulto_qty: '36u', bulto_price: 2500 },
  { cod: '2', seccion: 'Ñandú áéí', nombre: 'Línea1\nLínea2', pack_qty: '', pack_price: '', bulto_qty: '300kg', bulto_price: 150000 },
  { cod: '9001', seccion: 'Mieles', nombre: '=HYPERLINK("x")', pack_qty: '', pack_price: '', bulto_qty: '1250u', bulto_price: 2030 },
];

test('CSV con comas, comillas, saltos, tildes y ñ: round-trip propio y sha256 igual a WebCrypto', async () => {
  const csv = C.generarCsv(especiales);
  assert.ok(!csv.includes('\r') && csv.charCodeAt(0) !== 0xFEFF && csv.endsWith('\n'));
  const leidas = C.parsearCsv(csv);
  assert.deepStrictEqual(leidas.map(f => f.nombre), especiales.map(f => f.nombre));
  assert.strictEqual(leidas[1].seccion, 'Ñandú áéí');
  const web = Buffer.from(await crypto.webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(csv))).toString('hex');
  assert.strictEqual(C.sha256(csv), web);
});

test('contrato con el cotizador web real: columnas, precios, cantidades y version.json', async (t) => {
  const w = cargarCotizador();
  if (!w) return t.skip('cotizador no está en el escritorio');
  const csv = C.generarCsv(especiales);
  const secciones = w.Cat.construir(w.Cat.filasAObjetos(w.Cat.parseCSV(csv)));
  assert.deepStrictEqual(Array.from(secciones, s => s.name), ['Mieles', 'Ñandú áéí']);
  const [miel, pallet] = secciones[0].products;
  assert.deepStrictEqual([miel.name, miel.packMin, miel.packPrice, miel.bultoMin, miel.bultoPrice], ['Miel, "pet" 1/2', 12, 2760, 36, 2500]);
  assert.deepStrictEqual([pallet.cod, pallet.packPrice, pallet.bultoMin, pallet.bultoPrice], ['9001', null, 1250, 2030]);
  const tambor = secciones[1].products[0];
  assert.deepStrictEqual([tambor.name, tambor.packPrice, tambor.bultoQty, tambor.bultoPrice], ['Línea1\nLínea2', null, '300kg', 150000]);
  const ver = JSON.parse(JSON.stringify(C.generarVersion({ version: 7, csv, productos: 3, usuario: 'qa' })));
  if (w.CatSync) {
    const p = w.CatSync.parseVersion(ver);
    assert.strictEqual(p.version, 7);
    assert.strictEqual(p.sha256, C.sha256(csv));
  }
});

// Documenta el contrato actual: el cotizador toma el primer entero (\d+) como mínimo, así que "1.5kg" queda en 1.
test('contrato: cantidad kg con decimales el cotizador la lee como mínimo entero', (t) => {
  const w = cargarCotizador();
  if (!w) return t.skip('cotizador no está en el escritorio');
  const csv = C.generarCsv([{ cod: '9', seccion: 'S', nombre: 'n', pack_qty: C.normalizarCantidad('1,5kg').valor, pack_price: 10, bulto_qty: '', bulto_price: '' }]);
  const p = w.Cat.construir(w.Cat.filasAObjetos(w.Cat.parseCSV(csv)))[0].products[0];
  assert.strictEqual(p.packQty, '1.5kg');
  assert.strictEqual(p.packMin, 1);
});

// ── Rutas ──
const listados = {
  almacen: [{ plu: '100', decision: { fuente: 'sistema' }, mayoristas: [{ plu: '101', tipo: 'pack' }],
    sugeridos: { sistema: { mayoristas: [{ plu: '101', neto: 1000 }] } } }],
  fraccionado: [], produccion: [],
};
function montar({ permiso = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotmay-b-'));
  const apiRoute = fn => async (req, res) => { try { res.json(await fn(req)); } catch (err) { res.status(500).json({ error: err.message }); } };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { id: 1, usuario: 'tester' } }; next(); });
  app.use(require('../routes/rutas_cotizador_mayorista')({ apiRoute, DATA_DIR: dir, tienePermiso: () => permiso,
    listadosVigentes: async () => { await new Promise(r => setTimeout(r, 10)); return listados; }, preciosSigaPorPlu: async () => new Map([['101', 1000]]) }));
  return new Promise(ok => { const server = app.listen(0, () => ok({ server, dir, base: `http://127.0.0.1:${server.address().port}/api/cotizador-mayorista` })); });
}
const cerrar = ({ server, dir }) => { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); };
const pedir = (base, metodo, url, body) => fetch(base + url, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

test('rutas: 403 en todas las escrituras (tabla, subida, importar, exportar)', async () => {
  const ctx = await montar({ permiso: false });
  try {
    assert.strictEqual((await pedir(ctx.base, 'PUT', '/tabla', { filas: [] })).status, 403);
    assert.strictEqual((await pedir(ctx.base, 'PUT', '/subida', { host: 'h', usuario: 'u', ruta: '/' })).status, 403);
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('x')]), 'a.xlsx');
    assert.strictEqual((await fetch(ctx.base + '/importar', { method: 'POST', body: fd })).status, 403);
    assert.strictEqual((await pedir(ctx.base, 'POST', '/exportar')).status, 403);
    assert.ok(!fs.existsSync(path.join(ctx.dir, 'cotizador_mayorista.json')));
  } finally { cerrar(ctx); }
});

test('rutas: importar archivo que no es xlsx o sin la hoja da error sin stack ni rutas', async () => {
  const ctx = await montar();
  try {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('no soy un excel')]), 'a.xlsx');
    const r = await (await fetch(ctx.base + '/importar', { method: 'POST', body: fd })).json();
    assert.ok(r.error);
    assert.ok(!/[A-Z]:\\|\/tmp|at /.test(r.error), r.error);
  } finally { cerrar(ctx); }
});

test('rutas: descarga rechaza versión/archivo hostil', async () => {
  const ctx = await montar();
  try {
    for (const u of ['/publicaciones/..%2F..%2Fx/catalogo.csv', '/publicaciones/1/meta.json', '/publicaciones/1/..%2F..%2Fcotizador_mayorista.json',
      '/publicaciones/0/catalogo.csv', '/publicaciones/1.5/catalogo.csv', '/publicaciones/-1/version.json']) {
      const r = await pedir(ctx.base, 'GET', u);
      assert.ok(r.status === 400 || r.status === 404, `${u} → ${r.status}`);
    }
    assert.strictEqual((await pedir(ctx.base, 'GET', '/publicaciones/1/catalogo.csv')).status, 404);
  } finally { cerrar(ctx); }
});

test('rutas: dos exportaciones simultáneas dan versiones distintas y ambas completas', async () => {
  const ctx = await montar();
  try {
    await pedir(ctx.base, 'PUT', '/tabla', { filas: [{ cod: '100', seccion: 'S', nombre: 'Miel', packQty: '12u', bultoQty: '' }] });
    const rs = await Promise.all([1, 2, 3].map(() => pedir(ctx.base, 'POST', '/exportar').then(r => r.json())));
    assert.deepStrictEqual(rs.map(r => r.version).sort(), [1, 2, 3], JSON.stringify(rs));
    for (const v of [1, 2, 3]) {
      const d = path.join(ctx.dir, 'cotizador_publicaciones', `v00${v}`);
      for (const a of ['catalogo.csv', 'version.json', 'meta.json']) assert.ok(fs.existsSync(path.join(d, a)), `v${v}/${a}`);
    }
  } finally { cerrar(ctx); }
});
