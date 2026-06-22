// SOLO LECTURA — determinar empiricamente la direccion de una reserva.
const sql = require('mssql/msnodesqlv8');
const DB_CONFIG = { connectionString:
  'Driver={ODBC Driver 17 for SQL Server};Server=servidorapidelta\\SQLSTANDARD;' +
  'Database=Siga;UID=apidelta;PWD=apd706;TrustServerCertificate=yes;' };

(async () => {
  const pool = await sql.connect(DB_CONFIG);
  const q = async (label, sqlText, limit = 30) => {
    try {
      const r = await pool.request().query(sqlText);
      console.log(`\n===== ${label} (${r.recordset.length} filas) =====`);
      console.table(r.recordset.slice(0, limit));
    } catch (e) { console.log(`\n===== ${label} — ERROR: ${e.message} =====`); }
  };

  // Productos con stock actual en el deposito 99 (reservado) de Casa Central
  await q('Productos con stock en deposito 99 (reservado) - top por |stock|', `
    SELECT TOP 15 IdProducto, IdDeposito, Stock, Stock2
    FROM ProductosDepositos
    WHERE IdSucursal=1 AND IdDeposito=99 AND Stock <> 0
    ORDER BY ABS(Stock) DESC`);

  // Para el producto 90621 del ejemplo: stock actual en ambos depositos + suma de sus reservas
  await q('Producto 90621: stock actual por deposito (Suc 1)', `
    SELECT IdDeposito, Stock, Stock2 FROM ProductosDepositos
    WHERE IdProducto='90621' AND IdSucursal=1 ORDER BY IdDeposito`);
  await q('Producto 90621: suma de movimientos RESERVA por deposito', `
    SELECT IdDeposito, SUM(Cantidad) AS suma_cantidad, COUNT(*) AS lineas
    FROM MovimientosStockProductos
    WHERE IdProducto='90621' AND IdSucursal=1 AND IdTipoMovimiento='RESERVA'
    GROUP BY IdDeposito ORDER BY IdDeposito`);

  // Resumen general: balance neto del deposito 99 (¿positivo o negativo?)
  await q('Balance global deposito 99 (Suc 1)', `
    SELECT COUNT(*) AS productos_con_stock,
           SUM(CASE WHEN Stock>0 THEN 1 ELSE 0 END) AS positivos,
           SUM(CASE WHEN Stock<0 THEN 1 ELSE 0 END) AS negativos,
           MIN(Stock) AS min_stock, MAX(Stock) AS max_stock
    FROM ProductosDepositos WHERE IdSucursal=1 AND IdDeposito=99 AND Stock<>0`);

  await pool.close();
  process.exit(0);
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
