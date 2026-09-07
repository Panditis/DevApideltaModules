'use strict';
const express = require('express');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const compras = require('../lib/compras');
const comprasImport = require('../lib/compras_import');

// ── Rutas del módulo Compras ──────────────────────────────────────────────────
// Extraídas de server.js sin cambios de comportamiento: mismas rutas, mismo orden
// relativo entre ellas y mismas queries. Los bloques movidos conservan la
// indentación original a propósito: reindentar cambiaría el texto de los SQL
// multilínea, que son template literals.
//
// compras.js y compras_import.js son lógica pura sin estado: se requieren directo.
// Todo lo que tiene estado o vive en server.js (pool SQL, disco, paths de data/,
// helpers SQL compartidos) entra por deps.
//
// Lo que NO está acá y sigue en server.js a propósito:
//   · /api/compras/consumo, /urgencias, /buscar y /productos → los consume
//     dashboard_consumo.html (módulo /consumo); comparten prefijo por historia.
//     Viven en rutas_consumo.js, no acá ni en server.js.
//   · /api/compras/control/* y comprasDeProveedor() → rutas_compras_control.js.
//   · /api/compras/consumo-mensual[/recalcular] → cache compartido con distribución.
module.exports = function crearRutasCompras(deps) {
  const {
    apiRoute, leerJSON, query, getPool,
    sqlStockPorPlu, sqlStockDistribucion, _ventasJoin,
    // pedidos_compra.json lo lee también el control de compras (rutas_compras_control.js):
    // los helpers de disco quedan en server.js y llegan por acá a los dos routers.
    leerPedidosCompra, guardarPedidosCompra,
    PESABLES_LISTAS_PATH, DISTRIB_CONFIG_PATH, CONSUMO_MENSUAL_PATH, A8020_CALC_PATH,
  } = deps;
  const router = express.Router();

router.get('/compras',       (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'compras.html')));
// Ruta histórica del módulo de reposición: ahora Compras es un solo módulo servido en /compras.
router.get('/compras-modulo', (_req, res) => res.redirect(301, '/compras'));

// ── Módulo Compras ───────────────────────────────────────────────────────────
// Armar el pedido a un proveedor → seguimiento → dashboard OTIF. La matemática
// (equivalencias de pesables, cobertura, estados, OTIF) vive en compras.js; acá
// van las queries a SIGA, el disco y la validación del request.
const VENTANAS_SUC = [30, 60, 90];

function usuarioCompras(req)          { return String((req.session && req.session.user && req.session.user.usuario) || 'anonimo'); }

// Sólo proveedores a los que efectivamente se les compró en la ventana: SIGA tiene
// 2264 proveedores cargados y 1108 con movimiento en 24 meses. Listar los otros es
// ofrecer una búsqueda que sólo puede terminar en una tabla vacía. Se ordena por
// cantidad de productos para que el proveedor real aparezca primero.
// El JOIN lleva IdProveedor por la misma razón que productosCompradosAlProveedor.
router.get('/api/compras/proveedores', apiRoute(async (req) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return { proveedores: [] };
  const pool = await getPool();
  const r = await pool.request().input('like', `%${q}%`).query(
    `SELECT TOP 50 pv.IdProveedor, pv.NombreProveedor,
            COUNT(DISTINCT cp.IdProducto) AS Productos,
            CONVERT(varchar(10), MAX(c.Fecha), 23) AS UltimaCompra
     FROM Proveedores pv
     JOIN Compras c ON c.IdProveedor = pv.IdProveedor
       AND c.Fecha >= DATEADD(MONTH,-24,CAST(GETDATE() AS DATE))
     JOIN ComprasProductos cp ON cp.IdSucursal=c.IdSucursal AND cp.IdTipoComprobante=c.IdTipoComprobante
       AND cp.Letra=c.Letra AND cp.CentroEmisor=c.CentroEmisor AND cp.NumeroComprobante=c.NumeroComprobante
       AND cp.IdProveedor=c.IdProveedor
     WHERE pv.NombreProveedor LIKE @like
     GROUP BY pv.IdProveedor, pv.NombreProveedor
     ORDER BY COUNT(DISTINCT cp.IdProducto) DESC`);
  return { proveedores: r.recordset.map(p => ({
    id: Number(p.IdProveedor), nombre: p.NombreProveedor,
    productos: Number(p.Productos) || 0, ultimaCompra: p.UltimaCompra || null,
  })) };
}));

