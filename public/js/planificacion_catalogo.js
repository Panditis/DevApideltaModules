'use strict';

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
  let esMielNuevo;
  if (editarGrupoEsNuevo) {
    if (nuevoGrupoEsMiel) {
      esMielNuevo = true;                               // vino del botón "Agregar variedad"
    } else if (/miel/i.test(editarGrupoRef)) {
      const llevar = await preguntarSeccionMiel(editarGrupoRef); // grupo general con "miel" → preguntar
      esMielNuevo = !!llevar;
    }
  }

  const btn = document.getElementById('btnGuardarGrupo');
  btn.disabled = true; btn.textContent = 'Guardando…';
  try {
    const _gPlus = granelesData.map(g => String(g.plu));
    const _gPlu  = _gPlus[0] || '';
    // Primero el grupo (el PATCH de meta exige que exista en catalogo.json), después su config.
    await api('PUT', `/api/catalogo/grupo/${encodeURIComponent(editarGrupoRef)}`, items);
    await Promise.all([
      api('PATCH', `/api/catalogo/grupo/${encodeURIComponent(editarGrupoRef)}/meta`,
        { granelPlus: _gPlus, mpManual: mpManualData, ...(esMielNuevo !== undefined ? { esMiel: esMielNuevo } : {}) }),
      guardarFormulasGrupo(),
    ]);
    toast(`✓ "${editarGrupoRef}" — ${items.length} PLUs${_gPlu ? ' · Granel PLU '+_gPlu : ''}`);
    document.getElementById('overlayEditarGrupo').classList.remove('open');
    cargarCatalogo();
  } catch (e) {
    toast('Error al guardar: ' + mensajeApiError(e), true);
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

// ── CATÁLOGO DE PRODUCCIÓN (spec 2026-10-22-planificacion-centro §2) ──────
// Lista simple: una fila por producto (granel base o grupo) con Tipo, Granel base y el tilde Activo.
// Lo demás (estado, motivo, fasón, responsables, próxima fecha) se edita en el panel de detalle (click en la fila).
// Todo se guarda con PATCH (grupo: /api/catalogo/grupo/:ref/meta; granel: /api/plan/graneles-base/:plu).
let granelesBaseCache = [];
let clientesCatCache = [];
let catFiltro = 'todos';

function cfgLocalDesdeGrupos(grupos) {
  const out = {};
  for (const g of grupos) {
    const gl = (Array.isArray(g.granelPlus) ? g.granelPlus : []).map(String).filter(Boolean);
    out[g.productoRef] = {
      activo: g.activo, ...(gl[0] ? { granelPlu: gl[0] } : {}), ...(gl.length > 1 ? { granelPlus: gl } : {}),
      ...(Array.isArray(g.mpManual) && g.mpManual.length ? { mpManual: g.mpManual } : {}),
      ...(typeof g.granelDirecto === 'boolean' ? { granelDirecto: g.granelDirecto } : {}),
      ...(typeof g.esMiel === 'boolean' ? { esMiel: g.esMiel } : {}),
      ...(g.reqGranel === true ? { reqGranel: true } : {}),
    };
  }
  return out;
}

async function cargarCatalogo() {
  try {
    const [grupos, graneles, clientes] = await Promise.all([
      api('GET', '/api/catalogo/grupos'), api('GET', '/api/plan/graneles-base'), api('GET', '/api/clientes-registro'),
    ]);
    gruposCatCache = grupos;
    granelesBaseCache = graneles;
    clientesCatCache = clientes;
    gruposCfgLocal = cfgLocalDesdeGrupos(grupos);
    renderCatalogo();
  } catch (e) {
    toast('Error al cargar catálogo: ' + mensajeApiError(e), true);
  }
}

const opcionesHTML = (pares, valor) => pares.map(([v, t]) => `<option value="${escHtml(String(v))}" ${String(v) === String(valor ?? '') ? 'selected' : ''}>${escHtml(t)}</option>`).join('');
const ESTADOS_CAT = [['activo', 'Activo'], ['pausado', 'Pausado'], ['discontinuado', 'Discontinuado']];
const CAT_TIPO_TXT = { granel: 'Con granel base', directo: 'Directo' };

const catNombreGranel = plu => (granelesBaseCache.find(b => String(b.plu) === String(plu)) || {}).nombre || 'PLU ' + plu;
const catNombreCliente = id => (clientesCatCache.find(c => String(c.id) === String(id)) || {}).nombre || 'Cliente ' + id;

// ── Lista ─────────────────────────────────────────────────────────
// Una fila por granel base y por grupo: { esGranel, clave, nombre, x } (x = objeto del cache).
// Alfabético; los discontinuados van al final.
function catFilas() {
  const q = document.getElementById('filtroCatalogo').value.trim().toLowerCase();
  const grupoPasa = g => catFiltro === 'todos' || (catFiltro === 'fason' ? g.clienteId != null : (catFiltro === g.tipo && g.clienteId == null));
  const graneles = (catFiltro === 'todos' || catFiltro === 'graneles')
    ? granelesBaseCache.map(b => ({ esGranel: true, clave: b.plu, nombre: b.nombre, x: b })) : [];
  const grupos = catFiltro === 'graneles' ? []
    : gruposCatCache.filter(grupoPasa).map(g => ({ esGranel: false, clave: g.productoRef, nombre: g.productoRef, x: g }));
  const disc = f => (f.x.estado === 'discontinuado' ? 1 : 0);
  return [...graneles, ...grupos].filter(f => !q || f.nombre.toLowerCase().includes(q))
    .sort((a, b) => disc(a) - disc(b) || a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));
}

