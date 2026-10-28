'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

// Regresión del fix 11e4fd8 en /api/plan/sugerencias (calcularSugerencias, el del buscador del plan
// del día y de pedidos_web): sin pendientes de pedidos. Antes un pendiente forzaba sugerir aunque el
// stock alcanzara y se sumaba a la cantidad. calcularSugerencias lee el config.json real del worktree
// (solo minDiasParaSugerir / incidenciaStockPlanif / rubros), así que las cuentas salen de ahí.
const CONFIG_REAL = path.join(__dirname, '..', 'config.json');

function montar() {
  const sqls = [];
  const query = async sql => {
    sqls.push(sql);
    if (sql === 'TERMINADOS') return [
      { IdProducto: 1, NombreProducto: 'Con stock', NombreRubro: 'R', StockActual: 1000 },
      { IdProducto: 2, NombreProducto: 'Sin stock', NombreRubro: 'R', StockActual: 0 },
    ];
    if (/PromDiario/.test(sql)) return [{ IdProducto: 1, PromDiario: 1 }, { IdProducto: 2, PromDiario: 2 }];
    // Si volviera la consulta de pendientes, devolvería 50 por PLU.
    if (/PedidosProductos|CantPendiente/.test(sql)) return [{ IdProducto: 1, UnidPendientes: 50 }, { IdProducto: 2, UnidPendientes: 50 }];
    return [];
  };
  const app = express();
  app.use(require('../routes/rutas_plan')({
    apiRoute: fn => async (req, res) => { try { res.json(await fn(req)); } catch (e) { res.status(500).json({ error: e.message }); } },
    query, leerJSON: (_p, d) => d, guardarJSON: () => {}, DATA_DIR: os.tmpdir(), // no escribe: guardarJSON es no-op
    sqlStockTerminados: () => 'TERMINADOS', sqlStockGranel: () => 'GRANEL', sqlBOMGranel: () => 'BOM',
  }));
  return new Promise(ok => { const server = app.listen(0, () => ok({ server, sqls, url: `http://127.0.0.1:${server.address().port}` })); });
}

test('/api/plan/sugerencias: no consulta pendientes, no los devuelve y no fuerzan sugerido', { skip: !fs.existsSync(CONFIG_REAL) && 'sin config.json' }, async () => {
  const c = JSON.parse(fs.readFileSync(CONFIG_REAL, 'utf8'));
  const inc = typeof c.incidenciaStockPlanif === 'number' ? c.incidenciaStockPlanif : 1;
  const ctx = await montar();
  try {
    const r = await fetch(`${ctx.url}/api/plan/sugerencias?diasObjetivo=30`);
    const filas = await r.json();
    assert.strictEqual(r.status, 200, JSON.stringify(filas));
    assert.ok(!ctx.sqls.some(s => /PedidosProductos|CantPendiente/.test(s)), 'no debe consultar pendientes');
    const por = Object.fromEntries(filas.map(f => [f.idProducto, f]));
    for (const f of filas) assert.strictEqual(f.pendientes, undefined);
    // 1000 de stock a 1/día cubre más que minDiasParaSugerir: sin pendientes no sugiere nada.
    assert.ok(1000 >= c.minDiasParaSugerir, 'precondición del fixture');
    assert.strictEqual(por['1'].cantSugerida, 0);
    // Sin stock: 2/día × 30 días − 0, sin el +50 de pendientes.
    assert.strictEqual(por['2'].cantSugerida, Math.ceil(2 * 30 - 0 * inc));
    assert.strictEqual(por['2'].cantSugerida, 60);
  } finally {
    if (ctx.server.closeAllConnections) ctx.server.closeAllConnections();
    ctx.server.close();
  }
});
