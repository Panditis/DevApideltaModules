'use strict';

const SERVER_URL = location.protocol === 'file:'
  ? 'http://dev.local:8081'
  : '';

const HOY = new Date().toISOString().slice(0, 10);
document.getElementById('fechaHoy').textContent = formatFecha(HOY);

let sugerenciasCache = [];
let responsablesCache = [];
// Un responsable puede ser string (legado) u objeto {nombre, corto}. Mostrar SOLO el nombre.
const respNombre = r => (typeof r === 'string' ? r : (r && r.nombre) || '');
const respCorto  = r => (typeof r === 'string' ? '' : (r && (r.corto || r.abrev)) || '');
// Nombre de un ítem del carrito o del plan: "250G" solo no dice qué producto es; el nombre completo (baseNombre) ya trae la presentación.
const nombreLinea = l => l.producto || l.presentacion || '';
let planCache = null;
// ── Agenda de bloques ───────────────────────────────────────────
let plantillasTareas = [];   // data/plantillas_tareas.json
let bloquesDia       = [];   // bloques del día abierto, ya con horarios calculados
const BT = window.BloquesTareas;
let packagingCache = {}; // { plu: { envase:{codigo,nombre}|null, tapa:{codigo,nombre}|null } }
function autofillPackaging() {
  for (const it of (planCache?.items || [])) {
    const pk = packagingCache[String(it.idProducto)];
    if (!pk) continue;
    if ((it.envase == null || it.envase === '') && pk.envase) it.envase = pk.envase.codigo;
    // La tapa de la fórmula solo se autocompleta si es válida para el envase actual
    // (misma marca). Si el envase se cambió a otra marca, queda en blanco.
    if ((it.tapa === null || it.tapa === undefined || it.tapa === '') && pk.tapa) {
      const validas = tapasParaEnvase(opcionesPack(envasesReg, pk.envase), opcionesPack(tapasReg, pk.tapa), it.envase);
      if (validas.some(t => String(t.codigo) === String(pk.tapa.codigo))) it.tapa = pk.tapa.codigo;
    }
  }
}
async function prefetchPackaging() {
  const plus = [...new Set((planCache?.items || []).map(it => it.idProducto).filter(x => x != null && String(x) !== ''))].map(String);
  const faltan = plus.filter(p => !(p in packagingCache));
  if (!faltan.length) return false;
  try { const pk = await api('GET', `/api/plan/packaging?plus=${encodeURIComponent(faltan.join(','))}`); Object.assign(packagingCache, pk); return true; }
  catch { return false; }
}
function opcionesPack(registro, detectado) {
  const arr = [...(registro || [])];
  if (detectado && detectado.codigo && !arr.some(e => String(e.codigo) === String(detectado.codigo))) {
    arr.push({ codigo: detectado.codigo, nombre: (detectado.nombre || detectado.codigo) + ' · fórmula' });
  }
  return arr;
}
// ── Marcas de packaging (SILPLAST / MARPLAST) ──
// Un envase de una marca no puede combinarse con una tapa de la otra.
const _MARCAS_PACK = ['SILPLAST', 'MARPLAST'];
function marcaDe(nombre) {
  const s = String(nombre || '').toUpperCase();
  return _MARCAS_PACK.find(m => s.includes(m)) || null;
}
// Nombre de un código dentro de un set de opciones (registro + detectado en fórmula).
function nomOpc(opts, cod) {
  const c = String(cod || '');
  const h = (opts || []).find(e => String(e.codigo) === c);
  return h ? String(h.nombre || c) : c;
}
// Tapas válidas para el envase elegido: las de su misma marca; si el envase no tiene
// marca, solo tapas sin marca. Sin envase (granel) → ninguna.
function tapasParaEnvase(envOpts, tapOpts, envCod) {
  if (!envCod) return [];
  const marcaEnv = marcaDe(nomOpc(envOpts, envCod));
  return (tapOpts || []).filter(t => marcaDe(t.nombre) === marcaEnv);
}
let fechaPlanActual = null;
let semPlanBase       = lunesDeEstaFecha(HOY);
let semCalendarioBase = lunesDeEstaFecha(HOY);
let calMesActual = HOY.slice(0, 7); // YYYY-MM del mes mostrado en el calendario
let dragSrcRow = null;
let buscarDebounce = null;
let buscarProdDebounce = null;
let notasDebounce = null;
const SEM_LABEL = { GREEN: 'Bajo', YELLOW: 'Medio', RED: 'Alto', URGENT: 'Urgente' };
function semLabel(s){ return SEM_LABEL[s] || s || ''; }

