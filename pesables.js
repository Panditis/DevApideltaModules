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
  // Prioridad del producto (suma ponderada, normalizada 0..1, sin compuerta todo-o-nada).
  // Componentes:
  //   bg        = importancia minorista (BG) — driver principal.
  //   urgencia  = promedio de "cuán por debajo del mínimo" está el stock en cada sucursal
  //               (0=cómoda, 1=en/bajo mínimo).
  //   cantidad  = pedido teórico total de sucursales (Σ S−stock), normalizado.
  //   envasar   = volumen a envasar (D), normalizado.
  // Pesos sobreescribibles vía opts.prioPesos / opts.prioPesosSala.
  prioPesos: { bg: 0.5, urgencia: 0.25, cantidad: 0.15, envasar: 0.1 },
  // Variante "Sala": ignora envíos a sucursales, solo importancia + a-envasar.
  prioPesosSala: { bg: 0.7, envasar: 0.3 },
  granelCap: 2,      // ratio granel/aEnviar ≥ cap ⇒ disponibilidad máxima (informativo, granelRatio)
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

// Redondeo a múltiplo de la presentación (bolsa). Nearest: fracción <0.5 abajo, ≥0.5 arriba.
// presKg<=0 → sin cambio (backward-compat con tests golden). q<=0 → 0.
function snapPres(q, presKg) {
  if (!(presKg > 0) || !(q > 0)) return q > 0 ? q : 0;
  return Math.round(Math.round(q / presKg) * presKg * 1000) / 1000;
}

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
function enviarFinal(suc, plu, sn, teo, M, restrSets, presKg) {
  if (suc.restr && restrSets[suc.restr] && restrSets[suc.restr].has(plu)) return 'Restringido';
  if (sn !== 'Si') return sn;
  return snapPres(Math.min(M < 1 ? teo : teo / M, P.maxEnviar), presKg);
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
    const presKg = (opts && opts.presPorPlu && opts.presPorPlu[String(plu)]) || 0;
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

    const mins = {}, sLev = {}, sn = {}, teo = {}, stkPorSuc = {};
    // Empuje de presencia (piso de góndola en KG): si hay stock en central (H>0) y la demanda
    // estadística es baja (S<presencia), fija gatillo (min)=presencia y objetivo (S)=presencia·factor
    // → brecha (batch) para no reponer de a poco. Presencia escalada por clase ABC del PLU (A>B>C).
    // Clase F no se empuja. Espejo de calcularFilaAlmacen (distribucion.js). En KG, no unidades.
    // Piso de góndola (kg) elegido por el PESO DE PRESENTACIÓN (bolsa). opts.presenciaPorPresentacion =
    // [{hastaKg, piso}] ordenado asc por hastaKg; toma el primer tramo con presKg <= hastaKg (hastaKg
    // null = catch-all, presentaciones grandes). Reemplaza el piso por clase ABC (un 50g y un 1kg de
    // la misma clase necesitan pisos distintos). Fallback: presenciaPorClase (ABC) → empujePresencia plano.
    const claseAbc = (opts && opts.abcPorPlu && opts.abcPorPlu[String(plu)]) || null;
    const presTramos = opts && opts.presenciaPorPresentacion;
    let presRaw = 0;
    if (Array.isArray(presTramos) && presTramos.length) {
      const pk = presKg > 0 ? presKg : Infinity;   // sin presentación conocida → tramo catch-all
      const tr = presTramos.find((t) => t.hastaKg == null || pk <= t.hastaKg + 1e-9);
      presRaw = tr ? (Number(tr.piso) || 0) : 0;
    } else if (opts && opts.presenciaPorClase) {
      const pc = opts.presenciaPorClase;
      presRaw = pc[claseAbc] != null ? pc[claseAbc] : (pc.C != null ? pc.C : 0);
    } else {
      presRaw = (opts && opts.empujePresencia) || 0;
    }
    const presFactorS = Math.max(1, (opts && opts.empujePresenciaFactorS) || 1);
    const aplicaPres = presRaw > 0 && H > 0 && BK === 'Si' && claseAbc !== 'F';
    const presObjetivo = Math.round(presRaw * presFactorS * 100) / 100;   // kg, 2 dec
    for (const suc of SUC) {
      // Stock sucursal = MAX(stock,0), salvo Sucu11 que la planilla NO clampa (MAX de un solo valor).
      const stock = suc.key === 'sucu11' ? (st.sucu11 || 0) : Math.max(st[suc.key] || 0, 0);
      stkPorSuc[suc.key] = stock;
      const m = minSucursal(suc, a, cl, corregir);
      const s = sSucursal(suc, a, cl, corregir);
      let mm = m, ss = s;
      if (aplicaPres) {
        if (mm < presRaw) mm = presRaw;              // gatillo (min) ≥ presencia (piso góndola)
        if (ss < presObjetivo) ss = presObjetivo;    // demanda baja → objetivo = presencia·factor (brecha batch)
      }
      // S siempre por encima del min (kg, paso 0.1): con S == min el teórico da 0 y la sucursal
      // gatilla sin reponer. Pasa si el A8020 ya traía S = presencia y el empuje sube el min.
      if (mm > 0 && ss <= mm) ss = Math.round((mm + 0.1) * 100) / 100;
      mins[suc.key] = mm; sLev[suc.key] = ss;
      sn[suc.key] = enviarSN(BK === 'Si', stock, mm, H, F, suc);   // gatillo con min (punto de pedido)
      teo[suc.key] = enviarTeorico(sn[suc.key], ss, stock);   // repone hasta S
    }
    const sumTeo = SUC.reduce((s, suc) => s + teo[suc.key], 0);
    // PLU ausente del A8020: los teóricos son #N/A ⇒ CH = SUM(#N/A) = #N/A (NaN).
    // El #N/A contamina el SUMIF del grupo granel ⇒ CI=0 para todo el grupo (réplica exacta).
    const CH = a ? Math.max(sumTeo - H, 0) : NaN;
    return { plu, granel, gkey, cl, BK, BG, F, H, mins, sLev, stkPorSuc, sn, teo, sumTeo, CH, presKg,
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
      const e = enviarFinal(suc, r.plu, r.sn[suc.key], r.teo[suc.key], r.M, restrSets, r.presKg);
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
    // A-envasar en múltiplos de presentación (nearest), sin superar los kg de granel disponibles.
    if (r.J === 'Si' && r.presKg > 0) {
      const capGranel = Math.floor(r.F / r.presKg + 1e-9) * r.presKg;
      r.D = Math.min(snapPres(r.D, r.presKg), capGranel);
    }
    r.G = Math.max(r.J === 'Si' ? r.D - (r.CG - r.H) : 0, 0);
    r.BL = rutear(r);
  }

  // Bajo racionamiento: usar todo el granel y enviar todo lo generado + existente (grupos racionados).
  repartirGranelRacionado(rows);

  // ── Prioridad del producto: importancia (BG) + urgencia de stock + cantidad ──
  // a enviar + a-envasar. Sin compuerta exponencial (aplastaba productos importantes
  // con poco volumen puntual, ej. PLU 4467 — ver spec 2026-07-07-prioridad-unificada).
  const w = Object.assign({}, P.prioPesos, (opts && opts.prioPesos) || {});
  const wSala = Object.assign({}, P.prioPesosSala, (opts && opts.prioPesosSala) || {});
  let maxBG = 0, maxD = 0, maxTeo = 0;
  for (const r of rows) { if (r.BG > maxBG) maxBG = r.BG; if (r.D > maxD) maxD = r.D; if ((r.sumTeo || 0) > maxTeo) maxTeo = r.sumTeo || 0; }
  // Importancia del producto = ranking A8020 (0-1, mismo criterio que Almacén: (facturación/máx)^0.2).
  // Reemplaza el driver "bg" (importanciaMinorista cruda) por el ranking. Fallback en cascada: promedio
  // de ranks por sucursal → BG minorista normalizado (0-1). Alineado con distribucion.js importancia.modo='real'.
  const impRanking = (r) => {
    const a = a8020[String(r.plu)];
    if (a) {
      if (isNum(a.rankGeneral) && a.rankGeneral > 0) return a.rankGeneral;
      const rs = [a.rankRiv, a.rankUrq, a.rankNacion, a.rankChaca, a.rankPergamino, a.rankSanPedro, a.rankVRamallo]
        .filter((x) => isNum(x) && x > 0);
      if (rs.length) return rs.reduce((s, x) => s + x, 0) / rs.length;
    }
    return maxBG > 0 ? r.BG / maxBG : 0;
  };
  for (const r of rows) {
    // granel disponible relativo a lo que se envía: informativo, ya no pesa en prioridad.
    r.granelRatio = r.CG > 0 ? r.F / r.CG : 0;
    const bgN      = impRanking(r);   // importancia = ranking A8020 (fallback → BG minorista)
    const envasarN = maxD > 0 ? r.D / maxD : 0;
    // Cantidad: pedido teórico total de sucursales (Σ S−stock) → prioriza lo que realmente falta.
    const cantidadN = maxTeo > 0 ? (r.sumTeo || 0) / maxTeo : 0;
    // Urgencia de stock: promedio de "cuán por debajo del mínimo" está cada sucursal con min>0.
    const urgencias = SUC.map(suc => {
      const min = r.mins[suc.key];
      if (!(min > 0)) return null;
      return Math.max(0, 1 - r.stkPorSuc[suc.key] / min);
    }).filter(x => x != null);
    const urgenciaN = urgencias.length ? urgencias.reduce((s, x) => s + x, 0) / urgencias.length : 0;

    r.prioridad = w.bg * bgN + w.urgencia * urgenciaN + w.cantidad * cantidadN + w.envasar * envasarN;

    // Variante "Sala": ignora envíos a sucursales (CG) y stock de sucursal — solo importancia + a-envasar.
    r.prioridadSala = wSala.bg * bgN + wSala.envasar * envasarN;
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

// Reparte el envío disponible (avail = H + D) de una fila entre sus sucursales, proporcional al
// teórico (ideal) de cada una, en múltiplos de presentación, sin exceder el ideal de la sucursal.
// El sobrante por redondeo se asigna por urgencia (mayor ideal-restante primero). Respeta 'Restringido'.
function distribuirEnvioPesable(r, avail) {
  const p = r.presKg > 0 ? r.presKg : 0;
  const sumTeo = r.sumTeo || 0;
  const cand = SUC.filter((suc) => (r.teo[suc.key] > 0) && r.enviar[suc.key] !== 'Restringido');
  for (const suc of cand) r.enviar[suc.key] = 0;   // reset numéricos candidatos (mantiene Restringido)
  if (!(sumTeo > 0) || !(avail > 0) || !cand.length) return;
  let used = 0;
  for (const suc of cand) {
    const share = avail * r.teo[suc.key] / sumTeo;
    let e = p > 0 ? Math.floor(share / p + 1e-9) * p : share;   // floor a presentación (no pasarse)
    if (e > r.teo[suc.key]) e = p > 0 ? Math.floor(r.teo[suc.key] / p + 1e-9) * p : r.teo[suc.key];
    e = Math.round(e * 1000) / 1000;
    r.enviar[suc.key] = e; used += e;
  }
  let sobra = Math.round((Math.min(avail, sumTeo) - used) * 1000) / 1000;
  let guard = 0;
  while (p > 0 && sobra > 1e-6 && guard++ < 100000) {
    let best = null;
    for (const suc of cand) {
      if (p <= sobra + 1e-9 && r.enviar[suc.key] + p <= r.teo[suc.key] + 1e-9) {
        const rem = r.teo[suc.key] - r.enviar[suc.key];
        if (!best || rem > best.rem) best = { suc, rem };
      }
    }
    if (!best) break;
    r.enviar[best.suc.key] = Math.round((r.enviar[best.suc.key] + p) * 1000) / 1000;
    sobra = Math.round((sobra - p) * 1000) / 1000;
  }
}

// Post-pass: bajo racionamiento (ΣCH_grupo > F) usa TODO el granel. Reparte F proporcional a la
// demanda insatisfecha CH de cada presentación del grupo (snap a presentación, floor para no pasarse),
// rellena el sobrante con presentaciones enteras (mayor demanda-restante primero), revive J y envía
// todo (H + D). Solo toca grupos racionados; el resto del cálculo Excel queda intacto.
function repartirGranelRacionado(rows) {
  const groups = {};
  for (const r of rows) { if (r.gkey === 'NA') continue; (groups[r.gkey] = groups[r.gkey] || []).push(r); }
  for (const gkey of Object.keys(groups)) {
    const grp = groups[gkey];
    const F = grp[0].F;
    if (!(F > P.pocoGranel)) continue;
    const mem = grp.filter((r) => r.BK === 'Si' && isFinite(r.CH) && r.CH > 0);
    if (!mem.length) continue;
    const sumCH = mem.reduce((s, r) => s + r.CH, 0);
    if (!(sumCH > F)) continue;   // NO racionado (hay granel de sobra) → dejar como está
    // 1) reparto proporcional a CH, floor a presentación, cap ≤ CH
    for (const r of mem) {
      const target = F * r.CH / sumCH;   // ≤ CH porque F < sumCH
      const p = r.presKg > 0 ? r.presKg : 0;
      let d = p > 0 ? Math.floor(target / p + 1e-9) * p : target;
      const capCH = p > 0 ? Math.floor(r.CH / p + 1e-9) * p : r.CH;
      if (d > capCH) d = capCH;
      r._D = Math.round(d * 1000) / 1000;
    }
    // 2) rellenar sobrante de granel con presentaciones enteras (mayor demanda-restante primero)
    let usado = mem.reduce((s, r) => s + r._D, 0);
    let sobra = Math.round((F - usado) * 1000) / 1000;
    let guard = 0;
    while (sobra > 1e-6 && guard++ < 100000) {
      let best = null;
      for (const r of mem) {
        const p = r.presKg > 0 ? r.presKg : 0; if (!(p > 0)) continue;
        if (p <= sobra + 1e-9 && r._D + p <= r.CH + 1e-9) {
          const rem = r.CH - r._D;
          if (!best || rem > best.rem) best = { r, p, rem };
        }
      }
      if (!best) break;
      best.r._D = Math.round((best.r._D + best.p) * 1000) / 1000;
      sobra = Math.round((sobra - best.p) * 1000) / 1000;
    }
    // 3) aplicar: D, revivir J, enviar todo (H+D), recomputar CG/G/BL
    for (const r of mem) {
      if (!(r._D > 0)) { delete r._D; continue; }
      r.D = r._D; delete r._D; r.J = 'Si';
      distribuirEnvioPesable(r, r.H + r.D);
      r.CG = SUC.reduce((s, suc) => s + (isNum(r.enviar[suc.key]) ? r.enviar[suc.key] : 0), 0);
      r.G = Math.max(r.D - (r.CG - r.H), 0);
      r.BL = rutear(r);
    }
  }
}

function formatearFila(r) {
  return {
    plu: r.plu, granel: r.granel, peso: r.peso,
    BG: r.BG, F: r.F, H: r.H, I: r.I, M: r.M, CH: r.CH, CI: r.CI, CG: r.CG,
    mins: r.mins, sLev: r.sLev, sn: r.sn, teorico: r.teo, enviar: r.enviar,
    J: r.J, BJ: r.BJ, BK: r.BK, L: r.L, K: r.K, D: r.D, E: r.E, BM: r.BM, G: r.G, BL: r.BL,
    prioridad: r.prioridad, prioridadSala: r.prioridadSala,
    granelRatio: r.granelRatio, presKg: r.presKg,
  };
}

module.exports = { calcularPesables, P, SUC };
