// Script DESCARTABLE de solo lectura — descubre cómo Siga registra movimientos de stock.
// No escribe nada. Reusa el driver de los servidores.
const sql = require('mssql/msnodesqlv8');

const DB_CONFIG = {
  connectionString:
    'Driver={ODBC Driver 17 for SQL Server};' +
    'Server=servidorapidelta\\SQLSTANDARD;'   +
    'Database=Siga;'                           +
    'UID=apidelta;'                            +
    'PWD=apd706;'                              +
    'TrustServerCertificate=yes;'
};

(async () => {
  const pool = await sql.connect(DB_CONFIG);
  const q = async (label, sqlText) => {
    try {
      const r = await pool.request().query(sqlText);
      console.log(`\n===== ${label} (${r.recordset.length} filas) =====`);
      console.table(r.recordset.slice(0, 40));
    } catch (e) {
      console.log(`\n===== ${label} — ERROR: ${e.message} =====`);
    }
  };

  // 1. Tablas candidatas a movimientos / stock / comprobantes
  await q('TABLAS candidatas', `
    SELECT TABLE_NAME
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_TYPE='BASE TABLE' AND (
        TABLE_NAME LIKE '%Movim%' OR TABLE_NAME LIKE '%Stock%'
     OR TABLE_NAME LIKE '%Comprob%' OR TABLE_NAME LIKE '%Kardex%'
     OR TABLE_NAME LIKE '%Deposito%' OR TABLE_NAME LIKE '%Inventario%')
    ORDER BY TABLE_NAME`);

  // 2. Stored procedures candidatos (lo más importante)
  await q('STORED PROCEDURES candidatos', `
    SELECT ROUTINE_NAME
    FROM INFORMATION_SCHEMA.ROUTINES
    WHERE ROUTINE_TYPE='PROCEDURE' AND (
        ROUTINE_NAME LIKE '%Movim%' OR ROUTINE_NAME LIKE '%Stock%'
     OR ROUTINE_NAME LIKE '%Kardex%' OR ROUTINE_NAME LIKE '%Inventario%')
    ORDER BY ROUTINE_NAME`);

  // 3. Tipos de movimiento definidos (para encontrar el id de "Movimiento interno")
  await q('TIPOS DE MOVIMIENTO (tablas con Tipo+Movim)', `
    SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_NAME LIKE '%TipoMov%' OR TABLE_NAME LIKE '%MovimientoTipo%'
       OR TABLE_NAME LIKE '%TipoComprob%'
    ORDER BY TABLE_NAME`);

  await pool.close();
  process.exit(0);
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
