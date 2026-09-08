const test = require('node:test');
const assert = require('node:assert');
const {
  idFormasPago, periodoFiscal, totalBruto, calcularLinea, prorratearPercepciones,
  filaComprasImpuesto, agregarCantidadesPorProducto,
  ID_FORMAS_PAGO_CONTADO, ID_FORMAS_PAGO_MENSUAL,
} = require('../lib/compras_grabar');

// ── idFormasPago ─────────────────────────────────────────────────────────────
test('idFormasPago: contado cuando el vencimiento coincide con la fecha del comprobante', () => {
  assert.strictEqual(
    idFormasPago({ FechaComprobante: '2026-08-31', FechaVencimiento: '2026-08-31' }),
    ID_FORMAS_PAGO_CONTADO);
});

test('idFormasPago: contado cuando no hay vencimiento', () => {
  assert.strictEqual(
    idFormasPago({ FechaComprobante: '2026-08-31', FechaVencimiento: null }),
    ID_FORMAS_PAGO_CONTADO);
});

test('idFormasPago: mensual cuando el vencimiento es posterior', () => {
  assert.strictEqual(
    idFormasPago({ FechaComprobante: '2026-08-31', FechaVencimiento: '2026-09-30' }),
    ID_FORMAS_PAGO_MENSUAL);
});

// ── periodoFiscal ────────────────────────────────────────────────────────────
test('periodoFiscal: AAAAMM a partir de AAAA-MM-DD', () => {
  assert.strictEqual(periodoFiscal('2026-08-31'), 202608);
  assert.strictEqual(periodoFiscal('2026-01-05'), 202601);
});

// ── totalBruto ───────────────────────────────────────────────────────────────
test('totalBruto: neto + IVA, sin percepciones', () => {
  assert.strictEqual(totalBruto({ neto: 1000, totalIVA: 210, totalPercepciones: 50 }), 1210);
});

test('totalBruto: coincide con TotalNeto cuando el IVA es 0 (caso relevado en pruebas_compras)', () => {
  assert.strictEqual(totalBruto({ neto: 3750, totalIVA: 0, totalPercepciones: 0 }), 3750);
});

// ── calcularLinea ────────────────────────────────────────────────────────────
test('calcularLinea: con IVA 0%, Precio y PrecioNeto coinciden (caso relevado)', () => {
  const l = calcularLinea({
    resuelto: '7470', nombreSiga: 'Tutuca Maiz DEPOSITO GRANEL', codigoProveedor: null,
    orden: 1, cantidad: 1, precioUnitario: 3750, porcentajeIVA: 0, neto: 3750,
  });
  assert.strictEqual(l.precio, 3750);
  assert.strictEqual(l.precioNeto, 3750);
  assert.strictEqual(l.importeTotal, 3750);
  assert.strictEqual(l.importeTotalNeto, 3750);
  assert.strictEqual(l.iva, 0);
});

test('calcularLinea: con IVA 21%, separa neto de bruto', () => {
  const l = calcularLinea({
    resuelto: '2124', nombreSiga: 'Aceitunas', codigoProveedor: '29',
    orden: 1, cantidad: 12, precioUnitario: 5680.29, porcentajeIVA: 21, neto: 68163.48,
  });
  assert.strictEqual(l.precioNeto, 5680.29);
  assert.strictEqual(l.precio, 6873.15);           // 5680.29 * 1.21, redondeado
  assert.strictEqual(l.importeTotalNeto, 68163.48);
  assert.strictEqual(l.iva, 14314.33);              // 68163.48 * 0.21, redondeado
  assert.strictEqual(l.importeTotal, 82477.81);     // neto + iva
});

test('calcularLinea: arrastra el código de proveedor de la línea', () => {
  const l = calcularLinea({
    resuelto: '2124', nombreSiga: 'X', codigoProveedor: '29',
    orden: 1, cantidad: 1, precioUnitario: 10, porcentajeIVA: 0, neto: 10,
  });
  assert.strictEqual(l.codigoProveedor, '29');
});

