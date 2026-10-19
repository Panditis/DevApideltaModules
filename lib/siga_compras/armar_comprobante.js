'use strict';
// Borrador editado + contexto de SIGA → TODAS las filas a escribir, por tabla, ya calculadas. Puro: repo.grabar
// solo ejecuta. Columnas: DOC Parte III (Compras_I §2.1, ComprasProductos_I §3.1, ComprasImpuestos_I §4.1) y
// SqlServer.MovimientosStock_I / MovimientosStockProductos_I. Las 6 columnas de la clave (y el número
// automático, Emisor/Numero de impuestos y el número de movimiento) las completa repo.grabar.
// Se llama solo con un borrador sin errores de validarComprobante.
const C = require('./constantes');
const { calcularLinea, discriminaIVA, precioIncluyeIVA, redondear, redondearLejosDelCero, sinRuido } = require('./lineas');
const I = require('./impuestos');
const F = require('./fechas');
const { numeracionDe, emisorDe } = require('./validaciones');

// regla = discriminaIVA o precioIncluyeIVA (lineas.js); con contexto incompleto, false.
function fiscalDe(ctx, regla) {
  const prov = ctx.proveedor && ctx.proveedor.categoriaFiscal;
  const emp = ctx.empresa && ctx.empresa.categoriaFiscal;
  return !!(prov && emp && ctx.tipo) && regla({ proveedor: prov, empresa: emp, tipo: ctx.tipo });
}

// Todo lo calculable sin la clave definitiva: lo usan POST /validar (para mostrar) y armarComprobante.
// Tolera contexto incompleto (producto inexistente → IVA 0) porque /validar lo llama aunque haya errores.
function calcularComprobante(borrador, ctx) {
  const discrimina = fiscalDe(ctx, discriminaIVA);
  // SIGA-INFERIDO: v1 fija IVA 0 sin libro de IVA; SiGA deja elegir la alícuota (W L26420-26423)
  const sinLibroIVA = !!ctx.tipo && !ctx.tipo.grabaLibro;
  const { decimalesPrecio, decimalesTotal, pasajeIncluyeImpuestos } = ctx.parametros;
  const lineas = borrador.lineas.map(l => {
    const p = Object.hasOwn(ctx.productos, l.plu) ? ctx.productos[l.plu] : null;
    return {
      ...l, nombre: (p && p.nombre) || l.nombre, // el de SIGA, para la pantalla (como filaCompraProducto)
      ...calcularLinea({
        cantidad: l.cantidad, precio: l.precio || 0, porcentajeIVA: p && !sinLibroIVA ? p.alicuota : 0,
        porcDescRecGeneral: borrador.porcDescRecGeneral, discrimina, decimalesPrecio,
      }),
    };
  });
  const argsImpuestos = { lineas, percepciones: borrador.percepciones, decimalesPrecio };
  // DOC Parte III §3.3 / §4.1: los totales se suman sobre TODAS las filas (Reglas.Compras L2021) y recién después se
  // filtran las que se graban (L2131: BaseImponible + Importe != 0, Orden correlativo). Con desc. general -100%
  // la fila IVA queda con base e importe 0: no se graba, pero su Bruto suma a TotalBruto.
  const filasImpuestos = I.filasImpuestos(argsImpuestos);
  const totales = I.totalesCabecera(I.filasImpuestosTodas(argsImpuestos));
  const importeTotal = I.importeTotal(totales, decimalesTotal);
  const proporcional = I.proporcionalImp(lineas, importeTotal);
  return {
    discrimina,
    sinLibroIVA,
    incluyeIVA: fiscalDe(ctx, precioIncluyeIVA), // B/C: el precio de línea lleva IVA; ni esto ni discrimina = sin impuestos
    lineas: lineas.map((l, i) => ({
      ...l, proporcionalImp: proporcional[i], montoSaldo: I.montoSaldo(l, proporcional[i], pasajeIncluyeImpuestos),
    })),
    filasImpuestos,
    totales: { ...totales, importeTotal },
    percepciones: I.percepcionesCabecera(borrador.percepciones),
  };
}

