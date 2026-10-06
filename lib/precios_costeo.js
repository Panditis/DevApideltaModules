'use strict';
// Módulo puro de costeo — Precios. Sin fs/SQL/Express, todo se inyecta por parámetros.
// Fase 1: Almacén. Fase 2: Fraccionado (costo del granel × margen por costo y presentación).
// Producción llega en una fase futura, con el mismo shape de salida que costearAlmacen (ver abajo).

// Fórmula (spec 2026-10-02-precios-costo-neto-iva-curva, Parte C): costos separados de la ganancia.
//   costoReal   = C ÷ (1 − G_T)                    (G_T = variables% + departamentos% del tipo)
//   gananciaPct = curva_T(C) + Σ conceptosGanancia%  (o la ganancia propia del producto, que reemplaza las dos)
//   precioNeto  = costoReal × (1 + gananciaPct)      = C × (1 + markup), markup = (1 + g) ÷ (1 − G) − 1
//   base        = precioNeto × (1 + ivaVentaPct)     (precio con IVA)
//   precioFinal = base ÷ (1 − F)                      → redondeo a $50 (Parte D: F = Σ conceptosPrecioFinal%,
//                 impuestos cobrados sobre el precio final, ej. IIBB; cada concepto $ = final exacto × pct)
// ivaVentaPct = IVA de VENTA global de costeo.json (default 21). Productos.Alicuota sólo pasa el PrecioCosto de
// SIGA (con IVA de compra) a neto.
const IVA_DEFAULT_PCT = 21;
// Factor que se usaba hasta 2026-09-30 (costo sin IVA × markup × 1,21): sólo para migrar márgenes propios.
const IVA_VENTA_ANTERIOR = 1.21;

// IVA de venta de la config: número 0..100, si no el default.
function ivaVentaPctDe(cfg) {
  const v = (cfg || {}).ivaVentaPct;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : IVA_DEFAULT_PCT;
}

// ── Conceptos de ganancia (tab Ganancia) ─────────────────────────────────────
// [{ id, concepto, pct }]: % sobre el costo real que se suman a la curva de los tres tipos.
const CONCEPTOS_GANANCIA_MAX = 40;
const CONCEPTO_GANANCIA_RANGO = [-100, 300];
const conceptosGananciaDe = cfg => (Array.isArray((cfg || {}).conceptosGanancia) ? cfg.conceptosGanancia : [])
  .filter(c => c && typeof c.pct === 'number' && Number.isFinite(c.pct));
const totalConceptosGanancia = items => Math.round((Array.isArray(items) ? items : [])
  .filter(c => c && typeof c.pct === 'number' && Number.isFinite(c.pct)).reduce((s, c) => s + c.pct, 0) * 1e4) / 1e4;
// Ganancia standard = curva + conceptos (6 dec); sin curva no hay ganancia.
const gananciaStandard = (curvaPct, conceptosPct) => (curvaPct == null ? null : +(curvaPct + (Number(conceptosPct) || 0)).toFixed(6));

// Lista [{ id, concepto, pct }] (conceptos de ganancia y sobre precio final): concepto 1–60, pct en [min, max]
// (maxExcluido: pct < max), máx CONCEPTOS_GANANCIA_MAX, id slug o generado. nombre = clave del body en los errores.
function validarListaConceptos(items, { nombre, min, max, maxExcluido = false }) {
  if (!Array.isArray(items)) throw new Error(`${nombre}: debe ser una lista`);
  if (items.length > CONCEPTOS_GANANCIA_MAX) throw new Error(`${nombre}: máximo ${CONCEPTOS_GANANCIA_MAX} conceptos`);
  const limpios = items.map((it, i) => {
    if (!it || typeof it !== 'object') throw new Error(`${nombre}[${i}]: ítem inválido`);
    const concepto = typeof it.concepto === 'string' ? it.concepto.trim() : '';
    if (!concepto || concepto.length > CONCEPTO_MAX) throw new Error(`${nombre}[${i}].concepto: texto de 1 a ${CONCEPTO_MAX} caracteres`);
    if (typeof it.pct !== 'number' || !Number.isFinite(it.pct) || it.pct < min || (maxExcluido ? it.pct >= max : it.pct > max)) {
      throw new Error(`${nombre}[${i}].pct: debe ser un número ${maxExcluido ? `de ${min} a menos de ${max}` : `entre ${min} y ${max}`}`);
    }
    if (it.id != null && (typeof it.id !== 'string' || !ID_GASTO.test(it.id))) {
      throw new Error(`${nombre}[${i}].id: minúsculas, números y guiones (1 a 40)`);
    }
    return { id: it.id == null ? null : it.id, concepto, pct: it.pct };
  });
  return asignarIds(limpios, c => c.concepto);
}

function validarConceptosGanancia(items) {
  const [min, max] = CONCEPTO_GANANCIA_RANGO;
  return validarListaConceptos(items, { nombre: 'conceptos', min, max });
}

// ── Conceptos sobre precio final (Parte D) ───────────────────────────────────
// [{ id, concepto, pct }]: impuestos que se cobran sobre el precio final con IVA (IIBB, débitos/créditos). Iguales para
// los tres tipos. Gross-up: precioFinal = (precioNeto + IVA) ÷ (1 − F). pct 0..<100, total < 100.
const conceptosPrecioFinalDe = cfg => (Array.isArray((cfg || {}).conceptosPrecioFinal) ? cfg.conceptosPrecioFinal : [])
  .filter(c => c && typeof c.pct === 'number' && Number.isFinite(c.pct));
function validarConceptosPrecioFinal(items) {
  const lista = validarListaConceptos(items, { nombre: 'conceptosPrecioFinal', min: 0, max: 100, maxExcluido: true });
  if (totalConceptosGanancia(lista) >= 100) throw new Error('conceptosPrecioFinal: el total debe ser menor a 100 %');
  return lista;
}

function validarIvaVentaPct(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) throw new Error('ivaVentaPct: debe ser un número entre 0 y 100');
  return v;
}

