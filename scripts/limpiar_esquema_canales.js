'use strict';
// ── Limpieza de claves muertas tras el esquema por canal (fases 4 y 5, spec §4–§5) ──
// Se corre A MANO, una vez por instalación, DESPUÉS de migrar_esquema_canales.js y con el server ya en la versión nueva
// (la vieja volvería a escribir claves muertas):
//   node scripts/limpiar_esquema_canales.js [carpeta data]
// Saca de costeo.json y recetas_produccion.json lo que el código ya no lee (listas exactas: lib/precios_config_esquema
// CLAVES_MUERTAS_COSTEO y lib/precios_produccion limpiarRecetas). Idempotente. Backup <archivo>.bak-limpieza-esquema
// (si ya existe no se pisa: es el original). Escritura atómica (tmp + rename). Conviene correrlo sin nadie editando.
const fs = require('fs');
const path = require('path');
const { limpiarCosteo } = require('../lib/precios_config_esquema');
const { limpiarRecetas } = require('../lib/precios_produccion');

function limpiarArchivo(ruta, limpiar) {
  const nombre = path.basename(ruta);
  if (!fs.existsSync(ruta)) return `${nombre}: no existe, nada que limpiar`;
  const r = limpiar(JSON.parse(fs.readFileSync(ruta, 'utf8'))); // roto → tira antes de tocar nada
  if (!r) return `${nombre}: ya limpio`;
  const bak = `${ruta}.bak-limpieza-esquema`;
  if (!fs.existsSync(bak)) fs.copyFileSync(ruta, bak);
  fs.writeFileSync(`${ruta}.tmp`, JSON.stringify(r.datos, null, 2), 'utf8');
  fs.renameSync(`${ruta}.tmp`, ruta);
  return `${nombre}: limpio (${r.quitadas.join(', ')})`;
}

function main(dir = path.join(__dirname, '..', 'data')) {
  const costeo = path.join(dir, 'costeo.json');
  if (fs.existsSync(costeo) && !JSON.parse(fs.readFileSync(costeo, 'utf8')).margenes) {
    throw new Error('costeo.json sin migrar: correr antes node scripts/migrar_esquema_canales.js');
  }
  return [limpiarArchivo(costeo, limpiarCosteo), limpiarArchivo(path.join(dir, 'recetas_produccion.json'), limpiarRecetas)];
}

if (require.main === module) {
  try {
    main(process.argv[2]).forEach(l => console.log(l));
  } catch (err) {
    console.error('[limpiar_esquema_canales]', err.message);
    process.exitCode = 1;
  }
}

module.exports = { main };
