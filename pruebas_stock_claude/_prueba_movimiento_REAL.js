// ─────────────────────────────────────────────────────────────────────────────
// PRUEBA REAL (COMMIT) — net-zero: +2.5 y luego -2.5 sobre el producto 1010.
// Hace DOS movimientos internos reales en Siga. El stock vuelve a su valor original.
// ─────────────────────────────────────────────────────────────────────────────
const sql = require('mssql/msnodesqlv8');
const DB_CONFIG = { connectionString:
  'Driver={ODBC Driver 17 for SQL Server};Server=servidorapidelta\\SQLSTANDARD;' +
  'Database=Siga;UID=apidelta_stock;PWD=apd706;TrustServerCertificate=yes;' };

const BASE = {
  IdSucursal: 1, IdDeposito: 1, IdUbicacion: 1,
  IdTipoMovimiento: 'BIENESUSO', IdProducto: '1010',
  IdEmpleado: 1, Usuario: 'Adriel'
};

async function leerStock(pool) {
  const dep = (await pool.request().query(`SELECT Stock FROM ProductosDepositos
    WHERE IdProducto='${BASE.IdProducto}' AND IdSucursal=${BASE.IdSucursal} AND IdDeposito=${BASE.IdDeposito}`)).recordset[0].Stock;
  const ubi = (await pool.request().query(`SELECT Stock FROM ProductosUbicaciones
    WHERE IdProducto='${BASE.IdProducto}' AND IdSucursal=${BASE.IdSucursal} AND IdDeposito=${BASE.IdDeposito} AND IdUbicacion=${BASE.IdUbicacion}`)).recordset[0].Stock;
  return { dep, ubi };
}

async function hacerMovimiento(pool, cantidad, observacion) {
  const coef = (await pool.request().query(
    `SELECT CoeficienteStock FROM TiposMovimientos WHERE IdTipoMovimiento='${BASE.IdTipoMovimiento}'`)).recordset[0].CoeficienteStock;
  const delta = cantidad * coef;

  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const rq = () => new sql.Request(tx);
    const num = (await rq().query(`UPDATE MovimientosNumeros SET Numero = Numero + 1
      OUTPUT inserted.Numero AS Numero
      WHERE IdSucursal=${BASE.IdSucursal} AND IdTipoMovimiento='${BASE.IdTipoMovimiento}'`)).recordset[0].Numero;

    await rq().query(`INSERT INTO MovimientosStock
      (IdSucursal, IdTipoMovimiento, NumeroMovimiento, FechaMovimiento, Neto, Total, PorcentajeIVA,
       Usuario, Observacion, IdEmpleado, PercepcionIVA, PercepcionIB, PercepcionGanancias, PercepcionVarias, ImpuestosInternos)
      VALUES (${BASE.IdSucursal},'${BASE.IdTipoMovimiento}',${num},GETDATE(),0,0,0,
       '${BASE.Usuario}','${observacion}',${BASE.IdEmpleado},0,0,0,0,0)`);

    await rq().query(`INSERT INTO MovimientosStockProductos
      (IdSucursal, IdDeposito, IdUbicacion, IdTipoMovimiento, NumeroMovimiento, IdProducto, Cantidad, Cantidad2, Precio, Orden)
      VALUES (${BASE.IdSucursal},${BASE.IdDeposito},${BASE.IdUbicacion},'${BASE.IdTipoMovimiento}',${num},'${BASE.IdProducto}',${cantidad},0,0,1)`);

    await rq().query(`UPDATE ProductosDepositos SET Stock = Stock + ${delta}
      WHERE IdProducto='${BASE.IdProducto}' AND IdSucursal=${BASE.IdSucursal} AND IdDeposito=${BASE.IdDeposito}`);

    await rq().query(`UPDATE ProductosUbicaciones SET Stock = Stock + ${delta}
      WHERE IdProducto='${BASE.IdProducto}' AND IdSucursal=${BASE.IdSucursal} AND IdDeposito=${BASE.IdDeposito} AND IdUbicacion=${BASE.IdUbicacion}`);

    await tx.commit();
    return num;
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}

(async () => {
  const pool = await sql.connect(DB_CONFIG);

  const inicial = await leerStock(pool);
  console.log(`Stock INICIAL  -> deposito: ${inicial.dep}  ubicacion: ${inicial.ubi}`);

  // Movimiento 1: ENTRADA +2.5
  const n1 = await hacerMovimiento(pool, 2.5, 'PRUEBA API - entrada +2.5');
  const trasEntrada = await leerStock(pool);
  console.log(`\n✅ Movimiento ENTRADA #${n1} (+2.5) COMMIT`);
  console.log(`   Stock ahora -> deposito: ${trasEntrada.dep}  ubicacion: ${trasEntrada.ubi}`);

  // Movimiento 2: SALIDA -2.5
  const n2 = await hacerMovimiento(pool, -2.5, 'PRUEBA API - salida -2.5');
  const final = await leerStock(pool);
  console.log(`\n✅ Movimiento SALIDA #${n2} (-2.5) COMMIT`);
  console.log(`   Stock ahora -> deposito: ${final.dep}  ubicacion: ${final.ubi}`);

  const ok = Number(final.dep) === Number(inicial.dep) && Number(final.ubi) === Number(inicial.ubi);
  console.log(`\n──────────── RESULTADO ────────────`);
  console.log(`Movimientos creados: #${n1} (+2.5) y #${n2} (-2.5)`);
  console.log(`Stock ${ok ? 'VOLVIO al valor inicial ✅' : '⚠️ NO coincide con el inicial'}: ${inicial.dep} -> ${final.dep}`);
  console.log(`Podes verlos en SiGA: Stock -> Movimientos de Stock (numeros ${n1} y ${n2}).`);

  await pool.close();
  process.exit(0);
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
