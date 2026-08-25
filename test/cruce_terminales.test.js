const test = require('node:test');
const assert = require('node:assert');
const {
  claveId, montoANumero, fechaAISO, esAprobado,
  parseCSV, detectarPlataforma, parseNombreSucursal, parseMapaTerminales, sucursalDe,
  comprobantesPayway, comprobantesQR, comprobantesDeArchivo,
  clasificar, resumenPorSucursal, totalesGenerales, rangoFechas,
  terminalesDesconocidas, separarDuplicados, procesarArchivos,
} = require('../cruce_terminales');

// Réplica reducida del xlsx "Distribucion Terminales por sucursal": la fila de
// sucursales usa celdas combinadas (nombre sólo en la primera columna del grupo).
const GRILLA_XLSX = [
  ['TERMINALES - PAYWAY'],
  [],
  ['', 'SUCURSAL'],
  ['', 'URQUIZA - (2)', '', 'NACIÓN - (3)', '', 'SAN PEDRO   (7)'],
  ['ID TERMINAL', '16826094', '16826095', '16826194', '16826195', '16826087'],
  ['MODELO DE TERMINAL', 'N910', 'N910', 'N910', 'N910', 'N910'],
  ['ESTABLECIMIENTOS:'],
  ['VISA', '3922473', '3922473', '3938008', '3938008', '3922184'],
  ['MASTER PRISMA', '3922580', '3922580', '3938040', '3938040', '3922226'],
];

const MAPA = parseMapaTerminales(GRILLA_XLSX);

const CSV_PAYWAY = [
  '"Detalle de Transacciones de Payway Desde: 03/08/2026 Hasta: 08/08/2026"',
  '"FECHA";"ESTABLECIMIENTO";"TERMINAL";"LOTE";"TIPO";"MARCA";"NRO.TARJETA";"CUOTAS";"NOMBRE";"ESTADO";"MONEDA";"MONTO_BRUTO";"NRO.CUPON";"NRO.AUTORIZACION";"RETIRO_EFVO";"UUID";"PAYMENT_ID";"APP_ID";"PROPINA"',
  '"07/08/2026";"3922473";"16826094";"67";"Compra";"VISA DEBITO";"************0001";"1";"";"Aprobado";"ARS";"1000.50";"823";"813365";"0.00";"u-1";"";"";"0.00"',
  '"07/08/2026";"3938040";"16826194";"39";"Compra";"MASTERCARD DEBIT";"************0002";"1";"";"Rechazado";"ARS";"200.00";"658";"643485";"0.00";"u-2";"";"";"0.00"',
  // Terminal fuera del mapa pero con establecimiento conocido: cae en NACIÓN por fallback.
  '"06/08/2026";"3938008";"99999999";"39";"Compra";"VISA DEBITO";"************0003";"1";"";"Aprobado";"ARS";"300.25";"659";"643486";"0.00";"u-3";"";"";"0.00"',
].join('\n');

const CSV_QR = [
  '',
  'FECHA;MEDIO DE PAGO;PUNTO DE VENTA;TID;QR ID;TERMINAL LOGICA;NOMBRE QR;DESTINO;BILLETERA;NRO TARJETA;CANAL;MONTO;ESTADO',
  '07/08/2026;TRANSFERENCIA;APIDELTASRL014;NA;337291869260807;16826095;16826095;014030;CUENTADNI;;TERMINAL FISICA;$ 2000.75;Aprobado',
  '05/08/2026;TRANSFERENCIA;APIDELTASRL014;NA;337291869260805;12345678;12345678;014030;CUENTADNI;;TERMINAL FISICA;$ 500.0;Devuelto',
].join('\n');

// ── Normalizadores ────────────────────────────────────────────────────────────
test('claveId compara terminales sin ceros a la izquierda ni separadores', () => {
  assert.strictEqual(claveId('016826094'), '16826094');
  assert.strictEqual(claveId(' 16826094 '), '16826094');
  assert.strictEqual(claveId(''), '');
});

test('montoANumero soporta el formato de cada plataforma', () => {
  assert.strictEqual(montoANumero('$ 28746.98'), 28746.98); // QR
  assert.strictEqual(montoANumero('13183.74'), 13183.74);   // Payway
  assert.strictEqual(montoANumero('28.746,98'), 28746.98);  // es-AR
  assert.strictEqual(montoANumero(''), 0);
});

