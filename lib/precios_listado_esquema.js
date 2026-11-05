'use strict';
// ── Precios · filas de los listados con el esquema por canal (spec 2026-10-07-precios-esquema-canales-design §3) ──
// Puro (sin SQL/fs): costo por fuente (sistema / última compra / manual, + costos extra) → precios de cada canal con
// lib/precios_esquema → filas de Reventa, Fraccionado (por granel) y Producción (por presentación); decisión y export.
// routes/rutas_precios_esquema.js trae SIGA y archivos y llama a esto: un solo cálculo para listado, modal y export.
const E = require('./precios_esquema');
const { aplicarCostosExtra, compararConVigente, redondear2 } = require('./precios_costeo');
const { granelDePresentacion, crearGranelPorNombre } = require('./precios_consultas');
const FC = require('./precios_fraccionado_costo');
const { esSucursalReal } = require('./sucursales_no_reales');

// Fuentes de COSTO: generan sugeridos, columnas del export y emparejado de la planilla. La decisión admite además 'precio' (FUENTES_DECISION).
const FUENTES = ['sistema', 'ultimaCompra', 'manual'];
// 'precio' = precio fijo de Reventa (costeo.precioFijo): no es un costo, no genera sugeridos por costo (lo arma sugeridoPrecioFijo).
const FUENTES_DECISION = [...FUENTES, 'precio'];
const RATIO_UNIDAD = [0.5, 1.2]; // mismo criterio "revisar unidad" que lib/precios_pack_bulto
const PLU_SIGA = /^\d{1,12}$/;
const SIN_GRANEL = 'Sin granel asignado';
const porNombre = (a, b) => String(a.nombre ?? '').localeCompare(String(b.nombre ?? ''), 'es');

const objeto = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const vigenteDe = (vigentes, plu) => (plu != null && vigentes.has(plu) ? vigentes.get(plu) : null);
const manualDe = (costeo, plu) => { const v = objeto(costeo.costoPorProducto)[plu]; return typeof v === 'number' && v > 0 ? v : null; };
const extrasDe = (costeo, plu) => { const v = objeto(costeo.costosExtraFraccionado)[plu]; return Array.isArray(v) ? v : []; };
const decisionDe = (costeo, plu) => objeto(costeo.decisiones)[plu] || null;
// Tipo de proveedor de un producto de Reventa (costeo.tipoProveedor[plu]): a quién se le compra. Sin dato o inválido → null
// ("sin clasificar": no aparece en el listado por defecto, ver public/js/precios_listados.js filtrarFilas).
const TIPOS_PROVEEDOR = ['directo', 'distribuidor'];
const tipoProveedorDe = (costeo, plu) => { const v = objeto(objeto(costeo).tipoProveedor)[plu]; return TIPOS_PROVEEDOR.includes(v) ? v : null; };
// Margen del producto ({ modo, minorista?, pack?, bulto? }, costeo.margenProducto; fijo | ajuste). Fraccionado: el del granel. Un modo
// 'precio' guardado por 1bdc433 (antes de costeo.precioFijo) se ignora: el precio fijo de Reventa ya no vive acá.
const margenProductoDe = (costeo, plu) => {
  const mp = plu == null ? null : objeto(objeto(costeo).margenProducto)[plu] || null;
  return mp && mp.modo === 'precio' ? null : mp;
};
// Precio fijo de un producto de Reventa ({ minorista?, pack?, bulto? }, costeo.precioFijo). Sin dato → null.
const precioFijoDe = (costeo, plu) => (plu == null ? null : objeto(objeto(costeo).precioFijo)[plu] || null);

// Costo de mercadería por fuente (sistema: PrecioCosto de SIGA tal cual; última compra: neto de factura) con
// los costos extra del producto/granel ($ o % del costo). Fuente sin costo
// (> 0) → null: no hay sugerido con ella.
function costosFuentes({ costoSistema = null, costoUltimaCompra = null, costoManual = null, extras = [] } = {}) {
  const con = c => (c > 0 ? aplicarCostosExtra(c, extras).costoTotal : null);
  return { sistema: con(costoSistema), ultimaCompra: con(costoUltimaCompra), manual: con(costoManual) };
}

// Costo de una materia prima de Producción = el que tiene en SU tab (Reventa o granel de Fraccionado), con sus costos
// extra (spec §2.1, fase 4): la fuente decidida si el PLU tiene decisión; si no, el costo manual si lo hay; si no,
// sistema. Fuente decidida sin dato → costo null (faltante: nunca se cae a otra fuente en silencio).
// fila = fila de costosPorPlu (filaCostos) o null.
function costoEnSuTab(fila, costeo, plu) {
  const c = objeto(costeo), f = objeto(fila);
  const costos = costosFuentes({ costoSistema: f.costoSistema, costoUltimaCompra: f.costoMercaderia, costoManual: manualDe(c, plu), extras: extrasDe(c, plu) });
  const decision = decisionDe(c, plu);
  // La decisión 'precio' (precio fijo de Reventa) no es un costo: la materia prima queda como sin decisión.
  const decidida = decision && decision.fuente !== 'precio' ? decision : null;
  const fuente = decidida ? decidida.fuente : costos.manual != null ? 'manual' : 'sistema';
  return { costo: costos[fuente] ?? null, fuente };
}

// costoDe(plu) → { costo, fuente, nombre } | null: costo de un insumo de Fraccionado en su tab (como las materias primas de
// Producción). costos = Map plu → fila de costosPorPlu; costeo = costeo.json. Sin fila en SIGA → null (faltante).
const crearCostoDe = (costos, costeo) => plu => { const row = costos.get(String(plu)); return row ? { ...costoEnSuTab(row, costeo, String(plu)), nombre: row.nombre } : null; };

// Columnas de costo de la fila (sin extras) desde una fila de productosConCostos (lib/precios_consultas filaCostos).
// ingresoHoy = hay un comprobante de compra del producto CARGADO hoy en SIGA (Compras.FechaActualizacion, no la fecha de la
// factura): filtro "Cargados hoy". No es costo: viaja a todos los usuarios (filaPublica no lo saca).
function infoCostos(fila, costoManual = null) {
  const f = objeto(fila);
  const sis = f.costoSistema ?? null, ult = f.costoMercaderia ?? null;
  return {
    costoSistema: sis, costoUltimaCompra: ult, fechaUltimaCompra: f.fechaUltimaCompra || null, proveedor: f.proveedor || null, costoManual,
    ingresoHoy: f.ingresoHoy === true,
    deltaUltimaPct: sis > 0 && ult > 0 ? +(((ult - sis) / sis) * 100).toFixed(1) : null,
  };
}

