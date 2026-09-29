// ── Precios · Producción: pasos 3 (insumos del producto) y 4 (tabla de presentaciones) ──
// Script clásico, cargado después de precios_produccion.js y precios_produccion_detalle.js: usa sus
// globales (prodDet, pedirCampos, guardarProd, validarProd, recargarDetalleProd, urlProd, API_PROD,
// conectarBuscadorSiga, htmlBuscadorSiga, badgeEstadoProd, textoFaltante, bodyPresentacion,
// opcionesVariedad, idManualNuevo, importeEmpaque, fmtNum, btnCls/btnPrim/campoCls, nombresProd,
// htmlMarcaPres/HTML_TH_MARCA/conectarMarcasProd (precios_produccion_export.js),
// htmlNotas, htmlCambios, cajaVacia, REQ, ayuda) y los de precios.html (esc, fmtMoney,
// fmtPrecio, fmtPct, chip, numOrNull, claseDelta, badgeSemaforo, avisar,
// confirmar, pedirJson). Decisión 11: el producto tiene su lista de insumos; cada presentación elige de ahí.
// El modal de la presentación (crear/editar) está en precios_produccion_modal.js.

const TIPOS_INSUMO_UI = [['envase', 'Envase'], ['tapa', 'Tapa'], ['etiqueta', 'Etiqueta'], ['precinto', 'Precinto'], ['otro', 'Otro']];
const FUENTE_TXT = { manual: 'manual', ultimaCompra: 'últ. compra', sistema: 'sistema', insumoManual: 'insumo manual', config: 'config', receta: 'receta' };
const textoFuente = f => FUENTE_TXT[f] || '—';
const refDe = clave => (/^\d+$/.test(clave) ? { plu: clave } : { manualId: clave });
const nombrePres = plu => (prodDet.presentaciones[plu] || {}).nombre || plu;
// Claves que movieron en alguna presentación (para el estado "Cambió" de cada insumo).
const clavesConCambio = () => new Set(Object.values(prodDet.presentaciones)
  .flatMap(p => ((p.cambios && p.cambios.componentes) || []).map(c => c.plu)));

