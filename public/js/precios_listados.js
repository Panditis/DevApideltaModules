// ── Precios · listados Reventa, Fraccionado y Producción con el esquema por canal (spec 2026-10-07 §3.1) ──
// Script clásico. Una fila por producto (Fraccionado: por granel, con sus presentaciones desplegables; Producción: por
// presentación) con costo sistema, última compra, vigente, sugerido por fuente y un <select> con la DECISIÓN (qué costo usar
// para el precio nuevo; marca el producto para exportar). Se decide acá, sin abrir el modal, o en el modal (clic en el nombre);
// las dos vías guardan igual (guardarDecision). Todo viene calculado del server (GET /api/precios/esquema/listado): acá sólo se filtra y pinta.
// Fraccionado además oculta los graneles REEFER e inactivos (toggles); el estado manual (activo / inactivo / automático) se fija con el botón de cada granel (con permiso de Configuración) o en Configuración › Costeo Fraccionado › Subrubros.
// Globales: esc, fmtMoney, fmtPrecio, fmtPct, claseDelta, HOJA_EXPORTACION, FILA_ENCABEZADOS, fmtFechaPrecio,
// montarOrden, ordenarCon (precios_comun.js), avisar, confirmar (precios_config.js), abrirModalEsquema, opcionesSelect
// (precios_modal_esquema.js), textoRevisar (precios_produccion.js), XLSX (CDN).
const normL = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Filtros del listado: texto (PLU/nombre, también presentaciones), sólo decididos, última compra más cara que sistema y
// cargados hoy (ingresoHoy: compra cargada hoy en SIGA; en Fraccionado, la del granel). proveedor: el texto también busca en el
// proveedor de la última compra (sólo Reventa, que es donde se muestra esa columna). clasificacion (sólo Reventa): 'con' = sólo
// las que tienen tipoProveedor (directo/distribuidor; las demás son marca Apidelta o afines), 'sin' = sólo las sin clasificar
// (toggle "Sin clasificar", para clasificar productos nuevos de SIGA desde el modal); null = todas.
// Fraccionado (spec 2026-10-26): los graneles REEFER (control de stock) y los inactivos se ocultan salvo verReefer / verInactivos.
// REEFER no depende de la actividad (rige verReefer aunque esté inactivo); el "sin granel" (plu null) siempre se ve.
// siempreVisibles (Set de PLU): graneles cuyo estado se cambió con el botón de la fila; no se ocultan hasta el próximo refresco o cambio de filtro.
function filtrarFilas(filas, { texto = '', soloDecididos = false, ultimaMasCara = false, soloHoy = false, proveedor = false, clasificacion = null, verReefer = false, verInactivos = false, siempreVisibles = null } = {}) {
  const t = normL(texto.trim());
  const coincide = f => !t || normL(`${f.plu ?? ''} ${f.nombre}${proveedor ? ` ${f.proveedor ?? ''}` : ''}`).includes(t)
    || (f.presentaciones || []).some(p => normL(`${p.plu} ${p.nombre}`).includes(t));
  const clase = f => !clasificacion || (clasificacion === 'con') === !!f.tipoProveedor;
  const oculta = f => f.plu != null && !(siempreVisibles && siempreVisibles.has(String(f.plu))) && (f.reefer === true ? !verReefer : f.activo === false && !verInactivos);
  return filas.filter(f => coincide(f) && clase(f) && !oculta(f) && (!soloDecididos || !!f.decision) && (!soloHoy || f.ingresoHoy === true)
    && (!ultimaMasCara || (f.costoSistema > 0 && f.costoUltimaCompra > f.costoSistema)));
}

// Actividad de los graneles de Fraccionado. Cuántos hay de cada tipo oculto-able (los números de los toggles; inactivos = no REEFER).
const contarOcultables = filas => ({ reefer: filas.filter(f => f.reefer === true).length, inactivos: filas.filter(f => f.reefer !== true && f.activo === false).length });
// sinMovGranel llega solo como informativo: ya no es causa de inactividad, no se muestra.
const TXT_MOTIVO_ACTIVIDAD = { sinPresentaciones: 'sin presentaciones', sinMovPresentaciones: 'sin movimientos de ninguna presentación en el último año' };
const textoMotivosActividad = motivos => (motivos || []).filter(m => m !== 'sinMovGranel').map(m => TXT_MOTIVO_ACTIVIDAD[m] || m).join('; ');
// Title del badge "inactivo": lo fijado a mano gana sobre los motivos del automático.
function textoInactivoLst(f) {
  if (f.activoManual === false) return 'Fijado a mano como inactivo';
  const motivos = textoMotivosActividad((f.actividad || {}).motivos);
  return motivos ? `Inactivo: ${motivos}` : 'Inactivo';
}
// "Activo por stock": sin movimientos recientes pero con stock en sucursales reales (fila.actividad.activoPorStock). '' si no aplica.
function textoActivoPorStockLst(f) {
  const a = f.actividad || {};
  if (a.activoPorStock !== true || f.activo === false) return '';
  const n = (a.sucursalesConStock || []).length, u = Number(a.stockPresentaciones) || 0;
  return `Sin movimientos recientes, pero hay stock en ${n} sucursal(es): ${u} unidades`;
}
// "Activo por presentación": el granel no se movió en el último año pero una presentación sí (fila.actividad.activoPorPresentaciones).
const TXT_ACTIVO_POR_PRES_LST = 'El granel no tuvo movimientos propios en el último año, pero una presentación sí.';
const textoActivoPorPresentacionesLst = f => ((f.actividad || {}).activoPorPresentaciones === true && f.activo !== false) ? TXT_ACTIVO_POR_PRES_LST : '';
const BADGE_ACT_LST ='ml-1 px-1.5 py-0.5 rounded text-[11px] font-semibold bg-ink/10 text-ink whitespace-nowrap';
function htmlBadgesActividadLst(f) {
  const badge = (txt, title) => ` <span class="${BADGE_ACT_LST}" title="${ESC_LST(title)}">${txt}</span>`;
  return (f.reefer === true ? badge('REEFER', 'Granel REEFER: depósito especial, sirve de control de stock') : '') + (f.activo === false ? badge('inactivo', textoInactivoLst(f)) : '') + (textoActivoPorPresentacionesLst(f) ? badge('activo por presentación', TXT_ACTIVO_POR_PRES_LST) : '') + (textoActivoPorStockLst(f) ? badge('activo por stock', textoActivoPorStockLst(f)) : '');
}

// Acción de actividad por granel (la usa el modal de Fraccionado, no la fila del listado). El granel REEFER lo rige su toggle y el "sin
// granel" (plu null) no tiene estado: sin botón. activo = lo que se ve hoy; fijado = activoManual boolean. Inactivo → "Activar" (true),
// activo → "Desactivar" (false); fijado a mano suma el texto "Fijado a mano" y "Volver a automático" (null).
function accionActividadLst(f) {
  if (f.plu == null || f.reefer === true) return null;
  const activo = f.activo !== false;
  return { activo, texto: activo ? 'Desactivar' : 'Activar', valor: !activo, fijado: typeof f.activoManual === 'boolean' };
}
// Fila con el estado ya cambiado (valor true | false | null = automático): activoManual y activo como los calcula el server (actividadGranel).
const conActividadLst = (f, valor) => ({ ...f, activoManual: valor, activo: valor ?? (f.actividad ? f.actividad.auto === 'activo' : true) });

// Presentaciones mayoristas (Fraccionado, p.mayorista / p.mayoristaOrigen: 'peso' | 'manual' | null / p.mayoristaTipo: 'pack' | 'bulto' | null; OJO:
// fila.mayoristas[] plural es el pack/bulto vinculado, otra cosa). Badge "Mayorista · Pack|Bulto" con el origen en el tooltip, y, sólo con permiso de
// Configuración (.solo-config), control segmentado Minorista | Mayorista · Pack | Mayorista · Bulto y "Volver a automático"
// (PUT config/…/fraccionado/mayorista { porPlu: { [plu]: false | 'pack' | 'bulto' | null } }).
const TXT_ORIGEN_MAY_LST = origen => (origen === 'manual' ? 'Marcada a mano' : origen === 'peso' ? 'Por peso' : '');
// Aviso del export (GET …/esquema/export → omitidosMayorista): las mayoristas con precio sin IVA no tienen lista de SIGA todavía.
const textoOmitidosMayoristaLst = n => `${n} presentaciones mayoristas no se exportaron: precio sin IVA, falta definir a qué lista de SIGA va.`;
const TIPO_MAY_LST = { pack: 'Pack', bulto: 'Bulto' };
// Tipo efectivo de una presentación mayorista (sin dato = bulto, el default); null si es minorista.
const tipoMayLst = p => (p && p.mayorista === true ? (p.mayoristaTipo === 'pack' ? 'pack' : 'bulto') : null);
// Regla del server: un granel con exactamente 2 mayoristas sin tipo a mano → la de menor peso es pack, la mayor bulto (p.mayoristaTipoOrigen === 'regla').
const AYUDA_REGLA_MAY = 'Si un granel tiene 2 presentaciones mayoristas, la de menor peso es pack y la mayor es bulto (salvo que marques el tipo a mano).';
const textoReglaMayLst = p => (p && p.mayorista === true && p.mayoristaTipoOrigen === 'regla'
  ? `Tipo por regla: ${tipoMayLst(p) === 'pack' ? 'menor de 2 mayoristas del granel → pack' : 'mayor de 2 → bulto'}` : '');
const htmlBadgeMayoristaLst = p => (p.mayorista === true
  ? ` <span class="${BADGE_ACT_LST}" title="${ESC_LST([TXT_ORIGEN_MAY_LST(p.mayoristaOrigen) || 'Mayorista', textoReglaMayLst(p)].filter(Boolean).join('. '))}">Mayorista · ${TIPO_MAY_LST[tipoMayLst(p)]}</span>` : '');
