'use strict';
const express = require('express');
const path = require('path');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const preciosProv = require('../lib/precios_proveedores');

// ── Rutas del módulo Precios de Proveedores ──────────────────────────────────
// Extraídas de server.js sin cambios de comportamiento: mismas rutas, mismo orden
// relativo entre ellas y mismas queries. Los bloques movidos conservan la
// indentación original a propósito: reindentar cambiaría el texto de los SQL
// multilínea, que son template literals.
//
// precios_proveedores.js es lógica pura sin estado: se requiere directo. Lo que
// vive en server.js (pool SQL, disco, DATA_DIR) entra por deps.
//
// El módulo se lleva todo lo suyo: los helpers de disco (leerPreciosProv,
// guardarPreciosProv) con su PRECIOS_PROV_PATH, las tres queries del universo de
// compra (universoParaCompra, ultimoProveedorPorProducto, historialComprasAnio),
// el contextoMatching y las guardas de SSRF de /parse-url (IPV4_PRIVADA,
// ipv4DesdeMapeadaV6, urlPermitida, fetchConRedirectSeguro). Ninguno tiene un solo
// uso fuera de estas rutas: la lista de precios de un proveedor sólo se lee y se
// escribe acá.
module.exports = function crearRutasPreciosProveedores(deps) {
  const { apiRoute, query, leerJSON, guardarJSON, DATA_DIR } = deps;
  const router = express.Router();

// ── Precios de Proveedores ─────────────────────────────────────────────────────
const PRECIOS_PROV_PATH = path.join(DATA_DIR, 'precios_proveedores.json');
const PRECIOS_PROV_DEF = { toleranciaPct: 2, proveedores: [] };
function leerPreciosProv() { return leerJSON(PRECIOS_PROV_PATH, PRECIOS_PROV_DEF); }
function guardarPreciosProv(d) { guardarJSON(PRECIOS_PROV_PATH, d); }

// Universo paraCompra (EsDeCompras=1, Activo=1) + costo actual de la central + código de barras.
async function universoParaCompra() {
  const rows = await query(`
    SELECT p.IdProducto, p.NombreProducto, p.CodigoDeBarras,
           CAST(ps.PrecioCosto AS FLOAT) AS PrecioCosto
    FROM Productos p
    LEFT JOIN ProductosSucursales ps ON ps.IdProducto = p.IdProducto
      AND ps.IdSucursal = (SELECT MIN(IdSucursal) FROM Sucursales WHERE SoyLaCentral = 1)
    WHERE p.EsDeCompras = 1 AND p.Activo = 1`);
  return rows.map(r => ({
    plu: String(r.IdProducto), nombre: r.NombreProducto,
    barras: String(r.CodigoDeBarras || '').trim(),
    costo: r.PrecioCosto != null ? +r.PrecioCosto : null,
  }));
}

// plu → { proveedor, precio, fecha } del proveedor con última fecha de compra.
async function ultimoProveedorPorProducto() {
  const rows = await query(`
    SELECT pp.IdProducto, pv.NombreProveedor, CAST(pp.UltimoPrecioCompra AS FLOAT) AS Precio,
           CONVERT(varchar(10), pp.UltimaFechaCompra, 23) AS Fecha
    FROM ProductosProveedores pp
    JOIN Proveedores pv ON pv.IdProveedor = pp.IdProveedor
    WHERE pp.UltimaFechaCompra IS NOT NULL
    ORDER BY pp.IdProducto, pp.UltimaFechaCompra DESC`);
  const map = new Map();
  for (const r of rows) {
    const id = String(r.IdProducto);
    if (!map.has(id)) map.set(id, { proveedor: r.NombreProveedor, precio: r.Precio, fecha: r.Fecha });
  }
  return map;
}

// plu → [{proveedor, fecha (última), precio (de la última compra), cantidad (total)}] del año en curso.
//
// El JOIN lleva IdProveedor porque es la sexta columna de la PK de Compras y de
// ComprasProductos. Sin ella las filas se multiplicaban: cada proveedor numera sus
// cotizaciones desde 1, así que la clave de 5 columnas se repite entre proveedores y
// aparecían cientos de "proveedores" falsos por producto. Ese era el motivo real; el
// NOT LIKE 'COTIZACION%' tapaba el síntoma y acá se conserva sólo porque este módulo
// compara precios de compra efectiva, donde una cotización no es un precio pagado.
async function historialComprasAnio() {
  const inicio = `${new Date().getFullYear()}-01-01`;
  const rows = await query(`
    SELECT cp.IdProducto, pv.NombreProveedor,
           CONVERT(varchar(10), c.Fecha, 23) AS Fecha,
           CAST(cp.Precio AS FLOAT) AS Precio, CAST(cp.Cantidad AS FLOAT) AS Cantidad
    FROM ComprasProductos cp
    JOIN Compras c ON c.IdSucursal = cp.IdSucursal AND c.IdTipoComprobante = cp.IdTipoComprobante
      AND c.Letra = cp.Letra AND c.CentroEmisor = cp.CentroEmisor AND c.NumeroComprobante = cp.NumeroComprobante
      AND c.IdProveedor = cp.IdProveedor
    JOIN Proveedores pv ON pv.IdProveedor = c.IdProveedor
    WHERE c.Fecha >= '${inicio}' AND c.IdTipoComprobante NOT LIKE 'COTIZACION%'
    ORDER BY cp.IdProducto, c.Fecha DESC`);
  const map = new Map();
  for (const r of rows) {
    const id = String(r.IdProducto);
    if (!map.has(id)) map.set(id, new Map());
    const prov = map.get(id);
    if (!prov.has(r.NombreProveedor)) {
      prov.set(r.NombreProveedor, { proveedor: r.NombreProveedor, fecha: r.Fecha, precio: r.Precio, cantidad: r.Cantidad || 0 });
    } else {
      prov.get(r.NombreProveedor).cantidad += r.Cantidad || 0;
    }
  }
  const out = new Map();
  for (const [id, provs] of map) out.set(id, [...provs.values()]);
  return out;
}

router.get('/precios-proveedores', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'precios_proveedores.html')));

