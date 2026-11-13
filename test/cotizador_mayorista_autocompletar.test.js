'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/cotizador_mayorista');

const pres = (plu, pesoG, tipo, extra = {}) => ({ plu, nombre: `P${plu}`, pesoG, mayorista: !!tipo, mayoristaTipo: tipo || null, ...extra });
// Granel 500 con minorista 501 (250 g) y mayoristas según `may`.
const frac = (may, extra = {}) => ({ fraccionado: [{ plu: '500', decision: { fuente: 'sistema' }, ...extra,
  presentaciones: [pres('501', 250), ...may] }] });
const fila = x => ({ cod: '500', seccion: 'S', nombre: 'Almendra', packQty: '10kg', bultoQty: '25kg', ...x });
const auto = (filas, lst) => C.autocompletarVinculos(filas, C.indicePrecios(lst));

test('granel con una sola mayorista → bulto', () => {
  const r = auto([fila({ packQty: '' })], frac([pres('502', 25000, 'bulto')]));
  assert.strictEqual(r.filas[0].bultoPlu, '502');
  assert.deepStrictEqual(r.completadas, [{ cod: '500', nombre: 'Almendra', tipo: 'bulto', plu: '502', origen: 'presentacion', nombrePlu: 'P502' }]);
  assert.deepStrictEqual(r.sinVincular, []);
});

test('dos mayoristas → pack (menor) + bulto (mayor)', () => {
  const r = auto([fila({})], frac([pres('502', 10000, 'pack'), pres('503', 25000, 'bulto')]));
  assert.deepStrictEqual([r.filas[0].packPlu, r.filas[0].bultoPlu], ['502', '503']);
});

test('cod = presentación minorista del grupo también vincula', () => {
  const r = auto([fila({ cod: '501' })], frac([pres('502', 10000, 'pack'), pres('503', 25000, 'bulto')]));
  assert.deepStrictEqual([r.filas[0].packPlu, r.filas[0].bultoPlu], ['502', '503']);
});

test('no pisa Plu explícito ni muta la entrada', () => {
  const f = fila({ packPlu: '999' });
  const r = auto([f], frac([pres('502', 10000, 'pack'), pres('503', 25000, 'bulto')]));
  assert.strictEqual(r.filas[0].packPlu, '999');
  assert.strictEqual(r.filas[0].bultoPlu, '503');
  assert.strictEqual(f.bultoPlu, undefined);
});

test('sin cantidad no completa; modoPack ninguno no completa pack', () => {
  const lst = frac([pres('502', 10000, 'pack'), pres('503', 25000, 'bulto')]);
  assert.strictEqual(auto([fila({ bultoQty: '' })], lst).filas[0].bultoPlu, undefined);
  const r = auto([fila({ modoPack: 'ninguno' })], lst);
  assert.strictEqual(r.filas[0].packPlu, undefined);
  assert.strictEqual(r.filas[0].bultoPlu, '503');
});

test('sin vínculo → sinVincular', () => {
  const r = auto([fila({})], frac([]));
  assert.deepStrictEqual(r.sinVincular, [{ cod: '500', nombre: 'Almendra', faltan: ['pack', 'bulto'] }]);
});

test('vínculo SIGA gana sobre presentación mayorista', () => {
  const lst = frac([pres('502', 25000, 'bulto')], { mayoristas: [{ plu: '700', tipo: 'bulto' }] });
  assert.strictEqual(auto([fila({ packQty: '' })], lst).filas[0].bultoPlu, '700');
});

test('presentación mayorista entra al índice sólo como vínculo (sin precios)', () => {
  const m = C.indicePrecios(frac([pres('502', 25000, 'bulto')])).get('502');
  assert.deepStrictEqual([m.basePlu, m.tipo, m.presentacion, m.hermanos.has('501')], ['500', 'bulto', true, true]);
  assert.ok(!('decidido' in m) && !('vigente' in m));
});

test('sin autocompletar, cod de granel sin packPlu NO toma la presentación (preview/resumen)', () => {
  const idx = C.indicePrecios(frac([pres('502', 10000, 'pack'), pres('503', 25000, 'bulto')]));
  const f = fila({});
  assert.strictEqual(C.pluVinculado(f, 'pack', idx), null);
  assert.deepStrictEqual(C.resumenVinculos([f], idx).sinVincular, [{ cod: '500', nombre: 'Almendra', faltan: ['pack', 'bulto'] }]);
  const r = C.armarCatalogo({ tabla: { filas: C.validarTabla([f]) }, indice: idx });
  assert.deepStrictEqual([r.filas.length, r.revisar[0].motivos], [0, ['pack: sin vínculo', 'bulto: sin vínculo']]); // no toma precio de la presentación
  assert.strictEqual(idx.get('502').presentacion, true);
});