test('fechaAISO pasa DD/MM/AAAA a ISO', () => {
  assert.strictEqual(fechaAISO('07/08/2026'), '2026-08-07');
  assert.strictEqual(fechaAISO('7/8/2026'), '2026-08-07');
  assert.strictEqual(fechaAISO('sin fecha'), '');
});

test('esAprobado sólo acepta el estado Aprobado; el resto no lo es', () => {
  assert.strictEqual(esAprobado('Aprobado'), true);
  assert.strictEqual(esAprobado('APROBADO'), true);
  assert.strictEqual(esAprobado('Rechazado'), false);
  assert.strictEqual(esAprobado('Devuelto'), false);
  assert.strictEqual(esAprobado(''), false);
});

// ── CSV ───────────────────────────────────────────────────────────────────────
test('parseCSV respeta comillas y descarta filas vacías', () => {
  const filas = parseCSV('"a";"b;c"\n\n"d";"e"');
  assert.deepStrictEqual(filas, [['a', 'b;c'], ['d', 'e']]);
});

test('detectarPlataforma distingue Payway de QR aunque el encabezado no sea la fila 1', () => {
  assert.strictEqual(detectarPlataforma(parseCSV(CSV_PAYWAY)), 'payway');
  assert.strictEqual(detectarPlataforma(parseCSV(CSV_QR)), 'qr');
  assert.strictEqual(detectarPlataforma(parseCSV('a;b\n1;2')), null);
});

test('comprobantesDeArchivo rechaza un archivo con formato desconocido', () => {
  assert.throws(() => comprobantesDeArchivo('a;b\n1;2', 'otro.csv'), /No reconozco el formato/);
});

// ── Mapa del xlsx ─────────────────────────────────────────────────────────────
test('parseNombreSucursal extrae el id entre paréntesis', () => {
  assert.deepStrictEqual(parseNombreSucursal('URQUIZA - (2)'), { id: 2, nombre: 'URQUIZA' });
  assert.deepStrictEqual(parseNombreSucursal('SAN PEDRO   (7)'), { id: 7, nombre: 'SAN PEDRO' });
  assert.strictEqual(parseNombreSucursal('   '), null);
});

test('parseMapaTerminales arrastra el nombre de sucursal sobre las celdas combinadas', () => {
  assert.deepStrictEqual(MAPA.sucursales, [
    { id: 2, nombre: 'URQUIZA', terminales: ['16826094', '16826095'] },
    { id: 3, nombre: 'NACIÓN', terminales: ['16826194', '16826195'] },
    { id: 7, nombre: 'SAN PEDRO', terminales: ['16826087'] },
  ]);
  assert.deepStrictEqual(MAPA.terminales['16826095'], { id: 2, nombre: 'URQUIZA' });
});

test('parseMapaTerminales mapea los establecimientos de cada marca a su sucursal', () => {
  assert.deepStrictEqual(MAPA.establecimientos['3938040'], { id: 3, nombre: 'NACIÓN' });
  assert.deepStrictEqual(MAPA.establecimientos['3922226'], { id: 7, nombre: 'SAN PEDRO' });
});

test('parseMapaTerminales falla si el xlsx no tiene la fila ID TERMINAL', () => {
  assert.throws(() => parseMapaTerminales([['algo', 'otra cosa']]), /ID TERMINAL/);
});

test('sucursalDe usa la terminal y recién después el establecimiento', () => {
  assert.deepStrictEqual(sucursalDe(MAPA, '16826094', ''), { id: 2, nombre: 'URQUIZA', origen: 'terminal' });
  assert.deepStrictEqual(sucursalDe(MAPA, '99999999', '3938008'), { id: 3, nombre: 'NACIÓN', origen: 'establecimiento' });
  assert.deepStrictEqual(sucursalDe(MAPA, '99999999', ''), { id: null, nombre: 'Sin identificar', origen: null });
});

