'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const ml = require('../lib/ml_precios');
// Equivalencia del criterio viejo de cuotas (texto de la bajada) con cuotasQty sobre la tabla de CFG.
const Q = { no: null, agregar: 3, interes_bajo: 6 };
const sinEnvio = ({ base, gastosPct, gastosFijos, esperado }) => ({ base, gastosPct, gastosFijos, esperado });

// Fixture: recorte real de la bajada de ML del 2026-10-26 (headers + 6 padres + 17 variantes).
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'ml_publicaciones_muestra.xlsx'));
const HEADER = ['ITEM_ID', 'VARIATION_ID', 'TITLE', 'QUANTITY', 'PRICE', 'SALE_PRICE', 'VALUE_ADDED_TAX', 'SHIPPING_METHOD', 'STATUS', 'LISTING_TYPE_V3'];
const xlsx = filas => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADER, [], [], [], [], ...filas]), 'Publicaciones');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};
const CFG = { ...ml.CONFIG_DEFAULT, comisionPct: 10, envioGratisPct: 5, cuotasBasePct: 0, tablaCuotas: [{ cuotas: 3, recargoPct: 8 }, { cuotas: 6, recargoPct: 3 }],
  tablaCostoFijo: [], envioGratisDesde: 0 };

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

test('esperado sin margen, envío gratis y cuotas = cálculo manual', () => {
  // base 1000×2 = 2000; gastos 10+5+8 = 23 % → 2000 / 0.77 = 2597.40
  const r = ml.precioEsperado(1000, 2, 'gratis', 'agregar', CFG, null, 3);
  assert.deepStrictEqual(sinEnvio(r), { base: 2000, gastosPct: 23, gastosFijos: 0, esperado: 2597.4 });
  assert.strictEqual(ml.precioEsperado(1000, 2, 'comprador', 'no', { ...CFG, redondeoPaso: 100 }).esperado, 2200); // 2000/0.9 = 2222.2
});

test('gastos al 100 % → esperado null (validarConfig no lo deja guardar)', () => {
  const r = ml.precioEsperado(1000, 1, 'no', 'no', { ...CFG, comisionPct: 100 });
  assert.strictEqual(r.esperado, null);
  assert.deepStrictEqual(ml.estadoDe({ vinculado: true, carta: 1000, precioMl: 1, esperado: r.esperado, toleranciaPct: 2 }), { estado: 'desviada', desvioPct: null });
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
    { id: 'A', titulo: 'a', precio: 2597.4, precioPromo: null, envio: 'gratis', cuotas: 'agregar', activa: true, stock: 1 },
    { id: 'B', titulo: 'b', precio: 500, precioPromo: null, envio: 'nd', cuotas: 'no', activa: false, stock: 0 },
    { id: 'C', titulo: 'c', precio: 500, precioPromo: null, envio: 'nd', cuotas: 'no', activa: true, stock: 0 },
  ];
  const cartas = new Map([['7', { precio: 1000, nombre: 'Prod 7' }]]);
  const filas = [
    ml.armarFila(pubs[0], { codigo: 7, unidades: 2, cuotasQty: 3 }, cartas, CFG),
    ml.armarFila(pubs[1], null, cartas, CFG),
    ml.armarFila(pubs[2], { codigo: 9, unidades: 1 }, cartas, CFG),
  ];
  assert.strictEqual(filas[0].estado, 'ok');
  assert.strictEqual(filas[0].nombreProducto, 'Prod 7');
  assert.strictEqual(filas[1].estado, 'sin_vincular');
  assert.strictEqual(filas[2].estado, 'sin_carta');
  assert.deepStrictEqual(ml.kpis(filas), { activas: 2, inactivas: 1, ok: 1, desviadas: 0, sinVincular: 1, sinCarta: 1, sinPrecio: 0 });
});

