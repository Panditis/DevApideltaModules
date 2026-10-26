// ── Precios · modal de Fraccionado: dos tarjetas lado a lado, costo real por presentación y máquina del granel (spec 2026-10-21-precios-fraccionado-costeo-design §9.3) ──
// Script clásico después de precios_modal_esquema.js y precios_config_fraccionado.js. pintarModalEsquema le deja el pintado
// (pintarModalFraccionadoMd) y conectarModalEsquema lo conecta (conectarModalFraccionadoMd). Dos tarjetas (#mDetCaja y #mDetDer):
//  · izquierda = configuración del granel: costo elegido (tarjetas), costo del granel (costo manual, costos extra, máquina), cómo
//    se conforma el costo y el precio por presentación (mercadería + insumos + mano de obra + máquina), margen del producto y
//    estado. Todo salvo las tarjetas y el estado va sólo con precios-config (sin él el server no manda el desglose ni los extras).
//  · derecha = precios de las presentaciones (htmlPreciosFraccMd, bajo el título "Precios de las presentaciones" y el subtítulo "por kg · con <fuente>"): vigente, sugerido con la fuente elegida, Δ $ y Δ %, por canal.
// Elegir un costo o guardar un margen repinta el modal entero (guardarOpcionMd / guardarCostoEsq): la tarjeta derecha siempre
// refleja lo elegido a la izquierda. La facilidad y el tiempo son los del subrubro del granel y los insumos los del peso de la
// presentación (Configuración › Costeo Fraccionado, precios_config_fraccionado.js): acá se ven. Globales: esc, fmtMoney, fmtFechaPrecio,
// fmtPct, claseDelta (precios_comun.js), mdEsq, mdFuente, mdDetalle, guardarCostoEsq, htmlPasos, htmlResumenMd, htmlAvisoMd,
// htmlOpcionesCosto, htmlMargenProductoMd, htmlEdicionCostos, htmlDesgloseEsq, filasCanales, fmtSug, pesosMd, textoFuenteMd (precios_modal_esquema.js), API_FR
// (precios_config_fraccionado.js), getJson (precios_produccion.js).
// El bloque "Estado" del granel (activo / inactivo / automático, spec 2026-10-26 §4) lo ve cualquier usuario de Precios:
// globales guardarActivoManual, conActivoManual, renderListado (precios_listados.js).
const NODE_FR_MD = typeof module === 'object' && module.exports;
const FMT_FR_MD = NODE_FR_MD ? require('./precios_comun.js') : { esc, fmtFechaPrecio, fmtPct, claseDelta };
const { esc: ESC_FR_MD, fmtFechaPrecio: FECHA_FR_MD } = FMT_FR_MD;
const ESQ_FR_MD = NODE_FR_MD ? require('./precios_modal_esquema.js') : { TIPO_CANAL, pctMd, avisosCanalMd, filasCanales, fmtSug, pesosMd, textoFuenteMd };
const ACT_FR_MD = NODE_FR_MD ? require('./precios_listados.js') : { textoMotivosActividad };
const FACIL_MD = { facil: 'Fácil', normal: 'Normal', dificil: 'Difícil' };
const TIEMPO_MD = { rapido: 'Rápido', normal: 'Normal', lento: 'Lento' };

