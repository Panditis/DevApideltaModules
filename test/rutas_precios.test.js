'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { calcularFilaAlmacen, costoSistemaSinIva, aplicarMarcados } = require('../routes/rutas_precios');

test('costoSistemaSinIva: saca el IVA con la alícuota del producto (Productos.Alicuota)', () => {
  assert.deepStrictEqual(costoSistemaSinIva(1210, 21), { costo: 1000, ivaPct: 21, ivaSupuesto: false });
  assert.deepStrictEqual(costoSistemaSinIva(1105, 10.5), { costo: 1000, ivaPct: 10.5, ivaSupuesto: false });
  // alícuota 0%: el costo de sistema ya es sin IVA
  assert.deepStrictEqual(costoSistemaSinIva(1000, 0), { costo: 1000, ivaPct: 0, ivaSupuesto: false });
});

test('costoSistemaSinIva: sin alícuota cargada en SIGA asume 21% y lo marca', () => {
  assert.deepStrictEqual(costoSistemaSinIva(1210, null), { costo: 1000, ivaPct: 21, ivaSupuesto: true });
});

test('costoSistemaSinIva: sin PrecioCosto (o 0) no hay costo de sistema', () => {
  assert.strictEqual(costoSistemaSinIva(null, 21).costo, null);
  assert.strictEqual(costoSistemaSinIva(0, 21).costo, null);
});

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

test('calcularFilaAlmacen: banda por costo + IVA; sugerido muy por encima del vigente → subir', () => {
  const fila = calcularFilaAlmacen({
    plu: '1', nombre: 'Arroz', costoSistema: 500, precioVigente: 500,
    costeoConfig: CFG_BASE,
  });
  // costoTotal = 500 * 1.03 = 515, precioNeto = 515*1.4 = 721, precioConIva = 721*1.21 = 850
  assert.strictEqual(fila.costoTotal, 515);
  assert.strictEqual(fila.markupPct, 40);
  assert.strictEqual(fila.banda, 'hasta 1000');
  assert.strictEqual(fila.precioNeto, 721);
  assert.strictEqual(fila.precioConIva, 850);
  assert.strictEqual(fila.precioVigente, 500);
  assert.deepStrictEqual(fila.faltantes, []);
  // sugerido (850) 70% por encima del vigente (500): hay que subir el precio
  assert.strictEqual(fila.deltaPct, 70);
  assert.strictEqual(fila.semaforo, 'subir');
});

test('calcularFilaAlmacen: precioVigente alineado con precioConIva da ok', () => {
  const fila = calcularFilaAlmacen({
    plu: '2', nombre: 'Fideos', costoSistema: 500, precioVigente: 850,
    costeoConfig: CFG_BASE,
  });
  assert.strictEqual(fila.deltaPct, 0);
  assert.strictEqual(fila.semaforo, 'ok');
});

test('calcularFilaAlmacen: margenPorProducto (override) gana sobre la banda por costo', () => {
  const cfg = { ...CFG_BASE, margenPorProducto: { '3': 20 } };
  const fila = calcularFilaAlmacen({
    plu: '3', nombre: 'Yerba', costoSistema: 500, precioVigente: null, costeoConfig: cfg,
  });
  assert.strictEqual(fila.markupPct, 20);
  assert.strictEqual(fila.banda, 'override');
  // el detalle necesita ambos: el override vigente y lo que daría la banda sin él
  assert.strictEqual(fila.markupOverride, 20);
  assert.strictEqual(fila.markupBanda, 40);
});

test('calcularFilaAlmacen: costoPorProducto (costo manual) reemplaza al costo de sistema en el cálculo', () => {
  const cfg = { ...CFG_BASE, costoPorProducto: { '7': 2000 } };
  const fila = calcularFilaAlmacen({
    plu: '7', nombre: 'Miel', costoMercaderia: 500, costoSistema: 600, precioVigente: null, costeoConfig: cfg,
  });
  assert.strictEqual(fila.costoOverride, 2000);
  assert.strictEqual(fila.costoBase, 2000);
  assert.strictEqual(fila.precioUltimaCompra, 500);
  // 2000 * 1.03 = 2060 → banda "sin tope" 15% → 2369 neto → 2866.49 c/IVA → 2850
  assert.strictEqual(fila.costoTotal, 2060);
  assert.strictEqual(fila.markupPct, 15);
  assert.strictEqual(fila.precioConIva, 2850);
  assert.strictEqual(fila.costosVariosPct, 3);
});

test('calcularFilaAlmacen: fuenteCosto "ultimaCompra" usa la última compra y costoOverride es null', () => {
  const cfg = { ...CFG_BASE, fuenteCosto: { '8': 'ultimaCompra' } };
  const fila = calcularFilaAlmacen({
    plu: '8', nombre: 'Te', costoMercaderia: 500, costoSistema: 605, precioVigente: null, costeoConfig: cfg,
  });
  assert.strictEqual(fila.costoFuente, 'ultimaCompra');
  assert.strictEqual(fila.costoOverride, null);
  assert.strictEqual(fila.costoBase, 500);
  assert.strictEqual(fila.precioUltimaCompra, 500);
});