// Lo que se le compró al proveedor en 24 meses, con la última compra de cada artículo.
// Todos los tipos de comprobante, cotizaciones incluidas.
//
// IdProveedor es parte de la PK de Compras y de ComprasProductos, y sin él en el JOIN
// las filas se multiplican: cada proveedor arranca su propia numeración de cotizaciones
// (NumeroComprobante 1, 2, 3…), así que la clave de 5 columnas se repite entre proveedores.
// Con la sexta columna el JOIN devuelve 27.815 renglones, exactamente los que existen;
// sin ella devolvía 830.396. Ese era el motivo real por el que historialComprasAnio
// excluye las cotizaciones — el filtro tapaba el síntoma, no la causa.
async function productosCompradosAlProveedor(idProveedor) {
  const pool = await getPool();
  const r = await pool.request().input('idProv', idProveedor).query(`
    ;WITH cc AS (
      SELECT cp.IdProducto, c.Fecha,
             CAST(cp.Precio AS FLOAT) AS Precio, CAST(cp.Cantidad AS FLOAT) AS Cantidad
      FROM ComprasProductos cp
      JOIN Compras c ON c.IdSucursal=cp.IdSucursal AND c.IdTipoComprobante=cp.IdTipoComprobante
        AND c.Letra=cp.Letra AND c.CentroEmisor=cp.CentroEmisor AND c.NumeroComprobante=cp.NumeroComprobante
        AND c.IdProveedor=cp.IdProveedor
      WHERE c.IdProveedor = @idProv
        AND c.Fecha >= DATEADD(MONTH,-24,CAST(GETDATE() AS DATE))
        AND LTRIM(RTRIM(cp.IdProducto)) <> '1'
    ), agg AS (
      SELECT IdProducto, MAX(Fecha) AS UltimaFecha, SUM(Cantidad) AS CantTotal, COUNT(*) AS Compras
      FROM cc GROUP BY IdProducto
    ), ult AS (
      SELECT IdProducto, Precio, Cantidad,
             ROW_NUMBER() OVER (PARTITION BY IdProducto ORDER BY Fecha DESC) AS rn
      FROM cc
    )
    SELECT a.IdProducto, CONVERT(varchar(10), a.UltimaFecha, 23) AS UltimaFecha,
           a.CantTotal, a.Compras, u.Precio AS UltimoPrecio, u.Cantidad AS UltimaCantidad,
           p.NombreProducto, p.Activo
    FROM agg a
    JOIN ult u ON u.IdProducto=a.IdProducto AND u.rn=1
    LEFT JOIN Productos p ON p.IdProducto=a.IdProducto
    ORDER BY a.UltimaFecha DESC`);
  return r.recordset;
}

// Ventas al cliente final en sucursales de los últimos `dias` días, por producto.
// Mismos filtros que el resto del sistema (_ventasWhere): sin anulados y sin
// comprobantes a clientes categoría SUCURSAL, que son transferencias internas.
function sqlVentasDias(idList, dias, pluList) {
  return `SELECT vp.IdProducto, SUM(vp.Cantidad) AS Cant
    FROM VentasProductos vp ${_ventasJoin}
    WHERE v.Fecha >= DATEADD(DAY,-${dias},CAST(GETDATE() AS DATE)) AND v.Fecha < CAST(GETDATE() AS DATE)
      AND ISNULL(v.IdEstadoComprobante,'') != 'ANULADO' AND v.IdSucursal IN (${idList})
      AND UPPER(ISNULL(cat.NombreCategoria,'')) != 'SUCURSAL'
      AND vp.IdProducto IN (${pluList.map(p => `'${p}'`).join(',')})
    GROUP BY vp.IdProducto`;
}

// SIGA no acepta listas IN de más de ~2100 parámetros: se parte en lotes de 1000.
async function queryPorLotes(lista, sqlFn) {
  const LOTE = 1000;
  if (lista.length <= LOTE) return query(sqlFn(lista));
  const out = [];
  for (let i = 0; i < lista.length; i += LOTE) out.push(...await query(sqlFn(lista.slice(i, i + LOTE))));
  return out;
}

