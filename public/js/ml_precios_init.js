// ── Control de precios ML · arranque: pestañas con hash y carga inicial ──
const PESTANAS = {
  control: { iniciar: () => {} },
  vinculos: { iniciar: cargarVinculos }, // se recarga cada vez: Control puede haber cambiado vínculos
  costos: { iniciar: () => {} },
};

function activarPestana(id) {
  if (!PESTANAS[id]) id = 'control';
  document.querySelectorAll('#tabs .navtab').forEach(b => {
    const on = b.dataset.tab === id;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `panel-${id}`));
  PESTANAS[id].iniciar();
}

// Flechas izquierda/derecha entre pestañas (patrón tablist).
$('tabs').addEventListener('keydown', e => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const botones = [...document.querySelectorAll('#tabs .navtab')];
  const i = botones.indexOf(document.activeElement);
  if (i < 0) return;
  const sig = botones[(i + (e.key === 'ArrowRight' ? 1 : -1) + botones.length) % botones.length];
  sig.focus();
  location.hash = sig.dataset.tab;
});
document.querySelectorAll('#tabs .navtab').forEach(b => b.addEventListener('click', () => { location.hash = b.dataset.tab; }));
window.addEventListener('hashchange', () => activarPestana(location.hash.slice(1)));

activarPestana(location.hash.slice(1));
// Config y Control cargan juntos: el resumen y el desglose necesitan la config (tolerancia, costos).
Promise.all([cargarControl(), cargarConfig()]).then(() => { if (datos) renderControl(); if (vinculos) renderVinculos(); });
