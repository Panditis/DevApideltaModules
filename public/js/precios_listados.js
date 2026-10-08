// ── Precios · listados Reventa, Fraccionado y Producción con el esquema por canal (spec 2026-10-07 §3.1) ──
// Script clásico. Una fila por producto (Fraccionado: por granel con sus presentaciones debajo; Producción: por
// presentación) con costo sistema, última compra, vigente, sugerido por fuente y un badge con la DECISIÓN (se toma en el
// modal, clic en el nombre; reemplaza al marcado y a la fuente de costo). Todo viene calculado del server (GET /api/precios/esquema/listado): acá sólo se filtra y pinta.
// Globales: esc, fmtMoney, fmtPrecio, fmtPct, claseDelta, HOJA_EXPORTACION, FILA_ENCABEZADOS, fmtFechaPrecio,
// montarOrden, ordenarCon (precios_comun.js), avisar, confirmar (precios_config.js), abrirModalEsquema (precios_modal_esquema.js),
// textoRevisar (precios_produccion.js), XLSX (CDN).
const ETIQUETA_DECISION = { sistema: '↑ sistema', ultimaCompra: '↑ última compra', manual: '↑ manual' };
const normL = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Texto del badge de una fila decidida (null sin decisión). Producción: "aumentar" (sistema es su única fuente).
function etiquetaDecision(fila, tipo) {
  if (!fila.decision) return null;
  return tipo === 'produccion' ? '↑ aumentar' : ETIQUETA_DECISION[fila.decision.fuente] || `↑ ${fila.decision.fuente}`;
}

// Filtros del listado: texto (PLU/nombre, también presentaciones), sólo decididos, última compra más cara que sistema.
function filtrarFilas(filas, { texto = '', soloDecididos = false, ultimaMasCara = false } = {}) {
  const t = normL(texto.trim());
  const coincide = f => !t || normL(`${f.plu ?? ''} ${f.nombre}`).includes(t)
    || (f.presentaciones || []).some(p => normL(`${p.plu} ${p.nombre}`).includes(t));
  return filas.filter(f => coincide(f) && (!soloDecididos || !!f.decision)
    && (!ultimaMasCara || (f.costoSistema > 0 && f.costoUltimaCompra > f.costoSistema)));
}

// ── Orden ────────────────────────────────────────────────────────────────────────
// Headers ordenables de precios_comun.js (montarOrden/ordenarCon). Siempre hay un orden: por defecto el nombre A→Z (es, sin
// mayúsculas ni acentos). Nulls al final. Fraccionado ordena los granel: cada uno lleva dentro sus presentaciones (en el
// orden del server, por peso), así que quedan juntas bajo su granel.
const ORDENAR_LST = typeof module === 'object' && module.exports ? require('./precios_comun.js').ordenarCon : ordenarCon;
const ORDEN_LST_DEFECTO = { clave: 'nombre', dir: 'asc' };
const precioSugerido = s => (s && s.minorista ? s.minorista.precio : null);
const COLUMNAS_LST = {
  plu: f => f.plu,
  nombre: f => (f.plu == null ? null : f.nombre), // "Sin granel asignado" (plu null) siempre al final
  costoSistema: f => f.costoSistema, ultimaCompra: f => f.costoUltimaCompra, deltaUltima: f => f.deltaUltimaPct, vigente: f => f.vigente,
  sugeridoSistema: f => precioSugerido((f.sugeridos || {}).sistema), sugeridoUltima: f => precioSugerido((f.sugeridos || {}).ultimaCompra),
};
const ordenarListado = (filas, orden) => ORDENAR_LST(filas, orden || ORDEN_LST_DEFECTO, COLUMNAS_LST);
// siguienteOrden cicla asc → desc → null (orden original); acá no hay "sin orden": el tercer clic vuelve a asc.
const ordenSinNulo = (previo, o) => o || { clave: previo.clave, dir: 'asc' };

if (typeof module === 'object' && module.exports) module.exports = { etiquetaDecision, filtrarFilas, ordenarListado, ordenSinNulo };

// ── DOM ─────────────────────────────────────────────────────────────────────────
const LST_CONT = { almacen: 'lstAlmacen', fraccionado: 'lstFracc', produccion: 'prodContenido' };
const lstCols = tipo => (tipo === 'produccion' ? 7 : 8);
let lstDatos = {};                                                  // tipo → filas del server
let lstOrden = { almacen: ORDEN_LST_DEFECTO, fraccionado: ORDEN_LST_DEFECTO, produccion: ORDEN_LST_DEFECTO }; // orden por tab (sobrevive recargas y filtros)
const lstFiltros = { almacen: {}, fraccionado: {}, produccion: {} }; // estado de los filtros por tab (sobrevive recargas)
const NOMBRE_LISTA = { minorista: 'minorista', packNeto: 'pack_sin_iva', packIva: 'pack_con_iva', bultoNeto: 'bulto_sin_iva', bultoIva: 'bulto_con_iva' };

