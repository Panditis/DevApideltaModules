'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { montar, pedir, cerrar, nombresDe } = require('./plan_nueva_montar');

const SIGA = { 'FROM Productos WHERE': nombresDe({ 100: 'ALMENDRA 500G', 101: 'ALMENDRA 1KG', 200: 'NUEZ 250G' }) };
// 555 ya no existe en SIGA (dado de baja después de cargarlo).
const ALMENDRAS = { id: 'a', nombre: 'Almendras', plus: ['100', '555'], creado: '2026-10-01T00:00:00.000Z' };
const CON_ALMENDRAS = { 'plan_nueva_catalogo.json': { categorias: [ALMENDRAS] } };

test('POST /api/plan-nueva/catalogo: crea con nombres de SIGA y guarda sólo PLU', async () => {
  const ctx = await montar({ filasSql: SIGA });
  try {
    const r = await pedir(ctx.base, 'POST', '/api/plan-nueva/catalogo', { nombre: ' Nueces ', plus: ['200'] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.nombre, 'Nueces');
    assert.deepStrictEqual(r.data.presentaciones, [{ plu: '200', nombre: 'NUEZ 250G' }]);
    const [guardada] = ctx.leer('plan_nueva_catalogo.json').categorias;
    assert.deepStrictEqual(guardada, { id: r.data.id, nombre: 'Nueces', plus: ['200'], creado: r.data.creado });
  } finally { cerrar(ctx); }
});

test('POST: PLU inexistente en SIGA → 400 y no guarda nada', async () => {
  const ctx = await montar({ filasSql: SIGA });
  try {
    const r = await pedir(ctx.base, 'POST', '/api/plan-nueva/catalogo', { nombre: 'Nueces', plus: ['200', '999'] });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /999/);
    assert.strictEqual(ctx.leer('plan_nueva_catalogo.json'), null);
  } finally { cerrar(ctx); }
});

test('POST: nombre repetido (sin acentos/mayúsculas) → 409; PLU de otra categoría → 409', async () => {
  const ctx = await montar({ filasSql: SIGA, archivos: CON_ALMENDRAS });
  try {
    assert.strictEqual((await pedir(ctx.base, 'POST', '/api/plan-nueva/catalogo', { nombre: 'ALMENDRAS', plus: [] })).status, 409);
    const r = await pedir(ctx.base, 'POST', '/api/plan-nueva/catalogo', { nombre: 'Otra', plus: ['100'] });
    assert.strictEqual(r.status, 409);
    assert.match(r.data.error, /Almendras/);
  } finally { cerrar(ctx); }
});

test('GET: categorías con nombres de SIGA; PLU sin nombre → "PLU n"', async () => {
  const ctx = await montar({ filasSql: SIGA, archivos: CON_ALMENDRAS });
  try {
    const r = await pedir(ctx.base, 'GET', '/api/plan-nueva/catalogo');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.data.categorias[0].presentaciones, [{ plu: '100', nombre: 'ALMENDRA 500G' }, { plu: '555', nombre: 'PLU 555' }]);
    assert.deepStrictEqual(r.data.categorias[0].plus, ['100', '555']);
  } finally { cerrar(ctx); }
});

test('GET: si SIGA falla devuelve igual el catálogo, con "PLU n"', async () => {
  const ctx = await montar({ archivos: CON_ALMENDRAS, filasSql: { 'FROM Productos WHERE': () => { throw new Error('SIGA caído'); } } });
  try {
    const r = await pedir(ctx.base, 'GET', '/api/plan-nueva/catalogo');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.categorias[0].presentaciones[0].nombre, 'PLU 100');
  } finally { cerrar(ctx); }
});

test('POST y PUT con SIGA caído → 503 genérico y no guardan', async () => {
  const caido = { 'FROM Productos WHERE': () => { throw new Error('Login failed for user sa'); } };
  const ctx = await montar({ filasSql: caido, archivos: CON_ALMENDRAS });
  try {
    const post = await pedir(ctx.base, 'POST', '/api/plan-nueva/catalogo', { nombre: 'Nueces', plus: ['200'] });
    assert.strictEqual(post.status, 503);
    assert.deepStrictEqual(post.data, { error: 'SIGA no disponible' });
    const put = await pedir(ctx.base, 'PUT', '/api/plan-nueva/catalogo/a', { nombre: 'Almendras', plus: ['100', '101'] });
    assert.strictEqual(put.status, 503);
    assert.deepStrictEqual(put.data, { error: 'SIGA no disponible' });
    assert.deepStrictEqual(ctx.leer('plan_nueva_catalogo.json').categorias, [ALMENDRAS]);
  } finally { cerrar(ctx); }
});

test('PUT: renombra y agrega; sólo exige en SIGA los PLU nuevos (555 ya estaba)', async () => {
  const ctx = await montar({ filasSql: SIGA, archivos: CON_ALMENDRAS });
  try {
    const r = await pedir(ctx.base, 'PUT', '/api/plan-nueva/catalogo/a', { nombre: 'Almendras peladas', plus: ['100', '555', '101'] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.nombre, 'Almendras peladas');
    assert.deepStrictEqual(r.data.presentaciones.map(p => p.nombre), ['ALMENDRA 500G', 'PLU 555', 'ALMENDRA 1KG']);
    assert.deepStrictEqual(ctx.leer('plan_nueva_catalogo.json').categorias[0].plus, ['100', '555', '101']);
    const mal = await pedir(ctx.base, 'PUT', '/api/plan-nueva/catalogo/a', { nombre: 'Almendras', plus: ['100', '998'] });
    assert.strictEqual(mal.status, 400);
    assert.match(mal.data.error, /998/);
  } finally { cerrar(ctx); }
});

test('PUT y DELETE de una categoría inexistente → 404; DELETE borra', async () => {
  const ctx = await montar({ filasSql: SIGA, archivos: CON_ALMENDRAS });
  try {
    assert.strictEqual((await pedir(ctx.base, 'PUT', '/api/plan-nueva/catalogo/zz', { nombre: 'X', plus: [] })).status, 404);
    assert.strictEqual((await pedir(ctx.base, 'DELETE', '/api/plan-nueva/catalogo/zz')).status, 404);
    const r = await pedir(ctx.base, 'DELETE', '/api/plan-nueva/catalogo/a');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(ctx.leer('plan_nueva_catalogo.json').categorias, []);
  } finally { cerrar(ctx); }
});
