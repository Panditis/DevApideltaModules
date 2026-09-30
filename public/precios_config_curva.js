// ── Precios · Configuración: ganancia según costo (curva) — Almacén y Fraccionado ──
// Script clásico cargado después de precios_config_gastos.js: usa sus globales (gananciaPorCurvaCliente,
// markupDesdeGananciaCli, fmtPctGastos, gastosConfig) y los de los otros scripts de precios.html (esc,
// numOrNull, pedirJson, putJson, configCargada, cargarConfiguracion, fraccCargado, almacenData, fraccData).
// ganancia(c) = clamp(a − b·ln c, piso, techo) [+ ajuste por tramo de peso en Fraccionado]. Curva apagada →
// bandas / matriz como siempre; el margen propio por producto sigue ganando. "Calcular desde SIGA" =
// POST /api/precios/curva-ganancia/ajustar/:tipo (no guarda); Guardar = PUT /api/precios/config/curva-ganancia/:tipo.

// ── Helpers puros (sin DOM; test/precios_config_curva.test.js) ─────────────────
const CURVA_COSTOS_EJEMPLO = [500, 1000, 5000, 10000, 50000];
const fmtNumCurva = n => (n == null ? '—' : String(+(+n).toFixed(2)).replace('.', ','));
// Puntos de ganancia que se pierden cada vez que el costo se duplica: b × ln 2.
const puntosPorDuplicar = b => +(b * Math.LN2).toFixed(2);
// Curva sin mirar `activa` ni el ajuste por peso (la tarjeta la muestra aunque esté apagada).
const baseCurva = (curva, costo) => gananciaPorCurvaCliente({ ...curva, activa: true, ajustesPeso: null }, costo);

// Tabla de ejemplo: ganancia (con el ajuste del tramo de 1 kg si hay) y markup total con los gastos.
function filasEjemploCurva(curva, gastosPct) {
  return CURVA_COSTOS_EJEMPLO.map(costo => {
    const ganancia = gananciaPorCurvaCliente({ ...curva, activa: true }, costo);
    return { costo, ganancia, markup: markupDesdeGananciaCli(ganancia, gastosPct) };
  });
}

// Ajustes guardados alineados a los tramos de la matriz vigente (tramo sin ajuste → 0).
function ajustesParaTramos(tramosG, ajustesPeso) {
  const aj = ajustesPeso && Array.isArray(ajustesPeso.tramosG) ? ajustesPeso : { tramosG: [], puntos: [] };
  return (tramosG || []).map(t => {
    const i = aj.tramosG.indexOf(t);
    return i < 0 ? 0 : Number(aj.puntos[i]) || 0;
  });
}

// Productos con margen propio sobre los datos ya cargados (Almacén: filas; Fraccionado: presentaciones).
function margenPropio(tipo, filasAlmacen, gruposFracc) {
  const items = tipo === 'fraccionado'
    ? (gruposFracc || []).flatMap(g => g.presentaciones || []) : (filasAlmacen || []);
  return { n: items.filter(f => f && f.markupOverride != null).length, total: items.length };
}

// Marcas del eje X logarítmico: 1-2-5 × 10^k dentro de [min, max]; si son más de 8, 1-5 o sólo 10^k.
function marcasLog(min, max) {
  const con = ms => {
    const out = [];
    for (let k = Math.floor(Math.log10(min)); k <= Math.ceil(Math.log10(max)); k++) {
      for (const m of ms) { const v = +(m * 10 ** k).toPrecision(6); if (v >= min && v <= max) out.push(v); }
    }
    return out;
  };
  const marcas = [[1, 2, 5], [1, 5], [1]].map(con).find(o => o.length <= 8) || [];
  return marcas.length ? marcas : [min, max];
}
// Marcas del eje Y (ganancia %): paso "redondo" para que queden ~6 o menos.
function marcasLineales(min, max) {
  const paso = [1, 2, 5, 10, 20, 25, 50, 100].find(p => (max - min) / p <= 6) || 100;
  const out = [];
  for (let v = Math.ceil(min / paso) * paso + 0; v <= max; v += paso) out.push(v); // + 0: sin −0
  return out;
}

