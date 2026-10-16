// ── Precios · listados Reventa, Fraccionado y Producción con el esquema por canal (spec 2026-10-07 §3.1) ──
// Script clásico. Una fila por producto (Fraccionado: por granel con sus presentaciones debajo; Producción: por
// presentación) con costo sistema, última compra, vigente, sugerido por fuente y un <select> con la DECISIÓN (qué costo usar
// para el precio nuevo; marca el producto para exportar). Se decide acá, sin abrir el modal, o en el modal (clic en el nombre);
// las dos vías guardan igual (guardarDecision). Todo viene calculado del server (GET /api/precios/esquema/listado): acá sólo se filtra y pinta.
// Globales: esc, fmtMoney, fmtPrecio, fmtPct, claseDelta, HOJA_EXPORTACION, FILA_ENCABEZADOS, fmtFechaPrecio,
// montarOrden, ordenarCon (precios_comun.js), avisar, confirmar (precios_config.js), abrirModalEsquema, opcionesSelect
// (precios_modal_esquema.js), textoRevisar (precios_produccion.js), XLSX (CDN).
const normL = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Filtros del listado: texto (PLU/nombre, también presentaciones), sólo decididos, última compra más cara que sistema y
// cargados hoy (ingresoHoy: compra cargada hoy en SIGA; en Fraccionado, la del granel). proveedor: el texto también busca en el
// proveedor de la última compra (sólo Reventa, que es donde se muestra esa columna).
function filtrarFilas(filas, { texto = '', soloDecididos = false, ultimaMasCara = false, soloHoy = false, proveedor = false } = {}) {
  const t = normL(texto.trim());
  const coincide = f => !t || normL(`${f.plu ?? ''} ${f.nombre}${proveedor ? ` ${f.proveedor ?? ''}` : ''}`).includes(t)
    || (f.presentaciones || []).some(p => normL(`${p.plu} ${p.nombre}`).includes(t));
  return filas.filter(f => coincide(f) && (!soloDecididos || !!f.decision) && (!soloHoy || f.ingresoHoy === true)
    && (!ultimaMasCara || (f.costoSistema > 0 && f.costoUltimaCompra > f.costoSistema)));
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
  costoSistema: f => f.costoSistema, ultimaCompra: f => f.costoUltimaCompra, deltaUltima: f => f.deltaUltimaPct, proveedor: f => f.proveedor, vigente: f => f.vigente,
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
const deltaFrac = (nuevo, base) => (nuevo != null && base > 0 ? Math.round(((nuevo - base) / base) * 10000) / 10000 : null);
// PLU de la planilla = número (como el Codigo del export a SIGA, lib/precios_listado_esquema codigoNumerico); no numérico/null quedan como están.
const pluXlsx = plu => (/^\d+$/.test(String(plu)) ? Number(plu) : plu);
const ENC_COSTOS_XLSX = ['Costo actual (sistema)', 'Costo última compra', 'Δ% costo (última vs actual)', 'Fecha última compra'];
const ENC_PRECIOS_XLSX = ['Precio actual', 'Precio nuevo con costo actual', 'Δ% (vs precio actual)', 'Precio nuevo con costo última compra', 'Δ% (vs precio actual)'];
function filasExportListado(filas, tipo) {
  const precios = (p, conUltima = true) => {
    const vig = p ? p.vigente ?? null : null, sug = p ? p.sugeridos || {} : {};
    const sis = precioSugerido(sug.sistema) ?? null, ult = precioSugerido(sug.ultimaCompra) ?? null;
    return [vig, sis, deltaFrac(sis, vig), ...(conUltima ? [ult, deltaFrac(ult, vig)] : [])];
  };
  if (tipo === 'produccion') {
    return [['PLU', 'Nombre', 'Costo actual (receta/envasado)', ...ENC_PRECIOS_XLSX.slice(0, 3)],
      ...filas.map(f => [pluXlsx(f.plu), f.nombre, f.costoSistema ?? null, ...precios(f, false)])];
  }
  const costos = f => [f.costoSistema ?? null, f.costoUltimaCompra ?? null, deltaFrac(f.costoUltimaCompra, f.costoSistema), f.fechaUltimaCompra || null];
  // Reventa: el proveedor de la última compra va justo después de su fecha.
  if (tipo !== 'fraccionado') return [['PLU', 'Nombre', ...ENC_COSTOS_XLSX, 'Proveedor', ...ENC_PRECIOS_XLSX],
    ...filas.map(f => [pluXlsx(f.plu), f.nombre, ...costos(f), f.proveedor || null, ...precios(f)])];
  const granel = g => (g.plu == null ? g.nombre : `${g.plu} · ${g.nombre}`);
  return [['PLU', 'Nombre', 'Granel', ...ENC_COSTOS_XLSX, ...ENC_PRECIOS_XLSX], ...filas.flatMap(g => ((g.presentaciones || []).length
    ? g.presentaciones.map(p => [pluXlsx(p.plu), p.nombre, granel(g), ...costos(g), ...precios(p)])
    : [[pluXlsx(g.plu), g.nombre, granel(g), ...costos(g), ...precios(null)]]))];
}

if (typeof module === 'object' && module.exports) module.exports = { htmlSelectDecision, filtrarFilas, ordenarListado, ordenSinNulo, filasDeClase, resumenExport, filasExportListado };

// ── DOM ─────────────────────────────────────────────────────────────────────────
const LST_CONT = { almacen: 'lstAlmacen', fraccionado: 'lstFracc', produccion: 'prodContenido' };
const lstCols = tipo => (tipo === 'produccion' ? 8 : tipo === 'almacen' ? 10 : 9); // Reventa suma Proveedor
let lstDatos = {};                                                  // tipo → filas del server
let lstVariedadesEnv = [];                                          // variedades envasadas (tarjetas de producto base, resumenBases)
let lstCostoFamiliaEnv = {};                                        // producto base → precio de materia prima $/kg (GET /envasado/opciones)
let lstOrden = { almacen: ORDEN_LST_DEFECTO, fraccionado: ORDEN_LST_DEFECTO, produccion: ORDEN_LST_DEFECTO }; // orden por tab (sobrevive recargas y filtros)
const lstFiltros = { almacen: {}, fraccionado: {}, produccion: {}, envasado: {} }; // estado de los filtros por tab (sobrevive recargas)
// Producción: los dos sub-tabs comparten datos y orden, pero cada uno tiene su búsqueda (prodClase, precios_produccion.js).
const claseLst = tipo => (tipo === 'produccion' ? prodClase : null);
const filtrosLst = tipo => lstFiltros[claseLst(tipo) === 'envasado' ? 'envasado' : tipo];
const filtrosBusqueda = tipo => ({ ...filtrosLst(tipo), proveedor: tipo === 'almacen' }); // lo que recibe filtrarFilas
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
// Margen del producto (sólo llega con el permiso de Configuración: CLAVES_OCULTAS lo saca sin él). "m=" margen fijo, "±m"
// ajuste (sin modo = dato viejo, ajuste).
const TXT_CANAL_LST = { minorista: 'Minorista', pack: 'Pack', bulto: 'Bulto' };
const badgeMargenProducto = f => {
  if (preciosSinConfig || !f.margenProducto) return '';
  const { modo = 'ajuste', ...canales } = f.margenProducto;
  const fijo = modo === 'fijo';
  const t = Object.entries(canales).map(([c, v]) => `${TXT_CANAL_LST[c] || c} ${!fijo && v > 0 ? '+' : ''}${fmtNum(v)} %`).join(' · ');
  return ` <span class="ml-1 px-1.5 py-0.5 rounded text-[11px] font-semibold bg-ink/10 text-ink whitespace-nowrap" title="${fijo ? 'Margen fijo' : 'Ajuste de margen'} del producto: ${esc(t)}">${fijo ? 'm=' : '±m'}</span>`;
};
// Clic en el nombre = modal del producto (detalle del cálculo, costos, márgenes). La decisión rápida es el select de la fila
// (Fraccionado: en el granel, vale para sus presentaciones; el "sin granel" no tiene). Producción además tiene el botón
// "Precios" a la vista (el nombre solo no se veía clickeable).
const botonNombre = f => `<button type="button" class="lst-abrir text-left hover:text-verde hover:underline" data-plu="${esc(f.plu ?? '')}"${f.plu == null ? ' disabled' : ''}>${esc(f.nombre)}</button>${badgeMargenProducto(f)}`;
const celdaDecision = (f, tipo) => (f.plu == null ? '' : htmlSelectDecision(f, opcionesSelect(f, tipo))); // opcionesSelect: precios_modal_esquema.js

function filaHtml(f, tipo) {
  const marca = f.decision ? ' class="bg-verde/5"' : '';
  if (tipo === 'produccion') {
    const rev = textoRevisar(f.aRevisar); // precios_produccion.js
    return `<tr${marca}><td class="p-2">${esc(f.plu)}</td><td class="p-2">${botonNombre(f)}</td>
      <td class="p-2 num">${f.costoSistema == null ? '<span class="text-gris">—</span>' : '$ ' + fmtMoney(f.costoSistema)}</td>
      <td class="p-2 num">${vigenteTxt(f.vigente)}</td><td class="p-2 num">${celdaPrecio(f.sugeridos.sistema)}</td>
      <td class="p-2">${rev ? `<span class="px-1.5 py-0.5 rounded text-[11px] font-semibold bg-warn/15 text-warn" title="${esc(f.aRevisar.map(x => textoRevisar([x])).join('\n'))}">⚠ ${esc(rev)}</span>` : ''}</td>
      <td class="p-2">${celdaDecision(f, tipo)}</td>
      <td class="p-2 whitespace-nowrap"><button type="button" class="lst-abrir cfg-btn2 mr-2" data-plu="${esc(f.plu)}">Precios</button><a class="text-xs text-verde underline underline-offset-2" href="#produccion/${encodeURIComponent(f.productoId)}">Receta</a></td></tr>`;
  }
  const fracc = tipo === 'fraccionado';
  const subfilas = (f.presentaciones || []).map(p => `<tr class="text-ink/80"><td class="p-2 pl-6 text-gris">${esc(p.plu)}</td><td class="p-2">↳ ${esc(p.nombre)}</td>
    <td></td><td></td><td></td><td class="p-2 num">${vigenteTxt(p.vigente)}</td>
    <td class="p-2 num">${celdaPrecio(p.sugeridos.sistema)}</td><td class="p-2 num">${celdaPrecio(p.sugeridos.ultimaCompra)}</td><td></td></tr>`).join('');
  return `<tr${marca}><td class="p-2">${esc(f.plu ?? '—')}</td><td class="p-2 font-semibold">${botonNombre(f)}${f.plu == null ? ' <span class="text-gris text-xs font-normal">sin granel</span>' : ''}</td>
    <td class="p-2 num">${f.costoSistema == null ? '<span class="text-gris">—</span>' : '$ ' + fmtMoney(f.costoSistema)}</td>
    <td class="p-2 num">${celdaUltima(f)}</td><td class="p-2 num">${celdaDeltaUltima(f)}</td>${tipo === 'almacen' ? celdaProveedor(f) : ''}
    <td class="p-2 num">${fracc ? '' : vigenteTxt(f.vigente)}</td>
    <td class="p-2 num">${fracc ? '' : celdaPrecio(f.sugeridos.sistema)}</td><td class="p-2 num">${fracc ? '' : celdaPrecio(f.sugeridos.ultimaCompra)}</td>
    <td class="p-2">${celdaDecision(f, tipo)}</td></tr>${subfilas}`;
}

function htmlMarcoListado(tipo) {
  const f = filtrosLst(tipo), prod = tipo === 'produccion', fracc = tipo === 'fraccionado', alm = tipo === 'almacen';
  if (claseLst(tipo) === 'envasado') return htmlMarcoBases(f); // precios_produccion_envasado.js: tarjetas de producto base
  // [texto, clave de orden]. En Fraccionado vigente y sugeridos son de las presentaciones, no del granel: no se ordenan.
  const ths = prod ? [['Código', 'plu'], ['Producto', 'nombre'], ['Costo', 'costoSistema'], ['Vigente', 'vigente'], ['Sugerido', 'sugeridoSistema'], ['A revisar'], ['Decisión'], ['']]
    : [['Código', 'plu'], [fracc ? 'Granel / presentación' : 'Producto', 'nombre'], ['Costo sistema', 'costoSistema'], ['Última compra', 'ultimaCompra'], ['Δ% vs sistema', 'deltaUltima'],
      ...(alm ? [['Proveedor', 'proveedor']] : []), ['Vigente', !fracc && 'vigente'], ['Sugerido con sistema', !fracc && 'sugeridoSistema'], ['Sugerido con última compra', !fracc && 'sugeridoUltima'], ['Decisión']];
  const toggle = (cls, k, txt) => `<button type="button" class="fbtn ${cls}${f[k] ? ' on' : ''}" aria-pressed="${!!f[k]}">${txt}</button>`;
  return `<div class="lst-aviso hidden mb-3 p-3 rounded-lg bg-warn/10 text-warn text-sm">Falta migrar la configuración al esquema por canal: sin márgenes no hay sugeridos.</div>
  <div class="flex items-center gap-2 mb-3 flex-wrap">
    <button type="button" class="lst-recargar px-3 py-1.5 rounded-lg border border-borde text-sm hover:bg-white">Recargar</button>
    <input type="search" class="lst-buscar px-3 py-1.5 rounded-lg border border-borde bg-bg/60 text-sm w-72" placeholder="Buscar por PLU, nombre${alm ? ' o proveedor' : ''}…" value="${esc(f.texto || '')}">
    ${toggle('lst-decididos', 'soloDecididos', 'Sólo decididos')}
    ${prod ? '' : toggle('lst-mascara', 'ultimaMasCara', 'Última compra más cara')}
    ${prod ? '' : toggle('lst-hoy', 'soloHoy', 'Cargados hoy <span class="fbtn-n lst-hoy-n"></span>')}
    <span class="lst-conteo text-sm text-gris"></span>
    <span class="ml-auto"></span>
    <button type="button" class="lst-quitar px-3 py-1.5 rounded-lg border border-borde text-sm hover:bg-white">Quitar decisiones</button>
    <button type="button" class="lst-exportar-listado px-3 py-1.5 rounded-lg border border-borde text-sm hover:bg-white" title="Todas las filas de la pestaña con los filtros y el orden actuales (reporte, no el formato de SIGA)">Exportar listado (.xlsx)</button>
    <button type="button" class="lst-exportar px-3 py-1.5 rounded-lg bg-verde text-white text-sm font-semibold hover:bg-verdeHover">Exportar decididos</button>
    ${prod ? '<button type="button" class="lst-nuevo cfg-btn" title="Producto con receta (ej. pepas, granola)">+ Nuevo</button>' : ''}
  </div>
  <div class="overflow-x-auto rounded-xl border border-borde shadow-fluent bg-card"><table class="w-full text-sm">
    <thead class="bg-verde/5 text-verde"><tr>${ths.map(([t, k], i) => `<th class="p-2 ${i < 2 || k === 'proveedor' ? 'text-left' : ''}"${k ? ` data-orden="${k}"` : ''}>${t}</th>`).join('')}</tr></thead>
    <tbody class="lst-cuerpo"><tr><td colspan="${lstCols(tipo)}" class="p-10 text-center text-ink/50"><span class="spin"></span> Cargando…</td></tr></tbody></table></div>`;
}

// ponytail: lstFiltros es estado de UI (no datos del server): se muta en el lugar a propósito.
function conectarListado(tipo, cont) {
  const f = filtrosLst(tipo);
  cont.querySelector('.lst-recargar').onclick = () => cargarListado(tipo);
  cont.querySelector('.lst-buscar').oninput = e => { f.texto = e.target.value; renderListado(tipo); };
  [['.lst-decididos', 'soloDecididos'], ['.lst-mascara', 'ultimaMasCara'], ['.lst-hoy', 'soloHoy']].forEach(([sel, k]) => {
    const b = cont.querySelector(sel);
    if (b) b.onclick = () => { f[k] = !f[k]; b.classList.toggle('on', f[k]); b.setAttribute('aria-pressed', String(f[k])); renderListado(tipo); };
  });
  montarOrdenListado(tipo, cont);
  cont.querySelector('.lst-exportar').onclick = exportarDecididos;
  cont.querySelector('.lst-exportar-listado').onclick = () => exportarListado(tipo);
  cont.querySelector('.lst-quitar').onclick = quitarDecisiones;
  const nuevo = cont.querySelector('.lst-nuevo'); // precios_produccion.js / precios_produccion_envasado.js
  if (nuevo) nuevo.onclick = () => (prodClase === 'envasado' ? abrirBaseNueva() : nuevoProducto());
  const cuerpo = cont.querySelector('.lst-cuerpo');
  cuerpo.addEventListener('change', e => { const s = e.target.closest('.lst-decision'); if (s) cambiarDecisionLst(tipo, s); });
  cuerpo.addEventListener('click', e => {
    const b = e.target.closest('.lst-abrir'); if (b && b.dataset.plu) abrirModalEsquema(tipo, b.dataset.plu);
    // Envasado Apidelta: tarjeta de producto base → su modal; la tarjeta "Nuevo producto base" → alta.
    const t = e.target.closest('.eb-tarjeta'); if (t) (t.classList.contains('lst-nuevo') ? abrirBaseNueva() : abrirBaseEnvasado(t.dataset.familia));
  });
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
  cont.querySelector('.lst-conteo').textContent = `${filas.length} de ${todas.length} · ${todas.filter(f => f.decision).length} decididos`;
  // ponytail: pinta todo de una vez (mismo volumen que el listado viejo); paginar si se pone lento.
  cuerpo.innerHTML = filas.length ? filas.map(fl => filaHtml(fl, tipo)).join('') : htmlSinFilas(tipo);
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
    const resumen = resumenExport(j.listas);
    if (!resumen.some(r => r.filas)) { avisar('No hay productos decididos con precio sugerido para exportar.'); return; }
    const fecha = fechaHoyLst();
    const descargar = lista => {
      const ws = XLSX.utils.aoa_to_sheet([]);
      XLSX.utils.sheet_add_aoa(ws, j.listas[lista], { origin: `A${FILA_ENCABEZADOS}` });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, HOJA_EXPORTACION);
      // SIGA importa Excel 97-2003 (.xls, BIFF8), igual que el export de siempre.
      XLSX.writeFile(wb, `precios_${NOMBRE_LISTA[lista]}_${fecha}.xls`, { bookType: 'biff8' });
    };
    dialogoExport(resumen, descargar, j.omitidos);
  } catch (e) { avisar(e.message); }
}

