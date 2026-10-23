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

// ── Parámetros: { diasConsumo, diasCubrir } (data/plan_nueva_params.json) ────────────────────────
const PARAMS_DEFAULT = Object.freeze({ diasConsumo: 120, diasCubrir: 30 });
const RANGO_DIAS_CONSUMO = Object.freeze([7, 365]);
const RANGO_DIAS_CUBRIR = Object.freeze([1, 180]);
const DIAS_MES = 30;
// ponytail: tolerancia para que 27.000000000000004 (9 ÷ 7 × 21) no redondee a 28.
const EPSILON = 1e-9;

// Entero en [min, max] (número o texto de dígitos) o null.
function enteroEnRango(v, [min, max]) {
  const n = typeof v === 'number' ? v : (/^\s*\d+\s*$/.test(String(v ?? '')) ? Number(v) : NaN);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

// Lo guardado (o nada) con defaults: un valor fuera de rango en el archivo cae al default.
function leerParams(guardado) {
  const g = guardado || {};
  return {
    diasConsumo: enteroEnRango(g.diasConsumo, RANGO_DIAS_CONSUMO) ?? PARAMS_DEFAULT.diasConsumo,
    diasCubrir: enteroEnRango(g.diasCubrir, RANGO_DIAS_CUBRIR) ?? PARAMS_DEFAULT.diasCubrir,
  };
}

function validarParams(body) {
  const b = body || {};
  const diasConsumo = enteroEnRango(b.diasConsumo, RANGO_DIAS_CONSUMO);
  if (diasConsumo === null) throw errorHttp(400, `Días de consumo: entero entre ${RANGO_DIAS_CONSUMO[0]} y ${RANGO_DIAS_CONSUMO[1]}`);
  const diasCubrir = enteroEnRango(b.diasCubrir, RANGO_DIAS_CUBRIR);
  if (diasCubrir === null) throw errorHttp(400, `Días a cubrir: entero entre ${RANGO_DIAS_CUBRIR[0]} y ${RANGO_DIAS_CUBRIR[1]}`);
  return { diasConsumo, diasCubrir };
}

// ── Tablero ───────────────────────────────────────────────────────────────────────────────────
const redondear2 = n => Math.round(n * 100) / 100;

// unidades: vendidas en sucursales en los últimos diasConsumo días; stock: número o null (sin dato en SIGA).
// consumoDia = unidades ÷ N; consumoMes = consumoDia × 30; sugerido = max(0, ceil(consumoDia × D − stock)).
// El sugerido sale del consumo sin redondear; consumoDia/consumoMes se devuelven con 2 decimales.
function calcularFila({ plu, nombre, unidades, stock }, { diasConsumo, diasCubrir }) {
  const consumoDia = (Number(unidades) || 0) / diasConsumo;
  const stockCentral = stock === null || stock === undefined ? null : Number(stock) || 0;
  const sugerido = Math.max(0, Math.ceil(consumoDia * diasCubrir - (stockCentral ?? 0) - EPSILON));
  return { plu, nombre, consumoDia: redondear2(consumoDia), consumoMes: redondear2(consumoDia * DIAS_MES), stockCentral, sugerido };
}

// Categorías del catálogo + Maps por PLU (nombres, ventas en unidades, stock; PLU sin entrada en stock = sin dato)
// → { params, categorias: [{ id, nombre, presentaciones: [fila] }] }, categorías ordenadas por nombre.
function armarTablero({ categorias, nombres, ventas, stock }, params) {
  const ordenadas = [...(categorias || [])].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  return {
    params,
    categorias: ordenadas.map(c => ({
      id: c.id,
      nombre: c.nombre,
      presentaciones: c.plus.map(plu => calcularFila({
        plu,
        nombre: nombres.get(plu) || `PLU ${plu}`,
        unidades: ventas.get(plu) || 0,
        stock: stock.has(plu) ? stock.get(plu) : null,
      }, params)),
    })),
  };
}

// data/responsables.json: [{ nombre, corto }] (o textos sueltos) → nombres sin repetir.
const nombresResponsables = lista => [...new Set((lista || [])
  .map(r => (typeof r === 'string' ? r : r && r.nombre))
  .filter(Boolean)
  .map(String))];

// ── Órdenes: { ordenes: [{ id, numero, fecha, creado, usuario, notas, estado, lineas }] } ─────────────
const MAX_LINEAS = 200;
const MAX_TEXTO = 500;

function fechaValida(f) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(f ?? ''))) return false;
  const d = new Date(`${f}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === f;
}

function textoCorto(v, campo) {
  const s = String(v ?? '').trim();
  if (s.length > MAX_TEXTO) throw errorHttp(400, `${campo}: máximo ${MAX_TEXTO} caracteres`);
  return s;
}

// Una línea del carrito → línea de la orden. La categoría sale del catálogo, no del cliente.
function validarLinea(x, n, { categoriaDe, validos, vistos }) {
  const l = x || {};
  const plu = String(l.plu ?? '').trim();
  if (!categoriaDe.has(plu)) throw errorHttp(400, `Línea ${n}: el PLU ${plu || '(vacío)'} no está en el catálogo`);
  if (vistos.has(plu)) throw errorHttp(400, `Línea ${n}: el PLU ${plu} está repetido`);
  if (!Number.isInteger(l.cantidad) || l.cantidad <= 0) throw errorHttp(400, `Línea ${n}: la cantidad debe ser un entero mayor a 0`);
  if (!Array.isArray(l.responsables)) throw errorHttp(400, `Línea ${n}: responsables debe ser una lista`);
  const responsables = [...new Set(l.responsables.map(String))];
  const ajeno = responsables.find(r => !validos.has(r));
  if (ajeno !== undefined) throw errorHttp(400, `Línea ${n}: no existe el responsable "${ajeno}"`);
  return {
    plu,
    nombre: textoCorto(l.nombre, `Línea ${n}: nombre`) || `PLU ${plu}`,
    categoria: categoriaDe.get(plu),
    cantidad: l.cantidad,
    responsables,
    notas: textoCorto(l.notas, `Línea ${n}: notas`),
  };
}

// body del carrito { fecha, notas, lineas } → { fecha, notas, lineas } validado.
function validarOrden(body, { categorias, responsables }) {
  const b = body || {};
  if (!fechaValida(b.fecha)) throw errorHttp(400, 'Fecha inválida (AAAA-MM-DD)');
  const notas = textoCorto(b.notas, 'Notas de la orden');
  if (!Array.isArray(b.lineas) || !b.lineas.length) throw errorHttp(400, 'La orden no tiene líneas');
  if (b.lineas.length > MAX_LINEAS) throw errorHttp(400, `Máximo ${MAX_LINEAS} líneas por orden`);
  const ctx = {
    categoriaDe: new Map((categorias || []).flatMap(c => c.plus.map(p => [p, c.nombre]))),
    validos: new Set(nombresResponsables(responsables)),
    vistos: new Set(),
  };
  const lineas = b.lineas.map((l, i) => {
    const linea = validarLinea(l, i + 1, ctx);
    ctx.vistos.add(linea.plu); // ponytail: Set local de esta validación, se muta a propósito
    return linea;
  });
  return { fecha: b.fecha, notas, lineas };
}

function crearOrden(ordenes, datos, { id, ahora, usuario }) {
  const numero = ordenes.reduce((max, o) => Math.max(max, Number(o.numero) || 0), 0) + 1;
  const orden = { id, numero, ...datos, creado: ahora, usuario, estado: 'activa' };
  return { ordenes: [...ordenes, orden], orden };
}

const ordenesRecientes = ordenes => [...ordenes].sort((a, b) => (Number(b.numero) || 0) - (Number(a.numero) || 0));

module.exports = {
  esPlu, normalizar, errorHttp,
  validarCategoria, agregarCategoria, editarCategoria, borrarCategoria,
  PARAMS_DEFAULT, leerParams, validarParams, calcularFila, armarTablero, nombresResponsables,
  MAX_LINEAS, validarOrden, crearOrden, ordenesRecientes,
};
