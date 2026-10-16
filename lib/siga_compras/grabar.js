'use strict';
// repo.grabar: ejecuta las filas de armar_comprobante.js en UNA transacción con getPoolStock (apidelta_stock),
// en el orden de SiGA (DOC Parte II §1.3), con el SQL de los Eniac.SqlServer.*.cs descompilados pero con
// parámetros (request.input) en vez de valores concatenados. Separado de repo.js para que ningún archivo pase de
// 400 líneas. Fuente: docs/siga_compras_carga_descompilado.md (DOC).
const { LOCK, sqlDuplicadoCompras, sqlDuplicadoCtaCte, SQL_VENTAS_NUMEROS_G1, conParametros, ErrorSiga } = require('./sql_comun');

// SucursalDeposito.TiposDepositos.OPERATIVO (SqlServer.ProductosSucursales_UStock L273).
const TIPO_DEPOSITO_OPERATIVO = 'OPERATIVO';

const MENSAJE_SIN_CONFIRMAR = 'No se pudo confirmar la grabación del comprobante en SIGA: verificá en SiGA antes de reintentar.';

// Tabla y columnas son constantes del código (filas de armar_comprobante.js), nunca entrada del usuario;
// los valores van siempre como parámetros (nombre del parámetro = nombre de la columna).
function insertar(ejecutar, tabla, fila) {
  const columnas = Object.keys(fila);
  if (!columnas.every(c => /^\w+$/.test(c))) throw new Error(`Columna inválida en ${tabla}`);
  return ejecutar(`INSERT INTO ${tabla} (${columnas.join(', ')}) VALUES (${columnas.map(c => '@' + c).join(', ')})`, fila);
}

// Parámetros de Compras.Existe / CuentasCorrientesProv.Existe con idSucursal = 0: cualquier sucursal,
// (InformaLibroIVA OR misma empresa).
const paramsExiste = (clave, numeracion) => ({
  idProveedor: clave.IdProveedor, idTipoComprobante: clave.IdTipoComprobante, letra: clave.Letra,
  centroEmisor: clave.CentroEmisor, numeroComprobante: clave.NumeroComprobante, idEmpresa: numeracion.idEmpresa,
});

// Numeración y duplicado en Compras DENTRO de la transacción, con UPDLOCK/HOLDLOCK (SiGA no bloquea: DOC Parte II
// §2), antes del INSERT de Compras cuya clave protegen. El aviso previo de la pantalla (ctx.duplicado) no cuenta:
// acá se vuelve a controlar siempre.
// ponytail: HOLDLOCK sin IdSucursal bloquea un rango ancho de Compras; alcanza para la carga manual, si hubiera
// concurrencia alta conviene un índice por (IdProveedor, IdTipoComprobante, Letra, CentroEmisor, NumeroComprobante).
async function claveDefinitiva(ejecutar, { clave, numeracion }) {
  if (numeracion.modo === 'proveedor') {
    // Reglas.Compras.GetProximoNumero (L642-661): MAX + 1 por proveedor, sucursal, tipo, letra y emisor.
    const r = await ejecutar(`SELECT ISNULL(MAX(C.NumeroComprobante), 0) + 1 AS Siguiente FROM Compras C ${LOCK}
     WHERE C.IdProveedor = @idProveedor AND C.IdSucursal = @idSucursal AND C.IdTipoComprobante = @idTipoComprobante
       AND C.Letra = @letra AND C.CentroEmisor = @centroEmisor`, {
      idProveedor: clave.IdProveedor, idSucursal: clave.IdSucursal, idTipoComprobante: clave.IdTipoComprobante,
      letra: clave.Letra, centroEmisor: clave.CentroEmisor,
    });
    return { ...clave, NumeroComprobante: Number(r.recordset[0].Siguiente) };
  }
  if (numeracion.modo !== 'manual') throw new ErrorSiga(`v1: numeración ${numeracion.modo} no soportada.`);
  if ((await ejecutar(sqlDuplicadoCompras(LOCK), paramsExiste(clave, numeracion))).recordset.length) {
    throw new ErrorSiga('Este comprobante ya fue INGRESADO con ANTERIORIDAD');
  }
  return clave;
}

