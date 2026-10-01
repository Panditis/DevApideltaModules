const test = require('node:test');
const assert = require('node:assert');
const {
  parseBajada, normalizarTickets, cruzar, rangoConsulta, sqlTickets, RESULTADO, MAX_DIAS,
  TOL_MONTO_DEFAULT, TOL_MIN_DEFAULT, TOL_MONTO_MAX, TOL_MIN_MAX, ErrorCruce, validarTolerancias,
  MAX_VENTANA_PAGO_DIVIDIDO,
} = require('../lib/cruce_bancario');
const { ENCABEZADO, filaBanco, filaSql } = require('./cruce_bancario_fixtures');

const movs = (...filas) => parseBajada([ENCABEZADO, ...filas]).movimientos;
const banco = (fecha, importe, extra = {}) => filaBanco({ fecha, importe, ...extra });
const tickets = (...filas) => normalizarTickets(filas.map(filaSql));

// ── normalizarTickets ─────────────────────────────────────────────────────────
test('normalizarTickets arma la etiqueta del ticket y descarta filas sin fecha o importe', () => {
  const r = normalizarTickets([
    filaSql({ suc: 3, fecha: '2026-09-22 19:57:10', importe: 13898.4, numero: '77' }),
    filaSql({ suc: 3, fecha: 'basura', importe: 10 }),
    filaSql({ suc: 3, fecha: '2026-09-22 19:57:10', importe: 'x' }),
  ]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].etiqueta, 'FC B 0001-77');
  assert.strictEqual(r[0].centavos, 1389840);
  assert.strictEqual(r[0].sucursal, 'SUC 3');
  assert.strictEqual(r[0].fecha, '2026-09-22 19:57:10');
});

// ── cruzar ────────────────────────────────────────────────────────────────────
test('cruzar ubica el ticket y su sucursal por importe y hora', () => {
  const { filas } = cruzar(
    movs(banco('2026-09-22 19:58:42', '13.898,00')),
    tickets({ suc: 3, fecha: '2026-09-22 19:57:10', importe: 13898, numero: '77' }),
  );
  assert.strictEqual(filas[0].resultado, RESULTADO.UBICADO);
  assert.strictEqual(filas[0].ticket.idSucursal, 3);
  assert.strictEqual(filas[0].ticket.sucursal, 'SUC 3');
  assert.strictEqual(filas[0].ticket.etiqueta, 'FC B 0001-77');
  assert.strictEqual(filas[0].difSegundos, -92);
  assert.strictEqual(filas[0].difImporte, 0);
  assert.deepStrictEqual(filas[0].otros, []);
});

test('cruzar absorbe el redondeo de centavos del importe', () => {
  const { filas } = cruzar(
    movs(banco('2026-09-22 10:00:00', '15.811,40')),
    tickets({ fecha: '2026-09-22 10:00:30', importe: 15811 }),
  );
  assert.strictEqual(filas[0].resultado, RESULTADO.UBICADO);
  assert.strictEqual(filas[0].difImporte, -0.4);
});

test('cruzar acepta el límite exacto de la tolerancia de hora por defecto (180 s) y rechaza un segundo más', () => {
  const b = movs(banco('2026-09-22 10:00:00', '100,00'));
  const justo = cruzar(b, tickets({ fecha: '2026-09-22 10:03:00', importe: 100 }));
  const pasado = cruzar(b, tickets({ fecha: '2026-09-22 10:03:01', importe: 100 }));
  assert.strictEqual(justo.filas[0].resultado, RESULTADO.UBICADO);
  // Fuera de la ventana de hora no es un 1 a 1; como el importe es idéntico y es el mismo día, queda a revisar.
  assert.strictEqual(pasado.filas[0].resultado, RESULTADO.A_REVISAR);
});

test('cruzar acepta el límite exacto de la tolerancia de importe y rechaza un centavo más', () => {
  const b = movs(banco('2026-09-22 10:00:00', '100,00'));
  const justo = cruzar(b, tickets({ fecha: '2026-09-22 10:00:10', importe: 105 }));
  const pasado = cruzar(b, tickets({ fecha: '2026-09-22 10:00:10', importe: 105.01 }));
  assert.strictEqual(justo.filas[0].resultado, RESULTADO.UBICADO);
  assert.strictEqual(pasado.filas[0].resultado, RESULTADO.SIN_UBICAR);
});

test('cruzar respeta tolerancias pasadas por parámetro y vuelve al default si son inválidas', () => {
  const b = movs(banco('2026-09-22 10:00:00', '100,00'));
  const t = tickets({ fecha: '2026-09-22 10:00:10', importe: 101 });
  assert.strictEqual(cruzar(b, t, { tolMonto: 0 }).filas[0].resultado, RESULTADO.SIN_UBICAR);
  assert.strictEqual(cruzar(b, t, { tolMonto: '0,5' }).filas[0].resultado, RESULTADO.SIN_UBICAR);

  const lejos = tickets({ fecha: '2026-09-22 10:04:00', importe: 100 });
  assert.strictEqual(cruzar(b, lejos).filas[0].resultado, RESULTADO.A_REVISAR);
  assert.strictEqual(cruzar(b, lejos, { tolMin: 5 }).filas[0].resultado, RESULTADO.UBICADO);

  const invalido = cruzar(b, t, { tolMonto: 'abc', tolMin: -1 });
  assert.strictEqual(invalido.tolMonto, TOL_MONTO_DEFAULT);
  assert.strictEqual(invalido.tolMin, TOL_MIN_DEFAULT);
});

