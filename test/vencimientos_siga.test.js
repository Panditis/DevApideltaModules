'use strict';
// Cruce SIGA de vencimientos con filas ya unidas (sin SQL real). Fixtures (a)-(k) de la spec + signo.
const test = require('node:test');
const assert = require('node:assert');
const { cruzarLote, normalizarTipo, consultarMovimientos } = require('../lib/vencimientos_siga');

const HOY = '2030-01-01';
const CFG = { tipoOferta: 'PARA OFERTA', tipoNoVendido: 'VENCIDO', depositoMovimientos: 1, diasAviso: 15, margenDias: 7 };
const lote = (id, venc, sucs, idProducto = 10) => ({ id, idProducto, vencimiento: venc, creado: '2029-12-01T10:00:00Z',
  sucursales: Object.fromEntries(Object.entries(sucs).map(([s, u]) => [s, { unidades: u, oferta: 0, vendido: 0, movimientos: [] }])) });
const fila = (Tipo, Cantidad, extra = {}) => ({ IdSucursal: 1, IdProducto: 10, Tipo, IdDeposito: 1, Cantidad, ...extra });
const uno = (lotes, filas, cfg = CFG) => cruzarLote(lotes, filas, cfg, HOY);
const L = [lote('A', '2030-03-01', { 1: 10 })];

test('(a) OK exacto → ok, en oferta', () => {
  const r = uno(L, [fila('PARA OFERTA', -10)]).porLote.A[1];
  assert.strictEqual(r.estadoCruce, 'ok');
  assert.strictEqual(r.estadoLote, 'en oferta');
  assert.strictEqual(r.diferencia, 0);
  assert.strictEqual(r.origenVendido, 'siga');
});

test('(b) movido < lote → ok con diferencia negativa', () => {
  const r = uno(L, [fila('PARA OFERTA', -4)]).porLote.A[1];
  assert.strictEqual(r.estadoCruce, 'ok');
  assert.strictEqual(r.diferencia, -6);
});

test('(c) movido > lote → diferencia', () => {
  const r = uno(L, [fila('PARA OFERTA', -12)]).porLote.A[1];
  assert.strictEqual(r.estadoCruce, 'diferencia');
  assert.strictEqual(r.diferencia, 2);
});

test('(d) tipo con espacios y minúsculas se normaliza', () => {
  assert.strictEqual(normalizarTipo(' para  oferta '), 'PARA OFERTA');
  assert.strictEqual(uno(L, [fila('para  oferta ', -10)]).porLote.A[1].movidoOferta, 10);
});

test('(e) depósito 2 se ignora', () => {
  const r = uno(L, [fila('PARA OFERTA', -10, { IdDeposito: 2 })]).porLote.A[1];
  assert.strictEqual(r.estadoCruce, 'sin movimiento');
});

test('(f) otra sucursal sin lote → huérfano, no toca el lote', () => {
  const { porLote, huerfanos } = uno(L, [fila('PARA OFERTA', -10, { IdSucursal: 2 })]);
  assert.strictEqual(porLote.A[1].movidoOferta, 0);
  assert.deepStrictEqual(huerfanos.map(h => [h.idSucursal, h.estadoCruce]), [[2, 'diferencia']]);
});

test('(g) producto sin lote → huérfano diferencia; sucursal ficticia se ignora', () => {
  const { huerfanos } = uno(L, [fila('PARA OFERTA', -3, { IdProducto: 99 }), fila('PARA OFERTA', -3, { IdSucursal: 6 })]);
  assert.deepStrictEqual(huerfanos, [{ idSucursal: 1, idProducto: 99, movidoOferta: 3, movidoVencido: 0, estadoCruce: 'diferencia' }]);
});

test('(h) sin movimiento a 5 días → aviso falta movimiento', () => {
  const r = uno([lote('A', '2030-01-06', { 1: 10 })], []).porLote.A[1];
  assert.strictEqual(r.estadoCruce, 'sin movimiento');
  assert.strictEqual(r.aviso, 'falta movimiento');
  assert.strictEqual(r.origenVendido, 'manual');
  assert.strictEqual(uno(L, []).porLote.A[1].aviso, null, 'lejos del vencimiento no avisa');
});

