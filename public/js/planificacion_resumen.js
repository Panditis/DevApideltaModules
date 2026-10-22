'use strict';
// Helpers compartidos de planificación: los usaba el Resumen (reemplazado por el Tablero,
// spec 2026-10-22-planificacion-centro) y los siguen usando carrito, registros, envío, fórmulas y
// el tablero. gruposCache/gruposSorted quedan vacíos: registros y envío los consultan con fallback.

let gruposCache = [];
let gruposSorted = [];
const URGENCIA_CHIP = { URGENTE: ['RED', '🔴 Urgente'], PRONTO: ['YELLOW', '🟡 Pronto'], OK: ['GREEN', '🟢 OK'] };
const nfAR = (n, dec = 1) => Number(n).toLocaleString('es-AR', { maximumFractionDigits: dec });
const chipUrgencia = nivel => { const [clase, txt] = URGENCIA_CHIP[nivel] || URGENCIA_CHIP.OK; return `<span class="badge ${clase}">${txt}</span>`; };

// ── STOCK POR SUCURSAL (modal 🔍, lo abre el tablero) ──────────────────────
// Columnas del modal. Grupo con presentaciones: una por presentación, sumando el stock de todos sus
// PLUs (p.plus: las bases fusionadas), igual que la columna "Stock suc.". Granel: una por PLU, con el
// nombre del producto sin el del grupo.
function columnasStock(data, g) {
  const filas = data.presentaciones || [];
  if ((g.presentaciones || []).length) {
    return g.presentaciones.map(p => {
      const plus = (p.plus || [p.plu]).map(String), porSuc = {};
      for (const r of filas.filter(f => plus.includes(String(f.plu))))
        for (const [id, v] of Object.entries(r.porSuc)) porSuc[id] = (porSuc[id] || 0) + v;
      return { nombre: p.presentacion || p.baseNombre, porSuc };
    });
  }
  const ref = String(g.productoRef || '');
  return filas.map(r => {
    const nom = String(r.nombre || r.plu);
    return { nombre: nom.toLowerCase().startsWith(ref.toLowerCase()) ? (nom.slice(ref.length).trim() || nom) : nom, porSuc: r.porSuc };
  });
}

// Filas = sucursales (sin Casa Central) con stock en alguna presentación; columnas = presentaciones + Total.
function renderStockDetalle(data, g) {
  const pres = columnasStock(data, g);
  const sucs = (data.sucursales || []).filter(s => !s.central && pres.some(r => r.porSuc[s.id] > 0));
  if (!sucs.length) return '<div style="padding:10px;color:var(--muted)">Sin stock en sucursales.</div>';
  const fmt = n => Math.round(n * 100) / 100;
  const num = 'text-align:right;white-space:nowrap;padding:5px 10px';
  const cell = v => v ? `<td style="${num}">${fmt(v)}</td>` : `<td style="${num};color:var(--border)">·</td>`;
  const th = 'font-size:11px;color:var(--muted);padding:4px 10px';
  const head = pres.map(r => `<th style="${th};text-align:right">${escHtml(r.nombre)}</th>`).join('');
  const body = sucs.map(s => {
    const total = pres.reduce((t, r) => t + (r.porSuc[s.id] || 0), 0);
    return `<tr style="border-bottom:1px solid var(--md-outline-variant)"><td style="font-size:13px;padding:5px 10px;white-space:nowrap">${escHtml(s.nombre)}</td>${pres.map(r => cell(r.porSuc[s.id])).join('')}<td class="font-bold" style="${num}">${fmt(total)}</td></tr>`;
  }).join('');
  const totalesPres = pres.map(r => sucs.reduce((t, s) => t + (r.porSuc[s.id] || 0), 0));
  const pie = `<tr style="border-top:2px solid var(--md-outline-variant)"><td class="font-bold" style="font-size:13px;padding:5px 10px">Total</td>${totalesPres.map(t => `<td class="font-bold" style="${num}">${fmt(t)}</td>`).join('')}<td class="font-bold" style="${num}">${fmt(totalesPres.reduce((a, b) => a + b, 0))}</td></tr>`;
  return `<table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr style="border-bottom:2px solid var(--md-outline-variant)"><th style="${th};text-align:left">SUCURSAL</th>${head}<th style="${th};text-align:right">TOTAL</th></tr></thead>
    <tbody>${body}${pie}</tbody></table>`;
}

// ¿La referencia es una variedad de miel del catálogo? Usa el flag esMiel (default: nombre arranca con "Miel").
function esVariedadMiel(ref) {
  return cfgGetEsMiel(ref);
}

// ¿El ítem es una variedad de miel? (decide si pedir el número de tambor) — solo las del catálogo
function esItemMiel(it) {
  return esVariedadMiel(it.rubro) || esVariedadMiel(it.producto);
}

// Nombre de un PLU (cacheado): lo usan fórmulas y catálogo para mostrar graneles.
const _nombrePluCache = {};
async function nombreDePlu(plu) {
  if (plu in _nombrePluCache) return _nombrePluCache[plu];
  let nom = '';
  try {
    const rows = await api('GET', '/api/siga/buscar?q=' + encodeURIComponent(plu));
    nom = (rows.find(r => String(r.plu) === String(plu)) || {}).producto || '';
  } catch { /* sin nombre: se muestra el PLU */ }
  _nombrePluCache[plu] = nom;
  return nom;
}

