'use strict';
// Consultas SIGA compartidas por los routers de Precios (esquema por canal y Producción): un solo criterio de "costo" y
// de "precio vigente".
// Recibe `query` y LISTA_PRECIOS_VENTA por deps, igual que los routers (y los filtros de fórmula
// activa de server.js para los vínculos pack/bulto).
const { armarVinculos } = require('./precios_pack_bulto');
const { TIPOS_QUE_RESTAN } = require('./compras_control');

// Notas de crédito de compra (restan, no son un precio pagado): fuera de "última compra".
// Constantes del repo, nunca input: seguro interpolarlas.
const NC_SQL = TIPOS_QUE_RESTAN.map(t => `'${t}'`).join(',');

// JOIN línea ↔ comprobante de compra (6 columnas, mismo que rutas_compras.js). `cp`/`c` son los alias.
const JOIN_COMPRAS = (cp, c) => `JOIN Compras ${c} ON ${c}.IdSucursal=${cp}.IdSucursal AND ${c}.IdTipoComprobante=${cp}.IdTipoComprobante
          AND ${c}.Letra=${cp}.Letra AND ${c}.CentroEmisor=${cp}.CentroEmisor AND ${c}.NumeroComprobante=${cp}.NumeroComprobante
          AND ${c}.IdProveedor=${cp}.IdProveedor`;

// Costo de sistema (sucursal central) + último comprobante real de compra de un producto `p`
// (ComprasProductos, no ProductosProveedores.UltimoPrecioCompra): el más reciente por fecha del
// comprobante, sin notas de crédito ni líneas sin precio. Trae neto, % IVA y tipo: el costo neto
// (PrecioNeto, factura o cotización) lo resuelve costoLineaCompra en JS.
// ponytail: TOP 1 correlacionado por producto (como antes sobre ProductosProveedores); depende del
// índice por IdProducto de ComprasProductos. Si el listado Almacén se pone lento, pasar a un CTE con
// ROW_NUMBER filtrado a los productos del universo.
const SQL_COSTOS_PRODUCTO = `
      LEFT JOIN ProductosSucursales ps ON ps.IdProducto = p.IdProducto
        AND ps.IdSucursal = (SELECT MIN(IdSucursal) FROM Sucursales WHERE SoyLaCentral = 1)
      OUTER APPLY (
        SELECT TOP 1 CAST(cp.PrecioNeto AS FLOAT) AS PrecioNeto, CAST(cp.PorcentajeIVA AS FLOAT) AS PorcentajeIVA,
          c.IdTipoComprobante AS Tipo, pv.NombreProveedor AS Proveedor, c.Fecha AS FechaCompra
        FROM ComprasProductos cp
        ${JOIN_COMPRAS('cp', 'c')}
        LEFT JOIN Proveedores pv ON pv.IdProveedor = c.IdProveedor
        WHERE cp.IdProducto = p.IdProducto AND cp.PrecioNeto > 0 AND LTRIM(RTRIM(cp.IdProducto)) <> '1'
          AND c.IdTipoComprobante NOT IN (${NC_SQL})
        ORDER BY c.Fecha DESC, c.FechaActualizacion DESC, c.NumeroComprobante DESC, cp.Orden DESC
      ) uc`;

// Precio vigente de mostrador (sucursal central, lista de venta). Precedente verificado:
// rutas_precios_historico.js:63-66 (mismo patrón SUCURSAL_PRECIOS_HIST=1).
const SUCURSAL_PRECIOS_ALMACEN = 1;

// IdProducto aceptado para interpolar en un IN (varchar en SIGA: puede no ser numérico).
const ID_SQL_RE = /^[\w-]{1,30}$/;

