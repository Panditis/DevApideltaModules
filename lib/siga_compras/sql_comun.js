'use strict';
// Piezas de SQL que comparten las lecturas (repo.js) y la grabación (grabar.js). Todo el SQL va con parámetros
// (request.input), nunca concatenado. Fuente: docs/siga_compras_carga_descompilado.md (DOC).

const LOCK = 'WITH (UPDLOCK, HOLDLOCK)';

// DOC Parte I §3.4 / Parte III §6.1: Compras.Existe(idSucursal = 0, …) (Eniac.SqlServer.Compras.cs L365-390):
// mismo proveedor + tipo + letra + emisor + número en CUALQUIER sucursal, (TC.InformaLibroIVA OR misma empresa).
const sqlDuplicadoCompras = lock => `SELECT TOP 1 C.IdSucursal FROM Compras C ${lock}
     INNER JOIN TiposComprobantes TC ON TC.IdTipoComprobante = C.IdTipoComprobante
     INNER JOIN Sucursales S ON S.IdSucursal = C.IdSucursal
     WHERE C.IdTipoComprobante = @idTipoComprobante AND C.Letra = @letra AND C.CentroEmisor = @centroEmisor
       AND C.NumeroComprobante = @numeroComprobante AND C.IdProveedor = @idProveedor
       AND (TC.InformaLibroIVA = 1 OR S.IdEmpresa = @idEmpresa)`;

// DOC Parte I §7 #20: la pantalla llama CuentasCorrientesProv.Existe(0, …) (Win L23004), que con idSucursal = 0 usa
// la empresa del usuario (Eniac.SqlServer.CuentasCorrientesProv.cs L295-330).
// Task 9: al grabar, Reglas.Compras.cs L700 lo llama con IdSucursal > 0 (filtro CCP.IdSucursal = X, sin el filtro
// de empresa).
const sqlDuplicadoCtaCte = lock => `SELECT TOP 1 CCP.IdSucursal FROM CuentasCorrientesProv CCP ${lock}
     INNER JOIN TiposComprobantes TC ON TC.IdTipoComprobante = CCP.IdTipoComprobante
     INNER JOIN Sucursales S ON S.IdSucursal = CCP.IdSucursal
     WHERE CCP.IdSucursal > 0 AND CCP.IdProveedor = @idProveedor AND CCP.IdTipoComprobante = @idTipoComprobante
       AND CCP.Letra = @letra AND CCP.CentroEmisor = @centroEmisor AND CCP.NumeroComprobante = @numeroComprobante
       AND (TC.InformaLibroIVA = 1 OR S.IdEmpresa = @idEmpresa)`;

// DOC Parte I §3.4 / §6.1, paso 2 de Reglas.Compras.Existe (Eniac.Reglas.Compras.cs L1643-1680): VentasNumeros_G1
// (Eniac.SqlServer.VentasNumeros.cs L188-197). Si hay fila, SiGA busca también sin proveedor y en Ventas/Compras de
// los tipos relacionados; la v1 no lo replica y bloquea.
const SQL_VENTAS_NUMEROS_G1 = `SELECT TOP 1 VN.IdTipoComprobante FROM VentasNumeros VN
     WHERE VN.IdEmpresa = @idEmpresa AND VN.IdTipoComprobante = @idTipoComprobante
       AND VN.LetraFiscal = @letra AND VN.CentroEmisor = @centroEmisor`;

// Error de configuración de SIGA (falta un parámetro o una fila que SiGA necesita): la ruta lo muestra tal cual
// en vez de un 500 genérico. Se reconoce por `instanceof ErrorSiga` o por err.code === 'SIGA_CONFIG'.
class ErrorSiga extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = 'ErrorSiga';
    this.code = 'SIGA_CONFIG';
  }
}

// Tipo mssql explícito para cada valor: entero → BigInt, decimal → Decimal(19,6), texto → VarChar del largo justo
// (compara bien contra columnas char/varchar sin conversión implícita de la columna), bool → Bit, null → VarChar(1).
function tipoDe(sql, valor) {
  if (valor === null || valor === undefined) return sql.VarChar(1);
  if (typeof valor === 'boolean') return sql.Bit;
  if (typeof valor === 'number') return Number.isInteger(valor) ? sql.BigInt : sql.Decimal(19, 6);
  return sql.VarChar(Math.max(1, String(valor).length));
}

function conParametros(sql, rq, params) {
  for (const [nombre, valor] of Object.entries(params || {})) rq.input(nombre, tipoDe(sql, valor), valor);
  return rq;
}

module.exports = { LOCK, sqlDuplicadoCompras, sqlDuplicadoCtaCte, SQL_VENTAS_NUMEROS_G1, conParametros, ErrorSiga };