test('cruzar usa cada ticket una sola vez: gana el movimiento más cercano en hora', () => {
  const { filas } = cruzar(
    movs(
      banco('2026-09-22 10:00:00', '100,00'),
      banco('2026-09-22 10:00:50', '100,00'),
    ),
    tickets({ fecha: '2026-09-22 10:00:45', importe: 100 }),
  );
  assert.strictEqual(filas[0].resultado, RESULTADO.SIN_UBICAR);
  assert.strictEqual(filas[1].resultado, RESULTADO.UBICADO);
});

test('cruzar desempata por importe antes que por hora y marca AMBIGUO con los alternativos', () => {
  const { filas } = cruzar(
    movs(banco('2026-09-22 10:00:00', '100,00')),
    tickets(
      { suc: 1, fecha: '2026-09-22 10:01:50', importe: 100, numero: '1' },
      { suc: 2, fecha: '2026-09-22 10:00:05', importe: 100.4, numero: '9' },
    ),
  );
  assert.strictEqual(filas[0].resultado, RESULTADO.AMBIGUO);
  assert.strictEqual(filas[0].ticket.idSucursal, 1);
  assert.deepStrictEqual(filas[0].otros.map(t => t.idSucursal), [2]);
});

test('cruzar no cuenta como alternativo un ticket que se llevó otro movimiento', () => {
  const { filas } = cruzar(
    movs(
      banco('2026-09-22 10:00:00', '100,00'),
      banco('2026-09-22 10:00:10', '100,00'),
    ),
    tickets(
      { suc: 1, fecha: '2026-09-22 10:00:02', importe: 100, numero: '1' },
      { suc: 2, fecha: '2026-09-22 10:00:12', importe: 100, numero: '2' },
    ),
  );
  assert.deepStrictEqual(filas.map(f => f.resultado), [RESULTADO.UBICADO, RESULTADO.UBICADO]);
  assert.deepStrictEqual(filas.map(f => f.ticket.idSucursal), [1, 2]);
});

test('cruzar deja SIN UBICAR lo que no tiene ticket', () => {
  const { filas } = cruzar(movs(banco('2026-09-22 10:00:00', '100,00')), []);
  assert.strictEqual(filas[0].resultado, RESULTADO.SIN_UBICAR);
  assert.strictEqual(filas[0].ticket, null);
});

test('cruzar marca NO APLICA lo que no es una venta aprobada y no le gasta el ticket a otro', () => {
  const { filas } = cruzar(
    movs(
      banco('2026-09-22 10:00:00', '100,00', { estado: 'Anulada' }),
      banco('2026-09-22 10:00:30', '100,00'),
    ),
    tickets({ fecha: '2026-09-22 10:00:10', importe: 100 }),
  );
  assert.strictEqual(filas[0].resultado, RESULTADO.NO_APLICA);
  assert.strictEqual(filas[0].ticket, null);
  assert.strictEqual(filas[1].resultado, RESULTADO.UBICADO);
});

test('cruzar devuelve una fila por movimiento en el orden del archivo', () => {
  const { filas } = cruzar(
    movs(banco('2026-09-22 12:00:00', '10,00'), banco('2026-09-22 09:00:00', '20,00')),
    [],
  );
  assert.deepStrictEqual(filas.map(f => f.movimiento.fila), [2, 3]);
});

// ── rangoConsulta ─────────────────────────────────────────────────────────────
// El ticket de un A REVISAR puede estar horas lejos del movimiento: la consulta cubre los días completos.
const DIA_COMPLETO = { desde: '2026-09-22 00:00:00', hasta: '2026-09-22 23:59:59' };

test('rangoConsulta cubre los días completos de los movimientos y ignora los que no aplican', () => {
  const m = movs(
    banco('2026-09-22 08:21:59', '100,00'),
    banco('2026-09-22 19:58:42', '100,00'),
    banco('2026-09-01 00:00:00', '100,00', { estado: 'Anulada' }),
  );
  assert.deepStrictEqual(rangoConsulta(m), DIA_COMPLETO);
  assert.deepStrictEqual(rangoConsulta(m, 5), DIA_COMPLETO);
});

test('rangoConsulta con un solo movimiento consulta su día de 00:00:00 a 23:59:59', () => {
  assert.deepStrictEqual(rangoConsulta(movs(banco('2026-09-22 19:58:42', '100,00'))), DIA_COMPLETO);
});

test('rangoConsulta extiende el rango por el margen de hora cuando éste cruza la medianoche', () => {
  const temprano = movs(banco('2026-09-22 00:01:00', '100,00'));
  const tarde = movs(banco('2026-09-22 23:59:30', '100,00'));
  assert.deepStrictEqual(rangoConsulta(temprano), { desde: '2026-09-21 23:58:00', hasta: '2026-09-22 23:59:59' });
  assert.deepStrictEqual(rangoConsulta(tarde), { desde: '2026-09-22 00:00:00', hasta: '2026-09-23 00:02:30' });
});

test('rangoConsulta abarca desde el inicio del primer día hasta el fin del último', () => {
  const m = movs(banco('2026-09-22 15:00:00', '100,00'), banco('2026-09-24 09:30:00', '100,00'));
  assert.deepStrictEqual(rangoConsulta(m), { desde: '2026-09-22 00:00:00', hasta: '2026-09-24 23:59:59' });
});