// Desglose del precio sobre el costo neto C con el markup total m (ya incluye gastos y ganancia). gastos =
// { variablesPct, departamentosPct } del tipo (G = suma); departamentosPct null = desconocido → sin desglose.
// conceptos = conceptos de ganancia aplicados ([] con ganancia propia). Sumas exactas a 2 decimales:
// C + variables + departamentos = costoReal; gananciaCurva + Σ conceptos = ganancia; costoReal + ganancia = precioNeto;
// precioNeto + iva = precioConIvaBase; precioConIvaBase + Σ conceptosFinal $ = precioFinalExacto (conceptosFinal =
// conceptos sobre precio final, ver sobrePrecioFinal).
function desglosePrecio({ costo, markupPct, gastos = {}, ivaPct = IVA_DEFAULT_PCT, conceptos = [], conceptosFinal = [] }) {
  const C = redondear2(Number(costo));
  const precioNeto = redondear2(Number(costo) * (1 + markupPct / 100));
  const v = gastos.variablesPct == null ? 0 : gastos.variablesPct;
  const d = gastos.departamentosPct === undefined ? 0 : gastos.departamentosPct;
  const conGastos = esNumero(v) && esNumero(d) && v + d < 100;
  const realExacto = conGastos ? Number(costo) / (1 - (v + d) / 100) : null;
  const costoReal = conGastos ? redondear2(realExacto) : null;
  const variables = conGastos ? redondear2(realExacto * v / 100) : null;
  const departamentos = conGastos ? redondear2(costoReal - C - variables) : null;
  const gananciaPct = conGastos ? +(((1 + markupPct / 100) * (1 - (v + d) / 100) - 1) * 100).toFixed(6) : null;
  const ganancia = conGastos ? redondear2(precioNeto - costoReal) : null;
  const lista = (Array.isArray(conceptos) ? conceptos : []).filter(c => c && esNumero(c.pct)).map(c => ({
    id: c.id ?? null, concepto: c.concepto, pct: c.pct, importe: conGastos ? redondear2(realExacto * c.pct / 100) : null,
  }));
  const conceptosPct = totalConceptosGanancia(lista);
  const conceptosImporte = conGastos ? redondear2(lista.reduce((s, c) => s + c.importe, 0)) : null;
  const iva = redondear2(precioNeto * ivaPct / 100);
  const precioConIvaBase = redondear2(precioNeto + iva);
  const fin = sobrePrecioFinal(precioConIvaBase, conceptosFinal);
  return {
    costo: C, variablesPct: conGastos ? v : null, variables, departamentosPct: conGastos ? d : null, departamentos, costoReal,
    gananciaPct, ganancia,
    gananciaCurvaPct: gananciaPct == null ? null : +(gananciaPct - conceptosPct).toFixed(6),
    gananciaCurva: ganancia == null ? null : redondear2(ganancia - conceptosImporte),
    conceptos: lista, conceptosPct, conceptosImporte,
    precioNeto, ivaPct, iva, precioConIvaBase,
    conceptosFinal: fin.lista, conceptosFinalPct: fin.pct, conceptosFinalImporte: fin.importe,
    precioFinalExacto: fin.exacto, markupNetoPct: redondear2(markupPct),
  };
}

// Gross-up de los conceptos sobre precio final: exacto = base ÷ (1 − F); cada concepto $ = exacto × pct y el último
// absorbe el redondeo (base + Σ importes = exacto, a 2 decimales). F = 0 → exacto = base (el precio de antes).
// ponytail: F ≥ 100 no se maneja acá; lo impiden validarConceptosPrecioFinal y la migración (mueve gastos < 100 %).
function sobrePrecioFinal(base, conceptosFinal) {
  const items = (Array.isArray(conceptosFinal) ? conceptosFinal : []).filter(c => c && esNumero(c.pct));
  const pct = totalConceptosGanancia(items);
  const exacto = pct > 0 ? redondear2(base / (1 - pct / 100)) : base;
  const importe = redondear2(exacto - base);
  const previos = items.slice(0, -1).map(c => redondear2(exacto * c.pct / 100));
  const ultimo = redondear2(importe - previos.reduce((s, v) => s + v, 0));
  const lista = items.map((c, i) => ({ id: c.id ?? null, concepto: c.concepto, pct: c.pct, importe: i < previos.length ? previos[i] : ultimo }));
  return { lista, pct, importe, exacto };
}

// Markup final % = precio final ÷ costo neto − 1 (2 decimales); null sin datos.
function markupFinalPct(precioFinal, costo) {
  const p = Number(precioFinal), c = Number(costo);
  return precioFinal == null || costo == null || !(p > 0) || !(c > 0) ? null : redondear2((p / c - 1) * 100);
}

// Campos del precio comunes a Almacén/Fraccionado/Producción a partir del desglose.
function camposPrecio(des) {
  const precioConIva = redondearPrecioVenta(des.precioFinalExacto);
  return {
    precioNeto: des.precioNeto, precioConIva, precioConIvaExacto: des.precioFinalExacto,
    costoReal: des.costoReal, gananciaPct: des.gananciaPct, ivaPct: des.ivaPct, finalPct: des.conceptosFinalPct,
    markupFinalPct: markupFinalPct(precioConIva, des.costo), desglose: des,
  };
}
const SIN_PRECIO = {
  precioNeto: null, precioConIva: null, precioConIvaExacto: null, costoReal: null, gananciaPct: null,
  markupFinalPct: null, desglose: null,
};

// Redondeo de plata a 2 decimales (convención ARS) — mismo patrón que redondear() en compras.js:
// sin esto, costo*pct/100 y aplicarMarkup dejan ruido de punto flotante (ej 24.999750000000002)
// que no debe llegar a una UI de precios.
function redondear2(n) {
  return Math.round(n * 100) / 100;
}

// Precio de venta final: múltiplo de 50 más cercano, sin decimales (regla comercial; el
// generador Excel hacía lo mismo con MROUND, a 10). Sólo para el precio final — costos
// y neto siguen a 2 decimales.
const PASO_PRECIO_VENTA = 50;
function redondearPrecioVenta(n) {
  return Math.round(n / PASO_PRECIO_VENTA) * PASO_PRECIO_VENTA;
}

function aplicarMarkup(costo, markupPct) {
  return costo * (1 + markupPct / 100);
}

// ── Fraccionado ──────────────────────────────────────────────────────────────
// Ganancia standard = curva por costo del granel + ajuste por tramo de peso (curvaGanancia.fraccionado).
// Rango del markup propio de una presentación temporal.
const MARKUP_FRAC_MIN = -99;
const MARKUP_FRAC_MAX = 1000;
const PESO_SIN_DATO_G = 1000; // sin peso en el nombre → se trata como 1 kg
// Tramos de peso (g) de la propuesta de curva Fraccionado cuando la curva guardada no trae los suyos.
const TRAMOS_PESO_DEFAULT = Object.freeze([100, 200, 400, 500, 1000, 5000, 10000]);

// Índice del tramo de peso (tramosG no vacío, ascendente): primer tramo con peso <= tramo; sin peso
// → 1 kg; más pesado que el último → último. Lo usa el ajuste por peso de la curva de ganancia.
function tramoDePeso(pesoG, tramosG) {
  const peso = pesoG > 0 ? pesoG : PESO_SIN_DATO_G;
  const i = tramosG.findIndex(t => peso <= t);
  return i < 0 ? tramosG.length - 1 : i;
}

