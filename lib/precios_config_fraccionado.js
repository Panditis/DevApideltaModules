'use strict';
// ── Precios · validación del costeo de Fraccionado (spec 2026-10-21-precios-fraccionado-costeo-design §9;
// 2026-10-23-precios-fraccionado-peso-subrubro-design §2 y §4) ──
// Puro: cada validar*/aplicar* recibe el body del PUT y devuelve lo nuevo para costeo.fraccionado, o tira con el campo
// inválido (routes/rutas_precios_fraccionado.js lo devuelve como { error }).
const { FACILIDADES, TIEMPOS, PESO_G, normalizarCosteoFraccionado, pesoGDe } = require('./precios_fraccionado_costo');

const PLU_SIGA = /^\d{1,12}$/;
const ID_SUBRUBRO = /^\d{1,9}$/;
const ID_MAQUINA = /^[a-z0-9-]{1,60}$/;
const BASE_ID_MAX = 50; // deja lugar al sufijo -2…-50 sin pasar de 60
const MAX_ITEMS = 50;
const MAX_TRAMOS = 20;
const MAX_PESOS = 200;
const NOMBRE_MAX = 60;
const MINUTOS_MAX = 600;
const FACTOR_MAX = 10;
const CANTIDAD_MAX = 1000;
const COSTO_HORA_MAX = 1e7;
// Claves de la forma vieja (lib/precios_fraccionado_costo las lee): no se vuelven a escribir.
const CLAVES_VIEJAS = ['tiempos', 'facilidades', 'insumosSubrubro', 'insumosPresentacion', 'presentaciones'];

const esNum = v => typeof v === 'number' && Number.isFinite(v);
const esObjeto = v => !!v && typeof v === 'object' && !Array.isArray(v);
const objeto = v => (esObjeto(v) ? v : {});
const sinClave = (o, k) => { const { [k]: _fuera, ...resto } = o; return resto; };
function exigirLista(v, campo, max) {
  if (!Array.isArray(v)) throw new Error(`${campo}: debe ser una lista`);
  if (v.length > max) throw new Error(`${campo}: máximo ${max}`);
  return v;
}

// Quién usa cada máquina: { [maquinaId]: { graneles, subrubros } } (excepciones por granel y máquina de cada subrubro).
function usosMaquinas({ porGranel = {}, subrubros = {} } = {}) {
  const usos = {}; // ponytail: acumulador local
  const sumar = (id, k) => { if (id) usos[id] = { graneles: 0, subrubros: 0, ...usos[id], [k]: ((usos[id] || {})[k] || 0) + 1 }; };
  Object.values(objeto(porGranel)).forEach(g => sumar(objeto(g).maquinaId, 'graneles'));
  Object.values(objeto(subrubros)).forEach(s => sumar(objeto(s).maquinaId, 'subrubros'));
  return usos;
}
const textoUsos = u => [u.subrubros ? `${u.subrubros} subrubro${u.subrubros === 1 ? '' : 's'}` : '',
  u.graneles ? `${u.graneles} granel${u.graneles === 1 ? '' : 'es'}` : ''].filter(Boolean).join(' y ');

// Id de una máquina nueva sacado del nombre (no cambia al renombrar): "Selladora Única" → 'selladora-unica'; repetido → -2, -3…
function idDesdeNombre(nombre, usados) {
  const base = nombre.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, BASE_ID_MAX).replace(/-$/, '') || 'maquina';
  let id = base;
  for (let n = 2; usados.has(id); n++) id = `${base}-${n}`;
  return id;
}

// body { maquinas: [{ id?, nombre, costoHora }] } → { maquinas } (lista completa). previo = costeo.fraccionado normalizado:
// una máquina que se saca y la usa un subrubro o un granel → error con su nombre.
function validarMaquinas(body, { maquinas: anteriores = [], porGranel = {}, subrubros = {} } = {}) {
  const entrada = exigirLista(objeto(body).maquinas, 'maquinas', MAX_ITEMS);
  const usados = new Set(entrada.map(m => objeto(m).id).filter(id => typeof id === 'string' && id));
  const maquinas = entrada.map((m, i) => {
    const x = objeto(m);
    const nombre = typeof x.nombre === 'string' ? x.nombre.trim() : '';
    if (!nombre || nombre.length > NOMBRE_MAX) throw new Error(`maquinas[${i}].nombre: texto de 1 a ${NOMBRE_MAX} caracteres`);
    if (!esNum(x.costoHora) || x.costoHora < 0 || x.costoHora > COSTO_HORA_MAX) throw new Error(`maquinas[${i}].costoHora: número desde 0 ($ por hora)`);
    const nuevo = x.id == null || x.id === '';
    if (!nuevo && !(typeof x.id === 'string' && ID_MAQUINA.test(x.id))) throw new Error(`maquinas[${i}].id: 1 a 60 caracteres entre a-z, 0-9 y guion`);
    const id = nuevo ? idDesdeNombre(nombre, usados) : x.id;
    usados.add(id);
    return { id, nombre, costoHora: x.costoHora };
  });
  const ids = new Set(maquinas.map(m => m.id));
  if (ids.size !== maquinas.length) throw new Error('maquinas: id repetido');
  for (const [id, u] of Object.entries(usosMaquinas({ porGranel, subrubros }))) {
    if (ids.has(id)) continue;
    const nombre = (anteriores.find(m => m.id === id) || {}).nombre || id;
    throw new Error(`La máquina ${nombre} la usan ${textoUsos(u)}: asignales otra antes de borrarla`);
  }
  return { maquinas };
}

