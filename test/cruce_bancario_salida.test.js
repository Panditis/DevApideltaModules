const test = require('node:test');
const assert = require('node:assert');
const {
  parseBajada, normalizarTickets, cruzar, filasDetalle, filasResumen, armarResumen, sufijoRango,
  RESULTADO, COLUMNAS_DETALLE, MAX_OTROS_CANDIDATOS, MAX_ATENCION,
} = require('../lib/cruce_bancario');
const { ENCABEZADO, filaBanco, pie, filaSql } = require('./cruce_bancario_fixtures');

// Un ubicado, un sin ubicar y un anulado; el pie informa el total de las dos ventas aprobadas.
function escenario(totalPie = 14398) {
  const parse = parseBajada([
    ENCABEZADO,
    filaBanco({ fecha: '2026-09-22 19:58:42', importe: '13.898,00', marca: 'Visa', auth: 'A1', ref: 'R1' }),
    filaBanco({ fecha: '2026-09-22 10:00:00', importe: '500,00' }),
    filaBanco({ fecha: '2026-09-22 11:00:00', importe: '77,00', estado: 'Anulada' }),
    ...pie(totalPie),
  ]);
  const cruce = cruzar(
    parse.movimientos,
    normalizarTickets([filaSql({ suc: 3, fecha: '2026-09-22 19:57:10', importe: 13898, numero: '77' })]),
  );
  return { parse, cruce };
}

const fila = (aoa, etiqueta) => aoa.find(r => r[0] === etiqueta);

// ── filasDetalle ──────────────────────────────────────────────────────────────
test('filasDetalle devuelve una fila por movimiento con las columnas en orden', () => {
  const { cruce } = escenario();
  const detalle = filasDetalle(cruce.filas);

  assert.strictEqual(detalle.length, 3);
  assert.deepStrictEqual(Object.keys(detalle[0]), COLUMNAS_DETALLE);
  assert.strictEqual(detalle[0].Resultado, 'UBICADO');
  assert.strictEqual(detalle[0]['Fecha banco'], '2026-09-22 19:58:42');
  assert.strictEqual(detalle[0]['Importe banco'], 13898);
  assert.strictEqual(detalle[0]['Nº Autorización'], 'A1');
  assert.strictEqual(detalle[0]['Sucursal ID'], 3);
  assert.strictEqual(detalle[0].Sucursal, 'SUC 3');
  assert.strictEqual(detalle[0].Ticket, 'FC B 0001-77');
  assert.strictEqual(detalle[0]['Fecha ticket'], '2026-09-22 19:57:10');
  assert.strictEqual(detalle[0]['Importe ticket'], 13898);
  assert.strictEqual(detalle[0]['Dif. importe'], 0);
  assert.strictEqual(detalle[0]['Dif. segundos'], -92);
  assert.strictEqual(detalle[0]['Otros candidatos'], '');
});

test('filasDetalle deja vacíos los campos del ticket en SIN UBICAR y NO APLICA', () => {
  const { cruce } = escenario();
  const detalle = filasDetalle(cruce.filas);

  assert.strictEqual(detalle[1].Resultado, 'SIN UBICAR');
  assert.strictEqual(detalle[1].Sucursal, '');
  assert.strictEqual(detalle[1].Ticket, '');
  assert.strictEqual(detalle[1]['Dif. segundos'], '');
  assert.strictEqual(detalle[2].Resultado, 'NO APLICA');
  assert.strictEqual(detalle[2]['Estado banco'], 'Anulada');
});

test('filasDetalle lista los otros candidatos de un AMBIGUO', () => {
  const parse = parseBajada([ENCABEZADO, filaBanco({ fecha: '2026-09-22 10:00:00', importe: '100,00' })]);
  const cruce = cruzar(parse.movimientos, normalizarTickets([
    filaSql({ suc: 1, fecha: '2026-09-22 10:01:50', importe: 100, numero: '1' }),
    filaSql({ suc: 2, fecha: '2026-09-22 10:00:05', importe: 100.4, numero: '9' }),
  ]));
  const detalle = filasDetalle(cruce.filas);

  assert.strictEqual(detalle[0].Resultado, 'AMBIGUO');
  assert.strictEqual(detalle[0]['Otros candidatos'], 'SUC 2 · FC B 0001-9 · 10:00:05 · $100.40');
});

// ── filasResumen ──────────────────────────────────────────────────────────────
test('filasResumen informa parámetros, lectura y conteo por resultado', () => {
  const { parse, cruce } = escenario();
  const aoa = filasResumen({ filas: cruce.filas, parse, tolMonto: cruce.tolMonto, tolMin: cruce.tolMin });

  assert.strictEqual(fila(aoa, 'Tolerancia de importe ($)')[1], 5);
  assert.strictEqual(fila(aoa, 'Tolerancia de hora (min)')[1], 3);
  assert.strictEqual(fila(aoa, 'Movimientos leídos')[1], 3);
  assert.strictEqual(fila(aoa, 'Filas descartadas (sin fecha válida)')[1], 0);
  assert.strictEqual(fila(aoa, 'Desde')[1], '2026-09-22 10:00:00');
  assert.strictEqual(fila(aoa, 'Hasta')[1], '2026-09-22 19:58:42');
  assert.deepStrictEqual(fila(aoa, RESULTADO.UBICADO), ['UBICADO', 1, 13898]);
  assert.deepStrictEqual(fila(aoa, RESULTADO.AMBIGUO), ['AMBIGUO', 0, 0]);
  assert.deepStrictEqual(fila(aoa, RESULTADO.SIN_UBICAR), ['SIN UBICAR', 1, 500]);
  assert.deepStrictEqual(fila(aoa, RESULTADO.NO_APLICA), ['NO APLICA', 1, 77]);
});