function crearConsultasPrecios({ query, LISTA_PRECIOS_VENTA, FORMULA_ACTIVA_SQL, SIN_FORMULA_GENERICO_SQL }) {
  // Productos con sus dos costos posibles (precio = costo × (1 + markup) × (1 + alícuota)):
  // - CostoSistema: ProductosSucursales.PrecioCosto de la central TAL CUAL lo muestra SIGA (fuente por defecto).
  // - Última compra: último comprobante real (SQL_COSTOS_PRODUCTO), neto con costoLineaCompra;
  //   elegible por producto con la decisión (costeo.decisiones[plu].fuente).
  // `filtroSql` es siempre una constante del router o un IN de ids ya validados, nunca input crudo.
  async function productosConCostos(filtroSql) {
    const rows = await query(`
      SELECT p.IdProducto, p.NombreProducto, uc.PrecioNeto AS UcPrecioNeto, uc.PorcentajeIVA AS UcPorcentajeIVA,
        uc.Tipo AS UcTipo, uc.Proveedor,
        CAST(ps.PrecioCosto AS FLOAT) AS CostoSistema, CAST(p.Alicuota AS FLOAT) AS IvaCompraPct,
        CONVERT(varchar(10), uc.FechaCompra, 23) AS FechaCompraTxt, r.NombreRubro AS Rubro,
        -- "Ingreso hoy" = el producto está en un comprobante de compra CARGADO hoy en SIGA
        -- (Compras.FechaActualizacion), no con fecha de factura de hoy: una factura del 15/9
        -- ingresada hoy tiene Fecha=15/9 y FechaActualizacion=hoy. Mismo join que rutas_compras.js.
        CASE WHEN EXISTS (
          SELECT 1 FROM ComprasProductos cp
          ${JOIN_COMPRAS('cp', 'c')}
          WHERE cp.IdProducto = p.IdProducto AND c.FechaActualizacion >= CAST(GETDATE() AS date)
        ) THEN 1 ELSE 0 END AS IngresoHoy
      FROM Productos p
      LEFT JOIN Rubros r ON r.IdRubro = p.IdRubro
      ${SQL_COSTOS_PRODUCTO}
      -- IvaCompraPct = Productos.Alicuota: alícuota de venta. Null → 21 % supuesto.
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

  // Universo Reventa: rubro 'Almacen', activo (constante, nunca input).
  const universoAlmacen = () => productosConCostos(`p.Activo = 1 AND r.NombreRubro = 'Almacen'`);

  // Fraccionado. Graneles = rubro 'Pesables Deposito'; presentaciones = 'Pesables Fraccionado' (mismo filtro que
  // rutas_fraccionado_externo) + 'Pesables Venta Directa', unidas por pesables_listas.formulas[plu].granel. Un venta
  // directa sin fórmula es su propio granel. `rubro` es siempre una constante de este archivo, nunca input.
  async function productosDeRubro(rubro) {
    const rows = await query(`
      SELECT p.IdProducto, p.NombreProducto
      FROM Productos p JOIN Rubros r ON r.IdRubro = p.IdRubro
      WHERE p.Activo = 1 AND r.NombreRubro = '${rubro}'`);
    return rows.map(r => ({ plu: String(r.IdProducto), nombre: String(r.NombreProducto || '').trim() }));
  }

  // Graneles con su subrubro de SIGA (máquina y tramos por subrubro de Fraccionado, spec 2026-10-21 §9).
  // SubRubros puede no existir en esta base: si la consulta falla por eso se recuerda (no se vuelve a probar) y los graneles
  // van sin subrubro (aviso sinSubrubro). Cualquier otro error sube.
  let sinTablaSubRubros = false;
  async function granelesConSubrubro() {
    if (!sinTablaSubRubros) {
      try {
        const rows = await query(`
          SELECT p.IdProducto, p.NombreProducto, sr.IdSubRubro, sr.NombreSubRubro
          FROM Productos p JOIN Rubros r ON r.IdRubro = p.IdRubro
          LEFT JOIN SubRubros sr ON sr.IdRubro = p.IdRubro AND sr.IdSubRubro = p.IdSubRubro
          WHERE p.Activo = 1 AND r.NombreRubro = 'Pesables Deposito'`);
        return rows.map(r => ({ plu: String(r.IdProducto), nombre: String(r.NombreProducto || '').trim(),
          subrubroId: r.IdSubRubro != null ? String(r.IdSubRubro).trim() : null,
          subrubro: r.NombreSubRubro ? String(r.NombreSubRubro).trim() : null }));
      } catch (err) {
        if (!/SubRubro/i.test(String(err && err.message))) throw err;
        sinTablaSubRubros = true;
      }
    }
    return (await productosDeRubro('Pesables Deposito')).map(g => ({ ...g, subrubroId: null, subrubro: null }));
  }

  // Granel ('Pesables Deposito') de la fórmula activa en SIGA de cada PLU: componente directo o a dos niveles (por el
  // intermedio de producción); gana el directo. Map plu → granelPlu.
  async function granelesEnFormulaSiga(plus) {
    const ids = plus.filter(id => /^\d{1,12}$/.test(id));
    if (!ids.length) return new Map();
    const lista = ids.map(id => `'${id}'`).join(',');
    const formulaActivaPc2 = FORMULA_ACTIVA_SQL.replace(/\bpc\./g, 'pc2.');
    const rows = await query(`
      SELECT CAST(pc.IdProducto AS VARCHAR) AS Plu, CAST(p.IdProducto AS VARCHAR) AS Granel, 1 AS Nivel
      FROM ProductosComponentes pc JOIN Productos p ON p.IdProducto = pc.IdProductoComponente
      JOIN Rubros r ON r.IdRubro = p.IdRubro
      WHERE pc.IdProducto IN (${lista}) AND r.NombreRubro = 'Pesables Deposito' AND ${FORMULA_ACTIVA_SQL}
      UNION ALL
      SELECT CAST(pc.IdProducto AS VARCHAR), CAST(p.IdProducto AS VARCHAR), 2
      FROM ProductosComponentes pc JOIN ProductosComponentes pc2 ON pc2.IdProducto = pc.IdProductoComponente
      JOIN Productos p ON p.IdProducto = pc2.IdProductoComponente JOIN Rubros r ON r.IdRubro = p.IdRubro
      WHERE pc.IdProducto IN (${lista}) AND r.NombreRubro = 'Pesables Deposito' AND ${FORMULA_ACTIVA_SQL} AND ${formulaActivaPc2}`);
    const mapa = new Map();
    for (const r of [...rows].sort((a, b) => a.Nivel - b.Nivel)) {
      const plu = String(r.Plu).trim();
      if (!mapa.has(plu)) mapa.set(plu, String(r.Granel).trim());
    }
    return mapa;
  }

  // Universo Fraccionado: graneles (con subrubro), presentaciones (los VD sin fórmula de pesables_listas con el granel de su
  // fórmula SIGA en granelSiga) y costos (Map plu → filaCostos) de los graneles + los referenciados por alguna presentación.
  // formulas = pesables_listas.json .formulas (lo lee el router: este archivo no toca fs).
  // extraPlus = PLUs de insumos de Fraccionado (lib/precios_fraccionado_costo plusInsumos): su costo entra en el mismo Map.
  async function universoFraccionado(formulas, extraPlus = []) {
    const [graneles, fraccionados, ventaDirecta] = await Promise.all([
      granelesConSubrubro(), productosDeRubro('Pesables Fraccionado'), productosDeRubro('Pesables Venta Directa'),
    ]);
    const granelSiga = await granelesEnFormulaSiga(ventaDirecta.filter(p => !granelDe(formulas, p.plu)).map(p => p.plu));
    const presentaciones = [...fraccionados, ...ventaDirecta.map(p => ({ ...p, ventaDirecta: true, granelSiga: granelSiga.get(p.plu) || null }))];
    const referenciados = presentaciones.map(p => granelDePresentacion(formulas, p)).filter(Boolean);
    const costos = await costosPorPlu([...graneles.map(g => g.plu), ...referenciados, ...extraPlus]);
    return { graneles, presentaciones, costos };
  }

  return { productosConCostos, costosPorPlu, preciosVigentesAlmacen, fechasPrecioAlmacen, vinculosPackBulto,
    universoAlmacen, universoFraccionado };
}

function granelDe(formulas, plu) {
  const f = (formulas || {})[plu];
  return f && f.granel != null ? String(f.granel) : null;
}

// Granel de una presentación: fórmula de pesables_listas; un venta directa sin ella usa la fórmula de
// SIGA (granelSiga), después el granel del mismo nombre ("Albahaca 1Kg" ↔ "Albahaca DEPOSITO GRANEL")
// y si no, es su propio granel: sus fraccionados (50G...) y temporales cuelgan de su PLU.
// Su costo SIGA ya es $/kg, como todo pesable.
const granelDePresentacion = (formulas, p, granelPorNombre = () => null) => granelDe(formulas, p.plu)
  ?? (p.ventaDirecta ? p.granelSiga || granelPorNombre(p.nombre) || p.plu : null);

// Nombre sin peso, paréntesis ("(Precio Por Kilo)"), "DEPOSITO"/"GRANEL", puntuación, tildes ni
// mayúsculas: clave para unir VD y granel. soloLetras también saca números (calibre "9/11").
const nombreBase = (nombre, soloLetras = false) => String(nombre || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/\([^)]*\)/g, ' ').replace(/\d+(?:[.,]\d+)?\s*(?:kgs?|grs?|gramos|g)\b/g, ' ')
  .replace(/\b(?:deposito|granel)\b/g, ' ').replace(soloLetras ? /[^a-z]+/g : /[^a-z0-9]+/g, ' ').trim();

// Buscador de granel por nombre: primero con calibre exacto; sin calibre sólo si el granel es único
// ("Avellanas Chicas 1Kg" ↔ "Avellanas Chicas - 9/11"; "Almendras 1Kg" con dos calibres no se une).
function crearGranelPorNombre(graneles) {
  const exacto = new Map((graneles || []).map(g => [nombreBase(g.nombre), g.plu]));
  const porLetras = new Map();
  for (const g of graneles || []) {
    const k = nombreBase(g.nombre, true);
    porLetras.set(k, porLetras.has(k) ? null : g.plu);
  }
  return nombre => exacto.get(nombreBase(nombre)) || porLetras.get(nombreBase(nombre, true)) || null;
}

// Costo NETO de una línea de compra de SIGA (Precios trabaja con costo neto + IVA de venta al final, spec
// 2026-10-02-precios-costo-neto-iva-curva): factura y cotización → PrecioNeto tal cual (la factura NO suma su
// IVA). Notas de crédito y líneas sin precio → null (no son un costo). Sólo la usa Precios (Compras no).
const esCotizacion = tipo => String(tipo || '').trim().toUpperCase().startsWith('COTIZACION');
const redondear2 = n => Math.round(n * 100) / 100;
function costoLineaCompra({ tipo, precioNeto } = {}) {
  const neto = Number(precioNeto);
  if (precioNeto == null || !Number.isFinite(neto) || neto <= 0) return null;
  if (TIPOS_QUE_RESTAN.includes(String(tipo || '').trim().toUpperCase())) return null;
  return redondear2(neto);
}

// Rótulo del comprobante para la UI ('factura' | 'cotización'), null sin compra.
const tipoCompra = tipo => (tipo == null ? null : esCotizacion(tipo) ? 'cotización' : 'factura');

// Costo de sistema = ProductosSucursales.PrecioCosto de SIGA TAL CUAL (2026-10-16, decisión del usuario: el
// módulo muestra y calcula con el mismo número que SIGA; antes se dividía por 1 + alícuota). La última compra
// sigue siendo el PrecioNeto de la factura. ivaCompraPct = Productos.Alicuota (null si no está cargada →
// ivaCompraSupuesto, 21 %): es la alícuota de VENTA del producto.
function filaCostos(r) {
  const sis = r.CostoSistema != null && +r.CostoSistema > 0 ? +r.CostoSistema : null;
  const alicuota = r.IvaCompraPct != null && Number.isFinite(+r.IvaCompraPct) ? +r.IvaCompraPct : null;
  return {
    plu: String(r.IdProducto), nombre: String(r.NombreProducto || '').trim(), rubro: r.Rubro || null,
    costoMercaderia: costoLineaCompra({ tipo: r.UcTipo, precioNeto: r.UcPrecioNeto }),
    tipoComprobanteUltimaCompra: tipoCompra(r.UcTipo),
    costoSistema: sis,
    ivaCompraPct: alicuota, ivaCompraSupuesto: alicuota == null,
    proveedor: r.Proveedor || null, fechaUltimaCompra: r.FechaCompraTxt || null,
    ingresoHoy: r.IngresoHoy === 1,
  };
}

module.exports = { crearConsultasPrecios, costoLineaCompra, filaCostos,
  granelDe, granelDePresentacion, crearGranelPorNombre };
