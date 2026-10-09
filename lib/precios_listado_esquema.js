'use strict';
// ── Precios · filas de los listados con el esquema por canal (spec 2026-10-07-precios-esquema-canales-design §3) ──
// Puro (sin SQL/fs): costo por fuente (sistema / última compra / manual, + costos extra) → precios de cada canal con
// lib/precios_esquema → filas de Reventa, Fraccionado (por granel) y Producción (por presentación); decisión y export.
// routes/rutas_precios_esquema.js trae SIGA y archivos y llama a esto: un solo cálculo para listado, modal y export.
const E = require('./precios_esquema');
const { aplicarCostosExtra, compararConVigente } = require('./precios_costeo');
const { granelDePresentacion, crearGranelPorNombre } = require('./precios_consultas');
const { pesoTokenKg } = require('./producto_carga');

const FUENTES = ['sistema', 'ultimaCompra', 'manual'];
const RATIO_UNIDAD = [0.5, 1.2]; // mismo criterio "revisar unidad" que lib/precios_pack_bulto
const PLU_SIGA = /^\d{1,12}$/;
const SIN_GRANEL = 'Sin granel asignado';
const porNombre = (a, b) => String(a.nombre ?? '').localeCompare(String(b.nombre ?? ''), 'es');

const objeto = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const vigenteDe = (vigentes, plu) => (plu != null && vigentes.has(plu) ? vigentes.get(plu) : null);
const manualDe = (costeo, plu) => { const v = objeto(costeo.costoPorProducto)[plu]; return typeof v === 'number' && v > 0 ? v : null; };
const extrasDe = (costeo, plu) => { const v = objeto(costeo.costosExtraFraccionado)[plu]; return Array.isArray(v) ? v : []; };
const decisionDe = (costeo, plu) => objeto(costeo.decisiones)[plu] || null;

// Costo de mercadería neto por fuente con los costos extra del producto/granel ($ o % del costo). Fuente sin costo
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
  const fuente = decision ? decision.fuente : costos.manual != null ? 'manual' : 'sistema';
  return { costo: costos[fuente] ?? null, fuente };
}

