// ── Precios · modal del producto con el esquema por canal (spec 2026-10-07 §3.2) ──
// Arriba: nombre, PLU, tipo, precio vigente y estado ("Sin cambios" / "Se exporta con …"). Paso principal: tarjetas de
// costo (radios reales: No cambiar / Costo sistema / Última compra / Costo manual; Producción: No cambiar / Aumentar)
// que GUARDAN la decisión al elegir. Debajo, la tabla por canal (vigente, nuevo, Δ%, margen total) del costo elegido.
// "Ver detalle" sólo existe con el permiso precios-config (y sólo entonces el server manda desglose y costos extra):
// desglose por canal + costos extra + venta de pesables (el costo manual se carga en su tarjeta de decisión). Fraccionado arma su propio
// layout a dos tarjetas (pintarModalFraccionadoMd, precios_modal_fraccionado.js: configuración del granel a la izquierda, ~70 %,
// precios de las presentaciones y su variación a la derecha, ~30 %) con estas mismas piezas. Globales: el modal compartido #mDet (abrirModal,
// cerrarDetalle) y formato/pedidos de precios_comun.js; de precios_listados.js: guardarDecision, renderListado,
// cargarListado; de precios_config.js: activarTab; de precios_produccion.js: salirDeProduccion, refrescarAlertasProduccion.
const TIPO_CANAL = { pack: 'Pack', bulto: 'Bulto' };

// Filas de la tabla por canal para una fuente. Fraccionado: una fila minorista por presentación ($/kg); el granel sólo
// aporta sus pack/bulto. Pack/bulto: sin IVA (contra el vigente: SIGA lo guarda sin IVA) y con IVA (sin vigente ni Δ).
// tipo = 'minorista' | 'pack' | 'bulto'; conIva = null en minorista; pesoG = gramos de la presentación (null sin peso).
function filasCanales(fila, fuente) {
  const filas = [];
  const sumar = (f, etiqueta) => {
    const s = (f.sugeridos || {})[fuente];
    const ok = s && !s.error ? s : null;
    if (etiqueta) {
      filas.push({ canal: etiqueta, tipo: 'minorista', conIva: null, plu: f.plu, nombre: f.nombre, pesoG: f.pesoG ?? null, vigente: f.vigente ?? null,
        sugerido: ok ? ok.minorista.precio : null, deltaPct: ok ? ok.minorista.deltaPct : null, estado: ok ? ok.minorista.estado : null,
        margenTotalPct: ok ? ok.minorista.margenTotalPct : null });
    }
    for (const m of f.mayoristas || []) {
      const p = ok ? ok.mayoristas.find(x => x.plu === m.plu) : null;
      const base = { tipo: m.tipo, plu: m.plu, nombre: m.nombre, unidades: m.unidades, faltante: p ? p.faltante : null };
      filas.push({ ...base, canal: `${TIPO_CANAL[m.tipo]} sin IVA`, conIva: false, vigente: m.vigente ?? null, sugerido: p ? p.neto : null,
        deltaPct: p ? p.deltaPct : null, estado: p ? p.estado : null, revisarUnidad: !!(p && p.revisarUnidad), margenTotalPct: p ? p.margenTotalNetoPct : null });
      filas.push({ ...base, canal: `${TIPO_CANAL[m.tipo]} con IVA`, conIva: true, vigente: null, sugerido: p ? p.conIva : null, deltaPct: null, estado: null,
        margenTotalPct: p ? p.margenTotalIvaPct : null });
    }
  };
  if (Array.isArray(fila.presentaciones)) {
    sumar(fila, null);
    fila.presentaciones.forEach(p => sumar(p, `Minorista · ${p.nombre}`));
  } else sumar(fila, 'Minorista');
  return filas;
}

// Opciones del selector de costo: { valor ('' = No cambiar, o la fuente), texto, costo, precio, deltaPct, estado,
// disponible, motivo }. precio/Δ% = minorista con ese costo (No cambiar: el vigente). Fraccionado: sin precio único; Δ% =
// promedio de las presentaciones (n = cuántas). Manual sólo si hay costo manual (o es la decisión guardada). Sin
// sugerido → no se puede elegir (salvo que sea la decisión guardada) y motivo dice por qué.
const TXT_OPCION = { sistema: 'Costo sistema', ultimaCompra: 'Última compra', manual: 'Costo manual', precio: 'Precio fijo' };
const COSTO_FUENTE = { sistema: 'costoSistema', ultimaCompra: 'costoUltimaCompra', manual: 'costoManual' };
const MOTIVO_SIN_COSTO = { sistema: 'Sin costo de sistema en SIGA', ultimaCompra: 'Sin compras registradas', manual: 'Sin costo manual', precio: 'Sin precio fijo' };
const MOTIVO_ERROR = { margen: 'Faltan configurar los márgenes', gastos: 'Revisar los gastos variables', costo: 'Costo inválido' };
const sugeridoDe = (f, fuente) => (f.sugeridos || {})[fuente] || null;
// Fuente del costo de referencia del precio fijo (Reventa): la que usó el server (sugeridos.precio.fuenteRef) o, si todavía no hay precio
// guardado, la primera con sugerido (sistema › última compra › manual, el mismo orden que el server). Sin ninguna → null.
const FUENTES_REF_MD = ['sistema', 'ultimaCompra', 'manual'];
const fuenteRefMd = fila => {
  const s = sugeridoDe(fila, 'precio');
  return (s && s.fuenteRef) || FUENTES_REF_MD.find(f => { const x = sugeridoDe(fila, f); return x && !x.error; }) || null;
};
// Card "Precio fijo" (costeo.precioFijo): un campo por canal. Minorista siempre; Pack y Bulto sólo si el producto tiene ese tipo de vínculo.
const CANALES_PF_MD = [['minorista', 'Minorista'], ['pack', 'Pack'], ['bulto', 'Bulto']];
const canalesPrecioFijoMd = fila => CANALES_PF_MD.filter(([c]) => c === 'minorista' || (fila.mayoristas || []).some(m => m.tipo === c));
// Body del PUT /api/precios/precio-fijo/:plu: un valor por canal; null = sin precio en ese canal (también los canales sin vínculo: lo guardado
// se reemplaza entero). valores = { canal: número | null } (numOrNull de lo tipeado). El 0 pasa tal cual: lo rechaza el server con su mensaje.
const payloadPrecioFijoMd = (valores = {}) => Object.fromEntries(CANALES_PF_MD.map(([c]) => [c, valores[c] ?? null]));
function resumenMinorista(fila, fuente) {
  const okDe = f => { const s = sugeridoDe(f, fuente); return s && !s.error ? s : null; };
  const error = (sugeridoDe(fila, fuente) || {}).error || null;
  if (Array.isArray(fila.presentaciones)) {
    const ds = fila.presentaciones.map(p => okDe(p)).filter(s => s && s.minorista.deltaPct != null).map(s => s.minorista.deltaPct);
    return { precio: null, deltaPct: ds.length ? Math.round((ds.reduce((a, b) => a + b, 0) / ds.length) * 10) / 10 : null, estado: null,
      ok: !!okDe(fila), error, n: fila.presentaciones.length };
  }
  const s = okDe(fila);
  return { precio: s ? s.minorista.precio : null, deltaPct: s ? s.minorista.deltaPct : null, estado: s ? s.minorista.estado : null, ok: !!s, error, n: null };
}
// manualSiempre / precioSiempre: el modal de Reventa muestra las tarjetas de costo manual y de precio fijo aunque no haya dato (se cargan
// en su tarjeta). 'precio' (sólo Reventa) = precio fijo de costeo.precioFijo; el select del listado lo ofrece sólo con precio fijo
// guardado (o si es la decisión guardada).
function opcionesCosto(fila, tipo, { manualSiempre = false, precioSiempre = false } = {}) {
  const actual = fila.decision ? fila.decision.fuente : null;
  const conPrecio = tipo === 'almacen' && (precioSiempre || fila.precioFijo != null || actual === 'precio');
  const fuentes = tipo === 'produccion' ? ['sistema']
    : ['sistema', 'ultimaCompra', ...(manualSiempre || fila.costoManual != null || actual === 'manual' ? ['manual'] : []), ...(conPrecio ? ['precio'] : [])];
  const noCambiar = { valor: '', texto: 'No cambiar', costo: null, precio: fila.vigente ?? null, deltaPct: null, estado: null, disponible: true, motivo: null };
  return [noCambiar, ...fuentes.map(f => {
    const r = resumenMinorista(fila, f);
    const costo = f === 'precio' ? null : (fila[COSTO_FUENTE[f]] ?? null); // el precio fijo muestra sus campos, no un costo
    const sinDato = tipo === 'produccion' ? 'La receta no tiene costo' : f === 'precio' && fila.precioFijo ? 'Sin costo para calcular el margen' : MOTIVO_SIN_COSTO[f];
    const motivo = r.ok ? null : r.error ? MOTIVO_ERROR[r.error] || 'No se pudo calcular el precio' : sinDato;
    return { valor: f, texto: tipo === 'produccion' ? 'Aumentar' : TXT_OPCION[f], costo, precio: r.precio, deltaPct: r.deltaPct, estado: r.estado,
      disponible: r.ok || f === actual, motivo, n: r.n };
  })];
}