test('(i) VENCIDO parcial → vendido = oferta − vencido, cerrado', () => {
  const r = uno(L, [fila('PARA OFERTA', -10), fila('VENCIDO', -3)]).porLote.A[1];
  assert.strictEqual(r.vendidoSiga, 7);
  assert.strictEqual(r.vendido, 7);
  assert.strictEqual(r.estadoLote, 'cerrado');
  assert.strictEqual(r.estadoCruce, 'ok');
});

test('(j) VENCIDO > oferta → diferencia', () => {
  assert.strictEqual(uno(L, [fila('PARA OFERTA', -2), fila('VENCIDO', -5)]).porLote.A[1].estadoCruce, 'diferencia');
});

test('(k) dos lotes mismo producto: reparte por vencimiento más cercano primero', () => {
  const lotes = [lote('LEJOS', '2030-06-01', { 1: 10 }), lote('CERCA', '2030-02-01', { 1: 5 })];
  const { porLote } = uno(lotes, [fila('PARA OFERTA', -8)]);
  assert.strictEqual(porLote.CERCA[1].movidoOferta, 5);
  assert.strictEqual(porLote.LEJOS[1].movidoOferta, 3);
});

test('signo: Cantidad negativa o positiva dan el mismo resultado', () => {
  const neg = uno(L, [fila('PARA OFERTA', -10), fila('VENCIDO', -3)]);
  const pos = uno(L, [fila('PARA OFERTA', 10), fila('VENCIDO', 3)]);
  assert.deepStrictEqual(neg, pos);
});

test('manual como respaldo solo sin PARA OFERTA', () => {
  const l = lote('A', '2030-03-01', { 1: 10 });
  const conManual = { ...l, sucursales: { 1: { ...l.sucursales[1], vendido: 4 } } };
  assert.deepStrictEqual(pick(uno([conManual], []).porLote.A[1]), { vendido: 4, origenVendido: 'manual', vendidoManual: 4 });
  assert.deepStrictEqual(pick(uno([conManual], [fila('PARA OFERTA', -6)]).porLote.A[1]), { vendido: 6, origenVendido: 'siga', vendidoManual: 4 });
});
test('IdProducto char con espacios desde SQL matchea el lote entero', () => {
  const r = uno([lote('A', '2030-03-01', { 1: 10 }, 123)], [fila('PARA OFERTA', -10, { IdProducto: '123 ' })]);
  assert.strictEqual(r.porLote.A[1].movidoOferta, 10);
  assert.deepStrictEqual(r.huerfanos, []);
});
const pick = r => ({ vendido: r.vendido, origenVendido: r.origenVendido, vendidoManual: r.vendidoManual });

test('consulta: parametrizada, tipos normalizados, depósito y productos', async () => {
  const inputs = {};
  let sql = '';
  const getPool = async () => ({ request() { const r = { input(k, v) { inputs[k] = v; return r; }, async query(q) { sql = q; return { recordset: [] }; } }; return r; } });
  await consultarMovimientos(getPool, L, { ...CFG, tipoOferta: ' para oferta' }, HOY);
  assert.strictEqual(inputs.tipoOfertaSql, 'PARAOFERTA');
  assert.strictEqual(inputs.tipoNoVendidoSql, 'VENCIDO');
  assert.match(sql, /REPLACE\(m\.IdTipoMovimiento, ' ', ''\)/);
  assert.match(sql, /^\s*SELECT/);
  assert.doesNotMatch(sql, /PARA ?OFERTA|VENCIDO/, 'tipos solo por parámetro');
  assert.strictEqual(inputs.deposito, 1);
  assert.strictEqual(inputs.prod0, '10', 'ids como texto: no fuerza conversión de la columna a int');
  assert.match(sql, /LTRIM\(RTRIM\(CAST\(mp\.IdProducto AS VARCHAR\(50\)\)\)\) IN \(@prod0\)/);
  // regresión: msnodesqlv8 rompe el declare con nombres pN
  assert.ok(!Object.keys(inputs).some(k => /^p\d+$/.test(k)), 'sin nombres pN');
  assert.deepStrictEqual([...new Set(sql.match(/@prod\d+/g))].map(s => s.slice(1)).sort(), Object.keys(inputs).filter(k => /^prod\d+$/.test(k)).sort());
  assert.strictEqual(inputs.desde, '2029-11-24');
  assert.strictEqual(inputs.hasta, '2030-01-09');
  assert.match(sql, /mp\.IdDeposito = @deposito/);
  assert.match(sql, /NOT IN \(6,8,11\)/);
  assert.deepStrictEqual(await consultarMovimientos(getPool, [], CFG, HOY), [], 'sin lotes no consulta');
});

