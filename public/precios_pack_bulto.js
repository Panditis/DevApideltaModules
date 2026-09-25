// ── Precios · Pack / Bulto (Fase 4, UI) ──────────────────────────────────────
// Script clásico cargado al final de precios.html: reusa sus globales (esc, fmtMoney, fmtPrecio, fmtPct,
// chip, badgeSemaforo, claseDelta, numOrNull, avisar, confirmar, marcarPlus, det, detCfg, almacenData,
// cargarAlmacen, renderAlmacen, renderListados), los de precios_fraccionado.js (fraccData, fraccTol,
// pedirJson, cargarFraccionado, renderFraccionado, actualizarBotonesFiltroFr) y los de
// precios_produccion.js (htmlBuscadorSiga, conectarBuscadorSiga).
// Pack y bulto son derivados de su producto normal: el server manda en cada fila base `packBulto` y acá
// sólo se pintan dentro de los modales de detalle, se recalculan en vivo en los modales y se edita el %
// propio (PUT/DELETE /api/precios/pack-bulto/descuento/:plu, se guarda al cambiar el campo).
// Plan: docs/superpowers/plans/2026-09-25-precios-fase4-pack-bulto.md

// ── Helpers puros (sin DOM; test/precios_pack_bulto_ui.test.js) ─────────────────
const PB_TIPO = { pack: 'Pack', bulto: 'Bulto' };
const PB_PASO = 50;
const fmtEnteroPB = n => new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 }).format(n);

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
function recalcularItemPB(it, precioBase, tol) {
  const precioSugerido = precioPackBultoCli(precioBase, it.descPct, it.precioVigente);
  if (precioSugerido == null) return { ...it, precioSugerido: null, deltaPct: null, semaforo: null, faltantes: ['base'] };
  const vig = it.precioVigente;
  if (!(vig > 0)) return { ...it, precioSugerido, deltaPct: null, semaforo: null, faltantes: [] };
  const deltaPct = +(((precioSugerido - vig) / vig) * 100).toFixed(1);
  const semaforo = Math.abs(deltaPct) <= (Number(tol) || 0) ? 'ok' : deltaPct > 0 ? 'subir' : 'bajar';
  return { ...it, precioSugerido, deltaPct, semaforo, faltantes: [] };
}

const aplicarMarcadosPB = (items, set) => (items || []).map(i => (i.marcado === set.has(i.plu) ? i : { ...i, marcado: set.has(i.plu) }));
const conPB = f => (f.packBulto || []).length > 0;

