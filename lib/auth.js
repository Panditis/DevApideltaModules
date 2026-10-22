// ── auth.js ──────────────────────────────────────────────────────────────────
// Infraestructura de autenticación y control de acceso por módulo.
// Sigue los patrones del proyecto: persistencia JSON síncrona en data/ y sin
// dependencias externas para el hashing (usa el módulo nativo `crypto`).
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USUARIOS_PATH = path.join(DATA_DIR, 'usuarios.json');
const MODULOS_PATH = path.join(DATA_DIR, 'modulos.json');

// ── Persistencia (mismo patrón que server.js: leerJSON/guardarJSON) ────────────
function leerJSON(p, def) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return def; }
}
function guardarJSON(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

// ── Catálogo canónico de módulos ───────────────────────────────────────────────
// Fuente única del mapeo ruta→módulo. Los overrides editables (activo,
// requiereAuth) viven en data/modulos.json; acá está lo que NO se edita.
// apiPrefijos sólo se asigna a módulos con prefijo único y auto-contenido; el
// clúster enredado (distribucion/produccion/planificacion/a8020 comparten
// /api/distribucion, /api/plan, /api/produccion…) queda como "sólo requiere login".
const CATALOGO_MODULOS = [
  { ref: 'a8020',               titulo: 'A8020 Calculado',          icon: 'bar-chart-2',   href: '/distribucion/a8020', rutasHtml: ['/distribucion/a8020'], apiPrefijos: [],                                  defaultRequiereAuth: true },
  { ref: 'pedidos',             titulo: 'Pedidos',                  icon: 'clipboard-list', href: '/pedidos',            rutasHtml: ['/pedidos'],            apiPrefijos: ['/api/pedidos', '/api/facturas', '/api/mayoristas'],  defaultRequiereAuth: true },
  { ref: 'planificacion',       titulo: 'Planificación',            icon: 'calendar-range', href: '/planificacion',      rutasHtml: ['/planificacion'],      apiPrefijos: [],                                  defaultRequiereAuth: true },
  { ref: 'produccion',          titulo: 'Producción',               icon: 'factory',        href: '/produccion',         rutasHtml: ['/produccion'],         apiPrefijos: [],                                  defaultRequiereAuth: true },
  { ref: 'productividad',       titulo: 'Productividad de Sala',    icon: 'gauge',          href: '/productividad',      rutasHtml: ['/productividad'],      apiPrefijos: ['/api/productividad'],             defaultRequiereAuth: true },
  { ref: 'fraccionado-externo',  titulo: 'Fraccionado Externo',      icon: 'package',        href: '/fraccionado-externo', rutasHtml: ['/fraccionado-externo'], apiPrefijos: ['/api/fraccionado-externo'],       defaultRequiereAuth: true },
  // Compras es un único módulo (el de reposición). '/compras-modulo' quedó como ruta
  // histórica que redirige a '/compras': se mantiene acá para que la redirección
  // siga pasando por el control de acceso.
  // '/compras/siga' y '/api/compras-siga' (importación de pedidos a SIGA) van explícitos: el prefijo
  // '/api/compras' no los cubre porque moduloDeRuta matchea con límite de segmento.
  { ref: 'compras',             titulo: 'Compras',                  icon: 'shopping-cart',  href: '/compras',            rutasHtml: ['/compras', '/compras-modulo', '/compras/siga'], apiPrefijos: ['/api/compras', '/api/compras-modulo', '/api/compras-import', '/api/compras-siga'], defaultRequiereAuth: true },
  { ref: 'consumo',             titulo: 'Compras Carlos',        icon: 'truck',          href: '/consumo',            rutasHtml: ['/consumo'],            apiPrefijos: ['/api/consumo', '/api/pendientes'], defaultRequiereAuth: true },
  { ref: 'insumos',             titulo: 'Control de Insumos',       icon: 'boxes',          href: '/insumos',            rutasHtml: ['/insumos'],            apiPrefijos: ['/api/insumos'],                   defaultRequiereAuth: true },
  { ref: 'distribucion',        titulo: 'Distribución y Fraccionado', icon: 'package',      href: '/distribucion',       rutasHtml: ['/distribucion'],       apiPrefijos: [],                                  defaultRequiereAuth: true },
  { ref: 'ventas-hora',         titulo: 'Ventas por Hora',          icon: 'clock',          href: '/ventas-hora',        rutasHtml: ['/ventas-hora'],        apiPrefijos: ['/api/ventas-hora'],               defaultRequiereAuth: true },
  { ref: 'precios-proveedores', titulo: 'Precios de Proveedores',   icon: 'tags',           href: '/precios-proveedores', rutasHtml: ['/precios-proveedores'], apiPrefijos: ['/api/precios-proveedores'],     defaultRequiereAuth: true },
  // El diagnóstico de quiebres cuelga de este módulo: mismo permiso, sin tile propio en el hub.
  { ref: 'analisis-ventas',     titulo: 'Análisis de Ventas',       icon: 'bar-chart-3',    href: '/analisis-ventas',    rutasHtml: ['/analisis-ventas', '/diagnostico-quiebre'], apiPrefijos: ['/api/analisis-ventas'], defaultRequiereAuth: true },
  { ref: 'analisis-central',    titulo: 'Análisis Casa Central',    icon: 'building-2',     href: '/analisis-central',   rutasHtml: ['/analisis-central'],   apiPrefijos: ['/api/analisis-central'],          defaultRequiereAuth: true },
  { ref: 'cuentas-corrientes',  titulo: 'Cuentas Corrientes',       icon: 'wallet',         href: '/cuentas-corrientes', rutasHtml: ['/cuentas-corrientes'], apiPrefijos: ['/api/cuentas-corrientes'],        defaultRequiereAuth: true },
  { ref: 'cruce-terminales',    titulo: 'Cruce de Terminales',      icon: 'credit-card',    href: '/cruce-terminales',   rutasHtml: ['/cruce-terminales'],   apiPrefijos: ['/api/cruce-terminales'],          defaultRequiereAuth: true },
  { ref: 'cruce-bancario',      titulo: 'Cruce Bancario',           icon: 'landmark',       href: '/cruce-bancario',     rutasHtml: ['/cruce-bancario'],     apiPrefijos: ['/api/cruce-bancario'],            defaultRequiereAuth: true },
  { ref: 'carteles-pesables',   titulo: 'Carteles Pesables',        icon: 'tag',            href: '/carteles-pesables',  rutasHtml: ['/carteles-pesables'],  apiPrefijos: ['/api/carteles-pesables'],         defaultRequiereAuth: true },
  { ref: 'precios-historico',   titulo: 'Precios Históricos',       icon: 'history',        href: '/precios-historico',  rutasHtml: ['/precios-historico'],  apiPrefijos: ['/api/precios-historico'],         defaultRequiereAuth: true },
  { ref: 'precios',             titulo: 'Precios',                  icon: 'tags',           href: '/precios',            rutasHtml: ['/precios'],            apiPrefijos: ['/api/precios'],                   defaultRequiereAuth: true },
  // RRHH es un módulo contenedor: su href apunta al sub-hub y de ahí cuelgan sus
  // submódulos (por ahora, el relevamiento de ropa de trabajo). Un solo permiso
  // para toda el área: sumar un submódulo es sumar su ruta acá.
  { ref: 'rrhh',                titulo: 'RRHH',                     icon: 'users',          href: '/rrhh',               rutasHtml: ['/rrhh', '/rrhh/relevamiento-ropa', '/rrhh/ausencias', '/rrhh/analizador-cv'], apiPrefijos: ['/api/rrhh'],          defaultRequiereAuth: true },
  // Sucursales es un módulo contenedor como RRHH: su href apunta al sub-hub y de ahí cuelgan
  // sus submódulos (por ahora, Mantenimiento: tickets propios). Un solo permiso para toda el área.
  { ref: 'sucursales',          titulo: 'Sucursales',               icon: 'store',          href: '/sucursales',         rutasHtml: ['/sucursales', '/sucursales/mantenimiento'], apiPrefijos: ['/api/sucursales'], defaultRequiereAuth: true },
  // Con el módulo se ven, crean y comentan tickets; cambiar estados (y destinatarios ajenos) pide 'tickets-gestion'.
  { ref: 'tickets',             titulo: 'Tickets de Desarrollo',    icon: 'ticket',         href: '/tickets',            rutasHtml: ['/tickets'],            apiPrefijos: ['/api/tickets'],                   defaultRequiereAuth: true },
  { ref: 'admin',               titulo: 'Centro de control',        icon: 'shield',         href: '/admin',              rutasHtml: ['/admin'],              apiPrefijos: ['/api/admin'],                     defaultRequiereAuth: true, soloAdmin: true },
];

const CATALOGO_POR_REF = new Map(CATALOGO_MODULOS.map(m => [m.ref, m]));

// Permisos finos dentro de un módulo: se asignan por usuario en /admin igual que los módulos (van en
// usuario.modulos) pero no son tiles del hub ni prefijos de ruta; el control lo hace el módulo con
// tienePermiso. esAdmin los tiene todos.
const PERMISOS_EXTRA = [
  { ref: 'precios-config', titulo: 'Precios · Configuración', modulo: 'precios' },
  { ref: 'tickets-gestion', titulo: 'Tickets · Gestión', modulo: 'tickets' },
  { ref: 'mantenimiento-gestion', titulo: 'Mantenimiento · Gestión', modulo: 'sucursales' },
];
const PERMISO_POR_REF = new Map(PERMISOS_EXTRA.map(p => [p.ref, p]));

// Índice de prefijos api ordenado por longitud desc: el prefijo más específico gana
// sobre el más corto. El chequeo de límite ('/') evita colisiones parciales.
const API_INDEX = CATALOGO_MODULOS
  .flatMap(m => m.apiPrefijos.map(pref => ({ ref: m.ref, pref })))
  .sort((a, b) => b.pref.length - a.pref.length);

// ── Overrides de módulos (data/modulos.json) ────────────────────────────────────
function leerModulos() {
  const overrides = leerJSON(MODULOS_PATH, {});
  return CATALOGO_MODULOS.map(m => {
    const o = overrides[m.ref] || {};
    return {
      ref: m.ref,
      titulo: m.titulo,
      icon: m.icon,
      href: m.href,
      soloAdmin: !!m.soloAdmin,
      activo: o.activo !== false,
      requiereAuth: typeof o.requiereAuth === 'boolean' ? o.requiereAuth : m.defaultRequiereAuth,
    };
  });
}
function guardarModulos(lista) {
  // Persiste sólo los campos editables por ref.
  const out = {};
  for (const m of Array.isArray(lista) ? lista : []) {
    if (!CATALOGO_POR_REF.has(m.ref)) continue;
    out[m.ref] = { activo: m.activo !== false, requiereAuth: !!m.requiereAuth };
  }
  guardarJSON(MODULOS_PATH, out);
  return leerModulos();
}
function moduloEstado(ref) {
  return leerModulos().find(m => m.ref === ref) || null;
}

// ── Hashing de contraseñas (crypto nativo, scrypt) ──────────────────────────────
const SCRYPT_KEYLEN = 64;
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, SCRYPT_KEYLEN).toString('hex');
  return { salt, hash };
}
function verifyPassword(pw, salt, hash) {
  if (!salt || !hash) return false;
  let derivada;
  try { derivada = crypto.scryptSync(String(pw), salt, SCRYPT_KEYLEN); }
  catch (e) { return false; }
  const guardada = Buffer.from(hash, 'hex');
  if (guardada.length !== derivada.length) return false;
  return crypto.timingSafeEqual(guardada, derivada);
}

