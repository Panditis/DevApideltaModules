const test = require('node:test');
const assert = require('node:assert');
const {
  horaDeFraccion, fechaDeLote, granelDe, cargaDeBloque, parseFilas, sinFechasCubiertas, salaDe,
} = require('../lib/resumenes_legacy');

const CABECERA = ['Codigo ingresado', 'Producto Ingresado', 'Cant ingresada', 'Lote', 'Empleado',
  'Obs', 'Sala', 'Hora Inicio', 'Hora Fin', 'Actividad', 'Envasado', 'Etiquetado', 'Empaquetado'];

// Bloque tal cual lo exporta el sistema viejo: producto, fila CODIGO con los inicios,
// primer componente con los fines, y el resto de los consumos.
const BLOQUE = [
  [90001, 'Miel Vidrio 500G', 600, '010226/0-90001', 'ANA', '', 'Sala Fraccionado', '', '', 'Maquina', 'ANA', 'BRUNO', 'CARLA'],
  ['CODIGO', 'PRODUCTO COMPONENTE', 'CANTIDAD', '010226/0-90001', 'ANA', '', 'Sala Fraccionado', '', '', 'Maquina', 0.3333333333333333, 0.3541666666666667, 0.3541666666666667],
  [3022737, 'Tapa Axial Negra 63MM', -600, '010226/0-90001', 'ANA', '', 'Sala Fraccionado', '', '', 'Maquina', 0.6666666666666666, 0.6875, 0.6875],
  [492, 'Envase Vidrio 500G', -600, '010226/0-90001', 'ANA', '', 'Sala Fraccionado', '', '', 'Maquina', '', '', ''],
  [9712, 'Miel Granel En Tambor', -300, '010226/0-90001', 'ANA', '', 'Sala Fraccionado', '', '', 'Maquina', '', '', ''],
];

test('horaDeFraccion convierte la fracción de día de Excel a HH:MM', () => {
  assert.strictEqual(horaDeFraccion(0.3333333333333333), '08:00');
  assert.strictEqual(horaDeFraccion(0.5), '12:00');
  assert.strictEqual(horaDeFraccion(0.6875), '16:30');
  assert.strictEqual(horaDeFraccion('9:05'), '09:05');   // algunos vienen ya escritos
  assert.strictEqual(horaDeFraccion(''), '');
  assert.strictEqual(horaDeFraccion(null), '');
  assert.strictEqual(horaDeFraccion(1.5), '');           // fuera del día: no es una hora
});

test('fechaDeLote saca la jornada del prefijo DDMMYY del lote', () => {
  assert.strictEqual(fechaDeLote('230226/0-15205'), '2026-02-23');
  assert.strictEqual(fechaDeLote('090126CDLR0-90739'), '2026-01-09');
  assert.strictEqual(fechaDeLote('TareaExtra0'), '');
  assert.strictEqual(fechaDeLote('991326/0-1'), '');     // día 99 y mes 13 no existen
  assert.strictEqual(fechaDeLote(''), '');
});

test('salaDe separa fraccionado de producción', () => {
  assert.strictEqual(salaDe('Sala Fraccionado'), 'fraccionado');
  assert.strictEqual(salaDe('Sala Produccion'), 'produccion');
  assert.strictEqual(salaDe(''), 'produccion');
});

test('granelDe elige el granel y nunca el packaging', () => {
  const comps = [
    { plu: '1', nombre: 'Tapa Axial Negra', cant: 600 },
    { plu: '2', nombre: 'Envase Vidrio 500G', cant: 600 },
    { plu: '3', nombre: 'Miel Granel En Tambor', cant: 300 },
  ];
  assert.strictEqual(granelDe(comps).plu, '3');          // 300 < 600, pero los otros son packaging
  // Sin ninguno que diga granel, gana el mayor consumo no-packaging.
  assert.strictEqual(granelDe([
    { plu: '1', nombre: 'Caja Carton', cant: 900 },
    { plu: '2', nombre: 'Nuez Pelada', cant: 12 },
  ]).plu, '2');
  assert.strictEqual(granelDe([]), null);
  assert.strictEqual(granelDe([{ plu: '1', nombre: 'Etiqueta', cant: 5 }]), null);
});

