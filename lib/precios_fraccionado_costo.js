'use strict';
// ── Precios · costo real de una presentación de Fraccionado (spec 2026-10-21-precios-fraccionado-costeo-design §9;
// 2026-10-29-precios-fraccionado-tiempos-historial-design) ──
// Puro (sin I/O). Por unidad: envase de su peso (envasePorPeso: bolsa PLU o bobina g × $/kg; spec 2026-10-29-…-envase-bolsa-bobina)
// + mano de obra + máquina, con
// minutos = max(0, minKg + ajuste del tramo) × kg. minKg = el del granel (porGranel, 0 vale) o el de su subrubro; ajuste =
// tabla global tramosTiempo (± min/kg). Máquina sólo la del granel. Se pasa a $/kg con el peso para sumarlo al $/kg del
// granel: el motor (lib/precios_esquema) y el ajuste por peso siguen trabajando en $/kg.
const { redondear2 } = require('./precios_costeo');
const { pesoTokenKg } = require('./producto_carga');

const CLAVE_MO = '_manoObra';
const CLAVE_MAQUINA = '_maquina';
const CLAVE_BOBINA = '_bobina';
const PESO_G = /^[1-9]\d{0,5}$/; // clave de envasePorPeso: gramos enteros > 0 (sin ceros adelante: tiene que ser String(pesoG))
const BASE_G = 1000; // el tramo que cubre 1 kg es la base: su ajuste vale 0 (lo exige el validador)

const objeto = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const lista = v => (Array.isArray(v) ? v : []);
const esNum = v => typeof v === 'number' && Number.isFinite(v);
const noNegativo = v => (esNum(v) && v >= 0 ? v : null);
const redondear4 = n => Math.round(n * 10000) / 10000;

// La forma vieja (escalas, factorFacilidad, subrubros[id].{maquinaId, tramos, facilidad, tiempo}, facilidades, tiempos, …)
// se lee y se ignora; el próximo guardado (lib/precios_config_fraccionado fraccionadoConCambios) la borra.
const PLU_SIGA = /^\d{1,12}$/;
const positivo = v => (esNum(v) && v > 0 ? v : null);
// envasePorPeso[pesoG] = { bolsaPlu?, bobinaG? }; una entrada sin ninguno de los dos se descarta.
function envaseDePeso(e) {
  const x = objeto(e);
  const plu = x.bolsaPlu != null && PLU_SIGA.test(String(x.bolsaPlu)) ? String(x.bolsaPlu) : null;
  const env = { ...(plu && { bolsaPlu: plu }), ...(positivo(x.bobinaG) != null && { bobinaG: x.bobinaG }) };
  // sinEnvase: peso sacado de la lista con productos → se costean sin envase y sin aviso. Nunca junto con bolsa/bobina.
  // oculto: además la fila no se muestra en la tabla Envase (no cambia el costeo); solo vale con sinEnvase.
  return !Object.keys(env).length && x.sinEnvase === true ? { sinEnvase: true, ...(x.oculto === true && { oculto: true }) } : env;
}
const envasePorPesoDe = x => Object.fromEntries(Object.entries(objeto(x.envasePorPeso)).filter(([g]) => PESO_G.test(g))
  .map(([g, e]) => [g, envaseDePeso(e)]).filter(([, e]) => Object.keys(e).length));
const tramosTiempoDe = x => lista(x.tramosTiempo).filter(t => Number.isInteger(objeto(t).hastaG) && t.hastaG > 0 && esNum(t.minKg))
  .map(t => ({ hastaG: t.hastaG, minKg: t.minKg }));
const subrubrosDe = x => Object.fromEntries(Object.entries(objeto(x.subrubros))
  .filter(([, s]) => noNegativo(objeto(s).minKg) != null).map(([id, s]) => [id, { minKg: s.minKg }]));
function granelDe(g) {
  const x = objeto(g);
  return { ...(noNegativo(x.minKg) != null && { minKg: x.minKg }), ...(typeof x.maquinaId === 'string' && x.maquinaId && { maquinaId: x.maquinaId }),
    ...(x.envase === 'bobina' && { envase: 'bobina' }) };
}
const porGranelDe = x => Object.fromEntries(Object.entries(objeto(x.porGranel))
  .map(([plu, g]) => [plu, granelDe(g)]).filter(([, g]) => Object.keys(g).length));