// <select> de decisión de los listados (precios_listados.js y la tabla de códigos de Envasado): las mismas opciones, precios y Δ%
// que el modal (opcionesCosto) con texto compacto: "No cambiar", "Sistema · $ 1.800 (+3.2%)" (Fraccionado: "Sistema · prom. +3.2%",
// el promedio de las presentaciones; Producción: "Aumentar · …"). Sin precio → "Última compra · Sin compras registradas" y
// deshabilitada (salvo la decisión guardada, que se ve aunque ya no tenga precio). → [{ valor, texto, disabled }].
const ETIQUETA_SELECT = { sistema: 'Sistema', ultimaCompra: 'Última compra', manual: 'Manual', precio: 'Precio fijo' };
const FMT_MD = typeof module === 'object' && module.exports ? require('./precios_comun.js') : { esc, fmtMoney, fmtPrecio, fmtPct };
function textoOpcionSelect(o, tipo, fracc) {
  if (o.valor === '') return 'No cambiar';
  const nombre = tipo === 'produccion' ? o.texto : ETIQUETA_SELECT[o.valor] || o.texto;
  if (!o.disponible || o.motivo) return `${nombre} · ${o.motivo || 'Sin precio'}`;
  const delta = o.deltaPct == null ? null : FMT_MD.fmtPct(o.deltaPct);
  if (fracc) return `${nombre} · ${delta == null ? 'sin vigente' : `prom. ${delta}`}`;
  return `${nombre} · $ ${FMT_MD.fmtPrecio(o.precio)}${delta == null ? '' : ` (${delta})`}`;
}
const opcionesSelect = (fila, tipo) => opcionesCosto(fila, tipo)
  .map(o => ({ valor: o.valor, texto: textoOpcionSelect(o, tipo, Array.isArray(fila.presentaciones)), disabled: !o.disponible }));

// Primer error del motor en la fila (granel o presentaciones), por cualquier fuente: 'margen' | 'gastos' | 'costo' | null.
function errorMotor(fila) {
  const filas = [fila, ...(fila.presentaciones || [])];
  for (const f of filas) for (const s of Object.values(f.sugeridos || {})) if (s && s.error) return s.error;
  return null;
}

// Porcentaje con coma y hasta 2 decimales ("35,5 %") y avisos de un canal pack/bulto (sin unidades vinculadas, o vigente de SIGA
// que parece estar en otra unidad). Los usan la tabla por canal y la tarjeta de precios de Fraccionado.
const pctMd = n => `${String(+(+n).toFixed(2)).replace('.', ',')} %`;
const avisosCanalMd = r => (r.faltante === 'unidades' ? ' <span class="md-warn">sin unidades</span>' : '')
  + (r.revisarUnidad ? ' <span class="md-warn" title="El vigente de SIGA parece estar en otra unidad">revisar unidad</span>' : '');

// Estado de la decisión para el encabezado y el aviso de guardado: { exporta, texto }.
function estadoDecision(fila, tipo) {
  if (!fila.decision) return { exporta: false, texto: 'Sin cambios · no se exporta' };
  const f = fila.decision.fuente;
  return { exporta: true, texto: tipo === 'produccion' ? 'Se exporta con aumento' : `Se exporta con ${(TXT_OPCION[f] || f).toLowerCase()}` };
}

// Modo de venta de un pack/bulto pesable → pedido a /api/precios/pack-bulto/venta/:plu. Por kg = el default: se borra.
const PESO_MAX_KG_MD = 1000; // mismo tope que lib/precios_pack_bulto
function ventaPayload(modo, pesoKg) {
  if (modo !== 'paquete') return { metodo: 'DELETE' };
  if (!(pesoKg > 0 && pesoKg <= PESO_MAX_KG_MD)) return { error: `Por paquete: poné el peso del paquete (más de 0 y hasta ${PESO_MAX_KG_MD} kg).` };
  return { metodo: 'PUT', body: { modo: 'paquete', pesoKg } };
}

// Producción: líneas de costo por unidad (lib/precios_produccion, campo rol) agrupadas en los tres conceptos del costo real:
// mercadería (granel, materias primas o la receta), insumos (envase, etiqueta…) y mano de obra. subtotal null si a una línea
// le falta costo. La usan el "Ver detalle" de acá, el modal de presentación y el editor de envasado (precios_produccion_*.js).
const ROL_CONCEPTO = { granel: 'mercaderia', mp: 'mercaderia', empaque: 'insumos', insumo: 'insumos', mo: 'mo' };
function conceptosCosto(lineas) {
  const de = c => (lineas || []).filter(l => (ROL_CONCEPTO[l.rol] || 'mercaderia') === c);
  const sub = ls => (ls.some(l => l.importe == null) ? null : Math.round(ls.reduce((s, l) => s + l.importe, 0) * 100) / 100);
  const mercaderia = de('mercaderia'), insumos = de('insumos');
  return { mercaderia: { lineas: mercaderia, subtotal: sub(mercaderia) }, insumos: { lineas: insumos, subtotal: sub(insumos) }, mo: de('mo')[0] || null };
}

// "Igualar a SIGA": margen fijo por canal con el que el precio queda en el vigente de SIGA (motor: margenParaPrecio). Costo = el
// elegido en el modal (No cambiar → sistema; fuente sin desglose → sistema). Usa el desglose (sólo viene con el permiso): costo
// con gastos, extras e IVA, el de cada fila (Fraccionado: cada presentación con su $/kg real; sin desglose, no aporta). Varios
// vigentes en un canal (presentaciones de Fraccionado, varios pack/bulto vinculados) → la mediana, con una nota del Δ aprox. con que quedan. Canal sin vigente → sin valor (queda el general).
// → { valores: { canal: margen }, notas: [texto], motivo (por qué no se puede, o null), fuente (la usada) }.
const PE_MD = typeof module === 'object' && module.exports ? require('../../lib/precios_esquema') : PreciosEsquema;
const QUIENES_IGUALAR_MD = { minorista: 'las presentaciones', pack: 'los pack vinculados', bulto: 'los bulto vinculados' };
const pct1Md = n => `${n > 0 ? '+' : ''}${(Math.round(n * 10) / 10 || 0).toFixed(1).replace('.', ',')} %`;
function medianaMd(xs) {
  const s = [...xs].sort((a, b) => a - b), k = Math.floor(s.length / 2);
  return s.length % 2 ? s[k] : Math.round(((s[k - 1] + s[k]) / 2) * 100) / 100;
}
function igualarSigaMd(fila, tipo, fuente) {
  const des = (f, fu) => ((f.sugeridos || {})[fu] || {}).desglose || null;
  const costoDe = fuente === 'precio' ? fuenteRefMd(fila) || 'sistema' : fuente; // el precio fijo no es un costo: se iguala con el de referencia
  const usada = des(fila, costoDe) ? costoDe : 'sistema';
  if (!des(fila, usada)) return { valores: {}, notas: [], motivo: 'Sin costo para calcular el margen', fuente: usada };
  // Cada fila (el granel y cada presentación de Fraccionado, que tiene su propio $/kg real) con su propio desglose; sin él, sin margen.
  const margen = (f, canal, vigente, unidades) => {
    const d = des(f, usada);
    if (!d) return null;
    const cfg = { extrasMinorista: [{ pct: d.minorista.extrasPct, tipos: { [tipo]: true } }], ivaVentaPct: d.minorista.ivaPct };
    return PE_MD.margenParaPrecio({ tipo, canal, costo: d.costoConGastos, precioObjetivo: vigente, unidades, cfg });
  };
  const filas = [fila, ...(fila.presentaciones || [])];
  const necesarios = {
    minorista: filas.filter(f => f.vigente > 0).map(f => margen(f, 'minorista', f.vigente)),
    ...Object.fromEntries(['pack', 'bulto'].map(c => [c, filas.flatMap(f => (f.mayoristas || []).map(m => [f, m]))
      .filter(([, m]) => m.tipo === c && m.vigente > 0).map(([f, m]) => margen(f, c, m.vigente, m.unidades))])),
  };
  const canales = Object.entries(necesarios).map(([c, ms]) => [c, ms.filter(m => m != null)]).filter(([, ms]) => ms.length);
  if (!canales.length) {
    // Hay vigentes pero ninguna fila con vigente tiene costo real (Fraccionado: envase sin costo): no es que falten precios.
    const conVigente = filas.filter(f => f.vigente > 0 || (f.mayoristas || []).some(m => m.vigente > 0));
    const faltaCosto = conVigente.length > 0 && conVigente.every(f => !des(f, usada));
    return { valores: {}, notas: [], motivo: faltaCosto ? 'Falta el costo real de las presentaciones (envase sin costo)' : 'Sin precios vigentes en SIGA para igualar', fuente: usada };
  }
  const valores = Object.fromEntries(canales.map(([c, ms]) => [c, medianaMd(ms)]));
  const notas = canales.filter(([, ms]) => new Set(ms).size > 1).map(([c, ms]) => {
    const deltas = ms.map(m => ((1 + valores[c] / 100) / (1 + m / 100) - 1) * 100);
    return `${CANALES_AJUSTE_MD.find(x => x[0] === c)[1]} aprox.: ${QUIENES_IGUALAR_MD[c]} quedan con Δ entre ${pct1Md(Math.min(...deltas))} y ${pct1Md(Math.max(...deltas))} (margen = la mediana).`;
  });
  return { valores, notas, motivo: null, fuente: usada };
}

