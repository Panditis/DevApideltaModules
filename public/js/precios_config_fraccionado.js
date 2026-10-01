// ── Precios · Configuración: ganancia standard Fraccionado (bandas de costo × tramos de peso) ─
// Script clásico cargado después de precios_fraccionado.js: usa sus globales (esc, numOrNull, inputCls,
// putJson, configCargada, fraccCargado, fraccData; de precios_config_gastos.js: textoMarkupTotal, gastosConfig,
// fmtPctGastos). Las celdas (markupPct) guardan GANANCIA; el markup total suma los gastos sobre venta. Se dibuja en #configFraccionado cada vez que
// cargarConfiguracion() trae la config. Matriz { bandas:[costoHasta..., null], tramosG:[g asc], markupPct:[fila][col] };
// el server (validarMarkupFraccionado) exige ascendentes y matriz completa.

// ── Helpers puros (sin DOM; test/precios_config_fraccionado.test.js) ───────────
// Columna nueva: con peso → en su lugar ordenado, copiando los márgenes de la columna de peso más
// cercano; sin peso (input vacío) → al final, copiando la última. Nunca deja celdas vacías.
function agregarTramo(m, pesoG = null) {
  const n = m.tramosG.length;
  let pos = n, origen = n - 1;
  if (pesoG > 0) {
    const i = m.tramosG.findIndex(t => t != null && t > pesoG);
    pos = i < 0 ? n : i;
    let mejor = Infinity;
    m.tramosG.forEach((t, k) => {
      const d = t != null ? Math.abs(t - pesoG) : Infinity;
      if (d < mejor) { mejor = d; origen = k; }
    });
  }
  const insertar = (arr, v) => [...arr.slice(0, pos), v, ...arr.slice(pos)];
  return {
    ...m,
    tramosG: insertar(m.tramosG, pesoG > 0 ? pesoG : null),
    markupPct: m.markupPct.map(f => insertar(f, f[origen] ?? null)),
  };
}

function quitarTramo(m, k) {
  if (m.tramosG.length <= 1) return m;
  const sin = arr => arr.filter((_, j) => j !== k);
  return { ...m, tramosG: sin(m.tramosG), markupPct: m.markupPct.map(sin) };
}

// Valida lo editable y devuelve la matriz ordenada (columnas por peso asc, bandas por costo asc con
// "sin tope" al final), moviendo los márgenes con su columna/fila. Tira Error con mensaje para #mfMsg.
function ordenarMatriz(m) {
  if (m.tramosG.some(t => !(t > 0))) throw new Error('Completá el peso (g) de todas las columnas con un número mayor a 0.');
  const pesoRep = m.tramosG.find((t, i) => m.tramosG.indexOf(t) !== i);
  if (pesoRep != null) throw new Error(`Peso repetido: ${pesoRep} g. Cada columna debe tener un peso distinto.`);
  const topes = m.bandas.slice(0, -1);
  if (topes.some(b => !(b > 0))) throw new Error('Completá el costo "hasta" de todas las bandas (menos la última) con un número mayor a 0.');
  const costoRep = topes.find((b, i) => topes.indexOf(b) !== i);
  if (costoRep != null) throw new Error(`Costo "hasta" repetido: $ ${costoRep}. Cada banda debe tener un tope distinto.`);
  if (m.markupPct.some(f => f.some(v => v == null))) throw new Error('Hay celdas de margen vacías: completalas antes de guardar.');
  const cols = m.tramosG.map((t, k) => k).sort((a, b) => m.tramosG[a] - m.tramosG[b]);
  const filas = topes.map((b, i) => i).sort((a, b) => topes[a] - topes[b]).concat(m.bandas.length - 1);
  return {
    bandas: filas.map(i => m.bandas[i]),
    tramosG: cols.map(k => m.tramosG[k]),
    markupPct: filas.map(i => cols.map(k => m.markupPct[i][k])),
  };
}

// Pesos (g) de presentaciones reales del Fraccionado que no tienen columna exacta, únicos y asc.
function pesosFaltantes(data, tramosG) {
  const pesos = (data || []).flatMap(g => (g.presentaciones || []).map(p => p.pesoG)).filter(g => g > 0);
  return [...new Set(pesos)].filter(g => !tramosG.includes(g)).sort((a, b) => a - b);
}