// ── Paso 3: insumos del producto ────────────────────────────────────────────────
function htmlFilaInsumo(it, cambiadas) {
  const esManual = it.plu == null;
  const estado = it.costo == null ? chip('Falta costo', 'bg-gris/15 text-gris')
    : cambiadas.has(it.clave) ? chip('Cambió', 'bg-warn/15 text-warn') : chip('OK', 'bg-ok/15 text-ok');
  const usado = (it.usadoEn || []).map(plu => esc(nombrePres(plu))).join(', ');
  const tambien = (it.tambienEn || []).map(t => `<a href="#produccion/${esc(encodeURIComponent(t.id))}" class="text-verde hover:underline">${esc(t.nombre)}</a>`).join(', ');
  const tip = esManual ? 'Costo del insumo manual (vale para todos los productos que lo usan)'
    : 'Costo manual sin IVA (el mismo override que Almacén). Vacío = vuelve al costo de sistema';
  const fondo = it.costo == null ? ' bg-gris/5' : cambiadas.has(it.clave) ? ` ${MARCA_CAMBIO}` : '';
  return `<tr class="border-t border-borde${fondo}" data-clave="${esc(it.clave)}">
    <td class="p-2 tabular-nums">${esManual ? '<span class="text-xs text-gris">manual</span>' : esc(it.plu)}</td>
    <td class="p-2">${esc(it.nombre || '—')}</td>
    <td class="p-2">${esc(it.tipo)}</td>
    <td class="p-2 text-right whitespace-nowrap">$ <input type="number" min="0" step="any" class="in-costo num-in w-24" aria-label="Costo de ${esc(it.nombre || it.clave)}" title="${esc(tip)}" value="${it.costo ?? ''}"></td>
    <td class="p-2 text-xs text-gris">${textoFuente(it.fuente)}</td>
    <td class="p-2 text-xs text-gris whitespace-nowrap">${esc(it.fechaUltimaCompra || '—')}</td>
    <td class="p-2 text-xs">${usado || '<span class="text-gris">ninguna</span>'}</td>
    <td class="p-2 text-xs">${tambien || '<span class="text-gris">—</span>'}</td>
    <td class="p-2 text-center">${estado}</td>
    <td class="p-2 text-center"><button type="button" class="in-quitar w-7 h-7 rounded-lg text-gris hover:text-crit hover:bg-crit/10" aria-label="Quitar ${esc(it.nombre || it.clave)} de la lista" title="Quitar de la lista">✕</button></td>
  </tr>`;
}
function htmlAltaInsumo() {
  const enLista = new Set(prodDet.insumos.map(i => i.clave));
  const manuales = (prodDet.insumosManuales || []).filter(m => !enLista.has(m.id))
    .map(m => `<option value="${esc(m.id)}">${esc(m.nombre)} · $ ${fmtMoney(m.costo)}</option>`).join('');
  return `<div class="flex flex-wrap items-center gap-2 mt-3">
    ${htmlBuscadorSiga('prBuscaInsumo', 'Agregar insumo de SIGA (PLU o nombre)…')}
    ${manuales ? `<select id="prInsumoExistente" class="${campoCls} py-1.5" aria-label="Agregar un insumo manual existente"><option value="">+ Insumo manual existente…</option>${manuales}</select>` : ''}
    <button type="button" id="prInsumoManual" class="${btnCls}">+ Nuevo insumo manual (sin PLU)</button></div>`;
}
function htmlSeccionInsumos() {
  const cambiadas = clavesConCambio();
  if (!prodDet.insumos.length) {
    return cajaVacia('Todavía no hay insumos. Agregá los envases, etiquetas, tapas y precintos que usa este producto: después cada presentación elige de esta lista.', htmlAltaInsumo());
  }
  return `<div class="overflow-x-auto rounded-xl border border-borde bg-card">
      <table class="w-full text-sm"><thead class="bg-verde/5 text-verde"><tr>
        <th class="p-2 text-left">PLU</th><th class="p-2 text-left">Nombre</th><th class="p-2 text-left">Tipo</th><th class="p-2 text-right">Costo</th>
        <th class="p-2 text-left">Fuente</th><th class="p-2 text-left">Última compra</th><th class="p-2 text-left">Usado en</th>
        <th class="p-2 text-left">También en</th><th class="p-2">Estado</th><th class="p-2"></th></tr></thead>
        <tbody id="prInsumos">${prodDet.insumos.map(it => htmlFilaInsumo(it, cambiadas)).join('')}</tbody></table>
    </div>${htmlAltaInsumo()}`;
}
const listaInsumos = () => prodDet.insumos.map(it => ({ ...refDe(it.clave), ...(prodDet.definicion.insumos || []).find(x => (x.plu != null ? String(x.plu) : x.manualId) === it.clave) }));
const putInsumos = insumos => pedirJson('PUT', urlProd(prodDet.id, '/insumos'), { insumos });
function agregarInsumoLista(clave) {
  if (prodDet.insumos.some(i => i.clave === clave)) { avisar('Ese insumo ya está en la lista.'); return; }
  guardarProd(() => putInsumos([...listaInsumos(), refDe(clave)]), null, 'Insumo agregado');
}
function conectarSeccionInsumos() {
  conectarBuscadorSiga('prBuscaInsumo', ({ plu }) => agregarInsumoLista(plu));
  const sel = document.getElementById('prInsumoExistente');
  if (sel) sel.onchange = () => { if (sel.value) agregarInsumoLista(sel.value); };
  document.getElementById('prInsumoManual').onclick = nuevoInsumoManual;
  document.querySelectorAll('#prInsumos tr[data-clave]').forEach(tr => {
    const it = prodDet.insumos.find(x => x.clave === tr.dataset.clave);
    tr.querySelector('.in-costo').addEventListener('change', e => cambiarCostoInsumo(it, numOrNull(e.target.value)));
    tr.querySelector('.in-quitar').onclick = () => quitarInsumo(it);
  });
}
function quitarInsumo(it) {
  if ((it.usadoEn || []).length) {
    avisar(`No se puede quitar "${it.nombre || it.clave}": lo usan las presentaciones ${it.usadoEn.map(nombrePres).join(', ')}.\nSacalo primero de esas presentaciones (paso 4).`);
    return;
  }
  guardarProd(() => putInsumos(listaInsumos().filter(x => (x.plu != null ? String(x.plu) : x.manualId) !== it.clave)), null, 'Insumo quitado');
}
async function nuevoInsumoManual() {
  const v = await pedirCampos('Nuevo insumo manual (sin PLU en SIGA)', [
    { name: 'nombre', label: 'Nombre * (ej. Etiqueta granola 2027)', required: true },
    { name: 'costo', label: 'Costo por unidad, sin IVA ($) *', type: 'number', required: true },
    { name: 'tipo', label: 'Tipo', options: TIPOS_INSUMO_UI, value: 'etiqueta' },
  ], 'Agregar');
  if (!v) return;
  const manualId = idManualNuevo(v.nombre, Date.now().toString(36).slice(-6));
  guardarProd(async () => {
    await pedirJson('PUT', `${API_PROD}/insumos-manuales/${encodeURIComponent(manualId)}`, { nombre: v.nombre, costo: numOrNull(v.costo), tipo: v.tipo });
    await putInsumos([...listaInsumos(), { manualId }]);
  }, null, 'Insumo agregado');
}
// Override de costo: PLU SIGA → PUT costo-producto (el mismo de Almacén); manual → PUT insumos-manuales.
function cambiarCostoInsumo(it, costo) {
  if (it.plu == null) {
    if (costo == null) { avisar('El insumo manual necesita un costo.'); recargarDetalleProd(); return; }
    guardarProd(() => pedirJson('PUT', `${API_PROD}/insumos-manuales/${encodeURIComponent(it.manualId)}`, { nombre: it.nombre, costo, tipo: it.tipo }), null, 'Costo guardado');
    return;
  }
  const body = costo == null ? { fuente: 'sistema' } : { fuente: 'manual', costo };
  guardarProd(() => pedirJson('PUT', '/api/precios/costo-producto/' + encodeURIComponent(it.plu), body), null, 'Costo guardado');
}