router.get('/api/precios-proveedores/listado', apiRoute(async () => {
  const [universo, ultimo, historial] = await Promise.all([
    universoParaCompra(), ultimoProveedorPorProducto(), historialComprasAnio(),
  ]);
  const productos = universo.map(p => {
    const u = ultimo.get(p.plu) || {};
    return {
      plu: p.plu, nombre: p.nombre, costo: p.costo,
      ultimoProveedor: u.proveedor || null, ultimoPrecio: u.precio || null, ultimaFecha: u.fecha || null,
      proveedoresAnio: historial.get(p.plu) || [],
    };
  });
  return { productos, total: productos.length, fechaCalculo: new Date().toISOString() };
}));

router.get('/api/precios-proveedores/proveedores', apiRoute(async () => leerPreciosProv()));

router.get('/api/precios-proveedores/proveedores-siga', apiRoute(async (req) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return { proveedores: [] };
  const like = q.replace(/'/g, "''");
  const rows = await query(`SELECT IdProveedor, NombreProveedor FROM Proveedores
    WHERE NombreProveedor LIKE '%${like}%' ORDER BY NombreProveedor`);
  return { proveedores: rows.map(r => ({ idProveedorSiga: Number(r.IdProveedor), nombre: r.NombreProveedor })) };
}));

router.post('/api/precios-proveedores/proveedores', apiRoute(async (req) => {
  const { idProveedorSiga, nombre, url } = req.body || {};
  const idNum = Number(idProveedorSiga);
  if (!Number.isFinite(idNum) || idNum <= 0 || !nombre) throw new Error('Proveedor inválido: falta idProveedorSiga o nombre');
  const data = leerPreciosProv();
  const id = `prov-${idNum}`;
  if (data.proveedores.some(p => p.id === id)) throw new Error('El proveedor ya tiene tab');
  const nuevo = { id, idProveedorSiga: idNum, nombre: String(nombre), url: url ? String(url) : '', listaVigente: null, matcheosManuales: {} };
  guardarPreciosProv({ ...data, proveedores: [...data.proveedores, nuevo] });
  return nuevo;
}));

router.delete('/api/precios-proveedores/proveedores/:id', apiRoute(async (req) => {
  const data = leerPreciosProv();
  const quedan = data.proveedores.filter(p => p.id !== req.params.id);
  if (quedan.length === data.proveedores.length) throw new Error('Proveedor no encontrado');
  guardarPreciosProv({ ...data, proveedores: quedan });
  return { ok: true };
}));