// ── Puros (test/precios_modal_fraccionado.test.js) ──
// componentesCosto de una presentación (lib/precios_fraccionado_costo) por concepto. fuente = la elegida en el modal;
// mercaderiaKg = $/kg del granel con esa fuente (con sus costos extra); costoKg = el de la presentación con esa fuente; los
// dos también por unidad (× kg de la presentación; null sin costo o sin peso).
function resumenCosteoFraccMd(p, fuente, costosGranel) {
  const lineas = p.componentesCosto || [];
  const porUnidad = kgCosto => (kgCosto == null || !(p.pesoG > 0) ? null : Math.round(kgCosto * (p.pesoG / 1000) * 100) / 100);
  const insumos = lineas.filter(l => l.rol === 'insumo');
  const c = p.costeoPresentacion || {};
  return {
    insumos,
    subtotalInsumos: insumos.some(l => l.importe == null) ? null : Math.round(insumos.reduce((s, l) => s + l.importe, 0) * 100) / 100,
    mo: lineas.find(l => l.rol === 'mo') || null, maquina: lineas.find(l => l.rol === 'maquina') || null,
    porUnidad: c.porUnidad ?? null, extraKg: c.extraKg ?? null,
    mercaderiaKg: (costosGranel || {})[fuente] ?? null, costoKg: (p.costos || {})[fuente] ?? null,
    mercaderiaUnidad: porUnidad((costosGranel || {})[fuente]), costoUnidad: porUnidad((p.costos || {})[fuente]),
  };
}
// Select de la máquina del granel: "" = la de su subrubro (se muestra cuál); cada máquina = excepción del granel.
const opcionesMaquinaMd = (maquinas, actual, delSubrubro) => `<option value="">Del subrubro (${ESC_FR_MD(delSubrubro || 'sin máquina')})</option>${(maquinas || [])
  .map(m => `<option value="${ESC_FR_MD(m.id)}"${m.id === actual ? ' selected' : ''}>${ESC_FR_MD(m.nombre)}</option>`).join('')}`;
const minMd = n => new Intl.NumberFormat('es-AR', { maximumFractionDigits: 4 }).format(n);
// "base del tramo × factor del tiempo × factor de la facilidad = minutos" (c = costeoPresentacion); sin base (dato viejo) sólo los minutos.
const formulaMinutosMd = (c, minutos) => (c.minutosBase == null ? `${minMd(minutos)} min`
  : `${minMd(c.minutosBase)} × ${minMd(c.factorTiempo ?? 1)} (tiempo) × ${minMd(c.factorFacilidad ?? 1)} (facilidad) = ${minMd(minutos)} min`);
// Línea de MO o máquina sin importe: sin minutos (granel sin subrubro o subrubro sin tramos) o, con minutos, sin máquina.
const SIN_MINUTOS_MD = 'sin minutos (cargá los tiempos por peso del subrubro en Configuración › Costeo Fraccionado)';
function textoSinTiempoMd(rol, avisos) {
  const a = avisos || [];
  if (rol === 'maquina' && a.includes('sinMaquina') && !a.includes('sinSubrubro') && !a.includes('sinTramos')) return 'Máquina — sin asignar (ni del subrubro ni del granel)';
  return `${rol === 'maquina' ? 'Máquina' : 'Mano de obra'} — ${a.includes('sinSubrubro') ? 'sin minutos: el granel no tiene subrubro en SIGA' : SIN_MINUTOS_MD}`;
}
// "Normal · Lento": facilidad y tiempo del subrubro con que se costeó la presentación (c = costeoPresentacion).
const textoElegidoMd = c => `${FACIL_MD[(c || {}).facilidad] || 'sin facilidad'} · ${TIEMPO_MD[(c || {}).tiempo] || 'sin tiempo'}`;

// ── Estado del granel en el listado: activo / inactivo fijado a mano, o automático (movimientos de los últimos 6 meses) ──
// Valor del <select> y activoManual del server (null = automático).
const valorSelectActivoMd = f => (f.activoManual === true ? 'activo' : f.activoManual === false ? 'inactivo' : 'auto');
const activoManualDeValorMd = v => (v === 'activo' ? true : v === 'inactivo' ? false : null);
// Opción "Automático": lo que decidiría el automático hoy (los motivos van aparte, en lineasEstadoMd: así el select no se ensancha).
const textoAutomaticoMd = f => (f.actividad ? `Automático (hoy: ${f.actividad.auto === 'inactivo' ? 'inactivo' : 'activo'})` : 'Automático (sin datos de actividad)');
const htmlOpcionesActivoMd = f => [['auto', textoAutomaticoMd(f)], ['activo', 'Activo'], ['inactivo', 'Inactivo']]
  .map(([v, t]) => `<option value="${v}"${v === valorSelectActivoMd(f) ? ' selected' : ''}>${ESC_FR_MD(t)}</option>`).join('');