// Columnas de costo de la fila (sin extras) desde una fila de productosConCostos (lib/precios_consultas filaCostos).
function infoCostos(fila, costoManual = null) {
  const f = objeto(fila);
  const sis = f.costoSistema ?? null, ult = f.costoMercaderia ?? null;
  return {
    costoSistema: sis, costoUltimaCompra: ult, fechaUltimaCompra: f.fechaUltimaCompra || null, proveedor: f.proveedor || null, costoManual,
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
// Semáforo contra el vigente (lista 0) en minorista y en las listas con IVA. desglose = salida cruda del motor (sólo
// viaja con el permiso de Configuración, ver filaPublica). error del motor: 'costo' | 'margen' | 'gastos'.
// margenExtra = margen especial del producto de Producción ({ minorista, pack, bulto }, puntos %), o null.
function preciosDeCosto({ cfg, tipo, costo, pesoG = null, vigente = null, mayoristas = [], margenExtra = null }) {
  const tol = cfg.toleranciaPct;
  const base = E.preciosCanales({ tipo, costo, pesoG, vigentes: { minorista: vigente }, cfg, margenExtra });
  if (base.error) return { error: base.error, minorista: null, mayoristas: [], desglose: null };
  const porVinculo = {};
  const mayor = mayoristas.map(m => {
    if (!(m.unidades > 0)) {
      return { plu: m.plu, faltante: 'unidades', neto: null, conIva: null, margenTotalNetoPct: null, margenTotalIvaPct: null,
        deltaPct: null, estado: null, revisarUnidad: false };
    }
    const canal = E.preciosCanales({ tipo, costo, pesoG, unidades: { [m.tipo]: m.unidades }, vigentes: { [m.tipo]: m.vigente }, cfg, margenExtra })[m.tipo];
    porVinculo[m.plu] = canal;
    const ratio = m.vigente > 0 ? m.vigente / canal.conIva : null;
    const costoCaja = costo * m.unidades;
    return { plu: m.plu, faltante: null, neto: canal.neto, conIva: canal.conIva,
      margenTotalNetoPct: margenTotalPct(canal.neto, costoCaja), margenTotalIvaPct: margenTotalPct(canal.conIva, costoCaja),
      ...compararConVigente(canal.conIva, m.vigente, tol),
      revisarUnidad: ratio != null && (ratio < RATIO_UNIDAD[0] || ratio > RATIO_UNIDAD[1]) };
  });
  return {
    error: null,
    minorista: { precio: base.minorista.precio, margenTotalPct: margenTotalPct(base.minorista.precio, costo), ...compararConVigente(base.minorista.precio, vigente, tol) },
    mayoristas: mayor, desglose: { ...base, porVinculo },
  };
}

// Fila de un producto (Reventa, presentación de Fraccionado o de Producción): un sugerido por fuente con costo.
function filaProducto({ plu, nombre, tipo, costos, pesoG = null, vigente = null, mayoristas = [], cfg, margenExtra = null }) {
  const sugeridos = Object.fromEntries(FUENTES.filter(f => costos[f] != null)
    .map(f => [f, preciosDeCosto({ cfg, tipo, costo: costos[f], pesoG, vigente, mayoristas, margenExtra })]));
  return { plu, nombre, tipo, pesoG, vigente, costos, mayoristas, sugeridos };
}

// Reventa: una fila por producto del universo (filas de productosConCostos).
function listadoReventa({ universo, vigentes, mayoristasDe, costeo, cfg }) {
  return (universo || []).map(p => {
    const manual = manualDe(costeo, p.plu);
    const extras = extrasDe(costeo, p.plu);
    return {
      ...filaProducto({ plu: p.plu, nombre: p.nombre, tipo: 'almacen', vigente: vigenteDe(vigentes, p.plu), mayoristas: mayoristasDe(p.plu), cfg,
        costos: costosFuentes({ costoSistema: p.costoSistema, costoUltimaCompra: p.costoMercaderia, costoManual: manual, extras }) }),
      ...infoCostos(p, manual), costosExtra: extras, decision: decisionDe(costeo, p.plu),
    };
  });
}

// Fraccionado: un grupo por granel con sus presentaciones (granelDePresentacion: fórmula › fórmula SIGA › nombre ›
// propio PLU). Granel referenciado fuera del rubro pero con fila en SIGA → grupo propio. Sin granel → grupo
// { plu: null } al final (no se puede decidir).
function agruparPorGranel({ graneles, presentaciones, formulas, costos }) {
  const granelPorNombre = crearGranelPorNombre(graneles);
  const grupos = new Map((graneles || []).map(g => [g.plu, { plu: g.plu, nombre: g.nombre, presentaciones: [] }]));
  const sinGranel = { plu: null, nombre: SIN_GRANEL, presentaciones: [] };
  for (const p of presentaciones || []) {
    const g = granelDePresentacion(formulas, p, granelPorNombre);
    if (g && !grupos.has(g) && costos.has(g)) grupos.set(g, { plu: g, nombre: costos.get(g).nombre, presentaciones: [] });
    const destino = g && grupos.has(g) ? grupos.get(g) : sinGranel;
    destino.presentaciones = [...destino.presentaciones, p];
  }
  const lista = [...grupos.values()].sort(porNombre);
  return sinGranel.presentaciones.length ? [...lista, sinGranel] : lista;
}

// Fila por granel con sus presentaciones. Precio por kg (como SIGA): costo $/kg del granel + costos extra (sin MO ni
// insumos), escalón por ese costo y ajuste por el peso de cada presentación. Los pack/bulto de una presentación o del
// granel son pesables (unidades = 1 kg o kg del paquete). La fila del granel no tiene vigente (no se vende suelto):
// sólo aporta sus pack/bulto. La decisión vive en el PLU del granel y alcanza a todas sus presentaciones.
function listadoFraccionado({ grupos, costos, vigentes, mayoristasDe, costeo, cfg }) {
  return (grupos || []).map(g => {
    const fila = g.plu != null ? costos.get(g.plu) || {} : {};
    const manual = g.plu != null ? manualDe(costeo, g.plu) : null;
    const extras = g.plu != null ? extrasDe(costeo, g.plu) : [];
    const costosG = g.plu == null ? { sistema: null, ultimaCompra: null, manual: null }
      : costosFuentes({ costoSistema: fila.costoSistema, costoUltimaCompra: fila.costoMercaderia, costoManual: manual, extras });
    const presentaciones = g.presentaciones.map(p => {
      const kg = pesoTokenKg(p.nombre);
      return filaProducto({ plu: p.plu, nombre: p.nombre, tipo: 'fraccionado', costos: costosG, pesoG: kg > 0 ? Math.round(kg * 1000) : null,
        vigente: vigenteDe(vigentes, p.plu), mayoristas: mayoristasDe(p.plu, true), cfg });
    }).sort((a, b) => (a.pesoG ?? Infinity) - (b.pesoG ?? Infinity));
    return {
      ...filaProducto({ plu: g.plu, nombre: g.nombre, tipo: 'fraccionado', costos: costosG, mayoristas: g.plu == null ? [] : mayoristasDe(g.plu, true), cfg }),
      ...infoCostos(fila, manual), costosExtra: extras, decision: g.plu == null ? null : decisionDe(costeo, g.plu), presentaciones,
    };
  });
}

// Producción: una fila por presentación con PLU de SIGA. Costo = costo por unidad de la receta (sólo materias primas,
// fase 4); es su única fuente ('sistema'), sin última compra ni manual. aRevisar = materias primas movidas desde la última
// validación (lib/precios_produccion revisionDe). margenExtra = margen especial de su producto (se suma al de cada canal).
function listadoProduccion({ presentaciones, vigentes, mayoristasDe, costeo, cfg }) {
  return (presentaciones || []).filter(p => PLU_SIGA.test(String(p.plu))).map(p => {
    const costo = p.costoUnidad > 0 ? p.costoUnidad : null;
    return {
      ...filaProducto({ plu: p.plu, nombre: p.nombre || p.plu, tipo: 'produccion', costos: { sistema: costo, ultimaCompra: null, manual: null },
        vigente: vigenteDe(vigentes, p.plu), mayoristas: mayoristasDe(p.plu), cfg, margenExtra: p.margenExtra || null }),
      productoId: p.productoId, costoSistema: costo, costoManual: null, decision: decisionDe(costeo, p.plu), aRevisar: p.aRevisar || null,
    };
  }).sort(porNombre);
}

// ── Decisión (reemplaza marcadosExportar + fuenteCosto, spec §3.1) ──────────────────────────────────────────
// decisiones { [plu]: { fuente, fecha } }. Producción guarda 'sistema' (= "Aumentar"). 'manual' exige costo manual.
function validarDecision(plu, fuente, costeo) {
  if (!PLU_SIGA.test(String(plu))) return 'PLU inválido';
  if (fuente !== null && !FUENTES.includes(fuente)) return `fuente inválida: ${FUENTES.join(', ')} o null`;
  if (fuente === 'manual' && manualDe(costeo || {}, plu) == null) return 'Este producto no tiene costo manual cargado';
  return null;
}
// Contra los listados: sólo se decide una fila de Reventa, un granel de Fraccionado o una presentación de Producción, y con
// una fuente que tenga sugerido en esa fila (Producción sólo 'sistema'; 'manual' exige costo manual); si no, nunca exportaría.
// fuente null (quitar) pasa siempre: así se limpian decisiones viejas de PLUs que ya no están.
function validarDecisionContraFilas({ almacen = [], fraccionado = [], produccion = [] }, plu, fuente) {
  if (fuente == null) return null;
  const fila = [...almacen, ...produccion, ...fraccionado.filter(g => g.plu != null)].find(f => f.plu === plu);
  if (!fila) {
    const grupo = fraccionado.find(g => (g.presentaciones || []).some(p => p.plu === plu));
    if (!grupo) return `El PLU ${plu} no está en ningún listado de precios`;
    return `El PLU ${plu} es una presentación de Fraccionado: la decisión se toma en su granel${grupo.plu != null ? ` (PLU ${grupo.plu})` : ''}`;
  }
  const disponibles = Object.keys(objeto(fila.sugeridos));
  return disponibles.includes(fuente) ? null
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
// Lo que exporta una fila con la fuente decidida: su costo y sus precios. Sin sugerido con esa fuente → null (omitido).
function resolverDecision(fila, fuente) {
  const s = objeto(fila.sugeridos)[fuente];
  if (!s || s.error) return null;
  return {
    costo: fila.costos[fuente],
    minorista: { plu: fila.plu, nombre: fila.nombre, precio: s.minorista.precio },
    mayoristas: s.mayoristas.filter(m => m.conIva != null).map(m => {
      const v = fila.mayoristas.find(x => x.plu === m.plu);
      return { plu: m.plu, nombre: v.nombre, tipo: v.tipo, unidades: v.unidades, neto: m.neto, conIva: m.conIva };
    }),
  };
}

// Filas decididas de los tres listados → items de export. La decisión alcanza a los pack/bulto vinculados; en
// Fraccionado la del granel alcanza a todas sus presentaciones (y a los pack/bulto del granel, que no tiene minorista).
function itemsDecididos({ almacen = [], fraccionado = [], produccion = [] }) {
  const items = [];
  let omitidos = 0;
  const sumar = (fila, fuente, conMinorista = true) => {
    const r = resolverDecision(fila, fuente);
    if (!r) { omitidos++; return; }
    items.push(conMinorista ? r : { ...r, minorista: null });
  };
  for (const f of [...almacen, ...produccion]) if (f.decision) sumar(f, f.decision.fuente);
  for (const g of fraccionado) {
    if (!g.decision) continue;
    sumar(g, g.decision.fuente, false);
    for (const p of g.presentaciones || []) sumar(p, g.decision.fuente);
  }
  return { items, omitidos };
}

const ENCABEZADO_EXPORT = Object.freeze(['Codigo', 'Nombre', 'Costo', 'Venta']);
const LISTAS_EXPORT = ['minorista', 'packNeto', 'packIva', 'bultoNeto', 'bultoIva'];
// Una lista por canal: [Codigo, Nombre, Costo, Venta]. Costo = costo de mercadería de lo que se vende (× unidades en
// pack/bulto: 1 salvo pesable por paquete, que va × kg), con IVA en minorista y en las listas con IVA (como el export de siempre), sin IVA en las listas sin IVA.
function listasExport(items, ivaVentaPct) {
  const conIva = c => E.r2(c * (1 + (Number(ivaVentaPct) || 0) / 100));
  const listas = Object.fromEntries(LISTAS_EXPORT.map(l => [l, [[...ENCABEZADO_EXPORT]]]));
  for (const it of items) {
    if (it.minorista) listas.minorista.push([it.minorista.plu, it.minorista.nombre, conIva(it.costo), it.minorista.precio]);
    for (const m of it.mayoristas) {
      const costo = E.r2(it.costo * m.unidades);
      listas[`${m.tipo}Neto`].push([m.plu, m.nombre, costo, m.neto]);
      listas[`${m.tipo}Iva`].push([m.plu, m.nombre, conIva(costo), m.conIva]);
    }
  }
  return listas;
}

// Lo que viaja al front. Sin desglose (gastos, márgenes, extras) ni costos con extras: el listado para todos y el
// detalle para quien no tiene precios-config. conDesglose = la fila entera (detalle con el permiso).
function filaPublica(fila, conDesglose = false) {
  if (conDesglose) return fila;
  const { costos: _c, costosExtra: _e, sugeridos, presentaciones, ...resto } = fila;
  return {
    ...resto,
    sugeridos: Object.fromEntries(Object.entries(sugeridos || {}).map(([f, s]) => { const { desglose: _d, ...x } = s; return [f, x]; })),
    ...(presentaciones ? { presentaciones: presentaciones.map(p => filaPublica(p)) } : {}),
  };
}

module.exports = {
  FUENTES, costosFuentes, costoEnSuTab, infoCostos, unidadesVinculo, crearMayoristasDe, preciosDeCosto, filaProducto, listadoReventa, filaPublica,
  agruparPorGranel, listadoFraccionado, listadoProduccion,
  validarDecision, validarDecisionContraFilas, aplicarDecision, vigentesDeFila, decisionVigente, podarDecisiones, leerCosteoVigente,
  resolverDecision, itemsDecididos, listasExport, LISTAS_EXPORT,
};
