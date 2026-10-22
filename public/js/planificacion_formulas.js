// ── Panel Granel MP (modal catálogo) ────────────────────────────
// Un grupo puede tener varios graneles (una masa por variedad). El primero de la lista es el
// que usa el resto del sistema (BOM del panel MP, sugerencias).
let granelesData = [];   // [{plu, nombre}]
function renderGraneles() {
  const c = document.getElementById('listaGraneles');
  if (!c) return;
  if (!granelesData.length) {
    c.innerHTML = '<span style="font-size:12px;color:var(--muted);font-style:italic">Sin graneles asignados</span>';
    return;
  }
  c.innerHTML = granelesData.map((g, i) => `<span style="display:inline-flex;align-items:center;gap:6px;background:#fff;border:1px solid var(--amb-border);border-radius:14px;padding:3px 6px 3px 10px;font-size:12px">
    <strong style="font-family:system-ui,sans-serif;color:var(--amb-text)">${escHtml(g.plu)}</strong>
    <span>${escHtml(g.nombre || '')}</span>
    ${i === 0 && granelesData.length > 1 ? '<span style="font-size:10px;color:var(--muted)">principal</span>' : ''}
    <button onclick="quitarGranel(${i})" title="Quitar" style="border:none;background:none;color:var(--red-text);cursor:pointer;font-size:13px;line-height:1">✕</button>
  </span>`).join('');
}
async function agregarGranel(plu, nombre) {
  const p = String(plu || '').trim();
  if (!p) { toast('Escribí el PLU del granel', true); return; }
  if (granelesData.some(g => g.plu === p)) { toast('Ese granel ya está en la lista', true); return; }
  granelesData = [...granelesData, { plu: p, nombre: nombre || '' }];
  renderGraneles();
  document.getElementById('inputGranelPlu').value = '';
  document.getElementById('resultadosGranelPlu').style.display = 'none';
  if (granelesData.length === 1) cargarBOM();   // el principal alimenta el panel de Materia Prima
  if (!nombre) {
    const nom = await nombreDePlu(p);
    const it = granelesData.find(g => g.plu === p);
    if (it && nom) { it.nombre = nom; renderGraneles(); }
  }
}
function quitarGranel(i) {
  const eraPrincipal = i === 0;
  granelesData = granelesData.filter((_, k) => k !== i);
  renderGraneles();
  if (eraPrincipal) cargarBOM();
}
function onGranelPluInput() {
  document.getElementById('resultadosGranelPlu').style.display = 'none';
}
async function buscarGranelPlu() {
  const q = document.getElementById('inputGranelPlu').value.trim();
  if (!q) { toast('Escribí PLU o nombre para buscar', true); return; }
  try {
    const rows = await api('GET', '/api/siga/buscar?q=' + encodeURIComponent(q));
    renderResultadosGranel(rows);
  } catch (e) { toast('Error al buscar: ' + e.message, true); }
}
function renderResultadosGranel(rows) {
  const c = document.getElementById('resultadosGranelPlu');
  c.innerHTML = '';
  if (!rows.length) {
    c.innerHTML = '<div style="padding:10px 14px;font-size:12px;color:var(--muted)">Sin resultados</div>';
    c.style.display = 'block'; return;
  }
  rows.forEach(r => {
    const d = document.createElement('div');
    d.style.cssText = 'padding:8px 14px;border-bottom:1px solid var(--amb-border);cursor:pointer;font-size:13px;display:flex;gap:10px;align-items:baseline';
    const pluS = String(r.plu);
    d.innerHTML = '<span style="font-family:system-ui,sans-serif;font-weight:700;color:var(--amb-text);flex-shrink:0">' + escHtml(pluS) + '</span>'
                + '<span>' + escHtml(r.producto) + '</span>'
                + '<span style="font-size:11px;color:var(--muted);margin-left:auto">' + escHtml(r.rubro||'') + '</span>';
    d.addEventListener('mousedown', () => seleccionarGranelPlu(pluS, r.producto));
    c.appendChild(d);
  });
  c.style.display = 'block';
}
function seleccionarGranelPlu(plu, nombre) {
  agregarGranel(plu, nombre);
}
document.getElementById('btnBuscarGranelPlu').addEventListener('click', buscarGranelPlu);
document.getElementById('btnAgregarGranelPlu').addEventListener('click', () =>
  agregarGranel(document.getElementById('inputGranelPlu').value.trim(), ''));
