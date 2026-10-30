'use strict';
// ── Precios · validación del costeo de Fraccionado (spec 2026-10-21-precios-fraccionado-costeo-design §9;
// 2026-10-23-precios-fraccionado-peso-subrubro-design §2 y §4; 2026-10-29-precios-fraccionado-tiempos-historial-design) ──
// Puro: cada validar*/aplicar* recibe el body del PUT y devuelve lo nuevo para costeo.fraccionado, o tira con el campo
// inválido (routes/rutas_precios_fraccionado.js lo devuelve como { error }).
const { PESO_G, BASE_G, PLU_SIGA, normalizarCosteoFraccionado, pesoGDe, tramoDe } = require('./precios_fraccionado_costo');

const ID_SUBRUBRO = /^\d{1,9}$/;
const ID_MAQUINA = /^[a-z0-9-]{1,60}$/;
const BASE_ID_MAX = 50; // deja lugar al sufijo -2…-50 sin pasar de 60
const MAX_ITEMS = 50;
const MAX_TRAMOS = 20;
const MAX_SUBRUBROS = 500;
const MAX_PESOS = 200;
const NOMBRE_MAX = 60;
const MIN_KG_MAX = 600; // min/kg: 0 a 600 en subrubro/granel, -600 a 600 en el ajuste por tramo
const BOBINA_G_MAX = 1000; // supuesto (spec envase-bolsa-bobina)
const COSTO_BOBINA_MAX = 1e7;
const COSTO_HORA_MAX = 1e7;
// Claves de la forma vieja: el normalizador (lib/precios_fraccionado_costo) las ignora y no se vuelven a escribir. Lo viejo de
// cada subrubro / granel (facilidad, tramos, máquina del subrubro, tiempo) tampoco: fraccionadoConCambios escribe lo normalizado.
const CLAVES_VIEJAS = ['tiempos', 'facilidades', 'insumosSubrubro', 'insumosPresentacion', 'presentaciones', 'escalas', 'factorFacilidad', 'insumosPorPeso'];

const esNum = v => typeof v === 'number' && Number.isFinite(v);
const esObjeto = v => !!v && typeof v === 'object' && !Array.isArray(v);
const objeto = v => (esObjeto(v) ? v : {});
const sinClave = (o, k) => { const { [k]: _fuera, ...resto } = o; return resto; };
function exigirLista(v, campo, max) {
  if (!Array.isArray(v)) throw new Error(`${campo}: debe ser una lista`);
  if (v.length > max) throw new Error(`${campo}: máximo ${max}`);
  return v;
}

// Quién usa cada máquina: { [maquinaId]: { graneles } } (la máquina va sólo por granel).
function usosMaquinas({ porGranel = {} } = {}) {
  return Object.values(objeto(porGranel)).map(g => objeto(g).maquinaId).filter(Boolean)
    .reduce((u, id) => ({ ...u, [id]: { graneles: ((u[id] || {}).graneles || 0) + 1 } }), {});
}
const textoUsos = u => `${u.graneles} granel${u.graneles === 1 ? '' : 'es'}`;

// Id de una máquina nueva sacado del nombre (no cambia al renombrar): "Selladora Única" → 'selladora-unica'; repetido → -2, -3…
function idDesdeNombre(nombre, usados) {
  const base = nombre.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, BASE_ID_MAX).replace(/-$/, '') || 'maquina';
  let id = base;
  for (let n = 2; usados.has(id); n++) id = `${base}-${n}`;
  return id;
}

// body { maquinas: [{ id?, nombre, costoHora }] } → { maquinas } (lista completa). previo = costeo.fraccionado normalizado:
// una máquina que se saca y la usa un granel → error con su nombre.
function validarMaquinas(body, { maquinas: anteriores = [], porGranel = {} } = {}) {
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
  for (const [id, u] of Object.entries(usosMaquinas({ porGranel }))) {
    if (ids.has(id)) continue;
    const nombre = (anteriores.find(m => m.id === id) || {}).nombre || id;
    throw new Error(`La máquina ${nombre} la usan ${textoUsos(u)}: asignales otra antes de borrarla`);
  }
  return { maquinas };
}

const exigirMinKg = (v, campo, min) => {
  if (!esNum(v) || v < min || v > MIN_KG_MAX) throw new Error(`${campo}: número de ${min} a ${MIN_KG_MAX} (min/kg)`);
  return v;
};

// PUT tramos-tiempo body { tramos: [{ hastaG, minKg }] } → { tramosTiempo }. hastaG gramos enteros ascendentes; minKg ± (ajuste por
// kilo). El tramo que cubre 1 kg (BASE_G) es la base y tiene que valer 0. [] = sin ajuste.
function validarTramosTiempo(body) {
  const tramos = exigirLista(objeto(body).tramos, 'tramos', MAX_TRAMOS);
  let previo = 0;
  const tramosTiempo = tramos.map((t, i) => {
    const x = objeto(t);
    if (!Number.isInteger(x.hastaG) || x.hastaG <= previo) throw new Error(`tramos[${i}].hastaG: gramos enteros, mayores que el tramo anterior`);
    previo = x.hastaG;
    return { hastaG: x.hastaG, minKg: exigirMinKg(x.minKg, `tramos[${i}].minKg`, -MIN_KG_MAX) };
  });
  const base = tramoDe(tramosTiempo, BASE_G);
  if (base && base.minKg !== 0) throw new Error(`tramos: el tramo de ${BASE_G} g (hasta ${base.hastaG} g) es la base y tiene que valer 0`);
  return { tramosTiempo };
}

