'use strict';
const express = require('express');
const path = require('path');

// ── Rutas del módulo Producción ───────────────────────────────────────────────
// La página de Producción Día, los registros de cargas (produccion_registros.json
// + su historial), la cola de órdenes que consume esa pantalla, el CRUD de
// órdenes de producción (/api/ordenes, ordenes.json) y el historial de cierres
// que lista Historial (/api/registros, registros.json).
//
// Extraídas de server.js sin cambios de comportamiento: mismas rutas, mismo orden
// relativo y mismos handlers. El bloque movido conserva la indentación original a
// propósito.
//
// Sólo se mudó presentacionDeNombre(), que no la usa nadie más. Lo compartido se
// inyecta y sigue viviendo en server.js:
//   - PROD_REG_PATH / PROD_HIST_PATH: los leen el cierre de día, la conciliación
//     y rutas_productividad.js.
//   - leerOrdenes / guardarOrdenes: además de acá las usa archivarRegistros()
//     (server.js), /api/plan/:fecha/envio (rutas_plan.js) y, de sólo lectura,
//     rutas_productividad.js.
//   - leerRegistros / guardarRegistros (registros.json, el historial de cierres
//     que lista Historial — no confundir con PROD_REG_PATH/PROD_HIST_PATH de
//     arriba): crearSnapshotsCierre() las sigue usando en server.js; leerRegistros
//     también la usa rutas_productividad.js.
//   - leerPlanReservas / reservasActivasDeOrden: motor de reservas, movido entero
//     a rutas_reservas.js; estas dos funciones siguen en server.js (las comparten
//     ambos routers por deps). Las usan GET /api/ordenes (marcar sinConciliar) y
//     DELETE /api/ordenes[/:id] (bloquear el borrado con reserva activa).
//   - crearSnapshotsCierre() se quedó entera en server.js: la sigue necesitando
//     archivarRegistros() ahí (también en server.js; la llama POST /api/produccion/
//     :fecha/registrar-movimiento, movida a rutas_reservas.js) — pero ahora también
//     se inyecta acá, la llama POST /api/registros.
//
// Orden de rutas: /api/produccion/:fecha/conciliacion y :fecha/registrar-movimiento
// se movieron a rutas_reservas.js (server.js las registra ANTES de este router),
// pero no capturaban nada de acá ni al revés: :fecha exige 3 segmentos con un
// literal fijo detrás ('conciliacion' / 'registrar-movimiento'), y las rutas de
// este módulo son de 2 segmentos (/registros, /historial, /registros-fecha) o de 3
// con métodos que aquéllas no registran (DELETE/PUT /registros/:id vs GET/POST).
module.exports = function crearRutasProduccion(deps) {
  const {
    apiRoute, leerJSON, guardarJSON, safeDate, cfg,
    PROD_REG_PATH, PROD_HIST_PATH, leerOrdenes, guardarOrdenes,
    leerPlanReservas, reservasActivasDeOrden, crearSnapshotsCierre,
    leerRegistros, guardarRegistros,
  } = deps;
  const router = express.Router();

router.get('/produccion',    (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', cfg.produccionHtml || 'apidelta_produccion_dia.html')));

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

// Un movimiento de reserva está "sin conciliar" mientras su entrada del ledger siga activa y
// no tenga ajuste.conciliado. La orden queda marcada si alguno de sus movimientos lo está.
router.get('/api/ordenes',        (_req, res) => {
  const sinConciliarPorFecha = new Map();
  const movsSinConciliar = fecha => {
    if (!fecha) return new Set();
    if (!sinConciliarPorFecha.has(fecha)) {
      const { plan } = leerPlanReservas(fecha);
      const set = new Set((plan && plan.reservas || [])
        .filter(rr => rr && rr.estado === 'activa' && !(rr.ajuste && rr.ajuste.conciliado))
        .map(rr => rr.numeroMovimiento).filter(n => n != null));
      sinConciliarPorFecha.set(fecha, set);
    }
    return sinConciliarPorFecha.get(fecha);
  };
  const ordenes = leerOrdenes().map(o => ({
    ...o,
    sinConciliar: (o.reservaMovimientos || []).some(n => movsSinConciliar(o.fecha).has(n)),
  }));
  res.json(ordenes);
});
router.post('/api/ordenes',       (req, res)  => { const o = req.body; if (!o || !o.id) return res.status(400).json({ error: 'Falta orden' }); const arr = leerOrdenes().filter(x => x.id !== o.id); arr.push(o); guardarOrdenes(arr); res.json(o); });
router.put('/api/ordenes/:id',    (req, res)  => { const id = parseInt(req.params.id), arr = leerOrdenes(), idx = arr.findIndex(o => o.id === id); if (idx < 0) return res.status(404).json({ error: 'No encontrado' }); arr[idx] = { ...arr[idx], ...req.body }; guardarOrdenes(arr); res.json(arr[idx]); });
// Borrar una orden con reserva activa dejaría mercadería apartada en SiGA sin dueño: se corta
// con 409 y se pide anular la reserva primero (mismo criterio que DELETE /api/plan/:fecha/item).
router.delete('/api/ordenes/:id', (req, res) => {
  const id  = parseInt(req.params.id);
  const arr = leerOrdenes();
  const orden = arr.find(o => o.id === id);
  const reservas = orden ? reservasActivasDeOrden(orden) : [];
  if (reservas.length) {
    return res.status(409).json({
      error: `La orden tiene reserva activa (movimiento${reservas.length > 1 ? 's' : ''} #${reservas.join(', #')}) `
           + 'y no se puede eliminar. Anulá o devolvé esa reserva primero.',
      reservas
    });
  }
  guardarOrdenes(arr.filter(o => o.id !== id));
  res.json({ ok: true });
});

// "Limpiar todo" conserva las órdenes con reserva activa y avisa cuántas quedaron, en vez de
// fallar entero: el resto del día sí se puede limpiar.
router.delete('/api/ordenes', (_req, res) => {
  const arr = leerOrdenes();
  const cache = new Map();
  const conservar = arr.filter(o => reservasActivasDeOrden(o, cache).length > 0);
  guardarOrdenes(conservar);
  res.json({
    ok: true, conservadas: conservar.length, eliminadas: arr.length - conservar.length,
    ...(conservar.length ? { aviso: `Se conservaron ${conservar.length} orden(es) con reserva activa: `
                                  + 'anulá o devolvé su reserva para poder eliminarlas.' } : {})
  });
});

router.get('/api/registros',  (_req, res) => res.json(leerRegistros()));
router.post('/api/registros', (req, res)  => {
  const ordenes = leerOrdenes();
  const todasCargas = leerJSON(PROD_REG_PATH, []);
  // ?fecha=YYYY-MM-DD archiva un solo día ("sin-fecha" = cargas sin fecha); sin el parámetro
  // se archiva todo, que es lo que hace el botón "Cerrar día".
  const fecha = req.query.fecha;
  const esDelDia = c => fecha === 'sin-fecha' ? !c.fecha : c.fecha === fecha;
  const cargas = fecha ? todasCargas.filter(esDelDia) : todasCargas;
  // El historial guarda productos: sin cargas no hay nada que archivar.
  if (!cargas.length) return res.status(400).json({ error: fecha ? 'No hay producción cargada para ese día' : 'No hay producción cargada para registrar' });
  const creados = crearSnapshotsCierre(cargas);
  if (req.query.limpiar === '1') {
    // Quitar las órdenes completadas; las pendientes siguen en ordenes.json. Drenar las cargas archivadas.
    if (fecha) {
      const idsDia = new Set(cargas.map(c => String(c.ordenId)));
      guardarOrdenes(ordenes.filter(o => !(o.estado === 'listo' && idsDia.has(String(o.id)))));
      guardarJSON(PROD_REG_PATH, todasCargas.filter(c => !esDelDia(c)));
    } else {
      guardarOrdenes(ordenes.filter(o => o.estado !== 'listo'));
      guardarJSON(PROD_REG_PATH, []);
    }
  }
  res.json({ ok: true, snapshots: creados.length, registros: creados });
});
router.delete('/api/registros/:id', (req, res) => {
  const id = Number(req.params.id);
  const arr = leerRegistros();
  const nuevo = arr.filter(x => x.id !== id);
  if (nuevo.length === arr.length) return res.status(404).json({ error: 'no encontrado' });
  guardarRegistros(nuevo);
  res.json({ ok: true });
});

  return router;
};