test('filasResumen suma por sucursal los ubicados y ambiguos', () => {
  const { parse, cruce } = escenario();
  const aoa = filasResumen({ filas: cruce.filas, parse, tolMonto: cruce.tolMonto, tolMin: cruce.tolMin });
  const sucursal = aoa.find(r => r[1] === 'SUC 3');
  assert.deepStrictEqual(sucursal, [3, 'SUC 3', 1, 13898]);
});

test('filasResumen compara la suma de ventas aprobadas con el Total bruto del pie', () => {
  const ok = escenario(14398);
  const mal = escenario(14000);
  const sin = escenario(null);
  const de = ({ parse, cruce }) => filasResumen({ filas: cruce.filas, parse, tolMonto: 5, tolMin: 3 });

  assert.strictEqual(fila(de(ok), 'Suma de ventas aprobadas ($)')[1], 14398);
  assert.strictEqual(fila(de(ok), 'Total bruto del archivo ($)')[1], 14398);
  assert.strictEqual(fila(de(ok), 'Control contra Total bruto')[1], 'OK');
  assert.strictEqual(fila(de(mal), 'Control contra Total bruto')[1], 'NO COINCIDE');
  assert.strictEqual(fila(de(sin), 'Control contra Total bruto')[1], 'Sin total en el archivo');
});

// ── sufijoRango ───────────────────────────────────────────────────────────────
test('sufijoRango nombra el archivo con el día o con el rango de días', () => {
  const mismoDia = parseBajada([
    ENCABEZADO,
    filaBanco({ fecha: '2026-09-22 10:00:00', importe: '1,00' }),
    filaBanco({ fecha: '2026-09-22 18:00:00', importe: '1,00' }),
  ]).movimientos;
  const varios = parseBajada([
    ENCABEZADO,
    filaBanco({ fecha: '2026-09-24 10:00:00', importe: '1,00' }),
    filaBanco({ fecha: '2026-09-22 18:00:00', importe: '1,00' }),
  ]).movimientos;

  assert.strictEqual(sufijoRango(mismoDia), '2026-09-22');
  assert.strictEqual(sufijoRango(varios), '2026-09-22_a_2026-09-24');
});

// ── Otros candidatos acotados ─────────────────────────────────────────────────
// Un movimiento de $100 con `cantidad` tickets alternativos además del ganador (el de importe exacto).
function ambiguoCon(cantidad) {
  const parse = parseBajada([ENCABEZADO, filaBanco({ fecha: '2026-09-22 10:00:00', importe: '100,00' })]);
  const alternativos = Array.from({ length: cantidad }, (_, i) =>
    filaSql({ suc: 2, fecha: '2026-09-22 10:00:05', importe: 100.01 + i / 100, numero: String(100 + i) }));
  const ganador = filaSql({ suc: 1, fecha: '2026-09-22 10:00:05', importe: 100, numero: '1' });
  return cruzar(parse.movimientos, normalizarTickets([ganador, ...alternativos])).filas;
}

test('filasDetalle muestra como máximo 10 otros candidatos y cuenta los omitidos', () => {
  const texto = filasDetalle(ambiguoCon(12))[0]['Otros candidatos'];
  assert.strictEqual(texto.split(' | ').length, MAX_OTROS_CANDIDATOS + 1);
  assert.ok(texto.endsWith(' | y 2 más'), texto);
});

test('filasDetalle no agrega el sufijo si los otros candidatos son exactamente 10', () => {
  const texto = filasDetalle(ambiguoCon(10))[0]['Otros candidatos'];
  assert.strictEqual(texto.split(' | ').length, 10);
  assert.doesNotMatch(texto, /más/);
});

// ── Resumen: ambiguos y control ───────────────────────────────────────────────
test('filasResumen suma a su sucursal los movimientos AMBIGUO', () => {
  const parse = parseBajada([ENCABEZADO, filaBanco({ fecha: '2026-09-22 10:00:00', importe: '100,00' })]);
  const cruce = cruzar(parse.movimientos, normalizarTickets([
    filaSql({ suc: 1, fecha: '2026-09-22 10:00:05', importe: 100, numero: '1' }),
    filaSql({ suc: 2, fecha: '2026-09-22 10:00:06', importe: 100.4, numero: '2' }),
  ]));
  const aoa = filasResumen({ filas: cruce.filas, parse, tolMonto: 5, tolMin: 3 });

  assert.strictEqual(cruce.filas[0].resultado, RESULTADO.AMBIGUO);
  assert.deepStrictEqual(fila(aoa, RESULTADO.AMBIGUO), ['AMBIGUO', 1, 100]);
  assert.deepStrictEqual(aoa.find(r => r[1] === 'SUC 1'), [1, 'SUC 1', 1, 100]);
  assert.strictEqual(aoa.find(r => r[1] === 'SUC 2'), undefined);
});

test('filasResumen da OK si el Total bruto coincide con la suma de todos los movimientos (hay una anulada)', () => {
  // Aprobadas: 13.898 + 500 = 14.398. Todos los movimientos (con la anulada de 77): 14.475.
  const { parse, cruce } = escenario(14475);
  const aoa = filasResumen({ filas: cruce.filas, parse, tolMonto: 5, tolMin: 3 });

  assert.strictEqual(fila(aoa, 'Suma de ventas aprobadas ($)')[1], 14398);
  assert.strictEqual(fila(aoa, 'Suma de todos los movimientos leídos ($)')[1], 14475);
  assert.strictEqual(fila(aoa, 'Control contra Total bruto')[1], 'OK');
});

