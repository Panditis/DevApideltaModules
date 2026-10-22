'use strict';
// ── Modal responsables ────────────────────────────────────────────
// ── Tab Envases (registro persistente con autocompletar Siga) ────
let envasesReg = [];
async function cargarEnvasesReg() {
  try { envasesReg = await api('GET', '/api/envases-registro') || []; }
  catch { envasesReg = []; }
  const cont = document.getElementById('tablaEnvasesReg');
  if (!cont) return;
  if (!envasesReg.length) {
    cont.innerHTML = '<div class="loading">Sin envases cargados. Ingresá un código de sistema arriba.</div>';
    return;
  }
  cont.innerHTML = `<div style="overflow-x:auto"><table>
    <thead><tr><th style="width:120px">Código</th><th>Nombre</th><th style="width:110px">Stock</th><th style="width:50px"></th></tr></thead>
    <tbody>${envasesReg.map(e => `<tr>
      <td style="font-family:system-ui,sans-serif;font-weight:700">${escHtml(String(e.codigo))}</td>
      <td>${escHtml(e.nombre || '')}</td>
      <td style="font-weight:700;color:${(e.stock || 0) <= 0 ? 'var(--red-text)' : 'var(--grn-text)'}">${e.stock ?? 0}</td>
      <td><button class="btn btn-danger btn-sm" onclick="eliminarEnvaseReg('${String(e.codigo).replace(/'/g, "\\'")}')">✕</button></td>
    </tr>`).join('')}</tbody></table></div>`;
}
let envLookupDebounce = null;
function _envLookup() {
  const cod = document.getElementById('envCodigo').value.trim();
  const nom = document.getElementById('envNombre');
  const stk = document.getElementById('envStock');
  const btn = document.getElementById('btnEnvAgregar');
  const msg = document.getElementById('envMsg');
  if (!cod) { nom.value = ''; stk.textContent = 'Stock: —'; btn.disabled = true; msg.textContent = ''; return; }
  clearTimeout(envLookupDebounce);
  envLookupDebounce = setTimeout(async () => {
    try {
      const e = await api('GET', `/api/envase-lookup?codigo=${encodeURIComponent(cod)}`);
      if (e && !e.error) { nom.value = e.nombre; stk.textContent = 'Stock: ' + e.stock; btn.disabled = false; msg.textContent = ''; }
      else { nom.value = ''; stk.textContent = 'Stock: —'; btn.disabled = true; msg.textContent = 'Producto no encontrado'; }
    } catch { btn.disabled = true; }
  }, 350);
}
async function agregarEnvaseReg() {
  const cod = document.getElementById('envCodigo').value.trim();
  if (!cod) return;
  try {
    const r = await api('POST', '/api/envases-registro', { codigo: cod });
    if (r.error) { toast(r.error, true); return; }
    document.getElementById('envCodigo').value = '';
    document.getElementById('envNombre').value = '';
    document.getElementById('envStock').textContent = 'Stock: —';
    document.getElementById('btnEnvAgregar').disabled = true;
    await cargarEnvasesReg();
    if (typeof renderPlan === 'function' && planCache) renderPlan();
    toast(`Envase "${r.envase?.nombre || cod}" agregado`);
  } catch (e) { toast('Error: ' + e.message, true); }
}
async function eliminarEnvaseReg(cod) {
  try { await api('DELETE', '/api/envases-registro/' + encodeURIComponent(cod)); }
  catch (e) { toast('Error al eliminar', true); }
  await cargarEnvasesReg();
  if (typeof renderPlan === 'function' && planCache) renderPlan();
}
document.getElementById('envCodigo')?.addEventListener('input', _envLookup);
document.getElementById('envCodigo')?.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !document.getElementById('btnEnvAgregar').disabled) agregarEnvaseReg();
});
document.getElementById('btnEnvAgregar')?.addEventListener('click', agregarEnvaseReg);
document.getElementById('btnEnvRefrescar')?.addEventListener('click', async () => {
  try { const r = await api('POST', '/api/envases-registro/refrescar', {}); envasesReg = r.envases || []; await cargarEnvasesReg(); toast('Stock actualizado'); }
  catch (e) { toast('Error al refrescar', true); }
});
cargarEnvasesReg();

