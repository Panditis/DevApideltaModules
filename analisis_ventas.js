'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Análisis de Ventas por Sucursal — módulo puro (sin I/O ni SQL exec)
//  Sanitización de params, builders de SQL y derivaciones de KPIs.
// ─────────────────────────────────────────────────────────────────────────────

// Sucursales en alcance (la central id=1 se excluye siempre).
const SUCURSALES_ANALISIS = [2, 3, 4, 5, 7, 9, 10];
// Casa central: mismo análisis, pero es su propio módulo porque acá no hay comparación
// entre sucursales. Los builders de SQL se reusan pasando este id como único alcance.
const SUCURSAL_CENTRAL = 1;
const NOMBRE_DIA = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const TOP_N_DEFAULT = 20;

// Intersección de los ids pedidos con la whitelist. Vacío/ inválido -> whitelist completa.
function sucIdsSeguras(raw) {
  if (!raw) return [...SUCURSALES_ANALISIS];
  const pedidos = String(raw).split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isInteger(n));
  const filtradas = pedidos.filter(n => SUCURSALES_ANALISIS.includes(n));
  return filtradas.length ? filtradas : [...SUCURSALES_ANALISIS];
}

function clampTopN(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n)) return TOP_N_DEFAULT;
  return Math.min(100, Math.max(1, n));
}

function ticketProm(facturacion, tickets) {
  return tickets > 0 ? facturacion / tickets : 0;
}

function mapDiaSemana(dow) {
  return NOMBRE_DIA[dow] ?? String(dow);
}

function kpisGlobales(comparativa, resumen) {
  const facturacion = comparativa.reduce((a, r) => a + Number(r.Facturacion || 0), 0);
  const tickets     = comparativa.reduce((a, r) => a + Number(r.Tickets || 0), 0);
  return {
    facturacion,
    tickets,
    ticketProm: ticketProm(facturacion, tickets),
    unidades: Number(resumen?.Unidades || 0),
    productosDistintos: Number(resumen?.ProductosDistintos || 0),
  };
}

// Join cabecera→renglón por la clave compuesta de 5 columnas de SIGA.
const JOIN_CLAVE5 = `INNER JOIN Ventas v
    ON  v.IdSucursal=vp.IdSucursal AND v.IdTipoComprobante=vp.IdTipoComprobante
    AND v.Letra=vp.Letra AND v.CentroEmisor=vp.CentroEmisor
    AND v.NumeroComprobante=vp.NumeroComprobante`;

// Joins a Clientes/Categorias para excluir transferencias internas (categoría SUCURSAL).
const JOIN_CLIENTE_CAT = `LEFT JOIN Clientes c ON c.IdCliente = v.IdCliente
    LEFT JOIN Categorias cat ON cat.IdCategoria = c.IdCategoria`;

// Categoría de clientes "Sucursal" en SIGA: venderle a esas cuentas es una transferencia
// interna, no venta real. Se descarta por id y por nombre: el id es lo firme, el nombre
// cubre que mañana se abra otra categoría de sucursales con otro id.
const CATEGORIA_SUCURSAL_ID = 5;

// Cláusula WHERE con los filtros comunes. desde/hasta/sucIdsCsv YA saneados por el endpoint.
function whereVentas({ desde, hasta, sucIdsCsv }) {
  return `v.Fecha >= '${desde} 00:00:00' AND v.Fecha <= '${hasta} 23:59:59'
      AND ISNULL(v.IdEstadoComprobante,'') != 'ANULADO'
      AND v.IdSucursal IN (${sucIdsCsv})
      AND UPPER(ISNULL(cat.NombreCategoria,'')) != 'SUCURSAL'
      AND ISNULL(c.IdCategoria, 0) != ${CATEGORIA_SUCURSAL_ID}
      AND v.ImporteTotal > 0`;
}

