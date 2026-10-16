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

test('preciosDeCosto: minorista y cada pack/bulto con sus unidades y margen total; sin unidades → faltante; vigente en otra unidad → revisar', () => {
  const r = L.preciosDeCosto({ cfg: CFG, tipo: 'almacen', costo: 1000, vigente: 1800, mayoristas: [
    { plu: '50', tipo: 'bulto', unidades: 1, vigente: 1750 },
    { plu: '51', tipo: 'pack', unidades: null, vigente: 900 }, // pesable por paquete sin kg
    { plu: '52', tipo: 'pack', unidades: 1, vigente: 10400 }, // cargado por caja
  ] });
  // margen total = precio final ÷ costo de mercadería (con extras) − 1: 1800 / 1000 → 80 %
  assert.deepStrictEqual(r.minorista, { precio: 1800, margenTotalPct: 80, deltaPct: 0, estado: 'ok' });
  // A mano: 1000 + 10 % gastos = 1100 → × 1,30 = 1430 neto (bultoNeto redondeo 0) → × 1,21 = 1730,30 → múltiplo de 50 = 1750.
  assert.deepStrictEqual(r.mayoristas[0], { plu: '50', faltante: null, neto: 1430, conIva: 1750, margenTotalNetoPct: 43, margenTotalIvaPct: 75,
    deltaPct: 0, estado: 'ok', revisarUnidad: false });
  assert.strictEqual(r.mayoristas[1].faltante, 'unidades');
  assert.deepStrictEqual([r.mayoristas[1].margenTotalNetoPct, r.mayoristas[1].margenTotalIvaPct], [null, null]);
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
  assert.deepStrictEqual(f.sugeridos.ultimaCompra.minorista, { precio: 3650, margenTotalPct: 82.5, deltaPct: 102.8, estado: 'subir' });
  assert.deepStrictEqual(f.mayoristas, [{ plu: '50', nombre: 'Arroz Bulto x6', tipo: 'bulto', unidades: 1, vigente: 1750, venta: null }]);
  assert.strictEqual(f.sugeridos.sistema.mayoristas[0].conIva, 1750);
  assert.deepStrictEqual([f.costoSistema, f.costoUltimaCompra, f.deltaUltimaPct, f.proveedor], [1000, 2000, 100, 'Molino']);
  assert.deepStrictEqual(f.decision, { fuente: 'ultimaCompra', fecha: '2026-10-07' });
});

test('listadoReventa: excluir saca los PLUs de venta de Producción (no se duplican en Reventa)', () => {
  const universo = [{ plu: '1', nombre: 'Arroz', costoSistema: 1000 }, { plu: '2280', nombre: 'Miel 500', costoSistema: 900 }];
  const base = { universo, vigentes: new Map(), mayoristasDe: () => [], costeo: {}, cfg: CFG };
  assert.deepStrictEqual(L.listadoReventa(base).map(f => f.plu), ['1', '2280']);
  assert.deepStrictEqual(L.listadoReventa({ ...base, excluir: new Set(['2280']) }).map(f => f.plu), ['1']);
});
test('listadoReventa: costo manual agrega la fuente manual; sin costos → sin sugeridos', () => {
  const md = L.crearMayoristasDe({ vinculos: [], vigentes: new Map() });
  const [a, b] = L.listadoReventa({ universo: [{ plu: '1', nombre: 'A', costoSistema: 1000 }, { plu: '2', nombre: 'B' }], vigentes: new Map(),
    mayoristasDe: md, costeo: { costoPorProducto: { 1: 1500 } }, cfg: CFG });
  assert.deepStrictEqual(Object.keys(a.sugeridos), ['sistema', 'manual']);
  assert.strictEqual(a.costoManual, 1500);
  assert.deepStrictEqual(b.sugeridos, {});
});

