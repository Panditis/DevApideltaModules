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
const fin = FUENTE.indexOf('// Export xlsx de la tab "Sin fraccionar"');
assert.ok(ini > 0 && fin > ini, 'no se encontró el bloque de redistribución');
const BLOQUE = FUENTE.slice(ini, fin);

function montar({ alm = [], pes = [], ventas = [], falla = null, distCfg = {} } = {}) {
  const sqls = [];
  const deps = {
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

test('consulta ventas solo de productos con necesidad total > stock central', async () => {
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
