'use strict';
const express = require('express');
const path = require('path');
const productividad = require('./lib/productividad');
const resumenesLegacy = require('./lib/resumenes_legacy');
const historialSala = require('./lib/historial_sala');
const familiasManuales = require('./lib/familias_manuales');
const analisisVentas = require('./lib/analisis_ventas');

// ── Rutas del módulo Productividad ───────────────────────────────────────────
// Extraídas de server.js sin cambios de comportamiento: mismas rutas, mismo orden
// relativo entre ellas y mismas queries. Los bloques movidos conservan la
// indentación original a propósito: reindentar cambiaría el texto de los SQL
// multilínea, que son template literals.
//
// productividad.js, resumenes_legacy.js, historial_sala.js, familias_manuales.js y
// analisis_ventas.js son lógica pura sin estado: se requieren directo. Todo lo que
// tiene estado o vive en server.js (pool SQL, disco, paths de data/) entra por deps.
//
// Los helpers y el caché de este bloque (conNombresCompletos, partirTareasExtra,
// familiaDeCarga, nombresDeProductos, preciosDeVenta, cargasProduccion,
// cachePrecios/cacheNombres, RESUMENES_DIR, PLU_TAREA_EXTRA) se usan sólo acá: se
// mudan enteros. Lo compartido —leerRegistros, leerOrdenes, los paths de data/ y
// LISTA_PRECIOS_VENTA, que también usan los tableros de precios y de ventas— se
// queda en server.js y llega por deps.
module.exports = function crearRutasProductividad(deps) {
  const {
    apiRoute, query, leerJSON, guardarJSON, safeDate,
    leerRegistros, leerOrdenes,
    DATA_DIR, PLANES_PATH, CATALOGO_PATH, PROD_REG_PATH, PROD_HIST_PATH,
    FRAC_REG_PATH, HISTORIAL_PATH, FAMILIAS_MANUALES_PATH,
    REF_SALA_PATH, REF_PROD_PATH, LISTA_PRECIOS_VENTA,
  } = deps;
  const router = express.Router();

router.get('/productividad',  (_req, res) => res.sendFile(path.join(__dirname, 'public', 'productividad.html')));

// ── Productividad de la sala ───────────────────────────────────────────────────
// Resúmenes exportados por el sistema viejo de sala, previos a los registros en JSON.
const RESUMENES_DIR = path.join(DATA_DIR, 'resumenes');
// Sólo lectura: junta lo que ya existe (plan, órdenes y cargas) y delega el cálculo en
// Familia de cada carga. Mandan las familias manuales (las arma el usuario por código en
// el módulo de análisis); lo que no está en ninguna cae en la familia deducida del nombre,
// mismo criterio que análisis de ventas: MIEL 500G y MIEL 1KG son una sola familia.
// El nombre que quedó guardado en la carga es con el que se cargó el lote, y muchas veces es
// el corto —"Polen", "Huevos", "G. KETO"— sin la presentación. El nombre completo del producto
// ("Polen 100G") se resuelve por PLU al entrar al tablero, para que todas las vistas nombren
// igual al mismo producto.
//
// Primero manda SIGA, que tiene todos los productos y siempre al día; el catálogo.json —que se
// carga a mano desde un Excel— queda de respaldo para cuando la base no contesta. Un PLU que no
// está en ninguno de los dos se queda con el nombre de la carga.
function conNombresCompletos(cargas, nombresSql) {
  const nombreCat = new Map(leerJSON(CATALOGO_PATH, [])
    .filter(i => i && i.plu != null && i.producto)
    .map(i => [String(i.plu), String(i.producto)]));
  return (cargas || []).map(c => {
    const plu = String(c && c.plu);
    const n = (nombresSql && nombresSql.get(plu)) || nombreCat.get(plu);
    return n && n !== c.nombre ? { ...c, nombre: n } : c;
  });
}

// Las tareas extra se cargan como un registro más de producción con el PLU reservado 'ACT'
// (apidelta_produccion_dia.html las guarda así): ocupan tiempo de sala pero no producen
// unidades. Salen de las cargas y se devuelven aparte, con la misma forma que las tareas de los
// resúmenes viejos, para que no hundan el ritmo de nadie ni ensucien la lista de productos.
const PLU_TAREA_EXTRA = 'ACT';
function partirTareasExtra(cargas) {
  const esTarea = c => String((c && c.plu) || '').trim().toUpperCase() === PLU_TAREA_EXTRA;
  return {
    cargas: (cargas || []).filter(c => !esTarea(c)),
    tareas: (cargas || []).filter(esTarea).map(c => ({
      id: c.id,
      fecha: c.fecha,
      persona: productividad.nombreLindo((productividad.personasDeCarga(c)[0] || {}).nombre || ''),
      tarea: String(c.observacion || c.nombre || 'Tarea extra').trim(),
      sala: 'Produccion',
      desde: c.desde || '',
      hasta: c.hasta || '',
    })),
  };
}

function familiaDeCarga() {
  const familiasPorPlu = new Map();
  for (const f of familiasManuales.familiasSanitizadas(leerJSON(FAMILIAS_MANUALES_PATH, []))) {
    for (const p of f.productos || []) if (p && p.id) familiasPorPlu.set(String(p.id), f.nombre);
  }
  return c => familiasPorPlu.get(String(c && c.plu))
    || analisisVentas.familiaNombre(c && c.nombre);
}

// productividad.js. Las cargas viven en tres lugares a la vez —el archivo vivo, el historial
// de conciliadas y el snapshot de cierre del día—, así que se unen por id antes de medir.
router.get('/api/productividad', apiRoute(async req => {
  const desde = req.query.desde ? safeDate(req.query.desde) : null;
  const hasta = req.query.hasta ? safeDate(req.query.hasta) : null;
  const enRango = f => productividad.enRango(f, desde, hasta);

  const planes = leerJSON(PLANES_PATH, {});
  const planItems = Object.keys(planes)
    .filter(enRango)
    .flatMap(fecha => (planes[fecha].items || []).map(it => ({ ...it, fecha })));

  const snapshots = leerRegistros();
  const nuevasProd = productividad
    .unirPorId(leerJSON(PROD_REG_PATH, []), leerJSON(PROD_HIST_PATH, []),
               snapshots.flatMap(s => (s && s.cargas) || []))
    .filter(c => enRango(c && c.fecha));

  // Fraccionado: el archivo vivo se vacía al cerrar el día, y lo cerrado queda dentro de cada
  // snapshot de historial_distribucion.json en su campo `produccion`.
  const nuevasFrac = productividad
    .unirPorId(leerJSON(FRAC_REG_PATH, []),
               leerJSON(HISTORIAL_PATH, []).flatMap(h => (h && h.produccion) || []))
    .filter(c => enRango(c && c.fecha));

  // Resúmenes viejos (data/resumenes/*.xlsx): son la producción anterior a estos JSON y salen
  // enteros de la sala de producción, más allá de lo que diga su columna "Sala". Las jornadas
  // que ya están cargadas en el sistema nuevo mandan, para no contarlas dos veces.
  const legacy = resumenesLegacy.leerCarpeta(RESUMENES_DIR);
  const legacyEnRango = legacy.cargas.filter(c => c && enRango(c.fecha));
  const nombres = await nombresDeProductosOVacio();
  const todoProd = partirTareasExtra(conNombresCompletos(
    [...nuevasProd, ...resumenesLegacy.sinFechasCubiertas(legacyEnRango, nuevasProd)], nombres));
  const cargasProd = todoProd.cargas;
  const todoFrac = partirTareasExtra(conNombresCompletos(nuevasFrac, nombres));
  const cargasFrac = todoFrac.cargas;
  // Tareas necesarias que no producen unidades (limpieza, preparación): van contadas aparte.
  // Las de los resúmenes viejos y las que se cargan hoy con PLU 'ACT' son la misma cosa.
  const tareas = [...legacy.tareas.filter(t => t && enRango(t.fecha)), ...todoProd.tareas];

  const familiaDe = familiaDeCarga();

  const ordenes = productividad.unirPorId(leerOrdenes(), snapshots.flatMap(s => (s && s.ordenes) || []));
  const { filas, sinPlan } = productividad.resumenOrdenes(planItems, cargasProd, ordenes);

  return {
    desde, hasta,
    produccion: {
      totales: productividad.totales(cargasProd),
      dias: productividad.resumenPorDia(planItems, cargasProd, ordenes),
      ordenes: filas,
      sinPlan,
      personas: productividad.resumenPersonas(cargasProd),
      productos: productividad.resumenProductos(cargasProd, familiaDe),
      familias: productividad.resumenFamilias(cargasProd, familiaDe),
      porDia: productividad.resumenPeriodos(cargasProd, 'dia', tareas, familiaDe),
      porSemana: productividad.resumenPeriodos(cargasProd, 'semana', tareas, familiaDe),
      porMes: productividad.resumenPeriodos(cargasProd, 'mes', tareas, familiaDe),
      tareas,
    },
    fraccionado: {
      totales: productividad.totales(cargasFrac),
      productos: productividad.resumenProductos(cargasFrac, familiaDe),
      familias: productividad.resumenFamilias(cargasFrac, familiaDe),
      personas: productividad.resumenPersonas(cargasFrac),
      porDia: productividad.resumenPeriodos(cargasFrac, 'dia', null, familiaDe),
      porSemana: productividad.resumenPeriodos(cargasFrac, 'semana', null, familiaDe),
      porMes: productividad.resumenPeriodos(cargasFrac, 'mes', null, familiaDe),
      tareas: todoFrac.tareas,
      registros: cargasFrac.map(c => ({
        id: c.id, fecha: c.fecha, plu: String(c.plu == null ? '' : c.plu), producto: c.nombre || '',
        persona: productividad.nombreLindo((productividad.personasDeCarga(c)[0] || {}).nombre || ''),
        unidades: Number(c.cantFraccionada) || 0, kilos: productividad.kilosDeCarga(c),
        desde: c.desde || '', hasta: c.hasta || '',
      })),
    },
  };
}));

// Historial de sala: los resúmenes viejos enteros, sin el filtro de fechas del dashboard y sin
// descartar las jornadas que también están en los JSON nuevos. Es la vista del archivo tal cual
// quedó, con el dato que sólo él tiene: quién hizo envasado, etiquetado y empaquetado, y cuánto
// tardó cada tarea. Endpoint aparte porque es pesado (156 xlsx) y se pide sólo al abrir la tab.
// Precios de venta de lista para valorizar lo producido. Misma lista y sucursal que usa el
// facturador, así el número coincide con lo que se cobra en el mostrador. Se cachean unos
// minutos: son 8 meses de lotes contra el catálogo entero y los precios no cambian por hora.
const PRECIOS_TTL_MS = 5 * 60 * 1000;
let cachePrecios = { sello: 0, mapa: new Map() };
let cacheNombres = { sello: 0, mapa: new Map() };

// Nombre completo de cada producto, tal cual lo tiene SIGA. Mismo caché que los precios: es una
// tabla entera contra la que se cruzan ocho meses de lotes y los nombres no cambian por hora.
async function nombresDeProductos() {
  if (Date.now() - cacheNombres.sello < PRECIOS_TTL_MS) return cacheNombres.mapa;
  const rows = await query('SELECT p.IdProducto, p.NombreProducto FROM Productos p');
  const mapa = new Map();
  for (const r of rows) {
    const n = String(r.NombreProducto || '').trim();
    if (n) mapa.set(String(r.IdProducto).trim(), n);
  }
  cacheNombres = { sello: Date.now(), mapa };
  return mapa;
}

// El tablero sigue midiendo aunque SIGA no conteste: sin nombres, cada carga se queda con el
// suyo y el catálogo de respaldo hace lo que puede.
async function nombresDeProductosOVacio() {
  try { return await nombresDeProductos(); } catch (e) {
    console.error('nombres de productos:', e.message);
    return new Map();
  }
}

async function preciosDeVenta() {
  if (Date.now() - cachePrecios.sello < PRECIOS_TTL_MS) return cachePrecios.mapa;
  const rows = await query(`
    SELECT p.IdProducto, CAST(psp.PrecioVenta AS FLOAT) AS PrecioVenta
    FROM Productos p
    JOIN ProductosSucursalesPrecios psp
      ON psp.IdProducto = p.IdProducto
     AND psp.IdSucursal = 1
     AND psp.IdListaPrecios = ${LISTA_PRECIOS_VENTA}
    WHERE psp.PrecioVenta > 0
  `);   // LISTA_PRECIOS_VENTA vive en server.js (lo usan también precios históricos y ventas) y llega por deps.
  const mapa = new Map();
  for (const r of rows) mapa.set(String(r.IdProducto).trim(), Number(r.PrecioVenta) || 0);
  cachePrecios = { sello: Date.now(), mapa };
  return mapa;
}

// `desde`/`hasta`, `plu` y `persona` acotan la medición: el tablero entero se recalcula sobre
// ese subconjunto, no se esconden filas de un total ya sumado. Sin fechas se mide todo el
// archivo; `rangoTotal` de la respuesta dice cuál es ese máximo.
router.get('/api/productividad/historial', apiRoute(async req => {
  const legacy = resumenesLegacy.leerCarpeta(RESUMENES_DIR);
  // Sin base de datos el tablero sigue sirviendo: pierde la columna de plata, no el resto.
  let precios = new Map();
  try { precios = await preciosDeVenta(); } catch (e) { console.error('precios de venta:', e.message); }
  const r = historialSala.resumen(legacy, {
    desde: req.query.desde ? safeDate(req.query.desde) : null,
    hasta: req.query.hasta ? safeDate(req.query.hasta) : null,
    plu: String(req.query.plu || '').trim(),
    persona: String(req.query.persona || '').trim(),
  }, precios);
  // La referencia viaja con el tablero: es contra lo que se dibujan las líneas de los gráficos.
  // La primera vez se calcula y se guarda sola — sin ella no habría contra qué comparar, y no
  // tiene por qué ser el usuario el que descubra que hay que sembrarla.
  let referencia = leerJSON(REF_SALA_PATH, null);
  if (!referencia) {
    referencia = historialSala.referencia(legacy, precios, new Date().toISOString());
    guardarJSON(REF_SALA_PATH, referencia);
  }
  return { ...r, referencia };
}));

// Mismo tablero que el historial de sala pero sobre TODO lo que pasó por la sala: los registros
// que carga el sistema y, detrás, los resúmenes .xlsx archivados. Los dos traen cada lote con
// sus tres tareas, su encargado y su horario, así que los mide el mismo módulo y juntos dan la
// serie larga que las estadísticas necesitan.
//
// El archivo viejo entra sólo por las jornadas que los registros nuevos no cubren: una fecha que
// ya está cargada en el sistema manda, para no contar dos veces el mismo día. La tab Historial
// de sala sigue mostrando el archivo solo, sin este cruce.
async function cargasProduccion() {
  const snapshots = leerRegistros();
  const nuevas = productividad.unirPorId(leerJSON(PROD_REG_PATH, []), leerJSON(PROD_HIST_PATH, []),
                                         snapshots.flatMap(s => (s && s.cargas) || []));
  const legacy = resumenesLegacy.leerCarpeta(RESUMENES_DIR);
  const partido = partirTareasExtra(conNombresCompletos(
    [...nuevas, ...resumenesLegacy.sinFechasCubiertas(legacy.cargas, nuevas)],
    await nombresDeProductosOVacio()));
  // Las tareas sin producto del archivo viejo son las mismas que las tareas extra de hoy.
  return { cargas: partido.cargas, tareas: [...partido.tareas, ...legacy.tareas] };
}

router.get('/api/productividad/historial-produccion', apiRoute(async req => {
  const { cargas, tareas } = await cargasProduccion();
  let precios = new Map();
  try { precios = await preciosDeVenta(); } catch (e) { console.error('precios de venta:', e.message); }
  const r = historialSala.resumen({ cargas, tareas }, {
    desde: req.query.desde ? safeDate(req.query.desde) : null,
    hasta: req.query.hasta ? safeDate(req.query.hasta) : null,
    plu: String(req.query.plu || '').trim(),
    persona: String(req.query.persona || '').trim(),
  }, precios);
  let referencia = leerJSON(REF_PROD_PATH, null);
  if (!referencia) {
    referencia = historialSala.referencia({ cargas }, precios, new Date().toISOString());
    guardarJSON(REF_PROD_PATH, referencia);
  }
  return { ...r, referencia };
}));

router.post('/api/productividad/historial-produccion/referencia', apiRoute(async () => {
  let precios = new Map();
  try { precios = await preciosDeVenta(); } catch (e) { console.error('precios de venta:', e.message); }
  const referencia = historialSala.referencia({ cargas: (await cargasProduccion()).cargas },
                                              precios, new Date().toISOString());
  guardarJSON(REF_PROD_PATH, referencia);
  return referencia;
}));

// Recalcular la referencia: se lee el archivo entero de nuevo y la foto nueva pisa a la vieja.
// Va por POST y a pedido porque mueve la vara con la que se mide todo lo demás.
router.post('/api/productividad/historial/referencia', apiRoute(async () => {
  const legacy = resumenesLegacy.leerCarpeta(RESUMENES_DIR);
  let precios = new Map();
  try { precios = await preciosDeVenta(); } catch (e) { console.error('precios de venta:', e.message); }
  const referencia = historialSala.referencia(legacy, precios, new Date().toISOString());
  guardarJSON(REF_SALA_PATH, referencia);
  return referencia;
}));

  return router;
};
