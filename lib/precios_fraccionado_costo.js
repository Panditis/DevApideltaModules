'use strict';
// ── Precios · costo real de una presentación de Fraccionado (spec 2026-10-21-precios-fraccionado-costeo-design §9;
// 2026-10-23-precios-fraccionado-peso-subrubro-design §3) ──
// Puro (sin I/O). Por unidad: insumos de su peso (insumosPorPeso, global) + mano de obra + máquina, con minutos = minutos
// base del tramo de peso del subrubro del granel × factor del tiempo × factor de la facilidad del subrubro. Máquina = la del granel
// (excepción) o la de su subrubro. Se pasa a $/kg con el peso para sumarlo al $/kg del granel: el motor (lib/precios_esquema)
// y el ajuste por peso siguen trabajando en $/kg.
const { redondear2 } = require('./precios_costeo');
const { pesoTokenKg } = require('./producto_carga');

const FACILIDADES = Object.freeze(['facil', 'normal', 'dificil']);
const TIEMPOS = Object.freeze(['rapido', 'normal', 'lento']);
const ESCALAS_DEFECTO = Object.freeze({
  facilidad: Object.freeze({ facil: 1, normal: 1.25, dificil: 1.5 }),
  tiempo: Object.freeze({ rapido: 0.75, normal: 1, lento: 1.5 }),
});
const CLAVE_MO = '_manoObra';
const CLAVE_MAQUINA = '_maquina';
const PESO_G = /^[1-9]\d{0,5}$/; // clave de insumosPorPeso: gramos enteros > 0 (sin ceros adelante: tiene que ser String(pesoG))

const objeto = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const lista = v => (Array.isArray(v) ? v : []);
const noNegativo = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const redondear4 = n => Math.round(n * 10000) / 10000;

// Forma vieja (2026-10-21 mañana) que se lee y se reescribe con la nueva en el próximo guardado
// (lib/precios_config_fraccionado fraccionadoConCambios): facilidades { facil, medio, dificil } → escalas.facilidad (medio →
// normal). tiempos global, insumosSubrubro, insumosPresentacion, presentaciones (por PLU, 2026-10-21) y la facilidad por
// granel se descartan (nada de eso llegó a producción).
const esFactor = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
// Un factor por id conocido (nada más: sin claves ajenas ni 'medio'): el primero válido (número > 0) de las fuentes, o el default.
const factoresDe = (ids, defecto, fuentes) => Object.fromEntries(ids.map(id => [id, fuentes.map(f => f[id]).find(esFactor) ?? defecto[id]]));
function escalasDe(x) {
  const v = objeto(x.facilidades), e = objeto(x.escalas);
  return {
    facilidad: factoresDe(FACILIDADES, ESCALAS_DEFECTO.facilidad, [objeto(e.facilidad), { facil: v.facil, normal: v.medio, dificil: v.dificil }]),
    tiempo: factoresDe(TIEMPOS, ESCALAS_DEFECTO.tiempo, [objeto(e.tiempo)]),
  };
}
const insumosPorPesoDe = x => Object.fromEntries(Object.entries(objeto(x.insumosPorPeso)).filter(([g, l]) => PESO_G.test(g) && Array.isArray(l)));
const porGranelDe = x => Object.fromEntries(Object.entries(objeto(x.porGranel))
  .filter(([, g]) => objeto(g).maquinaId).map(([plu, g]) => [plu, { maquinaId: g.maquinaId }]));
// facilidad / tiempo sólo si son un id conocido (ausente = sin elegir).
const elegido = (v, ids, k) => (ids.includes(v) ? { [k]: v } : {});
const subrubrosDe = x => Object.fromEntries(Object.entries(objeto(x.subrubros)).map(([id, v]) => {
  const s = objeto(v);
  return [id, { maquinaId: s.maquinaId ?? null, tramos: lista(s.tramos), ...elegido(s.facilidad, FACILIDADES, 'facilidad'), ...elegido(s.tiempo, TIEMPOS, 'tiempo') }];
}));

