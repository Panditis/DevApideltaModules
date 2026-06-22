// ─────────────────────────────────────────────────────────────────────────────
// PRUEBA REAL (COMMIT) — Traslado net-zero entre depositos del producto 1010:
//   1) 2.5 del dep 1 -> dep 2     2) 2.5 del dep 2 -> dep 1
// El stock vuelve a su estado original. Crea 2 comprobantes BIENESUSO de 2 lineas.
// ─────────────────────────────────────────────────────────────────────────────
const sql = require('mssql/msnodesqlv8');
const DB_CONFIG = { connectionString:
  'Driver={ODBC Driver 17 for SQL Server};Server=servidorapidelta\\SQLSTANDARD;' +
  'Database=Siga;UID=apidelta_stock;PWD=apd706;TrustServerCertificate=yes;' };

const BASE = { IdSucursal: 1, IdTipoMovimiento: 'BIENESUSO', IdProducto: '1010',
               IdEmpleado: 1, Usuario: 'Adriel' };

async function ubicacionDe(rq, dep) {
  const r = await rq().query(`SELECT TOP 1 IdUbicacion FROM SucursalesUbicaciones
    WHERE IdSucursal=${BASE.IdSucursal} AND IdDeposito=${dep} AND Activo=1 ORDER BY IdUbicacion`);
  return r.recordset.length ? r.recordset[0].IdUbicacion : 1;
}
async function stockDep(pool, dep) {
  const r = await pool.request().query(`SELECT Stock FROM ProductosDepositos
    WHERE IdProducto='${BASE.IdProducto}' AND IdSucursal=${BASE.IdSucursal} AND IdDeposito=${dep}`);
  return r.recordset.length ? Number(r.recordset[0].Stock) : 0;
}
async function aplicarStock(rq, dep, ubic, delta) {
  await rq().query(`
    IF EXISTS (SELECT 1 FROM ProductosDepositos WHERE IdProducto='${BASE.IdProducto}' AND IdSucursal=${BASE.IdSucursal} AND IdDeposito=${dep})
      UPDATE ProductosDepositos SET Stock = Stock + (${delta}) WHERE IdProducto='${BASE.IdProducto}' AND IdSucursal=${BASE.IdSucursal} AND IdDeposito=${dep};
    ELSE
      INSERT INTO ProductosDepositos (IdProducto, IdSucursal, IdDeposito, Stock, Stock2) VALUES ('${BASE.IdProducto}', ${BASE.IdSucursal}, ${dep}, ${delta}, 0);`);
  await rq().query(`
    IF EXISTS (SELECT 1 FROM ProductosUbicaciones WHERE IdProducto='${BASE.IdProducto}' AND IdSucursal=${BASE.IdSucursal} AND IdDeposito=${dep} AND IdUbicacion=${ubic})
      UPDATE ProductosUbicaciones SET Stock = Stock + (${delta}) WHERE IdProducto='${BASE.IdProducto}' AND IdSucursal=${BASE.IdSucursal} AND IdDeposito=${dep} AND IdUbicacion=${ubic};
    ELSE
      INSERT INTO ProductosUbicaciones (IdProducto, IdSucursal, IdDeposito, IdUbicacion, Stock, Stock2) VALUES ('${BASE.IdProducto}', ${BASE.IdSucursal}, ${dep}, ${ubic}, ${delta}, 0);`);
}

async function trasladar(pool, depOrigen, depDestino, cantidad, observacion) {
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const rq = () => new sql.Request(tx);
    const ubicO = await ubicacionDe(rq, depOrigen);
    const ubicD = await ubicacionDe(rq, depDestino);
    const num = (await rq().query(`UPDATE MovimientosNumeros SET Numero = Numero + 1
      OUTPUT inserted.Numero AS Numero
      WHERE IdSucursal=${BASE.IdSucursal} AND IdTipoMovimiento='${BASE.IdTipoMovimiento}'`)).recordset[0].Numero;
    await rq().query(`INSERT INTO MovimientosStock
      (IdSucursal, IdTipoMovimiento, NumeroMovimiento, FechaMovimiento, Neto, Total, PorcentajeIVA,
       Usuario, Observacion, IdEmpleado, PercepcionIVA, PercepcionIB, PercepcionGanancias, PercepcionVarias, ImpuestosInternos)
      VALUES (${BASE.IdSucursal},'${BASE.IdTipoMovimiento}',${num},GETDATE(),0,0,0,'${BASE.Usuario}','${observacion}',${BASE.IdEmpleado},0,0,0,0,0)`);
    await rq().query(`INSERT INTO MovimientosStockProductos
      (IdSucursal, IdDeposito, IdUbicacion, IdTipoMovimiento, NumeroMovimiento, IdProducto, Cantidad, Cantidad2, Precio, Orden)
      VALUES (${BASE.IdSucursal},${depOrigen},${ubicO},'${BASE.IdTipoMovimiento}',${num},'${BASE.IdProducto}',${-cantidad},0,0,1)`);
    await rq().query(`INSERT INTO MovimientosStockProductos
      (IdSucursal, IdDeposito, IdUbicacion, IdTipoMovimiento, NumeroMovimiento, IdProducto, Cantidad, Cantidad2, Precio, Orden)
      VALUES (${BASE.IdSucursal},${depDestino},${ubicD},'${BASE.IdTipoMovimiento}',${num},'${BASE.IdProducto}',${cantidad},0,0,2)`);
    await aplicarStock(rq, depOrigen,  ubicO, -cantidad);
    await aplicarStock(rq, depDestino, ubicD,  cantidad);
    await tx.commit();
    return num;
  } catch (e) { await tx.rollback(); throw e; }
}

(async () => {
  const pool = await sql.connect(DB_CONFIG);
  const ini1 = await stockDep(pool, 1), ini2 = await stockDep(pool, 2);
  console.log(`Stock INICIAL -> dep 1: ${ini1} | dep 2: ${ini2}`);

  const n1 = await trasladar(pool, 1, 2, 2.5, 'PRUEBA API - traslado dep 1->2');
  console.log(`\n✅ Traslado #${n1}: 2.5 de dep 1 -> dep 2 (COMMIT)`);
  console.log(`   Stock -> dep 1: ${await stockDep(pool,1)} | dep 2: ${await stockDep(pool,2)}`);

  const n2 = await trasladar(pool, 2, 1, 2.5, 'PRUEBA API - traslado dep 2->1 (revierte)');
  console.log(`\n✅ Traslado #${n2}: 2.5 de dep 2 -> dep 1 (COMMIT)`);
  const fin1 = await stockDep(pool, 1), fin2 = await stockDep(pool, 2);
  console.log(`   Stock -> dep 1: ${fin1} | dep 2: ${fin2}`);

  const ok = fin1 === ini1 && fin2 === ini2;
  console.log(`\n──────────── RESULTADO ────────────`);
  console.log(`Comprobantes creados: #${n1} (1->2) y #${n2} (2->1)`);
  console.log(`Stock ${ok ? 'VOLVIO al estado inicial ✅' : '⚠️ NO coincide'}: dep1 ${ini1}->${fin1}, dep2 ${ini2}->${fin2}`);
  console.log(`Verificalos en SiGA: Stock -> Movimientos de Stock (numeros ${n1} y ${n2}).`);

  await pool.close();
  process.exit(0);
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
