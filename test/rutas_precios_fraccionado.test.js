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
    assert.deepStrictEqual([j.migrado, j.maquinas, j.tramosTiempo, j.subrubros, j.porGranel, j.insumosPorPeso, 'escalas' in j], [false, [], [], {}, {}, {}, false]);
    assert.match((await a.pedir('PUT', `${BASE}/tramos-tiempo`, { tramos: [] })).error, /migrar_config_fraccionado/);
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

test('máquinas: alta y como máquina de un granel; no se borra en uso por un granel; el resto de costeo.fraccionado queda', async () => {
  const a = appCon({ fraccionado: FRACC });
  try {
    const j = await a.pedir('PUT', `${BASE}/maquinas`, { maquinas: [{ nombre: 'Envasadora Grande', costoHora: 3000 }] });
    assert.deepStrictEqual(j.maquinas, [{ id: 'envasadora-grande', nombre: 'Envasadora Grande', costoHora: 3000, usos: { graneles: 0 } }]);
    const g = await a.pedir('PUT', `${BASE}/granel/100`, { maquinaId: 'envasadora-grande' });
    assert.deepStrictEqual([g.porGranel, g.maquinas[0].usos], [{ 100: { maquinaId: 'envasadora-grande' } }, { graneles: 1 }]);
    assert.match((await a.pedir('PUT', `${BASE}/maquinas`, { maquinas: [] })).error, /Envasadora Grande la usan 1 granel/);
    assert.match((await a.pedir('PUT', `${BASE}/granel/100`, { maquinaId: 'otra' })).error, /maquinaId: otra no está/);
    assert.deepStrictEqual((await a.pedir('PUT', `${BASE}/granel/100`, { maquinaId: null })).porGranel, {});
    assert.strictEqual(a.leer().fraccionado.costoHora, 6000);
  } finally { a.cerrar(); }
});

test('granel/:plu: min/kg propio (0 vale) y máquina; ausente no toca, null saca; inválido no escribe', async () => {
  const a = appCon({ fraccionado: { ...FRACC, maquinas: [{ id: 'env', nombre: 'Envasadora', costoHora: 3000 }] } });
  try {
    assert.deepStrictEqual((await a.pedir('PUT', `${BASE}/granel/100`, { minKg: 0 })).porGranel, { 100: { minKg: 0 } });
    assert.deepStrictEqual((await a.pedir('PUT', `${BASE}/granel/100`, { maquinaId: 'env' })).porGranel, { 100: { minKg: 0, maquinaId: 'env' } });
    assert.match((await a.pedir('PUT', `${BASE}/granel/100`, { minKg: 601 })).error, /minKg: número de 0 a 600/);
    assert.match((await a.pedir('PUT', `${BASE}/granel/x`, {})).error, /PLU/);
    assert.deepStrictEqual(a.leer().fraccionado.porGranel, { 100: { minKg: 0, maquinaId: 'env' } });
    assert.deepStrictEqual((await a.pedir('PUT', `${BASE}/granel/100`, { minKg: null, maquinaId: null })).porGranel, {});
  } finally { a.cerrar(); }
});

test('tramos-tiempo: se guardan validados; hastaG no ascendente o base distinta de 0 → error sin escribir', async () => {
  const a = appCon({ fraccionado: FRACC });
  try {
    const tramos = [{ hastaG: 250, minKg: 3 }, { hastaG: 1000, minKg: 0 }, { hastaG: 5000, minKg: -1 }];
    assert.deepStrictEqual((await a.pedir('PUT', `${BASE}/tramos-tiempo`, { tramos })).tramosTiempo, tramos);
    assert.match((await a.pedir('PUT', `${BASE}/tramos-tiempo`, { tramos: [{ hastaG: 500, minKg: 1 }, { hastaG: 250, minKg: 0 }] })).error, /hastaG/);
    assert.match((await a.pedir('PUT', `${BASE}/tramos-tiempo`, { tramos: [{ hastaG: 1000, minKg: 2 }] })).error, /base/);
    assert.deepStrictEqual(a.leer().fraccionado.tramosTiempo, tramos);
  } finally { a.cerrar(); }
});

test('subrubros: en lote (número o null); campos viejos se ignoran y el primer PUT los borra; inválido no escribe', async () => {
  const viejo = { ...FRACC, escalas: { facilidad: { facil: 1, normal: 1.25, dificil: 1.5 } },
    subrubros: { 7: { facilidad: 'facil', tiempo: 'normal' }, 8: { maquinaId: null, tramos: [], facilidad: 'normal' } } };
  const a = appCon({ fraccionado: viejo });
  try {
    assert.deepStrictEqual((await a.pedir('GET', BASE)).subrubros, {});
    const s = await a.pedir('PUT', `${BASE}/subrubros`, { subrubros: { 7: 2, 9: 1.5 } });
    assert.deepStrictEqual(s.subrubros, { 7: { minKg: 2 }, 9: { minKg: 1.5 } });
    const f = a.leer().fraccionado;
    assert.deepStrictEqual([f.subrubros, 'escalas' in f, f.tramosTiempo], [{ 7: { minKg: 2 }, 9: { minKg: 1.5 } }, false, []]);
    assert.match((await a.pedir('PUT', `${BASE}/subrubros`, { subrubros: { 7: -1 } })).error, /subrubros\.7: número de 0 a 600/);
    assert.deepStrictEqual((await a.pedir('PUT', `${BASE}/subrubros`, { subrubros: { 7: null } })).subrubros, { 9: { minKg: 1.5 } });
  } finally { a.cerrar(); }
});