// Las tres opciones del control (pressed = estado efectivo) y, si la marca es manual, volver a automático. null = sin control (sin PLU).
const OPCIONES_MAY_LST = [{ texto: 'Minorista', valor: false }, { texto: 'Mayorista · Pack', valor: 'pack' }, { texto: 'Mayorista · Bulto', valor: 'bulto' }];
function accionesMayoristaLst(p) {
  if (p.plu == null) return null;
  const actual = tipoMayLst(p) || false;
  return [...OPCIONES_MAY_LST.map(o => ({ ...o, pressed: o.valor === actual })), ...(p.mayoristaOrigen === 'manual' ? [{ texto: 'Volver a automático', valor: null, pressed: false }] : [])];
}
function htmlAccionMayoristaLst(p) {
  const acciones = accionesMayoristaLst(p);
  if (!acciones) return '';
  const plu = ESC_LST(p.plu), nom = ESC_LST(p.nombre), cls = 'whitespace-nowrap px-2 py-0.5 rounded border border-borde text-xs font-semibold';
  const btn = a => `<button type="button" class="lst-may ${cls} ${a.pressed ? 'bg-ink text-white' : 'hover:bg-white'}" data-plu="${plu}" data-valor="${ESC_LST(JSON.stringify(a.valor))}" ${a.valor === null ? '' : `aria-pressed="${a.pressed}" `}aria-label="${a.texto}: ${nom}">${a.texto}</button>`;
  return `<span class="solo-config inline-flex flex-wrap items-center gap-1 ml-2 align-middle font-normal">`
    + acciones.map(btn).join('')
    + `<span class="lst-may-msg text-xs text-crit" role="alert"></span></span>`;
}
// Detalle del precio mayorista junto al sugerido. Para una presentación mayorista con descuento el sugerido (m.precio) es el precio SIN IVA $/kg del tipo
// elegido (Pack s/IVA o Bulto s/IVA; Δ%, estado y margen ya vienen contra él); el otro tipo (c/IVA) y minoristaOriginal (el minorista de antes, con IVA) son
// datos informativos. Mayorista sin esos campos = margen fijo del producto (sin descuento). null = no es mayorista o la fuente no tiene precio.
const PESOS_LST = n => '$ ' + new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 }).format(n);
const PCT_LST = n => new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1 }).format(n) + ' %';
const TXT_MARGEN_FIJO_LST = 'Margen fijo del producto: sin descuento mayorista';
function detalleMayoristaLst(p, s) {
  if (!p || p.mayorista !== true || !s || s.error || !s.minorista) return null;
  const m = s.minorista, pack = m.pack || null, bulto = m.bulto || null;
  if (m.minoristaOriginal == null && !pack && !bulto) return { fijo: true, titulo: TXT_MARGEN_FIJO_LST };
  const tipo = m.tipoMayorista === 'pack' || m.tipoMayorista === 'bulto' ? m.tipoMayorista : tipoMayLst(p);
  const marg = (txt, x) => (x && x.margenPct != null ? `${txt} ${PCT_LST(x.margenPct)}` : '');
  const titulo = [`Precio sugerido = ${tipo} SIN IVA`, [marg('Margen efectivo del bulto', bulto), marg('pack', pack)].filter(Boolean).join(' · ')].filter(Boolean).join('. ');
  const otro = tipo === 'pack' ? bulto : pack;
  return { fijo: false, tipo, etiqueta: `${TIPO_MAY_LST[tipo]} s/IVA`, antes: m.minoristaOriginal ?? null, packIva: pack ? pack.conIva : null, packNeto: pack ? pack.neto : null, bultoIva: bulto ? bulto.conIva : null,
    otroEtiqueta: tipo === 'pack' ? 'Bulto' : 'Pack', otroIva: otro ? otro.conIva : null, titulo };
}
function htmlDetalleMayoristaLst(p, s) {
  const d = detalleMayoristaLst(p, s);
  if (!d) return '';
  const cls = 'text-[11px] text-gris font-normal whitespace-nowrap';
  if (d.fijo) return `<div class="${cls}" title="${ESC_LST(d.titulo)}">margen fijo · sin dto. mayorista</div>`;
  const otro = d.otroIva == null ? '' : ` · ${d.otroEtiqueta} ${PESOS_LST(d.otroIva)} c/IVA`, antes = d.antes == null ? '' : ` · antes <s>${PESOS_LST(d.antes)}</s>`;
  return `<div class="${cls}" title="${ESC_LST(d.titulo)}"><span class="font-semibold text-ink/70">${d.etiqueta}</span>${otro}${antes}</div>`;
}
const celdaPrecioPres = (p, s) => celdaPrecio(s) + htmlDetalleMayoristaLst(p, s);

const PE_LST = typeof module === 'object' && module.exports ? require('../../lib/precios_esquema') : PreciosEsquema;

// Las presentaciones de UN granel con la marca de plu ya cambiada: reclasifica todas juntas con el esquema compartido (mayoristasDeGranel), así aplica la regla
// de 2 mayoristas igual que el server. Las marcas a mano de las otras presentaciones se conservan (origen 'manual').
function conMarcaMayoristaGranelLst(pres, plu, valor, pesoMinG) {
  const manual = valor === false || valor === true || valor === 'pack' || valor === 'bulto';
  const porPlu = {};
  for (const p of pres) if (p.mayoristaOrigen === 'manual') porPlu[p.plu] = p.mayorista ? (p.mayoristaTipo === 'pack' ? 'pack' : 'bulto') : false;
  if (manual) porPlu[plu] = valor; else delete porPlu[plu];
  const rs = PE_LST.mayoristasDeGranel(pres.map(p => ({ pesoG: p.pesoG, plu: p.plu })), { pesoMinG, porPlu });
  return pres.map((p, i) => ({ ...p, mayorista: rs[i].mayorista, mayoristaOrigen: rs[i].origen, mayoristaTipo: rs[i].mayorista ? (rs[i].tipo === 'pack' ? 'pack' : 'bulto') : null, mayoristaTipoOrigen: rs[i].tipoOrigen }));
}

// PLU del granel (fila de primer nivel) que contiene la presentación plu; null si no está.
function granelDePresentacionLst(filas, plu) {
  const g = (filas || []).find(f => (f.presentaciones || []).some(p => String(p.plu) === String(plu)));
  return g ? g.plu : null;
}

// ── Orden ────────────────────────────────────────────────────────────────────────
// Headers ordenables de precios_comun.js (montarOrden/ordenarCon). Siempre hay un orden: por defecto el nombre A→Z (es, sin
// mayúsculas ni acentos). Nulls al final. Fraccionado ordena los granel: cada uno lleva dentro sus presentaciones (en el
// orden del server, por peso), así que quedan juntas bajo su granel.
const ORDENAR_LST = typeof module === 'object' && module.exports ? require('./precios_comun.js').ordenarCon : ordenarCon;
const ORDEN_LST_DEFECTO = { clave: 'nombre', dir: 'asc' };
const precioSugerido = s => (s && s.minorista ? s.minorista.precio : null);
const COLUMNAS_LST = {
  plu: f => f.plu,
  nombre: f => (f.plu == null ? null : f.nombre), // "Sin granel asignado" (plu null) siempre al final
  costoSistema: f => f.costoSistema, ultimaCompra: f => f.costoUltimaCompra, deltaUltima: f => f.deltaUltimaPct, proveedor: f => f.proveedor, tipoProveedor: f => f.tipoProveedor || null, vigente: f => f.vigente,
  sugeridoSistema: f => precioSugerido((f.sugeridos || {}).sistema), sugeridoUltima: f => precioSugerido((f.sugeridos || {}).ultimaCompra),
};
const ordenarListado = (filas, orden) => ORDENAR_LST(filas, orden || ORDEN_LST_DEFECTO, COLUMNAS_LST);
// siguienteOrden cicla asc → desc → null (orden original); acá no hay "sin orden": el tercer clic vuelve a asc.
const ordenSinNulo = (previo, o) => o || { clave: previo.clave, dir: 'asc' };

// Producción: filas del sub-tab (Con receta = 'receta', default de las filas sin tipo; Envasado Apidelta = 'envasado').
// clase null (otras tabs) → todas.
const filasDeClase = (filas, clase) => (clase ? filas.filter(f => (f.tipoProduccion || 'receta') === clase) : filas);

// Export: las 5 listas del server (en este orden) con su etiqueta y cuántas filas trae cada una (sin el encabezado).
const ETIQUETA_LISTA = { minorista: 'Minorista', packNeto: 'Pack s/IVA', packIva: 'Pack c/IVA', bultoNeto: 'Bulto s/IVA', bultoIva: 'Bulto c/IVA' };
const resumenExport = listas => Object.keys(ETIQUETA_LISTA).map(lista => {
  const filas = (listas || {})[lista] || [];
  return { lista, etiqueta: ETIQUETA_LISTA[lista], filas: Math.max(filas.length - 1, 0) };
});

// Export "todo junto": varias listas del server en UN archivo (el PLU de minorista, pack y bulto es distinto: las filas no se pisan).
// Se suman al diálogo como filas de resumen extra; las 5 listas de arriba siguen bajando una por archivo.
const LISTAS_JUNTAS = { minoristaPackBultoNeto: { etiqueta: 'Todo junto: Minorista + Pack s/IVA + Bulto s/IVA', claves: ['minorista', 'packNeto', 'bultoNeto'], archivo: 'minorista_pack_bulto_sin_iva' } };
const juntarListas = (listas = {}, claves) => [(listas[claves[0]] || [[]])[0], ...claves.flatMap(c => (listas[c] || []).slice(1))];
const resumenJuntas = listas => Object.entries(LISTAS_JUNTAS).map(([lista, { etiqueta, claves }]) => ({ lista, etiqueta, filas: juntarListas(listas, claves).length - 1 }));