// Dominio del gráfico: X = costos de la muestra y los bins (con margen); Y = medianas, extremos de las
// curvas y el 5–95 % de la muestra (los outliers quedan afuera para no aplastar el resto). null sin datos.
function dominioCurva(prop, guardada) {
  const costos = [...(prop.muestra || []), ...(prop.bins || [])].map(p => p.costo).filter(c => c > 0);
  if (!costos.length) return null;
  const x = [Math.min(...costos) / 1.3, Math.max(...costos) * 1.3];
  const gs = (prop.muestra || []).map(p => p.ganancia).sort((p, q) => p - q);
  const pct = q => (gs.length ? gs[Math.floor(q * (gs.length - 1))] : null);
  const extremos = c => (c ? [baseCurva(c, x[0]), baseCurva(c, x[1])] : []);
  const ys = [...(prop.bins || []).map(b => b.ganancia), pct(0.05), pct(0.95), ...extremos(prop), ...extremos(guardada)]
    .filter(v => typeof v === 'number' && Number.isFinite(v));
  const y0 = Math.max(-50, Math.min(...ys) - 5), y1 = Math.min(300, Math.max(...ys) + 5);
  return { x, y: [y0, y1 > y0 ? y1 : y0 + 10] };
}

if (typeof module === 'object' && module.exports) {
  module.exports = { puntosPorDuplicar, filasEjemploCurva, ajustesParaTramos, margenPropio, marcasLog, marcasLineales, dominioCurva };
}

// ── Gráfico (SVG propio, sin librerías) ────────────────────────────────────────
const CV_W = 640, CV_H = 300, CV_M = { l: 52, r: 16, t: 14, b: 46 };
const fmtCostoEje = v => '$' + v.toLocaleString('es-AR');

// Escalas: X logarítmica (costo), Y lineal (ganancia %).
function escalasCurva(dom) {
  const [l0, l1] = dom.x.map(Math.log), [y0, y1] = dom.y;
  const ancho = CV_W - CV_M.l - CV_M.r, alto = CV_H - CV_M.t - CV_M.b;
  return {
    sx: c => +(CV_M.l + (Math.log(c) - l0) / (l1 - l0) * ancho).toFixed(1),
    sy: g => +(CV_M.t + (y1 - g) / (y1 - y0) * alto).toFixed(1),
  };
}

function ejesCurva(dom, { sx, sy }, tituloX) {
  const xIzq = CV_M.l, xDer = CV_W - CV_M.r, yAbajo = CV_H - CV_M.b, yArriba = CV_M.t;
  const xs = marcasLog(...dom.x).map(v => `<line x1="${sx(v)}" x2="${sx(v)}" y1="${yArriba}" y2="${yAbajo}" class="stroke-borde"/>
    <text x="${sx(v)}" y="${yAbajo + 16}" text-anchor="middle">${esc(fmtCostoEje(v))}</text>`).join('');
  const ys = marcasLineales(...dom.y).map(v => `<line x1="${xIzq}" x2="${xDer}" y1="${sy(v)}" y2="${sy(v)}" class="stroke-borde"/>
    <text x="${xIzq - 6}" y="${sy(v) + 4}" text-anchor="end">${v} %</text>`).join('');
  return `<g class="fill-gris" font-size="11">${xs}${ys}
    <text x="${(xIzq + xDer) / 2}" y="${CV_H - 6}" text-anchor="middle">${esc(tituloX)}</text>
    <text transform="rotate(-90)" x="${-(yArriba + yAbajo) / 2}" y="13" text-anchor="middle">Ganancia (%)</text></g>`;
}

// Trazo de la curva (sin ajuste por peso) en 80 tramos parejos en escala log, recortado al dominio Y.
function trazoCurva(curva, dom, { sx, sy }) {
  const [l0, l1] = dom.x.map(Math.log);
  return Array.from({ length: 81 }, (_, i) => Math.exp(l0 + (l1 - l0) * i / 80))
    .map(c => [c, baseCurva(curva, c)]).filter(([, g]) => g != null)
    .map(([c, g], i) => `${i ? 'L' : 'M'}${sx(c)},${sy(Math.min(dom.y[1], Math.max(dom.y[0], g)))}`).join('');
}

