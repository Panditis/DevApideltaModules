// ── Precios · tab Fraccionado + su configuración ─────────────────────────────
// Script clásico cargado después del <script> inline de precios.html: reusa sus globales
// (esc, fmtMoney, fmtPrecio, fmtPct, chip, badgeSemaforo, claseDelta, tieneFaltantes, normTxt,
// numOrNull, r2, redondear50, inputCls, estadoDe, proveedorDe, opcionesFiltro, pintarBotonesFiltro,
// dropCtxs, marcarPlus, abrirModal, detalleListo, MSG_SIN_GUARDAR, htmlCostoBase, conectarCostoBase, pintarCostoBase,
// costoEfectivo, cambioCosto, msgDetalle, chipFuenteCosto, det/detEstado/detInicial, configCargada,
// y el bloque de costos extra compartido: htmlCostosExtra, iniciarCostosExtra, restaurarCostosExtra,
// pintarTotalesCostosExtra, cambioExtras, extrasValidos, itemsCostosExtra, tipCostoExtras, msgExtrasInvalidos).
// Misma experiencia que Almacén: una fila por granel ('Pesables Deposito'); click → modal con el
// mismo selector de costo (sistema / última compra / manual, por PLU del granel) y la tabla de
// presentaciones con su margen (standard de la matriz o propio) y precio. Todo POR KILO.
// Fórmula: docs/superpowers/plans/2026-09-24-precios-fase2-fraccionado.md

let fraccData = [];       // grupos del server: [{ granelPlu, granelNombre, costoBase, ..., presentaciones }]
let fraccTol = 0;         // toleranciaPct de la config, para el semáforo en vivo
let fraccMatriz = null;   // markupFraccionado de la config, para el margen standard en vivo
let fraccCargado = false; // se carga al abrir la página; se invalida al cambiar config

const FALTA_TXT = { granel: 'Sin granel asignado', costoGranel: 'Sin costo de granel', markupPct: 'Sin margen' };
// Peor estado de un granel: subir > bajar > sin precio > sin vigente > ok.
const RANGO_ESTADO = { subir: 5, bajar: 4, sinPrecio: 3, sinVigente: 2, ok: 1 };
const pedirJson = (method, url, body) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
  .then(r => r.json()).then(j => { if (j && j.error) throw new Error(j.error); return j; });
const putJson = (url, body) => pedirJson('PUT', url, body);

// Presentación con el peor estado (empate → mayor |diferencia|); null si no hay presentaciones.
function peorPresentacion(g){
  let peor = null;
  for (const p of g.presentaciones) {
    const rp = RANGO_ESTADO[estadoDe(p)] || 0, rq = peor ? RANGO_ESTADO[estadoDe(peor)] || 0 : -1;
    if (rp > rq || (rp === rq && Math.abs(p.deltaPct || 0) > Math.abs(peor.deltaPct || 0))) peor = p;
  }
  return peor;
}
const estadoGrupo = g => { const p = peorPresentacion(g); return p ? estadoDe(p) : null; };
const marcablesDe = g => g.presentaciones.filter(p => !tieneFaltantes(p));
const esGranel = g => g.granelPlu != null;

// Misma fórmula que el backend (armarGruposFraccionado): precio por kg con IVA redondeado a
// $50, salvo que reproduzca el vigente de SIGA (alineado exacto).
function calcularPresentacion(costoKg, markup, vigente){
  if (!(costoKg > 0) || markup == null || markup <= -100) return { neto: null, precio: null, deltaPct: null, semaforo: null };
  const neto = r2(costoKg * (1 + markup / 100));
  const exacto = r2(neto * 1.21);
  const precio = vigente > 0 && Math.abs(exacto - vigente) < 0.5 ? vigente : redondear50(neto * 1.21);
  if (!(vigente > 0)) return { neto, precio, deltaPct: null, semaforo: null };
  const deltaPct = +(((precio - vigente) / vigente) * 100).toFixed(1);
  const semaforo = Math.abs(deltaPct) <= fraccTol ? 'ok' : deltaPct > 0 ? 'subir' : 'bajar';
  return { neto, precio, deltaPct, semaforo };
}

// Margen standard (espejo de markupStdFraccionado en lib/precios_costeo.js): fila = banda del
// costo del granel, col = tramo del peso (sin peso → 1 kg; más pesado que el último → última col).
function markupStdCliente(costoKg, pesoG){
  const m = fraccMatriz;
  if (!m || !(costoKg > 0)) return null;
  const fila = m.bandas.findIndex(b => b === null || costoKg <= b);
  if (fila < 0 || !m.tramosG.length) return null;
  const peso = pesoG > 0 ? pesoG : 1000;
  const i = m.tramosG.findIndex(t => peso <= t);
  const v = (m.markupPct[fila] || [])[i < 0 ? m.tramosG.length - 1 : i];
  return Number.isFinite(v) ? v : null;
}

// ── Marcados (mapa único por PLU con Almacén; lo usan la barra y la exportación de precios.html) ──
function aplicarMarcadosFracc(set){
  fraccData = fraccData.map(g => ({
    ...g, presentaciones: g.presentaciones.map(p => p.marcado === set.has(p.plu) ? p : { ...p, marcado: set.has(p.plu) }),
  }));
}
// Filas para exportarMarcados/filasExportacion: Costo = costo total $/kg del granel (base +
// costos extra), Venta = precio /kg.
function presentacionesMarcadas(){
  return fraccData.flatMap(g => g.presentaciones.filter(p => p.marcado).map(p => ({
    plu: p.plu, nombre: p.nombre, costoTotal: g.costoTotal, precioConIva: p.precioConIva, faltantes: p.faltantes,
  })));
}

