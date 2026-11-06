'use strict';
// ── Cotizador mayorista · exportación de precios (spec docs/specs/2026-11-03-cotizador-mayorista-exportacion-design.md) ──
// Genera catalogo.csv + version.json y los publica por FTP (POST .../publicar) o a mano con los comandos curl (respaldo).
// Config FTP: data/cotizador_ftp.json (ignorado por git), lo edita el usuario a mano; si no existe se crea con esta plantilla:
//   { "host": "srva103.controlvps.com", "puerto": 21, "usuario": "Apdftp", "password": "", "rutaRemota": "/web/cotizador", "secure": false }
//   secure: false = FTP común, true = FTPS explícito. La password nunca sale por API, logs, meta.json ni mensajes de error.
// Lógica pura en lib/cotizador_mayorista.js. Precios = listados del módulo Precios (listadosVigentes, del router de
// rutas_precios_esquema). Acceso: módulo 'precios' (lib/auth CATALOGO_MODULOS); escrituras además 'precios-config'.
// Datos: data/cotizador_mayorista.json (tabla + subida) y data/cotizador_publicaciones/vNNN/{catalogo.csv,version.json,meta.json}.
//
// Contrato (errores de validación: 200 { error }; sin permiso: 403 { error }; fallo interno: 500 { error }):
//   GET  /api/cotizador-mayorista/tabla        → { filas: [Fila], subida: { host, usuario, ruta }, comandos: [string] }
//        Fila = { cod, seccion, nombre, packQty, bultoQty, incluido, packPlu?, bultoPlu?, manual?, packPrice?, bultoPrice?, planilla? }
//        (orden del array = orden del catálogo; packPlu/bultoPlu vacíos = vínculo automático de SIGA)
//        Fila no manual suma modoPack: 'plu' | 'descuento' | 'ninguno' (ausente en filas viejas = 'plu') y, sólo en 'descuento',
//        descuentoPack: number (0 < x < 100). packQty = cantidad mínima del pack: en 'plu' como siempre, en 'descuento' la carga
//        el usuario (requerida), en 'ninguno' se ignora. Las filas manuales no llevan modoPack (precios fijos).
//   PUT  /api/cotizador-mayorista/tabla        body { filas: [Fila] } → { filas }      (reemplaza la tabla entera)
//        modoPack ausente/'' → 'plu'; otro valor → { error: 'Fila N: modoPack inválido (plu, descuento o ninguno)' };
//        descuentoPack acepta número o texto con coma ("12,5"); vacío, ≤0, ≥100 o no numérico → { error: 'Fila N: descuentoPack inválido (...)' }
//   PUT  /api/cotizador-mayorista/subida       body { host, usuario, ruta } → { subida, comandos }
//   POST /api/cotizador-mayorista/importar     multipart 'file' (.xlsx, hoja apidelta_precios) → { filas, secciones, manuales,
//        descartadas: [nroFila], vinculos: { vinculados, sinVincular: [{ cod, nombre, faltan }], manuales } | null, aviso? }
//   GET  /api/cotizador-mayorista/preview      → { filas: [FilaCsv + origen { pack, bulto }], revisar: [{ cod, nombre, motivos, respaldo }],
//        avisos: [string], errores: [string], diff: { nuevos, quitados, cambiados: [{ cod, nombre, campo, antes, despues, pct }] },
//        ultimaVersion: number|null, productos }
//        origen: 'decision' | 'manual' | 'descuento' (sólo pack) | 'respaldo' (último exportado o planilla) | null (columna vacía)
//        Cada fila armada trae además modoPack ('plu'|'descuento'|'ninguno') y, en 'descuento',
//        descuento: { pct, minoristaFinal, ivaPct, minoristaNeto, pack } (pack = Math.round(minoristaNeto × (1 − pct/100)),
//        minoristaNeto = minoristaFinal / (1 + ivaPct/100), minorista con la decisión vigente del producto). Filas que salen del
//        respaldo completo (cantidad no reconocida) no traen esos campos. 'descuento' sin packQty o sin minorista decidido →
//        mensaje en errores (bloquea exportar). 'ninguno' → pack_qty/pack_price '' sin aviso ni revisar.
//        El CSV exportado no cambia: sólo cod,seccion,nombre,pack_qty,pack_price,bulto_qty,bulto_price.
//        importar: fila no manual sin 'Codigo Pack' ni pack_price → modoPack 'ninguno'; si no, 'plu' (nunca 'descuento').
//        comparacion: pack en 'ninguno' no figura; en 'descuento' sistema = pack calculado, origen 'descuento', plu null.
//   POST /api/cotizador-mayorista/autocompletar (permiso precios-config) → { filas: [Fila], completadas: [{ cod, nombre, tipo, plu, origen }],
//        sinVincular: [{ cod, nombre, faltan: ['pack'|'bulto'], motivo? }] }  (guarda la tabla). Completa packPlu/bultoPlu vacíos de filas
//        no manuales con cantidad (pack sólo en modoPack 'plu'): vínculo SIGA o, si no hay, presentación mayorista de fraccionado
//        de Precios (cod = granel o cualquier presentación del grupo) o, si tampoco, producto de SIGA (cualquier rubro) cuya
//        fórmula activa es sólo el cod (nombre Pack/Bulto/Caja manda; si no, único → bulto, dos → menor pack / mayor bulto).
//        No pisa PLU ya cargados. completadas[].origen: 'sigaVinculo' | 'presentacion' | 'formula'. sinVincular[].motivo
//        (opcional): candidatos por fórmula ambiguos, no asignados. Si la consulta por fórmula falla, sigue sin esa fuente.
//        Limitación: los PLU por fórmula no son vínculos de Precios (no están en el índice): su precio en el catálogo sale
//        del respaldo (último exportado) con motivo "PLU X sin precio en el módulo"; no se inventan precios.
//   POST /api/cotizador-mayorista/exportar     → { version, generado, sha256, productos, diff, revisar }   (errores → { error })
//   GET  /api/cotizador-mayorista/historial    → [{ version, generado, usuario, productos, sha256, nuevos, quitados, cambiados,
//        publicado: { fecha, ok, error? } | null, metaIlegible? }]   (meta.json corrupto → fila con nulls y metaIlegible: true)
//   GET  /api/cotizador-mayorista/publicar/config → { host, puerto, usuario, rutaRemota, secure, tienePassword, aviso? }
//        (aviso si recién se creó el archivo con la plantilla)
//   POST /api/cotizador-mayorista/publicaciones/:version/publicar  (permiso precios-config)
//        → 200 { ok: true, version, subidos: ['catalogo.csv','version.json'], publicadoEn }
//        → 200 { error, version, subidos } si falla la subida (sin password, no conecta, login, carpeta, tamaño); { error } si falta password
//        → 400 versión inválida · 404 versión inexistente · 409 ya hay una publicación en curso · 403 sin permiso
//        Sube catalogo.csv y después version.json, cada uno como .tmp + verificación de tamaño + rename. Resultado en meta.json.publicado.
//   GET  /api/cotizador-mayorista/publicaciones/:version/catalogo.csv | version.json → descarga (attachment)
//   GET  /api/cotizador-mayorista/comparacion  → { iguales, difieren, sinDato, conDecision, detalle: [...] } (sistema vs planilla)
//   GET  /api/cotizador-mayorista/codigos.xlsx → descarga cotizador_codigos_AAAA-MM-DD.xlsx (hoja 'codigos', sólo lectura)
//        Columnas: Codigo, Producto, CodigoPack, Cantidad pack, CodigoBulto, CantidadBulto. Una fila por fila de la tabla
//        (incluidas o no), orden del catálogo. PLU = explícito o vínculo SIGA; manual sin PLU; pack vacío en 'ninguno'/'descuento'.
//        Cantidad normalizada ("12u", "10kg") o el texto crudo si no se reconoce. Si listadosVigentes falla: sólo PLU explícitos.
//        Error al generar → 500 { error }.
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const C = require('../lib/cotizador_mayorista');