// <select> de decisión de una fila. ops = opcionesSelect(fila, tipo) (precios_modal_esquema.js: mismas cifras que el modal).
// La celda de Envasado lo pide deshabilitado mientras el producto base tiene cambios sin guardar. .lst-dec-msg: error inline.
const ESC_LST = typeof module === 'object' && module.exports ? require('./precios_comun.js').esc : esc;
function htmlSelectDecision(fila, ops, { deshabilitado = false, titulo = '' } = {}) {
  const actual = fila.decision ? fila.decision.fuente : '';
  return `<select class="lst-decision num-in text-left${actual ? ' on' : ''}" data-plu="${ESC_LST(fila.plu)}" data-actual="${ESC_LST(actual)}" aria-label="Decisión de precio: ${ESC_LST(fila.nombre)}"${deshabilitado ? ' disabled' : ''}${titulo ? ` title="${ESC_LST(titulo)}"` : ''}>${
    ops.map(o => `<option value="${ESC_LST(o.valor)}"${o.valor === actual ? ' selected' : ''}${o.disabled ? ' disabled' : ''}>${ESC_LST(o.texto)}</option>`).join('')}</select><div class="lst-dec-msg text-xs text-crit" role="alert"></div>`;
}

// "Exportar listado (.xlsx)": reporte (no el formato de SIGA) de las filas YA filtradas y ordenadas del tab, todas (no sólo
// decididas). Devuelve la planilla como array de filas con encabezado: números reales (null = vacío) y Δ% como fracción
// (formato 0.0 % en Excel). Precio nuevo = el minorista sugerido de cada fuente (el mismo de la pantalla). Fraccionado: una
// fila por presentación con el costo $/kg de su granel; Producción: el costo es el de la receta/envasado, sin última compra.
const TXT_TIPO_PROVEEDOR = { directo: 'Directo', distribuidor: 'Distribuidor' };
const deltaFrac = (nuevo, base) => (nuevo != null && base > 0 ? Math.round(((nuevo - base) / base) * 10000) / 10000 : null);
// PLU de la planilla = número (como el Codigo del export a SIGA, lib/precios_listado_esquema codigoNumerico); no numérico/null quedan como están.
const pluXlsx = plu => (/^\d+$/.test(String(plu)) ? Number(plu) : plu);
const ENC_COSTOS_XLSX = ['Costo actual (sistema)', 'Costo última compra', 'Δ% costo (última vs actual)', 'Fecha última compra'];
const ENC_MAYORISTA_XLSX = ['Mayorista', 'Precio mayorista con IVA', 'Precio minorista anterior']; // últimas columnas del export de Fraccionado: las anteriores no se mueven. El sugerido de una mayorista es el bulto o el pack SIN IVA (m.tipoMayorista). Precio mayorista con IVA (del mismo tipo que el sugerido) y minorista anterior: con costo actual (sistema), sólo si es mayorista con descuento
const extrasMayoristaXlsx = p => { const m = p && p.mayorista === true && p.sugeridos && p.sugeridos.sistema && p.sugeridos.sistema.minorista; const t = m && m[m.tipoMayorista || 'bulto']; return [t ? t.conIva : null, m && m.minoristaOriginal != null ? m.minoristaOriginal : null]; };
const ENC_PRECIOS_XLSX = ['Precio actual', 'Precio nuevo con costo actual', 'Δ% (vs precio actual)', 'Precio nuevo con costo última compra', 'Δ% (vs precio actual)'];
function filasExportListado(filas, tipo) {
  const precios = (p, conUltima = true) => {
    const vig = p ? p.vigente ?? null : null, sug = p ? p.sugeridos || {} : {};
    const sis = precioSugerido(sug.sistema) ?? null, ult = precioSugerido(sug.ultimaCompra) ?? null;
    const vn = f => (f && f.minorista && f.minorista.vigenteNeto != null ? f.minorista.vigenteNeto : vig); // mayorista con descuento: sugerido sin IVA, se compara con vigenteNeto (como el listado)
    return [vig, sis, deltaFrac(sis, vn(sug.sistema)), ...(conUltima ? [ult, deltaFrac(ult, vn(sug.ultimaCompra))] : [])];
  };
  if (tipo === 'produccion') {
    return [['PLU', 'Nombre', 'Costo actual (receta/envasado)', ...ENC_PRECIOS_XLSX.slice(0, 3)],
      ...filas.map(f => [pluXlsx(f.plu), f.nombre, f.costoSistema ?? null, ...precios(f, false)])];
  }
  const costos = f => [f.costoSistema ?? null, f.costoUltimaCompra ?? null, deltaFrac(f.costoUltimaCompra, f.costoSistema), f.fechaUltimaCompra || null];
  // Reventa: el proveedor de la última compra va justo después de su fecha, y a continuación su tipo (Directo/Distribuidor).
  if (tipo !== 'fraccionado') return [['PLU', 'Nombre', ...ENC_COSTOS_XLSX, 'Proveedor', 'Tipo proveedor', ...ENC_PRECIOS_XLSX],
    ...filas.map(f => [pluXlsx(f.plu), f.nombre, ...costos(f), f.proveedor || null, TXT_TIPO_PROVEEDOR[f.tipoProveedor] || null, ...precios(f)])];
  const granel = g => (g.plu == null ? g.nombre : `${g.plu} · ${g.nombre}`);
  // Vinculados pack/bulto de SIGA (p.mayoristas / g.mayoristas): una fila 'Sí' por cada uno, una sola vez por plu. Vigente y neto sin IVA.
  const vistos = new Set();
  const filasVinculadosXlsx = (g, lista, dueno) => (lista || []).filter(v => !vistos.has(String(v.plu)) && vistos.add(String(v.plu))).map(v => {
    const sug = fuente => (((dueno || {}).sugeridos || {})[fuente] || {}).mayoristas; // sugeridos del dueño del vínculo (presentación o granel)
    const de = fuente => (sug(fuente) || []).find(s => String(s.plu) === String(v.plu)) || null;
    const vig = v.vigente || null, sis = de('sistema'), ult = de('ultimaCompra');
    return [pluXlsx(v.plu), v.nombre, granel(g), ...costos(g), vig, sis ? sis.neto ?? null : null, deltaFrac(sis ? sis.neto : null, vig),
      ult ? ult.neto ?? null : null, deltaFrac(ult ? ult.neto : null, vig), 'Sí', sis ? sis.conIva ?? null : null, null];
  });
  return [['PLU', 'Nombre', 'Granel', ...ENC_COSTOS_XLSX, ...ENC_PRECIOS_XLSX, ...ENC_MAYORISTA_XLSX], ...filas.flatMap(g => {
    const pres = g.presentaciones || [];
    const filasPres = pres.flatMap(p => [[pluXlsx(p.plu), p.nombre, granel(g), ...costos(g), ...precios(p), p.mayorista === true ? 'Sí' : 'No', ...extrasMayoristaXlsx(p)],
      ...filasVinculadosXlsx(g, p.mayoristas, p)]);
    // El granel va como un ítem más (tras sus presentaciones) con su costo y los precios en 0: no se vende, es referencia de costo.
    // El grupo "Sin granel asignado" (plu null) sólo aparece si no tiene presentaciones.
    // Si el granel es además una de sus presentaciones (venta directa, "… DEPOSITO VENTAS") ya sale con su precio: no se repite en 0.
    const esPropia = pres.some(p => String(p.plu) === String(g.plu));
    const filaGranel = !esPropia && (g.plu != null || !pres.length) ? [[pluXlsx(g.plu), g.nombre, granel(g), ...costos(g), 0, 0, null, 0, null, null, null, null]] : [];
    return [...filasPres, ...filaGranel, ...filasVinculadosXlsx(g, g.mayoristas, g)];
  })];
}

// "Importar planilla" (Reventa): la planilla Codigo/Nombre/Costo/Precio que se subió a SIGA. rows = la hoja como array de
// filas (XLSX sheet_to_json header:1); primeraFila = nro de fila de Excel de rows[0]. Encabezado = la primera fila con
// "codigo" y "costo"/"precio" (fila 1, o 4 como el formato SIGA), columnas en cualquier orden; "Venta" (formato del export a
// SIGA) vale como Precio. → { filas: [{ codigo, nombre, costo, precio, fila }], errores: [{ fila, codigo, nombre, motivo }] } o { error }.
const ENC_PLANILLA = { codigo: ['codigo'], nombre: ['nombre'], costo: ['costo'], precio: ['precio', 'venta'] };
// Celda → número, null (vacía) o NaN. Texto "1.234,56" o "$ 1234.5" también.
const numPlanilla = v => {
  if (typeof v === 'number') return v;
  const t = String(v ?? '').replace(/[$\s]/g, '');
  return t === '' ? null : Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t);
};
function parsearPlanillaDecisiones(rows, primeraFila = 1) {
  const hoja = Array.isArray(rows) ? rows : [];
  const celdas = r => (Array.isArray(r) ? r.map(c => normL(c).trim()) : []);
  const idx = hoja.findIndex(r => { const c = celdas(r); return c.includes('codigo') && ['costo', 'precio', 'venta'].some(k => c.includes(k)); });
  if (idx < 0) return { error: 'No se encontró el encabezado (Codigo, Nombre, Costo, Precio)' };
  const enc = celdas(hoja[idx]);
  const col = Object.fromEntries(Object.entries(ENC_PLANILLA).map(([k, nombres]) => [k, enc.findIndex(e => nombres.includes(e))]));
  const filas = [], errores = [];
  hoja.slice(idx + 1).forEach((r, i) => {
    if (!Array.isArray(r) || r.every(v => String(v ?? '').trim() === '')) return; // fila vacía
    const celda = k => (col[k] < 0 ? null : r[col[k]] ?? null);
    const fila = primeraFila + idx + 1 + i;
    const codigo = String(celda('codigo') ?? '').trim().replace(/^0+(?=\d)/, ''), nombre = String(celda('nombre') ?? '').trim();
    const costo = numPlanilla(celda('costo')), precio = numPlanilla(celda('precio'));
    const motivo = !/^\d{1,12}$/.test(codigo) ? 'Código inválido' : Number.isNaN(costo) || Number.isNaN(precio) ? 'Costo o precio no numérico'
      : costo == null && precio == null ? 'Sin costo ni precio' : null;
    if (motivo) errores.push({ fila, codigo, nombre, motivo });
    else filas.push({ codigo, nombre, costo, precio, fila });
  });
  return { filas, errores };
}
// Resultado del POST importar-decisiones (+ filas con error de la planilla) → la línea de resumen del diálogo.
function textoResumenImportacion({ marcados = {}, sinCoincidencia = [], noEncontrados = [] }, errores = 0) {
  const { sistema = 0, ultimaCompra = 0, manual = 0 } = marcados;
  return `${sistema + ultimaCompra + manual} marcados (${sistema} con costo sistema, ${ultimaCompra} con última compra${manual ? `, ${manual} manual` : ''})`
    + ` · ${sinCoincidencia.length} sin coincidencia · ${noEncontrados.length} códigos no encontrados${errores ? ` · ${errores} filas con error` : ''}`;
}
// Planilla "no marcados": sin coincidencia, no encontrados y filas con error (PLU numérico como el resto de los .xlsx).
const filasNoMarcados = lista => [['PLU', 'Nombre', 'Costo planilla', 'Precio planilla', 'Costo sistema', 'Costo última compra', 'Sugerido sistema', 'Sugerido última compra', 'Motivo'],
  ...lista.map(r => [pluXlsx(r.codigo), r.nombre || null, r.costo ?? null, r.precio ?? null, r.costoSistema ?? null, r.costoUltimaCompra ?? null,
    r.sugeridoSistema ?? null, r.sugeridoUltimaCompra ?? null, r.motivo])];

