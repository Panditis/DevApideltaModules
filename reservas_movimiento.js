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
      // Ya conciliado = su ajuste de producción ya se registró en SiGA (no se vuelve a mover).
      conciliado: !!(reserva.ajuste && reserva.ajuste.conciliado),
      ajuste: reserva.ajuste || null,
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
      // Se propaga el estado de conciliación del grupo para que el registro pueda saltar los
      // movimientos ya conciliados (idempotencia ante reintentos parciales).
      conciliado: !!grupo.conciliado,
      ajuste: grupo.ajuste || null,
    };
  });
}

/**
 * Líneas de stock del ajuste de UN movimiento de reserva. Función pura (no toca SIGA):
 * por cada componente del movimiento, descuenta lo consumido contra el depósito de reserva
 * (donde la mercadería está físicamente apartada) y devuelve el sobrante al depósito de
 * diferencias. NO incluye terminados ni el consumo que salió de fuera de la reserva
 * (eso va en el comprobante "resto", ver lineasProduccionDesdeConciliacion con incluirReserva:false).
 *
 * @param {Array<{plu:string, nombre:string, reservado:number, usado:number, sobrante:number}>} componentes
 * @param {{reserva:number, diferencias:number}} deps  depósitos: reserva (origen físico) y diferencias (destino del sobrante)
 * @returns {Array<{idProducto:string, nombre:string, idDeposito:number, cantidad:number, concepto:string}>}
 */
function lineasAjusteMovimiento(componentes, deps) {
  const lineas = [];
  const depReserva = deps && deps.reserva;
  const depDiferencias = deps && deps.diferencias;
  for (const comp of (componentes || [])) {
    if (!comp || !comp.plu) continue;
    const base = { idProducto: String(comp.plu), nombre: comp.nombre || '' };
    const usado = redondear4(comp.usado);
    const sobrante = redondear4(comp.sobrante);
    // Consumido contra lo apartado: sale del depósito de reserva.
    if (usado > 0) {
      lineas.push({ ...base, idDeposito: depReserva, cantidad: -usado, concepto: 'consumo-reserva' });
    }
    // Apartado de más: vuelve del depósito de reserva al de diferencias.
    if (sobrante > 0) {
      lineas.push({ ...base, idDeposito: depReserva, cantidad: -sobrante, concepto: 'sobrante-desde-reserva' });
      lineas.push({ ...base, idDeposito: depDiferencias, cantidad: sobrante, concepto: 'sobrante-a-diferencias' });
    }
  }
  return lineas;
}

module.exports = {
  ordenesDeMovimiento,
  migrarReservas,
  saldoLedger,
  itemsSinReservar,
  reservadoPorMovimiento,
  conciliarPorMovimiento,
  lineasAjusteMovimiento,
};
