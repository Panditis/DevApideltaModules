const test = require('node:test');
const assert = require('node:assert');
const { minutosDeHora, horaDeMinutos, duracionTarea, resolverPlantilla } = require('../bloques_tareas');

test('minutosDeHora y horaDeMinutos son inversas y rechazan basura', () => {
  assert.strictEqual(minutosDeHora('08:00'), 480);
  assert.strictEqual(minutosDeHora('8:05'), 485);
  assert.strictEqual(minutosDeHora('23:59'), 1439);
  assert.strictEqual(minutosDeHora('24:00'), null);
  assert.strictEqual(minutosDeHora('nada'), null);
  assert.strictEqual(minutosDeHora(''), null);
  assert.strictEqual(minutosDeHora(null), null);
  assert.strictEqual(horaDeMinutos(480), '08:00');
  assert.strictEqual(horaDeMinutos(1439), '23:59');
  // Una cadena larga no puede dar la vuelta al reloj y aparecer a la madrugada: se topa.
  assert.strictEqual(horaDeMinutos(1500), '23:59');
  assert.strictEqual(horaDeMinutos(-5), null);
});

test('duracionTarea suma minutos fijos + variables por cantidad', () => {
  const item = { cantConfirmada: 200, granelNecesario: 50 };
  // Sólo fijo: calentar el tambor tarda lo mismo para 10 que para 200 frascos.
  assert.strictEqual(duracionTarea({ minFijos: 90, minVar: 0, base: 'unidad' }, item), 90);
  // Fijo + variable por unidad: 10 + 0.5 * 200.
  assert.strictEqual(duracionTarea({ minFijos: 10, minVar: 0.5, base: 'unidad' }, item), 110);
  // Base kg: usa granelNecesario, no cantConfirmada.
  assert.strictEqual(duracionTarea({ minFijos: 0, minVar: 2, base: 'kg' }, item), 100);
  // Redondea al minuto y nunca da negativo.
  assert.strictEqual(duracionTarea({ minFijos: 0, minVar: 0.33, base: 'unidad' }, item), 66);
  assert.strictEqual(duracionTarea({ minFijos: -50, minVar: 0 }, item), 0);
  // Item sin cantidad: queda sólo el fijo.
  assert.strictEqual(duracionTarea({ minFijos: 15, minVar: 2, base: 'unidad' }, {}), 15);
});

test('duracionTarea no cambia con la cantidad de responsables', () => {
  const item = { cantConfirmada: 100 };
  const tarea = { minFijos: 10, minVar: 1, base: 'unidad' };
  const uno  = duracionTarea({ ...tarea, responsables: ['MICA'] }, item);
  const tres = duracionTarea({ ...tarea, responsables: ['MICA', 'JUAN', 'ANA'] }, item);
  assert.strictEqual(uno, 110);
  assert.strictEqual(tres, 110);
});

test('resolverPlantilla prefiere la del producto sobre la del rubro', () => {
  const plantillas = [
    { id: 1, alcance: 'rubro',    clave: 'Miel acacia', tareas: [] },
    { id: 2, alcance: 'producto', clave: '4039',        tareas: [] },
  ];
  const item = { idProducto: '4039', rubro: 'Miel acacia' };
  assert.strictEqual(resolverPlantilla(plantillas, item).id, 2);
  // Sin plantilla de producto cae al rubro, sin importar mayúsculas ni espacios.
  assert.strictEqual(resolverPlantilla(plantillas, { idProducto: '9999', rubro: ' MIEL ACACIA ' }).id, 1);
  // El idProducto puede venir numérico desde el plan.
  assert.strictEqual(resolverPlantilla(plantillas, { idProducto: 4039 }).id, 2);
  // Sin nada que matchee, null: el item queda "sin plantilla", no rompe.
  assert.strictEqual(resolverPlantilla(plantillas, { idProducto: '1', rubro: 'Dulces' }), null);
  assert.strictEqual(resolverPlantilla(null, { idProducto: '4039' }), null);
});

const { generarBloques, recalcularHorarios, detectarSolapes, carrilesPorResponsable } = require('../bloques_tareas');

const PLANTILLA_MIEL = {
  id: 1, alcance: 'producto', clave: '4039', nombre: 'Miel Acacia 1Kg',
  tareas: [
    { nombre: 'Calentar tambor',      minFijos: 90, minVar: 0,   base: 'unidad', responsables: [] },
    { nombre: 'Cargar fraccionadora', minFijos: 30, minVar: 0,   base: 'unidad', responsables: ['JUAN'] },
    { nombre: 'Envasado',             minFijos: 10, minVar: 0.5, base: 'unidad', responsables: ['MICA'] },
  ],
};
const ITEM_MIEL = { id: 500, idProducto: '4039', producto: 'Miel Acacia Apidelta 1Kg', rubro: 'Miel acacia', cantConfirmada: 100 };

