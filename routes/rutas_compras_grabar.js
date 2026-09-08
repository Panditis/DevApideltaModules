'use strict';
const express = require('express');
const comprasGrabar = require('../lib/compras_grabar');

// ── Grabación real de compras en SIGA ────────────────────────────────────────
// Escribe el comprobante completo (Compras/ComprasProductos/ComprasImpuestos +
// el movimiento de stock que genera + cuenta corriente del proveedor) en una sola
// transacción, replicando lo que hace SIGA internamente al cargar una compra a
// mano (función MovimientosDeComprasV2). Mapeo de las 14 escrituras, relevado por
// diff de snapshots contra una carga manual real: docs/compras_siga_mapeo.md
//
// Los cálculos puros (qué IdFormasPago corresponde, cómo se arma cada fila) están
// en lib/compras_grabar.js y tienen sus tests en test/compras_grabar.test.js. Acá
// sólo queda la ejecución SQL, en el mismo estilo que registrarMovimientoStock
// (routes/rutas_stock.js): un sql.Request(tx) por query, commit/rollback en catch.
//
// No se toca armarVistaCompra/resolverProductosCompra/calcularTotales: llegan por
// deps desde rutas_compras.js (ver server.js) y se vuelven a correr acá server-side
// antes de grabar, para no confiar en lo que mandó el navegador.
// RubrosCompras.IdRubro=1 es "Mercaderias de Reventa" (tabla RubrosCompras, distinta
// de Rubros/RubrosCompras... ojo, no confundir con Productos.IdRubro, que es otro
// campo sin relación). Se elige fijo porque este importador SOLO carga líneas que ya
// pasaron por resolverProductosCompra — siempre son productos reales, nunca un
// gasto/servicio — así que "Mercaderías de Reventa" es la categoría correcta por
// definición del alcance de este flujo, no una suposición. El único comprobante real
// relevado (pruebas_compras/analisis1.txt) trae IdRubro=3 ("Servicios prestados por
// Terceros"), pero esa compra puntual también tiene PorcentajeIVA=21 en la cabecera
// pese a ser una operación con IVA 0% — son valores que arrastró el formulario de
// SIGA de una carga anterior, no la clasificación correcta para ese producto
// (Tutuca Maíz, claramente mercadería). No se sigue ese ejemplo por esta razón.
const ID_RUBRO_MERCADERIAS = 1;
const ID_FUNCION_COMPRAS = 'MovimientosDeComprasV2';
const ID_EMPRESA = 1;

