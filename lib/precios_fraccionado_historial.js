'use strict';
// ── Precios · Fraccionado: sugerido de min/kg desde el historial (spec 2026-10-29-precios-fraccionado-tiempos-historial, E2) ──
// Puro (sin I/O). Entra producción de líneas de data/historial_distribucion.json (produccion[] de cada día), los graneles de
// SIGA con su subrubro y la tabla tramosTiempo guardada; sale la estadística que pinta Configuración. Todo a 1 kg.
const { intervaloDe, kilosDeCarga, personasDeCarga, claveNombre, unirPorId } = require('./productividad');
const { BASE_G, pesoGDe, tramoDe, ajusteDe } = require('./precios_fraccionado_costo');
const { granelDe } = require('./precios_consultas');

const MIN_MUESTRAS = 5;
const DURACION_MAX_MIN = 180;
const MOTIVOS = ['act', 'duracion', 'sinKilos', 'sinGranel', 'sinPeso'];

const r2 = n => Math.round(n * 100) / 100;
const lista = v => (Array.isArray(v) ? v : []);
const esObjeto = v => v != null && typeof v === 'object' && !Array.isArray(v);
const esPlu = v => v != null && /^\d{1,12}$/.test(String(v).trim());

// Cuantil con interpolación lineal (como Excel PERCENTIL.INC). Lista vacía → null. No muta la entrada.
function cuantil(valores, q) {
  const v = lista(valores).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * q, i = Math.floor(pos);
  return i + 1 < v.length ? v[i] + (v[i + 1] - v[i]) * (pos - i) : v[i];
}
const mediana = valores => cuantil(valores, 0.5);

// Franjas [a, b) de cada persona-día: { clave, i, a, b }. Carga sin persona = persona propia (no se reparte).
function franjasDe(cargas) {
  return cargas.flatMap((c, i) => {
    const personas = personasDeCarga(c);
    const quienes = personas.length ? personas.map(p => ({ k: claveNombre(p.nombre), desde: p.desde, hasta: p.hasta }))
      : [{ k: `#${i}`, desde: c.desde, hasta: c.hasta }];
    return quienes.map(p => ({ clave: `${c.fecha}|${p.k}`, i, iv: intervaloDe(p.desde, p.hasta) }))
      .filter(f => f.iv).map(f => ({ clave: f.clave, i: f.i, a: f.iv[0], b: f.iv[1] }));
  });
}

// Reparte un grupo (una persona-día): cada tramo de reloj entre cortes, en partes iguales entre las líneas activas.
function repartirGrupo(franjas, minutos) {
  const cortes = [...new Set(franjas.flatMap(f => [f.a, f.b]))].sort((x, y) => x - y);
  for (let k = 0; k + 1 < cortes.length; k++) {
    const [t0, t1] = [cortes[k], cortes[k + 1]];
    const activas = franjas.filter(f => f.a <= t0 && f.b >= t1);
    for (const f of activas) minutos[f.i] += (t1 - t0) / activas.length;
  }
}

// Persona-minutos de cada carga (alineado con `cargas`), con las solapadas de la misma persona y día repartidas.
// Entran TODAS las cargas de horario válido (ACT y las que después se descartan también). La suma de un grupo = minutosUnidos.
function repartirMinutos(cargas) {
  const cs = lista(cargas);
  const minutos = cs.map(() => 0);
  const grupos = new Map();
  for (const f of franjasDe(cs)) grupos.set(f.clave, [...(grupos.get(f.clave) || []), f]);
  for (const fs of grupos.values()) repartirGrupo(fs, minutos);
  return minutos;
}

// min/kg de una carga: crudo = minutos ÷ kilos; a 1 kg = crudo − ajuste de la tabla guardada para su peso (vacía → crudo).
function minKgPorCarga({ minutos, kilos, pesoG, tramos }) {
  const crudo = minutos / kilos;
  return { crudo, minKg: crudo - ajusteDe(tramos, pesoG) };
}

// Granel único de una carga: `granel` numérico, graneles[] de uno solo, la fórmula de pesables_listas de su PLU o su PLU si
// es un granel (venta directa que es su propio granel). Más de uno o ninguno → null.
function granelDeCarga(c, formulas, esGranel) {
  if (esPlu(c.granel)) return String(c.granel).trim();
  const gs = lista(c.graneles).filter(g => esObjeto(g) && esPlu(g.granel));
  if (gs.length) return gs.length === 1 ? String(gs[0].granel).trim() : null;
  if (!esPlu(c.plu)) return null;
  const plu = String(c.plu).trim();
  return granelDe(formulas, plu) || (esGranel(plu) ? plu : null);
}

// Motivo de descarte (en el orden de la spec) o la carga usable { plu, pesoG, minutos, kilos }.
function clasificar(c, minutos, formulas, esGranel) {
  if (String(c.plu || '').trim().toUpperCase() === 'ACT') return { motivo: 'act' };
  const iv = intervaloDe(c.desde, c.hasta);
  if (!iv || iv[1] - iv[0] > DURACION_MAX_MIN || !(minutos > 0)) return { motivo: 'duracion' };
  const kilos = kilosDeCarga(c);
  if (!(kilos > 0)) return { motivo: 'sinKilos' };
  const plu = granelDeCarga(c, formulas, esGranel);
  if (!plu) return { motivo: 'sinGranel' };
  const pesoG = pesoGDe(c.nombre);
  if (!pesoG) return { motivo: 'sinPeso' };
  return { usable: { plu, pesoG, minutos, kilos } };
}