// DOC Parte I §7 #20: en la carga, el control de cta. cte. es el de la pantalla, CuentasCorrientesProv.Existe(0, …)
// (Win L23004; SqlServer.CuentasCorrientesProv L295-330), solo con numeración manual. Va con lock justo antes de
// escribir la cta. cte. (orden de locks de SiGA) y corre aunque las filas no traigan cta. cte., como la pantalla.
async function controlarDuplicadoCtaCte(ejecutar, clave, numeracion) {
  if (numeracion.modo !== 'manual') return;
  if ((await ejecutar(sqlDuplicadoCtaCte(LOCK), paramsExiste(clave, numeracion))).recordset.length) {
    throw new ErrorSiga('Este comprobante ya EXISTE en Cuentas Corrientes de Proveedores');
  }
}

// Paso 2 de Reglas.Compras.Existe (L1655-1660): con fila en VentasNumeros_G1 la v1 no importa (validaciones ya lo
// bloquea con el contexto; acá se repite por si apareció entre la validación y la grabación). Sin lock: si hay fila
// se aborta, así que no hay nada que proteger hasta el commit.
// ponytail: por eso no hay UPDATE de VentasNumeros (DOC paso 4d): VentasNumeros.GetUno(tipo, letra, emisor) usa
// este mismo VentasNumeros_G1 (WHERE idéntico), así que si llegamos a grabar no hay fila que actualizar. Si la v2
// deja pasar numeración compartida, agregar ahí el UPDATE de VentasNumeros_U.
async function controlarNumeracionCompartida(ejecutar, clave, numeracion) {
  const r = await ejecutar(SQL_VENTAS_NUMEROS_G1, {
    idEmpresa: numeracion.idEmpresa, idTipoComprobante: clave.IdTipoComprobante, letra: clave.Letra, centroEmisor: clave.CentroEmisor,
  });
  if (r.recordset.length) {
    throw new ErrorSiga('v1: el tipo, letra y punto de venta comparten numeración con ventas (VentasNumeros); cargalo desde SiGA.');
  }
}

// DOC Parte II §1.3 paso 1 (MovimientosStock L252): GetUltimoNroMovimiento + 1, leído con lock.
async function leerNumeroMovimiento(ejecutar, idSucursal, idTipoMovimiento) {
  const r = await ejecutar(`SELECT Numero FROM MovimientosNumeros ${LOCK} WHERE IdSucursal = @idSucursal AND IdTipoMovimiento = @idTipoMovimiento`,
    { idSucursal, idTipoMovimiento });
  return (r.recordset[0] ? Number(r.recordset[0].Numero) : 0) + 1;
}

// SqlServer.MovimientosNumeros_U (L14-49): IF NOT EXISTS → INSERT; después UPDATE. Dos sentencias, como SiGA.
async function guardarNumeroMovimiento(ejecutar, params) {
  await ejecutar(`IF NOT EXISTS (SELECT Numero FROM MovimientosNumeros WHERE IdSucursal = @idSucursal AND IdTipoMovimiento = @idTipoMovimiento) BEGIN INSERT INTO MovimientosNumeros (IdSucursal, IdTipoMovimiento, Numero) VALUES (@idSucursal, @idTipoMovimiento, @numero) END`, params);
  await ejecutar('UPDATE MovimientosNumeros SET Numero = @numero WHERE IdSucursal = @idSucursal AND IdTipoMovimiento = @idTipoMovimiento', params);
}

