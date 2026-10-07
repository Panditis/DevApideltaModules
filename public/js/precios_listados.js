// ── Precios · listados Reventa, Fraccionado y Producción con el esquema por canal (spec 2026-10-07 §3.1) ──
// Script clásico. Una fila por producto (Fraccionado: por granel con sus presentaciones debajo; Producción: por
// presentación) con costo sistema, última compra, vigente, sugerido por fuente y la DECISIÓN (reemplaza al marcado y a
// la fuente de costo). Todo viene calculado del server (GET /api/precios/esquema/listado): acá sólo se filtra y pinta.
// Globales: esc, fmtMoney, fmtPrecio, fmtPct, claseDelta, HOJA_EXPORTACION, FILA_ENCABEZADOS, fmtFechaPrecio
// (precios_comun.js), avisar, confirmar (precios_config.js), abrirModalEsquema (precios_modal_esquema.js),
// textoRevisar (precios_produccion.js), XLSX (CDN).
const FUENTES_LST = ['sistema', 'ultimaCompra', 'manual'];
const ETIQUETA_DECISION = { sistema: 'Aumentar con sistema', ultimaCompra: 'Aumentar con última compra', manual: 'Aumentar con manual' };
const normL = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// [valor, texto] del selector. Fuentes con sugerido (manual sólo si hay costo manual) + la decisión guardada aunque ya
// no tenga sugerido. Producción: sólo "Aumentar" (= sistema, su única fuente).
function opcionesDecision(fila, tipo) {
  if (tipo === 'produccion') return [['', '—'], ['sistema', 'Aumentar']];
  const s = fila.sugeridos || {};
  const actual = fila.decision ? fila.decision.fuente : null;
  return [['', '—'], ...FUENTES_LST.filter(f => (s[f] && !s[f].error) || f === actual).map(f => [f, ETIQUETA_DECISION[f]])];
}

// Filtros del listado: texto (PLU/nombre, también presentaciones), sólo decididos, última compra más cara que sistema.
function filtrarFilas(filas, { texto = '', soloDecididos = false, ultimaMasCara = false } = {}) {
  const t = normL(texto.trim());
  const coincide = f => !t || normL(`${f.plu ?? ''} ${f.nombre}`).includes(t)
    || (f.presentaciones || []).some(p => normL(`${p.plu} ${p.nombre}`).includes(t));
  return filas.filter(f => coincide(f) && (!soloDecididos || !!f.decision)
    && (!ultimaMasCara || (f.costoSistema > 0 && f.costoUltimaCompra > f.costoSistema)));
}

if (typeof module === 'object' && module.exports) module.exports = { opcionesDecision, filtrarFilas };