// Renglones informativos: por qué el automático lo deja inactivo, último movimiento del granel y presentaciones con movimiento
// (movReciente true; null = sin datos y no cuenta).
function lineasEstadoMd(f) {
  const a = f.actividad;
  if (!a) return ['Sin datos de movimientos: no se pudo consultar SIGA, no se oculta por inactivo.'];
  const pres = f.presentaciones || [], con = pres.filter(p => p.movReciente === true);
  const motivos = a.auto === 'inactivo' ? ACT_FR_MD.textoMotivosActividad(a.motivos) : '';
  return [
    ...(motivos ? [`Inactivo en automático: ${motivos}.`] : []),
    `Último movimiento del granel: ${a.ultimoMovGranel ? FECHA_FR_MD(a.ultimoMovGranel) : 'ninguno en los últimos 6 meses'}.`,
    pres.length ? `Presentaciones con movimiento en los últimos 6 meses: ${con.length} de ${pres.length}${con.length ? ` (${con.map(p => p.nombre).join(', ')})` : ''}.`
      : 'Sin presentaciones en el listado.',
  ];
}
// Mensaje tras guardar (fila ya actualizada): cómo quedó y, si quedó inactivo, que el listado lo oculta.
const textoGuardadoActivoMd = f => `Guardado · ${f.activoManual == null ? 'automático' : 'fijado a mano'}: ${f.activo ? 'activo' : 'inactivo, el listado lo oculta salvo con "Ver inactivos"'}.`;
// Sin PLU (el grupo "sin granel") no hay estado que fijar. msg = HTML ya armado del estado (guardado / error).
function htmlEstadoActivoMd(f, msg = '') {
  if (f.plu == null) return '';
  const reefer = f.reefer === true ? ' <span class="md-sub">· REEFER: el listado lo oculta salvo con "Ver REEFER", sea cual sea su estado</span>' : '';
  return `<section id="mdAct" class="md-activo" aria-labelledby="mdActH">
    <h4 id="mdActH" class="md-h">Estado en el listado${reefer}</h4>
    <p class="md-ayuda">Los graneles inactivos no se muestran en el listado salvo con "Ver inactivos". Automático decide por los movimientos de stock de los últimos 6 meses.</p>
    <div class="flex flex-wrap items-center gap-2"><label for="mdActSel" class="text-sm">Mostrar como</label>
      <select id="mdActSel" class="num-in text-left">${htmlOpcionesActivoMd(f)}</select>
      <button type="button" id="mdActGuardar" class="cfg-btn2">Guardar</button></div>
    <ul class="md-act-mov">${lineasEstadoMd(f).map(l => `<li>${ESC_FR_MD(l)}</li>`).join('')}</ul>
    <p id="mdActMsg" class="md-msg" role="status" aria-live="polite">${msg}</p></section>`;
}

// ── Columna derecha: precios de las presentaciones y su variación contra el vigente ──
// Δ $ = sugerido − vigente, a centavos (sin el ruido del punto flotante); null si falta alguno de los dos (sin vigente o sin precio).
// Vigente 0 = "sin vigente" (SIGA devuelve PrecioVenta 0 y el server da Δ % null): tampoco hay Δ $.
const deltaPesosMd = (vigente, sugerido) => (!(vigente > 0) || sugerido == null ? null : Math.round((sugerido - vigente) * 100) / 100);
// "+$ 300" / "-$ 7.460" / "+$ 0,25" / "$ 0": signo explícito (el color solo no alcanza), enteros sin decimales como los precios.
function textoDeltaPesosMd(n) {
  if (n == null) return '—';
  if (n === 0) return '$ 0';
  const abs = Math.abs(n);
  return `${n > 0 ? '+' : '-'}$ ${ESQ_FR_MD.fmtSug(abs)}`;
}
// Peso de la presentación: "500 g", "1 kg", "1,5 kg"; sin peso (nombre sin gramaje) → ''.
const textoPesoMd = pesoG => (!(pesoG > 0) ? '' : pesoG >= 1000 ? `${minMd(pesoG / 1000)} kg` : `${minMd(pesoG)} g`);
// Las filas por canal de la fuente (filasCanales) con el Δ $ de cada una; la fila con IVA y las sin vigente quedan sin Δ.
const filasPreciosFraccMd = (fila, fuente) => ESQ_FR_MD.filasCanales(fila, fuente).map(r => ({ ...r, deltaPesos: deltaPesosMd(r.vigente, r.sugerido) }));
// Cuántas presentaciones suben / bajan / quedan igual (el semáforo del server, con su tolerancia), cuántas no tienen vigente con qué
// comparar y cuántas no tienen precio. Sólo cuenta las filas minoristas (una por presentación): los pack/bulto no.
function resumenVariacionFraccMd(filas) {
  const min = filas.filter(r => r.tipo === 'minorista');
  const conDelta = min.filter(r => r.sugerido != null && r.deltaPct != null);
  return { n: min.length, suben: conDelta.filter(r => r.estado === 'subir').length, bajan: conDelta.filter(r => r.estado === 'bajar').length,
    iguales: conDelta.filter(r => r.estado !== 'subir' && r.estado !== 'bajar').length,
    sinVigente: min.filter(r => r.sugerido != null && r.deltaPct == null).length, sinPrecio: min.filter(r => r.sugerido == null).length };
}
// Chips del resumen: { estado: 'subir' | 'bajar' | 'ok' | 'nd', texto } sólo para los grupos con presentaciones.
const chipsVariacionFraccMd = r => [['subir', r.suben, 'para subir'], ['bajar', r.bajan, 'para bajar'], ['ok', r.iguales, 'sin cambio'],
  ['nd', r.sinVigente, 'sin vigente'], ['nd', r.sinPrecio, 'sin precio']].filter(([, n]) => n > 0).map(([estado, n, txt]) => ({ estado, texto: `${n} ${txt}` }));
