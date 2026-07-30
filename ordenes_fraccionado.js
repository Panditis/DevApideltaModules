'use strict';
// Validación, normalización y totales de las órdenes de fraccionado mayorista.
// Módulo puro a propósito: sin SQL ni lectura de archivos, así se puede testear con node:test.
// Lo consume el CRUD /api/mayoristas/ordenes-fraccionado de server.js.
//
// El granel es OPCIONAL. Cuando las líneas salían del endpoint automático de faltantes siempre
// había granel resuelto, pero ahora el armado es manual (el operador elige productos desde la tab
// "Resumen por cliente") y hay productos cuyo granel no se puede resolver: por ejemplo
// "Yerba Apidelta 2Kg Pack X 40", cuyo producto de carga "Yerba Apidelta PEDIDOS" no existe en
// Siga. Rechazar esas líneas hacía fallar el POST entero con 400 y bloqueaba toda la orden, así
// que se aceptan con granel vacío y aportan 0 kg a los totales.

// El granel se mide en kg con decimales; multiplicar en punto flotante deja colas
// (3 × 0.1 da 0.30000000000000004). Se recorta a 6 decimales, la misma precisión que el
// DECIMAL(18,6) de sqlBOMGranel. Mismo criterio que fraccionado_faltantes.js.
function redondear(n) { return Math.round(n * 1e6) / 1e6; }

