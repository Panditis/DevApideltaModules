'use strict';
const express = require('express');
const path = require('path');

// ── Rutas del módulo Producción ───────────────────────────────────────────────
// La página de Producción Día, los registros de cargas (produccion_registros.json
// + su historial) y la cola de órdenes que consume esa pantalla.
//
// Extraídas de server.js sin cambios de comportamiento: mismas rutas, mismo orden
// relativo y mismos handlers. El bloque movido conserva la indentación original a
// propósito.
//
// Sólo se mudó presentacionDeNombre(), que no la usa nadie más. Lo compartido se
// inyecta y sigue viviendo en server.js:
//   - PROD_REG_PATH / PROD_HIST_PATH: los leen el cierre de día, la conciliación
//     y rutas_productividad.js.
//   - leerOrdenes / guardarOrdenes: los usa medio server.js (/api/ordenes, cierre,
//     enviar-produccion).
//   - archivarRegistros() y crearSnapshotsCierre() se quedaron enteras en server.js
//     por el mismo motivo (las llama /api/produccion/:fecha/registrar-movimiento).
//
// Orden de rutas: /api/produccion/:fecha/conciliacion y :fecha/registrar-movimiento
// quedaron en server.js y se declaran ANTES de este router, pero no capturan nada de
// acá: :fecha exige 3 segmentos con un literal fijo detrás ('conciliacion' /
// 'registrar-movimiento'), y las rutas de este módulo son de 2 segmentos
// (/registros, /historial, /registros-fecha) o de 3 con métodos que aquéllas no
// registran (DELETE/PUT /registros/:id vs GET/POST).
module.exports = function crearRutasProduccion(deps) {
  const {
    apiRoute, leerJSON, guardarJSON, safeDate, cfg,
    PROD_REG_PATH, PROD_HIST_PATH, leerOrdenes, guardarOrdenes,
  } = deps;
  const router = express.Router();

router.get('/produccion',    (_req, res) => res.sendFile(path.join(__dirname, cfg.produccionHtml || 'apidelta_produccion_dia.html')));

router.get('/api/produccion/registros', apiRoute(async () => leerJSON(PROD_REG_PATH, [])));
// Historial: registros ya conciliados/archivados (fuera de Terminados). Filtro opcional por fecha.
router.get('/api/produccion/historial', apiRoute(async req => {
  const fecha = req.query.fecha ? safeDate(req.query.fecha) : null;
  const hist = leerJSON(PROD_HIST_PATH, []);
  return fecha ? hist.filter(r => r && r.fecha === fecha) : hist;
}));
// Presentación deducida del nombre del producto ("MIEL APIDELTA 500G" → "500g"), o '' si el
// nombre no la trae. La carga manual no viene de una orden planificada, así que no tiene
// presentación cargada: sin esto la columna quedaba vacía en Terminados y en el historial.
function presentacionDeNombre(nombre) {
  const m = String(nombre || '').match(/(\d+(?:[.,]\d+)?)\s*(kg|g|ml|lt|l|cc)\b/i);
  return m ? m[1].replace(',', '.') + m[2].toLowerCase() : '';
}

router.post('/api/produccion/registros', (req, res) => {
  const b = req.body || {};
  if (b.plu == null || b.cantFraccionada == null) return res.status(400).json({ error: 'faltan campos' });
  const arr = leerJSON(PROD_REG_PATH, []);
  const presentacion = String(b.presentacion || '').trim() || presentacionDeNombre(b.nombre || b.producto);
  // Date.now() solo repetía id si entraban dos registros en el mismo ms (varias presentaciones
  // de una misma orden): con id repetido, borrar uno borraba los dos.
  let id = Date.now();
  while (arr.some(x => x && x.id === id)) id++;
  arr.push({ ...b, presentacion, id });
  guardarJSON(PROD_REG_PATH, arr);
  res.json({ ok: true });
});
router.delete('/api/produccion/registros-fecha', (req, res) => {
  const { fecha } = req.query;
  const arr = leerJSON(PROD_REG_PATH, []);
  const nuevo = fecha ? arr.filter(x => x.fecha !== fecha) : [];
  guardarJSON(PROD_REG_PATH, nuevo);
  res.json({ ok: true, eliminados: arr.length - nuevo.length });
});
router.delete('/api/produccion/registros/:id', (req, res) => {
  const id = Number(req.params.id);
  const arr = leerJSON(PROD_REG_PATH, []);
  const nuevo = arr.filter(x => x.id !== id);
  if (nuevo.length === arr.length) return res.status(404).json({ error: 'no encontrado' });
  guardarJSON(PROD_REG_PATH, nuevo);
  res.json({ ok: true });
});
router.put('/api/produccion/registros/:id', (req, res) => {
  const id = Number(req.params.id);
  const arr = leerJSON(PROD_REG_PATH, []);
  const idx = arr.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ error: 'no encontrado' });
  arr[idx] = { ...arr[idx], ...req.body, id };
  guardarJSON(PROD_REG_PATH, arr);
  res.json({ ok: true });
});

router.get('/api/ordenes-produccion', (_req, res) => res.json(leerOrdenes()));
router.post('/api/ordenes-produccion/reordenar', (req, res) => {
  const ids = req.body && req.body.ids;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'Falta ids[]' });
  try {
    const arr = leerOrdenes();
    const pos = new Map(ids.map((id, i) => [String(id), i]));
    arr.sort((a, b) => (pos.has(String(a.id)) ? pos.get(String(a.id)) : 1e9) - (pos.has(String(b.id)) ? pos.get(String(b.id)) : 1e9));
    guardarOrdenes(arr);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

  return router;
};
