// ── Precios · modal de Fraccionado: dos tarjetas lado a lado, costo real por presentación y máquina del granel (spec 2026-10-21-precios-fraccionado-costeo-design §9.3) ──
// Script clásico después de precios_modal_esquema.js y precios_config_fraccionado.js. pintarModalEsquema le deja el pintado
// (pintarModalFraccionadoMd) y conectarModalEsquema lo conecta (conectarModalFraccionadoMd). Dos tarjetas (#mDetCaja, ~70 % del ancho, y
// #mDetDer, ~30 %):
//  · izquierda = configuración del granel, en pasos numerados (cada uno es un panel .md-paso con su encabezado: título + para qué sirve; el
//    número lo pone un contador CSS en precios.html, así que sin precios-config el estado es el paso 2): 1 costo elegido (tarjetas, una fila de
//    cuatro, cada una con su acento, su "cuándo conviene" y, la elegida, "Elegida"; la de costo manual trae el campo para cargarlo), debajo en dos
//    columnas 2 el costo del granel (máquina, costos extra, venta de pack/bulto) y 3 el margen del producto con 4 el estado, y al final, sólo para
//    revisar, el acordeón "Cómo se conforma el costo y el precio": un panel con el mismo lenguaje que los pasos (sin número: lleva la marca
//    "Detalle") y dos apartados, A costo real y B precio, con una mini-tarjeta por presentación; cada una es una cuenta alineada (operador |
//    concepto con su detalle | importe, subtotales con línea, total destacado). Todo salvo las tarjetas y el estado va sólo con precios-config (sin él
//    el server no manda el desglose ni los extras, y el costo manual no se carga acá).
//  · derecha = precios de las presentaciones (htmlPreciosFraccMd, bajo el título "Precios de las presentaciones" y el subtítulo "por kg · con <fuente>"):
//    angosta, así que sin columnas: una tarjeta por presentación con vigente → sugerido con la fuente elegida, Δ % como chip, Δ $ y margen en
//    segunda línea y, adentro, el sub-bloque "Códigos mayoristas" con sus pack/bulto; al final, la tarjeta de los pack/bulto del granel.
// Elegir un costo o guardar un margen repinta el modal entero (guardarOpcionMd / guardarCostoEsq): la tarjeta derecha siempre
// refleja lo elegido a la izquierda. La facilidad y el tiempo son los del subrubro del granel y los insumos los del peso de la
// presentación (Configuración › Costeo Fraccionado, precios_config_fraccionado.js): acá se ven. Globales: esc, fmtMoney, fmtFechaPrecio,
// claseDelta (precios_comun.js), mdEsq, mdFuente, mdDetalle, guardarCostoEsq, htmlResumenMd, htmlAvisoMd, htmlOpcionesCosto,
// opcionesCosto, manualEnTarjetaMd, htmlMargenProductoMd, htmlEdicionCostos, filasCanales, fmtSug, pesosMd, textoFuenteMd, chipDelta, pasosMinoristaMd,
// pasosMayoristaMd (precios_modal_esquema.js), API_FR
// (precios_config_fraccionado.js), getJson (precios_produccion.js).
// El bloque "Estado" del granel (activo / inactivo / automático, spec 2026-10-26 §4) lo ve cualquier usuario de Precios:
// globales guardarActivoManual, conActivoManual, renderListado (precios_listados.js).
const NODE_FR_MD = typeof module === 'object' && module.exports;
const FMT_FR_MD = NODE_FR_MD ? require('./precios_comun.js') : { esc, fmtMoney, fmtFechaPrecio, claseDelta };
const { esc: ESC_FR_MD, fmtMoney: MONEY_FR_MD, fmtFechaPrecio: FECHA_FR_MD } = FMT_FR_MD;
const ESQ_FR_MD = NODE_FR_MD ? require('./precios_modal_esquema.js') : { TIPO_CANAL, pctMd, avisosCanalMd, filasCanales, fmtSug, pesosMd, textoFuenteMd, chipDelta, pasosMinoristaMd, pasosMayoristaMd };
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
function motivoSinTiempoMd(rol, avisos) {
  const a = avisos || [];
  if (rol === 'maquina' && a.includes('sinMaquina') && !a.includes('sinSubrubro') && !a.includes('sinTramos')) return 'sin asignar (ni del subrubro ni del granel)';
  return a.includes('sinSubrubro') ? 'sin minutos: el granel no tiene subrubro en SIGA' : SIN_MINUTOS_MD;
}
const textoSinTiempoMd = (rol, avisos) => `${rol === 'maquina' ? 'Máquina' : 'Mano de obra'} — ${motivoSinTiempoMd(rol, avisos)}`;
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
  return `<section id="mdAct" class="md-activo md-paso" aria-labelledby="mdActH">
    <div class="md-paso-cab"><h4 id="mdActH" class="md-h">Estado en el listado${reefer}</h4>
      <p class="md-paso-para">No cambia ningún precio: sólo define si el granel aparece en el listado.</p></div>
    <div class="md-paso-cuerpo"><p class="md-ayuda">Los graneles inactivos no se muestran en el listado salvo con "Ver inactivos". Automático decide por los movimientos de stock de los últimos 6 meses.</p>
    <div class="flex flex-wrap items-center gap-2"><label for="mdActSel" class="text-sm">Mostrar como</label>
      <select id="mdActSel" class="num-in text-left">${htmlOpcionesActivoMd(f)}</select>
      <button type="button" id="mdActGuardar" class="cfg-btn2">Guardar</button></div>
    <ul class="md-act-mov">${lineasEstadoMd(f).map(l => `<li>${ESC_FR_MD(l)}</li>`).join('')}</ul>
    <p id="mdActMsg" class="md-msg" role="status" aria-live="polite">${msg}</p></div></section>`;
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
// "Vigente $ 1.500 → Sugerido $ 1.800" (los rótulos, sólo para lector de pantalla) y aparte, más chico, el Δ $ (color de suba/baja del listado:
// claseDelta) y el margen total. La fila con IVA no tiene vigente ni Δ (SIGA guarda los pack/bulto sin IVA): sólo el sugerido y el margen.
const TITULO_DETALLE_FR_MD = 'Δ $ = sugerido menos vigente · Margen = precio final ÷ costo de mercadería (con sus extras) − 1';
function partesPreciosFraccMd(r) {
  const precios = `<span><span class="sr-only">Vigente </span>${ESQ_FR_MD.pesosMd(r.vigente)} <span class="md-fr-flecha" aria-hidden="true">→</span> `
    + `<span class="sr-only">Sugerido </span><b class="md-nuevo">${ESQ_FR_MD.pesosMd(r.sugerido)}</b></span>`;
  const detalle = [
    r.deltaPesos == null ? '' : `<span class="sr-only">Diferencia </span><span class="${FMT_FR_MD.claseDelta(r.estado)}">${textoDeltaPesosMd(r.deltaPesos)}</span>`,
    r.margenTotalPct == null ? '' : `margen ${ESQ_FR_MD.pctMd(r.margenTotalPct)}`,
  ].filter(Boolean).join(' · ');
  return { precios, detalle: detalle ? `<span class="md-fr-res" title="${TITULO_DETALLE_FR_MD}">${detalle}</span>` : '' };
}
// Δ % contra el vigente como chip (el del modal de Reventa); sin vigente o sin precio no hay chip.
const chipDeltaFrMd = r => (r.deltaPct == null ? '' : ESQ_FR_MD.chipDelta(r.deltaPct, r.estado));
// Reparte las filas por canal (filasPreciosFraccMd, ya en orden por peso) entre sus dueños: cada presentación con los pack/bulto que le siguen
// (hasta la próxima presentación) y, aparte, los del granel mismo (los que vienen antes de la primera presentación). Un pack/bulto =
// { tipo, plu, nombre, unidades, filas: [sin IVA, con IVA] }: sus dos filas, juntas, para pintarlas como una unidad.
function agruparPreciosFraccMd(filas) {
  const granel = [], presentaciones = [];
  let dueno = granel;
  for (const r of filas) {
    if (r.tipo === 'minorista') {
      dueno = [];
      presentaciones.push({ minorista: r, mayoristas: dueno });
      continue;
    }
    const ultimo = dueno[dueno.length - 1];
    if (ultimo && ultimo.plu === r.plu) ultimo.filas.push(r);
    else dueno.push({ tipo: r.tipo, plu: r.plu, nombre: r.nombre, unidades: r.unidades, filas: [r] });
  }
  return { granel, presentaciones };
}
// Fila de precios de un pack/bulto: "Sin IVA" (con vigente y Δ) o "Con IVA" (sin ellos) + vigente → sugerido, Δ % como chip, Δ $ y margen.
const htmlFilaPreciosFraccMd = r => {
  const { precios, detalle } = partesPreciosFraccMd(r);
  return `<div class="md-fr-fila"><span class="md-fr-iva">${r.conIva ? 'Con IVA' : 'Sin IVA'}</span>${precios}${chipDeltaFrMd(r)}${detalle}</div>`;
};
// Un pack/bulto: tipo en negrita con su PLU y sus unidades (y el aviso "revisar unidad" si corresponde), el nombre debajo y sus dos filas.
const htmlCodigoMayoristaFraccMd = m => `<li class="md-fr-cod"><div class="md-fr-cod-cab"><b>${ESC_FR_MD(ESQ_FR_MD.TIPO_CANAL[m.tipo] || m.tipo)}</b> `
  + `<span class="md-sub">PLU ${ESC_FR_MD(m.plu)}${m.unidades ? ` · × ${ESC_FR_MD(m.unidades)}` : ''}</span>${ESQ_FR_MD.avisosCanalMd(m.filas[0])}</div>`
  + `${m.nombre ? `<div class="md-fr-cod-nom">${ESC_FR_MD(m.nombre)}</div>` : ''}${m.filas.map(htmlFilaPreciosFraccMd).join('')}</li>`;
