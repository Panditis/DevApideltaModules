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
const { crearGuardPrecios } = require('../lib/precios_permisos');

// guard = el guardPrecios real (403 en config y sin CLAVES_OCULTAS sin permiso) en vez de sólo marcar preciosSinConfig.
function appCon(costeo, { query = async () => [], sinConfig = false, archivos = {}, usuario = null, guard = false } = {}) {
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
  if (guard) app.use(crearGuardPrecios({ tienePermiso: () => !sinConfig }));
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

// ── Producción en el modal: el detalle resuelve PLUs de receta y de envasado (granel + insumos) ──
const COSTOS_ENV = { ...COSTOS_FALSOS, 9710: ['Miel granel', 2420], 6334: ['Frasco 500', 363] };
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
  const almacen = ['1', '6319', '2280', '300'].map(id => ({ IdProducto: id, NombreProducto: `P${id}`, CostoSistema: 1210, IvaCompraPct: 21 }));
  const query = async sql => (sql.includes("NombreRubro = 'Almacen'") ? almacen : sigaEnv(sql));
  const a = appCon(MIGRADO, { query, archivos: { ...ARCHIVOS_FALSOS, 'recetas_produccion.json': RECETAS_ENV } });
  try {
    const { filas } = await a.pedir('GET', '/api/precios/esquema/listado?tipo=almacen');
    assert.deepStrictEqual(filas.map(f => f.plu).sort(), ['1', '300']);
    assert.match((await a.pedir('GET', '/api/precios/esquema/detalle/6319?tipo=almacen')).error, /no encontrado/);
    assert.strictEqual((await a.pedir('PUT', '/api/precios/decision/6319', { fuente: 'sistema' })).decision.fuente, 'sistema'); // como Producción
    const e = await a.pedir('GET', '/api/precios/esquema/export');
    assert.strictEqual(e.listas.minorista.filter(r => r[0] === '6319').length, 1); // una sola vez
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
    for (const plu of ['1', '50', '6319']) assert.deepStrictEqual((await poner(plu, { minorista: 20, pack: 0 })).margenProducto, { minorista: 20 }, plu);
    assert.deepStrictEqual(Object.keys(a.leer().margenProducto).sort(), ['1', '50', '6319', '999']);
    for (const [tipo, plu] of [['almacen', '1'], ['fraccionado', '50'], ['produccion', '6319']]) {
      assert.ok(await precio(tipo, plu) > antes[tipo], tipo);
    }
    const l = await a.pedir('GET', '/api/precios/esquema/listado?tipo=almacen');
    assert.deepStrictEqual(l.filas[0].margenProducto, { minorista: 20 }); // con permiso: el badge del listado
    assert.strictEqual((await poner('999', {})).margenProducto, null); // vacío borra (aunque el PLU ya no esté)
    assert.strictEqual((await poner('1', { minorista: 0 })).margenProducto, null);
    assert.deepStrictEqual(Object.keys(a.leer().margenProducto).sort(), ['50', '6319']);
    assert.strictEqual(await precio('almacen', '1'), antes.almacen);
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
