// ── Control de precios ML · núcleo: helpers, API, aviso, preferencias y estado compartido ──
const $ = id => document.getElementById(id);
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtMoney = n => '$' + Number(n).toLocaleString('es-AR', { maximumFractionDigits: 0 });
const fmtMoney2 = n => '$' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = n => Math.round(Number(n) || 0).toLocaleString('es-AR');
const fmtPct = n => Number(n).toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 2 }) + ' %';
const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
const parseNum = s => Number(String(s).trim().replace(',', '.'));
const signo = n => (n > 0 ? '+' : n < 0 ? '-' : '');
const fmtDif = n => `${signo(n)}${fmtMoney(Math.abs(n))}`;

const ENVIO = { gratis: 'Envío gratis', comprador: 'Envío a cargo del comprador', sin: 'Sin envío', nd: '' };

// Estado compartido entre archivos (cada uno lo llena y lo lee).
let datos = null; // GET /control
let config = null; // GET /config
let vinculos = null; // GET /vinculos

// ── Preferencias (filtros que se recuerdan) ──────────────────────────────────
const PREF_KEY = 'mlPrecios.prefs';
const PREF_DEFAULT = { grupo: 'pend', activa: 'activas', orden: null, dir: 'desc' };
function leerPrefs() {
  try { return { ...PREF_DEFAULT, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') }; } catch (_e) { return { ...PREF_DEFAULT }; }
}
function guardarPrefs(parcial) {
  const nuevas = { ...leerPrefs(), ...parcial };
  try { localStorage.setItem(PREF_KEY, JSON.stringify(nuevas)); } catch (_e) { /* sin storage: no pasa nada */ }
  return nuevas;
}

// ── Aviso flotante ───────────────────────────────────────────────────────────
let avisoTimer = null;
// avisar(texto) = ok que se va solo; avisar(texto, 'error') queda hasta cerrarlo; accion = { texto, fn } (ej. Deshacer).
function avisar(texto, tipo, accion) {
  const el = $('aviso');
  clearTimeout(avisoTimer);
  if (!texto) { el.hidden = true; el.textContent = ''; return; }
  const error = tipo === 'error';
  el.className = error ? 'error' : 'fade-in';
  el.setAttribute('role', error ? 'alert' : 'status');
  el.innerHTML = `<span>${escHtml(texto)}</span>`
    + (accion ? '<button type="button" data-a="accion"></button>' : '')
    + (error ? '<button type="button" data-a="cerrar" aria-label="Cerrar aviso">Cerrar</button>' : '');
  if (accion) el.querySelector('[data-a="accion"]').textContent = accion.texto;
  el.hidden = false;
  el.onclick = e => {
    const a = e.target.dataset && e.target.dataset.a;
    if (a === 'accion') { avisar(''); accion.fn(); } else if (a === 'cerrar') avisar('');
  };
  if (!error) avisoTimer = setTimeout(() => avisar(''), accion ? 10000 : 6000);
}

async function api(url, opts) {
  let r;
  try { r = await fetch(url, opts); } catch (_e) { throw new Error('No se pudo conectar con el servidor.'); }
  if (r.status === 401) throw new Error('La sesión venció. Recargá la página e iniciá sesión de nuevo.');
  if (r.status === 403) throw new Error('No tenés acceso a este módulo.');
  let cuerpo = null;
  try { cuerpo = await r.json(); } catch (_e) { /* sin JSON */ }
  if (!r.ok) throw new Error((cuerpo && cuerpo.error) || `Error ${r.status} del servidor.`);
  return cuerpo;
}

// Copia al portapapeles; con fallback para páginas sin contexto seguro (http en la red local).
async function copiarTexto(texto) {
  try { await navigator.clipboard.writeText(texto); return true; } catch (_e) { /* fallback */ }
  const t = document.createElement('textarea');
  t.value = texto; t.style.position = 'fixed'; t.style.opacity = '0';
  document.body.appendChild(t); t.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (_e) { ok = false; }
  t.remove();
  return ok;
}
