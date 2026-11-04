'use strict';
// ── Cotizador mayorista · exportación de precios (spec docs/specs/2026-11-03-cotizador-mayorista-exportacion-design.md) ──
// Genera catalogo.csv + version.json para que el usuario los suba A MANO por FTP (no sube nada, no guarda contraseñas).
// Lógica pura en lib/cotizador_mayorista.js. Precios = listados del módulo Precios (listadosVigentes, del router de
// rutas_precios_esquema). Acceso: módulo 'precios' (lib/auth CATALOGO_MODULOS); escrituras además 'precios-config'.
// Datos: data/cotizador_mayorista.json (tabla + subida) y data/cotizador_publicaciones/vNNN/{catalogo.csv,version.json,meta.json}.
//
// Contrato (errores de validación: 200 { error }; sin permiso: 403 { error }; fallo interno: 500 { error }):
//   GET  /api/cotizador-mayorista/tabla        → { filas: [Fila], subida: { host, usuario, ruta }, comandos: [string] }
//        Fila = { cod, seccion, nombre, packQty, bultoQty, incluido, packPlu?, bultoPlu?, manual?, packPrice?, bultoPrice?, planilla? }
//        (orden del array = orden del catálogo; packPlu/bultoPlu vacíos = vínculo automático de SIGA)
//   PUT  /api/cotizador-mayorista/tabla        body { filas: [Fila] } → { filas }      (reemplaza la tabla entera)
//   PUT  /api/cotizador-mayorista/subida       body { host, usuario, ruta } → { subida, comandos }
//   POST /api/cotizador-mayorista/importar     multipart 'file' (.xlsx, hoja apidelta_precios) → { filas, secciones, manuales,
//        descartadas: [nroFila], vinculos: { vinculados, sinVincular: [{ cod, nombre, faltan }], manuales } | null, aviso? }
//   GET  /api/cotizador-mayorista/preview      → { filas: [FilaCsv + origen { pack, bulto }], revisar: [{ cod, nombre, motivos, respaldo }],
//        avisos: [string], errores: [string], diff: { nuevos, quitados, cambiados: [{ cod, nombre, campo, antes, despues, pct }] },
//        ultimaVersion: number|null, productos }
//        origen: 'decision' | 'manual' | 'respaldo' (último exportado o planilla) | null (columna vacía)
//   POST /api/cotizador-mayorista/exportar     → { version, generado, sha256, productos, diff, revisar }   (errores → { error })
//   GET  /api/cotizador-mayorista/historial    → [{ version, generado, usuario, productos, sha256, nuevos, quitados, cambiados }]
//   GET  /api/cotizador-mayorista/publicaciones/:version/catalogo.csv | version.json → descarga (attachment)
//   GET  /api/cotizador-mayorista/comparacion  → { iguales, difieren, sinDato, conDecision, detalle: [...] } (sistema vs planilla)
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const C = require('../lib/cotizador_mayorista');

const PERMISO = 'precios-config';
const HOJA = 'apidelta_precios';

