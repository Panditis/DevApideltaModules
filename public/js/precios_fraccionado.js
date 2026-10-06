// ── Precios · tab Fraccionado (su configuración de margen standard está en precios_config_fraccionado.js) ─
// Script clásico cargado después de precios_almacen.js, precios_detalle.js y precios_config.js: reusa sus globales
// (esc, fmtMoney, fmtPrecio, fmtPct, chip, badgeSemaforo, claseDelta, tieneFaltantes, normTxt,
// numOrNull, r2, redondear50, inputCls, estadoDe, proveedorDe, opcionesFiltro, pintarBotonesFiltro,
// dropCtxs, marcarPlus, abrirModal, detalleListo, MSG_SIN_GUARDAR, htmlCostoBase, conectarCostoBase, pintarCostoBase,
// costoEfectivo, cambioCosto, msgDetalle, chipFuenteCosto, det/detEstado/detInicial, configCargada,
// y el bloque de costos extra compartido: htmlCostosExtra, iniciarCostosExtra, restaurarCostosExtra,
// pintarTotalesCostosExtra, cambioExtras, extrasValidos, itemsCostosExtra, tipCostoExtras, msgExtrasInvalidos).
// De precios_config_gastos.js (cargado al final, se usan recién al abrir un detalle): markupDesdeGananciaCli,
// fmtPctGastos — la curva + conceptos dan la ganancia standard (s/ costo real); el markup total sale con los gastos.
// Misma experiencia que Almacén: una fila por granel ('Pesables Deposito'); click → modal con el
// mismo selector de costo (sistema / última compra / manual, por PLU del granel) y la tabla de
// presentaciones con su margen (standard de la curva o propio) y precio. Todo POR KILO.
// Fórmula: docs/superpowers/plans/2026-09-24-precios-fase2-fraccionado.md

let fraccData = [];       // grupos del server: [{ granelPlu, granelNombre, costoBase, ..., presentaciones }]
let fraccTol = 0;         // toleranciaPct de la config, para el semáforo en vivo
let fraccCurva = null;    // curvaGanancia.fraccionado de la config: margen standard (siempre aplica)
let fraccCargado = false; // se carga al abrir la página; se invalida al cambiar config
let fraccCostoHora = 0;   // costoHora de la config: MO de fraccionado en vivo (sólo presentaciones con minutos propios)
let fraccGastos = 0;      // gastos sobre venta de Fraccionado (null = falta venta base): la curva guarda ganancia → markup total
let fraccConceptos = [];  // conceptos de ganancia de la config (se suman a la curva; no con ganancia propia)
let fraccIva = 21;        // IVA de venta de la config (temporales; las reales lo traen del server)
let fraccConceptosFinal = []; // conceptos sobre precio final de la config (gross-up después del IVA)

const FALTA_TXT = { granel: 'Sin granel asignado', costoGranel: 'Sin costo de granel', markupPct: 'Sin margen', pesoMo: 'Sin peso en el nombre para MO/insumos' };

// MO e insumos $/kg con el costo hora de la config (moKgCli/insKgCli en precios_orden.js). null = falta el peso.
const moKgCliente = (minutos, pesoG) => moKgCli(fraccCostoHora, minutos, pesoG);
const insKgCliente = insKgCli;
// Costo $/kg de la presentación = costo total del granel + MO + insumos (espejo de costosPresentacion).
const sumarMo = (costoTotal, moKg, insKg = 0) => (costoTotal == null || moKg == null || insKg == null ? null : r2(costoTotal + moKg + insKg));
const textoMo = moKg => (moKg == null ? 'sin peso' : moKg > 0 ? `+${fmtMoney(moKg)}/kg` : '');
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

