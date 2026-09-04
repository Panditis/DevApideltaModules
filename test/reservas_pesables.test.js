const test = require('node:test');
const assert = require('node:assert');
const { kgReserva, validarLineaPesable, lineaAApartar, granelReservadoPorPlu, pedidoReservadoPorPlu,
        granelReservadoNeto, restanteMayoristaPorReserva, imputarConsumoMayorista,
        lineasADevolverMayorista, restantePedidoPorReserva, agruparRestante } = require('../lib/reservas_pesables');

// ── Kilos a apartar ───────────────────────────────────────────────────────────
// El bulto "Almendras 5Kg" lleva 5 kg de granel por unidad: pedir 3 aparta 15 kg.

test('multiplica kg por unidad por las unidades pedidas', () => {
  // Arrange / Act
  const kg = kgReserva(5, 3);

  // Assert
  assert.strictEqual(kg, 15);
});

test('redondea a 4 decimales para no arrastrar colas de punto flotante', () => {
  // Arrange / Act
  const kg = kgReserva(0.1, 3);

  // Assert
  assert.strictEqual(kg, 0.3);
});

test('devuelve 0 cuando el kg por unidad no es un numero util', () => {
  // Arrange / Act / Assert
  assert.strictEqual(kgReserva(0, 3), 0);
  assert.strictEqual(kgReserva(null, 3), 0);
  assert.strictEqual(kgReserva(-2, 3), 0);
});

// ── Validacion de la linea pesable ────────────────────────────────────────────
// Una linea pesable necesita los tres PLU y un kg por unidad positivo. Sin eso el
// traslado saldria contra el intermedio "X Pedido", que no tiene stock propio.

function lineaPesable(extra) {
  return {
    pluPedido: '30111', nombrePedido: 'Almendras 5Kg',
    pluCarga: '40222', nombreCarga: 'Almendras Pedido',
    pluGranel: '50333', nombreGranel: 'Almendras Granel',
    kgPorUnidad: 5, unidades: 3,
    ...extra,
  };
}

test('acepta una linea pesable completa', () => {
  // Arrange / Act
  const error = validarLineaPesable(lineaPesable());

  // Assert
  assert.strictEqual(error, null);
});

test('rechaza una linea pesable sin granel', () => {
  // Arrange / Act
  const error = validarLineaPesable(lineaPesable({ pluGranel: '' }));

  // Assert
  assert.match(error, /granel/i);
});

test('rechaza una linea pesable sin producto de carga', () => {
  // Arrange / Act
  const error = validarLineaPesable(lineaPesable({ pluCarga: '' }));

  // Assert
  assert.match(error, /carga/i);
});

test('rechaza una linea pesable con kg por unidad en cero', () => {
  // Arrange / Act
  const error = validarLineaPesable(lineaPesable({ kgPorUnidad: 0 }));

  // Assert
  assert.match(error, /kg por unidad/i);
});

test('rechaza una linea pesable sin unidades pedidas', () => {
  // Arrange / Act
  const error = validarLineaPesable(lineaPesable({ unidades: 0 }));

  // Assert
  assert.match(error, /unidades/i);
});

test('kgReserva devuelve 0 cuando las unidades no sirven', () => {
  // Arrange / Act / Assert
  assert.strictEqual(kgReserva(5, 0), 0);
  assert.strictEqual(kgReserva(5, null), 0);
});

test('rechaza una linea pesable que no es un objeto', () => {
  // Arrange / Act / Assert
  assert.match(validarLineaPesable(null), /objeto/i);
});

// ── Que se aparta por cada linea del carrito ──────────────────────────────────
// Venta directa: el componente de un nivel, en unidades. Pesable: el granel, en kg.
// OJO con las unidades: `cantidad` ya viene expandida por CantidadPorBulto, mientras que
// `kgPorUnidad` son los kg por unidad de BULTO. Por eso el pesable multiplica contra
// `unidades` (bultos pedidos) y no contra `cantidad`, que ya lleva el factor adentro.

test('una linea de venta directa aparta su componente en unidades', () => {
  // Arrange
  const l = { plu: '40100', nombre: 'Mix Europeo 200G', cantidad: 120, unidades: 10, esPesable: false };

  // Act
  const ap = lineaAApartar(l);

  // Assert
  assert.deepStrictEqual(ap, { plu: '40100', nombre: 'Mix Europeo 200G', cantidad: 120 });
});

test('una linea pesable aparta el granel en kg segun los bultos pedidos', () => {
  // Arrange: 3 bultos de "Almendras 5Kg". cantidad=15 ya trae el factor 5 adentro.
  const l = { plu: '40222', nombre: 'Almendras Pedido', cantidad: 15, unidades: 3, esPesable: true,
              pluGranel: '50333', nombreGranel: 'Almendras Granel', kgPorUnidad: 5 };

  // Act
  const ap = lineaAApartar(l);

  // Assert: 3 bultos x 5 kg = 15 kg, NO 75.
  assert.deepStrictEqual(ap, { plu: '50333', nombre: 'Almendras Granel', cantidad: 15 });
});

test('un pesable con presentacion distinta aparta los kg de esa presentacion', () => {
  // Arrange: 2 bultos de "Almendras 20Kg". mult=20, cantidad=40, kg por bulto=20.
  const l = { plu: '40222', nombre: 'Almendras Pedido', cantidad: 40, unidades: 2, esPesable: true,
              pluGranel: '50333', nombreGranel: 'Almendras Granel', kgPorUnidad: 20 };

  // Act
  const ap = lineaAApartar(l);

  // Assert
  assert.strictEqual(ap.cantidad, 40);
});

test('una linea pesable sin granel resoluble no aparta nada', () => {
  // Arrange
  const l = { plu: '40222', nombre: 'Almendras Pedido', cantidad: 15, unidades: 3, esPesable: true,
              pluGranel: '', nombreGranel: '', kgPorUnidad: 5 };

  // Act
  const ap = lineaAApartar(l);

  // Assert
  assert.strictEqual(ap, null);
});

test('una linea pesable sin unidades de bulto no aparta nada', () => {
  // Arrange
  const l = { plu: '40222', nombre: 'Almendras Pedido', cantidad: 15, unidades: 0, esPesable: true,
              pluGranel: '50333', nombreGranel: 'Almendras Granel', kgPorUnidad: 5 };

  // Act
  const ap = lineaAApartar(l);

  // Assert
  assert.strictEqual(ap, null);
});

// ── Cuanto hay apartado por reservas mayoristas ───────────────────────────────
// La conciliacion de produccion necesita dos cosas: cuantos kg de granel estan en el deposito
// de reserva (para no descontarlos del principal) y cuantas unidades de "X Pedido" estan
// comprometidas (para dar de alta el terminado en reserva). Las anuladas no cuentan.

function reservaPesable(extra) {
  return {
    id: 1, estado: 'activa',
    pluCarga: '40222', nombreCarga: 'Almendras Pedido', unidadesPedidas: 3,
    lineas: [{ plu: '50333', nombre: 'Almendras Granel', cantidad: 15 }],
    ...extra,
  };
}

test('suma los kg de las reservas activas del mismo granel', () => {
  // Arrange
  const reservas = [reservaPesable(),
                    reservaPesable({ id: 2, lineas: [{ plu: '50333', cantidad: 10 }] })];

  // Act
  const mapa = granelReservadoPorPlu(reservas);

  // Assert
  assert.strictEqual(mapa.get('50333'), 25);
});

test('ignora las reservas anuladas al sumar granel', () => {
  // Arrange
  const reservas = [reservaPesable(), reservaPesable({ id: 2, estado: 'anulada' })];

  // Act
  const mapa = granelReservadoPorPlu(reservas);

  // Assert
  assert.strictEqual(mapa.get('50333'), 15);
});

test('devuelve un mapa vacio sin reservas', () => {
  // Arrange / Act
  const mapa = granelReservadoPorPlu([]);

  // Assert
  assert.strictEqual(mapa.size, 0);
});

test('suma las unidades comprometidas por producto de carga', () => {
  // Arrange
  const reservas = [reservaPesable(), reservaPesable({ id: 2, unidadesPedidas: 4 })];

  // Act
  const mapa = pedidoReservadoPorPlu(reservas);

  // Assert
  assert.strictEqual(mapa.get('40222'), 7);
});

test('una reserva de venta directa no aporta unidades de carga', () => {
  // Arrange
  const reservas = [reservaPesable({ pluCarga: null, unidadesPedidas: null })];

  // Act
  const mapa = pedidoReservadoPorPlu(reservas);

  // Assert
  assert.strictEqual(mapa.size, 0);
});

test('redondea la suma de kg fraccionados para no arrastrar colas de punto flotante', () => {
  // Arrange: 0.1 + 0.2 + 0.3 da 0.6000000000000001 en punto flotante sin redondear
  const reservas = [reservaPesable({
    lineas: [
      { plu: '50333', cantidad: 0.1 },
      { plu: '50333', cantidad: 0.2 },
      { plu: '50333', cantidad: 0.3 },
    ],
  })];

  // Act
  const mapa = granelReservadoPorPlu(reservas);

  // Assert
  assert.strictEqual(mapa.get('50333'), 0.6);
});

