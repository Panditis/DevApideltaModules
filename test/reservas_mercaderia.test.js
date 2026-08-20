const test = require('node:test');
const assert = require('node:assert');
const { validarLineasReserva, normalizarLineasReserva, totalesReserva }
  = require('../reservas_mercaderia');

// ── Reservas de mercaderia mayorista: validacion y normalizacion ──────────────────────────────
// Las lineas llegan del body del POST de /api/mayoristas/reservas. Son productos TERMINADOS
// (no se explota formula): plu, nombre y la cantidad que se aparta en el deposito de reserva.

function linea(extra) {
  return { plu: '30000', nombre: 'Mix Europeo 200G Unidad Bulto', cantidad: 10, ...extra };
}

test('rechaza un carrito sin lineas', () => {
  // Arrange / Act
  const error = validarLineasReserva([]);

  // Assert
  assert.strictEqual(error, 'La reserva no tiene lineas');
});

test('rechaza una linea sin plu', () => {
  // Arrange
  const lineas = [linea({ plu: '' })];

  // Act
  const error = validarLineasReserva(lineas);

  // Assert
  assert.match(error, /plu/i);
});

test('rechaza cantidades no numericas, negativas o cero', () => {
  // Arrange
  const casos = [{ cantidad: 'diez' }, { cantidad: -5 }, { cantidad: 0 }, { cantidad: null }];

  // Act / Assert
  for (const caso of casos) {
    const error = validarLineasReserva([linea(caso)]);
    assert.match(error, /cantidad/i, `deberia rechazar cantidad ${caso.cantidad}`);
  }
});

test('acepta un carrito valido', () => {
  // Arrange / Act
  const error = validarLineasReserva([linea()]);

  // Assert
  assert.strictEqual(error, null);
});

test('consolida el mismo plu repetido sumando las cantidades', () => {
  // Arrange: el mismo producto puede entrar dos veces si el cliente lo pidio en dos pedidos.
  const lineas = [linea({ cantidad: 10 }), linea({ cantidad: 4 })];

  // Act
  const normalizadas = normalizarLineasReserva(lineas);

  // Assert
  assert.strictEqual(normalizadas.length, 1);
  assert.strictEqual(normalizadas[0].cantidad, 14);
});

test('la normalizacion recorta el plu y el nombre y deja la cantidad numerica', () => {
  // Arrange
  const lineas = [{ plu: ' 30000 ', nombre: '  Mix Europeo  ', cantidad: '7' }];

  // Act
  const [salida] = normalizarLineasReserva(lineas);

  // Assert
  assert.deepStrictEqual(salida, { plu: '30000', nombre: 'Mix Europeo', cantidad: 7 });
});

test('los totales cuentan lineas y unidades', () => {
  // Arrange
  const lineas = normalizarLineasReserva([linea({ cantidad: 10 }), linea({ plu: '30001', cantidad: 5 })]);

  // Act
  const totales = totalesReserva(lineas);

  // Assert
  assert.deepStrictEqual(totales, { lineas: 2, unidades: 15 });
});

const { validarClienteReserva, validarCarritoUnCliente, plusReservadosDeCliente,
        validarPlusNoReservados, reservasActivasResumen }
  = require('../reservas_mercaderia');

// ── Un cliente por reserva ────────────────────────────────────────────────────────────────────
// El carrito es mono-cliente a proposito: un cliente por vez es un movimiento de SiGA por vez,
// asi no existe la falla parcial (que la mitad de los clientes queden reservados y la otra no).

test('rechaza una reserva sin cliente', () => {
  // Arrange / Act
  const error = validarClienteReserva('', 'Dietetica San Martin');

  // Assert
  assert.match(error, /cliente/i);
});

test('rechaza una reserva sin nombre de cliente', () => {
  // Arrange / Act
  const error = validarClienteReserva(412, '   ');

  // Assert
  assert.match(error, /cliente/i);
});

test('acepta un cliente valido', () => {
  // Arrange / Act
  const error = validarClienteReserva(412, 'Dietetica San Martin');

  // Assert
  assert.strictEqual(error, null);
});

test('rechaza un carrito con lineas de dos clientes distintos', () => {
  // Arrange: las lineas pueden traer idCliente propio (lo pone el boton del Resumen por cliente).
  const lineas = [linea({ idCliente: 412 }), linea({ plu: '30001', idCliente: 999 })];

  // Act
  const error = validarCarritoUnCliente(lineas, 412);

  // Assert
  assert.match(error, /mismo cliente/i);
});

test('acepta un carrito donde todas las lineas son del cliente de la reserva', () => {
  // Arrange
  const lineas = [linea({ idCliente: 412 }), linea({ plu: '30001', idCliente: '412' })];

  // Act
  const error = validarCarritoUnCliente(lineas, 412);

  // Assert
  assert.strictEqual(error, null);
});

test('una linea sin idCliente se acepta: el cliente lo pone el body', () => {
  // Arrange
  const lineas = [linea()];

  // Act
  const error = validarCarritoUnCliente(lineas, 412);

  // Assert
  assert.strictEqual(error, null);
});

// ── PLU ya reservados ─────────────────────────────────────────────────────────────────────────
// Sin esta guarda, dos pestanas abiertas reservan lo mismo dos veces y sale mercaderia de mas
// del deposito principal.

