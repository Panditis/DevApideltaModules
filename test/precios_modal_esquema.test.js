'use strict';
// Contrato server → modal: las filas por canal salen de lo que manda el detalle (lib/precios_listado_esquema filaPublica).
const test = require('node:test');
const assert = require('node:assert');
const L = require('../lib/precios_listado_esquema');
const { filasCanales, ventaPayload, opcionesCosto, opcionesSelect, errorMotor, estadoDecision, conceptosCosto, pasosAjusteMd, generalesCanalMd, igualarSigaMd } = require('../public/js/precios_modal_esquema.js');
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

test('opcionesSelect: texto compacto con precio y Δ% (mismos números que el modal); sin precio → deshabilitada con su motivo', () => {
  const md = L.crearMayoristasDe({ vinculos: [], vigentes });
  const pub = o => L.filaPublica(L.listadoReventa({ universo: [{ plu: '1', nombre: 'Arroz', costoSistema: 1000 }], vigentes, mayoristasDe: md, costeo: {}, cfg: CFG, ...o })[0]);
  const ops = opcionesSelect(pub(), 'almacen');
  assert.deepStrictEqual(ops.map(o => [o.valor, o.texto, o.disabled]), [
    ['', 'No cambiar', false], ['sistema', 'Sistema · $ 1.800 (0.0%)', false], ['ultimaCompra', 'Última compra · Sin compras registradas', true]]);
  // Mismas cifras que opcionesCosto (la fuente del modal): precio y Δ% de cada opción.
  const modal = opcionesCosto(pub(), 'almacen');
  assert.deepStrictEqual(ops.map(o => o.valor), modal.map(o => o.valor));
  assert.deepStrictEqual(ops.map(o => o.disabled), modal.map(o => !o.disponible));
  // Con costo manual aparece "Manual" con su precio; el precio nuevo y el Δ% contra el vigente salen del sugerido de esa fuente.
  const conManual = opcionesSelect(pub({ costeo: { costoPorProducto: { 1: 2000 } } }), 'almacen');
  assert.deepStrictEqual(conManual.map(o => o.valor), ['', 'sistema', 'ultimaCompra', 'manual']);
  assert.match(conManual[3].texto, /^Manual · \$ [\d.]+ \(\+\d+\.\d%\)$/);
  assert.strictEqual(conManual[3].disabled, false);
});

test('opcionesSelect: la decisión guardada sin precio sigue seleccionable (con el motivo); Producción dice "Aumentar"', () => {
  const md = L.crearMayoristasDe({ vinculos: [], vigentes });
  const [f] = L.listadoReventa({ universo: [{ plu: '1', nombre: 'Arroz', costoSistema: 1000 }], vigentes, mayoristasDe: md, costeo: {}, cfg: CFG });
  const guardada = { ...L.filaPublica(f), decision: { fuente: 'ultimaCompra' } }; // la última compra ya no existe
  const uc = opcionesSelect(guardada, 'almacen')[2];
  assert.deepStrictEqual([uc.texto, uc.disabled], ['Última compra · Sin compras registradas', false]);
  const [p, sin] = L.listadoProduccion({ presentaciones: [{ plu: '6319', nombre: 'Mezcla', costoUnidad: 1000 }, { plu: '6320', nombre: 'Sin costo', costoUnidad: 0 }],
    vigentes: new Map([['6319', 1500]]), mayoristasDe: md, costeo: {}, cfg: CFG });
  const aum = opcionesSelect(L.filaPublica(p), 'produccion');
  assert.deepStrictEqual(aum.map(o => o.valor), ['', 'sistema']);
  assert.match(aum[1].texto, /^Aumentar · \$ [\d.]+ \([+-]?\d+\.\d%\)$/);
  assert.deepStrictEqual(opcionesSelect(L.filaPublica(sin), 'produccion').map(o => [o.texto, o.disabled]), [['No cambiar', false], ['Aumentar · La receta no tiene costo', true]]);
});

