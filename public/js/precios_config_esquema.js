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
  </div>`;
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

// ── Márgenes: 9 tablas (tipo × canal) + grilla de quiebres en vivo + rango desde SIGA + ajuste por peso (Fraccionado) ──
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

function htmlAjustesPesoEsq(aj) {
  if (!aj || !Array.isArray(aj.tramosG) || !aj.tramosG.length) return '<p class="text-xs text-gris mt-2">Sin ajuste por peso.</p>';
  return `<div class="cfg-card mt-4 esq-ajustes" data-tramos="${esc(JSON.stringify(aj.tramosG))}">
    <h4 class="font-semibold text-sm mb-2">Ajuste por peso <span class="cfg-nota">se suma al margen de los tres canales según el peso de la presentación</span></h4>
    <div class="overflow-x-auto"><table class="cfg-tabla"><thead><tr><th class="text-left">Hasta (g)</th>${aj.tramosG.map(g => `<th>${esc(g)}</th>`).join('')}</tr></thead>
    <tbody><tr><td>Ajuste</td>${aj.puntos.map((p, i) => `<td>${campoU(`<input type="number" step="any" min="-100" max="100" data-tramo="${i}" value="${esc(p)}" aria-label="Ajuste hasta ${esc(aj.tramosG[i])} g">`, '%', { w: 'w-20' })}</td>`).join('')}</tr></tbody>
    </table></div></div>`;
}
const leerAjustesPesoEsq = sec => {
  const caja = sec.querySelector('.esq-ajustes');
  return caja ? { tramosG: JSON.parse(caja.dataset.tramos), puntos: [...caja.querySelectorAll('[data-tramo]')].map(i => numOrNull(i.value)) } : null;
};

function htmlTipoMargenesEsq(tipo, m) {
  return `<section class="mb-6" data-guardable data-nombre="Márgenes ${TIPOS_ESQ[tipo]}" data-tipo="${tipo}">
    <div class="flex items-center gap-3 mb-2 flex-wrap">
      <h3 class="cfg-h">${TIPOS_ESQ[tipo]}${tipo === 'fraccionado' ? ' <span class="cfg-nota">costo por kg del granel</span>' : ''}</h3>
      <button type="button" class="esq-rango cfg-btn2" title="Percentiles 5 y 95 de los costos de sistema del tipo (consulta SIGA; no guarda)">Recalcular rango</button>
      <span class="esq-msg text-sm" role="status" aria-live="polite"></span>
      <button type="button" class="esq-guardar cfg-btn ml-auto">Guardar ${TIPOS_ESQ[tipo]}</button></div>
    <div class="grid grid-cols-3 gap-4">${Object.keys(CANALES_ESQ).map(c => htmlTablaMargenEsq(c, m[c] || {})).join('')}</div>
    ${tipo === 'fraccionado' ? htmlAjustesPesoEsq(m.ajustesPeso) : ''}</section>`;
}

async function recalcularRangoEsq(sec, tipo) {
  const msg = sec.querySelector('.esq-msg');
  msgEsq(msg, 'Consultando costos en SIGA…');
  try {
    const { rango, n } = await pedirEsq('POST', `${API_ESQ}/rango/${tipo}`);
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
  panel.innerHTML = `<p class="cfg-cab"><b>Márgenes</b> — una tabla por tipo y canal. El margen baja en escalones del máximo (costos bajos) al mínimo
    (costos altos) entre "desde" y "hasta", en escala logarítmica. Pack y bulto no son descuentos del minorista: cada canal tiene su margen.</p>
    ${TIPOS_K.map(t => htmlTipoMargenesEsq(t, cfg.margenes[t] || {})).join('')}`;
  panel.querySelectorAll('[data-canal]').forEach(pintarQuiebresEsq);
  // oninput (no addEventListener): el panel persiste entre cargas y no hay que acumular listeners.
  panel.oninput = e => { const c = e.target.closest('[data-canal]'); if (c) pintarQuiebresEsq(c); };
  panel.querySelectorAll('section[data-tipo]').forEach(sec => {
    const tipo = sec.dataset.tipo;
    sec.querySelector('.esq-rango').onclick = () => recalcularRangoEsq(sec, tipo);
    sec.querySelector('.esq-guardar').onclick = () => {
      const tablas = Object.fromEntries([...sec.querySelectorAll('[data-canal]')].map(c => [c.dataset.canal, leerTablaEsq(c)]));
      const aj = leerAjustesPesoEsq(sec);
      guardarBloqueEsq(sec, `${API_ESQ}/margenes/${tipo}`, aj ? { ...tablas, ajustesPeso: aj } : tablas, cargarMargenesEsq);
    };
  });
}
