'use strict';
const express = require('express');
const path = require('path');
const analisisVentas = require('../lib/analisis_ventas');
const familiasManuales = require('../lib/familias_manuales');

// ── Rutas del módulo Análisis de Ventas ───────────────────────────────────────
// Una sola página con pestañas (Sucursales / Casa Central) más las familias
// manuales, que son el recorte de catálogo que arma el usuario a mano. Extraídas
// de server.js sin cambios de comportamiento: mismas rutas, mismo orden relativo
// entre ellas y mismas queries. Los bloques movidos conservan la indentación
// original a propósito: reindentar cambiaría el texto de los SQL multilínea, que
// son template literals.
//
// analisis_ventas.js y familias_manuales.js son lógica pura sin estado: se
// requieren directo. Lo que vive en server.js entra por deps.
//
// Lo que comparte prefijo o vecindad pero NO es de este módulo:
//   · /ventas-hora y /api/ventas-hora[/sucursales] — es su propio módulo en
//     data/modulos.json, tiene su propia página y no toca analisis_ventas.js.
//   · /precios-historico y /api/precios-historico[/xlsx] — grilla de
//     HistorialPrecios, otra página y otra librería; además comparte
//     LISTA_PRECIOS_VENTA con el facturador.
//   · /api/cuentas-corrientes — su propio módulo en data/modulos.json.
//   · FAMILIAS_MANUALES_PATH — lo lee también rutas_productividad, así que se
//     queda en server.js con su comentario y llega por deps.
module.exports = function crearRutasAnalisis(deps) {
  const {
    apiRoute, query, leerJSON, guardarJSON, safeDate, auth,
    FAMILIAS_MANUALES_PATH, generarTop20Prioritarios,
  } = deps;
  const router = express.Router();

// Análisis de ventas: una sola página con pestañas (Sucursales / Casa Central). Las dos
// rutas históricas siguen vivas porque cada una es el guard de su módulo de permiso; el
// front abre la pestaña que corresponde al path por el que se entró.
router.get(['/analisis-ventas', '/analisis-central'], (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'analisis.html')));
// El CSS y el JS del módulo van aparte para no repetirlos en cada pestaña. El proyecto no
// usa express.static: cada asset se declara con su propia ruta.
router.get('/analisis.css', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'analisis.css')));
router.get('/analisis_graficos.js', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'analisis_graficos.js')));
router.get('/analisis_familias_manuales.js', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'analisis_familias_manuales.js')));
router.get('/analisis_front.js', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'analisis_front.js')));

