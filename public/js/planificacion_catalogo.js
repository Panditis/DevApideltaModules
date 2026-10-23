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
  presModal = []; presModalCargado = true; presEditando = null;
  renderPresModal();
  document.getElementById('inputNuevaPres').value = '';
  document.getElementById('inputGranelPlu').value = '';
  granelesData = [];
  renderGraneles();
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
  presModal = []; presModalCargado = false; presEditando = null;
  document.getElementById('editarGrupoMeta').textContent      = 'Cargando…';
  document.getElementById('editarGrupoBody').innerHTML        = '<div class="loading">Cargando…</div>';
  document.getElementById('inputNuevaPres').value             = '';
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

// ── Presentaciones del grupo (tab Presentaciones) ─────────────────
// Estado en memoria: se renderiza desde acá y se guarda desde acá (nada se lee del DOM al guardar).
// Cada presentación junta códigos de SIGA; los mayoristas cuentan solo sus ventas de Casa Central a
// clientes MAYORISTA y no suman stock (ver lib/catalogo_presentaciones.js).
let presModal        = [];    // [{ nombre, codigos: [{ plu, producto, esMayorista }] }]
let presModalCargado = false; // false mientras carga o si falló: no se guarda (pisaría el grupo con nada)
let presEditando     = null;  // índice de la presentación que se está renombrando
let resultadosSiga   = {};    // índice de presentación → filas del buscador de SIGA
let buscarSigaTimer  = null;
const MAYORISTA_SUGERIDO_RE = /\b(pack|bulto|vid)\b/i;

// Misma regla que lib/catalogo_presentaciones.js: sin esMayorista escrito, el esVariante viejo es mayorista.
function esMayoristaJS(item) {
  return !!item && (item.esMayorista === true || (item.esMayorista === undefined && item.esVariante === true));
}

function renderModalGrupoBody(items) {
  const porPres = new Map();
  for (const it of items) {
    const nombre = it.presentacion || '(sin presentación)';
    if (!porPres.has(nombre)) porPres.set(nombre, []);
    porPres.get(nombre).push({ plu: Number(it.plu), producto: it.producto || it.baseNombre || '', esMayorista: esMayoristaJS(it) });
  }
  presModal = [...porPres.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([nombre, codigos]) => ({ nombre, codigos }));
  presModalCargado = true;
  renderPresModal();
}

function renderPresModal() {
  const nCod = presModal.reduce((s, p) => s + p.codigos.length, 0);
  document.getElementById('editarGrupoMeta').textContent = `${presModal.length} presentaciones · ${nCod} códigos`;
  resultadosSiga = {};
  document.getElementById('editarGrupoBody').innerHTML = presModal.length
    ? presModal.map(renderTarjetaPres).join('')
    : '<div class="loading" style="padding:32px">Sin presentaciones. Creá una arriba (ej: 500G) y agregale los códigos de SIGA.</div>';
}

function renderTarjetaPres(p, i) {
  const titulo = presEditando === i
    ? `<input type="text" class="plu-input pres-renombrar" data-i="${i}" value="${escHtml(p.nombre)}" style="width:180px">`
    : `<span>${escHtml(p.nombre)}</span>`;
  const filas = p.codigos.map((c, j) => `<div class="pres-cod-row${c.esMayorista ? ' mayorista' : ''}">
      <span class="pres-cod-plu">${escHtml(String(c.plu))}</span>
      <span class="pres-cod-nombre">${escHtml(c.producto)}${c.esMayorista ? ' <span class="badge-mayorista">Mayorista</span>' : ''}</span>
      <label class="pres-cod-may" title="Sus ventas se cuentan con las de Casa Central a clientes mayoristas; su stock no suma">
        <input type="checkbox" data-acc="mayorista" data-i="${i}" data-j="${j}" ${c.esMayorista ? 'checked' : ''}> Es mayorista</label>
      <button class="btn btn-danger btn-sm pres-btn-mini" data-acc="quitar" data-i="${i}" data-j="${j}" title="Quitar código">✕</button>
    </div>`).join('');
  return `<div class="pres-card">
    <div class="pres-card-head">${titulo}
      <span class="pres-cant">${p.codigos.length} código${p.codigos.length !== 1 ? 's' : ''}</span>
      <span style="flex:1"></span>
      <button class="btn btn-secondary btn-sm pres-btn-mini" data-acc="renombrar" data-i="${i}" title="Renombrar">✎</button>
      <button class="btn btn-danger btn-sm pres-btn-mini" data-acc="borrar" data-i="${i}" title="Borrar presentación">🗑</button>
    </div>
    ${filas || '<div class="pres-cod-vacio">Sin códigos todavía.</div>'}
    <div class="pres-buscar">
      <input type="text" class="plu-input pres-buscar-input" data-i="${i}" placeholder="Agregar código (PLU o nombre)…">
      <div class="pres-buscar-res" data-i="${i}"></div>
    </div>
  </div>`;
}

