'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

// Router real de planificación sobre Express, con DATA_DIR temporal y sin SQL: sólo se ejercitan
// POST /envio, PUT /notas y DELETE /item (anular). server.js no se toca.
function montar() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-envio-'));
  const leerJSON = (p, def) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : def);
  const guardarJSON = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2));
  const PLANES_PATH = path.join(dir, 'planes.json');
  const ORDENES_PATH = path.join(dir, 'ordenes.json');
  const PROD_REG_PATH = path.join(dir, 'produccion_registros.json');
  const GRUPOS_CFG_PATH = path.join(dir, 'grupos_config.json');
  guardarJSON(GRUPOS_CFG_PATH, { 'Miel Granel': { activo: true, granelPlu: '900' }, Miel: { activo: true, reqGranel: true } });
  const leerPlanReservas = fecha => { const planes = leerJSON(PLANES_PATH, {}); return { planes, plan: planes[fecha] || null }; };
  const app = express();
  app.use(express.json());
  app.use(require('../routes/rutas_plan')({
    apiRoute: fn => async (req, res) => res.json(await fn(req)), leerJSON, guardarJSON, query: async () => [], DATA_DIR: dir,
    PLANES_PATH, PROD_REG_PATH, GRUPOS_CFG_PATH, CATALOGO_PATH: path.join(dir, 'catalogo.json'),
    safeDate: v => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '2026-01-01'),
    leerPlanReservas, leerOrdenes: () => leerJSON(ORDENES_PATH, []), guardarOrdenes: a => guardarJSON(ORDENES_PATH, a),
    cfgGranelPlu: (cfg, ref) => { const v = cfg[ref]; return v && typeof v === 'object' ? String(v.granelPlu || '') : ''; },
  }));
  return new Promise(ok => {
    const server = app.listen(0, () => ok({
      server, dir, base: `http://127.0.0.1:${server.address().port}/api/plan`,
      planes: () => leerJSON(PLANES_PATH, {}), ordenes: () => leerJSON(ORDENES_PATH, []),
      guardarOrdenes: a => guardarJSON(ORDENES_PATH, a),
    }));
  });
}

async function pedir(base, metodo, url, body) {
  const r = await fetch(base + url, {
    method: metodo, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json() };
}

function cerrar({ server, dir }) {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

const F = '2026-10-21';
const granel = { esGranel: true, producto: 'Miel Granel', idProducto: 900, cantConfirmada: 50, semaforo: 'RED' };
const fracc = { producto: 'Miel 500g', presentacion: 'Miel 500g', rubro: 'Miel', idProducto: 101, cantConfirmada: 40 };
const fracc2 = { producto: 'Miel 1kg', presentacion: 'Miel 1kg', rubro: 'Miel', idProducto: 102, cantConfirmada: 10 };

test('POST /envio: valida el cuerpo y no escribe nada si es inválido', async () => {
  const ctx = await montar();
  try {
    assert.strictEqual((await pedir(ctx.base, 'POST', `/${F}/envio`, { items: [] })).status, 400);
    assert.strictEqual((await pedir(ctx.base, 'POST', `/${F}/envio`, { items: [{ ...granel, cantConfirmada: 0 }] })).status, 400);
    assert.strictEqual((await pedir(ctx.base, 'POST', `/${F}/envio`, { items: [granel], notas: 5 })).status, 400);
    assert.deepStrictEqual(ctx.planes(), {});
    assert.deepStrictEqual(ctx.ordenes(), []);
  } finally { cerrar(ctx); }
});

test('POST /envio: crea plan y órdenes; un segundo envío fusiona el ítem y suma notas', async () => {
  const ctx = await montar();
  try {
    const r1 = await pedir(ctx.base, 'POST', `/${F}/envio`, { items: [granel, fracc], notas: 'urgente' });
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r1.data.nuevas, 2);
    const ords = ctx.ordenes();
    assert.strictEqual(ords.length, 2);
    // código del granel resuelto desde grupos_config; el rubro con reqGranel marca granelAparte
    assert.strictEqual(ords.find(o => o.producto === 'Miel Granel').codigo, '900');
    assert.strictEqual(ords.find(o => o.producto === 'Miel').granelAparte, true);

    const r2 = await pedir(ctx.base, 'POST', `/${F}/envio`, { items: [{ ...granel, cantConfirmada: 20 }], notas: 'otra' });
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(r2.data.actualizadas, 1);
    const plan = ctx.planes()[F];
    const it = plan.items.find(i => i.producto === 'Miel Granel');
    assert.strictEqual(it.cantConfirmada, 70);
    assert.strictEqual(it.envios.length, 2);
    assert.strictEqual(plan.notas, 'urgente\notra');
    assert.strictEqual(ctx.ordenes().length, 2);
    assert.strictEqual(ctx.ordenes().find(o => o.producto === 'Miel Granel').cantidad, 70);
  } finally { cerrar(ctx); }
});

test('POST /envio: orden protegida se omite; si todo está protegido responde 409', async () => {
  const ctx = await montar();
  try {
    await pedir(ctx.base, 'POST', `/${F}/envio`, { items: [granel, fracc] });
    ctx.guardarOrdenes(ctx.ordenes().map(o => (o.producto === 'Miel Granel' ? { ...o, estado: 'listo' } : o)));
    const r = await pedir(ctx.base, 'POST', `/${F}/envio`, { items: [granel, fracc2] });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.data.omitidos, ['Miel Granel']);
    assert.strictEqual(ctx.planes()[F].items.find(i => i.producto === 'Miel Granel').cantConfirmada, 50);
    const r409 = await pedir(ctx.base, 'POST', `/${F}/envio`, { items: [granel] });
    assert.strictEqual(r409.status, 409);
  } finally { cerrar(ctx); }
});