test('generarBloques instancia la plantilla con orden, duración y responsables por defecto', () => {
  const bloques = generarBloques(ITEM_MIEL, PLANTILLA_MIEL, 1000);
  assert.strictEqual(bloques.length, 3);
  assert.deepStrictEqual(bloques.map(b => b.tarea), ['Calentar tambor', 'Cargar fraccionadora', 'Envasado']);
  assert.deepStrictEqual(bloques.map(b => b.orden), [1, 2, 3]);
  assert.deepStrictEqual(bloques.map(b => b.minutos), [90, 30, 60]);
  assert.deepStrictEqual(bloques.map(b => b.id), [1000, 1001, 1002]);
  assert.strictEqual(bloques[0].itemId, 500);
  assert.strictEqual(bloques[0].producto, 'Miel Acacia Apidelta 1Kg');
  assert.deepStrictEqual(bloques[2].responsables, ['MICA']);
  assert.strictEqual(bloques[2].manual, false);
  // Se guarda contra qué cantidad se generó, para avisar si después la cambian en el plan.
  assert.strictEqual(bloques[0].cantGenerada, 100);
  // Sin plantilla no hay bloques y no explota.
  assert.deepStrictEqual(generarBloques(ITEM_MIEL, null, 1000), []);
  assert.deepStrictEqual(generarBloques(null, PLANTILLA_MIEL, 1000), []);
});

test('recalcularHorarios encadena cada producto desde el inicio de jornada', () => {
  const bloques = generarBloques(ITEM_MIEL, PLANTILLA_MIEL, 1000);
  const con = recalcularHorarios(bloques, '08:00');
  assert.deepStrictEqual(con.map(b => [b.inicio, b.fin]), [
    ['08:00', '09:30'],   // calentar 90'
    ['09:30', '10:00'],   // cargar 30'
    ['10:00', '11:00'],   // envasar 60'
  ]);
  // Jornada inválida o vacía: cae a las 08:00 en vez de quedar sin horarios.
  assert.strictEqual(recalcularHorarios(bloques, 'basura')[0].inicio, '08:00');
});

test('recalcularHorarios respeta el ancla manual y encadena desde ahí', () => {
  const bloques = generarBloques(ITEM_MIEL, PLANTILLA_MIEL, 1000);
  bloques[1].manual = true;
  bloques[1].inicio = '11:00';
  const con = recalcularHorarios(bloques, '08:00');
  assert.deepStrictEqual(con.map(b => [b.inicio, b.fin]), [
    ['08:00', '09:30'],
    ['11:00', '11:30'],   // ancla: no arranca al terminar el anterior
    ['11:30', '12:30'],   // el siguiente sigue al ancla
  ]);
});

test('recalcularHorarios arranca cada producto por su cuenta y marca lo que se pasa del día', () => {
  const otro = { id: 600, idProducto: '4042', producto: 'Miel Acacia 250G', rubro: 'Miel acacia', cantConfirmada: 20 };
  const bloques = [
    ...generarBloques(ITEM_MIEL, PLANTILLA_MIEL, 1000),
    ...generarBloques(otro, PLANTILLA_MIEL, 2000),
  ];
  const con = recalcularHorarios(bloques, '08:00');
  // Los dos productos arrancan a las 08:00: son cadenas independientes.
  assert.strictEqual(con.find(b => b.itemId === 500 && b.orden === 1).inicio, '08:00');
  assert.strictEqual(con.find(b => b.itemId === 600 && b.orden === 1).inicio, '08:00');
  // Un bloque enorme se topa en 23:59 y queda marcado.
  const largo = recalcularHorarios([{ id: 1, itemId: 9, orden: 1, minutos: 20 * 60, manual: false }], '18:00');
  assert.strictEqual(largo[0].fin, '23:59');
  assert.strictEqual(largo[0].excedeDia, true);
});

test('detectarSolapes cruza sólo bloques que comparten responsable', () => {
  const bloques = recalcularHorarios([
    { id: 1, itemId: 1, orden: 1, minutos: 60, responsables: ['MICA'], manual: true, inicio: '08:00' },
    { id: 2, itemId: 2, orden: 1, minutos: 30, responsables: ['MICA'], manual: true, inicio: '08:30' },
    { id: 3, itemId: 3, orden: 1, minutos: 60, responsables: ['JUAN'], manual: true, inicio: '08:30' },
    { id: 4, itemId: 4, orden: 1, minutos: 60, responsables: ['MICA'], manual: true, inicio: '09:00' },
    { id: 5, itemId: 5, orden: 1, minutos: 60, responsables: [],       manual: true, inicio: '08:00' },
  ], '08:00');
  const ids = detectarSolapes(bloques).sort();
  // 1 y 2 se pisan; 3 es de otra persona; 4 arranca justo cuando 1 termina; 5 no tiene a nadie.
  assert.deepStrictEqual(ids, [1, 2]);
});

test('carrilesPorResponsable pone un bloque en la fila de cada responsable', () => {
  const bloques = recalcularHorarios([
    { id: 1, itemId: 1, orden: 1, minutos: 60, responsables: ['MICA', 'JUAN'], manual: true, inicio: '08:00' },
    { id: 2, itemId: 2, orden: 1, minutos: 60, responsables: [],               manual: true, inicio: '09:00' },
  ], '08:00');
  const carriles = carrilesPorResponsable(bloques);
  assert.deepStrictEqual(carriles.map(c => c.responsable), ['JUAN', 'MICA', '']);
  assert.strictEqual(carriles[0].bloques.length, 1);
  assert.strictEqual(carriles[1].bloques.length, 1);
  // "Sin asignar" va último y agrupa los bloques sin responsable.
  assert.strictEqual(carriles[2].bloques[0].id, 2);
});