// costeo.fraccionado con defaults (sin migrar o a medio cargar → mapas vacíos) y la forma vieja descartada.
function normalizarCosteoFraccionado(f) {
  const x = objeto(f);
  return { costoHora: noNegativo(x.costoHora), maquinas: lista(x.maquinas), tramosTiempo: tramosTiempoDe(x), subrubros: subrubrosDe(x),
    envasePorPeso: envasePorPesoDe(x), costoBobinaKg: positivo(x.costoBobinaKg), porGranel: porGranelDe(x) };
}

// Gramos enteros del peso del nombre ("Almendra 500G" → 500); sin peso → null. Es la clave de envasePorPeso.
const pesoGDe = nombre => { const kg = pesoTokenKg(nombre); return kg > 0 ? Math.round(kg * 1000) : null; };

// Tramos [{ hastaG, … }] ascendentes: el primero con pesoG ≤ hastaG; arriba del último → el último. Sin tramos o sin peso → null.
function tramoDe(tramos, pesoG) {
  const ts = lista(tramos);
  if (!ts.length || !(pesoG > 0)) return null;
  return ts.find(t => pesoG <= t.hastaG) || ts[ts.length - 1];
}
// Ajuste ± min/kg del peso (tabla vacía → 0).
const ajusteDe = (tramos, pesoG) => (tramoDe(tramos, pesoG) || { minKg: 0 }).minKg;

// PLUs de las bolsas (el router pide sus costos a SIGA).
const plusInsumos = cf => [...new Set(Object.values(objeto(cf.envasePorPeso)).map(e => objeto(e).bolsaPlu).filter(Boolean).map(String))];

// Envase del granel: 'bobina' si lo marcó, si no 'bolsa' (default).
const envaseDe = (cf, granel) => (objeto(objeto(cf.porGranel)[granel.plu]).envase === 'bobina' ? 'bobina' : 'bolsa');

// min/kg de un granel: el propio (porGranel, 0 vale) o el de su subrubro. → { minKg | null, origen: 'granel' | 'subrubro' | null }.
function minKgDe(cf, granel) {
  const propio = objeto(objeto(cf.porGranel)[granel.plu]).minKg;
  if (propio != null) return { minKg: propio, origen: 'granel' };
  const sub = granel.subrubroId != null ? objeto(objeto(cf.subrubros)[granel.subrubroId]).minKg : null;
  return sub != null ? { minKg: sub, origen: 'subrubro' } : { minKg: null, origen: null };
}

// Máquina del granel (sólo porGranel; sin máquina es lo normal) o null.
function maquinaDe(cf, granel) {
  const id = objeto(objeto(cf.porGranel)[granel.plu]).maquinaId;
  return (id && lista(cf.maquinas).find(m => m.id === id)) || null;
}

// Importe SIN redondear de una línea: insumo = cantidad × costo; minutos = minutos × costo hora ÷ 60 (sin costo → 0).
// El total y el $/kg salen de estos valores; el redondeo a 2 decimales es sólo para mostrar cada línea.
const crudoDe = l => (l.costoUnit == null ? 0 : l.cantidad * l.costoUnit / (l.rol === 'insumo' ? 1 : 60));
const lineaMinutos = (plu, nombre, rol, minutos, costoHora) => {
  const l = { plu, nombre, rol, cantidad: minutos, costoUnit: costoHora };
  return { ...l, importe: redondear2(crudoDe(l)) };
};
function lineasInsumos(usados, costoDe) { // usados = [{ plu, cantidad }]
  return usados.map(it => {
    const c = costoDe(String(it.plu));
    const costo = c ? Number(c.costo) : NaN;
    const costoUnit = Number.isFinite(costo) && costo > 0 ? costo : null;
    const l = { plu: String(it.plu), nombre: (c && c.nombre) || null, rol: 'insumo', origen: 'bolsa', cantidad: it.cantidad, costoUnit };
    return { ...l, importe: costoUnit == null ? null : redondear2(crudoDe(l)) };
  });
}