// Modo "Precio fijo": margen que da cada precio tipeado (minorista final con IVA; pack/bulto neto por unidad) con el costo de la
// fuente elegida (sin desglose en esa fuente → sistema, como igualarSigaMd). Misma cuenta que el motor (PE_MD.margenDePrecio).
// precios = { canal: número|null }; el canal sin precio (> 0) no aparece. Sin desglose (sin permiso o sin costo) → {}.
function margenesDePrecioMd(fila, fuente, precios) {
  const des = fu => ((fila.sugeridos || {})[fu] || {}).desglose || null;
  const d = des(fuente) || des('sistema');
  if (!d) return {};
  return Object.fromEntries(Object.entries(precios).filter(([, p]) => p > 0)
    .map(([canal, precio]) => [canal, PE_MD.margenDePrecio({ canal, precio, costoCG: d.costoConGastos, extrasPct: d.minorista.extrasPct, ivaPct: d.minorista.ivaPct })]));
}

// Precio en pesos: enteros sin decimales, el resto con centavos; null → "—". Compartidos con la tarjeta de precios de Fraccionado.
const fmtSug = n => (Number.isInteger(n) ? FMT_MD.fmtPrecio(n) : FMT_MD.fmtMoney(n));
const pesosMd = n => (n == null ? '<span class="md-nd">—</span>' : `$ ${fmtSug(n)}`);
// "con última compra" (con decisión: la fuente elegida) o "con costo sistema, para comparar" (sin decisión: nada se exporta).
const textoFuenteMd = (fila, fuente) => (fila.decision ? `con ${(TXT_OPCION[fuente] || fuente).toLowerCase()}` : 'con costo sistema, para comparar');

if (typeof module === 'object' && module.exports) module.exports = { fmtSug, pesosMd, textoFuenteMd, TIPO_CANAL, TXT_OPCION, pctMd, avisosCanalMd, filasCanales, ventaPayload, opcionesCosto, opcionesSelect, chipDelta, errorMotor, estadoDecision, conceptosCosto, pasosAjusteMd, pasosMinoristaMd, pasosMayoristaMd, generalesCanalMd, igualarSigaMd, margenesDePrecioMd, fuenteRefMd, canalesPrecioFijoMd, payloadPrecioFijoMd };

// ── DOM ─────────────────────────────────────────────────────────────────────────
let mdEsq = null;          // { tipo, fila } tal como vino del detalle
let mdFuente = 'sistema';  // fuente cuyos precios se muestran (la decidida; sistema si "No cambiar")
let mdDetalle = false;     // "Ver detalle" abierto
let mdMpModo = 'fijo';     // modo del bloque "Margen de este producto": el guardado; 'fijo' si no tiene

const TXT_TIPO_MD = { almacen: 'Reventa', fraccionado: 'Fraccionado', produccion: 'Producción' };
// Chip de Δ% contra el vigente: flecha por el signo, color por el semáforo (fuera de tolerancia = subir/bajar).
function chipDelta(deltaPct, estado, sufijo = '') {
  if (deltaPct == null) return '<span class="md-nd">—</span>';
  const flecha = deltaPct > 0 ? '▲' : deltaPct < 0 ? '▼' : '=';
  return `<span class="pr-sem sem-${FMT_MD.esc(estado || 'ok')} md-chip"><span aria-hidden="true">${flecha}</span>${FMT_MD.fmtPct(deltaPct)}${sufijo}</span>`;
}

async function abrirModalEsquema(tipo, plu, { detalle = false } = {}) {
  abrirModal('Cargando…', tipo === 'fraccionado' ? 'doble' : true); // precios_comun.js (Fraccionado: dos tarjetas)
  try {
    const fila = await (await fetch(`/api/precios/esquema/detalle/${encodeURIComponent(plu)}?tipo=${encodeURIComponent(tipo)}`)).json();
    if (fila.error) throw new Error(fila.error);
    mdEsq = { tipo, fila };
    mdFuente = fila.decision ? fila.decision.fuente : 'sistema';
    mdDetalle = detalle;
    mdMpModo = fila.margenProducto ? fila.margenProducto.modo || 'ajuste' : 'fijo'; // sin modo = dato viejo (ajuste)
    document.getElementById('mDetTitulo').textContent = fila.nombre || plu;
    document.getElementById('mDetSub').innerHTML = `<span class="md-tipo">${esc(TXT_TIPO_MD[tipo] || tipo)}</span>
      <span class="tabular-nums">PLU ${esc(fila.plu)}</span>${tipo === 'fraccionado' ? '<span>· precios por kg</span>' : ''}`;
    pintarModalEsquema();
    if (!detalle) enfocarOpcionMd();
  } catch (e) {
    document.getElementById('mDetDer').classList.add('hidden'); // el error ocupa sólo la tarjeta izquierda
    document.getElementById('mDetBody').innerHTML = `<p class="py-6 text-crit">No se pudo cargar: ${esc(e.message)}</p>`;
  }
}

// Foco en la opción elegida (o la primera habilitada) al abrir y después de guardar.
function enfocarOpcionMd() {
  const r = document.querySelector('#mdCostos input:checked') || document.querySelector('#mdCostos input:not(:disabled)');
  if (r) r.focus();
}

// Encabezado del cuerpo: precio vigente grande (Fraccionado: cuántas presentaciones) y estado de la decisión.
function htmlResumenMd(f, tipo) {
  const est = estadoDecision(f, tipo);
  const fracc = Array.isArray(f.presentaciones);
  const vig = fracc
    ? `<div class="md-vig-l">Presentaciones</div><div class="md-vig-v">${f.presentaciones.length}</div>`
    : `<div class="md-vig-l">Precio vigente</div><div class="md-vig-v">${f.vigente == null ? '<span class="md-nd">sin precio</span>' : '$ ' + fmtPrecio(f.vigente)}</div>`;
  const guia = fracc ? '<p class="md-guia">Seguí los pasos en orden. A la derecha ves cómo quedan los precios.</p>' : ''; // sólo Fraccionado
  return `<div class="md-resumen"><div>${vig}</div>${guia}
    <span id="mdEstado" class="md-estado${est.exporta ? ' on' : ''}"><span class="md-dot" aria-hidden="true"></span>${esc(est.texto)}</span></div>`;
}

// Avisos: error del motor (márgenes/gastos sin configurar → link a Configuración con el permiso) o producto sin costo.
function htmlAvisoMd(f, ops) {
  const err = errorMotor(f);
  if (err === 'margen' || err === 'gastos') {
    const sub = err === 'margen' ? 'margenes' : 'costos';
    const txt = err === 'margen' ? 'Faltan configurar los márgenes: sin ellos no hay precio sugerido.' : 'Los gastos variables configurados no permiten calcular el precio.';
    const accion = preciosSinConfig ? '<span>Avisale a quien administra los precios.</span>'
      : `<button type="button" class="md-ir-config" data-sub="${sub}">Ir a Configuración › ${sub === 'margenes' ? 'Márgenes' : 'Costos'}</button>`;
    return `<div class="md-aviso" role="note"><b>${txt}</b> ${accion}</div>`;
  }
  if (ops.slice(1).every(o => !o.disponible)) {
    return '<div class="md-aviso" role="note"><b>Este producto no tiene costo cargado</b>: no se puede calcular un precio nuevo. Queda el precio actual.</div>';
  }
  return '';
}

// Fraccionado: cuándo conviene cada costo (una línea gris chica en la tarjeta) y el acento de color de cada fuente (clase md-f-*, precios.html).
const CUANDO_MD = { '': 'Conviene si hoy no querés tocar este producto.', sistema: 'Conviene si el costo cargado en SIGA está al día.',
  ultimaCompra: 'Conviene si la última compra refleja lo que te cuesta hoy.', manual: 'Conviene si sabés el costo real y SIGA no lo tiene.' };
const CLASE_FUENTE_MD = { '': 'md-f-ninguna', sistema: 'md-f-sistema', ultimaCompra: 'md-f-ultimaCompra', manual: 'md-f-manual' };
const presentacionesMd = n => `${n} ${n === 1 ? 'presentación' : 'presentaciones'}`;