const vigenteTxt = v => (v == null ? '<span class="text-gris">—</span>' : '$ ' + fmtPrecio(v));
function celdaPrecio(s) {
  if (!s || s.error) return '<span class="text-gris">—</span>';
  const m = s.minorista;
  return `<b>$ ${fmtPrecio(m.precio)}</b>${m.deltaPct == null ? '' : ` <span class="text-xs ${claseDelta(m.estado)}">${fmtPct(m.deltaPct)}</span>`}`;
}
function celdaUltima(f) {
  if (f.costoUltimaCompra == null) return '<span class="text-gris">—</span>';
  return `$ ${fmtMoney(f.costoUltimaCompra)}<div class="text-xs text-gris">${esc(fmtFechaPrecio(f.fechaUltimaCompra) || '')}</div>`;
}
const celdaDeltaUltima = f => (f.deltaUltimaPct == null ? '<span class="text-gris">—</span>'
  : `<span class="${f.deltaUltimaPct > 0 ? 'text-crit' : 'text-ok'}">${fmtPct(f.deltaUltimaPct)}</span>`);
const badgeDecision = (f, tipo) => { const t = etiquetaDecision(f, tipo); return t ? ` <span class="ml-1 px-1.5 py-0.5 rounded text-[11px] font-semibold bg-verde/15 text-verde whitespace-nowrap" title="Decidido: se exporta">${esc(t)}</span>` : ''; };
// Clic en el nombre = modal del producto, donde se elige el costo (y con eso la decisión).
const botonNombre = (f, tipo) => `<button type="button" class="lst-abrir text-left hover:text-verde hover:underline" data-plu="${esc(f.plu ?? '')}"${f.plu == null ? ' disabled' : ''}>${esc(f.nombre)}</button>${badgeDecision(f, tipo)}`;

function filaHtml(f, tipo) {
  const marca = f.decision ? ' class="bg-verde/5"' : '';
  if (tipo === 'produccion') {
    const rev = textoRevisar(f.aRevisar); // precios_produccion.js
    return `<tr${marca}><td class="p-2">${esc(f.plu)}</td><td class="p-2">${botonNombre(f, tipo)}</td>
      <td class="p-2 num">${f.costoSistema == null ? '<span class="text-gris">—</span>' : '$ ' + fmtMoney(f.costoSistema)}</td>
      <td class="p-2 num">${vigenteTxt(f.vigente)}</td><td class="p-2 num">${celdaPrecio(f.sugeridos.sistema)}</td>
      <td class="p-2">${rev ? `<span class="px-1.5 py-0.5 rounded text-[11px] font-semibold bg-warn/15 text-warn" title="${esc(f.aRevisar.map(x => textoRevisar([x])).join('\n'))}">⚠ ${esc(rev)}</span>` : ''}</td>
      <td class="p-2"><a class="text-xs text-verde underline underline-offset-2" href="#produccion/${encodeURIComponent(f.productoId)}">Receta</a></td></tr>`;
  }
  const fracc = tipo === 'fraccionado';
  const subfilas = (f.presentaciones || []).map(p => `<tr class="text-ink/80"><td class="p-2 pl-6 text-gris">${esc(p.plu)}</td><td class="p-2">↳ ${esc(p.nombre)}</td>
    <td></td><td></td><td></td><td class="p-2 num">${vigenteTxt(p.vigente)}</td>
    <td class="p-2 num">${celdaPrecio(p.sugeridos.sistema)}</td><td class="p-2 num">${celdaPrecio(p.sugeridos.ultimaCompra)}</td></tr>`).join('');
  return `<tr${marca}><td class="p-2">${esc(f.plu ?? '—')}</td><td class="p-2 font-semibold">${botonNombre(f, tipo)}${f.plu == null ? ' <span class="text-gris text-xs font-normal">sin granel</span>' : ''}</td>
    <td class="p-2 num">${f.costoSistema == null ? '<span class="text-gris">—</span>' : '$ ' + fmtMoney(f.costoSistema)}</td>
    <td class="p-2 num">${celdaUltima(f)}</td><td class="p-2 num">${celdaDeltaUltima(f)}</td>
    <td class="p-2 num">${fracc ? '' : vigenteTxt(f.vigente)}</td>
    <td class="p-2 num">${fracc ? '' : celdaPrecio(f.sugeridos.sistema)}</td><td class="p-2 num">${fracc ? '' : celdaPrecio(f.sugeridos.ultimaCompra)}</td></tr>${subfilas}`;
}

