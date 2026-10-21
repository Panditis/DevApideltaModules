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
  const granel = { esGranel: true, producto: 'Miel Granel ', idGranel: '900', cantConfirmada: 5 };
  const fracc = { producto: 'Miel 500g', rubro: 'Miel ', cantConfirmada: 5 };
  const opts = { fecha: 'F', ahora: 1, ...resolvers };
  for (const it of [granel, fracc]) {
    assert.strictEqual(pe.claveItem(it), pe.claveOrden(pe.construirOrdenes([it], opts)[0]));
  }
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

test('fusionarEnvioEnPlan: plan nuevo crea ítems con envios[0]', () => {
  const plan = pe.fusionarEnvioEnPlan(undefined,
    [{ producto: 'Miel 500g', rubro: 'Miel', idProducto: 101, cantConfirmada: 40, responsables: ['Juan'] }],
    { fecha: '2026-10-21', envioId: 5000, hora: '09:12', usuario: 'adriel', creado: 'X' });
  assert.strictEqual(plan.fecha, '2026-10-21');
  assert.strictEqual(plan.notas, '');
  assert.strictEqual(plan.items.length, 1);
  const it = plan.items[0];
  assert.strictEqual(it.id, 5000);
  assert.strictEqual(it.estado, 'pendiente');
  assert.strictEqual(it.cantConfirmada, 40);
  assert.strictEqual(it.prioridad, 1);
  assert.deepStrictEqual(it.envios, [{ id: 5000, hora: '09:12', usuario: 'adriel', cantidad: 40 }]);
});

test('fusionarEnvioEnPlan: mismo producto suma, agrega historial y no muta el original', () => {
  const previo = { fecha: 'F', notas: 'n', creado: 'C', reserva: { x: 1 }, items: [
    { id: 1, producto: 'Miel 500g', rubro: 'Miel', idProducto: 101, cantConfirmada: 40, envase: 'E1',
      envios: [{ id: 10, hora: '08:00', usuario: 'a', cantidad: 40 }] },
  ] };
  const copia = JSON.parse(JSON.stringify(previo));
  const plan = pe.fusionarEnvioEnPlan(previo,
    [{ producto: 'Miel 500g', rubro: 'Miel', idProducto: 101, cantConfirmada: 10, envase: '', tapa: 'T9' }],
    { fecha: 'F', envioId: 20, hora: '10:00', usuario: 'b' });
  assert.deepStrictEqual(previo, copia);
  assert.strictEqual(plan.items.length, 1);
  assert.strictEqual(plan.items[0].cantConfirmada, 50);
  assert.strictEqual(plan.items[0].envase, 'E1');
  assert.strictEqual(plan.items[0].tapa, 'T9');
  assert.strictEqual(plan.items[0].envios.length, 2);
  assert.deepStrictEqual(plan.reserva, { x: 1 });
  assert.strictEqual(plan.notas, 'n');
});

test('fusionarEnvioEnPlan: ítem legado sin envios queda con un envío "anterior" (id null)', () => {
  const plan = pe.fusionarEnvioEnPlan({ fecha: 'F', items: [{ id: 1, producto: 'X', cantConfirmada: 3 }] },
    [{ producto: 'X', cantConfirmada: 2 }], { fecha: 'F', envioId: 9, hora: '11:00', usuario: 'u' });
  assert.deepStrictEqual(plan.items[0].envios.map(e => e.id), [null, 9]);
  assert.strictEqual(plan.items[0].cantConfirmada, 5);
});

test('fusionarEnvioEnPlan: notas del carrito se agregan al final, sin pisar', () => {
  const opts = { fecha: 'F', envioId: 1, hora: 'h', usuario: 'u' };
  const item = [{ producto: 'X', cantConfirmada: 1 }];
  assert.strictEqual(pe.fusionarEnvioEnPlan(undefined, item, { ...opts, notas: 'nueva' }).notas, 'nueva');
  assert.strictEqual(pe.fusionarEnvioEnPlan({ fecha: 'F', notas: 'vieja', items: [] }, item, { ...opts, notas: ' nueva ' }).notas, 'vieja\nnueva');
  assert.strictEqual(pe.fusionarEnvioEnPlan({ fecha: 'F', notas: 'vieja', items: [] }, item, { ...opts, notas: '  ' }).notas, 'vieja');
});

test('fusionarEnvioEnPlan: granel y fraccionado del mismo nombre son ítems distintos', () => {
  const plan = pe.fusionarEnvioEnPlan(undefined, [
    { producto: 'Mani', esGranel: true, cantConfirmada: 6 },
    { producto: 'Mani', cantConfirmada: 10 },
  ], { fecha: 'F', envioId: 1, hora: 'h', usuario: 'u' });
  assert.strictEqual(plan.items.length, 2);
});

const protegida = o => o.terminado === true || o.estado === 'listo';

