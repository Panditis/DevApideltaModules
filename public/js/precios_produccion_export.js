// ── Precios · Producción: marcar presentaciones para actualizar en SIGA y exportarlas ──
// Script clásico cargado después de precios.html, precios_fraccionado.js, precios_pack_bulto.js y
// precios_produccion*.js; usa sus globales (esc, avisar, marcarPlus, almacenData, actualizarBarraMarcados,
// presentacionesMarcadas, fraccData, filasPBMarcadas, prodDet, getJson, API_PROD, pintarFilasPresentaciones).
// Mismo mapa de marcados por PLU que Almacén y Fraccionado (costeo.json → marcadosExportar). Sólo las
// presentaciones finales con PLU de SIGA (ni recetas ni variedades): Costo = costo total por unidad,
// Venta = precio sugerido final (costo neto × (1 + markup) + IVA). Las filas vienen de GET /api/precios/produccion/productos (exportables).

// ── Helpers puros (sin DOM; test/precios_produccion_export.test.js) ─────────────
const PLU_SIGA = /^\d+$/;
// Marcable: PLU real de SIGA (no una provisoria n-…), sin faltantes y con precio sugerido.
const esMarcableProd = p => PLU_SIGA.test(String(p.plu)) && !(p.faltantes || []).length && p.precioConIva != null;

