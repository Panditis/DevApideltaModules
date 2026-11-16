'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { estimarPesoKg } = require('../lib/ml_precios');

test('estimarPesoKg: nombres reales de SIGA', () => {
  const casos = {
    'Aceite Girasol Cocinero 900 cc': 0.9, 'Yerba Playadito 1 Kg': 1, 'Harina 000 Pureza x 1 kg': 1,
    'Fideos Matarazzo 500gr': 0.5, 'Gaseosa 2.25 L': 2.25, 'Sal fina 500 g': 0.5, 'Azúcar x 25kg': 25,
    'Detergente 750 cc': 0.75, 'Leche 1 L': 1, 'Pack 6 x 500g': 3, 'Aceite 1,5 kg': 1.5,
    'Vino Malbec 2020 750ml': 0.75, 'Manteca 200 G': 0.2, 'Bidon 20 Lts': 20, 'Yerba 1kg.': 1, 'Pan 1 kg 10%': 1,
  };
  for (const [n, kg] of Object.entries(casos)) assert.equal(estimarPesoKg(n), kg, n);
});

test('estimarPesoKg: sin unidad de peso → null (metros, rollos, mg, lb, 0, vacío)', () => {
  for (const n of ['Papel higiénico 4 rollos 30 mts', 'Vitamina 500 mg x 30', 'Queso 1 lb', 'Fideos N° 2 largos',
    'Gaseosa 0 l', 'Tornillo 3 x 0 g', '', null, undefined]) assert.equal(estimarPesoKg(n), null, String(n));
});

test('estimarPesoKg: fracciones N/M', () => {
  assert.equal(estimarPesoKg('Cafe 1/2 kg'), 0.5);
  assert.equal(estimarPesoKg('Te 1/4 kg'), 0.25);
  assert.equal(estimarPesoKg('Jugo 3/4 L'), 0.75);
  assert.equal(estimarPesoKg('Raro 1/0 kg'), null);
});
test('estimarPesoKg: punto de miles solo con g/ml/cc; con kg/l es decimal', () => {
  assert.equal(estimarPesoKg('Azucar 1.000 g'), 1);
  assert.equal(estimarPesoKg('Arroz 1.500 gr'), 1.5);
  assert.equal(estimarPesoKg('Aceite 2.250 L'), 2.25);
  assert.equal(estimarPesoKg('Yerba 1,5 kg'), 1.5);
});
test('estimarPesoKg: tope de 50 kg por unidad, "Pack 100 x 2 kg" → null', () => {
  const { PESO_MAX_ESTIMADO_KG } = require('../lib/ml_precios');
  assert.equal(PESO_MAX_ESTIMADO_KG, 50);
  assert.equal(estimarPesoKg('Pack 100 x 2 kg'), null);
  assert.equal(estimarPesoKg('Bolsa 50 kg'), 50);
  assert.equal(estimarPesoKg('Galletitas x 12'), null); // ponytail: "x 12" sin unidad de peso es ambiguo, se ignora
});