// DOC Anexo PeriodosFiscales_UPosicion (SqlServer.PeriodosFiscales L164-194): dos sentencias; 0 filas en la
// primera → período no habilitado (mensaje literal de SiGA).
async function actualizarPeriodoFiscal(ejecutar, p) {
  const r = await ejecutar(`UPDATE PeriodosFiscales SET TotalNetoVentas = TotalNetoVentas + @netoVentas,
       TotalImpuestosVentas = TotalImpuestosVentas + @impuestosVentas, TotalVentas = TotalVentas + @ventas,
       TotalNetoCompras = TotalNetoCompras + @netoCompras, TotalImpuestosCompras = TotalImpuestosCompras + @impuestosCompras,
       TotalCompras = TotalCompras + @compras, TotalRetenciones = TotalRetenciones + @retenciones,
       TotalPercepciones = TotalPercepciones + @percepciones
     WHERE IdEmpresa = @idEmpresa AND PeriodoFiscal = @periodoFiscal`, {
    idEmpresa: p.IdEmpresa, periodoFiscal: p.PeriodoFiscal, netoVentas: 0, impuestosVentas: 0, ventas: 0,
    netoCompras: p.netoCompras, impuestosCompras: p.impuestosCompras, compras: p.compras, retenciones: 0, percepciones: p.percepciones,
  });
  if (!r.rowsAffected[0]) {
    throw new ErrorSiga(`La Fecha del Comprobante pertenece a un Periodo Fiscal (${p.PeriodoFiscal}) que aún NO esta habilitado.`);
  }
  await ejecutar(`UPDATE PeriodosFiscales SET Posicion = TotalImpuestosVentas - TotalImpuestosCompras,
       PosicionFinal = TotalImpuestosVentas - TotalImpuestosCompras - TotalRetenciones - TotalPercepciones
     WHERE IdEmpresa = @idEmpresa AND PeriodoFiscal = @periodoFiscal`, { idEmpresa: p.IdEmpresa, periodoFiscal: p.PeriodoFiscal });
}

// Reglas.ProductosSucursales.ActualizaProductosStock (L1799-1806), por destino: ProductosSucursales_UStock
// (SqlServer.ProductosSucursales L261-276), ProductosSucursalesDepositos_UStock (SqlServer.ProductosDepositos
// L89-106) y ProductosSucursalesUbicacion_UStock (SqlServer.ProductosUbicaciones L139-157), con Stock2 + 0.
// SiGA filtra TipoDeposito = 'OPERATIVO' a propósito: en los otros depósitos (RESERVADO, ENTRANSITO, DEFECTUOSO)
// el UPDATE no toca nada y solo se mueven depósito y ubicación. Desvío: con 0 filas se mira el tipo del depósito
// (mismo request de la transacción); si es OPERATIVO falta la fila de ProductosSucursales y se corta, en vez de
// dejar depósito y ubicación movidos sin la sucursal. HOLDLOCK en los MERGE (SiGA no lo pone) evita la carrera
// del upsert.
async function controlarSucursalSinFila(ejecutar, s, destino) {
  const r = await ejecutar('SELECT TipoDeposito FROM SucursalesDepositos WHERE IdSucursal = @idSucursal AND IdDeposito = @idDeposito', destino);
  if (!r.recordset.length) throw new ErrorSiga(`No existe el depósito ${s.IdDeposito} en la sucursal ${s.IdSucursal} (SucursalesDepositos).`);
  if (String(r.recordset[0].TipoDeposito || '').trim().toUpperCase() === TIPO_DEPOSITO_OPERATIVO) {
    throw new ErrorSiga(`ProductosSucursales no tiene fila para el producto ${s.IdProducto} en la sucursal ${s.IdSucursal}.`);
  }
}

