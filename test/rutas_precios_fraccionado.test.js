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
const FRACC = { costoHora: 6000, maquinas: [], tiempos: [], porGranel: {} };

test('sin migrar: GET da migrado false con defaults y los PUT no escriben', async () => {
  const a = appCon({ ivaVentaPct: 21 });
  try {
    const j = await a.pedir('GET', BASE);
    assert.deepStrictEqual([j.migrado, j.maquinas, j.facilidades], [false, [], { facil: 1, medio: 1.25, dificil: 1.5 }]);
    assert.match((await a.pedir('PUT', `${BASE}/tiempos`, { tiempos: [], facilidades: { facil: 1, medio: 1, dificil: 1 } })).error, /migrar_config_fraccionado/);
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

test('máquinas: alta con id del nombre, asignarla a un granel, no se borra en uso; el resto de costeo.fraccionado queda', async () => {
  const a = appCon({ fraccionado: FRACC });
  try {
    const j = await a.pedir('PUT', `${BASE}/maquinas`, { maquinas: [{ nombre: 'Envasadora Grande', costoHora: 3000 }] });
    assert.deepStrictEqual(j.maquinas, [{ id: 'envasadora-grande', nombre: 'Envasadora Grande', costoHora: 3000, usos: 0 }]);
    const g = await a.pedir('PUT', `${BASE}/granel/100`, { facilidad: 'medio', maquinaId: 'envasadora-grande' });
    assert.deepStrictEqual([g.porGranel, g.maquinas[0].usos], [{ 100: { facilidad: 'medio', maquinaId: 'envasadora-grande' } }, 1]);
    assert.match((await a.pedir('PUT', `${BASE}/maquinas`, { maquinas: [] })).error, /Envasadora Grande la usan 1 granel/);
    assert.match((await a.pedir('PUT', `${BASE}/granel/100`, { facilidad: 'medio', maquinaId: 'otra' })).error, /maquinaId/);
    assert.deepStrictEqual((await a.pedir('PUT', `${BASE}/granel/100`, { facilidad: null, maquinaId: null })).porGranel, {});
    assert.strictEqual(a.leer().fraccionado.costoHora, 6000);
  } finally { a.cerrar(); }
});

test('tiempos, insumos por subrubro e insumos propios se guardan validados', async () => {
  const a = appCon({ fraccionado: FRACC });
  try {
    await a.pedir('PUT', `${BASE}/tiempos`, { tiempos: [{ hastaG: 500, minutos: 0.5 }], facilidades: { facil: 1, medio: 1.2, dificil: 2 } });
    await a.pedir('PUT', `${BASE}/insumos-subrubro`, { insumosSubrubro: { 7: [{ hastaG: 500, insumos: [{ plu: '900', cantidad: 1 }] }] } });
    await a.pedir('PUT', `${BASE}/insumos-presentacion/101`, { insumos: [{ plu: '902', cantidad: 3 }] });
    assert.match((await a.pedir('PUT', `${BASE}/tiempos`, { tiempos: [{ hastaG: 0, minutos: 1 }], facilidades: { facil: 1, medio: 1, dificil: 1 } })).error, /hastaG/);
    const f = a.leer().fraccionado;
    assert.deepStrictEqual([f.tiempos, f.facilidades.dificil, f.insumosSubrubro[7][0].insumos, f.insumosPresentacion[101]],
      [[{ hastaG: 500, minutos: 0.5 }], 2, [{ plu: '900', cantidad: 1 }], [{ plu: '902', cantidad: 3 }]]);
    await a.pedir('PUT', `${BASE}/insumos-presentacion/101`, { insumos: [] });
    assert.deepStrictEqual(a.leer().fraccionado.insumosPresentacion, {});
  } finally { a.cerrar(); }
});

test('GET costeo: subrubros de los graneles y nombre + costo en su tab de cada insumo usado', async () => {
  const query = async sql => {
    if (sql.includes('SubRubros')) return [{ IdProducto: '100', NombreProducto: 'Almendra', IdSubRubro: 7, NombreSubRubro: 'Frutos secos' }];
    if (sql.includes('UcPrecioNeto')) return [{ IdProducto: '900', NombreProducto: 'Bolsa 500g', CostoSistema: 20, IvaCompraPct: 21 }];
    return [];
  };
  const a = appCon({ fraccionado: { ...FRACC, insumosSubrubro: { 7: [{ hastaG: 500, insumos: [{ plu: '900', cantidad: 1 }] }] } } }, { query });
  try {
    const j = await a.pedir('GET', `${BASE}/costeo`);
    assert.deepStrictEqual([j.migrado, j.subrubros, j.insumos], [true, [{ id: '7', nombre: 'Frutos secos', graneles: 1 }], { 900: { nombre: 'Bolsa 500g', costo: 20 } }]);
  } finally { a.cerrar(); }
});

test('sin permiso precios-config: 403 en GET y PUT', async () => {
  const a = appCon({ fraccionado: FRACC }, { guard: true, sinConfig: true });
  try {
    for (const [m, r] of [['GET', BASE], ['GET', `${BASE}/costeo`], ['PUT', `${BASE}/maquinas`], ['PUT', `${BASE}/granel/1`]]) {
      assert.strictEqual((await a.pedir(m, r, m === 'PUT' ? {} : undefined)).status, 403, `${m} ${r}`);
    }
  } finally { a.cerrar(); }
});