// ── Reparto del consumo entre la reserva del plan y el apartado mayorista ──────
// Invariante duro del circuito: cada kg que la sala consumio tiene que salir de UN deposito.
// La tabla recorre plan/mayorista/usado y comprueba el neto por deposito contra la verdad
// fisica. Se usan las funciones REALES de reservas_movimiento; lo unico replicado es la regla
// del comprobante "resto" (vive en server.js y no se puede requerir sin levantar el server).
// ponytail: replica de 3 lineas; si server.js cambia esa regla hay que espejarla aca.
const { lineasDiferenciasProduccion, lineasAjusteMovimiento, conciliarPorMovimiento, saldoLedger } = require('../lib/reservas_movimiento');
const { partirConsumoMayorista } = require('../lib/reservas_pesables');

const DEPS = { salida: 1, recepcion: 3, diferencias: 1, reserva: 2 };
const PLU_GRANEL = '7302';

// Neto por deposito de un dia con `plan` reservado por el plan, `may` apartado por el
// mayorista y `usado` consumido por la sala, armado con el MISMO orden que server.js.
function netoPorDeposito({ plan, may, usado, cobrado = 0 }) {
  const reservas = plan > 0 ? [{ estado: 'activa', numeroMovimiento: 55, lineas: [{ plu: PLU_GRANEL, nombre: 'Granel', cantidad: plan }] }] : [];
  const componentes = [{ plu: PLU_GRANEL, nombre: 'Granel', reservado: plan + may, usado }];
  const alMayorista = Math.min(may, cobrado, usado);
  // El granel que se le cobra al mayorista NO lo consumio el plan: si el reparto por movimiento
  // lo siguiera contando, el ajuste del plan sacaria del deposito de reserva kg que ya salieron
  // por la pata mayorista y las diferencias los devolverian una segunda vez.
  const porMovimiento = conciliarPorMovimiento(
    reservas.map(r => ({ numeroMovimiento: r.numeroMovimiento, ordenes: [], saldo: saldoLedger([r]), conciliado: false })),
    new Map([[PLU_GRANEL, Math.max(0, usado - alMayorista)]]));

  const { componentesPlan, lineasMayorista } = partirConsumoMayorista(
    componentes, may > 0 ? { [PLU_GRANEL]: may } : {}, DEPS.reserva, { [PLU_GRANEL]: cobrado });

  // Regla del comprobante "resto" (lineasProduccionDesdeConciliacion con incluirReserva:false):
  // sin nada reservado detras, todo el consumo sale del deposito de salida.
  const lineasResto = componentesPlan.filter(x => x.plu).flatMap(x => {
    const excedente = Math.max(0, x.usado - x.reservado);
    const deSalida = x.reservado > 0 ? 0 : excedente;
    return deSalida > 0 ? [{ idDeposito: DEPS.salida, cantidad: -deSalida }] : [];
  });
  const difs = lineasDiferenciasProduccion(componentesPlan, DEPS);
  const ajustes = porMovimiento.flatMap(m => lineasAjusteMovimiento(m.componentes, DEPS));

  const neto = {};
  for (const l of [...lineasResto, ...lineasMayorista, ...difs, ...ajustes]) {
    neto[l.idDeposito] = Math.round(((neto[l.idDeposito] || 0) + l.cantidad) * 1e4) / 1e4;
  }
  return { reserva: neto[DEPS.reserva] || 0, principal: neto[DEPS.salida] || 0 };
}

const TABLA = [
  // El caso que se perdia: la sala uso 12 con solo 5 apartados por el mayorista. Los 7 de mas
  // nunca estuvieron apartados y salen del principal; antes no salian de ningun lado.
  { plan: 0,  may: 5,    usado: 12, cobrado: 5,    reserva: -5,     principal: -7   },
  { plan: 0,  may: 5,    usado: 3,  cobrado: 3,    reserva: -3,     principal: 0    },
  { plan: 10, may: 5,    usado: 20, cobrado: 5,    reserva: -15,    principal: -5   },
  // Con el mayorista cobrado primero, al plan le sobran 3 de los 10 que aparto y vuelven al
  // principal. Antes el plan se comia esos 3 y el mayorista no pagaba nada.
  { plan: 10, may: 5,    usado: 12, cobrado: 5,    reserva: -15,    principal: 3    },
  { plan: 10, may: 5,    usado: 8,  cobrado: 5,    reserva: -15,    principal: 7    },
  // El caso normal del circuito: el plan consume EXACTAMENTE lo que aparto. El mayorista igual
  // paga su granel, porque su producto entro al deposito de reserva.
  { plan: 100, may: 3,   usado: 100, cobrado: 3,   reserva: -103,   principal: 3    },
  // La sala no llego a producir el pedido del mayorista: no se le cobra nada y sus kg siguen
  // apartados en el deposito de reserva.
  { plan: 10, may: 5,    usado: 12, cobrado: 0,    reserva: -10,    principal: -2   },
  // Sin mayorista el circuito tiene que quedar igual que antes de existir esta funcion.
  { plan: 10, may: 0,    usado: 12, cobrado: 0,    reserva: -10,    principal: -2   },
  { plan: 0,  may: 0,    usado: 5,  cobrado: 0,    reserva: 0,      principal: -5   },
  // Mayorista mayor que lo consumido: lo que sobra se queda en el deposito de reserva.
  { plan: 0,  may: 20,   usado: 4,  cobrado: 4,    reserva: -4,     principal: 0    },
  // Kilos fraccionados: el granel se aparta con decimales.
  { plan: 2.5, may: 1.25, usado: 3, cobrado: 1.25, reserva: -3.75,  principal: 0.75 },
];

for (const caso of TABLA) {
  test(`el consumo cae entero en un deposito (plan ${caso.plan}, mayorista ${caso.may}, usado ${caso.usado}, cobrado ${caso.cobrado})`, () => {
    // Act
    const neto = netoPorDeposito(caso);

    // Assert
    assert.deepStrictEqual(neto, { reserva: caso.reserva, principal: caso.principal });
    // Nada se evapora: lo que salio de los depositos menos lo que volvio es lo consumido.
    assert.strictEqual(Math.round((neto.reserva + neto.principal) * 1e4) / 1e4, -caso.usado);
  });
}

test('un componente sin plu no se toca aunque haya reservas mayoristas', () => {
  // Arrange
  const componentes = [{ plu: null, nombre: 'Granel sin PLU', reservado: 0, usado: 7 }];

  // Act
  const { componentesPlan, lineasMayorista } = partirConsumoMayorista(componentes, { '7302': 5 }, 2);

  // Assert
  assert.deepStrictEqual(componentesPlan, componentes);
  assert.deepStrictEqual(lineasMayorista, []);
});

test('la linea mayorista sale del deposito de reserva y con el consumo en negativo', () => {
  // Arrange: nada reservado por el plan, 5 apartados por el mayorista, la sala uso 3 y la
  // imputacion de la entrega le cobro esos 3 al mayorista.
  const componentes = [{ plu: '7302', nombre: 'Granel', reservado: 5, usado: 3 }];

  // Act
  const { componentesPlan, lineasMayorista } = partirConsumoMayorista(componentes, { '7302': 5 }, 2, { '7302': 3 });

  // Assert
  assert.deepStrictEqual(lineasMayorista, [{
    idProducto: '7302', nombre: 'Granel', idDeposito: 2, cantidad: -3, concepto: 'consumo-reserva-mayorista'
  }]);
  // La vista del plan queda sin nada: ni reservado propio ni consumo que conciliar.
  assert.strictEqual(componentesPlan[0].reservado, 0);
  assert.strictEqual(componentesPlan[0].usado, 0);
});

test('sin reservas mayoristas devuelve los componentes tal cual', () => {
  // Arrange
  const componentes = [{ plu: '7302', nombre: 'Granel', reservado: 10, usado: 12 }];

  // Act
  const { componentesPlan, lineasMayorista } = partirConsumoMayorista(componentes, {}, 2);

  // Assert
  assert.strictEqual(componentesPlan[0], componentes[0]);   // misma referencia: no se copia de gusto
  assert.deepStrictEqual(lineasMayorista, []);
});

// ── Apartado mayorista restante ───────────────────────────────────────────────
// El apartado NO se muta en reservas_mercaderia.json: lo que la sala consumio queda anotado
// en el asiento de produccion (plan.produccionRegistrada.asientos[].consumoMayorista) y el
// restante se deriva al leer. Asi el sello de la produccion y el consumo son UNA escritura.

function asiento(consumoMayorista, extra) {
  return { numeroMovimiento: 7, idRegistro: 'mov-1-0', registros: ['r1'], consumoMayorista, ...extra };
}

test('sin asientos el restante es el apartado entero', () => {
  // Arrange
  const reservas = [reservaPesable()];

  // Act
  const mapa = granelReservadoNeto(reservas, []);

  // Assert
  assert.strictEqual(mapa.get('50333'), 15);
});

test('el consumo anotado en el asiento baja el apartado restante', () => {
  // Arrange: 15 kg apartados, la sala consumio 6.
  const reservas = [reservaPesable()];
  const asientos = [asiento([{ idReserva: 1, plu: '50333', kg: 6 }])];

  // Act
  const mapa = granelReservadoNeto(reservas, asientos);

  // Assert
  assert.strictEqual(mapa.get('50333'), 9);
});

test('un apartado consumido entero deja de contar como reservado', () => {
  // Arrange
  const reservas = [reservaPesable()];
  const asientos = [asiento([{ idReserva: 1, plu: '50333', kg: 15 }])];

  // Act
  const mapa = granelReservadoNeto(reservas, asientos);

  // Assert: el PLU no aparece, igual que cuando no hay nada apartado.
  assert.strictEqual(mapa.has('50333'), false);
});