module.exports = function crearRutasCotizadorMayorista({ apiRoute, DATA_DIR, listadosVigentes, tienePermiso }) {
  const router = express.Router();
  const TABLA_PATH = path.join(DATA_DIR, 'cotizador_mayorista.json');
  const PUB_DIR = path.join(DATA_DIR, 'cotizador_publicaciones');
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

  const leerTabla = () => {
    if (!fs.existsSync(TABLA_PATH)) return { filas: [], subida: { ...C.SUBIDA_DEFECTO } };
    const t = JSON.parse(fs.readFileSync(TABLA_PATH, 'utf8')); // corrupto → throw (500), no se pisa con vacío
    return { filas: Array.isArray(t.filas) ? t.filas : [], subida: { ...C.SUBIDA_DEFECTO, ...t.subida } };
  };
  // Escritura atómica (tmp + rename) con copia .bak de la versión anterior.
  const guardarTabla = t => {
    const tmp = `${TABLA_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(t, null, 2), 'utf8');
    if (fs.existsSync(TABLA_PATH)) fs.copyFileSync(TABLA_PATH, `${TABLA_PATH}.bak`);
    fs.renameSync(tmp, TABLA_PATH);
  };
  const versiones = () => (fs.existsSync(PUB_DIR) ? fs.readdirSync(PUB_DIR, { withFileTypes: true }) : [])
    .filter(d => d.isDirectory()).map(d => /^v(\d+)$/.exec(d.name)).filter(Boolean).map(m => Number(m[1])).sort((a, b) => a - b);
  const dirVersion = v => path.join(PUB_DIR, `v${String(v).padStart(3, '0')}`);
  const ultima = () => {
    const v = versiones().pop();
    if (v == null) return { version: null, filas: [] };
    return { version: v, filas: C.parsearCsv(fs.readFileSync(path.join(dirVersion(v), 'catalogo.csv'), 'utf8')) };
  };
  const usuarioDe = req => (req.session && req.session.user && req.session.user.usuario) || null;
  const conPermiso = handler => (req, res, next) => (tienePermiso(req.session && req.session.user, PERMISO)
    ? handler(req, res, next) : res.status(403).json({ error: 'Sin permiso para editar o exportar el cotizador mayorista' }));

  // Respaldo por cod: la última publicación; antes de la primera, los precios de la planilla importada.
  const respaldosDe = (tabla, anterior) => (anterior.version != null
    ? new Map(anterior.filas.map(f => [f.cod, f]))
    : new Map(tabla.filas.filter(f => f.planilla).map(f => [f.cod, f.planilla])));

  async function vistaPrevia() {
    const listados = await listadosVigentes();
    const tabla = leerTabla(), anterior = ultima(); // leídos después del await
    const r = C.armarCatalogo({ tabla, indice: C.indicePrecios(listados), respaldos: respaldosDe(tabla, anterior) });
    return { ...r, diff: C.diffCatalogo(anterior.filas, r.filas), ultimaVersion: anterior.version, productos: r.filas.length };
  }
  const sinOrigen = filas => filas.map(({ origen: _o, ...f }) => f);

  router.get('/api/cotizador-mayorista/tabla', apiRoute(async () => {
    const t = leerTabla();
    return { ...t, comandos: C.comandosSubida(t.subida) };
  }));

  router.put('/api/cotizador-mayorista/tabla', conPermiso(apiRoute(async (req) => {
    let filas;
    try { filas = C.validarTabla((req.body || {}).filas); } catch (err) { return { error: err.message }; }
    guardarTabla({ ...leerTabla(), filas });
    return { filas };
  })));

  router.put('/api/cotizador-mayorista/subida', conPermiso(apiRoute(async (req) => {
    let subida;
    try { subida = C.validarSubida(req.body); } catch (err) { return { error: err.message }; }
    guardarTabla({ ...leerTabla(), subida });
    return { subida, comandos: C.comandosSubida(subida) };
  })));

  router.post('/api/cotizador-mayorista/importar', conPermiso((req, res, next) => upload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: `Archivo inválido: ${err.message}` });
    return next();
  })), apiRoute(async (req) => {
    if (!req.file) return { error: 'Falta el archivo (campo file)' };
    let rows;
    try {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      if (!wb.Sheets[HOJA]) return { error: `El archivo no tiene la hoja ${HOJA}` };
      rows = XLSX.utils.sheet_to_json(wb.Sheets[HOJA], { defval: '' });
    } catch (err) {
      console.error('[cotizador-mayorista] importar xlsx:', err.message);
      return { error: 'No se pudo leer el Excel' };
    }
    const { filas: crudas, descartadas } = C.filasDesdePlanilla(rows);
    let filas;
    try { filas = C.validarTabla(crudas); } catch (err) { return { error: err.message }; }
    let vinculos = null, aviso;
    try { vinculos = C.resumenVinculos(filas, C.indicePrecios(await listadosVigentes())); } catch (err) {
      console.error('[cotizador-mayorista] vínculos al importar:', err.message);
      aviso = 'Tabla importada; no se pudieron consultar los vínculos de SIGA';
    }
    guardarTabla({ ...leerTabla(), filas });
    return { filas: filas.length, secciones: new Set(filas.map(f => f.seccion)).size, manuales: filas.filter(f => f.manual).length,
      descartadas, vinculos, ...(aviso ? { aviso } : {}) };
  }));

  router.get('/api/cotizador-mayorista/preview', apiRoute(vistaPrevia));

  // Escribe vNNN.tmp completo y recién ahí lo renombra: si algo falla, la publicación anterior queda intacta.
  router.post('/api/cotizador-mayorista/exportar', conPermiso(apiRoute(async (req) => {
    const p = await vistaPrevia();
    if (p.errores.length) return { error: `No se puede exportar: ${p.errores.join('; ')}` };
    if (!p.filas.length) return { error: 'No hay productos para exportar' };
    const version = (versiones().pop() || 0) + 1;
    const csv = C.generarCsv(sinOrigen(p.filas));
    const ver = C.generarVersion({ version, csv, productos: p.filas.length, usuario: usuarioDe(req) });
    const meta = { ...ver, diff: p.diff, revisar: p.revisar, avisos: p.avisos };
    const destino = dirVersion(version), tmp = `${destino}.tmp`;
    try {
      fs.mkdirSync(PUB_DIR, { recursive: true });
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp);
      fs.writeFileSync(path.join(tmp, 'catalogo.csv'), csv, 'utf8');
      fs.writeFileSync(path.join(tmp, 'version.json'), JSON.stringify(ver, null, 2) + '\n', 'utf8');
      fs.writeFileSync(path.join(tmp, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
      fs.renameSync(tmp, destino);
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true });
      console.error('[cotizador-mayorista] exportar v%d:', version, err.message);
      throw new Error('No se pudo guardar la exportación; la anterior quedó intacta');
    }
    return { version, generado: ver.generado, sha256: ver.sha256, productos: ver.productos, diff: p.diff, revisar: p.revisar };
  })));

  router.get('/api/cotizador-mayorista/historial', apiRoute(async () => versiones().reverse().map(v => {
    const m = JSON.parse(fs.readFileSync(path.join(dirVersion(v), 'meta.json'), 'utf8'));
    const d = m.diff || {};
    return { version: m.version, generado: m.generado, usuario: m.usuario, productos: m.productos, sha256: m.sha256,
      nuevos: (d.nuevos || []).length, quitados: (d.quitados || []).length, cambiados: (d.cambiados || []).length };
  })));

  router.get('/api/cotizador-mayorista/publicaciones/:version/:archivo', (req, res) => {
    const v = Number(req.params.version), archivo = req.params.archivo;
    if (!Number.isInteger(v) || v < 1 || !['catalogo.csv', 'version.json'].includes(archivo)) return res.status(400).json({ error: 'Versión o archivo inválido' });
    const ruta = path.join(dirVersion(v), archivo);
    if (!fs.existsSync(ruta)) return res.status(404).json({ error: `No existe la versión ${v}` });
    return res.download(ruta, archivo);
  });

  router.get('/api/cotizador-mayorista/comparacion', apiRoute(async () => {
    const indice = C.indicePrecios(await listadosVigentes());
    return C.compararConPlanilla(leerTabla().filas, indice);
  }));

  return router;
};
