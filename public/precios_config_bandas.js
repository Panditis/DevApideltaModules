// ── Precios · Configuración: bandas de markup de Almacén y de Producción ──────
// Script clásico cargado después de precios.html: usa sus globales (esc, numOrNull, configCargada).
// Las dos tablas se editan igual y se guardan por separado con PUT /api/precios/config/bandas-markup
// (lista completa de los tres tipos; configSanitizada valida en el server). Para que guardar una no
// pise la otra, el body sale de lo último guardado (GET de la config) con sólo esa tabla reemplazada.
// Fraccionado no usa estas bandas (tiene su matriz): se reenvía tal cual.

// ── Helpers puros (sin DOM; test/precios_config_bandas.test.js) ─────────────────
function bodyBandas(guardadas, tipo, filas) {
  const g = guardadas || {};
  return { almacen: g.almacen || [], fraccionado: g.fraccionado || [], produccion: g.produccion || [], [tipo]: filas };
}
const editarBanda = (filas, i, campo, valor) => filas.map((b, k) => (k === i ? { ...b, [campo]: valor } : b));
const quitarBanda = (filas, i) => filas.filter((_, k) => k !== i);
// Nueva banda antes de "sin tope" (null siempre última): tope = doble del anterior (o $1.000) y el margen
// del anterior, así no rompe "a mayor costo, margen igual o menor". Se ajusta a mano y se ordena al guardar.
const TOPE_PRIMERA_BANDA = 1000;
function agregarBanda(filas) {
  if (!filas.length) return [{ costoHastaARS: null, markupMaxPct: 0 }];
  const conTope = filas.filter(b => b.costoHastaARS != null);
  const sinTope = filas.filter(b => b.costoHastaARS == null);
  const prev = conTope[conTope.length - 1] || sinTope[0];
  const tope = prev.costoHastaARS != null ? prev.costoHastaARS * 2 : TOPE_PRIMERA_BANDA;
  return [...conTope, { costoHastaARS: tope, markupMaxPct: prev.markupMaxPct }, ...sinTope];
}
// Por tope ascendente con "sin tope" al final (el server rechaza bandas desordenadas).
const ordenarBandas = filas => [...filas].sort((a, b) =>
  (a.costoHastaARS ?? Infinity) - (b.costoHastaARS ?? Infinity));

// Márgenes que hoy maneja SIGA, por banda de costo (sobre el listado de Almacén ya cargado):
// real = vigente sin IVA ÷ costo de sistema sin IVA (el criterio del módulo); SIGA = vigente ÷ costo con
// IVA de compra (sin alícuota → 21%). sugerido = mediana real, sin crecer con el costo (regla de las bandas).
const IVA_VENTA_BANDAS = 1.21;
const redondear1 = n => Math.round(n * 10) / 10;
function mediana(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const n = s.length;
  return !n ? null : redondear1(n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2);
}
function margenesPorBanda(filas, topes) {
  const grupos = topes.map(t => ({ costoHastaARS: t, real: [], siga: [] }));
  for (const f of filas || []) {
    if (!(f.costoSistema > 0) || !(f.precioVigente > 0)) continue;
    const g = grupos.find(x => x.costoHastaARS == null || f.costoSistema <= x.costoHastaARS);
    if (!g) continue;
    const conIvaCompra = f.costoSistema * (1 + (f.ivaCompraPct ?? 21) / 100);
    g.real.push((f.precioVigente / IVA_VENTA_BANDAS / f.costoSistema - 1) * 100);
    g.siga.push((f.precioVigente / conIvaCompra - 1) * 100);
  }
  let tope = Infinity;
  return grupos.map(g => {
    const realMed = mediana(g.real);
    if (realMed != null) tope = Math.min(tope, realMed);
    return { costoHastaARS: g.costoHastaARS, n: g.real.length, realMed, sigaMed: mediana(g.siga),
      sugerido: tope === Infinity ? null : tope };
  });
}

if (typeof module === 'object' && module.exports) {
  module.exports = { bodyBandas, editarBanda, quitarBanda, agregarBanda, ordenarBandas, margenesPorBanda };
}

// ── Tarjetas ────────────────────────────────────────────────────────────────────
// Ayuda = sobre qué costo se busca la banda (lib/precios_costeo.js costearAlmacen: costo base;
// lib/precios_produccion.js costearPresentacion: costoUnidad de la presentación).
const TABLAS_BANDAS = {
  almacen: { titulo: 'Bandas de markup — Almacén',
    ayuda: 'La banda se busca con el costo base del producto (sin IVA, antes de costos varios y extras).' },
  produccion: { titulo: 'Bandas de markup — Producción',
    ayuda: 'La banda se busca con el costo total por unidad de cada presentación (receta + insumos + mano de obra de empaquetado, sin IVA). Un margen propio del PLU la reemplaza.' },
};
let bandasEdit = { almacen: [], produccion: [] }; // copias editables