// ── Análisis de Ventas por Sucursal ──────────────────────────────────────────
// Días en quiebre por producto, sumando las sucursales del filtro. El umbral se calcula
// por producto+sucursal (las ventas de una sucursal no fijan el mínimo de otra) y la serie
// diaria de stock se reconstruye hacia atrás desde el stock de hoy, porque SIGA no guarda
// foto histórica. Devuelve Map idProducto -> días.
async function quiebresPorProducto(p, idProductos) {
  const idsCsv = analisisVentas.idsCsvSeguro(idProductos);
  if (!idsCsv) return new Map();
  const hoy = new Date().toISOString().slice(0, 10);
  const [pesablesRows, stockRows, netoRows, unidadesRows] = await Promise.all([
    query(analisisVentas.sqlPesables(idsCsv)),
    query(analisisVentas.sqlStockPorSucursal(idsCsv, p.sucIdsCsv)),
    query(analisisVentas.sqlNetoDiarioStock(p.desde, p.sucIdsCsv, idsCsv)),
    query(analisisVentas.sqlUnidadesPorSucursal(p, idsCsv)),
  ]);

  const pesables = new Set(pesablesRows.map(r => String(r.IdProducto)));
  const meses = analisisVentas.mesesDelRango(p.desde, p.hasta);
  const clave = (prod, suc) => `${prod}|${suc}`;
  const stock = new Map(stockRows.map(r => [clave(r.IdProducto, r.IdSucursal), Number(r.Stock || 0)]));
  const unidades = new Map(unidadesRows.map(r => [clave(r.IdProducto, r.IdSucursal), Number(r.Unidades || 0)]));
  // Netos y entradas indexados por producto+sucursal y, adentro, por fecha ISO.
  const netos = new Map();
  const entradas = new Map();
  for (const r of netoRows) {
    const k = clave(r.IdProducto, r.IdSucursal);
    if (!netos.has(k)) { netos.set(k, {}); entradas.set(k, {}); }
    const fecha = r.Fecha instanceof Date ? r.Fecha.toISOString().slice(0, 10) : String(r.Fecha).slice(0, 10);
    netos.get(k)[fecha] = Number(r.Neto || 0);
    entradas.get(k)[fecha] = Number(r.Entradas || 0);
  }

  // Una sucursal cuenta para un producto sólo si tuvo ventas o stock: si nunca lo trabajó,
  // sus días vacíos no son un quiebre suyo. La base del porcentaje acompaña ese criterio:
  // suma los días evaluables de cada sucursal que sí entró, así 8 días sobre 2 sucursales
  // se leen contra 52 día-sucursal y no contra 26.
  const acumulado = new Map();
  for (const k of new Set([...stock.keys(), ...unidades.keys()])) {
    const prod = k.split('|')[0];
    const umbral = analisisVentas.umbralQuiebre(unidades.get(k) || 0, meses, pesables.has(prod));
    const serie = analisisVentas.serieStockDiaria({
      stockActual: stock.get(k) || 0, netosPorFecha: netos.get(k), entradasPorFecha: entradas.get(k),
      desde: p.desde, hasta: p.hasta, hoy, umbral,
    });
    const previo = acumulado.get(prod) || { dias: 0, base: 0 };
    acumulado.set(prod, {
      dias: previo.dias + serie.filter(d => d.quiebre).length,
      base: previo.base + analisisVentas.diasEvaluados(serie),
    });
  }
  return acumulado;
}

// Qué tablas de clasificación (rubro/subrubro/marca) tiene esta base es fijo mientras el
// proceso vive: se sondea una vez y se reusa la condición armada. Si el sondeo falla, se
// cae al filtro por nombre de producto en vez de romper el reporte entero.
let condicionInsumos = null;
let subRubroDisponible = null;
async function sinInsumosSQL() {
  if (condicionInsumos === null) {
    const meta = await query(analisisVentas.sqlMetaClasificacion()).catch(() => []);
    const disponibles = analisisVentas.clasificacionesDisponibles(meta);
    condicionInsumos = analisisVentas.filtroSinInsumos(disponibles);
    // Apicultura puede estar cargada como subrubro de otro rubro y no como rubro propio: el
    // filtro de rubro (sinRubrosExcluidos/soloRubros) también matchea por subrubro cuando
    // esta base tiene la tabla, según el mismo sondeo que ya usa el filtro de insumos.
    subRubroDisponible = disponibles.some(c => c.tabla === 'SubRubros');
  }
  return condicionInsumos;
}


