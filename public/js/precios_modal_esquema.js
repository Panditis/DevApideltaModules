// ── Precios · modal del producto con el esquema por canal (spec 2026-10-07 §3.2) ──
// Simple: costos (sistema / última compra), tabla por canal (vigente, sugerido, Δ%) de la fuente elegida, decisión y
// Guardar. "Ver detalle" sólo existe con el permiso precios-config (y sólo entonces el server manda desglose y costos
// extra): desglose por canal + costo manual + costos extra. Globales: el modal compartido #mDet (abrirModal, cerrarDetalle)
// y formato/pedidos de precios_comun.js; de precios_listados.js: opcionesDecision, guardarDecision, renderListado, cargarListado.
const TIPO_CANAL = { pack: 'Pack', bulto: 'Bulto' };
const TXT_FUENTE = { sistema: 'sistema', ultimaCompra: 'última compra', manual: 'manual' };

// Filas de la tabla por canal para una fuente. Fraccionado: una fila minorista por presentación ($/kg); el granel sólo
// aporta sus pack/bulto. Pack/bulto: sin IVA (sin vigente: el de SIGA es con IVA) y con IVA (contra el vigente).
function filasCanales(fila, fuente) {
  const filas = [];
  const sumar = (f, etiqueta) => {
    const s = (f.sugeridos || {})[fuente];
    const ok = s && !s.error ? s : null;
    if (etiqueta) {
      filas.push({ canal: etiqueta, plu: f.plu, vigente: f.vigente ?? null, sugerido: ok ? ok.minorista.precio : null,
        deltaPct: ok ? ok.minorista.deltaPct : null, estado: ok ? ok.minorista.estado : null });
    }
    for (const m of f.mayoristas || []) {
      const p = ok ? ok.mayoristas.find(x => x.plu === m.plu) : null;
      const base = { plu: m.plu, nombre: m.nombre, unidades: m.unidades, faltante: p ? p.faltante : null };
      filas.push({ ...base, canal: `${TIPO_CANAL[m.tipo]} sin IVA`, vigente: null, sugerido: p ? p.neto : null, deltaPct: null, estado: null });
      filas.push({ ...base, canal: `${TIPO_CANAL[m.tipo]} con IVA`, vigente: m.vigente ?? null, sugerido: p ? p.conIva : null,
        deltaPct: p ? p.deltaPct : null, estado: p ? p.estado : null, revisarUnidad: !!(p && p.revisarUnidad) });
    }
  };
  if (Array.isArray(fila.presentaciones)) {
    sumar(fila, null);
    fila.presentaciones.forEach(p => sumar(p, `Minorista · ${p.nombre}`));
  } else sumar(fila, 'Minorista');
  return filas;
}

// Modo de venta de un pack/bulto pesable → pedido a /api/precios/pack-bulto/venta/:plu. Por kg = el default: se borra.
const PESO_MAX_KG_MD = 1000; // mismo tope que lib/precios_pack_bulto
function ventaPayload(modo, pesoKg) {
  if (modo !== 'paquete') return { metodo: 'DELETE' };
  if (!(pesoKg > 0 && pesoKg <= PESO_MAX_KG_MD)) return { error: `Por paquete: poné el peso del paquete (más de 0 y hasta ${PESO_MAX_KG_MD} kg).` };
  return { metodo: 'PUT', body: { modo: 'paquete', pesoKg } };
}

if (typeof module === 'object' && module.exports) module.exports = { filasCanales, ventaPayload };

// ── DOM ─────────────────────────────────────────────────────────────────────────
let mdEsq = null;          // { tipo, fila } tal como vino del detalle
let mdFuente = 'sistema';  // fuente cuyos precios se muestran (la del selector)
let mdDetalle = false;     // "Ver detalle" abierto

const fmtSug = n => (Number.isInteger(n) ? fmtPrecio(n) : fmtMoney(n));

