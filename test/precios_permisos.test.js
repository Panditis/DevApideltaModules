'use strict';
// Permiso fino Precios · Configuración (lib/precios_permisos + lib/auth tienePermiso).
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const permisos = require('../lib/precios_permisos');
const auth = require('../lib/auth');
const { calcularFilaAlmacen, armarGruposFraccionado } = require('../routes/rutas_precios');
const { costearTodos, normalizarDatos } = require('../routes/rutas_precios_produccion');

// ── Lista explícita de rutas de configuración (método + path de Express) ─────────────────────────────
const RUTAS_CONFIG_ESPERADAS = [
  'get /api/precios/config',
  'put /api/precios/config/ganancia',
  'put /api/precios/config/iva-venta',
  'put /api/precios/config/general',
  'put /api/precios/config/gastos-venta',
  'put /api/precios/config/departamentos',
  'put /api/precios/config/curva-ganancia/:tipo',
  'put /api/precios/config/pack-bulto',
  'post /api/precios/costos/venta-base/actualizar',
  'post /api/precios/curva-ganancia/ajustar/:tipo',
  'post /api/precios/curva-ganancia/ajustar/produccion',
  'post /api/precios/alinear-siga',
  'get /api/precios/margenes-propios',
  'post /api/precios/margenes-propios/previsualizar',
  'post /api/precios/margenes-propios/aplicar',
  'post /api/precios/pack-bulto/alinear-siga',
  'get /api/precios/produccion/categorias-maquina',
  'put /api/precios/produccion/categorias-maquina',
];

// Todas las rutas registradas por los routers de /precios (deps de prueba: sin SQL ni archivos).
function rutasDeLosRouters() {
  const deps = {
    apiRoute: fn => fn, query: async () => [], leerJSON: (_p, def) => def, guardarJSON: () => {},
    DATA_DIR: require('os').tmpdir(), LISTA_PRECIOS_VENTA: 0, FORMULA_ACTIVA_SQL: '1=1', SIN_FORMULA_GENERICO_SQL: '1=1', tiposPackaging: [],
  };
  const routers = ['rutas_precios', 'rutas_precios_produccion', 'rutas_precios_pack_bulto'].map(r => require(`../routes/${r}`)(deps));
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
  for (const r of ['/api/precios/listado', '/api/precios/detalle/1', '/api/precios/marcados', '/api/precios/margen-producto/1',
    '/api/precios/costo-producto/1', '/api/precios/costos-extra/1', '/api/precios/config/publica', '/api/precios/produccion/productos']) {
    assert.strictEqual(permisos.esRutaConfig(r), false, r);
  }
});

// ── Guard por HTTP ──────────────────────────────────────────────────────────────────────────────────
// Sesión simulada por header; tienePermiso de prueba: 'admin' y 'con' lo tienen, 'sin' no, sin header = sin sesión.
function appDePrueba() {
  const app = express();
  app.use((req, _res, next) => { const u = req.get('x-user'); req.session = u ? { user: { usuario: u } } : {}; next(); });
  app.use(permisos.crearGuardPrecios({ tienePermiso: (user, ref) => !!user && ref === 'precios-config' && ['admin', 'con'].includes(user.usuario) }));
  app.use((req, res) => res.json({ ok: true, sinConfig: req.preciosSinConfig, precioNeto: 100, costoReal: 80,
    filas: [{ plu: '1', gananciaPct: 25, gastosVentaPct: 20, desglose: { variables: 3, departamentos: 2, precioNeto: 100 } }] }));
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
      '/api/precios//config', '/api/precios/Margenes-Propios/aplicar']) {
      assert.strictEqual((await pedir('GET', url, 'sin')).status, 403, url);
    }
  } finally { cerrar(); }
});

test('guard: sin permiso las demás rutas de /api/precios responden sin las claves de estructura; con permiso, intactas', async () => {
  const { pedir, cerrar } = appDePrueba();
  try {
    const sin = await pedir('GET', '/api/precios/listado?tipo=almacen', 'sin');
    assert.strictEqual(sin.status, 200);
    assert.strictEqual(sin.body.sinConfig, true);
    assert.strictEqual('costoReal' in sin.body, false);
    assert.deepStrictEqual(sin.body.filas, [{ plu: '1', gananciaPct: 25, desglose: { precioNeto: 100 } }]);
    const con = await pedir('GET', '/api/precios/listado?tipo=almacen', 'con');
    assert.strictEqual(con.body.sinConfig, false);
    assert.strictEqual(con.body.costoReal, 80);
    assert.strictEqual(con.body.filas[0].desglose.variables, 3);
    // Otros módulos no pasan por el guard.
    const prov = await pedir('GET', '/api/precios-proveedores/listado', 'sin');
    assert.strictEqual(prov.body.costoReal, 80);
    assert.strictEqual(prov.body.sinConfig, undefined);
  } finally { cerrar(); }
});