// Unidades del vínculo pack/bulto (multiplican al neto unitario del canal). SIGA guarda el precio del pack/bulto POR
// UNIDAD (respuesta del usuario 2026-10-07): base no pesable → siempre 1 (vínculos manuales incluidos). Base pesable
// ($/kg: presentación de Fraccionado o granel): 1 si se vende por kg, kg del paquete si se vende por paquete
// (ventaPesable o kg de la fórmula). Paquete sin kg → null: sin precio mayorista (faltante 'unidades').
function unidadesVinculo(v, ventaPesable = {}, pesable = false) {
  if (pesable || v.granel) {
    const venta = objeto(objeto(ventaPesable)[v.plu]);
    if (venta.modo !== 'paquete') return 1;
    const kg = venta.pesoKg > 0 ? venta.pesoKg : v.cantidad;
    return kg > 0 ? kg : null;
  }
  return 1;
}

// mayoristasDe(basePlu, pesable) → [{ plu, nombre, tipo, unidades, vigente, venta }] de los pack/bulto vinculados a ese PLU.
// venta = modo de venta del pesable ({ modo: 'kg'|'paquete', pesoKg }) para editarlo en el detalle; no pesable → null.
function crearMayoristasDe({ vinculos, vigentes, ventaPesable = {} }) {
  const porBase = new Map();
  for (const v of vinculos || []) porBase.set(String(v.basePlu), [...(porBase.get(String(v.basePlu)) || []), v]);
  const ventaDe = plu => { const x = objeto(objeto(ventaPesable)[plu]); return { modo: x.modo === 'paquete' ? 'paquete' : 'kg', pesoKg: x.pesoKg > 0 ? x.pesoKg : null }; };
  return (basePlu, pesable = false) => (porBase.get(String(basePlu)) || []).map(v => ({
    plu: v.plu, nombre: v.nombre, tipo: v.tipo, unidades: unidadesVinculo(v, ventaPesable, pesable), vigente: vigenteDe(vigentes, v.plu),
    venta: pesable || v.granel ? ventaDe(v.plu) : null,
  }));
}

// Margen total de un canal = precio final ÷ costo de mercadería (con sus extras) − 1, en %. Una sola cifra: viaja a todos
// los usuarios (el desglose no).
const margenTotalPct = (precio, costo) => (precio != null && costo > 0 ? E.r2((precio / costo - 1) * 100) : null);

// Precios de un costo: minorista (motor sin vínculos) y cada pack/bulto vinculado (motor con sus unidades y vigente).
// Semáforo contra el vigente (lista 0): en minorista contra el precio final; en pack/bulto contra el SIN IVA (así carga el
// usuario esas listas en SIGA); el con IVA de pack/bulto no se compara. desglose = salida cruda del motor (sólo
// viaja con el permiso de Configuración, ver filaPublica). error del motor: 'costo' | 'margen' | 'gastos'.
// margenExtra = margen especial del producto de Producción ({ minorista, pack, bulto }, puntos %), o null. margenProducto =
// margen del producto (costeo.margenProducto: fijo reemplaza el del canal, ajuste se suma encima), o null. distribuidor =
// Reventa con proveedor distribuidor (el motor le resta el descuento de Configuración › Márgenes).
// Minorista de la fila. Presentación mayorista de Fraccionado (m.sinIva): el precio es el pack o bulto $/kg SIN IVA (tipoMayorista), así que el
// Δ%/estado se compara contra vigenteNeto (= vigente de SIGA tal cual: el de una mayorista ya está sin IVA); viajan pack/bulto informativos y el minorista de antes.
function minoristaDe(m, costo, vigente, tol) {
  const base = { precio: m.precio, margenTotalPct: margenTotalPct(m.precio, costo) };
  if (!m.sinIva) return { ...base, ...compararConVigente(m.precio, vigente, tol) };
  const canal = c => ({ neto: m.mayorista[c].precio, conIva: m.mayorista[c].conIva, margenPct: m.mayorista[c].margenPct });
  return { ...base, ...compararConVigente(m.precio, m.vigenteNeto, tol), sinIva: true, tipoMayorista: m.tipoMayorista, vigenteNeto: m.vigenteNeto,
    minoristaOriginal: m.minoristaOriginal.precio, minoristaOriginalNeto: m.minoristaOriginal.neto, bulto: canal('bulto'), pack: canal('pack') };
}

function preciosDeCosto({ cfg, tipo, costo, pesoG = null, vigente = null, mayoristas = [], margenExtra = null, margenProducto = null, distribuidor = false, variante = 'minorista' }) {
  const tol = cfg.toleranciaPct;
  const base = E.preciosCanales({ tipo, costo, pesoG, vigentes: { minorista: vigente }, cfg, margenExtra, margenProducto, distribuidor, variante });
  if (base.error) return { error: base.error, minorista: null, mayoristas: [], desglose: null };
  const porVinculo = {};
  const mayor = mayoristas.map(m => {
    if (!(m.unidades > 0)) {
      return { plu: m.plu, faltante: 'unidades', neto: null, conIva: null, margenTotalNetoPct: null, margenTotalIvaPct: null,
        deltaPct: null, estado: null, revisarUnidad: false };
    }
    const canal = E.preciosCanales({ tipo, costo, pesoG, unidades: { [m.tipo]: m.unidades }, vigentes: { [m.tipo]: m.vigente }, cfg, margenExtra, margenProducto, distribuidor, variante })[m.tipo];
    porVinculo[m.plu] = canal;
    const ratio = m.vigente > 0 ? m.vigente / canal.neto : null;
    const costoCaja = costo * m.unidades;
    return { plu: m.plu, faltante: null, neto: canal.neto, conIva: canal.conIva,
      margenTotalNetoPct: margenTotalPct(canal.neto, costoCaja), margenTotalIvaPct: margenTotalPct(canal.conIva, costoCaja),
      ...compararConVigente(canal.neto, m.vigente, tol),
      revisarUnidad: ratio != null && (ratio < RATIO_UNIDAD[0] || ratio > RATIO_UNIDAD[1]) };
  });
  return {
    error: null,
    minorista: minoristaDe(base.minorista, costo, vigente, tol),
    mayoristas: mayor, desglose: { ...base, porVinculo },
  };
}