function catCeldaGranel(f) {
  if (f.esGranel) return '—';
  const gl = f.x.granelPlus || [];
  if (!gl.length) return f.x.tipo === 'granel' ? '<span class="granel-warn">sin granel</span>' : '—';
  const txt = escHtml(gl.map(catNombreGranel).join(', '));
  // En un producto directo el granel es solo la referencia para ver el stock de MP.
  return f.x.tipo === 'granel' ? txt : `<span class="text-sm" title="Referencia para ver el stock de MP">${txt}</span>`;
}

function catBadges(f) {
  const pausa = f.x.estado === 'pausado' ? `<span class="cat-badge" title="${escHtml(f.x.motivo)}">⏸ Pausado</span>` : '';
  const fason = !f.esGranel && f.x.clienteId != null ? `<span class="cat-badge fason">Fasón · ${escHtml(catNombreCliente(f.x.clienteId))}</span>` : '';
  return pausa + fason;
}

function catFilaHTML(f) {
  const disc = f.x.estado === 'discontinuado';
  return `<tr ${f.esGranel ? 'data-granel' : 'data-ref'}="${escHtml(f.clave)}"${disc ? ' class="inactivo"' : ''}>
    <td class="font-bold">${escHtml(f.nombre)}${catBadges(f)}</td>
    <td>${f.esGranel ? 'Granel base' : escHtml(CAT_TIPO_TXT[f.x.tipo] || '')}</td>
    <td>${catCeldaGranel(f)}</td>
    <td class="cat-activo"><input type="checkbox" data-activo title="Activo"${disc ? '' : ' checked'}></td>
  </tr>`;
}

function renderCatalogo() {
  document.getElementById('cTotalGrupos').textContent = gruposCatCache.length;
  document.getElementById('cActivosGrupos').textContent = gruposCatCache.filter(g => g.estado !== 'discontinuado').length;
  document.getElementById('cTotalPlu').textContent = gruposCatCache.reduce((s, g) => s + g.totalPlu, 0);
  document.querySelectorAll('#catChips [data-filtro]').forEach(b => {
    b.classList.toggle('btn-primary', b.dataset.filtro === catFiltro);
    b.classList.toggle('btn-secondary', b.dataset.filtro !== catFiltro);
  });
  const filas = catFilas();
  document.getElementById('tablaCatalogo').innerHTML = filas.length
    ? `<table class="cat-tabla"><thead><tr><th>Producto</th><th>Tipo</th><th>Granel base</th><th class="cat-activo">Activo</th></tr></thead>
        <tbody>${filas.map(catFilaHTML).join('')}</tbody></table>`
    : '<div class="loading">Sin resultados.</div>';
}