const stats = (valores, piso) => {
  const f = v => (v == null ? null : r2(piso ? Math.max(0, v) : v));
  return { mediana: f(mediana(valores)), p25: f(cuantil(valores, 0.25)), p75: f(cuantil(valores, 0.75)) };
};
const sinValor = { mediana: null, p25: null, p75: null };
const agrupar = (items, clave) => items.reduce((m, x) => m.set(clave(x), [...(m.get(clave(x)) || []), x]), new Map());

// Producto (PLU del granel): mediana de sus cargas a 1 kg, nunca bajo 0. < MIN_MUESTRAS → pocosDatos sin valor.
function porProducto(usables, subrubroDe) {
  return Object.fromEntries([...agrupar(usables, u => u.plu)].map(([plu, us]) => {
    const pocosDatos = us.length < MIN_MUESTRAS;
    return [plu, { n: us.length, ...(pocosDatos ? sinValor : stats(us.map(u => u.minKg), true)), subrubroId: subrubroDe(plu), pocosDatos }];
  }));
}

// Subrubro: mediana de las medianas de sus productos con valor (un producto, un voto); n = cargas de esos productos.
function porSubrubro(productos) {
  const conSub = Object.entries(productos).filter(([, p]) => p.subrubroId != null);
  return Object.fromEntries([...agrupar(conSub, ([, p]) => p.subrubroId)].map(([id, ps]) => {
    const conValor = ps.filter(([, p]) => !p.pocosDatos);
    const n = conValor.reduce((s, [, p]) => s + p.n, 0);
    const pocosDatos = n < MIN_MUESTRAS;
    return [id, { n, productos: conValor.length, ...(pocosDatos ? sinValor : stats(conValor.map(([, p]) => p.mediana), true)), pocosDatos }];
  }));
}

// Histograma por subrubro: productos con valor, ordenados por min/kg.
function distribucionDe(productos, nombreDe) {
  const conValor = Object.entries(productos).filter(([, p]) => p.subrubroId != null && !p.pocosDatos);
  return Object.fromEntries([...agrupar(conValor, ([, p]) => p.subrubroId)].map(([id, ps]) => [id,
    ps.map(([plu, p]) => ({ plu, nombre: nombreDe(plu), n: p.n, minKg: p.mediana })).sort((a, b) => a.minKg - b.minKg)]));
}

// Tramos con cargas CRUDAS contra la base (el que contiene BASE_G): por producto, mediana del tramo − mediana de la base
// (sólo productos con cargas en ambos); sugerido = mediana de esas diferencias. La base no se sugiere (vale 0).
function porTramo(usables, tramos) {
  const base = tramoDe(tramos, BASE_G);
  const porPlu = agrupar(usables, u => u.plu);
  const crudaEn = (us, t) => mediana(us.filter(u => tramoDe(tramos, u.pesoG) === t).map(u => u.crudo));
  return lista(tramos).map(t => {
    if (t === base) {
      const n = [...porPlu.values()].filter(us => crudaEn(us, t) != null).length;
      return { hastaG: t.hastaG, base: true, n, mediana: 0, p25: 0, p75: 0, pocosDatos: false };
    }
    const difs = [...porPlu.values()].map(us => [crudaEn(us, t), crudaEn(us, base)])
      .filter(([a, b]) => a != null && b != null).map(([a, b]) => a - b);
    const pocosDatos = difs.length < MIN_MUESTRAS;
    return { hastaG: t.hastaG, base: false, n: difs.length, ...(pocosDatos ? sinValor : stats(difs, false)), pocosDatos };
  });
}

// Usables (con crudo y minKg) y descartes por motivo, después del reparto.
function separar(cargas, { formulas, graneles, tramos }) {
  const minutos = repartirMinutos(cargas);
  const plusGranel = new Set(graneles.map(g => g.plu));
  const descartes = Object.fromEntries(MOTIVOS.map(m => [m, 0]));
  const usables = [];
  cargas.forEach((c, i) => {
    const r = clasificar(c, minutos[i], formulas, plu => plusGranel.has(plu));
    if (r.motivo) descartes[r.motivo] += 1;
    else usables.push({ ...r.usable, ...minKgPorCarga({ ...r.usable, tramos }) });
  });
  return { usables, descartes };
}

// → { cargas: { total, usadas, descartes }, minMuestras, productos, subrubros, tramos, distribucion }. Sin historial → ceros.
// graneles = [{ plu, nombre, subrubroId }] (granelesConSubrubro); tramos = tramosTiempo guardado; formulas = pesables_listas.
function estadisticasHistorial({ cargas, graneles, tramos, formulas } = {}) {
  const unicas = unirPorId(lista(cargas).filter(esObjeto));
  const gs = lista(graneles).filter(esObjeto).map(g => ({ ...g, plu: String(g.plu) }));
  const ts = lista(tramos);
  const { usables, descartes } = separar(unicas, { formulas, graneles: gs, tramos: ts });
  const porPlu = new Map(gs.map(g => [g.plu, g]));
  const productos = porProducto(usables, plu => (porPlu.has(plu) && porPlu.get(plu).subrubroId != null ? String(porPlu.get(plu).subrubroId) : null));
  const nombreDe = plu => (porPlu.get(plu) || {}).nombre || null;
  return {
    cargas: { total: unicas.length, usadas: usables.length, descartes },
    minMuestras: MIN_MUESTRAS, productos, subrubros: porSubrubro(productos), tramos: porTramo(usables, ts),
    distribucion: distribucionDe(productos, nombreDe),
  };
}

module.exports = { MIN_MUESTRAS, DURACION_MAX_MIN, cuantil, mediana, repartirMinutos, minKgPorCarga, estadisticasHistorial };