// Una tarjeta por opción: toda la tarjeta es el <label> del radio. Muestra costo, precio nuevo grande y Δ% vs vigente.
// Fraccionado además lleva "Elegida" en la elegida, el costo por kg, el cuándo conviene y el acento por fuente; Reventa y Producción, el de siempre.
function htmlOpcionMd(o, f, actual) {
  const sel = actual === o.valor;
  const fracc = Array.isArray(f.presentaciones);
  let costo = '';
  if (o.valor === '') costo = fracc ? '' : 'Deja el precio como está';
  else if (o.valor === 'manual' && manualEnTarjetaMd(mdEsq.tipo)) costo = htmlManualDecMd(f);
  else if (o.valor === 'precio' && mdEsq.tipo === 'almacen') costo = htmlPrecioFijoMd(f);
  else if (o.costo != null) costo = `Costo <b class="tabular-nums">$ ${fmtMoney(o.costo)}</b>${fracc ? '<span class="md-u">/kg</span>' : ''}`;
  let extra = '';
  if (o.valor === 'ultimaCompra' && f.costoUltimaCompra != null) {
    const d = f.deltaUltimaPct == null ? '' : ` · <span class="${f.deltaUltimaPct > 0 ? 'text-crit' : 'text-ok'}">${fmtPct(f.deltaUltimaPct)} vs sistema</span>`;
    extra = `<div class="md-opc-extra">${esc(fmtFechaPrecio(f.fechaUltimaCompra))}${f.proveedor ? ' · ' + esc(f.proveedor) : ''}${d}</div>`;
  }
  let precio;
  if (!o.disponible || (o.valor !== '' && o.motivo)) precio = `<div class="md-opc-motivo">${esc(o.motivo || 'Sin precio')}</div>`;
  else if (o.valor === '') precio = fracc || o.precio == null ? '<div class="md-opc-l">Mantiene los precios actuales</div>'
    : `<div class="md-opc-l">Queda en</div><div class="md-opc-precio">$ ${fmtPrecio(o.precio)}</div><div class="md-opc-delta"><span class="md-chip md-chip-0">sin cambio</span></div>`;
  else if (fracc) precio = `<div class="md-opc-l">Cambio promedio en ${presentacionesMd(o.n)}</div><div class="md-opc-delta">${chipDelta(o.deltaPct, o.deltaPct > 0 ? 'subir' : o.deltaPct < 0 ? 'bajar' : 'ok')}</div>`;
  else precio = `<div class="md-opc-l">Precio nuevo</div><div class="md-opc-precio">$ ${fmtPrecio(o.precio)}</div><div class="md-opc-delta">${chipDelta(o.deltaPct, o.estado)}</div>`;
  if (o.valor === 'precio' && !o.motivo) precio += htmlMargenCardMd(f); // Margen X % de las tablas (sólo con el permiso: usa el desglose)
  const cuando = fracc ? `<span class="md-opc-cuando">${esc(CUANDO_MD[o.valor] || '')}</span>` : '';
  return `<label class="md-opc${fracc ? ` ${CLASE_FUENTE_MD[o.valor] || ''}` : ''}${sel ? ' sel' : ''}${o.disponible ? '' : ' off'}">
    <span class="md-opc-cab"><input type="radio" name="mdCosto" value="${esc(o.valor)}"${sel ? ' checked' : ''}${o.disponible ? '' : ' disabled'}>
      <span class="md-opc-t">${esc(o.texto)}</span>${sel ? `<span class="md-opc-ok" aria-hidden="true">${fracc ? '✓ Elegida' : '✓'}</span>` : ''}</span>
    <span class="md-opc-costo">${costo}</span>${extra}${cuando}
    <span class="md-opc-res">${precio}</span></label>`;
}

// Fraccionado: es el paso 1 (encabezado con el número y para qué sirve, precios.html .md-paso); la leyenda del grupo queda para el lector de pantalla.
const TITULO_COSTO_FR_MD = '¿Con qué costo calculo el precio nuevo?';
const PARA_COSTO_FR_MD = 'Elegir un costo marca el producto para exportar; “No cambiar” lo desmarca. Se guarda al elegir y vale para todas las presentaciones.';
function htmlOpcionesCosto(f, ops) {
  const actual = f.decision ? f.decision.fuente : '';
  const prod = mdEsq.tipo === 'produccion';
  const grupo = `<div id="mdCostos" class="md-opcs" style="--n:${ops.length}">${ops.map(o => htmlOpcionMd(o, f, actual)).join('')}</div>
    <div id="mdDecMsg" class="md-msg" role="status" aria-live="polite"></div>`;
  if (Array.isArray(f.presentaciones)) {
    return `<fieldset class="md-dec md-paso"><legend class="sr-only">${TITULO_COSTO_FR_MD}</legend>
    <div class="md-paso-cab"><h4 class="md-h" aria-hidden="true">${TITULO_COSTO_FR_MD}</h4><p class="md-paso-para">${PARA_COSTO_FR_MD}</p></div>
    <div class="md-paso-cuerpo">${grupo}</div></fieldset>`;
  }
  return `<fieldset class="md-dec"><legend class="md-h">${prod ? '¿Aumentar el precio con el costo de la receta?' : TITULO_COSTO_FR_MD}</legend>
    <p class="md-ayuda">Al elegir se guarda solo. ${prod ? '"Aumentar"' : 'Un costo'} marca el producto para exportar; "No cambiar" lo desmarca.</p>
    ${grupo}</fieldset>`;
}

// La tarjeta "Costo manual" trae el campo para cargarlo y elegirlo desde ahí. Reventa: siempre (cualquier usuario del módulo); "Usar" guarda
// el costo y elige la decisión 'manual'; "Quitar" lo borra (el server limpia la decisión manual). Fraccionado: sólo con precios-config (como el
// resto de sus costos); "Guardar" sólo guarda el costo (después se elige la tarjeta) con el mismo pedido de siempre (conectarEdicionCostos).
// Los controles dentro del <label> no marcan el radio (son contenido interactivo); un clic en el resto del campo tampoco (conectarModalEsquema).
const manualEnTarjetaMd = tipo => tipo === 'almacen' || (tipo === 'fraccionado' && !preciosSinConfig);
const MANUAL_TARJETA_MD = {
  almacen: { input: 'mdManualDec', guardar: 'mdManualUsar', texto: 'Usar', quitar: 'mdManualDecQuitar' },
  fraccionado: { input: 'mdManual', guardar: 'mdManualGuardar', texto: 'Guardar', quitar: 'mdManualQuitar' },
};
function htmlManualDecMd(f) {
  const m = MANUAL_TARJETA_MD[mdEsq.tipo];
  return `<span class="md-opc-manual">
    ${campoU(`<input id="${m.input}" type="number" min="0" step="any" value="${esc(f.costoManual ?? '')}" aria-label="Costo manual">`, '$', { pre: true, w: 'w-full' })}
    <span class="flex items-center gap-2"><button type="button" id="${m.guardar}" class="cfg-btn2">${m.texto}</button>
    ${f.costoManual != null ? `<button type="button" id="${m.quitar}" class="text-sm text-gris hover:text-crit">Quitar</button>` : ''}</span></span>`;
}
async function guardarManualDecMd(body) {
  const { tipo, fila: f } = mdEsq;
  msgDecisionMd('', '<span class="spin"></span> Guardando…');
  try {
    await pedirJson('PUT', `/api/precios/costo-producto/${encodeURIComponent(f.plu)}`, body); // precios_comun.js
    if (body.fuente === 'manual') await guardarDecision(f.plu, 'manual'); // precios_listados.js
    await abrirModalEsquema(tipo, f.plu, { detalle: mdDetalle });
    cargarListado(tipo);
    msgDecisionMd('text-ok', `✓ Guardado · ${esc(estadoDecision(mdEsq.fila, tipo).texto.toLowerCase())}`);
  } catch (e) { msgDecisionMd('text-crit', `No se pudo guardar: ${esc(e.message)}`); }
}
function conectarManualDecMd() {
  const usar = document.getElementById('mdManualUsar');
  if (!usar) return;
  const input = document.getElementById('mdManualDec');
  usar.onclick = () => guardarManualDecMd({ fuente: 'manual', costo: numOrNull(input.value) });
  input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); usar.click(); } };
  const quitar = document.getElementById('mdManualDecQuitar');
  if (quitar) quitar.onclick = () => guardarManualDecMd({ fuente: 'sistema' });
}

