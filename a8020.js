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
  const sucById = {};
  for (const [key, c] of Object.entries(config.sucursales)) sucById[c.idSucursal] = { key, T: c.T, L: c.L };
  const z = config.servicio;
  const ovr = overrides || {};
  const techoDef = config.techoDefault != null ? config.techoDefault : 10000;

  const filas = [];
  for (const r of stats) {
    const sc = sucById[r.idSucursal];
    if (!sc) continue;
    const N = opsDays[r.idSucursal] || 0;
    if (N <= 0) continue;
    const mu = (Number(r.sumQ) || 0) / N;
    const sigma = Math.sqrt(Math.max((Number(r.sumQ2) || 0) / N - mu * mu, 0));
    const cls = abc[String(r.plu)] || 'C';
    const zc = z[cls] != null ? z[cls] : z.C;
    const TL = sc.T + sc.L;
    const o = ovr[String(r.plu)] || {};
    const mult = o.mult != null ? o.mult : 1;
    const piso = o.pisoManual != null ? o.pisoManual : 0;
    const techo = o.techo != null ? o.techo : techoDef;
    const dec = pesablesSet.has(Number(r.plu)) ? 1 : 0;
    let S = mu * TL + zc * sigma * Math.sqrt(TL);
    S = TL <= 0 ? 0 : roundDec(Math.min(Math.max(S * mult, piso), techo), dec);
    filas.push({ idSucursal: r.idSucursal, sucursal: sc.key, plu: Number(r.plu),
                 mu, sigma, abc: cls, z: zc, S });
  }
  return { abc, filas };
}

module.exports = { computeA8020, clasificarABC, roundDec };
