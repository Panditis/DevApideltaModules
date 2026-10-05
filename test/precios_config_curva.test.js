'use strict';
// Helpers puros de la tarjeta de curva de ganancia (public/js/precios_config_curva.js). Es un script
// clásico: usa gananciaPorCurvaCliente y markupDesdeGananciaCli de precios_config_gastos.js como globales.
const test = require('node:test');
const assert = require('node:assert');
const gastos = require('../public/js/precios_config_gastos.js');
globalThis.gananciaPorCurvaCliente = gastos.gananciaPorCurvaCliente;
globalThis.markupDesdeGananciaCli = gastos.markupDesdeGananciaCli;
const ui = require('../public/js/precios_config_curva.js');
const costeo = require('../lib/precios_costeo.js');

const CURVA = { a: 40, b: 3, pisoPct: 10, techoPct: 35 };

test('puntosPorDuplicar: b × ln 2', () => {
  assert.strictEqual(ui.puntosPorDuplicar(3), 2.08);
  assert.strictEqual(ui.puntosPorDuplicar(-1), -0.69);
});

test('filasEjemploCurva: lectura en los costos netos de referencia — ganancia y markup s/ neto como el server, markup final con IVA 21 %', () => {
  const filas = ui.filasEjemploCurva(CURVA, 26.09);
  assert.deepStrictEqual(filas.map(f => f.costo), [500, 1000, 2500, 5000, 10000, 20000, 50000]);
  for (const f of filas) {
    const g = costeo.gananciaPorCurva(CURVA, f.costo);
    assert.strictEqual(f.ganancia, g);
    assert.strictEqual(f.markup, costeo.markupDesdeGanancia(g, 26.09));
    assert.strictEqual(f.markupFinal, +(((1 + f.markup / 100) * 1.21 - 1) * 100).toFixed(2));
  }
  // Con ajustes por peso, el ejemplo es la presentación de 1 kg.
  const conAj = ui.filasEjemploCurva({ ...CURVA, ajustesPeso: { tramosG: [500, 1000], puntos: [5, -2] } }, 0);
  assert.strictEqual(conAj[0].ganancia, +(Math.min(35, Math.max(10, 40 - 3 * Math.log(500))) - 2).toFixed(6));
  assert.strictEqual(ui.filasEjemploCurva({ ...CURVA, a: null }, 0)[0].ganancia, null);
  assert.strictEqual(ui.filasEjemploCurva({ ...CURVA, a: null }, 0)[0].markupFinal, null);
  // Por tramo de peso: el ajuste del tramo de la presentación.
  assert.strictEqual(ui.filasEjemploCurva({ ...CURVA, ajustesPeso: { tramosG: [500, 1000], puntos: [5, -2] } }, 0, 250)[0].ganancia,
    +(Math.min(35, Math.max(10, 40 - 3 * Math.log(500))) + 5).toFixed(6));
});

test('filasEjemploCurva: curva → + conceptos → markup con el G del tipo → markup final con el IVA de venta editable', () => {
  const [f] = ui.filasEjemploCurva(CURVA, 30, null, 4, 10.5);
  const curva = costeo.gananciaPorCurva(CURVA, 500);
  assert.strictEqual(f.gananciaCurva, curva);
  assert.strictEqual(f.ganancia, +(curva + 4).toFixed(6));
  assert.strictEqual(f.markup, costeo.markupDesdeGanancia(f.ganancia, 30));
  assert.strictEqual(f.markupFinal, +(((1 + f.markup / 100) * 1.105 - 1) * 100).toFixed(2));
});

test('ajustesParaTramos: alinea lo guardado a una lista de tramos, faltantes en 0', () => {
  assert.deepStrictEqual(ui.ajustesParaTramos([250, 500, 1000], { tramosG: [500, 1000, 5000], puntos: [3, -1, 7] }), [0, 3, -1]);
  assert.deepStrictEqual(ui.ajustesParaTramos([250, 500], null), [0, 0]);
  assert.deepStrictEqual(ui.ajustesParaTramos(undefined, null), []);
});

test('margenPropio: cuenta filas de Almacén o presentaciones de Fraccionado con ganancia propia', () => {
  const alm = [{ gananciaOverride: 30 }, { gananciaOverride: null }, {}, { gananciaOverride: 0 }];
  assert.deepStrictEqual(ui.margenPropio('almacen', alm, []), { n: 2, total: 4 });
  const fr = [{ presentaciones: [{ gananciaOverride: 5 }, {}] }, { presentaciones: [{ gananciaOverride: 1 }] }, {}];
  assert.deepStrictEqual(ui.margenPropio('fraccionado', alm, fr), { n: 2, total: 3 });
  assert.deepStrictEqual(ui.margenPropio('almacen', undefined, undefined), { n: 0, total: 0 });
  assert.deepStrictEqual(ui.margenPropio('produccion', alm, fr), { n: 0, total: 0 });
});

test('marcasLog: 1-2-5 dentro del rango, raleadas si son muchas; marcasLineales redondas', () => {
  assert.deepStrictEqual(ui.marcasLog(300, 60000), [500, 1000, 2000, 5000, 10000, 20000, 50000]);
  assert.deepStrictEqual(ui.marcasLog(3, 3e6), [10, 100, 1000, 10000, 100000, 1000000]);
  assert.deepStrictEqual(ui.marcasLog(1200, 1800), [1200, 1800]);
  assert.deepStrictEqual(ui.marcasLineales(3, 47), [10, 20, 30, 40]);
  assert.deepStrictEqual(ui.marcasLineales(-12, 95), [0, 20, 40, 60, 80]);
});

test('dominioCurva: X con margen sobre muestra y bins, Y acotado a [−50, 300]; sin datos → null', () => {
  const prop = { ...CURVA, muestra: [{ costo: 100, ganancia: 20 }, { costo: 10000, ganancia: 900 }],
    bins: [{ costo: 1000, ganancia: 18, n: 2 }] };
  const d = ui.dominioCurva(prop, null);
  assert.ok(Math.abs(d.x[0] - 100 / 1.3) < 1e-9 && Math.abs(d.x[1] - 13000) < 1e-9);
  assert.ok(d.y[0] >= -50 && d.y[1] <= 300 && d.y[0] < d.y[1]);
  assert.strictEqual(ui.dominioCurva({ muestra: [], bins: [] }, null), null);
});
