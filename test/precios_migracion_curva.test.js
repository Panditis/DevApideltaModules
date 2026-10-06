'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { costeoConCurva, curvaDesdeBandas, curvaDesdeMatriz, curvaANeta, MARKUP_FRACCIONADO_LEGADO } = require('../lib/precios_migracion_curva');
const { gananciaPorCurva, validarCurvaGanancia } = require('../lib/precios_costeo');
const { filasCurvaProduccion } = require('../routes/rutas_precios_produccion');

// Bandas Reventa de data/costeo.json de dev al 2026-10-02 (topes en costo con IVA).
const BANDAS_DEV = [
  { costoHastaARS: 1000, markupMaxPct: 24.2 }, { costoHastaARS: 2500, markupMaxPct: 17.2 },
  { costoHastaARS: 5000, markupMaxPct: 17.1 }, { costoHastaARS: 7500, markupMaxPct: 17.1 },
  { costoHastaARS: 10000, markupMaxPct: 17.1 }, { costoHastaARS: 15000, markupMaxPct: 17.1 },
  { costoHastaARS: 20000, markupMaxPct: 17 }, { costoHastaARS: 30000, markupMaxPct: 12.3 },
  { costoHastaARS: 50000, markupMaxPct: 12.3 }, { costoHastaARS: null, markupMaxPct: 12.3 },
];
const LEGADO = {
  toleranciaPct: 10, margenPorProducto: { 1: 30 },
  bandasMarkup: { almacen: BANDAS_DEV, fraccionado: [], produccion: [] },
  markupFraccionado: {
    bandas: [9999, 19999, null], tramosG: [100, 1000],
    markupPct: [[40, 20], [44, 24], [36, 16]],
  },
};
const centroNeto = (desde, hasta) => Math.sqrt(desde * hasta) / 1.21;

test('curvaDesdeBandas: mínimos cuadrados sobre costo neto; piso/techo = mín/máx de las bandas (bandas de dev)', () => {
  const c = curvaDesdeBandas(BANDAS_DEV);
  assert.deepStrictEqual(c, { a: 33.6173, b: 1.9559, pisoPct: 12.3, techoPct: 24.2 });
  // En el centro de cada banda la curva queda a menos de 2,5 puntos de la ganancia vieja.
  let desde = 100;
  for (const b of BANDAS_DEV) {
    const hasta = b.costoHastaARS ?? 2 * desde;
    const g = gananciaPorCurva(c, centroNeto(desde, hasta));
    assert.ok(Math.abs(g - b.markupMaxPct) < 2.5, `${b.costoHastaARS}: ${g} vs ${b.markupMaxPct}`);
    desde = hasta;
  }
  assert.strictEqual(curvaDesdeBandas([]), null);
  assert.deepStrictEqual(curvaDesdeBandas([{ costoHastaARS: null, markupMaxPct: 30 }]), { a: 30, b: 0, pisoPct: 30, techoPct: 30 });
});

test('curvaANeta: misma ganancia con costo neto que la vieja con costo × 1,21; sin activa', () => {
  const vieja = { activa: true, a: 40, b: 3, pisoPct: 5, techoPct: 35, ajustadaEl: '2026-09-30', n: 10 };
  const neta = curvaANeta(vieja);
  assert.strictEqual('activa' in neta, false);
  for (const costo of [100, 2000, 30000]) {
    assert.ok(Math.abs(gananciaPorCurva(neta, costo) - gananciaPorCurva(vieja, costo * 1.21)) < 0.001);
  }
});

test('curvaDesdeMatriz: curva por la media de columnas + ajuste por peso = residuo medio de cada columna', () => {
  const c = curvaDesdeMatriz(LEGADO.markupFraccionado);
  assert.deepStrictEqual(c.ajustesPeso.tramosG, [100, 1000]);
  // Las columnas difieren en 20 puntos en todas las filas: ajustes ±10 alrededor de la media.
  assert.deepStrictEqual(c.ajustesPeso.puntos, [10, -10]);
  assert.strictEqual(c.pisoPct, 26);
  assert.strictEqual(c.techoPct, 34);
  assert.doesNotThrow(() => validarCurvaGanancia(c, 'fraccionado'));
  // La matriz de fábrica también da una curva válida.
  assert.doesNotThrow(() => validarCurvaGanancia(curvaDesdeMatriz(MARKUP_FRACCIONADO_LEGADO), 'fraccionado'));
});

