'use strict';

/**
 * Reservas de pesables mayoristas: lo que distingue a un pesable de una venta directa.
 * Modulo puro (sin SQL ni fs), igual que reservas_mercaderia.js, asi se testea con node:test.
 *
 * Un bulto pesable no se aparta a si mismo ni a su componente directo: se aparta el GRANEL,
 * medido en kg. El componente directo ("Almendras Pedido") es un intermedio sin stock propio
 * que existe para que el mayorista pueda cambiar de presentacion al facturar sin romper nada.
 */

// Los kg se multiplican y se restan en punto flotante y dejan colas (3 x 0.1 = 0.30000000000000004).
// 4 decimales es la precision que ya usa el resto del circuito de reservas (redondear4 en server.js).
function redondear4(n) {
  return Math.round((Number(n) || 0) * 1e4) / 1e4;
}

function texto(v) {
  return String(v == null ? '' : v).trim();
}

function positivo(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Kilos de granel que hay que apartar por una linea de pedido.
 * @param {number} cantPorUnidad kg de granel por unidad del bulto (lo da sqlBOMGranel)
 * @param {number} unidades unidades pedidas del bulto
 * @returns {number} kg redondeados a 4 decimales; 0 si algun dato no sirve
 */
function kgReserva(cantPorUnidad, unidades) {
  const kgUnidad = positivo(cantPorUnidad);
  const cant = positivo(unidades);
  if (!kgUnidad || !cant) return 0;
  return redondear4(kgUnidad * cant);
}

/**
 * @param {object} l linea pesable cruda del body
 * @returns {string|null} mensaje de error, o null si esta bien
 */
function validarLineaPesable(l) {
  if (!l || typeof l !== 'object') return 'La linea pesable no es un objeto';
  if (!texto(l.pluPedido)) return 'La linea pesable no tiene el plu del pedido';
  if (!texto(l.pluCarga))  return 'La linea pesable no tiene el producto de carga';
  if (!texto(l.pluGranel)) return 'La linea pesable no tiene el granel a apartar';
  if (!positivo(l.cantPorUnidad)) return 'La linea pesable no tiene kg por unidad';
  if (!positivo(l.unidades)) return 'La linea pesable no tiene unidades pedidas';
  return null;
}

module.exports = { kgReserva, validarLineaPesable };
