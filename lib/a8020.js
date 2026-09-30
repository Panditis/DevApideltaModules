'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  a8020.js — cálculo de puntos de pedido (order-up-to) desde estadísticos de Siga.
//  Reemplaza el snapshot a8020.json. Modelo de revisión periódica:
//
//    S = μ·(T+L) + z·σ·√(T+L)        (nivel objetivo / order-up-to)
//
//  μ,σ = demanda diaria media/desvío por (sucursal, producto); T = días de cobertura
//  (= frecuencia de envío); L = tránsito; z = factor de servicio según clase ABC.
//  Spec: docs/superpowers/specs/2026-06-10-a8020-orderupto-design.md
// ─────────────────────────────────────────────────────────────────────────────

function roundDec(x, d) { const f = Math.pow(10, d); return Math.round(x * f) / f; }

// ── Boost de productos propios (Apidelta) ────────────────────────────────────
// Los productos de la casa se reponen con un plus sobre el nivel calculado: quebrar un producto
// propio cuesta más que sobrestockearlo. Factor configurable en distribucion_config.json
// (boostApidelta); 1.3 = +30%. Se aplica a S, así el min (= S·k) sube en la misma proporción.
const BOOST_APIDELTA_DEFAULT = 1.3;
// Mixes propios que no llevan "Apidelta" ni en el nombre ni en la marca: se reconocen por su
// denominación ("Mix Europeo", "Mix F.S N&P", "Mix F.S Sin Pasas", "Mix Cerv." y "Mix Cerv. Prem.").
const MIX_APIDELTA = ['europeo', 'n&p', 'sin pasas', 'cerv'];

