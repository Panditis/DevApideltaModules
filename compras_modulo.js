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

module.exports = { sugeridoCompra, redondearABulto, coberturaPorProveedor };
