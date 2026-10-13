// ── Precios · Producción: modal de presentación (crear / editar) con vista previa en vivo ──
// Script clásico, cargado después de los otros precios_produccion*.js: usa sus globales (prodDet,
// guardarProd, validarProd, urlProd, conectarBuscadorSiga, htmlBuscadorSiga, badgeEstadoProd,
// bodyPresentacion, opcionesVariedad, formatoPeso, presentacionSucia, faltaObligatorioPres, fmtNum,
// btnCls/btnPrim/campoCls, nombresProd, htmlNotas, htmlCambios, REQ, ayuda, sugeridoProd, AVISO_COSTO_HORA), conceptosCosto
// (precios_modal_esquema.js), campoU (precios_config.js) y los de
// precios.html (esc, fmtMoney, fmtPrecio, fmtPct, chip, numOrNull, claseDelta, avisar,
// confirmar, pedirJson). Layout: formulario en bloques ①–④ a la izquierda y resumen de costo a la derecha
// (≥ 900 px); apilado debajo con el sugerido en el pie. El resumen sale SIEMPRE del server: lo guardado
// o POST …/preview (costea en memoria, no escribe). Nunca se recalculan fórmulas acá.

const PREVIEW_MS = 300;
// presEd = { plu, nombrePlu, recetaId, kg, sinSiga, nombreNuevo, insumos [{ plu, nombre, cantidad }], minutos (por unidad),
//            inicial (lo guardado, para el "sin guardar"), preview, errorPreview, calculando }
let presEd = null;
let previewTimer = null, previewSeq = 0;

// ── Diálogo (un <dialog> propio: pie fijo, 2 columnas, confirmación al cerrar con cambios) ──
function dialogoPres() {
  let d = document.getElementById('dlgPres');
  if (d) return d;
  document.body.insertAdjacentHTML('beforeend', `
    <dialog id="dlgPres" class="p-0 rounded-xl border border-borde shadow-fluent bg-card text-ink w-[min(96vw,1100px)] max-w-none max-h-[92vh] backdrop:bg-ink/40" aria-labelledby="dpTitulo">
      <div class="flex flex-col max-h-[92vh]">
        <div class="px-5 pt-4 pb-3 flex items-start gap-3 border-b border-borde">
          <div class="min-w-0"><h3 id="dpTitulo" class="font-disp text-lg font-bold leading-snug"></h3><div id="dpSub" class="text-xs text-gris mt-0.5"></div></div>
          <button type="button" id="dpX" class="ml-auto -mr-2 w-8 h-8 shrink-0 rounded-lg text-gris hover:bg-bg hover:text-ink" aria-label="Cerrar">✕</button>
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto min-[900px]:overflow-hidden min-[900px]:grid min-[900px]:grid-cols-[minmax(0,1fr)_380px]">
          <div id="dpForm" class="p-5 min-[900px]:overflow-y-auto"></div>
          <aside id="dpResumen" class="p-5 bg-bg/50 border-t min-[900px]:border-t-0 min-[900px]:border-l border-borde min-[900px]:overflow-y-auto" aria-live="polite"></aside>
        </div>
        <div id="dpPie" class="px-5 py-3 border-t border-borde flex items-center gap-2 flex-wrap bg-card rounded-b-xl"></div>
      </div>
    </dialog>`);
  d = document.getElementById('dlgPres');
  d.addEventListener('cancel', e => { e.preventDefault(); cerrarPresentacion(); }); // Escape
  d.addEventListener('keydown', e => { if (e.key === 'Escape') e.stopPropagation(); }); // no llega al handler de #mDet
  d.querySelector('#dpX').onclick = () => cerrarPresentacion();
  return d;
}
const presAbierta = () => { const d = document.getElementById('dlgPres'); return !!(d && d.open); };
async function cerrarPresentacion({ forzar = false } = {}) {
  if (!presAbierta()) return true;
  if (!forzar && presEd && presentacionSucia(presEd, presEd.inicial)
    && !(await confirmar('¿Descartar los cambios sin guardar de esta presentación?', { textoOk: 'Descartar' }))) return false;
  clearTimeout(previewTimer);
  document.getElementById('dlgPres').close();
  presEd = null;
  return true;
}

