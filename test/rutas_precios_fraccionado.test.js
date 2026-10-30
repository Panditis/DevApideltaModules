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

function appCon(costeo, { query = async () => [], guard = false, sinConfig = false, archivos = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fracc-rutas-'));
  const archivo = path.join(dir, 'costeo.json');
  if (costeo) fs.writeFileSync(archivo, JSON.stringify(costeo));
  for (const [nombre, contenido] of Object.entries(archivos)) fs.writeFileSync(path.join(dir, nombre), JSON.stringify(contenido));
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
    const txt = await res.text();
    try { return { status: res.status, ...JSON.parse(txt) }; } catch { return { status: res.status, html: txt }; }
  };
  return { pedir, dir, leer: () => JSON.parse(fs.readFileSync(archivo, 'utf8')), cerrar: () => server && server.close() };
}

const BASE = '/api/precios/config/esquema/fraccionado';
const FRACC = { costoHora: 6000, maquinas: [] };

test('sin migrar: GET da migrado false con defaults y los PUT no escriben', async () => {
  const a = appCon({ ivaVentaPct: 21 });
  try {
    const j = await a.pedir('GET', BASE);
    assert.deepStrictEqual([j.migrado, j.maquinas, j.tramosTiempo, j.subrubros, j.porGranel, j.envasePorPeso, j.costoBobinaKg, 'insumosPorPeso' in j, 'escalas' in j], [false, [], [], {}, {}, {}, null, false, false]);
    assert.match((await a.pedir('PUT', `${BASE}/tramos-tiempo`, { tramos: [] })).error, /migrar_config_fraccionado/);
    assert.match((await a.pedir('PUT', `${BASE}/envase`, { pesos: { 500: { bolsaPlu: '900' } }, costoBobinaKg: 6000 })).error, /migrar_config_fraccionado/);
    assert.match((await a.pedir('PUT', `${BASE}/subrubros`, { graneles: { 100: 2 } })).error, /migrar_config_fraccionado/);
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

test('PUT envase: pesos y costo de bobina atómicos; responde la vista cruda; inválido no escribe nada; los dos null borran; insumosPorPeso viejo se borra', async () => {
  const viejo = { ...FRACC, facilidades: { facil: 1 }, insumosPresentacion: { 102: [{ plu: '900', cantidad: 1 }] }, insumosPorPeso: { 500: [{ plu: '900', cantidad: 1 }] } };
  const a = appCon({ fraccionado: viejo });
  try {
    const r = await a.pedir('PUT', `${BASE}/envase`, { costoBobinaKg: 6000, pesos: { 500: { bolsaPlu: ' 900 ', bobinaG: 8 }, 250: { bolsaPlu: 901 } } });
    assert.deepStrictEqual([r.status, r.migrado, r.envasePorPeso, r.costoBobinaKg, 'insumosPorPeso' in r],
      [200, true, { 500: { bolsaPlu: '900', bobinaG: 8 }, 250: { bolsaPlu: '901' } }, 6000, false]);
    const f = a.leer().fraccionado;
    assert.deepStrictEqual([f.envasePorPeso[500], f.costoBobinaKg], [{ bolsaPlu: '900', bobinaG: 8 }, 6000]);
    assert.deepStrictEqual(['insumosPorPeso' in f, 'facilidades' in f, 'insumosPresentacion' in f], [false, false, false]);
    for (const [body, re] of [[{ pesos: { 0: {} } }, /peso/], [{ pesos: { 201: { bolsaPlu: '1' }, 500: { bolsaPlu: 'abc' } } }, /peso 500: bolsaPlu/],
      [{ pesos: { 500: { bobinaG: 0 } } }, /peso 500: bobinaG/], [{ pesos: { 500: { bobinaG: 1001 } } }, /bobinaG/],
      [{ costoBobinaKg: 0 }, /costoBobinaKg/], [{ costoBobinaKg: 1, pesos: { 500: { bobinaG: 'x' } } }, /bobinaG/], [{ pesos: [] }, /pesos/]]) {
      const x = await a.pedir('PUT', `${BASE}/envase`, body);
      assert.match(x.error || '', re, JSON.stringify(body));
    }
    assert.deepStrictEqual([a.leer().fraccionado.envasePorPeso, a.leer().fraccionado.costoBobinaKg], [r.envasePorPeso, 6000]); // no escribió
    assert.strictEqual((await a.pedir('PUT', `${BASE}/envase`, {})).status, 200); // sin cambios: no es error
    assert.deepStrictEqual((await a.pedir('PUT', `${BASE}/envase`, { pesos: { 500: { bolsaPlu: null, bobinaG: '' } } })).envasePorPeso, { 250: { bolsaPlu: '901' } });
    const c = await a.pedir('PUT', `${BASE}/envase`, { costoBobinaKg: '' });
    assert.deepStrictEqual([c.costoBobinaKg, c.envasePorPeso], [null, { 250: { bolsaPlu: '901' } }]);
  } finally { a.cerrar(); }
});

test('PUT subrubros con graneles: guarda minKg propio sin tocar máquina/envase; atómico; tope 1000; body vacío da error', async () => {
  const a = appCon({ fraccionado: { ...FRACC, maquinas: [{ id: 'env', nombre: 'E', costoHora: 1 }], porGranel: { 100: { maquinaId: 'env', minKg: 1 }, 200: { envase: 'bobina' } } } });
  try {
    const r = await a.pedir('PUT', `${BASE}/subrubros`, { subrubros: { 7: 3 }, graneles: { 100: null, 200: 0, 300: 4.5 } });
    const esperado = { 100: { maquinaId: 'env' }, 200: { envase: 'bobina', minKg: 0 }, 300: { minKg: 4.5 } };
    assert.deepStrictEqual([r.status, r.subrubros, r.porGranel], [200, { 7: { minKg: 3 } }, esperado]);
    assert.match((await a.pedir('PUT', `${BASE}/subrubros`, { subrubros: { 7: 9 }, graneles: { 300: 601 } })).error, /graneles\.300: minKg: número de 0 a 600/);
    assert.match((await a.pedir('PUT', `${BASE}/subrubros`, { graneles: { abc: 1 } })).error, /graneles\.abc: PLU inválido/);
    const mil = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [String(i + 1), 1]));
    assert.match((await a.pedir('PUT', `${BASE}/subrubros`, { graneles: mil })).error, /graneles: máximo 1000/);
    assert.match((await a.pedir('PUT', `${BASE}/subrubros`, {})).error, /mandá al menos un cambio/);
    assert.deepStrictEqual([a.leer().fraccionado.subrubros, a.leer().fraccionado.porGranel], [{ 7: { minKg: 3 } }, esperado]); // no escribió
  } finally { a.cerrar(); }
});

test('PUT envase-peso/:pesoG y PUT costo-bobina ya no existen (404)', async () => {
  const a = appCon({ fraccionado: FRACC });
  try {
    assert.strictEqual((await a.pedir('PUT', `${BASE}/envase-peso/500`, { bolsaPlu: '900' })).status, 404);
    assert.strictEqual((await a.pedir('PUT', `${BASE}/costo-bobina`, { costoBobinaKg: 1 })).status, 404);
    assert.deepStrictEqual(a.leer().fraccionado, FRACC);
  } finally { a.cerrar(); }
});

test('granel/:plu con envase: bobina se guarda y la vista la devuelve; bolsa la borra; otro valor no escribe', async () => {
  const a = appCon({ fraccionado: FRACC });
  try {
    assert.deepStrictEqual((await a.pedir('PUT', `${BASE}/granel/100`, { minKg: 2, envase: 'bobina' })).porGranel, { 100: { minKg: 2, envase: 'bobina' } });
    assert.match((await a.pedir('PUT', `${BASE}/granel/100`, { envase: 'otra' })).error, /envase/);
    assert.deepStrictEqual(a.leer().fraccionado.porGranel, { 100: { minKg: 2, envase: 'bobina' } });
    assert.deepStrictEqual((await a.pedir('PUT', `${BASE}/granel/100`, { minKg: 3 })).porGranel, { 100: { minKg: 3, envase: 'bobina' } }); // "Fijar" no toca el envase
    assert.deepStrictEqual((await a.pedir('PUT', `${BASE}/granel/100`, { envase: 'bolsa' })).porGranel, { 100: { minKg: 3 } });
  } finally { a.cerrar(); }
});

test('PUT insumos-peso ya no existe (404)', async () => {
  const a = appCon({ fraccionado: FRACC });
  try {
    const r = crearRutas({ apiRoute: fn => fn, query: async () => [], leerJSON: (_p, d) => d, guardarJSON: () => {}, DATA_DIR: os.tmpdir() });
    assert.ok(!r.stack.some(l => l.route && l.route.path === `${BASE}/insumos-peso/:pesoG`));
    const res = await a.pedir('GET', BASE); // levanta el server
    assert.ok(res.migrado);
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

test('GET costeo: config + productos por subrubro (graneles con sus presentaciones) y los sin subrubro; envase con nombre y costo de la bolsa; SIGA sólo recibe los PLU de bolsa', async () => {
  const sqls = [];
  const query = async sql => {
    if (sql.includes('SubRubros')) {
      return [{ IdProducto: '100', NombreProducto: 'Almendra granel', IdSubRubro: 7, NombreSubRubro: 'Frutos secos' },
        { IdProducto: '200', NombreProducto: 'Sal granel', IdSubRubro: null, NombreSubRubro: null }];
    }
    if (sql.includes('ProductosComponentes')) return [{ Plu: '101', Granel: '100', Cant: 0.5 }, { Plu: '102', Granel: '100', Cant: 0.25 }];
    if (sql.includes("'Pesables Fraccionado'")) return [{ IdProducto: '101', NombreProducto: 'Almendra 500G' }, { IdProducto: '102', NombreProducto: 'Almendra 250G' }];
    sqls.push(sql);
    // costos: el insumo 900 tiene fila en SIGA (sistema 20), el 901 no
    const ids = (sql.match(/p\.IdProducto IN \(([^)]*)\)/) || [])[1];
    if (ids) return ids.includes("'900'") ? [{ IdProducto: '900', NombreProducto: 'Bolsa 500g', CostoSistema: 20, IvaCompraPct: 21 }] : [];
    return [];
  };
  // el costo del insumo es el de su tab: costo manual > sistema
  const a = appCon({ costoPorProducto: { 900: 25 }, fraccionado: { ...FRACC, envasePorPeso: { 500: { bolsaPlu: '900', bobinaG: 8 }, 750: { bolsaPlu: '901' }, 1000: { bobinaG: 10 } }, costoBobinaKg: 6000 } }, { query });
  try {
    const j = await a.pedir('GET', `${BASE}/costeo`);
    assert.deepStrictEqual([j.migrado, j.subrubrosSiga, j.sinSubrubro], [true,
      [{ id: '7', nombre: 'Frutos secos', graneles: [{ plu: '100', nombre: 'Almendra granel',
        presentaciones: [{ plu: '101', nombre: 'Almendra 500G', pesoG: 500 }, { plu: '102', nombre: 'Almendra 250G', pesoG: 250 }] }] }],
      [{ plu: '200', nombre: 'Sal granel', presentaciones: [] }]]);
    assert.deepStrictEqual(j.pesos, [{ pesoG: 250, presentaciones: 1 }, { pesoG: 500, presentaciones: 1 }]);
    assert.deepStrictEqual(j.envasePorPeso, {
      500: { bolsaPlu: '900', bobinaG: 8, bolsaNombre: 'Bolsa 500g', bolsaCosto: 25 }, 750: { bolsaPlu: '901', bolsaNombre: null, bolsaCosto: null },
      1000: { bobinaG: 10, bolsaNombre: null, bolsaCosto: null } });
    assert.strictEqual(j.costoBobinaKg, 6000);
    const pedidos = sqls.map(q => (q.match(/p.IdProducto IN (([^)]*))/) || [])[1]).filter(Boolean).join(',').match(/'[^']*'/g) || [];
    assert.deepStrictEqual([...new Set(pedidos)].sort(), ["'100'", "'200'", "'900'", "'901'"]); // graneles + bolsas, nada de bobina
  } finally { a.cerrar(); }
});

test('sin permiso precios-config: 403 en la configuración', async () => {
  const a = appCon({ fraccionado: FRACC }, { guard: true, sinConfig: true });
  try {
    for (const [m, r] of [['GET', BASE], ['GET', `${BASE}/costeo`], ['PUT', `${BASE}/maquinas`], ['PUT', `${BASE}/tramos-tiempo`],
      ['PUT', `${BASE}/subrubros`], ['PUT', `${BASE}/granel/1`], ['PUT', `${BASE}/envase`], ['PUT', `${BASE}/ajustes-peso`], ['GET', `${BASE}/historial`]]) {
      assert.strictEqual((await a.pedir(m, r, m === 'PUT' ? {} : undefined)).status, 403, `${m} ${r}`);
    }
  } finally { a.cerrar(); }
});

// ── GET historial (E2) ──
const cargaHist = (i, x = {}) => ({ id: `h${i}`, fecha: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}`, plu: '500', nombre: 'Almendra 1Kg',
  granel: '100', granelConsumido: 2, empleado: `P${i % 40}`, desde: '08:00', hasta: '08:40', ...x });
const filaGranel = { IdProducto: 100, NombreProducto: 'Almendra granel', IdSubRubro: 7, NombreSubRubro: 'Frutos secos' };

test('GET historial: estadística con la tabla guardada, sin escribir nada', async () => {
  const cargas = Array.from({ length: 6 }, (_, i) => cargaHist(i));
  const costeo = { fraccionado: { ...FRACC, tramosTiempo: [{ hastaG: 1000, minKg: 0 }] } };
  const a = appCon(costeo, { query: async () => [filaGranel], archivos: { 'historial_distribucion.json': [{ fecha: '2026-09-01', produccion: [...cargas, cargas[0]] }, null] } });
  try {
    const antes = fs.readdirSync(a.dir).map(n => [n, fs.statSync(path.join(a.dir, n)).mtimeMs]);
    const j = await a.pedir('GET', `${BASE}/historial`);
    assert.strictEqual(j.status, 200);
    assert.deepStrictEqual(j.cargas, { total: 6, usadas: 6, descartes: { act: 0, duracion: 0, sinKilos: 0, sinGranel: 0, sinPeso: 0 } });
    assert.deepStrictEqual(j.productos['100'], { n: 6, mediana: 20, p25: 20, p75: 20, subrubroId: '7', pocosDatos: false });
    assert.deepStrictEqual(j.subrubros['7'], { n: 6, productos: 1, mediana: 20, p25: 20, p75: 20, pocosDatos: false });
    assert.deepStrictEqual(j.tramos, [{ hastaG: 1000, base: true, n: 1, mediana: 0, p25: 0, p75: 0, pocosDatos: false }]);
    assert.deepStrictEqual(j.distribucion, { 7: [{ plu: '100', nombre: 'Almendra granel', n: 6, minKg: 20 }] });
    assert.deepStrictEqual(fs.readdirSync(a.dir).map(n => [n, fs.statSync(path.join(a.dir, n)).mtimeMs]), antes);
  } finally { a.cerrar(); }
});

test('GET historial: sin archivo → ceros; SIGA caído → 500 con mensaje claro', async () => {
  const a = appCon({ fraccionado: FRACC });
  try {
    const j = await a.pedir('GET', `${BASE}/historial`);
    assert.deepStrictEqual([j.cargas.total, j.productos, j.tramos], [0, {}, []]);
  } finally { a.cerrar(); }
  const b = appCon({ fraccionado: FRACC }, { query: async () => { throw new Error('ECONNRESET'); }, archivos: { 'historial_distribucion.json': [] } });
  const errorOriginal = console.error;
  console.error = () => {};
  try {
    const j = await b.pedir('GET', `${BASE}/historial`);
    assert.deepStrictEqual([j.status, j.error], [500, 'No se pudieron leer los graneles de SIGA']);
  } finally { console.error = errorOriginal; b.cerrar(); }
  const c = appCon({ fraccionado: FRACC }, { archivos: { 'historial_distribucion.json': { no: 'lista' } } });
  try { assert.strictEqual((await c.pedir('GET', `${BASE}/historial`)).status, 500); } finally { c.cerrar(); }
});

test('GET historial: 3.000 líneas sintéticas bajo 1 s', async () => {
  const cargas = Array.from({ length: 3000 }, (_, i) => cargaHist(i, { granel: String(100 + (i % 300)), nombre: ['X 50G', 'X 250G', 'X 1Kg'][i % 3],
    desde: `${String(7 + (i % 8)).padStart(2, '0')}:00`, hasta: `${String(7 + (i % 8)).padStart(2, '0')}:45` }));
  const filas = Array.from({ length: 300 }, (_, i) => ({ ...filaGranel, IdProducto: 100 + i, IdSubRubro: i % 12 }));
  const dias = Array.from({ length: 30 }, (_, d) => ({ fecha: 'x', produccion: cargas.slice(d * 100, d * 100 + 100) }));
  const a = appCon({ fraccionado: { ...FRACC, tramosTiempo: [{ hastaG: 100, minKg: 3 }, { hastaG: 500, minKg: 1 }, { hastaG: 1000, minKg: 0 }] } },
    { query: async () => filas, archivos: { 'historial_distribucion.json': dias } });
  try {
    await a.pedir('GET', BASE); // levanta el server fuera de la medición
    const t0 = Date.now();
    const j = await a.pedir('GET', `${BASE}/historial`);
    assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
    assert.strictEqual(j.cargas.total, 3000);
  } finally { a.cerrar(); }
});

// ── Estado en el listado (costeo.activoGranel) en el PUT subrubros: se movió del endpoint PUT /api/precios/fraccionado/activo/:plu ──
test('PUT subrubros con activos: true/false/null en la misma escritura; sólo activos no toca porGranel ni subrubros; la respuesta trae activoGranel', async () => {
  // Arrange
  const a = appCon({ ivaVentaPct: 21, activoGranel: { 7: true, 8: false }, fraccionado: { ...FRACC, subrubros: { 3: { minKg: 2 } }, porGranel: { 100: { minKg: 4 } } } });
  try {
    // Act
    const j = await a.pedir('PUT', `${BASE}/subrubros`, { activos: { 8: null, 100: false } });
    // Assert
    assert.deepStrictEqual(j.activoGranel, { 7: true, 100: false });
    const c = a.leer();
    assert.deepStrictEqual([c.activoGranel, c.fraccionado.porGranel, c.fraccionado.subrubros, c.ivaVentaPct], [{ 7: true, 100: false }, { 100: { minKg: 4 } }, { 3: { minKg: 2 } }, 21]);
    const mezcla = await a.pedir('PUT', `${BASE}/subrubros`, { subrubros: { 3: 5 }, graneles: { 100: null }, activos: { 7: null } });
    assert.deepStrictEqual([mezcla.subrubros, mezcla.porGranel, mezcla.activoGranel], [{ 3: { minKg: 5 } }, {}, { 100: false }]);
    assert.deepStrictEqual(a.leer().activoGranel, { 100: false });
  } finally { a.cerrar(); }
});

test('PUT subrubros sin activos conserva activoGranel; si costeo.json no lo tiene no se crea; los otros PUT también responden activoGranel', async () => {
  const a = appCon({ activoGranel: { 9: true }, fraccionado: FRACC });
  const b = appCon({ fraccionado: FRACC });
  try {
    assert.deepStrictEqual((await a.pedir('PUT', `${BASE}/subrubros`, { graneles: { 100: 3 } })).activoGranel, { 9: true });
    assert.deepStrictEqual(a.leer().activoGranel, { 9: true });
    assert.deepStrictEqual((await a.pedir('PUT', `${BASE}/granel/100`, { minKg: 1 })).activoGranel, { 9: true });
    assert.deepStrictEqual((await a.pedir('PUT', `${BASE}/tramos-tiempo`, { tramos: [] })).activoGranel, { 9: true });
    const sinClave = await b.pedir('PUT', `${BASE}/subrubros`, { subrubros: { 3: 1 } });
    assert.deepStrictEqual(sinClave.activoGranel, {});
    assert.strictEqual('activoGranel' in b.leer(), false);
  } finally { a.cerrar(); b.cerrar(); }
});

test('PUT subrubros: un error en cualquier mapa (subrubros, graneles o activos) no escribe nada; body vacío da el mensaje nuevo', async () => {
  const inicial = { activoGranel: { 9: true }, fraccionado: { ...FRACC, subrubros: { 3: { minKg: 2 } } } };
  const a = appCon(inicial);
  try {
    for (const [body, error] of [
      [{ subrubros: { 3: 5 }, activos: { 100: 'true' } }, /activos\.100: activo inválido/],
      [{ graneles: { 100: 1 }, activos: { '1x': true } }, /activos\.1x: PLU inválido/],
      [{ subrubros: { 3: 601 }, activos: { 100: true } }, /subrubros\.3/],
      [{ graneles: { 100: -1 }, activos: { 100: true } }, /graneles\.100/],
      [{ activos: [] }, /activos: debe ser un objeto/],
      [{}, /subrubros, graneles o activos: mandá al menos un cambio/]]) {
      assert.match((await a.pedir('PUT', `${BASE}/subrubros`, body)).error, error, JSON.stringify(body));
    }
    assert.deepStrictEqual(a.leer(), inicial);
  } finally { a.cerrar(); }
});

test('GET / y GET /costeo traen activoGranel (lo fijado a mano; {} sin ninguno)', async () => {
  const a = appCon({ activoGranel: { 100: false }, fraccionado: FRACC });
  const b = appCon({ fraccionado: FRACC });
  try {
    assert.deepStrictEqual([(await a.pedir('GET', BASE)).activoGranel, (await a.pedir('GET', `${BASE}/costeo`)).activoGranel], [{ 100: false }, { 100: false }]);
    assert.deepStrictEqual([(await b.pedir('GET', BASE)).activoGranel, (await b.pedir('GET', `${BASE}/costeo`)).activoGranel], [{}, {}]);
  } finally { a.cerrar(); b.cerrar(); }
});

test('sin precios-config: PUT subrubros con activos da 403 y no escribe', async () => {
  const a = appCon({ activoGranel: { 9: true }, fraccionado: FRACC }, { guard: true, sinConfig: true });
  try {
    assert.strictEqual((await a.pedir('PUT', `${BASE}/subrubros`, { activos: { 9: false } })).status, 403);
    assert.deepStrictEqual(a.leer().activoGranel, { 9: true });
  } finally { a.cerrar(); }
});