const presExiste = (nombre, salvo) => presModal.some((p, k) => k !== salvo && p.nombre.toLowerCase() === nombre.toLowerCase());
// Nombre de la presentación del grupo que ya tiene el PLU, o null.
function presDePlu(plu) {
  const p = presModal.find(x => x.codigos.some(c => c.plu === Number(plu)));
  return p ? p.nombre : null;
}
const inputBuscarDe = i => document.querySelector(`#editarGrupoBody .pres-buscar-input[data-i="${i}"]`);
const resultadosDe  = i => document.querySelector(`#editarGrupoBody .pres-buscar-res[data-i="${i}"]`);

function crearPresentacion() {
  const inp = document.getElementById('inputNuevaPres');
  const nombre = inp.value.trim();
  if (!nombre) { inp.focus(); return; }
  if (presExiste(nombre)) { toast(`Ya existe la presentación "${nombre}"`, true); inp.focus(); return; }
  presModal = [...presModal, { nombre, codigos: [] }];
  inp.value = '';
  presEditando = null;
  renderPresModal();
  const nueva = inputBuscarDe(presModal.length - 1);
  nueva.scrollIntoView({ block: 'center' });
  nueva.focus();
}

function confirmarRenombre(i, valor) {
  if (presEditando !== i) return; // ya confirmado (Enter y después blur)
  presEditando = null;
  const nombre = valor.trim();
  if (nombre && nombre !== presModal[i].nombre) {
    if (presExiste(nombre, i)) toast(`Ya existe la presentación "${nombre}"`, true);
    else presModal = presModal.map((p, k) => k === i ? { ...p, nombre } : p);
  }
  renderPresModal();
}

function borrarPresentacion(i) {
  const p = presModal[i];
  if (p.codigos.length && !confirm(`¿Borrar la presentación "${p.nombre}" y sus ${p.codigos.length} códigos?`)) return;
  presModal = presModal.filter((_, k) => k !== i);
  presEditando = null;
  renderPresModal();
}

const cambiarCodigos = (i, fn) => { presModal = presModal.map((p, k) => k === i ? { ...p, codigos: fn(p.codigos) } : p); };

async function buscarEnSiga(i, q) {
  const cont = resultadosDe(i);
  try {
    const rows = await api('GET', `/api/siga/buscar?q=${encodeURIComponent(q)}`);
    const inp = inputBuscarDe(i);
    if (!inp || inp.value.trim() !== q) return; // respuesta vieja: ya se escribió otra cosa o se re-renderizó
    resultadosSiga[i] = rows;
    cont.innerHTML = rows.length ? rows.map((r, k) => {
      const donde = presDePlu(r.plu);
      const cola = donde !== null
        ? `<span class="pres-res-ya">ya está en "${escHtml(donde)}"</span>`
        : `<span class="prod-rubro">${escHtml(r.rubro)}</span>`;
      return `<div class="search-result pres-res${donde !== null ? ' ya' : ''}" ${donde !== null ? '' : `data-acc="agregar" data-i="${i}" data-k="${k}"`}>
        <span class="pres-cod-plu">${escHtml(String(r.plu))}</span>
        <span class="prod-name">${escHtml(r.producto)}</span>${cola}
      </div>`;
    }).join('') : '<div class="pres-res-msg">Sin resultados.</div>';
  } catch (e) {
    if (cont) cont.innerHTML = `<div class="pres-res-msg" style="color:var(--red-text)">Error: ${escHtml(e.message)}</div>`;
  }
}

function agregarDesdeSiga(i, k) {
  const r = (resultadosSiga[i] || [])[k];
  if (!r) return;
  const plu = Number(r.plu);
  if (!Number.isInteger(plu) || plu <= 0) { toast(`El código "${r.plu}" no es un PLU válido`, true); return; }
  const donde = presDePlu(plu);
  if (donde !== null) { toast(`El PLU ${plu} ya está en "${donde}"`, true); return; }
  const producto = String(r.producto || '');
  // Sugerencia: pack/bulto/vid suele ser mayorista (se puede destildar).
  cambiarCodigos(i, cs => [...cs, { plu, producto, esMayorista: MAYORISTA_SUGERIDO_RE.test(producto) }]);
  renderPresModal();
  inputBuscarDe(i).focus(); // para seguir agregando a la misma presentación
  toast(`✓ PLU ${plu} agregado en "${presModal[i].nombre}"`);
}