// Guard aparte de apiRoute: un idProveedor inválido es error del cliente (400), y
// apiRoute manda todo lo que se lanza como 500.
function exigirIdProveedor(req, res, next) {
  const id = Number(req.query.idProveedor);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Falta idProveedor' });
  next();
}
router.get('/api/compras/armado', exigirIdProveedor, apiRoute(async (req) => {
  const idProveedor = Number(req.query.idProveedor);
  const ventanaSuc = VENTANAS_SUC.includes(Number(req.query.ventanaSuc)) ? Number(req.query.ventanaSuc) : 30;

  const pool = await getPool();
  const [rProv, filasCompra] = await Promise.all([
    pool.request().input('id', idProveedor).query('SELECT NombreProveedor FROM Proveedores WHERE IdProveedor = @id'),
    productosCompradosAlProveedor(idProveedor),
  ]);
  const proveedor = (rProv.recordset[0] || {}).NombreProveedor || null;
  // En SIGA IdProducto es char: viene con espacios y hay que normalizarlo antes de comparar.
  const plus = [...new Set(filasCompra.map(r => String(r.IdProducto).trim()))];
  if (!plus.length) {
    return { proveedor, idProveedor, meses: 24, ventanaSuc, timestampConsumo: null, sucursales: [], filas: [] };
  }

  // Se compra el granel pero en sucursales se vende fraccionado: el stock y las ventas
  // se consultan también para las presentaciones y se convierten a kg de granel.
  const pesLis = leerJSON(PESABLES_LISTAS_PATH, {}) || {};
  const formulas = pesLis.formulas || {};
  const pesosGranel = pesLis.pesosGranel || {};
  const fracPorPlu = new Map(plus.map(plu => [plu, compras.fraccionadosDe(formulas, plu)]));
  const plusConFrac = [...new Set([...plus, ...[...fracPorPlu.values()].flat().map(f => f.plu)])];

  const sucs = (leerJSON(DISTRIB_CONFIG_PATH, {}) || {}).sucursales || {};
  const sucursales = Object.keys(sucs);
  const sucKeyPorId = {};
  for (const [key, c] of Object.entries(sucs)) sucKeyPorId[String(c.idSucursal)] = key;
  // Filtrado: una sucursal sin idSucursal dejaría un hueco en el IN (5,2,,3), que no parsea.
  const idList = Object.values(sucs).map(s => Number(s.idSucursal)).filter(Number.isFinite).join(',');
  if (!idList) throw new Error('Falta data/distribucion_config.json (sucursales).');

  const [stockCentralRows, stockSucRows, ventasRows] = await Promise.all([
    queryPorLotes(plus, l => sqlStockPorPlu(l)),
    queryPorLotes(plusConFrac, l => sqlStockDistribucion(l)),
    queryPorLotes(plusConFrac, l => sqlVentasDias(idList, ventanaSuc, l)),
  ]);

  const centralPorPlu = {};
  for (const r of stockCentralRows) centralPorPlu[String(r.IdProducto).trim()] = Number(r.StockActual) || 0;
  const stockPorSuc = {};
  for (const r of stockSucRows) {
    const suc = sucKeyPorId[String(r.IdSucursal)];
    if (!suc) continue;   // la central (y cualquier sucursal fuera de config) no cuenta acá
    const plu = String(r.IdProducto).trim();
    if (!stockPorSuc[plu]) stockPorSuc[plu] = {};
    stockPorSuc[plu][suc] = Number(r.Stock) || 0;
  }
  const ventasPorPlu = {};
  for (const r of ventasRows) ventasPorPlu[String(r.IdProducto).trim()] = Number(r.Cant) || 0;

  // La serie mensual ya viene imputada (fraccionado → granel, bulto → componentes):
  // para un granel NO hay que volver a sumarle sus presentaciones.
  const cacheConsumo = leerJSON(CONSUMO_MENSUAL_PATH, {}) || {};
  const consumoMensual = cacheConsumo.consumoMensual || {};
  const a8020 = leerJSON(A8020_CALC_PATH, {}) || {};
  const abcPorPlu = a8020.abc || {};
  const nombresA8020 = a8020.nombres || {};
  const rankingGeneral = a8020.rankingGeneral || {};
  const serieDe = plu => Object.entries(consumoMensual[plu] || {})
    .map(([mes, v]) => ({ mes, ventas: Number(v.ventas) || 0, produccion: Number(v.produccion) || 0, total: Number(v.total) || 0 }))
    .sort((a, b) => a.mes.localeCompare(b.mes));

  const hoyISO = new Date().toISOString().slice(0, 10);
  const filas = filasCompra.map(r => {
    const plu = String(r.IdProducto).trim();
    const frac = fracPorPlu.get(plu) || [];
    // Productos.IdUnidadDeMedida no se usa en ninguna query del sistema: la unidad se
    // deriva de los pesables (si tiene peso de granel o presentaciones, se compra por kg).
    const esGranel = pesosGranel[plu] != null || frac.length > 0;
    const stockCentral = centralPorPlu[plu] || 0;
    const suc = compras.stockSucursalesEq(plu, frac, stockPorSuc);
    const serie = serieDe(plu);
    const demandaDiariaCentral = compras.demandaDiaria(serie, { hoyISO });
    return {
      plu, nombre: r.NombreProducto || plu, unidad: esGranel ? 'KG' : 'UN',
      activo: r.Activo == null ? null : !!Number(r.Activo), esGranel,
      ultimaFecha: r.UltimaFecha || null,
      ultimaCantidad: Number(r.UltimaCantidad) || 0,
      ultimoPrecio: Number(r.UltimoPrecio) || 0,
      compras24m: Number(r.Compras) || 0,
      cantTotal24m: Number(r.CantTotal) || 0,
      stockCentral, stockSucursales: suc.total, stockPorSucursal: suc.porSucursal,
      // De dónde sale el stock de sucursales: el granel más cada presentación fraccionada.
      // Los nombres de los fraccionados no vienen de la query de compras, salen del a8020.
      componentes: compras.componentesStockEq(plu, frac, stockPorSuc).map(c => ({
        ...c,
        nombre: c.plu === plu ? (r.NombreProducto || plu) : (nombresA8020[c.plu] || c.plu),
        // Sólo se consulta el stock central de los PLUs comprados: en central el granel
        // vive como granel, y para una presentación sin dato es null, no 0.
        stockCentral: c.esPropio ? stockCentral : (centralPorPlu[c.plu] != null ? centralPorPlu[c.plu] : null),
      })),
      consumoMensual: serie,
      abc: abcPorPlu[plu] || null,
      importancia: rankingGeneral[plu] != null ? rankingGeneral[plu] : null,
      demandaDiariaCentral,
      coberturaCentral: compras.coberturaDias(stockCentral, demandaDiariaCentral),
      coberturaSucursales: compras.coberturaDias(suc.total, compras.ventasEq(plu, frac, ventasPorPlu) / ventanaSuc),
    };
  });

  filas.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));

  return { proveedor, idProveedor, meses: 24, ventanaSuc,
    timestampConsumo: cacheConsumo.timestamp || null, sucursales, filas };
}));

