'use strict';

/**
 * Módulo puro de reservas de mercadería por movimiento SIGA.
 * Sin acceso a filesystem ni SIGA: sólo funciones sobre objetos plan planos.
 */

/**
 * @param {number} n
 * @returns {number}
 */
function redondear4(n) {
  return Math.round((Number(n) || 0) * 1e4) / 1e4;
}

/**
 * @param {Array<object>} items
 * @param {number|string} numeroMovimiento
 * @returns {Array<number|string>}
 */
function ordenesDeMovimiento(items, numeroMovimiento) {
  return (items || [])
    .filter(item => item && item.reservaMovimiento && item.reservaMovimiento.numeroMovimiento === numeroMovimiento)
    .map(item => item.id);
}

/**
 * @param {object|null} plan
 * @returns {object}
 */
function migrarReservas(plan) {
  if (plan === null || plan === undefined) {
    return { reservas: [] };
  }
  if (Array.isArray(plan.reservas)) {
    return plan;
  }
  if (plan.reserva) {
    const reserva = plan.reserva;
    const entrada = {
      numeroMovimiento: reserva.numeroMovimiento ?? null,
      idRegistro: reserva.idRegistro ?? null,
      estado: reserva.estado === 'anulada' ? 'anulada' : 'activa',
      fecha: reserva.fecha ?? null,
      fechaPlanificacion: plan.fecha ?? null,
      idSucursal: reserva.idSucursal ?? null,
      depOrigen: reserva.depOrigen ?? null,
      depDestino: reserva.depDestino ?? null,
      ordenes: ordenesDeMovimiento(plan.items, reserva.numeroMovimiento),
      lineas: reserva.lineas || [],
      devoluciones: reserva.devoluciones || [],
    };
    return { ...plan, reservas: [entrada] };
  }
  return { ...plan, reservas: [] };
}

/**
 * @param {Array<object>} reservas
 * @returns {Array<{plu:string, nombre:string, cantidad:number}>}
 */
function saldoLedger(reservas) {
  const nombresPorPlu = new Map();
  const totalesPorPlu = new Map();

  (reservas || [])
    .filter(reserva => reserva && reserva.estado === 'activa')
    .forEach(reserva => {
      (reserva.lineas || []).forEach(linea => {
        const plu = String(linea.plu);
        nombresPorPlu.set(plu, linea.nombre);
        totalesPorPlu.set(plu, (totalesPorPlu.get(plu) || 0) + (Number(linea.cantidad) || 0));
      });
      (reserva.devoluciones || []).forEach(devolucion => {
        (devolucion.lineas || []).forEach(linea => {
          const plu = String(linea.plu);
          totalesPorPlu.set(plu, (totalesPorPlu.get(plu) || 0) - (Number(linea.cantidad) || 0));
        });
      });
    });

  return Array.from(totalesPorPlu.entries())
    .map(([plu, cantidad]) => ({ plu, nombre: nombresPorPlu.get(plu), cantidad: redondear4(cantidad) }))
    .filter(linea => linea.cantidad > 0);
}

/**
 * @param {Array<object>} items
 * @returns {Array<object>}
 */
function itemsSinReservar(items) {
  return (items || []).filter(item => !(item && item.reservaMovimiento && item.reservaMovimiento.numeroMovimiento != null));
}

/**
 * @param {Array<object>} reservas
 * @returns {Array<{numeroMovimiento:*, ordenes:Array, saldo:Array}>}
 */
function reservadoPorMovimiento(reservas) {
  return (reservas || [])
    .filter(reserva => reserva && reserva.estado === 'activa')
    .map(reserva => ({
      numeroMovimiento: reserva.numeroMovimiento,
      ordenes: reserva.ordenes || [],
      saldo: saldoLedger([reserva]),
    }));
}

/**
 * @param {Array<{numeroMovimiento:*, ordenes:Array, saldo:Array}>} grupos
 * @param {Map<string, number>} usadoPorPlu
 * @returns {Array<object>}
 */
function conciliarPorMovimiento(grupos, usadoPorPlu) {
  const restantePorPlu = new Map();
  (usadoPorPlu || new Map()).forEach((valor, plu) => {
    restantePorPlu.set(plu, Number(valor) || 0);
  });

  return (grupos || []).map(grupo => {
    const componentes = (grupo.saldo || []).map(linea => {
      const plu = String(linea.plu);
      const reservado = Number(linea.cantidad) || 0;
      const restante = restantePorPlu.get(plu) || 0;
      const usado = Math.min(reservado, restante);
      restantePorPlu.set(plu, restante - usado);
      return {
        plu,
        nombre: linea.nombre,
        reservado: redondear4(reservado),
        usado: redondear4(usado),
        sobrante: redondear4(Math.max(0, reservado - usado)),
        faltante: 0,
      };
    });
    return {
      numeroMovimiento: grupo.numeroMovimiento,
      ordenes: grupo.ordenes || [],
      componentes,
    };
  });
}

module.exports = {
  ordenesDeMovimiento,
  migrarReservas,
  saldoLedger,
  itemsSinReservar,
  reservadoPorMovimiento,
  conciliarPorMovimiento,
};
