'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { calcularComprobante, armarComprobante } = require('../lib/siga_compras/armar_comprobante');
const { borradorFactcom, contextoFactcom, AHORA } = require('./siga_compras_fixture');

const armar = (b = borradorFactcom(), ctx = contextoFactcom()) =>
  armarComprobante(b, ctx, calcularComprobante(b, ctx), { ahora: AHORA, usuario: 'adriel-con-nombre-largo' });

test('calcularComprobante: FACTCOM A 1071364 completo', () => {
  const c = calcularComprobante(borradorFactcom(), contextoFactcom());
  assert.strictEqual(c.discrimina, true);
  assert.deepStrictEqual(c.totales, {
    totalBruto: 35023.65, totalNeto: 35023.65, totalIVA: 6686.32, totalPercepciones: 955.19, impuestosInternos: 0, importeTotal: 42665.16,
  });
  assert.deepStrictEqual(c.lineas.map(l => [l.plu, l.proporcionalImp, l.montoSaldo]), [['1001', 878.7748, 31839.64], ['1002', 76.4152, 3184.01]]);
  assert.strictEqual(c.filasImpuestos.length, 3);
  assert.deepStrictEqual(c.percepciones, { percepcionIVA: 955.19, percepcionIB: 0, percepcionGanancias: 0, percepcionVarias: 0, impuestosInternos: 0 });
});

test('armarComprobante: clave y las 60 columnas de Compras', () => {
  const f = armar();
  assert.deepStrictEqual(f.clave, { IdSucursal: 1, IdTipoComprobante: 'FACTCOM', Letra: 'A', CentroEmisor: 5007, NumeroComprobante: 1071364, IdProveedor: 328 });
  assert.deepStrictEqual(f.numeracion, { modo: 'manual', idEmpresa: 1, fecha: '20261010 14:47:06' });
  assert.strictEqual(Object.keys({ ...f.clave, ...f.compras }).length, 60);
  const c = f.compras;
  assert.strictEqual(c.Fecha, '20261010 14:47:06');
  assert.strictEqual(c.FechaActualizacion, '20261016 14:47:06');
  assert.strictEqual(c.PorcentajeIVA, 21);
  assert.strictEqual(c.ImporteTotal, 42665.16);
  assert.strictEqual(c.TotalBruto, 35023.65);
  assert.strictEqual(c.TotalNeto, 35023.65);
  assert.strictEqual(c.TotalIVA, 6686.32);
  assert.strictEqual(c.TotalPercepciones, 955.19);
  assert.strictEqual(c.PercepcionIVA, 955.19);
  assert.strictEqual(c.IdCategoriaFiscal, 2);
  assert.strictEqual(c.IdRubro, 1);
  assert.strictEqual(c.IdFormasPago, 3);
  assert.strictEqual(c.IdEmpresa, 1);
  assert.strictEqual(c.PeriodoFiscal, 202610);
  assert.strictEqual(c.ImportePesos, 0);
  assert.strictEqual(c.CotizacionDolar, 1450);
  assert.strictEqual(c.MetodoGrabacion, 'M');
  assert.strictEqual(c.IdFuncion, 'MovimientosDeComprasV2');
  assert.strictEqual(c.Usuario, 'adriel-con');
  assert.strictEqual(c.CuitProveedor, '20-12345678-6');
  assert.strictEqual(c.IVAModificadoManual, false);
  assert.strictEqual(c.ExcluirDePasaje, false);
});

