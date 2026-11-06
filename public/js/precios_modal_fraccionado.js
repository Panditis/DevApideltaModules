// ── Precios · modal de Fraccionado: dos tarjetas lado a lado, costo real por presentación, min/kg y máquina del granel (spec 2026-10-21-precios-fraccionado-costeo-design §9.3; 2026-10-29-precios-fraccionado-tiempos-historial-design) ──
// Script clásico después de precios_modal_esquema.js y precios_config_fraccionado.js. pintarModalEsquema le deja el pintado
// (pintarModalFraccionadoMd) y conectarModalEsquema lo conecta (conectarModalFraccionadoMd). Dos tarjetas (#mDetCaja, ~70 % del ancho, y
// #mDetDer, ~30 %):
//  · izquierda = configuración del granel, en pasos numerados (cada uno es un panel .md-paso con su encabezado: título + para qué sirve; el
//    número lo pone un contador CSS en precios.html, así que sin precios-config el margen es el paso 2): 1 costo elegido (tarjetas, una fila de
//    cuatro, cada una con su acento, su "cuándo conviene" y, la elegida, "Elegida"; la de costo manual trae el campo para cargarlo), debajo en dos
//    columnas 2 el costo del granel (min/kg y máquina, costos extra, venta de pack/bulto) y 3 el margen del producto, y al final, sólo para
//    revisar, el acordeón "Cómo se conforma el costo y el precio": un panel con el mismo lenguaje que los pasos (sin número: lleva la marca
//    "Detalle") y dos apartados, A costo real y B precio, con una mini-tarjeta por presentación; cada una es una cuenta alineada (operador |
//    concepto con su detalle | importe, subtotales con línea, total destacado). Todo salvo las tarjetas y el margen va sólo con precios-config (sin él
//    el server no manda el desglose ni los extras, y el costo manual no se carga acá).
//  · derecha = precios de las presentaciones (htmlPreciosFraccMd, bajo el título "Precios de las presentaciones" y el subtítulo "por kg · con <fuente>"):
//    angosta, así que sin columnas: una tarjeta por presentación con vigente → sugerido con la fuente elegida, Δ % como chip, Δ $ y margen en
//    segunda línea y, adentro, el sub-bloque "Códigos mayoristas" con sus pack/bulto; al final, la tarjeta de los pack/bulto del granel.
// Elegir un costo o guardar un margen repinta el modal entero (guardarOpcionMd / guardarCostoEsq): la tarjeta derecha siempre
// refleja lo elegido a la izquierda. El min/kg es el propio del granel (se carga acá, vacío = el del subrubro) o el del subrubro; el ajuste
// del tramo de peso y el envase del peso de la presentación (bolsa o bobina) vienen de Configuración › Costeo Fraccionado (precios_config_fraccionado.js): acá se ven, y acá se elige bolsa o bobina por producto. Globales: esc, fmtMoney,
// claseDelta (precios_comun.js), mdEsq, mdFuente, mdDetalle, guardarCostoEsq, htmlResumenMd, htmlAvisoMd, htmlOpcionesCosto,
// opcionesCosto, manualEnTarjetaMd, htmlMargenProductoMd, htmlEdicionCostos, filasCanales, fmtSug, pesosMd, textoFuenteMd, chipDelta, pasosMinoristaMd,
// pasosMayoristaMd (precios_modal_esquema.js), API_FR
// (precios_config_fraccionado.js), getJson (precios_produccion.js), conectarProductoHf (precios_fraccionado_historial.js: el chip del historial
// de ESTE producto junto a su min/kg propio, sólo en el bloque de precios-config).
// El estado del granel en el listado (automático / activo / inactivo) se ve y se cambia en el header de la tarjeta principal (#mDetAct, con permiso de
// Configuración) y también en Configuración › Costeo Fraccionado › Subrubros y en el botón de la fila del listado.
const NODE_FR_MD = typeof module === 'object' && module.exports;
const FMT_FR_MD = NODE_FR_MD ? require('./precios_comun.js') : { esc, fmtMoney, claseDelta };
const { esc: ESC_FR_MD, fmtMoney: MONEY_FR_MD } = FMT_FR_MD;
// Estado del granel (activo / inactivo): las mismas funciones del listado (precios_listados.js, que se carga antes).
const ACT_FR_MD = () => (NODE_FR_MD ? require('./precios_listados.js') : { accionActividadLst, textoInactivoLst, textoActivoPorStockLst, textoActivoPorPresentacionesLst, conActividadLst, conMarcaMayoristaGranelLst, accionesMayoristaLst, textoReglaMayLst, AYUDA_REGLA_MAY }); // al llamar: el orden de los scripts no importa
const ESQ_FR_MD = NODE_FR_MD ? require('./precios_modal_esquema.js') : { rotuloVentaMd, TIPO_CANAL, pctMd, avisosCanalMd, filasCanales, fmtSug, pesosMd, textoFuenteMd, chipDelta, pasosMinoristaMd, pasosMayoristaMd };

// ── Puros (test/precios_modal_fraccionado.test.js) ──
// componentesCosto de una presentación (lib/precios_fraccionado_costo) por concepto. fuente = la elegida en el modal;
// mercaderiaKg = $/kg del granel con esa fuente (con sus costos extra); costoKg = el de la presentación con esa fuente; los
// dos también por unidad (× kg de la presentación; null sin costo o sin peso). insumos = las líneas de rol 'insumo' (hoy, el envase).
function resumenCosteoFraccMd(p, fuente, costosGranel) {
  const lineas = p.componentesCosto || [];
  const porUnidad = kgCosto => (kgCosto == null || !(p.pesoG > 0) ? null : Math.round(kgCosto * (p.pesoG / 1000) * 100) / 100);
  const insumos = lineas.filter(l => l.rol === 'insumo');
  const c = p.costeoPresentacion || {};
  return {
    insumos,
    subtotalInsumos: insumos.some(l => l.importe == null) ? null : Math.round(insumos.reduce((s, l) => s + l.importe, 0) * 100) / 100,
    mo: lineas.find(l => l.rol === 'mo') || null, maquina: lineas.find(l => l.rol === 'maquina') || null,
    energia: lineas.find(l => l.rol === 'energia') || null,
    porUnidad: c.porUnidad ?? null, extraKg: c.extraKg ?? null,
    mercaderiaKg: (costosGranel || {})[fuente] ?? null, costoKg: (p.costos || {})[fuente] ?? null,
    mercaderiaUnidad: porUnidad((costosGranel || {})[fuente]), costoUnidad: porUnidad((p.costos || {})[fuente]),
  };
}
// Select de la máquina del granel: "" = sin máquina (lo normal: no hay línea de máquina ni aviso); cada máquina de la configuración. Es la única
// fuente de máquina (no hay máquina por subrubro).
const opcionesMaquinaMd = (maquinas, actual) => `<option value="">Sin máquina</option>${(maquinas || [])
  .map(m => `<option value="${ESC_FR_MD(m.id)}"${m.id === actual ? ' selected' : ''}>${ESC_FR_MD(m.nombre)}</option>`).join('')}`;