function normalizarNombreProd(s) {
  return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

// ¿Producto propio? Nombre o marca con "apidelta", o uno de los mixes de la casa.
function esProductoApidelta(nombre, marca) {
  const n = normalizarNombreProd(nombre), m = normalizarNombreProd(marca);
  if (n.includes('apidelta') || m.includes('apidelta')) return true;
  return n.includes('mix') && MIX_APIDELTA.some(k => n.includes(k));
}

// Factor a aplicar al nivel calculado de un PLU: boost si es propio, 1 si no.
function boostDePlu(plu, boostSet, factor) {
  return boostSet && boostSet.has(Number(plu)) ? (factor || BOOST_APIDELTA_DEFAULT) : 1;
}

// Clasifica PLUs en A/B/C por Pareto acumulado de una métrica (facturación o unidades).
function clasificarABC(metricByPlu, corteA, corteB) {
  const arr = Object.entries(metricByPlu).map(([plu, m]) => ({ plu, m: Number(m) || 0 }));
  const total = arr.reduce((s, x) => s + x.m, 0);
  arr.sort((a, b) => b.m - a.m);
  const abc = {};
  let acc = 0;
  for (const x of arr) {
    if (x.m <= 0) { abc[x.plu] = 'C'; continue; }
    acc += x.m;
    const share = total > 0 ? acc / total : 1;
    abc[x.plu] = share <= corteA ? 'A' : share <= corteB ? 'B' : 'C';
  }
  return abc;
}

// stats: [{ idSucursal, plu, sumQ, sumQ2 }]  (agregados diarios desde Siga)
// opsDays: { idSucursal: N }  (días operativos de la sucursal en la ventana)
// metricByPlu: { plu: métrica ABC }   ·  pesablesSet: Set<plu> (dec=1)  ·  overrides: { plu:{pisoManual,techo,mult} }
function computeA8020(stats, opsDays, metricByPlu, config, pesablesSet, overrides, boostSet) {
  const abc = clasificarABC(metricByPlu, config.abc.corteA, config.abc.corteB);
  const sucById = {}, sucByKey = {};
  for (const [key, c] of Object.entries(config.sucursales)) {
    sucById[c.idSucursal] = { key, T: c.T, L: c.L };
    sucByKey[key] = { idSucursal: c.idSucursal, T: c.T, L: c.L };
  }
  const z = config.servicio;
  const ovr = overrides || {};
  const techoDef = config.techoDefault != null ? config.techoDefault : 10000;
  const kFrac = config.minFraccion || { A: 0.7, B: 0.5, C: 0.35 };   // gatillo = fracción de S por clase ABC
  const boostFactor = config.boostApidelta != null ? config.boostApidelta : BOOST_APIDELTA_DEFAULT;

  // Construye una fila (suc, plu). Dos niveles:
  //   S   = μ·(T+L) + z·σ·√(T+L)   (order-up-to / objetivo al que se repone)
  //   min = S · k[clase]           (punto de pedido / gatilla la reposición; k por ABC)
  // Caps de override: mult y techo a S; pisoManual al min; min se clampa ≤ S.
  function buildFila(idSucursal, sucKey, plu, mu, sigma, cls, extra) {
    const sc = sucById[idSucursal];
    if (!sc) return null;
    const zc = z[cls] != null ? z[cls] : z.C;
    const TL = sc.T + sc.L;
    const o = ovr[String(plu)] || {};
    const mult = o.mult != null ? o.mult : 1;
    const piso = o.pisoManual != null ? o.pisoManual : 0;
    const techo = o.techo != null ? o.techo : techoDef;
    const dec = pesablesSet.has(Number(plu)) ? 1 : 0;
    const k = kFrac[cls] != null ? kFrac[cls] : (kFrac.C != null ? kFrac.C : 0.35);
    const boost = boostDePlu(plu, boostSet, boostFactor);
    let S = mu * TL + zc * sigma * Math.sqrt(TL);
    S = TL <= 0 ? 0 : roundDec(Math.min(Math.max(S * mult * boost, 0), techo), dec);
    let min = S <= 0 ? 0 : roundDec(Math.min(Math.max(S * k, piso), S), dec);
    return Object.assign({ idSucursal, sucursal: sucKey, plu: Number(plu), mu, sigma, abc: cls, z: zc, S, min }, extra || {});
  }

  // Denominador de μ/σ (config.demanda.denominador):
  //   'operativos'  → días operativos de la sucursal en toda la ventana (volumen real, pero diluye productos nuevos).
  //   'activos'     → días-con-venta del producto (reacciona a demanda intermitente/nueva; puede sobre-stockear).
  //   'desde_alta'  → días operativos desde la 1ª venta del producto (r.opsEff, precalculado en server): volumen
  //                   real para maduros (≈ operativos) sin castigar lanzamientos (≈ activos si vende estable).
  const denomMode = (config.demanda || {}).denominador || 'operativos';
  const filas = [];
  for (const r of stats) {
    const sc = sucById[r.idSucursal];
    if (!sc) continue;
    const N = denomMode === 'activos'    ? (Number(r.dcv)    || 0)
            : denomMode === 'desde_alta' ? (Number(r.opsEff) || 0)
            : (opsDays[r.idSucursal] || 0);
    if (N <= 0) continue;
    const mu = (Number(r.sumQ) || 0) / N;
    const sigma = Math.sqrt(Math.max((Number(r.sumQ2) || 0) / N - mu * mu, 0));
    const cls = abc[String(r.plu)] || 'C';
    const f = buildFila(r.idSucursal, sc.key, r.plu, mu, sigma, cls);
    if (f) filas.push(f);
  }

  // ── Proporción de base (% de Rivadavia) ──────────────────────────────────────
  // Para sucursales con factor f asignado: μ_final = μ_propio + f·μ_base ; idem σ.
  // El consumo de la base (Rivadavia por defecto) se suma al real de cada sucursal.
  const propBase = config.proporcionBase || {};
  const baseKey = config.proporcionBaseRef || 'riv';
  const propSucs = Object.keys(propBase).filter(k => (Number(propBase[k]) || 0) > 0 && k !== baseKey && sucByKey[k]);
  if (propSucs.length) {
    const baseIdx = {};   // plu → {mu, sigma} de la sucursal base
    for (const f of filas) if (f.sucursal === baseKey) baseIdx[f.plu] = { mu: f.mu, sigma: f.sigma };
    const have = new Set(filas.map(f => f.sucursal + '|' + f.plu));
    // 1) Ajusta filas existentes de las sucursales con factor
    for (const f of filas) {
      const fct = Number(propBase[f.sucursal]) || 0;
      if (fct <= 0) continue;
      const b = baseIdx[f.plu];
      if (!b) continue;
      const nf = buildFila(f.idSucursal, f.sucursal, f.plu, f.mu + fct * b.mu, f.sigma + fct * b.sigma, f.abc, { propBase: fct });
      if (nf) { f.mu = nf.mu; f.sigma = nf.sigma; f.S = nf.S; f.min = nf.min; f.propBase = fct; }
    }
    // 2) Crea filas para PLUs que vende la base pero la sucursal con factor no (μ_propio=0)
    for (const suc of propSucs) {
      const fct = Number(propBase[suc]) || 0;
      const sk = sucByKey[suc];
      for (const [plu, b] of Object.entries(baseIdx)) {
        if (have.has(suc + '|' + Number(plu))) continue;
        const cls = abc[String(plu)] || 'C';
        const nf = buildFila(sk.idSucursal, suc, plu, fct * b.mu, fct * b.sigma, cls, { propBase: fct, propSoloBase: true });
        if (nf && nf.S > 0) filas.push(nf);
      }
    }
  }

  return { abc, filas };
}

// Exponente de compresión: score = (facturación/máxima)^RANK_POW. Percentil de posición (rank/n) da
// SIEMPRE ~10% de items por decil sin importar el sesgo real de los datos — con facturación (Pareto,
// pocos productos explican casi toda la plata) eso pinta como "importante" a productos que no lo son.
// RANK_POW<1 comprime hacia 0 el grueso del catálogo y deja cerca de 1 solo a los que facturan cerca
// del máximo. Calibrado con datos reales: 0.2 deja ~80% del catálogo por debajo de 0.5.
const RANK_POW = 0.2;

// metricPorSuc: { idSucursal: { plu: facturación } }  ·  sucById: { idSucursal: sucKey }
// Retorna { sucKey: { plu: score } } — score 0-1 = (facturación/máxima de esa sucursal)^RANK_POW.
function calcularRankingPorSucursal(metricPorSuc, sucById) {
  const ranking = {};
  for (const [idSucursalStr, porPlu] of Object.entries(metricPorSuc || {})) {
    const sucKey = sucById[Number(idSucursalStr)];
    if (!sucKey) continue;
    const maxFact = Math.max(0, ...Object.values(porPlu).map((v) => Number(v) || 0));
    const scoreByPlu = {};
    for (const [plu, fact] of Object.entries(porPlu)) {
      const f = Number(fact) || 0;
      scoreByPlu[plu] = (f > 0 && maxFact > 0) ? roundDec(Math.pow(f / maxFact, RANK_POW), 4) : 0;
    }
    ranking[sucKey] = scoreByPlu;
  }
  return ranking;
}

// metricByPlu: { plu: facturación } — mismo criterio que calcularRankingPorSucursal pero sobre TODO
// el catálogo (sin distinguir sucursal). Retorna { plu: score }.
function calcularRankingGlobal(metricByPlu) {
  const maxFact = Math.max(0, ...Object.values(metricByPlu || {}).map((v) => Number(v) || 0));
  const score = {};
  for (const [plu, fact] of Object.entries(metricByPlu || {})) {
    const f = Number(fact) || 0;
    score[plu] = (f > 0 && maxFact > 0) ? roundDec(Math.pow(f / maxFact, RANK_POW), 4) : 0;
  }
  return score;
}

// ── Brecha obligatoria entre min y S ─────────────────────────────────────────
// min = punto de pedido, S = nivel al que se repone. Con S == min el envío teórico es 0 (o 1 por
// redondeo): la sucursal gatilla y repone de a nada, corrida tras corrida. S SIEMPRE tiene que
// quedar por encima del min; cuando coinciden se sube S (no se baja el min, que es la cobertura).
// paso = 1 unidad, o 0.1 en pesables (dec=1). Con min y S ambos en 0 no hay reposición y se deja así.
const PASO_BRECHA = { 0: 1, 1: 0.1, 2: 0.01 };
function asegurarBrechaMinS(min, S, dec) {
  const m = Number(min) || 0;
  let s = Number(S) || 0;
  if (m <= 0 && s <= 0) return { min: 0, S: 0 };
  const d = dec != null ? dec : (Number.isInteger(m) && Number.isInteger(s) ? 0 : 1);
  const paso = PASO_BRECHA[d] != null ? PASO_BRECHA[d] : 1;
  if (s <= m) s = roundDec(m + paso, d);
  return { min: m, S: s };
}

// ── Decimales permitidos por PLU ─────────────────────────────────────────────
// Sólo los pesables admiten fracción (0.1): se venden y se envían por peso. Todo el resto
// —almacén— va SIEMPRE en enteros: no existe medio pote, y un min fraccionado además rompe
// el gatillo (con min 0.8 un stock de 1 nunca pide, porque la regla es stock < min).
// Fuentes, de la más confiable a la menos: el pesablesSet en vivo (rubro Siga + lista manual
// siemprePesable), el que quedó guardado en el caché, y el rubro del propio caché. Sin ninguna
// de las tres devuelve null y el redondeo se infiere como antes.
const RUBRO_PESABLE = 'Pesables Fraccionado';
function decimalesDePlu(plu, pesablesSet, cache) {
  if (pesablesSet) return pesablesSet.has(Number(plu)) ? 1 : 0;
  const guardados = cache && Array.isArray(cache.pesables) ? cache.pesables : null;
  if (guardados) return guardados.some(p => Number(p) === Number(plu)) ? 1 : 0;
  const rubro = cache && cache.rubros ? cache.rubros[plu] : null;
  if (rubro != null) return rubro === RUBRO_PESABLE ? 1 : 0;
  return null;
}

// ── Ajustes manuales (S / min fijos por sucursal) ────────────────────────────
// manual: { plu: { sucKey: { S, min } } }  — valores fijados a mano desde la UI.
// El cálculo NUNCA los pisa: detalle[plu][suc].S/.min conservan siempre lo calculado
// y mins/sLevels (lo que consume distribución) quedan con el valor manual.
// Idempotente: reaplicarla sobre un caché ya ajustado da el mismo resultado, así que
// alcanza con volver a llamarla tras editar/borrar un ajuste, sin recalcular desde Siga.
// pesablesSet (opcional): PLUs que admiten decimales. Esta función es el único punto por el
// que pasan TODOS los valores que consume distribución, así que el redondeo se garantiza acá:
// da igual si el número vino del cálculo, de un fijo manual o de un caché viejo con decimales.
function aplicarManualA8020(cache, manual, pesablesSet) {
  const man = manual || {};
  cache.mins = cache.mins || {};
  cache.sLevels = cache.sLevels || {};
  cache.detalle = cache.detalle || {};
  // Redondea al paso del PLU y recién después asegura la brecha: redondear los dos niveles por
  // separado puede empatarlos (min 1.6→2 y S 2.2→2) y con S == min el envío teórico queda en 0.
  const nivelar = (plu, minCrudo, sCrudo) => {
    const dec = decimalesDePlu(plu, pesablesSet, cache);
    if (dec == null) return asegurarBrechaMinS(minCrudo, sCrudo);
    return asegurarBrechaMinS(roundDec(Number(minCrudo) || 0, dec),
                              roundDec(Number(sCrudo)   || 0, dec), dec);
  };
  for (const [plu, porSuc] of Object.entries(cache.detalle)) {
    for (const [suc, d] of Object.entries(porSuc)) {
      const m = (man[plu] || {})[suc];
      // Un fijo puede tocar sólo uno de los dos niveles y quedar pegado al otro: la brecha se
      // reasegura acá, no alcanza con validarla al guardar.
      const brecha = nivelar(plu, m && m.min != null ? Number(m.min) : d.min,
                                  m && m.S   != null ? Number(m.S)   : d.S);
      (cache.sLevels[plu] = cache.sLevels[plu] || {})[suc] = brecha.S;
      (cache.mins[plu] = cache.mins[plu] || {})[suc] = brecha.min;
      if (m) {
        d.manual = true;
        // La observación viaja en el caché: la UI la precarga al reabrir la celda para editar.
        if (m.nota) d.manualNota = m.nota; else delete d.manualNota;
        if (m.ts) d.manualTs = m.ts; else delete d.manualTs;
      } else { delete d.manual; delete d.manualNota; delete d.manualTs; }
    }
  }
  // Pares (plu, sucursal) fijados a mano que el cálculo no produjo: se crean con calculado 0.
  for (const [plu, porSuc] of Object.entries(man)) {
    for (const [suc, m] of Object.entries(porSuc)) {
      const det = cache.detalle[plu] = cache.detalle[plu] || {};
      if (det[suc]) continue;
      det[suc] = { mu: 0, sigma: 0, S: 0, min: 0, manual: true, soloManual: true,
        ...(m.nota ? { manualNota: m.nota } : {}), ...(m.ts ? { manualTs: m.ts } : {}) };
      const brecha = nivelar(plu, m.min != null ? Number(m.min) : 0, m.S != null ? Number(m.S) : 0);
      (cache.sLevels[plu] = cache.sLevels[plu] || {})[suc] = brecha.S;
      (cache.mins[plu] = cache.mins[plu] || {})[suc] = brecha.min;
    }
  }
  return cache;
}

// ── Consumo real por (sucursal, producto) ────────────────────────────────────
// Vender un PLU no siempre consume ESE PLU. El consumo se imputa al producto que realmente
// sale del stock:
//   · 'Almacen Bultos/Cajas' (mayorista) → la venta consume los componentes de su fórmula
//     activa: un bulto de 12 descuenta 12 unidades del suelto.
//   · 'Almacen' suelto → la venta es consumo propio.
//   · Fuera de almacén (fraccionado) → la venta consume kg del granel (cantFormula).
// Sin fórmula ni granel que resolver el consumo queda en el propio PLU: el volumen nunca se
// pierde. Es informativo — no entra en μ/σ y no toca S ni min.
const RUBRO_ALMACEN = 'Almacen';
const RUBRO_ALMACEN_BULTO = 'Almacen Bultos/Cajas';

// statRows: [{ idSucursal, plu, sumQ }]  ·  sucById: { idSucursal: sucKey }
// rubroDePlu: { plu: rubroSiga }  ·  formulasPesables: { plu: { granel, cantFormula } }
// compsPorBulto: Map<pluBulto, [{ plu, cantPorUnidad }]> (fórmula activa desde Siga)
// Retorna { consumo: { plu: { suc: q } }, consumoOrigen: { plu: { suc: {propio,bulto,fraccionado} } } }.
function calcularConsumoReal(statRows, sucById, rubroDePlu, formulasPesables, compsPorBulto) {
  const comps = compsPorBulto || new Map();
  const forms = formulasPesables || {};
  // IdProducto llega como char en algunas tablas de Siga: sin trim, el PLU de ventas ('100  ')
  // no matchea la clave del rubro ni la de la fórmula y todo el consumo cae al fallback.
  const norm = (v) => String(v == null ? '' : v).trim();
  const consumo = {}, origen = {};
  const imputar = (pluDestino, sucKey, q, via) => {
    if (!(q > 0)) return;
    const p = norm(pluDestino);
    (consumo[p] = consumo[p] || {})[sucKey] = (consumo[p][sucKey] || 0) + q;
    const porSuc = origen[p] = origen[p] || {};
    const o = porSuc[sucKey] = porSuc[sucKey] || { propio: 0, bulto: 0, fraccionado: 0 };
    o[via] += q;
  };
  for (const r of statRows || []) {
    const sucKey = (sucById || {})[r.idSucursal];
    if (!sucKey) continue;
    const q = Number(r.sumQ) || 0;
    if (!(q > 0)) continue;
    const plu = norm(r.plu);
    const rubro = (rubroDePlu || {})[plu] || null;
    if (rubro === RUBRO_ALMACEN_BULTO) {
      const cs = comps.get(plu) || [];
      if (!cs.length) { imputar(plu, sucKey, q, 'propio'); continue; }
      for (const c of cs) imputar(c.plu, sucKey, q * (Number(c.cantPorUnidad) || 0), 'bulto');
    } else if (rubro === RUBRO_ALMACEN) {
      imputar(plu, sucKey, q, 'propio');
    } else {
      const f = forms[plu] || {};
      const cant = Number(f.cantFormula);
      if (f.granel == null || !(cant > 0)) { imputar(plu, sucKey, q, 'propio'); continue; }
      imputar(f.granel, sucKey, q * cant, 'fraccionado');
    }
  }
  for (const porSuc of Object.values(consumo)) {
    for (const k of Object.keys(porSuc)) porSuc[k] = roundDec(porSuc[k], 2);
  }
  for (const porSuc of Object.values(origen)) {
    for (const o of Object.values(porSuc)) {
      o.propio = roundDec(o.propio, 2); o.bulto = roundDec(o.bulto, 2); o.fraccionado = roundDec(o.fraccionado, 2);
    }
  }
  return { consumo, consumoOrigen: origen };
}

// Recálculo automático: el A8020 vence cuando su último cálculo (timestamp ISO de a8020_calc.json)
// tiene `dias` días o más. Sin cálculo (o fecha inválida) está vencido; dias <= 0 lo desactiva.
const A8020_RECALCULAR_CADA_DIAS_DEFAULT = 7;
const MS_DIA = 86400000;
function a8020Vencido(timestamp, dias = A8020_RECALCULAR_CADA_DIAS_DEFAULT, ahora = new Date()) {
  const n = Number(dias);
  if (!(n > 0)) return false;
  const t = Date.parse(timestamp);
  return !Number.isFinite(t) || ahora.getTime() - t >= n * MS_DIA;
}

module.exports = { a8020Vencido, A8020_RECALCULAR_CADA_DIAS_DEFAULT, computeA8020, esProductoApidelta, boostDePlu, BOOST_APIDELTA_DEFAULT, calcularRankingPorSucursal, calcularRankingGlobal, clasificarABC, roundDec, aplicarManualA8020, asegurarBrechaMinS, calcularConsumoReal, RUBRO_ALMACEN, RUBRO_ALMACEN_BULTO };
