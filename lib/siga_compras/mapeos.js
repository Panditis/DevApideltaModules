'use strict';
// Filas crudas de SIGA (SELECT *) → objetos del dominio. Puro. Las columnas marcadas SIGA-INFERIDO llevan el
// nombre de la propiedad de la entidad en los .cs descompilados (docs/siga_compras_carga_descompilado.md); si la
// columna no existe se corta con un error claro en vez de grabar con un default inventado.
const C = require('./constantes');
const { letrasDe } = require('./lineas');
const { ErrorSiga } = require('./sql_comun');

const texto = v => (v == null ? '' : String(v).trim());
const numero = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const bool = v => v === true || v === 1 || ['1', 'true', 'si', 's'].includes(texto(v).toLowerCase());

// mssql devuelve el casing de la tabla y SQL Server no distingue mayúsculas: las columnas se buscan sin distinguirlas.
function claveDe(fila, columna) {
  if (!fila) return undefined;
  if (Object.prototype.hasOwnProperty.call(fila, columna)) return columna;
  const minuscula = columna.toLowerCase();
  return Object.keys(fila).find(k => k.toLowerCase() === minuscula);
}
const leer = (fila, columna) => { const k = claveDe(fila, columna); return k === undefined ? undefined : fila[k]; };

function requerido(fila, tabla, columna) {
  const k = claveDe(fila, columna);
  if (k === undefined) throw new ErrorSiga(`Falta la columna ${tabla}.${columna} en SIGA.`);
  return fila[k];
}

// IdProveedor/NombreProveedor/CuitProveedor/IdCategoriaFiscal: confirmados (routes/rutas_compras.js).
// IdRubroCompra: confirmado ("RC.IdRubro = P.IdRubroCompra" en SqlServer). SIGA-INFERIDO: IdFormasPago,
// DescuentoRecargoPorc, IdTipoComprobante (DOC Parte I §2, propiedades de Proveedor); son sugerencias, opcionales.
function mapearProveedor(fila) {
  return {
    idProveedor: numero(requerido(fila, 'Proveedores', 'IdProveedor')),
    nombre: texto(leer(fila, 'NombreProveedor')),
    cuit: texto(leer(fila, 'CuitProveedor')),
    idCategoriaFiscal: numero(leer(fila, 'IdCategoriaFiscal')),
    idRubroCompra: numero(leer(fila, 'IdRubroCompra')),
    idFormasPago: numero(leer(fila, 'IdFormasPago')),
    descuentoRecargoPorc: numero(leer(fila, 'DescuentoRecargoPorc')) || 0,
    idTipoComprobante: texto(leer(fila, 'IdTipoComprobante')) || null,
  };
}

// Confirmado (S.CategoriasFiscales.cs L86-106, SelectTexto): IvaDiscriminado y LetraFiscalCompra NO están en
// CategoriasFiscales; vienen de CategoriasFiscalesConfiguraciones (CFC, por categoría del cliente/proveedor y de la
// empresa). UtilizaImpuestos sí es de CategoriasFiscales (CF). La fila que recibe esta función es la de
// SQL_CATEGORIA_FISCAL (la consulta que tiene que usar repo.js, Task 8), con las columnas ya aliasadas.
function mapearCategoriaFiscal(fila) {
  const t = 'CategoriasFiscales';
  return {
    idCategoriaFiscal: numero(requerido(fila, t, 'IdCategoriaFiscal')),
    nombre: texto(leer(fila, 'NombreCategoriaFiscal')),
    ivaDiscriminado: bool(requerido(fila, t, 'IvaDiscriminado')),
    utilizaImpuestos: bool(requerido(fila, t, 'UtilizaImpuestos')),
    letraFiscalCompra: texto(requerido(fila, t, 'LetraFiscalCompra')).toUpperCase(),
  };
}

// GrabaLibro/InformaLibroIVA (con IVA en mayúsculas, S.TiposComprobantes.cs L31/L205)/NumeracionAutomatica/LetrasHabilitadas/CoeficienteStock/ActualizaCtaCte/
// UtilizaImpuestos/Tipo: confirmados (docs/compras_siga_mapeo.md). SIGA-INFERIDO: CoeficienteValores, AfectaCaja,
// EsComercial, GeneraContabilidad (requeridos: deciden qué se escribe); ImporteMinimo y ActivaTildeMercDespacha
// (opcionales: 0 / false).
function mapearTipoComprobante(fila) {
  const t = 'TiposComprobantes';
  return {
    idTipoComprobante: texto(requerido(fila, t, 'IdTipoComprobante')),
    descripcion: texto(leer(fila, 'Descripcion')),
    tipo: texto(requerido(fila, t, 'Tipo')),
    grabaLibro: bool(requerido(fila, t, 'GrabaLibro')),
    informaLibroIva: bool(requerido(fila, t, 'InformaLibroIVA')),
    numeracionAutomatica: bool(requerido(fila, t, 'NumeracionAutomatica')),
    letrasHabilitadas: letrasDe(requerido(fila, t, 'LetrasHabilitadas')),
    coeficienteStock: numero(requerido(fila, t, 'CoeficienteStock')) ?? 0,
    coeficienteValores: numero(requerido(fila, t, 'CoeficienteValores')) ?? 0,
    actualizaCtaCte: bool(requerido(fila, t, 'ActualizaCtaCte')),
    afectaCaja: bool(requerido(fila, t, 'AfectaCaja')),
    utilizaImpuestos: bool(requerido(fila, t, 'UtilizaImpuestos')),
    esComercial: bool(requerido(fila, t, 'EsComercial')),
    generaContabilidad: bool(requerido(fila, t, 'GeneraContabilidad')),
    importeMinimo: numero(leer(fila, 'ImporteMinimo')) || 0,
    activaTildeMercDespacha: bool(leer(fila, 'ActivaTildeMercDespacha')),
  };
}