test('filasResumen pone la suma de todos los movimientos justo debajo de la de aprobadas', () => {
  const { parse, cruce } = escenario();
  const aoa = filasResumen({ filas: cruce.filas, parse, tolMonto: 5, tolMin: 3 });
  const i = aoa.findIndex(r => r[0] === 'Suma de ventas aprobadas ($)');
  assert.strictEqual(aoa[i + 1][0], 'Suma de todos los movimientos leídos ($)');
});

// ── Pago dividido ─────────────────────────────────────────────────────────────
// Dos transferencias (filas 2 y 3 del archivo) que suman un ticket de la sucursal 2, y una venta suelta.
function escenarioDividido() {
  const parse = parseBajada([
    ENCABEZADO,
    filaBanco({ fecha: '2026-09-22 18:39:05', importe: '23.132,70' }),
    filaBanco({ fecha: '2026-09-22 18:40:40', importe: '600,00' }),
    filaBanco({ fecha: '2026-09-22 09:00:00', importe: '500,00' }),
  ]);
  const cruce = cruzar(parse.movimientos, normalizarTickets([
    filaSql({ suc: 2, fecha: '2026-09-22 18:39:42', importe: 23732.7, numero: '5' }),
  ]));
  return { parse, cruce };
}

test('COLUMNAS_DETALLE termina con la columna Observación', () => {
  assert.strictEqual(COLUMNAS_DETALLE[COLUMNAS_DETALLE.length - 1], 'Observación');
});

test('filasDetalle explica en Observación el pago dividido con el movimiento pareja', () => {
  const { cruce } = escenarioDividido();
  const detalle = filasDetalle(cruce.filas);

  assert.deepStrictEqual(Object.keys(detalle[0]), COLUMNAS_DETALLE);
  assert.strictEqual(detalle[0].Resultado, 'PAGO DIVIDIDO');
  assert.strictEqual(detalle[0]['Observación'], 'Pago dividido con el movimiento de 18:40:40 por $600.00 (fila 3).');
  assert.strictEqual(detalle[1].Resultado, 'PAGO DIVIDIDO');
  assert.strictEqual(detalle[1]['Observación'], 'Pago dividido con el movimiento de 18:39:05 por $23132.70 (fila 2).');
});

test('filasDetalle completa de un pago dividido el ticket, la sucursal y las diferencias de cada movimiento', () => {
  const { cruce } = escenarioDividido();
  const [a, b] = filasDetalle(cruce.filas);

  for (const f of [a, b]) {
    assert.strictEqual(f['Sucursal ID'], 2);
    assert.strictEqual(f.Sucursal, 'SUC 2');
    assert.strictEqual(f.Ticket, 'FC B 0001-5');
    assert.strictEqual(f['Fecha ticket'], '2026-09-22 18:39:42');
    assert.strictEqual(f['Importe ticket'], 23732.7);
    assert.strictEqual(f['Dif. importe'], 0);
    assert.strictEqual(f['Otros candidatos'], '');
  }
  assert.strictEqual(a['Dif. segundos'], 37);
  assert.strictEqual(b['Dif. segundos'], -58);
});

test('filasDetalle deja vacía la Observación en los resultados que no son pago dividido', () => {
  const { cruce } = escenarioDividido();
  const { cruce: otro } = escenario();
  const detalle = [...filasDetalle(cruce.filas), ...filasDetalle(otro.filas)];

  assert.deepStrictEqual(detalle.map(d => d.Resultado), [
    'PAGO DIVIDIDO', 'PAGO DIVIDIDO', 'SIN UBICAR', 'UBICADO', 'SIN UBICAR', 'NO APLICA',
  ]);
  const otros = detalle.filter(d => d.Resultado !== 'PAGO DIVIDIDO');
  assert.strictEqual(otros.length, 4);
  for (const d of otros) assert.strictEqual(d['Observación'], '');
});

test('filasResumen cuenta el PAGO DIVIDIDO con sus dos movimientos y su importe', () => {
  const { parse, cruce } = escenarioDividido();
  const aoa = filasResumen({ filas: cruce.filas, parse, tolMonto: cruce.tolMonto, tolMin: cruce.tolMin });

  assert.deepStrictEqual(fila(aoa, RESULTADO.PAGO_DIVIDIDO), ['PAGO DIVIDIDO', 2, 23732.7]);
  assert.deepStrictEqual(fila(aoa, RESULTADO.SIN_UBICAR), ['SIN UBICAR', 1, 500]);
  const i = aoa.findIndex(r => r[0] === 'Resultado');
  assert.deepStrictEqual(
    aoa.slice(i + 1, i + 7).map(r => r[0]),
    ['UBICADO', 'AMBIGUO', 'PAGO DIVIDIDO', 'A REVISAR', 'SIN UBICAR', 'NO APLICA'],
  );
});

test('filasResumen suma a su sucursal los movimientos de un pago dividido', () => {
  const { parse, cruce } = escenarioDividido();
  const aoa = filasResumen({ filas: cruce.filas, parse, tolMonto: cruce.tolMonto, tolMin: cruce.tolMin });

  assert.deepStrictEqual(aoa.find(r => r[1] === 'SUC 2'), [2, 'SUC 2', 2, 23732.7]);
});