async function abrirModalEsquema(tipo, plu, { detalle = false } = {}) {
  abrirModal('Cargando…', tipo === 'fraccionado'); // precios_comun.js
  try {
    const fila = await (await fetch(`/api/precios/esquema/detalle/${encodeURIComponent(plu)}?tipo=${encodeURIComponent(tipo)}`)).json();
    if (fila.error) throw new Error(fila.error);
    mdEsq = { tipo, fila };
    mdFuente = fila.decision ? fila.decision.fuente : 'sistema';
    mdDetalle = detalle;
    document.getElementById('mDetTitulo').textContent = fila.nombre || plu;
    document.getElementById('mDetSub').textContent = `PLU ${fila.plu}${tipo === 'fraccionado' ? ' · precios por kg' : ''}`;
    pintarModalEsquema();
  } catch (e) {
    document.getElementById('mDetBody').innerHTML = `<p class="py-6 text-crit">No se pudo cargar: ${esc(e.message)}</p>`;
  }
}

function htmlCostosModal(f) {
  const dato = (lbl, html) => `<div><div class="lbl">${esc(lbl)}</div><div class="font-semibold tabular-nums">${html}</div></div>`;
  const ult = f.costoUltimaCompra == null ? '—'
    : `$ ${fmtMoney(f.costoUltimaCompra)} <span class="text-xs text-gris font-normal">${esc(fmtFechaPrecio(f.fechaUltimaCompra) || '')}${f.proveedor ? ' · ' + esc(f.proveedor) : ''}${f.deltaUltimaPct == null ? '' : ' · ' + fmtPct(f.deltaUltimaPct)}</span>`;
  return `<div class="grid grid-cols-3 gap-4 mt-2">
    ${dato(mdEsq.tipo === 'produccion' ? 'Costo (receta)' : 'Costo sistema', f.costoSistema == null ? '—' : '$ ' + fmtMoney(f.costoSistema))}
    ${mdEsq.tipo === 'produccion' ? '' : dato('Última compra', ult)}
    ${f.costoManual == null ? '' : dato('Costo manual', '$ ' + fmtMoney(f.costoManual))}</div>`;
}

function htmlTablaCanales(f) {
  const filas = filasCanales(f, mdFuente);
  if (!filas.length) return '<p class="text-gris mt-3">Sin canales para mostrar.</p>';
  const avisos = r => (r.unidades ? ` <span class="text-xs text-gris">× ${esc(r.unidades)}</span>` : '')
    + (r.faltante === 'unidades' ? ' <span class="text-xs text-warn">sin unidades</span>' : '')
    + (r.revisarUnidad ? ' <span class="text-xs text-warn" title="El vigente de SIGA parece estar en otra unidad">revisar unidad</span>' : '');
  return `<table class="w-full text-sm mt-2"><thead><tr class="text-xs text-gris"><th class="text-left py-1">Canal</th><th class="text-left">PLU</th>
      <th class="text-right">Vigente</th><th class="text-right">Sugerido</th><th class="text-right">Δ%</th></tr></thead>
    <tbody>${filas.map(r => `<tr class="border-t border-borde"><td class="py-1.5">${esc(r.canal)}${avisos(r)}</td><td>${esc(r.plu)}</td>
      <td class="text-right tabular-nums">${r.vigente == null ? '—' : '$ ' + fmtPrecio(r.vigente)}</td>
      <td class="text-right tabular-nums font-semibold">${r.sugerido == null ? '—' : '$ ' + fmtSug(r.sugerido)}</td>
      <td class="text-right tabular-nums ${claseDelta(r.estado)}">${r.deltaPct == null ? '—' : fmtPct(r.deltaPct)}</td></tr>`).join('')}</tbody></table>`;
}

// ── Ver detalle (sólo con permiso: el server sólo entonces manda `desglose`) ──
const pctMd = n => `${String(+(+n).toFixed(2)).replace('.', ',')} %`;
const htmlPasos = (titulo, pasos) => `<div class="mt-3"><div class="lbl mb-1">${esc(titulo)}</div>${pasos.map(([op, txt, v]) =>
  `<div class="ec"><span class="ec-op" aria-hidden="true">${op}</span><span>${esc(txt)}</span><span class="ec-val">$ ${fmtMoney(v)}</span></div>`).join('')}</div>`;