router.get('/api/analisis-ventas', apiRoute(async req => {
  const desde = safeDate(req.query.desde);
  const hasta = safeDate(req.query.hasta);
  const sucIds = analisisVentas.sucIdsSeguras(req.query.sucursales);
  const sucIdsCsv = sucIds.join(',');
  const topN = analisisVentas.clampTopN(req.query.top);
  // Los insumos (por nombre, rubro, subrubro o marca) no son productos de venta: quedan
  // fuera de las dos tablas de top productos y, por arrastre, de las familias. La misma
  // llamada deja subRubroDisponible listo (ver comentario en sinInsumosSQL).
  const sinInsumos = await sinInsumosSQL();
  const p = { desde, hasta, sucIdsCsv, subRubroDisponible };

  const [comparativa, resumenArr, tendencia, diaSemana, horas, productosUnidades,
         artHistograma, artPorSucursal, productosFacturacion] =
    await Promise.all([
      query(analisisVentas.sqlComparativa(p)),
      query(analisisVentas.sqlResumenRenglon(p)),
      query(analisisVentas.sqlTendencia(p)),
      query(analisisVentas.sqlDiaSemana(p)),
      query(analisisVentas.sqlHora(p)),
      query(analisisVentas.sqlTopProductos(p, 'unidades', analisisVentas.LIMITE_FAMILIAS, sinInsumos)),
      query(analisisVentas.sqlArticulosHistograma(p)),
      query(analisisVentas.sqlArticulosPorSucursal(p)),
      // Una sola consulta amplia por facturación alimenta dos vistas: la tabla de productos
      // (paginada y con buscador, necesita todos los registros del rango) y las familias,
      // que se arman en JS sobre el nombre y se sesgarían si sólo se agrupara el top N.
      query(analisisVentas.sqlTopProductos(p, 'facturacion', analisisVentas.LIMITE_FAMILIAS, sinInsumos)),
    ]);

  const resumen = resumenArr[0] || { Unidades: 0, ProductosDistintos: 0 };
  const articulosProm = analisisVentas.promedioArticulos(artPorSucursal);
  // Reconstruir la serie diaria de stock cuesta cuatro consultas más y un recorrido día a
  // día por cada producto y sucursal: con varias sucursales el reporte se vuelve inusable.
  // Por eso los quiebres se calculan sólo cuando el filtro quedó en una sola sucursal.
  const conQuiebres = sucIds.length === 1;
  // Va después del Promise.all: necesita los ids de los productos que se van a listar.
  const quiebres = conQuiebres
    ? await quiebresPorProducto(p, productosFacturacion.map(r => r.IdProducto))
    : new Map();

  return {
    rango: { desde, hasta },
    sucursales: sucIds,
    // El front necesita distinguir "cero quiebres" de "no se calcularon".
    quiebresDisponibles: conQuiebres,
    kpis: { ...analisisVentas.kpisGlobales(comparativa, resumen), articulosProm },
    comparativa: comparativa.map(r => ({
      idSuc: r.IdSucursal, nombre: r.Nombre || `Suc. ${r.IdSucursal}`,
      facturacion: Number(r.Facturacion || 0), tickets: Number(r.Tickets || 0),
      ticketProm: analisisVentas.ticketProm(Number(r.Facturacion || 0), Number(r.Tickets || 0)),
    })),
    tendencia: tendencia.map(r => ({
      fecha: r.Fecha instanceof Date ? r.Fecha.toISOString().slice(0, 10) : String(r.Fecha).slice(0, 10),
      facturacion: Number(r.Facturacion || 0), tickets: Number(r.Tickets || 0),
    })),
    diaSemana: diaSemana.map(r => ({
      dow: Number(r.Dow), nombre: analisisVentas.mapDiaSemana(Number(r.Dow)),
      facturacion: Number(r.Facturacion || 0), tickets: Number(r.Tickets || 0),
    })),
    horas: horas.map(r => ({
      hora: Number(r.Hora), facturacion: Number(r.Facturacion || 0), tickets: Number(r.Tickets || 0),
    })),
    // Listas completas (no un top acotado): el front las pagina y filtra en memoria.
    topUnidades: productosUnidades.map(r => ({
      idProd: r.IdProducto, nombre: r.Nombre,
      unidades: Number(r.Unidades || 0), facturacion: Number(r.Facturacion || 0),
    })),
    topFacturacion: productosFacturacion.map(r => {
      const q = quiebres.get(String(r.IdProducto)) || { dias: 0, base: 0 };
      return {
        idProd: r.IdProducto, nombre: r.Nombre,
        unidades: Number(r.Unidades || 0), facturacion: Number(r.Facturacion || 0),
        // null (y no 0) cuando el cálculo no corrió: son cosas distintas para el que lee.
        quiebres: conQuiebres ? q.dias : null,
        // Base en día-sucursal: los días evaluables sumados de cada sucursal del filtro.
        quiebresBase: conQuiebres ? q.base : null,
        quiebresPorc: conQuiebres ? analisisVentas.porcentajeQuiebre(q.dias, q.base) : null,
      };
    }),
    // Familias del nombre + grupos manuales en una sola tabla. Los productos asignados a un
    // grupo se listan sólo ahí: ver familiasYGrupos.
    familias: analisisVentas.familiasYGrupos(productosFacturacion,
      familiasManuales.familiasSanitizadas(leerJSON(FAMILIAS_MANUALES_PATH, [])), topN),
    articulosPorTicket: {
      promedio: articulosProm,
      histograma: analisisVentas.bucketsArticulos(artHistograma),
      porSucursal: artPorSucursal.map(r => ({
        idSuc: r.IdSucursal, nombre: r.Nombre || `Suc. ${r.IdSucursal}`,
        tickets: Number(r.Tickets || 0), articulos: Number(r.Articulos || 0),
        promedio: Number(r.Promedio || 0),
        dias: Number(r.Dias || 0), ticketsDia: Number(r.TicketsDia || 0),
      })),
    },
  };
}));