const htmlCodigosMayoristasFraccMd = (mayoristas, etiqueta) => `<ul class="md-fr-cods" aria-label="${ESC_FR_MD(etiqueta)}">${mayoristas.map(htmlCodigoMayoristaFraccMd).join('')}</ul>`;
// Tarjeta de una presentación: nombre y Δ % arriba, PLU y peso, precios y, si tiene pack/bulto, su sub-bloque "Códigos mayoristas" adentro.
function htmlTarjetaPresentacionFraccMd({ minorista: r, mayoristas }) {
  const peso = textoPesoMd(r.pesoG);
  const { precios, detalle } = partesPreciosFraccMd(r);
  const mays = mayoristas.length ? `<div class="md-fr-mays"><div class="md-fr-mays-t">Códigos mayoristas</div>`
    + `${htmlCodigosMayoristasFraccMd(mayoristas, `Códigos mayoristas de ${r.nombre}`)}</div>` : '';
  return `<li class="md-fr-card md-fr-pres"><div class="md-fr-l1"><b>${ESC_FR_MD(r.nombre)}</b>${chipDeltaFrMd(r)}</div>`
    + `<div class="md-sub">PLU ${ESC_FR_MD(r.plu)}${peso ? ` · ${peso}` : ''}</div><div class="md-fr-l3">${precios}${detalle}</div>${mays}</li>`;
}
// Tarjeta de los pack/bulto del granel mismo (no de una presentación); sin ellos no hay tarjeta.
const htmlTarjetaGranelFraccMd = mayoristas => (!mayoristas.length ? '' : `<li class="md-fr-card md-fr-granel"><h4 class="md-fr-card-t">Mayoristas del granel `
  + `<span class="md-sub">· venta por kg</span></h4>${htmlCodigosMayoristasFraccMd(mayoristas, 'Códigos mayoristas del granel')}</li>`);
