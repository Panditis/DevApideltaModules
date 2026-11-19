'use strict';
// Rutas de vencimientos: store real sobre tmp dir, sesión y SIGA falsos.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { crearStore } = require('../lib/vencimientos');
const crearRutas = require('../routes/rutas_vencimientos');

const USUARIOS = {
  ana: { id: 1, usuario: 'ana', esAdmin: false, idSucursal: 1 },
  beto: { id: 2, usuario: 'beto', esAdmin: false, idSucursal: 2 },
  sin: { id: 3, usuario: 'sin', esAdmin: false },
  admin: { id: 4, usuario: 'admin', esAdmin: true },
  ficticia: { id: 5, usuario: 'ficticia', esAdmin: false, idSucursal: 6 },
};

function armar({ filas = [], falla = false, tienePermiso } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venc-rutas-'));
  const store = crearStore({ rutaDatos: path.join(dir, 'v.json'), rutaConfig: path.join(dir, 'c.json') });
  const sql = { query: null, inputs: {} };
  const getPool = async () => ({ request() {
    const r = { input(k, v) { sql.inputs[k] = v; return r; }, async query(q) { sql.query = q; if (falla) throw new Error("SIGA caído"); return { recordset: filas }; } };
    return r;
  } });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: USUARIOS[req.get('x-user')] }; next(); });
  const cambiosUsuario = [];
  app.use(crearRutas({ store, getPool, idSucursalDe: u => u.idSucursal || null, actualizarUsuario: (id, c) => cambiosUsuario.push({ id, ...c }), tienePermiso }));
  let server;
  const pedir = async (user, metodo, ruta, body) => {
    if (!server) server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const res = await fetch(`http://127.0.0.1:${server.address().port}${ruta}`, {
      method: metodo, headers: { 'x-user': user, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { pedir, sql, cambiosUsuario, cerrar: () => { if (server) { server.closeAllConnections(); server.close(); } } };
}

const ALTA = { idProducto: 10, vencimiento: '2030-12-31', unidades: 20, nombre: 'Yerba', codigo: '779' };

test('alta propia + otra sucursal suma columna; listado compartido', async () => {
  const a = armar();
  try {
    const r1 = await a.pedir('ana', 'POST', '/api/vencimientos/lotes', { ...ALTA, idSucursal: 5 });
    assert.strictEqual(r1.status, 200);
    assert.deepStrictEqual(Object.keys(r1.body.sucursales), ['1'], 'ignora idSucursal del body');
    assert.strictEqual(r1.body.nombre, 'Yerba');
    await a.pedir('beto', 'POST', '/api/vencimientos/lotes', { ...ALTA, unidades: 5 });
    const l = await a.pedir('ana', 'GET', '/api/vencimientos/lotes');
    assert.strictEqual(l.body.lotes.length, 1);
    assert.deepStrictEqual(l.body.sucursales, [1, 2]);
    assert.strictEqual(l.body.lotes[0].totalUnidades, 25);
    assert.strictEqual(l.body.lotes[0].semaforo, 'verde');
    assert.deepStrictEqual(l.body.usuario, { idSucursal: 1, esAdmin: false });
    assert.deepStrictEqual(l.body.umbrales, { rojo: 15, amarillo: 45 });
  } finally { a.cerrar(); }
});

test('usuario sin sucursal: 403 con mensaje; admin elige sucursal', async () => {
  const a = armar();
  try {
    const r = await a.pedir('sin', 'POST', '/api/vencimientos/lotes', ALTA);
    assert.strictEqual(r.status, 403);
    assert.match(r.body.error, /no tiene sucursal asignada/);
    const ad = await a.pedir('admin', 'POST', '/api/vencimientos/lotes', { ...ALTA, idSucursal: 3 });
    assert.deepStrictEqual(Object.keys(ad.body.sucursales), ['3']);
  } finally { a.cerrar(); }
});

test('editar otra sucursal: 403 aunque mande idSucursal; propia ok; admin ok', async () => {
  const a = armar();
  try {
    const { body: lote } = await a.pedir('ana', 'POST', '/api/vencimientos/lotes', ALTA);
    await a.pedir('beto', 'POST', '/api/vencimientos/lotes', ALTA);
    const u = `/api/vencimientos/lotes/${lote.id}`;
    assert.strictEqual((await a.pedir('ana', 'PUT', `${u}/unidades`, { unidades: 3, idSucursal: 2 })).status, 403);
    assert.strictEqual((await a.pedir('ana', 'POST', `${u}/movimientos`, { tipo: 'oferta', cantidad: 1, idSucursal: 2 })).status, 403);
    const ok = await a.pedir('ana', 'PUT', `${u}/unidades`, { unidades: 15 });
    assert.strictEqual(ok.body.sucursales['1'].unidades, 15);
    const mov = await a.pedir('admin', 'POST', `${u}/movimientos`, { tipo: 'vendido', cantidad: 2, idSucursal: 2 });
    assert.strictEqual(mov.body.sucursales['2'].vendido, 2);
    const h = await a.pedir('ana', 'GET', '/api/vencimientos/historial?idSucursal=2');
    assert.strictEqual(h.body.idSucursal, 1, 'no admin no elige sucursal en historial');
    assert.deepStrictEqual(h.body.movimientos.map(m => m.tipo), ['correccion', 'alta']);
  } finally { a.cerrar(); }
});

test('DELETE y PUT config solo admin', async () => {
  const a = armar();
  try {
    const { body: lote } = await a.pedir('ana', 'POST', '/api/vencimientos/lotes', ALTA);
    assert.strictEqual((await a.pedir('ana', 'DELETE', `/api/vencimientos/lotes/${lote.id}`)).status, 403);
    assert.strictEqual((await a.pedir('admin', 'DELETE', `/api/vencimientos/lotes/${lote.id}`)).status, 200);
    assert.strictEqual((await a.pedir('ana', 'PUT', '/api/vencimientos/config', { umbrales: { rojo: 5, amarillo: 10 } })).status, 403);
    assert.strictEqual((await a.pedir('admin', 'PUT', '/api/vencimientos/config', { umbrales: { rojo: 20, amarillo: 10 } })).status, 400);
    const ok = await a.pedir('admin', 'PUT', '/api/vencimientos/config', { umbrales: { rojo: 5, amarillo: 10 } });
    assert.deepStrictEqual(ok.body.umbrales, { rojo: 5, amarillo: 10 });
    assert.strictEqual(ok.body.diasAviso, 5, "diasAviso sigue al rojo");
    assert.deepStrictEqual((await a.pedir('ana', 'GET', '/api/vencimientos/config')).body, ok.body);
  } finally { a.cerrar(); }
});

test('validaciones en el borde', async () => {
  const a = armar();
  try {
    for (const b of [{ ...ALTA, idProducto: 'x' }, { ...ALTA, unidades: 0 }, { ...ALTA, unidades: 1.5 }, { ...ALTA, vencimiento: '31/12/2030' }]) {
      assert.strictEqual((await a.pedir('ana', 'POST', '/api/vencimientos/lotes', b)).status, 400, JSON.stringify(b));
    }
    assert.strictEqual((await a.pedir('ana', 'PUT', '/api/vencimientos/lotes/abc/unidades', { unidades: 1 })).status, 400);
    const { body: lote } = await a.pedir('ana', 'POST', '/api/vencimientos/lotes', ALTA);
    assert.strictEqual((await a.pedir('ana', 'POST', `/api/vencimientos/lotes/${lote.id}/movimientos`, { tipo: 'oferta', cantidad: 21 })).status, 400);
    assert.strictEqual((await a.pedir('ana', 'POST', `/api/vencimientos/lotes/${lote.id}/movimientos`, { tipo: 'robo', cantidad: 1 })).status, 400);
    assert.strictEqual((await a.pedir('ana', 'POST', `/api/vencimientos/lotes/00000000-0000-0000-0000-000000000000/movimientos`, { tipo: 'oferta', cantidad: 1 })).status, 404);
  } finally { a.cerrar(); }
});

test('productos: mínimo 2 caracteres; SQL inyectado va como parámetro', async () => {
  const a = armar({ filas: [{ IdProducto: ' 10 ', CodigoDeBarras: '779', NombreProducto: 'Yerba' }] });
  try {
    assert.strictEqual((await a.pedir('ana', 'GET', '/api/vencimientos/productos?q=y')).status, 400);
    const evil = "'; DROP TABLE Productos--";
    const r = await a.pedir('ana', 'GET', `/api/vencimientos/productos?q=${encodeURIComponent(evil)}`);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, [{ idProducto: '10', codigo: '779', nombre: 'Yerba' }]);
    assert.ok(!a.sql.query.includes('DROP'));
    assert.match(a.sql.query, /TOP 30/);
    assert.strictEqual(a.sql.inputs.codigo, evil);
    assert.ok(!('idProducto' in a.sql.inputs), 'texto inyectado no va como IdProducto');
    assert.ok(!a.sql.query.includes('p.IdProducto ='));
  } finally { a.cerrar(); }
});

test('productos: por nombre no compara IdProducto; numérico sí, como entero', async () => {
  const a = armar();
  try {
    assert.strictEqual((await a.pedir('ana', 'GET', '/api/vencimientos/productos?q=leche')).status, 200);
    assert.ok(!('idProducto' in a.sql.inputs));
    assert.ok(!a.sql.query.includes('p.IdProducto ='));
    assert.strictEqual(a.sql.inputs.codigo, 'leche');
  } finally { a.cerrar(); }
  const b = armar();
  try {
    assert.strictEqual((await b.pedir('ana', 'GET', '/api/vencimientos/productos?q=1234')).status, 200);
    assert.strictEqual(b.sql.inputs.idProducto, 1234);
    assert.strictEqual(b.sql.inputs.codigo, '1234');
    assert.match(b.sql.query, /p\.IdProducto = @idProducto/);
  } finally { b.cerrar(); }
  const c = armar();
  try {
    await c.pedir('ana', 'GET', '/api/vencimientos/productos?q=99999999999999999999');
    assert.ok(!('idProducto' in c.sql.inputs), 'fuera de rango seguro no va como entero');
  } finally { c.cerrar(); }
});

test('productos: solo rubros Almacen y Pesables Fraccionado, como parámetros', async () => {
  const a = armar();
  try {
    assert.strictEqual((await a.pedir('ana', 'GET', '/api/vencimientos/productos?q=yerba mate')).status, 200);
    assert.match(a.sql.query, /INNER JOIN Rubros r ON r\.IdRubro = p\.IdRubro/);
    assert.match(a.sql.query, /r\.NombreRubro IN \(@rubro0, @rubro1\) AND \(\(/);
    assert.deepStrictEqual([a.sql.inputs.rubro0, a.sql.inputs.rubro1], ['Almacen', 'Pesables Fraccionado']);
    assert.ok(!('rubro2' in a.sql.inputs));
    for (const otro of ['Bultos', 'Cajas', 'Deposito', 'Venta Directa']) {
      assert.ok(!a.sql.query.includes(otro) && !Object.values(a.sql.inputs).includes(otro), otro);
    }
  } finally { a.cerrar(); }
});

test('PUT unidades: null, vacío o booleano no se toman como 0/1 (regresión)', async () => {
  const a = armar();
  try {
    const { body: lote } = await a.pedir('ana', 'POST', '/api/vencimientos/lotes', ALTA);
    for (const unidades of [null, '', true, ' ', '1e1']) {
      assert.strictEqual((await a.pedir('ana', 'PUT', `/api/vencimientos/lotes/${lote.id}/unidades`, { unidades })).status, 400, JSON.stringify(unidades));
    }
    const ok = await a.pedir('ana', 'PUT', `/api/vencimientos/lotes/${lote.id}/unidades`, { unidades: 0 });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.sucursales['1'].unidades, 0);
  } finally { a.cerrar(); }
});

test('no admin: historial ignora idSucursal ajeno; alta ignora idSucursal ajeno', async () => {
  const a = armar();
  try {
    const { body: lote } = await a.pedir('ana', 'POST', '/api/vencimientos/lotes', { ...ALTA, idSucursal: 2 });
    assert.deepStrictEqual(Object.keys(lote.sucursales), ['1']);
    const h = await a.pedir('beto', 'GET', '/api/vencimientos/historial?idSucursal=1');
    assert.strictEqual(h.body.idSucursal, 2);
    assert.strictEqual(h.body.movimientos.length, 0);
    assert.strictEqual((await a.pedir('ana', 'DELETE', `/api/vencimientos/lotes/${lote.id}`)).status, 403);
  } finally { a.cerrar(); }
});

test('altas simultáneas por HTTP de varias sucursales no pierden columnas', async () => {
  const a = armar();
  try {
    await a.pedir('ana', 'GET', '/api/vencimientos/config'); // levanta el server antes (armar lo crea lazy)
    const rs = await Promise.all([a.pedir('ana', 'POST', '/api/vencimientos/lotes', ALTA), a.pedir('beto', 'POST', '/api/vencimientos/lotes', ALTA),
      a.pedir('admin', 'POST', '/api/vencimientos/lotes', { ...ALTA, idSucursal: 3 })]);
    rs.forEach(r => assert.strictEqual(r.status, 200));
    const { body } = await a.pedir('ana', 'GET', '/api/vencimientos/lotes');
    assert.strictEqual(body.lotes.length, 1);
    assert.deepStrictEqual(Object.keys(body.lotes[0].sucursales).sort(), ['1', '2', '3']);
  } finally { a.cerrar(); }
});

test('sin sesión: 401; /vencimientos y /js/vencimientos.js se sirven', async () => {
  const a = armar();
  const app = express();
  app.use(crearRutas({ store: null, getPool: null, idSucursalDe: () => null }));
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    assert.strictEqual((await a.pedir('nadie', 'GET', '/api/vencimientos/lotes')).status, 401);
    const base = `http://127.0.0.1:${srv.address().port}`;
    const js = await fetch(base + '/js/vencimientos.js');
    assert.strictEqual(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.match(await js.text(), /\/api\/vencimientos/);
    const html = await fetch(base + '/vencimientos');
    assert.strictEqual(html.status, 200);
    assert.match(await html.text(), /\/js\/vencimientos\.js/);
  } finally { a.cerrar(); srv.closeAllConnections(); srv.close(); }
});

test('GET /cruce: lote con PARA OFERTA queda ok y en oferta; ve todas las sucursales', async () => {
  const a = armar({ filas: [{ IdSucursal: 2, IdProducto: 10, Tipo: 'PARA OFERTA', IdDeposito: 1, Cantidad: -5 }] });
  try {
    const { body: lote } = await a.pedir('beto', 'POST', '/api/vencimientos/lotes', ALTA);
    const r = await a.pedir('ana', 'GET', '/api/vencimientos/cruce');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.cruceDisponible, true);
    assert.strictEqual(r.body.cruce[lote.id]['2'].estadoCruce, 'ok');
    assert.strictEqual(r.body.cruce[lote.id]['2'].estadoLote, 'en oferta');
    assert.deepStrictEqual(r.body.huerfanos, []);
    assert.match(a.sql.query, /mp\.IdDeposito = @deposito/);
  } finally { a.cerrar(); }
});

test('(l) GET /cruce con SIGA caído: 200 cruceDisponible:false y el listado sigue', async () => {
  const a = armar({ falla: true });
  const errorOriginal = console.error;
  console.error = () => {};
  try {
    await a.pedir('ana', 'POST', '/api/vencimientos/lotes', ALTA);
    const r = await a.pedir('ana', 'GET', '/api/vencimientos/cruce');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.cruceDisponible, false);
    assert.strictEqual(r.body.mensaje, 'Cruce no disponible');
    assert.strictEqual((await a.pedir('ana', 'GET', '/api/vencimientos/lotes')).status, 200);
  } finally { console.error = errorOriginal; a.cerrar(); }
});

test('config de cruce: defaults, PUT admin valida, diasAviso sigue al rojo', async () => {
  const a = armar();
  try {
    const d = (await a.pedir('ana', 'GET', '/api/vencimientos/config')).body;
    assert.deepStrictEqual(d, { umbrales: { rojo: 15, amarillo: 45 }, tipoOferta: 'PARA OFERTA', tipoNoVendido: 'VENCIDO', depositoMovimientos: 1, margenDias: 7, diasMaxOferta: 10, tipoOfertaVencida: 'OFERTA VENCIDO', diasMaxVencido: 10, diasAntesVencimientoOferta: 3, diasAviso: 15 });
    assert.strictEqual((await a.pedir('ana', 'PUT', '/api/vencimientos/config', { diasAviso: 3 })).status, 403);
    for (const malo of [{ diasAviso: -1 }, { depositoMovimientos: 0 }, { tipoOferta: '  ' }, { tipoNoVendido: 'x'.repeat(51) }, {}]) {
      assert.strictEqual((await a.pedir('admin', 'PUT', '/api/vencimientos/config', malo)).status, 400, JSON.stringify(malo));
    }
    const ok = await a.pedir('admin', 'PUT', '/api/vencimientos/config', { diasAviso: 3, depositoMovimientos: 2, tipoOferta: ' Para Oferta ' });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual([ok.body.diasAviso, ok.body.depositoMovimientos, ok.body.tipoOferta, ok.body.umbrales.rojo], [3, 2, 'Para Oferta', 15]);
  } finally { a.cerrar(); }
});

test('PUT mi-sucursal: cambia solo la propia, vacío desasigna, valida y rechaza 6/8/11', async () => {
  const a = armar();
  try {
    const ok = await a.pedir('ana', 'PUT', '/api/vencimientos/mi-sucursal', { idSucursal: '3', id: 4 });
    assert.deepStrictEqual([ok.status, ok.body], [200, { ok: true, idSucursal: 3 }]);
    const vacio = await a.pedir('sin', 'PUT', '/api/vencimientos/mi-sucursal', { idSucursal: '' });
    assert.deepStrictEqual(vacio.body, { ok: true, idSucursal: null });
    assert.deepStrictEqual(a.cambiosUsuario, [{ id: 1, idSucursal: 3 }, { id: 3, idSucursal: null }]);
    for (const idSucursal of ['abc', 0, -2, 1.5, 6, 8, '11']) {
      const r = await a.pedir('ana', 'PUT', '/api/vencimientos/mi-sucursal', { idSucursal });
      assert.strictEqual(r.status, 400, String(idSucursal));
      assert.ok(r.body.error);
    }
    assert.strictEqual((await a.pedir('nadie', 'PUT', '/api/vencimientos/mi-sucursal', { idSucursal: 2 })).status, 401);
    assert.strictEqual(a.cambiosUsuario.length, 2);
  } finally { a.cerrar(); }
});

test('ventas: sin lotes no consulta SIGA', async () => {
  const a = armar();
  try {
    const r = await a.pedir('ana', 'GET', '/api/vencimientos/ventas');
    assert.deepStrictEqual(r.body, { ventasDisponible: true, idSucursal: 1, ventas: {} });
    assert.strictEqual(a.sql.query, null);
  } finally { a.cerrar(); }
});

const HOY_LOCAL = (() => { const h = new Date(); return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}-${String(h.getDate()).padStart(2, '0')}`; })();
const FILAS_VENTAS = [{ IdSucursal: 1, IdProducto: '10', Dia: HOY_LOCAL, Cantidad: 4 }, { IdSucursal: 2, IdProducto: '10', Dia: HOY_LOCAL, Cantidad: 2 }];

test('ventas: solo la sucursal del usuario, también en lotes que no cargó; otra no se mezcla', async () => {
  const a = armar({ filas: FILAS_VENTAS });
  try {
    const l = await a.pedir('beto', 'POST', '/api/vencimientos/lotes', ALTA); // lo carga la 2, no la 1
    const r = await a.pedir('ana', 'GET', '/api/vencimientos/ventas?idSucursal=2');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { ventasDisponible: true, idSucursal: 1, ventas: { [l.body.id]: { vendidoDesdeCarga: 4, promMensual12: 0.3 } } },
      'no admin ignora ?idSucursal');
    assert.strictEqual(a.sql.inputs.suc, 1);
    assert.match(a.sql.query, /v.IdSucursal = @suc/);
  } finally { a.cerrar(); }
});

test('ventas: admin elige ?idSucursal; inválida o ficticia → 400', async () => {
  const a = armar({ filas: FILAS_VENTAS });
  try {
    const l = await a.pedir('ana', 'POST', '/api/vencimientos/lotes', ALTA);
    const r = await a.pedir('admin', 'GET', '/api/vencimientos/ventas?idSucursal=2');
    assert.deepStrictEqual(r.body, { ventasDisponible: true, idSucursal: 2, ventas: { [l.body.id]: { vendidoDesdeCarga: 2, promMensual12: 0.2 } } });
    for (const q of ['abc', '0', '-1', '6', '8', '11']) assert.strictEqual((await a.pedir('admin', 'GET', `/api/vencimientos/ventas?idSucursal=${q}`)).status, 400, q);
  } finally { a.cerrar(); }
});

test('ventas: sin sucursal o sucursal ficticia → 200 sin consultar SIGA', async () => {
  const a = armar({ filas: FILAS_VENTAS });
  try {
    await a.pedir('ana', 'POST', '/api/vencimientos/lotes', ALTA);
    for (const u of ['sin', 'admin']) {
      assert.deepStrictEqual((await a.pedir(u, 'GET', '/api/vencimientos/ventas')).body,
        { ventasDisponible: true, idSucursal: null, mensaje: 'Sin sucursal asignada', ventas: {} });
    }
    assert.deepStrictEqual((await a.pedir('ficticia', 'GET', '/api/vencimientos/ventas?idSucursal=1')).body,
      { ventasDisponible: true, idSucursal: 6, mensaje: 'Sucursal no válida', ventas: {} });
    assert.strictEqual(a.sql.query, null);
  } finally { a.cerrar(); }
});

test('ventas: SIGA falla → 200 con ventasDisponible:false', async () => {
  const a = armar({ falla: true });
  try {
    await a.pedir('ana', 'POST', '/api/vencimientos/lotes', ALTA);
    const r = await a.pedir('ana', 'GET', '/api/vencimientos/ventas');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { ventasDisponible: false, idSucursal: 1, mensaje: 'Ventas no disponibles', ventas: {} });
  } finally { a.cerrar(); }
});

const FILA_OF = (n, fecha, cant) => ({ NumeroMovimiento: n, Fecha: new Date(`${fecha}T00:00:00Z`), Tipo: 'PARA  OFERTA ', Cantidad: cant });

test('movimientos-oferta: sucursal propia, parámetros, fecha límite, orden y asignadoA', async () => {
  const a = armar({ filas: [FILA_OF(5, '2026-11-01', 3), FILA_OF(9, '2026-11-10', 4), { ...FILA_OF(1, '2026-11-11', 1), Tipo: 'VENCIDO' }] });
  try {
    const { body: lote } = await a.pedir('ana', 'POST', '/api/vencimientos/lotes', ALTA);
    const r = await a.pedir('ana', 'GET', '/api/vencimientos/movimientos-oferta?idProducto=10&idSucursal=2');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.idSucursal, 1, 'no admin ignora idSucursal');
    assert.strictEqual(r.body.diasMax, 10);
    assert.deepStrictEqual(r.body.movimientos.map(m => [m.numeroMovimiento, m.fecha, m.cantidad]), [[9, '2026-11-10', 4], [5, '2026-11-01', 3]]);
    assert.ok(Object.keys(a.sql.inputs).every(k => !/^p\d+$/.test(k)), 'sin nombres pN');
    assert.strictEqual(a.sql.inputs.sucursal, 1);
    assert.strictEqual(a.sql.inputs.producto, '10');
    const d = new Date(); d.setDate(d.getDate() - 10);
    const esperado = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    assert.strictEqual(a.sql.inputs.desde, esperado);
    const p = await a.pedir('ana', 'POST', `/api/vencimientos/lotes/${lote.id}/oferta`, { numeroMovimiento: 9, confirmacion: 'ok' });
    assert.strictEqual(p.status, 200);
    const r2 = await a.pedir('ana', 'GET', '/api/vencimientos/movimientos-oferta?idProducto=10');
    assert.deepStrictEqual(r2.body.movimientos[0].asignadoA, { idLote: lote.id, idSucursal: 1 });
    assert.strictEqual(r2.body.movimientos[1].asignadoA, null);
    const ad = await a.pedir('admin', 'GET', '/api/vencimientos/movimientos-oferta?idProducto=10&idSucursal=2');
    assert.strictEqual(ad.body.idSucursal, 2);
    assert.strictEqual(a.sql.inputs.sucursal, 2);
  } finally { a.cerrar(); }
});

test('movimientos-oferta: 400 sin sucursal, ficticia, idProducto inválido; 502 si SIGA falla', async () => {
  const a = armar({ falla: true });
  try {
    assert.strictEqual((await a.pedir('sin', 'GET', '/api/vencimientos/movimientos-oferta?idProducto=10')).status, 400);
    assert.strictEqual((await a.pedir('ficticia', 'GET', '/api/vencimientos/movimientos-oferta?idProducto=10')).status, 400);
    assert.strictEqual((await a.pedir('admin', 'GET', '/api/vencimientos/movimientos-oferta?idProducto=10&idSucursal=8')).status, 400);
    assert.strictEqual((await a.pedir('admin', 'GET', '/api/vencimientos/movimientos-oferta?idProducto=10')).status, 400);
    for (const q of ['', 'abc', '0', '-3', '1.5']) assert.strictEqual((await a.pedir('ana', 'GET', `/api/vencimientos/movimientos-oferta?idProducto=${q}`)).status, 400);
    const f = await a.pedir('ana', 'GET', '/api/vencimientos/movimientos-oferta?idProducto=10');
    assert.strictEqual(f.status, 502);
    assert.strictEqual(f.body.error, 'No se pudieron leer los movimientos de SIGA');
  } finally { a.cerrar(); }
});

test('POST/DELETE oferta: asigna, idempotente, ajeno 400, otro registro 409, otra sucursal 403, historial', async () => {
  const a = armar({ filas: [FILA_OF(9, '2026-11-10', 4)] });
  try {
    const { body: l1 } = await a.pedir('ana', 'POST', '/api/vencimientos/lotes', ALTA);
    const { body: l2 } = await a.pedir('ana', 'POST', '/api/vencimientos/lotes', { ...ALTA, vencimiento: '2031-01-01' });
    await a.pedir('beto', 'POST', '/api/vencimientos/lotes', ALTA);
    const u = id => `/api/vencimientos/lotes/${id}/oferta`;
    const ok = await a.pedir('ana', 'POST', u(l1.id), { numeroMovimiento: 9, confirmacion: 'ok' });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual({ ...ok.body.sucursales['1'].ofertasSistema[0], asignado: 'x' },{ numeroMovimiento: 9, fecha: '2026-11-10', cantidad: 4, asignado: 'x', usuario: 'ana' });
    assert.strictEqual((await a.pedir('ana', 'POST', u(l1.id), { numeroMovimiento: 9, confirmacion: 'ok' })).status, 200);
    assert.strictEqual((await a.pedir('ana', 'POST', u(l1.id), { numeroMovimiento: 99, confirmacion: 'ok' })).status, 400);
    assert.strictEqual((await a.pedir('ana', 'POST', u(l2.id), { numeroMovimiento: 9, confirmacion: 'ok' })).status, 409);
    assert.strictEqual((await a.pedir('ana', 'POST', u(l1.id), { numeroMovimiento: 9, idSucursal: 2, confirmacion: 'ok' })).status, 403);
    assert.strictEqual((await a.pedir('ana', 'DELETE', `${u(l1.id)}?idSucursal=2`)).status, 403);
    const h = await a.pedir('ana', 'GET', '/api/vencimientos/historial');
    assert.ok(h.body.movimientos.some(m => m.tipo === 'oferta-sistema' && m.numeroMovimiento === 9 && m.cantidad === 4));
    const d = await a.pedir('ana', 'DELETE', u(l1.id));
    assert.strictEqual(d.status, 200);
    assert.deepStrictEqual(d.body.sucursales['1'].ofertasSistema, []);
    assert.strictEqual((await a.pedir('ana', 'DELETE', u(l1.id))).status, 404);
    assert.strictEqual((await a.pedir('ana', 'POST', u(l2.id), { numeroMovimiento: 9, confirmacion: 'ok' })).status, 200);
    const l = await a.pedir('ana', 'GET', '/api/vencimientos/lotes');
    const fila = l.body.lotes.find(x => x.id === l2.id).sucursales['1'];
    assert.deepStrictEqual(fila.ofertasSistema.map(o => o.numeroMovimiento), [9]);
    assert.ok(!('ofertaSistema' in fila));
    assert.deepStrictEqual(l.body.lotes.find(x => x.id === l1.id).sucursales['1'].ofertasSistema, []);
    assert.strictEqual(fila.vencido, 0);
  } finally { a.cerrar(); }
});

test('POST/DELETE oferta: varios movimientos por registro y DELETE por numeroMovimiento', async () => {
  const a = armar({ filas: [FILA_OF(9, '2026-11-10', 4), FILA_OF(10, '2026-11-11', 2)] });
  try {
    const { body: l1 } = await a.pedir('ana', 'POST', '/api/vencimientos/lotes', ALTA);
    const { body: l2 } = await a.pedir('ana', 'POST', '/api/vencimientos/lotes', { ...ALTA, vencimiento: '2031-01-01' });
    const u = id => `/api/vencimientos/lotes/${id}/oferta`;
    assert.strictEqual((await a.pedir('ana', 'POST', u(l1.id), { numeroMovimiento: 9, confirmacion: 'ok' })).status, 200);
    const dos = await a.pedir('ana', 'POST', u(l1.id), { numeroMovimiento: 10, confirmacion: 'ok' });
    assert.deepStrictEqual(dos.body.sucursales['1'].ofertasSistema.map(o => o.numeroMovimiento), [9, 10]);
    assert.strictEqual((await a.pedir('ana', 'POST', u(l2.id), { numeroMovimiento: 10, confirmacion: 'ok' })).status, 409);
    assert.strictEqual((await a.pedir('ana', 'DELETE', `${u(l1.id)}?numeroMovimiento=abc`)).status, 400);
    assert.strictEqual((await a.pedir('ana', 'DELETE', `${u(l2.id)}?numeroMovimiento=10`)).status, 404);
    const d = await a.pedir('ana', 'DELETE', `${u(l1.id)}?numeroMovimiento=10`);
    assert.deepStrictEqual(d.body.sucursales['1'].ofertasSistema.map(o => o.numeroMovimiento), [9]);
    assert.strictEqual((await a.pedir('ana', 'POST', u(l2.id), { numeroMovimiento: 10, confirmacion: 'ok' })).status, 200);
    const mo = await a.pedir('ana', 'GET', '/api/vencimientos/movimientos-oferta?idProducto=10');
    const porNum = Object.fromEntries(mo.body.movimientos.map(m => [m.numeroMovimiento, m.asignadoA && m.asignadoA.idLote]));
    assert.deepStrictEqual(porNum, { 9: l1.id, 10: l2.id });
  } finally { a.cerrar(); }
});

test('movimiento vencido por ruta y PUT config diasMaxOferta', async () => {
  const a = armar();
  try {
    const { body: lote } = await a.pedir('ana', 'POST', '/api/vencimientos/lotes', { ...ALTA, unidades: 5 });
    const u = `/api/vencimientos/lotes/${lote.id}/movimientos`;
    await a.pedir('ana', 'POST', u, { tipo: 'vendido', cantidad: 2 });
    const v = await a.pedir('ana', 'POST', u, { tipo: 'vencido', cantidad: 3 });
    assert.strictEqual(v.status, 200);
    const l = await a.pedir('ana', 'GET', '/api/vencimientos/lotes');
    assert.deepStrictEqual([l.body.lotes[0].sucursales['1'].pendiente, l.body.lotes[0].sucursales['1'].estado], [0, 'cerrado']);
    assert.strictEqual((await a.pedir('ana', 'POST', u, { tipo: 'otro', cantidad: 1 })).status, 400);
    assert.strictEqual((await a.pedir('admin', 'PUT', '/api/vencimientos/config', { diasMaxOferta: 500 })).status, 400);
    assert.strictEqual((await a.pedir('admin', 'PUT', '/api/vencimientos/config', { diasMaxOferta: 10 })).body.diasMaxOferta, 10);
  } finally { a.cerrar(); }
});

test('POST oferta en lote: validación, falta confirmar, coincide => ok, PUT confirmacion, DELETE limpia', async () => {
  const a = armar({ filas: [FILA_OF(9, '2026-11-10', 4), FILA_OF(10, '2026-11-11', 16), FILA_OF(11, '2026-11-12', 3)] });
  try {
    const { body: l1 } = await a.pedir('ana', 'POST', '/api/vencimientos/lotes', ALTA); // 20 unidades
    const { body: l2 } = await a.pedir('ana', 'POST', '/api/vencimientos/lotes', { ...ALTA, vencimiento: '2031-01-01' });
    const u = id => `/api/vencimientos/lotes/${id}/oferta`;
    const fila = async id => (await a.pedir('ana', 'GET', '/api/vencimientos/lotes')).body.lotes.find(x => x.id === id).sucursales['1'];
    for (const body of [{}, { numerosMovimiento: [] }, { numerosMovimiento: 'x' }, { numerosMovimiento: [9, 'a'] }, { numerosMovimiento: [9, 9] }, { numerosMovimiento: [0] }])
      assert.strictEqual((await a.pedir('ana', 'POST', u(l1.id), body)).status, 400, JSON.stringify(body));
    assert.strictEqual((await a.pedir('ana', 'POST', u(l1.id), { numerosMovimiento: [9, 99], confirmacion: 'ok' })).status, 400);
    const falta = await a.pedir('ana', 'POST', u(l1.id), { numerosMovimiento: [9] });
    assert.strictEqual(falta.status, 400);
    assert.strictEqual(falta.body.error, 'Falta confirmar las cantidades');
    assert.deepStrictEqual((await fila(l1.id)).ofertasSistema, []);
    assert.strictEqual((await fila(l1.id)).ofertaEstado, null);
    const c = await a.pedir('ana', 'POST', u(l1.id), { numerosMovimiento: [9], confirmacion: 'corregir' });
    assert.strictEqual(c.status, 200);
    assert.strictEqual(c.body.sucursales['1'].ofertaEstado, 'corregir');
    assert.ok(!('ofertaDecision' in c.body.sucursales['1']));
    assert.strictEqual((await fila(l1.id)).ofertaEstado, 'corregir');
    // PUT confirmacion
    const pc = id => `/api/vencimientos/lotes/${id}/oferta/confirmacion`;
    assert.strictEqual((await a.pedir('ana', 'PUT', pc(l1.id), { confirmacion: 'x' })).status, 400);
    assert.strictEqual((await a.pedir('ana', 'PUT', pc(l2.id), { confirmacion: 'ok' })).status, 400);
    assert.strictEqual((await a.pedir('ana', 'PUT', pc(l1.id), { confirmacion: 'ok', idSucursal: 2 })).status, 403);
    const p = await a.pedir('ana', 'PUT', pc(l1.id), { confirmacion: 'ok' });
    assert.strictEqual(p.status, 200);
    assert.strictEqual(p.body.sucursales['1'].ofertaEstado, 'ok');
    assert.ok(!('ofertaDecision' in p.body.sucursales['1']));
    const h = await a.pedir('ana', 'GET', '/api/vencimientos/historial');
    assert.ok(h.body.movimientos.some(m => m.tipo === 'oferta-confirmacion' && m.estado === 'ok' && m.cantidadSistema === 4 && m.unidades === 20));
    // 409 de uno aborta todo
    assert.strictEqual((await a.pedir('ana', 'POST', u(l2.id), { numerosMovimiento: [11, 9], confirmacion: 'ok' })).status, 409);
    assert.deepStrictEqual((await fila(l2.id)).ofertasSistema, []);
    // mezcla con ya asignado, suma 20 = unidades => ok derivado
    const ok = await a.pedir('ana', 'POST', u(l1.id), { numerosMovimiento: [9, 10] });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ok.body.sucursales['1'].ofertasSistema.map(o => o.numeroMovimiento), [9, 10]);
    assert.strictEqual(ok.body.sucursales['1'].ofertaEstado, 'ok');
    assert.strictEqual((await a.pedir('ana', 'PUT', pc(l1.id), { confirmacion: 'corregir' })).status, 400, 'coinciden');
    // DELETE limpia la decisión
    const d = await a.pedir('ana', 'DELETE', `${u(l1.id)}?numeroMovimiento=10`);
    assert.strictEqual(d.status, 200);
    assert.strictEqual(d.body.sucursales['1'].ofertaEstado, null);
    assert.ok(!('ofertaDecision' in d.body.sucursales['1']));
  } finally { a.cerrar(); }
});

const FILA_VE = (n, fecha, cant, entra = cant) => ({ NumeroMovimiento: n, Fecha: new Date(`${fecha}T00:00:00Z`), Tipo: 'OFERTA  VENCIDO', Cantidad: 0, Entra: entra, Sale: cant });

test('vencido: GET movimientos, POST sin oferta 400, confirmación, PUT, DELETE, lotes, historial, config', async () => {
  const a = armar({ filas: [FILA_OF(9, '2026-11-10', 4), FILA_VE(70, '2026-11-12', 1), { ...FILA_VE(71, '2026-11-13', 9), Tipo: 'VENCIDO' }, FILA_VE(72, '2026-11-11', 2, 5)] });
  try {
    const { body: l1 } = await a.pedir('ana', 'POST', '/api/vencimientos/lotes', ALTA);
    const u = id => `/api/vencimientos/lotes/${id}/vencido`;
    const g = await a.pedir('ana', 'GET', '/api/vencimientos/movimientos-vencido?idProducto=10');
    assert.strictEqual(g.status, 200);
    assert.deepStrictEqual([g.body.idSucursal, g.body.diasMax], [1, 10]);
    assert.deepStrictEqual(g.body.movimientos.map(m => [m.numeroMovimiento, m.cantidad, m.entra, m.asimetrico, m.asignadoA]), [[70, 1, 1, false, null], [72, 2, 5, true, null]], 'solo OFERTA VENCIDO');
    assert.match(a.sql.query, /AS Entra/);
    assert.strictEqual(a.sql.inputs.tipoMovimientoSql, 'OFERTAVENCIDO');
    assert.ok(Object.keys(a.sql.inputs).every(k => !/^p\d+$/.test(k)));
    assert.match(a.sql.query, /ABS\(SUM\(mp\.Cantidad\)\)/);
    assert.doesNotMatch(a.sql.query, /OFERTA ?VENCIDO/);
    // Sin oferta: la base son las unidades cargadas.
    const sinConf = await a.pedir('ana', 'POST', u(l1.id), { numerosMovimiento: [70] });
    assert.deepStrictEqual([sinConf.status, sinConf.body.error], [400, 'Falta confirmar las cantidades']);
    const sinOf = await a.pedir('ana', 'POST', u(l1.id), { numerosMovimiento: [70], confirmacion: 'ok' });
    const colSinOf = sinOf.body.sucursales['1'];
    assert.deepStrictEqual([sinOf.status, colSinOf.vencidoEstado, colSinOf.vencidoBase], [200, 'ok', colSinOf.unidades]);
    const dSinOf = await a.pedir('ana', 'DELETE', u(l1.id));
    assert.deepStrictEqual([dSinOf.status, dSinOf.body.sucursales['1'].vencidoBase], [200, colSinOf.unidades]);
    assert.strictEqual((await a.pedir('ana', 'POST', `/api/vencimientos/lotes/${l1.id}/oferta`, { numerosMovimiento: [9], confirmacion: 'ok' })).status, 200);
    assert.strictEqual((await a.pedir('ana', 'POST', u(l1.id), { numerosMovimiento: [70] })).status, 400, 'falta confirmar');
    assert.strictEqual((await a.pedir('ana', 'POST', u(l1.id), { numerosMovimiento: [71], confirmacion: 'ok' })).status, 400, 'no es OFERTA VENCIDO');
    assert.strictEqual((await a.pedir('ana', 'POST', u(l1.id), { numerosMovimiento: [70], idSucursal: 2, confirmacion: 'ok' })).status, 403);
    const p = await a.pedir('ana', 'POST', u(l1.id), { numerosMovimiento: [70], confirmacion: 'ok' });
    assert.strictEqual(p.status, 200);
    const col = p.body.sucursales['1'];
    assert.deepStrictEqual([col.vencidosSistema.map(v => v.numeroMovimiento), col.vencidoEstado, 'vencidoDecision' in col, col.vencidoBase], [[70], 'ok', false, 4]);
    const g2 = await a.pedir('ana', 'GET', '/api/vencimientos/movimientos-vencido?idProducto=10');
    assert.deepStrictEqual(g2.body.movimientos[0].asignadoA, { idLote: l1.id, idSucursal: 1 });
    const c = await a.pedir('ana', 'PUT', `${u(l1.id)}/confirmacion`, { confirmacion: 'corregir' });
    assert.deepStrictEqual([c.body.sucursales['1'].vencidoEstado, c.body.sucursales['1'].vencidoBase], ['corregir', 4]);
    const l = await a.pedir('ana', 'GET', '/api/vencimientos/lotes');
    const fila = l.body.lotes.find(x => x.id === l1.id).sucursales['1'];
    assert.deepStrictEqual([fila.vencidoEstado, fila.pendiente, fila.vencidosSistema.length, fila.vencidoBase], ['corregir', 19, 1, 4]);
    const h = await a.pedir('ana', 'GET', '/api/vencimientos/historial');
    assert.ok(h.body.movimientos.some(m => m.tipo === 'vencido-confirmacion' && m.estado === 'corregir' && m.cantidadSistema === 1 && m.base === 4));
    const d = await a.pedir('ana', 'DELETE', `${u(l1.id)}?numeroMovimiento=70`);
    assert.deepStrictEqual([d.status, d.body.sucursales['1'].vencidosSistema, d.body.sucursales['1'].vencidoEstado], [200, [], null]);
    assert.strictEqual((await a.pedir('ana', 'DELETE', u(l1.id))).status, 404);
    assert.strictEqual((await a.pedir('ana', 'PUT', '/api/vencimientos/config', { diasMaxVencido: 20 })).status, 403);
    assert.strictEqual((await a.pedir('admin', 'PUT', '/api/vencimientos/config', { diasMaxVencido: 0 })).status, 400);
    const cf = await a.pedir('admin', 'PUT', '/api/vencimientos/config', { diasMaxVencido: 20, tipoOfertaVencida: 'OFERTA VENCIDO' });
    assert.deepStrictEqual([cf.body.diasMaxVencido, cf.body.tipoOfertaVencida], [20, 'OFERTA VENCIDO']);
    assert.strictEqual((await a.pedir('admin', 'PUT', '/api/vencimientos/config', { diasAntesVencimientoOferta: 61 })).status, 400);
    const cd = await a.pedir('admin', 'PUT', '/api/vencimientos/config', { diasAntesVencimientoOferta: 5 });
    assert.deepStrictEqual([cd.body.diasAntesVencimientoOferta, cd.body.diasMaxVencido], [5, 20]);
  } finally { a.cerrar(); }
});

test('movimientos-vencido: 502 si SIGA falla', async () => {
  const a = armar({ falla: true });
  try {
    assert.strictEqual((await a.pedir('ana', 'GET', '/api/vencimientos/movimientos-vencido?idProducto=10')).status, 502);
  } finally { a.cerrar(); }
});

test('DELETE registro: permisos, 400/404, lote sigue o se borra, movimientos liberados, recarga', async () => {
  const a = armar({ filas: [FILA_OF(9, '2026-11-10', 4)] });
  try {
    const { body: l1 } = await a.pedir('ana', 'POST', '/api/vencimientos/lotes', ALTA);
    const { body: l2 } = await a.pedir('ana', 'POST', '/api/vencimientos/lotes', { ...ALTA, vencimiento: '2031-01-01' });
    await a.pedir('beto', 'POST', '/api/vencimientos/lotes', ALTA);
    const of = id => `/api/vencimientos/lotes/${id}/oferta`;
    const reg = id => `/api/vencimientos/lotes/${id}/registro`;
    assert.strictEqual((await a.pedir('ana', 'POST', of(l1.id), { numeroMovimiento: 9, confirmacion: 'ok' })).status, 200);
    assert.strictEqual((await a.pedir('ana', 'POST', of(l2.id), { numeroMovimiento: 9, confirmacion: 'ok' })).status, 409);
    assert.strictEqual((await a.pedir('ana', 'DELETE', `${reg(l1.id)}?idSucursal=2`)).status, 403);
    assert.strictEqual((await a.pedir('sin', 'DELETE', reg(l1.id))).status, 400);
    assert.strictEqual((await a.pedir('admin', 'DELETE', reg(l1.id))).status, 400);
    assert.strictEqual((await a.pedir('admin', 'DELETE', `${reg(l1.id)}?idSucursal=abc`)).status, 400);
    assert.strictEqual((await a.pedir('ana', 'DELETE', reg('00000000-0000-0000-0000-000000000000'))).status, 404);
    assert.strictEqual((await a.pedir('admin', 'DELETE', `${reg(l1.id)}?idSucursal=3`)).status, 404);
    // ana borra su registro: el lote sigue por beto
    const d = await a.pedir('ana', 'DELETE', reg(l1.id));
    assert.deepStrictEqual(d.body, { ok: true, idSucursal: 1, loteEliminado: false });
    let lotes = (await a.pedir('ana', 'GET', '/api/vencimientos/lotes')).body.lotes;
    assert.deepStrictEqual(Object.keys(lotes.find(x => x.id === l1.id).sucursales), ['2']);
    assert.ok(lotes.find(x => x.id === l2.id), 'no toca otros lotes');
    const mo = await a.pedir('ana', 'GET', '/api/vencimientos/movimientos-oferta?idProducto=10');
    assert.strictEqual(mo.body.movimientos.find(m => m.numeroMovimiento === 9).asignadoA, null);
    assert.strictEqual((await a.pedir('ana', 'POST', of(l2.id), { numeroMovimiento: 9, confirmacion: 'ok' })).status, 200);
    // admin borra el de beto: era la única sucursal → lote eliminado y se puede recargar
    const d2 = await a.pedir('admin', 'DELETE', `${reg(l1.id)}?idSucursal=2`);
    assert.deepStrictEqual(d2.body, { ok: true, idSucursal: 2, loteEliminado: true });
    lotes = (await a.pedir('ana', 'GET', '/api/vencimientos/lotes')).body.lotes;
    assert.deepStrictEqual(lotes.map(x => x.id), [l2.id]);
    const re = await a.pedir('ana', 'POST', '/api/vencimientos/lotes', ALTA);
    assert.strictEqual(re.status, 200);
    assert.notStrictEqual(re.body.id, l1.id);
    // DELETE admin existente intacto
    assert.strictEqual((await a.pedir('ana', 'DELETE', `/api/vencimientos/lotes/${l2.id}`)).status, 403);
    assert.strictEqual((await a.pedir('admin', 'DELETE', `/api/vencimientos/lotes/${l2.id}`)).status, 200);
  } finally { a.cerrar(); }
});

// --- Movimientos sin lote ---------------------------------------------------
const filaSiga = (n, tipo, idProducto, extra = {}) => ({ NumeroMovimiento: n, Fecha: `2030-01-0${n % 9 + 1}`, Tipo: tipo, Cantidad: 4, Sale: 4, Entra: 4,
  IdProducto: String(idProducto), NombreProducto: `Prod ${idProducto}`, CodigoDeBarras: `c${idProducto}`, ...extra });

test('sin-lote: sucursal propia/admin, 400, parámetros, exclusiones, orden y 502', async () => {
  const filas = [filaSiga(1, 'PARA OFERTA', 10), filaSiga(2, 'PARA OFERTA', 11), filaSiga(3, 'OFERTA VENCIDO', 12), filaSiga(4, 'PARA OFERTA', 13), filaSiga(5, 'PARA OFERTA', 14)];
  const a = armar({ filas });
  try {
    // 11: registro activo -> fuera. 12: registro cerrado (vendido todo) -> sigue. 13: alta desde mov 4 -> activo y asignado -> fuera.
    await a.pedir('ana', 'POST', '/api/vencimientos/lotes', { idProducto: 11, vencimiento: '2030-12-31', unidades: 3 });
    const { body: c } = await a.pedir('ana', 'POST', '/api/vencimientos/lotes', { idProducto: 12, vencimiento: '2030-12-31', unidades: 2 });
    await a.pedir('ana', 'POST', `/api/vencimientos/lotes/${c.id}/movimientos`, { tipo: 'vendido', cantidad: 2 });
    assert.strictEqual((await a.pedir('ana', 'POST', '/api/vencimientos/sin-lote/alta', { clase: 'oferta', numeroMovimiento: 4, idProducto: 13, vencimiento: '2031-01-01', unidades: 4 })).status, 200);
    const r = await a.pedir('ana', 'GET', '/api/vencimientos/sin-lote?idSucursal=2');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.idSucursal, 1, 'no admin ignora idSucursal');
    assert.deepStrictEqual([r.body.diasMaxOferta, r.body.diasMaxVencido], [10, 10]);
    assert.deepStrictEqual(r.body.movimientos.map(m => [m.clase, m.numeroMovimiento]), [['oferta', 5], ['vencido', 3], ['oferta', 1]]);
    assert.deepStrictEqual(r.body.movimientos[2], { clase: 'oferta', numeroMovimiento: 1, fecha: '2030-01-02', idProducto: 10, nombre: 'Prod 10', codigo: 'c10', cantidad: 4, entra: 0, asimetrico: false });
    assert.deepStrictEqual([a.sql.inputs.rubro0, a.sql.inputs.rubro1, a.sql.inputs.sucursal], ['Almacen', 'Pesables Fraccionado', 1]);
    assert.ok(Object.keys(a.sql.inputs).every(k => !/^p\d+$/.test(k)));
    assert.strictEqual((await a.pedir('admin', 'GET', '/api/vencimientos/sin-lote?idSucursal=2')).body.idSucursal, 2);
    assert.strictEqual((await a.pedir('sin', 'GET', '/api/vencimientos/sin-lote')).status, 400);
    assert.strictEqual((await a.pedir('ficticia', 'GET', '/api/vencimientos/sin-lote')).status, 400);
    assert.strictEqual((await a.pedir('admin', 'GET', '/api/vencimientos/sin-lote?idSucursal=11')).status, 400);
  } finally { a.cerrar(); }
  const f = armar({ falla: true });
  try {
    const r = await f.pedir('ana', 'GET', '/api/vencimientos/sin-lote');
    assert.deepStrictEqual([r.status, r.body.error], [502, 'No se pudieron leer los movimientos de SIGA']);
  } finally { f.cerrar(); }
});

test('sin-lote/alta oferta: unidades = cantidad, ok sin confirmar, origenSistema, historial, activo', async () => {
  const a = armar({ filas: [filaSiga(7, 'PARA OFERTA', 10)] });
  try {
    const r = await a.pedir('ana', 'POST', '/api/vencimientos/sin-lote/alta', { clase: 'oferta', numeroMovimiento: 7, idProducto: 10, vencimiento: '2020-01-01', unidades: 4 });
    assert.strictEqual(r.status, 200);
    const col = r.body.sucursales['1'];
    assert.deepStrictEqual([r.body.nombre, r.body.codigo, col.unidades, col.ofertaEstado, col.origenSistema], ['Prod 10', 'c10', 4, 'ok', true]);
    assert.deepStrictEqual(col.ofertasSistema.map(o => [o.numeroMovimiento, o.cantidad, o.usuario]), [[7, 4, 'ana']]);
    assert.deepStrictEqual(col.movimientos.map(m => [m.tipo, m.unidades ?? m.cantidad]), [['alta', 4], ['oferta-sistema', 4]]);
    const l = await a.pedir('ana', 'GET', '/api/vencimientos/lotes');
    assert.deepStrictEqual([l.body.lotes[0].sucursales['1'].estado, l.body.lotes[0].sucursales['1'].origenSistema], ['cargado', true]);
    const dup = await a.pedir('ana', 'POST', '/api/vencimientos/sin-lote/alta', { clase: 'oferta', numeroMovimiento: 7, idProducto: 10, vencimiento: '2021-01-01', unidades: 4 });
    assert.strictEqual(dup.status, 409, 'ya asignado');
  } finally { a.cerrar(); }
});

test('sin-lote/alta vencido: queda cerrado; registros normales con origenSistema false', async () => {
  const a = armar({ filas: [filaSiga(8, 'OFERTA VENCIDO', 10, { Sale: 3, Entra: 3 })] });
  try {
    await a.pedir('ana', 'POST', '/api/vencimientos/lotes', { idProducto: 20, vencimiento: '2030-12-31', unidades: 3 });
    const r = await a.pedir('ana', 'POST', '/api/vencimientos/sin-lote/alta', { clase: 'vencido', numeroMovimiento: 8, idProducto: 10, vencimiento: '2020-01-01', unidades: 4 });
    assert.strictEqual(r.status, 200);
    const col = r.body.sucursales['1'];
    assert.deepStrictEqual([col.unidades, col.vencidoEstado, col.vencidosSistema.length], [3, 'ok', 1]);
    assert.deepStrictEqual(col.movimientos.map(m => m.tipo), ['alta', 'vencido-sistema']);
    const l = await a.pedir('ana', 'GET', '/api/vencimientos/lotes');
    const reg = l.body.lotes.find(x => x.idProducto === 10).sucursales['1'];
    assert.deepStrictEqual([reg.pendiente, reg.estado], [0, 'cerrado']);
    assert.strictEqual(l.body.lotes.find(x => x.idProducto === 20).sucursales['1'].origenSistema, false);
  } finally { a.cerrar(); }
});

test('sin-lote/alta: 400 no está en SIGA/fecha/clase, 403, 409 duplicado, columna en lote ajeno, atomicidad', async () => {
  const a = armar({ filas: [filaSiga(7, 'PARA OFERTA', 10), filaSiga(9, 'PARA OFERTA', 10)] });
  const alta = (u, b) => a.pedir(u, 'POST', '/api/vencimientos/sin-lote/alta', { clase: 'oferta', numeroMovimiento: 7, idProducto: 10, vencimiento: '2030-12-31', unidades: 4, ...b });
  try {
    assert.strictEqual((await alta('ana', { numeroMovimiento: 99 })).status, 400);
    assert.strictEqual((await alta('ana', { vencimiento: '2030-02-30' })).status, 400);
    assert.strictEqual((await alta('ana', { clase: 'otra' })).status, 400);
    assert.strictEqual((await alta('ana', { idSucursal: 2 })).status, 403);
    assert.strictEqual((await alta('sin', {})).status, 400);
    await a.pedir('beto', 'POST', '/api/vencimientos/lotes', { idProducto: 10, vencimiento: '2030-12-31', unidades: 5 });
    const r = await alta('ana', {});
    assert.deepStrictEqual(Object.keys(r.body.sucursales).sort(), ['1', '2']);
    const dup = await alta('ana', { numeroMovimiento: 9 });
    assert.deepStrictEqual([dup.status, dup.body.error], [409, 'Ya hay un registro de este producto con ese vencimiento en tu sucursal']);
    const ad = await alta('admin', { idSucursal: 3, numeroMovimiento: 9 });
    assert.deepStrictEqual(Object.keys(ad.body.sucursales).sort(), ['1', '2', '3']);
  } finally { a.cerrar(); }
  // Vencido con cantidad no entera -> 400 y no queda lote. Oferta con la misma cantidad y unidades entero -> OK.
  const b = armar({ filas: [filaSiga(5, 'OFERTA VENCIDO', 10, { Cantidad: 1.5, Sale: 1.5, Entra: 1.5 }), filaSiga(6, 'PARA OFERTA', 10, { Cantidad: 1.5, Sale: 1.5, Entra: 1.5 })] });
  try {
    const f = await b.pedir('ana', 'POST', '/api/vencimientos/sin-lote/alta', { clase: 'vencido', numeroMovimiento: 5, idProducto: 10 });
    assert.deepStrictEqual([f.status, f.body.error], [400, 'La cantidad del movimiento no es un número entero']);
    assert.strictEqual((await b.pedir('ana', 'GET', '/api/vencimientos/lotes')).body.lotes.length, 0);
    const o = await b.pedir('ana', 'POST', '/api/vencimientos/sin-lote/alta', { clase: 'oferta', numeroMovimiento: 6, idProducto: 10, vencimiento: '2030-12-31', unidades: 2 });
    assert.deepStrictEqual([o.status, o.body.sucursales['1'].unidades, o.body.sucursales['1'].ofertaEstado], [200, 2, null]);
  } finally { b.cerrar(); }
});

test('sin-lote/alta oferta: unidades declaradas, sin confirmar si no suman, después confirmación normal', async () => {
  const a = armar({ filas: [filaSiga(7, 'PARA OFERTA', 10), filaSiga(9, 'PARA OFERTA', 11)] });
  const alta = b => a.pedir('ana', 'POST', '/api/vencimientos/sin-lote/alta', { clase: 'oferta', numeroMovimiento: 7, idProducto: 10, vencimiento: '2030-12-31', ...b });
  try {
    for (const unidades of [undefined, 0, 1.5, 'abc', -2, '1.5']) assert.strictEqual((await alta({ unidades })).status, 400, `unidades ${unidades}`);
    assert.strictEqual((await alta({ unidades: 4, vencimiento: undefined })).status, 400, 'sin vencimiento');
    assert.strictEqual((await a.pedir('ana', 'GET', '/api/vencimientos/lotes')).body.lotes.length, 0, 'nada guardado');
    const r = await alta({ unidades: 6 });
    assert.strictEqual(r.status, 200);
    const col = r.body.sucursales['1'];
    assert.deepStrictEqual([col.unidades, col.ofertaEstado, col.ofertasSistema.length], [6, null, 1]);
    assert.deepStrictEqual(col.movimientos.map(m => [m.tipo, m.unidades ?? m.cantidad]), [['alta', 6], ['oferta-sistema', 4]]);
    const conf = c => a.pedir('ana', 'PUT', `/api/vencimientos/lotes/${r.body.id}/oferta/confirmacion`, { confirmacion: c });
    assert.strictEqual((await conf('corregir')).body.sucursales['1'].ofertaEstado, 'corregir');
    assert.strictEqual((await conf('ok')).body.sucursales['1'].ofertaEstado, 'ok');
    const igual = await a.pedir('ana', 'POST', '/api/vencimientos/sin-lote/alta', { clase: 'oferta', numeroMovimiento: 9, idProducto: 11, vencimiento: '2030-12-31', unidades: '4' });
    assert.deepStrictEqual([igual.status, igual.body.sucursales['1'].ofertaEstado], [200, 'ok']);
  } finally { a.cerrar(); }
});

test('sin-lote/alta vencido sin vencimiento ni unidades: vence = fecha del movimiento, cerrado; 409 duplicado', async () => {
  const a = armar({ filas: [filaSiga(8, 'OFERTA VENCIDO', 10), filaSiga(17, 'OFERTA VENCIDO', 10)] });
  try {
    const r = await a.pedir('ana', 'POST', '/api/vencimientos/sin-lote/alta', { clase: 'vencido', numeroMovimiento: 8, idProducto: 10 });
    assert.strictEqual(r.status, 200);
    const col = r.body.sucursales['1'];
    assert.deepStrictEqual([r.body.vencimiento, col.unidades, col.vencidoEstado, col.origenSistema], ['2030-01-09', 4, 'ok', true]);
    const reg = (await a.pedir('ana', 'GET', '/api/vencimientos/lotes')).body.lotes[0].sucursales['1'];
    assert.deepStrictEqual([reg.pendiente, reg.estado], [0, 'cerrado']);
    assert.deepStrictEqual(col.movimientos.map(m => m.tipo), ['alta', 'vencido-sistema']);
    // mov 17 tiene la misma fecha (17 % 9 + 1 = 9) -> mismo vencimiento -> 409
    const dup = await a.pedir('ana', 'POST', '/api/vencimientos/sin-lote/alta', { clase: 'vencido', numeroMovimiento: 17, idProducto: 10 });
    assert.deepStrictEqual([dup.status, dup.body.error], [409, 'Ya hay un registro de este producto con ese vencimiento en tu sucursal']);
  } finally { a.cerrar(); }
});

// --- Centro de control ------------------------------------------------------
// tienePermiso falso: admin o usuario con 'vencimientos-control' en permisos.
function armarControl({ filas = [], falla = false, sucursales } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venc-ctrl-'));
  const store = crearStore({ rutaDatos: path.join(dir, 'v.json'), rutaConfig: path.join(dir, 'c.json') });
  const cuenta = { queries: 0, sucursalesConsultadas: [] };
  const getPool = async () => ({ request() {
    const r = { input(k, v) { if (k === 'sucursal') cuenta.sucursalesConsultadas.push(v); return r; },
      async query() { cuenta.queries++; if (falla) throw new Error('SIGA caído'); return { recordset: filas }; } };
    return r;
  } });
  const app = express();
  app.use((req, _res, next) => { req.session = { user: USUARIOS[req.get('x-user')] }; next(); });
  const tienePermiso = (u, ref) => !!u && (u.esAdmin || (u.permisos || []).includes(ref));
  const sucursalesSiga = sucursales && (async () => { if (falla) throw new Error('SIGA caído'); return sucursales; });
  app.use(crearRutas({ store, getPool, idSucursalDe: u => u.idSucursal || null, tienePermiso, sucursalesSiga }));
  let server;
  const pedir = async (user, ruta) => {
    if (!server) server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const res = await fetch(`http://127.0.0.1:${server.address().port}${ruta}`, { headers: { 'x-user': user } });
    const txt = await res.text();
    let body = txt; try { body = JSON.parse(txt); } catch (_) { /* html/js */ }
    return { status: res.status, body, tipo: res.headers.get('content-type') || '' };
  };
  return { pedir, cuenta, cerrar: () => { if (server) { server.closeAllConnections(); server.close(); } } };
}
USUARIOS.ctrl = { id: 6, usuario: 'ctrl', esAdmin: false, idSucursal: 1, permisos: ['vencimientos-control'] };
const SUCS = [{ id: 1, nombre: 'Centro', activa: true }, { id: 2, nombre: 'Norte', activa: true }, { id: 3, nombre: 'Cerrada', activa: false },
  { id: 6, nombre: 'F6', activa: true }, { id: 8, nombre: 'F8', activa: true }, { id: 11, nombre: 'F11', activa: true }];