// ── Paso 4: presentaciones ──────────────────────────────────────────────────────
function htmlSeccionPresentaciones() {
  const pres = Object.values(prodDet.presentaciones);
  if (!pres.length) {
    return cajaVacia('Todavía no hay presentaciones. Cada una es un PLU vendible de SIGA (250 g, 500 g, 1 kg…): elegís la variedad, cuántos kg lleva y sus insumos, y el módulo calcula costo y precio.',
      `<button id="prNuevaPres" class="${btnPrim}">Crear presentación</button>`);
  }
  const th = (clave, txt, cls = '') => `<th class="p-2 ${cls}" data-orden="${clave}">${txt}</th>`;
  return `<div class="overflow-x-auto rounded-xl border border-borde bg-card"><table class="w-full text-sm">
    <thead class="bg-verde/5 text-verde"><tr>${HTML_TH_MARCA}${th('plu', 'PLU', 'text-left')}${th('nombre', 'Nombre', 'text-left')}${th('variedad', 'Variedad', 'text-left')}
      ${th('kg', 'kg', 'text-right')}${th('empaque', 'Empaque', 'text-right')}${th('costo', 'Costo', 'text-right')}${th('markup', 'Markup')}
      ${th('sugerido', 'Sugerido', 'text-right')}${th('vigente', 'Vigente', 'text-right')}${th('fecha', 'Act. precio')}${th('delta', 'Δ%', 'text-right')}${th('estado', 'Estado')}</tr></thead>
    <tbody id="prPres">${htmlFilasPresentaciones()}</tbody></table></div>
    <button id="prNuevaPres" class="${btnCls} mt-3">+ Otra presentación</button>`;
}
function htmlFilaPresentacion(p, nombres) {
  const falta = p.faltantes.length > 0;
  const tip = falta ? ` title="${esc('Sin precio. Falta: ' + p.faltantes.map(k => textoFaltante(k, nombres)).join('; '))}"` : '';
  const receta = prodDet.recetas[p.recetaId];
  const kg = (p.componentes.find(c => c.plu === '_receta') || {}).cantidad;
  const emp = importeEmpaque(p.componentes);
  const aviso = receta && receta.avisos.length ? ` <span class="text-warn" title="${esc(receta.avisos.join(' · '))}">⚠</span>` : '';
  const marca = estadoFila(p) === 'cambio' ? ' ' + MARCA_CAMBIO : '';
  return `<tr class="border-t border-borde cursor-pointer ${falta ? 'bg-gris/5 text-ink/60' : 'hover:bg-verde/5'}${marca}" data-plu="${esc(p.plu)}"${tip}>
    ${htmlMarcaPres(p)}
    <td class="p-2 tabular-nums">${esProvisoria(p.plu) ? '<span class="text-gris">—</span>' : esc(p.plu)}</td>
    <td class="p-2"><button type="button" class="text-left font-semibold text-verde hover:text-verdeHover">${esc(p.nombre || '—')}</button>${aviso}</td>
    <td class="p-2">${esc(receta ? receta.nombre : p.recetaId)}</td>
    <td class="p-2 text-right tabular-nums">${fmtNum(kg)}</td>
    <td class="p-2 text-right tabular-nums">${emp != null ? '$ ' + fmtMoney(emp) : '—'}</td>
    <td class="p-2 text-right tabular-nums">${p.costoUnidad != null ? '$ ' + fmtMoney(p.costoUnidad) : '—'}</td>
    <td class="p-2 text-center tabular-nums">${p.markupPct != null ? fmtNum(p.markupPct) + '%' : '—'}</td>
    <td class="p-2 text-right">${falta ? '<span class="text-ink/40">sin precio</span>' : '<b>' + fmtPrecio(p.precioConIva) + '</b>'}</td>
    <td class="p-2 text-right tabular-nums">${fmtMoney(p.precioVigente)}</td>
    ${htmlFechaPrecio(p.fechaPrecio)}
    <td class="p-2 text-right ${claseDelta(p.semaforo)}">${fmtPct(p.deltaPct)}</td>
    <td class="p-2 text-center">${badgeEstadoProd(p, nombres)}${esProvisoria(p.plu) ? ' ' + chip('Pendiente de alta en SIGA', 'bg-amarillo/30 text-ink') : ''}
      ${(p.avisos || []).includes('variedad') ? ' ' + chip('Elegí una variedad', 'bg-warn/15 text-warn') : ''}</td></tr>`;
}
// Filas en el orden elegido por header (precios_orden.js); re-pintar sólo el tbody conserva el foco del header.
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
  conectarMarcasProd(); // precios_produccion_export.js: checkbox por presentación y "marcar todas"
}
function conectarSeccionPresentaciones() {
  conectarFilasPresentaciones();
  document.getElementById('prNuevaPres').onclick = () => abrirPresentacion(null);
  montarOrdenPresProd(); // precios_orden.js
}
