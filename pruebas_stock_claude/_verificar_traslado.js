const sql = require('mssql/msnodesqlv8');
const DB_CONFIG = { connectionString:
  'Driver={ODBC Driver 17 for SQL Server};Server=servidorapidelta\\SQLSTANDARD;' +
  'Database=Siga;UID=apidelta;PWD=apd706;TrustServerCertificate=yes;' };
(async () => {
  const pool = await sql.connect(DB_CONFIG);
  const q = async (l, s, lim=30) => { const r = await pool.request().query(s);
    console.log(`\n===== ${l} (${r.recordset.length}) =====`); console.table(r.recordset.slice(0,lim)); };
  await q('Stock 1010 por deposito (Suc 1)', `SELECT pd.IdDeposito, sd.NombreDeposito, pd.Stock, pd.Stock2
    FROM ProductosDepositos pd LEFT JOIN SucursalesDepositos sd ON sd.IdSucursal=pd.IdSucursal AND sd.IdDeposito=pd.IdDeposito
    WHERE pd.IdProducto='1010' AND pd.IdSucursal=1 ORDER BY pd.IdDeposito`);
  await q('Comprobantes 16414 y 16415 (cabecera)', `SELECT NumeroMovimiento, FechaMovimiento, Usuario, Observacion
    FROM MovimientosStock WHERE IdSucursal=1 AND IdTipoMovimiento='BIENESUSO' AND NumeroMovimiento IN (16414,16415) ORDER BY NumeroMovimiento`);
  await q('Detalle (2 lineas c/u)', `SELECT NumeroMovimiento, IdDeposito, IdProducto, Cantidad, Orden
    FROM MovimientosStockProductos WHERE IdSucursal=1 AND IdTipoMovimiento='BIENESUSO' AND NumeroMovimiento IN (16414,16415)
    ORDER BY NumeroMovimiento, Orden`);
  await pool.close(); process.exit(0);
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
