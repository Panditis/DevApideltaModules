'use strict';
// ── Precios · costo real de una presentación de Fraccionado (spec 2026-10-21-precios-fraccionado-costeo-design §9) ──
// Puro (sin I/O). Por unidad: insumos de la presentación + mano de obra + máquina, con minutos = minutos base del tramo de
// peso del subrubro del granel × factor del tiempo × factor de la facilidad de la presentación. Máquina = la del granel
// (excepción) o la de su subrubro. Se pasa a $/kg con el peso para sumarlo al $/kg del granel: el motor (lib/precios_esquema)
// y el ajuste por peso siguen trabajando en $/kg.
const { redondear2 } = require('./precios_costeo');

const FACILIDADES = Object.freeze(['facil', 'normal', 'dificil']);
const TIEMPOS = Object.freeze(['rapido', 'normal', 'lento']);
const ESCALAS_DEFECTO = Object.freeze({
  facilidad: Object.freeze({ facil: 1, normal: 1.25, dificil: 1.5 }),
  tiempo: Object.freeze({ rapido: 0.75, normal: 1, lento: 1.5 }),
});
const CLAVE_MO = '_manoObra';
const CLAVE_MAQUINA = '_maquina';

const objeto = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const lista = v => (Array.isArray(v) ? v : []);
const noNegativo = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const redondear4 = n => Math.round(n * 10000) / 10000;

// Forma vieja (2026-10-21 mañana) que se lee y se reescribe con la nueva en el próximo guardado
// (lib/precios_config_fraccionado fraccionadoConCambios): facilidades { facil, medio, dificil } → escalas.facilidad (medio →
// normal); insumosPresentacion[plu] → presentaciones[plu].insumos. tiempos global, insumosSubrubro y la facilidad por granel
// se descartan.
function escalasDe(x) {
  const v = objeto(x.facilidades);
  const viejas = Object.fromEntries([['facil', v.facil], ['normal', v.medio], ['dificil', v.dificil]].filter(([, n]) => n != null));
  const e = objeto(x.escalas);
  return { facilidad: { ...ESCALAS_DEFECTO.facilidad, ...viejas, ...objeto(e.facilidad) }, tiempo: { ...ESCALAS_DEFECTO.tiempo, ...objeto(e.tiempo) } };
}
function presentacionesDe(x) {
  const viejas = Object.fromEntries(Object.entries(objeto(x.insumosPresentacion)).filter(([, l]) => lista(l).length).map(([plu, l]) => [plu, { insumos: lista(l) }]));
  const nuevas = Object.entries(objeto(x.presentaciones)).map(([plu, p]) => [plu, { ...(viejas[plu] || {}), ...objeto(p) }]);
  return { ...viejas, ...Object.fromEntries(nuevas) };
}
const porGranelDe = x => Object.fromEntries(Object.entries(objeto(x.porGranel))
  .filter(([, g]) => objeto(g).maquinaId).map(([plu, g]) => [plu, { maquinaId: g.maquinaId }]));
const subrubrosDe = x => Object.fromEntries(Object.entries(objeto(x.subrubros))
  .map(([id, s]) => [id, { maquinaId: objeto(s).maquinaId ?? null, tramos: lista(objeto(s).tramos) }]));

// costeo.fraccionado con defaults (sin migrar o a medio cargar → mapas vacíos y escalas por defecto) y la forma vieja convertida.
function normalizarCosteoFraccionado(f) {
  const x = objeto(f);
  return { costoHora: noNegativo(x.costoHora), maquinas: lista(x.maquinas), escalas: escalasDe(x), subrubros: subrubrosDe(x),
    presentaciones: presentacionesDe(x), porGranel: porGranelDe(x) };
}

// Tramos [{ hastaG, … }] ascendentes: el primero con pesoG ≤ hastaG; arriba del último → el último. Sin tramos o sin peso → null.
function tramoDe(tramos, pesoG) {
  const ts = lista(tramos);
  if (!ts.length || !(pesoG > 0)) return null;
  return ts.find(t => pesoG <= t.hastaG) || ts[ts.length - 1];
}

// PLUs de los insumos de las presentaciones (el router pide sus costos a SIGA).
const plusInsumos = cf => [...new Set(Object.values(objeto(cf.presentaciones)).flatMap(p => lista(objeto(p).insumos)).map(it => String(it.plu)))];

