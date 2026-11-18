'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// GET /api/distribucion/redistribucion. rutas_distribucion.js es una factoría con muchas deps y
// calcularDistribucion* son closures internas: igual que distribucion_doble_submit.test.js, se
// extrae el bloque del fuente y se evalúa con los motores, query y leerJSON simulados.
const FUENTE = fs.readFileSync(path.join(__dirname, '..', 'routes', 'rutas_distribucion.js'), 'utf8');
const ini = FUENTE.indexOf('// ── Redistribución sucursal');
const fin = FUENTE.indexOf('// Ocultos de Redistribución'); // el bloque de ocultos tiene su propio test
assert.ok(ini > 0 && fin > ini, 'no se encontró el bloque de redistribución');
const BLOQUE = FUENTE.slice(ini, fin);

function montar({ alm = [], pes = [], ventas = [], falla = null, distCfg = {}, listas = { noEnvasa: [] } } = {}) {
  const sqls = [];
  const deps = {
    leerListasDistrib: () => listas,
    leerJSON: p => (p === 'DIST' ? distCfg : {}),
    DISTRIB_CONFIG_PATH: 'DIST', A8020_CALC_PATH: 'A8020',
    calcularDistribucionAlmacen: async () => { if (falla) throw new Error(falla); return alm; },
    calcularDistribucionPesables: async () => pes,
    query: async sql => { sqls.push(sql); return ventas; },
    pisoMinimo: require('../lib/distribucion').pisoMinimo,
    redistribuirProducto: require('../lib/rotacion_reparto').redistribuirProducto,
    analisisVentas: require('../lib/analisis_ventas'),
  };
  let handler = null;
  const router = { get: (_r, fn) => { handler = fn; } };
  new Function(...Object.keys(deps), 'router', BLOQUE)(...Object.values(deps), router);
  return { sqls, llamar: async q => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await handler({ query: q }, res);
    return res;
  } };
}

// Almacén: riv(5) vende y necesita S − stock = 10; sucursal9 tiene 8 = S → sin necesidad. Central 0.
// `ideal` queda en 0 a propósito: la necesidad ya no sale del pedido del motor sino de S − stock.
const filaAlm = (plu, central) => ({ plu, nombre: 'Prod ' + plu, rubro: 'Almacen', central,
  presentacion: { unidadesPorBulto: 1 }, sSuc: { riv: 10, sucursal9: 8 }, minSuc: { riv: 2, sucursal9: 2 },
  stkSuc: { riv: 0, sucursal9: 8 }, ideal: {}, enviar: {}, enviarTexto: {} });

test('forma de respuesta con un producto a redistribuir', async () => {
  const { llamar } = montar({ alm: [filaAlm('100', 0)], ventas: [{ IdProducto: '100', IdSucursal: 5, Unidades: 200 }] });
  const res = await llamar({ dias: '30' });
  assert.strictEqual(res.code, 200);
  assert.deepStrictEqual(Object.keys(res.body).sort(), ['productos', 'rango', 'resumenSucursales', 'totales', 'umbrales']);
  assert.strictEqual(res.body.rango.dias, 30);
  const [p] = res.body.productos;
  assert.strictEqual(p.plu, '100');
  assert.strictEqual(p.unidad, 'u');
  assert.ok(p.movimientos.length > 0 && p.movimientos.every(m => m.origen === 9 && m.destino === 5));
  assert.strictEqual(res.body.totales.productos, 1);
  assert.strictEqual(res.body.resumenSucursales['9'].sale, p.mover);
  assert.strictEqual(res.body.resumenSucursales['5'].entra, p.mover);
});

test('dias inválido o fuera de 7–365 → 400', async () => {
  const { llamar } = montar();
  for (const dias of ['abc', '6', '366', '7.5', '-1']) assert.strictEqual((await llamar({ dias })).code, 400, dias);
  assert.strictEqual((await llamar({ dias: '7' })).code, 200);
  assert.strictEqual((await llamar({ dias: '365' })).code, 200);
});

