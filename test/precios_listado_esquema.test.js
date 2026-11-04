'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../lib/precios_listado_esquema');
const { CFG } = require('./precios_esquema_fixture');

// Precio del pack/bulto en SIGA = por unidad (respuesta del usuario 2026-10-07): el vigente del bulto es el de 1 unidad.
const VIGENTES = new Map([['1', 1800], ['50', 1430]]); // el vigente de pack/bulto en SIGA es SIN IVA (1430; con IVA serían 1750)
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
    { plu: '50', tipo: 'bulto', unidades: 1, vigente: 1430 },
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
  assert.deepStrictEqual(f.mayoristas, [{ plu: '50', nombre: 'Arroz Bulto x6', tipo: 'bulto', unidades: 1, vigente: 1430, venta: null }]);
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
  assert.strictEqual(g.presentaciones[1].sugeridos.sistema.mayoristas[0].conIva, 1650); // pack por kg (1501,5 × 0,9 desc. pack, con IVA): unidades 1
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

test('listadoReventa: el Δ% de pack/bulto es contra el vigente SIN IVA (el con IVA no se compara)', () => {
  const universo = [{ plu: '1', nombre: 'Arroz', costoSistema: 1000 }];
  const bulto = vigenteBulto => {
    const vig = new Map([['1', 1800], ['50', vigenteBulto]]);
    const [f] = L.listadoReventa({ universo, vigentes: vig, mayoristasDe: L.crearMayoristasDe({ vinculos: VINCULOS, vigentes: vig }), costeo: {}, cfg: CFG });
    return f.sugeridos.sistema.mayoristas[0];
  };
  const igual = bulto(1430); // = neto sugerido: ok. Con IVA (1750) ya no se mira
  assert.deepStrictEqual([igual.neto, igual.conIva, igual.deltaPct, igual.estado, igual.revisarUnidad], [1430, 1750, 0, 'ok', false]);
  const bajo = bulto(1300); // neto 1430 vs 1300 = +10 % → subir (tolerancia 5 %)
  assert.deepStrictEqual([bajo.deltaPct, bajo.estado], [10, 'subir']);
  assert.strictEqual(bulto(600).revisarUnidad, true); // 600 / 1430 < 0,5: parece en otra unidad
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
  assert.deepStrictEqual(listas.minorista, [enc, [1, 'Arroz', 1000, 1800], [101, 'Almendras 500G', 1000, 1950], [102, 'Almendras 1Kg', 1000, 1800], [100, 'Almendras', 1000, 1800]]);
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
    sistema: [1000, 1950, 1800, [1000, 1351.35], [1000, 1650]], // pack = $/kg minorista sin IVA × 0,9 (descuento, 2026-11-04)
    ultimaCompra: [1500, 2950, 2750, [1500, 2027.03], [1500, 2450]],
    manual: [800, 1550, 1450, [800, 1081.08], [800, 1300]],
  };
  for (const [fuente, [costoMin, venta500, venta1k, packNeto, packIva]] of Object.entries(esperado)) {
    const fraccionado = L.listadoFraccionado({
      grupos: [{ plu: '100', nombre: 'Almendras', presentaciones: [{ plu: '101', nombre: 'Almendras 500G' }, { plu: '102', nombre: 'Almendras 1Kg' }] }],
      costos: new Map([['100', { costoSistema: 1000, costoMercaderia: 1500 }]]), vigentes: new Map(),
      mayoristasDe: L.crearMayoristasDe({ vigentes: new Map(), vinculos: [{ plu: '110', nombre: 'Almendras Pack', basePlu: '102', cantidad: 5, tipo: 'pack' }] }),
      costeo: { costoPorProducto: { 100: 800 }, decisiones: { 100: { fuente } } }, cfg: CFG,
    });
    const listas = L.listasExport(L.itemsDecididos({ fraccionado }).items);
    assert.deepStrictEqual(listas.minorista.slice(1), [[101, 'Almendras 500G', costoMin, venta500], [102, 'Almendras 1Kg', costoMin, venta1k], [100, 'Almendras', costoMin, venta1k]], fuente); // + granel $/kg
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
  assert.deepStrictEqual(listas.minorista.slice(1).map(f => f[2]), [1000, 1000, 1000]); // + fila del granel
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

test('listadoReventa: el descuento distribuidor baja el margen sólo de los productos con tipoProveedor distribuidor', () => {
  const cfg = { ...CFG, margenes: { ...CFG.margenes, descuentoDistribuidorPct: 5 } };
  const md = L.crearMayoristasDe({ vinculos: [], vigentes: new Map() });
  const universo = ['1', '2', '3'].map(plu => ({ plu, nombre: plu, costoSistema: 1000 }));
  const filas = L.listadoReventa({ universo, vigentes: new Map(), mayoristasDe: md, costeo: { tipoProveedor: { 1: 'directo', 2: 'distribuidor' } }, cfg });
  const des = f => f.sugeridos.sistema.desglose.minorista;
  assert.deepStrictEqual(filas.map(f => [des(f).margenPct, des(f).descuentoDistribuidorPct]), [[30, undefined], [25, 5], [30, undefined]]);
  // 1100 × 1,25 = 1375 → × 1,05 × 1,21 = 1746,94 → 1750 (directo: 1800).
  assert.deepStrictEqual(filas.map(f => f.sugeridos.sistema.minorista.precio), [1800, 1750, 1800]);
  // Pública: precio final con el descuento, sin el desglose.
  assert.deepStrictEqual([L.filaPublica(filas[1]).sugeridos.sistema.minorista.precio, 'desglose' in L.filaPublica(filas[1]).sugeridos.sistema], [1750, false]);
});

test('validarTipoProveedor: PLU de SIGA y directo | distribuidor | null; aplicarPorPlu devuelve un mapa nuevo (null quita)', () => {
  assert.strictEqual(L.validarTipoProveedor('1', 'directo'), null);
  assert.strictEqual(L.validarTipoProveedor('1', 'distribuidor'), null);
  assert.strictEqual(L.validarTipoProveedor('1', null), null);
  assert.match(L.validarTipoProveedor('1', 'Directo'), /tipo inválido/);
  assert.match(L.validarTipoProveedor('1', undefined), /tipo inválido/);
  assert.match(L.validarTipoProveedor('abc', 'directo'), /PLU inválido/);
  const mapa = { 1: 'directo' };
  assert.deepStrictEqual(L.aplicarPorPlu(mapa, '2', 'distribuidor'), { 1: 'directo', 2: 'distribuidor' });
  assert.deepStrictEqual(L.aplicarPorPlu(mapa, '1', null), {});
  assert.deepStrictEqual(L.aplicarPorPlu(undefined, '1', 'directo'), { 1: 'directo' });
  assert.deepStrictEqual(mapa, { 1: 'directo' });
});

// ── Importar planilla (2026-10-19): la fuente sale del Costo (o del Precio) que el usuario subió a SIGA ──
// Fila mínima de Reventa: costos en pantalla y sugeridos { fuente: minorista }.
const filaPlanilla = (precios, costos = {}, extra = {}) => ({
  plu: '1', nombre: 'Arroz', tipoProveedor: 'directo', costoSistema: 1000, costoUltimaCompra: 1500, costoManual: null, ...costos, ...extra,
  sugeridos: Object.fromEntries(Object.entries(precios).map(([f, min]) => [f, { error: null, minorista: { precio: min }, mayoristas: [] }])),
});

test('emparejarFila: por Costo (costo en pantalla de cada fuente, ±0,50 estricto)', () => {
  const fila = filaPlanilla({ sistema: 1800, ultimaCompra: 2750 });
  assert.deepStrictEqual(L.emparejarFila(fila, { costo: 1000.4, precio: 9999 }), { fuente: 'sistema' });
  assert.deepStrictEqual(L.emparejarFila(fila, { costo: 1500, precio: null }), { fuente: 'ultimaCompra' });
  assert.deepStrictEqual(L.emparejarFila(filaPlanilla({ sistema: 1800, manual: 2100 }, { costoManual: 1200 }), { costo: 1200, precio: 1 }), { fuente: 'manual' });
  assert.deepStrictEqual(L.emparejarFila(fila, { costo: 1000.5, precio: null }), { motivo: 'Ningún costo ni precio coincide' });
  // costo de una fuente sin sugerido: no es candidata
  assert.deepStrictEqual(L.emparejarFila(filaPlanilla({ sistema: 1800 }), { costo: 1500, precio: 1800 }), { fuente: 'sistema' });
});

test('emparejarFila: empate por Costo → mismo minorista = la primera (sistema → ultimaCompra → manual); distinto → decide el Precio', () => {
  const igual = filaPlanilla({ sistema: 1800, ultimaCompra: 1800 }, { costoUltimaCompra: 1000 });
  assert.deepStrictEqual(L.emparejarFila(igual, { costo: 1000, precio: null }), { fuente: 'sistema' });
  const ultManual = filaPlanilla({ ultimaCompra: 1800, manual: 1800 }, { costoManual: 1500 });
  assert.deepStrictEqual(L.emparejarFila(ultManual, { costo: 1500, precio: null }), { fuente: 'ultimaCompra' });
  const distinto = filaPlanilla({ sistema: 1800, ultimaCompra: 1900 }, { costoUltimaCompra: 1000 });
  assert.deepStrictEqual(L.emparejarFila(distinto, { costo: 1000, precio: 1900.3 }), { fuente: 'ultimaCompra' });
  assert.deepStrictEqual(L.emparejarFila(distinto, { costo: 1000, precio: 2000 }), { motivo: 'Coinciden varios con precios distintos' });
  assert.deepStrictEqual(L.emparejarFila(distinto, { costo: 1000, precio: null }), { motivo: 'Coinciden varios con precios distintos' });
});

test('emparejarFila: sin Costo que coincida decide el Precio (minorista sugerido ±0,50); nada → motivo; sin sugerido', () => {
  const fila = filaPlanilla({ sistema: 1800, ultimaCompra: 2750 });
  assert.deepStrictEqual(L.emparejarFila(fila, { costo: 1234, precio: 2750.2 }), { fuente: 'ultimaCompra' });
  assert.deepStrictEqual(L.emparejarFila(fila, { costo: null, precio: 1799.6 }), { fuente: 'sistema' });
  assert.deepStrictEqual(L.emparejarFila(fila, { costo: 1234, precio: 1999 }), { motivo: 'Ningún costo ni precio coincide' });
  assert.deepStrictEqual(L.emparejarFila(filaPlanilla({ sistema: 1800, ultimaCompra: 1800.3 }), { costo: 1, precio: 1800.1 }),
    { motivo: 'Coinciden varios con precios distintos' });
  assert.deepStrictEqual(L.emparejarFila(filaPlanilla({}), { costo: 1000, precio: 1800 }), { motivo: 'Sin sugerido' });
  const conError = { ...fila, sugeridos: { sistema: { error: 'margen', minorista: null, mayoristas: [] } } };
  assert.deepStrictEqual(L.emparejarFila(conError, { costo: 1000, precio: 1800 }), { motivo: 'Sin sugerido' });
});

test('validarFilasPlanilla: código numérico (número o texto), costo/precio número o null; si no, error', () => {
  assert.deepStrictEqual(L.validarFilasPlanilla([{ codigo: 123, costo: 10, precio: null, nombre: 'A' }, { codigo: ' 45 ', costo: null, precio: 20 }]),
    { filas: [{ codigo: '123', nombre: 'A', costo: 10, precio: null }, { codigo: '45', nombre: '', costo: null, precio: 20 }] });
  assert.match(L.validarFilasPlanilla([]).error, /no tiene filas/);
  assert.match(L.validarFilasPlanilla('x').error, /no tiene filas/);
  assert.match(L.validarFilasPlanilla(Array(5001).fill({ codigo: 1, costo: 1, precio: 1 })).error, /más de 5000/);
  assert.match(L.validarFilasPlanilla([{ codigo: 'ABC', costo: 1, precio: 1 }]).error, /Fila 1/);
  assert.match(L.validarFilasPlanilla([{ codigo: 1, costo: 1, precio: 1 }, { codigo: 2, costo: '10', precio: 1 }]).error, /Fila 2/);
  assert.match(L.validarFilasPlanilla([null]).error, /Fila 1/);
});

test('cruzarPlanilla: marca por fuente (también sin clasificar), sin coincidencia con sus costos/sugeridos, no encontrados y Producción', () => {
  const almacen = [
    filaPlanilla({ sistema: 1800, ultimaCompra: 2750 }),
    { ...filaPlanilla({ sistema: 900, ultimaCompra: 950 }, { costoSistema: 500, costoUltimaCompra: 520 }), plu: '2', nombre: 'Yerba', tipoProveedor: null },
    { ...filaPlanilla({ sistema: 700 }, { costoSistema: 400, costoUltimaCompra: null }), plu: '3', nombre: 'Fideos', tipoProveedor: null },
  ];
  const r = L.cruzarPlanilla(almacen, [
    { codigo: '1', nombre: 'x', costo: 1000, precio: 1800 }, { codigo: '1', nombre: 'x', costo: 1500, precio: 2750 }, // repetido: vale la última
    { codigo: '2', nombre: 'Yerba', costo: 520, precio: 950 }, { codigo: '3', nombre: 'F', costo: 1, precio: 1 },
    { codigo: '9', nombre: 'Nuevo', costo: 1, precio: 2 }, { codigo: '6319', nombre: 'Pepas', costo: 1, precio: 2 },
  ], new Set(['6319']));
  assert.deepStrictEqual(r.decisiones.map(d => [d.plu, d.fuente, d.fila.nombre]), [['1', 'ultimaCompra', 'Arroz'], ['2', 'ultimaCompra', 'Yerba']]);
  assert.deepStrictEqual(r.marcados, { sistema: 0, ultimaCompra: 2, manual: 0 });
  assert.deepStrictEqual([r.sinClasificar, r.total], [1, 6]);
  assert.deepStrictEqual(r.sinCoincidencia, [{ codigo: '3', nombre: 'Fideos', costo: 1, precio: 1, costoSistema: 400, costoUltimaCompra: null,
    sugeridoSistema: 700, sugeridoUltimaCompra: null, motivo: 'Ningún costo ni precio coincide · Sin clasificar (no aparece en el listado)' }]);
  assert.deepStrictEqual(r.noEncontrados.map(n => [n.codigo, n.nombre, n.motivo]),
    [['9', 'Nuevo', 'Código no encontrado en Reventa'], ['6319', 'Pepas', 'Es de Producción (se decide en Producción)']]);
});

const FCx = require('../lib/precios_fraccionado_costo');

test('agruparPorGranel: cada grupo lleva el subrubro de su granel', () => {
  const [g] = L.agruparPorGranel({ graneles: [{ plu: '100', nombre: 'Almendras', subrubroId: '7', subrubro: 'Frutos secos' }],
    presentaciones: [{ plu: '101', nombre: 'Almendras 500G' }], formulas: { 101: { granel: '100' } }, costos: new Map() });
  assert.deepStrictEqual([g.subrubroId, g.subrubro], ['7', 'Frutos secos']);
});

test('listadoFraccionado con costeoF: (min/kg del subrubro + ajuste del tramo) × kg, sin máquina por defecto, insumos del peso de la presentación', () => {
  const grupos = [{ plu: '100', nombre: 'Almendras', subrubroId: '7', subrubro: 'Frutos secos', presentaciones: [{ plu: '101', nombre: 'Almendras 500G' }] }];
  const costos = new Map([['100', { plu: '100', nombre: 'Almendras', costoSistema: 1000, costoMercaderia: null }],
    ['900', { plu: '900', nombre: 'Bolsa 500g', costoSistema: 20, costoMercaderia: null }]]);
  const costeoF = FCx.normalizarCosteoFraccionado({
    costoHora: 6000, maquinas: [{ id: 'env', nombre: 'Envasadora', costoHora: 3000 }],
    tramosTiempo: [{ hastaG: 500, minKg: 1 }, { hastaG: 1000, minKg: 0 }],
    subrubros: { 7: { minKg: 1, facilidad: 'facil' } },
    envasePorPeso: { 500: { bolsaPlu: '900' } },
  });
  const armar = (cf, costeo = {}) => L.listadoFraccionado({ grupos, costos, vigentes: new Map(), mayoristasDe: () => [], costeo, cfg: CFG, costeoF: cf })[0];
  const g = armar(costeoF);
  const p = g.presentaciones[0];
  // (1 + 1) × 0,5 = 1 min: MO 100 + bolsa 20 = 120 por unidad ÷ 0,5 kg = 240 $/kg → 1000 + 240
  assert.strictEqual(p.costos.sistema, 1240);
  assert.strictEqual(p.sugeridos.sistema.minorista.precio, L.preciosDeCosto({ cfg: CFG, tipo: 'fraccionado', costo: 1240, pesoG: 500 }).minorista.precio);
  assert.deepStrictEqual(p.costeoPresentacion, { minutos: 1, minKg: 1, minKgOrigen: 'subrubro', ajusteMinKg: 1, porUnidad: 120, extraKg: 240 });
  assert.deepStrictEqual(p.componentesCosto.map(l => l.rol), ['granel', 'insumo', 'mo']);
  assert.deepStrictEqual(p.componentesCosto[0], { plu: '100', nombre: 'Almendras', rol: 'granel', cantidad: 0.5, costoUnit: 1000, importe: 500, fuente: 'sistema' });
  assert.deepStrictEqual([p.componentesCosto[1].nombre, 'fraccPresentacion' in p], ['Bolsa 500g', false]);
  assert.deepStrictEqual([p.avisosCosto, g.avisosCosto], [[], []]);
  assert.deepStrictEqual(g.costeoGranel, { maquinaId: null, maquina: null, minKgPropio: null, minKgSubrubro: 1, minKgOrigen: 'subrubro', envase: 'bolsa', subrubroId: '7', subrubro: 'Frutos secos' });
  assert.strictEqual(g.costos.sistema, 1000); // el granel (decisión, rango, pack/bulto del granel) sigue con su mercadería
  // La mercadería de la línea granel sigue la fuente del granel en su tab (costo manual > sistema), como en Producción
  const gm = armar(costeoF, { costoPorProducto: { 100: 1200 } });
  assert.deepStrictEqual([gm.presentaciones[0].componentesCosto[0].costoUnit, gm.presentaciones[0].componentesCosto[0].importe, gm.presentaciones[0].componentesCosto[0].fuente], [1200, 600, 'manual']);
  // Granel con min/kg propio 3 y máquina: (3 + 1) × 0,5 = 2 min; MO 200 + máquina 100 + bolsa 20 = 320 → 640 $/kg
  const ge = armar({ ...costeoF, porGranel: { 100: { minKg: 3, maquinaId: 'env' } } });
  assert.deepStrictEqual(ge.costeoGranel, { maquinaId: 'env', maquina: 'Envasadora', minKgPropio: 3, minKgSubrubro: 1, minKgOrigen: 'granel', envase: 'bolsa', subrubroId: '7', subrubro: 'Frutos secos' });
  assert.deepStrictEqual([ge.presentaciones[0].costeoPresentacion.minutos, ge.presentaciones[0].costos.sistema], [2, 1640]);
  // Listado público: sin costos ni desglose; los avisos sí
  const pub = L.filaPublica(g);
  assert.deepStrictEqual([pub.presentaciones[0].componentesCosto, pub.presentaciones[0].costeoPresentacion, pub.presentaciones[0].avisosCosto],
    [undefined, undefined, []]);
});

test('listadoFraccionado: con la config actual de dev (13 subrubros sólo con facilidad/tiempo) los sugeridos no cambian (sin minutos, aviso sinMinutos)', () => {
  const grupos = [{ plu: '100', nombre: 'Almendras', subrubroId: '7', subrubro: 'Frutos secos', presentaciones: [{ plu: '101', nombre: 'Almendras 500G' }, { plu: '102', nombre: 'Almendras 1KG' }] }];
  const costos = new Map([['100', { plu: '100', nombre: 'Almendras', costoSistema: 1000, costoMercaderia: 900 }]]);
  const subrubros = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [String(i + 1), { facilidad: ['facil', 'normal', 'dificil'][i % 3], tiempo: 'normal' }]));
  const dev = FCx.normalizarCosteoFraccionado({ costoHora: 6000, escalas: { facilidad: { facil: 1, normal: 1.25, dificil: 1.5 } }, subrubros, maquinas: [], porGranel: {}, insumosPorPeso: {} }); // insumosPorPeso vacío como el data/costeo.json de dev: se ignora
  const armar = cf => L.listadoFraccionado({ grupos, costos, vigentes: new Map(), mayoristasDe: () => [], costeo: {}, cfg: CFG, costeoF: cf })[0];
  const sinCosteo = L.listadoFraccionado({ grupos, costos, vigentes: new Map(), mayoristasDe: () => [], costeo: {}, cfg: CFG })[0];
  const g = armar(dev);
  assert.deepStrictEqual(g.presentaciones.map(p => p.sugeridos), sinCosteo.presentaciones.map(p => p.sugeridos));
  assert.deepStrictEqual(g.presentaciones.map(p => p.costeoPresentacion.minutos), [0, 0]);
  assert.deepStrictEqual(g.avisosCosto, ['sinMinutos', 'sinBolsa']);
});