test('VENCIDO sin PARA OFERTA → diferencia y cerrado; origen manual', () => {
  const r = uno(L, [fila('VENCIDO', -4)]).porLote.A[1];
  assert.deepStrictEqual([r.estadoCruce, r.movidoVencido, r.estadoLote, r.origenVendido], ['diferencia', 4, 'cerrado', 'manual']);
});

test('lote cuya única columna es sucursal ficticia 6/8/11 no aparece ni genera huérfanos', () => {
  for (const suc of [6, 8, 11]) {
    const r = uno([lote('F', '2030-01-03', { [suc]: 5 })], [fila('PARA OFERTA', -5, { IdSucursal: suc })]);
    assert.deepStrictEqual(r, { porLote: {}, huerfanos: [] }, `suc ${suc}`);
  }
});

test('tipo pegado (PARAOFERTA) que pasa el filtro SQL se descarta en JS', () => {
  assert.strictEqual(uno(L, [fila('PARAOFERTA', -10)]).porLote.A[1].estadoCruce, 'sin movimiento');
  assert.strictEqual(uno(L, [fila('  PARA   OFERTA  ', -10)]).porLote.A[1].movidoOferta, 10);
});

test('config guardada vieja (solo umbrales) → defaults de cruce, diasAviso = rojo', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { crearStore } = require('../lib/vencimientos');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venc-cfg-'));
  const rutaConfig = path.join(dir, 'c.json');
  fs.writeFileSync(rutaConfig, JSON.stringify({ umbrales: { rojo: 10, amarillo: 30 } }));
  const store = crearStore({ rutaDatos: path.join(dir, 'v.json'), rutaConfig });
  assert.deepStrictEqual(await store.leerConfig(), { umbrales: { rojo: 10, amarillo: 30 }, tipoOferta: 'PARA OFERTA', tipoNoVendido: 'VENCIDO', depositoMovimientos: 1, margenDias: 7, diasMaxOferta: 10, tipoOfertaVencida: 'OFERTA VENCIDO', diasMaxVencido: 10, diasAviso: 10 });
});

test('marcarAsignados: busca en los arrays ofertasSistema del mismo producto y sucursal', () => {
  const { marcarAsignados } = require('../lib/vencimientos_siga');
  const lotes = [
    { id: 'a', idProducto: 10, sucursales: { 1: { ofertasSistema: [{ numeroMovimiento: 1 }, { numeroMovimiento: 2 }] } } },
    { id: 'b', idProducto: 10, sucursales: { 1: { ofertasSistema: [{ numeroMovimiento: 3 }] }, 2: { ofertasSistema: [{ numeroMovimiento: 4 }] } } },
    { id: 'c', idProducto: 11, sucursales: { 1: { ofertasSistema: [{ numeroMovimiento: 5 }] } } },
    { id: 'd', idProducto: 10, sucursales: { 1: {} } },
  ];
  const r = marcarAsignados([1, 2, 3, 4, 5].map(n => ({ numeroMovimiento: n })), lotes, 10, 1);
  assert.deepStrictEqual(r.map(m => m.asignadoA), [{ idLote: 'a', idSucursal: 1 }, { idLote: 'a', idSucursal: 1 }, { idLote: 'b', idSucursal: 1 }, null, null]);
});