test('sin dias usa el default de config (o 30)', async () => {
  assert.strictEqual((await montar().llamar({})).body.rango.dias, 30);
  assert.strictEqual((await montar({ distCfg: { redistribucion: { dias: 60 } } }).llamar({})).body.rango.dias, 60);
});

test('sin filas devuelve productos vacío y no consulta ventas', async () => {
  const m = montar();
  const res = await m.llamar({ dias: '30' });
  assert.deepStrictEqual(res.body.productos, []);
  assert.strictEqual(m.sqls.length, 0);
});

test('error del motor/SQL → 500 con mensaje', async () => {
  const res = await montar({ falla: 'timeout SQL' }).llamar({ dias: '30' });
  assert.strictEqual(res.code, 500);
  assert.strictEqual(res.body.error, 'timeout SQL');
});

test('consulta ventas solo de productos con central 0 (central > 0 queda afuera aunque falte)', async () => {
  // 200 (central 50 > necesidad 10) y 300 (central 10 = necesidad 10) quedan afuera por central > 0
  const m = montar({ alm: [filaAlm('100', 0), filaAlm('200', 50), filaAlm('300', 10)] });
  await m.llamar({ dias: '30' });
  assert.strictEqual(m.sqls.length, 1);
  assert.match(m.sqls[0], /'100'/);
  assert.doesNotMatch(m.sqls[0], /'200'|'300'/);
});

// ── Necesidad = max(0, S − stock), 0 si Fact/Restringido (nota 2026-11-16 del spec) ──
// Donante fijo: sucursal9 con 50 de stock, S 0 y sin ventas → sobra todo. Central 0.
const filaUrq = (extra = {}) => ({ plu: '500', nombre: 'Prod 500', rubro: 'Almacen', central: 0,
  presentacion: { unidadesPorBulto: 1 },
  sSuc: { urq: 15, riv: 10, sucursal9: 0 }, minSuc: { urq: 5, riv: 2, sucursal9: 0 },
  stkSuc: { urq: 11, riv: 0, sucursal9: 50 }, ideal: {}, enviar: {}, enviarTexto: {}, ...extra });
const ventasUrq = [{ IdProducto: '500', IdSucursal: 2, Unidades: 300 }, { IdProducto: '500', IdSucursal: 5, Unidades: 300 }];

test('stock < S y stock >= min → necesidad = S − stock (Urquiza 11/15 → 4)', async () => {
  const res = await montar({ alm: [filaUrq()], ventas: ventasUrq }).llamar({ dias: '30' });
  const [p] = res.body.productos;
  assert.strictEqual(p.sucursales['2'].necesidad, 4);
  assert.strictEqual(p.sucursales['5'].necesidad, 10);
  assert.strictEqual(p.demanda, 14);
});

test('stock >= S → necesidad 0', async () => {
  const res = await montar({ alm: [filaUrq({ stkSuc: { urq: 15, riv: 0, sucursal9: 50 } })], ventas: ventasUrq }).llamar({ dias: '30' });
  const [p] = res.body.productos;
  assert.strictEqual(p.sucursales['2'].necesidad, 0);
  assert.strictEqual(p.demanda, 10);
  const res2 = await montar({ alm: [filaUrq({ stkSuc: { urq: 40, riv: 0, sucursal9: 50 } })], ventas: ventasUrq }).llamar({ dias: '30' });
  assert.strictEqual(res2.body.productos[0].sucursales['2'].necesidad, 0);
});

