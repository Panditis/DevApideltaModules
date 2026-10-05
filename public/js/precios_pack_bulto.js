// ── Precios · Pack / Bulto (Fase 4, UI) ──────────────────────────────────────
// Script clásico cargado al final de precios.html: reusa sus globales (esc, fmtMoney, fmtPrecio, fmtPct,
// chip, badgeSemaforo, claseDelta, numOrNull, avisar, confirmar, marcarPlus, det, detCfg, almacenData,
// cargarAlmacen, renderAlmacen, renderListados), los de precios_fraccionado.js (fraccData, fraccTol,
// pedirJson, cargarFraccionado, renderFraccionado, actualizarBotonesFiltroFr) y los de
// precios_produccion.js (htmlBuscadorSiga, conectarBuscadorSiga).
// Pack y bulto son derivados de su producto normal: el server manda en cada fila base `packBulto` y acá
// sólo se pintan dentro de los modales de detalle, se recalculan en vivo en los modales y se edita el %
// propio (PUT/DELETE /api/precios/pack-bulto/descuento/:plu).
// Pesables (Fraccionado: sub-filas y bultos del granel): modo de venta "Por kg" / "Por paquete" + peso (kg),
// PUT /api/precios/pack-bulto/venta/:plu; por paquete el precio es el del paquete ($/kg × peso).
// % y modo/peso quedan pendientes (pbPend) y se guardan con el Guardar del pie de cada modal, como el resto.
// Plan: docs/superpowers/plans/2026-09-25-precios-fase4-pack-bulto.md

// ── Helpers puros (sin DOM; test/precios_pack_bulto_ui.test.js) ─────────────────
const PB_TIPO = { pack: 'Pack', bulto: 'Bulto' };
const PB_PASO = 50;
const PB_PESO_MAX = 1000; // kg, mismo tope que configPackBultoSanitizada
const PB_RATIO_UNIDAD = [0.5, 1.2]; // mismo rango "revisar unidad" que lib/precios_pack_bulto.js
const fmtEnteroPB = n => new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 }).format(n);
const fmtKgPB = n => (n == null ? '—' : new Intl.NumberFormat('es-AR', { maximumFractionDigits: 3 }).format(n) + ' kg');
const esPaquetePB = it => it.modoVenta === 'paquete';

// 9,7 → '−9,7%' (descuento); −5 → '+5%' (el pack sale más caro que el suelto).
function fmtDescPB(d) {
  if (d == null || !Number.isFinite(Number(d))) return '—';
  const s = String(+Math.abs(d).toFixed(2)).replace('.', ',');
  return d > 0 ? `−${s}%` : d < 0 ? `+${s}%` : '0%';
}

// Espejo de precioPackBulto (lib/precios_pack_bulto.js): redondeo a $50 salvo alineado exacto (< $0,50 del vigente).
function precioPackBultoCli(base, descPct, vigente) {
  if (!(base > 0) || descPct == null) return null;
  const exacto = base * (1 - descPct / 100);
  return vigente > 0 && Math.abs(exacto - vigente) < 0.5 ? vigente : Math.round(exacto / PB_PASO) * PB_PASO;
}

// Recalcula una sub-fila con el precio del base que se está editando (mismo compararConVigente del server).
// Por paquete: precio /kg del base × peso; sin peso válido → faltante 'peso' (como el server).
function recalcularItemPB(it, precioBase, tol) {
  const paquete = esPaquetePB(it);
  const faltan = [...(precioBase > 0 ? [] : ['base']), ...(paquete && !(it.pesoKg > 0) ? ['peso'] : [])];
  const precioSugerido = faltan.length ? null : precioPackBultoCli(paquete ? precioBase * it.pesoKg : precioBase, it.descPct, it.precioVigente);
  if (precioSugerido == null) return { ...it, precioSugerido: null, deltaPct: null, semaforo: null, faltantes: faltan.length ? faltan : ['base'] };
  const vig = it.precioVigente;
  if (!(vig > 0)) return { ...it, precioSugerido, deltaPct: null, semaforo: null, faltantes: [] };
  const deltaPct = +(((precioSugerido - vig) / vig) * 100).toFixed(1);
  const semaforo = Math.abs(deltaPct) <= (Number(tol) || 0) ? 'ok' : deltaPct > 0 ? 'subir' : 'bajar';
  return { ...it, precioSugerido, deltaPct, semaforo, faltantes: [] };
}

const aplicarMarcadosPB = (items, set) => (items || []).map(i => (i.marcado === set.has(i.plu) ? i : { ...i, marcado: set.has(i.plu) }));
const conPB = f => (f.packBulto || []).length > 0;

// Filas de exportación (mismo shape que filasExportacion): Costo = costo total de su base (misma unidad);
// pesable por paquete: costo $/kg del base × peso (Venta = precio del paquete).
const costoPB = (i, costoTotal) => (esPaquetePB(i) && costoTotal != null && i.pesoKg > 0 ? Math.round(costoTotal * i.pesoKg * 100) / 100 : costoTotal);
function filasPBMarcadas(almacen, fracc) {
  const vistos = new Set();
  const filas = [];
  const agregar = (items, costoTotal, ivaPct) => (items || []).filter(i => i.marcado && !vistos.has(i.plu)).forEach(i => {
    vistos.add(i.plu);
    filas.push({ plu: i.plu, nombre: i.nombre, costoTotal: costoPB(i, costoTotal), precioConIva: i.precioSugerido, faltantes: i.faltantes, ivaPct });
  });
  for (const f of almacen || []) agregar(f.packBulto, f.costoTotal, f.ivaPct);
  for (const g of fracc || []) for (const p of g.presentaciones || []) agregar(p.packBulto, g.costoTotal, p.ivaPct);
  return filas;
}