// Misma fórmula que el backend (armarGruposFraccionado → costearFraccionado): precio neto /kg = costo neto ×
// (1 + markup) = costo real × (1 + ganancia), + IVA de venta (iva = { ivaPct }), ÷ (1 − F) (conceptos sobre precio
// final, fraccConceptosFinal), redondeado a $50 salvo que
// reproduzca el vigente de SIGA (alineado exacto) — desgloseCli en precios_orden.js. d = desglose para el modal;
// conceptos = conceptos de ganancia aplicados ([] con ganancia propia).
let fraccGastosDes = { variablesPct: 0, departamentosPct: 0 }; // gastos de Fraccionado partidos (desglose)
function calcularPresentacion(costoKg, markup, vigente, iva = {}, conceptos = []){
  if (!(costoKg > 0) || markup == null || markup <= -100) return { neto: null, precio: null, deltaPct: null, semaforo: null, d: null };
  const d = desgloseCli({ costo: costoKg, markup, gastos: fraccGastosDes, ivaPct: iva.ivaPct, conceptos, conceptosFinal: fraccConceptosFinal, vigente });
  const neto = d.precioNeto, precio = d.precioFinal;
  if (!(vigente > 0)) return { neto, precio, deltaPct: null, semaforo: null, d };
  const deltaPct = +(((precio - vigente) / vigente) * 100).toFixed(1);
  const semaforo = Math.abs(deltaPct) <= fraccTol ? 'ok' : deltaPct > 0 ? 'subir' : 'bajar';
  return { neto, precio, deltaPct, semaforo, d };
}
// IVA de las temporales (sin PLU): el IVA de venta de la config, como el server.
const ivaGranelDet = () => ({ ivaPct: fraccIva });

// Ganancia standard (espejo de stdFraccionado en routes/rutas_precios.js): curva de Fraccionado sobre el costo base
// NETO del granel ($/kg) + ajuste del tramo de peso (sin peso → 1 kg; más pesado que el último → último) + conceptos.
const gananciaCurvaCliente = (costoNetoKg, pesoG) => gananciaPorCurvaCliente(fraccCurva, costoNetoKg, pesoG);
function gananciaStdCliente(costoNetoKg, pesoG){
  const c = gananciaCurvaCliente(costoNetoKg, pesoG);
  return c == null ? null : +(c + totalConceptosCli(fraccConceptos)).toFixed(6); // precios_orden.js
}
// Ganancia (propia o standard) → markup total con los gastos de Fraccionado.
const markupDeGananciaFr = g => markupDesdeGananciaCli(g, fraccGastos);
// Leyenda del standard: "standard 22,5 %" y en title curva + conceptos y el markup.
function pintarStd(el, costoKg, pesoG, std, conPropio){
  el.textContent = std == null ? 'sin standard' : conPropio ? `standard ${fmtPctGastos(std)}` : 'standard';
  el.title = std == null || preciosSinConfig ? '' // sin el permiso, std ya es el markup s/ neto
    : `curva ${fmtPctGastos(gananciaCurvaCliente(costoKg, pesoG))} + conceptos ${fmtPctGastos(totalConceptosCli(fraccConceptos))} · markup s/ neto ${fmtPctGastos(markupDeGananciaFr(std))}`;
}

// ── Marcados (mapa único por PLU con Almacén; lo usan la barra y la exportación de precios.html) ──
function aplicarMarcadosFracc(set){
  fraccData = fraccData.map(g => ({
    ...g, presentaciones: g.presentaciones.map(p => ({ ...p, marcado: set.has(p.plu), packBulto: aplicarMarcadosPB(p.packBulto, set) })),
  }));
}
// Filas para exportarMarcados/filasExportacion: Costo = costo total $/kg del granel (base +
// costos extra), Venta = precio /kg.
function presentacionesMarcadas(){
  return fraccData.flatMap(g => g.presentaciones.filter(p => p.marcado).map(p => ({
    plu: p.plu, nombre: p.nombre, costoTotal: p.costoKg ?? g.costoTotal, precioConIva: p.precioConIva, faltantes: p.faltantes, ivaPct: p.ivaPct,
  })));
}

