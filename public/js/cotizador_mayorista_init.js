'use strict';
// ── Cotizador mayorista · arranque: pestañas (navegación por hash) y carga perezosa de cada una ──

const PESTANAS = {
  exportar: { iniciar: iniciarExportar },
  productos: { iniciar: () => { iniciarTabla(); return cargarTabla(); } },
  historial: { iniciar: () => { iniciarHistorial(); return cargarHistorial(); } },
  comparacion: { iniciar: () => { iniciarComparacion(); return cargarComparacion(); } },
};
const iniciadas = new Set();

function activarPestana(id) {
  if (!PESTANAS[id]) id = 'exportar';
  document.querySelectorAll('#tabs .navtab').forEach(b => {
    const on = b.dataset.tab === id;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `panel-${id}`));
  if (!iniciadas.has(id)) { iniciadas.add(id); PESTANAS[id].iniciar(); }
}

// Flechas izquierda/derecha entre pestañas (patrón tablist).
function teclaPestanas(e) {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const botones = [...document.querySelectorAll('#tabs .navtab')];
  const i = botones.findIndex(b => b === document.activeElement);
  if (i < 0) return;
  const sig = botones[(i + (e.key === 'ArrowRight' ? 1 : -1) + botones.length) % botones.length];
  sig.focus();
  location.hash = sig.dataset.tab;
}

document.querySelectorAll('#tabs .navtab').forEach(b => b.addEventListener('click', () => { location.hash = b.dataset.tab; }));
$('tabs').addEventListener('keydown', teclaPestanas);
window.addEventListener('hashchange', () => activarPestana(location.hash.slice(1)));
activarPestana(location.hash.slice(1));