// ── Listado ──────────────────────────────────────────────────────────────────
async function cargarFraccionado(){
  const tbody = document.getElementById('cuerpoFracc');
  tbody.innerHTML = '<tr><td colspan="8" class="p-10 text-center text-ink/50"><span class="spin"></span> Cargando…</td></tr>';
  try {
    const [rl, rc] = await Promise.all([fetch('/api/precios/listado?tipo=fraccionado'), fetch('/api/precios/config')]);
    const j = await rl.json(), c = await rc.json();
    if (j.error) throw new Error(j.error);
    if (c.error) throw new Error(c.error);
    fraccData = j;
    fraccTol = Number(c.toleranciaPct) || 0;
    fraccMatriz = c.markupFraccionado || null;
    document.getElementById('frTolerancia').value = c.toleranciaPct;
    fraccCargado = true;
    const graneles = j.filter(esGranel);
    const nPres = j.reduce((n, g) => n + g.presentaciones.length, 0);
    document.getElementById('fraccMeta').textContent = `${graneles.length} graneles · ${nPres} presentaciones · precios por kg`;
    renderFraccionado();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8" class="p-8 text-center text-crit">No se pudo cargar: ${esc(e.message)}</td></tr>`;
  }
}

// ── Filtros (mismo mecanismo que Almacén: fDrop compartido vía dropCtxs.fracc) ─
const filtroSelFr = { proveedor: new Set(), estado: new Set() };
let frIngresoHoy = false, frSoloMarcados = false, frOcultarVacios = false;
const valorFracc = { proveedor: proveedorDe, estado: estadoGrupo };
dropCtxs.fracc = {
  sel: filtroSelFr,
  opciones: tipo => opcionesFiltro(tipo, fraccData.filter(esGranel), valorFracc),
  aplicar: () => { actualizarBotonesFiltroFr(); renderFraccionado(); },
};
function actualizarBotonesFiltroFr(){
  pintarBotonesFiltro('panel-fraccionado', filtroSelFr,
    [['frIngresoHoy', frIngresoHoy], ['frSoloMarcados', frSoloMarcados], ['frOcultarVacios', frOcultarVacios]]);
}

// El grupo "Sin granel asignado" sólo se muestra sin filtros activos (no tiene costo ni proveedor).
function filtrarFraccionado(){
  const q = normTxt(document.getElementById('frBuscar').value.trim());
  const { proveedor, estado } = filtroSelFr;
  const hayFiltros = q || proveedor.size || estado.size || frIngresoHoy || frSoloMarcados;
  return fraccData.filter(g => {
    if (!esGranel(g)) return !hayFiltros && g.presentaciones.length > 0;
    if (q && !String(g.granelPlu).includes(q) && !normTxt(g.granelNombre).includes(q)
      && !g.presentaciones.some(p => String(p.plu).includes(q) || normTxt(p.nombre).includes(q))) return false;
    if (proveedor.size && !proveedor.has(proveedorDe(g))) return false;
    if (estado.size && !estado.has(estadoGrupo(g))) return false;
    if (frIngresoHoy && !g.ingresoHoy) return false;
    if (frSoloMarcados && !g.presentaciones.some(p => p.marcado)) return false;
    if (frOcultarVacios && !g.presentaciones.length) return false;
    return true;
  });
}

