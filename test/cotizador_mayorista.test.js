'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const C = require('../lib/cotizador_mayorista');

test('normalizarCantidad: todos los casos del Excel', () => {
  const casos = { '12u': '12u', '6u': '6u', '5kg': '5kg', '—': '', '': '', 'caja x 8u': '8u', '4 cajas x 32u': '32u',
    '4 cajas x 56u': '56u', 'caja x 14u': '14u', '4': '4u', '12': '12u', '160U': '160u', '300kg': '300kg' };
  for (const [e, s] of Object.entries(casos)) assert.strictEqual(C.normalizarCantidad(e).valor, s, e);
  assert.strictEqual(C.normalizarCantidad('media docena').valor, null);
  assert.ok(C.normalizarCantidad('media docena').aviso);
  assert.strictEqual(C.normalizarCantidad('1.5u').valor, null);
});

// Listado falso: base 100 con pack 101 (decidido) y bulto 102; base 200 solo bulto sin decisión.
const listados = {
  almacen: [
    { plu: '100', decision: { fuente: 'sistema' }, mayoristas: [{ plu: '101', tipo: 'pack' }, { plu: '102', tipo: 'bulto' }],
      sugeridos: { sistema: { mayoristas: [{ plu: '101', neto: 999.6 }, { plu: '102', neto: 900.4 }] } } },
    { plu: '200', decision: null, mayoristas: [{ plu: '202', tipo: 'bulto' }],
      sugeridos: { sistema: { mayoristas: [{ plu: '202', neto: 5000 }] } } },
  ],
  fraccionado: [], produccion: [],
};
const tabla = { filas: [
  { cod: '100', seccion: 'Mieles', nombre: 'Miel, "pet"', packQty: 'caja x 8u', bultoQty: '4 cajas x 32u' },
  { cod: '200', seccion: 'Tambores', nombre: 'Tambor 300kg', packQty: '—', bultoQty: '300kg' },
  { cod: '9001', seccion: 'Mieles', nombre: 'Pallet', packQty: '', bultoQty: '1250u', manual: true, packPrice: null, bultoPrice: 2030 },
] };

test('armarCatalogo: decisión, solo bulto, manual, respaldo y orden por sección', () => {
  const indice = C.indicePrecios(listados);
  const sin = C.armarCatalogo({ tabla, indice });
  assert.deepStrictEqual(sin.filas.map(f => f.cod), ['100', '9001']); // 200 sin decisión ni respaldo: no sale
  assert.strictEqual(sin.revisar[0].cod, '200');
  const f = sin.filas[0];
  assert.deepStrictEqual([f.pack_qty, f.pack_price, f.bulto_qty, f.bulto_price], ['8u', 1000, '32u', 900]);
  assert.deepStrictEqual([sin.filas[1].pack_qty, sin.filas[1].pack_price, sin.filas[1].bulto_price], ['', '', 2030]);
  const con = C.armarCatalogo({ tabla, indice, respaldos: new Map([['200', { pack_price: '', bulto_price: '4800' }]]) });
  const t = con.filas.find(x => x.cod === '200');
  assert.deepStrictEqual([t.pack_qty, t.pack_price, t.bulto_qty, t.bulto_price, t.origen.bulto], ['', '', '300kg', 4800, 'respaldo']);
  assert.ok(con.revisar.find(r => r.cod === '200').respaldo);
});

test('armarCatalogo: cod repetido es error, cantidad rara va a revisar, bulto > pack avisa', () => {
  const r = C.armarCatalogo({ tabla: { filas: [
    { cod: '9002', seccion: 'S', nombre: 'a', bultoQty: '1u', manual: true, packPrice: 10, packQty: '1u', bultoPrice: 20 },
    { cod: '9002', seccion: 'S', nombre: 'b', manual: true, bultoQty: '1u', bultoPrice: 5 },
    { cod: '9003', seccion: 'S', nombre: 'c', manual: true, bultoQty: 'docena', bultoPrice: 5 },
  ] } });
  assert.deepStrictEqual(r.errores, ['cod repetido: 9002']);
  assert.strictEqual(r.revisar[0].cod, '9003');
  assert.strictEqual(r.avisos.length, 1);
});

function cargarCotizador() {
  const ruta = 'C:/Users/Adriel/Desktop/cotizador/js/catalogo.js';
  if (!fs.existsSync(ruta)) return null;
  const window = { CONFIG: { COLUMNAS_CSV: C.COLUMNAS, SECCIONES_APIDELTA: [], SECCION_MIELES: 'MIELES', CODS_SIN_VARIEDAD: [] } };
  vm.runInNewContext(fs.readFileSync(ruta, 'utf8'), { window });
  return window.Cat;
}

