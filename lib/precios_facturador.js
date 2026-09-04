'use strict';
// Planilla de precios del facturador que vive en una carpeta compartida de la red.
// Es la fuente de respaldo cuando SQL no responde: la exporta la macro de SiGA con las
// columnas IdProducto / NombreProducto / CodigoDeBarras / PrecioVenta, pero el detector
// de columnas es por nombre para que un cambio de orden o de prefijo no la rompa.
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const FILAS_A_MIRAR = 10;      // encabezado: sólo puede estar en las primeras filas
const LARGO_BARRA_MINIMO = 7;  // "0", "1" y los códigos de 2-3 dígitos son restos de carga

const COLUMNAS = {
  plu:    /idproducto|(^|\.)codigo$|^plu$/i,
  nombre: /nombreproducto|(^|\.)nombre|descripcion/i,
  precio: /precioventa|(^|\.)precio/i,
  barra:  /codigodebarras|codigobarra|(^|\.)barra|ean/i,
};

const limpiar = v => String(v == null ? '' : v).trim();

// "1.234,56" | "1234.56" | "$ 1.234" → número, o null. El separador que aparece último
// es el decimal; sin coma, un punto con más de 2 decimales es separador de miles.
function parsearPrecio(valor) {
  let s = limpiar(valor).replace(/^\$\s*/, '').replace(/\s/g, '');
  if (!s || !/^-?\d[\d.,]*$/.test(s)) return null;
  const p = s.lastIndexOf('.'), c = s.lastIndexOf(',');
  if (p >= 0 && c >= 0) s = c > p ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (c >= 0) s = s.slice(c + 1).length <= 2 ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (p >= 0 && s.slice(p + 1).length > 2) s = s.replace(/\./g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

// Devuelve { filaEncabezado, plu, nombre, precio, barra } o null si no se reconoce nada.
// La primera fila que tenga nombre y precio gana: sin esas dos no hay catálogo posible.
function detectarColumnas(grilla) {
  for (let f = 0; f < Math.min(grilla.length, FILAS_A_MIRAR); f++) {
    const fila = grilla[f] || [];
    const cols = { filaEncabezado: f, plu: null, nombre: null, precio: null, barra: null };
    fila.forEach((celda, i) => {
      const txt = limpiar(celda);
      if (!txt) return;
      for (const clave of ['plu', 'nombre', 'precio', 'barra']) {
        if (cols[clave] == null && COLUMNAS[clave].test(txt)) { cols[clave] = i; return; }
      }
    });
    if (cols.nombre != null && cols.precio != null) return cols;
  }
  return null;
}

// Mismo shape que /api/facturador/catalogo, para que el facturador no distinga la fuente.
// La planilla no trae modalidad de balanza ni unidad: eso sólo lo sabe SQL.
function filasACatalogo(grilla, cols) {
  const productos = [];
  for (let f = cols.filaEncabezado + 1; f < grilla.length; f++) {
    const fila = grilla[f] || [];
    const nombre = limpiar(fila[cols.nombre]);
    const precio = parsearPrecio(fila[cols.precio]);
    if (!nombre || precio == null) continue;
    const barra = cols.barra == null ? '' : limpiar(fila[cols.barra]).replace(/\D/g, '');
    productos.push({
      plu: cols.plu == null ? '' : limpiar(fila[cols.plu]),
      nombre,
      precio,
      barra: barra.length >= LARGO_BARRA_MINIMO ? barra : '',
      modalidad: null,
      unidad: '',
    });
  }
  return productos;
}

// La más nueva por fecha de modificación. La carpeta junta la planilla vigente con la macro
// que la genera, conexiones .odc y archivos viejos: el .xlsm queda afuera a propósito
// (tiene sus propias hojas de trabajo y una la lee como si fuera el catálogo, con la mitad
// de los productos), y los ~$ son los temporales que deja Excel mientras está abierto.
function planillaMasNueva(dir) {
  const archivos = fs.readdirSync(dir)
    .filter(n => /\.(xlsx|xls|csv)$/i.test(n) && !n.startsWith('~$'))
    .map(n => ({ nombre: n, ruta: path.join(dir, n), mtime: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!archivos.length) throw new Error(`No hay planillas (.xlsx/.csv) en ${dir}`);
  return archivos[0];
}

// `ruta` puede ser la carpeta compartida o directamente la planilla, por si algún día
// conviven varias en la misma carpeta y hay que fijar cuál.
function catalogoDeDirectorio(ruta) {
  const st = fs.statSync(ruta);
  const archivo = st.isDirectory()
    ? planillaMasNueva(ruta)
    : { nombre: path.basename(ruta), ruta, mtime: st.mtimeMs };
  const wb = XLSX.readFile(archivo.ruta);
  const hoja = wb.Sheets[wb.SheetNames[0]];
  const grilla = XLSX.utils.sheet_to_json(hoja, { header: 1, raw: false, defval: '' });
  const cols = detectarColumnas(grilla);
  if (!cols) throw new Error(`No se reconocieron las columnas de nombre y precio en ${archivo.nombre}`);
  const productos = filasACatalogo(grilla, cols);
  if (!productos.length) throw new Error(`${archivo.nombre} no tiene filas con nombre y precio`);
  return {
    generado: new Date(archivo.mtime).toISOString(),
    origen: `archivo de red: ${archivo.nombre}`,
    productos,
  };
}

module.exports = { parsearPrecio, detectarColumnas, filasACatalogo, planillaMasNueva, catalogoDeDirectorio };
