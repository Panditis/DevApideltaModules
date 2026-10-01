const test = require('node:test');
const assert = require('node:assert');
const { parseFechaHora, segundosATexto, parseBajada, ErrorCruce } = require('../lib/cruce_bancario');
const { ENCABEZADO, filaBanco, pie } = require('./cruce_bancario_fixtures');

const EPOCH_REF = Date.UTC(2026, 8, 22, 19, 58, 42) / 1000;

// ── Fecha ─────────────────────────────────────────────────────────────────────
test('parseFechaHora lee texto ISO con segundos', () => {
  assert.strictEqual(parseFechaHora('2026-09-22 19:58:42'), EPOCH_REF);
});

test('parseFechaHora lee dd/mm/aaaa con segundos opcionales', () => {
  assert.strictEqual(parseFechaHora('22/09/2026 19:58:42'), EPOCH_REF);
  assert.strictEqual(parseFechaHora('22/09/2026 19:58'), EPOCH_REF - 42);
});

test('parseFechaHora lee el número serial de Excel', () => {
  const serial = EPOCH_REF / 86400 + 25569;
  assert.strictEqual(parseFechaHora(serial), EPOCH_REF);
});

test('parseFechaHora rechaza lo que no es una fecha con hora', () => {
  assert.strictEqual(parseFechaHora(1767758.88), null); // total del pie: fuera del rango de seriales
  assert.strictEqual(parseFechaHora('2026-02-31 10:00:00'), null);
  assert.strictEqual(parseFechaHora('2026-09-22'), null);
  assert.strictEqual(parseFechaHora('Total bruto'), null);
  assert.strictEqual(parseFechaHora(''), null);
  assert.strictEqual(parseFechaHora(undefined), null);
});

test('segundosATexto es la inversa de parseFechaHora', () => {
  assert.strictEqual(segundosATexto(EPOCH_REF), '2026-09-22 19:58:42');
});

// ── parseBajada ───────────────────────────────────────────────────────────────
test('parseBajada lee los movimientos con las columnas del archivo real', () => {
  const { movimientos, descartadas, totalControl } = parseBajada([
    ENCABEZADO,
    filaBanco({ fecha: '2026-09-22 19:58:42', importe: '13.898,00', auth: '008601', ref: 'ref-1' }),
    filaBanco({ fecha: '2026-09-22 19:55:02', importe: '11.615,00', marca: 'PCT', terminal: 'COELSA' }),
  ]);

  assert.strictEqual(movimientos.length, 2);
  assert.deepStrictEqual(movimientos[0], {
    fila: 2, segundos: EPOCH_REF, fecha: '2026-09-22 19:58:42', importe: 13898, centavos: 1389800,
    marca: 'Visa', metodo: 'Visa', autorizacion: '008601', referencia: 'ref-1', terminal: '',
    estado: 'Aprobada', tipo: 'Venta', aplica: true,
  });
  assert.strictEqual(movimientos[1].marca, 'PCT');
  assert.strictEqual(movimientos[1].terminal, 'COELSA');
  assert.strictEqual(descartadas, 0);
  assert.strictEqual(totalControl, null);
});

test('parseBajada convierte importes es-AR con centavos y celdas numéricas', () => {
  const { movimientos } = parseBajada([
    ENCABEZADO,
    filaBanco({ fecha: '2026-09-22 19:50:51', importe: '15.811,40' }),
    filaBanco({ fecha: '2026-09-22 19:26:05', importe: 27136.68 }),
  ]);
  assert.strictEqual(movimientos[0].centavos, 1581140);
  assert.strictEqual(movimientos[1].centavos, 2713668);
});

test('parseBajada no confunde "Importe" con "Importe propina"', () => {
  const { movimientos } = parseBajada([
    ['Fecha', 'Importe propina', 'Importe'],
    ['2026-09-22 10:00:00', '5,00', '100,00'],
  ]);
  assert.strictEqual(movimientos[0].importe, 100);
});

test('parseBajada encuentra el encabezado aunque no sea la primera fila', () => {
  const { movimientos } = parseBajada([
    ['Reporte de ventas'],
    [],
    ENCABEZADO,
    filaBanco({ fecha: '2026-09-22 10:00:00', importe: '100,00' }),
  ]);
  assert.strictEqual(movimientos.length, 1);
  assert.strictEqual(movimientos[0].fila, 4);
});

test('parseBajada ignora el pie y guarda el Total bruto como control', () => {
  const r = parseBajada([
    ENCABEZADO,
    filaBanco({ fecha: '2026-09-22 10:00:00', importe: '100,00' }),
    filaBanco({ fecha: '2026-09-22 11:00:00', importe: '250,50' }),
    ...pie(350.5),
  ]);
  assert.strictEqual(r.movimientos.length, 2);
  assert.strictEqual(r.descartadas, 0);
  assert.strictEqual(r.totalControl, 350.5);
});

test('parseBajada cuenta las filas con contenido y sin fecha válida, no las vacías', () => {
  const r = parseBajada([
    ENCABEZADO,
    filaBanco({ fecha: '2026-09-22 10:00:00', importe: '100,00' }),
    filaBanco({ fecha: 'sin fecha', importe: '50,00' }),
    [],
    ['', '', ''],
  ]);
  assert.strictEqual(r.movimientos.length, 1);
  assert.strictEqual(r.descartadas, 1);
});

test('parseBajada marca como no aplicables los estados, tipos e importes que no son una venta aprobada', () => {
  const { movimientos } = parseBajada([
    ENCABEZADO,
    filaBanco({ fecha: '2026-09-22 10:00:00', importe: '100,00' }),
    filaBanco({ fecha: '2026-09-22 10:01:00', importe: '100,00', estado: 'Anulada' }),
    filaBanco({ fecha: '2026-09-22 10:02:00', importe: '100,00', tipo: 'Devolución' }),
    filaBanco({ fecha: '2026-09-22 10:03:00', importe: '0,00' }),
  ]);
  assert.deepStrictEqual(movimientos.map(m => m.aplica), [true, false, false, false]);
});

test('parseBajada asume que aplica si el archivo no trae Estado ni Tipo', () => {
  const { movimientos } = parseBajada([
    ['Fecha', 'Importe'],
    ['2026-09-22 10:00:00', '100,00'],
  ]);
  assert.strictEqual(movimientos[0].aplica, true);
});

test('parseBajada falla con los encabezados leídos si faltan Fecha o Importe', () => {
  assert.throws(
    () => parseBajada([['Columna A', 'Columna B'], ['x', 'y']]),
    /Encabezados leídos: Columna A, Columna B/,
  );
});

test('parseBajada falla si no hay ningún movimiento con fecha válida', () => {
  assert.throws(() => parseBajada([ENCABEZADO]), /no tiene movimientos/);
});

test('parseBajada lanza ErrorCruce si faltan las columnas y lista la primera fila no vacía', () => {
  const grilla = [[], ['Reporte de ventas'], ['Columna A', 'Columna B'], ['x', 'y']];
  assert.throws(() => parseBajada(grilla), err => {
    assert.ok(err instanceof ErrorCruce);
    assert.strictEqual(err.name, 'ErrorCruce');
    assert.match(err.message, /Encabezados leídos: Reporte de ventas$/);
    return true;
  });
});

test('parseBajada lanza ErrorCruce si no hay ningún movimiento', () => {
  assert.throws(() => parseBajada([ENCABEZADO]), err => err instanceof ErrorCruce && /no tiene movimientos/.test(err.message));
});
