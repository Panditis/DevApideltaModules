// ── Precios · tab Ganancia: a) margen de ganancia (conceptos de ganancia + curvas por tipo) y b) conceptos sobre
// precio final ──
// Script clásico cargado al final de precios.html: usa los globales de los otros scripts (esc, numOrNull, putJson,
// leerConfig, configCargada, fmtPctGastos, renderConfigCurva, fraccCargado, refrescarAlertasProduccion).
// Spec: docs/superpowers/specs/2026-10-02-precios-costo-neto-iva-curva-design.md, Partes C y D.
//   ganancia (s/ costo real) = curva del tipo + Σ conceptos de ganancia; precio neto = costo real × (1 + ganancia);
//   + IVA de venta (se edita en Costos); precio final = (neto + IVA) ÷ (1 − F), F = Σ conceptos sobre precio final.
// Guardar = PUT /api/precios/config/ganancia { conceptos } o { conceptosPrecioFinal }. No reescala nada: cambia los precios.

// ── Helpers puros (sin DOM; test/precios_ganancia_front.test.js) ──────────────────
const CONCEPTOS_GANANCIA_MAX_CLI = 40;
const totalConceptosGananciaCli = items => Math.round((items || [])
  .filter(c => c && typeof c.pct === 'number' && Number.isFinite(c.pct)).reduce((s, c) => s + c.pct, 0) * 1e4) / 1e4;
// Conceptos con concepto recortado (id sólo si ya lo tenía).
const limpiarConceptos = items => (items || []).map(c => ({ ...(c.id ? { id: c.id } : {}), concepto: String(c.concepto || '').trim(), pct: c.pct }));
// Body del PUT de cada lista.
const bodyGanancia = items => ({ conceptos: limpiarConceptos(items) });
const bodyPrecioFinal = items => ({ conceptosPrecioFinal: limpiarConceptos(items) });

// Márgenes propios (Parte E.1): rótulo de un rango [desde, hasta) de Δ precio % (null = sin límite) y resumen en texto.
const fmtDeltaMp = n => `${n > 0 ? '+' : ''}${String(n).replace('.', ',')} %`;
const etiquetaRangoMp = ({ desde, hasta }) => (desde == null ? `menos de ${fmtDeltaMp(hasta)}`
  : hasta == null ? `${fmtDeltaMp(desde)} o más` : `${fmtDeltaMp(desde)} a ${fmtDeltaMp(hasta)}`);
const textoResumenMp = r => `${r.totales.standard} pasan al standard · ${r.totales.acercar} se acercan ${String(r.topePct).replace('.', ',')} % · `
  + `${r.totales.sinCambio} sin cambio (${r.motivosSinCambio.sinCosto} sin costo, ${r.motivosSinCambio.sinStandard} sin standard, `
  + `${r.motivosSinCambio.sinListado} fuera de los listados)`;

if (typeof module === 'object' && module.exports) {
  module.exports = { totalConceptosGananciaCli, bodyGanancia, bodyPrecioFinal, CONCEPTOS_GANANCIA_MAX_CLI, etiquetaRangoMp, textoResumenMp };
}

// ── Tarjetas de conceptos (misma UI para las dos listas) ────────────────────────────
// p = prefijo de ids; campo = clave de la config; body = arma el PUT; min/max = rango del % (max excluido en la final).
const LISTAS_GANANCIA = {
  gc: { contenedor: 'gananciaConceptos', campo: 'conceptosGanancia', body: bodyGanancia, min: -100, max: 300,
    titulo: 'Conceptos de ganancia', etiqueta: 'Concepto de ganancia',
    vacio: 'Sin conceptos: la ganancia es sólo la curva de cada tipo',
    ayuda: `% sobre el costo real que se suman a la curva de Reventa, Fraccionado y Producción: ganancia = curva + conceptos;
      precio neto = costo real × (1 + ganancia). Las ganancias propias por producto reemplazan curva y conceptos. Guardar no
      reescala nada: los precios sugeridos cambian.` },
  pf: { contenedor: 'gananciaPrecioFinal', campo: 'conceptosPrecioFinal', body: bodyPrecioFinal, min: 0, max: 99.99,
    titulo: 'Conceptos sobre precio final', etiqueta: 'Concepto sobre precio final',
    vacio: 'Sin conceptos: el precio final es el precio neto + IVA',
    ayuda: `% del precio final al público (con IVA), iguales para todos los tipos (ej. Ingresos brutos, impuesto a los débitos
      y créditos). Precio final = (precio neto + IVA) ÷ (1 − total); cada concepto $ = precio final × %. El total tiene que
      ser menor a 100 %. Guardar no reescala nada: los precios sugeridos cambian.` },
};
let listasEdit = { gc: [], pf: [] }; // copias editables [{ id?, concepto, pct }]