// ── Estado ──────────────────────────────────────────────────────────────────────
function estadoInicialPres(plu) {
  const def = plu ? prodDet.definicion.presentaciones[plu] || {} : {};
  const variedades = opcionesVariedad(prodDet.definicion.recetas);
  const v = {
    plu: plu || null, recetaId: def.recetaId || (variedades[0] || [''])[0], kg: def.kgPorUnidad ?? null,
    // Decisión 13: presentación que todavía no está en SIGA (clave n-…): nombre propio en vez de PLU.
    sinSiga: esProvisoria(plu), nombreNuevo: esProvisoria(plu) ? def.nombre || '' : '',
    // ④ Insumos (nombre del costeo guardado) y minutos por unidad de mano de obra.
    insumos: (def.insumos || []).map(it => ({ plu: String(it.plu), cantidad: it.cantidad, nombre: nombreInsumoPres(plu, it.plu) })),
    minutos: def.minutosPorUnidad ?? null,
  };
  return { ...v, nombrePlu: null, inicial: v, preview: null, errorPreview: '', calculando: false };
}
const guardadaPres = () => (presEd.plu && prodDet.presentaciones[presEd.plu]) || null;
const nombreInsumoPres = (plu, insumo) => ((((plu && prodDet.presentaciones[plu]) || {}).componentes || []).find(c => c.plu === String(insumo)) || {}).nombre || null;
const suciaPres = () => presentacionSucia(presEd, presEd.inicial);
// Lo que muestra el resumen: con cambios, la vista previa; sin cambios, lo guardado.
const datosResumen = () => (suciaPres() ? presEd.preview : presEd.preview || guardadaPres());
const bodyDe = v => ({ ...bodyPresentacion({ recetaId: v.recetaId, kgPorUnidad: v.kg, insumos: v.insumos, minutosPorUnidad: v.minutos }),
  ...(v.sinSiga ? { nombre: (v.nombreNuevo || '').trim() } : {}) });

function abrirPresentacion(plu) {
  presEd = estadoInicialPres(plu);
  const d = dialogoPres();
  pintarModalPresentacion();
  if (!d.open) d.showModal();
}
// Tras cargar un costo/margen desde un faltante (detalle ya recargado): re-pinta y recalcula.
function refrescarModalPres() {
  if (!presEd || !presAbierta()) return;
  presEd = { ...presEd, preview: null };
  pintarModalPresentacion();
  pedirPreview();
}
function pintarModalPresentacion() {
  const p = guardadaPres();
  document.getElementById('dpTitulo').textContent = p ? p.nombre || `Presentación ${presEd.plu}` : 'Nueva presentación';
  const pluTxt = esProvisoria(presEd.plu) ? 'Pendiente de alta en SIGA' : `PLU ${presEd.plu}`;
  document.getElementById('dpSub').textContent = p ? `${pluTxt} · ${prodDet.nombre}` : `${prodDet.nombre} · paso 3`;
  document.getElementById('dpForm').innerHTML = htmlBannersPres() + htmlFormPres(p);
  conectarFormPres();
  pintarVivo();
}

// ── Vista previa (server) ───────────────────────────────────────────────────────
function programarPreview() { clearTimeout(previewTimer); previewTimer = setTimeout(pedirPreview, PREVIEW_MS); }
async function pedirPreview() {
  if (!presEd) return;
  if (!suciaPres() || faltaObligatorioPres(presEd, { sinPlu: true })) {
    presEd = { ...presEd, preview: null, errorPreview: '', calculando: false };
    pintarVivo();
    return;
  }
  const n = ++previewSeq;
  presEd = { ...presEd, calculando: true };
  pintarResumenPres();
  const url = urlProd(prodDet.id, presEd.plu ? `/presentaciones/${encodeURIComponent(presEd.plu)}/preview` : '/presentaciones/preview');
  let cambio;
  try { cambio = { preview: await pedirJson('POST', url, bodyDe(presEd)), errorPreview: '' }; }
  catch (e) { cambio = { preview: null, errorPreview: e.message }; }
  if (n !== previewSeq || !presEd) return; // llegó una respuesta vieja o se cerró el modal
  presEd = { ...presEd, ...cambio, calculando: false };
  pintarVivo();
}
// Partes que dependen del estado/preview (no re-dibuja los campos: no se pierde el foco).
function pintarVivo() {
  if (!presEd) return;
  const banners = document.getElementById('dpBanners');
  if (banners) { banners.outerHTML = htmlBannersPres(); conectarBanners(); }
  const g = document.getElementById('dpGramos');
  if (g) g.textContent = formatoPeso(presEd.kg) ? '= ' + formatoPeso(presEd.kg) : '';
  pintarResumenPres();
  pintarPiePres();
}

