// ══════════════════ RESUMEN MP (+Todo) ══════════════════════

let _mpResumenResolve = null;

document.getElementById('cerrarMPResumen').addEventListener('click', () => {
  document.getElementById('overlayMPResumen').classList.remove('open');
  if (_mpResumenResolve) { _mpResumenResolve(false); _mpResumenResolve = null; }
});
document.getElementById('btnMPResumenCancelar').addEventListener('click', () => {
  document.getElementById('overlayMPResumen').classList.remove('open');
  if (_mpResumenResolve) { _mpResumenResolve(false); _mpResumenResolve = null; }
});
document.getElementById('btnMPResumenContinuar').addEventListener('click', () => {
  document.getElementById('overlayMPResumen').classList.remove('open');
  if (_mpResumenResolve) { _mpResumenResolve(true); _mpResumenResolve = null; }
});
document.getElementById('overlayMPResumen').addEventListener('click', e => {
  if (e.target === e.currentTarget) {
    e.currentTarget.classList.remove('open');
    if (_mpResumenResolve) { _mpResumenResolve(false); _mpResumenResolve = null; }
  }
});

async function calcularMPParaItems(items) {
  const mpMap = {};
  for (const it of items) {
    const cant = it.cantConfirmada ?? it.cantSugerida ?? 0;
    if (cant <= 0) continue;
    // Granel manual: no tiene idProducto, su fórmula se busca por el PLU del granel.
    const pluRaw = it.idProducto ?? (it.esGranel ? it.idGranel : null);
    if (pluRaw == null || pluRaw === '') continue;
    const plu = String(pluRaw);
    if (!formulasAllCache[plu]) {
      try {
        const bom = await api('GET', `/api/bom/producto/${plu}`);
        if (bom.length) formulasAllCache[plu] = bom.map(c => ({ ...c, _fromSiga: true }));
      } catch(e) {}
    }
    for (const c of (formulasAllCache[plu] || [])) {
      const k = String(c.plu);
      if (!mpMap[k]) mpMap[k] = { nombre: c.nombre, total: 0 };
      mpMap[k].total = Math.round((mpMap[k].total + c.cantPorUnidad * cant) * 10000) / 10000;
    }
  }
  return Object.entries(mpMap).map(([plu, v]) => ({ plu, ...v }));
}

// avisosHtml: bloque HTML opcional que se antepone a la tabla (avisos del carrito).
// Resuelve true/false según el botón que se toque. La promesa se arma antes de calcular: cerrar el
// modal mientras dice "Calculando…" cancela (false) en vez de dejar al llamador colgado, y el botón
// de confirmar queda deshabilitado hasta tener el resumen a la vista.
async function mostrarMPResumen(titulo, items, avisosHtml = '') {
  if (_mpResumenResolve) _mpResumenResolve(false); // un resumen anterior sin resolver cuenta como cancelado
  const decision = new Promise(resolve => { _mpResumenResolve = resolve; });
  const btnOk = document.getElementById('btnMPResumenContinuar');
  btnOk.disabled = true;
  document.getElementById('mpResumenTitulo').textContent = titulo;
  document.getElementById('mpResumenBody').innerHTML = '<div style="color:var(--muted);font-size:13px">Calculando…</div>';
  document.getElementById('overlayMPResumen').classList.add('open');
  try { await renderMPResumen(items, avisosHtml); }
  finally { btnOk.disabled = false; }
  return decision;
}

// Más de tantas filas: la tabla se parte en dos columnas lado a lado para que entre sin scroll vertical.
const MP_FILAS_UNA_COLUMNA = 12;

function tablaMP(filas) {
  const th = (txt, izq) => `<th style="text-align:${izq ? 'left' : 'right'};padding:4px 8px;font-size:11px;color:var(--muted)">${txt}</th>`;
  return `<table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr style="background:var(--md-surface-1)">${th('Componente', true)}${th('Necesario')}${th('Stock')}${th('Dif.')}</tr></thead>
    <tbody>${filas.map(({ r, stock, diff, falta }) => `<tr style="border-bottom:1px solid var(--md-outline-variant)${falta ? ';background:var(--red-bg)' : ''}">
      <td style="padding:4px 8px${falta ? ';font-weight:600' : ''}">
        ${falta ? '<span style="color:var(--red-text);margin-right:4px">⚠</span>' : ''}${escHtml(r.nombre)}
        <span style="font-size:10px;color:var(--muted);margin-left:4px">PLU ${escHtml(String(r.plu))}</span>
      </td>
      <td style="text-align:right;padding:4px 8px;font-family:system-ui,sans-serif;font-weight:700;white-space:nowrap">${r.total}</td>
      <td style="text-align:right;padding:4px 8px;white-space:nowrap;color:${stock === null ? 'var(--muted)' : falta ? 'var(--red-text)' : 'var(--verde)'}">${stock !== null ? stock : '—'}</td>
      <td style="text-align:right;padding:4px 8px;white-space:nowrap;font-weight:700;color:${diff === null ? 'var(--muted)' : falta ? 'var(--red-text)' : 'var(--verde)'}">${diff !== null ? (diff >= 0 ? '+' : '') + diff : '—'}</td>
    </tr>`).join('')}</tbody></table>`;
}

async function renderMPResumen(items, avisosHtml) {
  const mpList = await calcularMPParaItems(items);
  const body = document.getElementById('mpResumenBody');

  if (!mpList.length) {
    body.innerHTML = avisosHtml + '<div style="color:var(--muted);font-size:13px;padding:8px 0">Sin fórmulas definidas para estas presentaciones.</div>';
    return;
  }
  const stockMap = new Map();
  try {
    const rows = await api('GET', `/api/stock/plus?ids=${mpList.map(r => r.plu).join(',')}`);
    for (const r of rows) stockMap.set(String(r.IdProducto), parseFloat(r.StockActual));
  } catch(e) {}

  const filas = mpList.map(r => {
    const stock = stockMap.has(r.plu) ? stockMap.get(r.plu) : null;
    const diff  = stock !== null ? Math.round((stock - r.total) * 10000) / 10000 : null;
    return { r, stock, diff, falta: diff !== null && diff < 0 };
  });
  const mitad = Math.ceil(filas.length / 2);
  body.innerHTML = avisosHtml + (filas.length > MP_FILAS_UNA_COLUMNA
    ? `<div class="mp-cols">${tablaMP(filas.slice(0, mitad))}${tablaMP(filas.slice(mitad))}</div>`
    : tablaMP(filas));
}
