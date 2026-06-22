// SOLO LECTURA — nombres reales de depositos de mercaderia y contexto del deposito 99.
const sql = require('mssql/msnodesqlv8');
const DB_CONFIG = { connectionString:
  'Driver={ODBC Driver 17 for SQL Server};Server=servidorapidelta\\SQLSTANDARD;' +
  'Database=Siga;UID=apidelta;PWD=apd706;TrustServerCertificate=yes;' };

(async () => {
  const pool = await sql.connect(DB_CONFIG);
  const q = async (label, sqlText, limit = 40) => {
    try {
      const r = await pool.request().query(sqlText);
      console.log(`\n===== ${label} (${r.recordset.length} filas) =====`);
      console.table(r.recordset.slice(0, limit));
    } catch (e) { console.log(`\n===== ${label} — ERROR: ${e.message} =====`); }
  };

  // Estructura de SucursalesDepositos
  await q('COLUMNAS SucursalesDepositos', `
    SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME='SucursalesDepositos' ORDER BY ORDINAL_POSITION`, 30);

  // Depositos de mercaderia de Casa Central (Sucursal 1)
  await q('Depositos de mercaderia - Sucursal 1', `
    SELECT * FROM SucursalesDepositos WHERE IdSucursal=1 ORDER BY IdDeposito`, 40);

  // Stock del 1010 en TODOS sus depositos de Casa Central (para traslados)
  await q('Stock 1010 en depositos de Sucursal 1', `
    SELECT pd.IdDeposito, sd.NombreDeposito, pd.Stock, pd.Stock2
    FROM ProductosDepositos pd
    LEFT JOIN SucursalesDepositos sd ON sd.IdSucursal=pd.IdSucursal AND sd.IdDeposito=pd.IdDeposito
    WHERE pd.IdProducto='1010' AND pd.IdSucursal=1 ORDER BY pd.IdDeposito`, 40);

  await pool.close();
  process.exit(0);
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