// PUT subrubros body { subrubros: { [id]: minKg | null } } (en lote; null = sacar) → subrubros nuevo.
function aplicarSubrubros(subrubros, body) {
  const cambios = objeto(body).subrubros;
  if (!esObjeto(cambios)) throw new Error('subrubros: debe ser un objeto { id: min/kg o null }');
  const entradas = Object.entries(cambios);
  if (entradas.length > MAX_SUBRUBROS) throw new Error(`subrubros: máximo ${MAX_SUBRUBROS}`);
  return entradas.reduce((acc, [id, v]) => {
    if (!ID_SUBRUBRO.test(id)) throw new Error(`subrubros: id ${id} inválido`);
    return v == null ? sinClave(acc, id) : { ...acc, [id]: { minKg: exigirMinKg(v, `subrubros.${id}`, 0) } };
  }, objeto(subrubros));
}

const exigirMaquina = (maquinaId, maquinas) => {
  if (typeof maquinaId !== 'string' || !(maquinas || []).some(m => m.id === maquinaId)) throw new Error(`maquinaId: ${maquinaId} no está en Configuración › Costeo Fraccionado › Máquinas`);
};
const ENVASES = ['bolsa', 'bobina'];
// PUT granel/:plu body { minKg?, maquinaId?, envase? } (ausente = no tocar, null = sacar) → porGranel nuevo. Sin nada → se borra la entrada.
function aplicarGranel(porGranel, plu, body, maquinas) {
  if (!PLU_SIGA.test(String(plu))) throw new Error('PLU inválido');
  if (!esObjeto(body)) throw new Error('body: debe ser un objeto');
  const previo = objeto(objeto(porGranel)[plu]);
  const conCampo = (g, k, validar) => (!(k in body) ? g : body[k] == null ? sinClave(g, k) : { ...g, [k]: validar(body[k]) });
  const minKg = conCampo(previo, 'minKg', v => exigirMinKg(v, 'minKg', 0));
  const conMaquina = conCampo(minKg, 'maquinaId', v => { exigirMaquina(v, maquinas); return v; });
  if ('envase' in body && body.envase != null && !ENVASES.includes(body.envase)) throw new Error("envase: 'bolsa' o 'bobina'");
  // 'bolsa' es el default: no se guarda
  const nuevo = !('envase' in body) ? conMaquina : body.envase === 'bobina' ? { ...conMaquina, envase: 'bobina' } : sinClave(conMaquina, 'envase');
  const resto = sinClave(objeto(porGranel), String(plu));
  return Object.keys(nuevo).length ? { ...resto, [plu]: nuevo } : resto;
}

// Un peso del PUT envase: { bolsaPlu?, bobinaG? } (ausente = no tocar, null o '' = sacar) → envasePorPeso nuevo. Sin
// ninguno de los dos se borra el peso. Hasta MAX_PESOS pesos (uno que ya está se puede cambiar siempre).
function aplicarEnvasePeso(envasePorPeso, pesoG, body) {
  const clave = String(pesoG);
  if (!PESO_G.test(clave)) throw new Error('peso inválido: gramos enteros mayores que 0 (hasta 6 cifras)');
  if (!esObjeto(body)) throw new Error('body: debe ser un objeto');
  const vacio = v => v == null || v === '';
  const conCampo = (e, k, validar) => (!(k in body) ? e : vacio(body[k]) ? sinClave(e, k) : { ...e, [k]: validar(body[k]) });
  const conBolsa = conCampo(objeto(objeto(envasePorPeso)[clave]), 'bolsaPlu', v => {
    const plu = String(v).trim();
    if (!PLU_SIGA.test(plu)) throw new Error(`bolsaPlu: el PLU de la bolsa tiene que ser un número de SIGA (hasta 12 dígitos), no "${String(v).slice(0, 20)}"`);
    return plu;
  });
  const nuevo = conCampo(conBolsa, 'bobinaG', v => {
    if (!esNum(v) || v <= 0 || v > BOBINA_G_MAX) throw new Error(`bobinaG: peso de la bolsa en gramos, mayor que 0 y hasta ${BOBINA_G_MAX}`);
    return v;
  });
  const resto = sinClave(objeto(envasePorPeso), clave);
  if (!Object.keys(nuevo).length) return resto;
  if (!(clave in objeto(envasePorPeso)) && Object.keys(resto).length >= MAX_PESOS) throw new Error(`envase por peso: máximo ${MAX_PESOS} pesos`);
  return { ...resto, [clave]: nuevo };
}