function htmlTarjetaBandas(tipo) {
  const t = TABLAS_BANDAS[tipo];
  return `<div class="rounded-xl border border-borde shadow-fluent bg-card p-5 max-w-md mt-5" data-bandas="${tipo}">
    <h2 class="font-disp text-lg font-bold text-verde mb-1">${esc(t.titulo)}</h2>
    <p class="text-xs text-ink/50 mb-4">${esc(t.ayuda)} Costo hasta ($) vacío = sin tope (sólo permitido en la última fila).</p>
    <table class="w-full text-sm">
      <thead class="text-ink/60"><tr><th class="text-left font-normal pb-1">Costo hasta ($)</th>
        <th class="text-left font-normal pb-1">Markup máx (%)</th><th></th></tr></thead>
      <tbody class="bd-filas"></tbody>
    </table>
    <button type="button" class="bd-agregar mt-3 px-3 py-1 rounded-lg border border-borde text-xs hover:bg-white">+ Agregar banda</button>
    ${tipo === 'almacen' ? `<button type="button" class="bd-siga mt-3 ml-1 px-3 py-1 rounded-lg border border-borde text-xs hover:bg-white">Ver márgenes de SIGA</button>
    <div class="bd-siga-res"></div>` : ''}
    <div class="bd-msg text-sm my-3" role="status" aria-live="polite"></div>
    <button type="button" class="bd-guardar px-3 py-1.5 rounded-lg bg-verde text-white text-sm hover:bg-verdeHover disabled:opacity-40">Guardar bandas</button>
  </div>`;
}
const tarjetaBandas = tipo => document.querySelector(`#configBandas [data-bandas="${tipo}"]`);

function renderBandasFilas(tipo) {
  const filas = bandasEdit[tipo];
  tarjetaBandas(tipo).querySelector('.bd-filas').innerHTML = filas.map((b, i) => `
    <tr data-i="${i}">
      <td class="pr-2 py-1"><input type="number" step="any" placeholder="sin tope" data-campo="costoHastaARS" value="${esc(b.costoHastaARS ?? '')}"
          aria-label="Costo hasta, fila ${i + 1}" class="w-28 px-2 py-1 rounded border border-borde"></td>
      <td class="pr-2 py-1"><input type="number" step="any" data-campo="markupMaxPct" value="${esc(b.markupMaxPct ?? '')}"
          aria-label="Markup máximo, fila ${i + 1}" class="w-24 px-2 py-1 rounded border border-borde"></td>
      <td><button type="button" class="bd-quitar text-crit hover:opacity-70 px-1" title="Quitar fila" aria-label="Quitar fila ${i + 1}">✕</button></td>
    </tr>`).join('') || '<tr><td colspan="3" class="text-ink/50 py-2">Sin bandas — agregá una</td></tr>';
}

function msgBandas(tipo, txt, cls) {
  const el = tarjetaBandas(tipo).querySelector('.bd-msg');
  el.className = `bd-msg text-sm my-3 ${cls}`;
  el.textContent = txt;
}

function conectarTarjetaBandas(tipo) {
  const card = tarjetaBandas(tipo);
  const cambiar = filas => { bandasEdit = { ...bandasEdit, [tipo]: filas }; };
  card.querySelector('.bd-filas').addEventListener('change', e => {
    const campo = e.target.dataset.campo, tr = e.target.closest('tr[data-i]');
    if (campo && tr) cambiar(editarBanda(bandasEdit[tipo], Number(tr.dataset.i), campo, numOrNull(e.target.value)));
  });
  card.querySelector('.bd-filas').addEventListener('click', e => {
    const tr = e.target.closest('.bd-quitar') && e.target.closest('tr[data-i]');
    if (tr) { cambiar(quitarBanda(bandasEdit[tipo], Number(tr.dataset.i))); renderBandasFilas(tipo); }
  });
  card.querySelector('.bd-agregar').onclick = () => { cambiar(agregarBanda(bandasEdit[tipo])); renderBandasFilas(tipo); };
  card.querySelector('.bd-guardar').onclick = () => guardarBandas(tipo);
  const btnSiga = card.querySelector('.bd-siga');
  if (btnSiga) btnSiga.onclick = () => mostrarMargenesSiga(tipo);
}