// 'Pack: $ 2.700 (−9,7%) · Bulto: $ 2.550 (−14,7%)'
const resumenPB = items => (items || []).map(i => `${PB_TIPO[i.tipo] || i.tipo}: ${i.precioSugerido != null
  ? '$ ' + fmtEnteroPB(i.precioSugerido) : 'sin precio'} (${fmtDescPB(i.descPct)})`).join(' · ');

// Resultado de "Alinear con SIGA": título + motivos de omisión agrupados (el detalle entre paréntesis se agrupa).
function textoAlinearPB(j) {
  const omitidos = j.omitidos || [];
  const cuenta = new Map();
  for (const o of omitidos) { const k = String(o.motivo || '').replace(/\s*\(.*\)$/, ''); cuenta.set(k, (cuenta.get(k) || 0) + 1); }
  const motivos = [...cuenta].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es')).map(([k, n]) => `${k}: ${n}`);
  return { titulo: `${j.alineados} alineados · ${omitidos.length} omitidos`, motivos };
}

// Bulto/pack de un granel: su vigente llevado a $/kg (÷ kg de la fórmula; por paquete ÷ peso elegido),
// para compararlo con las presentaciones.
function vigenteKgPB(it) {
  const kg = esPaquetePB(it) ? it.pesoKg : it.cantidad;
  return it.precioVigente > 0 && kg > 0 ? +(it.precioVigente / kg).toFixed(2) : null;
}

// Espejo del ratio del server: vigente pack ÷ (vigente base × peso si es paquete) fuera de 0,5–1,2.
function revisarUnidadPB(it, vigBase) {
  if (it.granel) return false;
  const ref = esPaquetePB(it) ? vigBase * it.pesoKg : vigBase;
  if (!(it.precioVigente > 0 && ref > 0)) return false;
  const ratio = it.precioVigente / ref;
  return ratio < PB_RATIO_UNIDAD[0] || ratio > PB_RATIO_UNIDAD[1];
}

// Unidad del precio de un pack/bulto pesable: '/kg' o 'paquete 2,5 kg'; no pesable → ''.
const unidadPB = it => (it.modoVenta == null ? '' : !esPaquetePB(it) ? '/kg' : it.pesoKg > 0 ? `paquete ${fmtKgPB(it.pesoKg)}` : 'paquete');

// ── Cambios pendientes (% propio y modo/peso): mapa plu → cambio con la forma del ítem
// ({ descOverride, descPct } y/o { modoVenta, pesoKg }). Se guardan con el pie del modal.
const API_PB = '/api/precios/pack-bulto';
const pesoValidoPB = kg => kg > 0 && kg <= PB_PESO_MAX;
const mismoDescPB = (c, orig) => !('descOverride' in c) || c.descOverride === (orig.descOverride ?? null);
const mismaVentaPB = (c, orig) => !('modoVenta' in c)
  || (c.modoVenta === orig.modoVenta && (c.modoVenta !== 'paquete' || c.pesoKg === (orig.pesoKg ?? null)));
// Suma `cambio` al pendiente del PLU (sin mutar); lo que vuelve a quedar como el original se descarta.
function conPendientePB(pend, orig, cambio) {
  const c = { ...pend[orig.plu], ...cambio };
  const resto = {
    ...(mismoDescPB(c, orig) ? {} : { descOverride: c.descOverride, descPct: c.descPct }),
    ...(mismaVentaPB(c, orig) ? {} : { modoVenta: c.modoVenta, pesoKg: c.pesoKg }),
  };
  const { [orig.plu]: _fuera, ...otros } = pend;
  return Object.keys(resto).length ? { ...otros, [orig.plu]: resto } : otros;
}
const vistaPB = (it, ...capas) => Object.assign({}, it, ...capas.map(c => c[it.plu]));
const hayPendientesPB = pend => Object.keys(pend).length > 0;
const pendientesValidosPB = pend => Object.values(pend).every(c => c.modoVenta !== 'paquete' || pesoValidoPB(c.pesoKg));
// Pedidos al server (mismos endpoints de siempre); `cambio` = la parte que guarda cada uno.
function pedidosPB(pend) {
  return Object.entries(pend).flatMap(([plu, c]) => {
    const u = encodeURIComponent(plu);
    const desc = { descOverride: c.descOverride, descPct: c.descPct };
    const venta = { modoVenta: c.modoVenta, pesoKg: c.pesoKg };
    return [
      ...('descOverride' in c ? [{ plu, metodo: c.descOverride == null ? 'DELETE' : 'PUT', url: `${API_PB}/descuento/${u}`,
        body: c.descOverride == null ? undefined : { descPct: c.descOverride }, cambio: desc }] : []),
      ...('modoVenta' in c ? [{ plu, metodo: 'PUT', url: `${API_PB}/venta/${u}`,
        body: pesoValidoPB(c.pesoKg) ? { modo: c.modoVenta, pesoKg: c.pesoKg } : { modo: c.modoVenta }, cambio: venta }] : []),
    ];
  });
}
// Rearma plu → cambio desde pedidos (p.ej. los que fallaron vuelven a quedar pendientes).
const agruparPB = (pedidos, base = {}) => pedidos.reduce((acc, p) => ({ ...acc, [p.plu]: { ...acc[p.plu], ...p.cambio } }), base);

if (typeof module === 'object' && module.exports) {
  module.exports = {
    fmtDescPB, precioPackBultoCli, recalcularItemPB, aplicarMarcadosPB, conPB, filasPBMarcadas, resumenPB, textoAlinearPB, vigenteKgPB,
    revisarUnidadPB, unidadPB, conPendientePB, vistaPB, hayPendientesPB, pendientesValidosPB, pedidosPB, agruparPB,
  };
}

