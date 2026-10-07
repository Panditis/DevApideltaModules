'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { opcionesDecision, filtrarFilas } = require('../public/js/precios_listados.js');

test('opcionesDecision: fuentes con sugerido; manual sólo si hay; la guardada siempre; Producción sólo Aumentar', () => {
  const fila = { sugeridos: { sistema: { minorista: {} }, ultimaCompra: { error: 'margen' } }, decision: null };
  assert.deepStrictEqual(opcionesDecision(fila, 'almacen'), [['', '—'], ['sistema', 'Aumentar con sistema']]);
  const conManual = { sugeridos: { sistema: {}, ultimaCompra: {}, manual: {} } };
  assert.deepStrictEqual(opcionesDecision(conManual, 'almacen').map(o => o[0]), ['', 'sistema', 'ultimaCompra', 'manual']);
  assert.deepStrictEqual(opcionesDecision({ sugeridos: { sistema: {} }, decision: { fuente: 'manual' } }, 'almacen').map(o => o[0]), ['', 'sistema', 'manual']);
  assert.deepStrictEqual(opcionesDecision(conManual, 'produccion'), [['', '—'], ['sistema', 'Aumentar']]);
});

test('filtrarFilas: texto en PLU/nombre (y presentaciones), sólo decididos, última compra más cara', () => {
  const filas = [
    { plu: '1', nombre: 'Azúcar', decision: { fuente: 'sistema' }, costoSistema: 100, costoUltimaCompra: 120 },
    { plu: '2', nombre: 'Arroz', decision: null, costoSistema: 100, costoUltimaCompra: 90 },
    { plu: '3', nombre: 'Almendras', decision: null, presentaciones: [{ plu: '31', nombre: 'Almendras 500G' }] },
  ];
  assert.deepStrictEqual(filtrarFilas(filas, { texto: 'azucar' }).map(f => f.plu), ['1']);
  assert.deepStrictEqual(filtrarFilas(filas, { texto: '31' }).map(f => f.plu), ['3']);
  assert.deepStrictEqual(filtrarFilas(filas, { soloDecididos: true }).map(f => f.plu), ['1']);
  assert.deepStrictEqual(filtrarFilas(filas, { ultimaMasCara: true }).map(f => f.plu), ['1']);
  assert.strictEqual(filtrarFilas(filas).length, 3);
});
