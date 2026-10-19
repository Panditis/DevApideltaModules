'use strict';
// Acceso a SIGA para la importación de compras. Todo el SQL va con parámetros (request.input), nunca concatenado.
// Lecturas con getPool (usuario de solo lectura, como el resto de la app); la grabación (grabar.js) con
// getPoolStock (apidelta_stock, el que tiene GRANT de escritura) en UNA transacción (DOC Parte II §1.3 y §2).
// Fuente: docs/siga_compras_carga_descompilado.md (DOC).
const C = require('./constantes');
const M = require('./mapeos');
const { periodoFiscalDe } = require('./fechas');
// emisorDe: emisor con el que SiGA controla la numeración (con numeración automática, 1 si viene vacío).
const { emisorDe } = require('./validaciones');
const { sqlProximoNumero, sqlDuplicadoCompras, sqlDuplicadoCtaCte, SQL_VENTAS_NUMEROS_G1, conParametros, ErrorSiga } = require('./sql_comun');
const crearGrabar = require('./grabar');

// Patrones de una lista separada por comas (VentasNumeros_G1_PorRelacionado).
const patronesLista = valor => ({ exacto: valor, inicio: `${valor},%`, fin: `%,${valor}`, medio: `%,${valor},%` });

module.exports = function crearRepoSigaCompras({ sql, getPool, getPoolStock }) {
  async function consultar(texto, params) {
    const pool = await getPool();
    const r = await conParametros(sql, pool.request(), params).query(texto);
    return r.recordset;
  }

  // IN (...) con un parámetro por valor.
  function lista(prefijo, valores) {
    const params = Object.fromEntries(valores.map((v, i) => [`${prefijo}${i}`, v]));
    return { marcas: Object.keys(params).map(k => '@' + k).join(', '), params };
  }

  async function leerProveedor(idProveedor) {
    const [fila] = await consultar('SELECT * FROM Proveedores WHERE IdProveedor = @idProveedor', { idProveedor });
    return fila ? M.mapearProveedor(fila) : null;
  }

  async function leerSucursal(idSucursal) {
    const [fila] = await consultar('SELECT IdSucursal, IdEmpresa FROM Sucursales WHERE IdSucursal = @idSucursal', { idSucursal });
    return fila ? { idSucursal: Number(fila.IdSucursal), idEmpresa: Number(fila.IdEmpresa) } : null;
  }

  // R.Publicos.cs (L973-983, L2326, L2774): parámetros de la empresa de la sucursal destino. SiGA lee la categoría
  // fiscal con CROSS JOIN a la fila CATEGORIAFISCALEMPRESA (S.CategoriasFiscales.cs L107): sin esa fila no hay
  // categoría, así que se corta acá en vez de usar el default 2.
  async function leerParametros(idEmpresa) {
    const { marcas, params } = lista('par', Object.values(C.PARAMETROS));
    const filas = await consultar(
      `SELECT IdParametro, ValorParametro FROM Parametros WHERE IdEmpresa = @idEmpresa AND IdParametro IN (${marcas})`,
      { idEmpresa, ...params });
    const cfe = filas.find(f => String(f.IdParametro).trim().toUpperCase() === C.PARAMETROS.CATEGORIA_FISCAL_EMPRESA);
    if (!cfe || cfe.ValorParametro == null || String(cfe.ValorParametro).trim() === '') {
      throw new ErrorSiga(`Falta el parámetro ${C.PARAMETROS.CATEGORIA_FISCAL_EMPRESA} en SIGA para la empresa ${idEmpresa}.`);
    }
    return M.mapearParametros(filas);
  }

  // S.CategoriasFiscales.cs SelectTexto con la configuración (CFC) de la categoría fiscal de la empresa.
  async function leerCategoriaFiscal(idCategoriaFiscal, categoriaFiscalEmpresa) {
    if (idCategoriaFiscal == null || categoriaFiscalEmpresa == null) return null;
    const [fila] = await consultar(M.SQL_CATEGORIA_FISCAL, { idCategoriaFiscal, categoriaFiscalEmpresa });
    return fila ? M.mapearCategoriaFiscal(fila) : null;
  }

  async function leerTipo(idTipoComprobante) {
    const [fila] = await consultar('SELECT * FROM TiposComprobantes WHERE IdTipoComprobante = @idTipoComprobante', { idTipoComprobante });
    return fila ? M.mapearTipoComprobante(fila) : null;
  }

  async function leerFormaPago(idFormasPago) {
    const [fila] = await consultar('SELECT * FROM VentasFormasPago WHERE IdFormasPago = @idFormasPago', { idFormasPago });
    return fila ? M.mapearFormaPago(fila) : null;
  }

  async function leerProductos(plus) {
    if (!plus.length) return {};
    const { marcas, params } = lista('plu', plus);
    const filas = await consultar(`SELECT * FROM Productos WHERE IdProducto IN (${marcas})`, params);
    return Object.fromEntries(filas.map(f => { const p = M.mapearProducto(f); return [p.idProducto, p]; }));
  }

  async function leerUbicacion({ idSucursal, idDeposito, idUbicacion }) {
    const [fila] = await consultar(
      'SELECT * FROM SucursalesUbicaciones WHERE IdSucursal = @idSucursal AND IdDeposito = @idDeposito AND IdUbicacion = @idUbicacion',
      { idSucursal, idDeposito, idUbicacion });
    return fila ? M.mapearUbicacion(fila) : null;
  }

  // DOC Parte I §8.1: TiposMovimientos.GetUnoPorComprobanteAsociado (R.TiposMovimientos.cs L173-203): recorre las
  // filas con ComprobantesAsociados no nulo, parte la lista por comas y compara exacto (sin trim, con mayúsculas);
  // cada coincidencia pisa a la anterior, así que gana la ÚLTIMA. SIGA-INFERIDO: SiGA no ordena; se asume el orden
  // del índice clustered (IdTipoMovimiento ascendente, gana la última coincidencia).
  async function leerTipoMovimiento(idTipoComprobante) {
    const filas = await consultar('SELECT * FROM TiposMovimientos WHERE ComprobantesAsociados IS NOT NULL ORDER BY IdTipoMovimiento');
    const coincidencias = filas.filter(f => String(f.ComprobantesAsociados || '').split(',').includes(idTipoComprobante));
    const fila = coincidencias[coincidencias.length - 1];
    return fila ? M.mapearTipoMovimiento(fila) : null;
  }

  // DOC Parte I §1.2 punto 6.
  async function leerCotizacion() {
    const [fila] = await consultar('SELECT FactorConversion FROM Monedas WHERE IdMoneda = @idMoneda', { idMoneda: C.ID_MONEDA_DOLAR });
    return fila ? Number(fila.FactorConversion) : null;
  }

  async function leerPeriodo(idEmpresa, periodoFiscal) {
    const [fila] = await consultar(
      'SELECT PeriodoFiscal, FechaCierre FROM PeriodosFiscales WHERE IdEmpresa = @idEmpresa AND PeriodoFiscal = @periodoFiscal',
      { idEmpresa, periodoFiscal });
    return fila ? { periodoFiscal: Number(fila.PeriodoFiscal), fechaCierre: fila.FechaCierre || null } : null;
  }

  // Aviso previo para la pantalla; el control que vale es el de grabar(), con lock.
  // Reglas.Compras L1643-1680: sin proveedor, tipo, letra, emisor o número no se controla.
  const SIN_DUPLICADO = Object.freeze({ enCompras: false, enCtaCte: false });
  async function leerDuplicado({ idProveedor, idTipoComprobante, letra, centroEmisor, numeroComprobante, idEmpresa }) {
    if (!idProveedor || !idTipoComprobante || !letra || !(centroEmisor > 0) || !(numeroComprobante > 0)) return SIN_DUPLICADO;
    const params = { idProveedor, idTipoComprobante, letra, centroEmisor, numeroComprobante, idEmpresa };
    const [enCompras, enCtaCte] = await Promise.all([
      consultar(sqlDuplicadoCompras(''), params), consultar(sqlDuplicadoCtaCte(''), params),
    ]);
    return { enCompras: enCompras.length > 0, enCtaCte: enCtaCte.length > 0 };
  }

  // Paso 2 de Reglas.Compras.Existe (L1655-1660): fila en VentasNumeros_G1. La v1 no replica la búsqueda sin
  // proveedor: marca numeracionCompartidaConVentas y validaciones bloquea. Corre también con numeración automática
  // (la pantalla precarga emisor 1 y número, Win L22998), así que no depende del número.
  async function leerNumeracionCompartida(idEmpresa, idTipoComprobante, letra, centroEmisor) {
    if (!idTipoComprobante || !letra || !(centroEmisor > 0)) return false;
    const filas = await consultar(SQL_VENTAS_NUMEROS_G1, { idEmpresa, idTipoComprobante, letra, centroEmisor });
    return filas.length > 0;
  }

  // Número que propone la pantalla con numeración automática por proveedor (Win L22755: Compras.GetProximoNumero).
  // Sin lock: es solo para mostrar; grabar.js lo recalcula con lock (validaciones.numeracionDe).
  async function leerProximoNumero(b, tipo) {
    if (!tipo.numeracionAutomatica || b.idProveedor == null || !b.letra) return null;
    const [fila] = await consultar(sqlProximoNumero(''), {
      idProveedor: b.idProveedor, idSucursal: b.idSucursal, idTipoComprobante: tipo.idTipoComprobante,
      letra: b.letra, centroEmisor: emisorDe(b, tipo),
    });
    return fila ? Number(fila.Siguiente) : null;
  }

  // DOC Parte I §3.2 (VentasNumeros.GetUnoPorRelacionado) con el SQL de VentasNumeros_G1_PorRelacionado.
  // SiGA no pone paréntesis alrededor de los OR (bug de precedencia); acá sí.
  async function leerVentasNumerosRelacionado(idEmpresa, idTipoComprobante) {
    const filas = await consultar(`SELECT TOP 1 IdTipoComprobante FROM VentasNumeros
       WHERE (IdTipoComprobanteRelacionado = @exacto OR IdTipoComprobanteRelacionado LIKE @inicio
          OR IdTipoComprobanteRelacionado LIKE @fin OR IdTipoComprobanteRelacionado LIKE @medio)
         AND IdEmpresa = @idEmpresa`, { idEmpresa, ...patronesLista(idTipoComprobante) });
    return filas.length > 0;
  }

  // Todo lo que validarComprobante y armarComprobante necesitan de SIGA para un borrador.
  async function contexto(b, { hoy }) {
    const [proveedor, sucursal, tipo] = await Promise.all([
      b.idProveedor != null ? leerProveedor(b.idProveedor) : null,
      b.idSucursal != null ? leerSucursal(b.idSucursal) : null,
      b.idTipoComprobante ? leerTipo(b.idTipoComprobante) : null,
    ]);
    const idEmpresa = sucursal ? sucursal.idEmpresa : null;
    const parametros = sucursal ? await leerParametros(idEmpresa) : M.mapearParametros([]);
    const cfe = sucursal ? parametros.categoriaFiscalEmpresa : null;
    const plus = b.lineas.map(l => l.plu).filter(plu => !/^NUEVO-/i.test(plu));
    const conTipoYSucursal = tipo && sucursal;
    const [cfProveedor, cfEmpresa, formaPago, productos, ubicacion, tipoMovimiento, cotizacionDolar,
      periodo, duplicado, ventasNumerosRelacionado, numeracionCompartidaConVentas, proximoNumero] = await Promise.all([
      leerCategoriaFiscal(proveedor && proveedor.idCategoriaFiscal, cfe),
      leerCategoriaFiscal(cfe, cfe),
      b.idFormasPago != null ? leerFormaPago(b.idFormasPago) : null,
      leerProductos(plus),
      sucursal && b.idDeposito != null && b.idUbicacion != null ? leerUbicacion(b) : null,
      tipo ? leerTipoMovimiento(tipo.idTipoComprobante) : null,
      leerCotizacion(),
      conTipoYSucursal ? leerPeriodo(idEmpresa, periodoFiscalDe(b, tipo)) : null,
      conTipoYSucursal
        ? leerDuplicado({
          idProveedor: b.idProveedor, idTipoComprobante: tipo.idTipoComprobante, letra: b.letra,
          centroEmisor: emisorDe(b, tipo), numeroComprobante: b.numeroComprobante, idEmpresa,
        })
        : SIN_DUPLICADO,
      conTipoYSucursal ? leerVentasNumerosRelacionado(idEmpresa, tipo.idTipoComprobante) : false,
      conTipoYSucursal ? leerNumeracionCompartida(idEmpresa, tipo.idTipoComprobante, b.letra, emisorDe(b, tipo)) : false,
      conTipoYSucursal ? leerProximoNumero(b, tipo) : null,
    ]);
    return {
      hoy,
      proveedor: proveedor ? { ...proveedor, categoriaFiscal: cfProveedor } : null,
      empresa: { idEmpresa, categoriaFiscal: cfEmpresa },
      tipo, formaPago, productos,
      destino: { sucursal, ubicacion },
      tipoMovimiento, periodo, duplicado, ventasNumerosRelacionado, numeracionCompartidaConVentas,
      // Con VentasNumeros relacionado no numera por proveedor (validaciones.modoNumeracion): no hay propuesta.
      proximoNumero: ventasNumerosRelacionado ? null : proximoNumero,
      parametros,
      cotizacionDolar,
    };
  }

  async function leerProvincias() {
    try {
      const filas = await consultar('SELECT * FROM Provincias ORDER BY IdProvincia');
      return { provincias: filas.map(M.mapearProvincia), avisos: [] };
    } catch (err) {
      return { provincias: [], avisos: [`No se pudo leer la tabla Provincias (${err.message}): la provincia de PIIBB se tipea a mano.`] };
    }
  }

  // Combos de la pantalla (GET /api/compras-siga/pedidos/:numero/borrador).
  async function catalogos({ idProveedor, idSucursal = C.SUCURSAL_DEFAULT }) {
    const [proveedor, sucursal] = await Promise.all([
      idProveedor != null ? leerProveedor(idProveedor) : null,
      leerSucursal(idSucursal),
    ]);
    const cfe = sucursal ? (await leerParametros(sucursal.idEmpresa)).categoriaFiscalEmpresa : null;
    const [cf, tipos, formas, sucursales, ubicaciones, provincias, periodos] = await Promise.all([
      leerCategoriaFiscal(proveedor && proveedor.idCategoriaFiscal, cfe),
      consultar('SELECT * FROM TiposComprobantes WHERE Tipo = @tipo ORDER BY IdTipoComprobante', { tipo: C.TIPO_COMPRAS }),
      consultar('SELECT * FROM VentasFormasPago ORDER BY IdFormasPago'),
      consultar('SELECT IdSucursal, Nombre FROM Sucursales ORDER BY IdSucursal'),
      consultar('SELECT * FROM SucursalesUbicaciones ORDER BY IdSucursal, IdDeposito, IdUbicacion'),
      leerProvincias(),
      sucursal
        ? consultar('SELECT PeriodoFiscal FROM PeriodosFiscales WHERE IdEmpresa = @idEmpresa AND FechaCierre IS NULL ORDER BY PeriodoFiscal DESC',
          { idEmpresa: sucursal.idEmpresa })
        : [],
    ]);
    return {
      proveedor: proveedor && { ...proveedor, letraFiscalCompra: cf ? cf.letraFiscalCompra : '', ivaDiscriminado: cf ? cf.ivaDiscriminado : false },
      tipos: tipos.map(M.mapearTipoComprobante).map(t => ({
        idTipoComprobante: t.idTipoComprobante, descripcion: t.descripcion, letrasHabilitadas: t.letrasHabilitadas,
        numeracionAutomatica: t.numeracionAutomatica, grabaLibro: t.grabaLibro,
      })),
      formasPago: formas.map(M.mapearFormaPago),
      sucursales: sucursales.map(s => ({ idSucursal: Number(s.IdSucursal), nombre: String(s.Nombre || '').trim() })),
      ubicaciones: ubicaciones.map(M.mapearUbicacion),
      periodos: periodos.map(p => Number(p.PeriodoFiscal)),
      provincias: provincias.provincias,
      avisos: provincias.avisos,
    };
  }

  return { contexto, catalogos, grabar: crearGrabar({ sql, getPool, getPoolStock }) };
};
