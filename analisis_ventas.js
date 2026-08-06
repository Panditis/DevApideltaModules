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

// ── Importe facturado de un renglón ──────────────────────────────────────────
// vp.ImporteTotal es el neto SIN impuestos (Precio × Cantidad, antes del descuento
// general), así que sumarlo dejaba los tops ~21% por debajo de lo que muestra SIGA:
// el código 2544 con 500 unidades daba 1.638.430 contra 1.883.375 reales.
// El importe que ve el usuario es el neto final más los impuestos del renglón, y esa
// suma reconstruye la cabecera Ventas.ImporteTotal al centavo.
// ImporteTotalConImpuestos NO sirve: ignora el descuento/recargo general.
function exprImporteRenglon(alias = 'vp') {
  return `(${alias}.ImporteTotalNeto + ISNULL(${alias}.ImporteImpuesto, 0)`
    + ` + ISNULL(${alias}.ImporteImpuestoInterno, 0))`;
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

// ── Productos que no son venta real (sólo casa central) ──────────────────────
// Salen por la caja de la central pero no son venta de mostrador: el 302158 es una carga
// interna y el 1 ("A Articulos Varios", rubro ADMINISTRACION) es el comodín administrativo
// con el que se carga cualquier cosa. Se excluyen en los dos niveles: el renglón no
// cuenta (unidades, tops, artículos del ticket) y su importe se descuenta del total
// del comprobante, así la facturación tampoco los arrastra.
// El filtro se activa pasando `excProdCsv` en los parámetros: el análisis por sucursales
// no lo manda, así que sus consultas quedan exactamente como estaban.
const PRODUCTOS_EXCLUIDOS_CENTRAL = ['302158', '1'];

// Condición de renglón: descarta los productos excluidos. Vacía si no hay lista.
function sinProductosExcluidos(excProdCsv) {
  return excProdCsv ? `vp.IdProducto NOT IN (${excProdCsv})` : '';
}

// La misma condición ya lista para concatenar dentro de un WHERE (vacía = no suma nada).
function andSinProductosExcluidos(excProdCsv, sangria = '      ') {
  const cond = sinProductosExcluidos(excProdCsv);
  return cond ? `\n${sangria}AND ${cond}` : '';
}

// Importe de los renglones excluidos agregado POR COMPROBANTE. Se agrupa en un derivado
// y se engancha por la clave de 5 columnas: un JOIN directo a VentasProductos duplicaría
// las filas de cabecera y con eso la facturación y los tickets.
// El derivado se acota al mismo alcance de sucursales que la consulta para no barrer
// VentasProductos entera cuando el análisis es de una sola sucursal.
function joinImporteExcluido(excProdCsv, sucIdsCsv) {
  if (!excProdCsv) return '';
  return `LEFT JOIN (
      SELECT vpe.IdSucursal, vpe.IdTipoComprobante, vpe.Letra, vpe.CentroEmisor,
        vpe.NumeroComprobante, SUM(${exprImporteRenglon('vpe')}) AS Importe
      FROM VentasProductos vpe
      WHERE vpe.IdProducto IN (${excProdCsv})
        AND vpe.IdSucursal IN (${sucIdsCsv})
      GROUP BY vpe.IdSucursal, vpe.IdTipoComprobante, vpe.Letra, vpe.CentroEmisor,
        vpe.NumeroComprobante
    ) exc ON exc.IdSucursal = v.IdSucursal AND exc.IdTipoComprobante = v.IdTipoComprobante
      AND exc.Letra = v.Letra AND exc.CentroEmisor = v.CentroEmisor
      AND exc.NumeroComprobante = v.NumeroComprobante`;
}

// Facturación de cabecera neta de los renglones excluidos. Se resta con el importe de
// renglón con impuestos (exprImporteRenglon), que es la misma base que v.ImporteTotal.
function exprFacturacion(excProdCsv) {
  return excProdCsv ? `SUM(v.ImporteTotal - ISNULL(exc.Importe, 0))` : `SUM(v.ImporteTotal)`;
}

// Tickets: un comprobante que sólo tenía el producto excluido queda en cero al restarlo,
// y entonces no era una venta: no se cuenta.
function exprTickets(excProdCsv) {
  return excProdCsv
    ? `SUM(CASE WHEN v.ImporteTotal - ISNULL(exc.Importe, 0) > 0 THEN 1 ELSE 0 END)`
    : `COUNT(*)`;
}

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
// Alcance por defecto: el análisis por sucursales. "Pesables Deposito" es el granel que
// después se fracciona (la venta real se cuenta en Pesables Fraccionado) y "Apicultura"
// son los insumos del apiario. Ojo con los otros dos: "Bultos/Cajas" no existe como rubro
// en la base (filtra cero productos) y "Almacen Bultos/Cajas" son 873 productos de venta
// real por bulto/pack — por eso casa central usa su propia lista, más abajo.
// Se filtra con NOT EXISTS contra el IdProducto del renglón (no con JOIN) para que la
// condición sirva igual en las consultas que no joinean Productos y para no duplicar filas.
const RUBROS_EXCLUIDOS = ['Bultos/Cajas', 'Almacen Bultos/Cajas', 'Pesables Deposito', 'Apicultura'];

// Casa central tiene su propio criterio: ahí lo único que no es venta de mostrador son los
// insumos del apiario. "Almacen Bultos/Cajas" son los bultos y packs de almacén (873
// productos: es venta mayorista real, no envase) y el granel de depósito también se vende,
// así que excluirlos escondía ventas enteras. Los códigos puntuales que no son venta real
// se sacan uno por uno con PRODUCTOS_EXCLUIDOS_CENTRAL, no por rubro.
const RUBROS_EXCLUIDOS_CENTRAL = ['Apicultura'];

// El nombre se compara sin espacios ("Bultos / Cajas") y con collation CI_AI, que ignora
// mayúsculas y acentos: la base puede tener "Pesables Depósito" con tilde.
function sinRubrosExcluidos(lista) {
  const rubros = (lista && lista.length ? lista : RUBROS_EXCLUIDOS)
    .map(r => `'${r.replace(/\s/g, '')}'`).join(', ');
  return `NOT EXISTS (SELECT 1 FROM Productos pExc
      INNER JOIN Rubros rExc ON rExc.IdRubro = pExc.IdRubro
      WHERE pExc.IdProducto = vp.IdProducto
        AND REPLACE(COALESCE(rExc.NombreRubro,''),' ','') COLLATE Latin1_General_CI_AI IN (${rubros}))`;
}

// Alcance por defecto (análisis por sucursales), que es el que se usa si p no trae lista.
const SIN_RUBROS_EXCLUIDOS = sinRubrosExcluidos(RUBROS_EXCLUIDOS);

// KPIs + comparativa: nivel cabecera (Ventas), 1 fila por comprobante.
function sqlComparativa(p) {
  return `SELECT v.IdSucursal, s.Nombre AS Nombre,
      ${exprFacturacion(p.excProdCsv)} AS Facturacion, ${exprTickets(p.excProdCsv)} AS Tickets
    FROM Ventas v
    LEFT JOIN Sucursales s ON s.IdSucursal = v.IdSucursal
    ${JOIN_CLIENTE_CAT}
    ${joinImporteExcluido(p.excProdCsv, p.sucIdsCsv)}
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
      AND ${sinRubrosExcluidos(p.rubrosExcluidos)}${andSinProductosExcluidos(p.excProdCsv)}`;
}

function sqlTendencia(p) {
  return `SELECT CAST(v.Fecha AS DATE) AS Fecha,
      ${exprFacturacion(p.excProdCsv)} AS Facturacion, ${exprTickets(p.excProdCsv)} AS Tickets
    FROM Ventas v
    ${JOIN_CLIENTE_CAT}
    ${joinImporteExcluido(p.excProdCsv, p.sucIdsCsv)}
    WHERE ${whereVentas(p)}
    GROUP BY CAST(v.Fecha AS DATE)
    ORDER BY Fecha`;
}

function sqlDiaSemana(p) {
  return `SELECT (DATEPART(WEEKDAY, v.Fecha) + @@DATEFIRST - 2) % 7 AS Dow,
      ${exprFacturacion(p.excProdCsv)} AS Facturacion, ${exprTickets(p.excProdCsv)} AS Tickets
    FROM Ventas v
    ${JOIN_CLIENTE_CAT}
    ${joinImporteExcluido(p.excProdCsv, p.sucIdsCsv)}
    WHERE ${whereVentas(p)}
    GROUP BY (DATEPART(WEEKDAY, v.Fecha) + @@DATEFIRST - 2) % 7
    ORDER BY Dow`;
}

function sqlHora(p) {
  return `SELECT DATEPART(HOUR, v.Fecha) AS Hora,
      ${exprFacturacion(p.excProdCsv)} AS Facturacion, ${exprTickets(p.excProdCsv)} AS Tickets
    FROM Ventas v
    ${JOIN_CLIENTE_CAT}
    ${joinImporteExcluido(p.excProdCsv, p.sucIdsCsv)}
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
  // El rubro viaja con cada producto porque el equivalente en kilos/litros sólo se calcula
  // sobre fraccionado y bultos (ver equivalenteFamilia). LEFT JOIN: un producto sin rubro
  // sigue contando en unidades y facturación, sólo se queda sin equivalente.
  return `SELECT TOP ${topN} vp.IdProducto AS IdProducto, p.NombreProducto AS Nombre,
      ISNULL(rp.NombreRubro,'') AS Rubro,
      SUM(vp.Cantidad) AS Unidades, SUM(${exprImporteRenglon()}) AS Facturacion
    FROM VentasProductos vp
    ${JOIN_CLAVE5}
    ${JOIN_CLIENTE_CAT}
    INNER JOIN Productos p ON p.IdProducto = vp.IdProducto
    LEFT JOIN Rubros rp ON rp.IdRubro = p.IdRubro
    WHERE ${whereVentas(p)}
      AND ${sinRubrosExcluidos(p.rubrosExcluidos)}${filtro}${andSinProductosExcluidos(p.excProdCsv)}
    GROUP BY vp.IdProducto, p.NombreProducto, rp.NombreRubro
    ORDER BY ${col} DESC`;
}

// ── Ventas por cliente ───────────────────────────────────────────────────────
// Se pide a nivel cliente×producto y el total del cliente se arma sumando su detalle:
// así la fila del ranking y su desplegable salen del mismo dato y no pueden discrepar.
// Los filtros son los mismos que el resto del módulo (categoría Sucursal, rubros y
// productos excluidos), por eso reusa whereVentas y las condiciones de renglón.
function sqlVentasPorClienteProducto(p) {
  return `SELECT v.IdCliente AS IdCliente,
      LTRIM(RTRIM(ISNULL(c.NombreCliente,''))) AS Cliente,
      vp.IdProducto AS IdProducto, p.NombreProducto AS Nombre,
      ISNULL(mp.NombreMarca,'') AS Marca,
      SUM(vp.Cantidad) AS Unidades, SUM(${exprImporteRenglon()}) AS Facturacion
    FROM VentasProductos vp
    ${JOIN_CLAVE5}
    ${JOIN_CLIENTE_CAT}
    INNER JOIN Productos p ON p.IdProducto = vp.IdProducto
    LEFT JOIN Marcas mp ON mp.IdMarca = p.IdMarca
    WHERE ${whereVentas(p)}
      AND ${sinRubrosExcluidos(p.rubrosExcluidos)}${andSinProductosExcluidos(p.excProdCsv)}
    GROUP BY v.IdCliente, LTRIM(RTRIM(ISNULL(c.NombreCliente,''))), vp.IdProducto, p.NombreProducto,
      ISNULL(mp.NombreMarca,'')
    ORDER BY Facturacion DESC`;
}

// Etiqueta para las ventas sin cliente identificado (mostrador). No se descartan: son
// venta real y hay que poder verlas en el ranking.
const CLIENTE_SIN_NOMBRE = 'Sin cliente';

// ── Producto de marca propia ─────────────────────────────────────────────────
// Se resuelve por marca Y por nombre porque en SIGA ninguna de las dos alcanza sola: hay
// 1.190 productos de la marca "Apidelta" que no dicen "Apidelta" en el nombre (las mieles
// a granel en tambor, por ejemplo) y hay 82 mermeladas y 45 conservas Apidelta cargadas
// bajo marcas genéricas ("Mermeladas y Untables", "Conservas y Salsas"). Con la unión de
// los dos criterios no queda ningún producto propio afuera.
// Pago De Los Arroyos es la otra línea propia de la casa y cuenta igual que Apidelta.
const MARCAS_PROPIAS = ['apidelta', 'pago de los arroyos'];

// Las granolas de elaboración propia no llevan la marca en el nombre: se cargan con el
// prefijo "G." y la variedad ("G. Crunch 500G", "G. Chocolate Gold 250G", "G. Keto 40G").
// Se exige el punto y que siga una letra para no confundirlo con un nombre que empiece
// con G. La marca "Granolas" no sirve como criterio: ahí también están las granolas de
// terceros (Natural Candy, Paqueta, Fermar).
const GRANOLA_PROPIA = /^g\.\s*[a-záéíóúñ]/i;

// Los mix de frutos secos de armado propio tampoco dicen Apidelta. Son seis variedades y
// se listan una por una: la palabra "mix" sola no alcanza (hay Mix Tropical Iqf congelado,
// Mix Chantilly, Mix Costa De Mar, todos de reventa) y la marca tampoco ("Mix Frutos
// Secos" y "Apidelta" se reparten las presentaciones de un mismo mix sin criterio).
// Los puntos son opcionales porque el catálogo tiene las dos formas ("F.S" y "F.S.") y
// cada patrón corta con (?![a-z]) para que "Tropic" no se coma "Tropical Iqf".
const MIX_PROPIOS = [
  /^mix\s+europeo(?![a-z])/,
  /^mix\s+f\.?\s*s\.?\s+sin\s+pasas(?![a-z])/,
  /^mix\s+f\.?\s*s\.?\s+n\s*&\s*p(?![a-z])/,
  /^mix\s+tropic(?![a-z])/,
  /^mix\s+cerv\.?\s+prem(?![a-z])/,
  /^mix\s+cervecero(?![a-z])/,
];

// Normaliza para comparar: sin acentos, sin mayúsculas y sin espacios de más.
function normalizarTexto(txt) {
  return String(txt || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s{2,}/g, ' ').trim();
}

// Un producto es propio si su marca es una de las líneas de la casa (o una variante:
// "Apidelta Miel", "Apidelta Yerba", "Apidelta Aceite Oliva"…), si el nombre la menciona,
// o si es una elaboración propia que no lleva la marca en el nombre: las granolas
// (prefijo "G.") y los seis mix de frutos secos.
function esProductoPropio(nombre, marca) {
  const n = normalizarTexto(nombre);
  const m = normalizarTexto(marca);
  if (GRANOLA_PROPIA.test(n)) return true;
  if (MIX_PROPIOS.some(re => re.test(n))) return true;
  return MARCAS_PROPIAS.some(propia => m.startsWith(propia) || n.includes(propia));
}

// Colapsa filas cliente×producto en clientes, con el detalle de qué compró cada uno.
// Mismo contrato que agruparFamilias: totales sumables (kilos/litros) más las unidades
// crudas, detalle ordenado por facturación y corte en topN.
// Además marca qué productos son de marca propia y cuenta cuántas FAMILIAS propias
// distintas le trabaja el cliente: dos presentaciones de la misma línea (Miel Apidelta
// 500G y 1Kg) son una sola familia, que es la pregunta comercial de verdad.
function agruparClientes(rows, topN) {
  const mapa = new Map();
  (rows || []).forEach(r => {
    const clave = String(r.IdCliente ?? '').trim() || CLIENTE_SIN_NOMBRE;
    if (!mapa.has(clave)) mapa.set(clave, {
      idCliente: r.IdCliente ?? null, cliente: String(r.Cliente || '').trim() || CLIENTE_SIN_NOMBRE,
      unidades: 0, kilos: 0, litros: 0, unidadesSinEquivalencia: 0, facturacion: 0,
      facturacionPropia: 0, familiasPropias: 0, productos: [], _famPropias: new Set(),
    });
    const g = mapa.get(clave);
    const nombre = String(r.Nombre || '').trim();
    const unidades = Number(r.Unidades || 0);
    const facturacion = Number(r.Facturacion || 0);
    const peso = pesoPresentacion(nombre);
    const equivalente = peso ? redondearMagnitud(peso.cantidad * unidades) : null;
    const propio = esProductoPropio(nombre, r.Marca);
    const familia = familiaNombre(nombre, r.IdProducto);
    g.unidades += unidades;
    g.facturacion += facturacion;
    if (!peso) g.unidadesSinEquivalencia += unidades;
    else if (peso.unidad === 'kg') g.kilos = redondearMagnitud(g.kilos + equivalente);
    else g.litros = redondearMagnitud(g.litros + equivalente);
    if (propio) {
      g.facturacionPropia += facturacion;
      g._famPropias.add(claveFamilia(familia));
    }
    g.productos.push({
      idProd: r.IdProducto, nombre, unidades, facturacion, propio, familia,
      marca: String(r.Marca || '').trim(),
      kilos: peso && peso.unidad === 'kg' ? equivalente : null,
      litros: peso && peso.unidad === 'l' ? equivalente : null,
    });
  });
  return [...mapa.values()]
    .map(({ _famPropias, ...g }) => ({
      ...g,
      familiasPropias: _famPropias.size,
      productos: [...g.productos].sort((a, b) => b.facturacion - a.facturacion),
    }))
    .sort((a, b) => b.facturacion - a.facturacion)
    .slice(0, topN || TOP_N_DEFAULT);
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
      AND ${sinRubrosExcluidos(p.rubrosExcluidos)}${idsCsv ? ` AND vp.IdProducto IN (${idsCsv})` : ''}${andSinProductosExcluidos(p.excProdCsv)}
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
        AND ${sinRubrosExcluidos(p.rubrosExcluidos)}${andSinProductosExcluidos(p.excProdCsv, '        ')}
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
        AND ${sinRubrosExcluidos(p.rubrosExcluidos)}${andSinProductosExcluidos(p.excProdCsv, '        ')}
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

// La miel a granel en tambor ("Miel Granel En Tambor Acacia", "... Trebol", y una docena
// más) es la misma línea Apidelta: suelta arma una familia de una fila por variedad. Se
// exige que el nombre empiece con "miel" para no arrastrar los tambores vacíos de
// Apicultura ni el granel de aceite o vinagre, que también dicen "Tambor".
const MIEL_TAMBOR = /^miel\b.*\btambor(es)?\b/i;

// Pago De Los Arroyos es la otra línea de miel de la casa y se reporta junto con Apidelta:
// una sola familia de miel propia en todas las tablas. Antes vivían separadas y el tambor
// de Arroyo (9712) era la excepción de la regla del tambor; al unificarse dejó de serlo,
// así que la excepción por código desapareció.
const MIEL_PAGO_ARROYOS = /^miel\s+pago\s+de\s+los\s+arroyos\b/i;

// Línea Molens: toda la línea lleva la marca en el nombre, en cualquier posición
// ("Galletitas Molens Vainilla", "Budin Molens"), así que alcanza con buscar la palabra.
// Se acepta con y sin apóstrofo porque la base la escribe de las dos formas. Los límites
// de palabra evitan arrastrar "Molensina" o "Premolens", que no son de la línea.
const MOLENS = /\bmolen'?s\b/i;
const FAMILIA_MOLENS = 'MOLENS';

// Nombre de familia legible. Si al recortar no queda nada, se devuelve el nombre original
// (un producto llamado sólo "1KG" es un dato sucio, pero no puede desaparecer del reporte).
// idProd es opcional: sólo lo necesitan las excepciones por código.
function familiaNombre(nombre, idProd) {
  const original = String(nombre || '').trim();
  if (MIEL_TAMBOR.test(original)) return FAMILIA_MIEL_APIDELTA;
  if (MIEL_APIDELTA.test(original)) return FAMILIA_MIEL_APIDELTA;
  if (MIEL_PAGO_ARROYOS.test(original)) return FAMILIA_MIEL_APIDELTA;
  if (MOLENS.test(original)) return FAMILIA_MOLENS;
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

// ── Equivalente físico de la presentación ────────────────────────────────────
// Las unidades de una familia no son sumables: 2 tambores de 28Kg y 12 frascos de 1Kg
// dan "14" de nada. Con el peso de la presentación sí se llega a una magnitud real
// (2×28 + 12×1 = 68 kg). El peso sale del nombre, que es donde SIGA lo declara.
const FACTOR_MAGNITUD = {
  kg: { unidad: 'kg', factor: 1 },    kgs: { unidad: 'kg', factor: 1 },
  g:  { unidad: 'kg', factor: 0.001 }, gr: { unidad: 'kg', factor: 0.001 },
  grs: { unidad: 'kg', factor: 0.001 },
  l:  { unidad: 'l',  factor: 1 },    lt: { unidad: 'l',  factor: 1 },
  ml: { unidad: 'l',  factor: 0.001 }, cc: { unidad: 'l',  factor: 0.001 },
};
// Primera cifra con unidad de peso/volumen del nombre: en "250G Pack (x14u)" es el 250G
// y no el 14, que es cuántas unidades trae el pack (por decisión, el pack no multiplica).
// Las unidades de conteo (u, un) quedan afuera a propósito: no dan magnitud física.
const RE_PRESENTACION = /(\d+(?:[.,]\d+)?)\s*(kgs|kg|grs|gr|g|ml|cc|lt|l)\b/i;

// Los equivalentes se acumulan multiplicando decimales chicos (40G = 0,04): sin redondear
// en cada paso, la suma arrastra el error binario y termina en 12,000000000000002.
function redondearMagnitud(n) {
  return Math.round(n * 10000) / 10000;
}

// Devuelve { cantidad, unidad: 'kg'|'l' } o null si el nombre no declara presentación.
function pesoPresentacion(nombre) {
  const m = RE_PRESENTACION.exec(String(nombre || ''));
  if (!m) return null;
  const magnitud = FACTOR_MAGNITUD[m[2].toLowerCase()];
  if (!magnitud) return null;
  const valor = parseFloat(m[1].replace(',', '.'));
  if (!Number.isFinite(valor) || valor <= 0) return null;
  // Redondeo a 4 decimales: 40G × 0,001 arrastra basura binaria.
  return { cantidad: Math.round(valor * magnitud.factor * 10000) / 10000, unidad: magnitud.unidad };
}

// ── Qué rubros admiten equivalente ───────────────────────────────────────────
// El kilaje equivalente sólo significa algo donde el nombre declara el contenido real del
// envase. Son dos rubros: el fraccionado, que se vende por peso, y el bulto, que se vende
// por paquete cerrado. En el resto (almacén suelto, insumos, etc.) el peso del nombre no
// es una magnitud vendida y sumarlo daría un total inventado: ahí no se muestra nada.
const RUBRO_FRACCIONADO = 'Pesables Fraccionado';
const RUBRO_BULTOS = 'Almacen Bultos/Cajas';

// Comparación tolerante, igual que la de rubros excluidos: sin espacios, sin acentos y sin
// distinguir mayúsculas, porque la base escribe "Bultos / Cajas" y "Depósito" con tilde.
function claveRubro(rubro) {
  return String(rubro || '').replace(/\s/g, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
const CLAVE_FRACCIONADO = claveRubro(RUBRO_FRACCIONADO);
const CLAVE_BULTOS = claveRubro(RUBRO_BULTOS);

// La familia lleva equivalente si vende de alguna de las dos formas medibles. Si no tiene
// ni fraccionado ni bulto, la cantidad del renglón no es un peso y no hay qué mostrar.
function familiaSeMide(presentaciones) {
  return presentaciones.some(p => p.rubro === CLAVE_BULTOS || p.rubro === CLAVE_FRACCIONADO);
}

// El rubro es la señal principal de que algo se vende por paquete, pero no alcanza: hay
// pesables cuyas ventas son todas de bultos ("Mix Cerv.Prem") y productos con el rubro mal
// cargado ("Mix Tropic. 200G Unidad Bulto", 98 paquetes leídos como 98 kg en vez de 19,6).
// El nombre es la señal que sí acompaña: "Unidad" y "Bulto" marcan que el renglón cuenta
// paquetes; sin ninguna de esas palabras, la cantidad del renglón ya está en kilos.
const NOMBRE_POR_PAQUETE = /\b(BULTO|BULTOS|PACK|CAJA|CAJAS|UNIDAD|UNIDADES)\b/i;

function seVendePorPaquete(p) {
  return p.rubro === CLAVE_BULTOS || NOMBRE_POR_PAQUETE.test(String(p.nombre || ''));
}

// Kilos (o litros) que salieron por una presentación. Hay dos formas de vender lo mismo:
//  · Bulto: paquete cerrado. El renglón cuenta paquetes, así que el peso sale de
//    multiplicar el contenido declarado en el nombre por la cantidad vendida.
//    Un bulto que no declara contenido se deja como viene: estimarlo sería inventar.
//  · Todo lo demás: se vende por peso, o sea que la cantidad del renglón YA está en kilos.
//    Multiplicarla por el peso del nombre —el error de la primera versión— convertía
//    10 kg de MIX TROPIC 500G en 5, o 15 kg de 5KG en 75.
function medirPresentacion(p) {
  const porPaquete = seVendePorPaquete(p);
  const peso = porPaquete ? pesoPresentacion(p.nombre) : null;
  if (!peso) return { ...p, kilos: p.unidades, litros: 0, porPaquete };
  const equivalente = redondearMagnitud(peso.cantidad * p.unidades);
  return {
    ...p,
    kilos: peso.unidad === 'kg' ? equivalente : 0,
    litros: peso.unidad === 'l' ? equivalente : 0,
    porPaquete,
  };
}

// El equivalente de la familia son todos sus kilos sumados, midiendo cada presentación como
// corresponda. Los litros van aparte: un litro no es un kilo.
function equivalenteFamilia(presentaciones) {
  const seMide = familiaSeMide(presentaciones);
  const medidas = presentaciones.map(p => seMide
    ? medirPresentacion(p)
    : { ...p, kilos: 0, litros: 0, porPaquete: false });
  const acumulado = medidas.reduce((acc, p) => ({
    kilos: redondearMagnitud(acc.kilos + (p.kilos || 0)),
    litros: redondearMagnitud(acc.litros + (p.litros || 0)),
  }), { kilos: 0, litros: 0 });
  return { ...acumulado, equivalenteAplica: seMide, presentaciones: medidas };
}

// Colapsa filas {IdProducto, Nombre, Rubro, Unidades, Facturacion} en familias, sumando las
// presentaciones. Devuelve las topN familias por facturación, cada una con su detalle.
// La familia trae kilos/litros equivalentes (la magnitud real) y además las unidades
// crudas como dato secundario. El equivalente se calcula en una segunda pasada porque
// depende de qué rubros tenga la familia entera, no de cada renglón por separado.
function agruparFamilias(rows, topN) {
  const mapa = new Map();
  (rows || []).forEach(r => {
    const nombre = String(r.Nombre || '').trim();
    if (!nombre) return;
    const familia = familiaNombre(nombre, r.IdProducto);
    const clave = claveFamilia(familia);
    if (!mapa.has(clave)) mapa.set(clave, {
      familia, unidades: 0, facturacion: 0, presentaciones: [],
    });
    const g = mapa.get(clave);
    const unidades = Number(r.Unidades || 0);
    const facturacion = Number(r.Facturacion || 0);
    // Unidades y facturación suman siempre, sea cual sea el rubro: el recorte por rubro es
    // sólo del equivalente.
    g.unidades += unidades;
    g.facturacion += facturacion;
    g.presentaciones.push({
      idProd: r.IdProducto, nombre, unidades, facturacion, rubro: claveRubro(r.Rubro),
    });
  });
  return [...mapa.values()]
    .map(g => {
      const eq = equivalenteFamilia(g.presentaciones);
      return {
        ...g,
        kilos: eq.kilos, litros: eq.litros,
        equivalenteAplica: eq.equivalenteAplica,
        presentaciones: [...eq.presentaciones].sort((a, b) => b.facturacion - a.facturacion),
      };
    })
    .sort((a, b) => b.facturacion - a.facturacion)
    // Infinity deja pasar todas: la pestaña de familias consolidadas las lista completas y
    // pagina en el front, así que el tope de acá la dejaría corta.
    .slice(0, topN || TOP_N_DEFAULT);
}

// ── Familias consolidadas (casa central + sucursales) ────────────────────────
// Las sucursales que pide la pestaña de familias. A diferencia de sucIdsSeguras, distingue
// "no vino el parámetro" (todas, que es como abre la pestaña) de "vino vacío" (el usuario
// destildó todos los chips y quiere ver sólo la central).
function sucIdsFamilias(raw) {
  if (raw === undefined || raw === null) return [...SUCURSALES_ANALISIS];
  const pedidos = String(raw).split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => SUCURSALES_ANALISIS.includes(n));
  return [...new Set(pedidos)];
}

// Un mismo producto puede venderse en la central y en las sucursales, y cada alcance se
// consulta por separado (tienen filtros distintos). Sin fusionar, la familia lo listaría dos
// veces en el detalle y el equivalente en kilos se duplicaría. El id viene como string desde
// el driver en una consulta y puede venir numérico en otra: se compara siempre como texto.
function fusionarProductos(...listas) {
  const mapa = new Map();
  listas.forEach(lista => {
    (lista || []).forEach(r => {
      const clave = String(r.IdProducto);
      const previo = mapa.get(clave);
      if (!previo) {
        mapa.set(clave, { ...r, Unidades: Number(r.Unidades || 0), Facturacion: Number(r.Facturacion || 0) });
        return;
      }
      mapa.set(clave, {
        ...previo,
        Unidades: previo.Unidades + Number(r.Unidades || 0),
        Facturacion: previo.Facturacion + Number(r.Facturacion || 0),
      });
    });
  });
  return [...mapa.values()];
}

module.exports = {
  SUCURSALES_ANALISIS, SUCURSAL_CENTRAL, NOMBRE_DIA, TOP_N_DEFAULT, BUCKETS_ARTICULOS, LIMITE_FAMILIAS,
  PALABRA_INSUMO, CLASIFICACIONES, CATEGORIA_SUCURSAL_ID, RUBROS_EXCLUIDOS, SIN_RUBROS_EXCLUIDOS,
  RUBROS_EXCLUIDOS_CENTRAL, sinRubrosExcluidos,
  PRODUCTOS_EXCLUIDOS_CENTRAL, sinProductosExcluidos, joinImporteExcluido,
  exprFacturacion, exprTickets, exprImporteRenglon,
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
  familiaNombre, claveFamilia, agruparFamilias, pesoPresentacion,
  sucIdsFamilias, fusionarProductos,
  RUBRO_FRACCIONADO, RUBRO_BULTOS, claveRubro, familiaSeMide, medirPresentacion,
  sqlVentasPorClienteProducto, agruparClientes, CLIENTE_SIN_NOMBRE,
  MARCAS_PROPIAS, esProductoPropio,
};