test('validarConfig', () => {
  assert.strictEqual(ml.validarConfig(ml.CONFIG_DEFAULT), null);
  assert.match(ml.validarConfig({ ...CFG, comisionPct: 60, envioGratisPct: 40 }), /100 %/);
  assert.match(ml.validarConfig({ ...CFG, comisionPct: -1 }), /comisionPct/);
  assert.ok(ml.validarConfig({ ...CFG, tablaCuotas: [{ cuotas: 0, recargoPct: 1 }] }));
});

test('regresión: config vieja (sin campos nuevos) normalizada da el mismo esperado', () => {
  const { envioMonto, costoFijoMonto, impuestosPct, extras, ...vieja } = CFG;
  const cfg = ml.normalizarConfig(vieja);
  assert.deepStrictEqual([cfg.envioMonto, cfg.costoFijoMonto, cfg.impuestosPct, cfg.extras], [0, 0, 0, []]);
  assert.ok(!('extras' in vieja)); // no muta
  assert.strictEqual(ml.precioEsperado(1000, 2, 'gratis', 'agregar', cfg, null, 3).esperado, 2597.4);
  assert.strictEqual(ml.precioEsperado(1000, 2, 'comprador', 'no', { ...cfg, redondeoPaso: 100 }).esperado, 2200);
});

test('costos nuevos: $ al numerador (envío solo gratis), % al divisor', () => {
  const cfg = { ...CFG, envioGratisPct: 0, envioMonto: 500, costoFijoMonto: 100, impuestosPct: 4,
    extras: [{ nombre: 'Emb', tipo: '$', valor: 50 }, { nombre: 'Pub', tipo: '%', valor: 3 }] };
  // gratis: 2000 + 500 + 100 + 50 = 2650; gastos 10 + 8 + 4 + 3 = 25 % → 2650 / 0.75 = 3533.33
  assert.deepStrictEqual(sinEnvio(ml.precioEsperado(1000, 2, 'gratis', 'agregar', cfg, null, 3)), { base: 2000, gastosPct: 25, gastosFijos: 650, esperado: 3533.33 });
  // comprador: 2000 + 150 = 2150; gastos 10 + 4 + 3 = 17 % → 2150 / 0.83 = 2590.36
  const c = ml.precioEsperado(1000, 2, 'comprador', 'no', cfg);
  assert.strictEqual(c.gastosFijos, 150);
  assert.strictEqual(c.esperado, 2590.36);
});

test('validarConfig: campos nuevos', () => {
  const ok = { ...CFG, envioGratisPct: 0, envioMonto: 1, costoFijoMonto: 0, impuestosPct: 1, extras: [{ nombre: 'x', tipo: '%', valor: 1 }] };
  assert.strictEqual(ml.validarConfig(ok), null);
  assert.match(ml.validarConfig({ ...ok, envioMonto: -1 }), /envioMonto/);
  assert.match(ml.validarConfig({ ...ok, costoFijoMonto: -1 }), /costoFijoMonto/);
  assert.match(ml.validarConfig({ ...ok, extras: [{ nombre: 'x', tipo: 'kg', valor: 1 }] }), /tipo/);
  assert.match(ml.validarConfig({ ...ok, extras: [{ nombre: 'x', tipo: '$', valor: -1 }] }), /valor/);
  assert.match(ml.validarConfig({ ...ok, extras: [{ nombre: 'y'.repeat(61), tipo: '$', valor: 1 }] }), /nombre/);
  assert.match(ml.validarConfig({ ...ok, extras: Array(21).fill({ nombre: 'x', tipo: '$', valor: 1 }) }), /20/);
  assert.match(ml.validarConfig({ ...ok, impuestosPct: 50, extras: [{ nombre: 'x', tipo: '%', valor: 32 }] }), /100 %/); // 10+8+50+32
});

