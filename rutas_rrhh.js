'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const rrhhRopa = require('./lib/rrhh_ropa');
const rrhhAusencias = require('./lib/rrhh_ausencias');

// ── Rutas del módulo RRHH ────────────────────────────────────────────────────
// Extraídas de server.js sin cambios de comportamiento: mismas rutas, mismo orden
// relativo entre ellas y mismos handlers. Los bloques movidos conservan la
// indentación original a propósito.
//
// rrhh_ropa.js y rrhh_ausencias.js son lógica pura sin estado: se requieren
// directo. Lo que vive en server.js (disco, DATA_DIR) entra por deps.
//
// Los dos submódulos (relevamiento de ropa y ausencias) viajan juntos porque
// comparten el prefijo /api/rrhh y el sub-hub /rrhh, pero no comparten nada de
// estado: cada uno tiene su JSON y sus helpers. Todo lo del bloque
// —leerRopa/guardarRopa con su SSE (ropaSuscriptores, avisarRopa, conResumen),
// rutaRopa, buscarIndice, y del lado de ausencias leerAusencias/guardarAusencias,
// semillaAusencias, normalizarDocAusencias, parsearBajada, rutaAusencias,
// respuestaAusencias, uploadAusencias— se usa sólo acá.
module.exports = function crearRutasRrhh(deps) {
  const { leerJSON, guardarJSON, DATA_DIR } = deps;
  const router = express.Router();

// RRHH: sub-hub con los módulos del área y, colgando de él, cada submódulo.
router.get('/rrhh',                    (_req, res) => res.sendFile(path.join(__dirname, 'public', 'rrhh.html')));
router.get('/rrhh/relevamiento-ropa',  (_req, res) => res.sendFile(path.join(__dirname, 'public', 'rrhh_relevamiento_ropa.html')));
router.get('/rrhh_relevamiento_ropa.js', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'rrhh_relevamiento_ropa.js')));
router.get('/rrhh/ausencias',          (_req, res) => res.sendFile(path.join(__dirname, 'public', 'rrhh_ausencias_dashboard.html')));
router.get('/rrhh_ausencias.js',       (_req, res) => res.sendFile(path.join(__dirname, 'lib', 'rrhh_ausencias.js')));
router.get('/rrhh_ausencias_front.js', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'rrhh_ausencias_front.js')));

// ── RRHH · Relevamiento de ropa de trabajo ─────────────────────────────────────
// Un único JSON con el catálogo de prendas y la ficha de cada empleado. Toda
// escritura pasa por rrhh_ropa.normalizarDocumento (trust boundary) antes de
// persistir, así el archivo nunca queda con empleados desalineados del catálogo.
const RRHH_ROPA_PATH = path.join(DATA_DIR, 'relevamientoRopa', 'relevamiento_ropa.json');

function leerRopa() {
  return rrhhRopa.normalizarDocumento(leerJSON(RRHH_ROPA_PATH, { prendas: [], empleados: [] }));
}
function guardarRopa(doc) {
  const limpio = rrhhRopa.normalizarDocumento(doc);
  fs.mkdirSync(path.dirname(RRHH_ROPA_PATH), { recursive: true });
  guardarJSON(RRHH_ROPA_PATH, limpio);
  avisarRopa(limpio);
  return limpio;
}
// Pestañas abiertas en el relevamiento (SSE). Toda escritura pasa por guardarRopa,
// así que avisar desde ahí alcanza para que las demás vean el cambio sin recargar.
const ropaSuscriptores = new Set();
function avisarRopa(doc) {
  if (!ropaSuscriptores.size) return;
  const evento = `data: ${JSON.stringify(conResumen(doc))}\n\n`;
  for (const res of ropaSuscriptores) {
    try { res.write(evento); } catch { ropaSuscriptores.delete(res); }
  }
}
// El front siempre recibe el documento completo + su resumen: es chico (decenas
// de empleados) y así no hay que reconciliar estado parcial después de cada ABM.
function conResumen(doc) {
  return { ...doc, resumen: rrhhRopa.resumen(doc) };
}
// Lo que tira el módulo puro son errores de validación del input → 400, no 500.
function rutaRopa(fn) {
  return (req, res) => {
    try { res.json(conResumen(fn(req))); }
    catch (err) { console.error(err.message); res.status(400).json({ error: err.message }); }
  };
}
function buscarIndice(lista, id, queEs) {
  const i = lista.findIndex(x => x.id === id);
  if (i < 0) throw new Error(`No existe ${queEs} con id "${id}".`);
  return i;
}