test('rangoConsulta devuelve null si ningún movimiento aplica', () => {
  assert.strictEqual(rangoConsulta(movs(banco('2026-09-22 10:00:00', '100,00', { estado: 'Anulada' }))), null);
});

test('rangoConsulta rechaza un archivo que abarca más del máximo de días', () => {
  const m = movs(banco('2026-01-01 10:00:00', '100,00'), banco('2026-06-01 10:00:00', '100,00'));
  assert.throws(() => rangoConsulta(m), new RegExp(String(MAX_DIAS)));
});

// ── sqlTickets ────────────────────────────────────────────────────────────────
test('sqlTickets filtra tickets válidos y trae la fecha como texto', () => {
  const sql = sqlTickets('2026-09-22 08:18:59', '2026-09-22 20:01:42');
  assert.match(sql, /v\.Fecha >= '2026-09-22 08:18:59'/);
  assert.match(sql, /v\.Fecha <= '2026-09-22 20:01:42'/);
  assert.match(sql, /ISNULL\(v\.IdEstadoComprobante,''\) != 'ANULADO'/);
  assert.match(sql, /v\.ImporteTotal > 0/);
  assert.match(sql, /CONVERT\(varchar\(19\), v\.Fecha, 120\) AS FechaTxt/);
});

test('sqlTickets rechaza fechas que no tengan el formato esperado', () => {
  assert.throws(() => sqlTickets("2026-09-22'; DROP TABLE Ventas; --", '2026-09-22 20:00:42'), /Rango de fechas inválido/);
  assert.throws(() => sqlTickets('2026-09-22 08:19:59', undefined), /Rango de fechas inválido/);
});

// ── Topes de tolerancia ───────────────────────────────────────────────────────
const esErrorCruce = patron => err => err instanceof ErrorCruce && patron.test(err.message);

test('validarTolerancias devuelve los defaults si no hay valores', () => {
  assert.deepStrictEqual(validarTolerancias({}), { tolMonto: 5, tolMin: 3 });
  assert.deepStrictEqual(validarTolerancias({ tolMonto: '', tolMin: null }), { tolMonto: 5, tolMin: 3 });
});

test('validarTolerancias acepta exactamente los máximos y la coma decimal', () => {
  assert.strictEqual(TOL_MONTO_MAX, 100);
  assert.strictEqual(TOL_MIN_MAX, 15);
  assert.deepStrictEqual(validarTolerancias({ tolMonto: 100, tolMin: 15 }), { tolMonto: 100, tolMin: 15 });
  assert.deepStrictEqual(validarTolerancias({ tolMonto: '99,5', tolMin: '0' }), { tolMonto: 99.5, tolMin: 0 });
});

test('validarTolerancias rechaza lo que pasa el máximo con el tope en el mensaje', () => {
  assert.throws(() => validarTolerancias({ tolMonto: 101 }), esErrorCruce(/importe.*100/));
  assert.throws(() => validarTolerancias({ tolMin: 16 }), esErrorCruce(/hora.*15/));
  assert.throws(() => validarTolerancias({ tolMin: '15,01' }), esErrorCruce(/hora.*15/));
});

test('validarTolerancias vuelve al default si el valor es inválido', () => {
  assert.deepStrictEqual(validarTolerancias({ tolMonto: 'abc', tolMin: -1 }), { tolMonto: 5, tolMin: 3 });
  assert.deepStrictEqual(validarTolerancias({ tolMonto: 'Infinity', tolMin: '-0,5' }), { tolMonto: 5, tolMin: 3 });
});

test('cruzar y rangoConsulta también lanzan ErrorCruce si la tolerancia supera el máximo', () => {
  const m = movs(banco('2026-09-22 10:00:00', '100,00'));
  assert.throws(() => cruzar(m, [], { tolMonto: 101 }), esErrorCruce(/importe.*100/));
  assert.throws(() => cruzar(m, [], { tolMin: 16 }), esErrorCruce(/hora.*15/));
  assert.throws(() => rangoConsulta(m, 16), esErrorCruce(/hora.*15/));
  assert.deepStrictEqual(rangoConsulta(m, 15), DIA_COMPLETO);
});

// ── Rango máximo ──────────────────────────────────────────────────────────────
test('rangoConsulta acepta exactamente MAX_DIAS días entre el primer y el último movimiento', () => {
  const dia = n => new Date(Date.UTC(2026, 5, 1 + n, 10)).toISOString().slice(0, 19).replace('T', ' ');
  const justo = movs(banco(dia(0), '100,00'), banco(dia(MAX_DIAS), '100,00'));
  const pasado = movs(banco(dia(0), '100,00'), banco(dia(MAX_DIAS + 1), '100,00'));
  assert.doesNotThrow(() => rangoConsulta(justo));
  assert.throws(() => rangoConsulta(pasado), esErrorCruce(new RegExp(String(MAX_DIAS))));
});

// ── Bordes del cruce ──────────────────────────────────────────────────────────
test('cruzar ubica un ticket que cae pasada la medianoche y la consulta cubre los dos días', () => {
  const m = movs(banco('2026-09-22 23:59:30', '100,00'));
  const { filas } = cruzar(m, tickets({ fecha: '2026-09-23 00:00:10', importe: 100 }));
  assert.strictEqual(filas[0].resultado, RESULTADO.UBICADO);
  assert.strictEqual(filas[0].difSegundos, 40);
  assert.deepStrictEqual(rangoConsulta(m), { desde: '2026-09-22 00:00:00', hasta: '2026-09-23 00:02:30' });
});