// ── Rubros excluidos del análisis ────────────────────────────────────────────
// Nada de esto es venta de mostrador: "Bultos/Cajas" y "Almacen Bultos/Cajas" son el
// envase, "Pesables Deposito" es el granel que después se fracciona (la venta real se
// cuenta en Pesables Fraccionado) y "Apicultura" son los insumos del apiario. Si entran,
// inflan unidades, se cuelan en los tops y suman un artículo de más en cada ticket.
// Se filtra con NOT EXISTS contra el IdProducto del renglón (no con JOIN) para que la
// condición sirva igual en las consultas que no joinean Productos y para no duplicar filas.
const RUBROS_EXCLUIDOS = ['Bultos/Cajas', 'Almacen Bultos/Cajas', 'Pesables Deposito', 'Apicultura'];
// El nombre se compara sin espacios ("Bultos / Cajas") y con collation CI_AI, que ignora
// mayúsculas y acentos: la base puede tener "Pesables Depósito" con tilde.
const SIN_RUBROS_EXCLUIDOS = `NOT EXISTS (SELECT 1 FROM Productos pExc
      INNER JOIN Rubros rExc ON rExc.IdRubro = pExc.IdRubro
      WHERE pExc.IdProducto = vp.IdProducto
        AND REPLACE(COALESCE(rExc.NombreRubro,''),' ','') COLLATE Latin1_General_CI_AI IN (${
          RUBROS_EXCLUIDOS.map(r => `'${r.replace(/\s/g, '')}'`).join(', ')
        }))`;

// KPIs + comparativa: nivel cabecera (Ventas), 1 fila por comprobante.
function sqlComparativa(p) {
  return `SELECT v.IdSucursal, s.Nombre AS Nombre,
      SUM(v.ImporteTotal) AS Facturacion, COUNT(*) AS Tickets
    FROM Ventas v
    LEFT JOIN Sucursales s ON s.IdSucursal = v.IdSucursal
    ${JOIN_CLIENTE_CAT}
    WHERE ${whereVentas(p)}
    GROUP BY v.IdSucursal, s.Nombre
    ORDER BY Facturacion DESC`;
}

// Totales de unidades y productos distintos: nivel renglón (VentasProductos).
function sqlResumenRenglon(p) {
  return `SELECT SUM(vp.Cantidad) AS Unidades, COUNT(DISTINCT vp.IdProducto) AS ProductosDistintos
    FROM VentasProductos vp
    ${JOIN_CLAVE5}
    ${JOIN_CLIENTE_CAT}
    WHERE ${whereVentas(p)}
      AND ${SIN_RUBROS_EXCLUIDOS}`;
}

function sqlTendencia(p) {
  return `SELECT CAST(v.Fecha AS DATE) AS Fecha,
      SUM(v.ImporteTotal) AS Facturacion, COUNT(*) AS Tickets
    FROM Ventas v
    ${JOIN_CLIENTE_CAT}
    WHERE ${whereVentas(p)}
    GROUP BY CAST(v.Fecha AS DATE)
    ORDER BY Fecha`;
}

function sqlDiaSemana(p) {
  return `SELECT (DATEPART(WEEKDAY, v.Fecha) + @@DATEFIRST - 2) % 7 AS Dow,
      SUM(v.ImporteTotal) AS Facturacion, COUNT(*) AS Tickets
    FROM Ventas v
    ${JOIN_CLIENTE_CAT}
    WHERE ${whereVentas(p)}
    GROUP BY (DATEPART(WEEKDAY, v.Fecha) + @@DATEFIRST - 2) % 7
    ORDER BY Dow`;
}

function sqlHora(p) {
  return `SELECT DATEPART(HOUR, v.Fecha) AS Hora,
      SUM(v.ImporteTotal) AS Facturacion, COUNT(*) AS Tickets
    FROM Ventas v
    ${JOIN_CLIENTE_CAT}
    WHERE ${whereVentas(p)}
    GROUP BY DATEPART(HOUR, v.Fecha)
    ORDER BY Hora`;
}

