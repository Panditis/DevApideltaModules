'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const sql = require('mssql/msnodesqlv8');

// ── Rutas de Stock (Siga) ──────────────────────────────────────────────────────
// Consultas de stock (terminados/granel/plus), catálogo de sucursales activas,
// diagnóstico de tipos de movimiento y depósitos, y los movimientos de stock
// sueltos: alta libre, traslado entre depósitos, su log persistente y su
// reversión. Extraídas de server.js sin cambios de comportamiento: mismas rutas,
// mismo orden relativo y mismas queries. Los bloques movidos conservan la
// indentación original a propósito (hay template literals SQL multilínea y
// reindentar les cambiaría el texto).
//
// Lo que comparte vecindad con stock pero NO se movió acá, y por qué:
//   · /api/plan/:fecha/reserva* y /api/plan/:fecha/reservar|actualizar|devolver —
//     el módulo de reservas. Comparte con este router el mismo log de movimientos
//     y el mismo ledger plan.reservas[] (además del plan.reserva viejo, por
//     compatibilidad), pero se movió entero a rutas_reservas.js: no es parte de
//     este corte.
//   · /api/produccion/:fecha/conciliacion y /api/produccion/:fecha/registrar-movimiento
//     — ya estaban señaladas en server.js como parte del bloque de reservas/
//     movimientos SIGA, no de rutas_produccion.js, y se movieron junto con ese
//     bloque a rutas_reservas.js.
//   · GET /api/movimientos/siga/:numero — por dominio real es de producción: la usa
//     la conciliación (apidelta_produccion_dia.html) para auditar un comprobante sin
//     salir de la pantalla, y no tiene consumidor en las pantallas de stock. Por eso
//     se movió con el resto del bloque a rutas_reservas.js en vez de venir acá.
//
// Lo que SÍ se movió entero porque no tiene uso fuera de este router:
//   · registrarMovimientoStock — sólo la llaman las rutas de movimiento y de
//     revertir, las dos de acá abajo.
//   · MOV_LOG_ORIGENES / MOV_LOG_LIMIT_DEF / MOV_LOG_LIMIT_MAX — sólo las usa
//     GET /api/stock/movimientos.
//
// Todo lo demás que tocan estas rutas (sucursalesSiga, resolverSucursal,
// sucursalPublica, depositosActivos, trasladarStock, registrarMovimientoMultilinea,
// ejecutarYRegistrar, conLogError, leerMovLog/guardarMovLog/actualizarMovLog,
// cfgReserva, getPoolStock, leerPlanReservas, ordenesProducidasDeReserva,
// motivoBloqueoProduccion, sincronizarPlanConLog, limpiarProduccionRegistrada,
// guardarJSON, PLANES_PATH, sqlStockTerminados/Granel/PorPlu,
// TIPOS_MOVIMIENTO_STOCK_PERMITIDOS, USUARIO_MOV_MAX, ERR_SUCURSAL_INVALIDA) lo usa
// también el módulo de reservas, producción o mayoristas (varios ya viajaban por
// deps a rutas_mayoristas): se queda en server.js y viaja por acá.
module.exports = function crearRutasStock(deps) {
  const {
    apiRoute, query,
    sucursalesSiga, resolverSucursal, sucursalPublica,
    sqlStockTerminados, sqlStockGranel, sqlStockPorPlu,
    TIPOS_MOVIMIENTO_STOCK_PERMITIDOS, depositosActivos,
    cfgReserva, USUARIO_MOV_MAX, getPoolStock,
    ejecutarYRegistrar, conLogError, trasladarStock, registrarMovimientoMultilinea,
    ERR_SUCURSAL_INVALIDA, leerMovLog, guardarMovLog, actualizarMovLog,
    leerPlanReservas, ordenesProducidasDeReserva, motivoBloqueoProduccion,
    sincronizarPlanConLog, limpiarProduccionRegistrada,
    guardarJSON, PLANES_PATH,
  } = deps;
  const router = express.Router();

router.get('/api/stock/terminados', apiRoute(async () => { const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); return query(sqlStockTerminados(c.rubrosPlanificables.join(','))); }));
router.get('/api/stock/granel',     apiRoute(async () => { const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); return query(sqlStockGranel(c.rubrosGranel.join(','))); }));
router.get('/api/stock/plus',       apiRoute(async req => { const ids = String(req.query.ids||'').split(',').map(s=>s.trim()).filter(Boolean); if (!ids.length) return []; return query(sqlStockPorPlu(ids)); }));