test('CSV: contrato, sha256 estable y round-trip con el parser', () => {
  const { filas } = C.armarCatalogo({ tabla, indice: C.indicePrecios(listados) });
  const limpio = filas.map(({ origen: _o, ...x }) => x);
  const csv = C.generarCsv(limpio);
  assert.ok(csv.startsWith('cod,seccion,nombre,pack_qty,pack_price,bulto_qty,bulto_price\n'));
  assert.ok(!csv.includes('\r') && csv.charCodeAt(0) !== 0xFEFF);
  assert.strictEqual(C.sha256(csv), C.sha256(C.generarCsv(limpio)));
  assert.match(C.sha256(csv), /^[0-9a-f]{64}$/);
  const leidas = C.parsearCsv(csv);
  assert.strictEqual(leidas[0].nombre, 'Miel, "pet"');
  const ver = C.generarVersion({ version: 3, csv, productos: 2, usuario: 'u' });
  assert.strictEqual(ver.sha256, C.sha256(csv));
  assert.match(ver.generado, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  const Cat = cargarCotizador();
  if (!Cat) return;
  const secciones = Cat.construir(Cat.filasAObjetos(Cat.parseCSV(csv)));
  const p = secciones[0].products[0];
  assert.deepStrictEqual([p.cod, p.name, p.packMin, p.packPrice, p.bultoMin, p.bultoPrice], ['100', 'Miel, "pet"', 8, 1000, 32, 900]);
  assert.strictEqual(secciones[0].products[1].packPrice, null);
});

test('diffCatalogo y comandos de subida sin contraseña', () => {
  const d = C.diffCatalogo([{ cod: '1', pack_price: '100' }, { cod: '2' }], [{ cod: '1', pack_price: 110 }, { cod: '3', pack_price: 50, bulto_price: 40 }]);
  assert.deepStrictEqual(d.nuevos.map(x => x.cod), ['3']);
  assert.deepStrictEqual([d.nuevos[0].pack_price, d.nuevos[0].bulto_price], [50, 40]);
  assert.deepStrictEqual(d.quitados.map(x => x.cod), ['2']);
  assert.strictEqual(d.cambiados[0].pct, 10);
  assert.deepStrictEqual(C.comandosSubida(C.SUBIDA_DEFECTO), [
    'curl -T catalogo.csv ftp://srva103.controlvps.com/web/cotizador/ --user Apdftp',
    'curl -T version.json ftp://srva103.controlvps.com/web/cotizador/ --user Apdftp']);
  assert.throws(() => C.validarSubida({ host: 'h', usuario: 'u:clave', ruta: '/x' }));
});

// ── Rutas ──
function montar({ permiso = true, fallarListados = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotmay-'));
  const apiRoute = fn => async (req, res) => { try { res.json(await fn(req)); } catch (err) { res.status(500).json({ error: err.message }); } };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { id: 1, usuario: 'tester' } }; next(); });
  app.use(require('../routes/rutas_cotizador_mayorista')({
    apiRoute, DATA_DIR: dir, tienePermiso: () => permiso,
    listadosVigentes: async () => { if (fallarListados) throw new Error('sin SIGA'); return listados; },
  }));
  return new Promise(ok => { const server = app.listen(0, () => ok({ server, dir, base: `http://127.0.0.1:${server.address().port}/api/cotizador-mayorista` })); });
}
const pedir = async (base, metodo, url, body) => {
  const r = await fetch(base + url, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: r.headers.get('content-type').includes('json') ? await r.json() : await r.text() };
};
const cerrar = ({ server, dir }) => { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); };

test('rutas: sin permiso 403 en escrituras', async () => {
  const ctx = await montar({ permiso: false });
  try {
    assert.strictEqual((await pedir(ctx.base, 'PUT', '/tabla', { filas: [] })).status, 403);
    assert.strictEqual((await pedir(ctx.base, 'POST', '/exportar')).status, 403);
    assert.strictEqual((await pedir(ctx.base, 'GET', '/tabla')).status, 200);
  } finally { cerrar(ctx); }
});

test('rutas: tabla, preview, exportar guarda versión, descarga e historial', async () => {
  const ctx = await montar();
  try {
    const { base } = ctx;
    assert.ok((await pedir(base, 'PUT', '/tabla', { filas: [{ cod: 'abc', seccion: 'S', nombre: 'n' }] })).data.error);
    assert.ok(!(await pedir(base, 'PUT', '/tabla', { filas: tabla.filas })).data.error);
    const prev = (await pedir(base, 'GET', '/preview')).data;
    assert.strictEqual(prev.productos, 2);
    assert.strictEqual(prev.diff.nuevos.length, 2);
    const ex = (await pedir(base, 'POST', '/exportar')).data;
    assert.strictEqual(ex.version, 1);
    const csv = (await pedir(base, 'GET', '/publicaciones/1/catalogo.csv')).data;
    const ver = (await pedir(base, 'GET', '/publicaciones/1/version.json')).data;
    assert.strictEqual(C.sha256(csv), ver.sha256);
    assert.strictEqual(ver.usuario, 'tester');
    assert.strictEqual((await pedir(base, 'POST', '/exportar')).data.version, 2);
    const hist = (await pedir(base, 'GET', '/historial')).data;
    assert.deepStrictEqual(hist.map(h => h.version), [2, 1]);
    assert.strictEqual(hist[0].nuevos, 0);
    assert.strictEqual((await pedir(base, 'GET', '/publicaciones/9/catalogo.csv')).status, 404);
    assert.strictEqual((await pedir(base, 'GET', '/publicaciones/1/..%2Fx')).status, 400);
  } finally { cerrar(ctx); }
});