// Cuerpo de la tarjeta derecha (#mDetDer; su título y su subtítulo —subtituloPreciosFraccMd— los pone pintarModalFraccionadoMd): los chips del
// resumen de variación y una lista de tarjetas: una por presentación, en orden por peso, con sus pack/bulto adentro (sin IVA con Δ, con IVA
// sin Δ), y al final la de los pack/bulto del granel. Al final y no arriba: el título y los chips hablan de las presentaciones, y los del
// granel (que no tienen peso) no deben leerse como una más de la secuencia por peso.
function htmlPreciosFraccMd(f, fuente) {
  const filas = filasPreciosFraccMd(f, fuente);
  const chips = chipsVariacionFraccMd(resumenVariacionFraccMd(filas)).map(chipFrMd).join('');
  const cab = chips ? `<div class="md-fr-chips">${chips}</div>` : '';
  if (!filas.length) return `${cab}<p class="text-gris">Sin precios para mostrar.</p>`;
  const { granel, presentaciones } = agruparPreciosFraccMd(filas);
  return `${cab}<ul class="md-fr-lista">${presentaciones.map(htmlTarjetaPresentacionFraccMd).join('')}${htmlTarjetaGranelFraccMd(granel)}</ul>`;
}
// Debajo de las tarjetas de costo: un bloque por columna cuando hay dos; con uno solo (sin configuración sólo queda el estado) a ancho completo.
function htmlColumnasFraccMd(...bloques) {
  const hay = bloques.filter(Boolean);
  return hay.length > 1 ? `<div class="md-fr-cols">${hay.map(b => `<div class="md-fr-col">${b}</div>`).join('')}</div>` : hay.join('');
}

