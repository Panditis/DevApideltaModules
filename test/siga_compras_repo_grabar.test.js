'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crearRepo = require('../lib/siga_compras/repo');
const { calcularComprobante, armarComprobante } = require('../lib/siga_compras/armar_comprobante');
const { ErrorSiga } = require('../lib/siga_compras/sql_comun');
const { crearSqlFalso, assertParametrizado } = require('./siga_compras_sql_falso');
const { borradorFactcom, contextoFactcom, AHORA } = require('./siga_compras_fixture');

const filasDe = (b = borradorFactcom(), ctx = contextoFactcom()) =>
  armarComprobante(b, ctx, calcularComprobante(b, ctx), { ahora: AHORA, usuario: 'adriel' });

const RESPUESTAS = texto => {
  if (/^SELECT ISNULL\(MAX/.test(texto)) return { recordset: [{ Siguiente: 51 }] };
  if (/^SELECT Numero FROM MovimientosNumeros/.test(texto)) return { recordset: [{ Numero: 41 }] };
  return { recordset: [], rowsAffected: [1] };
};

function grabarCon(responder = RESPUESTAS, filas = filasDe()) {
  const falso = crearSqlFalso(responder);
  return { falso, promesa: crearRepo(falso).grabar(filas) };
}

// Etiqueta de cada sentencia, para comparar la secuencia exacta.
const ETIQUETAS = [
  ['BEGIN', /^BEGIN TRAN$/],
  ['COMMIT', /^COMMIT$/],
  ['ROLLBACK', /^ROLLBACK$/],
  ['MAX', /^SELECT ISNULL\(MAX\(C\.NumeroComprobante\), 0\) \+ 1 AS Siguiente FROM Compras C WITH \(UPDLOCK, HOLDLOCK\)/],
  ['DUP_COMPRAS', /^SELECT TOP 1 C\.IdSucursal FROM Compras C WITH \(UPDLOCK, HOLDLOCK\)/],
  ['DUP_CTACTE', /^SELECT TOP 1 CCP\.IdSucursal FROM CuentasCorrientesProv CCP WITH \(UPDLOCK, HOLDLOCK\)/],
  ['VN_G1', /^SELECT TOP 1 VN\.IdTipoComprobante FROM VentasNumeros VN\s+WHERE/],
  ['MN_LEER', /^SELECT Numero FROM MovimientosNumeros WITH \(UPDLOCK, HOLDLOCK\)/],
  ['COMPRAS', /^INSERT INTO Compras \(/],
  ['PF_TOTALES', /^UPDATE PeriodosFiscales SET TotalNetoVentas/],
  ['PF_POSICION', /^UPDATE PeriodosFiscales SET Posicion/],
  ['CP', /^INSERT INTO ComprasProductos \(/],
  ['CI', /^INSERT INTO ComprasImpuestos \(/],
  ['MN_INSERT', /^IF NOT EXISTS \(SELECT Numero FROM MovimientosNumeros/],
  ['MN_UPDATE', /^UPDATE MovimientosNumeros SET Numero = @numero/],
  ['MS', /^INSERT INTO MovimientosStock \(/],
  ['MSP', /^INSERT INTO MovimientosStockProductos \(/],
  ['PS', /^UPDATE PS SET Stock = Stock \+ @cantidad FROM ProductosSucursales PS/],
  ['PD', /^MERGE INTO ProductosDepositos WITH \(HOLDLOCK\) AS D/],
  ['PU', /^MERGE INTO ProductosUbicaciones WITH \(HOLDLOCK\) AS D/],
  ['PP', /^IF EXISTS \(SELECT 1 FROM ProductosProveedores WITH \(UPDLOCK, HOLDLOCK\)/],
  ['CCP', /^INSERT INTO CuentasCorrientesProv \(/],
  ['CCPP', /^INSERT INTO CuentasCorrientesProvPagos \(/],
];
const etiqueta = texto => (ETIQUETAS.find(([, re]) => re.test(texto)) || ['?'])[0];
const secuencia = registro => registro.map(e => etiqueta(e.texto));
const buscar = (registro, nombre) => registro.filter(e => etiqueta(e.texto) === nombre);

const SECUENCIA_FACTCOM = [
  'BEGIN', 'DUP_COMPRAS', 'DUP_CTACTE', 'VN_G1', 'MN_LEER', 'COMPRAS', 'PF_TOTALES', 'PF_POSICION', 'CP', 'CP',
  'CI', 'CI', 'CI', 'MN_INSERT', 'MN_UPDATE', 'MS',
  'MSP', 'PS', 'PD', 'PU', 'PP',
  'MSP', 'PS', 'PD', 'PU', 'PP',
  'CCP', 'CCPP', 'COMMIT',
];

test('grabar: una transacción con la secuencia exacta de SiGA (DOC Parte II §1.3)', async () => {
  const { falso, promesa } = grabarCon();
  const r = await promesa;
  assert.deepStrictEqual(r, {
    clave: { IdSucursal: 1, IdTipoComprobante: 'FACTCOM', Letra: 'A', CentroEmisor: 5007, NumeroComprobante: 1071364, IdProveedor: 328 },
    numeroMovimiento: 42,
  });
  assert.deepStrictEqual(secuencia(falso.registro), SECUENCIA_FACTCOM);
  assert.ok(falso.registro.every(e => e.pool === 'stock'), 'todo con getPoolStock');
});

test('grabar: todo parametrizado (sin comillas en el SQL) y con la clave definitiva', async () => {
  const { falso, promesa } = grabarCon();
  await promesa;
  assertParametrizado(falso.registro);
  assert.ok(falso.registro.every(e => !e.texto.includes("'")), 'hay un literal entre comillas');
  const filas = filasDe();
  assert.deepStrictEqual(buscar(falso.registro, 'COMPRAS')[0].params, { ...filas.clave, ...filas.compras });
  const impuestos = buscar(falso.registro, 'CI').map(e => e.params);
  assert.deepStrictEqual(impuestos.map(p => [p.Orden, p.Emisor, p.Numero]), [[1, 5007, 1071364], [2, 5007, 1071364], [3, 5007, 1071364]]);
  const ms = buscar(falso.registro, 'MS')[0].params;
  assert.deepStrictEqual([ms.NumeroMovimiento, ms.IdTipoMovimiento, ms.IdTipoComprobante, ms.NumeroComprobante], [42, 'COMPRA', 'FACTCOM', 1071364]);
  const msp = buscar(falso.registro, 'MSP')[0].params;
  assert.deepStrictEqual([msp.IdSucursal, msp.IdTipoMovimiento, msp.NumeroMovimiento, msp.Orden, msp.Precio], [1, 'COMPRA', 42, 1, 31839.64]);
});

test('grabar: MovimientosNumeros como MovimientosNumeros_U (IF NOT EXISTS INSERT + UPDATE) con el número leído con lock + 1', async () => {
  const { falso, promesa } = grabarCon(texto => (/^SELECT Numero FROM MovimientosNumeros/.test(texto) ? { recordset: [] } : RESPUESTAS(texto)));
  const r = await promesa;
  assert.strictEqual(r.numeroMovimiento, 1);
  const leer = buscar(falso.registro, 'MN_LEER')[0];
  assert.deepStrictEqual(leer.params, { idSucursal: 1, idTipoMovimiento: 'COMPRA' });
  const [ins] = buscar(falso.registro, 'MN_INSERT');
  assert.match(ins.texto, /BEGIN INSERT INTO MovimientosNumeros \(IdSucursal, IdTipoMovimiento, Numero\) VALUES \(@idSucursal, @idTipoMovimiento, @numero\) END$/);
  assert.deepStrictEqual(ins.params, { idSucursal: 1, idTipoMovimiento: 'COMPRA', numero: 1 });
  assert.deepStrictEqual(buscar(falso.registro, 'MN_UPDATE')[0].params, { idSucursal: 1, idTipoMovimiento: 'COMPRA', numero: 1 });
});

test('grabar: libro IVA con PeriodosFiscales_UPosicion (dos sentencias, importes de la fila periodoFiscal)', async () => {
  const { falso, promesa } = grabarCon();
  await promesa;
  const [totales] = buscar(falso.registro, 'PF_TOTALES');
  assert.deepStrictEqual(totales.params, {
    idEmpresa: 1, periodoFiscal: 202610, netoVentas: 0, impuestosVentas: 0, ventas: 0,
    netoCompras: 35023.65, impuestosCompras: 6686.32, compras: 42665.16, retenciones: 0, percepciones: 955.19,
  });
  const [posicion] = buscar(falso.registro, 'PF_POSICION');
  assert.match(posicion.texto, /PosicionFinal = TotalImpuestosVentas - TotalImpuestosCompras - TotalRetenciones - TotalPercepciones/);
  assert.deepStrictEqual(posicion.params, { idEmpresa: 1, periodoFiscal: 202610 });
});

test('grabar: período fiscal no habilitado (0 filas) → ErrorSiga con el mensaje de SiGA y rollback', async () => {
  const { falso, promesa } = grabarCon(texto => (/^UPDATE PeriodosFiscales SET TotalNetoVentas/.test(texto) ? { rowsAffected: [0] } : RESPUESTAS(texto)));
  await assert.rejects(promesa, err => err instanceof ErrorSiga
    && err.message === 'La Fecha del Comprobante pertenece a un Periodo Fiscal (202610) que aún NO esta habilitado.');
  assert.deepStrictEqual(secuencia(falso.registro).slice(-2), ['PF_TOTALES', 'ROLLBACK']);
});

test('grabar: stock por destino con el SQL de SiGA (UStock con depósito OPERATIVO, MERGE de depósito y ubicación)', async () => {
  const { falso, promesa } = grabarCon();
  await promesa;
  const [ps] = buscar(falso.registro, 'PS');
  assert.match(ps.texto, /INNER JOIN SucursalesDepositos SD ON SD\.IdSucursal = PS\.IdSucursal/);
  assert.match(ps.texto, /SD\.IdDeposito = @idDeposito AND SD\.TipoDeposito = @tipoDeposito$/);
  assert.deepStrictEqual(ps.params, { idSucursal: 1, idDeposito: 1, idProducto: '1001', cantidad: 1, tipoDeposito: 'OPERATIVO' });
  const [pd] = buscar(falso.registro, 'PD');
  assert.match(pd.texto, /WHEN MATCHED THEN UPDATE SET D\.Stock = D\.Stock \+ O\.Stock, D\.Stock2 = D\.Stock2 \+ O\.Stock2/);
  assert.deepStrictEqual(pd.params, { idSucursal: 1, idDeposito: 1, idProducto: '1001', cantidad: 1 });
  const [pu] = buscar(falso.registro, 'PU');
  assert.match(pu.texto, /ON O\.IdSucursal = D\.IdSucursal AND O\.IdDeposito = D\.IdDeposito AND O\.IdUbicacion = D\.IdUbicacion AND O\.IdProducto = D\.IdProducto/);
  assert.deepStrictEqual(pu.params, { idSucursal: 1, idDeposito: 1, idUbicacion: 1, idProducto: '1001', cantidad: 1 });
});

test('grabar: stock solo para productos con AfectaStock (MovimientosStockProductos y último precio para todos)', async () => {
  const ctx = contextoFactcom();
  const productos = { ...ctx.productos, 1002: { ...ctx.productos[1002], afectaStock: false } };
  const { falso, promesa } = grabarCon(RESPUESTAS, filasDe(borradorFactcom(), { ...ctx, productos }));
  await promesa;
  const tramo = secuencia(falso.registro).filter(s => ['MSP', 'PS', 'PD', 'PU', 'PP'].includes(s));
  assert.deepStrictEqual(tramo, ['MSP', 'PS', 'PD', 'PU', 'PP', 'MSP', 'PP']);
  assert.deepStrictEqual(buscar(falso.registro, 'PS').map(e => e.params.idProducto), ['1001']);
});

test('grabar: ubicación con sucursal asociada repite el stock allá, en el orden de ActualizarStock', async () => {
  const ctx = contextoFactcom();
  const ubicacion = { ...ctx.destino.ubicacion, sucursalAsociada: 2, depositoAsociado: 7, ubicacionAsociada: 9 };
  const { falso, promesa } = grabarCon(RESPUESTAS, filasDe(borradorFactcom(), { ...ctx, destino: { ...ctx.destino, ubicacion } }));
  await promesa;
  const tramo = secuencia(falso.registro).filter(s => ['MSP', 'PS', 'PD', 'PU', 'PP'].includes(s)).slice(0, 8);
  assert.deepStrictEqual(tramo, ['MSP', 'PS', 'PD', 'PU', 'PS', 'PD', 'PU', 'PP']);
  assert.deepStrictEqual(buscar(falso.registro, 'PU')[1].params, { idSucursal: 2, idDeposito: 7, idUbicacion: 9, idProducto: '1001', cantidad: 1 });
});

test('grabar: ProductosSucursales_UStock sin fila afectada → ErrorSiga y rollback', async () => {
  const { falso, promesa } = grabarCon(texto => (/^UPDATE PS SET Stock/.test(texto) ? { rowsAffected: [0] } : RESPUESTAS(texto)));
  await assert.rejects(promesa, err => err instanceof ErrorSiga && err.message
    === 'ProductosSucursales no tiene fila para el producto 1001 en la sucursal 1 con el depósito 1 OPERATIVO.');
  assert.deepStrictEqual(secuencia(falso.registro).slice(-2), ['PS', 'ROLLBACK']);
});

test('grabar: último precio = ActualizaPrecioUltimaCompra si existe, si no el MERGE de ProductosProveedores_I', async () => {
  const { falso, promesa } = grabarCon();
  await promesa;
  const [pp] = buscar(falso.registro, 'PP');
  assert.deepStrictEqual(pp.params, {
    IdProveedor: 328, IdProducto: '1001', CodigoProductoProveedor: '1001', UltimoPrecioCompra: 31839.64,
    UltimaFechaCompra: '20261010 14:47:06', UltimoPrecioFabrica: 31839.64, DescuentoRecargoPorc1: 0, DescuentoRecargoPorc2: 0,
    DescuentoRecargoPorc3: 0, DescuentoRecargoPorc4: 0, DescuentoRecargoPorc5: 0, DescuentoRecargoPorc6: 0,
  });
  assert.match(pp.texto, /BEGIN UPDATE ProductosProveedores SET UltimoPrecioCompra = @UltimoPrecioCompra, UltimaFechaCompra = @UltimaFechaCompra WHERE IdProveedor = @IdProveedor AND IdProducto = @IdProducto END/);
  assert.match(pp.texto, /ELSE BEGIN MERGE INTO ProductosProveedores AS D/);
  assert.match(pp.texto, /INSERT \(IdProveedor, IdProducto, CodigoProductoProveedor, UltimoPrecioCompra, UltimaFechaCompra, UltimoPrecioFabrica, DescuentoRecargoPorc1, DescuentoRecargoPorc2, DescuentoRecargoPorc3, DescuentoRecargoPorc4, DescuentoRecargoPorc5, DescuentoRecargoPorc6\)/);
  assert.doesNotMatch(pp.texto, /Orden/);
});

const COLUMNAS_CCP = [
  'IdSucursal', 'IdTipoComprobante', 'Letra', 'CentroEmisor', 'NumeroComprobante', 'Fecha', 'FechaVencimiento', 'ImporteTotal',
  'IdProveedor', 'IdFormasPago', 'Observacion', 'RefProveedor', 'Saldo', 'CantidadCuotas', 'importePesos', 'importeDolares',
  'ImporteTickets', 'importeTransfBancaria', 'importeCheques', 'importeEuros', 'idCuentaBancaria', 'importeRetenciones',
  'ImporteTarjetas', 'IdEstadoComprobante', 'IdUsuario', 'FechaActualizacion', 'MetodoGrabacion', 'IdFuncion', 'ImprimeSaldos',
  'CotizacionDolar', 'FechaTransferencia', 'PromedioDiasPago', 'SaldoCtaCte', 'NumeroOrdenCompra', 'FechaPromedioPago',
  'FechaPromedioEmision', 'DiasPromedioEmision',
];
const COLUMNAS_CCPP = [
  'IdSucursal', 'IdTipoComprobante', 'Letra', 'CentroEmisor', 'NumeroComprobante', 'CuotaNumero', 'IdProveedor', 'Fecha',
  'FechaVencimiento', 'ImporteCuota', 'SaldoCuota', 'IdFormasPago', 'Observacion', 'IdTipoComprobante2', 'NumeroComprobante2',
  'CentroEmisor2', 'CuotaNumero2', 'Letra2', 'DescuentoRecargoPorc', 'DescuentoRecargo',
];
const columnasDe = texto => /\(([^)]*)\)/.exec(texto)[1].split(', ');

test('grabar: cta. cte. con las 37 columnas de CuentasCorrientesProv_I y las 20 de Pagos_I, en su orden', async () => {
  const { falso, promesa } = grabarCon();
  await promesa;
  const [ccp] = buscar(falso.registro, 'CCP');
  assert.deepStrictEqual(columnasDe(ccp.texto), COLUMNAS_CCP);
  assert.deepStrictEqual([ccp.params.ImporteTotal, ccp.params.Saldo, ccp.params.importeEuros, ccp.params.IdProveedor], [42665.16, 42665.16, 0, 328]);
  const [pago] = buscar(falso.registro, 'CCPP');
  assert.deepStrictEqual(columnasDe(pago.texto), COLUMNAS_CCPP);
  assert.deepStrictEqual([pago.params.IdTipoComprobante2, pago.params.NumeroComprobante2, pago.params.CentroEmisor2, pago.params.CuotaNumero2, pago.params.Letra2],
    ['FACTCOM', 1071364, 5007, 1, 'A']);
});

test('grabar: con Dias = 0 (sin cta. cte. en las filas) no escribe CuentasCorrientesProv ni Pagos', async () => {
  const ctx = contextoFactcom();
  const filas = filasDe(borradorFactcom(), { ...ctx, formaPago: { ...ctx.formaPago, dias: 0 } });
  assert.strictEqual(filas.ctaCte, null);
  const { falso, promesa } = grabarCon(RESPUESTAS, filas);
  await promesa;
  assert.deepStrictEqual(secuencia(falso.registro).slice(-3), ['PU', 'PP', 'COMMIT']);
  assert.strictEqual(falso.registro.filter(e => /CuentasCorrientesProv/.test(e.texto) && /^INSERT/.test(e.texto)).length, 0);
});

test('grabar: rechaza el duplicado en Compras aunque el contexto previo dijera "no duplicado"; rollback sin escribir nada', async () => {
  const ctx = contextoFactcom({ duplicado: null });
  const { falso, promesa } = grabarCon(texto => (
    /^SELECT TOP 1 C\.IdSucursal FROM Compras C/.test(texto) ? { recordset: [{ IdSucursal: 11 }] } : RESPUESTAS(texto)),
  filasDe(borradorFactcom(), ctx));
  await assert.rejects(promesa, err => err instanceof ErrorSiga && err.message === 'Este comprobante ya fue INGRESADO con ANTERIORIDAD');
  assert.deepStrictEqual(secuencia(falso.registro), ['BEGIN', 'DUP_COMPRAS', 'ROLLBACK']);
  const [dup] = falso.registro.filter(e => etiqueta(e.texto) === 'DUP_COMPRAS');
  assert.match(dup.texto, /C\.IdProveedor = @idProveedor/);
  assert.doesNotMatch(dup.texto, /C\.IdSucursal = @/);
  assert.match(dup.texto, /TC\.InformaLibroIVA = 1 OR S\.IdEmpresa = @idEmpresa/);
  assert.deepStrictEqual([dup.params.idProveedor, dup.params.numeroComprobante, dup.params.idEmpresa], [328, 1071364, 1]);
});

test('grabar: duplicado en cta. cte. de la misma sucursal (Existe con IdSucursal > 0, sin filtro de empresa) → rollback', async () => {
  const { falso, promesa } = grabarCon(texto => (
    /FROM CuentasCorrientesProv CCP/.test(texto) ? { recordset: [{ IdSucursal: 1 }] } : RESPUESTAS(texto)));
  await assert.rejects(promesa, err => err instanceof ErrorSiga && err.message === 'Este comprobante ya EXISTE en Cuentas Corrientes de Proveedores');
  assert.deepStrictEqual(secuencia(falso.registro), ['BEGIN', 'DUP_COMPRAS', 'DUP_CTACTE', 'ROLLBACK']);
  const [dup] = buscar(falso.registro, 'DUP_CTACTE');
  assert.match(dup.texto, /WHERE CCP\.IdSucursal = @idSucursal AND CCP\.IdProveedor = @idProveedor/);
  assert.doesNotMatch(dup.texto, /IdEmpresa/);
  assert.deepStrictEqual(dup.params, {
    idSucursal: 1, idProveedor: 328, idTipoComprobante: 'FACTCOM', letra: 'A', centroEmisor: 5007, numeroComprobante: 1071364,
  });
});

test('grabar: numeración compartida con ventas (VentasNumeros_G1) detectada adentro → rollback', async () => {
  const { falso, promesa } = grabarCon(texto => (
    /FROM VentasNumeros VN/.test(texto) ? { recordset: [{ IdTipoComprobante: 'FACTCOM' }] } : RESPUESTAS(texto)));
  await assert.rejects(promesa, err => err instanceof ErrorSiga && /comparten numeración con ventas/.test(err.message));
  assert.deepStrictEqual(secuencia(falso.registro), ['BEGIN', 'DUP_COMPRAS', 'DUP_CTACTE', 'VN_G1', 'ROLLBACK']);
  assert.deepStrictEqual(buscar(falso.registro, 'VN_G1')[0].params, { idEmpresa: 1, idTipoComprobante: 'FACTCOM', letra: 'A', centroEmisor: 5007 });
});

test('grabar: numeración automática por proveedor = MAX + 1 con lock; el número final llega a impuestos, movimiento y cta. cte.', async () => {
  const ctx = contextoFactcom();
  const tipo = { ...ctx.tipo, idTipoComprobante: 'COTIZACIONCOM', grabaLibro: false, numeracionAutomatica: true, letrasHabilitadas: ['X'], esComercial: false };
  const filas = filasDe(borradorFactcom({ idTipoComprobante: 'COTIZACIONCOM', letra: 'X', centroEmisor: null, numeroComprobante: null }), { ...ctx, tipo });
  assert.strictEqual(filas.ctaCte.cuotas[0].NumeroComprobante2, 0);
  const { falso, promesa } = grabarCon(RESPUESTAS, filas);
  const r = await promesa;
  assert.strictEqual(r.clave.NumeroComprobante, 51);
  assert.deepStrictEqual(secuencia(falso.registro).slice(0, 5), ['BEGIN', 'MAX', 'VN_G1', 'MN_LEER', 'COMPRAS']);
  assert.ok(!secuencia(falso.registro).some(s => ['DUP_COMPRAS', 'DUP_CTACTE', 'PF_TOTALES', 'PF_POSICION'].includes(s)));
  const [max] = buscar(falso.registro, 'MAX');
  assert.match(max.texto, /WHERE C\.IdProveedor = @idProveedor AND C\.IdSucursal = @idSucursal AND C\.IdTipoComprobante = @idTipoComprobante/);
  assert.deepStrictEqual(max.params, { idProveedor: 328, idSucursal: 1, idTipoComprobante: 'COTIZACIONCOM', letra: 'X', centroEmisor: 1 });
  assert.strictEqual(buscar(falso.registro, 'COMPRAS')[0].params.NumeroComprobante, 51);
  assert.ok(buscar(falso.registro, 'CI').every(e => e.params.Numero === 51 && e.params.Emisor === 1));
  assert.strictEqual(buscar(falso.registro, 'MS')[0].params.NumeroComprobante, 51);
  assert.strictEqual(buscar(falso.registro, 'CCP')[0].params.NumeroComprobante, 51);
  const pago = buscar(falso.registro, 'CCPP')[0].params;
  assert.deepStrictEqual([pago.NumeroComprobante, pago.NumeroComprobante2, pago.CentroEmisor2], [51, 51, 1]);
});

test('grabar: numeración que la v1 no soporta → ErrorSiga antes de escribir', async () => {
  const filas = { ...filasDe(), numeracion: { ...filasDe().numeracion, modo: 'comprasNumeros' } };
  const { falso, promesa } = grabarCon(RESPUESTAS, filas);
  await assert.rejects(promesa, err => err instanceof ErrorSiga && /comprasNumeros/.test(err.message));
  assert.deepStrictEqual(secuencia(falso.registro), ['BEGIN', 'ROLLBACK']);
});

test('grabar: PK duplicada de Compras → mensaje de SiGA (Reglas.Compras L633-636) como ErrorSiga', async () => {
  const { falso, promesa } = grabarCon(texto => {
    if (/^INSERT INTO Compras \(/.test(texto)) {
      throw new Error("Violation of PRIMARY KEY constraint 'PK_Compras'. Cannot insert duplicate key in object 'dbo.Compras'.");
    }
    return RESPUESTAS(texto);
  });
  await assert.rejects(promesa, err => err instanceof ErrorSiga && err.message === 'El Comprobante ya existe y no lo puede volver a cargar.');
  assert.strictEqual(falso.registro.at(-1).texto, 'ROLLBACK');
});

test('grabar: un error en CUALQUIER paso N hace rollback, no hace commit y no ejecuta nada después', async () => {
  const total = SECUENCIA_FACTCOM.length - 2; // sin BEGIN ni COMMIT
  for (let n = 1; n <= total; n += 1) {
    let llamadas = 0;
    const { falso, promesa } = grabarCon(texto => {
      llamadas += 1;
      if (llamadas === n) throw new Error(`falla en el paso ${n}`);
      return RESPUESTAS(texto);
    });
    await assert.rejects(promesa, { message: `falla en el paso ${n}` });
    assert.deepStrictEqual(secuencia(falso.registro), [...SECUENCIA_FACTCOM.slice(0, n + 1), 'ROLLBACK'], `paso ${n}`);
  }
});

test('grabar: si SQL Server ya abortó la transacción (evento rollback de mssql) no se vuelve a llamar rollback', async () => {
  const { falso, promesa } = grabarCon(texto => {
    if (/^INSERT INTO Compras \(/.test(texto)) throw Object.assign(new Error('Transaction aborted'), { abortaTransaccion: true });
    return RESPUESTAS(texto);
  });
  await assert.rejects(promesa, { message: 'Transaction aborted' });
  assert.deepStrictEqual(secuencia(falso.registro).slice(-2), ['COMPRAS', 'ROLLBACK']);
  assert.strictEqual(falso.registro.filter(e => e.texto === 'ROLLBACK').length, 1);
});