function htmlFilaGranel(g){
  const n = g.presentaciones.length;
  if (!esGranel(g)) {
    const nombres = g.presentaciones.map(p => `${p.plu} ${p.nombre}`).join('\n');
    return `<tr class="border-t border-borde opacity-60" title="${esc(nombres)}">
      <td class="p-2"></td><td class="p-2">—</td>
      <td class="p-2" colspan="6">${esc(g.granelNombre)} · ${n} presentaci${n === 1 ? 'ón' : 'ones'} sin granel en la fórmula (Pesables): sin precio</td></tr>`;
  }
  const m = marcablesDe(g);
  const nMarc = m.filter(p => p.marcado).length;
  const nTmp = (g.temporales || []).length;
  const precios = g.presentaciones.map(p => p.precioConIva).filter(v => v != null);
  const min = Math.min(...precios), max = Math.max(...precios);
  const rango = !precios.length ? '<span class="text-ink/40">sin precio</span>'
    : min === max ? `<b>${fmtPrecio(min)}</b>` : `<b>${fmtPrecio(min)}</b> – <b>${fmtPrecio(max)}</b>`;
  const peor = peorPresentacion(g);
  const estado = peor ? estadoDe(peor) : null;
  const badge = estado === 'sinPrecio' ? chip('Sin precio', 'bg-ink/10 text-ink/60') : badgeSemaforo(peor && peor.semaforo);
  const extras = g.costosExtra || [];
  const tipCosto = tipCostoExtras(g, '$/kg');
  const costo = g.costoBase == null ? '<span class="text-crit text-xs">sin costo</span>'
    : chipFuenteCosto(g.costoFuente) + fmtMoney(g.costoTotal) + (extras.length ? ' <span class="text-[10px] text-gris">+extras</span>' : '');
  const tipCompra = `Proveedor: ${g.proveedor || '—'} · Última compra: ${g.fechaUltimaCompra || '—'}`;
  const badgeHoy = g.ingresoHoy ? ' ' + chip('Ingreso hoy', 'bg-ok/15 text-ok') : '';
  const filaCls = (n ? 'hover:bg-verde/5' : 'text-ink/60 hover:bg-verde/5') + (nMarc ? ' bg-amarillo/10' : '');
  return `<tr class="border-t border-borde cursor-pointer ${filaCls}" data-granel="${esc(g.granelPlu)}">
    <td class="p-2 text-center"><input type="checkbox" class="chk-granel accent-verde" data-granel="${esc(g.granelPlu)}"${m.length && nMarc === m.length ? ' checked' : ''}${m.length ? '' : ' disabled title="Sin presentaciones con precio sugerido"'}></td>
    <td class="p-2">${esc(g.granelPlu)}</td>
    <td class="p-2" title="${esc(tipCompra)}">${esc(g.granelNombre)}${badgeHoy}</td>
    <td class="p-2 text-right whitespace-nowrap"${tipCosto ? ` title="${esc(tipCosto)}"` : ''}>${costo}</td>
    <td class="p-2 text-center" title="${esc(g.presentaciones.map(p => p.nombre).join('\n'))}">${n || '<span class="text-ink/40">0</span>'}${nTmp ? ' ' + chip(`+${nTmp} temp.`, 'bg-amarillo/30 text-ink') : ''}</td>
    <td class="p-2 text-right whitespace-nowrap">${n ? rango : ''}</td>
    <td class="p-2 text-right ${claseDelta(peor && peor.semaforo)}">${fmtPct(peor ? peor.deltaPct : null)}</td>
    <td class="p-2 text-center">${n ? badge : ''}</td>
  </tr>`;
}

function renderFraccionado(){
  const tbody = document.getElementById('cuerpoFracc');
  const conteo = document.getElementById('fraccConteo');
  const chkTodos = document.getElementById('chkTodosFr');
  actualizarBarraMarcados(); // precios.html
  chkTodos.checked = false; chkTodos.indeterminate = false;
  const total = fraccData.filter(esGranel).length;
  if (!fraccData.length) {
    conteo.textContent = '';
    tbody.innerHTML = '<tr><td colspan="8" class="p-10 text-center text-ink/50">Sin graneles</td></tr>';
    return;
  }
  const grupos = filtrarFraccionado();
  conteo.textContent = `${grupos.filter(esGranel).length} de ${total} graneles`;
  if (!grupos.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="p-10 text-center text-ink/50">Ningún granel coincide con los filtros</td></tr>';
    return;
  }
  const marcables = grupos.flatMap(marcablesDe);
  const nMarc = marcables.filter(p => p.marcado).length;
  chkTodos.checked = marcables.length > 0 && nMarc === marcables.length;
  chkTodos.indeterminate = nMarc > 0 && nMarc < marcables.length;
  tbody.innerHTML = grupos.map(htmlFilaGranel).join('');
  tbody.querySelectorAll('tr[data-granel]').forEach(tr => tr.onclick = () => abrirDetalleFracc(tr.dataset.granel));
  // Check del granel = todas sus presentaciones con precio; indeterminado si están marcadas algunas.
  tbody.querySelectorAll('.chk-granel').forEach(cb => {
    const m = marcablesDe(fraccData.find(g => g.granelPlu === cb.dataset.granel));
    const n = m.filter(p => p.marcado).length;
    cb.indeterminate = n > 0 && n < m.length;
    cb.parentElement.onclick = e => e.stopPropagation();
    cb.onchange = () => marcarPlus(m.map(p => p.plu), cb.checked).catch(err => { avisar(err.message); renderFraccionado(); });
  });
}

// ── Detalle del granel (modal #mDet compartido con Almacén) ─────────────────────
async function abrirDetalleFracc(granelPlu){
  const body = document.getElementById('mDetBody');
  abrirModal('Detalle — ' + granelPlu, true);
  try {
    const [rd, rc] = await Promise.all([
      fetch('/api/precios/detalle/' + encodeURIComponent(granelPlu) + '?tipo=fraccionado'),
      fetch('/api/precios/config'),
    ]);
    const j = await rd.json(), c = await rc.json();
    if (j.error) throw new Error(j.error);
    if (c.error) throw new Error(c.error);
    det = j;
    fraccTol = Number(c.toleranciaPct) || 0;
    fraccMatriz = c.markupFraccionado || null;
    detEstado = { costoFuente: j.costoFuente || 'sistema' };
    detInicial = { costoFuente: detEstado.costoFuente, costoManualValor: j.costoOverride };
    detalleListo(j.granelNombre, j.granelPlu, j);
    body.innerHTML = htmlDetalleFracc(j);
    document.getElementById('inCosto').value = j.costoOverride ?? '';
    iniciarCostosExtra(j.costosExtra, '$/kg', recalcularDetalleFracc);
    restaurarTemporales();
    conectarDetalleFracc();
    recalcularDetalleFracc();
  } catch (e) {
    body.innerHTML = `<p class="text-crit">No se pudo cargar: ${esc(e.message)}</p>`;
  }
}