test('clavesBloqueadas: órdenes protegidas del día e ítems recepcionados', () => {
  const ordenes = [
    { fecha: 'F', producto: 'Miel', presentaciones: [], estado: 'listo' },
    { fecha: 'F', producto: 'Coco', presentaciones: [], estado: 'pendiente' },
    { fecha: 'OTRA', producto: 'Nuez', presentaciones: [], estado: 'listo' },
  ];
  const plan = { items: [{ esGranel: true, producto: 'Granel X', produccionMovimiento: { numeroMovimiento: 3 } }] };
  const s = pe.clavesBloqueadas(ordenes, plan, { fecha: 'F', protegida });
  assert.deepStrictEqual([...s].sort(), ['F|miel', 'G|granel x']);
});

test('sincronizarOrdenes: actualiza conservando id/estado/Urgente, agrega nuevas, borra vacías, respeta otras', () => {
  const ordenes = [
    { id: 1, fecha: 'F', producto: 'Miel', presentaciones: [], cantidad: 10, estado: 'en_proceso', criticidad: 'Urgente', reservaMovimientos: [7] },
    { id: 2, fecha: 'F', producto: 'Coco', presentaciones: [], cantidad: 5, estado: 'pendiente' },
    { id: 3, fecha: 'OTRA', producto: 'Miel', presentaciones: [], cantidad: 1, estado: 'pendiente' },
    { id: 4, fecha: 'F', producto: 'Nuez', presentaciones: [], cantidad: 2, estado: 'pendiente' },
  ];
  const armadas = [
    { id: 100, fecha: 'F', producto: 'Miel', presentaciones: [], cantidad: 30, estado: 'pendiente', criticidad: 'Media' },
    { id: 101, fecha: 'F', producto: 'Granel Y', cantidad: 8, estado: 'pendiente', criticidad: 'Alta' },
  ];
  const snapshot = JSON.parse(JSON.stringify(ordenes));
  const claves = new Set(['F|miel', 'F|coco', 'G|granel y']);
  const r = pe.sincronizarOrdenes(ordenes, armadas, { fecha: 'F', claves, protegida });
  assert.strictEqual(r.actualizadas, 1);
  assert.strictEqual(r.nuevas, 1);
  assert.strictEqual(r.borradas, 1);
  const miel = r.ordenes.find(o => o.fecha === 'F' && o.producto === 'Miel');
  assert.deepStrictEqual([miel.id, miel.cantidad, miel.estado, miel.criticidad, miel.reservaMovimientos], [1, 30, 'en_proceso', 'Urgente', [7]]);
  assert.ok(!r.ordenes.some(o => o.producto === 'Coco'));
  assert.ok(r.ordenes.some(o => o.id === 3));
  assert.ok(r.ordenes.some(o => o.id === 4));
  assert.ok(r.ordenes.some(o => o.id === 101));
  assert.deepStrictEqual(ordenes, snapshot); // no muta
});

test('sincronizarOrdenes: protegida no se toca ni se duplica', () => {
  const ordenes = [{ id: 1, fecha: 'F', producto: 'Miel', presentaciones: [], cantidad: 10, estado: 'listo' }];
  const armadas = [{ id: 9, fecha: 'F', producto: 'Miel', presentaciones: [], cantidad: 99 }];
  const r = pe.sincronizarOrdenes(ordenes, armadas, { fecha: 'F', claves: new Set(['F|miel']), protegida });
  assert.deepStrictEqual(r.ordenes, ordenes);
  assert.strictEqual(r.nuevas + r.actualizadas + r.borradas, 0);
});

test('construirOrdenes: rubros que sólo difieren en mayúsculas/espacios son una sola orden', () => {
  const ordenes = pe.construirOrdenes([
    { producto: 'Miel 500g', rubro: 'Miel', cantConfirmada: 10 },
    { producto: 'Miel 1kg', rubro: 'miel ', cantConfirmada: 20 },
  ], { fecha: 'F', ahora: 1, ...resolvers });
  assert.strictEqual(ordenes.length, 1);
  assert.strictEqual(ordenes[0].producto, 'Miel');
  assert.strictEqual(ordenes[0].cantidad, 30);
  assert.strictEqual(pe.claveOrden(ordenes[0]), 'F|miel');
});

test('construirOrdenes: cantidades numéricas como string se suman como número', () => {
  const [o] = pe.construirOrdenes([
    { producto: 'A', rubro: 'R', cantConfirmada: '5' },
    { producto: 'B', rubro: 'R', cantConfirmada: '3' },
  ], { fecha: 'F', ahora: 1, ...resolvers });
  assert.strictEqual(o.cantidad, 8);
});

test('construirOrdenes: reservaMovimientos = movimientos únicos sellados en sus ítems', () => {
  const ordenes = pe.construirOrdenes([
    { producto: 'A', rubro: 'R', cantConfirmada: 1, reservaMovimiento: { numeroMovimiento: 7 } },
    { producto: 'B', rubro: 'R', cantConfirmada: 1, reservaMovimiento: { numeroMovimiento: 7 } },
    { producto: 'C', rubro: 'R', cantConfirmada: 1, reservaMovimiento: { numeroMovimiento: 8 } },
    { producto: 'D', rubro: 'R', cantConfirmada: 1, reservaMovimiento: null },
    { producto: 'Granel', esGranel: true, cantConfirmada: 1, reservaMovimiento: { numeroMovimiento: 9 } },
    { producto: 'Libre', rubro: 'L', cantConfirmada: 1 },
  ], { fecha: 'F', ahora: 1, ...resolvers });
  const por = n => ordenes.find(o => o.producto === n).reservaMovimientos;
  assert.deepStrictEqual(por('R'), [7, 8]);
  assert.deepStrictEqual(por('Granel'), [9]);
  assert.deepStrictEqual(por('L'), []);
});

