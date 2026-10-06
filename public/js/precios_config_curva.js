// ── Precios · Costos: ganancia según costo (curva) — Reventa (almacen), Fraccionado y Producción ──
// Script clásico cargado después de precios_config_gastos.js: usa sus globales (gananciaPorCurvaCliente,
// markupDesdeGananciaCli, fmtPctGastos, gastosConfig) y los de los otros scripts de precios.html (esc,
// numOrNull, pedirJson, putJson, configCargada, cargarGanancia, fraccCargado, almacenData, fraccData,
// refrescarAlertasProduccion). ganancia(c) = clamp(a − b·ln c, piso, techo) sobre el costo NETO [+ ajuste por
// tramo de peso en Fraccionado]: único método standard de los tres tipos (siempre aplica); el margen propio por
// producto la pisa. "Calcular desde SIGA" = POST /api/precios/curva-ganancia/ajustar/:tipo (no guarda);
// Guardar = PUT /api/precios/config/curva-ganancia/:tipo.

// ── Helpers puros (sin DOM; test/precios_config_curva.test.js) ─────────────────
// Costos netos de referencia de la tabla de lectura.
const CURVA_COSTOS_EJEMPLO = [500, 1000, 2500, 5000, 10000, 20000, 50000];
// IVA de venta con el que la tabla muestra el markup final si la config no trae ivaVentaPct.
const CURVA_IVA_LECTURA = 21;
// Tramos de peso (g) del ajuste Fraccionado cuando la curva guardada no trae los suyos (= TRAMOS_PESO_DEFAULT del server).
const CURVA_TRAMOS_DEFAULT = [100, 200, 400, 500, 1000, 5000, 10000];
const fmtNumCurva = n => (n == null ? '—' : String(+(+n).toFixed(2)).replace('.', ','));
// Puntos de ganancia que se pierden cada vez que el costo se duplica: b × ln 2.
const puntosPorDuplicar = b => +(b * Math.LN2).toFixed(2);
// Curva sin el ajuste por peso (trazo del gráfico).
const baseCurva = (curva, costo) => gananciaPorCurvaCliente({ ...curva, ajustesPeso: null }, costo);
// Markup final % (precio final ÷ costo neto − 1) desde el markup sobre neto: × (1 + IVA) ÷ (1 − F), F = conceptos
// sobre precio final.
const markupFinalCli = (markupNeto, ivaPct = CURVA_IVA_LECTURA, finalPct = 0) =>
  (markupNeto == null ? null : +(((1 + markupNeto / 100) * (1 + ivaPct / 100) / (1 - finalPct / 100) - 1) * 100).toFixed(2));

// Tabla de lectura en los costos netos de referencia: ganancia de la curva (con el ajuste del tramo de pesoG si hay;
// sin peso = 1 kg), + conceptos de ganancia = ganancia total s/ costo real; markup sobre neto con los gastos del tipo
// ((1 + ganancia) ÷ (1 − gastos) − 1) y markup final con el IVA de venta y los conceptos sobre precio final (finalPct).
function filasEjemploCurva(curva, gastosPct, pesoG = null, conceptosPct = 0, ivaPct = CURVA_IVA_LECTURA, finalPct = 0) {
  return CURVA_COSTOS_EJEMPLO.map(costo => {
    const gananciaCurva = gananciaPorCurvaCliente(curva, costo, pesoG);
    const ganancia = gananciaCurva == null ? null : +(gananciaCurva + conceptosPct).toFixed(6);
    const markup = markupDesdeGananciaCli(ganancia, gastosPct);
    return { costo, gananciaCurva, ganancia, markup, markupFinal: markupFinalCli(markup, ivaPct, finalPct) };
  });
}
// Conceptos, IVA de venta y conceptos sobre precio final de la config cargada para las tablas de lectura.
const lecturaCfg = () => ({ conceptosPct: Number((configCargada || {}).conceptosGananciaPct) || 0,
  ivaPct: Number.isFinite((configCargada || {}).ivaVentaPct) ? configCargada.ivaVentaPct : CURVA_IVA_LECTURA,
  finalPct: Number((configCargada || {}).conceptosPrecioFinalPct) || 0 });