// ── A REVISAR ─────────────────────────────────────────────────────────────────
// Un movimiento de $52.086,14 a `horaBanco` y un ticket de la sucursal 2 por el mismo importe a `horaTicket`.
function escenarioARevisar(horaBanco, horaTicket) {
  const parse = parseBajada([
    ENCABEZADO,
    filaBanco({ fecha: `2026-09-22 ${horaBanco}`, importe: '52.086,14' }),
    filaBanco({ fecha: '2026-09-22 09:00:00', importe: '100,00' }),
  ]);
  const cruce = cruzar(parse.movimientos, normalizarTickets([
    filaSql({ suc: 2, fecha: `2026-09-22 ${horaTicket}`, importe: 52086.14, numero: '9' }),
    filaSql({ suc: 2, fecha: '2026-09-22 09:00:10', importe: 100, numero: '10' }),
  ]));
  return { parse, cruce };
}

const observacionARevisar = (horaBanco, horaTicket) => {
  const [revisar] = filasDetalle(escenarioARevisar(horaBanco, horaTicket).cruce.filas);
  assert.strictEqual(revisar.Resultado, 'A REVISAR');
  return revisar['Observación'];
};

test('filasDetalle explica en Observación el A REVISAR con el ticket horas después del banco', () => {
  assert.strictEqual(
    observacionARevisar('12:25:37', '19:45:42'),
    'Importe idéntico, pero la hora difiere: el ticket de SIGA está 7 h 20 min después del banco. Revisar.',
  );
});

test('filasDetalle explica en Observación el A REVISAR con el ticket horas antes del banco', () => {
  assert.strictEqual(
    observacionARevisar('19:45:42', '12:25:37'),
    'Importe idéntico, pero la hora difiere: el ticket de SIGA está 7 h 20 min antes del banco. Revisar.',
  );
});

test('filasDetalle muestra sólo minutos si la diferencia es menor a una hora y redondea hacia abajo', () => {
  assert.strictEqual(
    observacionARevisar('10:00:00', '10:45:30'),
    'Importe idéntico, pero la hora difiere: el ticket de SIGA está 45 min después del banco. Revisar.',
  );
  assert.strictEqual(
    observacionARevisar('10:59:59', '10:00:00'),
    'Importe idéntico, pero la hora difiere: el ticket de SIGA está 59 min antes del banco. Revisar.',
  );
  assert.strictEqual(
    observacionARevisar('10:00:00', '10:59:59'),
    'Importe idéntico, pero la hora difiere: el ticket de SIGA está 59 min después del banco. Revisar.',
  );
});

test('filasDetalle muestra la hora y los minutos desde la hora exacta (1 h 0 min)', () => {
  assert.strictEqual(
    observacionARevisar('10:00:00', '11:00:00'),
    'Importe idéntico, pero la hora difiere: el ticket de SIGA está 1 h 0 min después del banco. Revisar.',
  );
  assert.strictEqual(
    observacionARevisar('10:00:00', '12:33:20'),
    'Importe idéntico, pero la hora difiere: el ticket de SIGA está 2 h 33 min después del banco. Revisar.',
  );
});

test('filasDetalle completa de un A REVISAR el ticket, la sucursal y las diferencias', () => {
  const [revisar, ubicado] = filasDetalle(escenarioARevisar('12:25:37', '19:45:42').cruce.filas);

  assert.deepStrictEqual(Object.keys(revisar), COLUMNAS_DETALLE);
  assert.strictEqual(revisar['Sucursal ID'], 2);
  assert.strictEqual(revisar.Sucursal, 'SUC 2');
  assert.strictEqual(revisar.Ticket, 'FC B 0001-9');
  assert.strictEqual(revisar['Fecha ticket'], '2026-09-22 19:45:42');
  assert.strictEqual(revisar['Importe ticket'], 52086.14);
  assert.strictEqual(revisar['Dif. importe'], 0);
  assert.strictEqual(revisar['Dif. segundos'], 26405);
  assert.strictEqual(revisar['Otros candidatos'], '');
  assert.strictEqual(ubicado.Resultado, 'UBICADO');
  assert.strictEqual(ubicado['Observación'], '');
});

test('filasResumen cuenta el A REVISAR con su importe y lo suma a su sucursal junto con los demás', () => {
  const { parse, cruce } = escenarioARevisar('12:25:37', '19:45:42');
  const aoa = filasResumen({ filas: cruce.filas, parse, tolMonto: cruce.tolMonto, tolMin: cruce.tolMin });

  assert.deepStrictEqual(fila(aoa, RESULTADO.A_REVISAR), ['A REVISAR', 1, 52086.14]);
  assert.deepStrictEqual(fila(aoa, RESULTADO.UBICADO), ['UBICADO', 1, 100]);
  assert.deepStrictEqual(fila(aoa, RESULTADO.SIN_UBICAR), ['SIN UBICAR', 0, 0]);
  assert.deepStrictEqual(aoa.find(r => r[1] === 'SUC 2'), [2, 'SUC 2', 2, 52186.14]);
});

// ── armarResumen: el resumen estructurado ─────────────────────────────────────
const resumenDe = ({ parse, cruce }) => armarResumen({ filas: cruce.filas, parse, tolMonto: cruce.tolMonto, tolMin: cruce.tolMin });