// ── Pack/bulto sólo dentro de los modales: bloque del detalle Almacén, sub-filas del modal
// Fraccionado y bloque del modal de presentación de Producción. Los listados sólo filtran. ──
let soloConPB = false;  // filtro "Con pack/bulto" de Almacén
let frConPB = false;    // ídem Fraccionado
// Chip con tooltip (chip() de precios.html no lleva title). `txt` y `title` se escapan acá.
const chipTitPB = (txt, cls, title) => `<span class="px-1.5 py-0.5 rounded text-[11px] font-semibold whitespace-nowrap ${cls}" title="${esc(title)}">${esc(txt)}</span>`;
const badgeRevisarPB = it => (it.revisarUnidad
  ? ' ' + chipTitPB('revisar unidad', 'bg-warn/15 text-warn', 'El vigente del pack/bulto no guarda proporción con el del producto normal (¿cargado por caja entera?)') : '');
const TIT_GRANEL_PB = 'El granel no tiene precio sugerido propio (se costea por presentación): no se calcula precio para este pack/bulto. Se muestra el vigente de SIGA.';
const chipGranelPB = () => chipTitPB('granel · sin sugerido', 'bg-ink/10 text-ink/60', TIT_GRANEL_PB);
const estadoPB = it => (it.granel ? chipGranelPB() : (it.faltantes || []).includes('peso') ? chip('Falta peso', 'bg-warn/15 text-warn')
  : it.precioSugerido == null ? chip('Sin precio', 'bg-ink/10 text-ink/60')
  : it.precioVigente == null ? '<span class="text-[11px] text-gris">sin vigente</span>' : badgeSemaforo(it.semaforo));
const etiquetaPB = it => `<span class="text-gris" aria-hidden="true">↳</span> <b>${PB_TIPO[it.tipo] || esc(it.tipo)}</b>
  <span class="text-gris">${fmtDescPB(it.descPct)}</span>${it.descOverride != null ? ' ' + chip('propio', 'bg-amarillo/30 text-ink') : ''}`;
const chkPB = it => `<input type="checkbox" class="pb-marca accent-verde" data-plu="${esc(it.plu)}" aria-label="Marcar ${esc(it.nombre || it.plu)} para actualizar en SIGA"${it.marcado ? ' checked' : ''}${it.precioSugerido == null ? ' disabled title="Sin precio sugerido"' : ''}>`;

// ── Cambios sin guardar del modal abierto (uno a la vez): cada modal los suma a su "hay cambios",
// los envía con su Guardar (guardarPendientesPB) y los revierte con Descartar (descartarPB). ──
let pbPend = {};        // plu → cambio sin guardar
let pbGuardados = {};   // plu → cambio ya guardado mientras el modal sigue abierto (falló otro guardado del pie)
let pbGenerales = null; // promesa de los % generales (config), una por modal
const MSG_PESO_PB = 'Falta el peso del paquete (pack/bulto por paquete: más de 0 y hasta 1000 kg).';
const hayCambiosPB = () => hayPendientesPB(pbPend);
const validosPB = () => pendientesValidosPB(pbPend);
const vistaModalPB = it => vistaPB(it, pbGuardados, pbPend);
function limpiarPendientesPB() { pbPend = {}; pbGuardados = {}; pbGenerales = null; }
const cambiarPB = (orig, cambio) => { pbPend = conPendientePB(pbPend, vistaPB(orig, pbGuardados), cambio); };
// Envía los pendientes (PUT/DELETE descuento, PUT venta). Los que fallan quedan pendientes y se lanza el error.
// ponytail: lo que se edite mientras viaja el guardado se pisa con el resultado (el guardado dura un instante).
async function guardarPendientesPB() {
  const pedidos = pedidosPB(pbPend);
  if (!pedidos.length) return;
  const res = await Promise.allSettled(pedidos.map(p => pedirJson(p.metodo, p.url, p.body)));
  const ok = pedidos.filter((_, i) => res[i].status === 'fulfilled');
  pbGuardados = agruparPB(ok, pbGuardados);
  pbPend = agruparPB(pedidos.filter((_, i) => res[i].status === 'rejected'));
  if (ok.length) pbListadosViejos();
  const falla = res.find(r => r.status === 'rejected');
  if (falla) throw new Error(`Pack/bulto sin guardar (PLU ${Object.keys(pbPend).join(', ')}): ${falla.reason.message}`);
}
// Descartar: pendientes fuera y los campos vuelven a lo guardado. itemDe(plu) = ítem original del modal.
function descartarPB(raiz, itemDe) {
  pbPend = {};
  raiz.querySelectorAll('.pb-desc').forEach(i => { i.value = vistaModalPB(itemDe(i.dataset.plu)).descOverride ?? ''; });
  raiz.querySelectorAll('.pb-venta').forEach(caja => {
    const it = vistaModalPB(itemDe(caja.dataset.plu));
    caja.querySelector('.pb-modo').value = it.modoVenta;
    caja.querySelector('.pb-peso').value = it.pesoKg ?? '';
    caja.querySelector('.pb-peso-wrap').classList.toggle('hidden', !esPaquetePB(it));
  });
}

// Checkboxes de pack/bulto en los modales: marcan el PLU del pack/bulto para exportar.
function conectarMarcasPB(raiz, alFallar) {
  raiz.querySelectorAll('.pb-marca').forEach(cb => {
    cb.parentElement.onclick = e => e.stopPropagation();
    cb.onchange = () => marcarPlus([cb.dataset.plu], cb.checked).catch(err => { cb.checked = !cb.checked; avisar(err.message); if (alFallar) alFallar(); });
  });
}
// Input del % propio (vacío = % general del tipo). Queda pendiente hasta el Guardar del pie del modal.
const inputDescPB = it => `<input type="number" step="any" min="-50" max="90" inputmode="decimal" class="pb-desc num-in w-16 text-ink" data-plu="${esc(it.plu)}" data-tipo="${esc(it.tipo)}"
  aria-label="Descuento % de ${esc(it.nombre || it.plu)}" title="Descuento % sobre el sugerido del producto normal. Vacío = % general" value="${esc(it.descOverride ?? '')}" placeholder="${esc(it.descOverride == null ? it.descPct : '')}">`;