function ariaCurva(prop, guardada) {
  return `Gráfico de ganancia según costo: ${prop.n} productos, a = ${fmtNumCurva(prop.a)}, b = ${fmtNumCurva(prop.b)}, `
    + `r² = ${fmtNumCurva(prop.r2)}. Puntos: productos y medianas por tramo de costo; línea: curva propuesta`
    + (guardada ? '; línea punteada: curva guardada.' : '.');
}

function svgCurva(tipo, prop, guardada) {
  const dom = dominioCurva(prop, guardada);
  if (!dom) return '<p class="text-xs text-gris">Sin datos para graficar.</p>';
  const esc2 = escalasCurva(dom);
  const dentro = p => p.costo > 0 && p.ganancia >= dom.y[0] && p.ganancia <= dom.y[1];
  const muestra = prop.muestra.filter(dentro).map(p => `<circle cx="${esc2.sx(p.costo)}" cy="${esc2.sy(p.ganancia)}" r="2"/>`).join('');
  const bins = prop.bins.filter(dentro).map(b => `<circle cx="${esc2.sx(b.costo)}" cy="${esc2.sy(b.ganancia)}" r="5">`
    + `<title>${esc(fmtCostoEje(b.costo))} → ${esc(fmtPctGastos(b.ganancia))} (${b.n} productos)</title></circle>`).join('');
  return `<svg viewBox="0 0 ${CV_W} ${CV_H}" class="w-full h-auto" role="img" aria-label="${esc(ariaCurva(prop, guardada))}">
    ${ejesCurva(dom, esc2, CURVA_TIPOS[tipo].ejeX)}
    <g class="fill-gris" fill-opacity="0.3">${muestra}</g>
    ${guardada ? `<path d="${trazoCurva(guardada, dom, esc2)}" fill="none" class="stroke-gris" stroke-width="2" stroke-dasharray="6 4"/>` : ''}
    <path d="${trazoCurva(prop, dom, esc2)}" fill="none" class="stroke-verde" stroke-width="2.5"/>
    <g class="fill-warn stroke-card" stroke-width="1.5">${bins}</g>
  </svg>`;
}

function leyendaCurva(guardada) {
  const item = (svg, txt) => `<span class="inline-flex items-center gap-1.5"><svg aria-hidden="true" width="22" height="12">${svg}</svg>${txt}</span>`;
  return `<div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gris mt-1">
    ${item('<circle cx="11" cy="6" r="2.5" class="fill-gris" fill-opacity="0.45"/>', 'Productos (muestra)')}
    ${item('<circle cx="11" cy="6" r="5" class="fill-warn"/>', 'Mediana por tramo de costo')}
    ${item('<line x1="0" y1="6" x2="22" y2="6" class="stroke-verde" stroke-width="2.5"/>', 'Curva propuesta')}
    ${guardada ? item('<line x1="0" y1="6" x2="22" y2="6" class="stroke-gris" stroke-width="2" stroke-dasharray="6 4"/>', 'Curva guardada') : ''}
  </div>`;
}

// ── Tarjetas ────────────────────────────────────────────────────────────────────
// Almacén va debajo de su tabla de bandas (#configCurvaAlmacen lo crea precios_config_bandas.js);
// Fraccionado, debajo de la matriz (#configCurvaFraccionado en precios.html).
const CURVA_TIPOS = {
  almacen: { cont: 'configCurvaAlmacen', titulo: 'Ganancia según costo (curva) — Almacén', reemplaza: 'las bandas de Almacén',
    ejeX: 'Costo base ($, escala logarítmica)',
    ayuda: 'La ganancia standard sale del costo base del producto: a más costo, menor ganancia.' },
  fraccionado: { cont: 'configCurvaFraccionado', titulo: 'Ganancia según costo (curva) — Fraccionado', reemplaza: 'la matriz de Fraccionado',
    ejeX: 'Costo del granel ($/kg, escala logarítmica)',
    ayuda: 'La ganancia standard sale del costo del granel por kg, más un ajuste según el peso de la presentación (mismos tramos que la matriz).' },
};
let curvaEdit = { almacen: null, fraccionado: null };      // copia editable { activa, a, b, pisoPct, techoPct, ajustadaEl, n, ajustesPeso? }
let curvaGuardada = { almacen: null, fraccionado: null };  // lo que vino de la config
let curvaPropuesta = { almacen: null, fraccionado: null }; // respuesta de "Calcular desde SIGA" (sobrevive a recargar la config)