// La llama cargarConfiguracion (precios.html) con la config recién leída.
function renderConfigBandas(cfg) {
  const bm = cfg.bandasMarkup || {};
  bandasEdit = Object.fromEntries(Object.keys(TABLAS_BANDAS).map(t => [t, (bm[t] || []).map(b => ({ ...b }))]));
  document.getElementById('configBandas').innerHTML = Object.keys(TABLAS_BANDAS).map(htmlTarjetaBandas).join('');
  Object.keys(TABLAS_BANDAS).forEach(tipo => { renderBandasFilas(tipo); conectarTarjetaBandas(tipo); });
}
function errorConfigBandas(msg) {
  document.getElementById('configBandas').innerHTML = `<p class="text-crit mt-5">No se pudieron cargar las bandas: ${esc(msg)}</p>`;
}

async function guardarBandas(tipo) {
  const btn = tarjetaBandas(tipo).querySelector('.bd-guardar');
  btn.disabled = true;
  msgBandas(tipo, 'Guardando…', 'text-ink/50');
  try {
    const actual = await (await fetch('/api/precios/config')).json(); // lo último guardado (otra tabla, otra PC)
    if (actual.error) throw new Error(actual.error);
    const r = await fetch('/api/precios/config/bandas-markup', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyBandas(actual.bandasMarkup, tipo, ordenarBandas(bandasEdit[tipo]))),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    configCargada = { ...configCargada, bandasMarkup: j.bandasMarkup }; // precios.html
    bandasEdit = { ...bandasEdit, [tipo]: (j.bandasMarkup[tipo] || []).map(b => ({ ...b })) };
    renderBandasFilas(tipo);
    msgBandas(tipo, 'Guardado.', 'text-ok');
  } catch (e) {
    msgBandas(tipo, e.message, 'text-crit');
  } finally { btn.disabled = false; }
}

// ── Márgenes de SIGA por banda (sólo Almacén): sobre el listado ya cargado (almacenData, precios_almacen.js) ──
const fmtPctBanda = n => (n == null ? '—' : String(n).replace('.', ',') + '%');
async function mostrarMargenesSiga(tipo) {
  const res = tarjetaBandas(tipo).querySelector('.bd-siga-res');
  if (!almacenData.length) { res.innerHTML = '<p class="text-xs text-gris mt-2">Cargando Almacén…</p>'; await cargarAlmacen(); }
  const filas = margenesPorBanda(almacenData, ordenarBandas(bandasEdit[tipo]).map(b => b.costoHastaARS));
  res.innerHTML = `<table class="w-full text-xs mt-3 tabular-nums">
      <thead class="text-ink/60"><tr><th class="text-left font-normal">Costo hasta</th><th class="text-right font-normal">Prod.</th>
        <th class="text-right font-normal" title="Vigente sin IVA ÷ costo de sistema sin IVA (criterio del módulo)">Real</th>
        <th class="text-right font-normal" title="Vigente ÷ costo de sistema con IVA de compra (como lo calcula SIGA)">SIGA</th>
        <th class="text-right font-normal" title="Mediana real, sin crecer con el costo">Sugerido</th></tr></thead>
      <tbody>${filas.map(f => `<tr class="border-t border-borde"><td>${f.costoHastaARS == null ? 'sin tope' : '$ ' + esc(fmtMoney(f.costoHastaARS))}</td>
        <td class="text-right">${f.n}</td><td class="text-right">${fmtPctBanda(f.realMed)}</td><td class="text-right text-gris">${fmtPctBanda(f.sigaMed)}</td>
        <td class="text-right font-semibold">${fmtPctBanda(f.sugerido)}</td></tr>`).join('')}</tbody></table>
    <p class="text-[11px] text-gris mt-1">Medianas de los productos de Almacén con costo de sistema y precio vigente. Usa los topes de la tabla de arriba.</p>
    <button type="button" class="bd-usar-siga mt-2 px-3 py-1 rounded-lg border border-borde text-xs hover:bg-white">Usar sugeridos (después: Guardar)</button>`;
  res.querySelector('.bd-usar-siga').onclick = () => {
    const sug = new Map(filas.map(f => [f.costoHastaARS, f.sugerido]));
    bandasEdit = { ...bandasEdit, [tipo]: ordenarBandas(bandasEdit[tipo]).map(b => (sug.get(b.costoHastaARS) != null ? { ...b, markupMaxPct: sug.get(b.costoHastaARS) } : b)) };
    renderBandasFilas(tipo);
    msgBandas(tipo, 'Márgenes de SIGA cargados: revisalos y tocá Guardar.', 'text-warn');
  };
}