test('listadoFraccionado con costeoF: insumo sin costo → la presentación queda sin sugerido y con el faltante', () => {
  const grupos = [{ plu: '100', nombre: 'Almendras', subrubroId: '7', presentaciones: [{ plu: '101', nombre: 'Almendras 500G' }] }];
  const costos = new Map([['100', { plu: '100', nombre: 'Almendras', costoSistema: 1000 }]]);
  const costeoF = FCx.normalizarCosteoFraccionado({ envasePorPeso: { 500: { bolsaPlu: '901' } } });
  const [g] = L.listadoFraccionado({ grupos, costos, vigentes: new Map(), mayoristasDe: () => [], costeo: {}, cfg: CFG, costeoF });
  assert.deepStrictEqual([g.presentaciones[0].sugeridos, g.presentaciones[0].faltantesCosto], [{}, ['901']]);
});

test('listadoFraccionado con costeoF: granel sin costo en una fuente → sin sugerido en esa fuente, sin faltante si otra fuente lo tiene', () => {
  const grupos = [{ plu: '100', nombre: 'Almendras', subrubroId: '7', presentaciones: [{ plu: '101', nombre: 'Almendras 500G' }, { plu: '102', nombre: 'Almendras 1KG' }] }];
  const costos = new Map([['100', { plu: '100', nombre: 'Almendras', costoSistema: 1000, costoMercaderia: null }]]);
  const costeoF = FCx.normalizarCosteoFraccionado({ envasePorPeso: { 1000: { bolsaPlu: '901' } } });
  const costeo = { decisiones: { 100: { fuente: 'ultimaCompra' } } }; // decidió última compra y el granel no tiene
  const [g] = L.listadoFraccionado({ grupos, costos, vigentes: new Map(), mayoristasDe: () => [], costeo, cfg: CFG, costeoF });
  const [p500, p1kg] = g.presentaciones;
  // la línea del granel queda sin importe, pero la presentación sigue con el sugerido de sistema y sin badge "sin costo"
  assert.deepStrictEqual([p500.componentesCosto[0].importe, p500.faltantesCosto, Object.keys(p500.sugeridos)], [null, [], ['sistema']]);
  assert.deepStrictEqual([p1kg.faltantesCosto, Object.keys(p1kg.sugeridos)], [['901'], []]); // el insumo sin costo sí la deja sin sugerido
  // con costo en la fuente decidida no hay faltante
  const [ok] = L.listadoFraccionado({ grupos, costos, vigentes: new Map(), mayoristasDe: () => [], costeo: {}, cfg: CFG, costeoF });
  assert.deepStrictEqual(ok.presentaciones[0].faltantesCosto, []);
  // sólo última compra (sin costo de sistema): sugerido de última compra, sin faltante
  const soloUlt = new Map([['100', { plu: '100', nombre: 'Almendras', costoSistema: null, costoMercaderia: 900 }]]);
  const [u] = L.listadoFraccionado({ grupos, costos: soloUlt, vigentes: new Map(), mayoristasDe: () => [], costeo: {}, cfg: CFG, costeoF });
  assert.deepStrictEqual([Object.keys(u.presentaciones[0].sugeridos), u.presentaciones[0].faltantesCosto], [['ultimaCompra'], []]);
  // granel sin ningún costo: ninguna presentación tiene sugerido
  const sinCosto = new Map([['100', { plu: '100', nombre: 'Almendras', costoSistema: null, costoMercaderia: null }]]);
  const [s] = L.listadoFraccionado({ grupos, costos: sinCosto, vigentes: new Map(), mayoristasDe: () => [], costeo: {}, cfg: CFG, costeoF });
  assert.deepStrictEqual(s.presentaciones.map(p => Object.keys(p.sugeridos)), [[], []]);
});