// Fila de un producto (Reventa, presentación de Fraccionado o de Producción): un sugerido por fuente con costo.
// margenProducto viaja en la fila (si hay) para el modal y el badge; es configuración: CLAVES_OCULTAS lo saca sin el permiso.
// variante = la de la presentación de Fraccionado (lib/precios_esquema preciosCanales), se reenvía al motor.
function filaProducto({ plu, nombre, tipo, costos, pesoG = null, vigente = null, mayoristas = [], cfg, margenExtra = null, margenProducto = null, distribuidor = false, variante = 'minorista' }) {
  const sugeridos = Object.fromEntries(FUENTES.filter(f => costos[f] != null)
    .map(f => [f, preciosDeCosto({ cfg, tipo, costo: costos[f], pesoG, vigente, mayoristas, margenExtra, margenProducto, distribuidor, variante })]));
  return { plu, nombre, tipo, pesoG, vigente, costos, mayoristas, sugeridos, ...(margenProducto ? { margenProducto } : {}) };
}

// Costo de referencia del precio fijo (sólo Reventa): el de la primera fuente con costo (sistema › última compra › manual, con extras).
// El precio fijo no depende de la fuente elegida: la fuente sólo pone el costo contra el que se calcula el margen (y el Costo del export).
const costoReferencia = costos => { const fuente = FUENTES.find(f => costos[f] != null); return fuente ? { fuente, costo: costos[fuente] } : null; };

// sugeridos.precio de una fila de Reventa con precio fijo guardado: preciosDeCosto con el modo 'precio' del motor (el valor ES el precio del
// canal, sin alinear; canal vacío → margen general) y el costo de referencia. Sin precio fijo o sin costo → {} (no hay sugerido 'precio').
// fuenteRef (pública) = de dónde salió el costo; el costo con extras no viaja (filaPublica saca `costos`): la card y el export usan el costo
// en pantalla de esa fuente. El margenProducto real (fijo/ajuste) no se usa acá ni este modo toca a las otras fuentes.
// Fraccionado: tipo/pesoG/variante de la presentación, precioFijo ya en $/kg ({} = margen general: presentación sin precio fijo de un
// granel que tiene alguna, o el granel mismo) y extra = { precioPresentacion, precioKg } que viaja tal cual en sugeridos.precio.
function sugeridoPrecioFijo({ cfg, costos, precioFijo, vigente = null, mayoristas = [], distribuidor = false, tipo = 'almacen', pesoG = null, variante = 'minorista', extra = {} }) {
  const ref = precioFijo ? costoReferencia(costos) : null;
  if (!ref) return {};
  const calculo = preciosDeCosto({ cfg, tipo, costo: ref.costo, pesoG, vigente, mayoristas, margenProducto: { modo: 'precio', ...precioFijo }, distribuidor, variante });
  return { precio: { ...calculo, fuenteRef: ref.fuente, ...extra } };
}

// Precio fijo de una presentación de Fraccionado: costeo.precioFijo[plu].minorista = precio de la BOLSA final con IVA (como lo tipea el
// usuario). Sólo presentaciones no mayoristas con peso (se pasa a $/kg con pesoG); si no -> null (un dato viejo se ignora).
function precioBolsaDe(costeo, p, costeoF) {
  const pf = precioFijoDe(costeo, p.plu), pesoG = FC.pesoGDe(p.nombre);
  if (!pf || !(pf.minorista > 0) || !(pesoG > 0) || FC.esMayoristaPresentacion(pesoG, p.plu, costeoF && costeoF.mayorista).mayorista) return null;
  return { precioPresentacion: pf.minorista, precioKg: E.r2(pf.minorista * 1000 / pesoG) };
}

// Reventa: una fila por producto del universo (filas de productosConCostos). excluir = PLUs de venta de Producción
// (lib/precios_produccion plusVentaProduccion): se deciden y exportan en Producción, no dos veces.
function listadoReventa({ universo, vigentes, mayoristasDe, costeo, cfg, excluir = new Set() }) {
  return (universo || []).filter(p => !excluir.has(String(p.plu))).map(p => {
    const manual = manualDe(costeo, p.plu);
    const extras = extrasDe(costeo, p.plu);
    const tipoProveedor = tipoProveedorDe(costeo, p.plu);
    const precioFijo = precioFijoDe(costeo, p.plu);
    const distribuidor = tipoProveedor === 'distribuidor';
    const vigente = vigenteDe(vigentes, p.plu), mayoristas = mayoristasDe(p.plu);
    const costos = costosFuentes({ costoSistema: p.costoSistema, costoUltimaCompra: p.costoMercaderia, costoManual: manual, extras });
    const fila = filaProducto({ plu: p.plu, nombre: p.nombre, tipo: 'almacen', vigente, mayoristas, cfg, margenProducto: margenProductoDe(costeo, p.plu), distribuidor, costos });
    return {
      ...fila, sugeridos: { ...fila.sugeridos, ...sugeridoPrecioFijo({ cfg, costos, precioFijo, vigente, mayoristas, distribuidor }) },
      ...(precioFijo ? { precioFijo } : {}),
      ...infoCostos(p, manual), costosExtra: extras, decision: decisionDe(costeo, p.plu), tipoProveedor,
    };
  });
}

// PUT /api/precios/tipo-proveedor/:plu: tipo 'directo' | 'distribuidor' | null (null quita). Error o null.
function validarTipoProveedor(plu, tipo) {
  if (!PLU_SIGA.test(String(plu))) return 'PLU inválido';
  if (tipo !== null && !TIPOS_PROVEEDOR.includes(tipo)) return `tipo inválido: ${TIPOS_PROVEEDOR.join(', ')} o null`;
  return null;
}
// Mapa nuevo { [plu]: valor } con el valor del PLU puesto (null lo saca): tipoProveedor y activoGranel.
function aplicarPorPlu(mapa, plu, valor) {
  const { [plu]: _fuera, ...resto } = objeto(mapa);
  return valor == null ? resto : { ...resto, [plu]: valor };
}
// PUT /api/precios/precio-fijo/:plu: PLU de SIGA o 'PLU inválido' (los precios los valida lib/precios_produccion validarPrecioFijo).
const validarPluSiga = plu => (PLU_SIGA.test(String(plu)) ? null : 'PLU inválido');
// Campos de costeo que cambian al poner (precios = { minorista?, pack?, bulto? }) o quitar (null) el precio fijo de un PLU. Al quitar también
// se va la decisión 'precio' de ese PLU (sin precio fijo nunca exportaría); la de otra fuente y las demás decisiones no se tocan.
// grupo = { granel, presentaciones: [plu] } si plu es una presentación de Fraccionado: la decisión es la del granel y se va sólo si
// ninguna otra presentación queda con precio fijo.
function aplicarPrecioFijo(costeo, plu, precios, grupo = null) {
  const c = objeto(costeo);
  const precioFijo = aplicarPorPlu(c.precioFijo, plu, precios);
  const clave = grupo ? grupo.granel : plu;
  const decision = objeto(c.decisiones)[clave];
  const quedan = grupo ? grupo.presentaciones.some(x => x in precioFijo) : false;
  return precios == null && !quedan && decision && decision.fuente === 'precio'
    ? { precioFijo, decisiones: aplicarDecision(c.decisiones, clave, null) } : { precioFijo };
}

