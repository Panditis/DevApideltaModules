'use strict';
// Helpers puros de costo compartidos por el esquema por canal: redondeo a 2 decimales, comparación contra el vigente de SIGA, costos extra por producto y validación de la lista de gastos variables (Configuración › Costos).

// Redondeo de plata a 2 decimales (convención ARS) — mismo patrón que redondear() en compras.js:
// sin esto, costo*pct/100 y aplicarMarkup dejan ruido de punto flotante (ej 24.999750000000002)
// que no debe llegar a una UI de precios.
function redondear2(n) {
  return Math.round(n * 100) / 100;
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

// ── Lista de gastos variables (Configuración › Costos) ─────────────────────────────
// validarGastosVenta valida concepto, %, ids y total < 100 %. `listas` (hoy sólo 'sucursal') la saca
// lib/precios_config_esquema antes de guardar.
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
// -3... si ya existe; un id explícito repetido es error.
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

// Lista de gastos / extras → [{ id, concepto, pct, listas }]. Sin id se genera el
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

module.exports = { redondear2, compararConVigente, aplicarCostosExtra, validarCostosExtra, validarGastosVenta };