// Costeo Fraccionado, POR KILO (SIGA guarda el PrecioVenta de Pesables Fraccionado por kg).
// Todas las presentaciones de un granel llevan el mismo costo (el del granel); varía el margen.
// costoKg es NETO; gastos/ivaPct/conceptos como en costearAlmacen.
function costearFraccionado({ plu, nombre, costoKg, markupPct, banda = null, gastos, ivaPct = IVA_DEFAULT_PCT, conceptos = [],
  conceptosFinal = [] } = {}) {
  const faltantes = [];
  const costo = Number(costoKg);
  if (costoKg == null || !Number.isFinite(costo) || costo <= 0) faltantes.push('costoGranel');
  if (typeof markupPct !== 'number' || !Number.isFinite(markupPct)) faltantes.push('markupPct');

  const componentes = [];
  let costoTotal = null;
  let precio = { ...SIN_PRECIO, ivaPct, finalPct: totalConceptosGanancia(conceptosFinal) };
  if (!faltantes.length) {
    costoTotal = redondear2(costo);
    componentes.push({ concepto: 'Granel', detalle: 'costo neto por kg', importe: costoTotal });
    precio = camposPrecio(desglosePrecio({ costo, markupPct, gastos, ivaPct, conceptos, conceptosFinal }));
  }
  return {
    plu, nombre, tipo: 'fraccionado',
    componentes,
    costoTotal, markupPct: Number.isFinite(markupPct) ? markupPct : null, banda,
    ...precio,
    faltantes,
  };
}

// Costos extra por producto (costosExtraFraccionado[plu], compartida por Fraccionado y Almacén):
// cada ítem suma un importe fijo ('kg' = $/kg en Fraccionado, $ por unidad en Almacén — `unidad`
// sólo cambia el rótulo del detalle) o un % del costo base ('pct', siempre sobre el base, nunca
// sobre base + otros extras).
// Sin costo base no hay costo total (mismo criterio "nunca optimista" que el resto).
const COSTOS_EXTRA_MAX_ITEMS = 20;
const COSTOS_EXTRA_RANGO = { kg: [0, 1e6], pct: [-100, 1000] };
const CONCEPTO_MAX = 60;

function aplicarCostosExtra(costoBase, items, unidad = '$/kg') {
  const base = Number(costoBase);
  if (costoBase == null || !Number.isFinite(base)) return { costoTotal: null, componentes: [] };
  const componentes = (Array.isArray(items) ? items : [])
    .filter(it => it && Number.isFinite(it.valor) && (it.tipo === 'kg' || it.tipo === 'pct'))
    .map(it => ({
      concepto: it.concepto,
      detalle: it.tipo === 'kg' ? unidad : `${it.valor}%`,
      importe: redondear2(it.tipo === 'kg' ? it.valor : base * it.valor / 100),
    }));
  return { costoTotal: redondear2(componentes.reduce((s, c) => s + c.importe, base)), componentes };
}

// Validación estricta del body de PUT /api/precios/costos-extra/:plu. Devuelve ítems limpios
// (concepto recortado, sólo claves conocidas) o tira con el índice del ítem inválido.
function validarCostosExtra(items) {
  if (!Array.isArray(items)) throw new Error('items: debe ser una lista');
  if (items.length > COSTOS_EXTRA_MAX_ITEMS) throw new Error(`items: máximo ${COSTOS_EXTRA_MAX_ITEMS} costos extra`);
  return items.map((it, i) => {
    if (!it || typeof it !== 'object') throw new Error(`items[${i}]: ítem inválido`);
    const concepto = typeof it.concepto === 'string' ? it.concepto.trim() : '';
    if (!concepto || concepto.length > CONCEPTO_MAX) throw new Error(`items[${i}].concepto: texto de 1 a ${CONCEPTO_MAX} caracteres`);
    const rango = it.tipo === 'kg' || it.tipo === 'pct' ? COSTOS_EXTRA_RANGO[it.tipo] : null;
    if (!rango) throw new Error(`items[${i}].tipo: debe ser 'kg' o 'pct'`);
    const [min, max] = rango;
    if (typeof it.valor !== 'number' || !Number.isFinite(it.valor) || it.valor < min || it.valor > max) {
      throw new Error(`items[${i}].valor: debe ser un número entre ${min} y ${max}`);
    }
    return { concepto, tipo: it.tipo, valor: it.valor };
  });
}

// Presentación temporal de Fraccionado (simulación sin código en SIGA): { pesoG, gananciaPct, nombre? }.
// gananciaPct = ganancia propia (s/ costo real, reemplaza curva + conceptos); null = standard. parcial (PUT) =
// sólo valida las claves presentes y nombre ''/null significa quitarlo (queda nombre: null en la salida).
const PESO_TEMPORAL_RANGO = [1, 100000];
function validarPresentacionTemporal(body, { parcial = false } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  if (!parcial || 'pesoG' in b) {
    const [min, max] = PESO_TEMPORAL_RANGO;
    if (typeof b.pesoG !== 'number' || !Number.isFinite(b.pesoG) || b.pesoG < min || b.pesoG > max) {
      throw new Error(`pesoG: debe ser un número de ${min} a ${max} gramos`);
    }
    out.pesoG = b.pesoG;
  }
  if (!parcial || 'gananciaPct' in b) {
    const m = b.gananciaPct == null ? null : b.gananciaPct;
    if (m !== null && (typeof m !== 'number' || !Number.isFinite(m) || m < MARKUP_FRAC_MIN || m > MARKUP_FRAC_MAX)) {
      throw new Error(`gananciaPct: debe ser null (standard) o un número entre ${MARKUP_FRAC_MIN} y ${MARKUP_FRAC_MAX}`);
    }
    out.gananciaPct = m;
  }
  if ('nombre' in b) {
    if (b.nombre != null && typeof b.nombre !== 'string') throw new Error(`nombre: debe ser texto de hasta ${CONCEPTO_MAX} caracteres`);
    const nombre = (b.nombre || '').trim();
    if (nombre.length > CONCEPTO_MAX) throw new Error(`nombre: máximo ${CONCEPTO_MAX} caracteres`);
    if (nombre) out.nombre = nombre; else if (parcial) out.nombre = null;
  }
  if (parcial && !Object.keys(out).length) throw new Error('nada para editar: pesoG, gananciaPct o nombre');
  return out;
}

// Costeo Almacén → forma de salida única (la misma en Fraccionado/Producción). costoTotal = costo NETO
// (costoMercaderia + costos extra del producto, ver aplicarCostosExtra, 'kg' = $ fijo por unidad). Sin
// costoMercaderia válido no hay precio: nunca se devuelve un precio "optimista" sobre costo parcial o cero.
// gastos = { variablesPct, departamentosPct } del tipo (sólo para el desglose: markupPct ya es el total);
// ivaPct = IVA de venta (ivaVentaPctDe); conceptos = conceptos de ganancia aplicados (desglose); conceptosFinal =
// conceptos sobre precio final (gross-up). Salida: precioNeto, precioConIva (final, a $50), precioConIvaExacto,
// costoReal, gananciaPct, ivaPct, finalPct (F %), markupFinalPct y desglose.
function costearAlmacen({ costoMercaderia, costosExtra = [], markupPct, banda = null, plu, nombre, gastos, ivaPct = IVA_DEFAULT_PCT, conceptos = [],
  conceptosFinal = [] } = {}) {
  const faltantes = [];
  const costo = Number(costoMercaderia);
  if (costoMercaderia == null || !Number.isFinite(costo)) faltantes.push('costoMercaderia');
  // Sin costo la curva no da ganancia: el faltante real es el costo, no el margen (como en Fraccionado).
  else if (typeof markupPct !== 'number' || !Number.isFinite(markupPct)) faltantes.push('markupPct');

  const componentes = [];
  let costoTotal = null;
  let precio = { ...SIN_PRECIO, ivaPct, finalPct: totalConceptosGanancia(conceptosFinal) };

  if (!faltantes.length) {
    const extra = aplicarCostosExtra(costo, costosExtra, '$');
    costoTotal = redondear2(extra.componentes.reduce((t, c) => t + c.importe, costo));
    componentes.push({ concepto: 'Mercadería', detalle: 'costo neto', importe: redondear2(costo) });
    componentes.push(...extra.componentes);
    precio = camposPrecio(desglosePrecio({ costo: costoTotal, markupPct, gastos, ivaPct, conceptos, conceptosFinal }));
  }

  return {
    plu, nombre, tipo: 'almacen',
    componentes,
    costoTotal, markupPct: Number.isFinite(markupPct) ? markupPct : null, banda,
    ...precio,
    faltantes,
  };
}

