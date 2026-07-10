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
  // (S < presencia), eleva min y S de cada sucursal a un piso de "presencia" para impulsar el envío
  // aunque no haya estadística que lo respalde. Se auto-limita al stock del central vía el rateo.
  // Logia(minLogia/SLogia, id 8) y Sucu11(minVConst/SVConst, id 11) están inactivas en Siga
  // — no se empujan (quedan siempre en 0, no cuentan para nada en el reparto).
  const PARES_MIN_S = [['minRiv','SRiv'],['minUrq','SUrq'],['minNacion','SNacion'],['minChaca','SChaca'],
    ['minPergamino','SPergamino'],['minSanPedro','SSanPedro'],
    ['minVRamallo','SVRamallo']];
  const pres = (opts && opts.empujePresencia) || 0;
  if (pres > 0 && D > 0 && envasaSi && !a.claseF) {   // clase F (viejo sin rotación): no se empuja
    const aa = { ...a };
    for (const [mk, sk] of PARES_MIN_S) {
      if ((aa[sk] || 0) < pres) aa[sk] = pres;   // objetivo (S) ≥ presencia
      if ((aa[mk] || 0) < pres) aa[mk] = pres;   // gatillo (min) ≥ presencia → topa sucursales con poco
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

  // Racionamiento por prioridad (porcentaje con waterfall): cuando el stock central no
  // alcanza para todos, se reparte según el peso de cada sucursal; si a alguna le sobra
  // porque cubre el 100% de su pedido con su cuota, el excedente se redistribuye entre
  // el resto según sus pesos (no se pierde stock). Pesos configurables vía
  // opts.pesosRacionado.
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
  const minPorClave = { riv: minRiv, urq: minUrq, nacion: minNacion, chaca: minChaca, pergamino: minPergamino, sanpedro: minSanPedro, sucu8: minSucu8, sucu9: minSucu9, sucu11: minSucu11 };
  const stockPorClave = { riv: st.riv||0, urq: st.urq||0, nacion: st.nacion||0, chaca: st.chaca||0, pergamino: st.pergamino||0, sanpedro: st.sanpedro||0, sucu8: st.sucu8||0, sucu9: st.sucu9||0, sucu11: st.sucu11||0 };
  // Urgencia de stock (0=cómoda, 1=en/bajo mínimo) manda sobre la prioridad fija de
  // sucursal: una diferencia de urgencia de 0.1 ya pesa más que toda la escala de
  // importancia (máx 0.5) — la importancia solo desempata entre urgencias parecidas.
  const pesoEfectivo = (k) => {
    const min = minPorClave[k];
    const urgencia = min > 0 ? Math.max(0, 1 - stockPorClave[k] / min) : (stockPorClave[k] <= 0 ? 1 : 0);
    return urgencia * 10 + (pesosRacionado[k] || 0);
  };
  const racionPorClave = {};
  if (D > pideTotal) {
    for (const k of ORDEN_CLAVES) racionPorClave[k] = pidePorClave[k] || 0;
  } else {
    const asignCrudo = {}; for (const k of ORDEN_CLAVES) asignCrudo[k] = 0;
    let activos = new Set(ORDEN_CLAVES.filter(k => (pidePorClave[k] || 0) > 0));
    let restante = Math.max(D, 0);
    let guard = 0;
    while (restante > 1e-9 && activos.size && guard++ < ORDEN_CLAVES.length + 1) {
      const sumaPesos = [...activos].reduce((s, k) => s + pesoEfectivo(k), 0);
      if (sumaPesos <= 0) break;
      let sobra = 0;
      for (const k of [...activos]) {
        const cuota = restante * (pesoEfectivo(k) / sumaPesos);
        const falta = (pidePorClave[k] || 0) - asignCrudo[k];
        if (cuota >= falta) { asignCrudo[k] += falta; sobra += cuota - falta; activos.delete(k); }
        else { asignCrudo[k] += cuota; }
      }
      restante = sobra;
    }
    // Redondeo con reparto de resto (largest remainder): si cada sucursal se redondea
    // independiente, la suma final puede no dar D exacto (queda remanente sin repartir).
    // Se redondea todo hacia abajo y las unidades sobrantes van a quienes tengan mayor
    // parte fraccionaria, hasta agotar el stock racionado.
    const enteros = {}; let sumaEnteros = 0;
    for (const k of ORDEN_CLAVES) { enteros[k] = Math.floor(asignCrudo[k]); sumaEnteros += enteros[k]; }
    let sobranteEntero = Math.round(Math.min(D, pideTotal)) - sumaEnteros;
    const porFraccion = ORDEN_CLAVES.filter(k => asignCrudo[k] > 0)
      .sort((a, b) => (asignCrudo[b] - enteros[b]) - (asignCrudo[a] - enteros[a]));
    for (const k of porFraccion) {
      if (sobranteEntero <= 0) break;
      enteros[k] += 1; sobranteEntero -= 1;
    }
    for (const k of ORDEN_CLAVES) racionPorClave[k] = enteros[k];
  }
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

  // Piso de micro-envío: descarta envío calculado < umbral% del S de esa sucursal (opts.umbralMicroEnvio).
  // Aplica siempre, sin importar el stock propio de la sucursal (no vale la pena logísticamente igual).
  // No afecta a importancia (usa eXxx original, sin piso) — la prioridad no depende de si conviene enviarlo.
  // enviarMicro guarda {qty,umbral,S,min} de las sucursales suprimidas (pre-piso), para mostrar en UI.
  const umbralMicro = (opts && opts.umbralMicroEnvio) || 0;
  const enviarMicro = {};
  const piso = (valor, S, min, key) => {
    if (!isNum(valor) || valor <= 0 || umbralMicro <= 0) return valor;
    const umbralAbs = round(Math.max(umbralMicro * (S || 0), 1), 0);   // piso = umbral·S redondeado, mínimo absoluto 1
    if (valor < umbralAbs) { enviarMicro[key] = { qty: valor, umbral: umbralAbs, S, min }; return 'Micro'; }   // valor >= umbralAbs para enviar
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
    term(minUrq, st.urq||0, eUrq), term(minNacion, st.nacion||0, eNac),
    term(minChaca, st.chaca||0, eCha), term(minPergamino, st.pergamino||0, ePer),
    term(minSanPedro, st.sanpedro||0, eSan), term(minSucu8, st.sucu8||0, eSu8),
    term(minSucu9, st.sucu9||0, eSu9), term(minSucu11, st.sucu11||0, eS11),
  );
  const penal = 1 - [eUrq, eNac, eCha, ePer, eSan, eSu8, eSu9, eS11]
    .reduce((s, v) => s + (isNum(v) ? 0 : 0.05), 0);
  const importanciaLegacy = maxTerm * penal;

  // Real (opts.importancia.modo==='real'): urgencia continua × demanda de la sucursal (S) agregada sobre
  // TODAS las sucursales que pueden recibir → premia amplitud (cuántas sucursales), tamaño (S) y urgencia
  // (qué tan bajo del min), por el valor del producto (BB = importancia minorista). Fallback = legacy.
  const impCfg = (opts && opts.importancia) || {};
  let importancia = importanciaLegacy;
  let impSucOut = null;   // contribución por sucursal → el cliente suma solo las visibles y renormaliza
  if (impCfg.modo === 'real') {
    const valor = impCfg.usarBB === false ? 1 : (BB > 0 ? BB : 1);
    const impSuc = {};
    let acc = 0;
    const addSuc = (key, mn, S, stk0, env) => {
      if (!(mn > 0) || !isNum(env)) { impSuc[key] = 0; return; }      // solo sucursales que realmente recibirían
      const urg = Math.max(0, Math.min((mn - (stk0 || 0)) / mn, 1));  // 0..1: qué tan por debajo del min
      const c = (S || 0) * urg;                                       // ponderado por demanda (S) de la sucursal
      impSuc[key] = valor * c; acc += c;
    };
    addSuc('urq', minUrq, sUrq, st.urq, eUrq);
    addSuc('nacion', minNacion, sNac, st.nacion, eNac);
    addSuc('chaca', minChaca, sCha, st.chaca, eCha);
    addSuc('pergamino', minPergamino, sPer, st.pergamino, ePer);
    addSuc('sanPedro', minSanPedro, sSan, st.sanpedro, eSan);
    addSuc('sucursal9', minSucu9, sSu9, st.sucu9, eSu9);
    if (impCfg.incluirRivadavia !== false) addSuc('riv', minRiv, sRiv, st.riv, eRiv);
    importancia = valor * acc;
    impSucOut = impSuc;
  }

  const consumo = a.consumo || 0;
  const meses = consumo > 0 ? roundup(D / consumo, 2) : 0;

  return {
    plu, envasa: envasaSi ? 'Si' : 'No', central: D, base8020: BB,
    mins: { riv: minRiv, urq: minUrq, nacion: minNacion, chaca: minChaca, pergamino: minPergamino,
            sanpedro: minSanPedro, sucu8: minSucu8, sucu9: minSucu9, sucu11: minSucu11 },
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

// racionarPorPrioridad: Tarea 2 — placeholder para evitar segundo cambio en module.exports
const racionarPorPrioridad = undefined;

module.exports = { calcularAlmacen, calcularFilaAlmacen, SUCURSALES_SALIDA, round, roundup, pisoMinimo, racionarPorPrioridad };