document.getElementById('inputGranelPlu').addEventListener('keydown', e => {
  if (e.key === 'Enter') buscarGranelPlu();
  if (e.key === 'Escape') document.getElementById('resultadosGranelPlu').style.display = 'none';
});

// ── Panel Materia Prima ──────────────────────────────────────────
let mpManualData = [];
let mpSelectedComp = null;
let mpPanelOpen = false;

function setModalTab(tab) {
  document.getElementById('mPanelPres').style.display     = tab==='pres'     ? 'flex' : 'none';
  document.getElementById('mPanelMP').style.display       = tab==='mp'        ? 'flex' : 'none';
  document.getElementById('mPanelFormulas').style.display = tab==='formulas'  ? 'flex' : 'none';
  document.getElementById('mTabPres').className     = 'modal-tab' + (tab==='pres'    ? ' modal-tab-active' : '');
  document.getElementById('mTabMP').className       = 'modal-tab' + (tab==='mp'      ? ' modal-tab-active' : '');
  document.getElementById('mTabFormulas').className = 'modal-tab' + (tab==='formulas'? ' modal-tab-active' : '');
  if (tab==='mp') cargarBOM();
  if (tab==='formulas') renderFormulasPanel();
}

async function cargarBOM() {
  const plu = granelesData[0]?.plu || '';
  document.getElementById('mpBody').innerHTML = '<div style="font-size:12px;color:var(--muted)">Cargando…</div>';
  let bomSiga = [];
  if (plu) {
    try {
      bomSiga = await api('GET', '/api/bom/producto/' + encodeURIComponent(plu));
    } catch(e) { bomSiga = []; }
  }
  renderBOM(bomSiga);
}

function renderBOM(bomSiga) {
  const allRows = [
    ...bomSiga.map(r =>
      '<tr style="border-bottom:1px solid #eee">' +
      '<td style="padding:4px 8px;font-size:12px">' + escHtml(r.nombre) + '</td>' +
      '<td style="padding:4px 8px;font-size:11px;color:var(--muted);text-align:right">' + r.plu + '</td>' +
      '<td style="padding:4px 8px;font-size:12px;text-align:right">' + r.cantPorUnidad + '</td>' +
      '<td style="padding:4px 6px;font-size:11px;color:var(--muted);text-align:center">Siga</td>' +
      '<td></td></tr>'
    ),
    ...mpManualData.map((r, i) =>
      '<tr style="border-bottom:1px solid #eee;background:#fffbf0">' +
      '<td style="padding:4px 8px;font-size:12px">' + escHtml(r.nombre) + '</td>' +
      '<td style="padding:4px 8px;font-size:11px;color:var(--muted);text-align:right">' + (r.plu||'—') + '</td>' +
      '<td style="padding:4px 8px;font-size:12px;text-align:right">' + r.cantPorKg + '</td>' +
      '<td style="padding:4px 6px;font-size:11px;color:var(--amb-text);text-align:center">manual</td>' +
      '<td style="padding:2px 4px"><button onclick="mpQuitarManual(' + i + ')" style="border:none;background:none;color:var(--red-text);cursor:pointer;font-size:13px;line-height:1" title="Quitar">✕</button></td></tr>'
    )
  ];
  const total = bomSiga.length + mpManualData.length;
  const plu = granelesData[0]?.plu || '';
  if (!allRows.length) {
    document.getElementById('mpBody').innerHTML =
      '<div style="font-size:12px;color:var(--muted);padding:4px 0">' +
      (plu ? 'Sin fórmula en Siga para PLU ' + escHtml(plu) + '. Agregá componentes manualmente:' :
             'Asigná un PLU de granel arriba, o agregá componentes manualmente:') + '</div>';
  } else {
    document.getElementById('mpBody').innerHTML =
      '<table style="width:100%;border-collapse:collapse">' +
      '<thead><tr style="font-size:11px;color:var(--muted)">' +
      '<th style="text-align:left;padding:3px 8px">Componente</th>' +
      '<th style="text-align:right;padding:3px 8px">PLU</th>' +
      '<th style="text-align:right;padding:3px 8px">Cant/KG</th>' +
      '<th style="text-align:center;padding:3px 8px">Origen</th>' +
      '<th></th></tr></thead><tbody>' + allRows.join('') + '</tbody></table>';
  }
  document.getElementById('mpBadge').textContent = total
    ? total + ' componente' + (total > 1 ? 's' : '') + (bomSiga.length ? ' (Siga)' : '') + (mpManualData.length ? ' +' + mpManualData.length + ' manual' + (mpManualData.length>1?'es':'') : '')
    : '';
}