// Select del envase del granel: bolsa (el default: ausente en el server = bolsa) o bobina; lo elegido es costeoGranel.envase.
const opcionesEnvaseMd = actual => [['bolsa', 'Bolsa (por defecto)'], ['bobina', 'Bobina']]
  .map(([v, t]) => `<option value="${v}"${v === (actual === 'bobina' ? 'bobina' : 'bolsa') ? ' selected' : ''}>${t}</option>`).join('');
const minMd = n => new Intl.NumberFormat('es-AR', { maximumFractionDigits: 4 }).format(n);
const conSignoMd = (n, sep = '') => `${n > 0 ? '+' : '-'}${sep}${minMd(Math.abs(n))}`;
// "(min/kg + ajuste) min/kg × kg = minutos" (c = costeoPresentacion, kg = los de la presentación). El ajuste ± del tramo de peso sólo se muestra si
// no es 0; sin min/kg (no pasa con minutos > 0) sólo los minutos.
function formulaMinutosMd(c, minutos, kg) {
  if (c.minKg == null) return `${minMd(minutos)} min`;
  const porKg = c.ajusteMinKg ? `(${minMd(c.minKg)} ${conSignoMd(c.ajusteMinKg, ' ')})` : minMd(c.minKg);
  return `${porKg} min/kg × ${minMd(kg)} kg = ${minMd(minutos)} min`;
}
// Línea de MO sin importe: sin min/kg (ni del producto ni del subrubro) o, con min/kg, minutos 0 (min/kg + ajuste del tramo ≤ 0).
const SIN_MINUTOS_MD = 'sin minutos (cargá el min/kg del subrubro en Configuración › Costeo Fraccionado o el propio del producto acá)';
const CERO_MINUTOS_MD = 'sin minutos: el min/kg más el ajuste del tramo de peso da 0';
const SIN_VALOR_ENERGIA_MD = 'la máquina tiene consumo y falta el valor de la energía (cargalo en Costos, Gastos variables, con el switch en Fraccionado)';
const motivoSinMinutosMd = avisos => ((avisos || []).includes('sinMinutos') ? SIN_MINUTOS_MD : CERO_MINUTOS_MD);
// "2 min/kg (+3 por tramo) · del subrubro": min/kg con que se costeó la presentación, su ajuste de tramo y de dónde sale (c = costeoPresentacion).
const ORIGEN_MIN_KG_MD = { granel: 'propio del producto', subrubro: 'del subrubro' };
function textoElegidoMd(c) {
  const { minKg, minKgOrigen, ajusteMinKg } = c || {};
  if (minKg == null) return 'sin min/kg';
  return [`${minMd(minKg)} min/kg${ajusteMinKg ? ` (${conSignoMd(ajusteMinKg)} por tramo)` : ''}`, ORIGEN_MIN_KG_MD[minKgOrigen]].filter(Boolean).join(' · ');
}

