'use strict';
// Caso real del DOC: FACTCOM A 5007-1071364 (neto 35.023,65 + IVA 6.686,32 + PIVA 955,19 = 42.665,16),
// de un proveedor RI con la empresa RI. Lo usan los tests de validaciones, armado, repo y rutas.
// Las funciones aceptan cambios superficiales (spread) para armar variantes.

const CATEGORIA_RI = Object.freeze({
  idCategoriaFiscal: 2, nombre: 'Responsable Inscripto', ivaDiscriminado: true, utilizaImpuestos: true, letraFiscalCompra: 'A',
});

const AHORA = new Date(2026, 9, 16, 14, 47, 6);

function borradorFactcom(cambios = {}) {
  return {
    numeroPedido: 'P-0007', idProveedor: 328, proveedor: 'PROVEEDOR RI',
    idTipoComprobante: 'FACTCOM', letra: 'A', centroEmisor: 5007, numeroComprobante: 1071364,
    fecha: '2026-10-10', periodoFiscal: 202610, idSucursal: 1, idDeposito: 1, idUbicacion: 1,
    idFormasPago: 3, porcDescRecGeneral: 0, observacion: 'Pedido P-0007',
    lineas: [
      { orden: 1, plu: '1001', nombre: 'Harina', cantidad: 1, precio: 31839.64 },
      { orden: 2, plu: '1002', nombre: 'Huevos', cantidad: 1, precio: 3184.01 },
    ],
    percepciones: [{ tipo: 'PIVA', importe: 955.19, baseImponible: 0, alicuota: 0, idProvincia: null }],
    descartadas: [], bloqueos: [],
    ...cambios,
  };
}

function contextoFactcom(cambios = {}) {
  return {
    hoy: '2026-10-16',
    proveedor: {
      idProveedor: 328, nombre: 'PROVEEDOR RI', cuit: '20-12345678-6', idCategoriaFiscal: 2, idRubroCompra: 1,
      idFormasPago: 3, descuentoRecargoPorc: 0, idTipoComprobante: 'FACTCOM', categoriaFiscal: { ...CATEGORIA_RI },
    },
    empresa: { idEmpresa: 1, categoriaFiscal: { ...CATEGORIA_RI } },
    tipo: {
      idTipoComprobante: 'FACTCOM', descripcion: 'Factura de compra', tipo: 'COMPRAS', grabaLibro: true,
      informaLibroIva: true, numeracionAutomatica: false, letrasHabilitadas: ['A', 'B', 'C', 'E', 'I', 'M'],
      coeficienteStock: 1, coeficienteValores: 1, actualizaCtaCte: true, afectaCaja: true, utilizaImpuestos: true,
      esComercial: true, generaContabilidad: false, importeMinimo: 0, activaTildeMercDespacha: false,
    },
    formaPago: { idFormasPago: 3, descripcion: 'Cta. Cte.', dias: 30 },
    productos: {
      1001: {
        idProducto: '1001', nombre: 'HARINA 000 X 25', activo: true, esDeCompras: true, alicuota: 21, afectaStock: true,
        embalaje: 0, precioPorEmbalaje: false, idUnidadDeMedida: 'UN', idUnidadDeMedidaCompra: 'UN', conceptoCompras: null, idMoneda: 1,
      },
      1002: {
        idProducto: '1002', nombre: 'HUEVOS X 30', activo: true, esDeCompras: true, alicuota: 0, afectaStock: true,
        embalaje: 0, precioPorEmbalaje: false, idUnidadDeMedida: 'UN', idUnidadDeMedidaCompra: 'UN', conceptoCompras: null, idMoneda: 1,
      },
    },
    destino: {
      sucursal: { idSucursal: 1, idEmpresa: 1 },
      ubicacion: {
        idSucursal: 1, idDeposito: 1, idUbicacion: 1, nombre: 'Depósito 1 · Ubicación 1',
        sucursalAsociada: 0, depositoAsociado: 0, ubicacionAsociada: 0,
      },
    },
    tipoMovimiento: { idTipoMovimiento: 'COMPRA', coeficienteStock: 1 },
    periodo: { periodoFiscal: 202610, fechaCierre: null },
    duplicado: { enCompras: false, enCtaCte: false },
    ventasNumerosRelacionado: false,
    parametros: { categoriaFiscalEmpresa: 2, decimalesTotal: 2, decimalesPrecio: 2, pasajeIncluyeImpuestos: false },
    cotizacionDolar: 1450,
    ...cambios,
  };
}