// Markup % que lleva el costo neto al precio final: la inversa de costearAlmacen sin el redondeo a $50
// (precio × (1 − F) ÷ (1 + alícuota) ÷ costo − 1; finalPct = F, los conceptos sobre precio final). 6 decimales para
// que recalcular reproduzca el precio al centavo.
function markupParaPrecio(costoTotal, precioConIva, ivaPct = IVA_DEFAULT_PCT, finalPct = 0) {
  if (costoTotal == null || precioConIva == null) return null;
  const c = Number(costoTotal), p = Number(precioConIva), a = Number(ivaPct ?? IVA_DEFAULT_PCT), f = Number(finalPct) || 0;
  if (!Number.isFinite(c) || !Number.isFinite(p) || !Number.isFinite(a) || c <= 0 || p <= 0 || f >= 100) return null;
  return +(((p * (1 - f / 100) / (1 + a / 100) / c) - 1) * 100).toFixed(6);
}

// Migración Parte D (una vez, marcador precioFinalConceptos): mueve de gastosVenta a conceptosPrecioFinal los conceptos
// que se cobran sobre el precio final (IIBB, impuesto débitos/créditos) con su id/concepto/pct. No reescala nada: los
// precios suben un poco a propósito. Sin esos ids la lista queda como estaba (vacía). Devuelve null si ya está
// migrado, o { costeo nuevo, movidos }. Copia nueva, no muta.
const IDS_PRECIO_FINAL = ['ingresos-brutos', 'impuesto-deb-cred'];
const PRECIO_FINAL_MIGRADO = 'conceptos';
function migrarConceptosPrecioFinal(costeo) {
  const c = costeo || {};
  if (c.precioFinalConceptos === PRECIO_FINAL_MIGRADO) return null;
  const gastos = Array.isArray(c.gastosVenta) ? c.gastosVenta : [];
  const mover = g => !!g && IDS_PRECIO_FINAL.includes(g.id);
  const movidos = gastos.filter(mover).map(g => ({ id: g.id, concepto: g.concepto, pct: g.pct }));
  const previos = conceptosPrecioFinalDe(c).filter(p => !movidos.some(m => m.id === p.id));
  return {
    costeo: { ...c, gastosVenta: gastos.filter(g => !mover(g)), conceptosPrecioFinal: [...previos, ...movidos],
      precioFinalConceptos: PRECIO_FINAL_MIGRADO },
    movidos: movidos.length,
  };
}

// Migración única de márgenes propios al costo "tal cual SIGA" sin ×1,21 en la venta. Antes:
// precio = (PrecioCosto ÷ (1 + a)) × (1 + m) × 1,21; ahora: PrecioCosto × (1 + m'). Mismo precio ⇒
// m' = (1 + m) × 1,21 ÷ (1 + a) − 1 (con a = 21 % queda igual). alicuotaDePlu: Map plu → alícuota %
// (la del producto en Almacén, la del granel en Fraccionado; 0 si el costo no cambia, p. ej. manual).
// PLUs fuera del mapa o con alícuota null (→ 21 %) no se tocan. Copia nueva, no muta.
function migrarMargenesBaseCosto(margenPorProducto, alicuotaDePlu) {
  const alicuotas = alicuotaDePlu instanceof Map ? alicuotaDePlu : new Map();
  let ajustados = 0;
  const margenes = Object.fromEntries(Object.entries(margenPorProducto || {}).map(([plu, m]) => {
    const a = alicuotas.get(plu);
    if (!esNumero(m) || !esNumero(a) || a === 21) return [plu, m];
    ajustados++;
    return [plu, +(((1 + m / 100) * IVA_VENTA_ANTERIOR / (1 + a / 100) - 1) * 100).toFixed(6)];
  }));
  return { margenPorProducto: margenes, ajustados };
}

// Aplica la migración sobre costeo.json una sola vez: con baseCosto === 'siga' devuelve null (ya
// migrado); si no, { costeo nuevo con baseCosto 'siga', ajustados }.
const BASE_COSTO_SIGA = 'siga';
function migrarCosteoBaseCosto(costeo, alicuotaDePlu) {
  const c = costeo || {};
  if (c.baseCosto === BASE_COSTO_SIGA) return null;
  const { margenPorProducto, ajustados } = migrarMargenesBaseCosto(c.margenPorProducto, alicuotaDePlu);
  return { costeo: { ...c, margenPorProducto, baseCosto: BASE_COSTO_SIGA }, ajustados };
}

// Diferencia del precio sugerido contra el vigente de SIGA, en % del vigente:
// + = el calculado es más alto (hay que subir el precio), − = más bajo (bajar).
// Dentro de ±toleranciaPct se considera OK (no se resalta).
function compararConVigente(precioSugerido, precioVigente, toleranciaPct) {
  const sug = Number(precioSugerido), vig = Number(precioVigente);
  if (precioSugerido == null || precioVigente == null || !Number.isFinite(sug) || !Number.isFinite(vig) || vig <= 0) {
    return { deltaPct: null, estado: null };
  }
  const deltaPct = +(((sug - vig) / vig) * 100).toFixed(1);
  const tol = Number(toleranciaPct) || 0;
  const estado = Math.abs(deltaPct) <= tol ? 'ok' : deltaPct > 0 ? 'subir' : 'bajar';
  return { deltaPct, estado };
}

// Costo de la factura cargada hoy contra la compra anterior (deltaPct en % de la anterior):
// 'sube' / 'baja' fuera de ±toleranciaPct (la global del módulo), 'igual' dentro (borde incluido),
// 'sin-anterior' si no hubo compra previa con qué comparar.
function tendenciaCompraHoy(deltaPct, toleranciaPct) {
  if (deltaPct == null || !Number.isFinite(Number(deltaPct))) return 'sin-anterior';
  const d = Number(deltaPct), tol = Number(toleranciaPct) || 0;
  return Math.abs(d) <= tol ? 'igual' : d > 0 ? 'sube' : 'baja';
}

