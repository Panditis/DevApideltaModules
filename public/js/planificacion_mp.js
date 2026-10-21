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
    const plu = String(it.idProducto);
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

async function mostrarMPResumen(titulo, items) {
  document.getElementById('mpResumenTitulo').textContent = titulo;
  document.getElementById('mpResumenBody').innerHTML = '<div style="color:var(--muted);font-size:13px">Calculando…</div>';
  document.getElementById('overlayMPResumen').classList.add('open');

  const mpList = await calcularMPParaItems(items);
  const body = document.getElementById('mpResumenBody');

  if (!mpList.length) {
    body.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px 0">Sin fórmulas definidas para estas presentaciones.</div>';
  } else {
    const stockMap = new Map();
    try {
      const rows = await api('GET', `/api/stock/plus?ids=${mpList.map(r => r.plu).join(',')}`);
      for (const r of rows) stockMap.set(String(r.IdProducto), parseFloat(r.StockActual));
    } catch(e) {}

    body.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px">
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

// ══════════════════ MULTI-RESPONSABLE WIDGET ══════════════════════

// bloqueado = orden reservada: se ven los responsables asignados pero no se abre el desplegable.
function renderRespMulti(it, bloqueado) {
  const resps = Array.isArray(it.responsables) ? it.responsables : (it.responsable ? [it.responsable] : []);
  const chips = resps.length
    ? resps.map(r => `<span class="resp-chip-sm">${escHtml(r)}</span>`).join('')
    : `<span style="color:var(--muted);font-size:11px">Sin asignar</span>`;
  if (bloqueado) {
    return `<div class="resp-multi" onclick="event.stopPropagation()">
      <div class="resp-multi-display resp-multi-bloq" title="Orden reservada: anulá la reserva para cambiarlo">${chips}</div>
    </div>`;
  }
  const opts = responsablesCache.map(r => {
    const nom = respNombre(r);
    return `<label style="display:flex;align-items:center;gap:7px;padding:6px 10px;cursor:pointer;font-size:12px;border-bottom:1px solid #f0f0f0;hover:background:#f5f5f5">
      <input type="checkbox" ${resps.includes(nom)?'checked':''} style="accent-color:var(--md-primary)"
        onchange="toggleResp(${it.id},'${escHtml(nom).replace(/'/g,"\\'")}')">
      ${escHtml(nom)}
    </label>`;
  }).join('');
  return `<div class="resp-multi" onclick="event.stopPropagation()">
    <div class="resp-multi-display" id="rdsp-${it.id}" onclick="toggleRespDrop('rmd-${it.id}')">
      ${chips}<span class="rm-arrow">▾</span>
    </div>
    <div class="resp-dropdown" id="rmd-${it.id}" style="display:none">
      ${opts || '<div style="padding:8px 10px;color:var(--muted);font-size:12px">Sin responsables cargados.</div>'}
    </div>
  </div>`;
}

let _openRespDrop = null;
function toggleRespDrop(id) {
  if (_openRespDrop && _openRespDrop !== id) {
    const prev = document.getElementById(_openRespDrop);
    if (prev) prev.style.display = 'none';
  }
  const dd = document.getElementById(id);
  if (!dd) return;
  const show = dd.style.display === 'none';
  if (show) {
    const trigger = document.getElementById(id.replace('rmd-', 'rdsp-'));
    if (trigger) {
      const r = trigger.getBoundingClientRect();
      dd.style.top  = (r.bottom + 2) + 'px';
      dd.style.left = r.left + 'px';
      dd.style.minWidth = r.width + 'px';
    }
    dd.style.display = 'block';
  } else {
    dd.style.display = 'none';
  }
  _openRespDrop = show ? id : null;
}
document.addEventListener('click', () => {
  if (_openRespDrop) {
    const el = document.getElementById(_openRespDrop);
    if (el) el.style.display = 'none';
    _openRespDrop = null;
  }
});

function toggleResp(itemId, nombre) {
  const item = planCache?.items?.find(i => i.id === itemId);
  if (!item) return;
  if (!Array.isArray(item.responsables)) item.responsables = item.responsable ? [item.responsable] : [];
  const idx = item.responsables.indexOf(nombre);
  if (idx >= 0) item.responsables.splice(idx, 1); else item.responsables.push(nombre);
  actualizarItem(itemId, 'responsables', [...item.responsables]);
  // Actualizar solo el display (sin cerrar el dropdown)
  const dsp = document.getElementById(`rdsp-${itemId}`);
  if (dsp) {
    const resps = item.responsables;
    const chips = resps.length
      ? resps.map(r => `<span class="resp-chip-sm">${escHtml(r)}</span>`).join('')
      : `<span style="color:var(--muted);font-size:11px">Sin asignar</span>`;
    dsp.innerHTML = chips + '<span class="rm-arrow">▾</span>';
  }
}
