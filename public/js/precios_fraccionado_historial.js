// ── Precios · Fraccionado: sugerido de min/kg desde el historial (spec 2026-10-29-precios-fraccionado-tiempos-historial-design, E2) ──
// Script clásico, antes de precios_config_fraccionado.js y precios_modal_fraccionado.js, que sólo lo llaman. Pide GET
// /api/precios/config/esquema/fraccionado/historial UNA vez para todo el módulo (cache en memoria; se invalida al guardar la tabla de
// tramos, que cambia los valores de producto y subrubro) y arma: los chips grises "Historial: …" con su "Usar" (rellena el campo, NO
// guarda) en la tabla de subrubros, la de tramos y el modal del granel; el resumen de cargas usadas y descartadas; y el panel "Ver
// distribución" de un subrubro (histograma de los min/kg por producto con su mediana y su valor actual, y los productos que más se
// alejan, cada uno con "Fijar"). Todo es min/kg a 1 kg, SIN el ajuste del tramo de peso (la fórmula lo suma por presentación).
// Globales: esc, numOrNull (precios_comun.js), getJson (precios_produccion.js), msgEsq (precios_config_esquema.js).
const API_HF = '/api/precios/config/esquema/fraccionado/historial';
const GRUPOS_HF = 10;       // barras del histograma, de ancho parejo entre el mínimo y el máximo
const ALEJADOS_HF = 5;      // productos que se listan con su "Fijar"
const MIN_MUESTRAS_HF = 5;  // sólo si la respuesta no trae minMuestras
// Motivos de descarte del servidor (cargas.descartes) con su texto; 180 = DURACION_MAX_MIN de lib/precios_fraccionado_historial.js.
const MOTIVOS_HF = [['act', 'marcadas ACT'], ['duracion', 'sin horario, de 0 minutos o de más de 180'], ['sinKilos', 'sin kilos'],
  ['sinGranel', 'sin un granel único'], ['sinPeso', 'sin peso en el nombre (los pedidos)']];
const AYUDA_HF = 'El chip gris "Historial" es la mediana del tiempo por 1 kg de las cargas de fraccionado, ya descontado el ajuste de la tabla de tramos guardada. '
  + '"Usar" completa el campo sin guardar: el valor se aplica con el Guardar de la tarjeta. Orden de uso: tramos, subrubros y, al final, pisar productos; '
  + 'si cambiás la tabla de tramos y la guardás, los sugeridos se recalculan. Los pedidos no entran en el cálculo: sin peso en el nombre no se puede ubicar el tramo.';
const AYUDA_DIST_HF = 'Cada barra agrupa los productos según su tiempo mediano por 1 kg. Los valores son por 1 kg y no incluyen el ajuste del tramo de peso, que se suma por presentación.';
const AYUDA_FIJAR_HF = 'Fijar pone ese valor como min/kg propio del producto: pisa al del subrubro (el ajuste del tramo se suma igual, por presentación) y se guarda en el momento.';

// ── Puros (test/precios_fraccionado_historial_ui.test.js) ──
const NUM_HF = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 });
const fmtMinHf = n => NUM_HF.format(n || 0); // `|| 0`: sin el "-0"
const fmtSignoHf = n => `${n > 0 ? '+' : ''}${fmtMinHf(n)}`;
const pluralHf = (n, uno, otros) => `${NUM_HF.format(n)} ${n === 1 ? uno : otros}`;
const textoCargasHf = n => pluralHf(n, 'carga', 'cargas');
const textoProductosHf = n => pluralHf(n, 'producto', 'productos');
const redondearHf = n => Math.round(n * 100) / 100;
const objetoHf = o => (o && typeof o === 'object' && !Array.isArray(o) ? o : {});
const entradaHf = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null);
const nombreProdHf = p => p.nombre || `PLU ${p.plu}`;