// Línea del envase del peso (o aviso sinBolsa / sinBobina sin dato). Bobina: cantidad = kg de bolsa, costoUnit = $/kg (null → faltante).
function envasePresentacion(cf, granel, pesoG, costoDe) {
  const e = objeto(objeto(cf.envasePorPeso)[String(pesoG)]);
  if (e.sinEnvase === true) return { lineas: [], aviso: null };
  if (envaseDe(cf, granel) === 'bolsa') {
    return e.bolsaPlu ? { lineas: lineasInsumos([{ plu: e.bolsaPlu, cantidad: 1 }], costoDe), aviso: null } : { lineas: [], aviso: 'sinBolsa' };
  }
  if (!e.bobinaG) return { lineas: [], aviso: 'sinBobina' };
  const l = { plu: CLAVE_BOBINA, nombre: 'Bobina', rol: 'insumo', origen: 'bobina', cantidad: redondear4(e.bobinaG / 1000), costoUnit: cf.costoBobinaKg };
  return { lineas: [{ ...l, importe: l.costoUnit == null ? null : redondear2(crudoDe(l)) }], aviso: null };
}

// Costo extra por unidad de una presentación. granel = { plu, subrubroId }; cf = normalizarCosteoFraccionado(...);
// costoDe(plu) → { costo, nombre } | null (costo del insumo en su tab).
// → { pesoG, minKg (null sin cargar), minKgOrigen, ajusteMinKg, minutos, lineas (rol 'insumo' | 'mo' | 'maquina'), porUnidad,
// extraKg, avisos, faltantes }. Insumo sin costo → faltante: porUnidad y extraKg null (sin sugerido, nunca 0). Sin min/kg →
// 0 min + aviso sinMinutos (el ajuste solo no genera minutos). Sin peso → sólo mercadería.
function costearPresentacion({ pesoG, granel = {}, cf, costoDe = () => null }) {
  const { minKg, origen } = minKgDe(cf, granel);
  if (!(pesoG > 0)) {
    return { pesoG: null, minKg, minKgOrigen: origen, ajusteMinKg: 0, minutos: 0, lineas: [], porUnidad: 0, extraKg: 0, avisos: ['sinPeso'], faltantes: [] };
  }
  const avisos = [];
  if (minKg == null) avisos.push('sinMinutos');
  const ajusteMinKg = ajusteDe(cf.tramosTiempo, pesoG);
  const minutos = minKg == null ? 0 : redondear4(Math.max(0, minKg + ajusteMinKg) * pesoG / 1000);
  if (minutos > 0 && cf.costoHora == null) avisos.push('costoHora');
  const { lineas: insumos, aviso } = envasePresentacion(cf, granel, pesoG, costoDe);
  if (aviso) avisos.push(aviso);
  const maquina = maquinaDe(cf, granel);
  const tiempo = minutos > 0 ? [lineaMinutos(CLAVE_MO, 'Mano de obra', 'mo', minutos, cf.costoHora),
    ...(maquina ? [lineaMinutos(CLAVE_MAQUINA, maquina.nombre, 'maquina', minutos, noNegativo(maquina.costoHora))] : [])] : [];
  const lineas = [...insumos, ...tiempo];
  const faltantes = insumos.filter(l => l.importe == null).map(l => l.plu);
  const crudo = faltantes.length ? null : lineas.reduce((s, l) => s + crudoDe(l), 0);
  return {
    pesoG, minKg, minKgOrigen: origen, ajusteMinKg, minutos, lineas,
    porUnidad: crudo == null ? null : redondear2(crudo),
    extraKg: crudo == null ? null : redondear2(crudo / (pesoG / 1000)), avisos, faltantes,
  };
}

// Costos por fuente del granel ($/kg) + el extra $/kg de la presentación. extra null (faltante) → ninguna fuente tiene costo.
function sumarExtraKg(costos, extraKg) {
  return Object.fromEntries(Object.entries(costos).map(([f, c]) => [f, c == null || extraKg == null ? null : redondear2(c + extraKg)]));
}

module.exports = {
  CLAVE_MO, CLAVE_MAQUINA, CLAVE_BOBINA, PESO_G, BASE_G, PLU_SIGA,
  normalizarCosteoFraccionado, pesoGDe, tramoDe, ajusteDe, plusInsumos, minKgDe, maquinaDe, envaseDe, costearPresentacion, sumarExtraKg,
};
