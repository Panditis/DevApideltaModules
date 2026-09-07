const test = require('node:test');
const assert = require('node:assert');
const { parsearCompra, parsearCabecera, parsearDetalle, parsearDetallePedido, calcularTotales, aNumero, aFechaISO } = require('../lib/compras_import');

// ── Formato plano: una sola hoja con todo en columnas ───────────────────────
const TITULOS_PLANO = [
  'IdProveedor', 'TipoComprobante', 'Letra', 'PuntoVenta', 'NumeroComprobante', 'FechaComprobante',
  'IdSucursal', 'IdDeposito', 'IdUbicacion', 'PercepcionIVA',
  'PLU', 'CodigoProveedor', 'Cantidad', 'PrecioUnitario', 'PorcentajeIVA', 'Descripcion',
];
const CAB_PLANO = [328, 'FACTCOM', 'A', 5007, 1234567, '2026-08-31', 1, 1, 1, 0];

test('plano: lee cabecera y detalle de una sola hoja', () => {
  const matriz = [
    TITULOS_PLANO,
    [...CAB_PLANO, '2124', '29', 12, 5680.29, 21, 'Aceitunas Negras'],
    [...CAB_PLANO, '2113', '65', 12, 9774.00, 21, 'Aceitunas Negras N0'],
  ];
  const r = parsearCompra({ matriz });

  assert.deepStrictEqual(r.errores, []);
  assert.strictEqual(r.cabecera.IdProveedor, 328);
  assert.strictEqual(r.cabecera.TipoComprobante, 'FACTCOM');
  assert.strictEqual(r.cabecera.FechaVencimiento, '2026-09-30');
  assert.strictEqual(r.lineas.length, 2);
  assert.strictEqual(r.totales.total, 224396.29, 'mismo total que el formato de dos hojas');
});

test('plano: la cabecera puede ir sólo en la primera fila', () => {
  const vacios = CAB_PLANO.map(() => '');
  const matriz = [
    TITULOS_PLANO,
    [...CAB_PLANO, '2124', '29', 12, 5680.29, 21, 'Primera'],
    [...vacios,    '2113', '65', 12, 9774.00, 21, 'Hereda de arriba'],
  ];
  const r = parsearCompra({ matriz });

  assert.deepStrictEqual(r.errores, []);
  assert.strictEqual(r.cabecera.NumeroComprobante, 1234567);
  assert.strictEqual(r.lineas.length, 2);
});

test('plano: rechaza dos comprobantes distintos en el mismo archivo', () => {
  const otro = [...CAB_PLANO];
  otro[4] = 7654321;                                    // NumeroComprobante distinto
  const matriz = [
    TITULOS_PLANO,
    [...CAB_PLANO, '2124', '29', 12, 5680.29, 21, 'Factura A'],
    [...otro,      '2113', '65', 12, 9774.00, 21, 'Factura B'],
  ];
  const r = parsearCompra({ matriz });

  assert.strictEqual(r.valido, false);
  assert.ok(r.errores.some(e => e.includes('NumeroComprobante') && e.includes('una sola factura')), r.errores.join(' | '));
});

test('plano: corta en la primera fila sin identificador', () => {
  const matriz = [
    TITULOS_PLANO,
    [...CAB_PLANO, '2124', '29', 12, 5680.29, 21, 'Item'],
    [...CAB_PLANO.map(() => ''), '', '', '', '', '', 'TOTAL'],
    [...CAB_PLANO, '2113', '65', 12, 9774.00, 21, 'Después del corte'],
  ];
  const r = parsearCompra({ matriz });
  assert.strictEqual(r.lineas.length, 1);
});