// DOC Parte III §2.1: las 60 columnas de Compras_I menos las 6 de la clave.
function filaCompras(b, ctx, calculo, { fecha, ahora, usuario, cotizacionDolar }) {
  const t = ctx.tipo;
  const tot = calculo.totales;
  const per = calculo.percepciones;
  // Columna 23: PeriodoFiscal solo si EsComercial | GeneraContabilidad; IdEmpresa NULL si no hay período (col. 22).
  const periodo = t.esComercial || t.generaContabilidad ? F.periodoFiscalDe(b, t) : 0;
  const porcGeneral = Number(b.porcDescRecGeneral) || 0;
  return {
    Fecha: F.fechaSiga(fecha),
    IdComprador: C.ID_COMPRADOR_DEFAULT,
    // DOC Parte I §6.2 (rareza de SiGA): DescuentoRecargo guarda el % general, igual que DescuentoRecargoPorc.
    DescuentoRecargo: porcGeneral,
    DescuentoRecargoPorc: porcGeneral,
    IVAModificadoManual: false,
    ImporteTotal: tot.importeTotal,
    IdCategoriaFiscal: ctx.proveedor.idCategoriaFiscal,
    IdFormasPago: ctx.formaPago.idFormasPago,
    Observacion: String(b.observacion || '').slice(0, C.LARGO_OBSERVACION),
    PorcentajeIVA: C.PORCENTAJE_IVA_CABECERA,
    IdRubro: ctx.proveedor.idRubroCompra,
    PercepcionIVA: per.percepcionIVA,
    PercepcionIB: per.percepcionIB,
    PercepcionGanancias: per.percepcionGanancias,
    PercepcionVarias: per.percepcionVarias,
    IdEmpresa: periodo ? ctx.destino.sucursal.idEmpresa : null,
    PeriodoFiscal: periodo || null,
    // DOC Parte I §8.1 (L23439-23442): si el tipo no afecta caja, txtEfectivo = total.
    ImportePesos: t.afectaCaja ? 0 : tot.importeTotal,
    ImporteTarjetas: 0,
    ImporteCheques: 0,
    importeTransfBancaria: 0,
    idCuentaBancaria: null,
    idEstadoComprobante: null,
    CantidadInvocados: 0,
    Usuario: usuario,
    FechaActualizacion: F.fechaSiga(ahora),
    CotizacionDolar: cotizacionDolar,
    FechaOficializacionDespacho: null,
    IdAduana: null,
    IdDestinacion: null,
    NumeroDespacho: null,
    DigitoVerificadorDespacho: null,
    IdDespachante: null,
    IdAgenteTransporte: null,
    DerechoAduanero: null,
    BienCapitalDespacho: false,
    NumeroManifiestoDespacho: null,
    Bultos: 0,
    ValorDeclarado: 0,
    IdTransportista: null,
    NumeroLote: 0,
    TotalBruto: tot.totalBruto,
    TotalNeto: tot.totalNeto,
    TotalIVA: tot.totalIVA,
    TotalPercepciones: tot.totalPercepciones,
    MetodoGrabacion: C.METODO_GRABACION,
    IdFuncion: C.ID_FUNCION,
    NombreProveedor: String(ctx.proveedor.nombre || '').slice(0, C.LARGO_NOMBRE_PROVEEDOR),
    CuitProveedor: ctx.proveedor.cuit || '',
    ImpuestosInternos: per.impuestosInternos,
    ExcluirDePasaje: false,
    // DOC Parte I §3.1: chbMercaderiaEnviada = tipo.ActivaTildeMercDespacha.
    MercEnviada: !!t.activaTildeMercDespacha,
    IdConceptoCM05: null,
    NumeroOrdenCompra: null,
  };
}