// ── Exclusión de insumos ─────────────────────────────────────────────────────
// Un producto queda fuera de los tops si dice "INSUMO" en el nombre o en cualquiera de
// sus clasificaciones (rubro, subrubro, marca). Se filtra con NOT EXISTS y no con JOIN:
// si alguna clasificación tuviera clave compuesta, un JOIN podría duplicar renglones e
// inflar unidades y facturación; NOT EXISTS nunca multiplica filas.
const PALABRA_INSUMO = 'INSUMO';
const CLASIFICACIONES = [
  { tabla: 'Rubros',    alias: 'rIns',  nombre: 'NombreRubro',    claves: ['IdRubro'] },
  { tabla: 'SubRubros', alias: 'srIns', nombre: 'NombreSubRubro', claves: ['IdRubro', 'IdSubRubro'] },
  { tabla: 'Marcas',    alias: 'mIns',  nombre: 'NombreMarca',    claves: ['IdMarca'] },
];

function sqlMetaClasificacion() {
  const tablas = ['Productos', ...CLASIFICACIONES.map(c => c.tabla)].map(t => `'${t}'`).join(', ');
  return `SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME IN (${tablas})`;
}

// Se queda con las clasificaciones que esta instalación de SIGA realmente tiene: tabla
// presente, columna de nombre presente y al menos una clave que exista en ambos lados.
// Lo que no está se ignora en silencio: el filtro por nombre de producto siempre aplica.
function clasificacionesDisponibles(metaRows) {
  const porTabla = new Map();
  (metaRows || []).forEach(r => {
    const tabla = String(r.TABLE_NAME || '');
    if (!porTabla.has(tabla)) porTabla.set(tabla, new Set());
    porTabla.get(tabla).add(String(r.COLUMN_NAME || ''));
  });
  const colsProducto = porTabla.get('Productos') || new Set();
  return CLASIFICACIONES.reduce((acc, c) => {
    const cols = porTabla.get(c.tabla);
    if (!cols || !cols.has(c.nombre)) return acc;
    const claves = c.claves.filter(k => cols.has(k) && colsProducto.has(k));
    return claves.length ? [...acc, { ...c, claves }] : acc;
  }, []);
}

// Condición SQL que deja fuera los insumos. Asume que Productos está aliasado como `p`.
function filtroSinInsumos(disponibles) {
  const condiciones = [`UPPER(COALESCE(p.NombreProducto,'')) NOT LIKE '%${PALABRA_INSUMO}%'`];
  (disponibles || []).forEach(c => {
    const on = c.claves.map(k => `${c.alias}.${k} = p.${k}`).join(' AND ');
    condiciones.push(`NOT EXISTS (SELECT 1 FROM ${c.tabla} ${c.alias}
        WHERE ${on} AND UPPER(COALESCE(${c.alias}.${c.nombre},'')) LIKE '%${PALABRA_INSUMO}%')`);
  });
  return condiciones.join('\n      AND ');
}

// Top productos por 'unidades' o 'facturacion'. topN ya clampeado a entero.
// sinInsumos: condición extra ya armada (filtroSinInsumos); vacía = sin filtrar.
function sqlTopProductos(p, orden, topN, sinInsumos) {
  const col = orden === 'unidades' ? 'Unidades' : 'Facturacion';
  const filtro = sinInsumos ? `\n      AND ${sinInsumos}` : '';
  return `SELECT TOP ${topN} vp.IdProducto AS IdProducto, p.NombreProducto AS Nombre,
      SUM(vp.Cantidad) AS Unidades, SUM(vp.ImporteTotalNeto) AS Facturacion
    FROM VentasProductos vp
    ${JOIN_CLAVE5}
    ${JOIN_CLIENTE_CAT}
    INNER JOIN Productos p ON p.IdProducto = vp.IdProducto
    WHERE ${whereVentas(p)}
      AND ${SIN_RUBROS_EXCLUIDOS}${filtro}
    GROUP BY vp.IdProducto, p.NombreProducto
    ORDER BY ${col} DESC`;
}

