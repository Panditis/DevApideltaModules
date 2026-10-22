'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const bloquesTareas = require('../lib/bloques_tareas');
const planEnvio = require('../lib/plan_envio');
const { filtrarSucursalesReales, sqlExcluirSucursales } = require('../lib/sucursales_no_reales');
const { validarDiasObjetivo, resolverDiasObjetivo } = require('../lib/plan_params');

// ── Rutas de planificación ───────────────────────────────────────────────────
// Buscador de productos SIGA, recetas locales (formulas.json), responsables,
// sugerencias de producción del buscador manual (terminados), consumo/
// pendientes/BOM y packaging de planificación, clientes de registro rápido, y
// el CRUD de planes del día (ítems, agenda de bloques de tareas, calendario y
// envío a producción). Extraídas de server.js sin cambios de comportamiento:
// mismas rutas, mismo orden relativo y mismas queries. Los bloques movidos
// conservan la indentación original a propósito (hay template literals SQL
// multilínea y reindentar les cambiaría el texto).
//
// Lo que comparte vecindad o prefijo con planificación pero NO se movió, y por qué:
//   · GET /api/health, GET /api/config — infraestructura genérica (inicio.html
//     y otros), no del dominio planificación. Se quedan en el mismo banner de
//     donde salió este router.
//   · GET /api/diag/quiebre, /diag/ventas-test, /diag/plu-detalle — dominio
//     análisis de ventas (rutas_analisis.js), no planificación.
//   · GET /api/diag/consumo-grupo — dominio catálogo.
//   · GET /api/diag/estados-venta, /diag/categorias-clientes — huérfanas sin
//     dominio claro, se quedan donde estaban.
//   · GET /api/plan/:fecha/reserva*, POST /api/plan/:fecha/reservar|actualizar|
//     devolver — motor de reservas, entero en rutas_reservas.js: no es parte de
//     este corte. POST /api/plan/:fecha/envio y DELETE /api/plan/:fecha/item/:id
//     llaman a leerPlanReservas/leerOrdenes/guardarOrdenes: esas funciones siguen
//     enteras en server.js y se reciben por deps.
//
// Lo que SÍ se movió entero porque no tiene uso fuera de este router (confirmado
// con grep en server.js y en todos los rutas_*.js antes de mover):
//   · calcularSugerencias, con los sub-helpers que sólo ella usa: sqlConsumo,
//     sqlPendientes, sqlBOM (wrapper de sqlBOMGranel), RUBRO_MANUAL_EXCLUIDO_RE,
//     PRODUCTO_SAVONA_RE. La llama /api/plan/sugerencias (buscador manual), que
//     vive acá. El cálculo por catálogo lo reemplazó el
//     Tablero (rutas_plan_tablero.js, con los SQL builders de lib/plan_sql.js).
//   · FORMULAS_PATH, RESP_PATH, CLIENTES_PATH, PLANTILLAS_TAREAS_PATH — sin uso
//     en ningún otro rutas_*.js.
//   · bloquesTareas (bloques_tareas.js) pasa a requerirse directo acá: sólo lo
//     usaban las rutas de plantillas-tareas y /api/plan/:fecha/bloques.
//
// Lo que se queda en server.js y viaja por deps porque además lo usan otros
// routers ya extraídos: sqlStockTerminados/sqlStockGranel y
// sucursalesSiga/sucursalPublica (rutas_stock.js), sqlBOMGranel/FORMULA_ACTIVA_SQL/
// SIN_FORMULA_GENERICO_SQL (rutas_mayoristas.js), cfgGranelPlu/GRUPOS_CFG_PATH
// (rutas_catalogo.js), PROD_REG_PATH
// (rutas_distribucion.js/rutas_produccion.js/rutas_productividad.js),
// leerOrdenes/guardarOrdenes (rutas_produccion.js, y leerOrdenes también
// rutas_productividad.js), safeDate (varios), leerPlanReservas (rutas_stock.js) y tiposPackaging (además
// usada por el motor de reservas de stock, aplicarSeleccionPackaging).
module.exports = function crearRutasPlan(deps) {
  const {
    apiRoute, leerJSON, guardarJSON, query, DATA_DIR,
    PLANES_PATH, PROD_REG_PATH, GRUPOS_CFG_PATH,
    safeDate, leerPlanReservas,
    leerOrdenes, guardarOrdenes,
    tiposPackaging, FORMULA_ACTIVA_SQL, SIN_FORMULA_GENERICO_SQL,
    sqlStockTerminados, sqlStockGranel, sqlBOMGranel,
    cfgGranelPlu,
    sucursalesSiga, sucursalPublica,
  } = deps;
  const router = express.Router();

const RESP_PATH      = path.join(DATA_DIR, 'responsables.json');
const CLIENTES_PATH    = path.join(DATA_DIR, 'clientes.json');          // [{id,nombre}]
const FORMULAS_PATH  = path.join(DATA_DIR, 'formulas.json'); // { "plu": [{plu,nombre,cantPorUnidad}] }
// Parámetros compartidos de planificación (hoy: días a cubrir del sugerido). Ver lib/plan_params.js.
const PLAN_PARAMS_PATH = path.join(DATA_DIR, 'planificacion_params.json');
// Qué tareas lleva cada producto o rubro y cuánto dura cada una. Va en su propio archivo y no
// dentro del plan: las plantillas son la receta, valen para todos los días y no se pisan al
// cambiar de fecha.
const PLANTILLAS_TAREAS_PATH = path.join(DATA_DIR, 'plantillas_tareas.json');

  // Órdenes que producción ya empezó: no se pisan ni se borran desde planificación.
  const protegidaFn = () => {
    const trabajadas = new Set(leerJSON(PROD_REG_PATH, []).map(r => String(r && r.ordenId)).filter(v => v && v !== 'undefined'));
    return o => o.terminado === true || o.estado === 'listo' || trabajadas.has(String(o.id));
  };
  // Datos que construirOrdenes necesita y que en el front salían de globales.
  // ponytail: el código de granel sale del ítem o de grupos_config; el granelId del catálogo
  // (que el front miraba en gruposSorted) no se consulta — los ítems del carrito ya traen idGranel.
  const resolversOrdenes = () => {
    const gruposCfg = leerJSON(GRUPOS_CFG_PATH, {});
    const clientes = leerJSON(CLIENTES_PATH, []);
    return {
      codigoGranel: it => String(it.idGranel || it.granelId || cfgGranelPlu(gruposCfg, it.producto) || ''),
      requiereGranel: ref => { const v = gruposCfg[ref]; return !!(v && typeof v === 'object' && v.reqGranel === true); },
      nombreCliente: id => (clientes.find(c => String(c.id) === String(id)) || {}).nombre || '',
    };
  };
  const horaLocal = () => new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });

