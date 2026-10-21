'use strict';
// ── Carteles Pesables ─────────────────────────────────────────────────────────
// Réplica de la planilla Excel (con macros) que arma los carteles de precio de los
// pesables fraccionados en bolsa. SIGA guarda el precio por kilo; el cartel muestra
// el precio de la bolsa: precio/kg × peso de la bolsa, que sale del nombre.
// Todo puro: la consulta a SIGA vive en routes/rutas_carteles_pesables.js.

// Tokens del nombre → peso de la bolsa en kg. Copia fiel de la tabla del Excel,
// errores incluidos: la búsqueda es case-sensitive (FIND) y los espacios iniciales
// son parte del token (" 50G" no matchea dentro de "250G", pero "20G" sí dentro de "120G").
// " 2KG", " 5KG" y "10KG" valen 1 a propósito: en el Excel esas bolsas grandes se cartelean por kilo.
const TOKENS_PESO = Object.freeze([
  [' 1K', 1], ['500G', 0.5], [' 50G', 0.05], [' 30G', 0.03], ['100G', 0.1], ['200G', 0.2],
  ['250G', 0.25], ['150G', 0.15], ['70G', 0.07], ['75G', 0.075], ['20G', 0.02], ['80G', 0.08],
  ['60G', 0.06], ['400G', 0.4], ['10KG', 1], [' 2KG', 1], [' 5KG', 1], ['180G', 0.18],
].map(([token, kg]) => Object.freeze({ token, kg })));

// El máximo de los tokens que aparecen; ninguno → 1 (se cartelea el precio por kilo).
// La condición del Excel es posición > 0: un token al inicio del nombre no cuenta.
function multiplicadorPorNombre(nombre) {
  const texto = String(nombre || '');
  const pesos = TOKENS_PESO.filter(t => texto.indexOf(t.token) > 0).map(t => t.kg);
  return pesos.length ? Math.max(...pesos) : 1;
}

// ROUND de Excel: mitad lejos del cero. toPrecision(15) imita los 15 dígitos de Excel,
// así 14110*0.05 (705.5000000000001 en double) redondea igual que en la planilla.
function redondearExcel(x) {
  const limpio = Number(Number(x).toPrecision(15));
  return Math.sign(limpio) * Math.round(Math.abs(limpio));
}

// base = ROUND(barcode "20…" ? precio*mult : precio, 0); precio = MROUND(base, 10).
// Los códigos que arrancan con "20" son los de balanza (precio por kilo); el resto ya es por unidad.
function precioBolsa({ precioVenta, codigoDeBarras, nombre }) {
  const precio = Number(precioVenta) || 0;
  const porKilo = String(codigoDeBarras || '').trim().startsWith('20');
  const base = redondearExcel(porKilo ? precio * multiplicadorPorNombre(nombre) : precio);
  return redondearExcel(base / 10) * 10;
}

function nombreCartel(nombre) {
  return String(nombre || '').replace(/\(precio por kilo\)/gi, '').replace(/\s+/g, ' ').trim();
}

// mssql devuelve las fechas como Date en UTC (useUTC por defecto): el día se toma del ISO.
function fechaIso(valor) {
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : valor.toISOString().slice(0, 10);
  const m = /^\d{4}-\d{2}-\d{2}/.exec(String(valor || ''));
  return m ? m[0] : null;
}

// Fila de SIGA (IdProducto, NombreProducto, CodigoDeBarras, PrecioVenta, FechaActualizacion, Stock) → cartel.
// tipo 'almacen': precio de venta tal cual (unitario); el peso de bolsa y el redondeo a 10 son sólo de pesables,
// en almacén cambiarían el precio de caja.
function armarCartel(fila, tipo = 'pesables') {
  const nombre = fila.NombreProducto;
  const esPesable = tipo !== 'almacen';
  return {
    plu: String(fila.IdProducto ?? '').trim(),
    nombre: nombreCartel(nombre),
    precioKg: Number(fila.PrecioVenta) || 0,
    multiplicador: esPesable ? multiplicadorPorNombre(nombre) : 1,
    precio: esPesable
      ? precioBolsa({ precioVenta: fila.PrecioVenta, codigoDeBarras: fila.CodigoDeBarras, nombre })
      : redondearExcel(Number(fila.PrecioVenta) || 0),
    fechaActualizacion: fechaIso(fila.FechaActualizacion),
    stock: Number(fila.Stock) || 0,
  };
}

module.exports = { TOKENS_PESO, multiplicadorPorNombre, precioBolsa, nombreCartel, armarCartel };
