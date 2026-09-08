'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const { calcularFaltantesFraccionado } = require('../lib/fraccionado_faltantes');
const { resolverProductoCarga, analizarNombreCarga } = require('../lib/producto_carga');
const { validarLineasFraccionado, normalizarLineasFraccionado, totalesOrdenFraccionado,
        progresoOrdenFraccionado, marcarLineaOrden, editarLineaOrden, validarLineasNoRepetidas,
        compromisosPorPlu } = require('../lib/ordenes_fraccionado');
const { validarLineasReserva, normalizarLineasReserva, validarClienteReserva,
        validarCarritoUnCliente, nuevaReserva, anularReserva } = require('../lib/reservas_mercaderia');
const { lineaAApartar, validarLineaPesable,
        lineasADevolverMayorista,
        lineasTerminadoADevolverMayorista, filasSaldoMayorista } = require('../lib/reservas_pesables');

// ── Rutas del módulo Mayoristas ──────────────────────────────────────────────
// Extraídas de server.js sin cambios de comportamiento: mismas rutas, mismo orden
// relativo entre ellas y mismas queries. Los bloques movidos conservan la
// indentación original a propósito: reindentar cambiaría el texto de los SQL
// multilínea, que son template literals.
//
// El orden importa dentro del router: /reservas/saldos va antes que /reservas/:id
// y /ordenes-fraccionado/plus-activos antes que /ordenes-fraccionado/:id, o Express
// matchea la palabra como un id. Se conservó tal cual estaba.
//
// fraccionado_faltantes.js, producto_carga.js, ordenes_fraccionado.js,
// reservas_mercaderia.js y reservas_pesables.js son lógica pura sin estado: se
// requieren directo. Todo lo que tiene estado o vive en server.js (pool SQL, disco,
// config, movimientos a SiGA) entra por deps.
//
// Lo que NO se mudó, a propósito, y llega por deps:
//   · bomGranelPorPlu → lo usa también /api/resumen (la tabla de pedidos), que
//     sigue en server.js. Es la única fuente de la equivalencia bulto→granel.
//   · RESERVAS_MERC_PATH → el tablero de almacén lee el mismo archivo para sumar
//     el reservado mayorista al del plan. Dos fuentes de verdad del mismo JSON no.
//   · params, apiRoute, conLogError, ejecutarYRegistrar, trasladarStock,
//     resolverSucursal, depositosActivos, stockDeComponentes, asientosProduccion,
//     cfgReserva, cfgProduccion, redondear4, esIdDeposito y los SQL compartidos:
//     son infraestructura del server, la usan casi todos los módulos.
module.exports = function crearRutasMayoristas(deps) {
  const {
    apiRoute, params, query, getPoolStock, getResumen,
    leerJSON, guardarJSON, DATA_DIR, PLANES_PATH,
    FORMULA_ACTIVA_SQL, SIN_FORMULA_GENERICO_SQL, sqlBOMGranel,
    bomGranelPorPlu, RESERVAS_MERC_PATH,
    resolverSucursal, depositosActivos, trasladarStock, ejecutarYRegistrar, conLogError,
    cfgReserva, cfgProduccion, ERR_RESERVA_SIN_CONFIG, ERR_RESERVA_DEPOSITOS,
    redondear4, esIdDeposito, stockDeComponentes, asientosProduccion,
  } = deps;
  const router = express.Router();

async function getFaltantesFraccionado(desde, hasta, localidades, clientes, pedidos, estados) {
  const filasResumen = await getResumen(desde, hasta, localidades, clientes, pedidos, estados);
  if (!filasResumen.length) return [];

  // Agregado por PLU conservando el desglose de clientes (getResumen viene por cliente+producto).
  const porPlu = new Map();
  for (const r of filasResumen) {
    const plu = String(r.IdProducto);
    if (!porPlu.has(plu)) {
      porPlu.set(plu, {
        plu, nombre: r.NombreProducto, rubro: r.NombreRubro || '',
        pendiente: 0, stockCentral: Number(r.StockCentral) || 0, clientes: [],
      });
    }
    const acc = porPlu.get(plu);
    const pend = Number(r.TotalUnidades) || 0;
    acc.pendiente += pend;
    acc.clientes.push({ idCliente: r.IdCliente, nombre: r.NombreCliente, pendiente: pend });
  }

  const bomGranel = await bomGranelPorPlu([...porPlu.keys()]);
  if (!bomGranel.size) return [];

  // Stock del granel: se suman todos los depósitos de la central, sin filtrar por nombre de
  // depósito. El filtro LIKE '%GRANEL%' no sirve acá (ningún depósito se llama así en Siga: el
  // preexistente /api/stock/granel devuelve StockGranel=0 con StockTotal>0 por ese mismo motivo).
  // El granel ya es un producto propio ("X DEPOSITO GRANEL"), así que alcanza con acotar por PLU,
  // igual que hace el módulo de pesables al resolver su columna de granel.
  const granelCodes = [...new Set([...bomGranel.values()].map(b => b.granelPlu))].filter(g => /^\d+$/.test(g));
  const granelRows = granelCodes.length ? await query(`
    SELECT pd.IdProducto, COALESCE(SUM(pd.Stock),0) AS Stock
    FROM ProductosDepositos pd
    INNER JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal
    INNER JOIN Sucursales s ON s.IdSucursal=pd.IdSucursal
    WHERE s.SoyLaCentral=1
      AND pd.IdProducto IN (${granelCodes.map(g => `'${g}'`).join(',')})
    GROUP BY pd.IdProducto`) : [];
  const stockGranel = new Map(granelRows.map(r => [String(r.IdProducto), Number(r.Stock) || 0]));

  return calcularFaltantesFraccionado([...porPlu.values()], bomGranel, stockGranel);
}

router.get('/api/mayoristas/fraccionado-faltantes', apiRoute(async req => {
  const p = params(req);
  return getFaltantesFraccionado(p.desde, p.hasta, p.localidades, p.clientes, p.pedidos, p.estados);
}));

// Escapa un texto para usarlo como prefijo de un LIKE: además de duplicar la comilla simple
// (mismo criterio que el resto del archivo), neutraliza los comodines de SQL Server con la
// notación de corchetes, así un nombre con "%" o "_" no se convierte en un patrón abierto.
function escaparLikePrefijo(s) {
  return String(s || '').replace(/'/g, "''").replace(/[%_\[]/g, c => `[${c}]`);
}

// Producto contra el cual la encargada carga la producción de una línea mayorista.
// No es el producto de la línea ni el componente del BOM: la regla es por nombre y vive en
// producto_carga.js (puro, testeado). Acá sólo se arma el catálogo de candidatos.
router.get('/api/mayoristas/producto-carga', apiRoute(async req => {
  const plu = String(req.query.plu || '').trim();
  // Siempre 200 con `motivo`: la UI tiene que poder avisar "no se pudo resolver" y seguir
  // trabajando, no romper la pantalla de carga con un 500.
  if (!/^\d+$/.test(plu)) return { plu: null, motivo: 'PLU inválido' };

  const filas = await query(
    `SELECT TOP 1 IdProducto, NombreProducto FROM dbo.Productos WHERE IdProducto='${plu}'`);
  if (!filas.length) return { plu: null, motivo: `No existe el producto ${plu}` };
  const nombreMayorista = String(filas[0].NombreProducto || '');

  const info = analizarNombreCarga(nombreMayorista);
  if (!info.base) return { plu: null, nombreMayorista, motivo: 'No se pudo derivar el nombre base' };

  // Se acota por prefijo del nombre base en vez de traer los ~20k productos: tanto el minorista
  // ("Mix Europeo 200G") como el PEDIDOS ("Mix Europeo PEDIDOS") empiezan con ese base. El TOP
  // es un tope de seguridad para bases muy cortas; el orden lo hace determinista.
  const candidatos = await query(
    `SELECT TOP 300 IdProducto, NombreProducto FROM dbo.Productos
     WHERE Activo=1 AND NombreProducto LIKE '${escaparLikePrefijo(info.base)}%'
     ORDER BY NombreProducto`);

  const destino = resolverProductoCarga(nombreMayorista,
    candidatos.map(r => ({ plu: String(r.IdProducto), nombre: r.NombreProducto })));
  if (!destino) {
    const esperado = info.presentacionKg != null && info.presentacionKg <= 1
      ? `${info.base} de ${info.presentacionKg} kg` : `${info.base} PEDIDOS`;
    return { plu: null, nombreMayorista, base: info.base, presentacionKg: info.presentacionKg,
             motivo: `No se encontró el producto de carga (${esperado})` };
  }

  // Granel del destino: la pantalla de carga lo necesita para mostrar los kg que consume cada
  // unidad. Es informativo, así que si el destino no tiene fórmula activa se devuelve igual.
  let granel = null;
  if (/^\d+$/.test(destino.plu)) {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));

    // Destino con UN solo componente directo: ese componente ES el producto que se descuenta.
    // Es el caso de las mezclas que se envasan desde un granel que no está en rubrosGranel
    // ("G. KETO PEDIDOS" → "G. KETO 10Kg (Precio por kilo)", cantidad 1). sqlBOMGranel no lo ve
    // por el rubro, baja un nivel más y devuelve un ingrediente suelto de la mezcla
    // (Nuez Cuartillo 0.224), que no es lo que se consume al fraccionar.
    const directos = await query(`
      SELECT pc.IdProductoComponente, p.NombreProducto AS NombreComponente, pc.Cantidad AS CantPorUnidad
      FROM ProductosComponentes pc INNER JOIN Productos p ON p.IdProducto=pc.IdProductoComponente
      WHERE pc.IdProducto='${destino.plu}' AND ${FORMULA_ACTIVA_SQL} AND ${SIN_FORMULA_GENERICO_SQL}`);
    if (directos.length === 1) {
      const d = directos[0];
      return { ...destino, nombreMayorista, base: info.base,
               granelPlu: String(d.IdProductoComponente), granelNombre: d.NombreComponente || '',
               cantPorUnidad: Number(d.CantPorUnidad) || 0 };
    }

    const bomRows = await query(
      sqlBOMGranel(c.rubrosGranel.join(','), ` AND pc.IdProducto IN ('${destino.plu}')`));
    for (const b of bomRows) {
      const cand = { granelPlu: String(b.IdProductoComponente), granelNombre: b.NombreComponente || '',
                     cantPorUnidad: Number(b.CantPorUnidad) || 0 };
      // Mismo criterio que getFaltantesFraccionado: el componente principal es el de mayor
      // CantPorUnidad, el resto son trazas.
      if (!granel || cand.cantPorUnidad > granel.cantPorUnidad) granel = cand;
    }
  }

  return { ...destino, nombreMayorista, base: info.base, ...(granel || {}) };
}));