router.get('/api/sucursales', apiRoute(async () =>
  (await sucursalesSiga()).filter(s => s.activa).map(sucursalPublica)));

// Diagnóstico de solo lectura: qué tipos de movimiento usa SiGA y con qué frecuencia.
// Sirve para elegir el IdTipoMovimiento correcto antes de habilitarlo para escritura
// (hoy solo BIENESUSO está permitido). No modifica nada.
router.get('/api/stock/tipos-movimiento', apiRoute(async req => {
  const s = await resolverSucursal(req.query.idSucursal);
  if (s.error) return { error: s.error };
  const suc = s.idSucursal;
  const [tipos, conSignoMixto] = await Promise.all([
    query(`SELECT TOP 40 ms.IdTipoMovimiento, COUNT(*) AS Comprobantes,
                  MAX(ms.FechaMovimiento) AS Ultimo
             FROM MovimientosStock ms WHERE ms.IdSucursal=${suc}
            GROUP BY ms.IdTipoMovimiento ORDER BY COUNT(*) DESC`),
    // Patrón de producción: un mismo comprobante con líneas positivas y negativas a la vez
    // (consume componentes y genera el terminado). Es lo que hoy NO cubre trasladarStock.
    query(`SELECT TOP 20 d.IdTipoMovimiento,
                  COUNT(DISTINCT d.NumeroMovimiento) AS Comprobantes,
                  SUM(CASE WHEN d.Cantidad > 0 THEN 1 ELSE 0 END) AS LineasPositivas,
                  SUM(CASE WHEN d.Cantidad < 0 THEN 1 ELSE 0 END) AS LineasNegativas
             FROM MovimientosStockProductos d WHERE d.IdSucursal=${suc}
            GROUP BY d.IdTipoMovimiento
           HAVING SUM(CASE WHEN d.Cantidad > 0 THEN 1 ELSE 0 END) > 0
              AND SUM(CASE WHEN d.Cantidad < 0 THEN 1 ELSE 0 END) > 0
            ORDER BY COUNT(DISTINCT d.NumeroMovimiento) DESC`)
  ]);
  return { permitidosParaEscritura: TIPOS_MOVIMIENTO_STOCK_PERMITIDOS, tipos, conSignoMixto };
}));

// A diferencia del resto, acá idSucursal sigue siendo obligatorio (es un endpoint de
// diagnóstico y pedir depósitos "de la sucursal que sea" no tiene sentido); lo que se suma
// es la validación contra Sucursales para no devolver una lista vacía ante un id inexistente.
router.get('/api/stock/depositos', apiRoute(async req => {
  const idSucursal = Number(req.query.idSucursal);
  if (!Number.isInteger(idSucursal) || idSucursal <= 0) return { error: 'Falta idSucursal (entero positivo)' };
  const s = await resolverSucursal(idSucursal);
  if (s.error) return { error: s.error };
  return depositosActivos(s.idSucursal);
}));