function htmlFilaConcepto(p, c, i) {
  const l = LISTAS_GANANCIA[p];
  return `<tr data-i="${i}">
    <td class="pr-3 py-1"><input type="text" maxlength="60" data-campo="concepto" value="${esc(c.concepto ?? '')}"
        aria-label="${l.etiqueta}, fila ${i + 1}" class="campo-t"></td>
    <td class="pr-2 py-1 text-right">${campoU(`<input type="number" min="${l.min}" max="${l.max}" step="any" inputmode="decimal" data-campo="pct"
        value="${esc(c.pct ?? '')}" aria-label="Porcentaje del concepto, fila ${i + 1}">`, '%')}</td>
    <td class="text-right"><button type="button" class="${p}-quitar btn-quitar" data-edita title="Quitar concepto" aria-label="Quitar concepto ${i + 1}">✕</button></td>
  </tr>`;
}

function pintarConceptos(p) {
  document.getElementById(`${p}Filas`).innerHTML = listasEdit[p].map((c, i) => htmlFilaConcepto(p, c, i)).join('')
    || `<tr><td colspan="3" class="text-ink/50 py-2">${LISTAS_GANANCIA[p].vacio}</td></tr>`;
  document.getElementById(`${p}Agregar`).disabled = listasEdit[p].length >= CONCEPTOS_GANANCIA_MAX_CLI;
  pintarTotalConceptos(p);
}
const pintarTotalConceptos = p => { document.getElementById(`${p}Total`).textContent = fmtPctGastos(totalConceptosGananciaCli(listasEdit[p])); };

function msgGanancia(p, txt, cls) {
  const el = document.getElementById(`${p}Msg`);
  if (el) { el.className = `text-sm ${cls}`; el.textContent = txt; }
}

function renderListaConceptos(p, cfg) {
  const l = LISTAS_GANANCIA[p];
  listasEdit = { ...listasEdit, [p]: (cfg[l.campo] || []).map(c => ({ ...c })) };
  document.getElementById(l.contenedor).innerHTML = `
    <div class="cfg-card" data-guardable>
      <h3 class="cfg-h">${l.titulo}</h3>
      <p class="cfg-ayuda">${l.ayuda}</p>
      <table class="w-full text-sm cfg-tabla">
        <thead><tr><th class="text-left">Concepto</th><th class="text-right pr-2">%</th><th class="w-8"></th></tr></thead>
        <tbody id="${p}Filas"></tbody>
        <tfoot>
          <tr class="border-t border-borde cfg-total"><td>Total conceptos</td>
            <td id="${p}Total" class="text-right pr-[17px] tabular-nums" aria-live="polite"></td><td></td></tr>
        </tfoot>
      </table>
      <button type="button" id="${p}Agregar" class="cfg-btn2 mt-3" data-edita>+ Agregar concepto</button>
      <div class="cfg-pie">
        <span id="${p}Msg" class="text-sm" role="status" aria-live="polite"></span>
        <button type="button" id="${p}Guardar" class="cfg-btn">Guardar</button>
      </div>
    </div>`;
  pintarConceptos(p);
  conectarConceptos(p);
}

function conectarConceptos(p) {
  const filas = document.getElementById(`${p}Filas`);
  // Editar actualiza la copia sin re-dibujar (no se pierde el foco); agregar/quitar re-dibuja.
  filas.addEventListener('input', e => {
    const campo = e.target.dataset.campo, tr = e.target.closest('tr[data-i]');
    if (!campo || !tr) return;
    const valor = campo === 'pct' ? numOrNull(e.target.value) : e.target.value;
    listasEdit = { ...listasEdit, [p]: listasEdit[p].map((c, k) => (k === Number(tr.dataset.i) ? { ...c, [campo]: valor } : c)) };
    pintarTotalConceptos(p);
  });
  filas.addEventListener('click', e => {
    const tr = e.target.closest(`.${p}-quitar`) && e.target.closest('tr[data-i]');
    if (tr) { listasEdit = { ...listasEdit, [p]: listasEdit[p].filter((_, k) => k !== Number(tr.dataset.i)) }; pintarConceptos(p); }
  });
  document.getElementById(`${p}Agregar`).onclick = () => {
    if (listasEdit[p].length >= CONCEPTOS_GANANCIA_MAX_CLI) return;
    listasEdit = { ...listasEdit, [p]: [...listasEdit[p], { concepto: '', pct: null }] };
    pintarConceptos(p);
    const inputs = filas.querySelectorAll('input[data-campo="concepto"]');
    inputs[inputs.length - 1].focus();
  };
  document.getElementById(`${p}Guardar`).onclick = () => guardarListaConceptos(p);
}

