// test/plan_envio.test.js
const test = require('node:test');
const assert = require('node:assert');
const pe = require('../lib/plan_envio');

const resolvers = {
  codigoGranel: it => String(it.idGranel || ''),
  requiereGranel: ref => ref === 'Apimani Clasico',
  nombreCliente: id => (id === 7 ? 'Cliente Siete' : ''),
};

test('claveItem: granel por producto, fraccionado por rubro (fallback producto)', () => {
  assert.strictEqual(pe.claveItem({ esGranel: true, producto: 'Miel Granel ' }), 'G|miel granel');
  assert.strictEqual(pe.claveItem({ producto: 'Miel 500g', rubro: 'Miel' }), 'F|miel');
  assert.strictEqual(pe.claveItem({ producto: 'Suelto' }), 'F|suelto');
});

test('claveOrden coincide con claveItem del ítem que la generó', () => {
  assert.strictEqual(pe.claveOrden({ producto: 'Miel', presentaciones: [] }), 'F|miel');
  assert.strictEqual(pe.claveOrden({ producto: 'Miel Granel' }), 'G|miel granel');
});

test('validarItemsEnvio rechaza vacío, sin producto y cantidad <= 0', () => {
  assert.deepStrictEqual(pe.validarItemsEnvio([]), ['Sin ítems para enviar']);
  assert.deepStrictEqual(pe.validarItemsEnvio(null), ['Sin ítems para enviar']);
  const err = pe.validarItemsEnvio([{ producto: '', cantConfirmada: 1 }, { producto: 'X', cantConfirmada: 0 }]);
  assert.strictEqual(err.length, 2);
  assert.deepStrictEqual(pe.validarItemsEnvio([{ producto: 'X', cantConfirmada: 3 }]), []);
});

test('construirOrdenes: 1 orden por granel, 1 por rubro en fraccionado', () => {
  const items = [
    { esGranel: true, producto: 'Miel Granel', idGranel: '900', cantConfirmada: 50, semaforo: 'RED', prioridad: 1, tambor: 'T1', responsables: ['Ana'] },
    { producto: 'Miel 500g', presentacion: 'Miel 500g', rubro: 'Miel', idProducto: 101, cantConfirmada: 40, semaforo: 'YELLOW', prioridad: 2, envase: 'E1', tapa: 'T1', responsables: ['Juan'] },
    { producto: 'Miel 1kg', presentacion: 'Miel 1kg', rubro: 'Miel', idProducto: 102, cantConfirmada: 30, semaforo: 'RED', prioridad: 3, responsables: ['Ana'], cliente: 7 },
    { producto: 'Ya hecho', rubro: 'Otro', cantConfirmada: 5, produccionMovimiento: { numeroMovimiento: 9 } },
  ];
  const ordenes = pe.construirOrdenes(items, { fecha: '2026-10-21', ahora: 1000, ...resolvers });
  assert.strictEqual(ordenes.length, 2);
  const g = ordenes.find(o => o.producto === 'Miel Granel');
  assert.strictEqual(g.codigo, '900');
  assert.strictEqual(g.presentacion, '50 Kg · Tambor T1');
  assert.strictEqual(g.criticidad, 'Alta');
  assert.strictEqual(g.fecha, '2026-10-21');
  const f = ordenes.find(o => o.producto === 'Miel');
  assert.strictEqual(f.cantidad, 70);
  assert.strictEqual(f.codigo, '101, 102');
  assert.strictEqual(f.criticidad, 'Alta');
  assert.strictEqual(f.prioridad, 2);
  assert.deepStrictEqual(f.encargados, ['Juan', 'Ana']);
  assert.strictEqual(f.cliente, 'Cliente Siete');
  assert.strictEqual(f.presentacion, 'Miel 500g: 40 / Miel 1kg: 30');
  assert.deepStrictEqual(ordenes.map(o => o.id), [1000, 1001]);
});

test('construirOrdenes: granelAparte si el grupo requiere granel previo', () => {
  const [o] = pe.construirOrdenes([{ producto: 'Apimani 250', rubro: 'Apimani Clasico', cantConfirmada: 5 }],
    { fecha: '2026-10-21', ahora: 1, ...resolvers });
  assert.strictEqual(o.granelAparte, true);
});