test('cruzar desempata por orden original si dos tickets son idénticos en importe y segundo', () => {
  const { filas } = cruzar(
    movs(banco('2026-09-22 10:00:00', '100,00')),
    tickets(
      { suc: 1, fecha: '2026-09-22 10:00:30', importe: 100, numero: '1' },
      { suc: 2, fecha: '2026-09-22 10:00:30', importe: 100, numero: '2' },
    ),
  );
  assert.strictEqual(filas[0].resultado, RESULTADO.AMBIGUO);
  assert.strictEqual(filas[0].ticket.idSucursal, 1);
  assert.deepStrictEqual(filas[0].otros.map(t => t.idSucursal), [2]);
});

test('cruzar no comparte el array de otros entre las filas sin ticket', () => {
  const { filas } = cruzar(
    movs(
      banco('2026-09-22 10:00:00', '100,00'),
      banco('2026-09-22 11:00:00', '200,00'),
      banco('2026-09-22 12:00:00', '300,00', { estado: 'Anulada' }),
    ),
    [],
  );
  assert.notStrictEqual(filas[0].otros, filas[1].otros);
  assert.notStrictEqual(filas[1].otros, filas[2].otros);
});

// ── Pago dividido (de a dos movimientos) ──────────────────────────────────────
// Caso real del 22/09/2026: un ticket de 23.732,70 se pagó con dos transferencias.
const PAGO_A = ['2026-09-22 18:39:05', '23.132,70'];
const PAGO_B = ['2026-09-22 18:40:40', '600,00'];
const TICKET_DIVIDIDO = { suc: 2, fecha: '2026-09-22 18:39:42', importe: 23732.7, numero: '5' };
const resultados = filas => filas.map(f => f.resultado);
const DIVIDIDOS = [RESULTADO.PAGO_DIVIDIDO, RESULTADO.PAGO_DIVIDIDO];
const SIN_UBICAR_X2 = [RESULTADO.SIN_UBICAR, RESULTADO.SIN_UBICAR];

test('cruzar ubica un pago dividido: los dos movimientos van al mismo ticket', () => {
  const { filas } = cruzar(movs(banco(...PAGO_A), banco(...PAGO_B)), tickets(TICKET_DIVIDIDO));

  assert.deepStrictEqual(resultados(filas), DIVIDIDOS);
  assert.strictEqual(filas[0].ticket.idSucursal, 2);
  assert.strictEqual(filas[0].ticket.etiqueta, 'FC B 0001-5');
  assert.strictEqual(filas[1].ticket, filas[0].ticket);
  assert.strictEqual(filas[0].difImporte, 0);
  assert.strictEqual(filas[1].difImporte, 0);
  assert.strictEqual(filas[0].difSegundos, 37);
  assert.strictEqual(filas[1].difSegundos, -58);
  assert.deepStrictEqual(filas[0].otros, []);
  assert.deepStrictEqual(filas[1].otros, []);
  assert.strictEqual(filas[0].pareja, filas[1].movimiento);
  assert.strictEqual(filas[1].pareja, filas[0].movimiento);
});

test('cruzar ubica el pago dividido sin importar el orden de los movimientos en el archivo', () => {
  const { filas } = cruzar(movs(banco(...PAGO_B), banco(...PAGO_A)), tickets(TICKET_DIVIDIDO));
  assert.deepStrictEqual(resultados(filas), DIVIDIDOS);
  assert.strictEqual(filas[0].pareja, filas[1].movimiento);
  assert.strictEqual(filas[1].pareja, filas[0].movimiento);
});

test('cruzar acepta que la suma difiera del ticket hasta la tolerancia de importe y no un centavo más', () => {
  const con = importe => cruzar(movs(banco(...PAGO_A), banco(...PAGO_B)), tickets({ ...TICKET_DIVIDIDO, importe })).filas;
  const justoArriba = con(23737.7);   // el ticket supera la suma en exactamente $5
  const justoAbajo = con(23727.7);    // la suma supera al ticket en exactamente $5
  const pasadoArriba = con(23737.71);
  const pasadoAbajo = con(23727.69);

  assert.deepStrictEqual(resultados(justoArriba), DIVIDIDOS);
  assert.strictEqual(justoArriba[0].difImporte, 5);
  assert.strictEqual(justoArriba[1].difImporte, 5);
  assert.deepStrictEqual(resultados(justoAbajo), DIVIDIDOS);
  assert.strictEqual(justoAbajo[0].difImporte, -5);
  assert.deepStrictEqual(resultados(pasadoArriba), SIN_UBICAR_X2);
  assert.deepStrictEqual(resultados(pasadoAbajo), SIN_UBICAR_X2);
});

test('cruzar respeta la tolerancia de importe del parámetro en el pago dividido', () => {
  const m = movs(banco(...PAGO_A), banco(...PAGO_B));
  const t = tickets({ ...TICKET_DIVIDIDO, importe: 23733.7 });  // $1 de diferencia con la suma
  assert.deepStrictEqual(resultados(cruzar(m, t, { tolMonto: 0 }).filas), SIN_UBICAR_X2);
  assert.deepStrictEqual(resultados(cruzar(m, t, { tolMonto: 1 }).filas), DIVIDIDOS);
});