// El número es correlativo y ordena cronológicamente, así que alcanza para el sort.
router.get('/api/compras/pedidos', apiRoute(async (req) => {
  const proveedor = String(req.query.proveedor || '').trim();
  const estado = String(req.query.estado || '').trim().toUpperCase();
  return leerPedidosCompra()
    .filter(p => (!proveedor || p.proveedor === proveedor) && (!estado || p.estado === estado))
    .sort((a, b) => String(b.numero).localeCompare(String(a.numero)));
}));

router.post('/api/compras/pedidos', (req, res) => {
  const b = req.body || {};
  const pedidos = leerPedidosCompra();
  try {
    const pedido = compras.construirPedido({
      numero: compras.siguienteNumero(pedidos),
      fechaISO: new Date().toISOString().slice(0, 10),
      proveedor: b.proveedor,
      idProveedor: b.idProveedor != null ? b.idProveedor : null,
      usuario: usuarioCompras(req),
      items: b.items,
      ts: new Date().toISOString(),
    });
    guardarPedidosCompra([...pedidos, pedido]);
    res.json({ ok: true, pedido });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Único endpoint de seguimiento: guardar, cerrar y anular son el mismo PUT con
// distinto estado. Las reglas (no cerrar sin retiro, líneas sin resolver) están en compras.js.
router.put('/api/compras/pedidos/:numero', (req, res) => {
  const numero = String(req.params.numero);
  const pedidos = leerPedidosCompra();
  const i = pedidos.findIndex(p => String(p.numero) === numero);
  if (i < 0) return res.status(404).json({ error: 'Pedido no encontrado' });
  try {
    const actualizado = compras.aplicarSeguimiento(pedidos[i], req.body || {},
      { ts: new Date().toISOString(), usuario: usuarioCompras(req) });
    // Copia del array y reemplazo del índice: no se muta lo leído del disco.
    const copia = [...pedidos];
    copia[i] = actualizado;
    guardarPedidosCompra(copia);
    res.json({ ok: true, pedido: actualizado });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/api/compras/otif', apiRoute(async (req) => compras.otif(leerPedidosCompra(), {
  proveedor: req.query.proveedor ? String(req.query.proveedor) : undefined,
  desde: req.query.desde ? String(req.query.desde) : undefined,
  hasta: req.query.hasta ? String(req.query.hasta) : undefined,
})));


// ── Importación de facturas de compra — BANCO DE PRUEBAS ───────────────────────
// Sólo lectura: parsea el xlsx, resuelve los productos contra SIGA y devuelve la
// previsualización. NO escribe nada en SIGA. El mapeo de las 12 tablas que tocaría
// la carga real está relevado en docs/compras_siga_mapeo.md
const uploadCompraXlsx = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.get('/compras/importar-prueba', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'compras_import_prueba.html')));