const ORD_FRACC_PATH = path.join(DATA_DIR, 'ordenes_fraccionado.json');

// La validación, la normalización y los totales viven en ordenes_fraccionado.js (puro, testeado):
// el granel es opcional porque el armado manual de órdenes incluye productos sin granel resoluble.

// El progreso por línea se calcula al vuelo en cada respuesta y NO se persiste: así no puede
// quedar desincronizado de `lineas` si una orden se edita por otra vía.
const conProgreso = orden => ({ ...orden, progreso: progresoOrdenFraccionado(orden.lineas) });

router.get('/api/mayoristas/ordenes-fraccionado', apiRoute(async () =>
  leerJSON(ORD_FRACC_PATH, []).slice().sort((a, b) => b.id - a.id).map(conProgreso)));

// Los cuatro handlers que siguen van con (req, res) crudo y NO con apiRoute: apiRoute hace
// `res.json(await fn(req))`, sin forma de setear el status, así que envolverlos convertiría
// los 400 de validación y los 404 en respuestas 200. Es el mismo criterio que el resto de las
// rutas de escritura del archivo (ver /api/admin/modulos).
// Va ANTES de :id (Express matchea por orden de registro y 'plus-activos' caería en el handler
// de arriba). Es el detalle de qué PLU están comprometidos y con qué cliente: la usa
// pedidos_web.html para bloquear el alta en el momento (por cliente, no por PLU a secas), sin
// bajarse todas las órdenes con sus líneas. `null` en vez de un array de clientes significa "sin
// cliente registrado, bloqueado para cualquiera" (ver compromisosPorPlu).
router.get('/api/mayoristas/ordenes-fraccionado/plus-activos', apiRoute(async () => {
  const compromisos = compromisosPorPlu(leerJSON(ORD_FRACC_PATH, []));
  const out = {};
  for (const [plu, info] of compromisos) out[plu] = info.sinCliente ? null : [...info.clientes.keys()];
  return out;
}));