// ── Vista sin estructura: mismos precios, "ganancia" = markup s/ costo neto ──────────────────────────
const curva = { a: 120, b: 12, pisoPct: 15, techoPct: 60 };
const preciosCosteo = require('../lib/precios_costeo');
const COSTEO = {
  toleranciaPct: 10, costoHora: 6000, metodoGanancia: 'curva', ivaVentaPct: 21,
  // Marcadores de las migraciones ya hechas: crear el router no reescribe nada.
  margenPropio: preciosCosteo.MARGEN_PROPIO_GANANCIA, precioFinalConceptos: preciosCosteo.PRECIO_FINAL_MIGRADO,
  baseCosto: preciosCosteo.BASE_COSTO_SIGA,
  gastosVenta: [{ id: 'tarj', concepto: 'Tarjetas', pct: 4, listas: ['sucursal'] }],
  departamentos: [{ id: 'adm', nombre: 'Administración', costoMensual: 1000000, imputacion: { almacen: 50, fraccionado: 30, produccion: 20 } }],
  ventaBase: { meses: 3, manual: { almacen: 20000000, fraccionado: 10000000, produccion: 5000000 }, produccionSinDepartamentos: false },
  conceptosGanancia: [{ id: 'reinv', concepto: 'Reinversión', pct: 3 }],
  conceptosPrecioFinal: [{ id: 'iibb', concepto: 'IIBB', pct: 3.5 }, { id: 'debcred', concepto: 'Déb/Créd', pct: 1.2 }],
  curvaGanancia: {
    almacen: curva, produccion: { a: 50, b: 0, pisoPct: 50, techoPct: 50 },
    fraccionado: { ...curva, ajustesPeso: { tramosG: [100, 500, 1000], puntos: [12, 5, 0] } },
  },
  margenPorProducto: { 2: 18, 11: 33 },
  presentacionesTemporales: { 4409: [{ id: 't-a', pesoG: 250, gananciaPct: 40 }, { id: 't-b', pesoG: 100 }] },
};
const cerca = (a, b, tol = 0.011) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

test('proyectarCosteo: Reventa da los mismos precios con gastos 0, sin conceptos y ganancia = markup', () => {
  const proy = permisos.proyectarCosteo(COSTEO, 'almacen');
  assert.deepStrictEqual(proy.gastosVenta, []);
  assert.deepStrictEqual(proy.departamentos, []);
  assert.deepStrictEqual(proy.conceptosGanancia, []);
  assert.strictEqual('ventaBase' in proy, false);
  assert.deepStrictEqual(proy.conceptosPrecioFinal, [{ id: 'impuestos-final', concepto: 'Impuestos s/ precio final', pct: 4.7 }]);
  for (const [plu, costo] of [['1', 300], ['2', 300], ['3', 4500], ['4', 90000], ['5', 12]]) {
    const real = calcularFilaAlmacen({ plu, nombre: 'x', costoSistema: costo, precioVigente: null, costeoConfig: COSTEO });
    const vista = calcularFilaAlmacen({ plu, nombre: 'x', costoSistema: costo, precioVigente: null, costeoConfig: proy });
    assert.ok(real.gastosVentaPct > 0 && real.gananciaPct !== real.markupPct, 'el caso tiene estructura');
    assert.strictEqual(vista.precioConIva, real.precioConIva, `precio ${plu}`);
    cerca(vista.precioNeto, real.precioNeto);
    cerca(vista.markupPct, real.markupPct, 1e-4);
    cerca(vista.gananciaPct, vista.markupPct, 1e-4); // ganancia de la vista = markup s/ neto
    assert.strictEqual(vista.costoReal, vista.costoTotal);
    assert.strictEqual(vista.gastosVentaPct, 0);
  }
});

