const test = require('node:test');
const assert = require('node:assert');
const {
  CATALOGO_MODULOS,
  hashPassword, verifyPassword,
  moduloDeRuta, puedeAcceder, hubDeUsuario, usuariosDelModulo,
  crearUsuario, eliminarUsuario, autenticar, cambiarPasswordPropia,
} = require('../lib/auth');

// ── hashPassword / verifyPassword ───────────────────────────────────────────────
test('hashPassword + verifyPassword hacen round-trip con la password correcta', () => {
  const { salt, hash } = hashPassword('secreta123');
  assert.strictEqual(verifyPassword('secreta123', salt, hash), true);
});

test('verifyPassword rechaza una password incorrecta', () => {
  const { salt, hash } = hashPassword('secreta123');
  assert.strictEqual(verifyPassword('otra', salt, hash), false);
});

test('verifyPassword devuelve false si falta salt o hash', () => {
  const { salt, hash } = hashPassword('secreta123');
  assert.strictEqual(verifyPassword('secreta123', undefined, hash), false);
  assert.strictEqual(verifyPassword('secreta123', salt, undefined), false);
  assert.strictEqual(verifyPassword('secreta123', undefined, undefined), false);
});

test('hashPassword genera un salt aleatorio distinto en cada llamada', () => {
  const a = hashPassword('misma');
  const b = hashPassword('misma');
  assert.notStrictEqual(a.salt, b.salt); // salt aleatorio
  assert.notStrictEqual(a.hash, b.hash); // por ende el hash también difiere
  // Cada par sigue verificando su propia password.
  assert.strictEqual(verifyPassword('misma', a.salt, a.hash), true);
  assert.strictEqual(verifyPassword('misma', b.salt, b.hash), true);
});

// ── moduloDeRuta: páginas HTML exactas (el más específico gana) ──────────────────
test('moduloDeRuta resuelve páginas HTML por igualdad exacta', () => {
  assert.strictEqual(moduloDeRuta('/compras'), 'compras');
  assert.strictEqual(moduloDeRuta('/distribucion'), 'distribucion');
  assert.strictEqual(moduloDeRuta('/planificacion'), 'planificacion');
});

test('moduloDeRuta resuelve Sucursales y sus submódulos Mantenimiento y Carteles Pesables', () => {
  assert.strictEqual(moduloDeRuta('/sucursales'), 'sucursales');
  assert.strictEqual(moduloDeRuta('/sucursales/mantenimiento'), 'sucursales');
  assert.strictEqual(moduloDeRuta('/api/sucursales/mantenimiento'), 'sucursales');
  assert.strictEqual(moduloDeRuta('/api/sucursales/mantenimiento/3/etapas'), 'sucursales');
  assert.strictEqual(moduloDeRuta('/carteles-pesables'), 'sucursales');
  assert.strictEqual(moduloDeRuta('/api/carteles-pesables'), 'sucursales');
});

test('moduloDeRuta da prioridad a la ruta HTML más específica (/distribucion/a8020)', () => {
  assert.strictEqual(moduloDeRuta('/distribucion/a8020'), 'a8020');
});

// ── moduloDeRuta: prefijos de API con límite de segmento ─────────────────────────
test('moduloDeRuta mapea ambos prefijos de compras al módulo unificado', () => {
  assert.strictEqual(moduloDeRuta('/api/compras-modulo/x'), 'compras');
  assert.strictEqual(moduloDeRuta('/api/compras/y'), 'compras');
});

test('la ruta histórica /compras-modulo sigue bajo el módulo compras', () => {
  assert.strictEqual(moduloDeRuta('/compras-modulo'), 'compras');
});

test('el prefijo /api/panel del panel viejo ya no mapea a ningún módulo', () => {
  assert.strictEqual(moduloDeRuta('/api/panel/datos'), null);
});

test('moduloDeRuta mapea prefijos api de único segmento', () => {
  assert.strictEqual(moduloDeRuta('/api/precios-proveedores'), 'precios-proveedores');
});

test('las APIs de Precios › Producción quedan bajo el módulo precios; los prefijos vecinos no cambian', () => {
  assert.strictEqual(moduloDeRuta('/api/precios/produccion/productos'), 'precios');
  assert.strictEqual(moduloDeRuta('/api/precios/produccion/productos/p-pepas/recetas/base'), 'precios');
  assert.strictEqual(moduloDeRuta('/api/precios/produccion/alertas'), 'precios');
  assert.strictEqual(moduloDeRuta('/API/Precios/Produccion/alertas'), 'precios');
  assert.strictEqual(moduloDeRuta('/api/precios-proveedores/listado'), 'precios-proveedores');
  assert.strictEqual(moduloDeRuta('/api/precios-historico/x'), 'precios-historico');
});

