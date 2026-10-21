'use strict';
// Carteles Pesables: peso de bolsa por nombre, precio de la bolsa (ROUND + MROUND de Excel)
// y la ruta con SIGA falso (query inyectada).
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { multiplicadorPorNombre, precioBolsa, nombreCartel, armarCartel } = require('../lib/carteles_pesables');
const crearRutas = require('../routes/rutas_carteles_pesables');

test('multiplicador: ejemplos de la planilla', () => {
  assert.strictEqual(multiplicadorPorNombre('Achicoria 50G'), 0.05);
  assert.strictEqual(multiplicadorPorNombre('Agar Agar 30Gr'), 0.03);
  // " 50G" lleva espacio: no matchea dentro de "250G".
  assert.strictEqual(multiplicadorPorNombre('Acai Pulpa 250Gr'), 0.25);
});

test('multiplicador: sin token → 1', () => {
  assert.strictEqual(multiplicadorPorNombre('Almendras Peladas'), 1);
  assert.strictEqual(multiplicadorPorNombre(''), 1);
  assert.strictEqual(multiplicadorPorNombre(null), 1);
});

test('multiplicador: con varios tokens gana el máximo', () => {
  // "120G" contiene "20G" (0.02): replicado tal cual el Excel; con "500G" gana 0.5.
  assert.strictEqual(multiplicadorPorNombre('Mix 120G'), 0.02);
  assert.strictEqual(multiplicadorPorNombre('Pack 500G x 100G'), 0.5);
});

test('multiplicador: token al inicio del nombre no cuenta', () => {
  assert.strictEqual(multiplicadorPorNombre('500G Nueces'), 1);
});

test('multiplicador: búsqueda case-sensitive', () => {
  assert.strictEqual(multiplicadorPorNombre('Achicoria 50g'), 1);
});

test('precio: barcode "20…" multiplica y redondea como ROUND + MROUND de Excel', () => {
  const caso = (precioVenta, nombre) => precioBolsa({ precioVenta, codigoDeBarras: '2001588000000', nombre });
  assert.strictEqual(caso(14110, 'Achicoria 50G'), 710);      // 705.5 → 706 → 710
  assert.strictEqual(caso(10770, 'Algo 50G'), 540);           // 538.5 → 539 → 540
  assert.strictEqual(caso(103210, 'Agar Agar 30Gr'), 3100);   // 3096.3 → 3096 → 3100
  assert.strictEqual(caso(1235, 'Sin peso'), 1240);           // MROUND: .5 hacia arriba
});

test('precio: barcode que no arranca con "20" no se multiplica', () => {
  assert.strictEqual(precioBolsa({ precioVenta: 14110, codigoDeBarras: '7791234567890', nombre: 'Achicoria 50G' }), 14110);
  assert.strictEqual(precioBolsa({ precioVenta: 14114, codigoDeBarras: null, nombre: 'Achicoria 50G' }), 14110);
});

test('nombre del cartel: saca "(Precio por kilo)" sin importar mayúsculas', () => {
  assert.strictEqual(nombreCartel('Achicoria 50G (Precio por kilo)'), 'Achicoria 50G');
  assert.strictEqual(nombreCartel('  Pasas (PRECIO POR KILO)  de uva '), 'Pasas de uva');
});

test('armarCartel: fila de SIGA → cartel', () => {
  const c = armarCartel({ IdProducto: ' 1588 ', NombreProducto: 'Achicoria 50G (Precio por kilo)', CodigoDeBarras: '2001588',
    PrecioVenta: 14110, FechaActualizacion: new Date('2026-04-03T00:00:00Z'), Stock: 12.5 });
  assert.deepStrictEqual(c, { plu: '1588', nombre: 'Achicoria 50G', precioKg: 14110, multiplicador: 0.05, precio: 710,
    fechaActualizacion: '2026-04-03', stock: 12.5 });
  assert.strictEqual(armarCartel({ IdProducto: '1', NombreProducto: 'X', PrecioVenta: 1 }).fechaActualizacion, null);
});

function appCon(query) {
  const apiRoute = fn => async (req, res) => { try { res.json(await fn(req)); } catch (err) { res.status(500).json({ error: err.message }); } };
  const app = express();
  app.use(crearRutas({ apiRoute, query, LISTA_PRECIOS_VENTA: 0 }));
  let server;
  const pedir = async ruta => {
    if (!server) server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const res = await fetch(`http://127.0.0.1:${server.address().port}${ruta}`);
    return { status: res.status, body: await res.json() };
  };
  return { pedir, cerrar: () => server && server.close() };
}

test('ruta: idSucursal inválido → 400 sin tocar SIGA', async () => {
  let consultas = 0;
  const a = appCon(async () => { consultas++; return []; });
  try {
    for (const v of ['', 'abc', '0', '-3', '5.5', '5;DROP', '1e3']) {
      const r = await a.pedir(`/api/carteles-pesables?idSucursal=${encodeURIComponent(v)}`);
      assert.strictEqual(r.status, 400, `idSucursal=${v}`);
      assert.match(r.body.error, /idSucursal/);
    }
    assert.strictEqual(consultas, 0);
  } finally { a.cerrar(); }
});

test('ruta: devuelve las filas armadas y filtra por sucursal y lista', async () => {
  let sqlVisto = '';
  const a = appCon(async q => { sqlVisto = q; return [
    { IdProducto: '1588', NombreProducto: 'Achicoria 50G', CodigoDeBarras: '2001588', PrecioVenta: 14110, FechaActualizacion: null, Stock: 3 },
    { IdProducto: '18', NombreProducto: 'Agar Agar 30Gr', CodigoDeBarras: '20018', PrecioVenta: 103210, FechaActualizacion: null, Stock: 0 },
  ]; });
  try {
    const r = await a.pedir('/api/carteles-pesables?idSucursal=5');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.map(c => [c.plu, c.precio]), [['1588', 710], ['18', 3100]]);
    assert.match(sqlVisto, /ps\.IdSucursal = 5\b/);
    assert.match(sqlVisto, /IdListaPrecios = 0\b/);
    assert.match(sqlVisto, /'Pesables Fraccionado'/);
  } finally { a.cerrar(); }
});

test('armarCartel almacen: precio de venta exacto, sin peso de bolsa ni redondeo a 10', () => {
  const c = armarCartel({ IdProducto: '700', NombreProducto: 'Yerba 500G', CodigoDeBarras: '2000700', PrecioVenta: 1995.4, Stock: 1 }, 'almacen');
  assert.strictEqual(c.multiplicador, 1);
  assert.strictEqual(c.precio, 1995);
});

test('ruta: tipo=almacen consulta el rubro Almacen; tipo inválido → 400', async () => {
  let sqlVisto = '';
  const a = appCon(async q => { sqlVisto = q; return [
    { IdProducto: '700', NombreProducto: 'Yerba 500G', CodigoDeBarras: '7790001', PrecioVenta: 1995, FechaActualizacion: null, Stock: 1 },
  ]; });
  try {
    const r = await a.pedir('/api/carteles-pesables?idSucursal=5&tipo=almacen');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.map(c => [c.plu, c.precio]), [['700', 1995]]);
    assert.match(sqlVisto, /NombreRubro = 'Almacen'/);
    sqlVisto = '';
    const mal = await a.pedir(`/api/carteles-pesables?idSucursal=5&tipo=${encodeURIComponent("x' OR 1=1--")}`);
    assert.strictEqual(mal.status, 400);
    assert.strictEqual(sqlVisto, '');
  } finally { a.cerrar(); }
});
