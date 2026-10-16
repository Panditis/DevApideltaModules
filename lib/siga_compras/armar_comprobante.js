'use strict';
// Borrador editado + contexto de SIGA → TODAS las filas a escribir, por tabla, ya calculadas. Puro: repo.grabar
// solo ejecuta. Columnas: DOC Parte III (Compras_I §2.1, ComprasProductos_I §3.1, ComprasImpuestos_I §4.1) y
// SqlServer.MovimientosStock_I / MovimientosStockProductos_I. Las 6 columnas de la clave (y el número
// automático, Emisor/Numero de impuestos y el número de movimiento) las completa repo.grabar.
// Se llama solo con un borrador sin errores de validarComprobante.
const C = require('./constantes');
const { calcularLinea, discriminaIVA, redondear, sinRuido } = require('./lineas');
const I = require('./impuestos');
const F = require('./fechas');
const { modoNumeracion } = require('./validaciones');

function discriminaDe(ctx) {
  const prov = ctx.proveedor && ctx.proveedor.categoriaFiscal;
  const emp = ctx.empresa && ctx.empresa.categoriaFiscal;
  return !!(prov && emp && ctx.tipo) && discriminaIVA({ proveedor: prov, empresa: emp, tipo: ctx.tipo });
}

// Todo lo calculable sin la clave definitiva: lo usan POST /validar (para mostrar) y armarComprobante.
// Tolera contexto incompleto (producto inexistente → IVA 0) porque /validar lo llama aunque haya errores.
function calcularComprobante(borrador, ctx) {
  const discrimina = discriminaDe(ctx);
  const { decimalesPrecio, decimalesTotal, pasajeIncluyeImpuestos } = ctx.parametros;
  const lineas = borrador.lineas.map(l => {
    const p = ctx.productos[l.plu];
    return {
      ...l,
      ...calcularLinea({
        cantidad: l.cantidad, precio: l.precio || 0, porcentajeIVA: p ? p.alicuota : 0,
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
    lineas: lineas.map((l, i) => ({
      ...l, proporcionalImp: proporcional[i], montoSaldo: I.montoSaldo(l, proporcional[i], pasajeIncluyeImpuestos),
    })),
    filasImpuestos,
    totales: { ...totales, importeTotal },
    percepciones: I.percepcionesCabecera(borrador.percepciones),
  };
}

// DOC Parte III §2.1: las 60 columnas de Compras_I menos las 6 de la clave.
function filaCompras(b, ctx, calculo, { fecha, ahora, usuario }) {
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
    CotizacionDolar: ctx.cotizacionDolar,
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
    IVA: l.iva, // Parte III §3.1 col. 21: sin redondear.
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
function filaMovimientoStock(b, ctx, calculo, { fecha, usuario }) {
  const p = calculo.percepciones;
  return {
    IdTipoMovimiento: ctx.tipoMovimiento.idTipoMovimiento,
    FechaMovimiento: F.fechaSiga(fecha),
    Neto: 0,
    Total: calculo.totales.importeTotal,
    PorcentajeIVA: 0,
    IdCategoriaFiscal: ctx.proveedor.idCategoriaFiscal || null,
    Usuario: usuario,
    Observacion: String(b.observacion || '').slice(0, C.LARGO_OBSERVACION) || null,
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

// DOC Parte II §3.5 (ME L733-753): precio de la línea con desc./rec. de la línea y del general (Round 2),
// dividido por la cotización si el producto está en dólares.
function precioUltimaCompra(l, b, p, cotizacionDolar) {
  const general = Number(b.porcDescRecGeneral) || 0;
  const conDescuentos = l.descuentoRecargoPorc !== 0 || general !== 0
    ? redondear(redondear(l.precio * (1 + l.descuentoRecargoPorc / 100), 2) * (1 + general / 100), 2)
    : l.precio;
  return p.idMoneda === C.ID_MONEDA_DOLAR && cotizacionDolar ? conDescuentos / cotizacionDolar : conDescuentos;
}

// DOC Parte II §1.4 (PS L1790-1794): si la ubicación tiene sucursal asociada, el stock se repite allá.
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
function filasStock(b, ctx, calculo, fecha) {
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
      ? lineas.map(x => ({
        Orden: x.l.orden, IdProducto: x.p.idProducto,
        Precio: precioUltimaCompra(x.l, b, x.p, ctx.cotizacionDolar), Fecha: F.fechaSiga(fecha),
      }))
      : [],
  };
}

// DOC Parte II §1.3 paso 13 y §3.4 (ME L419-439, CCP L210-279, CCPP L66-91): solo si ActualizaCtaCte y
// FormaPago.Dias > 0; una sola cuota por el total, vencimiento = fecha + Dias.
// SIGA-INFERIDO: TieneModuloCuentaCorrienteProveedores = true (las dos pruebas reales escribieron cta. cte.).
// SIGA-INFERIDO: columnas = las del grabador anterior (relevadas por diff de snapshots, docs/compras_siga_mapeo.md).
function filaCtaCte(ctx, calculo, compras, { fecha, ahora, usuario }) {
  if (!ctx.tipo.actualizaCtaCte || !(ctx.formaPago.dias > 0)) return null;
  const total = calculo.totales.importeTotal;
  const fechaCC = F.fechaSiga(F.fechaCtaCte(fecha, ahora));
  const vence = F.fechaSiga(F.vencimiento(fecha, ctx.formaPago.dias));
  const observacion = compras.Observacion;
  return {
    cabecera: {
      Fecha: fechaCC, FechaVencimiento: vence, ImporteTotal: total, IdFormasPago: ctx.formaPago.idFormasPago,
      Observacion: observacion, Saldo: total, CantidadCuotas: 1, ImportePesos: compras.ImportePesos,
      ImporteDolares: 0, ImporteEuros: 0, ImporteCheques: 0, ImporteTransfBancaria: 0, ImporteTickets: 0,
      ImporteRetenciones: 0, ImporteTarjetas: 0, IdEstadoComprobante: C.ESTADO_CTA_CTE, IdUsuario: usuario,
      FechaActualizacion: F.fechaSiga(ahora), MetodoGrabacion: C.METODO_GRABACION, IdFuncion: C.ID_FUNCION,
      CotizacionDolar: ctx.cotizacionDolar, RefProveedor: '', PromedioDiasPago: 0,
    },
    cuotas: [{
      CuotaNumero: 1, Fecha: fechaCC, FechaVencimiento: vence, ImporteCuota: total, SaldoCuota: total,
      IdFormasPago: ctx.formaPago.idFormasPago, Observacion: observacion, DescuentoRecargo: 0, DescuentoRecargoPorc: 0,
    }],
  };
}

function armarComprobante(borrador, ctx, calculo, { ahora, usuario }) {
  const modo = modoNumeracion(ctx.tipo, ctx.ventasNumerosRelacionado);
  const fecha = F.fechaHoraComprobante(borrador.fecha, ahora);
  const opciones = { fecha, ahora, usuario: String(usuario || '').slice(0, C.LARGO_USUARIO) };
  const compras = filaCompras(borrador, ctx, calculo, opciones);
  return {
    clave: {
      IdSucursal: borrador.idSucursal,
      IdTipoComprobante: ctx.tipo.idTipoComprobante,
      Letra: borrador.letra,
      // DOC Parte I §3.2 (CargarProximoNumeroProveedor): emisor 1; el número lo asigna repo.grabar con lock.
      CentroEmisor: modo === 'proveedor' ? 1 : Number(borrador.centroEmisor),
      NumeroComprobante: modo === 'proveedor' ? 0 : Number(borrador.numeroComprobante),
      IdProveedor: ctx.proveedor.idProveedor,
    },
    // SIGA-INFERIDO: VentasNumeros.Fecha = la fecha del comprobante.
    numeracion: { modo, idEmpresa: ctx.destino.sucursal.idEmpresa, fecha: F.fechaSiga(fecha) },
    compras,
    comprasProductos: calculo.lineas.map(l => filaCompraProducto(l, borrador, ctx)),
    comprasImpuestos: calculo.filasImpuestos.map(filaCompraImpuesto),
    periodoFiscal: filaPeriodoFiscal(ctx, compras, calculo),
    movimientoStock: filaMovimientoStock(borrador, ctx, calculo, opciones),
    ...filasStock(borrador, ctx, calculo, fecha),
    ctaCte: filaCtaCte(ctx, calculo, compras, opciones),
  };
}

module.exports = { calcularComprobante, armarComprobante };
