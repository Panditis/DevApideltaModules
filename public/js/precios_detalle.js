// ── Precios · modal de detalle (Almacén, compartido con Fraccionado) ──
// abrirDetalle/htmlDetalle, selector de costo base, abrirModal, conectarDetalle, recalcularDetalle,
// costos extra, guardar/cerrar detalle y foco del modal.
// Script clásico (no módulo) cargado después de precios_almacen.js: comparte sus globales (esc, fmtMoney, ...).

// ── Almacén: detalle (modal) — resultado arriba + la cuenta como una ecuación ──
// Deja editar costo base, costos extra, margen y precio final con vista previa en vivo.
// Misma fórmula que lib/precios_costeo.js: (costo + varios% + costos extra) × (1+markup%) →
// múltiplo de $50 (sin ×1,21: el costo ya viene con IVA; precioFinalCli en precios_orden.js). "Guardar"
// persiste los valores manuales del producto; elegir "Sistema" / "volver a la banda" vuelven al automático.
const PASO_PRECIO = 50;
const redondear50 = n => Math.round(n / PASO_PRECIO) * PASO_PRECIO;
const r2 = n => Math.round(n * 100) / 100;
const numOrNull = v => { const s = String(v ?? '').trim(); if (s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
const chip = (txt, cls) => `<span class="px-1.5 py-0.5 rounded text-[11px] font-semibold ${cls}">${txt}</span>`;
const inputCls = 'px-2 py-1 rounded-lg border border-borde text-right tabular-nums focus:outline-none focus:border-verde focus:ring-2 focus:ring-verde/20';

let det = null;        // fila del detalle tal como vino del server
let detCfg = null;     // { bandas, toleranciaPct, gastosVentaPct, curva } para recalcular la banda en vivo
let detEstado = null;  // { costoFuente: 'sistema'|'ultimaCompra'|'manual', markupManual } editable
let detInicial = null; // estado al abrir, para saber si hay cambios sin guardar
let detEditandoFinal = false; // el usuario está tipeando el precio final: no pisar ese input
// Markup exacto (hasta 6 decimales, ej. el que deja "Alinear con SIGA"). El input lo muestra a
// 2 decimales; mientras el usuario no tipee en el input, el cálculo y el guardado usan éste.
let detMarkupExacto = null;
const fmtMarkupInput = m => m == null ? '' : r2(m);
function markupActual(){
  if (detEstado.markupManual && detMarkupExacto != null) return detMarkupExacto;
  return numOrNull(document.getElementById('inMarkup').value);
}

// La banda guarda GANANCIA: markup = total con los gastos sobre venta (espejo de calcularFilaAlmacen,
// markupDesdeGananciaCli en precios_config_gastos.js); ganancia queda para mostrar el desglose.
// Con la curva de Almacén activa la ganancia sale de la curva (gananciaPorCurvaCliente) y la banda es "curva".
function bandaParaCosto(costo){
  if (costo == null) return null;
  if (detCfg.curva && detCfg.curva.activa === true) {
    const ganancia = gananciaPorCurvaCliente(detCfg.curva, costo);
    const markup = markupDesdeGananciaCli(ganancia, detCfg.gastosVentaPct);
    return markup == null ? null : { markup, ganancia, label: 'curva' };
  }
  for (const b of detCfg.bandas) {
    if (b.costoHastaARS === null || costo <= b.costoHastaARS) {
      const markup = markupDesdeGananciaCli(b.markupMaxPct, detCfg.gastosVentaPct);
      if (markup == null) return null;
      return { markup, ganancia: b.markupMaxPct, label: b.costoHastaARS === null ? 'sin tope' : `hasta $ ${fmtPrecio(b.costoHastaARS)}` };
    }
  }
  return null;
}
const desgloseBanda = b => `${textoGananciaGastos(b.ganancia, detCfg.gastosVentaPct)} = ${fmtPctGastos(b.markup)}`;

async function abrirDetalle(plu){
  const body = document.getElementById('mDetBody');
  abrirModal('Detalle — ' + plu, false);
  try {
    const [rd, rc] = await Promise.all([
      fetch('/api/precios/detalle/' + encodeURIComponent(plu)),
      fetch('/api/precios/config'),
    ]);
    const j = await rd.json(), c = await rc.json();
    if (j.error) throw new Error(j.error);
    if (c.error) throw new Error(c.error);
    det = j;
    detCfg = { bandas: (c.bandasMarkup || {}).almacen || [], toleranciaPct: Number(c.toleranciaPct) || 0,
      gastosVentaPct: Number(c.gastosVentaPct) || 0, curva: (c.curvaGanancia || {}).almacen || null };
    detEstado = { costoFuente: j.costoFuente || 'sistema', markupManual: j.markupOverride != null };
    detInicial = { ...detEstado, costoManualValor: j.costoOverride, markup: j.markupPct };
    detalleListo(j.nombre, j.plu, j);
    body.innerHTML = htmlDetalle(j);
    document.getElementById('inCosto').value = j.costoOverride ?? '';
    detMarkupExacto = j.markupPct ?? null;
    document.getElementById('inMarkup').value = fmtMarkupInput(j.markupPct);
    iniciarCostosExtra(j.costosExtra, '$', recalcularDetalle);
    conectarDetalle();
    recalcularDetalle();
  } catch (e) {
    body.innerHTML = `<p class="text-crit">No se pudo cargar: ${esc(e.message)}</p>`;
  }
}

// Encabezado del modal ya cargado: nombre + línea discreta (PLU · proveedor · última compra) y
// pie Descartar / Guardar visible. Compartido por Almacén y Fraccionado.
function detalleListo(nombre, plu, j){
  document.getElementById('mDetTitulo').textContent = nombre;
  const partes = ['PLU ' + esc(plu), esc(j.proveedor || 'sin proveedor'),
    j.fechaUltimaCompra ? 'últ. compra ' + esc(j.fechaUltimaCompra) : 'sin compras'];
  document.getElementById('mDetSub').innerHTML = partes.join(' · ')
    + htmlAvisoIngresoHoy(j, true); // precios_orden.js (Almacén y granel de Fraccionado)
  document.getElementById('mDetPie').classList.remove('hidden');
}

const DELTA_BASE = 'text-xl font-semibold tabular-nums leading-tight';

function htmlDetalle(j){
  const sinPrecio = tieneFaltantes(j);
  const renglon = (op, medio, valor, cls = '') =>
    `<div class="ec ${cls}"><span class="ec-op" aria-hidden="true">${op}</span>${medio}${valor}</div>`;
  return `
    <section id="dResultado" class="sec s-res flex flex-wrap items-end gap-x-8 gap-y-3 pt-2 pb-3 mb-2" aria-label="Resultado">
      <div><div class="lbl">Sugerido</div><div id="dSugerido" class="text-3xl font-bold text-verde tabular-nums leading-tight">—</div></div>
      <div><div class="lbl">Vigente SIGA</div><div id="dVigente" class="text-xl font-semibold text-ink/70 tabular-nums leading-tight">—</div>
        <div id="dMargenVig" class="text-[11px] text-gris tabular-nums"></div></div>
      <div><div class="lbl">Diferencia</div>
        <div class="flex items-center gap-2"><span id="dDelta" class="${DELTA_BASE}">—</span><span id="dEstado" class="text-xs text-gris"></span></div></div>
    </section>
    <label class="inline-flex items-center gap-2 text-xs text-gris mb-1 ${sinPrecio ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:text-ink'}"${sinPrecio ? ' title="Sin precio sugerido"' : ''}>
      <input id="chkMarcaDet" type="checkbox" class="accent-verde"${j.marcado ? ' checked' : ''}${sinPrecio ? ' disabled' : ''}>
      Marcar para actualizar en SIGA <span id="dMarcaMsg"></span></label>

    <div class="mt-2" role="group" aria-label="Cálculo del precio">
      ${htmlCostoBase(j, '$')}
      ${renglon('+', `<span class="text-gris">Costos varios <span class="text-xs">${esc(j.costosVariosPct || 0)}% del costo</span></span>`,
        '<span id="dCostoVarios" class="ec-val text-gris">—</span>', 'sec s-costo')}
      ${htmlCostosExtra('$', '$ = monto fijo por unidad; % = sobre el costo base. La banda de margen se busca con el costo base.')}
      ${renglon('×', `<div class="min-w-0"><label for="inMarkup" class="font-semibold">Margen</label> <span id="dChipMarkup"></span>
          <div class="text-xs text-gris mt-0.5"><span id="dInfoMarkup"></span>
            <button type="button" id="btnUsarBanda" class="hidden ml-1 text-verde underline underline-offset-2 hover:text-verdeHover">volver a la banda</button></div></div>`,
        '<span class="ec-val text-gris"><input id="inMarkup" type="number" min="-99" step="any" inputmode="decimal" class="num-in w-24 text-lg font-semibold text-ink"> %</span>', 'sec s-margen')}
      ${renglon('=', `<div class="min-w-0"><label for="inFinal" class="font-semibold text-verde">Precio final</label>
          <div id="dFinalInfo" class="text-xs text-gris mt-0.5">costo × (1 + margen) = <span id="dNeto" class="tabular-nums">—</span> · redondeo a $50</div></div>`,
        `<span class="ec-val text-gris">$ <input id="inFinal" type="number" min="0" step="50" inputmode="numeric" aria-describedby="dFinalInfo"
            title="Escribí el precio que querés: se recalcula el margen" class="num-in w-32 text-lg font-bold text-verde"></span>`, 'sec s-final')}
    </div>
    <div id="dPackBulto"></div>`;
}

// ── Selector de costo base: compartido por Almacén (producto) y Fraccionado (granel) ──
// Control segmentado Sistema / Última compra / Manual con el valor de cada opción; el detalle
// de la opción elegida (comprobante, proveedor, fecha) va en texto chico debajo. Usa `det`,
// `detEstado.costoFuente` y el input #inCosto. Guardar = PUT /api/precios/costo-producto/:plu.
const chipFuenteCosto = fuente => fuente === 'manual' || fuente === 'ultimaCompra'
  ? chip(fuente === 'manual' ? 'manual' : 'últ. compra', 'bg-amarillo/30 text-ink') + ' ' : '';
const ETIQUETA_SEG_COSTO = { sistema: 'Sistema', ultimaCompra: 'Última compra', manual: 'Manual' };

// Cada opción muestra el valor que entra en la cuenta, tal cual lo manda el server: sistema = PrecioCosto de
// SIGA; última compra = el comprobante (factura: neto + IVA; cotización: tal cual).
function htmlCostoBase(j, unidad){
  const seg = (fuente, valor, habilitado = valor != null) => `
        <button type="button" data-fuente="${fuente}" aria-pressed="false" class="costo-opt seg-opt"${habilitado ? '' : ' disabled'}>
          ${ETIQUETA_SEG_COSTO[fuente]}<b${fuente === 'manual' ? ' id="dSegManual"' : ''}>${valor != null ? '$ ' + fmtMoney(valor) : '—'}</b></button>`;
  return `
    <div class="ec sec s-costo"><span class="ec-op" aria-hidden="true"></span>
      <div class="min-w-0">
        <div id="lblCosto" class="font-semibold">Costo${unidad === '$/kg' ? ' por kg' : ''}</div>
        <div class="seg mt-1.5" role="group" aria-labelledby="lblCosto">${seg('sistema', costoSistemaDe(j))}${seg('ultimaCompra', j.precioUltimaCompra ?? null)}${seg('manual', null, true)}
        </div>
        <div id="dCostoManual" class="hidden mt-2 text-gris"><label for="inCosto" class="text-xs mr-1">Costo manual</label>$
          <input id="inCosto" type="number" min="0" step="any" inputmode="decimal" placeholder="0,00" class="num-in w-32 font-semibold text-ink"></div>
        <div id="dCostoInfo" class="text-xs text-gris mt-1.5"></div>
      </div>
      <span id="dCostoBase" class="ec-val font-semibold">—</span></div>`;
}

// Elegir fuente de costo: las dos fijas son un clic; "manual" arranca con el costo que se
// estaba usando para no empezar de cero. onCambio = recalcular el modal que lo contiene.
function conectarCostoBase(onCambio){
  const inCosto = document.getElementById('inCosto');
  document.querySelectorAll('.costo-opt[data-fuente]').forEach(op => op.addEventListener('click', () => {
    if (op.disabled) return;
    const fuente = op.dataset.fuente;
    if (fuente === 'manual' && detEstado.costoFuente !== 'manual' && numOrNull(inCosto.value) == null) {
      const actual = costoEfectivo();
      if (actual != null) inCosto.value = actual;
    }
    detEstado.costoFuente = fuente;
    onCambio();
    if (fuente === 'manual') { inCosto.focus(); inCosto.select(); }
  }));
  inCosto.addEventListener('input', () => { detEstado.costoFuente = 'manual'; onCambio(); });
}

// Detalle chico de la opción de costo elegida.
function infoFuenteCosto(fuente){
  if (fuente === 'manual') return '';
  if (fuente === 'ultimaCompra') {
    if (det.precioUltimaCompra == null) return 'Sin compras registradas.';
    const tipo = det.tipoComprobanteUltimaCompra;
    const cuenta = tipo === 'cotización' ? 'cotización, tal cual' : tipo === 'factura' ? 'factura, neto + IVA' : 'última compra';
    return `${esc(cuenta)} · ${esc(det.proveedor || 'sin proveedor')} · ${esc(det.fechaUltimaCompra || '—')}`;
  }
  return costoSistemaDe(det) == null ? 'Sin costo en SIGA.' : 'Costo de SIGA tal cual (PrecioCosto).';
}

// Pinta la opción elegida, el valor manual y el detalle; devuelve el costo efectivo.
function pintarCostoBase(){
  const costo = costoEfectivo();
  const fuente = detEstado.costoFuente;
  document.getElementById('dCostoBase').textContent = costo != null ? '$ ' + fmtMoney(costo) : '—';
  document.querySelectorAll('.costo-opt[data-fuente]').forEach(op => op.setAttribute('aria-pressed', String(op.dataset.fuente === fuente)));
  const manual = numOrNull(document.getElementById('inCosto').value);
  document.getElementById('dSegManual').textContent = manual != null ? '$ ' + fmtMoney(manual) : 'cargar';
  document.getElementById('dCostoManual').classList.toggle('hidden', fuente !== 'manual');
  document.getElementById('dCostoInfo').innerHTML = infoFuenteCosto(fuente);
  return costo;
}

// Abre el modal compartido #mDet en estado "cargando". ancho = true para Fraccionado (tabla de presentaciones).
let detFocoPrevio = null; // foco antes de abrir, se devuelve al cerrar
function abrirModal(titulo, ancho){
  const modal = document.getElementById('mDet');
  const caja = document.getElementById('mDetCaja');
  if (modal.classList.contains('hidden')) detFocoPrevio = document.activeElement;
  limpiarPendientesPB(); // precios_pack_bulto.js: % y modo/peso sin guardar del modal anterior
  caja.classList.toggle('max-w-2xl', !ancho); caja.classList.toggle('max-w-3xl', !!ancho);
  document.getElementById('mDetTitulo').textContent = titulo;
  document.getElementById('mDetSub').textContent = '';
  document.getElementById('mDetPie').classList.add('hidden');
  msgDetalle('');
  document.getElementById('mDetBody').innerHTML = '<div class="py-10 text-center text-gris"><span class="spin"></span> Cargando…</div>';
  modal.classList.remove('hidden'); modal.classList.add('flex');
  caja.focus();
}

function conectarDetalle(){
  const inCosto = document.getElementById('inCosto');
  const inMarkup = document.getElementById('inMarkup');
  inMarkup.addEventListener('input', () => { detEstado.markupManual = true; detMarkupExacto = null; recalcularDetalle(); });
  document.getElementById('btnUsarBanda').onclick = () => { detEstado.markupManual = false; detMarkupExacto = null; recalcularDetalle(); };
  // Precio final → markup: markup = (precio / costoTotal − 1) × 100 (IVA_VENTA_CLI = 1), a 6 decimales
  // (el input muestra 2; el exacto queda en detMarkupExacto para reproducir el precio al
  // centavo). Mientras se escribe no se pisa el input; al salir se ajusta a $50, salvo que
  // sea el precio vigente de SIGA (se respeta tal cual, como en el backend).
  const inFinal = document.getElementById('inFinal');
  const markupParaPrecio = precio => {
    const costo = costoEfectivo();
    if (costo == null || costo <= 0 || precio == null || precio <= 0) return null;
    const costoTotal = costoTotalAlmacen(costo);
    return +((precio / IVA_VENTA_CLI / costoTotal - 1) * 100).toFixed(6); // precios_orden.js
  };
  const fijarMarkup = mk => { detEstado.markupManual = true; detMarkupExacto = mk; inMarkup.value = fmtMarkupInput(mk); };
  // Cambio de costo: el margen vuelve a la banda de ese costo (deja el propio, ej. el de "Alinear con SIGA")
  // y el precio se recalcula. Volver a la fuente con la que se abrió (salvo manual) restaura el margen de
  // entonces. Después se puede escribir otro margen o precio a mano.
  conectarCostoBase(() => {
    const volvio = detEstado.costoFuente === detInicial.costoFuente && detEstado.costoFuente !== 'manual';
    detEstado.markupManual = volvio ? detInicial.markupManual : false;
    detMarkupExacto = volvio ? detInicial.markup ?? null : null;
    if (volvio && detInicial.markupManual) inMarkup.value = fmtMarkupInput(detInicial.markup);
    recalcularDetalle();
  });
  inFinal.addEventListener('input', () => {
    const mk = markupParaPrecio(numOrNull(inFinal.value));
    if (mk == null) return;
    fijarMarkup(mk);
    detEditandoFinal = true;
    recalcularDetalle();
    detEditandoFinal = false;
  });
  inFinal.addEventListener('change', () => {
    const p = numOrNull(inFinal.value);
    if (p == null || p <= 0) { recalcularDetalle(); return; }
    const mk = markupParaPrecio(p === det.precioVigente ? p : redondear50(p));
    if (mk != null) fijarMarkup(mk);
    recalcularDetalle();
  });
  document.getElementById('btnDescartar').onclick = () => {
    detEstado = { costoFuente: detInicial.costoFuente, markupManual: detInicial.markupManual };
    detMarkupExacto = detInicial.markup ?? null;
    inCosto.value = detInicial.costoManualValor ?? ''; inMarkup.value = fmtMarkupInput(detInicial.markup);
    restaurarCostosExtra(det.costosExtra);
    if (conPB(det)) descartarPB(document.getElementById('dPackBulto'), itemDetPB); // precios_pack_bulto.js
    msgDetalle(''); recalcularDetalle();
  };
  document.getElementById('btnGuardarDet').onclick = guardarDetalle;
  const chkMarca = document.getElementById('chkMarcaDet');
  chkMarca.onchange = async () => {
    const msg = document.getElementById('dMarcaMsg');
    chkMarca.disabled = true; msg.className = 'text-xs text-gris'; msg.textContent = 'Guardando…';
    try {
      const j = await marcarPlus([det.plu], chkMarca.checked);
      det = { ...det, marcado: j.marcados.includes(det.plu) };
      chkMarca.checked = det.marcado; msg.textContent = '';
    } catch (e) {
      chkMarca.checked = !chkMarca.checked; msg.className = 'text-xs text-crit'; msg.textContent = e.message;
    } finally { chkMarca.disabled = false; }
  };
}

// Costo que usa el cálculo según la fuente elegida en el paso 1.
function costoEfectivo(){
  const f = detEstado.costoFuente;
  if (f === 'manual') return numOrNull(document.getElementById('inCosto').value);
  if (f === 'ultimaCompra') return det.precioUltimaCompra ?? null;
  return det.costoSistema ?? null;
}

// Costo total Almacén (espejo de costearAlmacen): base + costos varios % + costos extra del producto.
const costoVariosDe = costo => costo * (Number(det.costosVariosPct) || 0) / 100;
const costoTotalAlmacen = costo => extrasCliente(costo, costoVariosDe(costo)).total;

// Margen que deja el precio vigente con el costo elegido, recalculado en vivo: vigente / costo − 1
// (el mismo criterio que la cuenta: costo tal cual, precio final sin ×1,21).
function margenVigente(vig, costo){
  return vig > 0 && costo > 0 ? r2((vig / IVA_VENTA_CLI / costo - 1) * 100) : null;
}
function pintarMargenVigente(vig, costo){
  const el = document.getElementById('dMargenVig');
  if (!el) return;
  const m = margenVigente(vig, costo);
  el.textContent = m != null ? `margen ${fmtPct(m)}` : '';
  el.title = m != null ? 'Margen que deja el precio vigente con el costo elegido (vigente ÷ costo − 1).' : '';
}

function recalcularDetalle(){
  const inMarkup = document.getElementById('inMarkup');
  const costo = costoEfectivo();
  const banda = bandaParaCosto(costo);
  if (!detEstado.markupManual) inMarkup.value = banda ? fmtMarkupInput(banda.markup) : '';
  // Sin margen propio se usa el markup exacto de la banda (el input lo muestra a 2 decimales).
  const markup = detEstado.markupManual ? markupActual() : banda ? banda.markup : null;
  // Markup negativo es válido (precio de SIGA bajo el costo); se avisa abajo.
  const valido = costo != null && costo > 0 && markup != null && markup > -100;

  pintarCostoBase();
  const costoTotal = pintarTotalesCostosExtra(costo, costo != null ? costoVariosDe(costo) : 0);
  document.getElementById('dCostoVarios').textContent = costo != null ? '$ ' + fmtMoney(r2(costoVariosDe(costo))) : '—';
  document.getElementById('dChipMarkup').innerHTML = detEstado.markupManual
    ? chip('propio', 'bg-amarillo/30 text-ink') : '';
  document.getElementById('dInfoMarkup').textContent = detEstado.markupManual
    ? `La banda daría ${banda ? desgloseBanda(banda) : '—'}.`
    : banda ? `${banda.label === 'curva' ? 'De la curva' : 'De la banda ' + banda.label}: ${desgloseBanda(banda)}. Escribí otro para fijar uno propio.` : 'Sin banda para este costo: escribí un margen.';
  document.getElementById('btnUsarBanda').classList.toggle('hidden', !detEstado.markupManual);

  const set = (id, v) => { document.getElementById(id).textContent = v; };
  const vig = det.precioVigente;
  set('dVigente', vig != null ? '$ ' + fmtPrecio(vig) : '—');
  pintarMargenVigente(vig, costo);
  const inFinal = document.getElementById('inFinal');
  const dResultado = document.getElementById('dResultado');
  dResultado.dataset.estado = '';
  if (!valido) {
    ['dNeto', 'dSugerido', 'dDelta'].forEach(id => set(id, '—'));
    document.getElementById('dDelta').className = DELTA_BASE;
    if (!detEditandoFinal) inFinal.value = '';
    document.getElementById('dEstado').innerHTML = '';
    pintarPBDetalle(null); // precios_pack_bulto.js
  } else {
    const neto = r2(costoTotal * (1 + markup / 100));
    // Misma regla que el backend: si costo y markup reproducen el vigente de SIGA se respeta
    // ese precio; si no, múltiplo de $50 (precioFinalCli, precios_orden.js).
    const final = precioFinalCli(neto, vig).precio;
    set('dNeto', '$ ' + fmtMoney(neto));
    if (!detEditandoFinal) inFinal.value = final;
    set('dSugerido', '$ ' + fmtPrecio(final));
    pintarPBDetalle(final); // precios_pack_bulto.js: pack/bulto en vivo sobre el precio final
    const dDelta = document.getElementById('dDelta');
    if (vig != null && vig > 0) {
      // Misma fórmula que compararConVigente en el backend: (sugerido − vigente) / vigente.
      // + = hay que subir el precio, − = bajarlo; dentro de ±tolerancia es ok.
      const delta = +(((final - vig) / vig) * 100).toFixed(1);
      const tol = detCfg.toleranciaPct;
      const estado = Math.abs(delta) <= tol ? 'ok' : delta > 0 ? 'subir' : 'bajar';
      set('dDelta', fmtPct(delta));
      dDelta.className = DELTA_BASE + ' ' + claseDelta(estado);
      dResultado.dataset.estado = estado;
      document.getElementById('dEstado').innerHTML = badgeSemaforo(estado);
    } else {
      set('dDelta', '—');
      dDelta.className = DELTA_BASE;
      document.getElementById('dEstado').textContent = 'sin precio vigente';
    }
  }

  // Pack/bulto (% propio) cuenta como cambio del modal y se guarda con el mismo Guardar.
  const cambiosBase = cambioCosto() || cambioMarkup() || cambioExtras();
  const hayCambios = cambiosBase || hayCambiosPB();
  const extrasOk = extrasValidos();
  document.getElementById('btnGuardarDet').disabled = !(hayCambios && (valido || !cambiosBase) && extrasOk && validosPB());
  document.getElementById('btnDescartar').disabled = !hayCambios;
  if (!extrasOk) msgDetalle(msgExtrasInvalidos(), true);
  else if (!validosPB()) msgDetalle(MSG_PESO_PB, true);
  else if (markup != null && markup < 0) msgDetalle('El precio queda por debajo del costo (margen negativo).', true);
  else if (cambiosBase && !valido) msgDetalle('Completá costo y margen para calcular.', true);
  else if (hayCambios) msgDetalle(MSG_SIN_GUARDAR, false, 'text-warn');
  else msgDetalle('');
}

function cambioCosto(){
  return detEstado.costoFuente !== detInicial.costoFuente
    || (detEstado.costoFuente === 'manual' && numOrNull(document.getElementById('inCosto').value) !== detInicial.costoManualValor);
}
function cambioMarkup(){
  return detEstado.markupManual !== detInicial.markupManual
    || (detEstado.markupManual && markupActual() !== detInicial.markup);
}

const MSG_SIN_GUARDAR = '● Cambios sin guardar';
function msgDetalle(txt, esError, cls){
  const el = document.getElementById('dMsg');
  if (!el) return;
  el.className = 'text-sm ' + (cls || (esError ? 'text-crit' : 'text-ok'));
  el.textContent = txt;
}

// ── Costos extra por producto: bloque editable compartido por el detalle de Almacén
// (unidad '$' = monto fijo por unidad) y el de Fraccionado ('$/kg', por granel). Misma clave
// de costeo.json y mismo PUT /api/precios/costos-extra/:plu: en los ítems, tipo 'kg' es el
// importe fijo en los dos tabs (sólo cambia el rótulo). Un modal abierto a la vez → estado único.
const COSTO_EXTRA_MAX_ITEMS = 20;
let ceItems = [];          // copia editable [{ concepto, tipo: 'kg'|'pct', valor }]
let ceInicial = '[]';
let ceUnidad = '$';
let ceOnCambio = () => {};
const textoCostoExtra = (it, unidad) => `${it.concepto}: ${it.tipo === 'kg' ? '$ ' + fmtMoney(it.valor) + (unidad === '$/kg' ? '/kg' : '') : it.valor + '%'}`;
const claveExtras = items => JSON.stringify(items.map(it => [String(it.concepto || '').trim(), it.tipo, it.valor]));
const cambioExtras = () => claveExtras(ceItems) !== ceInicial;
const itemsCostosExtra = () => ceItems.map(it => ({ concepto: String(it.concepto).trim(), tipo: it.tipo, valor: it.valor }));
// Mismos límites que validarCostosExtra (lib/precios_costeo.js); el server valida igual.
const extrasValidos = () => ceItems.every(it => {
  const c = String(it.concepto || '').trim();
  if (!c || c.length > 60 || it.valor == null) return false;
  return it.tipo === 'kg' ? it.valor >= 0 && it.valor <= 1e6 : it.valor >= -100 && it.valor <= 1000;
});
const msgExtrasInvalidos = () => `Costos extra: completá concepto y valor (${ceUnidad} de 0 a 1.000.000; % de −100 a 1000).`;
// Tooltip de la columna Costo de los listados: base (+ costos varios) + extras, con el desglose.
function tipCostoExtras(f, unidad, varios = null){
  const items = f.costosExtra || [];
  if (!items.length || f.costoBase == null) return '';
  return `Base $ ${fmtMoney(f.costoBase)}${varios ? ` + varios $ ${fmtMoney(varios)}` : ''} + extras $ ${fmtMoney(f.costoExtraTotal)}\n`
    + items.map(it => textoCostoExtra(it, unidad)).join('\n');
}

// Espejo de aplicarCostosExtra (lib/precios_costeo.js): % sobre el costo base, cada importe a 2
// decimales. `otros` = lo que se suma aparte del base (costos varios de Almacén).
function extrasCliente(base, otros = 0, items = ceItems){
  if (base == null) return { total: null, subtotal: null, importes: items.map(() => null) };
  const importes = items.map(it => it.valor == null ? null : r2(it.tipo === 'kg' ? it.valor : base * it.valor / 100));
  const subtotal = r2(importes.reduce((s, v) => s + (v || 0), 0));
  return { total: r2(importes.reduce((s, v) => s + (v || 0), base + otros)), subtotal, importes };
}

// Contenido del bloque (el contenedor lo pone cada modal). Después de insertarlo: iniciarCostosExtra.
function htmlCostosExtra(unidad, ayuda){
  return `
    <div class="ec sec s-extra"><span class="ec-op" aria-hidden="true">+</span>
      <div class="min-w-0">
        <button type="button" id="ceToggle" aria-expanded="false" aria-controls="cePanel" class="inline-flex items-center gap-1.5 font-semibold hover:text-verde">
          <span id="ceCaret" aria-hidden="true" class="text-[9px] text-gris transition-transform">▶</span>Costos extra
          <span id="ceResumen" class="font-normal text-gris"></span></button>
        <div id="cePanel" class="hidden mt-2">
          <div id="ceLista" class="space-y-1.5"></div>
          <button type="button" id="ceAgregar" class="mt-2 text-xs font-semibold text-verde hover:text-verdeHover disabled:opacity-40">+ Agregar costo extra</button>
          <p class="text-[11px] text-gris mt-1">${ayuda}</p>
        </div>
      </div>
      <span id="ceSubtotal" class="ec-val">—</span></div>
    <div class="ec ec-total sec s-costo"><span class="ec-op" aria-hidden="true">=</span>
      <span class="font-semibold">Costo total${unidad === '$/kg' ? ' por kg' : ''}</span>
      <span id="ceTotal" class="ec-val font-semibold">—</span></div>`;
}

// Plegado por defecto: el renglón muestra "n ítems" + subtotal; se despliega al tocarlo.
function desplegarCostosExtra(abrir){
  document.getElementById('cePanel').classList.toggle('hidden', !abrir);
  document.getElementById('ceToggle').setAttribute('aria-expanded', String(abrir));
  document.getElementById('ceCaret').style.transform = abrir ? 'rotate(90deg)' : '';
}

function iniciarCostosExtra(items, unidad, onCambio){
  ceUnidad = unidad; ceOnCambio = onCambio;
  restaurarCostosExtra(items);
  ceInicial = claveExtras(ceItems);
  const agregar = () => {
    if (ceItems.length >= COSTO_EXTRA_MAX_ITEMS) return;
    ceItems = [...ceItems, { concepto: '', tipo: 'kg', valor: null }];
    pintarCostosExtra(); ceOnCambio();
    const conceptos = document.querySelectorAll('#ceLista .ce-concepto');
    conceptos[conceptos.length - 1].focus();
  };
  document.getElementById('ceAgregar').onclick = agregar;
  // Sin ítems, tocar el renglón ya abre uno nuevo para cargar.
  document.getElementById('ceToggle').onclick = () => {
    const abierto = document.getElementById('ceToggle').getAttribute('aria-expanded') === 'true';
    desplegarCostosExtra(!abierto);
    if (!abierto && !ceItems.length) agregar();
  };
}
// Vuelve a los ítems guardados (Descartar) sin tocar ceInicial.
function restaurarCostosExtra(items){
  ceItems = (items || []).map(it => ({ ...it }));
  pintarCostosExtra();
}

function pintarCostosExtra(){
  const lista = document.getElementById('ceLista');
  lista.innerHTML = ceItems.length ? ceItems.map((it, i) => `
    <div class="flex items-center gap-1.5 flex-wrap" data-i="${i}">
      <input type="text" maxlength="60" placeholder="Concepto (envase, flete…)" aria-label="Concepto del costo extra ${i + 1}"
        class="ce-concepto flex-1 min-w-[9rem] num-in" style="text-align:left" value="${esc(it.concepto)}">
      <select class="ce-tipo num-in" aria-label="Tipo del costo extra ${i + 1}">
        <option value="kg"${it.tipo === 'kg' ? ' selected' : ''}>${ceUnidad}</option>
        <option value="pct"${it.tipo === 'pct' ? ' selected' : ''}>%</option>
      </select>
      <input type="number" step="any" inputmode="decimal" aria-label="Valor del costo extra ${i + 1}" class="ce-valor w-20 num-in" value="${esc(it.valor ?? '')}">
      <span class="ce-importe w-24 text-right tabular-nums text-xs text-gris"></span>
      <button type="button" class="ce-quitar w-7 h-7 rounded-lg text-gris hover:text-crit hover:bg-crit/10" aria-label="Quitar costo extra ${i + 1}" title="Quitar">✕</button>
    </div>`).join('') : '<div class="text-xs text-gris">Sin costos extra.</div>';
  // Editar un campo actualiza ceItems sin re-dibujar (no se pierde el foco); agregar/quitar re-dibuja.
  const editar = (i, cambio) => { ceItems = ceItems.map((it, k) => k === i ? { ...it, ...cambio } : it); ceOnCambio(); };
  lista.querySelectorAll('[data-i]').forEach(row => {
    const i = Number(row.dataset.i);
    row.querySelector('.ce-concepto').addEventListener('input', e => editar(i, { concepto: e.target.value }));
    row.querySelector('.ce-tipo').addEventListener('change', e => editar(i, { tipo: e.target.value }));
    row.querySelector('.ce-valor').addEventListener('input', e => editar(i, { valor: numOrNull(e.target.value) }));
    row.querySelector('.ce-quitar').onclick = () => {
      ceItems = ceItems.filter((_, k) => k !== i); pintarCostosExtra(); ceOnCambio();
      document.getElementById('ceAgregar').focus();
    };
  });
  document.getElementById('ceAgregar').disabled = ceItems.length >= COSTO_EXTRA_MAX_ITEMS;
}

// Pinta importes/resumen/subtotal/total del bloque y devuelve el costo total (null sin costo base).
function pintarTotalesCostosExtra(base, otros = 0){
  const ext = extrasCliente(base, otros);
  const sufijo = ceUnidad === '$/kg' ? ' /kg' : '';
  document.querySelectorAll('#ceLista [data-i]').forEach(row => {
    const v = ext.importes[Number(row.dataset.i)];
    row.querySelector('.ce-importe').textContent = v != null ? '$ ' + fmtMoney(v) + sufijo : '—';
  });
  const n = ceItems.length;
  document.getElementById('ceResumen').innerHTML = n
    ? `· ${n} ${n === 1 ? 'ítem' : 'ítems'}` : '<span class="text-verde">· agregar</span>';
  document.getElementById('ceSubtotal').textContent = n && ext.subtotal != null ? '$ ' + fmtMoney(ext.subtotal) : '—';
  document.getElementById('ceTotal').textContent = ext.total != null ? '$ ' + fmtMoney(ext.total) : '—';
  return ext.total;
}

// Guarda sólo lo que cambió: costo, markup manual (null = volver al automático), costos extra y
// los % propios de pack/bulto pendientes.
async function guardarDetalle(){
  const costo = numOrNull(document.getElementById('inCosto').value);
  const markup = markupActual();
  const put = (url, body) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(r => r.json()).then(j => { if (j.error) throw new Error(j.error); return j; });
  const plu = encodeURIComponent(det.plu);
  const tareas = [];
  if (cambioCosto()) {
    const fuente = detEstado.costoFuente;
    tareas.push(put('/api/precios/costo-producto/' + plu, fuente === 'manual' ? { fuente, costo } : { fuente }));
  }
  if (cambioMarkup()) {
    tareas.push(put('/api/precios/margen-producto/' + plu, { markupPct: detEstado.markupManual ? markup : null }));
  }
  if (cambioExtras()) tareas.push(put('/api/precios/costos-extra/' + plu, { items: itemsCostosExtra() }));
  tareas.push(guardarPendientesPB()); // precios_pack_bulto.js: los que fallen quedan pendientes
  document.getElementById('btnGuardarDet').disabled = true;
  msgDetalle('Guardando…', false, 'text-gris');
  try {
    await Promise.all(tareas);
    await abrirDetalle(det.plu);
    msgDetalle('Guardado.');
    cargarAlmacen();
    refrescarAlertasProduccion(); // precios_produccion.js: el costo puede ser insumo/materia prima de Producción
  } catch (e) {
    msgDetalle(e.message, true);
    document.getElementById('btnGuardarDet').disabled = false;
  }
}

// Cerrar con cambios sin guardar pide confirmación (Descartar habilitado = hay cambios).
async function cerrarDetalle(){
  const modal = document.getElementById('mDet');
  if (modal.classList.contains('hidden')) return;
  const hayCambios = !document.getElementById('mDetPie').classList.contains('hidden') && !document.getElementById('btnDescartar').disabled;
  if (hayCambios && !(await confirmar('Hay cambios sin guardar. ¿Cerrar y descartarlos?', { textoOk: 'Descartar' }))) return;
  modal.classList.add('hidden'); modal.classList.remove('flex');
  limpiarPendientesPB();
  if (detFocoPrevio && document.contains(detFocoPrevio)) detFocoPrevio.focus();
}
// Tab no se escapa del modal abierto: del último control vuelve al primero y viceversa.
function atraparFocoModal(e){
  const caja = document.getElementById('mDetCaja');
  const focos = [...caja.querySelectorAll('button, input, select, a[href]')].filter(el => !el.disabled && el.offsetParent !== null);
  if (!focos.length) return;
  const primero = focos[0], ultimo = focos[focos.length - 1], actual = document.activeElement;
  if (e.shiftKey && (actual === primero || actual === caja)) { e.preventDefault(); ultimo.focus(); }
  else if (!e.shiftKey && actual === ultimo) { e.preventDefault(); primero.focus(); }
}
document.getElementById('mDetX').onclick = cerrarDetalle;
document.getElementById('mDet').addEventListener('click', e => { if (e.target.id === 'mDet') cerrarDetalle(); });