// La respuesta del servidor con todas sus partes (una parte que falte o venga rota no tira la pantalla).
function normalizarHistorialHf(j) {
  const c = objetoHf(j && j.cargas), d = objetoHf(c.descartes);
  return {
    cargas: { total: Number(c.total) || 0, usadas: Number(c.usadas) || 0, descartes: Object.fromEntries(MOTIVOS_HF.map(([k]) => [k, Number(d[k]) || 0])) },
    minMuestras: Number(j && j.minMuestras) || MIN_MUESTRAS_HF,
    productos: objetoHf(j && j.productos), subrubros: objetoHf(j && j.subrubros), tramos: Array.isArray(j && j.tramos) ? j.tramos : [],
    distribucion: objetoHf(j && j.distribucion),
  };
}
// El error de la petición, en castellano: el del servidor tal cual; de red o de formato, uno genérico.
const mensajeErrorHf = e => (e && e.message && !(e instanceof TypeError) && !(e instanceof SyntaxError) ? e.message : 'no se pudo conectar con el servidor');

// Chips: { texto, titulo, usar: valor sugerido | null (pocos datos: sin valor ni "Usar") } o null (sin entrada: sin chip).
const TITULO_VALOR_HF = 'Mediana del tiempo por 1 kg de las cargas del historial, ya sin el ajuste de la tabla de tramos guardada.';
const chipPocosHf = h => ({ texto: 'pocos datos', usar: null, titulo: `Menos de ${h.minMuestras} muestras: todavía no alcanza para sugerir un valor.` });
const sinValorHf = e => e.pocosDatos || e.mediana == null;
const rangoHf = e => `La mitad central de los valores va de ${fmtMinHf(e.p25)} a ${fmtMinHf(e.p75)}.`;
function chipSubrubroHf(h, id) {
  const s = h && entradaHf(h.subrubros, id);
  if (!s) return null;
  if (sinValorHf(s)) return chipPocosHf(h);
  return { texto: `Historial: ${fmtMinHf(s.mediana)} · ${textoCargasHf(s.n)} · ${textoProductosHf(s.productos)}`, usar: s.mediana,
    titulo: `${TITULO_VALOR_HF} Sale de la mediana de los productos del subrubro (uno cada uno). ${rangoHf(s)}` };
}
// hastaG = el "hasta" que tiene la fila ahora; guardadoG = el que tenía al pintarse (null en una fila nueva): si se editó sin guardar, ya no es el
// tramo del historial. La base vale 0 fijo: no se sugiere.
function chipTramoHf(h, hastaG, guardadoG) {
  if (!h || guardadoG == null || hastaG !== guardadoG) return null;
  const t = h.tramos.find(x => x.hastaG === hastaG);
  if (!t || t.base) return null;
  if (sinValorHf(t)) return chipPocosHf(h);
  return { texto: `Historial: ${fmtSignoHf(t.mediana)} · ${textoProductosHf(t.n)}`, usar: t.mediana,
    titulo: `Diferencia de minutos por kg contra el tramo base (mediana de los productos que se fraccionan en ambos). ${rangoHf(t)}` };
}
function chipProductoHf(h, plu) {
  const p = h && entradaHf(h.productos, String(plu));
  if (!p) return null;
  if (sinValorHf(p)) return chipPocosHf(h);
  return { texto: `Historial: ${fmtMinHf(p.mediana)} por 1 kg · ${textoCargasHf(p.n)}`, usar: p.mediana,
    titulo: `${TITULO_VALOR_HF} ${rangoHf(p)}` };
}