// Máquina de un granel: la suya (excepción, porGranel) o la de su subrubro. → { maquina | null, origen: 'granel' | 'subrubro' | null }.
function maquinaDe(cf, granel) {
  const propia = objeto(cf.porGranel[granel.plu]).maquinaId;
  const id = propia || objeto(cf.subrubros[granel.subrubroId]).maquinaId;
  return { maquina: cf.maquinas.find(m => m.id === id) || null, origen: propia ? 'granel' : id ? 'subrubro' : null };
}

// Importe SIN redondear de una línea: insumo = cantidad × costo; minutos = minutos × costo hora ÷ 60 (sin costo → 0).
// El total y el $/kg salen de estos valores; el redondeo a 2 decimales es sólo para mostrar cada línea.
const crudoDe = l => (l.costoUnit == null ? 0 : l.cantidad * l.costoUnit / (l.rol === 'insumo' ? 1 : 60));
const lineaMinutos = (plu, nombre, rol, minutos, costoHora) => {
  const l = { plu, nombre, rol, cantidad: minutos, costoUnit: costoHora };
  return { ...l, importe: redondear2(crudoDe(l)) };
};

// Costo extra por unidad de una presentación. granel = { plu, subrubroId }; cf = normalizarCosteoFraccionado(...);
// costoDe(plu) → { costo, nombre } | null (costo del insumo en su tab). → { pesoG, facilidad, tiempo (los elegidos), minutos,
// minutosBase (del tramo, 0 sin tramo), factorTiempo, factorFacilidad (1 sin elegir), lineas (rol 'insumo' | 'mo' | 'maquina'),
// porUnidad, extraKg, avisos, faltantes }. Insumo sin costo → faltante: porUnidad y extraKg null (la presentación queda sin
// sugerido, nunca 0). Lo demás que falte va en 0 (o factor 1) con un aviso (spec §9.2). Sin peso → sólo mercadería.
function costearPresentacion({ plu, pesoG, granel = {}, cf, costoDe = () => null }) {
  const datos = objeto(cf.presentaciones[plu]);
  const elegidos = { facilidad: datos.facilidad ?? null, tiempo: datos.tiempo ?? null };
  if (!(pesoG > 0)) {
    return { pesoG: null, ...elegidos, minutos: 0, minutosBase: 0, factorTiempo: 1, factorFacilidad: 1, lineas: [], porUnidad: 0, extraKg: 0, avisos: ['sinPeso'], faltantes: [] };
  }
  const avisos = [];
  const conSubrubro = granel.subrubroId != null;
  if (!conSubrubro) avisos.push('sinSubrubro');
  const tramo = conSubrubro ? tramoDe(objeto(cf.subrubros[granel.subrubroId]).tramos, pesoG) : null;
  if (conSubrubro && !tramo) avisos.push('sinTramos');
  const fT = cf.escalas.tiempo[datos.tiempo], fF = cf.escalas.facilidad[datos.facilidad];
  if (!(fT > 0)) avisos.push('sinTiempo');
  if (!(fF > 0)) avisos.push('sinFacilidad');
  const factorTiempo = fT > 0 ? fT : 1, factorFacilidad = fF > 0 ? fF : 1;
  const minutosBase = tramo ? tramo.minutos : 0;
  const minutos = tramo ? redondear4(minutosBase * factorTiempo * factorFacilidad) : 0;
  const { maquina } = maquinaDe(cf, granel);
  if (!maquina) avisos.push('sinMaquina');
  if (minutos > 0 && cf.costoHora == null) avisos.push('costoHora');
  const usados = lista(datos.insumos);
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
    pesoG, ...elegidos, minutos, minutosBase, factorTiempo, factorFacilidad, lineas,
    porUnidad: crudo == null ? null : redondear2(crudo),
    extraKg: crudo == null ? null : redondear2(crudo / (pesoG / 1000)), avisos, faltantes,
  };
}

// Costos por fuente del granel ($/kg) + el extra $/kg de la presentación. extra null (faltante) → ninguna fuente tiene costo.
function sumarExtraKg(costos, extraKg) {
  return Object.fromEntries(Object.entries(costos).map(([f, c]) => [f, c == null || extraKg == null ? null : redondear2(c + extraKg)]));
}

module.exports = {
  FACILIDADES, TIEMPOS, ESCALAS_DEFECTO, CLAVE_MO, CLAVE_MAQUINA,
  normalizarCosteoFraccionado, tramoDe, plusInsumos, maquinaDe, costearPresentacion, sumarExtraKg,
};