test('regresión: costos nuevos explícitos en 0 dan el mismo resultado que antes en todas las combinaciones', () => {
  const cero = { ...CFG, envioMonto: 0, costoFijoMonto: 0, impuestosPct: 0, extras: [{ nombre: 'n', tipo: '$', valor: 0 }, { nombre: 'm', tipo: '%', valor: 0 }] };
  // sin campos nuevos: 2000/(1-g)
  const previos = { gratis: { no: 2352.94, agregar: 2597.4, interes_bajo: 2439.02 }, comprador: { no: 2222.22, agregar: 2439.02, interes_bajo: 2298.85 } };
  for (const envio of ['gratis', 'comprador']) for (const cuotas of ml.CUOTAS) {
    const r = ml.precioEsperado(1000, 2, envio, cuotas, cero, null, Q[cuotas]);
    assert.strictEqual(r.esperado, previos[envio][cuotas], `${envio}/${cuotas}`);
    assert.strictEqual(r.gastosFijos, 0);
  }
});

test('validarConfig: extras no lista y nombres vacíos o solo espacios', () => {
  for (const extras of [{}, 'x', 1]) assert.match(ml.validarConfig({ ...CFG, extras }), /lista/);
  for (const nombre of ['', '   ', '\t']) assert.match(ml.validarConfig({ ...CFG, extras: [{ nombre, tipo: '$', valor: 1 }] }), /nombre/);
  assert.strictEqual(ml.validarConfig({ ...CFG, extras: null }), null); // ausente/null = []
});

// ── Envío por tramo de peso y umbral de envío gratis obligatorio ──
const TABLA = [{ topeKg: 0.5, valor: 100 }, { topeKg: 2, valor: 300 }];

test('tramoEnvio: borde exacto, mayor al último, sin peso, tabla vacía', () => {
  assert.deepStrictEqual(ml.tramoEnvio(TABLA, 0.5, 9), { monto: 100, topeKg: 0.5, origen: 'tabla' });
  assert.deepStrictEqual(ml.tramoEnvio(TABLA, 0.501, 9), { monto: 300, topeKg: 2, origen: 'tabla' });
  const def = { monto: 9, topeKg: null, origen: 'defecto' };
  for (const p of [2.001, null, undefined, 0, -1, '1', NaN]) assert.deepStrictEqual(ml.tramoEnvio(TABLA, p, 9), def, String(p));
  assert.deepStrictEqual(ml.tramoEnvio([], 1, 9), def);
});

test('validarConfig: tablaEnvio (orden, duplicados, negativos, > 30) y envioGratisDesde', () => {
  const ok = { ...CFG, tablaEnvio: TABLA };
  assert.strictEqual(ml.validarConfig(ok), null);
  assert.strictEqual(ml.validarConfig({ ...ok, tablaEnvio: [] }), null);
  assert.match(ml.validarConfig({ ...ok, tablaEnvio: [TABLA[1], TABLA[0]] }), /crecientes/);
  assert.match(ml.validarConfig({ ...ok, tablaEnvio: [TABLA[0], { topeKg: 0.5, valor: 1 }] }), /crecientes/);
  assert.match(ml.validarConfig({ ...ok, tablaEnvio: [{ topeKg: -1, valor: 1 }] }), /tope/);
  assert.match(ml.validarConfig({ ...ok, tablaEnvio: [{ topeKg: 0, valor: 1 }] }), /tope/);
  assert.match(ml.validarConfig({ ...ok, tablaEnvio: [{ topeKg: 1, valor: -1 }] }), /valor/);
  assert.match(ml.validarConfig({ ...ok, tablaEnvio: Array.from({ length: 31 }, (_, i) => ({ topeKg: i + 1, valor: 1 })) }), /30/);
  assert.match(ml.validarConfig({ ...ok, tablaEnvio: 'x' }), /lista/);
  for (const v of [-1, '5', NaN]) assert.match(ml.validarConfig({ ...ok, envioGratisDesde: v }), /envioGratisDesde/);
  assert.strictEqual(ml.validarConfig({ ...ok, envioGratisDesde: 0 }), null);
});