async function registrarMovimientoStock(pool, m) {
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const rq = () => new sql.Request(tx);
    const delta = (await rq()
      .input('tipo', sql.VarChar, m.idTipoMovimiento)
      .query(`SELECT CoeficienteStock FROM TiposMovimientos WHERE IdTipoMovimiento=@tipo`)
    ).recordset[0]?.CoeficienteStock;
    if (delta === undefined) throw new Error(`Tipo de movimiento desconocido: ${m.idTipoMovimiento}`);
    const cantidadStock = m.cantidad * delta;

    const numero = (await rq()
      .input('sucursal', sql.Int, m.idSucursal)
      .input('tipo', sql.VarChar, m.idTipoMovimiento)
      .query(`UPDATE MovimientosNumeros SET Numero = Numero + 1
              OUTPUT inserted.Numero AS Numero
              WHERE IdSucursal=@sucursal AND IdTipoMovimiento=@tipo`)
    ).recordset[0].Numero;

    await rq()
      .input('sucursal', sql.Int, m.idSucursal)
      .input('tipo', sql.VarChar, m.idTipoMovimiento)
      .input('numero', sql.Int, numero)
      .input('usuario', sql.NVarChar, m.usuario)
      .input('observacion', sql.NVarChar, m.observacion)
      .input('empleado', sql.Int, m.idEmpleado)
      .query(`INSERT INTO MovimientosStock
        (IdSucursal, IdTipoMovimiento, NumeroMovimiento, FechaMovimiento, Neto, Total, PorcentajeIVA,
         Usuario, Observacion, IdEmpleado, PercepcionIVA, PercepcionIB, PercepcionGanancias, PercepcionVarias, ImpuestosInternos)
        VALUES (@sucursal, @tipo, @numero, GETDATE(), 0, 0, 0, @usuario, @observacion, @empleado, 0, 0, 0, 0, 0)`);

    await rq()
      .input('sucursal', sql.Int, m.idSucursal)
      .input('deposito', sql.Int, m.idDeposito)
      .input('ubicacion', sql.Int, m.idUbicacion)
      .input('tipo', sql.VarChar, m.idTipoMovimiento)
      .input('numero', sql.Int, numero)
      .input('producto', sql.VarChar, m.idProducto)
      .input('cantidad', sql.Decimal(18, 4), m.cantidad)
      .query(`INSERT INTO MovimientosStockProductos
        (IdSucursal, IdDeposito, IdUbicacion, IdTipoMovimiento, NumeroMovimiento, IdProducto, Cantidad, Cantidad2, Precio, Orden)
        VALUES (@sucursal, @deposito, @ubicacion, @tipo, @numero, @producto, @cantidad, 0, 0, 1)`);

    await rq()
      .input('sucursal', sql.Int, m.idSucursal)
      .input('deposito', sql.Int, m.idDeposito)
      .input('producto', sql.VarChar, m.idProducto)
      .input('delta', sql.Decimal(18, 4), cantidadStock)
      .query(`IF EXISTS (SELECT 1 FROM ProductosDepositos WHERE IdProducto=@producto AND IdSucursal=@sucursal AND IdDeposito=@deposito)
                UPDATE ProductosDepositos SET Stock = Stock + @delta
                WHERE IdProducto=@producto AND IdSucursal=@sucursal AND IdDeposito=@deposito;
              ELSE
                INSERT INTO ProductosDepositos (IdProducto, IdSucursal, IdDeposito, Stock, Stock2)
                VALUES (@producto, @sucursal, @deposito, @delta, 0);`);

    await rq()
      .input('sucursal', sql.Int, m.idSucursal)
      .input('deposito', sql.Int, m.idDeposito)
      .input('ubicacion', sql.Int, m.idUbicacion)
      .input('producto', sql.VarChar, m.idProducto)
      .input('delta', sql.Decimal(18, 4), cantidadStock)
      .query(`IF EXISTS (SELECT 1 FROM ProductosUbicaciones WHERE IdProducto=@producto AND IdSucursal=@sucursal AND IdDeposito=@deposito AND IdUbicacion=@ubicacion)
                UPDATE ProductosUbicaciones SET Stock = Stock + @delta
                WHERE IdProducto=@producto AND IdSucursal=@sucursal AND IdDeposito=@deposito AND IdUbicacion=@ubicacion;
              ELSE
                INSERT INTO ProductosUbicaciones (IdProducto, IdSucursal, IdDeposito, IdUbicacion, Stock, Stock2)
                VALUES (@producto, @sucursal, @deposito, @ubicacion, @delta, 0);`);

    await tx.commit();
    return numero;
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}

