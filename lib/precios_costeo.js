'use strict';
// Módulo puro de costeo — Precios. Sin fs/SQL/Express, todo se inyecta por parámetros.
// Fase 1: Almacén. Fase 2: Fraccionado (costo del granel × margen por costo y presentación).
// Producción llega en una fase futura, con el mismo shape de salida que costearAlmacen (ver abajo).

const IVA = 1.21; // 21% fijo, hardcodeado — no es config ni parámetro (decisión de negocio).

// Banda que corresponde a un costo: la primera de `bandas` (ordenadas asc por costoHastaARS,
// donde costoHastaARS:null = sin tope) cuyo tope sea >= costo. overridePct, si es un número,
// gana siempre sin mirar costo/bandas.
function resolverBanda(costo, bandas, overridePct) {
  if (typeof overridePct === 'number' && Number.isFinite(overridePct)) {
    return { markupPct: overridePct, banda: 'override' };
  }
  const c = Number(costo);
  for (const b of (Array.isArray(bandas) ? bandas : [])) {
    if (b.costoHastaARS === null || c <= b.costoHastaARS) {
      return {
        markupPct: b.markupMaxPct,
        banda: b.costoHastaARS === null ? 'sin tope' : `hasta ${b.costoHastaARS}`,
      };
    }
  }
  return { markupPct: null, banda: null };
}

function markupDe(costo, bandas, overridePct) {
  return resolverBanda(costo, bandas, overridePct).markupPct;
}

// Redondeo de plata a 2 decimales (convención ARS) — mismo patrón que redondear() en compras.js:
// sin esto, costo*pct/100 y aplicarMarkup dejan ruido de punto flotante (ej 24.999750000000002)
// que no debe llegar a una UI de precios.
function redondear2(n) {
  return Math.round(n * 100) / 100;
}

// Precio de venta final: múltiplo de 50 más cercano, sin decimales (regla comercial; el
// generador Excel hacía lo mismo con MROUND, a 10). Sólo para el precio con IVA — costos
// y neto siguen a 2 decimales.
const PASO_PRECIO_VENTA = 50;
function redondearPrecioVenta(n) {
  return Math.round(n / PASO_PRECIO_VENTA) * PASO_PRECIO_VENTA;
}

function aplicarMarkup(costo, markupPct) {
  return costo * (1 + markupPct / 100);
}

function conIva(precioNeto) {
  return precioNeto * IVA;
}

// Una banda es inválida si: costoHastaARS no es number ni null, null aparece antes del final
// (deja de significar "sin tope"), el array no está ordenado ascendente por costoHastaARS, o
// markupMaxPct crece a medida que sube el costo (a mayor costo el markup tiene que ser igual
// o menor, nunca mayor). Rechaza fuerte con throw — mismo patrón que insumos.js: que se vea,
// no que se filtre en silencio como familiasSanitizadas hace con datos "blandos".
function validarBandas(bandas, tipo) {
  const lista = Array.isArray(bandas) ? bandas : [];
  let anterior = null;
  lista.forEach((b, i) => {
    if (!b || typeof b !== 'object') throw new Error(`bandasMarkup.${tipo}[${i}]: banda inválida`);
    const { costoHastaARS, markupMaxPct } = b;
    if (costoHastaARS !== null && !Number.isFinite(costoHastaARS)) {
      throw new Error(`bandasMarkup.${tipo}[${i}]: costoHastaARS inválido`);
    }
    if (costoHastaARS === null && i !== lista.length - 1) {
      throw new Error(`bandasMarkup.${tipo}[${i}]: costoHastaARS:null (sin tope) sólo puede ir en la última banda`);
    }
    if (!Number.isFinite(markupMaxPct)) {
      throw new Error(`bandasMarkup.${tipo}[${i}]: markupMaxPct inválido`);
    }
    if (anterior) {
      if (anterior.costoHastaARS !== null && costoHastaARS !== null && costoHastaARS < anterior.costoHastaARS) {
        throw new Error(`bandasMarkup.${tipo}[${i}]: bandas desordenadas, costoHastaARS debe ser ascendente`);
      }
      if (markupMaxPct > anterior.markupMaxPct) {
        throw new Error(`bandasMarkup.${tipo}[${i}]: markupMaxPct no puede ser mayor al de la banda anterior`);
      }
    }
    anterior = { costoHastaARS, markupMaxPct };
  });
  return lista;
}

// Espejo de familiasSanitizadas() en familias_manuales.js: versión limpia de la config para
// guardar/servir. A diferencia de esa, acá "limpio" no es tolerar y filtrar basura sino
// rechazar bandas mal armadas (ver validarBandas) — un markup mal ordenado calcula precios
// mal para todo el catálogo, no es un dato descartable.
function configSanitizada(config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const bandasIn = cfg.bandasMarkup && typeof cfg.bandasMarkup === 'object' ? cfg.bandasMarkup : {};
  return {
    ...cfg,
    bandasMarkup: {
      almacen: validarBandas(bandasIn.almacen, 'almacen'),
      fraccionado: validarBandas(bandasIn.fraccionado, 'fraccionado'),
      produccion: validarBandas(bandasIn.produccion, 'produccion'),
    },
  };
}