async function actualizarStock(ejecutar, s) {
  const destino = { idSucursal: s.IdSucursal, idDeposito: s.IdDeposito };
  const r = await ejecutar(`UPDATE PS SET Stock = Stock + @cantidad FROM ProductosSucursales PS
     INNER JOIN SucursalesDepositos SD ON SD.IdSucursal = PS.IdSucursal
     WHERE PS.IdSucursal = @idSucursal AND PS.IdProducto = @idProducto AND SD.IdDeposito = @idDeposito AND SD.TipoDeposito = @tipoDeposito`,
  { ...destino, idProducto: s.IdProducto, cantidad: s.Cantidad, tipoDeposito: TIPO_DEPOSITO_OPERATIVO });
  if (!r.rowsAffected[0]) await controlarSucursalSinFila(ejecutar, s, destino);
  await ejecutar(`MERGE INTO ProductosDepositos WITH (HOLDLOCK) AS D
     USING (SELECT @idSucursal AS IdSucursal, @idDeposito AS IdDeposito, @idProducto AS IdProducto, @cantidad AS Stock, 0 AS Stock2) AS O
        ON O.IdSucursal = D.IdSucursal AND O.IdDeposito = D.IdDeposito AND O.IdProducto = D.IdProducto
     WHEN MATCHED THEN UPDATE SET D.Stock = D.Stock + O.Stock, D.Stock2 = D.Stock2 + O.Stock2
     WHEN NOT MATCHED THEN INSERT (IdSucursal, IdDeposito, IdProducto, Stock, Stock2) VALUES (O.IdSucursal, O.IdDeposito, O.IdProducto, O.Stock, O.Stock2);`,
  { ...destino, idProducto: s.IdProducto, cantidad: s.Cantidad });
  await ejecutar(`MERGE INTO ProductosUbicaciones WITH (HOLDLOCK) AS D
     USING (SELECT @idSucursal AS IdSucursal, @idDeposito AS IdDeposito, @idUbicacion AS IdUbicacion, @idProducto AS IdProducto, @cantidad AS Stock, 0 AS Stock2) AS O
        ON O.IdSucursal = D.IdSucursal AND O.IdDeposito = D.IdDeposito AND O.IdUbicacion = D.IdUbicacion AND O.IdProducto = D.IdProducto
     WHEN MATCHED THEN UPDATE SET D.Stock = D.Stock + O.Stock, D.Stock2 = D.Stock2 + O.Stock2
     WHEN NOT MATCHED THEN INSERT (IdSucursal, IdDeposito, IdUbicacion, IdProducto, Stock, Stock2) VALUES (O.IdSucursal, O.IdDeposito, O.IdUbicacion, O.IdProducto, O.Stock, O.Stock2);`,
  { ...destino, idUbicacion: s.IdUbicacion, idProducto: s.IdProducto, cantidad: s.Cantidad });
}

// Reglas.MovimientosStock L744-753: GetPorProductoYProveedor sin filas → ProductosProveedores_I (MERGE,
// SqlServer.ProductosProveedores L20-34); si existe → ActualizaPrecioUltimaCompra (L85-97), solo precio y fecha.
// Una sola sentencia con IF EXISTS en vez del SELECT + Execute de SiGA. `Orden` no es columna: se descarta.
const COLUMNAS_PP = ['IdProveedor', 'IdProducto', 'CodigoProductoProveedor', 'UltimoPrecioCompra', 'UltimaFechaCompra',
  'UltimoPrecioFabrica', 'DescuentoRecargoPorc1', 'DescuentoRecargoPorc2', 'DescuentoRecargoPorc3', 'DescuentoRecargoPorc4',
  'DescuentoRecargoPorc5', 'DescuentoRecargoPorc6'];
const SQL_ULTIMO_PRECIO = `IF EXISTS (SELECT 1 FROM ProductosProveedores ${LOCK} WHERE IdProveedor = @IdProveedor AND IdProducto = @IdProducto)
  BEGIN UPDATE ProductosProveedores SET UltimoPrecioCompra = @UltimoPrecioCompra, UltimaFechaCompra = @UltimaFechaCompra WHERE IdProveedor = @IdProveedor AND IdProducto = @IdProducto END
  ELSE BEGIN MERGE INTO ProductosProveedores AS D
     USING (SELECT ${COLUMNAS_PP.map(c => `@${c} AS ${c}`).join(', ')}) AS O
        ON D.IdProducto = O.IdProducto AND D.IdProveedor = O.IdProveedor
     WHEN NOT MATCHED THEN INSERT (${COLUMNAS_PP.join(', ')}) VALUES (${COLUMNAS_PP.map(c => 'O.' + c).join(', ')});
  END`;

