'use strict';
// Router del esquema por canal por HTTP, con costeo.json en un directorio temporal y SIGA falso (query inyectada).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const crearRutas = require('../routes/rutas_precios_esquema');
const { migrarEsquemaCanales, migrarConfigFraccionado } = require('../lib/precios_config_esquema');
const { crearGuardPrecios } = require('../lib/precios_permisos');

// guard = el guardPrecios real (403 en config y sin CLAVES_OCULTAS sin permiso) en vez de sólo marcar preciosSinConfig.
function appCon(costeo, { query = async () => [], sinConfig = false, archivos = {}, usuario = null, guard = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esq-rutas-'));
  const archivo = path.join(dir, 'costeo.json');
  if (costeo) fs.writeFileSync(archivo, JSON.stringify(costeo));
  for (const [nombre, datos] of Object.entries(archivos)) fs.writeFileSync(path.join(dir, nombre), JSON.stringify(datos));
  const leerJSON = (p, def) => { try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : def; } catch { return def; } };
  let escrituras = 0;
  const guardarJSON = (p, d) => { escrituras++; fs.writeFileSync(p, JSON.stringify(d, null, 2)); };
  const apiRoute = fn => async (req, res) => { try { res.json(await fn(req)); } catch (err) { res.status(500).json({ error: err.message }); } };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.preciosSinConfig = sinConfig; if (usuario) req.session = { user: { usuario } }; next(); });
  if (guard) app.use(crearGuardPrecios({ tienePermiso: () => !sinConfig }));
  app.use(crearRutas({ apiRoute, query, leerJSON, guardarJSON, DATA_DIR: dir, LISTA_PRECIOS_VENTA: 0, FORMULA_ACTIVA_SQL: '1=1', SIN_FORMULA_GENERICO_SQL: '1=1' }));
  let server;
  const pedir = async (metodo, ruta, body, crudo = false) => {
    if (!server) server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const res = await fetch(`http://127.0.0.1:${server.address().port}${ruta}`,
      { method: metodo, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return crudo ? res : res.json();
  };
  return { pedir, leer: () => JSON.parse(fs.readFileSync(archivo, 'utf8')), cerrar: () => server && server.close(), escrituras: () => escrituras };
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

test('config esquema: PUT márgenes guarda las 3 tablas por canal y saca sinConfigurar; el ajuste por peso guardado queda (el del body se ignora); inválido no escribe', async () => {
  const aj = { tramosG: [100], puntos: [5] };
  const a = appCon({ ...MIGRADO, margenes: { ...MIGRADO.margenes, ajustesPeso: aj } });
  try {
    const T = { minPct: 20, maxPct: 40, escalones: 5, rango: { desde: 50, hasta: 5000 } };
    assert.match((await a.pedir('PUT', '/api/precios/config/esquema/margenes', { minorista: T, pack: T })).error, /bulto/);
    assert.strictEqual(a.leer().margenes.pack.sinConfigurar, true);
    const j = await a.pedir('PUT', '/api/precios/config/esquema/margenes', { minorista: T, pack: { ...T, sinConfigurar: true }, bulto: T, ajustesPeso: { tramosG: [300], puntos: [9] } });
    assert.deepStrictEqual(j.margenes, { minorista: T, pack: T, bulto: T, ajustesPeso: aj });
    await a.pedir('PUT', '/api/precios/config/esquema/margenes', { minorista: T, pack: T, bulto: T });
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
  const filas = [100, 1000, 10000].map((c, i) => ({ IdProducto: String(i + 1), NombreProducto: `P${i}`, CostoSistema: c, IvaCompraPct: 21 }));
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
// CostoSistema = PrecioCosto de SIGA, que el módulo usa tal cual (sin dividir por la alícuota).
const COSTOS_FALSOS = { 1: ['Arroz', 1000], 50: ['Almendra granel', 10000], 300: ['Harina', 330.58] };
const sigaFalso = async (sql) => {
  if (sql.includes("NombreRubro = 'Almacen'")) return [{ IdProducto: '1', NombreProducto: 'Arroz', CostoSistema: 1000, IvaCompraPct: 21 }];
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

test('config esquema: Recalcular rango por tipo — Reventa con Producción; Fraccionado sólo el $/kg de sus graneles', async () => {
  const a = appCon(migrarConfigFraccionado(MIGRADO).costeo, { query: sigaFalso, archivos: ARCHIVOS_FALSOS });
  try {
    // Reventa 1000 + Producción 1 kg de harina 330,58 (el granel de 10000 $/kg no entra: Fraccionado ya tiene su config)
    assert.deepStrictEqual(await a.pedir('POST', '/api/precios/config/esquema/rango'), { rango: { desde: 330.58, hasta: 1000 }, n: 2 });
    // Fraccionado: un solo granel → no alcanza para percentiles
    assert.match((await a.pedir('POST', '/api/precios/config/esquema/rango?tipo=fraccionado')).error, /suficientes costos/);
    assert.match((await a.pedir('POST', '/api/precios/config/esquema/rango?tipo=x')).error, /tipo inválido/);
  } finally { a.cerrar(); }
});

test('config esquema: Recalcular rango con Fraccionado sin migrar junta los tres tipos (usa las tablas de la raíz)', async () => {
  const a = appCon(MIGRADO, { query: sigaFalso, archivos: ARCHIVOS_FALSOS });
  try {
    // Reventa 1000 + Producción 330,58 + el granel de Fraccionado 10000 $/kg
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
    // Harina: sistema 330,58 vs 300 validado
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

// ── Producción en el modal: el detalle resuelve PLUs de receta y de envasado (granel + insumos) ──
const COSTOS_ENV = { ...COSTOS_FALSOS, 9710: ['Miel granel', 2000], 6334: ['Frasco 500', 300] };
const sigaEnv = async (sql) => {
  const ids = (sql.match(/p\.IdProducto IN \(([^)]*)\)/) || [])[1];
  if (ids) return ids.match(/\w+/g).filter(id => COSTOS_ENV[id]).map(id => ({ IdProducto: id, NombreProducto: COSTOS_ENV[id][0], CostoSistema: COSTOS_ENV[id][1], IvaCompraPct: 21 }));
  return sigaFalso(sql);
};
const RECETAS_ENV = { productos: { ...ARCHIVOS_FALSOS['recetas_produccion.json'].productos,
  'p-miel': { tipo: 'envasado', familia: 'Miel', nombre: 'Pradera', granelPlu: '9710', presentaciones: { 2280: { kgPorUnidad: 0.5, componentes: [{ plu: '6334', cantidad: 1 }] } } } } };

test('detalle Producción: PLU de receta y PLU envasado con sugerido; el envasado trae granel + insumos', async () => {
  const a = appCon(MIGRADO, { query: sigaEnv, archivos: { ...ARCHIVOS_FALSOS, 'recetas_produccion.json': RECETAS_ENV } });
  try {
    const r = await a.pedir('GET', '/api/precios/esquema/detalle/6319?tipo=produccion');
    assert.ok(r.sugeridos.sistema.minorista.precio > 0, JSON.stringify(r));
    assert.ok(r.sugeridos.sistema.desglose);
    assert.deepStrictEqual(r.componentesCosto.map(c => [c.rol, c.plu, c.importe]), [['mp', '300', 330.58]]); // materias primas por unidad
    const e = await a.pedir('GET', '/api/precios/esquema/detalle/2280?tipo=produccion');
    assert.ok(e.sugeridos.sistema.minorista.precio > 0, JSON.stringify(e));
    assert.strictEqual(e.tipoProduccion, 'envasado');
    assert.deepStrictEqual(e.componentesCosto.map(c => [c.rol, c.plu]), [['granel', '9710'], ['empaque', '6334']]);
  } finally { a.cerrar(); }
});

test('Reventa sin los PLUs de venta de Producción: ni listado, ni decisión como Reventa, ni export doble; la MP sigue costeando', async () => {
  // 6319 (presentación de receta) y 2280 (envasado) también están en el rubro Almacen de SIGA; 300 (materia prima) también.
  const almacen = ['1', '6319', '2280', '300'].map(id => ({ IdProducto: id, NombreProducto: `P${id}`, CostoSistema: 1000, IvaCompraPct: 21 }));
  const query = async sql => (sql.includes("NombreRubro = 'Almacen'") ? almacen : sigaEnv(sql));
  const a = appCon(MIGRADO, { query, archivos: { ...ARCHIVOS_FALSOS, 'recetas_produccion.json': RECETAS_ENV } });
  try {
    const { filas } = await a.pedir('GET', '/api/precios/esquema/listado?tipo=almacen');
    assert.deepStrictEqual(filas.map(f => f.plu).sort(), ['1', '300']);
    assert.match((await a.pedir('GET', '/api/precios/esquema/detalle/6319?tipo=almacen')).error, /no encontrado/);
    assert.strictEqual((await a.pedir('PUT', '/api/precios/decision/6319', { fuente: 'sistema' })).decision.fuente, 'sistema'); // como Producción
    const e = await a.pedir('GET', '/api/precios/esquema/export');
    assert.strictEqual(e.listas.minorista.filter(r => r[0] === 6319).length, 1); // una sola vez
    const p = (await a.pedir('GET', '/api/precios/esquema/listado?tipo=produccion')).filas.find(f => f.plu === '6319');
    assert.strictEqual(p.costoSistema, 330.58); // la materia prima 300 sigue con su costo
  } finally { a.cerrar(); }
});

// ── Insumos y mano de obra de Producción (2026-10-13) ──
test('config esquema: PUT costo-hora valida antes de escribir; el GET lo devuelve (sin cargar → null)', async () => {
  const a = appCon(MIGRADO);
  try {
    assert.strictEqual((await a.pedir('GET', '/api/precios/config/esquema')).costoHora, null);
    assert.match((await a.pedir('PUT', '/api/precios/config/esquema/costo-hora', { costoHora: -5 })).error, /costoHora/);
    assert.match((await a.pedir('PUT', '/api/precios/config/esquema/costo-hora', { costoHora: '8268' })).error, /costoHora/);
    assert.ok(!('costoHora' in a.leer()));
    assert.strictEqual((await a.pedir('PUT', '/api/precios/config/esquema/costo-hora', { costoHora: 8268 })).costoHora, 8268);
    assert.strictEqual(a.leer().costoHora, 8268);
    assert.strictEqual(a.leer().toleranciaPct, 3); // no pisa lo demás
  } finally { a.cerrar(); }
});

test('detalle Producción: el costo suma insumos + mano de obra (costo hora de Configuración); desglose sólo con el permiso', async () => {
  const recetas = JSON.parse(JSON.stringify(RECETAS_ENV));
  recetas.productos['p-mezcla'].presentaciones['6319'] = { recetaId: 'base', kgPorUnidad: 1, insumos: [{ plu: '6334', cantidad: 2 }], minutosPorUnidad: 3 };
  recetas.productos['p-miel'].presentaciones['2280'].minutosPorUnidad = 1;
  for (const sinConfig of [false, true]) {
    const a = appCon({ ...MIGRADO, costoHora: 6000 }, { query: sigaEnv, sinConfig, archivos: { ...ARCHIVOS_FALSOS, 'recetas_produccion.json': recetas } });
    try {
      const r = await a.pedir('GET', '/api/precios/esquema/detalle/6319?tipo=produccion');
      // Harina 330,58 + 2 × frasco 300 + 3 min × $6000/h = 300
      assert.strictEqual(r.costoSistema, 1230.58);
      const e = await a.pedir('GET', '/api/precios/esquema/detalle/2280?tipo=produccion');
      if (sinConfig) {
        assert.ok(!('componentesCosto' in r) && !('componentesCosto' in e));
        continue;
      }
      assert.deepStrictEqual(r.componentesCosto.map(c => [c.rol, c.plu, c.importe]), [['mp', '300', 330.58], ['insumo', '6334', 600], ['mo', '_manoObra', 300]]);
      assert.deepStrictEqual(e.componentesCosto.map(c => [c.rol, c.plu, c.importe]), [['granel', '9710', 1000], ['empaque', '6334', 300], ['mo', '_manoObra', 100]]);
    } finally { a.cerrar(); }
  }
});

test('margen del producto: PUT guarda/quita por PLU decidible (granel en Fraccionado), mueve el precio del listado; inválido no escribe', async () => {
  const a = appCon({ ...MIGRADO, margenProducto: { 999: { minorista: 1 } } }, { query: sigaFalso, archivos: ARCHIVOS_FALSOS });
  const poner = (plu, body) => a.pedir('PUT', `/api/precios/config/esquema/margen-producto/${plu}`, body);
  const precio = async (tipo, plu) => {
    const f = await a.pedir('GET', `/api/precios/esquema/detalle/${plu}?tipo=${tipo}`);
    return (f.presentaciones ? f.presentaciones[0] : f).sugeridos.sistema.minorista.precio;
  };
  try {
    const antes = { almacen: await precio('almacen', '1'), fraccionado: await precio('fraccionado', '50'), produccion: await precio('produccion', '6319') };
    assert.match((await poner('777', { minorista: 5 })).error, /no está en ningún listado/);
    assert.match((await poner('51', { minorista: 5 })).error, /presentación de Fraccionado.*PLU 50/);
    assert.match((await poner('1', { minorista: -100 })).error, /margenProducto\.minorista: El margen/);
    assert.match((await poner('1', { mayorista: 5 })).error, /canal desconocido/);
    assert.deepStrictEqual(a.leer().margenProducto, { 999: { minorista: 1 } }); // ningún rechazo escribió
    for (const plu of ['1', '50', '6319']) assert.deepStrictEqual((await poner(plu, { minorista: 20, pack: 0 })).margenProducto, { modo: 'ajuste', minorista: 20 }, plu);
    assert.deepStrictEqual(Object.keys(a.leer().margenProducto).sort(), ['1', '50', '6319', '999']);
    for (const [tipo, plu] of [['almacen', '1'], ['fraccionado', '50'], ['produccion', '6319']]) {
      assert.ok(await precio(tipo, plu) > antes[tipo], tipo);
    }
    const l = await a.pedir('GET', '/api/precios/esquema/listado?tipo=almacen');
    assert.deepStrictEqual(l.filas[0].margenProducto, { modo: 'ajuste', minorista: 20 }); // con permiso: el badge del listado
    // Modo fijo: el valor es el margen (0 vale); modo desconocido → error sin escribir.
    assert.match((await poner('1', { modo: 'otro', minorista: 5 })).error, /margenProducto\.modo/);
    assert.deepStrictEqual((await poner('1', { modo: 'fijo', minorista: 55, pack: 0, bulto: null })).margenProducto, { modo: 'fijo', minorista: 55, pack: 0 });
    const fijo = (await a.pedir('GET', '/api/precios/esquema/detalle/1?tipo=almacen')).sugeridos.sistema.desglose.minorista;
    assert.deepStrictEqual([fijo.margenPct, fijo.margenProductoModo, fijo.margenGeneralPct], [55, 'fijo', 43.33]);
    assert.strictEqual((await poner('1', { modo: 'fijo', minorista: 20 })).margenProducto.minorista, 20);
    assert.strictEqual((await poner('999', {})).margenProducto, null); // vacío borra (aunque el PLU ya no esté)
    assert.strictEqual((await poner('1', { minorista: 0 })).margenProducto, null);
    assert.deepStrictEqual(Object.keys(a.leer().margenProducto).sort(), ['50', '6319']);
    assert.strictEqual(await precio('almacen', '1'), antes.almacen);
  } finally { a.cerrar(); }
});

test('margen del producto: el modo precio ya no se guarda acá (el precio fijo es costeo.precioFijo)', async () => {
  const a = appCon({ ...MIGRADO }, { query: sigaFalso, archivos: ARCHIVOS_FALSOS });
  try {
    assert.match((await a.pedir('PUT', '/api/precios/config/esquema/margen-producto/1', { modo: 'precio', minorista: 3999 })).error, /margenProducto\.modo: debe ser fijo o ajuste/);
    assert.strictEqual(a.leer().margenProducto, undefined); // el rechazo no escribió
  } finally { a.cerrar(); }
});

test('margen del producto: sin precios-config → 403 al guardar y ni listado ni detalle lo traen (tampoco margenProductoPct)', async () => {
  const costeo = { ...MIGRADO, margenProducto: { 1: { minorista: 20 }, 50: { minorista: 5 }, 6319: { minorista: 3 } } };
  const a = appCon(costeo, { query: sigaFalso, archivos: ARCHIVOS_FALSOS, sinConfig: true, guard: true });
  try {
    assert.match((await a.pedir('PUT', '/api/precios/config/esquema/margen-producto/1', { minorista: 1 })).error, /Sin permiso/);
    assert.deepStrictEqual(a.leer().margenProducto, costeo.margenProducto);
    for (const tipo of ['almacen', 'fraccionado', 'produccion']) {
      const txt = JSON.stringify([await a.pedir('GET', `/api/precios/esquema/listado?tipo=${tipo}`),
        await a.pedir('GET', `/api/precios/esquema/detalle/${{ almacen: '1', fraccionado: '50', produccion: '6319' }[tipo]}?tipo=${tipo}`)]);
      assert.ok(!txt.includes('margenProducto'), tipo);
      assert.ok(txt.includes('"precio"'), tipo); // el precio (ya con el ajuste) sí viaja
    }
  } finally { a.cerrar(); }
});

test('export: Reventa decidida con bulto vinculado → su PLU en minorista y el bulto en las dos listas de bulto', async () => {
  const query = async sql => {
    if (sql.includes("'Almacen Bultos/Cajas'")) return [{ plu: '2', nombre: 'Arroz BULTO x10', basePlu: '1', cantidad: 10, baseNombre: 'Arroz', baseRubro: 'Almacen' }];
    if (sql.includes('ProductosSucursalesPrecios')) return [{ IdProducto: '1', Precio: 1800 }, { IdProducto: '2', Precio: 16000 }];
    return sigaFalso(sql);
  };
  const a = appCon(MIGRADO, { query, archivos: ARCHIVOS_FALSOS });
  try {
    assert.strictEqual((await a.pedir('PUT', '/api/precios/decision/1', { fuente: 'sistema' })).decision.fuente, 'sistema');
    const { listas, omitidos } = await a.pedir('GET', '/api/precios/esquema/export');
    assert.strictEqual(omitidos, 0);
    assert.deepStrictEqual(listas.minorista.slice(1).map(r => r[0]), [1]);
    assert.deepStrictEqual([listas.bultoNeto, listas.bultoIva].map(l => l.slice(1).map(r => r[0])), [[2], [2]]);
  } finally { a.cerrar(); }
});

test('export: con la última compra decidida, Costo y Venta salen de ella (no de sistema) en Reventa, su bulto vinculado y Fraccionado; Codigo numérico', async () => {
  const ultima = { 1: 1500, 50: 15000 }; // última compra neta de factura (sistema: 1000 y 10000)
  const query = async sql => {
    if (sql.includes("'Almacen Bultos/Cajas'")) return [{ plu: '2', nombre: 'Arroz BULTO x10', basePlu: '1', cantidad: 10, baseNombre: 'Arroz', baseRubro: 'Almacen' }];
    if (sql.includes('ProductosSucursalesPrecios')) return [{ IdProducto: '1', Precio: 1800 }, { IdProducto: '2', Precio: 16000 }];
    if (sql.includes("NombreRubro = 'Almacen'")) return [{ IdProducto: '1', NombreProducto: 'Arroz', CostoSistema: 1000, UcPrecioNeto: ultima[1], UcTipo: 'FACTCOM', IvaCompraPct: 21 }];
    const ids = (sql.match(/p\.IdProducto IN \(([^)]*)\)/) || [])[1];
    if (ids) return ids.match(/\w+/g).filter(id => COSTOS_FALSOS[id]).map(id => ({ IdProducto: id, NombreProducto: COSTOS_FALSOS[id][0], CostoSistema: COSTOS_FALSOS[id][1], UcPrecioNeto: ultima[id], UcTipo: 'FACTCOM', IvaCompraPct: 21 }));
    return sigaFalso(sql);
  };
  const a = appCon(MIGRADO, { query, archivos: ARCHIVOS_FALSOS });
  try {
    for (const plu of ['1', '50']) assert.strictEqual((await a.pedir('PUT', `/api/precios/decision/${plu}`, { fuente: 'ultimaCompra' })).decision.fuente, 'ultimaCompra');
    const { listas } = await a.pedir('GET', '/api/precios/esquema/export');
    const arroz = (await a.pedir('GET', '/api/precios/esquema/listado?tipo=almacen')).filas[0];
    const almendra = (await a.pedir('GET', '/api/precios/esquema/listado?tipo=fraccionado')).filas[0].presentaciones[0];
    assert.notStrictEqual(arroz.sugeridos.ultimaCompra.minorista.precio, arroz.sugeridos.sistema.minorista.precio);
    // Costo = 1500 (última compra) tal cual, sin IVA, no 1000 de sistema; Venta = el sugerido con la última compra.
    assert.deepStrictEqual(listas.minorista[1], [1, 'Arroz', 1500, arroz.sugeridos.ultimaCompra.minorista.precio]);
    assert.deepStrictEqual(listas.minorista[2], [51, 'Almendra 500G', 15000, almendra.sugeridos.ultimaCompra.minorista.precio]);
    // Bulto vinculado a Reventa: por unidad (1) del costo de la última compra, igual en las listas sin y con IVA.
    assert.deepStrictEqual([listas.bultoNeto[1].slice(0, 3), listas.bultoIva[1].slice(0, 3)], [[2, 'Arroz BULTO x10', 1500], [2, 'Arroz BULTO x10', 1500]]);
    assert.strictEqual(listas.bultoNeto[1][3], arroz.sugeridos.ultimaCompra.mayoristas[0].neto); // Venta del bulto = su sugerido con la última compra
  } finally { a.cerrar(); }
});

test('tipo de proveedor: PUT guarda/cambia/quita en una fila de Reventa; rechaza tipo inválido y PLU fuera de Reventa sin escribir', async () => {
  const a = appCon({ ...MIGRADO, tipoProveedor: { 999: 'directo' } }, { query: sigaFalso, archivos: ARCHIVOS_FALSOS, guard: true, sinConfig: true });
  const poner = (plu, tipo) => a.pedir('PUT', `/api/precios/tipo-proveedor/${plu}`, { tipo });
  try {
    assert.deepStrictEqual(await poner('1', 'distribuidor'), { plu: '1', tipoProveedor: 'distribuidor' }); // sin precios-config: igual que el costo manual
    assert.deepStrictEqual(a.leer().tipoProveedor, { 999: 'directo', 1: 'distribuidor' });
    assert.strictEqual((await poner('1', 'directo')).tipoProveedor, 'directo');
    assert.match((await poner('1', 'mayorista')).error, /tipo inválido/);
    assert.match((await a.pedir('PUT', '/api/precios/tipo-proveedor/1', {})).error, /tipo inválido/);
    assert.match((await poner('50', 'directo')).error, /no es un producto de Reventa/); // granel de Fraccionado
    assert.match((await poner('777', 'directo')).error, /no es un producto de Reventa/);
    assert.deepStrictEqual(a.leer().tipoProveedor, { 999: 'directo', 1: 'directo' });
    const j = await a.pedir('GET', '/api/precios/esquema/listado?tipo=almacen');
    assert.strictEqual(j.filas.find(f => f.plu === '1').tipoProveedor, 'directo');
    assert.strictEqual((await poner('999', null)).tipoProveedor, null); // quitar pasa siempre (PLU que ya no está)
    assert.strictEqual((await poner('1', null)).tipoProveedor, null);
    assert.deepStrictEqual(a.leer().tipoProveedor, {});
  } finally { a.cerrar(); }
});

test('importar planilla: marca por Costo/Precio con usuario y foto de vigentes (también sin clasificar) en una escritura; informa no encontrados', async () => {
  const query = async sql => {
    if (sql.includes("'Almacen Bultos/Cajas'")) return [{ plu: '2', nombre: 'Arroz BULTO x10', basePlu: '1', cantidad: 10, baseNombre: 'Arroz', baseRubro: 'Almacen' }];
    if (sql.includes('ProductosSucursalesPrecios')) return [{ IdProducto: '1', Precio: 1800 }, { IdProducto: '2', Precio: 16000 }];
    if (sql.includes("NombreRubro = 'Almacen'")) return [{ IdProducto: '1', NombreProducto: 'Arroz', CostoSistema: 1000, UcPrecioNeto: 1500, UcTipo: 'FACTCOM', IvaCompraPct: 21 },
      { IdProducto: '4', NombreProducto: 'Yerba', CostoSistema: 2000, IvaCompraPct: 21 }, { IdProducto: '5', NombreProducto: 'Fideos', CostoSistema: 300, IvaCompraPct: 21 }];
    return sigaFalso(sql);
  };
  const a = appCon({ ...MIGRADO, tipoProveedor: { 1: 'directo', 5: 'directo' } }, { query, archivos: ARCHIVOS_FALSOS, usuario: 'ana' });
  try {
    const { filas } = await a.pedir('GET', '/api/precios/esquema/listado?tipo=almacen');
    const arroz = filas.find(f => f.plu === '1');
    assert.match((await a.pedir('POST', '/api/precios/esquema/importar-decisiones', { filas: [{ codigo: 'x', costo: 1, precio: 1 }] })).error, /Fila 1/);
    const antes = a.escrituras();
    const r = await a.pedir('POST', '/api/precios/esquema/importar-decisiones', { filas: [
      { codigo: 1, nombre: 'Arroz', costo: 1, precio: arroz.sugeridos.ultimaCompra.minorista.precio }, // por Precio
      { codigo: '4', nombre: 'Yerba', costo: 2000, precio: null }, // sin clasificar: igual se marca
      { codigo: 5, nombre: 'Fideos', costo: 1, precio: 1 }, { codigo: 777, nombre: 'Nuevo', costo: 1, precio: 1 }, { codigo: 6319, nombre: 'Mezcla', costo: 1, precio: 1 },
    ] });
    assert.strictEqual(a.escrituras() - antes, 1);
    assert.deepStrictEqual([r.marcados, r.sinClasificar, r.total], [{ sistema: 1, ultimaCompra: 1, manual: 0 }, 1, 5]);
    assert.deepStrictEqual(r.sinCoincidencia.map(x => [x.codigo, x.nombre, x.costoSistema, x.motivo]), [['5', 'Fideos', 300, 'Ningún costo ni precio coincide']]);
    assert.deepStrictEqual(r.noEncontrados.map(x => [x.codigo, x.motivo]), [['777', 'Código no encontrado en Reventa'], ['6319', 'Es de Producción (se decide en Producción)']]);
    const d = a.leer().decisiones;
    assert.deepStrictEqual(Object.keys(d).sort(), ['1', '4']);
    assert.deepStrictEqual([d[1].fuente, d[1].usuario, d[1].vigente, d[4].fuente, d[4].vigente], ['ultimaCompra', 'ana', { 1: 1800, 2: 16000 }, 'sistema', { 4: null }]);
    const { listas } = await a.pedir('GET', '/api/precios/esquema/export'); // las decisiones sobreviven a la poda y exportan
    assert.deepStrictEqual(listas.minorista.slice(1).map(x => [x[0], x[2]]), [[1, 1500], [4, 2000]]);
    assert.deepStrictEqual(listas.bultoIva.slice(1).map(x => x[0]), [2]);
  } finally { a.cerrar(); }
});

// ── Configuración por tipo (spec 2026-10-21 §2.3) ──
const CON_FRACC = migrarConfigFraccionado(MIGRADO).costeo;
const T_FRACC = { minPct: 80, maxPct: 120, escalones: 5, rango: { desde: 50, hasta: 50000 } };

test('config por tipo: GET ?tipo=fraccionado lee su bloque (o la raíz sin migrar); tipo inválido → error', async () => {
  const a = appCon(MIGRADO);
  try {
    const sin = await a.pedir('GET', '/api/precios/config/esquema?tipo=fraccionado');
    assert.deepStrictEqual([sin.fraccionadoMigrado, sin.maquinas, sin.tramosTiempo], [false, [], []]);
    assert.match((await a.pedir('GET', '/api/precios/config/esquema?tipo=produccion')).error, /tipo inválido/);
    assert.match((await a.pedir('PUT', '/api/precios/config/esquema/precio?tipo=fraccionado', { ivaVentaPct: 10, toleranciaPct: 3, redondeo: RED })).error, /migrar_config_fraccionado/);
    assert.deepStrictEqual(a.leer(), MIGRADO); // sin migrar no escribe
  } finally { a.cerrar(); }
});

test('config por tipo: PUT ?tipo=fraccionado guarda en costeo.fraccionado y no toca la raíz (precio, costos, márgenes, costo hora)', async () => {
  const a = appCon(CON_FRACC);
  const url = r => `/api/precios/config/esquema/${r}?tipo=fraccionado`;
  try {
    assert.strictEqual((await a.pedir('PUT', url('precio'), { ivaVentaPct: 10.5, toleranciaPct: 3, redondeo: RED })).ivaVentaPct, 10.5);
    const tipos = { almacen: false, fraccionado: true, produccion: false };
    const c = await a.pedir('PUT', url('costos'), { modoGastos: 'precio', gastosVenta: [{ concepto: 'Flete', pct: 2, tipos }], extrasMinorista: [] });
    assert.deepStrictEqual(c.gastosVenta, [{ id: 'flete', concepto: 'Flete', pct: 2, tipos }]); // la vista con tilde sólo Fraccionado
    await a.pedir('PUT', url('margenes'), { minorista: T_FRACC, pack: T_FRACC, bulto: T_FRACC, ajustesPeso: { tramosG: [300], puntos: [9] } });
    await a.pedir('PUT', url('costo-hora'), { costoHora: 5000 });
    const d = a.leer();
    assert.deepStrictEqual([d.fraccionado.ivaVentaPct, d.fraccionado.modoGastos, d.fraccionado.costoHora], [10.5, 'precio', 5000]);
    assert.deepStrictEqual(d.fraccionado.gastosVenta, [{ id: 'flete', concepto: 'Flete', pct: 2 }]); // guardado sin tildes
    assert.deepStrictEqual(d.fraccionado.margenes.minorista, T_FRACC);
    assert.strictEqual(d.fraccionado.margenes.ajustesPeso, undefined); // el del body se ignora (lo edita Costeo Fraccionado)
    assert.deepStrictEqual(d.fraccionado.maquinas, []); // lo propio se conserva
    for (const k of ['ivaVentaPct', 'modoGastos', 'gastosVenta', 'margenes', 'costoHora']) assert.deepStrictEqual(d[k], CON_FRACC[k], k);
    const g = await a.pedir('GET', '/api/precios/config/esquema');
    assert.deepStrictEqual([g.fraccionadoMigrado, g.margenes], [true, CON_FRACC.margenes]);
  } finally { a.cerrar(); }
});

test('config por tipo: Fraccionado usa sus márgenes; Reventa y Producción siguen con los de la raíz', async () => {
  const a = appCon(CON_FRACC, { query: sigaFalso, archivos: ARCHIVOS_FALSOS });
  const precio = async (tipo, plu) => {
    const f = await a.pedir('GET', `/api/precios/esquema/detalle/${plu}?tipo=${tipo}`);
    return (f.presentaciones ? f.presentaciones[0] : f).sugeridos.sistema.minorista.precio;
  };
  try {
    const antes = { almacen: await precio('almacen', '1'), fraccionado: await precio('fraccionado', '50'), produccion: await precio('produccion', '6319') };
    await a.pedir('PUT', '/api/precios/config/esquema/margenes?tipo=fraccionado', { minorista: T_FRACC, pack: T_FRACC, bulto: T_FRACC });
    assert.ok(await precio('fraccionado', '50') > antes.fraccionado);
    assert.strictEqual(await precio('almacen', '1'), antes.almacen);
    assert.strictEqual(await precio('produccion', '6319'), antes.produccion);
    await a.pedir('PUT', '/api/precios/config/esquema/precio?tipo=fraccionado', { ivaVentaPct: 21, toleranciaPct: 7, redondeo: RED });
    assert.strictEqual((await a.pedir('GET', '/api/precios/esquema/listado?tipo=fraccionado')).toleranciaPct, 7);
    assert.strictEqual((await a.pedir('GET', '/api/precios/esquema/listado?tipo=almacen')).toleranciaPct, 3);
  } finally { a.cerrar(); }
});

test('listado Fraccionado: la presentación suma los insumos de su peso + la MO (min/kg del subrubro × kg); el desglose sólo en el detalle', async () => {
  // Harina (300, 330,58) como insumo de 51 "Almendra 500G"; 2 min/kg × 0,5 kg = 1 min × 6000/60 = 100 de MO → 430,58 por unidad ÷ 0,5 kg = 861,16
  const conSub = async sql => (sql.includes('SubRubros')
    ? [{ IdProducto: '50', NombreProducto: 'Almendra granel', IdSubRubro: 7, NombreSubRubro: 'Frutos secos' }] : sigaFalso(sql));
  const fraccionado = { ...CON_FRACC.fraccionado, costoHora: 6000, subrubros: { 7: { minKg: 2 } },
    envasePorPeso: { 500: { bolsaPlu: '300' } } };
  const a = appCon({ ...CON_FRACC, fraccionado }, { query: conSub, archivos: ARCHIVOS_FALSOS });
  try {
    const det = await a.pedir('GET', '/api/precios/esquema/detalle/50?tipo=fraccionado');
    assert.strictEqual(det.presentaciones[0].costos.sistema, 10861.16);
    assert.strictEqual(det.costos.sistema, 10000); // el granel sigue con su mercadería
    assert.deepStrictEqual(det.presentaciones[0].componentesCosto.map(l => [l.plu, l.rol, l.importe]),
      [['50', 'granel', 5000], ['300', 'insumo', 330.58], ['_manoObra', 'mo', 100]]);
    const [g] = (await a.pedir('GET', '/api/precios/esquema/listado?tipo=fraccionado')).filas;
    assert.deepStrictEqual([g.avisosCosto, g.presentaciones[0].componentesCosto], [[], undefined]);
  } finally { a.cerrar(); }
});


test('listado Fraccionado sin costeo.fraccionado: como antes (sin avisos ni costeo)', async () => {
  const a = appCon(MIGRADO, { query: sigaFalso, archivos: ARCHIVOS_FALSOS });
  try {
    const det = await a.pedir('GET', '/api/precios/esquema/detalle/50?tipo=fraccionado');
    assert.deepStrictEqual([det.presentaciones[0].costos.sistema, det.avisosCosto], [10000, undefined]);
  } finally { a.cerrar(); }
});

test('listado Fraccionado con costeo.fraccionado que no es un bloque (lista o número): no activa el costeo', async () => {
  for (const basura of [[], 5, 'x']) {
    const a = appCon({ ...MIGRADO, fraccionado: basura }, { query: sigaFalso, archivos: ARCHIVOS_FALSOS });
    try {
      const det = await a.pedir('GET', '/api/precios/esquema/detalle/50?tipo=fraccionado');
      assert.deepStrictEqual([det.presentaciones[0].costos.sistema, det.avisosCosto], [10000, undefined], JSON.stringify(basura));
    } finally { a.cerrar(); }
  }
});

// ── Actividad de Fraccionado (spec 2026-10-26-precios-fraccionado-activos-reefer) ─────────────
const conMovimientos = filas => async sql => (sql.includes('MovimientosStockProductos') ? filas : sigaFalso(sql));

test('listado Fraccionado: actividad del granel con los movimientos de 6 meses (granel + presentaciones); detalle igual', async () => {
  const sqls = [];
  const query = async sql => { sqls.push(sql); return conMovimientos([{ IdProducto: '50', N: 4, Ultimo: '2026-10-20' }, { IdProducto: '51', N: 1, Ultimo: '2026-09-02' }])(sql); };
  const a = appCon(MIGRADO, { query, archivos: ARCHIVOS_FALSOS });
  try {
    const j = await a.pedir('GET', '/api/precios/esquema/listado?tipo=fraccionado');
    const [g] = j.filas;
    assert.strictEqual(j.avisoActividad, undefined);
    assert.deepStrictEqual([g.reefer, g.activoManual, g.activo, g.actividad, g.presentaciones[0].movReciente],
      [false, null, true, { auto: 'activo', motivos: [], ultimoMovGranel: '2026-10-20', presentacionesActivas: 1 }, true]);
    const sqlMov = sqls.find(s => s.includes('MovimientosStockProductos'));
    assert.match(sqlMov, /'50','51'|'51','50'/);
    const d = crearRutas.restarMeses(new Date(), 6);
    const desde = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    assert.ok(sqlMov.includes(`'${desde} 00:00:00'`), sqlMov);
    assert.strictEqual((await a.pedir('GET', '/api/precios/esquema/detalle/50?tipo=fraccionado')).actividad.auto, 'activo');
    // Reventa no consulta movimientos
    sqls.length = 0;
    await a.pedir('GET', '/api/precios/esquema/listado?tipo=almacen');
    assert.ok(!sqls.some(s => s.includes('MovimientosStockProductos')));
  } finally { a.cerrar(); }
});

test('actividad: sólo GET listado y detalle de Fraccionado consultan movimientos; decisión, margen, export y rango no', async () => {
  let movs = 0;
  const query = async sql => { if (sql.includes('MovimientosStockProductos')) movs++; return conMovimientos([])(sql); };
  const a = appCon(MIGRADO, { query, archivos: ARCHIVOS_FALSOS });
  const sinMovimientos = async (nombre, pedido) => {
    const antes = movs;
    const j = await pedido();
    assert.strictEqual(j.error, undefined, `${nombre}: ${j.error}`);
    assert.strictEqual(movs, antes, nombre);
  };
  try {
    await sinMovimientos('decisión', () => a.pedir('PUT', '/api/precios/decision/50', { fuente: 'sistema' }));
    await sinMovimientos('margen', () => a.pedir('PUT', '/api/precios/config/esquema/margen-producto/50', { minorista: 5 }));
    await sinMovimientos('export', () => a.pedir('GET', '/api/precios/esquema/export'));
    const antes = movs;
    await a.pedir('POST', '/api/precios/config/esquema/rango?tipo=fraccionado'); // un granel: error de percentiles, da igual
    assert.strictEqual(movs, antes, 'rango');
    await a.pedir('GET', '/api/precios/esquema/listado?tipo=fraccionado');
    assert.strictEqual(movs, antes + 1, 'listado');
    await a.pedir('GET', '/api/precios/esquema/detalle/50?tipo=fraccionado');
    assert.strictEqual(movs, antes + 2, 'detalle');
  } finally { a.cerrar(); }
});

test('restarMeses: fija el día al último del mes si no existe, cruza años y no muta la fecha', () => {
  const iso = d => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const casos = [[[2026, 7, 31], 6, '2026-2-28'], [[2024, 7, 31], 6, '2024-2-29'], [[2026, 9, 26], 6, '2026-4-26'],
    [[2026, 2, 31], 1, '2026-2-28'], [[2026, 0, 15], 6, '2025-7-15'], [[2026, 11, 31], 6, '2026-6-30']];
  for (const [[y, m, dia], meses, esperado] of casos) {
    const d = new Date(y, m, dia);
    assert.strictEqual(iso(crearRutas.restarMeses(d, meses)), esperado);
    assert.strictEqual(iso(d), `${y}-${m + 1}-${dia}`);
  }
});

test('listado Fraccionado: si la consulta de movimientos falla, avisoActividad y nadie inactivo (el listado no se cae)', async () => {
  const query = async sql => { if (sql.includes('MovimientosStockProductos')) throw new Error('timeout'); return sigaFalso(sql); };
  const a = appCon({ ...MIGRADO, activoGranel: { 50: false } }, { query, archivos: ARCHIVOS_FALSOS });
  const error = console.error;
  console.error = () => {};
  try {
    const j = await a.pedir('GET', '/api/precios/esquema/listado?tipo=fraccionado');
    assert.match(j.avisoActividad, /movimientos/);
    assert.deepStrictEqual([j.filas[0].actividad, j.filas[0].activoManual, j.filas[0].activo, j.filas[0].presentaciones[0].movReciente], [null, false, false, null]);
    assert.strictEqual((await a.pedir('GET', '/api/precios/esquema/listado?tipo=almacen')).avisoActividad, undefined);
  } finally { console.error = error; a.cerrar(); }
});

test('PUT /api/precios/fraccionado/activo/:plu ya no existe (404, no escribe): el estado se guarda con PUT …/config/esquema/fraccionado/subrubros { activos }', async () => {
  // Arrange
  const a = appCon({ ...MIGRADO, activoGranel: { 7: true } }, { query: conMovimientos([]), archivos: ARCHIVOS_FALSOS });
  try {
    const antes = a.escrituras();
    // Act
    const res = await a.pedir('PUT', '/api/precios/fraccionado/activo/50', { activo: true }, true);
    // Assert
    assert.strictEqual(res.status, 404);
    assert.strictEqual(a.escrituras(), antes);
    assert.deepStrictEqual(a.leer().activoGranel, { 7: true });
  } finally { a.cerrar(); }
});

test('detalle Fraccionado: min/kg propio del granel + ajuste del tramo + máquina del granel, calculado a mano', async () => {
  // Arrange: subrubro 2 min/kg, propio 4 (gana), tramo de 500 g +2 → (4 + 2) × 0,5 kg = 3 min.
  // MO 3 × 6000/60 = 300; máquina 3 × 1200/60 = 60; insumo 330,58 → 690,58 por unidad ÷ 0,5 kg = 1381,16 $/kg extra.
  const conSub = async sql => (sql.includes('SubRubros')
    ? [{ IdProducto: '50', NombreProducto: 'Almendra granel', IdSubRubro: 7, NombreSubRubro: 'Frutos secos' }] : sigaFalso(sql));
  const fraccionado = { ...CON_FRACC.fraccionado, costoHora: 6000, subrubros: { 7: { minKg: 2 } },
    maquinas: [{ id: 'sel', nombre: 'Selladora', costoHora: 1200 }], porGranel: { 50: { minKg: 4, maquinaId: 'sel' } },
    tramosTiempo: [{ hastaG: 500, minKg: 2 }, { hastaG: 1000, minKg: 0 }], envasePorPeso: { 500: { bolsaPlu: '300' } } };
  const a = appCon({ ...CON_FRACC, fraccionado }, { query: conSub, archivos: ARCHIVOS_FALSOS });
  try {
    // Act
    const det = await a.pedir('GET', '/api/precios/esquema/detalle/50?tipo=fraccionado');
    // Assert
    const p = det.presentaciones[0];
    assert.strictEqual(p.costos.sistema, 11381.16);
    assert.deepStrictEqual(p.componentesCosto.map(l => [l.plu, l.rol, l.importe]),
      [['50', 'granel', 5000], ['300', 'insumo', 330.58], ['_manoObra', 'mo', 300], ['_maquina', 'maquina', 60]]);
    assert.deepStrictEqual(det.avisosCosto, []);
    assert.deepStrictEqual(det.costeoGranel, { maquinaId: 'sel', maquina: 'Selladora', minKgPropio: 4, minKgSubrubro: 2,
      minKgOrigen: 'granel', envase: 'bolsa', subrubroId: '7', subrubro: 'Frutos secos' });
  } finally { a.cerrar(); }
});

test('precio fijo: PUT guarda por PLU de Reventa, valida los precios y quita (limpiando sólo su decisión "precio")', async () => {
  const a = appCon({ ...MIGRADO, precioFijo: { 999: { minorista: 1 } } }, { query: sigaFalso, archivos: ARCHIVOS_FALSOS });
  const poner = (plu, body) => a.pedir('PUT', `/api/precios/precio-fijo/${plu}`, body);
  try {
    for (const plu of ['50', '51', '6319', '777']) assert.match((await poner(plu, { minorista: 3999 })).error, /no es un producto de Reventa/, plu);
    assert.match((await poner('1', { minorista: 0 })).error, /precioFijo\.minorista: El precio debe ser mayor a 0/);
    assert.match((await poner('1', { minorista: 3999.999 })).error, /hasta 2 decimales/);
    assert.match((await poner('1', { mayorista: 5 })).error, /canal desconocido/);
    assert.match((await poner('x1', { minorista: 5 })).error, /PLU inválido/);
    assert.deepStrictEqual(a.leer().precioFijo, { 999: { minorista: 1 } }); // ningún rechazo escribió
    assert.deepStrictEqual((await poner('1', { minorista: 3999, pack: null })).precioFijo, { minorista: 3999 });
    assert.strictEqual((await a.pedir('PUT', '/api/precios/decision/1', { fuente: 'precio' })).decision.fuente, 'precio');
    assert.strictEqual((await poner('1', { minorista: 3500 })).precioFijo.minorista, 3500); // cambiar el precio no suelta la decisión
    assert.strictEqual(a.leer().decisiones['1'].fuente, 'precio');
    assert.deepStrictEqual((await poner('1', {})).precioFijo, null); // vacío = quitar: se va el precio fijo y su decisión
    assert.ok(!('1' in a.leer().precioFijo) && !('1' in (a.leer().decisiones || {})));
    assert.strictEqual((await poner('999', {})).precioFijo, null); // quitar pasa siempre (PLU que ya no está)
    assert.deepStrictEqual(a.leer().precioFijo, {});
  } finally { a.cerrar(); }
});

test('precio fijo: quitar no toca la decisión de otra fuente', async () => {
  const a = appCon({ ...MIGRADO, precioFijo: { 1: { minorista: 3999 } } }, { query: sigaFalso, archivos: ARCHIVOS_FALSOS });
  try {
    await a.pedir('PUT', '/api/precios/decision/1', { fuente: 'sistema' });
    await a.pedir('PUT', '/api/precios/precio-fijo/1', {});
    assert.strictEqual(a.leer().decisiones['1'].fuente, 'sistema');
  } finally { a.cerrar(); }
});

test('decisión "precio": exige precio fijo guardado y una fila de Reventa; el listado trae sugeridos.precio y el export sale con el precio fijo y el costo de referencia', async () => {
  const a = appCon({ ...MIGRADO, precioFijo: { 1: { minorista: 3999 } } }, { query: sigaFalso, archivos: ARCHIVOS_FALSOS });
  try {
    for (const plu of ['50', '6319']) assert.match((await a.pedir('PUT', `/api/precios/decision/${plu}`, { fuente: 'precio' })).error, /precio fijo/, plu);
    const f = await a.pedir('GET', '/api/precios/esquema/detalle/1?tipo=almacen');
    assert.deepStrictEqual(f.precioFijo, { minorista: 3999 });
    assert.deepStrictEqual([f.sugeridos.precio.minorista.precio, f.sugeridos.precio.fuenteRef], [3999, 'sistema']);
    assert.notStrictEqual(f.sugeridos.sistema.minorista.precio, 3999); // las otras fuentes siguen con su margen
    assert.strictEqual((await a.pedir('PUT', '/api/precios/decision/1', { fuente: 'precio' })).decision.fuente, 'precio');
    const { listas, omitidos } = await a.pedir('GET', '/api/precios/esquema/export');
    assert.strictEqual(omitidos, 0);
    assert.deepStrictEqual(listas.minorista.slice(1), [[1, 'Arroz', 1000, 3999]]);
  } finally { a.cerrar(); }
});

test('precio fijo sin precios-config: la card lo ve (fila.precioFijo, sugeridos.precio.fuenteRef) pero no el margen de las tablas ni el desglose; el PUT no pide el permiso', async () => {
  const a = appCon({ ...MIGRADO, precioFijo: { 1: { minorista: 3999 } } }, { query: sigaFalso, archivos: ARCHIVOS_FALSOS, sinConfig: true, guard: true });
  try {
    for (const ruta of ['/api/precios/esquema/detalle/1?tipo=almacen', '/api/precios/esquema/listado?tipo=almacen']) {
      const r = await a.pedir('GET', ruta);
      const fila = r.filas ? r.filas[0] : r;
      assert.deepStrictEqual(fila.precioFijo, { minorista: 3999 }, ruta);
      assert.strictEqual(fila.sugeridos.precio.fuenteRef, 'sistema', ruta);
      const txt = JSON.stringify(r);
      for (const clave of ['desglose', 'margenGeneralPct', 'margenProductoModo', '"margenPct"', 'costoConGastos', 'margenProducto"']) assert.ok(!txt.includes(clave), `${ruta} ${clave}`);
    }
    assert.strictEqual((await a.pedir('PUT', '/api/precios/precio-fijo/1', { minorista: 4100 })).precioFijo.minorista, 4100);
  } finally { a.cerrar(); }
});

// ── Tabla manual (filas) de Fraccionado ──────────────────────────────────────

const FILAS_FRACC = [{ hasta: 1000, margenPct: 300 }, { hasta: null, margenPct: 250 }];
const URL_MARG = '/api/precios/config/esquema/margenes';

test('tabla manual: PUT ?tipo=fraccionado con filas las guarda en costeo.fraccionado y el GET las devuelve; la raíz no cambia', async () => {
  const a = appCon(CON_FRACC);
  try {
    const j = await a.pedir('PUT', `${URL_MARG}?tipo=fraccionado`, { minorista: T_FRACC, pack: { ...T_FRACC, filas: [{ hasta: 1000, margenPct: 300 }, { margenPct: 250 }] }, bulto: T_FRACC });
    assert.deepStrictEqual(j.margenes.pack.filas, FILAS_FRACC);
    const d = a.leer();
    assert.deepStrictEqual(d.fraccionado.margenes.pack, { ...T_FRACC, filas: FILAS_FRACC });
    assert.strictEqual('filas' in d.fraccionado.margenes.minorista, false);
    assert.deepStrictEqual(d.margenes, CON_FRACC.margenes);
    const g = await a.pedir('GET', '/api/precios/config/esquema?tipo=fraccionado');
    assert.deepStrictEqual(g.margenes.pack.filas, FILAS_FRACC);
  } finally { a.cerrar(); }
});

test('tabla manual: PUT con una fila inválida rechaza los tres canales con "canal: Fila N" y no escribe', async () => {
  const a = appCon(CON_FRACC);
  try {
    const antes = a.escrituras();
    const malo = [{ hasta: 0, margenPct: 10 }, { hasta: null, margenPct: 5 }];
    const j = await a.pedir('PUT', `${URL_MARG}?tipo=fraccionado`, { minorista: { ...T_FRACC, filas: FILAS_FRACC }, pack: T_FRACC, bulto: { ...T_FRACC, filas: malo } });
    assert.strictEqual(j.error, 'bulto: Fila 1: el corte debe ser un número mayor a 0');
    assert.strictEqual(a.escrituras(), antes);
    assert.deepStrictEqual(a.leer(), CON_FRACC);
  } finally { a.cerrar(); }
});

test('tabla manual: PUT sin ?tipo (Reventa) descarta las filas del body', async () => {
  const a = appCon(CON_FRACC);
  try {
    await a.pedir('PUT', URL_MARG, { minorista: { ...T_FRACC, filas: FILAS_FRACC }, pack: T_FRACC, bulto: T_FRACC });
    const d = a.leer();
    assert.deepStrictEqual(d.margenes.minorista, T_FRACC);
    assert.deepStrictEqual(d.fraccionado.margenes, CON_FRACC.fraccionado.margenes);
  } finally { a.cerrar(); }
});

test('tabla manual: PUT sin filas las borra; ajustesPeso y descuentoDistribuidorPct se conservan como hoy', async () => {
  const aj = { tramosG: [100], puntos: [5] };
  const fraccionado = { ...CON_FRACC.fraccionado, margenes: { minorista: { ...T_FRACC, filas: FILAS_FRACC }, pack: T_FRACC, bulto: T_FRACC, ajustesPeso: aj } };
  const a = appCon({ ...CON_FRACC, fraccionado });
  try {
    await a.pedir('PUT', `${URL_MARG}?tipo=fraccionado`, { minorista: T_FRACC, pack: T_FRACC, bulto: T_FRACC, descuentoDistribuidorPct: 4, ajustesPeso: { tramosG: [9], puntos: [1] } });
    assert.deepStrictEqual(a.leer().fraccionado.margenes, { minorista: T_FRACC, pack: T_FRACC, bulto: T_FRACC, ajustesPeso: aj, descuentoDistribuidorPct: 4 });
  } finally { a.cerrar(); }
});

test('tabla manual: detalle y listado de Fraccionado cambian de precio con una fila manual; Reventa no', async () => {
  const a = appCon(CON_FRACC, { query: sigaFalso, archivos: ARCHIVOS_FALSOS });
  const detalle = async (tipo, plu) => {
    const f = await a.pedir('GET', `/api/precios/esquema/detalle/${plu}?tipo=${tipo}`);
    return (f.presentaciones ? f.presentaciones[0] : f).sugeridos.sistema.minorista;
  };
  const listado = async () => (await a.pedir('GET', '/api/precios/esquema/listado?tipo=fraccionado')).filas[0].presentaciones[0].sugeridos.sistema.minorista.precio;
  try {
    await a.pedir('PUT', `${URL_MARG}?tipo=fraccionado`, { minorista: T_FRACC, pack: T_FRACC, bulto: T_FRACC });
    const antes = { fracc: (await detalle('fraccionado', '50')).precio, lista: await listado(), reventa: (await detalle('almacen', '1')).precio };
    const unica = [{ hasta: null, margenPct: 400 }];
    await a.pedir('PUT', `${URL_MARG}?tipo=fraccionado`, { minorista: { ...T_FRACC, filas: unica }, pack: T_FRACC, bulto: T_FRACC });
    const fr = await detalle('fraccionado', '50');
    assert.ok(fr.precio > antes.fracc, `${fr.precio} > ${antes.fracc}`);
    assert.strictEqual(await listado(), fr.precio);
    assert.notStrictEqual(antes.lista, fr.precio);
    assert.strictEqual((await detalle('almacen', '1')).precio, antes.reventa);
  } finally { a.cerrar(); }
});
