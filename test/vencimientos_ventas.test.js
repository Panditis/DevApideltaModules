'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { calcularVentas, consultarVentas, desde12Meses } = require('../lib/vencimientos_ventas');

const HOY = '2026-11-18';
// creado a mediodía local: la fecha local de carga es 2026-11-10 en cualquier zona razonable.
const creado = dia => new Date(`${dia}T12:00:00`).toISOString();
const lote = (id, extra = {}) => ({ id, idProducto: 10, vencimiento: '2027-01-01', creado: creado('2026-11-10'),
  sucursales: { 1: { unidades: 5, vendido: 0 }, 2: { unidades: 0, vendido: 0 } }, ...extra });
const fila = (suc, dia, cant, prod = 10) => ({ IdSucursal: suc, IdProducto: `${prod} `, Dia: new Date(`${dia}T00:00:00Z`), Cantidad: cant });

test('ventana de 12 meses', () => {
  assert.strictEqual(desde12Meses(HOY), '2025-11-19');
});

test('desde carga inclusive, antes no cuenta; ventana excluye lo viejo; promedio /12 a 1 decimal; otra sucursal no se mezcla', () => {
  const filas = [fila(1, '2026-11-09', 100), fila(1, '2026-11-10', 3), fila(1, '2026-11-15', 4),
    fila(1, '2025-11-18', 1000), fila(1, '2025-11-19', 1), fila(3, '2026-11-12', 50), fila(1, '2026-11-12', 7, 99)];
  const v = calcularVentas([lote('a')], filas, HOY, 1);
  assert.deepStrictEqual(v, { a: { vendidoDesdeCarga: 7, promMensual12: 9 } }); // (100+3+4+1)/12 = 9
});

test('lote sin unidades en la sucursal igual trae sus ventas; mismo producto comparte promedio', () => {
  const filas = [fila(2, '2026-01-01', 10), fila(2, '2026-11-17', 1), fila(1, '2026-11-17', 50)];
  const v = calcularVentas([lote('a'), lote('b', { creado: creado('2026-11-18') })], filas, HOY, 2);
  assert.deepStrictEqual(v, { a: { vendidoDesdeCarga: 1, promMensual12: 0.9 }, b: { vendidoDesdeCarga: 0, promMensual12: 0.9 } });
});

test('filas vacías → 0 y 0 para todo lote', () => {
  assert.deepStrictEqual(calcularVentas([lote('a'), lote('b', { sucursales: {} })], [], HOY, 4),
    { a: { vendidoDesdeCarga: 0, promMensual12: 0 }, b: { vendidoDesdeCarga: 0, promMensual12: 0 } });
});

const poolFalso = consultas => async () => ({ request() {
  const inputs = {};
  const r = { input(k, v) { inputs[k] = v; return r; }, async query(q) { consultas.push({ q, inputs }); return { recordset: [{ x: 1 }] }; } };
  return r;
} });

test('consultarVentas parte en tandas de 200 y filtra por la única sucursal', async () => {
  const consultas = [];
  const lotes = Array.from({ length: 450 }, (_, i) => ({ idProducto: i + 1, sucursales: {} }));
  const filas = await consultarVentas(poolFalso(consultas), lotes, HOY, 4);
  assert.strictEqual(consultas.length, 3);
  assert.strictEqual(filas.length, 3);
  assert.strictEqual(consultas[0].inputs.prod199, '200');
  // regresión: msnodesqlv8 rompe el declare con nombres pN
  for (const { q, inputs } of consultas) {
    assert.ok(!Object.keys(inputs).some(k => /^p\d+$/.test(k)), 'sin nombres pN');
    assert.deepStrictEqual([...new Set(q.match(/@prod\d+/g))].map(s => s.slice(1)).sort(), Object.keys(inputs).filter(k => /^prod\d+$/.test(k)).sort());
  }
  assert.strictEqual(consultas[0].inputs.suc, 4);
  assert.match(consultas[0].q, /v.IdSucursal = @suc/);
  assert.strictEqual(consultas[0].inputs.desde, '2025-11-19');
  assert.strictEqual(consultas[0].inputs.hasta, '2026-11-19');
  assert.match(consultas[0].q, /ANULADO/);
});

test('consultarVentas sin sucursal válida no consulta', async () => {
  const consultas = [];
  for (const suc of [null, 0, 6, 8, 11]) assert.deepStrictEqual(await consultarVentas(poolFalso(consultas), [{ idProducto: 1 }], HOY, suc), []);
  assert.strictEqual(consultas.length, 0);
});
