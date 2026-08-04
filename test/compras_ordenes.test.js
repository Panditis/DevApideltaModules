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

const { aplicarTransicion } = require('../compras_modulo');

const ordenBase = () => ({
  id: 1785415836277, fecha: '2026-07-30', proveedor: 'DISTRIBUIDORA LANIN',
  items: [{ plu: '3035', nombre: 'Yogurt', cantidad: 10, costoUnit: 100, subtotal: 1000 }],
  total: 1000, estado: 'GENERADA',
});
const ctx = { ts: '2026-08-04T12:00:00.000Z', fechaISO: '2026-08-04', usuario: 'adriel', leadTimes: { _default: 14, 'DISTRIBUIDORA LANIN': 4 } };

test('ENVIADA fija fechaEnvio y fechaEstimada con el lead time del proveedor', () => {
  const r = aplicarTransicion(ordenBase(), 'ENVIADA', ctx);
  assert.strictEqual(r.estado, 'ENVIADA');
  assert.strictEqual(r.fechaEnvio, '2026-08-04');
  assert.strictEqual(r.fechaEstimada, '2026-08-08');
  assert.strictEqual(r.fechaRecepcion, null);
});

test('RECIBIDA fija fechaRecepcion y conserva la estimada', () => {
  const enviada = aplicarTransicion(ordenBase(), 'ENVIADA', ctx);
  const r = aplicarTransicion(enviada, 'RECIBIDA', { ...ctx, fechaISO: '2026-08-09' });
  assert.strictEqual(r.estado, 'RECIBIDA');
  assert.strictEqual(r.fechaRecepcion, '2026-08-09');
  assert.strictEqual(r.fechaEstimada, '2026-08-08');
});

test('el historial acumula cada paso con usuario y timestamp', () => {
  const enviada = aplicarTransicion(ordenBase(), 'ENVIADA', ctx);
  const recibida = aplicarTransicion(enviada, 'RECIBIDA', { ...ctx, usuario: 'otro' });
  assert.strictEqual(recibida.historial.length, 2);
  assert.deepStrictEqual(recibida.historial[0], { estado: 'ENVIADA', ts: ctx.ts, usuario: 'adriel' });
  assert.strictEqual(recibida.historial[1].estado, 'RECIBIDA');
  assert.strictEqual(recibida.historial[1].usuario, 'otro');
});

test('ANULADA guarda la nota', () => {
  const r = aplicarTransicion(ordenBase(), 'ANULADA', { ...ctx, nota: 'proveedor sin stock' });
  assert.strictEqual(r.estado, 'ANULADA');
  assert.strictEqual(r.nota, 'proveedor sin stock');
});

test('no muta la orden original', () => {
  const orden = ordenBase();
  aplicarTransicion(orden, 'ENVIADA', ctx);
  assert.strictEqual(orden.estado, 'GENERADA');
  assert.strictEqual(orden.fechaEnvio, undefined);
});

test('una transición inválida tira error y no devuelve orden', () => {
  assert.throws(() => aplicarTransicion(ordenBase(), 'RECIBIDA', ctx), /GENERADA.*RECIBIDA/);
  const recibida = { ...ordenBase(), estado: 'RECIBIDA' };
  assert.throws(() => aplicarTransicion(recibida, 'ENVIADA', ctx), /RECIBIDA.*ENVIADA/);
});

test('orden vieja sin campos nuevos se completa al transicionar', () => {
  const vieja = { id: 1, fecha: '2026-07-01', proveedor: 'X', items: [], total: 0, estado: 'GENERADA' };
  const r = aplicarTransicion(vieja, 'ENVIADA', ctx);
  assert.strictEqual(r.fechaRecepcion, null);
  assert.strictEqual(r.nota, null);
  assert.strictEqual(r.historial.length, 1);
});

const { pendientePorPlu } = require('../compras_modulo');

const orden = (estado, items) => ({ id: 1, fecha: '2026-08-01', proveedor: 'P', items, total: 0, estado });

test('pendientePorPlu suma GENERADA y ENVIADA', () => {
  const r = pendientePorPlu([
    orden('GENERADA', [{ plu: '100', cantidad: 10 }]),
    orden('ENVIADA', [{ plu: '100', cantidad: 5 }, { plu: '200', cantidad: 3 }]),
  ]);
  assert.deepStrictEqual(r, { 100: 15, 200: 3 });
});

test('pendientePorPlu ignora RECIBIDA y ANULADA', () => {
  const r = pendientePorPlu([
    orden('RECIBIDA', [{ plu: '100', cantidad: 99 }]),
    orden('ANULADA', [{ plu: '100', cantidad: 99 }]),
    orden('GENERADA', [{ plu: '100', cantidad: 2 }]),
  ]);
  assert.deepStrictEqual(r, { 100: 2 });
});

test('pendientePorPlu tolera lista vacía, items faltantes y cantidades basura', () => {
  assert.deepStrictEqual(pendientePorPlu([]), {});
  assert.deepStrictEqual(pendientePorPlu(null), {});
  assert.deepStrictEqual(pendientePorPlu([orden('GENERADA', null)]), {});
  assert.deepStrictEqual(pendientePorPlu([orden('GENERADA', [{ plu: '100', cantidad: 'x' }])]), {});
});

test('pendientePorPlu normaliza el PLU con espacios', () => {
  const r = pendientePorPlu([orden('GENERADA', [{ plu: ' 100 ', cantidad: 4 }, { plu: '100', cantidad: 1 }])]);
  assert.deepStrictEqual(r, { 100: 5 });
});

const { construirOrden } = require('../compras_modulo');

test('construirOrden nace con los campos de seguimiento vacíos', () => {
  const o = construirOrden({
    id: 1, fechaISO: '2026-08-04', proveedor: 'P',
    items: [{ plu: '100', nombre: 'X', cantidad: 2, costoUnit: 50 }],
  });
  assert.strictEqual(o.estado, 'GENERADA');
  assert.strictEqual(o.fechaEnvio, null);
  assert.strictEqual(o.fechaRecepcion, null);
  assert.strictEqual(o.fechaEstimada, null);
  assert.strictEqual(o.nota, null);
  assert.deepStrictEqual(o.historial, []);
  assert.strictEqual(o.total, 100);
});
