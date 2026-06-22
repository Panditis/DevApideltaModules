// SOLO LECTURA — que TipoMovimiento usa Siga para trasladar un producto entre depositos.
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

  // Movimientos donde un mismo producto aparece en 2 depositos distintos dentro del mismo comprobante
  // (patron de traslado). Agrupado por tipo + par de depositos.
  await q('Patrones de traslado entre depositos por tipo (Sucursal 1)', `
    WITH multi AS (
      SELECT IdSucursal, IdTipoMovimiento, NumeroMovimiento, IdProducto
      FROM MovimientosStockProductos
      WHERE IdSucursal=1
      GROUP BY IdSucursal, IdTipoMovimiento, NumeroMovimiento, IdProducto
      HAVING COUNT(DISTINCT IdDeposito) > 1
    )
    SELECT d.IdTipoMovimiento,
           MIN(CASE WHEN d.Cantidad<0 THEN d.IdDeposito END) AS dep_origen_ejemplo,
           MIN(CASE WHEN d.Cantidad>0 THEN d.IdDeposito END) AS dep_destino_ejemplo,
           COUNT(*) AS lineas
    FROM MovimientosStockProductos d
    JOIN multi ON multi.IdSucursal=d.IdSucursal AND multi.IdTipoMovimiento=d.IdTipoMovimiento
              AND multi.NumeroMovimiento=d.NumeroMovimiento AND multi.IdProducto=d.IdProducto
    GROUP BY d.IdTipoMovimiento
    ORDER BY lineas DESC`);

  // Movimientos que tocan especificamente el deposito 2 (Reservador Mayorista)
  await q('Movimientos que tocan el deposito 2 - por tipo', `
    SELECT IdTipoMovimiento, COUNT(*) AS lineas, SUM(Cantidad) AS suma
    FROM MovimientosStockProductos WHERE IdSucursal=1 AND IdDeposito=2
    GROUP BY IdTipoMovimiento ORDER BY lineas DESC`);

  // Ejemplo concreto de un traslado que NO sea RESERVA (para ver la estructura)
  await q('Ejemplo de traslado no-RESERVA (2 lineas, distinto deposito)', `
    WITH multi AS (
      SELECT TOP 5 IdSucursal, IdTipoMovimiento, NumeroMovimiento, IdProducto
      FROM MovimientosStockProductos
      WHERE IdSucursal=1 AND IdTipoMovimiento NOT IN ('RESERVA','SRV_RESERVA')
      GROUP BY IdSucursal, IdTipoMovimiento, NumeroMovimiento, IdProducto
      HAVING COUNT(DISTINCT IdDeposito) > 1
      ORDER BY NumeroMovimiento DESC
    )
    SELECT d.IdTipoMovimiento, d.NumeroMovimiento, d.IdProducto, d.IdDeposito, d.Cantidad, d.Orden
    FROM MovimientosStockProductos d
    JOIN multi ON multi.IdSucursal=d.IdSucursal AND multi.IdTipoMovimiento=d.IdTipoMovimiento
              AND multi.NumeroMovimiento=d.NumeroMovimiento AND multi.IdProducto=d.IdProducto
    ORDER BY d.NumeroMovimiento DESC, d.Orden`);

  await pool.close();
  process.exit(0);
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