// ── Acordeón "Cómo se conforma el costo y el precio": cuentas alineadas, una mini-tarjeta por presentación ──
// Un renglón de cuenta = { op, txt, det, v, u, tipo }: el operador (+ × = ÷) en su columna, el concepto con su detalle debajo y el importe a la
// derecha. v = importe en $ (null = sin dato: "—"; sin v = renglón sin importe), u = importe ya en texto (los kg del "÷"). tipo: 'sub' = desglose
// del renglón de arriba (sangrado: sus importes ya están en ese renglón), 'nd' = falta cargar algo (gris, con su motivo), 'nota' = aclaración
// sin importe. Los "=" son subtotales; el último es el total, el resultado destacado de la cuenta.
const dineroFrMd = n => `$ ${MONEY_FR_MD(n)}`;
const dineroDetFrMd = n => `$\u00a0${MONEY_FR_MD(n)}`; // en los detalles, que se parten en renglones: el $ no se separa de su número
const textoMinutosMd = (l, falta, c) => `${formulaMinutosMd(c, l.cantidad)} × ${l.costoUnit == null ? `sin costo hora (${falta})` : `${dineroDetFrMd(l.costoUnit)}/h`}`;

// Cuenta del costo real de una presentación con la fuente elegida: mercadería + insumos + mano de obra + máquina = costo por unidad ÷ kg = $/kg.
function filasCostoPresFraccMd(p, fuente, costosGranel) {
  if ((p.avisosCosto || []).includes('sinPeso')) return [{ tipo: 'nota', txt: 'Sin peso en el nombre: sólo mercadería' }, { op: '=', txt: 'Costo $/kg', v: (p.costos || {})[fuente] ?? null }];
  const r = resumenCosteoFraccMd(p, fuente, costosGranel), c = p.costeoPresentacion || {}, avisos = p.avisosCosto || [], kg = minMd(p.pesoG / 1000);
  const insumo = l => ({ tipo: 'sub', txt: l.nombre || l.plu, det: `${minMd(l.cantidad)} × ${l.costoUnit == null ? 'sin costo' : dineroDetFrMd(l.costoUnit)}`, v: l.importe });
  const conMinutos = (rol, l, txt, falta) => (l ? { op: '+', txt, det: textoMinutosMd(l, falta, c), v: l.importe }
    : { op: '+', txt, det: motivoSinTiempoMd(rol, avisos), tipo: 'nd', v: 0 });
  return [
    { txt: 'Mercadería', det: `${kg} kg × ${r.mercaderiaKg == null ? 'sin costo' : `${dineroDetFrMd(r.mercaderiaKg)}/kg`}`, v: r.mercaderiaUnidad },
    r.insumos.length ? { op: '+', txt: 'Insumos', v: r.subtotalInsumos }
      : { op: '+', txt: 'Insumos', det: 'sin cargar (Configuración › Costeo Fraccionado › Insumos por peso)', tipo: 'nd', v: r.subtotalInsumos },
    ...r.insumos.map(insumo),
    conMinutos('mo', r.mo, 'Mano de obra', 'cargalo en Costos con el switch en Fraccionado'),
    conMinutos('maquina', r.maquina, r.maquina ? `Máquina ${r.maquina.nombre}` : 'Máquina', 'cargalo en la máquina'),
    { op: '=', txt: 'Costo real por unidad', ...(r.porUnidad == null ? { det: 'falta el costo de un insumo' } : {}), v: r.costoUnidad },
    { op: '÷', txt: 'Peso de la presentación', u: `${kg} kg` },
    { op: '=', txt: 'Costo real $/kg', v: r.costoKg },
  ];
}