// DOC Parte III §3.1: las 43 columnas de ComprasProductos_I menos las 6 de la clave.
function filaCompraProducto(l, b, ctx) {
  const p = ctx.productos[l.plu];
  return {
    Orden: l.orden,
    IdProducto: p.idProducto,
    NombreProducto: String(p.nombre || l.nombre).slice(0, C.LARGO_NOMBRE_PRODUCTO),
    Cantidad: l.cantidad,
    Precio: l.precio,
    DescRecGeneral: l.descRecGeneral,
    DescRecGeneralProducto: l.descRecGeneralProducto,
    DescuentoRecargo: l.descuentoRecargo,
    DescuentoRecargoProducto: l.descuentoRecargoProducto,
    DescuentoRecargoPorc: l.descuentoRecargoPorc,
    PrecioNeto: l.precioNeto,
    ImporteTotal: l.importeTotal,
    ImporteTotalNeto: l.importeTotalNeto,
    PorcentajeIVA: l.porcentajeIVA,
    IVA: sinRuido(l.iva), // Parte III §3.1 col. 21: sin redondear (solo se limpia el error del float).
    IdConcepto: null,
    PasajeMovimiento: false,
    MontoAplicado: 0,
    MontoSaldo: l.montoSaldo,
    ProporcionalImp: l.proporcionalImp,
    IdCentroCosto: null,
    IdaAtributoProducto01: null,
    IdaAtributoProducto02: null,
    IdaAtributoProducto03: null,
    IdaAtributoProducto04: null,
    IdDeposito: b.idDeposito,
    IdUbicacion: b.idUbicacion,
    InformeCalidadNumero: null,
    InformeCalidadLink: null,
    IdLote: null,
    FechaVencimientoLote: null,
    // Reglas.ComprasProductos.cs:49-54: con UM iguales (la v1 bloquea las distintas).
    CantidadUMCompra: l.cantidad,
    FactorConversionCompra: 1,
    PrecioPorUMCompra: l.precio,
    IdUnidadDeMedida: p.idUnidadDeMedida || '',
    IdUnidadDeMedidaCompra: p.idUnidadDeMedidaCompra || '',
    ConceptoCompras: p.conceptoCompras ?? null,
  };
}

// DOC Parte III §4.1: Emisor y Numero los completa repo.grabar con la clave final (C L2140-2144).
function filaCompraImpuesto(f) {
  return {
    IdTipoImpuesto: f.idTipoImpuesto, Orden: f.orden, IdProvincia: f.idProvincia, Bruto: f.bruto,
    BaseImponible: f.baseImponible, Alicuota: f.alicuota, Importe: f.importe, EsDespacho: false,
  };
}

// DOC Parte II §1.3 paso 4g (C L2075-2078) y Anexo PeriodosFiscales_UPosicion: si GrabaLibro y el proveedor
// discrimina IVA. Usa el mismo período e IdEmpresa que la cabecera (comp.PeriodoFiscal).
function filaPeriodoFiscal(ctx, compras, calculo) {
  const cf = ctx.proveedor.categoriaFiscal;
  if (!ctx.tipo.grabaLibro || !(cf && cf.ivaDiscriminado)) return null;
  return {
    IdEmpresa: compras.IdEmpresa != null ? compras.IdEmpresa : ctx.destino.sucursal.idEmpresa,
    PeriodoFiscal: compras.PeriodoFiscal || 0,
    netoCompras: calculo.totales.totalNeto,
    impuestosCompras: calculo.totales.totalIVA,
    compras: calculo.totales.importeTotal,
    percepciones: calculo.percepciones.percepcionIVA,
  };
}

// DOC Parte II §1.3 paso 8 y SqlServer.MovimientosStock_I. La pantalla no setea Neto/PorcentajeIVA/TotalImpuestos
// (quedan en 0); las percepciones van sin coeficiente (DOC Parte I §8.1).
function filaMovimientoStock(ctx, calculo, compras, { fecha, usuario }) {
  const p = calculo.percepciones;
  return {
    IdTipoMovimiento: ctx.tipoMovimiento.idTipoMovimiento,
    FechaMovimiento: F.fechaSiga(fecha),
    Neto: 0,
    Total: calculo.totales.importeTotal,
    PorcentajeIVA: 0,
    IdCategoriaFiscal: ctx.proveedor.idCategoriaFiscal || null,
    Usuario: usuario,
    Observacion: compras.Observacion || null,
    TotalImpuestos: 0,
    IdCliente: null,
    IdSucursal2: null,
    PercepcionIVA: p.percepcionIVA,
    PercepcionIB: p.percepcionIB,
    PercepcionGanancias: p.percepcionGanancias,
    PercepcionVarias: p.percepcionVarias,
    IdProduccion: null,
    IdProveedor: ctx.proveedor.idProveedor,
    IdEmpleado: null,
    ImpuestosInternos: p.impuestosInternos,
  };
}