test('cruzar no arma un pago dividido si uno de los movimientos queda fuera de la ventana de hora', () => {
  const t = tickets({ fecha: '2026-09-22 10:00:00', importe: 1000 });
  const par = hora => movs(banco(hora, '400,00'), banco('2026-09-22 10:00:00', '600,00'));

  assert.deepStrictEqual(resultados(cruzar(par('2026-09-22 10:03:00'), t).filas), DIVIDIDOS);     // 180 s: entra
  assert.deepStrictEqual(resultados(cruzar(par('2026-09-22 10:03:01'), t).filas), SIN_UBICAR_X2); // 181 s: no
  assert.deepStrictEqual(resultados(cruzar(par('2026-09-22 09:57:00'), t).filas), DIVIDIDOS);     // 180 s antes
  assert.deepStrictEqual(resultados(cruzar(par('2026-09-22 09:56:59'), t).filas), SIN_UBICAR_X2); // 181 s antes
});

test('cruzar no usa para un pago dividido un ticket que ya tomó una asignación 1 a 1', () => {
  const { filas } = cruzar(
    movs(banco(...PAGO_A), banco(...PAGO_B), banco('2026-09-22 18:39:45', '23.732,70')),
    tickets(TICKET_DIVIDIDO),
  );
  assert.deepStrictEqual(resultados(filas), [RESULTADO.SIN_UBICAR, RESULTADO.SIN_UBICAR, RESULTADO.UBICADO]);
  assert.strictEqual(filas[2].ticket.etiqueta, 'FC B 0001-5');
});

test('cruzar da prioridad a la asignación 1 a 1: su movimiento no se usa en un pago dividido', () => {
  const { filas } = cruzar(
    movs(banco('2026-09-22 10:00:10', '400,00'), banco('2026-09-22 10:00:20', '600,00')),
    tickets(
      { suc: 1, fecha: '2026-09-22 10:00:00', importe: 1000, numero: '1' },
      { suc: 2, fecha: '2026-09-22 10:00:15', importe: 400, numero: '2' },
    ),
  );
  // Los 400 tienen su ticket de 400 (1 a 1): no pueden ser parte del pago de 1.000.
  assert.deepStrictEqual(resultados(filas), [RESULTADO.UBICADO, RESULTADO.SIN_UBICAR]);
  assert.strictEqual(filas[0].ticket.idSucursal, 2);
  assert.strictEqual(filas[1].ticket, null);
  assert.strictEqual(filas[1].pareja, null);
});

test('cruzar no arma un pago dividido de tres movimientos', () => {
  const { filas } = cruzar(
    movs(
      banco('2026-09-22 10:00:00', '10.000,00'),
      banco('2026-09-22 10:00:10', '20.000,00'),
      banco('2026-09-22 10:00:20', '30.000,00'),
    ),
    tickets({ fecha: '2026-09-22 10:00:15', importe: 60000 }),
  );
  assert.deepStrictEqual(resultados(filas), [RESULTADO.SIN_UBICAR, RESULTADO.SIN_UBICAR, RESULTADO.SIN_UBICAR]);
});

test('cruzar no mezcla en un pago dividido un movimiento que no aplica', () => {
  const { filas } = cruzar(
    movs(banco(...PAGO_A), banco(...PAGO_B, { estado: 'Anulada' })),
    tickets(TICKET_DIVIDIDO),
  );
  assert.deepStrictEqual(resultados(filas), [RESULTADO.SIN_UBICAR, RESULTADO.NO_APLICA]);
});

test('cruzar con dos pares que compiten por el ticket asigna el de menor costo y deja el otro sin ubicar', () => {
  // Ticket de 1.000. Par X: suma exacta pero a 100 s. Par Y: suma $0,03 más, pero a 10 s.
  // Gana X: el importe pesa antes que la hora.
  const { filas } = cruzar(
    movs(
      banco('2026-09-22 10:01:40', '400,00'),   // X1: a 100 s del ticket
      banco('2026-09-22 10:01:40', '600,00'),   // X2
      banco('2026-09-22 10:00:10', '450,00'),   // Y1: a 10 s
      banco('2026-09-22 10:00:10', '550,03'),   // Y2
    ),
    tickets({ fecha: '2026-09-22 10:00:00', importe: 1000 }),
  );
  assert.deepStrictEqual(resultados(filas), [...DIVIDIDOS, ...SIN_UBICAR_X2]);
  assert.strictEqual(filas[0].pareja, filas[1].movimiento);
  assert.strictEqual(filas[2].pareja, null);
});

test('cruzar desempata dos pares con la misma suma por el mayor desfase de hora', () => {
  const { filas } = cruzar(
    movs(
      banco('2026-09-22 10:01:30', '400,00'),   // par lejano: su mayor desfase es de 90 s
      banco('2026-09-22 10:00:20', '600,00'),
      banco('2026-09-22 10:00:30', '450,00'),   // par cercano: su mayor desfase es de 30 s
      banco('2026-09-22 10:00:10', '550,00'),
    ),
    tickets({ fecha: '2026-09-22 10:00:00', importe: 1000 }),
  );
  assert.deepStrictEqual(resultados(filas), [...SIN_UBICAR_X2, ...DIVIDIDOS]);
  assert.strictEqual(filas[2].pareja, filas[3].movimiento);
});