test('plano: los títulos toleran variantes de escritura', () => {
  const matriz = [
    ['id proveedor', 'Tipo_Comprobante', 'LETRA', 'Punto Venta', 'numerocomprobante', 'Fecha Comprobante',
     'IdSucursal', 'IdDeposito', 'IdUbicacion', 'plu', 'cantidad', 'precio unitario', 'Porcentaje IVA'],
    [328, 'FACTCOM', 'A', 5007, 1234567, '2026-08-31', 1, 1, 1, '2124', 12, 5680.29, 21],
  ];
  const r = parsearCompra({ matriz });
  assert.deepStrictEqual(r.errores, []);
  assert.strictEqual(r.lineas[0].neto, 68163.48);
});

test('plano: reporta los obligatorios que faltan como columna', () => {
  const matriz = [
    ['IdProveedor', 'PLU', 'Cantidad', 'PrecioUnitario', 'PorcentajeIVA'],
    [328, '2124', 12, 5680.29, 21],
  ];
  const r = parsearCompra({ matriz });
  assert.strictEqual(r.valido, false);
  assert.ok(r.errores.some(e => e.includes('TipoComprobante')), r.errores.join(' | '));
});

const CABECERA_OK = [
  ['Campo', 'Valor', 'Tipo', 'Obligatorio', 'Notas'],
  ['IdProveedor', 328],
  ['TipoComprobante', 'FACTCOM'],
  ['Letra', 'A'],
  ['PuntoVenta', 5007],
  ['NumeroComprobante', 1234567],
  ['FechaComprobante', '2026-08-31'],
  ['IdSucursal', 1],
  ['IdDeposito', 1],
  ['IdUbicacion', 1],
];

const DETALLE_OK = [
  ['PLU', 'Cantidad', 'PrecioUnitario', 'PorcentajeIVA', 'CodigoProveedor', 'Descripcion'],
  ['2124', 12, 5680.29, 21, '29', 'Aceitunas Negras Griegas'],
  ['2113', 12, 9774.00, 21, '65', 'Aceitunas Negras Nat N0'],
];

test('parsea una compra válida y calcula el total', () => {
  const r = parsearCompra({ matrizCabecera: CABECERA_OK, matrizDetalle: DETALLE_OK });

  assert.deepStrictEqual(r.errores, []);
  assert.strictEqual(r.valido, true);
  assert.strictEqual(r.lineas.length, 2);
  assert.strictEqual(r.totales.neto, 185451.48);
  assert.strictEqual(r.totales.totalIVA, 38944.81);
  assert.strictEqual(r.totales.total, 224396.29);
});

test('el IVA se agrupa por alícuota, no por línea', () => {
  const detalle = [
    ['PLU', 'Cantidad', 'PrecioUnitario', 'PorcentajeIVA'],
    ['2124', 12, 5680.29, 21],
    ['2139', 84, 2997.23, 10.5],
    ['30191', 60, 2420.43, 0],
  ];
  const { totales } = parsearCompra({ matrizCabecera: CABECERA_OK, matrizDetalle: detalle });
  const ivas = totales.impuestos.filter(i => i.tipo === 'IVA');

  assert.strictEqual(ivas.length, 3, 'una fila por alícuota presente');
  assert.deepStrictEqual(ivas.map(i => i.alicuota), [21, 10.5, 0], 'ordenadas de mayor a menor');
  assert.strictEqual(ivas[0].importe, 14314.33);
  assert.strictEqual(ivas[1].importe, 26435.57);
  assert.strictEqual(ivas[2].importe, 0);
});

test('las percepciones se suman al total y salen como filas propias', () => {
  const cabecera = [...CABECERA_OK, ['PercepcionIVA', 3000], ['PercepcionIIBB', 1500.5]];
  const { totales } = parsearCompra({ matrizCabecera: cabecera, matrizDetalle: DETALLE_OK });

  assert.strictEqual(totales.totalPercepciones, 4500.5);
  assert.strictEqual(totales.total, 228896.79);
  assert.ok(totales.impuestos.some(i => i.tipo === 'PIVA' && i.importe === 3000));
  assert.ok(totales.impuestos.some(i => i.tipo === 'PIIBB' && i.importe === 1500.5));
});

