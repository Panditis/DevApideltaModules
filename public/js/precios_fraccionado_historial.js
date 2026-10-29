// ── Precios · Fraccionado: sugerido de min/kg desde el historial (spec 2026-10-29-precios-fraccionado-tiempos-historial-design, E2) ──
// Script clásico, antes de precios_config_fraccionado.js y precios_modal_fraccionado.js, que sólo lo llaman. Pide GET
// /api/precios/config/esquema/fraccionado/historial UNA vez para todo el módulo (cache en memoria; se invalida al guardar la tabla de
// tramos, que cambia los valores de producto y subrubro) y arma: los chips grises "Historial: …" con su "Usar" (rellena el campo, NO
// guarda) en la tabla de subrubros, la de tramos y el modal del granel; el resumen de cargas usadas y descartadas; y el panel "Ver
// distribución" de un subrubro (histograma de los min/kg por producto con su mediana y su valor actual, y los productos que más se
// alejan, cada uno con "Fijar"). Todo es min/kg a 1 kg, SIN el ajuste del tramo de peso (la fórmula lo suma por presentación).
// Globales: esc, numOrNull (precios_comun.js), getJson (precios_produccion.js), msgEsq (precios_config_esquema.js).
const API_HF = '/api/precios/config/esquema/fraccionado/historial';
const MAX_BARRAS_HF = 12;   // barras del histograma como mucho (la de atípicos incluida); el paso redondo se elige para que entren
const MIN_BARRAS_HF = 6;    // barras que se buscan como mínimo (si el rango lo permite con un paso redondo)
const FACTOR_ATIPICO_HF = 3; // atípico: más de Q3 + 3 × IQR de los min/kg de los productos del subrubro
const GUIAS_Y_HF = 4;       // tramos de la escala de productos (eje Y) como mucho
const PRESUPUESTO_EJE_HF = 70; // caracteres que entran en el eje X: con más (número + espacio por marca) se rotula uno de cada dos bordes
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