// ── Min/kg del granel (g = costeoGranel): textos del bloque "Tiempo, máquina y envase" y el body del PUT granel/:plu ──
// usado = cuál se usa hoy y de dónde sale (minKgOrigen); herencia = qué pasa si se deja vacío (se ve aunque el propio lo pise).
function textosMinKgMd(g) {
  const delSub = g.subrubro ? `del subrubro ${g.subrubro}` : 'del subrubro';
  const usado = g.minKgOrigen === 'granel' ? `Hoy se usa ${minMd(g.minKgPropio)} min/kg, propio de este producto.`
    : g.minKgOrigen === 'subrubro' ? `Hoy se usa ${minMd(g.minKgSubrubro)} min/kg, ${delSub}.`
      : 'Hoy no hay min/kg: sin minutos no suma mano de obra ni máquina.';
  const herencia = g.minKgSubrubro != null ? `Vacío = hereda ${minMd(g.minKgSubrubro)} min/kg ${delSub}.`
    : g.subrubro ? `Vacío = hereda el del subrubro ${g.subrubro}, que todavía no tiene min/kg.`
      : 'Vacío = hereda el del subrubro, pero este granel no tiene subrubro en SIGA.';
  return { usado, herencia };
}
const MAX_MIN_KG_MD = 600;
const ERROR_MIN_KG_MD = `Min por kg: un número de 0 a ${MAX_MIN_KG_MD} (vacío = hereda el del subrubro)`;
// { body: { minKg: número | null (vacío = vuelve a heredar), maquinaId: id | null, envase: 'bolsa' | 'bobina' } } o { error }. El server valida igual:
// esto evita el viaje con un texto roto. Cualquier envase que no sea 'bobina' va como 'bolsa' (el server borra la clave: es el default).
function bodyGranelMd(minKgTxt, maquinaId, envase) {
  const t = String(minKgTxt ?? '').trim().replace(',', '.');
  const minKg = t === '' ? null : Number(t);
  if (minKg != null && !(Number.isFinite(minKg) && minKg >= 0 && minKg <= MAX_MIN_KG_MD)) return { error: ERROR_MIN_KG_MD };
  return { body: { minKg, maquinaId: maquinaId || null, envase: envase === 'bobina' ? 'bobina' : 'bolsa' } };
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
// Nota discreta si el vinculado subió al piso del pack (regla "piso de vinculados"); sin pisoAplicado no hay nota.
const htmlNotaPisoFraccMd = r => (!r || !r.pisoAplicado || r.pisoKg == null ? ''
  : `<div class="md-sub md-fr-piso">Subió al piso del pack: antes ${r.netoSinPiso == null ? '—' : ESQ_FR_MD.pesosMd(r.netoSinPiso)}, piso ${ESQ_FR_MD.pesosMd(r.pisoKg)}/kg</div>`);
const htmlCodigoMayoristaFraccMd = m => `<li class="md-fr-cod"><div class="md-fr-cod-cab"><b>${ESC_FR_MD(ESQ_FR_MD.TIPO_CANAL[m.tipo] || m.tipo)}</b> `
  + `<span class="md-sub">PLU ${ESC_FR_MD(m.plu)}${m.unidades ? ` · × ${ESC_FR_MD(m.unidades)}` : ''}</span>${ESQ_FR_MD.avisosCanalMd(m.filas[0])}</div>`
  + `${m.nombre ? `<div class="md-fr-cod-nom">${ESC_FR_MD(m.nombre)}</div>` : ''}${m.filas.map(htmlFilaPreciosFraccMd).join('')}${htmlNotaPisoFraccMd(m.filas[0])}</li>`;
const htmlCodigosMayoristasFraccMd = (mayoristas, etiqueta) => `<ul class="md-fr-cods" aria-label="${ESC_FR_MD(etiqueta)}">${mayoristas.map(htmlCodigoMayoristaFraccMd).join('')}</ul>`;
// Bloque "Precio mayorista" de una presentación mayorista (p = la del listado; fuente = la del modal). El sugerido de la fila pública es el precio BULTO SIN IVA
// (minorista.precio); el pack (neto y con IVA) es el paso intermedio. Con desglose (permiso de Configuración): base, descuentos y netos de pack y bulto; sin él,
// sólo lo público (pack, bulto, antes y márgenes). { fijo: true } = mayorista con margen fijo del producto (sin descuento); null = no es mayorista o no hay precio.
function datosMayoristaFraccMd(p, fuente) {
  const s = p && p.mayorista === true ? (p.sugeridos || {})[fuente] : null;
  if (!s || s.error || !s.minorista) return null;
  const m = s.minorista, may = s.desglose && s.desglose.minorista ? s.desglose.minorista.mayorista : null;
  if (!may && m.minoristaOriginal == null && !m.pack && !m.bulto) return { fijo: true };
  const pk = m.pack || {}, b = m.bulto || {};
  const tipo = [m.tipoMayorista, may && may.tipoMayorista, p.mayoristaTipo].find(t => t === 'pack' || t === 'bulto') || 'bulto'; // sin dato = bulto (el default)
  return { fijo: false, tipo, conDesglose: !!may, base: may ? may.base : null, descPackPct: may ? may.descPackPct : null, descBultoPct: may ? may.descBultoPct : null,
    packNeto: tipo === 'pack' ? m.precio : (pk.neto ?? (may ? may.pack.precio : null)), packIva: pk.conIva ?? (may ? may.pack.conIva : null), packMargenPct: pk.margenPct ?? (may ? may.pack.margenPct : null),
    bultoNeto: tipo === 'bulto' ? m.precio : (b.neto ?? (may ? may.bulto.precio : null)), bultoIva: b.conIva ?? (may ? may.bulto.conIva : null), bultoMargenPct: b.margenPct ?? m.margenTotalPct ?? (may ? may.bulto.margenPct : null),
    antes: m.minoristaOriginal ?? null };
}
const TEXTO_FIJO_FR_MD = 'Margen fijo del producto: sin descuento mayorista.';
function htmlBloqueMayoristaFraccMd(d) {
  if (!d) return '';
  const cab = '<div class="md-fr-mays-t">Precio mayorista</div>';
  if (d.fijo) return `<div class="md-fr-may-bloque">${cab}<p class="md-sub">${TEXTO_FIJO_FR_MD}</p></div>`;
  const pc = n => (n == null ? '—' : ESQ_FR_MD.pctMd(n)), peso = n => ESQ_FR_MD.pesosMd(n);
  const fila = (txt, v, det = '') => `<div class="flex flex-wrap items-baseline justify-between gap-x-3"><span>${txt}</span><span class="text-right">${v}${det ? ` <span class="md-sub">${det}</span>` : ''}</span></div>`;
  const det = (...xs) => xs.filter(Boolean).join(' · ');
  const margen = n => (n == null ? '' : `margen ${pc(n)}`);
  const esPack = d.tipo === 'pack';
  const principal = n => `<b class="md-nuevo">${peso(n)}</b>`;
  const filaPack = esPack
    ? fila(d.descPackPct == null ? 'Pack sin IVA (sugerido)' : `Pack sin IVA (sugerido, −${pc(d.descPackPct)} sobre el minorista)`, principal(d.packNeto), det(d.packIva == null ? '' : `con IVA ${ESQ_FR_MD.fmtSug(d.packIva)}`, margen(d.packMargenPct)))
    : fila(d.descPackPct == null ? 'Pack' : `Pack (−${pc(d.descPackPct)})`, peso(d.packIva), det('con IVA', d.packNeto == null ? '' : `sin IVA ${ESQ_FR_MD.fmtSug(d.packNeto)}`, margen(d.packMargenPct)));
  const filaBulto = esPack
    ? fila(d.descBultoPct == null ? 'Bulto' : `Bulto (−${pc(d.descBultoPct)} sobre el pack)`, peso(d.bultoIva), det('con IVA', d.bultoNeto == null ? '' : `sin IVA ${ESQ_FR_MD.fmtSug(d.bultoNeto)}`, margen(d.bultoMargenPct)))
    : fila(d.descBultoPct == null ? 'Bulto sin IVA (sugerido)' : `Bulto sin IVA (sugerido, −${pc(d.descBultoPct)} sobre el pack)`, principal(d.bultoNeto), det(d.bultoIva == null ? '' : `con IVA ${ESQ_FR_MD.fmtSug(d.bultoIva)}`, margen(d.bultoMargenPct)));
  const filas = [
    d.base == null ? '' : fila('Minorista por kg, sin IVA (base)', peso(d.base)),
    filaPack, filaBulto,
    d.antes == null ? '' : fila('Minorista anterior (con IVA)', `<s>${peso(d.antes)}</s>`),
  ].filter(Boolean).join('');
  return `<div class="md-fr-may-bloque">${cab}<div class="md-sub flex flex-col gap-0.5">${filas}</div></div>`;
}
// Tarjeta de una presentación: nombre y Δ % arriba, PLU y peso, precios y, si tiene pack/bulto, su sub-bloque "Códigos mayoristas" adentro.
// Clasificación mayorista/minorista de la presentación (p = la presentación del listado, con mayorista y mayoristaOrigen): sólo lectura. '' sin dato.
// Con permiso de Configuración (.solo-config) lleva el toggle Minorista | Mayorista (aria-pressed) y, si la marca es manual, "Volver a automático";
// se guarda en pintarMarcasMayoristaFraccMd. Sin PLU, sin toggle.
const htmlClaseMayoristaFraccMd = p => {
  if (!p || typeof p.mayorista !== 'boolean') return '';
  const origen = p.mayoristaOrigen === 'manual' ? 'marcada a mano' : 'por peso';
  const regla = ACT_FR_MD().textoReglaMayLst(p); // '' salvo tipo por regla (2 mayoristas del granel)
  const texto = p.mayorista ? `Mayorista · ${p.mayoristaTipo === 'pack' ? 'Pack' : 'Bulto'} (${origen})` : 'Minorista';
  const aviso = regla ? ` <span class="md-sub" title="${ESC_FR_MD(ACT_FR_MD().AYUDA_REGLA_MAY)}">· ${ESC_FR_MD(regla)}</span>` : '';
  const acciones = ACT_FR_MD().accionesMayoristaLst(p); // null = sin PLU: sólo lectura
  if (!acciones) return `<div class="md-sub">${texto}${aviso}</div>`;
  const plu = ESC_FR_MD(p.plu), nom = ESC_FR_MD(p.nombre);
  const cls = 'md-may whitespace-nowrap px-2 py-0.5 border border-borde text-xs font-semibold';
  const btn = (a, extra) => `<button type="button" class="${cls} ${extra}" data-plu="${plu}" data-valor="${ESC_FR_MD(JSON.stringify(a.valor))}" ${a.valor === null ? '' : `aria-pressed="${a.pressed}" `}aria-label="${a.texto}: ${nom}">${a.texto}</button>`;
  const segs = acciones.filter(a => a.valor !== null).map(a => btn(a, a.pressed ? 'bg-ink text-white' : 'text-gris hover:bg-white')).join('');
  const auto = acciones.find(a => a.valor === null);
  return `<div class="md-sub md-may-fila flex flex-wrap items-center gap-2" data-plu="${plu}"><span>${texto}${aviso}</span><span class="solo-config inline-flex flex-wrap items-center gap-2">`
    + `<span role="group" class="inline-flex rounded overflow-hidden" aria-label="Clasificación de ${nom}">${segs}</span>`
    + (auto ? btn({ ...auto, texto: 'Volver a automático' }, 'rounded').replace(/ aria-label="[^"]*"/, ` aria-label="Volver a automático la clasificación de ${nom}"`) : '')
    + `<span class="md-may-msg text-xs" role="alert"></span></span></div>`;
};
function htmlTarjetaPresentacionFraccMd({ minorista: r, mayoristas, presentacion, fuente }) {
  const peso = textoPesoMd(r.pesoG), may = datosMayoristaFraccMd(presentacion, fuente);
  const { precios: pr, detalle } = partesPreciosFraccMd(r);
  const precios = may && !may.fijo ? `${pr} <span class="md-chip-0" title="El sugerido de una presentación mayorista es el precio ${may.tipo === 'pack' ? 'pack' : 'bulto'} sin IVA">sin IVA</span>` : pr;
  const sp = fuente === 'precio' && presentacion && presentacion.precioFijo ? (presentacion.sugeridos || {}).precio : null;
  const bolsa = sp && sp.precioPresentacion != null ? `<div class="md-sub">Precio fijo de la bolsa (con IVA): <b>${ESQ_FR_MD.pesosMd(sp.precioPresentacion)}</b></div>` : ''; // tal cual lo tipeado, no recalculado desde $/kg
  const mays = mayoristas.length ? `<div class="md-fr-mays"><div class="md-fr-mays-t">Códigos mayoristas</div>`
    + `${htmlCodigosMayoristasFraccMd(mayoristas, `Códigos mayoristas de ${r.nombre}`)}</div>` : '';
  return `<li class="md-fr-card md-fr-pres"><div class="md-fr-l1"><b>${ESC_FR_MD(r.nombre)}</b>${chipDeltaFrMd(r)}</div>`
    + `<div class="md-sub">PLU ${ESC_FR_MD(r.plu)}${peso ? ` · ${peso}` : ''}</div>${htmlClaseMayoristaFraccMd(presentacion)}<div class="md-fr-l3">${precios}${detalle}</div>${bolsa}${htmlBloqueMayoristaFraccMd(may)}${mays}</li>`;
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
  const porPlu = Object.fromEntries((f.presentaciones || []).map(p => [String(p.plu), p]));
  return `${cab}<ul class="md-fr-lista">${presentaciones.map(x => htmlTarjetaPresentacionFraccMd({ ...x, presentacion: porPlu[String(x.minorista.plu)], fuente })).join('')}${htmlTarjetaGranelFraccMd(granel)}</ul>`;
}
// Debajo de las tarjetas de costo: un bloque por columna cuando hay dos; con uno solo (sin configuración sólo queda el margen) a ancho completo.
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
const textoMinutosMd = (l, falta, c, kg) => `${formulaMinutosMd(c, l.cantidad, kg)} × ${l.costoUnit == null ? `sin costo hora (${falta})` : `${dineroDetFrMd(l.costoUnit)}/h`}`;

// Envase de la presentación (las líneas de rol 'insumo'; hay una sola): bolsa = "Bolsa <nombre> 1 × $ x"; bobina (plu '_bobina', cantidad = kg de
// bolsa, costoUnit = $/kg) = "Bobina 0,008 kg (8 g de bolsa) × $ x/kg". Sin dato (avisos sinBolsa / sinBobina) = renglón gris con el motivo.
const MOTIVO_SIN_ENVASE_MD = { sinBolsa: 'sin bolsa cargada para este peso', sinBobina: 'sin peso de bolsa para este peso' };
function lineaEnvaseMd(l) {
  const costo = l.costoUnit == null ? 'sin costo' : dineroDetFrMd(l.costoUnit);
  if (l.origen === 'bobina') return { tipo: 'sub', txt: 'Bobina', det: `${minMd(l.cantidad)} kg (${minMd(l.cantidad * 1000)} g de bolsa) × ${l.costoUnit == null ? costo : `${costo}/kg`}`, v: l.importe };
  const txt = !l.nombre ? `Bolsa PLU ${l.plu}` : /^bolsa\b/i.test(l.nombre) ? l.nombre : `Bolsa ${l.nombre}`; // sin repetir "Bolsa" si el nombre de SIGA ya lo trae
  return { tipo: 'sub', txt, det: `${minMd(l.cantidad)} × ${costo}`, v: l.importe };
}
function filasEnvaseFraccMd(r, avisos) {
  if (r.insumos.length) return [{ op: '+', txt: 'Envase', v: r.subtotalInsumos }, ...r.insumos.map(lineaEnvaseMd)];
  const motivo = avisos.map(a => MOTIVO_SIN_ENVASE_MD[a]).find(Boolean) || 'sin envase cargado';
  return [{ op: '+', txt: 'Envase', det: motivo, tipo: 'nd', v: r.subtotalInsumos }];
}

// Cuenta del costo real de una presentación con la fuente elegida: mercadería + envase + mano de obra (+ máquina, sólo si el granel tiene) = costo por unidad ÷ kg = $/kg.
function filasCostoPresFraccMd(p, fuente, costosGranel) {
  if ((p.avisosCosto || []).includes('sinPeso')) return [{ tipo: 'nota', txt: 'Sin peso en el nombre: sólo mercadería' }, { op: '=', txt: 'Costo $/kg', v: (p.costos || {})[fuente] ?? null }];
  const r = resumenCosteoFraccMd(p, fuente, costosGranel), c = p.costeoPresentacion || {}, avisos = p.avisosCosto || [], kgNum = p.pesoG / 1000, kg = minMd(kgNum);
  const conMinutos = (l, txt, falta) => ({ op: '+', txt, det: textoMinutosMd(l, falta, c, kgNum), v: l.importe });
  return [
    { txt: 'Mercadería', det: `${kg} kg × ${r.mercaderiaKg == null ? 'sin costo' : `${dineroDetFrMd(r.mercaderiaKg)}/kg`}`, v: r.mercaderiaUnidad },
    ...filasEnvaseFraccMd(r, avisos),
    r.mo ? conMinutos(r.mo, 'Mano de obra', 'cargalo en Costos con el switch en Fraccionado')
      : { op: '+', txt: 'Mano de obra', det: motivoSinMinutosMd(avisos), tipo: 'nd', v: 0 },
    ...(r.maquina ? [conMinutos(r.maquina, `Máquina ${r.maquina.nombre}`, 'cargalo en la máquina')] : []), // sin máquina no hay línea ni aviso: es lo normal
    ...(r.energia ? [conMinutos(r.energia, 'Energía', 'cargalo en Costos')] // costoUnit = kWh/h × $/kWh, por hora de trabajo
      : avisos.includes('valorEnergia') ? [{ op: '+', txt: 'Energía', det: SIN_VALOR_ENERGIA_MD, tipo: 'nd', v: 0 }] : []), // sin consumo no hay línea ni aviso
    { op: '=', txt: 'Costo real por unidad', ...(r.porUnidad == null ? { det: 'falta el costo del envase' } : {}), v: r.costoUnidad },
    { op: '÷', txt: 'Peso de la presentación', u: `${kg} kg` },
    { op: '=', txt: 'Costo real $/kg', v: r.costoKg },
  ];
}

// [operador, texto, importe] de esquema (pasosMinoristaMd / pasosMayoristaMd) → renglón de cuenta. Sin operador y sin importe (salvo el primero,
// la base de la cuenta) es una nota: los ajustes del margen ("incluye margen especial del producto…").
const filaDePasoMd = ([op, txt, v], i) => (i > 0 && !op && v == null ? { tipo: 'nota', txt } : { ...(op ? { op } : {}), txt, v: v ?? null });
// Cuentas del precio de una fila (presentación o granel) con la fuente elegida: el minorista (el granel no lo tiene: { minorista: false }) y cada
// pack/bulto con su desglose. Sin desglose de la fuente → null.
// Pasos del precio minorista. Presentación mayorista con descuento (d.minorista.mayorista): la base de la cuenta (margen de tabla, extras, IVA) es el minorista
// de antes (minoristaOriginal) y de ahí salen el pack (descuento sobre ese precio) y el bulto sin IVA (sobre el pack; es el sugerido); el margen de tabla no se muestra
// como aplicado: el efectivo del pack y del bulto van en notas. Sin descuento (minorista o margen fijo) = la cuenta de siempre.
function pasosMinoristaFraccMd(d, costoTxt) {
  const m = d.minorista, may = m.mayorista, o = m.minoristaOriginal;
  if (!may || !o) return ESQ_FR_MD.pasosMinoristaMd(d, costoTxt);
  const pasos = ESQ_FR_MD.pasosMinoristaMd({ ...d, minorista: { ...m, margenPct: o.margenPct, exacto: o.exacto, precio: o.precio } }, costoTxt);
  pasos[pasos.length - 1] = ['', 'Precio minorista de antes, con IVA (redondeado)', o.precio];
  const pc = ESQ_FR_MD.pctMd;
  const tipo = [m.tipoMayorista, may.tipoMayorista].find(t => t === 'pack' || t === 'bulto') || 'bulto';
  const hastaPack = [...pasos, ['×', `Descuento pack −${pc(may.descPackPct)}`, may.pack.exactoIva], ['=', 'Precio pack con IVA', may.pack.conIva]];
  if (tipo === 'pack') { // el pack es el resultado: sin IVA (÷ IVA) y sin aplicar el descuento de bulto
    return [...hastaPack, ['÷', `IVA ${pc(m.ivaPct)}`, may.pack.neto], ['=', 'Precio pack sin IVA (sugerido)', may.pack.precio], ['', `Margen efectivo del pack ${pc(may.pack.margenPct)}`, null]];
  }
  return [...hastaPack, ['', `Margen efectivo del pack ${pc(may.pack.margenPct)} (sin IVA ${ESQ_FR_MD.fmtSug(may.pack.precio)} por kg)`, null],
    ['×', `Descuento bulto −${pc(may.descBultoPct)} sobre el pack`, may.bulto.exactoIva], ['÷', `IVA ${pc(m.ivaPct)}`, may.bulto.neto],
    ['=', 'Precio bulto sin IVA (sugerido)', may.bulto.precio], ['', `Margen efectivo del bulto ${pc(may.bulto.margenPct)}`, null]];
}
function cuentasPrecioFraccMd(fila, fuente, { minorista = true } = {}) {
  const s = (fila.sugeridos || {})[fuente];
  if (!s || !s.desglose) return null;
  const d = s.desglose, porVinculo = d.porVinculo || {};
  return {
    minorista: minorista ? pasosMinoristaFraccMd(d, fila.componentesCosto ? 'Costo real' : 'Costo de mercadería').map(filaDePasoMd) : null, // presentación costeada = mercadería + envase + MO + máquina
    mayoristas: (fila.mayoristas || []).filter(v => porVinculo[v.plu]).map(v => ({ tipo: v.tipo, plu: v.plu, nombre: v.nombre, unidades: porVinculo[v.plu].unidades, venta: v.venta,
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
  + `<span class="md-chip-0" title="Min/kg con que se costeó (el propio del producto o el del subrubro) más el ajuste del tramo de peso">${ESC_FR_MD(textoElegidoMd(p.costeoPresentacion))}</span></div>`
  + `${subTarjetaFraccMd(p)}${htmlCuentaFraccMd(filasCostoPresFraccMd(p, fuente, costosGranel))}</li>`;
// Un pack/bulto dentro de la tarjeta de su dueño: banda con su tipo, PLU y unidades (y su nombre) y su cuenta.
const htmlCanalFraccMd = m => `<div class="md-dt-canal"><b>${ESC_FR_MD(ESQ_FR_MD.TIPO_CANAL[m.tipo] || m.tipo)}</b> `
  + `<span class="md-sub">PLU ${ESC_FR_MD(m.plu)}${m.unidades ? ` · × ${ESC_FR_MD(m.unidades)}` : ''}${ESQ_FR_MD.rotuloVentaMd(m.venta) ? ` · ${ESC_FR_MD(ESQ_FR_MD.rotuloVentaMd(m.venta))}` : ''}</span>${m.nombre ? `<div class="md-dt-canal-nom">${ESC_FR_MD(m.nombre)}</div>` : ''}</div>${htmlCuentaFraccMd(m.filas)}`;
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
  return `${costo ? htmlApartadoFraccMd('mdDetCostoH', 'A', 'Costo real por presentación', 'Mercadería + envase + mano de obra + máquina: lo que cuesta armar cada presentación, y de ahí su costo por kg.',
    `<ul class="md-dt-lista">${costo}</ul>`) : ''}`
    + htmlApartadoFraccMd('mdDetPrecioH', costo ? 'B' : '', 'Cómo se calcula el precio', 'Del costo real al precio: gastos variables, margen, extras, IVA y redondeo, por presentación y por pack/bulto.',
      precio ? `<ul class="md-dt-lista">${precio}</ul>` : `<p class="md-dt-vacio">${SIN_DESGLOSE_FR_MD}</p>`);
}

// Estado del granel en el header de la tarjeta principal: badge Activo / Inactivo con su origen (a mano / automático) y, sólo con permiso de
// Configuración (.solo-config), el botón según estado (+ "Volver a automático" si está fijado a mano). Sin botón ni estado en REEFER y "sin granel".
function htmlActividadFraccMd(f) {
  const a = ACT_FR_MD().accionActividadLst(f);
  if (!a) return '';
  const cls = 'whitespace-nowrap px-2 py-0.5 rounded border border-borde text-xs font-semibold hover:bg-white';
  const porStock = ACT_FR_MD().textoActivoPorStockLst(f);
  const nom = ESC_FR_MD(f.nombre), titulo = a.activo ? (a.fijado ? 'Fijado a mano como activo' : 'Activo según los movimientos de stock') : ACT_FR_MD().textoInactivoLst(f);
  return `<span class="inline-flex flex-wrap items-center gap-2 text-xs"><span class="font-semibold text-ink" title="${ESC_FR_MD(titulo)}">${a.activo ? 'Activo' : 'Inactivo'}</span>`
    + `<span class="text-gris">${a.fijado ? 'Fijado a mano' : 'Automático'}</span>`
    + (ACT_FR_MD().textoActivoPorPresentacionesLst(f) ? `<span class="md-por-stock md-por-presentacion px-1.5 py-0.5 rounded text-[11px] font-semibold bg-ink/10 text-ink whitespace-nowrap" title="${ESC_FR_MD(ACT_FR_MD().textoActivoPorPresentacionesLst(f))}">Activo por presentación</span>` : '')
    + (porStock ? `<span class="md-por-stock px-1.5 py-0.5 rounded text-[11px] font-semibold bg-ink/10 text-ink whitespace-nowrap" title="${ESC_FR_MD(porStock)}">Activo por stock</span>` : '')
    + `<span class="solo-config inline-flex flex-wrap items-center gap-1">`
    + `<button type="button" class="md-act ${cls}" data-valor="${a.valor}" aria-label="${a.texto} el granel ${nom}">${a.texto}</button>`
    + (a.fijado ? `<button type="button" class="md-act ${cls}" data-valor="null" aria-label="Volver a automático el estado del granel ${nom}">Volver a automático</button>` : '')
    + `</span></span><span class="md-act-msg text-xs text-crit" role="alert"></span>`;
}

if (typeof module === 'object' && module.exports) module.exports = { htmlActividadFraccMd, resumenCosteoFraccMd, opcionesMaquinaMd, opcionesEnvaseMd, formulaMinutosMd, textoElegidoMd, textosMinKgMd, bodyGranelMd,
  deltaPesosMd, textoDeltaPesosMd, textoPesoMd, filasPreciosFraccMd, agruparPreciosFraccMd, resumenVariacionFraccMd, chipsVariacionFraccMd, subtituloPreciosFraccMd, htmlPreciosFraccMd, htmlColumnasFraccMd, datosMayoristaFraccMd, htmlBloqueMayoristaFraccMd, pasosMinoristaFraccMd,
  motivoSinMinutosMd, filasCostoPresFraccMd, cuentasPrecioFraccMd, htmlCuentaFraccMd, htmlTarjetaCostoFraccMd, htmlTarjetaPrecioFraccMd, htmlCuerpoDetalleFraccMd };

// ── DOM ──
let mdFrMaquinas = null; // máquinas de Configuración › Costeo Fraccionado (se piden cada vez que se conecta el modal: una máquina nueva aparece)

// Min/kg propio del granel (vacío = hereda el del subrubro; se muestra cuál se usa hoy y cuál hereda), su máquina (la única fuente de máquina;
// "Sin máquina" es lo normal) y su envase (bolsa por defecto o bobina). Un solo Guardar manda los tres (PUT granel/:plu). Sin costeoGranel (sin migrar
// o "sin granel") no hay nada que mostrar.
const AYUDA_TIEMPO_MD = 'Minutos de armado por 1 kg de este granel. Cada presentación los multiplica por sus kg, y el ajuste de su tramo de peso '
  + '(Configuración › Costeo Fraccionado) se suma encima. Vacío = usa el del subrubro.';
const AYUDA_ENVASE_MD = 'Envase: bolsa (el PLU de SIGA cargado para el peso) o bobina (peso de la bolsa × $/kg de bobina); se cargan en Configuración › Costeo Fraccionado › Envase.';
function htmlTiempoGranelMd(f) {
  if (!f.costeoGranel) return '';
  const g = f.costeoGranel, t = textosMinKgMd(g);
  const maquinas = mdFrMaquinas || (g.maquinaId ? [{ id: g.maquinaId, nombre: g.maquina || g.maquinaId }] : []);
  const entrada = `<input id="mdFrMinKg" type="number" min="0" max="${MAX_MIN_KG_MD}" step="any" value="${esc(g.minKgPropio ?? '')}" placeholder="${esc(g.minKgSubrubro ?? '')}" aria-describedby="mdFrAyuda">`;
  return `<div class="md-edicion" id="mdFr">
    <div class="md-sb-t">Tiempo, máquina y envase <span class="md-sub">· ${g.subrubro ? `subrubro ${esc(g.subrubro)}` : 'sin subrubro en SIGA'}</span></div>
    <p class="md-sb-ayuda">${AYUDA_TIEMPO_MD}</p>
    <div class="flex flex-wrap items-end gap-3">
      <div><label for="mdFrMinKg" class="block text-sm mb-1">Min por kg</label>${campoU(entrada, 'min/kg', { w: 'w-36' })}</div>
      <div><label for="mdFrMaquina" class="block text-sm mb-1">Máquina</label><select id="mdFrMaquina" class="num-in text-left">${opcionesMaquinaMd(maquinas, g.maquinaId)}</select></div>
      <div><label for="mdFrEnvase" class="block text-sm mb-1">Envase</label><select id="mdFrEnvase" class="num-in text-left" aria-describedby="mdFrAyuda">${opcionesEnvaseMd(g.envase)}</select></div>
      <button type="button" id="mdFrGuardar" class="cfg-btn2">Guardar</button></div>
    <div id="mdFrHist" class="hf-modal"></div>
    <p id="mdFrAyuda" class="md-sb-ayuda mt-2">${esc(t.usado)} ${esc(t.herencia)} La máquina es opcional: si elegís una, suma los mismos minutos × su costo hora. ${AYUDA_ENVASE_MD}</p>
    <p id="mdFrMsg" class="text-sm mt-1" role="status" aria-live="polite"></p></div>`;
}

// ── Layout a dos tarjetas ──
// "Costo del granel" (sólo con precios-config): min/kg y máquina, costos extra y venta de pack/bulto pesables. (El costo manual se carga en su tarjeta de decisión.)
const htmlCostoGranelMd = f => (preciosSinConfig ? '' : `<section class="md-fr-sec md-paso" aria-labelledby="mdCostoH">
  <div class="md-paso-cab"><h4 id="mdCostoH" class="md-h">Costo del granel <span class="md-sub">· $/kg</span></h4>
    <p class="md-paso-para">Se suma al costo elegido en el paso 1 y cambia el precio de todas las presentaciones.</p></div>
  <div class="md-paso-cuerpo">${htmlTiempoGranelMd(f)}${htmlEdicionCostos(f)}</div></section>`);

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
// tarjeta de costo manual siempre está, para cargarlo desde ahí), en dos columnas el costo del granel y el margen del producto,
// y cómo se conforma el costo y el precio. Derecha (#mDetDerBody): precios de las presentaciones con la fuente elegida (mdFuente).
function pintarModalFraccionadoMd() {
  const { tipo, fila: f } = mdEsq;
  const ops = opcionesCosto(f, tipo, { manualSiempre: manualEnTarjetaMd(tipo), precioSiempre: true }); // precios_modal_esquema.js
  const abajo = htmlColumnasFraccMd(htmlCostoGranelMd(f), htmlMargenProductoMd(f));
  document.getElementById('mDetBody').innerHTML = `${htmlResumenMd(f, tipo)}${htmlAvisoMd(f, ops)}${htmlOpcionesCosto(f, ops)}${abajo}${htmlDetalleFraccMd(f)}`;
  document.getElementById('mDetDerSub').textContent = subtituloPreciosFraccMd(f, mdFuente);
  document.getElementById('mDetDerBody').innerHTML = htmlPreciosFraccMd(f, mdFuente);
  conectarModalEsquema(); // precios_modal_esquema.js: tarjetas, edición de costos y margen; llama a conectarModalFraccionadoMd
  pintarActividadFraccMd();
  pintarMarcasMayoristaFraccMd();
}

// Header (#mDetAct): estado y botones del granel. Guardar = guardarActividadLst del listado (PUT, fila de atrás refrescada y visible aunque "Ver inactivos"
// esté apagado); acá se actualiza mdEsq.fila y se repinta sólo el header. Falla → error visible y todo queda como estaba.
function pintarActividadFraccMd(foco = false) {
  const cont = document.getElementById('mDetAct');
  if (!cont) return;
  cont.innerHTML = htmlActividadFraccMd(mdEsq.fila);
  const botones = [...cont.querySelectorAll('.md-act')], msg = cont.querySelector('.md-act-msg');
  botones.forEach(b => {
    b.onclick = async () => {
      const valor = JSON.parse(b.dataset.valor), plu = mdEsq.fila.plu;
      botones.forEach(x => { x.disabled = true; });
      msg.textContent = '';
      try {
        await guardarActividadLst(mdEsq.tipo, plu, valor); // precios_listados.js
      } catch (e) {
        botones.forEach(x => { x.disabled = false; });
        msg.textContent = `No se pudo cambiar el estado: ${e.message}`;
        return;
      }
      if (!mdEsq || mdEsq.fila.plu !== plu) return; // se cerró o se abrió otro producto mientras guardaba
      mdEsq = { ...mdEsq, fila: ACT_FR_MD().conActividadLst(mdEsq.fila, valor) };
      pintarActividadFraccMd(true);
    };
  });
  if (foco) { const primero = cont.querySelector('.md-act'); if (primero) primero.focus(); }
}

// Toggle Minorista | Mayorista de cada presentación (card derecha). Guardar = guardarMarcaMayoristaLst del listado (PUT, subfila de atrás refrescada);
// acá se actualiza la presentación en mdEsq.fila, se repinta sólo la card derecha y se recarga el detalle (pack/bulto dependen de la clasificación).
// Falla → error visible junto al toggle y todo queda como estaba. Es un único onclick delegado: repintar la card no acumula handlers.
function pintarMarcasMayoristaFraccMd() {
  const cont = document.getElementById('mDetDerBody');
  if (!cont) return;
  cont.onclick = async e => {
    const b = e.target.closest('.md-may');
    if (!b || b.disabled || b.getAttribute('aria-pressed') === 'true') return;
    const fila = b.closest('.md-may-fila'), plu = b.dataset.plu, valor = JSON.parse(b.dataset.valor), granel = mdEsq.fila.plu;
    const botones = [...fila.querySelectorAll('.md-may')], msg = fila.querySelector('.md-may-msg');
    botones.forEach(x => { x.disabled = true; });
    msg.textContent = ''; msg.classList.remove('text-crit');
    let umbral, avisoListado = '';
    try {
      umbral = await guardarMarcaMayoristaLst(mdEsq.tipo, plu, valor); // precios_listados.js
    } catch (err) {
      if (!err.marcaGuardada) {
        botones.forEach(x => { x.disabled = false; });
        msg.classList.add('text-crit'); // sólo con error (el color no debe estar en el HTML vacío)
        msg.textContent = `No se pudo cambiar la marca: ${err.message}`;
        return;
      }
      avisoListado = err.message; // la marca se guardó; sólo falló refrescar el listado de atrás: se muestra tras repintar
    }
    if (!mdEsq || mdEsq.fila.plu !== granel) return; // se cerró o se abrió otro producto mientras guardaba
    const conMarca = ACT_FR_MD().conMarcaMayoristaGranelLst;
    const aplicar = f => ({ ...f, presentaciones: conMarca(f.presentaciones, plu, valor, umbral) });
    mdEsq = { ...mdEsq, fila: aplicar(mdEsq.fila) };
    repintarPreciosFraccMd(plu, valor);
    try { // detalle fresco del server (mismo endpoint que al abrir); si falla queda lo local y se avisa
      const nueva = await (await fetch(`/api/precios/esquema/detalle/${encodeURIComponent(granel)}?tipo=${encodeURIComponent(mdEsq.tipo)}`)).json();
      if (nueva.error) throw new Error(nueva.error);
      if (!mdEsq || mdEsq.fila.plu !== granel) return;
      mdEsq = { ...mdEsq, fila: aplicar(nueva) };
      repintarModalCompletoFraccMd(plu, valor);
    } catch (err) {
      avisoListado = `La marca se guardó, pero no se pudo actualizar el detalle (${err.message}). Cerrá y volvé a abrir el producto.`;
    }
    if (avisoListado) avisarMarcaFraccMd(plu, avisoListado);
  };
}
function avisarMarcaFraccMd(plu, texto) {
  const f = [...document.querySelectorAll('#mDetDerBody .md-may-fila')].find(x => x.dataset.plu === String(plu));
  const msg = f && f.querySelector('.md-may-msg');
  if (!msg) return;
  msg.classList.add('text-crit');
  msg.textContent = texto;
}
// Repinta las dos tarjetas con el detalle nuevo (mdEsq) sin pisar lo que se está editando a la izquierda: los campos con id cuyo valor difiere del
// original (borrador sin guardar) se restauran y reciben un "input" para que sus handlers recalculen; scroll de ambas tarjetas y foco se conservan.
function repintarModalCompletoFraccMd(plu, valor) {
  const izq = document.getElementById('mDetBody'), der = document.getElementById('mDetDerBody');
  const campos = [...izq.querySelectorAll('input[id],textarea[id],select[id]')];
  const esCheck = c => c.type === 'checkbox';
  const sucios = campos.filter(c => c.type !== 'radio' && (esCheck(c) ? c.checked !== c.defaultChecked : c.value !== c.defaultValue))
    .map(c => ({ id: c.id, valor: esCheck(c) ? c.checked : c.value }));
  const act = document.activeElement;
  const focoIzq = act && izq.contains(act) && act.id ? act.id : null;
  const focoDer = !!act && der.contains(act);
  const tops = [izq.scrollTop, der.scrollTop];
  pintarModalFraccionadoMd();
  sucios.forEach(({ id, valor: v }) => {
    const c = document.getElementById(id);
    if (!c) return;
    if (esCheck(c)) c.checked = v; else c.value = v;
    c.dispatchEvent(new Event('input', { bubbles: true }));
  });
  document.getElementById('mDetBody').scrollTop = tops[0];
  document.getElementById('mDetDerBody').scrollTop = tops[1];
  if (focoIzq) { const c = document.getElementById(focoIzq); if (c) c.focus(); }
  else if (focoDer) {
    const f = [...document.querySelectorAll('#mDetDerBody .md-may-fila')].find(x => x.dataset.plu === String(plu));
    const b = f && (f.querySelector(`.md-may[data-valor="${valor}"]`) || f.querySelector('.md-may'));
    if (b) b.focus();
  }
}
function repintarPreciosFraccMd(plu, valor, foco = true) {
  const cont = document.getElementById('mDetDerBody');
  const activo = !foco && document.activeElement && cont.contains(document.activeElement);
  cont.innerHTML = htmlPreciosFraccMd(mdEsq.fila, mdFuente);
  const f = [...cont.querySelectorAll('.md-may-fila')].find(x => x.dataset.plu === String(plu));
  const b = f && (f.querySelector(`.md-may[data-valor="${valor}"]`) || f.querySelector('.md-may'));
  if (b && (foco || activo)) b.focus();
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
function conectarModalFraccionadoMd() { conectarCosteoFraccMd(); conectarDetalleFraccMd(); conectarPrecioFijoFraccMd(); }

// ── Card "Precio fijo" (costeo.precioFijo[pluPresentación].minorista = precio de la BOLSA con IVA) ──
// Un campo por presentación no mayorista y con peso; vacío = margen general. "Usar" guarda cada precio (PUT precio-fijo/:plu de la presentación) y
// elige la decisión 'precio' del granel; "Quitar" borra todos (el server limpia la decisión). Reusa msgDecisionMd, guardarDecision y los
// ids mdPfUsar / mdPfQuitar de la card de Reventa. El margen en vivo usa el desglose (sólo con precios-config); la bolsa se muestra como se tipeó.
const presentacionesPfMd = f => (f.presentaciones || []).filter(p => p.plu != null && p.mayorista !== true && p.pesoG > 0);
const idPfMd = (pre, p) => `${pre}-${String(p.plu).replace(/[^\w-]/g, '_')}`;
function htmlPrecioFijoFraccMd(f) {
  const pres = presentacionesPfMd(f);
  const campos = pres.map(p => {
    const margen = preciosSinConfig ? '' : `<span id="${idPfMd('mdPfMargen', p)}" class="md-pf-margen tabular-nums"></span>`;
    const describe = preciosSinConfig ? '' : ` aria-describedby="${idPfMd('mdPfMargen', p)}"`;
    const valor = (p.precioFijo || {}).minorista;
    return `<span class="md-pf-campo"><span>${ESC_FR_MD(p.nombre)} <span class="md-sub">· ${textoPesoMd(p.pesoG)}</span></span>
      ${campoU(`<input type="number" min="0" step="any" id="${idPfMd('mdPf', p)}" class="md-pf-in" value="${ESC_FR_MD(valor ?? '')}" placeholder="general" aria-label="Precio fijo de la bolsa ${ESC_FR_MD(p.nombre)} en pesos"${describe}>`, '$', { pre: true, w: 'w-full' })}${margen}</span>`;
  }).join('');
  const sinCosto = fuenteRefMd(f) == null || !pres.length;
  const hay = pres.some(p => p.precioFijo);
  return `<span class="md-opc-manual md-opc-pf">${campos || '<span class="md-opc-extra">Sin presentaciones con peso.</span>'}
    <span class="md-opc-extra">Precio de la bolsa con IVA. Vacío = margen general. El granel y los mayoristas no llevan precio fijo.</span>
    <span class="flex items-center gap-2"><button type="button" id="mdPfUsar" class="cfg-btn2"${sinCosto ? ' disabled title="Sin costo cargado o sin presentaciones: no se puede calcular el precio"' : ''}>Usar</button>
    ${hay ? '<button type="button" id="mdPfQuitar" class="text-sm text-gris hover:text-crit">Quitar</button>' : ''}</span></span>`;
}
// Margen que deja cada bolsa tipeada: el precio por kg (bolsa ÷ kg) contra el costo de la presentación (margenesDePrecioMd); sólo para el margen, nunca se muestra.
function pintarMargenesPfFraccMd() {
  const ref = fuenteRefMd(mdEsq.fila) || 'sistema';
  for (const p of presentacionesPfMd(mdEsq.fila)) {
    const s = document.getElementById(idPfMd('mdPfMargen', p));
    if (!s) continue;
    const bolsa = numOrNull(document.getElementById(idPfMd('mdPf', p)).value);
    const m = bolsa > 0 ? margenesDePrecioMd(p, ref, { minorista: Math.round(((bolsa * 1000) / p.pesoG) * 100) / 100 }).minorista : null;
    s.textContent = m == null ? '' : `Margen ${ESQ_FR_MD.pctMd(m)}`;
  }
}
// Guarda (o borra) cada precio y, con usar, elige la decisión 'precio'; recarga modal y listado. Primero los que se cargan y después los que se vacían.
async function guardarPrecioFijoFraccMd(cambios, usar) {
  const { tipo, fila: f } = mdEsq;
  msgDecisionMd('', '<span class="spin"></span> Guardando…');
  try {
    for (const [plu, minorista] of [...cambios].sort((a, b) => (b[1] != null) - (a[1] != null))) {
      await pedirJson('PUT', `/api/precios/precio-fijo/${encodeURIComponent(plu)}`, { minorista }); // precios_comun.js
    }
    if (usar) await guardarDecision(f.plu, 'precio'); // precios_listados.js
    await abrirModalEsquema(tipo, f.plu, { detalle: mdDetalle });
    cargarListado(tipo);
    msgDecisionMd('text-ok', `✓ Guardado · ${esc(estadoDecision(mdEsq.fila, tipo).texto.toLowerCase())}`);
  } catch (e) { msgDecisionMd('text-crit', `No se pudo guardar: ${esc(e.message)}`); }
}
function conectarPrecioFijoFraccMd() {
  const usar = document.getElementById('mdPfUsar');
  if (!usar || mdEsq.tipo !== 'fraccionado') return;
  const pres = presentacionesPfMd(mdEsq.fila);
  const campo = p => document.getElementById(idPfMd('mdPf', p));
  pres.forEach(p => {
    campo(p).oninput = pintarMargenesPfFraccMd;
    campo(p).onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); usar.click(); } };
  });
  usar.onclick = () => {
    const nuevos = pres.map(p => [p, numOrNull(campo(p).value)]);
    if (nuevos.every(([, v]) => v == null)) return msgDecisionMd('text-crit', 'Cargá al menos un precio.');
    const cambios = nuevos.filter(([p, v]) => v !== ((p.precioFijo || {}).minorista ?? null)).map(([p, v]) => [p.plu, v]);
    return guardarPrecioFijoFraccMd(cambios, true);
  };
  const quitar = document.getElementById('mdPfQuitar');
  if (quitar) quitar.onclick = () => guardarPrecioFijoFraccMd(pres.filter(p => p.precioFijo).map(p => [p.plu, null]), false);
  pintarMargenesPfFraccMd();
}

function conectarCosteoFraccMd() {
  if (!document.getElementById('mdFr')) return;
  const g = mdEsq.fila.costeoGranel;
  getJson(API_FR).then(cfg => {
    mdFrMaquinas = cfg.maquinas.map(({ id, nombre }) => ({ id, nombre }));
    const sel = document.getElementById('mdFrMaquina');
    if (!sel) return;
    const v = sel.value;
    sel.innerHTML = opcionesMaquinaMd(mdFrMaquinas, g.maquinaId);
    if ([...sel.options].some(o => o.value === v)) sel.value = v;
  }).catch(e => mostrarErrorFrMd(`No se pudieron leer las máquinas: ${e.message}`));
  const minKg = document.getElementById('mdFrMinKg');
  const guardar = document.getElementById('mdFrGuardar');
  guardar.onclick = () => {
    const r = bodyGranelMd(minKg.value, document.getElementById('mdFrMaquina').value, document.getElementById('mdFrEnvase').value);
    if (r.error) { mostrarErrorFrMd(r.error); minKg.setAttribute('aria-invalid', 'true'); minKg.focus(); return; }
    minKg.removeAttribute('aria-invalid');
    guardarCostoEsq(`${API_FR}/granel/${encodeURIComponent(mdEsq.fila.plu)}`, r.body, 'PUT', 'mdFrMsg');
  };
  minKg.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); guardar.click(); } };
  conectarProductoHf({ slot: document.getElementById('mdFrHist'), input: minKg, plu: mdEsq.fila.plu, msg: document.getElementById('mdFrMsg') }); // historial (una sola carga para todo el módulo)
}
function mostrarErrorFrMd(texto) {
  const m = document.getElementById('mdFrMsg');
  if (m) { m.className = 'text-sm mt-1 text-crit'; m.textContent = texto; }
}