test('rechaza si el ImporteTotal declarado no coincide con el calculado', () => {
  const cabecera = [...CABECERA_OK, ['ImporteTotal', 999999]];
  const r = parsearCompra({ matrizCabecera: cabecera, matrizDetalle: DETALLE_OK });

  assert.strictEqual(r.valido, false);
  assert.ok(r.errores.some(e => e.includes('no coincide')), r.errores.join(' | '));
});

test('acepta el ImporteTotal correcto', () => {
  const cabecera = [...CABECERA_OK, ['ImporteTotal', 224396.29]];
  const r = parsearCompra({ matrizCabecera: cabecera, matrizDetalle: DETALLE_OK });
  assert.deepStrictEqual(r.errores, []);
});

// Una factura la emite el proveedor: letra, punto de venta y número salen del papel.
test('factura sin NumeroComprobante es un error: el número lo trae el proveedor', () => {
  const cab = CABECERA_OK.filter(f => f[0] !== 'NumeroComprobante');
  const r = parsearCompra({ matrizCabecera: cab, matrizDetalle: DETALLE_OK });

  assert.strictEqual(r.valido, false);
  assert.ok(r.errores.some(e => e.includes('NumeroComprobante') && e.includes('obligatorio')), r.errores.join(' | '));
  assert.strictEqual(r.cabecera.numeroAutomatico, undefined, 'una factura nunca se autonumera');
});

test('cotización sin NumeroComprobante se autonumera', () => {
  const cab = CABECERA_OK
    .filter(f => f[0] !== 'NumeroComprobante')
    .map(f => (f[0] === 'TipoComprobante' ? ['TipoComprobante', 'COTIZACIONCOM'] : f[0] === 'Letra' ? ['Letra', 'X'] : f));
  const r = parsearCompra({ matrizCabecera: cab, matrizDetalle: DETALLE_OK });

  assert.deepStrictEqual(r.errores, []);
  assert.strictEqual(r.cabecera.numeroAutomatico, true);
  assert.ok(r.avisos.some(a => a.includes('lo asigna el sistema')), r.avisos.join(' | '));
});

test('con NumeroComprobante no marca numeración automática', () => {
  const r = parsearCompra({ matrizCabecera: CABECERA_OK, matrizDetalle: DETALLE_OK });
  assert.strictEqual(r.cabecera.numeroAutomatico, undefined);
  assert.strictEqual(r.cabecera.NumeroComprobante, 1234567);
});

test('la letra tiene que corresponder al tipo de comprobante', () => {
  const facturaX = CABECERA_OK.map(f => (f[0] === 'Letra' ? ['Letra', 'X'] : f));
  const rX = parsearCabecera(facturaX);
  assert.ok(rX.errores.some(e => e.includes('no corresponde a FACTCOM')), rX.errores.join(' | '));

  const cotizacionA = CABECERA_OK.map(f => (f[0] === 'TipoComprobante' ? ['TipoComprobante', 'COTIZACIONCOM'] : f));
  const rA = parsearCabecera(cotizacionA);
  assert.ok(rA.errores.some(e => e.includes('no corresponde a COTIZACIONCOM')), rA.errores.join(' | '));
});

test('NCREDCOM no habilita la letra M, FACTCOM sí', () => {
  const nc = CABECERA_OK.map(f => (f[0] === 'TipoComprobante' ? ['TipoComprobante', 'NCREDCOM'] : f[0] === 'Letra' ? ['Letra', 'M'] : f));
  assert.ok(parsearCabecera(nc).errores.some(e => e.includes('no corresponde a NCREDCOM')));

  const fc = CABECERA_OK.map(f => (f[0] === 'Letra' ? ['Letra', 'M'] : f));
  assert.deepStrictEqual(parsearCabecera(fc).errores, []);
});

