'use strict';
// Router del esquema por canal por HTTP, con costeo.json en un directorio temporal y SIGA falso (query inyectada).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const crearRutas = require('../routes/rutas_precios_esquema');
const { migrarEsquemaCanales } = require('../lib/precios_config_esquema');

function appCon(costeo, { query = async () => [], sinConfig = false, archivos = {}, usuario = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esq-rutas-'));
  const archivo = path.join(dir, 'costeo.json');
  if (costeo) fs.writeFileSync(archivo, JSON.stringify(costeo));
  for (const [nombre, datos] of Object.entries(archivos)) fs.writeFileSync(path.join(dir, nombre), JSON.stringify(datos));
  const leerJSON = (p, def) => { try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : def; } catch { return def; } };
  const guardarJSON = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2));
  const apiRoute = fn => async (req, res) => { try { res.json(await fn(req)); } catch (err) { res.status(500).json({ error: err.message }); } };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.preciosSinConfig = sinConfig; if (usuario) req.session = { user: { usuario } }; next(); });
  app.use(crearRutas({ apiRoute, query, leerJSON, guardarJSON, DATA_DIR: dir, LISTA_PRECIOS_VENTA: 0, FORMULA_ACTIVA_SQL: '1=1', SIN_FORMULA_GENERICO_SQL: '1=1' }));
  let server;
  const pedir = async (metodo, ruta, body) => {
    if (!server) server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const res = await fetch(`http://127.0.0.1:${server.address().port}${ruta}`,
      { method: metodo, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return res.json();
  };
  return { pedir, leer: () => JSON.parse(fs.readFileSync(archivo, 'utf8')), cerrar: () => server && server.close() };
}

const MIGRADO = migrarEsquemaCanales({ toleranciaPct: 3, gastosVenta: [{ id: 'flete', concepto: 'Flete', pct: 1, listas: ['sucursal'] }] }).costeo;
const RED = { minorista: 100, packNeto: 0, packIva: 50, bultoNeto: 0, bultoIva: 50 };

test('config esquema: GET sin archivo → defaults y migrado false', async () => {
  const a = appCon(null);
  try {
    const j = await a.pedir('GET', '/api/precios/config/esquema');
    assert.deepStrictEqual([j.migrado, j.redondeo.minorista, j.modoGastos], [false, 50, 'costo']);
  } finally { a.cerrar(); }
});

test('config esquema: PUT precio valida antes de escribir', async () => {
  const a = appCon(MIGRADO);
  try {
    assert.match((await a.pedir('PUT', '/api/precios/config/esquema/precio', { ivaVentaPct: 500, toleranciaPct: 3, redondeo: RED })).error, /ivaVentaPct/);
    assert.strictEqual(a.leer().redondeo.minorista, 50);
    const j = await a.pedir('PUT', '/api/precios/config/esquema/precio', { ivaVentaPct: 21, toleranciaPct: 4, redondeo: RED });
    assert.strictEqual(j.redondeo.minorista, 100);
    const c = a.leer();
    assert.deepStrictEqual([c.ivaVentaPct, c.toleranciaPct, c.redondeo], [21, 4, RED]);
  } finally { a.cerrar(); }
});

test('config esquema: PUT márgenes guarda las 3 tablas por canal (+ ajuste por peso) y saca sinConfigurar; inválido no escribe', async () => {
  const a = appCon(MIGRADO);
  try {
    const T = { minPct: 20, maxPct: 40, escalones: 5, rango: { desde: 50, hasta: 5000 } };
    assert.match((await a.pedir('PUT', '/api/precios/config/esquema/margenes', { minorista: T, pack: T })).error, /bulto/);
    assert.strictEqual(a.leer().margenes.pack.sinConfigurar, true);
    const aj = { tramosG: [100], puntos: [5] };
    const j = await a.pedir('PUT', '/api/precios/config/esquema/margenes', { minorista: T, pack: { ...T, sinConfigurar: true }, bulto: T, ajustesPeso: aj });
    assert.deepStrictEqual(j.margenes, { minorista: T, pack: T, bulto: T, ajustesPeso: aj });
    assert.deepStrictEqual(a.leer().margenes, { minorista: T, pack: T, bulto: T, ajustesPeso: aj });
  } finally { a.cerrar(); }
});

test('config esquema: PUT costos guarda modo, gastos (sin listas) y extras', async () => {
  const a = appCon(MIGRADO);
  try {
    const tipos = { almacen: true, fraccionado: false, produccion: true };
    const j = await a.pedir('PUT', '/api/precios/config/esquema/costos', { modoGastos: 'precio',
      gastosVenta: [{ id: 'flete', concepto: 'Flete', pct: 2, tipos }], extrasMinorista: [] });
    assert.strictEqual(j.modoGastos, 'precio');
    assert.deepStrictEqual(a.leer().gastosVenta, [{ id: 'flete', concepto: 'Flete', pct: 2, tipos }]);
    assert.deepStrictEqual(a.leer().extrasMinorista, []);
  } finally { a.cerrar(); }
});

test('config esquema: Recalcular rango = percentiles de los costos de sistema; sin costos → error; no guarda', async () => {
  const filas = [121, 1210, 12100].map((c, i) => ({ IdProducto: String(i + 1), NombreProducto: `P${i}`, CostoSistema: c, IvaCompraPct: 21 }));
  const a = appCon(MIGRADO, { query: async sql => (sql.includes('UcPrecioNeto') ? filas : []) });
  try {
    assert.deepStrictEqual(await a.pedir('POST', '/api/precios/config/esquema/rango'), { rango: { desde: 100, hasta: 10000 }, n: 3 });
    assert.deepStrictEqual(a.leer().margenes, MIGRADO.margenes);
  } finally { a.cerrar(); }
  const b = appCon(MIGRADO);
  try { assert.match((await b.pedir('POST', '/api/precios/config/esquema/rango')).error, /suficientes costos/); } finally { b.cerrar(); }
});

// ── Fase 3: decisión, listado, detalle, export ───────────────────────────────

// SIGA falso con un producto en cada listado: Reventa (1 Arroz), Fraccionado (granel 50 con su presentación 51) y
// Producción (presentación 6319 de una receta con la materia prima 300).
const COSTOS_FALSOS = { 1: ['Arroz', 1210], 50: ['Almendra granel', 12100], 300: ['Harina', 400] };
const sigaFalso = async (sql) => {
  if (sql.includes("NombreRubro = 'Almacen'")) return [{ IdProducto: '1', NombreProducto: 'Arroz', CostoSistema: 1210, IvaCompraPct: 21 }];
  if (sql.includes("NombreRubro = 'Pesables Deposito'")) return [{ IdProducto: '50', NombreProducto: 'Almendra granel' }];
  if (sql.includes("NombreRubro = 'Pesables Fraccionado'")) return [{ IdProducto: '51', NombreProducto: 'Almendra 500G' }];
  const ids = (sql.match(/p\.IdProducto IN \(([^)]*)\)/) || [])[1];
  if (ids) return ids.match(/\w+/g).filter(id => COSTOS_FALSOS[id]).map(id => ({ IdProducto: id, NombreProducto: COSTOS_FALSOS[id][0], CostoSistema: COSTOS_FALSOS[id][1], IvaCompraPct: 21 }));
  return [];
};
const ARCHIVOS_FALSOS = {
  'pesables_listas.json': { formulas: { 51: { granel: '50' } } },
  'recetas_produccion.json': { productos: { 'p-mezcla': { nombre: 'Mezcla',
    recetas: { base: { nombre: 'Base', rendimientoKg: 1, materiasPrimas: [{ plu: '300', cantidad: 1, unidad: 'kg' }] } },
    presentaciones: { 6319: { recetaId: 'base', kgPorUnidad: 1, insumos: [] } } } } },
};