// Histograma: `grupos` barras de ancho parejo entre el mínimo y el máximo (el máximo cae en la última). Un solo valor, o todos iguales: una barra.
function histogramaHf(valores, grupos = GRUPOS_HF) {
  const v = valores.filter(Number.isFinite);
  if (!v.length) return { min: null, max: null, barras: [] };
  const min = Math.min(...v), max = Math.max(...v);
  if (min === max) return { min, max, barras: [{ desde: min, hasta: max, n: v.length }] };
  const ancho = (max - min) / grupos, grupoDe = x => Math.min(grupos - 1, Math.floor((x - min) / ancho));
  return { min, max, barras: Array.from({ length: grupos }, (_, i) => ({ desde: min + i * ancho, hasta: i === grupos - 1 ? max : min + (i + 1) * ancho,
    n: v.filter(x => grupoDe(x) === i).length })) };
}
// Dónde cae un valor sobre el eje del histograma (0 a 100 %); fuera del rango se recorta al borde y se marca.
function posicionHf(valor, { min, max }) {
  if (min === max) return { pct: 50, fuera: valor !== min };
  const pct = ((valor - min) / (max - min)) * 100;
  return { pct: Math.min(100, Math.max(0, pct)), fuera: pct < 0 || pct > 100 };
}
function medianaHf(valores) {
  const v = valores.filter(Number.isFinite).sort((a, b) => a - b), m = v.length >> 1;
  if (!v.length) return null;
  return v.length % 2 ? v[m] : redondearHf((v[m - 1] + v[m]) / 2);
}
// Los `k` productos de mayor distancia absoluta a `centro` (con su dif); los que están justo en el centro no cuentan. Empate: el de más cargas.
const masAlejadosHf = (lista, centro, k = ALEJADOS_HF) => lista.map(p => ({ ...p, dif: redondearHf(p.minKg - centro) })).filter(p => p.dif !== 0)
  .sort((a, b) => Math.abs(b.dif) - Math.abs(a.dif) || b.n - a.n || nombreProdHf(a).localeCompare(nombreProdHf(b), 'es')).slice(0, k);
// Lo que muestra el panel de un subrubro: sus productos, la mediana (la del servidor; con pocos datos, la de los productos mostrados) y el valor actual.
function modeloDistribucionHf(h, id, actual) {
  const lista = entradaHf(h.distribucion, id) || [], s = entradaHf(h.subrubros, id);
  const delServidor = s && !sinValorHf(s) ? s.mediana : null;
  return { lista, mediana: delServidor ?? medianaHf(lista.map(p => p.minKg)), pocosDatos: delServidor == null, actual: actual ?? null, minMuestras: h.minMuestras };
}

// ── HTML (puro) ──
const botonUsarHf = (valor, paraQue) => `<button type="button" class="hf-usar cfg-btn2" data-hf-valor="${esc(valor)}" aria-label="${esc(`Usar ${fmtMinHf(valor)} min/kg ${paraQue}`)}">Usar</button>`;
const htmlChipHf = (c, paraQue) => (!c ? '' : `<span class="hf-chip${c.usar == null ? ' hf-poco' : ''}" title="${esc(c.titulo)}">${esc(c.texto)}</span>${c.usar == null ? '' : botonUsarHf(c.usar, paraQue)}`);
const htmlFilaHf = html => (html ? `<div class="hf-fila">${html}</div>` : '');
function htmlSubrubroHf(h, id, nombre) {
  const lista = h && entradaHf(h.distribucion, id);
  const ver = lista && lista.length ? `<button type="button" class="hf-ver cfg-btn2" data-hf-ver="${esc(id)}" data-hf-nombre="${esc(nombre)}" aria-haspopup="dialog" aria-label="${esc(`Ver distribución de ${nombre}`)}">Ver distribución</button>` : '';
  return htmlFilaHf(htmlChipHf(chipSubrubroHf(h, id), `en ${nombre}`) + ver);
}
const htmlTramoHf = (h, hastaG, guardadoG) => htmlFilaHf(htmlChipHf(chipTramoHf(h, hastaG, guardadoG), `en el ajuste del tramo hasta ${hastaG} g`));
const htmlProductoHf = (h, plu) => htmlFilaHf(htmlChipHf(chipProductoHf(h, plu), 'como min/kg propio de este producto'));

