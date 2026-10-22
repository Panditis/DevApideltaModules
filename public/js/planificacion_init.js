'use strict';
// ── Init ─────────────────────────────────────────────────────────
(async () => {
  await checkConnection();
  try { responsablesCache = await api('GET', '/api/responsables'); } catch {}
  // init.js carga antes que planificacion_tablero.js: esperar a que corran todos los scripts de la página.
  if (document.readyState === 'loading') await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));
  cargarTablero();
})();
