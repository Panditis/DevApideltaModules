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
function computeA8020(stats, opsDays, metricByPlu, config, pesablesSet, overrides) {
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
    let S = mu * TL + zc * sigma * Math.sqrt(TL);
    S = TL <= 0 ? 0 : roundDec(Math.min(Math.max(S * mult, 0), techo), dec);
    let min = S <= 0 ? 0 : roundDec(Math.min(Math.max(S * k, piso), S), dec);
    return Object.assign({ idSucursal, sucursal: sucKey, plu: Number(plu), mu, sigma, abc: cls, z: zc, S, min }, extra || {});
  }

  // Denominador de μ/σ: 'operativos' (días operativos de la sucursal, default) o
  // 'activos' (días-con-venta del producto → reacciona a demanda reciente/intermitente, puede sobre-stockear).
  const denomActivos = ((config.demanda || {}).denominador === 'activos');
  const filas = [];
  for (const r of stats) {
    const sc = sucById[r.idSucursal];
    if (!sc) continue;
    const N = denomActivos ? (Number(r.dcv) || 0) : (opsDays[r.idSucursal] || 0);
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

module.exports = { computeA8020, clasificarABC, roundDec };