router.post('/api/stock/movimiento', apiRoute(async req => {
  const b = req.body || {};
  const idSucursal      = Number(b.idSucursal);
  const idDeposito       = Number(b.idDeposito);
  const idUbicacion      = Number(b.idUbicacion);
  const idEmpleado       = Number(b.idEmpleado);
  const cantidad         = Number(b.cantidad);
  const idTipoMovimiento = String(b.idTipoMovimiento || '').trim().toUpperCase();
  const idProducto       = String(b.idProducto || '').trim();
  // Sin usuario en el body se firma con el de config.json (reserva.usuario): así el usuario
  // de los movimientos se cambia en un solo lugar. Recortado por USUARIO_MOV_MAX.
  const usuario          = String(b.usuario || cfgReserva().usuario || '').trim().slice(0, USUARIO_MOV_MAX);
  const observacion      = String(b.observacion || '').trim().slice(0, 200);

  if (!TIPOS_MOVIMIENTO_STOCK_PERMITIDOS.includes(idTipoMovimiento)) {
    return { error: `idTipoMovimiento inválido. Permitidos: ${TIPOS_MOVIMIENTO_STOCK_PERMITIDOS.join(', ')}` };
  }
  if (![idSucursal, idDeposito, idUbicacion, idEmpleado].every(n => Number.isInteger(n) && n > 0)) {
    return { error: 'idSucursal, idDeposito, idUbicacion e idEmpleado deben ser enteros positivos' };
  }
  if (!Number.isFinite(cantidad) || cantidad === 0) {
    return { error: 'cantidad debe ser un número distinto de 0' };
  }
  if (!idProducto) return { error: 'Falta idProducto' };
  if (!usuario)    return { error: 'Falta usuario' };

  const poolW = await getPoolStock();
  // Movimiento de una sola línea y sin depósito destino: en el log va depDestino en null.
  const r = await ejecutarYRegistrar({
    origen: 'movimiento', plan: null, itemId: null,
    idSucursal, depOrigen: idDeposito, depDestino: null, idUbicacion, idEmpleado,
    idTipoMovimiento, usuario, observacion,
    lineas: [{ plu: idProducto, nombre: null, cantidad }]
  }, () => registrarMovimientoStock(poolW, {
    idSucursal, idDeposito, idUbicacion, idEmpleado, cantidad,
    idTipoMovimiento, idProducto, usuario, observacion
  }));
  return conLogError({ ok: true, numeroMovimiento: r.numeroMovimiento, idTipoMovimiento, idSucursal, idRegistro: r.idRegistro }, r.logError);
}));

// 'reserva' es la de planificacion (componentes de formula del plan del dia); 'reserva-mayorista'
// es la de Pedidos mayoristas (producto terminado apartado para UN cliente). Son dos flujos
// distintos y hay que poder filtrarlos por separado en /api/stock/movimientos.
const MOV_LOG_ORIGENES     = ['reserva', 'reserva-mayorista', 'ajuste', 'devolucion', 'traslado', 'movimiento', 'produccion'];
const MOV_LOG_LIMIT_DEF    = 100;
const MOV_LOG_LIMIT_MAX    = 500;