// Un AMBIGUO (el ticket de SUC 1 gana; SUC 2 queda de alternativo), un A REVISAR y dos SIN UBICAR, mezclados
// a propósito en el archivo (filas 2 a 5) para comprobar que la atención se ordena por prioridad y por fecha.
function escenarioMezcla() {
  const parse = parseBajada([
    ENCABEZADO,
    filaBanco({ fecha: '2026-09-22 11:00:00', importe: '300,00' }),
    filaBanco({ fecha: '2026-09-22 09:00:00', importe: '100,00' }),
    filaBanco({ fecha: '2026-09-22 08:00:00', importe: '500,00' }),
    filaBanco({ fecha: '2026-09-22 12:25:37', importe: '52.086,14' }),
  ]);
  const cruce = cruzar(parse.movimientos, normalizarTickets([
    filaSql({ suc: 1, fecha: '2026-09-22 09:00:05', importe: 100, numero: '1' }),
    filaSql({ suc: 2, fecha: '2026-09-22 09:00:06', importe: 100.4, numero: '2' }),
    filaSql({ suc: 2, fecha: '2026-09-22 19:45:42', importe: 52086.14, numero: '9' }),
  ]));
  return { parse, cruce };
}

test('armarResumen informa parámetros, archivo y un renglón por resultado, en el orden de RESULTADO', () => {
  const resumen = resumenDe(escenario());

  assert.deepStrictEqual(resumen.parametros, { tolMonto: 5, tolMin: 3 });
  assert.deepStrictEqual(resumen.archivo, {
    leidos: 3,
    descartadas: 0,
    desde: '2026-09-22 10:00:00',
    hasta: '2026-09-22 19:58:42',
    sumaAprobadas: 14398,
    sumaTodos: 14475,
    totalBruto: 14398,
    control: 'OK',
  });
  assert.deepStrictEqual(resumen.porResultado, [
    { resultado: 'UBICADO', cantidad: 1, importe: 13898 },
    { resultado: 'AMBIGUO', cantidad: 0, importe: 0 },
    { resultado: 'PAGO DIVIDIDO', cantidad: 0, importe: 0 },
    { resultado: 'A REVISAR', cantidad: 0, importe: 0 },
    { resultado: 'SIN UBICAR', cantidad: 1, importe: 500 },
    { resultado: 'NO APLICA', cantidad: 1, importe: 77 },
  ]);
  assert.deepStrictEqual(resumen.porResultado.map(r => r.resultado), Object.values(RESULTADO));
});

test('armarResumen agrupa por sucursal los que tienen ticket y cuenta los que hay que revisar', () => {
  const resumen = resumenDe(escenario());
  assert.deepStrictEqual(resumen.porSucursal, [{ id: 3, nombre: 'SUC 3', cantidad: 1, importe: 13898, revisar: 0 }]);
});

test('armarResumen deja en la atención sólo el SIN UBICAR y no el UBICADO ni el NO APLICA', () => {
  const { atencion } = resumenDe(escenario());

  assert.strictEqual(atencion.total, 1);
  assert.strictEqual(atencion.omitidas, 0);
  assert.deepStrictEqual(atencion.filas, [{
    fila: 3,
    fecha: '2026-09-22 10:00:00',
    importe: 500,
    resultado: 'SIN UBICAR',
    sucursal: '',
    ticket: '',
    fechaTicket: '',
    observacion: '',
    otros: '',
  }]);
});

test('armarResumen da el control en sus tres valores', () => {
  const ok = resumenDe(escenario(14398)).archivo;
  const okConAnuladas = resumenDe(escenario(14475)).archivo;
  const mal = resumenDe(escenario(14000)).archivo;
  const sin = resumenDe(escenario(null)).archivo;

  assert.deepStrictEqual([ok.control, ok.totalBruto], ['OK', 14398]);
  assert.deepStrictEqual([okConAnuladas.control, okConAnuladas.totalBruto], ['OK', 14475]);
  assert.deepStrictEqual([mal.control, mal.totalBruto], ['NO COINCIDE', 14000]);
  assert.deepStrictEqual([sin.control, sin.totalBruto], ['SIN TOTAL', null]);
});

test('armarResumen cuenta el PAGO DIVIDIDO con sus dos movimientos y no lo manda a la atención', () => {
  const resumen = resumenDe(escenarioDividido());

  assert.deepStrictEqual(resumen.porResultado.find(r => r.resultado === 'PAGO DIVIDIDO'), { resultado: 'PAGO DIVIDIDO', cantidad: 2, importe: 23732.7 });
  assert.deepStrictEqual(resumen.porSucursal, [{ id: 2, nombre: 'SUC 2', cantidad: 2, importe: 23732.7, revisar: 0 }]);
  assert.deepStrictEqual(resumen.atencion.filas.map(f => f.resultado), ['SIN UBICAR']);
});

test('armarResumen pone el A REVISAR en la atención con su ticket y su observación, y lo suma a revisar de su sucursal', () => {
  const resumen = resumenDe(escenarioARevisar('12:25:37', '19:45:42'));

  assert.deepStrictEqual(resumen.porSucursal, [{ id: 2, nombre: 'SUC 2', cantidad: 2, importe: 52186.14, revisar: 1 }]);
  assert.strictEqual(resumen.atencion.total, 1);
  assert.deepStrictEqual(resumen.atencion.filas, [{
    fila: 2,
    fecha: '2026-09-22 12:25:37',
    importe: 52086.14,
    resultado: 'A REVISAR',
    sucursal: 'SUC 2',
    ticket: 'FC B 0001-9',
    fechaTicket: '2026-09-22 19:45:42',
    observacion: 'Importe idéntico, pero la hora difiere: el ticket de SIGA está 7 h 20 min después del banco. Revisar.',
    otros: '',
  }]);
});

