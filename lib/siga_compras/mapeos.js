'use strict';
// Filas crudas de SIGA (SELECT *) → objetos del dominio. Puro. Las columnas marcadas SIGA-INFERIDO llevan el
// nombre de la propiedad de la entidad en los .cs descompilados (docs/siga_compras_carga_descompilado.md); si la
// columna no existe se corta con un error claro en vez de grabar con un default inventado.
const C = require('./constantes');
const { letrasDe } = require('./lineas');

const texto = v => (v == null ? '' : String(v).trim());
const numero = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const bool = v => v === true || v === 1 || ['1', 'true', 'si', 's'].includes(texto(v).toLowerCase());

function requerido(fila, tabla, columna) {
  if (!fila || !Object.prototype.hasOwnProperty.call(fila, columna)) {
    throw new Error(`Falta la columna ${tabla}.${columna} en SIGA (nombre SIGA-INFERIDO, ver docs/siga_compras_carga_descompilado.md).`);
  }
  return fila[columna];
}

// IdProveedor/NombreProveedor/CuitProveedor/IdCategoriaFiscal: confirmados (routes/rutas_compras.js).
// IdRubroCompra: confirmado ("RC.IdRubro = P.IdRubroCompra" en SqlServer). SIGA-INFERIDO: IdFormasPago,
// DescuentoRecargoPorc, IdTipoComprobante (DOC Parte I §2, propiedades de Proveedor); son sugerencias, opcionales.
function mapearProveedor(fila) {
  return {
    idProveedor: numero(requerido(fila, 'Proveedores', 'IdProveedor')),
    nombre: texto(fila.NombreProveedor),
    cuit: texto(fila.CuitProveedor),
    idCategoriaFiscal: numero(fila.IdCategoriaFiscal),
    idRubroCompra: numero(fila.IdRubroCompra),
    idFormasPago: numero(fila.IdFormasPago),
    descuentoRecargoPorc: numero(fila.DescuentoRecargoPorc) || 0,
    idTipoComprobante: texto(fila.IdTipoComprobante) || null,
  };
}

// SIGA-INFERIDO: columnas de CategoriaFiscal.IvaDiscriminado/UtilizaImpuestos/LetraFiscalCompra. Ojo:
// SqlServer.Compras también usa CategoriasFiscalesConfiguraciones.IvaDiscriminado (por empresa).
function mapearCategoriaFiscal(fila) {
  const t = 'CategoriasFiscales';
  return {
    idCategoriaFiscal: numero(requerido(fila, t, 'IdCategoriaFiscal')),
    nombre: texto(fila.NombreCategoriaFiscal),
    ivaDiscriminado: bool(requerido(fila, t, 'IvaDiscriminado')),
    utilizaImpuestos: bool(requerido(fila, t, 'UtilizaImpuestos')),
    letraFiscalCompra: texto(requerido(fila, t, 'LetraFiscalCompra')).toUpperCase(),
  };
}

// GrabaLibro/InformaLibroIva/NumeracionAutomatica/LetrasHabilitadas/CoeficienteStock/ActualizaCtaCte/
// UtilizaImpuestos/Tipo: confirmados (docs/compras_siga_mapeo.md). SIGA-INFERIDO: CoeficienteValores, AfectaCaja,
// EsComercial, GeneraContabilidad (requeridos: deciden qué se escribe); ImporteMinimo y ActivaTildeMercDespacha
// (opcionales: 0 / false).
function mapearTipoComprobante(fila) {
  const t = 'TiposComprobantes';
  return {
    idTipoComprobante: texto(requerido(fila, t, 'IdTipoComprobante')),
    descripcion: texto(fila.Descripcion),
    tipo: texto(requerido(fila, t, 'Tipo')),
    grabaLibro: bool(requerido(fila, t, 'GrabaLibro')),
    informaLibroIva: bool(requerido(fila, t, 'InformaLibroIva')),
    numeracionAutomatica: bool(requerido(fila, t, 'NumeracionAutomatica')),
    letrasHabilitadas: letrasDe(requerido(fila, t, 'LetrasHabilitadas')),
    coeficienteStock: numero(requerido(fila, t, 'CoeficienteStock')) ?? 0,
    coeficienteValores: numero(requerido(fila, t, 'CoeficienteValores')) ?? 0,
    actualizaCtaCte: bool(requerido(fila, t, 'ActualizaCtaCte')),
    afectaCaja: bool(requerido(fila, t, 'AfectaCaja')),
    utilizaImpuestos: bool(requerido(fila, t, 'UtilizaImpuestos')),
    esComercial: bool(requerido(fila, t, 'EsComercial')),
    generaContabilidad: bool(requerido(fila, t, 'GeneraContabilidad')),
    importeMinimo: numero(fila.ImporteMinimo) || 0,
    activaTildeMercDespacha: bool(fila.ActivaTildeMercDespacha),
  };
}