// [operador, texto, importe] de esquema (pasosMinoristaMd / pasosMayoristaMd) → renglón de cuenta. Sin operador y sin importe (salvo el primero,
// la base de la cuenta) es una nota: los ajustes del margen ("incluye margen especial del producto…").
const filaDePasoMd = ([op, txt, v], i) => (i > 0 && !op && v == null ? { tipo: 'nota', txt } : { ...(op ? { op } : {}), txt, v: v ?? null });
// Cuentas del precio de una fila (presentación o granel) con la fuente elegida: el minorista (el granel no lo tiene: { minorista: false }) y cada
// pack/bulto con su desglose. Sin desglose de la fuente → null.
function cuentasPrecioFraccMd(fila, fuente, { minorista = true } = {}) {
  const s = (fila.sugeridos || {})[fuente];
  if (!s || !s.desglose) return null;
  const d = s.desglose, porVinculo = d.porVinculo || {};
  return {
    minorista: minorista ? ESQ_FR_MD.pasosMinoristaMd(d, fila.componentesCosto ? 'Costo real' : 'Costo de mercadería').map(filaDePasoMd) : null, // presentación costeada = mercadería + insumos + MO + máquina
    mayoristas: (fila.mayoristas || []).filter(v => porVinculo[v.plu]).map(v => ({ tipo: v.tipo, plu: v.plu, nombre: v.nombre, unidades: porVinculo[v.plu].unidades,
      filas: ESQ_FR_MD.pasosMayoristaMd(d, porVinculo[v.plu]).map(filaDePasoMd) })),
  };
}

function htmlCuentaFraccMd(filas) {
  const total = filas.map(r => r.op).lastIndexOf('=');
  const importe = r => (r.u != null ? `<span class="md-cu-v">${ESC_FR_MD(r.u)}</span>` : r.v === undefined ? '<span class="md-cu-v"></span>'
    : r.v === null ? '<span class="md-cu-v md-cu-vnd">—</span>' : `<span class="md-cu-v">${dineroFrMd(r.v)}</span>`);
  const fila = (r, i) => {
    const cls = ['md-cu-f', r.tipo && `md-cu-${r.tipo}`, r.op === '=' && (i === total ? 'md-cu-tot' : 'md-cu-sub-r')].filter(Boolean).join(' ');
    return `<div class="${cls}"><span class="md-cu-op" aria-hidden="true">${ESC_FR_MD(r.op || '')}</span><span class="md-cu-t">${ESC_FR_MD(r.txt)}`
      + `${r.det ? `<span class="md-cu-d">${ESC_FR_MD(r.det)}</span>` : ''}</span>${importe(r)}</div>`;
  };
  return `<div class="md-cu">${filas.map(fila).join('')}</div>`;
}

// Mini-tarjetas (como las de la derecha): cabecera con el nombre y, abajo, PLU y peso; después la cuenta.
const subTarjetaFraccMd = (p, prefijo = '') => `<div class="md-sub md-dt-sub">${prefijo}PLU ${ESC_FR_MD(p.plu)}${textoPesoMd(p.pesoG) ? ` · ${textoPesoMd(p.pesoG)}` : ''}</div>`;
const htmlTarjetaCostoFraccMd = (p, fuente, costosGranel) => `<li class="md-dt-card"><div class="md-dt-cab"><b>${ESC_FR_MD(p.nombre)}</b>`
  + `<span class="md-chip-0" title="Facilidad y tiempo del subrubro con que se costeó">${ESC_FR_MD(textoElegidoMd(p.costeoPresentacion))}</span></div>`
  + `${subTarjetaFraccMd(p)}${htmlCuentaFraccMd(filasCostoPresFraccMd(p, fuente, costosGranel))}</li>`;
// Un pack/bulto dentro de la tarjeta de su dueño: banda con su tipo, PLU y unidades (y su nombre) y su cuenta.
const htmlCanalFraccMd = m => `<div class="md-dt-canal"><b>${ESC_FR_MD(ESQ_FR_MD.TIPO_CANAL[m.tipo] || m.tipo)}</b> `
  + `<span class="md-sub">PLU ${ESC_FR_MD(m.plu)}${m.unidades ? ` · × ${ESC_FR_MD(m.unidades)}` : ''}</span>${m.nombre ? `<div class="md-dt-canal-nom">${ESC_FR_MD(m.nombre)}</div>` : ''}</div>${htmlCuentaFraccMd(m.filas)}`;