router.get('/api/rrhh/ropa', rutaRopa(() => leerRopa()));

// Stream de cambios. Manda el documento entero en cada aviso (es chico) para que el
// front no tenga que reconciliar nada: reemplaza su copia y vuelve a pintar.
router.get('/api/rrhh/ropa/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(conResumen(leerRopa()))}\n\n`);
  ropaSuscriptores.add(res);
  // Sin tráfico, un proxy o el propio navegador cortan la conexión a los pocos minutos.
  const latido = setInterval(() => res.write(': latido\n\n'), 25000);
  req.on('close', () => { clearInterval(latido); ropaSuscriptores.delete(res); });
});

router.post('/api/rrhh/ropa/empleados', rutaRopa(req => {
  const doc = leerRopa();
  const nuevo = rrhhRopa.normalizarEmpleado(req.body || {}, doc.prendas);
  nuevo.id = rrhhRopa.siguienteIdEmpleado(doc.empleados);
  return guardarRopa({ ...doc, empleados: [...doc.empleados, nuevo] });
}));

router.put('/api/rrhh/ropa/empleados/:id', rutaRopa(req => {
  const doc = leerRopa();
  const i = buscarIndice(doc.empleados, req.params.id, 'el empleado');
  const previo = doc.empleados[i];
  // El form de edición no manda "destacado": se conserva el que ya tenía la fila.
  const body = { destacado: previo.destacado, ...(req.body || {}) };
  const editado = { ...rrhhRopa.normalizarEmpleado(body, doc.prendas), id: previo.id };
  return guardarRopa({ ...doc, empleados: doc.empleados.map((e, j) => (j === i ? editado : e)) });
}));

// Resaltado de fila: estado compartido, se togglea con un click en la tabla.
router.patch('/api/rrhh/ropa/empleados/:id/destacado', rutaRopa(req => {
  const doc = leerRopa();
  const i = buscarIndice(doc.empleados, req.params.id, 'el empleado');
  const destacado = (req.body || {}).destacado === true;
  return guardarRopa({ ...doc, empleados: doc.empleados.map((e, j) => (j === i ? { ...e, destacado } : e)) });
}));

router.delete('/api/rrhh/ropa/empleados/:id', rutaRopa(req => {
  const doc = leerRopa();
  buscarIndice(doc.empleados, req.params.id, 'el empleado');
  return guardarRopa({ ...doc, empleados: doc.empleados.filter(e => e.id !== req.params.id) });
}));

router.post('/api/rrhh/ropa/prendas', rutaRopa(req => {
  const doc = leerRopa();
  const nueva = rrhhRopa.normalizarPrenda({ nombre: (req.body || {}).nombre }, doc.prendas.map(p => p.id));
  // normalizarDocumento le agrega la prenda vacía a cada empleado.
  return guardarRopa({ ...doc, prendas: [...doc.prendas, nueva] });
}));

router.put('/api/rrhh/ropa/prendas/:id', rutaRopa(req => {
  const doc = leerRopa();
  const i = buscarIndice(doc.prendas, req.params.id, 'la prenda');
  // Sólo se renombra: cambiar el id dejaría huérfanas las fichas de los empleados.
  const editada = rrhhRopa.normalizarPrenda({ id: doc.prendas[i].id, nombre: (req.body || {}).nombre });
  return guardarRopa({ ...doc, prendas: doc.prendas.map((p, j) => (j === i ? editada : p)) });
}));

router.delete('/api/rrhh/ropa/prendas/:id', rutaRopa(req => {
  const doc = leerRopa();
  buscarIndice(doc.prendas, req.params.id, 'la prenda');
  return guardarRopa({ ...doc, prendas: doc.prendas.filter(p => p.id !== req.params.id) });
}));

// ── RRHH · Ausencias ───────────────────────────────────────────────────────────
// Un único JSON con todos los registros de ausencia (el histórico y lo que se va
// sumando bajada tras bajada), la bitácora de importaciones y el mapeo de códigos
// del reloj → tipo de licencia. El apartado "Histórico" mira todo el archivo; el
// de "Al día" mira el período que se está cargando. Misma agregación para los dos.
const RRHH_AUSENCIAS_DIR  = path.join(DATA_DIR, 'ausencias');
const RRHH_AUSENCIAS_PATH = path.join(RRHH_AUSENCIAS_DIR, 'ausencias.json');
// Semilla: la planilla que armó RRHH a mano antes de que existiera el módulo.
const RRHH_AUSENCIAS_SEMILLA = path.join(RRHH_AUSENCIAS_DIR, 'Ausencias_Resumen_2025-2026.xlsx');
const RRHH_AUSENCIAS_HOJA_SEMILLA = 'Detalle Ausencias';