// Aplica un PATCH a un grupo o a un granel base y actualiza los caches. Devuelve true si hay que
// recargar todo el catálogo: tipo/granelPlus de un grupo cambian las variedades de los graneles base.
async function catPatchear(esGranel, clave, patch) {
  if (esGranel) {
    const r = await api('PATCH', `/api/plan/graneles-base/${encodeURIComponent(clave)}`, patch);
    granelesBaseCache = granelesBaseCache.map(b => (b.plu === clave ? r : b));
    return false;
  }
  const r = await api('PATCH', `/api/catalogo/grupo/${encodeURIComponent(clave)}/meta`, patch);
  gruposCatCache = gruposCatCache.map(g => (g.productoRef === clave ? { ...g, ...r } : g));
  gruposCfgLocal = cfgLocalDesdeGrupos(gruposCatCache);
  return 'tipo' in patch || 'granelPlus' in patch;
}

// Tilde Activo: destildar = discontinuado, tildar = activo (un pausado sigue tildado, con su badge).
document.getElementById('tablaCatalogo').addEventListener('change', async e => {
  const chk = e.target.closest('input[data-activo]');
  if (!chk) return;
  const fila = chk.closest('tr');
  const esGranel = fila.dataset.granel != null;
  chk.disabled = true;
  try {
    await catPatchear(esGranel, esGranel ? fila.dataset.granel : fila.dataset.ref, { estado: chk.checked ? 'activo' : 'discontinuado' });
    toast('Guardado');
  } catch (err) {
    toast('No se guardó: ' + mensajeApiError(err), true);
  }
  renderCatalogo(); // reordena (los discontinuados bajan) y, si falló, vuelve al valor guardado
});
document.getElementById('tablaCatalogo').addEventListener('click', e => {
  const fila = e.target.closest('tbody tr');
  if (!fila || e.target.closest('.cat-activo')) return;
  const esGranel = fila.dataset.granel != null;
  catAbrirDetalle(esGranel, esGranel ? fila.dataset.granel : fila.dataset.ref);
});

// ── Panel de detalle ──────────────────────────────────────────────
let catDet = null; // { esGranel, clave, orig } del producto abierto en el panel

function catDetEstadoHTML(x) {
  return `<div class="cat-dos">
    <label class="cat-campo">Estado<select data-campo="estado">${opcionesHTML(ESTADOS_CAT, x.estado)}</select></label>
    <label class="cat-campo" data-motivo${x.estado === 'pausado' ? '' : ' hidden'}>Motivo de la pausa<input type="text" data-campo="motivo" value="${escHtml(x.motivo)}"></label>
  </div>`;
}

function catDetRespFechaHTML(x) {
  // Los responsables ya guardados se listan aunque no estén en la lista actual: así no se pierden al guardar.
  const nombres = [...new Set([...(responsablesCache || []).map(respNombre).filter(Boolean), ...x.responsables])];
  const checks = nombres.map(n => `<label><input type="checkbox" data-campo="responsables" value="${escHtml(n)}"${x.responsables.includes(n) ? ' checked' : ''}> ${escHtml(n)}</label>`).join('');
  return `<div class="cat-campo">Responsables<div class="cat-resp">${checks || '<span class="text-sm">No hay responsables cargados</span>'}</div></div>
    <label class="cat-campo">Próxima producción<input type="date" data-campo="proximaFecha" value="${escHtml(x.proximaFecha || '')}"></label>`;
}

