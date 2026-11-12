'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const ml = require('../lib/ml_precios');

// Fixture: recorte real de la bajada de ML del 2026-10-26 (headers + 6 padres + 17 variantes).
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'ml_publicaciones_muestra.xlsx'));
const HEADER = ['ITEM_ID', 'VARIATION_ID', 'TITLE', 'QUANTITY', 'PRICE', 'SALE_PRICE', 'VALUE_ADDED_TAX', 'SHIPPING_METHOD', 'STATUS', 'LISTING_TYPE_V3'];
const xlsx = filas => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADER, [], [], [], [], ...filas]), 'Publicaciones');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};
const CFG = { ...ml.CONFIG_DEFAULT, comisionPct: 10, envioGratisPct: 5, cuotasPct: { no: 0, agregar: 8, interes_bajo: 3 },
  tablaMargen: { minPct: 30, maxPct: 30, escalones: 1, rango: { desde: 1, hasta: 2 } } };

test('parsea la bajada real: solo padres, variantes contadas', () => {
  const r = ml.parsearBajada(FIXTURE);
  assert.strictEqual(r.publicaciones.length, 6);
  assert.strictEqual(r.variantesIgnoradas, 17);
  assert.strictEqual(r.total, 23);
  const polen = r.publicaciones.find(p => p.id === 'MLA681472431');
  assert.deepStrictEqual(polen, { id: 'MLA681472431', titulo: polen.titulo, precio: 58000, precioPromo: null, envio: 'gratis', activa: true, cuotas: 'interes_bajo', stock: 31, iva: 21 });
  const porId = Object.fromEntries(r.publicaciones.map(p => [p.id, p]));
  assert.strictEqual(porId.MLA617910359.envio, 'comprador');
  assert.strictEqual(porId.MLA618175467.cuotas, 'agregar');
  assert.strictEqual(porId.MLA661505574.activa, false);
  assert.strictEqual(porId.MLA1911105585.envio, 'sin');
  assert.strictEqual(porId.MLA1827448504.envio, 'nd');
});

test('dedup por ITEM_ID gana la última; SALE_PRICE numérico es promo', () => {
  const r = ml.parsearBajada(xlsx([
    ['MLA1', '', 'A', 1, 100, '-', '21 %', 'Mercado Envíos gratis', 'Activa', 'No agregar cuotas'],
    ['MLA1', '', 'A2', 1, 200, 150, '21 %', 'Mercado Envíos gratis', 'Activa', 'No agregar cuotas'],
  ]));
  assert.strictEqual(r.publicaciones.length, 1);
  assert.strictEqual(r.publicaciones[0].titulo, 'A2');
  assert.strictEqual(ml.precioMlDe(r.publicaciones[0]), 150);
});

test('rechaza archivos que no son xlsx o sin hoja Publicaciones', () => {
  assert.throws(() => ml.parsearBajada(Buffer.from('hola')), ml.ErrorBajada);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x']]), 'Otra');
  assert.throws(() => ml.parsearBajada(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })), /Publicaciones/);
});

test('esperado con margen, envío gratis y cuotas = cálculo manual', () => {
  // base 1000×2 = 2000; ×1.30 = 2600; gastos 10+5+8 = 23 % → 2600 / 0.77 = 3376.62
  const r = ml.precioEsperado(1000, 2, 'gratis', 'agregar', CFG);
  assert.deepStrictEqual(r, { base: 2000, margenPct: 30, gastosPct: 23, esperado: 3376.62 });
  assert.strictEqual(ml.precioEsperado(1000, 2, 'comprador', 'no', { ...CFG, redondeoPaso: 100 }).esperado, 2900); // 2600/0.9 = 2888.9
});

test('gastos al 100 % → sin_margen', () => {
  const r = ml.precioEsperado(1000, 1, 'no', 'no', { ...CFG, comisionPct: 100 });
  assert.strictEqual(r.esperado, null);
  assert.strictEqual(ml.estadoDe({ vinculado: true, carta: 1000, precioMl: 1, esperado: r.esperado, toleranciaPct: 2 }).estado, 'sin_margen');
});

test('borde de tolerancia: justo = ok, apenas arriba = desviada', () => {
  const e = (precioMl) => ml.estadoDe({ vinculado: true, carta: 1, precioMl, esperado: 1000, toleranciaPct: 2 });
  assert.deepStrictEqual(e(1020), { estado: 'ok', desvioPct: 2 });
  assert.deepStrictEqual(e(980), { estado: 'ok', desvioPct: -2 });
  assert.strictEqual(e(1020.1).estado, 'desviada');
});

test('estados previos al desvío', () => {
  const base = { vinculado: true, carta: 100, precioMl: 100, esperado: 100, toleranciaPct: 2 };
  assert.strictEqual(ml.estadoDe({ ...base, vinculado: false }).estado, 'sin_vincular');
  assert.strictEqual(ml.estadoDe({ ...base, precioMl: null }).estado, 'sin_precio');
  assert.strictEqual(ml.estadoDe({ ...base, carta: null }).estado, 'sin_carta');
});

test('armarFila + kpis: sin vínculo no entra en ok/desviadas', () => {
  const pubs = [
    { id: 'A', titulo: 'a', precio: 3376.62, precioPromo: null, envio: 'gratis', cuotas: 'agregar', activa: true, stock: 1 },
    { id: 'B', titulo: 'b', precio: 500, precioPromo: null, envio: 'nd', cuotas: 'no', activa: false, stock: 0 },
    { id: 'C', titulo: 'c', precio: 500, precioPromo: null, envio: 'nd', cuotas: 'no', activa: true, stock: 0 },
  ];
  const cartas = new Map([['7', { precio: 1000, nombre: 'Prod 7' }]]);
  const filas = [
    ml.armarFila(pubs[0], { codigo: 7, unidades: 2 }, cartas, CFG),
    ml.armarFila(pubs[1], null, cartas, CFG),
    ml.armarFila(pubs[2], { codigo: 9, unidades: 1 }, cartas, CFG),
  ];
  assert.strictEqual(filas[0].estado, 'ok');
  assert.strictEqual(filas[0].nombreProducto, 'Prod 7');
  assert.strictEqual(filas[1].estado, 'sin_vincular');
  assert.strictEqual(filas[2].estado, 'sin_carta');
  assert.deepStrictEqual(ml.kpis(filas), { activas: 2, inactivas: 1, ok: 1, desviadas: 0, sinVincular: 1, sinCarta: 1, sinMargen: 0, sinPrecio: 0 });
});

test('validarConfig', () => {
  assert.strictEqual(ml.validarConfig(ml.CONFIG_DEFAULT), null);
  assert.match(ml.validarConfig({ ...CFG, comisionPct: 60, envioGratisPct: 40 }), /100 %/);
  assert.match(ml.validarConfig({ ...CFG, comisionPct: -1 }), /comisionPct/);
  assert.ok(ml.validarConfig({ ...CFG, tablaMargen: { ...CFG.tablaMargen, minPct: -100 } }));
  assert.ok(ml.validarConfig({ ...CFG, cuotasPct: { no: 0 } }));
});