// DOC Parte II §3.5 (Reglas.MovimientosStock L734-743): precio ORIGINAL de la línea (L708 lo guarda antes de pisarlo
// con PrecioNeto) con desc./rec. de la línea y del general (Round 2), dividido por Compra.CotizacionDolar (ya en N2)
// si el producto está en dólares. Cotización 0 con productos en dólares la bloquea validarComprobante.
function precioUltimaCompra(l, b, p, cotizacionDolar) {
  const general = Number(b.porcDescRecGeneral) || 0;
  const conDescuentos = l.descuentoRecargoPorc !== 0 || general !== 0
    ? redondear(redondear(l.precio * (1 + l.descuentoRecargoPorc / 100), 2) * (1 + general / 100), 2)
    : l.precio;
  return p.idMoneda === C.ID_MONEDA_DOLAR ? conDescuentos / cotizacionDolar : conDescuentos;
}

// Reglas.MovimientosStock L744-753: si no existe la fila, InsertarProductoProveedor → ProductosProveedores_I (MERGE,
// SqlServer.ProductosProveedores L20-34) con CodigoProductoProveedor = IdProducto, UltimoPrecioFabrica = el mismo
// precio y descuentos 1..6 en 0; si existe, ActualizaPrecioUltimaCompra (L85-97) solo con UltimoPrecioCompra y
// UltimaFechaCompra. UltimaFechaCompra = oMov.FechaMovimiento (con hora). Orden no es columna: es la línea.
function filaProductoProveedor(x, b, cotizacionDolar, fecha) {
  const precio = precioUltimaCompra(x.l, b, x.p, cotizacionDolar);
  return {
    Orden: x.l.orden, IdProducto: x.p.idProducto, CodigoProductoProveedor: x.p.idProducto,
    UltimoPrecioCompra: precio, UltimaFechaCompra: F.fechaSiga(fecha), UltimoPrecioFabrica: precio,
    DescuentoRecargoPorc1: 0, DescuentoRecargoPorc2: 0, DescuentoRecargoPorc3: 0,
    DescuentoRecargoPorc4: 0, DescuentoRecargoPorc5: 0, DescuentoRecargoPorc6: 0,
  };
}

// DOC Parte II §1.4 (Reglas.ProductosSucursales.ActualizarStock L1769-1797): solo si Producto.AfectaStock, y si la
// ubicación tiene sucursal asociada se repite allá. Cada destino = ActualizaProductosStock: ProductosSucursales_UStock
// (Stock + Cantidad, join SucursalesDepositos OPERATIVO), ProductosDepositos y ProductosUbicaciones por MERGE
// (Stock + Cantidad, Stock2 + 0). Sin atributos (IdaAtributo* null) no toca ProductosSucursalesAtributos.
function destinosStock(b, ctx) {
  const u = ctx.destino.ubicacion;
  const propio = { IdSucursal: b.idSucursal, IdDeposito: b.idDeposito, IdUbicacion: b.idUbicacion };
  return u.sucursalAsociada > 0
    ? [propio, { IdSucursal: u.sucursalAsociada, IdDeposito: u.depositoAsociado, IdUbicacion: u.ubicacionAsociada }]
    : [propio];
}

// DOC Parte II §1.3 pasos 9-9d (GrabaMovimientoStock ME L690-753): solo si TipoMovimiento.CoeficienteStock != 0.
// Cantidad × CoeficienteStock × (Embalaje si PrecioPorEmbalaje); MovimientosStockProductos.Precio = PrecioNeto;
// stock solo para productos con AfectaStock; ProductosProveedores solo con IdProveedor != 0.
// Precio = PrecioNeto porque el tipo de movimiento se eligió por ComprobantesAsociados (no vacío, L709-712).
function filasStock(b, ctx, calculo, { fecha, cotizacionDolar }) {
  const coef = ctx.tipoMovimiento.coeficienteStock;
  if (coef === 0) return { movimientosStockProductos: [], actualizacionesStock: [], productosProveedores: [] };
  const lineas = calculo.lineas.map(l => ({ l, p: ctx.productos[l.plu] }));
  const cantidadStock = ({ l, p }) => sinRuido(l.cantidad * coef * (p.precioPorEmbalaje ? Number(p.embalaje) : 1));
  return {
    movimientosStockProductos: lineas.map(x => ({
      Orden: x.l.orden, IdDeposito: b.idDeposito, IdUbicacion: b.idUbicacion, IdProducto: x.p.idProducto,
      Cantidad: cantidadStock(x), Cantidad2: 0, Precio: x.l.precioNeto, IdLote: null, VtoLote: null,
      IdaAtributoProducto01: null, IdaAtributoProducto02: null, IdaAtributoProducto03: null, IdaAtributoProducto04: null,
      InformeCalidadNumero: null, InformeCalidadLink: null,
    })),
    actualizacionesStock: lineas.filter(x => x.p.afectaStock).flatMap(x => destinosStock(b, ctx).map(d => ({
      Orden: x.l.orden, ...d, IdProducto: x.p.idProducto, Cantidad: cantidadStock(x),
    }))),
    productosProveedores: ctx.proveedor.idProveedor
      ? lineas.map(x => filaProductoProveedor(x, b, cotizacionDolar, fecha))
      : [],
  };
}