// "por kg · con última compra" o "por kg · con costo sistema, para comparar" (textoFuenteMd, el mismo de "Precios por canal").
const subtituloPreciosFraccMd = (fila, fuente) => `por kg · ${ESQ_FR_MD.textoFuenteMd(fila, fuente)}`;

const chipFrMd = c => (c.estado === 'nd' ? `<span class="md-chip-0">${c.texto}</span>` : `<span class="pr-sem sem-${c.estado}">${c.texto}</span>`);
// Celdas de una fila: vigente, sugerido, Δ $, Δ % (color de suba/baja del listado: claseDelta) y margen total. La fila con IVA no tiene
// vigente ni Δ (SIGA guarda los pack/bulto sin IVA): celdas de Δ vacías; sin vigente o sin precio, "—".
function celdasPreciosFraccMd(r) {
  const delta = (valor, txt) => (r.conIva === true ? '' : valor == null ? '<span class="md-nd">—</span>' : `<span class="${FMT_FR_MD.claseDelta(r.estado)}">${txt}</span>`);
  return `<td class="num">${ESQ_FR_MD.pesosMd(r.vigente)}</td><td class="num md-nuevo">${ESQ_FR_MD.pesosMd(r.sugerido)}</td>`
    + `<td class="num">${delta(r.deltaPesos, textoDeltaPesosMd(r.deltaPesos))}</td><td class="num">${delta(r.deltaPct, FMT_FR_MD.fmtPct(r.deltaPct))}</td>`
    + `<td class="num">${r.margenTotalPct == null ? '<span class="md-nd">—</span>' : ESQ_FR_MD.pctMd(r.margenTotalPct)}</td>`;
}
// Cuerpo de la tarjeta derecha (#mDetDer; su título y su subtítulo —subtituloPreciosFraccMd— los pone pintarModalFraccionadoMd): los chips del
// resumen de variación y la tabla: una fila por presentación (nombre, PLU y peso) y, debajo de cada una, sus pack/bulto (sin IVA con Δ, con
// IVA sin Δ). Los pack/bulto del granel mismo (antes de la primera presentación) van arriba bajo "Granel".
function htmlPreciosFraccMd(f, fuente) {
  const filas = filasPreciosFraccMd(f, fuente);
  const chips = chipsVariacionFraccMd(resumenVariacionFraccMd(filas)).map(chipFrMd).join('');
  const cab = chips ? `<div class="md-fr-chips">${chips}</div>` : '';
  if (!filas.length) return `${cab}<p class="text-gris">Sin precios para mostrar.</p>`;
  let previo = null, conMinorista = false;
  const cuerpo = filas.map(r => {
    if (r.tipo === 'minorista') {
      previo = null; conMinorista = true;
      const peso = textoPesoMd(r.pesoG);
      return `<tr class="md-min"><td><b>${ESC_FR_MD(r.nombre)}</b> <span class="md-sub">PLU ${ESC_FR_MD(r.plu)}${peso ? ` · ${peso}` : ''}</span></td>${celdasPreciosFraccMd(r)}</tr>`;
    }
    const grupo = r.plu !== previo ? `<tr class="md-grp"><td colspan="6">${conMinorista ? '' : 'Granel · '}${ESC_FR_MD(ESQ_FR_MD.TIPO_CANAL[r.tipo] || r.tipo)} <span class="md-sub">PLU ${ESC_FR_MD(r.plu)} · ${ESC_FR_MD(r.nombre || '')}${r.unidades ? ` · × ${ESC_FR_MD(r.unidades)}` : ''}</span>${ESQ_FR_MD.avisosCanalMd(r)}</td></tr>` : '';
    previo = r.plu;
    return `${grupo}<tr class="md-may"><td>${r.conIva ? 'Con IVA' : 'Sin IVA'}</td>${celdasPreciosFraccMd(r)}</tr>`;
  }).join('');
  return `${cab}<table class="md-tabla md-fr-tabla"><thead><tr><th class="text-left">Presentación</th><th>Vigente</th><th>Sugerido</th>`
    + `<th title="Sugerido menos vigente, en pesos">Δ $</th><th title="Sugerido contra vigente, en %">Δ %</th>`
    + `<th title="Precio final ÷ costo de mercadería (con sus extras) − 1">Margen total</th></tr></thead><tbody>${cuerpo}</tbody></table>`;
}