test('suma el consumo anotado en varios asientos de la misma reserva', () => {
  // Arrange: dos lotes del mismo dia, 6 kg y 4 kg.
  const reservas = [reservaPesable()];
  const asientos = [asiento([{ idReserva: 1, plu: '50333', kg: 6 }]),
                    asiento([{ idReserva: 1, plu: '50333', kg: 4 }], { idRegistro: 'mov-2-0' })];

  // Act
  const mapa = granelReservadoNeto(reservas, asientos);

  // Assert
  assert.strictEqual(mapa.get('50333'), 5);
});

test('un consumo de un PLU que ninguna reserva viva tiene no descuenta nada', () => {
  // Arrange: el asiento anota un granel que esta reserva no aparto.
  const reservas = [reservaPesable()];
  const asientos = [asiento([{ idReserva: 99, plu: '60444', kg: 8 }])];

  // Act
  const mapa = granelReservadoNeto(reservas, asientos);

  // Assert
  assert.strictEqual(mapa.get('50333'), 15);
  assert.strictEqual(mapa.has('60444'), false);
});

test('el restante de kg fraccionados no arrastra colas de punto flotante', () => {
  // Arrange
  const reservas = [reservaPesable({ lineas: [{ plu: '50333', cantidad: 0.3 }] })];
  const asientos = [asiento([{ idReserva: 1, plu: '50333', kg: 0.1 }])];

  // Act
  const mapa = granelReservadoNeto(reservas, asientos);

  // Assert
  assert.strictEqual(mapa.get('50333'), 0.2);
});

test('los asientos viejos sin consumo anotado se leen como cero consumido', () => {
  // Arrange: planes.json esta lleno de asientos escritos antes de este campo.
  const reservas = [reservaPesable()];
  const asientos = [{ numeroMovimiento: 3, idRegistro: 'mov-viejo', registros: ['r1'] },
                    { numeroMovimiento: 4, idRegistro: 'mov-viejo-2', consumoMayorista: null }];

  // Act
  const mapa = granelReservadoNeto(reservas, asientos);

  // Assert
  assert.strictEqual(mapa.get('50333'), 15);
});

test('el consumo de una reserva no baja el apartado de otra sucursal', () => {
  // Arrange: dos sucursales con el mismo granel; la clave es el id de reserva, que es unico
  // (Date.now()), no un contador por sucursal como numeroMovimiento.
  const suc1 = reservaPesable({ id: 101, idSucursal: 1 });
  const suc2 = reservaPesable({ id: 202, idSucursal: 2 });
  const asientos = [asiento([{ idReserva: 101, plu: '50333', kg: 15 }], { idSucursal: 1 })];

  // Act
  const soloSuc2 = granelReservadoNeto([suc2], asientos);
  const ambas = granelReservadoNeto([suc1, suc2], asientos);

  // Assert: lo consumido en la sucursal 1 no toca lo apartado en la 2.
  assert.strictEqual(soloSuc2.get('50333'), 15);
  assert.strictEqual(ambas.get('50333'), 15);
});

test('una reserva anulada no aporta apartado aunque tenga consumo anotado', () => {
  // Arrange
  const reservas = [reservaPesable({ estado: 'anulada' })];
  const asientos = [asiento([{ idReserva: 1, plu: '50333', kg: 6 }])];

  // Act
  const mapa = granelReservadoNeto(reservas, asientos);

  // Assert
  assert.strictEqual(mapa.size, 0);
});

test('el restante por reserva dice que queda en cada reserva y en cada PLU', () => {
  // Arrange
  const reservas = [reservaPesable({ id: 101 }), reservaPesable({ id: 202 })];
  const asientos = [asiento([{ idReserva: 101, plu: '50333', kg: 6 }])];

  // Act
  const filas = restanteMayoristaPorReserva(reservas, asientos);

  // Assert
  assert.deepStrictEqual(filas, [{ idReserva: 101, plu: '50333', restante: 9 },
                                 { idReserva: 202, plu: '50333', restante: 15 }]);
});

// ── Imputacion del consumo a las reservas ─────────────────────────────────────
// El granel del deposito de reserva es fungible: que reserva "puso" los kg que la sala
// consumio es una convencion (la mas vieja primero). Lo que no es convencion es que se
// anote CONTRA una reserva: sin eso el consumo de ayer descontaria la reserva de hoy.

test('imputa el consumo a la reserva que tiene ese granel apartado', () => {
  // Arrange
  const filas = [{ idReserva: 101, plu: '50333', restante: 15 }];

  // Act
  const consumo = imputarConsumoMayorista(filas, { '50333': 6 });

  // Assert
  assert.deepStrictEqual(consumo, [{ idReserva: 101, plu: '50333', kg: 6 }]);
});

test('reparte el consumo entre varias reservas, la mas vieja primero', () => {
  // Arrange: el id lleva el timestamp de creacion, asi que el menor es el mas viejo.
  const filas = [{ idReserva: 202, plu: '50333', restante: 10 },
                 { idReserva: 101, plu: '50333', restante: 4 }];

  // Act
  const consumo = imputarConsumoMayorista(filas, { '50333': 9 });

  // Assert
  assert.deepStrictEqual(consumo, [{ idReserva: 101, plu: '50333', kg: 4 },
                                   { idReserva: 202, plu: '50333', kg: 5 }]);
});

test('no imputa mas kg de los que le quedan a la reserva', () => {
  // Arrange
  const filas = [{ idReserva: 101, plu: '50333', restante: 4 }];

  // Act
  const consumo = imputarConsumoMayorista(filas, { '50333': 9 });

  // Assert: los 5 kg que sobran salieron de otro lado, no del apartado.
  assert.deepStrictEqual(consumo, [{ idReserva: 101, plu: '50333', kg: 4 }]);
});

test('sin consumo no anota nada en el asiento', () => {
  // Arrange
  const filas = [{ idReserva: 101, plu: '50333', restante: 15 }];

  // Act / Assert
  assert.deepStrictEqual(imputarConsumoMayorista(filas, {}), []);
  assert.deepStrictEqual(imputarConsumoMayorista(filas, { '50333': 0 }), []);
  assert.deepStrictEqual(imputarConsumoMayorista([], { '50333': 6 }), []);
});

test('la imputacion de kg fraccionados no arrastra colas de punto flotante', () => {
  // Arrange
  const filas = [{ idReserva: 101, plu: '50333', restante: 0.1 },
                 { idReserva: 202, plu: '50333', restante: 0.5 }];

  // Act
  const consumo = imputarConsumoMayorista(filas, { '50333': 0.3 });

  // Assert
  assert.deepStrictEqual(consumo, [{ idReserva: 101, plu: '50333', kg: 0.1 },
                                   { idReserva: 202, plu: '50333', kg: 0.2 }]);
});

test('dos lotes seguidos no consumen mas kg que los apartados', () => {
  // Arrange: 10 kg apartados y dos lotes de 6 kg, el bug que motiva todo esto.
  const reservas = [reservaPesable({ id: 101, lineas: [{ plu: '50333', cantidad: 10 }] })];

  // Act: lote 1 contra el apartado entero.
  const lote1 = imputarConsumoMayorista(restanteMayoristaPorReserva(reservas, []),
    { '50333': Math.min(granelReservadoNeto(reservas, []).get('50333'), 6) });
  const asientos = [asiento(lote1)];
  // Lote 2: el apartado restante ya es 4, asi que solo puede salir 4 del deposito de reserva.
  const restanteLote2 = granelReservadoNeto(reservas, asientos).get('50333');
  const lote2 = imputarConsumoMayorista(restanteMayoristaPorReserva(reservas, asientos),
    { '50333': Math.min(restanteLote2, 6) });

  // Assert
  assert.strictEqual(restanteLote2, 4);
  const total = [...lote1, ...lote2].reduce((s, c) => s + c.kg, 0);
  assert.strictEqual(total, 10);
  assert.strictEqual(granelReservadoNeto(reservas, [...asientos, asiento(lote2)]).size, 0);
});

// ── Que devuelve la anulacion ─────────────────────────────────────────────────
// Anular emite el traslado inverso (deposito de reserva -> principal). Lo que la produccion
// ya consumio NO esta en el deposito de reserva: devolverlo seria inventar stock. Las lineas
// siguen diciendo lo apartado original (no se mutan), asi que el restante se deriva igual que
// en la conciliacion, con los asientos de produccion.

test('sin consumo se devuelven las lineas enteras', () => {
  // Arrange
  const reserva = reservaPesable({ id: 101 });

  // Act
  const lineas = lineasADevolverMayorista(reserva, []);

  // Assert
  assert.deepStrictEqual(lineas.map(l => [l.plu, l.cantidad]), [['50333', 15]]);
  assert.strictEqual(lineas[0].nombre, 'Almendras Granel');
});

test('con consumo parcial se devuelve solo lo que quedo apartado', () => {
  // Arrange: 15 kg apartados, la produccion consumio 6.
  const reserva = reservaPesable({ id: 101 });
  const asientos = [asiento([{ idReserva: 101, plu: '50333', kg: 6 }])];

  // Act
  const lineas = lineasADevolverMayorista(reserva, asientos);

  // Assert
  assert.deepStrictEqual(lineas.map(l => [l.plu, l.cantidad]), [['50333', 9]]);
});

test('con el apartado consumido entero no queda nada que devolver', () => {
  // Arrange
  const reserva = reservaPesable({ id: 101 });
  const asientos = [asiento([{ idReserva: 101, plu: '50333', kg: 15 }])];

  // Act
  const lineas = lineasADevolverMayorista(reserva, asientos);

  // Assert: sin lineas no hay comprobante que emitir, pero la reserva igual se anula.
  assert.deepStrictEqual(lineas, []);
});