// Selector "Por kg / Por paquete" + peso (kg, visible por paquete, precargado con la fórmula) de un pesable.
function htmlVentaPB(it) {
  if (it.modoVenta == null) return '';
  const quien = esc(it.nombre || it.plu);
  const opt = (v, txt) => `<option value="${v}"${it.modoVenta === v ? ' selected' : ''}>${txt}</option>`;
  return `<div class="pb-venta flex flex-wrap items-center gap-1 mt-1 text-[11px] text-gris" data-plu="${esc(it.plu)}">
    <select class="pb-modo num-in text-ink" style="text-align:left" aria-label="Modo de venta de ${quien}">${opt('kg', 'Por kg')}${opt('paquete', 'Por paquete')}</select>
    <span class="pb-peso-wrap whitespace-nowrap${esPaquetePB(it) ? '' : ' hidden'}"><input type="number" step="any" min="0" max="${PB_PESO_MAX}" inputmode="decimal"
      class="pb-peso num-in w-16 text-ink" aria-label="Peso (kg) del paquete de ${quien}" title="Peso del paquete en kg (precargado con la fórmula de SIGA)" value="${esc(it.pesoKg ?? '')}"> kg</span></div>`;
}

// Modo/peso → cambio pendiente (se guarda con el pie). Peso inválido queda null: faltante 'peso' y Guardar bloqueado.
function conectarVentaPB(raiz, itemDe, alCambiar) {
  raiz.querySelectorAll('.pb-venta').forEach(caja => {
    const modo = caja.querySelector('.pb-modo');
    const peso = caja.querySelector('.pb-peso');
    const cambiar = () => {
      const kg = numOrNull(peso.value);
      caja.querySelector('.pb-peso-wrap').classList.toggle('hidden', modo.value !== 'paquete');
      cambiarPB(itemDe(caja.dataset.plu), { modoVenta: modo.value, pesoKg: pesoValidoPB(kg) ? kg : null });
      alCambiar();
    };
    modo.addEventListener('change', () => { cambiar(); if (modo.value === 'paquete' && !pesoValidoPB(numOrNull(peso.value))) peso.focus(); });
    peso.addEventListener('input', cambiar);
  });
}

// % propio → cambio pendiente (vacío = volver al general, que se busca en la config para mostrarlo).
function conectarDescPB(raiz, itemDe, alCambiar) {
  raiz.querySelectorAll('.pb-desc').forEach(input => input.addEventListener('input', async () => {
    const v = numOrNull(input.value);
    let general = null;
    if (v == null) {
      try { general = await descGeneralPB(input.dataset.tipo); } catch (e) { avisar(e.message); }
      if (numOrNull(input.value) != null || !input.isConnected) return; // siguió escribiendo o se cerró el modal
    }
    cambiarPB(itemDe(input.dataset.plu), { descOverride: v, descPct: v ?? general });
    alCambiar();
  }));
}
// % general del tipo (para mostrarlo al quitar el propio): /api/precios/config trae packBulto.
async function descGeneralPB(tipo) {
  pbGenerales = pbGenerales || fetch('/api/precios/config').then(r => r.json()).then(j => { if (j.error) throw new Error(j.error); return j.packBulto || {}; });
  try {
    const pb = await pbGenerales;
    return tipo === 'pack' ? pb.descPackPct : pb.descBultoPct;
  } catch (e) { pbGenerales = null; throw e; }
}

// Partes en vivo de las filas [data-pb-item] (Almacén y Producción): etiqueta, precio, Δ y estado.
const precioPBHtml = it => (it.precioSugerido != null ? '<b class="text-verde">$ ' + fmtPrecio(it.precioSugerido) + '</b>' : '<span class="text-gris">sin precio</span>');
function pintarFilasPB(raiz, items) {
  for (const it of items) {
    const fila = raiz.querySelector(`[data-pb-item="${CSS.escape(it.plu)}"]`);
    if (!fila) continue;
    fila.querySelector('.pb-etq').innerHTML = etiquetaPB(it) + badgeRevisarPB(it);
    fila.querySelector('.pb-precio').innerHTML = precioPBHtml(it);
    fila.querySelector('.pb-delta').innerHTML = `<span class="${claseDelta(it.semaforo)}">${esc(fmtPct(it.deltaPct))}</span>`;
    fila.querySelector('.pb-estado').innerHTML = estadoPB(it);
  }
}

// Modal Almacén: bloque bajo la cuenta, recalculado en vivo con el precio final del base. La estructura
// (checkbox + input del %) se dibuja una sola vez por firma; en vivo sólo cambian etiqueta/precio/Δ/estado,
// así no se pierde el foco del % mientras se escribe.
function htmlBloquePBDetalle(items) {
  return `<div class="mt-4"><div class="pb-resumen lbl mb-1"></div>
    <div class="rounded-lg border border-borde divide-y divide-borde">${items.map(it => `
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" data-pb-item="${esc(it.plu)}">
        ${chkPB(it)}<div class="min-w-0 flex-1"><span class="pb-etq"></span><div class="text-[11px] text-gris">PLU ${esc(it.plu)} · ${esc(it.nombre || '')}</div></div>
        <span class="text-gris text-xs whitespace-nowrap">− ${inputDescPB(it)} %</span>
        <span class="pb-precio tabular-nums w-20 text-right"></span>
        <span class="tabular-nums text-gris w-20 text-right">vig. ${it.precioVigente != null ? fmtPrecio(it.precioVigente) : '—'}</span>
        <span class="pb-delta tabular-nums w-14 text-right"></span><span class="pb-estado"></span></div>`).join('')}</div>
    <p class="text-[11px] text-gris mt-1">Precio = sugerido del producto × (1 − descuento), redondeo a $50. El % propio se guarda con «Guardar».</p></div>`;
}
const itemDetPB = plu => det.packBulto.find(i => i.plu === plu);
function pintarPBDetalle(precioBase) {
  const el = document.getElementById('dPackBulto');
  if (!el) return;
  if (!det || !conPB(det)) { el.innerHTML = ''; el.dataset.firma = ''; return; }
  const items = det.packBulto.map(it => recalcularItemPB(vistaModalPB(it), precioBase, detCfg.toleranciaPct));
  const firma = JSON.stringify(det.packBulto.map(i => [i.plu, i.descOverride, i.descPct, i.marcado]));
  if (el.dataset.firma !== firma) {
    el.innerHTML = htmlBloquePBDetalle(items);
    el.dataset.firma = firma;
    conectarMarcasPB(el);
    conectarDescPB(el, itemDetPB, recalcularDetalle);
  }
  el.querySelector('.pb-resumen').textContent = 'Pack / Bulto · ' + resumenPB(items);
  pintarFilasPB(el, items);
}