// DOC Parte II §1.3 paso 13 y §3.4: solo si ActualizaCtaCte y FormaPago.Dias > 0 (Reglas.MovimientosStock L419).
// SIGA-INFERIDO: TieneModuloCuentaCorrienteProveedores = true (las dos pruebas reales escribieron cta. cte.).
// Columnas y orden = SqlServer.CuentasCorrientesProv_I (L20-167) menos las 6 de la clave; valores = los que pasa
// Reglas.CuentasCorrientesProv.GrabaCuentaCorrienteProv (L210-252) con la entidad que arma MovimientosStock L421-436.
// SIGA-INFERIDO: los campos que nadie asigna (FechaTransferencia, SaldoCtaCte, FechaPromedio*, DiasPromedioEmision,
// RefProveedor, importes de otros medios) quedan en el default de la entidad (null / 0 / ''), no decompilada.
function cabeceraCtaCte(ctx, calculo, compras, { fechaCC, vence, ahora, usuario }) {
  const total = calculo.totales.importeTotal;
  return {
    Fecha: fechaCC, // L235-238: si es de hoy, DateTime.Now.
    FechaVencimiento: vence, // MovimientosStock L430: DateAdd("d", Dias, Compra.Fecha).
    ImporteTotal: total,
    IdFormasPago: ctx.formaPago.idFormasPago,
    Observacion: compras.Observacion,
    RefProveedor: '', // '{0}' de null en .NET da '' (SqlServer L71).
    Saldo: total, // L217-218: no es recibo → Saldo = ImporteTotal.
    CantidadCuotas: 1, // L219: Pagos.Count; la pantalla agrega una sola cuota (Win L23647-23651).
    importePesos: compras.ImportePesos, // MovimientosStock L432: Compra.ImportePesos × Coef.
    importeDolares: 0,
    ImporteTickets: 0,
    importeTransfBancaria: 0,
    importeCheques: 0,
    importeEuros: 0, // SqlServer L80: literal 0.
    idCuentaBancaria: null, // SqlServer L81-88: NULL si ≤ 0 (sin transferencias).
    importeRetenciones: 0,
    ImporteTarjetas: 0,
    IdEstadoComprobante: C.ESTADO_CTA_CTE, // L240.
    IdUsuario: usuario, // L241: Usuario.Actual.Nombre.
    FechaActualizacion: F.fechaSiga(ahora), // L242.
    MetodoGrabacion: C.METODO_GRABACION, // SqlServer L95.
    IdFuncion: C.ID_FUNCION,
    ImprimeSaldos: null, // L244-249: solo los recibos llevan true; si no, null → NULL (SqlServer L97-104).
    CotizacionDolar: compras.CotizacionDolar, // MovimientosStock L433.
    FechaTransferencia: null, // SqlServer L106-113: NULL sin valor.
    PromedioDiasPago: 0, // L252: < 0 → 0; default 0.
    SaldoCtaCte: null, // SqlServer L115-122: NULL sin valor.
    NumeroOrdenCompra: null, // SqlServer L123-130: NULL si 0; MovimientosStock no copia el de la compra.
    FechaPromedioPago: null,
    FechaPromedioEmision: null,
    DiasPromedioEmision: null,
  };
}

