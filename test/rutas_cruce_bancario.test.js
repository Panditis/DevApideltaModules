const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const XLSX = require('xlsx');
const crearRutas = require('../routes/rutas_cruce_bancario');
const { ENCABEZADO: ENCABEZADO_REAL, filaBanco } = require('./cruce_bancario_fixtures');

const ENCABEZADO = ['Fecha', 'Estado', 'Importe', 'Tipo', 'Marca tarjeta'];
const FILA_OK = ['2026-09-22 19:58:42', 'Aprobada', '13.898,00', 'Venta', 'Visa'];
const TICKET = {
  IdSucursal: 3, NombreSucursal: 'URQUIZA', IdTipoComprobante: 'FC', Letra: 'B', CentroEmisor: '0001',
  NumeroComprobante: '123', FechaTxt: '2026-09-22 19:57:10', ImporteTotal: 13898,
};

function xlsDe(filas) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(filas), 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xls' });
}

async function conServidor(query, fn) {
  const app = express();
  app.use(crearRutas({ query }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

function subir(base, buffer, campos = {}) {
  const fd = new FormData();
  if (buffer) fd.append('archivo', new Blob([buffer]), 'sales.xls');
  for (const [clave, valor] of Object.entries(campos)) fd.append(clave, String(valor));
  return fetch(`${base}/api/cruce-bancario/procesar`, { method: 'POST', body: fd });
}

// La respuesta 200 es JSON: { resumen, archivo: { nombre, base64 } } con el xlsx en base64.
const libroDe = async respuesta => {
  const { archivo } = await respuesta.json();
  return XLSX.read(Buffer.from(archivo.base64, 'base64'), { type: 'buffer' });
};

const detalleDe = async respuesta => {
  const wb = await libroDe(respuesta);
  return { hojas: wb.SheetNames, detalle: XLSX.utils.sheet_to_json(wb.Sheets.Detalle) };
};

test('devuelve el xlsx con Resumen y Detalle y ubica el ticket en su sucursal', async () => {
  const consultas = [];
  await conServidor(async sql => { consultas.push(sql); return [TICKET]; }, async base => {
    const r = await subir(base, xlsDe([ENCABEZADO, FILA_OK]));
    assert.strictEqual(r.status, 200);

    const { hojas, detalle } = await detalleDe(r);
    assert.deepStrictEqual(hojas, ['Resumen', 'Detalle']);
    assert.strictEqual(detalle[0].Resultado, 'UBICADO');
    assert.strictEqual(detalle[0].Sucursal, 'URQUIZA');
  });
  assert.strictEqual(consultas.length, 1);
  // Días completos: el ticket de un A REVISAR puede estar horas lejos del movimiento.
  assert.match(consultas[0], /v\.Fecha >= '2026-09-22 00:00:00'/);
  assert.match(consultas[0], /v\.Fecha <= '2026-09-22 23:59:59'/);
});

test('usa las tolerancias que llegan en el formulario', async () => {
  const ticketCaro = { ...TICKET, ImporteTotal: 13899 };
  await conServidor(async () => [ticketCaro], async base => {
    const conDefault = await detalleDe(await subir(base, xlsDe([ENCABEZADO, FILA_OK])));
    const estricto = await detalleDe(await subir(base, xlsDe([ENCABEZADO, FILA_OK]), { tolMonto: 0 }));
    assert.strictEqual(conDefault.detalle[0].Resultado, 'UBICADO');
    assert.strictEqual(estricto.detalle[0].Resultado, 'SIN UBICAR');
  });
});

test('no consulta SIGA si ningún movimiento aplica y igual devuelve el xlsx', async () => {
  let llamadas = 0;
  const anulada = ['2026-09-22 19:58:42', 'Anulada', '13.898,00', 'Venta', 'Visa'];
  await conServidor(async () => { llamadas += 1; return []; }, async base => {
    const r = await subir(base, xlsDe([ENCABEZADO, anulada]));
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await detalleDe(r)).detalle[0].Resultado, 'NO APLICA');
  });
  assert.strictEqual(llamadas, 0);
});

test('422 si falta el archivo', async () => {
  await conServidor(async () => [], async base => {
    const r = await subir(base, null);
    assert.strictEqual(r.status, 422);
    assert.match((await r.json()).error, /archivo/);
  });
});

test('422 con los encabezados leídos si faltan las columnas Fecha e Importe', async () => {
  await conServidor(async () => [], async base => {
    const r = await subir(base, xlsDe([['Columna A', 'Columna B'], ['x', 'y']]));
    assert.strictEqual(r.status, 422);
    assert.match((await r.json()).error, /Encabezados leídos: Columna A, Columna B/);
  });
});

test('500 genérico si SIGA falla y no filtra el detalle del error', async () => {
  const consoleError = console.error;
  console.error = () => {};
  try {
    await conServidor(async () => { throw new Error('ECONNRESET secreto-interno'); }, async base => {
      const r = await subir(base, xlsDe([ENCABEZADO, FILA_OK]));
      const { error } = await r.json();
      assert.strictEqual(r.status, 500);
      assert.match(error, /No se pudo consultar SIGA/);
      assert.doesNotMatch(error, /secreto-interno/);
    });
  } finally {
    console.error = consoleError;
  }
});

// ── Correcciones de la revisión (Tarea 8) ─────────────────────────────────────
test('422 con el mensaje de los 93 días si el archivo abarca más', async () => {
  const lejos = ['2026-01-01 10:00:00', 'Aprobada', '100,00', 'Venta', 'Visa'];
  await conServidor(async () => [], async base => {
    const r = await subir(base, xlsDe([ENCABEZADO, FILA_OK, lejos]));
    assert.strictEqual(r.status, 422);
    assert.match((await r.json()).error, /máximo es 93/);
  });
});

test('422 si el archivo no es un xls ni un xlsx', async () => {
  await conServidor(async () => [], async base => {
    const r = await subir(base, Buffer.from('%PDF-1.4 hola'));
    assert.strictEqual(r.status, 422);
    assert.match((await r.json()).error, /\.xls o \.xlsx/);
  });
});

test('422 si la tolerancia de hora supera el máximo', async () => {
  await conServidor(async () => [], async base => {
    const r = await subir(base, xlsDe([ENCABEZADO, FILA_OK]), { tolMin: 16 });
    assert.strictEqual(r.status, 422);
    assert.match((await r.json()).error, /hora.*15/);
  });
});

test('422 si la tolerancia de importe supera el máximo', async () => {
  await conServidor(async () => [], async base => {
    const r = await subir(base, xlsDe([ENCABEZADO, FILA_OK]), { tolMonto: 101 });
    assert.strictEqual(r.status, 422);
    assert.match((await r.json()).error, /importe.*100/);
  });
});

test('422 si la hoja es demasiado ancha para ser una bajada del banco', async () => {
  const ancha = Array.from({ length: 70 }, (_, i) => `c${i}`);
  await conServidor(async () => [], async base => {
    const r = await subir(base, xlsDe([ancha]));
    assert.strictEqual(r.status, 422);
    assert.match((await r.json()).error, /demasiado grande/);
  });
});

// Un xlsx chico que declara un área enorme: con sheetRows SheetJS recorta !ref a los datos reales y
// deja lo declarado en !fullref, así que la guarda tiene que mirar también esa dimensión declarada.
test('422 si el xlsx declara una dimensión enorme aunque tenga pocos datos', async () => {
  const ws = XLSX.utils.aoa_to_sheet([['Fecha', 'Importe'], ['2026-09-22 10:00:00', '100,00']]);
  ws['!ref'] = 'A1:B100000';
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'S');
  const xlsx = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  await conServidor(async () => [], async base => {
    const r = await subir(base, xlsx);
    assert.strictEqual(r.status, 422);
    assert.match((await r.json()).error, /demasiado grande/);
  });
});

