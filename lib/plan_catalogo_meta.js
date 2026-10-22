'use strict';
// Meta de producción de cada grupo del catálogo (data/grupos_config.json) y de cada granel base
// (data/graneles_base.json): tipo, estado, cliente fasón, responsables y próxima fecha.
// Funciones puras: las rutas leen y escriben los JSON. Spec 2026-10-22-planificacion-centro §1.
// activo y reqGranel (legado) se mantienen sincronizados con estado y tipo: los siguen leyendo
// cfgActivo (server.js) y requiereGranel (lib/plan_envio.js → granelAparte).
const TIPOS = ['granel', 'directo'];
const ESTADOS = ['activo', 'pausado', 'discontinuado'];
const CAMPOS_META = ['tipo', 'estado', 'motivo', 'clienteId', 'responsables', 'proximaFecha'];
const CAMPOS_GRUPO = [...CAMPOS_META, 'granelPlus', 'esMiel', 'mpManual'];
const CAMPOS_GRANEL = ['nombre', 'estado', 'motivo', 'responsables', 'proximaFecha'];

function errorMeta(mensaje) {
  const e = new Error(mensaje);
  e.status = 400;
  return e;
}

const comoObjeto = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

function fechaISOValida(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// Graneles del grupo: la lista granelPlus o, si no hay, el granelPlu suelto (mismo criterio que cfgGranelPlus).
function granelPlusDe(v) {
  const o = comoObjeto(v);
  const lista = (Array.isArray(o.granelPlus) ? o.granelPlus : []).map(x => String(x || '').trim()).filter(Boolean);
  const uno = String(o.granelPlu || '').trim();
  return lista.length ? lista : (uno ? [uno] : []);
}

// Meta de una entrada de grupos_config (true | false | objeto), con los defaults del formato viejo.
function metaDeEntrada(v) {
  const o = comoObjeto(v);
  return {
    tipo: TIPOS.includes(o.tipo) ? o.tipo : (o.reqGranel === true ? 'granel' : 'directo'),
    estado: ESTADOS.includes(o.estado) ? o.estado : ((v === false || o.activo === false) ? 'discontinuado' : 'activo'),
    motivo: typeof o.motivo === 'string' ? o.motivo : '',
    clienteId: o.clienteId ?? null,
    responsables: Array.isArray(o.responsables) ? o.responsables.map(String) : [],
    proximaFecha: typeof o.proximaFecha === 'string' && o.proximaFecha ? o.proximaFecha : null,
  };
}

function metaDeGranel(v) {
  const o = comoObjeto(v);
  const m = metaDeEntrada({ estado: o.estado, motivo: o.motivo, responsables: o.responsables, proximaFecha: o.proximaFecha });
  return { nombre: typeof o.nombre === 'string' ? o.nombre : '', estado: m.estado, motivo: m.motivo, responsables: m.responsables, proximaFecha: m.proximaFecha };
}

// editados: claves del PATCH. Responsables y cliente solo se validan contra el ctx si vienen en el PATCH;
// si no, se conserva lo guardado (así un PATCH de otro campo no se rompe con un responsables.json ilegible
// ni con un cliente ya borrado).
function normalizarComun(m, responsables, editados) {
  if (!ESTADOS.includes(m.estado)) throw errorMeta(`Estado inválido: ${m.estado}`);
  const motivo = String(m.motivo ?? '').trim();
  if (m.estado === 'pausado' && !motivo) throw errorMeta('Un producto pausado necesita un motivo');
  const fecha = m.proximaFecha === '' ? null : (m.proximaFecha ?? null);
  if (fecha !== null && !fechaISOValida(fecha)) throw errorMeta(`Fecha inválida: ${fecha}`);
  let resp = m.responsables;
  if (editados.includes('responsables')) {
    if (!Array.isArray(m.responsables)) throw errorMeta('Responsables: se esperaba una lista');
    const validos = new Set((responsables || []).map(r => (typeof r === 'string' ? r : r && r.nombre)).filter(Boolean));
    resp = [...new Set(m.responsables.map(String))].filter(n => validos.has(n));
  }
  return { estado: m.estado, motivo: m.estado === 'pausado' ? motivo : '', responsables: resp, proximaFecha: fecha };
}

function normalizarMetaGrupo(meta, { clientes = [], responsables = [], granelPlus = [], editados = CAMPOS_META } = {}) {
  if (!TIPOS.includes(meta.tipo)) throw errorMeta(`Tipo inválido: ${meta.tipo}`);
  if (meta.tipo === 'granel' && !granelPlus.length) throw errorMeta('Un producto con granel base necesita su granel: elegilo en la columna Granel');
  let clienteId = meta.clienteId ?? null;
  if (editados.includes('clienteId')) {
    const id = meta.clienteId === '' ? null : (meta.clienteId ?? null);
    const cliente = id === null ? null : clientes.find(c => String(c.id) === String(id));
    if (id !== null && !cliente) throw errorMeta(`Cliente inexistente: ${id}`);
    clienteId = cliente ? cliente.id : null;
  }
  const comun = normalizarComun(meta, responsables, editados);
  return { tipo: meta.tipo, estado: comun.estado, motivo: comun.motivo, clienteId, responsables: comun.responsables, proximaFecha: comun.proximaFecha };
}

function normalizarMetaGranel(meta, { responsables = [], editados = CAMPOS_GRANEL } = {}) {
  return { nombre: String(meta.nombre ?? '').trim(), ...normalizarComun(meta, responsables, editados) };
}

function camposDesconocidos(patch, permitidos) {
  const malos = Object.keys(patch).filter(k => !permitidos.includes(k));
  if (malos.length) throw errorMeta(`Campos no editables: ${malos.join(', ')}`);
}

const elegir = (o, claves) => Object.fromEntries(claves.filter(k => k in o).map(k => [k, o[k]]));

// Aplica un PATCH a la entrada de un grupo. Devuelve la entrada nueva (no muta la original).
function aplicarMetaGrupo(entrada, patch, ctx = {}) {
  const p = comoObjeto(patch);
  camposDesconocidos(p, CAMPOS_GRUPO);
  const base = typeof entrada === 'boolean' ? { activo: entrada } : { ...comoObjeto(entrada) };
  if ('granelPlus' in p) {
    if (!Array.isArray(p.granelPlus)) throw errorMeta('granelPlus: se esperaba una lista');
    const gl = [...new Set(p.granelPlus.map(x => String(x || '').trim()).filter(Boolean))];
    if (gl.some(x => !/^\d+$/.test(x))) throw errorMeta('granelPlus: PLU inválido');
    delete base.granelPlu;
    delete base.granelPlus;
    if (gl.length) base.granelPlu = gl[0];
    if (gl.length > 1) base.granelPlus = gl;
  }
  if ('esMiel' in p) {
    if (typeof p.esMiel !== 'boolean') throw errorMeta('esMiel: se esperaba true/false');
    base.esMiel = p.esMiel;
  }
  if ('mpManual' in p) {
    if (!Array.isArray(p.mpManual)) throw errorMeta('mpManual: se esperaba una lista');
    const mp = p.mpManual.filter(x => x && x.nombre);
    if (mp.length) base.mpManual = mp; else delete base.mpManual;
  }
  const meta = normalizarMetaGrupo({ ...metaDeEntrada(base), ...elegir(p, CAMPOS_META) }, { ...ctx, granelPlus: granelPlusDe(base), editados: Object.keys(p) });
  const out = { ...base, ...meta, activo: meta.estado !== 'discontinuado' };
  if (meta.tipo === 'granel') out.reqGranel = true; else delete out.reqGranel;
  return out;
}

function aplicarMetaGranel(entrada, patch, ctx = {}) {
  const p = comoObjeto(patch);
  camposDesconocidos(p, CAMPOS_GRANEL);
  return normalizarMetaGranel({ ...metaDeGranel(entrada), ...p }, { ...ctx, editados: Object.keys(p) });
}

// Migración (scripts/migrar_planificacion_centro.js): completa la meta de cada grupo y da de alta
// en graneles base los granelPlu(s) de los grupos tipo granel. Idempotente: lo que ya tiene tipo y
// estado no se toca, y no pisa graneles existentes.
function migrarPlanificacionCentro(gruposCfg, granelesBase) {
  let cambios = 0;
  const grupos = {};
  for (const [ref, v] of Object.entries(comoObjeto(gruposCfg))) {
    const o = comoObjeto(v);
    if (TIPOS.includes(o.tipo) && ESTADOS.includes(o.estado)) { grupos[ref] = v; continue; }
    const m = metaDeEntrada(v);
    grupos[ref] = { ...(typeof v === 'boolean' ? { activo: v } : o), ...m, activo: m.estado !== 'discontinuado' };
    cambios++;
  }
  const graneles = { ...comoObjeto(granelesBase) };
  for (const v of Object.values(grupos)) {
    if (v.tipo !== 'granel') continue;
    for (const plu of granelPlusDe(v)) {
      if (!/^\d+$/.test(plu) || Object.hasOwn(graneles, plu)) continue;
      graneles[plu] = metaDeGranel({});
      cambios++;
    }
  }
  return { gruposCfg: grupos, granelesBase: graneles, cambios };
}

module.exports = {
  TIPOS, ESTADOS, metaDeEntrada, metaDeGranel, granelPlusDe,
  normalizarMetaGrupo, normalizarMetaGranel, aplicarMetaGrupo, aplicarMetaGranel, migrarPlanificacionCentro,
};
