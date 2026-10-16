'use strict';
// repo.grabar: ejecuta las filas de armar_comprobante.js en UNA transacción con getPoolStock (apidelta_stock),
// en el orden de SiGA (DOC Parte II §1.3), con el SQL de los Eniac.SqlServer.*.cs descompilados pero con
// parámetros (request.input) en vez de valores concatenados. Separado de repo.js para que ningún archivo pase de
// 400 líneas. Fuente: docs/siga_compras_carga_descompilado.md (DOC).
const { LOCK, sqlDuplicadoCompras, SQL_VENTAS_NUMEROS_G1, conParametros, ErrorSiga } = require('./sql_comun');

// SucursalDeposito.TiposDepositos.OPERATIVO (SqlServer.ProductosSucursales_UStock L273).
const TIPO_DEPOSITO_OPERATIVO = 'OPERATIVO';

// Al grabar, SiGA controla la cta. cte. con CuentasCorrientesProv.Existe(IdSucursal > 0, …): filtro
// CCP.IdSucursal = X y, con idEmpresa = 0, sin el filtro de empresa (SqlServer.CuentasCorrientesProv L295-330).
const SQL_DUPLICADO_CTA_CTE = `SELECT TOP 1 CCP.IdSucursal FROM CuentasCorrientesProv CCP ${LOCK}
     INNER JOIN TiposComprobantes TC ON TC.IdTipoComprobante = CCP.IdTipoComprobante
     INNER JOIN Sucursales S ON S.IdSucursal = CCP.IdSucursal
     WHERE CCP.IdSucursal = @idSucursal AND CCP.IdProveedor = @idProveedor AND CCP.IdTipoComprobante = @idTipoComprobante
       AND CCP.Letra = @letra AND CCP.CentroEmisor = @centroEmisor AND CCP.NumeroComprobante = @numeroComprobante`;

// Tabla y columnas son constantes del código (filas de armar_comprobante.js), nunca entrada del usuario;
// los valores van siempre como parámetros (nombre del parámetro = nombre de la columna).
function insertar(ejecutar, tabla, fila) {
  const columnas = Object.keys(fila);
  if (!columnas.every(c => /^\w+$/.test(c))) throw new Error(`Columna inválida en ${tabla}`);
  return ejecutar(`INSERT INTO ${tabla} (${columnas.join(', ')}) VALUES (${columnas.map(c => '@' + c).join(', ')})`, fila);
}

// Numeración y duplicado DENTRO de la transacción, con UPDLOCK/HOLDLOCK (SiGA no bloquea: DOC Parte II §2).
// El aviso previo de la pantalla (ctx.duplicado) no cuenta: acá se vuelve a controlar siempre.
// ponytail: HOLDLOCK sin IdSucursal bloquea un rango ancho de Compras; alcanza para la carga manual, si hubiera
// concurrencia alta conviene un índice por (IdProveedor, IdTipoComprobante, Letra, CentroEmisor, NumeroComprobante).
async function claveDefinitiva(ejecutar, { clave, numeracion }) {
  const base = {
    idProveedor: clave.IdProveedor, idSucursal: clave.IdSucursal, idTipoComprobante: clave.IdTipoComprobante,
    letra: clave.Letra, centroEmisor: clave.CentroEmisor,
  };
  if (numeracion.modo === 'proveedor') {
    // Reglas.Compras.GetProximoNumero (L642-661): MAX + 1 por proveedor, sucursal, tipo, letra y emisor.
    const r = await ejecutar(`SELECT ISNULL(MAX(C.NumeroComprobante), 0) + 1 AS Siguiente FROM Compras C ${LOCK}
     WHERE C.IdProveedor = @idProveedor AND C.IdSucursal = @idSucursal AND C.IdTipoComprobante = @idTipoComprobante
       AND C.Letra = @letra AND C.CentroEmisor = @centroEmisor`, base);
    return { ...clave, NumeroComprobante: Number(r.recordset[0].Siguiente) };
  }
  if (numeracion.modo !== 'manual') throw new ErrorSiga(`v1: numeración ${numeracion.modo} no soportada.`);
  const params = { ...base, numeroComprobante: clave.NumeroComprobante };
  // Compras.Existe(idSucursal = 0, …): cualquier sucursal (sin @idSucursal), (InformaLibroIVA OR misma empresa).
  const paramsCompras = {
    idProveedor: params.idProveedor, idTipoComprobante: params.idTipoComprobante, letra: params.letra,
    centroEmisor: params.centroEmisor, numeroComprobante: params.numeroComprobante, idEmpresa: numeracion.idEmpresa,
  };
  if ((await ejecutar(sqlDuplicadoCompras(LOCK), paramsCompras)).recordset.length) {
    throw new ErrorSiga('Este comprobante ya fue INGRESADO con ANTERIORIDAD');
  }
  if ((await ejecutar(SQL_DUPLICADO_CTA_CTE, params)).recordset.length) {
    throw new ErrorSiga('Este comprobante ya EXISTE en Cuentas Corrientes de Proveedores');
  }
  return clave;
}

