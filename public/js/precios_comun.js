// ── Precios · helpers compartidos del front (formato, orden de tablas, fechas de precio, modal #mDet, pedidos JSON) ──
// Script clásico cargado primero en precios.html; en Node exporta lo puro para los tests.
// Sus const/let/function top-level son globales compartidas con el resto de los precios_*.js.

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const fmtMoney = n => n == null ? '—' : new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
// Precio sugerido: siempre múltiplo de 50 sin decimales (lo garantiza el backend).
const fmtPrecio = n => n == null ? '—' : new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 }).format(n);
const fmtPct = n => n == null ? '—' : (n > 0 ? '+' : '') + n.toFixed(1) + '%';

// Color del número de diferencia: sólo se resalta fuera de tolerancia.
const DELTA_CLS = { subir: 'font-semibold text-crit', bajar: 'font-semibold text-warn' };
const claseDelta = sem => DELTA_CLS[sem] || 'text-gris';

// ── Permiso de Configuración (ref precios-config) ──────────────────────────────
// GET /api/precios/config/publica dice si el usuario lo tiene (puedeConfig). Sin él (o si no se pudo saber) el server
// responde 403 a las rutas de configuración y manda los detalles sin desglose. La UI la ajusta aplicarPermisoConfig
// (precios_config.js); la seguridad es la del server.
let preciosSinConfig = false;
const permisoConfigPrecios = fetch('/api/precios/config/publica').then(r => r.json())
  .then(j => j && j.puedeConfig === true).catch(() => false);

// La decisión es temporal (spec esquema §3): al cargar /precios se borran las de ESTE usuario (las de otros quedan).
// cargarListado e iniciarProduccion la esperan antes de pedir datos, así listados y costos ya salen sin ellas.
const decisionesPropiasBorradas = fetch('/api/precios/decisiones/mias', { method: 'DELETE' }).then(r => r.json()).catch(() => null);

const normTxt = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Formato de exportación para importar en SIGA: encabezados en la fila 4 (A-D: Codigo, Nombre, Costo, Venta) y
// productos desde la fila 5 (lo arma precios_listados.js).
const HOJA_EXPORTACION = 'Precios';
const FILA_ENCABEZADOS = 4;

