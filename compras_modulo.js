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

module.exports = { sugeridoCompra };
