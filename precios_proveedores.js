'use strict';
// Módulo puro para Precios de Proveedores. Sin SQL ni fs — todo se inyecta por parámetros.
// Parsing de listas (texto PDF / HTML), matching a productos SIGA y comparación de precios.
const cheerio = require('cheerio');

const UMBRAL_NOMBRE = 0.6; // score mínimo de solapamiento de tokens para aceptar match por nombre

// "1.234,56" | "1234.56" | "$ 1.234" → número, o null si no es un número.
// Con punto y coma, el separador que aparece último es el decimal.
function parsearPrecioAR(token) {
  if (token == null) return null;
  let s = String(token).trim().replace(/^\$\s*/, '');
  if (!s || !/^\d[\d.,]*$/.test(s)) return null;
  const p = s.lastIndexOf('.'), c = s.lastIndexOf(',');
  if (p >= 0 && c >= 0) {
    s = c > p ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (c >= 0) {
    const dec = s.slice(c + 1);
    s = (s.indexOf(',') === c && dec.length <= 2) ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (p >= 0) {
    const dec = s.slice(p + 1);
    if (!(s.indexOf('.') === p && dec.length <= 2)) s = s.replace(/\./g, '');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Un token cuenta como precio si parsea Y (tiene separador, o es entero largo que no parece año).
// Evita que "2026" en un encabezado se lea como precio.
function esPrecioToken(tok) {
  const v = parsearPrecioAR(tok);
  if (v == null) return null;
  const s = String(tok).trim().replace(/^\$\s*/, '');
  const tieneSep = /[.,]/.test(s);
  if (!tieneSep && (s.length < 4 || (v >= 1900 && v <= 2100))) return null;
  return v;
}

const RE_CODIGO = /^[A-Za-z0-9][A-Za-z0-9\-._\/]{1,14}$/;

// Texto plano (de pdf-parse) → { items: [{codigoProveedor, descripcion, precio}], descartadas }.
// Heurística por línea: precio = último token numérico; código = primer token corto con dígito.
function parsearTextoPdf(texto) {
  const items = [];
  let descartadas = 0;
  for (const cruda of String(texto || '').split(/\r?\n/)) {
    const linea = cruda.trim();
    if (!linea) continue;
    const tokens = linea.split(/\s+/);
    if (tokens.length < 2) { descartadas++; continue; }
    let precio = null, iPrecio = -1;
    for (let i = tokens.length - 1; i >= 0; i--) {
      const v = esPrecioToken(tokens[i]);
      if (v != null) { precio = v; iPrecio = i; break; }
    }
    if (precio == null || iPrecio === 0) { descartadas++; continue; }
    const resto = tokens.slice(0, iPrecio);
    let codigoProveedor = '';
    if (resto.length > 1 && RE_CODIGO.test(resto[0]) && /\d/.test(resto[0])) codigoProveedor = resto.shift();
    const descripcion = resto.join(' ').trim();
    if (!descripcion) { descartadas++; continue; }
    items.push({ codigoProveedor, descripcion, precio });
  }
  return { items, descartadas };
}

// HTML → { items, descartadas }. Recorre <table>: precio = última celda numérica,
// código = primera celda si es corta y alfanumérica, descripción = el resto.
function parsearHtml(html) {
  const $ = cheerio.load(String(html || ''));
  const items = [];
  let descartadas = 0;
  $('table tr').each((_, tr) => {
    const celdas = $(tr).find('td,th').toArray().map(c => $(c).text().replace(/\s+/g, ' ').trim());
    if (celdas.length < 2) { if (celdas.length) descartadas++; return; }
    let precio = null, iPrecio = -1;
    for (let i = celdas.length - 1; i >= 0; i--) {
      const v = esPrecioToken(celdas[i]);
      if (v != null) { precio = v; iPrecio = i; break; }
    }
    if (precio == null) { descartadas++; return; }
    const resto = celdas.slice(0, iPrecio).filter(Boolean);
    if (!resto.length) { descartadas++; return; }
    let codigoProveedor = '';
    if (resto.length > 1 && RE_CODIGO.test(resto[0])) codigoProveedor = resto.shift();
    const descripcion = resto.join(' ').trim();
    if (!descripcion) { descartadas++; return; }
    items.push({ codigoProveedor, descripcion, precio });
  });
  return { items, descartadas };
}

// minúsculas, sin acentos, sin símbolos — para comparar nombres.
function normalizarNombre(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Solapamiento de tokens: intersección / máx(|a|,|b|). 0..1.
function scoreNombre(a, b) {
  const ta = new Set(normalizarNombre(a).split(' ').filter(Boolean));
  const tb = new Set(normalizarNombre(b).split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.max(ta.size, tb.size);
}

// Resuelve plu por: 1) matcheo manual, 2) código de proveedor SIGA, 3) código de barras,
// 4) nombre (score >= UMBRAL_NOMBRE). Sin match → plu null.
// ctx: { matcheosManuales: {cod→plu}, codigosProveedor: Map, barras: Map, catalogo: [{plu, nombre}] }
function matchearItems(items, ctx = {}) {
  const manuales = ctx.matcheosManuales || {};
  const codigos = ctx.codigosProveedor instanceof Map ? ctx.codigosProveedor : new Map(Object.entries(ctx.codigosProveedor || {}));
  const barras = ctx.barras instanceof Map ? ctx.barras : new Map(Object.entries(ctx.barras || {}));
  const catalogo = Array.isArray(ctx.catalogo) ? ctx.catalogo : [];
  return (Array.isArray(items) ? items : []).map(it => {
    const cod = String(it.codigoProveedor || '');
    if (cod && manuales[cod]) return { ...it, plu: String(manuales[cod]), matchTipo: 'manual', matchScore: 1 };
    if (cod && codigos.has(cod)) return { ...it, plu: String(codigos.get(cod)), matchTipo: 'codigo', matchScore: 1 };
    if (/^\d{8,14}$/.test(cod) && barras.has(cod)) return { ...it, plu: String(barras.get(cod)), matchTipo: 'barras', matchScore: 1 };
    let mejor = null, mejorScore = 0;
    for (const p of catalogo) {
      const s = scoreNombre(it.descripcion, p.nombre);
      if (s > mejorScore) { mejorScore = s; mejor = p; }
    }
    if (mejor && mejorScore >= UMBRAL_NOMBRE) return { ...it, plu: String(mejor.plu), matchTipo: 'nombre', matchScore: +mejorScore.toFixed(2) };
    return { ...it, plu: null, matchTipo: null, matchScore: 0 };
  });
}

module.exports = { UMBRAL_NOMBRE, parsearPrecioAR, parsearTextoPdf, parsearHtml, normalizarNombre, scoreNombre, matchearItems };
