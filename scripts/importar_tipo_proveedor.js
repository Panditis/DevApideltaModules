'use strict';
// ── Importa el tipo de proveedor de Reventa (Directo / Distribuidor) desde la planilla del usuario a data/costeo.json ──
// Se corre A MANO (dev y prod), cuando llega una planilla nueva:
//   node scripts/importar_tipo_proveedor.js <ruta.xlsx> [ruta/a/costeo.json]
// Hoja "Listado" (o la primera), encabezado en la fila 1; columna A = PLU (numérico), columna C = "Directo" | "Distribuidor"
// (sin importar mayúsculas ni tildes). Filas inválidas se saltean y se informan. Se SUMA a costeo.tipoProveedor (lo de la
// planilla pisa; lo que no está en ella queda: clasificado a mano desde el modal). Productos fuera de la planilla = marca
// Apidelta o afines: no aparecen en el listado de Reventa por defecto. Idempotente. Backup <ruta>.bak-tipo-proveedor
// (si ya existe no se pisa: es el original). Escritura atómica (tmp + rename). El server no se reinicia: lo lee por pedido.
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { TIPOS_PROVEEDOR } = require('../lib/precios_listado_esquema');

const PLU = /^\d{1,12}$/;
const norm = v => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

// Libro de SheetJS → { tipos: { [plu]: tipo }, invalidas: [{ fila, motivo }], total } (fila = número de fila en Excel).
function parsearTipoProveedor(wb) {
  const hoja = wb.Sheets.Listado || wb.Sheets[wb.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(hoja, { header: 1, defval: null, blankrows: false }).slice(1);
  let tipos = {};
  const invalidas = [];
  filas.forEach((r, i) => {
    const fila = i + 2, plu = String(r[0] ?? '').trim(), tipo = norm(r[2]);
    if (!PLU.test(plu)) invalidas.push({ fila, motivo: `PLU inválido: ${JSON.stringify(r[0])}` });
    else if (!TIPOS_PROVEEDOR.includes(tipo)) invalidas.push({ fila, motivo: `PLU ${plu}: tipo inválido ${JSON.stringify(r[2])}` });
    else if (tipos[plu] && tipos[plu] !== tipo) invalidas.push({ fila, motivo: `PLU ${plu} repetido con otro tipo (queda ${tipos[plu]})` });
    else tipos = { ...tipos, [plu]: tipo };
  });
  return { tipos, invalidas, total: filas.length };
}

function main(xlsx, ruta = path.join(__dirname, '..', 'data', 'costeo.json')) {
  if (!xlsx || !fs.existsSync(xlsx)) throw new Error(`no existe la planilla ${xlsx || '(falta la ruta)'}`);
  if (!fs.existsSync(ruta)) throw new Error(`no existe ${ruta}`);
  const costeo = JSON.parse(fs.readFileSync(ruta, 'utf8')); // roto → tira antes de tocar nada
  const { tipos, invalidas, total } = parsearTipoProveedor(XLSX.readFile(xlsx));
  const previo = costeo.tipoProveedor || {};
  const cambios = Object.entries(tipos).filter(([plu, t]) => previo[plu] !== t).length;
  const cuenta = t => Object.values(tipos).filter(x => x === t).length;
  const r = { directo: cuenta('directo'), distribuidor: cuenta('distribuidor'), invalidas, total, cambios };
  if (!cambios) return r;
  const bak = `${ruta}.bak-tipo-proveedor`;
  if (!fs.existsSync(bak)) fs.copyFileSync(ruta, bak);
  fs.writeFileSync(`${ruta}.tmp`, JSON.stringify({ ...costeo, tipoProveedor: { ...previo, ...tipos } }, null, 2), 'utf8');
  fs.renameSync(`${ruta}.tmp`, ruta);
  return r;
}

if (require.main === module) {
  try {
    const r = main(process.argv[2], process.argv[3]);
    r.invalidas.forEach(i => console.log(`  fila ${i.fila}: ${i.motivo}`));
    console.log(`directo: ${r.directo} · distribuidor: ${r.distribuidor} · inválidas: ${r.invalidas.length} · filas: ${r.total} · ${
      r.cambios ? `${r.cambios} PLU(s) nuevos o cambiados guardados` : 'sin cambios'}`);
  } catch (err) {
    console.error('[importar_tipo_proveedor]', err.message);
    process.exitCode = 1;
  }
}

module.exports = { parsearTipoProveedor, main };