// Costeo de Fraccionado (spec 2026-10-29): textos de los avisos que no bloquean el precio (se completan en Configuración › Costeo Fraccionado:
// min/kg del subrubro, envase por peso, costo hora; o el min/kg y el envase propios en el modal del granel) y "subrubro · min/kg · máquina · bobina" del granel.
const TXT_AVISO_COSTO = { sinPeso: 'presentación sin peso en el nombre (sólo mercadería)', sinMinutos: 'sin min/kg (ni del subrubro ni del producto): sin mano de obra ni máquina',
  costoHora: 'sin costo hora de Fraccionado', sinBolsa: 'sin bolsa cargada para su peso: el costo no incluye envase',
  sinBobina: 'sin peso de bolsa cargado para su peso: el costo no incluye envase',
  valorEnergia: 'máquina con consumo y sin valor de energía: el costo no incluye la energía' };
const textoAvisosCosto = avisos => (avisos || []).map(a => TXT_AVISO_COSTO[a] || a);
// costeoGranel sólo llega con el permiso de Configuración (CLAVES_OCULTAS). Sin máquina y con bolsa no se nombran: es el estado normal.
const numMinLst = n => new Intl.NumberFormat('es-AR', { maximumFractionDigits: 4 }).format(n);
const textoMinKgLst = c => (c.minKgOrigen === 'granel' ? `${numMinLst(c.minKgPropio)} min/kg (propio)` : c.minKgOrigen === 'subrubro' ? `${numMinLst(c.minKgSubrubro)} min/kg` : 'sin min/kg');
const textoCosteoGranel = c => [c.subrubro || 'sin subrubro', textoMinKgLst(c), c.maquina, c.envase === 'bobina' && 'bobina'].filter(Boolean).join(' · ');

// Tab Fraccionado: el granel es la fila principal y sus presentaciones se despliegan con ▸/▾ (cerrado por defecto). Clave del
// grupo = PLU del granel ('sin' para el "sin granel"). abiertos = Map clave → lo elegido con el botón, que manda; sin elegir, se
// abre sólo si el texto buscado coincide con una presentación y no con el granel (si no, la fila no explicaría por qué está).
const claveGrupoLst = f => (f.plu == null ? 'sin' : String(f.plu));
function abiertoLst(f, abiertos, texto = '') {
  const k = claveGrupoLst(f);
  if (abiertos.has(k)) return abiertos.get(k);
  const t = normL(texto.trim()), cae = s => normL(s).includes(t);
  return !!t && !cae(`${f.plu ?? ''} ${f.nombre}`) && (f.presentaciones || []).some(p => cae(`${p.plu} ${p.nombre}`));
}
// Botón ▸/▾ + "N presentaciones", antes del nombre del granel. Sin presentaciones no hay nada que desplegar.
function htmlDesplegarLst(f, abierto) {
  const n = (f.presentaciones || []).length;
  if (!n) return '';
  return `<button type="button" class="lst-desplegar w-5 text-verde" data-grupo="${ESC_LST(claveGrupoLst(f))}" aria-expanded="${abierto}" aria-label="${abierto ? 'Ocultar' : 'Mostrar'} las presentaciones de ${ESC_LST(f.nombre)}">${abierto ? '▾' : '▸'}</button>`
    + `<span class="text-xs text-gris font-normal mr-1">${n} presentaci${n === 1 ? 'ón' : 'ones'}</span> `;
}

// Title del badge "$=" (Reventa con precio fijo, costeo.precioFijo): "Minorista $ 3.999 · Bulto $ 12,50". fmtSug (precios_modal_esquema.js; se resuelve al llamar, el orden de los scripts no importa).
const FMT_SUG_LST = v => (typeof module === 'object' && module.exports ? require('./precios_modal_esquema.js').fmtSug : fmtSug)(v);
const CANALES_PF_LST = [['minorista', 'Minorista'], ['pack', 'Pack'], ['bulto', 'Bulto']];
const textoPrecioFijoLst = pf => CANALES_PF_LST.filter(([c]) => pf && pf[c] > 0).map(([c, t]) => `${t} $ ${FMT_SUG_LST(pf[c])}`).join(' · ');

if (typeof module === 'object' && module.exports) module.exports = { htmlSelectDecision, filtrarFilas, ordenarListado, ordenSinNulo, filasDeClase, resumenExport, juntarListas, resumenJuntas, filasExportListado,
  parsearPlanillaDecisiones, textoResumenImportacion, filasNoMarcados, textoAvisosCosto, textoCosteoGranel, claveGrupoLst, abiertoLst, htmlDesplegarLst,
  contarOcultables, textoMotivosActividad, textoInactivoLst, textoActivoPorStockLst, textoActivoPorPresentacionesLst, htmlBadgesActividadLst, textoPrecioFijoLst, accionActividadLst, conActividadLst, htmlBadgeMayoristaLst, tipoMayLst, textoReglaMayLst, AYUDA_REGLA_MAY, textoOmitidosMayoristaLst, detalleMayoristaLst, htmlDetalleMayoristaLst, accionesMayoristaLst, htmlAccionMayoristaLst, conMarcaMayoristaGranelLst, granelDePresentacionLst };

// ── DOM ─────────────────────────────────────────────────────────────────────────
const LST_CONT = { almacen: 'lstAlmacen', fraccionado: 'lstFracc', produccion: 'prodContenido' };
const lstCols = tipo => (tipo === 'produccion' ? 8 : tipo === 'almacen' ? 11 : 9); // Reventa suma Proveedor y Tipo
let lstDatos = {};                                                  // tipo → filas del server
let lstVariedadesEnv = [];                                          // variedades envasadas (tarjetas de producto base, resumenBases)
let lstCostoFamiliaEnv = {};                                        // producto base → precio de materia prima $/kg (GET /envasado/opciones)
let lstOrden = { almacen: ORDEN_LST_DEFECTO, fraccionado: ORDEN_LST_DEFECTO, produccion: ORDEN_LST_DEFECTO }; // orden por tab (sobrevive recargas y filtros)
const lstFiltros = { almacen: {}, fraccionado: {}, produccion: {}, envasado: {} }; // estado de los filtros por tab (sobrevive recargas)
const abiertosLst = new Map(); // ponytail: Fraccionado, grupos abiertos/cerrados con ▸/▾ (abiertoLst); estado de UI que se muta en el lugar
// Producción: los dos sub-tabs comparten datos y orden, pero cada uno tiene su búsqueda (prodClase, precios_produccion.js).
const claseLst = tipo => (tipo === 'produccion' ? prodClase : null);
const filtrosLst = tipo => lstFiltros[claseLst(tipo) === 'envasado' ? 'envasado' : tipo];
const visiblesLst = new Set(); // ponytail: PLU de graneles con el estado recién cambiado (siempreVisibles); estado de UI que se muta en el lugar
const filtrosBusqueda = tipo => ({ ...filtrosLst(tipo), proveedor: tipo === 'almacen', siempreVisibles: visiblesLst, // lo que recibe filtrarFilas
  clasificacion: tipo !== 'almacen' ? null : filtrosLst(tipo).sinClasificar ? 'sin' : 'con' });
const NOMBRE_LISTA = { minorista: 'minorista', packNeto: 'pack_sin_iva', packIva: 'pack_con_iva', bultoNeto: 'bulto_sin_iva', bultoIva: 'bulto_con_iva' };

const vigenteTxt = v => (v == null ? '<span class="text-gris">—</span>' : '$ ' + fmtPrecio(v));
function celdaPrecio(s) {
  if (!s || s.error) return '<span class="text-gris">—</span>';
  const m = s.minorista;
  return `<b>$ ${fmtPrecio(m.precio)}</b>${m.deltaPct == null ? '' : ` <span class="text-xs ${claseDelta(m.estado)}">${fmtPct(m.deltaPct)}</span>`}`;
}
// Chip "hoy": hay una compra del producto cargada hoy en SIGA (puede no ser la última por fecha de factura).
const chipHoy = f => (f.ingresoHoy ? ' <span class="px-1.5 rounded-full text-[11px] font-semibold bg-ok/15 text-ok" title="Compra cargada hoy en SIGA">hoy</span>' : '');
function celdaUltima(f) {
  if (f.costoUltimaCompra == null) return `<span class="text-gris">—</span>${chipHoy(f)}`;
  return `$ ${fmtMoney(f.costoUltimaCompra)}<div class="text-xs text-gris">${esc(fmtFechaPrecio(f.fechaUltimaCompra) || '')}${chipHoy(f)}</div>`;
}
const celdaDeltaUltima = f => (f.deltaUltimaPct == null ? '<span class="text-gris">—</span>'
  : `<span class="${f.deltaUltimaPct > 0 ? 'text-crit' : 'text-ok'}">${fmtPct(f.deltaUltimaPct)}</span>`);
