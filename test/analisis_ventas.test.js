const test = require('node:test');
const assert = require('node:assert');
const {
  SUCURSALES_ANALISIS, NOMBRE_DIA,
  sucIdsSeguras, clampTopN, ticketProm, kpisGlobales, mapDiaSemana,
} = require('../analisis_ventas');

test('SUCURSALES_ANALISIS es la whitelist fija', () => {
  assert.deepStrictEqual(SUCURSALES_ANALISIS, [2, 3, 4, 5, 7, 9, 10]);
});

test('sucIdsSeguras filtra a la whitelist e ignora ids ajenos', () => {
  assert.deepStrictEqual(sucIdsSeguras('2,3,999,1'), [2, 3]); // 999 y 1 (central) fuera
});

test('sucIdsSeguras sin input devuelve whitelist completa', () => {
  assert.deepStrictEqual(sucIdsSeguras(undefined), [2, 3, 4, 5, 7, 9, 10]);
  assert.deepStrictEqual(sucIdsSeguras(''), [2, 3, 4, 5, 7, 9, 10]);
});

test('sucIdsSeguras con solo ids inválidos cae a whitelist completa', () => {
  assert.deepStrictEqual(sucIdsSeguras('1,999'), [2, 3, 4, 5, 7, 9, 10]);
});

test('clampTopN limita a 1..100 con default 20', () => {
  assert.strictEqual(clampTopN(undefined), 20);
  assert.strictEqual(clampTopN('50'), 50);
  assert.strictEqual(clampTopN('0'), 1);
  assert.strictEqual(clampTopN('9999'), 100);
  assert.strictEqual(clampTopN('abc'), 20);
});

test('ticketProm divide y evita división por cero', () => {
  assert.strictEqual(ticketProm(1000, 4), 250);
  assert.strictEqual(ticketProm(1000, 0), 0);
});

test('mapDiaSemana mapea 0=Lunes .. 6=Domingo', () => {
  assert.strictEqual(mapDiaSemana(0), 'Lunes');
  assert.strictEqual(mapDiaSemana(6), 'Domingo');
});

test('kpisGlobales agrega comparativa y suma resumen de renglón', () => {
  const comparativa = [
    { IdSucursal: 2, Nombre: 'Urquiza', Facturacion: 600, Tickets: 3 },
    { IdSucursal: 3, Nombre: 'Nación',  Facturacion: 400, Tickets: 1 },
  ];
  const resumen = { Unidades: 120, ProductosDistintos: 45 };
  const k = kpisGlobales(comparativa, resumen);
  assert.strictEqual(k.facturacion, 1000);
  assert.strictEqual(k.tickets, 4);
  assert.strictEqual(k.ticketProm, 250);
  assert.strictEqual(k.unidades, 120);
  assert.strictEqual(k.productosDistintos, 45);
});
