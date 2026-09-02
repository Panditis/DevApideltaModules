// Verifica la exportación de tickets del facturador: las filas que salen y el .xlsx que se
// arma a mano (ZIP sin comprimir + XML mínimo, sin librerías, porque el HTML viaja suelto).
// El control es de contraste: el archivo generado se vuelve a leer con la librería `xlsx`,
// así que si el escritor se rompe, Excel tampoco lo iba a poder abrir.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const RAIZ = path.join(__dirname, '..');

function cargarParser() {
  const src = fs.readFileSync(path.join(RAIZ, 'facturador.html'), 'utf8');
  const desde = src.split('parser-inicio');
  assert.equal(desde.length, 2, 'no se encontró el marcador parser-inicio en facturador.html');
  let bloque = desde[1];
  bloque = bloque.slice(bloque.indexOf('*/') + 2);
  const fin = bloque.indexOf('/* ---8<--- parser-fin');
  assert.ok(fin > 0, 'no se encontró el marcador parser-fin en facturador.html');
  bloque = bloque.slice(0, fin);
  return new Function(bloque + `
    return { COLUMNAS_TICKETS, MEDIOS_PAGO, mediosDeTickets, columnasDeTickets,
             esLineaPesable, codigoDeCarga, filasDeTickets,
             columnaXlsx, hojaXml, crc32, armarZip, armarXlsx };`)();
}

const P = cargarParser();

// Un pesable escaneado (prefijo 20 + PLU 12345 + 250 g) y uno de almacén leído por su EAN.
const TICKETS = [{
  numero: 'T-1', fechaLocal: '01/09/2026', horaLocal: '10:15', cliente: 'Mostrador',
  vendedor: 'Ana', descuentoPct: 0, subtotal: 1250, total: 1250,
  pagos: [{ medio: 'EFECTIVO', importe: 1250 }],
  lineas: [
    { plu: '12345', nombre: 'Nuez mariposa', cant: 0.25, unidad: 'kg', precio: 4000,
      subtotal: 1000, origen: 'balanza-peso', barra: '2012345002506' },
    { plu: '778', nombre: 'Yerba 1 kg', cant: 1, unidad: '', precio: 250,
      subtotal: 250, origen: 'barra', barra: '7790001001234' },
  ],
}];

function columnas(filas, nombre) {
  const i = filas[0].indexOf(nombre);
  assert.ok(i >= 0, 'falta la columna ' + nombre);
  return filas.slice(1).map(f => f[i]);
}

test('el pesable se exporta por el código de barras leído y el de almacén por su PLU', () => {
  // Act
  const filas = P.filasDeTickets(TICKETS);

  // Assert
  assert.deepEqual(filas[0], P.columnasDeTickets(TICKETS));
  assert.deepEqual(columnas(filas, 'Codigo'), ['12345', '778']);
  assert.deepEqual(columnas(filas, 'CodigoCarga'), ['2012345002506', '778']);
});

test('sin código leído, el pesable cae al PLU en vez de quedar vacío', () => {
  // Arrange
  const linea = { plu: '12345', unidad: 'kg', origen: 'manual' };

  // Act / Assert
  assert.equal(P.esLineaPesable(linea), true);
  assert.equal(P.codigoDeCarga(linea), '12345');
  assert.equal(P.codigoDeCarga({ plu: '778', origen: 'manual' }), '778');
});

test('la etiqueta de bulto (prefijo 21) también se exporta por el código leído', () => {
  // Arrange
  const linea = { plu: '900', unidad: '', peso: 1.2, origen: 'balanza-unidad', barra: '2109000012004' };

  // Act / Assert
  assert.equal(P.esLineaPesable(linea), true);
  assert.equal(P.codigoDeCarga(linea), '2109000012004');
});

test('el .xlsx generado se abre con la librería xlsx y trae los mismos valores', () => {
  // Arrange
  const filas = P.filasDeTickets(TICKETS);

  // Act
  const bytes = P.armarXlsx(filas, 'Tickets');
  const wb = XLSX.read(Buffer.from(bytes), { type: 'buffer' });
  const leidas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });

  // Assert
  assert.deepEqual(wb.SheetNames, ['Tickets']);
  assert.deepEqual(leidas[0], P.columnasDeTickets(TICKETS));
  assert.equal(leidas.length, filas.length);
  // Los códigos tienen que llegar como texto: numéricos, Excel los muestra en notación
  // científica y les come los ceros de la izquierda.
  assert.deepEqual(columnas(leidas, 'CodigoCarga'), ['2012345002506', '778']);
  assert.equal(columnas(leidas, 'Cantidad')[0], 0.25);
  assert.equal(columnas(leidas, 'Precio')[0], 4000);
  // El medio y el importe van separados: pegados en una celda, el importe no se suma.
  assert.equal(columnas(leidas, 'MedioPago')[0], 'EFECTIVO');
  assert.equal(columnas(leidas, 'Pago EFECTIVO')[0], 1250);
});