// Proveedor de la última compra (Reventa): truncado, con el nombre completo en el tooltip.
const celdaProveedor = f => `<td class="p-2 max-w-[180px] truncate"${f.proveedor ? ` title="${esc(f.proveedor)}"` : ''}>${f.proveedor ? esc(f.proveedor) : '<span class="text-gris">—</span>'}</td>`;
// Tipo de proveedor (Reventa): chip compacto; sin clasificar → "—".
const celdaTipoProveedor = f => `<td class="p-2">${f.tipoProveedor ? `<span class="px-1.5 py-0.5 rounded text-[11px] font-semibold whitespace-nowrap ${
  f.tipoProveedor === 'directo' ? 'bg-verde/10 text-verde' : 'bg-ink/10 text-ink'}">${TXT_TIPO_PROVEEDOR[f.tipoProveedor]}</span>` : '<span class="text-gris">—</span>'}</td>`;
// Margen del producto (sólo llega con el permiso de Configuración: CLAVES_OCULTAS lo saca sin él). "m=" margen fijo, "±m"
// ajuste (sin modo = dato viejo, ajuste).
const TXT_CANAL_LST = { minorista: 'Minorista', pack: 'Pack', bulto: 'Bulto' };
const BADGE_MARGEN_LST = {
  fijo: { marca: 'm=', titulo: 'Margen fijo', valor: v => `${fmtNum(v)} %` },
  ajuste: { marca: '±m', titulo: 'Ajuste de margen', valor: v => `${v > 0 ? '+' : ''}${fmtNum(v)} %` },
};
const badgeMargenProducto = f => {
  if (preciosSinConfig || !f.margenProducto) return '';
  const { modo = 'ajuste', ...canales } = f.margenProducto;
  const b = BADGE_MARGEN_LST[modo] || BADGE_MARGEN_LST.ajuste;
  const t = Object.entries(canales).map(([c, v]) => `${TXT_CANAL_LST[c] || c} ${b.valor(v)}`).join(' · ');
  return ` <span class="ml-1 px-1.5 py-0.5 rounded text-[11px] font-semibold bg-ink/10 text-ink whitespace-nowrap" title="${b.titulo} del producto: ${esc(t)}">${b.marca}</span>`;
};
// Precio fijo (Reventa, costeo.precioFijo): público (como el costo manual), lo ve cualquier usuario del módulo.
// Fraccionado: la presentación con precioFijo (precio de la bolsa) y el granel con decisión 'precio'.
const badgePrecioFijo = f => {
  const granelFijo = Array.isArray(f.presentaciones) && f.decision && f.decision.fuente === 'precio';
  const titulo = f.precioFijo ? `Precio fijo del producto: ${textoPrecioFijoLst(f.precioFijo)}` : granelFijo ? 'Decisión: precio fijo en sus presentaciones' : '';
  const fijo = titulo ? ` <span class="ml-1 px-1.5 py-0.5 rounded text-[11px] font-semibold bg-ink/10 text-ink whitespace-nowrap" title="${esc(titulo)}">$=</span>` : '';
  const sinVigente = f.decisionPrecioSinVigente ? ' <span class="ml-1 px-1.5 py-0.5 rounded text-[11px] font-semibold bg-warn/15 text-warn whitespace-nowrap" title="La decisión de precio fijo quedó sin presentación vigente (se marcó mayorista). Elegí otra fuente o cargá un precio fijo.">$= sin vigente</span>' : '';
  return fijo + sinVigente;
};
// Avisos del costeo (⚠ n, detalle en el title) + subrubro · min/kg · máquina del granel. avisosCosto es público; costeoGranel no.
const badgeAvisosCosto = f => ((f.avisosCosto || []).length
  ? ` <span class="ml-1 px-1.5 py-0.5 rounded text-[11px] font-semibold bg-warn/15 text-warn whitespace-nowrap" title="${ESC_LST(textoAvisosCosto(f.avisosCosto).join('\n'))}">⚠ ${f.avisosCosto.length}</span>` : '')
  + (f.costeoGranel ? ` <span class="text-xs text-gris font-normal">${ESC_LST(textoCosteoGranel(f.costeoGranel))}</span>` : '');
// faltantesCosto = PLU de la bolsa o '_bobina' (sin $/kg) sin costo: la presentación queda sin sugerido.
const textoFaltanteCosto = x => (x === '_bobina' ? 'bobina' : `PLU ${x}`);
const badgeFaltanteCosto = p => ((p.faltantesCosto || []).length
  ? ` <span class="ml-1 text-[11px] text-crit" title="Sin costo: la presentación no tiene sugerido">sin costo: ${ESC_LST(p.faltantesCosto.map(textoFaltanteCosto).join(', '))}</span>` : '');
// Clic en el nombre = modal del producto (detalle del cálculo, costos, márgenes). La decisión rápida es el select de la fila
// (Fraccionado: en el granel, vale para sus presentaciones; el "sin granel" no tiene). Producción además tiene el botón
// "Precios" a la vista (el nombre solo no se veía clickeable).
const botonNombre = f => `<button type="button" class="lst-abrir text-left hover:text-verde hover:underline" data-plu="${esc(f.plu ?? '')}"${f.plu == null ? ' disabled' : ''}>${esc(f.nombre)}</button>${badgeMargenProducto(f)}${badgePrecioFijo(f)}`;
const celdaDecision = (f, tipo) => (f.plu == null ? '' : htmlSelectDecision(f, opcionesSelect(f, tipo))); // opcionesSelect: precios_modal_esquema.js

// abierto: Fraccionado, si se pintan las presentaciones del granel (abiertoLst).
function filaHtml(f, tipo, abierto = false) {
  const fracc = tipo === 'fraccionado';
  // lst-inactivo: granel inactivo visible (con "Ver inactivos") atenuado; bg-verde/5: tiene decisión.
  const clases = [f.decision ? 'bg-verde/5' : '', fracc && f.activo === false ? 'lst-inactivo' : ''].filter(Boolean).join(' ');
  const marca = clases ? ` class="${clases}"` : '';
  if (tipo === 'produccion') {
    const rev = textoRevisar(f.aRevisar); // precios_produccion.js
    return `<tr${marca}><td class="p-2">${esc(f.plu)}</td><td class="p-2">${botonNombre(f)}</td>
      <td class="p-2 num">${f.costoSistema == null ? '<span class="text-gris">—</span>' : '$ ' + fmtMoney(f.costoSistema)}</td>
      <td class="p-2 num">${vigenteTxt(f.vigente)}</td><td class="p-2 num">${celdaPrecio(f.sugeridos.sistema)}</td>
      <td class="p-2">${rev ? `<span class="px-1.5 py-0.5 rounded text-[11px] font-semibold bg-warn/15 text-warn" title="${esc(f.aRevisar.map(x => textoRevisar([x])).join('\n'))}">⚠ ${esc(rev)}</span>` : ''}</td>
      <td class="p-2">${celdaDecision(f, tipo)}</td>
      <td class="p-2 whitespace-nowrap"><button type="button" class="lst-abrir cfg-btn2 mr-2" data-plu="${esc(f.plu)}">Precios</button><a class="text-xs text-verde underline underline-offset-2" href="#produccion/${encodeURIComponent(f.productoId)}">Receta</a></td></tr>`;
  }
  const subfilas = !abierto ? '' : (f.presentaciones || []).map(p => `<tr class="text-ink/80"><td class="p-2 pl-6 text-gris">${esc(p.plu)}</td><td class="p-2 pl-7">↳ ${esc(p.nombre)}${htmlBadgeMayoristaLst(p)}${badgeFaltanteCosto(p)}${htmlAccionMayoristaLst(p)}</td>
    <td></td><td></td><td></td><td class="p-2 num">${vigenteTxt(p.vigente)}</td>
    <td class="p-2 num">${celdaPrecioPres(p, p.sugeridos.sistema)}</td><td class="p-2 num">${celdaPrecioPres(p, p.sugeridos.ultimaCompra)}</td><td></td></tr>`).join('');
  return `<tr${marca}><td class="p-2">${esc(f.plu ?? '—')}</td><td class="p-2 font-semibold">${fracc ? htmlDesplegarLst(f, abierto) : ''}${botonNombre(f)}${fracc ? htmlBadgesActividadLst(f) + badgeAvisosCosto(f) : ''}${f.plu == null ? ' <span class="text-gris text-xs font-normal">sin granel</span>' : ''}</td>
    <td class="p-2 num">${f.costoSistema == null ? '<span class="text-gris">—</span>' : '$ ' + fmtMoney(f.costoSistema)}</td>
    <td class="p-2 num">${celdaUltima(f)}</td><td class="p-2 num">${celdaDeltaUltima(f)}</td>${tipo === 'almacen' ? celdaProveedor(f) + celdaTipoProveedor(f) : ''}
    <td class="p-2 num">${fracc ? '' : vigenteTxt(f.vigente)}</td>
    <td class="p-2 num">${fracc ? '' : celdaPrecio(f.sugeridos.sistema)}</td><td class="p-2 num">${fracc ? '' : celdaPrecio(f.sugeridos.ultimaCompra)}</td>
    <td class="p-2">${celdaDecision(f, tipo)}</td></tr>${subfilas}`;
}

