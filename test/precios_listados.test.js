'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { etiquetaDecision, filtrarFilas } = require('../public/js/precios_listados.js');

test('etiquetaDecision: badge de la fila decidida con su fuente; sin decisión → null; Producción = aumentar', () => {
  assert.strictEqual(etiquetaDecision({ decision: null }, 'almacen'), null);
  assert.strictEqual(etiquetaDecision({ decision: { fuente: 'ultimaCompra' } }, 'almacen'), '↑ última compra');
  assert.strictEqual(etiquetaDecision({ decision: { fuente: 'sistema' } }, 'fraccionado'), '↑ sistema');
  assert.strictEqual(etiquetaDecision({ decision: { fuente: 'manual' } }, 'almacen'), '↑ manual');
  assert.strictEqual(etiquetaDecision({ decision: { fuente: 'sistema' } }, 'produccion'), '↑ aumentar');
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