test('cruzar usa cada ticket y cada movimiento una sola vez entre pagos divididos', () => {
  // Dos tickets de 1.000 y cuatro movimientos de 500: cada ticket se lleva un par distinto.
  const { filas } = cruzar(
    movs(
      banco('2026-09-22 10:00:00', '500,00'),
      banco('2026-09-22 10:00:05', '500,00'),
      banco('2026-09-22 10:00:10', '500,00'),
      banco('2026-09-22 10:00:15', '500,00'),
    ),
    tickets(
      { suc: 1, fecha: '2026-09-22 10:00:02', importe: 1000, numero: '1' },
      { suc: 2, fecha: '2026-09-22 10:00:12', importe: 1000, numero: '2' },
    ),
  );
  assert.deepStrictEqual(resultados(filas), [...DIVIDIDOS, ...DIVIDIDOS]);
  assert.deepStrictEqual(filas.map(f => f.ticket.idSucursal), [1, 1, 2, 2]);
  assert.strictEqual(filas[0].pareja, filas[1].movimiento);
  assert.strictEqual(filas[2].pareja, filas[3].movimiento);
});

test('cruzar saca de los otros candidatos un ticket que se llevó un pago dividido', () => {
  // El movimiento de 1.000 ve el ticket de 1.000 y también el de 1.002. Al de 1.002 se lo
  // llevan los movimientos de 500 y 502, así que ya no es una alternativa: queda UBICADO.
  const { filas } = cruzar(
    movs(
      banco('2026-09-22 10:00:00', '1.000,00'),
      banco('2026-09-22 10:00:10', '500,00'),
      banco('2026-09-22 10:00:20', '502,00'),
    ),
    tickets(
      { suc: 1, fecha: '2026-09-22 10:00:05', importe: 1000, numero: '1' },
      { suc: 2, fecha: '2026-09-22 10:00:15', importe: 1002, numero: '2' },
    ),
  );
  assert.deepStrictEqual(resultados(filas), [RESULTADO.UBICADO, ...DIVIDIDOS]);
  assert.strictEqual(filas[0].ticket.idSucursal, 1);
  assert.deepStrictEqual(filas[0].otros, []);
  assert.strictEqual(filas[1].ticket.idSucursal, 2);
});

