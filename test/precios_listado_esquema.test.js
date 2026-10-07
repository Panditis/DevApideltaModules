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

// ── Fraccionado y Producción ─────────────────────────────────────────────────

test('agruparPorGranel: fórmula, nombre del granel, propio PLU y "sin granel" al final', () => {
  const grupos = L.agruparPorGranel({
    graneles: [{ plu: '100', nombre: 'Almendras DEPOSITO GRANEL' }],
    presentaciones: [{ plu: '101', nombre: 'Almendras 500G' }, { plu: '102', nombre: 'Almendras 1Kg', ventaDirecta: true },
      { plu: '103', nombre: 'Pasas 1Kg', ventaDirecta: true }, { plu: '104', nombre: 'Rara 50G' }],
    formulas: { 101: { granel: 100 } },
    costos: new Map([['100', { plu: '100', nombre: 'Almendras DEPOSITO GRANEL' }], ['103', { plu: '103', nombre: 'Pasas 1Kg' }]]),
  });
  assert.deepStrictEqual(grupos.map(g => [g.plu, g.presentaciones.map(p => p.plu)]),
    [['100', ['101', '102']], ['103', ['103']], [null, ['104']]]);
});

test('listadoFraccionado: costo $/kg del granel en todas sus presentaciones, ajuste por peso, pack pesable y decisión del granel', () => {
  const grupos = [
    { plu: '100', nombre: 'Almendras', presentaciones: [{ plu: '102', nombre: 'Almendras 1Kg' }, { plu: '101', nombre: 'Almendras 500G' }] },
    { plu: null, nombre: 'Sin granel asignado', presentaciones: [{ plu: '104', nombre: 'Rara 50G' }] },
  ];
  const costos = new Map([['100', { plu: '100', nombre: 'Almendras', costoSistema: 1000, costoMercaderia: null }]]);
  const vigentes = new Map([['101', 1950], ['102', 1700]]);
  const mayoristasDe = L.crearMayoristasDe({ vigentes, vinculos: [{ plu: '60', nombre: 'Almendras 1Kg Pack', basePlu: '102', cantidad: 10, tipo: 'pack' }] });
  const [g, sin] = L.listadoFraccionado({ grupos, costos, vigentes, mayoristasDe, costeo: { decisiones: { 100: { fuente: 'sistema', fecha: 'x' } } }, cfg: CFG });
  assert.deepStrictEqual(g.presentaciones.map(p => [p.plu, p.pesoG, p.sugeridos.sistema.minorista.precio]), [['101', 500, 1950], ['102', 1000, 1800]]);
  assert.strictEqual(g.presentaciones[1].sugeridos.sistema.mayoristas[0].conIva, 1750); // pack por kg: unidades 1
  assert.deepStrictEqual(g.decision, { fuente: 'sistema', fecha: 'x' });
  assert.strictEqual(g.costoSistema, 1000);
  assert.deepStrictEqual([sin.plu, sin.decision, sin.presentaciones[0].sugeridos], [null, null, {}]);
});

test('listadoProduccion: sólo PLUs SIGA, costo por unidad de la receta como fuente sistema, ordenado por nombre', () => {
  const md = L.crearMayoristasDe({ vinculos: [], vigentes: new Map() });
  const filas = L.listadoProduccion({ presentaciones: [
    { productoId: 'p-granola', plu: '6319', nombre: 'Granola 500G', costoUnidad: 1000 },
    { productoId: 'p-granola', plu: 'n-nueva', nombre: 'Nueva', costoUnidad: 900 },
    { productoId: 'p-x', plu: '7000', nombre: 'Alfajor', costoUnidad: null },
  ], vigentes: new Map([['6319', 1800]]), mayoristasDe: md, costeo: { decisiones: { 6319: { fuente: 'sistema' } } }, cfg: CFG });
  assert.deepStrictEqual(filas.map(f => [f.plu, f.productoId, f.costoSistema, f.sugeridos.sistema ? f.sugeridos.sistema.minorista.precio : null, !!f.decision]),
    [['7000', 'p-x', null, null, false], ['6319', 'p-granola', 1000, 1800, true]]);
});

// ── Decisión y export ────────────────────────────────────────────────────────

