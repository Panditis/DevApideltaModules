'use strict';
// Helpers puros de la matriz de margen standard Fraccionado (public/precios_config_fraccionado.js).
const test = require('node:test');
const assert = require('node:assert');
const ui = require('../public/precios_config_fraccionado.js');

const M = () => ({
  bandas: [1000, null],
  tramosG: [250, 1000],
  markupPct: [[60, 50], [40, 30]],
});

test('agregarTramo sin peso: columna vacía al final copiando la última, sin mutar', () => {
  const m = M();
  const r = ui.agregarTramo(m);
  assert.deepStrictEqual(r.tramosG, [250, 1000, null]);
  assert.deepStrictEqual(r.markupPct, [[60, 50, 50], [40, 30, 30]]);
  assert.deepStrictEqual(m, M());
});

test('agregarTramo con peso: se inserta en orden copiando la columna de peso más cercano', () => {
  const r = ui.agregarTramo(M(), 400);
  assert.deepStrictEqual(r.tramosG, [250, 400, 1000]);
  assert.deepStrictEqual(r.markupPct, [[60, 60, 50], [40, 40, 30]]);
  const r2 = ui.agregarTramo(M(), 5000);
  assert.deepStrictEqual(r2.tramosG, [250, 1000, 5000]);
  assert.deepStrictEqual(r2.markupPct, [[60, 50, 50], [40, 30, 30]]);
  const r3 = ui.agregarTramo(M(), 100);
  assert.deepStrictEqual(r3.tramosG, [100, 250, 1000]);
  assert.deepStrictEqual(r3.markupPct, [[60, 60, 50], [40, 40, 30]]);
});

test('quitarTramo: saca la columna y sus márgenes; con una sola columna no hace nada', () => {
  const m = M();
  const r = ui.quitarTramo(m, 0);
  assert.deepStrictEqual(r, { bandas: [1000, null], tramosG: [1000], markupPct: [[50], [30]] });
  assert.deepStrictEqual(m, M());
  assert.deepStrictEqual(ui.quitarTramo(r, 0), r);
});

test('ordenarMatriz: ordena columnas por peso y bandas por costo moviendo los márgenes', () => {
  const m = { bandas: [2000, 500, null], tramosG: [1000, 250], markupPct: [[1, 2], [3, 4], [5, 6]] };
  const r = ui.ordenarMatriz(m);
  assert.deepStrictEqual(r, { bandas: [500, 2000, null], tramosG: [250, 1000], markupPct: [[4, 3], [2, 1], [6, 5]] });
  assert.deepStrictEqual(m.tramosG, [1000, 250]);
});

test('ordenarMatriz: rechaza pesos vacíos, ≤0 o repetidos, costos vacíos/repetidos y celdas vacías', () => {
  const con = cambios => () => ui.ordenarMatriz({ ...M(), ...cambios });
  assert.throws(con({ tramosG: [250, null] }), /peso/i);
  assert.throws(con({ tramosG: [250, 0] }), /peso/i);
  assert.throws(con({ tramosG: [250, 250] }), /repetid/i);
  assert.throws(con({ bandas: [null, null] }), /costo/i);
  assert.throws(con({ bandas: [1000, 1000, null], markupPct: [[1, 1], [1, 1], [1, 1]] }), /repetid/i);
  assert.throws(con({ markupPct: [[60, null], [40, 30]] }), /vac/i);
});

test('pesosFaltantes: pesos de presentaciones reales sin columna exacta, únicos y ascendentes', () => {
  const data = [
    { presentaciones: [{ pesoG: 500 }, { pesoG: 250 }, { pesoG: null }] },
    { presentaciones: [{ pesoG: 500 }, { pesoG: 100 }], temporales: [{ pesoG: 333 }] },
  ];
  assert.deepStrictEqual(ui.pesosFaltantes(data, [250, 1000]), [100, 500]);
  assert.deepStrictEqual(ui.pesosFaltantes(undefined, [250]), []);
});