// ── Card "Precio fijo" (Reventa; costeo.precioFijo) ──────────────────────────────────────────────────────────
// Quinta tarjeta del selector de costo, como la de Costo manual: campos de precio adentro (Minorista siempre; Pack y Bulto sólo si el producto
// tiene ese vínculo; vacío = margen general), "Usar" guarda el precio fijo y elige la decisión 'precio', "Quitar" lo borra (el server limpia la
// decisión). Cualquier usuario del módulo. El margen al tipear y el "Margen X %" de abajo usan el desglose: sólo con precios-config.
// El wrapper lleva .md-opc-manual: los controles dentro del <label> no marcan el radio (conectarModalEsquema).
function htmlCampoPrecioFijoMd(f, [c, t]) {
  const valor = (f.precioFijo || {})[c];
  const margen = preciosSinConfig ? '' : `<span id="mdPfMargen-${c}" class="md-pf-margen tabular-nums"></span>`;
  const describe = preciosSinConfig ? '' : ` aria-describedby="mdPfMargen-${c}"`;
  return `<span class="md-pf-campo"><span>${t}</span>
    ${campoU(`<input type="number" min="0" step="any" id="mdPf-${c}" class="md-pf-in" value="${esc(valor ?? '')}" placeholder="general" aria-label="Precio fijo ${t} en pesos"${describe}>`, '$', { pre: true, w: 'w-full' })}${margen}</span>`;
}
function htmlPrecioFijoMd(f) {
  const campos = canalesPrecioFijoMd(f).map(c => htmlCampoPrecioFijoMd(f, c)).join('');
  const sinCosto = fuenteRefMd(f) == null;
  return `<span class="md-opc-manual md-opc-pf">${campos}
    <span class="md-opc-extra">Minorista con IVA; pack y bulto sin IVA, por unidad. Vacío = margen general.</span>
    <span class="flex items-center gap-2"><button type="button" id="mdPfUsar" class="cfg-btn2"${sinCosto ? ' disabled title="Sin costo cargado: no se puede calcular el precio"' : ''}>Usar</button>
    ${f.precioFijo ? '<button type="button" id="mdPfQuitar" class="text-sm text-gris hover:text-crit">Quitar</button>' : ''}</span></span>`;
}
// "Margen X %" del precio fijo de minorista (margen de las tablas de Configuración sobre el costo con gastos, NO el "Margen total" de la tabla
// por canal). Sin desglose (sin permiso) o con minorista sin precio fijo (queda el margen general) → nada.
const htmlMargenCardMd = f => {
  const s = sugeridoDe(f, 'precio'), m = s && s.desglose && s.desglose.minorista;
  if (!m || m.margenProductoModo !== 'precio') return '';
  return `<div class="md-opc-margen">Margen <b class="tabular-nums">${pctMd(m.margenPct)}</b> <span class="md-sub">con ${esc((TXT_OPCION[s.fuenteRef] || s.fuenteRef).toLowerCase())}</span></div>`;
};
// Margen que da cada precio tipeado con el costo de referencia (misma cuenta que el motor: margenesDePrecioMd).
function pintarMargenesPrecioFijoMd() {
  const canales = canalesPrecioFijoMd(mdEsq.fila);
  const precios = Object.fromEntries(canales.map(([c]) => [c, numOrNull((document.getElementById(`mdPf-${c}`) || {}).value)]));
  const margenes = margenesDePrecioMd(mdEsq.fila, fuenteRefMd(mdEsq.fila) || 'sistema', precios);
  for (const [c] of canales) {
    const s = document.getElementById(`mdPfMargen-${c}`);
    if (s) s.textContent = margenes[c] == null ? '' : `Margen ${pctMd(margenes[c])}`;
  }
}
// Guarda (o quita) el precio fijo y, con usar, elige la decisión 'precio'; recarga modal y listado. Error: debajo de las tarjetas, sin decidir.
async function guardarPrecioFijoMd(precios, usar) {
  const { tipo, fila: f } = mdEsq;
  msgDecisionMd('', '<span class="spin"></span> Guardando…');
  try {
    await pedirJson('PUT', `/api/precios/precio-fijo/${encodeURIComponent(f.plu)}`, precios); // precios_comun.js
    if (usar) await guardarDecision(f.plu, 'precio'); // precios_listados.js
    await abrirModalEsquema(tipo, f.plu, { detalle: mdDetalle });
    cargarListado(tipo);
    msgDecisionMd('text-ok', `✓ Guardado · ${esc(estadoDecision(mdEsq.fila, tipo).texto.toLowerCase())}`);
  } catch (e) { msgDecisionMd('text-crit', `No se pudo guardar: ${esc(e.message)}`); }
}
function conectarPrecioFijoMd() {
  const usar = document.getElementById('mdPfUsar');
  if (!usar) return;
  const canales = canalesPrecioFijoMd(mdEsq.fila);
  const campos = canales.map(([c]) => document.getElementById(`mdPf-${c}`));
  const valores = () => Object.fromEntries(canales.map(([c], i) => [c, numOrNull(campos[i].value)]));
  campos.forEach(i => {
    i.oninput = pintarMargenesPrecioFijoMd;
    i.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); usar.click(); } };
  });
  usar.onclick = () => {
    const precios = payloadPrecioFijoMd(valores());
    if (Object.values(precios).every(v => v == null)) return msgDecisionMd('text-crit', 'Cargá al menos un precio.');
    return guardarPrecioFijoMd(precios, true);
  };
  const quitar = document.getElementById('mdPfQuitar');
  if (quitar) quitar.onclick = () => guardarPrecioFijoMd(payloadPrecioFijoMd({}), false);
  pintarMargenesPrecioFijoMd();
}

// Reventa: a quién se le compra (Directo / Distribuidor). Elegir guarda en el momento (guardarTipoProveedor,
// precios_listados.js); sin clasificar = ninguno elegido. msg = texto del estado tras guardar (o el error).
const TXT_TIPO_PROV_MD = [['directo', 'Directo'], ['distribuidor', 'Distribuidor']];
function htmlTipoProveedorMd(f, msg = '') {
  if (mdEsq.tipo !== 'almacen') return '';
  const b = ([v, t]) => `<button type="button" class="seg-opt md-tp" data-tipo="${v}" aria-pressed="${f.tipoProveedor === v}">${t}</button>`;
  return `<div id="mdTipoProv" class="flex flex-wrap items-center gap-3 mt-3"><span class="md-h">Proveedor</span>
    <div class="seg seg-sub" role="group" aria-label="Tipo de proveedor">${TXT_TIPO_PROV_MD.map(b).join('')}</div>
    ${f.tipoProveedor ? '' : '<span class="text-sm text-warn">Sin clasificar: no aparece en el listado por defecto</span>'}
    <span id="mdTipoProvMsg" class="text-sm" role="status" aria-live="polite">${msg}</span></div>`;
}
function pintarTipoProveedorMd(msg) {
  const el = document.getElementById('mdTipoProv');
  if (!el) return;
  el.outerHTML = htmlTipoProveedorMd(mdEsq.fila, msg);
  conectarTipoProveedorMd();
}
function conectarTipoProveedorMd() {
  document.querySelectorAll('#mdTipoProv .md-tp').forEach(b => b.onclick = async () => {
    const tipo = b.dataset.tipo, { fila: f } = mdEsq;
    if (f.tipoProveedor === tipo) return;
    document.querySelectorAll('#mdTipoProv .md-tp').forEach(x => { x.disabled = true; });
    document.getElementById('mdTipoProvMsg').innerHTML = '<span class="spin"></span> Guardando…';
    try {
      await guardarTipoProveedor(f.plu, tipo); // precios_listados.js
      // Distribuidor lleva el descuento al margen (Configuración › Márgenes): los precios cambian → recarga modal y listado.
      await abrirModalEsquema('almacen', f.plu, { detalle: mdDetalle });
      cargarListado('almacen');
      pintarTipoProveedorMd('<span class="text-ok">✓ Guardado</span>');
    } catch (e) {
      pintarTipoProveedorMd(`<span class="text-crit">No se pudo guardar: ${esc(e.message)}</span>`); // queda el valor anterior
    }
    const sel = document.querySelector(`#mdTipoProv .md-tp[data-tipo="${CSS.escape(mdEsq.fila.tipoProveedor || tipo)}"]`);
    if (sel) sel.focus();
  });
}

// Tabla por canal: minorista arriba y cada pack/bulto agrupado bajo su PLU y nombre. (Fraccionado no pasa por acá: tiene su
// propia tarjeta de precios por presentación, htmlPreciosFraccMd en precios_modal_fraccionado.js.)
function htmlTablaCanales(f) {
  const filas = filasCanales(f, mdFuente);
  if (!filas.length) return '<p class="text-gris mt-3">Sin canales para mostrar.</p>';
  const celdas = r => `<td class="num">${pesosMd(r.vigente)}</td><td class="num md-nuevo">${pesosMd(r.sugerido)}</td>
    <td class="num">${r.conIva === true ? '' : chipDelta(r.deltaPct, r.estado)}</td>
    <td class="num">${r.margenTotalPct == null ? '<span class="md-nd">—</span>' : pctMd(r.margenTotalPct)}</td>`;
  let previo = null;
  const cuerpo = filas.map(r => {
    if (r.tipo === 'minorista') {
      previo = null;
      return `<tr class="md-min"><td><b>Minorista</b> <span class="md-sub">PLU ${esc(r.plu)}</span></td>${celdas(r)}</tr>`;
    }
    const cab = r.plu !== previo ? `<tr class="md-grp"><td colspan="5">${esc(TIPO_CANAL[r.tipo] || r.tipo)} <span class="md-sub">PLU ${esc(r.plu)} · ${esc(r.nombre || '')}${r.unidades ? ` · × ${esc(r.unidades)}` : ''}</span>${avisosCanalMd(r)}</td></tr>` : '';
    previo = r.plu;
    return `${cab}<tr class="md-may"><td>${r.conIva ? 'Con IVA' : 'Sin IVA'}</td>${celdas(r)}</tr>`;
  }).join('');
  const txt = textoFuenteMd(mdEsq.fila, mdFuente);
  return `<section class="md-canales"><h4 class="md-h">Precios por canal <span class="md-sub">${esc(mdEsq.tipo !== 'produccion' ? txt : mdEsq.fila.decision ? 'con el aumento' : 'con el costo de la receta, para comparar')}</span></h4>
    <table class="md-tabla"><thead><tr><th class="text-left">Canal</th><th>Vigente</th><th>Nuevo</th><th>Δ vs vigente</th>
      <th title="Precio final ÷ costo de mercadería (con sus extras) − 1">Margen total</th></tr></thead><tbody>${cuerpo}</tbody></table></section>`;
}

// ── Ver detalle (sólo con permiso: el server sólo entonces manda `desglose`) ──
// Paso con v null = renglón aclaratorio sin importe (ej. el margen especial incluido en el margen del canal).
const htmlPasos = (titulo, pasos) => `<div class="md-bloque"><div class="lbl mb-1">${esc(titulo)}</div>${pasos.filter(Boolean).map(([op, txt, v]) =>
  `<div class="ec"><span class="ec-op" aria-hidden="true">${op}</span><span>${esc(txt)}</span><span class="ec-val">${v == null ? '' : '$ ' + fmtMoney(v)}</span></div>`).join('')}</div>`;
