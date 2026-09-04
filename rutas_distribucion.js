'use strict';
const express = require('express');
const path = require('path');
const insumos = require('./lib/insumos');
const { calcularAlmacen } = require('./lib/distribucion');
const { calcularPesables } = require('./lib/pesables');
const { universoLista, universoPesables } = require('./lib/listas_universo');
const { pesoTokenKg } = require('./lib/producto_carga');
const { computeA8020, calcularRankingPorSucursal, calcularRankingGlobal, roundDec, aplicarManualA8020, asegurarBrechaMinS,
        calcularConsumoReal, esProductoApidelta, boostDePlu, BOOST_APIDELTA_DEFAULT, RUBRO_ALMACEN_BULTO } = require('./lib/a8020');

// ── Rutas de Distribución (Almacen / Pesables / A8020 / Insumos) ───────────────────────────────
// El bloque más grande de server.js: réplica de las hojas "Almacen" y "Pesables", el motor A8020
// (puntos de pedido order-up-to), control de insumos/etiquetas, listas editables, fraccionado,
// historial, envasado y las páginas/docs del módulo. Extraídas sin cambios de comportamiento:
// mismas rutas, mismo orden relativo y mismas queries. Los bloques movidos conservan la
// indentación original a propósito (hay template literals SQL multilínea y reindentar les
// cambiaría el texto) — por eso las rutas de acá abajo arrancan en columna 0 en vez de seguir la
// indentación de la función que las envuelve.
//
// Insumos (/api/insumos/*) vino junto: vive físicamente intercalado entre rutas de distribución
// en server.js y sus helpers (INSUMOS_CFG, ES_INSUMO/ES_ETIQUETA, sqlInsumosStock/Movimientos,
// INSUMOS_NIVELES_PATH, ETIQUETAS_GRUPOS_PATH) no los usa nada más. La página GET /insumos (sendFile)
// NO se movió: vive en la sección de páginas estáticas de server.js junto con /pedidos,
// /planificacion, /consumo, etc. — un corte distinto, fuera de este alcance.
//
// Lo que comparte vecindad con distribución pero NO se movió, y por qué (se queda en server.js
// y viaja por deps):
//   · PESABLES_LISTAS_PATH, sqlStockDistribucion, DISTRIB_CONFIG_PATH, A8020_CALC_PATH y
//     _ventasJoin — también los usa rutas_compras.js (se registra al final, después de éste).
//   · FRAC_REG_PATH / HISTORIAL_PATH — también los usa rutas_productividad.js (unirPorId).
//   · PEDIDOS_COMPRA_PATH / leerPedidosCompra / guardarPedidosCompra — el control de compras
//     también lee pedidos_compra.json (rutas_compras.js y rutas_compras_control.js).
//   · PROD_REG_PATH / PROD_HIST_PATH / archivarRegistros() — están físicamente intercalados entre
//     las rutas de fraccionado y las de pesables-params, pero son del dominio Producción: los usa
//     rutas_produccion.js, rutas_productividad.js y el cierre de día más abajo en server.js.
//   · FORMULA_ACTIVA_SQL, SIN_FORMULA_GENERICO_SQL, componentesFormulaPorPadre, DATA_DIR, cfg —
//     utilidades/config de uso general en todo server.js.
//   · /api/plan/* y /api/produccion/:fecha/* — el módulo de reservas/plan, corte aparte.
module.exports = function crearRutasDistribucion(deps) {
  const {
    apiRoute, query, leerJSON, guardarJSON, cfg, DATA_DIR,
    PESABLES_LISTAS_PATH, sqlStockDistribucion, DISTRIB_CONFIG_PATH, A8020_CALC_PATH,
    _ventasJoin, FORMULA_ACTIVA_SQL, SIN_FORMULA_GENERICO_SQL, componentesFormulaPorPadre,
    CONSUMO_MENSUAL_PATH, FRAC_REG_PATH, HISTORIAL_PATH,
  } = deps;
  const router = express.Router();

// ── Distribución a sucursales (réplica hoja "Almacen") ──────────────────────────
const A8020_PATH           = path.join(DATA_DIR, 'a8020.json');
const DISTRIB_LISTAS_PATH  = path.join(DATA_DIR, 'distribucion_listas.json');
const ENVIOS_MANUALES_PATH = path.join(DATA_DIR, 'envios_manuales.json');
// IdSucursal Siga → clave de stock del motor (6=Savio no se usa en Almacen). VERIFICAR con /api/distribucion/sucursales.
const DISTRIB_SUC_MAP = { 2:'urq', 3:'nacion', 4:'chaca', 5:'riv', 7:'sanpedro', 8:'sucu8', 9:'sucu9', 10:'pergamino', 11:'sucu11' };   // central resuelta por idCentral (config)
// Peso de la presentación (bolsa) en kg. Prioridad: (1) marcador "por kilo"/"x kg" → 1kg suelto
// (gana aunque el nombre tenga un número de bulto, ej "10Kg (Por Kilo)"); (2) último token de peso
// del nombre (250G→0.25, 1Kg→1, 500Gr→0.5); (3) cantFormula del componente; (4) 1kg.
function pesoPresentacionKg(nombre, cantFormula) {
  const n = String(nombre || '');
  if (/(por\s*kilo|x\s*kilo|x\s*kg|precio\s*x\s*kilo|por\s*kg)\b/i.test(n)) return 1;
  // El barrido del token de peso vive en producto_carga.js: lo comparten esta función y la
  // resolución del producto de carga, y tener dos regex iguales en dos archivos ya nos había
  // dejado criterios divergiendo. La diferencia entre ambos usos es sólo el atajo "por kilo"
  // de arriba, que acá aplica (peso de la bolsa) y allá no (tamaño del envase).
  const kgToken = pesoTokenKg(n);
  if (kgToken != null) return kgToken;
  const cf = Number(cantFormula);
  return (cf > 0) ? cf : 1;
}
// enviar-key del motor Almacen → clave canónica de Fact
const ALM_FACT_KEY = { riv:'riv', urq:'urq', nacion:'nacion', chaca:'chaca', pergamino:'pergamino', sanPedro:'sanpedro', sucursal9:'ramallo', sucursal11:'sucu11' };
// Sucursal (clave de a8020_calc.detalle) → clave del nivel S en a8020.json (formato legacy).
const SUC_A_CLAVE_S = { riv: 'SRiv', urq: 'SUrq', nacion: 'SNacion', chaca: 'SChaca',
  pergamino: 'SPergamino', sanpedro: 'SSanPedro', ramallo: 'SVRamallo' };

// μ diaria por (plu, clave S) desde a8020_calc.detalle → define qué producto "rota poco" en cada
// sucursal para la regla caro-y-lento del motor de distribución.
function muPorPluDesdeDetalle(detalle) {
  const out = {};
  for (const [plu, d] of Object.entries(detalle || {})) {
    const m = {};
    for (const [suc, s] of Object.entries(d)) {
      const sk = SUC_A_CLAVE_S[suc];
      if (sk) m[sk] = Number(s.mu) || 0;
    }
    out[plu] = m;
  }
  return out;
}

async function calcularDistribucionAlmacen() {
  const a8020  = leerJSON(A8020_PATH, {});
  const distCfg = leerJSON(DISTRIB_CONFIG_PATH, {});
  const empujePresencia = (distCfg.empujeDeposito || {}).presencia || 0;
  const empujePresenciaFactorS = (distCfg.empujeDeposito || {}).presenciaFactorS || 2;
  const presenciaPorClase = (distCfg.empujeDeposito || {}).presenciaPorClase || null;   // { A, B, C } → presencia según ABC; si falta, usa presencia plana
  const importanciaCfg = distCfg.importancia || {};
  const umbralMicroEnvio = distCfg.umbralMicroEnvio || { tramos: [{ hastaS: null, pct: 0.20 }], pisoAbsoluto: 1 };
  const a8020Calc = leerJSON(A8020_CALC_PATH, {}) || {};
  const impViva = a8020Calc.impFacturacion || {};
  const abcPorPlu = a8020Calc.abc || {};   // clase ABC por PLU (para presencia escalada por importancia)
  // Regla caro-y-lento: μ real por sucursal + config del umbral y los pisos. Sin la clave de config
  // el motor no la aplica (paridad con el comportamiento histórico).
  const muPorPlu = muPorPluDesdeDetalle(a8020Calc.detalle || {});
  const sinEmpujeCaroLento = (distCfg.empujeDeposito || {}).sinEmpujeCaroLento || null;
  const ed = leerListasDistrib();
  const rubroRows = await query(`SELECT CAST(p.IdProducto AS VARCHAR) AS IdProducto
    FROM Productos p JOIN Rubros r ON r.IdRubro=p.IdRubro
    WHERE p.Activo=1 AND r.NombreRubro='Almacen'`);
  const basePlus = rubroRows.map(r => r.IdProducto);
  const plus = universoLista(basePlus, ed.siempreAlmacen, ed.noEnvasa);
  if (!plus.length) throw new Error('Sin productos activos de rubro "Almacen" en Siga.');
  const listas = { noEnvasa: ed.noEnvasa, restringidos: ed.restringidos, productosAlmacen: {}, importanciaMinorista: impViva };
  const inList = plus.map(p => `'${p}'`).join(',');   // IdProducto es varchar en Siga → citar
  const nuevoCfg = distCfg.nuevo || {};
  const nuevoDias = nuevoCfg.dias || 30;
  const pisoImportancia = nuevoCfg.pisoImportancia || 0.8;
  // Piso de reposición del producto nuevo: por defecto el de un clase B (min 4 / S 8).
  const pisosNuevo = { min: nuevoCfg.pisoMin != null ? nuevoCfg.pisoMin : 4,
                       S:   nuevoCfg.pisoS   != null ? nuevoCfg.pisoS   : 8 };
  const compraTipos = (distCfg.tiposMovimientoCompra || ['COMPRA', 'COMPRA-NC']).map(t => `'${t}'`).join(',');
  const [stockRows, nombres, fact, primeraCompraRows] = await Promise.all([
    query(sqlStockDistribucion(plus)),
    query(`SELECT p.IdProducto, p.NombreProducto, r.NombreRubro FROM Productos p LEFT JOIN Rubros r ON r.IdRubro=p.IdRubro WHERE p.IdProducto IN (${inList})`),
    calcularFactLive(),
    query(`SELECT mp.IdProducto, MIN(m.FechaMovimiento) AS Primera
      FROM MovimientosStockProductos mp
      JOIN MovimientosStock m ON m.IdSucursal=mp.IdSucursal AND m.IdTipoMovimiento=mp.IdTipoMovimiento AND m.NumeroMovimiento=mp.NumeroMovimiento
      WHERE mp.IdProducto IN (${inList}) AND mp.IdTipoMovimiento IN (${compraTipos})
      GROUP BY mp.IdProducto`),
  ]);
  const primeraCompraMap = new Map(primeraCompraRows.map(r => [String(r.IdProducto), r.Primera]));
  const umbralNuevo = new Date(Date.now() - nuevoDias * 24 * 60 * 60 * 1000);
  // Producto nuevo = primera COMPRA dentro de nuevo.dias. Única definición del sistema: el A8020
  // marca su badge con el mismo criterio. Da el piso de reposición y el de importancia.
  const esNuevoSet = new Set([...primeraCompraMap.entries()]
    .filter(([, fecha]) => new Date(fecha) >= umbralNuevo)
    .map(([plu]) => plu));
  const nombreMap = new Map(nombres.map(r => [String(r.IdProducto), r.NombreProducto]));
  const rubroMapA = new Map(nombres.map(r => [String(r.IdProducto), r.NombreRubro || '']));
  const idCentralA = distCfg.idCentral || 1;   // sucursal central (SoyLaCentral=1), configurable
  const stocks = new Map();
  for (const r of stockRows) {
    const key = r.IdSucursal === idCentralA ? 'central' : DISTRIB_SUC_MAP[r.IdSucursal]; if (!key) continue;
    const plu = String(r.IdProducto);
    if (!stocks.has(plu)) stocks.set(plu, {});
    const s = stocks.get(plu); s[key] = (s[key] || 0) + parseFloat(r.Stock || 0);
  }
  const productos = plus.map(plu => ({ plu, stocks: stocks.get(plu) || {} }));
  // Fact en vivo por sucursal, ANTES del cálculo: el racionamiento tiene que excluir del
  // pool compartido a las sucursales que van a salir 'Fact' (no consumen stock real), si
  // no le comen cupo al resto (ver spec 2026-07-07... / fix PLU 2121).
  const ALM_FACT_KEY_INTERNO = { riv: 'riv', urq: 'urq', nacion: 'nacion', chaca: 'chaca', pergamino: 'pergamino', sanPedro: 'sanpedro', sucursal9: 'sucu9', sucursal11: 'sucu11' };
  const factGatePorPlu = new Map();
  for (const plu of plus) {
    const set = new Set();
    for (const [ek, fk] of Object.entries(ALM_FACT_KEY))
      if (fact.factByKey[fk] && fact.factByKey[fk].has(Number(plu))) set.add(ALM_FACT_KEY_INTERNO[ek]);
    if (set.size) factGatePorPlu.set(plu, set);
  }
  const filas = calcularAlmacen(productos, a8020, listas, { corregirBugs: true, empujePresencia, empujePresenciaFactorS, presenciaPorClase, abcPorPlu, muPorPlu, sinEmpujeCaroLento, importancia: importanciaCfg, umbralMicroEnvio, pesosRacionado: distCfg.pesosRacionado, esNuevoSet, pisosNuevo, factGatePorPlu });
  // Fact en vivo: lo ya facturado a la sucursal desde su última recepción no se reenvía (enviar→0).
  for (const f of filas) {
    f.factSucs = [];
    for (const [ek, fk] of Object.entries(ALM_FACT_KEY))
      if (fact.factByKey[fk] && fact.factByKey[fk].has(Number(f.plu))) { f.enviar[ek] = 'Fact'; f.factSucs.push(ek); }
  }
  const almOvr = (leerJSON(ENVIOS_MANUALES_PATH, {})).almacen || {};
  for (const f of filas) {
    const ovr = almOvr[String(f.plu)]; if (!ovr) continue;
    f.enviarOverride = {};
    for (const [suc, val] of Object.entries(ovr))
      if (f.enviar[suc] !== 'Fact') { f.enviar[suc] = val; f.enviarOverride[suc] = true; }
  }
  // Prioridad compuesta: facturación (impNorm ya normalizado) + urgencia de stock por
  // sucursal (cuán por debajo del mínimo) + cantidad total a enviar. Ver spec
  // 2026-07-07-prioridad-unificada-design.md.
  const SUC_KEYS_ALM = ['riv', 'urq', 'nacion', 'chaca', 'pergamino', 'sanpedro', 'sucu8', 'sucu9', 'sucu11'];
  let maxCantidad = 0;
  const cantidadPorPlu = new Map();
  for (const f of filas) {
    const total = Object.values(f.ideal || {}).reduce((s, v) => s + (v || 0), 0);
    cantidadPorPlu.set(f.plu, total);
    if (total > maxCantidad) maxCantidad = total;
  }
  for (const f of filas) {
    const rawStk = stocks.get(String(f.plu)) || {};
    const urgencias = SUC_KEYS_ALM.map(k => {
      const min = (f.mins || {})[k];
      if (!(min > 0)) return null;
      return Math.max(0, 1 - (rawStk[k] || 0) / min);
    }).filter(x => x != null);
    const urgenciaStock = urgencias.length ? urgencias.reduce((s, x) => s + x, 0) / urgencias.length : 0;
    const cantidadN = maxCantidad > 0 ? cantidadPorPlu.get(f.plu) / maxCantidad : 0;
    f.impNorm = 0.6 * f.impNorm + 0.25 * urgenciaStock + 0.15 * cantidadN;
  }
  return filas.map(f => {
    const rawStk = stocks.get(String(f.plu)) || {};
    const stkSuc = { riv: rawStk.riv||0, urq: rawStk.urq||0, nacion: rawStk.nacion||0,
      chaca: rawStk.chaca||0, pergamino: rawStk.pergamino||0,
      sanPedro: rawStk.sanpedro||0, sucursal9: rawStk.sucu9||0 };
    const mnA = f.mins || {}, slA = f.sLevels || {};
    const minSuc = { riv: mnA.riv||0, urq: mnA.urq||0, nacion: mnA.nacion||0, chaca: mnA.chaca||0,
      pergamino: mnA.pergamino||0, sanPedro: mnA.sanpedro||0, sucursal9: mnA.sucu9||0 };
    const sSuc = { riv: slA.riv||0, urq: slA.urq||0, nacion: slA.nacion||0, chaca: slA.chaca||0,
      pergamino: slA.pergamino||0, sanPedro: slA.sanpedro||0, sucursal9: slA.sucu9||0 };
    const esNuevo = esNuevoSet.has(String(f.plu));
    const impNorm = esNuevo ? (pisoImportancia + f.impNorm) : f.impNorm;
    const primera = primeraCompraMap.get(String(f.plu));
    return { plu: f.plu, nombre: nombreMap.get(String(f.plu)) || '', rubro: rubroMapA.get(String(f.plu)) || '', central: f.central,
      enviar: f.enviar, enviarOverride: f.enviarOverride || {}, enviarTexto: f.enviarTexto, enviarMicro: f.enviarMicro, ideal: f.ideal, factSucs: f.factSucs, pideTotal: f.pideTotal, importancia: f.importancia, impSuc: f.impSuc, impNorm, meses: f.meses, stkSuc, minSuc, sSuc,
      esNuevo, primeraCompra: primera ? new Date(primera).toISOString().slice(0, 10) : null };
  });
}
router.get('/distribucion', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'distribucion.html')));
router.get('/docs/plan-distribucion.html', (_req, res) => res.sendFile(path.join(__dirname, 'docs', 'plan-distribucion.html')));
router.get('/docs/guia-distribucion.html', (_req, res) => res.sendFile(path.join(__dirname, 'docs', 'guia-distribucion.html')));
router.get('/docs/analisis-distribucion.html', (_req, res) => res.sendFile(path.join(__dirname, 'docs', 'analisis-distribucion.html')));
router.get('/docs/pesables-calculo.html', (_req, res) => res.sendFile(path.join(__dirname, 'docs', 'pesables-calculo.html')));
router.get('/api/distribucion/almacen', apiRoute(async () => calcularDistribucionAlmacen()));
router.get('/api/distribucion/sucursales', apiRoute(async () =>
  query('SELECT IdSucursal, Nombre, SoyLaCentral FROM Sucursales ORDER BY IdSucursal')));