function ultimoPrecioCompra(ejecutar, idProveedor, { Orden, ...pp }) {
  return ejecutar(SQL_ULTIMO_PRECIO, { IdProveedor: idProveedor, ...pp });
}

// GrabaMovimientoStock (MovimientosStock L687-753), por línea: MovimientosStockProductos, ActualizarStock (todos los
// destinos; armar ya dejó solo los AfectaStock) y último precio.
async function moverStock(ejecutar, clave, filas, numeroMovimiento) {
  for (const msp of filas.movimientosStockProductos) {
    await insertar(ejecutar, 'MovimientosStockProductos', {
      IdSucursal: clave.IdSucursal, IdTipoMovimiento: filas.movimientoStock.IdTipoMovimiento, NumeroMovimiento: numeroMovimiento, ...msp,
    });
    for (const s of filas.actualizacionesStock.filter(a => a.Orden === msp.Orden)) await actualizarStock(ejecutar, s);
    for (const pp of filas.productosProveedores.filter(a => a.Orden === msp.Orden)) await ultimoPrecioCompra(ejecutar, clave.IdProveedor, pp);
  }
}

// DOC Parte II §1.3 paso 13: columnas y orden de SqlServer.CuentasCorrientesProv_I (L20-167, 37) y
// CuentasCorrientesProvPagos_I (20). NumeroComprobante2/CentroEmisor2 = clave FINAL (con numeración automática
// armar_comprobante dejó 0 y 1).
async function insertarCtaCte(ejecutar, clave, { cabecera, cuotas }) {
  const { IdSucursal, IdTipoComprobante, Letra, CentroEmisor, NumeroComprobante, IdProveedor } = clave;
  const comprobante = { IdSucursal, IdTipoComprobante, Letra, CentroEmisor, NumeroComprobante };
  const { Fecha, FechaVencimiento, ImporteTotal, ...resto } = cabecera;
  await insertar(ejecutar, 'CuentasCorrientesProv', { ...comprobante, Fecha, FechaVencimiento, ImporteTotal, IdProveedor, ...resto });
  for (const cuota of cuotas) {
    await insertar(ejecutar, 'CuentasCorrientesProvPagos', {
      ...comprobante, CuotaNumero: cuota.CuotaNumero, IdProveedor, ...cuota, NumeroComprobante2: NumeroComprobante, CentroEmisor2: CentroEmisor,
    });
  }
}

// Reglas.Compras.Graba (L610-640): solo el INSERT de Compras traduce la clave duplicada; el resto de las tablas
// re-lanza el error tal cual.
async function insertarCompra(ejecutar, clave, compras) {
  try {
    await insertar(ejecutar, 'Compras', { ...clave, ...compras });
  } catch (err) {
    if (/Cannot insert duplicate key in object/i.test(String((err && err.message) || err))) {
      throw new ErrorSiga('El Comprobante ya existe y no lo puede volver a cargar.');
    }
    throw err;
  }
}