// ── Estado y alertas arriba del formulario ──────────────────────────────────────
function htmlBannersPres() {
  const p = guardadaPres(), r = datosResumen(), nombres = nombresProd();
  const partes = [];
  if (p && p.estado === 'cambio') {
    const pct = p.cambios && p.cambios.deltaPct != null ? ` (${fmtPct(p.cambios.deltaPct)})` : '';
    partes.push(`<div class="rounded-lg border border-warn/40 bg-warn/5 p-3 text-sm">
      <div class="flex flex-wrap items-center gap-2"><b class="text-warn">⚠ El costo cambió desde la última validación${pct}</b>
        <button type="button" id="dpRevisado" class="ml-auto ${btnCls}">Revisé, validar costo</button></div>
      <details class="mt-1"><summary class="text-xs text-gris cursor-pointer hover:text-ink">Ver qué cambió</summary>${htmlCambios(p.cambios, nombres)}</details></div>`);
  } else if (p) {
    partes.push(p.estado === 'ok' ? chip('✓ Costo validado', 'bg-ok/15 text-ok') : chip('Sin validar todavía', 'bg-gris/15 text-gris'));
  }
  if (r && r.faltantes && r.faltantes.length) partes.push(htmlNotas({ faltantes: r.faltantes }, nombres, presEd.plu));
  if (r && (r.avisos || []).includes('variedad')) partes.push(`<p class="text-xs text-warn">⚠ ${esc(mensajeFaltante('variedad').texto)} en ②.</p>`);
  if (r && (r.avisos || []).includes('costoHora')) partes.push(`<p class="text-xs text-warn">⚠ ${esc(AVISO_COSTO_HORA)}</p>`);
  return `<div id="dpBanners" class="space-y-2 mb-4">${partes.join('')}</div>`;
}
function conectarBanners() {
  const b = document.getElementById('dpRevisado');
  if (b) b.onclick = () => validarPres(b);
}

// ── Formulario en bloques ①–③ ────────────────────────────────────────────────────
const NUM_BLOQUE = ['①', '②', '③', '④'];
function bloquePres(n, titulo, cuerpo, opcional = false) {
  return `<section class="mb-5"><h4 class="flex items-center gap-2 text-sm font-semibold ${opcional ? 'text-gris' : 'text-ink'}">
    <span class="text-lg leading-none ${opcional ? 'text-gris' : 'text-verde'}" aria-hidden="true">${NUM_BLOQUE[n - 1]}</span>${titulo}
    ${opcional ? '<span class="font-normal text-xs">(opcional)</span>' : REQ}</h4><div class="mt-2 pl-7">${cuerpo}</div></section>`;
}
// ① Producto a la venta: PLU de SIGA, o "todavía no está en SIGA" (nombre + clave provisoria n-…).
// El módulo nunca escribe en SIGA: el alta la hace el usuario y después se vincula el PLU.
const inputNombreNuevo = () => `<label class="block text-xs text-gris">Nombre de la presentación ${REQ}
  <input id="dpNombreNuevo" maxlength="60" placeholder="ej. Granola 800 g" value="${esc(presEd.nombreNuevo)}" class="block mt-1 ${campoCls} w-full max-w-md py-1.5"></label>`;