if (typeof module === 'object' && module.exports) module.exports = { resumenCosteoFraccMd, opcionesMaquinaMd, formulaMinutosMd, textoSinTiempoMd, textoElegidoMd,
  textoAutomaticoMd, valorSelectActivoMd, activoManualDeValorMd, htmlOpcionesActivoMd, lineasEstadoMd, textoGuardadoActivoMd, htmlEstadoActivoMd,
  deltaPesosMd, textoDeltaPesosMd, textoPesoMd, filasPreciosFraccMd, resumenVariacionFraccMd, chipsVariacionFraccMd, subtituloPreciosFraccMd, htmlPreciosFraccMd };

// ── DOM ──
let mdFrMaquinas = null; // máquinas de Configuración › Costeo Fraccionado (se piden cada vez que se conecta el modal: una máquina nueva aparece)

const textoMinutosMd = (l, falta, c) => `${formulaMinutosMd(c, l.cantidad)} × ${l.costoUnit == null ? `sin costo hora (${falta})` : `$ ${fmtMoney(l.costoUnit)}/h`}`;

// Máquina del granel (excepción a la de su subrubro). Sin costeoGranel (sin migrar o "sin granel") no hay nada que mostrar.
function htmlMaquinaGranelMd(f) {
  if (!f.costeoGranel) return '';
  const g = f.costeoGranel;
  const maquinas = mdFrMaquinas || (g.maquinaId ? [{ id: g.maquinaId, nombre: g.maquina || g.maquinaId }] : []);
  return `<div class="md-edicion" id="mdFr">
    <div class="lbl mb-1">Máquina · ${g.subrubro ? `subrubro ${esc(g.subrubro)}` : 'sin subrubro en SIGA'}</div>
    <div class="flex flex-wrap items-center gap-2">
      <label class="text-sm">Máquina <select id="mdFrMaquina" class="num-in"${g.subrubro ? '' : ' disabled'}>${opcionesMaquinaMd(maquinas, g.maquinaId, g.maquinaSubrubro)}</select></label>
      ${g.subrubro ? '' : `<span class="text-xs text-gris">${esc('sin subrubro: no suma minutos')}</span>`}
      <button type="button" id="mdFrGuardar" class="cfg-btn2">Guardar</button></div>
    <p class="text-xs text-gris mt-1">Máquina, tiempos por peso, facilidad y tiempo del subrubro, e insumos por peso: Configuración › Costeo Fraccionado.</p>
    <p id="mdFrMsg" class="text-sm mt-1" role="status" aria-live="polite"></p></div>`;
}

