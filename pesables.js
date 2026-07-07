'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  pesables.js — motor de distribución de pesables/granel (réplica hoja "Pesables")
//
//  Calcula en kilogramos. Por cada PLU pesable decide:
//    - cuánto enviar a cada sucursal (racionado por disponibilidad central),
//    - si envasar (pasar granel → producto) y cuánto,
//    - ruteo: Fraccionado Revisar / Envasado / Fraccionado / Solo Preparacion.
//
//  Flag `corregirBugs` (igual criterio que Almacen):
//    false → paridad EXACTA con la planilla (incluye bugs copy-paste) → validar golden.
//    true  → versión corregida (Pergamino y Ramallo leen su Min propio del A8020).
//
//  Bugs de la planilla replicados con flag=false:
//    - Min Pergamino y Min Ramallo leen la col A8020 de Chacabuco (en vez de la propia).
//    - "Enviar teórico" de SanPedro/Logia/Ramallo/Sucu11 anula con el flag Fact de
//      Pergamino (ProductosPesables col I) en vez del propio.
//    - "Enviar" de Logia marca Fact con el flag de Rivadavia (col K).
//  Sólo los Min (Pergamino/Ramallo) se corrigen bajo corregirBugs:true, alineado con
//  la corrección equivalente del motor Almacen.
//
//  Mins = a8020.json (mismas columnas que Almacen) → fuente INYECTABLE.
// ─────────────────────────────────────────────────────────────────────────────

// Parámetros (hoja "Parametros", columna D). Constantes del negocio.
const P = {
  minPP: { riv: 0.3, urq: 0.4, nacion: 0.4, chaca: 0.4, savio: 0.4 }, // D5..D9
  maxPP: 100,        // D10..D14
  pocoGranel: 0.2,   // D15  (kg granel "poco para envasar"; y umbral central de Riv)
  factorMinSuc: 1.2, // D16  (stock_min_suc * factor > stock central ⇒ no enviar)
  pctImp: 0.8,       // D17  (umbral importancia 15 vs 30 días)
  multAlta: 2,       // D18
  multBaja: 3,       // D19
  maxEnviar: 50,     // D20..D24
  pctSobrante: 0.5,  // D30
  kgMin: 20,         // D32
  kgMaquina: 10,     // D34  (kg granel mín → "Envasado")
  pctCubre: 0.85,    // D35
  // Prioridad del producto (suma ponderada, normalizada 0..1). Componentes:
  //   bg      = importancia minorista (BG) — lo que ya se calculaba.
  //   granel  = disponibilidad de granel relativa a lo que se envía (F/CG): mucho granel
  //             frente a la demanda a despachar ⇒ sube; poco ⇒ baja.
  //   envasar = volumen a envasar (D): más kg a envasar ⇒ más prioridad.
  // Pesos y tope del ratio granel sobreescribibles vía opts.prioPesos / opts.granelCap.
  prioPesos: { bg: 0.5, granel: 0.3, envasar: 0.2, demanda: 0.25 },   // demanda = pedido teórico de sucursales
  granelCap: 2,      // ratio granel/aEnviar ≥ cap ⇒ disponibilidad máxima (granelN=1)
  // Compuerta de trabajo: si hay POCO para enviar+envasar (CG+D), baja la prioridad
  // de forma drástica aunque la rotación (BG) sea alta. Multiplica el puntaje base.
  //   workGate = min( (CG+D) / trabajoCap , 1 ) ^ trabajoGamma
  // trabajoCap = kg de trabajo a partir del cual no hay penalización; gamma>1 = caída brusca.
  trabajoCap: 20,
  trabajoGamma: 2,
};