const RUTAS_CONTROL = ['/api/vencimientos/centro-control', '/vencimientos-control', '/js/vencimientos_control.js', '/js/vencimientos_control_mock.js'];

test('centro-control: 403 sin permiso en API, página, js y mock; 200 admin y con permiso', async () => {
  const a = armarControl({ sucursales: SUCS });
  try {
    for (const ruta of RUTAS_CONTROL) {
      assert.strictEqual((await a.pedir('ana', ruta)).status, 403, `ana ${ruta}`);
      assert.strictEqual((await a.pedir('nadie', ruta)).status, ruta.startsWith('/api') ? 401 : 403, `sin sesión ${ruta}`);
      for (const u of ['admin', 'ctrl']) assert.strictEqual((await a.pedir(u, ruta)).status, 200, `${u} ${ruta}`);
    }
    assert.match((await a.pedir('ctrl', '/vencimientos-control')).body, /vencimientos_control\.js/);
    assert.match((await a.pedir('ctrl', '/js/vencimientos_control_mock.js')).tipo, /javascript/);
    const r = await a.pedir('ctrl', '/api/vencimientos/centro-control');
    assert.strictEqual(r.body.sinLote.disponible, true);
    assert.strictEqual(r.body.kpis.sinLote, 0);
  } finally { a.cerrar(); }
});