function htmlPresFraccMd(p, f) {
  const titulo = `${p.nombre} · ${textoElegidoMd(p.costeoPresentacion)}`;
  if ((p.avisosCosto || []).includes('sinPeso')) return htmlPasos(titulo, [['', 'Sin peso en el nombre: sólo mercadería', null], ['=', 'Costo $/kg', (p.costos || {})[mdFuente]]]);
  const r = resumenCosteoFraccMd(p, mdFuente, f.costos);
  const linea = l => ['', `· ${l.nombre || l.plu} ${minMd(l.cantidad)} × ${l.costoUnit == null ? 'sin costo' : `$ ${fmtMoney(l.costoUnit)}`}`, l.importe];
  const c = p.costeoPresentacion || {}, avisos = p.avisosCosto || [], kg = minMd(p.pesoG / 1000);
  return htmlPasos(titulo, [
    ['', `Mercadería · ${kg} kg × ${r.mercaderiaKg == null ? 'sin costo' : `$ ${fmtMoney(r.mercaderiaKg)}/kg`}`, r.mercaderiaUnidad],
    ['+', r.insumos.length ? 'Insumos' : 'Insumos — sin cargar (Configuración › Costeo Fraccionado › Insumos por peso)', r.subtotalInsumos], ...r.insumos.map(linea),
    ['+', r.mo ? `Mano de obra · ${textoMinutosMd(r.mo, 'cargalo en Costos con el switch en Fraccionado', c)}` : textoSinTiempoMd('mo', avisos), r.mo ? r.mo.importe : 0],
    ['+', r.maquina ? `Máquina ${r.maquina.nombre} · ${textoMinutosMd(r.maquina, 'cargalo en la máquina', c)}` : textoSinTiempoMd('maquina', avisos), r.maquina ? r.maquina.importe : 0],
    ['=', r.porUnidad == null ? 'Costo real por unidad — falta el costo de un insumo' : 'Costo real por unidad', r.costoUnidad],
    ['÷', `${kg} kg de la presentación`, null], ['=', 'Costo real $/kg', r.costoKg],
  ]);
}

// ── Layout a dos tarjetas ──
// "Costo del granel" (sólo con precios-config): máquina, costo manual, costos extra y venta de pack/bulto pesables.
const htmlCostoGranelMd = f => (preciosSinConfig ? '' : `<section class="md-fr-sec" aria-labelledby="mdCostoH">
  <h4 id="mdCostoH" class="md-h">Costo del granel <span class="md-sub">· $/kg</span></h4>${htmlMaquinaGranelMd(f)}${htmlEdicionCostos(f)}</section>`);

// Cómo se conforma el costo (mercadería + insumos + mano de obra + máquina, por presentación) y el precio (costo → margen → IVA →
// redondeo, por presentación y pack/bulto). Acordeón del theme, cerrado salvo que ya estuviera abierto (mdDetalle sobrevive a repintados).
function htmlDetalleFraccMd(f) {
  if (preciosSinConfig) return '';
  const costo = f.costeoGranel ? (f.presentaciones || []).map(p => htmlPresFraccMd(p, f)).join('') : '';
  return `<details id="mdDetCuerpo" class="acordeon md-fr-detalle"${mdDetalle ? ' open' : ''}>
    <summary><span class="caret" aria-hidden="true">▶</span><span class="md-h">Cómo se conforma el costo y el precio</span></summary>
    <div class="cuerpo">${costo ? `<div class="lbl mt-3">Costo real por presentación</div>${costo}` : ''}
      <div class="lbl mt-4">Cálculo del precio</div>${htmlDesgloseEsq(f)}</div></details>`;
}

// Dos tarjetas con su propio scroll (precios.html: #mDetCaja y #mDetDer). Izquierda (#mDetBody): decisión del costo, costo del granel,
// cómo se conforma, margen del producto y estado. Derecha (#mDetDerBody): precios de las presentaciones con la fuente elegida (mdFuente).
function pintarModalFraccionadoMd() {
  const { tipo, fila: f } = mdEsq;
  const ops = opcionesCosto(f, tipo);
  document.getElementById('mDetBody').innerHTML = `${htmlResumenMd(f, tipo)}${htmlAvisoMd(f, ops)}${htmlOpcionesCosto(f, ops)}${htmlCostoGranelMd(f)}${htmlDetalleFraccMd(f)}${htmlMargenProductoMd(f)}${htmlEstadoActivoMd(f)}`;
  document.getElementById('mDetDerSub').textContent = subtituloPreciosFraccMd(f, mdFuente);
  document.getElementById('mDetDerBody').innerHTML = htmlPreciosFraccMd(f, mdFuente);
  conectarModalEsquema(); // precios_modal_esquema.js: tarjetas, edición de costos y margen; llama a conectarModalFraccionadoMd
}

