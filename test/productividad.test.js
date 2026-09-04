const test = require('node:test');
const assert = require('node:assert');
const {
  minutosDeHora, intervaloDe, minutosUnidos, kilosDeCarga, personasDeCarga, claveNombre,
  nombreLindo, consolidarPlan, resumenPersonas, resumenOrdenes, resumenPorDia,
  resumenProductosFraccionado, resumenProductos, claveSemana, resumenPeriodos,
  totales, unirPorId, enRango,
} = require('../lib/productividad');

test('claveSemana da la semana ISO con su lunes y su domingo', () => {
  // 2026-08-11 es martes: la semana va del lunes 10 al domingo 16.
  assert.deepStrictEqual(claveSemana('2026-08-11'), { clave: '2026-W33', desde: '2026-08-10', hasta: '2026-08-16' });
  assert.deepStrictEqual(claveSemana('2026-08-10'), claveSemana('2026-08-16'));   // lunes y domingo, misma semana
  assert.notDeepStrictEqual(claveSemana('2026-08-16'), claveSemana('2026-08-17'));// domingo vs lunes siguiente
  assert.strictEqual(claveSemana('no-es-fecha'), null);
});

test('claveMes va del 1 al último día del mes, incluido febrero', () => {
  const { claveMes, clavePeriodo } = require('../lib/productividad');
  assert.deepStrictEqual(claveMes('2026-08-11'), { clave: '2026-08', desde: '2026-08-01', hasta: '2026-08-31' });
  assert.deepStrictEqual(claveMes('2026-02-05'), { clave: '2026-02', desde: '2026-02-01', hasta: '2026-02-28' });
  assert.strictEqual(claveMes('2026-08'), null);
  // El día es su propio período.
  assert.deepStrictEqual(clavePeriodo('2026-08-11', 'dia'), { clave: '2026-08-11', desde: '2026-08-11', hasta: '2026-08-11' });
  assert.strictEqual(clavePeriodo('2026-08-11', 'semana').clave, '2026-W33');
  assert.strictEqual(clavePeriodo('2026-08-11', 'mes').clave, '2026-08');
  assert.strictEqual(clavePeriodo('basura', 'dia'), null);
});

test('resumenFamilias agrupa las presentaciones y ordena por kilos', () => {
  const { resumenFamilias } = require('../lib/productividad');
  // La familia sale de una función inyectada: acá, el nombre sin la presentación.
  const familiaDe = c => String(c.nombre || '').replace(/\s+\d+\w*$/, '');
  const cargas = [
    { id: 1, fecha: '2026-03-02', plu: 'A', nombre: 'Miel 500G', cantFraccionada: 10, granelConsumido: 5, empleado: 'Ana', desde: '08:00', hasta: '09:00' },
    { id: 2, fecha: '2026-03-02', plu: 'B', nombre: 'Miel 1KG',  cantFraccionada: 4,  granelConsumido: 4, empleado: 'Ana', desde: '08:00', hasta: '09:00' },
    { id: 3, fecha: '2026-03-03', plu: 'C', nombre: 'Granola 200G', cantFraccionada: 2, granelConsumido: 20, empleado: 'Bea', desde: '08:00', hasta: '10:00' },
  ];
  const fam = resumenFamilias(cargas, familiaDe);
  assert.deepStrictEqual(fam.map(f => f.familia), ['Granola', 'Miel']);   // 20 kg antes que 9
  const miel = fam[1];
  assert.strictEqual(miel.productos, 2);       // dos presentaciones, una familia
  assert.strictEqual(miel.kilos, 9);
  assert.strictEqual(miel.personas, 1);
  assert.strictEqual(miel.horas, 1);           // Ana hizo las dos en el mismo bloque
  assert.strictEqual(miel.kgPorHora, 9);
  // Sin clasificador, todo cae en una sola bolsa identificada.
  assert.deepStrictEqual(resumenFamilias(cargas, null).map(f => f.familia), ['Sin familia']);
});

test('resumenPeriodos suma las familias del período', () => {
  const { resumenPeriodos } = require('../lib/productividad');
  const familiaDe = c => String(c.nombre || '').replace(/\s+\d+\w*$/, '');
  const cargas = [
    { id: 1, fecha: '2026-03-02', plu: 'A', nombre: 'Miel 500G', cantFraccionada: 10, granelConsumido: 5, empleado: 'Ana', desde: '08:00', hasta: '09:00' },
    { id: 2, fecha: '2026-03-02', plu: 'B', nombre: 'Miel 1KG', cantFraccionada: 4, granelConsumido: 4, empleado: 'Ana', desde: '08:00', hasta: '09:00' },
  ];
  const [mes] = resumenPeriodos(cargas, 'mes', null, familiaDe);
  assert.strictEqual(mes.clave, '2026-03');
  assert.strictEqual(mes.familiasTotal, 1);
  assert.strictEqual(mes.familias[0].familia, 'Miel');
  assert.strictEqual(mes.productosDistintos, 2);
  assert.strictEqual(mes.productos[0].familia, 'Miel');   // el producto sabe a qué familia va
});