test('armarResumen pone el AMBIGUO en la atención con los otros candidatos y lo suma a revisar de su sucursal', () => {
  const parse = parseBajada([ENCABEZADO, filaBanco({ fecha: '2026-09-22 10:00:00', importe: '100,00' })]);
  const cruce = cruzar(parse.movimientos, normalizarTickets([
    filaSql({ suc: 1, fecha: '2026-09-22 10:01:50', importe: 100, numero: '1' }),
    filaSql({ suc: 2, fecha: '2026-09-22 10:00:05', importe: 100.4, numero: '9' }),
  ]));
  const resumen = resumenDe({ parse, cruce });

  assert.deepStrictEqual(resumen.porSucursal, [{ id: 1, nombre: 'SUC 1', cantidad: 1, importe: 100, revisar: 1 }]);
  assert.deepStrictEqual(resumen.atencion.filas, [{
    fila: 2,
    fecha: '2026-09-22 10:00:00',
    importe: 100,
    resultado: 'AMBIGUO',
    sucursal: 'SUC 1',
    ticket: 'FC B 0001-1',
    fechaTicket: '2026-09-22 10:01:50',
    observacion: '',
    otros: 'SUC 2 · FC B 0001-9 · 10:00:05 · $100.40',
  }]);
  // El texto es el mismo de la columna del Detalle: no se arma dos veces.
  assert.strictEqual(resumen.atencion.filas[0].otros, filasDetalle(cruce.filas)[0]['Otros candidatos']);
});

test('armarResumen ordena la atención: A REVISAR, AMBIGUO y SIN UBICAR, y dentro de cada uno por fecha', () => {
  const resumen = resumenDe(escenarioMezcla());

  assert.deepStrictEqual(
    resumen.atencion.filas.map(f => [f.resultado, f.fila, f.fecha.slice(11)]),
    [['A REVISAR', 5, '12:25:37'], ['AMBIGUO', 3, '09:00:00'], ['SIN UBICAR', 4, '08:00:00'], ['SIN UBICAR', 2, '11:00:00']],
  );
  assert.strictEqual(resumen.atencion.total, 4);
  assert.deepStrictEqual(resumen.porSucursal.map(s => [s.nombre, s.cantidad, s.revisar]), [['SUC 1', 1, 1], ['SUC 2', 1, 1]]);
});

test('armarResumen recorta la atención a MAX_ATENCION sin sacar lo más urgente y cuenta las omitidas', () => {
  const sueltos = Array.from({ length: MAX_ATENCION + 5 }, (_, i) =>
    filaBanco({ fecha: `2026-09-22 ${String(8 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`, importe: '100,00' }));
  const parse = parseBajada([
    ENCABEZADO,
    ...sueltos,
    filaBanco({ fecha: '2026-09-22 23:00:00', importe: '52.086,14' }),
  ]);
  const cruce = cruzar(parse.movimientos, normalizarTickets([
    filaSql({ suc: 2, fecha: '2026-09-22 23:40:00', importe: 52086.14, numero: '9' }),
  ]));
  const { atencion } = resumenDe({ parse, cruce });

  assert.strictEqual(MAX_ATENCION, 200);
  assert.strictEqual(atencion.total, MAX_ATENCION + 6);
  assert.strictEqual(atencion.filas.length, MAX_ATENCION);
  assert.strictEqual(atencion.omitidas, 6);
  assert.strictEqual(atencion.filas[0].resultado, 'A REVISAR');
  assert.strictEqual(atencion.filas[1].resultado, 'SIN UBICAR');
  assert.strictEqual(atencion.filas[1].fila, 2);
  assert.strictEqual(atencion.filas[MAX_ATENCION - 1].fila, MAX_ATENCION);
});

test('armarResumen con todo resuelto deja la atención vacía', () => {
  const parse = parseBajada([ENCABEZADO, filaBanco({ fecha: '2026-09-22 10:00:00', importe: '100,00' })]);
  const cruce = cruzar(parse.movimientos, normalizarTickets([filaSql({ fecha: '2026-09-22 10:00:05', importe: 100 })]));

  assert.deepStrictEqual(resumenDe({ parse, cruce }).atencion, { total: 0, omitidas: 0, filas: [] });
});

test('armarResumen es JSON puro y no lleva datos personales del archivo', () => {
  const resumen = resumenDe(escenarioMezcla());

  assert.deepStrictEqual(JSON.parse(JSON.stringify(resumen)), resumen);
  assert.deepStrictEqual(Object.keys(resumen), ['parametros', 'archivo', 'porResultado', 'porSucursal', 'atencion', 'avisos']);
  assert.deepStrictEqual(Object.keys(resumen.atencion.filas[0]), [
    'fila', 'fecha', 'importe', 'resultado', 'sucursal', 'ticket', 'fechaTicket', 'observacion', 'otros',
  ]);
  assert.doesNotMatch(JSON.stringify(resumen), /CLIENTE|USUARIO|47045500|@/);
});

// ── SIN UBICAR con aviso ──────────────────────────────────────────────────────
// Un movimiento de `importe` a las 12:00:00 (fila 2) y los tickets de SIGA dados como [hora, importe, numero, extra].
// Con un solo ticket de importe idéntico el movimiento sería A REVISAR: para que quede SIN UBICAR con un ticket de
// igual importe hace falta que el importe esté repetido (otro ticket u otro movimiento).
const ticketsAviso = (...filas) => filas.map(([hora, importe, numero, extra = {}]) =>
  ({ ...filaSql({ suc: 1, fecha: `2026-09-22 ${hora}`, importe, numero }), ...extra }));