// Tramos ascendentes por hastaG (gramos enteros > 0, cada uno mayor que el anterior) con sus minutos base por unidad.
function validarTramos(tramos, campo) {
  exigirLista(tramos, campo, MAX_TRAMOS);
  let previo = 0;
  return tramos.map((t, i) => {
    const x = objeto(t);
    if (!Number.isInteger(x.hastaG) || x.hastaG <= previo) throw new Error(`${campo}[${i}].hastaG: gramos enteros, mayores que el tramo anterior`);
    if (!esNum(x.minutos) || x.minutos < 0 || x.minutos > MINUTOS_MAX) throw new Error(`${campo}[${i}].minutos: número de 0 a ${MINUTOS_MAX}`);
    previo = x.hastaG;
    return { hastaG: x.hastaG, minutos: x.minutos };
  });
}

const factores = (v, ids, campo) => {
  const x = objeto(v);
  return Object.fromEntries(ids.map(k => {
    if (!esNum(x[k]) || x[k] <= 0 || x[k] > FACTOR_MAX) throw new Error(`${campo}.${k}: número mayor que 0 y hasta ${FACTOR_MAX}`);
    return [k, x[k]];
  }));
};
// body { escalas: { facilidad: { facil, normal, dificil }, tiempo: { rapido, normal, lento } } } → { escalas }.
function validarEscalas(body) {
  const e = objeto(objeto(body).escalas);
  return { escalas: { facilidad: factores(e.facilidad, FACILIDADES, 'escalas.facilidad'), tiempo: factores(e.tiempo, TIEMPOS, 'escalas.tiempo') } };
}

const exigirMaquina = (maquinaId, maquinas) => {
  if (maquinaId !== null && !(maquinas || []).some(m => m.id === maquinaId)) throw new Error(`maquinaId: ${maquinaId} no está en Configuración › Costeo Fraccionado › Máquinas`);
};
// PUT subrubros/:id body { maquinaId, tramos, facilidad, tiempo } (facilidad / tiempo: un id o null = sin elegir) → subrubros
// nuevo. Sin máquina, sin tramos, sin facilidad y sin tiempo → se borra la entrada.
const OPCIONES = { facilidad: FACILIDADES, tiempo: TIEMPOS };
function aplicarSubrubro(subrubros, id, body, maquinas) {
  if (!ID_SUBRUBRO.test(String(id))) throw new Error('subrubro inválido');
  if (!esObjeto(body)) throw new Error('body: debe ser un objeto');
  const maquinaId = body.maquinaId ?? null;
  exigirMaquina(maquinaId, maquinas);
  const tramos = validarTramos(body.tramos ?? [], 'tramos');
  for (const [k, ids] of Object.entries(OPCIONES)) {
    if (body[k] != null && !ids.includes(body[k])) throw new Error(`${k}: ${ids.join(', ')} o null`);
  }
  const elegidos = Object.fromEntries(Object.keys(OPCIONES).filter(k => body[k] != null).map(k => [k, body[k]]));
  const resto = sinClave(objeto(subrubros), String(id));
  const vacio = maquinaId == null && !tramos.length && !Object.keys(elegidos).length;
  return vacio ? resto : { ...resto, [id]: { maquinaId, tramos, ...elegidos } };
}

// PUT granel/:plu body { maquinaId } (excepción de la máquina del subrubro; null = sacarla) → porGranel nuevo.
function aplicarGranel(porGranel, plu, body, maquinas) {
  if (!PLU_SIGA.test(String(plu))) throw new Error('PLU inválido');
  if (!esObjeto(body)) throw new Error('body: debe ser un objeto');
  const maquinaId = body.maquinaId ?? null;
  exigirMaquina(maquinaId, maquinas);
  const resto = sinClave(objeto(porGranel), String(plu));
  return maquinaId == null ? resto : { ...resto, [plu]: { maquinaId } };
}

