'use strict';
const express = require('express');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const cruceBancario = require('../lib/cruce_bancario');

const { ErrorCruce } = cruceBancario;

// ── Rutas del módulo Cruce bancario ───────────────────────────────────────────
// Sube el xls de la bajada del banco, ubica cada movimiento en un ticket de SIGA por importe y
// hora (lib/cruce_bancario.js) y responde un JSON con el resumen del resultado y el xlsx (en base64)
// con todos los movimientos y su sucursal.
// Nada se guarda: el archivo se procesa en memoria y SIGA se consulta sólo de lectura.
// Lo único que entra por deps es `query`, el acceso de lectura a SIGA de server.js.
module.exports = function crearRutasCruceBancario(deps) {
  const { query } = deps;
  const router = express.Router();

  // Una bajada real pesa decenas de KB: los topes cortan archivos armados para agotar memoria.
  const MAX_ARCHIVO_BYTES = 5 * 1024 * 1024;
  const MAX_FILAS_HOJA = 50000;
  const MAX_COLUMNAS_HOJA = 64;
  const MENSAJE_FORMATO = 'No pude leer el archivo: tiene que ser un .xls o .xlsx del banco.';
  // Firmas de archivo: OLE2 (.xls) y ZIP (.xlsx). Cualquier otro formato no se le pasa a SheetJS,
  // que también lee CSV, HTML, XML, etc.
  const FIRMAS_XLS_XLSX = [Buffer.from([0xD0, 0xCF, 0x11, 0xE0]), Buffer.from([0x50, 0x4B, 0x03, 0x04])];
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ARCHIVO_BYTES, files: 1, fields: 4, fieldSize: 100, parts: 6 },
  });

  router.get('/cruce-bancario', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'cruce_bancario.html')));

  // Errores de multer (archivo muy grande, etc.) con el mismo formato JSON que el resto.
  function recibirArchivo(req, res, next) {
    upload.single('archivo')(req, res, err => {
      if (!err) return next();
      const mensaje = err.code === 'LIMIT_FILE_SIZE' ? 'El archivo supera los 5 MB.' : 'No se pudo recibir el archivo.';
      return res.status(422).json({ error: mensaje });
    });
  }

  const esXlsOXlsx = buffer => FIRMAS_XLS_XLSX.some(firma => buffer.subarray(0, firma.length).equals(firma));

  // sheet_to_json con raw:true deja las fechas como vienen (texto o serial): la lib las interpreta.
  function leerGrilla(buffer) {
    if (!esXlsOXlsx(buffer)) throw new ErrorCruce(MENSAJE_FORMATO);
    let wb;
    try {
      // sheetRows: SheetJS deja de parsear filas pasado el tope (+1 para poder detectar que se pasó).
      wb = XLSX.read(buffer, { type: 'buffer', sheetRows: MAX_FILAS_HOJA + 1, cellText: false, cellNF: false });
    } catch (_err) {
      throw new ErrorCruce(MENSAJE_FORMATO);
    }
    const hoja = wb.Sheets[wb.SheetNames[0]];
    if (!hoja) throw new ErrorCruce('El archivo no tiene ninguna hoja.');
    // sheet_to_json con defval materializa todas las celdas del área declarada en !ref: un xlsx de
    // pocos KB con un !ref gigante tumba el proceso. Se corta antes de convertir. Con sheetRows,
    // SheetJS recorta !ref a los datos reales y deja lo declarado en !fullref: se mira esa
    // dimensión declarada primero, porque una bajada real nunca declara un área así.
    const area = XLSX.utils.decode_range(hoja['!fullref'] || hoja['!ref'] || 'A1');
    if (area.e.r + 1 > MAX_FILAS_HOJA || area.e.c + 1 > MAX_COLUMNAS_HOJA) {
      throw new ErrorCruce('La hoja es demasiado grande para ser una bajada del banco.');
    }
    return XLSX.utils.sheet_to_json(hoja, { header: 1, raw: true, defval: '' });
  }

  // El resumen ya viene armado (se calcula una vez en el handler): la hoja Resumen sale de él.
  function armarLibro({ filas, resumen }) {
    const hojaResumen = XLSX.utils.aoa_to_sheet(cruceBancario.matrizResumen(resumen));
    hojaResumen['!cols'] = [{ wch: 42 }, { wch: 24 }, { wch: 16 }, { wch: 16 }];
    const detalle = XLSX.utils.json_to_sheet(cruceBancario.filasDetalle(filas), { header: cruceBancario.COLUMNAS_DETALLE });
    detalle['!cols'] = cruceBancario.COLUMNAS_DETALLE.map(titulo => ({ wch: Math.max(14, titulo.length + 2) }));

    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, hojaResumen, 'Resumen');
    XLSX.utils.book_append_sheet(libro, detalle, 'Detalle');
    return XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' });
  }

  router.post('/api/cruce-bancario/procesar', recibirArchivo, async (req, res) => {
    const { tolMonto, tolMin } = req.body || {};

    // 1) Archivo y rango. Un ErrorCruce es del archivo o de los parámetros del usuario → 422 con el
    //    motivo; cualquier otro es un fallo interno y no se le refleja (puede traer rutas o datos).
    let parse;
    let rango;
    try {
      cruceBancario.validarTolerancias({ tolMonto, tolMin });
      if (!req.file) return res.status(422).json({ error: 'Falta el archivo de la bajada del banco (campo "archivo").' });
      parse = cruceBancario.parseBajada(leerGrilla(req.file.buffer));
      rango = cruceBancario.rangoConsulta(parse.movimientos, tolMin);
    } catch (err) {
      if (err instanceof ErrorCruce) return res.status(422).json({ error: err.message });
      console.error('[cruce-bancario] procesando el archivo:', err.message);
      return res.status(500).json({ error: 'No se pudo procesar el archivo.' });
    }

    // 2) Tickets de SIGA (sólo si hay algún movimiento que aplique).
    let tickets = [];
    if (rango) {
      try {
        const filasSql = await query(cruceBancario.sqlTickets(rango.desde, rango.hasta));
        tickets = cruceBancario.normalizarTickets(filasSql);
      } catch (err) {
        console.error('[cruce-bancario] consulta a SIGA:', err.message);
        return res.status(500).json({ error: 'No se pudo consultar SIGA. Probá de nuevo en unos minutos.' });
      }
    }

    // 3) Cruce, resumen y xlsx. Una sola respuesta JSON: el resumen para mostrarlo en la página y el
    //    xlsx en base64 para descargarlo, sin guardar nada en el server entre una llamada y otra.
    try {
      const cruce = cruceBancario.cruzar(parse.movimientos, tickets, { tolMonto, tolMin });
      const resumen = cruceBancario.armarResumen({ ...cruce, parse });
      const buffer = armarLibro({ filas: cruce.filas, resumen });
      res.setHeader('Cache-Control', 'no-store'); // son datos de cobros: que no queden en cachés
      return res.json({
        resumen,
        archivo: {
          nombre: `cruce_bancario_${cruceBancario.sufijoRango(parse.movimientos)}.xlsx`,
          base64: buffer.toString('base64'),
        },
      });
    } catch (err) {
      console.error('[cruce-bancario] armado del xlsx:', err.message);
      return res.status(500).json({ error: 'No se pudo armar el xlsx del cruce.' });
    }
  });

  return router;
};
