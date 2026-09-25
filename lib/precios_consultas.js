'use strict';
// Consultas SIGA compartidas por los routers de Precios (Almacén/Fraccionado en rutas_precios.js,
// Producción en rutas_precios_produccion.js): un solo criterio de "costo" y de "precio vigente".
// Recibe `query` y LISTA_PRECIOS_VENTA por deps, igual que los routers.

// Costo de sistema (sucursal central) + última compra neta de un producto `p`.
const SQL_COSTOS_PRODUCTO = `
      LEFT JOIN ProductosSucursales ps ON ps.IdProducto = p.IdProducto
        AND ps.IdSucursal = (SELECT MIN(IdSucursal) FROM Sucursales WHERE SoyLaCentral = 1)
      OUTER APPLY (
        SELECT TOP 1 CAST(pp.UltimoPrecioCompra AS FLOAT) AS Precio,
          pv.NombreProveedor AS Proveedor, pp.UltimaFechaCompra AS FechaCompra
        FROM ProductosProveedores pp
        LEFT JOIN Proveedores pv ON pv.IdProveedor = pp.IdProveedor
        WHERE pp.IdProducto = p.IdProducto AND pp.UltimaFechaCompra IS NOT NULL AND pp.UltimoPrecioCompra > 0
        ORDER BY pp.UltimaFechaCompra DESC
      ) uc`;

// Precio vigente de mostrador (sucursal central, lista de venta). Precedente verificado:
// rutas_precios_historico.js:63-66 (mismo patrón SUCURSAL_PRECIOS_HIST=1).
const SUCURSAL_PRECIOS_ALMACEN = 1;

// IdProducto aceptado para interpolar en un IN (varchar en SIGA: puede no ser numérico).
const ID_SQL_RE = /^[\w-]{1,30}$/;

function crearConsultasPrecios({ query, LISTA_PRECIOS_VENTA }) {
  // Productos con sus dos costos posibles:
  // - CostoSistema: ProductosSucursales.PrecioCosto de SIGA (fuente por defecto). Trae el IVA
  //   de compra adentro, así que se usa sin IVA (costoSistemaSinIva, con Productos.Alicuota)
  //   — si no, costearAlmacen volvería a sumar IVA y daría doble IVA.
  // - CostoCompra: última compra NETA (UltimoPrecioCompra del proveedor con compra más
  //   reciente, mismo origen que ultimoProveedorPorProducto en rutas_precios_proveedores.js),
  //   elegible por producto (fuenteCosto[plu] = 'ultimaCompra').
  // `filtroSql` es siempre una constante del router o un IN de ids ya validados, nunca input crudo.
  async function productosConCostos(filtroSql) {
    const rows = await query(`
      SELECT p.IdProducto, p.NombreProducto, uc.Precio AS CostoCompra, uc.Proveedor,
        CAST(ps.PrecioCosto AS FLOAT) AS CostoSistema, CAST(p.Alicuota AS FLOAT) AS IvaCompraPct,
        CONVERT(varchar(10), uc.FechaCompra, 23) AS FechaCompraTxt, r.NombreRubro AS Rubro,
        -- "Ingreso hoy" = el producto está en un comprobante de compra CARGADO hoy en SIGA
        -- (Compras.FechaActualizacion), no con fecha de factura de hoy: una factura del 15/9
        -- ingresada hoy tiene Fecha=15/9 y FechaActualizacion=hoy. Mismo join que rutas_compras.js.
        CASE WHEN EXISTS (
          SELECT 1 FROM ComprasProductos cp
          JOIN Compras c ON c.IdSucursal=cp.IdSucursal AND c.IdTipoComprobante=cp.IdTipoComprobante
            AND c.Letra=cp.Letra AND c.CentroEmisor=cp.CentroEmisor AND c.NumeroComprobante=cp.NumeroComprobante
            AND c.IdProveedor=cp.IdProveedor
          WHERE cp.IdProducto = p.IdProducto AND c.FechaActualizacion >= CAST(GETDATE() AS date)
        ) THEN 1 ELSE 0 END AS IngresoHoy
      FROM Productos p
      LEFT JOIN Rubros r ON r.IdRubro = p.IdRubro
      ${SQL_COSTOS_PRODUCTO}
      -- IvaCompraPct = Productos.Alicuota: el propio campo de IVA del producto en SIGA (el que
      -- SIGA usa para su "costo sin IVA"). Null → costoSistemaSinIva asume 21% y marca ivaSupuesto.
      WHERE ${filtroSql}`);
    return rows.map(filaCostos);
  }

  // Costos de un conjunto de PLUs (Map plu → fila de productosConCostos). Los ids se filtran por
  // formato antes de interpolarlos. IdProducto es varchar (hay códigos no numéricos): con un IN de
  // ints SQL Server convierte toda la columna a int y revienta. Van como strings, igual que en rutas_compras.js.
  async function costosPorPlu(plus) {
    const ids = [...new Set((plus || []).map(String).filter(id => ID_SQL_RE.test(id)))];
    if (!ids.length) return new Map();
    const rows = await productosConCostos(`p.IdProducto IN (${ids.map(id => `'${id}'`).join(',')})`);
    return new Map(rows.map(r => [r.plu, r]));
  }

  async function preciosVigentesAlmacen() {
    const rows = await query(`
      SELECT IdProducto, CAST(PrecioVenta AS FLOAT) AS Precio
      FROM ProductosSucursalesPrecios
      WHERE IdSucursal = ${SUCURSAL_PRECIOS_ALMACEN} AND IdListaPrecios = ${LISTA_PRECIOS_VENTA}`);
    return new Map(rows.map(r => [String(r.IdProducto), r.Precio != null ? +r.Precio : null]));
  }

  return { productosConCostos, costosPorPlu, preciosVigentesAlmacen };
}

