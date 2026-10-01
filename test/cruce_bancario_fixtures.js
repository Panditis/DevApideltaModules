'use strict';
// Datos de prueba del cruce bancario: réplica reducida del xls real del banco (mismos
// encabezados; fecha e importe en texto; al pie, una fila en blanco y la tabla de totales).
const ENCABEZADO = ['Origen', 'Fecha', 'Nombre de comercio', 'Nombre de sucursal', 'Usuario', 'Estado',
  'Nombre del cliente', 'E-mail del cliente', 'Marca tarjeta', 'Número tarjeta', 'Método de pago',
  'Moneda', 'Importe', 'Importe propina', 'Impuestos', 'Nº Referencia', 'Nº Autorización',
  'ID Terminal', 'Tipo', 'Lector'];

function filaBanco({ fecha, importe, estado = 'Aprobada', tipo = 'Venta', marca = 'Visa', metodo = marca, auth = '008601', ref = 'ref-1', terminal = '' }) {
  return ['QR', fecha, 'APIDELTA', 'APIDELTA', 'USUARIO', estado, 'CLIENTE', '', marca, '47045500XXXX7770',
    metodo, '032', importe, 0, 0, ref, auth, terminal, tipo, ''];
}

const pie = total => [
  [],
  ['Moneda', 'Total bruto', 'Total anuladas', 'Total propinas', 'Total impuestos', 'Total neto'],
  ['032', total, '', '', '', total],
];

// Fila tal como la devuelve la consulta a SIGA (sqlTickets).
function filaSql({ suc = 1, fecha, importe, numero = '1', tipo = 'FC', letra = 'B', centro = '0001' }) {
  return {
    IdSucursal: suc, NombreSucursal: `SUC ${suc}`, IdTipoComprobante: tipo, Letra: letra,
    CentroEmisor: centro, NumeroComprobante: numero, FechaTxt: fecha, ImporteTotal: importe,
  };
}

module.exports = { ENCABEZADO, filaBanco, pie, filaSql };
