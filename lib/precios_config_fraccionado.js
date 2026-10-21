'use strict';
// ── Precios · validación de Configuración › Fraccionado (spec 2026-10-21-precios-fraccionado-costeo-design §2.5) ──
// Puro: cada validar*/aplicar* recibe el body del PUT y devuelve lo nuevo para costeo.fraccionado, o tira con el campo
// inválido (routes/rutas_precios_fraccionado.js lo devuelve como { error }).
const { FACILIDADES } = require('./precios_fraccionado_costo');

const PLU_SIGA = /^\d{1,12}$/;
const ID_SUBRUBRO = /^\d{1,9}$/;
const MAX_ITEMS = 50;
const MAX_TRAMOS = 20;
const NOMBRE_MAX = 60;
const MINUTOS_MAX = 600;
const FACTOR_MAX = 10;
const CANTIDAD_MAX = 1000;
const COSTO_HORA_MAX = 1e7;

const esNum = v => typeof v === 'number' && Number.isFinite(v);
const esObjeto = v => !!v && typeof v === 'object' && !Array.isArray(v);
const objeto = v => (esObjeto(v) ? v : {});
const ID_MAQUINA = /^[a-z0-9-]{1,60}$/;
const BASE_ID_MAX = 50; // deja lugar al sufijo -2…-50 sin pasar de 60
function exigirLista(v, campo, max) {
  if (!Array.isArray(v)) throw new Error(`${campo}: debe ser una lista`);
  if (v.length > max) throw new Error(`${campo}: máximo ${max}`);
  return v;
}

// Cuántos graneles usan cada máquina: { [maquinaId]: n }.
const usosMaquinas = porGranel => Object.values(objeto(porGranel)).reduce((acc, g) => {
  const id = objeto(g).maquinaId;
  return id ? { ...acc, [id]: (acc[id] || 0) + 1 } : acc;
}, {});

// Id de una máquina nueva sacado del nombre (no cambia al renombrar): "Selladora Única" → 'selladora-unica'; repetido → -2, -3…
function idDesdeNombre(nombre, usados) {
  const base = nombre.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, BASE_ID_MAX).replace(/-$/, '') || 'maquina';
  let id = base;
  for (let n = 2; usados.has(id); n++) id = `${base}-${n}`;
  return id;
}

// body { maquinas: [{ id?, nombre, costoHora }] } → { maquinas } (lista completa). previo = costeo.fraccionado normalizado:
// una máquina que se saca y algún granel usa → error con su nombre.
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
  for (const [id, n] of Object.entries(usosMaquinas(porGranel))) {
    if (ids.has(id)) continue;
    const nombre = (anteriores.find(m => m.id === id) || {}).nombre || id;
    throw new Error(`La máquina ${nombre} la usan ${n} granel${n === 1 ? '' : 'es'}: asignales otra antes de borrarla`);
  }
  return { maquinas };
}

// Tramos ascendentes por hastaG (gramos enteros > 0, cada uno mayor que el anterior). resto(x, campo) valida lo demás del tramo.
function validarTramos(tramos, campo, resto) {
  exigirLista(tramos, campo, MAX_TRAMOS);
  let previo = 0;
  return tramos.map((t, i) => {
    const x = objeto(t);
    if (!Number.isInteger(x.hastaG) || x.hastaG <= previo) throw new Error(`${campo}[${i}].hastaG: gramos enteros, mayores que el tramo anterior`);
    previo = x.hastaG;
    return { hastaG: x.hastaG, ...resto(x, `${campo}[${i}]`) };
  });
}

// body { tiempos: [{ hastaG, minutos }], facilidades: { facil, medio, dificil } } → { tiempos, facilidades }.
function validarTiempos(body) {
  const b = objeto(body);
  const tiempos = validarTramos(b.tiempos, 'tiempos', (x, c) => {
    if (!esNum(x.minutos) || x.minutos < 0 || x.minutos > MINUTOS_MAX) throw new Error(`${c}.minutos: número de 0 a ${MINUTOS_MAX}`);
    return { minutos: x.minutos };
  });
  const f = objeto(b.facilidades);
  const facilidades = Object.fromEntries(FACILIDADES.map(k => {
    if (!esNum(f[k]) || f[k] <= 0 || f[k] > FACTOR_MAX) throw new Error(`facilidades.${k}: número mayor que 0 y hasta ${FACTOR_MAX}`);
    return [k, f[k]];
  }));
  return { tiempos, facilidades };
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

// body { insumosSubrubro: { [IdSubRubro]: [{ hastaG, insumos }] } } → { insumosSubrubro } (reemplaza el mapa entero; un
// subrubro sin tramos no se guarda).
function validarInsumosSubrubro(body) {
  const b = objeto(body);
  if (!('insumosSubrubro' in b)) throw new Error('insumosSubrubro: falta');
  if (!esObjeto(b.insumosSubrubro)) throw new Error('insumosSubrubro: debe ser un objeto');
  const insumosSubrubro = Object.fromEntries(Object.entries(b.insumosSubrubro).map(([id, tramos]) => {
    if (!ID_SUBRUBRO.test(id)) throw new Error(`insumosSubrubro: subrubro ${id} inválido`);
    return [id, validarTramos(tramos, `insumosSubrubro.${id}`, (x, c) => ({ insumos: validarListaInsumos(x.insumos, `${c}.insumos`) }))];
  }).filter(([, ts]) => ts.length));
  return { insumosSubrubro };
}

// PUT granel/:plu body { facilidad, maquinaId } (null = sin asignar) → porGranel nuevo. Los dos null → se borra la entrada.
function aplicarGranel(porGranel, plu, body, maquinas) {
  if (!PLU_SIGA.test(String(plu))) throw new Error('PLU inválido');
  if (!esObjeto(body)) throw new Error('body: debe ser un objeto');
  const b = body;
  const facilidad = b.facilidad ?? null, maquinaId = b.maquinaId ?? null;
  if (facilidad !== null && !FACILIDADES.includes(facilidad)) throw new Error(`facilidad: ${FACILIDADES.join(', ')} o null`);
  if (maquinaId !== null && !(maquinas || []).some(m => m.id === maquinaId)) throw new Error(`maquinaId: ${maquinaId} no está en Configuración › Costeo Fraccionado › Máquinas`);
  const { [plu]: _fuera, ...resto } = objeto(porGranel);
  return facilidad == null && maquinaId == null ? resto : { ...resto, [plu]: { facilidad, maquinaId } };
}

// PUT insumos-presentacion/:plu body { insumos } (vacía = volver a la regla) → insumosPresentacion nuevo.
function aplicarInsumosPresentacion(mapa, plu, body) {
  if (!PLU_SIGA.test(String(plu))) throw new Error('PLU inválido');
  const insumos = validarListaInsumos(objeto(body).insumos, 'insumos');
  const { [plu]: _fuera, ...resto } = objeto(mapa);
  return insumos.length ? { ...resto, [plu]: insumos } : resto;
}

module.exports = { usosMaquinas, validarMaquinas, validarTiempos, validarInsumosSubrubro, validarListaInsumos, aplicarGranel, aplicarInsumosPresentacion };