// ── Top 20 prioritarios ──────────────────────────────────────────────────────
// Genera y guarda en disco el top 20 por facturación (últimos 30 días) para que lo
// consuma el módulo Distribución. La generación vive en server.js (generarTop20Prioritarios)
// porque necesita el mismo cache de "sin insumos" que ya usa este módulo.
router.post('/api/analisis-ventas/prioritarios/generar', apiRoute(async () => {
  return generarTop20Prioritarios();
}));

// ── Tickets por monto (alcance sucursales) ──────────────────────────────────
// Endpoint aparte del análisis grande a propósito: el monto se cambia muchas veces
// seguidas y volver a correr las nueve consultas del panel por cada prueba sería
// carísimo. Ésta es una sola consulta de cabecera. Cuelga de /api/analisis-ventas para
// quedar bajo el mismo permiso de módulo (ver apiPrefijos en auth.js).
router.get('/api/analisis-ventas/montos', apiRoute(async req => {
  const desde = safeDate(req.query.desde);
  const hasta = safeDate(req.query.hasta);
  const sucIds = analisisVentas.sucIdsSeguras(req.query.sucursales);
  const monto = analisisVentas.montoSeguro(req.query.monto);
  const op = analisisVentas.opMontoSeguro(req.query.op);
  const rows = await query(analisisVentas.sqlTicketsPorMonto({
    desde, hasta, sucIdsCsv: sucIds.join(','), monto, op,
  }));
  return { rango: { desde, hasta }, sucursales: sucIds, monto, op,
    ...analisisVentas.ticketsPorMonto(rows) };
}));