const tarjetaCurva = tipo => document.querySelector(`[data-curva="${tipo}"]`);
const hoyISO = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
// Hay curva guardada para comparar si alguna vez se usó, se ajustó o se cargó a mano.
const hayCurvaGuardada = c => !!c && [c.a, c.b, c.pisoPct, c.techoPct].every(v => typeof v === 'number')
  && c.pisoPct < c.techoPct && (c.activa || c.ajustadaEl || c.a !== 0 || c.b !== 0);

function msgCurva(tipo, txt, cls, html = false) {
  const el = tarjetaCurva(tipo) && tarjetaCurva(tipo).querySelector('.cv-msg');
  if (!el) return;
  el.className = `cv-msg text-sm mt-2 ${cls}`;
  if (html) el.innerHTML = txt; else el.textContent = txt;
}

function htmlInputsCurva(tipo, c) {
  const campo = (cls, etiqueta, titulo, valor) => `<label class="block text-sm" title="${esc(titulo)}">${etiqueta}
      <input type="number" step="any" inputmode="decimal" value="${esc(valor ?? '')}" class="${cls} mt-1 w-full px-2 py-1 rounded border border-borde text-right tabular-nums"></label>`;
  return `<div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
    ${campo('cv-a', 'a (%)', 'Ganancia que daría un costo de $1: la altura de la curva', c.a)}
    ${campo('cv-b', 'b (pendiente)', 'Cuánto baja la ganancia a medida que sube el costo', c.b)}
    ${campo('cv-piso', 'Piso (%)', 'Ganancia mínima, para los costos más altos', c.pisoPct)}
    ${campo('cv-techo', 'Techo (%)', 'Ganancia máxima, para los costos más bajos', c.techoPct)}
  </div>`;
}

function htmlTarjetaCurva(tipo) {
  const t = CURVA_TIPOS[tipo], c = curvaEdit[tipo];
  return `<div class="rounded-xl border border-borde shadow-fluent bg-card p-5 max-w-2xl mt-5" data-curva="${tipo}">
    <h2 class="font-disp text-lg font-bold text-verde mb-1">${esc(t.titulo)}</h2>
    <p class="text-xs text-ink/50 mb-4">${esc(t.ayuda)} ganancia = a − b × ln(costo), acotada entre piso y techo.
      El markup que se aplica suma los gastos sobre venta (${esc(fmtPctGastos(gastosConfig()))}).</p>
    <label class="flex items-start gap-2 text-sm cursor-pointer"><input type="checkbox" role="switch" class="cv-activa accent-verde mt-1"${c.activa ? ' checked' : ''}>
      <span><b>Usar curva</b><span class="block text-[11px] text-gris">Apagado: se usan ${esc(t.reemplaza)}. Los márgenes propios por producto siguen ganando.</span></span></label>
    ${htmlInputsCurva(tipo, c)}
    <p class="cv-duplica text-sm mt-3" aria-live="polite"></p>
    <table class="text-sm mt-2 tabular-nums">
      <caption class="text-left text-xs text-ink/60 pb-1">Ejemplos${tipo === 'fraccionado' ? ' (presentación de 1 kg)' : ''}</caption>
      <thead class="text-ink/60"><tr><th class="text-left font-normal pr-6">Costo</th><th class="text-right font-normal pr-6">Ganancia</th>
        <th class="text-right font-normal" title="Con los gastos sobre venta actuales">Markup total</th></tr></thead>
      <tbody class="cv-ejemplo"></tbody>
    </table>
    ${tipo === 'fraccionado' ? '<div class="cv-ajustes mt-4"></div>' : ''}
    <p class="cv-aviso text-sm text-warn mt-3"></p>
    <p class="cv-estado text-[11px] text-gris mt-2"></p>
    <div class="flex flex-wrap items-center gap-2 mt-4">
      <button type="button" class="cv-calcular px-3 py-1 rounded-lg border border-borde text-xs hover:bg-white disabled:opacity-40">Calcular desde SIGA</button>
      <button type="button" class="cv-usar px-3 py-1 rounded-lg border border-borde text-xs hover:bg-white disabled:opacity-40"${curvaPropuesta[tipo] ? '' : ' disabled'}>Usar esta curva</button>
      <button type="button" class="cv-guardar px-3 py-1.5 rounded-lg bg-verde text-white text-sm hover:bg-verdeHover disabled:opacity-40">Guardar curva</button>
    </div>
    <div class="cv-msg text-sm mt-2" role="status" aria-live="polite"></div>
    <div class="cv-grafico mt-3"></div>
  </div>`;
}

