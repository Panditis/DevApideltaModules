// ── Precios · Configuración: gastos sobre venta (lista Sucursal) y conversión ganancia ↔ markup ──
// Script clásico cargado después de precios_fraccionado.js: usa sus globales (esc, numOrNull, putJson,
// configCargada, cargarCostos, fraccCargado, refrescarAlertasProduccion). Las curvas guardan
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
// gastosPct null = gastos desconocidos (falta la venta base del tipo) → null, como el server; undefined = 0.
function markupDesdeGananciaCli(gananciaPct, gastosPct) {
  const gastos = Number(gastosPct) || 0;
  if (gastosPct === null || typeof gananciaPct !== 'number' || !Number.isFinite(gananciaPct) || gastos >= 100) return null;
  if (gastos === 0) return gananciaPct;
  return +(((1 + gananciaPct / 100) / (1 - gastos / 100) - 1) * 100).toFixed(6);
}
function gananciaDesdeMarkupCli(markupPct, gastosPct) {
  const gastos = Number(gastosPct) || 0;
  if (gastosPct === null || typeof markupPct !== 'number' || !Number.isFinite(markupPct) || gastos >= 100) return null;
  if (gastos === 0) return markupPct;
  return +(((1 + markupPct / 100) * (1 - gastos / 100) - 1) * 100).toFixed(6);
}
const fmtPctGastos = n => (n == null ? '—' : String(+(+n).toFixed(2)).replace('.', ',') + ' %');
const textoGananciaGastos = (ganancia, gastos) => `ganancia ${fmtPctGastos(ganancia)} + gastos ${fmtPctGastos(gastos === null ? null : gastos || 0)}`;
// Leyenda "= markup total X %" de una ganancia de la curva ('' si no hay número).
function textoMarkupTotal(ganancia, gastos) {
  const m = markupDesdeGananciaCli(ganancia, gastos);
  return m == null ? '' : `markup total ${fmtPctGastos(m)}`;
}

// Gastos sobre venta de un tipo (almacen | fraccionado | produccion): el de la fila si lo trae (lo calculó
// el server), si no el del tipo en la config (gastosVentaPctPorTipo; null = falta venta base); config vieja
// sin el dato → el global. Puede devolver null: los que lo usan muestran "—", nunca un markup optimista.
function gastosTipoCli(cfg, tipo, fila = null) {
  if (fila && fila.gastosVentaPct !== undefined) return fila.gastosVentaPct;
  const c = cfg || {};
  if (c.gastosVentaPctPorTipo && c.gastosVentaPctPorTipo[tipo] !== undefined) return c.gastosVentaPctPorTipo[tipo];
  return Number(c.gastosVentaPct) || 0;
}

// Curva de ganancia (espejo de gananciaPorCurva/tramoDePeso en lib/precios_costeo.js):
// clamp(a − b·ln costo, piso, techo) + ajuste del tramo de peso (primer tramo ≥ peso; sin peso → 1 kg;
// más pesado que el último → último). Siempre aplica (sin interruptor); null si es inválida o no hay costo neto.
const PESO_SIN_DATO_CLI = 1000;
const esNumCli = v => typeof v === 'number' && Number.isFinite(v);
function tramoDePesoCli(pesoG, tramosG) {
  const peso = pesoG > 0 ? pesoG : PESO_SIN_DATO_CLI;
  const i = tramosG.findIndex(t => peso <= t);
  return i < 0 ? tramosG.length - 1 : i;
}
function gananciaPorCurvaCliente(curva, costo, pesoG = null) {
  const c = Number(costo);
  if (!curva || costo == null || !Number.isFinite(c) || c <= 0) return null;
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
    gastosTipoCli, gananciaPorCurvaCliente };
}

// Gastos guardados del tipo para las leyendas de las curvas de la tab Costos (null = falta venta base).
const gastosConfig = tipo => gastosTipoCli(configCargada, tipo);

// ── Tarjeta ─────────────────────────────────────────────────────────────────────
let gastosEdit = []; // copia editable [{ id?, concepto, pct, listas? }]

