'use strict';
// Router de Configuración › Costeo Fraccionado por HTTP, con costeo.json en un directorio temporal y SIGA falso.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const crearRutas = require('../routes/rutas_precios_fraccionado');
const { crearGuardPrecios } = require('../lib/precios_permisos');

function appCon(costeo, { query = async () => [], guard = false, sinConfig = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fracc-rutas-'));
  const archivo = path.join(dir, 'costeo.json');
  if (costeo) fs.writeFileSync(archivo, JSON.stringify(costeo));
  const leerJSON = (p, def) => { try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : def; } catch { return def; } };
  const guardarJSON = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2));
  const apiRoute = fn => async (req, res) => { try { res.json(await fn(req)); } catch (err) { res.status(500).json({ error: err.message }); } };
  const app = express();
  app.use(express.json());
  if (guard) app.use(crearGuardPrecios({ tienePermiso: () => !sinConfig }));
  app.use(crearRutas({ apiRoute, query, leerJSON, guardarJSON, DATA_DIR: dir, LISTA_PRECIOS_VENTA: 0, FORMULA_ACTIVA_SQL: '1=1', SIN_FORMULA_GENERICO_SQL: '1=1' }));
  let server;
  const pedir = async (metodo, ruta, body) => {
    if (!server) server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const res = await fetch(`http://127.0.0.1:${server.address().port}${ruta}`,
      { method: metodo, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, ...(await res.json()) };
  };
  return { pedir, leer: () => JSON.parse(fs.readFileSync(archivo, 'utf8')), cerrar: () => server && server.close() };
}

const BASE = '/api/precios/config/esquema/fraccionado';
const FRACC = { costoHora: 6000, maquinas: [] };

test('sin migrar: GET da migrado false con defaults y los PUT no escriben', async () => {
  const a = appCon({ ivaVentaPct: 21 });
  try {
    const j = await a.pedir('GET', BASE);
    assert.deepStrictEqual([j.migrado, j.maquinas, j.escalas.facilidad.normal, j.subrubros, j.insumosPorPeso], [false, [], 1.25, {}, {}]);
    assert.match((await a.pedir('PUT', `${BASE}/escalas`, { escalas: {} })).error, /migrar_config_fraccionado/);
    assert.match((await a.pedir('PUT', `${BASE}/insumos-peso/500`, { insumos: [{ plu: '900', cantidad: 1 }] })).error, /migrar_config_fraccionado/);
    assert.strictEqual(a.leer().fraccionado, undefined);
  } finally { a.cerrar(); }
});

test('costeo.fraccionado que no es un bloque (lista o número) cuenta como sin migrar: el PUT no lo pisa', async () => {
  for (const basura of [[], 5]) {
    const a = appCon({ fraccionado: basura });
    try {
      assert.strictEqual((await a.pedir('GET', BASE)).migrado, false);
      assert.match((await a.pedir('PUT', `${BASE}/maquinas`, { maquinas: [] })).error, /migrar_config_fraccionado/);
      assert.deepStrictEqual(a.leer().fraccionado, basura);
    } finally { a.cerrar(); }
  }
});

test('máquinas: alta, en un subrubro y como excepción de un granel; no se borra en uso; el resto de costeo.fraccionado queda', async () => {
  const a = appCon({ fraccionado: FRACC });
  try {
    const j = await a.pedir('PUT', `${BASE}/maquinas`, { maquinas: [{ nombre: 'Envasadora Grande', costoHora: 3000 }] });
    assert.deepStrictEqual(j.maquinas, [{ id: 'envasadora-grande', nombre: 'Envasadora Grande', costoHora: 3000, usos: { graneles: 0, subrubros: 0 } }]);
    const s = await a.pedir('PUT', `${BASE}/subrubros/7`, { maquinaId: 'envasadora-grande', tramos: [{ hastaG: 1000, minutos: 1 }] });
    assert.deepStrictEqual(s.subrubros, { 7: { maquinaId: 'envasadora-grande', tramos: [{ hastaG: 1000, minutos: 1 }] } });
    const g = await a.pedir('PUT', `${BASE}/granel/100`, { maquinaId: 'envasadora-grande' });
    assert.deepStrictEqual([g.porGranel, g.maquinas[0].usos], [{ 100: { maquinaId: 'envasadora-grande' } }, { graneles: 1, subrubros: 1 }]);
    assert.match((await a.pedir('PUT', `${BASE}/maquinas`, { maquinas: [] })).error, /Envasadora Grande la usan 1 subrubro y 1 granel/);
    assert.match((await a.pedir('PUT', `${BASE}/subrubros/7`, { maquinaId: 'otra', tramos: [] })).error, /maquinaId/);
    assert.deepStrictEqual((await a.pedir('PUT', `${BASE}/granel/100`, { maquinaId: null })).porGranel, {});
    assert.strictEqual(a.leer().fraccionado.costoHora, 6000);
  } finally { a.cerrar(); }
});