// ── Fraccionado ──────────────────────────────────────────────────────────────
// markupFraccionado = { bandas: [costoHasta..., null], tramosG: [...], markupPct: [fila][col] }:
// filas = bandas de costo del granel ($/kg), columnas = tramos de peso de la presentación (g).
// No se exige monotonía (el Excel sube y baja por decisión comercial).
const MARKUP_FRAC_MIN = -99;
const MARKUP_FRAC_MAX = 1000;
const PESO_SIN_DATO_G = 1000; // sin peso en el nombre → se trata como 1 kg

function validarMarkupFraccionado(m) {
  const n = 'markupFraccionado';
  if (!m || typeof m !== 'object') throw new Error(`${n}: debe ser un objeto { bandas, tramosG, markupPct }`);
  const { bandas, tramosG, markupPct } = m;
  if (!Array.isArray(bandas) || !bandas.length) throw new Error(`${n}.bandas: debe ser una lista no vacía`);
  bandas.forEach((b, i) => {
    if (b === null) {
      if (i !== bandas.length - 1) throw new Error(`${n}.bandas[${i}]: "sin tope" (null) sólo puede ser la última banda`);
      return;
    }
    if (typeof b !== 'number' || !Number.isFinite(b) || b <= 0) throw new Error(`${n}.bandas[${i}]: debe ser un costo positivo o null (sin tope)`);
    if (i > 0 && b <= bandas[i - 1]) throw new Error(`${n}.bandas[${i}]: las bandas deben ser ascendentes`);
  });
  if (!Array.isArray(tramosG) || !tramosG.length) throw new Error(`${n}.tramosG: debe ser una lista no vacía`);
  tramosG.forEach((t, i) => {
    if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) throw new Error(`${n}.tramosG[${i}]: debe ser un peso positivo en gramos`);
    if (i > 0 && t <= tramosG[i - 1]) throw new Error(`${n}.tramosG[${i}]: los tramos deben ser ascendentes`);
  });
  if (!Array.isArray(markupPct) || markupPct.length !== bandas.length) {
    throw new Error(`${n}.markupPct: debe tener ${bandas.length} filas (una por banda)`);
  }
  markupPct.forEach((fila, i) => {
    if (!Array.isArray(fila) || fila.length !== tramosG.length) {
      throw new Error(`${n}.markupPct[${i}]: debe tener ${tramosG.length} valores (uno por tramo)`);
    }
    fila.forEach((v, j) => {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < MARKUP_FRAC_MIN || v > MARKUP_FRAC_MAX) {
        throw new Error(`${n}.markupPct[${i}][${j}]: debe ser un número entre ${MARKUP_FRAC_MIN} y ${MARKUP_FRAC_MAX}`);
      }
    });
  });
  return m;
}

// Margen standard de una presentación: fila = primera banda con costoKg <= tope (null = sin
// tope); col = primer tramo con pesoG <= tramo (más pesado que el último → última col).
// Sin costo o sin matriz utilizable → todo null (la fila queda con faltante, no con un margen inventado).
function markupStdFraccionado(costoKg, pesoG, matriz) {
  const nada = { markupPct: null, fila: null, col: null };
  const c = Number(costoKg);
  if (costoKg == null || !Number.isFinite(c) || c <= 0 || !matriz) return nada;
  const bandas = Array.isArray(matriz.bandas) ? matriz.bandas : [];
  const tramos = Array.isArray(matriz.tramosG) ? matriz.tramosG : [];
  const fila = bandas.findIndex(b => b === null || c <= b);
  if (fila < 0 || !tramos.length) return nada;
  const peso = pesoG > 0 ? pesoG : PESO_SIN_DATO_G;
  const i = tramos.findIndex(t => peso <= t);
  const col = i < 0 ? tramos.length - 1 : i;
  const v = ((matriz.markupPct || [])[fila] || [])[col];
  return Number.isFinite(v) ? { markupPct: v, fila, col } : nada;
}