// ── DOM ─────────────────────────────────────────────────────────────────────────
const LST_CONT = { almacen: 'lstAlmacen', fraccionado: 'lstFracc', produccion: 'prodContenido' };
const LST_COLS = 9;
let lstDatos = {};                                                  // tipo → filas del server
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
  const delta = f.deltaUltimaPct == null ? '' : ` · <span class="${f.deltaUltimaPct > 0 ? 'text-crit' : 'text-ok'}">${fmtPct(f.deltaUltimaPct)}</span>`;
  return `$ ${fmtMoney(f.costoUltimaCompra)}<div class="text-xs text-gris">${esc(fmtFechaPrecio(f.fechaUltimaCompra) || '')}${delta}</div>`;
}
const selectDecision = (f, tipo) => `<select class="lst-decision num-in text-left" data-plu="${esc(f.plu)}" aria-label="Decisión ${esc(f.nombre)}">
  ${opcionesDecision(f, tipo).map(([v, t]) => `<option value="${v}"${(f.decision ? f.decision.fuente : '') === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
const botonNombre = f => `<button type="button" class="lst-abrir text-left hover:text-verde hover:underline" data-plu="${esc(f.plu ?? '')}"${f.plu == null ? ' disabled' : ''}>${esc(f.nombre)}</button>`;

function filaHtml(f, tipo) {
  const marca = f.decision ? ' class="bg-verde/5"' : '';
  if (tipo === 'produccion') {
    const rev = textoRevisar(f.aRevisar); // precios_produccion.js
    return `<tr${marca}><td class="p-2">${esc(f.plu)}</td><td class="p-2">${botonNombre(f)}</td>
      <td class="p-2 num">${f.costoSistema == null ? '<span class="text-gris">—</span>' : '$ ' + fmtMoney(f.costoSistema)}</td>
      <td class="p-2 num">${vigenteTxt(f.vigente)}</td><td class="p-2 num">${celdaPrecio(f.sugeridos.sistema)}</td>
      <td class="p-2">${rev ? `<span class="px-1.5 py-0.5 rounded text-[11px] font-semibold bg-warn/15 text-warn" title="${esc(f.aRevisar.map(x => textoRevisar([x])).join('\n'))}">⚠ ${esc(rev)}</span>` : ''}</td>
      <td class="p-2">${selectDecision(f, tipo)}</td>
      <td class="p-2"><a class="text-xs text-verde underline underline-offset-2" href="#produccion/${encodeURIComponent(f.productoId)}">Receta</a></td></tr>`;
  }
  const fracc = tipo === 'fraccionado';
  const subfilas = (f.presentaciones || []).map(p => `<tr class="text-ink/80"><td class="p-2 pl-6 text-gris">${esc(p.plu)}</td><td class="p-2">↳ ${esc(p.nombre)}</td>
    <td></td><td></td><td class="p-2 num">${vigenteTxt(p.vigente)}</td>
    <td class="p-2 num">${celdaPrecio(p.sugeridos.sistema)}</td><td class="p-2 num">${celdaPrecio(p.sugeridos.ultimaCompra)}</td><td></td></tr>`).join('');
  return `<tr${marca}><td class="p-2">${esc(f.plu ?? '—')}</td><td class="p-2 font-semibold">${botonNombre(f)}</td>
    <td class="p-2 num">${f.costoSistema == null ? '<span class="text-gris">—</span>' : '$ ' + fmtMoney(f.costoSistema)}</td>
    <td class="p-2 num">${celdaUltima(f)}</td>
    <td class="p-2 num">${fracc ? '' : vigenteTxt(f.vigente)}</td>
    <td class="p-2 num">${fracc ? '' : celdaPrecio(f.sugeridos.sistema)}</td><td class="p-2 num">${fracc ? '' : celdaPrecio(f.sugeridos.ultimaCompra)}</td>
    <td class="p-2">${f.plu == null ? '<span class="text-gris text-xs">sin granel</span>' : selectDecision(f, tipo)}</td></tr>${subfilas}`;
}

function htmlMarcoListado(tipo) {
  const f = lstFiltros[tipo], prod = tipo === 'produccion';
  const ths = prod ? ['Código', 'Producto', 'Costo', 'Vigente', 'Sugerido', 'A revisar', 'Decisión', '']
    : ['Código', tipo === 'fraccionado' ? 'Granel / presentación' : 'Producto', 'Costo sistema', 'Última compra', 'Vigente', 'Sugerido con sistema', 'Sugerido con última compra', 'Decisión'];
  const toggle = (cls, k, txt) => `<button type="button" class="fbtn ${cls}${f[k] ? ' on' : ''}" aria-pressed="${!!f[k]}">${txt}</button>`;
  return `<div class="lst-aviso hidden mb-3 p-3 rounded-lg bg-warn/10 text-warn text-sm">Falta migrar la configuración al esquema por canal: sin márgenes no hay sugeridos.</div>
  <div class="flex items-center gap-2 mb-3 flex-wrap">
    <button type="button" class="lst-recargar px-3 py-1.5 rounded-lg border border-borde text-sm hover:bg-white">Recargar</button>
    <input type="search" class="lst-buscar px-3 py-1.5 rounded-lg border border-borde bg-bg/60 text-sm w-72" placeholder="Buscar por PLU o nombre…" value="${esc(f.texto || '')}">
    ${toggle('lst-decididos', 'soloDecididos', 'Sólo decididos')}
    ${prod ? '<a href="#produccion/recetas" class="text-sm text-verde underline underline-offset-2">Recetas</a>' : toggle('lst-mascara', 'ultimaMasCara', 'Última compra más cara')}
    <span class="lst-conteo text-sm text-gris"></span>
    <span class="ml-auto"></span>
    <button type="button" class="lst-quitar px-3 py-1.5 rounded-lg border border-borde text-sm hover:bg-white">Quitar decisiones</button>
    <button type="button" class="lst-exportar px-3 py-1.5 rounded-lg bg-verde text-white text-sm font-semibold hover:bg-verdeHover">Exportar decididos</button>
  </div>
  <div class="overflow-x-auto rounded-xl border border-borde shadow-fluent bg-card"><table class="w-full text-sm">
    <thead class="bg-verde/5 text-verde"><tr>${ths.map((t, i) => `<th class="p-2 ${i < 2 ? 'text-left' : ''}">${t}</th>`).join('')}</tr></thead>
    <tbody class="lst-cuerpo"><tr><td colspan="${LST_COLS}" class="p-10 text-center text-ink/50"><span class="spin"></span> Cargando…</td></tr></tbody></table></div>`;
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
  cont.querySelector('.lst-exportar').onclick = exportarDecididos;
  cont.querySelector('.lst-quitar').onclick = quitarDecisiones;
  const cuerpo = cont.querySelector('.lst-cuerpo');
  cuerpo.addEventListener('change', e => { const s = e.target.closest('.lst-decision'); if (s) cambiarDecision(tipo, s.dataset.plu, s.value || null, s); });
  cuerpo.addEventListener('click', e => { const b = e.target.closest('.lst-abrir'); if (b && b.dataset.plu) abrirModalEsquema(tipo, b.dataset.plu); });
}

// Pinta el marco (siempre de nuevo: en Producción el contenedor lo comparten Recetas y el detalle) y trae las filas.
async function cargarListado(tipo) {
  const cont = document.getElementById(LST_CONT[tipo]);
  if (!cont) return;
  cont.innerHTML = htmlMarcoListado(tipo);
  conectarListado(tipo, cont);
  try {
    const j = await (await fetch(`/api/precios/esquema/listado?tipo=${tipo}`)).json();
    if (j.error) throw new Error(j.error);
    lstDatos = { ...lstDatos, [tipo]: j.filas };
    cont.querySelector('.lst-aviso').classList.toggle('hidden', j.migrado);
    renderListado(tipo);
  } catch (e) {
    cont.querySelector('.lst-cuerpo').innerHTML = `<tr><td colspan="${LST_COLS}" class="p-8 text-center text-crit">No se pudo cargar: ${esc(e.message)}</td></tr>`;
  }
}

function renderListado(tipo) {
  const cont = document.getElementById(LST_CONT[tipo]);
  const cuerpo = cont && cont.querySelector('.lst-cuerpo');
  if (!cuerpo || !lstDatos[tipo]) return;
  const todas = lstDatos[tipo];
  const filas = filtrarFilas(todas, lstFiltros[tipo]);
  cont.querySelector('.lst-conteo').textContent = `${filas.length} de ${todas.length} · ${todas.filter(f => f.decision).length} decididos`;
  // ponytail: pinta todo de una vez (mismo volumen que el listado viejo); paginar si se pone lento.
  cuerpo.innerHTML = filas.length ? filas.map(f => filaHtml(f, tipo)).join('')
    : `<tr><td colspan="${LST_COLS}" class="p-8 text-center text-gris">Sin productos para estos filtros.</td></tr>`;
}

// PUT de la decisión y actualización local (sin recargar SIGA). La usa también el modal.
async function guardarDecision(plu, fuente) {
  const r = await fetch(`/api/precios/decision/${encodeURIComponent(plu)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fuente }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  lstDatos = Object.fromEntries(Object.entries(lstDatos).map(([t, filas]) => [t, filas.map(f => (f.plu === plu ? { ...f, decision: j.decision } : f))]));
  return j.decision;
}
async function cambiarDecision(tipo, plu, fuente, select) {
  select.disabled = true;
  try { await guardarDecision(plu, fuente); } catch (e) { avisar(e.message); }
  renderListado(tipo);
}
async function quitarDecisiones() {
  if (!(await confirmar('¿Quitar todas las decisiones (Reventa, Fraccionado y Producción)?', { textoOk: 'Quitar' }))) return;
  try {
    const j = await (await fetch('/api/precios/decisiones', { method: 'DELETE' })).json();
    if (j.error) throw new Error(j.error);
    lstDatos = Object.fromEntries(Object.entries(lstDatos).map(([t, filas]) => [t, filas.map(f => ({ ...f, decision: null }))]));
    Object.keys(lstDatos).forEach(renderListado);
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