test('escalas: se guardan validadas', async () => {
  const a = appCon({ fraccionado: FRACC });
  try {
    const escalas = { facilidad: { facil: 1, normal: 1.2, dificil: 2 }, tiempo: { rapido: 0.5, normal: 1, lento: 2 } };
    assert.deepStrictEqual((await a.pedir('PUT', `${BASE}/escalas`, { escalas })).escalas, escalas);
    assert.match((await a.pedir('PUT', `${BASE}/escalas`, { escalas: { ...escalas, tiempo: { rapido: 0, normal: 1, lento: 1 } } })).error, /tiempo\.rapido/);
    assert.deepStrictEqual(a.leer().fraccionado.escalas, escalas);
  } finally { a.cerrar(); }
});

test('subrubros: facilidad y tiempo se guardan con la máquina y los tramos; inválidos → error', async () => {
  const a = appCon({ fraccionado: FRACC });
  try {
    const s = await a.pedir('PUT', `${BASE}/subrubros/7`, { maquinaId: null, tramos: [], facilidad: 'dificil', tiempo: 'rapido' });
    assert.deepStrictEqual(s.subrubros, { 7: { maquinaId: null, tramos: [], facilidad: 'dificil', tiempo: 'rapido' } });
    assert.match((await a.pedir('PUT', `${BASE}/subrubros/7`, { facilidad: 'medio' })).error, /facilidad/);
    assert.deepStrictEqual((await a.pedir('PUT', `${BASE}/subrubros/7`, { maquinaId: null, tramos: [], facilidad: null, tiempo: null })).subrubros, {});
  } finally { a.cerrar(); }
});

test('insumos-peso: guarda la lista del peso y responde la vista; [] la saca; lo viejo (presentaciones, insumosPresentacion) no se reescribe', async () => {
  const viejo = { ...FRACC, facilidades: { facil: 1, medio: 1.3, dificil: 2 }, insumosPresentacion: { 102: [{ plu: '900', cantidad: 1 }] },
    presentaciones: { 101: { facilidad: 'facil' } } };
  const a = appCon({ fraccionado: viejo });
  try {
    const r = await a.pedir('PUT', `${BASE}/insumos-peso/500`, { insumos: [{ plu: '900', cantidad: 1 }] });
    assert.deepStrictEqual([r.status, r.migrado, r.insumosPorPeso], [200, true, { 500: [{ plu: '900', cantidad: 1 }] }]);
    const f = a.leer().fraccionado;
    assert.deepStrictEqual(f.insumosPorPeso, { 500: [{ plu: '900', cantidad: 1 }] });
    assert.deepStrictEqual([f.escalas.facilidad.normal, 'facilidades' in f, 'presentaciones' in f, 'insumosPresentacion' in f], [1.3, false, false, false]);
    assert.match((await a.pedir('PUT', `${BASE}/insumos-peso/0`, { insumos: [] })).error, /peso/);
    assert.match((await a.pedir('PUT', `${BASE}/insumos-peso/500`, { insumos: [{ plu: 'x', cantidad: 1 }] })).error, /plu/);
    assert.deepStrictEqual((await a.pedir('PUT', `${BASE}/insumos-peso/500`, { insumos: [] })).insumosPorPeso, {});
    assert.deepStrictEqual((await a.pedir('GET', BASE)).insumosPorPeso, {});
  } finally { a.cerrar(); }
});

