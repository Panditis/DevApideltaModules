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
  app.use(rutas({ apiRoute, query, leerJSON, guardarJSON, DATA_DIR: dir, LISTA_PRECIOS_VENTA: 0, tiposPackaging,
    FORMULA_ACTIVA_SQL: '/*FORMULA_ACTIVA*/1=1', SIN_FORMULA_GENERICO_SQL: '/*SIN_GENERICO*/1=1' }));
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