test('las APIs de Precios › Pack / Bulto quedan bajo el módulo precios', () => {
  assert.strictEqual(moduloDeRuta('/api/precios/pack-bulto/vinculos'), 'precios');
  assert.strictEqual(moduloDeRuta('/api/precios/pack-bulto/descuento/91031'), 'precios');
  assert.strictEqual(moduloDeRuta('/api/precios/pack-bulto/vinculo/91031'), 'precios');
  assert.strictEqual(moduloDeRuta('/api/precios/config/pack-bulto'), 'precios');
});

// ── moduloDeRuta: rutas no mapeadas ──────────────────────────────────────────────
test('moduloDeRuta devuelve null para rutas sin módulo', () => {
  assert.strictEqual(moduloDeRuta('/api/health'), null);
  assert.strictEqual(moduloDeRuta('/cualquiera'), null);
});

// ── puedeAcceder ─────────────────────────────────────────────────────────────────
test('puedeAcceder: el admin accede a cualquier ref', () => {
  const admin = { esAdmin: true };
  assert.strictEqual(puedeAcceder(admin, 'compras'), true);
  assert.strictEqual(puedeAcceder(admin, 'pedidos'), true);
  assert.strictEqual(puedeAcceder(admin, 'no-existe'), true);
});

test('puedeAcceder: el usuario sólo entra a sus módulos asignados', () => {
  const user = { modulos: ['compras'] };
  assert.strictEqual(puedeAcceder(user, 'compras'), true);
  assert.strictEqual(puedeAcceder(user, 'pedidos'), false);
});

test('puedeAcceder: usuario null nunca accede', () => {
  assert.strictEqual(puedeAcceder(null, 'compras'), false);
});

test('puedeAcceder: ref null sólo requiere estar autenticado', () => {
  const user = { modulos: ['compras'] };
  assert.strictEqual(puedeAcceder(user, null), true);
});

test('las APIs de mayoristas quedan bajo el modulo pedidos', () => {
  // Sin esto las rutas nuevas de /api/mayoristas quedan fuera de todo módulo y sin
  // guard de acceso, que es el gap que ya apareció en el clúster distribución/producción.
  assert.strictEqual(moduloDeRuta('/api/mayoristas/ordenes-fraccionado'), 'pedidos');
  assert.strictEqual(moduloDeRuta('/api/mayoristas/fraccionado-faltantes'), 'pedidos');
});

// ── CATALOGO_MODULOS ─────────────────────────────────────────────────────────────
test('CATALOGO_MODULOS es un array no vacío con la forma esperada por entrada', () => {
  assert.ok(Array.isArray(CATALOGO_MODULOS));
  assert.ok(CATALOGO_MODULOS.length > 0);
  for (const m of CATALOGO_MODULOS) {
    assert.strictEqual(typeof m.ref, 'string');
    assert.ok(Array.isArray(m.rutasHtml));
  }
});


// ── cambiarPasswordPropia ───────────────────────────────────────────────────────
// Usa el data/usuarios.json real: crea un usuario descartable y lo borra al final.
test('cambiarPasswordPropia exige la actual, valida la nueva y la deja aplicada', (t) => {
  const uname = 'tmp_test_pw';
  crearUsuario({ usuario: uname, nombre: 'Temporal test', password: 'vieja123', modulos: [] });
  try {
    // La contraseña actual equivocada no cambia nada.
    assert.throws(() => cambiarPasswordPropia(uname, 'incorrecta', 'nueva12345'), /actual no es correcta/);
    assert.ok(autenticar(uname, 'vieja123'), 'la vieja sigue sirviendo tras el intento fallido');

    // La nueva corta se rechaza (misma regla que el alta).
    assert.throws(() => cambiarPasswordPropia(uname, 'vieja123', 'corta'), /al menos 8/);

    // Repetir la misma contraseña no cuenta como cambio.
    assert.throws(() => cambiarPasswordPropia(uname, 'vieja123', 'vieja123'), /distinta de la actual/);

    // Camino feliz: queda la nueva y la vieja deja de servir.
    assert.strictEqual(cambiarPasswordPropia(uname, 'vieja123', 'nueva12345'), true);
    assert.ok(autenticar(uname, 'nueva12345'), 'la nueva contraseña autentica');
    assert.strictEqual(autenticar(uname, 'vieja123'), null, 'la vieja ya no autentica');
  } finally {
    eliminarUsuario(require('../lib/auth').buscarPorUsuario(uname).id);
  }
});

