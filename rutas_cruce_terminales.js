'use strict';
const express = require('express');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const cruceTerminales = require('./lib/cruce_terminales');

// ── Rutas del módulo Cruce de terminales ─────────────────────────────────────
// Extraídas de server.js sin cambios de comportamiento: mismas rutas, mismo orden
// relativo entre ellas y mismos handlers. Los bloques movidos conservan la
// indentación original a propósito.
//
// cruce_terminales.js es lógica pura sin estado: se requiere directo. Lo que vive
// en server.js (helpers de disco, apiRoute, DATA_DIR) entra por deps.
//
// Todos los helpers de este bloque (textoDeBuffer, mapaDesdeXlsx, mapaGuardado,
// claveCruce, hojaDetalle, hojaResumen, hojaDuplicados) y su estado en memoria
// (ultimoCruce) se usan sólo acá: se mudan enteros.
module.exports = function crearRutasCruceTerminales(deps) {
  const { apiRoute, leerJSON, guardarJSON, DATA_DIR } = deps;
  const router = express.Router();

router.get('/cruce-terminales', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'cruce_terminales.html')));

// ── Cruce de terminales ────────────────────────────────────────────────────────
// Las bajadas de Payway y QR se procesan en memoria (no se guardan): lo único que
// persiste es el mapa terminal→sucursal que sale del xlsx de distribución, para no
// tener que resubirlo en cada cruce.
const TERMINALES_MAP_PATH = path.join(DATA_DIR, 'terminales_sucursal.json');
const uploadCruce = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 12 } });

// Los reportes bancarios bajan en Windows-1252: si se leen como UTF-8, los acentos
// llegan como U+FFFD. Se prueba UTF-8 y se cae a latin1 cuando aparece basura.
function textoDeBuffer(buffer) {
  const utf8 = buffer.toString('utf8');
  return utf8.includes('�') ? buffer.toString('latin1') : utf8;
}

function mapaDesdeXlsx(buffer, nombreArchivo) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('El xlsx no tiene ninguna hoja');
  const grilla = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  return { ...cruceTerminales.parseMapaTerminales(grilla), actualizado: new Date().toISOString(), archivo: nombreArchivo || '' };
}

function mapaGuardado() {
  return leerJSON(TERMINALES_MAP_PATH, null);
}

// El detalle del último cruce queda en memoria para poder exportarlo sin resubir los
// CSV. Se guarda uno por usuario (o 'anonimo' si el módulo está abierto) y se pisa en
// cada proceso, así no crece sin control.
const ultimoCruce = new Map();
function claveCruce(req) {
  return String((req.session && req.session.user && req.session.user.usuario) || 'anonimo');
}

router.get('/api/cruce-terminales/mapa', apiRoute(async () => {
  const mapa = mapaGuardado();
  if (!mapa) return { cargado: false, sucursales: [], terminales: 0 };
  return {
    cargado: true,
    actualizado: mapa.actualizado || null,
    archivo: mapa.archivo || '',
    sucursales: mapa.sucursales || [],
    terminales: Object.keys(mapa.terminales || {}).length,
  };
}));

router.post('/api/cruce-terminales/mapa', uploadCruce.single('mapa'), (req, res) => {
  try {
    if (!req.file) return res.status(422).json({ error: 'Falta el xlsx de distribución (campo "mapa")' });
    const mapa = mapaDesdeXlsx(req.file.buffer, req.file.originalname);
    guardarJSON(TERMINALES_MAP_PATH, mapa);
    res.json({ ok: true, actualizado: mapa.actualizado, archivo: mapa.archivo, sucursales: mapa.sucursales, terminales: Object.keys(mapa.terminales).length });
  } catch (err) { console.error(err.message); res.status(422).json({ error: err.message }); }
});

router.post('/api/cruce-terminales/procesar', uploadCruce.fields([{ name: 'archivos', maxCount: 10 }, { name: 'mapa', maxCount: 1 }]), (req, res) => {
  try {
    const csvs = (req.files?.archivos || []);
    if (!csvs.length) return res.status(422).json({ error: 'No subiste ningún .csv de las plataformas' });

    // El xlsx es opcional: si viene, reemplaza el mapa guardado; si no, se usa el último.
    let mapa = null;
    if (req.files?.mapa?.[0]) {
      mapa = mapaDesdeXlsx(req.files.mapa[0].buffer, req.files.mapa[0].originalname);
      guardarJSON(TERMINALES_MAP_PATH, mapa);
    } else {
      mapa = mapaGuardado();
      if (!mapa) return res.status(422).json({ error: 'Todavía no cargaste el xlsx "Distribucion Terminales por sucursal": subilo junto con los CSV.' });
    }

    const resultado = cruceTerminales.procesarArchivos(
      csvs.map(f => ({ nombre: f.originalname, texto: textoDeBuffer(f.buffer) })),
      mapa,
    );
    ultimoCruce.set(claveCruce(req), resultado);
    // El detalle completo puede ser de miles de filas: al front va sólo lo que se
    // muestra; el detalle entero se baja en el xlsx.
    res.json({
      archivos: resultado.archivos,
      resumen: resultado.resumen,
      totales: resultado.totales,
      rango: resultado.rango,
      desconocidas: resultado.desconocidas,
      duplicados: resultado.duplicados,
      mapa: { actualizado: mapa.actualizado || null, archivo: mapa.archivo || '', sucursales: mapa.sucursales || [] },
      muestra: resultado.detalle.slice(0, 200),
    });
  } catch (err) { console.error(err.message); res.status(422).json({ error: err.message }); }
});