async function guardarListaConceptos(p) {
  document.getElementById(`${p}Guardar`).disabled = true;
  msgGanancia(p, 'Guardando…', 'text-ink/50');
  try {
    await putJson('/api/precios/config/ganancia', LISTAS_GANANCIA[p].body(listasEdit[p]));
    fraccCargado = false; // precios_fraccionado.js: el precio cambia con los conceptos
    refrescarAlertasProduccion(); // precios_produccion.js
    await (p === 'pf' ? cargarPrecioFinal() : cargarGanancia());
    msgGanancia(p, 'Guardado.', 'text-ok');
  } catch (e) {
    msgGanancia(p, e.message, 'text-crit');
    document.getElementById(`${p}Guardar`).disabled = false;
  }
}

// Lee la config y pinta el sub-tab con `pintar`; idCarga = el "Cargando…" del sub-tab (también muestra el error).
async function cargarSubTabConfig(idCarga, pintar) {
  const carga = document.getElementById(idCarga);
  carga.className = 'text-sm text-ink/50 py-4';
  carga.innerHTML = '<span class="spin"></span> Cargando…';
  try {
    const j = await leerConfig(); // precios_config.js
    carga.className = 'hidden';
    pintar(j);
  } catch (e) {
    carga.className = 'text-sm py-4';
    carga.innerHTML = `<p class="text-crit" role="alert">No se pudo cargar: ${esc(e.message)}</p>`;
  }
}

// Sub-tab Ganancia: conceptos de ganancia y curvas por tipo (las tablas de lectura usan conceptos, IVA, F y el G del tipo).
const cargarGanancia = () => cargarSubTabConfig('gananciaCarga', j => {
  renderListaConceptos('gc', j);
  renderMargenesPropios();
  renderConfigCurva(j); // precios_config_curva.js
});

// ── Tarjeta Márgenes propios → curva (spec Parte E.1) ───────────────────────────────
// GET /api/precios/margenes-propios (cantidad por tipo); POST …/previsualizar y …/aplicar { topePct }.
const NOMBRE_TIPO_MP = { almacen: 'Reventa', fraccionado: 'Fraccionado', produccion: 'Producción' };
const fmtPrecioMp = n => (n == null ? '—' : '$ ' + new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n));

async function renderMargenesPropios() {
  const cont = document.getElementById('gananciaMargenes');
  let c;
  try {
    c = await (await fetch('/api/precios/margenes-propios')).json();
    if (c.error) throw new Error(c.error);
  } catch (e) {
    cont.innerHTML = `<div class="cfg-card"><p class="text-crit text-sm" role="alert">Márgenes propios: ${esc(e.message)}</p></div>`;
    return;
  }
  const [min, max] = c.topeRangoPct;
  cont.innerHTML = `
    <div class="cfg-card">
      <h3 class="cfg-h">Márgenes propios</h3>
      <p class="cfg-ayuda">Ganancias propias por producto (casi todas de "Alinear con SIGA") que reemplazan curva + conceptos. Cada paso
        compara el precio final exacto con la ganancia propia y con la standard (mismo costo): si la diferencia es menor o igual
        al tope, la propia se borra y el producto pasa al standard; si no, el precio se mueve el tope % hacia el standard (la
        ganancia propia se recalcula). Repetirlo otro día sigue acercando. Productos sin costo o sin standard no se tocan.</p>
      <p id="mpCuenta" class="text-sm mb-2">${htmlCuentaMp(c)}</p>
      <div class="flex items-center gap-2 flex-wrap">
        <label for="mpTope" class="text-sm">Tope de cambio por paso</label>
        ${campoU(`<input id="mpTope" type="number" min="${min}" max="${max}" step="0.5" inputmode="decimal" value="${esc(c.topeDefaultPct)}">`, '% del precio final', { w: 'w-44' })}
        <button type="button" id="mpPrevisualizar" class="cfg-btn2">Previsualizar</button>
        <button type="button" id="mpAplicar" class="cfg-btn">Aplicar</button>
      </div>
      <div id="mpMsg" class="text-sm mt-2" role="status" aria-live="polite"></div>
      <div id="mpResultado"></div>
    </div>`;
  document.getElementById('mpPrevisualizar').onclick = () => pasoMargenesPropios(false);
  document.getElementById('mpAplicar').onclick = () => pasoMargenesPropios(true);
}

const htmlCuentaMp = c => `<b>${c.total}</b> márgenes propios: ${Object.entries(c.porTipo).map(([t, n]) => `${esc(NOMBRE_TIPO_MP[t])} ${n}`).join(' · ')}`;