// ── Actividad de Fraccionado (spec 2026-10-26-precios-fraccionado-activos-reefer) ─────────────────────────────
// activos del PUT …/fraccionado/subrubros (lib/precios_config_fraccionado aplicarActivos): activo true | false | null (null = automático). Error o null.
function validarActivoGranel(plu, activo) {
  if (!PLU_SIGA.test(String(plu))) return 'PLU inválido';
  if (activo !== null && typeof activo !== 'boolean') return 'activo inválido: true, false o null (automático)';
  return null;
}
const REEFER = /\breefer\b/i;
// reefer (por nombre), actividad automática (null sin movimientos o sin granel), activoManual (costeo.activoGranel) y activo
// final = manual ?? automático; sin movimientos (consulta caída) el automático cuenta como activo. presentaciones ya con
// movReciente.
// stock: Map plu → [{ sucursal, stock }] (precios_consultas.stockPresentaciones) o undefined (sin pedir → sin criterio de stock).
// Alguna presentación con stock > 0 en una sucursal real mantiene activo el automático (activoPorStock). stock null = consulta
// caída → actividad null (activo salvo a mano), igual que sin movimientos: nunca apaga en silencio.
function stockDePresentaciones(presentaciones, stock) {
  const filas = presentaciones.flatMap(p => stock.get(p.plu) || []).filter(r => r.stock > 0 && esSucursalReal(r.sucursal));
  return { stockPresentaciones: redondear2(filas.reduce((s, r) => s + r.stock, 0)),
    sucursalesConStock: [...new Set(filas.map(r => Number(r.sucursal)))].sort((a, b) => a - b) };
}
function actividadGranel(g, presentaciones, movimientos, costeo, stock) {
  if (g.plu == null) return { reefer: false, actividad: null, activoManual: null, activo: true };
  const v = objeto(costeo.activoGranel)[g.plu];
  const activoManual = typeof v === 'boolean' ? v : null;
  let actividad = null;
  if (movimientos && stock !== null) {
    const movGranel = movimientos.get(g.plu) || null;
    const presentacionesActivas = presentaciones.filter(p => p.movReciente).length;
    const motivos = [...(movGranel ? [] : ['sinMovGranel']),
      ...(!presentaciones.length ? ['sinPresentaciones'] : !presentacionesActivas ? ['sinMovPresentaciones'] : [])];
    const st = stock ? stockDePresentaciones(presentaciones, stock) : null;
    const activoPorStock = !!st && motivos.length > 0 && st.sucursalesConStock.length > 0;
    actividad = { auto: !motivos.length || activoPorStock ? 'activo' : 'inactivo', motivos, ultimoMovGranel: movGranel ? movGranel.ultimo : null,
      presentacionesActivas, ...(st ? { activoPorStock, ...st } : {}) };
  }
  return { reefer: REEFER.test(g.nombre || ''), actividad, activoManual, activo: activoManual ?? (actividad ? actividad.auto === 'activo' : true) };
}

// Fraccionado: un grupo por granel con sus presentaciones (granelDePresentacion: fórmula › fórmula SIGA › nombre ›
// propio PLU). Granel referenciado fuera del rubro pero con fila en SIGA → grupo propio. Sin granel → grupo
// { plu: null } al final (no se puede decidir).
function agruparPorGranel({ graneles, presentaciones, formulas, costos }) {
  const granelPorNombre = crearGranelPorNombre(graneles);
  const grupos = new Map((graneles || []).map(g => [g.plu, { plu: g.plu, nombre: g.nombre, subrubroId: g.subrubroId ?? null, subrubro: g.subrubro ?? null, presentaciones: [] }]));
  const sinGranel = { plu: null, nombre: SIN_GRANEL, presentaciones: [] };
  for (const p of presentaciones || []) {
    const g = granelDePresentacion(formulas, p, granelPorNombre);
    if (g && !grupos.has(g) && costos.has(g)) grupos.set(g, { plu: g, nombre: costos.get(g).nombre, subrubroId: null, subrubro: null, presentaciones: [] });
    const destino = g && grupos.has(g) ? grupos.get(g) : sinGranel;
    destino.presentaciones = [...destino.presentaciones, p];
  }
  const lista = [...grupos.values()].sort(porNombre);
  return sinGranel.presentaciones.length ? [...lista, sinGranel] : lista;
}

// Línea 'granel' (mercadería) del desglose de una presentación: $/kg del granel × kg de la presentación. enTab = costoEnSuTab
// del granel (fuente decidida › manual › sistema, con sus extras; se calcula una vez por granel), igual que el granel de un
// envasado de Producción.
function lineaGranel({ g, enTab: { costo, fuente }, pesoG }) {
  const kg = pesoG / 1000;
  return { plu: g.plu, nombre: g.nombre, rol: 'granel', cantidad: kg, costoUnit: costo, importe: costo == null ? null : redondear2(costo * kg), fuente };
}

// Fila por granel con sus presentaciones. Precio por kg (como SIGA): costo $/kg del granel + costos extra y, con costeoF
// (costeo.fraccionado normalizado; null = sin migrar → como antes), + insumos de su peso + MO + máquina de CADA presentación pasados a
// $/kg (lib/precios_fraccionado_costo, spec 2026-10-21 §9). Escalón por ese costo y ajuste por el peso de cada presentación.
// Los pack/bulto de una presentación o del granel son pesables (unidades = 1 kg o kg del paquete). La fila del granel no tiene
// vigente (no se vende suelto) y conserva el costo de mercadería: aporta sus pack/bulto, la decisión (alcanza a todas sus
// presentaciones) y el rango. avisosCosto (público) = unión de los avisos de sus presentaciones; costeoGranel (CLAVES_OCULTAS)
// = subrubro, min/kg y máquina; costeoPresentacion (lo saca filaPublica) = minutos, min/kg y ajuste del tramo.
// costeoGranel: máquina del granel (sin máquina → null), envase ('bolsa' | 'bobina'), min/kg propio y el del subrubro (null sin cargar) y cuál manda.
function costeoGranelDe(cf, granelRef, g) {
  const propio = cf.porGranel[g.plu] || {};
  const maquina = FC.maquinaDe(cf, granelRef);
  const sub = g.subrubroId != null ? (cf.subrubros[g.subrubroId] || {}).minKg : null;
  return { maquinaId: propio.maquinaId ?? null, maquina: maquina ? maquina.nombre : null, minKgPropio: propio.minKg ?? null,
    minKgSubrubro: sub ?? null, minKgOrigen: FC.minKgDe(cf, granelRef).origen,
    envase: FC.envaseDe(cf, granelRef), subrubroId: g.subrubroId ?? null, subrubro: g.subrubro ?? null };
}