const PERMISO = 'precios-config';
const HOJA = 'apidelta_precios';

const FTP_TIMEOUT_MS = 30000;

module.exports = function crearRutasCotizadorMayorista({ apiRoute, DATA_DIR, listadosVigentes, tienePermiso, usosComoFormula = async () => [],
  // ponytail: basic-ftp 5.x a propósito; el aviso de npm audit (DoS en Client.list()) no aplica, no usamos list()
  crearClienteFtp = () => new (require('basic-ftp').Client)(FTP_TIMEOUT_MS) }) {
  const router = express.Router();
  const FTP_PATH = path.join(DATA_DIR, 'cotizador_ftp.json');
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

  router.post('/api/cotizador-mayorista/autocompletar', conPermiso(apiRoute(async () => {
    const indice = C.indicePrecios(await listadosVigentes());
    const tabla = leerTabla(); // leída después del await
    const sinSiga = C.autocompletarVinculos(tabla.filas, indice).sinVincular.map(s => s.cod).filter(c => /^\d{1,12}$/.test(c));
    let usos = [];
    if (sinSiga.length) {
      try { usos = await usosComoFormula(sinSiga); } catch (err) { console.error('[cotizador-mayorista] usosComoFormula falló, sigo sin esa fuente:', err.message); }
    }
    const r = C.autocompletarVinculos(tabla.filas, indice, C.candidatosPorFormula(usos));
    let filas;
    try { filas = C.validarTabla(r.filas); } catch (err) { return { error: err.message }; }
    guardarTabla({ ...tabla, filas });
    return { filas, completadas: r.completadas, sinVincular: r.sinVincular };
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

  // meta.json corrupto o ausente → null (no rompe el historial).
  const leerMeta = v => {
    try { return JSON.parse(fs.readFileSync(path.join(dirVersion(v), 'meta.json'), 'utf8')); } catch (err) {
      console.error('[cotizador-mayorista] meta.json v%d ilegible:', v, err.message);
      return null;
    }
  };
  const guardarMeta = (v, meta) => {
    const ruta = path.join(dirVersion(v), 'meta.json'), tmp = `${ruta}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8');
    fs.renameSync(tmp, ruta);
  };

  router.get('/api/cotizador-mayorista/historial', apiRoute(async () => versiones().reverse().map(v => {
    const m = leerMeta(v);
    if (!m) return { version: v, generado: null, usuario: null, productos: null, sha256: null, nuevos: 0, quitados: 0, cambiados: 0,
      publicado: null, metaIlegible: true };
    const d = m.diff || {};
    return { version: m.version, generado: m.generado, usuario: m.usuario, productos: m.productos, sha256: m.sha256,
      nuevos: (d.nuevos || []).length, quitados: (d.quitados || []).length, cambiados: (d.cambiados || []).length,
      publicado: m.publicado || null };
  })));

  // ── Publicar por FTP ──
  const leerFtp = () => {
    if (!fs.existsSync(FTP_PATH)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FTP_PATH, JSON.stringify(C.FTP_PLANTILLA, null, 2) + '\n', 'utf8');
      return { cfg: C.normalizarFtp(C.FTP_PLANTILLA), creado: true };
    }
    try { return { cfg: C.normalizarFtp(JSON.parse(fs.readFileSync(FTP_PATH, 'utf8'))), creado: false }; } catch {
      throw new Error('data/cotizador_ftp.json no es un JSON válido: corregilo a mano');
    }
  };
  const AVISO_SIN_PASSWORD = 'Falta la contraseña del FTP: escribila en "password" de data/cotizador_ftp.json (en la carpeta del subsistema) y volvé a publicar';

  router.get('/api/cotizador-mayorista/publicar/config', apiRoute(async () => {
    const { cfg, creado } = leerFtp();
    return { ...C.ftpPublico(cfg), ...(creado ? { aviso: 'Se creó data/cotizador_ftp.json con la plantilla; completá la contraseña' } : {}) };
  }));

  let publicando = false; // ponytail: lock en memoria, alcanza con un solo proceso Node
  router.post('/api/cotizador-mayorista/publicaciones/:version/publicar', conPermiso(async (req, res) => {
    const v = Number(req.params.version);
    if (!Number.isInteger(v) || v < 1) return res.status(400).json({ error: 'Versión inválida' });
    const dir = dirVersion(v);
    if (!fs.existsSync(path.join(dir, 'catalogo.csv')) || !fs.existsSync(path.join(dir, 'version.json'))) return res.status(404).json({ error: `No existe la versión ${v}` });
    if (publicando) return res.status(409).json({ error: 'Ya hay una publicación en curso; esperá a que termine' });
    let cfg;
    try { cfg = leerFtp().cfg; } catch (err) { return res.json({ error: err.message }); }
    if (!cfg.password) return res.json({ error: AVISO_SIN_PASSWORD });
    publicando = true;
    const subidos = [];
    let error = null;
    let client = null;
    let tmpPendiente = null; // .tmp remoto subido y todavía sin renombrar
    const limpiarTmp = () => tmpPendiente && client.remove(tmpPendiente, true).catch(() => {});
    try {
      client = crearClienteFtp();
      await client.access({ host: cfg.host, port: cfg.puerto, user: cfg.usuario, password: cfg.password, secure: cfg.secure });
      await client.cd(cfg.rutaRemota);
      for (const archivo of ['catalogo.csv', 'version.json']) { // csv primero: el navegador nunca ve versión sin catálogo
        const local = path.join(dir, archivo), tmp = `${archivo}.tmp`;
        const tamano = fs.statSync(local).size;
        tmpPendiente = tmp;
        await client.uploadFrom(local, tmp);
        const remoto = await client.size(tmp);
        if (remoto !== tamano) {
          error = `El tamaño subido de ${archivo} no coincide (${remoto} de ${tamano} bytes); reintentá`;
          await limpiarTmp();
          break;
        }
        try { await client.rename(tmp, archivo); } catch {
          await client.remove(archivo, true); // hay servidores que no renombran sobre un archivo existente
          await client.rename(tmp, archivo);
        }
        tmpPendiente = null;
        subidos.push(archivo);
      }
    } catch (err) {
      console.error('[cotizador-mayorista] publicar v%d:', v, C.redactar(err && err.message, cfg));
      error = C.mensajeFtp(err);
      if (client) await limpiarTmp();
    } finally {
      if (client) client.close();
      publicando = false;
    }
    const publicadoEn = C.isoLocal();
    const meta = leerMeta(v);
    if (meta) {
      try { guardarMeta(v, { ...meta, publicado: { fecha: publicadoEn, ok: !error, ...(error ? { error } : {}) } }); } catch (err) {
        console.error('[cotizador-mayorista] meta.json v%d no se pudo actualizar:', v, err.message);
      }
    }
    return res.json(error ? { error, version: v, subidos } : { ok: true, version: v, subidos, publicadoEn });
  }));

  router.get('/api/cotizador-mayorista/publicaciones/:version/:archivo', (req, res) => {
    const v = Number(req.params.version), archivo = req.params.archivo;
    if (!Number.isInteger(v) || v < 1 || !['catalogo.csv', 'version.json'].includes(archivo)) return res.status(400).json({ error: 'Versión o archivo inválido' });
    const ruta = path.join(dirVersion(v), archivo);
    if (!fs.existsSync(ruta)) return res.status(404).json({ error: `No existe la versión ${v}` });
    return res.download(ruta, archivo);
  });

  router.get('/api/cotizador-mayorista/codigos.xlsx', async (req, res) => {
    try {
      let indice = new Map();
      try { indice = C.indicePrecios(await listadosVigentes()); } catch (err) {
        console.error('[cotizador-mayorista] codigos.xlsx sin vínculos SIGA:', err.message); // sigue con los PLU explícitos
      }
      const ws = XLSX.utils.aoa_to_sheet(C.filasExportarCodigos(leerTabla().filas, indice));
      ws['!cols'] = [12, 45, 12, 14, 12, 14].map(wch => ({ wch }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'codigos');
      const d = new Date(), p = n => String(n).padStart(2, '0');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="cotizador_codigos_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.xlsx"`);
      return res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    } catch (err) {
      console.error('[cotizador-mayorista] codigos.xlsx:', err.message);
      return res.status(500).json({ error: 'No se pudo generar el Excel de códigos' });
    }
  });

  router.get('/api/cotizador-mayorista/comparacion', apiRoute(async () => {
    const indice = C.indicePrecios(await listadosVigentes());
    return C.compararConPlanilla(leerTabla().filas, indice);
  }));

  return router;
};
