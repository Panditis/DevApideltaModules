'use strict';
// Valores fijos de SiGA para la carga de compras (pantalla MovimientosDeComprasV2).
// Fuente: docs/siga_compras_carga_descompilado.md (DOC).

module.exports = Object.freeze({
  // Texto con separador de miles argentino ('1.500', '12.345.678'): Number() lo leería como 1,5; no se acepta como número.
  MILES_ARGENTINO: /^-?\d{1,3}(\.\d{3})+$/,
  // DOC Parte I §6.2 / Parte II §5.2: Compra.PorcentajeIVA = 21m hardcodeado (Win L23380, C L248, L3133).
  PORCENTAJE_IVA_CABECERA: 21,
  // DOC Parte III §0: MetodoGrabacion.Manual.ToString().Substring(0, 1).
  METODO_GRABACION: 'M',
  // DOC Parte III §2.1 columna 53.
  ID_FUNCION: 'MovimientosDeComprasV2',
  // DOC Parte I §1.2 punto 6: Monedas.GetUna(2).FactorConversion.
  ID_MONEDA_DOLAR: 2,
  // DOC Parte II §1.3: flagCompras = TipoComprobante.Tipo == "COMPRAS".
  TIPO_COMPRAS: 'COMPRAS',
  // DOC Parte I §5.2: orden en que SiGA arma las filas de ComprasImpuestos después de las de IVA.
  TIPOS_PERCEPCION: Object.freeze(['PIIBB', 'PGANA', 'PIVA', 'PVAR', 'IMINT']),
  TIPO_TIPO_IMPUESTO: Object.freeze({
    IVA: 'IVA', PIIBB: 'PERCEPCION', PGANA: 'PERCEPCION', PIVA: 'PERCEPCION', PVAR: 'PERCEPCION', IMINT: 'INTERNO',
  }),
  // DOC Parte II §3.4: GrabaCuentaCorrienteProv fija IdEstado = "NORMAL".
  ESTADO_CTA_CTE: 'NORMAL',
  // DOC Parte II §3.2 (ME L301): ImporteTotal = Round(Precio * Cantidad, 2); §3.3: proporción con 2 decimales fijos.
  DECIMALES_FIJOS: 2,
  // IdParametro de la tabla Parametros, tal como los lee R.Publicos.cs (L973-983, L2326, L2774).
  PARAMETROS: Object.freeze({
    CATEGORIA_FISCAL_EMPRESA: 'CATEGORIAFISCALEMPRESA',
    DECIMALES_TOTAL: 'COMPRASDECIMALESENTOTALGENERAL',
    DECIMALES_PRECIO: 'COMPRASDECIMALESREDONDEOENPRECIO',
    PASAJE_INCLUYE_IMPUESTOS: 'EXPENSASPASAJECOMPRASINCLUYEIMPUESTOS',
  }),
  // Defaults de SiGA cuando el parámetro no existe en la tabla (R.Publicos.cs: L983 total 2, L973 precio 4,
  // L2774 pasaje True, L2326 categoría fiscal de la empresa 2).
  DEFAULTS_PARAMETROS: Object.freeze({
    decimalesTotal: 2, decimalesPrecio: 4, pasajeIncluyeImpuestos: true, categoriaFiscalEmpresa: 2,
  }),
  // SIGA-INFERIDO: SiGA exige comprador (DOC Parte I §7 #24); el grabador anterior usaba el empleado 1.
  ID_COMPRADOR_DEFAULT: 1,
  // Spec "Destino": por defecto sucursal 1.
  SUCURSAL_DEFAULT: 1,
  // Largos de columnas varchar relevados por el grabador anterior.
  LARGO_USUARIO: 10,
  LARGO_OBSERVACION: 100,
  LARGO_NOMBRE_PROVEEDOR: 100,
  LARGO_NOMBRE_PRODUCTO: 60,
  // Tope v1 de líneas del comprobante: repo.leerProductos usa un parámetro por PLU y SQL Server corta en 2100.
  // SiGA no tiene tope en la grilla de productos (CantidadMaximaItems no aplica ahí).
  MAX_LINEAS: 200,
});