test('fusionarEnvioEnPlan: vacío ([] / false / "" / null) no pisa lo ya cargado', () => {
  const previo = { fecha: 'F', items: [
    { id: 1, producto: 'X', cantConfirmada: 1, responsables: ['Ana'], granelAparte: true, envase: 'E1', cliente: 7 },
  ] };
  const plan = pe.fusionarEnvioEnPlan(previo,
    [{ producto: 'X', cantConfirmada: 1, responsables: [], granelAparte: false, envase: '', cliente: null }],
    { fecha: 'F', envioId: 2, hora: 'h', usuario: 'u' });
  const it = plan.items[0];
  assert.deepStrictEqual(it.responsables, ['Ana']);
  assert.strictEqual(it.granelAparte, true);
  assert.strictEqual(it.envase, 'E1');
  assert.strictEqual(it.cliente, 7);
});

test('fusionarEnvioEnPlan: cantidades string se suman como número', () => {
  const plan = pe.fusionarEnvioEnPlan({ fecha: 'F', items: [{ id: 1, producto: 'X', cantConfirmada: '5' }] },
    [{ producto: 'X', cantConfirmada: '3' }], { fecha: 'F', envioId: 2, hora: 'h', usuario: 'u' });
  assert.strictEqual(plan.items[0].cantConfirmada, 8);
  assert.deepStrictEqual(plan.items[0].envios.map(e => e.cantidad), [5, 3]);
});

test('validarItemsEnvio rechaza cantidad no numérica', () => {
  assert.strictEqual(pe.validarItemsEnvio([{ producto: 'X', cantConfirmada: 'abc' }]).length, 1);
});

test('fusionarEnvioEnPlan: campos del servidor que vengan en el ítem no se guardan', () => {
  const forjado = {
    producto: 'X', cantConfirmada: 2, produccionMovimiento: { numeroMovimiento: 1 },
    reservaMovimiento: { numeroMovimiento: 2 }, reservaDevuelta: { numeroMovimiento: 3 },
    reservaError: 'x', envios: [{ id: 99 }], id: 77, estado: 'listo',
  };
  const plan = pe.fusionarEnvioEnPlan(undefined, [forjado], { fecha: 'F', envioId: 5, hora: 'h', usuario: 'u' });
  const it = plan.items[0];
  for (const k of ['produccionMovimiento', 'reservaMovimiento', 'reservaDevuelta', 'reservaError']) {
    assert.ok(!(k in it), `${k} no debería guardarse`);
  }
  assert.strictEqual(it.id, 5);
  assert.strictEqual(it.estado, 'pendiente');
  assert.deepStrictEqual(it.envios.map(e => e.id), [5]);
});

test('sincronizarOrdenes: la orden actualizada une los movimientos previos con los del plan', () => {
  const ordenes = [{ id: 1, fecha: 'F', producto: 'Miel', presentaciones: [], reservaMovimientos: [7] }];
  const armadas = [{ id: 9, fecha: 'F', producto: 'Miel', presentaciones: [], reservaMovimientos: [7, 8] }];
  const r = pe.sincronizarOrdenes(ordenes, armadas, { fecha: 'F', claves: new Set(['F|miel']), protegida });
  assert.deepStrictEqual(r.ordenes[0].reservaMovimientos, [7, 8]);
});

test('sincronizarOrdenes: la orden nueva conserva los movimientos que trae', () => {
  const armadas = [{ id: 9, fecha: 'F', producto: 'Miel', presentaciones: [], reservaMovimientos: [8] }];
  const r = pe.sincronizarOrdenes([], armadas, { fecha: 'F', claves: new Set(['F|miel']), protegida });
  assert.deepStrictEqual(r.ordenes[0].reservaMovimientos, [8]);
});

test('sincronizarOrdenes: duplicadas del día con la misma clave: actualiza la primera y borra el resto', () => {
  const ordenes = [
    { id: 1, fecha: 'F', producto: 'Miel', presentaciones: [], cantidad: 1, estado: 'pendiente' },
    { id: 2, fecha: 'F', producto: 'miel ', presentaciones: [], cantidad: 2, estado: 'pendiente' },
  ];
  const armadas = [{ id: 9, fecha: 'F', producto: 'Miel', presentaciones: [], cantidad: 30 }];
  const r = pe.sincronizarOrdenes(ordenes, armadas, { fecha: 'F', claves: new Set(['F|miel']), protegida });
  assert.strictEqual(r.ordenes.length, 1);
  assert.deepStrictEqual([r.ordenes[0].id, r.ordenes[0].cantidad], [1, 30]);
  assert.deepStrictEqual([r.actualizadas, r.nuevas, r.borradas], [1, 0, 1]);
});