test('plano: cotización con la columna NumeroComprobante vacía', () => {
  const cab = [...CAB_PLANO];
  cab[1] = 'COTIZACIONCOM'; cab[2] = 'X'; cab[4] = '';
  const matriz = [
    TITULOS_PLANO,
    [...cab, '2124', '29', 12, 5680.29, 21, 'Aceitunas Negras'],
    [...cab, '2113', '65', 12, 9774.00, 21, 'Aceitunas Negras N0'],
  ];
  const r = parsearCompra({ matriz });

  assert.deepStrictEqual(r.errores, []);
  assert.strictEqual(r.cabecera.numeroAutomatico, true);
  assert.strictEqual(r.lineas.length, 2);
});

test('reporta los campos obligatorios que faltan', () => {
  const { errores } = parsearCabecera([['Campo', 'Valor'], ['IdProveedor', 328]]);
  assert.ok(errores.some(e => e.includes('TipoComprobante')));
  assert.ok(errores.some(e => e.includes('FechaComprobante')));
  assert.ok(!errores.some(e => e.includes('IdProveedor')), 'IdProveedor vino, no debe figurar');
});

test('valida tipo de comprobante y letra', () => {
  const cab = CABECERA_OK.map(f => (f[0] === 'Letra' ? ['Letra', 'Z'] : f));
  const { errores } = parsearCabecera(cab);
  assert.ok(errores.some(e => e.includes('"Z"') && e.includes('FACTCOM')), errores.join(' | '));
});

test('completa FechaVencimiento a 30 días si no viene', () => {
  const { cabecera } = parsearCabecera(CABECERA_OK);
  assert.strictEqual(cabecera.FechaVencimiento, '2026-09-30');
});

test('respeta la FechaVencimiento explícita', () => {
  const { cabecera } = parsearCabecera([...CABECERA_OK, ['FechaVencimiento', '2026-10-15']]);
  assert.strictEqual(cabecera.FechaVencimiento, '2026-10-15');
});

test('corta el detalle en la primera fila sin identificador', () => {
  const detalle = [
    ['PLU', 'Cantidad', 'PrecioUnitario', 'PorcentajeIVA'],
    ['2124', 12, 5680.29, 21],
    ['', '', '', ''],
    ['SUBTOTAL', 999, 999, 21],           // basura del pie de la planilla
  ];
  const { lineas } = parsearDetalle(detalle);
  assert.strictEqual(lineas.length, 1);
});

test('rechaza cantidad no positiva y alícuota inválida', () => {
  const detalle = [
    ['PLU', 'Cantidad', 'PrecioUnitario', 'PorcentajeIVA'],
    ['2124', 0, 5680.29, 21],
    ['2113', 5, 100, 15],
  ];
  const { errores } = parsearDetalle(detalle);
  assert.ok(errores.some(e => e.includes('Fila 2') && e.includes('mayor a 0')), errores.join(' | '));
  assert.ok(errores.some(e => e.includes('Fila 3') && e.includes('alícuota')), errores.join(' | '));
});

test('exige al menos una columna de identificación', () => {
  const { errores } = parsearDetalle([['Cantidad', 'PrecioUnitario', 'PorcentajeIVA'], [1, 2, 21]]);
  assert.ok(errores.some(e => e.includes('identificación')), errores.join(' | '));
});

test('acepta identificar por código de proveedor sin PLU', () => {
  const detalle = [
    ['CodigoProveedor', 'Cantidad', 'PrecioUnitario', 'PorcentajeIVA'],
    ['480VERD', 120, 3995.21, 21],
  ];
  const r = parsearCompra({ matrizCabecera: CABECERA_OK, matrizDetalle: detalle });
  assert.deepStrictEqual(r.errores, []);
  assert.strictEqual(r.lineas[0].plu, null);
  assert.strictEqual(r.lineas[0].codigoProveedor, '480VERD');
  assert.ok(r.avisos.some(a => a.includes('código de proveedor')), r.avisos.join(' | '));
});

