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
  validarInsumosProducto, validarInsumoManual, validarCategoriasMaquina, validarPedidoValidar, aplicarValidacion,
  normalizarDatos, categoriasConUsos, validarBajaCategorias,
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
const COSTEO = { costoHora: 6000, toleranciaPct: 3, metodoGanancia: 'curva', curvaGanancia: { produccion: { a: 50, b: 0, pisoPct: 50, techoPct: 50 } } };
const PRODUCTO = {
  nombre: 'Granola',
  recetas: {
    base: { nombre: 'Base', rendimientoKg: 10, materiasPrimas: [{ plu: '300', cantidad: 5, unidad: 'kg' }, { plu: '7067', cantidad: 1, unidad: 'kg' }] },
    miel: { nombre: 'Con miel', varianteDe: 'base', extras: [{ plu: '300', cantidad: 1, unidad: 'kg' }] },
    clasica: { nombre: 'Clásica', varianteDe: 'base', extras: [] }, // variedad sin extras = la base tal cual
  },
  insumos: [{ plu: '6334' }, { manualId: 'm-etiqueta' }],
  presentaciones: { 6319: { recetaId: 'clasica', kgPorUnidad: 0.5, insumos: [{ plu: '6334', cantidad: 1 }, { manualId: 'm-etiqueta', cantidad: 1 }] } },
};
const DATOS = normalizarDatos({
  productos: { 'p-granola': PRODUCTO, 'p-yerba': { nombre: 'Yerba', recetas: {}, presentaciones: { 7777: { recetaId: 'x', kgPorUnidad: 1, insumos: [{ plu: '6334', cantidad: 1 }] } } } },
  insumosManuales: { 'm-etiqueta': { nombre: 'Etiqueta', costo: 60, tipo: 'etiqueta' } },
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

// ── plusUsados / armarCostoDe ────────────────────────────────────────────────

test('plusUsados: MP + extras + insumos de presentación + PLUs de presentación, sin manuales ni repetidos', () => {
  assert.deepStrictEqual(plusUsados(DATOS.productos).sort(), ['300', '6319', '6334', '7067', '7777']);
});

test('armarCostoDe: SIGA vía elegirCosto (override manual y última compra), manual, y null si falta', () => {
  const costeo = { costoPorProducto: { 300: 450 }, fuenteCosto: { 7067: 'ultimaCompra' } };
  const costoDe = armarCostoDe({ costos: COSTOS, costeo, insumosManuales: DATOS.insumosManuales });
  assert.deepStrictEqual(costoDe('300'), { costo: 450, fuente: 'manual', nombre: 'Harina' });
  assert.deepStrictEqual(costoDe('7067'), { costo: 3000, fuente: 'ultimaCompra', nombre: 'Azúcar' });
  assert.deepStrictEqual(costoDe('6334'), { costo: 180, fuente: 'sistema', nombre: 'ENVASE PET 500' });
  assert.deepStrictEqual(costoDe('m-etiqueta'), { costo: 60, fuente: 'insumoManual', nombre: 'Etiqueta' });
  assert.strictEqual(costoDe('999'), null);
  assert.strictEqual(costoDe('m-nada'), null);
  assert.deepStrictEqual(costoDe('6319'), { costo: null, fuente: 'sistema', nombre: 'GRANOLA 500G' });
});

// ── costeo compartido: selector, detalle y alertas coinciden ────────────────

test('costearTodos + filaSelector: costo/kg base, variantes, presentaciones y nombre SIGA de la presentación', () => {
  const c = costearTodos({ productos: DATOS.productos, costos: COSTOS, costeo: COSTEO, datos: DATOS });
  const f = filaSelector('p-granola', PRODUCTO, c['p-granola']);
  // (5×400 + 1×2800) / 10 = 480
  const { exportables: _e, ...resto } = f;
  assert.deepStrictEqual(resto, { id: 'p-granola', nombre: 'Granola', variantes: 2, presentaciones: 1, costoKgBase: 480, alertas: 0, faltantes: 0 });
  assert.strictEqual(c['p-granola'].presentaciones['6319'].nombre, 'GRANOLA 500G');
  // 0.5×480 + 180 + 60 = 480 → +50% = 720 neto + IVA 151,20 = 871,20 → $850 (redondeo a $50)
  assert.strictEqual(c['p-granola'].presentaciones['6319'].costoUnidad, 480);
  assert.strictEqual(c['p-granola'].presentaciones['6319'].precioConIva, 850);
});

test('alertas, selector y detalle salen del mismo costeo: validar y subir un insumo compartido', () => {
  const c0 = costearTodos({ productos: DATOS.productos, costos: COSTOS, costeo: COSTEO, datos: DATOS });
  const { producto: validado } = aplicarValidacion(PRODUCTO, c0['p-granola'], { tipo: 'todo' }, '2026-09-25');
  const datos = { ...DATOS, productos: { ...DATOS.productos, 'p-granola': validado } };
  const caro = new Map([...COSTOS, ['6334', fila('6334', 'ENVASE PET 500', 250)]]);
  const c1 = costearTodos({ productos: datos.productos, costos: caro, costeo: COSTEO, datos });
  const alertas = resumenAlertas(c1);
  const detalle = armarDetalle({ id: 'p-granola', datos, costeado: c1['p-granola'], costos: caro, vigentes: new Map(), toleranciaPct: 3 });
  const selector = filaSelector('p-granola', validado, c1['p-granola']);
  assert.strictEqual(alertas.total, 1);
  assert.deepStrictEqual(alertas.items.map(i => [i.productoId, i.tipo, i.id]), [['p-granola', 'presentacion', '6319']]);
  assert.strictEqual(detalle.resumen.alertas, alertas.total);
  assert.strictEqual(selector.alertas, alertas.total);
  assert.strictEqual(detalle.presentaciones['6319'].estado, 'cambio');
  assert.strictEqual(detalle.recetas.base.estado, 'ok');
});

test('armarDetalle: "también en", tipo inferido y vigente/Δ% por presentación', () => {
  const c = costearTodos({ productos: DATOS.productos, costos: COSTOS, costeo: COSTEO, datos: DATOS });
  const tiposPackaging = (nombre, rubro) => ({ esTapa: false, esEnvase: String(rubro).includes('ENVASE') });
  const d = armarDetalle({ id: 'p-granola', datos: DATOS, costeado: c['p-granola'], costos: COSTOS, vigentes: new Map([['6319', 1000]]), toleranciaPct: 3, tiposPackaging });
  const envase = d.insumos.find(i => i.clave === '6334');
  assert.strictEqual(envase.tipo, 'envase');
  assert.deepStrictEqual(envase.tambienEn, [{ id: 'p-yerba', nombre: 'Yerba' }]);
  assert.deepStrictEqual(envase.usadoEn, ['6319']); // presentaciones de este producto que lo usan
  // p-yerba no tiene lista propia (dato viejo): se deriva de sus presentaciones y cuenta para "también en".
  assert.deepStrictEqual(d.insumosManuales, [{ id: 'm-etiqueta', nombre: 'Etiqueta', costo: 60, tipo: 'etiqueta' }]);
  assert.strictEqual(d.insumos.find(i => i.clave === 'm-etiqueta').tipo, 'etiqueta');
  assert.strictEqual(d.presentaciones['6319'].precioVigente, 1000);
  assert.strictEqual(d.presentaciones['6319'].deltaPct, -15); // sugerido 850 vs vigente 1000
  assert.strictEqual(d.presentaciones['6319'].semaforo, 'bajar');
  // La UI precarga los editores con la definición guardada (rendimiento, cantidades, unidades).
  assert.strictEqual(d.definicion, DATOS.productos['p-granola']);
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

test('validarInsumosProducto: formato, manual inexistente, repetido y quitar uno en uso', () => {
  const ok = validarInsumosProducto({ insumos: [{ plu: 6334 }, { manualId: 'm-etiqueta', tipo: 'etiqueta' }] }, PRODUCTO, DATOS.insumosManuales);
  assert.deepStrictEqual(ok, [{ plu: '6334' }, { manualId: 'm-etiqueta', tipo: 'etiqueta' }]);
  const err = (body, re) => assert.throws(() => validarInsumosProducto(body, PRODUCTO, DATOS.insumosManuales), re);
  err({}, /insumos/);
  err({ insumos: [{ plu: "1' OR 1=1" }] }, /plu/);
  err({ insumos: [{ plu: '6334' }, { manualId: 'm-nada' }] }, /m-nada/);
  err({ insumos: [{ plu: '6334' }, { plu: '6334' }, { manualId: 'm-etiqueta' }] }, /repetido/);
  err({ insumos: [{ plu: '6334' }] }, /en uso.*m-etiqueta.*6319/); // quita m-etiqueta, usado por 6319
  err({ insumos: [{ plu: '6334', tipo: 'raro' }, { manualId: 'm-etiqueta' }] }, /tipo/);
});

test('validarInsumoManual / validarCategoriasMaquina / validarPedidoValidar', () => {
  assert.deepStrictEqual(validarInsumoManual({ nombre: ' Etiqueta ', costo: 60, tipo: 'etiqueta' }), { nombre: 'Etiqueta', costo: 60, tipo: 'etiqueta' });
  assert.throws(() => validarInsumoManual({ nombre: 'x', costo: 0 }), /costo/);
  assert.throws(() => validarInsumoManual({ nombre: 'x', costo: '60' }), /costo/);
  assert.deepStrictEqual(validarCategoriasMaquina({ categorias: [{ id: 'maq', nombre: 'Línea', costoHora: 5000 }] }), [{ id: 'maq', nombre: 'Línea', costoHora: 5000 }]);
  assert.throws(() => validarCategoriasMaquina({ categorias: [{ id: 'a', nombre: 'A', costoHora: 1 }, { id: 'a', nombre: 'B', costoHora: 1 }] }), /repetido/);
  assert.throws(() => validarCategoriasMaquina({ categorias: [{ id: '../x', nombre: 'A', costoHora: 1 }] }), /id/);
  assert.deepStrictEqual(validarPedidoValidar({ tipo: 'receta', id: 'base' }), { tipo: 'receta', id: 'base' });
  assert.deepStrictEqual(validarPedidoValidar({ tipo: 'todo' }), { tipo: 'todo' });
  assert.throws(() => validarPedidoValidar({ tipo: 'presentacion', id: 'abc' }), /id/);
  assert.throws(() => validarPedidoValidar({ tipo: 'otro' }), /tipo/);
});

test('aplicarValidacion: receta puntual, faltantes rechaza (puntual) u omite (todo), sin mutar', () => {
  const sinAzucar = new Map([...COSTOS].filter(([k]) => k !== '7067'));
  const c = costearTodos({ productos: DATOS.productos, costos: sinAzucar, costeo: COSTEO, datos: DATOS })['p-granola'];
  assert.throws(() => aplicarValidacion(PRODUCTO, c, { tipo: 'receta', id: 'base' }, 'f'), /faltantes/);
  assert.throws(() => aplicarValidacion(PRODUCTO, c, { tipo: 'receta', id: 'nada' }, 'f'), /no encontrada/);
  const r = aplicarValidacion(PRODUCTO, c, { tipo: 'todo' }, 'f');
  assert.deepStrictEqual(r.validados, []);
  assert.deepStrictEqual(r.omitidos.map(o => o.id), ['base', 'miel', 'clasica', '6319']);
  const ok = costearTodos({ productos: DATOS.productos, costos: COSTOS, costeo: COSTEO, datos: DATOS })['p-granola'];
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

function montar() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precios-prod-'));
  fs.writeFileSync(path.join(dir, 'costeo.json'), JSON.stringify(COSTEO));
  const sqls = [];
  const query = async (sql) => {
    sqls.push(sql);
    if (sql.includes('ProductosSucursalesPrecios')) return [{ IdProducto: '6319', Precio: 1000 }];
    if (sql.includes('HistorialPrecios')) return [{ IdProducto: '6319', Fecha: '2026-02-10' }];
    if (sql.includes('ProductosComponentes')) return /IdProducto = 8104\b/.test(sql) ? FORMULA_8104 : [];
    if (sql.includes('SELECT TOP 1 NombreProducto')) return /IdProducto = 8104\b/.test(sql) ? [{ nombre: 'PEPAS X KG' }] : [];
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

test('router: crear producto, receta, insumos, presentación, validar y alertas', async () => {
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

    await pedir('PUT', '/insumos-manuales/m-etiqueta', { nombre: 'Etiqueta', costo: 60 });
    const r = await pedir('PUT', '/productos/p-granola/recetas/base', PRODUCTO.recetas.base);
    await pedir('PUT', '/productos/p-granola/recetas/clasica', PRODUCTO.recetas.clasica);
    const sobreBase = { ...PRODUCTO.presentaciones['6319'], recetaId: 'base', insumos: [] };
    assert.match((await pedir('PUT', '/productos/p-granola/presentaciones/6319', sobreBase)).error, /elegí una variedad/i);
    assert.strictEqual(r.receta.rendimientoKg, 10);
    assert.match((await pedir('PUT', '/productos/p-granola/presentaciones/5555', PRODUCTO.presentaciones['6319'])).error, /no existe en SIGA/);
    // La presentación sólo elige insumos de la lista del producto (decisión 11).
    assert.match((await pedir('PUT', '/productos/p-granola/presentaciones/6319', PRODUCTO.presentaciones['6319'])).error, /insumos del producto/);
    assert.deepStrictEqual((await pedir('PUT', '/productos/p-granola/insumos', { insumos: PRODUCTO.insumos })).insumos, PRODUCTO.insumos);
    const pr = await pedir('PUT', '/productos/p-granola/presentaciones/6319', PRODUCTO.presentaciones['6319']);
    assert.strictEqual(pr.nombreSiga, 'GRANOLA 500G');
    assert.match((await pedir('PUT', '/productos/p-granola-2/presentaciones/6319', { recetaId: 'x', kgPorUnidad: 1 })).error, /recetaId|pertenece/);

    const v = await pedir('POST', '/productos/p-granola/validar', { tipo: 'todo' });
    assert.deepStrictEqual(v.validados.map(x => x.id), ['base', 'clasica', '6319']);
    // Editar la receta no re-valida: conserva el snapshot.
    const e = await pedir('PUT', '/productos/p-granola/recetas/base', { ...PRODUCTO.recetas.base, nombre: 'Base 2' });
    assert.strictEqual(e.receta.validado.costoKg, 480);

    // Vista previa: costea con el cambio en memoria, NO escribe el archivo, y valida igual que el PUT.
    const archivo = path.join(dir, 'recetas_produccion.json');
    const antes = fs.readFileSync(archivo, 'utf8');
    const pv = await pedir('POST', '/productos/p-granola/presentaciones/6319/preview', { ...PRODUCTO.presentaciones['6319'], kgPorUnidad: 1 });
    assert.strictEqual(pv.plu, '6319');
    assert.strictEqual(pv.costoUnidad, 720); // 1 kg × 480 + 180 + 60
    assert.ok(pv.precioConIva > 0);
    assert.strictEqual(pv.precioVigente, 1000);
    assert.strictEqual(pv.estado, 'ok'); // conserva el validado guardado (no queda 'sin-validar')
    assert.strictEqual(fs.readFileSync(archivo, 'utf8'), antes);
    const alta = await pedir('POST', '/productos/p-granola/presentaciones/preview', { recetaId: 'clasica', kgPorUnidad: 0.5, insumos: [] });
    assert.strictEqual(alta.plu, null);
    assert.strictEqual(alta.costoUnidad, 240);
    assert.match((await pedir('POST', '/productos/p-granola/presentaciones/6319/preview', { recetaId: 'clasica', kgPorUnidad: 0 })).error, /kgPorUnidad/);
    assert.match((await pedir('POST', '/productos/p-granola/presentaciones/6319/preview', { recetaId: 'clasica', kgPorUnidad: 1, insumos: [{ plu: '9999', cantidad: 1 }] })).error, /insumos del producto/);
    assert.strictEqual(fs.readFileSync(archivo, 'utf8'), antes);

    const det = await pedir('GET', '/productos/p-granola');
    assert.strictEqual(det.recetas.base.estado, 'ok');
    assert.deepStrictEqual(det.insumos.map(i => [i.clave, i.usadoEn]), [['6334', ['6319']], ['m-etiqueta', ['6319']]]);
    assert.match((await pedir('PUT', '/productos/p-granola/insumos', { insumos: [{ plu: '6334' }] })).error, /en uso/);
    assert.strictEqual(det.presentaciones['6319'].precioVigente, 1000);
    const alertas = await pedir('GET', '/alertas');
    assert.deepStrictEqual(alertas, { total: 0, items: [] });
    const lista = await pedir('GET', '/productos');
    assert.deepStrictEqual(lista.map(p => [p.id, p.costoKgBase]), [['p-granola', 480], ['p-granola-2', null]]);

    assert.match((await pedir('DELETE', '/insumos-manuales/m-etiqueta')).error, /lo usan/);
    await pedir('PUT', '/productos/p-granola/presentaciones/6319', { ...PRODUCTO.presentaciones['6319'], insumos: [{ plu: '6334', cantidad: 1 }] });
    assert.match((await pedir('DELETE', '/insumos-manuales/m-etiqueta')).error, /Granola/); // sigue en la lista del producto
    await pedir('PUT', '/productos/p-granola/insumos', { insumos: [{ plu: '6334' }] });
    assert.ok((await pedir('DELETE', '/insumos-manuales/m-etiqueta')).borrado); // ya nadie lo lista
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
    await pedir('PUT', '/insumos-manuales/m-etiqueta', { nombre: 'Etiqueta', costo: 60 });
    await pedir('PUT', '/productos/p-granola/recetas/base', PRODUCTO.recetas.base);
    await pedir('PUT', '/productos/p-granola/recetas/clasica', PRODUCTO.recetas.clasica);
    await pedir('PUT', '/productos/p-granola/insumos', { insumos: PRODUCTO.insumos });
    const pres = { ...PRODUCTO.presentaciones['6319'], nombre: 'Granola 500 nueva' };
    assert.match((await pedir('PUT', '/productos/p-granola/presentaciones/n-granola-500', PRODUCTO.presentaciones['6319'])).error, /nombre/);
    const alta = await pedir('PUT', '/productos/p-granola/presentaciones/n-granola-500', pres);
    assert.strictEqual(alta.plu, 'n-granola-500');
    assert.strictEqual(alta.nombreSiga, null); // no se consulta SIGA para una provisoria
    const det = await pedir('GET', '/productos/p-granola');
    const p = det.presentaciones['n-granola-500'];
    assert.strictEqual(p.costoUnidad, 480);
    assert.ok(p.precioConIva > 0);
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


test('armarDetalle: cada presentación trae packBulto sobre su precioConIva; sin packBultoDe queda []', () => {
  const costeado = costearTodos({ productos: { 'p-granola': PRODUCTO }, costos: COSTOS, costeo: COSTEO, datos: DATOS })['p-granola'];
  const base = { id: 'p-granola', datos: DATOS, costeado, costos: COSTOS, vigentes: new Map(), toleranciaPct: 3 };
  const precio = costeado.presentaciones['6319'].precioConIva;
  const det = armarDetalle({ ...base, packBultoDe: (plu, p) => [{ plu: `pb-${plu}`, base: p }] });
  assert.deepStrictEqual(det.presentaciones['6319'].packBulto, [{ plu: 'pb-6319', base: precio }]);
  assert.deepStrictEqual(armarDetalle(base).presentaciones['6319'].packBulto, []);
});

// ── Máquinas: usos de cada categoría y baja bloqueada si está en uso ─────────
test('categoriasConUsos / validarBajaCategorias: qué recetas usan cada categoría; no se quita una en uso', () => {
  const datos = normalizarDatos({
    productos: {
      'p-granola': { nombre: 'Granola', recetas: { base: { nombre: 'Base', categoriaMaquinaId: 'horno' }, miel: { nombre: 'Con miel', varianteDe: 'base', categoriaMaquinaId: 'horno' } } },
      'p-pepas': { nombre: 'Pepas', recetas: { base: { nombre: 'Masa' } } },
    },
    categoriasMaquina: [{ id: 'horno', nombre: 'Horno', costoHora: 5000 }, { id: 'mezcladora', nombre: 'Mezcladora', costoHora: 3000 }],
  });
  assert.deepStrictEqual(categoriasConUsos(datos), [
    { id: 'horno', nombre: 'Horno', costoHora: 5000, usos: [{ id: 'p-granola', nombre: 'Granola', recetas: ['Base', 'Con miel'] }] },
    { id: 'mezcladora', nombre: 'Mezcladora', costoHora: 3000, usos: [] },
  ]);
  // Editar y quitar una sin uso: ok. Quitar la que usa Granola: error con el producto y la receta.
  assert.doesNotThrow(() => validarBajaCategorias(datos, [{ id: 'horno', nombre: 'Horno 2', costoHora: 6000 }]));
  assert.throws(() => validarBajaCategorias(datos, [{ id: 'mezcladora', nombre: 'M', costoHora: 1 }]), /Horno.*Granola \(Base, Con miel\)/);
});

// ── Exportar desde Producción: presentaciones con PLU SIGA y su marca ─────────
test('filaSelector.exportables y armarDetalle.marcado: sólo PLUs SIGA, costo total y precio, marca de marcadosExportar', () => {
  const conProv = { ...PRODUCTO, presentaciones: { ...PRODUCTO.presentaciones, 'n-nueva': PRODUCTO.presentaciones['6319'] } };
  const datos = normalizarDatos({ ...DATOS, productos: { 'p-granola': conProv } });
  const c = costearTodos({ productos: datos.productos, costos: COSTOS, costeo: COSTEO, datos })['p-granola'];
  const marcados = { 6319: '2026-09-29' };
  const f = filaSelector('p-granola', conProv, c, marcados);
  assert.deepStrictEqual(f.exportables, [{ plu: '6319', nombre: 'GRANOLA 500G', costoTotal: 480, precioConIva: 850, faltantes: [], ivaPct: 21, marcado: true, fechaPrecio: null }]); // 720 + IVA → 850
  assert.deepStrictEqual(filaSelector('p-granola', conProv, c).exportables.map(p => p.marcado), [false]);
  const det = armarDetalle({ id: 'p-granola', datos, costeado: c, costos: COSTOS, vigentes: new Map(), toleranciaPct: 3, marcados });
  assert.strictEqual(det.presentaciones['6319'].marcado, true);
  assert.strictEqual(det.presentaciones['n-nueva'].marcado, false);
});

test('router: GET/PUT categorias-maquina con usos; baja en uso bloqueada; productos expone marcados', async () => {
  const { server, dir, base } = await montar();
  const pedir = async (metodo, url, body) => (await fetch(base + url, {
    method: metodo, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })).json();
  try {
    assert.deepStrictEqual(await pedir('GET', '/categorias-maquina'), { categoriasMaquina: [] });
    const put = await pedir('PUT', '/categorias-maquina', { categorias: [{ id: 'horno', nombre: 'Horno', costoHora: 5000 }] });
    assert.deepStrictEqual(put.categoriasMaquina, [{ id: 'horno', nombre: 'Horno', costoHora: 5000, usos: [] }]);
    await pedir('POST', '/productos', { nombre: 'Granola' });
    await pedir('PUT', '/productos/p-granola/recetas/base', { ...PRODUCTO.recetas.base, categoriaMaquinaId: 'horno', minutosElaboracion: 30 });
    const get = await pedir('GET', '/categorias-maquina');
    assert.deepStrictEqual(get.categoriasMaquina[0].usos, [{ id: 'p-granola', nombre: 'Granola', recetas: ['Base'] }]);
    assert.match((await pedir('PUT', '/categorias-maquina', { categorias: [] })).error, /Granola/);
    const costeo = JSON.parse(fs.readFileSync(path.join(dir, 'costeo.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'costeo.json'), JSON.stringify({ ...costeo, marcadosExportar: { 6319: '2026-09-29' } }));
    await pedir('PUT', '/productos/p-granola/recetas/clasica', PRODUCTO.recetas.clasica);
    await pedir('PUT', '/insumos-manuales/m-etiqueta', { nombre: 'Etiqueta', costo: 60 });
    await pedir('PUT', '/productos/p-granola/insumos', { insumos: PRODUCTO.insumos });
    await pedir('PUT', '/productos/p-granola/presentaciones/6319', PRODUCTO.presentaciones['6319']);
    const [fila] = await pedir('GET', '/productos');
    assert.deepStrictEqual(fila.exportables.map(p => [p.plu, p.marcado, p.fechaPrecio]), [['6319', true, '2026-02-10']]);
    const detalle = await pedir('GET', '/productos/p-granola');
    assert.strictEqual(detalle.presentaciones['6319'].marcado, true);
    assert.strictEqual(detalle.presentaciones['6319'].fechaPrecio, '2026-02-10');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fecha del último cambio de precio: filaSelector (exportables) y armarDetalle (presentaciones); null sin historial', () => {
  const c = costearTodos({ productos: DATOS.productos, costos: COSTOS, costeo: COSTEO, datos: DATOS });
  const fechas = new Map([['6319', '2026-02-10']]);
  assert.deepStrictEqual(filaSelector('p-granola', PRODUCTO, c['p-granola'], {}, fechas).exportables.map(e => [e.plu, e.fechaPrecio]), [['6319', '2026-02-10']]);
  assert.strictEqual(filaSelector('p-granola', PRODUCTO, c['p-granola']).exportables[0].fechaPrecio, null);
  const base = { id: 'p-granola', datos: DATOS, costeado: c['p-granola'], costos: COSTOS, vigentes: new Map(), toleranciaPct: 3, tiposPackaging: () => ({}) };
  assert.strictEqual(armarDetalle({ ...base, fechas }).presentaciones['6319'].fechaPrecio, '2026-02-10');
  assert.strictEqual(armarDetalle(base).presentaciones['6319'].fechaPrecio, null);
});
