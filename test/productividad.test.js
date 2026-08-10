const test = require('node:test');
const assert = require('node:assert');
const {
  minutosDeHora, intervaloDe, minutosUnidos, kilosDeCarga, personasDeCarga, claveNombre,
  nombreLindo, consolidarPlan, resumenPersonas, resumenOrdenes, totales, unirPorId, enRango,
} = require('../productividad');

test('claveNombre unifica el mismo nombre escrito distinto', () => {
  assert.strictEqual(claveNombre('MILAGROS'), claveNombre('milagros'));
  assert.strictEqual(claveNombre('  Ana   María '), claveNombre('ana maria'));
  assert.strictEqual(nombreLindo('MILAGROS'), 'Milagros');
  assert.strictEqual(nombreLindo('ana  maria'), 'Ana Maria');
});

test('resumenPersonas junta MILAGROS y milagros en una sola persona', () => {
  const cargas = [
    { id: 1, fecha: '2026-08-03', plu: '1', cantFraccionada: 10, granelConsumido: 10, empleado: 'MILAGROS', desde: '08:00', hasta: '09:00' },
    { id: 2, fecha: '2026-08-04', plu: '2', cantFraccionada: 20, granelConsumido: 20, empleado: 'milagros', desde: '08:00', hasta: '09:00' },
  ];
  const r = resumenPersonas(cargas);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].persona, 'Milagros');
  assert.strictEqual(r[0].kilos, 30);
  assert.strictEqual(r[0].horas, 2);   // días distintos: no se fusionan entre sí
});

test('consolidarPlan suma las líneas repetidas del mismo producto', () => {
  const plan = [
    { fecha: '2026-08-11', idProducto: '11121', cantConfirmada: 248, estado: 'listo',
      responsables: ['Analia'], produccionMovimiento: { numeroMovimiento: 13 } },
    { fecha: '2026-08-11', idProducto: '11121', cantConfirmada: 162, estado: 'pendiente',
      responsables: ['Karen'], produccionMovimiento: { numeroMovimiento: 13 } },
  ];
  const c = consolidarPlan(plan);
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].cantConfirmada, 410);
  assert.strictEqual(c[0].lineas, 2);
  assert.deepStrictEqual(c[0].responsables, ['Analia', 'Karen']);
  assert.strictEqual(c[0].estado, 'pendiente');
});

test('resumenOrdenes no cuenta la misma carga dos veces con el plan repetido', () => {
  const plan = [
    { fecha: '2026-08-11', idProducto: '91305', cantConfirmada: 200, produccionMovimiento: { numeroMovimiento: 13 } },
    { fecha: '2026-08-11', idProducto: '91305', cantConfirmada: 210, produccionMovimiento: { numeroMovimiento: 13 } },
  ];
  const cargas = [{ id: 1, fecha: '2026-08-11', plu: '91305', cantFraccionada: 400,
                    archivado: { numeroMovimiento: 13 } }];
  const { filas } = resumenOrdenes(plan, cargas, []);
  assert.strictEqual(filas.length, 1);
  assert.strictEqual(filas[0].planificado, 410);
  assert.strictEqual(filas[0].producido, 400);   // no 800
  assert.strictEqual(filas[0].lineasPlan, 2);
});

test('minutosDeHora parsea HH:MM y rechaza basura', () => {
  assert.strictEqual(minutosDeHora('08:30'), 510);
  assert.strictEqual(minutosDeHora('8:05'), 485);
  assert.strictEqual(minutosDeHora(''), null);
  assert.strictEqual(minutosDeHora('25:00'), null);
  assert.strictEqual(minutosDeHora('08:75'), null);
  assert.strictEqual(minutosDeHora(undefined), null);
});

test('intervaloDe descarta rangos vacíos o invertidos', () => {
  assert.deepStrictEqual(intervaloDe('08:00', '09:00'), [480, 540]);
  assert.strictEqual(intervaloDe('09:00', '08:00'), null);
  assert.strictEqual(intervaloDe('09:00', '09:00'), null);
  assert.strictEqual(intervaloDe('09:00', ''), null);
});

test('minutosUnidos fusiona solapados y suma los separados', () => {
  // Tres cargas en el mismo bloque = una hora, no tres.
  assert.strictEqual(minutosUnidos([[480, 540], [480, 540], [480, 540]]), 60);
  // Solapamiento parcial: 08:00-09:00 + 08:30-10:00 = 08:00-10:00.
  assert.strictEqual(minutosUnidos([[480, 540], [510, 600]]), 120);
  // Bloques separados se suman.
  assert.strictEqual(minutosUnidos([[480, 540], [600, 660]]), 120);
  // Contiguos no dejan hueco.
  assert.strictEqual(minutosUnidos([[480, 540], [540, 600]]), 120);
  assert.strictEqual(minutosUnidos([null, undefined]), 0);
});