function htmlFilaGasto(g, i) {
  return `<tr data-i="${i}">
    <td class="pr-3 py-1"><input type="text" maxlength="60" data-campo="concepto" value="${esc(g.concepto ?? '')}"
        aria-label="Concepto, fila ${i + 1}" class="campo-t"></td>
    <td class="pr-2 py-1 text-right">${campoU(`<input type="number" min="0" max="100" step="any" inputmode="decimal" data-campo="pct" value="${esc(g.pct ?? '')}"
        aria-label="Porcentaje, fila ${i + 1}">`, '%')}</td>
    <td class="text-right"><button type="button" class="gv-quitar btn-quitar" data-edita title="Quitar gasto" aria-label="Quitar gasto ${i + 1}">✕</button></td>
  </tr>`;
}

function pintarGastos() {
  document.getElementById('gvFilas').innerHTML = gastosEdit.map(htmlFilaGasto).join('')
    || '<tr><td colspan="3" class="text-ink/50 py-2">Sin gastos: el costo real es el costo neto</td></tr>';
  pintarTotalGastos();
}
const pintarTotalGastos = () => { document.getElementById('gvTotal').textContent = fmtPctGastos(totalGastosCli(gastosEdit)); };

function msgGastos(txt, cls) {
  const el = document.getElementById('gvMsg');
  if (el) { el.className = `text-sm ${cls}`; el.textContent = txt; }
}

// La llama cargarCostos (precios_config.js) con la config recién leída.
function renderConfigGastos(cfg) {
  gastosEdit = (cfg.gastosVenta || []).map(g => ({ ...g }));
  document.getElementById('configGastos').innerHTML = `
    <div class="cfg-card" data-guardable>
      <h3 class="cfg-h">Variables sobre venta</h3>
      <p class="cfg-ayuda">Lista Sucursal: % sobre el precio neto de venta, iguales para Reventa, Fraccionado y Producción
        (a cada tipo se le suman sus departamentos).</p>
      <table class="w-full text-sm cfg-tabla">
        <thead><tr><th class="text-left">Concepto</th><th class="text-right pr-2">%</th><th class="w-8"></th></tr></thead>
        <tbody id="gvFilas"></tbody>
        <tfoot><tr class="border-t border-borde cfg-total"><td>Total variables</td>
          <td id="gvTotal" class="text-right pr-[17px] tabular-nums" aria-live="polite"></td><td></td></tr></tfoot>
      </table>
      <button type="button" id="gvAgregar" class="cfg-btn2 mt-3" data-edita>+ Agregar gasto</button>
      <label class="flex items-start gap-2 text-sm mt-4 cursor-pointer"><input id="gvConservar" type="checkbox" class="accent-verde mt-1" checked>
        <span>Mantener los precios actuales <span class="cfg-nota">reescala las curvas de ganancia y las ganancias propias de cada tipo para que el precio no cambie (los conceptos de ganancia no se tocan)</span></span></label>
      <div class="cfg-pie">
        <span id="gvMsg" class="text-sm" role="status" aria-live="polite"></span>
        <button type="button" id="gvGuardar" class="cfg-btn">Guardar gastos</button>
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

// Guarda y recarga toda la tab Costos: con "mantener precios" el server reescala las curvas,
// así que se vuelven a dibujar con lo guardado.
async function guardarGastos() {
  document.getElementById('gvGuardar').disabled = true;
  msgGastos('Guardando…', 'text-ink/50');
  const items = gastosEdit.map(g => ({ ...(g.id ? { id: g.id } : {}), concepto: String(g.concepto || '').trim(),
    pct: g.pct, listas: g.listas || [LISTA_SUCURSAL] }));
  try {
    await putJson('/api/precios/config/gastos-venta', { items, conservarPrecios: document.getElementById('gvConservar').checked });
    fraccCargado = false; // precios_fraccionado.js: el standard de la curva cambia con los gastos
    refrescarAlertasProduccion(); // precios_produccion.js: la curva de Producción también
    await cargarCostos(); // precios_config.js: vuelve a dibujar esta tarjeta y el resumen (curvas: tab Ganancia)
    msgGastos('Guardado.', 'text-ok');
  } catch (e) {
    msgGastos(e.message, 'text-crit');
    document.getElementById('gvGuardar').disabled = false;
  }
}