// VentasFormasPago.Dias y DescripcionFormasPago: confirmados (DOC Parte III §6.2, lib/compras_grabar.js).
function mapearFormaPago(fila) {
  return {
    idFormasPago: numero(requerido(fila, 'VentasFormasPago', 'IdFormasPago')),
    descripcion: texto(leer(fila, 'DescripcionFormasPago')),
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
    nombre: texto(leer(fila, 'NombreProducto')),
    activo: bool(leer(fila, 'Activo')),
    esDeCompras: bool(leer(fila, 'EsDeCompras')),
    alicuota: numero(requerido(fila, t, 'Alicuota')) ?? 0,
    afectaStock: bool(requerido(fila, t, 'AfectaStock')),
    embalaje: numero(leer(fila, 'Embalaje')) ?? 0,
    precioPorEmbalaje: bool(leer(fila, 'PrecioPorEmbalaje')),
    idUnidadDeMedida: texto(requerido(fila, t, 'IdUnidadDeMedida')),
    idUnidadDeMedidaCompra: texto(requerido(fila, t, 'IdUnidadDeMedidaCompra')),
    conceptoCompras: numero(leer(fila, 'ConceptoCompras')),
    idMoneda: numero(leer(fila, 'IdMoneda')) ?? 1,
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
    nombre: texto(leer(fila, 'NombreUbicacion')) || `Depósito ${idDeposito} · Ubicación ${idUbicacion}`,
    sucursalAsociada: numero(leer(fila, 'SucursalAsociada')) || 0,
    depositoAsociado: numero(leer(fila, 'DepositoAsociado')) || 0,
    ubicacionAsociada: numero(leer(fila, 'UbicacionAsociada')) || 0,
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
  return { idProvincia, nombre: texto(leer(fila, 'NombreProvincia')) || idProvincia };
}

// Parametros(IdParametro, ValorParametro): confirmado. IdParametro y defaults confirmados (R.Publicos.cs L973-983,
// L2326, L2774), en constantes.js.
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
    categoriaFiscalEmpresa: entero(P.CATEGORIA_FISCAL_EMPRESA, D.categoriaFiscalEmpresa),
    decimalesTotal: entero(P.DECIMALES_TOTAL, D.decimalesTotal),
    decimalesPrecio: entero(P.DECIMALES_PRECIO, D.decimalesPrecio),
    pasajeIncluyeImpuestos: pasaje === undefined ? D.pasajeIncluyeImpuestos : bool(pasaje),
  };
}

// Consulta que tiene que usar repo.js (Task 8) para la categoría fiscal de un proveedor (@idCategoriaFiscal) o de la
// empresa. Réplica de S.CategoriasFiscales.cs SelectTexto (L86-109); la categoría de la empresa sale de
// Parametros.CATEGORIAFISCALEMPRESA. SiGA hace CROSS JOIN con esa fila: sin ella no devuelve nada, así que repo.js
// corta con error (el default 2 de mapearParametros no aplica acá).
const SQL_CATEGORIA_FISCAL = `SELECT CF.IdCategoriaFiscal, CF.NombreCategoriaFiscal, CF.UtilizaImpuestos,
       CFC.LetraFiscalCompra, ISNULL(CFC.IvaDiscriminado, 0) IvaDiscriminado
  FROM CategoriasFiscales CF
  LEFT JOIN CategoriasFiscalesConfiguraciones CFC
    ON CFC.IdCategoriaFiscalCliente = CF.IdCategoriaFiscal AND CFC.IdCategoriaFiscalEmpresa = @categoriaFiscalEmpresa
 WHERE CF.IdCategoriaFiscal = @idCategoriaFiscal`;

module.exports = {
  SQL_CATEGORIA_FISCAL,
  mapearProveedor, mapearCategoriaFiscal, mapearTipoComprobante, mapearFormaPago, mapearProducto,
  mapearUbicacion, mapearTipoMovimiento, mapearProvincia, mapearParametros,
};
