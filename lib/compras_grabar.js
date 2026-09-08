'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Grabación de una compra en SIGA — cálculos puros, sin SQL ni I/O.
//  Arma a partir de `vista` (la que devuelve armarVistaCompra, routes/rutas_compras.js)
//  los valores que van en cada INSERT/UPDATE de routes/rutas_compras_grabar.js.
//  Mapeo de tablas y columnas: docs/compras_siga_mapeo.md. Los valores que no surgen
//  directo de un campo de `vista` (TotalBruto, Precio bruto por línea, ProporcionalImp)
//  están confirmados contra pruebas_compras/analisis1.txt y analisis2.txt (relevamiento
//  real, no una suposición): TotalBruto = TotalNeto + TotalIVA y ComprasProductos.Precio
//  = PrecioNeto cuando IVA es 0%, lo mismo que se ve en esos snapshots.
// ─────────────────────────────────────────────────────────────────────────────

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const r4 = n => Math.round((n + Number.EPSILON) * 10000) / 10000;

const ID_FORMAS_PAGO_CONTADO = 5;
const ID_FORMAS_PAGO_MENSUAL = 1;

// Regla ya acordada: sin vencimiento (o vencimiento == fecha del comprobante) es
// contado; cualquier otro vencimiento es "Mensual" (que es también el default de
// 30 días que ya aplica parsearCabecera cuando no viene FechaVencimiento explícita).
function idFormasPago(cabecera) {
  if (!cabecera.FechaVencimiento || cabecera.FechaVencimiento === cabecera.FechaComprobante) {
    return ID_FORMAS_PAGO_CONTADO;
  }
  return ID_FORMAS_PAGO_MENSUAL;
}

// AAAAMM a partir de 'AAAA-MM-DD'.
function periodoFiscal(fechaISO) {
  return Number(String(fechaISO).slice(0, 7).replace('-', ''));
}

// TotalBruto de Compras: mismo criterio que ComprasImpuestos.Bruto por fila
// (BaseImponible + Importe), es decir neto + IVA sin percepciones.
function totalBruto(totales) {
  return r2(totales.neto + totales.totalIVA);
}

// Por línea: separa el precio/importe neto (el que ya calculó el parser, sin IVA)
// del bruto que graba SIGA en Precio/ImporteTotal. El PLU resuelto y el nombre
// vienen de resolverProductosCompra (ya corrido por armarVistaCompra).
function calcularLinea(linea) {
  const iva = linea.porcentajeIVA || 0;
  const importeTotalNeto = linea.neto;
  const importeIva = r2(importeTotalNeto * iva / 100);
  const importeTotal = r2(importeTotalNeto + importeIva);
  const precioNeto = linea.precioUnitario;
  const precio = r2(precioNeto * (1 + iva / 100));
  return {
    idProducto: linea.resuelto,
    nombreProducto: linea.nombreSiga,
    codigoProveedor: linea.codigoProveedor || null,
    orden: linea.orden,
    cantidad: linea.cantidad,
    precioNeto, precio,
    importeTotalNeto, importeTotal,
    iva: importeIva, porcentajeIVA: iva,
  };
}

// ProporcionalImp de ComprasProductos: prorratea el total de percepciones entre las
// líneas según su peso en el neto (confirmado por el ejemplo del mapeo: 878,7748 +
// 76,4152 = 955,19). La última línea se lleva el resto exacto, para que la suma dé
// el total real y no quede unos centésimos afuera por el redondeo de las demás.
function prorratearPercepciones(lineasCalc, totalNeto, totalPercepciones) {
  if (!totalPercepciones || !lineasCalc.length || !totalNeto) return lineasCalc.map(() => 0);
  let acumulado = 0;
  return lineasCalc.map((l, i) => {
    if (i === lineasCalc.length - 1) return r4(totalPercepciones - acumulado);
    const parte = r4(totalPercepciones * (l.importeTotalNeto / totalNeto));
    acumulado += parte;
    return parte;
  });
}

// Fila de ComprasImpuestos para una entrada de totales.impuestos (calcularTotales,
// lib/compras_import.js). Bruto = BaseImponible + Importe, confirmado en
// pruebas_compras/analisis2.txt.
function filaComprasImpuesto(impuesto, orden, cabecera) {
  return {
    orden,
    idTipoImpuesto: impuesto.tipo,
    emisor: cabecera.PuntoVenta,
    numero: cabecera.NumeroComprobante,
    baseImponible: impuesto.baseImponible,
    alicuota: impuesto.alicuota,
    importe: impuesto.importe,
    bruto: r2(impuesto.baseImponible + impuesto.importe),
  };
}

// ProductosSucursales (paso 11) es un solo UPDATE por producto: si el parser dejara
// pasar dos líneas del mismo producto, agregar antes evita perder una de las dos.
function agregarCantidadesPorProducto(lineasCalc) {
  const porProducto = new Map();
  for (const l of lineasCalc) porProducto.set(l.idProducto, (porProducto.get(l.idProducto) || 0) + l.cantidad);
  return [...porProducto.entries()].map(([idProducto, cantidad]) => ({ idProducto, cantidad }));
}

module.exports = {
  idFormasPago, periodoFiscal, totalBruto, calcularLinea, prorratearPercepciones,
  filaComprasImpuesto, agregarCantidadesPorProducto,
  ID_FORMAS_PAGO_CONTADO, ID_FORMAS_PAGO_MENSUAL,
};
