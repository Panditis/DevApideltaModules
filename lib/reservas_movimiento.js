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
      ordenes: Array.isArray(reserva.ordenes) ? reserva.ordenes : [],
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
 * @param {*} n
 * @returns {boolean}
 */
function esIdDeposito(n) {
  return Number.isInteger(Number(n)) && Number(n) > 0;
}

/**
 * Depósitos del movimiento de producción.
 *
 * El destino de las diferencias NO se elige nunca: lo determina el sentido de la diferencia.
 *   · usado > reservado → el excedente NO puede salir del depósito de reserva: ahí sólo está lo
 *     apartado, así que descontarlo de ahí lo deja en negativo y no toca el principal, que es de
 *     donde realmente salió la mercadería de más.
 *   · usado < reservado → el sobrante vuelve al depósito de origen, que es de donde se sacó.
 * En los dos casos la contraparte es la misma: el depósito de origen de la reserva. Y sin reserva
 * no hay nada apartado, así que tampoco hay diferencia que devolver.
 *
 * Por eso, con una reserva ACTIVA, salida y diferencias se fuerzan a reserva.depOrigen. Antes los
 * dos salían de combos libres de la pantalla y, con el de salida apuntando al depósito de reserva,
 * el excedente se descontaba del lugar equivocado (bug real: plan 2026-08-06, comprobante #5,
 * −8 de Almendra sobre el depósito 2 en vez del 1).
 *
 * @param {{depositoTerminados:number|null}} cp Config de producción.
 * @param {{depositoPrincipal:number, depositoReserva:number|null}} cr Config de reserva.
 * @param {{estado?:string, depOrigen?:number, depDestino?:number}|null} reserva Reserva del plan.
 * @param {{depSalida?:*, depRecepcion?:*}} [elegidos] Lo elegido en pantalla (depDiferencias se ignora).
 * @returns {{salida:number, recepcion:number, diferencias:number, reserva:number|null, forzadosPorReserva:boolean}}
 */
function depositosProduccion(cp, cr, reserva, elegidos) {
  const e = elegidos || {};
  const conDefault = (valor, porDefecto) => (esIdDeposito(valor) ? Number(valor) : porDefecto);

  const viva   = !!reserva && reserva.estado === 'activa' && esIdDeposito(reserva.depOrigen);
  const origen = viva ? Number(reserva.depOrigen) : null;

  // Sin reserva viva se conserva el comportamiento anterior: lo elegido y, si no vino nada,
  // el origen de la última reserva del plan y por último el principal del config.
  const salida      = origen ?? conDefault(e.depSalida, conDefault(reserva && reserva.depOrigen, cr.depositoPrincipal));
  // Siempre derivado, nunca elegido: la contraparte de la diferencia es de donde salió lo apartado.
  const diferencias = origen ?? salida;
  // La recepción de los terminados sigue siendo libre: no toca el stock apartado.
  const recepcion   = conDefault(e.depRecepcion, cp.depositoTerminados || salida);

  return {
    salida, recepcion, diferencias,
    reserva: conDefault(reserva && reserva.depDestino, cr.depositoReserva),
    forzadosPorReserva: origen != null,
  };
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
  for (const comp of (componentes || [])) {
    if (!comp || !comp.plu) continue;
    const usado = redondear4(comp.usado);
    // Consumido contra lo apartado: sale del depósito de reserva.
    if (usado > 0) {
      lineas.push({
        idProducto: String(comp.plu), nombre: comp.nombre || '',
        idDeposito: depReserva, cantidad: -usado, concepto: 'consumo-reserva'
      });
    }
  }
  return lineas;
}

/**
 * Líneas del comprobante de AJUSTE POR DIFERENCIAS: lo que se desvió de lo reservado. Va en su
 * propio comprobante para poder identificarlo en SiGA por la observación, en vez de quedar
 * mezclado con el consumo normal y con el alta de terminados. Función pura.
 *
 * Sólo mira componentes que tenían algo reservado: el consumo de lo NO reservado no es una
 * diferencia sino consumo común, y sale en el comprobante de producción.
 *   · usado > reservado (se usó de más)   → −excedente en el depósito de origen de la reserva.
 *   · usado < reservado (se usó de menos) → −sobrante en el de reserva y +sobrante en el de origen.
 *
 * @param {Array<{plu:string, nombre:string, reservado:number, usado:number}>} componentes
 * @param {{reserva:number, diferencias:number}} deps reserva (donde está lo apartado) y diferencias (el de origen)
 * @returns {Array<{idProducto:string, nombre:string, idDeposito:number, cantidad:number, concepto:string}>}
 */