test('con varias lineas devuelve enteras las que nadie consumio', () => {
  // Arrange
  const reserva = reservaPesable({ id: 101, lineas: [
    { plu: '50333', nombre: 'Almendras Granel', cantidad: 15 },
    { plu: '60444', nombre: 'Nueces Granel', cantidad: 8 }] });
  const asientos = [asiento([{ idReserva: 101, plu: '50333', kg: 15 }])];

  // Act
  const lineas = lineasADevolverMayorista(reserva, asientos);

  // Assert
  assert.deepStrictEqual(lineas.map(l => [l.plu, l.cantidad]), [['60444', 8]]);
});

test('el consumo de un PLU repartido en dos lineas se descuenta de una sola vez', () => {
  // Arrange: dos lineas del mismo granel, 10 y 4, con 12 consumidos.
  const reserva = reservaPesable({ id: 101, lineas: [
    { plu: '50333', nombre: 'Almendras Granel', cantidad: 10 },
    { plu: '50333', nombre: 'Almendras Granel', cantidad: 4 }] });
  const asientos = [asiento([{ idReserva: 101, plu: '50333', kg: 12 }])];

  // Act
  const lineas = lineasADevolverMayorista(reserva, asientos);

  // Assert: quedan 2 en total, no 2 por linea.
  assert.deepStrictEqual(lineas.map(l => [l.plu, l.cantidad]), [['50333', 2]]);
});

test('el consumo de otra reserva no achica lo que esta devuelve', () => {
  // Arrange
  const reserva = reservaPesable({ id: 101 });
  const asientos = [asiento([{ idReserva: 202, plu: '50333', kg: 15 }])];

  // Act
  const lineas = lineasADevolverMayorista(reserva, asientos);

  // Assert
  assert.deepStrictEqual(lineas.map(l => [l.plu, l.cantidad]), [['50333', 15]]);
});

test('los asientos viejos sin consumo anotado devuelven la reserva entera', () => {
  // Arrange
  const reserva = reservaPesable({ id: 101 });
  const asientos = [{ numeroMovimiento: 3, idRegistro: 'mov-viejo', registros: ['r1'] }];

  // Act
  const lineas = lineasADevolverMayorista(reserva, asientos);

  // Assert
  assert.deepStrictEqual(lineas.map(l => [l.plu, l.cantidad]), [['50333', 15]]);
});

test('nunca sale una linea con cantidad cero o negativa', () => {
  // Arrange: consumido de mas (no deberia pasar) y una linea sin cantidad util.
  const reserva = reservaPesable({ id: 101, lineas: [
    { plu: '50333', nombre: 'Almendras Granel', cantidad: 15 },
    { plu: '60444', nombre: 'Nueces Granel', cantidad: 0 }] });
  const asientos = [asiento([{ idReserva: 101, plu: '50333', kg: 20 }])];

  // Act
  const lineas = lineasADevolverMayorista(reserva, asientos);

  // Assert
  assert.deepStrictEqual(lineas, []);
});

// ── "X Pedido" que todavia falta entrar al deposito de reserva ────────────────
// Simetrico al granel: lo que ya entro queda anotado en el asiento de produccion
// (terminadoMayorista) y lo que falta se deriva al leer. Sin esto, con la produccion cargada
// en lotes, el lote 2 volveria a ver las unidades enteras y entrarian dos veces al deposito
// de reserva (reserva de 3, lotes de 6 y 4 = 6 unidades apartadas).

test('sin asientos falta entrar la reserva entera de X Pedido', () => {
  // Arrange
  const reservas = [reservaPesable({ id: 101 })];

  // Act
  const filas = restantePedidoPorReserva(reservas, []);

  // Assert
  assert.deepStrictEqual(filas, [{ idReserva: 101, plu: '40222', restante: 3 }]);
});

test('lo que ya entro al deposito de reserva no vuelve a faltar', () => {
  // Arrange: 3 pedidas, 2 ya entraron.
  const reservas = [reservaPesable({ id: 101 })];
  const asientos = [{ idRegistro: 'mov-1', terminadoMayorista: [{ idReserva: 101, plu: '40222', unidades: 2 }] }];

  // Act
  const filas = restantePedidoPorReserva(reservas, asientos);

  // Assert
  assert.deepStrictEqual(filas, [{ idReserva: 101, plu: '40222', restante: 1 }]);
});

test('los asientos viejos sin terminadoMayorista no descuentan unidades', () => {
  // Arrange: planes.json esta lleno de asientos escritos antes de este campo.
  const reservas = [reservaPesable({ id: 101 })];
  const asientos = [{ idRegistro: 'mov-viejo', registros: ['r1'] },
                    { idRegistro: 'mov-viejo-2', terminadoMayorista: null }];

  // Act
  const filas = restantePedidoPorReserva(reservas, asientos);

  // Assert
  assert.deepStrictEqual(filas, [{ idReserva: 101, plu: '40222', restante: 3 }]);
});

test('lo que entro contra otra reserva no descuenta esta', () => {
  // Arrange
  const reservas = [reservaPesable({ id: 101 })];
  const asientos = [{ idRegistro: 'mov-1', terminadoMayorista: [{ idReserva: 202, plu: '40222', unidades: 3 }] }];

  // Act
  const filas = restantePedidoPorReserva(reservas, asientos);

  // Assert
  assert.deepStrictEqual(filas, [{ idReserva: 101, plu: '40222', restante: 3 }]);
});

test('una reserva de venta directa no aporta unidades de X Pedido', () => {
  // Arrange: sin pluCarga no hay intermedio que apartar.
  const reservas = [reservaPesable({ id: 101, pluCarga: null, unidadesPedidas: null })];

  // Act / Assert
  assert.deepStrictEqual(restantePedidoPorReserva(reservas, []), []);
});

test('agruparRestante suma lo que falta de varias reservas del mismo producto', () => {
  // Arrange
  const filas = [{ idReserva: 101, plu: '40222', restante: 3 },
                 { idReserva: 202, plu: '40222', restante: 2 },
                 { idReserva: 303, plu: '40222', restante: 0 }];

  // Act
  const mapa = agruparRestante(filas);

  // Assert
  assert.strictEqual(mapa.get('40222'), 5);
  assert.strictEqual(mapa.size, 1);
});

test('dos lotes no meten al deposito de reserva mas unidades que las apartadas', () => {
  // Arrange: reserva de 3 unidades, produccion de 10 registrada en lotes de 6 y 4.
  const reservas = [reservaPesable({ id: 101 })];
  const lote = (producido, asientos) => {
    const reservado = agruparRestante(restantePedidoPorReserva(reservas, asientos)).get('40222') || 0;
    const aReserva = Math.min(producido, reservado);
    return { aReserva, anotado: imputarConsumoMayorista(restantePedidoPorReserva(reservas, asientos),
                                                        { '40222': aReserva }) };
  };

  // Act
  const lote1 = lote(6, []);
  const asientos = [{ idRegistro: 'mov-1', terminadoMayorista: lote1.anotado.map(
    ({ idReserva, plu, kg }) => ({ idReserva, plu, unidades: kg })) }];
  const lote2 = lote(4, asientos);

  // Assert: 3 en total, no 3 por lote.
  assert.strictEqual(lote1.aReserva, 3);
  assert.strictEqual(lote2.aReserva, 0);
});

// ── Entrega mayorista: una sola imputacion para las dos patas ─────────────────
// El defecto que esto cierra: mientras el terminado y el consumo de granel se calculaban por
// separado, un dia normal (el plan consume justo lo que reservo) entregaba las unidades al
// deposito de reserva SIN cobrarle el granel a la reserva. El deposito quedaba con la materia
// prima Y el producto terminado del mismo pedido, y nada reconciliaba los dos ledgers.
const { basesEntregaMayorista, imputarEntregaMayorista } = require('../lib/reservas_pesables');

test('el dia normal cobra el granel de las unidades que entrega', () => {
  // Arrange: el plan aparto 100 kg de granel, la reserva mayorista 15 kg para 3 unidades.
  // La sala produjo 100 unidades y consumio los 100 kg del plan mas los 15 del mayorista.
  const reservas = [reservaPesable({ id: 101 })];
  const bases = basesEntregaMayorista(reservas, []);

  // Act
  const r = imputarEntregaMayorista(bases, new Map([['40222', 100]]), new Map([['50333', 115]]));

  // Assert: las 3 unidades entran al deposito de reserva y sus 15 kg se cobran a la reserva.
  assert.deepStrictEqual(r.terminadoMayorista, [{ idReserva: 101, plu: '40222', unidades: 3 }]);
  assert.deepStrictEqual(r.consumoMayorista,   [{ idReserva: 101, plu: '50333', kg: 15 }]);
  assert.strictEqual(r.unidadesPorPlu.get('40222'), 3);
});

test('entrega solo las unidades que la produccion alcanzo a fabricar', () => {
  // Arrange: reserva de 3 unidades pero la sala solo produjo 2.
  const bases = basesEntregaMayorista([reservaPesable({ id: 101 })], []);

  // Act
  const r = imputarEntregaMayorista(bases, new Map([['40222', 2]]), new Map([['50333', 100]]));

  // Assert: 2 unidades y sus 10 kg (5 kg por unidad), no las 3 apartadas.
  assert.deepStrictEqual(r.terminadoMayorista, [{ idReserva: 101, plu: '40222', unidades: 2 }]);
  assert.deepStrictEqual(r.consumoMayorista,   [{ idReserva: 101, plu: '50333', kg: 10 }]);
});