// Actividad de Fraccionado (spec 2026-10-26): REEFER por nombre; activo automático = granel y alguna presentación con
// movimientos; activoGranel manual gana; sin consulta (movimientos null) nadie queda inactivo salvo a mano.
const GRUPOS_ACT = [
  { plu: '100', nombre: 'Almendras', presentaciones: [{ plu: '101', nombre: 'Almendras 500G' }, { plu: '102', nombre: 'Almendras 1Kg' }] },
  { plu: '200', nombre: 'Nueces REEFER', presentaciones: [] },
  { plu: '300', nombre: 'Pasas Reefers', presentaciones: [{ plu: '301', nombre: 'Pasas 500G' }] },
  { plu: '400', nombre: 'Maní', presentaciones: [{ plu: '401', nombre: 'Maní 500G' }] },
  { plu: null, nombre: 'Sin granel asignado', presentaciones: [{ plu: '104', nombre: 'Rara 50G' }] },
];
const fraccAct = (movimientos, activoGranel) => L.listadoFraccionado({ grupos: GRUPOS_ACT, costos: new Map(), vigentes: new Map(),
  mayoristasDe: L.crearMayoristasDe({ vinculos: [], vigentes: new Map() }), costeo: activoGranel ? { activoGranel } : {}, cfg: CFG, movimientos });