test('config esquema: Recalcular rango junta los costos de los tres tipos (Reventa, granel $/kg, Producción)', async () => {
  const a = appCon(MIGRADO, { query: sigaFalso, archivos: ARCHIVOS_FALSOS });
  try {
    // Reventa 1210/1,21 = 1000; granel 12100/1,21 = 10000 $/kg; Producción 1 kg de harina 400/1,21 = 330,58
    assert.deepStrictEqual(await a.pedir('POST', '/api/precios/config/esquema/rango'), { rango: { desde: 330.58, hasta: 10000 }, n: 3 });
  } finally { a.cerrar(); }
});

test('decisión: PUT guarda/quita, valida el costo manual; DELETE las borra', async () => {
  const a = appCon({ ...MIGRADO, costoPorProducto: { 1: 100 } }, { query: sigaFalso, archivos: ARCHIVOS_FALSOS });
  try {
    assert.strictEqual((await a.pedir('PUT', '/api/precios/decision/1', { fuente: 'manual' })).decision.fuente, 'manual');
    assert.match((await a.pedir('PUT', '/api/precios/decision/50', { fuente: 'manual' })).error, /costo manual/);
    assert.match((await a.pedir('PUT', '/api/precios/decision/50', {})).error, /fuente/);
    await a.pedir('PUT', '/api/precios/decision/6319', { fuente: 'sistema' });
    assert.deepStrictEqual(Object.keys(a.leer().decisiones).sort(), ['1', '6319']);
    assert.strictEqual((await a.pedir('PUT', '/api/precios/decision/1', { fuente: null })).decision, null);
    assert.deepStrictEqual(Object.keys(a.leer().decisiones), ['6319']);
    await a.pedir('DELETE', '/api/precios/decisiones');
    assert.deepStrictEqual(a.leer().decisiones, {});
  } finally { a.cerrar(); }
});