// También ANTES de :id, por lo mismo que plus-activos. Endpoint liviano de polling: Distribución
// pregunta cada tanto si hay órdenes nuevas o editadas, así que devuelve sólo los sellos de tiempo
// y la cantidad de líneas, nunca las líneas enteras.
router.get('/api/mayoristas/ordenes-fraccionado/novedades', apiRoute(async () =>
  leerJSON(ORD_FRACC_PATH, [])
    .filter(o => o && o.estado === 'pendiente')
    .map(o => {
      // Las órdenes guardadas antes de estos campos no los tienen, pero el id ES un Date.now():
      // alcanza para que el polling detecte un alta vieja sin tener que migrar el archivo.
      const creadoEn = Number(o.creadoEn) || Number(o.id) || 0;
      return {
        id: o.id, fecha: o.fecha, estado: o.estado,
        creadoEn, actualizadoEn: Number(o.actualizadoEn) || creadoEn,
        lineas: Array.isArray(o.lineas) ? o.lineas.length : 0,
      };
    })));

router.get('/api/mayoristas/ordenes-fraccionado/:id', (req, res) => {
  const orden = leerJSON(ORD_FRACC_PATH, []).find(o => String(o.id) === String(req.params.id));
  if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });
  res.json(conProgreso(orden));
});

router.post('/api/mayoristas/ordenes-fraccionado', (req, res) => {
  const error = validarLineasFraccionado(req.body && req.body.lineas);
  if (error) return res.status(400).json({ error });
  const arr = leerJSON(ORD_FRACC_PATH, []);
  // Un artículo se manda a fraccionar una sola vez por cliente: si el mismo cliente ya lo tiene en
  // una orden sin anular (o el PLU está repetido dentro del mismo body) se rechaza la orden entera.
  // Otro cliente pidiendo el mismo PLU sí puede convivir en otra orden activa (ver
  // validarLineasNoRepetidas). 409 y no 400 porque el body es válido: lo que choca es el estado del
  // archivo, y el frontend lo distingue para avisar de otra manera.
  const repetido = validarLineasNoRepetidas(req.body.lineas, arr);
  if (repetido) return res.status(409).json({ error: repetido });
  const lineas = normalizarLineasFraccionado(req.body.lineas);
  // Un solo Date.now() para los dos: una orden recién creada nunca puede figurar como editada.
  const ahora = Date.now();
  const orden = {
    id: ahora,
    fecha: new Date().toISOString().slice(0, 10),
    // Sellos que consulta el polling de /novedades: alta y última modificación de la orden.
    creadoEn: ahora,
    actualizadoEn: ahora,
    origen: 'mayorista',
    estado: 'pendiente',
    usuario: String((req.body && req.body.usuario) || ''),
    filtros: (req.body && req.body.filtros) || {},
    lineas,
    totales: totalesOrdenFraccionado(lineas),
  };
  arr.push(orden);
  guardarJSON(ORD_FRACC_PATH, arr);
  res.json(conProgreso(orden));
});

// Va ANTES del PUT /:id sólo por claridad: Express no necesita el orden acá porque `:id` no matchea
// barras, así que /:id/lineas/:plu nunca cae en el handler de arriba ni al revés.
router.put('/api/mayoristas/ordenes-fraccionado/:id/lineas/:plu', (req, res) => {
  const arr = leerJSON(ORD_FRACC_PATH, []);
  const i = arr.findIndex(o => String(o.id) === String(req.params.id));
  if (i < 0) return res.status(404).json({ error: 'Orden no encontrada' });
  const body = req.body || {};
  // La fecha y la hora las pone el server: el cliente no puede antedatar una carga de producción.
  // Las dos salen del MISMO Date y en hora local, no UTC: con toISOString() una carga hecha
  // después de las 21:00 ART quedaba fechada al día siguiente, y la hora habría salido corrida.
  const ahora = new Date();
  const dosDig = n => String(n).padStart(2, '0');
  const { orden, error } = marcarLineaOrden(arr[i], req.params.plu, {
    estado: body.estado,
    cargadoCant: body.cargadoCant,
    fecha: `${ahora.getFullYear()}-${dosDig(ahora.getMonth() + 1)}-${dosDig(ahora.getDate())}`,
    hora: `${dosDig(ahora.getHours())}:${dosDig(ahora.getMinutes())}`,
  });
  if (error) return res.status(400).json({ error });
  arr[i] = orden;
  guardarJSON(ORD_FRACC_PATH, arr);
  res.json(conProgreso(orden));
});