// Costo base de un producto (Almacén) o de un granel (Fraccionado), por prioridad:
// manual (cfg.costoPorProducto[plu], > 0, se toma como neto) → última compra (PrecioNeto del comprobante)
// si el producto eligió esa fuente (cfg.fuenteCosto[plu] === 'ultimaCompra') → costo de sistema SIGA neto (default).
// Si la fuente elegida no tiene dato, costoBase es null: nunca se cae a otra fuente en silencio.
function elegirCosto({ plu, costoUltimaCompra = null, costoSistema = null, cfg } = {}) {
  const c = cfg || {};
  const manual = plu != null ? (c.costoPorProducto || {})[plu] : undefined;
  const costoOverride = typeof manual === 'number' && Number.isFinite(manual) && manual > 0 ? manual : null;
  const costoFuente = costoOverride != null ? 'manual'
    : plu != null && (c.fuenteCosto || {})[plu] === 'ultimaCompra' ? 'ultimaCompra' : 'sistema';
  const costoBase = costoFuente === 'manual' ? costoOverride
    : costoFuente === 'ultimaCompra' ? costoUltimaCompra : costoSistema;
  return { costoBase: costoBase != null ? costoBase : null, costoFuente, costoOverride };
}

// ── Gastos sobre venta (esquema del Excel viejo) ─────────────────────────────
// Las curvas de ganancia (Reventa, Fraccionado, Producción) guardan GANANCIA; el markup total
// sale de la fórmula exacta markup = (1 + ganancia) / (1 − gastosVenta) − 1, con el total de gastos
// de la lista (y los departamentos del tipo). Los márgenes propios por producto también son ganancia (Parte C).
// Con gastos 0 es la identidad.
// Hoy sólo existe la lista 'sucursal'; cada gasto la guarda igual para no migrar el día que haya más.
const LISTAS_GASTOS = ['sucursal'];
const GASTOS_MAX_ITEMS = 40;
const ID_GASTO = /^[a-z0-9-]{1,40}$/;
const redondear4 = n => Math.round(n * 1e4) / 1e4;

function totalGastosVenta(gastos, lista = 'sucursal') {
  if (!Array.isArray(gastos)) return 0;
  const total = gastos
    .filter(g => g && Array.isArray(g.listas) && g.listas.includes(lista) && Number.isFinite(g.pct))
    .reduce((s, g) => s + g.pct, 0);
  return redondear4(total);
}

// 6 decimales (como markupParaPrecio). Gastos 0 devuelve la ganancia tal cual: identidad exacta,
// sin ruido de punto flotante, para que sin gastos los precios sean idénticos a los de antes.
// gastosPct null = gastos desconocidos (gastosVentaPctTipo sin venta base, ver lib/precios_costos) →
// null: nunca un markup optimista. undefined sigue siendo 0.
function markupDesdeGanancia(gananciaPct, gastosPct) {
  const gastos = Number(gastosPct) || 0;
  if (gastosPct === null || typeof gananciaPct !== 'number' || !Number.isFinite(gananciaPct) || gastos >= 100) return null;
  if (gastos === 0) return gananciaPct;
  return +(((1 + gananciaPct / 100) / (1 - gastos / 100) - 1) * 100).toFixed(6);
}

function gananciaDesdeMarkup(markupPct, gastosPct) {
  const gastos = Number(gastosPct) || 0;
  if (gastosPct === null || typeof markupPct !== 'number' || !Number.isFinite(markupPct) || gastos >= 100) return null;
  if (gastos === 0) return markupPct;
  return +(((1 + markupPct / 100) * (1 - gastos / 100) - 1) * 100).toFixed(6);
}

const slugGasto = concepto => String(concepto).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'gasto';

function validarItemGasto(it, i) {
  if (!it || typeof it !== 'object') throw new Error(`items[${i}]: ítem inválido`);
  const concepto = typeof it.concepto === 'string' ? it.concepto.trim() : '';
  if (!concepto || concepto.length > CONCEPTO_MAX) throw new Error(`items[${i}].concepto: texto de 1 a ${CONCEPTO_MAX} caracteres`);
  if (typeof it.pct !== 'number' || !Number.isFinite(it.pct) || it.pct < 0 || it.pct > 100) {
    throw new Error(`items[${i}].pct: debe ser un número entre 0 y 100`);
  }
  const listas = it.listas == null ? [...LISTAS_GASTOS] : it.listas;
  if (!Array.isArray(listas) || !listas.length || !listas.every(l => LISTAS_GASTOS.includes(l))) {
    throw new Error(`items[${i}].listas: debe ser una lista no vacía de ${LISTAS_GASTOS.join(', ')}`);
  }
  if (it.id != null && (typeof it.id !== 'string' || !ID_GASTO.test(it.id))) {
    throw new Error(`items[${i}].id: minúsculas, números y guiones (1 a 40)`);
  }
  return { id: it.id == null ? null : it.id, concepto, pct: it.pct, listas: [...new Set(listas)] };
}

// Ítems ya validados con id (string) o null: sin id se genera el slug de textoDe(ítem) con sufijo -2,
// -3... si ya existe; un id explícito repetido es error. Compartido con departamentos (lib/precios_costos).
function asignarIds(limpios, textoDe) {
  const explicitos = limpios.filter(g => g.id).map(g => g.id);
  const repetido = explicitos.find((id, i) => explicitos.indexOf(id) !== i);
  if (repetido) throw new Error(`items: id "${repetido}" repetido`);
  const usados = new Set(explicitos);
  return limpios.map(g => {
    if (g.id) return g;
    const base = slugGasto(textoDe(g));
    let id = base;
    for (let n = 2; usados.has(id); n++) id = `${base}-${n}`;
    usados.add(id);
    return { ...g, id };
  });
}

// Body de PUT /api/precios/config/gastos-venta → [{ id, concepto, pct, listas }]. Sin id se genera el
// slug del concepto (con sufijo -2, -3... si ya existe); un id explícito repetido es error.
function validarGastosVenta(items) {
  if (!Array.isArray(items)) throw new Error('items: debe ser una lista');
  if (items.length > GASTOS_MAX_ITEMS) throw new Error(`items: máximo ${GASTOS_MAX_ITEMS} gastos`);
  const lista = asignarIds(items.map(validarItemGasto), g => g.concepto);
  for (const l of LISTAS_GASTOS) {
    if (totalGastosVenta(lista, l) >= 100) throw new Error(`items: el total de gastos de la lista ${l} debe ser menor a 100 %`);
  }
  return lista;
}

