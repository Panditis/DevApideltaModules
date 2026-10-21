'use strict';
// ── Configuración propia de Fraccionado en data/costeo.json (spec 2026-10-21-precios-fraccionado-costeo-design §2.2) ──
// Se corre A MANO, una vez por instalación (dev y prod), después de migrar_esquema_canales.js:
//   node scripts/migrar_config_fraccionado.js [ruta/a/costeo.json]
// Crea costeo.fraccionado copiando la configuración de la raíz (Reventa) (lib/precios_config_esquema
// migrarConfigFraccionado). Idempotente. Backup <ruta>.bak-config-fraccionado antes de escribir; si ya existe no se pisa
// (es el original). Escritura atómica (tmp + rename). Conviene correrlo sin nadie editando la configuración.
const fs = require('fs');
const path = require('path');
const { migrarConfigFraccionado } = require('../lib/precios_config_esquema');

function main(ruta = path.join(__dirname, '..', 'data', 'costeo.json')) {
  if (!fs.existsSync(ruta)) throw new Error(`no existe ${ruta}`);
  const actual = JSON.parse(fs.readFileSync(ruta, 'utf8')); // roto → tira antes de tocar nada
  const r = migrarConfigFraccionado(actual); // sin esquema por canal → tira antes de tocar nada
  if (!r) return 'ya migrado: sin cambios';
  const bak = `${ruta}.bak-config-fraccionado`;
  if (!fs.existsSync(bak)) fs.copyFileSync(ruta, bak);
  const tmp = `${ruta}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(r.costeo, null, 2), 'utf8');
  fs.renameSync(tmp, ruta);
  return `migrado: ${r.claves.join(', ')} (backup ${path.basename(bak)})`;
}

if (require.main === module) {
  try {
    console.log(main(process.argv[2]));
  } catch (err) {
    console.error('[migrar_config_fraccionado]', err.message);
    process.exitCode = 1;
  }
}

module.exports = { main };