// ── Comprobantes ──────────────────────────────────────────────────────────────
test('comprobantesPayway normaliza fecha, monto y estado', () => {
  const cs = comprobantesPayway(parseCSV(CSV_PAYWAY));
  assert.strictEqual(cs.length, 3);
  assert.strictEqual(cs[0].plataforma, 'Payway');
  assert.strictEqual(cs[0].fecha, '2026-08-07');
  assert.strictEqual(cs[0].terminal, '16826094');
  assert.strictEqual(cs[0].monto, 1000.5);
  assert.strictEqual(cs[0].aprobado, true);
  assert.strictEqual(cs[1].aprobado, false);
});

test('comprobantesQR toma la terminal lógica y limpia el signo peso del monto', () => {
  const cs = comprobantesQR(parseCSV(CSV_QR));
  assert.strictEqual(cs.length, 2);
  assert.strictEqual(cs[0].plataforma, 'QR');
  assert.strictEqual(cs[0].terminal, '16826095');
  assert.strictEqual(cs[0].monto, 2000.75);
  assert.strictEqual(cs[1].aprobado, false); // Devuelto no es aprobado
});

// ── Clasificación y resumen ───────────────────────────────────────────────────
const RESULTADO = procesarArchivos([
  { nombre: 'payway.csv', texto: CSV_PAYWAY },
  { nombre: 'qr.csv', texto: CSV_QR },
], MAPA);

test('procesarArchivos detecta la plataforma de cada archivo y junta los comprobantes', () => {
  assert.deepStrictEqual(RESULTADO.archivos, [
    { nombre: 'payway.csv', plataforma: 'payway', comprobantes: 3 },
    { nombre: 'qr.csv', plataforma: 'qr', comprobantes: 2 },
  ]);
  assert.strictEqual(RESULTADO.detalle.length, 5);
});

test('cada comprobante queda con su sucursal y su marca de aprobado', () => {
  const porComprobante = Object.fromEntries(RESULTADO.detalle.map(c => [c.comprobante, c]));
  assert.strictEqual(porComprobante['823'].sucursal, 'URQUIZA');
  assert.strictEqual(porComprobante['823'].aprobado, true);
  assert.strictEqual(porComprobante['659'].sucursal, 'NACIÓN');
  assert.strictEqual(porComprobante['659'].origenSucursal, 'establecimiento');
  assert.strictEqual(porComprobante['337291869260805'].sucursal, 'Sin identificar');
  assert.strictEqual(porComprobante['337291869260805'].identificada, false);
});

test('el resumen separa aprobados del resto por sucursal y deja Sin identificar al final', () => {
  const filas = RESULTADO.resumen;
  assert.deepStrictEqual(filas.map(f => f.sucursal), ['URQUIZA', 'NACIÓN', 'Sin identificar']);

  const urquiza = filas[0];
  assert.deepStrictEqual(urquiza.aprobados, { cantidad: 2, monto: 3001.25 }); // 1000.50 + 2000.75
  assert.deepStrictEqual(urquiza.noAprobados, { cantidad: 0, monto: 0 });
  assert.deepStrictEqual(urquiza.plataformas.map(p => p.plataforma), ['Payway', 'QR']);

  const nacion = filas[1];
  assert.deepStrictEqual(nacion.aprobados, { cantidad: 1, monto: 300.25 });
  assert.deepStrictEqual(nacion.noAprobados, { cantidad: 1, monto: 200 });
});

test('los totales generales cuadran con el detalle', () => {
  assert.deepStrictEqual(RESULTADO.totales, {
    comprobantes: 5,
    aprobados: { cantidad: 3, monto: 3301.5 },
    noAprobados: { cantidad: 2, monto: 700 },
    sinIdentificar: 1,
  });
});

test('rangoFechas devuelve la primera y la última fecha de la bajada', () => {
  assert.deepStrictEqual(RESULTADO.rango, { desde: '2026-08-05', hasta: '2026-08-07' });
});

test('terminalesDesconocidas junta lo que hay que dar de alta en el xlsx', () => {
  assert.deepStrictEqual(RESULTADO.desconocidas, [
    { terminal: '12345678', establecimiento: '', plataforma: 'QR', cantidad: 1, monto: 500 },
  ]);
});

test('procesarArchivos sin archivos avisa en lugar de devolver un resumen vacío', () => {
  assert.throws(() => procesarArchivos([], MAPA), /ningún archivo/);
});