// Al cambiar los gastos, reescala las curvas de ganancia para que el precio no cambie. Con g = curva + K (K =
// conceptos de ganancia, que NO se reescalan): (1 + g')/(1 − gastosNuevo) = (1 + g)/(1 − gastosViejo) ⇒
// 1 + curva' + K = k(1 + curva + K), k = (1 − gastosNuevo)/(1 − gastosViejo) ⇒ curva' = k(1 + curva + K) − 1 − K
// (ver escalarCurva). Es una transformación afín creciente de la curva (k > 0): conmuta con el clamp y con el
// ajuste por peso, así que la igualdad es exacta para todo costo también con conceptos ≠ 0; la única
// aproximación es el redondeo a 4 decimales de a, b, piso, techo y ajustes (y fallar si piso/techo salen de
// rango). gastosViejo/gastosNuevo: un número (mismo % para los tres tipos) o { almacen, fraccionado, produccion }
// (gastosPorTipo de lib/precios_costos); cada tipo reescala su curva. Un tipo con gastos null (desconocidos) no se
// toca. Copia nueva, no muta costeo.
const TIPOS_GANANCIA = ['almacen', 'fraccionado', 'produccion'];
function factoresPorTipo(gastosViejo, gastosNuevo) {
  const porTipo = v => (v && typeof v === 'object' ? v
    : Object.fromEntries(TIPOS_GANANCIA.map(t => [t, Number(v) || 0])));
  const viejo = porTipo(gastosViejo), nuevo = porTipo(gastosNuevo);
  return Object.fromEntries(TIPOS_GANANCIA.map(t => {
    const v = viejo[t], n = nuevo[t];
    if (v == null || n == null || v === n) return [t, null];
    return [t, (1 - n / 100) / (1 - v / 100)];
  }));
}

function reescalarGanancias(costeo, gastosViejo, gastosNuevo) {
  const factores = factoresPorTipo(gastosViejo, gastosNuevo);
  const cg = costeo.curvaGanancia;
  if (Object.values(factores).every(f => f == null) || !cg || typeof cg !== 'object') return costeo;
  const K = totalConceptosGanancia(costeo.conceptosGanancia);
  const ganancia = factor => v => (Number.isFinite(v) ? redondear4(((1 + (v + K) / 100) * factor - 1) * 100 - K) : v);
  return {
    ...costeo,
    curvaGanancia: Object.fromEntries(Object.entries(cg).map(([tipo, c]) => [tipo,
      factores[tipo] != null ? escalarCurva(c, factores[tipo], ganancia(factores[tipo])) : c])),
  };
}

// Mismo reescalado para las ganancias propias (reemplazan curva + conceptos: 1 + g' = k(1 + g)): margenPorProducto
// (tipo de cada PLU con tipoDePlu, default Reventa) y presentaciones temporales (Fraccionado). Copia nueva.
function reescalarGananciasPropias(costeo, gastosViejo, gastosNuevo, tipoDePlu = () => 'almacen') {
  const f = factoresPorTipo(gastosViejo, gastosNuevo);
  const escalar = (v, k) => (k != null && Number.isFinite(v) ? +(((1 + v / 100) * k - 1) * 100).toFixed(6) : v);
  const margen = Object.fromEntries(Object.entries(costeo.margenPorProducto || {})
    .map(([plu, v]) => [plu, escalar(v, f[tipoDePlu(plu) || 'almacen'])]));
  const temporales = Object.fromEntries(Object.entries(costeo.presentacionesTemporales || {})
    .map(([g, lista]) => [g, (Array.isArray(lista) ? lista : []).map(t => ({ ...t, gananciaPct: t.gananciaPct == null ? t.gananciaPct : escalar(t.gananciaPct, f.fraccionado) }))]));
  return {
    ...costeo,
    ...(costeo.margenPorProducto ? { margenPorProducto: margen } : {}),
    ...(costeo.presentacionesTemporales ? { presentacionesTemporales: temporales } : {}),
  };
}

// Migración de márgenes propios (spec Parte C): antes eran markup total s/ costo neto (precio neto = C(1 + m)),
// ahora son ganancia s/ costo real (reemplaza curva + conceptos). Mismo precio ⇒ g = (1 + m)(1 − G_T) − 1 con el
// G del tipo de cada PLU (tipoDePlu; default Reventa). Temporales: markupPct → gananciaPct con G Fraccionado.
// Un tipo con G null (falta venta base) deja el valor como estaba (esos precios no salen igual: faltante).
// Idempotente con el marcador margenPropio === 'ganancia': devuelve null si ya está migrado.
const MARGEN_PROPIO_GANANCIA = 'ganancia';
function migrarMargenesAGanancia(costeo, gastosPorTipo, tipoDePlu = () => 'almacen') {
  const c = costeo || {};
  if (c.margenPropio === MARGEN_PROPIO_GANANCIA) return null;
  let ajustados = 0;
  const conv = (m, tipo) => {
    const g = gananciaDesdeMarkup(m, gastosPorTipo[tipo] ?? null);
    if (g == null) return m;
    ajustados++;
    return g;
  };
  const margenPorProducto = Object.fromEntries(Object.entries(c.margenPorProducto || {})
    .map(([plu, m]) => [plu, esNumero(m) ? conv(m, tipoDePlu(plu) || 'almacen') : m]));
  const presentacionesTemporales = Object.fromEntries(Object.entries(c.presentacionesTemporales || {})
    .map(([g, lista]) => [g, (Array.isArray(lista) ? lista : []).map(t => {
      if (!t || !('markupPct' in t)) return t;
      const { markupPct, ...resto } = t;
      return { ...resto, gananciaPct: esNumero(markupPct) ? conv(markupPct, 'fraccionado') : null };
    })]));
  return {
    costeo: { ...c, margenPorProducto, presentacionesTemporales, margenPropio: MARGEN_PROPIO_GANANCIA },
    ajustados,
  };
}

// 1 + g' = k(1 + g) aplicado a la curva: los niveles (a, piso, techo) con `nivel` (que incluye los conceptos),
// b' = k·b y cada ajuste por peso ×k. Exacto porque el clamp es monótono y k > 0.
function escalarCurva(c, k, nivel) {
  if (!c || typeof c !== 'object') return c;
  const por = v => (Number.isFinite(v) ? redondear4(k * v) : v);
  const aj = c.ajustesPeso;
  return {
    ...c, a: nivel(c.a), b: por(c.b), pisoPct: nivel(c.pisoPct), techoPct: nivel(c.techoPct),
    ...(aj && Array.isArray(aj.puntos) ? { ajustesPeso: { ...aj, puntos: aj.puntos.map(por) } } : {}),
  };
}

// ── Curva de ganancia según costo ────────────────────────────────────────────
// ganancia(c) = clamp(a − b·ln c, piso, techo) [+ ajuste del tramo de peso en Fraccionado]: a más costo,
// menos ganancia. Es GANANCIA: el markup total sale de markupDesdeGanancia. Único método standard de los tres
// tipos (spec 2026-10-02 Parte B: reemplazó bandas y matriz; siempre aplica, el margen propio por producto la
// pisa). El costo del eje es el NETO. Se ajusta desde los precios vigentes de SIGA.
const TIPOS_CURVA = ['almacen', 'fraccionado', 'produccion'];
const CURVA_RANGO_PCT = [-50, 300];
const AJUSTE_PESO_RANGO = [-100, 100];
const AJUSTES_PESO_MAX = 20;
const CURVA_MIN_PUNTOS = 20;
const CURVA_BINS = 20;
const MUESTRA_MAX = 1500;
const CURVA_BASE = { a: 0, b: 0, pisoPct: 0, techoPct: 100, ajustadaEl: null, n: null };
const CURVA_GANANCIA_DEFAULT = Object.freeze({
  almacen: Object.freeze({ ...CURVA_BASE }),
  fraccionado: Object.freeze({ ...CURVA_BASE, ajustesPeso: null }),
  produccion: Object.freeze({ ...CURVA_BASE }),
});

