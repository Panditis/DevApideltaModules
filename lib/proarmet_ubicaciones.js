'use strict';
// Ubicaciones del Depósito Proarmet: secciones físicas con productos asignados. Persistencia propia
// en JSON (no toca SIGA): { ubicaciones: [{ id, idDeposito, nombre, descripcion, creada }],
// asignaciones: [{ idUbicacion, idProducto }] } (solo PLU, sin cantidad). Las operaciones puras devuelven datos nuevos.
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const NOMBRE_MAX = 40;
const DESCRIPCION_MAX = 200;
const PLU_RE = /^[A-Za-z0-9_-]+$/;
const VACIO = { ubicaciones: [], asignaciones: [] };

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

// Valida y sanea el PLU del body.
function validarAsignacion(body) {
  const idProducto = String(body?.idProducto ?? '').trim();
  if (!idProducto || idProducto.length > 40 || !PLU_RE.test(idProducto)) return { error: 'idProducto inválido' };
  return { idProducto };
}

// Agrega el PLU a la ubicación (idempotente). Un PLU puede estar en varias ubicaciones.
function asignar(datos, id, idProducto) {
  if (!datos.ubicaciones.some(x => x.id === id)) return { error: 'La ubicación no existe' };
  if (datos.asignaciones.some(a => a.idUbicacion === id && a.idProducto === idProducto)) return { datos };
  return { datos: { ...datos, asignaciones: [...datos.asignaciones, { idUbicacion: id, idProducto }] } };
}

// Quita el PLU (ok aunque no estuviera).
function quitar(datos, id, idProducto) {
  if (!datos.ubicaciones.some(x => x.id === id)) return { error: 'La ubicación no existe' };
  return { datos: { ...datos, asignaciones: datos.asignaciones.filter(a => !(a.idUbicacion === id && a.idProducto === idProducto)) } };
}

// desc: Map idProducto -> descripción (desde Productos).
function vista(datos, idDeposito, desc = new Map()) {
  const ubic = datos.ubicaciones.filter(u => u.idDeposito === idDeposito);
  const ubicaciones = ubic.map(u => {
    const productos = datos.asignaciones.filter(a => a.idUbicacion === u.id)
      .map(a => ({ idProducto: a.idProducto, descripcion: desc.get(a.idProducto) ?? null }))
      .sort((a, b) => a.idProducto.localeCompare(b.idProducto, 'es', { numeric: true }));
    return {
      id: u.id, nombre: u.nombre, descripcion: u.descripcion,
      totalProductos: productos.length, productos,
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
  const crudas = (Array.isArray(m.asignaciones) ? m.asignaciones : [])
    .filter(a => a && ids.has(a.idUbicacion) && typeof a.idProducto === 'string' && PLU_RE.test(a.idProducto));
  // Datos viejos pueden traer cantidad: se ignora y se deduplica por ubicación+PLU.
  const vistos = new Set();
  const asignaciones = crudas.flatMap(a => {
    const k = `${a.idUbicacion}|${a.idProducto}`;
    if (vistos.has(k)) return [];
    vistos.add(k);
    return [{ idUbicacion: a.idUbicacion, idProducto: a.idProducto }];
  });
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

module.exports = { PLU_RE, crear, editar, borrar, validarAsignacion, asignar, quitar, vista, idsAsignados, sanear, leer, modificar };
