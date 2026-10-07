'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../lib/precios_listado_esquema');
const { CFG } = require('./precios_esquema_fixture');

// Precio del pack/bulto en SIGA = por unidad (respuesta del usuario 2026-10-07): el vigente del bulto es el de 1 unidad.
const VIGENTES = new Map([['1', 1800], ['50', 1750]]);
const VINCULOS = [{ plu: '50', nombre: 'Arroz Bulto x6', basePlu: '1', cantidad: 6, tipo: 'bulto' }];

test('costosFuentes: suma los costos extra a cada fuente; sin costo (o ≤ 0) → null', () => {
  const extras = [{ concepto: 'Flete', tipo: 'kg', valor: 50 }, { concepto: 'Merma', tipo: 'pct', valor: 10 }];
  assert.deepStrictEqual(L.costosFuentes({ costoSistema: 1000, costoUltimaCompra: 2000, costoManual: null, extras }),
    { sistema: 1150, ultimaCompra: 2250, manual: null });
  assert.deepStrictEqual(L.costosFuentes({ costoSistema: 0 }), { sistema: null, ultimaCompra: null, manual: null });
});

test('unidadesVinculo: base no pesable = 1 (precio por unidad); pesable por kg = 1, por paquete = kg; paquete sin kg → null', () => {
  assert.strictEqual(L.unidadesVinculo({ plu: '50', cantidad: 6 }), 1);
  assert.strictEqual(L.unidadesVinculo({ plu: '51', cantidad: null }), 1); // vínculo manual
  assert.strictEqual(L.unidadesVinculo({ plu: '52', cantidad: 10 }, {}, true), 1);
  assert.strictEqual(L.unidadesVinculo({ plu: '52', cantidad: 10 }, { 52: { modo: 'paquete' } }, true), 10);
  assert.strictEqual(L.unidadesVinculo({ plu: '52', cantidad: 10 }, { 52: { modo: 'paquete', pesoKg: 5 } }, true), 5);
  assert.strictEqual(L.unidadesVinculo({ plu: '53', granel: true, cantidad: null }, { 53: { modo: 'paquete' } }), null);
});

test('preciosDeCosto: minorista y cada pack/bulto con sus unidades; sin unidades → faltante; vigente en otra unidad → revisar', () => {
  const r = L.preciosDeCosto({ cfg: CFG, tipo: 'almacen', costo: 1000, vigente: 1800, mayoristas: [
    { plu: '50', tipo: 'bulto', unidades: 1, vigente: 1750 },
    { plu: '51', tipo: 'pack', unidades: null, vigente: 900 }, // pesable por paquete sin kg
    { plu: '52', tipo: 'pack', unidades: 1, vigente: 10400 }, // cargado por caja
  ] });
  assert.deepStrictEqual(r.minorista, { precio: 1800, deltaPct: 0, estado: 'ok' });
  // A mano: 1000 + 10 % gastos = 1100 → × 1,30 = 1430 neto (bultoNeto redondeo 0) → × 1,21 = 1730,30 → múltiplo de 50 = 1750.
  assert.deepStrictEqual(r.mayoristas[0], { plu: '50', faltante: null, neto: 1430, conIva: 1750, deltaPct: 0, estado: 'ok', revisarUnidad: false });
  assert.strictEqual(r.mayoristas[1].faltante, 'unidades');
  assert.strictEqual(r.mayoristas[2].revisarUnidad, true);
  assert.strictEqual(r.desglose.porVinculo['50'].unidades, 1);
  assert.strictEqual(r.desglose.minorista.exacto, 1816.82);
});

test('preciosDeCosto: error del motor (sin márgenes) → sin precios', () => {
  assert.deepStrictEqual(L.preciosDeCosto({ cfg: { ...CFG, margenes: {} }, tipo: 'almacen', costo: 1000 }),
    { error: 'margen', minorista: null, mayoristas: [], desglose: null });
});

test('listadoReventa: un sugerido por fuente con costo, pack/bulto vinculados, última compra y decisión', () => {
  const mayoristasDe = L.crearMayoristasDe({ vinculos: VINCULOS, vigentes: VIGENTES });
  const universo = [{ plu: '1', nombre: 'Arroz', costoSistema: 1000, costoMercaderia: 2000, fechaUltimaCompra: '2026-10-01', proveedor: 'Molino' }];
  const costeo = { decisiones: { 1: { fuente: 'ultimaCompra', fecha: '2026-10-07' } } };
  const [f] = L.listadoReventa({ universo, vigentes: VIGENTES, mayoristasDe, costeo, cfg: CFG });
  assert.strictEqual(f.vigente, 1800);
  assert.deepStrictEqual(Object.keys(f.sugeridos), ['sistema', 'ultimaCompra']);
  assert.strictEqual(f.sugeridos.sistema.minorista.precio, 1800);
  assert.deepStrictEqual(f.sugeridos.ultimaCompra.minorista, { precio: 3650, deltaPct: 102.8, estado: 'subir' });
  assert.deepStrictEqual(f.mayoristas, [{ plu: '50', nombre: 'Arroz Bulto x6', tipo: 'bulto', unidades: 1, vigente: 1750 }]);
  assert.strictEqual(f.sugeridos.sistema.mayoristas[0].conIva, 1750);
  assert.deepStrictEqual([f.costoSistema, f.costoUltimaCompra, f.deltaUltimaPct, f.proveedor], [1000, 2000, 100, 'Molino']);
  assert.deepStrictEqual(f.decision, { fuente: 'ultimaCompra', fecha: '2026-10-07' });
});

test('listadoReventa: costo manual agrega la fuente manual; sin costos → sin sugeridos', () => {
  const md = L.crearMayoristasDe({ vinculos: [], vigentes: new Map() });
  const [a, b] = L.listadoReventa({ universo: [{ plu: '1', nombre: 'A', costoSistema: 1000 }, { plu: '2', nombre: 'B' }], vigentes: new Map(),
    mayoristasDe: md, costeo: { costoPorProducto: { 1: 1500 } }, cfg: CFG });
  assert.deepStrictEqual(Object.keys(a.sugeridos), ['sistema', 'manual']);
  assert.strictEqual(a.costoManual, 1500);
  assert.deepStrictEqual(b.sugeridos, {});
});

test('filaPublica: sin desglose ni costos con extras (también en presentaciones); con permiso, la fila entera', () => {
  const md = L.crearMayoristasDe({ vinculos: VINCULOS, vigentes: VIGENTES });
  const [f] = L.listadoReventa({ universo: [{ plu: '1', nombre: 'Arroz', costoSistema: 1000 }], vigentes: VIGENTES, mayoristasDe: md,
    costeo: { costosExtraFraccionado: { 1: [{ concepto: 'Flete', tipo: 'kg', valor: 10 }] } }, cfg: CFG });
  const pub = L.filaPublica(f);
  const txt = JSON.stringify(pub);
  for (const clave of ['desglose', 'gastosPct', 'margenPct', 'extrasPct', 'costoConGastos', 'costosExtra', '"costos"']) assert.ok(!txt.includes(clave), clave);
  assert.strictEqual(pub.sugeridos.sistema.minorista.precio, f.sugeridos.sistema.minorista.precio);
  assert.strictEqual(L.filaPublica(f, true), f);
  assert.ok(!JSON.stringify(L.filaPublica({ ...f, presentaciones: [f] })).includes('desglose'));
});
