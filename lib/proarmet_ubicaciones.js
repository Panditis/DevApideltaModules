'use strict';
// Ubicaciones del Depósito Proarmet: secciones físicas con productos asignados. Persistencia propia
// en JSON (no toca SIGA): { ubicaciones: [{ id, idDeposito, nombre, descripcion, creada }],
// asignaciones: [{ idUbicacion, idProducto, cantidad }] }. Las operaciones puras devuelven datos nuevos.
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const NOMBRE_MAX = 40;
const DESCRIPCION_MAX = 200;
const PLU_RE = /^[A-Za-z0-9_-]+$/;
const VACIO = { ubicaciones: [], asignaciones: [] };
const redondear = n => Math.round(n * 1000) / 1000;

function limpiarTextos(body, ubicaciones, idDeposito, idPropio) {
  const nombre = typeof body?.nombre === 'string' ? body.nombre.trim() : '';
  if (!nombre) return { error: 'El nombre es obligatorio' };
  if (nombre.length > NOMBRE_MAX) return { error: `El nombre admite hasta ${NOMBRE_MAX} caracteres` };
  const descripcion = body.descripcion == null ? '' : String(body.descripcion).trim();
  if (descripcion.length > DESCRIPCION_MAX) return { error: `La descripción admite hasta ${DESCRIPCION_MAX} caracteres` };
  const n = nombre.toLowerCase();
  if (ubicaciones.some(u => u.idDeposito === idDeposito && u.id !== idPropio && u.nombre.toLowerCase() === n)) {
    return { error: `Ya existe una ubicación "${nombre}" en este depósito` };
  }
  return { nombre, descripcion };
}

function crear(datos, idDeposito, body, id, creada) {
  const t = limpiarTextos(body, datos.ubicaciones, idDeposito, null);
  if (t.error) return t;
  return { datos: { ...datos, ubicaciones: [...datos.ubicaciones, { id, idDeposito, nombre: t.nombre, descripcion: t.descripcion, creada }] } };
}

function editar(datos, id, body) {
  const u = datos.ubicaciones.find(x => x.id === id);
  if (!u) return { error: 'La ubicación no existe' };
  const t = limpiarTextos(body, datos.ubicaciones, u.idDeposito, id);
  if (t.error) return t;
  return { datos: { ...datos, ubicaciones: datos.ubicaciones.map(x => (x.id === id ? { ...x, nombre: t.nombre, descripcion: t.descripcion } : x)) } };
}

function borrar(datos, id, forzar) {
  if (!datos.ubicaciones.some(x => x.id === id)) return { error: 'La ubicación no existe' };
  const n = datos.asignaciones.filter(a => a.idUbicacion === id).length;
  if (n && !forzar) return { error: `La ubicación tiene ${n} producto(s) asignado(s). Quitalos o confirmá el borrado forzado.` };
  return { datos: { ubicaciones: datos.ubicaciones.filter(x => x.id !== id), asignaciones: datos.asignaciones.filter(a => a.idUbicacion !== id) } };
}

// Valida idProducto/cantidad del body. cantidad 0 = quitar; hasta 3 decimales.
function validarAsignacion(body) {
  const idProducto = String(body?.idProducto ?? '').trim();
  if (!idProducto || idProducto.length > 40 || !PLU_RE.test(idProducto)) return { error: 'idProducto inválido' };
  const raw = body.cantidad;
  const cantidad = (typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '')) ? Number(raw) : NaN;
  if (!Number.isFinite(cantidad) || cantidad < 0) return { error: 'La cantidad debe ser un número mayor o igual a 0' };
  if (redondear(cantidad) !== cantidad) return { error: 'La cantidad admite hasta 3 decimales' };
  return { idProducto, cantidad };
}

// Upsert de la asignación (sin tope de stock: la ubicación es solo un listado de qué va en cada lugar).
function asignar(datos, id, idProducto, cantidad) {
  if (!datos.ubicaciones.some(x => x.id === id)) return { error: 'La ubicación no existe' };
  const resto = datos.asignaciones.filter(a => !(a.idUbicacion === id && a.idProducto === idProducto));
  const asignaciones = cantidad > 0 ? [...resto, { idUbicacion: id, idProducto, cantidad }] : resto;
  return { datos: { ...datos, asignaciones } };
}

