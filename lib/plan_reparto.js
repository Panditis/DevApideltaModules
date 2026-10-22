'use strict';
/**
 * Reparto de un estimado en kg entre las presentaciones de una variedad (spec 2026-10-22 §3.6).
 * Cargable en el navegador (global PlanReparto, servido en /js/plan_reparto.js): el tablero lo usa
 * al tocar "+" con la cantidad que el usuario haya editado.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlanReparto = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // kg → [{plu, nombre, presentacion, unidades}] en proporción a los kg vendidos de cada presentación;
  // si ninguna vendió, todo a la de mayor peso. unidades = ceil(kg ÷ peso).
  function repartirEnPresentaciones(kg, presentaciones) {
    const validas = (presentaciones || []).filter(p => p && p.plu && Number(p.pesoKg) > 0);
    if (!(Number(kg) > 0) || !validas.length) return [];
    const total = validas.reduce((s, p) => s + (Number(p.ventasKg) || 0), 0);
    const partes = total > 0
      ? validas.map(p => ({ p, kg: kg * (Number(p.ventasKg) || 0) / total }))
      : [{ p: validas.reduce((a, b) => (Number(b.pesoKg) > Number(a.pesoKg) ? b : a)), kg }];
    return partes
      .filter(x => x.kg > 0)
      .map(({ p, kg: k }) => ({ plu: p.plu, nombre: p.nombre, presentacion: p.presentacion, unidades: Math.ceil(k / Number(p.pesoKg) - 1e-9) }));
  }
  return { repartirEnPresentaciones };
});
