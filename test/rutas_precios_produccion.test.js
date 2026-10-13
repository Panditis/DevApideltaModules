'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const rutas = require('../routes/rutas_precios_produccion');
const { resumenAlertas } = require('../lib/precios_produccion');
const {
  slug, idUnico, plusUsados, armarCostoDe, costearTodos, filaSelector, armarDetalle, tipoInsumo,
  validarPedidoValidar, aplicarValidacion, normalizarDatos, presentacionesDetectadas, conPresentacionesSiga,
} = rutas;

// Filas como las devuelve costosPorPlu (lib/precios_consultas).
const fila = (plu, nombre, costoSistema, extra = {}) => ({
  plu, nombre, rubro: null, costoMercaderia: null, costoSistema, fechaUltimaCompra: null, ...extra,
});
const COSTOS = new Map([
  ['300', fila('300', 'Harina', 400)],
  ['7067', fila('7067', 'Azúcar', 2800, { costoMercaderia: 3000 })],
  ['6334', fila('6334', 'ENVASE PET 500', 180, { rubro: 'ENVASES' })],
  ['6319', fila('6319', 'GRANOLA 500G', null)],
]);
const COSTEO = { toleranciaPct: 3 };
const PRODUCTO = {
  nombre: 'Granola',
  recetas: {
    base: { nombre: 'Base', rendimientoKg: 10, materiasPrimas: [{ plu: '300', cantidad: 5, unidad: 'kg' }, { plu: '7067', cantidad: 1, unidad: 'kg' }] },
    miel: { nombre: 'Con miel', varianteDe: 'base', extras: [{ plu: '300', cantidad: 1, unidad: 'kg' }] },
    clasica: { nombre: 'Clásica', varianteDe: 'base', extras: [] }, // variedad sin extras = la base tal cual
  },
  presentaciones: { 6319: { recetaId: 'clasica', kgPorUnidad: 0.5 } },
};
const DATOS = normalizarDatos({
  productos: { 'p-granola': PRODUCTO, 'p-yerba': { nombre: 'Yerba', recetas: {}, presentaciones: { 7777: { recetaId: 'x', kgPorUnidad: 1 } } } },
});

// ── slug / idUnico ───────────────────────────────────────────────────────────

test('slug: sin acentos, minúsculas, sólo [a-z0-9-]; vacío → producto', () => {
  assert.strictEqual(slug('Pepas de Membrillo'), 'pepas-de-membrillo');
  assert.strictEqual(slug('  Ñoquis  Caseros!! '), 'noquis-caseros');
  assert.strictEqual(slug('¡¡¡'), 'producto');
  assert.ok(slug('x'.repeat(100)).length <= 40);
});

test('idUnico: agrega -2, -3… si el id ya existe', () => {
  assert.strictEqual(idUnico('p-pepas', {}), 'p-pepas');
  assert.strictEqual(idUnico('p-pepas', { 'p-pepas': {} }), 'p-pepas-2');
  assert.strictEqual(idUnico('p-pepas', { 'p-pepas': {}, 'p-pepas-2': {} }), 'p-pepas-3');
});

// ── plusUsados ────────────────────────────────────────────────

test('plusUsados: MP + extras + PLUs de presentación, sin repetidos', () => {
  assert.deepStrictEqual(plusUsados(DATOS.productos).sort(), ['300', '6319', '7067', '7777']);
});

// ── costeo compartido: selector, detalle y alertas coinciden ────────────────

test('costearTodos + filaSelector: costo/kg base, variantes, presentaciones y nombre SIGA de la presentación', () => {
  const c = costearTodos({ productos: DATOS.productos, costos: COSTOS, costeo: COSTEO });
  const f = filaSelector('p-granola', PRODUCTO, c['p-granola']);
  // (5×400 + 1×2800) / 10 = 480
  const { exportables: _e, ...resto } = f;
  assert.deepStrictEqual(resto, { id: 'p-granola', nombre: 'Granola', variantes: 2, presentaciones: 1, costoKgBase: 480, alertas: 0, faltantes: 0 });
  assert.strictEqual(c['p-granola'].presentaciones['6319'].nombre, 'GRANOLA 500G');
  // 0.5 kg × 480 = 240 (sólo materias primas; sin precio: sale del esquema)
  assert.strictEqual(c['p-granola'].presentaciones['6319'].costoUnidad, 240);
  assert.ok(!('precioConIva' in c['p-granola'].presentaciones['6319']));
});

test('alertas, selector y detalle salen del mismo costeo: validar y subir una materia prima compartida', () => {
  const c0 = costearTodos({ productos: DATOS.productos, costos: COSTOS, costeo: COSTEO });
  const { producto: validado } = aplicarValidacion(PRODUCTO, c0['p-granola'], { tipo: 'todo' }, '2026-09-25');
  const datos = { ...DATOS, productos: { ...DATOS.productos, 'p-granola': validado } };
  const caro = new Map([...COSTOS, ['300', fila('300', 'Harina', 440)]]); // harina +10 %
  const c1 = costearTodos({ productos: datos.productos, costos: caro, costeo: COSTEO });
  const alertas = resumenAlertas(c1);
  const detalle = armarDetalle({ id: 'p-granola', datos, costeado: c1['p-granola'], vigentes: new Map() });
  const selector = filaSelector('p-granola', validado, c1['p-granola']);
  // base, miel, clasica y la presentación 6319
  assert.strictEqual(alertas.total, 4);
  assert.deepStrictEqual(alertas.items.filter(i => i.tipo === 'presentacion').map(i => [i.productoId, i.id, i.componentes]),
    [['p-granola', '6319', [{ plu: '300', nombre: 'Harina', antes: 400, ahora: 440 }]]]);
  assert.strictEqual(detalle.resumen.alertas, alertas.total);
  assert.strictEqual(selector.alertas, alertas.total);
  assert.strictEqual(detalle.presentaciones['6319'].estado, 'cambio');
  assert.strictEqual(detalle.recetas.base.estado, 'cambio');
});

test('tipoInsumo: explícito > envase/tapa por tiposPackaging > etiqueta/precinto por nombre > otro', () => {
  const tp = (nombre) => ({ esTapa: /^tapa /i.test(nombre), esEnvase: /^envase /i.test(nombre) });
  assert.strictEqual(tipoInsumo({ tipo: 'precinto', nombre: 'Envase x' }, tp), 'precinto');
  assert.strictEqual(tipoInsumo({ nombre: 'Tapa roja' }, tp), 'tapa');
  assert.strictEqual(tipoInsumo({ nombre: 'Envase 1kg' }, tp), 'envase');
  assert.strictEqual(tipoInsumo({ nombre: 'ETIQUETA PEPAS' }, tp), 'etiqueta');
  assert.strictEqual(tipoInsumo({ nombre: 'Bolsa' }, tp), 'otro');
  assert.strictEqual(tipoInsumo({ nombre: null }, undefined), 'otro');
});

// ── validaciones de request ──────────────────────────────────────────────────

test('validarPedidoValidar', () => {
  assert.deepStrictEqual(validarPedidoValidar({ tipo: 'receta', id: 'base' }), { tipo: 'receta', id: 'base' });
  assert.deepStrictEqual(validarPedidoValidar({ tipo: 'todo' }), { tipo: 'todo' });
  assert.throws(() => validarPedidoValidar({ tipo: 'presentacion', id: 'abc' }), /id/);
  assert.throws(() => validarPedidoValidar({ tipo: 'otro' }), /tipo/);
});

test('aplicarValidacion: receta puntual, faltantes rechaza (puntual) u omite (todo), sin mutar', () => {
  const sinAzucar = new Map([...COSTOS].filter(([k]) => k !== '7067'));
  const c = costearTodos({ productos: DATOS.productos, costos: sinAzucar, costeo: COSTEO })['p-granola'];
  assert.throws(() => aplicarValidacion(PRODUCTO, c, { tipo: 'receta', id: 'base' }, 'f'), /faltantes/);
  assert.throws(() => aplicarValidacion(PRODUCTO, c, { tipo: 'receta', id: 'nada' }, 'f'), /no encontrada/);
  const r = aplicarValidacion(PRODUCTO, c, { tipo: 'todo' }, 'f');
  assert.deepStrictEqual(r.validados, []);
  assert.deepStrictEqual(r.omitidos.map(o => o.id), ['base', 'miel', 'clasica', '6319']);
  const ok = costearTodos({ productos: DATOS.productos, costos: COSTOS, costeo: COSTEO })['p-granola'];
  const v = aplicarValidacion(PRODUCTO, ok, { tipo: 'receta', id: 'base' }, '2026-09-25');
  assert.deepStrictEqual(v.producto.recetas.base.validado, { fecha: '2026-09-25', costoKg: 480, costos: { 300: 400, 7067: 2800 } });
  assert.strictEqual(PRODUCTO.recetas.base.validado, undefined);
  assert.strictEqual(v.producto.recetas.miel.validado, undefined);
});

// ── Router de punta a punta (express real, query falsa, DATA_DIR temporal) ───

// Fórmula SIGA de 8104 (Pepas): masa + dulce + un envase (el envase no es ingrediente).
const FORMULA_8104 = [
  { plu: '300', nombre: 'Harina', cantPorUnidad: 0.5, rubro: 'MATERIA PRIMA' },
  { plu: '7067', nombre: 'Azúcar', cantPorUnidad: 0.1, rubro: 'MATERIA PRIMA' },
  { plu: '6334', nombre: 'ENVASE PET 500', cantPorUnidad: 1, rubro: 'ENVASES' },
];