function catDetGrupoHTML(g) {
  const gl = g.granelPlus || [];
  const opcionesGranel = [['', '— sin granel —'], ...granelesBaseCache.map(b => [b.plu, b.nombre])];
  // Un granel que no está en los graneles base igual se muestra (si no, el select diría "sin granel").
  if (gl.length === 1 && !opcionesGranel.some(([v]) => String(v) === String(gl[0]))) opcionesGranel.push([gl[0], 'PLU ' + gl[0]]);
  const granel = gl.length > 1
    ? `<div class="cat-campo">Granel base<div class="cat-ro">${escHtml(gl.map(catNombreGranel).join(', '))}</div><span class="text-sm">Varios graneles: se editan en Presentaciones.</span></div>`
    : `<label class="cat-campo">Granel base<select data-campo="granel">${opcionesHTML(opcionesGranel, gl[0] || '')}</select></label>`;
  const clientes = [['', 'Propio'], ...clientesCatCache.map(c => [c.id, c.nombre])];
  return `<div class="cat-dos">
      <label class="cat-campo">Tipo<select data-campo="tipo">${opcionesHTML(Object.entries(CAT_TIPO_TXT), g.tipo)}</select></label>
      ${granel}
    </div>
    ${catDetEstadoHTML(g)}
    <label class="cat-campo">Cliente fasón<select data-campo="clienteId">${opcionesHTML(clientes, g.clienteId ?? '')}</select></label>
    ${catDetRespFechaHTML(g)}
    <div class="cat-pres"><span>${g.presentaciones} presentaciones · ${g.totalPlu} PLUs</span>
      <button class="btn btn-secondary btn-sm" data-accion="presentaciones">Editar presentaciones</button></div>`;
}

function catDetGranelHTML(b) {
  return `<label class="cat-campo">Nombre<input type="text" data-campo="nombre" value="${escHtml(b.nombre)}"></label>
    ${catDetEstadoHTML(b)}
    ${catDetRespFechaHTML(b)}
    <div class="cat-campo">Alimenta<div class="cat-ro">${b.variedades.length ? escHtml(b.variedades.join(', ')) : 'sin variedades'}</div></div>`;
}

function catMostrarError(msg) {
  const el = document.getElementById('catDetError');
  el.textContent = msg;
  el.hidden = !msg;
}

function catAbrirDetalle(esGranel, clave) {
  const x = esGranel ? granelesBaseCache.find(b => b.plu === clave) : gruposCatCache.find(g => g.productoRef === clave);
  if (!x) return;
  catDet = { esGranel, clave, orig: x };
  document.getElementById('catDetTitulo').textContent = esGranel ? `Granel base · ${x.nombre}` : clave;
  document.getElementById('catDetBody').innerHTML = esGranel ? catDetGranelHTML(x) : catDetGrupoHTML(x);
  catMostrarError('');
  document.getElementById('overlayCatDetalle').classList.add('open');
}

function catCerrarDetalle() {
  catDet = null;
  document.getElementById('overlayCatDetalle').classList.remove('open');
}

// Valores del formulario del panel; un campo que el panel no muestra queda undefined.
function catLeerForm() {
  const body = document.getElementById('catDetBody');
  const val = c => { const el = body.querySelector(`[data-campo=${c}]`); return el ? el.value : undefined; };
  return {
    tipo: val('tipo'), granel: val('granel'), estado: val('estado'), motivo: (val('motivo') || '').trim(),
    clienteId: val('clienteId'), nombre: val('nombre'), proximaFecha: val('proximaFecha'),
    responsables: [...body.querySelectorAll('[data-campo=responsables]:checked')].map(x => x.value),
  };
}

function catValidarForm(orig, f, esGranel) {
  if (f.estado === 'pausado' && !f.motivo) return 'Indicá el motivo de la pausa.';
  if (esGranel) return '';
  const granel = f.granel !== undefined ? (f.granel ? [f.granel] : []) : (orig.granelPlus || []);
  if ((f.tipo ?? orig.tipo) === 'granel' && !granel.length) return 'Un producto "Con granel base" necesita su granel base: elegilo en la lista.';
  return '';
}

