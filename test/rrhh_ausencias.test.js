const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const A = require('../rrhh_ausencias');

// ── Ausencias (RRHH) ─────────────────────────────────────────────────────────
// Dos parsers muy distintos convergen en el mismo registro: el resumen histórico
// es una tabla plana, y la bajada del reloj es una sábana ancha con un bloque de
// columnas por día. Los casos de acá son los que rompen en producción: fechas en
// serial de Excel, encabezados con tildes, planillas que cruzan fin de año y
// códigos del reloj que todavía nadie clasificó.

const DIR_DATOS = path.join(__dirname, '..', 'data', 'ausencias');
const XLSX_HISTORICO = path.join(DIR_DATOS, 'Ausencias_Resumen_2025-2026.xlsx');
const XLSX_FICHAJES  = path.join(DIR_DATOS, 'Apidelta_Fichajes_182026a2682026.xlsx');

// ── Utilidades de fecha ──────────────────────────────────────────────────────
test('aISO acepta Date, serial de Excel, ISO y DD/MM/AAAA', () => {
  assert.strictEqual(A.aISO(new Date(2025, 5, 2)), '2025-06-02');
  assert.strictEqual(A.aISO(45810), '2025-06-02');            // serial de Excel
  assert.strictEqual(A.aISO('2025-06-02 00:00:00'), '2025-06-02');
  assert.strictEqual(A.aISO('2/6/2025'), '2025-06-02');
  assert.strictEqual(A.aISO(''), '');
  assert.strictEqual(A.aISO('cualquier cosa'), '');
});

test('el día de semana no se corre por el huso horario', () => {
  // Con `new Date('2025-06-02')` en un huso negativo esto daría 'Dom'.
  assert.strictEqual(A.diaSemana('2025-06-02'), 'Lun');
  assert.strictEqual(A.diaSemana('2026-08-01'), 'Sab');
  assert.strictEqual(A.etiquetaMes('2025-12-31'), '2025-12 Dic');
});

test('anioDesdeNombre saca el año del nombre de la bajada', () => {
  assert.strictEqual(A.anioDesdeNombre('Apidelta_Fichajes_182026a2682026.xlsx'), 2026);
  assert.strictEqual(A.anioDesdeNombre('bajada_2027.xlsx'), 2027);
  assert.strictEqual(A.anioDesdeNombre('fichajes.xlsx'), null);
});

// ── Normalización ────────────────────────────────────────────────────────────
test('normalizarRegistro exige fecha y persona', () => {
  assert.throws(() => A.normalizarRegistro({ persona: 'Ana' }), /fecha/);
  assert.throws(() => A.normalizarRegistro({ fecha: '2025-06-02' }), /persona/);
});

test('normalizarRegistro completa grupo y tipo por defecto', () => {
  const r = A.normalizarRegistro({ fecha: '2025-06-02', persona: ' Ana  Perez ' }, 3);
  assert.strictEqual(r.persona, 'Ana Perez');
  assert.strictEqual(r.grupo, A.GRUPO_DEFAULT);
  assert.strictEqual(r.tipo, A.SIN_CLASIFICAR);
  assert.strictEqual(r.fuente, A.FUENTE_RELOJ);
  assert.strictEqual(r.id, '2025-06-02|Ana Perez|3');
});

test('clave ignora mayúsculas para deduplicar entre fuentes', () => {
  const a = { fecha: '2025-06-02', persona: 'Ana', tipo: 'Suspension' };
  const b = { fecha: '2025-06-02', persona: 'ANA', tipo: 'suspension' };
  assert.strictEqual(A.clave(a), A.clave(b));
});

// ── Parser del resumen histórico ─────────────────────────────────────────────
const CAB_HISTORICO = ['Fecha', 'Fuente', 'Mes', 'Dia', 'DiaSem', 'Persona', 'Hoja', 'Grupo', 'Tipo', 'Observacion'];

