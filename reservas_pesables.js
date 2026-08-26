'use strict';

/**
 * Reservas de pesables mayoristas: lo que distingue a un pesable de una venta directa.
 * Modulo puro (sin SQL ni fs), igual que reservas_mercaderia.js, asi se testea con node:test.
 *
 * Un bulto pesable no se aparta a si mismo ni a su componente directo: se aparta el GRANEL,
 * medido en kg. El componente directo ("Almendras Pedido") es un intermedio sin stock propio
 * que existe para que el mayorista pueda cambiar de presentacion al facturar sin romper nada.
 */

// El saldo de la reserva lo sigue definiendo su modulo: totales se recalcula con el mismo
// helper que usa nuevaReserva, no con una copia.
const { totalesReserva } = require('./reservas_mercaderia');

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
 * Kg de granel apartados por reservas mayoristas vivas, agregados por PLU.
 * Lo consume la conciliacion de produccion para saber que parte del consumo de la sala sale
 * del deposito de reserva y no del principal.
 * @param {Array<object>} reservas contenido de reservas_mercaderia.json
 * @returns {Map<string, number>} pluGranel -> kg
 */
function granelReservadoPorPlu(reservas) {
  const mapa = new Map();
  for (const r of (reservas || [])) {
    if (!r || r.estado !== 'activa') continue;
    for (const l of (r.lineas || [])) {
      const plu = texto(l && l.plu);
      const cant = positivo(l && l.cantidad);
      if (!plu || !cant) continue;
      mapa.set(plu, redondear4((mapa.get(plu) || 0) + cant));
    }
  }
  return mapa;
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


/**
 * Baja de las reservas mayoristas vivas el granel que la sala ya consumio del deposito de
 * reserva (las lineas `consumo-reserva-mayorista` que arma partirConsumoMayorista).
 *
 * Sin esto la reserva sigue declarando los kg originales: el lote siguiente del mismo dia
 * vuelve a ver el apartado entero, la conciliacion lo descuenta otra vez y el deposito de
 * reserva se dibuja mas veces de lo que se aparto (10 kg reservados, dos lotes de 6, -12 kg).
 *
 * Idempotencia: `mov.numeroMovimiento` es la clave. Cada reserva guarda en `consumos[]` el
 * comprobante que le saco cada tramo, asi que un reintento con el mismo numero es un no-op
 * (mismo criterio que plan.ajustesDiferencias y plan.reservas[].ajuste en server.js: la marca
 * es el comprobante confirmado, y sirve de auditoria y de llave a la vez). Sin numero no hay
 * llave, y descontar a ciegas es justo el bug que se esta arreglando: no se toca nada.
 *
 * @param {Array<object>} reservas contenido de reservas_mercaderia.json
 * @param {Object<string, number>} consumoPorPlu pluGranel -> kg consumidos (positivos)
 * @param {{numeroMovimiento:*, fecha:string, idSucursal:*, depDestino:*}} mov comprobante ya confirmado
 * @returns {{reservas:Array<object>, cambiadas:number, aviso:string|null}} array NUEVO si hubo
 *   cambios, el mismo si no; `aviso` avisa lo que no se pudo imputar a ninguna reserva.
 */
function consumirGranelDeReservas(reservas, consumoPorPlu, mov) {
  const arr = reservas || [];
  const sinCambios = ca => ({ reservas: arr, cambiadas: 0, aviso: ca || null });

  const pendiente = new Map();
  for (const [plu, kg] of Object.entries(consumoPorPlu || {})) {
    const cant = positivo(kg);
    if (texto(plu) && cant) pendiente.set(texto(plu), cant);
  }
  if (!pendiente.size) return sinCambios();

  const numero = (mov || {}).numeroMovimiento;
  if (numero == null) {
    return sinCambios('No se pudo descontar el granel de las reservas mayoristas: el comprobante '
                    + 'no devolvió número de movimiento. Revisá a mano el saldo de las reservas.');
  }
  // Ya aplicado: el mismo comprobante no puede descontar dos veces (reintento tras falla parcial).
  if (arr.some(r => (r && r.consumos || []).some(c => c && c.numeroMovimiento === numero))) return sinCambios();

  // Orden de imputacion: la reserva mas vieja primero (fecha, y el id desempata cuando dos
  // comparten fecha). Es la que antes se va a retirar, asi que su granel es el primero que la
  // produccion tiene que respaldar; y ademas es un orden estable, independiente de como quedo
  // ordenado el archivo (el listado lo devuelve al reves, por id descendente).
  const clave = r => `${texto(r.fecha)}|${String(r.id ?? '').padStart(12, '0')}`;
  const candidatas = arr
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r && r.estado === 'activa'
                    && Number(r.idSucursal) === Number(mov.idSucursal)
                    && Number(r.depDestino) === Number(mov.depDestino))
    .sort((a, b) => clave(a.r) < clave(b.r) ? -1 : clave(a.r) > clave(b.r) ? 1 : 0);

  const cambios = new Map();
  for (const { r, i } of candidatas) {
    const aplicado = [];
    const lineas = (r.lineas || []).map(l => {
      const plu = texto(l && l.plu);
      const disponible = positivo(l && l.cantidad);
      const tomar = Math.min(disponible, pendiente.get(plu) || 0);
      if (!(tomar > 0)) return l;
      pendiente.set(plu, redondear4(pendiente.get(plu) - tomar));
      aplicado.push({ plu, cantidad: redondear4(tomar) });
      return { ...l, cantidad: redondear4(disponible - tomar) };
    });
    if (!aplicado.length) continue;
    cambios.set(i, {
      ...r, lineas, totales: totalesReserva(lineas),
      consumos: [...(r.consumos || []),
                 { numeroMovimiento: numero, fecha: mov.fecha, lineas: aplicado }],
    });
  }

  // Lo que ninguna reserva pudo absorber salio igual del deposito de reserva en SiGA: no se
  // puede arreglar desde aca, pero callarlo deja un descuadre invisible.
  const sobra = [...pendiente.entries()].filter(([, kg]) => kg > 0);
  const aviso = sobra.length
    ? `Salieron del depósito de reserva ${sobra.map(([plu, kg]) => `${kg} de ${plu}`).join(', ')} que ninguna `
    + 'reserva mayorista viva tenía apartados: revisá el saldo del depósito de reserva.'
    : null;
  if (!cambios.size) return sinCambios(aviso);
  return {
    reservas: arr.map((r, i) => cambios.get(i) || r),
    cambiadas: cambios.size,
    aviso,
  };
}

module.exports = { kgReserva, validarLineaPesable, lineaAApartar, granelReservadoPorPlu, pedidoReservadoPorPlu, partirConsumoMayorista,
  consumirGranelDeReservas };