test('armarComprobante: ComprasProductos (43 columnas) y ComprasImpuestos', () => {
  const f = armar();
  assert.strictEqual(f.comprasProductos.length, 2);
  assert.strictEqual(Object.keys({ ...f.clave, ...f.comprasProductos[0] }).length, 43);
  const [p1] = f.comprasProductos;
  assert.deepStrictEqual(p1, {
    Orden: 1, IdProducto: '1001', NombreProducto: 'HARINA 000 X 25', Cantidad: 1, Precio: 31839.64,
    DescRecGeneral: 0, DescRecGeneralProducto: 0, DescuentoRecargo: 0, DescuentoRecargoProducto: 0, DescuentoRecargoPorc: 0,
    PrecioNeto: 31839.64, ImporteTotal: 31839.64, ImporteTotalNeto: 31839.64, PorcentajeIVA: 21, IVA: 6686.3244,
    IdConcepto: null, PasajeMovimiento: false, MontoAplicado: 0, MontoSaldo: 31839.64, ProporcionalImp: 878.7748,
    IdCentroCosto: null, IdaAtributoProducto01: null, IdaAtributoProducto02: null, IdaAtributoProducto03: null, IdaAtributoProducto04: null,
    IdDeposito: 1, IdUbicacion: 1, InformeCalidadNumero: null, InformeCalidadLink: null, IdLote: null, FechaVencimientoLote: null,
    CantidadUMCompra: 1, FactorConversionCompra: 1, PrecioPorUMCompra: 31839.64, IdUnidadDeMedida: 'UN', IdUnidadDeMedidaCompra: 'UN',
    ConceptoCompras: null,
  });
  assert.deepStrictEqual(f.comprasImpuestos, [
    { IdTipoImpuesto: 'IVA', Orden: 1, IdProvincia: null, Bruto: 31839.64, BaseImponible: 31839.64, Alicuota: 21, Importe: 6686.32, EsDespacho: false },
    { IdTipoImpuesto: 'IVA', Orden: 2, IdProvincia: null, Bruto: 3184.01, BaseImponible: 3184.01, Alicuota: 0, Importe: 0, EsDespacho: false },
    { IdTipoImpuesto: 'PIVA', Orden: 3, IdProvincia: null, Bruto: 0, BaseImponible: 0, Alicuota: 0, Importe: 955.19, EsDespacho: false },
  ]);
});

test('armarComprobante: libro IVA, movimiento de stock, último precio y cuenta corriente', () => {
  const f = armar();
  assert.deepStrictEqual(f.periodoFiscal, { IdEmpresa: 1, PeriodoFiscal: 202610, netoCompras: 35023.65, impuestosCompras: 6686.32, compras: 42665.16, percepciones: 955.19 });
  assert.deepStrictEqual(f.movimientoStock, {
    IdTipoMovimiento: 'COMPRA', FechaMovimiento: '20261010 14:47:06', Neto: 0, Total: 42665.16, PorcentajeIVA: 0,
    IdCategoriaFiscal: 2, Usuario: 'adriel-con', Observacion: 'Pedido P-0007', TotalImpuestos: 0, IdCliente: null,
    IdSucursal2: null, PercepcionIVA: 955.19, PercepcionIB: 0, PercepcionGanancias: 0, PercepcionVarias: 0,
    IdProduccion: null, IdProveedor: 328, IdEmpleado: null, ImpuestosInternos: 0,
  });
  assert.deepStrictEqual(f.movimientosStockProductos.map(m => [m.Orden, m.IdProducto, m.Cantidad, m.Precio, m.IdDeposito, m.IdUbicacion]),
    [[1, '1001', 1, 31839.64, 1, 1], [2, '1002', 1, 3184.01, 1, 1]]);
  assert.deepStrictEqual(f.actualizacionesStock, [
    { Orden: 1, IdSucursal: 1, IdDeposito: 1, IdUbicacion: 1, IdProducto: '1001', Cantidad: 1 },
    { Orden: 2, IdSucursal: 1, IdDeposito: 1, IdUbicacion: 1, IdProducto: '1002', Cantidad: 1 },
  ]);
  // SqlServer.ProductosProveedores_I (MERGE, L20-34) y ActualizaPrecioUltimaCompra (L85-97).
  const pp = (id, precio) => ({
    CodigoProductoProveedor: id, UltimoPrecioCompra: precio, UltimaFechaCompra: '20261010 14:47:06', UltimoPrecioFabrica: precio,
    DescuentoRecargoPorc1: 0, DescuentoRecargoPorc2: 0, DescuentoRecargoPorc3: 0, DescuentoRecargoPorc4: 0, DescuentoRecargoPorc5: 0, DescuentoRecargoPorc6: 0,
  });
  assert.deepStrictEqual(f.productosProveedores, [
    { Orden: 1, IdProducto: '1001', ...pp('1001', 31839.64) },
    { Orden: 2, IdProducto: '1002', ...pp('1002', 3184.01) },
  ]);
});

