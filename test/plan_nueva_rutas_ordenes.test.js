'use strict';
const test = require('node:test');
const assert = require('node:assert');
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