// Corrección de la cantidad pedida de UNA línea, desde Pedidos mayoristas. Aparte del PUT de
// /lineas/:plu (que es el avance de la sala) porque son dos permisos y dos reglas distintas:
// editar sólo se puede mientras la línea siga pendiente.
router.put('/api/mayoristas/ordenes-fraccionado/:id/lineas/:plu/cantidad', (req, res) => {
  const arr = leerJSON(ORD_FRACC_PATH, []);
  const i = arr.findIndex(o => String(o.id) === String(req.params.id));
  if (i < 0) return res.status(404).json({ error: 'Orden no encontrada' });
  const body = req.body || {};
  // Igual que en el PUT de arriba: fecha y hora las pone el server, del MISMO Date y en hora
  // local (con toISOString() una edición después de las 21:00 ART quedaría fechada al día siguiente).
  const ahora = new Date();
  const dosDig = n => String(n).padStart(2, '0');
  const { orden, error } = editarLineaOrden(arr[i], req.params.plu, {
    cantidad: body.cantidad,
    nota: body.nota,
    fecha: `${ahora.getFullYear()}-${dosDig(ahora.getMonth() + 1)}-${dosDig(ahora.getDate())}`,
    hora: `${dosDig(ahora.getHours())}:${dosDig(ahora.getMinutes())}`,
  });
  if (error) return res.status(400).json({ error });
  // Los totales cambian con la cantidad, así que se recalculan siempre acá y no en el módulo puro.
  arr[i] = { ...orden, actualizadoEn: ahora.getTime(),
             totales: totalesOrdenFraccionado(orden.lineas) };
  guardarJSON(ORD_FRACC_PATH, arr);
  res.json(conProgreso(arr[i]));
});

router.put('/api/mayoristas/ordenes-fraccionado/:id', (req, res) => {
  const arr = leerJSON(ORD_FRACC_PATH, []);
  const i = arr.findIndex(o => String(o.id) === String(req.params.id));
  if (i < 0) return res.status(404).json({ error: 'Orden no encontrada' });
  const cambios = req.body || {};
  const ESTADOS = ['pendiente', 'aplicada', 'anulada'];
  if (cambios.estado !== undefined && !ESTADOS.includes(cambios.estado)) {
    return res.status(400).json({ error: `Estado inválido: ${cambios.estado}` });
  }
  let lineas = arr[i].lineas;
  if (cambios.lineas !== undefined) {
    const error = validarLineasFraccionado(cambios.lineas);
    if (error) return res.status(400).json({ error });
    lineas = normalizarLineasFraccionado(cambios.lineas);
  }
  // id y fecha no se pisan desde el body: son la identidad de la orden. `progreso` se descarta
  // (JSON.stringify saltea undefined) para que el que devuelve el GET nunca termine persistido
  // si el cliente reenvía la orden entera.
  arr[i] = { ...arr[i], ...cambios, id: arr[i].id, fecha: arr[i].fecha,
             lineas, totales: totalesOrdenFraccionado(lineas), progreso: undefined };
  guardarJSON(ORD_FRACC_PATH, arr);
  res.json(conProgreso(arr[i]));
});

router.delete('/api/mayoristas/ordenes-fraccionado/:id', (req, res) => {
  const arr = leerJSON(ORD_FRACC_PATH, []);
  const nuevo = arr.filter(o => String(o.id) !== String(req.params.id));
  if (nuevo.length === arr.length) return res.status(404).json({ error: 'Orden no encontrada' });
  guardarJSON(ORD_FRACC_PATH, nuevo);
  res.json({ ok: true });
});

// ── Reservas de mercaderia mayorista ──────────────────────────────────────────
// Apartan producto TERMINADO en SiGA para un cliente: un movimiento del deposito principal al
// de reserva. A diferencia de la reserva de planificacion NO se explota formula. Una reserva
// es de UN cliente y sale en UN movimiento: por eso no existe la falla parcial.
// RESERVAS_MERC_PATH se queda en server.js —lo lee también el tablero de almacén— y entra por deps.

router.get('/api/mayoristas/reservas', apiRoute(async () =>
  leerJSON(RESERVAS_MERC_PATH, []).slice().sort((a, b) => b.id - a.id)));

// Saldos del deposito de reserva por producto. Se leen de SiGA, que es la verdad fisica: el
// deposito es uno solo y mezcla clientes, asi que un saldo "por reserva" seria un registro
// paralelo imposible de cuadrar contra facturaciones hechas fuera del sistema.
// Devuelve, por cada PLU con reserva mayorista viva, cuanto hay, cuanto esta comprometido y que
// ajuste dejaria el deposito en cero.
//
// OJO CON EL ORDEN: esta ruta va ANTES de `/:id`, o Express matchea "saldos" como un id y
// responde "Reserva no encontrada".
router.get('/api/mayoristas/reservas/saldos', apiRoute(async req => {
  const s = await resolverSucursal(req.query.idSucursal);
  if (s.error) return { error: s.error };
  const cr = s.cr;
  const depReserva = esIdDeposito(Number(req.query.depReserva))
    ? Number(req.query.depReserva) : cr.depositoReserva;
  if (!esIdDeposito(depReserva)) return { error: ERR_RESERVA_SIN_CONFIG };

  // Solo las reservas de ESTA sucursal y de ESTE deposito: los IDs de deposito son por sucursal,
  // asi que sin filtrar se compararia lo apartado en un lado contra el stock de otro.
  const vivas = leerJSON(RESERVAS_MERC_PATH, [])
    .filter(r => r && r.estado === 'activa'
              && Number(r.idSucursal) === cr.idSucursal
              && Number(r.depDestino) === depReserva);
  // Todos los PLU que alguna reserva viva nombra: el granel que aparto y el "X Pedido" que
  // espera. Se piden a SiGA de una sola vez y filasSaldoMayorista decide que hacer con cada uno.
  const plus = [...new Set(vivas.flatMap(r =>
    [String(r.pluCarga || ''), ...(r.lineas || []).map(l => String(l.plu || ''))]))]
    .filter(p => /^\d+$/.test(p));
  if (!plus.length) return { depReserva, idSucursal: cr.idSucursal, productos: [] };

  // stockDeComponentes ya arma el SELECT contra ProductosDepositos y sanea los PLU: el deposito
  // de reserva va como "origen" y no hay destino que mirar.
  const stock = await stockDeComponentes(cr, plus, depReserva, null);
  const asientosTodos = Object.values(leerJSON(PLANES_PATH, {})).flatMap(p => asientosProduccion(p));

  // Toda la regla (comprometido NETO, diferencia y ajuste) vive en el modulo puro, que es donde
  // se puede testear; aca solo queda el IO.
  return {
    depReserva, idSucursal: cr.idSucursal,
    productos: filasSaldoMayorista(vivas, asientosTodos,
      new Map(plus.map(p => [p, (stock.get(p) || { origen: 0 }).origen]))),
  };
}));