test('normalizarConfig: sin tablaEnvio/envioGratisDesde → iniciales; presentes (aunque vacía/0) se respetan', () => {
  const { tablaEnvio, envioGratisDesde, ...vieja } = ml.CONFIG_DEFAULT;
  const n = ml.normalizarConfig(vieja);
  assert.strictEqual(n.tablaEnvio.length, 10);
  assert.deepStrictEqual({ ...n.tablaEnvio[0] }, { topeKg: 0.3, valor: 5620 });
  assert.deepStrictEqual({ ...n.tablaEnvio[9] }, { topeKg: 29.9, valor: 27700 });
  assert.strictEqual(n.envioGratisDesde, 33000);
  assert.deepStrictEqual(ml.normalizarConfig({ ...vieja, tablaEnvio: [], envioGratisDesde: 0 }).tablaEnvio, []);
  assert.strictEqual(ml.normalizarConfig({ ...vieja, envioGratisDesde: 0 }).envioGratisDesde, 0);
});

test('tabla vacía: igual que antes (envioMonto por defecto)', () => {
  const cfg = { ...CFG, envioMonto: 500, tablaEnvio: [], envioGratisDesde: 0 };
  const r = ml.precioEsperado(1000, 2, 'gratis', 'agregar', cfg, 1);
  assert.strictEqual(r.gastosFijos, 500);
  assert.strictEqual(r.envioOrigen, 'defecto');
});

test('armarFila con envío por tramo: gratis usa el tramo; no gratis bajo el umbral no suma envío', () => {
  const cfg = { ...CFG, envioGratisPct: 0, envioMonto: 999, tablaEnvio: TABLA, envioGratisDesde: 0 };
  const cartas = new Map([['7', { precio: 1000, nombre: 'X' }]]);
  const pub = { id: 'MLA1', activa: true, envio: 'gratis', cuotas: 'no', precio: 3000 };
  const f = ml.armarFila(pub, { codigo: 7, unidades: 2, pesoKg: 1.5 }, cartas, cfg);
  assert.deepStrictEqual([f.pesoKg, f.envioMonto, f.envioTopeKg, f.envioOrigen, f.envioPorUmbral, f.gastosFijos], [1.5, 300, 2, 'tabla', false, 300]);
  assert.strictEqual(f.esperado, ml.precioEsperado(1000, 2, 'gratis', 'no', cfg, 1.5).esperado);
  const sinPeso = ml.armarFila(pub, { codigo: 7, unidades: 2 }, cartas, cfg);
  assert.deepStrictEqual([sinPeso.pesoKg, sinPeso.envioMonto, sinPeso.envioOrigen], [null, 999, 'defecto']);
  const comprador = ml.armarFila({ ...pub, envio: 'comprador' }, { codigo: 7, unidades: 2, pesoKg: 1.5 }, cartas, cfg);
  assert.deepStrictEqual([comprador.envioMonto, comprador.envioTopeKg, comprador.envioOrigen, comprador.gastosFijos], [0, null, null, 0]);
});

test('umbral de envío gratis obligatorio: borde exacto aplica, un peso menos no; 0 desactiva; gratis aplica bajo el umbral', () => {
  // sin envío: 1000 x 1 / 0.9 = 1111.11 (comprador, cuotas no, sin redondeo)
  const cfg = { ...CFG, envioGratisPct: 0, tablaEnvio: TABLA, envioMonto: 0 };
  const sin = ml.precioEsperado(1000, 1, 'comprador', 'no', { ...cfg, envioGratisDesde: 0 }, 1);
  assert.strictEqual(sin.esperado, 1111.11);
  assert.strictEqual(sin.envioPorUmbral, false);
  const borde = ml.precioEsperado(1000, 1, 'comprador', 'no', { ...cfg, envioGratisDesde: 1111.11 }, 1);
  assert.deepStrictEqual([borde.envioPorUmbral, borde.envioMonto, borde.envioTopeKg, borde.gastosFijos], [true, 300, 2, 300]);
  assert.strictEqual(borde.esperado, ml.precioEsperado(1000, 1, 'gratis', 'no', { ...cfg, envioGratisDesde: 0 }, 1).esperado);
  const bajo = ml.precioEsperado(1000, 1, 'comprador', 'no', { ...cfg, envioGratisDesde: 1112.11 }, 1);
  assert.deepStrictEqual([bajo.envioPorUmbral, bajo.envioMonto, bajo.esperado], [false, 0, 1111.11]);
  const gratis = ml.precioEsperado(1000, 1, 'gratis', 'no', { ...cfg, envioGratisDesde: 99999 }, 1);
  assert.deepStrictEqual([gratis.envioPorUmbral, gratis.envioMonto], [false, 300]);
});

