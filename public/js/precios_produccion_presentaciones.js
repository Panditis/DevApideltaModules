// ── Precios · Producción: paso 3 (tabla de presentaciones) ──
// Script clásico, cargado después de precios_produccion.js y precios_produccion_detalle.js: usa sus
// globales (prodDet, estadoFila, esProvisoria, badgeEstadoProd, textoFaltante, sugeridoProd, fmtNum, btnPrim, nombresProd,
// cajaVacia) y los de precios.html (esc, fmtMoney, fmtPrecio, fmtPct, chip). Los precios salen del motor del esquema
// (p.esquema); "Precios" abre el modal de canales (abrirModalEsquema, precios_modal_esquema.js).
// El modal de la presentación (crear/editar) está en precios_produccion_modal.js.

const FUENTE_TXT = { manual: 'manual', ultimaCompra: 'últ. compra', sistema: 'sistema', receta: 'receta' };
const textoFuente = f => FUENTE_TXT[f] || '—';

// ── Paso 3: presentaciones ──────────────────────────────────────────────────────
function htmlSeccionPresentaciones() {
  const pres = Object.values(prodDet.presentaciones);
  if (!pres.length) {
    return cajaVacia('Todavía no hay presentaciones. Cada una es un PLU vendible de SIGA (250 g, 500 g, 1 kg…): elegís la variedad y cuántos kg lleva, y el módulo calcula costo y precio.',
      `<button id="prNuevaPres" class="${btnPrim}">Crear presentación</button>`);
  }
  const th = (clave, txt, cls = '') => `<th class="${cls}" data-orden="${clave}">${txt}</th>`;
  return `<div class="pr-tabla-caja"><table class="pr-tabla pr-pres">
    <thead><tr class="pr-grupos"><th colspan="3"></th><th colspan="2" class="g-costo">Costo por unidad</th><th colspan="4" class="g-final">Precio minorista</th><th colspan="2"></th></tr>
      <tr>${th('plu', 'PLU', 'text-left')}${th('nombre', 'Presentación', 'text-left')}${th('variedad', 'Variedad', 'text-left')}
      ${th('kg', 'kg', 'num g-costo')}${th('costo', 'Costo', 'num g-costo')}
      ${th('sugerido', 'Sugerido', 'num g-final')}${th('vigente', 'Vigente SIGA', 'num g-final')}${th('delta', 'Diferencia', 'num g-final')}${th('fecha', 'Act. precio', 'g-final')}
      ${th('estado', 'Estado costo', 'text-left')}<th><span class="sr-only">Precios por canal</span></th></tr></thead>
    <tbody id="prPres">${htmlFilasPresentaciones()}</tbody></table></div>
    <div class="flex items-center gap-3 mt-3"><button id="prNuevaPres" class="cfg-btn2">+ Otra presentación</button>
      <span class="text-xs text-gris">Tocá una fila para editarla · <b>Precios</b> muestra minorista, pack y bulto con su decisión.</span>
      <button type="button" id="prExportar" class="cfg-btn ml-auto" title="El archivo de precios lleva todo lo decidido en Reventa, Fraccionado y Producción">Exportar decididos…</button></div>`;
}
const SEM_PRES = { ok: ['= OK', 'sem-ok'], subir: ['▲ Subir', 'sem-subir'], bajar: ['▼ Bajar', 'sem-bajar'] };
function htmlSemaforoPres(sem, delta) {
  const s = SEM_PRES[sem];
  if (!s) return '<span class="text-gris">—</span>';
  return `<span class="pr-sem ${s[1]}"><b>${s[0]}</b> <span class="tabular-nums">${esc(fmtPct(delta))}</span></span>`;
}
function htmlFilaPresentacion(p, nombres) {
  const falta = p.faltantes.length > 0;
  const tip = falta ? ` title="${esc('Sin costo. Falta: ' + p.faltantes.map(k => textoFaltante(k, nombres)).join('; '))}"` : '';
  const receta = prodDet.recetas[p.recetaId];
  const kg = (p.componentes.find(c => c.plu === '_receta') || {}).cantidad;
  const m = sugeridoProd(p);
  const marca = estadoFila(p) === 'cambio' ? ' pr-cambio' : '';
  return `<tr class="pr-fila-pres${falta ? ' pr-falta' : ''}${marca}" data-plu="${esc(p.plu)}"${tip}>
    <td class="tabular-nums">${esProvisoria(p.plu) ? '<span class="text-gris">—</span>' : esc(p.plu)}</td>
    <td><button type="button" class="text-left font-semibold text-verde hover:text-verdeHover">${esc(p.nombre || '—')}</button></td>
    <td class="text-gris">${esc(receta ? receta.nombre : p.recetaId)}</td>
    <td class="num g-costo">${fmtNum(kg)}</td>
    <td class="num g-costo font-semibold">${p.costoUnidad != null ? '$ ' + fmtMoney(p.costoUnidad) : '—'}</td>
    <td class="num g-final">${m ? '<b class="pr-sugerido">$ ' + fmtPrecio(m.precio) + '</b>' : '<span class="text-ink/40">sin precio</span>'}</td>
    <td class="num g-final text-gris">${p.precioVigente != null ? '$ ' + fmtPrecio(p.precioVigente) : '—'}</td>
    <td class="num g-final">${m ? htmlSemaforoPres(m.estado, m.deltaPct) : '<span class="text-gris">—</span>'}</td>
    ${htmlFechaPrecio(p.fechaPrecio, 'g-final')}
    <td>${badgeEstadoProd(p, nombres)}${esProvisoria(p.plu) ? ' ' + chip('Pendiente de alta en SIGA', 'bg-amarillo/30 text-ink') : ''}
      ${(p.avisos || []).includes('variedad') ? ' ' + chip('Elegí una variedad', 'bg-warn/15 text-warn') : ''}</td>
    <td>${esProvisoria(p.plu) ? '' : `<button type="button" class="pr-precios cfg-btn2" data-plu="${esc(p.plu)}">Precios</button>`}</td></tr>`;
}
// Filas en el orden elegido por header (ordenarPresProd, precios_produccion.js); re-pintar sólo el tbody conserva el foco del header.
function htmlFilasPresentaciones() {
  const nombres = nombresProd();
  return ordenarPresProd(Object.values(prodDet.presentaciones)).map(p => htmlFilaPresentacion(p, nombres)).join('');
}
function pintarFilasPresentaciones() {
  document.getElementById('prPres').innerHTML = htmlFilasPresentaciones();
  conectarFilasPresentaciones();
}
function conectarFilasPresentaciones() {
  document.querySelectorAll('#prPres tr[data-plu]').forEach(tr => tr.onclick = () => abrirPresentacion(tr.dataset.plu));
  document.querySelectorAll('#prPres .pr-precios').forEach(b => b.onclick = e => { e.stopPropagation(); abrirModalEsquema('produccion', b.dataset.plu); }); // precios_modal_esquema.js
}
function conectarSeccionPresentaciones() {
  conectarFilasPresentaciones();
  document.getElementById('prNuevaPres').onclick = () => abrirPresentacion(null);
  const exp = document.getElementById('prExportar');
  if (exp) exp.onclick = exportarDecididos; // precios_listados.js (el mismo botón de los listados)
  montarOrdenPresProd(); // precios_produccion.js
}
