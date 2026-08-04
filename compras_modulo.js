'use strict';
// Módulo de cálculo puro para Compras. Sin SQL ni fs — todo se inyecta por parámetros.
// Reutiliza pisoMinimo de distribucion.js (mismo piso escalonado que el racionamiento).
const { pisoMinimo } = require('./distribucion');

// sugerido = deficitReposicion + deficitMicro + faltanteReal (suma simple, ver plan)
function sugeridoCompra({ pideTotal = 0, central = 0, enviarMicro = {}, tramos = [], pisoAbsoluto = 0 }) {
  const deficitReposicion = Math.max((pideTotal || 0) - (central || 0), 0);
  const deficitMicro = Object.values(enviarMicro || {})
    .reduce((s, m) => s + (m && Number(m.qty) > 0 ? Number(m.qty) : 0), 0);
  const piso = pisoMinimo(pideTotal || 0, tramos, pisoAbsoluto);
  const faltanteReal = Math.max(piso - (central || 0), 0);
  const sugerido = deficitReposicion + deficitMicro + faltanteReal;
  return { deficitReposicion, deficitMicro, faltanteReal, sugerido };
}

// Redondea la cantidad al múltiplo de unidadesPorBulto (hacia arriba). Si no hay bulto cargado, pasa la cantidad tal cual.
function redondearABulto(cantidad, unidadesPorBulto) {
  const q = Math.max(0, Number(cantidad) || 0);
  const b = Number(unidadesPorBulto);
  if (!b || b <= 0) return { cantidad: q, bultos: null, sinBulto: true };
  const bultos = Math.ceil(q / b);
  return { cantidad: bultos * b, bultos, sinBulto: false };
}

// Agrupa los items del carrito por proveedor asociado → cuántos ítems cubre cada uno y su costo total.
// totalItems = cantidad total de ítems del carrito (incluye los sin proveedor), para mostrar "X de Y".
function coberturaPorProveedor(items) {
  const lista = Array.isArray(items) ? items : [];
  const totalItems = lista.length;
  const porProv = new Map();
  for (const it of lista) {
    const prov = it.proveedor;
    if (!prov) continue;
    if (!porProv.has(prov)) porProv.set(prov, { proveedor: prov, itemsCubiertos: 0, costoTotal: 0, totalItems });
    const p = porProv.get(prov);
    p.itemsCubiertos += 1;
    p.costoTotal += (Number(it.cantidad) || 0) * (Number(it.costoUnit) || 0);
  }
  return [...porProv.values()]
    .map(p => ({ ...p, costoTotal: Math.round(p.costoTotal) }))
    .sort((a, b) => b.itemsCubiertos - a.itemsCubiertos || b.costoTotal - a.costoTotal);
}

// ── Ciclo de vida de la orden de compra ──────────────────────────────────────
// GENERADA → ENVIADA → RECIBIDA, con ANULADA como salida desde cualquier estado
// abierto. RECIBIDA y ANULADA son finales: una orden cerrada no se reabre, se
// genera una nueva. La recepción es todo-o-nada (no hay cantidades por línea).
const ESTADOS_ORDEN = ['GENERADA', 'ENVIADA', 'RECIBIDA', 'ANULADA'];
const TRANSICIONES_ORDEN = {
  GENERADA: ['ENVIADA', 'ANULADA'],
  ENVIADA:  ['RECIBIDA', 'ANULADA'],
  RECIBIDA: [],
  ANULADA:  [],
};

function transicionValida(desde, hacia) {
  const permitidos = TRANSICIONES_ORDEN[desde];
  return Array.isArray(permitidos) && permitidos.includes(hacia);
}

// Fechas en 'YYYY-MM-DD' y aritmética en UTC: con hora local, un huso al oeste de
// Greenwich corre la fecha un día para atrás al serializarla.
const LEAD_TIME_FALLBACK = 14;

function sumarDias(fechaISO, dias) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(fechaISO || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + (Number(dias) || 0));
  return d.toISOString().slice(0, 10);
}

// data/lead_times.json: { "_default": 14, "<NOMBRE PROVEEDOR>": 4 }
function leadTimeDeProveedor(leadTimes, proveedor) {
  const lt = leadTimes || {};
  const propio = Number(lt[proveedor]);
  if (Number.isFinite(propio) && propio >= 0) return propio;
  const def = Number(lt._default);
  return Number.isFinite(def) && def >= 0 ? def : LEAD_TIME_FALLBACK;
}

// Devuelve una orden NUEVA con el estado aplicado. Nunca muta la recibida.
// ctx: { ts, fechaISO, usuario, nota, leadTimes } — todo inyectado, el módulo no
// conoce el reloj ni el disco.
function aplicarTransicion(orden, nuevoEstado, ctx) {
  const o = orden || {};
  const desde = o.estado || 'GENERADA';
  if (!transicionValida(desde, nuevoEstado)) {
    throw new Error(`Transición inválida: ${desde} → ${nuevoEstado}`);
  }
  const c = ctx || {};
  const historial = Array.isArray(o.historial) ? o.historial : [];
  const siguiente = {
    ...o,
    estado: nuevoEstado,
    fechaEnvio: o.fechaEnvio ?? null,
    fechaRecepcion: o.fechaRecepcion ?? null,
    fechaEstimada: o.fechaEstimada ?? null,
    nota: c.nota != null && c.nota !== '' ? String(c.nota) : (o.nota ?? null),
    historial: [...historial, { estado: nuevoEstado, ts: c.ts || null, usuario: c.usuario || null }],
  };
  if (nuevoEstado === 'ENVIADA') {
    siguiente.fechaEnvio = c.fechaISO || null;
    siguiente.fechaEstimada = sumarDias(c.fechaISO, leadTimeDeProveedor(c.leadTimes, o.proveedor));
  }
  if (nuevoEstado === 'RECIBIDA') siguiente.fechaRecepcion = c.fechaISO || null;
  return siguiente;
}

