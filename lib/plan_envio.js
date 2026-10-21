// lib/plan_envio.js
// Envío de la planificación a Producción del Día. El plan del día (planes.json[fecha].items) es
// la fuente de verdad: las órdenes de ordenes.json se regeneran desde sus ítems. Funciones puras:
// las rutas leen y escriben los JSON.

const CRITICIDAD = { URGENT: 'Urgente', RED: 'Alta', YELLOW: 'Media', GREEN: 'Baja' };
const CRIT_ORDER = { URGENT: 4, RED: 3, YELLOW: 2, GREEN: 1 };
// Todas las órdenes van a una única sección: producción no se categoriza por familia.
const SECCION = 'PRODUCCIÓN';

const norm = s => String(s || '').trim().toLowerCase();
const cantDe = it => it.cantConfirmada ?? it.cantSugerida ?? 0;
const pluDe = it => ((it.idProducto ?? it.plu) != null ? String(it.idProducto ?? it.plu) : '');
const respDe = it => (Array.isArray(it.responsables) ? it.responsables : (it.responsable ? [it.responsable] : []));

// Clave de la orden que genera un ítem: granel = 1 orden por producto; fraccionado = 1 por rubro.
function claveItem(it) {
  return it.esGranel ? `G|${norm(it.producto)}` : `F|${norm(it.rubro || it.producto)}`;
}
// Misma clave vista desde ordenes.json: `presentaciones` sólo lo arma el fraccionado.
function claveOrden(o) {
  return `${Array.isArray(o.presentaciones) ? 'F' : 'G'}|${norm(o.producto)}`;
}

function validarItemsEnvio(items) {
  if (!Array.isArray(items) || !items.length) return ['Sin ítems para enviar'];
  const errores = [];
  items.forEach((it, i) => {
    if (!it || typeof it !== 'object') { errores.push(`Ítem ${i + 1} inválido`); return; }
    if (!String(it.producto || '').trim()) errores.push(`Ítem ${i + 1} sin producto`);
    const c = Number(cantDe(it));
    if (!Number.isFinite(c) || c <= 0) errores.push(`"${it.producto || i + 1}": la cantidad debe ser mayor a 0`);
  });
  return errores;
}

function ordenGranel(it, { fecha, codigoGranel, nombreCliente }) {
  const cant = cantDe(it);
  const resps = respDe(it);
  return {
    id: 0,
    codigo: codigoGranel(it),
    idProducto: (it.idProducto ?? it.plu) ?? null,
    seccion: SECCION,
    producto: it.producto,
    presentacion: `${cant} ${it.unidadGranel || 'Kg'}${it.tambor ? ` · Tambor ${it.tambor}` : ''}`,
    cantidad: cant,
    criticidad: CRITICIDAD[it.semaforo] || 'Media',
    prioridad: it.prioridad,
    envase: it.envase || '',
    estado: 'pendiente',
    encargados: resps,
    encargado: resps.filter(Boolean).join(' / '),
    tambor: it.tambor || '',
    fecha,
    cliente: nombreCliente(it.cliente),
  };
}

function ordenFraccionado(rubro, its, { fecha, requiereGranel, nombreCliente }) {
  const semaforo = its.reduce((w, it) => ((CRIT_ORDER[it.semaforo] || 0) > (CRIT_ORDER[w] || 0) ? it.semaforo : w), 'GREEN');
  const presentaciones = its.map(it => ({
    presentacion: it.presentacion || it.producto || '', cantidad: cantDe(it),
    plu: pluDe(it), envase: it.envase || '', tapa: it.tapa || '',
  }));
  const tambores = [...new Set(its.map(it => it.tambor).filter(Boolean))].join(', ');
  const encargados = [...new Set(its.flatMap(respDe))];
  return {
    id: 0,
    codigo: presentaciones.map(p => p.plu).filter(Boolean).join(', '),
    seccion: SECCION,
    producto: rubro,
    // El granel del grupo va como orden propia: Producción no da de alta el granel acá.
    granelAparte: its.some(it => it.granelAparte) || requiereGranel(rubro),
    presentacion: presentaciones.map(p => `${p.presentacion}: ${p.cantidad}`).join(' / ') + (tambores ? ` · Tambor ${tambores}` : ''),
    presentaciones,
    cantidad: its.reduce((s, it) => s + cantDe(it), 0),
    criticidad: CRITICIDAD[semaforo] || 'Media',
    prioridad: Math.min(...its.map(it => it.prioridad ?? 9999)),
    envase: (its.find(it => it.envase) || {}).envase || '',
    tapa: (its.find(it => it.tapa) || {}).tapa || '',
    estado: 'pendiente',
    encargados,
    encargado: encargados.join(' / '),
    tambor: tambores,
    fecha,
    cliente: nombreCliente((its.find(i => i.cliente) || {}).cliente),
  };
}