// ── Distribución de pesables/granel (réplica hoja "Pesables") ───────────────────
// IdSucursal Siga → clave motor pesables. Logia(8) SÍ se reparte en pesables; Savio(6) no.
const PES_SUC_MAP = { 5:'riv', 2:'urq', 3:'nacion', 4:'chaca', 10:'pergamino', 7:'sanpedro', 8:'logia', 9:'ramallo', 11:'sucu11' };   // central resuelta por idCentral (config)
async function calcularDistribucionPesables(aplicarOcultar = true) {
  const a8020   = leerJSON(A8020_PATH, {});
  const pesLis  = leerJSON(PESABLES_LISTAS_PATH, {});
  const ed = leerListasDistrib();
  const impViva = (leerJSON(A8020_CALC_PATH, {}) || {}).impFacturacion || {};
  const formulas = pesLis.formulas || {};
  const ocultosLista = aplicarOcultar ? ed.ocultarPesable : [];   // checkbox "Ocultar códigos" en Pesables
  const distLis = { noEnvasa: ed.noEnvasa, restringidos: ed.restringidos, importanciaMinorista: impViva };
  const rubroRows = await query(`SELECT CAST(p.IdProducto AS VARCHAR) AS IdProducto, r.NombreRubro
    FROM Productos p JOIN Rubros r ON r.IdRubro=p.IdRubro
    WHERE p.Activo=1 AND r.NombreRubro='Pesables Fraccionado'`);
  const rubroMapP = new Map(rubroRows.map(r => [r.IdProducto, r.NombreRubro]));
  const basePlus = rubroRows.map(r => r.IdProducto);
  const plus = universoPesables(basePlus, ed.siemprePesable, ed.noEnvasa, ocultosLista);
  if (!plus.length) throw new Error('Sin productos activos de rubro "Pesables Fraccionado" en Siga.');
  const quote = arr => arr.map(p => `'${String(p).replace(/'/g, "''")}'`).join(',');
  // Códigos granel únicos (stock central de granel sale del depósito GRANEL, por código componente).
  const granelCodes = [...new Set(plus.map(p => (formulas[p] || {}).granel).filter(g => g != null).map(String))];
  const distCfgP = leerJSON(DISTRIB_CONFIG_PATH, {});
  const nuevoCfgP = distCfgP.nuevo || {};
  const nuevoDiasP = nuevoCfgP.dias || 30;
  const pisoImportanciaP = nuevoCfgP.pisoImportancia || 0.8;
  const compraTiposP = (distCfgP.tiposMovimientoCompra || ['COMPRA', 'COMPRA-NC']).map(t => `'${t}'`).join(',');
  const [stockRows, granelRows, nombres, fact, primeraCompraRows] = await Promise.all([
    query(sqlStockDistribucion(plus)),   // producto terminado: DisponibleVenta=1 por IdSucursal (central + sucursales)
    granelCodes.length ? query(`SELECT pd.IdProducto, COALESCE(SUM(pd.Stock),0) AS Stock
       FROM ProductosDepositos pd
       INNER JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal
       INNER JOIN Sucursales s ON s.IdSucursal=pd.IdSucursal
       WHERE s.SoyLaCentral=1 AND pd.IdProducto IN (${quote(granelCodes)})
       GROUP BY pd.IdProducto`) : Promise.resolve([]),
    query(`SELECT IdProducto, NombreProducto FROM Productos WHERE IdProducto IN (${quote([...new Set([...plus, ...granelCodes])])})`),
    calcularFactLive(),
    query(`SELECT mp.IdProducto, MIN(m.FechaMovimiento) AS Primera
      FROM MovimientosStockProductos mp
      JOIN MovimientosStock m ON m.IdSucursal=mp.IdSucursal AND m.IdTipoMovimiento=mp.IdTipoMovimiento AND m.NumeroMovimiento=mp.NumeroMovimiento
      WHERE mp.IdProducto IN (${quote(plus)}) AND mp.IdTipoMovimiento IN (${compraTiposP})
      GROUP BY mp.IdProducto`),
  ]);
  const primeraCompraMapP = new Map(primeraCompraRows.map(r => [String(r.IdProducto), r.Primera]));
  const umbralNuevoP = new Date(Date.now() - nuevoDiasP * 24 * 60 * 60 * 1000);
  const esNuevoSetP = new Set([...primeraCompraMapP.entries()]
    .filter(([, fecha]) => new Date(fecha) >= umbralNuevoP)
    .map(([plu]) => plu));
  const nombreMap = new Map(nombres.map(r => [String(r.IdProducto), r.NombreProducto]));
  const granelMap = new Map(granelRows.map(r => [String(r.IdProducto), parseFloat(r.Stock || 0)]));
  const idCentralP = distCfgP.idCentral || 1;   // sucursal central (SoyLaCentral=1), configurable
  const stocks = new Map();
  for (const r of stockRows) {
    const key = r.IdSucursal === idCentralP ? 'central' : PES_SUC_MAP[r.IdSucursal]; if (!key) continue;
    const plu = String(r.IdProducto);
    if (!stocks.has(plu)) stocks.set(plu, {});
    const s = stocks.get(plu); s[key] = (s[key] || 0) + parseFloat(r.Stock || 0);
  }
  const sinGranelSet = new Set(ed.siemprePesableSinGranel.map(String));
  const productos = plus.map(plu => {
    const st = stocks.get(plu) || {};
    const granel = (formulas[plu] || {}).granel;
    st.granel = (granel != null && !sinGranelSet.has(String(plu))) ? (granelMap.get(String(granel)) || 0) : 0;
    return { plu, stocks: st };
  });
  const pesParams = leerJSON(PESABLES_PARAMS_PATH, {});   // pesos de prioridad editables (opcional)
  const empPes = distCfgP.empujeDepositoPesables || {};
  const a8020CalcP = leerJSON(A8020_CALC_PATH, {}) || {};
  const abcPorPluP = a8020CalcP.abc || {};   // clase ABC por PLU (presencia escalada)
  // μ diaria TOTAL del PLU (suma de las 7 sucursales que reparten) → base de la cobertura de
  // depósito. Se restringe a esas claves: 'detalle' también trae logia/sucu11, inactivas en Siga.
  const SUC_MU = Object.keys(SUC_A_CLAVE_S);
  const muPorPluP = {};
  for (const [plu, d] of Object.entries(a8020CalcP.detalle || {}))
    muPorPluP[plu] = SUC_MU.reduce((s, k) => s + ((d[k] && Number(d[k].mu)) || 0), 0);
  const presPorPlu = {};
  for (const plu of plus) presPorPlu[String(plu)] = pesoPresentacionKg(nombreMap.get(String(plu)) || '', (formulas[String(plu)] || {}).cantFormula);
  const filas = calcularPesables(productos, a8020, pesLis, distLis,
    { corregirBugs: true, prioPesos: pesParams.prioPesos, granelCap: pesParams.granelCap,
      empujePresencia: empPes.presencia, empujePresenciaFactorS: empPes.presenciaFactorS,
      presenciaPorClase: empPes.presenciaPorClase, presenciaPorPresentacion: empPes.presenciaPorPresentacion, abcPorPlu: abcPorPluP, presPorPlu,
      coberturaDeposito: distCfgP.coberturaDepositoPesables, muPorPlu: muPorPluP });
  // Fact en vivo: lo ya facturado a la sucursal desde su última recepción no se reenvía.
  for (const f of filas) for (const [k, set] of Object.entries(fact.factByKey))
    if (f.enviar[k] !== undefined && set.has(Number(f.plu))) f.enviar[k] = 'Fact';
  const pesOvr = (leerJSON(ENVIOS_MANUALES_PATH, {})).pesable || {};
  for (const f of filas) {
    const ovr = pesOvr[String(f.plu)]; if (!ovr) continue;
    f.enviarOverride = {};
    for (const [suc, val] of Object.entries(ovr))
      if (f.enviar[suc] !== 'Fact') { f.enviar[suc] = val; f.enviarOverride[suc] = true; }
  }
  return filas.map(f => {
    const esNuevo = esNuevoSetP.has(String(f.plu));
    const primera = primeraCompraMapP.get(String(f.plu));
    const prioridad = esNuevo ? Math.max(f.prioridad, pisoImportanciaP) : f.prioridad;
    const prioridadSala = esNuevo ? Math.max(f.prioridadSala, pisoImportanciaP) : f.prioridadSala;
    return { plu: f.plu, nombre: nombreMap.get(String(f.plu)) || '', rubro: rubroMapP.get(String(f.plu)) || '',
      granel: f.granel, nombreGranel: f.granel != null ? (nombreMap.get(String(f.granel)) || '') : '',
      cantFormula: (formulas[String(f.plu)] || {}).cantFormula ?? 1,
      peso: f.peso, F: f.F, H: f.H, BG: f.BG, enviar: f.enviar, enviarOverride: f.enviarOverride || {}, ideal: f.teorico, CG: f.CG, mins: f.mins, sLev: f.sLev,
      J: f.J, D: f.D, G: f.G, objDep: f.objDep, BL: f.BL, prioridad, prioridadSala,
      granelRatio: f.granelRatio, stkSuc: stocks.get(String(f.plu)) || {},
      esNuevo, primeraCompra: primera ? new Date(primera).toISOString().slice(0, 10) : null };
  });
}
router.get('/api/distribucion/pesables', apiRoute(async (req) => calcularDistribucionPesables(req.query.ocultar !== '0')));
router.get('/api/distribucion/envios-manuales', apiRoute(async () => leerJSON(ENVIOS_MANUALES_PATH, { almacen: {}, pesable: {} })));
router.post('/api/distribucion/envio-override', (req, res) => {
  const { tipo, plu, suc, valor } = req.body || {};
  if (!tipo || !plu || !suc) return res.status(400).json({ error: 'faltan campos' });
  const d = leerJSON(ENVIOS_MANUALES_PATH, { almacen: {}, pesable: {} });
  if (!d[tipo]) d[tipo] = {};
  if (valor === null || valor === undefined) {
    if (d[tipo][String(plu)]) { delete d[tipo][String(plu)][suc]; if (!Object.keys(d[tipo][String(plu)]).length) delete d[tipo][String(plu)]; }
  } else {
    if (!d[tipo][String(plu)]) d[tipo][String(plu)] = {};
    d[tipo][String(plu)][suc] = Number(valor);
  }
  guardarJSON(ENVIOS_MANUALES_PATH, d);
  res.json({ ok: true });
});
router.delete('/api/distribucion/envios-manuales', (req, res) => {
  const { tipo } = req.body || {};
  const d = leerJSON(ENVIOS_MANUALES_PATH, { almacen: {}, pesable: {} });
  if (!tipo || tipo === 'todos') guardarJSON(ENVIOS_MANUALES_PATH, { almacen: {}, pesable: {} });
  else { d[tipo] = {}; guardarJSON(ENVIOS_MANUALES_PATH, d); }
  res.json({ ok: true });
});