function htmlFilaPresentacionDet(p){
  const falta = p.faltantes.filter(k => k !== 'costoGranel').map(k => FALTA_TXT[k] || k).join(' · ');
  const sinPrecio = tieneFaltantes(p);
  return `<tr class="border-t border-borde align-top" data-plu="${esc(p.plu)}">
    <td class="py-2.5 pr-2"><input type="checkbox" class="fd-marca accent-verde mt-0.5" aria-label="Marcar ${esc(p.nombre)} para actualizar en SIGA"${p.marcado ? ' checked' : ''}${sinPrecio ? ' disabled title="Sin precio sugerido guardado"' : ''}></td>
    <td class="py-2.5 pr-3 break-words"><div class="font-medium">${esc(p.nombre)}</div>
      <div class="text-[11px] text-gris">PLU ${esc(p.plu)}${falta ? ` · <span class="text-crit">${esc(falta)}</span>` : ''}</div></td>
    <td class="py-2 pr-3 whitespace-nowrap"><div class="flex items-center justify-end gap-1 text-gris">
        <input type="number" step="any" min="-99" max="1000" inputmode="decimal" aria-label="Margen % de ${esc(p.nombre)}" class="fd-margen w-16 num-in text-ink" value="${esc(p.markupOverride ?? '')}">%
        <button type="button" class="fd-reset w-6 h-6 rounded text-verde hover:bg-verde/10" aria-label="Volver al margen standard" title="Volver al margen standard">↺</button></div>
      <div class="fd-std text-[11px] text-gris text-right pr-7"></div></td>
    <td class="py-2.5 pr-3 text-right tabular-nums"><div class="fd-final"></div><div class="fd-neto text-[11px] text-gris"></div></td>
    <td class="hidden sm:table-cell py-2.5 pr-3 text-right tabular-nums text-gris">${fmtMoney(p.precioVigente)}</td>
    <td class="py-2.5 text-right whitespace-nowrap"><div class="fd-delta tabular-nums"></div><div class="fd-estado mt-0.5"></div>
      <div class="sm:hidden text-[11px] text-gris tabular-nums">vig. ${fmtPrecio(p.precioVigente)}</div></td>
  </tr>`;
}

function htmlDetalleFracc(j){
  const filas = j.presentaciones.length ? j.presentaciones.map(htmlFilaPresentacionDet).join('')
    : '<tr><td colspan="6" class="py-6 text-center text-gris">Este granel no tiene presentaciones asociadas (fórmulas de Pesables)</td></tr>';
  const th = (txt, cls = 'text-right') => `<th scope="col" class="pb-1.5 pr-3 font-semibold text-[11px] text-gris ${cls}">${txt}</th>`;
  return `
    <div class="mt-1" role="group" aria-label="Costo del granel">
      ${htmlCostoBase(j, '$/kg')}
      ${htmlCostosExtra('$/kg', '$/kg = monto fijo por kilo; % = sobre el costo base. El margen standard se busca con el costo base.')}
    </div>

    <div class="mt-5 mb-1.5">
      <h4 class="lbl sec-tit s-final">Presentaciones · precio por kg</h4>
      <p class="text-[11px] text-gris">Costo total × (1 + margen) × IVA 21%, redondeo a $50 · margen vacío = standard</p>
    </div>
    <div class="overflow-x-auto rounded-lg border border-borde">
      <table class="w-full text-sm">
        <thead class="bg-verde/5"><tr class="border-b border-borde">
          ${th('<span class="sr-only">Exportar a SIGA</span>✓', 'text-left w-6 pl-2 pt-1.5')}${th('Presentación', 'text-left pt-1.5')}${th('Margen', 'text-right pt-1.5')}
          ${th('Precio final /kg', 'text-right pt-1.5')}${th('Vigente', 'text-right hidden sm:table-cell pt-1.5')}${th('Δ', 'text-right pt-1.5 !pr-0 sm:!pr-2')}</tr></thead>
        <tbody class="fd-cuerpo">${filas}</tbody>
        <tbody id="ftCuerpo" class="fd-cuerpo"></tbody>
      </table>
    </div>
    <div class="mt-2 flex items-baseline gap-2 flex-wrap">
      <button type="button" id="ftAgregar" class="text-xs font-semibold text-verde hover:text-verdeHover disabled:opacity-40">+ Simular presentación</button>
      <span class="text-[11px] text-gris">peso sin código en SIGA · no se marca ni se exporta</span></div>`;
}

const filasDetFracc = () => [...document.querySelectorAll('#mDetBody tr[data-plu]')]
  .map(tr => ({ tr, p: det.presentaciones.find(x => x.plu === tr.dataset.plu) }));

function conectarDetalleFracc(){
  conectarCostoBase(recalcularDetalleFracc);
  for (const { tr } of filasDetFracc()) {
    const input = tr.querySelector('.fd-margen');
    input.addEventListener('input', recalcularDetalleFracc);
    tr.querySelector('.fd-reset').onclick = () => { input.value = ''; recalcularDetalleFracc(); input.focus(); };
    const chk = tr.querySelector('.fd-marca');
    chk.onchange = async () => {
      chk.disabled = true;
      try {
        const j = await marcarPlus([tr.dataset.plu], chk.checked);
        chk.checked = j.marcados.includes(tr.dataset.plu);
      } catch (e) {
        chk.checked = !chk.checked; msgDetalle(e.message, true);
      } finally { chk.disabled = false; }
    };
  }
  document.getElementById('btnDescartar').onclick = () => {
    detEstado = { costoFuente: detInicial.costoFuente };
    document.getElementById('inCosto').value = detInicial.costoManualValor ?? '';
    for (const { tr, p } of filasDetFracc()) tr.querySelector('.fd-margen').value = p.markupOverride ?? '';
    restaurarCostosExtra(det.costosExtra);
    restaurarTemporales();
    msgDetalle(''); recalcularDetalleFracc();
  };
  document.getElementById('ftAgregar').onclick = agregarTemporal;
  document.getElementById('btnGuardarDet').onclick = guardarDetalleFracc;
}