test('clasificar sin mapa deja todo Sin identificar en vez de romper', () => {
  const detalle = clasificar(comprobantesPayway(parseCSV(CSV_PAYWAY)), null);
  assert.ok(detalle.every(c => c.sucursal === 'Sin identificar' && c.identificada === false));
  assert.strictEqual(totalesGenerales(detalle).sinIdentificar, 3);
  assert.strictEqual(resumenPorSucursal(detalle).length, 1);
  assert.deepStrictEqual(rangoFechas([]), { desde: null, hasta: null });
  assert.deepStrictEqual(terminalesDesconocidas([]), []);
});

// ── Cobros duplicados entre plataformas ───────────────────────────────────────
const detalleDup = (extra = []) => clasificar([
  { plataforma: 'QR', fecha: '2026-08-07', terminal: '16826094', tarjeta: '**** **** **** 4006', monto: 1000.5, comprobante: 'qr-1', aprobado: true },
  { plataforma: 'Payway', fecha: '2026-08-07', terminal: '16826094', tarjeta: '************4006', monto: 1000.5, comprobante: 'pw-1', aprobado: true },
  ...extra,
], MAPA);

test('separarDuplicados deja el registro de QR y aparta el de tarjetas', () => {
  const { detalle, duplicados } = separarDuplicados(detalleDup());
  assert.deepStrictEqual(detalle.map(c => c.comprobante), ['qr-1']);
  assert.strictEqual(duplicados.length, 1);
  assert.strictEqual(duplicados[0].descartadoComprobante, 'pw-1');
  assert.strictEqual(duplicados[0].qrComprobante, 'qr-1');
  assert.strictEqual(duplicados[0].tarjeta, '4006');
  assert.strictEqual(duplicados[0].sucursal, 'URQUIZA');
});

test('separarDuplicados no cruza si cambia día, terminal, monto o dígitos', () => {
  const distintos = [
    { plataforma: 'Payway', fecha: '2026-08-06', terminal: '16826094', tarjeta: '************4006', monto: 1000.5, comprobante: 'otro-dia', aprobado: true },
    { plataforma: 'Payway', fecha: '2026-08-07', terminal: '16826095', tarjeta: '************4006', monto: 1000.5, comprobante: 'otra-term', aprobado: true },
    { plataforma: 'Payway', fecha: '2026-08-07', terminal: '16826094', tarjeta: '************4006', monto: 1000.51, comprobante: 'otro-monto', aprobado: true },
    { plataforma: 'Payway', fecha: '2026-08-07', terminal: '16826094', tarjeta: '************9999', monto: 1000.5, comprobante: 'otra-tarj', aprobado: true },
  ];
  const { detalle, duplicados } = separarDuplicados(detalleDup(distintos));
  assert.strictEqual(duplicados.length, 1);
  assert.deepStrictEqual(detalle.map(c => c.comprobante),
    ['qr-1', 'otro-dia', 'otra-term', 'otro-monto', 'otra-tarj']);
});

test('separarDuplicados descarta 1 a 1: el cobro de más de Payway sobrevive', () => {
  const { detalle, duplicados } = separarDuplicados(detalleDup([
    { plataforma: 'Payway', fecha: '2026-08-07', terminal: '16826094', tarjeta: '************4006', monto: 1000.5, comprobante: 'pw-2', aprobado: true },
  ]));
  assert.strictEqual(duplicados.length, 1);
  assert.deepStrictEqual(detalle.map(c => c.comprobante), ['qr-1', 'pw-2']);
});

test('separarDuplicados no cruza transferencias: sin dígitos de tarjeta no hay caso', () => {
  const sinTarjeta = clasificar([
    { plataforma: 'QR', fecha: '2026-08-07', terminal: '16826094', tarjeta: '', monto: 1000.5, comprobante: 'qr-transf', aprobado: true },
    { plataforma: 'Payway', fecha: '2026-08-07', terminal: '16826094', tarjeta: '', monto: 1000.5, comprobante: 'pw-sin-tarj', aprobado: true },
  ], MAPA);
  const { detalle, duplicados } = separarDuplicados(sinTarjeta);
  assert.strictEqual(duplicados.length, 0);
  assert.strictEqual(detalle.length, 2);
});