const SIN_DESGLOSE_FR_MD = 'Sin desglose para esta fuente.';
function htmlTarjetaPrecioFraccMd(p, fuente) {
  const c = cuentasPrecioFraccMd(p, fuente);
  return `<li class="md-dt-card"><div class="md-dt-cab"><b>${ESC_FR_MD(p.nombre)}</b></div>${subTarjetaFraccMd(p, 'Minorista · ')}`
    + `${c ? `${htmlCuentaFraccMd(c.minorista)}${c.mayoristas.map(htmlCanalFraccMd).join('')}` : `<p class="md-dt-vacio">${SIN_DESGLOSE_FR_MD}</p>`}</li>`;
}
// Los pack/bulto del granel mismo (no de una presentación); sin ellos, sin tarjeta.
function htmlTarjetaGranelPrecioFraccMd(f, fuente) {
  const c = cuentasPrecioFraccMd(f, fuente, { minorista: false });
  return !c || !c.mayoristas.length ? '' : `<li class="md-dt-card md-dt-granel"><div class="md-dt-cab"><b>Mayoristas del granel</b></div><div class="md-sub md-dt-sub">venta por kg</div>${c.mayoristas.map(htmlCanalFraccMd).join('')}</li>`;
}
// Apartado del acordeón: banda con su letra, título y para qué sirve, y debajo las tarjetas.
const htmlApartadoFraccMd = (id, letra, titulo, ayuda, cuerpo) => `<section class="md-dt-sec" aria-labelledby="${id}"><div class="md-dt-sec-cab">`
  + `${letra ? `<span class="md-dt-letra" aria-hidden="true">${letra}</span>` : ''}<h5 id="${id}" class="md-h">${titulo}</h5><p class="md-dt-para">${ayuda}</p></div><div class="md-dt-sec-cuerpo">${cuerpo}</div></section>`;
const OJO_FR_MD = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
// Contenido del acordeón con la fuente elegida: A = costo real por presentación (sólo con costeoGranel), B = cómo se llega al precio.
// Con un solo apartado no hay letras.
function htmlCuerpoDetalleFraccMd(f, fuente) {
  const pres = f.presentaciones || [];
  const costo = f.costeoGranel ? pres.map(p => htmlTarjetaCostoFraccMd(p, fuente, f.costos)).join('') : '';
  const granel = htmlTarjetaGranelPrecioFraccMd(f, fuente);
  const precio = pres.some(p => cuentasPrecioFraccMd(p, fuente)) || granel ? pres.map(p => htmlTarjetaPrecioFraccMd(p, fuente)).join('') + granel : '';
  return `${costo ? htmlApartadoFraccMd('mdDetCostoH', 'A', 'Costo real por presentación', 'Mercadería + insumos + mano de obra + máquina: lo que cuesta armar cada presentación, y de ahí su costo por kg.',
    `<ul class="md-dt-lista">${costo}</ul>`) : ''}`
    + htmlApartadoFraccMd('mdDetPrecioH', costo ? 'B' : '', 'Cómo se calcula el precio', 'Del costo real al precio: gastos variables, margen, extras, IVA y redondeo, por presentación y por pack/bulto.',
      precio ? `<ul class="md-dt-lista">${precio}</ul>` : `<p class="md-dt-vacio">${SIN_DESGLOSE_FR_MD}</p>`);
}

if (typeof module === 'object' && module.exports) module.exports = { resumenCosteoFraccMd, opcionesMaquinaMd, formulaMinutosMd, textoSinTiempoMd, textoElegidoMd,
  textoAutomaticoMd, valorSelectActivoMd, activoManualDeValorMd, htmlOpcionesActivoMd, lineasEstadoMd, textoGuardadoActivoMd, htmlEstadoActivoMd,
  deltaPesosMd, textoDeltaPesosMd, textoPesoMd, filasPreciosFraccMd, agruparPreciosFraccMd, resumenVariacionFraccMd, chipsVariacionFraccMd, subtituloPreciosFraccMd, htmlPreciosFraccMd, htmlColumnasFraccMd,
  motivoSinTiempoMd, filasCostoPresFraccMd, cuentasPrecioFraccMd, htmlCuentaFraccMd, htmlTarjetaCostoFraccMd, htmlTarjetaPrecioFraccMd, htmlCuerpoDetalleFraccMd };

// ── DOM ──
let mdFrMaquinas = null; // máquinas de Configuración › Costeo Fraccionado (se piden cada vez que se conecta el modal: una máquina nueva aparece)

