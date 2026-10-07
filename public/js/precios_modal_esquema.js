// ── Precios · modal del producto con el esquema por canal (spec 2026-10-07 §3.2) ──
// Simple: selector de costo arriba (No cambiar / Costo sistema / Última compra / Costo manual; Producción: No cambiar /
// Aumentar) que GUARDA la decisión al elegir, y tabla por canal (vigente, nuevo, Δ%, margen total) del costo elegido.
// "Ver detalle" sólo existe con el permiso precios-config (y sólo entonces el server manda desglose y costos
// extra): desglose por canal + costo manual + costos extra. Globales: el modal compartido #mDet (abrirModal, cerrarDetalle)
// y formato/pedidos de precios_comun.js; de precios_listados.js: guardarDecision, renderListado, cargarListado.
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
        deltaPct: ok ? ok.minorista.deltaPct : null, estado: ok ? ok.minorista.estado : null, margenTotalPct: ok ? ok.minorista.margenTotalPct : null });
    }
    for (const m of f.mayoristas || []) {
      const p = ok ? ok.mayoristas.find(x => x.plu === m.plu) : null;
      const base = { plu: m.plu, nombre: m.nombre, unidades: m.unidades, faltante: p ? p.faltante : null };
      filas.push({ ...base, canal: `${TIPO_CANAL[m.tipo]} sin IVA`, vigente: null, sugerido: p ? p.neto : null, deltaPct: null, estado: null,
        margenTotalPct: p ? p.margenTotalNetoPct : null });
      filas.push({ ...base, canal: `${TIPO_CANAL[m.tipo]} con IVA`, vigente: m.vigente ?? null, sugerido: p ? p.conIva : null,
        deltaPct: p ? p.deltaPct : null, estado: p ? p.estado : null, revisarUnidad: !!(p && p.revisarUnidad), margenTotalPct: p ? p.margenTotalIvaPct : null });
    }
  };
  if (Array.isArray(fila.presentaciones)) {
    sumar(fila, null);
    fila.presentaciones.forEach(p => sumar(p, `Minorista · ${p.nombre}`));
  } else sumar(fila, 'Minorista');
  return filas;
}

// Opciones del selector de costo: { valor ('' = No cambiar, o la fuente), texto, costo, precio, deltaPct, estado, disponible }.
// precio/Δ% = minorista con ese costo (No cambiar: el vigente). Fraccionado: sin precio único; Δ% = promedio de las
// presentaciones. Manual sólo si hay costo manual (o es la decisión guardada). Sin sugerido → no se puede elegir.
const TXT_OPCION = { sistema: 'Costo sistema', ultimaCompra: 'Última compra', manual: 'Costo manual' };
const COSTO_FUENTE = { sistema: 'costoSistema', ultimaCompra: 'costoUltimaCompra', manual: 'costoManual' };
function resumenMinorista(fila, fuente) {
  const okDe = f => { const s = (f.sugeridos || {})[fuente]; return s && !s.error ? s : null; };
  if (Array.isArray(fila.presentaciones)) {
    const ds = fila.presentaciones.map(p => okDe(p)).filter(s => s && s.minorista.deltaPct != null).map(s => s.minorista.deltaPct);
    return { precio: null, deltaPct: ds.length ? Math.round((ds.reduce((a, b) => a + b, 0) / ds.length) * 10) / 10 : null, estado: null, ok: !!okDe(fila) };
  }
  const s = okDe(fila);
  return { precio: s ? s.minorista.precio : null, deltaPct: s ? s.minorista.deltaPct : null, estado: s ? s.minorista.estado : null, ok: !!s };
}
function opcionesCosto(fila, tipo) {
  const actual = fila.decision ? fila.decision.fuente : null;
  const fuentes = tipo === 'produccion' ? ['sistema']
    : ['sistema', 'ultimaCompra', ...(fila.costoManual != null || actual === 'manual' ? ['manual'] : [])];
  const noCambiar = { valor: '', texto: 'No cambiar', costo: null, precio: fila.vigente ?? null, deltaPct: null, estado: null, disponible: true };
  return [noCambiar, ...fuentes.map(f => {
    const r = resumenMinorista(fila, f);
    return { valor: f, texto: tipo === 'produccion' ? 'Aumentar' : TXT_OPCION[f], costo: fila[COSTO_FUENTE[f]] ?? null,
      precio: r.precio, deltaPct: r.deltaPct, estado: r.estado, disponible: r.ok || f === actual };
  })];
}