test('la respuesta con el resumen y el xlsx no se cachea', async () => {
  await conServidor(async () => [TICKET], async base => {
    const r = await subir(base, xlsDe([ENCABEZADO, FILA_OK]));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
  });
});

// ── Pago dividido y tolerancia de 3 minutos (Tarea 9) ─────────────────────────
test('devuelve el xlsx marcando PAGO DIVIDIDO en los dos movimientos que suman un ticket', async () => {
  const ticket = { ...TICKET, NumeroComprobante: '5', FechaTxt: '2026-09-22 18:39:42', ImporteTotal: 23732.7 };
  const filas = [
    ENCABEZADO,
    ['2026-09-22 18:39:05', 'Aprobada', '23.132,70', 'Venta', 'Visa'],
    ['2026-09-22 18:40:40', 'Aprobada', '600,00', 'Venta', 'Visa'],
  ];
  await conServidor(async () => [ticket], async base => {
    const r = await subir(base, xlsDe(filas));
    assert.strictEqual(r.status, 200);

    const { detalle } = await detalleDe(r);
    assert.deepStrictEqual(detalle.map(d => d.Resultado), ['PAGO DIVIDIDO', 'PAGO DIVIDIDO']);
    assert.deepStrictEqual(detalle.map(d => d.Sucursal), ['URQUIZA', 'URQUIZA']);
    assert.deepStrictEqual(detalle.map(d => d.Ticket), ['FC B 0001-5', 'FC B 0001-5']);
    assert.deepStrictEqual(detalle.map(d => d['Dif. segundos']), [37, -58]);
    assert.strictEqual(detalle[0]['Observación'], 'Pago dividido con el movimiento de 18:40:40 por $600.00 (fila 3).');
    assert.strictEqual(detalle[1]['Observación'], 'Pago dividido con el movimiento de 18:39:05 por $23132.70 (fila 2).');
  });
});