router.get('/api/stock/movimientos', apiRoute(async req => {
  const q      = req.query || {};
  const plan   = String(q.plan   || '').trim();
  const origen = String(q.origen || '').trim();
  const estado = String(q.estado || '').trim();
  const limit  = Math.min(Math.max(parseInt(q.limit) || MOV_LOG_LIMIT_DEF, 1), MOV_LOG_LIMIT_MAX);
  if (origen && !MOV_LOG_ORIGENES.includes(origen)) {
    return { error: `origen inválido. Permitidos: ${MOV_LOG_ORIGENES.join(', ')}` };
  }
  // Filtro por sucursal: cada registro del log ya guarda su idSucursal. Se valida sólo el
  // formato (no se consulta SiGA): sin el parámetro se devuelven todas, como hasta ahora.
  const filtraSuc  = String(q.idSucursal ?? '').trim() !== '';
  const idSucursal = filtraSuc ? Number(q.idSucursal) : null;
  if (filtraSuc && (!Number.isInteger(idSucursal) || idSucursal <= 0)) return { error: ERR_SUCURSAL_INVALIDA };
  return leerMovLog()
    .filter(r => r && (!plan || r.plan === plan) && (!origen || r.origen === origen) && (!estado || r.estado === estado)
              && (!filtraSuc || Number(r.idSucursal) === idSucursal))
    .slice()
    .reverse()   // el log se escribe con el más nuevo al final; acá se devuelve al revés
    .slice(0, limit);
}));

router.get('/api/stock/movimientos/:id', apiRoute(async req => {
  const id = String(req.params.id || '').trim();
  return leerMovLog().find(r => r && r.id === id) || { error: 'Movimiento no encontrado' };
}));