// Máquina del granel (excepción a la de su subrubro). Sin costeoGranel (sin migrar o "sin granel") no hay nada que mostrar.
function htmlMaquinaGranelMd(f) {
  if (!f.costeoGranel) return '';
  const g = f.costeoGranel;
  const maquinas = mdFrMaquinas || (g.maquinaId ? [{ id: g.maquinaId, nombre: g.maquina || g.maquinaId }] : []);
  return `<div class="md-edicion" id="mdFr">
    <div class="md-sb-t">Máquina <span class="md-sub">· ${g.subrubro ? `subrubro ${esc(g.subrubro)}` : 'sin subrubro en SIGA'}</span></div>
    <p class="md-sb-ayuda">Suma el costo de usar la máquina en cada presentación. Por defecto es la del subrubro: elegí otra sólo si este granel usa una distinta.</p>
    <div class="flex flex-wrap items-center gap-2">
      <label for="mdFrMaquina" class="sr-only">Máquina</label><select id="mdFrMaquina" class="num-in"${g.subrubro ? '' : ' disabled'}>${opcionesMaquinaMd(maquinas, g.maquinaId, g.maquinaSubrubro)}</select>
      ${g.subrubro ? '' : `<span class="text-xs text-gris">${esc('sin subrubro: no suma minutos')}</span>`}
      <button type="button" id="mdFrGuardar" class="cfg-btn2">Guardar</button></div>
    <p class="md-sb-ayuda mt-1">Tiempos por peso, facilidad, tiempo e insumos se cargan en Configuración › Costeo Fraccionado.</p>
    <p id="mdFrMsg" class="text-sm mt-1" role="status" aria-live="polite"></p></div>`;
}

// ── Layout a dos tarjetas ──
// "Costo del granel" (sólo con precios-config): máquina, costos extra y venta de pack/bulto pesables. (El costo manual se carga en su tarjeta de decisión.)
const htmlCostoGranelMd = f => (preciosSinConfig ? '' : `<section class="md-fr-sec md-paso" aria-labelledby="mdCostoH">
  <div class="md-paso-cab"><h4 id="mdCostoH" class="md-h">Costo del granel <span class="md-sub">· $/kg</span></h4>
    <p class="md-paso-para">Se suma al costo elegido en el paso 1 y cambia el precio de todas las presentaciones.</p></div>
  <div class="md-paso-cuerpo">${htmlMaquinaGranelMd(f)}${htmlEdicionCostos(f)}</div></section>`);

// Cómo se conforma el costo y el precio, sólo para revisar: acordeón del theme con el lenguaje de los pasos (panel, encabezado teñido, título y
// para qué sirve) y dos apartados con sus mini-tarjetas (htmlCuerpoDetalleFraccMd). Cerrado salvo que ya estuviera abierto (mdDetalle sobrevive a repintados).
function htmlDetalleFraccMd(f) {
  if (preciosSinConfig) return '';
  return `<details id="mdDetCuerpo" class="acordeon md-fr-detalle"${mdDetalle ? ' open' : ''}>
    <summary><span class="caret" aria-hidden="true">▶</span><span class="md-det-tit"><span class="md-h">Cómo se conforma el costo y el precio</span>
      <span class="md-det-para">Sólo para revisar, no cambia nada: de dónde sale el costo real de cada presentación y cómo se llega a su precio.</span></span>
      <span class="md-det-tag">${OJO_FR_MD}Detalle</span></summary>
    <div class="cuerpo">${htmlCuerpoDetalleFraccMd(f, mdFuente)}</div></details>`;
}

// Dos tarjetas con su propio scroll (precios.html: #mDetCaja y #mDetDer). Izquierda (#mDetBody): decisión del costo (con precios-config la
// tarjeta de costo manual siempre está, para cargarlo desde ahí), en dos columnas el costo del granel y el margen del producto con el estado,
// y cómo se conforma el costo y el precio. Derecha (#mDetDerBody): precios de las presentaciones con la fuente elegida (mdFuente).
function pintarModalFraccionadoMd() {
  const { tipo, fila: f } = mdEsq;
  const ops = opcionesCosto(f, tipo, { manualSiempre: manualEnTarjetaMd(tipo) }); // precios_modal_esquema.js
  const abajo = htmlColumnasFraccMd(htmlCostoGranelMd(f), `${htmlMargenProductoMd(f)}${htmlEstadoActivoMd(f)}`);
  document.getElementById('mDetBody').innerHTML = `${htmlResumenMd(f, tipo)}${htmlAvisoMd(f, ops)}${htmlOpcionesCosto(f, ops)}${abajo}${htmlDetalleFraccMd(f)}`;
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