if (typeof module === 'object' && module.exports) {
  module.exports = { agregarTramo, quitarTramo, ordenarMatriz, pesosFaltantes };
}

// ── Tarjeta ─────────────────────────────────────────────────────────────────────
let mfEdit = null; // copia editable { bandas, tramosG, markupPct }

const inMf = (valor, cls, extra = '') =>
  `<input type="number" step="any" value="${esc(valor ?? '')}" class="${cls} w-20 ${inputCls}" ${extra}>`;

// Lee lo que hay en pantalla (para no perder ediciones al agregar/quitar una banda o un peso).
function leerMatrizFracc(){
  const filas = [...document.querySelectorAll('#mfFilas tr')];
  return {
    bandas: filas.map((tr, i) => i === filas.length - 1 ? null : numOrNull(tr.querySelector('.mf-hasta').value)),
    tramosG: [...document.querySelectorAll('.mf-tramo')].map(i => numOrNull(i.value)),
    markupPct: filas.map(tr => [...tr.querySelectorAll('.mf-celda')].map(i => numOrNull(i.value))),
  };
}

const editarMf = f => { mfEdit = f(leerMatrizFracc()); pintarMatrizFracc(); };

function pintarMatrizFracc(){
  const m = mfEdit;
  const ultima = m.bandas.length - 1;
  const quitarCol = k => m.tramosG.length > 1
    ? `<button class="mf-quitar-tramo text-crit hover:opacity-70 px-1" data-k="${k}" title="Quitar peso" aria-label="Quitar columna ${k + 1}">✕</button>` : '';
  document.getElementById('mfTabla').innerHTML = `
    <thead class="text-ink/60"><tr>
      <th class="text-left font-normal pb-1 pr-2 whitespace-nowrap">Costo granel hasta ($/kg) \\ peso hasta (g)</th>
      ${m.tramosG.map((t, k) => `<th class="pb-1 pr-1 whitespace-nowrap">${inMf(t, 'mf-tramo', `aria-label="Peso de la columna ${k + 1} (g)"`)}${quitarCol(k)}</th>`).join('')}<th></th></tr></thead>
    <tbody id="mfFilas">${m.bandas.map((b, i) => `<tr>
      <td class="pr-2 py-1">${i === ultima ? '<span class="text-gris text-xs">sin tope</span>' : inMf(b, 'mf-hasta w-28')}</td>
      ${m.tramosG.map((_, k) => `<td class="pr-1 py-1">${inMf((m.markupPct[i] || [])[k], 'mf-celda', `aria-label="Ganancia % banda ${i + 1}, columna ${k + 1}" title="${esc(textoMarkupTotal((m.markupPct[i] || [])[k], gastosConfig()))}"`)}</td>`).join('')}
      <td>${m.bandas.length > 1 ? `<button class="mf-quitar text-crit hover:opacity-70 px-1" data-i="${i}" title="Quitar banda">✕</button>` : ''}</td>
    </tr>`).join('')}</tbody>`;
  document.querySelectorAll('.mf-quitar').forEach(btn => btn.onclick = () => editarMf(a => {
    const i = Number(btn.dataset.i);
    const quitar = arr => arr.filter((_, k) => k !== i);
    const bandas = quitar(a.bandas);
    return { ...a, bandas: [...bandas.slice(0, -1), null], markupPct: quitar(a.markupPct) }; // la última siempre es "sin tope"
  }));
  document.querySelectorAll('.mf-quitar-tramo').forEach(btn => btn.onclick = () =>
    editarMf(a => quitarTramo(a, Number(btn.dataset.k))));
  pintarPesosFaltantes();
}

// Chips con los pesos de presentaciones reales sin columna propia (fraccData se carga con la página).
function pintarPesosFaltantes(){
  const cont = document.getElementById('mfFaltantes');
  const pesos = pesosFaltantes(fraccData, mfEdit.tramosG);
  cont.innerHTML = !pesos.length ? '' : `<span class="text-ink/50">Pesos de presentaciones sin columna propia:</span>
    ${pesos.map(g => `<button class="mf-chip px-2 py-0.5 rounded-full border border-borde hover:bg-white" data-g="${esc(g)}" title="Agregar columna de ${esc(g)} g">+ ${esc(g)} g</button>`).join(' ')}`;
  cont.querySelectorAll('.mf-chip').forEach(btn => btn.onclick = () =>
    editarMf(a => agregarTramo(a, Number(btn.dataset.g))));
}