// costeo.fraccionado con defaults (sin migrar o a medio cargar → mapas vacíos y escalas por defecto) y la forma vieja convertida.
function normalizarCosteoFraccionado(f) {
  const x = objeto(f);
  return { costoHora: noNegativo(x.costoHora), maquinas: lista(x.maquinas), escalas: escalasDe(x), subrubros: subrubrosDe(x),
    insumosPorPeso: insumosPorPesoDe(x), porGranel: porGranelDe(x) };
}

// Gramos enteros del peso del nombre ("Almendra 500G" → 500); sin peso → null. Es la clave de insumosPorPeso.
const pesoGDe = nombre => { const kg = pesoTokenKg(nombre); return kg > 0 ? Math.round(kg * 1000) : null; };

// Tramos [{ hastaG, … }] ascendentes: el primero con pesoG ≤ hastaG; arriba del último → el último. Sin tramos o sin peso → null.
function tramoDe(tramos, pesoG) {
  const ts = lista(tramos);
  if (!ts.length || !(pesoG > 0)) return null;
  return ts.find(t => pesoG <= t.hastaG) || ts[ts.length - 1];
}

// PLUs de los insumos por peso (el router pide sus costos a SIGA).
const plusInsumos = cf => [...new Set(Object.values(objeto(cf.insumosPorPeso)).flatMap(lista).map(it => String(it.plu)))];

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
// costoDe(plu) → { costo, nombre } | null (costo del insumo en su tab). plu no se usa (los insumos son los de su peso).
// → { pesoG, facilidad, tiempo (los del subrubro, null sin elegir), minutos,
// minutosBase (del tramo, 0 sin tramo), factorTiempo, factorFacilidad (1 sin elegir), lineas (rol 'insumo' | 'mo' | 'maquina'),
// porUnidad, extraKg, avisos, faltantes }. Insumo sin costo → faltante: porUnidad y extraKg null (la presentación queda sin
// sugerido, nunca 0). Lo demás que falte va en 0 (o factor 1) con un aviso (spec §9.2). Sin peso → sólo mercadería.
function costearPresentacion({ pesoG, granel = {}, cf, costoDe = () => null }) {
  const sub = granel.subrubroId != null ? objeto(cf.subrubros[granel.subrubroId]) : {};
  const elegidos = { facilidad: sub.facilidad ?? null, tiempo: sub.tiempo ?? null };
  if (!(pesoG > 0)) {
    return { pesoG: null, ...elegidos, minutos: 0, minutosBase: 0, factorTiempo: 1, factorFacilidad: 1, lineas: [], porUnidad: 0, extraKg: 0, avisos: ['sinPeso'], faltantes: [] };
  }
  const avisos = [];
  const conSubrubro = granel.subrubroId != null;
  if (!conSubrubro) avisos.push('sinSubrubro');
  const tramo = conSubrubro ? tramoDe(sub.tramos, pesoG) : null;
  if (conSubrubro && !tramo) avisos.push('sinTramos');
  const fT = cf.escalas.tiempo[sub.tiempo], fF = cf.escalas.facilidad[sub.facilidad];
  const { maquina } = maquinaDe(cf, granel);
  // Sin tramo no hay minutos: lo único que importa es el subrubro / los tramos (sinSubrubro, sinTramos); avisar además el
  // tiempo, la facilidad o la máquina que faltan sería ruido.
  if (tramo) {
    if (!(fT > 0)) avisos.push('sinTiempo');
    if (!(fF > 0)) avisos.push('sinFacilidad');
    if (!maquina) avisos.push('sinMaquina');
  }
  const factorTiempo = fT > 0 ? fT : 1, factorFacilidad = fF > 0 ? fF : 1;
  const minutosBase = tramo ? tramo.minutos : 0;
  const minutos = tramo ? redondear4(minutosBase * factorTiempo * factorFacilidad) : 0;
  if (minutos > 0 && cf.costoHora == null) avisos.push('costoHora');
  const usados = lista(objeto(cf.insumosPorPeso)[String(pesoG)]);
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
  FACILIDADES, TIEMPOS, ESCALAS_DEFECTO, CLAVE_MO, CLAVE_MAQUINA, PESO_G,
  normalizarCosteoFraccionado, pesoGDe, tramoDe, plusInsumos, maquinaDe, costearPresentacion, sumarExtraKg,
};