function htmlDesgloseEsq(f) {
  const bloques = [];
  const de = (fila, titulo) => {
    const s = (fila.sugeridos || {})[mdFuente];
    if (!s || !s.desglose) return;
    const d = s.desglose, m = d.minorista;
    if (titulo) bloques.push(htmlPasos(titulo, [
      ['', 'Costo de mercadería', d.costo], ['+', `Gastos variables ${pctMd(d.gastosPct)}`, d.costoConGastos],
      ['×', `Margen ${pctMd(m.margenPct)}`, m.neto], ['×', `Extras minoristas ${pctMd(m.extrasPct)}`, m.conExtras],
      ['×', `IVA ${pctMd(m.ivaPct)}`, m.exacto], ['=', 'Precio redondeado', m.precio]]));
    for (const v of fila.mayoristas || []) {
      const c = d.porVinculo[v.plu];
      if (c) bloques.push(htmlPasos(`${TIPO_CANAL[v.tipo]} ${v.plu} (× ${c.unidades})`, [
        ['', 'Costo con gastos', d.costoConGastos], ['×', `Margen ${pctMd(c.margenPct)}`, c.netoUnidad], ['×', `${c.unidades} unidades`, c.exactoNeto],
        ['=', 'Sin IVA redondeado', c.neto], ['×', 'IVA', c.exactoIva], ['=', 'Con IVA redondeado', c.conIva]]));
    }
  };
  if (Array.isArray(f.presentaciones)) { de(f, null); f.presentaciones.forEach(p => de(p, `Minorista · ${p.nombre}`)); }
  else de(f, 'Minorista');
  return bloques.length ? bloques.join('') : '<p class="text-gris mt-3">Sin desglose para esta fuente.</p>';
}

const htmlFilaExtraMd = (it = {}) => `<tr><td class="py-1 pr-2"><input class="num-in w-full text-left" data-k="concepto" value="${esc(it.concepto || '')}" aria-label="Concepto"></td>
  <td class="py-1 pr-2"><select class="num-in" data-k="tipo" aria-label="Tipo"><option value="kg"${it.tipo !== 'pct' ? ' selected' : ''}>$</option><option value="pct"${it.tipo === 'pct' ? ' selected' : ''}>%</option></select></td>
  <td class="py-1 pr-2"><input class="num-in w-24" type="number" step="any" data-k="valor" value="${esc(it.valor ?? '')}" aria-label="Valor"></td>
  <td class="py-1"><button type="button" class="md-extra-quitar text-gris hover:text-crit" aria-label="Quitar">✕</button></td></tr>`;
// Pack/bulto pesables (granel y presentaciones de Fraccionado) con su modo de venta: por kg o por paquete + kg.
const ventasPesablesMd = f => [...(f.mayoristas || []), ...(f.presentaciones || []).flatMap(p => p.mayoristas || [])].filter(m => m.venta);
const htmlVentaMd = m => `<tr><td class="py-1 pr-2">${esc(TIPO_CANAL[m.tipo] || m.tipo)} ${esc(m.plu)} <span class="text-gris">${esc(m.nombre || '')}</span></td>
  <td class="py-1 pr-2"><select class="md-venta-modo num-in" data-plu="${esc(m.plu)}" aria-label="Modo de venta de ${esc(m.plu)}">
    <option value="kg"${m.venta.modo !== 'paquete' ? ' selected' : ''}>Por kg</option><option value="paquete"${m.venta.modo === 'paquete' ? ' selected' : ''}>Por paquete</option></select></td>
  <td class="py-1 pr-2"><input type="number" min="0" step="any" class="md-venta-kg num-in w-20${m.venta.modo === 'paquete' ? '' : ' hidden'}" data-plu="${esc(m.plu)}" value="${esc(m.venta.pesoKg ?? '')}" aria-label="Kg del paquete de ${esc(m.plu)}"></td>
  <td class="py-1"><button type="button" class="md-venta-guardar cfg-btn2" data-plu="${esc(m.plu)}">Guardar</button></td></tr>`;