// ── Mapeo de ruta → ref de módulo ───────────────────────────────────────────────
function moduloDeRuta(p) {
  // Express enruta case-insensitive por defecto: normalizamos a minúsculas para
  // que el matching de auth no se pueda esquivar variando mayúsculas en la URL.
  const ruta = String(p || '').split('?')[0].toLowerCase();
  // 1) Páginas HTML por igualdad exacta ('/distribucion/a8020' antes que '/distribucion').
  for (const m of CATALOGO_MODULOS) {
    if (m.rutasHtml.includes(ruta)) return m.ref;
  }
  // 2) Prefijos de API, el más largo primero, con límite de segmento.
  for (const { ref, pref } of API_INDEX) {
    if (ruta === pref || ruta.startsWith(pref + '/')) return ref;
  }
  return null; // Ruta no asociada a ningún módulo.
}

// Permiso fino (PERMISOS_EXTRA) del usuario de la sesión, releído de data/usuarios.json: quitarlo, desactivar
// o borrar al usuario rige en el próximo request, sin esperar a que vuelva a loguearse. Sin sesión → false.
function tienePermiso(user, ref) {
  if (!user || !PERMISO_POR_REF.has(ref)) return false;
  const actual = leerUsuarios().find(u => Number(u.id) === Number(user.id));
  if (!actual || actual.activo === false) return false;
  if (actual.esAdmin) return true;
  return Array.isArray(actual.modulos) && actual.modulos.includes(ref);
}