// Modo de venta de un pack/bulto pesable → pedido a /api/precios/pack-bulto/venta/:plu. Por kg = el default: se borra.
const PESO_MAX_KG_MD = 1000; // mismo tope que lib/precios_pack_bulto
function ventaPayload(modo, pesoKg) {
  if (modo !== 'paquete') return { metodo: 'DELETE' };
  if (!(pesoKg > 0 && pesoKg <= PESO_MAX_KG_MD)) return { error: `Por paquete: poné el peso del paquete (más de 0 y hasta ${PESO_MAX_KG_MD} kg).` };
  return { metodo: 'PUT', body: { modo: 'paquete', pesoKg } };
}

if (typeof module === 'object' && module.exports) module.exports = { filasCanales, ventaPayload, opcionesCosto };

// ── DOM ─────────────────────────────────────────────────────────────────────────
let mdEsq = null;          // { tipo, fila } tal como vino del detalle
let mdFuente = 'sistema';  // fuente cuyos precios se muestran (la del selector)
let mdDetalle = false;     // "Ver detalle" abierto

const fmtSug = n => (Number.isInteger(n) ? fmtPrecio(n) : fmtMoney(n));
const pctMd = n => `${String(+(+n).toFixed(2)).replace('.', ',')} %`;

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

// Selector de costo: radios que guardan la decisión al elegir. Cada opción muestra su costo y el precio minorista con Δ%.
function htmlOpcionesCosto(f) {
  const actual = f.decision ? f.decision.fuente : '';
  const ult = f.costoUltimaCompra == null ? ''
    : ` <span class="text-xs text-gris">${esc(fmtFechaPrecio(f.fechaUltimaCompra) || '')}${f.proveedor ? ' · ' + esc(f.proveedor) : ''}${f.deltaUltimaPct == null ? '' : ' · ' + fmtPct(f.deltaUltimaPct) + ' vs sistema'}</span>`;
  const precio = o => {
    if (o.valor === '') return o.precio == null ? '' : `vigente $ ${fmtPrecio(o.precio)}`;
    if (!o.disponible) return '<span class="text-gris">sin precio</span>';
    const d = o.deltaPct == null ? '' : ` <span class="${claseDelta(o.estado)}">${fmtPct(o.deltaPct)}</span>`;
    return o.precio == null ? (o.deltaPct == null ? '' : `Δ prom. presentaciones${d}`) : `→ <b>$ ${fmtPrecio(o.precio)}</b>${d}`;
  };
  return `<fieldset class="mt-2"><legend class="lbl mb-1">${mdEsq.tipo === 'produccion' ? 'Decisión' : 'Costo a tomar'}</legend>
    <div id="mdCostos" class="grid gap-1">${opcionesCosto(f, mdEsq.tipo).map(o => `<label class="flex items-center gap-3 px-3 py-2 rounded-lg border border-borde ${o.disponible ? 'cursor-pointer hover:bg-verde/5' : 'opacity-50'}${actual === o.valor ? ' bg-verde/5 border-verde' : ''}">
      <input type="radio" name="mdCosto" value="${o.valor}" class="accent-verde"${actual === o.valor ? ' checked' : ''}${o.disponible ? '' : ' disabled'}>
      <span class="font-semibold w-32">${esc(o.texto)}</span>
      <span class="tabular-nums w-28 text-right">${o.costo == null ? '' : '$ ' + fmtMoney(o.costo)}</span>
      <span class="tabular-nums">${precio(o)}${o.valor === 'ultimaCompra' ? ult : ''}</span></label>`).join('')}</div>
    <span id="mdDecMsg" class="text-sm" role="status" aria-live="polite"></span></fieldset>`;
}