// ── Cuotas por cantidad y cargo fijo por tramo de precio ──
const CUOTAS_T = [{ cuotas: 1, recargoPct: 0 }, { cuotas: 3, recargoPct: 8 }, { cuotas: 6, recargoPct: 12 }];
const CF_T = [{ precioMax: 15000, valor: 1115 }, { precioMax: 25000, valor: 2300 }];

test('recargoCuotas: fila exacta, sin fila, qty inválida, tabla vacía', () => {
  assert.strictEqual(ml.recargoCuotas(CUOTAS_T, 3), 8);
  assert.strictEqual(ml.recargoCuotas(CUOTAS_T, 1), 0);
  for (const q of [2, 12, null, undefined, 1.5, '3', 0]) assert.strictEqual(ml.recargoCuotas(CUOTAS_T, q), 0, String(q));
  assert.strictEqual(ml.recargoCuotas([], 3), 0);
});

test('tramoCostoFijo: tope exacto, mayor al último, tabla vacía, precio inválido', () => {
  assert.deepStrictEqual(ml.tramoCostoFijo(CF_T, 15000, 9), { monto: 1115, precioMax: 15000, origen: 'tabla' });
  assert.deepStrictEqual(ml.tramoCostoFijo(CF_T, 15000.01, 9), { monto: 2300, precioMax: 25000, origen: 'tabla' });
  const def = { monto: 9, precioMax: null, origen: 'defecto' };
  assert.deepStrictEqual(ml.tramoCostoFijo(CF_T, 25000.01, 9), def);
  assert.deepStrictEqual(ml.tramoCostoFijo([], 100, 9), def);
  assert.deepStrictEqual(ml.tramoCostoFijo(CF_T, null, 9), def);
});

test('validarConfig: cuotas y cargo fijo', () => {
  const ok = { ...CFG, cuotasBasePct: 4, tablaCuotas: CUOTAS_T, tablaCostoFijo: CF_T };
  assert.strictEqual(ml.validarConfig(ok), null);
  assert.strictEqual(ml.validarConfig({ ...ok, tablaCuotas: [], tablaCostoFijo: [] }), null);
  for (const v of [-1, 100, '4']) assert.match(ml.validarConfig({ ...ok, cuotasBasePct: v }), /cuotasBasePct/);
  for (const c of [0, 25, 1.5, '3']) assert.match(ml.validarConfig({ ...ok, tablaCuotas: [{ cuotas: c, recargoPct: 1 }] }), /entero/, String(c));
  assert.match(ml.validarConfig({ ...ok, tablaCuotas: [{ cuotas: 3, recargoPct: -1 }] }), /recargo/);
  assert.match(ml.validarConfig({ ...ok, tablaCuotas: [{ cuotas: 3, recargoPct: 1 }, { cuotas: 3, recargoPct: 2 }] }), /repetida/);
  assert.match(ml.validarConfig({ ...ok, tablaCuotas: Array.from({ length: 13 }, (_, i) => ({ cuotas: i + 1, recargoPct: 0 })) }), /12/);
  assert.match(ml.validarConfig({ ...ok, tablaCuotas: 'x' }), /lista/);
  assert.match(ml.validarConfig({ ...ok, comisionPct: 60, cuotasBasePct: 28 }), /100 %/); // 60 + 28 + 12
  assert.match(ml.validarConfig({ ...ok, tablaCostoFijo: [CF_T[1], CF_T[0]] }), /crecientes/);
  assert.match(ml.validarConfig({ ...ok, tablaCostoFijo: [CF_T[0], { precioMax: 15000, valor: 1 }] }), /crecientes/);
  assert.match(ml.validarConfig({ ...ok, tablaCostoFijo: [{ precioMax: 0, valor: 1 }] }), /precio máximo/);
  assert.match(ml.validarConfig({ ...ok, tablaCostoFijo: [{ precioMax: 10, valor: -1 }] }), /valor/);
  assert.match(ml.validarConfig({ ...ok, tablaCostoFijo: Array.from({ length: 31 }, (_, i) => ({ precioMax: i + 1, valor: 0 })) }), /30/);
});

