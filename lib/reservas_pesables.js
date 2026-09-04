'use strict';

/**
 * Reservas de pesables mayoristas: lo que distingue a un pesable de una venta directa.
 * Modulo puro (sin SQL ni fs), igual que reservas_mercaderia.js, asi se testea con node:test.
 *
 * Un bulto pesable no se aparta a si mismo ni a su componente directo: se aparta el GRANEL,
 * medido en kg. El componente directo ("Almendras Pedido") es un intermedio sin stock propio
 * que existe para que el mayorista pueda cambiar de presentacion al facturar sin romper nada.
 */

// Los kg se multiplican y se restan en punto flotante y dejan colas (3 x 0.1 = 0.30000000000000004).
// 4 decimales es la precision que ya usa el resto del circuito de reservas (redondear4 en server.js).
function redondear4(n) {
  return Math.round((Number(n) || 0) * 1e4) / 1e4;
}

function texto(v) {
  return String(v == null ? '' : v).trim();
}

function positivo(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Kilos de granel que hay que apartar por una linea de pedido.
 * @param {number} cantPorUnidad kg de granel por unidad del bulto (lo da sqlBOMGranel)
 * @param {number} unidades unidades pedidas del bulto
 * @returns {number} kg redondeados a 4 decimales; 0 si algun dato no sirve
 */
function kgReserva(cantPorUnidad, unidades) {
  const kgUnidad = positivo(cantPorUnidad);
  const cant = positivo(unidades);
  if (!kgUnidad || !cant) return 0;
  return redondear4(kgUnidad * cant);
}

/**
 * @param {object} l linea pesable cruda del body
 * @returns {string|null} mensaje de error, o null si esta bien
 */
function validarLineaPesable(l) {
  if (!l || typeof l !== 'object') return 'La linea pesable no es un objeto';
  if (!texto(l.pluPedido)) return 'La linea pesable no tiene el plu del pedido';
  if (!texto(l.pluCarga))  return 'La linea pesable no tiene el producto de carga';
  if (!texto(l.pluGranel)) return 'La linea pesable no tiene el granel a apartar';
  if (!positivo(l.kgPorUnidad)) return 'La linea pesable no tiene kg por unidad';
  if (!positivo(l.unidades)) return 'La linea pesable no tiene unidades pedidas';
  return null;
}

/**
 * Que producto y que cantidad se mueven en SiGA por una linea del carrito.
 * Venta directa: el componente de un nivel, en unidades (comportamiento historico).
 * Pesable: el granel, en kg — el intermedio "X Pedido" no tiene stock propio.
 *
 * OJO con las unidades del pesable: `cantidad` ya viene multiplicada por CantidadPorBulto
 * (lo hace agregarAReserva en el front), mientras que `kgPorUnidad` son los kg de granel por
 * unidad de BULTO (sqlBOMGranel ya multiplico los dos niveles). Multiplicar kgPorUnidad por
 * `cantidad` aplicaria el factor dos veces, asi que se usa `unidades`, los bultos pedidos.
 * @param {object} l linea del carrito
 * @returns {{plu:string, nombre:string, cantidad:number}|null} null si no hay nada apartable
 */
function lineaAApartar(l) {
  if (!l) return null;
  if (!l.esPesable) {
    const cantidad = positivo(l.cantidad);
    if (!texto(l.plu) || !cantidad) return null;
    return { plu: texto(l.plu), nombre: texto(l.nombre), cantidad };
  }
  const kg = kgReserva(l.kgPorUnidad, l.unidades);
  if (!texto(l.pluGranel) || !kg) return null;
  return { plu: texto(l.pluGranel), nombre: texto(l.nombreGranel), cantidad: kg };
}

/**
 * Kg que cada reserva mayorista viva todavia tiene apartados, por (reserva, PLU).
 *
 * Lo apartado NO se muta en reservas_mercaderia.json: lo que la sala consumio del deposito de
 * reserva queda anotado en el asiento de la produccion que lo consumio
 * (plan.produccionRegistrada.asientos[].consumoMayorista) y el restante se deriva al leer. Asi
 * el sello de la produccion y el consumo son UNA sola escritura: un reintento tras una caida
 * recalcula lo mismo, porque ninguno de los dos datos se movio sin el otro.
 *
 * El consumo se anota CONTRA una reserva (idReserva, que es un Date.now() unico) y no solo por
 * PLU: sin eso, el consumo de una reserva vieja seguiria descontando una reserva nueva del
 * mismo granel, y lo consumido en una sucursal descontaria lo apartado en otra.
 *
 * @param {Array<object>} reservas contenido de reservas_mercaderia.json (ya filtrado por
 *   sucursal y deposito por quien llama: los IDs de deposito son por sucursal)
 * @param {Array<object>} asientos asientos de produccion; los viejos no traen consumoMayorista
 *   y se leen como cero consumido
 * @returns {Array<{idReserva:*, plu:string, restante:number}>}
 */
function anotadoPorReserva(asientos, campo, valor) {
  const mapa = new Map();
  for (const a of (asientos || [])) {
    for (const c of ((a && a[campo]) || [])) {
      const clave = `${texto(c && c.idReserva)}|${texto(c && c.plu)}`;
      mapa.set(clave, redondear4((mapa.get(clave) || 0) + positivo(c && c[valor])));
    }
  }
  return mapa;
}

/**
 * Suma por PLU lo que quede en un array de restantes (el de granel o el de "X Pedido").
 * @param {Array<{plu:string, restante:number}>} filas
 * @returns {Map<string, number>} plu -> restante; los ceros no aparecen
 */
function agruparRestante(filas) {
  const mapa = new Map();
  for (const f of (filas || [])) {
    const plu = texto(f && f.plu);
    const restante = positivo(f && f.restante);
    if (!plu || !restante) continue;
    mapa.set(plu, redondear4((mapa.get(plu) || 0) + restante));
  }
  return mapa;
}

/**
 * Unidades de "X Pedido" que una reserva mayorista viva todavia espera del deposito de
 * reserva. Simetrico a restanteMayoristaPorReserva, con el mismo motivo: lo que ya entro
 * queda anotado en el asiento de produccion (terminadoMayorista) y lo que falta se deriva al
 * leer. Sin esto, con la produccion cargada en lotes, el lote 2 vuelve a ver las unidades
 * enteras y mete al deposito de reserva mas de lo apartado.
 * Una reserva de venta directa no tiene pluCarga y no aporta.
 * @param {Array<object>} reservas contenido de reservas_mercaderia.json (ya filtrado por
 *   sucursal y deposito por quien llama)
 * @param {Array<object>} asientos asientos de produccion; los viejos no traen el campo y se
 *   leen como cero entregado
 * @returns {Array<{idReserva:*, plu:string, restante:number}>}
 */
function restantePedidoPorReserva(reservas, asientos) {
  const entregado = anotadoPorReserva(asientos, 'terminadoMayorista', 'unidades');
  const filas = [];
  for (const r of (reservas || [])) {
    if (!r || r.estado !== 'activa') continue;
    const plu = texto(r.pluCarga);
    const unidades = positivo(r.unidadesPedidas);
    if (!plu || !unidades) continue;
    const ya = entregado.get(`${texto(r.id)}|${plu}`) || 0;
    filas.push({ idReserva: r.id, plu, restante: redondear4(Math.max(0, unidades - ya)) });
  }
  return filas;
}

function restanteMayoristaPorReserva(reservas, asientos) {
  const consumido = anotadoPorReserva(asientos, 'consumoMayorista', 'kg');
  const filas = [];
  for (const r of (reservas || [])) {
    if (!r || r.estado !== 'activa') continue;
    // Agregado por PLU dentro de la reserva: hoy cada reserva tiene una sola linea, pero si
    // tuviera dos del mismo granel el consumo anotado es de las dos juntas.
    const porPlu = new Map();
    for (const l of (r.lineas || [])) {
      const plu = texto(l && l.plu);
      const cant = positivo(l && l.cantidad);
      if (!plu || !cant) continue;
      porPlu.set(plu, redondear4((porPlu.get(plu) || 0) + cant));
    }
    for (const [plu, cant] of porPlu) {
      const gastado = consumido.get(`${texto(r.id)}|${plu}`) || 0;
      filas.push({ idReserva: r.id, plu, restante: redondear4(Math.max(0, cant - gastado)) });
    }
  }
  return filas;
}

/**
 * Kg de granel TODAVIA apartados por reservas mayoristas vivas, agregados por PLU.
 * Lo consume la conciliacion de produccion para saber que parte del consumo de la sala sale
 * del deposito de reserva y no del principal. Un apartado ya consumido no aparece: si siguiera
 * apareciendo, el lote siguiente lo descontaria de nuevo (10 kg apartados, dos lotes de 6, -12).
 * @param {Array<object>} reservas contenido de reservas_mercaderia.json
 * @param {Array<object>} asientos asientos de produccion con el consumo ya anotado
 * @returns {Map<string, number>} pluGranel -> kg
 */
function granelReservadoNeto(reservas, asientos) {
  return agruparRestante(restanteMayoristaPorReserva(reservas, asientos));
}

/**
 * Lo apartado en BRUTO, sin descontar lo que la produccion ya consumio. Es el neto sin
 * asientos: sirve para avisar de lo apartado en otro deposito, donde la sala no consume.
 * @param {Array<object>} reservas contenido de reservas_mercaderia.json
 * @returns {Map<string, number>} pluGranel -> kg
 */
function granelReservadoPorPlu(reservas) {
  return granelReservadoNeto(reservas, []);
}

/**
 * Lineas que hay que devolver al anular una reserva mayorista: las mismas de la reserva, pero
 * recortadas a lo que TODAVIA esta en el deposito de reserva.
 *
 * Las lineas de la reserva siguen diciendo lo apartado original (no se mutan nunca), asi que
 * devolverlas enteras despues de que la produccion consumio parte seria devolver kg que ya no
 * estan: el deposito de reserva quedaria en negativo y el principal con stock inventado.
 * Una linea sin nada que devolver no sale: un traslado de cantidad cero no es un movimiento.
 *
 * @param {object} reserva reserva de reservas_mercaderia.json
 * @param {Array<object>} asientos asientos de produccion (todas las fechas)
 * @returns {Array<object>} copias de las lineas con la cantidad recortada; [] si no queda nada
 */
function lineasADevolverMayorista(reserva, asientos) {
  const restante = new Map(restanteMayoristaPorReserva([reserva], asientos).map(f => [f.plu, f.restante]));
  const out = [];
  for (const l of ((reserva && reserva.lineas) || [])) {
    const plu = texto(l && l.plu);
    const queda = restante.get(plu) || 0;
    // Con dos lineas del mismo PLU, lo consumido es de las dos juntas: se va gastando el
    // restante linea por linea en vez de repetirlo en cada una.
    const cant = redondear4(Math.min(positivo(l && l.cantidad), queda));
    if (!(cant > 0)) continue;
    restante.set(plu, redondear4(queda - cant));
    out.push({ ...l, cantidad: cant });
  }
  return out;
}

/**
 * Que movimiento hace falta para dejar el deposito de reserva en cero para un producto.
 *
 * El deposito de reserva es de paso: lo que queda ahi despues de que el mayorista se llevo lo
 * suyo es una diferencia que hay que resolver. El saldo es `stock fisico - comprometido`, asi
 * que su signo dice el sentido del traslado:
 *  · positivo → hay de mas en la reserva y vuelve al principal;
 *  · negativo → falta contra lo que las reservas vivas tienen apartado, y se repone.
 *
 * Un PLU es granel O producto de carga, nunca los dos, asi que en la practica solo uno de los
 * dos saldos llega distinto de cero. El orden esta definido igual (primero el granel) para que
 * la funcion sea total y no dependa de esa suposicion.
 *
 * Se resuelve UN ajuste por vez: si quedaran los dos saldos vivos, primero el granel y en la
 * vuelta siguiente el terminado.
 *
 * La des-produccion (volver "X Pedido" a granel) NO sale por aca: cambia de producto y se
 * registra como una produccion inversa, con su propio comprobante.
 *
 * @param {{saldoGranel:number, saldoPedido:number, pluGranel?:string, pluCarga?:string}} s
 * @returns {{tipo:string, plu:string, cantidad:number, sentido:string}|null} null si esta en cero
 */
function ajustePropuesto(s) {
  // redondear4 antes de comparar: el saldo sale de una resta de floats y una cola de
  // 1e-17 dispararia un traslado fantasma de una cantidad que SiGA ni puede representar.
  const granel = redondear4(s && s.saldoGranel);
  const pedido = redondear4(s && s.saldoPedido);
  if (granel > 0) {
    return { tipo: 'devolver-granel', plu: texto(s.pluGranel), cantidad: granel,
             sentido: 'reserva-a-principal' };
  }
  // Hay MENOS granel del que las reservas vivas tienen apartado: alguien lo saco del deposito
  // de reserva por fuera del circuito. Sin esta rama el faltante devolvia `null` y quedaba
  // invisible justo cuando hay que actuar.
  if (granel < 0) {
    return { tipo: 'reponer-granel', plu: texto(s.pluGranel), cantidad: redondear4(-granel),
             sentido: 'principal-a-reserva' };
  }
  if (pedido > 0) {
    return { tipo: 'devolver-pedido', plu: texto(s.pluCarga), cantidad: pedido,
             sentido: 'reserva-a-principal' };
  }
  if (pedido < 0) {
    return { tipo: 'reponer-pedido', plu: texto(s.pluCarga), cantidad: redondear4(-pedido),
             sentido: 'principal-a-reserva' };
  }
  return null;
}

// Un PLU viaja al WHERE del stock, que sanea con replace(/\D/g,''): uno con basura consultaria
// el stock de OTRO producto y lo devolveria como si fuera este. Se descartan antes.
function esPluNumerico(plu) {
  return /^\d+$/.test(texto(plu));
}

/**
 * Filas de saldo del deposito de reserva: por cada PLU con reserva mayorista viva, cuanto hay
 * fisicamente, cuanto esta comprometido y que ajuste lo dejaria en cero.
 *
 * Las dos patas se comprometen distinto, y la asimetria es a proposito:
 *
 *  · GRANEL: NETO de lo que la produccion consumio. El granel consumido ya no esta en el
 *    deposito — se convirtio en producto — asi que nadie lo debe. Con el bruto, una reserva ya
 *    producida seguiria diciendo "15 kg comprometidos" y el ajuste sacaria 15 kg del principal
 *    para reponer algo que no falta.
 *
 *  · "X PEDIDO": BRUTO, las unidadesPedidas enteras, mientras la reserva este viva. Son las
 *    unidades que el cliente tiene derecho a retirar; que la sala todavia no las haya fabricado
 *    no cambia lo que se le debe. Un saldo negativo aca no siempre es un error: puede ser que el
 *    cliente ya se llevo lo suyo y la reserva quedo abierta. En los dos casos lo que hay que
 *    hacer es mirar esa reserva, que es justamente para lo que sirve esta pantalla.
 *
 * El stock fisico se pasa como dato (lo consulta el endpoint) para que esta funcion sea pura:
 * es la regla, no el IO, lo que hay que poder testear.
 *
 * @param {Array<object>} reservas reservas de ESTA sucursal y ESTE deposito (el filtro es de
 *   quien llama: los IDs de deposito son por sucursal)
 * @param {Array<object>} asientos asientos de produccion de TODAS las fechas
 * @param {Map<string,number>|Object<string,number>} stockPorPlu stock en el deposito de reserva;
 *   un PLU ausente se lee como cero, que es lo que significa
 * @returns {Array<{plu:string, esGranel:boolean, saldo:number, comprometido:number,
 *   diferencia:number, ajuste:object|null, reservas:Array<object>}>}
 */
function filasSaldoMayorista(reservas, asientos, stockPorPlu) {
  const vivas  = (reservas || []).filter(r => r && r.estado === 'activa');
  const granel = granelReservadoNeto(vivas, asientos);
  const pedido = pedidoReservadoPorPlu(vivas);
  const stock  = mapaCantidades(stockPorPlu);
  // Un PLU entra si alguien lo tiene comprometido O si quedo stock suyo en el deposito: sin lo
  // segundo, una reserva ya entregada del todo (comprometido 0) desaparece de la pantalla y con
  // ella el producto que todavia esta fisicamente ahi esperando que el mayorista lo retire.
  const plus = [...new Set([...granel.keys(), ...pedido.keys(),
                            ...[...stock.keys()].filter(p => esRelevante(p, vivas))])]
    .filter(esPluNumerico)
    .sort();
  return plus.map(plu => {
    const esGranel = granel.has(plu) || vivas.some(r => (r.lineas || []).some(l => texto(l && l.plu) === plu));
    const comprometido = redondear4(esGranel ? (granel.get(plu) || 0) : (pedido.get(plu) || 0));
    const saldo = redondear4(stock.get(plu) || 0);
    // Positiva sobra en la reserva; negativa falta contra lo que las reservas vivas apartaron.
    const diferencia = redondear4(saldo - comprometido);
    return {
      plu, nombre: nombreDePlu(plu, esGranel, vivas), esGranel, saldo, comprometido, diferencia,
      ajuste: ajustePropuesto({
        saldoGranel: esGranel ? diferencia : 0,
        saldoPedido: esGranel ? 0 : diferencia,
        pluGranel: esGranel ? plu : null,
        pluCarga:  esGranel ? null : plu,
      }),
      reservas: vivas
        .filter(r => (r.lineas || []).some(l => texto(l && l.plu) === plu) || texto(r.pluCarga) === plu)
        .map(r => ({ id: r.id, cliente: texto(r.nombreCliente), pluPedido: texto(r.pluPedido) })),
    };
  // Nada comprometido y nada fisico no es una fila: es el estado normal de un PLU cuyo circuito
  // ya cerro (el granel se consumio entero y su producto salio). Mostrarlo llena la pantalla de
  // ceros y esconde las filas que si necesitan un ajuste.
  }).filter(f => f.saldo !== 0 || f.comprometido !== 0);
}

// Nombre del producto para la pantalla: un PLU pelado no le dice nada al operador y el dato ya
// esta en la reserva. Las viejas, guardadas antes de que se guardaran los nombres, dan '' — que
// se renderiza como vacio, no como "undefined".
function nombreDePlu(plu, esGranel, vivas) {
  for (const r of vivas) {
    if (esGranel) {
      const l = (r.lineas || []).find(x => texto(x && x.plu) === plu && texto(x && x.nombre));
      if (l) return texto(l.nombre);
    } else if (texto(r.pluCarga) === plu && texto(r.nombreCarga)) {
      return texto(r.nombreCarga);
    }
  }
  return '';
}

// Un PLU del stock solo interesa si alguna reserva viva lo nombra: el deposito de reserva puede
// tener cualquier otra cosa y no es asunto de esta pantalla.
function esRelevante(plu, vivas) {
  const p = texto(plu);
  return vivas.some(r => texto(r.pluCarga) === p || (r.lineas || []).some(l => texto(l && l.plu) === p));
}

// Como mapaPositivo pero conservando los negativos: un saldo fisico puede estar en negativo y
// ese es justamente el caso que hay que mostrar.
function mapaCantidades(v) {
  const mapa = new Map();
  const pares = v instanceof Map ? v.entries() : Object.entries(v || {});
  for (const [plu, cant] of pares) {
    const n = Number(cant);
    if (texto(plu) && Number.isFinite(n)) mapa.set(texto(plu), n);
  }
  return mapa;
}

/**
 * Unidades de "X Pedido" que la produccion ya metio al deposito de reserva por esta reserva y
 * que hay que sacar de ahi al anularla.
 *
 * Son la OTRA mitad de lo que devuelve lineasADevolverMayorista. Esa devuelve el granel que
 * quedo sin tocar; esta, el granel que la sala ya convirtio en producto. Sin las dos, una
 * reserva producida entera se anulaba dejando el terminado varado en el deposito de reserva sin
 * ninguna reserva viva que lo reclamara, y el aviso decia "la produccion ya consumio N" — que
 * es enganoso: el granel no salio del edificio, cambio de forma y sigue ahi.
 *
 * Van a RECEPCION, no al deposito de origen de la reserva: son terminados, no materia prima, y
 * el origen es de donde salio el granel.
 *
 * @param {object} reserva reserva de reservas_mercaderia.json
 * @param {Array<object>} asientos asientos de produccion (todas las fechas)
 * @returns {Array<{plu:string, nombre:string, cantidad:number}>} vacio si no se produjo nada
 */
function lineasTerminadoADevolverMayorista(reserva, asientos) {
  const pedidas = positivo(reserva && reserva.unidadesPedidas);
  return restantePedidoPorReserva([reserva], asientos).flatMap(f => {
    const entregado = redondear4(pedidas - positivo(f.restante));
    if (!(entregado > 0)) return [];
    return [{ plu: f.plu, nombre: texto(reserva && reserva.nombreCarga), cantidad: entregado }];
  });
}

/**
 * Reparte los kg que la sala consumio del deposito de reserva entre las reservas que todavia
 * los tienen apartados. Es lo que se anota en el asiento de produccion.
 *
 * El granel del deposito es fungible: que reserva "puso" los kg consumidos es una convencion.
 * Se imputa a la mas vieja primero (el id lleva el Date.now() de la creacion, asi que el menor
 * es el mas viejo) porque es la que antes se va a retirar. Nunca se le saca a una reserva mas
 * de lo que le queda: lo que exceda salio de otro lado, no del apartado.
 *
 * @param {Array<{idReserva:*, plu:string, restante:number}>} restantes de restanteMayoristaPorReserva
 * @param {Object<string, number>} consumoPorPlu pluGranel -> kg consumidos (positivos)
 * @returns {Array<{idReserva:*, plu:string, kg:number}>}
 */
function imputarConsumoMayorista(restantes, consumoPorPlu) {
  const pendiente = new Map();
  for (const [plu, kg] of Object.entries(consumoPorPlu || {})) {
    const cant = positivo(kg);
    if (texto(plu) && cant) pendiente.set(texto(plu), cant);
  }
  if (!pendiente.size) return [];
  const consumo = [];
  const orden = [...(restantes || [])].sort((a, b) => (Number(a && a.idReserva) || 0) - (Number(b && b.idReserva) || 0));
  for (const f of orden) {
    const plu = texto(f && f.plu);
    const tomar = redondear4(Math.min(positivo(f && f.restante), pendiente.get(plu) || 0));
    if (!(tomar > 0)) continue;
    pendiente.set(plu, redondear4(pendiente.get(plu) - tomar));
    consumo.push({ idReserva: f.idReserva, plu, kg: tomar });
  }
  return consumo;
}

/**
 * Normaliza un Map o un objeto plano de plu -> cantidad a un Map con solo valores positivos.
 * Se acepta cualquiera de los dos porque la conciliacion viaja serializada a JSON (objeto) pero
 * dentro del proceso se pasan Maps.
 * @param {Map<string,number>|Object<string,number>} v
 * @returns {Map<string, number>}
 */
function mapaPositivo(v) {
  const mapa = new Map();
  const pares = v instanceof Map ? v.entries() : Object.entries(v || {});
  for (const [plu, cant] of pares) {
    const n = positivo(cant);
    if (texto(plu) && n) mapa.set(texto(plu), n);
  }
  return mapa;
}

/**
 * Base de imputacion de cada reserva mayorista viva: el vinculo entre las DOS patas que la
 * produccion mueve juntas — las unidades de "X Pedido" que entran al deposito de reserva y los
 * kg de granel que salen de ahi para fabricarlas.
 *
 * Existe como UNA sola estructura a proposito. Mientras las dos patas se calcularon por
 * separado, un dia normal (el plan consume exactamente lo que reservo) entregaba las unidades
 * SIN cobrarle el granel a la reserva: el deposito de reserva terminaba con la materia prima Y
 * el producto terminado del mismo pedido, y ningun ledger reconciliaba al otro.
 *
 * `kgPorUnidad` sale de la reserva misma (kg apartados / unidades pedidas), no de la formula:
 * es lo que el operador aparto para ese pedido y es contra eso que hay que rendir cuentas.
 *
 * @param {Array<object>} reservas reservas_mercaderia.json ya filtrado por sucursal y deposito
 * @param {Array<object>} asientos asientos de produccion de TODAS las fechas
 * @returns {Array<{idReserva:*, plu:string, restanteUnidades:number,
 *   granel:Array<{plu:string, kgPorUnidad:number, restante:number}>}>}
 */
function basesEntregaMayorista(reservas, asientos) {
  const restGranel = new Map(restanteMayoristaPorReserva(reservas, asientos)
    .map(f => [`${texto(f.idReserva)}|${f.plu}`, f.restante]));
  const porId = new Map((reservas || []).map(r => [texto(r && r.id), r]));
  return restantePedidoPorReserva(reservas, asientos).map(f => {
    const r = porId.get(texto(f.idReserva)) || {};
    const unidadesPedidas = positivo(r.unidadesPedidas);
    // Las lineas se agrupan por PLU antes de mirar el restante: el restante ya viene agregado
    // por PLU dentro de la reserva, asi que dos lineas del mismo granel leyendolo cada una lo
    // cobrarian dos veces.
    const porPlu = new Map();
    for (const l of (r.lineas || [])) {
      const plu = texto(l && l.plu);
      const cant = positivo(l && l.cantidad);
      if (!plu || !cant || !unidadesPedidas) continue;
      porPlu.set(plu, redondear4((porPlu.get(plu) || 0) + cant));
    }
    const granel = [...porPlu].map(([plu, cant]) => ({
      plu, kgPorUnidad: cant / unidadesPedidas,
      restante: restGranel.get(`${texto(f.idReserva)}|${plu}`) || 0
    }));
    return { idReserva: f.idReserva, plu: f.plu, restanteUnidades: f.restante, granel };
  });
}

/**
 * LA imputacion de la entrega mayorista: decide de una sola vez cuantas unidades de "X Pedido"
 * entran al deposito de reserva por cada reserva y cuantos kg de granel se le cobran por ellas.
 *
 * El orden importa y es el inverso al que tenia el circuito: manda el TERMINADO (lo que la sala
 * efectivamente fabrico) y el granel se deriva de el. Derivarlo al reves — cobrarle al mayorista
 * solo el granel que excede lo que reservo el plan — dejaba el caso normal sin cobrar nada.
 *
 * Se imputa a la reserva mas vieja primero (el id lleva el Date.now() de la creacion): es la que
 * antes se va a retirar. Tres topes, todos duros:
 *  · lo que le falta entrar a esa reserva (restanteUnidades, ya neto de asientos anteriores);
 *  · lo que la sala produjo de ese "X Pedido" y todavia no se imputo a otra reserva;
 *  · el granel: kg que le quedan apartados y kg que la sala declaro haber consumido. Si el
 *    granel no alcanza para las unidades que pedia, se entregan SOLO las que cubre. Entregar
 *    una unidad sin cobrar su granel deja el deposito de reserva con las dos cosas.
 *
 * @param {Array<object>} bases salida de basesEntregaMayorista
 * @param {Map<string,number>|Object} terminadosPorPlu unidades pendientes de alta, por PLU de carga
 * @param {Map<string,number>|Object} usadoPorPlu kg que la sala consumio, por PLU de granel
 * @returns {{terminadoMayorista:Array<{idReserva:*, plu:string, unidades:number}>,
 *   consumoMayorista:Array<{idReserva:*, plu:string, kg:number}>, unidadesPorPlu:Map<string,number>}}
 */
function imputarEntregaMayorista(bases, terminadosPorPlu, usadoPorPlu) {
  const pendienteTerm = mapaPositivo(terminadosPorPlu);
  const usadoDisp     = mapaPositivo(usadoPorPlu);
  const terminadoMayorista = [], consumoMayorista = [];
  const orden = [...(bases || [])].sort((a, b) => (Number(a && a.idReserva) || 0) - (Number(b && b.idReserva) || 0));
  for (const b of orden) {
    const plu = texto(b && b.plu);
    const quiere = redondear4(Math.min(positivo(b && b.restanteUnidades), pendienteTerm.get(plu) || 0));
    if (!(quiere > 0)) continue;
    const granel = ((b && b.granel) || []).filter(g => texto(g && g.plu) && positivo(g && g.kgPorUnidad));
    // Fraccion de `quiere` que el granel banca. Sin lineas de granel el factor queda en 1: una
    // reserva sin nada apartado no tiene granel que cobrar y su entrega no le debe nada a nadie.
    // ponytail: no pasa hoy (toda reserva pesable aparta granel), es solo el neutro del min.
    let factor = 1;
    for (const g of granel) {
      const disp = Math.min(positivo(g.restante), usadoDisp.get(texto(g.plu)) || 0);
      factor = Math.min(factor, disp / (positivo(g.kgPorUnidad) * quiere));
    }
    const unidades = redondear4(quiere * Math.max(0, Math.min(1, factor)));
    if (!(unidades > 0)) continue;
    for (const g of granel) {
      const gplu = texto(g.plu);
      const kg = redondear4(Math.min(positivo(g.kgPorUnidad) * unidades, positivo(g.restante),
                                     usadoDisp.get(gplu) || 0));
      if (!(kg > 0)) continue;
      usadoDisp.set(gplu, redondear4((usadoDisp.get(gplu) || 0) - kg));
      consumoMayorista.push({ idReserva: b.idReserva, plu: gplu, kg });
    }
    pendienteTerm.set(plu, redondear4((pendienteTerm.get(plu) || 0) - unidades));
    terminadoMayorista.push({ idReserva: b.idReserva, plu, unidades });
  }
  return {
    terminadoMayorista, consumoMayorista,
    // Agregado por PLU de carga: es lo que el comprobante de produccion rutea al deposito de
    // reserva en vez del de recepcion. Sale de la MISMA imputacion que el asiento, asi que el
    // stock que se mueve y lo que queda anotado no pueden desfasarse.
    unidadesPorPlu: agruparRestante(terminadoMayorista.map(t => ({ plu: t.plu, restante: t.unidades })))
  };
}

/**
 * Unidades de "X Pedido" comprometidas por reservas mayoristas vivas, agregadas por PLU de
 * carga. Es lo que tiene que entrar al deposito de reserva cuando la sala produce.
 * Las reservas de venta directa no tienen pluCarga y no aportan.
 * @param {Array<object>} reservas contenido de reservas_mercaderia.json
 * @returns {Map<string, number>} pluCarga -> unidades
 */
function pedidoReservadoPorPlu(reservas) {
  return agruparRestante(restantePedidoPorReserva(reservas, []));
}

/**
 * Parte los componentes de la conciliacion en la vista del PLAN y las lineas del apartado
 * MAYORISTA. Hace falta porque componentes[].reservado suma los dos apartados (para que el
 * consumo no se cargue al deposito principal) pero cada uno se registra distinto:
 *  - lo del plan tiene comprobante de conciliacion propio y su sobrante se devuelve;
 *  - lo del mayorista NO figura en porMovimiento y NO es devolvible: tiene que quedarse
 *    en el deposito de reserva hasta que el mayorista se lo lleve.
 *
 * `componentesPlan` es la vista que deben consumir TODOS los pasos de abajo (el comprobante
 * de produccion, las diferencias y el corte antidoble-conteo). Usar el componente crudo en
 * alguno de ellos hace desaparecer el consumo que excede plan+mayorista: con el reservado
 * inflado, el comprobante de produccion no lo manda al deposito de salida y las diferencias
 * tampoco lo ven.
 *
 * @param {Array<{plu:*, nombre:*, reservado:number, usado:number}>} componentes
 * @param {Object<string, number>} reservadoMayorista aporte mayorista por PLU
 * @param {number} depReserva deposito donde esta lo apartado
 * @param {Map<string,number>|Object<string,number>} consumoPorPlu kg que la imputacion de la
 *   entrega (imputarEntregaMayorista) le cobro al mayorista, por PLU de granel. NO se recalcula
 *   aca: el granel que sale del apartado es el de las unidades que se entregaron, y quien sabe
 *   cuantas son es la imputacion. Deducirlo del `usado` — cobrarle al mayorista solo lo que
 *   excede lo que reservo el plan — dejaba el caso normal (el plan consume justo lo que
 *   reservo) entregando el producto sin cobrar el granel.
 * @returns {{componentesPlan:Array<object>, lineasMayorista:Array<object>}}
 */
function partirConsumoMayorista(componentes, reservadoMayorista, depReserva, consumoPorPlu) {
  const cobrado = mapaPositivo(consumoPorPlu);
  const componentesPlan = [], lineasMayorista = [];
  for (const comp of (componentes || [])) {
    const plu = texto(comp && comp.plu);
    const mayorista = positivo((reservadoMayorista || {})[plu]);
    if (!(mayorista > 0)) { componentesPlan.push(comp); continue; }
    const usado = positivo(comp.usado);
    // Lo que reservo el plan es el resto; el max(0) cubre un reservado que no llegue a
    // cubrir el aporte mayorista (no deberia pasar: el reservado se arma sumandolo).
    const delPlan = redondear4(Math.max(0, positivo(comp.reservado) - mayorista));
    // Los topes siguen valiendo aunque el numero venga de afuera: nunca mas kg que los que la
    // reserva tiene apartados ni que los que la sala declaro haber consumido.
    const consumido = redondear4(Math.min(mayorista, cobrado.get(plu) || 0, usado));
    componentesPlan.push({ ...comp, reservado: delPlan, usado: redondear4(usado - consumido) });
    if (consumido > 0) {
      lineasMayorista.push({
        idProducto: texto(comp.plu), nombre: texto(comp.nombre),
        idDeposito: depReserva, cantidad: -consumido, concepto: 'consumo-reserva-mayorista'
      });
    }
  }
  return { componentesPlan, lineasMayorista };
}

module.exports = { kgReserva, validarLineaPesable, lineaAApartar, granelReservadoPorPlu, pedidoReservadoPorPlu, partirConsumoMayorista,
  restanteMayoristaPorReserva, granelReservadoNeto, imputarConsumoMayorista, lineasADevolverMayorista,
  restantePedidoPorReserva, agruparRestante, basesEntregaMayorista, imputarEntregaMayorista,
  lineasTerminadoADevolverMayorista, ajustePropuesto, filasSaldoMayorista };
