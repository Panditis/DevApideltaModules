'use strict';
// Contrato server → modal: las filas por canal salen de lo que manda el detalle (lib/precios_listado_esquema filaPublica).
const test = require('node:test');
const assert = require('node:assert');
const L = require('../lib/precios_listado_esquema');
const { filasCanales, ventaPayload, opcionesCosto, errorMotor, estadoDecision } = require('../public/js/precios_modal_esquema.js');
const { CFG } = require('./precios_esquema_fixture');

// Pack/bulto en SIGA = precio por unidad (unidades 1): el vigente del bulto es el de 1 unidad.
const vigentes = new Map([['1', 1800], ['50', 1750]]);
const vinculos = [{ plu: '50', nombre: 'Arroz Bulto x6', basePlu: '1', cantidad: 6, tipo: 'bulto' }];

test('filasCanales: minorista + bulto sin y con IVA de la fuente elegida; fuente sin costo → sin sugeridos', () => {
  const [f] = L.listadoReventa({ universo: [{ plu: '1', nombre: 'Arroz', costoSistema: 1000 }], vigentes,
    mayoristasDe: L.crearMayoristasDe({ vinculos, vigentes }), costeo: {}, cfg: CFG });
  const pub = L.filaPublica(f);
  assert.deepStrictEqual(filasCanales(pub, 'sistema').map(r => [r.canal, r.plu, r.vigente, r.sugerido, r.deltaPct, r.margenTotalPct]), [
    ['Minorista', '1', 1800, 1800, 0, 80], ['Bulto sin IVA', '50', null, 1430, null, 43], ['Bulto con IVA', '50', 1750, 1750, 0, 75]]);
  assert.deepStrictEqual(filasCanales(pub, 'ultimaCompra').map(r => r.sugerido), [null, null, null]);
});

test('filasCanales Fraccionado: una fila minorista por presentación; el granel no tiene minorista', () => {
  const [g] = L.listadoFraccionado({
    grupos: [{ plu: '100', nombre: 'Almendras', presentaciones: [{ plu: '101', nombre: 'Almendras 500G' }, { plu: '102', nombre: 'Almendras 1Kg' }] }],
    costos: new Map([['100', { costoSistema: 1000 }]]), vigentes: new Map(), mayoristasDe: L.crearMayoristasDe({ vinculos: [], vigentes: new Map() }),
    costeo: {}, cfg: CFG,
  });
  assert.deepStrictEqual(filasCanales(L.filaPublica(g), 'sistema').map(r => [r.canal, r.plu, r.sugerido, r.margenTotalPct]),
    [['Minorista · Almendras 500G', '101', 1950, 95], ['Minorista · Almendras 1Kg', '102', 1800, 80]]);
});

test('opcionesCosto: No cambiar + cada costo con su precio minorista y Δ%; manual sólo si hay; sin sugerido → deshabilitada', () => {
  const md = L.crearMayoristasDe({ vinculos: [], vigentes });
  const [f] = L.listadoReventa({ universo: [{ plu: '1', nombre: 'Arroz', costoSistema: 1000 }], vigentes, mayoristasDe: md, costeo: {}, cfg: CFG });
  const ops = opcionesCosto(L.filaPublica(f), 'almacen');
  assert.deepStrictEqual(ops.map(o => [o.valor, o.texto, o.costo, o.precio, o.deltaPct, o.disponible]), [
    ['', 'No cambiar', null, 1800, null, true],
    ['sistema', 'Costo sistema', 1000, 1800, 0, true],
    ['ultimaCompra', 'Última compra', null, null, null, false]]);
  const [m] = L.listadoReventa({ universo: [{ plu: '1', nombre: 'Arroz', costoSistema: 1000 }], vigentes, mayoristasDe: md,
    costeo: { costoPorProducto: { 1: 2000 } }, cfg: CFG });
  assert.deepStrictEqual(opcionesCosto(L.filaPublica(m), 'almacen').map(o => o.valor), ['', 'sistema', 'ultimaCompra', 'manual']);
});