// Recalcula en vivo: el margen standard depende del costo elegido (banda de la matriz, por costo
// base); el precio se calcula sobre el costo total (base + costos extra).
function recalcularDetalleFracc(){
  const costo = pintarCostoBase();
  const costoTotal = pintarTotalesCostosExtra(costo);
  let margenesCambiados = 0;
  for (const { tr, p } of filasDetFracc()) {
    const input = tr.querySelector('.fd-margen');
    const std = markupStdCliente(costo, p.pesoG);
    const propio = numOrNull(input.value);
    if (propio !== p.markupOverride) margenesCambiados++;
    tr.querySelector('.fd-std').textContent = std == null ? 'sin standard' : propio == null ? 'standard' : `standard ${std}%`;
    input.placeholder = std ?? '—';
    input.title = `Vacío = margen standard (${std ?? '—'}%)`;
    tr.querySelector('.fd-reset').classList.toggle('invisible', propio == null);
    const c = p.faltantes.includes('granel') ? calcularPresentacion(null) : calcularPresentacion(costoTotal, propio ?? std, p.precioVigente);
    tr.querySelector('.fd-neto').textContent = c.neto != null ? 'neto ' + fmtMoney(c.neto) : '';
    tr.querySelector('.fd-final').innerHTML = c.precio == null ? '<span class="text-gris">sin precio</span>'
      : `<b class="text-verde">$ ${fmtPrecio(c.precio)}</b>`;
    const td = tr.querySelector('.fd-delta');
    td.className = 'fd-delta tabular-nums ' + claseDelta(c.semaforo);
    td.textContent = fmtPct(c.deltaPct);
    tr.querySelector('.fd-estado').innerHTML = c.precio == null ? chip('Sin precio', 'bg-ink/10 text-ink/60')
      : p.precioVigente == null ? '<span class="text-[11px] text-gris">sin vigente</span>' : badgeSemaforo(c.semaforo);
  }
  recalcularTemporales(costo, costoTotal);
  const costoOk = costo != null && costo > 0;
  const hayCambios = cambioCosto() || margenesCambiados > 0 || cambioExtras() || cambioTemporales();
  const extrasOk = extrasValidos();
  const tmpOk = temporalesValidas();
  document.getElementById('btnGuardarDet').disabled = !(hayCambios && extrasOk && tmpOk && (costoOk || !cambioCosto()));
  document.getElementById('btnDescartar').disabled = !hayCambios;
  if (cambioCosto() && !costoOk) msgDetalle('Completá el costo base para calcular.', true);
  else if (!extrasOk) msgDetalle(msgExtrasInvalidos(), true);
  else if (!tmpOk) msgDetalle('Presentación simulada: elegí el peso (1 a 100.000 g); margen de −99 a 1000 % o vacío = standard.', true);
  else if (hayCambios) msgDetalle(MSG_SIN_GUARDAR, false, 'text-warn');
  else msgDetalle('');
}

// Guarda sólo lo que cambió: costo del granel (PUT costo-producto), costos extra (PUT costos-extra,
// lista completa; [] los borra) y margen propio de cada presentación cambiada (PUT margen-producto;
// null = volver al standard).
async function guardarDetalleFracc(){
  const tareas = [];
  if (cambioCosto()) {
    const fuente = detEstado.costoFuente;
    const costo = numOrNull(document.getElementById('inCosto').value);
    tareas.push(putJson('/api/precios/costo-producto/' + encodeURIComponent(det.granelPlu), fuente === 'manual' ? { fuente, costo } : { fuente }));
  }
  if (cambioExtras()) {
    tareas.push(putJson('/api/precios/costos-extra/' + encodeURIComponent(det.granelPlu), { items: itemsCostosExtra() }));
  }
  for (const { tr, p } of filasDetFracc()) {
    const valor = numOrNull(tr.querySelector('.fd-margen').value);
    if (valor !== p.markupOverride) tareas.push(putJson('/api/precios/margen-producto/' + encodeURIComponent(p.plu), { markupPct: valor }));
  }
  tareas.push(...tareasTemporales());
  document.getElementById('btnGuardarDet').disabled = true;
  msgDetalle('Guardando…', false, 'text-gris');
  try {
    await Promise.all(tareas);
    await abrirDetalleFracc(det.granelPlu);
    msgDetalle('Guardado.');
    cargarFraccionado();
  } catch (e) {
    msgDetalle(e.message, true);
    document.getElementById('btnGuardarDet').disabled = false;
  }
}

