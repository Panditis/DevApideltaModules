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

// ── Fecha de actualización del precio (último cambio real de PrecioVenta en SIGA, 'YYYY-MM-DD') ──
// Más de DIAS_PRECIO_VIEJO días sin cambio → se resalta (text-warn). Un grupo muestra la más antigua.
const DIAS_PRECIO_VIEJO = 90;
const FECHA_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function fmtFechaPrecio(iso) {
  const m = FECHA_ISO_RE.exec(String(iso ?? ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '—';
}
function esPrecioViejo(iso, hoy = new Date()) {
  const m = FECHA_ISO_RE.exec(String(iso ?? ''));
  if (!m) return false;
  const dias = (Date.UTC(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()) - Date.UTC(+m[1], m[2] - 1, +m[3])) / 86400000;
  return dias > DIAS_PRECIO_VIEJO;
}
// ISO ordena como texto: la más antigua es la menor.
function rangoFechas(fechas) {
  const fs = (fechas || []).filter(f => FECHA_ISO_RE.test(String(f ?? ''))).sort();
  return fs.length ? { min: fs[0], max: fs[fs.length - 1] } : null;
}
const fechaMasAntigua = fechas => (rangoFechas(fechas) || {}).min ?? null;

// ── Costo última compra vs. costo de sistema (columnas fijas de Almacén y del granel de Fraccionado) ──
// Las dos columnas van CON IVA para compararlas a simple vista: el sistema es PrecioCosto de SIGA (ya trae el
// IVA de compra) y la compra, neta en SIGA, se lleva a con IVA con la alícuota del producto (sin dato → 21%).
const IVA_COMPRA_DEFAULT = 21;
const conIvaCompra = (f, neto) => (neto == null ? null
  : Math.round(neto * (1 + (f.ivaCompraPct ?? IVA_COMPRA_DEFAULT) / 100) * 100) / 100);
function costoSistemaConIvaDe(f) {
  return f.costoSistemaConIva != null ? f.costoSistemaConIva : conIvaCompra(f, f.costoSistema ?? null);
}
// La factura cargada hoy (compraHoy) manda; si no, la última compra (precioUltimaCompra/fechaUltimaCompra).
function ultimaCompraDe(f) {
  const ch = f.compraHoy;
  if (ch && ch.costo != null) {
    return { costo: conIvaCompra(f, ch.costo), hoy: true, proveedor: ch.proveedor || f.proveedor || null, comprobante: ch.comprobante || null,
      fecha: null, costoAnterior: conIvaCompra(f, ch.costoAnterior ?? null), fechaAnterior: ch.fechaAnterior ?? null };
  }
  if (f.precioUltimaCompra == null) return null;
  return { costo: conIvaCompra(f, f.precioUltimaCompra), hoy: false, proveedor: f.proveedor || null, comprobante: null,
    fecha: f.fechaUltimaCompra || null, costoAnterior: null, fechaAnterior: null };
}
const costoUltimaCompra = f => (ultimaCompraDe(f) || {}).costo ?? null;
// Δ% de la última compra contra el costo de sistema (1 decimal); null si falta alguno.
function deltaUltimaVsSistema(f) {
  const c = costoUltimaCompra(f);
  const sis = costoSistemaConIvaDe(f);
  if (c == null || !(sis > 0)) return null;
  return +(((c - sis) / sis) * 100).toFixed(1);
}
// Mismo criterio que tendenciaCompraHoy del server: dentro de ±tolerancia es 'igual'.
const tendenciaCosto = (d, tol) => (d == null ? null : Math.abs(d) <= (Number(tol) || 0) ? 'igual' : d > 0 ? 'sube' : 'baja');
function tipUltimaCompra(u) {
  if (!u) return 'Sin compras registradas';
  return [
    u.hoy ? 'Factura cargada hoy en SIGA (con IVA)' : 'Última compra (con IVA)',
    `Proveedor: ${u.proveedor || '—'}` + (u.comprobante ? ` · Comprobante: ${u.comprobante}` : ''),
    `Fecha: ${u.hoy ? 'hoy' : u.fecha || '—'}`,
    ...(u.costoAnterior != null ? [`antes $ ${fmtCostoAviso(u.costoAnterior)} (${fmtFechaPrecio(u.fechaAnterior)})`] : []),
  ].join('\n');
}
// Con el filtro "Ingreso hoy" y sin orden elegido: mayor suba de la última compra vs. sistema primero.
const ordenarPorUltimaCompra = filas => ordenarFilas(filas, 'ultima', 'desc', deltaUltimaVsSistema);

// Columnas de cada tabla → valor a ordenar. Reciben por parámetro los helpers de estado de cada tab.
const columnasAlmacen = estadoDe => ({
  plu: f => f.plu, nombre: f => f.nombre, costo: f => f.costoTotal, sistema: costoSistemaConIvaDe, ultima: costoUltimaCompra,
  markup: f => f.markupPct, vigente: f => f.precioVigente, delta: f => f.deltaPct,
  estado: f => rango(RANGO_ESTADO_PRECIO, estadoDe(f)), fecha: f => f.fechaPrecio,
});
const columnasFracc = ({ estadoGrupo, peorPresentacion }) => ({
  plu: g => g.granelPlu, nombre: g => g.granelNombre, costo: g => (g.costoBase == null ? null : g.costoTotal),
  sistema: costoSistemaConIvaDe, ultima: costoUltimaCompra, presentaciones: g => (g.presentaciones || []).length,
  delta: g => (peorPresentacion(g) || {}).deltaPct, estado: g => rango(RANGO_ESTADO_PRECIO, estadoGrupo(g)),
  fecha: g => fechaMasAntigua((g.presentaciones || []).map(p => p.fechaPrecio)),
});
const columnasPresFracc = estadoDe => ({
  nombre: p => p.nombre, peso: p => p.pesoG, margen: p => p.markupPct, final: p => p.precioConIva,
  vigente: p => p.precioVigente, delta: p => p.deltaPct, estado: p => rango(RANGO_ESTADO_PRECIO, estadoDe(p)),
  fecha: p => p.fechaPrecio,
});
// Selector de Producción: con alertas/faltantes primero (más cambios = más arriba); sin alertas al final.
const columnasSelectorProd = () => ({
  nombre: p => p.nombre, variantes: p => p.variantes, presentaciones: p => p.presentaciones, costo: p => p.costoKgBase,
  estado: p => (p.alertas || p.faltantes ? -((p.alertas || 0) * 1000 + (p.faltantes || 0)) : null),
  fecha: p => fechaMasAntigua((p.exportables || []).map(e => e.fechaPrecio)),
});
const columnasPresProd = ({ estadoFila, nombreVariedad, kgDe, empaqueDe }) => ({
  plu: p => p.plu, nombre: p => p.nombre, variedad: nombreVariedad, kg: kgDe, empaque: empaqueDe, costo: p => p.costoUnidad,
  markup: p => p.markupPct, sugerido: p => (sinPrecioFila(p) ? null : p.precioConIva), vigente: p => p.precioVigente,
  delta: p => p.deltaPct, estado: p => rango(RANGO_ESTADO_PROD, estadoFila(p)), fecha: p => p.fechaPrecio,
});
const ordenarCon = (filas, orden, cols) => ordenarFilas(filas, orden && orden.clave, orden && orden.dir, extractorDe(cols));

// ── Aviso "Factura hoy" (modales de detalle): costo neto de la factura cargada hoy vs. la compra anterior ──────────
// compraHoy viene del server con la tendencia ya resuelta contra la tolerancia global (sube/baja/igual/sin-anterior).
const AVISO_COMPRA = {
  sube: { flecha: '▲', cls: 'bg-crit/15 text-crit' },
  baja: { flecha: '▼', cls: 'bg-ok/15 text-ok' },
  igual: { flecha: '=', cls: 'bg-ink/10 text-ink/70' },
  'sin-anterior': { flecha: '', cls: 'bg-ink/10 text-ink/70' },
};
const nfAviso = dec => new Intl.NumberFormat('es-AR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const fmtCostoAviso = n => nfAviso(Math.abs(n) < 100 ? 2 : 0).format(n); // centavos sólo en costos chicos
const fmtPctAviso = n => (n > 0 ? '+' : '') + nfAviso(1).format(n) + '%';
// { texto, tip, tipo } del aviso (sin HTML).
function textoCompraHoy(ch) {
  const tipo = Object.hasOwn(AVISO_COMPRA, ch.tendencia) ? ch.tendencia : 'sin-anterior';
  const hayAnterior = ch.costoAnterior != null && ch.deltaPct != null;
  const fechaAnt = fmtFechaPrecio(ch.fechaAnterior);
  const texto = `Factura hoy $ ${fmtCostoAviso(ch.costo)}` + (hayAnterior
    ? ` ${AVISO_COMPRA[tipo].flecha} ${fmtPctAviso(ch.deltaPct)} (antes $ ${fmtCostoAviso(ch.costoAnterior)}${ch.fechaAnterior ? ' · ' + fechaAnt.slice(0, 5) : ''})`
    : ' · sin compra anterior');
  const tip = [
    'Costo unitario neto sin IVA de la factura cargada hoy en SIGA',
    `Proveedor: ${ch.proveedor || '—'} · Comprobante: ${ch.comprobante || '—'}`,
    hayAnterior ? `Compra anterior: $ ${fmtCostoAviso(ch.costoAnterior)} del ${fechaAnt}` : 'Sin compra anterior registrada',
  ].join('\n');
  return { texto, tip, tipo };
}
// Aviso de los modales de detalle: con compraHoy, costo y Δ contra la anterior; si ingresó hoy pero no hay
// línea con precio (ej. sólo una cotización), queda el badge "Ingreso hoy" de siempre. destacado = filtro activo.
function htmlAvisoIngresoHoy(f, destacado = false) {
  if (!f.compraHoy) return f.ingresoHoy ? ' <span class="px-2 py-0.5 rounded-full text-xs font-semibold bg-ok/15 text-ok">Ingreso hoy</span>' : '';
  const a = textoCompraHoy(f.compraHoy);
  const extra = destacado ? ' font-semibold ring-1 ring-current' : '';
  return ` <span class="inline-block px-2 py-0.5 rounded-full text-xs whitespace-nowrap tabular-nums ${AVISO_COMPRA[a.tipo].cls}${extra}" title="${esc(a.tip)}">${esc(a.texto)}</span>`;
}

if (typeof module === 'object' && module.exports) {
  module.exports = { costoSistemaConIvaDe,
    textoCompraHoy, ultimaCompraDe, deltaUltimaVsSistema, tendenciaCosto, tipUltimaCompra, ordenarPorUltimaCompra,
    valorOrden, compararOrden, ordenarFilas, siguienteOrden, RANGO_ESTADO_PRECIO, RANGO_ESTADO_PROD,
    columnasAlmacen, columnasFracc, columnasPresFracc, columnasSelectorProd, columnasPresProd, ordenarCon,
    DIAS_PRECIO_VIEJO, fmtFechaPrecio, esPrecioViejo, rangoFechas,
  };
}

// ── Headers ordenables (<th aria-sort> con <button>, ▲/▼ en la columna activa) ────
const ariaOrden = (clave, orden) => (orden && orden.clave === clave ? (orden.dir === 'asc' ? 'ascending' : 'descending') : 'none');
function htmlBotonOrden(clave, texto, orden, cls = '') {
  const activo = orden && orden.clave === clave;
  return `<button type="button" data-orden="${esc(clave)}" class="inline-flex items-center gap-1 hover:text-verde ${activo ? 'text-verde underline underline-offset-4' : ''} ${cls}"
    title="Ordenar por ${esc(String(texto).replace(/<[^>]+>/g, '').trim())}">${texto}<span aria-hidden="true" class="text-[9px] w-2">${activo ? (orden.dir === 'asc' ? '▲' : '▼') : ''}</span></button>`;
}
// Celda "Act. precio": una fecha o, para un grupo, la más antigua de `fechas` con el rango en el tooltip.
function htmlFechaPrecio(fechas, cls = 'p-2') {
  const r = rangoFechas([].concat(fechas));
  if (!r) return `<td class="${cls} text-center text-ink/40">—</td>`;
  const tip = r.min === r.max ? `Último cambio de precio en SIGA: ${fmtFechaPrecio(r.min)}`
    : `Más antigua ${fmtFechaPrecio(r.min)} – más reciente ${fmtFechaPrecio(r.max)}`;
  const viejo = esPrecioViejo(r.min);
  return `<td class="${cls} text-center tabular-nums whitespace-nowrap${viejo ? ' text-warn' : ''}" title="${esc(tip + (viejo ? ` · más de ${DIAS_PRECIO_VIEJO} días` : ''))}">${esc(fmtFechaPrecio(r.min))}</td>`;
}
// Celdas fijas "Costo sistema" y "Costo última compra" (listado Almacén y fila de granel de Fraccionado).
// El costo de sistema se muestra siempre; si el precio se calcula con otra fuente, un punto con tooltip.
const FUENTE_EN_USO = { manual: 'un costo manual', ultimaCompra: 'la última compra' };
function htmlCeldaCostoSistema(f) {
  const fuente = FUENTE_EN_USO[f.costoFuente];
  const ind = fuente ? ` <span class="text-[10px] text-warn align-super" title="${esc(`El precio sugerido se calcula con ${fuente}, no con el costo de sistema`)}">●</span>` : '';
  return `<td class="p-2 text-right whitespace-nowrap tabular-nums" title="Costo de sistema SIGA con IVA">${fmtMoney(costoSistemaConIvaDe(f))}${ind}</td>`;
}
// ▲ rojo si la última compra supera al sistema más allá de la tolerancia, ▼ verde si queda por debajo.
const TEND_COSTO = { sube: ['▲ ', 'text-crit font-semibold'], baja: ['▼ ', 'text-ok font-semibold'] };
function htmlCeldaUltimaCompra(f, tol) {
  const u = ultimaCompraDe(f);
  if (!u) return '<td class="p-2 text-right text-ink/40" title="Sin compras registradas">—</td>';
  const d = deltaUltimaVsSistema(f);
  const [flecha, cls] = TEND_COSTO[tendenciaCosto(d, tol)] || ['', ''];
  const tip = tipUltimaCompra(u) + (d != null ? `\nvs. costo de sistema: ${fmtPctAviso(d)}` : '');
  const hoy = u.hoy ? ' <span class="text-[10px] font-semibold text-verde">hoy</span>' : '';
  return `<td class="p-2 text-right whitespace-nowrap tabular-nums ${cls}" title="${esc(tip)}">${flecha}${fmtMoney(u.costo)}${hoy}</td>`;
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
const ordenarAlmacen = filas => (!ordenAlmacen && soloIngresoHoy ? ordenarPorUltimaCompra(filas)
  : ordenarCon(filas, ordenAlmacen, columnasAlmacen(estadoDe)));
function montarOrdenAlmacen() {
  montarOrden(document.querySelector('#panel-almacen thead'), ordenAlmacen, o => { ordenAlmacen = o; montarOrdenAlmacen(); renderAlmacen(); });
}
// Fraccionado: los graneles se ordenan; "Sin granel asignado" queda siempre al final.
function ordenarGruposFracc(grupos) {
  const graneles = grupos.filter(esGranel);
  const ordenados = !ordenFracc && frIngresoHoy ? ordenarPorUltimaCompra(graneles)
    : ordenarCon(graneles, ordenFracc, columnasFracc({ estadoGrupo, peorPresentacion }));
  return [...ordenados, ...grupos.filter(g => !esGranel(g))];
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