function mpQuitarManual(i) {
  mpManualData.splice(i, 1);
  cargarBOM();
}

// Sugerencias del buscador de componentes: la presentación de más kg de cada producto del Tablero.
function buildDefaultMPList() {
  const t = tablero || { filas: [], fason: [] };
  const productos = [...t.filas.flatMap(f => (f.nivel === 'granel' ? f.variedades : [f])), ...t.fason.flatMap(c => c.filas)];
  const vistos = new Set();
  const res = [];
  for (const g of productos) {
    if (vistos.has(g.productoRef) || !g.presentaciones.length) continue;
    vistos.add(g.productoRef);
    const best = g.presentaciones.reduce((a, b) => (b.pesoKg > a.pesoKg ? b : a));
    res.push({ plu: best.plu, nombre: best.nombre || g.productoRef });
  }
  return res;
}
function renderDefaultMP(divId, selectFn) {
  const defaults = buildDefaultMPList();
  const div = document.getElementById(divId);
  if (!defaults.length) { div.style.display='none'; return; }
  div.innerHTML = '<div style="padding:4px 10px;font-size:10px;font-weight:700;color:var(--muted);letter-spacing:.5px;background:#f7faf6;border-bottom:1px solid #e0eaff">PRESENTACIÓN MÁS GRANDE POR GRUPO</div>' +
    defaults.map(r =>
      `<div style="padding:6px 12px;cursor:pointer;font-size:12px;border-bottom:1px solid #eee;display:flex;gap:8px"
        onmousedown="${selectFn}('${r.plu}','${escHtml(r.nombre).replace(/'/g,"\\'")}')">
        <strong style="font-family:system-ui,sans-serif;flex-shrink:0">${escHtml(String(r.plu))}</strong>
        <span>${escHtml(r.nombre)}</span>
      </div>`
    ).join('');
  div.style.display = 'block';
}