function htmlVentasPesablesMd(f) {
  const ms = mdEsq.tipo === 'fraccionado' ? ventasPesablesMd(f) : [];
  return ms.length ? `<div class="lbl mt-3 mb-1">Venta de pack/bulto pesables</div>
    <table class="w-full text-sm"><tbody id="mdVentas">${ms.map(htmlVentaMd).join('')}</tbody></table>` : '';
}
function htmlEdicionCostos(f) {
  if (mdEsq.tipo === 'produccion') return '';
  return `<div class="mt-4 pt-3 border-t border-borde">
    <div class="lbl mb-1">Costo manual</div>
    <div class="flex items-center gap-2">${campoU(`<input id="mdManual" type="number" min="0" step="any" value="${esc(f.costoManual ?? '')}">`, '$', { pre: true, w: 'w-36' })}
      <button type="button" id="mdManualGuardar" class="cfg-btn2">Guardar</button>
      ${f.costoManual != null ? '<button type="button" id="mdManualQuitar" class="text-sm text-gris hover:text-crit">Quitar</button>' : ''}</div>
    <div class="lbl mt-3 mb-1">Costos extra (${mdEsq.tipo === 'fraccionado' ? '$/kg' : '$'} o % del costo)</div>
    <table class="w-full text-sm"><tbody id="mdExtras">${(f.costosExtra || []).map(htmlFilaExtraMd).join('')}</tbody></table>
    <div class="flex gap-2 mt-1"><button type="button" id="mdExtraAgregar" class="cfg-btn2">+ Agregar</button>
      <button type="button" id="mdExtrasGuardar" class="cfg-btn2">Guardar costos extra</button></div>
    ${htmlVentasPesablesMd(f)}
    <p id="mdMsg" class="text-sm mt-1" role="status" aria-live="polite"></p></div>`;
}

function pintarModalEsquema() {
  const { tipo, fila: f } = mdEsq;
  const opciones = opcionesDecision(f, tipo).map(([v, t]) =>
    `<option value="${v}"${(f.decision ? f.decision.fuente : '') === v ? ' selected' : ''}>${esc(t)}</option>`).join('');
  document.getElementById('mDetBody').innerHTML = `${htmlCostosModal(f)}
    <div class="flex items-center gap-2 mt-4 flex-wrap"><label for="mdDecision" class="font-semibold text-sm">Decisión</label>
      <select id="mdDecision" class="num-in text-left">${opciones}</select>
      <button type="button" id="mdGuardar" class="px-4 py-1.5 rounded-lg bg-verde text-white text-sm font-semibold hover:bg-verdeHover">Guardar</button>
      <span id="mdDecMsg" class="text-sm" role="status" aria-live="polite"></span></div>
    <div class="text-xs text-gris mt-3">Precios con el costo de ${esc(TXT_FUENTE[mdFuente] || mdFuente)}</div>
    ${htmlTablaCanales(f)}
    ${preciosSinConfig ? '' : `<button type="button" id="mdVerDetalle" class="mt-4 text-sm text-verde underline underline-offset-2" aria-expanded="${mdDetalle}">${mdDetalle ? 'Ocultar detalle' : 'Ver detalle'}</button>
      ${mdDetalle ? htmlDesgloseEsq(f) + htmlEdicionCostos(f) : ''}`}`;
  conectarModalEsquema();
}