// Filas crudas tal como las devolvería SIGA (SELECT *, char con espacios a la derecha) para el mismo caso:
// mapeadas con lib/siga_compras/mapeos.js tienen que dar exactamente contextoFactcom().
const FILAS_SIGA = {
  Proveedores: [{
    IdProveedor: 328, NombreProveedor: 'PROVEEDOR RI ', CuitProveedor: '20-12345678-6', IdCategoriaFiscal: 2,
    IdRubroCompra: 1, IdFormasPago: 3, DescuentoRecargoPorc: 0, IdTipoComprobante: 'FACTCOM   ',
  }],
  Sucursales: [{ IdSucursal: 1, IdEmpresa: 1, Nombre: 'Casa Central' }],
  Parametros: [
    { IdParametro: 'CATEGORIAFISCALEMPRESA', ValorParametro: '2' },
    { IdParametro: 'COMPRASDECIMALESENTOTALGENERAL', ValorParametro: '2' },
    // SIGA-INFERIDO: la base real tendría COMPRASDECIMALESREDONDEOENPRECIO=2 (deducido de 6.686,32 del caso 1071364)
    { IdParametro: 'COMPRASDECIMALESREDONDEOENPRECIO', ValorParametro: '2' },
    { IdParametro: 'EXPENSASPASAJECOMPRASINCLUYEIMPUESTOS', ValorParametro: 'False' },
  ],
  CategoriasFiscales: [{
    IdCategoriaFiscal: 2, NombreCategoriaFiscal: 'Responsable Inscripto', IvaDiscriminado: true, UtilizaImpuestos: true, LetraFiscalCompra: 'A',
  }],
  TiposComprobantes: [{
    IdTipoComprobante: 'FACTCOM   ', Descripcion: 'Factura de compra', Tipo: 'COMPRAS', GrabaLibro: true, InformaLibroIVA: true,
    NumeracionAutomatica: false, LetrasHabilitadas: 'ABCEIM', CoeficienteStock: 1, CoeficienteValores: 1, ActualizaCtaCte: true,
    AfectaCaja: true, UtilizaImpuestos: true, EsComercial: true, GeneraContabilidad: false, ImporteMinimo: 0,
  }],
  VentasFormasPago: [{ IdFormasPago: 3, DescripcionFormasPago: ' Cta. Cte.', Dias: 30 }],
  Productos: [
    {
      IdProducto: '1001      ', NombreProducto: 'HARINA 000 X 25', Activo: true, EsDeCompras: true, Alicuota: 21, AfectaStock: true,
      Embalaje: 0, PrecioPorEmbalaje: false, IdUnidadDeMedida: 'UN', IdUnidadDeMedidaCompra: 'UN', ConceptoCompras: null, IdMoneda: 1,
    },
    {
      IdProducto: '1002      ', NombreProducto: 'HUEVOS X 30', Activo: true, EsDeCompras: true, Alicuota: 0, AfectaStock: true,
      Embalaje: 0, PrecioPorEmbalaje: false, IdUnidadDeMedida: 'UN', IdUnidadDeMedidaCompra: 'UN', ConceptoCompras: null, IdMoneda: 1,
    },
  ],
  SucursalesUbicaciones: [{ IdSucursal: 1, IdDeposito: 1, IdUbicacion: 1 }],
  TiposMovimientos: [{ IdTipoMovimiento: 'COMPRA    ', CoeficienteStock: 1 }],
  Monedas: [{ FactorConversion: 1450 }],
  PeriodosFiscales: [{ PeriodoFiscal: 202610, FechaCierre: null }],
  Provincias: [{ IdProvincia: 'SF', NombreProvincia: 'Santa Fe' }],
};

module.exports = { borradorFactcom, contextoFactcom, AHORA, FILAS_SIGA };
