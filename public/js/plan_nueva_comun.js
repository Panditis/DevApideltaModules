'use strict';
// Planificación nueva — helpers compartidos del front (spec docs/superpowers/specs/2026-10-22-planificacion-nueva-design.md).
// Script clásico: lo de nivel superior queda global para los demás plan_nueva_*.js. Las funciones puras se
// exportan al final para test/plan_nueva_front.test.js; las que tocan el DOM sólo se llaman en el navegador.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// ponytail: mismo normalizar que lib/plan_nueva.js; una línea no justifica servir la lib al navegador.
const normalizarTexto = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const fmtNum = n => (n === null || n === undefined ? '—' : Number(n).toLocaleString('es-AR', { maximumFractionDigits: 2 }));

// Nombre de la categoría (distinta de idPropio) que ya tiene el PLU, o null.
function duenioPlu(categorias, plu, idPropio = null) {
  const c = (categorias || []).find(x => x.id !== idPropio && x.plus.includes(String(plu)));
  return c ? c.nombre : null;
}

// Fecha local AAAA-MM-DD (toISOString sola da la de UTC: a la noche ya sería mañana).
function hoyISO(d = new Date()) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

// Tablero filtrado por texto sin acentos: una categoría que coincide entra entera; si no, sólo sus
// presentaciones que coinciden por nombre o PLU. Las que quedan vacías (y no coinciden por nombre) se van.
function filtrarTablero(categorias, q) {
  const t = normalizarTexto(q);
  if (!t) return categorias;
  return categorias
    .map(c => (normalizarTexto(c.nombre).includes(t) ? c : {
      ...c,
      presentaciones: c.presentaciones.filter(p => normalizarTexto(p.nombre).includes(t) || String(p.plu).startsWith(t)),
    }))
    .filter(c => c.presentaciones.length || normalizarTexto(c.nombre).includes(t));
}

// ── Carrito: { fecha, notas, lineas: [{ plu, nombre, categoria, cantidad, responsables, notas }] } ──
const CLAVE_CARRITO = 'planNueva.carrito.v1';
const carritoVacio = fecha => ({ fecha, notas: '', lineas: [] });
const enCarrito = (carrito, plu) => carrito.lineas.some(l => l.plu === String(plu));

// Agrega una fila del tablero; la cantidad arranca en el sugerido (o 1 si es 0). Si ya está, devuelve el mismo.
function agregarAlCarrito(carrito, fila, categoria) {
  if (enCarrito(carrito, fila.plu)) return carrito;
  const linea = { plu: String(fila.plu), nombre: fila.nombre, categoria, cantidad: fila.sugerido > 0 ? fila.sugerido : 1, responsables: [], notas: '' };
  return { ...carrito, lineas: [...carrito.lineas, linea] };
}
const editarLinea = (carrito, plu, cambios) => ({ ...carrito, lineas: carrito.lineas.map(l => (l.plu === String(plu) ? { ...l, ...cambios } : l)) });
const quitarDelCarrito = (carrito, plu) => ({ ...carrito, lineas: carrito.lineas.filter(l => l.plu !== String(plu)) });
const payloadOrden = carrito => ({
  fecha: carrito.fecha,
  notas: carrito.notas,
  lineas: carrito.lineas.map(({ plu, nombre, cantidad, responsables, notas }) => ({ plu, nombre, cantidad, responsables, notas })),
});

// Carrito guardado, o uno vacío con fecha `hoy` si no hay, está roto o el storage no responde.
function leerCarrito(storage, hoy) {
  try {
    const c = JSON.parse(storage.getItem(CLAVE_CARRITO));
    const lineasOk = c && Array.isArray(c.lineas) && c.lineas.every(l => l && typeof l.plu === 'string' && Array.isArray(l.responsables));
    if (lineasOk && typeof c.fecha === 'string' && typeof c.notas === 'string') return c;
  } catch { /* storage bloqueado o JSON roto: se arranca vacío */ }
  return carritoVacio(hoy);
}
function guardarCarrito(storage, carrito) {
  try { storage.setItem(CLAVE_CARRITO, JSON.stringify(carrito)); }
  catch (e) { console.warn('[plan-nueva] no se pudo guardar el carrito:', e.message); }
}

async function api(metodo, url, body) {
  const r = await fetch(url, {
    method: metodo,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
  return data;
}

const TOAST_MS = 3500;
let toastTimer = null;
function toast(mensaje, tipo = 'ok') {
  const el = document.getElementById('toast');
  el.textContent = mensaje;
  el.className = `fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg shadow-fluent text-sm text-white ${tipo === 'error' ? 'bg-crit' : 'bg-verde'}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), TOAST_MS);
}

// Tabs: cada plan_nueva_*.js registra TABS.<nombre> = { cargar: async () => … }; se recarga al mostrarla.
const TABS = {};
function mostrarTab(nombre) {
  const tab = document.getElementById('tab-' + nombre) ? nombre : 'planificacion';
  document.querySelectorAll('[data-tab]').forEach(b => {
    b.classList.toggle('on', b.dataset.tab === tab);
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  });
  document.querySelectorAll('.tab-panel').forEach(s => s.classList.toggle('hidden', s.id !== 'tab-' + tab));
  history.replaceState(null, '', '#' + tab);
  if (TABS[tab]) TABS[tab].cargar().catch(e => toast(e.message, 'error'));
}

if (typeof module !== 'undefined') {
  module.exports = {
    esc, normalizarTexto, fmtNum, duenioPlu, hoyISO, filtrarTablero,
    carritoVacio, enCarrito, agregarAlCarrito, editarLinea, quitarDelCarrito, payloadOrden, leerCarrito, guardarCarrito,
  };
}
