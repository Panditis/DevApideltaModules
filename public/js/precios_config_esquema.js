// ── Precios · Configuración del esquema por canal: Costos, Márgenes y Precio (spec 2026-10-07 §3.3) ──
// Script clásico, cargado después de precios_config.js y de /js/precios_esquema.js (global PreciosEsquema = el mismo lib
// del server). Lee/guarda /api/precios/config/esquema (sólo con el permiso precios-config). Globales: esc, fmtMoney,
// numOrNull (precios_comun.js), campoU, marcarSucio, limpiarSucio (precios_config.js).
const API_ESQ = '/api/precios/config/esquema';
const TIPOS_ESQ = { almacen: 'Reventa', fraccionado: 'Fraccionado', produccion: 'Producción' };
const TIPOS_K = Object.keys(TIPOS_ESQ);
const REDONDEOS_ESQ = { minorista: 'Minorista', packNeto: 'Pack sin IVA', packIva: 'Pack con IVA', bultoNeto: 'Bulto sin IVA', bultoIva: 'Bulto con IVA' };
let cfgEsq = null; // última config leída

async function pedirEsq(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j;
}
// La comparten Costos, Márgenes, Precio y el Simulador. Sin migrar: aviso arriba de Configuración.
async function leerCfgEsq() {
  cfgEsq = await pedirEsq('GET', API_ESQ);
  document.getElementById('cfgEsqAviso').classList.toggle('hidden', cfgEsq.migrado);
  return cfgEsq;
}
const msgEsq = (el, txt, cls = 'text-ink/50') => { if (el) { el.className = `esq-msg text-sm ${cls}`; el.textContent = txt; } };
const pctEsq = n => `${String(+(+n).toFixed(2)).replace('.', ',')} %`;

async function cargarPanelEsq(id, pintar) {
  const panel = document.getElementById(id);
  panel.innerHTML = '<div class="text-sm text-ink/50 py-4"><span class="spin"></span> Cargando…</div>';
  try { pintar(panel, await leerCfgEsq()); }
  catch (e) { panel.innerHTML = `<p class="text-sm text-crit py-4">No se pudo cargar: ${esc(e.message)}</p>`; }
}
const cargarCostosEsq = () => cargarPanelEsq('panel-costos', pintarCostosEsq);
const cargarPrecioEsq = () => cargarPanelEsq('panel-precio', pintarPrecioEsq);

// PUT y redibujo con lo guardado (el bloque queda limpio); si falla, el error queda en el mensaje del bloque.
async function guardarBloqueEsq(bloque, url, body, recargar) {
  const msg = bloque.querySelector('.esq-msg');
  msgEsq(msg, 'Guardando…');
  try { await pedirEsq('PUT', url, body); limpiarSucio(bloque); await recargar(); }
  catch (e) { msgEsq(msg, e.message, 'text-crit'); }
}

