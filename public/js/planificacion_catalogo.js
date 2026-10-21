
// ══════════════════ MODAL EDITAR GRUPO ══════════════════════════

let editarGrupoRef    = null;
let editarGrupoRefId  = null;
let editarGrupoEsNuevo = false;
let nuevoGrupoEsMiel   = false; // true si el alta viene del botón "Agregar variedad" (sección Mieles)

const PRES_RE_JS = /(\d+(?:[.,]\d+)?\s*(?:G|Kg|Ml|L|g|kg|ml|l))(?:\s+\w+)*$/i;
function normalizarNombreJS(nombre) {
  let n = nombre.trim();
  n = n.replace(/\s+pack\b.*$/i,  '').trim();
  n = n.replace(/\s+bulto\b.*$/i, '').trim();
  n = n.replace(/\bvid\s+/i,      '').trim();
  n = n.replace(/\s+vid$/i,       '').trim();
  return n.trim();
}
function extraerPresentacionJS(base) {
  const m = PRES_RE_JS.exec(base);
  if (!m) return base;
  return m[0].trim().replace(/\bkg\b/i, 'Kg').replace(/\bg\b/i, 'G');
}

function abrirModalNuevoGrupo() {
  editarGrupoRef     = null;
  editarGrupoRefId   = null;
  editarGrupoEsNuevo = true;
  nuevoGrupoEsMiel   = false;
  document.getElementById('editarGrupoTitulo').style.display  = 'none';
  document.getElementById('inputNombreGrupo').style.display   = '';
  document.getElementById('inputNombreGrupo').value           = '';
  document.getElementById('editarGrupoMeta').textContent      = '0 presentaciones · 0 PLUs';
  document.getElementById('editarGrupoBody').innerHTML =
    '<div class="loading" style="padding:32px">Escribí el nombre del grupo arriba y buscá productos en Siga para agregarlos.</div>';
  document.getElementById('inputNuevaPres').value = '';
  document.getElementById('inputGranelPlu').value = '';
  granelesData = [];
  renderGraneles();
  document.getElementById('panelBuscarSiga').style.display = 'none';
  document.getElementById('overlayEditarGrupo').classList.add('open');
  setTimeout(() => document.getElementById('inputNombreGrupo').focus(), 80);
}

// Alta de variedad de miel: reusa el modal de nuevo grupo, con el nombre pre-cargado "Miel "
// para que quede en la sección Variedades de Miel y habilite la carga de tambor.
function abrirModalNuevaVariedadMiel() {
  abrirModalNuevoGrupo();
  nuevoGrupoEsMiel = true;
  const inp = document.getElementById('inputNombreGrupo');
  inp.value = 'Miel ';
  setTimeout(() => { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }, 100);
}

// Pregunta (Promise) si un grupo con "miel" en el nombre va a la sección Mieles.
let _seccionMielResolve = null;
function preguntarSeccionMiel(nombre) {
  document.getElementById('smNombre').textContent = nombre || '';
  document.getElementById('overlaySeccionMiel').classList.add('open');
  return new Promise(resolve => { _seccionMielResolve = resolve; });
}
function _resolverSeccionMiel(val) {
  document.getElementById('overlaySeccionMiel').classList.remove('open');
  if (_seccionMielResolve) { const r = _seccionMielResolve; _seccionMielResolve = null; r(val); }
}
document.getElementById('btnSmSi').addEventListener('click', () => _resolverSeccionMiel(true));
document.getElementById('btnSmNo').addEventListener('click', () => _resolverSeccionMiel(false));
document.getElementById('cerrarSeccionMiel').addEventListener('click', () => _resolverSeccionMiel(false));
document.getElementById('overlaySeccionMiel').addEventListener('click', e => { if (e.target === e.currentTarget) _resolverSeccionMiel(false); });

