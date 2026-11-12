'use strict';
// Nombres de PLU pack/bulto: vinculosResueltos, plusSinNombre, columnas 7-8 del xlsx, rutas /vinculos y /nombres,
// nombrePlu de /autocompletar y nombresPorPlu (SQL falso).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const XLSX = require('xlsx');
const C = require('../lib/cotizador_mayorista');

// SIGA: cod 100 tiene pack 101 (con nombre) y bulto 102 (sin nombre en el índice).
const listados = { almacen: [{ plu: '100', mayoristas: [{ plu: '101', tipo: 'pack', nombre: 'Pack101' }, { plu: '102', tipo: 'bulto' }] }] };
const indice = () => C.indicePrecios(listados);
const filas = [
  { cod: '100', seccion: 'A', nombre: 'Siga', packQty: '4', bultoQty: '8' },
  { cod: '200', seccion: 'A', nombre: 'Explicito', packQty: '4', bultoQty: '8', packPlu: '201', bultoPlu: '101' },
  { cod: '300', seccion: 'A', nombre: 'SinCant', packQty: '', bultoQty: '', packPlu: '301', bultoPlu: '302' },
  { cod: '400', seccion: 'A', nombre: 'Desc', packQty: '4', bultoQty: '8', modoPack: 'descuento', packPlu: '401', bultoPlu: '201' },
  { cod: '500', seccion: 'A', nombre: 'Ninguno', packQty: '4', bultoQty: '8', modoPack: 'ninguno', packPlu: '501' },
  { cod: '9005', seccion: 'A', nombre: 'Manual', packQty: '4', bultoQty: '8', manual: true, packPlu: '9', bultoPlu: '8' },
];

test('vinculosResueltos: explícito (fila), automático (siga), sin cantidad, descuento/ninguno, manual ausente', () => {
  const r = C.vinculosResueltos(filas, indice(), { 201: 'Doscientos uno' });
  assert.deepStrictEqual(r['100'], { pack: { plu: '101', nombre: 'Pack101', origen: 'siga' }, bulto: { plu: '102', nombre: null, origen: 'siga' } });
  assert.deepStrictEqual(r['200'], { pack: { plu: '201', nombre: 'Doscientos uno', origen: 'fila' }, bulto: { plu: '101', nombre: 'Pack101', origen: 'fila' } });
  assert.deepStrictEqual(r['300'], { pack: null, bulto: null });
  assert.deepStrictEqual(r['400'], { pack: null, bulto: { plu: '201', nombre: 'Doscientos uno', origen: 'fila' } });
  assert.deepStrictEqual(r['500'].pack, null);
  assert.ok(!('9005' in r));
  assert.deepStrictEqual(C.vinculosResueltos(filas, indice())['200'].pack, { plu: '201', nombre: null, origen: 'fila' });
});

test('plusSinNombre: sólo explícitos no manuales, sin repetidos, excluye los que el índice nombra', () => {
  assert.deepStrictEqual(C.plusSinNombre(filas, indice()), ['201', '301', '302', '401', '501']);
  assert.deepStrictEqual(C.plusSinNombre([], indice()), []);
});

test('filasExportarCodigos: 8 columnas, nombres llenos/vacíos (manual, ninguno, sin nombre)', () => {
  const r = C.filasExportarCodigos(filas, indice(), { 201: 'Doscientos uno' });
  assert.strictEqual(r[0].length, 8);
  const por = Object.fromEntries(r.slice(1).map(x => [x[1], x.slice(6)]));
  assert.deepStrictEqual(por.Siga, ['Pack101', '']);
  assert.deepStrictEqual(por.Explicito, ['Doscientos uno', 'Pack101']);
  assert.deepStrictEqual(por.Ninguno, ['', '']);
  assert.deepStrictEqual(por.Manual, ['', '']);
  assert.ok(r.every(x => x.length === 8));
});

