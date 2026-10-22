'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { repartirEnPresentaciones } = require('../lib/plan_reparto');

const pres = [
  { plu: '1', nombre: 'Pepas 250G', presentacion: '250G', pesoKg: 0.25, ventasKg: 300 },
  { plu: '2', nombre: 'Pepas 500G', presentacion: '500G', pesoKg: 0.5, ventasKg: 100 },
];

test('reparte los kg en proporción a lo vendido y redondea hacia arriba a unidades', () => {
  assert.deepStrictEqual(repartirEnPresentaciones(10, pres), [
    { plu: '1', nombre: 'Pepas 250G', presentacion: '250G', unidades: 30 },
    { plu: '2', nombre: 'Pepas 500G', presentacion: '500G', unidades: 5 },
  ]);
  assert.deepStrictEqual(repartirEnPresentaciones(1, pres).map(r => r.unidades), [3, 1]); // 0.75/0.25=3, 0.25/0.5=0.5→1
});

test('sin ventas: todo a la presentación de mayor peso', () => {
  const sinVentas = pres.map(p => ({ ...p, ventasKg: 0 }));
  assert.deepStrictEqual(repartirEnPresentaciones(10, sinVentas), [{ plu: '2', nombre: 'Pepas 500G', presentacion: '500G', unidades: 20 }]);
});

test('ignora presentaciones sin peso o sin plu; kg <= 0 → []', () => {
  assert.deepStrictEqual(repartirEnPresentaciones(0, pres), []);
  assert.deepStrictEqual(repartirEnPresentaciones(-3, pres), []);
  assert.deepStrictEqual(repartirEnPresentaciones(5, [{ plu: '1', pesoKg: null, ventasKg: 10 }]), []);
  assert.deepStrictEqual(repartirEnPresentaciones(5, [{ plu: null, pesoKg: 1, ventasKg: 10 }]), []);
  assert.deepStrictEqual(repartirEnPresentaciones(5, [{ plu: '3', nombre: 'X', presentacion: '1Kg', pesoKg: 1, ventasKg: 0 }, { plu: '4', pesoKg: null, ventasKg: 9 }]).map(r => r.unidades), [5]);
});
