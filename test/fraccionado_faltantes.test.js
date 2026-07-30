const test = require('node:test');
const assert = require('node:assert');
const { calcularFaltantesFraccionado } = require('../fraccionado_faltantes');

// ── Faltantes fraccionables: qué productos hay que fraccionar y cuánto ────────────────────────
// `pendientes` simula lo que sale de agregar getResumen() por PLU (pendiente + stock de la
// presentación + desglose de clientes). `bomGranel` simula sqlBOMGranel() ya mapeado por PLU.
// `stockGranel` simula el stock de los depósitos GRANEL de la central, por PLU de granel.

test('faltante simple: pendiente mayor al stock y granel de sobra', () => {
  // Arrange
  const pendientes = [{
    plu: '4467', nombre: 'Nuez Mariposa 200G', pendiente: 200, stockCentral: 80,
    clientes: [{ idCliente: 9, nombre: 'Cliente X', pendiente: 200 }],
  }];
  const bomGranel = new Map([
    ['4467', { granelPlu: '7333', granelNombre: 'Nuez Mariposa GRANEL', cantPorUnidad: 0.2 }],
  ]);
  const stockGranel = new Map([['7333', 100]]);

  // Act
  const filas = calcularFaltantesFraccionado(pendientes, bomGranel, stockGranel);

  // Assert
  assert.strictEqual(filas.length, 1);
  assert.strictEqual(filas[0].faltante, 120);
  assert.strictEqual(filas[0].sugerido, 120);
  assert.strictEqual(filas[0].cubre, true);
  assert.strictEqual(filas[0].granelNecesario, 24);
  assert.strictEqual(filas[0].granelStock, 100);
  assert.strictEqual(filas[0].granelNombre, 'Nuez Mariposa GRANEL');
  assert.deepStrictEqual(filas[0].clientes, [{ idCliente: 9, nombre: 'Cliente X', pendiente: 200 }]);
});

test('granel insuficiente: sugerido se recorta al maximo que el granel banca', () => {
  // Arrange: faltan 120 unidades a 0.2kg = 24kg, pero solo hay 10kg → 50 unidades.
  const pendientes = [{
    plu: '4467', nombre: 'Nuez Mariposa 200G', pendiente: 200, stockCentral: 80, clientes: [],
  }];
  const bomGranel = new Map([
    ['4467', { granelPlu: '7333', granelNombre: 'Nuez Mariposa GRANEL', cantPorUnidad: 0.2 }],
  ]);
  const stockGranel = new Map([['7333', 10]]);

  // Act
  const filas = calcularFaltantesFraccionado(pendientes, bomGranel, stockGranel);

  // Assert
  assert.strictEqual(filas[0].faltante, 120);
  assert.strictEqual(filas[0].sugerido, 50);
  assert.strictEqual(filas[0].cubre, false);
  assert.strictEqual(filas[0].granelNecesario, 10);
});

test('granel en cero: sugerido cero y cubre false, la fila no desaparece', () => {
  // Arrange: la fila tiene que verse igual, con la alerta, para que el operador sepa que falta granel.
  const pendientes = [{ plu: '4467', nombre: 'Nuez Mariposa 200G', pendiente: 200, stockCentral: 80, clientes: [] }];
  const bomGranel = new Map([['4467', { granelPlu: '7333', granelNombre: 'Nuez GRANEL', cantPorUnidad: 0.2 }]]);
  const stockGranel = new Map([['7333', 0]]);

  // Act
  const filas = calcularFaltantesFraccionado(pendientes, bomGranel, stockGranel);

  // Assert
  assert.strictEqual(filas.length, 1);
  assert.strictEqual(filas[0].sugerido, 0);
  assert.strictEqual(filas[0].cubre, false);
  assert.strictEqual(filas[0].granelNecesario, 0);
});
