'use strict';
const sql = require('mssql/msnodesqlv8');

const DB_CONFIG = {
  connectionString:
    'Driver={ODBC Driver 17 for SQL Server};' +
    'Server=servidorapidelta\\SQLSTANDARD;'   +
    'Database=Siga;'                           +
    'UID=apidelta;'                            +
    'PWD=apd706;'                              +
    'TrustServerCertificate=yes;',
  requestTimeout: 120000
};

(async () => {
  const pool = await sql.connect(DB_CONFIG);

  const frag = await pool.request().query(`
    SELECT OBJECT_NAME(ips.object_id) AS Tabla, i.name AS Indice,
           ips.avg_fragmentation_in_percent AS FragPct, ips.page_count AS Paginas
    FROM sys.dm_db_index_physical_stats(DB_ID(), NULL, NULL, NULL, 'LIMITED') ips
    JOIN sys.indexes i ON i.object_id = ips.object_id AND i.index_id = ips.index_id
    WHERE ips.avg_fragmentation_in_percent > 30 AND ips.page_count > 1000
    ORDER BY ips.avg_fragmentation_in_percent DESC;
  `);

  const statsAge = await pool.request().query(`
    SELECT OBJECT_NAME(s.object_id) AS Tabla, s.name AS Stat,
           STATS_DATE(s.object_id, s.stats_id) AS UltimaActualizacion,
           sp.rows, sp.modification_counter AS FilasModificadas
    FROM sys.stats s
    CROSS APPLY sys.dm_db_stats_properties(s.object_id, s.stats_id) sp
    WHERE sp.modification_counter > 0
    ORDER BY sp.modification_counter DESC;
  `);

  const dbSize = await pool.request().query(`
    SELECT name AS Archivo, size/128.0 AS TamañoMB,
           CAST(FILEPROPERTY(name, 'SpaceUsed') AS int)/128.0 AS UsadoMB
    FROM sys.database_files;
  `);

  console.log('=== FRAGMENTACION (>30%, >1000 paginas) ===');
  console.log(JSON.stringify(frag.recordset, null, 2));
  console.log('Total indices con fragmentacion alta:', frag.recordset.length);

  console.log('\n=== STATS MAS DESACTUALIZADAS (top 20 por filas modificadas) ===');
  console.log(JSON.stringify(statsAge.recordset.slice(0, 20), null, 2));

  console.log('\n=== TAMAÑO ARCHIVOS DB ===');
  console.log(JSON.stringify(dbSize.recordset, null, 2));

  await pool.close();
  process.exit(0);
})().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
