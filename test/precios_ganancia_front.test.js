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
