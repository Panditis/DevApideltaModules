// ── Precios · Configuración: gastos sobre venta (lista Sucursal) y conversión ganancia ↔ markup ──
// Script clásico cargado después de precios_fraccionado.js: usa sus globales (esc, numOrNull, putJson,
// configCargada, cargarConfiguracion, fraccCargado, refrescarAlertasProduccion). Bandas y matriz guardan
// GANANCIA; el markup total que se aplica al costo sale de la fórmula exacta con el total de gastos
// (espejo de lib/precios_costeo.js). Guardar = PUT /api/precios/config/gastos-venta.

// ── Helpers puros (sin DOM; test/precios_config_gastos.test.js) ─────────────────
const LISTA_SUCURSAL = 'sucursal';
// Σ pct de los gastos de la lista (fila sin listas = nueva, va a Sucursal). 4 decimales, como el server.
function totalGastosCli(items, lista = LISTA_SUCURSAL) {
  if (!Array.isArray(items)) return 0;
  const total = items.filter(g => g && (!g.listas || g.listas.includes(lista)) && Number.isFinite(g.pct))
    .reduce((s, g) => s + g.pct, 0);
  return +total.toFixed(4);
}
// markupTotal = (1 + ganancia) ÷ (1 − gastos) − 1. Gastos 0 = identidad exacta (precios de siempre).
function markupDesdeGananciaCli(gananciaPct, gastosPct) {
  const gastos = Number(gastosPct) || 0;
  if (typeof gananciaPct !== 'number' || !Number.isFinite(gananciaPct) || gastos >= 100) return null;
  if (gastos === 0) return gananciaPct;
  return +(((1 + gananciaPct / 100) / (1 - gastos / 100) - 1) * 100).toFixed(6);
}
function gananciaDesdeMarkupCli(markupPct, gastosPct) {
  const gastos = Number(gastosPct) || 0;
  if (typeof markupPct !== 'number' || !Number.isFinite(markupPct) || gastos >= 100) return null;
  if (gastos === 0) return markupPct;
  return +(((1 + markupPct / 100) * (1 - gastos / 100) - 1) * 100).toFixed(6);
}
const fmtPctGastos = n => (n == null ? '—' : String(+(+n).toFixed(2)).replace('.', ',') + ' %');
const textoGananciaGastos = (ganancia, gastos) => `ganancia ${fmtPctGastos(ganancia)} + gastos ${fmtPctGastos(gastos || 0)}`;
// Leyenda "= markup total X %" de una ganancia de banda/matriz ('' si no hay número).
function textoMarkupTotal(ganancia, gastos) {
  const m = markupDesdeGananciaCli(ganancia, gastos);
  return m == null ? '' : `markup total ${fmtPctGastos(m)}`;
}

// Curva de ganancia (espejo de gananciaPorCurva/tramoDePeso en lib/precios_costeo.js):
// clamp(a − b·ln costo, piso, techo) + ajuste del tramo de peso (primer tramo ≥ peso; sin peso → 1 kg;
// más pesado que el último → último). null si la curva está inactiva/inválida o no hay costo.
const PESO_SIN_DATO_CLI = 1000;
const esNumCli = v => typeof v === 'number' && Number.isFinite(v);
function tramoDePesoCli(pesoG, tramosG) {
  const peso = pesoG > 0 ? pesoG : PESO_SIN_DATO_CLI;
  const i = tramosG.findIndex(t => peso <= t);
  return i < 0 ? tramosG.length - 1 : i;
}
function gananciaPorCurvaCliente(curva, costo, pesoG = null) {
  const c = Number(costo);
  if (!curva || curva.activa !== true || costo == null || !Number.isFinite(c) || c <= 0) return null;
  const { a, b, pisoPct, techoPct } = curva;
  if (![a, b, pisoPct, techoPct].every(esNumCli) || pisoPct > techoPct) return null;
  const base = Math.min(techoPct, Math.max(pisoPct, a - b * Math.log(c)));
  const aj = curva.ajustesPeso;
  const ajuste = aj && Array.isArray(aj.tramosG) && aj.tramosG.length && Array.isArray(aj.puntos)
    ? Number(aj.puntos[tramoDePesoCli(pesoG, aj.tramosG)]) || 0 : 0;
  return +(base + ajuste).toFixed(6);
}

if (typeof module === 'object' && module.exports) {
  module.exports = { totalGastosCli, markupDesdeGananciaCli, gananciaDesdeMarkupCli, fmtPctGastos, textoGananciaGastos, textoMarkupTotal,
    gananciaPorCurvaCliente };
}

// Total vigente (el guardado) para las leyendas de bandas y matriz de Configuración.
const gastosConfig = () => Number((configCargada || {}).gastosVentaPct) || 0;

// ── Tarjeta ─────────────────────────────────────────────────────────────────────
let gastosEdit = []; // copia editable [{ id?, concepto, pct, listas? }]

function htmlFilaGasto(g, i) {
  return `<tr data-i="${i}">
    <td class="pr-2 py-1"><input type="text" maxlength="60" data-campo="concepto" value="${esc(g.concepto ?? '')}"
        aria-label="Concepto, fila ${i + 1}" class="w-full px-2 py-1 rounded border border-borde"></td>
    <td class="pr-2 py-1"><input type="number" min="0" max="100" step="any" inputmode="decimal" data-campo="pct" value="${esc(g.pct ?? '')}"
        aria-label="Porcentaje, fila ${i + 1}" class="w-20 px-2 py-1 rounded border border-borde text-right tabular-nums"></td>
    <td><button type="button" class="gv-quitar text-crit hover:opacity-70 px-1" title="Quitar gasto" aria-label="Quitar gasto ${i + 1}">✕</button></td>
  </tr>`;
}