// Barra: alto proporcional al grupo más grande (hasta 86 %: arriba queda lugar para su cantidad). Las vacías no se anuncian (están en la tabla).
function htmlBarraHf(b, maxN, uno) {
  if (!b.n) return '<div class="hf-barra" aria-hidden="true"></div>';
  const t = uno ? `${fmtMinHf(b.desde)} min/kg: ${textoProductosHf(b.n)}` : `De ${fmtMinHf(b.desde)} a ${fmtMinHf(b.hasta)} min/kg: ${textoProductosHf(b.n)}`;
  return `<div class="hf-barra" role="img" aria-label="${esc(t)}" title="${esc(t)}" style="--h:${Math.max(4, Math.round((b.n / maxN) * 86))}%"><span class="hf-n" aria-hidden="true">${b.n}</span><span class="hf-rect"></span></div>`;
}
function htmlMarcaHf(clase, texto, { pct }) {
  const lado = pct < 18 ? ' hf-izq' : pct > 82 ? ' hf-der' : '';
  return `<div class="hf-marca ${clase}${lado}" style="left:${+pct.toFixed(2)}%"><span class="hf-tag">${esc(texto)}</span></div>`;
}
function htmlHistogramaHf(hist, { mediana, actual }) {
  if (!hist.barras.length) return '<p class="hf-vacio-d">Sin productos con historial en este subrubro.</p>';
  const uno = hist.barras.length === 1, maxN = Math.max(...hist.barras.map(b => b.n)), n = hist.barras.reduce((s, b) => s + b.n, 0);
  const pa = actual == null ? null : posicionHf(actual, hist);
  const marcas = (mediana == null ? '' : htmlMarcaHf('hf-mediana', `Mediana ${fmtMinHf(mediana)}`, posicionHf(mediana, hist)))
    + (pa ? htmlMarcaHf('hf-actual', `Valor actual ${fmtMinHf(actual)}${pa.fuera ? ' (fuera del rango)' : ''}`, pa) : '');
  const aria = `Histograma de min por kg de ${textoProductosHf(n)}, de ${fmtMinHf(hist.min)} a ${fmtMinHf(hist.max)}. ${mediana == null ? '' : `Mediana ${fmtMinHf(mediana)}. `}`
    + `${actual == null ? 'Sin valor actual guardado. ' : `Valor actual ${fmtMinHf(actual)}. `}Los mismos datos están en la tabla de abajo.`;
  return `<div class="hf-pista" role="group" aria-label="${esc(aria)}">${marcas}<div class="hf-barras${uno ? ' hf-uno' : ''}">${hist.barras.map(b => htmlBarraHf(b, maxN, uno)).join('')}</div></div>
    <div class="hf-eje${uno ? ' hf-eje-uno' : ''}"><span>${fmtMinHf(hist.min)}</span>${uno ? '' : `<span>${fmtMinHf(hist.max)}</span>`}</div>`;
}
// La misma información que las barras, en una tabla (lector de pantalla y números exactos).
function htmlTablaHistoHf(hist) {
  if (!hist.barras.length) return '';
  const uno = hist.barras.length === 1;
  const filas = hist.barras.map(b => `<tr><th scope="row" class="text-left font-normal">${esc(uno ? fmtMinHf(b.desde) : `${fmtMinHf(b.desde)} a ${fmtMinHf(b.hasta)}`)}</th><td class="text-right tabular-nums">${b.n}</td></tr>`).join('');
  return `<details class="hf-tabla"><summary>Ver los datos en una tabla</summary><table class="cfg-tabla fr-filas w-full"><caption class="sr-only">Productos por rango de min por kg (por 1 kg)</caption>
    <thead><tr><th scope="col" class="text-left">Rango (min/kg)</th><th scope="col" class="text-right">Productos</th></tr></thead><tbody>${filas}</tbody></table></details>`;
}
const htmlFilaAlejadoHf = p => `<tr data-plu="${esc(p.plu)}"><th scope="row" class="text-left font-normal">${esc(nombreProdHf(p))}<span class="hf-plu">PLU ${esc(p.plu)}</span></th>
  <td class="text-right tabular-nums">${NUM_HF.format(p.n)}</td><td class="text-right tabular-nums">${fmtMinHf(p.minKg)}</td><td class="text-right tabular-nums">${fmtSignoHf(p.dif)}</td>
  <td class="text-right"><button type="button" class="hf-fijar cfg-btn2" data-plu="${esc(p.plu)}" data-hf-valor="${esc(p.minKg)}" data-hf-nombre="${esc(nombreProdHf(p))}"
    aria-label="${esc(`Fijar ${fmtMinHf(p.minKg)} min/kg como propio de ${nombreProdHf(p)}`)}">Fijar</button></td></tr>`;