test('con 3 minutos por defecto ubica un ticket a 180 s y no uno a 181 s', async () => {
  const justo = { ...TICKET, FechaTxt: '2026-09-22 20:01:42' };    // 180 s después de FILA_OK
  const pasado = { ...TICKET, FechaTxt: '2026-09-22 20:01:43' };   // 181 s
  await conServidor(async () => [justo], async base => {
    assert.strictEqual((await detalleDe(await subir(base, xlsDe([ENCABEZADO, FILA_OK])))).detalle[0].Resultado, 'UBICADO');
  });
  await conServidor(async () => [pasado], async base => {
    // Fuera de la ventana de hora, pero con el importe idéntico el mismo día: queda a revisar, no ubicado.
    assert.strictEqual((await detalleDe(await subir(base, xlsDe([ENCABEZADO, FILA_OK])))).detalle[0].Resultado, 'A REVISAR');
  });
});

// ── A REVISAR: importe idéntico el mismo día con la hora muy distinta ─────────
test('devuelve el xlsx marcando A REVISAR el ticket de importe idéntico horas después, con su observación', async () => {
  const ticket = { ...TICKET, NumeroComprobante: '9', FechaTxt: '2026-09-22 19:45:42', ImporteTotal: 52086.14 };
  const filas = [ENCABEZADO, ['2026-09-22 12:25:37', 'Aprobada', '52.086,14', 'Venta', 'Visa']];
  await conServidor(async () => [ticket], async base => {
    const r = await subir(base, xlsDe(filas));
    assert.strictEqual(r.status, 200);

    const wb = await libroDe(r);
    const detalle = XLSX.utils.sheet_to_json(wb.Sheets.Detalle);
    assert.strictEqual(detalle[0].Resultado, 'A REVISAR');
    assert.strictEqual(detalle[0].Sucursal, 'URQUIZA');
    assert.strictEqual(detalle[0].Ticket, 'FC B 0001-9');
    assert.strictEqual(detalle[0]['Dif. segundos'], 26405);
    assert.strictEqual(
      detalle[0]['Observación'],
      'Importe idéntico, pero la hora difiere: el ticket de SIGA está 7 h 20 min después del banco. Revisar.',
    );

    const resumen = XLSX.utils.sheet_to_json(wb.Sheets.Resumen, { header: 1 });
    assert.deepStrictEqual(resumen.find(f => f[0] === 'A REVISAR'), ['A REVISAR', 1, 52086.14]);
  });
});

// ── Resumen en la respuesta ───────────────────────────────────────────────────
test('responde JSON sin caché con el nombre del archivo, el resumen y el xlsx en base64', async () => {
  await conServidor(async () => [TICKET], async base => {
    const r = await subir(base, xlsDe([ENCABEZADO, FILA_OK]));
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /^application\/json/);
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    assert.strictEqual(r.headers.get('content-disposition'), null);

    const cuerpo = await r.json();
    assert.deepStrictEqual(Object.keys(cuerpo), ['resumen', 'archivo']);
    assert.deepStrictEqual(Object.keys(cuerpo.archivo), ['nombre', 'base64']);
    assert.strictEqual(cuerpo.archivo.nombre, 'cruce_bancario_2026-09-22.xlsx');
    // El base64 es un xlsx de verdad (firma ZIP "PK").
    assert.strictEqual(Buffer.from(cuerpo.archivo.base64, 'base64').subarray(0, 2).toString('latin1'), 'PK');
    assert.deepStrictEqual(Object.keys(cuerpo.resumen), ['parametros', 'archivo', 'porResultado', 'porSucursal', 'atencion']);
  });
});

