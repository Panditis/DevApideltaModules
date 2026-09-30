'use strict';
// Lógica pura del módulo Fraccionado Externo: costeo de mano de obra por paquete y armado de
// pedidos para tercerizar. Sin I/O ni SQL — igual criterio que lib/compras.js. Minutos/paquete y
// factor salen de niveles configurables (por defecto rápido/normal/lento y fácil/medio/difícil); el valor
// hora se ajusta por pedido.

// Precios y paquetes se manejan con 2 decimales. EPSILON evita que 1.005 redondee a 1.00.
const redondear2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function calcularCostoItem({ minPorPaquete, paquetes, factorComplejidad, valorHora }) {
  const min = Number(minPorPaquete);
  const paq = Number(paquetes);
  const factor = Number(factorComplejidad);
  const hora = Number(valorHora);
  if (!Number.isFinite(min) || min <= 0) throw new Error('minPorPaquete inválido');
  if (!Number.isFinite(paq) || paq <= 0) throw new Error('paquetes inválido');
  if (!Number.isFinite(factor) || factor <= 0) throw new Error('factorComplejidad inválido');
  if (!Number.isFinite(hora) || hora <= 0) throw new Error('valorHora inválido');
  const costoUnitario = redondear2((hora / 60) * min * factor);
  return {
    costoUnitario,
    costoTotal: redondear2(costoUnitario * redondear2(paq)),
  };
}

// Niveles: en vez de cargar minutos/paquete y factor a mano por producto, el usuario elige un
// nivel y el valor sale de la config del módulo (tab Configuración), donde también puede agregar,
// renombrar o quitar niveles. 'historial'/'manual' quedan sólo para leer pedidos viejos.
const ORIGENES_TIEMPO = new Set(['nivel', 'historial', 'manual']);
const GRUPOS = ['tiempos', 'factores'];
const MAX_NIVELES = 20;
const CONFIG_DEFAULT = Object.freeze({
  tiempos: Object.freeze([
    { id: 'rapido', nombre: 'Rápido', valor: 0.25 },
    { id: 'normal', nombre: 'Normal', valor: 0.5 },
    { id: 'lento', nombre: 'Lento', valor: 1 },
  ]),
  factores: Object.freeze([
    { id: 'facil', nombre: 'Fácil', valor: 1 },
    { id: 'medio', nombre: 'Medio', valor: 1.2 },
    { id: 'dificil', nombre: 'Difícil', valor: 1.5 },
  ]),
});
// Formato viejo del archivo: { tiempos: { rapido: 0.25, ... } } — los nombres salen de acá.
const NOMBRES_VIEJOS = { rapido: 'Rápido', normal: 'Normal', lento: 'Lento', facil: 'Fácil', medio: 'Medio', dificil: 'Difícil' };

const slug = txt => String(txt).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'nivel';

function validarGrupo(src, grupo) {
  const lista = Array.isArray(src)
    ? src
    : (src && typeof src === 'object'
      ? Object.entries(src).map(([id, valor]) => ({ id, nombre: NOMBRES_VIEJOS[id] || id, valor }))
      : null);
  if (!lista) throw new Error(`Faltan los ${grupo}`);
  if (!lista.length) throw new Error(`Tiene que haber al menos una opción de ${grupo}`);
  if (lista.length > MAX_NIVELES) throw new Error(`Máximo ${MAX_NIVELES} opciones de ${grupo}`);
  const normalizados = lista.map(n => {
    const nombre = String((n && n.nombre) || '').trim();
    if (!nombre) throw new Error('Hay una opción sin nombre');
    const valor = Number(n.valor);
    if (!Number.isFinite(valor) || valor <= 0) throw new Error(`Valor inválido para ${nombre}`);
    return { idPedido: n.id ? String(n.id) : null, nombre, valor };
  });
  const nombres = normalizados.map(n => n.nombre.toLowerCase());
  const repetido = nombres.find((n, i) => nombres.indexOf(n) !== i);
  if (repetido) throw new Error(`Nombre repetido: ${repetido}`);
  // Los ids existentes se conservan (los pedidos guardados los referencian); los nuevos salen del
  // nombre, con sufijo si chocan.
  const usados = new Set(normalizados.map(n => n.idPedido).filter(Boolean));
  return normalizados.map(({ idPedido, nombre, valor }) => {
    if (idPedido) return { id: idPedido, nombre, valor };
    const base = slug(nombre);
    let id = base;
    for (let k = 2; usados.has(id); k++) id = `${base}-${k}`;
    usados.add(id);
    return { id, nombre, valor };
  });
}