test('validarDecision / aplicarDecision', () => {
  const costeo = { costoPorProducto: { 5: 100 } };
  assert.strictEqual(L.validarDecision('5', 'manual', costeo), null);
  assert.match(L.validarDecision('6', 'manual', costeo), /costo manual/);
  assert.match(L.validarDecision('x1', 'sistema', costeo), /PLU/);
  assert.match(L.validarDecision('5', 'otra', costeo), /fuente/);
  assert.strictEqual(L.validarDecision('5', null, costeo), null);
  const antes = { 1: { fuente: 'sistema', fecha: 'a' } };
  const d = L.aplicarDecision(antes, '2', 'ultimaCompra', 'b');
  assert.deepStrictEqual(d, { 1: { fuente: 'sistema', fecha: 'a' }, 2: { fuente: 'ultimaCompra', fecha: 'b' } });
  assert.deepStrictEqual(L.aplicarDecision(d, '1', null, 'c'), { 2: { fuente: 'ultimaCompra', fecha: 'b' } });
  assert.deepStrictEqual(antes, { 1: { fuente: 'sistema', fecha: 'a' } });
});

test('validarDecisionContraFilas: sólo filas decidibles y fuentes con sugerido; null siempre pasa (limpia decisiones viejas)', () => {
  const sug = (...fs) => Object.fromEntries(fs.map(f => [f, {}]));
  const filas = {
    almacen: [{ plu: '1', sugeridos: sug('sistema', 'ultimaCompra') }],
    fraccionado: [
      { plu: '100', sugeridos: sug('sistema'), presentaciones: [{ plu: '101', sugeridos: sug('sistema') }] },
      { plu: null, sugeridos: {}, presentaciones: [{ plu: '102', sugeridos: {} }] }, // "Sin granel asignado"
    ],
    produccion: [{ plu: '6319', sugeridos: sug('sistema') }],
  };
  const v = (plu, fuente) => L.validarDecisionContraFilas(filas, plu, fuente);
  assert.strictEqual(v('1', 'ultimaCompra'), null);
  assert.strictEqual(v('100', 'sistema'), null); // granel de Fraccionado
  assert.strictEqual(v('6319', 'sistema'), null);
  assert.match(v('999', 'sistema'), /no está en ningún listado/);
  assert.match(v('101', 'sistema'), /presentación de Fraccionado.*granel \(PLU 100\)/);
  assert.match(v('102', 'sistema'), /presentación de Fraccionado/); // grupo sin granel: nadie la decide
  assert.match(v('6319', 'ultimaCompra'), /no tiene precio sugerido con la fuente ultimaCompra \(disponibles: sistema\)/);
  assert.match(v('1', 'manual'), /disponibles: sistema, ultimaCompra/);
  assert.strictEqual(v('999', null), null);
  assert.strictEqual(v('101', null), null);
});

test('itemsDecididos + listasExport: una lista por canal; Fraccionado alcanza a todas sus presentaciones; sin precio → omitido', () => {
  const almacen = L.listadoReventa({
    universo: [{ plu: '1', nombre: 'Arroz', costoSistema: 1000 }, { plu: '2', nombre: 'Fideos', costoSistema: 500 }, { plu: '3', nombre: 'Sal', costoSistema: 300 }],
    vigentes: VIGENTES, mayoristasDe: L.crearMayoristasDe({ vinculos: VINCULOS, vigentes: VIGENTES }),
    costeo: { decisiones: { 1: { fuente: 'sistema' }, 3: { fuente: 'ultimaCompra' } } }, cfg: CFG,
  });
  const fraccionado = L.listadoFraccionado({
    grupos: [{ plu: '100', nombre: 'Almendras', presentaciones: [{ plu: '101', nombre: 'Almendras 500G' }, { plu: '102', nombre: 'Almendras 1Kg' }] }],
    costos: new Map([['100', { costoSistema: 1000 }]]), vigentes: new Map(), mayoristasDe: L.crearMayoristasDe({ vinculos: [], vigentes: new Map() }),
    costeo: { decisiones: { 100: { fuente: 'sistema' } } }, cfg: CFG,
  });
  const { items, omitidos } = L.itemsDecididos({ almacen, fraccionado, produccion: [] });
  assert.strictEqual(omitidos, 1); // Sal: decidida con última compra, que no tiene
  const listas = L.listasExport(items, 21);
  const enc = ['Codigo', 'Nombre', 'Costo', 'Venta'];
  assert.deepStrictEqual(listas.minorista, [enc, ['1', 'Arroz', 1210, 1800], ['101', 'Almendras 500G', 1210, 1950], ['102', 'Almendras 1Kg', 1210, 1800]]);
  // Pack/bulto por unidad: Costo = costo unitario (1000; con IVA 1210), Venta = 1430 neto / 1750 con IVA.
  assert.deepStrictEqual(listas.bultoNeto, [enc, ['50', 'Arroz Bulto x6', 1000, 1430]]);
  assert.deepStrictEqual(listas.bultoIva, [enc, ['50', 'Arroz Bulto x6', 1210, 1750]]);
  assert.deepStrictEqual([listas.packNeto, listas.packIva], [[enc], [enc]]);
});
