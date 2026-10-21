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
const API_P = '/api/precios/fraccionado/presentaciones';
const FRACC = { costoHora: 6000, maquinas: [] };

test('sin migrar: GET da migrado false con defaults y los PUT (config y presentaciones) no escriben', async () => {
  const a = appCon({ ivaVentaPct: 21 });
  try {
    const j = await a.pedir('GET', BASE);
    assert.deepStrictEqual([j.migrado, j.maquinas, j.escalas.facilidad.normal, j.subrubros], [false, [], 1.25, {}]);
    assert.match((await a.pedir('PUT', `${BASE}/escalas`, { escalas: {} })).error, /migrar_config_fraccionado/);
    assert.match((await a.pedir('PUT', API_P, { cambios: [{ plu: '101', facilidad: 'facil' }] })).error, /migrar_config_fraccionado/);
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

test('presentaciones: lote sin permiso de Configuración (no es /config), responde sin la configuración; lo viejo pasa a la forma nueva', async () => {
  const viejo = { ...FRACC, maquinas: [{ id: 'env', nombre: 'Envasadora', costoHora: 3000 }], facilidades: { facil: 1, medio: 1.3, dificil: 2 },
    tiempos: [{ hastaG: 1, minutos: 1 }], insumosPresentacion: { 102: [{ plu: '900', cantidad: 1 }] } };
  const a = appCon({ fraccionado: viejo }, { guard: true, sinConfig: true });
  try {
    const r = await a.pedir('PUT', API_P, { cambios: [{ plu: '101', facilidad: 'normal', tiempo: 'lento' }, { plu: '102', tiempo: 'rapido' }] });
    assert.deepStrictEqual(r, { status: 200, ok: true });
    const f = a.leer().fraccionado;
    assert.deepStrictEqual(f.presentaciones, { 101: { facilidad: 'normal', tiempo: 'lento' }, 102: { insumos: [{ plu: '900', cantidad: 1 }], tiempo: 'rapido' } });
    assert.deepStrictEqual([f.escalas.facilidad.normal, 'facilidades' in f, 'tiempos' in f, 'insumosPresentacion' in f], [1.3, false, false, false]);
    assert.match((await a.pedir('PUT', API_P, { cambios: [{ plu: '101', facilidad: 'medio' }] })).error, /facilidad/);
  } finally { a.cerrar(); }
});

test('GET costeo: config + productos por subrubro (graneles con sus presentaciones) y los sin subrubro', async () => {
  const query = async sql => {
    if (sql.includes('SubRubros')) {
      return [{ IdProducto: '100', NombreProducto: 'Almendra granel', IdSubRubro: 7, NombreSubRubro: 'Frutos secos' },
        { IdProducto: '200', NombreProducto: 'Sal granel', IdSubRubro: null, NombreSubRubro: null }];
    }
    if (sql.includes('ProductosComponentes')) return [{ Plu: '101', Granel: '100', Cant: 0.5 }];
    if (sql.includes("'Pesables Fraccionado'")) return [{ IdProducto: '101', NombreProducto: 'Almendra 500G' }];
    return [];
  };
  const a = appCon({ fraccionado: FRACC }, { query });
  try {
    const j = await a.pedir('GET', `${BASE}/costeo`);
    assert.deepStrictEqual([j.migrado, j.subrubrosSiga, j.sinSubrubro], [true,
      [{ id: '7', nombre: 'Frutos secos', graneles: [{ plu: '100', nombre: 'Almendra granel', presentaciones: [{ plu: '101', nombre: 'Almendra 500G' }] }] }],
      [{ plu: '200', nombre: 'Sal granel', presentaciones: [] }]]);
  } finally { a.cerrar(); }
});

test('sin permiso precios-config: 403 en la configuración', async () => {
  const a = appCon({ fraccionado: FRACC }, { guard: true, sinConfig: true });
  try {
    for (const [m, r] of [['GET', BASE], ['GET', `${BASE}/costeo`], ['PUT', `${BASE}/maquinas`], ['PUT', `${BASE}/escalas`],
      ['PUT', `${BASE}/subrubros/7`], ['PUT', `${BASE}/granel/1`]]) {
      assert.strictEqual((await a.pedir(m, r, m === 'PUT' ? {} : undefined)).status, 403, `${m} ${r}`);
    }
  } finally { a.cerrar(); }
});
