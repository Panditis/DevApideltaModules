// Script DESCARTABLE de solo lectura — paso 2: anatomía de un movimiento de stock en Siga.
// No escribe nada.
const sql = require('mssql/msnodesqlv8');
const DB_CONFIG = {
  connectionString:
    'Driver={ODBC Driver 17 for SQL Server};' +
    'Server=servidorapidelta\\SQLSTANDARD;'   +
    'Database=Siga;'                           +
    'UID=apidelta;PWD=apd706;TrustServerCertificate=yes;'
};

(async () => {
  const pool = await sql.connect(DB_CONFIG);
  const q = async (label, sqlText, limit = 25) => {
    try {
      const r = await pool.request().query(sqlText);
      console.log(`\n===== ${label} (${r.recordset.length} filas) =====`);
      console.table(r.recordset.slice(0, limit));
    } catch (e) { console.log(`\n===== ${label} — ERROR: ${e.message} =====`); }
  };

  // 1. Estructura de la cabecera
  await q('COLUMNAS MovimientosStock', `
    SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH
    FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='MovimientosStock'
    ORDER BY ORDINAL_POSITION`, 60);

  // 2. Estructura del detalle
  await q('COLUMNAS MovimientosStockProductos', `
    SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH
    FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='MovimientosStockProductos'
    ORDER BY ORDINAL_POSITION`, 60);

  // 3. Tipos de movimiento (encontrar "interno")
  await q('TiposMovimientos (contenido)', `SELECT * FROM TiposMovimientos`, 60);

  // 4. Estructura de ProductosDepositos (stock por deposito)
  await q('COLUMNAS ProductosDepositos', `
    SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
    FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='ProductosDepositos'
    ORDER BY ORDINAL_POSITION`, 40);

  // 5. Un movimiento real reciente (cabecera)
  await q('Ultimos MovimientosStock (cabecera)', `
    SELECT TOP 5 * FROM MovimientosStock ORDER BY 1 DESC`, 5);

  // 6. ¿Hay TRIGGERS en estas tablas? (clave para saber si el stock se actualiza solo)
  await q('TRIGGERS en tablas de stock', `
    SELECT t.name AS trigger_name, OBJECT_NAME(t.parent_id) AS tabla, t.is_disabled
    FROM sys.triggers t
    WHERE OBJECT_NAME(t.parent_id) IN
      ('MovimientosStock','MovimientosStockProductos','ProductosDepositos','MovimientosStockProductosLotes')
    ORDER BY tabla`, 40);

  await pool.close();
  process.exit(0);
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