test('listadoFraccionado actividad: REEFER, auto con motivos, manual gana, "Sin granel" siempre activo; movReciente por presentación', () => {
  const mov = new Map([['100', { n: 3, ultimo: '2026-10-01' }], ['101', { n: 1, ultimo: '2026-09-01' }], ['200', { n: 2, ultimo: '2026-08-01' }], ['401', { n: 1, ultimo: '2026-07-01' }]]);
  const [alm, nue, pas, man, sin] = fraccAct(mov, { 300: true, 100: false, 999: 'x' });
  assert.deepStrictEqual(alm.actividad, { auto: 'activo', motivos: [], ultimoMovGranel: '2026-10-01', presentacionesActivas: 1 });
  assert.deepStrictEqual([alm.reefer, alm.activoManual, alm.activo], [false, false, false]); // fijado inactivo a mano
  const almP = Object.fromEntries(alm.presentaciones.map(p => [p.plu, p.movReciente]));
  assert.deepStrictEqual(almP, { 101: true, 102: false });
  assert.deepStrictEqual([nue.reefer, nue.actividad.auto, nue.actividad.motivos, nue.activo], [true, 'inactivo', ['sinPresentaciones'], false]);
  assert.deepStrictEqual([pas.reefer, pas.actividad.motivos, pas.activoManual, pas.activo], [false, ['sinMovGranel', 'sinMovPresentaciones'], true, true]);
  assert.deepStrictEqual([man.actividad.motivos, man.actividad.ultimoMovGranel, man.activoManual, man.activo], [['sinMovGranel'], null, null, false]);
  assert.deepStrictEqual([sin.reefer, sin.actividad, sin.activoManual, sin.activo, sin.presentaciones[0].movReciente], [false, null, null, true, false]);
  // viajan a todos los usuarios (filaPublica no los saca)
  const pub = L.filaPublica(alm);
  assert.deepStrictEqual([pub.reefer, pub.activo, pub.activoManual, pub.actividad.auto, pub.presentaciones[0].movReciente], [false, false, false, 'activo', true]);
});