// ── Listado ──────────────────────────────────────────────────────────────────
async function cargarFraccionado(){
  const tbody = document.getElementById('cuerpoFracc');
  tbody.innerHTML = '<tr><td colspan="10" class="p-10 text-center text-ink/50"><span class="spin"></span> Cargando…</td></tr>';
  try {
    const [rl, rc] = await Promise.all([fetch('/api/precios/listado?tipo=fraccionado'), fetchConfigPrecios()]);
    const j = await rl.json(), c = await rc.json();
    if (j.error) throw new Error(j.error);
    if (c.error) throw new Error(c.error);
    fraccData = j;
    fraccTol = Number(c.toleranciaPct) || 0;
    fraccCurva = (c.curvaGanancia || c.curvaMarkup || {}).fraccionado || null; // curvaMarkup: config pública (sin permiso)
    fraccGastosDes = gastosDesgloseCli(c, 'fraccionado'); // precios_orden.js
    document.getElementById('frTolerancia').value = c.toleranciaPct;
    fraccCargado = true;
    const graneles = j.filter(esGranel);
    const nPres = j.reduce((n, g) => n + g.presentaciones.length, 0);
    document.getElementById('fraccMeta').textContent = `${graneles.length} graneles · ${nPres} presentaciones · precios por kg`;
    renderFraccionado();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="10" class="p-8 text-center text-crit">No se pudo cargar: ${esc(e.message)}</td></tr>`;
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
    [['frIngresoHoy', frIngresoHoy], ['frSoloMarcados', frSoloMarcados], ['frOcultarVacios', frOcultarVacios], ['frConPB', frConPB]]);
}

// El grupo "Sin granel asignado" sólo se muestra sin filtros activos (no tiene costo ni proveedor).
function filtrarFraccionado(){
  const q = normTxt(document.getElementById('frBuscar').value.trim());
  const { proveedor, estado } = filtroSelFr;
  const hayFiltros = q || proveedor.size || estado.size || frIngresoHoy || frSoloMarcados || frConPB;
  return fraccData.filter(g => {
    if (!esGranel(g)) return !hayFiltros && g.presentaciones.length > 0;
    if (q && !String(g.granelPlu).includes(q) && !normTxt(g.granelNombre).includes(q)
      && !g.presentaciones.some(p => String(p.plu).includes(q) || normTxt(p.nombre).includes(q))) return false;
    if (proveedor.size && !proveedor.has(proveedorDe(g))) return false;
    if (estado.size && !estado.has(estadoGrupo(g))) return false;
    if (frIngresoHoy && !g.ingresoHoy) return false;
    if (frSoloMarcados && !g.presentaciones.some(p => p.marcado)) return false;
    if (frOcultarVacios && !g.presentaciones.length) return false;
    if (frConPB && !g.presentaciones.some(conPB) && !conPB({ packBulto: g.packBultoGranel })) return false; // precios_pack_bulto.js
    return true;
  });
}

function htmlFilaGranel(g){
  const n = g.presentaciones.length;
  if (!esGranel(g)) {
    const nombres = g.presentaciones.map(p => `${p.plu} ${p.nombre}`).join('\n');
    return `<tr class="border-t border-borde opacity-60" title="${esc(nombres)}">
      <td class="p-2"></td><td class="p-2">—</td>
      <td class="p-2" colspan="8">${esc(g.granelNombre)} · ${n} presentaci${n === 1 ? 'ón' : 'ones'} sin granel en la fórmula (Pesables): sin precio</td></tr>`;
  }
  const m = marcablesDe(g);
  const nMarc = m.filter(p => p.marcado).length;
  const nTmp = (g.temporales || []).length;
  const peor = peorPresentacion(g);
  const estado = peor ? estadoDe(peor) : null;
  const badge = estado === 'sinPrecio' ? chip('Sin precio', 'bg-ink/10 text-ink/60') : badgeSemaforo(peor && peor.semaforo);
  const extras = g.costosExtra || [];
  const tipCosto = tipCostoExtras(g, '$/kg');
  const costo = g.costoBase == null ? '<span class="text-crit text-xs">sin costo</span>'
    : chipFuenteCosto(g.costoFuente) + fmtMoney(g.costoTotal) + (extras.length ? ' <span class="text-[10px] text-gris">+extras</span>' : '');
  const tipCompra = `Proveedor: ${g.proveedor || '—'} · Última compra: ${g.fechaUltimaCompra || '—'}`;
  const badgeHoy = g.ingresoHoy ? ' ' + BADGE_INGRESO_HOY : ''; // precios_almacen.js
  const filaCls = (n ? 'hover:bg-verde/5' : 'text-ink/60 hover:bg-verde/5') + (nMarc ? ' bg-amarillo/10' : '');
  return `<tr class="border-t border-borde cursor-pointer ${filaCls}" data-granel="${esc(g.granelPlu)}">
    <td class="p-2 text-center"><input type="checkbox" class="chk-granel accent-verde" data-granel="${esc(g.granelPlu)}"${m.length && nMarc === m.length ? ' checked' : ''}${m.length ? '' : ' disabled title="Sin presentaciones con precio sugerido"'}></td>
    <td class="p-2">${esc(g.granelPlu)}</td>
    <td class="p-2" title="${esc(tipCompra)}">${esc(g.granelNombre)}${badgeHoy}</td>
    <td class="p-2 text-right whitespace-nowrap"${tipCosto ? ` title="${esc(tipCosto)}"` : ''}>${costo}</td>
    ${htmlCeldaCostoSistema(g)}${htmlCeldaUltimaCompra(g, fraccTol)}
    <td class="p-2 text-center" title="${esc(g.presentaciones.map(p => p.nombre).join('\n'))}">${n || '<span class="text-ink/40">0</span>'}${nTmp ? ' ' + chip(`+${nTmp} temp.`, 'bg-amarillo/30 text-ink') : ''}</td>
    ${htmlFechaPrecio(g.presentaciones.map(p => p.fechaPrecio))}
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
    tbody.innerHTML = '<tr><td colspan="10" class="p-10 text-center text-ink/50">Sin graneles</td></tr>';
    return;
  }
  const grupos = ordenarGruposFracc(filtrarFraccionado()); // precios_orden.js
  conteo.textContent = `${grupos.filter(esGranel).length} de ${total} graneles`;
  if (!grupos.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="p-10 text-center text-ink/50">Ningún granel coincide con los filtros</td></tr>';
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
      fetchConfigPrecios(), // precios_almacen.js: sin el permiso, la config pública (markup s/ neto, gastos 0)
    ]);
    const j = await rd.json(), c = await rc.json();
    if (j.error) throw new Error(j.error);
    if (c.error) throw new Error(c.error);
    det = j;
    fraccTol = Number(c.toleranciaPct) || 0;
    fraccCurva = (c.curvaGanancia || c.curvaMarkup || {}).fraccionado || null;
    fraccCostoHora = Number(c.costoHora) || 0;
    fraccGastos = gastosTipoCli(c, 'fraccionado', j); // precios_config_gastos.js (null = falta venta base)
    fraccGastosDes = gastosDesgloseCli(c, 'fraccionado'); // precios_orden.js
    fraccConceptos = conceptosCli(c); fraccIva = ivaVentaCli(c); fraccConceptosFinal = conceptosFinalCli(c); // precios_orden.js
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
    <td class="py-2.5 pr-3 break-words"><div class="font-medium">${esc(p.nombre)}${p.ventaDirecta ? ' ' + chip('Venta directa', 'bg-verde/10 text-verde') : ''}</div>
      <div class="text-[11px] text-gris">PLU ${esc(p.plu)}${falta ? ` · <span class="text-crit">${esc(falta)}</span>` : ''}</div>
      ${p.plu === det.granelPlu ? '<div class="text-[11px] text-gris mt-1">es su propio granel · sin fraccionado</div>'
        : `<div class="mt-1 flex items-center gap-1 text-[11px] text-gris">MO
        <input type="number" step="any" min="0" max="600" inputmode="decimal" aria-label="Minutos de fraccionado por unidad de ${esc(p.nombre)}" class="fd-min w-14 num-in text-ink" title="Vacío = sin valor propio: no suma mano de obra" value="${esc(p.minutosOverride ?? '')}"> min
        <span class="fd-mo tabular-nums"></span></div>
        <div class="mt-1 flex items-center gap-1 text-[11px] text-gris">Insumos $
        <input type="number" step="any" min="0" max="10000000" inputmode="decimal" aria-label="Insumos de fraccionado en $ por unidad de ${esc(p.nombre)}" class="fd-ins w-16 num-in text-ink" title="Vacío = sin valor propio: no suma insumos" value="${esc(p.insumosOverride ?? '')}"> /u
        <span class="fd-insk tabular-nums"></span></div>`}</td>
    <td class="py-2 pr-3 whitespace-nowrap"><div class="flex items-center justify-end gap-1 text-gris">
        <input type="number" step="any" min="-99" max="1000" inputmode="decimal" aria-label="${segunPermiso('Ganancia', 'Markup')} % de ${esc(p.nombre)}" class="fd-margen w-16 num-in text-ink" value="${esc(p.gananciaOverride ?? '')}">%
        <button type="button" class="fd-reset w-6 h-6 rounded text-verde hover:bg-verde/10" aria-label="Volver al standard" title="Volver al standard">↺</button></div>
      <div class="fd-std text-[11px] text-gris text-right pr-7"></div></td>
    <td class="py-2.5 pr-3 text-right tabular-nums"><div class="fd-final"></div><div class="fd-neto text-[11px] text-gris"></div>
      <button type="button" class="fd-ver-des text-[11px] text-verde underline underline-offset-2 hover:text-verdeHover" aria-expanded="false">desglose</button></td>
    <td class="hidden sm:table-cell py-2.5 pr-3 text-right tabular-nums text-gris">${fmtMoney(p.precioVigente)}</td>
    ${htmlFechaPrecio(p.fechaPrecio, 'hidden sm:table-cell py-2.5 pr-3')}
    <td class="py-2.5 text-right whitespace-nowrap"><div class="fd-delta tabular-nums"></div><div class="fd-estado mt-0.5"></div>
      <div class="sm:hidden text-[11px] text-gris tabular-nums">vig. ${fmtPrecio(p.precioVigente)}</div></td>
  </tr>
  <tr class="fd-des-tr hidden" data-des-pres="${esc(p.plu)}"><td colspan="7" class="pb-3 px-2"><div class="fd-des-body max-w-lg ml-auto"></div></td></tr>`
    + htmlSubfilasFraccPB(p); // sub-filas ↳ pack/bulto (precios_pack_bulto.js)
}

function htmlDetalleFracc(j){
  const filas = j.presentaciones.length ? ordenarPresFracc(j.presentaciones).map(htmlFilaPresentacionDet).join('')
    : '<tr><td colspan="7" class="py-6 text-center text-gris">Este granel no tiene presentaciones asociadas (fórmulas de Pesables)</td></tr>';
  const th = (txt, cls = 'text-right', orden = '') => `<th scope="col"${orden ? ` data-orden="${orden}"` : ''} class="pb-1.5 pr-3 font-semibold text-[11px] text-gris ${cls}">${txt}</th>`;
  return `
    <div class="mt-1" role="group" aria-label="Costo del granel">
      ${htmlCostoBase(j, '$/kg')}
      ${htmlCostosExtra('$/kg', '$/kg = monto fijo por kilo; % = sobre el costo base. El margen standard se busca con el costo base.')}
    </div>

    <div class="mt-5 mb-1.5">
      <h4 class="lbl sec-tit s-final">Presentaciones · precio por kg</h4>
      <p class="text-[11px] text-gris">${segunPermiso('Costo real (costo neto ÷ (1 − gastos)) × (1 + ganancia) = precio neto, + IVA de venta, ÷ (1 − conceptos s/ precio final), redondeo a $50 · ganancia vacía = standard (curva + conceptos)',
        'Costo neto × (1 + markup) = precio neto, + IVA de venta, ÷ (1 − impuestos s/ precio final), redondeo a $50 · markup vacío = standard')}</p>
    </div>
    <div class="overflow-x-auto rounded-lg border border-borde">
      <table class="w-full text-sm">
        <thead class="bg-verde/5"><tr class="border-b border-borde">
          ${th('<span class="sr-only">Exportar a SIGA</span>✓', 'text-left w-6 pl-2 pt-1.5')}${th('Presentación', 'text-left pt-1.5', 'peso')}${th(segunPermiso('Ganancia', 'Markup'), 'text-right pt-1.5', 'margen')}
          ${th('Precio final /kg', 'text-right pt-1.5', 'final')}${th('Vigente', 'text-right hidden sm:table-cell pt-1.5', 'vigente')}${th('Act. precio', 'text-center hidden sm:table-cell pt-1.5', 'fecha')}${th('Δ', 'text-right pt-1.5 !pr-0 sm:!pr-2', 'delta')}</tr></thead>
        <tbody class="fd-cuerpo">${filas}</tbody>
        <tbody id="ftCuerpo" class="fd-cuerpo"></tbody>
      </table>
    </div>
    <div class="mt-2 flex items-baseline gap-2 flex-wrap">
      <button type="button" id="ftAgregar" class="text-xs font-semibold text-verde hover:text-verdeHover disabled:opacity-40">+ Simular presentación</button>
      <span class="text-[11px] text-gris">peso sin código en SIGA · no se marca ni se exporta</span></div>
    ${htmlBloquePBGranel(j.packBultoGranel)}`; // precios_pack_bulto.js
}

const filasDetFracc = () => [...document.querySelectorAll('#mDetBody tr[data-plu]')]
  .map(tr => ({ tr, p: det.presentaciones.find(x => x.plu === tr.dataset.plu) }));

function conectarDetalleFracc(){
  conectarCostoBase(recalcularDetalleFracc);
  for (const { tr } of filasDetFracc()) {
    const input = tr.querySelector('.fd-margen');
    input.addEventListener('input', recalcularDetalleFracc);
    tr.querySelector('.fd-min')?.addEventListener('input', recalcularDetalleFracc);
    tr.querySelector('.fd-ins')?.addEventListener('input', recalcularDetalleFracc);
    tr.querySelector('.fd-reset').onclick = () => { input.value = ''; recalcularDetalleFracc(); input.focus(); };
    const verDes = tr.querySelector('.fd-ver-des');
    verDes.onclick = () => {
      const fila = document.querySelector(`#mDetBody tr[data-des-pres="${CSS.escape(tr.dataset.plu)}"]`);
      const abrir = fila.classList.contains('hidden');
      fila.classList.toggle('hidden', !abrir);
      verDes.setAttribute('aria-expanded', String(abrir));
    };
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
    for (const { tr, p } of filasDetFracc()) {
      tr.querySelector('.fd-margen').value = p.gananciaOverride ?? '';
      const min = tr.querySelector('.fd-min');
      if (min) min.value = p.minutosOverride ?? '';
      const ins = tr.querySelector('.fd-ins');
      if (ins) ins.value = p.insumosOverride ?? '';
    }
    restaurarCostosExtra(det.costosExtra);
    restaurarTemporales();
    descartarPB(document.getElementById('mDetBody'), itemFraccPB); // precios_pack_bulto.js
    msgDetalle(''); recalcularDetalleFracc();
  };
  document.getElementById('ftAgregar').onclick = agregarTemporal;
  conectarSubfilasFraccPB(); // precios_pack_bulto.js
  montarOrdenPresFracc(); // precios_orden.js
  document.getElementById('btnGuardarDet').onclick = guardarDetalleFracc;
}

