'use strict';
// ── Init ─────────────────────────────────────────────────────────
(async () => {
  await checkConnection();
  try { responsablesCache = await api('GET', '/api/responsables'); } catch {}
  cargarSugerencias();
})();