// ── Costos: gastos variables (+ modo) y extras minoristas, con tilde por tipo ──
function htmlFilaItemEsq(it = {}) {
  return `<tr data-id="${esc(it.id || '')}">
    <td class="py-1 pr-2"><input class="num-in w-full text-left" data-k="concepto" value="${esc(it.concepto || '')}" aria-label="Concepto"></td>
    <td class="py-1 pr-2">${campoU(`<input type="number" step="any" min="0" max="100" data-k="pct" value="${esc(it.pct ?? '')}" aria-label="Porcentaje">`, '%', { w: 'w-24' })}</td>
    ${TIPOS_K.map(t => `<td class="py-1 text-center"><input type="checkbox" class="accent-verde" data-tipo="${t}"${it.tipos && it.tipos[t] ? ' checked' : ''} aria-label="${TIPOS_ESQ[t]}"></td>`).join('')}
    <td class="py-1 pl-2"><button type="button" class="esq-quitar text-gris hover:text-crit" data-edita aria-label="Quitar">✕</button></td></tr>`;
}
function htmlItemsEsq(lista, titulo, ayuda, items) {
  return `<div class="cfg-card min-w-0" data-lista="${lista}">
    <h3 class="cfg-h">${esc(titulo)}</h3><p class="cfg-ayuda">${esc(ayuda)}</p>
    <table class="cfg-tabla w-full mt-2"><thead><tr><th class="text-left">Concepto</th><th class="text-left">%</th>
      ${TIPOS_K.map(t => `<th>${TIPOS_ESQ[t]}</th>`).join('')}<th></th></tr></thead>
      <tbody>${items.map(htmlFilaItemEsq).join('')}</tbody></table>
    <div class="flex items-center gap-3 mt-2"><button type="button" class="esq-agregar cfg-btn2" data-edita>+ Agregar</button>
      <span class="esq-totales text-xs text-gris"></span></div></div>`;
}
function leerItemsEsq(card) {
  return [...card.querySelectorAll('tbody tr')].map(tr => ({
    ...(tr.dataset.id ? { id: tr.dataset.id } : {}),
    concepto: tr.querySelector('[data-k="concepto"]').value.trim(),
    pct: numOrNull(tr.querySelector('[data-k="pct"]').value),
    tipos: Object.fromEntries(TIPOS_K.map(t => [t, tr.querySelector(`[data-tipo="${t}"]`).checked])),
  }));
}
function pintarTotalesEsq(card) {
  const items = leerItemsEsq(card).filter(it => it.pct != null);
  card.querySelector('.esq-totales').textContent = 'Total: ' + TIPOS_K.map(t => `${TIPOS_ESQ[t]} ${pctEsq(PreciosEsquema.pctItems(items, t))}`).join(' · ');
}
function pintarCostosEsq(panel, cfg) {
  panel.innerHTML = `<p class="cfg-cab"><b>Costos</b> — se suman al costo de mercadería. Los gastos variables valen para los tres canales; los extras, sólo para el minorista. Cada ítem se aplica a los tipos tildados.</p>
  <div data-guardable data-nombre="Costos">
    <div class="cfg-card mb-4"><h3 class="cfg-h">Cómo se aplican los gastos variables</h3>
      <div class="seg seg-sub mt-2" role="group" aria-label="Modo de los gastos variables">
        <button type="button" class="seg-opt" data-modo="costo" data-edita aria-pressed="${cfg.modoGastos === 'costo'}">Sobre costo · costo × (1 + %)</button>
        <button type="button" class="seg-opt" data-modo="precio" data-edita aria-pressed="${cfg.modoGastos === 'precio'}">Sobre precio · costo ÷ (1 − %)</button>
      </div></div>
    <div class="cfg-grid">
      ${htmlItemsEsq('gastosVenta', 'Gastos variables', 'Sobre el costo de mercadería, antes del margen de cada canal.', cfg.gastosVenta)}
      ${htmlItemsEsq('extrasMinorista', 'Costos extras minoristas', 'Markup sobre el neto minorista, antes del IVA (ej. IIBB, débitos y créditos).', cfg.extrasMinorista)}
    </div>
    <div class="cfg-pie mt-4"><span class="esq-msg text-sm" role="status" aria-live="polite"></span>
      <button type="button" class="esq-guardar cfg-btn">Guardar costos</button></div>
  </div>
  ${htmlCostoHoraEsq(cfg)}`;
  conectarCostoHoraEsq(panel);
  const bloque = panel.querySelector('[data-guardable]');
  bloque.querySelectorAll('[data-lista]').forEach(pintarTotalesEsq);
  bloque.addEventListener('input', e => { const c = e.target.closest('[data-lista]'); if (c) pintarTotalesEsq(c); });
  bloque.addEventListener('click', e => {
    const modo = e.target.closest('[data-modo]');
    if (modo) bloque.querySelectorAll('[data-modo]').forEach(b => b.setAttribute('aria-pressed', String(b === modo)));
    const agregar = e.target.closest('.esq-agregar');
    if (agregar) agregar.closest('[data-lista]').querySelector('tbody')
      .insertAdjacentHTML('beforeend', htmlFilaItemEsq({ tipos: { almacen: true, fraccionado: true, produccion: true } }));
    const quitar = e.target.closest('.esq-quitar');
    if (quitar) { const c = quitar.closest('[data-lista]'); quitar.closest('tr').remove(); pintarTotalesEsq(c); }
  });
  bloque.querySelector('.esq-guardar').onclick = () => {
    const lista = k => leerItemsEsq(bloque.querySelector(`[data-lista="${k}"]`));
    guardarBloqueEsq(bloque, `${API_ESQ}/costos`, {
      modoGastos: bloque.querySelector('[data-modo][aria-pressed="true"]').dataset.modo,
      gastosVenta: lista('gastosVenta'), extrasMinorista: lista('extrasMinorista'),
    }, cargarCostosEsq);
  };
}