function htmlBloquePlu(p) {
  if (p && esProvisoria(presEd.plu)) {
    return `${chip('Pendiente de alta en SIGA', 'bg-amarillo/30 text-ink')} ${inputNombreNuevo()}
      <div class="mt-2 text-xs text-gris">¿Ya la diste de alta en SIGA? Vinculala a su PLU (conserva todo lo cargado):</div>
      <div class="mt-1">${htmlBuscadorSiga('dpVincular', 'Buscá el PLU nuevo en SIGA…')}</div>`;
  }
  if (p) return `<div class="text-sm"><b class="tabular-nums">PLU ${esc(presEd.plu)}</b> · ${esc(p.nombre || '')}</div>`;
  const modo = `<div class="flex flex-wrap gap-x-4 gap-y-1 text-sm mb-2">
    <label class="inline-flex items-center gap-1.5"><input type="radio" name="dpModoPlu" value="siga" class="accent-verde"${presEd.sinSiga ? '' : ' checked'}> Ya está en SIGA</label>
    <label class="inline-flex items-center gap-1.5"><input type="radio" name="dpModoPlu" value="nueva" class="accent-verde"${presEd.sinSiga ? ' checked' : ''}> Todavía no está en SIGA</label></div>`;
  if (presEd.sinSiga) return modo + inputNombreNuevo() + ayuda('Se crea con una clave provisoria; cuando la des de alta en SIGA, la vinculás a su PLU.');
  const elegido = presEd.plu ? `<div class="text-sm mb-1"><b class="tabular-nums">PLU ${esc(presEd.plu)}</b> · ${esc(presEd.nombrePlu || '')}</div>` : '';
  return modo + elegido + htmlBuscadorSiga('dpPlu', presEd.plu ? 'Cambiar PLU…' : 'Buscá el PLU vendible de SIGA, ej. GRANOLA 500');
}
function htmlBloqueVariedad() {
  const variedades = opcionesVariedad(prodDet.definicion.recetas);
  if (!variedades.length) {
    return `<div class="rounded-lg border border-dashed border-borde bg-bg/60 p-3 text-xs text-gris flex flex-wrap items-center gap-2">
      <span>No hay variedades. Si el producto no tiene sabores, creá una variedad sin extras (ej. Clásica).</span>
      <button type="button" data-pr-accion="paso" data-paso="2" class="${btnCls}">Crear variedad (paso 2)</button></div>`;
  }
  const actual = prodDet.recetas[presEd.recetaId];
  const sobreBase = actual && !actual.varianteDe ? `<option value="" selected disabled>${esc(actual.nombre)} (receta base: elegí una variedad)</option>` : '';
  const opciones = sobreBase + variedades.map(([id, t]) => {
    const c = (prodDet.recetas[id] || {}).costoKg;
    return `<option value="${esc(id)}"${id === presEd.recetaId ? ' selected' : ''}>${esc(t)} · ${c != null ? '$ ' + fmtMoney(c) + '/kg' : 'sin costo'}</option>`;
  }).join('');
  return `<select id="dpReceta" class="${campoCls} py-1.5 w-full max-w-md" aria-label="Variedad">${opciones}</select>
    ${ayuda('De qué variedad sale el contenido; al lado, su costo por kg.')}`;
}
function htmlBloqueCantidad() {
  const g = formatoPeso(presEd.kg);
  return `<label class="text-xs text-gris">Kg por unidad ${REQ}
      <span class="flex items-center gap-2 mt-1"><input id="dpKg" type="number" step="any" min="0" placeholder="ej. 0,27" value="${presEd.kg ?? ''}"
        class="${campoCls} w-32 text-right tabular-nums"><span id="dpGramos" class="text-sm text-ink font-semibold">${g ? '= ' + g : ''}</span></span></label>
    ${ayuda('Cuánta receta lleva cada unidad vendida.')}`;
}
// ④ Insumos por unidad (envase, etiqueta, bolsa, caja…: el mismo buscador múltiple de Envasado) y minutos de mano de obra.
function htmlBloqueInsumosPres() {
  const filas = presEd.insumos.map((it, j) => `<tr><td class="tabular-nums">${esc(it.plu)}</td><td class="text-left">${esc(it.nombre || '')}</td>
      <td class="num">${campoU(`<input type="number" min="0" step="any" class="dp-ins-cant" data-j="${j}" value="${esc(it.cantidad ?? '')}" aria-label="Cantidad de ${esc(it.nombre || it.plu)} por unidad">`, 'u', { w: 'w-24' })}</td>
      <td class="text-right"><button type="button" class="dp-ins-quitar btn-quitar" data-j="${j}" aria-label="Quitar ${esc(it.nombre || it.plu)}">✕</button></td></tr>`).join('');
  const tabla = filas ? `<table class="pr-tabla pr-tabla-in mb-2"><thead><tr><th>PLU</th><th class="text-left">Insumo</th><th class="num">Por unidad</th><th class="w-10"></th></tr></thead><tbody>${filas}</tbody></table>` : '';
  return `${tabla}${htmlBuscadorSiga('dpIns', 'Buscar insumos en SIGA: envase, etiqueta, bolsa, caja… (podés tildar varios)')}
    <label class="text-xs text-gris block mt-3">Minutos por unidad (mano de obra)
      <span class="flex items-center gap-2 mt-1">${campoU(`<input id="dpMin" type="number" step="any" min="0" placeholder="ej. 2" value="${esc(presEd.minutos ?? '')}">`, 'min', { w: 'w-24' })}</span></label>
    ${ayuda('Tiempo estimado para producir una unidad; se multiplica por el costo hora de Configuración › Costos.')}`;
}
function htmlFormPres(p) {
  return bloquePres(1, 'Producto a la venta', htmlBloquePlu(p))
    + bloquePres(2, '¿De qué variedad?', htmlBloqueVariedad())
    + bloquePres(3, '¿Cuánto lleva?', htmlBloqueCantidad())
    + bloquePres(4, 'Insumos y mano de obra', htmlBloqueInsumosPres(), true);
}
function setPres(cambio) {
  presEd = { ...presEd, ...cambio };
  pintarVivo();
  programarPreview();
}
function conectarFormPres() {
  const num = (id, campo) => { const el = document.getElementById(id); if (el) el.addEventListener('input', () => setPres({ [campo]: numOrNull(el.value) })); };
  num('dpKg', 'kg');
  num('dpMin', 'minutos');
  conectarInsumosPres();
  const receta = document.getElementById('dpReceta');
  if (receta) receta.addEventListener('change', e => { setPres({ recetaId: e.target.value }); pintarBannersSolo(); });
  document.querySelectorAll('#dpForm input[name=dpModoPlu]').forEach(r => r.addEventListener('change', () => {
    presEd = { ...presEd, sinSiga: r.value === 'nueva', plu: null, nombrePlu: null };
    pintarModalPresentacion();
    programarPreview();
  }));
  const nombreNuevo = document.getElementById('dpNombreNuevo');
  if (nombreNuevo) nombreNuevo.addEventListener('input', () => setPres({ nombreNuevo: nombreNuevo.value }));
  if (document.getElementById('dpVincular')) conectarBuscadorSiga('dpVincular', vincularPres);
  if (document.getElementById('dpPlu')) conectarBuscadorSiga('dpPlu', elegirPluPres);
  conectarBanners();
}
// Insumos de ④: cantidad sin repintar (no pierde el foco); agregar/quitar repinta el formulario.
function conectarInsumosPres() {
  const insumosCon = insumos => { presEd = { ...presEd, insumos }; pintarModalPresentacion(); programarPreview(); };
  document.querySelectorAll('#dpForm .dp-ins-cant').forEach(inp => inp.addEventListener('input', () => {
    const j = Number(inp.dataset.j);
    setPres({ insumos: presEd.insumos.map((it, k) => (k === j ? { ...it, cantidad: numOrNull(inp.value) } : it)) });
  }));
  document.querySelectorAll('#dpForm .dp-ins-quitar').forEach(b => b.onclick = () => insumosCon(presEd.insumos.filter((_, k) => k !== Number(b.dataset.j))));
  if (!document.getElementById('dpIns')) return;
  const motivo = plu => (plu === String(presEd.plu) ? 'es esta presentación' : presEd.insumos.some(it => it.plu === plu) ? 'ya está' : null);
  conectarBuscadorSiga('dpIns', items => {
    const nuevos = items.filter(it => !motivo(String(it.plu))).map(it => ({ plu: String(it.plu), nombre: it.nombre || null, cantidad: 1 }));
    if (nuevos.length) insumosCon([...presEd.insumos, ...nuevos]);
  }, { multiple: true, deshabilitado: motivo });
}
const pintarBannersSolo = () => { const b = document.getElementById('dpBanners'); if (b) { b.outerHTML = htmlBannersPres(); conectarBanners(); } };
function elegirPluPres({ plu, nombre }) {
  if (prodDet.presentaciones[plu]) { avisar(`El PLU ${plu} ya es una presentación de este producto: abrila desde la tabla.`); return; }
  presEd = { ...presEd, plu, nombrePlu: nombre };
  pintarModalPresentacion();
  programarPreview();
}

