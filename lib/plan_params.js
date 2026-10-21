// Parámetros de planificación compartidos por todos los usuarios (data/planificacion_params.json).
// Hoy uno solo: los días que tiene que cubrir el sugerido ("Días a cubrir" en el Resumen).
const DIAS_A_CUBRIR_DEFAULT = 30;
const DIAS_A_CUBRIR_MIN = 1, DIAS_A_CUBRIR_MAX = 180;

// Entero de 1 a 180 (número o texto de solo dígitos); cualquier otra cosa devuelve null.
function validarDiasObjetivo(valor) {
  const n = typeof valor === 'number' ? valor : (typeof valor === 'string' && /^\d+$/.test(valor.trim()) ? Number(valor.trim()) : NaN);
  return Number.isInteger(n) && n >= DIAS_A_CUBRIR_MIN && n <= DIAS_A_CUBRIR_MAX ? n : null;
}

// Lo guardado en el archivo; si falta o no sirve, el diasObjetivo de config.json; si tampoco, 30.
function resolverDiasObjetivo(guardado, config) {
  return validarDiasObjetivo((guardado || {}).diasObjetivo)
    ?? validarDiasObjetivo((config || {}).diasObjetivo)
    ?? DIAS_A_CUBRIR_DEFAULT;
}

module.exports = { DIAS_A_CUBRIR_DEFAULT, DIAS_A_CUBRIR_MIN, DIAS_A_CUBRIR_MAX, validarDiasObjetivo, resolverDiasObjetivo };