// ── API ─────────────────────────────────────────────────────────
async function api(method, ruta, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(SERVER_URL + ruta, opts);
  if (!res.ok) {
    const txt = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${txt}`);
  }
  return res.json();
}

// Los errores de api() llegan como Error("<status>: <texto>"), donde <texto>
// suele ser el JSON crudo de la respuesta ({error, yaProducido, ...}). Estos
// helpers extraen el mensaje legible para mostrarlo en toasts/alerts.
function parseApiErrorBody(e) {
  const msg = e?.message || '';
  const i = msg.indexOf(':');
  const body = i === -1 ? msg : msg.slice(i + 1).trim();
  try { return JSON.parse(body); } catch { return null; }
}
function mensajeApiError(e) {
  const data = parseApiErrorBody(e);
  return (data && typeof data.error === 'string') ? data.error : (e?.message || 'Error desconocido');
}

// ── Toast ────────────────────────────────────────────────────────
function toast(msg, isErr) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = ''; }, 3200);
}

// ── Helpers fecha ────────────────────────────────────────────────
function formatFecha(iso) {
  const dias = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
  const d    = new Date(iso + 'T00:00:00');
  const [, m, dd] = iso.split('-');
  return `${dias[d.getDay()]} ${dd}/${m}`;
}
function lunesDeEstaFecha(iso) {
  const d   = new Date(iso + 'T00:00:00');
  const dow = d.getDay();
  d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
  return d.toISOString().slice(0, 10);
}
function addDias(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── SUCURSAL DE TRABAJO ──────────────────────────────────────────
// Los ids de depósito son POR SUCURSAL: el depósito 3 de una sucursal no es el
// mismo que el 3 de otra. La sucursal elegida acá viaja en todas las consultas
// de stock y en todas las operaciones de reserva.
const LS_SUCURSAL = 'apidelta.sucursal';

let sucursalesCache  = [];
let idSucursalActual = leerSucursalGuardada();

function leerSucursalGuardada() {
  try {
    const v = localStorage.getItem(LS_SUCURSAL);
    return (v == null || v === '') ? null : String(v);
  } catch (e) {
    // localStorage bloqueado (modo privado / permisos): se trabaja sin persistencia.
    return null;
  }
}

function guardarSucursal(id) {
  try {
    if (id == null || id === '') localStorage.removeItem(LS_SUCURSAL);
    else                         localStorage.setItem(LS_SUCURSAL, String(id));
  } catch (e) {
    toast('No se pudo recordar la sucursal elegida en este navegador', true);
  }
}

function sucursalActual() {
  return (idSucursalActual == null || idSucursalActual === '') ? null : String(idSucursalActual);
}

function nombreSucursal(id) {
  const s = sucursalesCache.find(x => String(x.id) === String(id));
  return s ? String(s.nombre || '') : '';
}

// "sucursal 5 Casa Central" (sin escapar: escapa quien lo inserta en el HTML)
function etiquetaSucursal(id) {
  if (id == null || id === '') return '—';
  const nom = nombreSucursal(id);
  return `sucursal ${id}${nom ? ' ' + nom : ''}`;
}

// Agrega idSucursal a una ruta GET respetando los parámetros que ya traiga.
function conSucursal(ruta) {
  const id = sucursalActual();
  if (id == null) return ruta;
  return ruta + (ruta.includes('?') ? '&' : '?') + 'idSucursal=' + encodeURIComponent(id);
}

// Ídem para los POST: la sucursal viaja en el cuerpo.
function bodyConSucursal(body) {
  const id = sucursalActual();
  return id == null ? { ...(body || {}) } : { ...(body || {}), idSucursal: id };
}

function renderSelectSucursal() {
  const sel = document.getElementById('selSucursal');
  if (!sel) return;

  // Sin lista (la consulta falló): se muestra la última sucursal conocida, que es
  // la que se sigue mandando en las llamadas, para no perder el contexto de trabajo.
  if (!sucursalesCache.length) {
    const id = sucursalActual();
    sel.innerHTML = id == null
      ? '<option value="">— Sucursal del servidor —</option>'
      : `<option value="${escHtml(id)}">${escHtml(id)} — (sin nombre)</option>`;
    sel.value    = id ?? '';
    sel.disabled = true;
    sel.title    = 'No se pudo cargar la lista de sucursales: no se puede cambiar de sucursal';
    return;
  }

  sel.disabled  = false;
  sel.innerHTML = sucursalesCache.map(s => {
    const suf = s.central === true ? ' ★ (central)' : '';
    return `<option value="${escHtml(String(s.id))}">${escHtml(String(s.id))} — ${escHtml(s.nombre || '')}${suf}</option>`;
  }).join('');
  sel.value = sucursalActual() ?? '';
  sel.title = `Trabajando en ${etiquetaSucursal(sucursalActual())} · desde acá se consultan los depósitos y se reserva la mercadería`;
}

async function cargarSucursales() {
  let data;
  try {
    data = await api('GET', '/api/sucursales');
  } catch (e) {
    sucursalesCache = [];
    renderSelectSucursal();
    toast('Error al cargar las sucursales: ' + e.message, true);
    return;
  }

  sucursalesCache = (Array.isArray(data) ? data : []).filter(s => s && s.id != null);

  const guardada = sucursalActual();
  const existe   = guardada != null && sucursalesCache.some(s => String(s.id) === guardada);
  if (!existe) {
    const porDefecto = sucursalesCache.find(s => s.central === true) || sucursalesCache[0] || null;
    idSucursalActual = porDefecto ? String(porDefecto.id) : null;
    guardarSucursal(idSucursalActual);
    if (guardada != null && idSucursalActual != null) {
      toast(`La sucursal ${guardada} ya no está disponible: se cambió a ${etiquetaSucursal(idSucursalActual)}`, true);
    }
  }

  renderSelectSucursal();
}

// Cambiar de sucursal invalida los depósitos elegidos y el stock consultado:
// se vuelve a pedir todo lo que dependa de la sucursal.
async function onCambioSucursal() {
  const sel = document.getElementById('selSucursal');
  if (!sel) return;

  const nuevo = sel.value === '' ? null : String(sel.value);
  if (nuevo === sucursalActual()) return;

  idSucursalActual = nuevo;
  guardarSucursal(nuevo);
  renderSelectSucursal();
  toast(`Trabajando en ${etiquetaSucursal(nuevo)}`);

  const modalReserva = document.getElementById('overlayReserva');
  if (modalReserva && modalReserva.classList.contains('open')) {
    try { await recargarModalReservaPorSucursal(); }
    catch (e) { toast('Error al recargar la reserva: ' + e.message, true); }
  } else {
    try { await refrescarEstadoReserva(true); }
    catch (e) { toast('Error al refrescar la reserva: ' + e.message, true); }
  }

  const modalMov = document.getElementById('overlayMovStock');
  if (modalMov && modalMov.classList.contains('open')) {
    try { await cargarMovStock(); }
    catch (e) { toast('Error al recargar los movimientos: ' + e.message, true); }
  }
}

document.getElementById('selSucursal').addEventListener('change', () => {
  onCambioSucursal().catch(e => toast('Error al cambiar de sucursal: ' + e.message, true));
});

cargarSucursales().catch(e => toast('Error al cargar las sucursales: ' + e.message, true));

// ── Tabs ─────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'tablero' && !tablero) cargarTablero(); // ya cargado: se refresca con Recargar
    if (btn.dataset.tab === 'plan')       { cargarEnvasesReg(); cargarClientesReg(); cargarTapasReg(); seleccionarDia(fechaPlanActual || HOY); }
    if (btn.dataset.tab === 'agenda')     cargarAgenda();
    if (btn.dataset.tab === 'calendario') cargarCalendario(calMesActual + '-01');
    if (btn.dataset.tab === 'catalogo')   cargarCatalogo();
    if (btn.dataset.tab === 'envases')    cargarEnvasesReg();
    if (btn.dataset.tab === 'tapas')      cargarTapasReg();
    if (btn.dataset.tab === 'clientes')   cargarClientesReg();
  });
});

// ── Conexión ─────────────────────────────────────────────────────
async function checkConnection() {
  try {
    await api('GET', '/api/health');
    document.getElementById('statusDot').className = 'status-dot ok';
  } catch {
    document.getElementById('statusDot').className = 'status-dot err';
  }
}
