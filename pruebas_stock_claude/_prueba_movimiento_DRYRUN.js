// ─────────────────────────────────────────────────────────────────────────────
// PRUEBA EN SECO (DRY-RUN) de un Movimiento Interno en Siga.
// Ejecuta TODA la transacción y al final hace ROLLBACK => NO escribe nada.
// Sirve para comprobar que la lógica es correcta sin tocar la base real.
// ─────────────────────────────────────────────────────────────────────────────
const sql = require('mssql/msnodesqlv8');
const DB_CONFIG = {
  connectionString:
    'Driver={ODBC Driver 17 for SQL Server};' +
    'Server=servidorapidelta\\SQLSTANDARD;'   +
    'Database=Siga;'                           +
    'UID=apidelta_stock;PWD=apd706;TrustServerCertificate=yes;'  // usuario con permisos de escritura
};

// ── Parámetros del movimiento de prueba ──────────────────────────────────────
const P = {
  IdSucursal: 1,           // Casa Central
  IdDeposito: 1,
  IdUbicacion: 1,          // "Unica"
  IdTipoMovimiento: 'BIENESUSO',  // "Movimientos internos"
  IdProducto: '1010',      // Tutuca Maiz 100G
  Cantidad: 2.5,           // a sumar (coeficiente +1)
  IdEmpleado: 1,
  Usuario: 'Adriel',       // se valida contra Usuarios mas abajo
  Observacion: 'PRUEBA API - dry run (se revierte)'
};

(async () => {
  const pool = await sql.connect(DB_CONFIG);

  // 0. Validar usuario y coeficiente (lectura)
  const usuarios = (await pool.request().query(
    `SELECT Id FROM Usuarios WHERE Activo=1`)).recordset.map(r => r.Id);
  const coef = (await pool.request().query(
    `SELECT CoeficienteStock FROM TiposMovimientos WHERE IdTipoMovimiento='${P.IdTipoMovimiento}'`)
    ).recordset[0].CoeficienteStock;
  const usuarioValido = usuarios.includes(P.Usuario);
  const usuarioUsar = usuarioValido ? P.Usuario : usuarios[0];
  const delta = P.Cantidad * coef;

  console.log('Usuarios disponibles (muestra):', usuarios.join(', '));
  console.log(`Usuario solicitado '${P.Usuario}' valido?:`, usuarioValido, '=> se usara:', usuarioUsar);
  console.log('CoeficienteStock:', coef, '=> delta de stock:', delta);

  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const rq = () => new sql.Request(tx);

    // Stock ANTES
    const antesDep = (await rq().query(`SELECT Stock FROM ProductosDepositos
      WHERE IdProducto='${P.IdProducto}' AND IdSucursal=${P.IdSucursal} AND IdDeposito=${P.IdDeposito}`)).recordset[0];
    const antesUbi = (await rq().query(`SELECT Stock FROM ProductosUbicaciones
      WHERE IdProducto='${P.IdProducto}' AND IdSucursal=${P.IdSucursal} AND IdDeposito=${P.IdDeposito} AND IdUbicacion=${P.IdUbicacion}`)).recordset[0];

    // 1. Reservar numero atomicamente
    const num = (await rq().query(`UPDATE MovimientosNumeros SET Numero = Numero + 1
      OUTPUT inserted.Numero AS Numero
      WHERE IdSucursal=${P.IdSucursal} AND IdTipoMovimiento='${P.IdTipoMovimiento}'`)).recordset[0].Numero;

    // 2. Cabecera
    await rq().query(`INSERT INTO MovimientosStock
      (IdSucursal, IdTipoMovimiento, NumeroMovimiento, FechaMovimiento, Neto, Total, PorcentajeIVA,
       Usuario, Observacion, IdEmpleado, PercepcionIVA, PercepcionIB, PercepcionGanancias, PercepcionVarias, ImpuestosInternos)
      VALUES (${P.IdSucursal},'${P.IdTipoMovimiento}',${num},GETDATE(),0,0,0,
       '${usuarioUsar}','${P.Observacion}',${P.IdEmpleado},0,0,0,0,0)`);

    // 3. Detalle
    await rq().query(`INSERT INTO MovimientosStockProductos
      (IdSucursal, IdDeposito, IdUbicacion, IdTipoMovimiento, NumeroMovimiento, IdProducto, Cantidad, Cantidad2, Precio, Orden)
      VALUES (${P.IdSucursal},${P.IdDeposito},${P.IdUbicacion},'${P.IdTipoMovimiento}',${num},'${P.IdProducto}',${P.Cantidad},0,0,1)`);

    // 4. Stock por deposito
    await rq().query(`UPDATE ProductosDepositos SET Stock = Stock + ${delta}
      WHERE IdProducto='${P.IdProducto}' AND IdSucursal=${P.IdSucursal} AND IdDeposito=${P.IdDeposito}`);

    // 5. Stock por ubicacion
    await rq().query(`UPDATE ProductosUbicaciones SET Stock = Stock + ${delta}
      WHERE IdProducto='${P.IdProducto}' AND IdSucursal=${P.IdSucursal} AND IdDeposito=${P.IdDeposito} AND IdUbicacion=${P.IdUbicacion}`);

    // Stock DESPUES (dentro de la transaccion)
    const despDep = (await rq().query(`SELECT Stock FROM ProductosDepositos
      WHERE IdProducto='${P.IdProducto}' AND IdSucursal=${P.IdSucursal} AND IdDeposito=${P.IdDeposito}`)).recordset[0];
    const despUbi = (await rq().query(`SELECT Stock FROM ProductosUbicaciones
      WHERE IdProducto='${P.IdProducto}' AND IdSucursal=${P.IdSucursal} AND IdDeposito=${P.IdDeposito} AND IdUbicacion=${P.IdUbicacion}`)).recordset[0];

    console.log('\n──────────── RESULTADO SIMULADO ────────────');
    console.log('Numero de movimiento que se reservaria:', num);
    console.log(`ProductosDepositos.Stock:   ${antesDep.Stock}  ->  ${despDep.Stock}`);
    console.log(`ProductosUbicaciones.Stock: ${antesUbi.Stock}  ->  ${despUbi.Stock}`);

    // ⛔ NO COMMIT — se revierte todo
    await tx.rollback();
    console.log('\n✅ ROLLBACK ejecutado: NO se escribio absolutamente nada en la base.');
    console.log('   (Si los numeros de arriba son correctos, el endpoint real funcionara igual pero con COMMIT.)');
  } catch (e) {
    await tx.rollback();
    console.log('\n❌ ERROR durante la prueba (se revirtio todo):', e.message);
  }
  await pool.close();
  process.exit(0);
})().catch(e => { console.error('FALLO conexion:', e.message); process.exit(1); });