// ── Ruta POST /autocompletar ──
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
function montar({ permiso = true, usosComoFormula } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotmay-auto-'));
  const apiRoute = fn => async (req, res) => { try { res.json(await fn(req)); } catch (err) { res.status(500).json({ error: err.message }); } };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { id: 1, usuario: 'tester' } }; next(); });
  app.use(require('../routes/rutas_cotizador_mayorista')({ apiRoute, DATA_DIR: dir, tienePermiso: () => permiso, usosComoFormula,
    listadosVigentes: async () => frac([pres('502', 10000, 'pack'), pres('503', 25000, 'bulto')]) }));
  return new Promise(ok => { const server = app.listen(0, () => ok({ server, dir, base: `http://127.0.0.1:${server.address().port}/api/cotizador-mayorista` })); });
}
const post = async base => { const r = await fetch(`${base}/autocompletar`, { method: 'POST' }); return { status: r.status, data: await r.json() }; };
const cerrar = ({ server, dir }) => { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); };
const escribir = (dir, filas) => fs.writeFileSync(path.join(dir, 'cotizador_mayorista.json'), JSON.stringify({ filas }));

test('ruta autocompletar: guarda la tabla con los PLU completados', async () => {
  const ctx = await montar();
  try {
    escribir(ctx.dir, [fila({})]);
    const { status, data } = await post(ctx.base);
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(data.completadas.map(c => c.plu), ['502', '503']);
    const guardada = JSON.parse(fs.readFileSync(path.join(ctx.dir, 'cotizador_mayorista.json'), 'utf8'));
    assert.deepStrictEqual([guardada.filas[0].packPlu, guardada.filas[0].bultoPlu], ['502', '503']);
  } finally { cerrar(ctx); }
});

test('ruta autocompletar: tabla inválida → { error } sin guardar; sin permiso → 403', async () => {
  let ctx = await montar();
  try {
    escribir(ctx.dir, [fila({ cod: 'abc' })]);
    const antes = fs.readFileSync(path.join(ctx.dir, 'cotizador_mayorista.json'), 'utf8');
    const { status, data } = await post(ctx.base);
    assert.strictEqual(status, 200);
    assert.ok(data.error);
    assert.strictEqual(fs.readFileSync(path.join(ctx.dir, 'cotizador_mayorista.json'), 'utf8'), antes);
  } finally { cerrar(ctx); }
  ctx = await montar({ permiso: false });
  try { assert.strictEqual((await post(ctx.base)).status, 403); } finally { cerrar(ctx); }
});

// ── Fuente fórmula (candidatosPorFormula + 3ª fuente de autocompletarVinculos) ──
const u = (plu, nombre, cantidad, basePlu = '100') => ({ basePlu, plu, nombre, cantidad, rubro: 'X' });
const filaF = x => ({ cod: '100', seccion: 'S', nombre: 'Pepas', packQty: '6u', bultoQty: '24u', ...x });
const runF = (filas, usos, idx = new Map()) => C.autocompletarVinculos(filas, idx, C.candidatosPorFormula(usos));

test('fórmula: único candidato sin tipo → bulto, origen formula', () => {
  const r = runF([filaF({ packQty: '' })], [u('200', 'PEPAS X24', 24)]);
  assert.deepStrictEqual(r.completadas, [{ cod: '100', nombre: 'Pepas', tipo: 'bulto', plu: '200', origen: 'formula', nombrePlu: 'PEPAS X24' }]);
});

test('fórmula: dos sin tipo → menor pack / mayor bulto; nombre manda', () => {
  let r = runF([filaF({})], [u('201', 'A', 24), u('202', 'B', 6)]);
  assert.deepStrictEqual([r.filas[0].packPlu, r.filas[0].bultoPlu], ['202', '201']);
  r = runF([filaF({})], [u('201', 'PEPAS PACK', 24), u('202', 'B', 6)]);
  assert.deepStrictEqual([r.filas[0].packPlu, r.filas[0].bultoPlu], ['201', '202']);
});

test('fórmula: columna libre — uno con tipo por nombre + uno sin tipo toma la que falta (aunque su cantidad sea menor)', () => {
  const r = runF([filaF({})], [u('201', 'PEPAS BULTO', 24), u('202', 'B', 48)]);
  assert.deepStrictEqual([r.filas[0].packPlu, r.filas[0].bultoPlu], ['202', '201']);
  const r2 = runF([filaF({})], [u('201', 'PEPAS CAJA', 24), u('202', 'B', 6)]);
  assert.deepStrictEqual([r2.filas[0].packPlu, r2.filas[0].bultoPlu], ['202', '201']);
});

