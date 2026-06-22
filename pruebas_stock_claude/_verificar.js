// Verificacion de SOLO LECTURA del estado tras la prueba real. No escribe nada.
const sql = require('mssql/msnodesqlv8');
const DB_CONFIG = { connectionString:
  'Driver={ODBC Driver 17 for SQL Server};Server=servidorapidelta\\SQLSTANDARD;' +
  'Database=Siga;UID=apidelta;PWD=apd706;TrustServerCertificate=yes;' };

(async () => {
  const pool = await sql.connect(DB_CONFIG);
  const q = async (label, sqlText, limit = 30) => {
    const r = await pool.request().query(sqlText);
    console.log(`\n===== ${label} (${r.recordset.length} filas) =====`);
    console.table(r.recordset.slice(0, limit));
  };

  // 1. Contador actual de comprobantes (Suc 1, BIENESUSO)
  await q('Contador MovimientosNumeros (Suc 1 BIENESUSO)', `
    SELECT IdSucursal, IdTipoMovimiento, Numero
    FROM MovimientosNumeros WHERE IdSucursal=1 AND IdTipoMovimiento='BIENESUSO'`);

  // 2. Stock actual del producto 1010 (las dos tablas)
  await q('Stock 1010 - ProductosDepositos', `
    SELECT IdProducto, IdSucursal, IdDeposito, Stock, Stock2
    FROM ProductosDepositos WHERE IdProducto='1010' AND IdSucursal=1`);
  await q('Stock 1010 - ProductosUbicaciones', `
    SELECT IdProducto, IdSucursal, IdDeposito, IdUbicacion, Stock, Stock2
    FROM ProductosUbicaciones WHERE IdProducto='1010' AND IdSucursal=1`);

  // 3. Ultimos movimientos BIENESUSO de Casa Central (ver 16411 / 16412)
  await q('Ultimos 5 MovimientosStock (Suc 1 BIENESUSO)', `
    SELECT TOP 5 NumeroMovimiento, FechaMovimiento, Total, Usuario, Observacion
    FROM MovimientosStock WHERE IdSucursal=1 AND IdTipoMovimiento='BIENESUSO'
    ORDER BY NumeroMovimiento DESC`);

  // 4. Detalle de esos movimientos para el producto 1010
  await q('Detalle de movimientos recientes del 1010', `
    SELECT NumeroMovimiento, IdProducto, Cantidad, Precio, Orden
    FROM MovimientosStockProductos
    WHERE IdSucursal=1 AND IdTipoMovimiento='BIENESUSO' AND IdProducto='1010'
    ORDER BY CAST(NumeroMovimiento AS bigint) DESC`, 10);

  await pool.close();
  process.exit(0);
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