test('config vieja (con cuotasPct y sin tablas): defaults sin cuotasPct; presentes se respetan', () => {
  const { cuotasBasePct, tablaCuotas, tablaCostoFijo, ...resto } = ml.CONFIG_DEFAULT;
  const vieja = { ...resto, comisionPct: 14.8, cuotasPct: { no: 0, agregar: 8, interes_bajo: 3 } };
  const n = ml.normalizarConfig(vieja);
  assert.ok(!('cuotasPct' in n));
  assert.strictEqual(n.comisionPct, 14.8);
  assert.strictEqual(n.cuotasBasePct, 4);
  assert.deepStrictEqual(n.tablaCuotas.map(t => [t.cuotas, t.recargoPct]), [[1, 0], [3, 8], [6, 12], [9, 16], [12, 19]]);
  assert.deepStrictEqual(n.tablaCostoFijo.map(t => [t.precioMax, t.valor]), [[15000, 1115], [25000, 2300], [33000, 2810]]);
  assert.strictEqual(ml.validarConfig(n), null);
  assert.ok('cuotasPct' in vieja); // no muta
  const presentes = ml.normalizarConfig({ ...vieja, tablaCuotas: [], tablaCostoFijo: [], cuotasBasePct: 0 });
  assert.deepStrictEqual([presentes.tablaCuotas, presentes.tablaCostoFijo, presentes.cuotasBasePct], [[], [], 0]);
  assert.strictEqual(ml.CONFIG_DEFAULT.comisionPct, 16);
});

test('armarFila con cuotas y cargo fijo: cuotasPct = base + recargo; sin cuotasQty = 1', () => {
  const cfg = { ...CFG, cuotasBasePct: 4, tablaCuotas: CUOTAS_T, tablaCostoFijo: CF_T, costoFijoMonto: 50 };
  const cartas = new Map([['7', { precio: 1000, nombre: 'X' }]]);
  const pub = { id: 'MLA1', activa: true, envio: 'comprador', cuotas: 'no', precio: 3000 };
  const f = ml.armarFila(pub, { codigo: 7, unidades: 2, cuotasQty: 6 }, cartas, cfg);
  assert.deepStrictEqual([f.cuotasQty, f.cuotasPct, f.costoFijoTabla, f.costoFijoPrecioMax, f.costoFijoOrigen, f.gastosFijos], [6, 16, 1115, 15000, 'tabla', 1115]);
  assert.strictEqual(f.gastosPct, 10 + 16);
  const uno = ml.armarFila(pub, { codigo: 7, unidades: 2 }, cartas, cfg);
  assert.deepStrictEqual([uno.cuotasQty, uno.cuotasPct], [null, 4]);
  const sinVinc = ml.armarFila(pub, null, cartas, cfg);
  assert.deepStrictEqual([sinVinc.cuotasPct, sinVinc.costoFijoTabla, sinVinc.costoFijoPrecioMax], [null, 0, null]);
});

