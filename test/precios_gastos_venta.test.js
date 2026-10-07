'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  totalGastosVenta, markupDesdeGanancia, gananciaDesdeMarkup, validarGastosVenta, reescalarGanancias, gananciaPorCurva,
} = require('../lib/precios_costeo');

// Los 8 conceptos de la tabla de gastos sobre venta del Excel viejo (lista sucursal) = 26,09 %.
const GASTOS_EXCEL = [
  { id: 'iibb', concepto: 'IIBB', pct: 5, listas: ['sucursal'] },
  { id: 'financieros', concepto: 'Financieros', pct: 2.3, listas: ['sucursal'] },
  { id: 'deb-cred', concepto: 'Deb/Cred', pct: 0.79, listas: ['sucursal'] },
  { id: 'flete', concepto: 'Flete', pct: 1, listas: ['sucursal'] },
  { id: 'pauta', concepto: 'Pauta', pct: 0.5, listas: ['sucursal'] },
  { id: 'pop', concepto: 'POP', pct: 0.5, listas: ['sucursal'] },
  { id: 'vencido', concepto: 'Vencido', pct: 1, listas: ['sucursal'] },
  { id: 'goa', concepto: 'GOA', pct: 15, listas: ['sucursal'] },
];

// ── totalGastosVenta ─────────────────────────────────────────────────────────

test('totalGastosVenta: suma los 8 conceptos del Excel → 26.09', () => {
  assert.strictEqual(totalGastosVenta(GASTOS_EXCEL), 26.09);
  assert.strictEqual(totalGastosVenta(GASTOS_EXCEL, 'sucursal'), 26.09);
});

test('totalGastosVenta: sólo suma los ítems de la lista pedida; inválido o ausente → 0', () => {
  const gastos = [...GASTOS_EXCEL, { id: 'x', concepto: 'Mayorista', pct: 7, listas: ['mayorista'] }];
  assert.strictEqual(totalGastosVenta(gastos), 26.09);
  assert.strictEqual(totalGastosVenta(gastos, 'mayorista'), 7);
  assert.strictEqual(totalGastosVenta(undefined), 0);
  assert.strictEqual(totalGastosVenta(null), 0);
  assert.strictEqual(totalGastosVenta('basura'), 0);
  assert.strictEqual(totalGastosVenta([]), 0);
});

// ── markupDesdeGanancia / gananciaDesdeMarkup ────────────────────────────────

test('markupDesdeGanancia: fórmula exacta (1+g)/(1−gastos)−1; 15 % con 26.09 % → 55.594642', () => {
  assert.strictEqual(markupDesdeGanancia(15, 26.09), 55.594642);
});

test('markupDesdeGanancia: sin gastos es la identidad', () => {
  assert.strictEqual(markupDesdeGanancia(68.32, 0), 68.32);
  assert.strictEqual(markupDesdeGanancia(15, 0), 15);
  assert.strictEqual(markupDesdeGanancia(-5, 0), -5);
});

test('markupDesdeGanancia: ganancia no numérica o gastos ≥ 100 → null', () => {
  assert.strictEqual(markupDesdeGanancia(null, 10), null);
  assert.strictEqual(markupDesdeGanancia(NaN, 10), null);
  assert.strictEqual(markupDesdeGanancia('15', 10), null);
  assert.strictEqual(markupDesdeGanancia(15, 100), null);
});

test('gananciaDesdeMarkup: inversa de markupDesdeGanancia; sin gastos identidad; inválidos → null', () => {
  assert.ok(Math.abs(gananciaDesdeMarkup(55.594642, 26.09) - 15) < 1e-5);
  assert.strictEqual(gananciaDesdeMarkup(40, 0), 40);
  assert.strictEqual(gananciaDesdeMarkup(null, 10), null);
  assert.strictEqual(gananciaDesdeMarkup(40, 100), null);
});

// ── validarGastosVenta ───────────────────────────────────────────────────────

test('validarGastosVenta: devuelve la lista limpia; id por slug del concepto si falta; listas default sucursal', () => {
  const r = validarGastosVenta([
    { concepto: '  Ingresos Brutos ', pct: 5, basura: 1 },
    { id: 'goa', concepto: 'GOA', pct: 15, listas: ['sucursal'] },
    { concepto: 'Ingresos brutos', pct: 1 },
  ]);
  assert.deepStrictEqual(r, [
    { id: 'ingresos-brutos', concepto: 'Ingresos Brutos', pct: 5, listas: ['sucursal'] },
    { id: 'goa', concepto: 'GOA', pct: 15, listas: ['sucursal'] },
    { id: 'ingresos-brutos-2', concepto: 'Ingresos brutos', pct: 1, listas: ['sucursal'] },
  ]);
  assert.deepStrictEqual(validarGastosVenta([]), []);
});

