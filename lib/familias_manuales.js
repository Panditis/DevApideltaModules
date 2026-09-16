'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Familias manuales de producto — módulo puro (sin I/O ni SQL exec)
//  El usuario arma los grupos a mano: un nombre y una lista de códigos de SIGA.
//  Es otra cosa que las familias de analisis_ventas.js, que se deducen del nombre
//  del producto y no se pueden editar: acá el criterio de agrupación es comercial
//  ("Mieles premium", "Línea sin TACC") y sólo lo sabe quien lo define.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_FAMILIAS = 60;
const MAX_PRODUCTOS = 400;
const LARGO_NOMBRE = 60;
const LARGO_NOMBRE_PROD = 120;
const LARGO_ID = 30;

function textoCorto(v, max) {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Normaliza lo que manda el front antes de escribirlo al JSON: recorta, saca duplicados
// y descarta lo que no tiene nombre. El archivo lo lee después el endpoint de ventas para
// armar el IN () de la consulta, así que lo que entra sucio termina en el SQL.
function familiasSanitizadas(raw) {
  const lista = Array.isArray(raw) ? raw : [];
  const nombresVistos = new Set();
  const salida = [];
  for (const f of lista.slice(0, MAX_FAMILIAS)) {
    const nombre = textoCorto(f && f.nombre, LARGO_NOMBRE);
    if (!nombre) continue;
    // Dos familias con el mismo nombre serían dos barras indistinguibles en el gráfico.
    const clave = nombre.toLowerCase();
    if (nombresVistos.has(clave)) continue;
    nombresVistos.add(clave);
    salida.push({
      nombre,
      activo: Boolean(f && f.activo),
      productos: productosSanitizados(f && f.productos),
    });
  }
  // "Semana activa" es exclusiva: si vino más de un grupo marcado, gana el primero
  // y el resto se apaga (evita que el front tenga que decidir cuál mostrar).
  let yaHuboActivo = false;
  salida.forEach(f => {
    if (!f.activo) return;
    if (yaHuboActivo) { f.activo = false; return; }
    yaHuboActivo = true;
  });
  return salida;
}

function productosSanitizados(raw) {
  const vistos = new Set();
  const salida = [];
  for (const p of (Array.isArray(raw) ? raw : [])) {
    // Se acepta tanto {id,nombre} como el {codigo,nombre} que devuelve /api/productos/buscar.
    const id = textoCorto(p && typeof p === 'object' ? (p.id ?? p.codigo) : p, LARGO_ID);
    if (!id || vistos.has(id)) continue;
    vistos.add(id);
    salida.push({ id, nombre: textoCorto(p && p.nombre, LARGO_NOMBRE_PROD) });
    if (salida.length >= MAX_PRODUCTOS) break;
  }
  return salida;
}

// Todos los códigos de todas las familias, sin repetir: es el universo que se consulta una
// sola vez y después se reparte. Un producto puede estar en más de una familia y se cuenta
// en cada una (agrupar a mano no obliga a particionar el catálogo).
function idsDeFamilias(familias) {
  const ids = new Set();
  (familias || []).forEach(f => (f.productos || []).forEach(p => {
    const id = textoCorto(p && typeof p === 'object' ? (p.id ?? p.codigo) : p, LARGO_ID);
    if (id) ids.add(id);
  }));
  return [...ids];
}

// El grupo marcado como "semana activa" (si hay uno): nombre e ids de sus productos,
// para que el endpoint y la UI no tengan que buscar el flag por su cuenta.
function idsDeGrupoActivo(familias) {
  const activo = (familias || []).find(f => f.activo);
  if (!activo) return { nombre: null, ids: [] };
  return { nombre: activo.nombre, ids: (activo.productos || []).map(p => String(p.id)) };
}

function celdaVacia() {
  return { unidades: 0, facturacion: 0 };
}

// Reparte las filas {IdProducto, IdSucursal, Nombre, Unidades, Facturacion} en las familias
// definidas. Cada familia trae su total, el desglose por sucursal (todas las pedidas, con
// cero si no vendió: el gráfico necesita la columna igual) y el detalle por producto.
function agruparVentas(rows, familias, sucIds) {
  const sucursales = (sucIds || []).map(Number);
  // Un producto puede repetirse en varias familias, así que el índice es id -> [destinos].
  const porProducto = new Map();
  const grupos = (familias || []).map(f => {
    const g = {
      nombre: f.nombre,
      total: celdaVacia(),
      porSucursal: Object.fromEntries(sucursales.map(id => [id, celdaVacia()])),
      // Cada producto lleva su propio desglose por sucursal: el SQL ya viene a ese nivel y
      // colapsarlo obligaría a una segunda consulta para el gráfico de producto.
      productos: (f.productos || []).map(p => ({
        id: String(p.id), nombre: p.nombre || '', unidades: 0, facturacion: 0,
        porSucursal: Object.fromEntries(sucursales.map(id => [id, celdaVacia()])),
      })),
    };
    g.productos.forEach(p => {
      if (!porProducto.has(p.id)) porProducto.set(p.id, []);
      porProducto.get(p.id).push({ grupo: g, prod: p });
    });
    return g;
  });

  (rows || []).forEach(r => {
    const destinos = porProducto.get(String(r.IdProducto ?? '').trim());
    if (!destinos) return;
    const suc = Number(r.IdSucursal);
    const unidades = Number(r.Unidades || 0);
    const facturacion = Number(r.Facturacion || 0);
    destinos.forEach(({ grupo, prod }) => {
      // El nombre lo pisa el de SIGA: el guardado en el JSON puede haber quedado viejo.
      if (r.Nombre) prod.nombre = String(r.Nombre);
      prod.unidades += unidades;
      prod.facturacion += facturacion;
      grupo.total.unidades += unidades;
      grupo.total.facturacion += facturacion;
      // Una sucursal fuera del filtro no puede llegar (el SQL ya la excluye), pero si
      // llegara suma al total y no rompe el desglose.
      const celda = grupo.porSucursal[suc];
      if (celda) { celda.unidades += unidades; celda.facturacion += facturacion; }
      const celdaProd = prod.porSucursal[suc];
      if (celdaProd) { celdaProd.unidades += unidades; celdaProd.facturacion += facturacion; }
    });
  });

  grupos.forEach(g => g.productos.sort((a, b) => b.facturacion - a.facturacion));
  return grupos.sort((a, b) => b.total.facturacion - a.total.facturacion);
}

// Total vendido por sucursal sumando todas las familias: es la fila de cierre de la tabla.
function totalesPorSucursal(grupos, sucIds) {
  return (sucIds || []).map(Number).map(id => {
    const celda = (grupos || []).reduce((acc, g) => {
      const c = g.porSucursal[id] || celdaVacia();
      return { unidades: acc.unidades + c.unidades, facturacion: acc.facturacion + c.facturacion };
    }, celdaVacia());
    return { idSucursal: id, ...celda };
  });
}

module.exports = {
  MAX_FAMILIAS, MAX_PRODUCTOS,
  familiasSanitizadas, productosSanitizados, idsDeFamilias, idsDeGrupoActivo,
  agruparVentas, totalesPorSucursal,
};
