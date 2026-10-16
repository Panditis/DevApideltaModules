'use strict';
const express = require('express');
const { RE_ROL_ENVASADO, tieneRol, esSoloEtiquetado, packagingDeRegistro } = require('../lib/produccion_packaging');

// ── Rutas de Reservas del plan + Conciliación de producción con SiGA ───────────
// El motor que ata movimientos de stock reales en SiGA con la planificación de
// producción: el ledger plan.reservas[] (apartar mercadería antes de producir,
// ajustarla si cambia el plan, devolverla) y la conciliación que cruza reserva vs.
// producción cargada antes de dar de alta el movimiento real. Extraídas de
// server.js sin cambios de comportamiento: mismas rutas, mismo orden relativo y
// mismas queries. Los bloques movidos conservan la indentación original a
// propósito (hay template literals SQL multilínea y reindentar les cambiaría el
// texto).
//
// Lo que se movió entero junto con las rutas porque no tiene uso fuera de este
// router (confirmado por grep en server.js y en todos los demás rutas_*.js):
//   · RE_ROL_ENVASADO / RE_NOMBRE_ETIQUETA — regexes que sólo usan los helpers
//     de conciliación de acá abajo.
//   · plusDeRegistro, tieneRolEnvasado, esRegistroManual, motivoExclusionRegistro,
//     granelesDeRegistro, pluComponentePorNombre,
//     tipoComponentePorNombre, filaComponente, consumoRealDeRegistros,
//     productosDeConciliacion, conciliacionProduccion — el motor de conciliación
//     completo: sólo lo llaman GET /api/produccion/:fecha/conciliacion y POST
//     /api/produccion/:fecha/registrar-movimiento, las dos de acá.
//
// Todo lo demás que tocan estas rutas (resolverSucursal, depositosActivos,
// sucursalDeReserva, chequearSucursalReserva, trasladarStock,
// registrarMovimientoMultilinea, ejecutarYRegistrar, conLogError, leerMovLog,
// leerPlanReservas, sincronizarPlanConLog, sincronizarReservaConLog,
// migrarReservas, saldoLedger, itemsSinReservar, reservadoPorMovimiento,
// conciliarPorMovimiento, componentesDePlan, componentesFormulaPorPadre,
// stockDeComponentes, cambiosDelPlan, deltaReserva, componentesPendientes,
// firmaPlanReserva, itemsFirmables, itemsDeComponentes, sellarItems,
// detalleItemsReserva, reservaAjustada, tipoMovimientoAjusteReserva,
// ejecutarDevolucionReserva, saldoItemReserva, ordenesProducidasDeReserva,
// motivoBloqueoProduccion, tiposPackaging, depositosProduccion, cfgReserva,
// cfgProduccion, restanteMayoristaPorReserva, restantePedidoPorReserva,
// granelReservadoNeto, granelReservadoPorPlu, terminadosPorPluDeConciliacion,
// imputarEntregaMayorista, basesEntregaMayorista, agruparRestante,
// partirConsumoMayorista, lineasProduccionDesdeConciliacion, lineasAjusteMovimiento,
// lineasDiferenciasProduccion, registrosYaRegistrados, archivarRegistros,
// asientosProduccion, esIdDeposito, idDepositoODefault, redondear4, getPoolStock,
// leerJSON, guardarJSON, PLANES_PATH, PROD_REG_PATH, RESERVAS_MERC_PATH,
// TIPOS_MOVIMIENTO_STOCK_PERMITIDOS, ERR_RESERVA_SIN_CONFIG, ERR_RESERVA_DEPOSITOS)
// lo usa también rutas_stock.js, rutas_mayoristas.js o el resto de server.js: se
// queda en server.js y viaja por acá.
module.exports = function crearRutasReservas(deps) {
  const {
    apiRoute, safeDate, query,
    leerJSON, guardarJSON, PLANES_PATH, PROD_REG_PATH, RESERVAS_MERC_PATH,
    resolverSucursal, depositosActivos, sucursalDeReserva, chequearSucursalReserva,
    esIdDeposito, idDepositoODefault, redondear4,
    trasladarStock, registrarMovimientoMultilinea, getPoolStock, ejecutarYRegistrar, conLogError,
    leerMovLog, leerPlanReservas, sincronizarPlanConLog, sincronizarReservaConLog,
    migrarReservas, saldoLedger, itemsSinReservar, reservadoPorMovimiento, conciliarPorMovimiento,
    componentesDePlan, componentesFormulaPorPadre, stockDeComponentes,
    cambiosDelPlan, deltaReserva, componentesPendientes, firmaPlanReserva, itemsFirmables,
    itemsDeComponentes, sellarItems, detalleItemsReserva,
    reservaAjustada, tipoMovimientoAjusteReserva,
    ejecutarDevolucionReserva, saldoItemReserva,
    ordenesProducidasDeReserva, motivoBloqueoProduccion,
    tiposPackaging,
    depositosProduccion, cfgReserva, cfgProduccion,
    restanteMayoristaPorReserva, restantePedidoPorReserva, granelReservadoNeto, granelReservadoPorPlu,
    terminadosPorPluDeConciliacion, imputarEntregaMayorista, basesEntregaMayorista, agruparRestante,
    partirConsumoMayorista, lineasProduccionDesdeConciliacion, lineasAjusteMovimiento, lineasDiferenciasProduccion,
    registrosYaRegistrados, archivarRegistros, asientosProduccion,
    TIPOS_MOVIMIENTO_STOCK_PERMITIDOS, ERR_RESERVA_SIN_CONFIG, ERR_RESERVA_DEPOSITOS,
  } = deps;
  const router = express.Router();

router.get('/api/plan/:fecha/reserva', apiRoute(async req => {
  const fecha = safeDate(req.params.fecha);
  const s     = await resolverSucursal(req.query.idSucursal);
  if (s.error) return { error: s.error };
  const cr    = s.cr;
  // Auto-reparación: antes de armar la respuesta se contrasta la reserva contra el log de
  // movimientos y, si hace falta, se corrige y se persiste el plan. Así un plan que quedó
  // marcado como reservado después de revertir sus movimientos desde el historial se
  // arregla solo al abrir el modal, sin tocar el JSON a mano.
  // LIMITACIÓN CONOCIDA: planes.json está indexado SÓLO por fecha, no por fecha+sucursal.
  // Hay un único plan por día para todas las sucursales, así que cambiar de sucursal no
  // cambia el plan que se lee acá: lo único que distingue una sucursal de otra es la
  // reserva, que congela la suya en reserva.idSucursal (ver sucursalDeReserva). Indexar por
  // fecha+sucursal sería una migración del archivo y queda fuera de este cambio.
  const plan  = sincronizarPlanConLog(fecha).plan || { fecha, notas: '', items: [] };
  const { componentes, itemsSinFormula, sustituciones } = await componentesDePlan(plan.items || []);

  // Depósitos efectivos del preview: los del query si son válidos, si no los de config.
  // El destino puede quedar en null (config sin depósito de reserva y sin elección todavía).
  const depOrigen  = idDepositoODefault(req.query.depOrigen,  cr.depositoPrincipal);
  const depDestino = idDepositoODefault(req.query.depDestino, cr.depositoReserva);

  const depositos = await depositosActivos(cr.idSucursal);
  const stock     = await stockDeComponentes(cr, componentes.map(c => c.plu), depOrigen, depDestino);

  const depReservaCfg = depositos.find(d => Number(d.IdDeposito) === cr.depositoReserva);
  const nombreDepositoReserva = depReservaCfg ? String(depReservaCfg.NombreDeposito || '').trim() : null;

  // Estado de la reserva frente a las órdenes de hoy: firma, qué cambió y qué habría que
  // mover para poner la reserva al día.
  const reservaActiva = !!(plan.reserva && plan.reserva.estado === 'activa');
  const cambios = cambiosDelPlan(plan.items || [], plan.reserva);
  const delta   = reservaActiva
    ? deltaReserva(componentesPendientes(componentes, plan.items || []), plan.reserva)
    : [];

  // La reserva activa puede ser de otra sucursal. Acá NO se falla (es sólo lectura): se
  // informa para que la pantalla avise antes de intentar reservar, actualizar o devolver.
  const sucReserva = reservaActiva ? sucursalDeReserva(plan.reserva) : null;
  const sucursalDistinta = reservaActiva && sucReserva !== cr.idSucursal
    ? { deLaReserva: sucReserva, pedida: cr.idSucursal } : null;

  // Los IDs de depósito son POR sucursal: el preseleccionado de config puede no existir en
  // la sucursal pedida. En ese caso la selección vuelve a null en vez de exponer un ID que
  // no se puede usar.
  const activos   = new Set(depositos.map(d => Number(d.IdDeposito)));
  const depValido = d => (esIdDeposito(d) && activos.has(d) ? d : null);

  return {
    firma: {
      actual:    firmaPlanReserva(plan.items || []),
      reservada: reservaActiva ? (plan.reserva.firma || null) : null,
      hayCambios: cambios.hayCambios
    },
    cambios: cambios.detalle,
    delta,
    config: {
      idSucursal: cr.idSucursal, depositoPrincipal: cr.depositoPrincipal,
      depositoReserva: cr.depositoReserva, configurado: cr.depositoReserva != null, nombreDepositoReserva
    },
    depositos: depositos.map(d => ({
      idDeposito: Number(d.IdDeposito), nombre: String(d.NombreDeposito || '').trim(),
      tipoDeposito: d.TipoDeposito, disponibleVenta: d.DisponibleVenta
    })),
    seleccion: { depOrigen: depValido(depOrigen), depDestino: depValido(depDestino) },
    // Presente sólo cuando la reserva activa es de otra sucursal (si no, null).
    sucursalDistinta,
    componentes: componentes.map(c => {
      const s = stock.get(c.plu) || { origen: 0, destino: 0 };
      return {
        plu: c.plu, nombre: c.nombre, rubro: c.rubro, necesario: c.necesario,
        stockOrigen: redondear4(s.origen), stockDestino: redondear4(s.destino),
        faltante: redondear4(Math.max(0, c.necesario - s.origen)), porItem: c.porItem,
        origen: c.origen, reemplazaA: c.reemplazaA
      };
    }),
    reserva: plan.reserva || null,
    // Qué se movió por cada línea del plan y con qué comprobante de SiGA.
    porItem: detalleItemsReserva(plan.items || [], plan.reserva),
    itemsSinFormula,
    // Envases y tapas elegidos en la planificación que reemplazaron (o agregaron) componentes.
    sustituciones
  };
}));

router.get('/api/plan/:fecha/reservas-resumen', apiRoute(async req => {
  const fecha = safeDate(req.params.fecha);
  const { plan } = leerPlanReservas(fecha);
  if (!plan) return { fecha, reservas: [] };
  const porItem = new Map((plan.items || []).map(it => [String(it.id), it]));

  // Los ajustes de reserva NO dejan entrada en plan.reservas (viven en reserva.ajustes), pero
  // sí sellan ítems: si no se listan acá el sello queda sin botón para revertirlo y la orden
  // no se puede borrar más. Se arman con el mismo shape que una reserva del ledger.
  const ajustes = leerMovLog()
    .filter(m => m && m.plan === fecha && m.origen === 'ajuste' && m.estado === 'confirmado' && m.numeroMovimiento != null)
    .map(m => {
      const ordenes = (plan.items || [])
        .filter(it => it.reservaMovimiento && String(it.reservaMovimiento.numeroMovimiento) === String(m.numeroMovimiento))
        .map(it => it.id);
      return { m, ordenes };
    })
    .filter(({ ordenes }) => ordenes.length)
    .map(({ m, ordenes }) => {
      const producidas = ordenesProducidasDeReserva({ ordenes }, plan.items);
      const producidasPorId = new Map(producidas.map(p => [String(p.id), p.numeroMovimiento]));
      return {
        numeroMovimiento: m.numeroMovimiento, estado: 'activa', fecha: m.fechaHora,
        fechaPlanificacion: m.fechaHora, idRegistro: m.id, origen: 'ajuste',
        ordenes: ordenes.map(id => {
          const it = porItem.get(String(id));
          return { id, producto: it ? (it.producto || it.nombre || '') : '',
                   produccionMovimiento: producidasPorId.get(String(id)) ?? null };
        }),
        bloqueoProduccion: motivoBloqueoProduccion(producidas, 'revertir este movimiento'),
        productos: (m.lineas || []).map(l => ({ plu: String(l.plu), nombre: l.nombre || '', cantidad: l.cantidad })),
      };
    });

  return {
    fecha,
    reservas: (plan.reservas || []).map(r => {
      // bloqueoProduccion viaja al frontend para que el botón Revertir salga deshabilitado con
      // el motivo a la vista, en vez de dejar clickear y fallar recién contra el servidor.
      const producidas = ordenesProducidasDeReserva(r, plan.items);
      const producidasPorId = new Map(producidas.map(p => [String(p.id), p.numeroMovimiento]));
      return {
        numeroMovimiento: r.numeroMovimiento, estado: r.estado, fecha: r.fecha,
        fechaPlanificacion: r.fechaPlanificacion, idRegistro: r.idRegistro,
        ordenes: (Array.isArray(r.ordenes) ? r.ordenes : []).map(id => {
          const it = porItem.get(String(id));
          return { id, producto: it ? (it.producto || it.nombre || '') : '',
                   produccionMovimiento: producidasPorId.get(String(id)) ?? null };
        }),
        bloqueoProduccion: motivoBloqueoProduccion(producidas, 'revertir este movimiento'),
        productos: (r.lineas || []).map(l => ({ plu: String(l.plu), nombre: l.nombre || '', cantidad: l.cantidad })),
        origen: 'reserva',
      };
    }).concat(ajustes),
  };
}));

router.post('/api/plan/:fecha/reservar', apiRoute(async req => {
  const fecha = safeDate(req.params.fecha);
  const b     = req.body || {};
  const s     = await resolverSucursal(b.idSucursal);
  if (s.error) return { error: s.error };
  const cr    = s.cr;

  // Depósitos elegidos en el modal; si no vienen se usan los de config. Si vienen pero
  // son inválidos NO se cae al config: se avisa para no reservar en el depósito equivocado.
  const vinoOrigen  = b.depOrigen  !== undefined && b.depOrigen  !== null && b.depOrigen  !== '';
  const vinoDestino = b.depDestino !== undefined && b.depDestino !== null && b.depDestino !== '';
  const depOrigen   = vinoOrigen  ? Number(b.depOrigen)  : cr.depositoPrincipal;
  const depDestino  = vinoDestino ? Number(b.depDestino) : cr.depositoReserva;
  if (!vinoDestino && !cr.depositoReserva) return { error: ERR_RESERVA_SIN_CONFIG };
  if (!esIdDeposito(depOrigen) || !esIdDeposito(depDestino) || depOrigen === depDestino) {
    return { error: ERR_RESERVA_DEPOSITOS };
  }

  const activos = new Set((await depositosActivos(cr.idSucursal)).map(d => Number(d.IdDeposito)));
  if (!activos.has(depOrigen))  return { error: `El depósito de origen ${depOrigen} no existe o no está activo en la sucursal ${cr.idSucursal}` };
  if (!activos.has(depDestino)) return { error: `El depósito de destino ${depDestino} no existe o no está activo en la sucursal ${cr.idSucursal}` };

  // planes.json está indexado sólo por fecha (un plan por día para TODAS las sucursales,
  // ver el comentario en GET /api/plan/:fecha/reserva): lo único que ata el plan a una
  // sucursal es su reserva.
  const planes   = leerJSON(PLANES_PATH, {});
  const guardado = planes[fecha];
  if (!guardado || !(guardado.items || []).length) return { error: 'El plan no tiene ítems para reservar' };
  // Auto-reparación antes de decidir si ya hay una reserva activa: si los movimientos de la
  // reserva anterior se revirtieron desde el historial, acá queda 'anulada' y se puede
  // volver a reservar.
  const sync = sincronizarReservaConLog(fecha, guardado);
  if (sync.cambio) { planes[fecha] = sync.plan; guardarJSON(PLANES_PATH, planes); }
  let plan = planes[fecha];
  // Una reserva activa de otra sucursal bloquea todo: no se ejecuta ningún movimiento.
  // Los depósitos y el stock son por sucursal, así que operar acá dejaría la mercadería
  // en el lugar equivocado.
  const errSucursal = chequearSucursalReserva(plan.reserva, cr.idSucursal);
  if (errSucursal) return { error: errSucursal };
  // Con reserva activa no se vuelve a reservar, salvo que hayan cambiado las órdenes del
  // plan del día: en ese caso se ofrece actualizar la reserva moviendo sólo la diferencia.
  // Reserva incremental: sólo las órdenes que todavía no tienen sello de movimiento.
  const sinReservar = itemsSinReservar(plan.items);
  if (!sinReservar.length) {
    return { error: 'Todas las órdenes del plan ya están reservadas. Agregá productos nuevos para reservar.', yaReservado: true };
  }
  const { componentes } = await componentesDePlan(sinReservar);
  if (!componentes.length) {
    // Sin componentes puede ser porque el plan no tiene fórmulas, o porque TODOS los ítems
    // con fórmula ya fueron producidos y recepcionados (produccionMovimiento). Se distingue
    // recomputando los componentes de los ítems sellados sin el sello: si ahí sí hay
    // componentes, el plan no está vacío, simplemente ya se produjo todo.
    const producidos = (plan.items || []).filter(it => it && it.produccionMovimiento);
    if (producidos.length) {
      const sinSello = producidos.map(it => { const c = { ...it }; delete c.produccionMovimiento; return c; });
      const { componentes: hip } = await componentesDePlan(sinSello);
      if (hip.length) {
        const num = (plan.produccionRegistrada && plan.produccionRegistrada.numeroMovimiento)
          ?? producidos[0].produccionMovimiento.numeroMovimiento;
        return { error: `Todos los productos del plan ya fueron producidos y recepcionados (movimiento #${num}). Agregá productos nuevos al plan para reservar.`,
                 todoProducido: true };
      }
    }
    return { error: 'Ningún ítem del plan tiene componentes de fórmula para reservar' };
  }

  const stock = await stockDeComponentes(cr, componentes.map(c => c.plu), depOrigen, depDestino);
  // stockPrincipal se mantiene como alias de stockOrigen para no romper la UI vieja.
  const faltantes = componentes.map(c => {
    const s = stock.get(c.plu) || { origen: 0, destino: 0 };
    return { plu: c.plu, nombre: c.nombre, necesario: c.necesario,
             stockOrigen: redondear4(s.origen), stockPrincipal: redondear4(s.origen),
             faltante: redondear4(Math.max(0, c.necesario - s.origen)) };
  }).filter(f => f.faltante > 0);
  // Con permitirFaltante se reserva igual la cantidad necesaria completa (el depósito
  // de origen puede quedar en negativo); sin él no se escribe nada.
  if (faltantes.length && b.permitirFaltante !== true) {
    return { error: 'Hay componentes sin stock suficiente en el depósito de origen', faltantes };
  }

  const poolW = await getPoolStock();
  const observacion = `PLAN ${fecha} RESERVA ${depOrigen}>${depDestino}`.slice(0, 200);
  const r = await ejecutarYRegistrar({
    origen: 'reserva', plan: fecha, itemId: null,
    idSucursal: cr.idSucursal, depOrigen, depDestino, idEmpleado: cr.idEmpleado,
    idTipoMovimiento: cr.idTipoMovimiento, usuario: cr.usuario, observacion,
    lineas: componentes.map(c => ({ plu: c.plu, nombre: c.nombre, cantidad: c.necesario }))
  }, () => trasladarStock(poolW, {
    idSucursal: cr.idSucursal, depOrigen, depDestino,
    idTipoMovimiento: cr.idTipoMovimiento, usuario: cr.usuario, idEmpleado: cr.idEmpleado,
    observacion,
    lineas: componentes.map(c => ({ idProducto: c.plu, cantidad: c.necesario }))
  }));
  const numero = r.numeroMovimiento;

  const lineas = componentes.map(c => ({ plu: c.plu, nombre: c.nombre, cantidad: c.necesario, porItem: c.porItem }));
  plan = migrarReservas(plan);
  const ahora = new Date().toISOString();
  const nueva = {
    numeroMovimiento: numero, idRegistro: r.idRegistro ?? null, estado: 'activa',
    fecha: ahora, fechaPlanificacion: fecha,
    idSucursal: cr.idSucursal, depOrigen, depDestino,
    ordenes: [...itemsDeComponentes(componentes)],
    lineas, devoluciones: [],
  };
  plan.reservas = [...plan.reservas, nueva];
  plan.items = sellarItems(plan.items, itemsDeComponentes(componentes), 'reservaMovimiento',
    { numeroMovimiento: numero, fecha: ahora, idRegistro: r.idRegistro ?? null, depOrigen, depDestino },
    { limpiarDevuelta: true });
  // Compat: mantener plan.reserva apuntando a la última reserva activa para el código viejo.
  plan.reserva = { ...nueva, usuario: cr.usuario, firma: firmaPlanReserva(plan.items), items: itemsFirmables(plan.items), ajustes: [] };
  planes[fecha] = plan;
  guardarJSON(PLANES_PATH, planes);
  return conLogError({ ok: true, numeroMovimiento: numero, idSucursal: cr.idSucursal, depOrigen, depDestino, lineas, idRegistro: r.idRegistro }, r.logError);
}));

// Pone la reserva al día cuando cambiaron las órdenes del plan: mueve sólo la diferencia
// entre lo reservado y lo que el plan necesita ahora (puede salir un comprobante de
// reserva y otro de devolución en la misma llamada).
router.post('/api/plan/:fecha/reserva/actualizar', apiRoute(async req => {
  const fecha  = safeDate(req.params.fecha);
  const b      = req.body || {};
  const s      = await resolverSucursal(b.idSucursal);
  if (s.error) return { error: s.error };
  const cr     = s.cr;
  const planes = leerJSON(PLANES_PATH, {});
  const plan   = planes[fecha];
  if (!plan) return { error: 'Plan no encontrado' };

  const reserva = plan.reserva;
  if (!reserva || reserva.estado !== 'activa') {
    return { error: 'El plan no tiene una reserva activa; usá Reservar para crearla' };
  }
  // Igual que al reservar: si la reserva es de otra sucursal no se mueve nada.
  const errSucursal = chequearSucursalReserva(reserva, cr.idSucursal);
  if (errSucursal) return { error: errSucursal };
  // Los dos comprobantes del ajuste salen en la sucursal congelada en la reserva.
  const crReserva = { ...cr, idSucursal: sucursalDeReserva(reserva) };
  const n = reserva.numeroMovimiento;
  const { hayCambios } = cambiosDelPlan(plan.items || [], reserva);
  if (!hayCambios) {
    return { error: `Este plan ya tiene la reserva #${n} hecha. Para volver a reservar, modificá las órdenes del plan del día.`,
             yaReservado: true, numeroMovimiento: n };
  }

  // Los depósitos son los de la reserva original; el config sólo es fallback de reservas
  // viejas guardadas antes de poder elegirlos en el modal.
  const depOrigen  = idDepositoODefault(reserva.depOrigen,  cr.depositoPrincipal);
  const depDestino = idDepositoODefault(reserva.depDestino, cr.depositoReserva);
  if (!esIdDeposito(depOrigen) || !esIdDeposito(depDestino) || depOrigen === depDestino) {
    return { error: ERR_RESERVA_DEPOSITOS };
  }

  const { componentes } = await componentesDePlan(plan.items || []);
  const objetivo = componentesPendientes(componentes, plan.items || []);
  const delta    = deltaReserva(objetivo, reserva);

  const nuevasLineas = objetivo.map(c => ({ plu: c.plu, nombre: c.nombre, cantidad: c.necesario, porItem: c.porItem }));
  const firma = firmaPlanReserva(plan.items || []);
  const items = itemsFirmables(plan.items || []);

  if (!delta.length) {
    // El plan cambió de una forma que no altera los componentes (por ejemplo se eligió un
    // envase que otro ítem ya usaba): no hay nada que mover, pero igual se refresca la
    // firma para dejar de avisar por un cambio que la reserva ya contempla.
    plan.reserva = reservaAjustada(reserva, { lineas: nuevasLineas, firma, items, ajustes: [] });
    guardarJSON(PLANES_PATH, planes);
    return { error: 'No hay diferencias que mover: la reserva ya coincide con el plan' };
  }

  const positivos = delta.filter(d => d.delta > 0);
  const negativos = delta.filter(d => d.delta < 0);

  if (positivos.length) {
    const stock = await stockDeComponentes(crReserva, positivos.map(d => d.plu), depOrigen, depDestino);
    const faltantes = positivos.map(d => {
      const s = stock.get(d.plu) || { origen: 0, destino: 0 };
      return { plu: d.plu, nombre: d.nombre, necesario: d.delta,
               stockOrigen: redondear4(s.origen), stockPrincipal: redondear4(s.origen),
               faltante: redondear4(Math.max(0, d.delta - s.origen)) };
    }).filter(f => f.faltante > 0);
    if (faltantes.length && b.permitirFaltante !== true) {
      return { error: 'Hay componentes sin stock suficiente en el depósito de origen', faltantes };
    }
  }

  const poolW  = await getPoolStock();
  // Los dos sentidos del ajuste corrigen una reserva ya hecha, así que van con el tipo de
  // producción (REC-SUC), no con el del apartado y su devolución (BIENESUSO).
  const tipoAjuste = tipoMovimientoAjusteReserva();
  const base   = { idSucursal: crReserva.idSucursal, idTipoMovimiento: tipoAjuste, usuario: cr.usuario, idEmpleado: cr.idEmpleado };
  const ahora  = new Date().toISOString();
  const movimientos = [], ajustes = [], logErrores = [];

  // Ítems que participan de cada sentido del ajuste. Los que suman salen por el comprobante
  // de reserva; los que sólo intervienen en el sentido inverso quedan con el de devolución.
  // Para el sentido inverso se miran también las líneas viejas: un componente puede bajar
  // justamente porque el ítem que lo pedía ya no está en el objetivo.
  const plusPositivos = new Set(positivos.map(d => String(d.plu)));
  const plusNegativos = new Set(negativos.map(d => String(d.plu)));
  const idsReserva    = itemsDeComponentes(objetivo.filter(c => plusPositivos.has(String(c.plu))));
  const idsDevolucion = new Set([
    ...itemsDeComponentes((reserva.lineas || []).filter(l => plusNegativos.has(String(l.plu)))),
    ...itemsDeComponentes(objetivo.filter(c => plusNegativos.has(String(c.plu))))
  ].filter(id => !idsReserva.has(id)));

  // Los dos sentidos del ajuste salen como dos comprobantes distintos y por lo tanto dejan
  // dos registros separados en el log, ambos con origen 'ajuste' (el sentido se distingue
  // por los depósitos: el de devolución los lleva invertidos).
  if (positivos.length) {
    const lineasMov   = positivos.map(d => ({ plu: d.plu, nombre: d.nombre, cantidad: d.delta }));
    const observacion = `PLAN ${fecha} AJUSTE+ ${depOrigen}>${depDestino}`.slice(0, 200);
    const r = await ejecutarYRegistrar({
      origen: 'ajuste', plan: fecha, itemId: null,
      idSucursal: crReserva.idSucursal, depOrigen, depDestino, idEmpleado: cr.idEmpleado,
      idTipoMovimiento: tipoAjuste, usuario: cr.usuario, observacion, lineas: lineasMov
    }, () => trasladarStock(poolW, {
      ...base, depOrigen, depDestino, observacion,
      lineas: lineasMov.map(l => ({ idProducto: l.plu, cantidad: l.cantidad }))
    }));
    logErrores.push(r.logError);
    movimientos.push({ numeroMovimiento: r.numeroMovimiento, sentido: 'reserva', idRegistro: r.idRegistro });
    ajustes.push({ numeroMovimiento: r.numeroMovimiento, fecha: ahora, sentido: 'reserva', lineas: lineasMov });
    // El ítem guarda el ÚLTIMO movimiento que lo cubre; el histórico completo queda en
    // reserva.ajustes y en el log de movimientos.
    plan.items = sellarItems(plan.items, idsReserva, 'reservaMovimiento',
      { numeroMovimiento: r.numeroMovimiento, fecha: ahora, idRegistro: r.idRegistro ?? null, depOrigen, depDestino },
      { limpiarDevuelta: true });
  }

  if (negativos.length) {
    const lineasMov   = negativos.map(d => ({ plu: d.plu, nombre: d.nombre, cantidad: redondear4(Math.abs(d.delta)) }));
    const observacion = `PLAN ${fecha} AJUSTE- ${depDestino}>${depOrigen}`.slice(0, 200);
    const r = await ejecutarYRegistrar({
      origen: 'ajuste', plan: fecha, itemId: null,
      idSucursal: crReserva.idSucursal, depOrigen: depDestino, depDestino: depOrigen, idEmpleado: cr.idEmpleado,
      idTipoMovimiento: tipoAjuste, usuario: cr.usuario, observacion, lineas: lineasMov
    }, () => trasladarStock(poolW, {
      ...base, depOrigen: depDestino, depDestino: depOrigen, observacion,
      lineas: lineasMov.map(l => ({ idProducto: l.plu, cantidad: l.cantidad }))
    }));
    logErrores.push(r.logError);
    movimientos.push({ numeroMovimiento: r.numeroMovimiento, sentido: 'devolucion', idRegistro: r.idRegistro });
    ajustes.push({ numeroMovimiento: r.numeroMovimiento, fecha: ahora, sentido: 'devolucion', lineas: lineasMov });
    // Ítems que sólo intervinieron en este sentido: no recibieron nada, así que se sellan
    // con el comprobante del ajuste pero conservan su devolución previa si la tenían.
    plan.items = sellarItems(plan.items, idsDevolucion, 'reservaMovimiento',
      { numeroMovimiento: r.numeroMovimiento, fecha: ahora, idRegistro: r.idRegistro ?? null, depOrigen: depDestino, depDestino: depOrigen });
  }

  plan.reserva = reservaAjustada(reserva, { lineas: nuevasLineas, firma, items, ajustes });
  guardarJSON(PLANES_PATH, planes);
  return conLogError({ ok: true, movimientos, delta }, ...logErrores);
}));

router.post('/api/plan/:fecha/reserva/devolver', apiRoute(async req => {
  const fecha  = safeDate(req.params.fecha);
  const planes = leerJSON(PLANES_PATH, {});
  const plan   = planes[fecha];
  if (!plan) return { error: 'Plan no encontrado' };

  const b = req.body || {};
  const itemId = b.itemId == null || b.itemId === '' ? null : parseInt(b.itemId);
  if (itemId != null && !Number.isInteger(itemId)) return { error: 'itemId inválido' };

  const s = await resolverSucursal(b.idSucursal);
  if (s.error) return { error: s.error };
  // La devolución se ejecuta con la sucursal de la reserva (ver ejecutarDevolucionReserva);
  // si la pantalla está parada en otra, no se mueve nada y se avisa.
  const errSucursal = chequearSucursalReserva(plan.reserva, s.idSucursal);
  if (errSucursal) return { error: errSucursal };

  // El saldo por ítem se calcula ANTES de la devolución: después ya está todo devuelto.
  const reservaPrevia = plan.reserva;
  const r = await ejecutarDevolucionReserva(plan, itemId);
  if (r.error) return { error: r.error };
  plan.reserva = r.reserva;

  // Anulación total: se sella la devolución en todos los ítems que tenían saldo.
  // Con itemId el sello lo escribe quien dispara la devolución de ese ítem.
  if (itemId == null) {
    const conSaldo = (plan.items || []).filter(it => saldoItemReserva(reservaPrevia, it.id).length).map(it => it.id);
    plan.items = sellarItems(plan.items, conSaldo, 'reservaDevuelta',
      { numeroMovimiento: r.numeroMovimiento, fecha: new Date().toISOString(), idRegistro: r.idRegistro ?? null,
        depOrigen: r.depOrigen, depDestino: r.depDestino });
  }
  guardarJSON(PLANES_PATH, planes);
  return conLogError({ ok: true, numeroMovimiento: r.numeroMovimiento, lineas: r.lineas, idRegistro: r.idRegistro }, r.logError);
}));

// ── Conciliación: producción cargada vs reserva del día ────────────────────────
// Pantalla de verificación previa al alta de producción. Cruza tres registros que hoy
// viven separados: lo que se reservó (plan.reserva), lo que efectivamente se movió
// (movimientos_stock.json) y lo que el operario declaró haber producido y consumido
// (produccion_registros.json), para que las diferencias se vean ANTES de tocar stock.
// ES SÓLO LECTURA: no ejecuta ningún movimiento. Lo único que escribe es la
// sincronización de la reserva con el log, igual que GET /api/plan/:fecha/reserva.

// RE_ROL_ENVASADO / tieneRol / etiquetaDeFormula / la regla del packaging: lib/produccion_packaging.js.
const RE_NOMBRE_ETIQUETA = /^\s*etiquetas?\b/i;

// Un registro puede traer varios PLU juntos ("2892, 2891"): se separan y se sanitizan.
// 'ACT' (tarea extra) no tiene dígitos, así que devuelve [].
function plusDeRegistro(valor) {
  return String(valor ?? '').split(',').map(s => s.replace(/\D/g, '')).filter(Boolean);
}

function tieneRolEnvasado(reg) { return tieneRol(reg, RE_ROL_ENVASADO); }

// Carga manual: producción que se cargó a mano, sin orden del plan detrás (ordenId null). Por
// motivos externos no se planifica, así que no hay reserva contra la cual conciliarla: se
// resuelve entera en el depósito de recepción y queda fuera del cuadro reserva-vs-producción.
function esRegistroManual(reg) {
  return !reg || reg.ordenId === null || reg.ordenId === undefined || reg.ordenId === '';
}

// Motivo por el que un registro NO entra al alta de producción, o null si entra.
function motivoExclusionRegistro(reg) {
  if (String((reg && reg.plu) || '').trim().toUpperCase() === 'ACT') return 'tarea-extra';
  if (!tieneRolEnvasado(reg)) return 'sin-rol-envasado';
  return null;
}

// graneles es la clave nueva (varios por registro); si viene vacía manda el par suelto
// granel/nombreGranel/granelConsumido, que es como se cargaban antes.
function granelesDeRegistro(reg) {
  if (Array.isArray(reg && reg.graneles) && reg.graneles.length) return reg.graneles;
  if (reg && reg.nombreGranel) {
    return [{ granel: reg.granel || null, nombreGranel: reg.nombreGranel, granelConsumido: reg.granelConsumido }];
  }
  return [];
}

// Un granel cargado sin PLU sólo se puede resolver por nombre contra la fórmula del
// producto. Se compara sin distinguir mayúsculas ni espacios de más.
function pluComponentePorNombre(comps, nombre) {
  const buscado = String(nombre || '').trim().toLowerCase();
  if (!buscado) return '';
  const c = (comps || []).find(x => String(x.nombre || '').trim().toLowerCase() === buscado);
  return c ? c.plu : '';
}

// Tipo de un componente que quedó reservado y no se usó: no pasó por ningún registro de
// producción, así que sólo se lo puede clasificar por el nombre. null = no se pudo.
function tipoComponentePorNombre(nombre) {
  const t = tiposPackaging(nombre, '');
  if (t.esTapa)   return 'tapa';
  if (t.esEnvase) return 'envase';
  if (RE_NOMBRE_ETIQUETA.test(String(nombre || '')) || String(nombre || '').toUpperCase().includes('ETIQUET')) return 'etiqueta';
  return null;
}

function filaComponente(plu, nombre, tipo, reservado, usado) {
  const res = redondear4(reservado), uso = redondear4(usado);
  const diferencia = redondear4(uso - res);
  return { plu: plu || null, nombre: String(nombre || ''), tipo,
           reservado: res, usado: uso, diferencia,
           falta: diferencia > 0, sobra: diferencia < 0 };
}

// Consumo real declarado por los registros que entran al alta (y los sólo-Etiquetado, que
// aportan nada más que su etiqueta), agregado por componente.
// formulas es el Map padre → componentes de fórmula activa (puede venir vacío si SiGA no
// respondió: en ese caso no hay etiquetas y los graneles sin PLU quedan sin resolver).
// Devuelve { componentes: Map, avisos: [] }.
function consumoRealDeRegistros(incluidos, formulas) {
  const usados = new Map(), avisos = [];
  const sumar = (plu, nombre, tipo, cantidad) => {
    // Cantidad 0 (o negativa) no se acumula: es un componente que el operario puso en cero,
    // el mismo criterio con el que el CSV lo omite.
    if (!(cantidad > 0)) return;
    const clave = plu ? `plu:${plu}` : `nombre:${String(nombre || '').trim().toLowerCase()}`;
    const e = usados.get(clave) || { plu: plu || null, nombre: String(nombre || ''), tipo, usado: 0 };
    e.usado = redondear4(e.usado + cantidad);
    if (!e.nombre) e.nombre = String(nombre || '');
    usados.set(clave, e);
  };

  for (const reg of incluidos) {
    const pluProd  = plusDeRegistro(reg.plu)[0] || null;
    const comps    = (pluProd && formulas.get(pluProd)) || [];
    const etiqueta = String(reg.nombre || reg.plu || 'sin nombre');

    // Sin Envasado (carga sólo de Etiquetado) no hay granel que consumir.
    for (const g of (tieneRolEnvasado(reg) ? granelesDeRegistro(reg) : [])) {
      const consumido    = Number(g && g.granelConsumido) || 0;
      const nombreGranel = String((g && g.nombreGranel) || '').trim();
      if (!consumido) continue;
      const pluGranel = String((g && g.granel) ?? '').replace(/\D/g, '') || pluComponentePorNombre(comps, nombreGranel);
      if (!pluGranel) {
        avisos.push(`Granel sin PLU: "${nombreGranel || 'sin nombre'}" (${consumido}) en ${etiqueta}. `
                  + 'No se puede dar de baja hasta identificarlo.');
      }
      sumar(pluGranel || null, nombreGranel || 'Granel sin identificar', 'granel', consumido);
    }

    // Envase/tapa (con Envasado) y etiqueta (con Etiquetado): cantidades guardadas en la carga,
    // o el cálculo viejo si el registro es anterior a guardarlas (ver packagingDeRegistro).
    const pack = packagingDeRegistro(reg, comps);
    for (const l of pack.lineas) sumar(l.plu, l.nombre, l.tipo, l.cantidad);
    if (pack.sinEtiqueta && comps.length) avisos.push(`La fórmula de ${etiqueta} no tiene etiqueta: no se descuenta ninguna.`);
  }
  return { componentes: usados, avisos };
}

// Productos de la fecha agrupados para el alta. Los excluidos NO se esconden: se
// devuelven marcados con su motivo para que la pantalla muestre qué queda afuera.
// La clave incluye el motivo: un mismo PLU con registros incluidos y excluidos da dos
// filas, porque sólo una de las dos cantidades se va a dar de alta.
function productosDeConciliacion(registros) {
  const grupos = new Map();
  for (const reg of registros) {
    const pluTexto = String(reg.plu ?? '').trim();
    const plus     = plusDeRegistro(pluTexto);
    const excluido = motivoExclusionRegistro(reg);
    // La carga manual también parte la clave: un mismo PLU cargado a mano y por orden da dos
    // filas, porque sólo una de las dos se concilia contra la reserva.
    const manual   = esRegistroManual(reg);
    const clave    = `${pluTexto || `sin-plu-${reg.id}`}|${excluido || 'alta'}|${manual ? 'man' : 'plan'}`;
    const g = grupos.get(clave) || {
      plu: plus[0] || null, pluTexto, plus, nombre: String(reg.nombre || '').trim(),
      cantidad: 0, registros: 0, excluido, manual, detalle: []
    };
    if (!g.nombre) g.nombre = String(reg.nombre || '').trim();
    g.cantidad  = redondear4(g.cantidad + (Number(reg.cantFraccionada) || 0));
    g.registros += 1;
    // Detalle por registro individual (id + cantidad): sirve para separar lo ya registrado
    // de lo pendiente cuando una misma fecha se registra en varias tandas.
    g.detalle.push({ id: reg.id, cant: Number(reg.cantFraccionada) || 0 });
    grupos.set(clave, g);
  }
  return [...grupos.values()].sort((a, b) => a.nombre.localeCompare(b.nombre));
}

// idSucursal es la sucursal en la que está parada la pantalla: la conciliación es sólo
// lectura, así que no filtra nada, pero avisa si la reserva del día es de otra sucursal
// (planes.json tiene un único plan por fecha para todas: ver GET /api/plan/:fecha/reserva).
async function conciliacionProduccion(fecha, idSucursal) {
  const avisos    = [];
  const registros = leerJSON(PROD_REG_PATH, []).filter(r => r && r.fecha === fecha);
  if (!registros.length) avisos.push(`No hay producción cargada para el ${fecha}.`);

  // Asientos ya registrados de esta fecha: mapa registroId → { numeroMovimiento, fecha } para
  // marcar los productos y NO volver a descontar sus componentes. Se lee el plan una sola vez
  // acá (la reserva se sincroniza más abajo con la MISMA referencia).
  const planes = leerJSON(PLANES_PATH, {});
  let plan     = planes[fecha] || null;
  const regInfo = new Map();
  for (const a of asientosProduccion(plan)) {
    const lista = (Array.isArray(a.registros) && a.registros.length) ? a.registros : registros.map(r => r.id);
    for (const rid of lista) if (!regInfo.has(String(rid))) regInfo.set(String(rid), { numeroMovimiento: a.numeroMovimiento ?? null, fecha: a.fecha ?? null });
  }
  const estaRegistrado = r => regInfo.has(String(r.id));

  const productos = productosDeConciliacion(registros);
  // Marca de cada producto según sus registros: si TODOS están asentados → yaRegistrado; si sólo
  // algunos → parcial (y la cantidad pasa a ser sólo lo pendiente). Los ya registrados no
  // vuelven a aportar cantidad al alta ni sus componentes al descuento.
  for (const p of productos) {
    if (p.excluido) continue;
    const det = Array.isArray(p.detalle) ? p.detalle : [];
    const reg = det.filter(d => regInfo.has(String(d.id)));
    const pen = det.filter(d => !regInfo.has(String(d.id)));
    if (!reg.length) continue;
    const info = regInfo.get(String(reg[0].id)) || {};
    const asiento = { numeroMovimiento: info.numeroMovimiento ?? null, fecha: info.fecha ?? null };
    if (!pen.length) {
      p.yaRegistrado = asiento;
    } else {
      p.parcial = { ...asiento, cantidadRegistrada: redondear4(reg.reduce((s, d) => s + d.cant, 0)), registros: reg.length };
      p.cantidad  = redondear4(pen.reduce((s, d) => s + d.cant, 0));
      p.registros = pen.length;
    }
  }

  const incluidos = registros.filter(r => !motivoExclusionRegistro(r) && !estaRegistrado(r));
  // Sólo Etiquetado: fuera del alta, pero su etiqueta SÍ se descuenta. Mismo criterio de
  // "ya registrado" que el resto: el asiento guarda sus ids y no se vuelven a mover.
  const soloEtiqueta = registros.filter(r => esSoloEtiquetado(r) && !estaRegistrado(r) && plusDeRegistro(r.plu)[0]);
  const consumen  = [...incluidos, ...soloEtiqueta];
  const extras    = registros.filter(r => motivoExclusionRegistro(r) === 'tarea-extra').length;
  const sinRol    = registros.filter(r => motivoExclusionRegistro(r) === 'sin-rol-envasado').length;
  if (extras) avisos.push(`${extras} registro(s) son tareas extra (ACT): no dan de alta ningún producto.`);
  if (sinRol) avisos.push(`${sinRol} registro(s) no tienen el rol Envasado cargado y quedan fuera del alta`
                        + (soloEtiqueta.length ? ` (${soloEtiqueta.length} con Etiquetado: sólo descuentan la etiqueta).` : '.'));
  for (const p of productos) {
    if (p.plus.length > 1) {
      avisos.push(`El producto "${p.nombre || p.pluTexto}" tiene varios PLU cargados (${p.pluTexto}): `
                + `se usa ${p.plu} para la fórmula. Verificá cuál corresponde antes de dar el alta.`);
    } else if (!p.plu && !p.excluido) {
      avisos.push(`El producto "${p.nombre || p.pluTexto || 'sin nombre'}" no tiene un PLU numérico: no se puede dar de alta.`);
    }
  }

  // Fórmula activa de los productos que sí entran al alta: de ahí salen la etiqueta y el
  // PLU de los graneles cargados sólo por nombre. Si SiGA no responde la pantalla igual
  // se arma, con un aviso: el resto de la conciliación no depende de la base.
  let formulas = new Map();
  const plusFormula = [...new Set(consumen.map(r => plusDeRegistro(r.plu)[0]).filter(Boolean))];
  if (plusFormula.length) {
    try { formulas = await componentesFormulaPorPadre(plusFormula); }
    catch (e) { avisos.push(`No se pudo consultar la fórmula en SiGA (${e.message}): las etiquetas quedaron fuera de la conciliación.`); }
  }

  // El consumo se parte en dos: lo planificado (se concilia contra la reserva) y la carga
  // manual (no tiene reserva detrás: se resuelve en el depósito de recepción). Si se mezclaran,
  // el consumo manual se comería la reserva de las órdenes planificadas del mismo PLU.
  const incluidosPlan   = consumen.filter(r => !esRegistroManual(r));
  const incluidosManual = consumen.filter(r =>  esRegistroManual(r));
  const consumo       = consumoRealDeRegistros(incluidosPlan, formulas);
  const consumoManual = consumoRealDeRegistros(incluidosManual, formulas);
  avisos.push(...consumo.avisos, ...consumoManual.avisos);
  if (incluidosManual.length) {
    avisos.push(`${incluidosManual.length} registro(s) son de carga manual (sin orden planificada): sus componentes `
              + 'se descuentan del depósito de recepción, donde también entra el terminado, y quedan fuera '
              + 'del cuadro de reserva vs. producción.');
  }

  // La reserva se pone al día contra el log antes de comparar: si los movimientos se
  // revirtieron desde el historial, el saldo que muestra el plan no es el real. (plan/planes
  // ya se leyeron arriba para la marca de producción registrada.)
  let reserva  = plan && plan.reserva ? plan.reserva : null;
  if (plan) {
    const sync = sincronizarReservaConLog(fecha, plan);
    if (sync.cambio) {
      guardarJSON(PLANES_PATH, { ...planes, [fecha]: sync.plan });
      plan    = sync.plan;
      reserva = sync.plan.reserva || null;
    }
  }
  if (!plan)         avisos.push(`No hay plan cargado para el ${fecha}: no hay reserva contra la cual conciliar.`);
  else if (!reserva) avisos.push(`El plan del ${fecha} no tiene reserva: todo el consumo figura como no reservado.`);
  else if (reserva.estado !== 'activa') {
    avisos.push(`La reserva del ${fecha} está ${reserva.estado}: no queda nada reservado y todo el consumo figura como no reservado.`);
  }
  if (reserva && reserva.desincronizada) {
    avisos.push('La reserva está desincronizada con el log de movimientos: revisá el saldo antes de dar de alta la producción.');
  }
  const sucReserva = reserva ? sucursalDeReserva(reserva) : null;
  const sucursalPedida = Number(idSucursal) || null;
  const sucursalDistinta = reserva && reserva.estado === 'activa' && sucursalPedida != null && sucReserva !== sucursalPedida
    ? { deLaReserva: sucReserva, pedida: sucursalPedida } : null;
  if (sucursalDistinta) {
    avisos.push(`La reserva del ${fecha} es de la sucursal ${sucReserva} y estás trabajando sobre la sucursal ${sucursalPedida}: `
              + 'cambiá a esa sucursal para devolver o ajustar lo reservado.');
  }

  // Sólo una reserva activa tiene stock realmente apartado en el depósito de reserva.
  // Saldo agregado sobre las reservas activas del ledger (no sólo plan.reserva, que es la
  // última reserva): así `reservado` coincide con el desglose por movimiento (porMovimiento)
  // y el comprobante "resto" no doble-cuenta el consumo cuando hay varias reservas en el día.
  // Las reservas YA CONCILIADAS (su ajuste de producción se registró: la mercadería ya se
  // recepcionó) salieron del circuito y quedan fuera de la conciliación. Si siguieran contando
  // aparecerían como sobrante fantasma —reservado > 0 y usado 0, porque sus registros de
  // producción ya están asentados— y se mezclarían con las reservas nuevas.
  const _pLedger    = migrarReservas(plan || {});
  const esConciliada = r => !!(r && r.ajuste && r.ajuste.conciliado);
  const reservasVivas = (_pLedger.reservas || []).filter(r => !esConciliada(r));
  // Comprobantes de las reservas ya conciliadas: sirven para marcarlas en el listado de
  // movimientos del día y que no se confundan con las que todavía esperan conciliación.
  const numsConciliados = new Set((_pLedger.reservas || [])
    .filter(r => esConciliada(r) && r.numeroMovimiento != null)
    .map(r => String(r.numeroMovimiento)));
  const saldo     = saldoLedger(reservasVivas);
  const reservado = new Map(saldo.map(l => [String(l.plu), redondear4(l.cantidad)]));
  if (numsConciliados.size) {
    avisos.push(`${numsConciliados.size} reserva(s) ya recepcionada(s) (movimiento${numsConciliados.size > 1 ? 's' : ''} `
              + `#${[...numsConciliados].join(', #')}) quedan fuera del resumen: su circuito ya cerró.`);
  }

  // Al reservado del plan se le suma el de las reservas MAYORISTAS vivas del mismo PLU: ese
  // stock ya esta fisicamente en el deposito de reserva. Sin esto la sala descontaria del
  // deposito principal algo que no esta ahi, y el principal quedaria en negativo por esa
  // cantidad. El aporte se publica aparte (reservadoMayorista) porque NO es un sobrante
  // devolvible ni figura en porMovimiento: quien arma el movimiento tiene que poder restarlo.
  // Solo cuentan las reservas de ESTA sucursal y de ESTE deposito de reserva: los IDs de
  // deposito son por sucursal, y lo apartado en otro deposito no esta donde la sala descuenta.
  const cr = cfgReserva();
  const cp = cfgProduccion();
  const depsPropuestos = depositosProduccion(cp, cr, reserva, {});
  const sucursalConciliada = Number(sucursalPedida || cr.idSucursal);
  const depReservaProd = Number(depsPropuestos.reserva);
  const mercSucursal = leerJSON(RESERVAS_MERC_PATH, [])
    .filter(r => r && r.estado === 'activa' && Number(r.idSucursal) === sucursalConciliada);
  // Lo apartado se lee NETO de lo que la produccion ya consumio: cada asiento anota contra que
  // reserva salio el granel del deposito de reserva (consumoMayorista). Se miran los asientos de
  // TODAS las fechas, no solo la de hoy: una reserva vive varios dias y lo que consumio la
  // produccion de ayer no puede volver a descontarse hoy. Los asientos viejos no traen el campo
  // y se leen como cero consumido, que es el comportamiento de siempre.
  const asientosTodos = Object.values(planes).flatMap(p => asientosProduccion(p));
  const mercReserva = mercSucursal.filter(r => Number(r.depDestino) === depReservaProd);
  const restanteMayorista = restanteMayoristaPorReserva(mercReserva, asientosTodos);
  // Y lo mismo para el intermedio "X Pedido": cuantas unidades le faltan entrar al deposito de
  // reserva a cada reserva viva. Lo que ya entro esta anotado en los asientos.
  const restantePedido = restantePedidoPorReserva(mercReserva, asientosTodos);
  const granelMayorista = granelReservadoNeto(mercReserva, asientosTodos);
  if (granelMayorista.size) {
    avisos.push(`Hay stock apartado por ${granelMayorista.size} producto(s) con reserva mayorista viva: `
              + 'ese consumo se descuenta del depósito de reserva.');
  }
  // Lo apartado en OTRO deposito no se cuenta (los IDs son por sucursal y ahi no es donde la
  // sala descuenta), pero callarlo seria peor: su consumo va a salir del deposito principal y
  // puede dejarlo en negativo. Pasa siempre que el dia no tiene reserva del plan, porque el
  // deposito de reserva cae al de config y ahi puede no haber ninguno configurado.
  for (const dep of new Set(mercSucursal.filter(r => Number(r.depDestino) !== depReservaProd).map(r => Number(r.depDestino)))) {
    const total = [...granelReservadoPorPlu(mercSucursal.filter(r => Number(r.depDestino) === dep)).values()]
      .reduce((s2, v) => redondear4(s2 + v), 0);
    avisos.push(`Hay ${total} unidad(es) apartadas por reservas mayoristas en el depósito ${dep}, distinto del `
              + `depósito de reserva de esta producción (${esIdDeposito(depReservaProd) ? depReservaProd : 'sin configurar'}): `
              + 'NO cuentan como reservado y su consumo se va a descontar del depósito principal.');
  }
  const mayoristaDe = plu => (plu ? (granelMayorista.get(String(plu)) || 0) : 0);

  const componentes = [], conUso = new Set();
  for (const u of consumo.componentes.values()) {
    if (u.plu) conUso.add(u.plu);
    componentes.push(filaComponente(u.plu, u.nombre, u.tipo,
      (u.plu ? (reservado.get(u.plu) || 0) : 0) + mayoristaDe(u.plu), u.usado));
  }
  // Reservado y no usado: sobra entero, hay que devolverlo al depósito principal.
  for (const l of saldo) {
    const plu = String(l.plu);
    if (conUso.has(plu)) continue;
    componentes.push(filaComponente(plu, l.nombre, tipoComponentePorNombre(l.nombre), l.cantidad + mayoristaDe(plu), 0));
  }
  // Los PLU que SOLO tienen reserva mayorista (sin reserva del plan ni consumo) no se agregan
  // como componente: no participan del movimiento y aparecerian como sobrante a devolver al
  // deposito principal, que es justo lo que hay que evitar.
  componentes.sort((a, b) => String(a.tipo || 'zz').localeCompare(String(b.tipo || 'zz')) || a.nombre.localeCompare(b.nombre));

  // Componentes de la carga manual: van aparte, siempre con reservado 0 (no hay nada apartado
  // para ellos) y se descuentan del depósito de recepción al registrar el movimiento.
  const componentesManual = [...consumoManual.componentes.values()]
    .map(u => filaComponente(u.plu, u.nombre, u.tipo, 0, u.usado))
    .sort((a, b) => String(a.tipo || 'zz').localeCompare(String(b.tipo || 'zz')) || a.nombre.localeCompare(b.nombre));

  const movimientos = leerMovLog()
    .filter(r => r && r.plan === fecha)
    .map(r => ({
      id: r.id, numeroMovimiento: r.numeroMovimiento ?? null, origen: r.origen,
      fechaHora: r.fechaHora, estado: r.estado,
      // Claves del comprobante en SiGA: con ellas la pantalla puede pedir su detalle real.
      idSucursal: r.idSucursal ?? null, idTipoMovimiento: r.idTipoMovimiento || null,
      depOrigen: r.depOrigen ?? null, depDestino: r.depDestino ?? null,
      lineas: (r.lineas || []).map(l => ({
        plu: String(l.plu), nombre: l.nombre == null ? '' : String(l.nombre), cantidad: redondear4(l.cantidad)
      })),
      // Una reversión se registra con el MISMO origen que el movimiento que deshace, así que
      // sin revierteA/revertidoPor es indistinguible de una reserva normal en el listado.
      // Se mandan los dos IDs para poder mostrar el par ("revertido por #32" / "reversión de #31").
      revertido: !!r.revertidoPor, revertidoPor: r.revertidoPor || null, revierteA: r.revierteA || null,
      // Marcas para no mezclar en el listado lo que ya cerró con lo que falta conciliar:
      //  · esRecepcion → el movimiento ES el alta de producción (terminados que entraron).
      //  · conciliado  → es una reserva cuyo ajuste de producción ya se registró.
      esRecepcion: r.origen === 'produccion',
      conciliado: r.numeroMovimiento != null && numsConciliados.has(String(r.numeroMovimiento))
    }))
    .reverse();   // el log se escribe con el más nuevo al final
  const pendientes = movimientos.filter(m => m.estado === 'pendiente').length;
  const fallidos   = movimientos.filter(m => m.estado === 'fallido').length;
  if (pendientes) {
    avisos.push(`Hay ${pendientes} movimiento(s) en estado pendiente para esta fecha: verificá a mano en SiGA si se ejecutaron antes de seguir.`);
  }
  if (fallidos) avisos.push(`Hay ${fallidos} movimiento(s) fallidos en el log de esta fecha (informativo: no movieron stock).`);

  const sinReservar = componentes.filter(c => c.reservado === 0 && c.usado > 0).length;
  if (sinReservar) avisos.push(`${sinReservar} componente(s) se consumieron sin estar reservados.`);

  // Productos ya registrados (total o parcialmente): se avisa cuántos y con qué comprobante,
  // y se calcula si queda algo pendiente de registrar (para bloquear exportar/registrar).
  const yaRegistrados = productos.filter(p => !p.excluido && p.yaRegistrado);
  const parciales     = productos.filter(p => !p.excluido && p.parcial);
  if (yaRegistrados.length || parciales.length) {
    const nums = [...new Set([...yaRegistrados.map(p => p.yaRegistrado.numeroMovimiento),
                              ...parciales.map(p => p.parcial.numeroMovimiento)].filter(n => n != null))];
    const compTxt = nums.length ? ` (movimiento${nums.length > 1 ? 's' : ''} #${nums.join(', #')})` : '';
    if (yaRegistrados.length) avisos.push(`${yaRegistrados.length} producto(s) ya fueron registrados${compTxt} y no se vuelven a descontar.`);
    if (parciales.length)     avisos.push(`${parciales.length} producto(s) tienen parte ya registrada${compTxt}: sólo se registrará lo pendiente.`);
  }
  // Hay algo pendiente si algún producto NO excluido todavía no quedó totalmente registrado.
  // Los sólo-Etiquetado cuentan si su etiqueta se pudo resolver (si no, no habría línea que mover
  // y la fecha quedaría pendiente para siempre).
  const soloEtiquetaPendientes = soloEtiqueta.filter(r =>
    packagingDeRegistro(r, formulas.get(plusDeRegistro(r.plu)[0]) || []).lineas.length);
  const pendienteDeRegistrar = productos.some(p => !p.excluido && !p.yaRegistrado) || soloEtiquetaPendientes.length > 0;

  // Depósitos de la sucursal en la que está parada la pantalla: el modal elige de dónde salen
  // los componentes no reservados (y a dónde vuelve el sobrante) y a dónde entran los
  // terminados. Los IDs son POR sucursal, así que un default de config que no exista en esta
  // sucursal se descarta en vez de exponer un ID que no se puede usar. Si SiGA no responde la
  // lista queda vacía y los defaults se devuelven igual: la conciliación no depende de esto.
  // (cr/cp/depsPropuestos ya se resolvieron arriba, para el aporte de las reservas mayoristas.)
  let depositos = [];
  try { depositos = await depositosActivos(sucursalPedida || cr.idSucursal); }
  catch (e) { avisos.push(`No se pudieron consultar los depósitos en SiGA (${e.message}): elegilos a mano antes de registrar.`); }
  const activos   = new Set(depositos.map(d => Number(d.IdDeposito)));
  const depValido = v => {
    const n = Number(v);
    if (!esIdDeposito(n)) return null;
    return (depositos.length && !activos.has(n)) ? null : n;
  };

  // ── Entrega mayorista: UNA sola imputación gobierna las dos patas ────────────
  // Las unidades de "X Pedido" que entran al depósito de reserva y los kg de granel que salen
  // de ahí para fabricarlas son el mismo hecho contado de dos maneras. Se calculan juntos y acá
  // (no en el registro) para que la pantalla muestre exactamente los números que se van a
  // mover: primero cuántas unidades del pedido cubre la producción PENDIENTE, y de ahí se
  // deriva el granel que se le cobra a cada reserva.
  const terminadosPendientes = terminadosPorPluDeConciliacion(productos);
  const entrega = imputarEntregaMayorista(
    basesEntregaMayorista(mercReserva, asientosTodos),
    terminadosPendientes,
    new Map(componentes.filter(x => x.plu).map(x => [String(x.plu), x.usado])));
  const granelMayoristaCobrado = agruparRestante(entrega.consumoMayorista.map(x => ({ plu: x.plu, restante: x.kg })));
  // La entrega se recorta sola cuando el granel no alcanza (apartado ya consumido, o consumo
  // declarado menor al que pide la fórmula). Callarlo haría que el operador viera menos unidades
  // en el depósito de reserva de las que espera y no supiera por qué.
  for (const [plu, falta] of agruparRestante(restantePedido)) {
    const sinEntregar = redondear4(Math.min(falta, terminadosPendientes.get(plu) || 0)
                                 - (entrega.unidadesPorPlu.get(plu) || 0));
    if (sinEntregar <= 0) continue;
    avisos.push(`${sinEntregar} unidad(es) del producto ${plu} que una reserva mayorista espera NO entran al `
              + 'depósito de reserva: el granel que quedaba apartado no alcanza para cubrirlas. '
              + 'Entran a recepción como producción normal.');
  }

  // Desglose por movimiento de reserva (para conciliar por orden y por movimiento). Sólo las
  // reservas todavía sin recepción: las conciliadas ya no tienen nada que mover.
  const _gruposMov = reservadoPorMovimiento(reservasVivas);
  // El granel que se le cobra al mayorista NO lo consumió el plan: si el reparto por movimiento
  // lo siguiera contando, el ajuste del plan sacaría del depósito de reserva kg que ya salieron
  // por la pata mayorista y las diferencias los devolverían una segunda vez.
  const _usadoPorPlu = new Map([...consumo.componentes.values()]
    .filter(u => u.plu).map(u => [String(u.plu),
      redondear4(Math.max(0, u.usado - (granelMayoristaCobrado.get(String(u.plu)) || 0)))]));
  const porMovimiento = conciliarPorMovimiento(_gruposMov, _usadoPorPlu);

  return {
    fecha,
    idSucursal: sucursalPedida,
    // Presente sólo cuando la reserva activa es de otra sucursal (si no, null).
    sucursalDistinta,
    reserva: {
      existe: !!reserva,
      estado: reserva ? reserva.estado : null,
      numeroMovimiento: reserva ? (reserva.numeroMovimiento ?? null) : null,
      idSucursal: sucReserva,
      depOrigen:  reserva ? (reserva.depOrigen  ?? null) : null,
      depDestino: reserva ? (reserva.depDestino ?? null) : null,
      desincronizada: (reserva && reserva.desincronizada) || null,
      movimientos,
      saldo: saldo.map(l => ({ plu: String(l.plu), nombre: String(l.nombre || ''), cantidad: redondear4(l.cantidad) }))
    },
    productos,
    componentes,
    // Parte de componentes[].reservado que viene de reservas MAYORISTAS vivas, por PLU. Objeto
    // plano (no Map) porque la conciliacion se serializa a JSON. Se publica para poder separar
    // lo apartado por el plan (devolvible, y presente en porMovimiento) de lo apartado por el
    // mayorista, que tiene que quedarse en el deposito de reserva.
    reservadoMayorista: Object.fromEntries(granelMayorista),
    // Base de imputacion: cuanto le queda apartado a CADA reserva. Es lo que necesita
    // /registrar-movimiento para anotar en el asiento contra que reserva sale cada kg
    // consumido, sin volver a leer ni filtrar reservas_mercaderia.json por su cuenta.
    restanteMayorista,
    // Unidades de "X Pedido" que cada reserva todavia espera: con eso el alta del terminado
    // sabe que parte entra al deposito de reserva en vez del de recepcion.
    restantePedido,
    // Las DOS patas de la entrega mayorista de esta produccion pendiente, ya imputadas contra
    // cada reserva por imputarEntregaMayorista. /registrar-movimiento las consume tal cual: no
    // vuelve a calcular ninguna de las dos, que es lo que las dejaba desfasadas entre si.
    //  · terminado      → unidades de "X Pedido" que entran al deposito de reserva, por reserva.
    //  · consumo        → kg de granel que se le cobran a esa reserva por esas unidades.
    //  · unidadesPorPlu → el agregado que rutea el alta del terminado (objeto plano: viaja a JSON).
    //  · granelPorPlu   → el agregado que descuenta el consumo del deposito de reserva.
    entregaMayorista: {
      terminado: entrega.terminadoMayorista,
      consumo: entrega.consumoMayorista,
      unidadesPorPlu: Object.fromEntries(entrega.unidadesPorPlu),
      granelPorPlu: Object.fromEntries(granelMayoristaCobrado),
    },
    // Consumo de la carga manual, fuera del cuadro reserva-vs-producción: no hay reserva contra
    // la cual conciliarlo. Se registra íntegro contra el depósito de recepción.
    componentesManual,
    // Desglose reservado-vs-usado por movimiento de reserva (misma info que "componentes",
    // recortada por movimiento en vez de agregada por PLU).
    porMovimiento,
    // Depósitos elegibles de la sucursal + la preselección que propone el servidor.
    depositos: depositos.map(d => ({
      idDeposito: Number(d.IdDeposito), nombre: String(d.NombreDeposito || '').trim(),
      tipoDeposito: d.TipoDeposito, disponibleVenta: d.DisponibleVenta
    })),
    // La preselección la calcula la MISMA función que resuelve los depósitos del movimiento
    // real, así la pantalla no puede mostrar una elección distinta de la que se va a escribir.
    seleccion: {
      depSalida:      depValido(depsPropuestos.salida),
      depRecepcion:   depValido(depsPropuestos.recepcion),
      // A dónde vuelve la diferencia entre lo reservado y lo realmente consumido.
      depDiferencias: depValido(depsPropuestos.diferencias),
      // El depósito donde la mercadería está físicamente apartada: no se elige, sale de la
      // reserva del plan (o de config si todavía no hay reserva). Puede ser null.
      depReserva:     depsPropuestos.reserva,
      // true = hay reserva activa, así que salida y diferencias las fija su depOrigen y la
      // pantalla tiene que mostrarlos como fijos, no como elegibles.
      forzadosPorReserva: depsPropuestos.forzadosPorReserva
    },
    // Marca del alta de producción de esta fecha (o null): con esto la pantalla deshabilita
    // el botón de registrar el movimiento y muestra con qué comprobante se registró.
    produccionRegistrada: (plan && plan.produccionRegistrada) || null,
    // false = todo lo de la fecha ya fue registrado: la pantalla bloquea exportar y registrar.
    pendienteDeRegistrar,
    // Ids de las cargas sólo-Etiquetado que este registro descuenta: /registrar-movimiento las
    // suma al asiento para que no se vuelvan a mover.
    registrosSoloEtiqueta: soloEtiquetaPendientes.map(r => r.id),
    totales: {
      productos:          productos.filter(p => !p.excluido).length,
      productosExcluidos: productos.filter(p =>  p.excluido).length,
      componentes:        componentes.length,
      conDiferencia:      componentes.filter(c => c.diferencia !== 0).length,
      sinReservar,
      // Reservas que ya se recepcionaron y por eso NO entran en el resumen ni se vuelven a mover.
      reservasConciliadas: numsConciliados.size,
      // Producción cargada a mano: no se concilia contra reserva.
      productosManuales:   productos.filter(p => !p.excluido && p.manual).length,
      componentesManuales: componentesManual.length
    },
    avisos
  };
}

// Qué quedó realmente escrito en SiGA para un comprobante de stock: cabecera + renglones.
// Sólo lectura (pool de lectura, nunca el de escritura). La conciliación lo usa para poder
// auditar un movimiento del log contra la base sin salir de la pantalla.
// GET /api/movimientos/siga/:numero?idSucursal=1&idTipoMovimiento=BIENESUSO
router.get('/api/movimientos/siga/:numero', apiRoute(async req => {
  // query() no toma parámetros (interpola el string), así que lo que viene de la URL se valida
  // a mano antes de tocar el SQL: dos enteros y un tipo de movimiento alfanumérico.
  const numero = Number(req.params.numero);
  const suc    = Number(req.query.idSucursal);
  const tipo   = String(req.query.idTipoMovimiento || '').trim();
  if (!Number.isInteger(numero) || numero <= 0) return { error: 'Número de movimiento inválido' };
  if (!Number.isInteger(suc)    || suc    <= 0) return { error: 'Sucursal inválida' };
  if (!/^[A-Z0-9_]{1,20}$/i.test(tipo))         return { error: 'Tipo de movimiento inválido' };

  const filtro = `IdSucursal=${suc} AND IdTipoMovimiento='${tipo}' AND NumeroMovimiento=${numero}`;
  const [cab] = await query(`SELECT TOP 1 CONVERT(varchar(19), FechaMovimiento, 120) AS Fecha,
      Usuario, Observacion, IdEmpleado, Neto, Total
    FROM MovimientosStock WHERE ${filtro}`);
  if (!cab) {
    return { encontrado: false, numeroMovimiento: numero, idSucursal: suc, idTipoMovimiento: tipo,
             lineas: [], aviso: 'El comprobante no existe en SiGA con esa sucursal y tipo de movimiento.' };
  }
  const lineas = await query(`SELECT mp.Orden, mp.IdProducto, p.NombreProducto, mp.Cantidad,
      mp.IdDeposito, sd.NombreDeposito
    FROM MovimientosStockProductos mp
    LEFT JOIN Productos p ON p.IdProducto=mp.IdProducto
    LEFT JOIN SucursalesDepositos sd ON sd.IdDeposito=mp.IdDeposito AND sd.IdSucursal=mp.IdSucursal
    WHERE mp.IdSucursal=${suc} AND mp.IdTipoMovimiento='${tipo}' AND mp.NumeroMovimiento=${numero}
    ORDER BY mp.Orden`);

  return {
    encontrado: true,
    numeroMovimiento: numero, idSucursal: suc, idTipoMovimiento: tipo,
    cabecera: {
      fecha: cab.Fecha || null, usuario: String(cab.Usuario || '').trim(),
      observacion: String(cab.Observacion || '').trim(),
      idEmpleado: cab.IdEmpleado ?? null,
      neto: Number(cab.Neto) || 0, total: Number(cab.Total) || 0
    },
    lineas: lineas.map(l => ({
      orden: l.Orden ?? null,
      plu: String(l.IdProducto ?? ''),
      nombre: String(l.NombreProducto || '').trim(),
      cantidad: redondear4(l.Cantidad),
      idDeposito: l.IdDeposito ?? null,
      nombreDeposito: String(l.NombreDeposito || '').trim()
    }))
  };
}));

// Estas dos rutas /api/produccion/:fecha/* viven acá a proposito: van con el bloque de reservas/movimientos SIGA, no con rutas_produccion.js.
router.get('/api/produccion/:fecha/conciliacion', apiRoute(async req => {
  const s = await resolverSucursal(req.query.idSucursal);
  if (s.error) return { error: s.error };
  return conciliacionProduccion(safeDate(req.params.fecha), s.idSucursal);
}));

// ── Alta de producción: el movimiento de stock ─────────────────────────────────
// Los depósitos del circuito los resuelve depositosProduccion (módulo reservas_movimiento):
//   · salida      → de dónde salen los componentes que NO cubre la reserva.
//   · recepcion   → dónde ENTRAN los productos terminados. Lo elige el operador.
//   · diferencias → a dónde vuelve el sobrante entre lo reservado y lo consumido.
//   · reserva     → dónde está físicamente lo apartado (depDestino de la reserva del plan).
// Con una reserva activa, salida y diferencias NO son elegibles: los fija el depOrigen de esa
// reserva, porque el excedente salió del principal y el sobrante tiene que volver ahí.
// Las lineas del comprobante las arma lineasProduccionDesdeConciliacion (mismo modulo puro).

// Registra la producción de una fecha como UN comprobante de stock en SiGA: da de alta los
// terminados y de baja los componentes realmente consumidos, según la conciliación.
// El tipo es BIENESUSO (el único habilitado para escritura) y no es el tipo semánticamente
// correcto para una producción: lo que identifica estos comprobantes es la OBSERVACIÓN
// (produccion.observacion en config.json + la fecha), que es por donde se los filtra en SiGA.
// Body: { idSucursal?, confirmar: true, omitirSinPlu?: true, depSalida?, depRecepcion?, depDiferencias? }
router.post('/api/produccion/:fecha/registrar-movimiento', apiRoute(async req => {
  const fecha = safeDate(req.params.fecha);
  const b     = req.body || {};
  // Doble confirmación explícita: este endpoint escribe stock real y no es idempotente.
  if (b.confirmar !== true) return { error: 'Falta confirmar el movimiento' };

  const s = await resolverSucursal(b.idSucursal);
  if (s.error) return { error: s.error };
  const cr = s.cr;
  const cp = cfgProduccion();
  if (!TIPOS_MOVIMIENTO_STOCK_PERMITIDOS.includes(cp.idTipoMovimiento)) {
    return { error: `idTipoMovimiento inválido (produccion.idTipoMovimiento en config.json). `
                  + `Permitidos: ${TIPOS_MOVIMIENTO_STOCK_PERMITIDOS.join(', ')}` };
  }

  // El plan previo se usa para la reserva; el bloqueo por "ya registrado" pasó a evaluarse
  // sobre la conciliación (per-registro), porque una carga nueva del mismo día debe poder
  // registrarse aunque la fecha ya tenga un asiento previo.
  const planPrevio = leerJSON(PLANES_PATH, {})[fecha] || null;
  // Una reserva activa de otra sucursal bloquea todo: los depósitos y el stock son por
  // sucursal y el consumo saldría del lugar equivocado.
  const errSucursal = chequearSucursalReserva(planPrevio && planPrevio.reserva, cr.idSucursal);
  if (errSucursal) return { error: errSucursal };

  // Depósitos elegidos en la pantalla. Se validan contra la sucursal ANTES de calcular o
  // escribir nada: los IDs son por sucursal y un depósito de otra movería stock donde no va.
  // Si no vienen se usan los defaults de siempre (config + reserva del plan).
  const vino = v => v !== undefined && v !== null && v !== '';
  const elegidos = { depSalida: b.depSalida, depRecepcion: b.depRecepcion, depDiferencias: b.depDiferencias };
  if (vino(b.depSalida) || vino(b.depRecepcion) || vino(b.depDiferencias)) {
    const activos = new Set((await depositosActivos(cr.idSucursal)).map(d => Number(d.IdDeposito)));
    const valido  = v => esIdDeposito(Number(v)) && activos.has(Number(v));
    if (vino(b.depSalida)      && !valido(b.depSalida))      return { error: 'Depósito de salida inválido' };
    if (vino(b.depRecepcion)   && !valido(b.depRecepcion))   return { error: 'Depósito de recepción inválido' };
    if (vino(b.depDiferencias) && !valido(b.depDiferencias)) return { error: 'Depósito de diferencias inválido' };
  }

  const c = await conciliacionProduccion(fecha, cr.idSucursal);
  const hayProductos = (c.productos || []).some(p => !p.excluido);
  if (!hayProductos && !(c.componentes || []).length && !(c.componentesManual || []).length) {
    return { error: `No hay producción cargada para el ${fecha}: no hay nada que registrar` };
  }
  // Trabajo pendiente = producción sin registrar O ajustes de reserva sin conciliar. Con la
  // conciliación por movimiento, una fecha "ya registrada" en terminados puede tener todavía
  // ajustes de reserva pendientes (p. ej. un reintento tras una falla parcial): en ese caso NO
  // se bloquea, se retoma sólo lo que falta.
  const hayAjustesPendientes = (c.porMovimiento || [])
    .some(m => !m.conciliado && (m.componentes || []).some(x => (x.usado > 0) || (x.sobrante > 0)));
  if (c.pendienteDeRegistrar === false && !hayAjustesPendientes) {
    const num = c.produccionRegistrada ? (c.produccionRegistrada.numeroMovimiento ?? null) : null;
    return { error: `Toda la producción del ${fecha} ya fue registrada${num != null ? ` (movimiento #${num})` : ''}`,
             yaRegistrado: true, numeroMovimiento: num };
  }
  // Registros de producción que aporta ESTE movimiento: los pendientes de la fecha, con rol de
  // envasado y PLU resoluble (los sin PLU se omiten y quedan pendientes para corregirlos). Se
  // guardan en el asiento para que la reversión devuelva sólo estos a "pendiente".
  const registrosFecha  = leerJSON(PROD_REG_PATH, []).filter(r => r && r.fecha === fecha);
  const yaAsentados     = registrosYaRegistrados(planPrevio, registrosFecha);
  const soloEtiquetaIds = new Set((c.registrosSoloEtiqueta || []).map(String));
  const idsRegistrados  = registrosFecha
    .filter(r => (!motivoExclusionRegistro(r) || soloEtiquetaIds.has(String(r.id)))
              && !yaAsentados.has(String(r.id)) && plusDeRegistro(r.plu)[0])
    .map(r => r.id);
  // Un movimiento en 'pendiente' significa que no se sabe si llegó a ejecutarse en SiGA:
  // registrar encima duplicaría el consumo.
  const pendientes = ((c.reserva && c.reserva.movimientos) || []).filter(m => m.estado === 'pendiente');
  if (pendientes.length) {
    return { error: `Hay ${pendientes.length} movimiento(s) en estado pendiente para el ${fecha}: `
                  + 'verificá a mano en SiGA si se ejecutaron y resolvelos antes de registrar la producción.',
             pendientes: pendientes.map(m => m.id) };
  }

  const deps = depositosProduccion(cp, cr, c.reserva, elegidos);
  // Un ajuste SiGA POR movimiento de reserva (trazabilidad 1:1 reserva→ajuste):
  //  · "resto"    → terminados (alta de producto) + consumo que salió de FUERA de la reserva.
  //  · por cada movimiento de reserva NO conciliado → consumo contra lo apartado + sobrante.
  // Lo apartado por reservas MAYORISTAS viaja dentro de componentes[].reservado (para que el
  // consumo no se cargue al deposito principal) pero NO es del plan. Se parte ANTES de armar
  // nada: `componentesPlan` es la vista que consumen TODOS los pasos de abajo (el comprobante
  // de produccion, las diferencias y el corte antidoble-conteo). Si alguno mirara el
  // componente crudo, el consumo que excede plan+mayorista no saldria de ningun deposito.
  // Las dos patas de la entrega mayorista vienen YA imputadas de la conciliacion
  // (imputarEntregaMayorista) y no se recalculan acá. Salen del mismo reparto, así que las
  // unidades que entran al depósito de reserva y el granel que se le cobra a cada reserva no
  // pueden desfasarse. Cuando se calculaban por separado, un día normal (el plan consume justo
  // lo que reservó) entregaba el producto sin cobrar el granel: el depósito de reserva quedaba
  // con la materia prima Y el terminado del mismo pedido, y ningún ledger reconciliaba al otro.
  const em = c.entregaMayorista || {};
  // Contra qué reserva mayorista sale cada kg que la sala consumió del depósito de reserva. Se
  // guarda en el asiento de producción (misma escritura que el sello) y es lo que hace que el
  // lote siguiente vea el apartado que QUEDA en vez del original. No se toca
  // reservas_mercaderia.json: mover uno solo de los dos datos abre una ventana en la que un
  // reintento recalcularía el mismo consumo contra un apartado ya achicado.
  const consumoMayorista   = em.consumo   || [];
  // Contra qué reserva entró cada unidad de "X Pedido", con la misma escritura y la misma
  // reversión que el consumo de granel de arriba.
  const terminadoMayorista = em.terminado || [];
  const { componentesPlan, lineasMayorista } =
    partirConsumoMayorista(c.componentes, c.reservadoMayorista, deps.reserva, em.granelPorPlu);
  // El terminado que cubre una reserva mayorista viva entra al deposito de reserva, no al de
  // recepcion. `unidadesPorPlu` ya viene neto de lo que los asientos anteriores metieron y
  // topeado por el granel que la reserva todavia tiene apartado.
  const resto     = lineasProduccionDesdeConciliacion({ ...c, componentes: componentesPlan }, deps,
    { incluirReserva: false, reservadoPorTerminado: new Map(Object.entries(em.unidadesPorPlu || {})) });
  const ajustesMov = (c.porMovimiento || [])
    .map(m => ({ numeroMovimiento: m.numeroMovimiento, ordenes: m.ordenes || [], conciliado: !!m.conciliado, lineas: lineasAjusteMovimiento(m.componentes, deps) }))
    // Los movimientos ya conciliados no se re-registran (idempotencia ante reintentos parciales).
    .filter(m => !m.conciliado && m.lineas.length);
  // El consumo del apartado mayorista va en el comprobante de produccion, junto al resto del
  // consumo de fuera de la reserva del plan: asi queda cubierto por la misma marca de
  // idempotencia y no necesita comprobante nuevo.
  const lineasResto = [...resto.lineas, ...lineasMayorista];
  // Ajuste por diferencias: un único comprobante con todo lo que se desvió de lo reservado
  // (excedente y sobrante), calculado sobre el agregado por PLU de las reservas todavía vivas.
  const difs = lineasDiferenciasProduccion(componentesPlan, deps);
  // Reservas que cubre ese comprobante: sirven de marca de idempotencia. Si un reintento llega
  // con las mismas reservas todavía sin conciliar, las diferencias ya se escribieron.
  const movimientosACubrir = ajustesMov.map(m => m.numeroMovimiento);
  const diferenciasYaRegistradas = ((planPrevio && planPrevio.ajustesDiferencias) || []).some(a =>
    Array.isArray(a && a.reservas) && a.reservas.length === movimientosACubrir.length
    && a.reservas.every(n => movimientosACubrir.includes(n)));

  const sinPlu = resto.sinPlu;
  const todasLasLineas = [...lineasResto, ...difs, ...ajustesMov.flatMap(m => m.lineas)];

  // Defensa contra doble conteo: el reservado agregado (que usa el "resto" para el consumo-salida)
  // debe coincidir con la suma por movimiento. Sólo diferirían si una reserva quedara net-negativa
  // por PLU dentro de sí misma (devoluciones > líneas): hoy no ocurre, pero se corta por las dudas.
  // Se compara contra componentesPlan: el aporte mayorista no esta en porMovimiento (es de otro
  // circuito) y haria saltar el corte por una diferencia legitima.
  const reservadoAgg = new Map(componentesPlan.filter(x => x.plu).map(x => [String(x.plu), redondear4(x.reservado)]));
  const reservadoMov = new Map();
  for (const m of (c.porMovimiento || [])) for (const x of (m.componentes || [])) {
    reservadoMov.set(String(x.plu), redondear4((reservadoMov.get(String(x.plu)) || 0) + (Number(x.reservado) || 0)));
  }
  const descuadre = [...reservadoMov.entries()].filter(([plu, v]) => Math.abs(v - (reservadoAgg.get(plu) || 0)) > 1e-4);
  if (descuadre.length) {
    return { error: 'La reserva agregada no coincide con la suma por movimiento (posible reserva con devoluciones '
                  + 'inconsistentes). Revisá las reservas del plan antes de registrar la producción.',
             descuadre: descuadre.map(([plu]) => plu) };
  }

  // Sin PLU no hay forma de mover el stock: o se aborta, o el operador acepta explícitamente
  // dejarlos afuera (y se informan en la respuesta para corregirlos después).
  if (sinPlu.length && b.omitirSinPlu !== true) {
    return { error: `Hay ${sinPlu.length} componente(s)/producto(s) sin PLU: no se pueden mover. `
                  + 'Corregilos o volvé a enviar con omitirSinPlu para dejarlos afuera.',
             sinPlu };
  }
  if (!todasLasLineas.length) return { error: 'No quedó ninguna línea para mover' };
  // Defensa: sin depósito de reserva configurado ni reserva viva, una línea de consumo
  // reservado quedaría sin depósito. Antes de escribir, todas las líneas tienen que tenerlo.
  const sinDeposito = todasLasLineas.filter(l => !esIdDeposito(Number(l.idDeposito)));
  if (sinDeposito.length) {
    return { error: 'No se pudo determinar el depósito de todas las líneas '
                  + '(elegí el depósito de salida y el de recepción, y revisá reserva.depositoReserva en config.json)',
             sinDeposito: sinDeposito.map(l => ({ plu: l.idProducto, concepto: l.concepto })) };
  }

  // La observación es la marca que identifica estos comprobantes en SiGA: el prefijo
  // (produccion.observacion + fecha) es común a todos, y después cada uno dice qué es —
  // mismo patrón que la reserva, que escribe "<obs> <fecha> RESERVA <dep>><dep>".
  const obsPrefijo = `${cp.observacion} ${fecha}`.trim();
  const obsBase    = `${obsPrefijo} PRODUCCION`;
  const poolW = await getPoolStock();
  const comprobantes = [], logErrores = [];
  let errMarca = null, avisoMarca = null, errEscritura = null;
  let r = { numeroMovimiento: null, idRegistro: null };

  // opts.tipo/opts.origen permiten que el ajuste por diferencias salga con SU tipo de movimiento
  // (el de la reserva) y quede rotulado aparte en el log; el resto usa el de producción.
  const escribirComprobante = async (lineasComp, observacion, depOrigen, depDestino, opts) => {
    const tipo   = (opts && opts.tipo)   || cp.idTipoMovimiento;
    const origen = (opts && opts.origen) || 'produccion';
    return ejecutarYRegistrar({
      origen, plan: fecha, itemId: null, idSucursal: cr.idSucursal,
      // La cabecera de un movimiento multi-depósito es sólo referencia: el depósito real de
      // cada renglón va EN LA LÍNEA.
      depOrigen, depDestino, idUbicacion: null, idEmpleado: cr.idEmpleado,
      idTipoMovimiento: tipo, usuario: cr.usuario, observacion,
      lineas: lineasComp.map(l => ({ plu: l.idProducto, nombre: l.nombre || null, cantidad: l.cantidad, idDeposito: l.idDeposito }))
    }, () => registrarMovimientoMultilinea(poolW, {
      idSucursal: cr.idSucursal, idTipoMovimiento: tipo,
      usuario: cr.usuario, idEmpleado: cr.idEmpleado, observacion,
      lineas: lineasComp.map(l => ({ idProducto: l.idProducto, idDeposito: l.idDeposito, cantidad: l.cantidad }))
    }));
  };

  // Aplica un cambio al plan y lo persiste de inmediato (re-lee para no pisar escrituras
  // concurrentes). Se llama DESPUÉS de cada comprobante confirmado para que un reintento tras
  // una falla parcial salte lo ya registrado (idempotencia). Devuelve {aviso} si no hay plan.
  const aplicarAlPlan = (mutador) => {
    const planes = leerJSON(PLANES_PATH, {});
    // Producción 100% de carga manual: la fecha no tiene plan, pero la marca del asiento igual
    // tiene que persistir. Sin ella la pantalla nunca veía la producción como registrada (el
    // botón de registrar movimiento quedaba habilitado, con riesgo de duplicar el descuento) y
    // los registros no se archivaban al historial. Se crea un plan mínimo: sin ítems ni reserva,
    // sólo sostén de la marca.
    const planActual = planes[fecha]
      || { fecha, notas: '', items: [], creado: new Date().toISOString(), soloProduccionManual: true };
    guardarJSON(PLANES_PATH, { ...planes, [fecha]: mutador(planActual) });
    return { ok: true };
  };

  // Marca del asiento de producción (terminados) + sello por ítem. Se persiste apenas confirma
  // el comprobante "resto": un reintento verá esos registros como yaRegistrados y no los repite.
  const marcarProduccion = (planActual, rc) => {
    const asientoNuevo = {
      numeroMovimiento: rc.numeroMovimiento, fecha: new Date().toISOString(),
      idRegistro: rc.idRegistro, usuario: cr.usuario, idSucursal: cr.idSucursal, registros: idsRegistrados,
      // Granel del apartado mayorista que consumio ESTE movimiento, por reserva. Revertir el
      // movimiento borra el asiento (limpiarProduccionRegistrada) y con el este consumo, asi
      // que el apartado vuelve solo. Sin consumo mayorista el campo no se escribe: los asientos
      // que no lo tienen se leen como cero consumido.
      ...(consumoMayorista.length ? { consumoMayorista } : {}),
      // Unidades de "X Pedido" que ESTE movimiento metio al deposito de reserva, por reserva.
      // Misma escritura y misma reversion que el resto del asiento.
      ...(terminadoMayorista.length ? { terminadoMayorista } : {})
    };
    const asientos = [...asientosProduccion(planActual), asientoNuevo];
    const produccionRegistrada = { ...asientoNuevo, asientos };
    // Las cargas sólo-Etiquetado van en el asiento pero no producen el ítem: no lo sellan.
    const registrosDelAsiento = registrosFecha.filter(rr => idsRegistrados.includes(rr.id) && !motivoExclusionRegistro(rr));
    const plusProducidos = new Set(registrosDelAsiento.flatMap(rr => plusDeRegistro(rr.plu)));
    const sello = { numeroMovimiento: rc.numeroMovimiento, fecha: asientoNuevo.fecha, idRegistro: rc.idRegistro };
    const items = (planActual.items || []).map(it => {
      if (!it || it.produccionMovimiento) return it;
      const plu = String(it.idProducto ?? it.idGranel ?? '').replace(/\D/g, '');
      if (!plu || !plusProducidos.has(plu)) return it;
      return { ...it, produccionMovimiento: sello };
    });
    return { ...planActual, produccionRegistrada, items };
  };

  try {
    // 1) Comprobante "resto" (terminados + consumo no reservado). Puede no tener líneas si todo
    //    el consumo fue contra reservas y no hay alta de producto pendiente.
    if (lineasResto.length) {
      // Este es el comprobante de PRODUCCIÓN propiamente dicho: da de alta los terminados y
      // descuenta el consumo que NO salió de una reserva del plan (fórmulas sin reservar,
      // excedentes, carga manual y lo consumido del apartado mayorista, que sí sale del
      // depósito de reserva). Los que cierran cada reserva se rotulan CONCILIACION.
      const rResto = await escribirComprobante(lineasResto, obsBase.slice(0, 200), deps.reserva || deps.salida, deps.recepcion);
      logErrores.push(rResto.logError);
      comprobantes.push({ tipo: 'resto', numeroMovimiento: rResto.numeroMovimiento, idRegistro: rResto.idRegistro });
      r = rResto;
      const res = aplicarAlPlan(planActual => marcarProduccion(planActual, rResto));
      if (res.aviso) avisoMarca = res.aviso;
    }

    // 2) Ajuste por diferencias: TODO lo que se desvió de lo reservado, en un comprobante propio
    //    y con el tipo de la reserva (BIENESUSO), para poder identificarlo en SiGA por la
    //    observación en vez de que quede mezclado con el alta de producción.
    //    Va ANTES de los ajustes por movimiento: esos cierran las reservas y, una vez cerradas,
    //    el reservado deja de contar y la diferencia ya no se podría calcular.
    if (difs.length && !diferenciasYaRegistradas) {
      const observacion = `${obsPrefijo} AJUSTE POR DIFERENCIAS`.slice(0, 200);
      const rd = await escribirComprobante(difs, observacion, deps.reserva, deps.diferencias,
        { tipo: cr.idTipoMovimiento, origen: 'ajuste' });
      logErrores.push(rd.logError);
      comprobantes.push({ tipo: 'diferencias', numeroMovimiento: rd.numeroMovimiento, idRegistro: rd.idRegistro });
      if (r.numeroMovimiento == null) r = rd;
      // Marca de idempotencia: si un ajuste posterior falla, el reintento no vuelve a escribir
      // las mismas diferencias (las reservas siguen vivas y se recalcularían iguales).
      const res = aplicarAlPlan(planActual => ({
        ...planActual,
        ajustesDiferencias: [...(planActual.ajustesDiferencias || []), {
          numeroMovimiento: rd.numeroMovimiento, idRegistro: rd.idRegistro ?? null,
          fecha: new Date().toISOString(), reservas: movimientosACubrir
        }]
      }));
      if (res.aviso && !avisoMarca) avisoMarca = res.aviso;
    }

    // 3) Un comprobante de ajuste por movimiento de reserva. Cada uno sella SU reserva apenas
    //    confirma, así un fallo intermedio no obliga a repetir los anteriores.
    for (const m of ajustesMov) {
      // Cada ajuste cierra UNA reserva: la observación lo dice y nombra el comprobante de
      // reserva que concilia, para poder seguir el par reserva → conciliación desde SiGA.
      const observacion = `${obsPrefijo} CONCILIACION RESERVA #${m.numeroMovimiento ?? '—'}`.slice(0, 200);
      const rm = await escribirComprobante(m.lineas, observacion, deps.reserva, deps.diferencias || deps.reserva);
      logErrores.push(rm.logError);
      comprobantes.push({ tipo: 'ajuste', numeroMovimientoReserva: m.numeroMovimiento, numeroMovimiento: rm.numeroMovimiento, idRegistro: rm.idRegistro });
      if (r.numeroMovimiento == null) r = rm;   // sin resto, el principal es el primer ajuste
      const res = aplicarAlPlan(planActual => ({
        ...planActual,
        reservas: migrarReservas(planActual).reservas.map(rr =>
          rr.numeroMovimiento === m.numeroMovimiento
            ? { ...rr, ajuste: { numeroMovimiento: rm.numeroMovimiento, idRegistro: rm.idRegistro, fecha: new Date().toISOString(), conciliado: true } }
            : rr),
      }));
      if (res.aviso && !avisoMarca) avisoMarca = res.aviso;
    }
  } catch (e) {
    // ejecutarYRegistrar re-lanza si el comprobante falló en SiGA. Cada comprobante es su propia
    // transacción, así que lo ya escrito quedó firme y marcado; se corta acá y se avisa para
    // reintentar (el reintento salta lo confirmado).
    errEscritura = `Se registraron ${comprobantes.length} comprobante(s); el siguiente falló: ${e.message}. `
                 + 'Reintentá el registro: los comprobantes ya hechos no se repiten.';
  }

  // Registros conciliados → historial: salen del listado de Terminados (quedan archivados para
  // consulta). Sólo si la marca del plan se persistió (los ítems quedaron dados de alta).
  let archivados = 0;
  if (idsRegistrados.length && !errMarca && !avisoMarca) {
    try { archivados = archivarRegistros(idsRegistrados, { numeroMovimiento: r.numeroMovimiento, planFecha: fecha }); }
    catch (e) { errMarca = `No se pudieron archivar los registros conciliados: ${e.message}`; }
  }

  const resp = {
    ok: !errEscritura, numeroMovimiento: r.numeroMovimiento, idRegistro: r.idRegistro, archivados,
    comprobantes, idSucursal: cr.idSucursal, observacion: obsBase.slice(0, 200), depositos: deps,
    lineas: todasLasLineas, resumen: { ...resto.resumen, ajustesMovimiento: ajustesMov.length },
    ...(errEscritura ? { parcial: true } : {}),
    ...(sinPlu.length ? { omitidosSinPlu: sinPlu } : {}),
    ...(avisoMarca ? { aviso: avisoMarca } : {})
  };
  return conLogError(resp, ...logErrores, errMarca, errEscritura);
}));
  return router;
};