function escenarioAviso(tickets, { importe = '100,00', otrosMovimientos = [] } = {}) {
  const parse = parseBajada([
    ENCABEZADO,
    filaBanco({ fecha: '2026-09-22 12:00:00', importe }),
    ...otrosMovimientos.map(([hora, imp]) => filaBanco({ fecha: `2026-09-22 ${hora}`, importe: imp })),
  ]);
  return { parse, cruce: cruzar(parse.movimientos, normalizarTickets(tickets)) };
}

const observacionAviso = (tickets, opciones) => {
  const [d] = filasDetalle(escenarioAviso(tickets, opciones).cruce.filas);
  assert.strictEqual(d.Resultado, 'SIN UBICAR');
  return d['Observación'];
};
const AVISO = 'No hay ticket dentro de la ventana de hora, pero hay';

test('filasDetalle avisa en Observación de un único ticket del día con el importe igual, a otra hora', () => {
  // Dos movimientos de 100,00 y un solo ticket de 100,00: el par no es único, queda SIN UBICAR con aviso.
  const texto = observacionAviso(ticketsAviso(['15:00:00', 100, '1']), { otrosMovimientos: [['08:00:00', '100,00']] });
  assert.strictEqual(
    texto,
    `${AVISO} 1 ticket del día con importe coincidente: SUC 1 FC B 0001-1 a las 15:00:00 (3 h 0 min después del banco). Revisar.`,
  );
});

test('filasDetalle agrega el importe del ticket sólo si difiere del movimiento', () => {
  assert.strictEqual(
    observacionAviso(ticketsAviso(['15:00:00', 102, '1'])),
    `${AVISO} 1 ticket del día con importe coincidente: SUC 1 FC B 0001-1 a las 15:00:00 (3 h 0 min después del banco), importe $102.00. Revisar.`,
  );
  assert.strictEqual(
    observacionAviso(ticketsAviso(['15:00:00', 97.5, '1'])),
    `${AVISO} 1 ticket del día con importe coincidente: SUC 1 FC B 0001-1 a las 15:00:00 (3 h 0 min después del banco), importe $97.50. Revisar.`,
  );
});

test('filasDetalle lista varios candidatos separados por "; ", del más cercano al más lejano, con antes y después', () => {
  const texto = observacionAviso(ticketsAviso(['15:00:00', 100, '1'], ['09:30:00', 100, '2'], ['11:15:00', 101, '3']));
  assert.strictEqual(
    texto,
    `${AVISO} 3 tickets del día con importe coincidente: `
    + 'SUC 1 FC B 0001-3 a las 11:15:00 (45 min antes del banco), importe $101.00; '
    + 'SUC 1 FC B 0001-2 a las 09:30:00 (2 h 30 min antes del banco); '
    + 'SUC 1 FC B 0001-1 a las 15:00:00 (3 h 0 min después del banco). Revisar.',
  );
});

test('filasDetalle muestra los 3 más cercanos y cuenta con "y K más" los que no entran', () => {
  const texto = observacionAviso(ticketsAviso(
    ['13:00:00', 100, '1'], ['14:00:00', 100, '2'], ['15:00:00', 100, '3'], ['16:00:00', 100, '4'], ['17:00:00', 100, '5'],
  ));
  assert.strictEqual(
    texto,
    `${AVISO} 5 tickets del día con importe coincidente: `
    + 'SUC 1 FC B 0001-1 a las 13:00:00 (1 h 0 min después del banco); '
    + 'SUC 1 FC B 0001-2 a las 14:00:00 (2 h 0 min después del banco); '
    + 'SUC 1 FC B 0001-3 a las 15:00:00 (3 h 0 min después del banco) y 2 más. Revisar.',
  );
});

test('filasDetalle muestra sólo minutos si el ticket está a menos de una hora y redondea hacia abajo', () => {
  assert.match(observacionAviso(ticketsAviso(['12:45:30', 102, '1'])), /a las 12:45:30 \(45 min después del banco\), importe/);
  assert.match(observacionAviso(ticketsAviso(['11:00:01', 102, '1'])), /a las 11:00:01 \(59 min antes del banco\), importe/);
  assert.match(observacionAviso(ticketsAviso(['13:00:00', 102, '1'])), /a las 13:00:00 \(1 h 0 min después del banco\), importe/);
});

test('filasDetalle nombra la sucursal del candidato, con "Sucursal N" si no tiene nombre y "Sucursal ?" si no tiene ni id', () => {
  const sinNombre = ticketsAviso(['15:00:00', 102, '1', { NombreSucursal: '' }]);
  const sinNada = ticketsAviso(['15:00:00', 102, '1', { NombreSucursal: '', IdSucursal: null }]);
  assert.match(observacionAviso(sinNombre), /: Sucursal 1 FC B 0001-1 a las 15:00:00/);
  assert.match(observacionAviso(sinNada), /: Sucursal \? FC B 0001-1 a las 15:00:00/);
});

test('filasDetalle no usa rayas largas en el aviso y deja la Observación vacía en un SIN UBICAR sin candidatos', () => {
  const conAviso = observacionAviso(ticketsAviso(['15:00:00', 102, '1'], ['16:00:00', 101, '2']));
  assert.doesNotMatch(conAviso, /[—–]/);

  const [sinAviso] = filasDetalle(escenarioAviso(ticketsAviso(['15:00:00', 500, '1'])).cruce.filas);
  assert.strictEqual(sinAviso.Resultado, 'SIN UBICAR');
  assert.strictEqual(sinAviso['Observación'], '');
});

