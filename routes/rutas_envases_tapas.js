'use strict';
const express = require('express');
const path = require('path');

// ── Rutas de envases y tapas ──────────────────────────────────────────────────
// Los dos registros (data/envases_registro.json y data/tapas_registro.json) son
// el mismo mecanismo con dos archivos: se guarda un código de producto de SIGA y
// se le refresca nombre y stock. Comparten envaseLookup, que es la única razón
// por la que viajan juntos. Extraídas de server.js sin cambios de
// comportamiento: mismas rutas, mismo orden relativo y mismas queries. El bloque
// movido conserva la indentación original a propósito: reindentar cambiaría el
// texto de los SQL multilínea, que son template literals.
//
// envaseLookup, ENVASES_REG_PATH y TAPAS_REG_PATH no tienen un solo uso fuera
// del bloque: se mudan enteros. Sólo entran por deps los helpers compartidos del
// server (apiRoute, query, el disco y DATA_DIR).
module.exports = function crearRutasEnvasesTapas(deps) {
  const { apiRoute, query, leerJSON, guardarJSON, DATA_DIR } = deps;
  const router = express.Router();

const ENVASES_REG_PATH = path.join(DATA_DIR, 'envases_registro.json'); // [{codigo,nombre,stock}]
const TAPAS_REG_PATH   = path.join(DATA_DIR, 'tapas_registro.json');    // [{codigo,nombre,stock}]

router.get('/api/envases', apiRoute(async () => query(`
SELECT p.IdProducto, p.NombreProducto, r.NombreRubro, COALESCE(SUM(pd.Stock),0) AS StockActual
FROM Productos p INNER JOIN Rubros r ON r.IdRubro=p.IdRubro
LEFT  JOIN ProductosDepositos pd ON pd.IdProducto=p.IdProducto
LEFT  JOIN SucursalesDepositos sd ON sd.IdDeposito=pd.IdDeposito AND sd.IdSucursal=pd.IdSucursal
LEFT  JOIN Sucursales s ON s.IdSucursal=pd.IdSucursal AND s.SoyLaCentral=1
WHERE p.Activo=1 AND UPPER(r.NombreRubro) LIKE '%EMBALA%'
GROUP BY p.IdProducto, p.NombreProducto, r.NombreRubro ORDER BY p.NombreProducto`)));

// ── Registro de envases (código de sistema → nombre + stock desde Siga) ──
async function envaseLookup(codigo) {
  const safe = String(codigo).replace(/'/g, "''");
  const rows = await query(`SELECT TOP 1 p.IdProducto, p.NombreProducto,
      COALESCE((SELECT SUM(pd.Stock) FROM dbo.ProductosDepositos pd WHERE pd.IdProducto = p.IdProducto), 0) AS StockActual
    FROM dbo.Productos p WHERE p.IdProducto = '${safe}' AND p.Activo = 1`);
  return rows.length ? { codigo: String(rows[0].IdProducto), nombre: rows[0].NombreProducto, stock: Number(rows[0].StockActual) || 0 } : null;
}
router.get('/api/envase-lookup', apiRoute(async req => {
  const codigo = (req.query.codigo || '').trim();
  if (!codigo) return { error: 'Falta código' };
  return (await envaseLookup(codigo)) || { error: 'Producto no encontrado' };
}));
router.get('/api/envases-registro', (_req, res) => res.json(leerJSON(ENVASES_REG_PATH, [])));
router.post('/api/envases-registro', apiRoute(async req => {
  const codigo = ((req.body && req.body.codigo) || '').toString().trim();
  if (!codigo) return { error: 'Falta código' };
  const e = await envaseLookup(codigo);
  if (!e) return { error: 'Producto no encontrado en Siga' };
  const arr = leerJSON(ENVASES_REG_PATH, []);
  const i = arr.findIndex(x => String(x.codigo) === String(e.codigo));
  if (i >= 0) arr[i] = e; else arr.push(e);
  guardarJSON(ENVASES_REG_PATH, arr);
  return { ok: true, envase: e };
}));
router.post('/api/envases-registro/refrescar', apiRoute(async () => {
  const arr = leerJSON(ENVASES_REG_PATH, []);
  for (const x of arr) { const e = await envaseLookup(x.codigo); if (e) { x.nombre = e.nombre; x.stock = e.stock; } }
  guardarJSON(ENVASES_REG_PATH, arr);
  return { ok: true, envases: arr };
}));
router.delete('/api/envases-registro/:codigo', (req, res) => {
  const cod = String(req.params.codigo);
  guardarJSON(ENVASES_REG_PATH, leerJSON(ENVASES_REG_PATH, []).filter(x => String(x.codigo) !== cod));
  res.json({ ok: true });
});
router.get('/api/tapas-registro', (_req, res) => res.json(leerJSON(TAPAS_REG_PATH, [])));
router.post('/api/tapas-registro', apiRoute(async req => {
  const codigo = ((req.body && req.body.codigo) || '').toString().trim();
  if (!codigo) return { error: 'Falta código' };
  const e = await envaseLookup(codigo);
  if (!e) return { error: 'Producto no encontrado en Siga' };
  const arr = leerJSON(TAPAS_REG_PATH, []);
  const i = arr.findIndex(x => String(x.codigo) === String(e.codigo));
  if (i >= 0) arr[i] = e; else arr.push(e);
  guardarJSON(TAPAS_REG_PATH, arr);
  return { ok: true, tapa: e };
}));
router.post('/api/tapas-registro/refrescar', apiRoute(async () => {
  const arr = leerJSON(TAPAS_REG_PATH, []);
  for (const x of arr) { const e = await envaseLookup(x.codigo); if (e) { x.nombre = e.nombre; x.stock = e.stock; } }
  guardarJSON(TAPAS_REG_PATH, arr);
  return { ok: true, tapas: arr };
}));
router.delete('/api/tapas-registro/:codigo', (req, res) => {
  const cod = String(req.params.codigo);
  guardarJSON(TAPAS_REG_PATH, leerJSON(TAPAS_REG_PATH, []).filter(x => String(x.codigo) !== cod));
  res.json({ ok: true });
});
router.get('/api/tapa-lookup', apiRoute(async req => {
  const codigo = (req.query.codigo || '').trim();
  if (!codigo) return { error: 'Falta código' };
  return (await envaseLookup(codigo)) || { error: 'Producto no encontrado' };
}));

  return router;
};