// Busca la hoja por nombre sin distinguir mayúsculas ni espacios sobrantes.
function hojaCompra(wb, nombre) {
  const clave = wb.SheetNames.find(n => String(n).trim().toLowerCase() === nombre);
  return clave ? wb.Sheets[clave] : null;
}

// SELECT ... IN (...) con parámetros: nunca interpola los valores en el SQL.
async function selectEnLista(sqlTexto, valores, extras = []) {
  if (!valores.length) return [];
  const pool = await getPool();
  const rq = pool.request();
  for (const [nombre, valor] of extras) rq.input(nombre, valor);
  const marcas = valores.map((v, i) => {
    rq.input('v' + i, String(v));
    return '@v' + i;
  });
  const r = await rq.query(sqlTexto.replace('{{EN_LISTA}}', marcas.join(',')));
  return r.recordset;
}

// Resuelve cada línea a un IdProducto de SIGA por PLU, código de proveedor o barras.
async function resolverProductosCompra(idProveedor, lineas) {
  const unicos = campo => [...new Set(lineas.map(l => l[campo]).filter(Boolean))];

  const [porPlu, porCodProv, porBarras, porIdent] = await Promise.all([
    selectEnLista(
      'SELECT IdProducto, NombreProducto, Activo, EsDeCompras FROM Productos WHERE IdProducto IN ({{EN_LISTA}})',
      unicos('plu')),
    selectEnLista(
      `SELECT pp.CodigoProductoProveedor, pp.IdProducto, p.NombreProducto
         FROM ProductosProveedores pp
         JOIN Productos p ON p.IdProducto = pp.IdProducto
        WHERE pp.IdProveedor = @prov AND pp.CodigoProductoProveedor IN ({{EN_LISTA}})`,
      unicos('codigoProveedor'), [['prov', idProveedor]]),
    selectEnLista(
      'SELECT IdProducto, NombreProducto, CodigoDeBarras FROM Productos WHERE CodigoDeBarras IN ({{EN_LISTA}})',
      unicos('codigoBarras')),
    selectEnLista(
      `SELECT pi.Identificacion, pi.IdProducto, p.NombreProducto
         FROM ProductosIdentificaciones pi
         JOIN Productos p ON p.IdProducto = pi.IdProducto
        WHERE pi.Identificacion IN ({{EN_LISTA}})`,
      unicos('codigoBarras')),
  ]);

  const mapaPlu = new Map(porPlu.map(r => [String(r.IdProducto).trim(), r]));

  // Un mismo código de proveedor puede apuntar a varios productos (hay 213 casos
  // así en SIGA): se marcan como ambiguos en vez de elegir uno al azar.
  const mapaCod = new Map();
  for (const r of porCodProv) {
    const k = String(r.CodigoProductoProveedor).trim();
    if (!mapaCod.has(k)) mapaCod.set(k, []);
    mapaCod.get(k).push(r);
  }

  const mapaBarras = new Map();
  for (const r of [...porBarras, ...porIdent]) {
    const k = String(r.CodigoDeBarras ?? r.Identificacion ?? '').trim();
    if (!k) continue;
    if (!mapaBarras.has(k)) mapaBarras.set(k, []);
    if (!mapaBarras.get(k).some(x => String(x.IdProducto) === String(r.IdProducto))) mapaBarras.get(k).push(r);
  }

  return lineas.map(l => {
    const salida = { ...l, resuelto: null, nombreSiga: null, estado: 'no-encontrado', origen: null, notas: [] };

    if (l.plu) {
      const p = mapaPlu.get(l.plu);
      if (p) {
        salida.resuelto = String(p.IdProducto).trim();
        salida.nombreSiga = p.NombreProducto;
        salida.estado = 'ok';
        salida.origen = 'PLU';
        if (!p.Activo) salida.notas.push('El producto está inactivo en SIGA.');
        if (!p.EsDeCompras) salida.notas.push('El producto no está marcado como "de compras".');
      } else {
        salida.notas.push(`El PLU ${l.plu} no existe en SIGA.`);
      }
    }

    if (!salida.resuelto && l.codigoProveedor) {
      const c = mapaCod.get(l.codigoProveedor) || [];
      if (c.length === 1) {
        salida.resuelto = String(c[0].IdProducto).trim();
        salida.nombreSiga = c[0].NombreProducto;
        salida.estado = 'ok';
        salida.origen = 'CodigoProveedor';
      } else if (c.length > 1) {
        salida.estado = 'ambiguo';
        salida.opciones = c.map(x => ({ plu: String(x.IdProducto).trim(), nombre: x.NombreProducto }));
        salida.notas.push(`El código "${l.codigoProveedor}" apunta a ${c.length} productos distintos.`);
      } else {
        salida.notas.push(`El código de proveedor "${l.codigoProveedor}" no está cargado para este proveedor.`);
      }
    }

    if (!salida.resuelto && salida.estado !== 'ambiguo' && l.codigoBarras) {
      const b = mapaBarras.get(l.codigoBarras) || [];
      if (b.length === 1) {
        salida.resuelto = String(b[0].IdProducto).trim();
        salida.nombreSiga = b[0].NombreProducto;
        salida.estado = 'ok';
        salida.origen = 'CodigoBarras';
      } else if (b.length > 1) {
        salida.estado = 'ambiguo';
        salida.opciones = b.map(x => ({ plu: String(x.IdProducto).trim(), nombre: x.NombreProducto }));
        salida.notas.push(`El código de barras "${l.codigoBarras}" apunta a ${b.length} productos.`);
      } else {
        salida.notas.push(`El código de barras "${l.codigoBarras}" no existe en SIGA.`);
      }
    }

    // Cuando vienen los dos, que no se contradigan.
    if (salida.estado === 'ok' && salida.origen === 'PLU' && l.codigoProveedor) {
      const c = mapaCod.get(l.codigoProveedor) || [];
      if (c.length && !c.some(x => String(x.IdProducto).trim() === salida.resuelto)) {
        salida.notas.push(`El código "${l.codigoProveedor}" está cargado para otro producto (${c.map(x => x.IdProducto).join(', ')}).`);
      }
    }

    return salida;
  });
}