// Diálogo con una fila por lista: "Minorista · 12 productos [Descargar]"; vacía → "sin productos" y sin botón.
function dialogoExport(resumen, descargar, omitidos) {
  let d = document.getElementById('dlgExport');
  if (!d) {
    d = document.createElement('dialog');
    d.id = 'dlgExport';
    d.className = 'rounded-xl border border-borde shadow-fluent p-0 w-[min(92vw,460px)] bg-card text-ink backdrop:bg-ink/40';
    document.body.appendChild(d);
  }
  d.innerHTML = `<form method="dialog" class="p-5">
    <p class="text-sm font-semibold mb-3">Exportar decididos: un archivo por lista</p>
    <ul class="text-sm divide-y divide-borde">${resumen.map(r => `<li class="flex items-center justify-between gap-3 py-2">
      <span>${esc(r.etiqueta)} · ${r.filas ? `${r.filas} producto(s)` : '<span class="text-ink/60">sin productos</span>'}</span>
      ${r.filas ? `<button type="button" data-lista="${esc(r.lista)}" class="px-3 py-1 rounded-lg bg-verde text-white text-sm font-semibold hover:bg-verdeHover">Descargar</button>` : ''}
    </li>`).join('')}</ul>
    ${omitidos ? `<p class="text-xs text-ink/70 mt-3">${omitidos} producto(s) decidido(s) sin precio con la fuente elegida quedaron fuera de los archivos.</p>` : ''}
    <div class="flex justify-end mt-4"><button value="ok" class="px-3 py-1.5 rounded-lg border border-borde text-sm hover:bg-white">Cerrar</button></div>
  </form>`;
  d.querySelectorAll('button[data-lista]').forEach(b => {
    b.onclick = () => { descargar(b.dataset.lista); b.textContent = 'Descargado ✓'; };
  });
  d.showModal();
}