test('listadoFraccionado actividad sin movimientos (consulta caída): actividad null, activo salvo fijado a mano; REEFER igual', () => {
  const [alm, nue, pas] = fraccAct(null, { 100: false, 300: true });
  assert.deepStrictEqual([alm.actividad, alm.activo, alm.presentaciones[0].movReciente], [null, false, null]);
  assert.deepStrictEqual([nue.reefer, nue.actividad, nue.activoManual, nue.activo], [true, null, null, true]);
  assert.strictEqual(pas.activo, true);
});

test('validarActivoGranel: PLU de SIGA y true | false | null; aplicarPorPlu con booleanos (false queda, null quita)', () => {
  assert.strictEqual(L.validarActivoGranel('100', true), null);
  assert.strictEqual(L.validarActivoGranel('100', false), null);
  assert.strictEqual(L.validarActivoGranel('100', null), null);
  for (const v of [undefined, 'true', 1, 0]) assert.match(L.validarActivoGranel('100', v), /activo inválido/, String(v));
  assert.match(L.validarActivoGranel('abc', true), /PLU inválido/);
  assert.deepStrictEqual(L.aplicarPorPlu({ 1: true }, '2', false), { 1: true, 2: false });
  assert.deepStrictEqual(L.aplicarPorPlu({ 1: true }, '1', null), {});
});

// ── Precio fijo de Reventa (costeo.precioFijo): sugeridos.precio, decisión 'precio' y export ──
const arroz = (extra = {}, costeo = {}) => L.listadoReventa({ universo: [{ plu: '1', nombre: 'Arroz', costoSistema: 1000, ...extra }], vigentes: VIGENTES,
  mayoristasDe: L.crearMayoristasDe({ vinculos: VINCULOS, vigentes: VIGENTES }), costeo, cfg: CFG })[0];
const conPrecio = (precio = { minorista: 3999 }) => ({ precioFijo: { 1: precio } });