test('precio de referencia (sin envío ni cargo fijo) decide el tramo, aunque el final lo supere', () => {
  // ref: 1000 / 0.9 = 1111.11; con precioMax = ref cae en el primer tramo; el final (con 300 de cargo) es mayor
  const cfg = { ...CFG, envioGratisPct: 0, costoFijoMonto: 0, envioGratisDesde: 0 };
  const ref = ml.precioEsperado(1000, 1, 'comprador', 'no', { ...cfg, tablaCostoFijo: [] }).esperado;
  assert.strictEqual(ref, 1111.11);
  const t = [{ precioMax: 1111.11, valor: 300 }, { precioMax: 99999, valor: 900 }];
  const r = ml.precioEsperado(1000, 1, 'comprador', 'no', { ...cfg, tablaCostoFijo: t });
  assert.deepStrictEqual([r.costoFijoTabla, r.costoFijoPrecioMax], [300, 1111.11]);
  assert.ok(r.esperado > 1111.11);
  const r2 = ml.precioEsperado(1000, 1, 'comprador', 'no', { ...cfg, tablaCostoFijo: [{ precioMax: 1111.1, valor: 300 }, t[1]] });
  assert.deepStrictEqual([r2.costoFijoTabla, r2.costoFijoPrecioMax], [900, 99999]);
  // el umbral de envío también mira la referencia: con cargo fijo alto, ref sigue bajo el umbral
  const u = ml.precioEsperado(1000, 1, 'comprador', 'no', { ...cfg, tablaCostoFijo: [], costoFijoMonto: 5000, envioGratisDesde: 1111.12 });
  assert.strictEqual(u.envioPorUmbral, false);
  assert.ok(u.esperado > 1111.12);
});

test('identidad sin margen: esperado − (esperado × Σ% + Σ$) ≈ base', () => {
  const cfgs = [
    { ...CFG, redondeoPaso: 0 },
    { ...CFG, redondeoPaso: 0, cuotasBasePct: 4, tablaCuotas: [{ cuotas: 1, recargoPct: 0 }, { cuotas: 6, recargoPct: 12 }],
      tablaCostoFijo: [{ precioMax: 15000, valor: 1115 }, { precioMax: 25000, valor: 2300 }], costoFijoMonto: 2810,
      tablaEnvio: [{ topeKg: 1, valor: 7000 }], envioMonto: 9000, envioGratisDesde: 33000, impuestosPct: 3,
      extras: [{ nombre: 'a', tipo: '$', valor: 120 }, { nombre: 'b', tipo: '%', valor: 1.5 }] },
    { ...CFG, redondeoPaso: 100, cuotasBasePct: 4, tablaCostoFijo: [{ precioMax: 20000, valor: 1500 }] },
  ];
  for (const cfg of cfgs) for (const carta of [300, 4999.99, 12000, 40000]) for (const envio of ['gratis', 'comprador']) for (const q of [1, 6]) {
    const r = ml.precioEsperado(carta, 1, envio, 'no', cfg, 0.8, q);
    const neto = r.esperado - (r.esperado * r.gastosPct / 100 + r.gastosFijos);
    const tol = cfg.redondeoPaso ? cfg.redondeoPaso / 2 : 0.01;
    assert.ok(Math.abs(neto - r.base) <= tol + 1e-9, JSON.stringify({ carta, envio, q, neto, base: r.base }));
  }
});

test('config vieja con tablaMargen: se ignora, valida y calcula sin margen', () => {
  const vieja = { ...ml.CONFIG_DEFAULT, tablaMargen: { minPct: 20, maxPct: 40, escalones: 5, rango: { desde: 1000, hasta: 100000 } } };
  const n = ml.normalizarConfig(vieja);
  assert.ok(!('tablaMargen' in n));
  assert.ok('tablaMargen' in vieja); // no muta
  assert.strictEqual(ml.validarConfig(n), null);
  assert.strictEqual(ml.precioEsperado(1000, 1, 'comprador', 'no', n).base, 1000);
  assert.ok(!('margenPct' in ml.precioEsperado(1000, 1, 'comprador', 'no', n)));
});