// Fila de ajustes por peso (puntos de ganancia que se suman a la curva), un input por tramo de la matriz.
function pintarAjustesCurva(tipo) {
  const cont = tarjetaCurva(tipo).querySelector('.cv-ajustes');
  if (!cont) return;
  const { tramosG, puntos } = curvaEdit[tipo].ajustesPeso;
  cont.innerHTML = !tramosG.length ? '' : `<p class="text-sm mb-1">Ajuste por peso <span class="text-[11px] text-gris">(puntos de ganancia que se suman a la curva; tramos de la matriz)</span></p>
    <div class="overflow-x-auto"><table class="text-sm"><thead class="text-ink/60"><tr>${tramosG.map(t => `<th class="font-normal pr-1 text-left whitespace-nowrap">hasta ${esc(t)} g</th>`).join('')}</tr></thead>
      <tbody><tr>${puntos.map((v, k) => `<td class="pr-1 py-1"><input type="number" step="any" min="-100" max="100" inputmode="decimal" value="${esc(v)}"
        aria-label="Ajuste de ganancia para presentaciones hasta ${esc(tramosG[k])} g" class="cv-ajuste w-20 px-2 py-1 rounded border border-borde text-right tabular-nums"></td>`).join('')}</tr></tbody></table></div>`;
}

// Lee la tarjeta sobre la copia editable: conserva ajustadaEl y n (sólo los cambia "Usar esta curva").
function leerCurva(tipo) {
  const card = tarjetaCurva(tipo), v = cls => numOrNull(card.querySelector(cls).value);
  const c = { ...curvaEdit[tipo], activa: card.querySelector('.cv-activa').checked,
    a: v('.cv-a'), b: v('.cv-b'), pisoPct: v('.cv-piso'), techoPct: v('.cv-techo') };
  if (tipo !== 'fraccionado') return c;
  const puntos = [...card.querySelectorAll('.cv-ajuste')].map(i => numOrNull(i.value) ?? 0);
  return { ...c, ajustesPeso: { tramosG: curvaEdit[tipo].ajustesPeso.tramosG, puntos } };
}

// Texto "cada vez que el costo se duplica…" y tabla de ejemplos, en vivo con lo que hay en los inputs.
function pintarCurvaVivo(tipo) {
  const card = tarjetaCurva(tipo), c = curvaEdit[tipo];
  const dup = card.querySelector('.cv-duplica');
  const b = typeof c.b === 'number' ? puntosPorDuplicar(c.b) : null;
  dup.className = `cv-duplica text-sm mt-3 ${b != null && b < 0 ? 'text-warn' : ''}`;
  dup.textContent = b == null ? 'Completá a y b para ver la curva.'
    : b >= 0 ? `Cada vez que el costo se duplica, la ganancia baja ${fmtNumCurva(b)} puntos.`
      : `Atención: con b negativo la ganancia SUBE ${fmtNumCurva(-b)} puntos cada vez que el costo se duplica.`;
  if (typeof c.pisoPct === 'number' && typeof c.techoPct === 'number' && c.pisoPct >= c.techoPct) {
    dup.className = 'cv-duplica text-sm mt-3 text-crit';
    dup.textContent = 'El piso tiene que ser menor que el techo.';
  }
  card.querySelector('.cv-ejemplo').innerHTML = filasEjemploCurva(c, gastosConfig()).map(f => `<tr class="border-t border-borde">
    <td class="pr-6 py-0.5">${esc(fmtCostoEje(f.costo))}</td><td class="text-right pr-6">${esc(fmtPctGastos(f.ganancia))}</td>
    <td class="text-right text-gris">${esc(fmtPctGastos(f.markup))}</td></tr>`).join('');
}