test('fórmula: ambiguos → sinVincular con motivo y sin asignar', () => {
  let r = runF([filaF({})], [u('1', 'A', 1), u('2', 'B', 2), u('3', 'C', 3)]);
  assert.strictEqual(r.filas[0].packPlu, undefined); assert.match(r.sinVincular[0].motivo, /3 candidato/);
  r = runF([filaF({})], [u('1', 'A', 6), u('2', 'B', 6)]);
  assert.strictEqual(r.completadas.length, 0); assert.match(r.sinVincular[0].motivo, /misma cantidad/);
  r = runF([filaF({})], [u('1', 'PEPAS PACK X6', 6), u('2', 'PACK X12', 12)]);
  assert.strictEqual(r.completadas.length, 0); assert.match(r.sinVincular[0].motivo, /mismo tipo por nombre/);
  assert.match(r.sinVincular[0].motivo, /\(1, 2\)/);
});

test('fórmula: no pisa explícito ni repite PLU en pack y bulto', () => {
  let r = runF([filaF({ packPlu: '9' })], [u('201', 'A', 24), u('202', 'B', 6)]);
  assert.deepStrictEqual([r.filas[0].packPlu, r.filas[0].bultoPlu], ['9', '201']);
  r = runF([filaF({ bultoPlu: '200' })], [u('200', 'PEPAS PACK', 24)]);
  assert.strictEqual(r.filas[0].packPlu, undefined);
});

test('origen: SIGA (sigaVinculo) y presentación ganan sobre fórmula', () => {
  const lst = frac([pres('502', 10000, 'pack')], { mayoristas: [{ plu: '700', tipo: 'bulto' }] });
  const r = C.autocompletarVinculos([fila({})], C.indicePrecios(lst), C.candidatosPorFormula([u('800', 'A', 1, '500'), u('801', 'B', 2, '500')]));
  assert.deepStrictEqual(r.completadas.map(c => [c.tipo, c.plu, c.origen]), [['pack', '502', 'presentacion'], ['bulto', '700', 'sigaVinculo']]);
});

test('ruta autocompletar: usosComoFormula sólo con cod numéricos con faltantes; asigna por fórmula', async () => {
  const llamadas = [];
  const ctx = await montar({ usosComoFormula: async plus => { llamadas.push(plus); return [u('900', 'PEPAS CAJA', 24, '100')]; } });
  try {
    escribir(ctx.dir, [fila({}), filaF({ packQty: '' }), filaF({ cod: '101', packQty: '', bultoPlu: '5' })]);
    const { status, data } = await post(ctx.base);
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(llamadas, [['100']]);
    assert.deepStrictEqual(data.completadas.find(c => c.cod === '100'), { cod: '100', nombre: 'Pepas', tipo: 'bulto', plu: '900', origen: 'formula', nombrePlu: 'PEPAS CAJA' });
  } finally { cerrar(ctx); }
});

test('ruta autocompletar: sin faltantes no consulta; si usosComoFormula tira, sigue sin esa fuente', async () => {
  let n = 0;
  let ctx = await montar({ usosComoFormula: async () => { n++; return []; } });
  try { escribir(ctx.dir, [fila({})]); assert.strictEqual((await post(ctx.base)).status, 200); assert.strictEqual(n, 0); } finally { cerrar(ctx); }
  const err = console.error; console.error = () => {};
  ctx = await montar({ usosComoFormula: async () => { throw new Error('timeout'); } });
  try {
    escribir(ctx.dir, [fila({}), filaF({ packQty: '' })]);
    const { status, data } = await post(ctx.base);
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(data.completadas.map(c => c.plu), ['502', '503']);
    assert.deepStrictEqual(data.sinVincular, [{ cod: '100', nombre: 'Pepas', faltan: ['bulto'] }]);
  } finally { console.error = err; cerrar(ctx); }
});

test('usosComoFormula: descarta ids no numéricos, chunk de 500, normaliza filas', async () => {
  const sqls = [];
  const { usosComoFormula } = require('../lib/precios_consultas').crearConsultasPrecios({ LISTA_PRECIOS_VENTA: 0, FORMULA_ACTIVA_SQL: '1=1', SIN_FORMULA_GENERICO_SQL: '1=1',
    query: async sql => { sqls.push(sql); return sqls.length === 1 ? [{ basePlu: '1 ', plu: ' 9', nombre: 'N', cantidad: '6', rubro: null }] : []; } });
  const ids = [...Array.from({ length: 600 }, (_, i) => String(i + 1)), "1'; DROP TABLE x--", '', null, '1'];
  const r = await usosComoFormula(ids);
  assert.strictEqual(sqls.length, 2);
  assert.ok(!sqls.join().includes('DROP'));
  assert.match(sqls[0], /HAVING COUNT\(\*\) = 1/);
  assert.deepStrictEqual(r, [{ basePlu: '1', plu: '9', nombre: 'N', cantidad: 6, rubro: null }]);
  assert.deepStrictEqual(await usosComoFormula(undefined), []);
});
