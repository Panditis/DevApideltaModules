'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { montar, pedir, cerrar, nombresDe } = require('./plan_nueva_montar');

const CATALOGO = { 'plan_nueva_catalogo.json': { categorias: [{ id: 'a', nombre: 'Almendras', plus: ['100', '101'], creado: 'x' }] } };

test('GET /api/plan-nueva/tablero: ventas de sucursales ÷ N, stock central y params guardados', async () => {
  const ctx = await montar({
    archivos: { ...CATALOGO, 'plan_nueva_params.json': { diasConsumo: 90, diasCubrir: 10 } },
    filasSql: {
      UnidVendidas: [{ IdProducto: '100 ', UnidVendidas: 180 }],
      STOCKCENTRAL: [{ IdProducto: '100', StockActual: 5 }],
      'FROM Productos WHERE': nombresDe({ 100: 'ALMENDRA 500G', 101: 'ALMENDRA 1KG' }),
    },
  });
  try {
    const r = await pedir(ctx.base, 'GET', '/api/plan-nueva/tablero');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.data.params, { diasConsumo: 90, diasCubrir: 10 });
    const [almendras] = r.data.categorias;
    // 180 ÷ 90 = 2/día → 60/mes; 2 × 10 − 5 = 15
    assert.deepStrictEqual(almendras.presentaciones, [
      { plu: '100', nombre: 'ALMENDRA 500G', consumoDia: 2, consumoMes: 60, stockCentral: 5, sugerido: 15 },
      { plu: '101', nombre: 'ALMENDRA 1KG', consumoDia: 0, consumoMes: 0, stockCentral: null, sugerido: 0 },
    ]);
    // El SQL de ventas es el probado de lib/plan_sql.js: ventana N, sin sucursales no reales y sin Casa Central.
    const ventasSql = ctx.sqls.find(s => s.includes('UnidVendidas'));
    assert.match(ventasSql, /DATEADD\(DAY,-90,/);
    assert.match(ventasSql, /NOT IN \(6,8,11\)/);
    assert.match(ventasSql, /SoyLaCentral=1/);
    assert.ok(ctx.sqls.some(s => s === 'STOCKCENTRAL 100,101'));
  } finally { cerrar(ctx); }
});

test('GET tablero: sin categorías → vacío, params default y sin consultar SIGA', async () => {
  const ctx = await montar();
  try {
    const r = await pedir(ctx.base, 'GET', '/api/plan-nueva/tablero');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.data, { params: { diasConsumo: 120, diasCubrir: 30 }, categorias: [] });
    assert.strictEqual(ctx.sqls.length, 0);
  } finally { cerrar(ctx); }
});

test('GET tablero: si SIGA falla → 503 genérico, sin el detalle del driver', async () => {
  const ctx = await montar({ archivos: CATALOGO, filasSql: { UnidVendidas: () => { throw new Error('timeout SIGA'); } } });
  try {
    const r = await pedir(ctx.base, 'GET', '/api/plan-nueva/tablero');
    assert.strictEqual(r.status, 503);
    assert.deepStrictEqual(r.data, { error: 'SIGA no disponible' });
  } finally { cerrar(ctx); }
});

test('GET/PUT /api/plan-nueva/params: defaults, guarda válidos y rechaza fuera de rango sin tocar el archivo', async () => {
  const ctx = await montar();
  try {
    assert.deepStrictEqual((await pedir(ctx.base, 'GET', '/api/plan-nueva/params')).data, { diasConsumo: 120, diasCubrir: 30 });
    const ok = await pedir(ctx.base, 'PUT', '/api/plan-nueva/params', { diasConsumo: 60, diasCubrir: 15 });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ctx.leer('plan_nueva_params.json'), { diasConsumo: 60, diasCubrir: 15 });
    const mal = await pedir(ctx.base, 'PUT', '/api/plan-nueva/params', { diasConsumo: 400, diasCubrir: 15 });
    assert.strictEqual(mal.status, 400);
    assert.deepStrictEqual(ctx.leer('plan_nueva_params.json'), { diasConsumo: 60, diasCubrir: 15 });
    assert.deepStrictEqual((await pedir(ctx.base, 'GET', '/api/plan-nueva/params')).data, { diasConsumo: 60, diasCubrir: 15 });
  } finally { cerrar(ctx); }
});

test('GET /api/plan-nueva/responsables: nombres de data/responsables.json', async () => {
  const ctx = await montar({ archivos: { 'responsables.json': [{ nombre: 'Ana', corto: 'ANA' }, { nombre: 'Beto', corto: 'BETO' }] } });
  try {
    assert.deepStrictEqual((await pedir(ctx.base, 'GET', '/api/plan-nueva/responsables')).data, ['Ana', 'Beto']);
  } finally { cerrar(ctx); }
});