test('los títulos toleran acentos, espacios y mayúsculas', () => {
  const detalle = [
    ['plu', ' Cantidad ', 'Precio_Unitario', 'PORCENTAJE IVA'],
    ['2124', 12, 5680.29, 21],
  ];
  const { lineas, errores } = parsearDetalle(detalle);
  assert.deepStrictEqual(errores, []);
  assert.strictEqual(lineas[0].neto, 68163.48);
});

test('aNumero rechaza montos ambiguos con separador de miles', () => {
  assert.strictEqual(aNumero('1.234,56'), null);
  assert.strictEqual(aNumero('1,234.56'), null);
  assert.strictEqual(aNumero('5680,29'), 5680.29);
  assert.strictEqual(aNumero('5680.29'), 5680.29);
  assert.strictEqual(aNumero('$100'), 100);
  assert.strictEqual(aNumero('doce'), null);
  assert.strictEqual(aNumero(12), 12);
});

test('aFechaISO acepta serial de Excel y texto', () => {
  assert.strictEqual(aFechaISO('2026-08-31'), '2026-08-31');
  assert.strictEqual(aFechaISO('31/08/2026'), '2026-08-31');
  assert.strictEqual(aFechaISO(46265), '2026-08-31');
  assert.strictEqual(aFechaISO('el martes'), null);
});

test('el neto no arrastra error de punto flotante', () => {
  const detalle = [
    ['PLU', 'Cantidad', 'PrecioUnitario', 'PorcentajeIVA'],
    ['2139', 84, 2997.23, 0],
    ['2121', 120, 3995.21, 0],
  ];
  const { lineas } = parsearDetalle(detalle);
  const { neto } = calcularTotales({}, lineas);
  assert.strictEqual(neto, 731192.52);   // 251767.32 + 479425.20
});

// ── parsearDetallePedido: pedidos de compra sin precio ni IVA ────────────────

test('parsearDetallePedido: caso feliz con 2 filas PLU + Cantidad', () => {
  const matriz = [
    ['PLU', 'CodigoProveedor', 'Cantidad', 'Descripcion'],
    ['2124', '29', 12, 'Aceitunas Negras'],
    ['2113', '65', 24, 'Aceitunas Verdes'],
  ];
  const { lineas, errores } = parsearDetallePedido(matriz);

  assert.deepStrictEqual(errores, []);
  assert.strictEqual(lineas.length, 2);
  assert.strictEqual(lineas[0].plu, '2124');
  assert.strictEqual(lineas[0].cantidad, 12);
  assert.strictEqual(lineas[0].orden, 1);
  assert.strictEqual(lineas[1].plu, '2113');
  assert.strictEqual(lineas[1].cantidad, 24);
  assert.strictEqual(lineas[1].orden, 2);
});

test('parsearDetallePedido: rechaza si falta columna Cantidad', () => {
  const matriz = [
    ['PLU', 'CodigoProveedor', 'Descripcion'],
    ['2124', '29', 'Aceitunas'],
  ];
  const { lineas, errores } = parsearDetallePedido(matriz);

  assert.strictEqual(lineas.length, 0);
  assert.ok(errores.some(e => e.includes('Falta la columna "Cantidad"')), errores.join(' | '));
});

test('parsearDetallePedido: rechaza si falta toda columna de identificación', () => {
  const matriz = [
    ['Cantidad', 'Descripcion'],
    [12, 'Aceitunas'],
  ];
  const { lineas, errores } = parsearDetallePedido(matriz);

  assert.strictEqual(lineas.length, 0);
  assert.ok(errores.some(e => e.includes('identificación')), errores.join(' | '));
});