test('enviar o enviarTexto Fact/Restringido → necesidad 0', async () => {
  for (const extra of [{ enviar: { urq: 'Fact' } }, { enviar: { urq: 'Restringido' } },
    { enviarTexto: { urq: 'Fact' } }, { enviarTexto: { urq: 'Restringido' } }]) {
    const res = await montar({ alm: [filaUrq(extra)], ventas: ventasUrq }).llamar({ dias: '30' });
    const [p] = res.body.productos;
    assert.strictEqual(p.sucursales['2'].necesidad, 0, JSON.stringify(extra));
    assert.strictEqual(p.sucursales['5'].necesidad, 10, JSON.stringify(extra));
    assert.ok(p.movimientos.every(m => m.destino !== 2), JSON.stringify(extra));
  }
  // 'No' / numérico no anulan la necesidad
  const res = await montar({ alm: [filaUrq({ enviarTexto: { urq: 'No' }, enviar: { urq: 0 } })], ventas: ventasUrq }).llamar({ dias: '30' });
  assert.strictEqual(res.body.productos[0].sucursales['2'].necesidad, 4);
});

const filaPes = (extra = {}) => ({ plu: '700', nombre: 'Pes 700', rubro: 'Pesables Fraccionado', H: 0, presKg: 0.5,
  sLev: { urq: 3, ramallo: 0 }, mins: { urq: 1, ramallo: 0 }, stkSuc: { urq: -2, ramallo: 20 }, ideal: {}, enviar: {}, ...extra });

test('pesables: stock negativo se trata como 0 → necesidad = S', async () => {
  const res = await montar({ pes: [filaPes()], ventas: [{ IdProducto: '700', IdSucursal: 2, Unidades: 100 }] }).llamar({ dias: '30' });
  const [p] = res.body.productos;
  assert.strictEqual(p.unidad, 'kg');
  assert.strictEqual(p.sucursales['2'].stock, 0);
  assert.strictEqual(p.sucursales['2'].necesidad, 3);
  assert.ok(p.movimientos.some(m => m.origen === 9 && m.destino === 2));
  const r2 = await montar({ pes: [filaPes({ enviar: { urq: 'Restringido' } })] }).llamar({ dias: '30' });
  assert.deepStrictEqual(r2.body.productos, []);
});

// ── No envasa = necesidad 0 (lista global por PLU, decisión 2026-11-18) ──
test('almacén noEnvasa con stock < S en todas → necesidad 0 y no consulta sus ventas', async () => {
  // Arrange: 500 (urq 11/15, riv 0/10) está en noEnvasa; 100 es candidato normal
  const m = montar({ alm: [filaUrq(), filaAlm('100', 0)], ventas: ventasUrq, listas: { noEnvasa: ['500'] } });
  // Act
  const res = await m.llamar({ dias: '30' });
  // Assert
  assert.strictEqual(m.sqls.length, 1);
  assert.match(m.sqls[0], /'100'/);
  assert.doesNotMatch(m.sqls[0], /'500'/);
  assert.ok(res.body.productos.every(p => p.plu !== '500'));
});

test('almacén noEnvasa solo → no hay candidatas ni consulta de ventas', async () => {
  const m = montar({ alm: [filaUrq()], ventas: ventasUrq, listas: { noEnvasa: ['500'] } });
  const res = await m.llamar({ dias: '30' });
  assert.strictEqual(m.sqls.length, 0);
  assert.deepStrictEqual(res.body.productos, []);
});

test('pesable noEnvasa → necesidad 0 en todas (no se lista)', async () => {
  const m = montar({ pes: [filaPes()], ventas: [{ IdProducto: '700', IdSucursal: 2, Unidades: 100 }], listas: { noEnvasa: ['700'] } });
  const res = await m.llamar({ dias: '30' });
  assert.deepStrictEqual(res.body.productos, []);
  assert.strictEqual(m.sqls.length, 0);
});

test('fuera de noEnvasa, enviar No / enviarTexto 0 no anulan: necesidad S − stock', async () => {
  for (const extra of [{ enviar: { urq: 'No' } }, { enviarTexto: { urq: 0 } }]) {
    const res = await montar({ alm: [filaUrq(extra)], ventas: ventasUrq, listas: { noEnvasa: ['999'] } }).llamar({ dias: '30' });
    assert.strictEqual(res.body.productos[0].sucursales['2'].necesidad, 4, JSON.stringify(extra));
  }
});

