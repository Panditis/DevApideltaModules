'use strict';
// Helpers puros de la tab Ganancia (public/js/precios_ganancia.js).
const test = require('node:test');
const assert = require('node:assert');
const ui = require('../public/js/precios_ganancia.js');
const { totalConceptosGanancia, validarConceptosGanancia, validarConceptosPrecioFinal } = require('../lib/precios_costeo');

test('totalConceptosGananciaCli = totalConceptosGanancia del server (ignora filas sin %)', () => {
  const items = [{ concepto: 'A', pct: 2.5 }, { concepto: 'B', pct: -0.333 }, { concepto: 'C', pct: null }];
  assert.strictEqual(ui.totalConceptosGananciaCli(items), totalConceptosGanancia(items));
  assert.strictEqual(ui.totalConceptosGananciaCli([]), 0);
});

test('bodyGanancia: conceptos recortados (id sólo si existía); el server lo acepta tal cual', () => {
  const body = ui.bodyGanancia([{ id: 'reinv', concepto: ' Reinversión ', pct: 2 }, { concepto: 'Riesgo', pct: 1 }]);
  assert.deepStrictEqual(body, { conceptos: [{ id: 'reinv', concepto: 'Reinversión', pct: 2 }, { concepto: 'Riesgo', pct: 1 }] });
  assert.deepStrictEqual(validarConceptosGanancia(body.conceptos).map(c => c.id), ['reinv', 'riesgo']);
});

test('bodyPrecioFinal: conceptos sobre precio final recortados; el server los acepta', () => {
  const body = ui.bodyPrecioFinal([{ id: 'ingresos-brutos', concepto: ' IIBB ', pct: 5 }, { concepto: 'Débitos y créditos', pct: 0.79 }]);
  assert.deepStrictEqual(body, { conceptosPrecioFinal: [{ id: 'ingresos-brutos', concepto: 'IIBB', pct: 5 }, { concepto: 'Débitos y créditos', pct: 0.79 }] });
  assert.deepStrictEqual(validarConceptosPrecioFinal(body.conceptosPrecioFinal).map(c => c.id), ['ingresos-brutos', 'debitos-y-creditos']);
});

test('márgenes propios: rótulo de rangos de Δ y resumen en texto', () => {
  const { etiquetaRangoMp, textoResumenMp } = require('../public/js/precios_ganancia.js');
  assert.strictEqual(etiquetaRangoMp({ desde: null, hasta: -10 }), 'menos de -10 %');
  assert.strictEqual(etiquetaRangoMp({ desde: -0.5, hasta: 0.5 }), '-0,5 % a +0,5 %');
  assert.strictEqual(etiquetaRangoMp({ desde: 10, hasta: null }), '+10 % o más');
  assert.strictEqual(textoResumenMp({ topePct: 5, totales: { standard: 3, acercar: 2, sinCambio: 1 },
    motivosSinCambio: { sinCosto: 1, sinStandard: 0, sinListado: 0 } }),
  '3 pasan al standard · 2 se acercan 5 % · 1 sin cambio (1 sin costo, 0 sin standard, 0 fuera de los listados)');
});