function puedeAcceder(user, ref) {
  if (!user) return false;
  if (user.esAdmin) return true;
  if (!ref) return true; // rutas sin módulo: basta con estar autenticado.
  return Array.isArray(user.modulos) && user.modulos.includes(ref);
}

// ── Usuarios (data/usuarios.json) ────────────────────────────────────────────────
function sanitizar(u) {
  if (!u) return null;
  const { salt, hash, ...resto } = u;
  return resto;
}
function leerUsuarios() { return leerJSON(USUARIOS_PATH, []); }
function guardarUsuarios(lista) { guardarJSON(USUARIOS_PATH, lista); return lista; }
function listarUsuarios() { return leerUsuarios().map(sanitizar); }

function buscarPorUsuario(usuario) {
  const u = String(usuario || '').trim().toLowerCase();
  return leerUsuarios().find(x => String(x.usuario || '').toLowerCase() === u) || null;
}

// Hash señuelo para igualar el tiempo de respuesta cuando el usuario no existe
// (evita enumeración de usuarios por timing).
const DUMMY_SALT = 'ffffffffffffffffffffffffffffffff';
function scryptSeñuelo(password) {
  try { crypto.scryptSync(String(password || ''), DUMMY_SALT, SCRYPT_KEYLEN); } catch (e) { /* no-op */ }
}