test('centro-control: SIGA caído → 200, sinLote.disponible=false y kpis.sinLote=null', async () => {
  const a = armarControl({ falla: true, sucursales: SUCS });
  try {
    const r = await a.pedir('admin', '/api/vencimientos/centro-control');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.sinLote.disponible, false);
    assert.deepStrictEqual(r.body.sinLote.porSucursal, []);
    assert.strictEqual(r.body.kpis.sinLote, null);
  } finally { a.cerrar(); }
});

test('centro-control: el bloque sin lote se cachea 60 s y no reconsulta SIGA', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2030-01-15T12:00:00Z') });
  const a = armarControl({ filas: [filaSiga(1, 'PARA OFERTA', 10)], sucursales: SUCS });
  try {
    const r1 = await a.pedir('admin', '/api/vencimientos/centro-control');
    const n = a.cuenta.queries;
    assert.ok(n > 0);
    assert.strictEqual(r1.body.kpis.sinLote, 2, 'PARA OFERTA cuenta solo en clase oferta: 1 por sucursal');
    await a.pedir('admin', '/api/vencimientos/centro-control');
    t.mock.timers.tick(59 * 1000);
    await a.pedir('admin', '/api/vencimientos/centro-control');
    assert.strictEqual(a.cuenta.queries, n, 'dentro de 60 s no reconsulta');
    t.mock.timers.tick(2 * 1000);
    await a.pedir('admin', '/api/vencimientos/centro-control');
    assert.strictEqual(a.cuenta.queries, 2 * n, 'vencida la caché reconsulta');
  } finally { a.cerrar(); }
});

