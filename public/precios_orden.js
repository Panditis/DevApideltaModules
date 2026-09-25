// ── Precios · orden de tablas (compartido por Almacén, Fraccionado y Producción) ──
// Script clásico cargado antes de precios_fraccionado.js. Sólo visualización: el orden se aplica sobre
// lo ya filtrado/buscado y vive mientras dure la página (sobrevive a recargas de datos y guardados).
// Click en un header: asc → desc → orden original (siguienteOrden). Vacíos/null siempre al final;
// números como número; texto con localeCompare('es'); estados por severidad (RANGO_ESTADO_*).

// ── Helpers puros (sin DOM; test/precios_orden.test.js) ─────────────────────────
// Valor comparable: número (o string numérico, ej. PLU) → número; vacío → null; resto → texto.
function valorOrden(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return /^-?\d+(\.\d+)?$/.test(String(v).trim()) ? Number(v) : String(v);
}
function compararOrden(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'es', { sensitivity: 'base', numeric: true });
}
// Copia ordenada por `clave` ('asc' | 'desc' | null = orden original). Estable; nulls siempre al final.
// extraer(fila, clave) → valor de la columna (default: fila[clave]).
function ordenarFilas(filas, clave, dir, extraer = (f, c) => f[c]) {
  const conPos = (filas || []).map((f, pos) => ({ f, pos }));
  if (!clave || !dir) return conPos.map(x => x.f);
  const signo = dir === 'desc' ? -1 : 1;
  const conValor = conPos.map(x => ({ ...x, v: valorOrden(extraer(x.f, clave)) }));
  return conValor.sort((x, y) => {
    if (x.v == null || y.v == null) return (x.v == null) - (y.v == null) || x.pos - y.pos;
    return signo * compararOrden(x.v, y.v) || x.pos - y.pos;
  }).map(x => x.f);
}
// Click en un header: misma columna asc → desc → sin orden; otra columna arranca en asc.
function siguienteOrden(actual, clave) {
  if (!actual || actual.clave !== clave) return { clave, dir: 'asc' };
  return actual.dir === 'asc' ? { clave, dir: 'desc' } : null;
}

// Severidad (asc = lo más urgente primero). Precios: subir > bajar > ok > sin vigente > sin precio.
const RANGO_ESTADO_PRECIO = { subir: 1, bajar: 2, ok: 3, sinVigente: 4, sinPrecio: 5 };
// Producción (estadoFila): faltantes > cambió > sin validar > ok.
const RANGO_ESTADO_PROD = { faltantes: 1, cambio: 2, 'sin-validar': 3, ok: 4 };
const rango = (mapa, e) => (Object.hasOwn(mapa, e) ? mapa[e] : null);
const sinPrecioFila = f => Array.isArray(f.faltantes) && f.faltantes.length > 0;
const extractorDe = cols => (f, clave) => (cols[clave] ? cols[clave](f) : f[clave]);

// Columnas de cada tabla → valor a ordenar. Reciben por parámetro los helpers de estado de cada tab.
const columnasAlmacen = estadoDe => ({
  plu: f => f.plu, nombre: f => f.nombre, costo: f => f.costoTotal, markup: f => f.markupPct,
  sugerido: f => (sinPrecioFila(f) ? null : f.precioConIva), vigente: f => f.precioVigente, delta: f => f.deltaPct,
  estado: f => rango(RANGO_ESTADO_PRECIO, estadoDe(f)),
});
function precioMinGrupo(g) {
  const ps = (g.presentaciones || []).map(p => p.precioConIva).filter(v => v != null);
  return ps.length ? Math.min(...ps) : null;
}
const columnasFracc = ({ estadoGrupo, peorPresentacion }) => ({
  plu: g => g.granelPlu, nombre: g => g.granelNombre, costo: g => (g.costoBase == null ? null : g.costoTotal),
  presentaciones: g => (g.presentaciones || []).length, sugerido: precioMinGrupo,
  delta: g => (peorPresentacion(g) || {}).deltaPct, estado: g => rango(RANGO_ESTADO_PRECIO, estadoGrupo(g)),
});
const columnasPresFracc = estadoDe => ({
  nombre: p => p.nombre, peso: p => p.pesoG, margen: p => p.markupPct, final: p => p.precioConIva,
  vigente: p => p.precioVigente, delta: p => p.deltaPct, estado: p => rango(RANGO_ESTADO_PRECIO, estadoDe(p)),
});
// Selector de Producción: con alertas/faltantes primero (más cambios = más arriba); sin alertas al final.
const columnasSelectorProd = () => ({
  nombre: p => p.nombre, variantes: p => p.variantes, presentaciones: p => p.presentaciones, costo: p => p.costoKgBase,
  estado: p => (p.alertas || p.faltantes ? -((p.alertas || 0) * 1000 + (p.faltantes || 0)) : null),
});
const columnasPresProd = ({ estadoFila, nombreVariedad, kgDe, empaqueDe }) => ({
  plu: p => p.plu, nombre: p => p.nombre, variedad: nombreVariedad, kg: kgDe, empaque: empaqueDe, costo: p => p.costoUnidad,
  markup: p => p.markupPct, sugerido: p => (sinPrecioFila(p) ? null : p.precioConIva), vigente: p => p.precioVigente,
  delta: p => p.deltaPct, estado: p => rango(RANGO_ESTADO_PROD, estadoFila(p)),
});
const ordenarCon = (filas, orden, cols) => ordenarFilas(filas, orden && orden.clave, orden && orden.dir, extractorDe(cols));

if (typeof module === 'object' && module.exports) {
  module.exports = {
    valorOrden, compararOrden, ordenarFilas, siguienteOrden, RANGO_ESTADO_PRECIO, RANGO_ESTADO_PROD,
    columnasAlmacen, columnasFracc, columnasPresFracc, columnasSelectorProd, columnasPresProd, ordenarCon,
  };
}

