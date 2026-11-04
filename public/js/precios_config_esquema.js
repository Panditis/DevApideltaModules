// ── Precios · Configuración del esquema por canal: Costos, Márgenes y Precio (spec 2026-10-07 §3.3) ──
// Script clásico, cargado después de precios_config.js y de /js/precios_esquema.js (global PreciosEsquema = el mismo lib
// del server). Lee/guarda /api/precios/config/esquema (sólo con el permiso precios-config). Globales: esc, fmtMoney,
// numOrNull (precios_comun.js), campoU, marcarSucio, limpiarSucio (precios_config.js).
const API_ESQ = '/api/precios/config/esquema';
const TIPOS_ESQ = { almacen: 'Reventa', fraccionado: 'Fraccionado', produccion: 'Producción' };
const TIPOS_K = Object.keys(TIPOS_ESQ);
const REDONDEOS_ESQ = { minorista: 'Minorista', packNeto: 'Pack sin IVA', packIva: 'Pack con IVA', bultoNeto: 'Bulto sin IVA', bultoIva: 'Bulto con IVA' };
let cfgEsq = null; // última config leída

// Switch Reventa | Fraccionado (spec 2026-10-21 §2.4): cada tipo con sus valores; Producción usa los de Reventa. Se recuerda
// en la sesión. Los GET/PUT de Configuración van con ?tipo=fraccionado (urlEsq).
const CLAVE_TIPO_CFG = 'precios.tipoCfg';
let tipoCfgEsq = (() => { try { return sessionStorage.getItem(CLAVE_TIPO_CFG) === 'fraccionado' ? 'fraccionado' : 'almacen'; } catch { return 'almacen'; } })();
const esFraccCfg = () => tipoCfgEsq === 'fraccionado';
const urlEsq = (ruta = '') => `${API_ESQ}${ruta}${esFraccCfg() ? '?tipo=fraccionado' : ''}`;

async function pedirEsq(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j;
}
// La comparten Costos, Márgenes, Precio y el Simulador. Sin migrar: aviso arriba de Configuración.
// null si el tipo del switch cambió mientras tanto: manda la carga del tipo nuevo (sin carreras al alternar rápido).
async function leerCfgEsq() {
  const tipo = tipoCfgEsq;
  const cfg = await pedirEsq('GET', urlEsq());
  if (tipo !== tipoCfgEsq) return null;
  cfgEsq = cfg;
  document.getElementById('cfgEsqAviso').classList.toggle('hidden', cfgEsq.migrado);
  document.getElementById('cfgFraccAviso').classList.toggle('hidden', !esFraccCfg() || cfgEsq.fraccionadoMigrado);
  return cfgEsq;
}
const msgEsq = (el, txt, cls = 'text-ink/50') => { if (el) { el.className = `esq-msg text-sm ${cls}`; el.textContent = txt; } };
const pctEsq = n => `${String(+(+n).toFixed(2)).replace('.', ',')} %`;