// ── Resumen de costo (columna derecha) ──────────────────────────────────────────
const filaRes = (op, txt, val, cls = '') => `<div class="flex items-baseline gap-2 py-1 text-sm ${cls}">
  <span class="w-3 shrink-0 text-gris" aria-hidden="true">${op}</span><span class="flex-1 min-w-0">${txt}</span><span class="tabular-nums whitespace-nowrap">${val}</span></div>`;
const plataRes = v => (v == null ? '<span class="text-crit text-xs">falta</span>' : '$ ' + fmtMoney(v));
function htmlPrecioRes(r) {
  const m = sugeridoProd(r);
  return `<div class="flex flex-wrap items-end gap-x-6 gap-y-2">
    <div><div class="lbl">Sugerido minorista</div><div class="text-3xl font-bold text-verde tabular-nums leading-tight">${m ? '$ ' + fmtPrecio(m.precio) : '<span class="text-lg text-gris">sin precio</span>'}</div></div>
    <div><div class="lbl">Vigente SIGA</div><div class="text-lg font-semibold text-ink/70 tabular-nums">${r.precioVigente != null ? '$ ' + fmtPrecio(r.precioVigente) : '—'}</div></div>
    <div><div class="lbl">Diferencia</div><span class="font-semibold tabular-nums ${claseDelta(m && m.estado)}">${m ? fmtPct(m.deltaPct) : '—'}</span></div></div>`;
}
// Costo real = mercadería (receta × kg, con cada materia prima por unidad) + insumos + mano de obra (conceptosCosto,
// precios_modal_esquema.js).
function htmlEcuacionRes(r) {
  const { insumos, mo } = conceptosCosto(r.componentes);
  const receta = r.componentes.find(c => c.plu === '_receta') || {};
  const sub = t => `<span class="block text-[11px] text-gris">${t}</span>`;
  const mercaderia = [`Receta ${esc(receta.nombre || '')}: ${fmtNum(receta.cantidad)} kg × ${plataRes(receta.costoUnit)}/kg`,
    ...(r.materiasPrimas || []).map(l => `· ${esc(l.nombre || l.plu)} ${fmtNum(l.cantidad)} kg × ${plataRes(l.costoUnit)}`)];
  const lineasIns = insumos.lineas.length ? insumos.lineas.map(l => `· ${esc(l.nombre || l.plu)} ${fmtNum(l.cantidad)} × ${plataRes(l.costoUnit)}`) : ['sin insumos cargados (④)'];
  const textoMo = !mo ? 'sin minutos cargados (④)' : `${fmtNum(mo.cantidad)} min × ${mo.costoUnit == null ? 'sin costo hora' : `${plataRes(mo.costoUnit)}/h`}`;
  return `<div class="mt-4 rounded-lg border border-borde bg-card px-3 py-2" role="group" aria-label="Cálculo del costo">
    ${filaRes('', `Mercadería${mercaderia.map(sub).join('')}`, plataRes(receta.importe))}
    ${filaRes('+', `Insumos${lineasIns.map(sub).join('')}`, plataRes(insumos.subtotal))}
    ${filaRes('+', `Mano de obra${sub(textoMo)}`, plataRes(mo ? mo.importe : 0))}
    ${filaRes('=', '<b>Costo real por unidad</b>', `<b>${plataRes(r.costoUnidad)}</b>`, 'border-t border-borde mt-1 pt-2')}
    <p class="text-[11px] text-gris pt-1">Cada materia prima e insumo con el costo de su tab; la mano de obra con el costo hora de Configuración. Pack, bulto y el desglose: botón «Precios» de la tabla.</p></div>`;
}
function pintarResumenPres() {
  const el = document.getElementById('dpResumen');
  if (!el || !presEd) return;
  const r = datosResumen();
  const cab = `<div class="flex items-center gap-2 mb-3"><span class="lbl">Resumen de costo</span>
    <span id="dpSucio">${htmlSucioPres()}</span>${presEd.calculando ? '<span class="spin" aria-label="Calculando"></span>' : ''}</div>`;
  if (!r) {
    const msg = presEd.errorPreview || faltaObligatorioPres(presEd, { sinPlu: true }) || 'Calculando…';
    el.innerHTML = cab + `<p class="text-sm ${presEd.errorPreview ? 'text-crit' : 'text-gris'}">${esc(msg)}</p>
      <p class="text-xs text-gris mt-2">El precio se calcula solo mientras completás ②–③.</p>`;
    return;
  }
  el.innerHTML = cab + htmlPrecioRes(r) + htmlEcuacionRes(r)
    + (presEd.errorPreview ? `<p class="text-xs text-crit mt-2">${esc(presEd.errorPreview)}</p>` : '')
    + htmlFormulaSiga(r);
  const copiar = document.getElementById('dpCopiarFormula');
  if (copiar) copiar.onclick = () => copiarFormulaSiga(r);
}

