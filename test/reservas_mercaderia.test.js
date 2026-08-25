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

test('dos registros del mismo plu quedan como lineas separadas', () => {
  // Arrange: el mismo producto puede entrar dos veces, por dos pedidos distintos del mismo
  // cliente. Cada registro seleccionado sale con su propio movimiento de SiGA, asi que NO se
  // consolidan: sumarlos perderia la trazabilidad de cual registro origino cual comprobante.
  const lineas = [linea({ cantidad: 10, pluPedido: '40010' }), linea({ cantidad: 4, pluPedido: '40011' })];

  // Act
  const normalizadas = normalizarLineasReserva(lineas);

  // Assert
  assert.strictEqual(normalizadas.length, 2);
  assert.deepStrictEqual(normalizadas.map(l => l.cantidad), [10, 4]);
  assert.deepStrictEqual(normalizadas.map(l => l.pluPedido), ['40010', '40011']);
});

test('la normalizacion recorta el plu y el nombre y deja la cantidad numerica', () => {
  // Arrange
  const lineas = [{ plu: ' 30000 ', nombre: '  Mix Europeo  ', cantidad: '7' }];

  // Act
  const [salida] = normalizarLineasReserva(lineas);

  // Assert: sin pluPedido se asume que el producto del pedido es el mismo que se aparta.
  assert.deepStrictEqual(salida,
    { plu: '30000', nombre: 'Mix Europeo', cantidad: 7, pluPedido: '30000', nombrePedido: 'Mix Europeo' });
});

test('la linea guarda el producto del pedido y el que se aparta por separado', () => {
  // Arrange: un Almacen Bulto/Caja aparta su componente de formula, no el producto del pedido.
  const lineas = [{ plu: '1024', nombre: 'Yerba Apidelta 1Kg', cantidad: 60,
                    pluPedido: '40010', nombrePedido: 'Yerba Apidelta 1Kg Bulto X12' }];

  // Act
  const [salida] = normalizarLineasReserva(lineas);

  // Assert
  assert.strictEqual(salida.plu, '1024');
  assert.strictEqual(salida.cantidad, 60);
  assert.strictEqual(salida.pluPedido, '40010');
  assert.strictEqual(salida.nombrePedido, 'Yerba Apidelta 1Kg Bulto X12');
});

test('los totales cuentan lineas y unidades', () => {
  // Arrange
  const lineas = normalizarLineasReserva([linea({ cantidad: 10 }), linea({ plu: '30001', cantidad: 5 })]);

  // Act
  const totales = totalesReserva(lineas);

  // Assert
  assert.deepStrictEqual(totales, { lineas: 2, unidades: 15 });
});

const { validarClienteReserva, validarCarritoUnCliente } = require('../reservas_mercaderia');

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

function reservaActiva(extra) {
  return {
    id: 1, estado: 'activa', idCliente: 412, nombreCliente: 'Dietetica San Martin',
    lineas: [{ plu: '30000', nombre: 'Mix Europeo 200G', cantidad: 10 }],
    anulacion: null, ...extra,
  };
}







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