test('el granel manda: sin kg apartados no se entrega ninguna unidad', () => {
  // Arrange: la reserva ya gasto su granel en una produccion anterior, pero su ledger de
  // unidades todavia dice que faltan 3. Entregarlas ahora seria regalar producto.
  const asientos = [{ consumoMayorista: [{ idReserva: 101, plu: '50333', kg: 15 }] }];
  const bases = basesEntregaMayorista([reservaPesable({ id: 101 })], asientos);

  // Act
  const r = imputarEntregaMayorista(bases, new Map([['40222', 3]]), new Map([['50333', 100]]));

  // Assert
  assert.deepStrictEqual(r.terminadoMayorista, []);
  assert.deepStrictEqual(r.consumoMayorista, []);
});

test('el granel a medias recorta las unidades entregadas', () => {
  // Arrange: quedan 10 de los 15 kg apartados (5 kg por unidad) -> alcanza para 2 unidades.
  const asientos = [{ consumoMayorista: [{ idReserva: 101, plu: '50333', kg: 5 }],
                      terminadoMayorista: [{ idReserva: 101, plu: '40222', unidades: 1 }] }];
  const bases = basesEntregaMayorista([reservaPesable({ id: 101 })], asientos);

  // Act
  const r = imputarEntregaMayorista(bases, new Map([['40222', 5]]), new Map([['50333', 100]]));

  // Assert
  assert.deepStrictEqual(r.terminadoMayorista, [{ idReserva: 101, plu: '40222', unidades: 2 }]);
  assert.deepStrictEqual(r.consumoMayorista,   [{ idReserva: 101, plu: '50333', kg: 10 }]);
});

test('no se le cobra al mayorista mas granel del que la sala consumio', () => {
  // Arrange: la sala produjo las 3 unidades pero solo declaro 6 kg de consumo de ese granel.
  const bases = basesEntregaMayorista([reservaPesable({ id: 101 })], []);

  // Act
  const r = imputarEntregaMayorista(bases, new Map([['40222', 3]]), new Map([['50333', 6]]));

  // Assert: 6 kg cubren 1.2 unidades; se entregan 1.2 y se cobran los 6 kg.
  assert.deepStrictEqual(r.terminadoMayorista, [{ idReserva: 101, plu: '40222', unidades: 1.2 }]);
  assert.deepStrictEqual(r.consumoMayorista,   [{ idReserva: 101, plu: '50333', kg: 6 }]);
});

test('reparte entre dos reservas del mismo pedido, la mas vieja primero', () => {
  // Arrange: dos reservas de 3 unidades cada una y produccion para 4.
  const reservas = [reservaPesable({ id: 202 }), reservaPesable({ id: 101 })];
  const bases = basesEntregaMayorista(reservas, []);

  // Act
  const r = imputarEntregaMayorista(bases, new Map([['40222', 4]]), new Map([['50333', 100]]));

  // Assert: la 101 se lleva sus 3 enteras y la 202 la unidad que sobra.
  assert.deepStrictEqual(r.terminadoMayorista, [{ idReserva: 101, plu: '40222', unidades: 3 },
                                                { idReserva: 202, plu: '40222', unidades: 1 }]);
  assert.deepStrictEqual(r.consumoMayorista,   [{ idReserva: 101, plu: '50333', kg: 15 },
                                                { idReserva: 202, plu: '50333', kg: 5 }]);
  assert.strictEqual(r.unidadesPorPlu.get('40222'), 4);
});

test('dos lotes del mismo dia no entregan mas de lo apartado', () => {
  // Arrange: reserva de 3 unidades, produccion cargada en dos lotes de 2.
  const reservas = [reservaPesable({ id: 101 })];
  const lote = asientos => imputarEntregaMayorista(basesEntregaMayorista(reservas, asientos),
    new Map([['40222', 2]]), new Map([['50333', 100]]));

  // Act
  const l1 = lote([]);
  const l2 = lote([{ terminadoMayorista: l1.terminadoMayorista, consumoMayorista: l1.consumoMayorista }]);

  // Assert: 2 + 1 = las 3 apartadas, y el granel acompana (10 + 5 = 15).
  assert.strictEqual(l1.unidadesPorPlu.get('40222'), 2);
  assert.strictEqual(l2.unidadesPorPlu.get('40222'), 1);
  assert.deepStrictEqual(l2.consumoMayorista, [{ idReserva: 101, plu: '50333', kg: 5 }]);
});

test('una reserva de venta directa no entrega nada por esta via', () => {
  // Arrange
  const reservas = [reservaPesable({ id: 101, pluCarga: null, unidadesPedidas: null })];

  // Act
  const r = imputarEntregaMayorista(basesEntregaMayorista(reservas, []),
    new Map([['40222', 10]]), new Map([['50333', 100]]));

  // Assert
  assert.deepStrictEqual(r.terminadoMayorista, []);
  assert.deepStrictEqual(r.consumoMayorista, []);
});

test('sin produccion del pedido no se cobra granel', () => {
  // Arrange
  const bases = basesEntregaMayorista([reservaPesable({ id: 101 })], []);

  // Act
  const r = imputarEntregaMayorista(bases, new Map(), new Map([['50333', 100]]));

  // Assert
  assert.deepStrictEqual(r.consumoMayorista, []);
  assert.strictEqual(r.unidadesPorPlu.size, 0);
});

test('dos lineas del mismo granel en una reserva no cobran el restante dos veces', () => {
  // Arrange: 15 kg apartados en dos lineas del mismo PLU para 3 unidades.
  const reservas = [reservaPesable({ id: 101, lineas: [{ plu: '50333', cantidad: 10 },
                                                       { plu: '50333', cantidad: 5 }] })];
  const bases = basesEntregaMayorista(reservas, []);

  // Act
  const r = imputarEntregaMayorista(bases, new Map([['40222', 3]]), new Map([['50333', 100]]));

  // Assert: una sola linea de consumo por 15 kg, no dos por 15 cada una.
  assert.deepStrictEqual(r.consumoMayorista, [{ idReserva: 101, plu: '50333', kg: 15 }]);
});

test('los kg fraccionados de la entrega no arrastran colas de punto flotante', () => {
  // Arrange: 0.3 kg para 3 unidades = 0.1 kg por unidad.
  const reservas = [reservaPesable({ id: 101, lineas: [{ plu: '50333', cantidad: 0.3 }] })];
  const bases = basesEntregaMayorista(reservas, []);

  // Act
  const r = imputarEntregaMayorista(bases, new Map([['40222', 3]]), new Map([['50333', 5]]));

  // Assert
  assert.deepStrictEqual(r.consumoMayorista, [{ idReserva: 101, plu: '50333', kg: 0.3 }]);
});

// ── Anular: las unidades ya entregadas tambien tienen que volver ──────────────
// Anulando una reserva se devolvia SOLO el granel que quedaba apartado. Lo que la produccion
// ya habia convertido en producto terminado se quedaba varado en el deposito de reserva, sin
// ninguna reserva viva que lo reclamara, y el aviso decia "la produccion ya consumio N" — que
// es enganoso: el granel no salio del edificio, se convirtio en mercaderia que sigue ahi.
const { lineasTerminadoADevolverMayorista } = require('../lib/reservas_pesables');

test('sin produccion no hay terminado que devolver', () => {
  // Arrange
  const reserva = reservaPesable({ id: 101 });

  // Act / Assert
  assert.deepStrictEqual(lineasTerminadoADevolverMayorista(reserva, []), []);
});

test('devuelve las unidades que la produccion ya metio al deposito de reserva', () => {
  // Arrange: de las 3 unidades apartadas, la produccion entrego 2.
  const reserva = reservaPesable({ id: 101 });
  const asientos = [{ terminadoMayorista: [{ idReserva: 101, plu: '40222', unidades: 2 }] }];

  // Act
  const lineas = lineasTerminadoADevolverMayorista(reserva, asientos);

  // Assert
  assert.deepStrictEqual(lineas, [{ plu: '40222', nombre: 'Almendras Pedido', cantidad: 2 }]);
});

test('una reserva producida entera devuelve todas sus unidades', () => {
  // Arrange
  const reserva = reservaPesable({ id: 101 });
  const asientos = [{ terminadoMayorista: [{ idReserva: 101, plu: '40222', unidades: 3 }] }];

  // Act / Assert
  assert.deepStrictEqual(lineasTerminadoADevolverMayorista(reserva, asientos),
                         [{ plu: '40222', nombre: 'Almendras Pedido', cantidad: 3 }]);
});

test('lo entregado contra otra reserva no se devuelve por esta', () => {
  // Arrange
  const reserva = reservaPesable({ id: 101 });
  const asientos = [{ terminadoMayorista: [{ idReserva: 202, plu: '40222', unidades: 3 }] }];

  // Act / Assert
  assert.deepStrictEqual(lineasTerminadoADevolverMayorista(reserva, asientos), []);
});

test('una reserva de venta directa no tiene terminado que devolver', () => {
  // Arrange
  const reserva = reservaPesable({ id: 101, pluCarga: null, unidadesPedidas: null });

  // Act / Assert
  assert.deepStrictEqual(lineasTerminadoADevolverMayorista(reserva, []), []);
});

