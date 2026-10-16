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

// DOC Parte I §7 #20. SIGA-INFERIDO: CuentasCorrientesProv.Existe(0, …) con las mismas claves, cualquier sucursal.
const sqlDuplicadoCtaCte = lock => `SELECT TOP 1 IdSucursal FROM CuentasCorrientesProv ${lock}
     WHERE IdProveedor = @idProveedor AND IdTipoComprobante = @idTipoComprobante AND Letra = @letra
       AND CentroEmisor = @centroEmisor AND NumeroComprobante = @numeroComprobante`;

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

module.exports = { LOCK, sqlDuplicadoCompras, sqlDuplicadoCtaCte, conParametros };