// Número finito y positivo, o 0. Se usa para cantPorUnidad: un valor inválido (0, negativo,
// texto, ausente) no invalida la línea, simplemente significa "sin granel imputado".
function numeroPositivoOCero(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Totales de la orden. Los recalcula siempre el server: lo que manda el cliente es solo la
 * selección, nunca los totales. Las líneas sin granel suman 0 kg pero sí cuentan sus unidades.
 * @param {Array} lineas líneas ya normalizadas
 * @returns {{lineas:number, unidades:number, kgGranel:number}}
 */
// Estados posibles de UNA línea (la orden tiene los suyos: pendiente/aplicada/anulada).
// 'cargado' no distingue parciales a propósito: la regla de negocio es que cualquier carga cierra
// la línea, aunque se hayan producido menos unidades de las pedidas (la cantidad real igual se
// guarda en cargadoCant como dato). 'sin_stock' lo marca la encargada cuando no la va a hacer.
const ESTADOS_LINEA = ['pendiente', 'cargado', 'sin_stock'];

// Cantidad realmente cargada: 0 es un valor legítimo, así que no sirve numeroPositivoOCero.
function cantidadCargadaValida(v) {
  // null y '' pasan por Number() como 0; se descartan antes para no confundir "no mandó cantidad"
  // con "cargó cero unidades", que sí es un valor legítimo.
  if (v === null || v === undefined || v === '') return false;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0;
}

function normalizarFecha(v) {
  const s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

/**
 * Avance de la orden, para que la tab Pedidos de distribucion.html y el módulo de Pedidos
 * mayoristas muestren lo mismo sin recalcular cada una por su lado.
 * Se calcula al vuelo (nunca se persiste) para que no pueda quedar desincronizado de `lineas`.
 * @param {Array} lineas líneas ya normalizadas
 * @returns {{total:number, cargadas:number, sinStock:number, pendientes:number}}
 */
function progresoOrdenFraccionado(lineas) {
  const arr = Array.isArray(lineas) ? lineas : [];
  const cuenta = estado => arr.filter(l => (l && l.estado) === estado).length;
  const cargadas = cuenta('cargado');
  const sinStock = cuenta('sin_stock');
  return {
    total: arr.length,
    cargadas,
    sinStock,
    // Por diferencia: una línea vieja sin `estado` cuenta como pendiente aunque no se haya
    // normalizado, que es lo que corresponde para las órdenes guardadas antes de este campo.
    pendientes: arr.length - cargadas - sinStock,
  };
}

/**
 * Aplica el cambio de estado de UNA línea. Pura: no toca la orden recibida, devuelve una nueva.
 * Volver a 'pendiente' está permitido (la encargada se puede equivocar) y limpia cantidad y fecha.
 * @param {object} orden orden completa tal cual está persistida
 * @param {string|number} plu PLU de la línea a marcar
 * @param {{estado:string, cargadoCant?:*, fecha?:string}} cambio
 * @returns {{orden:object|null, error:string|null}}
 */
function marcarLineaOrden(orden, plu, cambio) {
  const c = cambio || {};
  if (!orden || !Array.isArray(orden.lineas)) return { orden: null, error: 'Orden inválida' };
  if (!ESTADOS_LINEA.includes(c.estado)) {
    return { orden: null, error: `Estado de línea inválido: ${c.estado}` };
  }
  const buscado = String(plu == null ? '' : plu).trim();
  const i = orden.lineas.findIndex(l => l && String(l.plu) === buscado);
  if (i < 0) return { orden: null, error: `La orden no tiene una línea con el PLU ${buscado}` };
  // La cantidad sólo se exige (y se guarda) cuando se está cargando producción: en 'sin_stock' y
  // 'pendiente' no hay nada cargado, así que lo que venga en el body se ignora.
  if (c.estado === 'cargado' && !cantidadCargadaValida(c.cargadoCant)) {
    return { orden: null, error: `Cantidad cargada inválida en el PLU ${buscado}` };
  }
  const linea = {
    ...orden.lineas[i],
    estado: c.estado,
    cargadoCant: c.estado === 'cargado' ? Number(c.cargadoCant) : 0,
    cargadoFecha: c.estado === 'cargado' ? normalizarFecha(c.fecha) : '',
  };
  const lineas = orden.lineas.map((l, idx) => (idx === i ? linea : l));
  return { orden: { ...orden, lineas }, error: null };
}

function totalesOrdenFraccionado(lineas) {
  return {
    lineas: lineas.length,
    unidades: lineas.reduce((s, l) => s + (Number(l.cantidad) || 0), 0),
    kgGranel: redondear(lineas.reduce((s, l) => s + (Number(l.granelNecesario) || 0), 0)),
  };
}

/**
 * Devuelve un string con el error, o null si está todo bien.
 * Sólo `plu` y `cantidad` son obligatorios: son los que definen qué y cuánto se fracciona.
 * `granelPlu` y `cantPorUnidad` son informativos y pueden faltar (ver cabecera del módulo).
 * @param {*} lineas lo que llegó en el body, sin validar
 * @returns {string|null}
 */
function validarLineasFraccionado(lineas) {
  if (!Array.isArray(lineas) || !lineas.length) return 'La orden tiene que tener al menos una línea';
  for (const l of lineas) {
    if (!l || typeof l !== 'object')                  return 'Hay una línea inválida';
    if (!String(l.plu || '').trim())                  return 'Hay una línea sin PLU';
    const cant = Number(l.cantidad);
    if (!Number.isFinite(cant) || cant <= 0)          return `Cantidad inválida en el PLU ${l.plu}`;
  }
  return null;
}

/**
 * Deja las líneas con la forma exacta que se persiste. Asume que ya pasaron por
 * validarLineasFraccionado (plu y cantidad válidos).
 * Sin granel resuelto la línea se guarda igual, con los campos de granel en vacío/0: así la orden
 * conserva el producto elegido y la encargada puede cargar la producción a mano.
 * @param {Array} lineas
 * @returns {Array}
 */
function normalizarLineasFraccionado(lineas) {
  return lineas.map(l => {
    const cantidad = Number(l.cantidad);
    const granelPlu = String(l.granelPlu || '').trim();
    // Sin granelPlu no hay contra qué imputar kg, así que cantPorUnidad se fuerza a 0 aunque
    // el cliente haya mandado un número: evita guardar un granelNecesario huérfano.
    const cantPorUnidad = granelPlu ? numeroPositivoOCero(l.cantPorUnidad) : 0;
    return {
      plu: String(l.plu).trim(),
      nombre: String(l.nombre || ''),
      cantidad,
      granelPlu,
      granelNombre: granelPlu ? String(l.granelNombre || '') : '',
      cantPorUnidad,
      granelNecesario: redondear(cantidad * cantPorUnidad),
      // Producto contra el cual se imputa la producción, resuelto por /api/mayoristas/producto-carga.
      // Se guarda tal cual lo manda el frontend: acá no se valida ni se deriva nada.
      pluCarga: String(l.pluCarga || ''),
      nombreCarga: String(l.nombreCarga || ''),
      manual: l.manual === true,
      // Avance de la línea. Se preserva si ya viene (editar una orden no puede borrar lo que la
      // encargada ya cargó) y cae a los defaults si no: las órdenes guardadas antes de este campo
      // se leen y se editan igual, quedando como 'pendiente'.
      estado: ESTADOS_LINEA.includes(l.estado) ? l.estado : 'pendiente',
      cargadoCant: l.estado === 'cargado' && cantidadCargadaValida(l.cargadoCant)
        ? Number(l.cargadoCant) : 0,
      cargadoFecha: l.estado === 'cargado' ? normalizarFecha(l.cargadoFecha) : '',
      clientes: Array.isArray(l.clientes) ? l.clientes.map(c => ({
        idCliente: c.idCliente, nombre: String(c.nombre || ''), pendiente: Number(c.pendiente) || 0,
      })) : [],
    };
  });
}

module.exports = {
  ESTADOS_LINEA,
  validarLineasFraccionado,
  normalizarLineasFraccionado,
  totalesOrdenFraccionado,
  progresoOrdenFraccionado,
  marcarLineaOrden,
};