test('las unidades entregadas en dos lotes se devuelven de una sola vez', () => {
  // Arrange
  const reserva = reservaPesable({ id: 101 });
  const asientos = [{ terminadoMayorista: [{ idReserva: 101, plu: '40222', unidades: 2 }] },
                    { terminadoMayorista: [{ idReserva: 101, plu: '40222', unidades: 1 }] }];

  // Act / Assert
  assert.deepStrictEqual(lineasTerminadoADevolverMayorista(reserva, asientos),
                         [{ plu: '40222', nombre: 'Almendras Pedido', cantidad: 3 }]);
});

// ── Que ajuste deja el deposito de reserva en cero ────────────────────────────
// El deposito de reserva es de paso: cuando el mayorista se llevo lo suyo, lo que quede ahi es
// una diferencia que hay que resolver. Un PLU es granel O producto de carga, nunca los dos, asi
// que en la practica solo uno de los dos saldos llega distinto de cero; el orden esta definido
// igual para que la funcion sea total.
const { ajustePropuesto } = require('../lib/reservas_pesables');

test('sin saldos no propone ningun ajuste', () => {
  // Arrange / Act
  const a = ajustePropuesto({ saldoGranel: 0, saldoPedido: 0 });

  // Assert
  assert.strictEqual(a, null);
});

test('sobro granel: lo devuelve al principal', () => {
  // Arrange / Act
  const a = ajustePropuesto({ saldoGranel: 2.5, saldoPedido: 0, pluGranel: '50333', pluCarga: '40222' });

  // Assert
  assert.deepStrictEqual(a, { tipo: 'devolver-granel', plu: '50333', cantidad: 2.5,
                              sentido: 'reserva-a-principal' });
});

test('sobro producto de pedido: lo devuelve al principal', () => {
  // Arrange / Act
  const a = ajustePropuesto({ saldoGranel: 0, saldoPedido: 3, pluGranel: '50333', pluCarga: '40222' });

  // Assert
  assert.deepStrictEqual(a, { tipo: 'devolver-pedido', plu: '40222', cantidad: 3,
                              sentido: 'reserva-a-principal' });
});

test('facturo de mas: propone reponer el pedido desde el principal', () => {
  // Arrange / Act
  const a = ajustePropuesto({ saldoGranel: 0, saldoPedido: -2, pluGranel: '50333', pluCarga: '40222' });

  // Assert
  assert.deepStrictEqual(a, { tipo: 'reponer-pedido', plu: '40222', cantidad: 2,
                              sentido: 'principal-a-reserva' });
});

test('el granel manda cuando los dos tienen saldo', () => {
  // Arrange / Act
  const a = ajustePropuesto({ saldoGranel: 1, saldoPedido: 3, pluGranel: '50333', pluCarga: '40222' });

  // Assert
  assert.strictEqual(a.tipo, 'devolver-granel');
});

// El caso que faltaba: hay MENOS granel del que las reservas vivas tienen apartado. Alguien lo
// saco del deposito de reserva por fuera del circuito. Sin esta rama el endpoint devolvia
// `ajuste: null` y el faltante quedaba invisible justo cuando hay que actuar.
test('falta granel de lo apartado: propone reponerlo desde el principal', () => {
  // Arrange / Act
  const a = ajustePropuesto({ saldoGranel: -4, saldoPedido: 0, pluGranel: '50333', pluCarga: '40222' });

  // Assert
  assert.deepStrictEqual(a, { tipo: 'reponer-granel', plu: '50333', cantidad: 4,
                              sentido: 'principal-a-reserva' });
});

test('un saldo negativo no propone mover una cantidad negativa', () => {
  // Arrange / Act
  const granel = ajustePropuesto({ saldoGranel: -4, pluGranel: '50333' });
  const pedido = ajustePropuesto({ saldoPedido: -2, pluCarga: '40222' });

  // Assert: los traslados siempre llevan cantidad positiva; el sentido es lo que cambia.
  assert.ok(granel.cantidad > 0);
  assert.ok(pedido.cantidad > 0);
  assert.strictEqual(granel.sentido, 'principal-a-reserva');
  assert.strictEqual(pedido.sentido, 'principal-a-reserva');
});

test('una cola de punto flotante no dispara un ajuste fantasma', () => {
  // Arrange: 0.1 + 0.2 - 0.3 deja -0.00000000000000006 en el saldo.
  const a = ajustePropuesto({ saldoGranel: 0.1 + 0.2 - 0.3, saldoPedido: 0, pluGranel: '50333' });

  // Assert
  assert.strictEqual(a, null);
});

test('un saldo que no es numero se lee como cero', () => {
  // Arrange / Act / Assert
  assert.strictEqual(ajustePropuesto({}), null);
  assert.strictEqual(ajustePropuesto(null), null);
  assert.strictEqual(ajustePropuesto({ saldoGranel: null, saldoPedido: undefined }), null);
});

// ── Saldos del deposito de reserva ────────────────────────────────────────────
// El endpoint solo hace IO (leer los json y pedirle el stock a SiGA); la regla de que esta
// comprometido y que ajuste corresponde vive aca, que es donde se puede testear. Los ocho
// defectos de esta feature estuvieron todos en esta clase de frontera.
const { filasSaldoMayorista } = require('../lib/reservas_pesables');

test('sin reservas vivas no hay filas', () => {
  // Arrange / Act / Assert
  assert.deepStrictEqual(filasSaldoMayorista([], [], new Map()), []);
});

test('el granel apartado y sin tocar da saldo igual a comprometido y ningun ajuste', () => {
  // Arrange: 15 kg apartados, 15 kg fisicos en el deposito.
  const reservas = [reservaPesable({ id: 101, nombreCliente: 'ACME' })];

  // Act
  const filas = filasSaldoMayorista(reservas, [], new Map([['50333', 15]]));

  // Assert
  const g = filas.find(f => f.plu === '50333');
  assert.strictEqual(g.comprometido, 15);
  assert.strictEqual(g.saldo, 15);
  assert.strictEqual(g.ajuste, null);
  assert.strictEqual(g.esGranel, true);
});

// EL bug que tenia el plan: usaba granelReservadoPorPlu/pedidoReservadoPorPlu, que son BRUTOS.
// Con el bruto, una reserva ya producida sigue diciendo "15 kg comprometidos" aunque el granel
// ya salio del deposito, y el ajuste propuesto habria sacado 15 kg del principal para reponer
// algo que nadie debe.
test('el granel que la produccion ya consumio deja de estar comprometido', () => {
  // Arrange: los 15 kg se consumieron y entraron las 3 unidades de "X Pedido".
  const reservas = [reservaPesable({ id: 101 })];
  const asientos = [{ consumoMayorista:   [{ idReserva: 101, plu: '50333', kg: 15 }],
                      terminadoMayorista: [{ idReserva: 101, plu: '40222', unidades: 3 }] }];

  // Act: el deposito tiene 0 kg de granel y las 3 unidades esperando al cliente.
  const filas = filasSaldoMayorista(reservas, asientos, new Map([['50333', 0], ['40222', 3]]));

  // Assert: el granel ya no figura (nada comprometido, nada fisico).
  assert.strictEqual(filas.find(f => f.plu === '50333'), undefined);
  // Y el pedido cuadra: las 3 que el cliente tiene derecho a retirar estan ahi. Sin ajuste.
  const p = filas.find(f => f.plu === '40222');
  assert.strictEqual(p.comprometido, 3);
  assert.strictEqual(p.saldo, 3);
  assert.strictEqual(p.ajuste, null);
});

// La otra mitad de la asimetria: el "X Pedido" se compromete BRUTO mientras la reserva viva.
// Que la sala todavia no lo haya fabricado no cambia lo que el cliente tiene derecho a retirar.
test('el pedido sigue comprometido entero aunque la produccion no lo haya hecho', () => {
  // Arrange: reserva de 3 unidades, la sala no produjo nada todavia.
  const filas = filasSaldoMayorista([reservaPesable({ id: 101 })], [],
                                    new Map([['50333', 15], ['40222', 0]]));

  // Assert
  const p = filas.find(f => f.plu === '40222');
  assert.strictEqual(p.comprometido, 3);
  assert.deepStrictEqual(p.ajuste, { tipo: 'reponer-pedido', plu: '40222', cantidad: 3,
                                     sentido: 'principal-a-reserva' });
});

test('el cliente que ya retiro lo suyo deja la reserva con saldo negativo', () => {
  // Arrange: se produjeron las 3 unidades y el cliente se las llevo; la reserva quedo abierta.
  const asientos = [{ consumoMayorista:   [{ idReserva: 101, plu: '50333', kg: 15 }],
                      terminadoMayorista: [{ idReserva: 101, plu: '40222', unidades: 3 }] }];

  // Act
  const filas = filasSaldoMayorista([reservaPesable({ id: 101 })], asientos,
                                    new Map([['50333', 0], ['40222', 0]]));

  // Assert: el faltante es la senal de que hay que mirar esa reserva y cerrarla.
  const p = filas.find(f => f.plu === '40222');
  assert.strictEqual(p.comprometido, 3);
  assert.strictEqual(p.saldo, 0);
  assert.strictEqual(p.ajuste.tipo, 'reponer-pedido');
});

test('sobra granel en el deposito: propone devolverlo', () => {
  // Arrange: 15 apartados, 18 fisicos.
  const filas = filasSaldoMayorista([reservaPesable({ id: 101 })], [], new Map([['50333', 18]]));

  // Assert
  const g = filas.find(f => f.plu === '50333');
  assert.deepStrictEqual(g.ajuste, { tipo: 'devolver-granel', plu: '50333', cantidad: 3,
                                     sentido: 'reserva-a-principal' });
});