test('kilosDeCarga prioriza granelConsumido y cae a graneles[] y a fórmula', () => {
  assert.strictEqual(kilosDeCarga({ granelConsumido: 140 }), 140);
  assert.strictEqual(kilosDeCarga({ graneles: [{ granelConsumido: 25 }, { granelConsumido: 5 }] }), 30);
  assert.strictEqual(kilosDeCarga({ cantFraccionada: 10, cantFormula: 0.5 }), 5);
  assert.strictEqual(kilosDeCarga(null), 0);
});

test('personasDeCarga toma roles, si no responsables, si no empleado', () => {
  assert.deepStrictEqual(
    personasDeCarga({ roles: [{ rol: 'Envasado', nombre: 'Paola', desde: '08:00', hasta: '09:00' }] }),
    [{ nombre: 'Paola', rol: 'Envasado', desde: '08:00', hasta: '09:00' }]);
  // responsables[] no trae horario propio: hereda el de la carga.
  assert.deepStrictEqual(
    personasDeCarga({ responsables: [{ nombre: 'Karen', rol: 'Tapado' }], desde: '10:00', hasta: '11:00' }),
    [{ nombre: 'Karen', rol: 'Tapado', desde: '10:00', hasta: '11:00' }]);
  assert.deepStrictEqual(
    personasDeCarga({ empleado: 'Micaela', desde: '08:00', hasta: '09:00' }),
    [{ nombre: 'Micaela', rol: '', desde: '08:00', hasta: '09:00' }]);
  assert.deepStrictEqual(personasDeCarga({ empleado: '   ' }), []);
});

test('resumenPersonas: bloque repetido cuenta una hora y el ritmo no se infla', () => {
  const cargas = [
    { id: 1, fecha: '2026-08-10', plu: '111', cantFraccionada: 100, granelConsumido: 30, empleado: 'Ana', desde: '08:00', hasta: '09:00' },
    { id: 2, fecha: '2026-08-10', plu: '222', cantFraccionada: 50,  granelConsumido: 20, empleado: 'Ana', desde: '08:00', hasta: '09:00' },
  ];
  const [ana] = resumenPersonas(cargas);
  assert.strictEqual(ana.persona, 'Ana');
  assert.strictEqual(ana.cargas, 2);
  assert.strictEqual(ana.productos, 2);
  assert.strictEqual(ana.unidades, 150);
  assert.strictEqual(ana.kilos, 50);
  assert.strictEqual(ana.horas, 1);          // 08:00-09:00 una sola vez
  assert.strictEqual(ana.kgPorHora, 50);
  assert.strictEqual(ana.unidPorHora, 150);
  assert.strictEqual(ana.dias, 1);
});

test('resumenPersonas prorratea la carga compartida: la suma da el total', () => {
  const cargas = [{
    id: 1, fecha: '2026-08-10', plu: '111', cantFraccionada: 200, granelConsumido: 80,
    roles: [{ rol: 'Envasado', nombre: 'Ana', desde: '08:00', hasta: '09:00' },
            { rol: 'Tapado',   nombre: 'Bea', desde: '08:00', hasta: '09:00' }],
  }];
  const r = resumenPersonas(cargas);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r.reduce((s, p) => s + p.unidades, 0), 200);
  assert.strictEqual(r.reduce((s, p) => s + p.kilos, 0), 80);
  assert.strictEqual(r[0].kilos, 40);
});

test('resumenPersonas sin horario deja el ritmo en null en vez de dividir por cero', () => {
  const [p] = resumenPersonas([{ id: 1, fecha: '2026-08-10', plu: '1', cantFraccionada: 10, empleado: 'Ana' }]);
  assert.strictEqual(p.horas, 0);
  assert.strictEqual(p.kgPorHora, null);
  assert.strictEqual(p.unidPorHora, null);
});

test('resumenPersonas ignora cargas sin responsable', () => {
  assert.deepStrictEqual(resumenPersonas([{ id: 1, fecha: '2026-08-03', plu: '1', cantFraccionada: 10, empleado: '' }]), []);
});

test('resumenOrdenes matchea por movimiento y calcula el cumplimiento', () => {
  const plan = [{ fecha: '2026-08-11', idProducto: '11121', producto: 'Yogurt', presentacion: '1.3 Kg',
                  cantConfirmada: 248, estado: 'pendiente', responsables: ['Analia'],
                  produccionMovimiento: { numeroMovimiento: 13 } }];
  const cargas = [{ id: 9, fecha: '2026-08-10', plu: '11121', cantFraccionada: 124, granelConsumido: 40,
                    desde: '08:00', hasta: '10:00', empleado: 'Paola', archivado: { numeroMovimiento: 13 } }];
  const { filas, sinPlan } = resumenOrdenes(plan, cargas, []);
  assert.strictEqual(filas.length, 1);
  assert.strictEqual(filas[0].producido, 124);
  assert.strictEqual(filas[0].pct, 50);
  assert.strictEqual(filas[0].movimiento, 13);
  assert.strictEqual(filas[0].horas, 2);
  assert.strictEqual(filas[0].unidPorHora, 62);
  assert.deepStrictEqual(filas[0].personas, ['Paola']);
  assert.deepStrictEqual(sinPlan, []);   // la carga quedó imputada al plan, no huérfana
});

