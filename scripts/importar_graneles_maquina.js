'use strict';
// ── Importa máquina / inactivo por granel desde la planilla del usuario a data/costeo.json ──
//   node scripts/importar_graneles_maquina.js <ruta.xlsx> [--aplicar] [--maquina <id>] [--costeo <ruta/a/costeo.json>]
// Hoja "Graneles" (o la primera), columnas Codigo y Maquina (s = máquina+bobina, x = inactivo, vacío = sin máquina y bolsa).
// Graneles con máquina que no están en la planilla quedan sin máquina y bolsa. Sin --aplicar = vista previa (no escribe).
// --aplicar: backup <costeo>.bak-<timestamp> y escritura atómica (tmp + rename). El server lee costeo.json por pedido (sin cache):
// no hace falta reiniciar, pero un guardado desde la UI justo en ese instante pisaría uno u otro.
// ponytail: no valida que los códigos existan como granel en SIGA (sería consultar la base); se aplican igual.
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { importarGranelesMaquina } = require('../lib/importar_graneles_maquina');

function argsDe(argv) {
  const val = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  return { xlsx: argv.find(a => !a.startsWith('--') && a !== val('--maquina') && a !== val('--costeo')),
    aplicar: argv.includes('--aplicar'), maquina: val('--maquina'),
    ruta: val('--costeo') || path.join(__dirname, '..', 'data', 'costeo.json') };
}

function main({ xlsx, aplicar, maquina, ruta }) {
  if (!xlsx || !fs.existsSync(xlsx)) throw new Error(`no existe la planilla ${xlsx || '(falta la ruta)'}`);
  const costeo = JSON.parse(fs.readFileSync(ruta, 'utf8'));
  const wb = XLSX.readFile(xlsx);
  const filas = XLSX.utils.sheet_to_json(wb.Sheets.Graneles || wb.Sheets[wb.SheetNames[0]], { defval: null });
  const { costeoNuevo, resumen: r } = importarGranelesMaquina(filas, costeo, { maquina });
  r.advertencias.forEach(a => console.log(`  aviso: ${a}`));
  console.log(`filas: ${filas.length} · máquina "${r.maquinaId}"`);
  console.log(`a máquina+bobina: ${r.aMaquina} · a inactivo (sin máquina, bolsa): ${r.aInactivo} (nuevos inactivos: ${r.nuevosInactivos}) · sin máquina y bolsa: ${r.aBolsa}`);
  console.log(`cambian: ${r.cambiosGranel} · ya estaban: ${r.yaEstaban} · advertencias: ${r.advertencias.length}`);
  console.log('códigos inexistentes en SIGA: no se valida (requiere la base)');
  if (!aplicar) return console.log('VISTA PREVIA: no se escribió nada (usá --aplicar)');
  if (!r.cambiosGranel) return console.log('sin cambios');
  const bak = `${ruta}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(ruta, bak);
  fs.writeFileSync(`${ruta}.tmp`, JSON.stringify(costeoNuevo, null, 2), 'utf8');
  fs.renameSync(`${ruta}.tmp`, ruta);
  console.log(`guardado ${ruta} (backup ${bak})`);
}

if (require.main === module) {
  try { main(argsDe(process.argv.slice(2))); } catch (err) {
    console.error('[importar_graneles_maquina]', err.message);
    process.exitCode = 1;
  }
}