function listadoFraccionado({ grupos, costos, vigentes, mayoristasDe, costeo, cfg, costeoF = null, movimientos = null, stock }) {
  const costoDe = crearCostoDe(costos, costeo);
  return (grupos || []).map(g => {
    const fila = g.plu != null ? costos.get(g.plu) || {} : {};
    const manual = g.plu != null ? manualDe(costeo, g.plu) : null;
    const extras = g.plu != null ? extrasDe(costeo, g.plu) : [];
    const costosG = g.plu == null ? { sistema: null, ultimaCompra: null, manual: null }
      : costosFuentes({ costoSistema: fila.costoSistema, costoUltimaCompra: fila.costoMercaderia, costoManual: manual, extras });
    const margenProducto = margenProductoDe(costeo, g.plu); // el del granel alcanza a todas sus presentaciones
    const conCosteo = costeoF != null && g.plu != null;
    const granelRef = { plu: g.plu, subrubroId: g.subrubroId ?? null };
    const enTab = conCosteo ? costoEnSuTab(fila, costeo, g.plu) : null;
    const hayPrecioFijo = g.plu != null && g.presentaciones.some(p => precioBolsaDe(costeo, p, costeoF));
    const presentaciones = g.presentaciones.map(p => {
      const pesoG = FC.pesoGDe(p.nombre);
      const extra = conCosteo ? FC.costearPresentacion({ pesoG, granel: granelRef, cf: costeoF, costoDe }) : null;
      // Mayorista (público): marca manual o peso ≥ umbral de costeo.fraccionado.mayorista; sin migrar → nunca.
      const may = FC.esMayoristaPresentacion(pesoG, p.plu, costeoF && costeoF.mayorista);
      const costosP = extra ? FC.sumarExtraKg(costosG, extra.extraKg) : costosG;
      const vigente = vigenteDe(vigentes, p.plu), mayoristas = mayoristasDe(p.plu, true), variante = may.mayorista ? may.tipo : 'minorista';
      const fp = filaProducto({ plu: p.plu, nombre: p.nombre, tipo: 'fraccionado', costos: costosP, pesoG, vigente, mayoristas, cfg, margenProducto, variante });
      const bolsa = precioBolsaDe(costeo, p, costeoF);
      const precio = hayPrecioFijo ? sugeridoPrecioFijo({ cfg, costos: costosP, precioFijo: bolsa ? { minorista: bolsa.precioKg } : {}, vigente, mayoristas,
        tipo: 'fraccionado', pesoG, variante, extra: bolsa || {} }) : {};
      const filaP = { ...fp, sugeridos: { ...fp.sugeridos, ...precio }, ...(bolsa ? { precioFijo: { minorista: bolsa.precioPresentacion } } : {}),
        mayorista: may.mayorista, mayoristaOrigen: may.origen, mayoristaTipo: may.tipo };
      // Granel sin costo en la fuente decidida (importe null): la línea queda sin importe, nunca un 0 en silencio. No es un
      // faltante de la presentación: sin costo en una fuente, esa fuente no tiene sugerido (filaProducto) y las otras siguen.
      const granel = extra && pesoG ? lineaGranel({ g, enTab, pesoG }) : null;
      const movReciente = movimientos ? movimientos.has(p.plu) : null;
      return extra ? { ...filaP, movReciente, componentesCosto: granel ? [granel, ...extra.lineas] : extra.lineas,
        avisosCosto: extra.avisos, faltantesCosto: extra.faltantes,
        costeoPresentacion: { minutos: extra.minutos, minKg: extra.minKg, minKgOrigen: extra.minKgOrigen,
          ajusteMinKg: extra.ajusteMinKg, porUnidad: extra.porUnidad, extraKg: extra.extraKg } } : { ...filaP, movReciente };
    }).sort((a, b) => (a.pesoG ?? Infinity) - (b.pesoG ?? Infinity));
    const mayoristasG = g.plu == null ? [] : mayoristasDe(g.plu, true);
    const fg = filaProducto({ plu: g.plu, nombre: g.nombre, tipo: 'fraccionado', costos: costosG, mayoristas: mayoristasG, cfg, margenProducto });
    // Granel con alguna presentación fija: sugeridos.precio con el margen general (valida la decisión 'precio' y exporta sus pack/bulto).
    const precioG = hayPrecioFijo ? sugeridoPrecioFijo({ cfg, costos: costosG, precioFijo: {}, mayoristas: mayoristasG, tipo: 'fraccionado' }) : {};
    // ponytail: decisión 'precio' sin presentación fija vigente (quedó mayorista por porPlu o pesoMinG) = sin decisión; no se borra del
    // JSON (vuelve sola si la presentación deja de ser mayorista). decisionPrecioSinVigente avisa al front para no exportar en silencio.
    const guardada = g.plu == null ? null : decisionDe(costeo, g.plu);
    const precioHuerfano = !!guardada && guardada.fuente === 'precio' && !hayPrecioFijo;
    return {
      ...fg, sugeridos: { ...fg.sugeridos, ...precioG },
      ...infoCostos(fila, manual), costosExtra: extras, decision: precioHuerfano ? null : guardada, presentaciones,
      ...(precioHuerfano ? { decisionPrecioSinVigente: true } : {}),
      ...actividadGranel(g, presentaciones, movimientos, costeo, stock),
      ...(conCosteo ? {
        avisosCosto: [...new Set(presentaciones.flatMap(p => p.avisosCosto || []))],
        costeoGranel: costeoGranelDe(costeoF, granelRef, g),
      } : {}),
    };
  });
}

