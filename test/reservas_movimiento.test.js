const test = require('node:test');
const assert = require('node:assert');
const { migrarReservas, saldoLedger, itemsSinReservar, reservadoPorMovimiento, conciliarPorMovimiento, lineasAjusteMovimiento } = require('../reservas_movimiento');

test('migrarReservas: plan sin reserva devuelve reservas vacío', () => {
  assert.deepStrictEqual(migrarReservas({ fecha: '2026-07-24', items: [] }).reservas, []);
});
test('migrarReservas: convierte reserva vieja activa en un elemento del ledger', () => {
  const plan = { fecha: '2026-07-24', reserva: { numeroMovimiento: 111, estado: 'activa', fecha: '2026-07-24T10:00:00Z', idSucursal: 1, depOrigen: 1, depDestino: 5, lineas: [{ plu: '9', nombre: 'Granel', cantidad: 100 }], devoluciones: [] }, items: [{ id: 1, reservaMovimiento: { numeroMovimiento: 111 } }, { id: 2 }] };
  const r = migrarReservas(plan).reservas;
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].numeroMovimiento, 111);
  assert.strictEqual(r[0].fechaPlanificacion, '2026-07-24');
  assert.deepStrictEqual(r[0].ordenes, [1]);
});
test('migrarReservas: plan que ya tiene reservas no se altera', () => {
  const plan = { fecha: '2026-07-24', reservas: [{ numeroMovimiento: 9 }], reserva: { numeroMovimiento: 1 } };
  assert.strictEqual(migrarReservas(plan).reservas.length, 1);
  assert.strictEqual(migrarReservas(plan).reservas[0].numeroMovimiento, 9);
});
test('saldoLedger: suma reservas activas y descuenta devoluciones', () => {
  const reservas = [
    { estado: 'activa', lineas: [{ plu: '9', nombre: 'G', cantidad: 100 }], devoluciones: [{ lineas: [{ plu: '9', cantidad: 30 }] }] },
    { estado: 'activa', lineas: [{ plu: '9', nombre: 'G', cantidad: 50 }], devoluciones: [] },
    { estado: 'anulada', lineas: [{ plu: '9', nombre: 'G', cantidad: 999 }], devoluciones: [] },
  ];
  assert.strictEqual(saldoLedger(reservas).find(l => l.plu === '9').cantidad, 120);
});
test('saldoLedger: omite líneas que quedan en 0', () => {
  const reservas = [{ estado: 'activa', lineas: [{ plu: '9', nombre: 'G', cantidad: 40 }], devoluciones: [{ lineas: [{ plu: '9', cantidad: 40 }] }] }];
  assert.strictEqual(saldoLedger(reservas).length, 0);
});
test('itemsSinReservar: sólo ítems sin sello de movimiento', () => {
  const items = [{ id: 1, reservaMovimiento: { numeroMovimiento: 5 } }, { id: 2 }, { id: 3, reservaMovimiento: null }];
  assert.deepStrictEqual(itemsSinReservar(items).map(i => i.id), [2, 3]);
});
test('reservadoPorMovimiento: agrupa lineas por numeroMovimiento', () => {
  const reservas = [
    { numeroMovimiento: 10, estado: 'activa', ordenes: [1], lineas: [{ plu: '9', nombre: 'G', cantidad: 100 }], devoluciones: [] },
    { numeroMovimiento: 11, estado: 'activa', ordenes: [2], lineas: [{ plu: '9', nombre: 'G', cantidad: 40 }], devoluciones: [] },
  ];
  const grupos = reservadoPorMovimiento(reservas);
  assert.strictEqual(grupos.length, 2);
  assert.strictEqual(grupos.find(g => g.numeroMovimiento === 10).saldo.find(l => l.plu === '9').cantidad, 100);
  assert.deepStrictEqual(grupos.find(g => g.numeroMovimiento === 10).ordenes, [1]);
  assert.strictEqual(grupos.find(g => g.numeroMovimiento === 10).conciliado, false);
});

