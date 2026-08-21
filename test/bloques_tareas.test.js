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
