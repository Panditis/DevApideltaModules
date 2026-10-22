'use strict';
// ── Planificación como centro de producción (spec 2026-10-22-planificacion-centro §1.3) ──
// Se corre A MANO, una vez por instalación (dev y prod):
//   node scripts/migrar_planificacion_centro.js [ruta/a/data]
// Completa tipo/estado/motivo/clienteId/responsables/proximaFecha en grupos_config.json y crea
// graneles_base.json con los granelPlu(s) de los grupos tipo granel (lib/plan_catalogo_meta
// migrarPlanificacionCentro). Idempotente. Backup <archivo>.bak-planificacion-centro antes de
// escribir (si ya existe no se pisa: es el original). Escritura atómica (tmp + rename).
const fs = require('fs');
const path = require('path');
const { migrarPlanificacionCentro } = require('../lib/plan_catalogo_meta');

function escribir(ruta, data) {
  if (fs.existsSync(ruta)) {
    const bak = `${ruta}.bak-planificacion-centro`;
    if (!fs.existsSync(bak)) fs.copyFileSync(ruta, bak);
  }
  const tmp = `${ruta}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, ruta);
}

function main(dataDir = path.join(__dirname, '..', 'data')) {
  const cfgPath = path.join(dataDir, 'grupos_config.json');
  const granelesPath = path.join(dataDir, 'graneles_base.json');
  if (!fs.existsSync(cfgPath)) throw new Error(`no existe ${cfgPath}`);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); // roto → tira antes de tocar nada
  const graneles = fs.existsSync(granelesPath) ? JSON.parse(fs.readFileSync(granelesPath, 'utf8')) : {};
  const r = migrarPlanificacionCentro(cfg, graneles);
  if (!r.cambios) return 'ya migrado: sin cambios';
  escribir(cfgPath, r.gruposCfg);
  escribir(granelesPath, r.granelesBase);
  return `migrado: ${r.cambios} cambios (${Object.keys(r.granelesBase).length} graneles base)`;
}

if (require.main === module) {
  try {
    console.log(main(process.argv[2]));
  } catch (err) {
    console.error('[migrar_planificacion_centro]', err.message);
    process.exitCode = 1;
  }
}

module.exports = { main };