// Contexto para matchearItems: códigos del proveedor en SIGA + barras + catálogo del universo.
async function contextoMatching(idProveedorSiga, matcheosManuales) {
  const universo = await universoParaCompra();
  const catalogo = universo.map(p => ({ plu: p.plu, nombre: p.nombre }));
  const barras = new Map(universo.filter(p => p.barras).map(p => [p.barras, p.plu]));
  const codigosProveedor = new Map();
  const idNum = Number(idProveedorSiga);
  if (Number.isFinite(idNum) && idNum > 0) {
    const rows = await query(`SELECT IdProducto, CodigoProductoProveedor FROM ProductosProveedores
      WHERE IdProveedor = ${idNum} AND LTRIM(RTRIM(ISNULL(CodigoProductoProveedor,''))) <> ''`);
    for (const r of rows) codigosProveedor.set(String(r.CodigoProductoProveedor).trim(), String(r.IdProducto));
  }
  return { matcheosManuales: matcheosManuales || {}, codigosProveedor, barras, catalogo };
}

const IPV4_PRIVADA = /^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^0\.|^169\.254\./;

// "::ffff:7f00:1" (forma que usa el parser URL de Node) → "127.0.0.1", o null si no matchea.
function ipv4DesdeMapeadaV6(h) {
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h);
  if (!m) return null;
  const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

// Solo http/https públicas — bloquea localhost, rangos privados IPv4/IPv6 y metadata de nube (SSRF).
function urlPermitida(u) {
  let parsed;
  try { parsed = new URL(String(u)); } catch { return false; }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  let h = parsed.hostname.toLowerCase();
  if (h === 'localhost') return false;
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1); // literal IPv6
  if (IPV4_PRIVADA.test(h)) return false;
  const v4Mapeada = ipv4DesdeMapeadaV6(h);
  if (v4Mapeada && IPV4_PRIVADA.test(v4Mapeada)) return false;
  if (h === '::1' || h === '::' || /^fe80:/.test(h) || /^f[cd][0-9a-f]{2}:/.test(h)) return false; // loopback/link-local/ULA IPv6
  return true;
}

// fetch con seguimiento manual de redirects, revalidando cada salto contra urlPermitida (evita bypass de SSRF vía 3xx).
async function fetchConRedirectSeguro(url, opts, maxRedirects = 3) {
  let actual = url;
  for (let i = 0; i <= maxRedirects; i++) {
    if (!urlPermitida(actual)) throw new Error('Redirect hacia una URL no permitida');
    const resp = await fetch(actual, { ...opts, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const loc = resp.headers.get('location');
      if (!loc) throw new Error('Redirect sin encabezado Location');
      actual = new URL(loc, actual).toString();
      continue;
    }
    return resp;
  }
  throw new Error('Demasiados redirects');
}

const uploadPreciosPdf = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.post('/api/precios-proveedores/parse-pdf', uploadPreciosPdf.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(422).json({ error: 'Falta el archivo PDF (campo "pdf")' });
    const data = leerPreciosProv();
    const prov = data.proveedores.find(p => p.id === String(req.body.id || ''));
    if (!prov) return res.status(422).json({ error: 'Proveedor no encontrado' });
    let texto = '';
    try { texto = (await pdfParse(req.file.buffer)).text || ''; }
    catch { return res.status(422).json({ error: 'PDF corrupto o ilegible' }); }
    if (!texto.trim()) return res.status(422).json({ error: 'PDF sin texto extraíble (¿escaneado? OCR fuera de alcance)' });
    const { items, descartadas } = preciosProv.parsearTextoPdf(texto);
    if (!items.length) return res.status(422).json({ error: 'No se detectaron líneas con precio en el PDF', descartadas });
    const ctx = await contextoMatching(prov.idProveedorSiga, prov.matcheosManuales);
    res.json({ items: preciosProv.matchearItems(items, ctx), descartadas });
  } catch (err) { console.error(err.message); res.status(500).json({ error: err.message }); }
});

