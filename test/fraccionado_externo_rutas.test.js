'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

// Router real sobre Express, con DATA_DIR temporal y sin SQL (query falsa): sólo se ejercitan las
// rutas de tareas y de pedidos.
function montar() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-tareas-'));
  const leerJSON = (p, def) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : def);
  const guardarJSON = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2));
  const apiRoute = fn => async (req, res) => {
    try { res.json(await fn(req)); } catch (err) { res.status(500).json({ error: err.message }); }
  };
  const pedidosPath = path.join(dir, 'pedidos.json');
  const app = express();
  app.use(express.json());
  app.use(require('../routes/rutas_fraccionado_externo')({
    apiRoute, leerJSON, guardarJSON, query: async () => [], DATA_DIR: dir,
    FRAC_REG_PATH: path.join(dir, 'frac.json'), HISTORIAL_PATH: path.join(dir, 'hist.json'),
    leerPedidosFraccionadoExterno: () => leerJSON(pedidosPath, { pedidos: [] }).pedidos,
    guardarPedidosFraccionadoExterno: lista => guardarJSON(pedidosPath, { pedidos: lista }),
  }));
  return new Promise(ok => {
    const server = app.listen(0, () => ok({
      server, dir, base: `http://127.0.0.1:${server.address().port}/api/fraccionado-externo`,
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

test('ABM de tareas: alta, listado, edición, borrado y validaciones', async () => {
  const ctx = await montar();
  const { base } = ctx;
  try {
    assert.deepStrictEqual((await pedir(base, 'GET', '/tareas')).data, { tareas: [] });

    const alta = await pedir(base, 'POST', '/tareas', { nombre: ' Etiquetado ', monto: 25 });
    assert.strictEqual(alta.status, 200);
    assert.deepStrictEqual(alta.data.tarea, { id: 'T1', nombre: 'Etiquetado', monto: 25 });
    assert.strictEqual((await pedir(base, 'POST', '/tareas', { nombre: 'Reempaque', monto: 10 })).data.tarea.id, 'T2');

    const repetida = await pedir(base, 'POST', '/tareas', { nombre: 'etiquetado', monto: 1 });
    assert.strictEqual(repetida.status, 400);
    assert.match(repetida.data.error, /Ya existe/);
    assert.strictEqual((await pedir(base, 'POST', '/tareas', { nombre: 'X', monto: 0 })).status, 400);

    const edit = await pedir(base, 'PUT', '/tareas/T1', { nombre: 'Etiquetado', monto: 30 });
    assert.strictEqual(edit.status, 200);
    assert.deepStrictEqual(edit.data.tarea, { id: 'T1', nombre: 'Etiquetado', monto: 30 });
    assert.strictEqual((await pedir(base, 'PUT', '/tareas/T9', { nombre: 'Z', monto: 5 })).status, 404);
    assert.strictEqual((await pedir(base, 'PUT', '/tareas/T2', { nombre: 'etiquetado', monto: 5 })).status, 400);
    assert.deepStrictEqual((await pedir(base, 'GET', '/tareas')).data.tareas[1], { id: 'T2', nombre: 'Reempaque', monto: 10 }); // un PUT rechazado no altera lo guardado

    assert.strictEqual((await pedir(base, 'DELETE', '/tareas/T2')).status, 200);
    assert.strictEqual((await pedir(base, 'DELETE', '/tareas/T2')).status, 404);
    assert.deepStrictEqual((await pedir(base, 'GET', '/tareas')).data.tareas, [{ id: 'T1', nombre: 'Etiquetado', monto: 30 }]);
  } finally { cerrar(ctx); }
});

test('POST pedidos: resuelve tareas desde el archivo, suma al total y guarda una copia', async () => {
  const ctx = await montar();
  const { base } = ctx;
  try {
    await pedir(base, 'POST', '/tareas', { nombre: 'Etiquetado', monto: 25 });
    const producto = {
      plu: '1101', nombre: 'Oregano 50G', presentacion: '50G',
      nivelTiempo: 'normal', nivelComplejidad: 'facil', kilos: 1, paquetes: 20,
    };
    const tarea = { tipo: 'tarea', tareaId: 'T1', cantidad: 40, nombre: 'hack', montoUnitario: 1, costoTotal: 1 };
    const { status, data } = await pedir(base, 'POST', '/pedidos', { tercero: 'Sur', valorHora: 6000, items: [producto, tarea] });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.pedido.items[1].nombre, 'Etiquetado'); // del archivo, no del cliente
    assert.strictEqual(data.pedido.items[1].montoUnitario, 25);
    assert.strictEqual(data.pedido.items[1].costoTotal, 1000);
    assert.strictEqual(data.pedido.total, 2000); // producto: 6000/60 × 0.5 × 20 = 1000

    // Editar y borrar la tarea no toca el pedido ya generado.
    await pedir(base, 'PUT', '/tareas/T1', { nombre: 'Otro', monto: 99 });
    await pedir(base, 'DELETE', '/tareas/T1');
    const guardado = (await pedir(base, 'GET', '/pedidos')).data.pedidos[0];
    assert.strictEqual(guardado.items[1].nombre, 'Etiquetado');
    assert.strictEqual(guardado.total, 2000);
  } finally { cerrar(ctx); }
});

test('POST pedidos: tarea inexistente o cantidad inválida devuelven 400 y no guardan nada', async () => {
  const ctx = await montar();
  const { base } = ctx;
  try {
    await pedir(base, 'POST', '/tareas', { nombre: 'Etiquetado', monto: 25 });
    const cabecera = { tercero: 'Sur', valorHora: 6000 };
    const inexistente = await pedir(base, 'POST', '/pedidos', { ...cabecera, items: [{ tipo: 'tarea', tareaId: 'T9', cantidad: 1 }] });
    assert.strictEqual(inexistente.status, 400);
    assert.match(inexistente.data.error, /tareaId/);
    const sinCantidad = await pedir(base, 'POST', '/pedidos', { ...cabecera, items: [{ tipo: 'tarea', tareaId: 'T1', cantidad: 0 }] });
    assert.strictEqual(sinCantidad.status, 400);
    assert.match(sinCantidad.data.error, /cantidad/);
    assert.deepStrictEqual((await pedir(base, 'GET', '/pedidos')).data.pedidos, []);
  } finally { cerrar(ctx); }
});
