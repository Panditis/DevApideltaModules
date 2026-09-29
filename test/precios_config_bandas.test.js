'use strict';
// Helpers puros de las bandas de markup de Configuración (public/precios_config_bandas.js).
const test = require('node:test');
const assert = require('node:assert');
const ui = require('../public/precios_config_bandas.js');

const GUARDADAS = {
  almacen: [{ costoHastaARS: 1000, markupMaxPct: 60 }, { costoHastaARS: null, markupMaxPct: 40 }],
  fraccionado: [{ costoHastaARS: null, markupMaxPct: 30 }],
  produccion: [{ costoHastaARS: null, markupMaxPct: 50 }],
};

test('bodyBandas: lo último guardado con sólo la tabla que se guarda reemplazada (no pisa la otra)', () => {
  const nuevas = [{ costoHastaARS: null, markupMaxPct: 80 }];
  assert.deepStrictEqual(ui.bodyBandas(GUARDADAS, 'produccion', nuevas), { ...GUARDADAS, produccion: nuevas });
  assert.deepStrictEqual(ui.bodyBandas(GUARDADAS, 'almacen', nuevas), { ...GUARDADAS, almacen: nuevas });
  assert.deepStrictEqual(ui.bodyBandas(undefined, 'almacen', []), { almacen: [], fraccionado: [], produccion: [] });
});

test('editarBanda / quitarBanda / agregarBanda: devuelven listas nuevas sin mutar', () => {
  const filas = GUARDADAS.almacen;
  assert.deepStrictEqual(ui.editarBanda(filas, 0, 'costoHastaARS', null), [{ costoHastaARS: null, markupMaxPct: 60 }, filas[1]]);
  assert.deepStrictEqual(ui.editarBanda(filas, 1, 'markupMaxPct', 45.5), [filas[0], { costoHastaARS: null, markupMaxPct: 45.5 }]);
  assert.deepStrictEqual(ui.quitarBanda(filas, 0), [filas[1]]);
  assert.strictEqual(filas[0].costoHastaARS, 1000);
});

test('agregarBanda: inserta antes de "sin tope", tope = doble del anterior y margen del anterior (no rompe el orden)', () => {
  const filas = [{ costoHastaARS: 2500, markupMaxPct: 65 }, { costoHastaARS: 10000, markupMaxPct: 62 }, { costoHastaARS: null, markupMaxPct: 55 }];
  assert.deepStrictEqual(ui.agregarBanda(filas), [filas[0], filas[1], { costoHastaARS: 20000, markupMaxPct: 62 }, filas[2]]);
  assert.strictEqual(filas.length, 3); // sin mutar
  assert.deepStrictEqual(ui.agregarBanda([{ costoHastaARS: null, markupMaxPct: 55 }]), [{ costoHastaARS: 1000, markupMaxPct: 55 }, { costoHastaARS: null, markupMaxPct: 55 }]);
  assert.deepStrictEqual(ui.agregarBanda([]), [{ costoHastaARS: null, markupMaxPct: 0 }]);
});

test('ordenarBandas: por tope ascendente, "sin tope" al final', () => {
  const filas = [{ costoHastaARS: null, markupMaxPct: 55 }, { costoHastaARS: 5000, markupMaxPct: 60 }, { costoHastaARS: 1000, markupMaxPct: 65 }];
  assert.deepStrictEqual(ui.ordenarBandas(filas).map(b => b.costoHastaARS), [1000, 5000, null]);
});

test('margenesPorBanda: mediana del margen real (sin IVA) y SIGA (costo con IVA) por banda; sugerido no crece con el costo', () => {
  // vigente 1210 con costo sin IVA 500 → real = 1000/500−1 = 100%; SIGA (IVA compra 21%) = 1210/605−1 = 100%.
  // IVA compra 10,5%: costo sin IVA 500 → con IVA 552,5 → SIGA 119%; real sigue 100%.
  const filas = [
    { costoSistema: 500, ivaCompraPct: 21, precioVigente: 1210 },
    { costoSistema: 500, ivaCompraPct: 10.5, precioVigente: 1210 },
    { costoSistema: 2000, ivaCompraPct: 21, precioVigente: 3630 },   // real 50%
    { costoSistema: 3000, ivaCompraPct: 21, precioVigente: 7260 },   // real 100% → sugerido topeado por la banda anterior
    { costoSistema: null, precioVigente: 100 }, { costoSistema: 100, precioVigente: null }, // sin datos: fuera
  ];
  const r = ui.margenesPorBanda(filas, [1000, 2500, null]);
  assert.deepStrictEqual(r.map(b => [b.costoHastaARS, b.n, b.realMed, b.sigaMed, b.sugerido]),
    [[1000, 2, 100, 109.5, 100], [2500, 1, 50, 50, 50], [null, 1, 100, 100, 50]]);
  assert.strictEqual(ui.margenesPorBanda([], [null])[0].sugerido, null);
});