// Columnas y orden = SqlServer.CuentasCorrientesProvPagos_I menos las 6 de la clave; valores de
// Reglas.CuentasCorrientesProvPagos.GrabaCuentaCorrienteProvPagos (L66-91): sin ser recibo, ImporteCuota y
// SaldoCuota = SaldoCuota (= total, Win L23648-23649) y las columnas "2" apuntan al mismo comprobante y cuota.
// NumeroComprobante2/CentroEmisor2 salen de la clave: con numeración automática repo.grabar los completa
// junto con la clave final (como Emisor/Numero de ComprasImpuestos).
function cuotaCtaCte(ctx, calculo, compras, clave, { fechaCC, vence }) {
  const total = calculo.totales.importeTotal;
  return {
    CuotaNumero: 1,
    Fecha: fechaCC, // L90: ent.CuentaCorrienteProv.Fecha, ya ajustada a la hora real si es de hoy.
    FechaVencimiento: vence, // Win L23650: dtpFecha + Dias.
    ImporteCuota: total,
    SaldoCuota: total,
    IdFormasPago: ctx.formaPago.idFormasPago,
    Observacion: compras.Observacion,
    IdTipoComprobante2: clave.IdTipoComprobante,
    NumeroComprobante2: clave.NumeroComprobante,
    CentroEmisor2: clave.CentroEmisor,
    CuotaNumero2: 1,
    Letra2: clave.Letra,
    DescuentoRecargoPorc: 0, // default de la entidad: la pantalla no los asigna.
    DescuentoRecargo: 0,
  };
}

function filaCtaCte(ctx, calculo, compras, clave, { fecha, ahora, usuario }) {
  if (!ctx.tipo.actualizaCtaCte || !(ctx.formaPago.dias > 0)) return null;
  const fechas = {
    fechaCC: F.fechaSiga(F.fechaCtaCte(fecha, ahora)), vence: F.fechaSiga(F.vencimiento(fecha, ctx.formaPago.dias)), ahora, usuario,
  };
  return {
    cabecera: cabeceraCtaCte(ctx, calculo, compras, fechas),
    cuotas: [cuotaCtaCte(ctx, calculo, compras, clave, fechas)],
  };
}

function armarComprobante(borrador, ctx, calculo, { ahora, usuario }) {
  const modo = numeracionDe(borrador, ctx);
  const fecha = F.fechaHoraComprobante(borrador.fecha, ahora);
  const opciones = {
    fecha, ahora, usuario: String(usuario || '').slice(0, C.LARGO_USUARIO),
    // Win L20046/L24122 + L23459: decimal.Parse(FactorConversion.ToString("N2")) → 2 decimales lejos del cero.
    // Ese mismo valor va a Compras, a la cta. cte. y divide el último precio en dólares.
    cotizacionDolar: redondearLejosDelCero(ctx.cotizacionDolar, 2),
  };
  const compras = filaCompras(borrador, ctx, calculo, opciones);
  const clave = {
    IdSucursal: borrador.idSucursal,
    IdTipoComprobante: ctx.tipo.idTipoComprobante,
    Letra: borrador.letra,
    // DOC Parte I §3.2 (CargarProximoNumeroProveedor): emisor editable (vacío = 1); en 'proveedor' el número lo
    // asigna repo.grabar con lock; un número tipeado distinto del propuesto llega como 'manual' (numeracionDe).
    CentroEmisor: emisorDe(borrador, ctx.tipo),
    NumeroComprobante: modo === 'proveedor' ? 0 : Number(borrador.numeroComprobante),
    IdProveedor: ctx.proveedor.idProveedor,
  };
  return {
    clave,
    // SIGA-INFERIDO: VentasNumeros.Fecha = la fecha del comprobante.
    numeracion: { modo, idEmpresa: ctx.destino.sucursal.idEmpresa, fecha: F.fechaSiga(fecha) },
    compras,
    comprasProductos: calculo.lineas.map(l => filaCompraProducto(l, borrador, ctx)),
    comprasImpuestos: calculo.filasImpuestos.map(filaCompraImpuesto),
    periodoFiscal: filaPeriodoFiscal(ctx, compras, calculo),
    movimientoStock: filaMovimientoStock(ctx, calculo, compras, opciones),
    ...filasStock(borrador, ctx, calculo, opciones),
    ctaCte: filaCtaCte(ctx, calculo, compras, clave, opciones),
  };
}

module.exports = { calcularComprobante, armarComprobante };