async function abrirModalGrupo(productoRef) {
  editarGrupoRef     = productoRef;
  editarGrupoRefId   = null;
  editarGrupoEsNuevo = false;
  document.getElementById('editarGrupoTitulo').textContent    = productoRef;
  document.getElementById('editarGrupoTitulo').style.display  = '';
  document.getElementById('inputGranelPlu').value = '';
  granelesData = cfgGetGranelPlus(productoRef).map(plu => ({ plu, nombre: '' }));
  renderGraneles();
  // Los nombres no se guardan en la config: se resuelven contra SiGA al abrir el modal.
  granelesData.forEach(async g => {
    const nom = await nombreDePlu(g.plu);
    if (nom && granelesData.includes(g)) { g.nombre = nom; renderGraneles(); }
  });
  mpManualData = cfgGetMpManual(productoRef).map(x=>({...x}));
  mpSelectedComp = null;
  document.getElementById('mpBody').innerHTML = '';
  document.getElementById('mpResultados').style.display = 'none';
  document.getElementById('mpInputBuscar').value = '';
  document.getElementById('mpInputCant').value = '';
  setModalTab('pres');
  document.getElementById('inputNombreGrupo').style.display   = 'none';
  document.getElementById('editarGrupoMeta').textContent      = 'Cargando…';
  document.getElementById('editarGrupoBody').innerHTML        = '<div class="loading">Cargando…</div>';
  document.getElementById('inputNuevaPres').value             = '';
  document.getElementById('panelBuscarSiga').style.display    = 'none';
  document.getElementById('overlayEditarGrupo').classList.add('open');
  try {
    const items = await api('GET', `/api/catalogo/grupo/${encodeURIComponent(productoRef)}`);
    if (items.length) editarGrupoRefId = items[0].refId;
    renderModalGrupoBody(items);
    await cargarFormulasGrupo(items); // cargar fórmulas en paralelo
  } catch (e) {
    document.getElementById('editarGrupoBody').innerHTML =
      `<div class="loading" style="color:red">Error: ${escHtml(e.message)}</div>`;
  }
}

function buildTablaHTML(bodyRows) {
  return `<table class="plu-tabla" style="min-width:520px">
    <thead><tr>
      <th style="width:86px">PLU</th>
      <th>Nombre en Siga</th>
      <th style="width:118px">Presentación</th>
      <th style="width:56px;text-align:center">Variante</th>
      <th style="width:38px"></th>
    </tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>`;
}

function renderModalGrupoBody(items) {
  const porPres = {};
  for (const item of items) {
    const p = item.presentacion || '(sin presentación)';
    if (!porPres[p]) porPres[p] = [];
    porPres[p].push(item);
  }
  const presentaciones = Object.keys(porPres).sort((a, b) => a.localeCompare(b));
  document.getElementById('editarGrupoMeta').textContent =
    `${presentaciones.length} presentaciones · ${items.length} PLUs`;

  if (!items.length) {
    document.getElementById('editarGrupoBody').innerHTML =
      '<div class="loading" style="padding:32px">Sin PLUs. Usá "+ Presentación" para agregar.</div>';
    return;
  }

  const bodyRows = presentaciones.flatMap(p => {
    const its  = porPres[p];
    const safe = p.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    return [
      `<tr class="pres-group-row" data-group="${escHtml(p)}">
        <td colspan="3">${escHtml(p)}
          <span style="font-weight:400;color:var(--muted);font-size:11px;margin-left:6px">${its.length} PLU${its.length!==1?'s':''}</span>
        </td>
        <td></td>
        <td><button class="btn btn-secondary btn-sm" style="font-size:11px;padding:2px 7px"
          onclick="agregarFilaPlu('${safe}')">+ PLU</button></td>
      </tr>`,
      ...its.map(item => renderFilaPlu(item))
    ];
  }).join('');

  document.getElementById('editarGrupoBody').innerHTML = buildTablaHTML(bodyRows);
}

function renderFilaPlu(item) {
  return `<tr data-plu-row>
    <td><input class="plu-input plu-input-plu" type="number" min="1"
      value="${item.plu||''}" data-field="plu"></td>
    <td><input class="plu-input" type="text"
      value="${escHtml(item.producto||item.baseNombre||'')}" data-field="producto"></td>
    <td><input class="plu-input plu-input-pres" type="text"
      value="${escHtml(item.presentacion||'')}" data-field="presentacion"></td>
    <td style="text-align:center">
      <input type="checkbox" ${item.esVariante?'checked':''} data-field="esVariante"
        style="width:16px;height:16px;accent-color:var(--verde)">
    </td>
    <td><button class="btn btn-danger btn-sm" style="padding:2px 7px"
      onclick="this.closest('tr').remove();actualizarMetaModal()">✕</button></td>
  </tr>`;
}