// Emite el ajuste que deja un producto del deposito de reserva en cero. Los cuatro tipos son
// traslados entre principal y reserva; la des-produccion (volver "X Pedido" a granel) NO va por
// aca porque cambia de producto: eso se registra como una produccion inversa desde la pantalla
// de produccion, con su propio comprobante.
// Va con (req, res) crudo y NO con apiRoute, por el mismo motivo que el POST de reservas:
// apiRoute no deja setear el status y los 400 de validacion saldrian como 200.
// Body: { idSucursal?, plu, tipo, cantidad, depReserva?, depPrincipal?, permitirFaltante? }
router.post('/api/mayoristas/reservas/ajuste', async (req, res) => {
  try {
    const b = req.body || {};
    // Los tipos son los que emite ajustePropuesto. Si se agrega uno alla y no aca, el front
    // muestra un boton que el servidor rechaza.
    const TIPOS = ['devolver-granel', 'devolver-pedido', 'reponer-granel', 'reponer-pedido'];
    if (!TIPOS.includes(b.tipo)) {
      return res.status(400).json({ error: `tipo invalido. Permitidos: ${TIPOS.join(', ')}` });
    }
    const plu = String(b.plu || '').trim();
    const cantidad = Number(b.cantidad);
    if (!plu) return res.status(400).json({ error: 'Falta plu' });
    // Los PLU de SiGA son numericos y este valor viaja al WHERE del stock y a la linea del
    // traslado: cualquier otra cosa se rechaza en vez de sanearse a un PLU distinto.
    if (!/^\d+$/.test(plu)) return res.status(400).json({ error: 'plu invalido: tiene que ser numerico' });
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      return res.status(400).json({ error: 'cantidad tiene que ser mayor a cero' });
    }

    const s = await resolverSucursal(b.idSucursal);
    if (s.error) return res.status(400).json({ error: s.error });
    const cr = s.cr;
    const depReserva   = esIdDeposito(Number(b.depReserva))   ? Number(b.depReserva)   : cr.depositoReserva;
    const depPrincipal = esIdDeposito(Number(b.depPrincipal)) ? Number(b.depPrincipal) : cr.depositoPrincipal;
    if (!esIdDeposito(depReserva) || !esIdDeposito(depPrincipal) || depReserva === depPrincipal) {
      return res.status(400).json({ error: ERR_RESERVA_DEPOSITOS });
    }

    // Los "reponer" van al reves que los "devolver": traen del principal a la reserva lo que
    // falta contra lo apartado, en vez de sacar de la reserva lo que sobra.
    const alReves = b.tipo === 'reponer-granel' || b.tipo === 'reponer-pedido';
    const depOrigen  = alReves ? depPrincipal : depReserva;
    const depDestino = alReves ? depReserva   : depPrincipal;

    const activos = new Set((await depositosActivos(cr.idSucursal)).map(d => Number(d.IdDeposito)));
    if (!activos.has(depOrigen) || !activos.has(depDestino)) {
      return res.status(400).json({ error: `Alguno de los depositos no esta activo en la sucursal ${cr.idSucursal}` });
    }

    // El saldo del origen se chequea ANTES de mover: sin esto, un ajuste con la cantidad
    // equivocada (o repetido dos veces por doble click) deja el deposito en negativo, que es
    // exactamente el descuadre que este endpoint existe para arreglar. Mismo criterio que el
    // POST de reservas: con permitirFaltante se emite igual, pero es una decision explicita.
    const stock = await stockDeComponentes(cr, [plu], depOrigen, null);
    const disponible = redondear4((stock.get(plu) || { origen: 0 }).origen);
    if (cantidad > disponible && b.permitirFaltante !== true) {
      return res.status(400).json({
        error: `El deposito ${depOrigen} tiene ${disponible} de ${plu} y el ajuste mueve ${redondear4(cantidad)}`,
        disponible, necesario: redondear4(cantidad),
      });
    }

    const observacion = `AJUSTE RESERVA MAY ${b.tipo} ${plu} ${depOrigen}>${depDestino}`.slice(0, 200);
    const movimiento = {
      idSucursal: cr.idSucursal, depOrigen, depDestino,
      idTipoMovimiento: cr.idTipoMovimiento, usuario: cr.usuario, idEmpleado: cr.idEmpleado,
      observacion,
    };
    const poolW = await getPoolStock();
    // 'ajuste' y no un origen nuevo: MOV_LOG_ORIGENES es la lista cerrada por la que filtra
    // GET /api/stock/movimientos, y un origen fuera de ella hace que el listado lo rechace.
    // Lo que identifica a estos comprobantes es la observacion.
    const r = await ejecutarYRegistrar({
      origen: 'ajuste', plan: null, itemId: null, ...movimiento,
      lineas: [{ plu, nombre: null, cantidad }],
    }, () => trasladarStock(poolW, { ...movimiento, lineas: [{ idProducto: plu, cantidad }] }));

    res.json(conLogError({ ok: true, numeroMovimiento: r.numeroMovimiento,
                           idRegistro: r.idRegistro ?? null }, r.logError));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/mayoristas/reservas/:id', (req, res) => {
  const reserva = leerJSON(RESERVAS_MERC_PATH, []).find(r => String(r.id) === String(req.params.id));
  if (!reserva) return res.status(404).json({ error: 'Reserva no encontrada' });
  res.json(reserva);
});