// Margen especial del producto (Producción) y ajuste del producto (costeo.margenProducto): ya están sumados en margenPct; se
// muestran aparte para explicar el total, con el general en el último renglón. Margen fijo del producto: reemplaza todo, un
// renglón con el general que reemplazó. Descuento distribuidor (Reventa): ya restado en margenPct; renglón con el margen antes
// y después. Sin ninguno → [].
const signoPctMd = n => `${n > 0 ? '+' : ''}${pctMd(n)}`;
function pasosAjusteMd(c) {
  if (c.margenProductoModo === 'fijo') return [['', `margen fijo del producto ${pctMd(c.margenPct)} (general ${pctMd(c.margenGeneralPct)})`, null]];
  if (c.margenProductoModo === 'precio') return [['', `precio fijo del producto $ ${fmtSug(c.precioFijo)} → margen ${pctMd(c.margenPct)} (general ${pctMd(c.margenGeneralPct)})`, null]];
  const esp = c.margenEspecialPct || 0, prod = c.margenProductoPct || 0, dto = c.descuentoDistribuidorPct || 0;
  const general = ` (general ${pctMd(c.margenPct - esp - prod + dto)})`;
  return [esp ? ['', `incluye margen especial del producto ${signoPctMd(esp)}${prod ? '' : general}`, null] : null,
    prod ? ['', `incluye ajuste del producto ${signoPctMd(prod)}${general}`, null] : null,
    dto ? ['', `incluye descuento distribuidor −${pctMd(dto)} (margen ${pctMd(c.margenPct + dto)} → ${pctMd(c.margenPct)})`, null] : null].filter(Boolean);
}
// Pasos del precio minorista (d = desglose de la fuente; costoTxt = rótulo del primer renglón) y de un pack/bulto (c = d.porVinculo[plu]):
// [operador, texto, importe tras el paso]. Reventa/Producción los pintan con htmlPasos; Fraccionado, con su propia cuenta (precios_modal_fraccionado.js).
function pasosMinoristaMd(d, costoTxt) {
  const m = d.minorista;
  return [['', costoTxt, d.costo], ['+', `Gastos variables ${pctMd(d.gastosPct)}`, d.costoConGastos], ['×', `Margen ${pctMd(m.margenPct)}`, m.neto], ...pasosAjusteMd(m),
    ['×', `Extras minoristas ${pctMd(m.extrasPct)}`, m.conExtras], ['×', `IVA ${pctMd(m.ivaPct)}`, m.exacto], ['=', m.margenProductoModo === 'precio' ? 'Precio fijo' : 'Precio redondeado', m.precio]];
}
function pasosMayoristaMd(d, c) {
  return [['', 'Costo con gastos', d.costoConGastos], ['×', `Margen ${pctMd(c.margenPct)}`, c.netoUnidad], ...pasosAjusteMd(c), ['×', `${c.unidades} unidades`, c.exactoNeto],
    ['=', c.margenProductoModo === 'precio' ? 'Sin IVA (precio fijo)' : 'Sin IVA redondeado', c.neto], ['×', 'IVA', c.exactoIva], ['=', 'Con IVA redondeado', c.conIva]];
}
// Margen general de cada canal (sin el del producto, con el especial) en la fuente: placeholder del margen fijo. Pack/bulto: el
// primer vínculo de ese tipo (Fraccionado: también los de sus presentaciones). Sin desglose → null.
function generalesCanalMd(fila, fuente) {
  const des = f => { const s = (f.sugeridos || {})[fuente]; return (s && s.desglose) || null; };
  const general = c => (!c ? null : c.margenProductoModo === 'fijo' || c.margenProductoModo === 'precio' ? c.margenGeneralPct
    : Math.round((c.margenPct - (c.margenProductoPct || 0) + (c.descuentoDistribuidorPct || 0)) * 100) / 100);
  const vinculos = [fila, ...(fila.presentaciones || [])].flatMap(f => (f.mayoristas || []).map(m => ({ m, d: des(f) })));
  const mayor = tipo => { const v = vinculos.find(x => x.m.tipo === tipo && x.d && x.d.porVinculo[x.m.plu]); return v ? general(v.d.porVinculo[v.m.plu]) : null; };
  return { minorista: general((des(fila) || {}).minorista), pack: mayor('pack'), bulto: mayor('bulto') };
}
// Producción: de dónde sale el costo real por unidad, en tres conceptos (conceptosCosto): mercadería (envasado: granel × kg;
// receta: cada materia prima llevada a una unidad, rol 'mp'), insumos y mano de obra. Sólo viene con el permiso.
const cantMd = n => (n == null ? '—' : new Intl.NumberFormat('es-AR', { maximumFractionDigits: 4 }).format(n)); // MP por unidad: 4 decimales
// Mano de obra en texto: "2 min × $ 8.268,00/h" (sin costo hora: aviso para cargarlo en Configuración › Costos).
const textoManoObraMd = mo => `${cantMd(mo.cantidad)} min × ${mo.costoUnit == null ? 'sin costo hora (cargá el costo hora en Configuración › Costos)' : `$ ${fmtMoney(mo.costoUnit)}/h`}`;
function htmlCostoEnvasadoMd(f) {
  const unit = c => (c.costoUnit == null ? 'sin costo' : `$ ${fmtMoney(c.costoUnit)}`);
  const linea = c => ['', `· ${c.rol === 'granel'
    ? `${c.fuente === 'familia' ? `${c.familia || 'Producto base'} (precio del producto base)` : `Granel ${c.nombre || c.plu}`} ${cantMd(c.cantidad)} kg × ${unit(c)}/kg`
    : `${c.nombre || c.plu} ${cantMd(c.cantidad)}${c.rol === 'mp' ? ' kg' : ''} × ${unit(c)}`}`, c.importe];
  const { mercaderia, insumos, mo } = conceptosCosto(f.componentesCosto);
  return htmlPasos('Costo real por unidad', [
    ['', 'Mercadería', mercaderia.subtotal], ...mercaderia.lineas.map(linea),
    ['+', insumos.lineas.length ? 'Insumos' : 'Insumos — sin cargar', insumos.subtotal], ...insumos.lineas.map(linea),
    ['+', mo ? `Mano de obra · ${textoManoObraMd(mo)}` : 'Mano de obra — sin minutos cargados', mo ? mo.importe : 0],
    ['=', 'Costo real', f.costoSistema]]);
}
function htmlDesgloseEsq(f) {
  const bloques = Array.isArray(f.componentesCosto) && f.componentesCosto.length ? [htmlCostoEnvasadoMd(f)] : [];
  const s = (f.sugeridos || {})[mdFuente];
  if (s && s.desglose) {
    const d = s.desglose;
    bloques.push(htmlPasos('Minorista', pasosMinoristaMd(d, 'Costo de mercadería')));
    for (const v of f.mayoristas || []) {
      const c = d.porVinculo[v.plu];
      if (c) bloques.push(htmlPasos(`${TIPO_CANAL[v.tipo]} ${v.plu} (× ${c.unidades})`, pasosMayoristaMd(d, c)));
    }
  }
  return bloques.length ? `<div class="md-desglose">${bloques.join('')}</div>` : '<p class="text-gris mt-3">Sin desglose para esta fuente.</p>';
}

const htmlFilaExtraMd = (it = {}) => `<tr><td class="py-1 pr-2"><input class="num-in w-full text-left" data-k="concepto" value="${esc(it.concepto || '')}" aria-label="Concepto"></td>
  <td class="py-1 pr-2"><select class="num-in" data-k="tipo" aria-label="Tipo"><option value="kg"${it.tipo !== 'pct' ? ' selected' : ''}>$</option><option value="pct"${it.tipo === 'pct' ? ' selected' : ''}>%</option></select></td>
  <td class="py-1 pr-2"><input class="num-in w-24" type="number" step="any" data-k="valor" value="${esc(it.valor ?? '')}" aria-label="Valor"></td>
  <td class="py-1"><button type="button" class="md-extra-quitar btn-quitar" aria-label="Quitar">✕</button></td></tr>`;
// Pack/bulto pesables (granel y presentaciones de Fraccionado) con su modo de venta: por kg o por paquete + kg.
const ventasPesablesMd = f => [...(f.mayoristas || []), ...(f.presentaciones || []).flatMap(p => p.mayoristas || [])].filter(m => m.venta);
const htmlVentaMd = m => `<tr><td class="py-1 pr-2">${esc(TIPO_CANAL[m.tipo] || m.tipo)} ${esc(m.plu)} <span class="text-gris">${esc(m.nombre || '')}</span></td>
  <td class="py-1 pr-2"><select class="md-venta-modo num-in" data-plu="${esc(m.plu)}" aria-label="Modo de venta de ${esc(m.plu)}">
    <option value="kg"${m.venta.modo !== 'paquete' ? ' selected' : ''}>Por kg</option><option value="paquete"${m.venta.modo === 'paquete' ? ' selected' : ''}>Por paquete</option></select></td>
  <td class="py-1 pr-2"><input type="number" min="0" step="any" class="md-venta-kg num-in w-20${m.venta.modo === 'paquete' ? '' : ' hidden'}" data-plu="${esc(m.plu)}" value="${esc(m.venta.pesoKg ?? '')}" aria-label="Kg del paquete de ${esc(m.plu)}"></td>
  <td class="py-1"><button type="button" class="md-venta-guardar cfg-btn2" data-plu="${esc(m.plu)}">Guardar</button></td></tr>`;