// ── Control de insumos ─────────────────────────────────────────────────────────
// Los insumos no se venden: no aparecen en Ventas y el análisis los excluye a
// propósito. Su consumo se lee de los movimientos de stock, donde la Cantidad ya
// viene firmada (negativa = salió del depósito) y la suma de todas las líneas de un
// depósito da exactamente su stock. La matemática vive en insumos.js; acá, las queries.
const INSUMOS_CFG = {
  rubros: insumos.RUBROS,                    // vacío: el rubro de Siga no define un insumo
  prefijoNombre: insumos.PREFIJO_NOMBRE,     // todo producto cuyo nombre arranque con "Insumo"
  idSucursal: 1,         // Casa Central
  depositos: [1],        // su depósito principal; los "Reservado*" no son stock disponible
  ventanaMeses: insumos.VENTANA_MESES,
  umbrales: insumos.UMBRALES,
  tiposExcluidos: insumos.TIPOS_NO_CONSUMO,
  ...(cfg.insumos || {}),
};
const numList = arr => (arr || []).map(Number).filter(n => Number.isInteger(n) && n > 0).join(',');
// Una sola definición de "esto es un insumo" para las dos queries: si divergen,
// el listado y el consumo hablan de universos distintos y nadie se entera.
const ES_INSUMO = insumos.condicionSQL(INSUMOS_CFG);
// El módulo mira dos universos con la misma matemática: los productos "Insumo …" y
// los "Etiqueta …", que son materiales de producto terminado pero se compran, se
// consumen y se reponen igual. Lo único que cambia es el prefijo del nombre; los
// rubros que config.json le sume a insumos no arrastran a las etiquetas.
const ES_ETIQUETA = insumos.condicionSQL({ ...INSUMOS_CFG, rubros: [], prefijoNombre: 'ETIQUETA' });
const condUniverso = tipo => (String(tipo || '') === 'etiqueta' ? ES_ETIQUETA : ES_INSUMO);

function sqlInsumosStock(cond = ES_INSUMO) {
  return `SELECT p.IdProducto, p.NombreProducto, r.NombreRubro, p.EsDeCompras,
    COALESCE((SELECT SUM(pd.Stock) FROM ProductosDepositos pd
              WHERE pd.IdProducto = p.IdProducto AND pd.IdSucursal = ${Number(INSUMOS_CFG.idSucursal)}
                AND pd.IdDeposito IN (${numList(INSUMOS_CFG.depositos)})), 0) AS StockCentral
  FROM Productos p INNER JOIN Rubros r ON r.IdRubro = p.IdRubro
  WHERE p.Activo = 1 AND ${cond}
  ORDER BY p.NombreProducto`;
}

// Salidas y entradas por producto, mes y tipo de movimiento. El mes sale del header
// (MovimientosStock.FechaMovimiento): el detalle no tiene fecha propia.
// filtroPlu acota a un solo insumo, para la vista de detalle.
function sqlInsumosMovimientos(filtroPlu, cond = ES_INSUMO) {
  const plu = filtroPlu ? `AND mp.IdProducto = '${String(filtroPlu).replace(/'/g, "''")}'` : '';
  return `SELECT mp.IdProducto, CONVERT(varchar(7), m.FechaMovimiento, 126) AS Mes, mp.IdTipoMovimiento,
      SUM(CASE WHEN mp.Cantidad < 0 THEN -mp.Cantidad ELSE 0 END) AS Salidas,
      SUM(CASE WHEN mp.Cantidad > 0 THEN  mp.Cantidad ELSE 0 END) AS Entradas
  FROM MovimientosStockProductos mp
  INNER JOIN MovimientosStock m ON m.IdSucursal = mp.IdSucursal
       AND m.IdTipoMovimiento = mp.IdTipoMovimiento AND m.NumeroMovimiento = mp.NumeroMovimiento
  INNER JOIN Productos p ON p.IdProducto = mp.IdProducto
  WHERE ${cond} AND p.Activo = 1
    AND mp.IdSucursal = ${Number(INSUMOS_CFG.idSucursal)}
    AND mp.IdDeposito IN (${numList(INSUMOS_CFG.depositos)})
    AND m.FechaMovimiento >= DATEADD(MONTH, -${Number(INSUMOS_CFG.ventanaMeses)}, CAST(GETDATE() AS DATE)) ${plu}
  GROUP BY mp.IdProducto, CONVERT(varchar(7), m.FechaMovimiento, 126), mp.IdTipoMovimiento`;
}

// Niveles de reposición cargados a mano: { [plu]: { min, max } }. Son criterio de
// quien compra, no una cuenta: por eso se guardan y no se recalculan.
const INSUMOS_NIVELES_PATH = path.join(DATA_DIR, 'insumos_niveles.json');

// Grupos de etiquetas puestos a mano: { [plu]: 'Grupo' }. Sólo las excepciones —
// lo que el nombre ya agrupa bien no se guarda.
const ETIQUETAS_GRUPOS_PATH = path.join(DATA_DIR, 'etiquetas_grupos.json');

const mesActualISO = () => new Date().toISOString().slice(0, 7);
const filaMovInsumo = r => ({ plu: String(r.IdProducto), mes: r.Mes, tipo: r.IdTipoMovimiento,
                              salidas: Number(r.Salidas) || 0, entradas: Number(r.Entradas) || 0 });

router.get('/api/insumos/listado', apiRoute(async (req) => {
  const cond = condUniverso(req.query.tipo);
  const [stockRows, movRows] = await Promise.all([
    query(sqlInsumosStock(cond)), query(sqlInsumosMovimientos(null, cond))]);
  const productos = stockRows.map(r => ({
    plu: String(r.IdProducto), nombre: r.NombreProducto, rubro: r.NombreRubro,
    stock: Number(r.StockCentral) || 0, esDeCompras: !!r.EsDeCompras,
  }));
  const esDeCompras = new Map(productos.map(p => [p.plu, p.esDeCompras]));
  const filas = insumos.calcularListado({
    productos, filasMov: movRows.map(filaMovInsumo), mesActual: mesActualISO(),
    ventanaMeses: INSUMOS_CFG.ventanaMeses, umbrales: INSUMOS_CFG.umbrales,
    tiposExcluidos: INSUMOS_CFG.tiposExcluidos, niveles: leerJSON(INSUMOS_NIVELES_PATH, {}),
  // Las etiquetas viajan con su grupo calculado: el front agrupa por ese string,
  // así la regla de qué es un grupo vive en un solo lado.
  }).map(f => ({ ...f, esDeCompras: esDeCompras.get(f.plu) === true,
                 ...(cond === ES_ETIQUETA
                     ? { grupo: insumos.grupoDe(f.plu, f.nombre, leerJSON(ETIQUETAS_GRUPOS_PATH, {})) }
                     : {}) }));
  return {
    productos: filas, totales: insumos.totales(filas),
    mesActual: mesActualISO(), ventanaMeses: INSUMOS_CFG.ventanaMeses,
    umbrales: INSUMOS_CFG.umbrales, tiposExcluidos: INSUMOS_CFG.tiposExcluidos,
    fechaCalculo: new Date().toISOString(),
  };
}));