// ── Tab Tapas (registro persistente con autocompletar Siga) ────
let tapasReg = [];
async function cargarTapasReg() {
  try { tapasReg = await api('GET', '/api/tapas-registro') || []; }
  catch { tapasReg = []; }
  const cont = document.getElementById('tablaTapasReg');
  if (!cont) return;
  if (!tapasReg.length) {
    cont.innerHTML = '<div class="loading">Sin tapas cargadas. Ingresá un código de sistema arriba.</div>';
    return;
  }
  cont.innerHTML = `<div style="overflow-x:auto"><table>
    <thead><tr><th style="width:120px">Código</th><th>Nombre</th><th style="width:110px">Stock</th><th style="width:50px"></th></tr></thead>
    <tbody>${tapasReg.map(e => `<tr>
      <td style="font-family:system-ui,sans-serif;font-weight:700">${escHtml(String(e.codigo))}</td>
      <td>${escHtml(e.nombre || '')}</td>
      <td style="font-weight:700;color:${(e.stock || 0) <= 0 ? 'var(--red-text)' : 'var(--grn-text)'}">${e.stock ?? 0}</td>
      <td><button class="btn btn-danger btn-sm" onclick="eliminarTapaReg('${String(e.codigo).replace(/'/g, "\\'")}')">✕</button></td>
    </tr>`).join('')}</tbody></table></div>`;
}
let tapLookupDebounce = null;
function _tapLookup() {
  const cod = document.getElementById('tapCodigo').value.trim();
  const nom = document.getElementById('tapNombre');
  const stk = document.getElementById('tapStock');
  const btn = document.getElementById('btnTapAgregar');
  const msg = document.getElementById('tapMsg');
  if (!cod) { nom.value = ''; stk.textContent = 'Stock: —'; btn.disabled = true; msg.textContent = ''; return; }
  clearTimeout(tapLookupDebounce);
  tapLookupDebounce = setTimeout(async () => {
    try {
      const e = await api('GET', `/api/tapa-lookup?codigo=${encodeURIComponent(cod)}`);
      if (e && !e.error) { nom.value = e.nombre; stk.textContent = 'Stock: ' + e.stock; btn.disabled = false; msg.textContent = ''; }
      else { nom.value = ''; stk.textContent = 'Stock: —'; btn.disabled = true; msg.textContent = 'Producto no encontrado'; }
    } catch { btn.disabled = true; }
  }, 350);
}
async function agregarTapaReg() {
  const cod = document.getElementById('tapCodigo').value.trim();
  if (!cod) return;
  try {
    const r = await api('POST', '/api/tapas-registro', { codigo: cod });
    if (r.error) { toast(r.error, true); return; }
    document.getElementById('tapCodigo').value = '';
    document.getElementById('tapNombre').value = '';
    document.getElementById('tapStock').textContent = 'Stock: —';
    document.getElementById('btnTapAgregar').disabled = true;
    await cargarTapasReg();
    if (typeof renderPlan === 'function' && planCache) renderPlan();
    toast(`Tapa "${r.tapa?.nombre || cod}" agregada`);
  } catch (e) { toast('Error: ' + e.message, true); }
}
async function eliminarTapaReg(cod) {
  try { await api('DELETE', '/api/tapas-registro/' + encodeURIComponent(cod)); }
  catch (e) { toast('Error al eliminar', true); }
  await cargarTapasReg();
  if (typeof renderPlan === 'function' && planCache) renderPlan();
}
document.getElementById('tapCodigo')?.addEventListener('input', _tapLookup);
document.getElementById('tapCodigo')?.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !document.getElementById('btnTapAgregar').disabled) agregarTapaReg();
});
document.getElementById('btnTapAgregar')?.addEventListener('click', agregarTapaReg);
document.getElementById('btnTapRefrescar')?.addEventListener('click', async () => {
  try { const r = await api('POST', '/api/tapas-registro/refrescar', {}); tapasReg = r.tapas || []; await cargarTapasReg(); toast('Stock actualizado'); }
  catch (e) { toast('Error al refrescar', true); }
});
cargarTapasReg();