test('consultarMovimientosClase vencido: tipo normalizado, ventana diasMaxVencido, sucursal y asignados en vencidosSistema', async () => {
  const { consultarMovimientosClase, marcarAsignados } = require('../lib/vencimientos_siga');
  const inputs = {};
  let sql = '';
  const filas = [{ NumeroMovimiento: 3, Fecha: '2029-12-30', Tipo: 'Oferta  Vencido', Cantidad: 0, Entra: 2, Sale: 2 }, { NumeroMovimiento: 4, Fecha: '2029-12-30', Tipo: 'OFERTAVENCIDO', Cantidad: 0, Entra: 1, Sale: 1 }];
  const getPool = async () => ({ request() { const r = { input(k, v) { inputs[k] = v; return r; }, async query(q) { sql = q; return { recordset: filas }; } }; return r; } });
  const r = await consultarMovimientosClase(getPool, { clase: 'vencido', idProducto: 10, idSucursal: 3, config: { ...CFG, tipoOfertaVencida: ' oferta vencido', diasMaxVencido: 5, diasMaxOferta: 99 }, hoy: HOY });
  assert.deepStrictEqual(r, [{ numeroMovimiento: 3, fecha: '2029-12-30', cantidad: 2, entra: 2, asimetrico: false }]);
  assert.deepStrictEqual([inputs.tipoMovimientoSql, inputs.desde, inputs.sucursal, inputs.producto], ['OFERTAVENCIDO', '2029-12-27', 3, '10']);
  assert.ok(Object.keys(inputs).every(k => !/^p\d+$/.test(k)));
  assert.match(sql, /ABS\(SUM\(mp\.Cantidad\)\)/);
  const lotes = [{ id: 'A', idProducto: 10, sucursales: { 3: { ofertasSistema: [{ numeroMovimiento: 3 }] } } }, { id: 'B', idProducto: 10, sucursales: { 3: { vencidosSistema: [{ numeroMovimiento: 3 }] } } }];
  assert.deepStrictEqual(marcarAsignados(r, lotes, 10, 3, 'vencido')[0].asignadoA, { idLote: 'B', idSucursal: 3 });
  assert.deepStrictEqual(marcarAsignados(r, lotes, 10, 3)[0].asignadoA, { idLote: 'A', idSucursal: 3 });
});

test('consultarMovimientosClase: vencido toma solo las líneas negativas (Sale) y omite 0; oferta sigue con ABS(SUM)', async () => {
  const { consultarMovimientosClase } = require('../lib/vencimientos_siga');
  const correr = async (clase, filas) => {
    const inputs = {}; let sql = '';
    const getPool = async () => ({ request() { const r = { input(k, v) { inputs[k] = v; return r; }, async query(q) { sql = q; return { recordset: filas }; } }; return r; } });
    const r = await consultarMovimientosClase(getPool, { clase, idProducto: 10, idSucursal: 3, config: { ...CFG, tipoOfertaVencida: 'OFERTA VENCIDO', diasMaxVencido: 5, diasMaxOferta: 5 }, hoy: HOY });
    return { r, sql, inputs };
  };
  const f = (n, tipo, cant, entra, sale) => ({ NumeroMovimiento: n, Fecha: '2029-12-30', Tipo: tipo, Cantidad: cant, Entra: entra, Sale: sale });
  // +2/-2 -> 2; +5/-2 -> 2; solo positivas -> fuera; solo negativas -> su total; -1 y -3 del mismo mov (SQL suma) -> 4.
  const ve = await correr('vencido', [f(1, 'OFERTA VENCIDO', 0, 2, 2), f(2, 'OFERTA VENCIDO', 3, 5, 2), f(3, 'OFERTA VENCIDO', 4, 4, 0),
    f(4, 'OFERTA VENCIDO', 3, 0, 3), f(7, 'OFERTA VENCIDO', 4, 0, 4)]);
  assert.deepStrictEqual(ve.r.map(m => [m.numeroMovimiento, m.cantidad, m.entra, m.asimetrico]), [[7, 4, 0, true], [4, 3, 0, true], [2, 2, 5, true], [1, 2, 2, false]]);
  assert.ok(ve.sql.includes('SUM(CASE WHEN mp.Cantidad > 0 THEN mp.Cantidad ELSE 0 END) AS Entra'));
  assert.ok(ve.sql.includes('SUM(CASE WHEN mp.Cantidad < 0 THEN -mp.Cantidad ELSE 0 END) AS Sale'));
  assert.ok(!/@p\d/.test(ve.sql));
  assert.ok(Object.keys(ve.inputs).every(k => !/^p\d+$/.test(k)));
  const of = await correr('oferta', [f(5, CFG.tipoOferta, 2, 0, 2), f(6, CFG.tipoOferta, 0, 1, 1)]);
  assert.deepStrictEqual(of.r, [{ numeroMovimiento: 6, fecha: '2029-12-30', cantidad: 0, entra: 0, asimetrico: false }, { numeroMovimiento: 5, fecha: '2029-12-30', cantidad: 2, entra: 0, asimetrico: false }]);
});

