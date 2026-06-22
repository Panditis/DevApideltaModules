// Script DESCARTABLE de solo lectura — paso 3: numeración, depósitos y patrón real.
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
  const q = async (label, sqlText, limit = 30) => {
    try {
      const r = await pool.request().query(sqlText);
      console.log(`\n===== ${label} (${r.recordset.length} filas) =====`);
      console.table(r.recordset.slice(0, limit));
    } catch (e) { console.log(`\n===== ${label} — ERROR: ${e.message} =====`); }
  };

  // 1. Estructura y contenido de MovimientosNumeros (cómo numera)
  await q('COLUMNAS MovimientosNumeros', `
    SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME='MovimientosNumeros' ORDER BY ORDINAL_POSITION`, 30);
  await q('MovimientosNumeros para BIENESUSO', `
    SELECT * FROM MovimientosNumeros WHERE IdTipoMovimiento='BIENESUSO'`, 30);

  // 2. Depositos y ubicaciones (para ubicar "Casa Central")
  await q('Depositos', `SELECT * FROM Depositos`, 40);
  await q('COLUMNAS Ubicaciones (si existe)', `
    SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME LIKE '%Ubicacion%' ORDER BY TABLE_NAME, ORDINAL_POSITION`, 40);

  // 3. El detalle REAL del movimiento BIENESUSO ya existente (Numero 1, Sucursal 11)
  await q('Detalle real BIENESUSO (Sucursal 11, Numero 1)', `
    SELECT * FROM MovimientosStockProductos
    WHERE IdTipoMovimiento='BIENESUSO'`, 40);

  // 4. Stock actual del producto 1010 por deposito (para verificar luego)
  await q('Stock actual producto 1010 (ProductosDepositos)', `
    SELECT * FROM ProductosDepositos WHERE IdProducto='1010'`, 40);

  await pool.close();
  process.exit(0);
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