test('proyectarCosteo: Fraccionado (curva con ajuste por peso, propios y temporales) y Producción dan los mismos precios', () => {
  const graneles = [{ plu: '4409', nombre: 'Sem. Lino Granel' }];
  const presentaciones = [{ plu: '11', nombre: 'Sem. Lino 500G' }, { plu: '12', nombre: 'Sem. Lino 1Kg' }, { plu: '13', nombre: 'Sem. Lino 100G' }];
  const formulas = { 11: { granel: 4409 }, 12: { granel: 4409 }, 13: { granel: 4409 } };
  const costos = new Map([['4409', { nombre: 'Sem. Lino Granel', costoMercaderia: 2500, costoSistema: 2297 }]]);
  const armar = cfg => armarGruposFraccionado({ graneles, presentaciones, formulas, costos, vigentes: new Map(), costeoConfig: cfg })[0];
  const real = armar(COSTEO), vista = armar(permisos.proyectarCosteo(COSTEO, 'fraccionado'));
  for (const [i, p] of real.presentaciones.entries()) {
    assert.ok(p.precioConIva > 0, p.nombre);
    assert.strictEqual(vista.presentaciones[i].precioConIva, p.precioConIva, p.nombre);
    cerca(vista.presentaciones[i].markupPct, p.markupPct, 1e-4);
  }
  assert.strictEqual(real.temporales.length, 2);
  for (const [i, t] of real.temporales.entries()) assert.strictEqual(vista.temporales[i].precioConIva, t.precioConIva, t.id);

  const datos = normalizarDatos({ productos: { 'p-a': { nombre: 'A',
    recetas: { base: { nombre: 'Base', rendimientoKg: 10, materiasPrimas: [{ plu: '300', cantidad: 5, unidad: 'kg' }] } },
    insumos: [{ plu: '6334' }],
    presentaciones: { 7777: { recetaId: 'base', kgPorUnidad: 0.5, insumos: [{ plu: '6334', cantidad: 1 }] } } } } });
  const cp = new Map([['300', { plu: '300', nombre: 'Harina', costoSistema: 400, costoMercaderia: null }],
    ['6334', { plu: '6334', nombre: 'Envase', costoSistema: 180, costoMercaderia: null }]]);
  const prod = cfg => costearTodos({ productos: datos.productos, costos: cp, costeo: cfg, datos })['p-a'].presentaciones['7777'];
  assert.ok(prod(COSTEO).precioConIva > 0);
  assert.strictEqual(prod(permisos.proyectarCosteo(COSTEO, 'produccion')).precioConIva, prod(COSTEO).precioConIva);
});

test('proyectarCosteo: sin venta base del tipo (gastos desconocidos) no inventa precio', () => {
  const sinVenta = { ...COSTEO, ventaBase: { meses: 3, manual: {} } };
  const real = calcularFilaAlmacen({ plu: '2', nombre: 'x', costoSistema: 300, precioVigente: null, costeoConfig: sinVenta });
  const vista = calcularFilaAlmacen({ plu: '2', nombre: 'x', costoSistema: 300, precioVigente: null, costeoConfig: permisos.proyectarCosteo(sinVenta, 'almacen') });
  assert.strictEqual(real.precioConIva, null);
  assert.strictEqual(vista.precioConIva, null);
});

test('configPublicaSinEstructura: sólo gastos 0, curva de markup e impuestos s/ final agregados', () => {
  const c = permisos.sinClavesOcultas(permisos.configPublicaSinEstructura(COSTEO));
  assert.deepStrictEqual(Object.keys(c).sort(), ['conceptosPrecioFinal', 'curvaMarkup', 'gastosVentaPctPorTipo']);
  assert.deepStrictEqual(c.gastosVentaPctPorTipo, { almacen: 0, fraccionado: 0, produccion: 0 });
  assert.deepStrictEqual(c.conceptosPrecioFinal, [{ id: 'impuestos-final', concepto: 'Impuestos s/ precio final', pct: 4.7 }]);
  // La curva de markup no es la de ganancia: a y b cambian (b escala por 1 / (1 − G)).
  assert.notStrictEqual(c.curvaMarkup.almacen.a, curva.a);
  assert.ok(c.curvaMarkup.almacen.b > curva.b);
});