test('opcionesCosto: Producción = No cambiar / Aumentar; Fraccionado resume el Δ% promedio de las presentaciones', () => {
  const md = L.crearMayoristasDe({ vinculos: [], vigentes: new Map() });
  const [p] = L.listadoProduccion({ presentaciones: [{ plu: '6319', nombre: 'Mezcla', costoUnidad: 1000 }], vigentes, mayoristasDe: md, costeo: {}, cfg: CFG });
  assert.deepStrictEqual(opcionesCosto(L.filaPublica(p), 'produccion').map(o => [o.valor, o.texto, o.costo]), [['', 'No cambiar', null], ['sistema', 'Aumentar', 1000]]);
  const [g] = L.listadoFraccionado({
    grupos: [{ plu: '100', nombre: 'Almendras', presentaciones: [{ plu: '101', nombre: 'Almendras 500G' }, { plu: '102', nombre: 'Almendras 1Kg' }] }],
    costos: new Map([['100', { costoSistema: 1000 }]]), vigentes: new Map([['101', 1950], ['102', 1500]]), mayoristasDe: md, costeo: {}, cfg: CFG,
  });
  const sis = opcionesCosto(L.filaPublica(g), 'fraccionado')[1];
  assert.deepStrictEqual([sis.costo, sis.precio, sis.deltaPct], [1000, null, 10]); // (0 + 20) / 2
});

test('ventaPayload: por kg → DELETE (vuelve al default); por paquete exige kg > 0 y ≤ 1000', () => {
  assert.deepStrictEqual(ventaPayload('kg', null), { metodo: 'DELETE' });
  assert.deepStrictEqual(ventaPayload('paquete', 2.5), { metodo: 'PUT', body: { modo: 'paquete', pesoKg: 2.5 } });
  assert.match(ventaPayload('paquete', 0).error, /peso/);
  assert.match(ventaPayload('paquete', 1001).error, /peso/);
});

test('opcionesCosto: motivo de la opción sin precio (sin costo / márgenes sin configurar); errorMotor lo detecta', () => {
  const md = L.crearMayoristasDe({ vinculos: [], vigentes });
  const [f] = L.listadoReventa({ universo: [{ plu: '1', nombre: 'Arroz', costoSistema: 1000 }], vigentes, mayoristasDe: md, costeo: {}, cfg: CFG });
  const pub = L.filaPublica(f);
  assert.deepStrictEqual(opcionesCosto(pub, 'almacen').map(o => o.motivo), [null, null, 'Sin compras registradas']);
  assert.strictEqual(errorMotor(pub), null);
  const [sinM] = L.listadoReventa({ universo: [{ plu: '1', nombre: 'Arroz', costoSistema: 1000 }], vigentes, mayoristasDe: md, costeo: {},
    cfg: { ...CFG, margenes: {} } });
  const pubSinM = L.filaPublica(sinM);
  assert.strictEqual(errorMotor(pubSinM), 'margen');
  const sis = opcionesCosto(pubSinM, 'almacen')[1];
  assert.deepStrictEqual([sis.disponible, sis.motivo], [false, 'Faltan configurar los márgenes']);
  const [p] = L.listadoProduccion({ presentaciones: [{ plu: '6319', nombre: 'Mezcla', costoUnidad: 0 }], vigentes, mayoristasDe: md, costeo: {}, cfg: CFG });
  assert.strictEqual(opcionesCosto(L.filaPublica(p), 'produccion')[1].motivo, 'La receta no tiene costo');
});

test('estadoDecision: sin decisión no se exporta; con decisión dice con qué costo (Producción: aumento)', () => {
  assert.deepStrictEqual(estadoDecision({ decision: null }, 'almacen'), { exporta: false, texto: 'Sin cambios · no se exporta' });
  assert.strictEqual(estadoDecision({ decision: { fuente: 'ultimaCompra' } }, 'almacen').texto, 'Se exporta con última compra');
  assert.strictEqual(estadoDecision({ decision: { fuente: 'manual' } }, 'fraccionado').texto, 'Se exporta con costo manual');
  assert.strictEqual(estadoDecision({ decision: { fuente: 'sistema' } }, 'produccion').texto, 'Se exporta con aumento');
});