test('la importación a SIGA (/compras/siga y /api/compras-siga) queda bajo el módulo compras', () => {
  assert.strictEqual(moduloDeRuta('/compras/siga'), 'compras');
  assert.strictEqual(moduloDeRuta('/api/compras-siga/grabar'), 'compras');
  assert.strictEqual(moduloDeRuta('/api/compras-siga/pedidos/P-0001/borrador'), 'compras');
});

// ── usuariosDelModulo (destinatarios de Mantenimiento) ──────────────────────────
test('usuariosDelModulo trae sólo cuentas activas, no admin, con el módulo, sin salt ni hash', () => {
  const lista = [
    { usuario: 'SucursalNacion', nombre: 'Nacion', modulos: ['sucursales', 'solo-sucursales'], salt: 's', hash: 'h' },
    { usuario: 'sinNombre', nombre: '', modulos: ['sucursales'] },
    { usuario: 'baja', nombre: 'Baja', activo: false, modulos: ['sucursales'] },
    { usuario: 'jefe', nombre: 'Jefe', esAdmin: true, modulos: ['sucursales'] },
    { usuario: 'ventas', nombre: 'Ventas', modulos: ['pedidos'] },
    { usuario: 'sinModulos', nombre: 'X' },
  ];
  assert.deepStrictEqual(usuariosDelModulo(lista, 'sucursales'), [
    { usuario: 'SucursalNacion', nombre: 'Nacion' },
    { usuario: 'sinNombre', nombre: 'sinNombre' },
  ]);
  assert.deepStrictEqual(usuariosDelModulo(null, 'sucursales'), []);
});

// ── hubDeUsuario (permiso 'solo-sucursales') ────────────────────────────────────
test('hubDeUsuario ata a /sucursales sólo con el permiso + el módulo, y nunca al admin', () => {
  assert.strictEqual(hubDeUsuario({ modulos: ['sucursales', 'solo-sucursales'] }), '/sucursales');
  assert.strictEqual(hubDeUsuario({ modulos: ['sucursales'] }), null);
  // Sin el módulo, /sucursales daría 403 → '/' → loop: no se ata.
  assert.strictEqual(hubDeUsuario({ modulos: ['solo-sucursales'] }), null);
  assert.strictEqual(hubDeUsuario({ esAdmin: true, modulos: ['sucursales', 'solo-sucursales'] }), null);
  assert.strictEqual(hubDeUsuario({ activo: false, modulos: ['sucursales', 'solo-sucursales'] }), null);
  assert.strictEqual(hubDeUsuario(null), null);
});

test('Redistribución: /api/distribucion/redistribucion exige el módulo distribucion; /rotacion ya no tiene guard propio', () => {
  const ref = moduloDeRuta('/api/distribucion/redistribucion?dias=30');
  assert.strictEqual(ref, 'distribucion');
  assert.strictEqual(puedeAcceder({ modulos: ['distribucion'] }, ref), true);
  assert.strictEqual(puedeAcceder({ modulos: ['compras'] }, ref), false);   // el middleware responde 403
  assert.strictEqual(moduloDeRuta('/API/Distribucion/Redistribucion'), 'distribucion');
  assert.strictEqual(moduloDeRuta('/api/distribucion/rotacion'), null);
  assert.strictEqual(moduloDeRuta('/api/distribucion/redistribucionX'), null);
});

test('Redistribución ocultos: GET/POST /ocultos y /ocultos/restablecer exigen el módulo distribucion', () => {
  for (const ruta of ['/api/distribucion/redistribucion/ocultos', '/api/distribucion/redistribucion/ocultos/restablecer']) {
    const ref = moduloDeRuta(ruta);
    assert.strictEqual(ref, 'distribucion', ruta);
    assert.strictEqual(puedeAcceder({ modulos: ['distribucion'] }, ref), true);
    assert.strictEqual(puedeAcceder({ modulos: ['compras'] }, ref), false); // el middleware responde 403
  }
});