// Delegación: las tarjetas se re-renderizan enteras, los listeners quedan en el contenedor.
const _bodyGrupo = document.getElementById('editarGrupoBody');
_bodyGrupo.addEventListener('click', e => {
  const el = e.target.closest('[data-acc]');
  if (!el || el.dataset.acc === 'mayorista') return;
  const i = Number(el.dataset.i), j = Number(el.dataset.j);
  if (el.dataset.acc === 'renombrar') {
    presEditando = i;
    renderPresModal();
    const inp = document.querySelector('#editarGrupoBody .pres-renombrar');
    inp.focus(); inp.select();
  } else if (el.dataset.acc === 'borrar') borrarPresentacion(i);
  else if (el.dataset.acc === 'quitar') { cambiarCodigos(i, cs => cs.filter((_, x) => x !== j)); renderPresModal(); }
  else if (el.dataset.acc === 'agregar') agregarDesdeSiga(i, Number(el.dataset.k));
});
_bodyGrupo.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.acc !== 'mayorista') return;
  const j = Number(el.dataset.j);
  cambiarCodigos(Number(el.dataset.i), cs => cs.map((c, x) => x === j ? { ...c, esMayorista: el.checked } : c));
  renderPresModal();
});
_bodyGrupo.addEventListener('input', e => {
  const el = e.target;
  if (!el.classList.contains('pres-buscar-input')) return;
  const i = Number(el.dataset.i), q = el.value.trim(), cont = resultadosDe(i);
  clearTimeout(buscarSigaTimer);
  if (q.length < 2) { cont.innerHTML = ''; return; }
  cont.innerHTML = '<div class="pres-res-msg">Buscando…</div>';
  buscarSigaTimer = setTimeout(() => buscarEnSiga(i, q), 350);
});
_bodyGrupo.addEventListener('keydown', e => {
  const el = e.target;
  if (el.classList.contains('pres-renombrar')) {
    if (e.key === 'Enter') confirmarRenombre(Number(el.dataset.i), el.value);
    else if (e.key === 'Escape') { e.stopPropagation(); presEditando = null; renderPresModal(); }
  } else if (el.classList.contains('pres-buscar-input') && e.key === 'Escape') {
    el.value = ''; resultadosDe(Number(el.dataset.i)).innerHTML = '';
  }
});
_bodyGrupo.addEventListener('focusout', e => {
  if (e.target.classList.contains('pres-renombrar')) confirmarRenombre(Number(e.target.dataset.i), e.target.value);
});

document.getElementById('btnAgregarPresentacion').addEventListener('click', crearPresentacion);
document.getElementById('inputNuevaPres').addEventListener('keydown', e => {
  if (e.key === 'Enter') crearPresentacion();
});

async function guardarGrupo() {
  if (!editarGrupoEsNuevo && !presModalCargado) { toast('El grupo no terminó de cargar: no se guarda', true); return; }
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

  // Las presentaciones sin códigos no se guardan (en el catálogo una presentación existe por sus códigos).
  const vacias = presModal.filter(p => !p.codigos.length).map(p => p.nombre);
  const items = presModal.flatMap(p => p.codigos.map(c => ({
    plu: c.plu, producto: c.producto,
    baseNombre:   normalizarNombreJS(c.producto),
    presentacion: p.nombre,
    esMayorista:  c.esMayorista,
    refId:       editarGrupoRefId,
    productoRef: editarGrupoRef
  })));
  if (!items.length && !editarGrupoEsNuevo &&
      !confirm(`"${editarGrupoRef}" queda sin códigos y sale del catálogo. ¿Guardar igual?`)) return;

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
    toast(`✓ "${editarGrupoRef}" — ${items.length} códigos${_gPlu ? ' · Granel PLU '+_gPlu : ''}` +
      (vacias.length ? ` · sin guardar (vacías): ${vacias.join(', ')}` : ''));
    document.getElementById('overlayEditarGrupo').classList.remove('open');
    cargarCatalogo();
  } catch (e) {
    toast('Error al guardar: ' + e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = 'Guardar cambios';
  }
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
        <span title="Presentaciones">${g.presentaciones} presentaciones</span>
        <span title="Total PLUs">${g.totalPlu} PLUs</span>
        ${g.mayoristas ? `<span title="Códigos mayoristas: cuentan sus ventas de Casa Central a clientes mayoristas">${g.mayoristas} mayoristas</span>` : ''}
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