// consultaExtra(sql) → filas, o undefined para caer en la query falsa de siempre.
function montar(consultaExtra = () => undefined) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precios-prod-'));
  fs.writeFileSync(path.join(dir, 'costeo.json'), JSON.stringify(COSTEO));
  const sqls = [];
  const query = async (sql) => {
    sqls.push(sql);
    const extra = consultaExtra(sql);
    if (extra !== undefined) return extra;
    if (sql.includes('ProductosSucursalesPrecios')) return [{ IdProducto: '6319', Precio: 1000 }];
    if (sql.includes('HistorialPrecios')) return [{ IdProducto: '6319', Fecha: '2026-02-10' }];
    // 8105: fórmula sólo con empaque (sin ingredientes).
    if (sql.includes('ProductosComponentes')) return /IdProducto = 8104\b/.test(sql) ? FORMULA_8104 : /IdProducto = 8105\b/.test(sql) ? [FORMULA_8104[2]] : [];
    if (sql.includes('SELECT TOP 1 NombreProducto')) return /IdProducto = 810[45]\b/.test(sql) ? [{ nombre: 'PEPAS X KG' }] : [];
    const ids = [...sql.matchAll(/'(\d+)'/g)].map(m => m[1]);
    return ids.filter(id => COSTOS.has(id)).map(id => {
      const f = COSTOS.get(id);
      // PrecioCosto de SIGA viene CON IVA y filaCostos lo divide por (1 + alícuota): el mock lo arma desde el neto del módulo.
      return { IdProducto: id, NombreProducto: f.nombre, CostoSistema: f.costoSistema == null ? null : f.costoSistema * 1.21, IvaCompraPct: 21, Rubro: f.rubro };
    });
  };
  const leerJSON = (p, def) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : def);
  const guardarJSON = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2));
  const apiRoute = fn => async (req, res) => { try { res.json(await fn(req)); } catch (err) { res.status(500).json({ error: err.message }); } };
  const app = express();
  app.use(express.json());
  const tiposPackaging = (nombre, rubro) => ({ esTapa: false, esEnvase: String(rubro).includes('ENVASE') });
  const sqlFormula = { FORMULA_ACTIVA_SQL: '/*FORMULA_ACTIVA*/1=1', SIN_FORMULA_GENERICO_SQL: '/*SIN_GENERICO*/1=1' };
  app.use(rutas({ apiRoute, query, leerJSON, guardarJSON, DATA_DIR: dir, LISTA_PRECIOS_VENTA: 0, tiposPackaging, ...sqlFormula }));
  // El listado del esquema (Producción) sobre el mismo DATA_DIR: para comparar listado vs detalle vs vista previa.
  app.use(require('../routes/rutas_precios_esquema')({ apiRoute, query, leerJSON, guardarJSON, DATA_DIR: dir, LISTA_PRECIOS_VENTA: 0, ...sqlFormula }));
  return new Promise(ok => {
    const server = app.listen(0, () => ok({ server, dir, sqls, base: `http://127.0.0.1:${server.address().port}/api/precios/produccion` }));
  });
}

