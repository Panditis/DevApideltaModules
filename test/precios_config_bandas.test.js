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

// Regla 2026-09-30: margen real = vigente ÷ costo de sistema tal cual − 1 (sin /1,21 ni × alícuota); sin columna SIGA.
test('margenesPorBanda: mediana del margen real (vigente ÷ costo tal cual) por banda; sugerido no crece con el costo', () => {
  const filas = [
    { costoSistema: 500, ivaCompraPct: 21, precioVigente: 1000 },    // 1000/500 − 1 = 100 %
    { costoSistema: 500, ivaCompraPct: 10.5, precioVigente: 1000 },  // la alícuota ya no cambia nada: 100 %
    { costoSistema: 2000, ivaCompraPct: 21, precioVigente: 3000 },   // real 50%
    { costoSistema: 3000, ivaCompraPct: 21, precioVigente: 6000 },   // real 100% → sugerido topeado por la banda anterior
    { costoSistema: null, precioVigente: 100 }, { costoSistema: 100, precioVigente: null }, // sin datos: fuera
  ];
  const r = ui.margenesPorBanda(filas, [1000, 2500, null]);
  assert.deepStrictEqual(r.map(b => [b.costoHastaARS, b.n, b.realMed, b.sugerido]),
    [[1000, 2, 100, 100], [2500, 1, 50, 50], [null, 1, 100, 50]]);
  assert.strictEqual(ui.margenesPorBanda([], [null])[0].sugerido, null);
});