// Ítems ya recepcionados (produccionMovimiento) cerraron su circuito: reenviarlos descontaría
// componentes en SiGA dos veces al conciliar.
function construirOrdenes(items, { fecha, ahora = Date.now(), codigoGranel, requiereGranel, nombreCliente }) {
  const vivos = (items || []).filter(it => it && !it.produccionMovimiento && cantDe(it) > 0);
  const ordenes = vivos.filter(it => it.esGranel).map(it => ordenGranel(it, { fecha, codigoGranel, nombreCliente }));
  const porRubro = new Map();
  for (const it of vivos.filter(i => !i.esGranel)) {
    const k = it.rubro || it.producto;
    porRubro.set(k, [...(porRubro.get(k) || []), it]);
  }
  for (const [rubro, its] of porRubro) ordenes.push(ordenFraccionado(rubro, its, { fecha, requiereGranel, nombreCliente }));
  return ordenes.map((o, i) => ({ ...o, id: ahora + i }));
}

// Identidad de un ítem dentro del plan del día: PLU si lo tiene, si no el nombre.
const claveItemPlan = it => `${it.esGranel ? 'G' : 'F'}|${pluDe(it) || norm(it.producto)}`;
// Lo que un envío posterior puede actualizar de un ítem ya enviado (vacío = conserva lo previo).
const EDITABLES = ['responsables', 'envase', 'tapa', 'cliente', 'tambor', 'granelAparte'];
const camposEditables = n => Object.fromEntries(
  EDITABLES.filter(k => n[k] != null && n[k] !== '').map(k => [k, n[k]]));

// Notas del carrito: se agregan debajo de las del día, nunca las pisan.
const sumarNotas = (previas, nuevas) => {
  const n = String(nuevas || '').trim();
  if (!n) return previas || '';
  return previas ? `${previas}\n${n}` : n;
};

function fusionarEnvioEnPlan(plan, nuevos, { fecha, envioId, hora, usuario, notas = '', creado = new Date().toISOString() }) {
  const base = plan || { fecha, notas: '', creado, items: [] };
  const items = [...(base.items || [])];
  nuevos.forEach((n, i) => {
    const cant = cantDe(n);
    const envio = { id: envioId, hora, usuario, cantidad: cant };
    const idx = items.findIndex(it => claveItemPlan(it) === claveItemPlan(n));
    if (idx === -1) {
      items.push({ estado: 'pendiente', ...n, id: envioId + i, cantConfirmada: cant, prioridad: items.length + 1, envios: [envio] });
      return;
    }
    const prev = items[idx];
    const historial = Array.isArray(prev.envios) ? prev.envios : [{ id: null, hora: null, usuario: null, cantidad: cantDe(prev) }];
    items[idx] = { ...prev, ...camposEditables(n), cantConfirmada: cantDe(prev) + cant, envios: [...historial, envio] };
  });
  return { ...base, fecha, notas: sumarNotas(base.notas, notas), items };
}

module.exports = { claveItem, claveOrden, validarItemsEnvio, construirOrdenes, cantDe, fusionarEnvioEnPlan };