// ── Costo hora de mano de obra (Producción: minutos por unidad × costo hora ÷ 60). Guardado aparte (PUT …/costo-hora). ──
function htmlCostoHoraEsq(cfg) {
  return `<div class="cfg-grid cfg-grid-angosta mt-4"><div class="cfg-card min-w-0" data-guardable data-nombre="Costo hora" id="esqCostoHoraCard">
    <h3 class="cfg-h">Costo hora de mano de obra</h3>
    <p class="cfg-ayuda">Producción: los minutos por unidad de cada presentación y PLU envasado × este costo ÷ 60 se suman a su costo real (mercadería + insumos + mano de obra). Vacío = sin mano de obra.</p>
    <div class="cfg-campo"><label for="esqCostoHora">Costo hora <span class="cfg-nota">$ por hora de trabajo</span></label>
      ${campoU(`<input id="esqCostoHora" type="number" step="any" min="0" value="${esc(cfg.costoHora ?? '')}" placeholder="ej. 8268">`, '$/h', { w: 'w-32' })}</div>
    <div class="cfg-pie"><span class="esq-msg text-sm" role="status" aria-live="polite"></span><button type="button" class="esq-guardar-hora cfg-btn">Guardar</button></div>
  </div></div>`;
}
function conectarCostoHoraEsq(panel) {
  const card = panel.querySelector('#esqCostoHoraCard');
  card.querySelector('.esq-guardar-hora').onclick = () => guardarBloqueEsq(card, `${API_ESQ}/costo-hora`,
    { costoHora: numOrNull(card.querySelector('#esqCostoHora').value) }, () => msgEsq(card.querySelector('.esq-msg'), 'Guardado', 'text-ok')); // sin repintar: no pisa los gastos sin guardar
}

// ── Precio: IVA de venta, tolerancia y redondeo por lista ──
function pintarPrecioEsq(panel, cfg) {
  const num = (id, v, u, pre = false, extra = '') =>
    campoU(`<input id="${id}" type="number" step="any" min="0" value="${esc(v ?? '')}" ${extra}>`, u, { pre, w: 'w-32' });
  panel.innerHTML = `<p class="cfg-cab"><b>Precio</b> — IVA de venta (minorista y listas mayoristas con IVA), redondeo de cada lista y tolerancia del semáforo.</p>
  <div class="cfg-grid cfg-grid-angosta"><div class="cfg-card min-w-0" data-guardable data-nombre="Precio">
    <div class="cfg-campo"><label for="esqIva">IVA de venta</label>${num('esqIva', cfg.ivaVentaPct, '%', false, 'max="100"')}</div>
    <div class="cfg-campo"><label for="esqTol">Tolerancia del semáforo <span class="cfg-nota">diferencias dentro de ± este % no se resaltan</span></label>${num('esqTol', cfg.toleranciaPct, '%', false, 'max="100"')}</div>
    <h4 class="font-semibold text-sm mt-4 mb-1">Redondeo <span class="cfg-nota">múltiplo en $; 0 = exacto. Si el exacto queda a menos de $0,50 del vigente, se respeta el vigente.</span></h4>
    ${Object.entries(REDONDEOS_ESQ).map(([k, t]) => `<div class="cfg-campo"><label for="esqRed-${k}">${t}</label>${num(`esqRed-${k}`, cfg.redondeo[k], '$', true)}</div>`).join('')}
    <div class="cfg-pie"><span class="esq-msg text-sm" role="status" aria-live="polite"></span><button type="button" class="esq-guardar cfg-btn">Guardar</button></div>
  </div></div>`;
  const card = panel.querySelector('[data-guardable]');
  const v = id => numOrNull(document.getElementById(id).value);
  card.querySelector('.esq-guardar').onclick = () => guardarBloqueEsq(card, `${API_ESQ}/precio`, {
    ivaVentaPct: v('esqIva'), toleranciaPct: v('esqTol'),
    redondeo: Object.fromEntries(Object.keys(REDONDEOS_ESQ).map(k => [k, v(`esqRed-${k}`)])),
  }, cargarPrecioEsq);
}