// ── Tab Clientes ───────────────────────────────────────────────────
let clientesReg = [];
async function cargarClientesReg() {
  try { clientesReg = await api('GET', '/api/clientes-registro') || []; }
  catch { clientesReg = []; }
  const cont = document.getElementById('tablaClientes');
  if (!cont) return;
  if (!clientesReg.length) {
    cont.innerHTML = '<div class="loading">Sin clientes. Ingresá un nombre arriba.</div>';
    return;
  }
  cont.innerHTML = `<div style="overflow-x:auto"><table>
    <thead><tr><th>Nombre</th><th style="width:130px"></th></tr></thead>
    <tbody>${clientesReg.map(c => `<tr>
      <td>${escHtml(c.nombre)}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-danger btn-sm" onclick="borrarCliente(${c.id})">✕</button>
      </td>
    </tr>`).join('')}</tbody></table></div>`;
}
async function borrarCliente(id) {
  const c = clientesReg.find(x => x.id === id);
  confirmarModal('Eliminar cliente', `¿Eliminar <strong>${escHtml(c?.nombre || '')}</strong>?`, 'Eliminar', async () => {
    try {
      await api('DELETE', `/api/clientes-registro/${id}`);
      await cargarClientesReg();
      if (typeof renderPlan === 'function' && planCache) renderPlan();
      toast('Cliente eliminado');
    } catch (e) { toast('Error: ' + e.message, true); }
  }, true);
}
document.getElementById('cliNombre')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btnCliAgregar')?.click();
});
document.getElementById('btnCliAgregar')?.addEventListener('click', async () => {
  const nombre = document.getElementById('cliNombre').value.trim();
  if (!nombre) return;
  try {
    const r = await api('POST', '/api/clientes-registro', { nombre });
    if (r.error) { toast(r.error, true); return; }
    document.getElementById('cliNombre').value = '';
    await cargarClientesReg();
    if (typeof renderPlan === 'function' && planCache) renderPlan();
    toast(`Cliente "${nombre}" agregado`);
  } catch (e) { toast('Error: ' + e.message, true); }
});
cargarClientesReg();

// ── Catálogo de grupos para el carrito ───────────────────────────
async function cargarGruposCfgSiVacio() {
  if (Object.keys(gruposCfgLocal).length) return;
  try {
    const grupos = await api('GET', '/api/catalogo/grupos');
    gruposCfgLocal = cfgLocalDesdeGrupos(grupos);
  } catch (e) { /* silencioso: sin catálogo, cfgGet* devuelve los valores por defecto */ }
}

document.getElementById('btnGestionResp').addEventListener('click', () => {
  document.getElementById('overlayResp').classList.add('open');
  renderListaResp();
});
document.getElementById('cerrarResp').addEventListener('click', () =>
  document.getElementById('overlayResp').classList.remove('open'));
document.getElementById('overlayResp').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
});

function renderListaResp() {
  const html = responsablesCache.map((r, i) => {
    const c = respCorto(r);
    return `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
      <span style="flex:1;font-size:14px">${escHtml(respNombre(r))}${c ? ` <span style="color:var(--muted);font-size:12px">(${escHtml(c)})</span>` : ''}</span>
      <button class="btn btn-danger btn-sm" onclick="eliminarResp(${i})">✕</button>
    </div>`;
  }).join('') || '<div style="color:var(--muted);font-size:13px;padding:8px 0">Sin responsables cargados.</div>';
  document.getElementById('listaResp').innerHTML = html;
}

