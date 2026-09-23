'use strict';
// Módulo puro de costeo — Precios. Sin fs/SQL/Express, todo se inyecta por parámetros.
// Fase 1: sólo Almacén. Fraccionado/Producción/máquina/corrección de presentación llegan
// en fases futuras, pero el shape de salida de costearAlmacen ya las soporta (ver abajo).

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

// Costeo Almacén → forma de salida única (misma que van a usar Fraccionado/Producción en
// fases futuras). costoTotal = costoMercaderia + costos varios. Sin costoMercaderia válido
// no hay precio: nunca se devuelve un precio "optimista" calculado sobre costo parcial o cero.
function costearAlmacen({ costoMercaderia, costosVariosPct = 0, markupPct, banda = null, plu, nombre } = {}) {
  const faltantes = [];
  const costo = Number(costoMercaderia);
  if (costoMercaderia == null || !Number.isFinite(costo)) faltantes.push('costoMercaderia');
  if (typeof markupPct !== 'number' || !Number.isFinite(markupPct)) faltantes.push('markupPct');

  const componentes = [];
  let costoTotal = null;
  let precioNeto = null;
  let precioConIva = null;

  if (!faltantes.length) {
    const variosPct = Number(costosVariosPct) || 0;
    const costoVarios = costo * (variosPct / 100);
    costoTotal = redondear2(costo + costoVarios);
    componentes.push({ concepto: 'Mercadería', detalle: 'costo base', importe: redondear2(costo) });
    componentes.push({ concepto: 'Costos varios', detalle: `${variosPct}%`, importe: redondear2(costoVarios) });
    precioNeto = redondear2(aplicarMarkup(costoTotal, markupPct));
    precioConIva = redondearPrecioVenta(conIva(precioNeto));
  }

  return {
    plu, nombre, tipo: 'almacen',
    componentes,
    costoTotal, markupPct: Number.isFinite(markupPct) ? markupPct : null, banda,
    precioNeto, precioConIva,
    faltantes,
  };
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

module.exports = { IVA, compararConVigente, resolverBanda, markupDe, aplicarMarkup, conIva, redondearPrecioVenta, configSanitizada, costearAlmacen };