test('resumenOrdenes usa el movimiento de la orden cuando la carga está viva', () => {
  const plan = [{ fecha: '2026-08-06', idProducto: '3035', producto: 'Yogurt Batido',
                  cantConfirmada: 50, produccionMovimiento: { numeroMovimiento: 54 } }];
  const cargas = [{ id: 1, ordenId: 777, fecha: '2026-08-07', plu: '3035', cantFraccionada: 50 }];
  const ordenes = [{ id: 777, reservaMovimientos: [54] }];
  const { filas, sinPlan } = resumenOrdenes(plan, cargas, ordenes);
  assert.strictEqual(filas[0].producido, 50);   // fechas distintas, matchea igual por movimiento
  assert.deepStrictEqual(sinPlan, []);
});

test('resumenOrdenes cae a fecha + plu y reporta lo no planificado', () => {
  const plan = [{ fecha: '2026-08-10', idProducto: '111', producto: 'X', cantSugerida: 100 }];
  const cargas = [
    { id: 1, fecha: '2026-08-10', plu: '111', cantFraccionada: 100 },
    { id: 2, fecha: '2026-08-10', plu: '999', nombre: 'Carga manual', cantFraccionada: 7, granelConsumido: 7 },
  ];
  const { filas, sinPlan } = resumenOrdenes(plan, cargas, []);
  assert.strictEqual(filas[0].producido, 100);
  assert.strictEqual(filas[0].pct, 100);
  assert.strictEqual(sinPlan.length, 1);
  assert.strictEqual(sinPlan[0].plu, '999');
  assert.strictEqual(sinPlan[0].kilos, 7);
});

test('resumenOrdenes con plan sin producir deja pct 0 y ritmo null', () => {
  const { filas } = resumenOrdenes([{ fecha: '2026-08-11', idProducto: '5', cantConfirmada: 10 }], [], []);
  assert.strictEqual(filas[0].producido, 0);
  assert.strictEqual(filas[0].pct, 0);
  assert.strictEqual(filas[0].unidPorHora, null);
});

test('totales no duplica horas de la misma persona en el mismo bloque', () => {
  const cargas = [
    { id: 1, fecha: '2026-08-10', plu: '1', cantFraccionada: 10, granelConsumido: 5, empleado: 'Ana', desde: '08:00', hasta: '09:00' },
    { id: 2, fecha: '2026-08-10', plu: '1', cantFraccionada: 20, granelConsumido: 6, empleado: 'Ana', desde: '08:00', hasta: '09:00' },
    { id: 3, fecha: '2026-08-10', plu: '2', cantFraccionada: 30, granelConsumido: 9, empleado: 'Bea', desde: '08:00', hasta: '09:00' },
  ];
  const t = totales(cargas);
  assert.strictEqual(t.cargas, 3);
  assert.strictEqual(t.unidades, 60);
  assert.strictEqual(t.kilos, 20);
  assert.strictEqual(t.personas, 2);
  assert.strictEqual(t.horas, 2);      // 1h de Ana + 1h de Bea
  assert.strictEqual(t.productos, 2);
  assert.strictEqual(t.dias, 1);
});

test('unirPorId descarta el mismo registro repetido entre archivo, historial y cierre', () => {
  const vivo = [{ id: 1, fecha: '2026-08-10' }];
  const hist = [{ id: 1, fecha: '2026-08-10' }, { id: 2, fecha: '2026-08-07' }];
  const cierre = [{ id: 2, fecha: '2026-08-07' }, { id: 3, fecha: '2026-07-30' }];
  assert.deepStrictEqual(unirPorId(vivo, hist, cierre).map(r => r.id), [1, 2, 3]);
  assert.deepStrictEqual(unirPorId(null, undefined, [null]), []);
});

test('enRango compara la fecha ISO como texto, inclusive en los bordes', () => {
  assert.strictEqual(enRango('2026-08-10', '2026-08-01', '2026-08-10'), true);
  assert.strictEqual(enRango('2026-08-01', '2026-08-01', '2026-08-10'), true);
  assert.strictEqual(enRango('2026-07-31', '2026-08-01', '2026-08-10'), false);
  assert.strictEqual(enRango('2026-08-11', '2026-08-01', '2026-08-10'), false);
  assert.strictEqual(enRango('', '2026-08-01', '2026-08-10'), false);
  assert.strictEqual(enRango('2026-08-11', null, null), true);
});