// Marcados: también las sub-filas del modal abierto (det), para que un re-pintado no las desmarque.
function aplicarMarcadosDetPB(set) {
  if (!det) return;
  if (det.packBulto) det = { ...det, packBulto: aplicarMarcadosPB(det.packBulto, set) };
  if (Array.isArray(det.presentaciones)) {
    det = { ...det, presentaciones: det.presentaciones.map(p => (p.packBulto ? { ...p, packBulto: aplicarMarcadosPB(p.packBulto, set) } : p)) };
  }
}
function pbListadosViejos() { cargarAlmacen(); fraccCargado = false; cargarFraccionado(); }

// ── Fraccionado: sub-filas en la tabla de presentaciones del modal del granel ──
function htmlSubfilasFraccPB(p) {
  return (p.packBulto || []).map(it => `<tr class="pb-sub border-t border-borde/60 bg-bg/40 text-[13px]" data-pb-pres="${esc(p.plu)}" data-pb-plu="${esc(it.plu)}">
    <td class="py-2 pr-2">${chkPB(it)}</td>
    <td class="py-2 pr-3 pl-3"><span class="pb-etq">${etiquetaPB(it)}${badgeRevisarPB(it)}</span><div class="text-[11px] text-gris">PLU ${esc(it.plu)} · ${esc(it.nombre || '')}</div>${htmlVentaPB(it)}</td>
    <td class="py-2 pr-3 whitespace-nowrap text-right text-gris text-xs">− ${inputDescPB(it)} %</td>
    <td class="pb-final py-2 pr-3 text-right tabular-nums"></td>
    <td class="hidden sm:table-cell py-2 pr-3 text-right tabular-nums text-gris">${fmtMoney(it.precioVigente)}</td>
    ${htmlFechaPrecio(it.fechaPrecio, 'hidden sm:table-cell py-2 pr-3')}
    <td class="py-2 text-right whitespace-nowrap"><div class="pb-delta tabular-nums"></div><div class="pb-estado mt-0.5"></div></td></tr>`).join('');
}
// En vivo desde recalcularDetalleFracc: precio /kg de la presentación que se está editando (por paquete × peso).
// p.precioVigente = vigente del base, para el ratio "revisar unidad" del modo elegido.
function pintarSubfilasFraccPB(p, precioBase) {
  for (const it of p.packBulto || []) {
    const tr = document.querySelector(`#mDetBody tr[data-pb-pres="${CSS.escape(p.plu)}"][data-pb-plu="${CSS.escape(it.plu)}"]`);
    if (!tr) continue;
    const calc = recalcularItemPB(vistaModalPB(it), precioBase, fraccTol);
    const r = { ...calc, revisarUnidad: revisarUnidadPB(calc, p.precioVigente) };
    tr.querySelector('.pb-etq').innerHTML = etiquetaPB(r) + badgeRevisarPB(r);
    tr.querySelector('.pb-marca').disabled = r.precioSugerido == null;
    const unidad = unidadPB(r) ? `<div class="text-[11px] text-gris">${esc(unidadPB(r))}</div>` : '';
    tr.querySelector('.pb-final').innerHTML = (r.precioSugerido == null ? '<span class="text-gris">sin precio</span>' : `<b class="text-verde">$ ${fmtPrecio(r.precioSugerido)}</b>`) + unidad;
    const d = tr.querySelector('.pb-delta');
    d.className = 'pb-delta tabular-nums ' + claseDelta(r.semaforo);
    d.textContent = fmtPct(r.deltaPct);
    tr.querySelector('.pb-estado').innerHTML = estadoPB(r);
  }
}
// Ítem original (sin pendientes) del modal del granel: sub-filas de presentaciones y bultos del granel.
const itemFraccPB = plu => [...det.presentaciones.flatMap(p => p.packBulto || []), ...(det.packBultoGranel || [])].find(i => i.plu === plu);
function conectarSubfilasFraccPB() {
  const cuerpo = document.getElementById('mDetBody');
  conectarMarcasPB(cuerpo);
  conectarDescPB(cuerpo, itemFraccPB, recalcularDetalleFracc);
  conectarVentaPB(cuerpo, itemFraccPB, recalcularDetalleFracc);
}

