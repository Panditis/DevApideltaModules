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
  assert.deepStrictEqual(r.completadas, [{ cod: '500', nombre: 'Almendra', tipo: 'bulto', plu: '502' }]);
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

test('sin cantidad no completa; modoPack descuento/ninguno no completa pack', () => {
  const lst = frac([pres('502', 10000, 'pack'), pres('503', 25000, 'bulto')]);
  assert.strictEqual(auto([fila({ bultoQty: '' })], lst).filas[0].bultoPlu, undefined);
  for (const modoPack of ['descuento', 'ninguno']) {
    const r = auto([fila({ modoPack, descuentoPack: 10 })], lst);
    assert.strictEqual(r.filas[0].packPlu, undefined);
    assert.strictEqual(r.filas[0].bultoPlu, '503');
  }
});

test('fila manual queda intacta', () => {
  const f = fila({ manual: true, packPrice: 1, bultoPrice: 2 });
  const r = auto([f], frac([pres('502', 10000, 'pack'), pres('503', 25000, 'bulto')]));
  assert.strictEqual(r.filas[0], f);
  assert.deepStrictEqual([r.completadas, r.sinVincular], [[], []]);
});

test('sin vínculo → sinVincular', () => {
  const r = auto([fila({})], frac([]));
  assert.deepStrictEqual(r.sinVincular, [{ cod: '500', nombre: 'Almendra', faltan: ['pack', 'bulto'] }]);
});

test('vínculo SIGA gana sobre presentación mayorista', () => {
  const lst = frac([pres('502', 25000, 'bulto')], { mayoristas: [{ plu: '700', tipo: 'bulto' }] });
  assert.strictEqual(auto([fila({ packQty: '' })], lst).filas[0].bultoPlu, '700');
});

test('precio decidido sinIva de la presentación entra al índice', () => {
  const sug = { sistema: { minorista: { precio: 4321, sinIva: true } }, ultimaCompra: { minorista: { precio: 1, sinIva: false } } };
  const idx = C.indicePrecios(frac([pres('502', 25000, 'bulto', { sugeridos: sug })]));
  const m = idx.get('502');
  assert.deepStrictEqual([m.basePlu, m.tipo, m.decidido, m.sugerido, m.fuenteSugerido], ['500', 'bulto', 4321, 4321, 'sistema']);
  const sinIva = C.indicePrecios(frac([pres('502', 25000, 'bulto', { sugeridos: { sistema: { minorista: { precio: 5 } } } })]), {});
  assert.strictEqual(sinIva.get('502').decidido, null);
});

test('sin autocompletar, cod de granel sin packPlu NO toma la presentación (preview/resumen)', () => {
  const idx = C.indicePrecios(frac([pres('502', 10000, 'pack'), pres('503', 25000, 'bulto')]));
  const f = fila({});
  assert.strictEqual(C.pluVinculado(f, 'pack', idx), null);
  assert.deepStrictEqual(C.resumenVinculos([f], idx).sinVincular, [{ cod: '500', nombre: 'Almendra', faltan: ['pack', 'bulto'] }]);
  const r = C.armarCatalogo({ tabla: { filas: C.validarTabla([f]) }, indice: idx });
  assert.ok(!r.filas.some(x => x.origen && x.origen.pack === 'decision')); // sin vínculo: no sale precio de la presentación
  assert.strictEqual(idx.get('502').presentacion, true);
});

// ── Ruta POST /autocompletar ──
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
function montar({ permiso = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotmay-auto-'));
  const apiRoute = fn => async (req, res) => { try { res.json(await fn(req)); } catch (err) { res.status(500).json({ error: err.message }); } };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { id: 1, usuario: 'tester' } }; next(); });
  app.use(require('../routes/rutas_cotizador_mayorista')({ apiRoute, DATA_DIR: dir, tienePermiso: () => permiso,
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