function validarConfig(cfg) {
  return Object.fromEntries(GRUPOS.map(g => [g, validarGrupo(cfg && cfg[g], g)]));
}

function resolverNiveles(item, cfg) {
  const { nivelTiempo, nivelComplejidad } = item || {};
  const tiempo = cfg.tiempos.find(n => n.id === nivelTiempo);
  const factor = cfg.factores.find(n => n.id === nivelComplejidad);
  if (!tiempo) throw new Error(`nivelTiempo inválido: ${nivelTiempo}`);
  if (!factor) throw new Error(`nivelComplejidad inválido: ${nivelComplejidad}`);
  return { ...item, origenTiempo: 'nivel', minPorPaquete: tiempo.valor, factorComplejidad: factor.valor };
}

// Sugerencia inicial al agregar un producto: el nivel cuyo valor configurado queda más cerca de
// los minutos/paquete reales del historial. Sin historial: 'normal' si existe, si no el primero.
function nivelTiempoMasCercano(minPorPaquete, tiempos) {
  const m = Number(minPorPaquete);
  if (minPorPaquete == null || !Number.isFinite(m) || m <= 0) {
    return (tiempos.find(n => n.id === 'normal') || tiempos[0]).id;
  }
  return tiempos.reduce((mejor, n) => Math.abs(n.valor - m) < Math.abs(mejor.valor - m) ? n : mejor).id;
}

function construirItemPedido({ plu, nombre, presentacion, minPorPaquete, origenTiempo, kilos, paquetes, factorComplejidad, valorHora, nivelTiempo = null, nivelComplejidad = null }) {
  if (!String(plu == null ? '' : plu).trim()) throw new Error('Falta el PLU del producto');
  if (!String(nombre || '').trim()) throw new Error('Falta el nombre del producto');
  if (!ORIGENES_TIEMPO.has(origenTiempo)) throw new Error(`origenTiempo inválido: ${origenTiempo}`);
  const { costoUnitario, costoTotal } = calcularCostoItem({ minPorPaquete, paquetes, factorComplejidad, valorHora });
  return {
    plu: String(plu), nombre: String(nombre), presentacion: presentacion || '',
    minPorPaquete: Number(minPorPaquete), origenTiempo,
    // kilos es lo que carga el usuario (lo que se le va a entregar al tercero); paquetes ya
    // viene calculado del lado del cliente (kilos / peso de la presentación) — se guarda el
    // kilaje también para que el pedido y el PDF muestren la cantidad real pedida, no sólo la
    // derivada.
    kilos: kilos != null ? Number(kilos) : null,
    paquetes: redondear2(paquetes), factorComplejidad: Number(factorComplejidad),
    nivelTiempo, nivelComplejidad,
    costoUnitario, costoTotal,
  };
}

// Tareas específicas: trabajos que no son productos (etiquetado, reempaque…). Se definen con un
// monto fijo por unidad; al armar el pedido sólo se indica la cantidad. Ver
// docs/superpowers/specs/2026-09-30-fraccionado-externo-tareas-design.md.
function validarTarea(datos, existentes = [], idActual = null) {
  const nombre = String((datos && datos.nombre) || '').trim();
  if (!nombre) throw new Error('Falta el nombre de la tarea');
  const monto = redondear2(datos.monto);
  if (!Number.isFinite(monto) || monto <= 0) throw new Error('Monto inválido: tiene que ser mayor a 0');
  const repetida = (existentes || []).some(t => t.id !== idActual
    && String(t.nombre).trim().toLowerCase() === nombre.toLowerCase());
  if (repetida) throw new Error(`Ya existe una tarea llamada ${nombre}`);
  return { nombre, monto };
}