// Niveles de reposición. El PUT con min y max vacíos borra el nivel del insumo:
// es la forma de sacarlo del circuito de compra sin inventar otro endpoint.
router.get('/api/insumos/niveles', apiRoute(async () => leerJSON(INSUMOS_NIVELES_PATH, {})));
router.put('/api/insumos/niveles/:plu', (req, res) => {
  const plu = String(req.params.plu || '').trim();
  if (!/^\d+$/.test(plu)) return res.status(400).json({ error: 'PLU inválido' });
  let nivel;
  try { nivel = insumos.normalizarNivel(req.body || {}); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const d = leerJSON(INSUMOS_NIVELES_PATH, {});
  if (nivel) d[plu] = nivel; else delete d[plu];
  guardarJSON(INSUMOS_NIVELES_PATH, d);
  res.json({ ok: true, plu, nivel });
});

// Mover etiquetas de grupo. Se manda { asignaciones: { plu: 'Grupo' | null } }:
// el nombre las trae a ese grupo y null las devuelve al automático. No hay forma de
// dejar un producto sin grupo ni en dos a la vez: cada PLU es una clave del mapa.
router.put('/api/insumos/grupos', (req, res) => {
  const asignaciones = (req.body || {}).asignaciones;
  if (!asignaciones || typeof asignaciones !== 'object' || Array.isArray(asignaciones))
    return res.status(400).json({ error: 'faltan las asignaciones' });
  if (Object.keys(asignaciones).length > 500)
    return res.status(400).json({ error: 'demasiadas asignaciones en una sola vez' });
  let mapa;
  try { mapa = insumos.aplicarAsignaciones(leerJSON(ETIQUETAS_GRUPOS_PATH, {}), asignaciones); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  guardarJSON(ETIQUETAS_GRUPOS_PATH, mapa);
  res.json({ ok: true, grupos: mapa });
});

// De dónde sale el consumo de un insumo: la serie mes a mes, el desglose por tipo de
// movimiento (con cuáles cuentan y cuáles no) y los últimos movimientos crudos.
router.get('/api/insumos/detalle/:plu', apiRoute(async (req) => {
  const plu = String(req.params.plu || '').trim();
  if (!/^\d+$/.test(plu)) throw new Error('PLU inválido');
  const [prodRows, movRows, ultimos] = await Promise.all([
    query(`SELECT TOP 1 p.IdProducto, p.NombreProducto, r.NombreRubro,
             COALESCE((SELECT SUM(pd.Stock) FROM ProductosDepositos pd
                       WHERE pd.IdProducto = p.IdProducto AND pd.IdSucursal = ${Number(INSUMOS_CFG.idSucursal)}
                         AND pd.IdDeposito IN (${numList(INSUMOS_CFG.depositos)})), 0) AS StockCentral
           FROM Productos p INNER JOIN Rubros r ON r.IdRubro = p.IdRubro
           WHERE p.IdProducto = '${plu}'`),
    query(sqlInsumosMovimientos(plu, condUniverso(req.query.tipo))),
    query(`SELECT TOP 40 CONVERT(varchar(19), m.FechaMovimiento, 126) AS Fecha, mp.IdTipoMovimiento,
             mp.NumeroMovimiento, mp.Cantidad, m.Observacion, m.Usuario
           FROM MovimientosStockProductos mp
           INNER JOIN MovimientosStock m ON m.IdSucursal = mp.IdSucursal
                AND m.IdTipoMovimiento = mp.IdTipoMovimiento AND m.NumeroMovimiento = mp.NumeroMovimiento
           WHERE mp.IdProducto = '${plu}' AND mp.IdSucursal = ${Number(INSUMOS_CFG.idSucursal)}
             AND mp.IdDeposito IN (${numList(INSUMOS_CFG.depositos)})
           ORDER BY m.FechaMovimiento DESC`),
  ]);
  const prod = prodRows[0];
  if (!prod) throw new Error('Insumo no encontrado');
  const filas = movRows.map(filaMovInsumo);
  const serie = insumos.serieMensual(filas, INSUMOS_CFG.tiposExcluidos)[plu] || {};
  const resumen = insumos.resumenInsumo({
    plu, nombre: prod.NombreProducto, rubro: prod.NombreRubro,
    stock: Number(prod.StockCentral) || 0, serie, mesActual: mesActualISO(),
    ventanaMeses: INSUMOS_CFG.ventanaMeses, umbrales: INSUMOS_CFG.umbrales,
  });
  return {
    ...resumen, serie,
    porTipo: insumos.desglosePorTipo(filas, INSUMOS_CFG.tiposExcluidos),
    movimientos: ultimos.map(m => ({
      fecha: m.Fecha, tipo: m.IdTipoMovimiento, numero: String(m.NumeroMovimiento),
      cantidad: Number(m.Cantidad) || 0, observacion: (m.Observacion || '').trim(), usuario: m.Usuario,
    })),
  };
}));

// ── A8020 autónomo: puntos de pedido order-up-to calculados desde Siga ──────────
// Spec: docs/superpowers/specs/2026-06-10-a8020-orderupto-design.md
const DISTRIB_OVERRIDES_PATH = path.join(DATA_DIR, 'distribucion_overrides.json');
// Ajustes manuales de S/min por (plu, sucursal). Persisten al recalcular: el cálculo
// escribe lo suyo en detalle[plu][suc].S/.min y estos valores pisan mins/sLevels.
const A8020_MANUAL_PATH = path.join(DATA_DIR, 'a8020_manual.json');

// Escribe data/a8020.json en formato legacy (pesables.js / almacen.js / distribucion.js) desde el caché.
//   minX = punto de pedido (gatillo) · SX = order-up-to (objetivo al que se repone).
const LEGACY_KEY = { riv:'minRiv', urq:'minUrq', nacion:'minNacion', chaca:'minChaca',
  pergamino:'minPergamino', sanpedro:'minSanPedro', logia:'minLogia',
  ramallo:'minVRamallo', sucu11:'minVConst' };
const LEGACY_KEY_S = { riv:'SRiv', urq:'SUrq', nacion:'SNacion', chaca:'SChaca',
  pergamino:'SPergamino', sanpedro:'SSanPedro', logia:'SLogia',
  ramallo:'SVRamallo', sucu11:'SVConst' };
// Ranking por sucursal (percentil 0-1 de importancia del PLU dentro de esa sucursal) → distribucion.js
// lo usa para ponderar la importancia del envío por sucursal en vez del BB global plano.
const LEGACY_KEY_RANK = { riv:'rankRiv', urq:'rankUrq', nacion:'rankNacion', chaca:'rankChaca',
  pergamino:'rankPergamino', sanpedro:'rankSanPedro', ramallo:'rankVRamallo' };
function escribirA8020Legacy(cache) {
  const a8020Legacy = {};
  for (const [plu, sucData] of Object.entries(cache.mins || {})) {
    a8020Legacy[plu] = {};
    for (const [sucKey, m] of Object.entries(sucData)) {
      const lk = LEGACY_KEY[sucKey]; if (lk) a8020Legacy[plu][lk] = m;
      const sk = LEGACY_KEY_S[sucKey]; const sv = ((cache.sLevels || {})[plu] || {})[sucKey];
      if (sk && sv != null) a8020Legacy[plu][sk] = sv;
    }
  }
  for (const [plu, cls] of Object.entries(cache.abc || {})) {
    if (cls === 'F') (a8020Legacy[plu] = a8020Legacy[plu] || {}).claseF = true;
  }
  // Cachés previos a los ajustes manuales no traen rankingPorSucursal: se reconstruye desde detalle
  // para no borrar los rankXxx del legacy al fijar un valor sin recalcular desde Siga.
  let rankSuc = cache.rankingPorSucursal;
  if (!rankSuc) {
    rankSuc = {};
    for (const [plu, porSuc] of Object.entries(cache.detalle || {})) {
      for (const [suc, d] of Object.entries(porSuc)) {
        if (d.ranking != null) (rankSuc[suc] = rankSuc[suc] || {})[plu] = d.ranking;
      }
    }
  }
  for (const [sucKey, porPlu] of Object.entries(rankSuc)) {
    const rk = LEGACY_KEY_RANK[sucKey]; if (!rk) continue;
    for (const [plu, score] of Object.entries(porPlu)) {
      (a8020Legacy[plu] = a8020Legacy[plu] || {})[rk] = score;
    }
  }
  // Ranking general (mismo 0-1, todo el catálogo) → fallback en distribucion.js cuando el PLU no tiene
  // rank en NINGUNA sucursal. Reemplaza el fallback a BB crudo (facturación en miles/millones) que
  // mezclaba escalas con los rankXxx (0-1) y disparaba la importancia de esos PLUs muy por encima del resto.
  for (const [plu, score] of Object.entries(cache.rankingGeneral || {})) {
    (a8020Legacy[plu] = a8020Legacy[plu] || {}).rankGeneral = score;
  }
  guardarJSON(A8020_PATH, a8020Legacy);
  return a8020Legacy;
}
// Reaplica los ajustes manuales sobre el caché ya calculado y reescribe el legacy.
// Evita tener que recalcular desde Siga (que tarda minutos) al fijar/quitar un valor.
function reaplicarManualA8020() {
  const cache = leerJSON(A8020_CALC_PATH, null);
  if (!cache || cache.vacio || !cache.detalle) return null;
  // Sin pesablesSet en vivo (esto a propósito no consulta Siga): aplicarManualA8020 cae al
  // cache.pesables que dejó el último recálculo y, si tampoco está, al rubro del caché.
  // En los dos casos almacén queda en enteros.
  aplicarManualA8020(cache, leerJSON(A8020_MANUAL_PATH, {}));
  guardarJSON(A8020_CALC_PATH, cache);
  escribirA8020Legacy(cache);
  return cache;
}
// Filtros comunes: venta al cliente final por sucursal (excluye ANULADO y comprobantes a clientes categoría SUCURSAL).
function _ventasWhere(idList, meses) {
  return `v.Fecha >= DATEADD(MONTH,-${meses},CAST(GETDATE() AS DATE)) AND v.Fecha < CAST(GETDATE() AS DATE)
    AND ISNULL(v.IdEstadoComprobante,'') != 'ANULADO' AND v.IdSucursal IN (${idList})
    AND UPPER(ISNULL(cat.NombreCategoria,'')) != 'SUCURSAL'`;
}
function sqlVentasStats(idList, meses) {   // μ,σ: agrega a día, luego Σq y Σq² por (sucursal, producto)
  return `;WITH vd AS (
    SELECT v.IdSucursal, vp.IdProducto, CAST(v.Fecha AS DATE) AS Dia, SUM(vp.Cantidad) AS QDia
    FROM VentasProductos vp ${_ventasJoin}
    WHERE ${_ventasWhere(idList, meses)}
    GROUP BY v.IdSucursal, vp.IdProducto, CAST(v.Fecha AS DATE))
  SELECT IdSucursal, IdProducto, COUNT(*) AS DiasConVenta, MIN(Dia) AS PrimeraVenta, SUM(QDia) AS SumQ, SUM(QDia*QDia) AS SumQ2
  FROM vd GROUP BY IdSucursal, IdProducto`;
}
function sqlDiasOperativos(idList, meses) {   // días con algún comprobante por sucursal (denominador N)
  return `SELECT v.IdSucursal, COUNT(DISTINCT CAST(v.Fecha AS DATE)) AS DiasOperativos
  FROM Ventas v
  LEFT JOIN Clientes c ON c.IdCliente=v.IdCliente LEFT JOIN Categorias cat ON cat.IdCategoria=c.IdCategoria
  WHERE ${_ventasWhere(idList, meses)}
  GROUP BY v.IdSucursal`;
}
function sqlAbcMetric(idList, meses, metrica) {   // métrica ABC por PLU (facturación o unidades)
  const col = metrica === 'unidades' ? 'vp.Cantidad' : 'vp.ImporteTotalNeto';
  return `SELECT vp.IdProducto, SUM(${col}) AS Metric
  FROM VentasProductos vp ${_ventasJoin}
  WHERE ${_ventasWhere(idList, meses)}
  GROUP BY vp.IdProducto`;
}
function sqlAbcMetricPorSucursal(idList, meses, metrica) {   // métrica ABC por (sucursal, PLU) — ranking local
  const col = metrica === 'unidades' ? 'vp.Cantidad' : 'vp.ImporteTotalNeto';
  return `SELECT vp.IdSucursal, vp.IdProducto, SUM(${col}) AS Metric
  FROM VentasProductos vp ${_ventasJoin}
  WHERE ${_ventasWhere(idList, meses)}
  GROUP BY vp.IdSucursal, vp.IdProducto`;
}
// Consumo real por (sucursal, producto): la imputación vive en a8020.js (pura y testeable);
// acá sólo se resuelven las fórmulas activas de los bultos con venta, que salen de Siga.
async function consumoRealA8020(statRows, sucById, rubroDePlu, formulasPesables) {
  const norm = (v) => String(v == null ? '' : v).trim();
  const bultos = [...new Set(statRows.filter(r => rubroDePlu[norm(r.plu)] === RUBRO_ALMACEN_BULTO).map(r => norm(r.plu)))];
  let compsPorBulto = new Map();
  if (bultos.length) {
    try { compsPorBulto = await componentesFormulaPorPadre(bultos); }
    catch (e) { console.error('[a8020/consumo] fórmulas de bultos:', e.message); }
  }
  return calcularConsumoReal(statRows, sucById, rubroDePlu, formulasPesables, compsPorBulto);
}
async function recalcularA8020() {
  const config = leerJSON(DISTRIB_CONFIG_PATH, {});
  const pesLis = leerJSON(PESABLES_LISTAS_PATH, {});
  const overrides = leerJSON(DISTRIB_OVERRIDES_PATH, {});
  const sucs = config.sucursales || {};
  const idList = Object.values(sucs).map(s => s.idSucursal).join(',');
  if (!idList) throw new Error('Falta data/distribucion_config.json (sucursales).');
  const meses = config.ventanaMeses || 12;
  const metrica = (config.abc || {}).metrica || 'facturacion';
  const [stats, ops, abcRows, abcRowsPorSuc] = await Promise.all([
    query(sqlVentasStats(idList, meses)),
    query(sqlDiasOperativos(idList, meses)),
    query(sqlAbcMetric(idList, meses, metrica)),
    query(sqlAbcMetricPorSucursal(idList, meses, metrica)),
  ]);
  const opsDays = {}; for (const r of ops) opsDays[r.IdSucursal] = Number(r.DiasOperativos) || 0;
  const metricByPlu = {}; for (const r of abcRows) metricByPlu[String(r.IdProducto)] = Number(r.Metric) || 0;
  const metricPorSuc = {};
  for (const r of abcRowsPorSuc) {
    (metricPorSuc[r.IdSucursal] = metricPorSuc[r.IdSucursal] || {})[String(r.IdProducto)] = Number(r.Metric) || 0;
  }
  const sucById = {};
  for (const [key, c] of Object.entries(sucs)) sucById[c.idSucursal] = key;
  // Denominador 'desde_alta': días operativos de la sucursal escalados a la fracción de ventana en que el
  // producto ya existía (desde su 1ª venta). Maduros → fracción≈1 → ≈ operativos; nuevos → dividido por su vida real.
  const denomMode = (config.demanda || {}).denominador || 'operativos';
  const MS_DIA = 86400000;
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const winStart = new Date(hoy); winStart.setMonth(winStart.getMonth() - meses);
  const winDias = Math.max(1, Math.round((hoy - winStart) / MS_DIA));
  const statRows = stats.map(r => {
    const dcv = Number(r.DiasConVenta) || 0;
    const row = { idSucursal: r.IdSucursal, plu: r.IdProducto,
      sumQ: Number(r.SumQ) || 0, sumQ2: Number(r.SumQ2) || 0, dcv,
      opsEff: opsDays[r.IdSucursal] || 0 };
    if (denomMode === 'desde_alta' && r.PrimeraVenta) {
      const pv = new Date(r.PrimeraVenta); pv.setHours(0, 0, 0, 0);
      const ini = pv < winStart ? winStart : pv;
      const frac = Math.min(1, Math.max(1, Math.round((hoy - ini) / MS_DIA)) / winDias);
      // opsEff nunca por debajo de dcv: los días-con-venta son subconjunto de los operativos. En sucursales
      // nuevas (opsDays chico) la fracción-calendario subestima y dispara μ→∞, σ→0; el piso en dcv lo corrige.
      row.opsEff = Math.max(dcv, 1, Math.round((opsDays[r.IdSucursal] || 0) * frac));
    }
    return row;
  });
  const dcvMap = {};
  for (const r of stats) {
    if (!dcvMap[r.IdSucursal]) dcvMap[r.IdSucursal] = {};
    dcvMap[r.IdSucursal][r.IdProducto] = Number(r.DiasConVenta) || 0;
  }
  const edAlm = leerListasDistrib();
  // Universo bootstrap = TODOS los productos activos de Siga (cualquier rubro), en vivo.
  // Antes se derivaba de archivos estáticos (distribucion_listas/pesables_listas): productos nuevos o
  // sin ventas en la ventana quedaban invisibles en a8020 aunque distribución sí los mostrara (p.ej. PLU 5738,
  // rubro Almacen sin ventas + ausente del snapshot viejo → no aparecía ni recalculando).
  const activosRows = await query(`SELECT CAST(p.IdProducto AS VARCHAR) AS IdProducto, r.NombreRubro, p.NombreProducto, m.NombreMarca
    FROM Productos p LEFT JOIN Rubros r ON r.IdRubro=p.IdRubro LEFT JOIN Marcas m ON m.IdMarca=p.IdMarca
    WHERE p.Activo=1`);
  const rubroActivo = {};   // plu → rubro Siga (semilla de rubroDePlu; evita re-consultar todo el universo)
  for (const r of activosRows) rubroActivo[String(r.IdProducto)] = r.NombreRubro || null;
  // Pesables (para decimales fraccionarios en min/S): rubro 'Pesables Fraccionado' en vivo + lista manual siemprePesable.
  const pesablesSet = new Set([
    ...activosRows.filter(r => r.NombreRubro === 'Pesables Fraccionado').map(r => Number(r.IdProducto)),
    ...(edAlm.siemprePesable || []).map(Number),
  ]);
  const bootstrapSet = new Set(activosRows.map(r => Number(r.IdProducto)));
  // Productos propios (marca/nombre Apidelta + mixes de la casa): llevan boost sobre el nivel calculado.
  const boostFactor = config.boostApidelta != null ? config.boostApidelta : BOOST_APIDELTA_DEFAULT;
  const boostSet = new Set(activosRows.filter(r => esProductoApidelta(r.NombreProducto, r.NombreMarca)).map(r => Number(r.IdProducto)));
  const { abc, filas } = computeA8020(statRows, opsDays, metricByPlu, config, pesablesSet, overrides, boostSet);
  const ranking = calcularRankingPorSucursal(metricPorSuc, sucById);
  const rankingGeneral = calcularRankingGlobal(metricByPlu);   // importancia general del producto (0-1, todo el catálogo, sin distinguir sucursal)

  // Índice de crudos por (idSucursal, plu) para exponer volumen/denominador en el detalle (diagnóstico).
  const statIdx = {};
  for (const r of statRows) (statIdx[r.idSucursal] = statIdx[r.idSucursal] || {})[r.plu] = r;
  const mins = {}, sLevels = {}, detalle = {};
  for (const f of filas) {
    (mins[f.plu] = mins[f.plu] || {})[f.sucursal] = f.min;
    (sLevels[f.plu] = sLevels[f.plu] || {})[f.sucursal] = f.S;
    const rk = (ranking[f.sucursal] || {})[String(f.plu)];
    const sr = (statIdx[f.idSucursal] || {})[f.plu];
    (detalle[f.plu] = detalle[f.plu] || {})[f.sucursal] =
      { mu: Math.round(f.mu * 1000) / 1000, sigma: Math.round(f.sigma * 1000) / 1000, S: f.S, min: f.min,
        ...(rk != null ? { ranking: rk } : {}),
        ...(sr ? { sumQ: sr.sumQ, dcv: sr.dcv, opsEff: sr.opsEff } : {}),
        ...(f.propBase ? { propBase: f.propBase, propSoloBase: !!f.propSoloBase } : {}) };
  }
  // ── Bootstrap: PLUs pesables sin historial → interpola μ/σ por rubro ─────────
  const prodPesInfo = pesLis.productosPesables || {};
  // Rubro por producto (desde Siga) → habilita el promedio-por-rubro también en ALMACÉN, no sólo pesables.
  const rubroDePlu = { ...rubroActivo };   // ya trae el rubro de TODO el universo activo (una sola query arriba)
  // Sólo falta el rubro de PLUs con ventas pero inactivos (no vienen en activosRows): consulta acotada.
  const plusRubroFaltante = [...new Set(filas.map(f => String(f.plu)))].filter(p => !(p in rubroDePlu));
  if (plusRubroFaltante.length) {
    const inL = plusRubroFaltante.map(p => `'${p}'`).join(',');
    const rr = await query(`SELECT p.IdProducto, r.NombreRubro FROM Productos p LEFT JOIN Rubros r ON r.IdRubro=p.IdRubro WHERE p.IdProducto IN (${inL})`);
    for (const x of rr) rubroDePlu[String(x.IdProducto)] = x.NombreRubro || null;
  }
  const rubroOf = (plu) => rubroDePlu[String(plu)] || (prodPesInfo[String(plu)] || {}).rubro || null;
  // Índice rubro → sucKey → {sumMu, sumSigma, n} a partir de filas ya calculadas
  const rubroIdx = {};
  for (const f of filas) {
    const rubro = rubroOf(f.plu);
    if (!rubro) continue;
    if (!rubroIdx[rubro]) rubroIdx[rubro] = {};
    const rs = rubroIdx[rubro][f.sucursal] = rubroIdx[rubro][f.sucursal] || { sumMu: 0, sumSigma: 0, n: 0 };
    rs.sumMu += f.mu; rs.sumSigma += f.sigma; rs.n++;
  }
  // Índice sucursal → plu → {mu, sigma} para baseSucursal
  const filaSucPlu = {};
  for (const f of filas) {
    if (!filaSucPlu[f.sucursal]) filaSucPlu[f.sucursal] = {};
    filaSucPlu[f.sucursal][f.plu] = { mu: f.mu, sigma: f.sigma };
  }
  const bootstrapped = new Set();
  const sucConf = config.sucursales || {};
  const zConf = config.servicio || { A: 2.05, B: 1.645, C: 1.28 };
  const techoDefault = config.techoDefault || 10000;
  const kFrac = config.minFraccion || { A: 0.7, B: 0.5, C: 0.35 };
  // Calcula ambos niveles {min, S}. S = order-up-to; min = S·k[clase] (gatillo). min ≤ S.
  const levelsOf = (sc, mu, sigma, cls, plu) => {
    const TL = (sc.T || 0) + (sc.L || 0);
    const zc = zConf[cls || 'C'] ?? zConf.C;
    const o = overrides[String(plu)] || {};
    const mult = o.mult ?? 1, piso = o.pisoManual ?? 0, techo = o.techo ?? techoDefault;
    const dec = pesablesSet.has(Number(plu)) ? 1 : 0;
    const k = kFrac[cls || 'C'] ?? kFrac.C ?? 0.35;
    const boost = boostDePlu(plu, boostSet, boostFactor);
    const S = TL <= 0 ? 0 : roundDec(Math.min(Math.max((mu * TL + zc * sigma * Math.sqrt(TL)) * mult * boost, 0), techo), dec);
    const min = S <= 0 ? 0 : roundDec(Math.min(Math.max(S * k, piso), S), dec);
    // El redondeo (S=1 → min=round(0.5)=1) y el pisoManual pueden dejar min == S: sin brecha el
    // envío teórico es 0 y la sucursal gatilla sin reponer nada. asegurarBrechaMinS sube S.
    return asegurarBrechaMinS(min, S, dec);
  };
  // ── Nivelación: sucursales con pocos días-con-venta → mezcla con base sucursal o promedio rubro ──
  const nivelCfg = config.nivelacion || {};
  const nivelMinDias = nivelCfg.minDiasConVenta || 0;
  const nivelSucs = nivelCfg.sucursales ? new Set(nivelCfg.sucursales) : new Set(Object.keys(sucConf));
  const baseSucursal = nivelCfg.baseSucursal || {};
  if (nivelMinDias > 0 || Object.keys(baseSucursal).length > 0) {
    for (const f of filas) {
      if (!nivelSucs.has(f.sucursal)) continue;
      const baseKey = baseSucursal[f.sucursal];
      const dcv = (dcvMap[f.idSucursal] || {})[f.plu] || 0;
      if (!baseKey && dcv >= nivelMinDias) continue;
      const w = baseKey ? 1 : (1 - dcv / nivelMinDias);
      let mu_base, sig_base, baseLabel;
      if (baseKey && filaSucPlu[baseKey] && filaSucPlu[baseKey][f.plu]) {
        const bf = filaSucPlu[baseKey][f.plu];
        mu_base = bf.mu; sig_base = bf.sigma; baseLabel = baseKey;
      } else {
        const rubro = rubroOf(f.plu);
        const rs = rubro && rubroIdx[rubro] && rubroIdx[rubro][f.sucursal];
        if (!rs || rs.n === 0) continue;
        mu_base = rs.sumMu / rs.n; sig_base = rs.sumSigma / rs.n; baseLabel = 'rubro';
      }
      const mu_new = (1 - w) * f.mu + w * mu_base;
      const sig_new = (1 - w) * f.sigma + w * sig_base;
      const sc = sucConf[f.sucursal] || {};
      const TL = (sc.T || 0) + (sc.L || 0);
      if (TL <= 0) continue;
      const { S: S_new, min: min_new } = levelsOf(sc, mu_new, sig_new, abc[String(f.plu)], f.plu);
      f.mu = mu_new; f.sigma = sig_new; f.S = S_new; f.min = min_new;
      mins[f.plu][f.sucursal] = min_new;
      sLevels[f.plu][f.sucursal] = S_new;
      detalle[f.plu][f.sucursal] = { mu: roundDec(mu_new, 3), sigma: roundDec(sig_new, 3), S: S_new, min: min_new, nivelado: true, dcv, w: roundDec(w, 2), base: baseLabel };
    }
  }
  for (const plu of bootstrapSet) {
    const rubro = rubroOf(plu);
    if (!rubro || !rubroIdx[rubro]) continue;
    const rubroSucs = rubroIdx[rubro];
    const yaTenia = !!mins[String(plu)];   // tenía datos reales/nivelados en alguna sucursal
    let anyS = false;
    for (const [sucKey, sucCfg] of Object.entries(sucConf)) {
      if ((mins[String(plu)] || {})[sucKey] != null) continue;   // esta sucursal ya tiene (real o nivelado) → no pisar
      const baseK = baseSucursal[sucKey];
      const rs = (baseK && rubroSucs[baseK]) ? rubroSucs[baseK] : rubroSucs[sucKey];
      if (!rs || rs.n === 0) continue;
      const mu = rs.sumMu / rs.n;
      const sigma = rs.sumSigma / rs.n;
      const TL = (sucCfg.T || 0) + (sucCfg.L || 0);
      if (TL <= 0) continue;
      const { S, min } = levelsOf(sucCfg, mu, sigma, 'C', plu);
      (mins[String(plu)] = mins[String(plu)] || {})[sucKey] = min;
      (sLevels[String(plu)] = sLevels[String(plu)] || {})[sucKey] = S;
      (detalle[String(plu)] = detalle[String(plu)] || {})[sucKey] =
        { mu: Math.round(mu * 1000) / 1000, sigma: Math.round(sigma * 1000) / 1000, S, min, bootstrap: true, base: baseK || 'rubro' };
      anyS = true;
    }
    // Sin datos previos → producto nuevo: clase C + marca bootstrap. Con datos previos (relleno parcial)
    // conserva su clasificación; las sucursales rellenadas quedan marcadas bootstrap en detalle.
    if (anyS && !yaTenia) { abc[String(plu)] = 'C'; bootstrapped.add(String(plu)); }
  }
  // Fill-in: PLUs con datos en otras suc pero sin S en sucursales con baseSucursal
  for (const [sucKey, baseKey] of Object.entries(baseSucursal)) {
    const sc = sucConf[sucKey]; if (!sc) continue;
    const TL = (sc.T || 0) + (sc.L || 0); if (TL <= 0) continue;
    for (const [plu, sucs] of Object.entries(mins)) {
      if (sucs[sucKey] != null) continue;
      const bf = (filaSucPlu[baseKey] || {})[Number(plu)];
      if (!bf) continue;
      const { mu, sigma } = bf;
      const { S, min } = levelsOf(sc, mu, sigma, abc[plu], plu);
      sucs[sucKey] = min;
      (sLevels[plu] = sLevels[plu] || {})[sucKey] = S;
      (detalle[plu] = detalle[plu] || {})[sucKey] = { mu: roundDec(mu, 3), sigma: roundDec(sigma, 3), S, min, fillIn: true, base: baseKey };
    }
  }

  // ── Clasificación: Nuevo y F ──────────────────────────────────────────────────
  //   Nuevo → primera COMPRA dentro de nuevo.dias. Única definición de "producto nuevo" en todo el
  //           sistema: la misma que usa distribución para el piso de reposición y de importancia.
  //   F     → cero ventas + movimientos no-compra anteriores al umbral de meses → stock muerto
  //           (min/S=0, sin empuje). Ser Nuevo gana sobre F.
  const salesSet = new Set(statRows.map(r => String(r.plu)));
  const compraTipos = config.tiposMovimientoCompra || ['COMPRA', 'COMPRA-NC'];
  const umbralNuevo = config.antiguedadMesesNuevo ?? 3;
  const nuevoDias = (config.nuevo || {}).dias || 30;
  const compraInNuevos = compraTipos.map(t => `'${t}'`).join(',') || `''`;
  // HAVING sobre la primera compra: devuelve sólo los recién incorporados, no todo el catálogo.
  const nuevosSet = new Set();
  {
    const rows = await query(`SELECT mp.IdProducto
      FROM MovimientosStockProductos mp
      INNER JOIN MovimientosStock m ON m.IdSucursal=mp.IdSucursal AND m.IdTipoMovimiento=mp.IdTipoMovimiento AND m.NumeroMovimiento=mp.NumeroMovimiento
      WHERE mp.IdTipoMovimiento IN (${compraInNuevos})
      GROUP BY mp.IdProducto
      HAVING MIN(m.FechaMovimiento) >= DATEADD(DAY, -${nuevoDias}, CAST(GETDATE() AS DATE))`);
    for (const r of rows) nuevosSet.add(String(r.IdProducto));
  }
  const candNoVenta = [...bootstrapSet].map(String).filter(p => !salesSet.has(p) && !nuevosSet.has(p));
  // F = existe un movimiento NO-compra anterior al umbral (actividad vieja sin ventas). Resto = Nuevo.
  // Existence check con filtro de fecha+tipo: mucho más liviano que agregar MIN sobre toda la tabla.
  const esViejo = new Set();
  if (candNoVenta.length) {
    const compraIn = compraTipos.map(t => `'${t}'`).join(',') || `''`;
    const CH = 1000;
    for (let i = 0; i < candNoVenta.length; i += CH) {
      const chunk = candNoVenta.slice(i, i + CH).map(p => `'${p}'`).join(',');
      // MovimientosStockProductos: detalle con IdProducto; la fecha vive en el header MovimientosStock.
      const rows = await query(`SELECT DISTINCT mp.IdProducto
        FROM MovimientosStockProductos mp
        INNER JOIN MovimientosStock m ON m.IdSucursal=mp.IdSucursal AND m.IdTipoMovimiento=mp.IdTipoMovimiento AND m.NumeroMovimiento=mp.NumeroMovimiento
        WHERE mp.IdProducto IN (${chunk})
          AND mp.IdTipoMovimiento NOT IN (${compraIn})
          AND m.FechaMovimiento < DATEADD(MONTH, -${umbralNuevo}, CAST(GETDATE() AS DATE))`);
      for (const r of rows) esViejo.add(String(r.IdProducto));
    }
  }
  const nuevos = [], viejos = [];
  for (const plu of nuevosSet) {
    if (!mins[plu]) continue;   // sin niveles calculados no aparece en la tabla
    nuevos.push(Number(plu));
    for (const sk of Object.keys(detalle[plu] || {})) detalle[plu][sk].nuevo = true;
  }
  for (const plu of candNoVenta) {
    if (!esViejo.has(plu)) continue;
    viejos.push(Number(plu)); abc[plu] = 'F';   // escribirA8020Legacy deriva claseF de abc
    if (mins[plu]) for (const sk of Object.keys(mins[plu])) mins[plu][sk] = 0;
    if (sLevels[plu]) for (const sk of Object.keys(sLevels[plu])) sLevels[plu][sk] = 0;
    if (detalle[plu]) for (const sk of Object.keys(detalle[plu])) { detalle[plu][sk].S = 0; detalle[plu][sk].min = 0; detalle[plu][sk].viejo = true; }
    bootstrapped.delete(plu);
  }

  // Consumo real (informativo): rastrea la venta hasta el producto que sale del stock —
  // bultos → componentes de la fórmula, fraccionado → kg del granel.
  const { consumo, consumoOrigen } = await consumoRealA8020(statRows, sucById, rubroDePlu, pesLis.formulas || {});
  // Un granel puede recibir consumo sin tener niveles propios (no se vende suelto en ninguna
  // sucursal): igual entra en `plus` para que la tabla le arme la fila y muestre su nombre.
  const plus = [...new Set([...Object.keys(mins), ...Object.keys(consumo)])];
  const nombres = {};
  if (plus.length) {
    const inList = plus.map(p => `'${p}'`).join(',');
    const rows = await query(`SELECT IdProducto, NombreProducto FROM Productos WHERE IdProducto IN (${inList})`);
    for (const r of rows) nombres[String(r.IdProducto)] = r.NombreProducto;
  }
  // Ranking por sucursal: mergear al final. Nivelación/bootstrap/fillIn (arriba) reconstruyen
  // detalle[plu][sucursal] desde cero y pisan el merge inicial hecho junto con `filas` — sin este
  // segundo pase, cualquier PLU nivelado/bootstrapped pierde su ranking en la UI aunque exista.
  for (const [sucKey, porPlu] of Object.entries(ranking)) {
    for (const [plu, score] of Object.entries(porPlu)) {
      if (detalle[plu] && detalle[plu][sucKey]) detalle[plu][sucKey].ranking = score;
    }
  }
  const cache = { timestamp: new Date().toISOString(), ventanaMeses: meses,
    metricaABC: (config.abc || {}).metrica || 'facturacion', opsDays, abc, mins, sLevels, detalle, nombres,
    bootstrapped: [...bootstrapped], nuevos, viejos, rubros: rubroDePlu, impFacturacion: metricByPlu,
    // Qué PLUs admiten decimales, para que reaplicarManualA8020 pueda redondear sin volver a Siga.
    pesables: [...pesablesSet],
    boostApidelta: { factor: boostFactor, plus: [...boostSet] },
    consumo, consumoOrigen,
    rankingGeneral, rankingPorSucursal: ranking };
  // Ajustes manuales: se aplican SIEMPRE al final, así el recálculo nunca los pisa. El
  // pesablesSet en vivo garantiza el redondeo: almacén entero, pesables con un decimal.
  aplicarManualA8020(cache, leerJSON(A8020_MANUAL_PATH, {}), pesablesSet);
  guardarJSON(A8020_CALC_PATH, cache);
  escribirA8020Legacy(cache);

  // Resumen para la respuesta (no vuelca todo)
  const distAbc = { A: 0, B: 0, C: 0 };
  for (const v of Object.values(abc)) distAbc[v] = (distAbc[v] || 0) + 1;
  const conS = filas.filter(f => f.S > 0).length;
  const ejemplos = Object.entries(detalle).slice(0, 6).map(([plu, suc]) => ({ plu: Number(plu), suc }));
  return { timestamp: cache.timestamp, ventanaMeses: meses, opsDays,
    productos: Object.keys(mins).length, paresSucursalProducto: filas.length, conEnvioPosible: conS,
    distribucionABC: distAbc, ejemplos };
}
router.get('/api/distribucion/a8020/recalcular', apiRoute(async () => recalcularA8020()));
router.get('/api/distribucion/a8020', apiRoute(async () => leerJSON(A8020_CALC_PATH, { vacio: true })));

// ── Serie mensual de consumo (predicción de compra) ────────────────────────────
// Ventas por (mes, sucursal, producto). Mismos filtros que el resto del sistema:
// sin comprobantes anulados y sin clientes categoría SUCURSAL (transferencias internas).
function sqlVentasMensuales(idList, meses) {
  return `SELECT CONVERT(varchar(7), v.Fecha, 126) AS Mes, v.IdSucursal, vp.IdProducto,
      SUM(vp.Cantidad) AS Cant
    FROM VentasProductos vp ${_ventasJoin}
    WHERE ${_ventasWhere(idList, meses)}
    GROUP BY CONVERT(varchar(7), v.Fecha, 126), v.IdSucursal, vp.IdProducto`;
}

// Consumo de componentes por producción, por mes. En el movimiento de producción el
// consumo se registra NEGATIVO y el alta de terminados POSITIVO (ver
// lineasProduccionDesdeConciliacion): por eso sólo cuentan las líneas negativas.
// Salvedad conocida: el sobrante devuelto al depósito de diferencias también es
// positivo y no se descuenta, así que el consumo por producción queda apenas
// sobreestimado cuando hubo devolución.
// tipoMovimiento acepta uno o varios tipos: la producción se registró históricamente como
// BIENESUSO y desde el cambio de tipos va como REC-SUC, así que la ventana de 24 meses tiene
// que mirar los dos o el histórico desaparece de la serie.
function sqlProduccionMensual(tipoMovimiento, meses) {
  const tipos = (Array.isArray(tipoMovimiento) ? tipoMovimiento : [tipoMovimiento])
    .map(t => String(t || '').trim())
    .filter(Boolean)
    .map(t => `'${t.replace(/'/g, "''")}'`);
  if (!tipos.length) throw new Error('sqlProduccionMensual requiere al menos un tipo de movimiento');
  return `SELECT CONVERT(varchar(7), m.FechaMovimiento, 126) AS Mes, mp.IdProducto,
      SUM(CASE WHEN mp.Cantidad < 0 THEN -mp.Cantidad ELSE 0 END) AS Cant
    FROM MovimientosStockProductos mp
    INNER JOIN MovimientosStock m ON m.IdSucursal=mp.IdSucursal
      AND m.IdTipoMovimiento=mp.IdTipoMovimiento AND m.NumeroMovimiento=mp.NumeroMovimiento
    WHERE mp.IdTipoMovimiento IN (${tipos.join(', ')})
      AND m.FechaMovimiento >= DATEADD(MONTH,-${meses},CAST(GETDATE() AS DATE))
      AND m.FechaMovimiento < CAST(GETDATE() AS DATE)
    GROUP BY CONVERT(varchar(7), m.FechaMovimiento, 126), mp.IdProducto`;
}

// Serie mensual imputada al producto que realmente sale del stock. Reusa la misma
// imputación que A8020 (bulto → componentes, fraccionado → granel), aplicada mes a mes.
async function recalcularConsumoMensual() {
  const config = leerJSON(DISTRIB_CONFIG_PATH, {});
  const pesLis = leerJSON(PESABLES_LISTAS_PATH, {});
  const sucs = config.sucursales || {};
  const idList = Object.values(sucs).map(s => s.idSucursal).join(',');
  if (!idList) throw new Error('Falta data/distribucion_config.json (sucursales).');
  const meses = 24;
  const sucById = {};
  for (const [key, c] of Object.entries(sucs)) sucById[c.idSucursal] = key;

  const rubroRows = await query(`SELECT CAST(p.IdProducto AS VARCHAR) AS IdProducto, r.NombreRubro
    FROM Productos p LEFT JOIN Rubros r ON r.IdRubro=p.IdRubro`);
  const rubroDePlu = {};
  for (const r of rubroRows) rubroDePlu[String(r.IdProducto).trim()] = r.NombreRubro || null;

  const tipoProd  = (leerJSON(path.join(__dirname, 'config.json'), {}).produccion || {}).idTipoMovimiento || 'BIENESUSO';
  // BIENESUSO siempre se incluye: es el tipo con el que se registró la producción hasta el
  // cambio a REC-SUC y sigue siendo el único dato de los meses anteriores.
  const tiposProd = [...new Set([tipoProd, 'BIENESUSO'])];
  const [ventasRows, prodRows] = await Promise.all([
    query(sqlVentasMensuales(idList, meses)),
    query(sqlProduccionMensual(tiposProd, meses)).catch((e) => {
      console.error('[consumo-mensual] producción:', e.message);
      return [];
    }),
  ]);

  // Ventas: se imputan mes a mes con la misma regla que A8020.
  const porMes = {};            // mes → statRows para calcularConsumoReal
  const ventasPorSucursal = {}; // plu → mes → suc → cantidad (crudo, sin imputar)
  for (const r of ventasRows) {
    const mes = String(r.Mes);
    (porMes[mes] = porMes[mes] || []).push({ idSucursal: r.IdSucursal, plu: r.IdProducto, sumQ: Number(r.Cant) || 0 });
    const plu = String(r.IdProducto).trim();
    const suc = sucById[r.IdSucursal];
    if (!suc) continue;
    const porPlu = ventasPorSucursal[plu] = ventasPorSucursal[plu] || {};
    (porPlu[mes] = porPlu[mes] || {})[suc] = Number(r.Cant) || 0;
  }

  // Fórmulas de los bultos con venta en cualquier mes: una sola consulta para todos.
  const bultos = [...new Set(ventasRows
    .filter(r => rubroDePlu[String(r.IdProducto).trim()] === RUBRO_ALMACEN_BULTO)
    .map(r => String(r.IdProducto).trim()))];
  let compsPorBulto = new Map();
  if (bultos.length) {
    try { compsPorBulto = await componentesFormulaPorPadre(bultos); }
    catch (e) { console.error('[consumo-mensual] fórmulas de bultos:', e.message); }
  }

  const consumoMensual = {};
  const anotar = (plu, mes, campo, cantidad) => {
    if (!(cantidad > 0)) return;
    const p = String(plu).trim();
    const porPlu = consumoMensual[p] = consumoMensual[p] || {};
    const celda = porPlu[mes] = porPlu[mes] || { ventas: 0, produccion: 0, total: 0 };
    celda[campo] = Math.round((celda[campo] + cantidad) * 100) / 100;
    celda.total = Math.round((celda.ventas + celda.produccion) * 100) / 100;
  };
  for (const [mes, filas] of Object.entries(porMes)) {
    const { consumo } = calcularConsumoReal(filas, sucById, rubroDePlu, pesLis.formulas || {}, compsPorBulto);
    for (const [plu, porSuc] of Object.entries(consumo)) {
      anotar(plu, mes, 'ventas', Object.values(porSuc).reduce((s, v) => s + (Number(v) || 0), 0));
    }
  }
  for (const r of prodRows) anotar(r.IdProducto, String(r.Mes), 'produccion', Number(r.Cant) || 0);

  const cache = { timestamp: new Date().toISOString(), ventanaMeses: meses,
    tipoMovimientoProduccion: tipoProd, consumoMensual, ventasPorSucursal };
  guardarJSON(CONSUMO_MENSUAL_PATH, cache);
  return { timestamp: cache.timestamp, ventanaMeses: meses,
    productos: Object.keys(consumoMensual).length,
    mesesConDatos: [...new Set(Object.values(consumoMensual).flatMap(p => Object.keys(p)))].sort() };
}

router.get('/api/compras/consumo-mensual/recalcular', apiRoute(async () => recalcularConsumoMensual()));
router.get('/api/compras/consumo-mensual', apiRoute(async () => leerJSON(CONSUMO_MENSUAL_PATH, { vacio: true })));

// ── Ajustes manuales de S/min por (plu, sucursal) ──────────────────────────────
const MANUAL_MAX = 100000;
function validarValorManual(v, campo) {
  if (v === '' || v == null) return null;            // null = sin fijar (usa el calculado)
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > MANUAL_MAX) throw new Error(`Valor inválido para ${campo}`);
  return roundDec(n, 2);
}
// Lista los ajustes con su valor calculado al lado, para la vista rápida de la UI.
router.get('/api/distribucion/a8020/manual', (_req, res) => {
  const manual = leerJSON(A8020_MANUAL_PATH, {});
  const cache = leerJSON(A8020_CALC_PATH, {}) || {};
  const items = [];
  for (const [plu, porSuc] of Object.entries(manual)) {
    for (const [sucursal, m] of Object.entries(porSuc)) {
      const d = ((cache.detalle || {})[plu] || {})[sucursal] || {};
      items.push({ plu: Number(plu), sucursal, S: m.S ?? null, min: m.min ?? null,
        nota: m.nota || '', ts: m.ts || null, usuario: m.usuario || null,
        nombre: (cache.nombres || {})[plu] || '', calcS: d.S ?? null, calcMin: d.min ?? null });
    }
  }
  items.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || '') || a.sucursal.localeCompare(b.sucursal));
  res.json({ items });
});
router.post('/api/distribucion/a8020/manual', (req, res) => {
  try {
    const body = req.body || {};
    const plu = String(body.plu || '').trim();
    const sucursal = String(body.sucursal || '').trim();
    if (!plu) throw new Error('Falta plu');
    const sucs = (leerJSON(DISTRIB_CONFIG_PATH, {}).sucursales) || {};
    if (!sucs[sucursal]) throw new Error(`Sucursal desconocida: ${sucursal}`);
    const S = validarValorManual(body.S, 'S');
    const min = validarValorManual(body.min, 'min');
    if (S == null && min == null) throw new Error('Indicá al menos S o min');
    // S tiene que quedar SIEMPRE por encima del min: con S == min el envío teórico es 0.
    if (S != null && min != null && min >= S) throw new Error('El S tiene que ser mayor que el min');
    // Fijar uno solo también puede empatar contra el calculado del otro nivel.
    if (S == null || min == null) {
      const d = ((leerJSON(A8020_CALC_PATH, {}).detalle || {})[plu] || {})[sucursal] || {};
      const minEf = min != null ? min : d.min, sEf = S != null ? S : d.S;
      if (minEf != null && sEf != null && minEf >= sEf) {
        throw new Error(`El S tiene que ser mayor que el min (quedaría min=${minEf} y S=${sEf})`);
      }
    }
    const manual = leerJSON(A8020_MANUAL_PATH, {});
    const prev = (manual[plu] || {})[sucursal] || {};
    const entry = { ts: new Date().toISOString() };
    if (S != null) entry.S = S;
    if (min != null) entry.min = min;
    if (body.nota != null) entry.nota = String(body.nota).slice(0, 200);
    else if (prev.nota) entry.nota = prev.nota;
    const usuario = req.session && req.session.user && req.session.user.usuario;
    if (usuario) entry.usuario = usuario;
    manual[plu] = { ...(manual[plu] || {}), [sucursal]: entry };
    guardarJSON(A8020_MANUAL_PATH, manual);
    reaplicarManualA8020();
    res.json({ ok: true, plu: Number(plu), sucursal, ...entry });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/api/distribucion/a8020/manual/:plu/:sucursal', (req, res) => {
  try {
    const { plu, sucursal } = req.params;
    const manual = leerJSON(A8020_MANUAL_PATH, {});
    if (manual[plu]) {
      const { [sucursal]: _quitado, ...resto } = manual[plu];
      if (Object.keys(resto).length) manual[plu] = resto; else delete manual[plu];
      guardarJSON(A8020_MANUAL_PATH, manual);
      reaplicarManualA8020();
    }
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/distribucion/a8020', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'a8020.html')));

// ── Listas editables de distribución (excluir / siempre-Almacen / siempre-Pesable) ──
const LISTAS_DISTRIB_PATH = path.join(DATA_DIR, 'listas_distribucion.json');
const RESTR_SUCURSALES = ['rivadavia', 'urquiza', 'chacabuco', 'nacion', 'pergamino', 'sanPedro', 'villaRamallo'];
function leerListasDistrib() {
  let l = leerJSON(LISTAS_DISTRIB_PATH, null);
  if (!l) {   // seed: noEnvasa + restringidos del snapshot de la planilla; siempre* vacíos
    const snap = leerJSON(DISTRIB_LISTAS_PATH, {});
    const restrSnap = snap.restringidos || {};
    l = { noEnvasa: (snap.noEnvasa || []).map(Number).sort((a, b) => a - b), siempreAlmacen: [], siemprePesable: [], siemprePesableSinGranel: [], ocultarPesable: [],
      restringidos: Object.fromEntries(RESTR_SUCURSALES.map(k => [k, (restrSnap[k] || []).map(Number).sort((a, b) => a - b)])) };
    guardarJSON(LISTAS_DISTRIB_PATH, l);
  }
  l.noEnvasa = (l.noEnvasa || []).map(Number);
  l.siempreAlmacen = (l.siempreAlmacen || []).map(Number);
  l.siemprePesable = (l.siemprePesable || []).map(Number);
  l.siemprePesableSinGranel = (l.siemprePesableSinGranel || []).map(Number);
  l.ocultarPesable = (l.ocultarPesable || []).map(Number);   // ocultos solo en Pesables
  l.restringidos = l.restringidos || {};
  for (const k of RESTR_SUCURSALES) l.restringidos[k] = (l.restringidos[k] || []).map(Number);
  return l;
}
// ── Fact en vivo: productos facturados a cada sucursal desde su última recepción (REC-SUC) ──
async function calcularFactLive() {
  const config = leerJSON(DISTRIB_CONFIG_PATH, {});
  const sucs = config.sucursales || {};
  const idSuc2key = {}, idCli2key = {}, idSucs = [], idClis = [];
  for (const [key, c] of Object.entries(sucs)) {
    if (c.idSucursal) { idSuc2key[c.idSucursal] = key; idSucs.push(c.idSucursal); }
    if (c.idCliente) { idCli2key[c.idCliente] = key; idClis.push(c.idCliente); }
  }
  const recByKey = {};
  if (idSucs.length) {
    // CONVERT(varchar,120) returns 'YYYY-MM-DD HH:MM:SS' string — no JS Date/timezone conversion
    const recRows = await query(`SELECT IdSucursal, CONVERT(varchar(19), MAX(FechaMovimiento), 120) AS Ult FROM MovimientosStock
      WHERE IdTipoMovimiento='REC-SUC' AND IdSucursal IN (${idSucs.join(',')}) GROUP BY IdSucursal`);
    for (const r of recRows) { const k = idSuc2key[r.IdSucursal]; if (k && r.Ult) recByKey[k] = r.Ult; }
  }
  const factByKey = {};
  if (idClis.length) {
    const key2cli = {};
    for (const [key, c] of Object.entries(sucs)) { if (c.idCliente) key2cli[key] = c.idCliente; }
    const cliConds = Object.entries(recByKey)
      .filter(([key]) => key2cli[key])
      .map(([key, ultStr]) => `(v.IdCliente = ${key2cli[key]} AND v.Fecha > '${ultStr}')`);
    if (cliConds.length) {
      const ventas = await query(`SELECT DISTINCT v.IdCliente, vp.IdProducto
        FROM VentasProductos vp
        INNER JOIN Ventas v ON v.IdSucursal=vp.IdSucursal AND v.IdTipoComprobante=vp.IdTipoComprobante
          AND v.Letra=vp.Letra AND v.CentroEmisor=vp.CentroEmisor AND v.NumeroComprobante=vp.NumeroComprobante
        WHERE ISNULL(v.IdEstadoComprobante,'')!='ANULADO'
          AND (${cliConds.join(' OR ')})`);
      for (const r of ventas) {
        const k = idCli2key[r.IdCliente]; if (!k) continue;
        (factByKey[k] = factByKey[k] || new Set()).add(Number(r.IdProducto));
      }
    }
  }
  return { recByKey, factByKey };
}

router.get('/api/distribucion/recepcion', apiRoute(async () => {
  const { recByKey } = await calcularFactLive();
  const out = {}; for (const [k, d] of Object.entries(recByKey)) out[k] = d;
  return out;
}));
router.get('/api/distribucion/fact-ventas-debug', apiRoute(async (req) => {
  const { plu, idCli, desde } = req.query;
  if (!idCli || !desde) return { error: 'Params: idCli, desde (YYYY-MM-DD HH:MM:SS), plu opcional' };
  const pluFilter = plu ? `AND vp.IdProducto='${Number(plu)}'` : '';
  return await query(`SELECT TOP 30 v.IdCliente, v.IdSucursal, CONVERT(varchar(19),v.Fecha,120) AS Fecha,
    v.IdEstadoComprobante, v.IdTipoComprobante, v.NumeroComprobante, vp.IdProducto, vp.Cantidad
    FROM VentasProductos vp
    INNER JOIN Ventas v ON v.IdSucursal=vp.IdSucursal AND v.IdTipoComprobante=vp.IdTipoComprobante
      AND v.Letra=vp.Letra AND v.CentroEmisor=vp.CentroEmisor AND v.NumeroComprobante=vp.NumeroComprobante
    WHERE v.IdCliente=${Number(idCli)} AND v.Fecha > '${desde}'
      AND ISNULL(v.IdEstadoComprobante,'') != 'ANULADO'
    ${pluFilter}
    ORDER BY v.Fecha DESC`);
}));
router.get('/api/distribucion/plu-debug', apiRoute(async (req) => {
  const { plu } = req.query;
  if (!plu) return { error: 'param: plu' };
  const rows = await calcularDistribucionPesables();
  const row = rows.find(r => String(r.plu) === String(plu));
  return row ? { plu: row.plu, nombre: row.nombre, enviar: row.enviar } : { notFound: true };
}));
router.get('/api/distribucion/fact-set-debug', apiRoute(async () => {
  const { factByKey } = await calcularFactLive();
  const out = {};
  for (const [k, set] of Object.entries(factByKey)) out[k] = [...set].sort((a,b) => a-b);
  return out;
}));
router.get('/api/distribucion/fact-debug', apiRoute(async () => {
  const config = leerJSON(DISTRIB_CONFIG_PATH, {});
  const sucs = config.sucursales || {};
  const idSuc2key = {}, key2cli = {}, idSucs = [];
  for (const [key, c] of Object.entries(sucs)) {
    if (c.idSucursal) { idSuc2key[c.idSucursal] = key; idSucs.push(c.idSucursal); }
    if (c.idCliente) key2cli[key] = c.idCliente;
  }
  const recByKey = {};
  if (idSucs.length) {
    const rows = await query(`SELECT IdSucursal, CONVERT(varchar(19), MAX(FechaMovimiento), 120) AS Ult FROM MovimientosStock
      WHERE IdTipoMovimiento='REC-SUC' AND IdSucursal IN (${idSucs.join(',')}) GROUP BY IdSucursal`);
    for (const r of rows) { const k = idSuc2key[r.IdSucursal]; if (k && r.Ult) recByKey[k] = r.Ult; }
  }
  const cliConds = Object.entries(recByKey)
    .filter(([key]) => key2cli[key])
    .map(([key, ultStr]) => `(v.IdCliente = ${key2cli[key]} AND v.Fecha > '${ultStr}')`);
  const sql = cliConds.length
    ? `SELECT DISTINCT v.IdCliente, vp.IdProducto FROM VentasProductos vp INNER JOIN Ventas v ON ... WHERE ISNULL(v.IdEstadoComprobante,'')!='ANULADO' AND (${cliConds.join(' OR ')})`
    : 'NO CONDITIONS';
  return { recByKey, conditions: cliConds, sqlPreview: sql };
}));
router.get('/api/distribucion/listas', apiRoute(async () => {
  const l = leerListasDistrib();
  const all = [...new Set([...l.noEnvasa, ...l.siempreAlmacen, ...l.siemprePesable, ...l.siemprePesableSinGranel, ...l.ocultarPesable,
    ...Object.values(l.restringidos).flat()])];
  const nombres = {};
  if (all.length) {
    const inList = all.map(p => `'${p}'`).join(',');   // IdProducto es varchar en Siga
    const rows = await query(`SELECT IdProducto, NombreProducto FROM Productos WHERE IdProducto IN (${inList})`);
    for (const r of rows) nombres[String(r.IdProducto)] = r.NombreProducto;
  }
  return { ...l, nombres };
}));
router.post('/api/distribucion/listas', (req, res) => {
  const cur = leerListasDistrib();
  const { lista, accion, plu, sucursal } = req.body || {};
  if (!['add', 'remove'].includes(accion) || !Number.isFinite(Number(plu)))
    return res.status(400).json({ error: 'parámetros inválidos' });
  if (lista === 'restringidos') {
    if (!RESTR_SUCURSALES.includes(sucursal))
      return res.status(400).json({ error: 'sucursal inválida' });
    const set = new Set(cur.restringidos[sucursal]);
    if (accion === 'add') set.add(Number(plu)); else set.delete(Number(plu));
    cur.restringidos[sucursal] = [...set].sort((a, b) => a - b);
    guardarJSON(LISTAS_DISTRIB_PATH, cur);
    return res.json({ ok: true, lista, sucursal, count: cur.restringidos[sucursal].length });
  }
  if (!['noEnvasa', 'siempreAlmacen', 'siemprePesable', 'siemprePesableSinGranel', 'ocultarPesable'].includes(lista))
    return res.status(400).json({ error: 'parámetros inválidos' });
  const set = new Set(cur[lista]);
  if (accion === 'add') set.add(Number(plu)); else set.delete(Number(plu));
  cur[lista] = [...set].sort((a, b) => a - b);
  guardarJSON(LISTAS_DISTRIB_PATH, cur);
  res.json({ ok: true, lista, count: cur[lista].length });
});
router.get('/api/distribucion/buscar', apiRoute(async req => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return [];
  if (/^\d+$/.test(q))
    return query(`SELECT TOP 25 IdProducto, NombreProducto FROM Productos WHERE CAST(IdProducto AS VARCHAR) LIKE '${q}%' ORDER BY IdProducto`);
  const safe = q.replace(/'/g, "''");
  return query(`SELECT TOP 25 IdProducto, NombreProducto FROM Productos WHERE NombreProducto LIKE '%${safe}%' AND Activo=1 ORDER BY NombreProducto`);
}));
// ── Distribución: registros de producción fraccionado ───────────────────────────
router.get('/api/distribucion/fraccionado-registros', apiRoute(async () => leerJSON(FRAC_REG_PATH, [])));
const ALMACEN_TIPO_PATH = path.join(DATA_DIR, 'almacen_tipo.json');
router.get('/api/distribucion/almacen-tipo', apiRoute(async () => leerJSON(ALMACEN_TIPO_PATH, {})));
router.post('/api/distribucion/almacen-tipo', (req, res) => {
  const { plu, tipo } = req.body || {};
  if (!plu) return res.status(400).json({ error: 'falta plu' });
  const d = leerJSON(ALMACEN_TIPO_PATH, {});
  if (!tipo) delete d[String(plu)]; else d[String(plu)] = tipo;
  guardarJSON(ALMACEN_TIPO_PATH, d);
  res.json({ ok: true });
});

// Clave natural de un registro de fraccionado: el mismo producto, del mismo día, hecho por el
// mismo empleado, en el mismo tramo horario y con la misma cantidad es siempre el mismo trabajo.
// Se usa para rebotar el doble-submit (ver el POST de abajo).
function claveRegistroFrac(r) {
  return [r.lote || '', r.plu, r.fecha || '', r.empleado || '', r.desde || '', r.hasta || '',
          Number(r.cantFraccionada)].join('|');
}
router.post('/api/distribucion/fraccionado-registros', (req, res) => {
  const b = req.body || {};
  if (b.plu == null || b.cantFraccionada == null) return res.status(400).json({ error: 'faltan campos' });
  // Se guarda el cuerpo completo (incluye observacion, ordenId, seccion y graneles[]).
  const arr = leerJSON(FRAC_REG_PATH, []);
  // Rebote de doble-submit: cuando el server queda trabado (consultas a Siga bloqueando el event
  // loop) la operaria no ve respuesta y vuelve a apretar Guardar; las requests se encolan y entran
  // todas juntas. Pasó el 02/09/26 con el PLU 1218: 12 altas idénticas en 335 ms. Reenviar la misma
  // carga devuelve el id ya existente en vez de duplicarla, así el front no necesita cambiar nada.
  const dup = arr.find(x => claveRegistroFrac(x) === claveRegistroFrac(b));
  if (dup) return res.json({ ok: true, id: dup.id, duplicado: true });
  const nuevo = { ...b, id: Date.now() };
  arr.push(nuevo);
  guardarJSON(FRAC_REG_PATH, arr);
  res.json({ ok: true, id: nuevo.id });
});
router.get('/api/distribucion/pedidos', apiRoute(async () => {
  const rows = await query(`SELECT p.IdProducto, p.NombreProducto, ISNULL(r.NombreRubro,'') AS Rubro, p.EsCompuesto
    FROM Productos p LEFT JOIN Rubros r ON r.IdRubro = p.IdRubro
    WHERE p.NombreProducto LIKE '%PEDIDO%' AND p.Activo = 1 ORDER BY p.NombreProducto`);
  return rows.map(r => ({ plu: r.IdProducto, nombre: r.NombreProducto, rubro: r.Rubro, esCompuesto: !!r.EsCompuesto }));
}));
router.get('/api/distribucion/pedido-formula/:plu', async (req, res) => {
  try {
    const plu = parseInt(req.params.plu, 10);
    if (isNaN(plu)) return res.status(400).json({ error: 'PLU inválido' });
    // Sólo la fórmula vigente: sin este filtro entraban los componentes de todas las
    // fórmulas del producto y el MAX() se quedaba con la cantidad más grande entre ellas,
    // así que la carga de producción y la distribución consumían insumos de fórmulas viejas.
    // El componente se aliasa `p` porque es lo que espera SIN_FORMULA_GENERICO_SQL.
    const rows = await query(`
      SELECT pc.IdProductoComponente AS plu, p.NombreProducto AS nombre,
             CAST(MAX(pc.Cantidad) AS FLOAT) AS cantidad
      FROM ProductosComponentes pc
      INNER JOIN Productos p ON p.IdProducto = pc.IdProductoComponente
      WHERE pc.IdProducto = ${plu} AND ${FORMULA_ACTIVA_SQL} AND ${SIN_FORMULA_GENERICO_SQL}
      GROUP BY pc.IdProductoComponente, p.NombreProducto`);
    console.log(`[pedido-formula] PLU=${plu} result=${rows.length}`);
    res.json(rows.map(r => ({ plu: String(r.plu), nombre: r.nombre, cantidad: r.cantidad })));
  } catch(e) { console.error('[pedido-formula]', e.message); res.status(500).json({ error: e.message }); }
});
router.delete('/api/distribucion/fraccionado-registros-fecha', (req, res) => {
  const { fecha } = req.query;
  const arr = leerJSON(FRAC_REG_PATH, []);
  const nuevo = fecha ? arr.filter(x => x.fecha !== fecha) : [];
  guardarJSON(FRAC_REG_PATH, nuevo);
  res.json({ ok: true, eliminados: arr.length - nuevo.length });
});
router.get('/api/distribucion/historial', apiRoute(async () => leerJSON(HISTORIAL_PATH, [])));
router.post('/api/distribucion/historial', (req, res) => {
  const b = req.body || {};
  if (!b.fecha) return res.status(400).json({ error: 'falta fecha' });
  // Guarda el cuerpo completo (incluye ordenes, completadas, pctCompletadas, totalOrdenes).
  // Una fecha tiene un solo snapshot: archivar dos veces el mismo día es o un doble click o un
  // re-archivado después de agregar registros, y en los dos casos el bueno es el último. Apilando
  // quedaban dos entradas del mismo día en el historial (pasó el 02/09/26, exports 10:57 y 11:01).
  const arr = leerJSON(HISTORIAL_PATH, []).filter(x => x.fecha !== b.fecha);
  arr.unshift({ ...b, produccion: b.produccion || [], pesables: b.pesables || [], id: Date.now(), exportadoEn: new Date().toISOString() });
  guardarJSON(HISTORIAL_PATH, arr);
  res.json({ ok: true });
});
router.delete('/api/distribucion/historial/:id', (req, res) => {
  const id = Number(req.params.id);
  const arr = leerJSON(HISTORIAL_PATH, []);
  const nuevo = arr.filter(x => x.id !== id);
  if (nuevo.length === arr.length) return res.status(404).json({ error: 'no encontrado' });
  guardarJSON(HISTORIAL_PATH, nuevo);
  res.json({ ok: true });
});
router.delete('/api/distribucion/fraccionado-registros/:id', (req, res) => {
  const id = Number(req.params.id);
  const arr = leerJSON(FRAC_REG_PATH, []);
  const nuevo = arr.filter(x => x.id !== id);
  if (nuevo.length === arr.length) return res.status(404).json({ error: 'no encontrado' });
  guardarJSON(FRAC_REG_PATH, nuevo);
  res.json({ ok: true });
});
router.put('/api/distribucion/fraccionado-registros/:id', (req, res) => {
  const id = Number(req.params.id);
  const arr = leerJSON(FRAC_REG_PATH, []);
  const idx = arr.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ error: 'no encontrado' });
  arr[idx] = { ...arr[idx], ...req.body, id };
  guardarJSON(FRAC_REG_PATH, arr);
  res.json({ ok: true });
});


// ── Distribución: parámetros pesables (config motor) ────────────────────────────
const PESABLES_PARAMS_PATH = path.join(DATA_DIR, 'pesables_params.json');
router.get('/api/distribucion/pesables-params', apiRoute(async () => leerJSON(PESABLES_PARAMS_PATH, {})));
router.post('/api/distribucion/pesables-params', (req, res) => {
  const params = req.body;
  if (!params || typeof params !== 'object') return res.status(400).json({ error: 'body inválido' });
  guardarJSON(PESABLES_PARAMS_PATH, params);
  res.json({ ok: true });
});

// ── Distribución: asignaciones de empleados a órdenes fraccionado ───────────────
const FRACCIONADO_ASIG_PATH = path.join(DATA_DIR, 'fraccionado_asignaciones.json');
router.get('/api/distribucion/fraccionado-asignaciones', apiRoute(async () => leerJSON(FRACCIONADO_ASIG_PATH, {})));
router.post('/api/distribucion/fraccionado-asignaciones', (req, res) => {
  const { plu, empleados } = req.body || {};
  if (!plu) return res.status(400).json({ error: 'falta plu' });
  const cur = leerJSON(FRACCIONADO_ASIG_PATH, {});
  if (!empleados || empleados.length === 0) delete cur[String(plu)];
  else cur[String(plu)] = empleados;
  guardarJSON(FRACCIONADO_ASIG_PATH, cur);
  res.json({ ok: true });
});

// ── Distribución: clasificación envasado propio vs externo ──────────────────────
const ENVASADO_CLAS_PATH = path.join(DATA_DIR, 'envasado_clasificacion.json');
router.get('/api/distribucion/envasado', apiRoute(async () => {
  const data = leerJSON(ENVASADO_CLAS_PATH, { apidelta: [], externo: [], nombres: {} });
  return data;
}));
router.post('/api/distribucion/envasado', (req, res) => {
  const { accion, tipo, plu, nombre } = req.body || {};
  if (!accion || !tipo || !plu) return res.status(400).json({ error: 'faltan campos' });
  const cur = leerJSON(ENVASADO_CLAS_PATH, { apidelta: [], externo: [], nombres: {} });
  const id = Number(plu);
  if (accion === 'add') {
    if (!cur[tipo]) cur[tipo] = [];
    if (!cur[tipo].includes(id)) cur[tipo].push(id);
    if (nombre) cur.nombres[id] = nombre;
  } else if (accion === 'remove') {
    ['apidelta', 'externo'].forEach(t => { cur[t] = (cur[t] || []).filter(x => x !== id); });
    delete cur.nombres[id];
  } else if (accion === 'move') {
    const otro = tipo === 'apidelta' ? 'externo' : 'apidelta';
    cur[otro] = (cur[otro] || []).filter(x => x !== id);
    if (!cur[tipo]) cur[tipo] = [];
    if (!cur[tipo].includes(id)) cur[tipo].push(id);
  }
  guardarJSON(ENVASADO_CLAS_PATH, cur);
  res.json({ ok: true });
});
router.get('/api/distribucion/buscar-rubro', apiRoute(async req => {
  const rubro = String(req.query.rubro || '').trim();
  if (!rubro) return [];
  const safe = rubro.replace(/'/g, "''");
  return query(`SELECT TOP 200 p.IdProducto, p.NombreProducto, r.NombreRubro
    FROM Productos p
    LEFT JOIN Rubros r ON r.IdRubro=p.IdRubro
    WHERE r.NombreRubro LIKE '%${safe}%' AND p.Activo=1
    ORDER BY r.NombreRubro, p.NombreProducto`);
}));
router.get('/api/distribucion/buscar-marca', apiRoute(async req => {
  const marca = String(req.query.marca || '').trim();
  if (!marca) return [];
  const safe = marca.replace(/'/g, "''");
  try {
    return await query(`SELECT TOP 200 p.IdProducto, p.NombreProducto, r.NombreRubro
      FROM Productos p
      LEFT JOIN Rubros r ON r.IdRubro=p.IdRubro
      INNER JOIN Marcas m ON m.IdMarca=p.IdMarca
      WHERE m.NombreMarca LIKE '%${safe}%' AND p.Activo=1
      ORDER BY m.NombreMarca, p.NombreProducto`);
  } catch {
    return [];
  }
}));
router.get('/api/distribucion/rubros-lista', apiRoute(async () =>
  query(`SELECT DISTINCT NombreRubro FROM Rubros WHERE NombreRubro IS NOT NULL AND NombreRubro != '' ORDER BY NombreRubro`)
));
  return router;
};