test('resumenPeriodos por día arma el ranking de productos y de personas', () => {
  const cargas = [
    { id: 1, fecha: '2026-03-02', plu: 'A', nombre: 'Miel', cantFraccionada: 100, granelConsumido: 50, empleado: 'Ana', desde: '08:00', hasta: '10:00' },
    { id: 2, fecha: '2026-03-02', plu: 'B', nombre: 'Granola', cantFraccionada: 10, granelConsumido: 5, empleado: 'Ana', desde: '10:00', hasta: '11:00' },
    { id: 3, fecha: '2026-03-02', plu: 'A', nombre: 'Miel', cantFraccionada: 20, granelConsumido: 9, empleado: 'Bea', desde: '08:00', hasta: '09:00' },
    { id: 4, fecha: '2026-03-03', plu: 'C', nombre: 'Mix', cantFraccionada: 5, granelConsumido: 4, empleado: 'Bea', desde: '08:00', hasta: '09:00' },
  ];
  const dias = resumenPeriodos(cargas, 'dia');
  assert.deepStrictEqual(dias.map(d => d.clave), ['2026-03-03', '2026-03-02']);   // más nuevo primero
  const d2 = dias[1];
  assert.strictEqual(d2.cargas, 3);
  assert.strictEqual(d2.kilos, 64);
  assert.strictEqual(d2.productosDistintos, 2);
  assert.strictEqual(d2.personasTotal, 2);
  // Productos por kilos: Miel (59) antes que Granola (5).
  assert.deepStrictEqual(d2.productos.map(p => p.plu), ['A', 'B']);
  // Personas por cuántos productos distintos hizo cada una: Ana (2) antes que Bea (1).
  assert.deepStrictEqual(d2.personas.map(p => [p.persona, p.productos]), [['Ana', 2], ['Bea', 1]]);
  assert.strictEqual(d2.horas, 4);   // Ana 08-11 son 3 h, Bea 08-09 es 1 h
});

test('resumenPeriodos por semana junta los días de la misma semana ISO', () => {
  const cargas = [
    { id: 1, fecha: '2026-03-02', plu: 'A', nombre: 'Miel', cantFraccionada: 10, granelConsumido: 10, empleado: 'Ana', desde: '08:00', hasta: '09:00' },
    { id: 2, fecha: '2026-03-06', plu: 'B', nombre: 'Mix',  cantFraccionada: 20, granelConsumido: 20, empleado: 'Ana', desde: '08:00', hasta: '09:00' },
    { id: 3, fecha: '2026-03-09', plu: 'A', nombre: 'Miel', cantFraccionada: 30, granelConsumido: 30, empleado: 'Bea', desde: '08:00', hasta: '09:00' },
  ];
  const sem = resumenPeriodos(cargas, 'semana');
  assert.strictEqual(sem.length, 2);
  const primera = sem[1];
  assert.strictEqual(primera.desde, '2026-03-02');
  assert.strictEqual(primera.hasta, '2026-03-08');
  assert.strictEqual(primera.cargas, 2);
  assert.strictEqual(primera.kilos, 30);
  assert.strictEqual(primera.dias, 2);
  assert.strictEqual(primera.horas, 2);   // dos días distintos, una hora cada uno
});

test('resumenPeriodos cuenta las tareas extra aparte, sin sumarlas a la producción', () => {
  const cargas = [{ id: 1, fecha: '2026-03-02', plu: 'A', nombre: 'Miel', cantFraccionada: 10, granelConsumido: 10, empleado: 'Ana', desde: '08:00', hasta: '09:00' }];
  const tareas = [
    { id: 't1', fecha: '2026-03-02', persona: 'Ana', tarea: 'limpieza', desde: '09:00', hasta: '11:00' },
    { id: 't2', fecha: '2026-03-02', persona: 'Bea', tarea: 'preparación', desde: '09:00', hasta: '09:30' },
  ];
  const [d] = resumenPeriodos(cargas, 'dia', tareas);
  assert.strictEqual(d.tareas, 2);
  assert.strictEqual(d.horasTareas, 2.5);
  assert.strictEqual(d.horas, 1);            // las horas de producción no las incluyen
  assert.strictEqual(d.personasTotal, 1);    // Bea sólo hizo tareas: no es productora
});

test('resumenProductos conserva el nombre viejo como alias', () => {
  assert.strictEqual(resumenProductos, resumenProductosFraccionado);
});