test('listadoReventa: con precio fijo hay sugeridos.precio (precio exacto, fuenteRef, margen de las tablas en el desglose); las otras fuentes no cambian', () => {
  const sin = arroz();
  const f = arroz({}, conPrecio({ minorista: 3999, bulto: 2000 }));
  assert.deepStrictEqual(f.precioFijo, { minorista: 3999, bulto: 2000 });
  assert.deepStrictEqual(Object.keys(f.sugeridos), ['sistema', 'precio']);
  assert.deepStrictEqual(f.sugeridos.sistema, sin.sugeridos.sistema); // nunca con el precio fijo
  assert.strictEqual(f.margenProducto, undefined);
  const p = f.sugeridos.precio;
  assert.strictEqual(p.fuenteRef, 'sistema');
  assert.deepStrictEqual(p.minorista, { precio: 3999, margenTotalPct: 299.9, deltaPct: 122.2, estado: 'subir' });
  assert.deepStrictEqual([p.mayoristas[0].neto, p.mayoristas[0].conIva], [2000, 2400]);
  assert.strictEqual(p.desglose.minorista.margenPct, 186.14);
  assert.strictEqual(p.desglose.minorista.margenProductoModo, 'precio');
  assert.strictEqual(sin.precioFijo, undefined);
  assert.ok(!('precio' in sin.sugeridos));
});

test('listadoReventa: el costo de referencia del precio fijo es sistema › última compra › manual; sin ninguno no hay sugeridos.precio', () => {
  const ref = (extra, costeo = {}) => (arroz(extra, { ...conPrecio(), ...costeo }).sugeridos.precio || {}).fuenteRef;
  assert.strictEqual(ref({ costoMercaderia: 1500 }), 'sistema');
  assert.strictEqual(ref({ costoSistema: null, costoMercaderia: 1500 }), 'ultimaCompra');
  assert.strictEqual(ref({ costoSistema: null }, { costoPorProducto: { 1: 800 } }), 'manual');
  assert.strictEqual(ref({ costoSistema: null }), undefined);
  // El precio fijo no depende de la fuente: con otro costo de referencia el precio es el mismo y cambia el margen.
  const m = e => arroz(e, conPrecio()).sugeridos.precio;
  assert.strictEqual(m({ costoSistema: null, costoMercaderia: 1500 }).minorista.precio, 3999);
  assert.notStrictEqual(m({ costoSistema: null, costoMercaderia: 1500 }).desglose.minorista.margenPct, m({}).desglose.minorista.margenPct);
});

test('listadoReventa: un margenProducto modo "precio" viejo (1bdc433) se ignora; fijo y ajuste siguen igual', () => {
  const sin = arroz();
  const viejo = arroz({}, { margenProducto: { 1: { modo: 'precio', minorista: 3999 } } });
  assert.deepStrictEqual(viejo.sugeridos, sin.sugeridos);
  assert.strictEqual(viejo.margenProducto, undefined);
  assert.deepStrictEqual(arroz({}, { margenProducto: { 1: { modo: 'fijo', minorista: 50 } } }).margenProducto, { modo: 'fijo', minorista: 50 });
});

test('filaPublica: el precio fijo y fuenteRef viajan; el desglose (margenPct, margenGeneralPct) no', () => {
  const pub = L.filaPublica(arroz({}, conPrecio()));
  assert.deepStrictEqual(pub.precioFijo, { minorista: 3999 });
  assert.strictEqual(pub.sugeridos.precio.fuenteRef, 'sistema');
  assert.ok(!('desglose' in pub.sugeridos.precio));
  assert.ok(!JSON.stringify(pub).includes('margenGeneralPct'));
});

test('validarDecision: "precio" pasa (lo valida contra las filas); las demás fuentes no cambian', () => {
  assert.strictEqual(L.validarDecision('5', 'precio', { precioFijo: { 5: { minorista: 10 } } }), null);
  assert.strictEqual(L.validarDecision('5', 'precio', {}), null); // sin precio fijo lo rechaza validarDecisionContraFilas (granel de Fraccionado)
  assert.match(L.validarDecision('5', 'otra', {}), /fuente inválida: sistema, ultimaCompra, manual, precio o null/);
  assert.strictEqual(L.validarDecision('5', 'sistema', {}), null);
});

test('validarDecisionContraFilas: "precio" sólo en una fila de Reventa con sugeridos.precio (Producción y Fraccionado nunca lo tienen)', () => {
  assert.strictEqual(L.validarDecisionContraFilas({ almacen: [arroz({}, conPrecio())] }, '1', 'precio'), null);
  assert.match(L.validarDecisionContraFilas({ almacen: [arroz()] }, '1', 'precio'), /no tiene precio fijo cargado/);
  assert.match(L.validarDecisionContraFilas({ almacen: [arroz({ costoSistema: null }, conPrecio())] }, '1', 'precio'), /no tiene precio fijo cargado/); // sin costo de referencia
  const [p] = L.listadoProduccion({ presentaciones: [{ plu: '6319', nombre: 'Mezcla', costoUnidad: 1000 }], vigentes: new Map(),
    mayoristasDe: L.crearMayoristasDe({ vinculos: [], vigentes: new Map() }), costeo: { precioFijo: { 6319: { minorista: 5 } } }, cfg: CFG });
  assert.match(L.validarDecisionContraFilas({ produccion: [p] }, '6319', 'precio'), /no tiene precio fijo cargado/);
});

test('costoEnSuTab: la decisión "precio" (precio fijo de Reventa) no es un costo: la materia prima queda como sin decisión', () => {
  const fila = { costoSistema: 1000, costoMercaderia: 1200 };
  const decisiones = { 5: { fuente: 'precio' } };
  assert.deepStrictEqual(L.costoEnSuTab(fila, { decisiones }, '5'), { costo: 1000, fuente: 'sistema' });
  assert.deepStrictEqual(L.costoEnSuTab(fila, { decisiones, costoPorProducto: { 5: 900 } }, '5'), { costo: 900, fuente: 'manual' });
});