test('falta granel contra lo apartado: propone reponerlo', () => {
  // Arrange: 15 apartados, 11 fisicos — alguien saco 4 kg por fuera del circuito.
  const filas = filasSaldoMayorista([reservaPesable({ id: 101 })], [], new Map([['50333', 11]]));

  // Assert
  const g = filas.find(f => f.plu === '50333');
  assert.deepStrictEqual(g.ajuste, { tipo: 'reponer-granel', plu: '50333', cantidad: 4,
                                     sentido: 'principal-a-reserva' });
});

test('un PLU sin stock fisico se lee como cero, no como faltante de dato', () => {
  // Arrange: SiGA no devolvio fila para ese PLU (no tiene stock en ese deposito).
  const filas = filasSaldoMayorista([reservaPesable({ id: 101 })], [], new Map());

  // Assert
  const g = filas.find(f => f.plu === '50333');
  assert.strictEqual(g.saldo, 0);
  assert.strictEqual(g.ajuste.tipo, 'reponer-granel');
  assert.strictEqual(g.ajuste.cantidad, 15);
});

test('cada fila dice que reservas la componen', () => {
  // Arrange
  const reservas = [reservaPesable({ id: 101, nombreCliente: 'ACME', pluPedido: '30111' }),
                    reservaPesable({ id: 202, nombreCliente: 'OTRO', pluPedido: '30111' })];

  // Act
  const filas = filasSaldoMayorista(reservas, [], new Map([['50333', 30]]));

  // Assert
  const g = filas.find(f => f.plu === '50333');
  assert.deepStrictEqual(g.reservas, [{ id: 101, cliente: 'ACME', pluPedido: '30111' },
                                      { id: 202, cliente: 'OTRO', pluPedido: '30111' }]);
  assert.strictEqual(g.comprometido, 30);
});

test('los PLU no numericos quedan fuera', () => {
  // Arrange: un PLU con basura consultaria el stock de OTRO producto (el SELECT sanea con
  // replace(/\D/g,'')) y lo devolveria como si fuera este.
  const reservas = [reservaPesable({ id: 101, pluCarga: '40222',
                                     lineas: [{ plu: '503-33', nombre: 'raro', cantidad: 5 }] })];

  // Act
  const filas = filasSaldoMayorista(reservas, [], new Map([['503-33', 5], ['40222', 3]]));

  // Assert
  assert.deepStrictEqual(filas.map(f => f.plu), ['40222']);
});

test('una reserva anulada no aporta nada', () => {
  // Arrange
  const filas = filasSaldoMayorista([reservaPesable({ id: 101, estado: 'anulada' })], [],
                                    new Map([['50333', 15]]));

  // Assert
  assert.deepStrictEqual(filas, []);
});

test('un producto de carga con saldo negativo propone reponer', () => {
  // Arrange: se facturaron mas unidades de las que habia y el deposito quedo en -2.
  const filas = filasSaldoMayorista([reservaPesable({ id: 101 })], [],
                                    new Map([['50333', 15], ['40222', -2]]));

  // Assert: faltan las 3 comprometidas mas las 2 que ya estan en negativo.
  const p = filas.find(f => f.plu === '40222');
  assert.deepStrictEqual(p.ajuste, { tipo: 'reponer-pedido', plu: '40222', cantidad: 5,
                                     sentido: 'principal-a-reserva' });
});

// El PLU pelado no le dice nada al operador: la fila lleva el nombre del producto, que ya esta
// en la reserva (la linea de granel para el granel, nombreCarga para el "X Pedido").
test('la fila del granel trae el nombre de la linea de la reserva', () => {
  // Arrange / Act
  const filas = filasSaldoMayorista([reservaPesable({ id: 101 })], [], new Map([['50333', 15]]));

  // Assert
  assert.strictEqual(filas.find(f => f.plu === '50333').nombre, 'Almendras Granel');
});

test('la fila del pedido trae el nombreCarga de la reserva', () => {
  // Arrange / Act
  const filas = filasSaldoMayorista([reservaPesable({ id: 101 })], [], new Map([['40222', 3]]));

  // Assert
  assert.strictEqual(filas.find(f => f.plu === '40222').nombre, 'Almendras Pedido');
});

test('sin nombre en la reserva la fila queda con el string vacio, no con undefined', () => {
  // Arrange: una reserva vieja guardada antes de que se guardaran los nombres.
  const reservas = [reservaPesable({ id: 101, nombreCarga: null,
                                     lineas: [{ plu: '50333', cantidad: 15 }] })];

  // Act
  const filas = filasSaldoMayorista(reservas, [], new Map([['50333', 15], ['40222', 3]]));

  // Assert
  assert.deepStrictEqual(filas.map(f => f.nombre), ['', '']);
});

// ── Los tipos de ajuste viven en tres lugares y tienen que coincidir ──────────
// 1. ajustePropuesto (modulo puro) los EMITE.
// 2. El POST /api/mayoristas/reservas/ajuste (rutas_mayoristas.js) los ACEPTA.
// 3. AJUSTE_TXT (pedidos_web.html) los ETIQUETA.
// Nada los mantenia sincronizados y por eso el plan traia el front etiquetando por tipo con un
// ternario de dos ramas: cuando aparecio un cuarto tipo, `reponer-granel` decia "Devolver" y
// mandaba al operador a mover el stock en la direccion contraria. Estos chequeos son baratos y
// agarran el desfase la proxima vez.
const fs = require('node:fs');
const path = require('node:path');
const raiz = path.join(__dirname, '..');

// Los tipos que ajustePropuesto puede devolver, sacados de la funcion misma en vez de escritos a
// mano: una lista copiada se desactualiza igual que el ternario que esto reemplaza.
const TIPOS_EMITIDOS = [
  ajustePropuesto({ saldoGranel:  1, pluGranel: 'g' }).tipo,
  ajustePropuesto({ saldoGranel: -1, pluGranel: 'g' }).tipo,
  ajustePropuesto({ saldoPedido:  1, pluCarga:  'c' }).tipo,
  ajustePropuesto({ saldoPedido: -1, pluCarga:  'c' }).tipo,
];

test('ajustePropuesto emite cuatro tipos distintos', () => {
  // Arrange / Act / Assert
  assert.deepStrictEqual([...new Set(TIPOS_EMITIDOS)].sort(),
    ['devolver-granel', 'devolver-pedido', 'reponer-granel', 'reponer-pedido']);
});

test('el endpoint de ajuste acepta todos los tipos que se emiten', () => {
  // Arrange: la lista blanca del POST, leida del fuente.
  const src = fs.readFileSync(path.join(raiz, 'rutas_mayoristas.js'), 'utf8');
  const m = src.match(/const TIPOS = \[([^\]]+)\]/);
  assert.ok(m, 'no se encontro la lista TIPOS en el endpoint de ajuste');
  const aceptados = m[1].match(/'[^']+'/g).map(s => s.slice(1, -1));

  // Assert: un tipo emitido y no aceptado da un boton que el servidor rechaza con 400.
  for (const t of TIPOS_EMITIDOS) assert.ok(aceptados.includes(t), `el endpoint no acepta "${t}"`);
});