// ── Márgenes: 3 tablas (una por canal, para los tres tipos) + grilla de quiebres en vivo + rango desde SIGA + ajuste por peso (Fraccionado) ──
const CANALES_ESQ = { minorista: 'Minorista', pack: 'Mayorista pack', bulto: 'Mayorista bulto' };
const cargarMargenesEsq = () => cargarPanelEsq('panel-margenes', pintarMargenesEsq);
const chipEsq = (txt, title = '') => `<span class="px-1.5 py-0.5 rounded text-[11px] font-semibold bg-warn/15 text-warn"${title ? ` title="${esc(title)}"` : ''}>${esc(txt)}</span>`;

function htmlTablaMargenEsq(canal, t) {
  const r = t.rango || {};
  const num = (k, v, u, extra = '', pre = false) => campoU(`<input type="number" step="any" data-k="${k}" value="${esc(v ?? '')}" ${extra}>`, u, { pre, w: 'w-28' });
  return `<div class="cfg-card min-w-0" data-canal="${canal}"${t.rangoEstimado ? ' data-rango-estimado' : ''}>
    <h4 class="font-semibold text-sm mb-2 flex items-center gap-2 flex-wrap">${CANALES_ESQ[canal]}
      ${t.sinConfigurar ? chipEsq('sin configurar', 'Copia del minorista: revisalo y guardá') : ''}
      ${t.rangoEstimado ? chipEsq('rango estimado', 'Rango de arranque: tocá Recalcular rango') : ''}</h4>
    <div class="cfg-campo"><label>Margen máximo <span class="cfg-nota">costos bajos</span></label>${num('maxPct', t.maxPct, '%')}</div>
    <div class="cfg-campo"><label>Margen mínimo <span class="cfg-nota">costos altos</span></label>${num('minPct', t.minPct, '%')}</div>
    <div class="cfg-campo"><label>Escalones</label>${num('escalones', t.escalones, '#', 'min="1" max="30" step="1"')}</div>
    <div class="cfg-campo"><label>Rango desde</label>${num('desde', r.desde, '$', 'min="0"', true)}</div>
    <div class="cfg-campo"><label>Rango hasta</label>${num('hasta', r.hasta, '$', 'min="0"', true)}</div>
    <div class="esq-quiebres mt-3 text-xs"></div></div>`;
}
function leerTablaEsq(card) {
  const v = k => numOrNull(card.querySelector(`[data-k="${k}"]`).value);
  return { minPct: v('minPct'), maxPct: v('maxPct'), escalones: v('escalones'), rango: { desde: v('desde'), hasta: v('hasta') },
    ...(card.hasAttribute('data-rango-estimado') ? { rangoEstimado: true } : {}) };
}
// Grilla de quiebres (sólo lectura) con el mismo cálculo del server; tabla inválida → el mensaje de validación.
function pintarQuiebresEsq(card) {
  const t = leerTablaEsq(card);
  const err = PreciosEsquema.validarTablaMargen(t);
  const desde = (qs, i) => (i ? `≥ $ ${fmtMoney(qs[i - 1].hasta)}` : 'todos');
  card.querySelector('.esq-quiebres').innerHTML = err ? `<p class="text-crit">${esc(err)}</p>`
    : `<table class="w-full"><thead><tr class="text-gris"><th class="text-left font-normal">Costo</th><th class="text-right font-normal">Margen</th></tr></thead><tbody>
      ${PreciosEsquema.quiebres(t).map((q, i, qs) => `<tr><td>${q.hasta == null ? desde(qs, i) : `< $ ${fmtMoney(q.hasta)}`}</td>
        <td class="text-right tabular-nums">${pctEsq(q.margenPct)}</td></tr>`).join('')}</tbody></table>`;
}

// Ajuste por peso: tabla editable (siempre visible, vacía = sin ajuste) + generador de tramos que sólo llena la tabla.
const htmlFilaTramoEsq = (g = '', p = '') => `<tr class="esq-tramo">
    <td class="py-1 pr-2">${campoU(`<input type="number" step="any" min="1" data-k="g" value="${esc(g)}" aria-label="Hasta (g)">`, 'g', { w: 'w-24' })}</td>
    <td class="py-1 pr-2">${campoU(`<input type="number" step="any" min="-100" max="100" data-k="p" value="${esc(p)}" aria-label="Ajuste %">`, '%', { w: 'w-20' })}</td>
    <td class="py-1"><button type="button" class="esq-quitar-tramo text-gris hover:text-crit" data-edita aria-label="Quitar tramo">✕</button></td></tr>`;
const numGenEsq = (k, v, u, extra = '') => `<label class="text-xs text-gris">${k}
    ${campoU(`<input type="number" step="any" data-gen="${k}" value="${v}" ${extra}>`, u, { w: 'w-20' })}</label>`;