function htmlMarcoListado(tipo) {
  const f = lstFiltros[tipo], prod = tipo === 'produccion', fracc = tipo === 'fraccionado';
  // [texto, clave de orden]. En Fraccionado vigente y sugeridos son de las presentaciones, no del granel: no se ordenan.
  const ths = prod ? [['Código', 'plu'], ['Producto', 'nombre'], ['Costo', 'costoSistema'], ['Vigente', 'vigente'], ['Sugerido', 'sugeridoSistema'], ['A revisar'], ['']]
    : [['Código', 'plu'], [fracc ? 'Granel / presentación' : 'Producto', 'nombre'], ['Costo sistema', 'costoSistema'], ['Última compra', 'ultimaCompra'], ['Δ% vs sistema', 'deltaUltima'],
      ['Vigente', !fracc && 'vigente'], ['Sugerido con sistema', !fracc && 'sugeridoSistema'], ['Sugerido con última compra', !fracc && 'sugeridoUltima']];
  const toggle = (cls, k, txt) => `<button type="button" class="fbtn ${cls}${f[k] ? ' on' : ''}" aria-pressed="${!!f[k]}">${txt}</button>`;
  return `<div class="lst-aviso hidden mb-3 p-3 rounded-lg bg-warn/10 text-warn text-sm">Falta migrar la configuración al esquema por canal: sin márgenes no hay sugeridos.</div>
  <div class="flex items-center gap-2 mb-3 flex-wrap">
    <button type="button" class="lst-recargar px-3 py-1.5 rounded-lg border border-borde text-sm hover:bg-white">Recargar</button>
    <input type="search" class="lst-buscar px-3 py-1.5 rounded-lg border border-borde bg-bg/60 text-sm w-72" placeholder="Buscar por PLU o nombre…" value="${esc(f.texto || '')}">
    ${toggle('lst-decididos', 'soloDecididos', 'Sólo decididos')}
    ${prod ? '' : toggle('lst-mascara', 'ultimaMasCara', 'Última compra más cara')}
    <span class="lst-conteo text-sm text-gris"></span>
    <span class="ml-auto"></span>
    <button type="button" class="lst-quitar px-3 py-1.5 rounded-lg border border-borde text-sm hover:bg-white">Quitar decisiones</button>
    <button type="button" class="lst-exportar px-3 py-1.5 rounded-lg bg-verde text-white text-sm font-semibold hover:bg-verdeHover">Exportar decididos</button>
  </div>
  <div class="overflow-x-auto rounded-xl border border-borde shadow-fluent bg-card"><table class="w-full text-sm">
    <thead class="bg-verde/5 text-verde"><tr>${ths.map(([t, k], i) => `<th class="p-2 ${i < 2 ? 'text-left' : ''}"${k ? ` data-orden="${k}"` : ''}>${t}</th>`).join('')}</tr></thead>
    <tbody class="lst-cuerpo"><tr><td colspan="${lstCols(tipo)}" class="p-10 text-center text-ink/50"><span class="spin"></span> Cargando…</td></tr></tbody></table></div>`;
}

// ponytail: lstFiltros es estado de UI (no datos del server): se muta en el lugar a propósito.
function conectarListado(tipo, cont) {
  const f = lstFiltros[tipo];
  cont.querySelector('.lst-recargar').onclick = () => cargarListado(tipo);
  cont.querySelector('.lst-buscar').oninput = e => { f.texto = e.target.value; renderListado(tipo); };
  [['.lst-decididos', 'soloDecididos'], ['.lst-mascara', 'ultimaMasCara']].forEach(([sel, k]) => {
    const b = cont.querySelector(sel);
    if (b) b.onclick = () => { f[k] = !f[k]; b.classList.toggle('on', f[k]); b.setAttribute('aria-pressed', String(f[k])); renderListado(tipo); };
  });
  montarOrdenListado(tipo, cont);
  cont.querySelector('.lst-exportar').onclick = exportarDecididos;
  cont.querySelector('.lst-quitar').onclick = quitarDecisiones;
  const cuerpo = cont.querySelector('.lst-cuerpo');
  cuerpo.addEventListener('click', e => { const b = e.target.closest('.lst-abrir'); if (b && b.dataset.plu) abrirModalEsquema(tipo, b.dataset.plu); });
}