// Revierte un movimiento ya confirmado generando OTRO movimiento con los depósitos
// invertidos (o la cantidad en negativo, para los movimientos de una sola línea).
// IMPORTANTE: revertir desde el log NO toca plan.reserva. El estado del plan y este log son
// dos registros distintos: el camino normal para deshacer una reserva es "Anular reserva"
// (POST /api/plan/:fecha/reserva/devolver), que además actualiza el plan. Revertir desde acá
// es la salida de emergencia para cuando el plan ya no existe o quedó inconsistente.
router.post('/api/stock/movimientos/:id/revertir', apiRoute(async req => {
  const id  = String(req.params.id || '').trim();
  const b   = req.body || {};
  const log = leerMovLog();
  const original = log.find(r => r && r.id === id);
  if (!original) return { error: 'Movimiento no encontrado' };

  if (original.estado === 'pendiente') {
    return { error: 'El movimiento quedó en estado pendiente: no se sabe si llegó a ejecutarse en SiGA. Verificalo a mano en SiGA antes de revertirlo.' };
  }
  if (original.estado === 'fallido') {
    return { error: 'El movimiento falló y no llegó a mover stock: no hay nada que revertir.' };
  }
  if (original.estado === 'revertido' || original.revertidoPor) {
    return { error: `El movimiento ya fue revertido por el registro ${original.revertidoPor || '(desconocido)'}.` };
  }
  if (original.estado !== 'confirmado') {
    return { error: `Sólo se pueden revertir movimientos confirmados (estado actual: ${original.estado}).` };
  }
  const lineas = (original.lineas || []).filter(l => Number(l.cantidad));
  if (!lineas.length) return { error: 'El movimiento no tiene líneas con cantidad para revertir' };

  // Misma guarda que "Anular reserva" y que modificar/eliminar una orden: una reserva cuyas
  // órdenes ya se produjeron y recepcionaron no se puede revertir, porque sus componentes ya
  // salieron del depósito de reserva. Va ANTES de escribir nada en SiGA.
  if ((original.origen === 'reserva' || original.origen === 'ajuste') && original.plan) {
    const { plan: planRev } = leerPlanReservas(original.plan);
    // El ajuste no tiene entrada en el ledger: sus órdenes son las que quedaron selladas con
    // su comprobante.
    const entrada = original.origen === 'ajuste'
      ? { ordenes: ((planRev && planRev.items) || [])
            .filter(it => it.reservaMovimiento && String(it.reservaMovimiento.numeroMovimiento) === String(original.numeroMovimiento))
            .map(it => it.id) }
      : planRev && (planRev.reservas || []).find(rr => rr &&
          (rr.idRegistro === original.id ||
           (rr.numeroMovimiento != null && rr.numeroMovimiento === original.numeroMovimiento)));
    const producidas = ordenesProducidasDeReserva(entrada, planRev && planRev.items);
    if (producidas.length) {
      return { error: motivoBloqueoProduccion(producidas, 'revertir este movimiento'), yaProducido: true };
    }
  }

  const cr          = cfgReserva();
  // Se firma con el usuario vigente de config.json, no con el del movimiento original: la
  // reversión la hace quien opera hoy. El usuario original queda igual en su propio registro.
  const usuario     = String(b.usuario || cr.usuario || '').trim().slice(0, USUARIO_MOV_MAX);
  const observacion = String(b.observacion || `Reversion de ${original.numeroMovimiento} (${original.origen})`).trim().slice(0, 200);
  const idEmpleado  = Number.isInteger(original.idEmpleado) && original.idEmpleado > 0 ? original.idEmpleado : cr.idEmpleado;
  if (!usuario) return { error: 'Falta usuario para registrar la reversión' };

  const poolW = await getPoolStock();
  // Tres formas distintas de revertir, según cómo se escribió el movimiento original:
  //  · multi-depósito (producción): cada línea tiene su propio depósito y su propio signo, y
  //    la cabecera depOrigen/depDestino es sólo referencia. Invertir los depósitos de la
  //    cabecera —como en un traslado— dejaría el stock en el lugar equivocado, así que la
  //    reversión invierte el SIGNO de cada línea y la deja en SU MISMO depósito.
  //  · sin depósito destino: movimiento de una sola línea, se repite con la cantidad negada.
  //  · el resto: traslado, se repite con los depósitos invertidos.
  const esMultiDeposito    = lineas.some(l => l && l.idDeposito != null);
  const esMovimientoSimple = !esMultiDeposito && original.depDestino == null;
  const lineasReversion = esMultiDeposito
    ? lineas.map(l => ({ ...l, cantidad: -Number(l.cantidad) }))
    : esMovimientoSimple
    ? [{ ...lineas[0], cantidad: -Number(lineas[0].cantidad) }]
    : lineas.map(l => ({ ...l, cantidad: Number(l.cantidad) }));

  const r = await ejecutarYRegistrar({
    origen: original.origen, plan: original.plan, itemId: original.itemId,
    idSucursal: original.idSucursal,
    depOrigen:  esMultiDeposito ? original.depOrigen : esMovimientoSimple ? original.depOrigen : original.depDestino,
    depDestino: esMultiDeposito ? original.depDestino : esMovimientoSimple ? null : original.depOrigen,
    idUbicacion: original.idUbicacion, idEmpleado,
    idTipoMovimiento: original.idTipoMovimiento, usuario, observacion,
    lineas: lineasReversion, revierteA: original.id
  }, () => esMultiDeposito
    ? registrarMovimientoMultilinea(poolW, {
        idSucursal: original.idSucursal, idTipoMovimiento: original.idTipoMovimiento,
        usuario, idEmpleado, observacion,
        lineas: lineasReversion.map(l => ({ idProducto: l.plu, idDeposito: l.idDeposito, cantidad: l.cantidad }))
      })
    : esMovimientoSimple
    ? registrarMovimientoStock(poolW, {
        idSucursal: original.idSucursal, idDeposito: original.depOrigen,
        idUbicacion: Number.isInteger(original.idUbicacion) && original.idUbicacion > 0 ? original.idUbicacion : 1,
        idEmpleado, cantidad: lineasReversion[0].cantidad,
        idTipoMovimiento: original.idTipoMovimiento, idProducto: lineasReversion[0].plu,
        usuario, observacion
      })
    : trasladarStock(poolW, {
        idSucursal: original.idSucursal, depOrigen: original.depDestino, depDestino: original.depOrigen,
        idTipoMovimiento: original.idTipoMovimiento, usuario, observacion, idEmpleado,
        lineas: lineasReversion.map(l => ({ idProducto: l.plu, cantidad: l.cantidad }))
      })
  );

  // Fase de enlace: se marca el original como revertido y se enlaza con su reversión.
  // Va ANTES de sincronizar el plan: el saldo según el log sólo descuenta la reversión una
  // vez que el par quedó enlazado.
  let errEnlace = null;
  try {
    const actual = leerMovLog();
    const copia  = actual.map(reg => {
      if (!reg) return reg;
      if (reg.id === original.id) return { ...reg, estado: 'revertido', revertidoPor: r.idRegistro };
      return reg;
    });
    guardarMovLog(copia);
  } catch (e) { errEnlace = `No se pudo enlazar la reversión ${r.idRegistro} con el original ${original.id}: ${e.message}`; }

  // Revertir el alta de producción tiene que dejar el plan como para poder volver a
  // registrarla: se borra la marca y, si la reserva se había cerrado justamente porque ese
  // movimiento consumió todo lo apartado, vuelve a quedar activa (la reversión devolvió los
  // componentes al depósito de reserva). Va ANTES de sincronizar el plan: sincronizarPlanConLog
  // sólo mira reservas activas.
  const errMarcaProduccion = original.origen === 'produccion' && original.plan
    ? limpiarProduccionRegistrada(original.plan, original.id)
    : null;

  // El plan y el log son registros distintos, así que acá se pone el plan al día con lo que
  // dice el log: si ya no queda nada en el depósito de reserva la reserva se anula sola, y
  // si quedó saldo parcial se avisa (no se puede recalcular a qué ítem le corresponde).
  let planSincronizado = null, advertencia = null, errPlan = null;
  if (original.plan) {
    try {
      const { motivo } = sincronizarPlanConLog(original.plan);
      if (motivo === 'anulada' || motivo === 'parcial') planSincronizado = motivo;
      if (motivo === 'parcial') {
        advertencia = `La reserva del plan ${original.plan} quedó con saldo parcial: según el log todavía hay componentes en el depósito de reserva, pero ya no coinciden con lo que dice el plan. Revisá la reserva y anulala antes de seguir.`;
      }
    } catch (e) { errPlan = `No se pudo sincronizar el plan ${original.plan} con el log: ${e.message}`; }
  }

  // Revertir una reserva libera sus órdenes: se anula la entrada del ledger (plan.reservas)
  // que corresponde a este movimiento y se limpia el sello reservaMovimiento de los ítems
  // que cubría, re-habilitándolos para volver a reservarse. Va DESPUÉS de sincronizarPlanConLog
  // (que sólo mira el plan.reserva viejo, único, agregado de todo el depósito) para que esta
  // actualización puntual por movimiento sea la que quede como estado final.
  // Los ajustes entran por el mismo camino: no tienen entrada propia en el ledger (el .map de
  // abajo no matchea ninguna), pero sí sellan ítems y hay que soltarlos igual.
  let errLedgerReserva = null;
  if ((original.origen === 'reserva' || original.origen === 'ajuste') && original.plan) {
    try {
      const { planes: planesReserva, plan: planReserva } = leerPlanReservas(original.plan);
      if (planReserva) {
        const reservas = (planReserva.reservas || []).map(rr =>
          (rr.idRegistro === original.id || (rr.numeroMovimiento != null && rr.numeroMovimiento === original.numeroMovimiento))
            ? { ...rr, estado: 'anulada' } : rr);
        const items = (planReserva.items || []).map(it =>
          (it.reservaMovimiento && it.reservaMovimiento.numeroMovimiento === original.numeroMovimiento)
            ? { ...it, reservaMovimiento: null } : it);
        // Compat: si plan.reserva (single, formato viejo) apuntaba a este movimiento, marcarlo anulado.
        const reservaCompat = (planReserva.reserva && planReserva.reserva.numeroMovimiento === original.numeroMovimiento)
          ? { ...planReserva.reserva, estado: 'anulada' } : planReserva.reserva;
        const planActualizado = { ...planReserva, reservas, items, reserva: reservaCompat };
        guardarJSON(PLANES_PATH, { ...planesReserva, [original.plan]: planActualizado });
      }
    } catch (e) { errLedgerReserva = `No se pudo anular la reserva del ledger para el plan ${original.plan}: ${e.message}`; }
  }

  // La advertencia queda también en el registro de la reversión, para que se entienda
  // después por qué el plan quedó marcado.
  const errAdv = advertencia ? actualizarMovLog(r.idRegistro, reg => ({ ...reg, advertencia })) : null;

  const resp = { ok: true, numeroMovimiento: r.numeroMovimiento, id: r.idRegistro, revierteA: original.id };
  const conPlan = planSincronizado ? { ...resp, planSincronizado } : resp;
  return conLogError(advertencia ? { ...conPlan, advertencia } : conPlan,
    r.logError, errEnlace, errPlan, errAdv, errMarcaProduccion, errLedgerReserva);
}));

