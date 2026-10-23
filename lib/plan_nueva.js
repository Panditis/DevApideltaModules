'use strict';
// Planificación nueva (spec docs/superpowers/specs/2026-10-22-planificacion-nueva-design.md): cálculos y
// validaciones puras. El I/O (JSON en data/ y SIGA) vive en routes/rutas_plan_nueva.js. Nada muta la entrada:
// cada operación devuelve listas nuevas.

const esPlu = p => /^\d+$/.test(String(p ?? ''));
const normalizar = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// Error con status HTTP: el router responde err.status (400/404/409) en vez de 500.
function errorHttp(status, mensaje) {
  const e = new Error(mensaje);
  e.status = status;
  return e;
}

// ── Catálogo: { categorias: [{ id, nombre, plus: ['2183', …], creado }] } ──────────────────────────
// body { nombre, plus } → { nombre, plus } limpio. Nombre no vacío y único sin mayúsculas/acentos; un PLU
// pertenece a una sola categoría (idPropio: la que se edita, no choca consigo misma).
function validarCategoria(body, categorias, idPropio = null) {
  const b = body || {};
  const nombre = String(b.nombre ?? '').trim();
  if (!nombre) throw errorHttp(400, 'El nombre de la categoría no puede estar vacío');
  const otras = (categorias || []).filter(c => c.id !== idPropio);
  if (otras.some(c => normalizar(c.nombre) === normalizar(nombre))) throw errorHttp(409, `Ya existe la categoría "${nombre}"`);
  if (!Array.isArray(b.plus)) throw errorHttp(400, 'Presentaciones: se esperaba una lista de PLU');
  const plus = [...new Set(b.plus.map(p => String(p ?? '').trim()))];
  const invalido = plus.find(p => !esPlu(p));
  if (invalido !== undefined) throw errorHttp(400, `PLU inválido: "${invalido}"`);
  for (const c of otras) {
    const repetido = plus.find(p => c.plus.includes(p));
    if (repetido) throw errorHttp(409, `El PLU ${repetido} ya está en la categoría "${c.nombre}"`);
  }
  return { nombre, plus };
}

function agregarCategoria(categorias, body, { id, ahora }) {
  const categoria = { id, ...validarCategoria(body, categorias), creado: ahora };
  return { categorias: [...categorias, categoria], categoria };
}

function editarCategoria(categorias, id, body) {
  const actual = categorias.find(c => c.id === id);
  if (!actual) throw errorHttp(404, 'No existe la categoría');
  const categoria = { ...actual, ...validarCategoria(body, categorias, id) };
  return { categorias: categorias.map(c => (c.id === id ? categoria : c)), categoria };
}

function borrarCategoria(categorias, id) {
  if (!categorias.some(c => c.id === id)) throw errorHttp(404, 'No existe la categoría');
  return categorias.filter(c => c.id !== id);
}

module.exports = {
  esPlu, normalizar, errorHttp,
  validarCategoria, agregarCategoria, editarCategoria, borrarCategoria,
};
