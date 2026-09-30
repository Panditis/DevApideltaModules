'use strict';
// Módulo puro de costeo — Precios. Sin fs/SQL/Express, todo se inyecta por parámetros.
// Fase 1: Almacén. Fase 2: Fraccionado (costo del granel × margen por costo y presentación).
// Producción llega en una fase futura, con el mismo shape de salida que costearAlmacen (ver abajo).

// Factor de IVA de la VENTA: 1 = no se suma. El costo ya viene "con IVA" (PrecioCosto de SIGA tal cual,
// factura + su IVA, cotización tal cual), así que precio final = costo × (1 + markup) (decisión del
// usuario, 2026-09-30). Único lugar del factor: conIva, markupParaPrecio y precioDe (Producción) lo leen de acá.
const IVA_VENTA = 1;
// Factor que se usaba hasta 2026-09-30 (costo sin IVA × markup × 1,21): sólo para migrar márgenes propios.
const IVA_VENTA_ANTERIOR = 1.21;

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
// generador Excel hacía lo mismo con MROUND, a 10). Sólo para el precio final — costos
// y neto siguen a 2 decimales.
const PASO_PRECIO_VENTA = 50;
function redondearPrecioVenta(n) {
  return Math.round(n / PASO_PRECIO_VENTA) * PASO_PRECIO_VENTA;
}

function aplicarMarkup(costo, markupPct) {
  return costo * (1 + markupPct / 100);
}

// Precio final a partir del neto (costo × (1 + markup)). Con IVA_VENTA = 1 es la identidad: se deja el
// nombre y el campo precioConIva porque así los leen la UI, los exports y los tests.
function conIva(precioNeto) {
  return precioNeto * IVA_VENTA;
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
  const col = tramoDePeso(pesoG, tramos);
  const v = ((matriz.markupPct || [])[fila] || [])[col];
  return Number.isFinite(v) ? { markupPct: v, fila, col } : nada;
}