test('el pago dividido pone cada importe en la columna de su medio', () => {
  // Arrange
  const dividido = [{ ...TICKETS[0], pagos: [{ medio: 'TARJETA', importe: 250 },
                                             { medio: 'EFECTIVO', importe: 1000 }] }];

  // Act
  const filas = P.filasDeTickets(dividido);

  // Assert
  assert.deepEqual(filas[0].slice(-2), ['Pago EFECTIVO', 'Pago TARJETA']);   // orden de MEDIOS_PAGO
  assert.deepEqual(columnas(filas, 'MedioPago'), ['TARJETA + EFECTIVO', 'TARJETA + EFECTIVO']);
  assert.deepEqual(columnas(filas, 'Pago EFECTIVO'), [1000, 1000]);
  assert.deepEqual(columnas(filas, 'Pago TARJETA'), [250, 250]);
});

test('sólo salen las columnas de los medios que se usaron', () => {
  // Act
  const columnasHoy = P.columnasDeTickets(TICKETS);

  // Assert
  assert.deepEqual(columnasHoy.slice(-1), ['Pago EFECTIVO']);
  assert.ok(!columnasHoy.includes('Pago TARJETA'), 'no debería haber columna de un medio sin usar');
});

test('el mismo medio dos veces en un ticket se suma en su columna', () => {
  // Arrange
  const doble = [{ ...TICKETS[0], pagos: [{ medio: 'EFECTIVO', importe: 1000 },
                                          { medio: 'EFECTIVO', importe: 250 }] }];

  // Act / Assert
  assert.deepEqual(columnas(P.filasDeTickets(doble), 'Pago EFECTIVO'), [1250, 1250]);
});

test('un medio viejo, fuera de la lista actual, igual sale en la planilla', () => {
  // Arrange
  const viejo = [{ ...TICKETS[0], pagos: [{ medio: 'CHEQUE', importe: 1250 }] }];

  // Act
  const filas = P.filasDeTickets(viejo);

  // Assert
  assert.ok(!P.MEDIOS_PAGO.includes('CHEQUE'), 'el fixture dejó de ser un medio desconocido');
  assert.deepEqual(P.mediosDeTickets(viejo), ['CHEQUE']);
  assert.deepEqual(columnas(filas, 'Pago CHEQUE'), [1250, 1250]);
});

test('un ticket sin pago registrado no rompe la exportación', () => {
  // Arrange
  const sinPago = [{ ...TICKETS[0], pagos: [] }];

  // Act
  const filas = P.filasDeTickets(sinPago);

  // Assert
  assert.deepEqual(filas[0], P.COLUMNAS_TICKETS);
  assert.deepEqual(columnas(filas, 'MedioPago'), ['', '']);
});

test('el nombre y los caracteres especiales del producto sobreviven al XML', () => {
  // Arrange
  const raro = [{ numero: 1, fechaLocal: '01/09/2026', horaLocal: '11:00', total: 10, descuentoPct: 0,
    lineas: [{ plu: '1', nombre: 'Té & <azúcar> "premium"', cant: 1, precio: 10, subtotal: 10 }] }];

  // Act
  const wb = XLSX.read(Buffer.from(P.armarXlsx(P.filasDeTickets(raro), 'Tickets')), { type: 'buffer' });
  const leidas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });

  // Assert
  assert.equal(columnas(leidas, 'Producto')[0], 'Té & <azúcar> "premium"');
  assert.equal(columnas(leidas, 'Ticket')[0], 1);
});

test('columnaXlsx numera las columnas como Excel', () => {
  assert.equal(P.columnaXlsx(0), 'A');
  assert.equal(P.columnaXlsx(25), 'Z');
  assert.equal(P.columnaXlsx(26), 'AA');
  assert.equal(P.columnaXlsx(51), 'AZ');
});