function agregarFilaPlu(presentacion) {
  let tbody = document.querySelector('#editarGrupoBody tbody');
  if (!tbody) {
    document.getElementById('editarGrupoBody').innerHTML = buildTablaHTML('');
    tbody = document.querySelector('#editarGrupoBody tbody');
  }
  let insertAfter = null;
  for (const tr of tbody.querySelectorAll('tr.pres-group-row')) {
    if (tr.dataset.group === presentacion) {
      insertAfter = tr;
      let next = tr.nextElementSibling;
      while (next && !next.classList.contains('pres-group-row')) {
        insertAfter = next;
        next = next.nextElementSibling;
      }
      break;
    }
  }
  const tr = document.createElement('tr');
  tr.setAttribute('data-plu-row', '');
  tr.innerHTML = `
    <td><input class="plu-input plu-input-plu" type="number" min="1" value="" data-field="plu" placeholder="PLU"></td>
    <td><input class="plu-input" type="text" value="" data-field="producto" placeholder="Nombre del producto"></td>
    <td><input class="plu-input plu-input-pres" type="text" value="${escHtml(presentacion)}" data-field="presentacion"></td>
    <td style="text-align:center">
      <input type="checkbox" data-field="esVariante" style="width:16px;height:16px;accent-color:var(--verde)">
    </td>
    <td><button class="btn btn-danger btn-sm" style="padding:2px 7px"
      onclick="this.closest('tr').remove();actualizarMetaModal()">✕</button></td>`;
  if (insertAfter) insertAfter.after(tr); else tbody.appendChild(tr);
  tr.querySelector('[data-field=plu]').focus();
  actualizarMetaModal();
}

function actualizarMetaModal() {
  const total  = document.querySelectorAll('#editarGrupoBody [data-plu-row]').length;
  const grupos = document.querySelectorAll('#editarGrupoBody tr.pres-group-row').length;
  document.getElementById('editarGrupoMeta').textContent = `${grupos} presentaciones · ${total} PLUs`;
}

document.getElementById('btnAgregarPresentacion').addEventListener('click', () => {
  const nombre = document.getElementById('inputNuevaPres').value.trim();
  if (!nombre) { document.getElementById('inputNuevaPres').focus(); return; }
  document.getElementById('inputNuevaPres').value = '';

  let tbody = document.querySelector('#editarGrupoBody tbody');
  if (!tbody) {
    document.getElementById('editarGrupoBody').innerHTML = buildTablaHTML('');
    tbody = document.querySelector('#editarGrupoBody tbody');
  }
  const safe = nombre.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
  const tr = document.createElement('tr');
  tr.className = 'pres-group-row';
  tr.dataset.group = nombre;
  tr.innerHTML = `
    <td colspan="3">${escHtml(nombre)}
      <span style="font-weight:400;color:var(--muted);font-size:11px;margin-left:6px">0 PLUs</span>
    </td>
    <td></td>
    <td><button class="btn btn-secondary btn-sm" style="font-size:11px;padding:2px 7px"
      onclick="agregarFilaPlu('${safe}')">+ PLU</button></td>`;
  tbody.appendChild(tr);
  agregarFilaPlu(nombre);
});

document.getElementById('inputNuevaPres').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btnAgregarPresentacion').click();
});

