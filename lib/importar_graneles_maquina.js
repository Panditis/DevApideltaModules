'use strict';
// Importación masiva máquina/inactivo por granel (scripts/importar_graneles_maquina.js). Lógica pura: filas + costeo → costeo nuevo.
// Maquina 's' → maquinaId + bobina; 'x' → activoGranel[plu] = false (igual que PUT subrubros activos) + sin máquina y bolsa;
// vacío o granel no listado → sin máquina y bolsa (estado sin tocar); otra letra → no se toca y va a advertencias.

const objeto = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
// '0893 ' → '893' (las claves de porGranel son el PLU de SIGA sin ceros a la izquierda)
const normPlu = v => String(v ?? '').trim().replace(/^0+(?=\d)/, '');
const sinClaves = (o, ks) => Object.fromEntries(Object.entries(o).filter(([k]) => !ks.includes(k)));

function maquinaUnica(maquinas, forzada) {
  const ms = Array.isArray(maquinas) ? maquinas : [];
  if (forzada != null) {
    if (!ms.some(m => m.id === forzada)) throw new Error(`máquina "${forzada}" no está en costeo.fraccionado.maquinas`);
    return forzada;
  }
  if (ms.length !== 1) throw new Error(`se esperaba una sola máquina en costeo.fraccionado.maquinas y hay ${ms.length}: pasá --maquina <id>`);
  return ms[0].id;
}

// filas = [{ Codigo, Maquina }] → { costeoNuevo, resumen }. No muta costeo.
function importarGranelesMaquina(filas, costeo, { maquina } = {}) {
  const f = objeto(objeto(costeo).fraccionado);
  const maquinaId = maquinaUnica(f.maquinas, maquina);
  const advertencias = [];
  const accion = {}; // plu → 's' | 'x' | ''
  filas.forEach((r, i) => {
    const plu = normPlu(r.Codigo), m = String(r.Maquina ?? '').trim().toLowerCase(), fila = i + 2;
    if (!/^\d{1,12}$/.test(plu)) return advertencias.push(`fila ${fila}: código inválido ${JSON.stringify(r.Codigo)}`);
    if (!['s', 'x', ''].includes(m)) return advertencias.push(`fila ${fila}: PLU ${plu} con Maquina "${m}" desconocida, no se toca`);
    if (plu in accion && accion[plu] !== m) advertencias.push(`fila ${fila}: PLU ${plu} repetido con otro valor (queda "${m || 'vacío'}")`);
    accion[plu] = m;
  });
  const raros = new Set(advertencias.filter(a => a.includes('desconocida')).map(a => a.match(/PLU (\d+)/)[1]));

  const previo = objeto(f.porGranel);
  const activoPrevio = objeto(costeo.activoGranel);
  const resumen = { maquinaId, aMaquina: 0, aInactivo: 0, aBolsa: 0, cambiosGranel: 0, yaEstaban: 0, nuevosInactivos: 0, advertencias };
  let porGranel = { ...previo }, activoGranel = { ...activoPrevio };
  const plus = new Set([...Object.keys(accion), ...Object.keys(previo)]);
  for (const plu of plus) {
    if (raros.has(plu) && !(plu in accion)) continue;
    const m = accion[plu] ?? '';
    const g = objeto(previo[plu]);
    const base = sinClaves(g, ['maquinaId', 'envase']);
    const nuevo = m === 's' ? { ...base, maquinaId, envase: 'bobina' } : base;
    if (m === 's') resumen.aMaquina++; else if (m === 'x') resumen.aInactivo++; else resumen.aBolsa++;
    const igual = JSON.stringify(nuevo) === JSON.stringify(g);
    if (Object.keys(nuevo).length) porGranel = { ...porGranel, [plu]: nuevo };
    else porGranel = sinClaves(porGranel, [plu]);
    let cambio = !igual;
    if (m === 'x' && activoPrevio[plu] !== false) { activoGranel = { ...activoGranel, [plu]: false }; resumen.nuevosInactivos++; cambio = true; }
    if (cambio) resumen.cambiosGranel++; else resumen.yaEstaban++;
  }
  const costeoNuevo = { ...costeo, ...(resumen.nuevosInactivos && { activoGranel }), fraccionado: { ...f, porGranel } };
  return { costeoNuevo, resumen: { ...resumen, plusExcel: Object.keys(accion) } };
}

module.exports = { importarGranelesMaquina, normPlu };