function htmlAlejadosHf(lista, mediana) {
  if (!lista.length) return '';
  const ale = masAlejadosHf(lista, mediana);
  const cuerpo = ale.length ? `<table class="cfg-tabla fr-filas w-full hf-alejados"><thead><tr><th scope="col" class="text-left">Producto</th><th scope="col" class="text-right">Cargas</th>
      <th scope="col" class="text-right">Min/kg (por 1 kg)</th><th scope="col" class="text-right">Contra la mediana</th><th scope="col"><span class="sr-only">Fijar</span></th></tr></thead>
    <tbody>${ale.map(htmlFilaAlejadoHf).join('')}</tbody></table>` : '<p class="text-sm text-gris">Todos los productos están en la mediana: no hay ninguno para fijar.</p>';
  return `<h4 class="hf-d-h">Los que más se alejan de la mediana</h4><p class="cfg-ayuda">${AYUDA_FIJAR_HF}</p>${cuerpo}`;
}
function htmlDistribucionHf(m) {
  const hist = histogramaHf(m.lista.map(p => p.minKg));
  const actual = m.actual == null ? '<b>sin valor</b>' : `<b>${fmtMinHf(m.actual)}</b> min/kg`;
  const poco = m.pocosDatos ? `<p class="hf-d-aviso">Pocos datos: con menos de ${m.minMuestras} muestras no se sugiere un valor para el subrubro; la mediana es sólo de los productos que se muestran.</p>` : '';
  return `<p class="cfg-ayuda">${AYUDA_DIST_HF}</p>
    <p class="hf-d-res"><span><b>${textoProductosHf(m.lista.length)}</b> con historial</span>${m.mediana == null ? '' : `<span>Mediana: <b>${fmtMinHf(m.mediana)}</b> min/kg</span>`}
      <span>Valor actual guardado: ${actual}</span></p>${poco}
    ${htmlHistogramaHf(hist, m)}${htmlTablaHistoHf(hist)}${htmlAlejadosHf(m.lista, m.mediana)}
    <p id="hfDistMsg" class="text-sm mt-3" role="status" aria-live="polite"></p>`;
}

// Estado de la carga: una línea (leyendo / error con "Reintentar" / usadas X de Y con el detalle de lo descartado y "Actualizar") y la ayuda.
function htmlLineaEstadoHf({ fase, datos, error }) {
  if (fase === 'error') return `No se pudo leer el historial (${esc(error)}): la configuración sigue andando, sin sugeridos. <button type="button" class="hf-recargar cfg-btn2">Reintentar</button>`;
  if (fase !== 'ok') return '<span class="spin"></span> Leyendo el historial de fraccionado…';
  const c = datos.cargas;
  if (!c.total) return 'Todavía no hay cargas en el historial de fraccionado: no hay sugeridos. <button type="button" class="hf-recargar cfg-btn2">Actualizar</button>';
  const motivos = MOTIVOS_HF.map(([k, txt]) => `<li>${esc(txt)}: <b>${NUM_HF.format(c.descartes[k])}</b></li>`).join('');
  return `<span>Historial de fraccionado: <b>usadas ${NUM_HF.format(c.usadas)} de ${textoCargasHf(c.total)}</b></span>`
    + `<details class="hf-desc"><summary>qué se descartó</summary><ul>${motivos}</ul></details><button type="button" class="hf-recargar cfg-btn2">Actualizar</button>`;
}
const htmlEstadoHf = est => `<div class="hf-linea" role="status" aria-live="polite">${htmlLineaEstadoHf(est)}</div><p class="hf-ayuda">${AYUDA_HF}</p>`;