test('parsearDetalleHistorico mapea columnas por nombre y saltea filas vacías', () => {
  const regs = A.parsearDetalleHistorico([
    CAB_HISTORICO,
    ['2025-06-02 00:00:00', 'RELOJ', '2025-06 Jun', 2, 'Lun', 'Ana', '90.ana', 'Ausencia/Licencia', 'Licencia con Goce de Sueldo', 'Cumpleaños'],
    ['', '', '', '', '', '', '', '', '', ''],                          // fila vacía
    ['2025-06-03 00:00:00', 'CLOVER', '', '', '', '', '', '', '', ''], // sin persona
    ['2025-06-04 00:00:00', 'CLOVER', '2025-06 Jun', 4, 'Mie', 'Bruno Diaz', 'Bruno Diaz', 'Ausencia/Licencia', 'Suspension', ''],
  ]);
  assert.strictEqual(regs.length, 2);
  assert.deepStrictEqual(
    regs.map(r => [r.fecha, r.fuente, r.persona, r.tipo]),
    [['2025-06-02', 'RELOJ', 'Ana', 'Licencia con Goce de Sueldo'],
     ['2025-06-04', 'CLOVER', 'Bruno Diaz', 'Suspension']]
  );
  assert.strictEqual(regs[0].obs, 'Cumpleaños');
});

test('parsearDetalleHistorico no depende del orden de las columnas', () => {
  const regs = A.parsearDetalleHistorico([
    ['Persona', 'Tipo', 'Fecha', 'Fuente'],
    ['Ana', 'Suspension', '2025-06-02', 'RELOJ'],
  ]);
  assert.deepStrictEqual([regs[0].persona, regs[0].tipo, regs[0].fecha], ['Ana', 'Suspension', '2025-06-02']);
});

test('parsearDetalleHistorico rechaza una hoja que no es el resumen', () => {
  assert.throws(() => A.parsearDetalleHistorico([['Cosa', 'Otra'], [1, 2]]), /Fecha/);
});

// ── Parser de la bajada del reloj ────────────────────────────────────────────
// Sábana mínima con la misma anatomía que la real: dos días, bloques de ancho
// distinto, y el encabezado del día con tilde (MIÉRCOLES) como lo exporta el reloj.
function sabanaFichajes() {
  return [
    ['', '', '', '', '1-AGO SÁBADO', '', '', '', '4-AGO MIÉRCOLES', '', '', 'HORAS TOTALES'],
    ['LEGAJO', 'APELLIDO Y NOMBRE', 'DESTINO', 'RAZÓN SOCIAL', 'Ausencia', 'Entrada', 'Salida', 'Total Hs.', 'Ausencia', 'Entrada', 'Salida', ''],
    ['111', 'Perez Ana', 'Producción', 'SA', 'ESC-5', '', '', '', '', '08:00', '17:00', '9:00'],
    ['222', 'Diaz Bruno', 'Depósito', 'SA', '', '08:00', '17:00', '9:00', 'VA5', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],   // cola vacía de la planilla
  ];
}

test('parsearFichajes ubica la columna Ausencia de cada bloque de día', () => {
  const r = A.parsearFichajes(sabanaFichajes(), { anio: 2026, mapeo: { 'ESC-5': 'Suspension', VA5: 'Vacaciones' } });
  assert.strictEqual(r.registros.length, 2);
  assert.deepStrictEqual(
    r.registros.map(x => [x.fecha, x.persona, x.legajo, x.codigo, x.tipo]),
    [['2026-08-01', 'Perez Ana', '111', 'ESC-5', 'Suspension'],
     ['2026-08-04', 'Diaz Bruno', '222', 'VA5', 'Vacaciones']]
  );
  assert.deepStrictEqual(r.periodo, { desde: '2026-08-01', hasta: '2026-08-04' });
  assert.strictEqual(r.registros[0].destino, 'Producción');
  assert.strictEqual(r.registros[0].fuente, A.FUENTE_RELOJ);
});

