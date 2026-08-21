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
 * Normaliza SIN consolidar: cada registro que el operador selecciono sale con su propio
 * movimiento de SiGA, aunque dos registros compartan el mismo plu a apartar (el bulto y la
 * caja de un mismo articulo, o dos pedidos distintos del mismo cliente). Sumarlos perderia
 * la trazabilidad de que registro origino que comprobante.
 *
 * `plu`/`nombre` es lo que se mueve en SiGA; `pluPedido`/`nombrePedido` es el producto que
 * figura en el pedido. Para los Almacen Bulto/Caja son distintos: se aparta el componente
 * de formula. Cuando no vienen, se asume que son el mismo producto.
 * @param {Array} lineas lineas ya validadas
 * @returns {Array<{plu:string, nombre:string, cantidad:number, pluPedido:string, nombrePedido:string}>}
 */
function normalizarLineasReserva(lineas) {
  return (lineas || []).map(l => {
    const plu = texto(l.plu);
    const nombre = texto(l.nombre);
    return {
      plu, nombre, cantidad: Number(l.cantidad),
      pluPedido: texto(l.pluPedido) || plu,
      nombrePedido: texto(l.nombrePedido) || nombre,
    };
  });
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
    // Una reserva = un registro seleccionado = un movimiento. `lineas` queda como array de
    // uno solo para que anular y el listado sigan recorriendo lo mismo.
    lineas: d.lineas || [],
    pluPedido: texto(d.pluPedido) || null,
    nombrePedido: texto(d.nombrePedido) || null,
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
  validarClienteReserva, validarCarritoUnCliente,
  nuevaReserva, anularReserva,
};