// ── Carga y cache: una sola petición para todo el módulo ──
let estadoHf = { fase: 'vacio', datos: null, error: null }; // fase: vacio | cargando | ok | error (se reemplaza entero, no se muta)
let promesaHf = null;
const historialHf = () => estadoHf.datos;
const estadoHistorialHf = () => estadoHf;
async function pedirHf() {
  try { return { fase: 'ok', datos: normalizarHistorialHf(await getJson(API_HF)), error: null }; }
  catch (e) { return { fase: 'error', datos: null, error: mensajeErrorHf(e) }; }
}
// Tras guardar los tramos: los valores de producto y subrubro restan el ajuste de la tabla guardada, así que hay que pedirlos de nuevo.
function invalidarHistorialHf() { promesaHf = null; estadoHf = { fase: 'vacio', datos: null, error: null }; }
// → Promise (no rechaza: el error queda en el estado). alCambiar se llama al empezar a leer y al terminar (ok o error). Un error no queda en el
// cache: la próxima vez se reintenta. Una respuesta de antes de invalidar no vale.
function cargarHistorialHf(alCambiar = () => {}) {
  if (!promesaHf) {
    estadoHf = { fase: 'cargando', datos: null, error: null };
    const mia = pedirHf().then(est => {
      if (promesaHf !== mia) return;
      estadoHf = est;
      if (est.fase === 'error') promesaHf = null;
    });
    promesaHf = mia;
    alCambiar();
  }
  return promesaHf.then(alCambiar);
}

// ── DOM ──
const avisarHf = (el, texto, cls = 'text-gris', margen = 'mt-3') => { if (el) { el.className = `text-sm ${margen} ${cls}`; el.textContent = texto; } };
// "Usar": rellena el campo y avisa como si se hubiera tipeado (marca la tarjeta "sin guardar"). No guarda nada: el valor se guarda con el Guardar de siempre.
function usarEnInputHf(input, valor) {
  input.value = String(valor);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}
function usarHf(boton, card) {
  usarEnInputHf(boton.closest('tr').querySelector('input[data-id],input[data-k="minKg"]'), Number(boton.dataset.hfValor));
  msgEsq(card.querySelector('.esq-msg'), 'Valor del historial puesto en el campo: falta guardar la tarjeta para aplicarlo.', 'text-warn');
}
function pintarSubrubrosHf(card) {
  if (!card) return;
  const h = historialHf();
  card.classList.toggle('hf-sin', !h); // sin historial la columna entera no se muestra
  card.querySelectorAll('td[data-hf-sub]').forEach(td => { td.innerHTML = htmlSubrubroHf(h, td.dataset.hfSub, td.dataset.hfNombre); });
}
function pintarTramosHf(card) {
  if (!card) return;
  const h = historialHf();
  card.classList.toggle('hf-sin', !h);
  card.querySelectorAll('tbody tr').forEach(tr => {
    const hasta = numOrNull(tr.querySelector('[data-k="hastaG"]').value), guardado = tr.dataset.guardado === undefined ? null : Number(tr.dataset.guardado);
    const slot = tr.querySelector('[data-hf-tramo]');
    if (slot) slot.innerHTML = htmlTramoHf(h, hasta, guardado);
  });
}
// acciones = { actual: id → min/kg guardado del subrubro | null, fijar: (plu, minKg) → Promise } (las pone precios_config_fraccionado.js).
function conectarSubrubrosHf(card, acciones) {
  pintarSubrubrosHf(card);
  card.onclick = e => {
    const usar = e.target.closest('.hf-usar'), ver = e.target.closest('.hf-ver');
    if (usar) usarHf(usar, card);
    else if (ver) abrirDistribucionHf({ id: ver.dataset.hfVer, nombre: ver.dataset.hfNombre, ...acciones });
  };
}
// La tarjeta se pinta desde lo guardado: el "hasta" de cada fila es el guardado (las filas agregadas después no lo tienen).
function conectarTramosHf(card) {
  card.querySelectorAll('tbody tr').forEach(tr => { tr.dataset.guardado = tr.querySelector('[data-k="hastaG"]').value; });
  pintarTramosHf(card);
  card.onclick = e => { const usar = e.target.closest('.hf-usar'); if (usar) usarHf(usar, card); };
}
// Modal del granel: el chip de ESE producto junto a su min/kg propio. slot = donde va el chip, input = su "Min por kg", msg = su línea de estado.
function conectarProductoHf({ slot, input, plu, msg }) {
  const pintar = () => { if (slot.isConnected !== false) slot.innerHTML = htmlProductoHf(historialHf(), plu); };
  slot.onclick = e => {
    const usar = e.target.closest('.hf-usar');
    if (!usar) return;
    usarEnInputHf(input, Number(usar.dataset.hfValor));
    avisarHf(msg, 'Valor del historial puesto en el campo: falta Guardar para aplicarlo.', 'text-warn', 'mt-1');
  };
  pintar();
  if (!historialHf()) cargarHistorialHf(pintar);
}
function pintarEstadoHf(el, alRecargar) {
  if (!el) return;
  el.innerHTML = htmlEstadoHf(estadoHf);
  const b = el.querySelector('.hf-recargar');
  if (b) b.onclick = alRecargar;
}