function htmlAjustesPesoEsq(aj) {
  const tramos = aj && Array.isArray(aj.tramosG) ? aj.tramosG : [];
  return `<div class="cfg-card mt-4 esq-ajustes">
    <h4 class="font-semibold text-sm mb-1">Ajuste por peso <span class="cfg-nota">se suma al margen de los tres canales según el peso de la presentación</span></h4>
    <p class="cfg-ayuda">Se usa el primer tramo cuyo "hasta" es mayor o igual al peso; más pesado que el último usa el último;
      una presentación sin peso cuenta como 1000 g. Sin tramos = sin ajuste.</p>
    <div class="flex gap-8 items-start flex-wrap">
      <div><table class="cfg-tabla"><thead><tr><th class="text-left">Hasta (g)</th><th class="text-left">Ajuste %</th><th></th></tr></thead>
        <tbody>${tramos.map((g, i) => htmlFilaTramoEsq(g, aj.puntos[i])).join('')}</tbody></table>
        <button type="button" class="esq-agregar-tramo cfg-btn2 mt-2" data-edita>＋ Agregar tramo</button></div>
      <div class="esq-generador"><h5 class="font-semibold text-xs mb-1">Generar tramos <span class="cfg-nota">cortes en escala log; el % baja lineal. Se aplica al guardar.</span></h5>
        <div class="flex gap-3 flex-wrap items-end">
          ${numGenEsq('Desde', 100, 'g', 'min="1"')}${numGenEsq('Hasta', 5000, 'g', 'min="1"')}
          ${numGenEsq('Tramos', 6, '#', `min="2" max="${PreciosEsquema.AJUSTES_PESO_MAX}" step="1"`)}
          ${numGenEsq('Más liviano', 15, '%', 'min="-100" max="100"')}${numGenEsq('Más pesado', -10, '%', 'min="-100" max="100"')}
          <button type="button" class="esq-generar cfg-btn2">Generar</button></div>
        <p class="esq-gen-msg text-xs text-crit mt-1" role="status" aria-live="polite"></p></div>
    </div></div>`;
}
// Tabla vacía → null (no se manda ajustesPeso = sin ajuste). Ordenada por gramos; lo inválido lo rechaza el server.
function leerAjustesPesoEsq(sec) {
  const filas = [...sec.querySelectorAll('.esq-tramo')].map(tr => ({ g: numOrNull(tr.querySelector('[data-k="g"]').value), p: numOrNull(tr.querySelector('[data-k="p"]').value) }))
    .sort((a, b) => (a.g ?? 0) - (b.g ?? 0));
  return filas.length ? { tramosG: filas.map(f => f.g), puntos: filas.map(f => f.p) } : null;
}
function generarTramosEsq(caja) {
  const v = k => numOrNull(caja.querySelector(`[data-gen="${k}"]`).value);
  const gen = PreciosEsquema.generarAjustesPeso({ desdeG: v('Desde'), hastaG: v('Hasta'), tramos: v('Tramos'), livianoPct: v('Más liviano'), pesadoPct: v('Más pesado') });
  const msg = caja.querySelector('.esq-gen-msg');
  msg.textContent = gen ? '' : `Revisá los datos: desde > 0, hasta > desde, de 2 a ${PreciosEsquema.AJUSTES_PESO_MAX} tramos (enteros) y % entre −100 y 100.`;
  if (!gen) return;
  const tbody = caja.querySelector('tbody');
  if (tbody.children.length && !confirm('Reemplazar los tramos actuales por los generados?')) return;
  tbody.innerHTML = gen.tramosG.map((g, i) => htmlFilaTramoEsq(g, gen.puntos[i])).join('');
  marcarSucio(caja.closest('[data-guardable]'));
}
// Clicks de la tarjeta (onclick, no addEventListener: se repinta en cada carga).
function clickAjustesPesoEsq(e) {
  const caja = e.currentTarget;
  if (e.target.closest('.esq-agregar-tramo')) caja.querySelector('tbody').insertAdjacentHTML('beforeend', htmlFilaTramoEsq());
  else if (e.target.closest('.esq-quitar-tramo')) { // ya sacada, el listener de data-edita no encuentra el bloque: se marca acá
    e.target.closest('tr').remove();
    marcarSucio(caja.closest('[data-guardable]'));
  }
  else if (e.target.closest('.esq-generar')) generarTramosEsq(caja);
}

