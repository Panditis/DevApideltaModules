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

if (typeof module !== 'undefined') module.exports = { esc, normalizarTexto, fmtNum, duenioPlu };