// Panel "Ver distribución" (#dlgHist en precios.html, un <dialog> modal: foco atrapado, Esc cierra).
function abrirDistribucionHf({ id, nombre, actual, fijar }) {
  const d = document.getElementById('dlgHist'), h = historialHf();
  if (!d || !h) return;
  d.querySelector('.hf-dlg-titulo').textContent = `Distribución de min/kg · ${nombre}`;
  const cuerpo = d.querySelector('.hf-dlg-cuerpo');
  cuerpo.innerHTML = htmlDistribucionHf(modeloDistribucionHf(h, id, actual(id)));
  cuerpo.onclick = e => { const b = e.target.closest('.hf-fijar'); if (b) fijarDesdeHf(b, fijar); };
  d.querySelector('.hf-dlg-cerrar').onclick = () => d.close();
  d.showModal();
}
// "Fijar": pisa el min/kg propio del producto con su valor del historial (guarda ya) y lo cuenta en el mensaje de estado del panel.
async function fijarDesdeHf(boton, fijar) {
  const msg = document.getElementById('hfDistMsg'), { plu, hfNombre: nombre } = boton.dataset, valor = Number(boton.dataset.hfValor);
  boton.disabled = true;
  avisarHf(msg, 'Guardando…');
  try { await fijar(plu, valor); } catch (e) {
    boton.disabled = false;
    avisarHf(msg, `No se pudo fijar: ${e.message}`, 'text-crit');
    return;
  }
  boton.textContent = '✓ Fijado';
  boton.classList.add('hf-fijado');
  boton.setAttribute('aria-label', `Fijado: ${nombre} con ${fmtMinHf(valor)} min/kg propio`);
  avisarHf(msg, `Listo: ${nombre} quedó con ${fmtMinHf(valor)} min/kg propio (por 1 kg, sin el ajuste del tramo).`, 'text-ok');
}

if (typeof module === 'object' && module.exports) module.exports = { normalizarHistorialHf, mensajeErrorHf, fmtMinHf, fmtSignoHf, textoCargasHf, textoProductosHf,
  chipSubrubroHf, chipTramoHf, chipProductoHf, histogramaHf, posicionHf, medianaHf, masAlejadosHf, modeloDistribucionHf, htmlSubrubroHf, htmlTramoHf, htmlProductoHf,
  htmlDistribucionHf, htmlEstadoHf, invalidarHistorialHf, cargarHistorialHf, historialHf, estadoHistorialHf, usarEnInputHf, pintarSubrubrosHf, pintarTramosHf,
  conectarSubrubrosHf, conectarTramosHf, conectarProductoHf, fijarDesdeHf };