// ── Fórmula para cargar en SIGA (sólo lectura; decisión 13: el módulo no escribe en SIGA) ──
function htmlFormulaSiga(r) {
  const filas = r.formulaSiga || [];
  if (!filas.length) return '';
  const nombres = nombresProd();
  return `<details class="mt-4 rounded-lg border border-borde bg-card px-3 py-2">
    <summary class="text-sm font-semibold cursor-pointer">Fórmula para cargar en SIGA <span class="font-normal text-xs text-gris">(por unidad vendida)</span></summary>
    <div class="overflow-x-auto mt-2"><table class="w-full text-xs"><thead class="text-gris"><tr><th class="text-left p-1">PLU</th><th class="text-left p-1">Componente</th>
      <th class="text-right p-1">Cantidad</th><th class="text-left p-1">Unidad</th></tr></thead>
      <tbody>${filas.map(f => `<tr class="border-t border-borde"><td class="p-1 tabular-nums">${esc(f.plu || '—')}</td>
        <td class="p-1">${esc(nombres[f.plu] || f.plu)}</td>
        <td class="p-1 text-right tabular-nums">${esc(String(f.cantidad).replace('.', ','))}</td><td class="p-1">${esc(f.unidad)}</td></tr>`).join('')}</tbody></table></div>
    <div class="flex items-center gap-2 mt-2"><button type="button" id="dpCopiarFormula" class="${btnCls}">Copiar</button>
      <span class="text-[11px] text-gris">Cargala a mano en SIGA: el módulo no escribe en SIGA.</span></div></details>`;
}
async function copiarFormulaSiga(r) {
  const texto = textoFormulaSiga(r.formulaSiga, nombresProd());
  try { await navigator.clipboard.writeText(texto); avisoExito('Fórmula copiada'); }
  catch { avisar('No se pudo copiar automáticamente. Copiala de acá:\n\n' + texto); }
}

