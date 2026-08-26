const test = require('node:test');
const assert = require('node:assert');
const { kgReserva, validarLineaPesable, lineaAApartar, granelReservadoPorPlu, pedidoReservadoPorPlu } = require('../reservas_pesables');

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
const { lineasDiferenciasProduccion, lineasAjusteMovimiento, conciliarPorMovimiento, saldoLedger } = require('../reservas_movimiento');
const { partirConsumoMayorista } = require('../reservas_pesables');

const DEPS = { salida: 1, recepcion: 3, diferencias: 1, reserva: 2 };
const PLU_GRANEL = '7302';

// Neto por deposito de un dia con `plan` reservado por el plan, `may` apartado por el
// mayorista y `usado` consumido por la sala, armado con el MISMO orden que server.js.
function netoPorDeposito({ plan, may, usado }) {
  const reservas = plan > 0 ? [{ estado: 'activa', numeroMovimiento: 55, lineas: [{ plu: PLU_GRANEL, nombre: 'Granel', cantidad: plan }] }] : [];
  const componentes = [{ plu: PLU_GRANEL, nombre: 'Granel', reservado: plan + may, usado }];
  const porMovimiento = conciliarPorMovimiento(
    reservas.map(r => ({ numeroMovimiento: r.numeroMovimiento, ordenes: [], saldo: saldoLedger([r]), conciliado: false })),
    new Map([[PLU_GRANEL, usado]]));

  const { componentesPlan, lineasMayorista } = partirConsumoMayorista(
    componentes, may > 0 ? { [PLU_GRANEL]: may } : {}, DEPS.reserva);

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
  { plan: 0,  may: 5,    usado: 12, reserva: -5,  principal: -7 },
  { plan: 0,  may: 5,    usado: 3,  reserva: -3,  principal: 0  },
  { plan: 10, may: 5,    usado: 20, reserva: -15, principal: -5 },
  { plan: 10, may: 5,    usado: 12, reserva: -12, principal: 0  },
  { plan: 10, may: 5,    usado: 8,  reserva: -10, principal: 2  },
  // Sin mayorista el circuito tiene que quedar igual que antes de existir esta funcion.
  { plan: 10, may: 0,    usado: 12, reserva: -10, principal: -2 },
  { plan: 0,  may: 0,    usado: 5,  reserva: 0,   principal: -5 },
  // Mayorista mayor que lo consumido: lo que sobra se queda en el deposito de reserva.
  { plan: 0,  may: 20,   usado: 4,  reserva: -4,  principal: 0  },
  // Kilos fraccionados: el granel se aparta con decimales.
  { plan: 2.5, may: 1.25, usado: 3, reserva: -3,  principal: 0  },
];

for (const caso of TABLA) {
  test(`el consumo cae entero en un deposito (plan ${caso.plan}, mayorista ${caso.may}, usado ${caso.usado})`, () => {
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
  // Arrange: nada reservado por el plan, 5 apartados por el mayorista, la sala uso 3.
  const componentes = [{ plu: '7302', nombre: 'Granel', reservado: 5, usado: 3 }];

  // Act
  const { componentesPlan, lineasMayorista } = partirConsumoMayorista(componentes, { '7302': 5 }, 2);

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
