// Prioridad de un grupo del catálogo según facturación de sus presentaciones: promedio ponderado
// por el propio valor (Σx²/Σx), así las presentaciones que más facturan dominan el puntaje.
function puntajePrioridad(valores) {
  const xs = (valores || []).map(Number).filter(x => Number.isFinite(x) && x > 0);
  const suma = xs.reduce((s, x) => s + x, 0);
  return suma ? Math.round((xs.reduce((s, x) => s + x * x, 0) / suma) * 100) / 100 : 0;
}
module.exports = { puntajePrioridad };