async function guardarGrupo() {
  // Resolver nombre del grupo
  if (editarGrupoEsNuevo) {
    const nombre = document.getElementById('inputNombreGrupo').value.trim();
    if (!nombre) {
      document.getElementById('inputNombreGrupo').focus();
      toast('Escribí un nombre para el grupo antes de guardar', true);
      return;
    }
    const yaExiste = gruposCatCache.some(g => g.productoRef.toLowerCase() === nombre.toLowerCase());
    if (yaExiste) {
      toast(`Ya existe un grupo llamado "${nombre}"`, true);
      document.getElementById('inputNombreGrupo').focus();
      return;
    }
    editarGrupoRef = nombre;
  }

  const rows = [...document.getElementById('editarGrupoBody').querySelectorAll('[data-plu-row]')];
  const items = [];
  for (const row of rows) {
    const plu          = parseInt(row.querySelector('[data-field=plu]').value);
    const producto     = row.querySelector('[data-field=producto]').value.trim();
    const presentacion = row.querySelector('[data-field=presentacion]').value.trim();
    const esVariante   = row.querySelector('[data-field=esVariante]').checked;
    if (!plu || !producto) continue;
    items.push({
      plu, producto,
      baseNombre:   normalizarNombreJS(producto),
      presentacion: presentacion || extraerPresentacionJS(normalizarNombreJS(producto)),
      esVariante,
      refId:       editarGrupoRefId,
      productoRef: editarGrupoRef
    });
  }

  // Grupo nuevo: decidir si es variedad de miel (sección Mieles + tambor).
  if (editarGrupoEsNuevo) {
    if (nuevoGrupoEsMiel) {
      cfgSetEsMiel(editarGrupoRef, true);               // vino del botón "Agregar variedad"
    } else if (/miel/i.test(editarGrupoRef)) {
      const llevar = await preguntarSeccionMiel(editarGrupoRef); // grupo general con "miel" → preguntar
      cfgSetEsMiel(editarGrupoRef, !!llevar);
    }
  }

  const btn = document.getElementById('btnGuardarGrupo');
  btn.disabled = true; btn.textContent = 'Guardando…';
  try {
    const _gPlus = granelesData.map(g => g.plu);
    const _gPlu  = _gPlus[0] || '';
    cfgSetGranelPlus(editarGrupoRef, _gPlus);
    // Persist mpManual into cfg entry (preserves activo + granelPlu already set above)
    const _cfgEntry = gruposCfgLocal[editarGrupoRef];
    if (mpManualData.length > 0) {
      if (_cfgEntry && typeof _cfgEntry === 'object') { _cfgEntry.mpManual = mpManualData; }
      else { gruposCfgLocal[editarGrupoRef] = { activo: _cfgEntry !== false, mpManual: mpManualData }; }
    } else if (_cfgEntry && typeof _cfgEntry === 'object') {
      delete _cfgEntry.mpManual;
    }
    await Promise.all([
      api('PUT', `/api/catalogo/grupo/${encodeURIComponent(editarGrupoRef)}`, items),
      guardarGruposCfg(),
      guardarFormulasGrupo()
    ]);
    toast(`✓ "${editarGrupoRef}" — ${items.length} PLUs${_gPlu ? ' · Granel PLU '+_gPlu : ''}`);
    document.getElementById('overlayEditarGrupo').classList.remove('open');
    cargarCatalogo();
  } catch (e) {
    toast('Error al guardar: ' + e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = 'Guardar cambios';
  }
}

// ── Buscar en Siga ───────────────────────────────────────────────
let buscarSigaTimer = null;

document.getElementById('btnToggleBuscarSiga').addEventListener('click', () => {
  const panel = document.getElementById('panelBuscarSiga');
  const visible = panel.style.display !== 'none';
  panel.style.display = visible ? 'none' : 'block';
  if (!visible) {
    actualizarSelectPres();
    document.getElementById('inputBuscarSiga').focus();
  }
});

function actualizarSelectPres() {
  const sel = document.getElementById('selectPresBuscar');
  const grupos = [...document.querySelectorAll('#editarGrupoBody tr.pres-group-row')];
  sel.innerHTML = '<option value="">Auto-detectar</option>' +
    grupos.map(g => `<option value="${escHtml(g.dataset.group)}">${escHtml(g.dataset.group)}</option>`).join('');
}

document.getElementById('inputBuscarSiga').addEventListener('input', function () {
  clearTimeout(buscarSigaTimer);
  const q = this.value.trim();
  if (q.length < 2) { document.getElementById('resultadosBuscarSiga').innerHTML = ''; return; }
  document.getElementById('resultadosBuscarSiga').innerHTML =
    '<div style="padding:8px 16px;font-size:12px;color:var(--muted)">Buscando…</div>';
  buscarSigaTimer = setTimeout(() => buscarEnSiga(q), 350);
});

document.getElementById('inputBuscarSiga').addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.getElementById('panelBuscarSiga').style.display = 'none';
  }
});