test('export con la decisión "precio": Venta = el precio fijo, Costo = el costo en pantalla de la fuente de referencia; sin costo de referencia se omite', () => {
  const decidida = f => ({ ...f, decision: { fuente: 'precio' } });
  const { items, omitidos } = L.itemsDecididos({ almacen: [decidida(arroz({}, conPrecio({ minorista: 3999, bulto: 2000 })))] });
  assert.strictEqual(omitidos, 0);
  const listas = L.listasExport(items);
  assert.deepStrictEqual(listas.minorista[1], [1, 'Arroz', 1000, 3999]);
  assert.deepStrictEqual(listas.bultoNeto[1], [50, 'Arroz Bulto x6', 1000, 2000]);
  assert.deepStrictEqual(listas.bultoIva[1], [50, 'Arroz Bulto x6', 1000, 2400]);
  // Costo de referencia = última compra: el Costo exportado es el de la última compra tal cual se ve (1500), no el de sistema.
  const ultima = L.listasExport(L.itemsDecididos({ almacen: [decidida(arroz({ costoSistema: null, costoMercaderia: 1500 }, conPrecio()))] }).items);
  assert.deepStrictEqual(ultima.minorista[1], [1, 'Arroz', 1500, 3999]);
  assert.strictEqual(L.itemsDecididos({ almacen: [decidida(arroz({ costoSistema: null }, conPrecio()))] }).omitidos, 1);
});

test('aplicarPrecioFijo: guarda por PLU; quitar borra el precio fijo y sólo la decisión "precio" de ese PLU', () => {
  const costeo = { precioFijo: { 1: { minorista: 10 }, 2: { minorista: 20 } }, decisiones: { 1: { fuente: 'precio' }, 2: { fuente: 'precio' } } };
  assert.deepStrictEqual(L.aplicarPrecioFijo(costeo, '1', { minorista: 15, bulto: 3 }), { precioFijo: { 1: { minorista: 15, bulto: 3 }, 2: { minorista: 20 } } });
  assert.deepStrictEqual(L.aplicarPrecioFijo(costeo, '1', null), { precioFijo: { 2: { minorista: 20 } }, decisiones: { 2: { fuente: 'precio' } } });
  assert.deepStrictEqual(L.aplicarPrecioFijo({ ...costeo, decisiones: { 1: { fuente: 'sistema' } } }, '1', null), { precioFijo: { 2: { minorista: 20 } } }); // otra fuente: se respeta
  assert.deepStrictEqual(L.aplicarPrecioFijo({}, '1', null), { precioFijo: {} });
  assert.strictEqual(L.validarPluSiga('123'), null);
  assert.match(L.validarPluSiga('x1'), /PLU inválido/);
});

test('precio fijo con un canal vacío (bulto con vínculo y sin precio): ese canal sale con el margen general y se exporta igual', () => {
  const sin = arroz();
  const f = arroz({}, conPrecio({ minorista: 3999 }));
  const [bulto] = f.sugeridos.precio.mayoristas;
  const [general] = sin.sugeridos.sistema.mayoristas; // mismo costo de referencia (sistema) y margen de las tablas
  assert.deepStrictEqual([bulto.plu, bulto.neto, bulto.conIva], [general.plu, general.neto, general.conIva]);
  assert.ok(bulto.conIva != null);
  const listas = L.listasExport(L.itemsDecididos({ almacen: [{ ...f, decision: { fuente: 'precio' } }] }).items);
  assert.deepStrictEqual(listas.minorista[1], [1, 'Arroz', 1000, 3999]);
  assert.deepStrictEqual(listas.bultoIva[1], [50, 'Arroz Bulto x6', 1000, general.conIva]);
});

test('listadoFraccionado con costeoF: granel en bobina → línea _bobina, costeoGranel.envase bobina; sin peso de bolsa → sinBobina; sin permiso no viaja costeoGranel', () => {
  // Arrange
  const grupos = [{ plu: '100', nombre: 'Almendras', subrubroId: '7', presentaciones: [{ plu: '101', nombre: 'Almendras 500G' }, { plu: '102', nombre: 'Almendras 1KG' }] }];
  const costos = new Map([['100', { plu: '100', nombre: 'Almendras', costoSistema: 1000 }]]);
  const costeoF = FCx.normalizarCosteoFraccionado({ costoBobinaKg: 6000, porGranel: { 100: { envase: 'bobina' } },
    envasePorPeso: { 500: { bolsaPlu: '900', bobinaG: 8 }, 1000: { bolsaPlu: '900' } } });
  // Act
  const [g] = L.listadoFraccionado({ grupos, costos, vigentes: new Map(), mayoristasDe: () => [], costeo: {}, cfg: CFG, costeoF });
  const [p500, p1kg] = g.presentaciones;
  // Assert: 8 g × 6000 = 48 por unidad ÷ 0,5 kg = 96 $/kg (sin minutos)
  assert.deepStrictEqual(p500.componentesCosto[1], { plu: '_bobina', nombre: 'Bobina', rol: 'insumo', origen: 'bobina', cantidad: 0.008, costoUnit: 6000, importe: 48 });
  assert.strictEqual(p500.costos.sistema, 1096);
  assert.deepStrictEqual([p1kg.avisosCosto, p1kg.costos.sistema], [['sinMinutos', 'sinBobina'], 1000]);
  assert.strictEqual(g.costeoGranel.envase, 'bobina');
  const pub = require('../lib/precios_permisos').sinClavesOcultas(L.filaPublica(g));
  assert.deepStrictEqual(['costeoGranel' in pub, pub.avisosCosto], [false, ['sinMinutos', 'sinBobina']]);
});

// ── Precio fijo de Fraccionado (spec precios_fraccionado_precio_fijo_card): precio de la presentación (bolsa) → $/kg ──
const ALMENDRAS = [{ plu: '100', nombre: 'Almendras', presentaciones: [{ plu: '102', nombre: 'Almendras 1Kg' }, { plu: '101', nombre: 'Almendras 500G' }] }];
const almendras = (costeo = {}) => L.listadoFraccionado({ grupos: ALMENDRAS, costos: new Map([['100', { plu: '100', nombre: 'Almendras', costoSistema: 1000 }]]),
  vigentes: new Map(), mayoristasDe: () => [], costeo, cfg: CFG })[0];