// ── Histograma: bordes redondos, atípicos agrupados, escala de productos ──
// Pasos redondos (1, 2, 2,5, 5 × 10^k) desde 0,1: 0,1 0,2 0,25 0,5 1 2 2,5 5 10 20 25 50 …; para la escala de productos, enteros.
const PASOS_HF = [-1, 0, 1, 2, 3, 4, 5].flatMap(k => [1, 2, 2.5, 5].map(m => Number((m * 10 ** k).toPrecision(12))));
const PASOS_FINOS_HF = [0.05, 0.02, 0.01]; // sólo si con 0,1 el rango es tan chico que saldrían menos de MIN_BARRAS_HF barras (ej. 0,34 a 0,6)
const PASOS_Y_HF = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
const aproxHf = x => Math.round(x * 1e9) / 1e9; // 0,3 / 0,1 da 2,9999999999999996: se redondea antes de floor y ceil
const indiceHf = (x, paso) => Math.floor(aproxHf(x / paso)); // nº del borde a cuya derecha cae x (justo en un borde: la barra de la derecha)
const bordeHf = (i, paso) => Math.round(i * paso * 100) / 100; // el borde nº i, sin "0,30000000000000004"
const decimalesHf = paso => (String(paso).split('.')[1] || '').length;
const cuantasHf = (min, max, paso) => Math.ceil(aproxHf(max / paso)) - indiceHf(min, paso);
// El paso redondo más chico con el que [min, max] entra en `tope` barras (bordes en múltiplos del paso). Si aun el menor (0,1) deja pocas barras, uno más fino.
function pasoHf(min, max, tope) {
  const base = PASOS_HF.find(p => cuantasHf(min, max, p) <= tope) ?? PASOS_HF[PASOS_HF.length - 1];
  if (base !== PASOS_HF[0] || cuantasHf(min, max, base) >= MIN_BARRAS_HF) return base;
  return PASOS_FINOS_HF.find(p => cuantasHf(min, max, p) >= MIN_BARRAS_HF) ?? PASOS_FINOS_HF[PASOS_FINOS_HF.length - 1];
}
// Eje X hasta `techo`: { desde, hasta, paso, dec, n } con n barras comunes entre dos bordes redondos (desde ≤ min, hasta ≥ techo).
function ejeHf(min, techo, tope) {
  const paso = pasoHf(min, techo, tope), i0 = indiceHf(min, paso), i1 = Math.max(i0 + 1, Math.ceil(aproxHf(techo / paso)));
  return { desde: bordeHf(i0, paso), hasta: bordeHf(i1, paso), paso, dec: decimalesHf(paso), n: i1 - i0 };
}
const cuantilHf = (orden, q) => {
  const pos = (orden.length - 1) * q, i = Math.floor(pos), j = Math.min(i + 1, orden.length - 1);
  return orden[i] + (orden[j] - orden[i]) * (pos - i);
};
// Más de Q3 + 3 × IQR es atípico. `orden`: valores ya ordenados. Sin dispersión (IQR 0) no hay nada que agrupar: null.
function topeAtipicosHf(orden) {
  const q3 = cuantilHf(orden, 0.75), iqr = q3 - cuantilHf(orden, 0.25);
  return iqr > 0 ? q3 + FACTOR_ATIPICO_HF * iqr : null;
}
// Las barras comunes del eje y, si `mas`, una última desde el borde `hasta` que agrupa todo lo que lo alcanza (con su máximo real).
function barrasHf(v, eje, mas) {
  const i0 = indiceHf(eje.desde, eje.paso), total = eje.n + (mas ? 1 : 0);
  const columnas = v.map(x => Math.min(total - 1, indiceHf(x, eje.paso) - i0)); // el máximo del eje (justo en el borde final) queda en la última
  const cuantos = k => columnas.filter(c => c === k).length;
  const comunes = Array.from({ length: eje.n }, (_, k) => ({ desde: bordeHf(i0 + k, eje.paso), hasta: bordeHf(i0 + k + 1, eje.paso), n: cuantos(k) }));
  return mas ? [...comunes, { desde: eje.hasta, hasta: null, n: cuantos(eje.n), mas: true, max: v[v.length - 1] }] : comunes;
}
// → { min, max (de los datos), uno, eje: { desde, hasta, paso, dec, n }, barras: [{ desde, hasta, n, mas?, max? }] }. Entre 6 y 12 barras de ancho parejo con
// bordes redondos. Con atípicos (hay valores ≥ el borde redondo que sigue a Q3 + 3 × IQR) el eje llega hasta ese borde y la última barra los agrupa.
// Un solo valor, o todos iguales: una barra (`uno`), sin paso.
function histogramaHf(valores) {
  const v = valores.filter(Number.isFinite).sort((a, b) => a - b), min = v[0], max = v[v.length - 1];
  if (!v.length) return { min: null, max: null, uno: false, eje: null, barras: [] };
  if (min === max) return { min, max, uno: true, eje: { desde: min, hasta: max, paso: null, dec: 0, n: 1 }, barras: [{ desde: min, hasta: max, n: v.length }] };
  const tope = topeAtipicosHf(v), conMas = tope == null ? null : ejeHf(min, tope, MAX_BARRAS_HF - 1);
  const mas = conMas != null && max >= conMas.hasta, eje = mas ? conMas : ejeHf(min, max, MAX_BARRAS_HF);
  return { min, max, uno: false, eje, barras: barrasHf(v, eje, mas) };
}
// Dónde cae un valor sobre el eje del histograma (0 a 100 %, en barras de ancho parejo); fuera del eje se recorta al borde y se marca. Lo que alcanza
// el borde de la barra agrupada queda en el centro de esa barra (no es "fuera": está en ese grupo).
function posicionHf(valor, { eje, barras }) {
  if (eje.paso == null) return { pct: 50, fuera: valor !== eje.desde };
  const ancho = 100 / barras.length;
  if (valor < eje.desde) return { pct: 0, fuera: true };
  if (barras[barras.length - 1].mas && valor >= eje.hasta) return { pct: 100 - ancho / 2, fuera: false };
  const pct = ((valor - eje.desde) / eje.paso) * ancho;
  return { pct: Math.min(100, pct), fuera: valor > eje.hasta };
}
// Marcas del eje X: un rótulo en cada borde de barra, con los decimales justos del paso ("≥ X" en el borde de la barra agrupada). Si no entran
// (PRESUPUESTO_EJE_HF), uno de cada dos, contando desde la agrupada si hay. Un solo valor: su número, al centro.
const fmtEjeHf = (x, dec) => x.toLocaleString('es-AR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
function marcasEjeHf({ barras, eje, uno }) {
  if (uno) return [{ pct: 50, texto: fmtMinHf(eje.desde) }];
  const n = barras.length, ultima = barras[n - 1];
  const bordes = barras.map((b, i) => ({ pct: (i * 100) / n, valor: b.desde, mas: b.mas === true }));
  const marcas = (ultima.mas ? bordes : [...bordes, { pct: 100, valor: ultima.hasta, mas: false }])
    .map(b => ({ pct: b.pct, texto: `${b.mas ? '≥ ' : ''}${fmtEjeHf(b.valor, eje.dec)}` }));
  const largo = Math.max(...marcas.map(m => m.texto.length)), salto = marcas.length * (largo + 1) > PRESUPUESTO_EJE_HF ? 2 : 1;
  const ancla = ultima.mas ? marcas.length - 1 : 0;
  return marcas.filter((_, i) => Math.abs(i - ancla) % salto === 0);
}
// Escala del eje Y (productos por barra): paso entero redondo con a lo sumo GUIAS_Y_HF tramos hasta cubrir el mayor.
function ejeYHf(maxN) {
  const paso = PASOS_Y_HF.find(p => Math.ceil(maxN / p) <= GUIAS_Y_HF) ?? PASOS_Y_HF[PASOS_Y_HF.length - 1], tope = Math.ceil(maxN / paso) * paso;
  return { paso, tope, guias: Array.from({ length: tope / paso + 1 }, (_, i) => i * paso) };
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

// El rango de una barra, igual en el texto de la barra y en la tabla: "1,5 a 2", "11 o más" (la agrupada) o el valor solo (una barra única).
const rotuloRangoHf = (b, uno) => (uno ? fmtMinHf(b.desde) : b.mas ? `${fmtMinHf(b.desde)} o más` : `${fmtMinHf(b.desde)} a ${fmtMinHf(b.hasta)}`);
const textoBarraHf = (b, uno) => `${uno || b.mas ? '' : 'de '}${rotuloRangoHf(b, uno)} min por kg: ${textoProductosHf(b.n)}${b.mas ? `, el mayor de ${fmtMinHf(b.max)}` : ''}`;
const alturaBarraHf = (n, tope) => Math.max(3, Math.round((n / tope) * 1000) / 10); // % del alto; un mínimo para que 1 producto se vea
// Barra: columna de ancho parejo (su rango es el de los bordes del eje) con su cantidad arriba. Las vacías no se anuncian (están en la tabla).
function htmlBarraHf(b, tope, uno) {
  const clase = `hf-barra${b.mas ? ' hf-mas' : ''}`;
  if (!b.n) return `<div class="${clase}" aria-hidden="true"></div>`;
  const t = textoBarraHf(b, uno);
  return `<div class="${clase}" role="img" aria-label="${esc(t)}" title="${esc(t)}" style="--h:${alturaBarraHf(b.n, tope)}%"><span class="hf-n" aria-hidden="true">${b.n}</span><span class="hf-rect"></span></div>`;
}
function htmlMarcaHf(clase, texto, { pct }) {
  const lado = pct < 18 ? ' hf-izq' : pct > 82 ? ' hf-der' : '';
  return `<div class="hf-marca ${clase}${lado}" style="left:${+pct.toFixed(2)}%"><span class="hf-tag">${esc(texto)}</span></div>`;
}
// Guías horizontales finas con el número de productos a la izquierda (decorativas: la cantidad de cada barra está en su rótulo y en la tabla).
const htmlGuiasHf = y => y.guias.map(g => `<div class="hf-guia" aria-hidden="true" style="bottom:${+((g / y.tope) * 100).toFixed(2)}%"><span class="hf-gn">${NUM_HF.format(g)}</span></div>`).join('');
const htmlEjeXHf = hist => `<div class="hf-eje" aria-hidden="true">${marcasEjeHf(hist).map(m => `<span class="hf-tick" style="left:${+m.pct.toFixed(2)}%">${esc(m.texto)}</span>`).join('')}</div>`;
function htmlNotaMasHf({ barras }) {
  const m = barras[barras.length - 1];
  if (!m.mas) return '';
  return `<p class="hf-nota">${textoProductosHf(m.n)} ${m.n === 1 ? 'queda muy lejos' : 'quedan muy lejos'} del resto y se ${m.n === 1 ? 'muestra' : 'agrupan'} en la última barra, de ${fmtMinHf(m.desde)} min/kg o más (el mayor: ${fmtMinHf(m.max)}).</p>`;
}
function htmlHistogramaHf(hist, { mediana, actual }) {
  if (!hist.barras.length) return '<p class="hf-vacio-d">Sin productos con historial en este subrubro.</p>';
  const y = ejeYHf(Math.max(...hist.barras.map(b => b.n))), n = hist.barras.reduce((s, b) => s + b.n, 0);
  const pa = actual == null ? null : posicionHf(actual, hist);
  const marcas = (mediana == null ? '' : htmlMarcaHf('hf-mediana', `Mediana ${fmtMinHf(mediana)}`, posicionHf(mediana, hist)))
    + (pa ? htmlMarcaHf('hf-actual', `Valor actual ${fmtMinHf(actual)}${pa.fuera ? ' (fuera del rango)' : ''}`, pa) : '');
  const aria = `Histograma de min por kg de ${textoProductosHf(n)}, de ${fmtMinHf(hist.min)} a ${fmtMinHf(hist.max)}. ${mediana == null ? '' : `Mediana ${fmtMinHf(mediana)}. `}`
    + `${actual == null ? 'Sin valor actual guardado. ' : `Valor actual ${fmtMinHf(actual)}. `}Los mismos datos están en la tabla de abajo.`;
  return `<div class="hf-grafico" role="group" aria-label="${esc(aria)}"><div class="hf-pista">${marcas}<span class="hf-yt" aria-hidden="true">Productos</span>
    <div class="hf-barras${hist.uno ? ' hf-uno' : ''}">${htmlGuiasHf(y)}${hist.barras.map(b => htmlBarraHf(b, y.tope, hist.uno)).join('')}</div></div>
    ${htmlEjeXHf(hist)}<p class="hf-xt" aria-hidden="true">Minutos por 1 kg</p></div>${htmlNotaMasHf(hist)}`;
}
// La misma información que las barras, con los mismos rangos, en una tabla (lector de pantalla y números exactos).
function htmlTablaHistoHf(hist) {
  if (!hist.barras.length) return '';
  const rotulo = b => `${rotuloRangoHf(b, hist.uno)}${b.mas ? ` (el mayor: ${fmtMinHf(b.max)})` : ''}`;
  const filas = hist.barras.map(b => `<tr><th scope="row" class="text-left font-normal">${esc(rotulo(b))}</th><td class="text-right tabular-nums">${b.n}</td></tr>`).join('');
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
  chipSubrubroHf, chipTramoHf, chipProductoHf, histogramaHf, topeAtipicosHf, posicionHf, marcasEjeHf, ejeYHf, medianaHf, masAlejadosHf, modeloDistribucionHf, htmlSubrubroHf, htmlTramoHf, htmlProductoHf,
  htmlDistribucionHf, htmlEstadoHf, invalidarHistorialHf, cargarHistorialHf, historialHf, estadoHistorialHf, usarEnInputHf, pintarSubrubrosHf, pintarTramosHf,
  conectarSubrubrosHf, conectarTramosHf, conectarProductoHf, fijarDesdeHf };