test('PUT /notas: pisa las notas del día, incluso con vacío', async () => {
  const ctx = await montar();
  try {
    assert.strictEqual((await pedir(ctx.base, 'PUT', `/${F}/notas`, { notas: 7 })).status, 400);
    assert.strictEqual((await pedir(ctx.base, 'PUT', `/${F}/notas`, { notas: 'hola' })).status, 200);
    assert.strictEqual(ctx.planes()[F].notas, 'hola');
    await pedir(ctx.base, 'PUT', `/${F}/notas`, { notas: '' });
    assert.strictEqual(ctx.planes()[F].notas, '');
  } finally { cerrar(ctx); }
});

test('DELETE /item: anular regenera la orden y la borra con la última presentación', async () => {
  const ctx = await montar();
  try {
    assert.strictEqual((await pedir(ctx.base, 'DELETE', `/${F}/item/1`)).status, 404);
    await pedir(ctx.base, 'POST', `/${F}/envio`, { items: [granel, fracc, fracc2] });
    const plan = ctx.planes()[F];
    assert.strictEqual((await pedir(ctx.base, 'DELETE', `/${F}/item/999`)).status, 404);

    const id1 = plan.items.find(i => i.producto === 'Miel 500g').id;
    assert.strictEqual((await pedir(ctx.base, 'DELETE', `/${F}/item/${id1}`)).status, 200);
    const miel = ctx.ordenes().find(o => o.producto === 'Miel');
    assert.deepStrictEqual(miel.presentaciones.map(p => p.plu), ['102']);

    const id2 = plan.items.find(i => i.producto === 'Miel 1kg').id;
    await pedir(ctx.base, 'DELETE', `/${F}/item/${id2}`);
    assert.deepStrictEqual(ctx.ordenes().map(o => o.producto), ['Miel Granel']);
    assert.strictEqual(ctx.planes()[F].items.length, 1);
  } finally { cerrar(ctx); }
});