const uploadAusencias = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function docAusenciasVacio() {
  return { registros: [], importaciones: [], mapeo: {} };
}

// La primera lectura levanta el histórico del xlsx. Si la planilla no está (o no
// se puede leer) arranca vacío: el módulo sigue sirviendo para cargar bajadas.
function semillaAusencias() {
  try {
    if (!fs.existsSync(RRHH_AUSENCIAS_SEMILLA)) return [];
    const wb = XLSX.readFile(RRHH_AUSENCIAS_SEMILLA, { cellDates: true });
    const hoja = wb.Sheets[RRHH_AUSENCIAS_HOJA_SEMILLA] || wb.Sheets[wb.SheetNames[0]];
    if (!hoja) return [];
    return rrhhAusencias.parsearDetalleHistorico(XLSX.utils.sheet_to_json(hoja, { header: 1, raw: true, defval: '' }));
  } catch (err) {
    console.error('Ausencias: no se pudo leer la planilla semilla:', err.message);
    return [];
  }
}

function normalizarDocAusencias(doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const mapeo = {};
  for (const [k, v] of Object.entries(d.mapeo && typeof d.mapeo === 'object' ? d.mapeo : {})) {
    const cod = rrhhAusencias.texto(k);
    if (cod) mapeo[cod] = rrhhAusencias.texto(v);
  }
  return {
    registros: rrhhAusencias.normalizarRegistros(d.registros),
    importaciones: (Array.isArray(d.importaciones) ? d.importaciones : []).map(i => ({
      id:       rrhhAusencias.texto(i.id),
      archivo:  rrhhAusencias.texto(i.archivo),
      periodo:  { desde: rrhhAusencias.aISO((i.periodo || {}).desde), hasta: rrhhAusencias.aISO((i.periodo || {}).hasta) },
      fecha:    rrhhAusencias.texto(i.fecha),
      usuario:  rrhhAusencias.texto(i.usuario),
      cantidad: Number(i.cantidad) || 0,
    })).filter(i => i.id),
    mapeo,
  };
}

function guardarAusencias(doc) {
  const limpio = normalizarDocAusencias(doc);
  fs.mkdirSync(RRHH_AUSENCIAS_DIR, { recursive: true });
  guardarJSON(RRHH_AUSENCIAS_PATH, limpio);
  return limpio;
}

function leerAusencias() {
  if (!fs.existsSync(RRHH_AUSENCIAS_PATH)) {
    const registros = semillaAusencias();
    const inicial = { ...docAusenciasVacio(), registros };
    if (registros.length) {
      inicial.importaciones = [{
        id: 'historico',
        archivo: path.basename(RRHH_AUSENCIAS_SEMILLA),
        periodo: rrhhAusencias.resumen(registros).periodo,
        fecha: new Date().toISOString(),
        usuario: 'semilla',
        cantidad: registros.length,
      }];
    }
    return guardarAusencias(inicial);
  }
  return normalizarDocAusencias(leerJSON(RRHH_AUSENCIAS_PATH, docAusenciasVacio()));
}

// El front recibe el documento entero (cientos de filas, nada pesado) y arma sus
// propias vistas con el mismo módulo puro: así histórico y al-día no divergen.
function respuestaAusencias(doc) {
  return { ...doc, tipos: rrhhAusencias.resumen(doc.registros).porTipo.map(t => t.clave) };
}

// Lo que tira el módulo puro son errores de validación del input → 400, no 500.
function rutaAusencias(fn) {
  return (req, res) => {
    try { res.json(respuestaAusencias(fn(req))); }
    catch (err) { console.error(err.message); res.status(400).json({ error: err.message }); }
  };
}

router.get('/api/rrhh/ausencias', rutaAusencias(() => leerAusencias()));

// Guarda el mapeo código → tipo sin tocar los registros ya cargados: reclasificar
// el pasado es otra cosa, acá sólo se define cómo se leen las próximas bajadas.
router.put('/api/rrhh/ausencias/mapeo', rutaAusencias(req => {
  const doc = leerAusencias();
  return guardarAusencias({ ...doc, mapeo: (req.body || {}).mapeo || {} });
}));