function htmlTablaCanales(f) {
  const filas = filasCanales(f, mdFuente);
  if (!filas.length) return '<p class="text-gris mt-3">Sin canales para mostrar.</p>';
  const avisos = r => (r.unidades ? ` <span class="text-xs text-gris">× ${esc(r.unidades)}</span>` : '')
    + (r.faltante === 'unidades' ? ' <span class="text-xs text-warn">sin unidades</span>' : '')
    + (r.revisarUnidad ? ' <span class="text-xs text-warn" title="El vigente de SIGA parece estar en otra unidad">revisar unidad</span>' : '');
  return `<table class="w-full text-sm mt-2"><thead><tr class="text-xs text-gris"><th class="text-left py-1">Canal</th><th class="text-left">PLU</th>
      <th class="text-right">Vigente</th><th class="text-right">Nuevo</th><th class="text-right">Δ%</th>
      <th class="text-right" title="Precio final ÷ costo de mercadería (con sus extras) − 1">Margen total</th></tr></thead>
    <tbody>${filas.map(r => `<tr class="border-t border-borde"><td class="py-1.5">${esc(r.canal)}${avisos(r)}</td><td>${esc(r.plu)}</td>
      <td class="text-right tabular-nums">${r.vigente == null ? '—' : '$ ' + fmtPrecio(r.vigente)}</td>
      <td class="text-right tabular-nums font-semibold">${r.sugerido == null ? '—' : '$ ' + fmtSug(r.sugerido)}</td>
      <td class="text-right tabular-nums ${claseDelta(r.estado)}">${r.deltaPct == null ? '—' : fmtPct(r.deltaPct)}</td>
      <td class="text-right tabular-nums">${r.margenTotalPct == null ? '—' : pctMd(r.margenTotalPct)}</td></tr>`).join('')}</tbody></table>`;
}

// ── Ver detalle (sólo con permiso: el server sólo entonces manda `desglose`) ──
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
  const { fila: f } = mdEsq;
  const txtPrecios = f.decision ? `Precios con ${esc(TXT_FUENTE[mdFuente] || mdFuente)}` : 'Sin decisión: precios con el costo de sistema, para comparar';
  document.getElementById('mDetBody').innerHTML = `${htmlOpcionesCosto(f)}
    <div class="text-xs text-gris mt-4">${txtPrecios}</div>
    ${htmlTablaCanales(f)}
    ${preciosSinConfig ? '' : `<button type="button" id="mdVerDetalle" class="mt-4 text-sm text-verde underline underline-offset-2" aria-expanded="${mdDetalle}">${mdDetalle ? 'Ocultar detalle' : 'Ver detalle'}</button>
      ${mdDetalle ? htmlDesgloseEsq(f) + htmlEdicionCostos(f) : ''}`}`;
  conectarModalEsquema();
}

// Elegir un costo guarda la decisión en el momento (No cambiar = sin decisión) y refresca la fila del listado;
// guardarDecision (precios_listados.js) ya avisa a Producción ("a revisar").
function conectarModalEsquema() {
  const { tipo, fila: f } = mdEsq;
  document.getElementById('mdCostos').onchange = async e => {
    const valor = e.target.value;
    document.querySelectorAll('#mdCostos input').forEach(i => { i.disabled = true; });
    try {
      const decision = await guardarDecision(f.plu, valor || null); // precios_listados.js
      mdEsq = { tipo, fila: { ...f, decision } };
      mdFuente = valor || 'sistema';
      renderListado(tipo);
      pintarModalEsquema();
      const msg = document.getElementById('mdDecMsg');
      msg.className = 'text-sm text-ok'; msg.textContent = valor ? 'Guardado: queda marcado para exportar.' : 'Guardado: sin cambio de precio.';
    } catch (err) {
      pintarModalEsquema();
      const msg = document.getElementById('mdDecMsg');
      msg.className = 'text-sm text-crit'; msg.textContent = err.message;
    }
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
    refrescarAlertasProduccion(); // precios_produccion.js: el costo pudo mover "a revisar" (no tira, va antes de recargar el modal)
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