test('cruzar no arma pares fuera de la ventana de cada ticket (no recorre todos los movimientos de a pares)', () => {
  // 100.000 movimientos sin ticket y 50 tickets que no coinciden por importe. Recorrer todos los
  // pares de movimientos serían 5 × 10^9 comparaciones; por ventana de ticket son unos miles.
  const base = Date.UTC(2026, 5, 1, 8, 0, 0) / 1000;
  const fecha = seg => new Date(seg * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const grilla = [ENCABEZADO, ...Array.from({ length: 100000 }, (_, i) => banco(fecha(base + i * 20), `${1000 + (i % 97)},00`))];
  const ticketsSql = Array.from({ length: 50 }, (_, i) => filaSql({ fecha: fecha(base + i * 40000), importe: 3 + i, numero: String(i) }));

  const { movimientos } = parseBajada(grilla);
  const normalizados = normalizarTickets(ticketsSql);
  const inicio = Date.now();
  const { filas } = cruzar(movimientos, normalizados);
  const ms = Date.now() - inicio;

  assert.strictEqual(filas.length, 100000);
  assert.ok(ms < 5000, `tardó ${ms} ms`);
});

test('cruzar no busca pagos divididos en una ventana con más movimientos sin ticket que el tope', () => {
  // Cada movimiento de 500 es la mitad del ticket de 1.000: dentro del tope se arma una pareja.
  const ventana = cantidad => cruzar(
    movs(...Array.from({ length: cantidad }, (_, i) => banco(`2026-09-22 10:00:${String(i % 60).padStart(2, '0')}`, '500,00'))),
    tickets({ fecha: '2026-09-22 10:00:30', importe: 1000 }),
  ).filas;

  const justo = ventana(MAX_VENTANA_PAGO_DIVIDIDO);
  const pasado = ventana(MAX_VENTANA_PAGO_DIVIDIDO + 1);
  assert.strictEqual(justo.filter(f => f.resultado === RESULTADO.PAGO_DIVIDIDO).length, 2);
  assert.strictEqual(pasado.filter(f => f.resultado === RESULTADO.PAGO_DIVIDIDO).length, 0);
});

test('cruzar deja sin pareja a las filas que no son un pago dividido', () => {
  const { filas } = cruzar(
    movs(
      banco('2026-09-22 10:00:00', '100,00'),
      banco('2026-09-22 11:00:00', '200,00'),
      banco('2026-09-22 12:00:00', '300,00', { estado: 'Anulada' }),
      banco('2026-09-22 13:00:00', '400,00'),
    ),
    tickets(
      { suc: 1, fecha: '2026-09-22 10:00:10', importe: 100, numero: '1' },
      { suc: 2, fecha: '2026-09-22 13:00:10', importe: 400, numero: '2' },
      { suc: 3, fecha: '2026-09-22 13:00:20', importe: 400.5, numero: '3' },
    ),
  );
  assert.deepStrictEqual(resultados(filas), [RESULTADO.UBICADO, RESULTADO.SIN_UBICAR, RESULTADO.NO_APLICA, RESULTADO.AMBIGUO]);
  for (const f of filas) assert.strictEqual(f.pareja, null);
});

test('RESULTADO lista PAGO DIVIDIDO justo después de AMBIGUO y A REVISAR justo después de PAGO DIVIDIDO', () => {
  assert.strictEqual(RESULTADO.PAGO_DIVIDIDO, 'PAGO DIVIDIDO');
  assert.strictEqual(RESULTADO.A_REVISAR, 'A REVISAR');
  assert.deepStrictEqual(Object.values(RESULTADO), ['UBICADO', 'AMBIGUO', 'PAGO DIVIDIDO', 'A REVISAR', 'SIN UBICAR', 'NO APLICA']);
});

// ── A REVISAR: importe idéntico el mismo día, con la hora muy distinta ────────
// Caso real del 22/09/2026: el ticket de SIGA figura horas después del cobro del banco.
const MOV_REVISAR = ['2026-09-22 12:25:37', '52.086,14'];
const TICKET_REVISAR = { suc: 1, fecha: '2026-09-22 19:45:42', importe: 52086.14, numero: '9' };

test('cruzar marca A REVISAR un ticket del mismo día con el importe idéntico y la hora muy distinta', () => {
  const { filas } = cruzar(movs(banco(...MOV_REVISAR)), tickets(TICKET_REVISAR));

  assert.strictEqual(filas[0].resultado, RESULTADO.A_REVISAR);
  assert.strictEqual(filas[0].ticket.etiqueta, 'FC B 0001-9');
  assert.strictEqual(filas[0].ticket.sucursal, 'SUC 1');
  assert.strictEqual(filas[0].difImporte, 0);
  assert.strictEqual(filas[0].difSegundos, 26405);
  assert.deepStrictEqual(filas[0].otros, []);
  assert.strictEqual(filas[0].pareja, null);
});

test('cruzar marca A REVISAR también un ticket anterior al banco (diferencia negativa)', () => {
  const { filas } = cruzar(
    movs(banco('2026-09-22 19:45:42', '52.086,14')),
    tickets({ ...TICKET_REVISAR, fecha: '2026-09-22 12:25:37' }),
  );
  assert.strictEqual(filas[0].resultado, RESULTADO.A_REVISAR);
  assert.strictEqual(filas[0].difSegundos, -26405);
});

test('cruzar no marca A REVISAR un ticket de otro día, aunque el importe sea idéntico', () => {
  const { filas } = cruzar(movs(banco(...MOV_REVISAR)), tickets({ ...TICKET_REVISAR, fecha: '2026-09-23 19:45:42' }));
  assert.strictEqual(filas[0].resultado, RESULTADO.SIN_UBICAR);
  assert.strictEqual(filas[0].ticket, null);
});

test('cruzar toma el día de 00:00:00 a 23:59:59: los extremos son del mismo día y los de al lado no', () => {
  const m = movs(banco('2026-09-22 12:00:00', '100,00'));
  const resultadoCon = fecha => cruzar(m, tickets({ fecha, importe: 100 })).filas[0].resultado;

  assert.strictEqual(resultadoCon('2026-09-22 00:00:00'), RESULTADO.A_REVISAR);
  assert.strictEqual(resultadoCon('2026-09-22 23:59:59'), RESULTADO.A_REVISAR);
  assert.strictEqual(resultadoCon('2026-09-21 23:59:59'), RESULTADO.SIN_UBICAR);
  assert.strictEqual(resultadoCon('2026-09-23 00:00:00'), RESULTADO.SIN_UBICAR);
});

test('cruzar no marca A REVISAR un importe que difiere en un centavo', () => {
  const { filas } = cruzar(movs(banco(...MOV_REVISAR)), tickets({ ...TICKET_REVISAR, importe: 52086.15 }));
  assert.strictEqual(filas[0].resultado, RESULTADO.SIN_UBICAR);
});

test('cruzar no marca A REVISAR si hay dos tickets del día con el mismo importe', () => {
  const { filas } = cruzar(
    movs(banco(...MOV_REVISAR)),
    tickets(TICKET_REVISAR, { ...TICKET_REVISAR, suc: 2, fecha: '2026-09-22 16:00:00', numero: '10' }),
  );
  assert.strictEqual(filas[0].resultado, RESULTADO.SIN_UBICAR);
  assert.strictEqual(filas[0].ticket, null);
});

test('cruzar no marca A REVISAR si hay dos movimientos del día con el mismo importe y un solo ticket', () => {
  const { filas } = cruzar(
    movs(banco(...MOV_REVISAR), banco('2026-09-22 09:00:00', '52.086,14')),
    tickets(TICKET_REVISAR),
  );
  assert.deepStrictEqual(resultados(filas), SIN_UBICAR_X2);
});

test('cruzar marca A REVISAR cada par único aunque haya otros importes y otros días', () => {
  const { filas } = cruzar(
    movs(
      banco('2026-09-22 10:00:00', '100,00'),
      banco('2026-09-22 11:00:00', '200,00'),
      banco('2026-09-23 10:00:00', '100,00'),
    ),
    tickets(
      { suc: 1, fecha: '2026-09-22 16:00:00', importe: 100, numero: '1' },
      { suc: 2, fecha: '2026-09-22 17:00:00', importe: 200, numero: '2' },
      { suc: 3, fecha: '2026-09-23 15:00:00', importe: 100, numero: '3' },
    ),
  );
  assert.deepStrictEqual(resultados(filas), [RESULTADO.A_REVISAR, RESULTADO.A_REVISAR, RESULTADO.A_REVISAR]);
  assert.deepStrictEqual(filas.map(f => f.ticket.idSucursal), [1, 2, 3]);
});

test('cruzar no marca A REVISAR un movimiento que no aplica', () => {
  const { filas } = cruzar(movs(banco(...MOV_REVISAR, { estado: 'Anulada' })), tickets(TICKET_REVISAR));
  assert.strictEqual(filas[0].resultado, RESULTADO.NO_APLICA);
  assert.strictEqual(filas[0].ticket, null);
});

test('cruzar no ofrece a A REVISAR un ticket que ya usó la asignación 1 a 1', () => {
  // El de 100,50 se lleva el ticket de 100,00 (1 a 1). El movimiento de 100,00 de la tarde tiene el
  // mismo importe exacto, pero ese ticket ya no está libre.
  const { filas } = cruzar(
    movs(banco('2026-09-22 10:00:00', '100,50'), banco('2026-09-22 15:00:00', '100,00')),
    tickets({ suc: 1, fecha: '2026-09-22 10:00:05', importe: 100, numero: '1' }),
  );
  assert.deepStrictEqual(resultados(filas), [RESULTADO.UBICADO, RESULTADO.SIN_UBICAR]);
  assert.strictEqual(filas[1].ticket, null);
});

test('cruzar no ofrece a A REVISAR un ticket que ya se llevó un pago dividido', () => {
  const { filas } = cruzar(
    movs(banco(...PAGO_A), banco(...PAGO_B), banco('2026-09-22 15:00:00', '23.732,70')),
    tickets(TICKET_DIVIDIDO),
  );
  assert.deepStrictEqual(resultados(filas), [...DIVIDIDOS, RESULTADO.SIN_UBICAR]);
  assert.strictEqual(filas[2].ticket, null);
});

test('cruzar da prioridad a la asignación 1 a 1 sobre A REVISAR', () => {
  // El ticket de 100 a 20 s es el 1 a 1; el de 100 de la tarde no se le ofrece a nadie.
  const { filas } = cruzar(
    movs(banco('2026-09-22 10:00:00', '100,00')),
    tickets(
      { suc: 1, fecha: '2026-09-22 10:00:20', importe: 100, numero: '1' },
      { suc: 2, fecha: '2026-09-22 15:00:00', importe: 100, numero: '2' },
    ),
  );
  assert.strictEqual(filas[0].resultado, RESULTADO.UBICADO);
  assert.strictEqual(filas[0].ticket.idSucursal, 1);
});

test('cruzar da prioridad al pago dividido sobre A REVISAR', () => {
  // Los de 400 y 600 suman el ticket de 1.000 (a 5 s); el movimiento de 1.000 de la tarde lo igualaría
  // por importe, pero el pago dividido llega primero.
  const { filas } = cruzar(
    movs(
      banco('2026-09-22 10:00:00', '400,00'),
      banco('2026-09-22 10:00:10', '600,00'),
      banco('2026-09-22 15:00:00', '1.000,00'),
    ),
    tickets({ fecha: '2026-09-22 10:00:05', importe: 1000 }),
  );
  assert.deepStrictEqual(resultados(filas), [...DIVIDIDOS, RESULTADO.SIN_UBICAR]);
});

test('cruzar sigue listando como alternativo de un AMBIGUO el ticket que se lleva un A REVISAR', () => {
  // El movimiento de la mañana se queda con el ticket de las 10:00:05 y ve el de las 10:00:30 como
  // alternativo; el movimiento de la tarde (mismo importe) se lleva ese segundo ticket a revisar.
  // Sólo el 1 a 1 y el pago dividido sacan un ticket de los otros candidatos: el A REVISAR es débil.
  const { filas } = cruzar(
    movs(banco('2026-09-22 10:00:00', '100,00'), banco('2026-09-22 15:00:20', '100,00')),
    tickets(
      { suc: 1, fecha: '2026-09-22 10:00:05', importe: 100, numero: '1' },
      { suc: 2, fecha: '2026-09-22 10:00:30', importe: 100, numero: '2' },
    ),
  );
  assert.deepStrictEqual(resultados(filas), [RESULTADO.AMBIGUO, RESULTADO.A_REVISAR]);
  assert.deepStrictEqual(filas[0].otros.map(t => t.idSucursal), [2]);
  assert.strictEqual(filas[1].ticket.idSucursal, 2);
});

test('cruzar resuelve miles de A REVISAR agrupando por día e importe (no recorre todos los pares)', () => {
  // 40.000 movimientos de importes distintos y sus tickets 8 horas después: todos son A REVISAR.
  // Comparar cada movimiento contra todos los tickets serían 1,6 × 10^9 comparaciones.
  const base = Date.UTC(2026, 5, 1, 0, 0, 0) / 1000;
  const fecha = seg => new Date(seg * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const cantidad = 40000;
  const grilla = [ENCABEZADO, ...Array.from({ length: cantidad }, (_, i) => banco(fecha(base + (i % 3000) * 3), `${i + 1},00`))];
  const ticketsSql = Array.from({ length: cantidad }, (_, i) => filaSql({ fecha: fecha(base + 28800 + (i % 3000) * 3), importe: i + 1, numero: String(i) }));

  const { movimientos } = parseBajada(grilla);
  const normalizados = normalizarTickets(ticketsSql);
  const inicio = Date.now();
  const { filas } = cruzar(movimientos, normalizados);
  const ms = Date.now() - inicio;

  assert.strictEqual(filas.filter(f => f.resultado === RESULTADO.A_REVISAR).length, cantidad);
  assert.ok(ms < 5000, `tardó ${ms} ms`);
});