// ── Bonificación de envío de ML ──
test('envioBonificado: off = igual; on bonifica tramo, defecto, gratis por bajada y por umbral; no aplica → 0', () => {
  const t = [{ topeKg: 2, valor: 7470 }];
  const cfg = { ...CFG, envioGratisPct: 0, tablaEnvio: t, envioMonto: 6141, envioGratisDesde: 0 };
  const off = ml.precioEsperado(1000, 2, 'gratis', 'no', cfg, 1);
  assert.deepStrictEqual(ml.precioEsperado(1000, 2, 'gratis', 'no', { ...cfg, envioBonificado: false }, 1), off);
  assert.deepStrictEqual([off.envioMonto, off.envioMontoLista, off.envioBonificado], [7470, 7470, false]);
  const on = { ...cfg, envioBonificado: true };
  const tabla = ml.precioEsperado(1000, 2, 'gratis', 'no', on, 1);
  assert.deepStrictEqual([tabla.envioMonto, tabla.envioMontoLista, tabla.envioBonificado, tabla.envioOrigen, tabla.gastosFijos], [3735, 7470, true, 'tabla', 3735]);
  const def = ml.precioEsperado(1000, 2, 'gratis', 'no', on, null);
  assert.deepStrictEqual([def.envioMonto, def.envioMontoLista, def.envioOrigen], [3070.5, 6141, 'defecto']); // impar → centavos
  const umbralOn = ml.precioEsperado(1000, 1, 'comprador', 'no', { ...on, envioGratisDesde: 1111.11 }, 1);
  const umbralOff = ml.precioEsperado(1000, 1, 'comprador', 'no', { ...cfg, envioGratisDesde: 1111.11 }, 1);
  assert.deepStrictEqual([umbralOn.envioPorUmbral, umbralOn.envioMonto, umbralOn.envioBonificado], [true, 3735, true]);
  assert.strictEqual(umbralOff.envioPorUmbral, true); // la bonificación no cambia si aplica
  const no = ml.precioEsperado(1000, 1, 'comprador', 'no', on, 1);
  assert.deepStrictEqual([no.envioMonto, no.envioMontoLista, no.envioBonificado], [0, 0, false]);
  assert.strictEqual(ml.ENVIO_BONIFICACION, 0.5);
});

test('envioBonificado: fila de control, validación y config vieja sin la clave', () => {
  const cfg = { ...CFG, tablaEnvio: [{ topeKg: 2, valor: 7470 }], envioGratisDesde: 0, envioBonificado: true };
  const cartas = new Map([['7', { precio: 1000, nombre: 'X' }]]);
  const pub = { id: 'MLA1', activa: true, envio: 'gratis', cuotas: 'no', precio: 3000 };
  const f = ml.armarFila(pub, { codigo: 7, unidades: 2, pesoKg: 1 }, cartas, cfg);
  assert.deepStrictEqual([f.envioMonto, f.envioMontoLista, f.envioBonificado], [3735, 7470, true]);
  const c = ml.armarFila({ ...pub, envio: 'comprador' }, { codigo: 7, unidades: 2, pesoKg: 1 }, cartas, cfg);
  assert.deepStrictEqual([c.envioMonto, c.envioMontoLista, c.envioBonificado], [0, 0, false]);
  for (const v of ['true', 1, 0]) assert.match(ml.validarConfig({ ...CFG, envioBonificado: v }), /envioBonificado/);
  assert.strictEqual(ml.validarConfig({ ...CFG, envioBonificado: true }), null);
  const { envioBonificado, ...vieja } = ml.CONFIG_DEFAULT;
  assert.strictEqual(ml.normalizarConfig(vieja).envioBonificado, false);
});

test('identidad esperado − comisiones ≈ base con envío bonificado', () => {
  const cfg = { ...CFG, redondeoPaso: 0, envioBonificado: true, tablaEnvio: [{ topeKg: 1, valor: 7001 }], envioMonto: 9000, envioGratisDesde: 3000,
    tablaCostoFijo: [{ precioMax: 15000, valor: 1115 }], costoFijoMonto: 2810, extras: [{ nombre: 'b', tipo: '%', valor: 1.5 }] };
  for (const carta of [300, 4999.99, 40000]) for (const envio of ['gratis', 'comprador']) for (const peso of [0.8, null]) {
    const r = ml.precioEsperado(carta, 1, envio, 'no', cfg, peso, 6);
    const neto = r.esperado - (r.esperado * r.gastosPct / 100 + r.gastosFijos);
    assert.ok(Math.abs(neto - r.base) <= 0.01 + 1e-9, JSON.stringify({ carta, envio, peso, neto }));
  }
});