// Las tres curvas con sus defaults; `activa` (interruptor viejo) se descarta.
function curvasGananciaConDefault(cg) {
  const c = cg && typeof cg === 'object' ? cg : {};
  const de = tipo => { const { activa: _sinUso, ...resto } = c[tipo] || {}; return { ...CURVA_GANANCIA_DEFAULT[tipo], ...resto }; };
  return Object.fromEntries(TIPOS_CURVA.map(t => [t, de(t)]));
}

const esNumero = v => typeof v === 'number' && Number.isFinite(v);

// clamp(a − b·ln c, piso, techo) sin ajustes por peso (lo usan el ajuste y los residuos).
function gananciaBaseCurva(curva, costo) {
  const c = Number(costo);
  if (!curva || costo == null || !Number.isFinite(c) || c <= 0) return null;
  const { a, b, pisoPct, techoPct } = curva;
  if (![a, b, pisoPct, techoPct].every(esNumero) || pisoPct > techoPct) return null;
  return Math.min(techoPct, Math.max(pisoPct, a - b * Math.log(c)));
}

// Ganancia standard por curva (6 dec) sobre el costo neto, o null si la curva es inválida o no hay costo. Con
// ajustesPeso suma el ajuste del tramo de la presentación (tramoDePeso), después del clamp.
function gananciaPorCurva(curva, costo, pesoG = null) {
  const base = gananciaBaseCurva(curva, costo);
  if (base == null) return null;
  const aj = curva.ajustesPeso;
  const ajuste = aj && Array.isArray(aj.tramosG) && aj.tramosG.length && Array.isArray(aj.puntos)
    ? Number(aj.puntos[tramoDePeso(pesoG, aj.tramosG)]) || 0 : 0;
  return +(base + ajuste).toFixed(6);
}

