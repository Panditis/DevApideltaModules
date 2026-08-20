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