// Bloques sucursal (orden de la planilla).
//   min/minBug = campo a8020 propio / el que lee la planilla (bug Pergamino/Ramallo = chaca)
//   pmin = mín punto pedido pesable (D5..D9); fb = fallback si a8020≤0 (Logia/Sucu11=0)
//   restr = clave listas.restringidos (null si no aplica)
//   teoFlag/envFlag = flag Fact que anula el teórico / marca "Fact" en Enviar (bugs incluidos)
//   centralFlat = Riv usa umbral central plano D15 (resto min*D16)
//   S/SBug = campo order-up-to propio / el que lee la planilla (mismo bug Pergamino/Ramallo = chaca)
const SUC = [
  { key: 'riv',       min: 'minRiv',       minBug: 'minRiv',      S: 'SRiv',       SBug: 'SRiv',    pmin: 0.3, fb: 0.2, restr: 'rivadavia',    teoFlag: null,        envFlag: 'rivadavia', centralFlat: true },
  { key: 'urq',       min: 'minUrq',       minBug: 'minUrq',      S: 'SUrq',       SBug: 'SUrq',    pmin: 0.4, fb: 0.2, restr: 'urquiza',      teoFlag: 'urquiza',   envFlag: 'urquiza' },
  { key: 'nacion',    min: 'minNacion',    minBug: 'minNacion',   S: 'SNacion',    SBug: 'SNacion', pmin: 0.4, fb: 0.2, restr: 'nacion',       teoFlag: 'nacion',    envFlag: 'nacion' },
  { key: 'chaca',     min: 'minChaca',     minBug: 'minChaca',    S: 'SChaca',     SBug: 'SChaca',  pmin: 0.4, fb: 0.2, restr: 'chacabuco',    teoFlag: 'chacabuco', envFlag: 'chacabuco' },
  { key: 'pergamino', min: 'minPergamino', minBug: 'minChaca',    S: 'SPergamino', SBug: 'SChaca',  pmin: 0.4, fb: 0.2, restr: 'pergamino',    teoFlag: 'pergamino', envFlag: 'pergamino' },
  { key: 'sanpedro',  min: 'minSanPedro',  minBug: 'minSanPedro', S: 'SSanPedro',  SBug: 'SSanPedro',pmin: 0.4, fb: 0.2, restr: 'sanPedro',     teoFlag: 'pergamino', envFlag: 'sanPedro' },
  { key: 'ramallo',   min: 'minVRamallo',  minBug: 'minChaca',    S: 'SVRamallo',  SBug: 'SChaca',  pmin: 0.4, fb: 0.2, restr: 'villaRamallo', teoFlag: 'pergamino', envFlag: 'ramallo' },
];

// ── Helpers estilo Excel ──────────────────────────────────────────────────────
const isNum = (x) => typeof x === 'number' && isFinite(x);
function round(x, d = 0) { const f = Math.pow(10, d); return Math.sign(x) * Math.round(Math.abs(x) * f) / f; }
const half = (x) => (x > 0 ? x / 2 : 0);
const safe = (x) => (isFinite(x) ? x : 0);   // IFERROR numérico

// Min sucursal: clamp(a8020,[pmin,100])/CL; fallback fb/CL si a8020≤0.
// PLU ausente del A8020 ⇒ la planilla da #N/A (NaN) y la fila entera queda no calculada.
function minSucursal(suc, a, cl, corregir) {
  if (!a) return suc.fb || 0;
  const v = a[corregir ? suc.min : suc.minBug] || 0;
  const base = v <= 0 ? suc.fb : Math.min(Math.max(suc.pmin, v), P.maxPP);
  return cl > 0 ? base / cl : base;
}

// Order-up-to sucursal: mismo clamp que minSucursal pero sobre el nivel objetivo S.
function sSucursal(suc, a, cl, corregir) {
  if (!a) return suc.fb || 0;
  const v = a[corregir ? suc.S : suc.SBug] || 0;
  const base = v <= 0 ? suc.fb : Math.min(Math.max(suc.pmin, v), P.maxPP);
  return cl > 0 ? base / cl : base;
}

function enviarSN(envasable, stock, min, H, F, suc) {
  if (!envasable) return 'No';            // BK="No" gana aunque min sea #N/A
  if (!isFinite(min)) return '#N/A';      // min #N/A ⇒ N>O = #N/A ⇒ fila errónea
  if (stock > min) return 'No';
  const umbral = suc.centralFlat ? P.pocoGranel : min * P.factorMinSuc;
  if ((H + F) < umbral) return 'No Stock';
  if (min === 0) return 'No PP';
  return 'Si';
}