// desc: Map idProducto -> descripción (desde Productos).
function vista(datos, idDeposito, desc = new Map()) {
  const ubic = datos.ubicaciones.filter(u => u.idDeposito === idDeposito);
  const ubicaciones = ubic.map(u => {
    const productos = datos.asignaciones.filter(a => a.idUbicacion === u.id)
      .map(a => ({ idProducto: a.idProducto, descripcion: desc.get(a.idProducto) ?? null, cantidad: a.cantidad }));
    return {
      id: u.id, nombre: u.nombre, descripcion: u.descripcion,
      totalProductos: productos.length, totalUnidades: redondear(productos.reduce((s, p) => s + p.cantidad, 0)), productos,
    };
  }).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  return { ubicaciones };
}

// Ids asignados en el depósito (para traer descripciones).
function idsAsignados(datos, idDeposito) {
  const ids = new Set(datos.ubicaciones.filter(u => u.idDeposito === idDeposito).map(u => u.id));
  return [...new Set(datos.asignaciones.filter(a => ids.has(a.idUbicacion)).map(a => a.idProducto))];
}

function sanear(m) {
  const ubicaciones = (Array.isArray(m.ubicaciones) ? m.ubicaciones : [])
    .filter(u => u && typeof u.id === 'string' && Number.isInteger(u.idDeposito) && typeof u.nombre === 'string');
  const ids = new Set(ubicaciones.map(u => u.id));
  const asignaciones = (Array.isArray(m.asignaciones) ? m.asignaciones : [])
    .filter(a => a && ids.has(a.idUbicacion) && typeof a.idProducto === 'string' && PLU_RE.test(a.idProducto) && Number.isFinite(a.cantidad) && a.cantidad > 0);
  return { ubicaciones, asignaciones };
}

// --- Persistencia (mismo patrón que lib/redistribucion_ocultos.js) ---
async function leerArchivo(ruta) {
  let txt;
  try { txt = await fs.readFile(ruta, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return VACIO; throw err; }
  try {
    const m = JSON.parse(txt);
    if (m && typeof m === 'object' && !Array.isArray(m)) return sanear(m);
  } catch { /* cae al log */ }
  // ponytail: corrupto → vacío + copia en .corrupto (una vez); la próxima escritura lo sobrescribe.
  console.error(`[proarmet_ubicaciones] ${path.basename(ruta)} corrupto, se usa vacío`);
  const previo = await fs.readFile(`${ruta}.corrupto`, 'utf8').catch(() => null);
  if (previo !== txt) await fs.writeFile(`${ruta}.corrupto`, txt, 'utf8').catch(() => {});
  return VACIO;
}

const REINTENTABLES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const espera = ms => new Promise(r => setTimeout(r, ms));
async function renombrar(tmp, ruta, intentos = 3) {
  for (let i = 1; ; i++) {
    try { return await fs.rename(tmp, ruta); }
    catch (err) { if (i >= intentos || !REINTENTABLES.has(err.code)) throw err; await espera(30); }
  }
}
async function escribir(ruta, datos) {
  const tmp = `${ruta}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(datos, null, 2), 'utf8');
  try { await renombrar(tmp, ruta); }
  catch (err) { await fs.rm(tmp, { force: true }); throw err; }
}

// ponytail: cola global en proceso; alcanza con un solo server escribiendo el archivo.
let cola = Promise.resolve();
function encolar(tarea) {
  const op = cola.then(tarea);
  cola = op.catch(() => {});
  return op;
}
const leer = ruta => encolar(() => leerArchivo(ruta));
// fn(datos) → { datos, ...extra } se escribe y devuelve; { error } no escribe.
function modificar(ruta, fn) {
  return encolar(async () => {
    const r = fn(await leerArchivo(ruta));
    if (r.error) return r;
    await escribir(ruta, r.datos);
    return r;
  });
}

module.exports = { PLU_RE, crear, editar, borrar, validarAsignacion, asignar, vista, idsAsignados, sanear, leer, modificar };