function htmlVentasPesablesMd(f) {
  const ms = mdEsq.tipo === 'fraccionado' ? ventasPesablesMd(f) : [];
  return ms.length ? `<div class="md-sb-sep"><div class="md-sb-t">Venta de pack/bulto pesables</div>
    <p class="md-sb-ayuda">Cómo se vende cada uno: por kg o por paquete (con su peso en kg).</p>
    <table class="w-full text-sm"><tbody id="mdVentas">${ms.map(htmlVentaMd).join('')}</tbody></table></div>` : '';
}
function htmlEdicionCostos(f) {
  if (mdEsq.tipo === 'produccion') return '';
  const cab = mdEsq.tipo === 'fraccionado' // Fraccionado: subtítulo y para qué sirve (dentro del paso "Costo del granel")
    ? '<div class="md-sb-t">Costos extra</div><p class="md-sb-ayuda">Se suman al costo del granel: un importe por kg ($) o un % del costo.</p>'
    : '<div class="lbl mb-1">Costos extra ($ o % del costo)</div>';
  return `<div class="md-edicion">
    ${cab}
    <table class="w-full text-sm"><tbody id="mdExtras">${(f.costosExtra || []).map(htmlFilaExtraMd).join('')}</tbody></table>
    <div class="flex gap-2 mt-1"><button type="button" id="mdExtraAgregar" class="cfg-btn2">+ Agregar</button>
      <button type="button" id="mdExtrasGuardar" class="cfg-btn2">Guardar costos extra</button></div>
    ${htmlVentasPesablesMd(f)}
    <p id="mdMsg" class="text-sm mt-1" role="status" aria-live="polite"></p></div>`;
}
// Margen de este producto (sólo con el permiso), por canal y en uno de dos modos: 'fijo' = el margen % final del canal
// (reemplaza general, ajuste por peso y especial; vacío = general) o 'ajuste' = puntos % que se suman (el precio fijo de Reventa es la
// quinta card del selector de costo). Se guarda en el PLU de la fila (Fraccionado: el granel, vale para todas sus presentaciones). Los valores guardados se ven sólo en su modo.
const CANALES_AJUSTE_MD = [['minorista', 'Minorista'], ['pack', 'Pack'], ['bulto', 'Bulto']];
const numMd = n => String(+(+n).toFixed(2)).replace('.', ',');
const MODOS_MP_MD = [['fijo', 'Margen fijo'], ['ajuste', 'Ajuste ±']];
const UNIDAD_MP_MD = { fijo: 'Margen %', ajuste: '+ pts %' };
function ayudaMargenProductoMd(modo) {
  const { tipo } = mdEsq;
  const txt = modo === 'fijo'
    ? `Margen % final de cada canal: reemplaza al margen general${tipo === 'fraccionado' ? ' y al ajuste por peso' : ''}${tipo === 'produccion' ? ' y al margen especial' : ''}. Vacío = margen general.`
    : `Puntos % por canal: se suman al margen general${tipo === 'produccion' ? ' y al margen especial' : ''}. Vacío o 0 = sin ajuste.`;
  return txt + (tipo === 'fraccionado' ? ' Aplica a todas las presentaciones del granel.' : '');
}
function htmlMargenProductoMd(f) {
  if (preciosSinConfig || f.plu == null) return '';
  const fijo = mdMpModo === 'fijo';
  const guardado = f.margenProducto || {};
  const m = (guardado.modo || 'ajuste') === mdMpModo ? guardado : {};
  const gen = generalesCanalMd(f, mdFuente);
  const ph = c => (!fijo ? '0' : gen[c] == null ? 'general' : `${numMd(gen[c])} (general)`);
  const etiqueta = t => (fijo ? `Margen ${t} en %` : `Ajuste de margen ${t} en puntos %`);
  const modo = (v, t) => `<button type="button" class="seg-opt md-mp-modo" data-modo="${v}" aria-pressed="${mdMpModo === v}">${t}</button>`;
  const modos = MODOS_MP_MD.map(([v, t]) => modo(v, t)).join('');
  const campos = CANALES_AJUSTE_MD.map(([c, t]) => `<label class="flex items-center gap-1 text-sm">${t}
    ${campoU(`<input type="number" step="any" class="md-mp-in" data-canal="${c}" value="${esc(m[c] ?? '')}" placeholder="${esc(ph(c))}" aria-label="${etiqueta(t)}">`,
    UNIDAD_MP_MD[mdMpModo], { w: fijo ? 'w-44' : 'w-32' })}</label>`).join('');
  const fr = mdEsq.tipo === 'fraccionado'; // Fraccionado: paso numerado (encabezado con para qué sirve + cuerpo); el resto, como siempre
  const cab = `<div class="${fr ? 'md-paso-cab ' : ''}flex flex-wrap items-center gap-3"><h4 class="md-h">Margen de este producto</h4>
    <div class="seg seg-sub" role="group" aria-label="Cómo se define el margen de este producto">${modos}</div>${fr ? '<p class="md-paso-para">Cuánto se gana sobre el costo, canal por canal.</p>' : ''}</div>`;
  const cuerpo = `<p class="md-ayuda">${esc(ayudaMargenProductoMd(mdMpModo))}</p>
    <div class="flex flex-wrap items-center gap-3">${campos}<button type="button" id="mdMargenGuardar" class="cfg-btn2">Guardar</button>
      ${htmlIgualarSigaMd(f)}</div>
    <p id="mdMargenMsg" class="text-sm mt-1" role="status" aria-live="polite"></p>`;
  return fr ? `<section class="md-margen-prod md-paso">${cab}<div class="md-paso-cuerpo">${cuerpo}</div></section>` : `<section class="md-margen-prod">${cab}${cuerpo}</section>`;
}
// Botón "Igualar a SIGA": deshabilitado con el motivo en el title si no hay costo o vigentes para calcular.
function htmlIgualarSigaMd(f) {
  const { motivo } = igualarSigaMd(f, mdEsq.tipo, mdFuente);
  return `<button type="button" id="mdMargenIgualar" class="cfg-btn2"${motivo ? ` disabled title="${esc(motivo)}"` : ' title="Margen fijo por canal para que el precio quede igual al vigente de SIGA"'}>Igualar a SIGA</button>`;
}
// Pasa a "Margen fijo" y llena cada canal con vigente con el margen que lo iguala (sin vigente: vacío). No guarda.
function igualarSigaClickMd() {
  const r = igualarSigaMd(mdEsq.fila, mdEsq.tipo, mdFuente);
  mdMpModo = 'fijo';
  document.querySelector('#mDetBody .md-margen-prod').outerHTML = htmlMargenProductoMd(mdEsq.fila);
  conectarMargenProductoMd();
  document.querySelectorAll('#mDetBody .md-mp-in').forEach(i => { i.value = r.valores[i.dataset.canal] ?? ''; });
  const msg = document.getElementById('mdMargenMsg');
  msg.className = 'text-sm mt-1';
  const con = mdEsq.tipo === 'produccion' ? 'Con el costo de la receta.' : `Con ${(TXT_OPCION[r.fuente] || r.fuente).toLowerCase()}.`;
  msg.textContent = [con, ...r.notas, 'Revisá y tocá Guardar.'].join(' ');
  document.getElementById('mdMargenGuardar').focus();
}
function conectarMargenProductoMd() {
  const sec = document.querySelector('#mDetBody .md-margen-prod');
  if (!sec) return;
  sec.querySelectorAll('.md-mp-modo').forEach(b => b.onclick = () => {
    if (b.dataset.modo === mdMpModo) return;
    mdMpModo = b.dataset.modo;
    sec.outerHTML = htmlMargenProductoMd(mdEsq.fila);
    conectarMargenProductoMd();
    document.querySelector(`#mDetBody .md-mp-modo[data-modo="${mdMpModo}"]`).focus();
  });
  document.getElementById('mdMargenIgualar').onclick = igualarSigaClickMd;
  document.getElementById('mdMargenGuardar').onclick = () => guardarCostoEsq(`/api/precios/config/esquema/margen-producto/${encodeURIComponent(mdEsq.fila.plu)}`,
    { modo: mdMpModo, ...Object.fromEntries([...sec.querySelectorAll('.md-mp-in')].map(i => [i.dataset.canal, numOrNull(i.value)])) }, 'PUT', 'mdMargenMsg');
}

function htmlVerDetalle(f) {
  if (preciosSinConfig) return '';
  return `<div class="md-det"><button type="button" id="mdVerDetalle" class="md-det-btn" aria-expanded="${mdDetalle}" aria-controls="mdDetCuerpo">
      <span class="md-caret" aria-hidden="true">▸</span>Ver detalle del cálculo y editar costos</button>
    <div id="mdDetCuerpo"${mdDetalle ? '' : ' hidden'}>${htmlDesgloseEsq(f)}${htmlEdicionCostos(f)}</div></div>`;
}