test('listadoReventa: ingresoHoy (compra cargada hoy en SIGA) viaja en la fila, también en la pública; sin dato → false', () => {
  const md = L.crearMayoristasDe({ vinculos: [], vigentes: new Map() });
  const universo = [{ plu: '1', nombre: 'A', costoSistema: 1000, ingresoHoy: true }, { plu: '2', nombre: 'B', costoSistema: 1000, ingresoHoy: false }, { plu: '3', nombre: 'C', costoSistema: 1000 }];
  const filas = L.listadoReventa({ universo, vigentes: new Map(), mayoristasDe: md, costeo: {}, cfg: CFG });
  assert.deepStrictEqual(filas.map(f => f.ingresoHoy), [true, false, false]);
  assert.deepStrictEqual(filas.map(f => L.filaPublica(f).ingresoHoy), [true, false, false]); // no es costo: lo ven todos
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

test('listadoFraccionado: ingresoHoy es del granel (su compra cargada hoy); "Sin granel" nunca', () => {
  const grupos = [
    { plu: '100', nombre: 'Almendras', presentaciones: [{ plu: '101', nombre: 'Almendras 500G' }] },
    { plu: '200', nombre: 'Nueces', presentaciones: [] },
    { plu: null, nombre: 'Sin granel asignado', presentaciones: [{ plu: '104', nombre: 'Rara 50G' }] },
  ];
  const costos = new Map([['100', { plu: '100', costoSistema: 1000, ingresoHoy: true }], ['200', { plu: '200', costoSistema: 900, ingresoHoy: false }]]);
  const md = L.crearMayoristasDe({ vinculos: [], vigentes: new Map() });
  const filas = L.listadoFraccionado({ grupos, costos, vigentes: new Map(), mayoristasDe: md, costeo: {}, cfg: CFG });
  assert.deepStrictEqual(filas.map(g => g.ingresoHoy), [true, false, false]);
  assert.strictEqual(L.filaPublica(filas[0]).ingresoHoy, true);
});

test('listadoProduccion: sólo PLUs SIGA, costo por unidad de la receta como fuente sistema, ordenado por nombre', () => {
  const md = L.crearMayoristasDe({ vinculos: [], vigentes: new Map() });
  const filas = L.listadoProduccion({ presentaciones: [
    { productoId: 'p-granola', plu: '6319', nombre: 'Granola 500G', costoUnidad: 1000, aRevisar: [{ plu: '300', nombre: 'Harina', antes: 400, ahora: 440 }] },
    { productoId: 'p-granola', plu: 'n-nueva', nombre: 'Nueva', costoUnidad: 900 },
    { productoId: 'p-x', plu: '7000', nombre: 'Alfajor', costoUnidad: null },
  ], vigentes: new Map([['6319', 1800]]), mayoristasDe: md, costeo: { decisiones: { 6319: { fuente: 'sistema' } } }, cfg: CFG });
  assert.deepStrictEqual(filas.map(f => [f.plu, f.productoId, f.costoSistema, f.sugeridos.sistema ? f.sugeridos.sistema.minorista.precio : null, !!f.decision]),
    [['7000', 'p-x', null, null, false], ['6319', 'p-granola', 1000, 1800, true]]);
  assert.deepStrictEqual(filas.find(f => f.plu === '6319').aRevisar, [{ plu: '300', nombre: 'Harina', antes: 400, ahora: 440 }]);
  assert.strictEqual(filas.find(f => f.plu === '7000').aRevisar, null);
});

test('listadoProduccion: el margen especial del producto (margenExtra) sube el precio de todos los canales de la presentación', () => {
  const md = L.crearMayoristasDe({ vinculos: [{ plu: '50', nombre: 'Granola Bulto', basePlu: '6319', cantidad: 6, tipo: 'bulto' }], vigentes: new Map() });
  const fila = extra => L.listadoProduccion({ presentaciones: [{ productoId: 'p-g', plu: '6319', nombre: 'G', costoUnidad: 1000, margenExtra: extra }],
    vigentes: new Map(), mayoristasDe: md, costeo: {}, cfg: CFG })[0].sugeridos.sistema;
  const sin = fila(null), con = fila({ minorista: 10, bulto: 20 });
  assert.deepStrictEqual([sin.desglose.minorista.margenPct, con.desglose.minorista.margenPct, con.desglose.minorista.margenEspecialPct], [30, 40, 10]);
  assert.deepStrictEqual([sin.desglose.porVinculo['50'].margenPct, con.desglose.porVinculo['50'].margenPct], [30, 50]);
  assert.ok(con.minorista.precio > sin.minorista.precio);
  assert.ok(con.mayoristas[0].conIva > sin.mayoristas[0].conIva);
});

test('margenProducto: suma puntos al canal en Reventa (por PLU), Fraccionado (el del granel, a todas sus presentaciones) y Producción (encima del especial)', () => {
  const md = L.crearMayoristasDe({ vinculos: VINCULOS, vigentes: VIGENTES });
  const reventa = costeo => L.listadoReventa({ universo: [{ plu: '1', nombre: 'Arroz', costoSistema: 1000 }], vigentes: VIGENTES, mayoristasDe: md, costeo, cfg: CFG })[0];
  const sin = reventa({}), con = reventa({ margenProducto: { 1: { minorista: 10, bulto: -5 } } });
  assert.deepStrictEqual(con.margenProducto, { minorista: 10, bulto: -5 });
  assert.strictEqual('margenProducto' in sin, false);
  const d = con.sugeridos.sistema.desglose;
  assert.deepStrictEqual([sin.sugeridos.sistema.desglose.minorista.margenPct, d.minorista.margenPct, d.minorista.margenProductoPct], [30, 40, 10]);
  assert.deepStrictEqual([d.porVinculo['50'].margenPct, d.porVinculo['50'].margenProductoPct], [25, -5]);
  assert.ok(con.sugeridos.sistema.minorista.precio > sin.sugeridos.sistema.minorista.precio);
  // filaPublica (listado / sin permiso) no lleva el desglose con margenProductoPct; la fila sí (CLAVES_OCULTAS la saca sin permiso).
  assert.ok(!JSON.stringify(L.filaPublica(con)).includes('margenProductoPct'));

  const grupos = [{ plu: '100', nombre: 'Almendras', presentaciones: [{ plu: '101', nombre: 'Almendras 500G' }] }];
  const costos = new Map([['100', { plu: '100', nombre: 'Almendras', costoSistema: 1000 }]]);
  const fracc = costeo => L.listadoFraccionado({ grupos, costos, vigentes: new Map(), mayoristasDe: md, costeo, cfg: CFG })[0];
  const gSin = fracc({}), gCon = fracc({ margenProducto: { 100: { minorista: 10 }, 101: { minorista: 50 } } }); // el de la presentación no cuenta
  const pct = g => g.presentaciones[0].sugeridos.sistema.desglose.minorista.margenPct;
  assert.strictEqual(pct(gCon) - pct(gSin), 10);
  assert.deepStrictEqual(gCon.margenProducto, { minorista: 10 });

  const prod = costeo => L.listadoProduccion({ presentaciones: [{ productoId: 'p', plu: '6319', nombre: 'G', costoUnidad: 1000, margenExtra: { minorista: 5 } }],
    vigentes: new Map(), mayoristasDe: md, costeo, cfg: CFG })[0].sugeridos.sistema.desglose.minorista;
  const m = prod({ margenProducto: { 6319: { minorista: 10 } } });
  assert.deepStrictEqual([prod({}).margenPct, m.margenPct, m.margenEspecialPct, m.margenProductoPct], [35, 45, 5, 10]);
});

test('listadoProduccion: tipoProduccion (receta por defecto | envasado) y el costeo del envasado sólo con desglose', () => {
  const md = L.crearMayoristasDe({ vinculos: [], vigentes: new Map() });
  const lineas = [{ plu: '7067', nombre: 'Miel granel', cantidad: 0.5, costoUnit: 2800, importe: 1400, rol: 'granel' },
    { plu: '6334', nombre: 'Envase', cantidad: 1, costoUnit: 180, importe: 180, rol: 'empaque' }];
  const filas = L.listadoProduccion({ presentaciones: [
    { productoId: 'p-g', plu: '6319', nombre: 'Granola', costoUnidad: 1000 },
    { productoId: 'p-m', plu: '9001', nombre: 'Miel 500', costoUnidad: 1580, tipoProduccion: 'envasado', componentesCosto: lineas, familia: 'Miel', variedad: 'Pradera' },
  ], vigentes: new Map(), mayoristasDe: md, costeo: {}, cfg: CFG });
  assert.deepStrictEqual(filas.map(f => [f.plu, f.tipoProduccion, f.familia, f.variedad]), [['6319', 'receta', undefined, undefined], ['9001', 'envasado', 'Miel', 'Pradera']]);
  assert.deepStrictEqual([L.filaPublica(filas[1]).familia, L.filaPublica(filas[1]).variedad], ['Miel', 'Pradera']); // agrupan el listado: van sin permiso
  assert.strictEqual(filas[0].componentesCosto, undefined);
  assert.deepStrictEqual(filas[1].componentesCosto, lineas);
  assert.strictEqual(L.filaPublica(filas[1]).componentesCosto, undefined); // estructura de costos: sólo con precios-config
  assert.strictEqual(L.filaPublica(filas[1]).tipoProduccion, 'envasado');
  assert.deepStrictEqual(L.filaPublica(filas[1], true).componentesCosto, lineas);
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
  const listas = L.listasExport(items);
  const enc = ['Codigo', 'Nombre', 'Costo', 'Venta'];
  assert.deepStrictEqual(listas.minorista, [enc, [1, 'Arroz', 1000, 1800], [101, 'Almendras 500G', 1000, 1950], [102, 'Almendras 1Kg', 1000, 1800]]);
  // Pack/bulto por unidad: Costo = costo unitario (1000) en ambas listas, Venta = 1430 neto / 1750 con IVA.
  assert.deepStrictEqual(listas.bultoNeto, [enc, [50, 'Arroz Bulto x6', 1000, 1430]]);
  assert.deepStrictEqual(listas.bultoIva, [enc, [50, 'Arroz Bulto x6', 1000, 1750]]);
  assert.deepStrictEqual([listas.packNeto, listas.packIva], [[enc], [enc]]);
});

// El Costo del archivo es el de la fuente decidida tal cual se ve en pantalla, nunca el de sistema, y SIN IVA en ninguna lista.
// Pack/bulto: × unidades (1 salvo pesable por paquete: × kg).
test('listasExport Reventa: Costo y Venta de la fuente decidida (sistema 1000, última compra 1500, manual 800); pack/bulto × unidades', () => {
  const esperado = { // [Costo minorista, Venta minorista, bulto s/IVA, bulto c/IVA]
    sistema: [1000, 1800, [1000, 1430], [1000, 1750]],
    ultimaCompra: [1500, 2750, [1500, 2145], [1500, 2600]],
    manual: [800, 1450, [800, 1144], [800, 1400]],
  };
  for (const [fuente, [costoMin, ventaMin, bultoNeto, bultoIva]] of Object.entries(esperado)) {
    const almacen = L.listadoReventa({
      universo: [{ plu: '1', nombre: 'Arroz', costoSistema: 1000, costoMercaderia: 1500 }],
      vigentes: VIGENTES, mayoristasDe: L.crearMayoristasDe({ vinculos: VINCULOS, vigentes: VIGENTES }),
      costeo: { costoPorProducto: { 1: 800 }, decisiones: { 1: { fuente } } }, cfg: CFG,
    });
    const listas = L.listasExport(L.itemsDecididos({ almacen }).items);
    assert.deepStrictEqual(listas.minorista[1], [1, 'Arroz', costoMin, ventaMin], fuente);
    assert.strictEqual(listas.minorista[1][3], almacen[0].sugeridos[fuente].minorista.precio, fuente); // Venta = sugerido de la fuente
    assert.deepStrictEqual(listas.bultoNeto[1], [50, 'Arroz Bulto x6', ...bultoNeto], fuente);
    assert.deepStrictEqual(listas.bultoIva[1], [50, 'Arroz Bulto x6', ...bultoIva], fuente);
  }
});

test('listasExport Fraccionado: la decisión del granel pone su costo $/kg de esa fuente en cada presentación y en los pack/bulto (pesable por paquete × kg)', () => {
  const esperado = { // [Costo minorista, Venta 500G, Venta 1Kg, pack s/IVA, pack c/IVA]
    sistema: [1000, 1950, 1800, [1000, 1430], [1000, 1750]],
    ultimaCompra: [1500, 2950, 2750, [1500, 2145], [1500, 2600]],
    manual: [800, 1550, 1450, [800, 1144], [800, 1400]],
  };
  for (const [fuente, [costoMin, venta500, venta1k, packNeto, packIva]] of Object.entries(esperado)) {
    const fraccionado = L.listadoFraccionado({
      grupos: [{ plu: '100', nombre: 'Almendras', presentaciones: [{ plu: '101', nombre: 'Almendras 500G' }, { plu: '102', nombre: 'Almendras 1Kg' }] }],
      costos: new Map([['100', { costoSistema: 1000, costoMercaderia: 1500 }]]), vigentes: new Map(),
      mayoristasDe: L.crearMayoristasDe({ vigentes: new Map(), vinculos: [{ plu: '110', nombre: 'Almendras Pack', basePlu: '102', cantidad: 5, tipo: 'pack' }] }),
      costeo: { costoPorProducto: { 100: 800 }, decisiones: { 100: { fuente } } }, cfg: CFG,
    });
    const listas = L.listasExport(L.itemsDecididos({ fraccionado }).items);
    assert.deepStrictEqual(listas.minorista.slice(1), [[101, 'Almendras 500G', costoMin, venta500], [102, 'Almendras 1Kg', costoMin, venta1k]], fuente);
    assert.deepStrictEqual(listas.packNeto[1], [110, 'Almendras Pack', ...packNeto], fuente);
    assert.deepStrictEqual(listas.packIva[1], [110, 'Almendras Pack', ...packIva], fuente);
  }
  // Pack pesable por paquete de 5 kg: Costo = costo $/kg de la fuente × 5.
  const fraccionado = L.listadoFraccionado({
    grupos: [{ plu: '100', nombre: 'Almendras', presentaciones: [{ plu: '102', nombre: 'Almendras 1Kg' }] }],
    costos: new Map([['100', { costoSistema: 1000, costoMercaderia: 1500 }]]), vigentes: new Map(),
    mayoristasDe: L.crearMayoristasDe({ vigentes: new Map(), ventaPesable: { 110: { modo: 'paquete', pesoKg: 5 } },
      vinculos: [{ plu: '110', nombre: 'Almendras Caja 5kg', basePlu: '102', cantidad: 5, tipo: 'pack' }] }),
    costeo: { decisiones: { 100: { fuente: 'ultimaCompra' } } }, cfg: CFG,
  });
  const listas = L.listasExport(L.itemsDecididos({ fraccionado }).items);
  assert.deepStrictEqual([listas.packNeto[1].slice(0, 3), listas.packIva[1].slice(0, 3)],
    [[110, 'Almendras Caja 5kg', 7500], [110, 'Almendras Caja 5kg', 7500]]);
});

test('listasExport: el Costo es el que se ve en pantalla (sin costos extra), aunque la Venta se calcule con ellos; la presentación toma el del granel', () => {
  const costeo = { costosExtraFraccionado: { 1: [{ concepto: 'Flete', tipo: 'pct', valor: 10 }], 100: [{ concepto: 'Flete', tipo: 'pct', valor: 10 }] },
    decisiones: { 1: { fuente: 'sistema' }, 100: { fuente: 'sistema' } } };
  const almacen = L.listadoReventa({ universo: [{ plu: '1', nombre: 'Arroz', costoSistema: 1000 }], vigentes: VIGENTES,
    mayoristasDe: L.crearMayoristasDe({ vinculos: [], vigentes: VIGENTES }), costeo, cfg: CFG });
  const fraccionado = L.listadoFraccionado({
    grupos: [{ plu: '100', nombre: 'Almendras', presentaciones: [{ plu: '101', nombre: 'Almendras 500G' }] }],
    costos: new Map([['100', { costoSistema: 1000 }]]), vigentes: new Map(), mayoristasDe: L.crearMayoristasDe({ vinculos: [], vigentes: new Map() }), costeo, cfg: CFG,
  });
  assert.strictEqual(almacen[0].costos.sistema, 1100); // el sugerido sí usa costo + extras
  const listas = L.listasExport(L.itemsDecididos({ almacen, fraccionado }).items);
  assert.deepStrictEqual(listas.minorista.slice(1).map(f => f[2]), [1000, 1000]);
});

test('listasExport Producción (Aumentar): Costo = costo de la receta/envasado por unidad', () => {
  const produccion = L.listadoProduccion({
    presentaciones: [{ productoId: 'p', plu: '6319', nombre: 'Mezcla 1kg', costoUnidad: 400 }],
    vigentes: new Map(), mayoristasDe: L.crearMayoristasDe({ vinculos: [], vigentes: new Map() }),
    costeo: { decisiones: { 6319: { fuente: 'sistema' } } }, cfg: CFG,
  });
  const fila = L.listasExport(L.itemsDecididos({ produccion }).items).minorista[1];
  assert.deepStrictEqual(fila.slice(0, 3), [6319, 'Mezcla 1kg', 400]); // costo por unidad, sin IVA
  assert.strictEqual(fila[3], produccion[0].sugeridos.sistema.minorista.precio);
});

test('listasExport: Codigo (PLU) numérico en todas las listas; un código no numérico queda como texto', () => {
  const items = [
    { costo: 10, minorista: { plu: '6319', nombre: 'A', precio: 100 }, mayoristas: [{ plu: '50', nombre: 'B', tipo: 'bulto', unidades: 1, neto: 130, conIva: 160 }, { plu: '60', nombre: 'P', tipo: 'pack', unidades: 1, neto: 120, conIva: 150 }] },
    { costo: 10, minorista: { plu: 'X-1', nombre: 'C', precio: 100 }, mayoristas: [] },
  ];
  const listas = L.listasExport(items);
  for (const lista of ['minorista', 'packNeto', 'packIva', 'bultoNeto', 'bultoIva']) {
    for (const fila of listas[lista].slice(1)) assert.ok(typeof fila[0] === 'number' || fila[0] === 'X-1', `${lista}: ${typeof fila[0]}`);
  }
  assert.deepStrictEqual(listas.minorista.slice(1).map(f => f[0]), [6319, 'X-1']);
  assert.deepStrictEqual([listas.packNeto[1][0], listas.bultoIva[1][0]], [60, 50]);
});

// ── Materias primas de Producción (fase 4) ───────────────────────────────────

test('costoEnSuTab: decisión › manual › sistema, con los costos extra del PLU; fuente decidida sin dato → null', () => {
  const fila = { costoSistema: 1000, costoMercaderia: 1200 };
  const extras = { 5: [{ concepto: 'Flete', tipo: 'pct', valor: 10 }] };
  assert.deepStrictEqual(L.costoEnSuTab(fila, {}, '5'), { costo: 1000, fuente: 'sistema' });
  assert.deepStrictEqual(L.costoEnSuTab(fila, { costosExtraFraccionado: extras }, '5'), { costo: 1100, fuente: 'sistema' });
  assert.deepStrictEqual(L.costoEnSuTab(fila, { costoPorProducto: { 5: 900 } }, '5'), { costo: 900, fuente: 'manual' });
  const conManual = { costoPorProducto: { 5: 900 } };
  assert.deepStrictEqual(L.costoEnSuTab(fila, { ...conManual, decisiones: { 5: { fuente: 'ultimaCompra' } } }, '5'), { costo: 1200, fuente: 'ultimaCompra' });
  assert.deepStrictEqual(L.costoEnSuTab(fila, { ...conManual, decisiones: { 5: { fuente: 'sistema' } } }, '5'), { costo: 1000, fuente: 'sistema' });
  assert.deepStrictEqual(L.costoEnSuTab({ costoSistema: 1000 }, { decisiones: { 5: { fuente: 'ultimaCompra' } } }, '5'), { costo: null, fuente: 'ultimaCompra' });
  assert.deepStrictEqual(L.costoEnSuTab(null, {}, '5'), { costo: null, fuente: 'sistema' });
});

test('crearMayoristasDe: pesable trae su modo de venta (kg por default, paquete con kg); no pesable sin venta', () => {
  const md = L.crearMayoristasDe({ vigentes: new Map(), ventaPesable: { 61: { modo: 'paquete', pesoKg: 5 } },
    vinculos: [{ plu: '60', basePlu: '102', tipo: 'pack', cantidad: 10 }, { plu: '61', basePlu: '102', tipo: 'bulto', cantidad: 10 }] });
  assert.deepStrictEqual(md('102', true).map(m => [m.plu, m.unidades, m.venta]),
    [['60', 1, { modo: 'kg', pesoKg: null }], ['61', 5, { modo: 'paquete', pesoKg: 5 }]]);
  assert.deepStrictEqual(md('102').map(m => m.venta), [null, null]);
});

// ── Decisión temporal (spec §3): vence si SIGA cambió el precio decidido ──
test('vigentesDeFila: Reventa/Producción = su vigente + pack/bulto; granel = sus presentaciones + todos los pack/bulto', () => {
  assert.deepStrictEqual(L.vigentesDeFila({ plu: '1', vigente: 1800, mayoristas: [{ plu: '50', vigente: 1750 }] }), { 1: 1800, 50: 1750 });
  const granel = { plu: '100', vigente: null, mayoristas: [{ plu: '109', vigente: 9000 }],
    presentaciones: [{ plu: '101', vigente: 500, mayoristas: [] }, { plu: '102', vigente: null, mayoristas: [{ plu: '103', vigente: 4000 }] }] };
  assert.deepStrictEqual(L.vigentesDeFila(granel), { 101: 500, 102: null, 103: 4000, 109: 9000 });
});

test('decisionVigente: igual → vigente; cambió el minorista o una presentación → vencida; sin foto (vieja) → vencida', () => {
  const vig = new Map([['1', 1800], ['50', 1750], ['101', 500]]);
  assert.strictEqual(L.decisionVigente({ fuente: 'sistema', vigente: { 1: 1800, 50: 1750 } }, vig), true);
  assert.strictEqual(L.decisionVigente({ fuente: 'sistema', vigente: { 1: 1700, 50: 1750 } }, vig), false); // minorista importado
  assert.strictEqual(L.decisionVigente({ fuente: 'sistema', vigente: { 101: 500, 102: null } }, vig), true); // 102 sigue sin precio
  assert.strictEqual(L.decisionVigente({ fuente: 'sistema', vigente: { 101: 450, 102: null } }, vig), false); // una presentación cambió
  assert.strictEqual(L.decisionVigente({ fuente: 'sistema', fecha: '2026-10-07' }, vig), false); // legacy sin foto
});

test('podarDecisiones: saca sólo las vencidas (objeto nuevo); sin vencidas devuelve el mismo costeo', () => {
  const vig = new Map([['1', 1800]]);
  const costeo = { toleranciaPct: 3, decisiones: { 1: { fuente: 'sistema', vigente: { 1: 1800 } }, 2: { fuente: 'sistema' } } };
  const r = L.podarDecisiones(costeo, vig);
  assert.deepStrictEqual([r.podadas, Object.keys(r.costeo.decisiones), r.costeo.toleranciaPct], [1, ['1'], 3]);
  assert.deepStrictEqual(Object.keys(costeo.decisiones), ['1', '2']); // no muta
  assert.strictEqual(L.podarDecisiones(r.costeo, vig).costeo, r.costeo);
});

// ── Tipo de proveedor (Reventa): directo | distribuidor, costeo.tipoProveedor[plu] ──
test('listadoReventa: tipoProveedor viaja en la fila (también en la pública); sin dato o inválido → null', () => {
  const md = L.crearMayoristasDe({ vinculos: [], vigentes: new Map() });
  const universo = [{ plu: '1', nombre: 'A', costoSistema: 1000 }, { plu: '2', nombre: 'B', costoSistema: 1000 }, { plu: '3', nombre: 'C' }, { plu: '4', nombre: 'D' }];
  const costeo = { tipoProveedor: { 1: 'directo', 2: 'distribuidor', 3: 'otro' } };
  const filas = L.listadoReventa({ universo, vigentes: new Map(), mayoristasDe: md, costeo, cfg: CFG });
  assert.deepStrictEqual(filas.map(f => f.tipoProveedor), ['directo', 'distribuidor', null, null]);
  assert.deepStrictEqual(filas.map(f => L.filaPublica(f).tipoProveedor), ['directo', 'distribuidor', null, null]);
});

test('validarTipoProveedor: PLU de SIGA y directo | distribuidor | null; aplicarTipoProveedor devuelve un mapa nuevo (null quita)', () => {
  assert.strictEqual(L.validarTipoProveedor('1', 'directo'), null);
  assert.strictEqual(L.validarTipoProveedor('1', 'distribuidor'), null);
  assert.strictEqual(L.validarTipoProveedor('1', null), null);
  assert.match(L.validarTipoProveedor('1', 'Directo'), /tipo inválido/);
  assert.match(L.validarTipoProveedor('1', undefined), /tipo inválido/);
  assert.match(L.validarTipoProveedor('abc', 'directo'), /PLU inválido/);
  const mapa = { 1: 'directo' };
  assert.deepStrictEqual(L.aplicarTipoProveedor(mapa, '2', 'distribuidor'), { 1: 'directo', 2: 'distribuidor' });
  assert.deepStrictEqual(L.aplicarTipoProveedor(mapa, '1', null), {});
  assert.deepStrictEqual(L.aplicarTipoProveedor(undefined, '1', 'directo'), { 1: 'directo' });
  assert.deepStrictEqual(mapa, { 1: 'directo' });
});