// ── Presentaciones simuladas (temporales) del granel ─────────────────────────
// Copia editable del modal: se guardan con el Guardar del modal (DELETE quitadas, POST nuevas, PUT
// cambiadas) y Descartar las revierte, igual que márgenes y costos extra. Un modal abierto a la vez.
const PESOS_COMUNES = [30, 50, 100, 150, 200, 250, 400, 500, 1000, 2000, 5000, 10000, 25000];
const TEMPORALES_MAX = 30; // mismo tope que el server (routes/rutas_precios.js)
const etiquetaPesoCli = g => (g >= 1000 ? `${g / 1000}KG` : `${g}G`);
let tmpEdit = []; // [{ id, pesoG, markupPct, nombre, otra }] — id 'n…' = todavía no guardada
let tmpSeq = 0;
const claveTmp = t => JSON.stringify([t.pesoG, t.markupPct]);
const inicialesTmp = () => (det.temporales || []).map(t => ({ id: t.id, pesoG: t.pesoG, markupPct: t.markupOverride, nombre: t.nombre }));
const cambiadaTmp = (ini, t) => { const o = ini.find(x => x.id === t.id); return !o || claveTmp(o) !== claveTmp(t); };
function cambioTemporales(){
  const ini = inicialesTmp();
  return ini.length !== tmpEdit.length || tmpEdit.some(t => cambiadaTmp(ini, t));
}
// Mismos límites que validarPresentacionTemporal (lib/precios_costeo.js); el server valida igual.
const temporalesValidas = () => tmpEdit.every(t => t.pesoG >= 1 && t.pesoG <= 100000
  && (t.markupPct == null || (t.markupPct >= -99 && t.markupPct <= 1000)));

function tareasTemporales(){
  const base = '/api/precios/presentaciones-temporales/' + encodeURIComponent(det.granelPlu);
  const ini = inicialesTmp();
  const body = t => ({ pesoG: t.pesoG, markupPct: t.markupPct });
  return [
    ...ini.filter(o => !tmpEdit.some(t => t.id === o.id)).map(o => pedirJson('DELETE', `${base}/${encodeURIComponent(o.id)}`)),
    ...tmpEdit.filter(t => t.id.startsWith('n')).map(t => pedirJson('POST', base, body(t))),
    ...tmpEdit.filter(t => !t.id.startsWith('n') && cambiadaTmp(ini, t)).map(t => pedirJson('PUT', `${base}/${encodeURIComponent(t.id)}`, body(t))),
  ];
}

function restaurarTemporales(){
  tmpEdit = inicialesTmp().map(t => ({ ...t, otra: !PESOS_COMUNES.includes(t.pesoG) }));
  pintarTemporales();
}
function agregarTemporal(){
  if (tmpEdit.length >= TEMPORALES_MAX) return;
  tmpEdit = [...tmpEdit, { id: 'n' + (++tmpSeq), pesoG: null, markupPct: null, nombre: null, otra: false }];
  pintarTemporales(); recalcularDetalleFracc();
  const sels = document.querySelectorAll('#ftCuerpo .ft-peso');
  sels[sels.length - 1].focus();
}

function htmlFilaTemporal(t, i){
  const ops = PESOS_COMUNES.map(g => `<option value="${g}"${!t.otra && t.pesoG === g ? ' selected' : ''}>${etiquetaPesoCli(g)}</option>`).join('');
  return `<tr class="tmp border-t border-borde align-top" data-tmp="${i}">
    <td class="py-2.5 pr-2 text-gris text-xs"><span aria-hidden="true">—</span></td>
    <td class="py-2 pr-3"><div class="flex items-center gap-1.5 flex-wrap">
        ${chip('Temporal', 'bg-amarillo/30 text-ink')}
        <select class="ft-peso num-in" style="text-align:left" aria-label="Peso de la presentación simulada ${i + 1}">
          <option value=""${t.pesoG == null && !t.otra ? ' selected' : ''}>Elegí…</option>${ops}<option value="otra"${t.otra ? ' selected' : ''}>Otra…</option></select>
        <span class="ft-otra-box${t.otra ? '' : ' hidden'} text-gris text-xs whitespace-nowrap"><input type="number" min="1" max="100000" step="any" inputmode="decimal"
          aria-label="Gramos de la presentación simulada ${i + 1}" class="ft-otra num-in w-20 text-ink" value="${t.otra ? esc(t.pesoG ?? '') : ''}"> g</span></div>
      ${t.nombre ? `<div class="text-[11px] text-gris mt-0.5">${esc(t.nombre)}</div>` : ''}</td>
    <td class="py-2 pr-3 whitespace-nowrap"><div class="flex items-center justify-end gap-1 text-gris">
        <input type="number" step="any" min="-99" max="1000" inputmode="decimal" aria-label="Margen % de la presentación simulada ${i + 1}" class="ft-margen w-16 num-in text-ink" value="${esc(t.markupPct ?? '')}">%
        <button type="button" class="ft-reset w-6 h-6 rounded text-verde hover:bg-verde/10" aria-label="Volver al margen standard" title="Volver al margen standard">↺</button></div>
      <div class="ft-std text-[11px] text-gris text-right pr-7"></div></td>
    <td class="py-2.5 pr-3 text-right tabular-nums"><div class="ft-final"></div><div class="ft-neto text-[11px] text-gris"></div></td>
    <td class="hidden sm:table-cell py-2.5 pr-3 text-right text-gris">—</td>
    <td class="py-2 text-right"><button type="button" class="ft-quitar w-7 h-7 rounded-lg text-gris hover:text-crit hover:bg-crit/10" aria-label="Quitar presentación simulada ${i + 1}" title="Quitar">✕</button></td>
  </tr>`;
}