// ── Análisis de ventas de casa central ──────────────────────────────────────
// Mismo análisis que el módulo por sucursal pero con alcance fijo en la central, así
// que reusa los mismos builders de SQL. Sin comparativa entre sucursales (hay una sola)
// y sin artículos por ticket: eso vive en el módulo de sucursales.
router.get('/api/analisis-central', apiRoute(async req => {
  const desde = safeDate(req.query.desde);
  const hasta = safeDate(req.query.hasta);
  const topN = analisisVentas.clampTopN(req.query.top);
  // Se sondea antes de armar p: subRubroDisponible tiene que ir con su valor final adentro
  // del objeto (una vez armado, cambiar la variable de afuera ya no lo actualiza).
  const sinInsumos = await sinInsumosSQL();
  // excProdCsv sólo acá: son códigos que salen por la caja de la central pero no son
  // venta real. El análisis por sucursales no lo manda y queda como estaba.
  const p = {
    desde, hasta, sucIdsCsv: String(analisisVentas.SUCURSAL_CENTRAL),
    excProdCsv: analisisVentas.idsCsvSeguro(analisisVentas.PRODUCTOS_EXCLUIDOS_CENTRAL),
    // En la central lo único que no es venta de mostrador es el apiario: bultos, packs y
    // granel de depósito sí se venden y quedaban afuera del análisis.
    rubrosExcluidos: analisisVentas.RUBROS_EXCLUIDOS_CENTRAL,
    subRubroDisponible,
  };

  // Los productos se piden una sola vez: la tabla del front ordena por facturación o por
  // unidades en memoria, así que no hace falta traer el mismo listado dos veces.
  const [totales, resumenArr, tendencia, diaSemana, horas, productos, ventasCliente] =
    await Promise.all([
      // Una sola fila (la central), pero da facturación y tickets para los KPIs.
      query(analisisVentas.sqlComparativa(p)),
      query(analisisVentas.sqlResumenRenglon(p)),
      query(analisisVentas.sqlTendencia(p)),
      query(analisisVentas.sqlDiaSemana(p)),
      query(analisisVentas.sqlHora(p)),
      query(analisisVentas.sqlTopProductos(p, 'facturacion', analisisVentas.LIMITE_FAMILIAS, sinInsumos)),
      query(analisisVentas.sqlVentasPorClienteProducto(p)),
    ]);

  const resumen = resumenArr[0] || { Unidades: 0, ProductosDistintos: 0 };
  return {
    rango: { desde, hasta },
    kpis: analisisVentas.kpisGlobales(totales, resumen),
    tendencia: tendencia.map(r => ({
      fecha: r.Fecha instanceof Date ? r.Fecha.toISOString().slice(0, 10) : String(r.Fecha).slice(0, 10),
      facturacion: Number(r.Facturacion || 0), tickets: Number(r.Tickets || 0),
    })),
    diaSemana: diaSemana.map(r => ({
      dow: Number(r.Dow), nombre: analisisVentas.mapDiaSemana(Number(r.Dow)),
      facturacion: Number(r.Facturacion || 0), tickets: Number(r.Tickets || 0),
    })),
    horas: horas.map(r => ({
      hora: Number(r.Hora), facturacion: Number(r.Facturacion || 0), tickets: Number(r.Tickets || 0),
    })),
    topProductos: productos.map(r => ({
      idProd: r.IdProducto, nombre: r.Nombre,
      unidades: Number(r.Unidades || 0), facturacion: Number(r.Facturacion || 0),
    })),
    familias: analisisVentas.agruparFamilias(productos, topN),
    clientes: analisisVentas.agruparClientes(ventasCliente, topN),
  };
}));