// Toma lo que devolvió el parser y lo contrasta con SIGA: proveedor, productos,
// sucursal y comprobante duplicado. La usan tanto la subida del xlsx como la
// revalidación de los datos editados a mano en la pantalla.
async function armarVistaCompra(parsed, archivo) {
  const errores = [...parsed.errores];
  const cab = parsed.cabecera;
  let proveedor = null;
  let lineas = parsed.lineas;
  let duplicado = null;

  // Sin proveedor válido no tiene sentido resolver códigos: se corta acá.
  if (cab.IdProveedor != null) {
    const pool = await getPool();
    const rp = await pool.request().input('id', cab.IdProveedor)
      .query('SELECT IdProveedor, NombreProveedor, CuitProveedor, IdCategoriaFiscal FROM Proveedores WHERE IdProveedor = @id');
    proveedor = rp.recordset[0] || null;
    if (!proveedor) errores.push(`El proveedor ${cab.IdProveedor} no existe en SIGA.`);
  }

  if (proveedor && lineas.length) {
    lineas = await resolverProductosCompra(cab.IdProveedor, lineas);
    const sinResolver = lineas.filter(l => l.estado !== 'ok');
    if (sinResolver.length) {
      errores.push(`${sinResolver.length} de ${lineas.length} ítem(s) no se pudieron identificar en SIGA. No se cargaría nada.`);
    }
  }

  // Numeración automática: sólo comprobantes internos (cotizaciones). Se consulta
  // el último usado para esa sucursal + tipo + letra + punto de venta. Es
  // provisorio: el definitivo se resuelve al grabar, porque otro usuario puede
  // cargar un comprobante en el medio.
  let numeroAsignado = false;
  if (cab.numeroAutomatico && cab.IdSucursal != null && cab.TipoComprobante && cab.Letra && cab.PuntoVenta != null) {
    const pool = await getPool();
    const rn = await pool.request()
      .input('suc', cab.IdSucursal).input('tipo', cab.TipoComprobante)
      .input('letra', cab.Letra).input('emisor', cab.PuntoVenta)
      .query(`SELECT MAX(NumeroComprobante) AS ultimo FROM Compras
               WHERE IdSucursal = @suc AND IdTipoComprobante = @tipo
                 AND Letra = @letra AND CentroEmisor = @emisor`);
    const ultimo = rn.recordset[0] && rn.recordset[0].ultimo != null ? Number(rn.recordset[0].ultimo) : 0;
    cab.NumeroComprobante = ultimo + 1;
    cab.numeroUltimoUsado = ultimo || null;
    numeroAsignado = true;
  }

  // Comprobante ya cargado: la PK de Compras es sucursal+tipo+letra+emisor+número.
  // Si el número lo asignamos nosotros no hace falta: es nuevo por construcción.
  if (!numeroAsignado && cab.IdSucursal != null && cab.TipoComprobante && cab.Letra && cab.PuntoVenta != null && cab.NumeroComprobante != null) {
    const pool = await getPool();
    const rd = await pool.request()
      .input('suc', cab.IdSucursal).input('tipo', cab.TipoComprobante).input('letra', cab.Letra)
      .input('emisor', cab.PuntoVenta).input('nro', cab.NumeroComprobante)
      .query(`SELECT CONVERT(varchar(10), Fecha, 23) AS Fecha, ImporteTotal, Usuario, NombreProveedor
                FROM Compras
               WHERE IdSucursal = @suc AND IdTipoComprobante = @tipo AND Letra = @letra
                 AND CentroEmisor = @emisor AND NumeroComprobante = @nro`);
    duplicado = rd.recordset[0] || null;
    if (duplicado) errores.push(`Ese comprobante ya está cargado en SIGA (${duplicado.Fecha}, ${duplicado.NombreProveedor}).`);
  }

  let sucursal = null;
  if (cab.IdSucursal != null) {
    const pool = await getPool();
    const rs = await pool.request().input('id', cab.IdSucursal)
      .query('SELECT IdSucursal, Nombre FROM Sucursales WHERE IdSucursal = @id');
    sucursal = rs.recordset[0] || null;
    if (!sucursal) errores.push(`La sucursal ${cab.IdSucursal} no existe.`);
  }

  return {
    archivo,
    cabecera: cab,
    proveedor,
    sucursal,
    duplicado,
    lineas,
    totales: parsed.totales,
    avisos: parsed.avisos,
    errores,
    numeroAsignado,
    // Catálogo para los selects de la pantalla: una sola fuente de verdad.
    tiposComprobante: comprasImport.TIPOS_COMPRA,
    valido: errores.length === 0,
    // Recordatorio explícito: este módulo no escribe. La carga real está sin implementar.
    grabaEnSiga: false,
  };
}