function lineasDiferenciasProduccion(componentes, deps) {
  const lineas = [];
  const depReserva     = deps && deps.reserva;
  const depDiferencias = deps && deps.diferencias;
  for (const comp of (componentes || [])) {
    if (!comp || !comp.plu) continue;
    const reservado = redondear4(comp.reservado);
    if (!(reservado > 0)) continue;   // sin reserva detrás no hay diferencia que ajustar
    const usado = redondear4(comp.usado);
    const base  = { idProducto: String(comp.plu), nombre: comp.nombre || '' };

    const excedente = redondear4(Math.max(0, usado - reservado));
    const sobrante  = redondear4(Math.max(0, reservado - usado));

    // Se usó de más: el excedente nunca estuvo apartado, así que se descuenta del de origen.
    if (excedente > 0) {
      lineas.push({ ...base, idDeposito: depDiferencias, cantidad: -excedente, concepto: 'excedente-a-origen' });
    }
    // Se usó de menos: lo apartado de más vuelve de donde salió.
    if (sobrante > 0) {
      lineas.push({ ...base, idDeposito: depReserva,     cantidad: -sobrante, concepto: 'sobrante-desde-reserva' });
      lineas.push({ ...base, idDeposito: depDiferencias, cantidad:  sobrante, concepto: 'sobrante-a-diferencias' });
    }
  }
  return lineas;
}

/**
 * Órdenes de una reserva que ya se produjeron y se recepcionaron como artículo final.
 *
 * Sus componentes salieron del depósito de reserva al recepcionar el producto terminado, así
 * que devolver o revertir esa reserva escribiría en SiGA un traslado contra stock que ya no
 * está: el depósito de reserva quedaría en negativo y al de origen le entraría mercadería
 * inexistente. Quien llama usa el resultado para bloquear la operación ANTES de escribir.
 *
 * @param {{ordenes?:Array<number|string>}} reserva Entrada del ledger (o `{ordenes:[id]}` para mirar un solo ítem).
 * @param {Array<{id:*, producto?:string, nombre?:string, produccionMovimiento?:{numeroMovimiento:*}}>} items Ítems del plan.
 * @returns {Array<{id:*, producto:string, numeroMovimiento:*}>} Vacío si ninguna orden fue producida.
 */
function ordenesProducidasDeReserva(reserva, items) {
  const porId = new Map((items || []).map(it => [String(it && it.id), it]));
  const ids   = Array.isArray(reserva && reserva.ordenes) ? reserva.ordenes : [];
  const out = [];
  for (const id of ids) {
    const it  = porId.get(String(id));
    const mov = it && it.produccionMovimiento;
    if (!mov || mov.numeroMovimiento == null) continue;
    out.push({ id, producto: String(it.producto || it.nombre || ''), numeroMovimiento: mov.numeroMovimiento });
  }
  return out;
}

/**
 * Mensaje único para todos los caminos que bloquean por producción ya recepcionada, en el
 * mismo tono que las guardas de modificar y eliminar órdenes.
 *
 * @param {Array<{id:*, producto:string, numeroMovimiento:*}>} producidas Salida de ordenesProducidasDeReserva.
 * @param {string} accion Qué se estaba intentando, p.ej. 'devolver la reserva'.
 * @returns {string|null} null cuando no hay nada que bloquear.
 */
function motivoBloqueoProduccion(producidas, accion) {
  if (!producidas || !producidas.length) return null;
  const una     = producidas.length === 1;
  const detalle = producidas.map(p => `"${p.producto || p.id}" (movimiento #${p.numeroMovimiento})`).join(', ');
  return `No se puede ${accion}: ${una ? 'la orden' : 'las órdenes'} ${detalle} ya `
       + `${una ? 'fue producida y recepcionada' : 'fueron producidas y recepcionadas'}. `
       + 'Los componentes ya se consumieron.';
}