function filaCostos(r) {
  // Costo de sistema SIGA (fuente por defecto): se usa SIN IVA.
  const sis = costoSistemaSinIva(r.CostoSistema, r.IvaCompraPct);
  return {
    plu: String(r.IdProducto), nombre: String(r.NombreProducto || '').trim(), rubro: r.Rubro || null,
    costoMercaderia: r.CostoCompra != null ? +r.CostoCompra : null,
    costoSistema: sis.costo,
    costoSistemaConIva: r.CostoSistema != null && +r.CostoSistema > 0 ? +r.CostoSistema : null,
    ivaCompraPct: sis.ivaPct, ivaCompraSupuesto: sis.ivaSupuesto,
    proveedor: r.Proveedor || null, fechaUltimaCompra: r.FechaCompraTxt || null,
    ingresoHoy: r.IngresoHoy === 1,
  };
}

// ProductosSucursales.PrecioCosto viene con el IVA de compra adentro. Se saca con la alícuota
// del producto en SIGA (Productos.Alicuota — el mismo campo que usa SIGA para su "costo sin
// IVA"). Si el producto no tiene alícuota cargada se asume 21% y se marca ivaSupuesto para
// que la UI lo avise.
const IVA_COMPRA_SUPUESTO = 21;
function costoSistemaSinIva(precioCostoConIva, ivaCompraPct) {
  const bruto = Number(precioCostoConIva);
  const conocido = ivaCompraPct != null && Number.isFinite(Number(ivaCompraPct));
  const ivaPct = conocido ? Number(ivaCompraPct) : IVA_COMPRA_SUPUESTO;
  if (precioCostoConIva == null || !Number.isFinite(bruto) || bruto <= 0) {
    return { costo: null, ivaPct, ivaSupuesto: !conocido };
  }
  return { costo: Math.round((bruto / (1 + ivaPct / 100)) * 100) / 100, ivaPct, ivaSupuesto: !conocido };
}

module.exports = { crearConsultasPrecios, costoSistemaSinIva };