function htmlMarcoListado(tipo) {
  const f = filtrosLst(tipo), prod = tipo === 'produccion', fracc = tipo === 'fraccionado', alm = tipo === 'almacen';
  if (claseLst(tipo) === 'envasado') return htmlMarcoBases(f); // precios_produccion_envasado.js: tarjetas de producto base
  // [texto, clave de orden]. En Fraccionado vigente y sugeridos son de las presentaciones, no del granel: no se ordenan.
  const ths = prod ? [['Código', 'plu'], ['Producto', 'nombre'], ['Costo', 'costoSistema'], ['Vigente', 'vigente'], ['Sugerido', 'sugeridoSistema'], ['A revisar'], ['Decisión'], ['']]
    : [['Código', 'plu'], [fracc ? 'Granel / presentación' : 'Producto', 'nombre'],
      ['Costo sistema', 'costoSistema'], ['Última compra', 'ultimaCompra'], ['Δ% vs sistema', 'deltaUltima'],
      ...(alm ? [['Proveedor', 'proveedor'], ['Tipo', 'tipoProveedor']] : []), ['Vigente', !fracc && 'vigente'], ['Sugerido con sistema', !fracc && 'sugeridoSistema'], ['Sugerido con última compra', !fracc && 'sugeridoUltima'], ['Decisión']];
  const toggle = (cls, k, txt) => `<button type="button" class="fbtn ${cls}${f[k] ? ' on' : ''}" aria-pressed="${!!f[k]}">${txt}</button>`;
  return `<div class="lst-aviso hidden mb-3 p-3 rounded-lg bg-warn/10 text-warn text-sm">Falta migrar la configuración al esquema por canal: sin márgenes no hay sugeridos.</div>
  ${fracc ? '<div class="lst-aviso-act hidden mb-3 p-3 rounded-lg bg-warn/10 text-warn text-sm" role="status"></div>' : ''}
  <div class="flex items-center gap-2 mb-3 flex-wrap">
    <button type="button" class="lst-recargar px-3 py-1.5 rounded-lg border border-borde text-sm hover:bg-white">Recargar</button>
    <input type="search" class="lst-buscar px-3 py-1.5 rounded-lg border border-borde bg-bg/60 text-sm w-72" placeholder="Buscar por PLU, nombre${alm ? ' o proveedor' : ''}…" value="${esc(f.texto || '')}">
    ${toggle('lst-decididos', 'soloDecididos', 'Sólo decididos')}
    ${prod ? '' : toggle('lst-mascara', 'ultimaMasCara', 'Última compra más cara')}
    ${prod ? '' : toggle('lst-hoy', 'soloHoy', 'Cargados hoy <span class="fbtn-n lst-hoy-n"></span>')}
    ${alm ? toggle('lst-sinclas', 'sinClasificar', 'Sin clasificar <span class="fbtn-n lst-sinclas-n"></span>') : ''}
    ${fracc ? toggle('lst-reefer', 'verReefer', 'Ver REEFER <span class="fbtn-n lst-reefer-n"></span>') + toggle('lst-inactivos', 'verInactivos', 'Ver inactivos <span class="fbtn-n lst-inactivos-n"></span>') : ''}
    <span class="lst-conteo text-sm text-gris"></span>
    <span class="ml-auto"></span>
    <button type="button" class="lst-quitar px-3 py-1.5 rounded-lg border border-borde text-sm hover:bg-white">Quitar decisiones</button>
    <button type="button" class="lst-exportar-listado px-3 py-1.5 rounded-lg border border-borde text-sm hover:bg-white" title="Todas las filas de la pestaña con los filtros y el orden actuales (reporte, no el formato de SIGA)">Exportar listado (.xlsx)</button>
    ${alm ? '<button type="button" class="lst-importar px-3 py-1.5 rounded-lg border border-borde text-sm hover:bg-white" title="Planilla Codigo/Nombre/Costo/Precio que se subió a SIGA: marca cada producto con el costo que coincide">Importar planilla</button><input type="file" class="lst-importar-archivo hidden" accept=".xls,.xlsx">' : ''}
    <button type="button" class="lst-exportar px-3 py-1.5 rounded-lg bg-verde text-white text-sm font-semibold hover:bg-verdeHover">Exportar decididos</button>
    ${prod ? '<button type="button" class="lst-nuevo cfg-btn" title="Producto con receta (ej. pepas, granola)">+ Nuevo</button>' : ''}
  </div>
  <div class="overflow-x-auto rounded-xl border border-borde shadow-fluent bg-card"><table class="w-full text-sm">
    <thead class="bg-verde/5 text-verde"><tr>${ths.map(([t, k], i) => `<th class="p-2 ${i < 2 || k === 'proveedor' || k === 'tipoProveedor' ? 'text-left' : ''}"${k ? ` data-orden="${k}"` : ''}>${t}</th>`).join('')}</tr></thead>
    <tbody class="lst-cuerpo"><tr><td colspan="${lstCols(tipo)}" class="p-10 text-center text-ink/50"><span class="spin"></span> Cargando…</td></tr></tbody></table></div>`;
}

// ponytail: lstFiltros es estado de UI (no datos del server): se muta en el lugar a propósito.
function conectarListado(tipo, cont) {
  const f = filtrosLst(tipo);
  cont.querySelector('.lst-recargar').onclick = () => cargarListado(tipo);
  cont.querySelector('.lst-buscar').oninput = e => { f.texto = e.target.value; visiblesLst.clear(); renderListado(tipo); };
  [['.lst-decididos', 'soloDecididos'], ['.lst-mascara', 'ultimaMasCara'], ['.lst-hoy', 'soloHoy'], ['.lst-sinclas', 'sinClasificar'], ['.lst-reefer', 'verReefer'], ['.lst-inactivos', 'verInactivos']].forEach(([sel, k]) => {
    const b = cont.querySelector(sel);
    if (b) b.onclick = () => { f[k] = !f[k]; visiblesLst.clear(); b.classList.toggle('on', f[k]); b.setAttribute('aria-pressed', String(f[k])); renderListado(tipo); };
  });
  montarOrdenListado(tipo, cont);
  cont.querySelector('.lst-exportar').onclick = exportarDecididos;
  cont.querySelector('.lst-exportar-listado').onclick = () => exportarListado(tipo);
  const imp = cont.querySelector('.lst-importar'), archivo = cont.querySelector('.lst-importar-archivo');
  if (imp) {
    imp.onclick = () => archivo.click();
    archivo.onchange = () => { const f = archivo.files[0]; archivo.value = ''; if (f) importarPlanilla(f); };
  }
  cont.querySelector('.lst-quitar').onclick = quitarDecisiones;
  const nuevo = cont.querySelector('.lst-nuevo'); // precios_produccion.js / precios_produccion_envasado.js
  if (nuevo) nuevo.onclick = () => (prodClase === 'envasado' ? abrirBaseNueva() : nuevoProducto());
  const cuerpo = cont.querySelector('.lst-cuerpo');
  cuerpo.addEventListener('change', e => { const s = e.target.closest('.lst-decision'); if (s) cambiarDecisionLst(tipo, s); });
  cuerpo.addEventListener('click', e => {
    const d = e.target.closest('.lst-desplegar'); if (d) desplegarLst(tipo, d);
    const m = e.target.closest('.lst-may'); if (m) cambiarMayoristaLst(tipo, m);
    const b = e.target.closest('.lst-abrir'); if (b && b.dataset.plu) abrirModalEsquema(tipo, b.dataset.plu);
    // Envasado Apidelta: tarjeta de producto base → su modal; la tarjeta "Nuevo producto base" → alta.
    const t = e.target.closest('.eb-tarjeta'); if (t) (t.classList.contains('lst-nuevo') ? abrirBaseNueva() : abrirBaseEnvasado(t.dataset.familia));
  });
}
// ▸/▾ de un granel de Fraccionado: invierte lo que se ve, repinta y devuelve el foco al botón nuevo.
function desplegarLst(tipo, boton) {
  const k = boton.dataset.grupo;
  abiertosLst.set(k, boton.getAttribute('aria-expanded') !== 'true');
  renderListado(tipo);
  const nuevo = document.getElementById(LST_CONT[tipo]).querySelector(`.lst-desplegar[data-grupo="${CSS.escape(k)}"]`);
  if (nuevo) nuevo.focus();
}

