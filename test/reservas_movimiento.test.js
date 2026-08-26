const test = require('node:test');
const assert = require('node:assert');
const { migrarReservas, saldoLedger, itemsSinReservar, reservadoPorMovimiento, conciliarPorMovimiento, depositosProduccion, lineasAjusteMovimiento, lineasDiferenciasProduccion, lineasProduccionDesdeConciliacion, ordenesProducidasDeReserva, motivoBloqueoProduccion, sanearSellosReserva } = require('../reservas_movimiento');

const setStr = (...ns) => new Set(ns.map(String));

test('sanearSellosReserva: sello de un movimiento vivo del plan no se toca', () => {
  const plan = { items: [{ id: 1, reservaMovimiento: { numeroMovimiento: 64 } }] };
  assert.strictEqual(sanearSellosReserva(plan, setStr(64), setStr(64)), plan);
});
test('sanearSellosReserva: sello de un movimiento revertido se suelta', () => {
  const plan = { items: [{ id: 1, reservaMovimiento: { numeroMovimiento: 64 } }] };
  const r = sanearSellosReserva(plan, setStr(), setStr(64));
  assert.strictEqual(r.items[0].reservaMovimiento, null);
  assert.strictEqual(plan.items[0].reservaMovimiento.numeroMovimiento, 64, 'no muta el plan original');
});
test('sanearSellosReserva: sello heredado de otro plan se suelta', () => {
  // 62 existe en el log pero pertenece a otro día: no está entre los vivos de este plan.
  const plan = { items: [{ id: 1, reservaMovimiento: { numeroMovimiento: 62 } }, { id: 2, reservaMovimiento: { numeroMovimiento: 15 } }] };
  const r = sanearSellosReserva(plan, setStr(15), setStr(15, 62));
  assert.strictEqual(r.items[0].reservaMovimiento, null);
  assert.strictEqual(r.items[1].reservaMovimiento.numeroMovimiento, 15);
});
test('sanearSellosReserva: sello que el log no conoce se respeta (bloquea de más)', () => {
  const plan = { items: [{ id: 1, reservaMovimiento: { numeroMovimiento: 7 } }] };
  assert.strictEqual(sanearSellosReserva(plan, setStr(), setStr(64)), plan);
});
test('sanearSellosReserva: compara como string y tolera plan sin items', () => {
  const plan = { items: [{ id: 1, reservaMovimiento: { numeroMovimiento: 64 } }] };
  assert.strictEqual(sanearSellosReserva(plan, setStr('64'), setStr('64')), plan);
  const vacio = { items: [] };
  assert.strictEqual(sanearSellosReserva(vacio, setStr(), setStr()), vacio);
  assert.strictEqual(sanearSellosReserva(null, setStr(), setStr()), null);
});

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

// Depósitos del movimiento de producción. El caso que motivó el forzado: con la reserva 1→2 y
// el combo de salida apuntando al depósito de reserva (2), el excedente sobre lo reservado se
// descontaba del 2 en vez del 1 (plan 2026-08-06, comprobante #5).
const CP_PROD = { depositoTerminados: null };
const CR_PROD = { depositoPrincipal: 1, depositoReserva: 2 };

test('depositosProduccion: con reserva activa el excedente sale del origen, no del de reserva', () => {
  const reserva = { estado: 'activa', depOrigen: 1, depDestino: 2 };
  const deps = depositosProduccion(CP_PROD, CR_PROD, reserva, { depSalida: 2, depDiferencias: 2, depRecepcion: 1 });
  assert.strictEqual(deps.salida, 1, 'el excedente se descuenta del depósito principal');
  assert.strictEqual(deps.diferencias, 1, 'el sobrante vuelve al depósito principal');
  assert.strictEqual(deps.reserva, 2);
  assert.strictEqual(deps.forzadosPorReserva, true);
});

test('depositosProduccion: con reserva activa la recepción de terminados sigue siendo elegible', () => {
  const reserva = { estado: 'activa', depOrigen: 1, depDestino: 2 };
  const deps = depositosProduccion(CP_PROD, CR_PROD, reserva, { depSalida: 2, depRecepcion: 7 });
  assert.strictEqual(deps.recepcion, 7);
  assert.strictEqual(deps.salida, 1);
});

test('depositosProduccion: sin reserva activa se eligen salida y recepción, diferencias sigue a salida', () => {
  const deps = depositosProduccion(CP_PROD, CR_PROD, { estado: 'anulada', depOrigen: 1, depDestino: 2 },
    { depSalida: 3, depRecepcion: 5 });
  assert.strictEqual(deps.salida, 3);
  assert.strictEqual(deps.diferencias, 3);
  assert.strictEqual(deps.recepcion, 5);
  assert.strictEqual(deps.forzadosPorReserva, false);
});