// Estado guardado + aviso de márgenes propios (sobre los listados ya cargados, sin pedir nada).
function pintarEstadoCurva(tipo) {
  const card = tarjetaCurva(tipo), g = curvaGuardada[tipo];
  const fecha = g.ajustadaEl ? g.ajustadaEl.split('-').reverse().join('/') : null;
  card.querySelector('.cv-estado').textContent = `Guardada: ${g.activa ? 'en uso' : 'apagada'}`
    + (fecha ? ` · ajustada desde SIGA el ${fecha}${g.n != null ? ` con ${g.n} productos` : ''}` : '');
  const { n, total } = margenPropio(tipo, typeof almacenData !== 'undefined' ? almacenData : [], typeof fraccData !== 'undefined' ? fraccData : []);
  card.querySelector('.cv-aviso').textContent = total && n / total > 0.5 ? `${n} productos tienen margen propio y no siguen la curva.` : '';
}

function pintarGraficoCurva(tipo) {
  const cont = tarjetaCurva(tipo).querySelector('.cv-grafico'), p = curvaPropuesta[tipo];
  if (!p) { cont.innerHTML = ''; return; }
  const guardada = hayCurvaGuardada(curvaGuardada[tipo]) ? curvaGuardada[tipo] : null;
  const aj = p.ajustesPeso && p.ajustesPeso.tramosG.length
    ? ' · ajuste por peso: ' + p.ajustesPeso.tramosG.map((t, k) => `${t} g ${fmtNumCurva(p.ajustesPeso.puntos[k])}`).join(', ') : '';
  cont.innerHTML = `<p class="text-sm mb-1"><b>Propuesta desde SIGA:</b> a = ${fmtNumCurva(p.a)} · b = ${fmtNumCurva(p.b)} ·
      piso ${esc(fmtPctGastos(p.pisoPct))} · techo ${esc(fmtPctGastos(p.techoPct))} · n = ${esc(p.n)} productos · r² = ${fmtNumCurva(p.r2)}${esc(aj)}</p>
    ${svgCurva(tipo, p, guardada)}${leyendaCurva(guardada)}`;
}

function conectarTarjetaCurva(tipo) {
  const card = tarjetaCurva(tipo);
  const releer = () => { curvaEdit = { ...curvaEdit, [tipo]: leerCurva(tipo) }; pintarCurvaVivo(tipo); };
  card.addEventListener('input', releer);
  card.addEventListener('change', releer);
  card.querySelector('.cv-calcular').onclick = () => calcularCurvaSiga(tipo);
  card.querySelector('.cv-usar').onclick = () => usarPropuestaCurva(tipo);
  card.querySelector('.cv-guardar').onclick = () => guardarCurva(tipo);
}

// La llama cargarConfiguracion (precios_config.js) con la config recién leída.
function renderConfigCurva(cfg) {
  const cg = cfg.curvaGanancia || {};
  const tramosG = (cfg.markupFraccionado || {}).tramosG || [];
  for (const tipo of Object.keys(CURVA_TIPOS)) {
    const cont = document.getElementById(CURVA_TIPOS[tipo].cont);
    if (!cont) continue;
    const g = cg[tipo] || { activa: false, a: 0, b: 0, pisoPct: 0, techoPct: 100, ajustadaEl: null, n: null };
    curvaGuardada = { ...curvaGuardada, [tipo]: g };
    curvaEdit = { ...curvaEdit, [tipo]: tipo === 'fraccionado'
      ? { ...g, ajustesPeso: { tramosG: [...tramosG], puntos: ajustesParaTramos(tramosG, g.ajustesPeso) } } : { ...g } };
    cont.innerHTML = htmlTarjetaCurva(tipo);
    pintarAjustesCurva(tipo);
    pintarCurvaVivo(tipo);
    pintarEstadoCurva(tipo);
    pintarGraficoCurva(tipo);
    conectarTarjetaCurva(tipo);
  }
}

