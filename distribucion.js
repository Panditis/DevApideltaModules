'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  distribucion.js — motor de distribución a sucursales (réplica hoja "Almacen")
//
//  Replica la planilla "Listas Envasado-Almacen". Flag `corregirBugs`:
//    false → paridad EXACTA con la planilla (incluye bugs) → para validar golden.
//    true  → versión corregida → producción.
//
//  Cambios corregidos con flag (la planilla copiaba el bloque Chacabuco):
//    - Pergamino: Min propio (no el de Chacabuco).
//    - V.Ramallo (sucu9): idem.
//    - Flag estático ProductosAlmacen IGNORADO: no fija min=0 ni pinta 'Fact'.
//      El 'Fact' real lo aplica server.js desde calcularFactLive() (facturado a la
//      sucursal desde su última recepción). Todo se recalcula, nada queda estático.
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

// Pide teórico: gatilla si stock ≤ min (punto de pedido); repone hasta S (order-up-to).
//   pedido = MAX(S − stock, 0).  Reemplaza la vieja fórmula (BB>0.75?min*2:min*4) − stock/2.
function pideTeorico(min, S, stock, envasaSi) {
  if (!(min >= stock && envasaSi)) return 0;
  return Math.max((S || 0) - stock, 0);
}

// Min con piso: flag ProductosAlmacen>0 ⇒ 0; sino MAX(minA8020, piso)
function minConPiso(flag, minA8020, piso) {
  return flag > 0 ? 0 : Math.max(minA8020 || 0, piso);
}

// Piso mínimo de envío: por debajo de esto no vale la pena mandar (abrir cajas, parada de
// transporte extra por 1-2 unidades). Escala con S de la sucursal para ese PLU: S alto usa % más
// bajo (no exige acumular demasiado para gatillar), S bajo usa % más alto (una unidad suelta sigue
// sin ser viable aunque sea "20% de casi nada"). tramos: [{hastaS, pct}], ordenado asc, hastaS=null
// es el catch-all final.
function pisoMinimo(S, tramos, pisoAbsoluto) {
  const s = S || 0;
  const tramo = (tramos || []).find(t => t.hastaS == null || s <= t.hastaS) || { pct: 0 };
  return Math.max(pisoAbsoluto || 0, round(s * (tramo.pct || 0), 0));
}

// Reparte D entre sucursales activas (pide>0) en orden de URGENCIA relativa a su S (pide/S — no
// acotada a [0,1]: pideTeorico ya garantiza pide=S-stock cuando pide>0, así que esto es
// equivalente a "cuán vacía está relativo a su objetivo" sin necesitar el stock por separado; si
// el stock está negativo (Siga lo permite) pide/S puede superar 1, y eso está bien: una sucursal
// más sobrevendida ordena antes que una menos sobrevendida, en vez de empatar en un tope) — no por
// pesosRacionado fijo. pesosRacionado solo desempata cuando dos sucursales tienen exactamente la
// misma urgencia. Primero reparte el piso mínimo a todas las urgidas que el pool alcance, después
// vuelca el sobrante hacia las más urgidas hasta agotar D o los pedidos.
function racionarPorPrioridad(pidePorClave, sPorClave, D, pesosRacionado, ordenClaves, tramos, pisoAbsoluto) {
  const urgencia = (k) => {
    const S = sPorClave[k] || 0;
    return S > 0 ? (pidePorClave[k] || 0) / S : 0;
  };
  const orden = [...ordenClaves].sort((a, b) => {
    const diff = urgencia(b) - urgencia(a);
    if (Math.abs(diff) > 1e-9) return diff;
    return (pesosRacionado[b] || 0) - (pesosRacionado[a] || 0);
  });
  const racionPorClave = {};
  for (const k of ordenClaves) racionPorClave[k] = 0;
  let restante = Math.max(D, 0);
  // Pasada 1: piso mínimo a cada sucursal activa que el pool alcance, en orden de
  // urgencia. Si D es "importante" (alcanza para el piso de varias), reparte primero un mínimo
  // viable a todas antes de concentrar en la más urgida. Si no alcanza ni para el piso de una,
  // se la salta (no corta, prueba la siguiente).
  for (const k of orden) {
    const pide = pidePorClave[k] || 0;
    if (pide <= 0) continue;
    const piso = pisoMinimo(sPorClave[k], tramos, pisoAbsoluto);
    if (pide < piso || restante < piso) continue;
    racionPorClave[k] = piso;
    restante -= piso;
  }
  // Pasada 2: con lo que sobra, completa hacia el pedido total — SOLO a las que ya limpiaron su
  // piso en la pasada 1. Las que quedaron en 0 no se reintentan acá: con lo poco que sobre al
  // final podría tocarles menos que su piso, y ese es justo el problema que esta función existe
  // para evitar.
  for (const k of orden) {
    if (racionPorClave[k] <= 0 || restante <= 0) continue;
    const pide = pidePorClave[k] || 0;
    const falta = pide - racionPorClave[k];
    if (falta <= 0) continue;
    const dar = round(Math.min(falta, restante), 0);
    racionPorClave[k] += dar;
    restante -= dar;
  }
  return racionPorClave;
}

