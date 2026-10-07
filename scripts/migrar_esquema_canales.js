'use strict';
// ── Migración ADITIVA de data/costeo.json al esquema por canal (spec 2026-10-07-precios-esquema-canales-design §4) ──
// Se corre A MANO, una vez por instalación (dev y prod); no corre al arrancar el server:
//   node scripts/migrar_esquema_canales.js [ruta/a/costeo.json]
// Agrega modoGastos, tildes por tipo en los gastos, extrasMinorista, margenes, redondeo y decisiones, y saca
// "Costos Financieros Minorista" de los gastos (lib/precios_config_esquema migrarEsquemaCanales). No borra claves
// viejas (fase 5). Idempotente. Backup <ruta>.bak-esquema-canales antes de escribir; si ya existe no se pisa (es el
// original). Escritura atómica (tmp + rename). Conviene correrlo sin nadie editando la configuración.
const fs = require('fs');
const path = require('path');
const { migrarEsquemaCanales } = require('../lib/precios_config_esquema');

function main(ruta = path.join(__dirname, '..', 'data', 'costeo.json')) {
  if (!fs.existsSync(ruta)) throw new Error(`no existe ${ruta}`);
  const actual = JSON.parse(fs.readFileSync(ruta, 'utf8')); // roto → tira antes de tocar nada
  const r = migrarEsquemaCanales(actual);
  if (!r) return 'ya migrado: sin cambios';
  const bak = `${ruta}.bak-esquema-canales`;
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
    console.error('[migrar_esquema_canales]', err.message);
    process.exitCode = 1;
  }
}

module.exports = { main };
