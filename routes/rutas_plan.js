'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const bloquesTareas = require('../lib/bloques_tareas');
const planEnvio = require('../lib/plan_envio');
const { puntajePrioridad, clasesABC, umbralDeClase, nivelUrgencia, compararUrgencia, calcularCobertura, urgenciaGrupoPorPeso, umbralPesoGrupo } = require('../lib/plan_prioridad');
const { SUCURSALES_NO_REALES, filtrarSucursalesReales, sqlExcluirSucursales, sqlExcluirCentral } = require('../lib/sucursales_no_reales');
const { validarDiasObjetivo, resolverDiasObjetivo } = require('../lib/plan_params');
const { esMayorista } = require('../lib/catalogo_presentaciones');

// ── Rutas de planificación ───────────────────────────────────────────────────
// Buscador de productos SIGA, recetas locales (formulas.json), responsables,
// cálculo de sugerencias de producción (terminados y catálogo), consumo/
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
//   · calcularSugerencias y calcularSugerenciasCatalogo, con los sub-helpers que
//     sólo ellas usan: sqlConsumo, sqlPendientes, sqlBOM (wrapper de
//     sqlBOMGranel), pesoEnKg, sqlVentasCatalogo, sqlStockTodosDepositos,
//     sqlStockSucursales, sqlPendientesPorPlu,
//     sqlBOMPorPlu, RUBRO_MANUAL_EXCLUIDO_RE, PRODUCTO_SAVONA_RE. Las llaman
//     /api/plan/sugerencias* (antes también /api/plan/:fecha/desde-sugerencias*,
//     ya eliminadas), que viven acá, así que no hay acoplamiento cruzado.
//   · FORMULAS_PATH, RESP_PATH, CLIENTES_PATH, PLANTILLAS_TAREAS_PATH — sin uso
//     en ningún otro rutas_*.js.
//   · bloquesTareas (bloques_tareas.js) pasa a requerirse directo acá: sólo lo
//     usaban las rutas de plantillas-tareas y /api/plan/:fecha/bloques.
//
// Lo que se queda en server.js y viaja por deps porque además lo usan otros
// routers ya extraídos: sqlStockTerminados/sqlStockGranel/sqlStockPorPlu y
// sucursalesSiga/sucursalPublica (rutas_stock.js, y sqlStockPorPlu también
// rutas_compras.js), sqlBOMGranel/FORMULA_ACTIVA_SQL/SIN_FORMULA_GENERICO_SQL
// (rutas_mayoristas.js), buildCatalogoMaps/cfgActivo/cfgGranelPlu/cfgEsGranel/
// CATALOGO_PATH/GRUPOS_CFG_PATH (rutas_catalogo.js), PROD_REG_PATH
// (rutas_distribucion.js/rutas_produccion.js/rutas_productividad.js),
// leerOrdenes/guardarOrdenes (rutas_produccion.js, y leerOrdenes también
// rutas_productividad.js), safeDate (varios), leerPlanReservas (rutas_stock.js) y tiposPackaging (además
// usada por el motor de reservas de stock, aplicarSeleccionPackaging).
module.exports = function crearRutasPlan(deps) {
  const {
    apiRoute, leerJSON, guardarJSON, query, DATA_DIR,
    PLANES_PATH, PROD_REG_PATH, CATALOGO_PATH, GRUPOS_CFG_PATH,
    safeDate, leerPlanReservas,
    leerOrdenes, guardarOrdenes,
    tiposPackaging, FORMULA_ACTIVA_SQL, SIN_FORMULA_GENERICO_SQL,
    sqlStockTerminados, sqlStockGranel, sqlBOMGranel, sqlStockPorPlu,
    buildCatalogoMaps, cfgActivo, cfgGranelPlu, cfgGranelPlus, cfgEsGranel, cfgVentaPorUnidad, cfgGranelesUnidad,
    sucursalesSiga, sucursalPublica,
    CONFIG_PATH = path.join(__dirname, '..', 'config.json'), // los tests pasan uno propio
  } = deps;
  const router = express.Router();
  const cacheVentas = new Map(); // ventas del catálogo por día (ver ventasDeCanal en calcularSugerenciasCatalogo)

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

function pesoEnKg(presentacion) {
  const m = String(presentacion).match(/(\d+(?:[.,]\d+)?)\s*(G|g|Kg|kg|KG)\b/);
  if (!m) return null;
  return m[2].toLowerCase() === 'g' ? parseFloat(m[1].replace(',', '.')) / 1000 : parseFloat(m[1].replace(',', '.'));
}
// Canal de las ventas del catálogo. Minoristas: sucursales reales, sin Casa Central ni clientes de
// categoría SUCURSAL. Mayoristas: lo que Casa Central le vende a clientes de categoría MAYORISTA.
function filtroCanalSql(mayorista) {
  return mayorista
    ? `v.IdSucursal IN (SELECT IdSucursal FROM Sucursales WHERE SoyLaCentral=1) AND UPPER(ISNULL(cat.NombreCategoria,'')) = 'MAYORISTA'`
    : `${sqlExcluirCentral('v.IdSucursal')} AND UPPER(ISNULL(cat.NombreCategoria,'')) != 'SUCURSAL'`;
}
// Ventas del catálogo por PLU y canal en una sola pasada: unidades, días con venta y facturación.
// DiasConVenta sirve de denominador cuando el granel está en quiebre (ver consumoBasePorDia).
function sqlVentasCatalogo(pluList, ventana, mayorista) {
  return `SELECT vp.IdProducto,
       SUM(vp.Cantidad) AS UnidVendidas,
       COUNT(DISTINCT CAST(v.Fecha AS DATE)) AS DiasConVenta,
       SUM(vp.ImporteTotal) AS TotalFacturado
FROM VentasProductos vp INNER JOIN Ventas v ON v.IdSucursal=vp.IdSucursal AND v.IdTipoComprobante=vp.IdTipoComprobante
  AND v.Letra=vp.Letra AND v.CentroEmisor=vp.CentroEmisor AND v.NumeroComprobante=vp.NumeroComprobante
LEFT  JOIN Clientes c ON c.IdCliente=v.IdCliente LEFT  JOIN Categorias cat ON cat.IdCategoria=c.IdCategoria
WHERE v.Fecha >= DATEADD(DAY,-${ventana},CAST(GETDATE() AS DATE)) AND v.Fecha < CAST(GETDATE() AS DATE)
  AND ${sqlExcluirSucursales('v.IdSucursal')} AND ${filtroCanalSql(mayorista)}
  AND ISNULL(v.IdEstadoComprobante,'') != 'ANULADO'
  AND vp.IdProducto IN (${pluList.join(',')}) GROUP BY vp.IdProducto`;
}

function sqlStockTodosDepositos(pluList) {
  return `SELECT pd.IdProducto, COALESCE(SUM(pd.Stock),0) AS StockActual FROM ProductosDepositos pd
INNER JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal
INNER JOIN Sucursales s ON s.IdSucursal=pd.IdSucursal
WHERE s.SoyLaCentral=1 AND ${sqlExcluirSucursales('pd.IdSucursal')} AND pd.IdProducto IN (${pluList.join(',')}) GROUP BY pd.IdProducto`;
}
function sqlStockSucursales(pluList) {
  // Stock en sucursales (todas menos Casa Central): SoyLaCentral=0
  return `SELECT pd.IdProducto, COALESCE(SUM(pd.Stock),0) AS StockActual FROM ProductosDepositos pd
INNER JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal
INNER JOIN Sucursales s ON s.IdSucursal=pd.IdSucursal
WHERE s.SoyLaCentral=0 AND ${sqlExcluirSucursales('pd.IdSucursal')} AND sd.DisponibleVenta=1 AND pd.IdProducto IN (${pluList.join(',')}) GROUP BY pd.IdProducto`;
}
function sqlPendientesPorPlu(pluList) {
  return `SELECT pp.IdProducto, SUM(pp.CantPendiente) AS UnidPendientes FROM PedidosProductos pp
INNER JOIN Pedidos ped ON ped.IdSucursal=pp.IdSucursal AND ped.NumeroPedido=pp.NumeroPedido
WHERE pp.CantPendiente>0 AND ped.FechaPedido >= DATEADD(DAY,-7,CAST(GETDATE() AS DATE))
  AND ${sqlExcluirSucursales('ped.IdSucursal')}
  AND pp.IdProducto IN (${pluList.join(',')}) GROUP BY pp.IdProducto`;
}
function sqlBOMPorPlu(pluList, rubrosG) {
  return sqlBOMGranel(rubrosG, `\n  AND pc.IdProducto IN (${pluList.join(',')})`);
}

async function calcularSugerenciasCatalogo(params) {
  const catalogoCompleto = leerJSON(CATALOGO_PATH, []);
  if (!catalogoCompleto.length) throw new Error('Catálogo vacío. Importar Excel desde planificación.');
  const gruposCfg = leerJSON(GRUPOS_CFG_PATH, {});
  const catalogo  = catalogoCompleto.filter(item => cfgActivo(gruposCfg, item.productoRef));
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const ventana = parseInt(params.ventana) || c.ventanaConsumoDias;
  const diasObj = parseInt(params.diasObjetivo) || resolverDiasObjetivo(leerJSON(PLAN_PARAMS_PATH, {}), c);
  const incStock = (typeof c.incidenciaStockPlanif === 'number') ? c.incidenciaStockPlanif : 1; // % del stock que cuenta en el sugerido (0.6 = 60%)
  const rubrosG = c.rubrosGranel.join(',');
  const { pluToBase, baseMap, refMap } = buildCatalogoMaps(catalogo);
  const todosLosPlu = catalogo.map(i => String(i.plu));
  const pluMetaMap = new Map(catalogo.map(i => [String(i.plu), i]));
  // Las ventas de los mayoristas salen de otra query (Casa Central → clientes MAYORISTA): se separan los PLUs.
  const plusMayoristas = [...pluMetaMap.keys()].filter(p => esMayorista(pluMetaMap.get(p)));
  const plusMinoristas = [...pluMetaMap.keys()].filter(p => !esMayorista(pluMetaMap.get(p)));
  async function queryEnLotes(sqlFn, plus = todosLosPlu) {
    const LOTE = 1000;
    if (!plus.length) return []; // IN () vacío es SQL inválido
    if (plus.length <= LOTE) return query(sqlFn(plus));
    const res = [];
    for (let i = 0; i < plus.length; i += LOTE) res.push(...await query(sqlFn(plus.slice(i, i + LOTE))));
    return res;
  }
  // Las ventas van hasta ayer (v.Fecha < hoy): en el día no cambian, se cachean por día/ventana/canal/PLUs.
  // ponytail: caché en memoria del proceso, sin tope; se vacía al cambiar el día o reiniciar el server.
  const ventasDeCanal = mayorista => {
    const plus = mayorista ? plusMayoristas : plusMinoristas;
    const hoy = new Date().toLocaleDateString('sv');
    const clave = `${hoy}|${ventana}|${mayorista}|${plus.join(',')}`;
    for (const k of cacheVentas.keys()) if (!k.startsWith(hoy + '|')) cacheVentas.delete(k);
    if (!cacheVentas.has(clave)) {
      const p = queryEnLotes(l => sqlVentasCatalogo(l, ventana, mayorista), plus);
      p.catch(() => cacheVentas.delete(clave)); // un error no queda cacheado
      cacheVentas.set(clave, p);
    }
    return cacheVentas.get(clave);
  };
  const ventasPorCanal = async () => (await Promise.all([ventasDeCanal(false), ventasDeCanal(true)])).flat();
  // PLUs de granel asignados manualmente en grupos_config. Un grupo puede tener más de uno (ej.
  // Yogurt Batido: 2 graneles previos a fabricar) — se traen todos, no solo el primero.
  const customGranelPlus = [...new Set(Object.keys(gruposCfg).flatMap(r=>cfgGranelPlus(gruposCfg,r)))];
  const quotedGP = customGranelPlus.map(p => `'${p}'`).join(',');
  const [ventasRows, pendientesRows, stockRows, stockTodosRows, stockSucRows, bomRows, granelRows, customGranelNomRows] = await Promise.all([
    ventasPorCanal(), queryEnLotes(l => sqlPendientesPorPlu(l)),
    queryEnLotes(l => sqlStockPorPlu(l)), queryEnLotes(l => sqlStockTodosDepositos(l)),
    queryEnLotes(l => sqlStockSucursales(l)),
    queryEnLotes(l => sqlBOMPorPlu(l, rubrosG)), query(sqlStockGranel(rubrosG)),
    customGranelPlus.length ? query(`SELECT CAST(IdProducto AS VARCHAR) AS IdProducto, NombreProducto FROM Productos WHERE CAST(IdProducto AS VARCHAR) IN (${quotedGP})`) : Promise.resolve([]),
  ]);
  const consumoRows = ventasRows, facturRows = ventasRows;
  // Por PLU guardamos total vendido y días con venta. El denominador se decide por grupo:
  // ÷ventana (demanda real) por defecto; ÷días-con-venta solo si el granel del grupo está sin stock (quiebre).
  const consumoTotalRaw = new Map(consumoRows.map(r => [String(r.IdProducto), parseFloat(r.UnidVendidas) || 0]));
  const consumoDiasRaw  = new Map(consumoRows.map(r => [String(r.IdProducto), parseInt(r.DiasConVenta) || 0]));
  const pendRaw    = new Map(pendientesRows.map(r => [String(r.IdProducto), parseFloat(r.UnidPendientes)]));
  const stockRaw   = new Map(stockRows.map(r => [String(r.IdProducto), parseFloat(r.StockActual)]));
  const stockTodosRaw = new Map(stockTodosRows.map(r => [String(r.IdProducto), parseFloat(r.StockActual)]));
  const stockSucRaw   = new Map(stockSucRows.map(r => [String(r.IdProducto), parseFloat(r.StockActual)]));
  const bomRaw     = new Map();
  for (const b of bomRows) { const k = String(b.IdProducto); if (!bomRaw.has(k)) bomRaw.set(k, b); }
  // Stock del granel: se suman todos los depósitos de la central, sin filtrar por nombre de
  // depósito. El LIKE '%GRANEL%' de sqlStockGranel devuelve siempre 0 (ningún depósito de Siga se
  // llama así), así que ese valor solo sirve de fallback. El granel ya es un producto propio
  // ("X DEPOSITO GRANEL"): alcanza con acotar por PLU, igual que fraccionado y pesables.
  const granelMap  = new Map(granelRows.map(r => [String(r.IdProducto), parseFloat(r.StockGranel)]));
  const granelPlusUsados = [...new Set([...customGranelPlus, ...bomRows.map(b => String(b.IdProductoComponente))])].filter(p => /^\d+$/.test(p));
  for (let i = 0; i < granelPlusUsados.length; i += 1000) {
    const rows = await query(sqlStockTodosDepositos(granelPlusUsados.slice(i, i + 1000)));
    for (const r of rows) granelMap.set(String(r.IdProducto), parseFloat(r.StockActual) || 0);
  }
  const customGranelNomMap = new Map(customGranelNomRows.map(r=>[String(r.IdProducto), r.NombreProducto]));
  const facturRaw = new Map(facturRows.map(r => [String(r.IdProducto), parseFloat(r.TotalFacturado) || 0]));
  // Mayoristas ≤200g de grupos NO enKg (mixes/FS): Cantidad SQL en unidades → convertir a kg
  // (regla de las viejas variantes pack/bulto, se conserva para no mover los grupos granel)
  const enKgRefIds = new Set([...refMap.entries()].filter(([,ri]) => (c.gruposGranelEnKg||[]).includes(ri.productoRef)).map(([id]) => id));
  // Grupos granel "x unidad" (grupos_config.ventaPorUnidad, ej. pepas: la masa es por kilo y las
  // presentaciones se venden por unidad): ventas, pendientes y stock de cada código pasan a kg con el
  // peso de su presentación — o del nombre del primer minorista si la presentación no lo dice. Los
  // mayoristas usan ese mismo peso (1 a 1). base → kg por unidad; null = sin peso, no se convierte.
  const pesoUnidadBase = new Map();
  for (const [base, bInfo] of baseMap) {
    if (!cfgVentaPorUnidad(gruposCfg, bInfo.productoRef) || !cfgEsGranel(gruposCfg, bInfo.productoRef, c.gruposGranel)) continue;
    pesoUnidadBase.set(base, pesoEnKg(bInfo.presentacion) ?? pesoEnKg(bInfo.baseNombre || ''));
  }
  // Mayoristas "x unidad" (catalogo.ventaPorUnidad del código) en grupos granel por kilo (ej. un Mix:
  // los minoristas van por kg y un mayorista es una bolsa cerrada que se vende por unidad): sus ventas
  // y pendientes pasan a kg con el peso del nombre del código, o de la presentación, o del primer
  // minorista. Sin peso no se convierte (se avisa). En un grupo x unidad ya convierte el peso del grupo.
  const mayUnidadBase = new Map();   // base → [{ plu, unidadesVentana, pesoKg }] (desglose del modal de urgencia)
  const consumoBaseVentana = new Map(), consumoBasePorDia = new Map(), unidadesBaseVentana = new Map();
  const consumoMayVentana = new Map(); // base → venta diaria (÷ventana) de los mayoristas: desglose del total, no entra en ningún cálculo
  const stockBase = new Map(), stockUnidBase = new Map(), stockBaseAll = new Map(), stockSucBase = new Map(), pendBase = new Map(), facturBase = new Map();
  for (const [plu, base] of pluToBase) {
    let total = consumoTotalRaw.get(plu) || 0;
    const dias = consumoDiasRaw.get(plu) || 0;
    const meta  = pluMetaMap.get(plu);
    const bInfo = baseMap.get(base);
    const esMay = esMayorista(meta);
    const porUnidad = pesoUnidadBase.has(base);
    const mayUnidad = esMay && meta.ventaPorUnidad === true && !porUnidad && cfgEsGranel(gruposCfg, bInfo.productoRef, c.gruposGranel);
    const pesoMay = mayUnidad ? (pesoEnKg(meta.producto || '') ?? pesoEnKg(bInfo.presentacion) ?? pesoEnKg(bInfo.baseNombre || '')) : null;
    if (mayUnidad) mayUnidadBase.set(base, [...(mayUnidadBase.get(base) || []), { plu, unidadesVentana: Math.round(total * 100) / 100, pesoKg: pesoMay }]);
    const peso = porUnidad ? pesoUnidadBase.get(base) : pesoMay;   // null/undefined = no se convierte
    const kg = n => (peso ? n * peso : n);
    // Con "x unidad" (del grupo o del código) la conversión ya la hace kg(): la regla vieja convertiría dos veces.
    let wVieja = 1;
    if (esMay && bInfo && !enKgRefIds.has(bInfo.refId) && !porUnidad && !mayUnidad) {
      const w = pesoEnKg(meta.presentacion);
      if (w !== null && w <= 0.2) wVieja = w;
    }
    total = total * wVieja;
    if (porUnidad) unidadesBaseVentana.set(base, (unidadesBaseVentana.get(base) || 0) + total);
    total = kg(total);
    const rateVentana = ventana > 0 ? total / ventana : 0;   // demanda real diaria
    const ratePorDia  = dias    > 0 ? total / dias    : 0;   // intensidad (días que vendió)
    consumoBaseVentana.set(base, (consumoBaseVentana.get(base) || 0) + rateVentana);
    consumoBasePorDia.set(base,  (consumoBasePorDia.get(base)  || 0) + ratePorDia);
    if (esMay) consumoMayVentana.set(base, (consumoMayVentana.get(base) || 0) + rateVentana);
    // Stock de los minoristas. Los mayoristas no suman stock, salvo en una presentación mayorista (sin
    // minoristas): ahí cuenta su stock de Casa Central, convertido igual que sus ventas; el de sucursales no.
    const sumaStock = !esMay || bInfo.esMayorista;
    const stockKg = raw => (sumaStock ? kg((raw.get(plu) || 0) * wVieja) : 0);
    pendBase.set(base,     (pendBase.get(base)     || 0) + kg(pendRaw.get(plu)         || 0));
    stockBase.set(base,    (stockBase.get(base)    || 0) + stockKg(stockRaw));
    stockUnidBase.set(base, (stockUnidBase.get(base) || 0) + (sumaStock ? (stockRaw.get(plu) || 0) : 0)); // sin pasar a kg (modal de stock central)
    stockBaseAll.set(base, (stockBaseAll.get(base) || 0) + stockKg(stockTodosRaw));
    stockSucBase.set(base, (stockSucBase.get(base) || 0) + (esMay ? 0 : kg(stockSucRaw.get(plu)   || 0)));
    facturBase.set(base,   (facturBase.get(base)   || 0) + (facturRaw.get(plu)       || 0));
  }
  // Granel del grupo: solo los PLUs cargados a mano en el catálogo (grupos_config.granelPlu/s)
  // cuentan como "el granel" del grupo (uno o más: Yogurt Batido tiene 2 graneles previos a
  // fabricar). Sin eso, el grupo no lleva granel y no muestra ningún valor — no hay fallback a la
  // fórmula (BOM): cualquier componente con stock granel propio calificaba como "el granel" aunque
  // fuera un saborizante menor (ej. "Canela En Polvo" en Miel Canela, 0.0042 por unidad).
  // enUnidades (grupos_config.granelesUnidad): el stock de ese granel está en unidades; solo cambia cómo se muestra.
  function resolverGranelGrupo(refInfo) {
    const enUnidades = new Set(cfgGranelesUnidad(gruposCfg, refInfo.productoRef));
    return cfgGranelPlus(gruposCfg, refInfo.productoRef).map(id => ({ id, nombre: customGranelNomMap.get(id) || id, enUnidades: enUnidades.has(id) }));
  }
  const grupos = [];
  for (const [refId, refInfo] of refMap) {
    // Stock del granel del grupo (se necesita ANTES de calcular consumo para elegir denominador)
    const esGranelCheck = cfgEsGranel(gruposCfg, refInfo.productoRef, c.gruposGranel);
    let granelStockGrupo = 0, nombreGranelGrupo = '', granelIdGrupo = '';
    // Uno o más graneles del grupo (ej. Yogurt Batido: 2 graneles previos a fabricar). Los campos
    // granelStockGrupo/nombreGranelGrupo/granelIdGrupo de arriba quedan como el primero (compat:
    // orden/totalSugerido de grupos esGranel y el resto de la UI que espera un solo valor); el
    // array completo va en granelesGrupo para mostrarlos todos en la columna STOCK GRANEL.
    let granelesGrupo = [];
    const granelRefs = resolverGranelGrupo(refInfo);
    if (granelRefs.length) {
      // Sin fila de stock del granel → 0 (quiebre real), no el stock de los terminados.
      granelesGrupo = granelRefs.map(r => ({ id: r.id, nombre: r.nombre, stock: Math.round((granelMap.get(r.id) || 0) * 100) / 100, enUnidades: r.enUnidades }));
      granelIdGrupo     = granelesGrupo[0].id;
      nombreGranelGrupo = granelesGrupo[0].nombre;
      granelStockGrupo  = granelesGrupo[0].stock;
    } else if (esGranelCheck) {
      let base10 = null;
      for (const [base, bInfo] of refInfo.bases) { if (bInfo.pluBase && !bInfo.esMayorista && /10\s*kg/i.test(bInfo.baseNombre || '')) { base10 = base; nombreGranelGrupo = bInfo.baseNombre; granelIdGrupo = String(bInfo.pluBase); break; } }
      if (base10) {
        granelStockGrupo = stockBaseAll.get(base10) || 0;
        granelesGrupo = [{ id: granelIdGrupo, nombre: nombreGranelGrupo, stock: granelStockGrupo, enUnidades: false }];
      }
    } else {
      // Sin granelPlu en el catálogo y sin componente granel en la fórmula (BOM) de ninguna base: el
      // grupo no lleva granel (ej. Miel Canela). null → "—" en la columna, en vez de reusar el stock
      // de los terminados como si fuera stock granel (bug histórico: confundía "hay stock" con "no
      // lleva granel").
      granelStockGrupo = null;
    }
    // El del primer granel (el de granelStockGrupo): la unidad con que se muestra el granel del grupo.
    const granelEnUnidades = !!(granelesGrupo[0] && granelesGrupo[0].enUnidades);
    // Denominador: ÷ventana (demanda real) salvo que el producto esté sin stock → ÷días-con-venta (quiebre de stock)
    const usarPorDia = granelStockGrupo <= 0;
    const consumoBaseUse = usarPorDia ? consumoBasePorDia : consumoBaseVentana;
    const presentaciones = [];
    for (const [base, bInfo] of refInfo.bases) {
      const pluBase = bInfo.pluBase; // en una presentación mayorista (sin minoristas), el primer mayorista
      const prom = consumoBaseUse.get(base) || 0, pend = pendBase.get(base) || 0, stock = stockBase.get(base) || 0;
      const stockSucursales = Math.round((stockSucBase.get(base) || 0) * 100) / 100; // stock en sucursales (no central)
      const ventasVentana = Math.round((consumoBaseVentana.get(base) || 0) * ventana * 100) / 100; // total vendido en la ventana (misma base que ventaDiariaUrg)
      const ventaDiariaUrg = Math.round((consumoBaseVentana.get(base) || 0) * 10000) / 10000; // venta de la ventana ÷ ventana: solo para la cobertura/urgencia (promDiario puede ir ÷días-con-venta)
      // Parte de lo anterior que vino del canal mayorista (Casa Central a clientes MAYORISTA): solo se muestra.
      const ventasMayoristaVentana = Math.round((consumoMayVentana.get(base) || 0) * ventana * 100) / 100;
      const ventaDiariaMayorista = Math.round((consumoMayVentana.get(base) || 0) * 10000) / 10000;
      const stockEfectivo = Math.round(stock * incStock * 100) / 100; // stock que cuenta en el sugerido (incidencia config)
      const bom = pluBase ? bomRaw.get(pluBase) : null;
      const customGPlu = cfgGranelPlu(gruposCfg, refInfo.productoRef);
      const idGranel   = bom ? String(bom.IdProductoComponente) : customGPlu;
      const nomGranel  = bom ? bom.NombreComponente : (customGPlu ? (customGranelNomMap.get(customGPlu)||customGPlu) : '');
      const cantPU     = bom ? parseFloat(bom.CantPorUnidad || 0) : 0;
      let diasStock  = prom > 0 ? stock / prom : (stock > 0 ? Infinity : 0);
      const semaforo = diasStock < c.umbralRojo ? 'RED' : diasStock < c.umbralAmarillo ? 'YELLOW' : 'GREEN';
      let cantSugerida = 0;
      if (diasStock < c.minDiasParaSugerir || pend > 0) cantSugerida = Math.max(0, Math.ceil((prom * diasObj) - stockEfectivo + pend));
      const granelNec = Math.round(cantSugerida * cantPU * 100) / 100;
      const granelDisp = idGranel ? (granelMap.get(idGranel) || 0) : null;
      const granelOk  = granelNec === 0 || granelDisp === null || granelDisp >= granelNec;
      const facturacionMensual = Math.round((facturBase.get(base) || 0) * (30 / ventana) * 100) / 100; // facturación mensual de la presentación (minoristas + mayoristas)
      const urgenciaScore = (isFinite(diasStock) ? -diasStock : 0) + (pend / Math.max(prom, 0.001))
                      + (semaforo === 'RED' ? 1000 : semaforo === 'YELLOW' ? 100 : 0) + (!granelOk ? 50 : 0);
      presentaciones.push({ plu: pluBase, plus: [...bInfo.plusBase], baseNombre: bInfo.baseNombre, presentacion: bInfo.presentacion,
        ...(bInfo.esMayorista ? { esMayorista: true } : {}),
        stockActual: stock, stockEfectivo, stockSucursales, facturacionMensual, ventasVentana, ventaDiariaUrg, ventasMayoristaVentana, ventaDiariaMayorista, promDiario: Math.round(prom * 100) / 100, promMes: Math.round(prom * 30 * 10) / 10,
        diasStock: isFinite(diasStock) ? Math.round(diasStock * 10) / 10 : 9999,
        semaforo, pendientes: pend, cantSugerida, idGranel, nombreGranel: nomGranel, cantPorUnidad: cantPU,
        granelNecesario: granelNec, granelDisponible: granelDisp !== null ? Math.round(granelDisp * 100) / 100 : null,
        granelOk, urgenciaScore });
    }
    if (!presentaciones.length) continue;
    // Ya viene una entrada por presentación (buildCatalogoMaps agrupa por presentación): no hay nada que fusionar.
    const presFinal = presentaciones.sort((a, b) => a.presentacion.localeCompare(b.presentacion));
    const presConDemanda = presFinal.filter(p => p.promDiario > 0 || p.pendientes > 0);
    if (!presFinal.length) continue; // sin presentaciones reales → saltar
    const presRef = presConDemanda.length ? presConDemanda : presFinal;
    const semaforoGrupo = presRef.some(p => p.semaforo === 'RED') ? 'RED' : presRef.some(p => p.semaforo === 'YELLOW') ? 'YELLOW' : 'GREEN';
    const urgenciaGrupo = presConDemanda.length ? Math.max(...presConDemanda.map(p => p.urgenciaScore)) : 0;
    const esGranel = esGranelCheck;
    if (esGranel) {
      const enKg = (c.gruposGranelEnKg || []).includes(refInfo.productoRef);
      let totalPromMes, totalPend;
      // Toda Cantidad en SQL está en kg (corregido en aggregación para pack/bulto ≤200g)
      totalPromMes = Math.round(presRef.reduce((s, p) => s + p.promMes, 0) * 10) / 10;
      totalPend    = Math.round(presRef.reduce((s, p) => s + p.pendientes, 0) * 100) / 100;
      const promDiarioTotal = totalPromMes / 30;
      // Lo que decide si hay que producir es el stock de las presentaciones (producto terminado), no solo la masa:
      // se descuentan el stock de presentaciones en Casa Central y el del granel (ya hay masa para fraccionar).
      const stockPresCentral = Math.round(presFinal.reduce((s, p) => s + (p.stockActual || 0), 0) * 100) / 100;
      const totalSugerido   = Math.max(0, Math.ceil((promDiarioTotal * diasObj) - stockPresCentral - (granelStockGrupo || 0) + totalPend));
      const facturGrupoG = [...refInfo.bases.keys()].reduce((s, base) => s + (facturBase.get(base) || 0), 0);
      const facturMensualG = Math.round(facturGrupoG * (30 / ventana) * 100) / 100;
      const stockSucGrupo = Math.round([...refInfo.bases.keys()].reduce((s, base) => s + (stockSucBase.get(base) || 0), 0) * 100) / 100;
      // Modal 🔍 de sucursales: sin los códigos de presentaciones mayoristas (su stock de sucursal no cuenta).
      const plusGrupo = [...refInfo.bases.values()].filter(b => !b.esMayorista).flatMap(b => b.plusBase);
      const ventaDiariaUrgG = Math.round(presFinal.reduce((s, p) => s + p.ventaDiariaUrg, 0) * 10000) / 10000;
      const ventasVentanaG = Math.round(presFinal.reduce((s, p) => s + p.ventasVentana, 0) * 100) / 100;
      const ventasMayoristaVentanaG = Math.round(presFinal.reduce((s, p) => s + p.ventasMayoristaVentana, 0) * 100) / 100;
      const ventaDiariaMayoristaG = Math.round(presFinal.reduce((s, p) => s + p.ventaDiariaMayorista, 0) * 10000) / 10000;
      // "x unidad": peso y unidades vendidas de cada presentación (null = por kilo).
      const claveBase = p => `${refId}|${p.presentacion}`;
      const porUnidadG = presFinal.some(p => pesoUnidadBase.has(claveBase(p)));
      const pesoKgDe = p => pesoUnidadBase.get(claveBase(p)) ?? null;
      const mayUnidadDe = p => mayUnidadBase.get(claveBase(p)) || [];
      const sinPeso = presFinal.filter(p => (porUnidadG && pesoKgDe(p) === null) || mayUnidadDe(p).some(m => m.pesoKg === null)).map(p => p.presentacion);
      grupos.push({ refId, productoRef: refInfo.productoRef, promPorDiasConVenta: usarPorDia, semaforo: semaforoGrupo, urgenciaScore: urgenciaGrupo,
        totalSugerido, esGranel: true, enKg, totalPromMes, totalPend, granelStockGrupo, nombreGranelGrupo, stockSucGrupo, stockPresCentral,
        plus: plusGrupo, granelId: granelIdGrupo, graneles: granelesGrupo, granelEnUnidades, ventaDiariaUrg: ventaDiariaUrgG, ventasVentana: ventasVentanaG,
        ventasMayoristaVentana: ventasMayoristaVentanaG, ventaDiariaMayorista: ventaDiariaMayoristaG,
        facturacionMensual: facturMensualG, presentaciones: [],
        ...(porUnidadG || sinPeso.length ? { presentacionesSinPeso: sinPeso } : {}),
        // Consumo por presentación solo para mostrar (modal de urgencia): el granel se planifica como grupo.
        desglose: presFinal.map(p => ({ presentacion: p.presentacion, baseNombre: p.baseNombre, ...(p.esMayorista ? { esMayorista: true } : {}),
          ventasVentana: p.ventasVentana, ventasMayoristaVentana: p.ventasMayoristaVentana, ventaDiariaMayorista: p.ventaDiariaMayorista,
          ventaDiariaUrg: p.ventaDiariaUrg, facturacionMensual: p.facturacionMensual, // stockCentral como está en SIGA (unidades en un grupo x unidad); stockCentralKg = el pasado a kg (null si no se convirtió).
          stockCentral: porUnidadG ? Math.round((stockUnidBase.get(claveBase(p)) || 0) * 100) / 100 : p.stockActual,
          stockCentralKg: pesoKgDe(p) ? p.stockActual : null, pesoKg: pesoKgDe(p),
          unidadesVentana: porUnidadG ? Math.round((unidadesBaseVentana.get(claveBase(p)) || 0) * 100) / 100 : null,
          mayoristasUnidad: mayUnidadDe(p) })) });
      continue;
    }
    const totalSugerido = presFinal.reduce((s, p) => s + p.cantSugerida, 0);
    const facturGrupo  = [...refInfo.bases.keys()].reduce((s, base) => s + (facturBase.get(base) || 0), 0);
    const facturMensual = Math.round(facturGrupo * (30 / ventana) * 100) / 100;
    grupos.push({ refId, productoRef: refInfo.productoRef, promPorDiasConVenta: usarPorDia, semaforo: semaforoGrupo, urgenciaScore: urgenciaGrupo,
      totalSugerido, esGranel: false, granelStockGrupo, nombreGranelGrupo, granelId: granelIdGrupo, graneles: granelesGrupo, granelEnUnidades,
      facturacionMensual: facturMensual, presentaciones: presFinal });
  }
  // Prioridad: Σf²/Σf de la facturación mensual de cada presentación (granel/sin presentaciones: la del grupo)
  for (const g of grupos) {
    g.rankingScore = puntajePrioridad(g.presentaciones.length ? g.presentaciones.map(p => p.facturacionMensual) : [g.facturacionMensual]);
  }
  const byRanking = [...grupos].sort((a, b) => b.rankingScore - a.rankingScore);
  byRanking.forEach((g, i) => { g.rankingPos = i + 1; });
  // Urgencia de producción: cobertura = (stock central + stock sucursales) / venta diaria de la red, con
  // la venta de la ventana ÷ ventana (ventaDiariaUrg; no toca promDiario ni el sugerido). El umbral
  // depende de la clase ABC del grupo (config urgenciaDias). Sin materia prima: eso se revisa en el
  // resumen de insumos al enviar. Grupo granel (sin presentaciones): stock = granel central + sucursales.
  const clases = clasesABC(grupos.map(g => g.rankingScore));
  const redondear1 = n => Math.round(n * 10) / 10;
  const umbralPeso = umbralPesoGrupo(c.urgenciaPesoGrupo); // config urgenciaPesoGrupo (0 < x <= 1), default 0.20
  grupos.forEach((g, i) => {
    g.claseABC = clases[i];
    g.ventanaDias = ventana;                                  // para explicar el cálculo en el Resumen
    g.diasObjetivo = diasObj;                                 // días a cubrir: stock mínimo del modal de urgencia
    g.incidenciaStock = incStock;                             // % del stock central que cuenta en el sugerido
    g.minDiasParaSugerir = c.minDiasParaSugerir;              // con más días de stock (y sin pendientes) no sugiere
    g.umbralUrgencia = umbralDeClase(g.claseABC, c.urgenciaDias);
    g.sucursalesExcluidas = SUCURSALES_NO_REALES;
    g.excluyeCentral = true; // las ventas de Casa Central no cuentan en este análisis (ver sqlExcluirCentral)
    for (const p of g.presentaciones) {
      const cobertura = calcularCobertura((p.stockActual || 0) + (p.stockSucursales || 0), p.ventaDiariaUrg);
      p.coberturaDias = cobertura === null ? null : redondear1(cobertura);
      p.urgencia = nivelUrgencia(cobertura, g.claseABC, c.urgenciaDias);
    }
    g.presentaciones.sort(compararUrgencia);
    if (g.presentaciones.length) {
      const coberturas = g.presentaciones.map(p => p.coberturaDias).filter(x => x !== null);
      g.coberturaDias = coberturas.length ? Math.min(...coberturas) : null;
      // El grupo es tan urgente como lo que pesan, en facturación, sus presentaciones urgentes (ver lib).
      const peso = urgenciaGrupoPorPeso(g.presentaciones, umbralPeso);
      g.urgencia = peso.urgencia;
      g.pesoUrgente = peso.pesoUrgente;
      g.pesoUrgentePronto = peso.pesoUrgentePronto;
      g.umbralPeso = umbralPeso;
    } else {
      // Granel: la cobertura mira el stock de las presentaciones (Casa Central + sucursales), no el de la masa.
      const cobertura = calcularCobertura((g.stockPresCentral || 0) + (g.stockSucGrupo || 0), g.ventaDiariaUrg);
      g.coberturaDias = cobertura === null ? null : redondear1(cobertura);
      g.urgencia = nivelUrgencia(cobertura, g.claseABC, c.urgenciaDias);
    }
  });
  grupos.sort(compararUrgencia);
  let out = grupos;
  if (params.soloRojos === '1') out = out.filter(g => g.semaforo === 'RED');
  if (params.q) { const q = String(params.q).toLowerCase(); out = out.filter(g => g.productoRef.toLowerCase().includes(q) || g.presentaciones.some(p => p.baseNombre.toLowerCase().includes(q))); }
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
  // Granel: mismo criterio que granelMap en calcularSugerenciasCatalogo (sqlStockTodosDepositos) —
  // por PLU en todos los depósitos de la central, sin filtrar por nombre de depósito (el LIKE
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
router.get('/api/plan/sugerencias-grupos', apiRoute(async req => calcularSugerenciasCatalogo(req.query)));
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
