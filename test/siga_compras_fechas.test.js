'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  fechaLocalISO, fechaHoraComprobante, fechaCtaCte, vencimiento, periodoDeFecha, periodoFiscalDe, fechaSiga,
} = require('../lib/siga_compras/fechas');

const AHORA = new Date(2026, 9, 16, 14, 47, 6);

test('fechaHoraComprobante: día elegido + hora del momento de cargar', () => {
  assert.strictEqual(fechaSiga(fechaHoraComprobante('2026-10-10', AHORA)), '20261010 14:47:06');
});

test('fechaCtaCte: hora real solo si el comprobante es de hoy', () => {
  const deHoy = new Date(2026, 9, 16, 9, 0, 0);
  assert.strictEqual(fechaCtaCte(deHoy, AHORA), AHORA);
  const viejo = new Date(2026, 9, 10, 9, 0, 0);
  assert.strictEqual(fechaCtaCte(viejo, AHORA), viejo);
});

test('vencimiento = fecha + Dias de la forma de pago (cruza de mes y de año, conserva la hora)', () => {
  assert.strictEqual(fechaSiga(vencimiento(new Date(2026, 9, 10, 14, 47, 6), 30)), '20261109 14:47:06');
  assert.strictEqual(fechaSiga(vencimiento(new Date(2026, 11, 20, 8, 0, 0), 15)), '20270104 08:00:00');
});

test('período fiscal: el del combo con GrabaLibro; yyyyMM de la fecha sin GrabaLibro', () => {
  assert.strictEqual(periodoDeFecha('2026-10-16'), 202610);
  assert.strictEqual(periodoFiscalDe({ periodoFiscal: 202609, fecha: '2026-10-16' }, { grabaLibro: true }), 202609);
  assert.strictEqual(periodoFiscalDe({ periodoFiscal: 202609, fecha: '2026-10-16' }, { grabaLibro: false }), 202610);
});

test('fechaSiga y fechaLocalISO', () => {
  assert.strictEqual(fechaSiga(new Date(2026, 0, 5, 9, 3, 7)), '20260105 09:03:07');
  assert.strictEqual(fechaLocalISO(new Date(2026, 0, 5, 23, 59, 0)), '2026-01-05');
});