// Cinco movimientos mezclados a propósito (filas 2 a 6): dos SIN UBICAR con aviso (filas 6 y 3), uno sin aviso (fila 2),
// un AMBIGUO (fila 4) y un A REVISAR (fila 5).
function escenarioMezclaAviso() {
  const parse = parseBajada([
    ENCABEZADO,
    filaBanco({ fecha: '2026-09-22 08:00:00', importe: '500,00' }),
    filaBanco({ fecha: '2026-09-22 11:00:00', importe: '300,00' }),
    filaBanco({ fecha: '2026-09-22 09:00:00', importe: '100,00' }),
    filaBanco({ fecha: '2026-09-22 12:25:37', importe: '52.086,14' }),
    filaBanco({ fecha: '2026-09-22 10:00:00', importe: '400,00' }),
  ]);
  const cruce = cruzar(parse.movimientos, normalizarTickets([
    filaSql({ suc: 1, fecha: '2026-09-22 09:00:05', importe: 100, numero: '1' }),
    filaSql({ suc: 2, fecha: '2026-09-22 09:00:06', importe: 100.4, numero: '2' }),
    filaSql({ suc: 2, fecha: '2026-09-22 19:45:42', importe: 52086.14, numero: '9' }),
    filaSql({ suc: 1, fecha: '2026-09-22 18:00:00', importe: 302, numero: '3' }),
    filaSql({ suc: 1, fecha: '2026-09-22 20:00:00', importe: 402, numero: '4' }),
  ]));
  return { parse, cruce };
}

test('armarResumen cuenta en avisos.importeSinHora los SIN UBICAR con aviso, y no los demás', () => {
  assert.deepStrictEqual(resumenDe(escenario()).avisos, { importeSinHora: 0 });
  assert.deepStrictEqual(resumenDe(escenarioMezclaAviso()).avisos, { importeSinHora: 2 });
  assert.strictEqual(resumenDe(escenarioMezclaAviso()).porResultado.find(r => r.resultado === 'SIN UBICAR').cantidad, 3);
});

test('armarResumen pone en la atención el SIN UBICAR con aviso antes que el que no lo tiene, sin cambiar el orden general', () => {
  const { atencion } = resumenDe(escenarioMezclaAviso());

  assert.deepStrictEqual(
    atencion.filas.map(f => [f.resultado, f.fila, f.fecha.slice(11)]),
    [
      ['A REVISAR', 5, '12:25:37'], ['AMBIGUO', 4, '09:00:00'],
      ['SIN UBICAR', 6, '10:00:00'], ['SIN UBICAR', 3, '11:00:00'], ['SIN UBICAR', 2, '08:00:00'],
    ],
  );
  assert.strictEqual(atencion.total, 5);
});

test('armarResumen lleva en la atención la misma observación del Detalle para un SIN UBICAR con aviso', () => {
  const { cruce, parse } = escenarioMezclaAviso();
  const { atencion } = armarResumen({ filas: cruce.filas, parse, tolMonto: cruce.tolMonto, tolMin: cruce.tolMin });
  const detalle = filasDetalle(cruce.filas);
  const conAviso = atencion.filas.filter(f => f.resultado === 'SIN UBICAR' && f.observacion);

  assert.strictEqual(conAviso.length, 2);
  assert.strictEqual(conAviso[0].observacion, detalle[4]['Observación']);
  assert.strictEqual(conAviso[1].observacion, detalle[1]['Observación']);
  assert.strictEqual(
    conAviso[0].observacion,
    `${AVISO} 1 ticket del día con importe coincidente: SUC 1 FC B 0001-4 a las 20:00:00 (10 h 0 min después del banco), importe $402.00. Revisar.`,
  );
  assert.deepStrictEqual(atencion.filas.find(f => f.resultado === 'SIN UBICAR' && !f.observacion).fila, 2);
});

test('filasResumen agrega la fila de avisos justo debajo de la tabla de resultados y antes del bloque por sucursal', () => {
  const { parse, cruce } = escenarioMezclaAviso();
  const aoa = filasResumen({ filas: cruce.filas, parse, tolMonto: cruce.tolMonto, tolMin: cruce.tolMin });
  const i = aoa.findIndex(r => r[0] === 'NO APLICA');

  assert.deepStrictEqual(aoa[i + 1], ['SIN UBICAR con importe coincidente en otra hora', 2]);
  assert.deepStrictEqual(aoa[i + 2], []);
  assert.strictEqual(aoa[i + 3][0], 'Sucursal ID');
});

test('filasResumen muestra la fila de avisos también en cero y conserva las etiquetas de siempre', () => {
  const { parse, cruce } = escenario();
  const aoa = filasResumen({ filas: cruce.filas, parse, tolMonto: cruce.tolMonto, tolMin: cruce.tolMin });

  assert.deepStrictEqual(fila(aoa, 'SIN UBICAR con importe coincidente en otra hora'), ['SIN UBICAR con importe coincidente en otra hora', 0]);
  const sinAvisos = aoa.filter(r => r[0] !== 'SIN UBICAR con importe coincidente en otra hora');
  const i = sinAvisos.findIndex(r => r[0] === 'Resultado');
  assert.deepStrictEqual(sinAvisos.slice(i, i + 9).map(r => r[0]), [
    'Resultado', 'UBICADO', 'AMBIGUO', 'PAGO DIVIDIDO', 'A REVISAR', 'SIN UBICAR', 'NO APLICA', undefined, 'Sucursal ID',
  ]);
});