// Costeo Fraccionado, POR KILO (SIGA guarda el PrecioVenta de Pesables Fraccionado por kg).
// Todas las presentaciones de un granel llevan el mismo costo (el del granel); varía el margen.
function costearFraccionado({ plu, nombre, costoKg, markupPct, banda = null } = {}) {
  const faltantes = [];
  const costo = Number(costoKg);
  if (costoKg == null || !Number.isFinite(costo) || costo <= 0) faltantes.push('costoGranel');
  if (typeof markupPct !== 'number' || !Number.isFinite(markupPct)) faltantes.push('markupPct');

  const componentes = [];
  let costoTotal = null;
  let precioNeto = null;
  let precioConIva = null;
  let precioConIvaExacto = null;
  if (!faltantes.length) {
    costoTotal = redondear2(costo);
    componentes.push({ concepto: 'Granel', detalle: 'costo por kg', importe: costoTotal });
    precioNeto = redondear2(aplicarMarkup(costo, markupPct));
    precioConIvaExacto = redondear2(conIva(precioNeto));
    precioConIva = redondearPrecioVenta(conIva(precioNeto));
  }
  return {
    plu, nombre, tipo: 'fraccionado',
    componentes,
    costoTotal, markupPct: Number.isFinite(markupPct) ? markupPct : null, banda,
    precioNeto, precioConIva, precioConIvaExacto,
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

// Presentación temporal de Fraccionado (simulación sin código en SIGA): { pesoG, markupPct, nombre? }.
// markupPct null = margen standard de la matriz. parcial (PUT) = sólo valida las claves presentes y
// nombre ''/null significa quitarlo (queda nombre: null en la salida).
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
  if (!parcial || 'markupPct' in b) {
    const m = b.markupPct == null ? null : b.markupPct;
    if (m !== null && (typeof m !== 'number' || !Number.isFinite(m) || m < MARKUP_FRAC_MIN || m > MARKUP_FRAC_MAX)) {
      throw new Error(`markupPct: debe ser null (standard) o un número entre ${MARKUP_FRAC_MIN} y ${MARKUP_FRAC_MAX}`);
    }
    out.markupPct = m;
  }
  if ('nombre' in b) {
    if (b.nombre != null && typeof b.nombre !== 'string') throw new Error(`nombre: debe ser texto de hasta ${CONCEPTO_MAX} caracteres`);
    const nombre = (b.nombre || '').trim();
    if (nombre.length > CONCEPTO_MAX) throw new Error(`nombre: máximo ${CONCEPTO_MAX} caracteres`);
    if (nombre) out.nombre = nombre; else if (parcial) out.nombre = null;
  }
  if (parcial && !Object.keys(out).length) throw new Error('nada para editar: pesoG, markupPct o nombre');
  return out;
}

// Costeo Almacén → forma de salida única (misma que van a usar Fraccionado/Producción en
// fases futuras). costoTotal = costoMercaderia + costos varios (% global) + costos extra del
// producto (ver aplicarCostosExtra, 'kg' = $ fijo por unidad). Sin costoMercaderia válido
// no hay precio: nunca se devuelve un precio "optimista" calculado sobre costo parcial o cero.
function costearAlmacen({ costoMercaderia, costosVariosPct = 0, costosExtra = [], markupPct, banda = null, plu, nombre } = {}) {
  const faltantes = [];
  const costo = Number(costoMercaderia);
  if (costoMercaderia == null || !Number.isFinite(costo)) faltantes.push('costoMercaderia');
  if (typeof markupPct !== 'number' || !Number.isFinite(markupPct)) faltantes.push('markupPct');

  const componentes = [];
  let costoTotal = null;
  let precioNeto = null;
  let precioConIva = null;
  let precioConIvaExacto = null;

  if (!faltantes.length) {
    const variosPct = Number(costosVariosPct) || 0;
    const costoVarios = costo * (variosPct / 100);
    const extra = aplicarCostosExtra(costo, costosExtra, '$');
    costoTotal = redondear2(extra.componentes.reduce((t, c) => t + c.importe, costo + costoVarios));
    componentes.push({ concepto: 'Mercadería', detalle: 'costo base', importe: redondear2(costo) });
    componentes.push({ concepto: 'Costos varios', detalle: `${variosPct}%`, importe: redondear2(costoVarios) });
    componentes.push(...extra.componentes);
    precioNeto = redondear2(aplicarMarkup(costoTotal, markupPct));
    precioConIvaExacto = redondear2(conIva(precioNeto));
    precioConIva = redondearPrecioVenta(conIva(precioNeto));
  }

  return {
    plu, nombre, tipo: 'almacen',
    componentes,
    costoTotal, markupPct: Number.isFinite(markupPct) ? markupPct : null, banda,
    precioNeto, precioConIva, precioConIvaExacto,
    faltantes,
  };
}

// Markup % que lleva costoTotal a precioConIva (IVA incluido): la inversa de costearAlmacen
// sin el redondeo a $50. 6 decimales para que recalcular reproduzca el precio al centavo.
function markupParaPrecio(costoTotal, precioConIva) {
  if (costoTotal == null || precioConIva == null) return null;
  const c = Number(costoTotal), p = Number(precioConIva);
  if (!Number.isFinite(c) || !Number.isFinite(p) || c <= 0 || p <= 0) return null;
  return +(((p / IVA / c) - 1) * 100).toFixed(6);
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
// manual (cfg.costoPorProducto[plu], > 0) → última compra neta si el producto eligió esa fuente
// (cfg.fuenteCosto[plu] === 'ultimaCompra') → costo de sistema SIGA sin IVA (default).
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

module.exports = { IVA, redondear2, elegirCosto, compararConVigente, tendenciaCompraHoy, markupParaPrecio, resolverBanda, markupDe, aplicarMarkup, conIva, redondearPrecioVenta, configSanitizada, costearAlmacen,
  validarMarkupFraccionado, markupStdFraccionado, costearFraccionado, aplicarCostosExtra, validarCostosExtra, validarPresentacionTemporal };