// ── Quiebres de stock ────────────────────────────────────────────────────────
// Un producto está en quiebre un día si su stock de cierre quedó en el umbral o por
// debajo. El umbral se calcula por producto y sucursal sobre las ventas del rango:
// pesables 5% de la venta mensual; el resto, ese 5% pero nunca más de 4 unidades.
// SIGA no guarda foto histórica de stock, así que la serie diaria se reconstruye hacia
// atrás desde el stock de hoy (ver diasEnQuiebre).
const UMBRAL_PORC_VENTAS = 0.05;
const UMBRAL_TOPE_UNIDADES = 4;
// Días hábiles de un mes tipo: 30 días menos sus ~4,3 domingos.
const DIAS_HABILES_POR_MES = 26;
const RUBRO_PESABLES = 'Pesables Fraccionado';
const MS_POR_DIA = 86400000;

// IdProducto en SIGA es varchar y hay códigos no numéricos (existe un producto 'O'), así
// que la lista va entrecomillada: con literales int, SQL Server convierte la columna a int
// y revienta con "Conversion failed when converting the varchar value 'O'". Las comillas
// simples se duplican, que es el escape de SQL Server.
function idsCsvSeguro(ids) {
  const limpios = (ids || [])
    .map(id => String(id ?? '').trim())
    .filter(Boolean)
    .map(id => id.replace(/'/g, "''"));
  return [...new Set(limpios)].map(id => `'${id}'`).join(',');
}

function sqlPesables(idsCsv) {
  return `SELECT p.IdProducto FROM Productos p
    JOIN Rubros r ON r.IdRubro = p.IdRubro
    WHERE r.NombreRubro = '${RUBRO_PESABLES}'${idsCsv ? ` AND p.IdProducto IN (${idsCsv})` : ''}`;
}

// Stock de hoy por producto y sucursal: punto de partida de la reconstrucción.
function sqlStockPorSucursal(idsCsv, sucIdsCsv) {
  return `SELECT pd.IdProducto, pd.IdSucursal, SUM(pd.Stock) AS Stock
    FROM ProductosDepositos pd
    JOIN SucursalesDepositos sd ON sd.IdDeposito = pd.IdDeposito AND sd.IdSucursal = pd.IdSucursal
    WHERE pd.IdSucursal IN (${sucIdsCsv})${idsCsv ? ` AND pd.IdProducto IN (${idsCsv})` : ''}
    GROUP BY pd.IdProducto, pd.IdSucursal`;
}

// Neto de stock por día. mp.Cantidad YA viene firmada en SIGA: una venta descuenta y queda
// en negativo, un ajuste o una recepción de sucursal suma y queda en positivo. Por eso se
// suma tal cual, sin TiposMovimientos.CoeficienteStock: multiplicar por el coeficiente
// duplicaba el signo, y cuando venía nulo dejaba todos los netos en cero (serie de stock
// plana y productos con el rango entero marcado en quiebre).
// Las ventas también son movimiento, así que no hay que sumarlas aparte.
// Sólo devuelve días con movimiento; los demás se asumen en cero.
function sqlNetoDiarioStock(desde, sucIdsCsv, idsCsv) {
  // Entradas aparte del neto: un día con recepción de +50 y ventas de -48 da neto +2, y uno
  // con +10 y -30 da neto -20 aunque también hubo mercadería. Para saber si se repuso hay
  // que sumar sólo los movimientos positivos.
  return `SELECT mp.IdProducto, m.IdSucursal, CAST(m.FechaMovimiento AS DATE) AS Fecha,
      SUM(mp.Cantidad) AS Neto,
      SUM(CASE WHEN mp.Cantidad > 0 THEN mp.Cantidad ELSE 0 END) AS Entradas
    FROM MovimientosStockProductos mp
    INNER JOIN MovimientosStock m ON m.IdSucursal = mp.IdSucursal
      AND m.IdTipoMovimiento = mp.IdTipoMovimiento AND m.NumeroMovimiento = mp.NumeroMovimiento
    WHERE m.FechaMovimiento >= '${desde} 00:00:00'
      AND m.IdSucursal IN (${sucIdsCsv})${idsCsv ? ` AND mp.IdProducto IN (${idsCsv})` : ''}
    GROUP BY mp.IdProducto, m.IdSucursal, CAST(m.FechaMovimiento AS DATE)`;
}

// Movimientos uno por uno, para auditar contra SIGA de dónde sale cada neto diario.
// IdTipoMovimiento ya es descriptivo ('COMPRA', 'VENTA'...), así que no hace falta join.
function sqlMovimientosProducto(desde, sucIdsCsv, idsCsv, tope = 500) {
  return `SELECT TOP ${tope} CONVERT(varchar(19), m.FechaMovimiento, 120) AS Fecha,
      mp.IdTipoMovimiento AS Tipo, mp.NumeroMovimiento AS Numero, mp.Cantidad AS Cantidad
    FROM MovimientosStockProductos mp
    INNER JOIN MovimientosStock m ON m.IdSucursal = mp.IdSucursal
      AND m.IdTipoMovimiento = mp.IdTipoMovimiento AND m.NumeroMovimiento = mp.NumeroMovimiento
    WHERE m.FechaMovimiento >= '${desde} 00:00:00'
      AND m.IdSucursal IN (${sucIdsCsv})${idsCsv ? ` AND mp.IdProducto IN (${idsCsv})` : ''}
    ORDER BY m.FechaMovimiento DESC`;
}

// Unidades vendidas por producto y sucursal: el umbral es por sucursal, así que no
// alcanza con el total del producto que ya devuelve sqlTopProductos.
function sqlUnidadesPorSucursal(p, idsCsv) {
  return `SELECT vp.IdProducto, vp.IdSucursal, SUM(vp.Cantidad) AS Unidades
    FROM VentasProductos vp
    ${JOIN_CLAVE5}
    ${JOIN_CLIENTE_CAT}
    WHERE ${whereVentas(p)}
      AND ${SIN_RUBROS_EXCLUIDOS}${idsCsv ? ` AND vp.IdProducto IN (${idsCsv})` : ''}
    GROUP BY vp.IdProducto, vp.IdSucursal`;
}

function fechaUTC(iso) {
  return new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
}

function diaAnterior(iso) {
  return new Date(fechaUTC(iso) - MS_POR_DIA).toISOString().slice(0, 10);
}

// Rango en meses, contando sólo días hábiles: los domingos no abren, así que no aportan
// venta y no deben diluir el promedio mensual. Por eso el divisor es 26 y no 30.
// Piso de un día: un rango que caiga todo en domingo no puede dar cero meses, porque
// después dividiría por cero al llevar las ventas a mensuales.
function mesesDelRango(desde, hasta) {
  let habiles = 0;
  for (let fecha = String(hasta).slice(0, 10); fecha >= desde; fecha = diaAnterior(fecha)) {
    if (fechaUTC(fecha).getUTCDay() !== 0) habiles++;
  }
  return Math.max(1, habiles) / DIAS_HABILES_POR_MES;
}

// Pesable: 5% de la venta mensual. No pesable: ese mismo 5% pero topeado en 4 unidades,
// para no exigirle un stock enorme a un producto que vende mucho.
function umbralQuiebre(unidadesRango, meses, esPesable) {
  const ventasMes = meses > 0 ? Number(unidadesRango || 0) / meses : 0;
  const porcentual = ventasMes * UMBRAL_PORC_VENTAS;
  return esPesable ? porcentual : Math.min(porcentual, UMBRAL_TOPE_UNIDADES);
}

// Serie diaria de stock dentro del rango, en orden cronológico. Camina desde hoy hacia
// atrás: cierre(D-1) = cierre(D) - neto(D). Los días posteriores al rango no entran en la
// serie, pero igual se recorren para arrastrar el stock hasta el rango.
//
// El quiebre se evalúa sobre la APERTURA (el cierre del día anterior), no sobre el cierre:
// si el día arrancó bajo el umbral, el faltante venía heredado y se perdió venta desde que
// abrió. Mirar el cierre marcaría como quiebre un día que estuvo abastecido toda la jornada
// y quedó bajo sólo por sus propias ventas.
//
// Un día con reposición no cuenta aunque haya abierto corto: la mercadería llegó y el
// faltante se resolvió ese mismo día. Se mira la suma de entradas (movimientos positivos),
// no el neto, que puede quedar negativo si las ventas del día superan lo recibido.
function serieStockDiaria({ stockActual, netosPorFecha, entradasPorFecha, desde, hasta, hoy, umbral }) {
  const fin = hasta < hoy ? hasta : hoy;
  const netos = netosPorFecha || {};
  const entradas = entradasPorFecha || {};
  const serie = [];
  let stock = Number(stockActual || 0);
  for (let fecha = hoy; fecha >= desde; fecha = diaAnterior(fecha)) {
    const neto = Number(netos[fecha] || 0);
    const entrada = Number(entradas[fecha] || 0);
    const apertura = stock - neto;
    // Los locales no abren los domingos: no puede haber quiebre de cara al cliente. Igual
    // entran en la serie y arrastran su neto, porque puede haber movimientos de depósito.
    const domingo = fechaUTC(fecha).getUTCDay() === 0;
    if (fecha <= fin) {
      serie.push({
        fecha, apertura, cierre: stock, neto, entrada, domingo,
        quiebre: !domingo && entrada <= 0 && apertura <= umbral,
      });
    }
    stock = apertura;
  }
  return serie.reverse();
}

// Cuenta TODOS los días del rango con stock <= umbral (no rachas: cada día suma uno).
function diasEnQuiebre(args) {
  return serieStockDiaria(args).filter(d => d.quiebre).length;
}

// Base para el porcentaje: los días que PODRÍAN haber sido quiebre. Los domingos quedan
// afuera; incluirlos bajaría el porcentaje de todos los productos por igual y haría ver
// mejor de lo que es una sucursal que estuvo desabastecida toda la semana hábil.
function diasEvaluados(serie) {
  return (serie || []).filter(d => !d.domingo).length;
}

function porcentajeQuiebre(dias, base) {
  return base > 0 ? (Number(dias || 0) * 100) / base : 0;
}

// ── Artículos por ticket ─────────────────────────────────────────────────────
// "Artículos" = renglones (líneas) del comprobante: cuántos ítems distintos se
// llevó cada cliente. Se cuenta agrupando VentasProductos por la clave de 5
// columnas del comprobante (mismo criterio que el JOIN cabecera→renglón).
const GROUP_TICKET = `vp.IdSucursal, vp.IdTipoComprobante, vp.Letra, vp.CentroEmisor, vp.NumeroComprobante`;

// Histograma: para cada N (cantidad de artículos del ticket), cuántos tickets tuvieron ese N.
function sqlArticulosHistograma(p) {
  return `SELECT t.Articulos AS Articulos, COUNT(*) AS Tickets FROM (
      SELECT COUNT(*) AS Articulos
      FROM VentasProductos vp
      ${JOIN_CLAVE5}
      ${JOIN_CLIENTE_CAT}
      WHERE ${whereVentas(p)}
        AND ${SIN_RUBROS_EXCLUIDOS}
      GROUP BY ${GROUP_TICKET}
    ) t
    GROUP BY t.Articulos
    ORDER BY t.Articulos`;
}

// Promedio de artículos por ticket, por sucursal. TicketsDia se calcula sobre los días
// con ventas de esa sucursal (no sobre los días calendario del rango) para que los días
// cerrados o sin actividad no hundan el promedio.
function sqlArticulosPorSucursal(p) {
  return `SELECT t.IdSucursal AS IdSucursal, s.Nombre AS Nombre,
      COUNT(*) AS Tickets, SUM(t.Articulos) AS Articulos,
      CAST(SUM(t.Articulos) AS FLOAT) / COUNT(*) AS Promedio,
      COUNT(DISTINCT t.Fecha) AS Dias,
      CAST(COUNT(*) AS FLOAT) / NULLIF(COUNT(DISTINCT t.Fecha), 0) AS TicketsDia
    FROM (
      SELECT vp.IdSucursal AS IdSucursal, COUNT(*) AS Articulos,
        MIN(CAST(v.Fecha AS DATE)) AS Fecha
      FROM VentasProductos vp
      ${JOIN_CLAVE5}
      ${JOIN_CLIENTE_CAT}
      WHERE ${whereVentas(p)}
        AND ${SIN_RUBROS_EXCLUIDOS}
      GROUP BY ${GROUP_TICKET}
    ) t
    LEFT JOIN Sucursales s ON s.IdSucursal = t.IdSucursal
    GROUP BY t.IdSucursal, s.Nombre
    ORDER BY Promedio DESC`;
}

// Buckets fijos para el histograma: rangos de a dos (salvo el primero) para que la
// torta quede en 5 porciones legibles y la cola larga no se pulverice.
const BUCKETS_ARTICULOS = [
  { label: '1-3', min: 1, max: 3 },
  { label: '4-5', min: 4, max: 5 },
  { label: '6-7', min: 6, max: 7 },
  { label: '8-9', min: 8, max: 9 },
  { label: '+10', min: 10, max: Infinity },
];

// Colapsa el histograma exacto (filas {Articulos, Tickets}) en los buckets fijos.
function bucketsArticulos(histRows) {
  return BUCKETS_ARTICULOS.map(b => {
    const tickets = (histRows || []).reduce((a, r) => {
      const n = Number(r.Articulos || 0);
      return n >= b.min && n <= b.max ? a + Number(r.Tickets || 0) : a;
    }, 0);
    return { label: b.label, tickets };
  });
}

// Promedio global de artículos/ticket a partir del desglose por sucursal.
function promedioArticulos(porSucursal) {
  const tickets   = (porSucursal || []).reduce((a, r) => a + Number(r.Tickets || 0), 0);
  const articulos = (porSucursal || []).reduce((a, r) => a + Number(r.Articulos || 0), 0);
  return tickets > 0 ? articulos / tickets : 0;
}

// ── Familias de producto ─────────────────────────────────────────────────────
// Una "familia" es el producto sin su presentación: MIEL PURA 500G, MIEL PURA 1KG y
// MIEL PURA PACK 6 son la misma familia MIEL PURA. Mismo criterio que usa el catálogo
// (normalizarNombre + extraerPresentacion en server.js), replicado acá para no arrastrar
// la dependencia: se corta el sufijo de peso/volumen y las variantes pack/bulto/vid.
const LIMITE_FAMILIAS = 1000;
const SUFIJO_VARIANTE = /\s+(pack|bulto|vid)\b.*$/i;
const SUFIJO_MULTIPLO = /\s*[xX]\s*\d+(?:[.,]\d+)?\s*(?:kg|kgs|g|gr|grs|ml|cc|lt|l|un|u)?\s*$/i;
// "x" huérfana que queda cuando el sufijo se cortó en dos pasos (ALMENDRA X 1 KG).
const X_COLGANTE = /\s+x$/i;
const SUFIJO_PRESENTACION = /\s*\d+(?:[.,]\d+)?\s*(?:kg|kgs|g|gr|grs|ml|cc|lt|l|un|u)\b.*$/i;

// Todas las mieles Apidelta son una sola familia: acacia, eucalipto, milflores y demás
// variedades son el mismo producto para el análisis, y separadas por presentación se
// pulverizan en decenas de filas. Sólo entra la nomenclatura exacta de la línea:
// "Miel <variedad> Apidelta <presentación>" — de ahí que se exija la variedad en el medio.
// Quedan afuera el artículo suelto "MIEL" (sin marca) y los derivados que sólo la
// mencionan (ARITOS CON MIEL, MERM APIDELTA … MIEL, JUGO … APIDELTA CON MIEL).
const MIEL_APIDELTA = /^miel\s+.+\s+apidelta\b/i;
const FAMILIA_MIEL_APIDELTA = 'MIEL APIDELTA';

// Nombre de familia legible. Si al recortar no queda nada, se devuelve el nombre original
// (un producto llamado sólo "1KG" es un dato sucio, pero no puede desaparecer del reporte).
function familiaNombre(nombre) {
  const original = String(nombre || '').trim();
  if (MIEL_APIDELTA.test(original)) return FAMILIA_MIEL_APIDELTA;
  const base = original
    .replace(SUFIJO_VARIANTE, '')
    .replace(/\bvid\s+/i, '')
    .replace(SUFIJO_MULTIPLO, '')
    .replace(SUFIJO_PRESENTACION, '')
    .replace(X_COLGANTE, '')
    .replace(/[\s.,;:-]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return base || original;
}

// Clave de agrupación: sin acentos, sin mayúsculas y sin espacios de más, para que
// "Miel Pura" y "MIEL  PURA" caigan en la misma fila.
function claveFamilia(familia) {
  return String(familia || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s{2,}/g, ' ').trim();
}

// Colapsa filas {IdProducto, Nombre, Unidades, Facturacion} en familias, sumando las
// presentaciones. Devuelve las topN familias por facturación, cada una con su detalle.
function agruparFamilias(rows, topN) {
  const mapa = new Map();
  (rows || []).forEach(r => {
    const nombre = String(r.Nombre || '').trim();
    if (!nombre) return;
    const familia = familiaNombre(nombre);
    const clave = claveFamilia(familia);
    if (!mapa.has(clave)) mapa.set(clave, { familia, unidades: 0, facturacion: 0, presentaciones: [] });
    const g = mapa.get(clave);
    const unidades = Number(r.Unidades || 0);
    const facturacion = Number(r.Facturacion || 0);
    g.unidades += unidades;
    g.facturacion += facturacion;
    g.presentaciones.push({ idProd: r.IdProducto, nombre, unidades, facturacion });
  });
  return [...mapa.values()]
    .map(g => ({
      ...g,
      presentaciones: [...g.presentaciones].sort((a, b) => b.facturacion - a.facturacion),
    }))
    .sort((a, b) => b.facturacion - a.facturacion)
    .slice(0, topN || TOP_N_DEFAULT);
}

module.exports = {
  SUCURSALES_ANALISIS, SUCURSAL_CENTRAL, NOMBRE_DIA, TOP_N_DEFAULT, BUCKETS_ARTICULOS, LIMITE_FAMILIAS,
  PALABRA_INSUMO, CLASIFICACIONES, CATEGORIA_SUCURSAL_ID, RUBROS_EXCLUIDOS, SIN_RUBROS_EXCLUIDOS,
  sucIdsSeguras, clampTopN, ticketProm, mapDiaSemana, kpisGlobales,
  whereVentas, sqlComparativa, sqlResumenRenglon,
  sqlTendencia, sqlDiaSemana, sqlHora, sqlTopProductos,
  sqlMetaClasificacion, clasificacionesDisponibles, filtroSinInsumos,
  UMBRAL_PORC_VENTAS, UMBRAL_TOPE_UNIDADES, RUBRO_PESABLES,
  idsCsvSeguro, sqlPesables, sqlStockPorSucursal, sqlNetoDiarioStock, sqlUnidadesPorSucursal,
  sqlMovimientosProducto,
  mesesDelRango, diaAnterior, umbralQuiebre, diasEnQuiebre, serieStockDiaria,
  diasEvaluados, porcentajeQuiebre,
  sqlArticulosHistograma, sqlArticulosPorSucursal, bucketsArticulos, promedioArticulos,
  familiaNombre, claveFamilia, agruparFamilias,
};