test('armarComprobante: cta. cte. con las columnas exactas de CuentasCorrientesProv_I y CuentasCorrientesProvPagos_I', () => {
  const f = armar();
  // SqlServer.CuentasCorrientesProv_I L20-167: 37 columnas en este orden (menos las 6 de la clave).
  assert.deepStrictEqual(Object.keys(f.ctaCte.cabecera), [
    'Fecha', 'FechaVencimiento', 'ImporteTotal', 'IdFormasPago', 'Observacion', 'RefProveedor', 'Saldo', 'CantidadCuotas',
    'importePesos', 'importeDolares', 'ImporteTickets', 'importeTransfBancaria', 'importeCheques', 'importeEuros',
    'idCuentaBancaria', 'importeRetenciones', 'ImporteTarjetas', 'IdEstadoComprobante', 'IdUsuario', 'FechaActualizacion',
    'MetodoGrabacion', 'IdFuncion', 'ImprimeSaldos', 'CotizacionDolar', 'FechaTransferencia', 'PromedioDiasPago',
    'SaldoCtaCte', 'NumeroOrdenCompra', 'FechaPromedioPago', 'FechaPromedioEmision', 'DiasPromedioEmision',
  ]);
  assert.strictEqual(Object.keys({ ...f.clave, ...f.ctaCte.cabecera }).length, 37);
  assert.deepStrictEqual(f.ctaCte.cabecera, {
    Fecha: '20261010 14:47:06', FechaVencimiento: '20261109 14:47:06', ImporteTotal: 42665.16, IdFormasPago: 3,
    Observacion: 'Pedido P-0007', RefProveedor: '', Saldo: 42665.16, CantidadCuotas: 1,
    importePesos: 0, importeDolares: 0, ImporteTickets: 0, importeTransfBancaria: 0, importeCheques: 0, importeEuros: 0,
    idCuentaBancaria: null, importeRetenciones: 0, ImporteTarjetas: 0, IdEstadoComprobante: 'NORMAL', IdUsuario: 'adriel-con',
    FechaActualizacion: '20261016 14:47:06', MetodoGrabacion: 'M', IdFuncion: 'MovimientosDeComprasV2', ImprimeSaldos: null,
    CotizacionDolar: 1450, FechaTransferencia: null, PromedioDiasPago: 0, SaldoCtaCte: null, NumeroOrdenCompra: null,
    FechaPromedioPago: null, FechaPromedioEmision: null, DiasPromedioEmision: null,
  });
  // SqlServer.CuentasCorrientesProvPagos_I: 20 columnas en este orden (menos las 6 de la clave); la cuota de una
  // factura se apunta a sí misma en las columnas "2" (Reglas.CuentasCorrientesProvPagos L76-90).
  assert.strictEqual(f.ctaCte.cuotas.length, 1);
  assert.deepStrictEqual(Object.keys(f.ctaCte.cuotas[0]), [
    'CuotaNumero', 'Fecha', 'FechaVencimiento', 'ImporteCuota', 'SaldoCuota', 'IdFormasPago', 'Observacion',
    'IdTipoComprobante2', 'NumeroComprobante2', 'CentroEmisor2', 'CuotaNumero2', 'Letra2', 'DescuentoRecargoPorc', 'DescuentoRecargo',
  ]);
  assert.strictEqual(Object.keys({ ...f.clave, ...f.ctaCte.cuotas[0] }).length, 20);
  assert.deepStrictEqual(f.ctaCte.cuotas[0], {
    CuotaNumero: 1, Fecha: '20261010 14:47:06', FechaVencimiento: '20261109 14:47:06', ImporteCuota: 42665.16,
    SaldoCuota: 42665.16, IdFormasPago: 3, Observacion: 'Pedido P-0007',
    IdTipoComprobante2: 'FACTCOM', NumeroComprobante2: 1071364, CentroEmisor2: 5007, CuotaNumero2: 1, Letra2: 'A',
    DescuentoRecargoPorc: 0, DescuentoRecargo: 0,
  });
  // Comprobante de hoy: la cta. cte. y la cuota llevan la hora real (Reglas.CuentasCorrientesProv L235-238).
  const hoy = armar(borradorFactcom({ fecha: '2026-10-16' }));
  assert.strictEqual(hoy.ctaCte.cabecera.Fecha, '20261016 14:47:06');
  assert.strictEqual(hoy.ctaCte.cuotas[0].Fecha, '20261016 14:47:06');
});

