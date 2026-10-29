'use strict';
// Permiso fino Precios · Configuración (lib/precios_permisos + lib/auth tienePermiso).
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const permisos = require('../lib/precios_permisos');
const auth = require('../lib/auth');

// ── Lista explícita de rutas de configuración (método + path de Express) ─────────────────────────────
const RUTAS_CONFIG_ESPERADAS = [
  'get /api/precios/config/esquema',
  'put /api/precios/config/esquema/costos',
  'put /api/precios/config/esquema/precio',
  'put /api/precios/config/esquema/margenes',
  'put /api/precios/config/esquema/costo-hora',
  'post /api/precios/config/esquema/rango',
  'put /api/precios/config/esquema/margen-producto/:plu',
  'put /api/precios/produccion/productos/:id/margen-especial',
  'put /api/precios/costos-extra/:plu',
  'get /api/precios/config/esquema/fraccionado',
  'get /api/precios/config/esquema/fraccionado/costeo',
  'get /api/precios/config/esquema/fraccionado/historial',
  'put /api/precios/config/esquema/fraccionado/maquinas',
  'put /api/precios/config/esquema/fraccionado/tramos-tiempo',
  'put /api/precios/config/esquema/fraccionado/subrubros',
  'put /api/precios/config/esquema/fraccionado/granel/:plu',
  'put /api/precios/config/esquema/fraccionado/insumos-peso/:pesoG',
  'put /api/precios/config/esquema/fraccionado/ajustes-peso',
];

// Todas las rutas registradas por los routers de /precios (deps de prueba: sin SQL ni archivos).
function rutasDeLosRouters() {
  const deps = {
    apiRoute: fn => fn, query: async () => [], leerJSON: (_p, def) => def, guardarJSON: () => {},
    DATA_DIR: require('os').tmpdir(), LISTA_PRECIOS_VENTA: 0, FORMULA_ACTIVA_SQL: '1=1', SIN_FORMULA_GENERICO_SQL: '1=1', tiposPackaging: [],
  };
  const routers = ['rutas_precios', 'rutas_precios_produccion', 'rutas_precios_pack_bulto', 'rutas_precios_esquema', 'rutas_precios_fraccionado'].map(r => require(`../routes/${r}`)(deps));
  return routers.flatMap(r => r.stack.filter(l => l.route).flatMap(l =>
    Object.keys(l.route.methods).map(m => `${m} ${l.route.path}`)));
}
const concreta = ruta => ruta.replace(/:tipo/g, 'almacen').replace(/:[a-zA-Z]+/g, '123');

test('cada ruta de config de los routers de precios está protegida y ninguna otra', () => {
  const rutas = rutasDeLosRouters();
  for (const r of RUTAS_CONFIG_ESPERADAS) assert.ok(rutas.includes(r), `falta en los routers: ${r}`);
  for (const r of rutas) {
    const esperado = RUTAS_CONFIG_ESPERADAS.includes(r);
    assert.strictEqual(permisos.esRutaConfig(concreta(r.split(' ')[1])), esperado, `${r} → ${esperado ? 'config' : 'permitida'}`);
  }
  // Las de trabajo de precios siguen permitidas (lista no exhaustiva, las que pidió el usuario).
  for (const r of ['/api/precios/costo-producto/1', '/api/precios/config/publica',
    '/api/precios/produccion/productos', '/api/precios/esquema/listado', '/api/precios/esquema/detalle/1', '/api/precios/esquema/export',
    '/api/precios/decision/1', '/api/precios/decisiones', '/api/precios/pack-bulto/vinculos']) {
    assert.strictEqual(permisos.esRutaConfig(r), false, r);
  }
});

// ── Guard por HTTP ──────────────────────────────────────────────────────────────────────────────────
// Sesión simulada por header; tienePermiso de prueba: 'admin' y 'con' lo tienen, 'sin' no, sin header = sin sesión.
function appDePrueba() {
  const app = express();
  app.use((req, _res, next) => { const u = req.get('x-user'); req.session = u ? { user: { usuario: u } } : {}; next(); });
  app.use(permisos.crearGuardPrecios({ tienePermiso: (user, ref) => !!user && ref === 'precios-config' && ['admin', 'con'].includes(user.usuario) }));
  app.use((req, res) => res.json({ ok: true, sinConfig: req.preciosSinConfig, precioNeto: 100, gastosVenta: [1],
    filas: [{ plu: '1', margenes: {}, extrasMinorista: [], sugeridos: { sistema: { minorista: { precio: 1 } } } }] }));
  let server;
  const pedir = async (metodo, ruta, usuario) => {
    if (!server) server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const res = await fetch(`http://127.0.0.1:${server.address().port}${ruta}`,
      { method: metodo, headers: usuario ? { 'x-user': usuario, 'content-type': 'application/json' } : {}, body: metodo === 'GET' ? undefined : '{}' });
    return { status: res.status, body: await res.json() };
  };
  return { pedir, cerrar: () => server && server.close() };
}