test('el resumen de la respuesta trae los conteos por resultado y por sucursal', async () => {
  await conServidor(async () => [TICKET], async base => {
    const { resumen } = await (await subir(base, xlsDe([ENCABEZADO, FILA_OK]))).json();

    assert.deepStrictEqual(resumen.parametros, { tolMonto: 5, tolMin: 3 });
    assert.strictEqual(resumen.archivo.leidos, 1);
    assert.deepStrictEqual(resumen.porResultado.map(r => [r.resultado, r.cantidad, r.importe]), [
      ['UBICADO', 1, 13898], ['AMBIGUO', 0, 0], ['PAGO DIVIDIDO', 0, 0],
      ['A REVISAR', 0, 0], ['SIN UBICAR', 0, 0], ['NO APLICA', 0, 0],
    ]);
    assert.deepStrictEqual(resumen.porSucursal, [{ id: 3, nombre: 'URQUIZA', cantidad: 1, importe: 13898, revisar: 0 }]);
    assert.deepStrictEqual(resumen.atencion, { total: 0, omitidas: 0, filas: [] });
  });
});

test('el resumen de la respuesta lista en la atención los movimientos a revisar y los sin ubicar', async () => {
  const ticket = { ...TICKET, NumeroComprobante: '9', FechaTxt: '2026-09-22 19:45:42', ImporteTotal: 52086.14 };
  const filas = [
    ENCABEZADO,
    ['2026-09-22 09:00:00', 'Aprobada', '500,00', 'Venta', 'Visa'],
    ['2026-09-22 12:25:37', 'Aprobada', '52.086,14', 'Venta', 'Visa'],
  ];
  await conServidor(async () => [ticket], async base => {
    const { resumen } = await (await subir(base, xlsDe(filas))).json();

    assert.deepStrictEqual(resumen.atencion.filas.map(f => [f.fila, f.resultado, f.importe]), [
      [3, 'A REVISAR', 52086.14],
      [2, 'SIN UBICAR', 500],
    ]);
    const [aRevisar, sinUbicar] = resumen.atencion.filas;
    assert.deepStrictEqual([aRevisar.sucursal, aRevisar.ticket, aRevisar.fechaTicket], ['URQUIZA', 'FC B 0001-9', '2026-09-22 19:45:42']);
    assert.match(aRevisar.observacion, /7 h 20 min después del banco/);
    assert.deepStrictEqual([sinUbicar.sucursal, sinUbicar.ticket, sinUbicar.fechaTicket, sinUbicar.observacion, sinUbicar.otros], ['', '', '', '', '']);
  });
});

test('el resumen y la hoja Resumen del xlsx de la respuesta cuentan lo mismo', async () => {
  await conServidor(async () => [TICKET], async base => {
    const r = await subir(base, xlsDe([ENCABEZADO, FILA_OK, ['2026-09-22 10:00:00', 'Aprobada', '500,00', 'Venta', 'Visa']]));
    const cuerpo = await r.json();
    const wb = XLSX.read(Buffer.from(cuerpo.archivo.base64, 'base64'), { type: 'buffer' });
    const hoja = XLSX.utils.sheet_to_json(wb.Sheets.Resumen, { header: 1 });

    for (const { resultado, cantidad, importe } of cuerpo.resumen.porResultado) {
      assert.deepStrictEqual(hoja.find(f => f[0] === resultado), [resultado, cantidad, importe]);
    }
    assert.strictEqual(hoja.find(f => f[0] === 'Movimientos leídos')[1], cuerpo.resumen.archivo.leidos);
  });
});

test('la respuesta no lleva datos personales del archivo del banco', async () => {
  // Con el encabezado y las filas completas del banco: nombre, e-mail y tarjeta del cliente incluidos.
  const filas = [
    ENCABEZADO_REAL,
    filaBanco({ fecha: '2026-09-22 19:58:42', importe: '13.898,00' }),
    filaBanco({ fecha: '2026-09-22 10:00:00', importe: '500,00' }),
  ];
  await conServidor(async () => [TICKET], async base => {
    const cuerpo = await (await subir(base, xlsDe(filas))).json();
    const wb = XLSX.read(Buffer.from(cuerpo.archivo.base64, 'base64'), { type: 'buffer' });

    for (const texto of [JSON.stringify(cuerpo.resumen), JSON.stringify(XLSX.utils.sheet_to_json(wb.Sheets.Detalle))]) {
      assert.doesNotMatch(texto, /CLIENTE|USUARIO|47045500|@/);
    }
    assert.deepStrictEqual(Object.keys(cuerpo.resumen.atencion.filas[0]), [
      'fila', 'fecha', 'importe', 'resultado', 'sucursal', 'ticket', 'fechaTicket', 'observacion', 'otros',
    ]);
  });
});
