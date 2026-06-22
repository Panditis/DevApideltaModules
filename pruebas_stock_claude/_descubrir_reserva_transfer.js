// SOLO LECTURA — descubrir como Siga maneja: (A) transferencias entre depositos y (B) reservas.
const sql = require('mssql/msnodesqlv8');
const DB_CONFIG = { connectionString:
  'Driver={ODBC Driver 17 for SQL Server};Server=servidorapidelta\\SQLSTANDARD;' +
  'Database=Siga;UID=apidelta;PWD=apd706;TrustServerCertificate=yes;' };

(async () => {
  const pool = await sql.connect(DB_CONFIG);
  const q = async (label, sqlText, limit = 25) => {
    try {
      const r = await pool.request().query(sqlText);
      console.log(`\n===== ${label} (${r.recordset.length} filas) =====`);
      console.table(r.recordset.slice(0, limit));
    } catch (e) { console.log(`\n===== ${label} — ERROR: ${e.message} =====`); }
  };

  // ── TABLAS dedicadas a reservas / transferencias ──────────────────────────
  await q('Tablas con Reserva/Transfer en el nombre', `
    SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_NAME LIKE '%Reserva%' OR TABLE_NAME LIKE '%Transfer%' OR TABLE_NAME LIKE '%Traslado%'
    ORDER BY TABLE_NAME`);

  // ── (A) TRANSFERENCIAS ENTRE DEPOSITOS ────────────────────────────────────
  // Detalle real donde se usa IdDeposito2 (destino) -> como se modela el traslado
  await q('Detalle con IdDeposito2 (traslados) — que tipos lo usan', `
    SELECT TOP 30 IdTipoMovimiento, NumeroMovimiento, IdProducto, Cantidad,
           IdDeposito, IdDeposito2, IdUbicacion, IdUbicacion2, Orden
    FROM MovimientosStockProductos
    WHERE IdDeposito2 IS NOT NULL
    ORDER BY NumeroMovimiento DESC`);

  await q('Conteo de traslados por tipo de movimiento', `
    SELECT IdTipoMovimiento, COUNT(*) AS cantidad
    FROM MovimientosStockProductos
    WHERE IdDeposito2 IS NOT NULL
    GROUP BY IdTipoMovimiento ORDER BY cantidad DESC`);

  // ── (B) RESERVAS ──────────────────────────────────────────────────────────
  // Tipos con flag ReservaMercaderia
  await q('Tipos de movimiento que reservan mercaderia', `
    SELECT IdTipoMovimiento, Descripcion, CoeficienteStock, ReservaMercaderia
    FROM TiposMovimientos WHERE ReservaMercaderia=1`);

  // Cabeceras reales de RESERVA
  await q('Cabeceras reales RESERVA/SRV_RESERVA (ultimas)', `
    SELECT TOP 10 IdSucursal, IdTipoMovimiento, NumeroMovimiento, FechaMovimiento, Total, Usuario, Observacion
    FROM MovimientosStock
    WHERE IdTipoMovimiento IN ('RESERVA','SRV_RESERVA')
    ORDER BY FechaMovimiento DESC`);

  // Detalle real de RESERVA
  await q('Detalle real RESERVA/SRV_RESERVA', `
    SELECT TOP 20 IdSucursal, IdTipoMovimiento, NumeroMovimiento, IdProducto, IdDeposito, IdUbicacion,
           Cantidad, Cantidad2, Precio, Orden
    FROM MovimientosStockProductos
    WHERE IdTipoMovimiento IN ('RESERVA','SRV_RESERVA')
    ORDER BY NumeroMovimiento DESC`);

  // ── Significado de Stock vs Stock2 ────────────────────────────────────────
  // Ver productos donde Stock2 <> 0 para inferir que representa
  await q('Ejemplos con Stock2 distinto de 0 (ProductosDepositos)', `
    SELECT TOP 15 IdProducto, IdSucursal, IdDeposito, Stock, Stock2
    FROM ProductosDepositos WHERE Stock2 <> 0 ORDER BY IdProducto`);

  await pool.close();
  process.exit(0);
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
