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
async function mostrarMPResumen(titulo, items, avisosHtml = '') {
  document.getElementById('mpResumenTitulo').textContent = titulo;
  document.getElementById('mpResumenBody').innerHTML = '<div style="color:var(--muted);font-size:13px">Calculando…</div>';
  document.getElementById('overlayMPResumen').classList.add('open');

  const mpList = await calcularMPParaItems(items);
  const body = document.getElementById('mpResumenBody');

  if (!mpList.length) {
    body.innerHTML = avisosHtml + '<div style="color:var(--muted);font-size:13px;padding:8px 0">Sin fórmulas definidas para estas presentaciones.</div>';
  } else {
    const stockMap = new Map();
    try {
      const rows = await api('GET', `/api/stock/plus?ids=${mpList.map(r => r.plu).join(',')}`);
      for (const r of rows) stockMap.set(String(r.IdProducto), parseFloat(r.StockActual));
    } catch(e) {}

    body.innerHTML = avisosHtml + `<table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#f1f5f9">
        <th style="text-align:left;padding:5px 8px;font-size:11px;color:var(--muted)">Componente</th>
        <th style="text-align:right;padding:5px 8px;font-size:11px;color:var(--muted)">Necesario</th>
        <th style="text-align:right;padding:5px 8px;font-size:11px;color:var(--muted)">Stock</th>
        <th style="text-align:right;padding:5px 8px;font-size:11px;color:var(--muted)">Dif.</th>
      </tr></thead><tbody>
      ${mpList.map(r => {
        const stock = stockMap.has(r.plu) ? stockMap.get(r.plu) : null;
        const diff  = stock !== null ? Math.round((stock - r.total) * 10000) / 10000 : null;
        const falta = diff !== null && diff < 0;
        return `<tr style="border-bottom:1px solid var(--md-outline-variant)${falta ? ';background:#fff5f5' : ''}">
          <td style="padding:6px 8px${falta ? ';font-weight:600' : ''}">
            ${falta ? '<span style="color:var(--red-text);margin-right:4px">⚠</span>' : ''}${escHtml(r.nombre)}
            <span style="font-size:10px;color:var(--muted);margin-left:4px">PLU ${escHtml(String(r.plu))}</span>
          </td>
          <td style="text-align:right;padding:6px 8px;font-family:system-ui,sans-serif;font-weight:700">${r.total}</td>
          <td style="text-align:right;padding:6px 8px;color:${stock === null ? 'var(--muted)' : falta ? 'var(--red-text)' : 'var(--verde)'}">
            ${stock !== null ? stock : '—'}
          </td>
          <td style="text-align:right;padding:6px 8px;font-weight:700;color:${diff === null ? 'var(--muted)' : falta ? 'var(--red-text)' : 'var(--verde)'}">
            ${diff !== null ? (diff >= 0 ? '+' : '') + diff : '—'}
          </td>
        </tr>`;
      }).join('')}
      </tbody></table>`;
  }

  return new Promise(resolve => { _mpResumenResolve = resolve; });
}
