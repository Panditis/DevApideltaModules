'use strict';
// Parseo del cruce pegado desde Excel: extrae parsearCruce de public/js/ml_precios_importar.js (como el test de paridad).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ml_precios_importar.js'), 'utf8');
const fin = src.indexOf('const impClaveActual');
const ctx = {};
vm.runInNewContext(src.slice(0, fin) + '\nthis.parsearCruce = parsearCruce;', ctx);
const p = t => JSON.parse(JSON.stringify(ctx.parsearCruce(t)));

test('TSV de Excel con \r\n, encabezado, BOM, NBSP y minúsculas', () => {
  const r = p('﻿PLU Siga\tCódigo ML\r\n2309\tMLA123\r\nmla456 7\r\n\r\n8 ; MLA9\r\n8,MLA10\r\n');
  assert.deepStrictEqual(r.filas, [{ id: 'MLA123', codigo: 2309 }, { id: 'MLA456', codigo: 7 }, { id: 'MLA9', codigo: 8 }, { id: 'MLA10', codigo: 8 }]);
  assert.deepStrictEqual(r.noReconocidas, []);
});

test('PLU repetido con varios MLA y par idéntico repetido una vez', () => {
  const r = p('7\tMLA1\n7\tMLA2\n7\tMLA1');
  assert.deepStrictEqual(r.filas, [{ id: 'MLA1', codigo: 7 }, { id: 'MLA2', codigo: 7 }]);
});

test('separador de miles, un solo dato o dos MLA: no reconocidas, nunca otro PLU', () => {
  const lineas = ['2.309\tMLA1', '2,309\tMLA2','MLA4', '2309', 'MLA6 MLA7', '1e3\tMLA8', '-7\tMLA9'];
  const r = p(lineas.join('\n'));
  assert.deepStrictEqual(r.filas, []);
  assert.strictEqual(r.noReconocidas.length, lineas.length);
});

// Observación: una línea entre comillas no tiene tokens 'limpios' y contiene 'MLA', así que se toma como encabezado y se descarta sin avisar.
test('línea entre comillas se descarta como encabezado (silenciosa, no vincula nada)', () => {
  const r = p('"2309"\t"MLA3"');
  assert.deepStrictEqual([r.filas, r.noReconocidas], [[], []]);
});

test('3 columnas: PLU antes del MLA y cantidad después, o ambos del mismo lado (primero PLU)', () => {
  const r = p('PLU Siga\tCodigo ML\tCantidad\n101\tMLA1\t6\nMLA2\t102\t3\n103 4 MLA3\n5\tMLA4');
  assert.deepStrictEqual(r.filas, [
    { id: 'MLA1', codigo: 101, unidades: 6 }, { id: 'MLA2', codigo: 102, unidades: 3 },
    { id: 'MLA3', codigo: 103, unidades: 4 }, { id: 'MLA4', codigo: 5 },
  ]);
  assert.deepStrictEqual(r.noReconocidas, []);
});

test('cantidad fuera de 1..9999, 4 tokens o separador de miles con MLA: no reconocidas', () => {
  const lineas = ['101\tMLA1\t0', '101\tMLA2\t10000', '101\tMLA3\t2\t9', '2,309 MLA4'];
  const r = p(lineas.join('\n'));
  assert.deepStrictEqual(r.filas, []);
  assert.strictEqual(r.noReconocidas.length, lineas.length);
});

test('mismo id con otras cantidades se manda tal cual; duplicado exacto cuenta una vez', () => {
  const r = p('7\tMLA1\t2\n7\tMLA1\t5\n7\tMLA1\t2');
  assert.deepStrictEqual(r.filas, [{ id: 'MLA1', codigo: 7, unidades: 2 }, { id: 'MLA1', codigo: 7, unidades: 5 }]);
});
