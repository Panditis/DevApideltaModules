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
    : 'Costo manual (el mismo override que Reventa). Vacío = vuelve al costo de sistema';
  const fondo = it.costo == null ? ' pr-falta' : cambiadas.has(it.clave) ? ' pr-cambio' : '';
  return `<tr class="${fondo}" data-clave="${esc(it.clave)}">
    <td class="p-2 tabular-nums">${esManual ? '<span class="text-xs text-gris">manual</span>' : esc(it.plu)}</td>
    <td class="p-2 font-medium">${esc(it.nombre || '—')}</td>
    <td class="p-2 text-gris">${esc(it.tipo)}</td>
    <td class="p-2 num">${campoU(`<input type="number" min="0" step="any" class="in-costo" aria-label="Costo de ${esc(it.nombre || it.clave)}" title="${esc(tip)}" value="${it.costo ?? ''}">`, '$', { pre: true })}</td>
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
  return `<div class="pr-tabla-caja">
      <table class="pr-tabla"><thead><tr>
        <th class="text-left">PLU</th><th class="text-left">Nombre</th><th class="text-left">Tipo</th><th class="num">Costo por unidad</th>
        <th class="text-left">Fuente</th><th class="text-left">Última compra</th><th class="text-left">Usado en</th>
        <th class="text-left">También en</th><th>Estado</th><th></th></tr></thead>
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
    { name: 'costo', label: 'Costo por unidad ($) *', type: 'number', required: true },
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
  const th = (clave, txt, cls = '') => `<th class="${cls}" data-orden="${clave}">${txt}</th>`;
  // Grupos de columnas con el color de su sección del desglose: costo (azul) → ganancia (verde) → precio final.
  return `<div class="pr-tabla-caja"><table class="pr-tabla pr-pres">
    <thead><tr class="pr-grupos"><th colspan="4"></th><th colspan="4" class="g-costo">Costo por unidad</th><th class="g-margen">${segunPermiso('Ganancia', 'Markup')}</th>
      <th colspan="4" class="g-final">Precio con IVA</th><th colspan="2"></th></tr>
      <tr>${HTML_TH_MARCA}${th('plu', 'PLU', 'text-left')}${th('nombre', 'Presentación', 'text-left')}${th('variedad', 'Variedad', 'text-left')}
      ${th('kg', 'kg', 'num g-costo')}${th('empaque', 'Empaque', 'num g-costo')}${th('costo', 'Costo neto', 'num g-costo')}${th('real', 'Costo real', 'num g-costo solo-config')}${th('markup', segunPermiso('Gan. · Mk final', 'Mk · Mk final'), 'num g-margen')}
      ${th('sugerido', 'Sugerido', 'num g-final')}${th('vigente', 'Vigente SIGA', 'num g-final')}${th('delta', 'Diferencia', 'num g-final')}${th('fecha', 'Act. precio', 'g-final')}${th('estado', 'Estado costo', 'text-left')}<th><span class="sr-only">Desglose</span></th></tr></thead>
    <tbody id="prPres">${htmlFilasPresentaciones()}</tbody></table></div>
    <div class="flex items-center gap-3 mt-3"><button id="prNuevaPres" class="cfg-btn2">+ Otra presentación</button>
      <span class="text-xs text-gris">Tocá una fila para editarla · <b>▾</b> abre el desglose del precio y la fórmula para SIGA · los pack/bulto van debajo de su presentación (su % se edita en la presentación).</span>
      <button type="button" id="prExportar" class="cfg-btn ml-auto" title="El archivo de precios lleva todo lo marcado en Reventa, Fraccionado y Producción">Exportar marcados…</button></div>`;
}
const COLS_PRES = 15;
// Estado del precio (semáforo) bien visible: flecha + acción + Δ%.
const SEM_PRES = { ok: ['= OK', 'sem-ok'], subir: ['▲ Subir', 'sem-subir'], bajar: ['▼ Bajar', 'sem-bajar'] };
function htmlSemaforoPres(sem, delta) {
  const s = SEM_PRES[sem];
  if (!s) return '<span class="text-gris">—</span>';
  return `<span class="pr-sem ${s[1]}"><b>${s[0]}</b> <span class="tabular-nums">${esc(fmtPct(delta))}</span></span>`;
}
// Desgloses abiertos (por PLU): sobreviven al re-pintado del tbody (orden, marcados, recarga).
let prodDesAbiertos = new Set();
function htmlFilaPresentacion(p, nombres) {
  const falta = p.faltantes.length > 0;
  const tip = falta ? ` title="${esc('Sin precio. Falta: ' + p.faltantes.map(k => textoFaltante(k, nombres)).join('; '))}"` : '';
  const receta = prodDet.recetas[p.recetaId];
  const kg = (p.componentes.find(c => c.plu === '_receta') || {}).cantidad;
  const emp = importeEmpaque(p.componentes);
  const aviso = receta && receta.avisos.length ? ` <span class="text-warn" title="${esc(receta.avisos.join(' · '))}">⚠</span>` : '';
  const marca = estadoFila(p) === 'cambio' ? ' pr-cambio' : '';
  const abierto = prodDesAbiertos.has(String(p.plu));
  const $ = v => (v != null ? '$ ' + fmtMoney(v) : '—');
  return `<tr class="pr-fila-pres${falta ? ' pr-falta' : ''}${marca}" data-plu="${esc(p.plu)}"${tip}>
    ${htmlMarcaPres(p)}
    <td class="tabular-nums">${esProvisoria(p.plu) ? '<span class="text-gris">—</span>' : esc(p.plu)}</td>
    <td><button type="button" class="text-left font-semibold text-verde hover:text-verdeHover">${esc(p.nombre || '—')}</button>${aviso}</td>
    <td class="text-gris">${esc(receta ? receta.nombre : p.recetaId)}</td>
    <td class="num g-costo">${fmtNum(kg)}</td>
    <td class="num g-costo">${$(emp)}</td>
    <td class="num g-costo">${$(p.costoUnidad)}</td>
    <td class="num g-costo font-semibold solo-config">${$(p.costoReal)}</td>
    <td class="num g-margen whitespace-nowrap" title="${esc(`${segunPermiso(`ganancia s/ costo real · markup s/ neto ${p.markupPct != null ? fmtNum(p.markupPct) + '%' : '—'}`, 'markup s/ costo neto')} · IVA ${p.ivaPct ?? '—'} % · markup final en gris`)}">${p.gananciaPct != null ? fmtNum(p.gananciaPct) + '%' : '—'} <span class="text-gris">· ${p.markupFinalPct != null ? fmtNum(p.markupFinalPct) + '%' : '—'}</span></td>
    <td class="num g-final">${falta ? '<span class="text-ink/40">sin precio</span>' : '<b class="pr-sugerido">$ ' + fmtPrecio(p.precioConIva) + '</b>'}</td>
    <td class="num g-final text-gris">${p.precioVigente != null ? '$ ' + fmtPrecio(p.precioVigente) : '—'}</td>
    <td class="num g-final">${htmlSemaforoPres(p.semaforo, p.deltaPct)}</td>
    ${htmlFechaPrecio(p.fechaPrecio, 'g-final')}
    <td>${badgeEstadoProd(p, nombres)}${esProvisoria(p.plu) ? ' ' + chip('Pendiente de alta en SIGA', 'bg-amarillo/30 text-ink') : ''}
      ${(p.avisos || []).includes('variedad') ? ' ' + chip('Elegí una variedad', 'bg-warn/15 text-warn') : ''}</td>
    <td class="pr-des-td">${p.desglose ? `<button type="button" class="pr-des-btn" data-des="${esc(p.plu)}" aria-expanded="${abierto}" title="${abierto ? 'Ocultar' : 'Ver'} el desglose del precio">${abierto ? '▴' : '▾'}</button>` : ''}</td></tr>
    ${abierto ? htmlDesgloseFila(p) : ''}${htmlSubfilasPBProd(p)}`;
}
// Desglose del precio en una sub-fila (htmlDesglose de precios_detalle.js, el mismo del modal): componentes del
// costo a la izquierda, costo neto → costo real → ganancia → precio neto → IVA → imp. s/ final → final a la derecha.
function htmlDesgloseFila(p) {
  const des = { ...p.desglose, markupFinalPct: p.markupFinalPct, precioFinal: p.precioConIva };
  return `<tr class="pr-des-fila" data-des-de="${esc(p.plu)}"><td colspan="${COLS_PRES}">
    <div class="pr-des-grid">
      <div><div class="lbl mb-1">Costo neto por unidad</div><div class="sec s-costo pr-des-comp">${p.componentes.map(filaComponente).join('')}
        ${filaRes('=', '<b>Costo neto</b>', `<b>${plataRes(p.costoUnidad)}</b>`, 'border-t border-borde mt-1 pt-2')}</div></div>
      <div><div class="lbl mb-1">Del costo neto al precio final</div>${htmlDesglose(des, '$', p.banda === 'override')}
        <div class="ec ec-total sec s-final"><span class="ec-op" aria-hidden="true">=</span><b class="text-verde">Precio sugerido <span class="text-xs text-gris font-normal">(redondeo $50)</span></b>
          <span class="ec-val font-bold text-verde">${p.precioConIva != null ? '$ ' + fmtPrecio(p.precioConIva) : '—'}</span></div></div>
    </div>
    <div class="flex items-center gap-3 mt-3"><button type="button" class="pr-copiar cfg-btn2" data-plu="${esc(p.plu)}"${(p.formulaSiga || []).length ? '' : ' disabled'}>Copiar fórmula SIGA</button>
      <span class="text-[11px] text-gris">Componentes por unidad vendida, para cargar a mano en SIGA (el módulo no escribe en SIGA).</span></div></td></tr>`;
}
// Pack/bulto de la presentación: sub-filas agrupadas bajo su fila (sólo lectura; el % se edita en el modal).
function htmlSubfilasPBProd(p) {
  return (p.packBulto || []).map(it => `<tr class="pr-pb" data-pb-de="${esc(p.plu)}" title="Pack/bulto de ${esc(p.nombre || p.plu)}: tocá para editar su descuento">
    <td></td><td class="tabular-nums text-gris">${esc(it.plu)}</td>
    <td colspan="2"><span class="pb-etq">${etiquetaPB(it)}${badgeRevisarPB(it)}</span> <span class="text-[11px] text-gris">${esc(it.nombre || '')}</span></td>
    <td colspan="4" class="g-costo"></td><td class="g-margen"></td>
    <td class="num g-final">${precioPBHtml(it)}</td>
    <td class="num g-final text-gris">${it.precioVigente != null ? '$ ' + fmtPrecio(it.precioVigente) : '—'}</td>
    <td class="num g-final">${it.precioSugerido == null || it.precioVigente == null ? estadoPB(it) : htmlSemaforoPres(it.semaforo, it.deltaPct)}</td>
    ${htmlFechaPrecio(it.fechaPrecio, 'g-final')}<td colspan="2"></td></tr>`).join('');
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
  document.querySelectorAll('#prPres .pr-copiar').forEach(b => b.onclick = () => copiarFormulaSiga(prodDet.presentaciones[b.dataset.plu])); // precios_produccion_modal.js
  document.querySelectorAll('#prPres tr[data-plu]').forEach(tr => tr.onclick = () => abrirPresentacion(tr.dataset.plu));
  document.querySelectorAll('#prPres tr[data-pb-de]').forEach(tr => tr.onclick = () => abrirPresentacion(tr.dataset.pbDe));
  document.querySelectorAll('#prPres .pr-des-btn').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const s = new Set(prodDesAbiertos);
    if (s.has(b.dataset.des)) s.delete(b.dataset.des); else s.add(b.dataset.des);
    prodDesAbiertos = s;
    pintarFilasPresentaciones();
  });
  conectarMarcasProd(); // precios_produccion_export.js: checkbox por presentación y "marcar todas"
}
function conectarSeccionPresentaciones() {
  conectarFilasPresentaciones();
  document.getElementById('prNuevaPres').onclick = () => abrirPresentacion(null);
  const exp = document.getElementById('prExportar');
  if (exp) exp.onclick = () => exportarMarcados(); // precios_almacen.js (el mismo de la barra de marcados)
  montarOrdenPresProd(); // precios_orden.js
}