const mediana = xs => {
  const s = [...xs].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const puntoCurvaValido = p => !!p && esNumero(p.costo) && p.costo > 0 && esNumero(p.ganancia)
  && p.ganancia >= CURVA_RANGO_PCT[0] && p.ganancia <= CURVA_RANGO_PCT[1];

// Hasta CURVA_BINS bins de igual cantidad ordenados por ln(costo): mediana de ln(costo) y de ganancia.
function binsPorCosto(puntos) {
  const orden = puntos.map(p => ({ x: Math.log(p.costo), g: p.ganancia })).sort((p, q) => p.x - q.x);
  const n = orden.length, k = Math.min(CURVA_BINS, n);
  return Array.from({ length: k }, (_, i) => orden.slice(Math.floor(i * n / k), Math.floor((i + 1) * n / k)))
    .map(bin => ({ x: mediana(bin.map(p => p.x)), g: mediana(bin.map(p => p.g)), n: bin.length }));
}

// Mínimos cuadrados ponderados por cantidad g = a − b·x sobre las medianas; r² ponderado.
function regresionBins(bins) {
  const W = bins.reduce((s, q) => s + q.n, 0);
  const mx = bins.reduce((s, q) => s + q.n * q.x, 0) / W;
  const mg = bins.reduce((s, q) => s + q.n * q.g, 0) / W;
  const sxx = bins.reduce((s, q) => s + q.n * (q.x - mx) ** 2, 0);
  const sxg = bins.reduce((s, q) => s + q.n * (q.x - mx) * (q.g - mg), 0);
  const pend = sxx > 0 ? sxg / sxx : 0;
  const a = mg - pend * mx;
  const ssTot = bins.reduce((s, q) => s + q.n * (q.g - mg) ** 2, 0);
  const ssRes = bins.reduce((s, q) => s + q.n * (q.g - (a + pend * q.x)) ** 2, 0);
  return { a, b: -pend, r2: ssTot > 0 ? 1 - ssRes / ssTot : 1 };
}

// Ajuste robusto de la curva: puntos [{ costo, ganancia }] (descarta costo ≤ 0 y ganancia fuera de
// rango); piso/techo = mín/máx de las medianas de los bins. Menos de CURVA_MIN_PUNTOS → throw.
function ajustarCurva(puntos) {
  const validos = (Array.isArray(puntos) ? puntos : []).filter(puntoCurvaValido);
  if (validos.length < CURVA_MIN_PUNTOS) {
    throw new Error(`pocos datos para ajustar la curva: ${validos.length} (mínimo ${CURVA_MIN_PUNTOS})`);
  }
  const bins = binsPorCosto(validos);
  const { a, b, r2 } = regresionBins(bins);
  const gs = bins.map(q => q.g);
  return {
    a: redondear4(a), b: redondear4(b), pisoPct: redondear2(Math.min(...gs)), techoPct: redondear2(Math.max(...gs)),
    n: validos.length, bins: bins.map(q => ({ costo: redondear2(Math.exp(q.x)), ganancia: redondear2(q.g), n: q.n })),
    r2: redondear4(r2),
  };
}

// Ajuste por peso: mediana del residuo (ganancia − curva sin ajuste) de los puntos de cada tramo,
// 1 decimal, acotada a AJUSTE_PESO_RANGO; tramo sin puntos → 0.
function ajustesPorPeso(puntos, curva, tramosG) {
  const tramos = Array.isArray(tramosG) ? tramosG : [];
  const residuos = tramos.map(() => []);
  for (const p of Array.isArray(puntos) ? puntos : []) {
    const base = tramos.length && puntoCurvaValido(p) ? gananciaBaseCurva(curva, p.costo) : null;
    if (base != null) residuos[tramoDePeso(p.pesoG, tramos)].push(p.ganancia - base);
  }
  const [min, max] = AJUSTE_PESO_RANGO;
  const ajuste = r => Math.min(max, Math.max(min, Math.round(mediana(r) * 10) / 10)) || 0; // || 0: sin −0
  return { tramosG: [...tramos], puntos: residuos.map(r => (r.length ? ajuste(r) : 0)) };
}

function validarAjustesPeso(aj, n) {
  if (aj == null) return null;
  if (typeof aj !== 'object') throw new Error(`${n}.ajustesPeso: debe ser { tramosG, puntos } o null`);
  const { tramosG, puntos } = aj;
  if (!Array.isArray(tramosG) || !tramosG.length || tramosG.length > AJUSTES_PESO_MAX) {
    throw new Error(`${n}.ajustesPeso.tramosG: lista de 1 a ${AJUSTES_PESO_MAX} pesos`);
  }
  tramosG.forEach((t, i) => {
    if (!esNumero(t) || t <= 0) throw new Error(`${n}.ajustesPeso.tramosG[${i}]: debe ser un peso positivo en gramos`);
    if (i > 0 && t <= tramosG[i - 1]) throw new Error(`${n}.ajustesPeso.tramosG[${i}]: los tramos deben ser ascendentes`);
  });
  const [min, max] = AJUSTE_PESO_RANGO;
  if (!Array.isArray(puntos) || puntos.length !== tramosG.length) {
    throw new Error(`${n}.ajustesPeso.puntos: debe tener ${tramosG.length} valores (uno por tramo)`);
  }
  puntos.forEach((v, i) => {
    if (!esNumero(v) || v < min || v > max) throw new Error(`${n}.ajustesPeso.puntos[${i}]: debe ser un número entre ${min} y ${max}`);
  });
  return { tramosG: [...tramosG], puntos: [...puntos] };
}

// Body de PUT /api/precios/config/curva-ganancia/:tipo → curva limpia (sólo claves conocidas) o throw.
// b puede ser 0 (curva plana, piso = techo permitido) o negativo (la UI avisa). ajustesPeso sólo existe en
// Fraccionado. `activa` (interruptor viejo) se ignora: la curva siempre aplica.
function validarCurvaGanancia(c, tipo) {
  if (!TIPOS_CURVA.includes(tipo)) throw new Error(`curvaGanancia: tipo inválido (${TIPOS_CURVA.join(', ')})`);
  const n = `curvaGanancia.${tipo}`;
  if (!c || typeof c !== 'object') throw new Error(`${n}: debe ser un objeto { a, b, pisoPct, techoPct }`);
  for (const k of ['a', 'b']) if (!esNumero(c[k])) throw new Error(`${n}.${k}: debe ser un número`);
  const [min, max] = CURVA_RANGO_PCT;
  for (const k of ['pisoPct', 'techoPct']) {
    if (!esNumero(c[k]) || c[k] < min || c[k] > max) throw new Error(`${n}.${k}: debe ser un número entre ${min} y ${max}`);
  }
  if (c.pisoPct > c.techoPct) throw new Error(`${n}: pisoPct no puede ser mayor a techoPct`);
  if (c.ajustadaEl != null && (typeof c.ajustadaEl !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(c.ajustadaEl))) {
    throw new Error(`${n}.ajustadaEl: fecha AAAA-MM-DD o null`);
  }
  if (c.n != null && (!Number.isInteger(c.n) || c.n < 0)) throw new Error(`${n}.n: entero ≥ 0 o null`);
  const limpia = {
    a: c.a, b: c.b, pisoPct: c.pisoPct, techoPct: c.techoPct,
    ajustadaEl: c.ajustadaEl ?? null, n: c.n ?? null,
  };
  return tipo === 'fraccionado' ? { ...limpia, ajustesPeso: validarAjustesPeso(c.ajustesPeso, n) } : limpia;
}

// Puntos para ajustar la curva desde SIGA: la ganancia implícita es la que, con los gastos actuales,
// reproduce el precio vigente (× (1 − F) ÷ (1 + IVA de venta)) con el costo neto total, menos los conceptos de
// ganancia (la curva es la parte de la ganancia que no son conceptos); el costo del eje es el base neto.
const gananciaImplicita = (costoTotal, precioVigente, gastosPct, ivaPct, conceptosPct = 0, finalPct = 0) => {
  const g = gananciaDesdeMarkup(markupParaPrecio(costoTotal, precioVigente, ivaPct, finalPct), gastosPct);
  return g == null ? null : +(g - conceptosPct).toFixed(6);
};

// Reventa y Producción: filas { costoBase, costoTotal, precioVigente, ivaPct, finalPct } (Producción: costo por unidad).
function puntosCurvaAlmacen(filas, gastosPct, conceptosPct = 0) {
  return (filas || []).filter(f => f && f.costoBase > 0 && f.costoTotal > 0 && f.precioVigente > 0)
    .map(f => ({ costo: f.costoBase, ganancia: gananciaImplicita(f.costoTotal, f.precioVigente, gastosPct, f.ivaPct, conceptosPct, f.finalPct) }));
}

// Fraccionado: una por presentación real con vigente; costo = base neto del granel, ganancia con su
// costoKg (granel + extras + MO + insumos).
function puntosCurvaFraccionado(grupos, gastosPct, conceptosPct = 0) {
  return (grupos || []).flatMap(g => (g && g.costoBase > 0 ? g.presentaciones || [] : [])
    .filter(p => p.costoKg > 0 && p.precioVigente > 0)
    .map(p => ({ costo: g.costoBase, ganancia: gananciaImplicita(p.costoKg, p.precioVigente, gastosPct, p.ivaPct, conceptosPct, p.finalPct), pesoG: p.pesoG })));
}

// Muestra para el gráfico: hasta MUESTRA_MAX puntos válidos, tomados a paso fijo (determinística).
function muestraCurva(puntos) {
  const v = puntos.filter(puntoCurvaValido);
  const paso = Math.max(1, v.length / MUESTRA_MAX);
  return Array.from({ length: Math.min(v.length, MUESTRA_MAX) }, (_, i) => v[Math.floor(i * paso)])
    .map(p => ({ costo: redondear2(p.costo), ganancia: redondear2(p.ganancia) }));
}

// Respuesta de POST /api/precios/curva-ganancia/ajustar/:tipo (no guarda nada). Almacén: filas de
// filasAlmacen; Producción: filas por presentación (mismo shape); Fraccionado: grupos de armarGruposFraccionado
// + tramosG de la curva guardada (TRAMOS_PESO_DEFAULT si no tiene).
function propuestaCurva(tipo, filasOGrupos, { gastosPct = 0, tramosG = [], conceptosPct = 0 } = {}) {
  const puntos = tipo === 'fraccionado' ? puntosCurvaFraccionado(filasOGrupos, gastosPct, conceptosPct)
    : puntosCurvaAlmacen(filasOGrupos, gastosPct, conceptosPct);
  const curva = ajustarCurva(puntos);
  const extra = tipo === 'fraccionado' ? { ajustesPeso: ajustesPorPeso(puntos, curva, tramosG) } : {};
  return { ...curva, ...extra, muestra: muestraCurva(puntos) };
}

module.exports = { IVA_DEFAULT_PCT, ivaVentaPctDe, validarIvaVentaPct, conceptosGananciaDe, totalConceptosGanancia, gananciaStandard,
  conceptosPrecioFinalDe, validarConceptosPrecioFinal, migrarConceptosPrecioFinal, PRECIO_FINAL_MIGRADO,
  validarConceptosGanancia, reescalarGananciasPropias, migrarMargenesAGanancia, MARGEN_PROPIO_GANANCIA,
  desglosePrecio, markupFinalPct, camposPrecio, SIN_PRECIO,
  redondear2, elegirCosto, compararConVigente, tendenciaCompraHoy, markupParaPrecio, aplicarMarkup, redondearPrecioVenta, costearAlmacen,
  costearFraccionado, aplicarCostosExtra, validarCostosExtra, validarPresentacionTemporal, TRAMOS_PESO_DEFAULT,
  totalGastosVenta, markupDesdeGanancia, gananciaDesdeMarkup, validarGastosVenta, reescalarGanancias, asignarIds, ID_GASTO,
  TIPOS_CURVA, CURVA_GANANCIA_DEFAULT, curvasGananciaConDefault, gananciaPorCurva, gananciaBaseCurva, ajustarCurva, ajustesPorPeso,
  validarCurvaGanancia, propuestaCurva, migrarMargenesBaseCosto, migrarCosteoBaseCosto, BASE_COSTO_SIGA, mediana };