test('validarGastosVenta: errores claros (lista, concepto, pct, listas, id, repetidos, máximo, total ≥ 100)', () => {
  assert.throws(() => validarGastosVenta('x'), /lista/);
  assert.throws(() => validarGastosVenta([null]), /items\[0\]/);
  assert.throws(() => validarGastosVenta([{ concepto: '', pct: 1 }]), /concepto/);
  assert.throws(() => validarGastosVenta([{ concepto: 'x'.repeat(61), pct: 1 }]), /concepto/);
  assert.throws(() => validarGastosVenta([{ concepto: 'A', pct: -1 }]), /pct/);
  assert.throws(() => validarGastosVenta([{ concepto: 'A', pct: 101 }]), /pct/);
  assert.throws(() => validarGastosVenta([{ concepto: 'A', pct: '5' }]), /pct/);
  assert.throws(() => validarGastosVenta([{ concepto: 'A', pct: 5, listas: ['mayorista'] }]), /listas/);
  assert.throws(() => validarGastosVenta([{ concepto: 'A', pct: 5, listas: [] }]), /listas/);
  assert.throws(() => validarGastosVenta([{ id: 'Con Espacios', concepto: 'A', pct: 5 }]), /id/);
  assert.throws(() => validarGastosVenta([{ id: 'a', concepto: 'A', pct: 5 }, { id: 'a', concepto: 'B', pct: 5 }]), /repetido/);
  assert.throws(() => validarGastosVenta(Array.from({ length: 41 }, (_, i) => ({ concepto: `G${i}`, pct: 0 }))), /máximo 40/);
  assert.throws(() => validarGastosVenta([{ concepto: 'A', pct: 60 }, { concepto: 'B', pct: 40 }]), /menor a 100/);
});

// ── reescalarGanancias ───────────────────────────────────────────────────────

const COSTEO = {
  toleranciaPct: 10,
  curvaGanancia: {
    almacen: { a: 60, b: 4, pisoPct: 15, techoPct: 40 },
    fraccionado: { a: 90, b: 3, pisoPct: 55, techoPct: 85, ajustesPeso: { tramosG: [100, 1000], puntos: [6, -4] } },
    produccion: { a: 50, b: 0, pisoPct: 50, techoPct: 50 },
  },
};
const COSTOS_PRUEBA = [1, 100, 1000, 5000, 50000, 1e7];

test('reescalarGanancias: el markup total de cada curva queda igual (3er decimal) al pasar de 0 a 26.09 % de gastos', () => {
  const r = reescalarGanancias(COSTEO, 0, 26.09);
  for (const tipo of ['almacen', 'fraccionado', 'produccion']) {
    for (const costo of COSTOS_PRUEBA) {
      for (const peso of [50, 1000]) {
        const antes = gananciaPorCurva(COSTEO.curvaGanancia[tipo], costo, peso);
        const despues = gananciaPorCurva(r.curvaGanancia[tipo], costo, peso);
        assert.ok(Math.abs(markupDesdeGanancia(despues, 26.09) - antes) < 0.001, `${tipo} ${costo} ${peso}: ${despues}`);
      }
    }
    for (const k of ['a', 'b', 'pisoPct', 'techoPct']) {
      const v = r.curvaGanancia[tipo][k];
      assert.strictEqual(v, Math.round(v * 1e4) / 1e4); // 4 decimales
    }
  }
  assert.strictEqual(r.toleranciaPct, 10);
});

test('reescalarGanancias: no muta la entrada; ida y vuelta vuelve a los valores originales', () => {
  const copia = JSON.parse(JSON.stringify(COSTEO));
  const ida = reescalarGanancias(COSTEO, 0, 26.09);
  assert.deepStrictEqual(COSTEO, copia);
  const vuelta = reescalarGanancias(ida, 26.09, 0);
  for (const tipo of ['almacen', 'fraccionado', 'produccion']) {
    for (const costo of COSTOS_PRUEBA) {
      assert.ok(Math.abs(gananciaPorCurva(vuelta.curvaGanancia[tipo], costo, 50) - gananciaPorCurva(COSTEO.curvaGanancia[tipo], costo, 50)) < 0.001);
    }
  }
});

test('reescalarGanancias: sin cambio de gastos o sin curvas no inventa nada', () => {
  assert.deepStrictEqual(reescalarGanancias(COSTEO, 10, 10), COSTEO);
  assert.strictEqual(reescalarGanancias({ toleranciaPct: 1 }, 0, 10).curvaGanancia, undefined);
});