test('router: crear producto, receta, presentación, validar y alertas', async () => {
  const { server, dir, sqls, base } = await montar();
  const pedir = async (metodo, url, body) => (await fetch(base + url, {
    method: metodo, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })).json();
  try {
    assert.deepStrictEqual(await pedir('GET', '/productos'), []);
    const a = await pedir('POST', '/productos', { nombre: 'Granola' });
    const b = await pedir('POST', '/productos', { nombre: 'Granola' });
    assert.deepStrictEqual([a.id, b.id], ['p-granola', 'p-granola-2']);
    assert.ok(fs.existsSync(path.join(dir, 'recetas_produccion.json')));
    assert.match((await pedir('POST', '/productos', { nombre: '' })).error, /nombre/);
    assert.match((await pedir('GET', '/productos/..%2Fx')).error, /id de producto/);

    const r = await pedir('PUT', '/productos/p-granola/recetas/base', PRODUCTO.recetas.base);
    await pedir('PUT', '/productos/p-granola/recetas/clasica', PRODUCTO.recetas.clasica);
    const sobreBase = { ...PRODUCTO.presentaciones['6319'], recetaId: 'base' };
    assert.match((await pedir('PUT', '/productos/p-granola/presentaciones/6319', sobreBase)).error, /elegí una variedad/i);
    assert.strictEqual(r.receta.rendimientoKg, 10);
    assert.match((await pedir('PUT', '/productos/p-granola/presentaciones/5555', PRODUCTO.presentaciones['6319'])).error, /no existe en SIGA/);
    const pr = await pedir('PUT', '/productos/p-granola/presentaciones/6319', PRODUCTO.presentaciones['6319']);
    assert.strictEqual(pr.nombreSiga, 'GRANOLA 500G');
    assert.match((await pedir('PUT', '/productos/p-granola-2/presentaciones/6319', { recetaId: 'x', kgPorUnidad: 1 })).error, /recetaId|pertenece/);

    const v = await pedir('POST', '/productos/p-granola/validar', { tipo: 'todo' });
    // 'granola' = la variedad automática que se creó con la base.
    assert.deepStrictEqual(v.validados.map(x => x.id), ['base', 'granola', 'clasica', '6319']);
    // Editar la receta no re-valida: conserva el snapshot.
    const e = await pedir('PUT', '/productos/p-granola/recetas/base', { ...PRODUCTO.recetas.base, nombre: 'Base 2' });
    assert.strictEqual(e.receta.validado.costoKg, 480);

    // Vista previa: costea con el cambio en memoria, NO escribe el archivo, y valida igual que el PUT.
    const archivo = path.join(dir, 'recetas_produccion.json');
    const antes = fs.readFileSync(archivo, 'utf8');
    const pv = await pedir('POST', '/productos/p-granola/presentaciones/6319/preview', { ...PRODUCTO.presentaciones['6319'], kgPorUnidad: 1 });
    assert.strictEqual(pv.plu, '6319');
    assert.strictEqual(pv.costoUnidad, 480); // 1 kg × 480
    assert.strictEqual(pv.esquema.plu, '6319'); // precios del motor del esquema
    assert.strictEqual(pv.precioVigente, 1000);
    assert.strictEqual(pv.estado, 'ok'); // conserva el validado guardado (no queda 'sin-validar')
    assert.strictEqual(fs.readFileSync(archivo, 'utf8'), antes);
    const alta = await pedir('POST', '/productos/p-granola/presentaciones/preview', { recetaId: 'clasica', kgPorUnidad: 0.5 });
    assert.strictEqual(alta.plu, null);
    assert.strictEqual(alta.costoUnidad, 240);
    assert.match((await pedir('POST', '/productos/p-granola/presentaciones/6319/preview', { recetaId: 'clasica', kgPorUnidad: 0 })).error, /kgPorUnidad/);
    assert.strictEqual(fs.readFileSync(archivo, 'utf8'), antes);

    const det = await pedir('GET', '/productos/p-granola');
    assert.strictEqual(det.recetas.base.estado, 'ok');
    assert.ok(!('insumos' in det) && !('categoriasMaquina' in det));
    assert.strictEqual(det.presentaciones['6319'].precioVigente, 1000);
    const alertas = await pedir('GET', '/alertas');
    assert.deepStrictEqual(alertas, { total: 0, items: [] });
    const lista = await pedir('GET', '/productos');
    assert.deepStrictEqual(lista.map(p => [p.id, p.costoKgBase]), [['p-granola', 480], ['p-granola-2', null]]);
    // Costo manual de la harina en su tab (440): "a revisar" con la materia prima, costo anterior y nuevo.
    fs.writeFileSync(path.join(dir, 'costeo.json'), JSON.stringify({ ...COSTEO, costoPorProducto: { 300: 440 } }));
    const conCambio = await pedir('GET', '/alertas');
    assert.strictEqual(conCambio.total, 4); // base, granola, clasica y 6319
    assert.deepStrictEqual(conCambio.items.find(i => i.id === '6319').componentes, [{ plu: '300', nombre: 'Harina', antes: 400, ahora: 440 }]);
    // Validar la receta de la presentación también valida la presentación.
    const vr = await pedir('POST', '/productos/p-granola/validar', { tipo: 'receta', id: 'clasica' });
    assert.deepStrictEqual(vr.validados, [{ tipo: 'receta', id: 'clasica' }, { tipo: 'presentacion', id: '6319' }]);
    assert.strictEqual((await pedir('GET', '/alertas')).total, 2); // quedan base y granola

    assert.match((await pedir('DELETE', '/productos/p-granola/recetas/base')).error, /variantes/);
    assert.match((await pedir('DELETE', '/productos/p-granola/recetas/clasica')).error, /presentaciones/);
    assert.ok((await pedir('DELETE', '/productos/p-granola-2')).borrado);
    // SQL: el IN sólo lleva PLUs numéricos validados, entre comillas.
    const ins = sqls.map(s => /IdProducto IN \(([^)]*)\)/.exec(s)).filter(Boolean);
    assert.ok(ins.length > 0);
    assert.ok(ins.every(m => m[1].split(',').every(x => /^'\d+'$/.test(x))));
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('formula-siga: componentes de la fórmula activa con costo y tipo; reusa los filtros SQL inyectados', async () => {
  const { server, dir, sqls, base } = await montar();
  const get = async url => (await fetch(base + url)).json();
  try {
    const f = await get('/formula-siga/8104');
    assert.strictEqual(f.plu, '8104');
    assert.strictEqual(f.nombre, 'PEPAS X KG');
    assert.deepStrictEqual(f.componentes.map(c => [c.plu, c.nombre, c.cantPorUnidad, c.costo, c.fuente, c.tipo]), [
      ['300', 'Harina', 0.5, 400, 'sistema', 'otro'],
      ['7067', 'Azúcar', 0.1, 2800, 'sistema', 'otro'],
      ['6334', 'ENVASE PET 500', 1, 180, 'sistema', 'envase'],
    ]);
    const sql = sqls.find(s => s.includes('ProductosComponentes'));
    assert.match(sql, /FORMULA_ACTIVA/);
    assert.match(sql, /SIN_GENERICO/);
    const vacia = await get('/formula-siga/5555');
    assert.deepStrictEqual(vacia.componentes, []);
    assert.match(vacia.mensaje, /fórmula/);
    assert.match((await get('/formula-siga/abc')).error, /plu/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PUT receta base con escalarVariantes: escala extras de sus variedades en la misma escritura', async () => {
  const { server, dir, base } = await montar();
  const pedir = async (metodo, url, body) => (await fetch(base + url, {
    method: metodo, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })).json();
  try {
    await pedir('POST', '/productos', { nombre: 'Granola' });
    await pedir('PUT', '/productos/p-granola/recetas/base', PRODUCTO.recetas.base); // 10 kg por tanda
    await pedir('PUT', '/productos/p-granola/recetas/miel', PRODUCTO.recetas.miel); // extra 1 kg
    await pedir('POST', '/productos/p-granola/validar', { tipo: 'todo' });
    const nueva = { ...PRODUCTO.recetas.base, rendimientoKg: 12.5, materiasPrimas: [{ plu: '300', cantidad: 6.25, unidad: 'kg' }, { plu: '7067', cantidad: 1.25, unidad: 'kg' }] };
    await pedir('PUT', '/productos/p-granola/recetas/base', { ...nueva, escalarVariantes: true });
    const datos = JSON.parse(fs.readFileSync(path.join(dir, 'recetas_produccion.json'), 'utf8'));
    const r = datos.productos['p-granola'].recetas;
    assert.strictEqual(r.base.rendimientoKg, 12.5);
    assert.strictEqual(r.miel.extras[0].cantidad, 1.25);
    assert.ok(r.miel.validado && r.base.validado); // snapshot intacto: el cambio queda visible
    assert.strictEqual(r.base.escalarVariantes, undefined); // el flag no se guarda
    // Sin el flag no se toca a las variedades.
    await pedir('PUT', '/productos/p-granola/recetas/base', { ...nueva, rendimientoKg: 25 });
    const r2 = JSON.parse(fs.readFileSync(path.join(dir, 'recetas_produccion.json'), 'utf8')).productos['p-granola'].recetas;
    assert.strictEqual(r2.miel.extras[0].cantidad, 1.25);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('presentación provisoria n-… (sin PLU SIGA) y vincular a un PLU real conservando todo', async () => {
  const { server, dir, base } = await montar();
  const pedir = async (metodo, url, body) => (await fetch(base + url, {
    method: metodo, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })).json();
  const leerArchivo = () => JSON.parse(fs.readFileSync(path.join(dir, 'recetas_produccion.json'), 'utf8'));
  try {
    await pedir('POST', '/productos', { nombre: 'Granola' });
    await pedir('PUT', '/productos/p-granola/recetas/base', PRODUCTO.recetas.base);
    await pedir('PUT', '/productos/p-granola/recetas/clasica', PRODUCTO.recetas.clasica);
    const pres = { ...PRODUCTO.presentaciones['6319'], nombre: 'Granola 500 nueva' };
    assert.match((await pedir('PUT', '/productos/p-granola/presentaciones/n-granola-500', PRODUCTO.presentaciones['6319'])).error, /nombre/);
    const alta = await pedir('PUT', '/productos/p-granola/presentaciones/n-granola-500', pres);
    assert.strictEqual(alta.plu, 'n-granola-500');
    assert.strictEqual(alta.nombreSiga, null); // no se consulta SIGA para una provisoria
    const det = await pedir('GET', '/productos/p-granola');
    const p = det.presentaciones['n-granola-500'];
    assert.strictEqual(p.costoUnidad, 240); // 0.5 kg × 480
    assert.ok('esquema' in p);
    assert.strictEqual(p.precioVigente, null);
    assert.strictEqual(p.nombre, 'Granola 500 nueva');
    assert.ok(p.formulaSiga.some(f => f.plu === '300'));
    await pedir('POST', '/productos/p-granola/validar', { tipo: 'presentacion', id: 'n-granola-500' });
    const validado = leerArchivo().productos['p-granola'].presentaciones['n-granola-500'].validado;
    assert.ok(validado);
    // Vincular: el PLU tiene que existir en SIGA y no estar usado.
    assert.match((await pedir('POST', '/productos/p-granola/presentaciones/n-granola-500/vincular', { plu: '5555' })).error, /no existe en SIGA/);
    assert.match((await pedir('POST', '/productos/p-granola/presentaciones/6319/vincular', { plu: '6319' })).error, /provisoria/);
    const v = await pedir('POST', '/productos/p-granola/presentaciones/n-granola-500/vincular', { plu: '6319' });
    assert.strictEqual(v.plu, '6319');
    const guardado = leerArchivo().productos['p-granola'].presentaciones;
    assert.ok(!guardado['n-granola-500']);
    assert.deepStrictEqual(guardado['6319'].validado, validado);
    assert.strictEqual(guardado['6319'].nombre, undefined); // ahora el nombre sale de SIGA
    assert.strictEqual(guardado['6319'].kgPorUnidad, 0.5);
    // Otro provisorio no puede tomar un PLU ya usado.
    await pedir('PUT', '/productos/p-granola/presentaciones/n-otra', { ...pres, nombre: 'Otra' });
    assert.match((await pedir('POST', '/productos/p-granola/presentaciones/n-otra/vincular', { plu: '6319' })).error, /ya es la presentación/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


// ── Exportar desde Producción: presentaciones con PLU SIGA ─────────
test('filaSelector.exportables: sólo PLUs SIGA y costo total', () => {
  const conProv = { ...PRODUCTO, presentaciones: { ...PRODUCTO.presentaciones, 'n-nueva': PRODUCTO.presentaciones['6319'] } };
  const datos = normalizarDatos({ ...DATOS, productos: { 'p-granola': conProv } });
  const c = costearTodos({ productos: datos.productos, costos: COSTOS, costeo: COSTEO })['p-granola'];
  const f = filaSelector('p-granola', conProv, c);
  assert.deepStrictEqual(f.exportables, [{ plu: '6319', nombre: 'GRANOLA 500G', costoTotal: 240, faltantes: [], fechaPrecio: null, variedad: 'Clásica' }]);
});

test('fecha del último cambio de precio: filaSelector (exportables) y armarDetalle (presentaciones); null sin historial', () => {
  const c = costearTodos({ productos: DATOS.productos, costos: COSTOS, costeo: COSTEO });
  const fechas = new Map([['6319', '2026-02-10']]);
  assert.deepStrictEqual(filaSelector('p-granola', PRODUCTO, c['p-granola'], fechas).exportables.map(e => [e.plu, e.fechaPrecio]), [['6319', '2026-02-10']]);
  assert.strictEqual(filaSelector('p-granola', PRODUCTO, c['p-granola']).exportables[0].fechaPrecio, null);
  const base = { id: 'p-granola', datos: DATOS, costeado: c['p-granola'], vigentes: new Map() };
  assert.strictEqual(armarDetalle({ ...base, fechas }).presentaciones['6319'].fechaPrecio, '2026-02-10');
  assert.strictEqual(armarDetalle(base).presentaciones['6319'].fechaPrecio, null);
});

// ── Variedad automática al crear la primera base ─────────────────────────────
test('PUT receta: base nueva sin variedades crea la variedad automática; edición o con variedad no', async () => {
  const { server, dir, base } = await montar();
  const pedir = async (metodo, url, body) => (await fetch(base + url, {
    method: metodo, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })).json();
  const recetas = id => JSON.parse(fs.readFileSync(path.join(dir, 'recetas_produccion.json'), 'utf8')).productos[id].recetas;
  try {
    await pedir('POST', '/productos', { nombre: 'Pepas de Membrillo' });
    const r = await pedir('PUT', '/productos/p-pepas-de-membrillo/recetas/base', PRODUCTO.recetas.base);
    assert.strictEqual(r.variedadCreada, 'pepas-de-membrillo');
    assert.deepStrictEqual(recetas('p-pepas-de-membrillo')['pepas-de-membrillo'], { nombre: 'Pepas de Membrillo', varianteDe: 'base', extras: [] });
    // Editar la base: no crea otra.
    const e = await pedir('PUT', '/productos/p-pepas-de-membrillo/recetas/base', { ...PRODUCTO.recetas.base, nombre: 'Masa' });
    assert.strictEqual(e.variedadCreada, null);
    // Otra base nueva con el producto que ya tiene variedad: tampoco.
    const otra = await pedir('PUT', '/productos/p-pepas-de-membrillo/recetas/otra', PRODUCTO.recetas.base);
    assert.strictEqual(otra.variedadCreada, null);
    assert.deepStrictEqual(Object.keys(recetas('p-pepas-de-membrillo')), ['base', 'pepas-de-membrillo', 'otra']);
    // Una variante a mano no dispara nada; el id de la automática no pisa uno existente.
    await pedir('POST', '/productos', { nombre: 'Base' });
    const b = await pedir('PUT', '/productos/p-base/recetas/base', PRODUCTO.recetas.base);
    assert.strictEqual(b.variedadCreada, 'base-2');
    assert.strictEqual(recetas('p-base')['base-2'].varianteDe, 'base');
    const v = await pedir('PUT', '/productos/p-base/recetas/miel', PRODUCTO.recetas.miel);
    assert.strictEqual(v.variedadCreada, null);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Alta de producto desde la fórmula de SIGA ────────────────────────────────
test('POST productos/desde-siga: receta base + variedad (el empaque no se guarda), en una escritura; errores de input', async () => {
  const { server, dir, base } = await montar();
  const pedir = async (metodo, url, body) => (await fetch(base + url, {
    method: metodo, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })).json();
  const archivo = path.join(dir, 'recetas_produccion.json');
  try {
    assert.match((await pedir('POST', '/productos/desde-siga', { nombre: '', plu: '8104', rendimientoKg: 10 })).error, /nombre/);
    assert.match((await pedir('POST', '/productos/desde-siga', { nombre: 'Pepas', plu: 'abc', rendimientoKg: 10 })).error, /plu/);
    assert.match((await pedir('POST', '/productos/desde-siga', { nombre: 'Pepas', plu: '8104', rendimientoKg: 0 })).error, /rendimientoKg/);
    assert.match((await pedir('POST', '/productos/desde-siga', { nombre: 'Pepas', plu: '8104' })).error, /rendimientoKg/);
    // Fórmula vacía: el mismo mensaje que formula-siga.
    const vacia = await pedir('POST', '/productos/desde-siga', { nombre: 'Pepas', plu: '5555', rendimientoKg: 10 });
    assert.strictEqual(vacia.error, (await pedir('GET', '/formula-siga/5555')).mensaje);
    // Sólo empaque: no hay receta posible.
    assert.match((await pedir('POST', '/productos/desde-siga', { nombre: 'Pepas', plu: '8105', rendimientoKg: 10 })).error, /ingrediente|empaque/i);
    assert.ok(!fs.existsSync(archivo)); // ningún error escribió

    const r = await pedir('POST', '/productos/desde-siga', { nombre: 'Pepas', plu: '8104', rendimientoKg: 10 });
    assert.strictEqual(r.id, 'p-pepas');
    assert.strictEqual(r.variedadCreada, 'pepas');
    const p = JSON.parse(fs.readFileSync(archivo, 'utf8')).productos['p-pepas'];
    assert.deepStrictEqual(r.producto, p);
    assert.deepStrictEqual(p.recetas, {
      base: { nombre: 'Pepas', rendimientoKg: 10, materiasPrimas: [{ plu: '300', cantidad: 5, unidad: 'kg' }, { plu: '7067', cantidad: 1, unidad: 'kg' }] },
      pepas: { nombre: 'Pepas', varianteDe: 'base', extras: [] },
    });
    assert.ok(!('insumos' in p));
    assert.deepStrictEqual(p.presentaciones, {});
    assert.strictEqual(p.nombre, 'Pepas');
    // Mismo nombre otra vez → id nuevo, no pisa.
    assert.strictEqual((await pedir('POST', '/productos/desde-siga', { nombre: 'Pepas', plu: '8104', rendimientoKg: 3 })).id, 'p-pepas-2');
    // El detalle lo costea como cualquier otro: (5×400 + 1×2800) / 10 = 480 $/kg.
    const det = await pedir('GET', '/productos/p-pepas');
    assert.strictEqual(det.recetas.base.costoKg, 480);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Presentaciones desde SIGA: caso yogur (90739 granel → presentaciones que lo usan) ─────────
// ProductosComponentes falso: [producto, fórmula, componente, cantidad]; activa = Productos.IdFormula.
const YOGUR_NOMBRES = {
  90739: ['Yogurt Natural Tipo Griego DEPOSITO GRANEL', 'MATERIA PRIMA'], 11121: ['Yogurt Griego 1.3 KG', 'YOGUR'],
  1968: ['Yogurt Batido c Frutilla 370G', 'YOGUR'], 3035: ['Yogurt Frutos Rojos 370G', 'YOGUR'], 2705: ['Yogurt Frutos Rojos 750G', 'YOGUR'],
  300: ['Leche', 'MATERIA PRIMA'], 90631: ['Mermelada Frutillas Produccion Yogur', 'MATERIA PRIMA'], 9610: ['Mermelada Frutos Rojos', 'MATERIA PRIMA'],
  5001: ['ETIQUETA YOGURT', 'ETIQUETAS'], 5002: ['Envase PP 370', 'ENVASES'], 5003: ['Tapa PP 370', 'ENVASES'], 5004: ['Envase PP 1300', 'ENVASES'],
};
const YOGUR_ACTIVA = { 2705: 2 }; // el resto: fórmula 1
const YOGUR_PC = [
  [90739, 1, 300, 1.1],
  [11121, 1, 90739, 1.3], [11121, 1, 5004, 1], [11121, 1, 5001, 1],
  [1968, 1, 90739, 0.33], [1968, 1, 90631, 0.04], [1968, 1, 5001, 1], [1968, 1, 5002, 1], [1968, 1, 5003, 1],
  [3035, 1, 90739, 0.336], [3035, 1, 9610, 0.034], [3035, 1, 5002, 1],
  [2705, 1, 90739, 0.5], [2705, 1, 9610, 0.05], // fórmula vieja: no cuenta
  [2705, 2, 90739, 0.681], [2705, 2, 9610, 0.069], [2705, 2, 5002, 1],
].map(([prod, formula, comp, cant]) => ({ prod: String(prod), formula, comp: String(comp), cant }));

// Emula la base: sin el filtro de fórmula activa en el SQL devuelve TODAS las fórmulas (así el test lo detecta).
function consultaYogur(sql) {
  if (sql.includes('SELECT TOP 1 NombreProducto')) {
    const m = /IdProducto = (\d+)/.exec(sql);
    return m && YOGUR_NOMBRES[m[1]] ? [{ nombre: YOGUR_NOMBRES[m[1]][0] }] : undefined;
  }
  if (!sql.includes('ProductosComponentes')) return undefined;
  const activas = YOGUR_PC.filter(r => !sql.includes('FORMULA_ACTIVA') || r.formula === (YOGUR_ACTIVA[r.prod] || 1));
  const inversa = /IdProductoComponente = (\d+)/.exec(sql);
  if (inversa) return activas.filter(r => r.comp === inversa[1]).map(r => ({ plu: r.prod, nombre: YOGUR_NOMBRES[r.prod][0], cantidad: r.cant }));
  const enLista = /IdProducto IN \(([^)]*)\)/.exec(sql);
  const unico = /IdProducto = (\d+)/.exec(sql);
  const padres = enLista ? enLista[1].split(',').map(x => x.replace(/'/g, '').trim()) : unico ? [unico[1]] : [];
  if (!padres.some(p => YOGUR_PC.some(r => r.prod === p))) return undefined;
  return activas.filter(r => padres.includes(r.prod)).map(r => ({
    padre: r.prod, plu: r.comp, nombre: YOGUR_NOMBRES[r.comp][0], cantidad: r.cant, cantPorUnidad: r.cant, rubro: YOGUR_NOMBRES[r.comp][1],
  }));
}

test('formula-siga: presentaciones que usan el granel en su fórmula activa (una consulta inversa + una IN, sin N+1)', async () => {
  const { server, dir, sqls, base } = await montar(consultaYogur);
  try {
    const f = await (await fetch(base + '/formula-siga/90739')).json();
    assert.deepStrictEqual(f.componentes.map(c => c.plu), ['300']); // la receta base no cambia
    assert.deepStrictEqual(f.presentaciones.map(p => [p.plu, p.kgGranel, p.kgPorUnidad, p.variedad, p.yaEn]), [
      ['11121', 1.3, 1.3, null, null],
      ['1968', 0.33, 0.37, 'Con Mermelada Frutillas Produccion Yogur', null],
      ['3035', 0.336, 0.37, 'Con Mermelada Frutos Rojos', null],
      ['2705', 0.681, 0.75, 'Con Mermelada Frutos Rojos', null], // fórmulas 1 y 2: sólo la activa, una vez
    ]);
    const p1968 = f.presentaciones[1];
    assert.strictEqual(p1968.nombre, 'Yogurt Batido c Frutilla 370G');
    assert.deepStrictEqual(p1968.extras, [{ plu: '90631', nombre: 'Mermelada Frutillas Produccion Yogur', cantidad: 0.04 }]);
    assert.deepStrictEqual(p1968.empaque.map(e => [e.plu, e.cantidad, e.tipo]), [['5001', 1, 'etiqueta'], ['5002', 1, 'envase'], ['5003', 1, 'envase']]);
    const pcs = sqls.filter(s => s.includes('ProductosComponentes'));
    assert.strictEqual(pcs.length, 3); // fórmula del granel + inversa + fórmulas de las presentaciones
    assert.ok(pcs.every(s => /FORMULA_ACTIVA/.test(s)));
    const ins = /IdProducto IN \(([^)]*)\)/.exec(pcs[2]);
    assert.ok(ins[1].split(',').every(x => /^'\d+'$/.test(x)));
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('POST desde-siga con presentaciones: variedades por conjunto de extras, extras promediados, subconjunto y omitidas', async () => {
  const { server, dir, base } = await montar(consultaYogur);
  const pedir = async (metodo, url, body) => (await fetch(base + url, {
    method: metodo, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })).json();
  const archivo = path.join(dir, 'recetas_produccion.json');
  const r4 = n => Math.round(n * 1e4) / 1e4;
  try {
    assert.match((await pedir('POST', '/productos/desde-siga', { nombre: 'Yogur', plu: '90739', rendimientoKg: 100, presentaciones: ['abc'] })).error, /presentaciones/);
    assert.ok(!fs.existsSync(archivo));

    const r = await pedir('POST', '/productos/desde-siga', { nombre: 'Yogur Griego', plu: '90739', rendimientoKg: 100 });
    assert.strictEqual(r.id, 'p-yogur-griego');
    assert.strictEqual(r.variedadCreada, 'yogur-griego');
    assert.deepStrictEqual(r.presentacionesCreadas, ['11121', '1968', '3035', '2705']);
    assert.deepStrictEqual(r.omitidas, []);
    const p = JSON.parse(fs.readFileSync(archivo, 'utf8')).productos['p-yogur-griego'];
    assert.deepStrictEqual(r.producto, p);
    const variedades = Object.entries(p.recetas).filter(([, x]) => x.varianteDe);
    assert.strictEqual(variedades.length, 3); // automática, con frutilla, con frutos rojos
    const porNombre = Object.fromEntries(variedades.map(([id, x]) => [x.nombre, { id, ...x }]));
    const frutilla = porNombre['Con Mermelada Frutillas Produccion Yogur'];
    const rojos = porNombre['Con Mermelada Frutos Rojos'];
    assert.deepStrictEqual(porNombre['Yogur Griego'].extras, []);
    assert.deepStrictEqual(frutilla.extras, [{ plu: '90631', cantidad: r4(0.04 / 0.33 * 100), unidad: 'kg' }]);
    assert.deepStrictEqual(rojos.extras, [{ plu: '9610', cantidad: r4((0.034 / 0.336 + 0.069 / 0.681) / 2 * 100), unidad: 'kg' }]);
    assert.deepStrictEqual(Object.fromEntries(Object.entries(p.presentaciones).map(([plu, x]) => [plu, [x.recetaId, x.kgPorUnidad]])), {
      11121: ['yogur-griego', 1.3], 1968: [frutilla.id, 0.37], 3035: [rojos.id, 0.37], 2705: [rojos.id, 0.75],
    });
    // El empaque detectado ya no se guarda (sólo viaja en la respuesta de formula-siga).
    assert.deepStrictEqual(p.presentaciones['1968'], { recetaId: frutilla.id, kgPorUnidad: 0.37 });
    assert.ok(!('insumos' in p));

    // Ya son presentaciones de "Yogur Griego": el segundo producto se crea igual, sin ellas.
    const dos = await pedir('POST', '/productos/desde-siga', { nombre: 'Yogur Dos', plu: '90739', rendimientoKg: 100 });
    assert.deepStrictEqual(dos.presentacionesCreadas, []);
    assert.deepStrictEqual(dos.omitidas.map(o => o.plu), ['11121', '1968', '3035', '2705']);
    assert.ok(dos.omitidas.every(o => /Yogur Griego/.test(o.motivo) && o.nombre));
    assert.deepStrictEqual(Object.keys(dos.producto.recetas), ['base', 'yogur-dos']);

    // Subconjunto elegido: sólo 1968 → sólo su variedad (no la de frutos rojos).
    fs.rmSync(archivo);
    const sub = await pedir('POST', '/productos/desde-siga', { nombre: 'Yogur', plu: '90739', rendimientoKg: 100, presentaciones: ['1968'] });
    assert.deepStrictEqual(sub.presentacionesCreadas, ['1968']);
    assert.deepStrictEqual(Object.values(sub.producto.recetas).map(x => x.nombre).sort(), ['Con Mermelada Frutillas Produccion Yogur', 'Yogur', 'Yogur']);
    // Un PLU elegido que no usa el granel: avisado en omitidas.
    const raro = await pedir('POST', '/productos/desde-siga', { nombre: 'Yogur Tres', plu: '90739', rendimientoKg: 100, presentaciones: ['777'] });
    assert.deepStrictEqual(raro.omitidas.map(o => o.plu), ['777']);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('presentacionesDetectadas / conPresentacionesSiga: suma repetidos, omite sin granel sin abortar; el empaque no se guarda', () => {
  const usos = [{ plu: '1', nombre: 'Uno', cantidad: 0.2 }, { plu: '1', nombre: 'Uno', cantidad: 0.1 }, { plu: '2', nombre: 'Dos', cantidad: 0 }];
  const componentes = [{ padre: '1', plu: '9', nombre: 'Extra', cantidad: 0.05, tipo: 'otro' }, { padre: '1', plu: '9', nombre: 'Extra', cantidad: 0.05, tipo: 'otro' },
    { padre: '1', plu: '50', nombre: 'Envase', cantidad: 0, tipo: 'envase' }, { padre: '1', plu: '7', nombre: 'Granel', cantidad: 0.3, tipo: 'otro' }];
  const det = presentacionesDetectadas({ granelPlu: '7', usos, componentes, productos: { 'p-x': { nombre: 'X', presentaciones: { 2: {} } } } });
  assert.deepStrictEqual(det.map(d => [d.plu, d.kgGranel, d.kgPorUnidad, d.extras.map(e => e.cantidad), d.empaque.length, d.yaEn]),
    [['1', 0.3, 0.4, [0.1], 1, null], ['2', 0, 0, [], 0, 'X']]);
  const producto = { nombre: 'P', recetas: { base: { nombre: 'P', rendimientoKg: 10, materiasPrimas: [{ plu: '7', cantidad: 1, unidad: 'kg' }] },
    p: { nombre: 'P', varianteDe: 'base', extras: [] } }, presentaciones: {} };
  const r = conPresentacionesSiga(producto, det, { rendimientoKg: 10, autoId: 'p', productos: {} });
  // '1': su envase (cantidad 0) ya no se valida ni se guarda → se crea con su variedad; '2' sin granel → omitida.
  assert.deepStrictEqual(r.presentacionesCreadas, ['1']);
  assert.deepStrictEqual(r.producto.presentaciones['1'], { recetaId: 'con-extra', kgPorUnidad: 0.4 });
  assert.deepStrictEqual(r.omitidas.map(o => o.plu), ['2']);
  assert.match(r.omitidas[0].motivo, /granel/);
  assert.deepStrictEqual(producto.presentaciones, {}); // sin mutar
});

test('armarCostoDe: cada materia prima con el costo de su tab (decisión › manual › sistema + extras); sin fila SIGA → null', () => {
  const costos = new Map([['300', { nombre: 'Harina', costoSistema: 400, costoMercaderia: 450 }], ['7067', { nombre: 'Avena', costoSistema: 2800 }]]);
  const costeo = { decisiones: { 300: { fuente: 'ultimaCompra' } }, costoPorProducto: { 7067: 3000 }, costosExtraFraccionado: { 7067: [{ concepto: 'Flete', tipo: 'kg', valor: 100 }] },
    fuenteCosto: { 7067: 'ultimaCompra' } }; // fuenteCosto ya no se lee
  const costoDe = armarCostoDe({ costos, costeo });
  assert.deepStrictEqual(costoDe('300'), { costo: 450, fuente: 'ultimaCompra', nombre: 'Harina' });
  assert.deepStrictEqual(costoDe('7067'), { costo: 3100, fuente: 'manual', nombre: 'Avena' });
  assert.strictEqual(costoDe('999'), null);
  assert.strictEqual(costoDe('m-etiqueta'), null); // ya no hay insumos manuales
});

test('aplicarValidacion: validar una receta valida también las presentaciones que salen de ella', () => {
  const costeado = {
    recetas: { base: { faltantes: [], costoKg: 620, costos: { 300: 400 } }, pasas: { faltantes: [], costoKg: 700, costos: { 300: 400, 812: 1 } } },
    presentaciones: { 6319: { recetaId: 'pasas', faltantes: [], costoUnidad: 350, costos: { 300: 400, 812: 1 } },
      7000: { recetaId: 'otra', faltantes: [], costoUnidad: 1, costos: {} }, 7001: { recetaId: 'pasas', faltantes: ['kgPorUnidad'], costoUnidad: null, costos: {} } },
  };
  const producto = { recetas: { base: {}, pasas: {} }, presentaciones: { 6319: {}, 7000: {}, 7001: {} } };
  const r = aplicarValidacion(producto, costeado, { tipo: 'receta', id: 'pasas' }, '2026-10-07');
  assert.deepStrictEqual(r.validados, [{ tipo: 'receta', id: 'pasas' }, { tipo: 'presentacion', id: '6319' }]);
  assert.deepStrictEqual(r.omitidos, [{ tipo: 'presentacion', id: '7001', faltantes: ['kgPorUnidad'] }]);
  assert.deepStrictEqual(r.producto.presentaciones['6319'].validado, { fecha: '2026-10-07', costoUnidad: 350, costos: { 300: 400, 812: 1 } });
  assert.ok(!r.producto.presentaciones['7000'].validado && !r.producto.recetas.base.validado);
});

test('armarDetalle: cada presentación trae vigente, fecha y la fila del motor (esquemaDe); sin insumos ni categorías', () => {
  const costeado = { nombre: 'Granola', recetas: {}, presentaciones: { 6319: { plu: '6319', nombre: 'G 500', costoUnidad: 310, faltantes: [] } }, resumen: {} };
  const datos = { productos: { 'p-g': { nombre: 'Granola', creado: '2026-01-01', recetas: {}, presentaciones: { 6319: {} } } } };
  const d = armarDetalle({ id: 'p-g', datos, costeado, vigentes: new Map([['6319', 900]]), fechas: new Map([['6319', '2026-09-01']]),
    esquemaDe: (plu, costo, nombre) => ({ plu, costo, nombre }) });
  assert.deepStrictEqual(d.presentaciones['6319'], { plu: '6319', nombre: 'G 500', costoUnidad: 310, faltantes: [], precioVigente: 900,
    fechaPrecio: '2026-09-01', esquema: { plu: '6319', costo: 310, nombre: 'G 500' } });
  assert.deepStrictEqual([d.id, d.creado, d.definicion], ['p-g', '2026-01-01', datos.productos['p-g']]);
  for (const k of ['insumos', 'insumosManuales', 'categoriasMaquina']) assert.ok(!(k in d), k);
});

test('PUT margen-especial: valida, guarda en el producto (vacío lo borra) y el detalle lo suma al margen de cada canal', async () => {
  const { server, dir, base } = await montar();
  const { CFG } = require('./precios_esquema_fixture');
  fs.writeFileSync(path.join(dir, 'costeo.json'), JSON.stringify({ ...COSTEO, margenes: CFG.margenes }));
  const pedir = async (metodo, url, body) => (await fetch(base + url, {
    method: metodo, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })).json();
  const archivo = () => JSON.parse(fs.readFileSync(path.join(dir, 'recetas_produccion.json'), 'utf8')).productos['p-granola'];
  const margenMin = async () => (await pedir('GET', '/productos/p-granola')).presentaciones['6319'].esquema.sugeridos.sistema.desglose.minorista;
  try {
    await pedir('POST', '/productos', { nombre: 'Granola' });
    await pedir('PUT', '/productos/p-granola/recetas/base', PRODUCTO.recetas.base);
    await pedir('PUT', '/productos/p-granola/recetas/clasica', PRODUCTO.recetas.clasica);
    await pedir('PUT', '/productos/p-granola/presentaciones/6319', PRODUCTO.presentaciones['6319']);
    assert.strictEqual((await margenMin()).margenPct, 30);

    assert.match((await pedir('PUT', '/productos/p-granola/margen-especial', { mayorista: 1 })).error, /canal desconocido/);
    assert.match((await pedir('PUT', '/productos/p-granola/margen-especial', { pack: -100 })).error, /margenEspecial\.pack/);
    assert.match((await pedir('PUT', '/productos/p-nada/margen-especial', { pack: 1 })).error, /no encontrado/);
    assert.ok(!('margenEspecial' in archivo()));

    const r = await pedir('PUT', '/productos/p-granola/margen-especial', { minorista: 5, pack: null, bulto: 0 });
    assert.deepStrictEqual(r, { id: 'p-granola', margenEspecial: { minorista: 5 } });
    assert.deepStrictEqual(archivo().margenEspecial, { minorista: 5 });
    assert.deepStrictEqual([(await margenMin()).margenPct, (await margenMin()).margenEspecialPct], [35, 5]);
    // Renombrar conserva el margen especial; vacío lo borra.
    await pedir('PUT', '/productos/p-granola', { nombre: 'Granola 2' });
    assert.deepStrictEqual(archivo().margenEspecial, { minorista: 5 });
    assert.deepStrictEqual(await pedir('PUT', '/productos/p-granola/margen-especial', {}), { id: 'p-granola', margenEspecial: null });
    assert.ok(!('margenEspecial' in archivo()));
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Envasado Apidelta: Familia › Variedad › PLUs ─────────────────────────────

const { envasadoDesdeFormula, opcionesEnvasado } = rutas;
// Variedad con un PLU (6319: 0,5 kg de granel 7067 + envase 6334).
const MIEL_ENV = { tipo: 'envasado', familia: 'Miel', nombre: 'Pradera', granelPlu: '7067',
  presentaciones: { 6319: { kgPorUnidad: 0.5, componentes: [{ plu: '6334', cantidad: 1 }] } } };

test('plusUsados: una variedad envasada aporta su granel, sus PLUs y los insumos de cada uno', () => {
  assert.deepStrictEqual(plusUsados({ 'p-miel': MIEL_ENV }).sort(), ['6319', '6334', '7067']);
});

test('normalizarDatos: migra al leer los envasados viejos de un solo PLU (idempotente)', () => {
  const viejo = { nombre: 'Miel 500', tipo: 'envasado', plu: '6319', granelPlu: '7067', kgPorUnidad: 0.5, componentes: [{ plu: '6334', cantidad: 1 }] };
  const d = normalizarDatos({ productos: { 'p-miel': viejo, 'p-granola': PRODUCTO } });
  assert.deepStrictEqual(d.productos['p-miel'], { ...MIEL_ENV, nombre: '500' });
  assert.strictEqual(d.productos['p-granola'], PRODUCTO);
  assert.deepStrictEqual(normalizarDatos(d), d);
});

test('envasadoDesdeFormula: granel = el no-empaque (por nombre "granel" o el de más cantidad); el resto, insumos con su cantidad', () => {
  const comp = (plu, nombre, cantPorUnidad, tipo, costo = null) => ({ plu, nombre, cantPorUnidad, tipo, costo, fuente: costo == null ? null : 'sistema' });
  const f = envasadoDesdeFormula({ plu: '6319', nombre: 'MIEL 500G', mensaje: null, componentes: [
    comp('6334', 'ENVASE 500', 1, 'envase', 180), comp('77', 'CAJA', 1, 'otro'), comp('7067', 'MIEL GRANEL', 0.5, 'otro', 2800), comp('812', 'ETIQUETA', 2, 'etiqueta')] });
  assert.deepStrictEqual([f.plu, f.nombre, f.granelPlu, f.granelNombre, f.kgPorUnidad, f.avisoGranel], ['6319', 'MIEL 500G', '7067', 'MIEL GRANEL', 0.5, null]);
  assert.deepStrictEqual(f.componentes.map(c => [c.plu, c.cantidad, c.costo]), [['6334', 1, 180], ['77', 1, null], ['812', 2, null]]);
  // Sin "granel" en el nombre: el no-empaque de más cantidad. Sin no-empaque: granel vacío (se elige a mano).
  const sinNombre = envasadoDesdeFormula({ plu: '1', nombre: 'X', componentes: [comp('5', 'MIEL', 0.25, 'otro'), comp('6', 'POLEN', 0.01, 'otro')] });
  assert.deepStrictEqual([sinNombre.granelPlu, sinNombre.kgPorUnidad, sinNombre.componentes.map(c => c.plu)], ['5', 0.25, ['6']]);
  const soloEmpaque = envasadoDesdeFormula({ plu: '1', nombre: 'X', componentes: [comp('6334', 'ENVASE', 1, 'envase')] });
  assert.deepStrictEqual([soloEmpaque.granelPlu, soloEmpaque.kgPorUnidad, soloEmpaque.componentes.length], [null, null, 1]);
  assert.match(soloEmpaque.mensaje, /granel/);
  const sinFormula = envasadoDesdeFormula({ plu: '1', nombre: 'X', componentes: [], mensaje: 'Este producto no tiene fórmula cargada en SIGA.' });
  assert.deepStrictEqual([sinFormula.granelPlu, sinFormula.componentes], [null, []]);
  assert.match(sinFormula.mensaje, /fórmula/);
  assert.throws(() => envasadoDesdeFormula({ plu: '1', nombre: null, componentes: [] }), /no existe/);
});

test('envasadoDesdeFormula con el granel de la variedad: si la fórmula lo usa es el granel; si usa otro, aviso (no bloquea)', () => {
  const comp = (plu, nombre, cantPorUnidad, tipo) => ({ plu, nombre, cantPorUnidad, tipo, costo: null });
  const formula = { plu: '9002', nombre: 'MIEL AZAHAR 1KG', componentes: [comp('5', 'MIEL PRADERA GRANEL', 0.2, 'otro'), comp('6', 'MIEL AZAHAR', 1, 'otro'), comp('7', 'TAPA', 1, 'tapa')] };
  const mismo = envasadoDesdeFormula(formula, { granelPlu: '6' });
  assert.deepStrictEqual([mismo.granelPlu, mismo.kgPorUnidad, mismo.avisoGranel, mismo.componentes.map(c => c.plu)], ['6', 1, null, ['5', '7']]);
  const otro = envasadoDesdeFormula(formula, { granelPlu: '99' });
  assert.deepStrictEqual([otro.granelPlu, otro.kgPorUnidad, otro.componentes.map(c => c.plu)], ['5', 0.2, ['6', '7']]);
  assert.match(otro.avisoGranel, /otro granel.*5.*MIEL PRADERA GRANEL/);
  // Sin granel en la fórmula no hay con qué comparar: queda el mensaje de siempre, sin aviso de granel.
  assert.strictEqual(envasadoDesdeFormula({ plu: '1', nombre: 'X', componentes: [comp('7', 'TAPA', 1, 'tapa')] }, { granelPlu: '6' }).avisoGranel, null);
});

test('opcionesEnvasado: familias (sin repetir, A→Z), dueño de cada PLU de venta y las variedades', () => {
  const o = opcionesEnvasado({ 'p-granola': PRODUCTO, 'p-miel': MIEL_ENV, 'p-azahar': { ...MIEL_ENV, nombre: 'Azahar', presentaciones: {} },
    'p-dulce': { ...MIEL_ENV, familia: 'Dulces', nombre: 'Leche', presentaciones: {} }, 'p-x': { ...MIEL_ENV, familia: '', nombre: 'Sin familia', presentaciones: {} } });
  assert.deepStrictEqual(o.familias, ['Dulces', 'Miel']);
  assert.deepStrictEqual(o.duenios, { 6319: { productoId: 'p-miel', nombre: 'Miel Pradera' } });
  assert.deepStrictEqual(o.variedades.map(v => [v.id, v.familia, v.nombre]),
    [['p-miel', 'Miel', 'Pradera'], ['p-azahar', 'Miel', 'Azahar'], ['p-dulce', 'Dulces', 'Leche'], ['p-x', '', 'Sin familia']]);
  // Los PLUs de receta también tienen dueño (no se pueden agregar a una variedad).
  assert.deepStrictEqual(opcionesEnvasado({ 'p-granola': { ...PRODUCTO, presentaciones: { 6319: {} } } }).duenios, { 6319: { productoId: 'p-granola', nombre: 'Granola' } });
});

test('aplicarValidacion: variedad envasada valida cada PLU (todo o uno); con faltantes no valida', () => {
  const c = costearTodos({ productos: { 'p-miel': MIEL_ENV }, costos: COSTOS, costeo: COSTEO })['p-miel'];
  assert.strictEqual(c.presentaciones['6319'].costoUnidad, 1580); // 0,5 × 2800 + 180
  const r = aplicarValidacion(MIEL_ENV, c, { tipo: 'todo' }, '2026-10-13');
  assert.deepStrictEqual(r.producto.presentaciones['6319'].validado, { fecha: '2026-10-13', costoUnidad: 1580, costos: { 7067: 2800, 6334: 180 } });
  assert.deepStrictEqual(r.validados, [{ tipo: 'presentacion', id: '6319' }]);
  assert.strictEqual(MIEL_ENV.presentaciones['6319'].validado, undefined); // no muta
  assert.deepStrictEqual(aplicarValidacion(MIEL_ENV, c, { tipo: 'presentacion', id: '6319' }, 'f').validados, [{ tipo: 'presentacion', id: '6319' }]);
  const sinEnvase = costearTodos({ productos: { 'p-miel': MIEL_ENV }, costos: new Map([...COSTOS].filter(([k]) => k !== '6334')), costeo: COSTEO })['p-miel'];
  assert.throws(() => aplicarValidacion(MIEL_ENV, sinEnvase, { tipo: 'presentacion', id: '6319' }, 'f'), /faltantes: 6334/);
  assert.deepStrictEqual(aplicarValidacion(MIEL_ENV, sinEnvase, { tipo: 'todo' }, 'f').omitidos, [{ tipo: 'presentacion', id: '6319', faltantes: ['6334'] }]);
});

test('router envasado: opciones, precarga con granel, alta de la variedad, PLUs, vista previa, edición, validar y alertas', async () => {
  const FORMULA_6319 = [
    { plu: '7067', nombre: 'MIEL GRANEL', cantPorUnidad: 0.5, rubro: 'MATERIA PRIMA' },
    { plu: '6334', nombre: 'ENVASE PET 500', cantPorUnidad: 1, rubro: 'ENVASES' },
  ];
  const { server, dir, base } = await montar(sql => {
    if (sql.includes('ProductosComponentes') && /IdProducto = 6319\b/.test(sql)) return FORMULA_6319;
    if (sql.includes('SELECT TOP 1 NombreProducto') && /IdProducto = 6319\b/.test(sql)) return [{ nombre: 'MIEL 500G' }];
    return undefined;
  });
  const pedir = async (metodo, url, body) => (await fetch(base + url, {
    method: metodo, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })).json();
  try {
    const pre = await pedir('GET', '/envasado/precarga/6319?granel=7067');
    assert.deepStrictEqual([pre.nombre, pre.granelPlu, pre.kgPorUnidad, pre.avisoGranel, pre.componentes.map(c => [c.plu, c.cantidad, c.costo])],
      ['MIEL 500G', '7067', 0.5, null, [['6334', 1, 180]]]);
    assert.match((await pedir('GET', '/envasado/precarga/6319?granel=300')).avisoGranel, /otro granel/);
    assert.match((await pedir('GET', '/envasado/precarga/6319?granel=x')).error, /granel/);
    assert.match((await pedir('GET', '/envasado/precarga/5555')).error, /no existe/);

    // Alta de la variedad sin PLUs (después se agregan).
    const archivo = path.join(dir, 'recetas_produccion.json');
    const variedad = { familia: 'Miel', nombre: 'Pradera', granelPlu: '7067' };
    assert.match((await pedir('POST', '/envasado', { ...variedad, granelPlu: '5555' })).error, /no existe en SIGA/);
    const alta = await pedir('POST', '/envasado', variedad);
    assert.strictEqual(alta.id, 'p-miel-pradera');
    assert.deepStrictEqual(alta.producto.presentaciones, {});

    const body = { ...variedad, presentaciones: { 6319: { kgPorUnidad: pre.kgPorUnidad, componentes: pre.componentes } } };
    const pv = await pedir('POST', '/envasado/preview', { ...body, id: alta.id });
    assert.deepStrictEqual([pv['6319'].costoUnidad, pv['6319'].precioVigente, pv['6319'].esquema.plu, pv['6319'].estado], [1580, 1000, '6319', 'sin-validar']);
    assert.ok(!JSON.parse(fs.readFileSync(archivo, 'utf8')).productos[alta.id].presentaciones['6319']); // la vista previa no escribe
    assert.match((await pedir('PUT', `/productos/${alta.id}/envasado`, { ...body, presentaciones: { 5555: { kgPorUnidad: 1 } } })).error, /no existe en SIGA/);
    const ed = await pedir('PUT', `/productos/${alta.id}/envasado`, body);
    assert.deepStrictEqual(ed.producto.presentaciones['6319'].componentes, [{ plu: '6334', cantidad: 1 }]);
    // Otra variedad no puede usar el mismo PLU; una presentación de receta tampoco.
    assert.match((await pedir('POST', '/envasado', { ...body, nombre: 'Azahar' })).error, /Miel Pradera/);
    await pedir('POST', '/productos', { nombre: 'Granola' });
    await pedir('PUT', '/productos/p-granola/recetas/base', PRODUCTO.recetas.base);
    assert.match((await pedir('PUT', '/productos/p-granola/presentaciones/6319', { recetaId: 'granola', kgPorUnidad: 1 })).error, /Miel Pradera/);

    const op = await pedir('GET', '/envasado/opciones');
    assert.deepStrictEqual([op.familias, op.duenios['6319'], op.variedades.map(v => v.id)], [['Miel'], { productoId: alta.id, nombre: 'Miel Pradera' }, [alta.id]]);
    // "Recetas" no la muestra; el detalle sí (con su definición).
    assert.deepStrictEqual((await pedir('GET', '/productos')).map(p => p.id), ['p-granola']);
    const det = await pedir('GET', `/productos/${alta.id}`);
    assert.deepStrictEqual([det.definicion.familia, det.presentaciones['6319'].costoUnidad, det.presentaciones['6319'].nombre, det.presentaciones['6319'].componentes.map(c => c.rol)],
      ['Miel', 1580, 'GRANOLA 500G', ['granel', 'empaque']]);

    const v = await pedir('POST', `/productos/${alta.id}/validar`, { tipo: 'presentacion', id: '6319' });
    assert.deepStrictEqual(v.validados, [{ tipo: 'presentacion', id: '6319' }]);
    // Editar no re-valida (conserva el validado de cada PLU, creado y margen); "a revisar" compara costos unitarios: 2 envases no es alerta.
    const ed2 = await pedir('PUT', `/productos/${alta.id}/envasado`, { ...body, presentaciones: { 6319: { kgPorUnidad: 0.5, componentes: [{ plu: '6334', cantidad: 2 }] } } });
    assert.ok(ed2.producto.presentaciones['6319'].validado && ed2.producto.creado);
    assert.match((await pedir('PUT', '/productos/p-granola/envasado', body)).error, /no es de envasado/);
    assert.strictEqual((await pedir('GET', '/alertas')).total, 0);
    // Sube el envase en su tab (costo manual): alerta del PLU con el envase antes → ahora.
    fs.writeFileSync(path.join(dir, 'costeo.json'), JSON.stringify({ ...COSTEO, costoPorProducto: { 6334: 200 } }));
    const al = await pedir('GET', '/alertas');
    const it = al.items.find(i => i.productoId === alta.id);
    assert.deepStrictEqual([it.id, it.componentes], ['6319', [{ plu: '6334', nombre: 'ENVASE PET 500', antes: 180, ahora: 200 }]]);
    assert.ok((await pedir('DELETE', `/productos/${alta.id}`)).borrado);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('precio de materia prima por familia: PUT guarda/borra/rechaza, opciones lo trae, y listado, detalle y vista previa lo usan igual', async () => {
  const { server, dir, base } = await montar();
  const { CFG } = require('./precios_esquema_fixture');
  fs.writeFileSync(path.join(dir, 'costeo.json'), JSON.stringify({ ...COSTEO, ...CFG }));
  const pedir = async (metodo, url, body) => (await fetch(base + url, {
    method: metodo, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })).json();
  const listado = async () => (await (await fetch(base.replace('/produccion', '/esquema/listado?tipo=produccion'))).json()).filas.find(f => f.plu === '6319');
  const archivo = () => JSON.parse(fs.readFileSync(path.join(dir, 'recetas_produccion.json'), 'utf8'));
  try {
    const alta = await pedir('POST', '/envasado', MIEL_ENV);
    await pedir('PUT', `/productos/${alta.id}/margen-especial`, { minorista: 7 });
    // Sin precio de familia: granel 7067 ($2800/kg) × 0,5 + envase 180.
    assert.strictEqual((await listado()).costoSistema, 1580);
    await pedir('POST', `/productos/${alta.id}/validar`, { tipo: 'todo' });

    assert.match((await pedir('PUT', '/familias/Miel/costo', { costoKg: 0 })).error, /costoKg/);
    assert.match((await pedir('PUT', '/familias/Otra/costo', { costoKg: 100 })).error, /familia/);
    assert.deepStrictEqual(await pedir('PUT', '/familias/miel/costo', { costoKg: 3000 }), { familia: 'miel', costoKg: 3000 });
    assert.deepStrictEqual(archivo().familias, { miel: { costoKg: 3000 } });
    assert.deepStrictEqual((await pedir('GET', '/envasado/opciones')).costoKgFamilias, { Miel: 3000 });

    // 0,5 × 3000 + 180 = 1680 en el listado, el detalle y la vista previa; mismo sugerido en los tres.
    const fila = await listado();
    const det = (await pedir('GET', `/productos/${alta.id}`)).presentaciones['6319'];
    const pv = (await pedir('POST', '/envasado/preview', { ...MIEL_ENV, id: alta.id }))['6319'];
    assert.deepStrictEqual([fila.costoSistema, det.costoUnidad, pv.costoUnidad], [1680, 1680, 1680]);
    const sugerido = x => x.sugeridos.sistema.minorista.precio;
    assert.ok(sugerido(fila) > 0);
    assert.deepStrictEqual([sugerido(det.esquema), sugerido(pv.esquema)], [sugerido(fila), sugerido(fila)]);
    assert.deepStrictEqual([det.componentes[0].fuente, det.componentes[0].familia, det.componentes[0].costoUnit], ['familia', 'Miel', 3000]);
    // El PLU validado con el granel queda "a revisar": 2800 → 3000.
    assert.deepStrictEqual(fila.aRevisar.map(r => [r.plu, r.antes, r.ahora]), [['7067', 2800, 3000]]);
    assert.strictEqual((await pedir('GET', '/alertas')).total, 1);

    // null lo borra: vuelve al costo del granel.
    assert.deepStrictEqual(await pedir('PUT', '/familias/Miel/costo', { costoKg: null }), { familia: 'Miel', costoKg: null });
    assert.deepStrictEqual(archivo().familias, {});
    assert.strictEqual((await listado()).costoSistema, 1580);
    assert.deepStrictEqual((await pedir('GET', '/envasado/opciones')).costoKgFamilias, {});
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Insumos y mano de obra (2026-10-13) ──
test('plusUsados: también los insumos de cada presentación de receta', () => {
  const productos = { 'p-a': { nombre: 'A', recetas: {}, presentaciones: { 6319: { recetaId: 'x', kgPorUnidad: 1, insumos: [{ plu: '6334', cantidad: 1 }] } } } };
  assert.deepStrictEqual(plusUsados(productos).sort(), ['6319', '6334']);
});

test('router presentación: insumos + minutos por unidad se guardan y suman al costo con el costo hora de costeo.json', async () => {
  const { server, dir, base } = await montar();
  const pedir = async (metodo, url, body) => (await fetch(base + url, {
    method: metodo, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })).json();
  try {
    await pedir('POST', '/productos', { nombre: 'Granola' });
    await pedir('PUT', '/productos/p-granola/recetas/base', PRODUCTO.recetas.base);
    const body = { recetaId: 'granola', kgPorUnidad: 0.5, insumos: [{ plu: '6334', cantidad: 1 }], minutosPorUnidad: 2 };
    // Sin costo hora: MO 0 con aviso (no faltante).
    const sin = await pedir('POST', '/productos/p-granola/presentaciones/6319/preview', body);
    assert.deepStrictEqual([sin.faltantes, sin.avisos], [[], ['costoHora']]);
    fs.writeFileSync(path.join(dir, 'costeo.json'), JSON.stringify({ ...COSTEO, costoHora: 6000 }));
    const put = await pedir('PUT', '/productos/p-granola/presentaciones/6319', body);
    assert.deepStrictEqual([put.presentacion.insumos, put.presentacion.minutosPorUnidad], [[{ plu: '6334', cantidad: 1 }], 2]);
    const p = (await pedir('GET', '/productos/p-granola')).presentaciones['6319'];
    const imp = rol => p.componentes.filter(l => (l.rol || 'receta') === rol).map(l => l.importe);
    assert.deepStrictEqual([imp('insumo'), imp('mo')], [[180], [200]]);
    assert.strictEqual(p.costoUnidad, Math.round((imp('receta')[0] + 180 + 200) * 100) / 100);
    assert.deepStrictEqual(p.avisos, []);
    // Insumo sin fila en SIGA → faltante con su PLU, sin costo.
    const falta = await pedir('POST', '/productos/p-granola/presentaciones/6319/preview', { ...body, insumos: [{ plu: '9999', cantidad: 1 }] });
    assert.deepStrictEqual([falta.costoUnidad, falta.faltantes], [null, ['9999']]);
    assert.match((await pedir('PUT', '/productos/p-granola/presentaciones/6319', { ...body, minutosPorUnidad: -1 })).error, /minutosPorUnidad/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Producto base (modal de Envasado Apidelta) ──
test('presentacionPublica: sin el permiso, el PLU costeado viaja sin desglose (líneas sin costo, sin snapshot ni MP)', () => {
  const p = { plu: '6319', costoUnidad: 1580, estado: 'cambio', faltantes: [], costos: { 7067: 2800 }, materiasPrimas: [{ plu: '1' }],
    cambios: { estado: 'cambio', deltaPct: 3, componentes: [{ plu: '7067', antes: 2700, ahora: 2800 }] },
    componentes: [{ plu: '7067', nombre: 'MIEL GRANEL', cantidad: 0.5, costoUnit: 2800, importe: 1400, fuente: 'sistema', rol: 'granel' }] };
  assert.strictEqual(rutas.presentacionPublica(p, true), p);
  const pub = rutas.presentacionPublica(p, false);
  assert.deepStrictEqual(pub.componentes, [{ plu: '7067', nombre: 'MIEL GRANEL', cantidad: 0.5, rol: 'granel' }]);
  assert.deepStrictEqual(pub.cambios, { estado: 'cambio', deltaPct: 3 });
  assert.ok(!('costos' in pub) && !('materiasPrimas' in pub));
  assert.deepStrictEqual([pub.costoUnidad, pub.estado], [1580, 'cambio']);
});

test('router producto base: GET con todas sus variedades, PUT renombra/mueve/quita en una escritura, POST alta, DELETE', async () => {
  const { server, dir, base } = await montar();
  const pedir = async (metodo, url, body) => (await fetch(base + url, {
    method: metodo, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })).json();
  const archivo = () => JSON.parse(fs.readFileSync(path.join(dir, 'recetas_produccion.json'), 'utf8'));
  try {
    const alta = await pedir('POST', '/envasado', MIEL_ENV);
    await pedir('POST', `/productos/${alta.id}/validar`, { tipo: 'todo' });
    await pedir('PUT', '/familias/Miel/costo', { costoKg: 3000 });
    assert.match((await pedir('GET', '/envasado/base?familia=Nada')).error, /no encontrado/);
    const b = await pedir('GET', '/envasado/base?familia=miel');
    assert.deepStrictEqual([b.familia, b.costoKg, b.conDesglose, b.variedades.map(v => [v.id, v.nombre, v.granelNombre])], ['Miel', 3000, true, [[alta.id, 'Pradera', 'Azúcar']]]);
    assert.deepStrictEqual([b.variedades[0].presentaciones['6319'].costoUnidad, b.variedades[0].presentaciones['6319'].esquema.plu], [1680, '6319']);

    // Renombrar + nueva variedad que se lleva el PLU 6319 + la vieja sin PLUs: una escritura, validado y creado conservados.
    const put = await pedir('PUT', '/envasado/base?familia=Miel', { familia: 'Mieles', variedades: [
      { id: alta.id, nombre: 'Pradera', granelPlu: '7067', presentaciones: { 6319: { kgPorUnidad: 0.5, componentes: [{ plu: '6334', cantidad: 1 }] } } },
      { id: null, nombre: 'Monte', granelPlu: '300', presentaciones: {} },
    ] });
    assert.deepStrictEqual([put.familia, put.ids, put.quitados], ['Mieles', [alta.id, 'p-mieles-monte'], []]);
    const d = archivo();
    assert.deepStrictEqual([d.productos[alta.id].familia, !!d.productos[alta.id].presentaciones['6319'].validado, !!d.productos[alta.id].creado, d.productos['p-mieles-monte'].familia],
      ['Mieles', true, true, 'Mieles']);
    assert.deepStrictEqual(d.familias, { Mieles: { costoKg: 3000 } });
    assert.match((await pedir('PUT', '/envasado/base?familia=Miel', { familia: 'X', variedades: [{ nombre: 'A', granelPlu: '7067' }] })).error, /no existe/);
    assert.match((await pedir('PUT', '/envasado/base?familia=Mieles', { familia: 'Mieles', variedades: [{ nombre: 'A', granelPlu: '5555' }] })).error, /no existe en SIGA/);
    // Quitar una variedad = no mandarla.
    const q = await pedir('PUT', '/envasado/base?familia=Mieles', { familia: 'Mieles', variedades: [{ id: 'p-mieles-monte', nombre: 'Monte', granelPlu: '300' }] });
    assert.deepStrictEqual(q.quitados, [alta.id]);
    // Alta de otro producto base; con un nombre que ya existe, error.
    assert.match((await pedir('POST', '/envasado/base', { familia: 'mieles', variedades: [{ nombre: 'B', granelPlu: '7067' }] })).error, /ya existe/);
    const nuevo = await pedir('POST', '/envasado/base', { familia: 'Propóleos', variedades: [{ nombre: 'Gotas', granelPlu: '7067', presentaciones: { 6319: { kgPorUnidad: 0.1 } } }] });
    assert.deepStrictEqual(nuevo.ids, ['p-propoleos-gotas']);
    const del = await pedir('DELETE', '/envasado/base?familia=Mieles');
    assert.deepStrictEqual(del.borrados, ['p-mieles-monte']);
    assert.deepStrictEqual([Object.keys(archivo().productos), archivo().familias], [['p-propoleos-gotas'], {}]);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