// ── Headers ordenables (<th aria-sort> con <button>, ▲/▼ en la columna activa) ────
const ariaOrden = (clave, orden) => (orden && orden.clave === clave ? (orden.dir === 'asc' ? 'ascending' : 'descending') : 'none');
function htmlBotonOrden(clave, texto, orden, cls = '') {
  const activo = orden && orden.clave === clave;
  return `<button type="button" data-orden="${esc(clave)}" class="inline-flex items-center gap-1 hover:text-verde ${activo ? 'text-verde underline underline-offset-4' : ''} ${cls}"
    title="Ordenar por ${esc(String(texto).replace(/<[^>]+>/g, '').trim())}">${texto}<span aria-hidden="true" class="text-[9px] w-2">${activo ? (orden.dir === 'asc' ? '▲' : '▼') : ''}</span></button>`;
}
// Para tablas armadas en JS (ingredientes de recetas).
function thOrden(clave, texto, orden, der = false) {
  return `<th class="p-1.5 ${der ? 'text-right' : 'text-left'}" aria-sort="${ariaOrden(clave, orden)}">${htmlBotonOrden(clave, texto, orden, 'uppercase tracking-[.02em]')}</th>`;
}
// Para <th data-orden="clave">Texto</th> ya en el DOM: los convierte en headers ordenables (idempotente:
// guarda el texto original en data-texto). onCambio(nuevoOrden) re-pinta la tabla; el foco vuelve al header.
function montarOrden(thead, orden, onCambio) {
  if (!thead) return;
  thead.querySelectorAll('th[data-orden]').forEach(th => {
    const clave = th.dataset.orden;
    if (th.dataset.texto == null) th.dataset.texto = th.innerHTML;
    th.setAttribute('aria-sort', ariaOrden(clave, orden));
    th.innerHTML = htmlBotonOrden(clave, th.dataset.texto, orden, 'font-[inherit] text-[inherit] uppercase');
    th.querySelector('button').onclick = () => {
      onCambio(siguienteOrden(orden, clave));
      const b = thead.querySelector(`th[data-orden="${CSS.escape(clave)}"] button`);
      if (b) b.focus();
    };
  });
}

// ── Estado del orden por tabla (vive mientras dure la página) ─────────────────────
let ordenAlmacen = null, ordenFracc = null, ordenPresFracc = null, ordenSelectorProd = null, ordenPresProd = null;

// Almacén (renderAlmacen en precios.html ordena lo filtrado con esto).
const ordenarAlmacen = filas => ordenarCon(filas, ordenAlmacen, columnasAlmacen(estadoDe));
function montarOrdenAlmacen() {
  montarOrden(document.querySelector('#panel-almacen thead'), ordenAlmacen, o => { ordenAlmacen = o; montarOrdenAlmacen(); renderAlmacen(); });
}
// Fraccionado: los graneles se ordenan; "Sin granel asignado" queda siempre al final.
function ordenarGruposFracc(grupos) {
  const graneles = grupos.filter(esGranel);
  return [...ordenarCon(graneles, ordenFracc, columnasFracc({ estadoGrupo, peorPresentacion })), ...grupos.filter(g => !esGranel(g))];
}
function montarOrdenFracc() {
  montarOrden(document.querySelector('#panel-fraccionado thead'), ordenFracc, o => { ordenFracc = o; montarOrdenFracc(); renderFraccionado(); });
}
// Modal del granel: ordena det.presentaciones y mueve las filas (con sus sub-filas pack/bulto) sin re-dibujar,
// así no se pierden los márgenes que el usuario está editando. Ordena por lo guardado (server).
const ordenarPresFracc = pres => ordenarCon(pres, ordenPresFracc, columnasPresFracc(estadoDe));
function montarOrdenPresFracc() {
  const thead = document.querySelector('#mDetBody thead');
  montarOrden(thead, ordenPresFracc, o => {
    ordenPresFracc = o;
    const cuerpo = document.querySelector('#mDetBody tbody.fd-cuerpo');
    for (const p of ordenarPresFracc(det.presentaciones)) {
      const filas = cuerpo.querySelectorAll(`tr[data-plu="${CSS.escape(p.plu)}"], tr[data-pb-pres="${CSS.escape(p.plu)}"]`);
      filas.forEach(tr => cuerpo.appendChild(tr));
    }
    montarOrdenPresFracc();
  });
}
// Producción: selector y tabla de presentaciones del paso 4.
const ordenarSelectorProd = filas => ordenarCon(filas, ordenSelectorProd, columnasSelectorProd());
function montarOrdenSelectorProd() {
  montarOrden(document.querySelector('#prCuerpo') && document.querySelector('#prCuerpo').closest('table').tHead,
    ordenSelectorProd, o => { ordenSelectorProd = o; montarOrdenSelectorProd(); pintarFilasSelector(); });
}
const ordenarPresProd = pres => ordenarCon(pres, ordenPresProd, columnasPresProd({
  estadoFila,
  nombreVariedad: p => { const r = prodDet.recetas[p.recetaId]; return r ? r.nombre : p.recetaId; },
  kgDe: p => (p.componentes.find(c => c.plu === '_receta') || {}).cantidad,
  empaqueDe: p => importeEmpaque(p.componentes),
}));
function montarOrdenPresProd() {
  const cuerpo = document.getElementById('prPres');
  if (!cuerpo) return;
  montarOrden(cuerpo.closest('table').tHead, ordenPresProd, o => { ordenPresProd = o; montarOrdenPresProd(); pintarFilasPresentaciones(); });
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => { montarOrdenAlmacen(); montarOrdenFracc(); });
}