test('depositosProduccion: depDiferencias elegido a mano se ignora siempre', () => {
  const conReserva = depositosProduccion(CP_PROD, CR_PROD, { estado: 'activa', depOrigen: 1, depDestino: 2 },
    { depDiferencias: 9 });
  assert.strictEqual(conReserva.diferencias, 1, 'con reserva manda su depOrigen');
  const sinReserva = depositosProduccion(CP_PROD, CR_PROD, null, { depSalida: 3, depDiferencias: 9 });
  assert.strictEqual(sinReserva.diferencias, 3, 'sin reserva sigue al depósito de salida');
});

test('depositosProduccion: sin reserva y sin elección cae al principal del config', () => {
  const deps = depositosProduccion(CP_PROD, CR_PROD, null, {});
  assert.strictEqual(deps.salida, 1);
  assert.strictEqual(deps.diferencias, 1);
  assert.strictEqual(deps.recepcion, 1);
  assert.strictEqual(deps.reserva, 2);
  assert.strictEqual(deps.forzadosPorReserva, false);
});

test('depositosProduccion: reserva activa con depOrigen inválido no fuerza nada', () => {
  const deps = depositosProduccion(CP_PROD, CR_PROD, { estado: 'activa', depOrigen: 0, depDestino: 2 }, { depSalida: 3 });
  assert.strictEqual(deps.salida, 3);
  assert.strictEqual(deps.forzadosPorReserva, false);
});

test('lineasAjusteMovimiento: sólo el consumo contra la reserva, sin las diferencias', () => {
  const deps = { reserva: 5, diferencias: 1 };
  const comps = [
    { plu: '9', nombre: 'G', reservado: 100, usado: 90, sobrante: 10 },
    { plu: '7', nombre: 'Envase', reservado: 50, usado: 50, sobrante: 0 },
  ];
  const lineas = lineasAjusteMovimiento(comps, deps);
  // El sobrante se fue al comprobante de diferencias: acá queda sólo el consumo.
  const c9 = lineas.filter(l => l.idProducto === '9');
  assert.strictEqual(c9.length, 1);
  assert.strictEqual(c9[0].concepto, 'consumo-reserva');
  assert.strictEqual(c9[0].cantidad, -90);
  assert.strictEqual(c9[0].idDeposito, 5);
  assert.strictEqual(lineas.filter(l => l.concepto.startsWith('sobrante')).length, 0);
  const c7 = lineas.filter(l => l.idProducto === '7');
  assert.strictEqual(c7.length, 1);
  assert.strictEqual(c7[0].cantidad, -50);
});

test('lineasAjusteMovimiento: usado 0 no genera líneas', () => {
  const lineas = lineasAjusteMovimiento([{ plu: '9', nombre: 'G', reservado: 40, usado: 0, sobrante: 40 }], { reserva: 5, diferencias: 1 });
  assert.strictEqual(lineas.length, 0);
});

// Ajuste por diferencias: comprobante propio con lo que se desvió de lo reservado.
test('lineasDiferenciasProduccion: se usó de más → excedente sale del depósito de origen', () => {
  // Caso real: Almendra reservada 2, usada 10 → 8 de más salen del principal (dep 1), no del 2.
  const lineas = lineasDiferenciasProduccion(
    [{ plu: '7019', nombre: 'Almendra', reservado: 2, usado: 10 }], { reserva: 2, diferencias: 1 });
  assert.strictEqual(lineas.length, 1);
  assert.strictEqual(lineas[0].concepto, 'excedente-a-origen');
  assert.strictEqual(lineas[0].cantidad, -8);
  assert.strictEqual(lineas[0].idDeposito, 1);
});

test('lineasDiferenciasProduccion: se usó de menos → sobrante vuelve de reserva al origen', () => {
  const lineas = lineasDiferenciasProduccion(
    [{ plu: '9', nombre: 'G', reservado: 100, usado: 90 }], { reserva: 5, diferencias: 1 });
  assert.strictEqual(lineas.length, 2);
  assert.strictEqual(lineas.find(l => l.concepto === 'sobrante-desde-reserva').cantidad, -10);
  assert.strictEqual(lineas.find(l => l.concepto === 'sobrante-desde-reserva').idDeposito, 5);
  assert.strictEqual(lineas.find(l => l.concepto === 'sobrante-a-diferencias').cantidad, 10);
  assert.strictEqual(lineas.find(l => l.concepto === 'sobrante-a-diferencias').idDeposito, 1);
});

