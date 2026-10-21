'use strict';
// ── Precios · costo real de una presentación de Fraccionado (spec 2026-10-21-precios-fraccionado-costeo-design §3) ──
// Puro (sin I/O). Por unidad: insumos (los propios de la presentación o la regla subrubro del granel × tramo de peso) +
// mano de obra + máquina, con minutos = tiempo del tramo de peso × factor de facilidad del granel. Se pasa a $/kg con el
// peso para sumarlo al $/kg del granel: el motor (lib/precios_esquema) y el ajuste por peso siguen trabajando en $/kg.
const { redondear2 } = require('./precios_costeo');

const FACILIDADES = Object.freeze(['facil', 'medio', 'dificil']);
const FACILIDADES_DEFECTO = Object.freeze({ facil: 1, medio: 1.25, dificil: 1.5 });
const CLAVE_MO = '_manoObra';
const CLAVE_MAQUINA = '_maquina';

const objeto = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const lista = v => (Array.isArray(v) ? v : []);
const noNegativo = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const redondear4 = n => Math.round(n * 10000) / 10000;

// costeo.fraccionado con defaults: sin migrar o a medio cargar → listas vacías y facilidades por defecto.
function normalizarCosteoFraccionado(f) {
  const x = objeto(f);
  return {
    costoHora: noNegativo(x.costoHora),
    maquinas: lista(x.maquinas),
    tiempos: lista(x.tiempos),
    facilidades: { ...FACILIDADES_DEFECTO, ...objeto(x.facilidades) },
    insumosSubrubro: objeto(x.insumosSubrubro),
    porGranel: objeto(x.porGranel),
    insumosPresentacion: objeto(x.insumosPresentacion),
  };
}

// Tramos [{ hastaG, … }] ascendentes: el primero con pesoG ≤ hastaG; arriba del último → el último. Sin tramos o sin peso → null.
function tramoDe(tramos, pesoG) {
  const ts = lista(tramos);
  if (!ts.length || !(pesoG > 0)) return null;
  return ts.find(t => pesoG <= t.hastaG) || ts[ts.length - 1];
}

// PLUs de insumo de las reglas y de los propios (el router pide sus costos a SIGA).
function plusInsumos(cf) {
  const deReglas = Object.values(objeto(cf.insumosSubrubro)).flatMap(ts => lista(ts).flatMap(t => lista(t.insumos)));
  const propios = Object.values(objeto(cf.insumosPresentacion)).flatMap(lista);
  return [...new Set([...deReglas, ...propios].map(it => String(it.plu)))];
}

// Importe SIN redondear de una línea: insumo = cantidad × costo; minutos = minutos × costo hora ÷ 60 (sin costo → 0).
// El total y el $/kg salen de estos valores; el redondeo a 2 decimales es sólo para mostrar cada línea.
const crudoDe = l => (l.costoUnit == null ? 0 : l.cantidad * l.costoUnit / (l.rol === 'insumo' ? 1 : 60));
const lineaMinutos = (plu, nombre, rol, minutos, costoHora) => {
  const l = { plu, nombre, rol, cantidad: minutos, costoUnit: costoHora };
  return { ...l, importe: redondear2(crudoDe(l)) };
};

// Costo extra por unidad de una presentación. granel = { plu, subrubroId }; cf = normalizarCosteoFraccionado(...);
// costoDe(plu) → { costo, nombre } | null (costo del insumo en su tab). → { pesoG, minutos, origenInsumos ('propios' |
// 'regla' | null), lineas (rol 'insumo' | 'mo' | 'maquina'), porUnidad, extraKg, avisos, faltantes }.
// Insumo sin costo → faltante: porUnidad y extraKg null (la presentación queda sin sugerido, nunca 0). Lo demás que falte
// va en 0 con un aviso (spec §3.1). Sin peso → sólo mercadería (extra 0, aviso sinPeso).
function costearPresentacion({ plu, pesoG, granel = {}, cf, costoDe = () => null }) {
  if (!(pesoG > 0)) {
    return { pesoG: null, minutos: 0, origenInsumos: null, lineas: [], porUnidad: 0, extraKg: 0, avisos: ['sinPeso'], faltantes: [] };
  }
  const avisos = [];
  const datos = objeto(cf.porGranel[granel.plu]);
  const factor = cf.facilidades[datos.facilidad];
  if (!(factor > 0)) avisos.push('sinFacilidad');
  const tramo = tramoDe(cf.tiempos, pesoG);
  if (!tramo) avisos.push('sinTiempos');
  const minutos = tramo ? redondear4(tramo.minutos * (factor > 0 ? factor : 1)) : 0;
  const maquina = cf.maquinas.find(m => m.id === datos.maquinaId) || null;
  if (!maquina) avisos.push('sinMaquina');
  if (minutos > 0 && cf.costoHora == null) avisos.push('costoHora');
  const propios = lista(cf.insumosPresentacion[plu]);
  const regla = lista((tramoDe(cf.insumosSubrubro[granel.subrubroId], pesoG) || {}).insumos);
  const usados = propios.length ? propios : regla;
  if (!usados.length) avisos.push('sinInsumos');
  const insumos = usados.map(it => {
    const c = costoDe(String(it.plu));
    const costo = c ? Number(c.costo) : NaN;
    const costoUnit = Number.isFinite(costo) && costo > 0 ? costo : null;
    const l = { plu: String(it.plu), nombre: (c && c.nombre) || null, rol: 'insumo', cantidad: it.cantidad, costoUnit };
    return { ...l, importe: costoUnit == null ? null : redondear2(crudoDe(l)) };
  });
  const tiempo = minutos > 0 ? [lineaMinutos(CLAVE_MO, 'Mano de obra', 'mo', minutos, cf.costoHora),
    ...(maquina ? [lineaMinutos(CLAVE_MAQUINA, maquina.nombre, 'maquina', minutos, noNegativo(maquina.costoHora))] : [])] : [];
  const lineas = [...insumos, ...tiempo];
  const faltantes = insumos.filter(l => l.importe == null).map(l => l.plu);
  const crudo = faltantes.length ? null : lineas.reduce((s, l) => s + crudoDe(l), 0);
  return {
    pesoG, minutos, origenInsumos: propios.length ? 'propios' : regla.length ? 'regla' : null, lineas,
    porUnidad: crudo == null ? null : redondear2(crudo),
    extraKg: crudo == null ? null : redondear2(crudo / (pesoG / 1000)), avisos, faltantes,
  };
}

// Costos por fuente del granel ($/kg) + el extra $/kg de la presentación. extra null (faltante) → ninguna fuente tiene costo.
function sumarExtraKg(costos, extraKg) {
  return Object.fromEntries(Object.entries(costos).map(([f, c]) => [f, c == null || extraKg == null ? null : redondear2(c + extraKg)]));
}

module.exports = {
  FACILIDADES, FACILIDADES_DEFECTO, CLAVE_MO, CLAVE_MAQUINA,
  normalizarCosteoFraccionado, tramoDe, plusInsumos, costearPresentacion, sumarExtraKg,
};