const COLUMNAS_DETALLE = [
  ['fecha', 'Fecha'], ['sucursalId', 'Sucursal ID'], ['sucursal', 'Sucursal'],
  ['plataforma', 'Plataforma'], ['terminal', 'Terminal'], ['establecimiento', 'Establecimiento'],
  ['medio', 'Medio de pago'], ['tarjeta', 'Tarjeta'], ['cuotas', 'Cuotas'],
  ['comprobante', 'Comprobante'], ['autorizacion', 'Autorización'],
  ['monto', 'Monto'], ['estado', 'Estado'], ['aprobadoTxt', 'Aprobado'],
  ['origenSucursal', 'Asignada por'], ['archivo', 'Archivo'],
];

function hojaDetalle(detalle) {
  const filas = detalle.map(c => {
    const fila = {};
    for (const [campo, titulo] of COLUMNAS_DETALLE) {
      fila[titulo] = campo === 'aprobadoTxt' ? (c.aprobado ? 'SÍ' : 'NO') : (c[campo] ?? '');
    }
    return fila;
  });
  return XLSX.utils.json_to_sheet(filas, { header: COLUMNAS_DETALLE.map(([, t]) => t) });
}

function hojaResumen(resumen, totales) {
  const filas = resumen.map(s => ({
    'Sucursal ID': s.sucursalId ?? '',
    'Sucursal': s.sucursal,
    'Aprobados (cant.)': s.aprobados.cantidad,
    'Aprobados ($)': s.aprobados.monto,
    'No aprobados (cant.)': s.noAprobados.cantidad,
    'No aprobados ($)': s.noAprobados.monto,
    'Total (cant.)': s.total.cantidad,
    'Total ($)': s.total.monto,
  }));
  filas.push({
    'Sucursal ID': '', 'Sucursal': 'TOTAL',
    'Aprobados (cant.)': totales.aprobados.cantidad, 'Aprobados ($)': totales.aprobados.monto,
    'No aprobados (cant.)': totales.noAprobados.cantidad, 'No aprobados ($)': totales.noAprobados.monto,
    'Total (cant.)': totales.comprobantes,
    'Total ($)': Math.round((totales.aprobados.monto + totales.noAprobados.monto) * 100) / 100,
  });
  return XLSX.utils.json_to_sheet(filas);
}

// Cobros que bajaron en las dos plataformas: en el cruce quedó sólo el registro de QR,
// pero se listan para poder controlarlos.
function hojaDuplicados(duplicados) {
  return XLSX.utils.json_to_sheet(duplicados.map(d => ({
    'Fecha': d.fecha,
    'Sucursal ID': d.sucursalId ?? '',
    'Sucursal': d.sucursal,
    'Terminal': d.terminal,
    'Tarjeta (dígitos)': d.tarjeta,
    'Monto': d.monto,
    'QR · comprobante': d.qrComprobante,
    'QR · medio': d.qrMedio,
    'QR · estado': d.qrEstado,
    'QR · archivo': d.qrArchivo,
    'Descartado · plataforma': d.descartadaPlataforma,
    'Descartado · comprobante': d.descartadoComprobante,
    'Descartado · autorización': d.descartadoAutorizacion,
    'Descartado · medio': d.descartadoMedio,
    'Descartado · estado': d.descartadoEstado,
    'Descartado · archivo': d.descartadoArchivo,
  })));
}

router.get('/api/cruce-terminales/exportar', (req, res) => {
  try {
    const resultado = ultimoCruce.get(claveCruce(req));
    if (!resultado) return res.status(409).json({ error: 'No hay un cruce procesado en esta sesión: subí los archivos de nuevo.' });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, hojaResumen(resultado.resumen, resultado.totales), 'Resumen');
    XLSX.utils.book_append_sheet(wb, hojaDetalle(resultado.detalle), 'Detalle');
    XLSX.utils.book_append_sheet(wb, hojaDetalle(resultado.detalle.filter(c => c.aprobado)), 'Aprobados');
    XLSX.utils.book_append_sheet(wb, hojaDetalle(resultado.detalle.filter(c => !c.aprobado)), 'No aprobados');
    if ((resultado.duplicados || []).length) {
      XLSX.utils.book_append_sheet(wb, hojaDuplicados(resultado.duplicados), 'Cruces QR-tarjeta');
    }
    if (resultado.desconocidas.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(resultado.desconocidas.map(t => ({
        'Terminal': t.terminal, 'Establecimiento': t.establecimiento, 'Plataforma': t.plataforma,
        'Comprobantes': t.cantidad, 'Monto': t.monto,
      }))), 'Sin identificar');
    }

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const sufijo = [resultado.rango.desde, resultado.rango.hasta].filter(Boolean).join('_a_') || 'sin-fecha';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="cruce_terminales_${sufijo}.xlsx"`);
    res.send(buffer);
  } catch (err) { console.error(err.message); res.status(500).json({ error: err.message }); }
});

  return router;
};