test('DELETE /item: 409 si producción ya empezó la orden o el ítem ya se recepcionó', async () => {
  const ctx = await montar();
  try {
    await pedir(ctx.base, 'POST', `/${F}/envio`, { items: [granel, fracc] });
    const plan = ctx.planes()[F];
    const idGranel = plan.items.find(i => i.producto === 'Miel Granel').id;
    ctx.guardarOrdenes(ctx.ordenes().map(o => (o.producto === 'Miel Granel' ? { ...o, terminado: true } : o)));
    assert.strictEqual((await pedir(ctx.base, 'DELETE', `/${F}/item/${idGranel}`)).status, 409);

    const planes = ctx.planes();
    const idFracc = planes[F].items.find(i => i.producto === 'Miel 500g').id;
    planes[F].items = planes[F].items.map(i => (i.id === idFracc ? { ...i, produccionMovimiento: { numeroMovimiento: 55 } } : i));
    fs.writeFileSync(path.join(ctx.dir, 'planes.json'), JSON.stringify(planes));
    const r = await pedir(ctx.base, 'DELETE', `/${F}/item/${idFracc}`);
    assert.strictEqual(r.status, 409);
    assert.match(r.data.error, /#55/);
  } finally { cerrar(ctx); }
});

// Mismo PLU que el fracc ya enviado, pero el carrito lo manda sin rubro: el ítem del plan conserva
// su rubro 'Miel', así que la orden afectada es la de 'Miel', no una 'Miel 500g' inexistente.
const fraccSinRubro = { producto: 'Miel 500g', presentacion: 'Miel 500g', idProducto: 101, cantConfirmada: 10 };

test('POST /envio: mismo PLU sin rubro actualiza la orden del rubro del plan', async () => {
  const ctx = await montar();
  try {
    await pedir(ctx.base, 'POST', `/${F}/envio`, { items: [fracc] });
    const r = await pedir(ctx.base, 'POST', `/${F}/envio`, { items: [fraccSinRubro] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.actualizadas, 1);
    assert.strictEqual(ctx.planes()[F].items[0].cantConfirmada, 50);
    const ords = ctx.ordenes();
    assert.deepStrictEqual(ords.map(o => o.producto), ['Miel']);
    assert.strictEqual(ords[0].cantidad, 50);
  } finally { cerrar(ctx); }
});

test('POST /envio: mismo PLU sin rubro no esquiva la protección de la orden del rubro', async () => {
  const ctx = await montar();
  try {
    await pedir(ctx.base, 'POST', `/${F}/envio`, { items: [fracc] });
    ctx.guardarOrdenes(ctx.ordenes().map(o => ({ ...o, estado: 'listo' })));
    const r = await pedir(ctx.base, 'POST', `/${F}/envio`, { items: [fraccSinRubro] });
    assert.strictEqual(r.status, 409);
    assert.deepStrictEqual(r.data.omitidos, ['Miel 500g']);
    assert.strictEqual(ctx.planes()[F].items[0].cantConfirmada, 40);
    assert.strictEqual(ctx.ordenes()[0].cantidad, 40);
  } finally { cerrar(ctx); }
});

test('DELETE /item: anular no crea una orden que no existía', async () => {
  const ctx = await montar();
  try {
    await pedir(ctx.base, 'POST', `/${F}/envio`, { items: [granel, fracc, fracc2] });
    ctx.guardarOrdenes(ctx.ordenes().filter(o => o.producto !== 'Miel')); // la orden del rubro se borró a mano
    const id1 = ctx.planes()[F].items.find(i => i.producto === 'Miel 500g').id;
    assert.strictEqual((await pedir(ctx.base, 'DELETE', `/${F}/item/${id1}`)).status, 200);
    assert.deepStrictEqual(ctx.ordenes().map(o => o.producto), ['Miel Granel']);
    assert.deepStrictEqual(ctx.planes()[F].items.map(i => i.producto).sort(), ['Miel 1kg', 'Miel Granel']);
  } finally { cerrar(ctx); }
});

test('DELETE /item: un error al leer el plan responde 500 en JSON', async () => {
  const ctx = await montar();
  try {
    fs.writeFileSync(path.join(ctx.dir, 'planes.json'), '{roto');
    const r = await pedir(ctx.base, 'DELETE', `/${F}/item/1`);
    assert.strictEqual(r.status, 500);
    assert.ok(r.data.error);
  } finally { cerrar(ctx); }
});