test('opcionesSelect Fraccionado: el Δ% es el promedio de las presentaciones ("prom."); sin vigentes no hay Δ%', () => {
  const md = L.crearMayoristasDe({ vinculos: [], vigentes: new Map() });
  const grupos = [{ plu: '100', nombre: 'Almendras', presentaciones: [{ plu: '101', nombre: 'Almendras 500G' }, { plu: '102', nombre: 'Almendras 1Kg' }] }];
  const fracc = v => L.filaPublica(L.listadoFraccionado({ grupos, costos: new Map([['100', { costoSistema: 1000 }]]), vigentes: v, mayoristasDe: md, costeo: {}, cfg: CFG })[0]);
  assert.strictEqual(opcionesSelect(fracc(new Map([['101', 1950], ['102', 1500]])), 'fraccionado')[1].texto, 'Sistema · prom. +10.0%'); // (0 + 20) / 2
  assert.strictEqual(opcionesSelect(fracc(new Map()), 'fraccionado')[1].texto, 'Sistema · sin vigente');
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

test('conceptosCosto: líneas de Producción en mercadería / insumos / mano de obra; subtotal null si falta un costo', () => {
  const lineas = [{ rol: 'mp', plu: '300', importe: 100 }, { rol: 'mp', plu: '7067', importe: 210.5 }, { rol: 'insumo', plu: '6334', importe: 180 },
    { rol: 'empaque', plu: '6320', importe: 45 }, { rol: 'mo', plu: '_manoObra', importe: 200 }, { plu: '_receta', importe: 9 }];
  const c = conceptosCosto(lineas);
  assert.deepStrictEqual([c.mercaderia.lineas.map(l => l.plu), c.mercaderia.subtotal], [['300', '7067', '_receta'], 319.5]);
  assert.deepStrictEqual([c.insumos.lineas.map(l => l.plu), c.insumos.subtotal], [['6334', '6320'], 225]);
  assert.strictEqual(c.mo.importe, 200);
  const falta = conceptosCosto([{ rol: 'granel', importe: 10 }, { rol: 'empaque', importe: null }]);
  assert.deepStrictEqual([falta.mercaderia.subtotal, falta.insumos.subtotal, falta.mo], [10, null, null]);
  assert.deepStrictEqual(conceptosCosto(undefined).insumos, { lineas: [], subtotal: 0 });
});

test('pasosAjusteMd: "Ver detalle" explica especial y ajuste del producto dentro del margen; general en el último renglón; sin ajustes → nada', () => {
  assert.deepStrictEqual(pasosAjusteMd({ margenPct: 30 }), []);
  assert.deepStrictEqual(pasosAjusteMd({ margenPct: 40, margenProductoPct: 10 }).map(p => p[1]), ['incluye ajuste del producto +10 % (general 30 %)']);
  assert.deepStrictEqual(pasosAjusteMd({ margenPct: 32, margenEspecialPct: 5, margenProductoPct: -3 }).map(p => p[1]),
    ['incluye margen especial del producto +5 %', 'incluye ajuste del producto -3 % (general 30 %)']);
  assert.deepStrictEqual(pasosAjusteMd({ margenPct: 35, margenEspecialPct: 5 }).map(p => p[1]), ['incluye margen especial del producto +5 % (general 30 %)']);
});

test('pasosAjusteMd: margen fijo del producto → un renglón con el general que reemplazó (sin el especial)', () => {
  assert.deepStrictEqual(pasosAjusteMd({ margenPct: 55, margenProductoPct: 55, margenProductoModo: 'fijo', margenGeneralPct: 43.33 }).map(p => p[1]),
    ['margen fijo del producto 55 % (general 43,33 %)']);
  assert.deepStrictEqual(pasosAjusteMd({ margenPct: 40, margenProductoPct: 10, margenProductoModo: 'ajuste' }).map(p => p[1]), ['incluye ajuste del producto +10 % (general 30 %)']);
});

test('pasosAjusteMd / generalesCanalMd: descuento distribuidor en "Ver detalle" y fuera del general', () => {
  assert.deepStrictEqual(pasosAjusteMd({ margenPct: 45, descuentoDistribuidorPct: 5 }).map(p => p[1]), ['incluye descuento distribuidor −5 % (margen 50 % → 45 %)']);
  assert.deepStrictEqual(pasosAjusteMd({ margenPct: 35, margenProductoPct: 10, descuentoDistribuidorPct: 5 }).map(p => p[1]),
    ['incluye ajuste del producto +10 % (general 30 %)', 'incluye descuento distribuidor −5 % (margen 40 % → 35 %)']);
  const fila = { sugeridos: { sistema: { desglose: { minorista: { margenPct: 45, descuentoDistribuidorPct: 5 }, porVinculo: {} } } }, mayoristas: [] };
  assert.strictEqual(generalesCanalMd(fila, 'sistema').minorista, 50);
});

test('generalesCanalMd: margen general por canal (sin el del producto) desde el desglose de la fuente; sin dato → null', () => {
  const des = (minorista, porVinculo = {}) => ({ sistema: { desglose: { minorista, porVinculo } } });
  const fila = { sugeridos: des({ margenPct: 55, margenProductoPct: 55, margenProductoModo: 'fijo', margenGeneralPct: 43.33 },
    { 60: { margenPct: 30, margenProductoPct: 5, margenProductoModo: 'ajuste' } }),
  mayoristas: [{ plu: '60', tipo: 'pack' }, { plu: '70', tipo: 'bulto' }] };
  assert.deepStrictEqual(generalesCanalMd(fila, 'sistema'), { minorista: 43.33, pack: 25, bulto: null });
  assert.deepStrictEqual(generalesCanalMd({ sugeridos: {} }, 'sistema'), { minorista: null, pack: null, bulto: null });
  // Fraccionado: pack/bulto vinculados a una presentación.
  const fracc = { sugeridos: des({ margenPct: 30 }), mayoristas: [],
    presentaciones: [{ sugeridos: des({ margenPct: 40 }, { 80: { margenPct: 27 } }), mayoristas: [{ plu: '80', tipo: 'bulto' }] }] };
  assert.deepStrictEqual(generalesCanalMd(fracc, 'sistema'), { minorista: 30, pack: null, bulto: 27 });
});

test('igualarSigaMd Reventa: margen fijo por canal con vigente; guardado como fijo, el precio queda igual al de SIGA', () => {
  const vig = new Map([['1', 1830], ['60', 1650]]);
  const md = L.crearMayoristasDe({ vinculos: [{ plu: '60', nombre: 'Arroz Pack x6', basePlu: '1', cantidad: 6, tipo: 'pack' }], vigentes: vig });
  const armar = costeo => L.filaPublica(L.listadoReventa({ universo: [{ plu: '1', nombre: 'Arroz', costoSistema: 1000 }], vigentes: vig, mayoristasDe: md, costeo, cfg: CFG })[0], true);
  // "No cambiar" (mdFuente = sistema) y fuente sin costo (ultimaCompra) → usa el costo sistema.
  for (const fuente of ['sistema', 'ultimaCompra']) {
    const r = igualarSigaMd(armar({}), 'almacen', fuente);
    assert.deepStrictEqual([Object.keys(r.valores).sort(), r.notas, r.motivo, r.fuente], [['minorista', 'pack'], [], null, 'sistema']);
    const f = armar({ margenProducto: { 1: { modo: 'fijo', ...r.valores } } });
    assert.deepStrictEqual([f.sugeridos.sistema.minorista.precio, f.sugeridos.sistema.mayoristas[0].conIva], [1830, f.mayoristas[0].vigente]);
  }
  // Sin desglose (usuario sin permiso) o sin vigentes → no se puede, con el motivo.
  const sinPermiso = L.filaPublica(L.listadoReventa({ universo: [{ plu: '1', nombre: 'Arroz', costoSistema: 1000 }], vigentes: vig, mayoristasDe: md, costeo: {}, cfg: CFG })[0]);
  assert.match(igualarSigaMd(sinPermiso, 'almacen', 'sistema').motivo, /costo/);
  const sinVig = L.filaPublica(L.listadoReventa({ universo: [{ plu: '1', nombre: 'Arroz', costoSistema: 1000 }], vigentes: new Map(), mayoristasDe: L.crearMayoristasDe({ vinculos: [], vigentes: new Map() }), costeo: {}, cfg: CFG })[0], true);
  assert.match(igualarSigaMd(sinVig, 'almacen', 'sistema').motivo, /vigente/);
});

test('igualarSigaMd Fraccionado: presentaciones con distinto margen necesario → la mediana y nota con el rango de Δ', () => {
  const md = L.crearMayoristasDe({ vinculos: [], vigentes: new Map() });
  const [g] = L.listadoFraccionado({
    grupos: [{ plu: '100', nombre: 'Almendras', presentaciones: [{ plu: '101', nombre: 'Almendras 500G' }, { plu: '102', nombre: 'Almendras 1Kg' }, { plu: '103', nombre: 'Almendras 2Kg' }] }],
    costos: new Map([['100', { costoSistema: 1000 }]]), vigentes: new Map([['101', 1950], ['102', 1800], ['103', 1500]]), mayoristasDe: md, costeo: {}, cfg: CFG,
  });
  const r = igualarSigaMd(L.filaPublica(g, true), 'fraccionado', 'sistema');
  const solo = v => igualarSigaMd({ ...L.filaPublica(g, true), presentaciones: L.filaPublica(g, true).presentaciones.filter(p => p.vigente === v) }, 'fraccionado', 'sistema').valores.minorista;
  assert.strictEqual(r.valores.minorista, solo(1800)); // mediana de las tres
  assert.ok(solo(1950) > r.valores.minorista && r.valores.minorista > solo(1500));
  assert.strictEqual(r.notas.length, 1);
  assert.match(r.notas[0], /^Minorista aprox\.: las presentaciones quedan con Δ entre -\d+,\d % y \+\d+,\d %/);
});