function sqlConsumo(ventana, rubros) {
  return `SELECT vp.IdProducto, SUM(vp.Cantidad) AS UnidVendidas,
       CAST(SUM(vp.Cantidad) AS DECIMAL(18,4)) / ${ventana} AS PromDiario
FROM VentasProductos vp
INNER JOIN Ventas v ON v.IdSucursal=vp.IdSucursal AND v.IdTipoComprobante=vp.IdTipoComprobante
  AND v.Letra=vp.Letra AND v.CentroEmisor=vp.CentroEmisor AND v.NumeroComprobante=vp.NumeroComprobante
INNER JOIN Sucursales s ON s.IdSucursal=v.IdSucursal
INNER JOIN Productos p ON p.IdProducto=vp.IdProducto
WHERE v.Fecha >= DATEADD(DAY,-${ventana},CAST(GETDATE() AS DATE)) AND v.Fecha < CAST(GETDATE() AS DATE)
  AND s.SoyLaCentral=1 AND ${sqlExcluirSucursales('v.IdSucursal')} AND ISNULL(v.IdEstadoComprobante,'') != 'ANULADO' ${rubros ? `AND p.IdRubro IN (${rubros})` : ''}
GROUP BY vp.IdProducto`;
}
function sqlPendientes() {
  return `SELECT pp.IdProducto, SUM(pp.CantPendiente) AS UnidPendientes
FROM PedidosProductos pp INNER JOIN Pedidos ped ON ped.IdSucursal=pp.IdSucursal AND ped.NumeroPedido=pp.NumeroPedido
WHERE pp.CantPendiente>0 AND ped.FechaPedido >= DATEADD(DAY,-7,CAST(GETDATE() AS DATE)) AND ${sqlExcluirSucursales('ped.IdSucursal')}
GROUP BY pp.IdProducto`;
}

