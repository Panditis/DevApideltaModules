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
