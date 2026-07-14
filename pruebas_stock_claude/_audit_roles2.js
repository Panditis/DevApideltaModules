require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const sql = require('mssql/msnodesqlv8');

const DB_CONFIG = { connectionString:
  `Driver={ODBC Driver 17 for SQL Server};Server=${process.env.SIGA_DB_SERVER};` +
  `Database=${process.env.SIGA_DB_NAME};UID=${process.env.SIGA_READ_UID};PWD=${process.env.SIGA_READ_PWD};TrustServerCertificate=yes;` };

const TABLES = ['Funciones', 'Roles', 'RolesFunciones', 'Usuarios', 'UsuariosRoles'];

(async () => {
  const pool = await sql.connect(DB_CONFIG);
  for (const t of TABLES) {
    const cols = (await pool.request().query(
      `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
       FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='${t}' ORDER BY ORDINAL_POSITION`)).recordset;
    console.log(`===== COLUMNAS ${t} =====`);
    console.table(cols);
    const count = (await pool.request().query(`SELECT COUNT(*) AS n FROM [${t}]`)).recordset[0].n;
    console.log(`${t}: ${count} filas`);
  }
  await pool.close();
  process.exit(0);
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