/**
 * Un ítem sellado con `reservaMovimiento` queda bloqueado: no se puede borrar ni cambiarle
 * cantidades. El sello vale mientras su movimiento siga vivo EN ESTE PLAN; uno revertido,
 * fallido o heredado de otro día deja al ítem trabado para siempre, porque el resumen de
 * reservas sólo lista `plan.reservas` y por ahí no queda nada para revertir.
 *
 * Un sello que el log NO conoce (anterior al log de movimientos) se respeta tal cual: ante
 * la duda se prefiere bloquear de más antes que liberar una orden con mercadería apartada.
 *
 * @param {{items?:Array<Object>}} plan Plan ya migrado.
 * @param {Set<string>} vivos Números de movimiento confirmados de ESTE plan.
 * @param {Set<string>} conocidos Números de movimiento presentes en el log (cualquier plan).
 * @returns {Object} El mismo plan si no había sellos huérfanos, o una copia sin ellos.
 */
function sanearSellosReserva(plan, vivos, conocidos) {
  const items = (plan && plan.items) || [];
  const huerfano = it => {
    const n = it && it.reservaMovimiento && it.reservaMovimiento.numeroMovimiento;
    if (n == null) return false;
    return conocidos.has(String(n)) && !vivos.has(String(n));
  };
  if (!items.some(huerfano)) return plan;
  return { ...plan, items: items.map(it => huerfano(it) ? { ...it, reservaMovimiento: null } : it) };
}

// Unidades pendientes de dar de alta, por PLU, con EXACTAMENTE la misma condición que usa el
// loop de terminados de lineasProduccionDesdeConciliacion (no excluido, no ya registrado,
// cantidad positiva, PLU resoluble). Vive acá para que la imputación de la entrega mayorista y
// el comprobante cuenten los mismos productos: si una de las dos contara uno de más, el asiento
// diría una cosa y el stock movido otra, y el desfasaje no se corrige nunca.
// Función pura.
function terminadosPorPluDeConciliacion(productos) {
  const mapa = new Map();
  for (const p of (productos || [])) {
    if (!p || p.excluido || p.yaRegistrado) continue;
    const cantidad = redondear4(p.cantidad);
    if (!(cantidad > 0) || !p.plu) continue;
    const plu = String(p.plu);
    mapa.set(plu, redondear4((mapa.get(plu) || 0) + cantidad));
  }
  return mapa;
}