// Activar / Desactivar / Volver a automático un granel (PUT config/…/fraccionado/subrubros { activos: { [plu]: true | false | null } }, el mismo
// que usa Configuración). Lo llama el modal de Fraccionado (precios_modal_fraccionado.js): PUT + fila local + repintado del listado; la fila queda
// visible hasta el próximo refresco o cambio de filtro. Si falla lanza y no cambia nada.
async function guardarActividadLst(tipo, plu, valor) {
  await pedirJson('PUT', `${API_FR}/subrubros`, { activos: { [plu]: valor } }); // precios_comun.js, precios_config_fraccionado.js
  visiblesLst.add(String(plu));
  if (!lstDatos[tipo]) return;
  lstDatos = { ...lstDatos, [tipo]: lstDatos[tipo].map(f => (String(f.plu) === String(plu) ? conActividadLst(f, valor) : f)) };
  renderListado(tipo);
}
// Forzar Mayorista / Minorista / Volver a automático una presentación (PUT …/fraccionado/mayorista { porPlu: { [plu]: false | 'pack' | 'bulto' | null } }):
// actualiza la presentación local sin recargar el listado. Si falla deja el error junto a los botones y no cambia nada.
// guardarMarcaMayoristaLst es compartido con el modal de Fraccionado: PUT + presentación local + repintado del listado. Devuelve el umbral vigente (g).
async function guardarMarcaMayoristaLst(tipo, plu, valor) {
  const vista = await pedirJson('PUT', `${API_FR}/mayorista`, { porPlu: { [plu]: valor } }); // precios_comun.js, precios_config_fraccionado.js
  const umbral = vista.mayorista ? vista.mayorista.pesoMinG : null;
  if (!lstDatos[tipo]) return umbral;
  const granel = granelDePresentacionLst(lstDatos[tipo], plu);
  if (granel != null) visiblesLst.add(String(granel)); // la fila tocada no se oculta aunque cambie su estado
  lstDatos = { ...lstDatos, [tipo]: lstDatos[tipo].map(g => ({ ...g, presentaciones: (g.presentaciones || []).some(p => String(p.plu) === String(plu)) ? conMarcaMayoristaGranelLst(g.presentaciones, plu, valor, umbral) : g.presentaciones })) };
  renderListado(tipo);
  // pack/bulto de las presentaciones mayoristas cambian en el server: se traen las filas de nuevo (sin repintar el marco: filtros, orden y grupos abiertos quedan)
  try {
    const j = await (await fetch(`/api/precios/esquema/listado?tipo=${tipo}`)).json();
    if (j.error) throw new Error(j.error);
    lstDatos = { ...lstDatos, [tipo]: j.filas };
    renderListado(tipo);
  } catch (e) {
    const err = new Error(`La marca se guardó, pero no se pudieron actualizar los precios del listado (${e.message}). Recargá el listado antes de exportar.`);
    err.marcaGuardada = true;
    throw err;
  }
  return umbral;
}
// Texto del error de guardarMarcaMayoristaLst: si la marca ya se había guardado, el mensaje ya lo dice entero.
const textoErrorMarcaLst = e => (e.marcaGuardada ? e.message : `No se pudo cambiar la marca: ${e.message}`);
async function cambiarMayoristaLst(tipo, boton) {
  if (boton.getAttribute('aria-pressed') === 'true') return; // ya es el estado efectivo
  const plu = boton.dataset.plu, valor = JSON.parse(boton.dataset.valor), grupo = boton.closest('span.solo-config');
  const botones = [...grupo.querySelectorAll('.lst-may')], msg = grupo.querySelector('.lst-may-msg');
  botones.forEach(b => { b.disabled = true; });
  msg.textContent = '';
  try {
    await guardarMarcaMayoristaLst(tipo, plu, valor);
  } catch (e) {
    botones.forEach(b => { b.disabled = false; });
    msg.textContent = textoErrorMarcaLst(e);
    if (!e.marcaGuardada) return;
  }
  const sel = `.lst-may[data-plu="${CSS.escape(plu)}"]`, cont = document.getElementById(LST_CONT[tipo]);
  const nuevo = cont.querySelector(`${sel}[data-valor="${CSS.escape(boton.dataset.valor)}"]`) || cont.querySelector(sel); // el mismo botón (o el primero si ya no está: volver a automático)
  if (!nuevo) return;
  nuevo.focus();
  const msgNuevo = nuevo.closest('span.solo-config').querySelector('.lst-may-msg'); // el listado se repintó: el aviso va en el span nuevo
  if (msgNuevo) msgNuevo.textContent = msg.textContent;
}

// Headers del tab; el clic guarda el orden, re-monta los headers (▲/▼, aria-sort) y re-pinta sólo el tbody.
function montarOrdenListado(tipo, cont) {
  const previo = lstOrden[tipo];
  montarOrden(cont.querySelector('thead'), previo, o => {
    lstOrden = { ...lstOrden, [tipo]: ordenSinNulo(previo, o) };
    montarOrdenListado(tipo, cont);
    renderListado(tipo);
  });
}

// Pinta el marco (siempre de nuevo: en Producción el contenedor lo comparten Recetas y el detalle) y trae las filas.
async function cargarListado(tipo) {
  const cont = document.getElementById(LST_CONT[tipo]);
  if (!cont) return;
  visiblesLst.clear();
  cont.innerHTML = htmlMarcoListado(tipo);
  conectarListado(tipo, cont);
  try {
    await decisionesPropiasBorradas; // precios_comun.js
    // Producción: también las variedades envasadas (el listado de Envasado muestra las que todavía no tienen PLUs).
    const opciones = tipo === 'produccion' ? getJson(API_PROD + '/envasado/opciones').catch(() => ({})) : null;
    const j = await (await fetch(`/api/precios/esquema/listado?tipo=${tipo}`)).json();
    if (j.error) throw new Error(j.error);
    if (opciones) { const o = await opciones; lstVariedadesEnv = o.variedades || []; lstCostoFamiliaEnv = o.costoKgFamilias || {}; }
    lstDatos = { ...lstDatos, [tipo]: j.filas };
    cont.querySelector('.lst-aviso').classList.toggle('hidden', j.migrado);
    const avisoAct = cont.querySelector('.lst-aviso-act'); // sólo Fraccionado: avisoActividad = falló la consulta de movimientos (frase completa del server)
    if (avisoAct) { avisoAct.textContent = j.avisoActividad || ''; avisoAct.classList.toggle('hidden', !j.avisoActividad); }
    renderListado(tipo);
  } catch (e) {
    const msg = `No se pudo cargar: ${esc(e.message)}`;
    cont.querySelector('.lst-cuerpo').innerHTML = claseLst(tipo) === 'envasado' ? `<div class="eb-vacio text-crit">${msg}</div>`
      : `<tr><td colspan="${lstCols(tipo)}" class="p-8 text-center text-crit">${msg}</td></tr>`;
  }
}