// Producción: una fila por presentación con PLU de SIGA. Costo = costo por unidad de la receta (sólo materias primas,
// fase 4); es su única fuente ('sistema'), sin última compra ni manual. aRevisar = materias primas movidas desde la última
// validación (lib/precios_produccion revisionDe). margenExtra = margen especial de su producto (se suma al de cada canal).
// tipoProduccion = 'receta' | 'envasado' (sub-tab de la UI); componentesCosto = granel + insumos de un envasado o materias
// primas por unidad de una receta ("Ver detalle"); familia y variedad = grupo del envasado en su listado.
function listadoProduccion({ presentaciones, vigentes, mayoristasDe, costeo, cfg }) {
  return (presentaciones || []).filter(p => PLU_SIGA.test(String(p.plu))).map(p => {
    const costo = p.costoUnidad > 0 ? p.costoUnidad : null;
    return {
      ...filaProducto({ plu: p.plu, nombre: p.nombre || p.plu, tipo: 'produccion', costos: { sistema: costo, ultimaCompra: null, manual: null },
        vigente: vigenteDe(vigentes, p.plu), mayoristas: mayoristasDe(p.plu), cfg, margenExtra: p.margenExtra || null,
        margenProducto: margenProductoDe(costeo, p.plu) }),
      productoId: p.productoId, costoSistema: costo, costoManual: null, decision: decisionDe(costeo, p.plu), aRevisar: p.aRevisar || null,
      tipoProduccion: p.tipoProduccion || 'receta', ...(p.componentesCosto ? { componentesCosto: p.componentesCosto } : {}),
      ...(p.tipoProduccion === 'envasado' ? { familia: p.familia || '', variedad: p.variedad } : {}),
    };
  }).sort(porNombre);
}

// ── Decisión (reemplaza marcadosExportar + fuenteCosto, spec §3.1) ──────────────────────────────────────────
// decisiones { [plu]: { fuente, fecha } }. Producción guarda 'sistema' (= "Aumentar"). 'manual' exige costo manual; 'precio' (precio fijo de
// Reventa o de alguna presentación del granel de Fraccionado) lo mira validarDecisionContraFilas: sólo con precio fijo y costo hay sugeridos.precio.
function validarDecision(plu, fuente, costeo) {
  if (!PLU_SIGA.test(String(plu))) return 'PLU inválido';
  if (fuente !== null && !FUENTES_DECISION.includes(fuente)) return `fuente inválida: ${FUENTES_DECISION.join(', ')} o null`;
  if (fuente === 'manual' && manualDe(costeo || {}, plu) == null) return 'Este producto no tiene costo manual cargado';
  return null;
}
// Fila decidible de un PLU: una fila de Reventa, un granel de Fraccionado o una presentación de Producción → { fila } o
// { error }. Mismo criterio para la decisión y para el ajuste de margen del producto.
function filaDecidible({ almacen = [], fraccionado = [], produccion = [] }, plu) {
  const fila = [...almacen, ...produccion, ...fraccionado.filter(g => g.plu != null)].find(f => f.plu === plu);
  if (fila) return { fila, error: null };
  const grupo = fraccionado.find(g => (g.presentaciones || []).some(p => p.plu === plu));
  if (!grupo) return { fila: null, error: `El PLU ${plu} no está en ningún listado de precios` };
  return { fila: null, error: `El PLU ${plu} es una presentación de Fraccionado: se decide en su granel${grupo.plu != null ? ` (PLU ${grupo.plu})` : ''}` };
}
// Contra los listados: sólo se decide una fila decidible (filaDecidible), y con una fuente que tenga sugerido en esa fila
// (Producción sólo 'sistema'; 'manual' exige costo manual); si no, nunca exportaría.
// fuente null (quitar) pasa siempre: así se limpian decisiones viejas de PLUs que ya no están.
function validarDecisionContraFilas(listados, plu, fuente) {
  if (fuente == null) return null;
  const { fila, error } = filaDecidible(listados, plu);
  if (error) return error;
  const disponibles = Object.keys(objeto(fila.sugeridos));
  if (disponibles.includes(fuente)) return null;
  return fuente === 'precio' ? 'Este producto no tiene precio fijo cargado'
    : `El PLU ${plu} no tiene precio sugerido con la fuente ${fuente} (disponibles: ${disponibles.join(', ') || 'ninguna'})`;
}
// fuente null quita la decisión. extra = { usuario, vigente } (ver vigentesDeFila). Devuelve un mapa nuevo.
function aplicarDecision(decisiones, plu, fuente, fecha, extra = {}) {
  const { [plu]: _fuera, ...resto } = objeto(decisiones);
  return fuente == null ? resto : { ...resto, [plu]: { fuente, fecha, ...extra } };
}

// ── Decisión temporal (spec §3): vence cuando SIGA cambia el precio de lo decidido (ya se importó) ──────────────
// Foto de los vigentes de una fila al decidir: { [plu]: vigente } de la fila (Reventa/Producción) o de cada presentación
// (granel de Fraccionado, que no se vende suelto), más los pack/bulto vinculados de todos ellos.
function vigentesDeFila(fila) {
  const f = objeto(fila);
  const vendidas = f.presentaciones || [f]; // el granel no tiene minorista propio: valen sus presentaciones
  const conVinculos = f.presentaciones ? [...vendidas, f] : vendidas;
  return Object.fromEntries([
    ...vendidas.map(x => [x.plu, x.vigente ?? null]),
    ...conVinculos.flatMap(x => (x.mayoristas || []).map(m => [m.plu, m.vigente ?? null])),
  ]);
}
// Vigente = la foto coincide con los precios de SIGA de hoy (vigentes: Map plu → precio). Sin foto (decisión vieja) → vencida.
function decisionVigente(decision, vigentes) {
  const foto = decision && decision.vigente;
  if (!foto || typeof foto !== 'object' || Array.isArray(foto)) return false;
  return Object.entries(foto).every(([plu, v]) => vigenteDe(vigentes, plu) === v);
}
// costeo sin las decisiones vencidas (nuevo objeto) y cuántas se sacaron.
function podarDecisiones(costeo, vigentes) {
  const decisiones = objeto(objeto(costeo).decisiones);
  const vivas = Object.fromEntries(Object.entries(decisiones).filter(([, d]) => decisionVigente(d, vigentes)));
  const podadas = Object.keys(decisiones).length - Object.keys(vivas).length;
  return { costeo: podadas ? { ...costeo, decisiones: vivas } : costeo, podadas };
}
// Lee el costeo con las decisiones vencidas ya sacadas y, si hubo, lo guarda (una vez por carga, no por fila). Releer
// después del await de SIGA: entre leer y escribir no hay await.
async function leerCosteoVigente({ leerCosteo, guardarCosteo, preciosVigentes }) {
  const vigentes = await preciosVigentes();
  const { costeo, podadas } = podarDecisiones(leerCosteo(), vigentes);
  if (podadas) guardarCosteo(costeo);
  return costeo;
}