// Bloque "Bultos / packs del granel" (fórmula SIGA = el granel mismo, grupo.packBultoGranel): sin precio
// sugerido ni exportación — PLU, nombre, modo de venta (kg/paquete + peso), kg de la fórmula, vigente
// (y su $/kg: ÷ kg de la fórmula, o ÷ peso elegido si es por paquete) y estado.
const txtVigKgPB = it => { const kg = vigenteKgPB(it); return kg != null ? `$ ${fmtPrecio(kg)}/kg` : ''; };
function htmlBloquePBGranel(items) {
  if (!(items || []).length) return '';
  const fila = it => `<tr class="border-t border-borde" data-pb-granel="${esc(it.plu)}">
      <td class="py-2 pr-3 pl-2"><b>${esc(PB_TIPO[it.tipo] || it.tipo)}</b> ${esc(it.nombre || '')}<div class="text-[11px] text-gris">PLU ${esc(it.plu)}</div>${htmlVentaPB(it)}</td>
      <td class="py-2 pr-3 text-right tabular-nums">${esc(fmtKgPB(it.cantidad))}</td>
      <td class="py-2 pr-3 text-right tabular-nums">${fmtMoney(it.precioVigente)}<div class="pb-vkg text-[11px] text-gris">${esc(txtVigKgPB(it))}</div></td>
      <td class="py-2 pr-2 text-right">${estadoPB(it)}</td></tr>`;
  return `<div class="mt-5 mb-1.5"><h4 class="lbl sec-tit">Bultos / packs del granel</h4>
    <p class="text-[11px] text-gris">Fórmula SIGA = este granel. Sin precio sugerido: se muestra el vigente de SIGA (no se exportan). Por paquete, el $/kg del vigente usa el peso elegido.</p></div>
    <div class="overflow-x-auto rounded-lg border border-borde"><table class="w-full text-sm">
      <thead class="bg-verde/5"><tr class="border-b border-borde text-[11px] text-gris">
        <th scope="col" class="py-1.5 pr-3 pl-2 text-left font-semibold">Pack / bulto</th><th scope="col" class="py-1.5 pr-3 text-right font-semibold">Cantidad</th>
        <th scope="col" class="py-1.5 pr-3 text-right font-semibold">Vigente</th><th scope="col" class="py-1.5 pr-2 text-right font-semibold">Estado</th></tr></thead>
      <tbody>${items.map(fila).join('')}</tbody></table></div>`;
}
// En vivo (recalcularDetalleFracc): sólo el $/kg del vigente de cada bulto del granel según modo/peso.
function pintarGranelPB() {
  for (const it of det.packBultoGranel || []) {
    const vkg = document.querySelector(`#mDetBody tr[data-pb-granel="${CSS.escape(it.plu)}"] .pb-vkg`);
    if (vkg) vkg.textContent = txtVigKgPB(vistaModalPB(it));
  }
}

// ── Producción: bloque en el modal de presentación ──────────
// Ítems a mostrar: los del server (preview o guardado) y, los que tienen cambios, recalculados en vivo.
const itemsProdPB = (items, precioBase) => (items || []).map(it => (pbPend[it.plu] || pbGuardados[it.plu]
  ? recalcularItemPB(vistaModalPB(it), precioBase, fraccTol) : it));
function htmlBloquePBProd(items, precioBase) {
  if (!(items || []).length) return '';
  return `<div class="mt-4"><div class="lbl mb-1">Pack / Bulto</div><div class="rounded-lg border border-borde divide-y divide-borde">${itemsProdPB(items, precioBase).map(it => `
    <div class="px-3 py-2 text-sm" data-pb-item="${esc(it.plu)}"><div><span class="pb-etq">${etiquetaPB(it)}${badgeRevisarPB(it)}</span><div class="text-[11px] text-gris">PLU ${esc(it.plu)} · ${esc(it.nombre || '')}</div></div>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
      <span class="text-gris text-xs whitespace-nowrap">− ${inputDescPB(it)} %</span>
      <span class="pb-precio tabular-nums">${precioPBHtml(it)}</span>
      <span class="tabular-nums text-gris">vig. ${it.precioVigente != null ? fmtPrecio(it.precioVigente) : '—'}</span>
      <span class="pb-delta tabular-nums"><span class="${claseDelta(it.semaforo)}">${esc(fmtPct(it.deltaPct))}</span></span><span class="pb-estado">${estadoPB(it)}</span></div></div>`).join('')}</div>
    <p class="text-[11px] text-gris mt-1">Se calculan solos sobre el sugerido de esta presentación. El % propio (vacío = general) se guarda con «Guardar presentación».</p></div>`;
}
// Modal de presentación: editar un % propio recalcula en vivo la fila (mismo cálculo que el server sobre el
// sugerido de la presentación) y actualiza el pie; se guarda con «Guardar presentación».
function conectarBloquePBProd(el, items, precioBase) {
  const itemDe = plu => items.find(i => i.plu === plu);
  conectarDescPB(el, itemDe, () => { pintarFilasPB(el, itemsProdPB(items, precioBase)); pintarPiePres(); });
}

// ── Configuración › Pack / Bulto ────────────────────────────────────────────────
// % generales, "Alinear con SIGA", % propios por producto, vínculos manuales y lista "sin vincular".
let pbConfig = null; // GET /api/precios/pack-bulto/vinculos: { config, vinculos, sinVincular }
const cardPB = cuerpo => `<div class="cfg-card">
  <h3 class="cfg-h">Pack / Bulto</h3>${cuerpo}</div>`;

async function cargarConfigPB() {
  const cont = document.getElementById('configPackBulto');
  if (!cont) return;
  cont.innerHTML = cardPB('<div class="text-sm text-ink/50 py-4"><span class="spin"></span> Cargando vínculos de SIGA…</div>');
  try {
    const j = await (await fetch(`${API_PB}/vinculos`)).json();
    if (j.error) throw new Error(j.error);
    pbConfig = j;
    pintarConfigPB();
  } catch (e) {
    cont.innerHTML = cardPB(`<p class="text-crit text-sm">No se pudo cargar: ${esc(e.message)}</p>`);
  }
}