// ── Inputs y modal compartido #mDet ──────────────────────────────────────────
const numOrNull = v => { const s = String(v ?? '').trim(); if (s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
const chip = (txt, cls) => `<span class="px-1.5 py-0.5 rounded text-[11px] font-semibold ${cls}">${txt}</span>`;
const inputCls = 'px-2 py-1 rounded-lg border border-borde text-right tabular-nums focus:outline-none focus:border-verde focus:ring-2 focus:ring-verde/20';
// Abre el modal compartido #mDet en estado "cargando". ancho = true para tablas anchas.
let detFocoPrevio = null; // foco antes de abrir, se devuelve al cerrar
function abrirModal(titulo, ancho){
  const modal = document.getElementById('mDet');
  const caja = document.getElementById('mDetCaja');
  if (modal.classList.contains('hidden')) detFocoPrevio = document.activeElement;
  caja.classList.toggle('max-w-2xl', !ancho); caja.classList.toggle('max-w-3xl', !!ancho);
  document.getElementById('mDetTitulo').textContent = titulo;
  document.getElementById('mDetSub').textContent = '';
  document.getElementById('mDetBody').innerHTML = '<div class="py-10 text-center text-gris"><span class="spin"></span> Cargando…</div>';
  modal.classList.remove('hidden'); modal.classList.add('flex');
  caja.focus();
}
function cerrarDetalle(){
  const modal = document.getElementById('mDet');
  if (modal.classList.contains('hidden')) return;
  modal.classList.add('hidden'); modal.classList.remove('flex');
  if (detFocoPrevio && document.contains(detFocoPrevio)) detFocoPrevio.focus();
}
// Tab no se escapa del modal abierto: del último control vuelve al primero y viceversa.
function atraparFocoModal(e){
  const caja = document.getElementById('mDetCaja');
  const focos = [...caja.querySelectorAll('button, input, select, a[href]')].filter(el => !el.disabled && el.offsetParent !== null);
  if (!focos.length) return;
  const primero = focos[0], ultimo = focos[focos.length - 1], actual = document.activeElement;
  if (e.shiftKey && (actual === primero || actual === caja)) { e.preventDefault(); ultimo.focus(); }
  else if (!e.shiftKey && actual === ultimo) { e.preventDefault(); primero.focus(); }
}
if (typeof document !== 'undefined') {
  document.getElementById('mDetX').onclick = cerrarDetalle;
  document.getElementById('mDet').addEventListener('click', e => { if (e.target.id === 'mDet') cerrarDetalle(); });
}

// ── Orden de tablas ────────────────────────────────────────────────────────────
// Sólo visualización: el orden se aplica sobre lo ya filtrado/buscado y vive mientras dure la página.
// Click en un header: asc → desc → orden original (siguienteOrden). Vacíos/null siempre al final;
// números como número; texto con localeCompare('es'); estados por severidad (rango).
// Valor comparable: número (o string numérico, ej. PLU) → número; vacío → null; resto → texto.
function valorOrden(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return /^-?\d+(\.\d+)?$/.test(String(v).trim()) ? Number(v) : String(v);
}
function compararOrden(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'es', { sensitivity: 'base', numeric: true });
}
// Copia ordenada por `clave` ('asc' | 'desc' | null = orden original). Estable; nulls siempre al final.
// extraer(fila, clave) → valor de la columna (default: fila[clave]).
function ordenarFilas(filas, clave, dir, extraer = (f, c) => f[c]) {
  const conPos = (filas || []).map((f, pos) => ({ f, pos }));
  if (!clave || !dir) return conPos.map(x => x.f);
  const signo = dir === 'desc' ? -1 : 1;
  const conValor = conPos.map(x => ({ ...x, v: valorOrden(extraer(x.f, clave)) }));
  return conValor.sort((x, y) => {
    if (x.v == null || y.v == null) return (x.v == null) - (y.v == null) || x.pos - y.pos;
    return signo * compararOrden(x.v, y.v) || x.pos - y.pos;
  }).map(x => x.f);
}
// Click en un header: misma columna asc → desc → sin orden; otra columna arranca en asc.
function siguienteOrden(actual, clave) {
  if (!actual || actual.clave !== clave) return { clave, dir: 'asc' };
  return actual.dir === 'asc' ? { clave, dir: 'desc' } : null;
}

const rango = (mapa, e) => (Object.hasOwn(mapa, e) ? mapa[e] : null);
const extractorDe = cols => (f, clave) => (cols[clave] ? cols[clave](f) : f[clave]);
const ordenarCon = (filas, orden, cols) => ordenarFilas(filas, orden && orden.clave, orden && orden.dir, extractorDe(cols));

// ── Fecha de actualización del precio (último cambio real de PrecioVenta en SIGA, 'YYYY-MM-DD') ──
// Más de DIAS_PRECIO_VIEJO días sin cambio → se resalta (text-warn). Un grupo muestra la más antigua.
const DIAS_PRECIO_VIEJO = 90;
const FECHA_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function fmtFechaPrecio(iso) {
  const m = FECHA_ISO_RE.exec(String(iso ?? ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '—';
}
function esPrecioViejo(iso, hoy = new Date()) {
  const m = FECHA_ISO_RE.exec(String(iso ?? ''));
  if (!m) return false;
  const dias = (Date.UTC(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()) - Date.UTC(+m[1], m[2] - 1, +m[3])) / 86400000;
  return dias > DIAS_PRECIO_VIEJO;
}
// ISO ordena como texto: la más antigua es la menor.
function rangoFechas(fechas) {
  const fs = (fechas || []).filter(f => FECHA_ISO_RE.test(String(f ?? ''))).sort();
  return fs.length ? { min: fs[0], max: fs[fs.length - 1] } : null;
}
const fechaMasAntigua = fechas => (rangoFechas(fechas) || {}).min ?? null;

// ── Headers ordenables (<th aria-sort> con <button>, ▲/▼ en la columna activa) ────
const ariaOrden = (clave, orden) => (orden && orden.clave === clave ? (orden.dir === 'asc' ? 'ascending' : 'descending') : 'none');
function htmlBotonOrden(clave, texto, orden, cls = '') {
  const activo = orden && orden.clave === clave;
  return `<button type="button" data-orden="${esc(clave)}" class="inline-flex items-center gap-1 hover:text-verde ${activo ? 'text-verde underline underline-offset-4' : ''} ${cls}"
    title="Ordenar por ${esc(String(texto).replace(/<[^>]+>/g, '').trim())}">${texto}<span aria-hidden="true" class="text-[9px] w-2">${activo ? (orden.dir === 'asc' ? '▲' : '▼') : ''}</span></button>`;
}
// Celda "Act. precio": una fecha o, para un grupo, la más antigua de `fechas` con el rango en el tooltip.
function htmlFechaPrecio(fechas, cls = 'p-2') {
  const r = rangoFechas([].concat(fechas));
  if (!r) return `<td class="${cls} text-center text-ink/40">—</td>`;
  const tip = r.min === r.max ? `Último cambio de precio en SIGA: ${fmtFechaPrecio(r.min)}`
    : `Más antigua ${fmtFechaPrecio(r.min)} – más reciente ${fmtFechaPrecio(r.max)}`;
  const viejo = esPrecioViejo(r.min);
  return `<td class="${cls} text-center tabular-nums whitespace-nowrap${viejo ? ' text-warn' : ''}" title="${esc(tip + (viejo ? ` · más de ${DIAS_PRECIO_VIEJO} días` : ''))}">${esc(fmtFechaPrecio(r.min))}</td>`;
}
// Para tablas armadas en JS (ingredientes de recetas).
function thOrden(clave, texto, orden, der = false) {
  return `<th class="p-1.5 ${der ? 'text-right' : 'text-left'}" aria-sort="${ariaOrden(clave, orden)}">${htmlBotonOrden(clave, texto, orden, 'uppercase tracking-[.02em]')}</th>`;
}
// Para <th data-orden="clave">Texto</th> ya en el DOM: los convierte en headers ordenables (idempotente:
// guarda el texto original en data-texto). onCambio(nuevoOrden) re-pinta la tabla; el foco vuelve al header.
function montarOrden(thead, orden, onCambio) {
  if (!thead) return;
  thead.querySelectorAll('th[data-orden]').forEach(th => {
    const clave = th.dataset.orden;
    if (th.dataset.texto == null) th.dataset.texto = th.innerHTML;
    th.setAttribute('aria-sort', ariaOrden(clave, orden));
    th.innerHTML = htmlBotonOrden(clave, th.dataset.texto, orden, 'font-[inherit] text-[inherit] uppercase');
    th.querySelector('button').onclick = () => {
      onCambio(siguienteOrden(orden, clave));
      const b = thead.querySelector(`th[data-orden="${CSS.escape(clave)}"] button`);
      if (b) b.focus();
    };
  });
}

// ── Pedidos JSON (tiran con el error del server) ─────────────────────────────
const pedirJson = (method, url, body) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
  .then(r => r.json()).then(j => { if (j && j.error) throw new Error(j.error); return j; });

if (typeof module === 'object' && module.exports) {
  module.exports = { esc, fmtPrecio, fmtPct, ordenarFilas, siguienteOrden, ordenarCon, rango, fmtFechaPrecio, esPrecioViejo, rangoFechas, fechaMasAntigua, DIAS_PRECIO_VIEJO };
}