// Filas de exportación (plu, nombre, costoTotal, precioConIva, faltantes) marcadas, de todos los productos.
function marcadasProd(lista) {
  return (lista || []).flatMap(f => (f.exportables || []).filter(p => p.marcado)
    .map(({ plu, nombre, costoTotal, precioConIva, faltantes, ivaPct }) => ({ plu, nombre, costoTotal, precioConIva, faltantes, ivaPct })));
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

// Vista "Todas las presentaciones": exportables de todos los productos con su producto (productoId, producto).
// q busca en presentación, producto y PLU (sin acentos); soloRevisar = semáforo subir/bajar.
// Orden por defecto: diferencia absoluta desc, sin diferencia al final (el orden por header se aplica después).
const normBusq = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function filasPlanasProd(lista, { q = '', soloRevisar = false } = {}) {
  const b = normBusq(q.trim());
  const abs = f => (f.deltaPct == null ? -1 : Math.abs(f.deltaPct));
  return (lista || []).flatMap(f => (f.exportables || []).map(p => ({ ...p, productoId: f.id, producto: f.nombre })))
    .filter(f => !b || [f.nombre, f.producto, f.plu].some(v => normBusq(v).includes(b)))
    .filter(f => !soloRevisar || f.semaforo === 'subir' || f.semaforo === 'bajar')
    .map((f, pos) => ({ f, pos })).sort((x, y) => abs(y.f) - abs(x.f) || x.pos - y.pos).map(x => x.f);
}

if (typeof module === 'object' && module.exports) {
  module.exports = { esMarcableProd, marcadasProd, aplicarMarcadosProd, unicosPorPlu, plusMarcarTodas, filasPlanasProd };
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
// Hook de renderListados (precios.html): re-pinta las filas de presentaciones (detalle) o la vista plana (listado).
function renderMarcasProd() {
  if (document.getElementById('prPres')) pintarFilasPresentaciones(); // precios_produccion_presentaciones.js
  if (document.getElementById('prPlanas')) pintarFilasPlanas();
}

// ── Vista plana del listado: todas las presentaciones de todos los productos ─────
// Usa los globales del selector (prodLista, prodBusqueda, prodSoloRevisar, pintarKpisProd, irAProduccion,
// cargandoHtml) y htmlSemaforoPres (precios_produccion_presentaciones.js), htmlFechaPrecio/ordenarCon/montarOrden (precios_orden.js).
const COLS_PLANAS = 11;
let ordenPlanasProd = null; // orden por header (null = diferencia absoluta desc, de filasPlanasProd)
const COLUMNAS_PLANAS = {
  plu: f => f.plu, nombre: f => f.nombre, producto: f => f.producto, variedad: f => f.variedad, costo: f => f.costoTotal,
  sugerido: f => ((f.faltantes || []).length ? null : f.precioConIva), vigente: f => f.precioVigente, delta: f => f.deltaPct, fecha: f => f.fechaPrecio,
};
const htmlTablaPlanas = () => `<table class="pr-tabla pr-sel">
    <thead><tr><th class="p-2 w-8"><input id="prMarcarTodasPlanas" type="checkbox" class="accent-verde" title="Marcar/desmarcar las presentaciones con precio de esta vista para actualizar en SIGA"></th>
      <th class="text-left" data-orden="plu">PLU</th><th class="text-left" data-orden="nombre">Presentación</th><th class="text-left" data-orden="producto">Producto</th>
      <th class="text-left" data-orden="variedad">Variedad</th><th class="num" data-orden="costo">Costo</th><th class="num" data-orden="sugerido">Sugerido</th>
      <th class="num" data-orden="vigente">Vigente SIGA</th><th class="num" data-orden="delta">Diferencia</th>
      <th data-orden="fecha" title="Último cambio de precio en SIGA">Act. precio</th><th class="w-10"><span class="sr-only">Abrir</span></th></tr></thead>
    <tbody id="prPlanas"><tr><td colspan="${COLS_PLANAS}">${cargandoHtml('Cargando…')}</td></tr></tbody>
  </table>`;
function montarOrdenPlanasProd() {
  const cuerpo = document.getElementById('prPlanas');
  if (cuerpo) montarOrden(cuerpo.closest('table').tHead, ordenPlanasProd, o => { ordenPlanasProd = o; montarOrdenPlanasProd(); pintarFilasPlanas(); });
}
const plata = v => (v != null ? '$ ' + fmtPrecio(v) : '<span class="text-gris">—</span>');
function htmlFilaPlana(f) {
  const falta = (f.faltantes || []).length > 0;
  return `<tr class="${falta ? 'pr-falta' : ''}" data-id="${esc(f.productoId)}" data-plu="${esc(f.plu)}">
    ${htmlMarcaPres(f)}
    <td class="tabular-nums">${esc(f.plu)}</td>
    <td class="font-semibold">${esc(f.nombre || '—')}</td>
    <td><a href="#produccion/${esc(encodeURIComponent(f.productoId))}" class="text-verde hover:underline">${esc(f.producto || f.productoId)}</a></td>
    <td class="text-gris">${esc(f.variedad || '—')}</td>
    <td class="num">${f.costoTotal != null ? '$ ' + fmtMoney(f.costoTotal) : '<span class="text-gris">—</span>'}</td>
    <td class="num">${falta ? '<span class="text-ink/40">sin precio</span>' : `<b class="pr-sugerido">${plata(f.precioConIva)}</b>`}</td>
    <td class="num text-gris">${plata(f.precioVigente)}</td>
    <td class="num">${htmlSemaforoPres(f.semaforo, f.deltaPct)}</td>
    ${htmlFechaPrecio(f.fechaPrecio, 'pr-td')}
    <td class="text-right"><span class="pr-abrir" aria-hidden="true">›</span></td></tr>`;
}
function pintarFilasPlanas() {
  const tbody = document.getElementById('prPlanas');
  if (!tbody || !prodLista) return;
  const todas = filasPlanasProd(prodExportLista);
  const vistas = filasPlanasProd(prodExportLista, { q: prodBusqueda, soloRevisar: prodSoloRevisar });
  const filas = ordenPlanasProd ? ordenarCon(vistas, ordenPlanasProd, COLUMNAS_PLANAS) : vistas;
  pintarKpisProd();
  document.getElementById('prConteo').textContent = todas.length ? `${filas.length} de ${todas.length} presentaciones` : '';
  document.getElementById('prNRevisar').textContent = `(${todas.filter(f => f.semaforo === 'subir' || f.semaforo === 'bajar').length})`;
  const vacio = !todas.length ? 'Todavía no hay presentaciones con PLU de SIGA' : 'Ninguna presentación coincide';
  tbody.innerHTML = filas.map(htmlFilaPlana).join('') || `<tr><td colspan="${COLS_PLANAS}" class="p-10 text-center text-ink/50">${vacio}</td></tr>`;
  tbody.querySelectorAll('tr[data-plu]').forEach(tr => { tr.onclick = e => { if (!e.target.closest('a')) irAProduccion(tr.dataset.id, tr.dataset.plu); }; });
  conectarMarcasFilas(tbody, filas, document.getElementById('prMarcarTodasPlanas'));
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
// Checkbox por fila dentro de `cont` + "marcar todas" (todas) sobre las presentaciones `pres` (array u objeto).
function conectarMarcasFilas(cont, pres, todas) {
  if (!cont) return; // sin presentaciones el paso 4 es una caja vacía: no hay tabla
  // La celda entera frena el clic: no abre la presentación (un checkbox deshabilitado no dispara eventos).
  cont.querySelectorAll('.pr-marca-td').forEach(td => { td.onclick = e => e.stopPropagation(); });
  cont.querySelectorAll('.pr-marca').forEach(cb => { cb.onchange = () => marcarProd([cb.dataset.plu], cb.checked); });
  if (!todas) return;
  const marcables = Object.values(pres).filter(esMarcableProd);
  const n = marcables.filter(p => p.marcado).length;
  todas.disabled = !marcables.length;
  todas.checked = marcables.length > 0 && n === marcables.length;
  todas.indeterminate = n > 0 && n < marcables.length;
  todas.onchange = () => {
    const { plus, marcado } = plusMarcarTodas(pres);
    if (plus.length) marcarProd(plus, marcado); else renderMarcasProd();
  };
}
const conectarMarcasProd = () => conectarMarcasFilas(document.getElementById('prPres'), prodDet.presentaciones, document.getElementById('prMarcarTodas'));

// Al abrir la página: la barra de marcados cuenta también las presentaciones de Producción.
// ponytail: es un costeo completo más al cargar (igual que /alertas); unificarlos si la carga pesa.
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => { cargarExportProd().catch(() => { /* sin Producción: la barra cuenta Almacén y Fraccionado */ }); });
}