test('parsearFichajes lista los códigos sin mapear y los deja sin tipo', () => {
  const r = A.parsearFichajes(sabanaFichajes(), { anio: 2026, mapeo: {} });
  assert.deepStrictEqual(r.sinMapear, ['ESC-5', 'VA5']);
  assert.deepStrictEqual(r.codigos.map(c => c.codigo).sort(), ['ESC-5', 'VA5']);
  assert.deepStrictEqual(r.registros.map(x => x.tipo), ['', '']);
});

test('parsearFichajes descarta los códigos mapeados a vacío', () => {
  const r = A.parsearFichajes(sabanaFichajes(), { anio: 2026, mapeo: { 'ESC-5': '', VA5: 'Vacaciones' } });
  assert.strictEqual(r.registros.length, 1);
  assert.strictEqual(r.registros[0].codigo, 'VA5');
  assert.deepStrictEqual(r.ignorados, { 'ESC-5': 1 });
  // Aunque se descarte, el código sigue contándose para que se vea en el detalle.
  assert.strictEqual(r.codigos.find(c => c.codigo === 'ESC-5').cantidad, 1);
});

test('parsearFichajes sube el año cuando la planilla cruza de diciembre a enero', () => {
  const r = A.parsearFichajes([
    ['', '', '', '', '30-DIC MARTES', '', '2-ENE VIERNES', ''],
    ['LEGAJO', 'APELLIDO Y NOMBRE', 'DESTINO', 'RAZÓN SOCIAL', 'Ausencia', 'Total Hs.', 'Ausencia', 'Total Hs.'],
    ['111', 'Perez Ana', '', '', 'VA5', '', 'VA5', ''],
  ], { anio: 2025, mapeo: { VA5: 'Vacaciones' } });
  assert.deepStrictEqual(r.registros.map(x => x.fecha), ['2025-12-30', '2026-01-02']);
});

test('parsearFichajes rechaza una planilla que no es la bajada del reloj', () => {
  assert.throws(() => A.parsearFichajes([['a'], ['b'], ['c']]), /Ausencia/);
  assert.throws(() => A.parsearFichajes([['a']]), /vacía|formato/);
});

// ── Filtros y agregaciones ───────────────────────────────────────────────────
const MUESTRA = [
  { fecha: '2025-06-02', fuente: 'RELOJ',  persona: 'Ana',   tipo: 'Suspension' },
  { fecha: '2025-06-03', fuente: 'RELOJ',  persona: 'Ana',   tipo: 'Licencia con Goce de Sueldo' },
  { fecha: '2025-07-01', fuente: 'CLOVER', persona: 'Bruno', tipo: 'Suspension' },
  { fecha: '2025-07-02', fuente: 'CLOVER', persona: 'Bruno', tipo: 'Suspension' },
].map(A.normalizarRegistro);

test('filtrar combina rango, fuente y búsqueda libre', () => {
  assert.strictEqual(A.filtrar(MUESTRA, { desde: '2025-07-01' }).length, 2);
  assert.strictEqual(A.filtrar(MUESTRA, { hasta: '2025-06-30' }).length, 2);
  assert.strictEqual(A.filtrar(MUESTRA, { fuentes: ['CLOVER'] }).length, 2);
  assert.strictEqual(A.filtrar(MUESTRA, { tipos: ['Suspension'], fuentes: ['RELOJ'] }).length, 1);
  assert.strictEqual(A.filtrar(MUESTRA, { q: 'bruno' }).length, 2);
  assert.strictEqual(A.filtrar(MUESTRA, {}).length, 4);
});