// POST: un cliente, un movimiento. El orden de operaciones esta pensado para que un error
// temprano no deje nada a medias: primero se valida TODO (cliente, lineas, depositos, choques,
// stock) y recien al final se toca SiGA y se escribe el archivo.
// Va con (req, res) crudo y NO con apiRoute: apiRoute hace `res.json(await fn(req))`, sin forma
// de setear el status, asi que los 400 de validacion y el 409 saldrian como 200. Mismo criterio
// que el CRUD de ordenes-fraccionado.
router.post('/api/mayoristas/reservas', async (req, res) => {
  try {
    const b = req.body || {};

    const errCliente = validarClienteReserva(b.idCliente, b.nombreCliente);
    if (errCliente) return res.status(400).json({ error: errCliente });
    const errLineas = validarLineasReserva(b.lineas);
    if (errLineas) return res.status(400).json({ error: errLineas });
    const errMezcla = validarCarritoUnCliente(b.lineas, b.idCliente);
    if (errMezcla) return res.status(400).json({ error: errMezcla });

    const s = await resolverSucursal(b.idSucursal);
    if (s.error) return res.status(400).json({ error: s.error });
    const cr = s.cr;

    // Un deposito que viene en el body pero es invalido NO cae al config: se avisa, para no
    // reservar en el lugar equivocado. Mismo criterio que POST /api/plan/:fecha/reservar.
    const vinoOrigen  = b.depOrigen  !== undefined && b.depOrigen  !== null && b.depOrigen  !== '';
    const vinoDestino = b.depDestino !== undefined && b.depDestino !== null && b.depDestino !== '';
    const depOrigen   = vinoOrigen  ? Number(b.depOrigen)  : cr.depositoPrincipal;
    const depDestino  = vinoDestino ? Number(b.depDestino) : cr.depositoReserva;
    if (!vinoDestino && !cr.depositoReserva) {
      return res.status(400).json({ error: ERR_RESERVA_SIN_CONFIG });
    }
    if (!esIdDeposito(depOrigen) || !esIdDeposito(depDestino) || depOrigen === depDestino) {
      return res.status(400).json({ error: ERR_RESERVA_DEPOSITOS });
    }
    const activos = new Set((await depositosActivos(cr.idSucursal)).map(d => Number(d.IdDeposito)));
    if (!activos.has(depOrigen)) {
      return res.status(400).json({ error: `El deposito de origen ${depOrigen} no existe o no esta activo en la sucursal ${cr.idSucursal}` });
    }
    if (!activos.has(depDestino)) {
      return res.status(400).json({ error: `El deposito de destino ${depDestino} no existe o no esta activo en la sucursal ${cr.idSucursal}` });
    }

    const lineas = normalizarLineasReserva(b.lineas);

    // Las lineas pesables se validan aparte: sin granel ni kg por unidad el traslado saldria
    // contra el intermedio "X Pedido", que no tiene stock propio.
    for (const l of (b.lineas || [])) {
      if (!l || !l.esPesable) continue;
      const errPesable = validarLineaPesable(l);
      if (errPesable) return res.status(400).json({ error: errPesable });
    }

    // Que se mueve en SiGA por cada linea. En venta directa es la linea misma; en pesables es
    // el granel en kg. `apartar` queda en paralelo a `lineas`: mismo indice, misma linea.
    const apartar = (b.lineas || []).map((cruda, i) => {
      const conv = lineaAApartar({ ...lineas[i], esPesable: !!(cruda && cruda.esPesable),
                                   pluGranel: cruda && cruda.pluGranel,
                                   nombreGranel: cruda && cruda.nombreGranel,
                                   kgPorUnidad: cruda && cruda.kgPorUnidad,
                                   unidades: cruda && cruda.unidades });
      return conv || { plu: lineas[i].plu, nombre: lineas[i].nombre, cantidad: lineas[i].cantidad };
    });

    // stockDeComponentes consulta ProductosDepositos por PLU, asi que sirve igual para
    // terminados y para componentes de formula: no sabe ni le importa que es cada uno.
    // Se suma por plu porque dos registros distintos pueden apartar el mismo componente y
    // el stock que hay que tener alcanza para los dos juntos, no para cada uno por separado.
    const stock = await stockDeComponentes(cr, apartar.map(a => a.plu), depOrigen, depDestino);
    const necesarioPorPlu = new Map();
    for (const a of apartar) necesarioPorPlu.set(a.plu, (necesarioPorPlu.get(a.plu) || 0) + a.cantidad);
    const faltantes = [...necesarioPorPlu.entries()].map(([plu, necesario]) => {
      const e = stock.get(plu) || { origen: 0, destino: 0 };
      const nombre = (apartar.find(a => a.plu === plu) || {}).nombre;
      return { plu, nombre, necesario: redondear4(necesario),
               stockOrigen: redondear4(e.origen), faltante: redondear4(Math.max(0, necesario - e.origen)) };
    }).filter(f => f.faltante > 0);
    // Con permitirFaltante se reserva igual la cantidad completa (el origen puede quedar en
    // negativo); sin el no se mueve nada.
    if (faltantes.length && b.permitirFaltante !== true) {
      return res.status(400).json({ error: 'Hay productos sin stock suficiente en el deposito de origen', faltantes });
    }

    // UN MOVIMIENTO POR REGISTRO: cada producto que el operador selecciono sale con su propio
    // comprobante de SiGA y su propia entrada en el archivo, para que cada uno se pueda anular
    // por separado. Si uno falla se corta ahi: lo ya emitido queda guardado y se informa cual
    // fallo, asi el operador reintenta solo eso en vez de duplicar lo que ya salio.
    const poolW = await getPoolStock();
    const arr = leerJSON(RESERVAS_MERC_PATH, []);
    const emitidas = [];
    let errorParcial = null;
    for (let i = 0; i < lineas.length; i++) {
      const l = lineas[i], a = apartar[i];
      const cruda = (b.lineas || [])[i] || {};
      const observacion = `RESERVA MAY ${b.nombreCliente} ${a.nombre} ${depOrigen}>${depDestino}`.slice(0, 200);
      const movimiento = {
        idSucursal: cr.idSucursal, depOrigen, depDestino,
        idTipoMovimiento: cr.idTipoMovimiento, usuario: cr.usuario, idEmpleado: cr.idEmpleado,
        observacion,
      };
      let r;
      try {
        r = await ejecutarYRegistrar({
          origen: 'reserva-mayorista', plan: null, itemId: null, ...movimiento,
          lineas: [{ plu: a.plu, nombre: a.nombre, cantidad: a.cantidad }],
        }, () => trasladarStock(poolW, {
          ...movimiento,
          lineas: [{ idProducto: a.plu, cantidad: a.cantidad }],
        }));
      } catch (e) {
        // Lo que se reporta es lo que SiGA rechazo (el granel/componente de `a`), no el
        // producto del pedido: el operador necesita saber que traslado fallo realmente.
        // `pluPedido` se deja de `l` como referencia de que registro del pedido es.
        errorParcial = { plu: a.plu, pluPedido: l.pluPedido, nombre: a.nombre, error: e.message };
        break;
      }
      emitidas.push(nuevaReserva({
        // El id lleva el indice: dos registros de la misma tanda caerian en el mismo Date.now().
        id: Date.now() * 100 + emitidas.length,
        fecha: new Date().toISOString(),
        idCliente: b.idCliente, nombreCliente: b.nombreCliente,
        idSucursal: cr.idSucursal, depOrigen, depDestino,
        numeroMovimiento: r.numeroMovimiento, idRegistro: r.idRegistro ?? null,
        usuario: cr.usuario,
        pluPedido: l.pluPedido, nombrePedido: l.nombrePedido,
        lineas: [{ plu: a.plu, nombre: a.nombre, cantidad: a.cantidad }],
        pluCarga: cruda.esPesable ? String(cruda.pluCarga || '') : null,
        nombreCarga: cruda.esPesable ? String(cruda.nombreCarga || '') : null,
        unidadesPedidas: cruda.esPesable ? Number(cruda.unidades) || 0 : null,
      }));
    }

    if (emitidas.length) {
      guardarJSON(RESERVAS_MERC_PATH, [...arr, ...emitidas]);
    }
    if (errorParcial) {
      // 207: parte salio y parte no. El frontend saca del carrito solo lo emitido.
      return res.status(emitidas.length ? 207 : 500).json({
        error: `No se pudo reservar ${errorParcial.nombre}: ${errorParcial.error}`,
        emitidas, fallo: errorParcial,
      });
    }
    res.json({ ok: true, emitidas });
  } catch (e) {
    // Error ANTES del primer movimiento (validacion, SiGA caido al pedir depositos): no se
    // escribio nada, el carrito del navegador queda intacto y reintentar es seguro. Los
    // errores a mitad de la tanda los maneja el 207 de arriba.
    res.status(500).json({ error: e.message });
  }
});