async function eliminarResp(i) {
  responsablesCache.splice(i, 1);
  await api('POST', '/api/responsables', responsablesCache).catch(()=>{});
  renderListaResp();
  renderPlan();
}

document.getElementById('btnAgregarResp').addEventListener('click', async () => {
  const input  = document.getElementById('nuevoResp');
  const inputC = document.getElementById('nuevoRespCorto');
  const nombre = input.value.trim();
  const corto  = inputC.value.trim();
  if (!nombre) return;
  responsablesCache.push(corto ? { nombre, corto } : { nombre });
  input.value = '';
  inputC.value = '';
  await api('POST', '/api/responsables', responsablesCache).catch(()=>{});
  renderListaResp();
  renderPlan();
  toast(`Responsable "${nombre}"${corto ? ` (${corto})` : ''} agregado`);
});

['nuevoResp', 'nuevoRespCorto'].forEach(id =>
  document.getElementById(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btnAgregarResp').click();
  }));

// ══════════════════ TAB 3: CALENDARIO ═══════════════════════════

const MESES_NOM = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

// Recibe cualquier fecha del mes a mostrar; arma una grilla mensual (filas = semanas,
// columnas = Lun-Vie). Empieza el lunes de la semana del día 1 y pide 6 semanas (42 días).
async function cargarCalendario(fechaEnMes) {
  semCalendarioBase = fechaEnMes;
  calMesActual = fechaEnMes.slice(0, 7);
  const primero = `${calMesActual}-01`;
  const desde = lunesDeEstaFecha(primero);
  const [yy, mm] = calMesActual.split('-');
  document.getElementById('tituloSemana').textContent = `${MESES_NOM[+mm - 1]} ${yy}`;
  document.getElementById('calGrid').innerHTML = '<div class="loading">Cargando…</div>';
  try {
    const cal = await api('GET', `/api/calendario?desde=${desde}&dias=42`);
    renderCalendario(cal);
  } catch (e) {
    document.getElementById('calGrid').innerHTML =
      `<div class="loading" style="color:red">Error: ${escHtml(e.message)}</div>`;
  }
}

function renderCalendario(cal) {
  const DOW = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
  const html = Object.entries(cal).map(([fecha, data]) => {
    const dow = new Date(fecha + 'T00:00:00').getDay();
    const [,, dd] = fecha.split('-');
    const esHoy = fecha === HOY;
    const fuera = fecha.slice(0, 7) !== calMesActual;
    const items5 = data.items.slice(0, 5);
    const chips = data.totalItems > 0
      ? items5.map(it => `<div class="day-item-chip ${it.semaforo||''}">${escHtml(it.producto)}</div>`).join('')
        + (data.totalItems > 5 ? `<div class="day-item-chip">+${data.totalItems-5} más</div>` : '')
      : '<div class="day-item-chip empty">Sin plan</div>';

    return `<div class="day-card${esHoy?' today':''}${fuera?' fuera-mes':''}" onclick="irAlDia('${fecha}')">
      <div class="day-head">
        <span>${DOW[dow]}</span>
        <span class="day-num">${dd}</span>
        ${data.tieneRiesgoGranel ? '<span title="Riesgo MP" style="color:var(--red-text)">⚠</span>' : ''}
      </div>
      <div class="day-stats">${data.totalItems} ítems · ${data.totalUnidades} u.</div>
      <div class="day-items">${chips}</div>
    </div>`;
  }).join('');
  document.getElementById('calGrid').innerHTML = html;
}

function irAlDia(fecha) {
  semPlanBase = lunesDeEstaFecha(fecha);
  fechaPlanActual = fecha;
  document.querySelector('[data-tab=plan]').click();
}

function calMesOffset(n) {
  const [y, m] = calMesActual.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
document.getElementById('btnSemAnt').addEventListener('click', () =>
  cargarCalendario(calMesOffset(-1)));
document.getElementById('btnSemSig').addEventListener('click', () =>
  cargarCalendario(calMesOffset(1)));