test('armarComprobante: cotización del dólar a 2 decimales lejos del cero (N2) en Compras, cta. cte. y último precio', () => {
  const ctx = contextoFactcom({ cotizacionDolar: 1450.445 });
  const enDolares = { ...ctx.productos, 1001: { ...ctx.productos['1001'], idMoneda: 2 } };
  const f = armar(borradorFactcom(), { ...ctx, productos: enDolares });
  assert.strictEqual(f.compras.CotizacionDolar, 1450.45);
  assert.strictEqual(f.ctaCte.cabecera.CotizacionDolar, 1450.45);
  assert.strictEqual(f.productosProveedores[0].UltimoPrecioCompra, 31839.64 / 1450.45);
  assert.strictEqual(f.productosProveedores[1].UltimoPrecioCompra, 3184.01);
});

test('armarComprobante: sin cta. cte. con Dias = 0 o sin ActualizaCtaCte; sin libro IVA sin GrabaLibro o sin discriminar', () => {
  const ctx = contextoFactcom();
  assert.strictEqual(armar(borradorFactcom(), { ...ctx, formaPago: { ...ctx.formaPago, dias: 0 } }).ctaCte, null);
  assert.strictEqual(armar(borradorFactcom(), { ...ctx, tipo: { ...ctx.tipo, actualizaCtaCte: false } }).ctaCte, null);
  assert.strictEqual(armar(borradorFactcom(), { ...ctx, tipo: { ...ctx.tipo, grabaLibro: false } }).periodoFiscal, null);
  const noDiscrimina = { ...ctx.proveedor, categoriaFiscal: { ...ctx.proveedor.categoriaFiscal, ivaDiscriminado: false } };
  assert.strictEqual(armar(borradorFactcom({ percepciones: [] }), { ...ctx, proveedor: noDiscrimina }).periodoFiscal, null);
});

test('armarComprobante: stock solo con AfectaStock, por embalaje y espejado en la sucursal asociada', () => {
  const ctx = contextoFactcom();
  const productos = {
    ...ctx.productos,
    1001: { ...ctx.productos['1001'], precioPorEmbalaje: true, embalaje: 12 },
    1002: { ...ctx.productos['1002'], afectaStock: false },
  };
  const ubicacion = { ...ctx.destino.ubicacion, sucursalAsociada: 11, depositoAsociado: 2, ubicacionAsociada: 3 };
  const f = armar(borradorFactcom(), { ...ctx, productos, destino: { ...ctx.destino, ubicacion } });
  assert.deepStrictEqual(f.movimientosStockProductos.map(m => m.Cantidad), [12, 1]);
  assert.deepStrictEqual(f.actualizacionesStock, [
    { Orden: 1, IdSucursal: 1, IdDeposito: 1, IdUbicacion: 1, IdProducto: '1001', Cantidad: 12 },
    { Orden: 1, IdSucursal: 11, IdDeposito: 2, IdUbicacion: 3, IdProducto: '1001', Cantidad: 12 },
  ]);
  const sinStock = armar(borradorFactcom(), { ...ctx, tipoMovimiento: { idTipoMovimiento: 'COMPRA', coeficienteStock: 0 } });
  assert.deepStrictEqual([sinStock.movimientosStockProductos, sinStock.actualizacionesStock, sinStock.productosProveedores], [[], [], []]);
});

