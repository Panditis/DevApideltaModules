'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { calcularFilaAlmacen } = require('../routes/rutas_precios');

const CFG_BASE = {
  toleranciaPct: 10,
  costosVariosPctAlmacen: 3,
  bandasMarkup: { almacen: [
    { costoHastaARS: 1000, markupMaxPct: 40 },
    { costoHastaARS: null, markupMaxPct: 15 },
  ] },
  margenPorProducto: {},
};

// ── calcularFilaAlmacen ──────────────────────────────────────────────────────
// Pura: sin SQL, sin fs. Cubre lo que listado/detalle arman a partir de las dos
// queries (costo de mercadería + precio vigente) ya resueltas.

test('calcularFilaAlmacen: banda por costo + IVA, comparado contra precio vigente en semáforo verde', () => {
  const fila = calcularFilaAlmacen({
    plu: '1', nombre: 'Arroz', costoMercaderia: 500, precioVigente: 500,
    costeoConfig: CFG_BASE,
  });
  // costoTotal = 500 * 1.03 = 515, precioNeto = 515*1.4 = 721, precioConIva = 721*1.21 = 872.41
  assert.strictEqual(fila.costoTotal, 515);
  assert.strictEqual(fila.markupPct, 40);
  assert.strictEqual(fila.banda, 'hasta 1000');
  assert.strictEqual(fila.precioNeto, 721);
  assert.strictEqual(fila.precioConIva, 872.41);
  assert.strictEqual(fila.precioVigente, 500);
  assert.deepStrictEqual(fila.faltantes, []);
  // precioVigente (500) muy por debajo de precioConIva (872.41): delta fuertemente negativo → verde
  assert.strictEqual(fila.semaforo, 'verde');
});

test('calcularFilaAlmacen: precioVigente alineado con precioConIva da semáforo amarillo', () => {
  const fila = calcularFilaAlmacen({
    plu: '2', nombre: 'Fideos', costoMercaderia: 500, precioVigente: 872.41,
    costeoConfig: CFG_BASE,
  });
  assert.strictEqual(fila.deltaPct, 0);
  assert.strictEqual(fila.semaforo, 'amarillo');
});

test('calcularFilaAlmacen: margenPorProducto (override) gana sobre la banda por costo', () => {
  const cfg = { ...CFG_BASE, margenPorProducto: { '3': 20 } };
  const fila = calcularFilaAlmacen({
    plu: '3', nombre: 'Yerba', costoMercaderia: 500, precioVigente: null, costeoConfig: cfg,
  });
  assert.strictEqual(fila.markupPct, 20);
  assert.strictEqual(fila.banda, 'override');
});

test('calcularFilaAlmacen: sin costoMercaderia no hay precio optimista — precios null y faltantes marcado', () => {
  const fila = calcularFilaAlmacen({
    plu: '4', nombre: 'Sin costo', costoMercaderia: null, precioVigente: 1000, costeoConfig: CFG_BASE,
  });
  assert.deepStrictEqual(fila.faltantes, ['costoMercaderia']);
  assert.strictEqual(fila.precioNeto, null);
  assert.strictEqual(fila.precioConIva, null);
  // sin costoActual válido, compararItem no puede opinar
  assert.strictEqual(fila.deltaPct, null);
  assert.strictEqual(fila.semaforo, null);
});

test('calcularFilaAlmacen: sin precioVigente (producto sin precio de mostrador) no rompe, delta/semaforo null', () => {
  const fila = calcularFilaAlmacen({
    plu: '5', nombre: 'Nuevo', costoMercaderia: 500, precioVigente: null, costeoConfig: CFG_BASE,
  });
  assert.strictEqual(fila.precioVigente, null);
  assert.strictEqual(fila.deltaPct, null);
  assert.strictEqual(fila.semaforo, null);
  // el costeo en sí no se ve afectado por la falta de precio vigente
  assert.strictEqual(fila.precioConIva, 872.41);
});