// Verifica credenciales para el login. Devuelve el usuario saneado o null.
function autenticar(usuario, password) {
  const u = buscarPorUsuario(usuario);
  if (!u || u.activo === false) { scryptSeñuelo(password); return null; }
  if (!verifyPassword(password, u.salt, u.hash)) return null;
  return sanitizar(u);
}

function nuevoId(lista) {
  return lista.reduce((max, u) => Math.max(max, Number(u.id) || 0), 0) + 1;
}
function refsValidos(modulos) {
  return Array.isArray(modulos) ? modulos.filter(r => CATALOGO_POR_REF.has(r) || PERMISO_POR_REF.has(r)) : [];
}
const MIN_PASSWORD = 8;
function validarPassword(pw) {
  if (!pw) throw new Error('La contraseña es obligatoria.');
  if (String(pw).length < MIN_PASSWORD) throw new Error(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`);
}
// ¿Se dejaría al sistema sin ningún administrador activo con este cambio sobre `id`?
function dejariaSinAdmin(lista, id, cambios) {
  const actual = lista.find(u => Number(u.id) === Number(id));
  if (!actual || !actual.esAdmin || actual.activo === false) return false;
  const otrosAdmins = lista.filter(u => Number(u.id) !== Number(id) && u.esAdmin && u.activo !== false).length;
  if (otrosAdmins > 0) return false; // hay otro admin activo: seguro
  const quitaAdmin = cambios.esAdmin === false;
  const desactiva = cambios.activo === false;
  return quitaAdmin || desactiva;
}

function crearUsuario({ usuario, nombre, password, esAdmin = false, modulos = [], activo = true }) {
  const uname = String(usuario || '').trim();
  if (!uname) throw new Error('El usuario es obligatorio.');
  validarPassword(password);
  if (buscarPorUsuario(uname)) throw new Error('Ya existe un usuario con ese nombre.');
  const lista = leerUsuarios();
  const { salt, hash } = hashPassword(password);
  const nuevo = {
    id: nuevoId(lista),
    usuario: uname,
    nombre: String(nombre || uname).trim(),
    salt, hash,
    esAdmin: !!esAdmin,
    modulos: refsValidos(modulos),
    activo: activo !== false,
  };
  lista.push(nuevo);
  guardarUsuarios(lista);
  return sanitizar(nuevo);
}

function actualizarUsuario(id, cambios = {}) {
  const lista = leerUsuarios();
  const idx = lista.findIndex(u => Number(u.id) === Number(id));
  if (idx === -1) throw new Error('Usuario no encontrado.');
  const actual = lista[idx];
  // Cambio de nombre de usuario: validar unicidad contra otros.
  if (cambios.usuario !== undefined) {
    const uname = String(cambios.usuario || '').trim();
    if (!uname) throw new Error('El usuario es obligatorio.');
    const choque = lista.find(u => Number(u.id) !== Number(id) && String(u.usuario).toLowerCase() === uname.toLowerCase());
    if (choque) throw new Error('Ya existe un usuario con ese nombre.');
  }
  // No permitir quedar sin ningún administrador activo.
  if (dejariaSinAdmin(lista, id, cambios)) {
    throw new Error('No se puede quitar el rol admin ni desactivar al último administrador activo.');
  }
  // Password opcional: si viene, validar longitud mínima.
  if (cambios.password) validarPassword(cambios.password);
  const actualizado = {
    ...actual,
    ...(cambios.usuario !== undefined ? { usuario: String(cambios.usuario).trim() } : {}),
    ...(cambios.nombre !== undefined ? { nombre: String(cambios.nombre).trim() } : {}),
    ...(cambios.esAdmin !== undefined ? { esAdmin: !!cambios.esAdmin } : {}),
    ...(cambios.modulos !== undefined ? { modulos: refsValidos(cambios.modulos) } : {}),
    ...(cambios.activo !== undefined ? { activo: cambios.activo !== false } : {}),
  };
  // Password opcional: sólo re-hashea si viene con contenido.
  if (cambios.password) {
    const { salt, hash } = hashPassword(cambios.password);
    actualizado.salt = salt;
    actualizado.hash = hash;
  }
  lista[idx] = actualizado;
  guardarUsuarios(lista);
  return sanitizar(actualizado);
}

function setPassword(id, password) {
  if (!password) throw new Error('La contraseña es obligatoria.');
  return actualizarUsuario(id, { password });
}

// Cambio de contraseña que hace el propio usuario desde el hub: exige la actual
// (no alcanza con tener la sesión abierta) y valida la nueva con la misma regla
// que el alta. Devuelve true o tira Error con el mensaje que ve el usuario.
function cambiarPasswordPropia(usuario, actual, nueva) {
  const u = autenticar(usuario, actual); // valida usuario activo + contraseña actual
  if (!u) throw new Error('La contraseña actual no es correcta.');
  validarPassword(nueva);
  if (String(actual) === String(nueva)) throw new Error('La nueva contraseña debe ser distinta de la actual.');
  setPassword(u.id, nueva);
  return true;
}

function eliminarUsuario(id) {
  const lista = leerUsuarios();
  const idx = lista.findIndex(u => Number(u.id) === Number(id));
  if (idx === -1) throw new Error('Usuario no encontrado.');
  const esUltimoAdmin = lista[idx].esAdmin && lista.filter(u => u.esAdmin && u.activo !== false).length <= 1;
  if (esUltimoAdmin) throw new Error('No se puede eliminar el último administrador activo.');
  lista.splice(idx, 1);
  guardarUsuarios(lista);
  return true;
}

// ── Seed de admin inicial ────────────────────────────────────────────────────────
// Si no hay usuarios, crea un admin. La contraseña sale de AUTH_ADMIN_PASSWORD o,
// si falta, se genera aleatoria y se imprime UNA sola vez en consola. Sin secretos
// hardcodeados.
function seedAdminSiVacio() {
  const lista = leerUsuarios();
  if (lista.length > 0) return null;
  const password = process.env.AUTH_ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  const generada = !process.env.AUTH_ADMIN_PASSWORD;
  const admin = crearUsuario({
    usuario: 'admin',
    nombre: 'Administrador',
    password,
    esAdmin: true,
    modulos: CATALOGO_MODULOS.map(m => m.ref),
    activo: true,
  });
  console.log('\n========================================================');
  console.log('  [auth] Admin inicial creado → usuario: admin');
  if (generada) {
    console.log(`  [auth] Contraseña generada: ${password}`);
    console.log('  [auth] Guardala ahora; no se vuelve a mostrar. Cambiala desde /admin.');
  } else {
    console.log('  [auth] Contraseña tomada de AUTH_ADMIN_PASSWORD.');
  }
  console.log('========================================================\n');
  return admin;
}

module.exports = {
  CATALOGO_MODULOS,
  PERMISOS_EXTRA,
  tienePermiso,
  hashPassword,
  verifyPassword,
  moduloDeRuta,
  puedeAcceder,
  leerModulos,
  guardarModulos,
  moduloEstado,
  leerUsuarios,
  listarUsuarios,
  buscarPorUsuario,
  autenticar,
  crearUsuario,
  actualizarUsuario,
  setPassword,
  cambiarPasswordPropia,
  eliminarUsuario,
  seedAdminSiVacio,
};