test('centro-control: sucursalesSiga filtra inactivas y 6/8/11; usa sus nombres', async () => {
  const a = armarControl({ sucursales: SUCS });
  try {
    const r = await a.pedir('admin', '/api/vencimientos/centro-control');
    assert.deepStrictEqual([...new Set(a.cuenta.sucursalesConsultadas)].sort(), [1, 2]);
    assert.deepStrictEqual(r.body.sinLote.porSucursal.map(s => [s.idSucursal, s.nombre]), [[1, 'Centro'], [2, 'Norte']]);
  } finally { a.cerrar(); }
});

// --- diasAntesVencimientoOferta: config y centro de control end-to-end ---
const masDias = (f, n) => new Date(Date.parse(`${f}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

test('config diasAntesVencimientoOferta: GET default 3, PUT valida 0..60 enteros y guardado parcial no pisa', async () => {
  const a = armar();
  try {
    assert.strictEqual((await a.pedir('ana', 'GET', '/api/vencimientos/config')).body.diasAntesVencimientoOferta, 3);
    for (const malo of [61, -1, 2.5, 'abc']) {
      const r = await a.pedir('admin', 'PUT', '/api/vencimientos/config', { diasAntesVencimientoOferta: malo });
      assert.strictEqual(r.status, 400, `valor ${malo}`);
    }
    assert.strictEqual((await a.pedir('ana', 'PUT', '/api/vencimientos/config', { diasAntesVencimientoOferta: 5 })).status, 403);
    await a.pedir('admin', 'PUT', '/api/vencimientos/config', { diasMaxOferta: 20, tipoOferta: 'OFERTA X' });
    const ok = await a.pedir('admin', 'PUT', '/api/vencimientos/config', { diasAntesVencimientoOferta: 0 });
    assert.strictEqual(ok.status, 200);
    const g = (await a.pedir('ana', 'GET', '/api/vencimientos/config')).body;
    assert.deepStrictEqual([g.diasAntesVencimientoOferta, g.diasMaxOferta, g.tipoOferta, g.umbrales], [0, 20, 'OFERTA X', { rojo: 15, amarillo: 45 }]);
    await a.pedir('admin', 'PUT', '/api/vencimientos/config', { diasMaxOferta: 30 });
    assert.strictEqual((await a.pedir('ana', 'GET', '/api/vencimientos/config')).body.diasAntesVencimientoOferta, 0, 'otro PUT no lo pisa');
    assert.strictEqual((await a.pedir('admin', 'PUT', '/api/vencimientos/config', { diasAntesVencimientoOferta: '60' })).body.diasAntesVencimientoOferta, 60);
  } finally { a.cerrar(); }
});

test('centro-control: reglaOferta.diasAntes sigue la config y enOferta.limite = vence - N', async () => {
  const fechaOf = masDias(HOY_LOCAL, -2);
  const vence = masDias(HOY_LOCAL, 10);
  const a = armar({ filas: [FILA_OF(9, fechaOf, 4)], tienePermiso: u => !!u && u.esAdmin });
  try {
    const { body: l } = await a.pedir('ana', 'POST', '/api/vencimientos/lotes', { ...ALTA, vencimiento: vence, unidades: 4 });
    assert.strictEqual((await a.pedir('ana', 'POST', `/api/vencimientos/lotes/${l.id}/oferta`, { numeroMovimiento: 9, confirmacion: 'ok' })).status, 200);
    let c = (await a.pedir('admin', 'GET', '/api/vencimientos/centro-control')).body;
    assert.deepStrictEqual(c.reglaOferta, { diasAntes: 3 });
    assert.strictEqual(c.enOferta[0].limite, masDias(vence, -3));
    assert.strictEqual((await a.pedir('admin', 'PUT', '/api/vencimientos/config', { diasAntesVencimientoOferta: 5 })).status, 200);
    c = (await a.pedir('admin', 'GET', '/api/vencimientos/centro-control')).body;
    assert.deepStrictEqual(c.reglaOferta, { diasAntes: 5 });
    const f = c.enOferta[0];
    assert.deepStrictEqual([f.vence, f.limite, f.diasParaLimite, f.fechaOferta, f.diasEnOferta, f.diasMaxOferta, f.estado],
      [vence, masDias(vence, -5), 5, fechaOf, 2, 7, 'en-plazo']);
    await a.pedir('admin', 'PUT', '/api/vencimientos/config', { diasAntesVencimientoOferta: 11 });
    const f2 = (await a.pedir('admin', 'GET', '/api/vencimientos/centro-control')).body.enOferta[0];
    assert.deepStrictEqual([f2.limite, f2.diasParaLimite, f2.estado], [masDias(vence, -11), -1, 'atrasada']);
    assert.strictEqual((await a.pedir('ana', 'GET', '/api/vencimientos/centro-control')).status, 403);
  } finally { a.cerrar(); }
});