// Lo pedido y todavía no recibido, por PLU. Única definición en el sistema: la
// predicción de compra la resta para no volver a pedir lo que ya está en camino.
const ESTADOS_PENDIENTES = ['GENERADA', 'ENVIADA'];

function pendientePorPlu(ordenes) {
  const acc = {};
  for (const o of (Array.isArray(ordenes) ? ordenes : [])) {
    if (!ESTADOS_PENDIENTES.includes(o && o.estado)) continue;
    for (const it of (Array.isArray(o.items) ? o.items : [])) {
      const plu = String((it && it.plu) != null ? it.plu : '').trim();
      const cant = Number(it && it.cantidad);
      if (!plu || !Number.isFinite(cant) || cant <= 0) continue;
      acc[plu] = (acc[plu] || 0) + cant;
    }
  }
  return acc;
}

// Construye el objeto orden persistible. id y fechaISO se inyectan desde el caller (server.js) — módulo puro sin Date.now().
function construirOrden({ id, fechaISO, proveedor, items }) {
  const lista = Array.isArray(items) ? items : [];
  if (!lista.length) throw new Error('La orden no tiene items');
  if (!proveedor) throw new Error('Falta proveedor');
  const detalle = lista.map(it => {
    const cantidad = Number(it.cantidad) || 0;
    const costoUnit = Number(it.costoUnit) || 0;
    return { plu: String(it.plu), nombre: it.nombre || String(it.plu), cantidad, costoUnit, subtotal: Math.round(cantidad * costoUnit) };
  });
  const total = detalle.reduce((s, it) => s + it.subtotal, 0);
  return { id, fecha: fechaISO, proveedor, items: detalle, total, estado: 'GENERADA',
    fechaEnvio: null, fechaRecepcion: null, fechaEstimada: null, nota: null, historial: [] };
}

// ── Pesables: una fila por granel, no por presentación ───────────────────────
// Lo que se compra es el granel; las presentaciones son cómo se vende. Un mismo
// granel puede salir en ocho fraccionados distintos, y con una fila por
// presentación el sugerido de compra queda partido en ocho pedazos que nadie suma.
// cantFormula es el multiplicador: kg de granel por unidad de esa presentación.
function agruparPesablesPorGranel(filas) {
  const porGranel = new Map();
  for (const f of (Array.isArray(filas) ? filas : [])) {
    if (!f || f.granel == null) continue;
    const clave = String(f.granel);
    const mult = Number(f.cantFormula) > 0 ? Number(f.cantFormula) : 1;
    if (!porGranel.has(clave)) {
      porGranel.set(clave, {
        granel: f.granel, nombreGranel: f.nombreGranel || '',
        pideTotalGranel: 0, stockPresentacionesKg: 0, presentaciones: [],
      });
    }
    const g = porGranel.get(clave);
    const pideUnidades = Object.values(f.ideal || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    const stockUnidades = Object.values(f.stkSuc || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    g.pideTotalGranel += pideUnidades * mult;
    g.stockPresentacionesKg += stockUnidades * mult;
    g.presentaciones.push({ plu: String(f.plu), nombre: f.nombre || '', cantFormula: mult,
      pideUnidades, stockUnidades });
  }
  return [...porGranel.values()].map(g => ({
    ...g,
    pideTotalGranel: Math.round(g.pideTotalGranel * 100) / 100,
    stockPresentacionesKg: Math.round(g.stockPresentacionesKg * 100) / 100,
  }));
}

// Promedio mensual del consumo real de A8020, que es el total de la ventana
// (12 meses por defecto) sumado por sucursal. null = el PLU no tiene consumo
// calculado todavía; la UI lo distingue de un consumo real de cero.
const VENTANA_MESES_FALLBACK = 12;

function consumoPromedioMensual(consumoPorPlu, plu, ventanaMeses) {
  const porSuc = (consumoPorPlu || {})[String(plu)];
  if (!porSuc) return null;
  const total = Object.values(porSuc).reduce((s, v) => s + (Number(v) || 0), 0);
  const meses = Number(ventanaMeses) > 0 ? Number(ventanaMeses) : VENTANA_MESES_FALLBACK;
  return Math.round((total / meses) * 100) / 100;
}

module.exports = { sugeridoCompra, redondearABulto, coberturaPorProveedor, construirOrden,
  ESTADOS_ORDEN, TRANSICIONES_ORDEN, transicionValida, sumarDias, leadTimeDeProveedor, aplicarTransicion,
  pendientePorPlu, ESTADOS_PENDIENTES, agruparPesablesPorGranel, consumoPromedioMensual };