// Insumos por unidad [{ plu, cantidad }]: PLU de SIGA, cantidad > 0, sin repetir.
function validarListaInsumos(v, campo) {
  exigirLista(v, campo, MAX_ITEMS);
  const vistos = new Set();
  return v.map((it, i) => {
    const x = objeto(it);
    const plu = String(x.plu ?? '').trim();
    if (!PLU_SIGA.test(plu)) throw new Error(`${campo}[${i}].plu: PLU de SIGA`);
    if (vistos.has(plu)) throw new Error(`${campo}[${i}].plu: ${plu} repetido`);
    vistos.add(plu);
    if (!esNum(x.cantidad) || x.cantidad <= 0 || x.cantidad > CANTIDAD_MAX) throw new Error(`${campo}[${i}].cantidad: número mayor que 0 y hasta ${CANTIDAD_MAX}`);
    return { plu, cantidad: x.cantidad };
  });
}

// PUT insumos-peso/:pesoG body { insumos: [{ plu, cantidad }] } → insumosPorPeso nuevo. [] o null saca el peso. pesoG = gramos
// enteros > 0 (la clave que busca costearPresentacion). Hasta MAX_PESOS pesos (uno que ya está se puede cambiar siempre).
function aplicarInsumosPeso(insumosPorPeso, pesoG, body) {
  const clave = String(pesoG);
  if (!PESO_G.test(clave)) throw new Error('peso inválido: gramos enteros mayores que 0 (hasta 6 cifras)');
  if (!esObjeto(body)) throw new Error('body: debe ser un objeto');
  const insumos = body.insumos == null ? [] : validarListaInsumos(body.insumos, 'insumos');
  const resto = sinClave(objeto(insumosPorPeso), clave);
  if (!insumos.length) return resto;
  if (Object.keys(resto).length >= MAX_PESOS) throw new Error(`insumos por peso: máximo ${MAX_PESOS} pesos`);
  return { ...resto, [clave]: insumos };
}

// insumosPorPeso con el nombre y el costo (en su tab) de cada insumo, para Configuración. costoDe = lib/precios_listado_esquema
// crearCostoDe (sin fila en SIGA → null: nombre y costo null).
const insumosConCosto = (insumosPorPeso, costoDe) => Object.fromEntries(Object.entries(objeto(insumosPorPeso)).map(([g, l]) => [g,
  l.map(it => { const c = costoDe(it.plu); return { plu: it.plu, cantidad: it.cantidad, nombre: c ? c.nombre : null, costo: c ? c.costo : null }; })]));

// costeo.fraccionado a escribir: lo normalizado (forma vieja ya convertida) sin las claves viejas + los cambios. Así un
// guardado cualquiera (aunque sea de máquinas) no pierde lo que sólo estaba en la forma vieja.
function fraccionadoConCambios(f, cambios) {
  const cf = normalizarCosteoFraccionado(f);
  const base = Object.fromEntries(Object.entries(objeto(f)).filter(([k]) => !CLAVES_VIEJAS.includes(k)));
  return { ...base, maquinas: cf.maquinas, escalas: cf.escalas, subrubros: cf.subrubros, insumosPorPeso: cf.insumosPorPeso, porGranel: cf.porGranel, ...cambios };
}

// Grupos del listado (lib/precios_listado_esquema agruparPorGranel; el "sin granel" no entra: no se costea) → { subrubrosSiga:
// [{ id, nombre, graneles: [{ plu, nombre, presentaciones: [{ plu, nombre, pesoG }] }] }] (A→Z), sinSubrubro: [granel…],
// pesos: [{ pesoG, presentaciones: n }] (ascendente; sin peso no entra) }: la lista de productos y la tabla de insumos por
// peso de Configuración › Costeo Fraccionado.
function productosPorSubrubro(grupos) {
  const granel = g => ({ plu: g.plu, nombre: g.nombre, presentaciones: (g.presentaciones || []).map(p => ({ plu: p.plu, nombre: p.nombre, pesoG: pesoGDe(p.nombre) })) });
  const conPlu = (grupos || []).filter(g => g.plu != null);
  const cuenta = conPlu.flatMap(g => granel(g).presentaciones).filter(p => p.pesoG != null)
    .reduce((m, p) => m.set(p.pesoG, (m.get(p.pesoG) || 0) + 1), new Map());
  const porId = new Map();
  for (const g of conPlu.filter(x => x.subrubroId != null)) {
    const s = porId.get(g.subrubroId) || { id: g.subrubroId, nombre: g.subrubro || `Subrubro ${g.subrubroId}`, graneles: [] };
    porId.set(g.subrubroId, { ...s, graneles: [...s.graneles, granel(g)] });
  }
  return { subrubrosSiga: [...porId.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
    sinSubrubro: conPlu.filter(g => g.subrubroId == null).map(granel),
    pesos: [...cuenta].sort((a, b) => a[0] - b[0]).map(([pesoG, presentaciones]) => ({ pesoG, presentaciones })) };
}

module.exports = { usosMaquinas, validarMaquinas, validarEscalas, aplicarSubrubro, aplicarGranel, validarListaInsumos,
  aplicarInsumosPeso, insumosConCosto, fraccionadoConCambios, productosPorSubrubro };
