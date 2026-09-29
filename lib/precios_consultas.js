'use strict';
// Consultas SIGA compartidas por los routers de Precios (Almacén/Fraccionado en rutas_precios.js,
// Producción en rutas_precios_produccion.js): un solo criterio de "costo" y de "precio vigente".
// Recibe `query` y LISTA_PRECIOS_VENTA por deps, igual que los routers (y los filtros de fórmula
// activa de server.js para los vínculos pack/bulto).
const { armarVinculos } = require('./precios_pack_bulto');

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

function crearConsultasPrecios({ query, LISTA_PRECIOS_VENTA, FORMULA_ACTIVA_SQL, SIN_FORMULA_GENERICO_SQL }) {
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

  // Fecha del último cambio REAL de precio de venta (Map plu → 'YYYY-MM-DD'), misma sucursal/lista que
  // preciosVigentesAlmacen: así la fecha corresponde al precio que se ve. HistorialPrecios registra también
  // cambios de COSTO con el mismo PrecioVenta: cuenta sólo la fila cuyo PrecioVenta difiere del anterior
  // (o la primera). Sin historial → el plu no está en el Map (la UI muestra "—"). Una sola query agregada.
  async function fechasPrecioAlmacen() {
    const rows = await query(`
      SELECT IdProducto, CONVERT(varchar(10), MAX(FechaHora), 23) AS Fecha
      FROM (
        SELECT IdProducto, FechaHora, PrecioVenta,
          LAG(PrecioVenta) OVER (PARTITION BY IdProducto ORDER BY FechaHora, IdHistorialPrecios) AS Anterior
        FROM HistorialPrecios
        WHERE IdSucursal = ${SUCURSAL_PRECIOS_ALMACEN} AND IdListaPrecios = ${LISTA_PRECIOS_VENTA} AND PrecioVenta IS NOT NULL
      ) h
      WHERE Anterior IS NULL OR PrecioVenta <> Anterior
      GROUP BY IdProducto`);
    // trim: mismo criterio que rutas_precios_historico.js para los IdProducto de HistorialPrecios.
    return new Map(rows.map(r => [String(r.IdProducto).trim(), r.Fecha || null]));
  }

  // Pack/bulto: productos activos del rubro 'Almacen Bultos/Cajas' con los componentes de su fórmula
  // activa (mismos filtros que /api/bom; semántica de lib/a8020.js calcularConsumoReal). Una sola
  // query para todo el rubro: OUTER APPLY deja una fila con basePlu NULL si no hay fórmula.
  // `p` es el componente (SIN_FORMULA_GENERICO_SQL lo espera con ese alias).
  async function vinculosPackBulto(vinculosManuales) {
    const rows = await query(`
      SELECT CAST(b.IdProducto AS VARCHAR) AS plu, b.NombreProducto AS nombre,
        CAST(x.IdProductoComponente AS VARCHAR) AS basePlu, CAST(x.Cantidad AS FLOAT) AS cantidad,
        x.NombreProducto AS baseNombre, x.NombreRubro AS baseRubro
      FROM Productos b
      JOIN Rubros r ON r.IdRubro = b.IdRubro
      OUTER APPLY (
        SELECT pc.IdProductoComponente, pc.Cantidad, p.NombreProducto, rp.NombreRubro
        FROM ProductosComponentes pc
        INNER JOIN Productos p ON p.IdProducto = pc.IdProductoComponente
        LEFT JOIN Rubros rp ON rp.IdRubro = p.IdRubro
        WHERE pc.IdProducto = b.IdProducto AND ${FORMULA_ACTIVA_SQL} AND ${SIN_FORMULA_GENERICO_SQL}
      ) x
      WHERE b.Activo = 1 AND r.NombreRubro = 'Almacen Bultos/Cajas'`);
    return armarVinculos(rows, vinculosManuales);
  }

  // Compra cargada HOY vs. la anterior, por producto (Map plu → compraHoy sin tendencia; la tendencia
  // la agrega el router con la tolerancia de costeo.json). Una sola query agregada para todo SIGA:
  // arranca de las líneas de comprobantes cargados hoy (pocas) y sólo para esos productos busca la
  // compra previa con un OUTER APPLY — sin N+1 y sin recorrer el histórico de productos que no ingresaron.
  // - "Hoy" = Compras.FechaActualizacion (mismo criterio que IngresoHoy de productosConCostos).
  // - Si el producto entró en varias facturas hoy, vale la última cargada (FechaActualizacion, y a igualdad
  //   el comprobante/orden de línea más alto).
  // - Anterior = última línea de ese producto en un comprobante cargado ANTES de hoy, de cualquier
  //   proveedor. FechaActualizacion NULL (registros viejos de SIGA) cuenta como anterior por su Fecha.
  // - Costo = ComprasProductos.PrecioNeto: unitario sin IVA, el mismo neto que SIGA vuelca en
  //   ProductosProveedores.UltimoPrecioCompra (fuente de "última compra" del módulo). Por unidad de
  //   stock (IdUnidadDeMedida), no por unidad de compra: eso es PrecioPorUMCompra/FactorConversionCompra.
  //   ponytail: no se aplica DescuentoRecargoProducto/DescRecGeneralProducto — ningún código del repo los
  //   lee y no hay un caso real que muestre si PrecioNeto ya viene bonificado; si una factura con
  //   bonificación por línea da un Δ raro, revisar esas columnas contra el visor de SIGA.
  // - Fuera: cotizaciones (no son precio pagado, como historialComprasAnio), el genérico '1'
  //   (flete/ajuste, como rutas_compras.js) y líneas sin precio (bonificadas al 100%).
  // Sin input del request: todo el SQL es constante.
  async function comprasHoy() {
    const rows = await query(`
      ;WITH hoy AS (
        SELECT LTRIM(RTRIM(cp.IdProducto)) AS IdProducto, CAST(cp.PrecioNeto AS FLOAT) AS Costo,
          pv.NombreProveedor AS Proveedor, c.Letra, c.CentroEmisor, c.NumeroComprobante,
          ROW_NUMBER() OVER (PARTITION BY cp.IdProducto ORDER BY c.FechaActualizacion DESC,
            c.NumeroComprobante DESC, cp.Orden DESC) AS rn
        FROM ComprasProductos cp
        JOIN Compras c ON c.IdSucursal=cp.IdSucursal AND c.IdTipoComprobante=cp.IdTipoComprobante
          AND c.Letra=cp.Letra AND c.CentroEmisor=cp.CentroEmisor AND c.NumeroComprobante=cp.NumeroComprobante
          AND c.IdProveedor=cp.IdProveedor
        LEFT JOIN Proveedores pv ON pv.IdProveedor = c.IdProveedor
        WHERE c.FechaActualizacion >= CAST(GETDATE() AS date)
          AND c.IdTipoComprobante NOT LIKE 'COTIZACION%'
          AND LTRIM(RTRIM(cp.IdProducto)) <> '1' AND cp.PrecioNeto > 0
      )
      SELECT h.IdProducto, h.Costo, h.Proveedor, h.Letra, h.CentroEmisor, h.NumeroComprobante,
        ant.Costo AS CostoAnterior, CONVERT(varchar(10), ant.Fecha, 23) AS FechaAnterior
      FROM hoy h
      OUTER APPLY (
        SELECT TOP 1 CAST(cp2.PrecioNeto AS FLOAT) AS Costo, c2.Fecha
        FROM ComprasProductos cp2
        JOIN Compras c2 ON c2.IdSucursal=cp2.IdSucursal AND c2.IdTipoComprobante=cp2.IdTipoComprobante
          AND c2.Letra=cp2.Letra AND c2.CentroEmisor=cp2.CentroEmisor AND c2.NumeroComprobante=cp2.NumeroComprobante
          AND c2.IdProveedor=cp2.IdProveedor
        WHERE cp2.IdProducto = h.IdProducto
          AND ISNULL(c2.FechaActualizacion, c2.Fecha) < CAST(GETDATE() AS date)
          AND c2.IdTipoComprobante NOT LIKE 'COTIZACION%' AND cp2.PrecioNeto > 0
        ORDER BY ISNULL(c2.FechaActualizacion, c2.Fecha) DESC, c2.Fecha DESC
      ) ant
      WHERE h.rn = 1`);
    return new Map(rows.map(r => [String(r.IdProducto).trim(), filaCompraHoy(r)]));
  }

  return { productosConCostos, costosPorPlu, preciosVigentesAlmacen, fechasPrecioAlmacen, vinculosPackBulto, comprasHoy };
}

// Comprobante como se lee en la factura: Letra-CentroEmisor(4)-Número(8).
const comprobanteTxt = r => `${String(r.Letra || '').trim()}-${String(r.CentroEmisor ?? '').padStart(4, '0')}-${String(r.NumeroComprobante ?? '').padStart(8, '0')}`;

function filaCompraHoy(r) {
  const costo = +r.Costo;
  const anterior = r.CostoAnterior != null && +r.CostoAnterior > 0 ? +r.CostoAnterior : null;
  return {
    costo, proveedor: r.Proveedor ? String(r.Proveedor).trim() : null, comprobante: comprobanteTxt(r),
    costoAnterior: anterior, fechaAnterior: anterior != null ? r.FechaAnterior || null : null,
    deltaPct: anterior != null ? +(((costo - anterior) / anterior) * 100).toFixed(1) : null,
  };
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
