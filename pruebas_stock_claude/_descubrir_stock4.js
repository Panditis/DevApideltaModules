// Script DESCARTABLE de solo lectura — paso 4: cierre de dudas (ubicaciones + cabecera real).
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

  // 1. ¿El producto 1010 tiene stock por UBICACION? (para saber si hay que actualizar ProductosUbicaciones)
  await q('ProductosUbicaciones para 1010', `
    SELECT * FROM ProductosUbicaciones WHERE IdProducto='1010'`, 20);

  // 2. ¿Cuantas filas tiene ProductosUbicaciones en total? (para saber si la tabla se usa)
  await q('¿Se usa ProductosUbicaciones?', `
    SELECT COUNT(*) AS total_filas,
           SUM(CASE WHEN Stock<>0 THEN 1 ELSE 0 END) AS filas_con_stock
    FROM ProductosUbicaciones`, 5);

  // 3. Ubicaciones definidas para Sucursal 1 / Deposito 1
  await q('SucursalesUbicaciones (Suc 1, Dep 1)', `
    SELECT IdSucursal, IdDeposito, IdUbicacion, NombreUbicacion, EstadoUbicacion, Activo
    FROM SucursalesUbicaciones WHERE IdSucursal=1 AND IdDeposito=1`, 20);

  // 4. Cabecera REAL de un BIENESUSO de Casa Central (Sucursal 1) — ver Neto/Total/campos
  await q('Cabecera real BIENESUSO Suc 1 (ultimas 5)', `
    SELECT TOP 5 IdSucursal, IdTipoMovimiento, NumeroMovimiento, FechaMovimiento,
           Neto, Total, PorcentajeIVA, Usuario, Observacion, IdEmpleado,
           PercepcionIVA, PercepcionIB, PercepcionGanancias, PercepcionVarias, ImpuestosInternos,
           IdTipoComprobante, IdCliente, IdSucursal2
    FROM MovimientosStock
    WHERE IdSucursal=1 AND IdTipoMovimiento='BIENESUSO'
    ORDER BY NumeroMovimiento DESC`, 5);

  // 5. Confirmar que el contador = max numero usado (para saber si proximo = contador+1)
  await q('Contador vs Max numero (Suc 1 BIENESUSO)', `
    SELECT
      (SELECT Numero FROM MovimientosNumeros WHERE IdSucursal=1 AND IdTipoMovimiento='BIENESUSO') AS contador,
      (SELECT MAX(CAST(NumeroMovimiento AS bigint)) FROM MovimientosStock WHERE IdSucursal=1 AND IdTipoMovimiento='BIENESUSO') AS max_numero_usado`, 5);

  await pool.close();
  process.exit(0);
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
