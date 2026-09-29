// ── Precios · Producción: marcar presentaciones para actualizar en SIGA y exportarlas ──
// Script clásico cargado después de precios.html, precios_fraccionado.js, precios_pack_bulto.js y
// precios_produccion*.js; usa sus globales (esc, avisar, marcarPlus, almacenData, actualizarBarraMarcados,
// presentacionesMarcadas, fraccData, filasPBMarcadas, prodDet, getJson, API_PROD, pintarFilasPresentaciones).
// Mismo mapa de marcados por PLU que Almacén y Fraccionado (costeo.json → marcadosExportar). Sólo las
// presentaciones finales con PLU de SIGA (ni recetas ni variedades): Costo = costo total por unidad,
// Venta = precio sugerido con IVA. Las filas vienen de GET /api/precios/produccion/productos (exportables).

// ── Helpers puros (sin DOM; test/precios_produccion_export.test.js) ─────────────
const PLU_SIGA = /^\d+$/;
// Marcable: PLU real de SIGA (no una provisoria n-…), sin faltantes y con precio sugerido.
const esMarcableProd = p => PLU_SIGA.test(String(p.plu)) && !(p.faltantes || []).length && p.precioConIva != null;

// Filas de exportación (plu, nombre, costoTotal, precioConIva, faltantes) marcadas, de todos los productos.
function marcadasProd(lista) {
  return (lista || []).flatMap(f => (f.exportables || []).filter(p => p.marcado)
    .map(({ plu, nombre, costoTotal, precioConIva, faltantes }) => ({ plu, nombre, costoTotal, precioConIva, faltantes })));
}

function aplicarMarcadosProd(lista, set) {
  return (lista || []).map(f => (f.exportables ? { ...f, exportables: f.exportables.map(p => ({ ...p, marcado: set.has(p.plu) })) } : f));
}

// Un PLU = una fila del archivo de SIGA: si aparece en dos fuentes gana la última (en el lugar de la primera).
const unicosPorPlu = filas => [...new Map((filas || []).map(f => [String(f.plu), f])).values()];

// "Marcar todas" de un producto: marca las marcables; si ya estaban todas marcadas, las desmarca.
function plusMarcarTodas(presentaciones) {
  const marcables = Object.values(presentaciones || {}).filter(esMarcableProd);
  return { plus: marcables.map(p => p.plu), marcado: !(marcables.length && marcables.every(p => p.marcado)) };
}

if (typeof module === 'object' && module.exports) {
  module.exports = { esMarcableProd, marcadasProd, aplicarMarcadosProd, unicosPorPlu, plusMarcarTodas };
}

// ── Estado (listado de productos con sus exportables) ───────────────────────────
let prodExportLista = [];

// La llama el selector de Producción al cargar su listado (misma respuesta, sin otro GET).
function tomarExportProd(lista) {
  prodExportLista = lista || [];
  actualizarBarraMarcados(); // precios.html
}
async function cargarExportProd() { tomarExportProd(await getJson(API_PROD + '/productos')); }

// Todo lo marcado de las tres tabs (barra de marcados y exportación de precios.html).
const filasMarcadasTodas = () => unicosPorPlu([
  ...almacenData.filter(f => f.marcado), ...presentacionesMarcadas(), ...filasPBMarcadas(almacenData, fraccData),
  ...marcadasProd(prodExportLista),
]);

// Antes de exportar se relee Producción: un guardado en el detalle cambia costos y precios.
async function refrescarExportProd() {
  try { await cargarExportProd(); return true; } catch (e) {
    avisar('No se pudieron leer las presentaciones de Producción: ' + e.message);
    return false;
  }
}

// Hook de aplicarMarcadosLocal (precios.html): la respuesta del PUT/DELETE de marcados manda.
function aplicarMarcadosProdLocal(set) {
  prodExportLista = aplicarMarcadosProd(prodExportLista, set);
  if (!prodDet) return;
  const presentaciones = Object.fromEntries(Object.entries(prodDet.presentaciones).map(([k, p]) => [k, { ...p, marcado: set.has(p.plu) }]));
  prodDet = { ...prodDet, presentaciones };
}
// Hook de renderListados (precios.html): re-pinta las filas de presentaciones si el detalle está abierto.
function renderMarcasProd() {
  if (document.getElementById('prPres')) pintarFilasPresentaciones(); // precios_produccion_presentaciones.js
}

// ── Checkbox por presentación y "marcar todas" (tabla del paso 4) ───────────────
function motivoNoMarcable(p) {
  if (!PLU_SIGA.test(String(p.plu))) return 'Pendiente de alta en SIGA: sin PLU para exportar';
  return esMarcableProd(p) ? '' : 'Sin precio sugerido: completá lo que falta';
}
function htmlMarcaPres(p) {
  const motivo = motivoNoMarcable(p);
  return `<td class="p-2 text-center pr-marca-td"${motivo ? ` title="${esc(motivo)}"` : ''}>
    <input type="checkbox" class="pr-marca accent-verde" data-plu="${esc(p.plu)}" aria-label="Marcar ${esc(p.nombre || p.plu)} para actualizar en SIGA"${p.marcado ? ' checked' : ''}${motivo ? ' disabled' : ''}></td>`;
}
const HTML_TH_MARCA = '<th class="p-2 w-8"><input id="prMarcarTodas" type="checkbox" class="accent-verde" title="Marcar/desmarcar todas las presentaciones con precio para actualizar en SIGA"></th>';

const marcarProd = (plus, marcado) => marcarPlus(plus, marcado).catch(err => { avisar(err.message); renderMarcasProd(); }); // precios.html
function conectarMarcasProd() {
  // La celda entera frena el clic: no abre el modal de la presentación (un checkbox deshabilitado no dispara eventos).
  document.querySelectorAll('#prPres .pr-marca-td').forEach(td => { td.onclick = e => e.stopPropagation(); });
  document.querySelectorAll('#prPres .pr-marca').forEach(cb => { cb.onchange = () => marcarProd([cb.dataset.plu], cb.checked); });
  const todas = document.getElementById('prMarcarTodas');
  if (!todas) return;
  const marcables = Object.values(prodDet.presentaciones).filter(esMarcableProd);
  const n = marcables.filter(p => p.marcado).length;
  todas.disabled = !marcables.length;
  todas.checked = marcables.length > 0 && n === marcables.length;
  todas.indeterminate = n > 0 && n < marcables.length;
  todas.onchange = () => {
    const { plus, marcado } = plusMarcarTodas(prodDet.presentaciones);
    if (plus.length) marcarProd(plus, marcado); else renderMarcasProd();
  };
}

// Al abrir la página: la barra de marcados cuenta también las presentaciones de Producción.
// ponytail: es un costeo completo más al cargar (igual que /alertas); unificarlos si la carga pesa.
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => { cargarExportProd().catch(() => { /* sin Producción: la barra cuenta Almacén y Fraccionado */ }); });
}