// Líneas del comprobante de producción a partir de la conciliación. Cada línea lleva su
// signo y su depósito:
//   · terminados     → +cantidad en el depósito de RECEPCIÓN (los excluidos no se dan de alta)
//   · consumo        → −usado contra lo que había reservado (depósito de reserva, que es donde
//                      la mercadería está físicamente) y, para lo que NO tenía reserva, contra
//                      el depósito de SALIDA.
// Lo que se desvía de lo reservado (excedente y sobrante) NO sale por acá: va en su propio
// comprobante de ajuste por diferencias (ver lineasDiferenciasProduccion), para poder
// identificarlo en SiGA por la observación.
// Los componentes sin PLU resoluble no se pueden mover y salen aparte en `sinPlu`.
// Función pura: no toca SQL ni archivos.
function lineasProduccionDesdeConciliacion(c, deps, opts) {
  // incluirReserva:false arma sólo el comprobante "resto" (terminados + consumo que salió de
  // FUERA de la reserva). El consumo contra la reserva y el sobrante se registran aparte, un
  // comprobante por movimiento de reserva (ver lineasAjusteMovimiento). Default true = comportamiento viejo.
  const incluirReserva = !opts || opts.incluirReserva !== false;
  // Copia propia: el reservado por terminado se GASTA fila por fila (un mismo PLU puede llegar
  // en dos filas de producto) y el mapa del llamador no se toca.
  const dispTerm = new Map((opts && opts.reservadoPorTerminado) || []);
  const lineas = [], sinPlu = [];
  let terminados = 0, componentes = 0, ajustes = 0;

  for (const p of (c.productos || [])) {
    // Excluidos no se dan de alta; los ya registrados tampoco (no se vuelven a mover). Los
    // parciales llegan con `cantidad` = sólo lo pendiente, así que se registran normal.
    if (p.excluido || p.yaRegistrado) continue;
    const cantidad = redondear4(p.cantidad);
    if (!(cantidad > 0)) continue;
    if (!p.plu) { sinPlu.push({ tipo: 'producto', nombre: p.nombre || p.pluTexto || 'sin nombre', cantidad }); continue; }
    // Lo que cubre una reserva mayorista viva entra al deposito de RESERVA: es de ahi que la
    // factura del mayorista lo va a descontar. `reservadoPorTerminado` ya viene NETO de lo que
    // los asientos anteriores metieron (imputarEntregaMayorista), asi que la produccion
    // cargada en lotes no lo mete dos veces. Sin reserva viva, todo va a recepcion como siempre.
    // Se DESCUENTA al usarlo: productosDeConciliacion agrupa por `${pluTexto}|${excluido}|${manual}`,
    // asi que el mismo PLU puede llegar en dos filas y releer el mapa en cada una metia al
    // deposito de reserva el doble de lo apartado.
    const plu = String(p.plu);
    const reservadoTerm = redondear4(Math.min(cantidad, dispTerm.get(plu) || 0));
    if (reservadoTerm > 0) dispTerm.set(plu, redondear4((dispTerm.get(plu) || 0) - reservadoTerm));
    const aRecepcion = redondear4(cantidad - reservadoTerm);
    if (reservadoTerm > 0) {
      lineas.push({ idProducto: String(p.plu), nombre: p.nombre || '', idDeposito: deps.reserva,
                    cantidad: reservadoTerm, concepto: 'terminado-reserva' });
      terminados++;
    }
    if (aRecepcion > 0) {
      lineas.push({ idProducto: String(p.plu), nombre: p.nombre || '', idDeposito: deps.recepcion,
                    cantidad: aRecepcion, concepto: 'terminado' });
      terminados++;
    }
  }

  for (const comp of (c.componentes || [])) {
    const usado = redondear4(comp.usado), reservado = redondear4(comp.reservado);
    if (!(usado > 0) && !(reservado > 0)) continue;
    if (!comp.plu) { sinPlu.push({ tipo: 'componente', nombre: comp.nombre || 'sin nombre', cantidad: usado }); continue; }
    const base        = { idProducto: String(comp.plu), nombre: comp.nombre || '' };
    const deReserva = redondear4(Math.min(usado, reservado));        // consumido contra lo apartado
    const excedente = redondear4(Math.max(0, usado - reservado));    // usado de más respecto de lo reservado
    const sobrante  = redondear4(Math.max(0, reservado - usado));    // apartado de más
    // Sin nada reservado no hay diferencia: todo el consumo es común y sale del depósito de
    // salida. Con reserva detrás, el desvío (excedente/sobrante) se registra en el comprobante
    // de ajuste por diferencias, no acá.
    const deSalida  = reservado > 0 ? 0 : excedente;

    if (incluirReserva && deReserva > 0) { lineas.push({ ...base, idDeposito: deps.reserva, cantidad: -deReserva, concepto: 'consumo-reserva' }); componentes++; }
    if (deSalida  > 0) { lineas.push({ ...base, idDeposito: deps.salida,  cantidad: -deSalida,  concepto: 'consumo-salida'  }); componentes++; }
    if (incluirReserva && (sobrante > 0 || (reservado > 0 && excedente > 0))) ajustes++;
  }

  // Carga manual: sin reserva detrás, el circuito entero ocurre en el depósito de RECEPCIÓN —
  // ahí se descuentan los componentes y ahí mismo entra el terminado, igual que si se armara
  // en el mostrador. Nunca toca el de reserva ni el de salida, y no depende de esos combos.
  // Va siempre en el comprobante de producción, con reserva o sin ella.
  for (const comp of (c.componentesManual || [])) {
    const usado = redondear4(comp.usado);
    if (!(usado > 0)) continue;
    if (!comp.plu) { sinPlu.push({ tipo: 'componente', nombre: comp.nombre || 'sin nombre', cantidad: usado }); continue; }
    lineas.push({ idProducto: String(comp.plu), nombre: comp.nombre || '', idDeposito: deps.recepcion, cantidad: -usado, concepto: 'consumo-manual' });
    componentes++;
  }
  return { lineas, sinPlu, resumen: { terminados, componentes, ajustes } };
}

module.exports = {
  ordenesDeMovimiento,
  migrarReservas,
  saldoLedger,
  itemsSinReservar,
  reservadoPorMovimiento,
  conciliarPorMovimiento,
  depositosProduccion,
  lineasAjusteMovimiento,
  lineasDiferenciasProduccion,
  lineasProduccionDesdeConciliacion,
  terminadosPorPluDeConciliacion,
  ordenesProducidasDeReserva,
  motivoBloqueoProduccion,
  sanearSellosReserva,
};