function conectarModalEsquema() {
  const { tipo, fila: f } = mdEsq;
  const sel = document.getElementById('mdDecision');
  // Elegir una fuente muestra sus precios; "—" deja los de la última fuente vista. No guarda hasta "Guardar".
  sel.onchange = () => {
    const elegido = sel.value;
    if (elegido) mdFuente = elegido;
    pintarModalEsquema();
    document.getElementById('mdDecision').value = elegido;
  };
  document.getElementById('mdGuardar').onclick = async () => {
    const msg = document.getElementById('mdDecMsg');
    try {
      const decision = await guardarDecision(f.plu, document.getElementById('mdDecision').value || null); // precios_listados.js
      mdEsq = { tipo, fila: { ...f, decision } };
      renderListado(tipo);
      msg.className = 'text-sm text-ok'; msg.textContent = 'Guardado.';
    } catch (e) { msg.className = 'text-sm text-crit'; msg.textContent = e.message; }
  };
  const ver = document.getElementById('mdVerDetalle');
  if (ver) ver.onclick = () => { mdDetalle = !mdDetalle; pintarModalEsquema(); };
  if (mdDetalle && document.getElementById('mdManualGuardar')) conectarEdicionCostos();
}

// Guarda costo manual / costos extra / venta de pack/bulto con las rutas de siempre y recarga modal (con el detalle
// abierto) y listado.
async function guardarCostoEsq(url, body, metodo = 'PUT') {
  const msg = document.getElementById('mdMsg');
  try {
    await pedirJson(metodo, url, body); // precios_comun.js: tira con el error del server
    const { tipo, fila } = mdEsq;
    await abrirModalEsquema(tipo, fila.plu, { detalle: true });
    cargarListado(tipo);
  } catch (e) { msg.className = 'text-sm mt-1 text-crit'; msg.textContent = e.message; }
}
function conectarEdicionCostos() {
  const plu = encodeURIComponent(mdEsq.fila.plu);
  const tbody = document.getElementById('mdExtras');
  document.getElementById('mdManualGuardar').onclick = () =>
    guardarCostoEsq(`/api/precios/costo-producto/${plu}`, { fuente: 'manual', costo: numOrNull(document.getElementById('mdManual').value) });
  const quitar = document.getElementById('mdManualQuitar');
  // fuente 'sistema' borra el costo manual.
  if (quitar) quitar.onclick = () => guardarCostoEsq(`/api/precios/costo-producto/${plu}`, { fuente: 'sistema' });
  document.getElementById('mdExtraAgregar').onclick = () => tbody.insertAdjacentHTML('beforeend', htmlFilaExtraMd());
  tbody.onclick = e => { const b = e.target.closest('.md-extra-quitar'); if (b) b.closest('tr').remove(); };
  document.getElementById('mdExtrasGuardar').onclick = () => guardarCostoEsq(`/api/precios/costos-extra/${plu}`, {
    items: [...tbody.querySelectorAll('tr')].map(tr => ({
      concepto: tr.querySelector('[data-k="concepto"]').value.trim(), tipo: tr.querySelector('[data-k="tipo"]').value,
      valor: numOrNull(tr.querySelector('[data-k="valor"]').value),
    })),
  });
  const ventas = document.getElementById('mdVentas');
  if (!ventas) return;
  ventas.onchange = e => {
    const sel = e.target.closest('.md-venta-modo');
    if (sel) ventas.querySelector(`.md-venta-kg[data-plu="${CSS.escape(sel.dataset.plu)}"]`).classList.toggle('hidden', sel.value !== 'paquete');
  };
  ventas.onclick = e => {
    const b = e.target.closest('.md-venta-guardar');
    if (!b) return;
    const q = cls => ventas.querySelector(`.${cls}[data-plu="${CSS.escape(b.dataset.plu)}"]`);
    const p = ventaPayload(q('md-venta-modo').value, numOrNull(q('md-venta-kg').value));
    if (p.error) { const msg = document.getElementById('mdMsg'); msg.className = 'text-sm mt-1 text-crit'; msg.textContent = p.error; return; }
    guardarCostoEsq(`/api/precios/pack-bulto/venta/${encodeURIComponent(b.dataset.plu)}`, p.body, p.metodo);
  };
}
