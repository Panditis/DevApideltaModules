// Lectura: columnas y muestra de la tabla Usuarios.
const sql = require('mssql/msnodesqlv8');
const DB_CONFIG = { connectionString:
  'Driver={ODBC Driver 17 for SQL Server};Server=servidorapidelta\\SQLSTANDARD;' +
  'Database=Siga;UID=apidelta;PWD=apd706;TrustServerCertificate=yes;' };
(async () => {
  const pool = await sql.connect(DB_CONFIG);
  const cols = (await pool.request().query(
    `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
     FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Usuarios' ORDER BY ORDINAL_POSITION`)).recordset;
  console.log('===== COLUMNAS Usuarios =====');
  console.table(cols);
  const muestra = (await pool.request().query(`SELECT TOP 10 * FROM Usuarios`)).recordset;
  console.log('===== MUESTRA Usuarios (top 10) =====');
  console.table(muestra);
  await pool.close(); process.exit(0);
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