// Editar actualiza tmpEdit sin re-dibujar (no se pierde el foco); agregar/quitar/descartar re-dibuja.
function pintarTemporales(){
  const cuerpo = document.getElementById('ftCuerpo');
  cuerpo.innerHTML = tmpEdit.length
    ? '<tr><td colspan="6" class="pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-warn">Simuladas · sin código en SIGA</td></tr>'
      + tmpEdit.map(htmlFilaTemporal).join('') : '';
  const editar = (i, cambio) => { tmpEdit = tmpEdit.map((t, k) => (k === i ? { ...t, ...cambio } : t)); recalcularDetalleFracc(); };
  cuerpo.querySelectorAll('tr[data-tmp]').forEach(tr => {
    const i = Number(tr.dataset.tmp);
    const sel = tr.querySelector('.ft-peso'), otra = tr.querySelector('.ft-otra'), margen = tr.querySelector('.ft-margen');
    sel.addEventListener('change', () => {
      const esOtra = sel.value === 'otra';
      tr.querySelector('.ft-otra-box').classList.toggle('hidden', !esOtra);
      editar(i, { otra: esOtra, pesoG: esOtra ? numOrNull(otra.value) : numOrNull(sel.value) });
      if (esOtra) otra.focus();
    });
    otra.addEventListener('input', () => editar(i, { pesoG: numOrNull(otra.value) }));
    margen.addEventListener('input', () => editar(i, { markupPct: numOrNull(margen.value) }));
    tr.querySelector('.ft-reset').onclick = () => { margen.value = ''; editar(i, { markupPct: null }); margen.focus(); };
    tr.querySelector('.ft-quitar').onclick = () => {
      tmpEdit = tmpEdit.filter((_, k) => k !== i); pintarTemporales(); recalcularDetalleFracc();
      document.getElementById('ftAgregar').focus();
    };
  });
  document.getElementById('ftAgregar').disabled = tmpEdit.length >= TEMPORALES_MAX;
}

// Precio en vivo de cada simulada: mismo cálculo que una real, sin vigente (no hay Δ ni semáforo).
function recalcularTemporales(costo, costoTotal){
  document.querySelectorAll('#ftCuerpo tr[data-tmp]').forEach(tr => {
    const t = tmpEdit[Number(tr.dataset.tmp)];
    const conPeso = t.pesoG > 0;
    const std = conPeso ? markupStdCliente(costo, t.pesoG) : null;
    const input = tr.querySelector('.ft-margen');
    input.placeholder = std ?? '—';
    input.title = `Vacío = margen standard (${std ?? '—'}%)`;
    tr.querySelector('.ft-std').textContent = !conPeso ? 'elegí el peso' : std == null ? 'sin standard' : `standard ${std}%`;
    tr.querySelector('.ft-reset').classList.toggle('invisible', t.markupPct == null);
    const c = conPeso ? calcularPresentacion(costoTotal, t.markupPct ?? std, null) : calcularPresentacion(null);
    tr.querySelector('.ft-neto').textContent = c.neto != null ? 'neto ' + fmtMoney(c.neto) : '';
    tr.querySelector('.ft-final').innerHTML = c.precio == null ? '<span class="text-gris">sin precio</span>'
      : `<b class="text-verde">$ ${fmtPrecio(c.precio)}</b>`;
  });
}

// ── Configuración: margen standard Fraccionado (bandas de costo × tramos de peso) ─
// Se dibuja en #configFraccionado cada vez que cargarConfiguracion() trae la config.
let mfEdit = null; // copia editable { bandas, tramosG, markupPct }

const inMf = (valor, cls, extra = '') =>
  `<input type="number" step="any" value="${esc(valor ?? '')}" class="${cls} w-20 ${inputCls}" ${extra}>`;

// Lee lo que hay en pantalla (para no perder ediciones al agregar/quitar una banda).
function leerMatrizFracc(){
  const filas = [...document.querySelectorAll('#mfFilas tr')];
  return {
    bandas: filas.map((tr, i) => i === filas.length - 1 ? null : numOrNull(tr.querySelector('.mf-hasta').value)),
    tramosG: [...document.querySelectorAll('.mf-tramo')].map(i => numOrNull(i.value)),
    markupPct: filas.map(tr => [...tr.querySelectorAll('.mf-celda')].map(i => numOrNull(i.value))),
  };
}

