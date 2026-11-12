'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const tn = require('../lib/tn_precios');

// ── Control de precios Tienda Nube (spec docs/specs/control_precios_tienda_nube.md) ─────
// Bajada CSV de TN vs carta de SIGA (lista 0, sucursal 1) × unidades × (1 + recargo). SIGA solo lectura; se escribe
// solo data/tn_*.json y data/tn_bajada.csv (bytes crudos, para exportar sin tocar el resto de las celdas).
module.exports = function crearRutasTnPrecios(deps) {
  const { apiRoute, query, leerJSON, guardarJSON, DATA_DIR, LISTA_PRECIOS_VENTA, tienePermiso } = deps;
  const router = express.Router();

  const BAJADA_PATH = path.join(DATA_DIR, 'tn_bajada.csv');
  const META_PATH = path.join(DATA_DIR, 'tn_bajada_meta.json');
  const VINCULOS_PATH = path.join(DATA_DIR, 'tn_vinculos.json');
  const CONFIG_PATH = path.join(DATA_DIR, 'tn_config.json');
  const COMBOS_PATH = path.join(DATA_DIR, 'tn_combos.json');
  const MAX_COMPONENTES = 30;
  const MAX_UNIDADES = 1000;
  const SUCURSAL_CARTA = 1;
  const MAX_ARCHIVO_BYTES = 10 * 1024 * 1024;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ARCHIVO_BYTES, files: 1, fields: 4, parts: 6 } });

  const esCodigo = v => Number.isInteger(v) && v > 0;
  const conPermiso = handler => (req, res, next) => (tienePermiso(req.session && req.session.user, 'precios-config')
    ? handler(req, res, next) : res.status(403).json({ error: 'Sin permiso para cambiar la configuración de precios.' }));

  function leerConfig() {
    const cfg = leerJSON(CONFIG_PATH, null);
    if (cfg) return cfg;
    guardarJSON(CONFIG_PATH, tn.CONFIG_DEFAULT);
    return tn.CONFIG_DEFAULT;
  }
  const leerVinculos = () => leerJSON(VINCULOS_PATH, {});
  const leerCombos = () => leerJSON(COMBOS_PATH, {});
  const leerBajada = () => (fs.existsSync(BAJADA_PATH) ? fs.readFileSync(BAJADA_PATH) : null);

  // Códigos validados como enteros > 0: se interpolan como literal, sin texto del usuario (igual que ml_precios).
  async function cartasDe(codigos) {
    const lista = [...new Set(codigos.filter(esCodigo))];
    if (!lista.length) return new Map();
    const filas = await query(`
      SELECT p.IdProducto, p.NombreProducto, CAST(psp.PrecioVenta AS FLOAT) AS Precio
      FROM Productos p
      LEFT JOIN ProductosSucursalesPrecios psp
        ON psp.IdProducto = p.IdProducto AND psp.IdSucursal = ${SUCURSAL_CARTA} AND psp.IdListaPrecios = ${LISTA_PRECIOS_VENTA}
      WHERE p.IdProducto IN (${lista.map(c => `'${c}'`).join(',')})`);
    return new Map(filas.map(f => [String(f.IdProducto).trim(), { precio: f.Precio, nombre: String(f.NombreProducto || '').trim() }]));
  }

  // Filas de control de la bajada guardada. Tira si falla SIGA.
  async function control() {
    const buf = leerBajada();
    if (!buf) return { importadoEn: null, filas: [] };
    const { filas } = tn.parsearBajada(buf);
    const vinculos = leerVinculos();
    const combos = leerCombos();
    const cfg = leerConfig();
    const sku = f => (/^\d+$/.test(f.sku) ? Number(f.sku) : null);
    const codigos = filas.flatMap(f => (f.esCombo ? (combos[f.clave] || []).map(c => c.codigo)
      : [vinculos[f.clave] ? vinculos[f.clave].codigo : sku(f)]));
    const cartas = await cartasDe(codigos);
    return {
      importadoEn: leerJSON(META_PATH, {}).importadoEn || null,
      filas: filas.map(f => (f.esCombo ? tn.armarCombo(f, combos[f.clave], cartas, cfg) : tn.armarFila(f, vinculos[f.clave] || null, cartas, cfg))),
    };
  }

  const filaDe = clave => {
    const buf = leerBajada();
    return buf ? tn.parsearBajada(buf).filas.find(f => f.clave === clave) || null : null;
  };

  router.get('/tn-precios', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'tn_precios.html')));

  router.post('/api/tn-precios/importar', (req, res) => {
    upload.single('archivo')(req, res, err => {
      if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'El archivo supera los 10 MB.' : 'No se pudo recibir el archivo.' });
      if (!req.file) return res.status(400).json({ error: 'Falta el archivo (campo "archivo").' });
      try {
        const r = tn.parsearBajada(req.file.buffer);
        if (!r.filas.length) return res.status(400).json({ error: 'El CSV no tiene productos.' });
        fs.writeFileSync(BAJADA_PATH, req.file.buffer);
        guardarJSON(META_PATH, { importadoEn: new Date().toISOString(), archivo: req.file.originalname });
        return res.json({ filas: r.filas.length, conSku: r.conSku, sinSku: r.sinSku, skuRepetidos: r.skuRepetidos, importadas: r.filas.length });
      } catch (e) {
        if (e instanceof tn.ErrorBajada) return res.status(400).json({ error: e.message });
        console.error('[tn-precios] importando bajada:', e.message);
        return res.status(500).json({ error: 'No se pudo importar el archivo.' });
      }
    });
  });

  router.get('/api/tn-precios/control', async (_req, res) => {
    let r;
    try {
      r = await control();
    } catch (e) {
      console.error('[tn-precios] control:', e.message);
      return res.status(502).json({ error: 'No se pudo leer la lista de precios de SIGA. Probá de nuevo en unos minutos.' });
    }
    return res.json({ importadoEn: r.importadoEn, kpis: tn.kpis(r.filas), filas: r.filas });
  });

  router.put('/api/tn-precios/vinculos/:clave', conPermiso(async (req, res) => {
    const clave = String(req.params.clave || '');
    const { codigo, unidades } = req.body || {};
    const fila = filaDe(clave);
    if (!fila) return res.status(400).json({ error: 'La fila no está en la bajada importada.' });
    if (fila.esCombo) return res.status(400).json({ error: 'La fila es un combo: cargá sus componentes en lugar de un vínculo.' });
    const vinculos = leerVinculos();
    if (codigo === null) {
      const { [clave]: _quitado, ...resto } = vinculos;
      guardarJSON(VINCULOS_PATH, resto);
      return res.json({ clave, vinculo: null });
    }
    if (!esCodigo(codigo)) return res.status(400).json({ error: 'El código debe ser un entero mayor a 0.' });
    if (!Number.isInteger(unidades) || unidades < 1) return res.status(400).json({ error: 'Las unidades deben ser un entero ≥ 1.' });
    try {
      const existe = await query(`SELECT TOP 1 IdProducto FROM Productos WHERE IdProducto = '${codigo}'`);
      if (!existe.length) return res.status(400).json({ error: `El código ${codigo} no existe en SIGA.` });
    } catch (e) {
      console.error('[tn-precios] validando código:', e.message);
      return res.status(502).json({ error: 'No se pudo consultar SIGA para validar el código.' });
    }
    const vinculo = { codigo, unidades, actualizado: new Date().toISOString() };
    guardarJSON(VINCULOS_PATH, { ...vinculos, [clave]: vinculo });
    return res.json({ clave, vinculo });
  }));

  router.put('/api/tn-precios/combos/:clave', conPermiso(async (req, res) => {
    const clave = String(req.params.clave || '');
    const fila = filaDe(clave);
    if (!fila) return res.status(400).json({ error: 'La fila no está en la bajada importada.' });
    if (!fila.esCombo) return res.status(400).json({ error: 'La fila no es un combo (su categoría no incluye "Combos").' });
    const lista = (req.body || {}).componentes;
    if (!Array.isArray(lista)) return res.status(400).json({ error: 'Falta la lista de componentes.' });
    if (lista.length > MAX_COMPONENTES) return res.status(400).json({ error: `Un combo admite hasta ${MAX_COMPONENTES} componentes.` });
    for (const c of lista) {
      if (!c || !esCodigo(c.codigo)) return res.status(400).json({ error: 'Cada código debe ser un entero mayor a 0.' });
      if (typeof c.unidades !== 'number' || !Number.isFinite(c.unidades) || c.unidades <= 0 || c.unidades > MAX_UNIDADES) {
        return res.status(400).json({ error: `Las unidades del código ${c.codigo} deben ser un número mayor a 0 y hasta ${MAX_UNIDADES}.` });
      }
    }
    const componentes = lista.map(c => ({ codigo: c.codigo, unidades: c.unidades }));
    if (new Set(componentes.map(c => c.codigo)).size !== componentes.length) return res.status(400).json({ error: 'Hay códigos repetidos en el combo.' });
    const combos = leerCombos();
    if (!componentes.length) {
      const { [clave]: _quitado, ...resto } = combos;
      guardarJSON(COMBOS_PATH, resto);
      return res.json({ clave, componentes: [] });
    }
    let existentes;
    try {
      existentes = await cartasDe(componentes.map(c => c.codigo));
    } catch (e) {
      console.error('[tn-precios] validando componentes:', e.message);
      return res.status(502).json({ error: 'No se pudo consultar SIGA para validar los códigos.' });
    }
    const faltan = componentes.filter(c => !existentes.has(String(c.codigo))).map(c => c.codigo);
    if (faltan.length) return res.status(400).json({ error: `No existen en SIGA: ${faltan.join(', ')}.` });
    guardarJSON(COMBOS_PATH, { ...combos, [clave]: componentes });
    return res.json({ clave, componentes });
  }));

  router.get('/api/tn-precios/config', apiRoute(async () => leerConfig()));

  router.put('/api/tn-precios/config', conPermiso((req, res) => {
    const b = req.body || {};
    const error = tn.validarConfig(b);
    if (error) return res.status(400).json({ error });
    const cfg = { recargoPct: b.recargoPct, toleranciaPct: b.toleranciaPct, redondeoPaso: b.redondeoPaso };
    guardarJSON(CONFIG_PATH, cfg);
    return res.json(cfg);
  }));

  router.get('/api/tn-precios/exportar', async (_req, res) => {
    let r;
    try {
      r = await control();
    } catch (e) {
      console.error('[tn-precios] exportar:', e.message);
      return res.status(502).json({ error: 'No se pudo leer la lista de precios de SIGA. Probá de nuevo en unos minutos.' });
    }
    const correcciones = Object.fromEntries(r.filas.filter(f => f.estado === 'desviada').map(f => [f.clave, f.esperado]));
    if (!Object.keys(correcciones).length) return res.status(409).json({ error: 'No hay filas desviadas para exportar.' });
    res.set('Content-Type', 'text/csv; charset=iso-8859-1');
    res.set('Content-Disposition', 'attachment; filename="tiendanube_precios_corregidos.csv"');
    return res.send(tn.exportarCsv(leerBajada(), correcciones));
  });

  return router;
};
