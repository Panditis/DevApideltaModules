// ponytail: one-off audit script, not a shared module. Copies dev/server.js DB_CONFIG pattern.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const sql = require('mssql/msnodesqlv8');

const DB_CONFIG = { connectionString:
  `Driver={ODBC Driver 17 for SQL Server};Server=${process.env.SIGA_DB_SERVER};` +
  `Database=${process.env.SIGA_DB_NAME};UID=${process.env.SIGA_READ_UID};PWD=${process.env.SIGA_READ_PWD};TrustServerCertificate=yes;` };

(async () => {
  const pool = await sql.connect(DB_CONFIG);

  const tables = (await pool.request().query(
    `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_NAME LIKE '%Rol%' OR TABLE_NAME LIKE '%Funcion%'
        OR TABLE_NAME LIKE '%Permis%' OR TABLE_NAME LIKE '%Usuario%'
        OR TABLE_NAME LIKE '%Menu%' OR TABLE_NAME LIKE '%Opcion%'
     ORDER BY TABLE_NAME`)).recordset;
  console.log('===== TABLAS CANDIDATAS =====');
  console.table(tables);

  await pool.close();
  process.exit(0);
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
