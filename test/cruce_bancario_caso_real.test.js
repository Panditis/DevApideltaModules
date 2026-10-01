const nodeTest = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseBajada, normalizarTickets, cruzar, armarResumen, RESULTADO } = require('../lib/cruce_bancario');
const { ENCABEZADO, filaBanco, filaSql } = require('./cruce_bancario_fixtures');

// Regresión con el caso real del 22/09/2026: 62 movimientos del banco contra los 61 tickets que
// mostró SIGA ese día. El fixture sólo trae fecha/hora, importe y sucursal (sin datos de clientes);
// `esperado` es la sucursal correcta de cada movimiento, en el orden del archivo del banco.
// Son movimientos reales: el fixture está en .gitignore, no se versiona. Sin el archivo
// (otra máquina, producción) estos tests se saltean en vez de fallar.
const FIXTURE = path.join(__dirname, 'fixtures', 'cruce_bancario_caso_2026-09-22.json');
const hayFixture = fs.existsSync(FIXTURE);
const caso = hayFixture ? require(FIXTURE) : null;
const test = (nombre, fn) => nodeTest(nombre, { skip: !hayFixture && 'falta el fixture real (no versionado)' }, fn);
const CENTAVOS_DEL_DIA = 176775888;   // 1.767.758,88: suma del banco y de los tickets
const SIN_TICKET_A_TIEMPO = [39233.42, 52086.14];   // en SIGA el ticket es horas posterior al banco

const movimientos = () => parseBajada([
  ENCABEZADO,
  ...caso.movimientos.map(({ fecha, importe }) => filaBanco({ fecha, importe })),
]).movimientos;

// La imagen de SIGA trae el nombre de la sucursal, no su id.
const ticketsDeSiga = () => normalizarTickets(caso.tickets.map(({ hora, monto, sucursal }, i) => ({
  ...filaSql({ fecha: `${caso.fecha} ${hora}`, importe: monto, numero: String(i + 1) }),
  IdSucursal: null,
  NombreSucursal: sucursal,
})));

const cuenta = filas => filas.reduce((acc, f) => ({ ...acc, [f.resultado]: (acc[f.resultado] || 0) + 1 }), {});

test('el fixture del caso real tiene 62 movimientos, 61 tickets y las sumas del día', () => {
  const m = movimientos();
  assert.strictEqual(m.length, 62);
  assert.strictEqual(caso.tickets.length, 61);
  assert.strictEqual(caso.esperado.length, 62);
  assert.strictEqual(m.reduce((a, x) => a + x.centavos, 0), CENTAVOS_DEL_DIA);
  assert.strictEqual(ticketsDeSiga().reduce((a, t) => a + t.centavos, 0), CENTAVOS_DEL_DIA);
});

test('caso real 22/09/2026: con los defaults (5 pesos y 3 min) ubica 58, detecta los 2 pagos divididos y deja 2 a revisar', () => {
  const { filas } = cruzar(movimientos(), ticketsDeSiga());

  assert.strictEqual(filas.length, 62);
  // Sin SIN UBICAR, AMBIGUO ni NO APLICA: las claves que faltan valen cero.
  assert.deepStrictEqual(cuenta(filas), {
    [RESULTADO.UBICADO]: 58,
    [RESULTADO.PAGO_DIVIDIDO]: 2,
    [RESULTADO.A_REVISAR]: 2,
  });
});

test('caso real 22/09/2026: la sucursal del ticket es la correcta en las 62 filas', () => {
  const { filas } = cruzar(movimientos(), ticketsDeSiga());
  const ubicadas = filas.map((f, i) => ({ f, esperada: caso.esperado[i] })).filter(({ f }) => f.ticket);

  assert.strictEqual(ubicadas.length, 62);
  for (const { f, esperada } of ubicadas) {
    assert.strictEqual(f.ticket.sucursal, esperada, `movimiento de $${f.movimiento.importe} a las ${f.movimiento.fecha.slice(11)}`);
  }
});

test('caso real 22/09/2026: el pago dividido es de Urquiza y suma el ticket de 23.732,70', () => {
  const { filas } = cruzar(movimientos(), ticketsDeSiga());
  const divididas = filas.filter(f => f.resultado === RESULTADO.PAGO_DIVIDIDO);

  assert.deepStrictEqual(divididas.map(f => f.movimiento.importe).sort((a, b) => a - b), [600, 23132.7]);
  assert.deepStrictEqual(divididas.map(f => f.ticket.sucursal), ['Urquiza', 'Urquiza']);
  assert.deepStrictEqual(divididas.map(f => f.ticket.importe), [23732.7, 23732.7]);
  assert.deepStrictEqual(divididas.map(f => f.difImporte), [0, 0]);
  assert.strictEqual(divididas[0].pareja, divididas[1].movimiento);
  assert.strictEqual(divididas[1].pareja, divididas[0].movimiento);
});