// ── Pie fijo ────────────────────────────────────────────────────────────────────
const htmlSucioPres = () => (suciaPres() ? chip('sin guardar', 'bg-amarillo/30 text-ink') : '');
function pintarPiePres() {
  document.getElementById('dpPie').innerHTML = htmlPiePres();
  conectarPiePres();
  const s = document.getElementById('dpSucio');
  if (s) s.innerHTML = htmlSucioPres();
}
function htmlPiePres() {
  const p = guardadaPres(), r = datosResumen(), sucia = suciaPres();
  const falta = faltaObligatorioPres(presEd);
  const bloqueoGuardar = falta || (p && !sucia ? 'No hay cambios para guardar.' : '');
  const bloqueoValidar = !p ? '' : sucia ? 'Guardá los cambios antes de validar.' : p.faltantes.length ? 'Con datos faltantes no se puede validar.'
    : p.estado === 'ok' ? 'Ya está validada con el costo actual.' : '';
  const m = r ? sugeridoProd(r) : null;
  const movil = `<span class="min-[900px]:hidden text-sm mr-auto">Sugerido <b class="text-verde tabular-nums">${m ? '$ ' + fmtPrecio(m.precio) : '—'}</b>
    ${m && m.deltaPct != null ? `<span class="${claseDelta(m.estado)} tabular-nums">${fmtPct(m.deltaPct)}</span>` : ''}</span>`;
  return `${p ? '<button type="button" id="dpEliminar" class="px-3 py-1.5 rounded-lg text-xs text-crit hover:bg-crit/10">Eliminar</button>' : ''}
    ${movil}<span class="hidden min-[900px]:block flex-1"></span>
    ${p ? `<span title="${esc(bloqueoValidar)}"><button type="button" id="dpValidar" class="${btnCls}"${bloqueoValidar ? ' disabled' : ''}>Validar costo</button></span>` : ''}
    <span title="${esc(bloqueoGuardar)}"><button type="button" id="dpGuardar" class="${btnPrim}"${bloqueoGuardar ? ' disabled' : ''}>${p ? 'Guardar presentación' : 'Crear presentación'}</button></span>`;
}
function conectarPiePres() {
  const g = document.getElementById('dpGuardar');
  g.onclick = () => guardarPres(g);
  const v = document.getElementById('dpValidar');
  if (v) v.onclick = () => validarPres(v);
  const e = document.getElementById('dpEliminar');
  if (e) e.onclick = eliminarPres;
}
const urlPres = plu => urlProd(prodDet.id, '/presentaciones/' + encodeURIComponent(plu));
async function guardarPres(btn) {
  const falta = faltaObligatorioPres(presEd);
  if (falta) { avisar(falta); return; }
  const todas = Object.values(prodDet.presentaciones).map(x => x.plu);
  const plu = presEd.plu || claveProvisoria(presEd.nombreNuevo, todas); // sin PLU de SIGA: clave provisoria n-…
  const nueva = !prodDet.presentaciones[plu], body = bodyDe(presEd), sucia = suciaPres();
  const guardar = async () => { if (nueva || sucia) await pedirJson('PUT', urlPres(plu), body); };
  // Tras guardar se re-abre con lo del server (costo, precio y estado actualizados).
  if (await guardarProd(guardar, btn, nueva ? 'Presentación creada' : 'Presentación guardada')) abrirPresentacion(plu);
  else if (presEd) pintarVivo();
}
// Vincular la presentación provisoria al PLU con el que el usuario la dio de alta en SIGA.
async function vincularPres({ plu, nombre }) {
  if (suciaPres()) { avisar('Guardá los cambios antes de vincular.'); return; }
  const clave = presEd.plu;
  if (!(await confirmar(`¿Vincular "${presEd.nombreNuevo}" al PLU ${plu} (${nombre}) de SIGA? Se conserva todo lo cargado.`, { textoOk: 'Vincular' }))) return;
  const ok = await guardarProd(() => pedirJson('POST', urlPres(clave) + '/vincular', { plu }), null, `Vinculada al PLU ${plu}`);
  if (ok) abrirPresentacion(plu);
}
async function validarPres(btn) {
  if (suciaPres()) { avisar('Guardá los cambios antes de validar.'); return; }
  const plu = presEd.plu;
  if (await validarProd({ tipo: 'presentacion', id: plu }, btn)) abrirPresentacion(plu);
}
async function eliminarPres() {
  const plu = presEd.plu;
  if (!(await confirmar(`¿Eliminar la presentación ${plu}? (el PLU sigue existiendo en SIGA)`, { textoOk: 'Eliminar' }))) return;
  if (await guardarProd(() => pedirJson('DELETE', urlPres(plu)), null, 'Presentación eliminada')) cerrarPresentacion({ forzar: true });
}