// Compara el formulario con el original y arma el PATCH solo con lo que cambió.
function catArmarPatch(orig, f) {
  const patch = {};
  const motivoOrig = orig.estado === 'pausado' ? orig.motivo : '';
  const motivoNuevo = f.estado === 'pausado' ? f.motivo : '';
  if (f.estado !== orig.estado || motivoNuevo !== motivoOrig) Object.assign(patch, { estado: f.estado, motivo: motivoNuevo });
  if (f.nombre !== undefined && f.nombre.trim() !== orig.nombre) patch.nombre = f.nombre.trim();
  if (f.tipo !== undefined && f.tipo !== orig.tipo) patch.tipo = f.tipo;
  if (f.granel !== undefined && f.granel !== String((orig.granelPlus || [])[0] || '')) patch.granelPlus = f.granel ? [f.granel] : [];
  if (f.clienteId !== undefined && f.clienteId !== String(orig.clienteId ?? '')) patch.clienteId = f.clienteId === '' ? null : Number(f.clienteId);
  if ([...f.responsables].sort().join('|') !== [...orig.responsables].sort().join('|')) patch.responsables = f.responsables;
  if ((f.proximaFecha || null) !== (orig.proximaFecha || null)) patch.proximaFecha = f.proximaFecha || null;
  return patch;
}

async function catGuardarDetalle() {
  if (!catDet) return;
  const { esGranel, clave, orig } = catDet;
  const f = catLeerForm();
  const invalido = catValidarForm(orig, f, esGranel);
  if (invalido) { catMostrarError(invalido); return; }
  const patch = catArmarPatch(orig, f);
  if (!Object.keys(patch).length) { catCerrarDetalle(); return; }
  const btn = document.getElementById('btnCatDetGuardar');
  btn.disabled = true; btn.textContent = 'Guardando…';
  try {
    const recargar = await catPatchear(esGranel, clave, patch);
    catCerrarDetalle();
    toast('Guardado');
    if (recargar) await cargarCatalogo(); else renderCatalogo();
  } catch (e) {
    catMostrarError(mensajeApiError(e)); // el panel queda abierto con lo que el usuario escribió
  } finally {
    btn.disabled = false; btn.textContent = 'Guardar';
  }
}

document.getElementById('catDetBody').addEventListener('change', e => {
  if (e.target.dataset.campo !== 'estado') return;
  const motivo = document.querySelector('#catDetBody [data-motivo]');
  motivo.hidden = e.target.value !== 'pausado';
  if (!motivo.hidden) motivo.querySelector('input').focus();
});
document.getElementById('catDetBody').addEventListener('click', e => {
  if (!e.target.closest('[data-accion=presentaciones]') || !catDet) return;
  const ref = catDet.clave;
  catCerrarDetalle();
  abrirModalGrupo(ref);
});
document.getElementById('btnCatDetGuardar').addEventListener('click', catGuardarDetalle);
document.getElementById('btnCatDetCancelar').addEventListener('click', catCerrarDetalle);
document.getElementById('cerrarCatDet').addEventListener('click', catCerrarDetalle);
document.getElementById('overlayCatDetalle').addEventListener('click', e => { if (e.target === e.currentTarget) catCerrarDetalle(); });

// ── Filtros y altas ───────────────────────────────────────────────
document.getElementById('catChips').addEventListener('click', e => {
  const b = e.target.closest('[data-filtro]');
  if (!b) return;
  catFiltro = b.dataset.filtro;
  renderCatalogo();
});
document.getElementById('btnNuevoGranelBase').addEventListener('click', async () => {
  const plu = (prompt('PLU de SIGA del granel base') || '').trim();
  if (!plu) return;
  try {
    await api('POST', '/api/plan/graneles-base', { plu });
    toast(`Granel ${plu} agregado`);
    catFiltro = 'graneles';
    cargarCatalogo();
  } catch (e) { toast('No se pudo agregar: ' + mensajeApiError(e), true); }
});

document.getElementById('filtroCatalogo').addEventListener('input', renderCatalogo);
document.getElementById('btnRecargarCatalogo').addEventListener('click', cargarCatalogo);
document.getElementById('btnNuevoGrupo').addEventListener('click', abrirModalNuevoGrupo);
document.getElementById('btnNuevaVariedadMiel').addEventListener('click', abrirModalNuevaVariedadMiel);

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