function reservaActiva(extra) {
  return {
    id: 1, estado: 'activa', idCliente: 412, nombreCliente: 'Dietetica San Martin',
    lineas: [{ plu: '30000', nombre: 'Mix Europeo 200G', cantidad: 10 }],
    anulacion: null, ...extra,
  };
}

test('lista los plu con reserva activa de un cliente', () => {
  // Arrange
  const reservas = [reservaActiva()];

  // Act
  const plus = plusReservadosDeCliente(reservas, 412);

  // Assert
  assert.deepStrictEqual([...plus], ['30000']);
});

test('las reservas anuladas no cuentan como plu reservado', () => {
  // Arrange
  const reservas = [reservaActiva({ estado: 'anulada' })];

  // Act
  const plus = plusReservadosDeCliente(reservas, 412);

  // Assert
  assert.strictEqual(plus.size, 0);
});

test('la reserva de otro cliente no bloquea el plu', () => {
  // Arrange
  const reservas = [reservaActiva({ idCliente: 999 })];

  // Act
  const plus = plusReservadosDeCliente(reservas, 412);

  // Assert
  assert.strictEqual(plus.size, 0);
});

test('rechaza reservar un plu que el cliente ya tiene reservado', () => {
  // Arrange
  const reservas = [reservaActiva()];

  // Act
  const error = validarPlusNoReservados([linea()], reservas, 412);

  // Assert
  assert.match(error, /30000/);
});

test('deja reservar un plu nuevo aunque el cliente tenga otras reservas activas', () => {
  // Arrange
  const reservas = [reservaActiva()];

  // Act
  const error = validarPlusNoReservados([linea({ plu: '30001' })], reservas, 412);

  // Assert
  assert.strictEqual(error, null);
});

test('el resumen de activas agrupa los plu por cliente', () => {
  // Arrange
  const reservas = [
    reservaActiva(),
    reservaActiva({ id: 2, idCliente: 999, lineas: [{ plu: '30001', nombre: 'Otro', cantidad: 3 }] }),
    reservaActiva({ id: 3, estado: 'anulada', lineas: [{ plu: '30002', nombre: 'Anulado', cantidad: 1 }] }),
  ];

  // Act
  const resumen = reservasActivasResumen(reservas);

  // Assert
  assert.deepStrictEqual(resumen, { 412: ['30000'], 999: ['30001'] });
});

const { nuevaReserva, anularReserva } = require('../reservas_mercaderia');

// ── Armado y anulacion ────────────────────────────────────────────────────────────────────────
// La reserva se arma DESPUES de que SiGA confirmo el movimiento: el numero de comprobante es
// parte de la identidad de la reserva, no un campo que se completa despues.

test('arma la reserva con el comprobante de siga y sus totales', () => {
  // Arrange
  const lineas = normalizarLineasReserva([linea({ cantidad: 10 })]);

  // Act
  const reserva = nuevaReserva({
    id: 1700000000000, fecha: '2026-08-20T14:30:00.000Z',
    idCliente: 412, nombreCliente: 'Dietetica San Martin',
    idSucursal: 1, depOrigen: 1, depDestino: 7,
    numeroMovimiento: 88123, idRegistro: 45, usuario: 'Adriel', lineas,
  });

  // Assert
  assert.strictEqual(reserva.estado, 'activa');
  assert.strictEqual(reserva.numeroMovimiento, 88123);
  assert.strictEqual(reserva.anulacion, null);
  assert.deepStrictEqual(reserva.totales, { lineas: 1, unidades: 10 });
});

test('anular una reserva activa la deja anulada con su comprobante inverso', () => {
  // Arrange
  const reserva = nuevaReserva({
    id: 1, fecha: '2026-08-20T14:30:00.000Z', idCliente: 412, nombreCliente: 'Dietetica',
    idSucursal: 1, depOrigen: 1, depDestino: 7, numeroMovimiento: 88123, idRegistro: 45,
    usuario: 'Adriel', lineas: normalizarLineasReserva([linea()]),
  });

  // Act
  const { reserva: anulada, error } = anularReserva(reserva, {
    numeroMovimiento: 88200, idRegistro: 46, fecha: '2026-08-20T18:00:00.000Z',
  });

  // Assert
  assert.strictEqual(error, undefined);
  assert.strictEqual(anulada.estado, 'anulada');
  assert.deepStrictEqual(anulada.anulacion,
    { numeroMovimiento: 88200, idRegistro: 46, fecha: '2026-08-20T18:00:00.000Z' });
});

test('anular no muta la reserva original', () => {
  // Arrange
  const reserva = reservaActiva();

  // Act
  anularReserva(reserva, { numeroMovimiento: 88200, idRegistro: 46, fecha: 'x' });

  // Assert
  assert.strictEqual(reserva.estado, 'activa');
});

test('anular dos veces falla', () => {
  // Arrange
  const { reserva: anulada } = anularReserva(reservaActiva(),
    { numeroMovimiento: 88200, idRegistro: 46, fecha: 'x' });

  // Act
  const { error } = anularReserva(anulada, { numeroMovimiento: 88300, idRegistro: 47, fecha: 'y' });

  // Assert
  assert.match(error, /anulada/i);
});