test('costeoConCurva: migra bandas/matriz a las tres curvas, saca bandasMarkup y markupFraccionado, marca y conserva el resto', () => {
  const m = costeoConCurva(LEGADO);
  assert.strictEqual(m.metodoGanancia, 'curva');
  assert.strictEqual('bandasMarkup' in m, false);
  assert.strictEqual('markupFraccionado' in m, false);
  assert.deepStrictEqual(m.margenPorProducto, { 1: 30 });
  assert.strictEqual(m.toleranciaPct, 10);
  assert.deepStrictEqual(Object.keys(m.curvaGanancia).sort(), ['almacen', 'fraccionado', 'produccion']);
  for (const [tipo, c] of Object.entries(m.curvaGanancia)) assert.doesNotThrow(() => validarCurvaGanancia(c, tipo), tipo);
  assert.strictEqual(m.curvaGanancia.almacen.a, 33.6173);
  // Producción sin bandas → plana con la mediana de las ganancias de Reventa (17,1).
  assert.deepStrictEqual(m.curvaGanancia.produccion, { ajustadaEl: null, n: null, a: 17.1, b: 0, pisoPct: 17.1, techoPct: 17.1 });
  assert.deepStrictEqual(LEGADO.bandasMarkup.almacen, BANDAS_DEV); // no muta
});

test('costeoConCurva: idempotente (con el marcador devuelve el mismo objeto) y migrar dos veces da lo mismo', () => {
  const m = costeoConCurva(LEGADO);
  assert.strictEqual(costeoConCurva(m), m);
  assert.deepStrictEqual(costeoConCurva(LEGADO), m);
});

test('costeoConCurva: curva vieja activa se usa pasada a neta; inactiva se ignora (bandas/matriz)', () => {
  const vieja = { activa: true, a: 40, b: 3, pisoPct: 5, techoPct: 35, ajustadaEl: '2026-09-30', n: 812 };
  const conActiva = costeoConCurva({ ...LEGADO, curvaGanancia: {
    almacen: vieja, fraccionado: { ...vieja, ajustesPeso: { tramosG: [500], puntos: [2] } },
  } });
  assert.deepStrictEqual(conActiva.curvaGanancia.almacen, curvaANeta(vieja));
  assert.deepStrictEqual(conActiva.curvaGanancia.fraccionado.ajustesPeso, { tramosG: [500], puntos: [2] });
  const conInactiva = costeoConCurva({ ...LEGADO, curvaGanancia: { almacen: { ...vieja, activa: false } } });
  assert.strictEqual(conInactiva.curvaGanancia.almacen.a, 33.6173);
});

test('costeoConCurva: Producción con bandas propias; config vacía → curvas por defecto válidas (Fraccionado con la matriz de fábrica)', () => {
  const m = costeoConCurva({ bandasMarkup: { produccion: [{ costoHastaARS: 2000, markupMaxPct: 40 }, { costoHastaARS: null, markupMaxPct: 25 }] } });
  assert.ok(m.curvaGanancia.produccion.b > 0);
  assert.strictEqual(m.curvaGanancia.produccion.techoPct, 40);
  assert.strictEqual(m.curvaGanancia.produccion.pisoPct, 25);
  const vacia = costeoConCurva({});
  for (const [tipo, c] of Object.entries(vacia.curvaGanancia)) assert.doesNotThrow(() => validarCurvaGanancia(c, tipo), tipo);
  assert.deepStrictEqual(vacia.curvaGanancia.fraccionado.ajustesPeso.tramosG, MARKUP_FRACCIONADO_LEGADO.tramosG);
  assert.strictEqual(costeoConCurva(null).metodoGanancia, 'curva');
});

test('filasCurvaProduccion: una fila por presentación con PLU de SIGA, costo y vigente', () => {
  const costeados = { p1: { presentaciones: {
    100: { costoUnidad: 500, ivaPct: 21, finalPct: 5.79 }, 'n-nueva': { costoUnidad: 400 }, 101: { costoUnidad: null }, 102: { costoUnidad: 300 },
  } } };
  const filas = filasCurvaProduccion(costeados, new Map([['100', 900], ['n-nueva', 800], ['101', 700]]), new Map());
  assert.deepStrictEqual(filas, [{ costoBase: 500, costoTotal: 500, precioVigente: 900, ivaPct: 21, finalPct: 5.79 }]);
});
