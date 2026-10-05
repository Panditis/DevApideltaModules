'use strict';
// Helpers puros de gastos sobre venta y conversión ganancia ↔ markup (public/js/precios_config_gastos.js),
// espejo de lib/precios_costeo.js: deben dar lo mismo que el server.
const test = require('node:test');
const assert = require('node:assert');
const ui = require('../public/js/precios_config_gastos.js');
const costeo = require('../lib/precios_costeo.js');

// Los 8 conceptos del Excel viejo (lista Sucursal): total 26,09 %.
const EXCEL = [5, 2.3, 0.79, 1, 0.5, 0.5, 1, 15].map((pct, i) => ({ id: 'g' + i, concepto: 'c' + i, pct, listas: ['sucursal'] }));

test('totalGastosCli: suma los de la lista (fila nueva sin listas cuenta), ignora pct inválidos', () => {
  assert.strictEqual(ui.totalGastosCli(EXCEL), 26.09);
  assert.strictEqual(ui.totalGastosCli([{ concepto: 'nuevo', pct: 2 }, { pct: 3, listas: ['otra'] }, { pct: null }]), 2);
  assert.strictEqual(ui.totalGastosCli(undefined), 0);
  assert.strictEqual(ui.totalGastosCli(EXCEL), costeo.totalGastosVenta(EXCEL));
});

test('markupDesdeGananciaCli: fórmula exacta, 0 gastos = identidad, inválidos → null', () => {
  assert.ok(Math.abs(ui.markupDesdeGananciaCli(15, 26.09) - 55.5946) < 0.0001);
  assert.strictEqual(ui.markupDesdeGananciaCli(15, 0), 15);
  assert.strictEqual(ui.markupDesdeGananciaCli(null, 10), null);
  assert.strictEqual(ui.markupDesdeGananciaCli(15, 100), null);
});

test('gananciaDesdeMarkupCli: inversa de markupDesdeGananciaCli e igual al server', () => {
  for (const [g, gastos] of [[15, 26.09], [-5, 10], [40, 0], [0, 33.3]]) {
    const m = ui.markupDesdeGananciaCli(g, gastos);
    assert.strictEqual(m, costeo.markupDesdeGanancia(g, gastos));
    assert.ok(Math.abs(ui.gananciaDesdeMarkupCli(m, gastos) - g) < 1e-5);
    assert.strictEqual(ui.gananciaDesdeMarkupCli(m, gastos), costeo.gananciaDesdeMarkup(m, gastos));
  }
  assert.strictEqual(ui.gananciaDesdeMarkupCli(undefined, 5), null);
});

test('textos: desglose ganancia + gastos y markup total con coma decimal', () => {
  assert.strictEqual(ui.textoGananciaGastos(15, 26.09), 'ganancia 15 % + gastos 26,09 %');
  assert.strictEqual(ui.textoGananciaGastos(15, undefined), 'ganancia 15 % + gastos 0 %');
  assert.strictEqual(ui.textoMarkupTotal(15, 26.09), 'markup total 55,59 %');
  assert.strictEqual(ui.textoMarkupTotal(null, 26.09), '');
  assert.strictEqual(ui.fmtPctGastos(null), '—');
});

test('gananciaPorCurvaCliente: igual a gananciaPorCurva del server (clamp, ln, ajuste por peso, plana; activa vieja se ignora)', () => {
  const aj = { tramosG: [250, 500, 1000, 5000], puntos: [6, 3, 0, -2.5] };
  const curvas = [
    { activa: true, a: 40, b: 3, pisoPct: 10, techoPct: 35 },
    { activa: true, a: 55.1234, b: 4.5678, pisoPct: -5, techoPct: 60, ajustesPeso: aj },
    { activa: true, a: 20, b: -1, pisoPct: 0, techoPct: 100 },
    { a: 17.1, b: 0, pisoPct: 17.1, techoPct: 17.1 },
    { activa: false, a: 40, b: 3, pisoPct: 10, techoPct: 35 },
    { activa: true, a: 40, b: 3, pisoPct: 50, techoPct: 10 },
    null,
  ];
  for (const curva of curvas) {
    for (const costo of [0.5, 1, 100, 500, 1000, 5000, 50000, 1e7, 0, -3, null, 'x']) {
      for (const peso of [null, 100, 250, 400, 1000, 3000, 9000]) {
        assert.strictEqual(ui.gananciaPorCurvaCliente(curva, costo, peso), costeo.gananciaPorCurva(curva, costo, peso),
          `${JSON.stringify(curva)} costo ${costo} peso ${peso}`);
      }
    }
  }
  assert.strictEqual(ui.gananciaPorCurvaCliente(curvas[0], 1000), +(40 - 3 * Math.log(1000)).toFixed(6));
});