// PUT envase: { costoBobinaKg } → { costoBobinaKg }. null o '' = sin cargar; 0 se rechaza (sería costo 0 en silencio).
function validarCostoBobina(body) {
  const v = objeto(body).costoBobinaKg;
  if (v == null || v === '') return { costoBobinaKg: null };
  if (!esNum(v) || v <= 0 || v > COSTO_BOBINA_MAX) throw new Error('costoBobinaKg: número mayor que 0 ($ por kg de bobina), o vacío para sacarlo');
  return { costoBobinaKg: v };
}

// Corre aplicar y antepone de quién es el error ("peso 500: …", "graneles.123: …").
const conPrefijo = (prefijo, aplicar) => { try { return aplicar(); } catch (err) { throw new Error(`${prefijo}: ${err.message}`); } };
const MAX_GRANELES = 1000;

// PUT subrubros body { subrubros?: { [id]: minKg|null }, graneles?: { [plu]: minKg|null } } → { subrubros?, porGranel? }. graneles es
// el minKg propio del granel (mismas reglas que PUT granel/:plu). Todo o nada: tira antes de devolver si algo es inválido.
function aplicarTiempos(cf, body) {
  const { subrubros, graneles } = objeto(body);
  if (subrubros != null && !esObjeto(subrubros)) throw new Error('subrubros: debe ser un objeto { id: min/kg o null }');
  if (graneles != null && !esObjeto(graneles)) throw new Error('graneles: debe ser un objeto { plu: min/kg o null }');
  const nG = Object.keys(graneles || {}).length;
  if (!Object.keys(subrubros || {}).length && !nG) throw new Error('subrubros o graneles: mandá al menos un cambio');
  if (nG > MAX_GRANELES) throw new Error(`graneles: máximo ${MAX_GRANELES}`);
  const conSub = subrubros ? { subrubros: aplicarSubrubros(cf.subrubros, { subrubros }) } : {};
  if (!nG) return conSub;
  const porGranel = Object.entries(graneles).reduce((acc, [plu, v]) =>
    conPrefijo(`graneles.${plu}`, () => aplicarGranel(acc, plu, { minKg: v }, cf.maquinas)), cf.porGranel);
  return { ...conSub, porGranel };
}

// PUT envase body { costoBobinaKg?, pesos?: { [pesoG]: { bolsaPlu?, bobinaG? } } } → { envasePorPeso?, costoBobinaKg? }. Por peso igual
// que aplicarEnvasePeso; costoBobinaKg ausente = no tocar. Todo o nada.
function aplicarEnvase(cf, body) {
  const b = objeto(body);
  if (b.pesos != null && !esObjeto(b.pesos)) throw new Error('pesos: debe ser un objeto { pesoG: { bolsaPlu, bobinaG } }');
  const conCosto = 'costoBobinaKg' in b ? validarCostoBobina(b) : {};
  if (!b.pesos) return conCosto;
  const envasePorPeso = Object.entries(b.pesos).reduce((acc, [g, e]) =>
    conPrefijo(`peso ${g}`, () => aplicarEnvasePeso(acc, g, e)), cf.envasePorPeso);
  return { ...conCosto, envasePorPeso };
}

// envasePorPeso con el nombre y el costo (en su tab) de la bolsa, para Configuración. costoDe = lib/precios_listado_esquema
// crearCostoDe (sin fila en SIGA o sin costo → null).
const envaseConCosto = (envasePorPeso, costoDe) => Object.fromEntries(Object.entries(objeto(envasePorPeso)).map(([g, e]) => {
  const c = e.bolsaPlu ? costoDe(e.bolsaPlu) : null;
  const costo = c ? Number(c.costo) : NaN;
  return [g, { ...e, bolsaNombre: (c && c.nombre) || null, bolsaCosto: Number.isFinite(costo) && costo > 0 ? costo : null }];
}));

// costeo.fraccionado a escribir: lo normalizado (forma vieja ya convertida) sin las claves viejas + los cambios. Así un
// guardado cualquiera (aunque sea de máquinas) no pierde lo que sólo estaba en la forma vieja.
function fraccionadoConCambios(f, cambios) {
  const cf = normalizarCosteoFraccionado(f);
  const base = Object.fromEntries(Object.entries(objeto(f)).filter(([k]) => !CLAVES_VIEJAS.includes(k)));
  return { ...base, maquinas: cf.maquinas, tramosTiempo: cf.tramosTiempo, subrubros: cf.subrubros, envasePorPeso: cf.envasePorPeso,
    costoBobinaKg: cf.costoBobinaKg, porGranel: cf.porGranel, ...cambios };
}

// Grupos del listado (lib/precios_listado_esquema agruparPorGranel; el "sin granel" no entra: no se costea) → { subrubrosSiga:
// [{ id, nombre, graneles: [{ plu, nombre, presentaciones: [{ plu, nombre, pesoG }] }] }] (A→Z), sinSubrubro: [granel…],
// pesos: [{ pesoG, presentaciones: n }] (ascendente; sin peso no entra) }: la lista de productos y la tabla de envase por
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

module.exports = { usosMaquinas, validarMaquinas, validarTramosTiempo, aplicarTiempos, aplicarGranel, aplicarEnvase,
  envaseConCosto, fraccionadoConCambios, productosPorSubrubro };