// Recuerda si el acordeón está abierto (los repintados lo respetan). Al abrirlo con un clic lo lleva arriba; el evento toggle del
// atributo open inicial (repintado) no es del usuario y no mueve el scroll.
function conectarDetalleFraccMd() {
  const det = document.getElementById('mdDetCuerpo');
  if (!det) return;
  let delUsuario = false;
  det.querySelector('summary').addEventListener('click', () => { delUsuario = true; });
  det.ontoggle = () => {
    mdDetalle = det.open;
    if (delUsuario && det.open) det.scrollIntoView({ block: 'start', behavior: 'smooth' });
    delUsuario = false;
  };
}
function conectarModalFraccionadoMd() { conectarCosteoFraccMd(); conectarEstadoActivoMd(); conectarDetalleFraccMd(); }

function conectarCosteoFraccMd() {
  if (!document.getElementById('mdFr')) return;
  const g = mdEsq.fila.costeoGranel;
  getJson(API_FR).then(cfg => {
    mdFrMaquinas = cfg.maquinas.map(({ id, nombre }) => ({ id, nombre }));
    const sel = document.getElementById('mdFrMaquina');
    if (!sel) return;
    const v = sel.value;
    sel.innerHTML = opcionesMaquinaMd(mdFrMaquinas, g.maquinaId, g.maquinaSubrubro);
    if ([...sel.options].some(o => o.value === v)) sel.value = v;
  }).catch(e => { const m = document.getElementById('mdFrMsg'); if (m) { m.className = 'text-sm mt-1 text-crit'; m.textContent = `No se pudieron leer las máquinas: ${e.message}`; } });
  document.getElementById('mdFrGuardar').onclick = () => guardarCostoEsq(`${API_FR}/granel/${encodeURIComponent(mdEsq.fila.plu)}`,
    { maquinaId: document.getElementById('mdFrMaquina').value || null }, 'PUT', 'mdFrMsg');
}

// ── Estado del granel: Guardar -> PUT (guardarActivoManual) -> fila local actualizada -> listado y bloque repintados, sin recargar SIGA ──
function pintarEstadoActivoMd(msg) {
  const el = document.getElementById('mdAct');
  if (!el) return;
  el.outerHTML = htmlEstadoActivoMd(mdEsq.fila, msg);
  conectarEstadoActivoMd();
}
function conectarEstadoActivoMd() {
  const guardar = document.getElementById('mdActGuardar');
  if (!guardar) return;
  guardar.onclick = async () => {
    const sel = document.getElementById('mdActSel'), msg = document.getElementById('mdActMsg');
    const { tipo, fila } = mdEsq;
    guardar.disabled = true; sel.disabled = true;
    msg.className = 'md-msg'; msg.innerHTML = '<span class="spin"></span> Guardando…';
    try {
      const activoManual = await guardarActivoManual(fila.plu, activoManualDeValorMd(sel.value)); // precios_listados.js
      mdEsq = { tipo, fila: conActivoManual(fila, activoManual) };
      renderListado(tipo); // el granel puede salir del listado (inactivo / REEFER): sin recargar SIGA
      pintarEstadoActivoMd(`<span class="text-ok">✓ ${ESC_FR_MD(textoGuardadoActivoMd(mdEsq.fila))}</span>`);
    } catch (e) {
      guardar.disabled = false; sel.disabled = false; // queda lo elegido para reintentar
      msg.className = 'md-msg text-crit'; msg.textContent = `No se pudo guardar: ${e.message}`;
      sel.focus();
      return;
    }
    document.getElementById('mdActSel').focus(); // el repintado reemplazó el select: sin foco el teclado quedaría en el <body>
  };
}