// Propuesta ajustada a los precios vigentes (no guarda). Arma todo el universo: tarda unos segundos.
async function calcularCurvaSiga(tipo) {
  const btn = tarjetaCurva(tipo).querySelector('.cv-calcular');
  btn.disabled = true;
  msgCurva(tipo, '<span class="spin"></span> Calculando con los precios vigentes de SIGA… puede tardar unos segundos', 'text-ink/50', true);
  try {
    const j = await pedirJson('POST', `/api/precios/curva-ganancia/ajustar/${tipo}`);
    curvaPropuesta = { ...curvaPropuesta, [tipo]: j };
    pintarGraficoCurva(tipo);
    tarjetaCurva(tipo).querySelector('.cv-usar').disabled = false;
    msgCurva(tipo, 'Propuesta lista: revisala en el gráfico y tocá "Usar esta curva".', 'text-ok');
  } catch (e) {
    msgCurva(tipo, e.message, 'text-crit');
  } finally { btn.disabled = false; }
}

// Vuelca la propuesta a los inputs (y los ajustes por peso a los tramos de la matriz); marca la fecha y n.
function usarPropuestaCurva(tipo) {
  const p = curvaPropuesta[tipo];
  if (!p) return;
  const actual = leerCurva(tipo);
  const extra = tipo === 'fraccionado'
    ? { ajustesPeso: { tramosG: actual.ajustesPeso.tramosG, puntos: ajustesParaTramos(actual.ajustesPeso.tramosG, p.ajustesPeso) } } : {};
  curvaEdit = { ...curvaEdit, [tipo]: { ...actual, a: p.a, b: p.b, pisoPct: p.pisoPct, techoPct: p.techoPct, ajustadaEl: hoyISO(), n: p.n, ...extra } };
  const card = tarjetaCurva(tipo);
  [['.cv-a', p.a], ['.cv-b', p.b], ['.cv-piso', p.pisoPct], ['.cv-techo', p.techoPct]].forEach(([cls, v]) => { card.querySelector(cls).value = v; });
  pintarAjustesCurva(tipo);
  pintarCurvaVivo(tipo);
  msgCurva(tipo, `Curva propuesta cargada: revisala${actual.activa ? '' : ', prendé "Usar curva"'} y tocá Guardar curva.`, 'text-warn');
}

// Guarda y recarga toda la Configuración (como gastos): el listado de Fraccionado se recalcula al volver.
async function guardarCurva(tipo) {
  const c = leerCurva(tipo);
  const body = { activa: c.activa, a: c.a, b: c.b, pisoPct: c.pisoPct, techoPct: c.techoPct, ajustadaEl: c.ajustadaEl ?? null, n: c.n ?? null,
    ...(tipo === 'fraccionado' ? { ajustesPeso: c.ajustesPeso.tramosG.length ? c.ajustesPeso : null } : {}) };
  const btn = tarjetaCurva(tipo).querySelector('.cv-guardar');
  btn.disabled = true;
  msgCurva(tipo, 'Guardando…', 'text-ink/50');
  try {
    await putJson(`/api/precios/config/curva-ganancia/${tipo}`, body);
    fraccCargado = false; // precios_fraccionado.js: el standard de la matriz/curva cambió
    await cargarConfiguracion(); // precios_config.js: vuelve a dibujar esta tarjeta con lo guardado
    msgCurva(tipo, 'Guardado.', 'text-ok');
  } catch (e) {
    msgCurva(tipo, e.message, 'text-crit');
    btn.disabled = false;
  }
}