// ── Export (spec §6; formato SIGA, ver preguntas del plan) ──────────────────────────────────────────────────
// Costo de cada fuente tal cual se ve en pantalla (columnas del listado y tarjetas del modal): el de la fila, SIN costos extra.
const COSTO_PANTALLA = { sistema: 'costoSistema', ultimaCompra: 'costoUltimaCompra', manual: 'costoManual' };
// Lo que exporta una fila con la fuente decidida: su costo y sus precios. Sin sugerido con esa fuente → null (omitido).
// filaCostos = la fila que muestra el costo (por defecto la misma; la presentación de Fraccionado usa el granel).
function resolverDecision(fila, fuente, filaCostos = fila) {
  const s = objeto(fila.sugeridos)[fuente];
  if (!s || s.error) return null;
  // 'precio' (precio fijo de Reventa): el Costo del export es el de la fuente del costo de referencia (la que dio el margen).
  const fuenteCosto = fuente === 'precio' ? s.fuenteRef : fuente;
  return {
    costo: filaCostos[COSTO_PANTALLA[fuenteCosto]],
    minorista: { plu: fila.plu, nombre: fila.nombre, precio: s.minorista.precio, ...(s.minorista.sinIva ? { sinIva: true } : {}) },
    mayoristas: s.mayoristas.filter(m => m.conIva != null).map(m => {
      const v = fila.mayoristas.find(x => x.plu === m.plu);
      return { plu: m.plu, nombre: v.nombre, tipo: v.tipo, unidades: v.unidades, neto: m.neto, conIva: m.conIva };
    }),
  };
}

// 2026-11-04: una presentación mayorista de Fraccionado CON descuento (minorista.sinIva) lleva el bulto $/kg SIN IVA y la
// lista minorista de SIGA va con IVA: importarla bajaría el precio ~21 %. Hasta que el usuario defina a qué lista de SIGA
// va, NO se exporta (se informa en omitidosMayorista/omitidosDetalle). Poner en true para volver a exportarla.
const EXPORTAR_MAYORISTA_SIN_IVA = false;
// Filas decididas de los tres listados → items de export. La decisión alcanza a los pack/bulto vinculados; en
// Fraccionado la del granel alcanza a todas sus presentaciones (y a los pack/bulto del granel, que no tiene minorista).
function itemsDecididos({ almacen = [], fraccionado = [], produccion = [] }, { exportarMayoristaSinIva = EXPORTAR_MAYORISTA_SIN_IVA } = {}) {
  const items = [];
  let omitidos = 0;
  const omitidosDetalle = []; // mayoristas con descuento no exportadas (ver EXPORTAR_MAYORISTA_SIN_IVA)
  const sumar = (fila, fuente, conMinorista = true, filaCostos = fila) => {
    const r = resolverDecision(fila, fuente, filaCostos);
    if (!r) { omitidos++; return; }
    if (conMinorista && r.minorista.sinIva && !exportarMayoristaSinIva) {
      omitidosDetalle.push({ plu: r.minorista.plu, nombre: r.minorista.nombre, motivo: 'mayoristaSinIva' });
      items.push({ ...r, minorista: null }); // sus pack/bulto vinculados siguen saliendo
      return;
    }
    items.push(conMinorista ? r : { ...r, minorista: null });
  };
  for (const f of [...almacen, ...produccion]) if (f.decision) sumar(f, f.decision.fuente);
  const graneles = []; // fila minorista propia del granel ($/kg), 2026-11-04: SIGA también actualiza costo y precio del base
  for (const g of fraccionado) {
    if (!g.decision) continue;
    const r = resolverDecision(g, g.decision.fuente);
    if (!r) omitidos++;
    else {
      items.push({ ...r, minorista: null });
      if (g.plu == null) omitidos++;
      else graneles.push({ costo: r.costo, minorista: r.minorista, mayoristas: [] });
    }
    for (const p of g.presentaciones || []) sumar(p, g.decision.fuente, true, g);
  }
  // Un PLU de granel que ya sale como minorista (o repetido) no se duplica.
  const vistos = new Set(items.filter(it => it.minorista).map(it => String(it.minorista.plu)));
  for (const it of graneles) {
    const plu = String(it.minorista.plu);
    if (!vistos.has(plu)) { vistos.add(plu); items.push(it); }
  }
  return { items, omitidos, omitidosMayorista: omitidosDetalle.length, omitidosDetalle };
}

const ENCABEZADO_EXPORT = Object.freeze(['Codigo', 'Nombre', 'Costo', 'Venta']);
const LISTAS_EXPORT = ['minorista', 'packNeto', 'packIva', 'bultoNeto', 'bultoIva'];
// Codigo del .xls = número (SIGA lo importa como número, no como texto). PLU no numérico queda como texto, nunca NaN
// (igual que lib/precios_historico pluNumerico).
const codigoNumerico = plu => (/^\d+$/.test(String(plu)) ? Number(plu) : plu);
// Una lista por canal: [Codigo, Nombre, Costo, Venta]. Costo = el costo de la fuente decidida tal cual se ve en pantalla
// (it.costo), SIN multiplicar por IVA en ninguna lista (el de sistema ya es el PrecioCosto de SIGA, con IVA); en pack/bulto
// × unidades (1 salvo pesable por paquete, que va × kg), porque su precio es por esa unidad. Venta = precio del canal.
function listasExport(items) {
  const listas = Object.fromEntries(LISTAS_EXPORT.map(l => [l, [[...ENCABEZADO_EXPORT]]]));
  for (const it of items) {
    // OJO: una presentación mayorista de Fraccionado lleva acá el bulto $/kg SIN IVA (lista minorista suele ir con IVA);
    // pendiente que el usuario confirme a qué lista de SIGA va.
    if (it.minorista) listas.minorista.push([codigoNumerico(it.minorista.plu), it.minorista.nombre, E.r2(it.costo), it.minorista.precio]);
    for (const m of it.mayoristas) {
      const costo = E.r2(it.costo * m.unidades);
      listas[`${m.tipo}Neto`].push([codigoNumerico(m.plu), m.nombre, costo, m.neto]);
      listas[`${m.tipo}Iva`].push([codigoNumerico(m.plu), m.nombre, costo, m.conIva]);
    }
  }
  return listas;
}