test('cargaDeBloque arma la carga con roles, horarios y granel', () => {
  const c = cargaDeBloque(BLOQUE, '2026-02-01');
  assert.strictEqual(c.fecha, '2026-02-01');
  assert.strictEqual(c.plu, '90001');
  assert.strictEqual(c.cantFraccionada, 600);
  assert.strictEqual(c.granelConsumido, 300);
  assert.strictEqual(c.nombreGranel, 'Miel Granel En Tambor');
  assert.strictEqual(c.sala, 'fraccionado');
  assert.strictEqual(c.id, 'legacy:010226/0-90001:90001');
  assert.deepStrictEqual(c.roles, [
    { rol: 'Envasado',    nombre: 'ANA',   desde: '08:00', hasta: '16:00' },
    { rol: 'Etiquetado',  nombre: 'BRUNO', desde: '08:30', hasta: '16:30' },
    { rol: 'Empaquetado', nombre: 'CARLA', desde: '08:30', hasta: '16:30' },
  ]);
  assert.strictEqual(c.desde, '08:00');   // el primero en entrar
  assert.strictEqual(c.hasta, '16:30');   // el último en salir
});

test('cargaDeBloque cae al empleado del lote cuando no hay roles cargados', () => {
  const c = cargaDeBloque([
    [7, 'Granola', 20, '010226/1-7', 'NOELIA', '', 'Sala Produccion', 0.375, 0.5, 'Manual', '', '', ''],
    [70, 'Avena Granel', -18, '010226/1-7', 'NOELIA', '', 'Sala Produccion', '', '', 'Manual', '', '', ''],
  ], '2026-02-01');
  assert.deepStrictEqual(c.roles, [{ rol: '', nombre: 'NOELIA', desde: '09:00', hasta: '12:00' }]);
  assert.strictEqual(c.sala, 'produccion');
  assert.strictEqual(c.granelConsumido, 18);
});

test('cargaDeBloque descarta el bloque sin fecha ni producto', () => {
  assert.strictEqual(cargaDeBloque([['CODIGO', 'PRODUCTO COMPONENTE', 'CANTIDAD', 'x']], ''), null);
  assert.strictEqual(cargaDeBloque([[1, 'Algo', 5, 'sin-fecha', 'ANA']], ''), null);
});

test('parseFilas corta bloques por lote y separa las tareas extra', () => {
  const rows = [
    CABECERA,
    ['', '', '', '', '', '', '', '', '', '', '', '', ''],   // fila vacía de separación
    [1, 'limpieza de arandanos', 0, 'TareaExtra1', 'KAREN', '', 'Sala Produccion', 0.3333333333333333, 0.375, '', '', '', ''],
    ...BLOQUE,
    [70200, 'Yogurt 1Kg', 40, '010226/2-70200', 'ANA', '', 'Sala Produccion', '', '', 'Manual', 'ANA', '', ''],
    ['CODIGO', 'PRODUCTO COMPONENTE', 'CANTIDAD', '010226/2-70200', 'ANA', '', 'Sala Produccion', '', '', 'Manual', 0.5, '', ''],
    [90739, 'Yogurt DEPOSITO GRANEL', -38, '010226/2-70200', 'ANA', '', 'Sala Produccion', '', '', 'Manual', 0.5833333333333334, '', ''],
  ];
  const { cargas, tareas } = parseFilas(rows);
  assert.strictEqual(cargas.length, 2);
  assert.deepStrictEqual(cargas.map(c => c.plu), ['90001', '70200']);
  assert.deepStrictEqual(cargas.map(c => c.sala), ['fraccionado', 'produccion']);
  assert.strictEqual(cargas[1].granelConsumido, 38);
  assert.deepStrictEqual(cargas[1].roles, [{ rol: 'Envasado', nombre: 'ANA', desde: '12:00', hasta: '14:00' }]);
  // La tarea sin producto no es una carga: sumaría horas sin unidades y hundiría el ritmo.
  assert.strictEqual(tareas.length, 1);
  assert.strictEqual(tareas[0].persona, 'KAREN');
  assert.strictEqual(tareas[0].tarea, 'limpieza de arandanos');
  assert.strictEqual(tareas[0].desde, '08:00');
  assert.strictEqual(tareas[0].hasta, '09:00');
  // La tarea extra no trae fecha propia: hereda la jornada dominante del archivo.
  assert.strictEqual(tareas[0].fecha, '2026-02-01');
});

test('parseFilas sin filas útiles devuelve vacío', () => {
  assert.deepStrictEqual(parseFilas([CABECERA]), { cargas: [], tareas: [] });
  assert.deepStrictEqual(parseFilas([]), { cargas: [], tareas: [] });
});

test('sinFechasCubiertas deja afuera las jornadas que ya están en el sistema nuevo', () => {
  const legacy = [
    { id: 'legacy:1', fecha: '2026-07-29' },
    { id: 'legacy:2', fecha: '2026-03-10' },
  ];
  const actuales = [{ id: 9, fecha: '2026-07-29' }];
  assert.deepStrictEqual(sinFechasCubiertas(legacy, actuales).map(c => c.id), ['legacy:2']);
  assert.strictEqual(sinFechasCubiertas(legacy, []).length, 2);
  assert.deepStrictEqual(sinFechasCubiertas(null, actuales), []);
});
