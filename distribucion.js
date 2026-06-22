'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  distribucion.js — motor de distribución a sucursales (réplica hoja "Almacen")
//
//  Replica la planilla "Listas Envasado-Almacen". Flag `corregirBugs`:
//    false → paridad EXACTA con la planilla (incluye bugs) → para validar golden.
//    true  → versión corregida (Pergamino y V.Ramallo leen su Min propio) → producción.
//
//  Bugs corregidos con flag (la planilla copiaba el bloque Chacabuco):
//    - Pergamino: Min y flag ProductosAlmacen propios (no los de Chacabuco).
//    - V.Ramallo (sucu9): idem.
//
//  Puntos de pedido (mins) = a8020.json → INYECTABLE: cuando llegue el A8020
//  calculado nuevo, sólo se reemplaza esa fuente; el motor no cambia.
//
//  Rarezas de la planilla NO tocadas (posible decisión de negocio, confirmar):
//    - Logia: salida forzada a 0.
//    - Sucu8 / Sucu11: usan la lista "Restringidos" de San Pedro; Sucu8/Sucu11 sin chequeo "Fact".
// ─────────────────────────────────────────────────────────────────────────────

const SUCURSALES_SALIDA = ['riv', 'urq', 'nacion', 'chaca', 'pergamino', 'sanPedro', 'logia', 'sucursal9', 'sucursal11'];

// ── Helpers numéricos estilo Excel ───────────────────────────────────────────
const isNum = (x) => typeof x === 'number' && isFinite(x);
function round(x, d = 0) {                 // ROUND: medio hacia afuera del cero
  const f = Math.pow(10, d);
  return Math.sign(x) * Math.round(Math.abs(x) * f) / f;
}
function roundup(x, d = 0) {               // ROUNDUP: aleja del cero
  const f = Math.pow(10, d);
  return Math.sign(x) * Math.ceil(Math.abs(x) * f) / f;
}

// Pide teórico (cols I,M,Q,...): IF(AND(min>=stock, envía), (BB>0.75?min*2:min*4) - (stock>0?round(stock/2):0), 0)
function pideTeorico(min, stock, base8020, envasaSi) {
  if (!(min >= stock && envasaSi)) return 0;
  const mult = base8020 > 0.75 ? min * 2 : min * 4;
  const resta = stock > 0 ? round(stock / 2, 0) : 0;
  return mult - resta;
}

// Min con piso: flag ProductosAlmacen>0 ⇒ 0; sino MAX(minA8020, piso)
function minConPiso(flag, minA8020, piso) {
  return flag > 0 ? 0 : Math.max(minA8020 || 0, piso);
}