// Anular: el movimiento inverso, deposito de reserva -> principal, con las mismas lineas y un
// solo comprobante. La sucursal y los depositos salen de la reserva, NO del config ni del body:
// cambiar de sucursal en la pantalla no puede hacer que la devolucion mueva stock en otro lado.
router.post('/api/mayoristas/reservas/:id/anular', async (req, res) => {
  try {
    const arr = leerJSON(RESERVAS_MERC_PATH, []);
    const i = arr.findIndex(r => String(r.id) === String(req.params.id));
    if (i < 0) return res.status(404).json({ error: 'Reserva no encontrada' });
    const reserva = arr[i];
    if (reserva.estado === 'anulada') {
      return res.status(409).json({ error: `La reserva #${reserva.id} ya esta anulada` });
    }

    // Las lineas dicen lo apartado ORIGINAL (nunca se mutan): lo que la produccion ya consumio
    // no esta en el deposito de reserva y devolverlo seria inventar stock. Se devuelve solo el
    // restante, derivado de los asientos de produccion de TODAS las fechas, igual que la
    // conciliacion (una reserva vive varios dias). Los asientos viejos no traen el campo y se
    // leen como cero consumido: una reserva que nadie produjo se devuelve entera, como siempre.
    const asientosTodos = Object.values(leerJSON(PLANES_PATH, {})).flatMap(p => asientosProduccion(p));
    const lineasADevolver = lineasADevolverMayorista(reserva, asientosTodos);
    const apartado = redondear4((reserva.lineas || []).reduce((acc, l) => acc + (Number(l.cantidad) || 0), 0));
    const consumido = redondear4(apartado - lineasADevolver.reduce((acc, l) => acc + l.cantidad, 0));
    // El granel consumido no salio del edificio: la produccion lo convirtio en unidades de
    // "X Pedido" que estan en el MISMO deposito de reserva. Devolver solo el granel restante
    // dejaba ese terminado varado ahi, sin ninguna reserva viva que lo reclamara.
    const lineasTerminado = lineasTerminadoADevolverMayorista(reserva, asientosTodos);
    const entregado = redondear4(lineasTerminado.reduce((acc, l) => acc + l.cantidad, 0));

    const cr = cfgReserva();
    // Los terminados van a RECEPCION, no al origen de la reserva: son producto, no el granel
    // que salio del deposito principal. Sin depositoTerminados configurado no hay a donde
    // mandarlos y se avisa en vez de moverlos a ciegas.
    const depRecepcion = Number(cfgProduccion().depositoTerminados);
    const devuelveTerminado = lineasTerminado.length && esIdDeposito(depRecepcion);
    // Sin lineas no se toca SiGA: pedir el pool haria que una base caida impida anular una
    // reserva que justamente no necesita mover nada.
    const poolW = (lineasADevolver.length || devuelveTerminado) ? await getPoolStock() : null;
    const observacion = `ANULA RESERVA MAY ${reserva.nombreCliente} #${reserva.numeroMovimiento}`.slice(0, 200);
    const mov = {
      idSucursal: reserva.idSucursal, depOrigen: reserva.depDestino, depDestino: reserva.depOrigen,
      idTipoMovimiento: cr.idTipoMovimiento, usuario: cr.usuario, idEmpleado: cr.idEmpleado,
      observacion,
    };
    // Sin nada que devolver no se emite comprobante, pero la reserva IGUAL se anula: que el
    // cliente la haya dado de baja es un hecho aparte de donde termino el stock. Cortar con un
    // 409 dejaria una reserva viva que el operador no puede cerrar por ningun lado; lo que
    // quedo en el deposito de reserva se resuelve por el circuito de saldos, no por aca.
    const r = lineasADevolver.length ? await ejecutarYRegistrar({
      origen: 'devolucion', plan: null, itemId: null,
      ...mov,
      lineas: lineasADevolver.map(l => ({ plu: l.plu, nombre: l.nombre, cantidad: l.cantidad })),
    }, () => trasladarStock(poolW, {
      ...mov,
      lineas: lineasADevolver.map(l => ({ idProducto: l.plu, cantidad: l.cantidad })),
    })) : { numeroMovimiento: null, idRegistro: null, logError: null };

    // Segunda pata: el terminado que ya estaba en el deposito de reserva vuelve a recepcion.
    // Va en su propio comprobante porque el destino es otro (recepcion, no el origen de la
    // reserva). Si SiGA la rechaza NO se corta la anulacion: el granel ya volvio y dejar la
    // reserva viva no arregla nada; se informa para que el operador mueva esas unidades.
    const movT = {
      idSucursal: reserva.idSucursal, depOrigen: reserva.depDestino, depDestino: depRecepcion,
      idTipoMovimiento: cr.idTipoMovimiento, usuario: cr.usuario, idEmpleado: cr.idEmpleado,
      observacion: `ANULA RESERVA MAY TERM ${reserva.nombreCliente} #${reserva.numeroMovimiento}`.slice(0, 200),
    };
    let errorTerminado = null;
    if (devuelveTerminado) {
      try {
        await ejecutarYRegistrar({
          origen: 'devolucion', plan: null, itemId: null, ...movT,
          lineas: lineasTerminado.map(l => ({ plu: l.plu, nombre: l.nombre, cantidad: l.cantidad })),
        }, () => trasladarStock(poolW, {
          ...movT,
          lineas: lineasTerminado.map(l => ({ idProducto: l.plu, cantidad: l.cantidad })),
        }));
      } catch (e) { errorTerminado = e.message; }
    }

    const { reserva: anulada, error } = anularReserva(reserva, {
      numeroMovimiento: r.numeroMovimiento, idRegistro: r.idRegistro ?? null,
      fecha: new Date().toISOString(),
    });
    if (error) return res.status(409).json({ error });
    arr[i] = anulada;
    guardarJSON(RESERVAS_MERC_PATH, arr);
    // El aviso es solo de la respuesta (no se persiste): el operador tiene que enterarse de que
    // volvió menos de lo apartado, y por qué. Las dos patas se nombran por separado: el granel
    // se mide en kg y el terminado en unidades, y sumarlos bajo una sola etiqueta (como se hacía
    // antes) da un número que no significa nada.
    const partes = [];
    if (consumido > 0) {
      partes.push(`Volvieron ${redondear4(apartado - consumido)} de ${apartado} de lo apartado al depósito de origen: `
                + `la producción ya usó ${consumido} del depósito de reserva.`);
    }
    if (entregado > 0 && devuelveTerminado && !errorTerminado) {
      partes.push(`Esas ${entregado} unidad(es) de "${lineasTerminado[0].nombre || 'X Pedido'}" ya estaban producidas `
                + `y volvieron del depósito de reserva al de recepción (${depRecepcion}).`);
    } else if (entregado > 0) {
      partes.push(`ATENCIÓN: quedan ${entregado} unidad(es) de "${lineasTerminado[0].nombre || 'X Pedido'}" en el `
                + `depósito de reserva ${reserva.depDestino}` + (errorTerminado
                  ? `: SiGA rechazó el movimiento (${errorTerminado}).`
                  : ': no hay depósito de terminados configurado (produccion.depositoTerminados).')
                + ' Moverlas a mano.');
    }
    const aviso = partes.length ? partes.join(' ') : null;
    res.json(conLogError({ ...anulada, ...(aviso ? { aviso } : {}) }, r.logError));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

  return router;
};