test('decisión: el PLU tiene que ser una fila decidible y la fuente tener sugerido; null siempre limpia', async () => {
  const a = appCon({ ...MIGRADO, decisiones: { 999: { fuente: 'sistema', fecha: 'x', vigente: { 999: null } } } }, { query: sigaFalso, archivos: ARCHIVOS_FALSOS });
  const decidir = (plu, fuente) => a.pedir('PUT', `/api/precios/decision/${plu}`, { fuente });
  try {
    assert.match((await decidir('777', 'sistema')).error, /no está en ningún listado/); // PLU desconocido
    assert.match((await decidir('51', 'sistema')).error, /presentación de Fraccionado.*PLU 50/); // la decisión es del granel
    assert.match((await decidir('6319', 'ultimaCompra')).error, /fuente ultimaCompra \(disponibles: sistema\)/); // Producción sólo sistema
    assert.match((await decidir('6319', 'manual')).error, /costo manual/);
    assert.match((await decidir('1', 'ultimaCompra')).error, /disponibles: sistema/); // Reventa sin compra registrada
    assert.deepStrictEqual(Object.keys(a.leer().decisiones), ['999']); // ningún rechazo escribió
    for (const plu of ['1', '50', '6319']) assert.strictEqual((await decidir(plu, 'sistema')).decision.fuente, 'sistema', plu);
    assert.deepStrictEqual(Object.keys(a.leer().decisiones).sort(), ['1', '50', '6319', '999']);
    assert.strictEqual((await decidir('999', null)).decision, null); // limpiar una decisión vieja sin fila
    assert.strictEqual((await decidir('1', null)).decision, null);
    assert.deepStrictEqual(Object.keys(a.leer().decisiones).sort(), ['50', '6319']);
  } finally { a.cerrar(); }
});

test('listado y export: tipo inválido; SIGA vacío → sin filas y listas sólo con encabezado', async () => {
  const a = appCon(MIGRADO);
  try {
    assert.match((await a.pedir('GET', '/api/precios/esquema/listado?tipo=otro')).error, /tipo/);
    for (const tipo of ['almacen', 'fraccionado', 'produccion']) {
      const j = await a.pedir('GET', `/api/precios/esquema/listado?tipo=${tipo}`);
      assert.deepStrictEqual([j.migrado, j.filas], [true, []], tipo);
    }
    const e = await a.pedir('GET', '/api/precios/esquema/export');
    assert.deepStrictEqual(e.listas.minorista, [['Codigo', 'Nombre', 'Costo', 'Venta']]);
    assert.strictEqual(e.omitidos, 0);
  } finally { a.cerrar(); }
});

