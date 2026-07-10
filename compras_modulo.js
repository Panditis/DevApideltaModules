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

module.exports = { sugeridoCompra, redondearABulto };