function sqlBOM(rubros) {
  return sqlBOMGranel(rubros);
}

// Rubro que nunca aparece en el buscador manual del plan del día (bultos/cajas de almacén).
const RUBRO_MANUAL_EXCLUIDO_RE = /almacen\s*bultos\s*\/?\s*cajas/i;
// SAVONA son productos especiales: pasan por encima de la exclusion de rubro (igual que /api/productos/buscar).
const PRODUCTO_SAVONA_RE = /savona/i;

async function calcularSugerencias(params) {
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  const ventana = parseInt(params.ventana) || c.ventanaConsumoDias;
  const diasObj = parseInt(params.diasObjetivo) || c.diasObjetivo;
  const incStock = (typeof c.incidenciaStockPlanif === 'number') ? c.incidenciaStockPlanif : 1; // % del stock que cuenta en el sugerido
  const rubrosP = c.rubrosPlanificables.join(','), rubrosG = c.rubrosGranel.join(',');
  // Búsqueda manual del modal (params.q) trae TODOS los productos activos, no sólo
  // los rubros planificables (bulto/caja). El sembrado automático sigue acotado a rubrosP.
  const rubrosTerm = params.q ? null : rubrosP;

  const [terminados, consumo, pendientes, granel, bom] = await Promise.all([
    query(sqlStockTerminados(rubrosTerm)), query(sqlConsumo(ventana, rubrosTerm)),
    query(sqlPendientes()), query(sqlStockGranel(rubrosG)), query(sqlBOM(rubrosG))
  ]);

  const consumoMap = new Map(consumo.map(r    => [String(r.IdProducto), parseFloat(r.PromDiario)]));
  const pendMap    = new Map(pendientes.map(r => [String(r.IdProducto), parseFloat(r.UnidPendientes)]));
  const granelMap  = new Map(granel.map(r     => [String(r.IdProducto), parseFloat(r.StockGranel)]));
  const bomMap     = new Map();
  for (const b of bom) { const k = String(b.IdProducto); if (!bomMap.has(k)) bomMap.set(k, b); }

  const resultado = [];
  for (const t of terminados) {
    const id = String(t.IdProducto), prom = consumoMap.get(id) || 0, pend = pendMap.get(id) || 0;
    const stock = parseFloat(t.StockActual || 0), b = bomMap.get(id);
    const stockEfectivo = Math.round(stock * incStock * 100) / 100;
    const idGranel = b ? String(b.IdProductoComponente) : '', nombreGranel = b ? b.NombreComponente : '';
    const cantPU   = b ? parseFloat(b.CantPorUnidad || 0) : 0;
    let diasStock  = prom > 0 ? stock / prom : (stock > 0 ? Infinity : 0);
    const semaforo = diasStock < c.umbralRojo ? 'RED' : diasStock < c.umbralAmarillo ? 'YELLOW' : 'GREEN';
    let cantSugerida = 0;
    if (diasStock < c.minDiasParaSugerir || pend > 0) cantSugerida = Math.max(0, Math.ceil((prom * diasObj) - stockEfectivo + pend));
    const granelNec  = Math.round(cantSugerida * cantPU * 100) / 100;
    const granelDisp = idGranel ? (granelMap.get(idGranel) || 0) : null;
    const granelOk   = granelNec === 0 || granelDisp === null || granelDisp >= granelNec;
    const urgencia   = (isFinite(diasStock) ? -diasStock : 0) + (pend / Math.max(prom, 0.001))
                     + (semaforo === 'RED' ? 1000 : semaforo === 'YELLOW' ? 100 : 0) + (!granelOk ? 50 : 0);
    resultado.push({ idProducto: id, producto: t.NombreProducto, rubro: t.NombreRubro,
      stockActual: stock, promDiario: Math.round(prom * 100) / 100,
      diasStock: isFinite(diasStock) ? Math.round(diasStock * 10) / 10 : 9999,
      semaforo, pendientes: pend, cantSugerida, idGranel, nombreGranel, cantPorUnidad: cantPU,
      granelNecesario: granelNec, granelDisponible: granelDisp !== null ? Math.round(granelDisp * 100) / 100 : null,
      granelOk, urgencia });
  }
  resultado.sort((a, b) => b.urgencia - a.urgencia);
  let out = resultado;
  if (params.soloRojos === '1') out = out.filter(r => r.semaforo === 'RED');
  if (params.q) {
    const q = String(params.q).toLowerCase();
    // El buscador manual del plan del día no ofrece "Almacen Bultos/Cajas": no se producen por unidad.
    out = out.filter(r => PRODUCTO_SAVONA_RE.test(String(r.producto || '')) || !RUBRO_MANUAL_EXCLUIDO_RE.test(String(r.rubro || '')));
    out = out.filter(r => r.producto.toLowerCase().includes(q) || r.rubro.toLowerCase().includes(q));
  }
  return out;
}