// Parsea la bajada que viene en el multipart y la cruza con lo ya cargado. Es el
// único lugar donde se decide qué trae una planilla: tanto la previsualización
// como la confirmación pasan por acá, así lo que se guarda es exactamente lo que
// se mostró (el cliente nunca manda registros, sólo el archivo).
function parsearBajada(req) {
  if (!req.file) throw new Error('No llegó ningún archivo.');
  const doc = leerAusencias();
  const nombre = req.file.originalname || 'bajada.xlsx';
  // El mapeo puede venir editado en el formulario sin haberse guardado todavía.
  let mapeo = doc.mapeo;
  if (req.body && req.body.mapeo) {
    try { mapeo = JSON.parse(req.body.mapeo); }
    catch { throw new Error('El mapeo de códigos no es un JSON válido.'); }
  }
  // El año no está en la planilla (sólo día y mes): sale del nombre del archivo,
  // y el front lo deja corregir a mano antes de confirmar.
  const anio = Number(req.body && req.body.anio) || rrhhAusencias.anioDesdeNombre(nombre) || new Date().getFullYear();
  const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
  const hoja = wb.Sheets[wb.SheetNames[0]];
  if (!hoja) throw new Error('El archivo no tiene hojas.');
  const matriz = XLSX.utils.sheet_to_json(hoja, { header: 1, raw: false, defval: '' });
  const parsed = rrhhAusencias.parsearFichajes(matriz, { anio, mapeo });

  const yaCargadas = new Set(doc.registros.map(rrhhAusencias.clave));
  const registros = parsed.registros.map(r => ({ ...r, duplicado: yaCargadas.has(rrhhAusencias.clave(r)) }));
  return { ...parsed, doc, mapeo, anio, archivo: nombre, registros, duplicados: registros.filter(r => r.duplicado).length };
}

// Previsualización: muestra lo que se importaría, sin guardar nada.
router.post('/api/rrhh/ausencias/importar', uploadAusencias.single('archivo'), (req, res) => {
  try {
    const { doc, ...vista } = parsearBajada(req);
    res.json(vista);
  } catch (err) { console.error(err.message); res.status(400).json({ error: err.message }); }
});

// Confirmación: vuelve a subir la misma planilla y la pasa al histórico. Los
// duplicados (misma persona, misma fecha, mismo tipo) se descartan siempre, así
// reimportar una bajada solapada no infla los números. Cada registro queda
// sellado con el id de su importación para poder deshacerla entera.
router.post('/api/rrhh/ausencias/importaciones', uploadAusencias.single('archivo'), rutaAusencias(req => {
  const { doc, mapeo, archivo, registros, sinMapear } = parsearBajada(req);
  if (sinMapear.length) throw new Error(`Faltan clasificar ${sinMapear.length} código(s): ${sinMapear.join(', ')}.`);

  const impId = `imp-${Date.now()}`;
  const aGuardar = registros
    .filter(r => !r.duplicado)
    .map(r => {
      const { duplicado, ...limpio } = r;
      return rrhhAusencias.normalizarRegistro({ ...limpio, id: `${impId}|${r.id}`, impId });
    });
  if (!aGuardar.length) throw new Error('No hay ausencias nuevas para guardar: todas ya estaban en el histórico.');

  return guardarAusencias({
    ...doc,
    // El mapeo usado en la importación queda guardado: es el que hay que repetir.
    mapeo,
    registros: [...doc.registros, ...aGuardar],
    importaciones: [...doc.importaciones, {
      id: impId,
      archivo,
      periodo: rrhhAusencias.resumen(aGuardar).periodo,
      fecha: new Date().toISOString(),
      usuario: (req.session && req.session.user && (req.session.user.nombre || req.session.user.usuario)) || '',
      cantidad: aGuardar.length,
    }],
  });
}));

// Deshacer una importación: saca sus registros y su entrada de la bitácora. El
// histórico semilla no se borra desde acá (se volvería a sembrar solo).
router.delete('/api/rrhh/ausencias/importaciones/:id', rutaAusencias(req => {
  const id = rrhhAusencias.texto(req.params.id);
  const doc = leerAusencias();
  if (!doc.importaciones.some(i => i.id === id)) throw new Error(`No existe la importación "${id}".`);
  if (id === 'historico') throw new Error('El histórico importado de la planilla original no se puede borrar desde acá.');
  return guardarAusencias({
    ...doc,
    registros: doc.registros.filter(r => r.impId !== id),
    importaciones: doc.importaciones.filter(i => i.id !== id),
  });
}));

  return router;
};
