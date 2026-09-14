'use strict';
// Lógica pura del módulo Fraccionado Externo: costeo de mano de obra por paquete y armado de
// pedidos para tercerizar. Sin I/O ni SQL — igual criterio que lib/compras.js. El tiempo real
// por paquete (minPorPaquete) sale de fuera (lib/productividad.js, vía el router); acá sólo se
// aplican los dos valores que el usuario ajusta a mano: factor de complejidad (por producto) y
// valor hora (por pedido).

function calcularCostoItem({ minPorPaquete, paquetes, factorComplejidad, valorHora }) {
  const min = Number(minPorPaquete);
  const paq = Number(paquetes);
  const factor = Number(factorComplejidad);
  const hora = Number(valorHora);
  if (!Number.isFinite(min) || min <= 0) throw new Error('minPorPaquete inválido');
  if (!Number.isFinite(paq) || paq <= 0) throw new Error('paquetes inválido');
  if (!Number.isFinite(factor) || factor <= 0) throw new Error('factorComplejidad inválido');
  if (!Number.isFinite(hora) || hora <= 0) throw new Error('valorHora inválido');
  const costoUnitarioExacto = (hora / 60) * min * factor;
  return {
    costoUnitario: Math.round(costoUnitarioExacto),
    costoTotal: Math.round(costoUnitarioExacto * paq),
  };
}

const ORIGENES_TIEMPO = new Set(['historial', 'manual']);

function construirItemPedido({ plu, nombre, presentacion, minPorPaquete, origenTiempo, paquetes, factorComplejidad, valorHora }) {
  if (!String(plu == null ? '' : plu).trim()) throw new Error('Falta el PLU del producto');
  if (!String(nombre || '').trim()) throw new Error('Falta el nombre del producto');
  if (!ORIGENES_TIEMPO.has(origenTiempo)) throw new Error(`origenTiempo inválido: ${origenTiempo}`);
  const { costoUnitario, costoTotal } = calcularCostoItem({ minPorPaquete, paquetes, factorComplejidad, valorHora });
  return {
    plu: String(plu), nombre: String(nombre), presentacion: presentacion || '',
    minPorPaquete: Number(minPorPaquete), origenTiempo,
    paquetes: Number(paquetes), factorComplejidad: Number(factorComplejidad),
    costoUnitario, costoTotal,
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
  const detalle = lista.map(it => construirItemPedido({ ...it, valorHora: hora }));
  const total = detalle.reduce((s, it) => s + it.costoTotal, 0);
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

module.exports = { calcularCostoItem, construirItemPedido, siguienteNumero, construirPedido, anularPedido };