// ── Análisis de ventas de apicultura (casa central) ──────────────────────────
// La contracara de /api/analisis-central: ahí se excluye el rubro Apicultura
// (RUBROS_EXCLUIDOS_CENTRAL), acá se filtra a sólo ese rubro con soloRubros(). Bajo el
// prefijo /api/analisis-central para heredar el mismo permiso (ver apiPrefijos en auth.js),
// sin agregar un módulo nuevo.
router.get('/api/analisis-central/apicultura', apiRoute(async req => {
  const desde = safeDate(req.query.desde);
  const hasta = safeDate(req.query.hasta);
  const topN = analisisVentas.clampTopN(req.query.top);
  const sinInsumos = await sinInsumosSQL();
  const p = {
    desde, hasta, sucIdsCsv: String(analisisVentas.SUCURSAL_CENTRAL),
    excProdCsv: analisisVentas.idsCsvSeguro(analisisVentas.PRODUCTOS_EXCLUIDOS_CENTRAL),
    subRubroDisponible,
  };
  const filtroRubro = analisisVentas.soloRubros(analisisVentas.RUBROS_EXCLUIDOS_CENTRAL, subRubroDisponible);

  const [resumenGralArr, resumenArr, tendencia, diaSemana, horas, productos, ventasCliente] =
    await Promise.all([
      query(analisisVentas.sqlApiculturaResumen(p)),
      query(analisisVentas.sqlResumenRenglon(p, filtroRubro)),
      query(analisisVentas.sqlApiculturaTendencia(p)),
      query(analisisVentas.sqlApiculturaDiaSemana(p)),
      query(analisisVentas.sqlApiculturaHora(p)),
      query(analisisVentas.sqlTopProductos(p, 'facturacion', analisisVentas.LIMITE_FAMILIAS, sinInsumos, filtroRubro)),
      query(analisisVentas.sqlVentasPorClienteProducto(p, filtroRubro)),
    ]);

  const resumenGral = resumenGralArr[0] || { Facturacion: 0, Tickets: 0 };
  const resumen = resumenArr[0] || { Unidades: 0, ProductosDistintos: 0 };
  return {
    rango: { desde, hasta },
    kpis: analisisVentas.kpisGlobales([resumenGral], resumen),
    tendencia: tendencia.map(r => ({
      fecha: r.Fecha instanceof Date ? r.Fecha.toISOString().slice(0, 10) : String(r.Fecha).slice(0, 10),
      facturacion: Number(r.Facturacion || 0), tickets: Number(r.Tickets || 0),
    })),
    diaSemana: diaSemana.map(r => ({
      dow: Number(r.Dow), nombre: analisisVentas.mapDiaSemana(Number(r.Dow)),
      facturacion: Number(r.Facturacion || 0), tickets: Number(r.Tickets || 0),
    })),
    horas: horas.map(r => ({
      hora: Number(r.Hora), facturacion: Number(r.Facturacion || 0), tickets: Number(r.Tickets || 0),
    })),
    topProductos: productos.map(r => ({
      idProd: r.IdProducto, nombre: r.Nombre,
      unidades: Number(r.Unidades || 0), facturacion: Number(r.Facturacion || 0),
    })),
    familias: analisisVentas.agruparFamilias(productos, topN),
    clientes: analisisVentas.agruparClientes(ventasCliente, topN),
  };
}));

// ── Familias de producto consolidadas (casa central + sucursales) ────────────
// Cada alcance se consulta por separado porque tienen filtros propios —la central excluye
// apicultura, los códigos que no son venta real y los clientes categoría sucursal— y recién
// después se fusionan por producto. Agrupar sobre la unión y no sobre dos agrupaciones
// sumadas es lo que hace que una familia con presentaciones en los dos lados dé bien.
// Muestra los datos de la central, así que exige los dos permisos, no uno.
function puedeVerFamilias(req, res, next) {
  const user = req.session && req.session.user;
  const ok = auth.puedeAcceder(user, 'analisis-ventas') && auth.puedeAcceder(user, 'analisis-central');
  if (!ok) return res.status(user ? 403 : 401).json({ error: user ? 'Sin permiso' : 'No autenticado' });
  return next();
}

router.get('/api/analisis-familias', puedeVerFamilias, apiRoute(async req => {
  const desde = safeDate(req.query.desde);
  const hasta = safeDate(req.query.hasta);
  // Vacío ≠ ausente: destildar todos los chips deja el listado sólo con la central.
  const sucIds = analisisVentas.sucIdsFamilias(req.query.sucursales);
  // La central entra salvo que se la destilde explícitamente (central=0).
  const conCentral = req.query.central !== '0';
  if (!sucIds.length && !conCentral) {
    return { rango: { desde, hasta }, sucursales: [], conCentral, totales: { unidades: 0, facturacion: 0 }, familias: [] };
  }
  const sinInsumos = await sinInsumosSQL();

  const consultas = [];
  if (sucIds.length) {
    consultas.push(query(analisisVentas.sqlTopProductos(
      { desde, hasta, sucIdsCsv: sucIds.join(','), subRubroDisponible },
      'facturacion', analisisVentas.LIMITE_FAMILIAS, sinInsumos)));
  }
  if (conCentral) {
    consultas.push(query(analisisVentas.sqlTopProductos({
      desde, hasta, sucIdsCsv: String(analisisVentas.SUCURSAL_CENTRAL),
      excProdCsv: analisisVentas.idsCsvSeguro(analisisVentas.PRODUCTOS_EXCLUIDOS_CENTRAL),
      rubrosExcluidos: analisisVentas.RUBROS_EXCLUIDOS_CENTRAL,
      subRubroDisponible,
    }, 'facturacion', analisisVentas.LIMITE_FAMILIAS, sinInsumos)));
  }
  const listas = await Promise.all(consultas);
  const productos = analisisVentas.fusionarProductos(...listas);

  // Sin tope: se listan todas las familias y el front las pagina de a 20. El tope de 20 del
  // resto de las vistas dejaría afuera justo la cola que esta pestaña quiere mostrar.
  const familias = analisisVentas.agruparFamilias(productos, Infinity);
  return {
    rango: { desde, hasta },
    sucursales: sucIds,
    conCentral,
    totales: {
      unidades: productos.reduce((a, r) => a + Number(r.Unidades || 0), 0),
      facturacion: productos.reduce((a, r) => a + Number(r.Facturacion || 0), 0),
      productos: productos.length,
    },
    familias,
  };
}));