test('consultarMovimientosClase sin idProducto: une Productos/Rubros, TOP, rubros como parámetros, ventana por clase', async () => {
  const { consultarMovimientosClase } = require('../lib/vencimientos_siga');
  const correr = async (opciones, filas) => {
    const inputs = {}; let sql = '';
    const getPool = async () => ({ request() { const r = { input(k, v) { inputs[k] = v; return r; }, async query(q) { sql = q; return { recordset: filas }; } }; return r; } });
    const r = await consultarMovimientosClase(getPool, { idSucursal: 3, config: { ...CFG, tipoOfertaVencida: 'OFERTA VENCIDO', diasMaxVencido: 5, diasMaxOferta: 2 }, hoy: HOY, ...opciones });
    return { r, sql, inputs };
  };
  const fila = { NumeroMovimiento: 9, Fecha: '2029-12-31', Tipo: 'PARA OFERTA', Cantidad: 4, Entra: 0, Sale: 4, IdProducto: ' 10 ', NombreProducto: 'Yerba ', CodigoDeBarras: '779 ' };
  const sin = await correr({ clase: 'oferta', rubros: ['Almacen', 'Pesables Fraccionado'], tope: 500 }, [fila]);
  assert.deepStrictEqual(sin.r, [{ numeroMovimiento: 9, fecha: '2029-12-31', idProducto: 10, nombre: 'Yerba', codigo: '779', cantidad: 4, entra: 0, asimetrico: false }]);
  assert.strictEqual(sin.inputs.producto, undefined);
  assert.deepStrictEqual([sin.inputs.rubro0, sin.inputs.rubro1, sin.inputs.desde], ['Almacen', 'Pesables Fraccionado', '2029-12-30']);
  assert.ok(Object.keys(sin.inputs).every(k => !/^p\d+$/.test(k)));
  assert.match(sin.sql, /SELECT TOP 500 /);
  assert.match(sin.sql, /INNER JOIN Rubros r/);
  assert.match(sin.sql, /r\.NombreRubro IN \(@rubro0, @rubro1\)/);
  assert.match(sin.sql, /ORDER BY .* DESC/);
  assert.ok(!sin.sql.includes('@producto'));
  const ve = await correr({ clase: 'vencido', rubros: ['Almacen'] }, []);
  assert.strictEqual(ve.inputs.desde, '2029-12-27');
  assert.match(ve.sql, /HAVING/);
  // Con idProducto y sin rubros: la consulta de siempre (sin TOP, sin joins, sin columnas extra).
  const con = await correr({ clase: 'oferta', idProducto: 10 }, [fila]);
  assert.deepStrictEqual(con.r, [{ numeroMovimiento: 9, fecha: '2029-12-31', cantidad: 4, entra: 0, asimetrico: false }]);
  assert.ok(!/TOP|Productos p|Rubros|ORDER BY/.test(con.sql));
  assert.strictEqual(con.inputs.producto, '10');
});