// MO e insumos de una fila del detalle: valores propios (vacío = sin valor propio: no suma); la fila del
// propio granel no los lleva (sin inputs → 0). Devuelve $/kg de cada uno (null = falta el peso) y cuántos cambiaron.
function costosFraccFila(tr, p){
  const inMin = tr.querySelector('.fd-min'), inIns = tr.querySelector('.fd-ins');
  if (!inMin) return { moKg: 0, insKg: 0, cambios: 0 };
  const minPropio = numOrNull(inMin.value), insPropio = numOrNull(inIns.value);
  const moKg = moKgCliente(minPropio ?? 0, p.pesoG);
  const insKg = insKgCliente(insPropio ?? 0, p.pesoG);
  tr.querySelector('.fd-mo').textContent = textoMo(moKg);
  tr.querySelector('.fd-insk').textContent = textoMo(insKg);
  const cambios = (minPropio !== (p.minutosOverride ?? null)) + (insPropio !== (p.insumosOverride ?? null));
  return { moKg, insKg, cambios };
}

// Recalcula en vivo: el margen standard depende del costo elegido (curva por costo base neto + tramo de
// peso); el precio se calcula sobre el costo total (base + costos extra).
function recalcularDetalleFracc(){
  const costo = pintarCostoBase();
  const costoTotal = pintarTotalesCostosExtra(costo);
  let margenesCambiados = 0;
  for (const { tr, p } of filasDetFracc()) {
    const input = tr.querySelector('.fd-margen');
    const std = gananciaStdCliente(costo, p.pesoG);
    const propio = numOrNull(input.value);
    if (propio !== (p.gananciaOverride ?? null)) margenesCambiados++;
    pintarStd(tr.querySelector('.fd-std'), costo, p.pesoG, std, propio != null);
    input.placeholder = std == null ? '—' : r2(std);
    input.title = `Vacío = standard (${fmtPctGastos(std)})`;
    tr.querySelector('.fd-reset').classList.toggle('invisible', propio == null);
    const extra = costosFraccFila(tr, p);
    margenesCambiados += extra.cambios;
    const c = p.faltantes.includes('granel') ? calcularPresentacion(null)
      : calcularPresentacion(sumarMo(costoTotal, extra.moKg, extra.insKg), markupDeGananciaFr(propio ?? std), p.precioVigente, p,
        propio != null ? [] : fraccConceptos);
    tr.querySelector('.fd-neto').textContent = c.d ? `${segunPermiso(`real ${fmtMoney(c.d.costoReal)} · `, '')}neto ${fmtMoney(c.neto)} · IVA ${pctD(c.d.ivaPct)}` : '';
    const desBody = document.querySelector(`#mDetBody tr[data-des-pres="${CSS.escape(p.plu)}"] .fd-des-body`);
    if (desBody) desBody.innerHTML = htmlDesglose(c.d, '$/kg', propio != null); // precios_detalle.js
    tr.querySelector('.fd-final').innerHTML = c.precio == null ? '<span class="text-gris">sin precio</span>'
      : `<b class="text-verde">$ ${fmtPrecio(c.precio)}</b>`;
    const td = tr.querySelector('.fd-delta');
    td.className = 'fd-delta tabular-nums ' + claseDelta(c.semaforo);
    td.textContent = fmtPct(c.deltaPct);
    tr.querySelector('.fd-estado').innerHTML = c.precio == null ? chip('Sin precio', 'bg-ink/10 text-ink/60')
      : p.precioVigente == null ? '<span class="text-[11px] text-gris">sin vigente</span>' : badgeSemaforo(c.semaforo);
    pintarSubfilasFraccPB(p, c.precio); // precios_pack_bulto.js: en vivo sobre el precio /kg
  }
  recalcularTemporales(costo, costoTotal);
  pintarGranelPB(); // precios_pack_bulto.js
  const costoOk = costo != null && costo > 0;
  // Pack/bulto (% propio, modo/peso) cuenta como cambio del modal y se guarda con el mismo Guardar.
  const hayCambios = cambioCosto() || margenesCambiados > 0 || cambioExtras() || cambioTemporales() || hayCambiosPB();
  const extrasOk = extrasValidos();
  const tmpOk = temporalesValidas();
  document.getElementById('btnGuardarDet').disabled = !(hayCambios && extrasOk && tmpOk && validosPB() && (costoOk || !cambioCosto()));
  document.getElementById('btnDescartar').disabled = !hayCambios;
  if (cambioCosto() && !costoOk) msgDetalle('Completá el costo base para calcular.', true);
  else if (!extrasOk) msgDetalle(msgExtrasInvalidos(), true);
  else if (!validosPB()) msgDetalle(MSG_PESO_PB, true);
  else if (!tmpOk) msgDetalle(`Presentación simulada: elegí el peso (1 a 100.000 g); ${segunPermiso('ganancia', 'markup')} de −99 a 1000 % o vacío = standard.`, true);
  else if (hayCambios) msgDetalle(MSG_SIN_GUARDAR, false, 'text-warn');
  else msgDetalle('');
}