router.post('/api/precios-proveedores/parse-url', async (req, res) => {
  try {
    const { url, id } = req.body || {};
    if (!urlPermitida(url)) return res.status(422).json({ error: 'URL inválida (solo http/https públicas)' });
    const data = leerPreciosProv();
    const prov = data.proveedores.find(p => p.id === String(id || ''));
    if (!prov) return res.status(422).json({ error: 'Proveedor no encontrado' });
    let html = '';
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const resp = await fetchConRedirectSeguro(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (ApideltaSubSystem)' } });
      clearTimeout(t);
      if (!resp.ok) return res.status(422).json({ error: `La página respondió ${resp.status}` });
      html = await resp.text();
    } catch { return res.status(422).json({ error: 'No se pudo acceder a la URL (timeout o red)' }); }
    const { items, descartadas } = preciosProv.parsearHtml(html);
    if (!items.length) return res.status(422).json({ error: 'No se encontraron tablas con precios en la página', descartadas });
    const ctx = await contextoMatching(prov.idProveedorSiga, prov.matcheosManuales);
    res.json({ items: preciosProv.matchearItems(items, ctx), descartadas });
  } catch (err) { console.error(err.message); res.status(500).json({ error: err.message }); }
});

const MATCH_TIPOS_VALIDOS = new Set(['manual', 'codigo', 'barras', 'nombre']);

router.put('/api/precios-proveedores/proveedores/:id/lista', apiRoute(async (req) => {
  const { origen, items, matcheosManuales } = req.body || {};
  if (!['pdf', 'url', 'manual'].includes(origen)) throw new Error('Origen inválido (pdf|url|manual)');
  if (!Array.isArray(items) || !items.length) throw new Error('La lista no tiene items');
  const limpios = items.map(it => {
    const precio = Number(it.precio);
    if (!Number.isFinite(precio) || precio <= 0) throw new Error(`Precio inválido en "${it.descripcion || it.codigoProveedor || '?'}"`);
    if (!it.descripcion) throw new Error('Item sin descripción');
    return {
      codigoProveedor: String(it.codigoProveedor || ''), descripcion: String(it.descripcion),
      precio, plu: it.plu != null && it.plu !== '' ? String(it.plu) : null,
      matchTipo: MATCH_TIPOS_VALIDOS.has(it.matchTipo) ? it.matchTipo : null, matchScore: Number(it.matchScore) || 0,
    };
  });
  const data = leerPreciosProv();
  const i = data.proveedores.findIndex(p => p.id === req.params.id);
  if (i < 0) throw new Error('Proveedor no encontrado');
  const prov = data.proveedores[i];
  const manuales = { ...prov.matcheosManuales };
  if (matcheosManuales && typeof matcheosManuales === 'object') {
    for (const [cod, plu] of Object.entries(matcheosManuales)) if (cod && plu) manuales[String(cod)] = String(plu);
  }
  const actualizado = {
    ...prov, matcheosManuales: manuales,
    listaVigente: { fechaCarga: new Date().toISOString(), origen, items: limpios },
  };
  guardarPreciosProv({ ...data, proveedores: data.proveedores.map((p, j) => (j === i ? actualizado : p)) });
  return actualizado;
}));

router.get('/api/precios-proveedores/proveedores/:id/comparacion', apiRoute(async (req) => {
  const data = leerPreciosProv();
  const prov = data.proveedores.find(p => p.id === req.params.id);
  if (!prov) throw new Error('Proveedor no encontrado');
  if (!prov.listaVigente) return { proveedor: prov.nombre, fechaCarga: null, origen: null, filas: [], sinMatchear: [] };
  const [universo, ultimo] = await Promise.all([universoParaCompra(), ultimoProveedorPorProducto()]);
  const porPlu = new Map(universo.map(p => [p.plu, p]));
  const filas = [], sinMatchear = [];
  for (const it of prov.listaVigente.items) {
    if (!it.plu || !porPlu.has(it.plu)) { sinMatchear.push(it); continue; }
    const p = porPlu.get(it.plu), u = ultimo.get(it.plu) || {};
    const cmp = preciosProv.compararItem({ precioLista: it.precio, costoActual: p.costo, toleranciaPct: data.toleranciaPct });
    filas.push({ ...it, nombreSiga: p.nombre, costoActual: p.costo, ultimoPagado: u.precio || null, ...cmp });
  }
  return { proveedor: prov.nombre, fechaCarga: prov.listaVigente.fechaCarga, origen: prov.listaVigente.origen, filas, sinMatchear };
}));

  return router;
};