function renderListado(tipo) {
  const cont = document.getElementById(LST_CONT[tipo]);
  const cuerpo = cont && cont.querySelector('.lst-cuerpo');
  if (!cuerpo || !lstDatos[tipo]) return;
  const todas = filasDeClase(lstDatos[tipo], claseLst(tipo));
  if (claseLst(tipo) === 'envasado') { // una tarjeta por producto base (precios_produccion_envasado.js)
    cont.querySelector('.lst-conteo').textContent = pintarBases(cuerpo, todas, lstVariedadesEnv, lstCostoFamiliaEnv, filtrosLst(tipo).texto);
    return;
  }
  const filas = ordenarListado(filtrarFilas(todas, filtrosBusqueda(tipo)), lstOrden[tipo]);
  const nHoy = cont.querySelector('.lst-hoy-n'); // filas del tab con compra cargada hoy (vacío = badge oculto)
  if (nHoy) nHoy.textContent = todas.filter(f => f.ingresoHoy).length || '';
  const nSin = cont.querySelector('.lst-sinclas-n'); // Reventa: productos sin tipo de proveedor (fuera del listado por defecto)
  if (nSin) nSin.textContent = todas.filter(f => !f.tipoProveedor).length || '';
  const oc = contarOcultables(todas); // Fraccionado: graneles REEFER / inactivos (los números de sus toggles; vacío = badge oculto)
  const nReefer = cont.querySelector('.lst-reefer-n'), nInact = cont.querySelector('.lst-inactivos-n');
  if (nReefer) nReefer.textContent = oc.reefer || '';
  if (nInact) nInact.textContent = oc.inactivos || '';
  cont.querySelector('.lst-conteo').textContent = `${filas.length} de ${todas.length} · ${todas.filter(f => f.decision).length} decididos`;
  // ponytail: pinta todo de una vez (mismo volumen que el listado viejo); paginar si se pone lento.
  const texto = filtrosLst(tipo).texto || '';
  cuerpo.innerHTML = filas.length ? filas.map(fl => filaHtml(fl, tipo, tipo === 'fraccionado' && abiertoLst(fl, abiertosLst, texto))).join('') : htmlSinFilas(tipo);
}
const htmlSinFilas = tipo => `<tr><td colspan="${lstCols(tipo)}" class="p-8 text-center text-gris">Sin productos para estos filtros.</td></tr>`;
// PUT de la decisión y actualización local (sin recargar SIGA). La usan el modal y los selects de decisión.
async function guardarDecision(plu, fuente) {
  const r = await fetch(`/api/precios/decision/${encodeURIComponent(plu)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fuente }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  lstDatos = Object.fromEntries(Object.entries(lstDatos).map(([t, filas]) => [t, filas.map(f => (f.plu === plu ? { ...f, decision: j.decision } : f))]));
  refrescarAlertasProduccion(); // precios_produccion.js: la decisión cambia el costo en uso → toast/badge "a revisar"
  return j.decision;
}
// PUT del tipo de proveedor (Reventa, desde el modal) y actualización local de la fila. Tira con el error del server.
async function guardarTipoProveedor(plu, tipo) {
  const j = await pedirJson('PUT', `/api/precios/tipo-proveedor/${encodeURIComponent(plu)}`, { tipo }); // precios_comun.js
  lstDatos = { ...lstDatos, almacen: (lstDatos.almacen || []).map(f => (f.plu === plu ? { ...f, tipoProveedor: j.tipoProveedor } : f)) };
  return j.tipoProveedor;
}
// Cambio de decisión desde un select (listado o tabla de códigos de Envasado): guarda igual que el modal, repinta el listado
// (fila resaltada, contadores, celdas de Envasado) y devuelve el foco al select nuevo. Mientras guarda se bloquean todos los
// selects (el repintado los reemplaza); si falla vuelve a la decisión guardada y deja el error en la misma celda.
async function cambiarDecisionLst(tipo, sel) {
  const plu = sel.dataset.plu, msg = sel.parentElement.querySelector('.lst-dec-msg');
  const libres = [...document.querySelectorAll('.lst-decision')].filter(s => !s.disabled); // los ya bloqueados (Envasado sin guardar) quedan como están
  libres.forEach(s => { s.disabled = true; });
  msg.textContent = '';
  try {
    await guardarDecision(plu, sel.value || null);
  } catch (e) {
    sel.value = sel.dataset.actual;
    msg.textContent = `No se pudo guardar: ${e.message}`;
    libres.forEach(s => { s.disabled = false; });
    sel.focus();
    return;
  }
  renderListado(tipo);
  const nuevo = document.querySelector(`.lst-decision[data-plu="${CSS.escape(plu)}"]`);
  if (nuevo) nuevo.focus(); // sin foco el teclado quedaría en el <body> tras el repintado
}
async function quitarDecisiones() {
  if (!(await confirmar('¿Quitar todas las decisiones (Reventa, Fraccionado y Producción)?', { textoOk: 'Quitar' }))) return;
  try {
    const j = await (await fetch('/api/precios/decisiones', { method: 'DELETE' })).json();
    if (j.error) throw new Error(j.error);
    lstDatos = Object.fromEntries(Object.entries(lstDatos).map(([t, filas]) => [t, filas.map(f => ({ ...f, decision: null }))]));
    Object.keys(lstDatos).forEach(renderListado);
    refrescarAlertasProduccion(); // precios_produccion.js
  } catch (e) { avisar(e.message); }
}

const fechaHoyLst = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Planilla .xlsx del tab visible (Producción: del sub-tab) con sus filtros y orden (filasExportListado). Formato de número
// por encabezado (Δ% → 0.0 %, costos y precios → 2 decimales), anchos por contenido y autofiltro en el encabezado.
// ponytail: SheetJS community (CDN 0.18.5) no escribe negrita ni paneles inmovilizados; si hacen falta, otra librería.
const NOMBRE_TAB_XLSX = { almacen: 'reventa', fraccionado: 'fraccionado', receta: 'produccion', envasado: 'envasado' };
function exportarListado(tipo) {
  const clase = claseLst(tipo);
  const filas = ordenarListado(filtrarFilas(filasDeClase(lstDatos[tipo] || [], clase), filtrosBusqueda(tipo)), lstOrden[tipo]);
  if (!filas.length) { avisar('No hay filas para exportar con estos filtros.'); return; }
  const aoa = filasExportListado(filas, tipo);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  aoa[0].forEach((enc, c) => {
    const z = enc.startsWith('Δ%') ? '0.0%' : /^(Costo|Precio)/.test(enc) ? '#,##0.00' : null;
    for (let r = 1; z && r < aoa.length; r++) {
      const celda = ws[XLSX.utils.encode_cell({ r, c })];
      if (celda && celda.t === 'n') celda.z = z;
    }
  });
  ws['!cols'] = aoa[0].map((_, c) => ({ wch: Math.min(50, Math.max(...aoa.map(r => String(r[c] ?? '').length)) + 2) }));
  ws['!autofilter'] = { ref: ws['!ref'] };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Listado');
  XLSX.writeFile(wb, `precios_${NOMBRE_TAB_XLSX[clase || tipo]}_${fechaHoyLst()}.xlsx`);
}

// Una planilla por lista con filas (minorista, pack/bulto sin y con IVA), en el formato que importa SIGA hoy.
// Un botón por archivo: Chrome deja pasar UNA descarga automática por clic y frenaba las demás (sólo salía una lista);
// cada clic es un gesto del usuario, así que cada archivo baja. Las listas vacías se informan, no se omiten en silencio.
async function exportarDecididos() {
  try {
    const j = await (await fetch('/api/precios/esquema/export')).json();
    if (j.error) throw new Error(j.error);
    const resumen = [...resumenExport(j.listas), ...resumenJuntas(j.listas)];
    if (!resumen.some(r => r.filas)) { avisar(`No hay productos decididos con precio sugerido para exportar.${j.omitidosMayorista > 0 ? ` ${textoOmitidosMayoristaLst(j.omitidosMayorista)}` : ''}`); return; }
    dialogoExport(resumen, lista => {
      const junta = LISTAS_JUNTAS[lista];
      descargarListaSiga(junta ? juntarListas(j.listas, junta.claves) : j.listas[lista], `precios_${junta ? junta.archivo : NOMBRE_LISTA[lista]}`);
    }, j.omitidos, j.omitidosMayorista);
  } catch (e) { avisar(e.message); }
}

// Una lista en el formato que importa SIGA: hoja HOJA_EXPORTACION, encabezado en FILA_ENCABEZADOS, Excel 97-2003 (.xls,
// BIFF8), igual que el export de siempre. nombre = archivo sin fecha ni extensión.
function descargarListaSiga(filas, nombre) {
  const ws = XLSX.utils.aoa_to_sheet([]);
  XLSX.utils.sheet_add_aoa(ws, filas, { origin: `A${FILA_ENCABEZADOS}` });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, HOJA_EXPORTACION);
  XLSX.writeFile(wb, `${nombre}_${fechaHoyLst()}.xls`, { bookType: 'biff8' });
}

// "Importar planilla" (Reventa): lee el Excel en el navegador (la primera hoja con encabezado), el server marca las decisiones
// (POST importar-decisiones) y se recarga el listado para ver los selects. Diálogo con el resumen, los no marcados y el export.
async function importarPlanilla(archivo) {
  try {
    const wb = XLSX.read(await archivo.arrayBuffer(), { type: 'array' });
    const leida = wb.SheetNames.map(n => wb.Sheets[n]).filter(ws => ws['!ref'])
      .map(ws => parsearPlanillaDecisiones(XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: true }), XLSX.utils.decode_range(ws['!ref']).s.r + 1))
      .find(p => !p.error);
    if (!leida) throw new Error('No se encontró el encabezado (Codigo, Nombre, Costo, Precio).');
    if (!leida.filas.length) throw new Error('La planilla no tiene filas con código y costo o precio.');
    const j = await pedirJson('POST', '/api/precios/esquema/importar-decisiones', { filas: leida.filas.map(({ fila: _f, ...f }) => f) }); // precios_comun.js
    await cargarListado('almacen');
    dialogoImportacion(j, leida.errores.map(e => ({ ...e, motivo: `${e.motivo} (fila ${e.fila})` })));
  } catch (e) { avisar(`No se pudo importar la planilla: ${e.message}`); }
}
function dialogoImportacion(j, errores) {
  let d = document.getElementById('dlgImportar');
  if (!d) {
    d = document.createElement('dialog');
    d.id = 'dlgImportar';
    d.className = 'rounded-xl border border-borde shadow-fluent p-0 w-[min(92vw,560px)] bg-card text-ink backdrop:bg-ink/40';
    document.body.appendChild(d);
  }
  const noMarcados = [...j.sinCoincidencia, ...j.noEncontrados, ...errores];
  d.innerHTML = `<form method="dialog" class="p-5">
    <p class="text-sm font-semibold mb-3">Importar planilla</p>
    <p class="text-sm">${esc(textoResumenImportacion(j, errores.length))}</p>
    ${j.sinClasificar ? `<p class="text-xs text-ink/70 mt-2">${j.sinClasificar} marcado(s) sin clasificar: no aparecen en el listado (filtro «Sin clasificar») pero se exportan igual.</p>` : ''}
    <p class="text-sm text-warn mt-3">Exportá sin recargar la página: las decisiones se borran al recargar y vencen si cambia el precio en SIGA.</p>
    <div class="flex justify-end gap-2 mt-4">${noMarcados.length ? '<button type="button" class="dlg-nomarcados px-3 py-1.5 rounded-lg border border-borde text-sm hover:bg-white">Descargar no marcados (.xlsx)</button>' : ''}<button value="ok" class="px-3 py-1.5 rounded-lg border border-borde text-sm hover:bg-white">Cerrar</button><button type="button" class="dlg-exportar px-3 py-1.5 rounded-lg bg-verde text-white text-sm font-semibold hover:bg-verdeHover">Exportar decididos</button></div>
  </form>`;
  const bn = d.querySelector('.dlg-nomarcados');
  if (bn) bn.onclick = () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(filasNoMarcados(noMarcados)), 'No marcados');
    XLSX.writeFile(wb, `precios_no_marcados_${fechaHoyLst()}.xlsx`);
    bn.textContent = 'Descargado ✓';
  };
  d.querySelector('.dlg-exportar').onclick = () => { d.close(); exportarDecididos(); };
  d.showModal();
}

// Diálogo con una fila por lista: "Minorista · 12 productos [Descargar]"; vacía → "sin productos" y sin botón.
function dialogoExport(resumen, descargar, omitidos, omitidosMayorista) {
  let d = document.getElementById('dlgExport');
  if (!d) {
    d = document.createElement('dialog');
    d.id = 'dlgExport';
    d.className = 'rounded-xl border border-borde shadow-fluent p-0 w-[min(92vw,460px)] bg-card text-ink backdrop:bg-ink/40';
    document.body.appendChild(d);
  }
  d.innerHTML = `<form method="dialog" class="p-5">
    <p class="text-sm font-semibold mb-3">Exportar decididos: un archivo por lista, o todo junto</p>
    <ul class="text-sm divide-y divide-borde">${resumen.map(r => `<li class="flex items-center justify-between gap-3 py-2">
      <span>${esc(r.etiqueta)} · ${r.filas ? `${r.filas} producto(s)` : '<span class="text-ink/60">sin productos</span>'}</span>
      ${r.filas ? `<button type="button" data-lista="${esc(r.lista)}" class="px-3 py-1 rounded-lg bg-verde text-white text-sm font-semibold hover:bg-verdeHover">Descargar</button>` : ''}
    </li>`).join('')}</ul>
    ${omitidos ? `<p class="text-xs text-ink/70 mt-3">${omitidos} producto(s) decidido(s) sin precio con la fuente elegida quedaron fuera de los archivos.</p>` : ''}
    ${omitidosMayorista > 0 ? `<p class="text-sm text-warn mt-3" role="status">${textoOmitidosMayoristaLst(omitidosMayorista)}</p>` : ''}
    <div class="flex justify-end mt-4"><button value="ok" class="px-3 py-1.5 rounded-lg border border-borde text-sm hover:bg-white">Cerrar</button></div>
  </form>`;
  d.querySelectorAll('button[data-lista]').forEach(b => {
    b.onclick = () => { descargar(b.dataset.lista); b.textContent = 'Descargado ✓'; };
  });
  d.showModal();
}