test('PUT /api/precios/fraccionado/presentaciones ya no existe', () => {
  const r = crearRutas({ apiRoute: fn => fn, query: async () => [], leerJSON: (_p, d) => d, guardarJSON: () => {}, DATA_DIR: os.tmpdir() });
  assert.ok(!r.stack.some(l => l.route && l.route.path === '/api/precios/fraccionado/presentaciones'));
});

test('GET costeo: config + productos por subrubro (graneles con sus presentaciones) y los sin subrubro', async () => {
  const query = async sql => {
    if (sql.includes('SubRubros')) {
      return [{ IdProducto: '100', NombreProducto: 'Almendra granel', IdSubRubro: 7, NombreSubRubro: 'Frutos secos' },
        { IdProducto: '200', NombreProducto: 'Sal granel', IdSubRubro: null, NombreSubRubro: null }];
    }
    if (sql.includes('ProductosComponentes')) return [{ Plu: '101', Granel: '100', Cant: 0.5 }, { Plu: '102', Granel: '100', Cant: 0.25 }];
    if (sql.includes("'Pesables Fraccionado'")) return [{ IdProducto: '101', NombreProducto: 'Almendra 500G' }, { IdProducto: '102', NombreProducto: 'Almendra 250G' }];
    // costos: el insumo 900 tiene fila en SIGA (sistema 20), el 901 no
    const ids = (sql.match(/p\.IdProducto IN \(([^)]*)\)/) || [])[1];
    if (ids) return ids.includes("'900'") ? [{ IdProducto: '900', NombreProducto: 'Bolsa 500g', CostoSistema: 20, IvaCompraPct: 21 }] : [];
    return [];
  };
  // el costo del insumo es el de su tab: costo manual > sistema
  const a = appCon({ costoPorProducto: { 900: 25 }, fraccionado: { ...FRACC, insumosPorPeso: { 500: [{ plu: '900', cantidad: 2 }, { plu: '901', cantidad: 1 }], 750: [{ plu: '900', cantidad: 1 }] } } }, { query });
  try {
    const j = await a.pedir('GET', `${BASE}/costeo`);
    assert.deepStrictEqual([j.migrado, j.subrubrosSiga, j.sinSubrubro], [true,
      [{ id: '7', nombre: 'Frutos secos', graneles: [{ plu: '100', nombre: 'Almendra granel',
        presentaciones: [{ plu: '101', nombre: 'Almendra 500G', pesoG: 500 }, { plu: '102', nombre: 'Almendra 250G', pesoG: 250 }] }] }],
      [{ plu: '200', nombre: 'Sal granel', presentaciones: [] }]]);
    assert.deepStrictEqual(j.pesos, [{ pesoG: 250, presentaciones: 1 }, { pesoG: 500, presentaciones: 1 }]);
    assert.deepStrictEqual(j.insumosPorPeso, {
      500: [{ plu: '900', cantidad: 2, nombre: 'Bolsa 500g', costo: 25 }, { plu: '901', cantidad: 1, nombre: null, costo: null }],
      750: [{ plu: '900', cantidad: 1, nombre: 'Bolsa 500g', costo: 25 }] });
  } finally { a.cerrar(); }
});

test('sin permiso precios-config: 403 en la configuración', async () => {
  const a = appCon({ fraccionado: FRACC }, { guard: true, sinConfig: true });
  try {
    for (const [m, r] of [['GET', BASE], ['GET', `${BASE}/costeo`], ['PUT', `${BASE}/maquinas`], ['PUT', `${BASE}/escalas`],
      ['PUT', `${BASE}/subrubros/7`], ['PUT', `${BASE}/granel/1`], ['PUT', `${BASE}/insumos-peso/500`]]) {
      assert.strictEqual((await a.pedir(m, r, m === 'PUT' ? {} : undefined)).status, 403, `${m} ${r}`);
    }
  } finally { a.cerrar(); }
});