router.post('/api/stock/traslado', apiRoute(async req => {
  const b = req.body || {};
  const idSucursal       = Number(b.idSucursal);
  const depOrigen        = Number(b.depOrigen);
  const depDestino       = Number(b.depDestino);
  const idEmpleado       = Number(b.idEmpleado);
  const idTipoMovimiento = String(b.idTipoMovimiento || '').trim().toUpperCase();
  // Sin usuario en el body se firma con el de config.json (reserva.usuario): así el usuario
  // de los movimientos se cambia en un solo lugar. Recortado además porque la columna
  // MovimientosStock.Usuario es corta y un valor largo hace fallar todo el INSERT con
  // "String or binary data would be truncated" (ver USUARIO_MOV_MAX).
  const usuario          = String(b.usuario || cfgReserva().usuario || '').trim().slice(0, USUARIO_MOV_MAX);
  const observacion      = String(b.observacion || '').trim().slice(0, 200);
  const lineas           = Array.isArray(b.lineas) ? b.lineas : [];

  if (!TIPOS_MOVIMIENTO_STOCK_PERMITIDOS.includes(idTipoMovimiento)) {
    return { error: `idTipoMovimiento inválido. Permitidos: ${TIPOS_MOVIMIENTO_STOCK_PERMITIDOS.join(', ')}` };
  }
  if (![idSucursal, depOrigen, depDestino, idEmpleado].every(n => Number.isInteger(n) && n > 0)) {
    return { error: 'idSucursal, depOrigen, depDestino e idEmpleado deben ser enteros positivos' };
  }
  if (depOrigen === depDestino) return { error: 'depOrigen y depDestino deben ser distintos' };
  if (!usuario)       return { error: 'Falta usuario' };
  if (!lineas.length) return { error: 'Falta lineas (al menos un producto a trasladar)' };
  for (const l of lineas) {
    const cantidad = Number(l && l.cantidad);
    if (!String((l && l.idProducto) || '').trim()) return { error: 'Cada línea debe tener idProducto' };
    if (!Number.isFinite(cantidad) || cantidad <= 0) return { error: `Cantidad inválida para el producto ${l.idProducto}: debe ser un número mayor a 0` };
  }

  const poolW   = await getPoolStock();
  const limpias = lineas.map(l => ({ idProducto: String(l.idProducto).trim(), cantidad: Number(l.cantidad) }));
  const r = await ejecutarYRegistrar({
    origen: 'traslado', plan: null, itemId: null,
    idSucursal, depOrigen, depDestino, idTipoMovimiento, usuario, observacion, idEmpleado,
    lineas: limpias.map(l => ({ plu: l.idProducto, nombre: null, cantidad: l.cantidad }))
  }, () => trasladarStock(poolW, {
    idSucursal, depOrigen, depDestino, idTipoMovimiento, usuario, observacion, idEmpleado,
    lineas: limpias
  }));
  return conLogError({ ok: true, numeroMovimiento: r.numeroMovimiento, idRegistro: r.idRegistro }, r.logError);
}));

  return router;
};