function pintarConfigPB() {
  const { config, vinculos, sinVincular } = pbConfig;
  const manuales = vinculos.filter(v => v.origen === 'manual');
  document.getElementById('configPackBulto').innerHTML = cardPB(`
    <p class="cfg-ayuda">Precio pack/bulto = sugerido del producto normal × (1 − descuento), redondeo a $50. Vínculo automático:
      productos del rubro "Almacen Bultos/Cajas" con un solo componente en su fórmula activa de SIGA. ${vinculos.length} vinculados · ${sinVincular.length} sin vincular.</p>
    <div id="pbGral" class="rounded-lg border border-borde p-4" data-guardable data-nombre="Pack / Bulto (descuentos generales)">
      <div class="flex flex-wrap items-center gap-x-8 gap-y-3">
        <div class="cfg-campo gap-3"><label for="pbDescPack">Descuento general pack</label>
          ${campoU(`<input id="pbDescPack" type="number" min="0" max="90" step="any" value="${esc(config.descPackPct)}">`, '%')}</div>
        <div class="cfg-campo gap-3"><label for="pbDescBulto">Descuento general bulto</label>
          ${campoU(`<input id="pbDescBulto" type="number" min="0" max="90" step="any" value="${esc(config.descBultoPct)}">`, '%')}</div>
      </div>
      <p class="cfg-nota mt-2">Se usan sólo en los pack/bulto sin % propio (nuevos o sin precio vigente en SIGA).</p>
      <div class="cfg-pie mt-3 pt-3">
        <span id="pbGralMsg" class="text-sm" role="status" aria-live="polite"></span>
        <button type="button" id="pbGuardarGral" class="cfg-btn">Guardar</button></div>
    </div>
    <div class="mt-5 flex items-center gap-3">
      <button type="button" id="pbAlinear" class="cfg-btn2">Alinear con SIGA</button>
      <span class="text-xs text-gris">Guarda como % propio el descuento que hoy tiene cada pack/bulto en SIGA (vigente pack ÷ vigente producto normal).</span></div>
    <div id="pbAlinearMsg" class="text-sm mt-2" role="status" aria-live="polite"></div>
    ${htmlOverridesPB(config.descPorProducto)}
    ${htmlManualesPB(manuales)}
    ${htmlSinVincularPB(sinVincular)}`);
  conectarConfigPB();
}

const vinculoDe = plu => (pbConfig.vinculos || []).find(v => v.plu === plu) || {};
function htmlFilaOverridePB([plu, pct]) {
  const v = vinculoDe(plu);
  return `<tr class="border-t border-borde"><td class="p-1.5 tabular-nums">${esc(plu)}</td><td class="p-1.5">${esc(v.nombre || '— (sin vínculo)')}</td>
    <td class="p-1.5">${esc(PB_TIPO[v.tipo] || '—')}</td><td class="p-1.5 text-gris">${esc(v.baseNombre || v.basePlu || '—')}</td>
    <td class="p-1.5 text-right tabular-nums">${fmtDescPB(pct)}</td>
    <td class="p-1.5 text-right"><button type="button" class="pb-quitar-desc text-xs text-gris hover:text-crit" data-plu="${esc(plu)}">Quitar</button></td></tr>`;
}
function htmlOverridesPB(desc) {
  const nombre = plu => String(vinculoDe(plu).nombre || plu);
  const filas = Object.entries(desc || {}).sort((a, b) => nombre(a[0]).localeCompare(nombre(b[0]), 'es'));
  const cuerpo = filas.length ? filas.map(htmlFilaOverridePB).join('')
    : '<tr><td colspan="6" class="p-3 text-center text-gris text-sm">Sin % propios: todos usan el general.</td></tr>';
  return `<details class="mt-5 border-t border-borde pt-4"${filas.length <= 20 ? ' open' : ''}>
    <summary class="font-semibold cursor-pointer">Descuentos propios por producto <span class="text-gris font-normal">(${filas.length})</span></summary>
    <div class="overflow-auto mt-2 rounded-lg border border-borde" style="max-height:360px"><table class="w-full text-sm">
      <thead class="bg-verde/5 text-verde"><tr><th class="p-1.5 text-left">PLU</th><th class="p-1.5 text-left">Pack/bulto</th><th class="p-1.5 text-left">Tipo</th>
        <th class="p-1.5 text-left">Producto normal</th><th class="p-1.5 text-right">Descuento</th><th class="p-1.5"></th></tr></thead><tbody>${cuerpo}</tbody></table></div></details>`;
}

function htmlManualesPB(manuales) {
  if (!manuales.length) return '';
  return `<div class="mt-5 border-t border-borde pt-4"><div class="font-semibold mb-2">Vínculos manuales <span class="text-gris font-normal">(${manuales.length})</span></div>
    ${manuales.map(v => `<div class="flex flex-wrap items-center gap-2 text-sm py-1">
      <span class="tabular-nums">${esc(v.plu)}</span> ${esc(v.nombre || '')} → <b>${esc(PB_TIPO[v.tipo] || v.tipo)}</b> de
      <span class="tabular-nums">${esc(v.basePlu)}</span> ${esc(v.baseNombre || '')}
      <button type="button" class="pb-quitar-vinc ml-auto text-xs text-gris hover:text-crit" data-plu="${esc(v.plu)}">Quitar vínculo</button></div>`).join('')}</div>`;
}

function htmlSinVincularPB(lista) {
  const filas = lista.length ? lista.map(s => `<tr class="border-t border-borde" data-sv="${esc(s.plu)}">
      <td class="p-1.5 tabular-nums">${esc(s.plu)}</td><td class="p-1.5">${esc(s.nombre || '')}</td><td class="p-1.5 text-gris text-xs">${esc(s.motivo)}</td>
      <td class="p-1.5 text-right"><button type="button" class="pb-vincular text-xs font-semibold text-verde hover:text-verdeHover">Vincular…</button></td></tr>`).join('')
    : '<tr><td colspan="4" class="p-3 text-center text-gris text-sm">Todos los productos del rubro quedaron vinculados.</td></tr>';
  return `<details class="mt-5 border-t border-borde pt-4" open>
    <summary class="font-semibold cursor-pointer">Sin vincular <span class="text-gris font-normal">(${lista.length})</span></summary>
    <p class="text-[11px] text-gris mt-1">Sin fórmula, fórmula con varios componentes o tipo ambiguo por nombre (los de un granel se ven en su detalle de Fraccionado). Vinculalos a mano con su producto normal.</p>
    <div class="overflow-auto mt-2 rounded-lg border border-borde" style="max-height:420px"><table class="w-full text-sm"><tbody id="pbSinVincular">${filas}</tbody></table></div></details>`;
}