module.exports = function crearRutasComprasGrabar(deps) {
  // resolverProductosCompra no se usa acá directo: ya la corre armarVistaCompra por
  // dentro. Sigue llegando por deps (server.js) porque server.js se la pasa a los dos
  // routers hermanos por igual; no hace falta destructurarla si no se usa.
  const { apiRoute, getPool, sql, comprasImport, armarVistaCompra, usuarioCompras } = deps;
  const router = express.Router();

  // ── Paso 1/2: duplicado (manual) o número definitivo (automático), con lock ──
  async function chequearDuplicado(rq, cab) {
    const r = await rq()
      .input('suc', sql.Int, cab.IdSucursal).input('tipo', sql.VarChar, cab.TipoComprobante)
      .input('letra', sql.VarChar, cab.Letra).input('emisor', sql.Int, cab.PuntoVenta)
      .input('nro', sql.Int, cab.NumeroComprobante)
      .query(`SELECT 1 AS x FROM Compras WITH (UPDLOCK, HOLDLOCK)
              WHERE IdSucursal=@suc AND IdTipoComprobante=@tipo AND Letra=@letra
                AND CentroEmisor=@emisor AND NumeroComprobante=@nro`);
    if (r.recordset.length) throw new Error('Ese comprobante ya está cargado en SIGA.');
  }

  async function asignarNumeroComprobante(rq, cab) {
    const r = await rq()
      .input('suc', sql.Int, cab.IdSucursal).input('tipo', sql.VarChar, cab.TipoComprobante)
      .input('letra', sql.VarChar, cab.Letra).input('emisor', sql.Int, cab.PuntoVenta)
      .query(`SELECT ISNULL(MAX(NumeroComprobante),0)+1 AS siguiente FROM Compras WITH (UPDLOCK, HOLDLOCK)
              WHERE IdSucursal=@suc AND IdTipoComprobante=@tipo AND Letra=@letra AND CentroEmisor=@emisor`);
    return r.recordset[0].siguiente;
  }

  // SIGA no tiene una tabla de cotización del dólar: el valor que graba cada
  // comprobante es "lo último que se usó" (todas las compras recientes reales
  // traen el mismo número, ver pruebas_compras/analisis1.txt). Se replica ese
  // criterio en vez de un 1 fijo, que sería un dato falso en una tabla financiera.
  async function cotizacionDolarActual(rq) {
    const r = await rq().query(
      'SELECT TOP 1 CotizacionDolar FROM Compras WHERE CotizacionDolar IS NOT NULL ORDER BY Fecha DESC');
    return r.recordset[0] ? r.recordset[0].CotizacionDolar : 1;
  }

  // ── Paso 3: Compras (cabecera) ───────────────────────────────────────────────
  async function insertCompra(rq, cab, proveedor, totales, usuario, idComprador, formaPago, cotizacion) {
    await rq()
      .input('suc', sql.Int, cab.IdSucursal).input('tipo', sql.VarChar, cab.TipoComprobante)
      .input('letra', sql.VarChar, cab.Letra).input('emisor', sql.Int, cab.PuntoVenta)
      .input('nro', sql.Int, cab.NumeroComprobante).input('fecha', sql.VarChar(10), cab.FechaComprobante)
      .input('total', sql.Decimal(18, 4), totales.total)
      .input('bruto', sql.Decimal(18, 4), comprasGrabar.totalBruto(totales))
      .input('neto', sql.Decimal(18, 4), totales.neto)
      .input('iva', sql.Decimal(18, 4), totales.totalIVA)
      .input('percep', sql.Decimal(18, 4), totales.totalPercepciones)
      .input('idProveedor', sql.Int, cab.IdProveedor)
      .input('nombreProveedor', sql.NVarChar, proveedor.NombreProveedor)
      .input('cuit', sql.VarChar, proveedor.CuitProveedor)
      .input('catFiscal', sql.Int, proveedor.IdCategoriaFiscal)
      .input('formaPago', sql.Int, formaPago)
      .input('periodo', sql.Int, comprasGrabar.periodoFiscal(cab.FechaComprobante))
      .input('usuario', sql.NVarChar, usuario)
      .input('comprador', sql.Int, idComprador)
      .input('observacion', sql.NVarChar, cab.Observacion || '')
      .input('percIVA', sql.Decimal(18, 4), cab.PercepcionIVA || 0)
      .input('percIB', sql.Decimal(18, 4), cab.PercepcionIIBB || 0)
      .input('percGan', sql.Decimal(18, 4), cab.PercepcionGanancias || 0)
      .input('percVar', sql.Decimal(18, 4), cab.PercepcionVarias || 0)
      .input('impInternos', sql.Decimal(18, 4), cab.ImpuestosInternos || 0)
      .input('cotizacion', sql.Decimal(18, 4), cotizacion)
      .query(`INSERT INTO Compras
        (IdSucursal, IdTipoComprobante, Letra, CentroEmisor, NumeroComprobante, Fecha,
         ImporteTotal, TotalBruto, TotalNeto, TotalIVA, TotalPercepciones,
         IdProveedor, NombreProveedor, CuitProveedor, IdCategoriaFiscal, IdFormasPago, IdRubro,
         PeriodoFiscal, Usuario, FechaActualizacion, MetodoGrabacion, IdFuncion, CotizacionDolar,
         IdEmpresa, IdComprador, Observacion, PercepcionIVA, PercepcionIB, PercepcionGanancias,
         PercepcionVarias, ImpuestosInternos)
        VALUES
        (@suc, @tipo, @letra, @emisor, @nro, @fecha,
         @total, @bruto, @neto, @iva, @percep,
         @idProveedor, @nombreProveedor, @cuit, @catFiscal, @formaPago, ${ID_RUBRO_MERCADERIAS},
         @periodo, @usuario, GETDATE(), 'M', '${ID_FUNCION_COMPRAS}', @cotizacion,
         ${ID_EMPRESA}, @comprador, @observacion, @percIVA, @percIB, @percGan,
         @percVar, @impInternos)`);
  }

  // ── Paso 4: ComprasProductos (una fila por línea) ────────────────────────────
  async function insertComprasProducto(rq, cab, l, proporcionalImp) {
    await rq()
      .input('suc', sql.Int, cab.IdSucursal).input('tipo', sql.VarChar, cab.TipoComprobante)
      .input('letra', sql.VarChar, cab.Letra).input('emisor', sql.Int, cab.PuntoVenta)
      .input('nro', sql.Int, cab.NumeroComprobante).input('producto', sql.VarChar, l.idProducto)
      .input('cantidad', sql.Decimal(18, 4), l.cantidad).input('precio', sql.Decimal(18, 4), l.precio)
      .input('importeTotal', sql.Decimal(18, 4), l.importeTotal)
      .input('precioNeto', sql.Decimal(18, 4), l.precioNeto)
      .input('importeTotalNeto', sql.Decimal(18, 4), l.importeTotalNeto)
      .input('porcIVA', sql.Decimal(18, 4), l.porcentajeIVA).input('iva', sql.Decimal(18, 4), l.iva)
      .input('orden', sql.Int, l.orden).input('nombreProducto', sql.NVarChar, l.nombreProducto)
      .input('idProveedor', sql.Int, cab.IdProveedor)
      .input('proporcional', sql.Decimal(18, 4), proporcionalImp)
      .input('deposito', sql.Int, cab.IdDeposito).input('ubicacion', sql.Int, cab.IdUbicacion)
      .query(`INSERT INTO ComprasProductos
        (IdSucursal, IdTipoComprobante, Letra, CentroEmisor, NumeroComprobante, IdProducto,
         Cantidad, Precio, ImporteTotal, PrecioNeto, ImporteTotalNeto, PorcentajeIVA, IVA,
         Orden, NombreProducto, IdProveedor, MontoSaldo, ProporcionalImp, IdDeposito, IdUbicacion,
         CantidadUMCompra, FactorConversionCompra, PrecioPorUMCompra, IdUnidadDeMedida, IdUnidadDeMedidaCompra)
        VALUES
        (@suc, @tipo, @letra, @emisor, @nro, @producto,
         @cantidad, @precio, @importeTotal, @precioNeto, @importeTotalNeto, @porcIVA, @iva,
         @orden, @nombreProducto, @idProveedor, @importeTotal, @proporcional, @deposito, @ubicacion,
         @cantidad, 1, @precio, 'UN', 'UN')`);
    // ponytail: IdUnidadDeMedida/IdUnidadDeMedidaCompra fijos en 'UN' — el único caso
    // relevado (pruebas_compras/analisis2.txt), incluso para un producto a granel,
    // usó 'UN'. La app no consulta Productos.IdUnidadDeMedida en ningún otro punto
    // (ver comentario en rutas_compras.js), así que no hay otra fuente. Si algún
    // producto necesita otra unidad de compra, esto hay que revisarlo con un caso real.
  }

  // ── Paso 5: ComprasImpuestos (una fila por alícuota/percepción) ──────────────
  async function insertComprasImpuesto(rq, cab, fila) {
    await rq()
      .input('suc', sql.Int, cab.IdSucursal).input('tipo', sql.VarChar, cab.TipoComprobante)
      .input('letra', sql.VarChar, cab.Letra).input('emisor', sql.Int, cab.PuntoVenta)
      .input('nro', sql.Int, cab.NumeroComprobante).input('idProveedor', sql.Int, cab.IdProveedor)
      .input('orden', sql.Int, fila.orden).input('idTipoImpuesto', sql.VarChar, fila.idTipoImpuesto)
      .input('filaEmisor', sql.Int, fila.emisor).input('filaNumero', sql.Int, fila.numero)
      .input('base', sql.Decimal(18, 4), fila.baseImponible).input('alicuota', sql.Decimal(18, 4), fila.alicuota)
      .input('importe', sql.Decimal(18, 4), fila.importe).input('bruto', sql.Decimal(18, 4), fila.bruto)
      .query(`INSERT INTO ComprasImpuestos
        (IdSucursal, IdTipoComprobante, Letra, CentroEmisor, NumeroComprobante, IdProveedor,
         Orden, IdTipoImpuesto, Emisor, Numero, BaseImponible, Alicuota, Importe, Bruto)
        VALUES (@suc, @tipo, @letra, @emisor, @nro, @idProveedor,
         @orden, @idTipoImpuesto, @filaEmisor, @filaNumero, @base, @alicuota, @importe, @bruto)`);
  }

  // ── Paso 6: número de movimiento de stock (mismo patrón atómico que
  // registrarMovimientoStock, con alta de la fila en MovimientosNumeros si es la
  // primera COMPRA de la sucursal — igual que se vio para Rosario) ────────────
  async function siguienteNumeroMovimientoStock(rq, idSucursal) {
    const r = await rq()
      .input('suc', sql.Int, idSucursal)
      .query(`IF EXISTS (SELECT 1 FROM MovimientosNumeros WITH (UPDLOCK, HOLDLOCK) WHERE IdSucursal=@suc AND IdTipoMovimiento='COMPRA')
                UPDATE MovimientosNumeros SET Numero = Numero + 1
                OUTPUT inserted.Numero AS Numero
                WHERE IdSucursal=@suc AND IdTipoMovimiento='COMPRA';
              ELSE
                INSERT INTO MovimientosNumeros (IdSucursal, IdTipoMovimiento, Numero)
                OUTPUT inserted.Numero AS Numero
                VALUES (@suc, 'COMPRA', 1);`);
    return r.recordset[0].Numero;
  }

  // ── Paso 7: MovimientosStock ──────────────────────────────────────────────────
  // Neto/PorcentajeIVA/TotalImpuestos/Percepcion*/ImpuestosInternos van en 0: así
  // quedaron en el relevamiento real (analisis1.txt) — el detalle impositivo vive
  // en Compras/ComprasProductos, acá sólo importa el link al comprobante y el total.
  async function insertMovimientoStock(rq, cab, proveedor, totales, numeroMovimiento, usuario) {
    await rq()
      .input('suc', sql.Int, cab.IdSucursal).input('numero', sql.Int, numeroMovimiento)
      .input('fecha', sql.VarChar(10), cab.FechaComprobante).input('total', sql.Decimal(18, 4), totales.total)
      .input('catFiscal', sql.Int, proveedor.IdCategoriaFiscal).input('tipo', sql.VarChar, cab.TipoComprobante)
      .input('letra', sql.VarChar, cab.Letra).input('emisor', sql.Int, cab.PuntoVenta)
      .input('nro', sql.Int, cab.NumeroComprobante).input('usuario', sql.NVarChar, usuario)
      .input('idProveedor', sql.Int, cab.IdProveedor)
      .query(`INSERT INTO MovimientosStock
        (IdSucursal, IdTipoMovimiento, NumeroMovimiento, FechaMovimiento, Neto, Total, PorcentajeIVA,
         IdCategoriaFiscal, IdTipoComprobante, Letra, CentroEmisor, NumeroComprobante, Usuario,
         TotalImpuestos, PercepcionIVA, PercepcionIB, PercepcionGanancias, PercepcionVarias,
         IdProveedor, ImpuestosInternos)
        VALUES (@suc, 'COMPRA', @numero, @fecha, 0, @total, 0,
         @catFiscal, @tipo, @letra, @emisor, @nro, @usuario,
         0, 0, 0, 0, 0, @idProveedor, 0)`);
  }

  // ── Paso 8: MovimientosStockProductos ────────────────────────────────────────
  async function insertMovimientoStockProducto(rq, cab, numeroMovimiento, l) {
    await rq()
      .input('suc', sql.Int, cab.IdSucursal).input('deposito', sql.Int, cab.IdDeposito)
      .input('ubicacion', sql.Int, cab.IdUbicacion).input('numero', sql.Int, numeroMovimiento)
      .input('producto', sql.VarChar, l.idProducto).input('cantidad', sql.Decimal(18, 4), l.cantidad)
      .input('precio', sql.Decimal(18, 4), l.precio).input('orden', sql.Int, l.orden)
      .query(`INSERT INTO MovimientosStockProductos
        (IdSucursal, IdDeposito, IdUbicacion, IdTipoMovimiento, NumeroMovimiento, IdProducto, Cantidad, Cantidad2, Precio, Orden)
        VALUES (@suc, @deposito, @ubicacion, 'COMPRA', @numero, @producto, @cantidad, 0, @precio, @orden)`);
  }

  // ── Pasos 9-10: stock por depósito y por ubicación — mismo patrón IF EXISTS
  // ...ELSE INSERT que registrarMovimientoStock (routes/rutas_stock.js). Una compra
  // siempre suma stock: no hace falta el coeficiente de TiposMovimientos. ─────────
  async function actualizarStockDeposito(rq, cab, l) {
    await rq()
      .input('sucursal', sql.Int, cab.IdSucursal).input('deposito', sql.Int, cab.IdDeposito)
      .input('producto', sql.VarChar, l.idProducto).input('delta', sql.Decimal(18, 4), l.cantidad)
      .query(`IF EXISTS (SELECT 1 FROM ProductosDepositos WHERE IdProducto=@producto AND IdSucursal=@sucursal AND IdDeposito=@deposito)
                UPDATE ProductosDepositos SET Stock = Stock + @delta
                WHERE IdProducto=@producto AND IdSucursal=@sucursal AND IdDeposito=@deposito;
              ELSE
                INSERT INTO ProductosDepositos (IdProducto, IdSucursal, IdDeposito, Stock, Stock2)
                VALUES (@producto, @sucursal, @deposito, @delta, 0);`);
  }

  async function actualizarStockUbicacion(rq, cab, l) {
    await rq()
      .input('sucursal', sql.Int, cab.IdSucursal).input('deposito', sql.Int, cab.IdDeposito)
      .input('ubicacion', sql.Int, cab.IdUbicacion).input('producto', sql.VarChar, l.idProducto)
      .input('delta', sql.Decimal(18, 4), l.cantidad)
      .query(`IF EXISTS (SELECT 1 FROM ProductosUbicaciones WHERE IdProducto=@producto AND IdSucursal=@sucursal AND IdDeposito=@deposito AND IdUbicacion=@ubicacion)
                UPDATE ProductosUbicaciones SET Stock = Stock + @delta
                WHERE IdProducto=@producto AND IdSucursal=@sucursal AND IdDeposito=@deposito AND IdUbicacion=@ubicacion;
              ELSE
                INSERT INTO ProductosUbicaciones (IdProducto, IdSucursal, IdDeposito, IdUbicacion, Stock, Stock2)
                VALUES (@producto, @sucursal, @deposito, @ubicacion, @delta, 0);`);
  }

  // ── Paso 11: stock por sucursal, agregado por producto. Sin trigger — lo
  // mantiene la app (docs/compras_siga_mapeo.md). Si la fila no existe, es un
  // estado inconsistente real (todo producto de compras debería tenerla ya): se
  // corta la transacción en vez de seguir con un UPDATE que no tocó nada. ────────
  async function actualizarStockSucursal(rq, idSucursal, idProducto, cantidad) {
    const r = await rq()
      .input('sucursal', sql.Int, idSucursal).input('producto', sql.VarChar, idProducto)
      .input('delta', sql.Decimal(18, 4), cantidad)
      .query(`UPDATE ProductosSucursales SET Stock = Stock + @delta WHERE IdProducto=@producto AND IdSucursal=@sucursal`);
    if (!r.rowsAffected[0]) throw new Error(`ProductosSucursales no tiene fila para el producto ${idProducto} en la sucursal ${idSucursal}.`);
  }

  // ── Pasos 12-13: cuenta corriente del proveedor. Fecha = GETDATE() (grabación
  // real), no la del comprobante — así lo muestra el relevamiento. ────────────────
  async function insertCuentaCorrienteProv(rq, cab, totales, formaPago, usuario, cotizacion) {
    await rq()
      .input('suc', sql.Int, cab.IdSucursal).input('tipo', sql.VarChar, cab.TipoComprobante)
      .input('letra', sql.VarChar, cab.Letra).input('emisor', sql.Int, cab.PuntoVenta)
      .input('nro', sql.Int, cab.NumeroComprobante)
      .input('vencimiento', sql.VarChar(10), cab.FechaVencimiento || cab.FechaComprobante)
      .input('total', sql.Decimal(18, 4), totales.total).input('formaPago', sql.Int, formaPago)
      .input('observacion', sql.NVarChar, cab.Observacion || '').input('usuario', sql.NVarChar, usuario)
      .input('idProveedor', sql.Int, cab.IdProveedor)
      .input('cotizacion', sql.Decimal(18, 4), cotizacion)
      .query(`INSERT INTO CuentasCorrientesProv
        (IdSucursal, IdTipoComprobante, Letra, CentroEmisor, NumeroComprobante, Fecha, FechaVencimiento,
         ImporteTotal, IdFormasPago, Observacion, Saldo, CantidadCuotas,
         ImportePesos, ImporteDolares, ImporteEuros, ImporteCheques, ImporteTransfBancaria, ImporteTickets,
         ImporteRetenciones, ImporteTarjetas, IdEstadoComprobante, IdUsuario, IdProveedor,
         FechaActualizacion, MetodoGrabacion, IdFuncion, CotizacionDolar, RefProveedor, PromedioDiasPago)
        VALUES (@suc, @tipo, @letra, @emisor, @nro, GETDATE(), @vencimiento,
         @total, @formaPago, @observacion, @total, 1,
         0, 0, 0, 0, 0, 0,
         0, 0, 'NORMAL', @usuario, @idProveedor,
         GETDATE(), 'M', '${ID_FUNCION_COMPRAS}', @cotizacion, '', 0)`);
  }

  // v1: una sola cuota (decisión ya tomada, ver docs/compras_siga_mapeo.md #11).
  async function insertCuentaCorrienteProvPago(rq, cab, totales, formaPago) {
    await rq()
      .input('suc', sql.Int, cab.IdSucursal).input('tipo', sql.VarChar, cab.TipoComprobante)
      .input('letra', sql.VarChar, cab.Letra).input('emisor', sql.Int, cab.PuntoVenta)
      .input('nro', sql.Int, cab.NumeroComprobante)
      .input('vencimiento', sql.VarChar(10), cab.FechaVencimiento || cab.FechaComprobante)
      .input('total', sql.Decimal(18, 4), totales.total).input('formaPago', sql.Int, formaPago)
      .input('observacion', sql.NVarChar, cab.Observacion || '').input('idProveedor', sql.Int, cab.IdProveedor)
      .query(`INSERT INTO CuentasCorrientesProvPagos
        (IdSucursal, IdTipoComprobante, Letra, CentroEmisor, NumeroComprobante, CuotaNumero, Fecha, FechaVencimiento,
         ImporteCuota, SaldoCuota, IdFormasPago, Observacion,
         IdTipoComprobante2, NumeroComprobante2, CentroEmisor2, CuotaNumero2, Letra2, IdProveedor,
         DescuentoRecargo, DescuentoRecargoPorc)
        VALUES (@suc, @tipo, @letra, @emisor, @nro, 1, GETDATE(), @vencimiento,
         @total, @total, @formaPago, @observacion,
         @tipo, @nro, @emisor, 1, @letra, @idProveedor, 0, 0)`);
  }

  // ── Paso 14: ProductosProveedores (upsert por línea) ──────────────────────────
  // UltimoPrecioFabrica: el mapeo no aclara de dónde sale (docs/compras_siga_mapeo.md
  // #12) — se deja sin tocar si la fila ya existe (no entra en el UPDATE) y NULL si
  // es alta nueva. CodigoProductoProveedor sólo se pisa si la línea lo trae.
  async function upsertProductoProveedor(rq, idProveedor, fechaCompra, l) {
    await rq()
      .input('producto', sql.VarChar, l.idProducto).input('proveedor', sql.Int, idProveedor)
      .input('codigo', sql.VarChar, l.codigoProveedor).input('precio', sql.Decimal(18, 4), l.precio)
      .input('fecha', sql.VarChar(10), fechaCompra)
      .query(`IF EXISTS (SELECT 1 FROM ProductosProveedores WHERE IdProducto=@producto AND IdProveedor=@proveedor)
                UPDATE ProductosProveedores
                   SET UltimoPrecioCompra=@precio, UltimaFechaCompra=@fecha,
                       CodigoProductoProveedor = ISNULL(@codigo, CodigoProductoProveedor)
                 WHERE IdProducto=@producto AND IdProveedor=@proveedor;
              ELSE
                INSERT INTO ProductosProveedores
                  (IdProducto, IdProveedor, CodigoProductoProveedor, UltimoPrecioCompra, UltimaFechaCompra, UltimoPrecioFabrica,
                   DescuentoRecargoPorc1, DescuentoRecargoPorc2, DescuentoRecargoPorc3, DescuentoRecargoPorc4, DescuentoRecargoPorc5, DescuentoRecargoPorc6)
                VALUES (@producto, @proveedor, @codigo, @precio, @fecha, NULL, 0, 0, 0, 0, 0, 0);`);
  }

  // ── La transacción completa ───────────────────────────────────────────────────
  async function grabarCompraEnSiga(pool, vista, { usuario, idEmpleadoComprador = 1 } = {}) {
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const rq = () => new sql.Request(tx);
      const cabOriginal = vista.cabecera;

      // 1-2. Duplicado (manual) o número definitivo (automático), con lock — el
      // número que trae el preview es provisorio, nunca se reusa a ciegas.
      let numeroFinal = cabOriginal.NumeroComprobante;
      if (cabOriginal.numeroAutomatico) {
        numeroFinal = await asignarNumeroComprobante(rq, cabOriginal);
      } else {
        await chequearDuplicado(rq, cabOriginal);
      }
      const cab = { ...cabOriginal, NumeroComprobante: numeroFinal };

      const lineasCalc = vista.lineas.map(comprasGrabar.calcularLinea);
      const proporcional = comprasGrabar.prorratearPercepciones(lineasCalc, vista.totales.neto, vista.totales.totalPercepciones);
      const formaPago = comprasGrabar.idFormasPago(cab);
      const cotizacion = await cotizacionDolarActual(rq);

      // 3. Compras
      await insertCompra(rq, cab, vista.proveedor, vista.totales, usuario, idEmpleadoComprador, formaPago, cotizacion);

      // 4. ComprasProductos
      for (let i = 0; i < lineasCalc.length; i++) await insertComprasProducto(rq, cab, lineasCalc[i], proporcional[i]);

      // 5. ComprasImpuestos — incluso con IVA en 0 (confirmado en el relevamiento)
      let orden = 1;
      for (const impuesto of vista.totales.impuestos) {
        await insertComprasImpuesto(rq, cab, comprasGrabar.filaComprasImpuesto(impuesto, orden, cab));
        orden++;
      }

      // 6. Número de movimiento de stock
      const numeroMovimiento = await siguienteNumeroMovimientoStock(rq, cab.IdSucursal);

      // 7. MovimientosStock
      await insertMovimientoStock(rq, cab, vista.proveedor, vista.totales, numeroMovimiento, usuario);

      // 8. MovimientosStockProductos
      for (const l of lineasCalc) await insertMovimientoStockProducto(rq, cab, numeroMovimiento, l);

      // 9-10. Stock por depósito y por ubicación, línea por línea
      for (const l of lineasCalc) {
        await actualizarStockDeposito(rq, cab, l);
        await actualizarStockUbicacion(rq, cab, l);
      }

      // 11. Stock por sucursal, agregado por producto
      for (const { idProducto, cantidad } of comprasGrabar.agregarCantidadesPorProducto(lineasCalc)) {
        await actualizarStockSucursal(rq, cab.IdSucursal, idProducto, cantidad);
      }

      // 12-13. Cuenta corriente del proveedor
      await insertCuentaCorrienteProv(rq, cab, vista.totales, formaPago, usuario, cotizacion);
      await insertCuentaCorrienteProvPago(rq, cab, vista.totales, formaPago);

      // 14. ProductosProveedores
      for (const l of lineasCalc) await upsertProductoProveedor(rq, cab.IdProveedor, cab.FechaComprobante, l);

      await tx.commit();
      return { numeroComprobante: cab.NumeroComprobante, numeroMovimiento };
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  }

  // Misma reconstrucción de matriz que /api/compras-import/revalidar (rutas_compras.js):
  // se vuelve a parsear y validar todo server-side, nunca se confía en lo que mandó
  // el navegador (valido/totales/estado de línea son fáciles de falsificar y esto
  // escribe plata real).
  const CLAVE_POR_COLUMNA = {
    PLU: 'plu', CodigoProveedor: 'codigoProveedor', CodigoBarras: 'codigoBarras',
    Cantidad: 'cantidad', PrecioUnitario: 'precioUnitario',
    PorcentajeIVA: 'porcentajeIVA', Descripcion: 'descripcion',
  };

  router.post('/api/compras-import/grabar', express.json({ limit: '2mb' }), apiRoute(async (req) => {
    const cabecera = (req.body && req.body.cabecera) || {};
    const lineasBody = Array.isArray(req.body && req.body.lineas) ? req.body.lineas : [];

    const colsCab = comprasImport.CAMPOS_CABECERA.map(c => c.campo);
    const valorCab = c => (cabecera[c] == null ? '' : cabecera[c]);
    const matriz = [[...comprasImport.COLUMNAS_DETALLE, ...colsCab]];
    for (const l of lineasBody) {
      matriz.push([
        ...comprasImport.COLUMNAS_DETALLE.map(c => { const v = l[CLAVE_POR_COLUMNA[c]]; return v == null ? '' : v; }),
        ...colsCab.map(valorCab),
      ]);
    }
    if (!lineasBody.length) matriz.push([...comprasImport.COLUMNAS_DETALLE.map(() => ''), ...colsCab.map(valorCab)]);

    const parsed = comprasImport.parsearCompra({ matriz });
    const vista = await armarVistaCompra(parsed, req.body && req.body.archivo);

    if (!vista.valido || vista.duplicado || vista.lineas.some(l => l.estado !== 'ok')) {
      throw new Error(vista.errores.length ? vista.errores.join(' | ') : 'La compra no pasó la validación.');
    }

    const usuario = usuarioCompras(req);
    const resultado = await grabarCompraEnSiga(await getPool(), vista, { usuario, idEmpleadoComprador: 1 });
    return { ok: true, ...resultado };
  }));

  return router;
};
