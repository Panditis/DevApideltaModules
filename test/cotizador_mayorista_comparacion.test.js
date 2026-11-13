'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const C = require('../lib/cotizador_mayorista');

const pres = (plu, pesoG, tipo) => ({ plu, nombre: `P${plu}`, pesoG, mayorista: !!tipo, mayoristaTipo: tipo || null });
const listados = {
  almacen: [{ plu: '100', decision: { fuente: 'sistema' }, mayoristas: [{ plu: '101', tipo: 'pack' }, { plu: '102', tipo: 'bulto' }],
    sugeridos: { sistema: { mayoristas: [{ plu: '101', neto: 1000 }, { plu: '102', neto: 900 }] } } }],
  fraccionado: [{ plu: '500', decision: { fuente: 'sistema' }, presentaciones: [pres('501', 250), pres('502', 25000, 'bulto')] }],
  produccion: [],
};

test('compararCodigos: origen presentacion (fraccionado) y pack ninguno → no aplica', () => {
  const r = C.compararCodigos([
    { cod: '500', seccion: 'S', nombre: 'Almendra', packQty: '', bultoQty: '25kg', bultoPlu: '502' },
    { cod: '100', seccion: 'S', nombre: 'Miel', packQty: '8u', bultoQty: '32u', modoPack: 'ninguno', packPlu: '101' },
  ], C.indicePrecios(listados), {});
  const [a, b] = r.detalle;
  assert.deepStrictEqual(a.bulto.sistema, { plu: '502', nombre: 'P502', origen: 'presentacion' });
  assert.strictEqual(a.bulto.estado, 'igual');
  assert.deepStrictEqual(b.pack, { catalogo: null, sistema: null, estado: 'no aplica' });
  assert.strictEqual(b.bulto.sistema.origen, 'sigaVinculo');
});

test('compararCodigos: lista vacía', () => {
  assert.deepStrictEqual(C.compararCodigos([]), { iguales: 0, distintos: 0, soloCatalogo: 0, soloSistema: 0, sinDato: 0, detalle: [] });
});

function montar(estado) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotmay-c-'));
  const apiRoute = fn => async (req, res) => { try { res.json(await fn(req)); } catch (err) { res.status(500).json({ error: err.message }); } };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { id: 1, usuario: 'tester' } }; next(); });
  app.use(require('../routes/rutas_cotizador_mayorista')({ apiRoute, DATA_DIR: dir, tienePermiso: () => true,
    listadosVigentes: async () => { if (estado.fallar) throw new Error('sin SIGA'); return listados; }, nombresPorPlu: async () => ({}),
    preciosSigaPorPlu: async () => { if (estado.fallarSiga) throw new Error('SIGA caído'); return new Map([['101', 1000], ['102', 900]]); } }));
  return new Promise(ok => { const server = app.listen(0, () => ok({ server, dir, base: `http://127.0.0.1:${server.address().port}/api/cotizador-mayorista` })); });
}
const pedir = async (base, metodo, url, body) => {
  const r = await fetch(base + url, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json() };
};
const cerrar = ({ server, dir }) => { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); };
const filaMiel = q => ({ cod: '100', seccion: 'S', nombre: 'Miel', packQty: '8u', bultoQty: q });

test('rutas: comparacion-codigos con listadosVigentes caído → 200, sistema null', async (t) => {
  t.mock.method(console, 'error', () => {});
  const ctx = await montar({ fallar: true });
  try {
    await pedir(ctx.base, 'PUT', '/tabla', { filas: [{ ...filaMiel('32u'), bultoPlu: '102' }] });
    const r = await pedir(ctx.base, 'GET', '/comparacion-codigos');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual([r.data.detalle[0].bulto.estado, r.data.detalle[0].bulto.sistema, r.data.soloCatalogo], ['solo catálogo', null, 1]);
  } finally { cerrar(ctx); }
});

test('rutas: comparacion con cantidad inválida (usa respaldo) y meta.json corrupto', async (t) => {
  t.mock.method(console, 'error', () => {});
  const ctx = await montar({});
  try {
    await pedir(ctx.base, 'PUT', '/tabla', { filas: [filaMiel('32u')] });
    assert.strictEqual((await pedir(ctx.base, 'POST', '/exportar')).data.version, 1);
    await pedir(ctx.base, 'PUT', '/tabla', { filas: [filaMiel('docena')] });
    fs.writeFileSync(path.join(ctx.dir, 'cotizador_publicaciones', 'v001', 'meta.json'), '{roto');
    const r = await pedir(ctx.base, 'GET', '/comparacion');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual([r.data.version, r.data.generado, r.data.publicado], [1, null, null]);
    const bulto = r.data.detalle.find(d => d.tipo === 'bulto');
    assert.ok(bulto, JSON.stringify(r.data));
    assert.deepStrictEqual([bulto.estado, bulto.publicado, bulto.sistema], ['igual', 900, 900]);
  } finally { cerrar(ctx); }
});

test('rutas: preview/comparacion con SIGA caído → 500 { error }, no cae a respaldo en silencio', async (t) => {
  t.mock.method(console, 'error', () => {});
  const ctx = await montar({ fallarSiga: true });
  try {
    await pedir(ctx.base, 'PUT', '/tabla', { filas: [filaMiel('32u')] });
    for (const url of ['/preview', '/comparacion']) {
      const r = await pedir(ctx.base, 'GET', url);
      assert.deepStrictEqual([r.status, r.data.error], [500, 'SIGA caído'], url);
    }
  } finally { cerrar(ctx); }
});