test('guard: 403 en cada ruta de config sin permiso (y sin sesión); 200 con permiso o admin', async () => {
  const { pedir, cerrar } = appDePrueba();
  try {
    for (const r of RUTAS_CONFIG_ESPERADAS) {
      const [metodo, ruta] = r.split(' ');
      const url = concreta(ruta);
      assert.strictEqual((await pedir(metodo.toUpperCase(), url, 'sin')).status, 403, `sin permiso ${r}`);
      assert.strictEqual((await pedir(metodo.toUpperCase(), url)).status, 403, `sin sesión ${r}`);
      assert.strictEqual((await pedir(metodo.toUpperCase(), url, 'con')).status, 200, `con permiso ${r}`);
      assert.strictEqual((await pedir(metodo.toUpperCase(), url, 'admin')).status, 200, `admin ${r}`);
    }
    // Variantes de la URL que Express enruta igual: mayúsculas, barra final, %xx.
    for (const url of ['/API/Precios/Config', '/api/precios/config/', '/api/precios/%63onfig', '/api/precios/config/General',
      '/api/precios//config', '/api/precios/Config/Esquema/Costos']) {
      assert.strictEqual((await pedir('GET', url, 'sin')).status, 403, url);
    }
  } finally { cerrar(); }
});

test('guard: sin permiso las demás rutas de /api/precios responden sin las claves de estructura; con permiso, intactas', async () => {
  const { pedir, cerrar } = appDePrueba();
  try {
    const sin = await pedir('GET', '/api/precios/esquema/listado?tipo=almacen', 'sin');
    assert.strictEqual(sin.status, 200);
    assert.deepStrictEqual(sin.body, { ok: true, sinConfig: true, precioNeto: 100, filas: [{ plu: '1', sugeridos: { sistema: { minorista: { precio: 1 } } } }] });
    const con = await pedir('GET', '/api/precios/esquema/listado?tipo=almacen', 'con');
    assert.deepStrictEqual(con.body, { ok: true, sinConfig: false, precioNeto: 100, gastosVenta: [1],
      filas: [{ plu: '1', margenes: {}, extrasMinorista: [], sugeridos: { sistema: { minorista: { precio: 1 } } } }] });
    // El margen especial de un producto de Producción (definicion del detalle) tampoco sale sin el permiso.
    assert.deepStrictEqual(permisos.sinClavesOcultas({ definicion: { nombre: 'G', margenEspecial: { minorista: 5 } } }), { definicion: { nombre: 'G' } });
    // Ni el ajuste de margen de un producto (fila) ni su parte en el desglose.
    assert.deepStrictEqual(permisos.sinClavesOcultas({ filas: [{ plu: '1', margenProducto: { minorista: 5 }, minorista: { margenProductoPct: 5, margenProductoModo: 'fijo', margenGeneralPct: 30, precioFijo: 3999, descuentoDistribuidorPct: 5, precio: 1 } }] }),
      { filas: [{ plu: '1', minorista: { precio: 1 } }] });
    // Otros módulos no pasan por el guard.
    const prov = await pedir('GET', '/api/precios-proveedores/listado', 'sin');
    assert.deepStrictEqual(prov.body.gastosVenta, [1]);
    assert.strictEqual(prov.body.sinConfig, undefined);
  } finally { cerrar(); }
});

// ── Asignación por usuario (data/usuarios.json real, usuario descartable como test/auth.test.js) ─────────
test('admin asigna precios-config: se guarda en modulos y tienePermiso lo lee fresco; esAdmin siempre lo tiene', () => {
  assert.ok(auth.PERMISOS_EXTRA.some(p => p.ref === 'precios-config'));
  const uname = `tmp-permiso-${Date.now()}`;
  const u = auth.crearUsuario({ usuario: uname, password: 'secreta123', modulos: ['precios'] });
  try {
    assert.strictEqual(auth.tienePermiso(u, 'precios-config'), false);
    const conPermiso = auth.actualizarUsuario(u.id, { modulos: ['precios', 'precios-config', 'inventado'] });
    assert.deepStrictEqual(conPermiso.modulos, ['precios', 'precios-config']);
    assert.strictEqual(auth.tienePermiso(u, 'precios-config'), true); // sesión vieja, permiso nuevo: rige ya
    auth.actualizarUsuario(u.id, { activo: false });
    assert.strictEqual(auth.tienePermiso(u, 'precios-config'), false);
    auth.actualizarUsuario(u.id, { activo: true, modulos: ['precios'], esAdmin: true });
    assert.strictEqual(auth.tienePermiso(u, 'precios-config'), true);
    assert.strictEqual(auth.tienePermiso(null, 'precios-config'), false);
    assert.strictEqual(auth.tienePermiso(u, 'otro-permiso'), false);
  } finally {
    auth.actualizarUsuario(u.id, { esAdmin: false });
    auth.eliminarUsuario(u.id);
  }
});

test('CLAVES_OCULTAS: la configuración del costeo de Fraccionado no viaja sin el permiso; los avisos sí', () => {
  const fila = { plu: '1', avisosCosto: ['sinMinutos'], costeoGranel: { maquina: 'Envasadora' }, maquinas: [], tramosTiempo: [], porGranel: {},
    insumosPorPeso: { 500: [{ plu: '900', cantidad: 1 }] } };
  assert.deepStrictEqual(permisos.sinClavesOcultas(fila), { plu: '1', avisosCosto: ['sinMinutos'] });
});