test('reservadoPorMovimiento: refleja conciliado desde ajuste.conciliado', () => {
  const reservas = [
    { numeroMovimiento: 10, estado: 'activa', ordenes: [1], lineas: [{ plu: '9', nombre: 'G', cantidad: 100 }], devoluciones: [], ajuste: { conciliado: true, numeroMovimiento: 555 } },
    { numeroMovimiento: 11, estado: 'activa', ordenes: [2], lineas: [{ plu: '9', nombre: 'G', cantidad: 40 }], devoluciones: [] },
  ];
  const grupos = reservadoPorMovimiento(reservas);
  assert.strictEqual(grupos.find(g => g.numeroMovimiento === 10).conciliado, true);
  assert.strictEqual(grupos.find(g => g.numeroMovimiento === 11).conciliado, false);
});

test('conciliarPorMovimiento: propaga conciliado a cada grupo', () => {
  const grupos = [{ numeroMovimiento: 10, ordenes: [1], conciliado: true, saldo: [{ plu: '9', nombre: 'G', cantidad: 100 }] }];
  const res = conciliarPorMovimiento(grupos, new Map([['9', 100]]));
  assert.strictEqual(res[0].conciliado, true);
});
test('conciliarPorMovimiento: compara reservado vs usado por movimiento', () => {
  const grupos = [
    { numeroMovimiento: 10, ordenes: [1], saldo: [{ plu: '9', nombre: 'G', cantidad: 100 }] },
    { numeroMovimiento: 11, ordenes: [2], saldo: [{ plu: '9', nombre: 'G', cantidad: 40 }] },
  ];
  const res = conciliarPorMovimiento(grupos, new Map([['9', 90]]));
  const m10 = res.find(m => m.numeroMovimiento === 10);
  const m11 = res.find(m => m.numeroMovimiento === 11);
  assert.strictEqual(m10.componentes[0].usado, 90);
  assert.strictEqual(m10.componentes[0].sobrante, 10);
  assert.strictEqual(m11.componentes[0].usado, 0);
  assert.strictEqual(m11.componentes[0].sobrante, 40);
});

test('lineasAjusteMovimiento: consumo contra reserva y sobrante a diferencias', () => {
  const deps = { reserva: 5, diferencias: 1 };
  const comps = [
    { plu: '9', nombre: 'G', reservado: 100, usado: 90, sobrante: 10 },
    { plu: '7', nombre: 'Envase', reservado: 50, usado: 50, sobrante: 0 },
  ];
  const lineas = lineasAjusteMovimiento(comps, deps);
  // comp 9: -90 consumo-reserva (dep 5), -10 sobrante-desde-reserva (dep 5), +10 a diferencias (dep 1)
  const c9 = lineas.filter(l => l.idProducto === '9');
  assert.strictEqual(c9.find(l => l.concepto === 'consumo-reserva').cantidad, -90);
  assert.strictEqual(c9.find(l => l.concepto === 'consumo-reserva').idDeposito, 5);
  assert.strictEqual(c9.find(l => l.concepto === 'sobrante-desde-reserva').cantidad, -10);
  assert.strictEqual(c9.find(l => l.concepto === 'sobrante-a-diferencias').cantidad, 10);
  assert.strictEqual(c9.find(l => l.concepto === 'sobrante-a-diferencias').idDeposito, 1);
  // comp 7: sólo consumo, sin sobrante
  const c7 = lineas.filter(l => l.idProducto === '7');
  assert.strictEqual(c7.length, 1);
  assert.strictEqual(c7[0].cantidad, -50);
});

test('lineasAjusteMovimiento: usado 0 y sin sobrante no genera líneas', () => {
  const lineas = lineasAjusteMovimiento([{ plu: '9', nombre: 'G', reservado: 40, usado: 0, sobrante: 40 }], { reserva: 5, diferencias: 1 });
  // usado 0 → sin consumo; sobrante 40 → dos líneas (devolución)
  assert.strictEqual(lineas.filter(l => l.concepto === 'consumo-reserva').length, 0);
  assert.strictEqual(lineas.filter(l => l.concepto.startsWith('sobrante')).length, 2);
});

test('lineasAjusteMovimiento: componente sin plu se ignora', () => {
  assert.strictEqual(lineasAjusteMovimiento([{ plu: '', usado: 10, sobrante: 0 }], { reserva: 5, diferencias: 1 }).length, 0);
});