test('calcularFilaAlmacen: costo manual permite precio aunque no haya costo de SIGA ni última compra', () => {
  const cfg = { ...CFG_BASE, costoPorProducto: { '9': 800 } };
  const fila = calcularFilaAlmacen({
    plu: '9', nombre: 'Nuevo', costoMercaderia: null, precioVigente: null, costeoConfig: cfg,
  });
  assert.deepStrictEqual(fila.faltantes, []);
  assert.strictEqual(fila.precioUltimaCompra, null);
  assert.strictEqual(fila.costoBase, 800);
});

test('calcularFilaAlmacen: por defecto usa el costo de SIGA (PrecioCosto sin IVA)', () => {
  const fila = calcularFilaAlmacen({
    plu: '10', nombre: 'Aceite', costoMercaderia: 500, costoSistema: 605, precioVigente: null, costeoConfig: CFG_BASE,
  });
  assert.strictEqual(fila.costoFuente, 'sistema');
  assert.strictEqual(fila.costoBase, 605);
  assert.strictEqual(fila.costoSistema, 605);
  assert.strictEqual(fila.precioUltimaCompra, 500);
});

test('calcularFilaAlmacen: manual gana sobre última compra y sistema', () => {
  const cfg = { ...CFG_BASE, fuenteCosto: { '11': 'ultimaCompra' }, costoPorProducto: { '11': 700 } };
  const man = calcularFilaAlmacen({
    plu: '11', nombre: 'A', costoMercaderia: 500, costoSistema: 605, precioVigente: null, costeoConfig: cfg,
  });
  assert.strictEqual(man.costoFuente, 'manual');
  assert.strictEqual(man.costoBase, 700);
});

test('calcularFilaAlmacen: fuente "sistema" sin PrecioCosto en SIGA → sin precio (nunca optimista)', () => {
  const fila = calcularFilaAlmacen({
    plu: '12', nombre: 'B', costoMercaderia: 500, costoSistema: null, precioVigente: null, costeoConfig: CFG_BASE,
  });
  assert.strictEqual(fila.costoBase, null);
  assert.strictEqual(fila.precioConIva, null);
  assert.ok(fila.faltantes.length > 0);
});

test('calcularFilaAlmacen: sin override, markupOverride es null y markupBanda es el de la banda', () => {
  const fila = calcularFilaAlmacen({
    plu: '6', nombre: 'Aceite', costoSistema: 500, precioVigente: null, costeoConfig: CFG_BASE,
  });
  assert.strictEqual(fila.markupOverride, null);
  assert.strictEqual(fila.markupBanda, 40);
});

test('calcularFilaAlmacen: sin costoMercaderia no hay precio optimista — precios null y faltantes marcado', () => {
  const fila = calcularFilaAlmacen({
    plu: '4', nombre: 'Sin costo', costoMercaderia: null, precioVigente: 1000, costeoConfig: CFG_BASE,
  });
  assert.deepStrictEqual(fila.faltantes, ['costoMercaderia']);
  assert.strictEqual(fila.precioNeto, null);
  assert.strictEqual(fila.precioConIva, null);
  // sin precio sugerido no hay contra qué comparar
  assert.strictEqual(fila.deltaPct, null);
  assert.strictEqual(fila.semaforo, null);
});

test('calcularFilaAlmacen: sin precioVigente (producto sin precio de mostrador) no rompe, delta/semaforo null', () => {
  const fila = calcularFilaAlmacen({
    plu: '5', nombre: 'Nuevo', costoSistema: 500, precioVigente: null, costeoConfig: CFG_BASE,
  });
  assert.strictEqual(fila.precioVigente, null);
  assert.strictEqual(fila.deltaPct, null);
  assert.strictEqual(fila.semaforo, null);
  // el costeo en sí no se ve afectado por la falta de precio vigente
  assert.strictEqual(fila.precioConIva, 850);
});

test('calcularFilaAlmacen: diferencia negativa fuera de tolerancia → bajar; dentro → ok', () => {
  // sugerido 850
  const bajar = calcularFilaAlmacen({ plu: '13', nombre: 'C', costoSistema: 500, precioVigente: 1000, costeoConfig: CFG_BASE });
  assert.strictEqual(bajar.deltaPct, -15);
  assert.strictEqual(bajar.semaforo, 'bajar');
  const ok = calcularFilaAlmacen({ plu: '13', nombre: 'C', costoSistema: 500, precioVigente: 1000, costeoConfig: { ...CFG_BASE, toleranciaPct: 15 } });
  assert.strictEqual(ok.semaforo, 'ok');
});

// ── aplicarMarcados ──────────────────────────────────────────────────────────
test('aplicarMarcados: agrega con fecha, quita, es idempotente y no muta la entrada', () => {
  const orig = { '1': '2026-09-01' };
  const agregado = aplicarMarcados(orig, ['2', '3'], true, '2026-09-23');
  assert.deepStrictEqual(agregado, { '1': '2026-09-01', '2': '2026-09-23', '3': '2026-09-23' });
  assert.deepStrictEqual(orig, { '1': '2026-09-01' });
  // re-marcar conserva la fecha original
  assert.deepStrictEqual(aplicarMarcados(agregado, ['1'], true, '2026-09-30'), agregado);
  const quitado = aplicarMarcados(agregado, ['1', '9'], false, '2026-09-23');
  assert.deepStrictEqual(quitado, { '2': '2026-09-23', '3': '2026-09-23' });
  assert.deepStrictEqual(aplicarMarcados(undefined, ['5'], true, 'x'), { '5': 'x' });
});