async function mpBuscarComp() {
  const q = document.getElementById('mpInputBuscar').value.trim();
  if (!q) { renderDefaultMP('mpResultados','mpSeleccionar'); return; }
  try {
    const rows = await api('GET', '/api/siga/buscar?q=' + encodeURIComponent(q));
    const div = document.getElementById('mpResultados');
    if (!rows.length) {
      div.innerHTML = '<div style="padding:8px 12px;font-size:12px;color:var(--muted)">Sin resultados</div>';
      div.style.display = 'block'; return;
    }
    div.innerHTML = rows.map(r =>
      '<div style="padding:6px 12px;cursor:pointer;font-size:12px;border-bottom:1px solid #eee;display:flex;gap:8px" ' +
      'onmousedown="mpSeleccionar(\'' + r.plu + '\',\'' + escHtml(r.producto).replace(/'/g,"\\'") + '\')">' +
      '<strong style="font-family:system-ui,sans-serif;flex-shrink:0">' + escHtml(String(r.plu)) + '</strong>' +
      '<span>' + escHtml(r.producto) + '</span>' +
      '<span style="margin-left:auto;color:var(--muted);font-size:11px">' + escHtml(r.rubro||'') + '</span></div>'
    ).join('');
    div.style.display = 'block';
  } catch(e) { toast('Error: ' + e.message, true); }
}

function mpSeleccionar(plu, nombre) {
  mpSelectedComp = { plu, nombre };
  document.getElementById('mpInputBuscar').value = plu + ' – ' + nombre;
  document.getElementById('mpResultados').style.display = 'none';
}

function mpAgregarComp() {
  const cant = parseFloat(document.getElementById('mpInputCant').value);
  if (!mpSelectedComp) { toast('Buscá y seleccioná un producto primero', true); return; }
  if (!cant || cant <= 0) { toast('Ingresá la cantidad por KG', true); return; }
  mpManualData.push({ plu: mpSelectedComp.plu, nombre: mpSelectedComp.nombre, cantPorKg: cant });
  mpSelectedComp = null;
  document.getElementById('mpInputBuscar').value = '';
  document.getElementById('mpInputCant').value = '';
  document.getElementById('mpResultados').style.display = 'none';
  cargarBOM();
}

// ══════════════════ FÓRMULAS POR PRESENTACIÓN ══════════════════════

let formulasData       = {};   // { plu: [{plu,nombre,cantPorUnidad}] }
let formulasPresItems  = [];   // items del grupo actual (no-variante)
let formulasActivePlu  = null;
let formulasSelComp    = null;
let formulasAllCache   = {};   // cache global para la vista en planificación

async function cargarFormulasGrupo(items) {
  formulasPresItems = (items || []).filter(i => !i.esVariante && i.plu);
  formulasActivePlu = null;
  formulasData = {};
  try {
    const all = await api('GET', '/api/formulas');
    for (const item of formulasPresItems) {
      const plu = String(item.plu);
      formulasData[plu] = Array.isArray(all[plu]) ? all[plu] : [];
    }
    formulasAllCache = { ...formulasAllCache, ...all };
  } catch(e) {}
  // Auto-completar desde Siga para presentaciones sin fórmula manual
  await Promise.all(formulasPresItems.map(async item => {
    const plu = String(item.plu);
    if (!formulasData[plu]?.length) {
      try {
        const bom = await api('GET', `/api/bom/producto/${plu}`);
        if (bom.length) {
          const comps = bom.map(c => ({ ...c, _fromSiga: true }));
          formulasData[plu] = comps;
          formulasAllCache[plu] = comps;
        }
      } catch(e) {}
    }
  }));
}

function renderFormulasPanel() {
  const sel = document.getElementById('formulaPresSelect');
  const prev = formulasActivePlu;
  sel.innerHTML = '<option value="">— seleccioná presentación —</option>' +
    formulasPresItems.map(i => {
      const comps = formulasData[String(i.plu)] || [];
      const tag = comps.length ? (comps[0]._fromSiga ? ' [Siga]' : ' [✓]') : '';
      return `<option value="${i.plu}"${String(i.plu)===prev?' selected':''}>${escHtml(i.baseNombre)}${tag} (PLU: ${i.plu})</option>`;
    }).join('');
  formulaSelectPres(prev || '');
}

function formulaSelectPres(plu) {
  formulasActivePlu = plu || null;
  const addForm = document.getElementById('formulaAddForm');
  const body    = document.getElementById('formulaBody');
  document.getElementById('formulaResultados').style.display = 'none';
  document.getElementById('formulaInputBuscar').value = '';
  document.getElementById('formulaInputCant').value = '';
  formulasSelComp = null;
  if (!plu) { body.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px 0">Seleccioná una presentación para editar su fórmula.</div>'; addForm.style.display='none'; return; }
  addForm.style.display = 'block';
  renderFormulaBody();
}

function renderFormulaBody() {
  const plu   = formulasActivePlu;
  const comps = formulasData[plu] || [];
  const body  = document.getElementById('formulaBody');
  if (!comps.length) {
    body.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:4px 0">Sin componentes. Agregá los ingredientes/insumos necesarios para producir 1 unidad.</div>';
    return;
  }
  const fromSiga = comps.some(c => c._fromSiga);
  body.innerHTML = (fromSiga ? '<div style="font-size:11px;color:#0369a1;background:#e0f2fe;border-radius:4px;padding:3px 8px;margin-bottom:6px;display:inline-block">📡 Cargado desde Siga</div>' : '') +
  `<table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr>
      <th style="text-align:left;padding:4px 6px;font-size:11px;color:var(--muted);font-weight:700">Componente</th>
      <th style="text-align:right;padding:4px 6px;font-size:11px;color:var(--muted);font-weight:700">Cant/unidad</th>
      <th style="width:28px"></th>
    </tr></thead>
    <tbody>
    ${comps.map((c,i) => `<tr style="border-bottom:1px solid var(--md-outline-variant)">
      <td style="padding:5px 6px">${escHtml(c.nombre)}<br><span style="font-size:10px;color:var(--muted)">PLU: ${c.plu||'—'}</span></td>
      <td style="text-align:right;padding:5px 6px;font-family:system-ui,sans-serif;font-weight:700">${c.cantPorUnidad}</td>
      <td><button style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:14px" onclick="formulaQuitarComp(${i})" title="Quitar">🗑</button></td>
    </tr>`).join('')}
    </tbody></table>`;
}

function formulaQuitarComp(idx) {
  const plu = formulasActivePlu; if (!plu) return;
  formulasData[plu] = (formulasData[plu]||[]).filter((_,i) => i!==idx);
  renderFormulaBody();
}

async function formulaBuscarComp() {
  const q = document.getElementById('formulaInputBuscar').value.trim();
  if (!q) { renderDefaultMP('formulaResultados','formulaSeleccionar'); return; }
  try {
    const rows = await api('GET', '/api/siga/buscar?q=' + encodeURIComponent(q));
    const div  = document.getElementById('formulaResultados');
    if (!rows.length) { div.innerHTML='<div style="padding:8px 12px;font-size:12px;color:var(--muted)">Sin resultados</div>'; div.style.display='block'; return; }
    div.innerHTML = rows.map(r =>
      `<div style="padding:6px 12px;cursor:pointer;font-size:12px;border-bottom:1px solid #eee;display:flex;gap:8px"
        onmousedown="formulaSeleccionar('${r.plu}','${escHtml(r.producto).replace(/'/g,"\\'")}')">
        <strong style="font-family:system-ui,sans-serif;flex-shrink:0">${escHtml(String(r.plu))}</strong>
        <span>${escHtml(r.producto)}</span>
        <span style="margin-left:auto;color:var(--muted);font-size:11px">${escHtml(r.rubro||'')}</span>
      </div>`
    ).join('');
    div.style.display = 'block';
  } catch(e) { toast('Error: '+e.message, true); }
}

function formulaSeleccionar(plu, nombre) {
  formulasSelComp = { plu, nombre };
  document.getElementById('formulaInputBuscar').value = plu + ' – ' + nombre;
  document.getElementById('formulaResultados').style.display = 'none';
}

function formulaAgregarComp() {
  const cant = parseFloat(document.getElementById('formulaInputCant').value);
  if (!formulasSelComp) { toast('Buscá y seleccioná un componente primero', true); return; }
  if (!cant || cant <= 0) { toast('Ingresá la cantidad por unidad', true); return; }
  const plu = formulasActivePlu; if (!plu) return;
  if (!formulasData[plu]) formulasData[plu] = [];
  formulasData[plu].push({ plu: formulasSelComp.plu, nombre: formulasSelComp.nombre, cantPorUnidad: cant });
  formulasSelComp = null;
  document.getElementById('formulaInputBuscar').value = '';
  document.getElementById('formulaInputCant').value = '';
  document.getElementById('formulaResultados').style.display = 'none';
  renderFormulaBody();
}

// Guardar fórmulas junto con el grupo (llamado desde guardarGrupo)
async function guardarFormulasGrupo() {
  for (const item of formulasPresItems) {
    const plu  = String(item.plu);
    const data = formulasData[plu] || [];
    await api('POST', `/api/formulas/${plu}`, data);
  }
}

// ══════════════════ VISTA FÓRMULA EN PLANIFICACIÓN ══════════════════

let fvStockMap = new Map();

async function abrirFormulaView(plu, nombre, cant) {
  if (!plu) return;
  // Refresh cache si está vacío
  if (!Object.keys(formulasAllCache).length) {
    try { formulasAllCache = await api('GET', '/api/formulas'); } catch(e) {}
  }
  let formula = formulasAllCache[String(plu)] || [];
  document.getElementById('fvTitulo').textContent = nombre;
  document.getElementById('fvCantInfo').textContent = cant
    ? `Cantidad a producir: ${cant} unidades`
    : 'Ingresá cantidad en el campo Sugerido para ver totales';
  document.getElementById('overlayFormulaView').classList.add('open');
  if (!formula.length) {
    document.getElementById('fvBOM').innerHTML = '<div style="color:var(--muted);font-size:12px;padding:8px 0">Buscando en Siga…</div>';
    try {
      const bom = await api('GET', `/api/bom/producto/${plu}`);
      if (bom.length) {
        formula = bom.map(c => ({ ...c, _fromSiga: true }));
        formulasAllCache[String(plu)] = formula;
      }
    } catch(e) {}
    if (!formula.length) {
      document.getElementById('fvBOM').innerHTML =
        '<div style="color:var(--muted);font-size:13px;padding:12px 0">Sin fórmula en Siga ni definida manualmente.</div>';
      return;
    }
  }
  document.getElementById('fvBOM').innerHTML = '<div style="color:var(--muted);font-size:12px">Cargando stock…</div>';
  // Fetch stock de componentes
  const plusList = formula.map(c=>c.plu).filter(Boolean);
  fvStockMap = new Map();
  if (plusList.length) {
    try {
      const rows = await api('GET', `/api/stock/plus?ids=${plusList.join(',')}`);
      for (const r of rows) fvStockMap.set(String(r.IdProducto), parseFloat(r.StockActual));
    } catch(e) {}
  }
  renderFvBOM(formula, cant);
}

function renderFvBOM(formula, cant) {
  const bom = document.getElementById('fvBOM');
  const sigatag = formula.some(c=>c._fromSiga) ? '<div style="font-size:11px;color:#0369a1;background:#e0f2fe;border-radius:4px;padding:2px 8px;margin-bottom:6px;display:inline-block">📡 Siga</div>' : '';
  bom.innerHTML = sigatag + formula.map(c => {
    const total    = cant ? Math.round(c.cantPorUnidad * cant * 10000) / 10000 : null;
    const stock    = c.plu ? (fvStockMap.get(String(c.plu)) ?? null) : null;
    const falta    = total !== null && stock !== null && stock < total;
    const colorCant= falta ? 'var(--red-text)' : 'var(--verde)';
    const stockTxt = stock !== null
      ? `<span style="font-size:11px;color:${falta?'var(--red-text)':'var(--muted)'}">stock: ${stock}${falta?` · falta ${Math.round((total-stock)*10000)/10000}`:''}</span>`
      : '';
    return `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:6px 0;border-bottom:1px solid var(--md-outline-variant);gap:8px">
      <div style="font-size:13px${falta?' font-weight:600':''}">
        ${falta?'<span style="color:var(--red-text);margin-right:4px">⚠</span>':''}${escHtml(c.nombre)}
        ${stockTxt?`<div>${stockTxt}</div>`:''}
      </div>
      <span style="font-family:system-ui,sans-serif;font-weight:700;font-size:14px;white-space:nowrap;color:${colorCant}">
        ${total!==null?total+' u':'—'}
      </span>
    </div>`;
  }).join('');
}

document.getElementById('cerrarFormulaView').addEventListener('click', () =>
  document.getElementById('overlayFormulaView').classList.remove('open'));
document.getElementById('overlayFormulaView').addEventListener('click', e => {
  if (e.target===e.currentTarget) e.currentTarget.classList.remove('open');
});