test('parsearDetallePedido: corta en fila sin identificador (subtotal al pie)', () => {
  const matriz = [
    ['PLU', 'CodigoProveedor', 'Cantidad', 'Descripcion'],
    ['2124', '29', 12, 'Item 1'],
    ['2113', '65', 24, 'Item 2'],
    ['', '', '', 'SUBTOTAL'],
    ['', '', 999, 'Basura'],
  ];
  const { lineas, errores } = parsearDetallePedido(matriz);

  assert.deepStrictEqual(errores, []);
  assert.strictEqual(lineas.length, 2, 'no incluye la fila de subtotal ni la siguiente');
});

test('parsearDetallePedido: toleran variantes en nombres de columna (espacios, acentos)', () => {
  const matriz = [
    ['plu', ' Codigo Proveedor ', 'CANTIDAD'],
    ['2124', '29', 12],
  ];
  const { lineas, errores } = parsearDetallePedido(matriz);

  assert.deepStrictEqual(errores, []);
  assert.strictEqual(lineas.length, 1);
  assert.strictEqual(lineas[0].cantidad, 12);
});

test('parsearDetallePedido: cantidad 0 y negativa generan errores separados sin cortar', () => {
  const matriz = [
    ['PLU', 'Cantidad'],
    ['2124', 0],
    ['2113', 10],
    ['2139', -5],
  ];
  const { lineas, errores } = parsearDetallePedido(matriz);

  assert.ok(errores.some(e => e.includes('Fila 2') && e.includes('mayor a 0')), errores.join(' | '));
  assert.ok(errores.some(e => e.includes('Fila 4') && e.includes('mayor a 0')), errores.join(' | '));
  assert.strictEqual(lineas.length, 3, 'sigue parseando el resto de filas');
  assert.strictEqual(lineas[1].cantidad, 10, 'la línea 3 válida se procesa');
});

test('parsearDetallePedido: cantidad ambigua con separador de miles se rechaza', () => {
  const matriz = [
    ['PLU', 'Cantidad'],
    ['2124', '1.234,56'],
  ];
  const { lineas, errores } = parsearDetallePedido(matriz);

  assert.ok(errores.some(e => e.includes('Fila 2') && e.includes('no es un número válido')), errores.join(' | '));
  assert.strictEqual(lineas.length, 1, 'se agrega igual pero con cantidad null');
  assert.strictEqual(lineas[0].cantidad, null);
});

test('parsearDetallePedido: acepta identificar solo por CodigoBarras sin PLU', () => {
  const matriz = [
    ['PLU', 'CodigoBarras', 'Cantidad'],
    ['', '7798012345678', 50],
  ];
  const { lineas, errores } = parsearDetallePedido(matriz);

  assert.deepStrictEqual(errores, []);
  assert.strictEqual(lineas.length, 1);
  assert.strictEqual(lineas[0].plu, null);
  assert.strictEqual(lineas[0].codigoBarras, '7798012345678');
});

test('parsearDetallePedido: matriz vacía (solo títulos) genera error de ítems', () => {
  const matriz = [
    ['PLU', 'Cantidad', 'Descripcion'],
  ];
  const { lineas, errores } = parsearDetallePedido(matriz);

  assert.strictEqual(lineas.length, 0);
  assert.ok(errores.some(e => e.includes('no tiene ítems')), errores.join(' | '));
});

test('parsearDetallePedido: deduplica por orden (mismo PLU en dos filas = dos líneas en salida)', () => {
  const matriz = [
    ['PLU', 'Cantidad'],
    ['2124', 12],
    ['2124', 24],
  ];
  const { lineas, errores } = parsearDetallePedido(matriz);

  assert.deepStrictEqual(errores, []);
  assert.strictEqual(lineas.length, 2, 'NO deduplica: ambas líneas aparecen');
  assert.strictEqual(lineas[0].cantidad, 12);
  assert.strictEqual(lineas[1].cantidad, 24);
  assert.strictEqual(lineas[0].orden, 1);
  assert.strictEqual(lineas[1].orden, 2);
});