function puedeVerAnalisis(req, res, next) {
  const user = req.session && req.session.user;
  if (!auth.puedeAcceder(user, 'analisis-ventas')) {
    return res.status(user ? 403 : 401).json({ error: user ? 'Sin permiso' : 'No autenticado' });
  }
  return next();
}

router.get('/api/familias-manuales', puedeVerAnalisis, (_req, res) => {
  res.json(familiasManuales.familiasSanitizadas(leerJSON(FAMILIAS_MANUALES_PATH, [])));
});

// Se guarda la lista entera de una: son pocas familias y editarlas es una operación de
// pantalla completa, así que un PUT del conjunto evita inventar ids y sincronizarlos.
router.put('/api/familias-manuales', puedeVerAnalisis, (req, res) => {
  const familias = familiasManuales.familiasSanitizadas(req.body);
  guardarJSON(FAMILIAS_MANUALES_PATH, familias);
  res.json(familias);
});

// Sin guard de módulo ni de sesión a propósito: Distribución consume esto desde cualquier
// PC, con o sin login, para destacar la "semana activa".
router.get('/api/familias-manuales/activa', (_req, res) => {
  const familias = familiasManuales.familiasSanitizadas(leerJSON(FAMILIAS_MANUALES_PATH, []));
  res.json(familiasManuales.idsDeGrupoActivo(familias));
});

router.get('/api/familias-manuales/ventas', puedeVerAnalisis, apiRoute(async req => {
  const desde = safeDate(req.query.desde);
  const hasta = safeDate(req.query.hasta);
  const sucIds = analisisVentas.sucIdsSeguras(req.query.sucursales);
  // Las promos se facturan a una cuenta propia por sucursal: acá se pueden mirar aparte
  // (solo), sacar del total (sin) o dejarlas adentro (todas, que es como abre el tablero).
  const promo = analisisVentas.modoPromoSeguro(req.query.promo) || 'todas';
  const familias = familiasManuales.familiasSanitizadas(leerJSON(FAMILIAS_MANUALES_PATH, []));
  const idsCsv = analisisVentas.idsCsvSeguro(familiasManuales.idsDeFamilias(familias));
  // Sin familias o sin productos asignados no hay nada que consultar: el IN () vacío sería
  // SQL inválido y la respuesta igual tiene que traer la estructura para que el front pinte.
  const rows = idsCsv
    ? await query(analisisVentas.sqlVentasPorProductoSucursal(
        { desde, hasta, sucIdsCsv: sucIds.join(','), promo }, idsCsv))
    : [];
  const grupos = familiasManuales.agruparVentas(rows, familias, sucIds);
  return {
    rango: { desde, hasta },
    sucursales: sucIds,
    promo,
    familias: grupos,
    porSucursal: familiasManuales.totalesPorSucursal(grupos, sucIds),
    totales: {
      facturacion: grupos.reduce((a, g) => a + g.total.facturacion, 0),
      unidades: grupos.reduce((a, g) => a + g.total.unidades, 0),
      productos: familiasManuales.idsDeFamilias(familias).length,
    },
  };
}));

  return router;
};