async function cargarPanelEsq(id, pintar) {
  const panel = document.getElementById(id);
  panel.innerHTML = '<div class="text-sm text-ink/50 py-4"><span class="spin"></span> Cargando…</div>';
  try { const cfg = await leerCfgEsq(); if (cfg) pintar(panel, cfg); }
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
// Fraccionado no tiene tildes (su tabla es sólo suya); Reventa muestra Reventa y Producción, y también Fraccionado mientras
// no se migre (hasta entonces Fraccionado usa estas tablas). Las columnas ocultas quedan en el DOM (class hidden) para que
// leerItemsEsq guarde su valor tal cual.
const tiposVisiblesEsq = cfg => (esFraccCfg() ? [] : cfg.fraccionadoMigrado ? ['almacen', 'produccion'] : TIPOS_K);
const tildesNuevoEsq = () => (esFraccCfg() ? { almacen: false, fraccionado: true, produccion: false } : { almacen: true, fraccionado: true, produccion: true });
const ocultaSi = (vis, t) => (vis.includes(t) ? '' : ' hidden');

function htmlFilaItemEsq(it = {}, vis = TIPOS_K) {
  return `<tr data-id="${esc(it.id || '')}">
    <td class="py-1 pr-2"><input class="num-in w-full text-left" data-k="concepto" value="${esc(it.concepto || '')}" aria-label="Concepto"></td>
    <td class="py-1 pr-2">${campoU(`<input type="number" step="any" min="0" max="100" data-k="pct" value="${esc(it.pct ?? '')}" aria-label="Porcentaje">`, '%', { w: 'w-24' })}</td>
    ${TIPOS_K.map(t => `<td class="py-1 text-center${ocultaSi(vis, t)}"><input type="checkbox" class="accent-verde" data-tipo="${t}"${it.tipos && it.tipos[t] ? ' checked' : ''} aria-label="${TIPOS_ESQ[t]}"></td>`).join('')}
    <td class="py-1 pl-2"><button type="button" class="esq-quitar text-gris hover:text-crit" data-edita aria-label="Quitar">✕</button></td></tr>`;
}
// Valor de la energía de Fraccionado ($/kWh, spec 2026-11-03): campo propio de la tarjeta Gastos variables, no un ítem (no cuenta en el total %).
// Vacío = sin cargar (se manda null).
const NOTA_ENERGIA_ESQ = 'No es un porcentaje: se usa con el consumo de cada máquina';
const htmlValorEnergiaEsq = valor => `<div class="cfg-campo mt-3 pt-3 border-t border-borde"><label for="esqValorEnergia">Valor de la energía ($/kWh) <span class="cfg-nota">${NOTA_ENERGIA_ESQ}</span></label>
    ${campoU(`<input id="esqValorEnergia" type="number" step="any" min="0" max="100000" value="${esc(valor ?? '')}" placeholder="ej. 120">`, '$/kWh', { w: 'w-32' })}</div>`;
function htmlItemsEsq(lista, titulo, ayuda, items, vis, extra = '') {
  return `<div class="cfg-card min-w-0" data-lista="${lista}" data-vis="${vis.join(',')}">
    <h3 class="cfg-h">${esc(titulo)}</h3><p class="cfg-ayuda">${esc(ayuda)}</p>
    <table class="cfg-tabla w-full mt-2"><thead><tr><th class="text-left">Concepto</th><th class="text-left">%</th>
      ${TIPOS_K.map(t => `<th class="${ocultaSi(vis, t).trim()}">${TIPOS_ESQ[t]}</th>`).join('')}<th></th></tr></thead>
      <tbody>${items.map(it => htmlFilaItemEsq(it, vis)).join('')}</tbody></table>
    <div class="flex items-center gap-3 mt-2"><button type="button" class="esq-agregar cfg-btn2" data-edita>+ Agregar</button>
      <span class="esq-totales text-xs text-gris"></span></div>${extra}</div>`;
}
function leerItemsEsq(card) {
  return [...card.querySelectorAll('tbody tr')].map(tr => ({
    ...(tr.dataset.id ? { id: tr.dataset.id } : {}),
    concepto: tr.querySelector('[data-k="concepto"]').value.trim(),
    pct: numOrNull(tr.querySelector('[data-k="pct"]').value),
    tipos: Object.fromEntries(TIPOS_K.map(t => [t, tr.querySelector(`[data-tipo="${t}"]`).checked])),
  }));
}
// Total por tipo visible; Fraccionado (sin tildes) un solo total.
function pintarTotalesEsq(card) {
  const items = leerItemsEsq(card).filter(it => it.pct != null);
  const vis = card.dataset.vis ? card.dataset.vis.split(',') : [];
  card.querySelector('.esq-totales').textContent = 'Total: ' + (vis.length
    ? vis.map(t => `${TIPOS_ESQ[t]} ${pctEsq(PreciosEsquema.pctItems(items, t))}`).join(' · ')
    : pctEsq(PreciosEsquema.pctItems(items, 'fraccionado')));
}
function pintarCostosEsq(panel, cfg) {
  const vis = tiposVisiblesEsq(cfg);
  const cab = esFraccCfg()
    ? '<b>Costos de Fraccionado</b> — se suman al costo $/kg del granel. Los gastos variables valen para los tres canales; los extras, sólo para el minorista.'
    : '<b>Costos de Reventa y Producción</b> — se suman al costo de mercadería. Los gastos variables valen para los tres canales; los extras, sólo para el minorista. Cada ítem se aplica a los tipos tildados.';
  panel.innerHTML = `<p class="cfg-cab">${cab}</p>
  <div data-guardable data-nombre="Costos">
    <div class="cfg-card mb-4"><h3 class="cfg-h">Cómo se aplican los gastos variables</h3>
      <div class="seg seg-sub mt-2" role="group" aria-label="Modo de los gastos variables">
        <button type="button" class="seg-opt" data-modo="costo" data-edita aria-pressed="${cfg.modoGastos === 'costo'}">Sobre costo · costo × (1 + %)</button>
        <button type="button" class="seg-opt" data-modo="precio" data-edita aria-pressed="${cfg.modoGastos === 'precio'}">Sobre precio · costo ÷ (1 − %)</button>
      </div></div>
    <div class="cfg-grid">
      ${htmlItemsEsq('gastosVenta', 'Gastos variables', 'Sobre el costo de mercadería, antes del margen de cada canal.', cfg.gastosVenta, vis, esFraccCfg() ? htmlValorEnergiaEsq(cfg.valorEnergiaKwh) : '')}
      ${htmlItemsEsq('extrasMinorista', 'Costos extras minoristas', 'Markup sobre el neto minorista, antes del IVA (ej. IIBB, débitos y créditos).', cfg.extrasMinorista, vis)}
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
    if (agregar) agregar.closest('[data-lista]').querySelector('tbody').insertAdjacentHTML('beforeend', htmlFilaItemEsq({ tipos: tildesNuevoEsq() }, vis));
    const quitar = e.target.closest('.esq-quitar');
    if (quitar) { const c = quitar.closest('[data-lista]'); quitar.closest('tr').remove(); pintarTotalesEsq(c); }
  });
  bloque.querySelector('.esq-guardar').onclick = () => {
    const lista = k => leerItemsEsq(bloque.querySelector(`[data-lista="${k}"]`));
    guardarBloqueEsq(bloque, urlEsq('/costos'), {
      modoGastos: bloque.querySelector('[data-modo][aria-pressed="true"]').dataset.modo,
      gastosVenta: lista('gastosVenta'), extrasMinorista: lista('extrasMinorista'),
      ...(esFraccCfg() ? { valorEnergiaKwh: numOrNull(bloque.querySelector('#esqValorEnergia').value) } : {}), // sólo Fraccionado
    }, cargarCostosEsq);
  };
}

// ── Costo hora de mano de obra (minutos × costo hora ÷ 60), del tipo del switch. Guardado aparte (PUT …/costo-hora). ──
function htmlCostoHoraEsq(cfg) {
  const ayuda = esFraccCfg()
    ? 'Fraccionado: los minutos de cada presentación × este costo ÷ 60 se suman a su costo. Vacío = sin mano de obra.'
    : 'Producción: los minutos por unidad de cada presentación y PLU envasado × este costo ÷ 60 se suman a su costo real (mercadería + insumos + mano de obra). Vacío = sin mano de obra.';
  return `<div class="cfg-grid cfg-grid-angosta mt-4"><div class="cfg-card min-w-0" data-guardable data-nombre="Costo hora" id="esqCostoHoraCard">
    <h3 class="cfg-h">Costo hora de mano de obra</h3>
    <p class="cfg-ayuda">${esc(ayuda)}</p>
    <div class="cfg-campo"><label for="esqCostoHora">Costo hora <span class="cfg-nota">$ por hora de trabajo</span></label>
      ${campoU(`<input id="esqCostoHora" type="number" step="any" min="0" value="${esc(cfg.costoHora ?? '')}" placeholder="ej. 8268">`, '$/h', { w: 'w-32' })}</div>
    <div class="cfg-pie"><span class="esq-msg text-sm" role="status" aria-live="polite"></span><button type="button" class="esq-guardar-hora cfg-btn">Guardar</button></div>
  </div></div>`;
}
function conectarCostoHoraEsq(panel) {
  const card = panel.querySelector('#esqCostoHoraCard');
  card.querySelector('.esq-guardar-hora').onclick = () => guardarBloqueEsq(card, urlEsq('/costo-hora'),
    { costoHora: numOrNull(card.querySelector('#esqCostoHora').value) }, () => msgEsq(card.querySelector('.esq-msg'), 'Guardado', 'text-ok')); // sin repintar: no pisa los gastos sin guardar
}

// ── Precio: IVA de venta, tolerancia y redondeo por lista ──
function pintarPrecioEsq(panel, cfg) {
  const num = (id, v, u, pre = false, extra = '') =>
    campoU(`<input id="${id}" type="number" step="any" min="0" value="${esc(v ?? '')}" ${extra}>`, u, { pre, w: 'w-32' });
  panel.innerHTML = `<p class="cfg-cab"><b>Precio${esFraccCfg() ? ' de Fraccionado' : ' de Reventa y Producción'}</b> — IVA de venta (minorista y listas mayoristas con IVA), redondeo de cada lista y tolerancia del semáforo.</p>
  <div class="cfg-grid cfg-grid-angosta"><div class="cfg-card min-w-0" data-guardable data-nombre="Precio">
    <div class="cfg-campo"><label for="esqIva">IVA de venta</label>${num('esqIva', cfg.ivaVentaPct, '%', false, 'max="100"')}</div>
    <div class="cfg-campo"><label for="esqTol">Tolerancia del semáforo <span class="cfg-nota">diferencias dentro de ± este % no se resaltan</span></label>${num('esqTol', cfg.toleranciaPct, '%', false, 'max="100"')}</div>
    <h4 class="font-semibold text-sm mt-4 mb-1">Redondeo <span class="cfg-nota">múltiplo en $; 0 = exacto. Si el exacto queda a menos de $0,50 del vigente, se respeta el vigente.</span></h4>
    ${Object.entries(REDONDEOS_ESQ).map(([k, t]) => `<div class="cfg-campo"><label for="esqRed-${k}">${t}</label>${num(`esqRed-${k}`, cfg.redondeo[k], '$', true)}</div>`).join('')}
    <div class="cfg-pie"><span class="esq-msg text-sm" role="status" aria-live="polite"></span><button type="button" class="esq-guardar cfg-btn">Guardar</button></div>
  </div></div>`;
  const card = panel.querySelector('[data-guardable]');
  const v = id => numOrNull(document.getElementById(id).value);
  card.querySelector('.esq-guardar').onclick = () => guardarBloqueEsq(card, urlEsq('/precio'), {
    ivaVentaPct: v('esqIva'), toleranciaPct: v('esqTol'),
    redondeo: Object.fromEntries(Object.keys(REDONDEOS_ESQ).map(k => [k, v(`esqRed-${k}`)])),
  }, cargarPrecioEsq);
}

// ── Márgenes: tablas por canal (Reventa/Producción: 3; Fraccionado: sólo minorista) + rango desde SIGA ──
// Reventa/Producción: generador (máx/mín/escalones/rango) + grilla de quiebres en vivo, de sólo lectura. Fraccionado: filas editables
// (corte y margen) y el generador aparte, que las llena. Una tarjeta de Fraccionado es manual (data-manual: sus filas se guardan tal
// cual, `filas` en la tabla) o automática (las filas siguen al generador y se guardan sin `filas`).
// (El ajuste por peso de Fraccionado se edita en Costeo Fraccionado: precios_config_fraccionado.js.)
const CANALES_ESQ = { minorista: 'Minorista', pack: 'Mayorista pack', bulto: 'Mayorista bulto' };
// Fraccionado sólo tiene la tabla del minorista: pack y bulto salen de los descuentos mayoristas (las tablas pack/bulto guardadas no se tocan).
const canalesMargenEsq = () => (esFraccCfg() ? ['minorista'] : Object.keys(CANALES_ESQ));
const cargarMargenesEsq = () => cargarPanelEsq('panel-margenes', pintarMargenesEsq);
const chipEsq = (txt, title = '', cls = 'bg-warn/15 text-warn') => `<span class="px-1.5 py-0.5 rounded text-[11px] font-semibold ${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(txt)}</span>`;
const CHIP_MANUAL_ESQ = chipEsq('Tabla manual', 'Las filas se guardan tal cual; el generador no las toca hasta que toques Generar', 'bg-verde/10 text-verde');
const AVISO_MANUAL_ESQ = 'Tabla manual: estos valores no cambian las filas. Generar las reemplaza.';
const FILA_VACIA_ESQ = { hasta: null, margenPct: null }; // generador todavía inválido: sólo la fila "en adelante", sin margen

// Filas (puras). Siempre hay al menos una y la última es "en adelante" (sin corte).
const soloGeneradorEsq = ({ filas, ...gen }) => gen;
function filasDeTablaEsq(t) { // las manuales guardadas, o las que da el generador
  if (Array.isArray(t.filas)) return t.filas;
  const gen = soloGeneradorEsq(t);
  return PreciosEsquema.validarTablaMargen(gen) ? [FILA_VACIA_ESQ] : PreciosEsquema.quiebres(gen);
}
// Agregar: antes de la última, con su margen y el corte vacío. Quitar: nunca la única; si era la última, la anterior pasa a "en adelante".
const filasConNuevaEsq = filas => [...filas.slice(0, -1), { hasta: null, margenPct: filas[filas.length - 1].margenPct }, filas[filas.length - 1]];
function filasSinEsq(filas, i) {
  if (filas.length < 2) return filas;
  const resto = filas.filter((_, j) => j !== i);
  return resto.map((f, j) => (j === resto.length - 1 ? { ...f, hasta: null } : f));
}
// Cortes ascendentes en las filas con corte (el vacío, al final de ellas); la última queda al final.
const ordenarFilasEsq = filas => [...filas.slice(0, -1).sort((a, b) => (a.hasta ?? Infinity) - (b.hasta ?? Infinity)), filas[filas.length - 1]];
const textoManualesEsq = nombres => (nombres.length ? ` Tabla manual en ${nombres.join(', ')}: sus filas no cambian, tocá Generar para aplicarlo.` : '');

function htmlFilaMargenEsq(f, i, n, canal) {
  const donde = `${CANALES_ESQ[canal]}, fila ${i + 1}`;
  const corte = i === n - 1 ? '<span class="text-sm text-gris">en adelante</span>'
    : campoU(`<input type="number" step="any" min="0" data-f="hasta" value="${esc(f.hasta ?? '')}" aria-label="${donde}: costo menor a ($/kg)">`, '$', { pre: true, w: 'w-28' });
  return `<tr class="esq-fila"><td>${corte}</td>
    <td>${campoU(`<input type="number" step="any" data-f="margenPct" value="${esc(f.margenPct ?? '')}" aria-label="${donde}: margen (%)">`, '%', { w: 'w-24' })}</td>
    <td><button type="button" class="esq-quitar-fila btn-quitar" aria-label="Quitar ${donde}"${n === 1 ? ' disabled' : ''}>✕</button></td></tr>`;
}
const htmlFilasMargenEsq = (canal, filas) => filas.map((f, i) => htmlFilaMargenEsq(f, i, filas.length, canal)).join('');

function htmlGeneradorEsq(canal, t) {
  const r = t.rango || {};
  const campo = (k, rotulo, v, u, extra = '', pre = false) => `<div class="cfg-campo"><label for="esq-${canal}-${k}">${rotulo}</label>
    ${campoU(`<input type="number" step="any" id="esq-${canal}-${k}" data-k="${k}" value="${esc(v ?? '')}" ${extra}>`, u, { pre, w: 'w-28' })}</div>`;
  return campo('maxPct', 'Margen máximo <span class="cfg-nota">costos bajos</span>', t.maxPct, '%')
    + campo('minPct', 'Margen mínimo <span class="cfg-nota">costos altos</span>', t.minPct, '%')
    + campo('escalones', 'Escalones', t.escalones, '#', 'min="1" max="30" step="1"')
    + campo('desde', 'Rango desde', r.desde, '$', 'min="0"', true)
    + campo('hasta', 'Rango hasta', r.hasta, '$', 'min="0"', true);
}
// Fraccionado: tabla de filas, error en vivo (role=status) y generador con su botón.
const htmlCuerpoEditableEsq = (canal, t, manual) => `<table class="cfg-tabla fr-filas esq-filas w-full"><thead><tr>
      <th class="text-left">Costo menor a ($/kg)</th><th class="text-left">Margen (%)</th><th><span class="sr-only">Quitar</span></th></tr></thead>
      <tbody>${htmlFilasMargenEsq(canal, filasDeTablaEsq(t))}</tbody></table>
    <button type="button" class="esq-agregar-fila cfg-btn2 mt-2">+ Agregar fila</button>
    <p class="esq-error text-xs text-crit mt-2" role="status" aria-live="polite"></p>
    <div class="mt-3 pt-3 border-t border-borde"><h5 class="font-semibold text-sm">Generar la tabla</h5>
      <p class="text-xs text-gris mb-2">Llena las filas con un margen que baja del máximo al mínimo, en escala logarítmica entre "desde" y "hasta".</p>
      ${htmlGeneradorEsq(canal, t)}
      <button type="button" class="esq-generar cfg-btn2 mt-2">Generar</button>
      <p class="esq-aviso-manual text-xs text-gris mt-2">${manual ? AVISO_MANUAL_ESQ : ''}</p></div>`;

function htmlTablaMargenEsq(canal, t, editable = false) {
  const manual = editable && Array.isArray(t.filas);
  return `<div class="cfg-card min-w-0" data-canal="${canal}"${t.rangoEstimado ? ' data-rango-estimado' : ''}${manual ? ' data-manual' : ''}>
    <h4 class="font-semibold text-sm mb-2 flex items-center gap-2 flex-wrap">${CANALES_ESQ[canal]}
      ${t.sinConfigurar ? chipEsq('sin configurar', 'Copia del minorista: revisalo y guardá') : ''}
      ${t.rangoEstimado ? chipEsq('rango estimado', 'Rango de arranque: tocá Recalcular rango') : ''}
      ${editable ? `<span class="esq-chip-manual contents">${manual ? CHIP_MANUAL_ESQ : ''}</span>` : ''}</h4>
    ${editable ? htmlCuerpoEditableEsq(canal, t, manual) : `${htmlGeneradorEsq(canal, t)}<div class="esq-quiebres mt-3 text-xs"></div>`}</div>`;
}

const esManualEsq = card => card.hasAttribute('data-manual');
const esEditableEsq = card => !!card.querySelector('.esq-filas');
// Filas en el orden de la pantalla (la última sin corte); lo vacío o inválido queda null y lo rechaza la validación.
function leerFilasEsq(card) {
  const lee = (tr, k) => { const i = tr.querySelector(`[data-f="${k}"]`); return i ? numOrNull(i.value) : null; };
  return [...card.querySelectorAll('.esq-fila')].map(tr => ({ hasta: lee(tr, 'hasta'), margenPct: lee(tr, 'margenPct') }));
}
function leerGeneradorEsq(card) {
  const v = k => numOrNull(card.querySelector(`[data-k="${k}"]`).value);
  return { minPct: v('minPct'), maxPct: v('maxPct'), escalones: v('escalones'), rango: { desde: v('desde'), hasta: v('hasta') },
    ...(card.hasAttribute('data-rango-estimado') ? { rangoEstimado: true } : {}) };
}
// Sólo una tarjeta manual manda `filas` (ordenadas por corte); la automática, el generador solo.
const leerTablaEsq = card => ({ ...leerGeneradorEsq(card), ...(esManualEsq(card) ? { filas: ordenarFilasEsq(leerFilasEsq(card)) } : {}) });

function marcarManualEsq(card, manual) {
  if (esManualEsq(card) === manual) return;
  card.toggleAttribute('data-manual', manual);
  card.querySelector('.esq-chip-manual').innerHTML = manual ? CHIP_MANUAL_ESQ : '';
  card.querySelector('.esq-aviso-manual').textContent = manual ? AVISO_MANUAL_ESQ : '';
}
const pintarFilasEsq = (card, filas) => { card.querySelector('.esq-filas tbody').innerHTML = htmlFilasMargenEsq(card.dataset.canal, filas); };

// Reventa/Producción: grilla de quiebres (sólo lectura) con el mismo cálculo del server. Fraccionado: error de la tabla (sin grilla; las
// filas de una tarjeta automática siguen al generador, las de una manual no se tocan). Tabla inválida → el mensaje de validación.
function pintarQuiebresEsq(card) {
  const t = leerTablaEsq(card);
  const err = PreciosEsquema.validarTablaMargen(t);
  if (esEditableEsq(card)) {
    if (!esManualEsq(card) && !err) pintarFilasEsq(card, PreciosEsquema.quiebres(t));
    card.querySelector('.esq-error').textContent = err || '';
    return;
  }
  const desde = (qs, i) => (i ? `≥ $ ${fmtMoney(qs[i - 1].hasta)}` : 'todos');
  card.querySelector('.esq-quiebres').innerHTML = err ? `<p class="text-crit">${esc(err)}</p>`
    : `<table class="w-full"><thead><tr class="text-gris"><th class="text-left font-normal">Costo</th><th class="text-right font-normal">Margen</th></tr></thead><tbody>
      ${PreciosEsquema.quiebres(t).map((q, i, qs) => `<tr><td>${q.hasta == null ? desde(qs, i) : `< $ ${fmtMoney(q.hasta)}`}</td>
        <td class="text-right tabular-nums">${pctEsq(q.margenPct)}</td></tr>`).join('')}</tbody></table>`;
}

// Mayorista: descuentos de Fraccionado (sólo ese tipo). Pack = minorista $/kg sin IVA − descPackPct; bulto = pack − descBultoPct. Texto con coma o punto.
const DESC_MAYORISTA_DEF = { descPackPct: 10, descBultoPct: 10 }; // ausente en la respuesta = 10 y 10
const CAMPOS_MAYORISTA_ESQ = { descPackPct: 'Descuento precio pack', descBultoPct: 'Descuento precio bulto' };
const AYUDA_MAYORISTA_ESQ = 'Pack = precio por kg minorista sin IVA menos el descuento pack. Bulto = precio pack menos el descuento bulto. Aplica a las presentaciones mayoristas y a los productos pack y bulto vinculados.';
function pctDeTextoEsq(txt) { // "10,5" / "10.5" → 10.5; vacío o inválido → null
  const s = String(txt ?? '').trim().replace(',', '.');
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}
const mayoristaEfectivoEsq = m => ({ ...DESC_MAYORISTA_DEF, ...Object.fromEntries(Object.keys(DESC_MAYORISTA_DEF).filter(k => m && Number.isFinite(m[k])).map(k => [k, m[k]])) });
function validarMayoristaEsq(v) { // '' si está bien; si no, el mensaje del primer campo malo
  for (const [k, rotulo] of Object.entries(CAMPOS_MAYORISTA_ESQ)) {
    if (v[k] == null) return `${rotulo}: ingresá un número (coma o punto).`;
    if (v[k] < 0 || v[k] >= 100) return `${rotulo}: debe ser mayor o igual a 0 y menor a 100.`;
  }
  return '';
}
const leerMayoristaEsq = card => Object.fromEntries(Object.keys(CAMPOS_MAYORISTA_ESQ).map(k => [k, pctDeTextoEsq(card.querySelector(`[data-k="${k}"]`).value)]));
function htmlMayoristaEsq(m) {
  const v = mayoristaEfectivoEsq(m);
  const campo = k => `<div class="cfg-campo"><label for="esqMay-${k}">${CAMPOS_MAYORISTA_ESQ[k]} (%)</label>
    ${campoU(`<input type="text" inputmode="decimal" id="esqMay-${k}" data-k="${k}" value="${esc(String(v[k]).replace('.', ','))}" aria-describedby="esqMayAyuda esqMayError">`, '%', { w: 'w-28' })}</div>`;
  return `<div class="cfg-card mt-4" data-mayorista><h3 class="cfg-h">Mayorista: descuentos</h3>
    <p class="cfg-ayuda" id="esqMayAyuda">${AYUDA_MAYORISTA_ESQ}</p>
    <div class="flex gap-6 flex-wrap">${Object.keys(CAMPOS_MAYORISTA_ESQ).map(campo).join('')}</div>
    <p class="esq-error-may text-xs text-crit mt-2" id="esqMayError" role="status" aria-live="polite"></p></div>`;
}
// Error en vivo de la tarjeta (aria-invalid en los campos); devuelve el mensaje ('' = válido).
function pintarMayoristaEsq(card) {
  const err = validarMayoristaEsq(leerMayoristaEsq(card));
  card.querySelector('.esq-error-may').textContent = err;
  const msg = card.closest('section').querySelector('.esq-msg');
  if (!err && msg.textContent.startsWith('Corregí')) msg.textContent = ''; // aviso de guardado bloqueado, ya resuelto
  card.querySelectorAll('[data-k]').forEach(i => i.setAttribute('aria-invalid', String(!!err && err.startsWith(CAMPOS_MAYORISTA_ESQ[i.dataset.k]))));
  return err;
}

// Reventa/Producción: las tres tablas y el descuento al distribuidor. Fraccionado: la tabla del minorista y los descuentos mayoristas (sin descuento al distribuidor).
function htmlMargenesEsq(m, cfg) {
  const tituloRango = esFraccCfg()
    ? 'Percentiles 5 y 95 de los costos $/kg de los graneles de Fraccionado (consulta SIGA; no guarda)'
    : `Percentiles 5 y 95 de los costos de sistema de Reventa y Producción${cfg.fraccionadoMigrado ? '' : ' y Fraccionado'} (consulta SIGA; no guarda)`;
  return `<section class="mb-6" data-guardable data-nombre="Márgenes">
    <div class="flex items-center gap-3 mb-2 flex-wrap">
      <button type="button" class="esq-rango cfg-btn2" title="${esc(tituloRango)}">Recalcular rango</button>
      <span class="esq-msg text-sm" role="status" aria-live="polite"></span>
      <button type="button" class="esq-guardar cfg-btn ml-auto">Guardar márgenes</button></div>
    <div class="grid ${esFraccCfg() ? 'grid-cols-1 max-w-xl' : 'grid-cols-3'} gap-4">${canalesMargenEsq().map(c => htmlTablaMargenEsq(c, m[c] || {}, esFraccCfg())).join('')}</div>
    ${esFraccCfg() ? '' : `<div class="cfg-card mt-4">
      <div class="cfg-campo"><label for="esqDtoDistrib">Descuento al margen para distribuidores</label>
        ${campoU(`<input id="esqDtoDistrib" type="number" step="any" min="0" max="99" value="${esc(m.descuentoDistribuidorPct ?? '')}" placeholder="0">`, 'puntos %', { w: 'w-28' })}</div>
      <p class="cfg-ayuda">Reventa con proveedor distribuidor: se resta del margen de los tres canales (ej. margen 50 % y descuento 5 → 45 %),
        después del ajuste del producto y antes de extras, IVA y redondeo. No aplica a un margen fijo del producto. Vacío = sin descuento.</p></div>`}
    ${esFraccCfg() ? htmlMayoristaEsq(m.mayorista) : ''}</section>`;
}

async function recalcularRangoEsq(sec) {
  const msg = sec.querySelector('.esq-msg');
  msgEsq(msg, 'Consultando costos en SIGA…');
  try {
    const { rango, n } = await pedirEsq('POST', urlEsq('/rango'));
    const cards = [...sec.querySelectorAll('[data-canal]')];
    cards.forEach(card => {
      card.querySelector('[data-k="desde"]').value = rango.desde;
      card.querySelector('[data-k="hasta"]').value = rango.hasta;
      card.removeAttribute('data-rango-estimado');
      pintarQuiebresEsq(card); // las tarjetas manuales no repintan sus filas
    });
    marcarSucio(sec);
    const manuales = cards.filter(esManualEsq).map(c => CANALES_ESQ[c.dataset.canal]);
    msgEsq(msg, `Rango con ${n} costos: $ ${fmtMoney(rango.desde)} – $ ${fmtMoney(rango.hasta)}. Guardá para aplicarlo.${textoManualesEsq(manuales)}`, 'text-ok');
  } catch (e) { msgEsq(msg, e.message, 'text-crit'); }
}

// Fraccionado: agregar, quitar y generar filas. Cambiar las filas pasa la tarjeta a manual y ensucia la sección (explícito: al quitar, la
// fila ya salió del DOM y el listener de data-edita no encuentra la tarjeta). El foco va a la fila que quedó en `foco`.
function cambiarFilasEsq(sec, card, filas, foco) {
  pintarFilasEsq(card, filas);
  marcarManualEsq(card, true);
  marcarSucio(sec);
  pintarQuiebresEsq(card);
  const fila = card.querySelectorAll('.esq-fila')[foco];
  const campo = fila && (fila.querySelector('[data-f="hasta"]') || fila.querySelector('[data-f="margenPct"]'));
  if (campo) campo.focus();
}
// Generar: filas desde el generador y la tarjeta vuelve a automática (se guarda sin `filas`). Pisar una manual pide confirmar.
async function generarFilasEsq(sec, card) {
  const gen = leerGeneradorEsq(card);
  const err = PreciosEsquema.validarTablaMargen(gen);
  if (err) { card.querySelector('.esq-error').textContent = `No se puede generar: ${err}`; return; }
  const eraManual = esManualEsq(card);
  if (eraManual && !(await confirmar(`¿Reemplazar las filas de ${CANALES_ESQ[card.dataset.canal]} por las generadas? Se pierde lo editado a mano.`, { textoOk: 'Reemplazar' }))) return; // precios_config.js
  marcarManualEsq(card, false);
  pintarFilasEsq(card, PreciosEsquema.quiebres(gen));
  pintarQuiebresEsq(card);
  if (eraManual) marcarSucio(sec);
}
function clickFilasEsq(sec, e) {
  const card = e.target.closest('[data-canal]'), b = e.target.closest('button');
  if (!card || !b || !esEditableEsq(card)) return;
  const filas = leerFilasEsq(card);
  if (b.classList.contains('esq-agregar-fila')) cambiarFilasEsq(sec, card, filasConNuevaEsq(filas), filas.length - 1);
  else if (b.classList.contains('esq-quitar-fila')) {
    const i = [...card.querySelectorAll('.esq-fila')].indexOf(b.closest('tr')), nuevas = filasSinEsq(filas, i);
    cambiarFilasEsq(sec, card, nuevas, Math.min(i, nuevas.length - 1));
  } else if (b.classList.contains('esq-generar')) generarFilasEsq(sec, card);
}

function pintarMargenesEsq(panel, cfg) {
  const cab = esFraccCfg()
    ? '<b>Márgenes de Fraccionado</b> — la tabla del minorista sobre el costo $/kg: cada fila es el margen de los costos menores a su corte y la última vale en adelante. Editá cortes y márgenes a mano, o generá la tabla desde el máximo, el mínimo, los escalones y el rango. Pack y bulto no tienen tabla: salen de los descuentos mayoristas sobre el precio minorista. El ajuste por peso de la presentación se configura en Costeo Fraccionado.'
    : '<b>Márgenes de Reventa y Producción</b> — una tabla por canal. El margen baja en escalones del máximo (costos bajos) al mínimo (costos altos) entre "desde" y "hasta", en escala logarítmica. Pack y bulto no son descuentos del minorista: cada canal tiene su margen.';
  panel.innerHTML = `<p class="cfg-cab">${cab}</p>
    ${htmlMargenesEsq(cfg.margenes || {}, cfg)}`;
  panel.querySelectorAll('[data-canal]').forEach(pintarQuiebresEsq);
  // oninput (no addEventListener): el panel persiste entre cargas y no hay que acumular listeners.
  panel.oninput = e => {
    const may = e.target.closest('[data-mayorista]');
    if (may) { pintarMayoristaEsq(may); return; }
    const c = e.target.closest('[data-canal]');
    if (!c) return;
    if (e.target.closest('.esq-fila')) marcarManualEsq(c, true); // editar una fila la pasa a manual
    pintarQuiebresEsq(c);
  };
  const sec = panel.querySelector('section[data-guardable]');
  sec.onclick = e => clickFilasEsq(sec, e); // onclick: la sección se repinta al guardar
  sec.querySelector('.esq-rango').onclick = () => recalcularRangoEsq(sec);
  sec.querySelector('.esq-guardar').onclick = () => {
    const tablas = Object.fromEntries([...sec.querySelectorAll('[data-canal]')].map(c => [c.dataset.canal, leerTablaEsq(c)]));
    const dto = sec.querySelector('#esqDtoDistrib');
    const may = sec.querySelector('[data-mayorista]');
    if (may && pintarMayoristaEsq(may)) { msgEsq(sec.querySelector('.esq-msg'), 'Corregí los descuentos mayoristas antes de guardar.', 'text-crit'); may.querySelector('[aria-invalid="true"]').focus(); return; }
    guardarBloqueEsq(sec, urlEsq('/margenes'), { ...tablas, ...(dto ? { descuentoDistribuidorPct: numOrNull(dto.value) } : {}),
      ...(may ? { mayorista: leerMayoristaEsq(may) } : {}) }, cargarMargenesEsq); // Fraccionado: siempre manda mayorista (reemplazo total)
  };
}

// Helpers de la tabla manual de Fraccionado para test (puros, y los que leen una tarjeta).
if (typeof module === 'object' && module.exports) module.exports = { htmlMargenesEsq, htmlValorEnergiaEsq, htmlTablaMargenEsq, htmlFilaMargenEsq, htmlFilasMargenEsq, filasDeTablaEsq,
  filasConNuevaEsq, filasSinEsq, ordenarFilasEsq, textoManualesEsq, esManualEsq, leerFilasEsq, leerGeneradorEsq, leerTablaEsq,
  canalesMargenEsq, pctDeTextoEsq, mayoristaEfectivoEsq, validarMayoristaEsq, leerMayoristaEsq, htmlMayoristaEsq };

// ── Switch Reventa | Fraccionado (#cfgTipo, precios.html) ──
// Cambiar de tipo con cambios sin guardar pregunta (puedeSalirConfig) y recarga el sub-tab visible con los valores del tipo.
function pintarSwitchTipoCfg() {
  document.querySelectorAll('#cfgTipo [data-tipo-cfg]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tipoCfg === tipoCfgEsq)));
}
pintarSwitchTipoCfg();
document.getElementById('cfgTipo').addEventListener('click', async e => {
  const b = e.target.closest('[data-tipo-cfg]');
  if (!b || b.dataset.tipoCfg === tipoCfgEsq || !(await puedeSalirConfig())) return; // precios_config.js
  tipoCfgEsq = b.dataset.tipoCfg;
  try { sessionStorage.setItem(CLAVE_TIPO_CFG, tipoCfgEsq); } catch { /* sin storage: vuelve a Reventa al recargar */ }
  pintarSwitchTipoCfg();
  activarSubConfig(ultimoSubConfig()); // precios_config.js
});
