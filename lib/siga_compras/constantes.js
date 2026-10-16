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
  // SIGA-INFERIDO: IdParametro de la tabla Parametros. Solo CATEGORIAFISCALEMPRESA está confirmado
  // (CROSS JOIN Parametros en SqlServer.Compras); los otros siguen el nombre de la propiedad de Publicos.
  PARAMETROS: Object.freeze({
    CATEGORIA_FISCAL_EMPRESA: 'CATEGORIAFISCALEMPRESA',
    DECIMALES_TOTAL: 'COMPRASDECIMALESENTOTALGENERAL',
    DECIMALES_PRECIO: 'COMPRASDECIMALESREDONDEOENPRECIO',
    PASAJE_INCLUYE_IMPUESTOS: 'PASAJECOMPRASINCLUYEIMPUESTOS',
  }),
  // SIGA-INFERIDO: defaults cuando el parámetro no existe en la tabla.
  DEFAULTS_PARAMETROS: Object.freeze({ decimalesTotal: 2, decimalesPrecio: 2, pasajeIncluyeImpuestos: false }),
  // SIGA-INFERIDO: SiGA exige comprador (DOC Parte I §7 #24); el grabador anterior usaba el empleado 1.
  ID_COMPRADOR_DEFAULT: 1,
  // Spec "Destino": por defecto sucursal 1.
  SUCURSAL_DEFAULT: 1,
  // Largos de columnas varchar relevados por el grabador anterior.
  LARGO_USUARIO: 10,
  LARGO_OBSERVACION: 100,
  LARGO_NOMBRE_PROVEEDOR: 100,
  LARGO_NOMBRE_PRODUCTO: 60,
});