test('rutas: comparacion sin publicaciones y contra la última versión', async () => {
  const ctx = await montar();
  try {
    await pedir(ctx.base, 'PUT', '/tabla', { filas: tabla.filas });
    const vacia = (await pedir(ctx.base, 'GET', '/comparacion')).data;
    assert.deepStrictEqual([vacia.sinPublicaciones, vacia.version, vacia.detalle.length], [true, null, 0]);
    await pedir(ctx.base, 'POST', '/exportar');
    const r = (await pedir(ctx.base, 'GET', '/comparacion')).data;
    assert.deepStrictEqual([r.sinPublicaciones, r.version, r.cambiaron, r.nuevos, r.quitados], [false, 1, 0, 0, 0]);
    assert.ok(r.generado && r.detalle.length && r.detalle.every(d => d.estado === 'igual' && d.publicado === d.sistema));
  } finally { cerrar(ctx); }
});

test('rutas: si falla la escritura no se pierde la versión anterior', async (t) => {
  const ctx = await montar();
  try {
    await pedir(ctx.base, 'PUT', '/tabla', { filas: tabla.filas });
    assert.strictEqual((await pedir(ctx.base, 'POST', '/exportar')).data.version, 1);
    t.mock.method(fs, 'renameSync', () => { throw new Error('disco lleno'); });
    const r = await pedir(ctx.base, 'POST', '/exportar');
    assert.strictEqual(r.status, 500);
    assert.ok(fs.existsSync(path.join(ctx.dir, 'cotizador_publicaciones', 'v001', 'catalogo.csv')));
    assert.ok(!fs.existsSync(path.join(ctx.dir, 'cotizador_publicaciones', 'v002.tmp')));
  } finally { cerrar(ctx); }
});

test('compararCodigos: catálogo (PLU de la tabla) vs sistema (vínculo sin lo explícito)', () => {
  const indice = C.indicePrecios(listados);
  const filas = [
    { cod: '100', seccion: 'Mieles', nombre: 'Miel', packQty: '8u', bultoQty: '32u', packPlu: '101', bultoPlu: '999' },
    { cod: '200', seccion: 'T', nombre: 'Tambor', packQty: '', bultoQty: '300kg', modoPack: 'ninguno' },
    { cod: '300', seccion: 'T', nombre: 'Otro', packQty: '6u', bultoPlu: '555' },
    { cod: '9004', seccion: 'T', nombre: 'Manual', manual: true },
  ];
  const r = C.compararCodigos(filas, indice, { 999: 'Bulto viejo' });
  assert.deepStrictEqual(r.detalle.map(d => d.cod), ['100', '200', '300']);
  const [a, b, c] = r.detalle;
  assert.deepStrictEqual(a.pack, { catalogo: { plu: '101', nombre: null }, sistema: { plu: '101', nombre: null, origen: 'sigaVinculo' }, estado: 'igual' });
  assert.deepStrictEqual([a.bulto.estado, a.bulto.catalogo.nombre, a.bulto.sistema.plu], ['distinto', 'Bulto viejo', '102']);
  assert.deepStrictEqual([b.pack.estado, b.bulto.estado, b.bulto.sistema.plu, b.bulto.catalogo], ['no aplica', 'solo sistema', '202', null]);
  assert.deepStrictEqual([c.pack.estado, c.bulto.estado, c.bulto.sinCantidad, c.pack.sinCantidad], ['sin dato', 'solo catálogo', true, undefined]);
  assert.deepStrictEqual([r.iguales, r.distintos, r.soloCatalogo, r.soloSistema, r.sinDato], [1, 1, 1, 1, 1]);
  assert.strictEqual(filas[0].packPlu, '101'); // sin mutar
});

test('rutas: GET comparacion-codigos', async () => {
  const m = await montar();
  try {
    fs.writeFileSync(path.join(m.dir, 'cotizador_mayorista.json'), JSON.stringify(tabla));
    const r = await pedir(m.base, 'GET', '/comparacion-codigos');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.data.detalle.map(d => d.cod), ['100', '200']);
    assert.strictEqual(r.data.detalle[0].bulto.estado, 'solo sistema');
  } finally { cerrar(m); }
});