// VentasFormasPago.Dias y DescripcionFormasPago: confirmados (DOC Parte III §6.2, lib/compras_grabar.js).
function mapearFormaPago(fila) {
  return {
    idFormasPago: numero(requerido(fila, 'VentasFormasPago', 'IdFormasPago')),
    descripcion: texto(fila.DescripcionFormasPago),
    dias: numero(requerido(fila, 'VentasFormasPago', 'Dias')) ?? 0,
  };
}

// Activo/EsDeCompras: confirmados (routes/rutas_compras.js); Alicuota: confirmada ("P.Alicuota" en SqlServer).
// SIGA-INFERIDO: AfectaStock, IdUnidadDeMedida, IdUnidadDeMedidaCompra (requeridos), Embalaje, PrecioPorEmbalaje,
// ConceptoCompras, IdMoneda (opcionales).
function mapearProducto(fila) {
  const t = 'Productos';
  return {
    idProducto: texto(requerido(fila, t, 'IdProducto')),
    nombre: texto(fila.NombreProducto),
    activo: bool(fila.Activo),
    esDeCompras: bool(fila.EsDeCompras),
    alicuota: numero(requerido(fila, t, 'Alicuota')) ?? 0,
    afectaStock: bool(requerido(fila, t, 'AfectaStock')),
    embalaje: numero(fila.Embalaje) ?? 0,
    precioPorEmbalaje: bool(fila.PrecioPorEmbalaje),
    idUnidadDeMedida: texto(requerido(fila, t, 'IdUnidadDeMedida')),
    idUnidadDeMedidaCompra: texto(requerido(fila, t, 'IdUnidadDeMedidaCompra')),
    conceptoCompras: numero(fila.ConceptoCompras),
    idMoneda: numero(fila.IdMoneda) ?? 1,
  };
}

// SIGA-INFERIDO: SucursalAsociada/DepositoAsociado/UbicacionAsociada (entidad SucursalUbicacion, DOC Parte II §1.4).
function mapearUbicacion(fila) {
  const t = 'SucursalesUbicaciones';
  const idDeposito = numero(requerido(fila, t, 'IdDeposito'));
  const idUbicacion = numero(requerido(fila, t, 'IdUbicacion'));
  return {
    idSucursal: numero(requerido(fila, t, 'IdSucursal')),
    idDeposito, idUbicacion,
    nombre: texto(fila.NombreUbicacion) || `Depósito ${idDeposito} · Ubicación ${idUbicacion}`,
    sucursalAsociada: numero(fila.SucursalAsociada) || 0,
    depositoAsociado: numero(fila.DepositoAsociado) || 0,
    ubicacionAsociada: numero(fila.UbicacionAsociada) || 0,
  };
}

// TiposMovimientos.CoeficienteStock: confirmado (routes/rutas_stock.js).
function mapearTipoMovimiento(fila) {
  return {
    idTipoMovimiento: texto(requerido(fila, 'TiposMovimientos', 'IdTipoMovimiento')),
    coeficienteStock: numero(requerido(fila, 'TiposMovimientos', 'CoeficienteStock')) ?? 0,
  };
}

// SIGA-INFERIDO: tabla Provincias (ComprasImpuestos.GetTodasLasProvincias, DOC Parte I §1.3).
function mapearProvincia(fila) {
  const idProvincia = texto(requerido(fila, 'Provincias', 'IdProvincia'));
  return { idProvincia, nombre: texto(fila.NombreProvincia) || idProvincia };
}

// Parametros(IdParametro, ValorParametro): confirmado. Nombres y defaults en constantes.js (SIGA-INFERIDO).
function mapearParametros(filas) {
  const valor = id => {
    const f = (filas || []).find(x => texto(x.IdParametro).toUpperCase() === id);
    return f ? f.ValorParametro : undefined;
  };
  const P = C.PARAMETROS;
  const D = C.DEFAULTS_PARAMETROS;
  const entero = (id, def) => { const n = numero(valor(id)); return n == null ? def : n; };
  const pasaje = valor(P.PASAJE_INCLUYE_IMPUESTOS);
  return {
    categoriaFiscalEmpresa: numero(valor(P.CATEGORIA_FISCAL_EMPRESA)),
    decimalesTotal: entero(P.DECIMALES_TOTAL, D.decimalesTotal),
    decimalesPrecio: entero(P.DECIMALES_PRECIO, D.decimalesPrecio),
    pasajeIncluyeImpuestos: pasaje === undefined ? D.pasajeIncluyeImpuestos : bool(pasaje),
  };
}

module.exports = {
  mapearProveedor, mapearCategoriaFiscal, mapearTipoComprobante, mapearFormaPago, mapearProducto,
  mapearUbicacion, mapearTipoMovimiento, mapearProvincia, mapearParametros,
};
