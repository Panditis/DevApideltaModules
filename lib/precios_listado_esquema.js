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

// mayoristasDe(basePlu, pesable) → [{ plu, nombre, tipo, unidades, vigente }] de los pack/bulto vinculados a ese PLU.
function crearMayoristasDe({ vinculos, vigentes, ventaPesable = {} }) {
  const porBase = new Map();
  for (const v of vinculos || []) porBase.set(String(v.basePlu), [...(porBase.get(String(v.basePlu)) || []), v]);
  return (basePlu, pesable = false) => (porBase.get(String(basePlu)) || []).map(v => ({
    plu: v.plu, nombre: v.nombre, tipo: v.tipo, unidades: unidadesVinculo(v, ventaPesable, pesable), vigente: vigenteDe(vigentes, v.plu),
  }));
}

// Precios de un costo: minorista (motor sin vínculos) y cada pack/bulto vinculado (motor con sus unidades y vigente).
// Semáforo contra el vigente (lista 0) en minorista y en las listas con IVA. desglose = salida cruda del motor (sólo
// viaja con el permiso de Configuración, ver filaPublica). error del motor: 'costo' | 'margen' | 'gastos'.
function preciosDeCosto({ cfg, tipo, costo, pesoG = null, vigente = null, mayoristas = [] }) {
  const tol = cfg.toleranciaPct;
  const base = E.preciosCanales({ tipo, costo, pesoG, vigentes: { minorista: vigente }, cfg });
  if (base.error) return { error: base.error, minorista: null, mayoristas: [], desglose: null };
  const porVinculo = {};
  const mayor = mayoristas.map(m => {
    if (!(m.unidades > 0)) return { plu: m.plu, faltante: 'unidades', neto: null, conIva: null, deltaPct: null, estado: null, revisarUnidad: false };
    const canal = E.preciosCanales({ tipo, costo, pesoG, unidades: { [m.tipo]: m.unidades }, vigentes: { [m.tipo]: m.vigente }, cfg })[m.tipo];
    porVinculo[m.plu] = canal;
    const ratio = m.vigente > 0 ? m.vigente / canal.conIva : null;
    return { plu: m.plu, faltante: null, neto: canal.neto, conIva: canal.conIva, ...compararConVigente(canal.conIva, m.vigente, tol),
      revisarUnidad: ratio != null && (ratio < RATIO_UNIDAD[0] || ratio > RATIO_UNIDAD[1]) };
  });
  return {
    error: null, minorista: { precio: base.minorista.precio, ...compararConVigente(base.minorista.precio, vigente, tol) },
    mayoristas: mayor, desglose: { ...base, porVinculo },
  };
}

// Fila de un producto (Reventa, presentación de Fraccionado o de Producción): un sugerido por fuente con costo.
function filaProducto({ plu, nombre, tipo, costos, pesoG = null, vigente = null, mayoristas = [], cfg }) {
  const sugeridos = Object.fromEntries(FUENTES.filter(f => costos[f] != null)
    .map(f => [f, preciosDeCosto({ cfg, tipo, costo: costos[f], pesoG, vigente, mayoristas })]));
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

// Producción: una fila por presentación con PLU de SIGA. Costo = costo por unidad de la receta (costearTodos, fase 3:
// sin cambios); es su única fuente ('sistema'), sin última compra ni manual.
function listadoProduccion({ presentaciones, vigentes, mayoristasDe, costeo, cfg }) {
  return (presentaciones || []).filter(p => PLU_SIGA.test(String(p.plu))).map(p => {
    const costo = p.costoUnidad > 0 ? p.costoUnidad : null;
    return {
      ...filaProducto({ plu: p.plu, nombre: p.nombre || p.plu, tipo: 'produccion', costos: { sistema: costo, ultimaCompra: null, manual: null },
        vigente: vigenteDe(vigentes, p.plu), mayoristas: mayoristasDe(p.plu), cfg }),
      productoId: p.productoId, costoSistema: costo, costoManual: null, decision: decisionDe(costeo, p.plu),
    };
  }).sort(porNombre);
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
  FUENTES, costosFuentes, infoCostos, unidadesVinculo, crearMayoristasDe, preciosDeCosto, filaProducto, listadoReventa, filaPublica,
  agruparPorGranel, listadoFraccionado, listadoProduccion,
};