test('listadoFraccionado: precio fijo de la presentación (bolsa con IVA) → sugeridos.precio en $/kg; las demás con margen general; el granel también trae sugeridos.precio', () => {
  const sin = almendras();
  const g = almendras({ precioFijo: { 101: { minorista: 1000 } } });
  const [p500, p1k] = g.presentaciones;
  assert.deepStrictEqual(p500.precioFijo, { minorista: 1000 });
  const s = p500.sugeridos.precio;
  assert.deepStrictEqual([s.precioPresentacion, s.precioKg, s.minorista.precio, s.minorista.margenTotalPct, s.fuenteRef], [1000, 2000, 2000, 100, 'sistema']);
  assert.strictEqual(s.desglose.minorista.margenProductoModo, 'precio');
  assert.deepStrictEqual(p500.sugeridos.sistema, sin.presentaciones[0].sugeridos.sistema); // la fuente de costo no cambia
  assert.strictEqual(p1k.precioFijo, undefined);
  assert.strictEqual(p1k.sugeridos.precio.minorista.precio, p1k.sugeridos.sistema.minorista.precio); // sin precio fijo: margen general
  assert.ok(!('precioPresentacion' in p1k.sugeridos.precio));
  assert.strictEqual(g.sugeridos.precio.fuenteRef, 'sistema');
  assert.ok(!('precio' in sin.sugeridos) && sin.presentaciones.every(p => !('precio' in p.sugeridos)));
  assert.strictEqual(L.filaPublica(g).presentaciones[0].precioFijo.minorista, 1000);
  assert.ok(!('desglose' in L.filaPublica(g).presentaciones[0].sugeridos.precio));
});

test('validarDecision / ContraFilas: "precio" en el granel vale si alguna presentación tiene precio fijo; si no, error claro', () => {
  const con = almendras({ precioFijo: { 101: { minorista: 1000 } } });
  assert.strictEqual(L.validarDecision('100', 'precio', {}), null); // el precio fijo lo mira contra las filas
  assert.strictEqual(L.validarDecisionContraFilas({ fraccionado: [con] }, '100', 'precio'), null);
  assert.match(L.validarDecisionContraFilas({ fraccionado: [almendras()] }, '100', 'precio'), /no tiene precio fijo cargado/);
});

test('export Fraccionado con decisión "precio": la presentación fija sale a su $/kg, las otras con margen general, Costo = el del granel', () => {
  const g = { ...almendras({ precioFijo: { 101: { minorista: 1000 } } }), decision: { fuente: 'precio' } };
  const { items, omitidos } = L.itemsDecididos({ fraccionado: [g] });
  assert.strictEqual(omitidos, 0);
  const min = L.listasExport(items).minorista.slice(1);
  assert.deepStrictEqual(min.find(r => r[0] === 101), [101, 'Almendras 500G', 1000, 2000]);
  assert.deepStrictEqual(min.find(r => r[0] === 102), [102, 'Almendras 1Kg', 1000, g.presentaciones[1].sugeridos.sistema.minorista.precio]);
});

test('listadoFraccionado: decisión "precio" sin presentación fija vigente (ej. quedó mayorista) → sin decisión + decisionPrecioSinVigente', () => {
  const g = almendras({ decisiones: { 100: { fuente: 'precio' } } });
  assert.strictEqual(g.decision, null);
  assert.strictEqual(g.decisionPrecioSinVigente, true);
  assert.strictEqual(almendras({ precioFijo: { 101: { minorista: 1000 } }, decisiones: { 100: { fuente: 'precio' } } }).decisionPrecioSinVigente, undefined);
  assert.strictEqual(almendras({ decisiones: { 100: { fuente: 'sistema' } } }).decision.fuente, 'sistema');
});

test('aplicarPrecioFijo con granel: quitar la última presentación fija borra la decisión "precio" del granel; quitar una de varias no', () => {
  const costeo = { precioFijo: { 101: { minorista: 1 }, 102: { minorista: 2 } }, decisiones: { 100: { fuente: 'precio' } } };
  assert.deepStrictEqual(L.aplicarPrecioFijo(costeo, '101', null, { granel: '100', presentaciones: ['101', '102'] }), { precioFijo: { 102: { minorista: 2 } } });
  assert.deepStrictEqual(L.aplicarPrecioFijo({ ...costeo, precioFijo: { 101: { minorista: 1 } } }, '101', null, { granel: '100', presentaciones: ['101', '102'] }),
    { precioFijo: {}, decisiones: {} });
});

test('con costeo.fraccionado: presentación fija que queda mayorista (porPlu o pesoMinG) deja "precio" huérfana y el export no la decide; si deja de ser mayorista, vuelve', () => {
  const base = { precioFijo: { 101: { minorista: 1000 } }, decisiones: { 100: { fuente: 'precio' } } };
  const conMay = mayorista => L.listadoFraccionado({ grupos: ALMENDRAS, costos: new Map([['100', { plu: '100', nombre: 'Almendras', costoSistema: 1000 }]]),
    vigentes: new Map(), mayoristasDe: () => [], costeo: base, cfg: CFG, costeoF: FCx.normalizarCosteoFraccionado({ mayorista }) })[0];
  for (const may of [{ porPlu: { 101: 'bulto' } }, { pesoMinG: 500 }]) {
    const g = conMay(may);
    assert.strictEqual(g.presentaciones[0].mayorista, true);
    assert.strictEqual(g.decision, null);
    assert.strictEqual(g.decisionPrecioSinVigente, true);
    assert.ok(!('precio' in g.sugeridos));
    const { items } = L.itemsDecididos({ fraccionado: [g] });
    assert.strictEqual(items.length, 0);
  }
  const vuelve = conMay({ porPlu: { 101: false }, pesoMinG: 500 });
  assert.strictEqual(vuelve.presentaciones[0].mayorista, false);
  assert.strictEqual(vuelve.decision.fuente, 'precio');
  assert.strictEqual(vuelve.decisionPrecioSinVigente, undefined);
  assert.ok(L.itemsDecididos({ fraccionado: [vuelve] }).items.length > 0);
});