// Guarda sólo lo que cambió: costo del granel (PUT costo-producto), costos extra (PUT costos-extra,
// lista completa; [] los borra), ganancia propia de cada presentación cambiada (PUT margen-producto;
// null = volver al standard) y pack/bulto pendientes (% propio, modo/peso).
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
    if (valor !== (p.gananciaOverride ?? null)) tareas.push(putJson('/api/precios/margen-producto/' + encodeURIComponent(p.plu), { gananciaPct: valor }));
    const inMin = tr.querySelector('.fd-min');
    const minutos = inMin ? numOrNull(inMin.value) : null;
    if (inMin && minutos !== (p.minutosOverride ?? null)) {
      tareas.push(putJson('/api/precios/minutos-fraccionado/' + encodeURIComponent(p.plu), { minutos }));
    }
    const inIns = tr.querySelector('.fd-ins');
    const pesos = inIns ? numOrNull(inIns.value) : null;
    if (inIns && pesos !== (p.insumosOverride ?? null)) {
      tareas.push(putJson('/api/precios/insumos-fraccionado/' + encodeURIComponent(p.plu), { pesos }));
    }
  }
  tareas.push(...tareasTemporales());
  tareas.push(guardarPendientesPB()); // precios_pack_bulto.js: los que fallen quedan pendientes
  document.getElementById('btnGuardarDet').disabled = true;
  msgDetalle('Guardando…', false, 'text-gris');
  try {
    await Promise.all(tareas);
    await abrirDetalleFracc(det.granelPlu);
    msgDetalle('Guardado.');
    cargarFraccionado();
    refrescarAlertasProduccion(); // precios_produccion.js: el granel puede ser materia prima de Producción
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
let tmpEdit = []; // [{ id, pesoG, gananciaPct, nombre, otra }] — id 'n…' = todavía no guardada
let tmpSeq = 0;
const claveTmp = t => JSON.stringify([t.pesoG, t.gananciaPct]);
const inicialesTmp = () => (det.temporales || []).map(t => ({ id: t.id, pesoG: t.pesoG, gananciaPct: t.gananciaOverride ?? null, nombre: t.nombre }));
const cambiadaTmp = (ini, t) => { const o = ini.find(x => x.id === t.id); return !o || claveTmp(o) !== claveTmp(t); };
function cambioTemporales(){
  const ini = inicialesTmp();
  return ini.length !== tmpEdit.length || tmpEdit.some(t => cambiadaTmp(ini, t));
}
// Mismos límites que validarPresentacionTemporal (lib/precios_costeo.js); el server valida igual.
const temporalesValidas = () => tmpEdit.every(t => t.pesoG >= 1 && t.pesoG <= 100000
  && (t.gananciaPct == null || (t.gananciaPct >= -99 && t.gananciaPct <= 1000)));

function tareasTemporales(){
  const base = '/api/precios/presentaciones-temporales/' + encodeURIComponent(det.granelPlu);
  const ini = inicialesTmp();
  const body = t => ({ pesoG: t.pesoG, gananciaPct: t.gananciaPct });
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
  tmpEdit = [...tmpEdit, { id: 'n' + (++tmpSeq), pesoG: null, gananciaPct: null, nombre: null, otra: false }];
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
        <input type="number" step="any" min="-99" max="1000" inputmode="decimal" aria-label="${segunPermiso('Ganancia', 'Markup')} % de la presentación simulada ${i + 1}" class="ft-margen w-16 num-in text-ink" value="${esc(t.gananciaPct ?? '')}">%
        <button type="button" class="ft-reset w-6 h-6 rounded text-verde hover:bg-verde/10" aria-label="Volver al standard" title="Volver al standard">↺</button></div>
      <div class="ft-std text-[11px] text-gris text-right pr-7"></div></td>
    <td class="py-2.5 pr-3 text-right tabular-nums"><div class="ft-final"></div><div class="ft-neto text-[11px] text-gris"></div></td>
    <td class="hidden sm:table-cell py-2.5 pr-3 text-right text-gris">—</td>
    <td class="hidden sm:table-cell py-2.5 pr-3 text-center text-gris">—</td>
    <td class="py-2 text-right"><button type="button" class="ft-quitar w-7 h-7 rounded-lg text-gris hover:text-crit hover:bg-crit/10" aria-label="Quitar presentación simulada ${i + 1}" title="Quitar">✕</button></td>
  </tr>`;
}

// Editar actualiza tmpEdit sin re-dibujar (no se pierde el foco); agregar/quitar/descartar re-dibuja.
function pintarTemporales(){
  const cuerpo = document.getElementById('ftCuerpo');
  cuerpo.innerHTML = tmpEdit.length
    ? '<tr><td colspan="7" class="pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-warn">Simuladas · sin código en SIGA</td></tr>'
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
    margen.addEventListener('input', () => editar(i, { gananciaPct: numOrNull(margen.value) }));
    tr.querySelector('.ft-reset').onclick = () => { margen.value = ''; editar(i, { gananciaPct: null }); margen.focus(); };
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
    const std = conPeso ? gananciaStdCliente(costo, t.pesoG) : null;
    const input = tr.querySelector('.ft-margen');
    input.placeholder = std == null ? '—' : r2(std);
    input.title = `Vacío = standard (${fmtPctGastos(std)})`;
    const stdEl = tr.querySelector('.ft-std');
    if (conPeso) pintarStd(stdEl, costo, t.pesoG, std, true); else { stdEl.textContent = 'elegí el peso'; stdEl.title = ''; }
    tr.querySelector('.ft-reset').classList.toggle('invisible', t.gananciaPct == null);
    // Temporales: sin PLU no hay MO ni insumos propios → no suman.
    const c = conPeso ? calcularPresentacion(sumarMo(costoTotal, 0), markupDeGananciaFr(t.gananciaPct ?? std), null, ivaGranelDet(),
      t.gananciaPct != null ? [] : fraccConceptos) : calcularPresentacion(null);
    tr.querySelector('.ft-neto').textContent = c.neto != null ? `${segunPermiso(`real ${fmtMoney(c.d.costoReal)} · `, '')}neto ${fmtMoney(c.neto)}` : '';
    tr.querySelector('.ft-final').innerHTML = c.precio == null ? '<span class="text-gris">sin precio</span>'
      : `<b class="text-verde">$ ${fmtPrecio(c.precio)}</b>`;
  });
}


document.getElementById('btnRecargarFracc').onclick = cargarFraccionado;
document.getElementById('frBuscar').addEventListener('input', renderFraccionado);
document.getElementById('frIngresoHoy').onclick = () => { frIngresoHoy = !frIngresoHoy; dropCtxs.fracc.aplicar(); };
document.getElementById('frSoloMarcados').onclick = () => { frSoloMarcados = !frSoloMarcados; dropCtxs.fracc.aplicar(); };
document.getElementById('frOcultarVacios').onclick = () => { frOcultarVacios = !frOcultarVacios; dropCtxs.fracc.aplicar(); };
document.getElementById('frLimpiar').onclick = () => {
  filtroSelFr.proveedor.clear(); filtroSelFr.estado.clear();
  frIngresoHoy = false; frSoloMarcados = false; frOcultarVacios = false; frConPB = false;
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
