'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const bloquesTareas = require('../lib/bloques_tareas');

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
//     este corte. PUT /api/plan/:fecha/item/:id llama a saldoItemReserva y
//     ejecutarDevolucionReserva (ese motor), y POST /api/enviar-produccion llama
//     a leerPlanReservas/leerOrdenes/guardarOrdenes: esas funciones siguen
//     enteras en server.js y se reciben por deps.
//
// Lo que SÍ se movió entero porque no tiene uso fuera de este router (confirmado
// con grep en server.js y en todos los rutas_*.js antes de mover):
//   · calcularSugerencias y calcularSugerenciasCatalogo, con los sub-helpers que
//     sólo ellas usan: sqlConsumo, sqlPendientes, sqlBOM (wrapper de
//     sqlBOMGranel), pesoEnKg, sqlConsumoCatalogo, sqlStockTodosDepositos,
//     sqlStockSucursales, sqlPendientesPorPlu, sqlFacturacionPorPlu,
//     sqlBOMPorPlu, RUBRO_MANUAL_EXCLUIDO_RE, PRODUCTO_SAVONA_RE. Las llaman
//     tanto /api/plan/sugerencias* como /api/plan/:fecha/desde-sugerencias*, y
//     ambos grupos de rutas viven acá, así que no hay acoplamiento cruzado.
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
// rutas_productividad.js), conLogError (rutas_mayoristas.js/rutas_stock.js),
// safeDate (varios), leerPlanReservas (rutas_stock.js) y tiposPackaging (además
// usada por el motor de reservas de stock, aplicarSeleccionPackaging).
module.exports = function crearRutasPlan(deps) {
  const {
    apiRoute, leerJSON, guardarJSON, query, DATA_DIR,
    PLANES_PATH, PROD_REG_PATH, CATALOGO_PATH, GRUPOS_CFG_PATH,
    safeDate, leerPlanReservas, saldoItemReserva, ejecutarDevolucionReserva,
    leerOrdenes, guardarOrdenes, conLogError,
    tiposPackaging, FORMULA_ACTIVA_SQL, SIN_FORMULA_GENERICO_SQL,
    sqlStockTerminados, sqlStockGranel, sqlBOMGranel, sqlStockPorPlu,
    buildCatalogoMaps, cfgActivo, cfgGranelPlu, cfgEsGranel,
    sucursalesSiga, sucursalPublica,
  } = deps;
  const router = express.Router();

const RESP_PATH      = path.join(DATA_DIR, 'responsables.json');
const CLIENTES_PATH    = path.join(DATA_DIR, 'clientes.json');          // [{id,nombre}]
const FORMULAS_PATH  = path.join(DATA_DIR, 'formulas.json'); // { "plu": [{plu,nombre,cantPorUnidad}] }
// Qué tareas lleva cada producto o rubro y cuánto dura cada una. Va en su propio archivo y no
// dentro del plan: las plantillas son la receta, valen para todos los días y no se pisan al
// cambiar de fecha.
const PLANTILLAS_TAREAS_PATH = path.join(DATA_DIR, 'plantillas_tareas.json');

function sqlConsumo(ventana, rubros) {
  return `SELECT vp.IdProducto, SUM(vp.Cantidad) AS UnidVendidas,
       CAST(SUM(vp.Cantidad) AS DECIMAL(18,4)) / ${ventana} AS PromDiario
FROM VentasProductos vp
INNER JOIN Ventas v ON v.IdSucursal=vp.IdSucursal AND v.IdTipoComprobante=vp.IdTipoComprobante
  AND v.Letra=vp.Letra AND v.CentroEmisor=vp.CentroEmisor AND v.NumeroComprobante=vp.NumeroComprobante
INNER JOIN Sucursales s ON s.IdSucursal=v.IdSucursal
INNER JOIN Productos p ON p.IdProducto=vp.IdProducto
WHERE v.Fecha >= DATEADD(DAY,-${ventana},CAST(GETDATE() AS DATE)) AND v.Fecha < CAST(GETDATE() AS DATE)
  AND s.SoyLaCentral=1 AND ISNULL(v.IdEstadoComprobante,'') != 'ANULADO' ${rubros ? `AND p.IdRubro IN (${rubros})` : ''}
GROUP BY vp.IdProducto`;
}
function sqlPendientes() {
  return `SELECT pp.IdProducto, SUM(pp.CantPendiente) AS UnidPendientes
FROM PedidosProductos pp INNER JOIN Pedidos ped ON ped.IdSucursal=pp.IdSucursal AND ped.NumeroPedido=pp.NumeroPedido
WHERE pp.CantPendiente>0 AND ped.FechaPedido >= DATEADD(DAY,-7,CAST(GETDATE() AS DATE))
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
function sqlConsumoCatalogo(pluList, ventana) {
  // PromDiario usa días con ventas como denominador (no ventana fija)
  // Evita que stockouts depriman el promedio: si vendiste 551kg en 20/30 días → 551/20*30 = 826 real
  return `SELECT vp.IdProducto,
       SUM(vp.Cantidad) AS UnidVendidas,
       COUNT(DISTINCT CAST(v.Fecha AS DATE)) AS DiasConVenta,
       CAST(SUM(vp.Cantidad) AS DECIMAL(18,4))
         / NULLIF(COUNT(DISTINCT CAST(v.Fecha AS DATE)), 0) AS PromDiarioPorDia
FROM VentasProductos vp INNER JOIN Ventas v ON v.IdSucursal=vp.IdSucursal AND v.IdTipoComprobante=vp.IdTipoComprobante
  AND v.Letra=vp.Letra AND v.CentroEmisor=vp.CentroEmisor AND v.NumeroComprobante=vp.NumeroComprobante
LEFT  JOIN Clientes c ON c.IdCliente=v.IdCliente LEFT  JOIN Categorias cat ON cat.IdCategoria=c.IdCategoria
WHERE v.Fecha >= DATEADD(DAY,-${ventana},CAST(GETDATE() AS DATE)) AND v.Fecha < CAST(GETDATE() AS DATE)
  AND ISNULL(v.IdEstadoComprobante,'') != 'ANULADO' AND UPPER(ISNULL(cat.NombreCategoria,'')) != 'SUCURSAL'
  AND vp.IdProducto IN (${pluList.join(',')}) GROUP BY vp.IdProducto`;
}

function sqlStockTodosDepositos(pluList) {
  return `SELECT pd.IdProducto, COALESCE(SUM(pd.Stock),0) AS StockActual FROM ProductosDepositos pd
INNER JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal
INNER JOIN Sucursales s ON s.IdSucursal=pd.IdSucursal
WHERE s.SoyLaCentral=1 AND pd.IdProducto IN (${pluList.join(',')}) GROUP BY pd.IdProducto`;
}
function sqlStockSucursales(pluList) {
  // Stock en sucursales (todas menos Casa Central): SoyLaCentral=0
  return `SELECT pd.IdProducto, COALESCE(SUM(pd.Stock),0) AS StockActual FROM ProductosDepositos pd
INNER JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal
INNER JOIN Sucursales s ON s.IdSucursal=pd.IdSucursal
WHERE s.SoyLaCentral=0 AND sd.DisponibleVenta=1 AND pd.IdProducto IN (${pluList.join(',')}) GROUP BY pd.IdProducto`;
}
function sqlPendientesPorPlu(pluList) {
  return `SELECT pp.IdProducto, SUM(pp.CantPendiente) AS UnidPendientes FROM PedidosProductos pp
INNER JOIN Pedidos ped ON ped.IdSucursal=pp.IdSucursal AND ped.NumeroPedido=pp.NumeroPedido
WHERE pp.CantPendiente>0 AND ped.FechaPedido >= DATEADD(DAY,-7,CAST(GETDATE() AS DATE))
  AND pp.IdProducto IN (${pluList.join(',')}) GROUP BY pp.IdProducto`;
}
function sqlFacturacionPorPlu(pluList, ventana) {
  return `SELECT vp.IdProducto, SUM(vp.ImporteTotal) AS TotalFacturado
FROM VentasProductos vp INNER JOIN Ventas v ON v.IdSucursal=vp.IdSucursal AND v.IdTipoComprobante=vp.IdTipoComprobante
  AND v.Letra=vp.Letra AND v.CentroEmisor=vp.CentroEmisor AND v.NumeroComprobante=vp.NumeroComprobante
LEFT JOIN Clientes c ON c.IdCliente=v.IdCliente LEFT JOIN Categorias cat ON cat.IdCategoria=c.IdCategoria
WHERE v.Fecha >= DATEADD(DAY,-${ventana},CAST(GETDATE() AS DATE)) AND v.Fecha < CAST(GETDATE() AS DATE)
  AND ISNULL(v.IdEstadoComprobante,'') != 'ANULADO' AND UPPER(ISNULL(cat.NombreCategoria,'')) != 'SUCURSAL'
  AND vp.IdProducto IN (${pluList.join(',')}) GROUP BY vp.IdProducto`;
}
function sqlBOMPorPlu(pluList, rubrosG) {
  return sqlBOMGranel(rubrosG, `\n  AND pc.IdProducto IN (${pluList.join(',')})`);
}

async function calcularSugerenciasCatalogo(params) {
  const catalogoCompleto = leerJSON(CATALOGO_PATH, []);
  if (!catalogoCompleto.length) throw new Error('Catálogo vacío. Importar Excel desde planificación.');
  const gruposCfg = leerJSON(GRUPOS_CFG_PATH, {});
  const catalogo  = catalogoCompleto.filter(item => cfgActivo(gruposCfg, item.productoRef));
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  const ventana = parseInt(params.ventana) || c.ventanaConsumoDias;
  const diasObj = parseInt(params.diasObjetivo) || c.diasObjetivo;
  const incStock = (typeof c.incidenciaStockPlanif === 'number') ? c.incidenciaStockPlanif : 1; // % del stock que cuenta en el sugerido (0.6 = 60%)
  const rubrosG = c.rubrosGranel.join(',');
  const { pluToBase, baseMap, refMap } = buildCatalogoMaps(catalogo);
  const todosLosPlu = catalogo.map(i => String(i.plu));
  async function queryEnLotes(sqlFn) {
    const LOTE = 1000;
    if (todosLosPlu.length <= LOTE) return query(sqlFn(todosLosPlu));
    const res = [];
    for (let i = 0; i < todosLosPlu.length; i += LOTE) res.push(...await query(sqlFn(todosLosPlu.slice(i, i + LOTE))));
    return res;
  }
  // PLUs de granel asignados manualmente en grupos_config
  const customGranelPlus = [...new Set(Object.keys(gruposCfg).map(r=>cfgGranelPlu(gruposCfg,r)).filter(Boolean))];
  const quotedGP = customGranelPlus.map(p => `'${p}'`).join(',');
  const [consumoRows, pendientesRows, stockRows, stockTodosRows, stockSucRows, bomRows, granelRows, customGranelNomRows, facturRows] = await Promise.all([
    queryEnLotes(l => sqlConsumoCatalogo(l, ventana)), queryEnLotes(l => sqlPendientesPorPlu(l)),
    queryEnLotes(l => sqlStockPorPlu(l)), queryEnLotes(l => sqlStockTodosDepositos(l)),
    queryEnLotes(l => sqlStockSucursales(l)),
    queryEnLotes(l => sqlBOMPorPlu(l, rubrosG)), query(sqlStockGranel(rubrosG)),
    customGranelPlus.length ? query(`SELECT CAST(IdProducto AS VARCHAR) AS IdProducto, NombreProducto FROM Productos WHERE CAST(IdProducto AS VARCHAR) IN (${quotedGP})`) : Promise.resolve([]),
    queryEnLotes(l => sqlFacturacionPorPlu(l, ventana)),
  ]);
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
  // Variantes ≤200g de grupos NO enKg (mixes/FS): Cantidad SQL en unidades → convertir a kg
  const pluMetaMap = new Map(catalogo.map(i => [String(i.plu), i]));
  const enKgRefIds = new Set([...refMap.entries()].filter(([,ri]) => (c.gruposGranelEnKg||[]).includes(ri.productoRef)).map(([id]) => id));
  const consumoBaseVentana = new Map(), consumoBasePorDia = new Map();
  const stockBase = new Map(), stockBaseAll = new Map(), stockSucBase = new Map(), pendBase = new Map(), facturBase = new Map();
  for (const [plu, base] of pluToBase) {
    let total = consumoTotalRaw.get(plu) || 0;
    const dias = consumoDiasRaw.get(plu) || 0;
    const meta  = pluMetaMap.get(plu);
    const bInfo = baseMap.get(base);
    if (meta && meta.esVariante && bInfo && !enKgRefIds.has(bInfo.refId)) {
      const w = pesoEnKg(meta.presentacion);
      if (w !== null && w <= 0.2) total = total * w;
    }
    const rateVentana = ventana > 0 ? total / ventana : 0;   // demanda real diaria
    const ratePorDia  = dias    > 0 ? total / dias    : 0;   // intensidad (días que vendió)
    consumoBaseVentana.set(base, (consumoBaseVentana.get(base) || 0) + rateVentana);
    consumoBasePorDia.set(base,  (consumoBasePorDia.get(base)  || 0) + ratePorDia);
    // Stock SOLO de artículos base (sin check de variante). Las variantes no suman stock.
    const esVar = !!(meta && meta.esVariante);
    pendBase.set(base,     (pendBase.get(base)     || 0) + (pendRaw.get(plu)         || 0));
    stockBase.set(base,    (stockBase.get(base)    || 0) + (esVar ? 0 : (stockRaw.get(plu)      || 0)));
    stockBaseAll.set(base, (stockBaseAll.get(base) || 0) + (esVar ? 0 : (stockTodosRaw.get(plu) || 0)));
    stockSucBase.set(base, (stockSucBase.get(base) || 0) + (esVar ? 0 : (stockSucRaw.get(plu)   || 0)));
    facturBase.set(base,   (facturBase.get(base)   || 0) + (facturRaw.get(plu)       || 0));
  }
  // Granel del grupo: PLU cargado a mano en el catálogo (grupos_config.granelPlu) y, si no hay,
  // el componente granel de la fórmula activa de sus bases (el de mayor CantPorUnidad = principal).
  function resolverGranelGrupo(refInfo) {
    const custom = cfgGranelPlu(gruposCfg, refInfo.productoRef);
    if (custom) return { id: custom, nombre: customGranelNomMap.get(custom) || custom };
    let mejor = null;
    for (const bInfo of refInfo.bases.values()) {
      if (!bInfo.pluBase) continue;
      const bom = bomRaw.get(String(bInfo.pluBase));
      if (!bom) continue;
      const cant = parseFloat(bom.CantPorUnidad || 0);
      if (!mejor || cant > mejor.cant) mejor = { id: String(bom.IdProductoComponente), nombre: bom.NombreComponente || '', cant };
    }
    return mejor ? { id: mejor.id, nombre: mejor.nombre } : null;
  }
  const grupos = [];
  for (const [refId, refInfo] of refMap) {
    // Stock del granel del grupo (se necesita ANTES de calcular consumo para elegir denominador)
    const esGranelCheck = cfgEsGranel(gruposCfg, refInfo.productoRef, c.gruposGranel);
    let granelStockGrupo = 0, nombreGranelGrupo = '', granelIdGrupo = '';
    const granelRef = resolverGranelGrupo(refInfo);
    if (granelRef) {
      // Sin fila de stock del granel → 0 (quiebre real), no el stock de los terminados.
      granelIdGrupo     = granelRef.id;
      nombreGranelGrupo = granelRef.nombre;
      granelStockGrupo  = Math.round((granelMap.get(granelRef.id) || 0) * 100) / 100;
    } else if (esGranelCheck) {
      let base10 = null;
      for (const [base, bInfo] of refInfo.bases) { if (/10\s*kg/i.test(base) && bInfo.pluBase) { base10 = base; granelIdGrupo = String(bInfo.pluBase); break; } }
      if (base10) { granelStockGrupo = stockBaseAll.get(base10) || 0; nombreGranelGrupo = base10; }
    } else {
      granelStockGrupo = Math.round([...refInfo.bases.keys()].reduce((s, base) => s + (stockBase.get(base) || 0), 0) * 100) / 100;
    }
    // Denominador: ÷ventana (demanda real) salvo que el producto esté sin stock → ÷días-con-venta (quiebre de stock)
    const usarPorDia = granelStockGrupo <= 0;
    const consumoBaseUse = usarPorDia ? consumoBasePorDia : consumoBaseVentana;
    const presentaciones = [];
    for (const [base, bInfo] of refInfo.bases) {
      if (!bInfo.pluBase) continue; // solo mostrar productos base (esVariante=false)
      const pluBase = bInfo.pluBase;
      const prom = consumoBaseUse.get(base) || 0, pend = pendBase.get(base) || 0, stock = stockBase.get(base) || 0;
      const stockSucursales = Math.round((stockSucBase.get(base) || 0) * 100) / 100; // stock en sucursales (no central)
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
      const urgencia  = (isFinite(diasStock) ? -diasStock : 0) + (pend / Math.max(prom, 0.001))
                      + (semaforo === 'RED' ? 1000 : semaforo === 'YELLOW' ? 100 : 0) + (!granelOk ? 50 : 0);
      presentaciones.push({ plu: pluBase, baseNombre: base, presentacion: bInfo.presentacion,
        stockActual: stock, stockEfectivo, stockSucursales, promDiario: Math.round(prom * 100) / 100, promMes: Math.round(prom * 30 * 10) / 10,
        diasStock: isFinite(diasStock) ? Math.round(diasStock * 10) / 10 : 9999,
        semaforo, pendientes: pend, cantSugerida, idGranel, nombreGranel: nomGranel, cantPorUnidad: cantPU,
        granelNecesario: granelNec, granelDisponible: granelDisp !== null ? Math.round(granelDisp * 100) / 100 : null,
        granelOk, urgencia });
    }
    if (!presentaciones.length) continue;
    const mergeMap = new Map();
    for (const p of presentaciones) {
      const key = p.presentacion;
      if (!mergeMap.has(key)) { mergeMap.set(key, { ...p }); } else {
        const m = mergeMap.get(key);
        m.stockActual += p.stockActual; m.stockEfectivo = Math.round((m.stockEfectivo + p.stockEfectivo) * 100) / 100;
        m.stockSucursales = Math.round((m.stockSucursales + p.stockSucursales) * 100) / 100;
        m.promDiario = Math.round((m.promDiario + p.promDiario) * 100) / 100;
        m.promMes = Math.round((m.promMes + p.promMes) * 10) / 10; m.pendientes += p.pendientes;
        m.cantSugerida += p.cantSugerida; m.granelNecesario += p.granelNecesario;
        const ds = m.promDiario > 0 ? m.stockActual / m.promDiario : (m.stockActual > 0 ? Infinity : 0);
        m.diasStock = isFinite(ds) ? Math.round(ds * 10) / 10 : 9999;
        m.semaforo = (m.semaforo === 'RED' || p.semaforo === 'RED') ? 'RED' : (m.semaforo === 'YELLOW' || p.semaforo === 'YELLOW') ? 'YELLOW' : 'GREEN';
        m.granelOk = m.granelOk && p.granelOk; m.urgencia = Math.max(m.urgencia, p.urgencia);
      }
    }
    const presFinal = [...mergeMap.values()].sort((a, b) => a.presentacion.localeCompare(b.presentacion));
    const presConDemanda = presFinal.filter(p => p.promDiario > 0 || p.pendientes > 0);
    if (!presFinal.length) continue; // sin presentaciones reales → saltar
    const presRef = presConDemanda.length ? presConDemanda : presFinal;
    const semaforoGrupo = presRef.some(p => p.semaforo === 'RED') ? 'RED' : presRef.some(p => p.semaforo === 'YELLOW') ? 'YELLOW' : 'GREEN';
    const urgenciaGrupo = presConDemanda.length ? Math.max(...presConDemanda.map(p => p.urgencia)) : 0;
    const esGranel = esGranelCheck;
    if (esGranel) {
      const enKg = (c.gruposGranelEnKg || []).includes(refInfo.productoRef);
      let totalPromMes, totalPend;
      // Toda Cantidad en SQL está en kg (corregido en aggregación para pack/bulto ≤200g)
      totalPromMes = Math.round(presRef.reduce((s, p) => s + p.promMes, 0) * 10) / 10;
      totalPend    = Math.round(presRef.reduce((s, p) => s + p.pendientes, 0) * 100) / 100;
      const promDiarioTotal = totalPromMes / 30;
      const totalSugerido   = Math.max(0, Math.ceil((promDiarioTotal * diasObj) - granelStockGrupo + totalPend));
      const facturGrupoG = [...refInfo.bases.keys()].reduce((s, base) => s + (facturBase.get(base) || 0), 0);
      const facturMensualG = Math.round(facturGrupoG * (30 / ventana) * 100) / 100;
      const stockSucGrupo = Math.round([...refInfo.bases.keys()].reduce((s, base) => s + (stockSucBase.get(base) || 0), 0) * 100) / 100;
      const plusGrupo = [...refInfo.bases.values()].map(b => b.pluBase).filter(Boolean).map(String);
      grupos.push({ refId, productoRef: refInfo.productoRef, semaforo: semaforoGrupo, urgencia: urgenciaGrupo,
        totalSugerido, esGranel: true, enKg, totalPromMes, totalPend, granelStockGrupo, nombreGranelGrupo, stockSucGrupo,
        plus: plusGrupo, granelId: granelIdGrupo,
        facturacionMensual: facturMensualG, presentaciones: [] });
      continue;
    }
    const totalSugerido = presFinal.reduce((s, p) => s + p.cantSugerida, 0);
    const facturGrupo  = [...refInfo.bases.keys()].reduce((s, base) => s + (facturBase.get(base) || 0), 0);
    const facturMensual = Math.round(facturGrupo * (30 / ventana) * 100) / 100;
    grupos.push({ refId, productoRef: refInfo.productoRef, semaforo: semaforoGrupo, urgencia: urgenciaGrupo,
      totalSugerido, esGranel: false, granelStockGrupo, nombreGranelGrupo, granelId: granelIdGrupo,
      facturacionMensual: facturMensual, presentaciones: presFinal });
  }
  // Ranking: score = 0.6*facturNorm + 0.4*cantNorm (facturación + cantidad vendida mensual)
  const maxFact = Math.max(...grupos.map(g => g.facturacionMensual || 0), 1);
  const maxProm = Math.max(...grupos.map(g => g.totalPromMes || 0), 1);
  for (const g of grupos) {
    const fNorm = (g.facturacionMensual || 0) / maxFact;
    const cNorm = (g.totalPromMes       || 0) / maxProm;
    g.rankingScore = Math.round((0.6 * fNorm + 0.4 * cNorm) * 1000) / 1000;
  }
  const byRanking = [...grupos].sort((a, b) => b.rankingScore - a.rankingScore);
  byRanking.forEach((g, i) => { g.rankingPos = i + 1; });
  grupos.sort((a, b) => b.urgencia - a.urgencia);
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
  const sucursales = sucs.map(sucursalPublica);
  const stockPorSuc = async (ids, soloGranel) => ids.length ? query(`
    SELECT CAST(pd.IdProducto AS VARCHAR) AS IdProducto, pd.IdSucursal, COALESCE(SUM(pd.Stock),0) AS Stock
    FROM ProductosDepositos pd
    INNER JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal
    WHERE ${soloGranel ? `UPPER(sd.NombreDeposito) LIKE '%GRANEL%'` : `sd.DisponibleVenta=1`}
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
router.get('/api/planes', (_req, res) => {
  const planes = leerJSON(PLANES_PATH, {});
  res.json(Object.keys(planes).sort().reverse().map(fecha => ({ fecha, totalItems: planes[fecha].items.length, totalUnidades: planes[fecha].items.reduce((s, i) => s + (i.cantConfirmada ?? i.cantSugerida ?? 0), 0), creado: planes[fecha].creado })));
});
// Con saneo de sellos: la UI dibuja el candado y deshabilita el ✕ mirando reservaMovimiento,
// así que tiene que ver lo mismo que las guardas de PUT y DELETE.
router.get('/api/plan/:fecha', (req, res) => { const fecha = safeDate(req.params.fecha); const { plan } = leerPlanReservas(fecha); res.json(plan || { fecha, notas: '', items: [] }); });

router.post('/api/plan/:fecha', (req, res) => {
  const fecha = safeDate(req.params.fecha), planes = leerJSON(PLANES_PATH, {});
  const prev = planes[fecha];
  // Las notas se pisan con cualquier string, incluido '' (borrarlas): con `||` una nota vacía
  // caía al valor anterior y el texto viejo volvía al recargar.
  const notas = typeof req.body.notas === 'string' ? req.body.notas : (prev?.notas || '');
  // Los ítems solo se reemplazan si el cuerpo los trae. Guardar una nota mandaba el cache del
  // navegador y pisaba los ítems (con sus sellos de reserva/producción) por una versión vieja.
  const items = Array.isArray(req.body.items) ? req.body.items : (prev?.items || []);
  // `...prev` conserva el resto del plan (plan.reserva, el ledger de reservas), que antes se
  // perdía porque el objeto se reconstruía desde cero en cada guardado de notas.
  planes[fecha] = { ...prev, fecha, notas, creado: prev?.creado || new Date().toISOString(), items };
  guardarJSON(PLANES_PATH, planes); res.json(planes[fecha]);
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

// Los bloques viven dentro del plan del día, pero NO se pueden guardar por POST /api/plan/:fecha:
// ese handler arma el plan como { ...prev, fecha, notas, creado, items } y descarta cualquier
// campo extra del body. Endpoint aparte, que además sólo toca jornadaInicio y bloques: los
// items y el ledger de reservas quedan intactos aunque el navegador tenga un cache viejo.
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

router.post('/api/plan/:fecha/desde-sugerencias', apiRoute(async req => {
  const fecha = safeDate(req.params.fecha), sugs = await calcularSugerencias({});
  const ts = Date.now();
  const items = sugs.filter(s => (s.semaforo === 'RED' || s.semaforo === 'YELLOW') && s.cantSugerida > 0).map((s, i) => ({
    id: ts + i, idProducto: s.idProducto, producto: s.producto, rubro: s.rubro, stockActual: s.stockActual,
    promDiario: s.promDiario, diasStock: s.diasStock, semaforo: s.semaforo, pendientes: s.pendientes,
    cantSugerida: s.cantSugerida, cantConfirmada: s.cantSugerida, responsable: '', prioridad: i + 1, estado: 'pendiente',
    idGranel: s.idGranel, nombreGranel: s.nombreGranel, cantPorUnidad: s.cantPorUnidad,
    granelNecesario: s.granelNecesario, granelDisponible: s.granelDisponible, granelOk: s.granelOk
  }));
  const planes = leerJSON(PLANES_PATH, {});
  planes[fecha] = { fecha, notas: planes[fecha]?.notas || '', creado: planes[fecha]?.creado || new Date().toISOString(), items };
  guardarJSON(PLANES_PATH, planes); return planes[fecha];
}));
router.post('/api/plan/:fecha/desde-sugerencias-catalogo', apiRoute(async req => {
  const fecha = safeDate(req.params.fecha), grupos = await calcularSugerenciasCatalogo({});
  const ts = Date.now(); let idx = 0; const items = [];
  for (const g of grupos) {
    if (g.semaforo === 'GREEN') continue;
    for (const p of g.presentaciones) {
      if (p.cantSugerida <= 0) continue;
      items.push({ id: ts + idx++, idProducto: p.plu, producto: p.baseNombre, rubro: g.productoRef, stockActual: p.stockActual,
        promDiario: p.promDiario, diasStock: p.diasStock, semaforo: p.semaforo, pendientes: p.pendientes,
        cantSugerida: p.cantSugerida, cantConfirmada: p.cantSugerida, responsable: '', prioridad: idx, estado: 'pendiente',
        idGranel: p.idGranel, nombreGranel: p.nombreGranel, cantPorUnidad: p.cantPorUnidad,
        granelNecesario: p.granelNecesario, granelDisponible: p.granelDisponible, granelOk: p.granelOk });
    }
  }
  const planes = leerJSON(PLANES_PATH, {});
  planes[fecha] = { fecha, notas: planes[fecha]?.notas || '', creado: planes[fecha]?.creado || new Date().toISOString(), items };
  guardarJSON(PLANES_PATH, planes); return planes[fecha];
}));
router.post('/api/plan/:fecha/item', apiRoute(async req => {
  const fecha = safeDate(req.params.fecha), planes = leerJSON(PLANES_PATH, {});
  if (!planes[fecha]) planes[fecha] = { fecha, notas: '', creado: new Date().toISOString(), items: [] };
  const nuevoItem = { responsable: '', estado: 'pendiente', ...req.body, id: Date.now(), cantConfirmada: req.body.cantConfirmada ?? req.body.cantSugerida ?? 0, prioridad: planes[fecha].items.length + 1 };
  planes[fecha].items.push(nuevoItem); guardarJSON(PLANES_PATH, planes); return nuevoItem;
}));
router.put('/api/plan/:fecha/item/:id', apiRoute(async req => {
  const fecha = safeDate(req.params.fecha), id = parseInt(req.params.id);
  // Igual que al eliminar: se lee con saneo de sellos para no bloquear por una reserva muerta.
  const { planes, plan } = leerPlanReservas(fecha);
  if (!plan) return { error: 'Plan no encontrado' };
  const idx = (plan.items || []).findIndex(i => i.id === id); if (idx === -1) return { error: 'Ítem no encontrado' };
  const actual = plan.items[idx], body = req.body || {};
  // Ya trabajado en producción: no se modifica (la página pudo quedar desactualizada).
  if (actual.produccionMovimiento && actual.produccionMovimiento.numeroMovimiento != null) {
    return { error: `La orden ya fue trabajada en producción (movimiento #${actual.produccionMovimiento.numeroMovimiento}). Recargá la planificación: no se puede modificar.`, yaProducido: true };
  }
  // Reservada: no se cambian cantidades ni producto (desincronizaría la reserva). El cambio de
  // estado (que dispara la devolución al terminar) sí se permite.
  if (actual.reservaMovimiento && actual.reservaMovimiento.numeroMovimiento != null) {
    // envase/tapa entran acá porque sustituyen a los de la fórmula al calcular la reserva:
    // cambiarlos con la reserva sellada dejaría apartado un packaging que ya no corresponde.
    const cambiaContenido = ['cantConfirmada','cantSugerida','idProducto','producto','presentaciones','cantidad','idGranel','envase','tapa']
      .some(k => k in body && JSON.stringify(body[k]) !== JSON.stringify(actual[k]));
    if (cambiaContenido) {
      return { error: `La orden está reservada (movimiento #${actual.reservaMovimiento.numeroMovimiento}). Anulá la reserva antes de modificar cantidades o producto.`, yaReservado: true };
    }
  }
  const pasaAListo = body.estado === 'listo' && actual.estado !== 'listo';
  plan.items[idx] = { ...plan.items[idx], ...req.body, id };

  // Devolución automática: al terminar un ítem vuelve al depósito principal sólo su
  // porción de la reserva. Si el traslado falla el cambio de estado NO se pierde: se
  // guarda igual y el error viaja en reservaError para que la UI lo muestre.
  let reservaError = null, logError = null;
  if (pasaAListo && plan.reserva && plan.reserva.estado === 'activa' && saldoItemReserva(plan.reserva, id).length) {
    try {
      const r = await ejecutarDevolucionReserva(plan, id);
      if (r.error) reservaError = r.error;
      else {
        logError = r.logError || null;
        plan.reserva = r.reserva;
        plan.items[idx] = { ...plan.items[idx], reservaDevuelta: { numeroMovimiento: r.numeroMovimiento, fecha: new Date().toISOString(), idRegistro: r.idRegistro ?? null, depOrigen: r.depOrigen, depDestino: r.depDestino } };
      }
    } catch (e) { reservaError = e.message; }
  }

  guardarJSON(PLANES_PATH, { ...planes, [fecha]: plan });
  const item = reservaError ? { ...plan.items[idx], reservaError } : plan.items[idx];
  return conLogError(item, logError);
}));
router.delete('/api/plan/:fecha/item/:id', (req, res) => {
  const fecha = safeDate(req.params.fecha), id = parseInt(req.params.id);
  // leerPlanReservas (y no leerJSON pelado) porque de paso suelta los sellos huérfanos: si el
  // movimiento que reservaba la orden ya se revirtió, la guarda de abajo no tiene que frenarla.
  const { planes, plan } = leerPlanReservas(fecha);
  if (!plan) return res.status(404).json({ error: 'Plan no encontrado' });
  const itemBloq = (plan.items || []).find(it => String(it.id) === String(id));
  if (itemBloq && itemBloq.produccionMovimiento && itemBloq.produccionMovimiento.numeroMovimiento != null) {
    return res.status(409).json({ error: `La orden ya fue trabajada en producción (movimiento #${itemBloq.produccionMovimiento.numeroMovimiento}). Recargá la planificación: no se puede eliminar.` });
  }
  if (itemBloq && itemBloq.reservaMovimiento && itemBloq.reservaMovimiento.numeroMovimiento != null) {
    return res.status(409).json({ error: `La orden está reservada (movimiento #${itemBloq.reservaMovimiento.numeroMovimiento}) y no se puede eliminar. Anulá esa reserva primero.` });
  }
  const items = (plan.items || []).filter(i => i.id !== id);
  guardarJSON(PLANES_PATH, { ...planes, [fecha]: { ...plan, items } });
  res.json({ ok: true });
});
router.delete('/api/plan/:fecha', (req, res) => {
  const fecha = safeDate(req.params.fecha), planes = leerJSON(PLANES_PATH, {});
  let conservadas = 0, porReserva = 0, porProduccion = 0;
  if (planes[fecha]) {
    // No se borran ni las órdenes reservadas ni las ya recepcionadas: las primeras tienen
    // mercadería apartada en SiGA y las segundas ya cerraron su circuito. Borrarlas dejaría
    // movimientos vivos apuntando a un ítem inexistente. Se elimina sólo el resto.
    // Antes sólo se miraba reservaMovimiento, así que un ítem recepcionado SIN reserva viva
    // (producido sin reservar, o con su reserva revertida desde el historial) se borraba.
    const items = planes[fecha].items || [];
    const tieneMov = (it, campo) => !!(it && it[campo] && it[campo].numeroMovimiento != null);
    const conservar = items.filter(it => tieneMov(it, 'reservaMovimiento') || tieneMov(it, 'produccionMovimiento'));
    porReserva    = conservar.filter(it => tieneMov(it, 'reservaMovimiento')).length;
    porProduccion = conservar.filter(it => tieneMov(it, 'produccionMovimiento') && !tieneMov(it, 'reservaMovimiento')).length;
    conservadas = conservar.length;
    planes[fecha].items = conservar;
    guardarJSON(PLANES_PATH, planes);
  }
  const partes = [];
  if (porReserva)    partes.push(`${porReserva} reservada(s): anulá su reserva para poder eliminarlas`);
  if (porProduccion) partes.push(`${porProduccion} ya recepcionada(s): su circuito ya cerró y no se pueden eliminar`);
  res.json({ ok: true, conservadas, porReserva, porProduccion,
    ...(conservadas ? { aviso: `Se conservaron ${conservadas} orden(es) — ${partes.join('; ')}.` } : {}) });
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
router.post('/api/enviar-produccion', (req, res) => {
  const nuevas = req.body;
  if (!Array.isArray(nuevas) || !nuevas.length) return res.status(400).json({ error: 'Sin órdenes' });
  try {
    // Dedup por (fecha + producto): si ya existe la orden ese día se sobreescriben
    // los datos con los nuevos, preservando id (link con lo cargado), estado y la
    // escalada manual a 'Urgente'. Las que no existen se agregan al final.
    const arr = leerOrdenes();
    const keyOf = o => `${o.fecha || ''}|${(o.producto || '').trim().toLowerCase()}`;
    const idx = new Map(arr.map((o, i) => [keyOf(o), i]));
    // Cada orden hereda los números de movimiento de reserva de los ítems del plan que la
    // componen: granel es 1 ítem por orden (match por producto); fraccionado agrupa varios
    // ítems por rubro (match por rubro, con fallback a producto si no hay rubro explícito) —
    // misma clave que arma construirOrdenes() en planificacion.html. Cache por fecha para no
    // releer planes.json por cada orden del envío.
    const planItemsPorFecha = new Map();
    const itemsDeOrden = n => {
      if (!planItemsPorFecha.has(n.fecha)) {
        const { plan } = leerPlanReservas(n.fecha);
        planItemsPorFecha.set(n.fecha, (plan && plan.items) || []);
      }
      return planItemsPorFecha.get(n.fecha).filter(it =>
        it && (it.producto === n.producto || (it.rubro || it.producto) === n.producto));
    };
    const movimientosDeOrden = n => [...new Set(itemsDeOrden(n)
      .filter(it => it.reservaMovimiento && it.reservaMovimiento.numeroMovimiento != null)
      .map(it => it.reservaMovimiento.numeroMovimiento))];
    // Un ítem con produccionMovimiento ya se produjo Y se recepcionó como artículo final: su
    // circuito cerró y la orden no se puede volver a enviar.
    // ordenesTrabajadas NO alcanza para detectarlo: al conciliar, los registros se mueven de
    // produccion_registros.json a produccion_historial.json, así que el Set queda vacío para
    // esas órdenes y volvían a ser re-enviables justo después de conciliar.
    const numeroRecepcion = n => {
      const it = itemsDeOrden(n).find(x =>
        x.produccionMovimiento && x.produccionMovimiento.numeroMovimiento != null);
      return it ? it.produccionMovimiento.numeroMovimiento : null;
    };
    // Órdenes ya trabajadas (con algún registro de producción cargado): no se pisan aunque
    // todavía no estén en 'listo'/terminado, para no borrar lo que producción ya cargó.
    const ordenesTrabajadas = new Set(leerJSON(PROD_REG_PATH, []).map(r => String(r && r.ordenId)).filter(v => v && v !== 'undefined'));
    let sobre = 0, nue = 0, completas = 0;
    const recepcionadas = [];
    for (const n of nuevas) {
      // Se corta ANTES del alta o la sobreescritura: la orden ya cerró su circuito en SiGA.
      const numRecep = numeroRecepcion(n);
      if (numRecep != null) {
        recepcionadas.push({ producto: n.producto, numeroMovimiento: numRecep });
        continue;
      }
      const k = keyOf(n), i = idx.get(k);
      const reservaMovimientos = movimientosDeOrden(n);
      if (i != null) {
        const prev = arr[i];
        // Si la orden previa ya está completa o fue trabajada en producción, se mantiene:
        // no se sobreescribe (preserva registro cargado, estado 'listo' y terminado).
        if (prev.terminado === true || prev.estado === 'listo' || ordenesTrabajadas.has(String(prev.id))) { completas++; continue; }
        arr[i] = { ...n, id: prev.id, estado: prev.estado, terminado: prev.terminado, criticidad: prev.criticidad === 'Urgente' ? 'Urgente' : n.criticidad, reservaMovimientos };
        sobre++;
      } else {
        arr.push({ ...n, reservaMovimientos }); idx.set(k, arr.length - 1); nue++;
      }
    }
    guardarOrdenes(arr);
    res.json({ ok: true, enviadas: nuevas.length, sobrescritas: sobre, nuevas: nue,
               completasOmitidas: completas, recepcionadasOmitidas: recepcionadas });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

  return router;
};