async function buscarEnSiga(q) {
  try {
    const rows = await api('GET', `/api/siga/buscar?q=${encodeURIComponent(q)}`);
    const enCatalogo = new Set(
      [...document.querySelectorAll('#editarGrupoBody [data-field=plu]')].map(i => i.value)
    );
    if (!rows.length) {
      document.getElementById('resultadosBuscarSiga').innerHTML =
        '<div style="padding:8px 16px;font-size:12px;color:var(--muted)">Sin resultados.</div>';
      return;
    }
    const html = rows.map(r => {
      const yaAgregado = enCatalogo.has(String(r.plu));
      return `<div class="search-result${yaAgregado?' siga-ya-cargado':''}"
          style="display:flex;align-items:center;gap:10px;padding:7px 16px;border-bottom:1px solid #e0eaff;cursor:${yaAgregado?'default':'pointer'};background:${yaAgregado?'#f0fdf4':'#fff'}"
          ${yaAgregado ? '' : `onclick="agregarDesdeSiga(${r.plu},'${escHtml(r.producto).replace(/'/g,"\\'")}','${escHtml(r.rubro).replace(/'/g,"\\'")}')"`}>
        <span style="font-family:system-ui,sans-serif;font-weight:700;font-size:13px;color:var(--muted);width:60px;flex-shrink:0">${escHtml(String(r.plu))}</span>
        <span style="flex:1;font-size:13px;${yaAgregado?'color:var(--grn-text)':''}">${escHtml(r.producto)}${yaAgregado?' <span style="font-size:11px">✓ ya cargado</span>':''}</span>
        <span style="font-size:11px;color:var(--muted)">${escHtml(r.rubro)}</span>
      </div>`;
    }).join('');
    document.getElementById('resultadosBuscarSiga').innerHTML = html;
  } catch (e) {
    document.getElementById('resultadosBuscarSiga').innerHTML =
      `<div style="padding:8px 16px;font-size:12px;color:red">Error: ${escHtml(e.message)}</div>`;
  }
}

function agregarDesdeSiga(plu, producto, rubro) {
  const base         = normalizarNombreJS(producto);
  const presDetected = extraerPresentacionJS(base);
  const presManual   = document.getElementById('selectPresBuscar').value;
  const presentacion = presManual || presDetected;

  // Buscar o crear el grupo
  let tbody = document.querySelector('#editarGrupoBody tbody');
  if (!tbody) {
    document.getElementById('editarGrupoBody').innerHTML = buildTablaHTML('');
    tbody = document.querySelector('#editarGrupoBody tbody');
  }

  let groupHeader = [...tbody.querySelectorAll('tr.pres-group-row')]
    .find(tr => tr.dataset.group === presentacion);

  if (!groupHeader) {
    // Crear grupo nuevo
    const safe = presentacion.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    const tr = document.createElement('tr');
    tr.className = 'pres-group-row';
    tr.dataset.group = presentacion;
    tr.innerHTML = `
      <td colspan="3">${escHtml(presentacion)}
        <span style="font-weight:400;color:var(--muted);font-size:11px;margin-left:6px">0 PLUs</span>
      </td>
      <td></td>
      <td><button class="btn btn-secondary btn-sm" style="font-size:11px;padding:2px 7px"
        onclick="agregarFilaPlu('${safe}')">+ PLU</button></td>`;
    tbody.appendChild(tr);
    groupHeader = tr;
    actualizarSelectPres();
  }

  // Insertar PLU después del último row del grupo
  let insertAfter = groupHeader;
  let next = groupHeader.nextElementSibling;
  while (next && !next.classList.contains('pres-group-row')) {
    insertAfter = next;
    next = next.nextElementSibling;
  }

  const esVariante = /\b(pack|bulto|vid)\b/i.test(producto);
  const tr = document.createElement('tr');
  tr.setAttribute('data-plu-row', '');
  tr.innerHTML = `
    <td><input class="plu-input plu-input-plu" type="number" min="1" value="${plu}" data-field="plu"></td>
    <td><input class="plu-input" type="text" value="${escHtml(producto)}" data-field="producto"></td>
    <td><input class="plu-input plu-input-pres" type="text" value="${escHtml(presentacion)}" data-field="presentacion"></td>
    <td style="text-align:center">
      <input type="checkbox" ${esVariante?'checked':''} data-field="esVariante"
        style="width:16px;height:16px;accent-color:var(--verde)">
    </td>
    <td><button class="btn btn-danger btn-sm" style="padding:2px 7px"
      onclick="this.closest('tr').remove();actualizarMetaModal()">✕</button></td>`;
  insertAfter.after(tr);

  // Marcar como ya cargado en los resultados
  document.getElementById('inputBuscarSiga').dispatchEvent(new Event('input'));
  tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
  actualizarMetaModal();
  toast(`✓ PLU ${plu} agregado en "${presentacion}"`);
}

document.getElementById('btnGuardarGrupo').addEventListener('click', guardarGrupo);
document.getElementById('btnCancelarGrupo').addEventListener('click', () =>
  document.getElementById('overlayEditarGrupo').classList.remove('open'));
document.getElementById('cerrarEditarGrupo').addEventListener('click', () =>
  document.getElementById('overlayEditarGrupo').classList.remove('open'));
document.getElementById('overlayEditarGrupo').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
});

// ══════════════════ TAB 4: CATÁLOGO ════════════════════════════

let gruposCatCache = [];
let gruposCfgLocal = {};
function cfgGetActivo(ref){const v=gruposCfgLocal[ref];if(v===undefined)return true;if(typeof v==='boolean')return v;return v.activo!==false;}
function cfgGetGranelPlu(ref){const v=gruposCfgLocal[ref];return(v&&typeof v==='object')?(v.granelPlu||''):''}
// Un grupo puede tener varios graneles. granelPlu = el primero (lo que espera el resto del sistema).
function cfgGetGranelPlus(ref){
  const v=gruposCfgLocal[ref];
  if(!v||typeof v!=='object')return [];
  const lista=(Array.isArray(v.granelPlus)?v.granelPlus:[]).map(x=>String(x||'').trim()).filter(Boolean);
  if(lista.length)return lista;
  const uno=String(v.granelPlu||'').trim();
  return uno?[uno]:[];
}
function cfgGetMpManual(ref){const v=gruposCfgLocal[ref];return(v&&typeof v==='object'&&Array.isArray(v.mpManual))?v.mpManual:[];}
function cfgRawGranelDirecto(ref){const v=gruposCfgLocal[ref];return(v&&typeof v==='object'&&typeof v.granelDirecto==='boolean')?v.granelDirecto:null;}
function cfgGetGranelDirecto(ref){const o=cfgRawGranelDirecto(ref);if(o!==null)return o;const g=gruposCatCache.find(x=>x.productoRef===ref);return g?!!g.esGranel:false;}
function cfgRawEsMiel(ref){const v=gruposCfgLocal[ref];return(v&&typeof v==='object'&&typeof v.esMiel==='boolean')?v.esMiel:null;}
// Por defecto (sin override) cae al nombre que arranca con "Miel".
function cfgGetEsMiel(ref){const o=cfgRawEsMiel(ref);if(o!==null)return o;return /^miel\b/i.test((ref||'').trim());}
// El grupo se planifica por presentaciones, pero antes hay que fabricar el granel (pepas → masa).
function cfgGetReqGranel(ref){const v=gruposCfgLocal[ref];return !!(v&&typeof v==='object'&&v.reqGranel===true);}
function cfgEntry(ref,{activo,granelPlu,granelPlus,mpManual,granelDirecto,esMiel,reqGranel}){const obj={activo};const _gl=[...new Set((granelPlus||[]).map(x=>String(x||'').trim()).filter(Boolean))];const _g1=_gl[0]||granelPlu||'';if(_g1)obj.granelPlu=_g1;if(_gl.length>1)obj.granelPlus=_gl;if(mpManual&&mpManual.length)obj.mpManual=mpManual;if(granelDirecto!==null&&granelDirecto!==undefined)obj.granelDirecto=granelDirecto;if(esMiel!==null&&esMiel!==undefined)obj.esMiel=esMiel;if(reqGranel)obj.reqGranel=true;const extra=obj.granelPlu||obj.mpManual||obj.granelDirecto!==undefined||obj.esMiel!==undefined||obj.reqGranel;return extra?obj:activo;}
// Setter genérico: parte de la config actual del grupo y aplica solo los campos del patch.
function cfgSet(ref,patch){gruposCfgLocal[ref]=cfgEntry(ref,{activo:cfgGetActivo(ref),granelPlus:cfgGetGranelPlus(ref),mpManual:cfgGetMpManual(ref),granelDirecto:cfgRawGranelDirecto(ref),esMiel:cfgRawEsMiel(ref),reqGranel:cfgGetReqGranel(ref),...patch});}
function cfgSetActivo(ref,a){cfgSet(ref,{activo:a});}
function cfgSetGranelPlus(ref,plus){cfgSet(ref,{granelPlus:plus});}
function cfgSetGranelDirecto(ref,val){cfgSet(ref,{granelDirecto:val});}
function cfgSetEsMiel(ref,val){cfgSet(ref,{esMiel:val});}
function cfgSetReqGranel(ref,val){cfgSet(ref,{reqGranel:val});}

async function cargarCatalogo() {
  try {
    gruposCatCache = await api('GET', '/api/catalogo/grupos');
    gruposCfgLocal = {};
    for (const g of gruposCatCache) {
      const gp = g.granelPlu || '';
      const mp = Array.isArray(g.mpManual) ? g.mpManual : [];
      const gd = (typeof g.granelDirecto === 'boolean') ? g.granelDirecto : null;
      const em = (typeof g.esMiel === 'boolean') ? g.esMiel : null;
      const rg = g.reqGranel === true;
      const gl = (Array.isArray(g.granelPlus) ? g.granelPlus : []).map(String).filter(Boolean);
      gruposCfgLocal[g.productoRef] = (gp || mp.length || gd !== null || em !== null || rg)
        ? { activo: g.activo, ...(gp?{granelPlu:gp}:{}), ...(gl.length>1?{granelPlus:gl}:{}), ...(mp.length?{mpManual:mp}:{}), ...(gd!==null?{granelDirecto:gd}:{}), ...(em!==null?{esMiel:em}:{}), ...(rg?{reqGranel:true}:{}) }
        : g.activo;
    }
    renderCatalogo();
  } catch (e) {
    toast('Error al cargar catálogo: ' + e.message, true);
  }
}

function renderCatalogo() {
  const q = document.getElementById('filtroCatalogo').value.trim().toLowerCase();
  const filtrado = q
    ? gruposCatCache.filter(g => g.productoRef.toLowerCase().includes(q))
    : gruposCatCache;

  const mieles = filtrado.filter(g => cfgGetEsMiel(g.productoRef));
  const otros  = filtrado.filter(g => !cfgGetEsMiel(g.productoRef));

  const activos   = gruposCatCache.filter(g => cfgGetActivo(g.productoRef)).length;
  const totalPlu  = gruposCatCache.reduce((s, g) => s + g.totalPlu, 0);
  document.getElementById('cTotalGrupos').textContent  = gruposCatCache.length;
  document.getElementById('cActivosGrupos').textContent = activos;
  document.getElementById('cTotalPlu').textContent      = totalPlu;

  document.getElementById('tablaMieles').innerHTML = renderGrupoRows(mieles) || '<div class="loading">Sin variedades de miel en el catálogo.</div>';
  document.getElementById('tablaOtros').innerHTML  = renderGrupoRows(otros)  || '<div class="loading">Sin grupos.</div>';
}

function renderGrupoRows(grupos) {
  if (!grupos.length) return '';
  return grupos.map(g => {
    const activo = cfgGetActivo(g.productoRef);
    const gPlu   = cfgGetGranelPlus(g.productoRef).join(', ');
    const esGranelG = cfgGetGranelDirecto(g.productoRef);
    const reqGran   = cfgGetReqGranel(g.productoRef);
    const id     = 'tog-' + g.productoRef.replace(/\W+/g, '_');
    const idG    = 'tggran-' + g.productoRef.replace(/\W+/g, '_');
    const idRG   = 'tgreqg-' + g.productoRef.replace(/\W+/g, '_');
    const ref    = g.productoRef.replace(/'/g, "\\'");
    return `<div class="grupo-cat-row">
      <label class="toggle-switch">
        <input type="checkbox" id="${id}" ${activo ? 'checked' : ''}
          onchange="toggleGrupoActivo('${ref}', this.checked)">
        <span class="toggle-slider"></span>
      </label>
      <span class="grupo-cat-nombre${activo ? '' : ' inactivo'}">${escHtml(g.productoRef)}</span>
      <div class="grupo-cat-meta">
        <span title="Presentaciones base">${g.presentaciones} presentaciones</span>
        <span title="Total PLUs">${g.totalPlu} PLUs</span>
        ${g.variantes ? `<span title="Packs y bultos">${g.variantes} variantes</span>` : ''}
        ${gPlu ? `<span title="Granel (MP)" style="color:var(--amb-text);font-weight:700">🛢 ${gPlu}</span>` : ''}
      </div>
      <label class="toggle-switch" title="Producir como granel (bulk). Off = planificar por presentaciones." style="transform:scale(.8)">
        <input type="checkbox" id="${idG}" ${esGranelG ? 'checked' : ''}
          onchange="toggleGrupoGranel('${ref}', this.checked)">
        <span class="toggle-slider"></span>
      </label>
      <span style="font-size:11px;color:${esGranelG?'#065f46':'var(--muted)'};font-weight:${esGranelG?'700':'400'};margin-right:6px">granel</span>
      <label style="font-size:11px;display:flex;align-items:center;gap:4px;color:${reqGran?'var(--amb-text)':'var(--muted)'};font-weight:${reqGran?'700':'400'}"
        title="Se hace en presentaciones pero primero hay que fabricar el granel (ej. pepas → masa). Al agregarlo al plan avisa y suma la orden de granel.">
        <input type="checkbox" id="${idRG}" ${reqGran ? 'checked' : ''}
          onchange="toggleGrupoReqGranel('${ref}', this.checked)">
        granel previo
      </label>
      <button class="btn btn-secondary btn-sm" style="font-size:11px;margin-left:8px"
        onclick="abrirModalGrupo('${ref}')">Ver / Editar</button>
    </div>`;
  }).join('');
}

async function toggleGrupoActivo(productoRef, activo) {
  cfgSetActivo(productoRef, activo);
  renderCatalogo();
  await guardarGruposCfg();
}

async function toggleGrupoGranel(productoRef, esGranel) {
  cfgSetGranelDirecto(productoRef, esGranel);
  renderCatalogo();
  await guardarGruposCfg();
}

async function toggleGrupoReqGranel(productoRef, req) {
  cfgSetReqGranel(productoRef, req);
  renderCatalogo();
  await guardarGruposCfg();
}

async function guardarGruposCfg() {
  try {
    await api('POST', '/api/catalogo/grupos-config', gruposCfgLocal);
  } catch (e) { toast('Error al guardar config: ' + e.message, true); }
}

async function toggleTodasMieles(activo) {
  for (const g of gruposCatCache)
    if (cfgGetEsMiel(g.productoRef)) cfgSetActivo(g.productoRef, activo);
  renderCatalogo();
  await guardarGruposCfg();
}

async function toggleTodosOtros(activo) {
  for (const g of gruposCatCache)
    if (!cfgGetEsMiel(g.productoRef)) cfgSetActivo(g.productoRef, activo);
  renderCatalogo();
  await guardarGruposCfg();
}

document.getElementById('filtroCatalogo').addEventListener('input', renderCatalogo);
document.getElementById('btnRecargarCatalogo').addEventListener('click', cargarCatalogo);
document.getElementById('btnNuevoGrupo').addEventListener('click', abrirModalNuevoGrupo);
document.getElementById('btnNuevaVariedadMiel').addEventListener('click', abrirModalNuevaVariedadMiel);
document.getElementById('btnActivarTodasMieles').addEventListener('click',    () => toggleTodasMieles(true));
document.getElementById('btnDesactivarTodasMieles').addEventListener('click', () => toggleTodasMieles(false));
document.getElementById('btnActivarTodos').addEventListener('click',    () => toggleTodosOtros(true));
document.getElementById('btnDesactivarTodos').addEventListener('click', () => toggleTodosOtros(false));

// ── Importar catálogo (tab Catálogo) ──────────────────────────────
document.getElementById('inputCatalogoTab').addEventListener('change', async function () {
  const file = this.files[0];
  if (!file) return;
  this.disabled = true;
  document.getElementById('btnImportarCatalogoTab').childNodes[0].textContent = '⏳ Importando… ';
  try {
    const fd = new FormData();
    fd.append('archivo', file);
    const res  = await fetch(SERVER_URL + '/api/catalogo/importar', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    toast(`✓ Catálogo actualizado — ${data.productos} productos`);
    cargarCatalogo();
  } catch (err) {
    toast('Error al importar: ' + err.message, true);
  } finally {
    document.getElementById('btnImportarCatalogoTab').childNodes[0].textContent = '📥 Actualizar catálogo ';
    this.value = '';
    this.disabled = false;
  }
});

// ── Importar catálogo ─────────────────────────────────────────────
document.getElementById('inputCatalogo').addEventListener('change', async function () {
  const file = this.files[0];
  if (!file) return;
  const label = document.getElementById('btnImportarCatalogo');
  const textoOriginal = '📥 Actualizar catálogo';
  label.childNodes[0].textContent = '⏳ Importando… ';
  this.disabled = true;
  try {
    const fd = new FormData();
    fd.append('archivo', file);
    const res  = await fetch(SERVER_URL + '/api/catalogo/importar', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    toast(`✓ Catálogo actualizado — ${data.productos} productos`);
    cargarSugerencias();
  } catch (err) {
    toast('Error al importar: ' + err.message, true);
  } finally {
    label.childNodes[0].textContent = textoOriginal + ' ';
    this.value = '';
    this.disabled = false;
  }
});