test('resumenPorDia agrupa por jornada, ordena de lo más nuevo a lo más viejo y no infla horas', () => {
  const plan = [
    { fecha: '2026-08-10', idProducto: '1', producto: 'A', cantConfirmada: 100, responsables: ['Ana'],
      produccionMovimiento: { numeroMovimiento: 7 } },
    { fecha: '2026-08-10', idProducto: '2', producto: 'B', cantConfirmada: 50, responsables: ['ANA', 'Bea'],
      produccionMovimiento: { numeroMovimiento: 7 } },
    { fecha: '2026-08-11', idProducto: '3', producto: 'C', cantConfirmada: 30, responsables: [] },
  ];
  const cargas = [
    // Las dos cargas del día 10 las hace Ana en el MISMO bloque: es una hora, no dos.
    { id: 1, fecha: '2026-08-10', plu: '1', cantFraccionada: 80, granelConsumido: 10, empleado: 'Ana', desde: '08:00', hasta: '09:00', archivado: { numeroMovimiento: 7 } },
    { id: 2, fecha: '2026-08-10', plu: '2', cantFraccionada: 50, granelConsumido: 5,  empleado: 'Ana', desde: '08:00', hasta: '09:00', archivado: { numeroMovimiento: 7 } },
  ];
  const dias = resumenPorDia(plan, cargas, []);
  assert.deepStrictEqual(dias.map(d => d.fecha), ['2026-08-11', '2026-08-10']);
  const d10 = dias[1];
  assert.strictEqual(d10.lineas, 2);
  assert.strictEqual(d10.planificado, 150);
  assert.strictEqual(d10.producido, 130);
  assert.strictEqual(d10.kilos, 15);
  assert.strictEqual(d10.cargas, 2);
  assert.strictEqual(d10.horas, 1);
  assert.deepStrictEqual(d10.personas, ['Ana']);
  assert.deepStrictEqual(d10.asignados, ['Ana', 'Bea']);   // ANA y Ana son la misma
  assert.strictEqual(d10.ordenes.length, 2);
  // El día planificado sin producir queda listado igual, con 0%.
  assert.strictEqual(dias[0].producido, 0);
  assert.strictEqual(dias[0].pct, 0);
  assert.strictEqual(dias[0].cargas, 0);
});

test('resumenPorDia imputa cada carga a un solo día cuando el plan se movió de fecha', () => {
  // El mismo movimiento quedó en el plan del 10 y en el del 11: la carga es una sola.
  const plan = [
    { fecha: '2026-08-10', idProducto: '1', producto: 'A', cantConfirmada: 100, produccionMovimiento: { numeroMovimiento: 13 } },
    { fecha: '2026-08-11', idProducto: '1', producto: 'A', cantConfirmada: 100, produccionMovimiento: { numeroMovimiento: 13 } },
  ];
  const cargas = [{ id: 1, fecha: '2026-08-10', plu: '1', cantFraccionada: 90, granelConsumido: 9,
                    empleado: 'Ana', desde: '08:00', hasta: '09:00', archivado: { numeroMovimiento: 13 } }];
  const dias = resumenPorDia(plan, cargas, []);
  assert.strictEqual(dias.reduce((s, d) => s + d.producido, 0), 90);   // no 180
  assert.strictEqual(dias.reduce((s, d) => s + d.cargas, 0), 1);
  const d10 = dias.find(d => d.fecha === '2026-08-10');
  assert.strictEqual(d10.producido, 90);   // se imputa a la jornada más vieja que la reclama
  assert.strictEqual(dias.find(d => d.fecha === '2026-08-11').producido, 0);
});

test('resumenProductosFraccionado promedia el tiempo por tanda y excluye las sin horario', () => {
  const cargas = [
    { id: 1, fecha: '2026-08-03', plu: '91590', nombre: 'Azucar Mascabo', cantFraccionada: 10, granelConsumido: 10, empleado: 'Ana', desde: '08:00', hasta: '09:00' },
    { id: 2, fecha: '2026-08-04', plu: '91590', nombre: 'Azucar Mascabo', cantFraccionada: 20, granelConsumido: 20, empleado: 'Bea', desde: '08:00', hasta: '10:00' },
    { id: 3, fecha: '2026-08-05', plu: '91590', nombre: 'Azucar Mascabo', cantFraccionada: 5,  granelConsumido: 5,  empleado: 'Ana' },
  ];
  const [p] = resumenProductosFraccionado(cargas);
  assert.strictEqual(p.plu, '91590');
  assert.strictEqual(p.cargas, 3);
  assert.strictEqual(p.unidades, 35);
  assert.strictEqual(p.kilos, 35);
  assert.strictEqual(p.minPromedio, 90);       // (60 + 120) / 2, la carga sin horario no cuenta
  assert.strictEqual(p.sinHorario, 1);
  assert.strictEqual(p.minPorKilo, 5.14);      // 180 min / 35 kg
  assert.strictEqual(p.kgPorHora, 11.67);      // 35 kg / 3 h
  assert.strictEqual(p.dias, 3);
  assert.deepStrictEqual(p.personas, ['Ana', 'Bea']);
});

test('resumenProductosFraccionado ordena por kilos e ignora cargas sin PLU', () => {
  const r = resumenProductosFraccionado([
    { id: 1, fecha: '2026-08-03', plu: 'A', nombre: 'Chico', cantFraccionada: 1, granelConsumido: 1, empleado: 'Ana' },
    { id: 2, fecha: '2026-08-03', plu: 'B', nombre: 'Grande', cantFraccionada: 1, granelConsumido: 90, empleado: 'Ana' },
    { id: 3, fecha: '2026-08-03', nombre: 'Sin plu', cantFraccionada: 5, empleado: 'Ana' },
  ]);
  assert.deepStrictEqual(r.map(x => x.plu), ['B', 'A']);
  assert.strictEqual(r[0].minPromedio, null);   // ninguna carga tiene horario
});

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