function pintarGastos() {
  document.getElementById('gvFilas').innerHTML = gastosEdit.map(htmlFilaGasto).join('')
    || '<tr><td colspan="3" class="text-ink/50 py-2">Sin gastos: el markup es igual a la ganancia</td></tr>';
  pintarTotalGastos();
}
const pintarTotalGastos = () => { document.getElementById('gvTotal').textContent = fmtPctGastos(totalGastosCli(gastosEdit)); };

function msgGastos(txt, cls) {
  const el = document.getElementById('gvMsg');
  if (el) { el.className = `text-sm ${cls}`; el.textContent = txt; }
}

// La llama cargarConfiguracion (precios_config.js) con la config recién leída.
function renderConfigGastos(cfg) {
  gastosEdit = (cfg.gastosVenta || []).map(g => ({ ...g }));
  document.getElementById('configGastos').innerHTML = `
    <div class="rounded-xl border border-borde shadow-fluent bg-card p-5 max-w-md mt-5">
      <h2 class="font-disp text-lg font-bold text-verde mb-1">Gastos sobre venta — Lista Sucursal</h2>
      <p class="text-xs text-ink/50 mb-4">% sobre el precio de venta. Bandas y matriz guardan la ganancia;
        el markup que se aplica al costo es (1 + ganancia) ÷ (1 − gastos) − 1. Los márgenes propios por producto no cambian.</p>
      <table class="w-full text-sm">
        <thead class="text-ink/60"><tr><th class="text-left font-normal pb-1">Concepto</th>
          <th class="text-left font-normal pb-1">%</th><th></th></tr></thead>
        <tbody id="gvFilas"></tbody>
        <tfoot><tr class="border-t border-borde"><td class="pt-2 font-semibold">Total</td>
          <td id="gvTotal" class="pt-2 font-semibold tabular-nums" aria-live="polite"></td><td></td></tr></tfoot>
      </table>
      <button type="button" id="gvAgregar" class="mt-3 px-3 py-1 rounded-lg border border-borde text-xs hover:bg-white">+ Agregar gasto</button>
      <label class="flex items-start gap-2 text-sm mt-4 cursor-pointer"><input id="gvConservar" type="checkbox" class="accent-verde mt-1" checked>
        <span>Mantener los precios actuales <span class="block text-[11px] text-gris">recalcula las ganancias de bandas y matriz para que el markup total no cambie</span></span></label>
      <div class="flex items-center gap-2 mt-3">
        <button type="button" id="gvGuardar" class="px-3 py-1.5 rounded-lg bg-verde text-white text-sm hover:bg-verdeHover disabled:opacity-40">Guardar gastos</button>
        <span id="gvMsg" class="text-sm" role="status" aria-live="polite"></span>
      </div>
    </div>`;
  pintarGastos();
  conectarGastos();
}

function conectarGastos() {
  const filas = document.getElementById('gvFilas');
  // Editar actualiza gastosEdit sin re-dibujar (no se pierde el foco); agregar/quitar re-dibuja.
  filas.addEventListener('input', e => {
    const campo = e.target.dataset.campo, tr = e.target.closest('tr[data-i]');
    if (!campo || !tr) return;
    const valor = campo === 'pct' ? numOrNull(e.target.value) : e.target.value;
    gastosEdit = gastosEdit.map((g, k) => (k === Number(tr.dataset.i) ? { ...g, [campo]: valor } : g));
    pintarTotalGastos();
  });
  filas.addEventListener('click', e => {
    const tr = e.target.closest('.gv-quitar') && e.target.closest('tr[data-i]');
    if (tr) { gastosEdit = gastosEdit.filter((_, k) => k !== Number(tr.dataset.i)); pintarGastos(); }
  });
  document.getElementById('gvAgregar').onclick = () => {
    gastosEdit = [...gastosEdit, { concepto: '', pct: null }];
    pintarGastos();
    const inputs = filas.querySelectorAll('input[data-campo="concepto"]');
    inputs[inputs.length - 1].focus();
  };
  document.getElementById('gvGuardar').onclick = guardarGastos;
}

// Guarda y recarga toda la Configuración: con "mantener precios" el server reescala las ganancias
// de bandas y matriz, así que se vuelven a dibujar con lo guardado.
async function guardarGastos() {
  document.getElementById('gvGuardar').disabled = true;
  msgGastos('Guardando…', 'text-ink/50');
  const items = gastosEdit.map(g => ({ ...(g.id ? { id: g.id } : {}), concepto: String(g.concepto || '').trim(),
    pct: g.pct, listas: g.listas || [LISTA_SUCURSAL] }));
  try {
    await putJson('/api/precios/config/gastos-venta', { items, conservarPrecios: document.getElementById('gvConservar').checked });
    fraccCargado = false; // precios_fraccionado.js: el standard de la matriz cambia con los gastos
    refrescarAlertasProduccion(); // precios_produccion.js: las bandas de Producción también
    await cargarConfiguracion(); // precios_config.js: vuelve a dibujar esta tarjeta, bandas y matriz
    msgGastos('Guardado.', 'text-ok');
  } catch (e) {
    msgGastos(e.message, 'text-crit');
    document.getElementById('gvGuardar').disabled = false;
  }
}