// Todo lo que va adentro de la transacción, en el orden de SiGA: Compras y PeriodosFiscales (C L628, L2075-2078)
// antes de tocar MovimientosNumeros (ME L370-374), así los locks se toman en el mismo orden que SiGA.
async function escribir(ejecutar, filas) {
  const clave = await claveDefinitiva(ejecutar, filas);
  await controlarNumeracionCompartida(ejecutar, clave, filas.numeracion);
  const idTipoMovimiento = filas.movimientoStock.IdTipoMovimiento;
  await insertarCompra(ejecutar, clave, filas.compras);
  if (filas.periodoFiscal) await actualizarPeriodoFiscal(ejecutar, filas.periodoFiscal);
  for (const cp of filas.comprasProductos) await insertar(ejecutar, 'ComprasProductos', { ...clave, ...cp });
  for (const ci of filas.comprasImpuestos) {
    // Reglas.Compras L2140-2144: sin número propio, Emisor/Numero = los del comprobante (clave final).
    await insertar(ejecutar, 'ComprasImpuestos', { ...clave, ...ci, Emisor: clave.CentroEmisor, Numero: clave.NumeroComprobante });
  }
  const numeroMovimiento = await leerNumeroMovimiento(ejecutar, clave.IdSucursal, idTipoMovimiento);
  await guardarNumeroMovimiento(ejecutar, { idSucursal: clave.IdSucursal, idTipoMovimiento, numero: numeroMovimiento });
  await insertar(ejecutar, 'MovimientosStock', {
    IdSucursal: clave.IdSucursal, NumeroMovimiento: numeroMovimiento, ...filas.movimientoStock,
    IdTipoComprobante: clave.IdTipoComprobante, Letra: clave.Letra, CentroEmisor: clave.CentroEmisor, NumeroComprobante: clave.NumeroComprobante,
  });
  await moverStock(ejecutar, clave, filas, numeroMovimiento);
  await controlarDuplicadoCtaCte(ejecutar, clave, filas.numeracion);
  if (filas.ctaCte) await insertarCtaCte(ejecutar, clave, filas.ctaCte);
  return { clave, numeroMovimiento };
}

// msnodesqlv8 (el driver de producción) puede tragarse un fallo del COMMIT: se relee la fila de Compras por su
// clave con el pool de LECTURA. Si no está (o no se puede leer) no se sabe si quedó grabado → ErrorSiga.
async function verificarGrabado(sql, getPool, clave) {
  let filas;
  try {
    const pool = await getPool();
    const r = await conParametros(sql, pool.request(), {
      idSucursal: clave.IdSucursal, idTipoComprobante: clave.IdTipoComprobante, letra: clave.Letra,
      centroEmisor: clave.CentroEmisor, numeroComprobante: clave.NumeroComprobante, idProveedor: clave.IdProveedor,
    }).query(`SELECT 1 AS Existe FROM Compras WHERE IdSucursal = @idSucursal AND IdTipoComprobante = @idTipoComprobante AND Letra = @letra AND CentroEmisor = @centroEmisor AND NumeroComprobante = @numeroComprobante AND IdProveedor = @idProveedor`);
    filas = r.recordset;
  } catch (err) {
    throw new ErrorSiga(`${MENSAJE_SIN_CONFIRMAR} (${err.message})`, 'SIGA_SIN_CONFIRMAR');
  }
  if (!filas.length) throw new ErrorSiga(MENSAJE_SIN_CONFIRMAR, 'SIGA_SIN_CONFIRMAR');
}

// Cualquier error → rollback completo y se re-lanza (ErrorSiga para lo de configuración/negocio). Si SQL Server
// ya abortó la transacción, mssql emite 'rollback' y un segundo rollback() fallaría: no se llama.
async function deshacer(tx, terminada, err) {
  if (!terminada) {
    try {
      await tx.rollback();
    } catch (errRollback) {
      const Clase = err instanceof ErrorSiga ? ErrorSiga : Error;
      throw new Clase(`${(err && err.message) || err} (además falló el rollback: ${errRollback.message})`);
    }
  }
  throw err;
}

module.exports = function crearGrabar({ sql, getPool, getPoolStock }) {
  return async function grabar(filas) {
    const pool = await getPoolStock();
    const tx = new sql.Transaction(pool);
    let terminada = false;
    tx.on('rollback', () => { terminada = true; });
    await tx.begin();
    const ejecutar = (texto, params) => conParametros(sql, new sql.Request(tx), params).query(texto);
    let resultado;
    try {
      resultado = await escribir(ejecutar, filas);
      await tx.commit();
    } catch (err) {
      await deshacer(tx, terminada, err);
    }
    await verificarGrabado(sql, getPool, resultado.clave);
    return resultado;
  };
};