function pintarMatrizFracc(){
  const m = mfEdit;
  const ultima = m.bandas.length - 1;
  document.getElementById('mfTabla').innerHTML = `
    <thead class="text-ink/60"><tr>
      <th class="text-left font-normal pb-1 pr-2 whitespace-nowrap">Costo granel hasta ($/kg) \\ peso hasta (g)</th>
      ${m.tramosG.map(t => `<th class="pb-1 pr-1">${inMf(t, 'mf-tramo')}</th>`).join('')}<th></th></tr></thead>
    <tbody id="mfFilas">${m.bandas.map((b, i) => `<tr>
      <td class="pr-2 py-1">${i === ultima ? '<span class="text-gris text-xs">sin tope</span>' : inMf(b, 'mf-hasta w-28')}</td>
      ${m.tramosG.map((_, k) => `<td class="pr-1 py-1">${inMf((m.markupPct[i] || [])[k], 'mf-celda')}</td>`).join('')}
      <td>${m.bandas.length > 1 ? `<button class="mf-quitar text-crit hover:opacity-70 px-1" data-i="${i}" title="Quitar banda">✕</button>` : ''}</td>
    </tr>`).join('')}</tbody>`;
  document.querySelectorAll('.mf-quitar').forEach(btn => btn.onclick = () => {
    const actual = leerMatrizFracc();
    const i = Number(btn.dataset.i);
    const quitar = (arr) => arr.filter((_, k) => k !== i);
    const bandas = quitar(actual.bandas);
    bandas[bandas.length - 1] = null; // la última siempre es "sin tope"
    mfEdit = { ...actual, bandas, markupPct: quitar(actual.markupPct) };
    pintarMatrizFracc();
  });
}

function renderConfigFraccionado(cfg){
  const m = cfg.markupFraccionado || { bandas: [null], tramosG: [1000], markupPct: [[0]] };
  mfEdit = { bandas: [...m.bandas], tramosG: [...m.tramosG], markupPct: m.markupPct.map(f => [...f]) };
  document.getElementById('configFraccionado').innerHTML = `
    <div class="rounded-xl border border-borde shadow-fluent bg-card p-5 mt-5 w-fit max-w-full">
      <h2 class="font-disp text-lg font-bold text-verde mb-1">Margen standard Fraccionado</h2>
      <p class="text-xs text-ink/50 mb-4">Margen % según el costo del granel por kg (filas) y el peso de la presentación (columnas):
        se usa la primera banda con costo ≤ tope y la primera columna con peso ≤ tramo; más pesado que el último tramo → última
        columna; sin peso en el nombre → columna de 1 kg. Cada presentación puede tener su margen propio (detalle del granel).</p>
      <div class="overflow-x-auto"><table id="mfTabla" class="text-sm"></table></div>
      <button id="mfAgregar" class="mt-2 px-3 py-1 rounded-lg border border-borde text-xs hover:bg-white">+ Agregar banda</button>
      <div class="flex items-center gap-2 mt-3">
        <button id="mfGuardar" class="px-3 py-1.5 rounded-lg bg-verde text-white text-sm hover:bg-verdeHover">Guardar</button>
        <span id="mfMsg" class="text-sm"></span>
      </div>
    </div>`;
  pintarMatrizFracc();
  // Nueva banda antes de la "sin tope", copiando los márgenes de la anterior.
  document.getElementById('mfAgregar').onclick = () => {
    const a = leerMatrizFracc();
    const n = a.bandas.length;
    mfEdit = {
      ...a,
      bandas: [...a.bandas.slice(0, n - 1), null, null],
      markupPct: [...a.markupPct.slice(0, n - 1), [...a.markupPct[n - 1]], a.markupPct[n - 1]],
    };
    pintarMatrizFracc();
  };
  document.getElementById('mfGuardar').onclick = guardarMatrizFracc;
}

async function guardarMatrizFracc(){
  const msg = document.getElementById('mfMsg');
  msg.className = 'text-sm text-ink/50'; msg.textContent = 'Guardando…';
  try {
    const body = leerMatrizFracc();
    if (body.bandas.slice(0, -1).some(b => b == null)) throw new Error('Completá el costo "hasta" de todas las bandas (menos la última)');
    const j = await putJson('/api/precios/config/markup-fraccionado', body);
    mfEdit = j.markupFraccionado;
    configCargada = { ...configCargada, markupFraccionado: j.markupFraccionado };
    fraccCargado = false; // el listado se recalcula la próxima vez que se abre el tab
    msg.className = 'text-sm text-ok'; msg.textContent = 'Guardado.';
  } catch (e) {
    msg.className = 'text-sm text-crit'; msg.textContent = e.message;
  }
}


document.getElementById('btnRecargarFracc').onclick = cargarFraccionado;
document.getElementById('frBuscar').addEventListener('input', renderFraccionado);
document.getElementById('frIngresoHoy').onclick = () => { frIngresoHoy = !frIngresoHoy; dropCtxs.fracc.aplicar(); };
document.getElementById('frSoloMarcados').onclick = () => { frSoloMarcados = !frSoloMarcados; dropCtxs.fracc.aplicar(); };
document.getElementById('frOcultarVacios').onclick = () => { frOcultarVacios = !frOcultarVacios; dropCtxs.fracc.aplicar(); };
document.getElementById('frLimpiar').onclick = () => {
  filtroSelFr.proveedor.clear(); filtroSelFr.estado.clear();
  frIngresoHoy = false; frSoloMarcados = false; frOcultarVacios = false;
  document.getElementById('frBuscar').value = '';
  cerrarDrop(); dropCtxs.fracc.aplicar();
};
document.getElementById('chkTodosFr').onchange = async e => {
  const plus = filtrarFraccionado().flatMap(marcablesDe).map(p => p.plu);
  if (!plus.length) { renderFraccionado(); return; }
  try { await marcarPlus(plus, e.target.checked); } catch (err) { avisar(err.message); renderFraccionado(); }
};

// Se carga con la página (no sólo al abrir el tab): la barra de marcados y la exportación
// cuentan también las presentaciones marcadas de Fraccionado.
cargarFraccionado();