test('Fact/Restringido siguen en 0 con lista noEnvasa presente', async () => {
  const res = await montar({ alm: [filaUrq({ enviar: { urq: 'Restringido' }, enviarTexto: { riv: 'Fact' } })],
    ventas: ventasUrq, listas: { noEnvasa: ['999'] } }).llamar({ dias: '30' });
  // ambas sucursales con necesidad 0 → sin faltante → no se lista
  assert.deepStrictEqual(res.body.productos, []);
  const r2 = await montar({ alm: [filaUrq({ enviar: { urq: 'Fact' } })], ventas: ventasUrq, listas: { noEnvasa: ['999'] } }).llamar({ dias: '30' });
  assert.strictEqual(r2.body.productos[0].sucursales['2'].necesidad, 0);
  assert.strictEqual(r2.body.productos[0].sucursales['5'].necesidad, 10);
});

test('comportamiento actual: noEnvasa con stock parado (sucursal9: 50, sin ventas) nunca dona', async () => {
  // Sin noEnvasa el mismo producto dona desde 9; con noEnvasa no tiene faltante propio → no se lista
  const sin = await montar({ alm: [filaUrq()], ventas: ventasUrq }).llamar({ dias: '30' });
  assert.ok(sin.body.productos[0].movimientos.some(m => m.origen === 9));
  const con = await montar({ alm: [filaUrq()], ventas: ventasUrq, listas: { noEnvasa: ['500'] } }).llamar({ dias: '30' });
  assert.deepStrictEqual(con.body.productos, []);
  assert.deepStrictEqual(con.body.resumenSucursales, {});
});

test('noEnvasa numérico matchea PLU string y viceversa', async () => {
  const a = await montar({ alm: [filaUrq()], ventas: ventasUrq, listas: { noEnvasa: [500] } }).llamar({ dias: '30' });
  assert.deepStrictEqual(a.body.productos, []);
  const b = await montar({ alm: [filaUrq({ plu: 500 })], ventas: ventasUrq, listas: { noEnvasa: ['500'] } }).llamar({ dias: '30' });
  assert.deepStrictEqual(b.body.productos, []);
});

test('listas sin clave noEnvasa o con null → no rompe y calcula normal', async () => {
  for (const listas of [{}, { noEnvasa: null }]) {
    const res = await montar({ alm: [filaUrq()], ventas: ventasUrq, listas }).llamar({ dias: '30' });
    assert.strictEqual(res.code, 200, JSON.stringify(listas));
    assert.strictEqual(res.body.productos[0].sucursales['2'].necesidad, 4);
  }
});

// ── Solo productos con central en 0 (decisión 2026-11-18) ──
test('central 0 con necesidad → entra y faltante = demanda', async () => {
  // Arrange
  const m = montar({ alm: [filaUrq()], ventas: ventasUrq });
  // Act
  const [p] = (await m.llamar({ dias: '30' })).body.productos;
  // Assert
  assert.strictEqual(p.central, 0);
  assert.strictEqual(p.demanda, 14);
  assert.strictEqual(p.faltante, p.demanda);
});

test('almacén con central mínima (1) → no entra ni se consulta', async () => {
  const m = montar({ alm: [filaUrq({ central: 1 })], ventas: ventasUrq });
  const res = await m.llamar({ dias: '30' });
  assert.strictEqual(m.sqls.length, 0);
  assert.deepStrictEqual(res.body.productos, []);
  // con un candidato válido el IN no trae a los descartados
  const m2 = montar({ alm: [filaUrq({ central: 1 }), filaAlm('100', 0)] });
  await m2.llamar({ dias: '30' });
  assert.strictEqual(m2.sqls.length, 1);
  assert.match(m2.sqls[0], /'100'/);
  assert.doesNotMatch(m2.sqls[0], /'500'/);
});

test('central negativa (-5) → entra, se calcula como 0 y se informa 0 (nunca negativa)', async () => {
  const [p] = (await montar({ alm: [filaUrq({ central: -5 })], ventas: ventasUrq }).llamar({ dias: '30' })).body.productos;
  assert.strictEqual(p.central, 0);
  assert.strictEqual(p.faltante, 14);
});