test('lineasDiferenciasProduccion: coinciden reservado y usado → sin líneas', () => {
  const lineas = lineasDiferenciasProduccion(
    [{ plu: '9', nombre: 'G', reservado: 50, usado: 50 }], { reserva: 5, diferencias: 1 });
  assert.strictEqual(lineas.length, 0);
});

test('lineasDiferenciasProduccion: consumo sin reserva detrás no es diferencia', () => {
  const lineas = lineasDiferenciasProduccion(
    [{ plu: '9', nombre: 'G', reservado: 0, usado: 30 }], { reserva: 5, diferencias: 1 });
  assert.strictEqual(lineas.length, 0);
});

test('lineasDiferenciasProduccion: el neto por depósito cierra igual que el circuito viejo', () => {
  const deps = { reserva: 2, diferencias: 1 };
  const comps = [{ plu: '7019', nombre: 'Almendra', reservado: 2, usado: 10 }];
  const consumo = lineasAjusteMovimiento([{ plu: '7019', nombre: 'Almendra', reservado: 2, usado: 2 }], deps);
  const netoPorDep = [...consumo, ...lineasDiferenciasProduccion(comps, deps)]
    .reduce((acc, l) => ({ ...acc, [l.idDeposito]: (acc[l.idDeposito] || 0) + l.cantidad }), {});
  assert.strictEqual(netoPorDep[2], -2, 'del depósito de reserva sale lo reservado');
  assert.strictEqual(netoPorDep[1], -8, 'del principal sale el excedente');
});

test('lineasAjusteMovimiento: componente sin plu se ignora', () => {
  assert.strictEqual(lineasAjusteMovimiento([{ plu: '', usado: 10, sobrante: 0 }], { reserva: 5, diferencias: 1 }).length, 0);
});

