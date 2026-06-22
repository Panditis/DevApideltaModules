// ─────────────────────────────────────────────────────────────────────────────
// PRUEBA EN SECO (DRY-RUN) — Traslado entre depositos (1 -> 2) del producto 1010.
// Modelo de 2 lineas (origen -Q, destino +Q) con tipo BIENESUSO.
// Crea la fila de stock en el destino si no existe. Termina en ROLLBACK => no escribe nada.
// ─────────────────────────────────────────────────────────────────────────────
const sql = require('mssql/msnodesqlv8');
const DB_CONFIG = { connectionString:
  'Driver={ODBC Driver 17 for SQL Server};Server=servidorapidelta\\SQLSTANDARD;' +
  'Database=Siga;UID=apidelta_stock;PWD=apd706;TrustServerCertificate=yes;' };

const P = {
  IdSucursal: 1,
  IdTipoMovimiento: 'BIENESUSO',
  IdProducto: '1010',
  Cantidad: 2.5,
  DepOrigen: 1,
  DepDestino: 2,
  IdEmpleado: 1,
  Usuario: 'Adriel',
  Observacion: 'PRUEBA API - traslado dep 1->2 (dry run)'
};

async function ubicacionDe(rq, dep) {
  const r = await rq().query(`SELECT TOP 1 IdUbicacion FROM SucursalesUbicaciones
    WHERE IdSucursal=${P.IdSucursal} AND IdDeposito=${dep} AND Activo=1 ORDER BY IdUbicacion`);
  return r.recordset.length ? r.recordset[0].IdUbicacion : 1;
}
async function stockDep(rq, dep) {
  const r = await rq().query(`SELECT Stock FROM ProductosDepositos
    WHERE IdProducto='${P.IdProducto}' AND IdSucursal=${P.IdSucursal} AND IdDeposito=${dep}`);
  return r.recordset.length ? r.recordset[0].Stock : '(sin fila)';
}
// upsert de stock en ProductosDepositos y ProductosUbicaciones
async function aplicarStock(rq, dep, ubic, delta) {
  await rq().query(`
    IF EXISTS (SELECT 1 FROM ProductosDepositos WHERE IdProducto='${P.IdProducto}' AND IdSucursal=${P.IdSucursal} AND IdDeposito=${dep})
      UPDATE ProductosDepositos SET Stock = Stock + (${delta})
        WHERE IdProducto='${P.IdProducto}' AND IdSucursal=${P.IdSucursal} AND IdDeposito=${dep};
    ELSE
      INSERT INTO ProductosDepositos (IdProducto, IdSucursal, IdDeposito, Stock, Stock2)
        VALUES ('${P.IdProducto}', ${P.IdSucursal}, ${dep}, ${delta}, 0);`);
  await rq().query(`
    IF EXISTS (SELECT 1 FROM ProductosUbicaciones WHERE IdProducto='${P.IdProducto}' AND IdSucursal=${P.IdSucursal} AND IdDeposito=${dep} AND IdUbicacion=${ubic})
      UPDATE ProductosUbicaciones SET Stock = Stock + (${delta})
        WHERE IdProducto='${P.IdProducto}' AND IdSucursal=${P.IdSucursal} AND IdDeposito=${dep} AND IdUbicacion=${ubic};
    ELSE
      INSERT INTO ProductosUbicaciones (IdProducto, IdSucursal, IdDeposito, IdUbicacion, Stock, Stock2)
        VALUES ('${P.IdProducto}', ${P.IdSucursal}, ${dep}, ${ubic}, ${delta}, 0);`);
}

(async () => {
  const pool = await sql.connect(DB_CONFIG);
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const rq = () => new sql.Request(tx);
    const ubicOrigen  = await ubicacionDe(rq, P.DepOrigen);
    const ubicDestino = await ubicacionDe(rq, P.DepDestino);
    console.log(`Ubicacion origen (dep ${P.DepOrigen}): ${ubicOrigen} | destino (dep ${P.DepDestino}): ${ubicDestino}`);

    const oAntes = await stockDep(rq, P.DepOrigen);
    const dAntes = await stockDep(rq, P.DepDestino);
    console.log(`\nStock ANTES -> dep ${P.DepOrigen}: ${oAntes} | dep ${P.DepDestino}: ${dAntes}`);

    // Reservar numero
    const num = (await rq().query(`UPDATE MovimientosNumeros SET Numero = Numero + 1
      OUTPUT inserted.Numero AS Numero
      WHERE IdSucursal=${P.IdSucursal} AND IdTipoMovimiento='${P.IdTipoMovimiento}'`)).recordset[0].Numero;

    // Cabecera
    await rq().query(`INSERT INTO MovimientosStock
      (IdSucursal, IdTipoMovimiento, NumeroMovimiento, FechaMovimiento, Neto, Total, PorcentajeIVA,
       Usuario, Observacion, IdEmpleado, PercepcionIVA, PercepcionIB, PercepcionGanancias, PercepcionVarias, ImpuestosInternos)
      VALUES (${P.IdSucursal},'${P.IdTipoMovimiento}',${num},GETDATE(),0,0,0,
       '${P.Usuario}','${P.Observacion}',${P.IdEmpleado},0,0,0,0,0)`);

    // Detalle linea 1: origen -Q
    await rq().query(`INSERT INTO MovimientosStockProductos
      (IdSucursal, IdDeposito, IdUbicacion, IdTipoMovimiento, NumeroMovimiento, IdProducto, Cantidad, Cantidad2, Precio, Orden)
      VALUES (${P.IdSucursal},${P.DepOrigen},${ubicOrigen},'${P.IdTipoMovimiento}',${num},'${P.IdProducto}',${-P.Cantidad},0,0,1)`);
    // Detalle linea 2: destino +Q
    await rq().query(`INSERT INTO MovimientosStockProductos
      (IdSucursal, IdDeposito, IdUbicacion, IdTipoMovimiento, NumeroMovimiento, IdProducto, Cantidad, Cantidad2, Precio, Orden)
      VALUES (${P.IdSucursal},${P.DepDestino},${ubicDestino},'${P.IdTipoMovimiento}',${num},'${P.IdProducto}',${P.Cantidad},0,0,2)`);

    // Stock: -Q en origen, +Q en destino (coef BIENESUSO = +1)
    await aplicarStock(rq, P.DepOrigen,  ubicOrigen,  -P.Cantidad);
    await aplicarStock(rq, P.DepDestino, ubicDestino,  P.Cantidad);

    const oDesp = await stockDep(rq, P.DepOrigen);
    const dDesp = await stockDep(rq, P.DepDestino);
    console.log(`Stock DESPUES-> dep ${P.DepOrigen}: ${oDesp} | dep ${P.DepDestino}: ${dDesp}`);
    console.log(`\nNumero de comprobante que se reservaria: ${num}`);

    await tx.rollback();
    console.log('\n✅ ROLLBACK ejecutado: NO se escribio nada. Si los numeros estan bien, el real funciona igual con COMMIT.');
  } catch (e) {
    await tx.rollback();
    console.log('\n❌ ERROR (se revirtio todo):', e.message);
  }
  await pool.close();
  process.exit(0);
})().catch(e => { console.error('FALLO conexion:', e.message); process.exit(1); });