const filasLectura = (c, tipo, pesoG = null) => { const l = lecturaCfg(); return filasEjemploCurva(c, gastosConfig(tipo), pesoG, l.conceptosPct, l.ivaPct, l.finalPct); };

// Ajustes guardados alineados a una lista de tramos (tramo sin ajuste → 0).
function ajustesParaTramos(tramosG, ajustesPeso) {
  const aj = ajustesPeso && Array.isArray(ajustesPeso.tramosG) ? ajustesPeso : { tramosG: [], puntos: [] };
  return (tramosG || []).map(t => {
    const i = aj.tramosG.indexOf(t);
    return i < 0 ? 0 : Number(aj.puntos[i]) || 0;
  });
}

// Productos con margen propio sobre los datos ya cargados (Almacén: filas; Fraccionado: presentaciones).
function margenPropio(tipo, filasAlmacen, gruposFracc) {
  // Producción no tiene listado cargado acá: sin aviso.
  const items = tipo === 'fraccionado' ? (gruposFracc || []).flatMap(g => g.presentaciones || [])
    : tipo === 'almacen' ? (filasAlmacen || []) : [];
  return { n: items.filter(f => f && f.gananciaOverride != null).length, total: items.length };
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
  module.exports = { puntosPorDuplicar, filasEjemploCurva, markupFinalCli, ajustesParaTramos, margenPropio, marcasLog, marcasLineales, dominioCurva,
    CURVA_COSTOS_EJEMPLO };
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
// Una por tipo, en #configCurvaAlmacen / #configCurvaFraccionado / #configCurvaProduccion (precios.html).
const CURVA_TIPOS = {
  almacen: { cont: 'configCurvaAlmacen', titulo: 'Curva de Reventa',
    ejeX: 'Costo base neto ($, escala logarítmica)', unidad: '',
    ayuda: 'La ganancia standard sale del costo base neto del producto (antes de costos extra): a más costo, menor ganancia.' },
  fraccionado: { cont: 'configCurvaFraccionado', titulo: 'Curva de Fraccionado',
    ejeX: 'Costo neto del granel ($/kg, escala logarítmica)', unidad: '/kg',
    ayuda: 'La ganancia standard sale del costo neto del granel por kg, más un ajuste según el peso de la presentación.' },
  produccion: { cont: 'configCurvaProduccion', titulo: 'Curva de Producción',
    ejeX: 'Costo neto por unidad ($, escala logarítmica)', unidad: '',
    ayuda: 'La ganancia standard sale del costo neto por unidad de cada presentación (receta + insumos + mano de obra de empaquetado).' },
};
const curvaVacia = () => Object.fromEntries(Object.keys(CURVA_TIPOS).map(t => [t, null]));
let curvaEdit = curvaVacia();      // copia editable { a, b, pisoPct, techoPct, ajustadaEl, n, ajustesPeso? }
let curvaGuardada = curvaVacia();  // lo que vino de la config
let curvaPropuesta = curvaVacia(); // respuesta de "Calcular desde SIGA" (sobrevive a recargar la config)

const tarjetaCurva = tipo => document.querySelector(`[data-curva="${tipo}"]`);
const hoyISO = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
// Hay curva guardada para comparar si es válida y no es la de fábrica en cero.
const hayCurvaGuardada = c => !!c && [c.a, c.b, c.pisoPct, c.techoPct].every(v => typeof v === 'number')
  && c.pisoPct <= c.techoPct && (c.ajustadaEl || c.a !== 0 || c.b !== 0);

function msgCurva(tipo, txt, cls, html = false) {
  const el = tarjetaCurva(tipo) && tarjetaCurva(tipo).querySelector('.cv-msg');
  if (!el) return;
  el.className = `cv-msg text-sm ${cls}`;
  if (html) el.innerHTML = txt; else el.textContent = txt;
}

function htmlInputsCurva(tipo, c) {
  const campo = (cls, etiqueta, titulo, valor, u) => `<label class="block text-sm font-semibold" title="${esc(titulo)}">${etiqueta}
      <span class="block mt-1">${campoU(`<input type="number" step="any" inputmode="decimal" value="${esc(valor ?? '')}" class="${cls}">`, u, { w: 'w-full' })}</span></label>`;
  return `<div class="grid grid-cols-4 gap-3">
    ${campo('cv-a', 'a · altura', 'Ganancia que daría un costo de $1: la altura de la curva', c.a, '%')}
    ${campo('cv-b', 'b · pendiente', 'Cuánto baja la ganancia a medida que sube el costo', c.b, 'pts')}
    ${campo('cv-piso', 'Piso', 'Ganancia mínima, para los costos más altos', c.pisoPct, '%')}
    ${campo('cv-techo', 'Techo', 'Ganancia máxima, para los costos más bajos', c.techoPct, '%')}
  </div>`;
}

function htmlTarjetaCurva(tipo) {
  const t = CURVA_TIPOS[tipo], c = curvaEdit[tipo];
  const lectura = `<table class="w-full text-sm tabular-nums cfg-tabla">
      <caption class="text-left text-xs text-gris pb-1">Lectura${tipo === 'fraccionado' ? ' por kg (presentación de 1 kg)' : ''} · costos del tipo ${esc(fmtPctGastos(gastosConfig(tipo)))} · conceptos ${esc(fmtPctGastos(lecturaCfg().conceptosPct))} · IVA ${esc(fmtPctGastos(lecturaCfg().ivaPct))} · s/ precio final ${esc(fmtPctGastos(lecturaCfg().finalPct))}</caption>
      <thead><tr><th class="text-left pr-4">Costo neto${esc(t.unidad)}</th><th class="text-right pr-4">Curva</th>
        <th class="text-right pr-4" title="Curva + conceptos de ganancia, s/ costo real">+ conceptos</th>
        <th class="text-right pr-4" title="(1 + ganancia) ÷ (1 − costos del tipo) − 1">Markup s/ neto</th>
        <th class="text-right" title="Precio final (con IVA y conceptos sobre precio final) ÷ costo neto − 1">Markup final</th></tr></thead>
      <tbody class="cv-ejemplo"></tbody>
    </table>`;
  // Fraccionado ocupa el ancho completo: inputs | lectura arriba; ajustes y tramos por peso (muchas columnas) abajo, a lo ancho.
  const cuerpo = tipo === 'fraccionado'
    ? `<div class="grid grid-cols-2 gap-x-8 gap-y-4 items-start"><div class="min-w-0">${htmlInputsCurva(tipo, c)}
        <p class="cv-duplica text-sm mt-3" aria-live="polite"></p></div><div class="min-w-0">${lectura}</div></div>
        <div class="cv-ajustes mt-5 pt-4 border-t border-borde"></div><div class="cv-tramos mt-4 overflow-x-auto"></div>`
    : `${htmlInputsCurva(tipo, c)}<p class="cv-duplica text-sm mt-3" aria-live="polite"></p><div class="mt-2">${lectura}</div>`;
  return `<div class="cfg-card" data-guardable data-curva="${tipo}">
    <h3 class="cfg-h">${esc(t.titulo)}</h3>
    <p class="cfg-ayuda">${esc(t.ayuda)} Curva = a − b × ln(costo neto), acotada entre piso y techo; ganancia = curva + conceptos
      de ganancia (las ganancias propias por producto reemplazan las dos).</p>
    ${cuerpo}
    <p class="cv-aviso text-sm text-warn mt-3"></p>
    <p class="cv-estado cfg-nota mt-2"></p>
    <div class="cv-grafico mt-3"></div>
    <div class="cfg-pie">
      <div class="cv-msg text-sm" role="status" aria-live="polite"></div>
      <button type="button" class="cv-calcular cfg-btn2">Calcular desde SIGA</button>
      <button type="button" class="cv-usar cfg-btn2" data-edita${curvaPropuesta[tipo] ? '' : ' disabled'}>Usar esta curva</button>
      <button type="button" class="cv-guardar cfg-btn">Guardar curva</button>
    </div>
  </div>`;
}

// Fila de ajustes por peso (puntos de ganancia que se suman a la curva), un input por tramo.
function pintarAjustesCurva(tipo) {
  const cont = tarjetaCurva(tipo).querySelector('.cv-ajustes');
  if (!cont) return;
  const { tramosG, puntos } = curvaEdit[tipo].ajustesPeso;
  cont.innerHTML = !tramosG.length ? '' : `<p class="text-sm font-semibold">Ajuste por peso <span class="cfg-nota">en puntos de ganancia que se suman a la curva; tramo = primer peso ≥ el de la presentación; sin peso → 1 kg</span></p>
    <div class="overflow-x-auto mt-2"><table class="w-full text-sm cfg-tabla"><thead><tr>${tramosG.map(t => `<th class="pr-1 text-right whitespace-nowrap">≤ ${esc(t)} g</th>`).join('')}</tr></thead>
      <tbody><tr>${puntos.map((v, k) => `<td class="pr-1 py-1">${campoU(`<input type="number" step="any" min="-100" max="100" inputmode="decimal" value="${esc(v)}"
        aria-label="Ajuste de ganancia para presentaciones hasta ${esc(tramosG[k])} g" class="cv-ajuste">`, '', { w: 'w-full' })}</td>`).join('')}</tr></tbody></table></div>`;
}

// Lee la tarjeta sobre la copia editable: conserva ajustadaEl y n (sólo los cambia "Usar esta curva").
function leerCurva(tipo) {
  const card = tarjetaCurva(tipo), v = cls => numOrNull(card.querySelector(cls).value);
  const c = { ...curvaEdit[tipo],
    a: v('.cv-a'), b: v('.cv-b'), pisoPct: v('.cv-piso'), techoPct: v('.cv-techo') };
  if (tipo !== 'fraccionado') return c;
  const puntos = [...card.querySelectorAll('.cv-ajuste')].map(i => numOrNull(i.value) ?? 0);
  return { ...c, ajustesPeso: { tramosG: curvaEdit[tipo].ajustesPeso.tramosG, puntos } };
}

// Texto "cada vez que el costo se duplica…" y tablas de lectura, en vivo con lo que hay en los inputs.
function pintarCurvaVivo(tipo) {
  const card = tarjetaCurva(tipo), c = curvaEdit[tipo];
  const dup = card.querySelector('.cv-duplica');
  const b = typeof c.b === 'number' ? puntosPorDuplicar(c.b) : null;
  dup.className = `cv-duplica text-sm mt-3 ${b != null && b < 0 ? 'text-warn' : ''}`;
  dup.textContent = b == null ? 'Completá a y b para ver la curva.'
    : b >= 0 ? `Cada vez que el costo se duplica, la ganancia baja ${fmtNumCurva(b)} puntos.`
      : `Atención: con b negativo la ganancia SUBE ${fmtNumCurva(-b)} puntos cada vez que el costo se duplica.`;
  if (typeof c.pisoPct === 'number' && typeof c.techoPct === 'number' && c.pisoPct > c.techoPct) {
    dup.className = 'cv-duplica text-sm mt-3 text-crit';
    dup.textContent = 'El piso no puede ser mayor que el techo.';
  }
  card.querySelector('.cv-ejemplo').innerHTML = filasLectura(c, tipo).map(f => `<tr class="border-t border-borde">
    <td class="pr-6 py-0.5">${esc(fmtCostoEje(f.costo))}</td><td class="text-right pr-6">${esc(fmtPctGastos(f.gananciaCurva))}</td>
    <td class="text-right pr-6">${esc(fmtPctGastos(f.ganancia))}</td>
    <td class="text-right pr-6 text-gris">${esc(fmtPctGastos(f.markup))}</td><td class="text-right text-gris">${esc(fmtPctGastos(f.markupFinal))}</td></tr>`).join('');
  pintarTramosCurva(tipo);
}

// Fraccionado: ganancia por tramo de peso en los costos de referencia (title = markup s/ neto y final).
function pintarTramosCurva(tipo) {
  const cont = tarjetaCurva(tipo).querySelector('.cv-tramos');
  if (!cont) return;
  const c = curvaEdit[tipo], tramos = (c.ajustesPeso || {}).tramosG || [];
  if (!tramos.length) { cont.innerHTML = ''; return; }
  const porTramo = tramos.map(t => filasLectura(c, tipo, t));
  cont.innerHTML = `<table class="w-full text-sm tabular-nums cfg-tabla">
    <caption class="text-left text-xs text-gris pb-1">Ganancia de la curva por tramo de peso (pasá el mouse para ver + conceptos y los markups)</caption>
    <thead><tr><th class="text-left pr-4">Costo neto/kg</th>${tramos.map(t => `<th class="text-right px-2 whitespace-nowrap">≤ ${esc(t)} g</th>`).join('')}</tr></thead>
    <tbody>${CURVA_COSTOS_EJEMPLO.map((costo, i) => `<tr class="border-t border-borde"><td class="pr-4 py-0.5">${esc(fmtCostoEje(costo))}</td>${porTramo.map(filas => {
      const f = filas[i];
      return `<td class="text-right px-2 whitespace-nowrap" title="+ conceptos ${esc(fmtPctGastos(f.ganancia))} · markup s/ neto ${esc(fmtPctGastos(f.markup))} · final ${esc(fmtPctGastos(f.markupFinal))}">${esc(fmtPctGastos(f.gananciaCurva))}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table>`;
}

// Estado guardado + aviso de márgenes propios (sobre los listados ya cargados, sin pedir nada).
function pintarEstadoCurva(tipo) {
  const card = tarjetaCurva(tipo), g = curvaGuardada[tipo];
  const fecha = g.ajustadaEl ? g.ajustadaEl.split('-').reverse().join('/') : null;
  card.querySelector('.cv-estado').textContent = fecha ? `Guardada · ajustada desde SIGA el ${fecha}${g.n != null ? ` con ${g.n} productos` : ''}`
    : 'Guardada (cargada a mano o migrada de las bandas/matriz)';
  const { n, total } = margenPropio(tipo, typeof almacenData !== 'undefined' ? almacenData : [], typeof fraccData !== 'undefined' ? fraccData : []);
  card.querySelector('.cv-aviso').textContent = total && n / total > 0.5 ? `${n} productos tienen ganancia propia y no siguen la curva.` : '';
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

// La llama cargarGanancia (precios_ganancia.js) con la config recién leída.
function renderConfigCurva(cfg) {
  const cg = cfg.curvaGanancia || {};
  for (const tipo of Object.keys(CURVA_TIPOS)) {
    const cont = document.getElementById(CURVA_TIPOS[tipo].cont);
    if (!cont) continue;
    const g = cg[tipo] || { a: 0, b: 0, pisoPct: 0, techoPct: 100, ajustadaEl: null, n: null };
    const tramosG = ((g.ajustesPeso || {}).tramosG) || CURVA_TRAMOS_DEFAULT;
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

// Vuelca la propuesta a los inputs (y los ajustes por peso a los tramos de la curva); marca la fecha y n.
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
  msgCurva(tipo, 'Curva propuesta cargada: revisala y tocá Guardar curva.', 'text-warn');
}

// Guarda y recarga la tab Ganancia: Fraccionado y Producción se recalculan al volver.
async function guardarCurva(tipo) {
  const c = leerCurva(tipo);
  const body = { a: c.a, b: c.b, pisoPct: c.pisoPct, techoPct: c.techoPct, ajustadaEl: c.ajustadaEl ?? null, n: c.n ?? null,
    ...(tipo === 'fraccionado' ? { ajustesPeso: c.ajustesPeso.tramosG.length ? c.ajustesPeso : null } : {}) };
  const btn = tarjetaCurva(tipo).querySelector('.cv-guardar');
  btn.disabled = true;
  msgCurva(tipo, 'Guardando…', 'text-ink/50');
  try {
    await putJson(`/api/precios/config/curva-ganancia/${tipo}`, body);
    fraccCargado = false; // precios_fraccionado.js: el standard de la curva cambió
    if (tipo === 'produccion') refrescarAlertasProduccion(); // precios_produccion.js
    await cargarGanancia(); // precios_ganancia.js: vuelve a dibujar esta tarjeta con lo guardado
    msgCurva(tipo, 'Guardado.', 'text-ok');
  } catch (e) {
    msgCurva(tipo, e.message, 'text-crit');
    btn.disabled = false;
  }
}