// ── Rutas ──
function montar({ listadosVigentes = async () => listados, nombresPorPlu, filasTabla = filas } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotmay-nom-'));
  fs.writeFileSync(path.join(dir, 'cotizador_mayorista.json'), JSON.stringify({ filas: filasTabla }));
  const apiRoute = fn => async (req, res) => { try { res.json(await fn(req)); } catch (err) { res.status(500).json({ error: err.message }); } };
  const app = express();
  app.use(require('../routes/rutas_cotizador_mayorista')({ apiRoute, DATA_DIR: dir, tienePermiso: () => false, listadosVigentes, nombresPorPlu }));
  return new Promise(ok => { const server = app.listen(0, () => ok({ server, dir, base: `http://127.0.0.1:${server.address().port}/api/cotizador-mayorista` })); });
}
const cerrar = ({ server, dir }) => { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); };
const get = async url => { const r = await fetch(url); return { status: r.status, data: await r.json() }; };
const silencio = async fn => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

test('ruta /vinculos: pide a SIGA sólo los faltantes y arma nombres (sin permiso de escritura)', async () => {
  const llamadas = [];
  const ctx = await montar({ nombresPorPlu: async p => { llamadas.push(p); return { 201: 'Doscientos uno' }; } });
  try {
    const { status, data } = await get(`${ctx.base}/vinculos`);
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(llamadas, [['201', '301', '302', '401', '501']]);
    assert.deepStrictEqual(data.vinculos['200'].pack, { plu: '201', nombre: 'Doscientos uno', origen: 'fila' });
    assert.deepStrictEqual(data.vinculos['100'].pack, { plu: '101', nombre: 'Pack101', origen: 'siga' });
  } finally { cerrar(ctx); }
});

test('ruta /vinculos: no llama a nombresPorPlu si no falta ninguno', async () => {
  let n = 0;
  const ctx = await montar({ filasTabla: [filas[0]], nombresPorPlu: async () => { n++; return {}; } });
  try { assert.strictEqual((await get(`${ctx.base}/vinculos`)).status, 200); assert.strictEqual(n, 0); } finally { cerrar(ctx); }
});

test('ruta /vinculos: listados y nombresPorPlu fallan → responde igual con nombre null', async () => {
  const ctx = await montar({ listadosVigentes: async () => { throw new Error('sql caído'); }, nombresPorPlu: async () => { throw new Error('timeout'); } });
  try {
    const { status, data } = await silencio(() => get(`${ctx.base}/vinculos`));
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(data.vinculos['100'], { pack: null, bulto: null });
    assert.deepStrictEqual(data.vinculos['200'].pack, { plu: '201', nombre: null, origen: 'fila' });
  } finally { cerrar(ctx); }
});

test('ruta /nombres: sin param o sólo no numéricos → {} sin consultar', async () => {
  let n = 0;
  const ctx = await montar({ nombresPorPlu: async () => { n++; return {}; } });
  try {
    assert.deepStrictEqual((await get(`${ctx.base}/nombres`)).data, { nombres: {} });
    assert.deepStrictEqual((await get(`${ctx.base}/nombres?plus=abc,1;DROP`)).data, { nombres: {} });
    assert.strictEqual(n, 0);
  } finally { cerrar(ctx); }
});

test('ruta /nombres: numéricos → nombre o null; no numéricos ignorados; repetidos una vez', async () => {
  const llamadas = [];
  const ctx = await montar({ nombresPorPlu: async p => { llamadas.push(p); return { 201: 'Doscientos uno' }; } });
  try {
    const { status, data } = await get(`${ctx.base}/nombres?plus=201, 999,abc,201`);
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(data, { nombres: { 201: 'Doscientos uno', 999: null } });
    assert.deepStrictEqual(llamadas, [['201', '999']]);
  } finally { cerrar(ctx); }
});

