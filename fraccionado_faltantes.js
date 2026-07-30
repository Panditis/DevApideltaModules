'use strict';
// Cálculo de faltantes fraccionables para las órdenes de fraccionado de Pedidos mayoristas.
// Módulo puro a propósito: sin SQL ni lectura de archivos, así se puede testear con node:test.
// Lo llama el endpoint /api/mayoristas/fraccionado-faltantes de server.js.

// El granel se mide en kg con decimales; multiplicar y restar en punto flotante deja colas
// (0.30000000000000004). Se recorta a 6 decimales, que es la misma precisión que usa el
// DECIMAL(18,6) de sqlBOMGranel.
function redondear(n) { return Math.round(n * 1e6) / 1e6; }

/**
 * @param {Array} pendientes  [{ plu, nombre, pendiente, stockCentral, clientes:[{idCliente,nombre,pendiente}] }]
 * @param {Map}   bomGranel   plu -> { granelPlu, granelNombre, cantPorUnidad }
 * @param {Map}   stockGranel granelPlu -> kg disponibles en la central
 * @returns {Array} filas con faltante, sugerido, cubre, granelNecesario
 */
function calcularFaltantesFraccionado(pendientes, bomGranel, stockGranel) {
  const candidatos = [];
  for (const p of pendientes || []) {
    const plu = String(p.plu == null ? '' : p.plu).trim();
    if (!plu) continue;
    const bom = bomGranel.get(plu);
    if (!bom) continue;
    const cantPorUnidad = Number(bom.cantPorUnidad);
    if (!Number.isFinite(cantPorUnidad) || cantPorUnidad <= 0) continue;
    const pendiente = Number(p.pendiente) || 0;
    const stockCentral = Number(p.stockCentral) || 0;
    const faltante = Math.max(0, pendiente - stockCentral);
    if (faltante <= 0) continue;
    candidatos.push({
      plu, nombre: p.nombre || '', pendiente, stockCentral, faltante,
      granelPlu: String(bom.granelPlu), granelNombre: bom.granelNombre || '', cantPorUnidad,
      clientes: (p.clientes || []).map(c => ({ ...c })),
    });
  }
  return candidatos.map(c => {
    const granelStock = Number(stockGranel.get(c.granelPlu)) || 0;
    const maxPorGranel = Math.floor(granelStock / c.cantPorUnidad);
    const sugerido = Math.max(0, Math.min(c.faltante, maxPorGranel));
    return {
      ...c, granelStock, sugerido,
      cubre: sugerido >= c.faltante,
      granelNecesario: redondear(sugerido * c.cantPorUnidad),
    };
  });
}

module.exports = { calcularFaltantesFraccionado };