// Correlativo "T1", "T2"…: máximo existente + 1.
function siguienteIdTarea(tareas) {
  const nums = (tareas || [])
    .map(t => /^T(\d+)$/.exec(String((t && t.id) || '')))
    .filter(Boolean)
    .map(m => Number(m[1]));
  return `T${(nums.length ? Math.max(...nums) : 0) + 1}`;
}

// Nombre y monto salen de la lista guardada en el servidor, nunca del cliente.
function resolverTarea(item, tareas) {
  const { tareaId, cantidad } = item || {};
  const tarea = (tareas || []).find(t => t.id === tareaId);
  if (!tarea) throw new Error(`tareaId inválido: ${tareaId}`);
  return { tipo: 'tarea', tareaId: tarea.id, nombre: tarea.nombre, montoUnitario: tarea.monto, cantidad };
}

function construirItemTarea({ tareaId, nombre, montoUnitario, cantidad }) {
  if (!String(tareaId == null ? '' : tareaId).trim()) throw new Error('Falta la tarea');
  if (!String(nombre || '').trim()) throw new Error('Falta el nombre de la tarea');
  const monto = Number(montoUnitario);
  if (!Number.isFinite(monto) || monto <= 0) throw new Error('montoUnitario inválido');
  const cant = redondear2(cantidad);
  if (!Number.isFinite(cant) || cant <= 0) throw new Error('cantidad inválida');
  return {
    tipo: 'tarea', tareaId: String(tareaId), nombre: String(nombre),
    montoUnitario: monto, cantidad: cant,
    costoUnitario: monto, costoTotal: redondear2(monto * cant),
  };
}

// Correlativo "FE-0001"; un anulado no libera su número — mismo criterio que compras (P-0001).
function siguienteNumero(pedidos) {
  const nums = (pedidos || [])
    .map(p => /^FE-(\d+)$/.exec(String((p && p.numero) || '')))
    .filter(Boolean)
    .map(m => Number(m[1]));
  const max = nums.length ? Math.max(...nums) : 0;
  return `FE-${String(max + 1).padStart(4, '0')}`;
}

function construirPedido({ numero, fechaISO, tercero, usuario = null, valorHora, items, ts = null } = {}) {
  const lista = Array.isArray(items) ? items : [];
  if (!lista.length) throw new Error('El pedido no tiene items');
  if (!String(tercero || '').trim()) throw new Error('Falta el tercero');
  const hora = Number(valorHora);
  if (!Number.isFinite(hora) || hora <= 0) throw new Error('valorHora inválido');
  const detalle = lista.map(it => (it && it.tipo === 'tarea'
    ? construirItemTarea(it)
    : construirItemPedido({ ...it, valorHora: hora })));
  const total = redondear2(detalle.reduce((s, it) => s + it.costoTotal, 0));
  return {
    numero, fecha: fechaISO, tercero: String(tercero).trim(), usuario, estado: 'PENDIENTE',
    valorHora: hora, items: detalle, total,
    historial: [{ ts, usuario, accion: 'creado' }],
  };
}

function anularPedido(pedido, { ts, usuario = null } = {}) {
  if (!pedido) throw new Error('Falta el pedido');
  if (pedido.estado === 'ANULADO') throw new Error('El pedido ya está anulado');
  return {
    ...pedido, estado: 'ANULADO',
    historial: [...(pedido.historial || []), { ts, usuario, accion: 'anulado' }],
  };
}

module.exports = {
  CONFIG_DEFAULT, validarConfig, resolverNiveles, nivelTiempoMasCercano, calcularCostoItem, construirItemPedido, siguienteNumero, construirPedido, anularPedido,
  validarTarea, siguienteIdTarea, resolverTarea, construirItemTarea };
