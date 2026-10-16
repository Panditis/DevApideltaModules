'use strict';
// Fórmula presentación → granel de los pesables ({ plu: { granel, cantFormula } }), leída en cada
// cálculo de la fórmula activa de Siga. Antes salía de pesables_listas.json .formulas (import
// estático del Excel), que no veía productos nuevos ni cambios de fórmula: el 5952 quedaba con
// granel null. El JSON queda sólo como respaldo para los PLU que Siga no resuelve.
// ponytail: sólo componente directo de rubro 'Pesables Deposito'. Un PLU cuyo granel sea de otro
// rubro o cuelgue de un intermedio cae al respaldo; si aparecen, sumar el 2º nivel acá.

const RUBROS_PRESENTACION = ['Pesables Fraccionado', 'Pesables Venta Directa'];
const RUBRO_GRANEL = 'Pesables Deposito';

// rows: [{ Plu, Granel, Cant }]. Lo resuelto por Siga pisa al respaldo. Una fórmula con más de un
// granel es un mix (bandejas, snacks): no tiene "su" granel, queda como estaba (sin entrada →
// granel null) y el modal de registro la resuelve con el BOM completo.
function armarFormulas(rows, respaldo) {
  const porPlu = new Map();
  for (const r of rows || []) {
    const plu = String(r.Plu).trim();
    if (!porPlu.has(plu)) porPlu.set(plu, []);
    porPlu.get(plu).push({ granel: Number(String(r.Granel).trim()), cantFormula: Number(r.Cant) || 1 });
  }
  const siga = {};
  for (const [plu, comps] of porPlu) {
    if (new Set(comps.map(c => c.granel)).size === 1) siga[plu] = comps[0];
  }
  return { ...(respaldo || {}), ...siga };
}

async function formulasPesables({ query, FORMULA_ACTIVA_SQL, respaldo }) {
  const rubros = RUBROS_PRESENTACION.map(r => `'${r}'`).join(',');
  try {
    const rows = await query(`
      SELECT CAST(pc.IdProducto AS VARCHAR) AS Plu, CAST(pc.IdProductoComponente AS VARCHAR) AS Granel,
             CAST(pc.Cantidad AS FLOAT) AS Cant
      FROM ProductosComponentes pc
      JOIN Productos pp ON pp.IdProducto = pc.IdProducto           JOIN Rubros rp ON rp.IdRubro = pp.IdRubro
      JOIN Productos p  ON p.IdProducto  = pc.IdProductoComponente JOIN Rubros r  ON r.IdRubro  = p.IdRubro
      WHERE pp.Activo = 1 AND rp.NombreRubro IN (${rubros}) AND r.NombreRubro = '${RUBRO_GRANEL}'
        AND ${FORMULA_ACTIVA_SQL}`);
    return armarFormulas(rows, respaldo);
  } catch (e) {
    console.error('[formulas pesables] Siga:', e.message);
    return { ...(respaldo || {}) };
  }
}

module.exports = { armarFormulas, formulasPesables };