function htmlResultadoMp(r) {
  const tdR = (txt, cls = '') => `<td class="px-2 py-1 text-right tabular-nums ${cls}">${txt}</td>`;
  const dist = r.distribucion.filter(d => d.n > 0).map(d => `<span class="mr-3 whitespace-nowrap">${esc(etiquetaRangoMp(d))}: <b>${d.n}</b></span>`).join('');
  return `
    <p class="text-sm mt-2">${esc(textoResumenMp(r))}</p>
    <p class="text-xs text-gris mt-1">Δ precio: ${dist || 'sin cambios'}</p>
    ${r.top.length ? `<h4 class="text-sm font-semibold mt-3 mb-1">Los ${r.top.length} con mayor cambio de precio</h4>
    <table class="w-full text-sm cfg-tabla">
      <thead><tr><th class="text-left pr-2">PLU</th><th class="text-left pr-2">Producto</th><th class="text-left pr-2">Tipo</th>
        <th class="text-right px-2">Precio actual</th><th class="text-right px-2">Precio standard</th><th class="text-right px-2">Precio nuevo</th>
        <th class="text-right px-2">Δ</th></tr></thead>
      <tbody>${r.top.map(f => `<tr class="border-t border-borde"><td class="pr-2 py-1 tabular-nums">${esc(f.plu ?? 'temporal')}</td>
        <td class="pr-2 py-1">${esc(f.nombre ?? '')}</td><td class="pr-2 py-1">${esc(NOMBRE_TIPO_MP[f.tipo] || f.tipo)}${f.accion === 'standard' ? ' <span class="text-ok text-xs">→ standard</span>' : ''}</td>
        ${tdR(esc(fmtPrecioMp(f.precioActual)))}${tdR(esc(fmtPrecioMp(f.precioStandard)), 'text-gris')}${tdR(esc(fmtPrecioMp(f.precioNuevo)), 'font-semibold')}
        ${tdR(esc(fmtDeltaMp(f.deltaPct)), f.deltaPct < 0 ? 'text-crit' : 'text-ok')}</tr>`).join('')}</tbody>
    </table>` : ''}`;
}

async function pasoMargenesPropios(aplicar) {
  const topePct = numOrNull(document.getElementById('mpTope').value);
  if (aplicar && !(await confirmar(`¿Aplicar el paso con tope ${String(topePct).replace('.', ',')} %? Borra o recalcula las ganancias propias (se guarda un backup de la config).`, { textoOk: 'Aplicar' }))) return;
  const botones = ['mpPrevisualizar', 'mpAplicar'].map(id => document.getElementById(id));
  const msg = document.getElementById('mpMsg');
  botones.forEach(b => { b.disabled = true; });
  msg.className = 'text-sm mt-2 text-ink/50';
  msg.innerHTML = '<span class="spin"></span> Calculando con los costos de SIGA… puede tardar unos segundos';
  try {
    const r = await pedirJson('POST', `/api/precios/margenes-propios/${aplicar ? 'aplicar' : 'previsualizar'}`, { topePct });
    document.getElementById('mpResultado').innerHTML = htmlResultadoMp(r);
    msg.className = 'text-sm mt-2 text-ok';
    msg.textContent = aplicar ? `Aplicado: ${r.aplicados} márgenes cambiados${r.omitidos ? ` (${r.omitidos} editados mientras tanto, no se tocaron)` : ''}.` : 'Previsualización (no se guardó nada).';
    if (aplicar) {
      fraccCargado = false; // precios_fraccionado.js
      refrescarAlertasProduccion(); // precios_produccion.js
      const c = await (await fetch('/api/precios/margenes-propios')).json();
      if (!c.error) document.getElementById('mpCuenta').innerHTML = htmlCuentaMp(c);
    }
  } catch (e) {
    msg.className = 'text-sm mt-2 text-crit'; msg.textContent = e.message;
  } finally { botones.forEach(b => { b.disabled = false; }); }
}

// Sub-tab Precio final: conceptos sobre precio final (edición) e IVA de venta (sólo lectura: se edita en Costos).
const cargarPrecioFinal = () => cargarSubTabConfig('pfCarga', j => {
  renderListaConceptos('pf', j);
  renderIvaLectura(j);
});

// IVA de venta en Precio final, sólo lectura: la edición sigue en Costos (renderIvaVenta, precios_costos.js).
function renderIvaLectura(cfg) {
  document.getElementById('pfIva').innerHTML = `
    <div class="cfg-card">
      <h3 class="cfg-h">IVA de venta</h3>
      <p class="cfg-ayuda">Se suma sobre el precio neto, antes de los conceptos sobre precio final. Se edita en Costos.</p>
      <div class="flex items-baseline justify-between">
        <span class="text-sm font-semibold">IVA de venta guardado</span>
        <span class="text-2xl font-bold text-ink tabular-nums">${esc(fmtPctGastos(ivaVentaCli(cfg)))}</span>
      </div>
      <div class="cfg-pie"><span role="status"></span>
        <button type="button" class="cfg-btn2" data-ir="costos">Editar en Costos ›</button></div>
    </div>`;
  document.querySelector('#pfIva [data-ir]').onclick = irASubConfig; // precios_config.js
}