// Paso 2 de Reglas.Compras.Existe (L1655-1660): con fila en VentasNumeros_G1 la v1 no importa (validaciones ya lo
// bloquea con el contexto; acá se repite por si apareció entre la validación y la grabación). Sin lock: si hay fila
// se aborta, así que no hay nada que proteger hasta el commit.
// ponytail: por eso no hay UPDATE de VentasNumeros (DOC paso 4d): su WHERE (empresa, sucursal o 0, tipo, letra,
// emisor) es un subconjunto de este SELECT, así que si llegamos a grabar no hay fila que actualizar. Si la v2 deja
// pasar numeración compartida, agregar ahí el UPDATE de VentasNumeros_U.
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
// Desvío: SiGA no controla las filas del UPDATE; acá 0 filas (sin fila en ProductosSucursales o depósito no
// OPERATIVO) corta, para no dejar depósito y ubicación movidos sin la sucursal. HOLDLOCK en los MERGE (SiGA no lo
// pone) evita la carrera del upsert.
async function actualizarStock(ejecutar, s) {
  const destino = { idSucursal: s.IdSucursal, idDeposito: s.IdDeposito };
  const r = await ejecutar(`UPDATE PS SET Stock = Stock + @cantidad FROM ProductosSucursales PS
     INNER JOIN SucursalesDepositos SD ON SD.IdSucursal = PS.IdSucursal
     WHERE PS.IdSucursal = @idSucursal AND PS.IdProducto = @idProducto AND SD.IdDeposito = @idDeposito AND SD.TipoDeposito = @tipoDeposito`,
  { ...destino, idProducto: s.IdProducto, cantidad: s.Cantidad, tipoDeposito: TIPO_DEPOSITO_OPERATIVO });
  if (!r.rowsAffected[0]) {
    throw new ErrorSiga(`ProductosSucursales no tiene fila para el producto ${s.IdProducto} en la sucursal ${s.IdSucursal} con el depósito ${s.IdDeposito} ${TIPO_DEPOSITO_OPERATIVO}.`);
  }
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

// Reglas.Compras L633-636.
function traducirError(err) {
  const msg = String((err && err.message) || err);
  return /Cannot insert duplicate key in object/i.test(msg) ? new ErrorSiga('El Comprobante ya existe y no lo puede volver a cargar.') : err;
}

// Todo lo que va adentro de la transacción, en el orden de SiGA.
async function escribir(ejecutar, filas) {
  const clave = await claveDefinitiva(ejecutar, filas);
  await controlarNumeracionCompartida(ejecutar, clave, filas.numeracion);
  const idTipoMovimiento = filas.movimientoStock.IdTipoMovimiento;
  const numeroMovimiento = await leerNumeroMovimiento(ejecutar, clave.IdSucursal, idTipoMovimiento);
  await insertar(ejecutar, 'Compras', { ...clave, ...filas.compras });
  if (filas.periodoFiscal) await actualizarPeriodoFiscal(ejecutar, filas.periodoFiscal);
  for (const cp of filas.comprasProductos) await insertar(ejecutar, 'ComprasProductos', { ...clave, ...cp });
  for (const ci of filas.comprasImpuestos) {
    // Reglas.Compras L2140-2144: sin número propio, Emisor/Numero = los del comprobante (clave final).
    await insertar(ejecutar, 'ComprasImpuestos', { ...clave, ...ci, Emisor: clave.CentroEmisor, Numero: clave.NumeroComprobante });
  }
  await guardarNumeroMovimiento(ejecutar, { idSucursal: clave.IdSucursal, idTipoMovimiento, numero: numeroMovimiento });
  await insertar(ejecutar, 'MovimientosStock', {
    IdSucursal: clave.IdSucursal, NumeroMovimiento: numeroMovimiento, ...filas.movimientoStock,
    IdTipoComprobante: clave.IdTipoComprobante, Letra: clave.Letra, CentroEmisor: clave.CentroEmisor, NumeroComprobante: clave.NumeroComprobante,
  });
  await moverStock(ejecutar, clave, filas, numeroMovimiento);
  if (filas.ctaCte) await insertarCtaCte(ejecutar, clave, filas.ctaCte);
  return { clave, numeroMovimiento };
}

module.exports = function crearGrabar({ sql, getPoolStock }) {
  // Cualquier error → rollback completo y se re-lanza (ErrorSiga para lo de configuración/negocio). Si SQL Server
  // ya abortó la transacción, mssql emite 'rollback' y un segundo rollback() fallaría: no se llama.
  return async function grabar(filas) {
    const pool = await getPoolStock();
    const tx = new sql.Transaction(pool);
    let terminada = false;
    tx.on('rollback', () => { terminada = true; });
    await tx.begin();
    const ejecutar = (texto, params) => conParametros(sql, new sql.Request(tx), params).query(texto);
    try {
      const resultado = await escribir(ejecutar, filas);
      await tx.commit();
      return resultado;
    } catch (err) {
      const motivo = traducirError(err);
      if (!terminada) {
        try {
          await tx.rollback();
        } catch (errRollback) {
          const Clase = motivo instanceof ErrorSiga ? ErrorSiga : Error;
          throw new Clase(`${motivo.message || motivo} (además falló el rollback: ${errRollback.message})`);
        }
      }
      throw motivo;
    }
  };
};
