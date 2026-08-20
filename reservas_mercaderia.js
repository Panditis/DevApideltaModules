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

/**
 * @param {number|string} idCliente
 * @param {string} nombreCliente
 * @returns {string|null}
 */
function validarClienteReserva(idCliente, nombreCliente) {
  if (!texto(idCliente)) return 'La reserva no tiene cliente';
  if (!texto(nombreCliente)) return 'La reserva no tiene nombre de cliente';
  return null;
}

/**
 * Una reserva es de UN cliente. Las lineas que vienen del Resumen por cliente traen su
 * idCliente; si alguna es de otro cliente el carrito esta mezclado y no se reserva nada.
 * @param {Array} lineas
 * @param {number|string} idCliente cliente de la reserva
 * @returns {string|null}
 */
function validarCarritoUnCliente(lineas, idCliente) {
  const esperado = texto(idCliente);
  for (const l of (lineas || [])) {
    const propio = texto(l && l.idCliente);
    // Sin idCliente la linea se acepta: el cliente lo define el body (producto suelto).
    if (propio && propio !== esperado) {
      return 'Todas las lineas de una reserva tienen que ser del mismo cliente';
    }
  }
  return null;
}

/**
 * @param {Array} reservas archivo entero
 * @param {number|string} idCliente
 * @returns {Set<string>} plu con reserva ACTIVA de ese cliente
 */
function plusReservadosDeCliente(reservas, idCliente) {
  const esperado = texto(idCliente);
  const plus = new Set();
  for (const r of (reservas || [])) {
    if (!r || r.estado !== 'activa' || texto(r.idCliente) !== esperado) continue;
    for (const l of (r.lineas || [])) plus.add(texto(l.plu));
  }
  return plus;
}

/**
 * @param {Array} lineas lineas del carrito
 * @param {Array} reservas archivo entero
 * @param {number|string} idCliente
 * @returns {string|null}
 */
function validarPlusNoReservados(lineas, reservas, idCliente) {
  const yaEstan = plusReservadosDeCliente(reservas, idCliente);
  const chocan = [...new Set((lineas || []).map(l => texto(l && l.plu)).filter(p => yaEstan.has(p)))];
  if (!chocan.length) return null;
  return `El cliente ya tiene una reserva activa con ${chocan.length === 1 ? 'el plu' : 'los plu'} `
       + `${chocan.join(', ')}. Anula esa reserva antes de volver a reservarlo.`;
}

/**
 * Mapa {idCliente: [plu, ...]} de las reservas ACTIVAS. Lo consume pedidos_web.html para
 * marcar los botones del Resumen por cliente sin bajarse todas las reservas con sus lineas.
 * @param {Array} reservas
 * @returns {Object<string, string[]>}
 */
function reservasActivasResumen(reservas) {
  const mapa = {};
  for (const r of (reservas || [])) {
    if (!r || r.estado !== 'activa') continue;
    const cli = texto(r.idCliente);
    const set = mapa[cli] || (mapa[cli] = new Set());
    for (const l of (r.lineas || [])) set.add(texto(l.plu));
  }
  return Object.fromEntries(Object.entries(mapa).map(([cli, set]) => [cli, [...set]]));
}

/**
 * Arma la reserva ya confirmada por SiGA. Se llama DESPUES del movimiento: si el traslado
 * falla no se escribe nada en el archivo, asi que reintentar es seguro.
 * @param {object} d datos de la reserva ya ejecutada
 * @returns {object} reserva lista para persistir
 */
function nuevaReserva(d) {
  return {
    id: d.id,
    fecha: d.fecha,
    estado: 'activa',
    idCliente: d.idCliente,
    nombreCliente: texto(d.nombreCliente),
    idSucursal: Number(d.idSucursal),
    depOrigen: Number(d.depOrigen),
    depDestino: Number(d.depDestino),
    numeroMovimiento: d.numeroMovimiento,
    idRegistro: d.idRegistro == null ? null : d.idRegistro,
    usuario: texto(d.usuario),
    lineas: d.lineas || [],
    totales: totalesReserva(d.lineas),
    anulacion: null,
  };
}

/**
 * Transicion activa -> anulada. Devuelve una copia: no muta la reserva original, para que un
 * error posterior no deje el array en memoria a medio cambiar.
 * @param {object} reserva
 * @param {{numeroMovimiento:number, idRegistro:number|null, fecha:string}} mov comprobante inverso
 * @returns {{reserva?:object, error?:string}}
 */
function anularReserva(reserva, mov) {
  if (!reserva) return { error: 'Reserva no encontrada' };
  if (reserva.estado === 'anulada') {
    return { error: `La reserva #${reserva.id} ya esta anulada` };
  }
  return {
    reserva: {
      ...reserva,
      estado: 'anulada',
      anulacion: {
        numeroMovimiento: mov.numeroMovimiento,
        idRegistro: mov.idRegistro == null ? null : mov.idRegistro,
        fecha: mov.fecha,
      },
    },
  };
}

module.exports = {
  MAX_LINEAS, validarLineasReserva, normalizarLineasReserva, totalesReserva,
  validarClienteReserva, validarCarritoUnCliente, plusReservadosDeCliente,
  validarPlusNoReservados, reservasActivasResumen,
  nuevaReserva, anularReserva,
};