test('central 10 < Σ necesidad 50 → ya NO entra (antes sí)', async () => {
  const fila = filaUrq({ central: 10, sSuc: { urq: 0, riv: 50, sucursal9: 0 }, stkSuc: { urq: 0, riv: 0, sucursal9: 50 } });
  const m = montar({ alm: [fila], ventas: ventasUrq });
  const res = await m.llamar({ dias: '30' });
  assert.strictEqual(m.sqls.length, 0);
  assert.deepStrictEqual(res.body.productos, []);
  // control: misma fila con central 0 sí entra
  const r0 = await montar({ alm: [{ ...fila, central: 0 }], ventas: ventasUrq }).llamar({ dias: '30' });
  assert.strictEqual(r0.body.productos[0].faltante, 50);
});

test('central 0 con Σ necesidad 0 (Fact/Restringido/No envasa) → no entra ni se consulta', async () => {
  for (const [extra, listas] of [
    [{ enviar: { urq: 'Fact' }, enviarTexto: { riv: 'Restringido' } }, { noEnvasa: [] }],
    [{}, { noEnvasa: ['500'] }]]) {
    const m = montar({ alm: [filaUrq(extra)], ventas: ventasUrq, listas });
    const res = await m.llamar({ dias: '30' });
    assert.strictEqual(m.sqls.length, 0, JSON.stringify(extra));
    assert.deepStrictEqual(res.body.productos, []);
  }
});

test('todos descartados → ninguna consulta SQL, productos [] y resumen vacío', async () => {
  const m = montar({ alm: [filaAlm('200', 50), filaUrq({ central: 3 })], pes: [filaPes({ H: 2, enviar: { urq: 'Fact' } })], ventas: ventasUrq });
  const res = await m.llamar({ dias: '30' });
  assert.strictEqual(m.sqls.length, 0);
  assert.deepStrictEqual(res.body.productos, []);
  assert.deepStrictEqual(res.body.resumenSucursales, {});
  assert.deepStrictEqual(res.body.totales, { productos: 0, movimientos: 0 });
});

test('IN de ventas: almacén con central ≤ 0 y necesidad > 0; pesables con necesidad > 0 aunque H > 0', async () => {
  const m = montar({
    alm: [filaAlm('100', 0), filaAlm('101', -3), filaAlm('102', 4), filaUrq({ plu: '103', enviar: { urq: 'Fact', riv: 'Fact' } })],
    pes: [filaPes(), filaPes({ plu: '701', H: 0.5 }), filaPes({ plu: '702', H: -1 })],
  });
  await m.llamar({ dias: '30' });
  assert.strictEqual(m.sqls.length, 1);
  for (const plu of ['100', '101', '700', '701', '702']) assert.match(m.sqls[0], new RegExp(`'${plu}'`));
  for (const plu of ['102', '103']) assert.doesNotMatch(m.sqls[0], new RegExp(`'${plu}'`));
});

test('resumenSucursales cuadra y solo cuenta productos con central 0', async () => {
  const m = montar({
    alm: [filaUrq(), filaUrq({ plu: '501', central: 5 }), filaAlm('100', 0)],
    pes: [filaPes()],
    ventas: [...ventasUrq, { IdProducto: '100', IdSucursal: 5, Unidades: 200 }, { IdProducto: '700', IdSucursal: 2, Unidades: 100 }],
  });
  const { productos, resumenSucursales } = (await m.llamar({ dias: '30' })).body;
  assert.deepStrictEqual(productos.map(p => p.plu).sort(), ['100', '500', '700']);
  for (const p of productos) {
    const sale = p.movimientos.reduce((a, x) => a + x.cantidad, 0);
    assert.ok(sale > 0, p.plu);
    for (const [s, x] of Object.entries(p.sucursales)) {
      const sal = p.movimientos.filter(mv => String(mv.origen) === s).reduce((a, mv) => a + mv.cantidad, 0);
      const ent = p.movimientos.filter(mv => String(mv.destino) === s).reduce((a, mv) => a + mv.cantidad, 0);
      assert.ok(Math.abs(x.stockFinal - (x.stock - sal + ent)) < 1e-9, `${p.plu}/${s}`);
    }
  }
  let sale = 0, entra = 0;
  for (const r of Object.values(resumenSucursales)) {
    sale += r.sale; entra += r.entra;
    assert.ok(Math.abs(r.stockDespues - (r.stockAntes - r.sale + r.entra)) < 1e-9);
  }
  assert.ok(Math.abs(sale - entra) < 1e-9);
  const mov = productos.reduce((a, p) => a + p.movimientos.reduce((b, x) => b + x.cantidad, 0), 0);
  assert.ok(Math.abs(sale - mov) < 1e-9, 'el 501 (central 5) no suma al resumen');
});