// Teórico = reponer hasta S (order-up-to): MAX(S − stock, 0), con tope maxEnviar.
// Antes: min·mult − stock/2 (mult según importancia BG) — reemplazado por modelo min/S.
function enviarTeorico(sn, S, stock) {
  if (sn !== 'Si') return 0;
  return Math.min(Math.max(S - stock, 0), P.maxEnviar);
}

// Fact es 100% dinámico (calcularFactLive() en server.js, post-cálculo) — no hay
// fallback estático de planilla.
function enviarFinal(suc, plu, sn, teo, M, restrSets) {
  if (suc.restr && restrSets[suc.restr] && restrSets[suc.restr].has(plu)) return 'Restringido';
  if (sn !== 'Si') return sn;
  return Math.min(M < 1 ? teo : teo / M, P.maxEnviar);
}

// ── Cálculo principal (3 pasadas; agrupa por código granel) ───────────────────
// productos = [{ plu, stocks:{central,granel,riv,urq,nacion,chaca,pergamino,sanpedro,logia,ramallo,sucu11} }]
function calcularPesables(productos, a8020, pesLis, distLis, opts) {
  const corregir = !opts || opts.corregirBugs !== false;
  const formulas = pesLis.formulas || {};
  const pesos = pesLis.pesosGranel || {};
  const fracSet = new Set((pesLis.fraccionadora || []).map(Number));
  const noEnvasa = new Set((distLis.noEnvasa || []).map(Number));
  const impMin = distLis.importanciaMinorista || {};
  const restrSets = {};
  for (const [k, arr] of Object.entries(distLis.restringidos || {})) restrSets[k] = new Set(arr.map(Number));

  const gkeyOf = (g) => (g == null ? 'NA' : String(g));

  // ── Pasada 1: bases, S/N, teóricos, CH ──────────────────────────────────────
  const rows = productos.map((pp) => {
    const plu = Number(pp.plu);
    const st = pp.stocks || {};
    const fInfo = formulas[String(plu)] || {};
    const granel = fInfo.granel != null ? fInfo.granel : null;
    const gkey = gkeyOf(granel);
    const cl = Math.min(fInfo.cantFormula != null ? fInfo.cantFormula : 1, 1);
    const BK = noEnvasa.has(plu) ? 'No' : 'Si';
    const BG = BK === 'Si' ? (Number(impMin[String(plu)]) || 0) : 0;
    // La planilla clampa F=MAX(granel,0) y H=MAX(central,0) (stock negativo de Siga → 0).
    const F = Math.max(st.granel || 0, 0), H = Math.max(st.central || 0, 0);
    const a = a8020[String(plu)];

    const mins = {}, sLev = {}, sn = {}, teo = {};
    for (const suc of SUC) {
      // Stock sucursal = MAX(stock,0), salvo Sucu11 que la planilla NO clampa (MAX de un solo valor).
      const stock = suc.key === 'sucu11' ? (st.sucu11 || 0) : Math.max(st[suc.key] || 0, 0);
      const m = minSucursal(suc, a, cl, corregir);
      const s = sSucursal(suc, a, cl, corregir);
      mins[suc.key] = m; sLev[suc.key] = s;
      sn[suc.key] = enviarSN(BK === 'Si', stock, m, H, F, suc);   // gatillo con min (punto de pedido)
      teo[suc.key] = enviarTeorico(sn[suc.key], s, stock);   // repone hasta S
    }
    const sumTeo = SUC.reduce((s, suc) => s + teo[suc.key], 0);
    // PLU ausente del A8020: los teóricos son #N/A ⇒ CH = SUM(#N/A) = #N/A (NaN).
    // El #N/A contamina el SUMIF del grupo granel ⇒ CI=0 para todo el grupo (réplica exacta).
    const CH = a ? Math.max(sumTeo - H, 0) : NaN;
    return { plu, granel, gkey, cl, BK, BG, F, H, mins, sn, teo, sumTeo, CH,
             peso: Number(pesos[gkey]) || 0, fracOk: fracSet.has(plu) };
  });

  // Agregado: ΣCH por código granel (SUMIF C, CH)
  const sumCH = {};
  for (const r of rows) sumCH[r.gkey] = (sumCH[r.gkey] || 0) + r.CH;

  // ── Pasada 2: CI, M, envíos, CG, BJ, I, J, L, E ─────────────────────────────
  for (const r of rows) {
    const sCH = sumCH[r.gkey];
    // IF(ΣCH > F*0.75, MIN(CH/ΣCH,1), 1); IFERROR→0 (ΣCH #N/A por grupo con fila ausente del A8020).
    r.CI = !isFinite(sCH) ? 0 : (sCH > r.F * 0.75 ? Math.min(safe(r.CH / sCH), 1) : 1);
    const denom = r.F * r.CI + r.H;
    r.M = safe(denom !== 0 ? r.sumTeo / denom : 0);   // M3 tiene su propio IFERROR→0

    r.enviar = {};
    const sends = [];
    for (const suc of SUC) {
      const e = enviarFinal(suc, r.plu, r.sn[suc.key], r.teo[suc.key], r.M, restrSets);
      r.enviar[suc.key] = e;
      sends.push(isNum(e) ? e : 0);
    }
    r.CG = sends.reduce((s, v) => s + v, 0);
    r.maxSend = Math.max(0, ...sends);
    r.BJ = r.CG > 0 ? 'Si' : 'No';
    const ventas = (a8020[String(r.plu)] && a8020[String(r.plu)].ventas) || 0;
    r.I = r.BK === 'Si' ? Math.max(ventas, r.CG) : 0;
    const cum = []; let acc = 0;
    for (const v of sends.slice().sort((x, y) => x - y)) { acc += v; cum.push(acc); }
    if (r.BK === 'No' || r.F < P.pocoGranel || r.CG <= r.H) r.J = 'No';
    else r.J = (r.H - r.CG) < Math.min(r.I * P.pctSobrante, P.kgMin) ? 'Si' : 'No';
    r.L = r.J === 'No' ? 0 : Math.min(r.F, Math.max(r.I, r.CH + r.maxSend * 2));
    if (r.J === 'No') r.E = 0;
    else {
      const t = r.H * 0.85, BY = cum[0] || 0, CA = cum[2] || 0, CC = cum[4] || 0, CE = cum[6] || 0, CG = cum[8] || 0;
      r.E = t < BY ? Math.sqrt(r.BG) : t < CA ? r.BG : t < CC ? r.BG * 0.85 : t < CE ? r.BG * 0.72 : t < CG ? r.BG * 0.45 : r.BG * 0.3;
    }
  }

  // Agregados: K = ΣL(J=Si) por granel; BM = MAXIFS(E, granel, J)
  const sumLJsi = {}, maxE = {};
  for (const r of rows) {
    if (r.J === 'Si') sumLJsi[r.gkey] = (sumLJsi[r.gkey] || 0) + r.L;
    const mk = r.gkey + '|' + r.J;
    maxE[mk] = Math.max(maxE[mk] || 0, r.E);
  }

  // ── Pasada 3: K, D, BM, G, BL ───────────────────────────────────────────────
  for (const r of rows) {
    r.K = round(sumLJsi[r.gkey] || 0, 2);
    r.BM = maxE[r.gkey + '|' + r.J] || 0;
    if (r.J !== 'Si') r.D = 0;
    else if (r.F > r.K) r.D = r.L;
    else if (r.CI < 1 && r.CI > 0) r.D = r.F * r.CI;
    else r.D = safe((r.F > 0 ? r.F : 0) / r.K * r.L);
    r.G = Math.max(r.J === 'Si' ? r.D - (r.CG - r.H) : 0, 0);
    r.BL = rutear(r);
  }

  // ── Prioridad del producto (suma ponderada de BG + granel + a-envasar) ──────
  const w = Object.assign({}, P.prioPesos, (opts && opts.prioPesos) || {});
  const cap = (opts && opts.granelCap) || P.granelCap;
  const trabajoCap = (opts && opts.trabajoCap) || P.trabajoCap;
  const trabajoGamma = (opts && opts.trabajoGamma) || P.trabajoGamma;
  let maxBG = 0, maxD = 0, maxTeo = 0;
  for (const r of rows) { if (r.BG > maxBG) maxBG = r.BG; if (r.D > maxD) maxD = r.D; if ((r.sumTeo || 0) > maxTeo) maxTeo = r.sumTeo || 0; }
  for (const r of rows) {
    // granel disponible relativo a lo que se envía: ratio>1 = sobra granel, <1 = escaso.
    r.granelRatio = r.CG > 0 ? r.F / r.CG : 0;
    const granelN  = cap > 0 ? Math.min(r.granelRatio, cap) / cap : 0;
    const bgN      = maxBG > 0 ? r.BG / maxBG : 0;
    const envasarN = maxD > 0 ? r.D / maxD : 0;
    // Demanda real de las sucursales: pedido teórico total (Σ S−stock) → prioriza lo que realmente falta en góndola,
    // no solo lo que tiene alto BG. Peso configurable (prioPesos.demanda); 0 = comportamiento anterior.
    const demandaN = maxTeo > 0 ? (r.sumTeo || 0) / maxTeo : 0;
    const base = w.bg * bgN + w.granel * granelN + w.envasar * envasarN + (w.demanda || 0) * demandaN;
    // Compuerta de trabajo: poco para enviar+envasar ⇒ desploma la prioridad aunque BG sea alto.
    r.trabajo = r.CG + r.D;
    r.workGate = trabajoCap > 0 ? Math.pow(Math.min(r.trabajo / trabajoCap, 1), trabajoGamma) : 1;
    r.prioridad = base * r.workGate;

    // Variante "Sala": ignora envíos a sucursales (CG). Solo cuenta el envasado (D):
    // granel relativo a lo que se envasa, y compuerta de trabajo = D. Misma regla de caída.
    const granelRatioSala = r.D > 0 ? r.F / r.D : 0;
    const granelNSala = cap > 0 ? Math.min(granelRatioSala, cap) / cap : 0;
    const baseSala = w.bg * bgN + w.granel * granelNSala + w.envasar * envasarN;
    r.workGateSala = trabajoCap > 0 ? Math.pow(Math.min(r.D / trabajoCap, 1), trabajoGamma) : 1;
    r.prioridadSala = baseSala * r.workGateSala;
  }

  return rows.map(formatearFila);
}