test('ruta /nombres: más de 50 → { error }; nombresPorPlu lanza → 500', async () => {
  let ctx = await montar({ nombresPorPlu: async () => ({}) });
  try {
    const plus = Array.from({ length: 51 }, (_, i) => i + 1).join(',');
    const { status, data } = await get(`${ctx.base}/nombres?plus=${plus}`);
    assert.strictEqual(status, 200);
    assert.ok(data.error);
  } finally { cerrar(ctx); }
  ctx = await montar({ nombresPorPlu: async () => { throw new Error('timeout'); } });
  try {
    const { status, data } = await get(`${ctx.base}/nombres?plus=201`);
    assert.strictEqual(status, 500);
    assert.strictEqual(data.error, 'timeout');
  } finally { cerrar(ctx); }
});

test('ruta codigos.xlsx: nombresPorPlu falla → descarga igual, nombres de explícitos vacíos', async () => {
  const ctx = await montar({ nombresPorPlu: async () => { throw new Error('timeout'); } });
  try {
    const r = await silencio(() => fetch(`${ctx.base}/codigos.xlsx`));
    assert.strictEqual(r.status, 200);
    const aoa = XLSX.utils.sheet_to_json(XLSX.read(Buffer.from(await r.arrayBuffer()), { type: 'buffer' }).Sheets.codigos, { header: 1, defval: '' });
    assert.strictEqual(aoa[0][6], 'NombrePack');
    const explicito = aoa.find(x => x[1] === 'Explicito');
    assert.deepStrictEqual(explicito.slice(6), ['', 'Pack101']);
  } finally { cerrar(ctx); }
});

test('autocompletar: nombrePlu por origen (sigaVinculo, presentacion, formula)', () => {
  const pres = (plu, pesoG, tipo) => ({ plu, nombre: `P${plu}`, pesoG, mayorista: !!tipo, mayoristaTipo: tipo || null });
  const lst = { fraccionado: [{ plu: '500', decision: { fuente: 'sistema' }, presentaciones: [pres('501', 250), pres('502', 10000, 'pack')] }],
    almacen: [{ plu: '500', mayoristas: [{ plu: '700', tipo: 'bulto', nombre: 'Bulto700' }] }] };
  const fila = { cod: '500', seccion: 'S', nombre: 'Almendra', packQty: '10kg', bultoQty: '25kg' };
  let r = C.autocompletarVinculos([fila], C.indicePrecios(lst));
  assert.deepStrictEqual(r.completadas.map(c => [c.origen, c.nombrePlu]), [['presentacion', 'P502'], ['sigaVinculo', 'Bulto700']]);
  const usos = [{ basePlu: '100', plu: '200', nombre: 'PEPAS X24', cantidad: 24, rubro: 'X' }];
  r = C.autocompletarVinculos([{ cod: '100', seccion: 'S', nombre: 'Pepas', packQty: '', bultoQty: '24u' }], new Map(), C.candidatosPorFormula(usos));
  assert.deepStrictEqual(r.completadas.map(c => [c.origen, c.nombrePlu]), [['formula', 'PEPAS X24']]);
});

test('nombresPorPlu: descarta no numéricos/inyección, chunk de 500, devuelve { plu: nombre }; undefined → {}', async () => {
  const sqls = [];
  const { nombresPorPlu } = require('../lib/precios_consultas').crearConsultasPrecios({ LISTA_PRECIOS_VENTA: 0, FORMULA_ACTIVA_SQL: '1=1', SIN_FORMULA_GENERICO_SQL: '1=1',
    query: async sql => { sqls.push(sql); return sqls.length === 1 ? [{ plu: '1 ', nombre: 'Uno' }] : [{ plu: '501', nombre: 'Q' }]; } });
  const ids = [...Array.from({ length: 600 }, (_, i) => String(i + 1)), "1'; DROP TABLE x--", '', null, '1', 7];
  const r = await nombresPorPlu(ids);
  assert.strictEqual(sqls.length, 2);
  assert.ok(!sqls.join().includes('DROP'));
  assert.match(sqls[0], /FROM Productos WHERE IdProducto IN \('1','2'/);
  assert.deepStrictEqual(r, { 1: 'Uno', 501: 'Q' });
  sqls.length = 0;
  assert.deepStrictEqual(await nombresPorPlu(undefined), {});
  assert.strictEqual(sqls.length, 0);
});