// Revalida la compra después de editarla en pantalla. Se reconstruye la misma
// matriz plana que produce el xlsx y se la pasa por el parser: así lo editado
// atraviesa exactamente las mismas validaciones que el archivo, sin confiar
// en lo que manda el navegador.
const CLAVE_POR_COLUMNA = {
  PLU: 'plu', CodigoProveedor: 'codigoProveedor', CodigoBarras: 'codigoBarras',
  Cantidad: 'cantidad', PrecioUnitario: 'precioUnitario',
  PorcentajeIVA: 'porcentajeIVA', Descripcion: 'descripcion',
};

router.post('/api/compras-import/revalidar', express.json({ limit: '2mb' }), apiRoute(async (req) => {
  const cabecera = (req.body && req.body.cabecera) || {};
  const lineas = Array.isArray(req.body && req.body.lineas) ? req.body.lineas : [];

  const colsCab = comprasImport.CAMPOS_CABECERA.map(c => c.campo);
  const valorCab = c => (cabecera[c] == null ? '' : cabecera[c]);
  const matriz = [[...comprasImport.COLUMNAS_DETALLE, ...colsCab]];

  for (const l of lineas) {
    matriz.push([
      ...comprasImport.COLUMNAS_DETALLE.map(c => {
        const v = l[CLAVE_POR_COLUMNA[c]];
        return v == null ? '' : v;
      }),
      ...colsCab.map(valorCab),
    ]);
  }
  // Sin ítems igual hay que devolver la cabecera parseada, para no perder lo editado.
  if (!lineas.length) matriz.push([...comprasImport.COLUMNAS_DETALLE.map(() => ''), ...colsCab.map(valorCab)]);

  const parsed = comprasImport.parsearCompra({ matriz });
  return armarVistaCompra(parsed, req.body && req.body.archivo);
}));