function htmlMargenesEsq(m) {
  return `<section class="mb-6" data-guardable data-nombre="Márgenes">
    <div class="flex items-center gap-3 mb-2 flex-wrap">
      <button type="button" class="esq-rango cfg-btn2" title="Percentiles 5 y 95 de los costos de sistema de Reventa, Fraccionado ($/kg del granel) y Producción (consulta SIGA; no guarda)">Recalcular rango</button>
      <span class="esq-msg text-sm" role="status" aria-live="polite"></span>
      <button type="button" class="esq-guardar cfg-btn ml-auto">Guardar márgenes</button></div>
    <div class="grid grid-cols-3 gap-4">${Object.keys(CANALES_ESQ).map(c => htmlTablaMargenEsq(c, m[c] || {})).join('')}</div>
    <div class="cfg-card mt-4">
      <div class="cfg-campo"><label for="esqDtoDistrib">Descuento al margen para distribuidores</label>
        ${campoU(`<input id="esqDtoDistrib" type="number" step="any" min="0" max="99" value="${esc(m.descuentoDistribuidorPct ?? '')}" placeholder="0">`, 'puntos %', { w: 'w-28' })}</div>
      <p class="cfg-ayuda">Reventa con proveedor distribuidor: se resta del margen de los tres canales (ej. margen 50 % y descuento 5 → 45 %),
        después del ajuste del producto y antes de extras, IVA y redondeo. No aplica a un margen fijo del producto. Vacío = sin descuento.</p></div>
    <h3 class="cfg-h mt-4">Fraccionado <span class="cfg-nota">costo por kg del granel</span></h3>
    ${htmlAjustesPesoEsq(m.ajustesPeso)}</section>`;
}

async function recalcularRangoEsq(sec) {
  const msg = sec.querySelector('.esq-msg');
  msgEsq(msg, 'Consultando costos en SIGA…');
  try {
    const { rango, n } = await pedirEsq('POST', `${API_ESQ}/rango`);
    sec.querySelectorAll('[data-canal]').forEach(card => {
      card.querySelector('[data-k="desde"]').value = rango.desde;
      card.querySelector('[data-k="hasta"]').value = rango.hasta;
      card.removeAttribute('data-rango-estimado');
      pintarQuiebresEsq(card);
    });
    marcarSucio(sec);
    msgEsq(msg, `Rango con ${n} costos: $ ${fmtMoney(rango.desde)} – $ ${fmtMoney(rango.hasta)}. Guardá para aplicarlo.`, 'text-ok');
  } catch (e) { msgEsq(msg, e.message, 'text-crit'); }
}

function pintarMargenesEsq(panel, cfg) {
  panel.innerHTML = `<p class="cfg-cab"><b>Márgenes</b> — una tabla por canal, la misma para Reventa, Fraccionado y Producción. El margen
    baja en escalones del máximo (costos bajos) al mínimo (costos altos) entre "desde" y "hasta", en escala logarítmica. Pack y bulto no
    son descuentos del minorista: cada canal tiene su margen. En Fraccionado se suma además el ajuste por peso.</p>
    ${htmlMargenesEsq(cfg.margenes || {})}`;
  panel.querySelectorAll('[data-canal]').forEach(pintarQuiebresEsq);
  // oninput (no addEventListener): el panel persiste entre cargas y no hay que acumular listeners.
  panel.oninput = e => { const c = e.target.closest('[data-canal]'); if (c) pintarQuiebresEsq(c); };
  const sec = panel.querySelector('section[data-guardable]');
  sec.querySelector('.esq-rango').onclick = () => recalcularRangoEsq(sec);
  sec.querySelector('.esq-ajustes').onclick = clickAjustesPesoEsq;
  sec.querySelector('.esq-guardar').onclick = () => {
    const tablas = Object.fromEntries([...sec.querySelectorAll('[data-canal]')].map(c => [c.dataset.canal, leerTablaEsq(c)]));
    const aj = leerAjustesPesoEsq(sec);
    const descuentoDistribuidorPct = numOrNull(sec.querySelector('#esqDtoDistrib').value);
    guardarBloqueEsq(sec, `${API_ESQ}/margenes`, { ...tablas, ...(aj ? { ajustesPeso: aj } : {}), descuentoDistribuidorPct }, cargarMargenesEsq);
  };
}