// Headers del tab; el clic guarda el orden, re-monta los headers (▲/▼, aria-sort) y re-pinta sólo el tbody.
function montarOrdenListado(tipo, cont) {
  const previo = lstOrden[tipo];
  montarOrden(cont.querySelector('thead'), previo, o => {
    lstOrden = { ...lstOrden, [tipo]: ordenSinNulo(previo, o) };
    montarOrdenListado(tipo, cont);
    renderListado(tipo);
  });
}

// Pinta el marco (siempre de nuevo: en Producción el contenedor lo comparten Recetas y el detalle) y trae las filas.
async function cargarListado(tipo) {
  const cont = document.getElementById(LST_CONT[tipo]);
  if (!cont) return;
  cont.innerHTML = htmlMarcoListado(tipo);
  conectarListado(tipo, cont);
  try {
    await decisionesPropiasBorradas; // precios_comun.js
    const j = await (await fetch(`/api/precios/esquema/listado?tipo=${tipo}`)).json();
    if (j.error) throw new Error(j.error);
    lstDatos = { ...lstDatos, [tipo]: j.filas };
    cont.querySelector('.lst-aviso').classList.toggle('hidden', j.migrado);
    renderListado(tipo);
  } catch (e) {
    cont.querySelector('.lst-cuerpo').innerHTML = `<tr><td colspan="${lstCols(tipo)}" class="p-8 text-center text-crit">No se pudo cargar: ${esc(e.message)}</td></tr>`;
  }
}

function renderListado(tipo) {
  const cont = document.getElementById(LST_CONT[tipo]);
  const cuerpo = cont && cont.querySelector('.lst-cuerpo');
  if (!cuerpo || !lstDatos[tipo]) return;
  const todas = lstDatos[tipo];
  const filas = ordenarListado(filtrarFilas(todas, lstFiltros[tipo]), lstOrden[tipo]);
  cont.querySelector('.lst-conteo').textContent = `${filas.length} de ${todas.length} · ${todas.filter(f => f.decision).length} decididos`;
  // ponytail: pinta todo de una vez (mismo volumen que el listado viejo); paginar si se pone lento.
  cuerpo.innerHTML = filas.length ? filas.map(f => filaHtml(f, tipo)).join('')
    : `<tr><td colspan="${lstCols(tipo)}" class="p-8 text-center text-gris">Sin productos para estos filtros.</td></tr>`;
}

// PUT de la decisión y actualización local (sin recargar SIGA). La usa el modal.
async function guardarDecision(plu, fuente) {
  const r = await fetch(`/api/precios/decision/${encodeURIComponent(plu)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fuente }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  lstDatos = Object.fromEntries(Object.entries(lstDatos).map(([t, filas]) => [t, filas.map(f => (f.plu === plu ? { ...f, decision: j.decision } : f))]));
  refrescarAlertasProduccion(); // precios_produccion.js: la decisión cambia el costo en uso → toast/badge "a revisar"
  return j.decision;
}
async function quitarDecisiones() {
  if (!(await confirmar('¿Quitar todas las decisiones (Reventa, Fraccionado y Producción)?', { textoOk: 'Quitar' }))) return;
  try {
    const j = await (await fetch('/api/precios/decisiones', { method: 'DELETE' })).json();
    if (j.error) throw new Error(j.error);
    lstDatos = Object.fromEntries(Object.entries(lstDatos).map(([t, filas]) => [t, filas.map(f => ({ ...f, decision: null }))]));
    Object.keys(lstDatos).forEach(renderListado);
    refrescarAlertasProduccion(); // precios_produccion.js
  } catch (e) { avisar(e.message); }
}

// Una planilla por lista con filas (minorista, pack/bulto sin y con IVA), en el formato que importa SIGA hoy.
async function exportarDecididos() {
  try {
    const j = await (await fetch('/api/precios/esquema/export')).json();
    if (j.error) throw new Error(j.error);
    const conFilas = Object.entries(j.listas).filter(([, filas]) => filas.length > 1);
    if (!conFilas.length) { avisar('No hay productos decididos con precio sugerido para exportar.'); return; }
    const d = new Date();
    const fecha = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    for (const [lista, filas] of conFilas) {
      const ws = XLSX.utils.aoa_to_sheet([]);
      XLSX.utils.sheet_add_aoa(ws, filas, { origin: `A${FILA_ENCABEZADOS}` });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, HOJA_EXPORTACION);
      // SIGA importa Excel 97-2003 (.xls, BIFF8), igual que el export de siempre.
      XLSX.writeFile(wb, `precios_${NOMBRE_LISTA[lista]}_${fecha}.xls`, { bookType: 'biff8' });
    }
    if (j.omitidos) avisar(`${j.omitidos} producto(s) decidido(s) sin precio con la fuente elegida quedaron fuera de los archivos.`);
  } catch (e) { avisar(e.message); }
}