function renderConfigFraccionado(cfg){
  const m = cfg.markupFraccionado || { bandas: [null], tramosG: [1000], markupPct: [[0]] };
  mfEdit = { bandas: [...m.bandas], tramosG: [...m.tramosG], markupPct: m.markupPct.map(f => [...f]) };
  document.getElementById('configFraccionado').innerHTML = `
    <div class="rounded-xl border border-borde shadow-fluent bg-card p-5 mt-5 w-fit max-w-full">
      <h2 class="font-disp text-lg font-bold text-verde mb-1">Ganancia standard Fraccionado</h2>
      <p class="text-xs text-ink/50 mb-4">Ganancia % según el costo del granel por kg (filas) y el peso de la presentación (columnas):
        se usa la primera banda con costo ≤ tope y la primera columna con peso ≤ tramo; más pesado que el último tramo → última
        columna; sin peso en el nombre → columna de 1 kg. Cada presentación puede tener su margen propio (detalle del granel).
        Al guardar, columnas y bandas se ordenan solas. El markup que se aplica suma los gastos sobre venta
        (${esc(fmtPctGastos(gastosConfig()))}): pasá el mouse por una celda para verlo.</p>
      <div class="overflow-x-auto"><table id="mfTabla" class="text-sm"></table></div>
      <div class="flex gap-2 mt-2">
        <button id="mfAgregar" class="px-3 py-1 rounded-lg border border-borde text-xs hover:bg-white">+ Agregar banda</button>
        <button id="mfAgregarTramo" class="px-3 py-1 rounded-lg border border-borde text-xs hover:bg-white">+ Agregar peso</button>
      </div>
      <div id="mfFaltantes" class="flex flex-wrap items-center gap-1 mt-2 text-xs max-w-2xl"></div>
      <div class="flex items-center gap-2 mt-3">
        <button id="mfGuardar" class="px-3 py-1.5 rounded-lg bg-verde text-white text-sm hover:bg-verdeHover">Guardar</button>
        <span id="mfMsg" class="text-sm" role="status" aria-live="polite"></span>
      </div>
    </div>`;
  pintarMatrizFracc();
  // Markup total de la celda en vivo (title), sin re-dibujar.
  document.getElementById('mfTabla').addEventListener('input', e => {
    if (e.target.classList.contains('mf-celda')) e.target.title = textoMarkupTotal(numOrNull(e.target.value), gastosConfig());
  });
  // Nueva banda antes de la "sin tope", copiando los márgenes de la anterior.
  document.getElementById('mfAgregar').onclick = () => editarMf(a => {
    const n = a.bandas.length;
    return {
      ...a,
      bandas: [...a.bandas.slice(0, n - 1), null, null],
      markupPct: [...a.markupPct.slice(0, n - 1), [...a.markupPct[n - 1]], a.markupPct[n - 1]],
    };
  });
  document.getElementById('mfAgregarTramo').onclick = () => {
    editarMf(a => agregarTramo(a));
    const tramos = document.querySelectorAll('.mf-tramo');
    tramos[tramos.length - 1].focus();
  };
  document.getElementById('mfGuardar').onclick = guardarMatrizFracc;
}

async function guardarMatrizFracc(){
  const msg = document.getElementById('mfMsg');
  let body;
  try { body = ordenarMatriz(leerMatrizFracc()); } catch (e) {
    msg.className = 'text-sm text-crit'; msg.textContent = e.message; return;
  }
  msg.className = 'text-sm text-ink/50'; msg.textContent = 'Guardando…';
  try {
    const j = await putJson('/api/precios/config/markup-fraccionado', body);
    mfEdit = j.markupFraccionado;
    pintarMatrizFracc(); // queda a la vista el orden guardado
    configCargada = { ...configCargada, markupFraccionado: j.markupFraccionado };
    fraccCargado = false; // el listado se recalcula la próxima vez que se abre el tab
    msg.className = 'text-sm text-ok'; msg.textContent = 'Guardado.';
  } catch (e) {
    msg.className = 'text-sm text-crit'; msg.textContent = e.message;
  }
}