test('PUT escalas y PUT subrubros/:id ya no existen', () => {
  const r = crearRutas({ apiRoute: fn => fn, query: async () => [], leerJSON: (_p, d) => d, guardarJSON: () => {}, DATA_DIR: os.tmpdir() });
  const paths = r.stack.filter(l => l.route).map(l => l.route.path);
  assert.ok(!paths.includes(`${BASE}/escalas`) && !paths.includes(`${BASE}/subrubros/:id`));
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
    assert.deepStrictEqual(['escalas' in f, 'facilidades' in f, 'presentaciones' in f, 'insumosPresentacion' in f], [false, false, false, false]);
    assert.match((await a.pedir('PUT', `${BASE}/insumos-peso/0`, { insumos: [] })).error, /peso/);
    assert.match((await a.pedir('PUT', `${BASE}/insumos-peso/500`, { insumos: [{ plu: 'x', cantidad: 1 }] })).error, /plu/);
    assert.deepStrictEqual((await a.pedir('PUT', `${BASE}/insumos-peso/500`, { insumos: [] })).insumosPorPeso, {});
    assert.deepStrictEqual((await a.pedir('GET', BASE)).insumosPorPeso, {});
  } finally { a.cerrar(); }
});

test('ajustes-peso: guarda en costeo.fraccionado.margenes.ajustesPeso (las tablas quedan) y responde la vista; null o sin tramos lo saca; inválido no escribe', async () => {
  const T = { minPct: 80, maxPct: 120, escalones: 5, rango: { desde: 50, hasta: 50000 } };
  const margenes = { minorista: T, pack: T, bulto: T };
  const a = appCon({ margenes: { minorista: T }, fraccionado: { ...FRACC, margenes } });
  const aj = { tramosG: [100, 1000], puntos: [8, 0] };
  try {
    assert.strictEqual((await a.pedir('GET', BASE)).ajustesPeso, null);
    const r = await a.pedir('PUT', `${BASE}/ajustes-peso`, { ajustesPeso: aj });
    assert.deepStrictEqual([r.status, r.migrado, r.ajustesPeso, r.maquinas], [200, true, aj, []]);
    assert.deepStrictEqual(a.leer().fraccionado.margenes, { ...margenes, ajustesPeso: aj });
    assert.deepStrictEqual(a.leer().margenes, { minorista: T }); // la raíz (Reventa) no se toca
    assert.deepStrictEqual((await a.pedir('GET', BASE)).ajustesPeso, aj);
    assert.match((await a.pedir('PUT', `${BASE}/ajustes-peso`, { ajustesPeso: { tramosG: [100], puntos: [200] } })).error, /puntos/);
    assert.match((await a.pedir('PUT', `${BASE}/ajustes-peso`, {})).error, /ajustesPeso: falta/);
    assert.deepStrictEqual(a.leer().fraccionado.margenes.ajustesPeso, aj);
    assert.strictEqual((await a.pedir('PUT', `${BASE}/ajustes-peso`, { ajustesPeso: { tramosG: [], puntos: [] } })).ajustesPeso, null);
    await a.pedir('PUT', `${BASE}/ajustes-peso`, { ajustesPeso: aj });
    assert.strictEqual((await a.pedir('PUT', `${BASE}/ajustes-peso`, { ajustesPeso: null })).ajustesPeso, null);
    assert.deepStrictEqual(a.leer().fraccionado.margenes, margenes);
  } finally { a.cerrar(); }
  const sin = appCon({ margenes: { minorista: T, ajustesPeso: aj } });
  try {
    assert.match((await sin.pedir('PUT', `${BASE}/ajustes-peso`, { ajustesPeso: null })).error, /migrar_config_fraccionado/);
    assert.deepStrictEqual(sin.leer().margenes.ajustesPeso, aj);
  } finally { sin.cerrar(); }
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
    for (const [m, r] of [['GET', BASE], ['GET', `${BASE}/costeo`], ['PUT', `${BASE}/maquinas`], ['PUT', `${BASE}/tramos-tiempo`],
      ['PUT', `${BASE}/subrubros`], ['PUT', `${BASE}/granel/1`], ['PUT', `${BASE}/insumos-peso/500`], ['PUT', `${BASE}/ajustes-peso`]]) {
      assert.strictEqual((await a.pedir(m, r, m === 'PUT' ? {} : undefined)).status, 403, `${m} ${r}`);
    }
  } finally { a.cerrar(); }
});