// Filas de exportación (mismo shape que filasExportacion): Costo = costo total de su base (misma unidad).
function filasPBMarcadas(almacen, fracc) {
  const vistos = new Set();
  const filas = [];
  const agregar = (items, costoTotal) => (items || []).filter(i => i.marcado && !vistos.has(i.plu)).forEach(i => {
    vistos.add(i.plu);
    filas.push({ plu: i.plu, nombre: i.nombre, costoTotal, precioConIva: i.precioSugerido, faltantes: i.faltantes });
  });
  for (const f of almacen || []) agregar(f.packBulto, f.costoTotal);
  for (const g of fracc || []) for (const p of g.presentaciones || []) agregar(p.packBulto, g.costoTotal);
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

if (typeof module === 'object' && module.exports) {
  module.exports = { fmtDescPB, precioPackBultoCli, recalcularItemPB, aplicarMarcadosPB, conPB, filasPBMarcadas, resumenPB, textoAlinearPB };
}

// ── Pack/bulto sólo dentro de los modales: bloque del detalle Almacén, sub-filas del modal
// Fraccionado y bloque del modal de presentación de Producción. Los listados sólo filtran. ──
let soloConPB = false;  // filtro "Con pack/bulto" de Almacén
let frConPB = false;    // ídem Fraccionado
const API_PB = '/api/precios/pack-bulto';
// Chip con tooltip (chip() de precios.html no lleva title). `txt` y `title` se escapan acá.
const chipTitPB = (txt, cls, title) => `<span class="px-1.5 py-0.5 rounded text-[11px] font-semibold whitespace-nowrap ${cls}" title="${esc(title)}">${esc(txt)}</span>`;
const badgeRevisarPB = it => (it.revisarUnidad
  ? ' ' + chipTitPB('revisar unidad', 'bg-warn/15 text-warn', 'El vigente del pack/bulto no guarda proporción con el del producto normal (¿cargado por caja entera?)') : '');
const estadoPB = it => (it.precioSugerido == null ? chip('Sin precio', 'bg-ink/10 text-ink/60')
  : it.precioVigente == null ? '<span class="text-[11px] text-gris">sin vigente</span>' : badgeSemaforo(it.semaforo));
const etiquetaPB = it => `<span class="text-gris" aria-hidden="true">↳</span> <b>${PB_TIPO[it.tipo] || esc(it.tipo)}</b>
  <span class="text-gris">${fmtDescPB(it.descPct)}</span>${it.descOverride != null ? ' ' + chip('propio', 'bg-amarillo/30 text-ink') : ''}`;
const chkPB = it => `<input type="checkbox" class="pb-marca accent-verde" data-plu="${esc(it.plu)}" aria-label="Marcar ${esc(it.nombre || it.plu)} para actualizar en SIGA"${it.marcado ? ' checked' : ''}${it.precioSugerido == null ? ' disabled title="Sin precio sugerido"' : ''}>`;

// Checkboxes de pack/bulto en los modales: marcan el PLU del pack/bulto para exportar.
function conectarMarcasPB(raiz, alFallar) {
  raiz.querySelectorAll('.pb-marca').forEach(cb => {
    cb.parentElement.onclick = e => e.stopPropagation();
    cb.onchange = () => marcarPlus([cb.dataset.plu], cb.checked).catch(err => { cb.checked = !cb.checked; avisar(err.message); if (alFallar) alFallar(); });
  });
}
// Input del % propio (vacío = % general del tipo). Se guarda al cambiar (change), no con el pie del modal.
const inputDescPB = it => `<input type="number" step="any" min="-50" max="90" inputmode="decimal" class="pb-desc num-in w-16 text-ink" data-plu="${esc(it.plu)}" data-tipo="${esc(it.tipo)}"
  aria-label="Descuento % de ${esc(it.nombre || it.plu)}" title="Descuento % sobre el sugerido del producto normal. Vacío = % general" value="${esc(it.descOverride ?? '')}" placeholder="${esc(it.descOverride == null ? it.descPct : '')}">`;

// Modal Almacén: bloque bajo la cuenta, recalculado en vivo con el precio final del base. La estructura
// (checkbox + input del %) se dibuja una sola vez por firma; en vivo sólo cambian precio/Δ/estado, así
// no se pierde el foco del % si el usuario pasa del precio final al % de un pack.
const precioPBHtml = it => (it.precioSugerido != null ? '<b class="text-verde">$ ' + fmtPrecio(it.precioSugerido) + '</b>' : '<span class="text-gris">sin precio</span>');
function htmlBloquePBDetalle(items) {
  return `<div class="mt-4"><div class="pb-resumen lbl mb-1"></div>
    <div class="rounded-lg border border-borde divide-y divide-borde">${items.map(it => `
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" data-pb-item="${esc(it.plu)}">
        ${chkPB(it)}<div class="min-w-0 flex-1">${etiquetaPB(it)}${badgeRevisarPB(it)}<div class="text-[11px] text-gris">PLU ${esc(it.plu)} · ${esc(it.nombre || '')}</div></div>
        <span class="text-gris text-xs whitespace-nowrap">− ${inputDescPB(it)} %</span>
        <span class="pb-precio tabular-nums w-20 text-right"></span>
        <span class="tabular-nums text-gris w-20 text-right">vig. ${it.precioVigente != null ? fmtPrecio(it.precioVigente) : '—'}</span>
        <span class="pb-delta tabular-nums w-14 text-right"></span><span class="pb-estado"></span></div>`).join('')}</div>
    <p class="text-[11px] text-gris mt-1">Precio = sugerido del producto × (1 − descuento), redondeo a $50. El % propio se guarda al salir del campo.</p></div>`;
}
function pintarPBDetalle(precioBase) {
  const el = document.getElementById('dPackBulto');
  if (!el) return;
  if (!det || !conPB(det)) { el.innerHTML = ''; el.dataset.firma = ''; return; }
  const items = det.packBulto.map(it => recalcularItemPB(it, precioBase, detCfg.toleranciaPct));
  const firma = JSON.stringify(det.packBulto.map(i => [i.plu, i.descOverride, i.descPct, i.marcado]));
  if (el.dataset.firma !== firma) {
    el.innerHTML = htmlBloquePBDetalle(items);
    el.dataset.firma = firma;
    conectarMarcasPB(el);
    conectarDescPB(el, (plu, cambio) => { det = { ...det, packBulto: det.packBulto.map(i => (i.plu === plu ? { ...i, ...cambio } : i)) }; });
  }
  el.querySelector('.pb-resumen').textContent = 'Pack / Bulto · ' + resumenPB(items);
  for (const it of items) {
    const fila = el.querySelector(`[data-pb-item="${CSS.escape(it.plu)}"]`);
    fila.querySelector('.pb-precio').innerHTML = precioPBHtml(it);
    const d = fila.querySelector('.pb-delta');
    d.className = 'pb-delta tabular-nums w-14 text-right ' + claseDelta(it.semaforo);
    d.textContent = fmtPct(it.deltaPct);
    fila.querySelector('.pb-estado').innerHTML = estadoPB(it);
  }
}

// Guarda el % propio (PUT) o lo quita (DELETE, vacío) y avisa al modal con el cambio para re-pintar.
function conectarDescPB(raiz, aplicar) {
  raiz.querySelectorAll('.pb-desc').forEach(input => input.addEventListener('change', async () => {
    const plu = input.dataset.plu;
    const v = numOrNull(input.value);
    input.disabled = true;
    try {
      const url = `${API_PB}/descuento/${encodeURIComponent(plu)}`;
      if (v == null) await pedirJson('DELETE', url); else await pedirJson('PUT', url, { descPct: v });
      const general = v == null ? await descGeneralPB(input.dataset.tipo) : null;
      aplicar(plu, { descOverride: v, descPct: v ?? general });
      pbListadosViejos();
      if (document.getElementById('mDetBody').contains(input)) repintarModalPB();
    } catch (e) { avisar(e.message); input.disabled = false; }
  }));
}

// % general del tipo (para mostrarlo al quitar el propio): /api/precios/config trae packBulto.
async function descGeneralPB(tipo) {
  const j = await (await fetch('/api/precios/config')).json();
  if (j.error) throw new Error(j.error);
  const pb = j.packBulto || {};
  return tipo === 'pack' ? pb.descPackPct : pb.descBultoPct;
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
// Re-pinta el modal abierto con det ya actualizado (Almacén o Fraccionado).
function repintarModalPB() {
  if (det && det.granelPlu !== undefined) { recalcularDetalleFracc(); return; }
  recalcularDetalle();
}

// ── Fraccionado: sub-filas en la tabla de presentaciones del modal del granel ──
function htmlSubfilasFraccPB(p) {
  return (p.packBulto || []).map(it => `<tr class="pb-sub border-t border-borde/60 bg-bg/40 text-[13px]" data-pb-pres="${esc(p.plu)}" data-pb-plu="${esc(it.plu)}">
    <td class="py-2 pr-2">${chkPB(it)}</td>
    <td class="py-2 pr-3 pl-3"><span class="pb-etq">${etiquetaPB(it)}</span>${badgeRevisarPB(it)}<div class="text-[11px] text-gris">PLU ${esc(it.plu)} · ${esc(it.nombre || '')}</div></td>
    <td class="py-2 pr-3 whitespace-nowrap text-right text-gris text-xs">− ${inputDescPB(it)} %</td>
    <td class="pb-final py-2 pr-3 text-right tabular-nums"></td>
    <td class="hidden sm:table-cell py-2 pr-3 text-right tabular-nums text-gris">${fmtMoney(it.precioVigente)}</td>
    <td class="py-2 text-right whitespace-nowrap"><div class="pb-delta tabular-nums"></div><div class="pb-estado mt-0.5"></div></td></tr>`).join('');
}
// En vivo desde recalcularDetalleFracc: precio /kg de la presentación que se está editando.
function pintarSubfilasFraccPB(p, precioBase) {
  for (const it of p.packBulto || []) {
    const tr = document.querySelector(`#mDetBody tr[data-pb-pres="${CSS.escape(p.plu)}"][data-pb-plu="${CSS.escape(it.plu)}"]`);
    if (!tr) continue;
    const r = recalcularItemPB(it, precioBase, fraccTol);
    tr.querySelector('.pb-etq').innerHTML = etiquetaPB(r);
    tr.querySelector('.pb-final').innerHTML = r.precioSugerido == null ? '<span class="text-gris">sin precio</span>' : `<b class="text-verde">$ ${fmtPrecio(r.precioSugerido)}</b>`;
    const d = tr.querySelector('.pb-delta');
    d.className = 'pb-delta tabular-nums ' + claseDelta(r.semaforo);
    d.textContent = fmtPct(r.deltaPct);
    tr.querySelector('.pb-estado').innerHTML = estadoPB(r);
  }
}
function conectarSubfilasFraccPB() {
  const cuerpo = document.getElementById('mDetBody');
  conectarMarcasPB(cuerpo);
  conectarDescPB(cuerpo, (plu, cambio) => {
    det = { ...det, presentaciones: det.presentaciones.map(p => ({ ...p, packBulto: (p.packBulto || []).map(i => (i.plu === plu ? { ...i, ...cambio } : i)) })) };
    const tr = cuerpo.querySelector(`tr[data-pb-plu="${CSS.escape(plu)}"]`);
    if (tr) tr.querySelector('.pb-desc').disabled = false;
  });
}

// ── Producción: bloque en el modal de presentación ──────────
function htmlBloquePBProd(items) {
  if (!(items || []).length) return '';
  return `<div class="mt-4"><div class="lbl mb-1">Pack / Bulto</div><div class="rounded-lg border border-borde divide-y divide-borde">${items.map(it => `
    <div class="px-3 py-2 text-sm"><div>${etiquetaPB(it)}${badgeRevisarPB(it)}<div class="text-[11px] text-gris">PLU ${esc(it.plu)} · ${esc(it.nombre || '')}</div></div>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
      <span class="text-gris text-xs whitespace-nowrap">− ${inputDescPB(it)} %</span>
      <span class="tabular-nums">${precioPBHtml(it)}</span>
      <span class="tabular-nums text-gris">vig. ${it.precioVigente != null ? fmtPrecio(it.precioVigente) : '—'}</span>
      <span class="tabular-nums ${claseDelta(it.semaforo)}">${fmtPct(it.deltaPct)}</span>${estadoPB(it)}</div></div>`).join('')}</div>
    <p class="text-[11px] text-gris mt-1">Se calculan solos sobre el sugerido de esta presentación. El % propio (vacío = general) se guarda al salir del campo.</p></div>`;
}
// Modal de presentación: guardar un % propio actualiza en memoria la vista previa y el detalle (mismo cálculo
// que el server sobre el sugerido de la presentación) y re-pinta el resumen; el próximo GET lo confirma.
function conectarBloquePBProd(el, precioBase) {
  conectarDescPB(el, (plu, cambio) => {
    const upd = items => (items || []).map(i => (i.plu === plu ? recalcularItemPB({ ...i, ...cambio }, precioBase, fraccTol) : i));
    if (presEd.preview) presEd = { ...presEd, preview: { ...presEd.preview, packBulto: upd(presEd.preview.packBulto) } };
    const g = presEd.plu && prodDet.presentaciones[presEd.plu];
    if (g) prodDet = { ...prodDet, presentaciones: { ...prodDet.presentaciones, [presEd.plu]: { ...g, packBulto: upd(g.packBulto) } } };
    pintarResumenPres();
  });
}

// ── Configuración › Pack / Bulto ────────────────────────────────────────────────
// % generales, "Alinear con SIGA", % propios por producto, vínculos manuales y lista "sin vincular".
let pbConfig = null; // GET /api/precios/pack-bulto/vinculos: { config, vinculos, sinVincular }
const cardPB = cuerpo => `<div class="rounded-xl border border-borde shadow-fluent bg-card p-5 mt-5 max-w-3xl">
  <h2 class="font-disp text-lg font-bold text-verde mb-1">Pack / Bulto</h2>${cuerpo}</div>`;

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
    <p class="text-xs text-ink/50 mb-4">Precio pack/bulto = sugerido del producto normal × (1 − descuento), redondeo a $50. Vínculo automático:
      productos del rubro "Almacen Bultos/Cajas" con un solo componente en su fórmula activa de SIGA. ${vinculos.length} vinculados · ${sinVincular.length} sin vincular.</p>
    <div class="flex flex-wrap items-end gap-3">
      <label class="text-sm">Descuento general pack (%)<input id="pbDescPack" type="number" min="0" max="90" step="any" value="${esc(config.descPackPct)}" class="mt-1 block w-28 ${inputCls}"></label>
      <label class="text-sm">Descuento general bulto (%)<input id="pbDescBulto" type="number" min="0" max="90" step="any" value="${esc(config.descBultoPct)}" class="mt-1 block w-28 ${inputCls}"></label>
      <button id="pbGuardarGral" class="px-3 py-1.5 rounded-lg bg-verde text-white text-sm hover:bg-verdeHover">Guardar</button>
      <span id="pbGralMsg" class="text-sm"></span></div>
    <p class="text-[11px] text-gris mt-1">Se usan sólo en los pack/bulto sin % propio (nuevos o sin precio vigente en SIGA).</p>
    <div class="mt-5 border-t border-borde pt-4">
      <button id="pbAlinear" class="px-3 py-1.5 rounded-lg bg-verde text-white text-sm hover:bg-verdeHover disabled:opacity-40">Alinear con SIGA</button>
      <span class="text-xs text-gris ml-2">Guarda como % propio el descuento que hoy tiene cada pack/bulto en SIGA (vigente pack ÷ vigente producto normal).</span>
      <div id="pbAlinearMsg" class="text-sm mt-2" role="status" aria-live="polite"></div></div>
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
    <p class="text-[11px] text-gris mt-1">Sin fórmula, fórmula con varios componentes, tipo ambiguo por nombre o componente granel. Vinculalos a mano con su producto normal.</p>
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