function pintarModalEsquema() {
  const { tipo, fila: f } = mdEsq;
  if (tipo === 'fraccionado') return pintarModalFraccionadoMd(); // dos tarjetas (precios_modal_fraccionado.js)
  const ops = opcionesCosto(f, tipo, { manualSiempre: tipo === 'almacen', precioSiempre: tipo === 'almacen' });
  document.getElementById('mDetBody').innerHTML = `${htmlResumenMd(f, tipo)}${htmlAvisoMd(f, ops)}${htmlOpcionesCosto(f, ops)}${htmlTipoProveedorMd(f)}
    ${htmlTablaCanales(f)}${htmlMargenProductoMd(f)}${htmlVerDetalle(f)}`;
  conectarModalEsquema();
}

function msgDecisionMd(cls, html) {
  const msg = document.getElementById('mdDecMsg');
  if (!msg) return; // el modal no se pudo recargar: ya muestra el error
  msg.className = `md-msg ${cls}`; msg.innerHTML = html;
}
// Elegir un costo guarda la decisión en el momento (No cambiar = sin decisión) y refresca la fila del listado;
// guardarDecision (precios_listados.js) ya avisa a Producción ("a revisar"). Error: vuelve a la elegida antes + Reintentar.
async function guardarOpcionMd(valor) {
  const { tipo, fila: f } = mdEsq;
  const grupo = document.getElementById('mdCostos');
  grupo.setAttribute('aria-busy', 'true');
  grupo.querySelectorAll('input').forEach(i => { i.disabled = true; });
  msgDecisionMd('', '<span class="spin"></span> Guardando…');
  try {
    const decision = await guardarDecision(f.plu, valor || null); // precios_listados.js
    mdEsq = { tipo, fila: { ...f, decision } };
    mdFuente = valor || 'sistema';
    renderListado(tipo);
    pintarModalEsquema();
    enfocarOpcionMd();
    msgDecisionMd('text-ok', `✓ Guardado · ${esc(estadoDecision(mdEsq.fila, tipo).texto.toLowerCase())}`);
  } catch (err) {
    pintarModalEsquema();
    enfocarOpcionMd();
    msgDecisionMd('text-crit', `No se pudo guardar: ${esc(err.message)} <button type="button" id="mdReintentar" class="cfg-btn2 ml-2">Reintentar</button>`);
    document.getElementById('mdReintentar').onclick = () => guardarOpcionMd(valor);
  }
}

function conectarModalEsquema() {
  const grupo = document.getElementById('mdCostos');
  grupo.onchange = e => { if (e.target.name === 'mdCosto') guardarOpcionMd(e.target.value); }; // no el campo del costo manual
  // Un clic en el campo del costo manual (el "$", el hueco entre el campo y los botones) activaría el <label> y elegiría la tarjeta: se cancela.
  grupo.addEventListener('click', e => { if (e.target.closest('.md-opc-manual')) e.preventDefault(); });
  // Flechas: mueven el foco entre opciones habilitadas SIN elegir (elegir guarda); Espacio o Enter eligen.
  grupo.onkeydown = e => {
    const radios = [...grupo.querySelectorAll('input[type="radio"]:not(:disabled)')];
    const i = radios.indexOf(document.activeElement);
    if (i < 0) return;
    const paso = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (paso) { e.preventDefault(); radios[(i + paso + radios.length) % radios.length].focus(); return; }
    if (e.key === 'Enter') { e.preventDefault(); if (!radios[i].checked) radios[i].click(); }
  };
  document.querySelectorAll('#mDetBody .md-ir-config').forEach(b => b.onclick = () => {
    cerrarDetalle();          // precios_comun.js
    salirDeProduccion();      // precios_produccion.js
    activarTab(b.dataset.sub); // precios_config.js
  });
  const ver = document.getElementById('mdVerDetalle');
  if (ver) ver.onclick = () => {
    mdDetalle = !mdDetalle;
    ver.setAttribute('aria-expanded', String(mdDetalle));
    const cuerpo = document.getElementById('mdDetCuerpo');
    cuerpo.hidden = !mdDetalle;
    if (mdDetalle) ver.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  if (document.getElementById('mdExtrasGuardar')) conectarEdicionCostos();
  conectarManualDecMd();
  conectarPrecioFijoMd();
  conectarMargenProductoMd();
  conectarTipoProveedorMd();
  if (mdEsq.tipo === 'fraccionado') conectarModalFraccionadoMd(); // precios_modal_fraccionado.js
}

// Guarda costo manual / costos extra / venta de pack/bulto / ajuste de margen con las rutas de siempre y recarga modal
// (con el detalle como estaba) y listado. msgId = dónde mostrar el error. → true si el pedido guardó (aunque después falle
// la recarga), false si no se guardó (quien tenga un borrador lo conserva).
async function guardarCostoEsq(url, body, metodo = 'PUT', msgId = 'mdMsg') {
  const msg = document.getElementById(msgId);
  const error = txt => { msg.className = 'text-sm mt-1 text-crit'; msg.textContent = txt; };
  try {
    await pedirJson(metodo, url, body); // precios_comun.js: tira con el error del server
  } catch (e) { error(e.message); return false; }
  try {
    refrescarAlertasProduccion(); // precios_produccion.js: el costo pudo mover "a revisar" (no tira, va antes de recargar el modal)
    const { tipo, fila } = mdEsq;
    await abrirModalEsquema(tipo, fila.plu, { detalle: mdDetalle });
    cargarListado(tipo);
    if (tipo === 'produccion') refrescarPanelProduccionMd();
  } catch (e) { error(`Se guardó, pero no se pudo recargar: ${e.message}`); }
  return true;
}
// El modal pudo abrirse encima del modal del producto base (Envasado) o del panel de presentaciones de una receta: también
// se recargan sus precios. ebEd / recargarBase / pintarBase (precios_produccion_envasado.js), prodDet / recargarDetalleProd
// (precios_produccion.js). Para abrir el modal desde el producto base no puede haber cambios sin guardar: recargar no pisa nada.
function refrescarPanelProduccionMd() {
  const base = document.getElementById('mBase');
  if (typeof ebEd !== 'undefined' && ebEd && base && !base.classList.contains('hidden')) {
    recargarBase(ebEd.familia).then(pintarBase).catch(e => avisar(`No se pudieron recargar los precios del producto base: ${e.message}`)); // precios_config.js
  } else if (typeof prodDet !== 'undefined' && prodDet && document.getElementById('prPres')) recargarDetalleProd();
}
function conectarEdicionCostos() {
  const plu = encodeURIComponent(mdEsq.fila.plu);
  const tbody = document.getElementById('mdExtras');
  // El costo manual de Fraccionado vive en su tarjeta de decisión (htmlManualDecMd; Reventa usa conectarManualDecMd): el error sale debajo de las tarjetas.
  const guardar = document.getElementById('mdManualGuardar');
  if (guardar) {
    guardar.onclick = () => guardarCostoEsq(`/api/precios/costo-producto/${plu}`, { fuente: 'manual', costo: numOrNull(document.getElementById('mdManual').value) }, 'PUT', 'mdDecMsg');
    document.getElementById('mdManual').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); guardar.click(); } };
  }
  const quitar = document.getElementById('mdManualQuitar');
  // fuente 'sistema' borra el costo manual.
  if (quitar) quitar.onclick = () => guardarCostoEsq(`/api/precios/costo-producto/${plu}`, { fuente: 'sistema' }, 'PUT', 'mdDecMsg');
  document.getElementById('mdExtraAgregar').onclick = () => tbody.insertAdjacentHTML('beforeend', htmlFilaExtraMd());
  tbody.onclick = e => { const b = e.target.closest('.md-extra-quitar'); if (b) b.closest('tr').remove(); };
  document.getElementById('mdExtrasGuardar').onclick = () => guardarCostoEsq(`/api/precios/costos-extra/${plu}`, {
    items: [...tbody.querySelectorAll('tr')].map(tr => ({
      concepto: tr.querySelector('[data-k="concepto"]').value.trim(), tipo: tr.querySelector('[data-k="tipo"]').value,
      valor: numOrNull(tr.querySelector('[data-k="valor"]').value),
    })),
  });
  const ventas = document.getElementById('mdVentas');
  if (!ventas) return;
  ventas.onchange = e => {
    const sel = e.target.closest('.md-venta-modo');
    if (sel) ventas.querySelector(`.md-venta-kg[data-plu="${CSS.escape(sel.dataset.plu)}"]`).classList.toggle('hidden', sel.value !== 'paquete');
  };
  ventas.onclick = e => {
    const b = e.target.closest('.md-venta-guardar');
    if (!b) return;
    const q = cls => ventas.querySelector(`.${cls}[data-plu="${CSS.escape(b.dataset.plu)}"]`);
    const p = ventaPayload(q('md-venta-modo').value, numOrNull(q('md-venta-kg').value));
    if (p.error) { const msg = document.getElementById('mdMsg'); msg.className = 'text-sm mt-1 text-crit'; msg.textContent = p.error; return; }
    guardarCostoEsq(`/api/precios/pack-bulto/venta/${encodeURIComponent(b.dataset.plu)}`, p.body, p.metodo);
  };
}