// ── centralGranel (granel de central f.F): informativo, no filtra (2026-11-18) ──
const ventasPes = [{ IdProducto: '700', IdSucursal: 2, Unidades: 100 }];

test('pesable F=12 y H=0 → entra con centralGranel 12', async () => {
  // Arrange
  const m = montar({ pes: [filaPes({ F: 12 })], ventas: ventasPes });
  // Act
  const [p] = (await m.llamar({ dias: '30' })).body.productos;
  // Assert
  assert.strictEqual(p.plu, '700');
  assert.strictEqual(p.central, 0);
  assert.strictEqual(p.centralGranel, 12);
});

test('pesable F negativo → centralGranel 0; F no numérico → null; almacén → null', async () => {
  for (const [F, esperado] of [[-4, 0], ['abc', null], [undefined, null], [NaN, null]]) {
    const [p] = (await montar({ pes: [filaPes({ F })], ventas: ventasPes }).llamar({ dias: '30' })).body.productos;
    assert.strictEqual(p.centralGranel, esperado, String(F));
  }
  const [a] = (await montar({ alm: [filaAlm('100', 0)], ventas: [{ IdProducto: '100', IdSucursal: 5, Unidades: 200 }] })
    .llamar({ dias: '30' })).body.productos;
  assert.strictEqual(a.centralGranel, null);
});

// Pesables sin corte por central: el front filtra por central/centralGranel (2026-11-18).
test('pesable H=2 < demanda 3 → entra con central 2, centralGranel 0 y faltante 1', async () => {
  const ventas = [...ventasPes, { IdProducto: '701', IdSucursal: 2, Unidades: 100 }];
  const m = montar({ pes: [filaPes({ F: 500 }), filaPes({ plu: '701', H: 2, F: 0 })], ventas });
  const res = await m.llamar({ dias: '30' });
  assert.deepStrictEqual(res.body.productos.map(p => p.plu).sort(), ['700', '701']);
  const p = res.body.productos.find(x => x.plu === '701');
  assert.strictEqual(p.central, 2);
  assert.strictEqual(p.centralGranel, 0);
  assert.strictEqual(p.demanda, 3);
  assert.strictEqual(p.faltante, 1);
});

test('pesable con H que cubre la demanda → se consulta pero queda fuera (faltante 0)', async () => {
  const m = montar({ pes: [filaPes({ H: 3 })], ventas: ventasPes });
  const res = await m.llamar({ dias: '30' });
  assert.strictEqual(m.sqls.length, 1);
  assert.deepStrictEqual(res.body.productos, []);
});

test('el IN de ventas no cambia por el granel', async () => {
  const conF = montar({ pes: [filaPes({ F: 99 }), filaPes({ plu: '701', H: 1, F: 0 })], alm: [filaAlm('100', 0)] });
  const sinF = montar({ pes: [filaPes(), filaPes({ plu: '701', H: 1 })], alm: [filaAlm('100', 0)] });
  await conF.llamar({ dias: '30' });
  await sinF.llamar({ dias: '30' });
  assert.deepStrictEqual(conF.sqls, sinF.sqls);
});
