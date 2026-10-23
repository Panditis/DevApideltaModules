'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const { esMayorista } = require('../lib/catalogo_presentaciones');

// ── Rutas del catálogo de grupos ──────────────────────────────────────────────
// El catálogo es data/catalogo.json (plu → grupo/presentación/mayorista) más su
// config data/grupos_config.json. Extraídas de server.js sin cambios de
// comportamiento: mismas rutas, mismo orden relativo y mismas queries. Los
// bloques movidos conservan la indentación original a propósito.
//
// Lo que comparte prefijo pero NO es del catálogo y sigue en server.js:
//   · /api/siga/buscar — quedó físicamente en medio del bloque, pero es el
//     buscador genérico de productos de SIGA, no toca catalogo.json.
//   · /api/formulas/* — recetas locales (data/formulas.json) de planificación.
//   · /api/producto, /api/productos/*, /api/formula[/schema] — lookups directos
//     a SIGA que consumen producción, distribución y análisis.
//   · /api/bom[/producto/:plu] — planificación: sale de rubrosGranel y lo lee
//     planificacion.html junto a /api/consumo y /api/pendientes.
//   · /api/productos (el de params(req)) — es del bloque de pedidos.
//
// Los helpers cfg* leen grupos_config.json y los usa también
// calcularSugerenciasCatalogo, que sigue en server.js: entran por deps.
module.exports = function crearRutasCatalogo(deps) {
  const {
    leerJSON, guardarJSON,
    CATALOGO_PATH, GRUPOS_CFG_PATH,
    cfgActivo, cfgGranelPlu, cfgGranelPlus, cfgMpManual,
    cfgEsGranel, cfgGranelOverride, cfgEsMiel, cfgReqGranel, cfgVentaPorUnidad,
  } = deps;
  const router = express.Router();

router.get('/api/catalogo',     (_req, res) => res.json(leerJSON(CATALOGO_PATH, [])));

// ── Grupos del catálogo con config de activos ────────────────────────────────
router.get('/api/catalogo/grupos', (_req, res) => {
  const catalogo  = leerJSON(CATALOGO_PATH, []);
  const gruposCfg = leerJSON(GRUPOS_CFG_PATH, {});
  const cCfg      = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  const mapa = new Map();
  for (const item of catalogo) {
    const ref = item.productoRef || '';
    if (!mapa.has(ref)) mapa.set(ref, { productoRef: ref, total: 0, mayoristas: 0, presentaciones: new Set() });
    const g = mapa.get(ref);
    g.total++;
    g.presentaciones.add(item.presentacion);
    if (esMayorista(item)) g.mayoristas++;
  }
  const grupos = [...mapa.values()].sort((a, b) => a.productoRef.localeCompare(b.productoRef)).map(g => ({
    productoRef:  g.productoRef,
    totalPlu:     g.total,
    presentaciones: g.presentaciones.size,
    mayoristas:   g.mayoristas,
    activo:       cfgActivo(gruposCfg, g.productoRef),
    granelPlu:    cfgGranelPlu(gruposCfg, g.productoRef),
    granelPlus:   cfgGranelPlus(gruposCfg, g.productoRef),
    mpManual:     cfgMpManual(gruposCfg, g.productoRef),
    esGranel:        cfgEsGranel(gruposCfg, g.productoRef, cCfg.gruposGranel),
    granelDirecto:   cfgGranelOverride(gruposCfg, g.productoRef),
    esMiel:          cfgEsMiel(gruposCfg, g.productoRef),
    reqGranel:       cfgReqGranel(gruposCfg, g.productoRef),
    ventaPorUnidad:  cfgVentaPorUnidad(gruposCfg, g.productoRef)
  }));
  res.json(grupos);
});

router.post('/api/catalogo/grupos-config', (req, res) => {
  const cfg = req.body;
  if (typeof cfg !== 'object' || Array.isArray(cfg))
    return res.status(400).json({ error: 'Se esperaba un objeto' });
  // Normalizar: si un entry es {activo:true, granelPlu:''} → true (compactar)
  const normalizado = {};
  for (const [k,v] of Object.entries(cfg)) {
    if (v && typeof v === 'object') {
      const a = v.activo !== false;
      // Lista de graneles; granelPlu se mantiene sincronizado con el primero.
      const gl = [...new Set((Array.isArray(v.granelPlus) ? v.granelPlus : [])
        .map(x => String(x || '').trim()).filter(Boolean))];
      const g = gl[0] || String(v.granelPlu||'').trim();
      const mp = Array.isArray(v.mpManual) ? v.mpManual.filter(x => x && x.nombre) : [];
      const gd = (typeof v.granelDirecto === 'boolean') ? v.granelDirecto : undefined;
      const em = (typeof v.esMiel === 'boolean') ? v.esMiel : undefined;
      const rg = (v.reqGranel === true) ? true : undefined;
      const vu = (v.ventaPorUnidad === true) ? true : undefined;
      if (!g && !mp.length && gd === undefined && em === undefined && rg === undefined && vu === undefined) { normalizado[k] = a; }
      else { normalizado[k] = {activo:a, ...(g?{granelPlu:g}:{}), ...(gl.length>1?{granelPlus:gl}:{}), ...(mp.length?{mpManual:mp}:{}), ...(gd!==undefined?{granelDirecto:gd}:{}), ...(em!==undefined?{esMiel:em}:{}), ...(rg?{reqGranel:true}:{}), ...(vu?{ventaPorUnidad:true}:{})}; }
    } else { normalizado[k] = v; }
  }
  guardarJSON(GRUPOS_CFG_PATH, normalizado);
  res.json({ ok: true });
});

router.get('/api/catalogo/grupo/:ref', (req, res) => {
  const ref      = decodeURIComponent(req.params.ref);
  const catalogo = leerJSON(CATALOGO_PATH, []);
  const items    = catalogo.filter(i => i.productoRef === ref);
  res.json(items);
});

router.put('/api/catalogo/grupo/:ref', (req, res) => {
  const ref      = decodeURIComponent(req.params.ref);
  const nuevos   = req.body;
  if (!Array.isArray(nuevos)) return res.status(400).json({ error: 'Se esperaba un array' });
  // Cada código: PLU entero > 0, con presentación, y una sola vez en el grupo (un PLU en dos
  // presentaciones contaría sus ventas dos veces).
  const vistos = new Set();
  for (const i of nuevos) {
    const plu = Number(i && i.plu);
    if (!Number.isInteger(plu) || plu <= 0) return res.status(400).json({ error: `PLU inválido: ${i && i.plu}` });
    if (!String(i.presentacion ?? '').trim()) return res.status(400).json({ error: `El PLU ${plu} no tiene presentación` });
    if (vistos.has(plu)) return res.status(400).json({ error: `El PLU ${plu} está repetido en el grupo` });
    vistos.add(plu);
  }
  const catalogo = leerJSON(CATALOGO_PATH, []);
  const otros    = catalogo.filter(i => i.productoRef !== ref);
  // refId debe ser 1:1 con productoRef (clave de agrupación en buildCatalogoMaps).
  // El editor manda refId stale/null en grupos nuevos → no confiar en el del cliente:
  // reutilizar el refId existente de este grupo, o asignar uno único (máx + 1).
  let refId = catalogo.find(i => i.productoRef === ref && i.refId != null)?.refId;
  if (refId == null) {
    const maxRef = catalogo.reduce((m, i) => Math.max(m, Number(i.refId) || 0), 0);
    refId = maxRef + 1;
  }
  // ventaPorUnidad (mayorista que se vende por unidad) solo vale en mayoristas: true o ausente.
  const normalizados = nuevos.map(({ ventaPorUnidad, ...i }) => ({ ...i, plu: Number(i.plu), presentacion: String(i.presentacion).trim(), refId, productoRef: ref,
    ...(ventaPorUnidad === true && esMayorista(i) ? { ventaPorUnidad: true } : {}) }));
  guardarJSON(CATALOGO_PATH, [...otros, ...normalizados]);
  res.json({ ok: true, productos: normalizados.length });
});

// ── Importar catálogo desde Excel ─────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function normalizarNombre(nombre) {
  let n = nombre.trim();
  n = n.replace(/\s+pack\b.*$/i,  '').trim();
  n = n.replace(/\s+bulto\b.*$/i, '').trim();
  n = n.replace(/\bvid\s+/i,      '').trim();
  n = n.replace(/\s+vid$/i,       '').trim();
  return n.trim();
}
const PRES_RE = /(\d+(?:[.,]\d+)?\s*(?:G|Kg|Ml|L|g|kg|ml|l))(?:\s+\w+)*$/i;
function extraerPresentacion(base) {
  const m = PRES_RE.exec(base);
  if (!m) return base;
  return m[0].trim().replace(/\bkg\b/i, 'Kg').replace(/\bg\b/i, 'G');
}

router.post('/api/catalogo/importar', upload.single('archivo'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Falta el archivo Excel' });
    const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    const filas = [];
    for (let i = 1; i < rows.length; i++) {
      const [plu, producto, refId, productoRef] = rows[i];
      if (plu == null || producto == null) continue;
      const pluInt = parseInt(plu);
      if (isNaN(pluInt)) continue;
      const nombreOrig   = String(producto).trim();
      const base         = normalizarNombre(nombreOrig);
      const presentacion = extraerPresentacion(base);
      const mayorista    = /\b(pack|bulto|vid)\b/i.test(nombreOrig);
      filas.push({
        plu: pluInt, producto: nombreOrig, baseNombre: base, presentacion, esMayorista: mayorista,
        refId: refId != null ? parseInt(refId) : null,
        productoRef: productoRef != null ? String(productoRef).trim() : ''
      });
    }
    guardarJSON(CATALOGO_PATH, filas);
    res.json({ ok: true, productos: filas.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

  return router;
};