// Buscador de productos, para agregar ítems a mano sin saber el PLU de memoria.
router.get('/api/compras-import/buscar-producto', apiRoute(async (req) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return { productos: [] };
  const pool = await getPool();
  const r = await pool.request().input('q', '%' + q + '%').input('exacto', q)
    .query(`SELECT TOP 25 p.IdProducto, p.NombreProducto, p.CodigoDeBarras, p.Activo
              FROM Productos p
             WHERE p.NombreProducto LIKE @q OR p.IdProducto = @exacto OR p.CodigoDeBarras = @exacto
             ORDER BY CASE WHEN p.IdProducto = @exacto THEN 0 ELSE 1 END, p.NombreProducto`);
  return {
    productos: r.recordset.map(p => ({
      plu: String(p.IdProducto).trim(), nombre: p.NombreProducto,
      barras: String(p.CodigoDeBarras || '').trim(), activo: !!p.Activo,
    })),
  };
}));

router.post('/api/compras-import/preview', uploadCompraXlsx.single('archivo'), apiRoute(async (req) => {
  if (!req.file) throw new Error('No llegó ningún archivo.');

  const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
  const opciones = { header: 1, raw: true, defval: '' };

  // El formato plano (una sola hoja, todo en columnas) es el habitual. Se sigue
  // aceptando el de dos hojas por los archivos armados antes del cambio.
  const hCab = hojaCompra(wb, 'cabecera');
  const hDet = hojaCompra(wb, 'detalle');
  let parsed;
  if (hCab && hDet) {
    parsed = comprasImport.parsearCompra({
      matrizCabecera: XLSX.utils.sheet_to_json(hCab, opciones),
      matrizDetalle:  XLSX.utils.sheet_to_json(hDet, opciones),
    });
  } else {
    const hoja = hojaCompra(wb, 'compra') || wb.Sheets[wb.SheetNames[0]];
    if (!hoja) throw new Error('El archivo no tiene ninguna hoja.');
    parsed = comprasImport.parsearCompra({ matriz: XLSX.utils.sheet_to_json(hoja, opciones) });
  }

  return armarVistaCompra(parsed, req.file.originalname);
}));

  return router;
};