test('resumen agrupa por fuente, tipo, mes, día de semana y persona', () => {
  const R = A.resumen(MUESTRA);
  assert.strictEqual(R.total, 4);
  assert.strictEqual(R.personas, 2);
  assert.deepStrictEqual(R.periodo, { desde: '2025-06-02', hasta: '2025-07-02' });
  assert.strictEqual(R.promedioMes, 2);
  assert.deepStrictEqual(R.porFuente, [{ clave: 'CLOVER', cantidad: 2 }, { clave: 'RELOJ', cantidad: 2 }]);
  assert.deepStrictEqual(R.porMes.map(m => m.clave), ['2025-06 Jun', '2025-07 Jul']);
  assert.strictEqual(R.porTipo[0].clave, 'Suspension');
  assert.strictEqual(R.porTipo[0].cantidad, 3);
  // El día de semana sale en orden de semana, no alfabético, y con los ceros.
  assert.deepStrictEqual(R.porDiaSem.map(d => d.clave), A.DIAS_SEMANA_ORDEN);
  assert.strictEqual(R.porDiaSem.reduce((a, d) => a + d.cantidad, 0), 4);
});

test('porPersona arma el pivot persona × tipo ordenado por total', () => {
  const p = A.porPersona(MUESTRA);
  assert.deepStrictEqual(p.filas.map(f => [f.persona, f.total]), [['Ana', 2], ['Bruno', 2]]);
  assert.strictEqual(p.filas.find(f => f.persona === 'Ana').porTipo.Suspension, 1);
  assert.strictEqual(p.filas.find(f => f.persona === 'Bruno').porTipo.Suspension, 2);
  assert.ok(p.tipos.includes('Suspension'));
});

test('resumen de una lista vacía no divide por cero', () => {
  const R = A.resumen([]);
  assert.strictEqual(R.total, 0);
  assert.strictEqual(R.promedioMes, 0);
  assert.deepStrictEqual(R.periodo, { desde: '', hasta: '' });
});

// ── Contra las planillas reales ──────────────────────────────────────────────
// Se saltean si los xlsx no están en el checkout: son datos de la empresa, no
// fixtures del repo, pero cuando están tienen que parsear enteros.
const hayPlanillas = fs.existsSync(XLSX_HISTORICO) && fs.existsSync(XLSX_FICHAJES);

test('parsea el resumen histórico real', { skip: !hayPlanillas && 'faltan los xlsx en data/ausencias' }, () => {
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(XLSX_HISTORICO, { cellDates: true });
  const hoja = wb.Sheets['Detalle Ausencias'];
  const regs = A.parsearDetalleHistorico(XLSX.utils.sheet_to_json(hoja, { header: 1, raw: true, defval: '' }));
  assert.ok(regs.length > 400, `esperaba +400 registros, hubo ${regs.length}`);
  assert.ok(regs.every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.fecha)));
  assert.ok(regs.every(r => r.persona));
  const R = A.resumen(regs);
  // Los totales por fuente son los que la propia planilla informa en "Resumen".
  assert.strictEqual(R.porFuente.find(f => f.clave === 'RELOJ').cantidad, 326);
  assert.strictEqual(R.porFuente.find(f => f.clave === 'CLOVER').cantidad, 91);
  assert.strictEqual(R.porMes[0].clave, '2025-06 Jun');
});

test('parsea la bajada de fichajes real', { skip: !hayPlanillas && 'faltan los xlsx en data/ausencias' }, () => {
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(XLSX_FICHAJES, { cellDates: false });
  const matriz = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
  const r = A.parsearFichajes(matriz, { anio: A.anioDesdeNombre(path.basename(XLSX_FICHAJES)) });
  assert.deepStrictEqual(r.periodo, { desde: '2026-08-01', hasta: '2026-08-26' });
  assert.strictEqual(r.registros.length, 41);
  assert.ok(r.registros.every(x => x.legajo && x.persona));
  assert.deepStrictEqual(r.codigos.map(c => c.codigo).sort(), ['AGF', 'ESC-5', 'Exam', 'VA5', 'susp.']);
});