// ── Bloqueo por produccion ya recepcionada ───────────────────────
// Devolver o revertir una reserva cuyas ordenes ya se produjeron devolveria al deposito de
// origen componentes que ya se consumieron: stock inventado en SiGA.
test('ordenesProducidasDeReserva: reserva sin ordenes producidas devuelve vacio', () => {
  const items = [{ id: 1, producto: 'Polen 100g' }, { id: 2, producto: 'Miel 500g' }];
  assert.deepStrictEqual(ordenesProducidasDeReserva({ ordenes: [1, 2] }, items), []);
});
test('ordenesProducidasDeReserva: detecta la orden con sello de produccion', () => {
  const items = [
    { id: 1, producto: 'Polen 100g', produccionMovimiento: { numeroMovimiento: 16480 } },
    { id: 2, producto: 'Miel 500g' }
  ];
  const r = ordenesProducidasDeReserva({ ordenes: [1, 2] }, items);
  assert.strictEqual(r.length, 1);
  assert.deepStrictEqual(r[0], { id: 1, producto: 'Polen 100g', numeroMovimiento: 16480 });
});
test('ordenesProducidasDeReserva: ignora ordenes fuera de la reserva', () => {
  const items = [{ id: 9, producto: 'Otro plan', produccionMovimiento: { numeroMovimiento: 1 } }];
  assert.deepStrictEqual(ordenesProducidasDeReserva({ ordenes: [1] }, items), []);
});
test('ordenesProducidasDeReserva: sello sin numeroMovimiento no bloquea', () => {
  const items = [{ id: 1, producto: 'Polen 100g', produccionMovimiento: { numeroMovimiento: null } }];
  assert.deepStrictEqual(ordenesProducidasDeReserva({ ordenes: [1] }, items), []);
});
test('ordenesProducidasDeReserva: compara ids como string (numero vs texto)', () => {
  const items = [{ id: '1', producto: 'Polen 100g', produccionMovimiento: { numeroMovimiento: 7 } }];
  assert.strictEqual(ordenesProducidasDeReserva({ ordenes: [1] }, items).length, 1);
});
test('ordenesProducidasDeReserva: tolera reserva o items ausentes', () => {
  assert.deepStrictEqual(ordenesProducidasDeReserva(null, null), []);
  assert.deepStrictEqual(ordenesProducidasDeReserva({}, []), []);
  assert.deepStrictEqual(ordenesProducidasDeReserva({ ordenes: null }, [{ id: 1 }]), []);
});
test('motivoBloqueoProduccion: sin producidas devuelve null', () => {
  assert.strictEqual(motivoBloqueoProduccion([], 'devolver la reserva'), null);
  assert.strictEqual(motivoBloqueoProduccion(null, 'devolver la reserva'), null);
});
test('motivoBloqueoProduccion: una orden usa singular y nombra la accion', () => {
  const msg = motivoBloqueoProduccion(
    [{ id: 1, producto: 'Polen 100g', numeroMovimiento: 16480 }], 'devolver la reserva');
  assert.match(msg, /No se puede devolver la reserva/);
  assert.match(msg, /la orden "Polen 100g" \(movimiento #16480\)/);
  assert.match(msg, /fue producida y recepcionada/);
});
test('motivoBloqueoProduccion: varias ordenes usan plural y se listan todas', () => {
  const msg = motivoBloqueoProduccion([
    { id: 1, producto: 'Polen 100g', numeroMovimiento: 16480 },
    { id: 2, producto: 'Miel 500g',  numeroMovimiento: 16481 }
  ], 'revertir este movimiento');
  assert.match(msg, /las ordenes|las órdenes/);
  assert.match(msg, /fueron producidas y recepcionadas/);
  assert.match(msg, /Polen 100g/);
  assert.match(msg, /Miel 500g/);
});
test('motivoBloqueoProduccion: sin nombre de producto cae al id', () => {
  const msg = motivoBloqueoProduccion([{ id: 42, producto: '', numeroMovimiento: 5 }], 'devolver la reserva');
  assert.match(msg, /"42"/);
});

// ── Alta del terminado con reserva mayorista ──────────────────────────────────
// Lo que cubre una reserva mayorista viva entra al deposito de RESERVA, no al de recepcion:
// es de ahi que la factura del mayorista lo va a descontar. El resto entra donde siempre.

test('parte el alta del terminado entre reserva y recepcion', () => {
  // Arrange
  const c = { productos: [{ plu: '40222', nombre: 'Almendras Pedido', cantidad: 10 }],
              componentes: [], componentesManual: [] };
  const deps = { salida: 1, recepcion: 2, diferencias: 1, reserva: 3 };
  const reservadoPorTerminado = new Map([['40222', 6]]);

  // Act
  const { lineas } = lineasProduccionDesdeConciliacion(c, deps, { reservadoPorTerminado });

  // Assert
  const aReserva = lineas.find(l => l.concepto === 'terminado-reserva');
  const aRecepcion = lineas.find(l => l.concepto === 'terminado');
  assert.strictEqual(aReserva.idDeposito, 3);
  assert.strictEqual(aReserva.cantidad, 6);
  assert.strictEqual(aRecepcion.idDeposito, 2);
  assert.strictEqual(aRecepcion.cantidad, 4);
});

test('sin reserva mayorista el terminado entero va a recepcion', () => {
  // Arrange
  const c = { productos: [{ plu: '40222', nombre: 'Almendras Pedido', cantidad: 10 }],
              componentes: [], componentesManual: [] };
  const deps = { salida: 1, recepcion: 2, diferencias: 1, reserva: 3 };

  // Act
  const { lineas, resumen } = lineasProduccionDesdeConciliacion(c, deps, {});

  // Assert: identico a lo de siempre, una sola linea.
  assert.strictEqual(lineas.length, 1);
  assert.strictEqual(lineas[0].concepto, 'terminado');
  assert.strictEqual(lineas[0].idDeposito, 2);
  assert.strictEqual(lineas[0].cantidad, 10);
  assert.strictEqual(resumen.terminados, 1);
});

test('la reserva mayorista que supera lo producido no genera linea de recepcion', () => {
  // Arrange: la sala produjo 4 de las 6 apartadas.
  const c = { productos: [{ plu: '40222', nombre: 'Almendras Pedido', cantidad: 4 }],
              componentes: [], componentesManual: [] };
  const deps = { salida: 1, recepcion: 2, diferencias: 1, reserva: 3 };

  // Act
  const { lineas } = lineasProduccionDesdeConciliacion(c, deps, { reservadoPorTerminado: new Map([['40222', 6]]) });

  // Assert
  assert.strictEqual(lineas.length, 1);
  assert.strictEqual(lineas[0].concepto, 'terminado-reserva');
  assert.strictEqual(lineas[0].idDeposito, 3);
  assert.strictEqual(lineas[0].cantidad, 4);
});

test('un terminado de otro producto no se ve afectado por la reserva', () => {
  // Arrange
  const c = { productos: [{ plu: '40222', nombre: 'Almendras Pedido', cantidad: 10 },
                          { plu: '40333', nombre: 'Nueces Pedido', cantidad: 5 }],
              componentes: [], componentesManual: [] };
  const deps = { salida: 1, recepcion: 2, diferencias: 1, reserva: 3 };

  // Act
  const { lineas } = lineasProduccionDesdeConciliacion(c, deps, { reservadoPorTerminado: new Map([['40222', 6]]) });

  // Assert
  const nueces = lineas.filter(l => l.idProducto === '40333');
  assert.deepStrictEqual(nueces.map(l => [l.concepto, l.idDeposito, l.cantidad]), [['terminado', 2, 5]]);
});
