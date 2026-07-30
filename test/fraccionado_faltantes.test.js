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

test('granel compartido: el segundo producto solo recibe el saldo', () => {
  // Arrange: dos presentaciones del mismo granel, 30kg en total. Se sirve primero el de mayor
  // faltante: 200G toma 100 un. × 0.2 = 20kg; a 500G le quedan 10kg / 0.5 = 20 unidades de 60.
  const pendientes = [
    { plu: '4468', nombre: 'Nuez Mariposa 500G', pendiente: 60, stockCentral: 0, clientes: [] },
    { plu: '4467', nombre: 'Nuez Mariposa 200G', pendiente: 100, stockCentral: 0, clientes: [] },
  ];
  const bomGranel = new Map([
    ['4467', { granelPlu: '7333', granelNombre: 'Nuez GRANEL', cantPorUnidad: 0.2 }],
    ['4468', { granelPlu: '7333', granelNombre: 'Nuez GRANEL', cantPorUnidad: 0.5 }],
  ]);
  const stockGranel = new Map([['7333', 30]]);

  // Act
  const filas = calcularFaltantesFraccionado(pendientes, bomGranel, stockGranel);

  // Assert: orden por faltante descendente → 4467 (100) primero, 4468 (60) después.
  assert.deepStrictEqual(filas.map(f => f.plu), ['4467', '4468']);
  assert.strictEqual(filas[0].sugerido, 100);          // consume 20kg
  assert.strictEqual(filas[0].granelNecesario, 20);
  assert.strictEqual(filas[1].sugerido, 20);           // le quedan 10kg / 0.5 = 20
  assert.strictEqual(filas[1].granelNecesario, 10);
  assert.strictEqual(filas[1].cubre, false);
  const kgTotal = filas.reduce((s, f) => s + f.granelNecesario, 0);
  assert.ok(kgTotal <= 30, `los kg comprometidos (${kgTotal}) no pueden superar el stock de granel`);
});

test('empate de faltante: desempata por plu ascendente, salida determinista', () => {
  // Arrange: mismo faltante, granel justo para uno solo.
  const pendientes = [
    { plu: '900', nombre: 'B', pendiente: 10, stockCentral: 0, clientes: [] },
    { plu: '100', nombre: 'A', pendiente: 10, stockCentral: 0, clientes: [] },
  ];
  const bomGranel = new Map([
    ['100', { granelPlu: '7333', granelNombre: 'G', cantPorUnidad: 1 }],
    ['900', { granelPlu: '7333', granelNombre: 'G', cantPorUnidad: 1 }],
  ]);
  const stockGranel = new Map([['7333', 10]]);

  // Act
  const filas = calcularFaltantesFraccionado(pendientes, bomGranel, stockGranel);

  // Assert
  assert.deepStrictEqual(filas.map(f => f.plu), ['100', '900']);
  assert.strictEqual(filas[0].sugerido, 10);
  assert.strictEqual(filas[1].sugerido, 0);
});

test('no muta las entradas', () => {
  // Arrange
  const pendientes = [{ plu: '4467', nombre: 'N', pendiente: 200, stockCentral: 80, clientes: [{ idCliente: 9, nombre: 'X', pendiente: 200 }] }];
  const bomGranel = new Map([['4467', { granelPlu: '7333', granelNombre: 'G', cantPorUnidad: 0.2 }]]);
  const stockGranel = new Map([['7333', 100]]);

  // Act
  calcularFaltantesFraccionado(pendientes, bomGranel, stockGranel);

  // Assert
  assert.strictEqual(stockGranel.get('7333'), 100);
  assert.strictEqual(pendientes[0].pendiente, 200);
  assert.deepStrictEqual(pendientes[0].clientes, [{ idCliente: 9, nombre: 'X', pendiente: 200 }]);
});
