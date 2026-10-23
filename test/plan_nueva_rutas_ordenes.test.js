'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { montar, pedir, cerrar } = require('./plan_nueva_montar');

const ARCH = {
  'plan_nueva_catalogo.json': { categorias: [{ id: 'a', nombre: 'Almendras', plus: ['100', '101'], creado: 'x' }] },
  'responsables.json': [{ nombre: 'Ana', corto: 'ANA' }],
};
const linea = (x = {}) => ({ plu: '100', nombre: 'ALMENDRA 500G', cantidad: 12, responsables: ['Ana'], notas: 'tostar', ...x });
const BODY = { fecha: '2026-10-22', notas: 'para el lunes', lineas: [linea()] };

test('POST /api/plan-nueva/ordenes: crea #1 con el usuario de la sesión; GET lista la más nueva primero', async () => {
  const ctx = await montar({ archivos: ARCH, usuario: 'adriel' });
  try {
    const r1 = await pedir(ctx.base, 'POST', '/api/plan-nueva/ordenes', BODY);
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r1.data.numero, 1);
    assert.strictEqual(r1.data.usuario, 'adriel');
    assert.strictEqual(r1.data.estado, 'activa');
    assert.strictEqual(r1.data.notas, 'para el lunes');
    assert.deepStrictEqual(r1.data.lineas, [{ plu: '100', nombre: 'ALMENDRA 500G', categoria: 'Almendras', cantidad: 12, responsables: ['Ana'], notas: 'tostar' }]);
    const r2 = await pedir(ctx.base, 'POST', '/api/plan-nueva/ordenes', { ...BODY, lineas: [linea({ plu: '101', nombre: 'ALMENDRA 1KG' })] });
    assert.strictEqual(r2.data.numero, 2);
    const lista = await pedir(ctx.base, 'GET', '/api/plan-nueva/ordenes');
    assert.deepStrictEqual(lista.data.map(o => o.numero), [2, 1]);
    assert.strictEqual(ctx.leer('plan_nueva_ordenes.json').ordenes.length, 2);
  } finally { cerrar(ctx); }
});

test('POST ordenes: inválida → 400 con mensaje y no guarda', async () => {
  const ctx = await montar({ archivos: ARCH });
  try {
    const r = await pedir(ctx.base, 'POST', '/api/plan-nueva/ordenes', { ...BODY, lineas: [linea({ cantidad: 0 })] });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /cantidad/);
    assert.strictEqual(ctx.leer('plan_nueva_ordenes.json'), null);
  } finally { cerrar(ctx); }
});

test('POST ordenes sin sesión → usuario "anonimo"; GET sin archivo → []', async () => {
  const ctx = await montar({ archivos: ARCH });
  try {
    assert.deepStrictEqual((await pedir(ctx.base, 'GET', '/api/plan-nueva/ordenes')).data, []);
    assert.strictEqual((await pedir(ctx.base, 'POST', '/api/plan-nueva/ordenes', BODY)).data.usuario, 'anonimo');
  } finally { cerrar(ctx); }
});

// ── Archivo de órdenes: nunca se pisa si no se pudo leer; escritura atómica ──────────────────────
const TRUNCADO = '{"ordenes":[{"id":"o1","numero":1,"lin';

test('órdenes: archivo corrupto → 500 en GET y POST y el archivo queda intacto', async () => {
  const ctx = await montar({ archivos: ARCH });
  const archivo = path.join(ctx.dir, 'plan_nueva_ordenes.json');
  fs.writeFileSync(archivo, TRUNCADO);
  try {
    for (const [metodo, body] of [['GET'], ['POST', BODY]]) {
      const r = await pedir(ctx.base, metodo, '/api/plan-nueva/ordenes', body);
      assert.strictEqual(r.status, 500);
      assert.match(r.data.error, /^No se pudo leer plan_nueva_ordenes\.json: /);
    }
    assert.strictEqual(fs.readFileSync(archivo, 'utf8'), TRUNCADO);
  } finally { cerrar(ctx); }
});

test('órdenes: JSON válido pero sin la lista "ordenes" también es 500 (no se interpreta como vacío)', async () => {
  const ctx = await montar({ archivos: ARCH });
  const archivo = path.join(ctx.dir, 'plan_nueva_ordenes.json');
  fs.writeFileSync(archivo, '{"otra":1}');
  try {
    assert.strictEqual((await pedir(ctx.base, 'POST', '/api/plan-nueva/ordenes', BODY)).status, 500);
    assert.strictEqual(fs.readFileSync(archivo, 'utf8'), '{"otra":1}');
  } finally { cerrar(ctx); }
});

test('órdenes: escritura normal deja JSON válido y ningún archivo temporal', async () => {
  const ctx = await montar({ archivos: ARCH });
  try {
    await pedir(ctx.base, 'POST', '/api/plan-nueva/ordenes', BODY);
    await pedir(ctx.base, 'POST', '/api/plan-nueva/ordenes', BODY);
    assert.strictEqual(ctx.leer('plan_nueva_ordenes.json').ordenes.length, 2);
    assert.deepStrictEqual(fs.readdirSync(ctx.dir).filter(f => f.includes('.tmp')), []);
  } finally { cerrar(ctx); }
});

test('PUT /api/plan-nueva/ordenes/:id/anular: anula sin borrar; repetir → 409; inexistente → 404', async () => {
  const ctx = await montar({ archivos: ARCH });
  try {
    const { data: creada } = await pedir(ctx.base, 'POST', '/api/plan-nueva/ordenes', BODY);
    const r = await pedir(ctx.base, 'PUT', `/api/plan-nueva/ordenes/${creada.id}/anular`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.estado, 'anulada');
    const [guardada] = ctx.leer('plan_nueva_ordenes.json').ordenes;
    assert.strictEqual(guardada.estado, 'anulada');
    assert.strictEqual(guardada.lineas.length, 1);
    assert.strictEqual((await pedir(ctx.base, 'PUT', `/api/plan-nueva/ordenes/${creada.id}/anular`)).status, 409);
    assert.strictEqual((await pedir(ctx.base, 'PUT', '/api/plan-nueva/ordenes/zz/anular')).status, 404);
  } finally { cerrar(ctx); }
});

test('PUT anular con el archivo de órdenes corrupto → 500 y no lo toca', async () => {
  const ctx = await montar({ archivos: ARCH });
  const archivo = path.join(ctx.dir, 'plan_nueva_ordenes.json');
  fs.writeFileSync(archivo, TRUNCADO);
  try {
    assert.strictEqual((await pedir(ctx.base, 'PUT', '/api/plan-nueva/ordenes/o1/anular')).status, 500);
    assert.strictEqual(fs.readFileSync(archivo, 'utf8'), TRUNCADO);
  } finally { cerrar(ctx); }
});