test('la pantalla sabe etiquetar todos los tipos que se emiten', () => {
  // Arrange: las claves de AJUSTE_TXT, leidas del fuente de la pantalla.
  const html = fs.readFileSync(path.join(raiz, 'public', 'pedidos_web.html'), 'utf8');
  const m = html.match(/var AJUSTE_TXT = \{([\s\S]*?)\n\};/);
  assert.ok(m, 'no se encontro AJUSTE_TXT en pedidos_web.html');
  const etiquetados = (m[1].match(/'[a-z-]+':\s*\{/g) || []).map(s => s.split("'")[1]);

  // Assert: sin etiqueta el boton sale con el verbo generico y no dice hacia donde mueve.
  for (const t of TIPOS_EMITIDOS) assert.ok(etiquetados.includes(t), `la pantalla no etiqueta "${t}"`);
});

test('el verbo de cada tipo coincide con el sentido del traslado', () => {
  // Arrange
  const html = fs.readFileSync(path.join(raiz, 'public', 'pedidos_web.html'), 'utf8');
  const bloque = html.match(/var AJUSTE_TXT = \{([\s\S]*?)\n\};/)[1];

  // Act / Assert: "reponer-*" tiene que decir Reponer y "devolver-*", Devolver. Etiquetar con un
  // ternario de dos ramas es exactamente como se rompio la primera vez.
  for (const t of TIPOS_EMITIDOS) {
    const fila = bloque.split('\n').find(l => l.includes(`'${t}'`));
    const esperado = t.startsWith('reponer') ? 'Reponer' : 'Devolver';
    assert.ok(fila && fila.includes(`verbo: '${esperado}'`), `"${t}" no dice "${esperado}"`);
  }
});


// ── Que se aparta por cada producto del resumen (pedidos_web.html) ────────────────
// La decision vive inline en el HTML (no hay modulo que requerir), asi que se extrae por
// nombre y se evalua sola, igual que en test/distribucion_formula_granel.test.js.
//
// Lo que se estaba escapando: un producto de rubro "Pesables Fraccionado" ("Trigo Sarraceno
// 1Kg") baja a granel SIN pasar por un intermedio "X Pedido", asi que se quedaba sin producto
// de carga, no calificaba como pesable y la reserva apartaba el terminado — que la sala
// todavia no habia fraccionado. Ahora los rubros pesables apartan el granel siempre, y el
// producto de carga cae en el producto mismo cuando no hay intermedio.

function cargarApartado() {
  const html = fs.readFileSync(path.join(raiz, 'public', 'pedidos_web.html'), 'utf8');
  const ini = html.indexOf('function apartadoDeProducto(');
  assert.notStrictEqual(ini, -1, 'no se encontro apartadoDeProducto en pedidos_web.html');
  let nivel = 0, visto = false, i;
  for (i = ini; i < html.length; i++) {
    if (html[i] === '{') { nivel++; visto = true; }
    else if (html[i] === '}') { nivel--; if (visto && nivel === 0) break; }
  }
  assert.ok(visto && nivel === 0, 'no se pudo cerrar apartadoDeProducto');
  return new Function('return ' + html.slice(ini, i + 1))();
}

test('un pesable fraccionado sin intermedio aparta el granel y se carga contra si mismo', () => {
  // Arrange: "Trigo Sarraceno 1Kg", rubro Pesables Fraccionado, formula directa al granel.
  const apartadoDeProducto = cargarApartado();

  // Act
  const r = apartadoDeProducto({
    IdProducto: '5012', NombreProducto: 'Trigo Sarraceno 1Kg',
    NombreRubro: 'Pesables Fraccionado',
    GranelPlu: '7050', GranelNombre: 'Trigo Sarraceno DEPOSITO GRANEL',
    KgPorUnidad: 1, GranelCount: 1,
  }, null);

  // Assert: pesable, contra el granel, con el producto del pedido como producto de carga.
  assert.strictEqual(r.esPesable, true);
  assert.strictEqual(r.pluCarga, '5012');
  assert.strictEqual(r.nombreCarga, 'Trigo Sarraceno 1Kg');
  assert.strictEqual(r.kgPorUnidad, 1);
  assert.strictEqual(r.sinFormula, false);
  // Y la linea que sale hacia SiGA aparta kg de granel, no unidades del terminado.
  assert.deepStrictEqual(
    lineaAApartar({ esPesable: r.esPesable, pluGranel: '7050', nombreGranel: 'Trigo Sarraceno DEPOSITO GRANEL',
                    kgPorUnidad: r.kgPorUnidad, unidades: 12 }),
    { plu: '7050', nombre: 'Trigo Sarraceno DEPOSITO GRANEL', cantidad: 12 });
});

test('un pesable de venta directa con intermedio sigue cargando contra el "X Pedido"', () => {
  // Arrange: el fallback no puede pisar el intermedio cuando /api/resumen si lo resolvio.
  const apartadoDeProducto = cargarApartado();

  // Act
  const r = apartadoDeProducto({
    IdProducto: '3011', NombreProducto: 'Azucar Impalpable 5Kg',
    NombreRubro: 'Pesables Venta Directa',
    CargaPlu: '4022', CargaNombre: 'Azucar Impalpable PEDIDOS',
    GranelPlu: '7001', KgPorUnidad: 5, GranelCount: 1,
  }, null);

  // Assert
  assert.strictEqual(r.esPesable, true);
  assert.strictEqual(r.pluCarga, '4022');
  assert.strictEqual(r.nombreCarga, 'Azucar Impalpable PEDIDOS');
});

test('un pesable sin granel se reserva por su mismo codigo, en unidades', () => {
  // Arrange: sin granel no hay nada que descomponer.
  const apartadoDeProducto = cargarApartado();

  // Act
  const r = apartadoDeProducto({
    IdProducto: '5099', NombreProducto: 'Mix Raro 1Kg',
    NombreRubro: 'Pesables Fraccionado', GranelCount: 1,
  }, null);

  // Assert: por su codigo, no pesable y con el boton habilitado.
  assert.strictEqual(r.esPesable, false);
  assert.strictEqual(r.pluRes, '5099');
  assert.strictEqual(r.pluCarga, '');
  assert.strictEqual(r.sinFormula, false);
});

test('un pesable con varios graneles es una receta y se reserva por su mismo codigo', () => {
  // Arrange: 7477 "G. Crunch" tiene 17 graneles; apartar el mas pesado seria reservar avena.
  const apartadoDeProducto = cargarApartado();

  // Act
  const r = apartadoDeProducto({
    IdProducto: '7477', NombreProducto: 'G. Crunch 1Kg',
    NombreRubro: 'Pesables Fraccionado',
    GranelPlu: '7020', KgPorUnidad: 0.5, GranelCount: 17,
  }, null);

  // Assert
  assert.strictEqual(r.esPesable, false);
  assert.strictEqual(r.pluRes, '7477');
});

test('un Almacen Bulto/Caja sigue reservando su componente de formula, en unidades', () => {
  // Arrange: el camino historico no se toca.
  const apartadoDeProducto = cargarApartado();

  // Act
  const r = apartadoDeProducto({
    IdProducto: '9001', NombreProducto: 'Fideos Bulto', NombreRubro: 'Almacen Bultos',
    IdComponente: '9002', GranelCount: 1,
  }, 'Fideos Paquete');

  // Assert
  assert.strictEqual(r.esPesable, false);
  assert.strictEqual(r.pluRes, '9002');
  assert.strictEqual(r.nombreRes, 'Fideos Paquete');
  assert.strictEqual(r.sinFormula, false);
});

test('un Bulto sin componente queda inerte con su motivo', () => {
  // Arrange: no hay stock que apartar, el SQL le da 0.
  const apartadoDeProducto = cargarApartado();

  // Act
  const r = apartadoDeProducto({
    IdProducto: '9500', NombreProducto: 'Cosa Bulto', NombreRubro: 'Almacen Bultos', GranelCount: 1,
  }, null);

  // Assert
  assert.strictEqual(r.sinFormula, true);
  assert.match(r.motivoInerte, /no hay nada que apartar/);
});

// ── Como se lee cada linea en el carrito y en el modal (pedidos_web.html) ───────────
// El modal de confirmacion listaba `l.nombre`, que es LO APARTADO (el componente de formula en
// un Almacen Bulto/Caja, el producto mismo en un pesable) y no el producto del pedido: el
// operador leia nombres que no eran los que habia agregado. Ahora los dos usan la misma
// descripcion, con el producto del pedido arriba y lo que se aparta abajo.

function cargarDescripcion() {
  const html = fs.readFileSync(path.join(raiz, 'public', 'pedidos_web.html'), 'utf8');
  const src = ['descripcionLineaRes', 'unidadLineaRes'].map(nombre => {
    const ini = html.indexOf(`function ${nombre}(`);
    assert.notStrictEqual(ini, -1, `no se encontro ${nombre} en pedidos_web.html`);
    let nivel = 0, visto = false, i;
    for (i = ini; i < html.length; i++) {
      if (html[i] === '{') { nivel++; visto = true; }
      else if (html[i] === '}') { nivel--; if (visto && nivel === 0) break; }
    }
    assert.ok(visto && nivel === 0, `no se pudo cerrar ${nombre}`);
    return html.slice(ini, i + 1);
  }).join('\n');
  // numFmt es del navegador; se le pasa uno equivalente para poder evaluar la funcion sola.
  return new Function(`
    const numFmt = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 });
    ${src}
    return { descripcionLineaRes, unidadLineaRes };
  `)();
}

test('un pesable se describe con el producto del pedido arriba y el granel abajo', () => {
  // Arrange
  const { descripcionLineaRes, unidadLineaRes } = cargarDescripcion();
  const linea = { pluPedido: '5012', nombrePedido: 'Trigo Sarraceno 1Kg',
                  plu: '5012', nombre: 'Trigo Sarraceno 1Kg', esPesable: true,
                  nombreGranel: 'Trigo Sarraceno DEPOSITO GRANEL', cantidad: 12, mult: 1 };

  // Act
  const d = descripcionLineaRes(linea);

  // Assert: el titulo es lo que el cliente pidio, no el granel.
  assert.strictEqual(d.titulo, 'Trigo Sarraceno 1Kg');
  assert.strictEqual(d.sub, 'reserva: Trigo Sarraceno DEPOSITO GRANEL · en kg');
  assert.strictEqual(unidadLineaRes(linea), ' kg');
});

test('un Almacen Bulto/Caja muestra el pedido arriba y su componente abajo', () => {
  // Arrange: sin esto el modal mostraba solo "Fideos Paquete", que no es lo que se agrego.
  const { descripcionLineaRes, unidadLineaRes } = cargarDescripcion();
  const linea = { pluPedido: '9001', nombrePedido: 'Fideos Bulto',
                  plu: '9002', nombre: 'Fideos Paquete', mult: 12, cantidad: 24 };

  // Act
  const d = descripcionLineaRes(linea);

  // Assert
  assert.strictEqual(d.titulo, 'Fideos Bulto');
  assert.strictEqual(d.sub, 'reserva: Fideos Paquete (×12)');
  assert.strictEqual(unidadLineaRes(linea), ' u.');
});

test('un producto que se aparta por su mismo codigo muestra el PLU', () => {
  // Arrange
  const { descripcionLineaRes } = cargarDescripcion();

  // Act
  const d = descripcionLineaRes({ pluPedido: '4100', nombrePedido: 'Yerba 1Kg',
                                  plu: '4100', nombre: 'Yerba 1Kg', mult: 1, cantidad: 6 });

  // Assert
  assert.strictEqual(d.titulo, 'Yerba 1Kg');
  assert.strictEqual(d.sub, 'PLU 4100');
});