// ── Cálculo de una fila de Almacen ───────────────────────────────────────────
function calcularFilaAlmacen(plu, st, a, pa, restr, noEnvasaSet, base8020Raw, opts) {
  a = a || {}; pa = pa || {};
  const corregir = !opts || opts.corregirBugs !== false;   // default true
  const D = st.central || 0;
  const BB = Math.max(base8020Raw || 0, 0.01);
  const envasaSi = !noEnvasaSet.has(plu);                   // BE
  const E_noStock = !(D > 0);                               // E: "No stock" si central<=0
  const has = (set, p) => !!(set && set.has(p));
  const pisoUno = D > 0 ? 1 : 0;

  // Mins por sucursal
  const minRiv       = Math.max(a.minRiv || 0, pisoUno);                    // sin flag (planilla)
  const minUrq       = minConPiso(pa.urquiza,   a.minUrq,      pisoUno);
  const minNacion    = minConPiso(pa.nacion,    a.minNacion,   pisoUno);
  const minChaca     = minConPiso(pa.chacabuco, a.minChaca,    pisoUno);
  const minPergamino = corregir ? minConPiso(pa.pergamino,    a.minPergamino, pisoUno)
                                : minConPiso(pa.chacabuco,    a.minChaca,     pisoUno);   // bug planilla
  const minSanPedro  = minConPiso(pa.sanPedro,  a.minSanPedro, pisoUno);
  const minSucu8     = minConPiso(pa.sucursal8, a.minLogia,    0);          // piso 0 (planilla)
  const minSucu9     = corregir ? minConPiso(pa.villaRamallo, a.minVRamallo, pisoUno)
                                : minConPiso(pa.chacabuco,    a.minChaca,     pisoUno);   // bug planilla
  const minSucu11    = minConPiso(pa.sucursal11, a.minVConst,  0);          // piso 0 (planilla)

  // Pide teórico por sucursal
  const pRiv = pideTeorico(minRiv, st.riv||0, BB, envasaSi);
  const pUrq = pideTeorico(minUrq, st.urq||0, BB, envasaSi);
  const pNac = pideTeorico(minNacion, st.nacion||0, BB, envasaSi);
  const pCha = pideTeorico(minChaca, st.chaca||0, BB, envasaSi);
  const pPer = pideTeorico(minPergamino, st.pergamino||0, BB, envasaSi);
  const pSan = pideTeorico(minSanPedro, st.sanpedro||0, BB, envasaSi);
  const pSu8 = pideTeorico(minSucu8, st.sucu8||0, BB, envasaSi);
  const pSu9 = pideTeorico(minSucu9, st.sucu9||0, BB, envasaSi);
  const pS11 = pideTeorico(minSucu11, st.sucu11||0, BB, envasaSi);
  const pideTotal = pRiv + pUrq + pNac + pCha + pPer + pSan + pSu8 + pSu9 + pS11;   // BD

  // Rateo ponderado: sucursal con stock=0 pesa el doble → recibe más pero no excluye al resto.
  const PESO_VACIO = 2;
  const ef = (pide, stk) => pide * (stk === 0 ? PESO_VACIO : 1);
  const pideEf = ef(pRiv,st.riv||0) + ef(pUrq,st.urq||0) + ef(pNac,st.nacion||0) +
                 ef(pCha,st.chaca||0) + ef(pPer,st.pergamino||0) + ef(pSan,st.sanpedro||0) +
                 ef(pSu8,st.sucu8||0) + ef(pSu9,st.sucu9||0) + ef(pS11,st.sucu11||0);

  const racion = (pide, stock, redondeo) => {
    if (D > pideTotal) return pide;
    if (pideEf === 0) return 'DIV0';
    const share = ef(pide, stock) * D / pideEf;
    return redondeo === 'up' ? roundup(share, 0) : round(share, 0);
  };
  // Rivadavia (J): nostock=(D<=0 && stock<=min); redondeo UP; fact=rivadavia
  const eRiv = has(restr.rivadavia, plu) ? 'Restringido'
    : pa.rivadavia === 1 ? 'Fact'
    : (D <= 0 && (st.riv||0) <= minRiv) ? 'No stock'
    : ((st.riv||0) > minRiv || minRiv === 0) ? 'No'
    : racion(pRiv, st.riv||0, 'up');
  // Genérico no-Rivadavia con chequeo Fact y nostock=(Ecentral && stock<=min)
  const envGen = (restrSet, factFlag, stock, min, pide) =>
      has(restrSet, plu) ? 'Restringido'
    : factFlag === 1 ? 'Fact'
    : (E_noStock && stock <= min) ? 'No stock'
    : (stock > min || min === 0) ? 'No'
    : racion(pide, stock, 'round');
  const eUrq = envGen(restr.urquiza,   pa.urquiza,   st.urq||0,       minUrq,    pUrq);
  const eNac = envGen(restr.nacion,    pa.nacion,    st.nacion||0,    minNacion, pNac);
  const eCha = envGen(restr.chacabuco, pa.chacabuco, st.chaca||0,     minChaca,  pCha);
  const ePer = envGen(restr.pergamino, pa.pergamino, st.pergamino||0, minPergamino, pPer);
  const eSan = envGen(restr.sanPedro,  pa.sanPedro,  st.sanpedro||0,  minSanPedro, pSan);
  // Sucu8 (AH): restr=sanPedro, SIN Fact, nostock=(E && stock>min)  [vestigial, no sale]
  const eSu8 = has(restr.sanPedro, plu) ? 'Restringido'
    : (E_noStock && (st.sucu8||0) > minSucu8) ? 'No stock'
    : ((st.sucu8||0) > minSucu8 || minSucu8 === 0) ? 'No'
    : racion(pSu8, st.sucu8||0, 'round');
  // Sucu9 (AL → sucursal9): restr/fact villaRamallo; nostock=(E && stock>min)
  const eSu9 = has(restr.villaRamallo, plu) ? 'Restringido'
    : pa.villaRamallo === 1 ? 'Fact'
    : (E_noStock && (st.sucu9||0) > minSucu9) ? 'No stock'
    : ((st.sucu9||0) > minSucu9 || minSucu9 === 0) ? 'No'
    : racion(pSu9, st.sucu9||0, 'round');
  // Sucu11 (AP → sucursal11): restr=sanPedro, SIN Fact, nostock=(E && stock>min)
  const eS11 = has(restr.sanPedro, plu) ? 'Restringido'
    : (E_noStock && (st.sucu11||0) > minSucu11) ? 'No stock'
    : ((st.sucu11||0) > minSucu11 || minSucu11 === 0) ? 'No'
    : racion(pS11, st.sucu11||0, 'round');

  // Numérico final (AQ:AY): 'Fact' se preserva como string; otro no-numérico → 0; logia forzado 0
  const n = (v) => (isNum(v) ? v : 0);
  const fe = (v) => v === 'Fact' ? 'Fact' : n(v);
  const enviar = { riv: fe(eRiv), urq: fe(eUrq), nacion: fe(eNac), chaca: fe(eCha),
    pergamino: fe(ePer), sanPedro: fe(eSan), logia: 0, sucursal9: fe(eSu9), sucursal11: fe(eS11) };

  // Importancia BA (excluye Rivadavia). term^1.15, penaliza 5% por enviar no-numérico.
  const term = (min, stock, enviarTxt) =>
    Math.pow((min > 0 && stock <= min && isNum(enviarTxt)) ? (stock === 0 ? BB : BB * (1 - stock / min / 2)) : 0, 1.15);
  const maxTerm = Math.max(
    term(minUrq, st.urq||0, eUrq), term(minNacion, st.nacion||0, eNac),
    term(minChaca, st.chaca||0, eCha), term(minPergamino, st.pergamino||0, ePer),
    term(minSanPedro, st.sanpedro||0, eSan), term(minSucu8, st.sucu8||0, eSu8),
    term(minSucu9, st.sucu9||0, eSu9), term(minSucu11, st.sucu11||0, eS11),
  );
  const penal = 1 - [eUrq, eNac, eCha, ePer, eSan, eSu8, eSu9, eS11]
    .reduce((s, v) => s + (isNum(v) ? 0 : 0.05), 0);
  const importancia = maxTerm * penal;

  const consumo = a.consumo || 0;
  const meses = consumo > 0 ? roundup(D / consumo, 2) : 0;

  return {
    plu, envasa: envasaSi ? 'Si' : 'No', central: D, base8020: BB,
    mins: { riv: minRiv, urq: minUrq, nacion: minNacion, chaca: minChaca, pergamino: minPergamino,
            sanpedro: minSanPedro, sucu8: minSucu8, sucu9: minSucu9, sucu11: minSucu11 },
    enviar, pideTotal, importancia, meses,
    enviarTexto: { riv: eRiv, urq: eUrq, nacion: eNac, chaca: eCha, pergamino: ePer,
                   sanPedro: eSan, sucu8: eSu8, sucu9: eSu9, sucu11: eS11 },
  };
}

// ── Todas las filas + normalización importancia (columna C) ──────────────────
// productos = [{ plu, stocks:{central,riv,urq,nacion,chaca,pergamino,sanpedro,sucu8,sucu9,sucu11} }]
function calcularAlmacen(productos, a8020, listas, opts) {
  const noEnvasaSet = new Set((listas.noEnvasa || []).map(Number));
  const restr = {};
  for (const [k, arr] of Object.entries(listas.restringidos || {})) restr[k] = new Set(arr.map(Number));
  const prodAlm = listas.productosAlmacen || {};
  const impMin = listas.importanciaMinorista || {};

  const filas = productos.map((p) => {
    const plu = Number(p.plu);
    return calcularFilaAlmacen(plu, p.stocks || {}, a8020[String(plu)], prodAlm[String(plu)],
      restr, noEnvasaSet, impMin[String(plu)], opts);
  });

  const maxBA = Math.max(0.01, ...filas.map((f) => f.importancia || 0));   // Referencias!B13
  for (const f of filas) f.impNorm = f.importancia / maxBA;                 // columna C
  return filas;
}

module.exports = { calcularAlmacen, calcularFilaAlmacen, SUCURSALES_SALIDA, round, roundup };