// Ruteo (col BL). IFERROR de la planilla → '' ante cualquier error.
function rutear(r) {
  if (r.BJ === 'No' && r.J === 'No') return '';
  if (r.J === 'Si' && r.F < r.peso) return 'Fraccionado Revisar';
  const cubre = r.CG > r.H * P.pctCubre;
  if (r.fracOk && r.J === 'Si' && r.F > P.kgMaquina && cubre) return 'Envasado';
  if ((r.BM > 0.5 || r.BG > 0.8) && r.J === 'Si' && r.F > 0.2 && cubre) return 'Fraccionado';
  if ((r.J === 'Si' && r.F > 0.2 && cubre) || r.D > 0) return 'Fraccionado';
  if (r.BJ === 'Si') return 'Solo Preparacion';
  return '';
}

function formatearFila(r) {
  return {
    plu: r.plu, granel: r.granel, peso: r.peso,
    BG: r.BG, F: r.F, H: r.H, I: r.I, M: r.M, CH: r.CH, CI: r.CI, CG: r.CG,
    mins: r.mins, sn: r.sn, teorico: r.teo, enviar: r.enviar,
    J: r.J, BJ: r.BJ, BK: r.BK, L: r.L, K: r.K, D: r.D, E: r.E, BM: r.BM, G: r.G, BL: r.BL,
    prioridad: r.prioridad, prioridadSala: r.prioridadSala,
    granelRatio: r.granelRatio, trabajo: r.trabajo, workGate: r.workGate,
  };
}

module.exports = { calcularPesables, P, SUC };