test('gananciaDesdeMarkupTipo: el markup que manda el usuario sin permiso se guarda como ganancia del tipo', () => {
  const proy = permisos.proyectarCosteo({ ...COSTEO, margenPorProducto: {} }, 'almacen');
  const g = permisos.gananciaDesdeMarkupTipo(COSTEO, 'almacen', 50);
  const conGanancia = { ...COSTEO, margenPorProducto: { 9: g } };
  const fila = calcularFilaAlmacen({ plu: '9', nombre: 'x', costoSistema: 1000, precioVigente: null, costeoConfig: conGanancia });
  cerca(fila.markupPct, 50, 1e-4);
  assert.ok(g < 50); // ganancia s/ costo real < markup s/ neto con gastos
  assert.deepStrictEqual(proy.margenPorProducto, {});
  assert.throws(() => permisos.gananciaDesdeMarkupTipo({ ...COSTEO, ventaBase: { manual: {} } }, 'almacen', 50), /venta base/);
});

// ── Endpoints de rutas_precios con un usuario sin permiso ───────────────────────────────────────────
function routerPrecios(archivo) {
  const estado = { archivo };
  const router = require('../routes/rutas_precios')({
    apiRoute: fn => async (req, res) => res.json(await fn(req)),
    query: async () => [{ rubro: 'Almacen' }], leerJSON: (p, def) => (/costeo\.json$/.test(p) ? estado.archivo : def), guardarJSON: (_p, d) => { estado.archivo = d; },
    DATA_DIR: require('os').tmpdir(), LISTA_PRECIOS_VENTA: 1,
  });
  const llamar = (method, ruta, body, sinConfig) => {
    const layer = router.stack.find(l => l.route && l.route.methods[method] && l.match(ruta));
    return new Promise(resolve => layer.route.stack[0].handle(
      { params: layer.params, body, query: {}, preciosSinConfig: sinConfig }, { json: resolve }));
  };
  return { estado, llamar };
}

test('GET config/publica: con permiso sólo lo mínimo; sin permiso además la vista proyectada', async () => {
  const { llamar } = routerPrecios({ ...COSTEO });
  const con = await llamar('get', '/api/precios/config/publica', undefined, false);
  assert.deepStrictEqual(Object.keys(con).sort(), ['costoHora', 'ivaVentaPct', 'packBulto', 'puedeConfig', 'toleranciaPct']);
  assert.strictEqual(con.puedeConfig, true);
  const sin = permisos.sinClavesOcultas(await llamar('get', '/api/precios/config/publica', undefined, true));
  assert.strictEqual(sin.puedeConfig, false);
  assert.deepStrictEqual(Object.keys(sin).sort(), ['conceptosPrecioFinal', 'costoHora', 'curvaMarkup', 'gastosVentaPctPorTipo',
    'ivaVentaPct', 'packBulto', 'puedeConfig', 'toleranciaPct']);
});

test('PUT margen-producto sin permiso: recibe markup, guarda ganancia del tipo y responde el markup', async () => {
  const { estado, llamar } = routerPrecios({ ...COSTEO, margenPorProducto: {} });
  const r = await llamar('put', '/api/precios/margen-producto/900', { gananciaPct: 50 }, true);
  assert.deepStrictEqual(r, { plu: '900', valor: 50 });
  cerca(estado.archivo.margenPorProducto['900'], permisos.gananciaDesdeMarkupTipo(COSTEO, 'almacen', 50), 1e-9);
  assert.match((await llamar('put', '/api/precios/margen-producto/900', { gananciaPct: 5000 }, true)).error, /valor inválido/);
  assert.deepStrictEqual(await llamar('put', '/api/precios/margen-producto/900', { gananciaPct: null }, true), { plu: '900', valor: null });
  // Con permiso, como siempre: el valor es ganancia.
  assert.deepStrictEqual(await llamar('put', '/api/precios/margen-producto/900', { gananciaPct: 20 }, false), { plu: '900', valor: 20 });
});

test('temporales sin permiso: la ganancia llega y sale como markup', async () => {
  const { estado, llamar } = routerPrecios({ ...COSTEO, presentacionesTemporales: {} });
  const r = await llamar('post', '/api/precios/presentaciones-temporales/4409', { pesoG: 250, gananciaPct: 60 }, true);
  cerca(r.temporal.gananciaPct, 60, 1e-4);
  const guardada = estado.archivo.presentacionesTemporales['4409'][0].gananciaPct;
  cerca(guardada, permisos.gananciaDesdeMarkupTipo(COSTEO, 'fraccionado', 60), 1e-9);
  assert.ok(guardada < 60);
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