// Editor en línea de un vínculo manual (uno a la vez): buscador SIGA del producto normal + tipo.
function abrirVinculoPB(tr) {
  document.querySelectorAll('#pbSinVincular tr.pb-editor').forEach(x => x.remove());
  const plu = tr.dataset.sv;
  const sugerido = /\bpack\b/i.test(tr.children[1].textContent) ? 'pack' : 'bulto';
  const opt = t => `<option value="${t}"${sugerido === t ? ' selected' : ''}>${PB_TIPO[t]}</option>`;
  tr.insertAdjacentHTML('afterend', `<tr class="pb-editor bg-bg/60"><td colspan="4" class="p-2"><div class="flex flex-wrap items-center gap-2">
    ${htmlBuscadorSiga('pbBuscaBase', 'Producto normal (PLU o nombre)…')}
    <span id="pbBaseElegida" class="text-sm text-gris">sin elegir</span>
    <select id="pbTipo" class="${inputCls}" style="text-align:left" aria-label="Tipo">${opt('pack')}${opt('bulto')}</select>
    <button type="button" id="pbGuardarVinc" class="px-3 py-1 rounded-lg bg-verde text-white text-sm hover:bg-verdeHover disabled:opacity-40" disabled>Vincular</button>
    <button type="button" id="pbCancelarVinc" class="px-2 py-1 text-sm text-gris hover:text-ink">Cancelar</button></div></td></tr>`);
  let base = null;
  conectarBuscadorSiga('pbBuscaBase', elegido => {
    base = elegido;
    document.getElementById('pbBaseElegida').textContent = `${elegido.plu} · ${elegido.nombre}`;
    document.getElementById('pbGuardarVinc').disabled = false;
  });
  document.getElementById('pbCancelarVinc').onclick = () => tr.nextElementSibling.remove();
  document.getElementById('pbGuardarVinc').onclick = () => accionConfigPB(() => pedirJson('PUT', `${API_PB}/vinculo/${encodeURIComponent(plu)}`,
    { basePlu: base.plu, tipo: document.getElementById('pbTipo').value }));
  document.getElementById('pbBuscaBase').focus();
}

// Ejecuta una escritura, recarga la sección y marca viejos los listados; errores → diálogo del theme.
async function accionConfigPB(fn) {
  try { await fn(); } catch (e) { avisar(e.message); return; }
  await cargarConfigPB();
  pbListadosViejos();
}

async function guardarGeneralPB() {
  const msg = document.getElementById('pbGralMsg');
  msg.className = 'text-sm text-ink/50'; msg.textContent = 'Guardando…';
  try {
    await pedirJson('PUT', '/api/precios/config/pack-bulto', {
      descPackPct: numOrNull(document.getElementById('pbDescPack').value), descBultoPct: numOrNull(document.getElementById('pbDescBulto').value),
    });
    msg.className = 'text-sm text-ok'; msg.textContent = 'Guardado.';
    limpiarSucio(document.getElementById('pbGral')); // precios_config.js
    pbListadosViejos();
  } catch (e) { msg.className = 'text-sm text-crit'; msg.textContent = e.message; }
}

async function alinearPB() {
  const pregunta = '¿Alinear los descuentos de pack/bulto con los precios vigentes de SIGA?\nPisa los % propios de los que tienen precio vigente; los que haya que revisar quedan como están.';
  if (!(await confirmar(pregunta, { textoOk: 'Alinear' }))) return;
  const btn = document.getElementById('pbAlinear');
  const msg = document.getElementById('pbAlinearMsg');
  btn.disabled = true; msg.className = 'text-sm mt-2 text-ink/50'; msg.innerHTML = '<span class="spin"></span> Alineando…';
  try {
    const t = textoAlinearPB(await pedirJson('POST', `${API_PB}/alinear-siga`));
    await cargarConfigPB();
    pbListadosViejos();
    const el = document.getElementById('pbAlinearMsg');
    el.className = 'text-sm mt-2 text-ok';
    el.innerHTML = `<b>${esc(t.titulo)}</b>${t.motivos.length ? `<ul class="text-xs text-gris mt-1 list-disc pl-5">${t.motivos.map(m => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}`;
  } catch (e) {
    msg.className = 'text-sm mt-2 text-crit'; msg.textContent = e.message; btn.disabled = false;
  }
}

function conectarConfigPB() {
  document.getElementById('pbGuardarGral').onclick = guardarGeneralPB;
  document.getElementById('pbAlinear').onclick = alinearPB;
  document.querySelectorAll('.pb-quitar-desc').forEach(b => { b.onclick = () => accionConfigPB(() => pedirJson('DELETE', `${API_PB}/descuento/${encodeURIComponent(b.dataset.plu)}`)); });
  document.querySelectorAll('.pb-quitar-vinc').forEach(b => {
    b.onclick = async () => {
      if (!(await confirmar('¿Quitar el vínculo manual? Vuelve al vínculo automático de SIGA (si lo tiene).', { textoOk: 'Quitar' }))) return;
      accionConfigPB(() => pedirJson('DELETE', `${API_PB}/vinculo/${encodeURIComponent(b.dataset.plu)}`));
    };
  });
  document.querySelectorAll('#pbSinVincular .pb-vincular').forEach(b => { b.onclick = () => abrirVinculoPB(b.closest('tr')); });
}

// ── Filtros "Con pack/bulto" (Almacén y Fraccionado) ─────────────────────────────
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const fAlm = document.getElementById('fConPB'), fFr = document.getElementById('frConPB');
    if (fAlm) fAlm.onclick = () => { soloConPB = !soloConPB; actualizarBotonesFiltro(); renderAlmacen(); };
    if (fFr) fFr.onclick = () => { frConPB = !frConPB; dropCtxs.fracc.aplicar(); };
  });
}