test('armarComprobante: último precio con descuento general y en dólares', () => {
  const ctx = contextoFactcom();
  const f = armar(borradorFactcom({ porcDescRecGeneral: -10 }), ctx);
  assert.strictEqual(f.compras.DescuentoRecargo, -10);
  assert.strictEqual(f.compras.DescuentoRecargoPorc, -10);
  assert.strictEqual(f.comprasProductos[0].PrecioNeto, 28655.68);
  assert.strictEqual(f.productosProveedores[0].UltimoPrecioCompra, 28655.68);
  const enDolares = { ...ctx.productos, 1001: { ...ctx.productos['1001'], idMoneda: 2 } };
  const g = armar(borradorFactcom(), { ...ctx, productos: enDolares });
  assert.strictEqual(g.productosProveedores[0].UltimoPrecioCompra, 31839.64 / 1450);
});

test('armarComprobante: COTIZACIONCOM numera por proveedor (emisor 1, número al grabar), sin libro y sin caja', () => {
  const ctx = contextoFactcom();
  const tipo = {
    ...ctx.tipo, idTipoComprobante: 'COTIZACIONCOM', descripcion: 'Cotización de compra', grabaLibro: false,
    informaLibroIva: false, numeracionAutomatica: true, letrasHabilitadas: ['X'], esComercial: false,
    afectaCaja: false, actualizaCtaCte: false,
  };
  const f = armar(borradorFactcom({ idTipoComprobante: 'COTIZACIONCOM', letra: 'X', centroEmisor: null, numeroComprobante: null }), { ...ctx, tipo });
  assert.deepStrictEqual(f.clave, { IdSucursal: 1, IdTipoComprobante: 'COTIZACIONCOM', Letra: 'X', CentroEmisor: 1, NumeroComprobante: 0, IdProveedor: 328 });
  assert.strictEqual(f.numeracion.modo, 'proveedor');
  assert.strictEqual(f.compras.PeriodoFiscal, null);
  assert.strictEqual(f.compras.IdEmpresa, null);
  assert.strictEqual(f.compras.ImportePesos, 42665.16);
  assert.strictEqual(f.periodoFiscal, null);
  assert.strictEqual(f.ctaCte, null);
});

test('armarComprobante: descuento general -100% → TotalBruto 100 y ninguna fila en ComprasImpuestos', () => {
  // Reglas.Compras L2021 suma los totales ANTES del filtro de L2131 (BaseImponible + Importe != 0): la fila IVA
  // con bruto 100, base 0 e importe 0 cuenta para TotalBruto pero no se graba.
  const b = borradorFactcom({
    porcDescRecGeneral: -100, percepciones: [],
    lineas: [{ orden: 1, plu: '1001', nombre: 'Harina', cantidad: 1, precio: 100 }],
  });
  const calculo = calcularComprobante(b, contextoFactcom());
  assert.deepStrictEqual(calculo.filasImpuestos, []);
  const f = armar(b);
  assert.strictEqual(f.compras.TotalBruto, 100);
  assert.strictEqual(f.compras.TotalNeto, 0);
  assert.strictEqual(f.compras.TotalIVA, 0);
  assert.strictEqual(f.compras.ImporteTotal, 0);
  assert.deepStrictEqual(f.comprasImpuestos, []);
});

test('calcularComprobante: incluyeIVA solo cuando todos usan impuestos y alguno no discrimina (B/C)', () => {
  const ctx = contextoFactcom();
  const conProveedor = cf => ({ ...ctx, proveedor: { ...ctx.proveedor, categoriaFiscal: { ...ctx.proveedor.categoriaFiscal, ...cf } } });
  const de = c => { const r = calcularComprobante(borradorFactcom(), c); return [r.discrimina, r.incluyeIVA]; };
  assert.deepStrictEqual(de(ctx), [true, false]);
  assert.deepStrictEqual(de(conProveedor({ ivaDiscriminado: false })), [false, true]);
  // Comprobante interno sin impuestos: ni discrimina ni lleva IVA en el precio.
  assert.deepStrictEqual(de({ ...ctx, tipo: { ...ctx.tipo, utilizaImpuestos: false } }), [false, false]);
});
