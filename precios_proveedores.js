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

module.exports = { UMBRAL_NOMBRE, parsearPrecioAR, parsearTextoPdf };
