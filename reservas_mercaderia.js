'use strict';

/**
 * Reservas de mercaderia mayorista: validacion, normalizacion y estado.
 * Modulo puro a proposito (sin SQL ni fs), igual que ordenes_fraccionado.js, asi se testea
 * con node:test. Lo consume el CRUD /api/mayoristas/reservas de server.js.
 *
 * A diferencia de la reserva de planificacion, aca NO se explota formula: se aparta el
 * producto TERMINADO. Una reserva pertenece a UN cliente y sale en UN movimiento de SiGA.
 */

// Un pegado accidental no puede convertirse en un movimiento de 500 renglones en SiGA.
const MAX_LINEAS = 200;

// Cantidad de unidades a reservar. Cero no es valido: una linea sin cantidad no aporta nada
// al movimiento y solo ensucia el comprobante.
function cantidadValida(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

function texto(v) {
  return String(v == null ? '' : v).trim();
}

/**
 * @param {Array} lineas lineas crudas del body
 * @returns {string|null} mensaje de error, o null si estan bien
 */
function validarLineasReserva(lineas) {
  if (!Array.isArray(lineas) || !lineas.length) return 'La reserva no tiene lineas';
  if (lineas.length > MAX_LINEAS) return `La reserva no puede tener mas de ${MAX_LINEAS} lineas`;
  for (const l of lineas) {
    if (!l || typeof l !== 'object') return 'Hay una linea que no es un objeto';
    if (!texto(l.plu)) return 'Hay una linea sin plu';
    if (!cantidadValida(l.cantidad)) {
      return `Cantidad invalida en el plu ${texto(l.plu)}: tiene que ser un numero mayor a cero`;
    }
  }
  return null;
}

/**
 * Normaliza y consolida: el mismo plu repetido (el cliente lo pidio en dos pedidos distintos)
 * se suma en una sola linea, para que el comprobante de SiGA no tenga renglones duplicados.
 * @param {Array} lineas lineas ya validadas
 * @returns {Array<{plu:string, nombre:string, cantidad:number}>}
 */
function normalizarLineasReserva(lineas) {
  const porPlu = new Map();
  for (const l of (lineas || [])) {
    const plu = texto(l.plu);
    const previa = porPlu.get(plu);
    if (previa) {
      previa.cantidad += Number(l.cantidad);
    } else {
      porPlu.set(plu, { plu, nombre: texto(l.nombre), cantidad: Number(l.cantidad) });
    }
  }
  return [...porPlu.values()];
}

/**
 * @param {Array} lineas lineas normalizadas
 * @returns {{lineas:number, unidades:number}}
 */
function totalesReserva(lineas) {
  const arr = lineas || [];
  return {
    lineas: arr.length,
    unidades: arr.reduce((acc, l) => acc + (Number(l.cantidad) || 0), 0),
  };
}

module.exports = { MAX_LINEAS, validarLineasReserva, normalizarLineasReserva, totalesReserva };