test('detalle: con el permiso trae el desglose; sin él, no; el listado nunca', async () => {
  const query = async sql => (sql.includes('UcPrecioNeto') ? [{ IdProducto: '1', NombreProducto: 'Arroz', CostoSistema: 1210, IvaCompraPct: 21 }]
    : sql.includes('ProductosSucursalesPrecios') ? [{ IdProducto: '1', Precio: 1800 }] : []);
  for (const [sinConfig, conDesglose] of [[false, true], [true, false]]) {
    const a = appCon(MIGRADO, { query, sinConfig });
    try {
      const f = await a.pedir('GET', '/api/precios/esquema/detalle/1?tipo=almacen');
      assert.strictEqual(f.vigente, 1800);
      assert.ok(f.sugeridos.sistema.minorista.precio > 0);
      assert.strictEqual('desglose' in f.sugeridos.sistema, conDesglose);
      assert.strictEqual('costosExtra' in f, conDesglose);
      const l = await a.pedir('GET', '/api/precios/esquema/listado?tipo=almacen');
      assert.strictEqual('desglose' in l.filas[0].sugeridos.sistema, false);
      assert.match((await a.pedir('GET', '/api/precios/esquema/detalle/9?tipo=almacen')).error, /no encontrado/);
    } finally { a.cerrar(); }
  }
});

test('listado Producción: "A revisar" con la materia prima que se movió desde la validación (costo de su tab)', async () => {
  const recetas = JSON.parse(JSON.stringify(ARCHIVOS_FALSOS['recetas_produccion.json']));
  const prod = recetas.productos['p-mezcla'];
  prod.recetas.base.validado = { fecha: '2026-10-01', costoKg: 300, costos: { 300: 300 } };
  prod.presentaciones['6319'].validado = { fecha: '2026-10-01', costoUnidad: 300, costos: { 300: 300 } };
  const a = appCon({ ...MIGRADO, toleranciaPct: 3 }, { query: sigaFalso, archivos: { ...ARCHIVOS_FALSOS, 'recetas_produccion.json': recetas } });
  try {
    const { filas } = await a.pedir('GET', '/api/precios/esquema/listado?tipo=produccion');
    const f = filas.find(x => x.plu === '6319');
    // Harina: sistema 400 con IVA 21 % → 330,58 neto (filaCostos) vs 300 validado
    assert.deepStrictEqual(f.aRevisar, [{ plu: '300', nombre: 'Harina', antes: 300, ahora: 330.58 }]);
  } finally { a.cerrar(); }
});

// ── Decisión temporal (spec §3) ──
test('decisión: PUT guarda el usuario de la sesión y la foto de los vigentes; si SIGA cambia el precio, el listado la poda', async () => {
  let precio = 1800;
  const query = async sql => (sql.includes('ProductosSucursalesPrecios') ? [{ IdProducto: '1', Precio: precio }] : sigaFalso(sql));
  const a = appCon(MIGRADO, { query, archivos: ARCHIVOS_FALSOS, usuario: 'ana' });
  try {
    await a.pedir('PUT', '/api/precios/decision/1', { fuente: 'sistema' });
    await a.pedir('PUT', '/api/precios/decision/50', { fuente: 'sistema' });
    const d = a.leer().decisiones;
    assert.deepStrictEqual([d[1].usuario, d[1].vigente, d[50].vigente], ['ana', { 1: 1800 }, { 51: null }]);
    assert.ok((await a.pedir('GET', '/api/precios/esquema/listado?tipo=almacen')).filas[0].decision);
    precio = 1900; // se importó el precio nuevo en SIGA
    const { filas } = await a.pedir('GET', '/api/precios/esquema/listado?tipo=almacen');
    assert.strictEqual(filas[0].decision, null);
    assert.deepStrictEqual(Object.keys(a.leer().decisiones), ['50']); // podada del archivo
  } finally { a.cerrar(); }
});

test('decisión: DELETE /decisiones/mias borra sólo las del usuario de la sesión', async () => {
  const foto = { vigente: {} };
  const decisiones = { 1: { fuente: 'sistema', usuario: 'ana', ...foto }, 2: { fuente: 'sistema', usuario: 'beto', ...foto }, 3: { fuente: 'manual', usuario: 'ana', ...foto } };
  const a = appCon({ ...MIGRADO, decisiones }, { usuario: 'ana' });
  try {
    assert.deepStrictEqual(await a.pedir('DELETE', '/api/precios/decisiones/mias'), { borradas: 2 });
    assert.deepStrictEqual(Object.keys(a.leer().decisiones), ['2']);
    assert.deepStrictEqual(await a.pedir('DELETE', '/api/precios/decisiones/mias'), { borradas: 0 });
  } finally { a.cerrar(); }
});