// ── Importar planilla (Reventa, 2026-10-19) ──
// El usuario elige el costo por producto en Excel y sube a SIGA una planilla Codigo/Nombre/Costo/Precio; esa misma planilla
// se importa acá para MARCAR cada producto con la fuente que eligió (decisión igual que PUT /decision), así "Exportar
// decididos" arma minorista + pack + bulto. Tolerancia ±$0,50 (como alinear, lib/precios_esquema).
const TOLERANCIA_PLANILLA = 0.5;
const MAX_FILAS_PLANILLA = 5000;
const precioMinorista = s => (s && !s.error && s.minorista ? s.minorista.precio ?? null : null);
const cerca = (a, b) => a != null && b != null && Math.abs(a - b) < TOLERANCIA_PLANILLA;
// Varias fuentes coinciden: con el mismo minorista da igual (la primera de FUENTES: sistema → ultimaCompra → manual); si no, null.
const unaDe = (fuentes, sug) => (fuentes.length === 1 || (fuentes.length > 1 && new Set(fuentes.map(f => precioMinorista(sug[f]))).size === 1) ? fuentes[0] : null);
// Fila de Reventa + { costo, precio } de la planilla → { fuente } | { motivo }. Primero el Costo contra el costo en pantalla
// de cada fuente (COSTO_PANTALLA, el que escribe el export); si no define, el Precio contra su minorista sugerido.
function emparejarFila(fila, { costo = null, precio = null } = {}) {
  const sug = objeto(fila.sugeridos);
  const candidatas = FUENTES.filter(f => precioMinorista(sug[f]) != null);
  if (!candidatas.length) return { motivo: 'Sin sugerido' };
  const porCosto = candidatas.filter(f => cerca(costo, fila[COSTO_PANTALLA[f]]));
  const fuenteCosto = unaDe(porCosto, sug);
  if (fuenteCosto) return { fuente: fuenteCosto };
  const porPrecio = (porCosto.length ? porCosto : candidatas).filter(f => cerca(precio, precioMinorista(sug[f])));
  const fuentePrecio = unaDe(porPrecio, sug);
  if (fuentePrecio) return { fuente: fuentePrecio };
  return { motivo: porCosto.length > 1 || porPrecio.length > 1 ? 'Coinciden varios con precios distintos' : 'Ningún costo ni precio coincide' };
}

// body.filas del POST → { filas: [{ codigo, nombre, costo, precio }] } | { error }. Código = PLU de SIGA (número o texto).
const numeroONull = v => (v == null ? null : typeof v === 'number' && Number.isFinite(v) ? v : undefined);
function validarFilasPlanilla(filas) {
  if (!Array.isArray(filas) || !filas.length) return { error: 'La planilla no tiene filas' };
  if (filas.length > MAX_FILAS_PLANILLA) return { error: `La planilla tiene más de ${MAX_FILAS_PLANILLA} filas` };
  const limpias = [];
  for (const [i, f] of filas.map(objeto).entries()) {
    const codigo = String(f.codigo ?? '').trim();
    const costo = numeroONull(f.costo), precio = numeroONull(f.precio);
    if (!PLU_SIGA.test(codigo) || costo === undefined || precio === undefined) return { error: `Fila ${i + 1} inválida: código numérico y costo/precio números o null` };
    limpias.push({ codigo, nombre: typeof f.nombre === 'string' ? f.nombre : '', costo, precio });
  }
  return { filas: limpias };
}

// Filas de la planilla contra el listado de Reventa ENTERO (también las sin tipo de proveedor, que el listado oculta por
// defecto). produccion = PLUs de venta de Producción (no están en Reventa). → { decisiones: [{ plu, fuente, fila }], marcados,
// sinCoincidencia, noEncontrados, sinClasificar, total }. Código repetido: vale la última fila.
function cruzarPlanilla(almacen, filas, produccion = new Set()) {
  const porPlu = new Map((almacen || []).map(f => [f.plu, f]));
  const decididas = new Map(), sinCoincidencia = [], noEncontrados = [];
  for (const p of filas) {
    const fila = porPlu.get(p.codigo);
    if (!fila) { noEncontrados.push({ ...p, motivo: produccion.has(p.codigo) ? 'Es de Producción (se decide en Producción)' : 'Código no encontrado en Reventa' }); continue; }
    const r = emparejarFila(fila, p);
    if (r.fuente) { decididas.set(fila.plu, { plu: fila.plu, fuente: r.fuente, fila }); continue; }
    const sug = objeto(fila.sugeridos);
    sinCoincidencia.push({ ...p, nombre: fila.nombre, costoSistema: fila.costoSistema ?? null, costoUltimaCompra: fila.costoUltimaCompra ?? null,
      sugeridoSistema: precioMinorista(sug.sistema), sugeridoUltimaCompra: precioMinorista(sug.ultimaCompra),
      motivo: fila.tipoProveedor ? r.motivo : `${r.motivo} · Sin clasificar (no aparece en el listado)` });
  }
  const decisiones = [...decididas.values()];
  const marcados = Object.fromEntries(FUENTES.map(f => [f, decisiones.filter(d => d.fuente === f).length]));
  return { decisiones, marcados, sinCoincidencia, noEncontrados, sinClasificar: decisiones.filter(d => !d.fila.tipoProveedor).length, total: filas.length };
}

// Lo que viaja al front. Sin desglose (gastos, márgenes, extras) ni costos con extras: el listado para todos y el
// detalle para quien no tiene precios-config. conDesglose = la fila entera (detalle con el permiso).
function filaPublica(fila, conDesglose = false) {
  if (conDesglose) return fila;
  const { costos: _c, costosExtra: _e, componentesCosto: _cc, costeoPresentacion: _cp, sugeridos, presentaciones, ...resto } = fila;
  return {
    ...resto,
    sugeridos: Object.fromEntries(Object.entries(sugeridos || {}).map(([f, s]) => { const { desglose: _d, ...x } = s; return [f, x]; })),
    ...(presentaciones ? { presentaciones: presentaciones.map(p => filaPublica(p)) } : {}),
  };
}

module.exports = {
  FUENTES, FUENTES_DECISION, precioFijoDe, validarPluSiga, aplicarPrecioFijo, TIPOS_PROVEEDOR, validarTipoProveedor, aplicarPorPlu, validarActivoGranel, costosFuentes, costoEnSuTab, crearCostoDe, infoCostos, unidadesVinculo, crearMayoristasDe, preciosDeCosto, filaProducto, listadoReventa, filaPublica,
  agruparPorGranel, listadoFraccionado, listadoProduccion,
  margenProductoDe, filaDecidible, validarDecision, validarDecisionContraFilas, aplicarDecision, vigentesDeFila, decisionVigente, podarDecisiones, leerCosteoVigente,
  resolverDecision, itemsDecididos, listasExport, LISTAS_EXPORT, emparejarFila, validarFilasPlanilla, cruzarPlanilla,
};