// ── Cálculo de una fila de Almacen ───────────────────────────────────────────
function calcularFilaAlmacen(plu, st, a, pa, restr, noEnvasaSet, base8020Raw, opts) {
  a = a || {}; pa = pa || {};
  const corregir = !opts || opts.corregirBugs !== false;   // default true
  // Producción: ignorar el flag estático ProductosAlmacen (no fija min=0 ni pinta
  // 'Fact'). El 'Fact' real lo aplica server.js desde facturación viva. Modo paridad
  // conserva el flag para replicar la planilla (golden).
  if (corregir) pa = {};
  const D = st.central || 0;
  const BB = Math.max(base8020Raw || 0, 0.01);
  const envasaSi = !noEnvasaSet.has(plu);                   // BE
  const E_noStock = !(D > 0);                               // E: "No stock" si central<=0
  const has = (set, p) => !!(set && set.has(p));
  const pisoUno = D > 0 ? 1 : 0;

  // Empuje por stock en central: si hay stock en el depósito (D>0) y la demanda estadística es baja
  // (S < presencia), fija góndola mínima: gatillo (min) = presencia y objetivo (S) = presencia·factor.
  // El factor deja brecha entre min y S (batch) para no reponer de a 1 (micro-envío). Se auto-limita
  // al stock del central vía el rateo. Logia(minLogia/SLogia, id 8) y Sucu11(minVConst/SVConst, id 11)
  // están inactivas en Siga — no se empujan (quedan siempre en 0, no cuentan para nada en el reparto).
  const PARES_MIN_S = [['minRiv','SRiv'],['minUrq','SUrq'],['minNacion','SNacion'],['minChaca','SChaca'],
    ['minPergamino','SPergamino'],['minSanPedro','SSanPedro'],
    ['minVRamallo','SVRamallo']];
  // Presencia según importancia: si hay presenciaPorClase usa el valor de la clase ABC del PLU
  // (A lento importante → góndola más alta; C lento irrelevante → baja). Si no, presencia plana.
  const presPorClase = opts && opts.presenciaPorClase;
  const claseAbc = (opts && opts.abcPorPlu && opts.abcPorPlu[plu]) || null;
  const pres = presPorClase
    ? (presPorClase[claseAbc] != null ? presPorClase[claseAbc] : (presPorClase.C != null ? presPorClase.C : 0))
    : ((opts && opts.empujePresencia) || 0);
  const presFactorS = Math.max(1, (opts && opts.empujePresenciaFactorS) || 1);
  // Regla "caro y lento" (opts.sinEmpujeCaroLento; sin esa clave el motor se comporta como siempre):
  // producto de ALTA facturación (clase A por defecto) que en esa sucursal rota poco (μ < umbralMu
  // u/día) NO recibe el empuje de góndola — ese empuje lo llevaría a presencia·factor (24u para un
  // clase A) y son justo los que más capital inmovilizan por unidad: llenarles la góndola cuesta caro
  // y la rotación no lo devuelve. Quedan con el min y el S del A8020, con un piso propio
  // (pisoMin/pisoS) para no caer en cantidades testimoniales.
  // El umbral es ABSOLUTO (u/día) y no una clase ABC: la clase por facturación no dice nada de
  // rotación, y una por unidades sería relativa al catálogo — con una cola larga, 0,5 u/día igual
  // saldría 'A'.
  const clCfg = (opts && opts.sinEmpujeCaroLento) || null;
  const clClases = new Set((clCfg && clCfg.clasesFact) || ['A']);
  const clUmbral = clCfg && clCfg.umbralMu != null ? clCfg.umbralMu : 0;
  const clPisoS = (clCfg && clCfg.pisoS != null) ? clCfg.pisoS : 0;
  const clPisoMin = (clCfg && clCfg.pisoMin != null) ? clCfg.pisoMin : 0;
  const muPorClaveS = (opts && opts.muPorPlu && opts.muPorPlu[plu]) || null;
  const esCaroLento = (sk) => {
    if (!clCfg || !clClases.has(claseAbc)) return false;
    return (muPorClaveS ? (muPorClaveS[sk] || 0) : 0) < clUmbral;
  };
  if (pres > 0 && D > 0 && envasaSi && !a.claseF) {   // clase F (viejo sin rotación): no se empuja
    const aa = { ...a };
    const objetivo = Math.round(pres * presFactorS);   // objetivo por encima del gatillo → brecha (batch)
    for (const [mk, sk] of PARES_MIN_S) {
      if (esCaroLento(sk)) {                           // caro y lento: A8020 + piso propio, sin empuje
        if ((aa[sk] || 0) < clPisoS) aa[sk] = clPisoS;
        if ((aa[mk] || 0) < clPisoMin) aa[mk] = clPisoMin;
        continue;
      }
      if ((aa[mk] || 0) < pres) aa[mk] = pres;          // gatillo (min) ≥ presencia (piso de góndola)
      if ((aa[sk] || 0) < pres) aa[sk] = objetivo;      // demanda baja (S<presencia) → objetivo = presencia·factor (> min)
    }
    a = aa;
  }
  // Empuje "producto nuevo": eleva min/S al propio stock de central (D) para que el
  // racionamiento por % reparta la mayor parte del depósito entre sucursales según su
  // peso (opts.pesosRacionado), en vez de esperar a que el min normal lo gatille.
  const esNuevo = has(opts && opts.esNuevoSet, plu);
  if (esNuevo && D > 0 && envasaSi && !a.claseF) {
    const aa = { ...a };
    for (const [mk, sk] of PARES_MIN_S) { aa[sk] = Math.max(aa[sk] || 0, D); aa[mk] = Math.max(aa[mk] || 0, D); }
    a = aa;
  }

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

  // Order-up-to (S) por sucursal — nivel al que se repone (a8020.json: SRiv, SUrq, …)
  const sRiv = a.SRiv||0, sUrq = a.SUrq||0, sNac = a.SNacion||0, sCha = a.SChaca||0,
        sPer = (corregir ? a.SPergamino : a.SChaca)||0, sSan = a.SSanPedro||0,
        sSu8 = a.SLogia||0, sSu9 = (corregir ? a.SVRamallo : a.SChaca)||0, sS11 = a.SVConst||0;

  // Pide teórico por sucursal: gatilla con min, repone hasta S
  const pRiv = pideTeorico(minRiv, sRiv, st.riv||0, envasaSi);
  const pUrq = pideTeorico(minUrq, sUrq, st.urq||0, envasaSi);
  const pNac = pideTeorico(minNacion, sNac, st.nacion||0, envasaSi);
  const pCha = pideTeorico(minChaca, sCha, st.chaca||0, envasaSi);
  const pPer = pideTeorico(minPergamino, sPer, st.pergamino||0, envasaSi);
  const pSan = pideTeorico(minSanPedro, sSan, st.sanpedro||0, envasaSi);
  const pSu8 = pideTeorico(minSucu8, sSu8, st.sucu8||0, envasaSi);
  const pSu9 = pideTeorico(minSucu9, sSu9, st.sucu9||0, envasaSi);
  const pS11 = pideTeorico(minSucu11, sS11, st.sucu11||0, envasaSi);

  // Racionamiento por urgencia: cuando el stock central no alcanza para todos, NO se prorratea
  // proporcional (fragmenta en pedazos chicos no viables logísticamente) ni se sirve por ranking
  // fijo de sucursal. Se sirve en orden de urgencia relativa a su S (racionarPorPrioridad) — cada
  // sucursal recibe su pedido completo o nada — nunca menos que su piso mínimo
  // (opts.umbralMicroEnvio, escalado por el S de esa sucursal). Si una no alcanza su piso, se
  // prueba la siguiente en la cola (no corta) para no desperdiciar stock que sí le alcanza a una
  // más urgida más abajo en el orden.
  // Sucursales que van a salir Fact/Restringido (no consumen stock real) se excluyen del
  // reparto ANTES de calcularlo — si no, su "pide" fantasma le come cupo al resto del pool
  // compartido aunque después nunca se use (bug visto en PLU 2121: Rivadavia en Fact restaba
  // stock que le hacía falta a Chacabuco/Villa Ramallo).
  const factGateSet = (opts && opts.factGatePorPlu && opts.factGatePorPlu.get(String(plu))) || null;
  const factGate = (k) => !!(factGateSet && factGateSet.has(k));
  const GATEADO = {
    riv: has(restr.rivadavia, plu) || pa.rivadavia === 1 || factGate('riv'),
    urq: has(restr.urquiza, plu) || pa.urquiza === 1 || factGate('urq'),
    nacion: has(restr.nacion, plu) || pa.nacion === 1 || factGate('nacion'),
    chaca: has(restr.chacabuco, plu) || pa.chacabuco === 1 || factGate('chaca'),
    pergamino: has(restr.pergamino, plu) || pa.pergamino === 1 || factGate('pergamino'),
    sanpedro: has(restr.sanPedro, plu) || pa.sanPedro === 1 || factGate('sanpedro'),
    sucu8: has(restr.sanPedro, plu),
    sucu9: has(restr.villaRamallo, plu) || pa.villaRamallo === 1 || factGate('sucu9'),
    sucu11: has(restr.sanPedro, plu) || factGate('sucu11'),
  };
  const PESOS_RACIONADO_DEFAULT = { riv: 0.50, chaca: 0.20, nacion: 0.12, urq: 0.08, pergamino: 0.06, sucu9: 0.03, sanpedro: 0.01, sucu8: 0, sucu11: 0 };
  const pesosRacionado = (opts && opts.pesosRacionado) || PESOS_RACIONADO_DEFAULT;
  const ORDEN_CLAVES = ['riv', 'urq', 'nacion', 'chaca', 'pergamino', 'sanpedro', 'sucu8', 'sucu9', 'sucu11'];
  const pidePorClaveCruda = { riv: pRiv, urq: pUrq, nacion: pNac, chaca: pCha, pergamino: pPer, sanpedro: pSan, sucu8: pSu8, sucu9: pSu9, sucu11: pS11 };
  const pidePorClave = {};
  for (const k of ORDEN_CLAVES) pidePorClave[k] = GATEADO[k] ? 0 : pidePorClaveCruda[k];
  const pideTotal = ORDEN_CLAVES.reduce((s, k) => s + (pidePorClave[k] || 0), 0);   // BD (ya sin gateados)
  const sPorClave = { riv: sRiv, urq: sUrq, nacion: sNac, chaca: sCha, pergamino: sPer, sanpedro: sSan, sucu8: sSu8, sucu9: sSu9, sucu11: sS11 };
  const umbralCfg = (opts && opts.umbralMicroEnvio) || {};
  const tramosMicro = umbralCfg.tramos || [{ hastaS: null, pct: 0.20 }];
  const pisoAbsolutoMicro = umbralCfg.pisoAbsoluto != null ? umbralCfg.pisoAbsoluto : 1;
  const racionPorClave = D > pideTotal
    ? Object.fromEntries(ORDEN_CLAVES.map(k => [k, pidePorClave[k] || 0]))
    : racionarPorPrioridad(pidePorClave, sPorClave, D, pesosRacionado, ORDEN_CLAVES, tramosMicro, pisoAbsolutoMicro);
  const racion = (key) => racionPorClave[key];
  // Rivadavia (J): nostock=(D<=0 && stock<=min); redondeo UP; fact=rivadavia
  const eRiv = has(restr.rivadavia, plu) ? 'Restringido'
    : pa.rivadavia === 1 ? 'Fact'
    : (D <= 0 && (st.riv||0) <= minRiv) ? 'No stock'
    : ((st.riv||0) > minRiv || minRiv === 0) ? 'No'
    : racion('riv');
  // Genérico no-Rivadavia con chequeo Fact y nostock=(Ecentral && stock<=min)
  const envGen = (restrSet, factFlag, stock, min, key) =>
      has(restrSet, plu) ? 'Restringido'
    : factFlag === 1 ? 'Fact'
    : (E_noStock && stock <= min) ? 'No stock'
    : (stock > min || min === 0) ? 'No'
    : racion(key);
  const eUrq = envGen(restr.urquiza,   pa.urquiza,   st.urq||0,       minUrq,    'urq');
  const eNac = envGen(restr.nacion,    pa.nacion,    st.nacion||0,    minNacion, 'nacion');
  const eCha = envGen(restr.chacabuco, pa.chacabuco, st.chaca||0,     minChaca,  'chaca');
  const ePer = envGen(restr.pergamino, pa.pergamino, st.pergamino||0, minPergamino, 'pergamino');
  const eSan = envGen(restr.sanPedro,  pa.sanPedro,  st.sanpedro||0,  minSanPedro, 'sanpedro');
  // Sucu8 (AH): restr=sanPedro, SIN Fact, nostock=(E && stock>min)  [vestigial, no sale]
  const eSu8 = has(restr.sanPedro, plu) ? 'Restringido'
    : (E_noStock && (st.sucu8||0) > minSucu8) ? 'No stock'
    : ((st.sucu8||0) > minSucu8 || minSucu8 === 0) ? 'No'
    : racion('sucu8');
  // Sucu9 (AL → sucursal9): restr/fact villaRamallo; nostock=(E && stock>min)
  const eSu9 = has(restr.villaRamallo, plu) ? 'Restringido'
    : pa.villaRamallo === 1 ? 'Fact'
    : (E_noStock && (st.sucu9||0) > minSucu9) ? 'No stock'
    : ((st.sucu9||0) > minSucu9 || minSucu9 === 0) ? 'No'
    : racion('sucu9');
  // Sucu11 (AP → sucursal11): restr=sanPedro, SIN Fact, nostock=(E && stock>min)
  const eS11 = has(restr.sanPedro, plu) ? 'Restringido'
    : (E_noStock && (st.sucu11||0) > minSucu11) ? 'No stock'
    : ((st.sucu11||0) > minSucu11 || minSucu11 === 0) ? 'No'
    : racion('sucu11');

  // Piso mínimo de envío: descarta envío calculado < pisoMinimo(S) escalonado
  // (opts.umbralMicroEnvio.tramos) — mismo piso que ya usó racionarPorPrioridad arriba para decidir
  // quién entra a la cola. Se reaplica acá porque D > pideTotal no pasa por esa función (cada
  // sucursal recibe su pide crudo, que igual puede ser chico sin que haya escasez de por medio).
  // Sí afecta a importancia (usa eXxxM post-piso) — un envío Micro no debe impulsar la importancia
  // del producto. enviarMicro guarda {qty,umbral,S,min} de las suprimidas (pre-piso), para la UI.
  const enviarMicro = {};
  const piso = (valor, S, min, key) => {
    if (!isNum(valor) || valor <= 0) return valor;
    const umbralAbs = pisoMinimo(S, tramosMicro, pisoAbsolutoMicro);
    if (valor < umbralAbs) { enviarMicro[key] = { qty: valor, umbral: umbralAbs, S, min }; return 'Micro'; }
    return valor;
  };
  const eRivM = piso(eRiv, sRiv, minRiv, 'riv');
  const eUrqM = piso(eUrq, sUrq, minUrq, 'urq');
  const eNacM = piso(eNac, sNac, minNacion, 'nacion');
  const eChaM = piso(eCha, sCha, minChaca, 'chaca');
  const ePerM = piso(ePer, sPer, minPergamino, 'pergamino');
  const eSanM = piso(eSan, sSan, minSanPedro, 'sanPedro');
  const eSu8M = piso(eSu8, sSu8, minSucu8, 'sucu8');
  const eSu9M = piso(eSu9, sSu9, minSucu9, 'sucu9');
  const eS11M = piso(eS11, sS11, minSucu11, 'sucu11');

  // Numérico final (AQ:AY): 'Fact' se preserva como string; otro no-numérico → 0; logia forzado 0
  const n = (v) => (isNum(v) ? v : 0);
  const fe = (v) => v === 'Fact' ? 'Fact' : n(v);
  const enviar = { riv: fe(eRivM), urq: fe(eUrqM), nacion: fe(eNacM), chaca: fe(eChaM),
    pergamino: fe(ePerM), sanPedro: fe(eSanM), logia: 0, sucursal9: fe(eSu9M), sucursal11: fe(eS11M) };

  // ── Importancia ──────────────────────────────────────────────────────────────
  // Legacy (planilla, BA): MAX de una sola sucursal, term^1.15, penaliza 5% por envío no-numérico, excluye Rivadavia.
  const term = (min, stock, enviarTxt) =>
    Math.pow((min > 0 && stock <= min && isNum(enviarTxt)) ? (stock === 0 ? BB : BB * (1 - stock / min / 2)) : 0, 1.15);
  const maxTerm = Math.max(
    term(minUrq, st.urq||0, eUrqM), term(minNacion, st.nacion||0, eNacM),
    term(minChaca, st.chaca||0, eChaM), term(minPergamino, st.pergamino||0, ePerM),
    term(minSanPedro, st.sanpedro||0, eSanM), term(minSucu8, st.sucu8||0, eSu8M),
    term(minSucu9, st.sucu9||0, eSu9M), term(minSucu11, st.sucu11||0, eS11M),
  );
  const penal = 1 - [eUrqM, eNacM, eChaM, ePerM, eSanM, eSu8M, eSu9M, eS11M]
    .reduce((s, v) => s + (isNum(v) ? 0 : 0.05), 0);
  const importanciaLegacy = maxTerm * penal;

  // Real (opts.importancia.modo==='real'): importancia = venta general del producto, NO necesidad de
  // stock de cada sucursal. Peso por sucursal = ranking A8020 de esa sucursal (a.rankXxx, 0-1: qué tan
  // importante es el PLU ahí específicamente), tal cual — sin S (demanda), sin stock/min/urgencia.
  // Gate = mn>0 (la sucursal tiene punto de pedido para este PLU, o sea lo vende) decide participación,
  // no peso. Fallback en 3 pasos si falta el rank de esta sucursal, TODOS en escala 0-1 (rank/rankGeneral
  // y BB NO se mezclan directo: BB es facturación cruda, puede ser miles — mezclar escalas dispara la
  // importancia de esos PLUs muy por encima del resto y, al normalizar contra el máximo del catálogo,
  // aplasta a todos los demás cerca de 0):
  //   1) el producto SÍ tiene rank en otras sucursales → promedio de esas.
  //   2) el producto no tiene rank en NINGUNA sucursal → rankGeneral (ranking global, mismo 0-1).
  //   3) ni siquiera tiene rankGeneral (a8020.json viejo, sin recalcular) → BB crudo, último recurso.
  const impCfg = (opts && opts.importancia) || {};
  let importancia = importanciaLegacy;
  let impSucOut = null;   // contribución por sucursal → el cliente suma solo las visibles y renormaliza
  if (impCfg.modo === 'real') {
    const ranksProducto = [a.rankRiv, a.rankUrq, a.rankNacion, a.rankChaca, a.rankPergamino, a.rankSanPedro, a.rankVRamallo]
      .filter((r) => isNum(r) && r > 0);
    const rankProm = ranksProducto.length ? ranksProducto.reduce((s, r) => s + r, 0) / ranksProducto.length : null;
    const valorGlobal = isNum(a.rankGeneral) && a.rankGeneral > 0 ? a.rankGeneral
      : (impCfg.usarBB === false ? 1 : (BB > 0 ? BB : 1));
    const impSuc = {};
    let acc = 0;
    const addSuc = (key, mn, rank) => {
      if (!(mn > 0)) { impSuc[key] = 0; return; }      // sucursal sin punto de pedido para este PLU → no lo vende ahí
      const valor = (isNum(rank) && rank > 0) ? rank : (rankProm != null ? rankProm : valorGlobal);
      impSuc[key] = valor; acc += valor;
    };
    addSuc('urq', minUrq, a.rankUrq);
    addSuc('nacion', minNacion, a.rankNacion);
    addSuc('chaca', minChaca, a.rankChaca);
    addSuc('pergamino', minPergamino, a.rankPergamino);
    addSuc('sanPedro', minSanPedro, a.rankSanPedro);
    addSuc('sucursal9', minSucu9, a.rankVRamallo);
    if (impCfg.incluirRivadavia !== false) addSuc('riv', minRiv, a.rankRiv);
    importancia = acc;
    impSucOut = impSuc;
  }

  const consumo = a.consumo || 0;
  const meses = consumo > 0 ? roundup(D / consumo, 2) : 0;

  return {
    plu, envasa: envasaSi ? 'Si' : 'No', central: D, base8020: BB,
    mins: { riv: minRiv, urq: minUrq, nacion: minNacion, chaca: minChaca, pergamino: minPergamino,
            sanpedro: minSanPedro, sucu8: minSucu8, sucu9: minSucu9, sucu11: minSucu11 },
    sLevels: { riv: sRiv, urq: sUrq, nacion: sNac, chaca: sCha, pergamino: sPer,
               sanpedro: sSan, sucu8: sSu8, sucu9: sSu9, sucu11: sS11 },
    enviar, pideTotal, importancia, impSuc: impSucOut, meses,
    ideal: { riv: pRiv, urq: pUrq, nacion: pNac, chaca: pCha, pergamino: pPer,
             sanPedro: pSan, sucursal9: pSu9 },   // pedido teórico (S−stock) sin límite de central
    enviarTexto: { riv: eRivM, urq: eUrqM, nacion: eNacM, chaca: eChaM, pergamino: ePerM,
                   sanPedro: eSanM, sucu8: eSu8M, sucu9: eSu9M, sucu11: eS11M },
    enviarMicro,
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

module.exports = { calcularAlmacen, calcularFilaAlmacen, SUCURSALES_SALIDA, round, roundup, pisoMinimo, racionarPorPrioridad };