test('moduloDeRuta resuelve Control de Vencimientos (/vencimientos y /api/vencimientos) bajo sucursales', () => {
  assert.strictEqual(moduloDeRuta('/vencimientos'), 'sucursales');
  assert.strictEqual(moduloDeRuta('/api/vencimientos'), 'sucursales');
  assert.strictEqual(moduloDeRuta('/api/vencimientos/lotes'), 'sucursales');
});

// Usa el data/usuarios.json real: crea usuarios descartables y los borra al final.
test('idSucursal: alta válida, ausente e inválida; edición y lectura vía idSucursalDe', () => {
  const auth = require('../lib/auth');
  const borrar = (u) => { const x = auth.buscarPorUsuario(u); if (x) auth.eliminarUsuario(x.id); };
  try {
    const conSuc = auth.crearUsuario({ usuario: 'tmp_test_suc1', password: 'clave12345', idSucursal: '3' });
    assert.strictEqual(conSuc.idSucursal, 3);
    assert.ok(auth.listarUsuarios().find(u => u.id === conSuc.id).idSucursal === 3, 'el listado del ABM lo trae');
    assert.strictEqual(auth.idSucursalDe({ id: conSuc.id }), 3, 'la sesión lo resuelve releyendo usuarios.json');

    const sinSuc = auth.crearUsuario({ usuario: 'tmp_test_suc2', password: 'clave12345' });
    assert.strictEqual(sinSuc.idSucursal, 1, 'sin sucursal => default 1');
    assert.strictEqual(auth.idSucursalDe({ id: sinSuc.id }), 1);
    assert.strictEqual(auth.normalizarIdSucursal(null), auth.SUCURSAL_DEFAULT);

    for (const malo of [0, -2, 1.5, 'abc']) {
      assert.throws(() => auth.crearUsuario({ usuario: 'tmp_test_suc3', password: 'clave12345', idSucursal: malo }), /entero mayor a 0/);
    }
    assert.strictEqual(auth.buscarPorUsuario('tmp_test_suc3'), null, 'el alta inválida no persiste');

    assert.strictEqual(auth.actualizarUsuario(sinSuc.id, { idSucursal: 7 }).idSucursal, 7);
    assert.strictEqual(auth.actualizarUsuario(sinSuc.id, { nombre: 'x' }).idSucursal, 7, 'no mandarlo no lo borra');
    assert.strictEqual(auth.actualizarUsuario(sinSuc.id, { idSucursal: '' }).idSucursal, 1, 'vacío vuelve al default');
    assert.throws(() => auth.actualizarUsuario(sinSuc.id, { idSucursal: 'x' }), /entero mayor a 0/);
    assert.strictEqual(auth.idSucursalDe(null), null);
  } finally {
    ['tmp_test_suc1', 'tmp_test_suc2', 'tmp_test_suc3'].forEach(borrar);
  }
});

test("tienePermiso: 'vencimientos-control' da true con el permiso, false sin él o inactivo; admin siempre", () => {
  const auth = require('../lib/auth');
  const borrar = u => { const x = auth.buscarPorUsuario(u); if (x) eliminarUsuario(x.id); };
  try {
    const con = crearUsuario({ usuario: 'tmp_test_vctrl1', password: 'clave12345', modulos: ['sucursales', 'vencimientos-control'] });
    const sin = crearUsuario({ usuario: 'tmp_test_vctrl2', password: 'clave12345', modulos: ['sucursales'] });
    const adm = crearUsuario({ usuario: 'tmp_test_vctrl3', password: 'clave12345', esAdmin: true });
    assert.strictEqual(auth.tienePermiso({ id: con.id }, 'vencimientos-control'), true);
    assert.strictEqual(auth.tienePermiso({ id: sin.id }, 'vencimientos-control'), false);
    assert.strictEqual(auth.tienePermiso({ id: adm.id }, 'vencimientos-control'), true);
    assert.strictEqual(auth.tienePermiso(null, 'vencimientos-control'), false);
    auth.actualizarUsuario(con.id, { activo: false });
    assert.strictEqual(auth.tienePermiso({ id: con.id }, 'vencimientos-control'), false, 'desactivar rige ya');
    assert.strictEqual(auth.moduloDeRuta('/vencimientos-control'), 'sucursales');
  } finally {
    ['tmp_test_vctrl1', 'tmp_test_vctrl2', 'tmp_test_vctrl3'].forEach(borrar);
  }
});
