const test = require('node:test');
const assert = require('node:assert');
const {
  CATALOGO_MODULOS,
  hashPassword, verifyPassword,
  moduloDeRuta, puedeAcceder,
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