router.get('/api/siga/buscar', apiRoute(async req => {
  const q = (req.query.q || '').trim().replace(/'/g, "''");
  if (q.length < 2) return [];
  const esNumero = /^\d+$/.test(q);
  const rows = await query(`
    SELECT TOP 30
      CAST(p.IdProducto AS VARCHAR) AS plu,
      p.NombreProducto AS producto,
      COALESCE(r.NombreRubro, '') AS rubro
    FROM Productos p
    LEFT JOIN Rubros r ON r.IdRubro = p.IdRubro
    WHERE p.Activo = 1
      AND (${esNumero ? `CAST(p.IdProducto AS VARCHAR) LIKE '${q}%'` : `p.NombreProducto LIKE '%${q}%'`})
    ORDER BY p.NombreProducto`);
  return rows;
}));

router.get('/api/formulas',          (_req, res) => res.json(leerJSON(FORMULAS_PATH, {})));
router.get('/api/formulas/:plu',     (req, res) => { const f = leerJSON(FORMULAS_PATH, {}); res.json(f[String(req.params.plu)] || []); });
router.post('/api/formulas/:plu',    (req, res) => { const f = leerJSON(FORMULAS_PATH, {}); const plu = String(req.params.plu); if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Se esperaba array' }); if (req.body.length) f[plu] = req.body; else delete f[plu]; guardarJSON(FORMULAS_PATH, f); res.json({ ok: true }); });
router.get('/api/responsables', (_req, res) => res.json(leerJSON(RESP_PATH, [])));
router.post('/api/responsables', (req, res) => { guardarJSON(RESP_PATH, req.body); res.json(req.body); });

// Detalle de stock por sucursal: presentaciones (depósitos de venta) + granel (depósitos LIKE %GRANEL%)
router.get('/api/plan/stock-detalle', apiRoute(async req => {
  const norm = s => String(s||'').split(',').map(x=>x.trim()).filter(Boolean);
  const plus = norm(req.query.plus), graneles = norm(req.query.graneles);
  const all = [...new Set([...plus, ...graneles])];
  if (!all.length) return { sucursales: [], presentaciones: [], graneles: [] };
  const quote = arr => arr.map(p => `'${String(p).replace(/'/g, "''")}'`).join(',');
  const [nombres, sucs] = await Promise.all([
    query(`SELECT CAST(IdProducto AS VARCHAR) AS IdProducto, NombreProducto FROM Productos WHERE CAST(IdProducto AS VARCHAR) IN (${quote(all)})`),
    sucursalesSiga(),
  ]);
  const nomMap = new Map(nombres.map(r => [String(r.IdProducto), r.NombreProducto]));
  const sucursales = filtrarSucursalesReales(sucs).map(sucursalPublica);
  // Granel: por PLU en todos los depósitos de la central, sin filtrar por nombre de depósito (el LIKE
  // '%GRANEL%' devuelve otra cosa: ningún depósito de Siga se llama así). Antes este endpoint usaba
  // el filtro viejo y el total del modal "detalle de stock" no coincidía con el de la tabla.
  const stockPorSuc = async (ids, soloGranel) => ids.length ? query(`
    SELECT CAST(pd.IdProducto AS VARCHAR) AS IdProducto, pd.IdSucursal, COALESCE(SUM(pd.Stock),0) AS Stock
    FROM ProductosDepositos pd
    INNER JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal
    INNER JOIN Sucursales s ON s.IdSucursal=sd.IdSucursal
    WHERE ${soloGranel ? `s.SoyLaCentral=1` : `sd.DisponibleVenta=1`}
      AND ${sqlExcluirSucursales('pd.IdSucursal')}
      AND CAST(pd.IdProducto AS VARCHAR) IN (${quote(ids)})
    GROUP BY pd.IdProducto, pd.IdSucursal`) : [];
  const [presRows, granRows] = await Promise.all([stockPorSuc(plus, false), stockPorSuc(graneles, true)]);
  const build = (ids, rows) => ids.map(plu => {
    const porSuc = {}; let total = 0;
    for (const r of rows) if (String(r.IdProducto) === plu) {
      const v = Math.round((parseFloat(r.Stock) || 0) * 100) / 100;
      porSuc[r.IdSucursal] = v; total += v;
    }
    return { plu, nombre: nomMap.get(plu) || plu, porSuc, total: Math.round(total * 100) / 100 };
  });
  return { sucursales, presentaciones: build(plus, presRows), graneles: build(graneles, granRows) };
}));
router.get('/api/consumo',          apiRoute(async req => { const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')); return query(sqlConsumo(parseInt(req.query.ventana) || c.ventanaConsumoDias, c.rubrosPlanificables.join(','))); }));
router.get('/api/pendientes',       apiRoute(async () => query(sqlPendientes())));
router.get('/api/bom',              apiRoute(async () => { const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')); return query(sqlBOM(c.rubrosGranel.join(','))); }));
router.get('/api/bom/producto/:plu', apiRoute(async req => {
  const plu = String(req.params.plu).replace(/\D/g, '');
  if (!plu) return [];
  return query(`
    SELECT pc.IdProductoComponente AS plu,
           p.NombreProducto        AS nombre,
           pc.Cantidad             AS cantPorUnidad
    FROM ProductosComponentes pc
    INNER JOIN Productos p ON p.IdProducto = pc.IdProductoComponente
    WHERE pc.IdProducto = ${plu} AND ${FORMULA_ACTIVA_SQL} AND ${SIN_FORMULA_GENERICO_SQL}
    ORDER BY p.NombreProducto`);
}));
router.get('/api/plan/sugerencias',        apiRoute(async req => calcularSugerencias(req.query)));
// Parámetros compartidos (todos los usuarios ven y usan el mismo). Va antes de /api/plan/:fecha.
const configPlan = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
router.get('/api/plan/params', (_req, res) => {
  res.json({ diasObjetivo: resolverDiasObjetivo(leerJSON(PLAN_PARAMS_PATH, {}), configPlan()) });
});
router.put('/api/plan/params', (req, res) => {
  const diasObjetivo = validarDiasObjetivo((req.body || {}).diasObjetivo);
  if (diasObjetivo === null) return res.status(400).json({ error: 'Los días a cubrir deben ser un número entero de 1 a 180' });
  guardarJSON(PLAN_PARAMS_PATH, { ...leerJSON(PLAN_PARAMS_PATH, {}), diasObjetivo });
  res.json({ diasObjetivo });
});
router.get('/api/plan/packaging', apiRoute(async req => {
  const plus = String(req.query.plus || '').split(',').map(s => s.replace(/\D/g, '')).filter(Boolean);
  if (!plus.length) return {};
  const rows = await query(`
    SELECT pc.IdProducto AS padre, pc.IdProductoComponente AS codigo,
           p.NombreProducto AS nombre, COALESCE(r.NombreRubro,'') AS rubro
    FROM ProductosComponentes pc
    INNER JOIN Productos p ON p.IdProducto = pc.IdProductoComponente
    LEFT  JOIN Rubros    r ON r.IdRubro   = p.IdRubro
    WHERE pc.IdProducto IN (${plus.join(',')}) AND ${FORMULA_ACTIVA_SQL} AND ${SIN_FORMULA_GENERICO_SQL}
    ORDER BY p.NombreProducto`);
  const out = {};
  for (const plu of plus) out[plu] = { envase: null, tapa: null };
  for (const r of rows) {
    const padre = String(r.padre);
    const t     = tiposPackaging(r.nombre, r.rubro);
    if (!out[padre]) out[padre] = { envase: null, tapa: null };
    const item = { codigo: String(r.codigo), nombre: String(r.nombre || '') };
    // Se queda con el primer componente que matchea de cada tipo y descarta los siguientes.
    // El else-if importa: un componente que matchea tapa pero llega con la tapa ya ocupada
    // cae a envase si también matchea esa regla (caso "Envase 1kg" con rubro "TAPAS").
    if      (!out[padre].tapa   && t.esTapa)   out[padre].tapa   = item;
    else if (!out[padre].envase && t.esEnvase) out[padre].envase = item;
  }
  return out;
}));
router.get('/api/clientes-registro', (_req, res) => res.json(leerJSON(CLIENTES_PATH, [])));
router.post('/api/clientes-registro', apiRoute(async req => {
  const nombre = ((req.body && req.body.nombre) || '').toString().trim();
  if (!nombre) return { error: 'Falta nombre' };
  const arr = leerJSON(CLIENTES_PATH, []);
  const id = Date.now();
  arr.push({ id, nombre });
  guardarJSON(CLIENTES_PATH, arr);
  return { ok: true, cliente: { id, nombre } };
}));
router.delete('/api/clientes-registro/:id', (req, res) => {
  const id = Number(req.params.id);
  guardarJSON(CLIENTES_PATH, leerJSON(CLIENTES_PATH, []).filter(x => x.id !== id));
  res.json({ ok: true });
});

router.get('/api/diag/bom-source', apiRoute(async () => {
  const [comp, tablaFormulas] = await Promise.all([
    query(`SELECT COUNT(*) AS Total FROM ProductosComponentes pc INNER JOIN Productos comp ON comp.IdProducto=pc.IdProductoComponente WHERE comp.IdRubro IN (22,23)`),
    query(`SELECT COUNT(*) AS Total FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='ProductosFormulas'`)
  ]);
  return { ProductosComponentes: comp[0].Total, tieneProductosFormulas: tablaFormulas[0].Total > 0 };
}));
// ── Planes ─────────────────────────────────────────────────────────────────────
// Con saneo de sellos: la UI dibuja el candado y deshabilita el ✕ mirando reservaMovimiento,
// así que tiene que ver lo mismo que la guarda de DELETE (anular).
router.get('/api/plan/:fecha', (req, res) => { const fecha = safeDate(req.params.fecha); const { plan } = leerPlanReservas(fecha); res.json(plan || { fecha, notas: '', items: [] }); });

// Envío del carrito a Producción del Día. Fusiona los ítems en el plan (un ítem por producto,
// con historial `envios`) y regenera desde el plan las órdenes de las claves tocadas. Lo que ya
// está en producción (orden protegida o ítem recepcionado) se omite y se informa.
// ponytail: planes.json y ordenes.json se escriben uno tras otro, sin transacción; un corte entre
// ambos deja el plan adelantado — reenviar el mismo día re-sincroniza las órdenes.
router.post('/api/plan/:fecha/envio', (req, res) => {
  const fecha = safeDate(req.params.fecha);
  const items = req.body && req.body.items;
  const notas = req.body && req.body.notas;
  const errores = planEnvio.validarItemsEnvio(items);
  if (notas != null && typeof notas !== 'string') errores.push('Las notas deben ser texto');
  if (errores.length) return res.status(400).json({ error: errores[0], errores });
  try {
    const { planes, plan } = leerPlanReservas(fecha);
    const ordenes = leerOrdenes();
    const protegida = protegidaFn();
    const bloqueadas = planEnvio.clavesBloqueadas(ordenes, plan, { fecha, protegida });
    // Clave de la orden que de verdad toca cada ítem: si el producto ya está en el plan manda el
    // rubro del ítem del plan (el merge lo conserva), no el que venga en el carrito.
    const clavesItems = planEnvio.clavesDeEnvio(plan, items);
    const aceptados = items.filter((_, i) => !bloqueadas.has(clavesItems[i]));
    const omitidos = items.filter((_, i) => bloqueadas.has(clavesItems[i])).map(it => it.producto);
    if (!aceptados.length) return res.status(409).json({ error: 'Todo lo enviado ya está en producción para ese día.', omitidos });
    const envioId = Date.now();
    const usuario = (req.session && req.session.user && req.session.user.usuario) || '';
    const nuevoPlan = planEnvio.fusionarEnvioEnPlan(plan, aceptados, { fecha, envioId, hora: horaLocal(), usuario, notas: notas || '' });
    const claves = new Set(clavesItems.filter(k => !bloqueadas.has(k)));
    const armadas = planEnvio.construirOrdenes(nuevoPlan.items.filter(it => claves.has(planEnvio.claveItem(it))),
      { fecha, ...resolversOrdenes() });
    const r = planEnvio.sincronizarOrdenes(ordenes, armadas, { fecha, claves, protegida });
    guardarJSON(PLANES_PATH, { ...planes, [fecha]: nuevoPlan });
    guardarOrdenes(r.ordenes);
    res.json({ ok: true, envioId, nuevas: r.nuevas, actualizadas: r.actualizadas, omitidos });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/api/plan/:fecha/notas', (req, res) => {
  const fecha = safeDate(req.params.fecha);
  const notas = req.body && req.body.notas;
  if (typeof notas !== 'string') return res.status(400).json({ error: 'Las notas deben ser texto' });
  const planes = leerJSON(PLANES_PATH, {});
  const prev = planes[fecha] || { fecha, creado: new Date().toISOString(), items: [] };
  guardarJSON(PLANES_PATH, { ...planes, [fecha]: { ...prev, notas } });
  res.json({ ok: true });
});

// ── Agenda de bloques de tareas ────────────────────────────────────────────────
// Plantillas: qué tareas lleva cada producto o rubro y cuánto dura cada una. Se guarda la
// lista entera de una: la edita un planificador por vez desde el modal, no hay concurrencia.
router.get('/api/plantillas-tareas', (_req, res) => res.json(leerJSON(PLANTILLAS_TAREAS_PATH, [])));

router.post('/api/plantillas-tareas', (req, res) => {
  // Se valida antes de tocar el disco: un body roto no puede dejar el archivo de recetas a
  // medias, porque después la agenda de todos los días se genera desde acá.
  const errores = bloquesTareas.validarPlantillas(req.body);
  if (errores.length) return res.status(400).json({ error: errores[0], errores });
  const lista = bloquesTareas.normalizarPlantillas(req.body);
  guardarJSON(PLANTILLAS_TAREAS_PATH, lista);
  res.json(lista);
});

// Los bloques viven dentro del plan del día, pero van por un endpoint aparte que sólo toca
// jornadaInicio y bloques: los items y el ledger de reservas quedan intactos aunque el
// navegador tenga un cache viejo.
router.post('/api/plan/:fecha/bloques', (req, res) => {
  const fecha = safeDate(req.params.fecha);
  const errores = bloquesTareas.validarBloquesBody(req.body);
  if (errores.length) return res.status(400).json({ error: errores[0], errores });
  const planes = leerJSON(PLANES_PATH, {});
  const prev = planes[fecha];
  // Sin plan del día no hay items contra los que colgar los bloques: crear el plan acá dejaría
  // una agenda huérfana que no se ve en ninguna pantalla.
  if (!prev) return res.status(404).json({ error: 'No hay plan cargado para esa fecha.' });
  // Una jornadaInicio ausente o vacía no borra la que ya estaba guardada: el front puede mandar
  // sólo los bloques y el arranque del día se conserva.
  const jornadaInicio = bloquesTareas.minutosDeHora(req.body.jornadaInicio) == null
    ? (prev.jornadaInicio || '08:00')
    : String(req.body.jornadaInicio).trim();
  planes[fecha] = { ...prev, jornadaInicio, bloques: bloquesTareas.normalizarBloques(req.body.bloques) };
  guardarJSON(PLANES_PATH, planes);
  res.json({ jornadaInicio, bloques: planes[fecha].bloques });
});

// Anular: saca el ítem del plan y regenera su orden (fraccionado pierde la presentación; granel
// o última presentación del rubro borran la orden). Bloqueado si producción ya lo tomó.
router.delete('/api/plan/:fecha/item/:id', (req, res) => {
  const fecha = safeDate(req.params.fecha), id = String(req.params.id);
  try {
    // leerPlanReservas suelta de paso los sellos huérfanos (movimiento ya revertido).
    const { planes, plan } = leerPlanReservas(fecha);
    if (!plan) return res.status(404).json({ error: 'Plan no encontrado' });
    const item = (plan.items || []).find(it => String(it.id) === id);
    if (!item) return res.status(404).json({ error: 'Ítem no encontrado' });
    if (item.produccionMovimiento && item.produccionMovimiento.numeroMovimiento != null) {
      return res.status(409).json({ error: `Ya fue producido (movimiento #${item.produccionMovimiento.numeroMovimiento}): no se puede anular.` });
    }
    if (item.reservaMovimiento && item.reservaMovimiento.numeroMovimiento != null) {
      return res.status(409).json({ error: `Está reservado (movimiento #${item.reservaMovimiento.numeroMovimiento}). Anulá esa reserva primero.` });
    }
    const ordenes = leerOrdenes();
    const protegida = protegidaFn();
    const clave = planEnvio.claveItem(item);
    if (planEnvio.clavesBloqueadas(ordenes, plan, { fecha, protegida }).has(clave)) {
      return res.status(409).json({ error: 'Producción ya empezó esa orden: no se puede anular desde planificación.' });
    }
    const items = plan.items.filter(it => String(it.id) !== id);
    const claves = new Set([clave]);
    const armadas = planEnvio.construirOrdenes(items.filter(it => planEnvio.claveItem(it) === clave), { fecha, ...resolversOrdenes() });
    // soloExistentes: anular nunca crea órdenes (si la del día ya no está, no se resucita).
    const r = planEnvio.sincronizarOrdenes(ordenes, armadas, { fecha, claves, protegida, soloExistentes: true });
    guardarJSON(PLANES_PATH, { ...planes, [fecha]: { ...plan, items } });
    guardarOrdenes(r.ordenes);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.get('/api/calendario', (req, res) => {
  const desde = safeDate(req.query.desde), dias = Math.min(parseInt(req.query.dias) || 7, 42);
  const planes = leerJSON(PLANES_PATH, {}), result = {}, base = new Date(desde + 'T00:00:00');
  for (let i = 0; i < dias; i++) {
    const d = new Date(base); d.setDate(d.getDate() + i);
    const f = d.toISOString().slice(0, 10), plan = planes[f] || { items: [] };
    result[f] = { totalItems: plan.items.length, totalUnidades: plan.items.reduce((s, it) => s + (it.cantConfirmada ?? it.cantSugerida ?? 0), 0), tieneRiesgoGranel: plan.items.some(it => it.granelOk === false), items: plan.items };
  }
  res.json(result);
});

  return router;
};
