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
function restanteMayoristaPorReserva(reservas, asientos) {
  const consumido = new Map();
  for (const a of (asientos || [])) {
    for (const c of ((a && a.consumoMayorista) || [])) {
      const clave = `${texto(c && c.idReserva)}|${texto(c && c.plu)}`;
      consumido.set(clave, redondear4((consumido.get(clave) || 0) + positivo(c && c.kg)));
    }
  }
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
  const mapa = new Map();
  for (const f of restanteMayoristaPorReserva(reservas, asientos)) {
    if (!f.restante) continue;
    mapa.set(f.plu, redondear4((mapa.get(f.plu) || 0) + f.restante));
  }
  return mapa;
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
 * Unidades de "X Pedido" comprometidas por reservas mayoristas vivas, agregadas por PLU de
 * carga. Es lo que tiene que entrar al deposito de reserva cuando la sala produce.
 * Las reservas de venta directa no tienen pluCarga y no aportan.
 * @param {Array<object>} reservas contenido de reservas_mercaderia.json
 * @returns {Map<string, number>} pluCarga -> unidades
 */
function pedidoReservadoPorPlu(reservas) {
  const mapa = new Map();
  for (const r of (reservas || [])) {
    if (!r || r.estado !== 'activa') continue;
    const plu = texto(r.pluCarga);
    const unidades = positivo(r.unidadesPedidas);
    if (!plu || !unidades) continue;
    mapa.set(plu, redondear4((mapa.get(plu) || 0) + unidades));
  }
  return mapa;
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
 * @returns {{componentesPlan:Array<object>, lineasMayorista:Array<object>}}
 */
function partirConsumoMayorista(componentes, reservadoMayorista, depReserva) {
  const componentesPlan = [], lineasMayorista = [];
  for (const comp of (componentes || [])) {
    const mayorista = positivo((reservadoMayorista || {})[texto(comp && comp.plu)]);
    if (!(mayorista > 0)) { componentesPlan.push(comp); continue; }
    const usado = positivo(comp.usado);
    // Lo que reservo el plan es el resto; el max(0) cubre un reservado que no llegue a
    // cubrir el aporte mayorista (no deberia pasar: el reservado se arma sumandolo).
    const delPlan = redondear4(Math.max(0, positivo(comp.reservado) - mayorista));
    // La sala consume primero contra la reserva del plan; recien lo que pasa de ahi sale del
    // apartado mayorista, y solo hasta donde el apartado alcanza.
    const consumido = redondear4(Math.min(mayorista, Math.max(0, usado - delPlan)));
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
  restanteMayoristaPorReserva, granelReservadoNeto, imputarConsumoMayorista, lineasADevolverMayorista };
