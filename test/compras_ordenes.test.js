const test = require('node:test');
const assert = require('node:assert');
const { transicionValida, ESTADOS_ORDEN } = require('../compras_modulo');

test('ESTADOS_ORDEN son los cuatro del spec', () => {
  assert.deepStrictEqual(ESTADOS_ORDEN, ['GENERADA', 'ENVIADA', 'RECIBIDA', 'ANULADA']);
});

test('transiciones válidas desde GENERADA', () => {
  assert.strictEqual(transicionValida('GENERADA', 'ENVIADA'), true);
  assert.strictEqual(transicionValida('GENERADA', 'ANULADA'), true);
});

test('transiciones válidas desde ENVIADA', () => {
  assert.strictEqual(transicionValida('ENVIADA', 'RECIBIDA'), true);
  assert.strictEqual(transicionValida('ENVIADA', 'ANULADA'), true);
});

test('no se puede saltear ENVIADA', () => {
  assert.strictEqual(transicionValida('GENERADA', 'RECIBIDA'), false);
});

test('no se puede retroceder', () => {
  assert.strictEqual(transicionValida('ENVIADA', 'GENERADA'), false);
});

test('RECIBIDA y ANULADA son finales', () => {
  for (const destino of ESTADOS_ORDEN) {
    assert.strictEqual(transicionValida('RECIBIDA', destino), false);
    assert.strictEqual(transicionValida('ANULADA', destino), false);
  }
});

test('estado desconocido o vacío nunca es válido', () => {
  assert.strictEqual(transicionValida('INVENTADO', 'ENVIADA'), false);
  assert.strictEqual(transicionValida('GENERADA', 'INVENTADO'), false);
  assert.strictEqual(transicionValida(null, 'ENVIADA'), false);
  assert.strictEqual(transicionValida('GENERADA', ''), false);
});

const { sumarDias, leadTimeDeProveedor } = require('../compras_modulo');

test('sumarDias avanza el calendario', () => {
  assert.strictEqual(sumarDias('2026-08-04', 14), '2026-08-18');
});

test('sumarDias cruza fin de mes y de año', () => {
  assert.strictEqual(sumarDias('2026-08-25', 10), '2026-09-04');
  assert.strictEqual(sumarDias('2026-12-28', 7), '2027-01-04');
});

test('sumarDias con entradas inválidas devuelve null', () => {
  assert.strictEqual(sumarDias('', 5), null);
  assert.strictEqual(sumarDias(null, 5), null);
  assert.strictEqual(sumarDias('no-es-fecha', 5), null);
});

test('leadTimeDeProveedor usa el del proveedor', () => {
  const lt = { _default: 14, 'DISTRIBUIDORA LANIN': 4 };
  assert.strictEqual(leadTimeDeProveedor(lt, 'DISTRIBUIDORA LANIN'), 4);
});

test('leadTimeDeProveedor cae al _default y después a 14', () => {
  assert.strictEqual(leadTimeDeProveedor({ _default: 7 }, 'PROVEEDOR NUEVO'), 7);
  assert.strictEqual(leadTimeDeProveedor({}, 'PROVEEDOR NUEVO'), 14);
  assert.strictEqual(leadTimeDeProveedor(null, null), 14);
});