test('calcularLinea: sin código de proveedor queda null (no undefined, para el bind de mssql)', () => {
  const l = calcularLinea({
    resuelto: '2124', nombreSiga: 'X', codigoProveedor: null,
    orden: 1, cantidad: 1, precioUnitario: 10, porcentajeIVA: 0, neto: 10,
  });
  assert.strictEqual(l.codigoProveedor, null);
});

// ── prorratearPercepciones ────────────────────────────────────────────────────
test('prorratearPercepciones: sin percepciones, todas las líneas en 0', () => {
  const lineas = [{ importeTotalNeto: 100 }, { importeTotalNeto: 200 }];
  assert.deepStrictEqual(prorratearPercepciones(lineas, 300, 0), [0, 0]);
});

test('prorratearPercepciones: reparte proporcional al neto y la suma da el total exacto', () => {
  // Dos líneas con neto 75%/25% del total: la percepción se reparte en la misma
  // proporción y la suma exacta cae en la última línea (no en la que redondea).
  const lineas = [{ importeTotalNeto: 75 }, { importeTotalNeto: 25 }];
  const r = prorratearPercepciones(lineas, 100, 955.19);
  assert.strictEqual(r[0], 716.3925);              // 955.19 * 0.75
  assert.strictEqual(r[1], 238.7975);              // resto exacto, no 955.19 * 0.25 redondeado aparte
  assert.strictEqual(r[0] + r[1], 955.19);
});

test('prorratearPercepciones: una sola línea se lleva todo el total', () => {
  const r = prorratearPercepciones([{ importeTotalNeto: 100 }], 100, 21.5);
  assert.deepStrictEqual(r, [21.5]);
});

// ── filaComprasImpuesto ───────────────────────────────────────────────────────
test('filaComprasImpuesto: Bruto = BaseImponible + Importe (confirmado en el relevamiento)', () => {
  const cab = { PuntoVenta: 1, NumeroComprobante: 50 };
  const fila = filaComprasImpuesto({ tipo: 'IVA', alicuota: 21, baseImponible: 31839.64, importe: 6686.32 }, 1, cab);
  assert.strictEqual(fila.orden, 1);
  assert.strictEqual(fila.idTipoImpuesto, 'IVA');
  assert.strictEqual(fila.emisor, 1);
  assert.strictEqual(fila.numero, 50);
  assert.strictEqual(fila.bruto, 38525.96);
});

test('filaComprasImpuesto: una percepción lleva base y bruto en 0, el importe en Importe', () => {
  const cab = { PuntoVenta: 1, NumeroComprobante: 50 };
  const fila = filaComprasImpuesto({ tipo: 'PIVA', alicuota: 0, baseImponible: 0, importe: 955.19 }, 3, cab);
  assert.strictEqual(fila.bruto, 955.19);
  assert.strictEqual(fila.baseImponible, 0);
});

// ── agregarCantidadesPorProducto ─────────────────────────────────────────────
test('agregarCantidadesPorProducto: suma cantidades cuando el mismo producto aparece dos veces', () => {
  const lineas = [{ idProducto: 'A', cantidad: 2 }, { idProducto: 'B', cantidad: 5 }, { idProducto: 'A', cantidad: 3 }];
  const r = agregarCantidadesPorProducto(lineas);
  assert.deepStrictEqual(r, [{ idProducto: 'A', cantidad: 5 }, { idProducto: 'B', cantidad: 5 }]);
});

test('agregarCantidadesPorProducto: una línea por producto, sin cambios', () => {
  const lineas = [{ idProducto: 'A', cantidad: 2 }, { idProducto: 'B', cantidad: 5 }];
  const r = agregarCantidadesPorProducto(lineas);
  assert.deepStrictEqual(r, [{ idProducto: 'A', cantidad: 2 }, { idProducto: 'B', cantidad: 5 }]);
});