// Índice del tramo de peso (tramosG no vacío, ascendente): primer tramo con peso <= tramo; sin peso
// → 1 kg; más pesado que el último → último. Compartido por la matriz y la curva de ganancia.
function tramoDePeso(pesoG, tramosG) {
  const peso = pesoG > 0 ? pesoG : PESO_SIN_DATO_G;
  const i = tramosG.findIndex(t => peso <= t);
  return i < 0 ? tramosG.length - 1 : i;
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

// Markup % que lleva costoTotal al precio final: la inversa de costearAlmacen sin el redondeo a $50
// (precio / costo − 1). 6 decimales para que recalcular reproduzca el precio al centavo.
function markupParaPrecio(costoTotal, precioConIva) {
  if (costoTotal == null || precioConIva == null) return null;
  const c = Number(costoTotal), p = Number(precioConIva);
  if (!Number.isFinite(c) || !Number.isFinite(p) || c <= 0 || p <= 0) return null;
  return +(((p / IVA_VENTA / c) - 1) * 100).toFixed(6);
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
// manual (cfg.costoPorProducto[plu], > 0) → última compra (factura + IVA, cotización tal cual) si el
// producto eligió esa fuente (cfg.fuenteCosto[plu] === 'ultimaCompra') → costo de sistema SIGA tal cual (default).
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
// Los standards (bandas Almacén/Producción, matriz Fraccionado) guardan GANANCIA; el markup total
// sale de la fórmula exacta markup = (1 + ganancia) / (1 − gastosVenta) − 1, con el total de gastos
// de la lista. Overrides por producto siguen siendo markup total. Con gastos 0 es la identidad.
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
function markupDesdeGanancia(gananciaPct, gastosPct) {
  const gastos = Number(gastosPct) || 0;
  if (typeof gananciaPct !== 'number' || !Number.isFinite(gananciaPct) || gastos >= 100) return null;
  if (gastos === 0) return gananciaPct;
  return +(((1 + gananciaPct / 100) / (1 - gastos / 100) - 1) * 100).toFixed(6);
}

function gananciaDesdeMarkup(markupPct, gastosPct) {
  const gastos = Number(gastosPct) || 0;
  if (typeof markupPct !== 'number' || !Number.isFinite(markupPct) || gastos >= 100) return null;
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

// Body de PUT /api/precios/config/gastos-venta → [{ id, concepto, pct, listas }]. Sin id se genera el
// slug del concepto (con sufijo -2, -3... si ya existe); un id explícito repetido es error.
function validarGastosVenta(items) {
  if (!Array.isArray(items)) throw new Error('items: debe ser una lista');
  if (items.length > GASTOS_MAX_ITEMS) throw new Error(`items: máximo ${GASTOS_MAX_ITEMS} gastos`);
  const limpios = items.map(validarItemGasto);
  const explicitos = limpios.filter(g => g.id).map(g => g.id);
  const repetido = explicitos.find((id, i) => explicitos.indexOf(id) !== i);
  if (repetido) throw new Error(`items: id "${repetido}" repetido`);
  const usados = new Set(explicitos);
  const lista = limpios.map(g => {
    if (g.id) return g;
    const base = slugGasto(g.concepto);
    let id = base;
    for (let n = 2; usados.has(id); n++) id = `${base}-${n}`;
    usados.add(id);
    return { ...g, id };
  });
  for (const l of LISTAS_GASTOS) {
    if (totalGastosVenta(lista, l) >= 100) throw new Error(`items: el total de gastos de la lista ${l} debe ser menor a 100 %`);
  }
  return lista;
}

// Al cambiar los gastos, reescala todas las ganancias para que el markup total no cambie:
// (1 + g')/(1 − gastosNuevo) = (1 + g)/(1 − gastosViejo) ⇒ g' = (1 + g)(1 − gastosNuevo)/(1 − gastosViejo) − 1,
// a 4 decimales. Las curvas de ganancia guardadas (activas o no) se reescalan igual: ver escalarCurva.
// Copia nueva, no muta costeo.
function reescalarGanancias(costeo, gastosViejo, gastosNuevo) {
  const viejo = Number(gastosViejo) || 0, nuevo = Number(gastosNuevo) || 0;
  if (viejo === nuevo) return costeo;
  const factor = (1 - nuevo / 100) / (1 - viejo / 100);
  const g = v => (Number.isFinite(v) ? redondear4(((1 + v / 100) * factor - 1) * 100) : v);
  const bandas = lista => (Array.isArray(lista) ? lista.map(b => ({ ...b, markupMaxPct: g(b.markupMaxPct) })) : lista);
  const bm = costeo.bandasMarkup || {};
  const mf = costeo.markupFraccionado;
  const cg = costeo.curvaGanancia;
  return {
    ...costeo,
    bandasMarkup: { ...bm, almacen: bandas(bm.almacen), produccion: bandas(bm.produccion), fraccionado: bandas(bm.fraccionado) },
    ...(mf ? { markupFraccionado: { ...mf, markupPct: (mf.markupPct || []).map(fila => (Array.isArray(fila) ? fila.map(g) : fila)) } } : {}),
    ...(cg && typeof cg === 'object'
      ? { curvaGanancia: Object.fromEntries(Object.entries(cg).map(([tipo, c]) => [tipo, escalarCurva(c, factor, g)])) } : {}),
  };
}

// 1 + g' = k(1 + g) aplicado a la curva: los niveles (a, piso, techo) como cualquier ganancia,
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
// menos ganancia. Es GANANCIA, como bandas y matriz: el markup total sale de markupDesdeGanancia.
// Inactiva (default) = bandas/matriz como siempre. Se ajusta desde los precios vigentes de SIGA.
const TIPOS_CURVA = ['almacen', 'fraccionado'];
const CURVA_RANGO_PCT = [-50, 300];
const AJUSTE_PESO_RANGO = [-100, 100];
const AJUSTES_PESO_MAX = 20;
const CURVA_MIN_PUNTOS = 20;
const CURVA_BINS = 20;
const MUESTRA_MAX = 1500;
const CURVA_BASE = { activa: false, a: 0, b: 0, pisoPct: 0, techoPct: 100, ajustadaEl: null, n: null };
const CURVA_GANANCIA_DEFAULT = Object.freeze({
  almacen: Object.freeze({ ...CURVA_BASE }),
  fraccionado: Object.freeze({ ...CURVA_BASE, ajustesPeso: null }),
});

function curvasGananciaConDefault(cg) {
  const c = cg && typeof cg === 'object' ? cg : {};
  return {
    almacen: { ...CURVA_GANANCIA_DEFAULT.almacen, ...(c.almacen || {}) },
    fraccionado: { ...CURVA_GANANCIA_DEFAULT.fraccionado, ...(c.fraccionado || {}) },
  };
}

const esNumero = v => typeof v === 'number' && Number.isFinite(v);

// clamp(a − b·ln c, piso, techo) sin mirar `activa` ni ajustes por peso (lo usan el ajuste y los residuos).
function gananciaBaseCurva(curva, costo) {
  const c = Number(costo);
  if (!curva || costo == null || !Number.isFinite(c) || c <= 0) return null;
  const { a, b, pisoPct, techoPct } = curva;
  if (![a, b, pisoPct, techoPct].every(esNumero) || pisoPct > techoPct) return null;
  return Math.min(techoPct, Math.max(pisoPct, a - b * Math.log(c)));
}

// Ganancia standard por curva (6 dec), o null si está inactiva/inválida o sin costo. Con ajustesPeso
// suma el ajuste del tramo (misma regla que la matriz), después del clamp.
function gananciaPorCurva(curva, costo, pesoG = null) {
  if (!curva || curva.activa !== true) return null;
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
// b puede ser 0 o negativo (la UI avisa). ajustesPeso sólo existe en Fraccionado.
function validarCurvaGanancia(c, tipo) {
  if (!TIPOS_CURVA.includes(tipo)) throw new Error(`curvaGanancia: tipo inválido (${TIPOS_CURVA.join(', ')})`);
  const n = `curvaGanancia.${tipo}`;
  if (!c || typeof c !== 'object') throw new Error(`${n}: debe ser un objeto { activa, a, b, pisoPct, techoPct }`);
  if (c.activa != null && typeof c.activa !== 'boolean') throw new Error(`${n}.activa: debe ser true o false`);
  for (const k of ['a', 'b']) if (!esNumero(c[k])) throw new Error(`${n}.${k}: debe ser un número`);
  const [min, max] = CURVA_RANGO_PCT;
  for (const k of ['pisoPct', 'techoPct']) {
    if (!esNumero(c[k]) || c[k] < min || c[k] > max) throw new Error(`${n}.${k}: debe ser un número entre ${min} y ${max}`);
  }
  if (c.pisoPct >= c.techoPct) throw new Error(`${n}: pisoPct debe ser menor a techoPct`);
  if (c.ajustadaEl != null && (typeof c.ajustadaEl !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(c.ajustadaEl))) {
    throw new Error(`${n}.ajustadaEl: fecha AAAA-MM-DD o null`);
  }
  if (c.n != null && (!Number.isInteger(c.n) || c.n < 0)) throw new Error(`${n}.n: entero ≥ 0 o null`);
  const limpia = {
    activa: c.activa === true, a: c.a, b: c.b, pisoPct: c.pisoPct, techoPct: c.techoPct,
    ajustadaEl: c.ajustadaEl ?? null, n: c.n ?? null,
  };
  return tipo === 'fraccionado' ? { ...limpia, ajustesPeso: validarAjustesPeso(c.ajustesPeso, n) } : limpia;
}

// Puntos para ajustar la curva desde SIGA: la ganancia implícita es la que, con los gastos actuales,
// reproduce el precio vigente con el costo total; el costo del eje es el base (el mismo que busca banda).
const gananciaImplicita = (costoTotal, precioVigente, gastosPct) =>
  gananciaDesdeMarkup(markupParaPrecio(costoTotal, precioVigente), gastosPct);

function puntosCurvaAlmacen(filas, gastosPct) {
  return (filas || []).filter(f => f && f.costoBase > 0 && f.costoTotal > 0 && f.precioVigente > 0)
    .map(f => ({ costo: f.costoBase, ganancia: gananciaImplicita(f.costoTotal, f.precioVigente, gastosPct) }));
}

// Fraccionado: una por presentación real con vigente; costo = base del granel, ganancia con su costoKg
// (granel + extras + MO + insumos).
function puntosCurvaFraccionado(grupos, gastosPct) {
  return (grupos || []).flatMap(g => (g && g.costoBase > 0 ? g.presentaciones || [] : [])
    .filter(p => p.costoKg > 0 && p.precioVigente > 0)
    .map(p => ({ costo: g.costoBase, ganancia: gananciaImplicita(p.costoKg, p.precioVigente, gastosPct), pesoG: p.pesoG })));
}

// Muestra para el gráfico: hasta MUESTRA_MAX puntos válidos, tomados a paso fijo (determinística).
function muestraCurva(puntos) {
  const v = puntos.filter(puntoCurvaValido);
  const paso = Math.max(1, v.length / MUESTRA_MAX);
  return Array.from({ length: Math.min(v.length, MUESTRA_MAX) }, (_, i) => v[Math.floor(i * paso)])
    .map(p => ({ costo: redondear2(p.costo), ganancia: redondear2(p.ganancia) }));
}

// Respuesta de POST /api/precios/curva-ganancia/ajustar/:tipo (no guarda nada). Almacén: filas de
// filasAlmacen; Fraccionado: grupos de armarGruposFraccionado + tramosG de la matriz vigente.
function propuestaCurva(tipo, filasOGrupos, { gastosPct = 0, tramosG = [] } = {}) {
  const puntos = tipo === 'fraccionado' ? puntosCurvaFraccionado(filasOGrupos, gastosPct) : puntosCurvaAlmacen(filasOGrupos, gastosPct);
  const curva = ajustarCurva(puntos);
  const extra = tipo === 'fraccionado' ? { ajustesPeso: ajustesPorPeso(puntos, curva, tramosG) } : {};
  return { ...curva, ...extra, muestra: muestraCurva(puntos) };
}

module.exports = { IVA_VENTA, redondear2, elegirCosto, compararConVigente, tendenciaCompraHoy, markupParaPrecio, resolverBanda, markupDe, aplicarMarkup, conIva, redondearPrecioVenta, configSanitizada, costearAlmacen,
  validarMarkupFraccionado, markupStdFraccionado, costearFraccionado, aplicarCostosExtra, validarCostosExtra, validarPresentacionTemporal,
  totalGastosVenta, markupDesdeGanancia, gananciaDesdeMarkup, validarGastosVenta, reescalarGanancias,
  TIPOS_CURVA, CURVA_GANANCIA_DEFAULT, curvasGananciaConDefault, gananciaPorCurva, ajustarCurva, ajustesPorPeso, validarCurvaGanancia,
  propuestaCurva, migrarMargenesBaseCosto, migrarCosteoBaseCosto, BASE_COSTO_SIGA };