test('caso real 22/09/2026: los dos de ticket posterior son A REVISAR de Rivadavia, con 3 y con 15 min', () => {
  for (const opciones of [{}, { tolMin: 15 }]) {
    const { filas } = cruzar(movimientos(), ticketsDeSiga(), opciones);
    const aRevisar = filas.map((f, i) => ({ f, i })).filter(({ f }) => f.resultado === RESULTADO.A_REVISAR);

    assert.deepStrictEqual(cuenta(filas), {
      [RESULTADO.UBICADO]: 58,
      [RESULTADO.PAGO_DIVIDIDO]: 2,
      [RESULTADO.A_REVISAR]: 2,
    });
    assert.deepStrictEqual(aRevisar.map(({ f }) => f.movimiento.importe).sort((a, b) => a - b), SIN_TICKET_A_TIEMPO);
    assert.deepStrictEqual(aRevisar.map(({ f }) => f.ticket.sucursal), ['Rivadavia', 'Rivadavia']);
    assert.deepStrictEqual(aRevisar.map(({ i }) => caso.esperado[i]), ['Rivadavia', 'Rivadavia']);
    for (const { f } of aRevisar) {
      assert.strictEqual(f.difImporte, 0);
      assert.strictEqual(f.ticket.importe, f.movimiento.importe);
      assert.ok(Math.abs(f.difSegundos) > 2 * 3600, `desfase de ${f.difSegundos} s`);
    }
  }
});

// ── Resumen estructurado ──────────────────────────────────────────────────────
// Totales por sucursal del banco, sacados del fixture (importe de cada movimiento y su sucursal
// `esperado`), sin pasar por el cruce. Orden del resumen: por id (el fixture no trae) y por nombre.
const TOTALES_POR_SUCURSAL = [
  ['Chacabuco', 8, 168893.15],
  ['Nación', 18, 515634.79],
  ['Pergamino', 2, 60203.68],
  ['Rivadavia', 16, 466878.89],
  ['San Pedro', 3, 65121.82],
  ['Urquiza', 14, 472940.55],
  ['Villa Ramallo', 1, 18086],
];

const resumenDelCaso = () => {
  const parse = parseBajada([
    ENCABEZADO,
    ...caso.movimientos.map(({ fecha, importe }) => filaBanco({ fecha, importe })),
  ]);
  const { filas, tolMonto, tolMin } = cruzar(parse.movimientos, ticketsDeSiga());
  return armarResumen({ filas, parse, tolMonto, tolMin });
};

test('caso real 22/09/2026: el resumen cuenta 58 UBICADO, 2 PAGO DIVIDIDO y 2 A REVISAR', () => {
  const resumen = resumenDelCaso();

  assert.deepStrictEqual(resumen.parametros, { tolMonto: 5, tolMin: 3 });
  assert.deepStrictEqual(
    resumen.porResultado.map(r => [r.resultado, r.cantidad]),
    [['UBICADO', 58], ['AMBIGUO', 0], ['PAGO DIVIDIDO', 2], ['A REVISAR', 2], ['SIN UBICAR', 0], ['NO APLICA', 0]],
  );
  assert.strictEqual(resumen.porResultado.reduce((a, r) => a + Math.round(r.importe * 100), 0), CENTAVOS_DEL_DIA);
  assert.strictEqual(resumen.archivo.leidos, 62);
  assert.strictEqual(resumen.archivo.descartadas, 0);
  assert.strictEqual(resumen.archivo.sumaAprobadas, CENTAVOS_DEL_DIA / 100);
  assert.strictEqual(resumen.archivo.sumaTodos, CENTAVOS_DEL_DIA / 100);
  // Sin SIN UBICAR no hay nada que avisar.
  assert.deepStrictEqual(resumen.avisos, { importeSinHora: 0 });
});

test('caso real 22/09/2026: la atención son los 2 A REVISAR de Rivadavia con sus observaciones', () => {
  const { atencion } = resumenDelCaso();

  assert.strictEqual(atencion.total, 2);
  assert.strictEqual(atencion.omitidas, 0);
  assert.deepStrictEqual(atencion.filas.map(f => f.importe).sort((a, b) => a - b), SIN_TICKET_A_TIEMPO);
  for (const f of atencion.filas) {
    assert.strictEqual(f.resultado, RESULTADO.A_REVISAR);
    assert.strictEqual(f.sucursal, 'Rivadavia');
    assert.strictEqual(f.otros, '');
    assert.match(f.observacion, /^Importe idéntico, pero la hora difiere: el ticket de SIGA está \d+ h \d+ min (antes|después) del banco\. Revisar\.$/);
    // La fila es la del xls (1 = encabezado) y la fecha, la del movimiento de esa fila.
    assert.strictEqual(f.fecha, caso.movimientos[f.fila - 2].fecha);
    assert.strictEqual(f.importe, caso.movimientos[f.fila - 2].importe);
    assert.ok(f.fechaTicket.startsWith(caso.fecha), f.fechaTicket);
  }
});

test('caso real 22/09/2026: el resumen por sucursal da los totales del fixture y marca los 2 a revisar en Rivadavia', () => {
  const { porSucursal } = resumenDelCaso();

  assert.deepStrictEqual(porSucursal.map(s => [s.nombre, s.cantidad, s.importe]), TOTALES_POR_SUCURSAL);
  assert.deepStrictEqual(porSucursal.map(s => [s.nombre, s.revisar]).filter(([, r]) => r > 0), [['Rivadavia', 2]]);
  assert.strictEqual(porSucursal.reduce((a, s) => a + s.cantidad, 0), 62);
  // Las sucursales del fixture no traen id: sale vacío, como en la columna del Detalle.
  assert.deepStrictEqual([...new Set(porSucursal.map(s => s.id))], ['']);
});
