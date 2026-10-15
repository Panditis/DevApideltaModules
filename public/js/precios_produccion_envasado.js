// ── Precios · Producción › Envasado Apidelta: listado de productos base y modal del producto base ──
// Producto base (en los datos: `familia`, ej. Miel) › Variedades (Pradera, Monte…: un producto envasado cada una, con su
// granel) › Códigos (PLUs de venta: 500 g, 1 kg, 28 kg…). Cada código = granel $/kg × kg por unidad + sus insumos (envase,
// tapa, etiqueta…) + minutos × costo hora ÷ 60. El producto base tiene el precio de materia prima $/kg (reemplaza el costo
// de cada granel). El costo SIEMPRE sale del server: GET /envasado/base al abrir, POST /envasado/preview mientras se edita.
// Sin el permiso de Configuración el server manda el costo sin desglose (sólo el total): acá no se muestra.
// Script clásico, cargado después de precios_produccion*.js: usa sus globales (prodDet, getJson, urlProd, API_PROD,
// htmlBuscadorSiga, conectarBuscadorSiga, sugeridoProd, textoRevisar, textoFaltante, fmtNum, campoU, avisoExito,
// marcarToggleProduccion, AVISO_COSTO_HORA), los de precios_listados.js (cargarListado, lstDatos, htmlSelectDecision,
// cambiarDecisionLst), de precios_modal_esquema.js (abrirModalEsquema, htmlCostoEnvasadoMd, opcionesSelect) y de precios.html (esc, fmtMoney, fmtPrecio, fmtPct,
// claseDelta, chip, numOrNull, pedirJson, avisar, confirmar, refrescarAlertasProduccion).
// Rutas: #produccion/envasado = listado · #produccion/envasado/nuevo y #produccion/<id>[/<plu>] de una variedad = el
// listado con el modal abierto (alta, o el producto base de esa variedad).

// ── Helpers puros (test/precios_produccion_ui.test.js) ──────────────────────────
const claveBase = s => String(s || '').trim().toLowerCase(); // misma comparación que el server (claveFamilia)
const normEb = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Body de una variedad (alta/edición/vista previa; id = la variedad que se edita, la vista previa conserva sus validados).
function bodyEnvasado(ed) {
  return {
    ...(ed.id ? { id: ed.id } : {}), familia: String(ed.familia || '').trim(), nombre: String(ed.nombre || '').trim(), granelPlu: ed.granelPlu,
    presentaciones: Object.fromEntries((ed.presentaciones || []).map(p => [p.plu, {
      kgPorUnidad: p.kgPorUnidad, componentes: (p.componentes || []).map(c => ({ plu: String(c.plu), cantidad: c.cantidad })),
      ...(p.minutosPorUnidad != null ? { minutosPorUnidad: p.minutosPorUnidad } : {}), // mano de obra por unidad
    }])),
  };
}
// Qué obligatorio falta en una variedad ('' = se puede guardar y costear). Una variedad sin códigos se puede crear.
function faltaObligatorioEnvasado(ed) {
  if (!String(ed.nombre || '').trim()) return 'Poné el nombre de la variedad (ej. Pradera).';
  if (!ed.granelPlu) return `Elegí el granel de ${ed.nombre}.`;
  for (const p of ed.presentaciones || []) {
    const nom = p.nombre || p.plu;
    if (!(Number(p.kgPorUnidad) > 0)) return `Completá los kg de granel por unidad de ${nom} (ej. 0,5).`;
    const sin = (p.componentes || []).find(c => !(Number(c.cantidad) > 0));
    if (sin) return `Completá la cantidad de ${sin.nombre || sin.plu} en ${nom} (mayor a 0).`;
    if (p.minutosPorUnidad != null && !(Number(p.minutosPorUnidad) >= 0)) return `Los minutos por unidad de ${nom} no pueden ser negativos.`;
  }
  return '';
}
// Body del guardado del producto base entero (POST/PUT /envasado/base): el server pone la familia en cada variedad.
function bodyBase(ed) {
  return { familia: String(ed.familia || '').trim(), variedades: (ed.variedades || []).map(v => {
    const { id: _id, familia: _f, ...resto } = bodyEnvasado(v);
    return { id: v.id || null, ...resto };
  }) };
}
// Qué falta para guardar el producto base ('' = nada): nombre, alguna variedad, lo de cada una y códigos sin repetir.
function faltaBase(ed) {
  if (!String(ed.familia || '').trim()) return 'Poné el nombre del producto base (ej. Miel).';
  if (!(ed.variedades || []).length) return 'Agregá al menos una variedad.';
  const vistos = new Map();
  for (const v of ed.variedades) {
    const falta = faltaObligatorioEnvasado(v);
    if (falta) return falta;
    for (const p of v.presentaciones || []) {
      if (vistos.has(p.plu)) return `El código ${p.plu} está en ${vistos.get(p.plu)} y en ${String(v.nombre).trim()}: dejalo en una sola variedad.`;
      vistos.set(p.plu, String(v.nombre).trim());
    }
  }
  return '';
}
// Variedad editable desde la respuesta de GET /envasado/base (nombres de códigos e insumos del costeo).
function variedadEditable(v) {
  const d = v.definicion || {};
  const lineas = Object.values(v.presentaciones || {}).flatMap(p => p.componentes || []);
  const nombre = plu => (lineas.find(c => String(c.plu) === String(plu)) || {}).nombre || null;
  return {
    key: v.id, id: v.id, nombre: d.nombre ?? v.nombre, granelPlu: d.granelPlu ?? v.granelPlu, granelNombre: v.granelNombre || nombre(d.granelPlu),
    presentaciones: Object.entries(d.presentaciones || {}).map(([plu, p]) => ({
      plu, nombre: ((v.presentaciones || {})[plu] || {}).nombre || null, kgPorUnidad: p.kgPorUnidad, minutosPorUnidad: p.minutosPorUnidad ?? null,
      componentes: (p.componentes || []).map(c => ({ plu: c.plu, nombre: nombre(c.plu), cantidad: c.cantidad })),
    })),
  };
}
// Código nuevo desde GET /envasado/precarga (kg = cantidad del granel en su fórmula SIGA, insumos = el resto). aviso = otro
// granel en la fórmula o sin fórmula/granel (se muestra en el código, no bloquea).
function presentacionDesdePrecarga(pre) {
  return {
    plu: String(pre.plu), nombre: pre.nombre || null, kgPorUnidad: pre.kgPorUnidad ?? null, minutosPorUnidad: null,
    componentes: (pre.componentes || []).map(c => ({ plu: String(c.plu), nombre: c.nombre || null, cantidad: c.cantidad })),
    aviso: pre.avisoGranel || pre.mensaje || null,
  };
}
// Insumos elegidos (cantidad 1) al código `destino` o, con destino null, a todos los de la variedad. Sin repetir ni el granel.
function conInsumos(presentaciones, destino, items, granelPlu) {
  return presentaciones.map(p => {
    if (destino != null && p.plu !== destino) return p;
    const ya = new Set([String(granelPlu), p.plu, ...p.componentes.map(c => String(c.plu))]);
    const nuevos = items.filter(it => !ya.has(String(it.plu))).map(it => ({ plu: String(it.plu), nombre: it.nombre || null, cantidad: 1 }));
    return nuevos.length ? { ...p, componentes: [...p.componentes, ...nuevos] } : p;
  });
}
// Por qué un código no se puede agregar a la variedad `key` (null = se puede). Mira las variedades en edición del producto
// base y, de lo guardado (duenios de GET /envasado/opciones), sólo lo de otros productos: un código quitado de una
// variedad de este producto base (aunque sea de otra variedad o de una variedad quitada) se puede volver a agregar.
function motivoCodigoOcupado(plu, base, key, duenios) {
  const s = String(plu);
  const v = (base.variedades || []).find(x => x.key === key) || {};
  if (s === String(v.granelPlu)) return 'es el granel';
  const en = (base.variedades || []).find(x => (x.presentaciones || []).some(p => p.plu === s));
  if (en) return en.key === key ? 'ya está en esta variedad' : `ya está en ${en.nombre || 'otra variedad'}`;
  const d = (duenios || {})[s];
  return d && !(base.ids || []).includes(d.productoId) ? `ya está en ${d.nombre}` : null;
}
// Estado de un código costeado: faltante (no se puede costear) › revisar (cambió desde la validación) › validado ›
// sin-validar; sin costeo todavía → pendiente.
function estadoCodigo(c) {
  if (!c) return 'pendiente';
  if ((c.faltantes || []).length) return 'faltante';
  return c.estado === 'cambio' ? 'revisar' : c.estado === 'ok' ? 'validado' : 'sin-validar';
}
// Conteos del encabezado del modal. costos = { [key de variedad]: { [plu]: código costeado } }.
function resumenBase(variedades, costos = {}) {
  const estados = (variedades || []).flatMap(v => (v.presentaciones || []).map(p => estadoCodigo((costos[v.key] || {})[p.plu])));
  const n = e => estados.filter(x => x === e).length;
  return { variedades: (variedades || []).length, codigos: estados.length, aRevisar: n('revisar'), faltantes: n('faltante'), validados: n('validado') };
}
// Tab "Pack / Bulto": por código con vínculos, sus pack/bulto con el sugerido sin y con IVA (motor, fila esquema del
// código), vigente, Δ% y margen total. Códigos sin vínculos no aparecen.
function filasPackBulto(variedades, costos = {}) {
  return (variedades || []).flatMap(v => (v.presentaciones || []).map(p => {
    const e = ((costos[v.key] || {})[p.plu] || {}).esquema;
    if (!e || !(e.mayoristas || []).length) return null;
    const s = (e.sugeridos || {}).sistema;
    const ok = s && !s.error ? s : null;
    const filas = e.mayoristas.map(m => {
      const x = (ok && ok.mayoristas.find(y => y.plu === m.plu)) || {};
      return { plu: m.plu, nombre: m.nombre, tipo: m.tipo, unidades: m.unidades ?? null, vigente: m.vigente ?? null, neto: x.neto ?? null, conIva: x.conIva ?? null,
        deltaPct: x.deltaPct ?? null, estado: x.estado ?? null, margenNetoPct: x.margenTotalNetoPct ?? null, margenIvaPct: x.margenTotalIvaPct ?? null, faltante: x.faltante ?? null };
    });
    return { plu: p.plu, nombre: p.nombre || e.nombre || p.plu, variedad: v.nombre, filas };
  })).filter(Boolean);
}
// Listado: una tarjeta por producto base desde las filas de Envasado del listado de Producción (una por código, con
// familia, variedad, productoId, decision, aRevisar, costoSistema) y las variedades de GET /envasado/opciones (también las
// que todavía no tienen códigos). texto busca en producto base, variedad, código y nombre (coincidencias = códigos que
// coinciden). A→Z; "sin producto base" ('') al final.
function resumenBases(filas, variedades = [], costoKgFamilias = {}, texto = '') {
  const bases = new Map(); // ponytail: acumulador local, se arma y se descarta acá
  const de = familia => {
    const k = claveBase(familia);
    if (!bases.has(k)) bases.set(k, { familia: String(familia || '').trim(), ids: new Set(), nombres: new Set(), filas: [] });
    return bases.get(k);
  };
  for (const v of variedades) { const b = de(v.familia); b.ids.add(v.id); b.nombres.add(v.nombre); }
  for (const f of filas || []) { const b = de(f.familia); b.ids.add(f.productoId); b.nombres.add(f.variedad); b.filas.push(f); }
  const t = normEb(String(texto || '').trim());
  const costo = k => (Object.entries(costoKgFamilias || {}).find(([f]) => claveBase(f) === k) || [])[1] ?? null;
  const resumen = ([k, b]) => {
    const propia = !t || [b.familia, ...b.nombres].some(s => normEb(s).includes(t));
    const coincidencias = t ? b.filas.filter(f => normEb(`${f.plu} ${f.nombre}`).includes(t)).map(f => f.plu) : [];
    if (!propia && !coincidencias.length) return null;
    return { familia: b.familia, costoKg: costo(k), variedades: b.ids.size, codigos: b.filas.length, coincidencias: propia ? [] : coincidencias,
      aRevisar: b.filas.filter(f => (f.aRevisar || []).length).length, decididos: b.filas.filter(f => f.decision).length,
      sinCosto: b.filas.filter(f => f.costoSistema == null).length };
  };
  return [...bases].map(resumen).filter(Boolean)
    .sort((a, b) => (a.familia === '') - (b.familia === '') || a.familia.localeCompare(b.familia, 'es', { sensitivity: 'base' }));
}

if (typeof module === 'object' && module.exports) {
  module.exports = { bodyEnvasado, faltaObligatorioEnvasado, bodyBase, faltaBase, variedadEditable, presentacionDesdePrecarga, conInsumos,
    motivoCodigoOcupado, estadoCodigo, resumenBase, filasPackBulto, resumenBases };
}

// ── Listado (sub-tab Envasado Apidelta; lo llaman cargarListado/renderListado de precios_listados.js) ──
const SIN_BASE = 'Sin producto base';
function htmlMarcoBases(f) {
  return `<div class="lst-aviso hidden mb-3 p-3 rounded-lg bg-warn/10 text-warn text-sm">Falta migrar la configuración al esquema por canal: sin márgenes no hay sugeridos.</div>
  <div class="flex items-center gap-2 mb-4 flex-wrap">
    <button type="button" class="lst-recargar px-3 py-1.5 rounded-lg border border-borde text-sm hover:bg-white">Recargar</button>
    <input type="search" class="lst-buscar px-3 py-1.5 rounded-lg border border-borde bg-bg/60 text-sm w-96" placeholder="Buscar producto base, variedad, código o nombre…" aria-label="Buscar producto base, variedad, código o nombre" value="${esc(f.texto || '')}">
    <span class="lst-conteo text-sm text-gris"></span><span class="ml-auto"></span>
    <button type="button" class="lst-quitar px-3 py-1.5 rounded-lg border border-borde text-sm hover:bg-white">Quitar decisiones</button>
    <button type="button" class="lst-exportar px-3 py-1.5 rounded-lg bg-verde text-white text-sm font-semibold hover:bg-verdeHover">Exportar decididos</button>
    <button type="button" class="lst-nuevo cfg-btn" title="Producto base (ej. Miel) con sus variedades y códigos">+ Nuevo producto base</button>
  </div>
  <div class="lst-cuerpo eb-grid" aria-live="polite"><div class="eb-vacio"><span class="spin"></span> Cargando…</div></div>`;
}
function htmlTarjetaBase(b) {
  const costo = b.costoKg != null ? `<b>$ ${fmtMoney(b.costoKg)}</b><span>/kg</span>` : '<span class="eb-tc-gris">usa el costo de cada granel</span>';
  const chips = [b.aRevisar ? chip(`● ${b.aRevisar} a revisar`, 'bg-warn/15 text-warn') : '', b.sinCosto ? chip(`${b.sinCosto} sin costo`, 'bg-crit/10 text-crit') : '',
    b.decididos ? chip(`↑ ${b.decididos} decidido${b.decididos === 1 ? '' : 's'}`, 'bg-verde/15 text-verde') : ''].filter(Boolean).join(' ')
    || (b.codigos ? chip('✓ al día', 'bg-ok/15 text-ok') : chip('sin códigos', 'bg-gris/15 text-gris'));
  const coinc = b.coincidencias.length ? `<span class="eb-tc-coinc">Coincide: ${esc(b.coincidencias.slice(0, 4).join(', '))}${b.coincidencias.length > 4 ? '…' : ''}</span>` : '';
  return `<button type="button" class="eb-tarjeta${b.aRevisar ? ' eb-t-rev' : ''}" data-familia="${esc(b.familia)}" aria-label="Abrir ${esc(b.familia || SIN_BASE)}">
    <span class="eb-tc-k">Producto base</span><span class="eb-tc-nom">${esc(b.familia || SIN_BASE)}</span>
    <span class="eb-tc-mp"><span class="eb-tc-l">Materia prima</span>${costo}</span>
    <span class="eb-tc-n"><b>${b.variedades}</b> variedad${b.variedades === 1 ? '' : 'es'} · <b>${b.codigos}</b> código${b.codigos === 1 ? '' : 's'}</span>
    <span class="eb-tc-chips">${chips}</span>${coinc}<span class="eb-tc-ir" aria-hidden="true">›</span></button>`;
}
// filas = las de Envasado del listado de Producción; variedades/costos = GET /envasado/opciones. → texto del conteo.
function pintarBases(cuerpo, filas, variedades, costos, texto) {
  const bases = resumenBases(filas, variedades, costos, texto);
  const nuevo = '<button type="button" class="eb-tarjeta eb-t-nueva lst-nuevo"><span class="eb-tc-mas" aria-hidden="true">+</span>Nuevo producto base</button>';
  cuerpo.innerHTML = bases.length ? bases.map(htmlTarjetaBase).join('') + (String(texto || '').trim() ? '' : nuevo)
    : `<div class="eb-vacio">${String(texto || '').trim() ? 'Ningún producto base coincide con la búsqueda.' : 'Todavía no hay productos base: creá el primero (ej. Miel).'}</div>${String(texto || '').trim() ? '' : nuevo}`;
  if (ebEd) pintarCeldasBase(); // modal abierto: selects y chips de decisión al día (la decisión se toma ahí o en el modal de precios)
  return `${bases.length} producto${bases.length === 1 ? '' : 's'} base · ${(filas || []).length} códigos · ${(filas || []).filter(f => f.decision).length} decididos`;
}

// ── Estado del modal ────────────────────────────────────────────────────────────
const EB_PREVIEW_MS = 300;
let ebEd = null;          // { anterior (familia guardada; null = alta), familia, ids (guardados), variedades: [variedadEditable + key], sucio }
let ebInfo = { costoKg: null, conDesglose: false }; // del GET (precio de materia prima y si viene el desglose)
let ebCosto = {};         // key de variedad → { plu: código costeado } (GET o vista previa)
let ebErr = {};           // key de variedad → error de su vista previa
let ebAbiertas = new Set(); // variedades desplegadas
let ebInsAbiertos = new Set(); // "key|plu" con los insumos desplegados
let ebTab = 'codigos';    // 'codigos' | 'pack'
let ebEditandoMp = false; // precio de materia prima en edición
let ebOpc = { duenios: {} };
let ebFocoPrevio = null, ebNuevaN = 0;
const ebTimers = {}, ebSeq = {};
const ebVariedad = key => ebEd.variedades.find(v => v.key === key);
const ebGuardado = (v, plu) => !!v.id && ebEd.guardados.has(`${v.id}|${plu}`);

function capaBase() {
  let c = document.getElementById('mBase');
  if (c) return c;
  document.body.insertAdjacentHTML('beforeend', `<div id="mBase" class="eb-capa hidden" role="dialog" aria-modal="true" aria-labelledby="ebTitulo">
    <div id="ebCaja" class="eb-caja fade-in" tabindex="-1"><div id="ebCab" class="eb-cab"></div><div id="ebTabs" class="eb-tabs" role="tablist" aria-label="Secciones del producto base"></div>
      <div id="ebCuerpo" class="eb-cuerpo"></div><div id="ebPie" class="eb-pie"></div></div></div>`);
  c = document.getElementById('mBase');
  c.addEventListener('mousedown', e => { if (e.target === c) cerrarBase(); });
  // Captura: corre antes que el Escape de #mDet (precios_config.js), así cuando #mDet está encima sólo se cierra él.
  window.addEventListener('keydown', teclaBase, true);
  return c;
}
function teclaBase(e) {
  const capa = document.getElementById('mBase');
  if (!capa || capa.classList.contains('hidden') || !document.getElementById('mDet').classList.contains('hidden')) return;
  if (document.querySelector('dialog[open]') || document.querySelector('.bs-lista:not(.hidden)')) return; // los cierra cada uno
  if (e.key === 'Escape') { e.preventDefault(); cerrarBase(); return; }
  if (e.key !== 'Tab') return;
  const caja = document.getElementById('ebCaja');
  const focos = [...caja.querySelectorAll('button, input, select, a[href]')].filter(el => !el.disabled && el.offsetParent !== null);
  if (!focos.length) return;
  const primero = focos[0], ultimo = focos[focos.length - 1], actual = document.activeElement;
  if (e.shiftKey && (actual === primero || actual === caja)) { e.preventDefault(); ultimo.focus(); }
  else if (!e.shiftKey && actual === ultimo) { e.preventDefault(); primero.focus(); }
}
function mostrarCapaBase() {
  const capa = capaBase();
  if (capa.classList.contains('hidden')) ebFocoPrevio = document.activeElement;
  capa.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
async function cerrarBase({ forzar = false } = {}) {
  if (!ebEd) return;
  if (!forzar && ebEd.sucio && !(await confirmar('Hay cambios sin guardar en el producto base. ¿Cerrar igual y perderlos?', { textoOk: 'Cerrar sin guardar' }))) return;
  Object.values(ebTimers).forEach(clearTimeout);
  ebEd = null;
  document.getElementById('mBase').classList.add('hidden');
  document.body.style.overflow = '';
  if (ebFocoPrevio && document.contains(ebFocoPrevio)) ebFocoPrevio.focus();
}
function cargarOpcionesBase() {
  getJson(API_PROD + '/envasado/opciones').then(o => { ebOpc = o; }).catch(() => { /* sin dueños: el server igual valida los códigos */ });
}

// ── Abrir ──────────────────────────────────────────────────────────────────────
// Producto base guardado (familia = su nombre, '' = variedades sin producto base). variedadId/plu: esa variedad desplegada.
async function abrirBaseEnvasado(familia, { variedadId = null, plu = null } = {}) {
  mostrarCapaBase();
  ebEd = { anterior: familia, familia, ids: [], guardados: new Set(), variedades: [], sucio: false };
  ebTab = 'codigos'; ebEditandoMp = false; ebErr = {}; ebCosto = {};
  document.getElementById('ebCab').innerHTML = `<h2 id="ebTitulo" class="eb-tit">${esc(familia || SIN_BASE)}</h2>`;
  document.getElementById('ebTabs').innerHTML = ''; document.getElementById('ebPie').innerHTML = '';
  document.getElementById('ebCuerpo').innerHTML = '<div class="eb-vacio"><span class="spin"></span> Cargando producto base…</div>';
  document.getElementById('ebCaja').focus();
  cargarOpcionesBase();
  try {
    await recargarBase(familia);
    const ids = ebEd.variedades.map(v => v.key);
    ebAbiertas = new Set(variedadId ? [variedadId] : ids.length <= 3 ? ids : ids.slice(0, 1));
    ebInsAbiertos = new Set(variedadId && plu ? [`${variedadId}|${plu}`] : []);
    pintarBase();
  } catch (e) {
    document.getElementById('ebCuerpo').innerHTML = `<div class="eb-vacio text-crit">No se pudo cargar: ${esc(e.message)}</div>`;
  }
}
// GET del producto base → edición limpia (sin cambios) + costos del server.
async function recargarBase(familia) {
  const r = await getJson(`${API_PROD}/envasado/base?familia=${encodeURIComponent(familia)}`);
  ebInfo = { costoKg: r.costoKg, conDesglose: r.conDesglose === true };
  const variedades = r.variedades.map(variedadEditable);
  ebEd = { anterior: r.familia, familia: r.familia, ids: variedades.map(v => v.id), variedades, sucio: false,
    guardados: new Set(variedades.flatMap(v => v.presentaciones.map(p => `${v.id}|${p.plu}`))) };
  ebCosto = Object.fromEntries(r.variedades.map(v => [v.id, v.presentaciones]));
  ebErr = {};
}
const nuevaVariedadEb = () => ({ key: `n${++ebNuevaN}`, id: null, nombre: '', granelPlu: null, granelNombre: null, presentaciones: [] });
function abrirBaseNueva() {
  mostrarCapaBase();
  const v = nuevaVariedadEb();
  ebEd = { anterior: null, familia: '', ids: [], guardados: new Set(), variedades: [v], sucio: true };
  ebInfo = { costoKg: null, conDesglose: !preciosSinConfig };
  ebCosto = {}; ebErr = {}; ebAbiertas = new Set([v.key]); ebInsAbiertos = new Set(); ebTab = 'codigos'; ebEditandoMp = false;
  cargarOpcionesBase();
  pintarBase();
  document.getElementById('ebNombre').focus();
}
// Entradas desde el ruteo (precios_produccion.js): #produccion/envasado/nuevo y el detalle de una variedad envasada.
function irAlListadoEnvasado() {
  history.replaceState(null, '', '#produccion/envasado');
  marcarToggleProduccion({ vista: 'envasado' });
  cargarListado('produccion');
}
function abrirEnvasadoNuevo() { irAlListadoEnvasado(); abrirBaseNueva(); }
function pintarDetalleEnvasado(abrirPlu = null) {
  const { id, definicion } = prodDet;
  irAlListadoEnvasado();
  abrirBaseEnvasado(definicion.familia || '', { variedadId: id, plu: abrirPlu });
}

// ── Pintado ─────────────────────────────────────────────────────────────────────
function pintarBase() {
  document.getElementById('ebCab').innerHTML = htmlCabBase();
  const nPack = filasPackBulto(ebEd.variedades, ebCosto).length;
  document.getElementById('ebTabs').innerHTML = [['codigos', 'Variedades y códigos'], ['pack', `Pack / Bulto${nPack ? ` <span class="eb-tab-n">${nPack}</span>` : ''}`]]
    .map(([k, t]) => `<button type="button" role="tab" id="ebTab-${k}" class="eb-tab" aria-selected="${ebTab === k}" aria-controls="ebCuerpo" tabindex="${ebTab === k ? 0 : -1}" data-tab="${k}">${t}</button>`).join('');
  document.getElementById('ebCuerpo').setAttribute('aria-labelledby', 'ebTab-' + ebTab);
  document.getElementById('ebCuerpo').innerHTML = ebTab === 'pack' ? htmlPackBulto() : htmlVariedades();
  pintarPieBase();
  conectarBase();
}
function htmlChipsBase() {
  const r = resumenBase(ebEd.variedades, ebCosto);
  const decididos = ebEd.variedades.flatMap(v => v.presentaciones).filter(p => decisionDeCodigo(p.plu)).length;
  const c = (n, txt, cls) => `<span class="eb-chip ${n ? cls : 'eb-chip-0'}"><b>${n}</b> ${txt}</span>`;
  return c(r.variedades, r.variedades === 1 ? 'variedad' : 'variedades', 'eb-chip-n') + c(r.codigos, r.codigos === 1 ? 'código' : 'códigos', 'eb-chip-n')
    + c(r.aRevisar, 'a revisar', 'eb-chip-warn') + c(r.faltantes, 'con faltantes', 'eb-chip-crit') + c(r.validados, 'validados', 'eb-chip-ok')
    + c(decididos, decididos === 1 ? 'decidido' : 'decididos', 'eb-chip-dec');
}
function htmlMpBase() {
  if (ebEd.anterior == null) return '<span class="eb-mp eb-mp-off">Materia prima $/kg: guardá el producto base para definirla</span>';
  if (ebEditandoMp) {
    return `<span class="eb-mp eb-mp-ed"><span>Materia prima</span>${campoU(`<input id="ebMpInput" type="number" min="0" step="any" value="${esc(ebInfo.costoKg ?? '')}" placeholder="vacío = granel" aria-label="Precio de materia prima por kg">`, '$/kg', { w: 'w-36' })}
      <button type="button" id="ebMpGuardar" class="cfg-btn !py-1">Guardar</button><button type="button" id="ebMpCancelar" class="text-xs text-gris underline">Cancelar</button></span>`;
  }
  const v = ebInfo.costoKg != null ? `<b>$ ${fmtMoney(ebInfo.costoKg)}</b>/kg` : '<span class="text-gris">usa el costo de cada granel</span>';
  return `<span class="eb-mp" title="Un $/kg para el granel de todas sus variedades: cada código lo multiplica por sus kg"><span>Materia prima</span>${v}
    <button type="button" id="ebMpEditar" class="eb-link">${ebInfo.costoKg != null ? 'Editar' : 'Definir'}</button></span>`;
}
function htmlCabBase() {
  return `<div class="eb-cab-izq"><span class="eb-kicker">Producto base · Envasado Apidelta</span>
      <input id="ebNombre" class="eb-nombre" maxlength="60" placeholder="Nombre (ej. Miel)" value="${esc(ebEd.familia)}" aria-label="Nombre del producto base">
      <h2 id="ebTitulo" class="sr-only">${esc(ebEd.familia || 'Nuevo producto base')}</h2></div>
    <div class="eb-cab-der"><div id="ebMp">${htmlMpBase()}</div><div id="ebChips" class="eb-chips">${htmlChipsBase()}</div></div>
    <button type="button" id="ebX" class="eb-x" aria-label="Cerrar">✕</button>`;
}

// ── Tab "Variedades y códigos" ──
const plataEb = v => (v == null ? '<span class="text-crit text-xs">sin costo</span>' : '$ ' + fmtMoney(v));
const filaDeCodigo = plu => ((typeof lstDatos === 'object' && lstDatos.produccion) || []).find(f => f.plu === plu) || null; // fila del listado de Producción
const decisionDeCodigo = plu => { const f = filaDeCodigo(plu); return f && f.decision ? f : null; };
const ESTADO_EB = { faltante: ['eb-e-falta', 'Faltante'], revisar: ['eb-e-rev', 'A revisar'], validado: ['eb-e-ok', 'Validado'], 'sin-validar': ['eb-e-sv', 'Sin validar'], pendiente: ['text-gris', '—'] };
function htmlVariedades() {
  const vs = ebEd.variedades.map(htmlVariedadEb).join('');
  return `${vs || '<div class="eb-vacio">Sin variedades: agregá la primera.</div>'}
    <button type="button" id="ebNuevaVar" class="eb-nueva-var"><span aria-hidden="true">+</span> Nueva variedad</button>`;
}
function htmlGranelEb(v) {
  if (!v.granelPlu) return `<span class="eb-granel">${htmlBuscadorSiga('ebGranel-' + v.key, 'Buscar el granel en SIGA (ej. MIEL PRADERA GRANEL)…')}</span>`;
  return `<span class="eb-granel"><span class="eb-granel-l">Granel</span><b class="tabular-nums">${esc(v.granelPlu)}</b> ${esc(v.granelNombre || '')}
    <button type="button" class="eb-link eb-cambiar-granel" data-key="${esc(v.key)}">Cambiar</button></span>`;
}
function htmlVariedadEb(v) {
  const abierta = ebAbiertas.has(v.key);
  const n = v.presentaciones.length;
  const r = resumenBase([v], ebCosto);
  const marcas = (r.aRevisar ? chip(`● ${r.aRevisar} a revisar`, 'bg-warn/15 text-warn') : '') + (r.faltantes ? ' ' + chip(`${r.faltantes} con faltantes`, 'bg-crit/10 text-crit') : '');
  const cuerpo = abierta ? `<div class="eb-var-cuerpo">${ebErr[v.key] ? `<p class="eb-err" role="alert">${esc(ebErr[v.key])}</p>` : ''}${htmlCodigosEb(v)}</div>` : '';
  return `<section class="eb-var${r.aRevisar ? ' eb-var-rev' : ''}" data-key="${esc(v.key)}">
    <div class="eb-var-cab">
      <button type="button" class="eb-caret" data-key="${esc(v.key)}" aria-expanded="${abierta}" aria-label="${abierta ? 'Plegar' : 'Desplegar'} ${esc(v.nombre || 'variedad')}">▸</button>
      <input class="eb-var-nombre" data-key="${esc(v.key)}" maxlength="60" placeholder="Variedad (ej. Pradera)" value="${esc(v.nombre)}" aria-label="Nombre de la variedad">
      ${htmlGranelEb(v)}
      <span class="eb-var-n">${n} código${n === 1 ? '' : 's'}</span>${marcas}
      <button type="button" class="eb-quitar-var" data-key="${esc(v.key)}" title="Eliminar la variedad (se aplica al guardar)">Eliminar variedad</button>
    </div>${cuerpo}</section>`;
}
const COLS_EB = 12;
function htmlCodigosEb(v) {
  if (!v.granelPlu) return '<p class="eb-ayuda">Elegí el granel de la variedad para agregar sus códigos.</p>';
  const filas = v.presentaciones.map((p, i) => htmlFilaCodigoEb(v, p, i)).join('')
    || `<tr><td colspan="${COLS_EB}" class="eb-sin">Todavía no tiene códigos: agregalos con el buscador de abajo.</td></tr>`;
  return `<table class="pr-tabla eb-tabla"><thead><tr><th class="text-left">Código</th><th class="text-left">Nombre</th><th class="num">Kg/unidad</th><th class="text-left">Insumos</th>
      <th class="num" title="Mano de obra: minutos por unidad × costo hora de Configuración › Costos">Min/unidad</th><th class="num" title="Mercadería + insumos + mano de obra">Costo final</th>
      <th class="num">Sugerido</th><th class="num">Vigente</th><th class="num">Δ%</th><th>Estado</th><th>Decisión</th><th></th></tr></thead><tbody>${filas}</tbody></table>
    <div class="eb-agregar"><span class="text-sm text-gris">＋ Agregar códigos:</span>${htmlBuscadorSiga('ebAgregar-' + v.key, 'Buscar en SIGA (ej. MIEL PRADERA) y tildar varios…')}
      <span class="text-xs text-gris">Se precargan desde su fórmula de SIGA (kg del granel e insumos).</span></div>`;
}
// Celdas que la vista previa actualiza sin repintar los inputs (data-eb = "<qué>|<key>|<plu>").
function celdaEb(que, key, plu) {
  const c = (ebCosto[key] || {})[plu];
  const s = c && c.costoUnidad != null ? sugeridoProd(c) : null;
  if (que === 'costo') return htmlCostoCeldaEb(c);
  if (que === 'sugerido') return s ? `<b class="eb-sug">$ ${fmtPrecio(s.precio)}</b>` : '<span class="text-gris">—</span>';
  if (que === 'vigente') return c && c.precioVigente != null ? '$ ' + fmtPrecio(c.precioVigente) : '<span class="text-gris">—</span>';
  if (que === 'delta') return s && s.deltaPct != null ? `<span class="${claseDelta(s.estado)}">${fmtPct(s.deltaPct)}</span>` : '<span class="text-gris">—</span>';
  if (que === 'decision') return celdaDecisionEb(plu);
  if (que === 'desglose') return htmlDesgloseEb(c);
  const e = estadoCodigo(c); // con cambios sin guardar: el de la vista previa (compara contra lo validado)
  const [cls, txt] = ESTADO_EB[e];
  const tip = e === 'faltante' ? ` title="${esc('Falta: ' + c.faltantes.map(k => textoFaltante(k)).join(', '))}"` : e === 'revisar' && c.revisar ? ` title="${esc(textoRevisar(c.revisar))}"` : '';
  return `<span class="eb-e ${cls}"${tip}>${txt}${e === 'revisar' && c.cambios && c.cambios.deltaPct != null ? ' ' + fmtPct(c.cambios.deltaPct) : ''}</span>`;
}
// Decisión del código: select "No cambiar" / "Aumentar · $X (Δ%)" (htmlSelectDecision, precios_listados.js; opcionesSelect, precios_modal_esquema.js)
// con el precio de lo guardado. Con cambios sin guardar queda deshabilitado, igual que "Precios"; sin fila en el listado todavía, un guión.
function celdaDecisionEb(plu) {
  const f = filaDeCodigo(plu);
  if (!f) return '<span class="text-gris text-xs">—</span>';
  return htmlSelectDecision(f, opcionesSelect(f, 'produccion'), ebEd.sucio ? { deshabilitado: true, titulo: 'Guardá los cambios para decidir el precio' } : {});
}
// Costo final: total; con el permiso, el tooltip con los tres conceptos (el desglose completo va en la fila desplegada).
function htmlCostoCeldaEb(c) {
  if (!c) return '<span class="text-gris">—</span>';
  if (!ebInfo.conDesglose) return `<b>${plataEb(c.costoUnidad)}</b>`;
  const { mercaderia, insumos, mo } = conceptosCosto(c.componentes); // precios_modal_esquema.js
  const tip = `Mercadería ${mercaderia.subtotal == null ? 'sin costo' : '$ ' + fmtMoney(mercaderia.subtotal)} + Insumos ${insumos.subtotal == null ? 'sin costo' : '$ ' + fmtMoney(insumos.subtotal)} + Mano de obra $ ${fmtMoney(mo ? mo.importe : 0)}`;
  return `<b title="${esc(tip)}" class="eb-costo">${plataEb(c.costoUnidad)}</b>`;
}
function htmlDesgloseEb(c) {
  if (!c || !ebInfo.conDesglose) return '';
  const aviso = (c.avisos || []).includes('costoHora') ? `<p class="text-xs text-warn mt-1">⚠ ${esc(AVISO_COSTO_HORA)}</p>` : '';
  return htmlCostoEnvasadoMd({ componentesCosto: c.componentes, costoSistema: c.costoUnidad }) + aviso; // precios_modal_esquema.js
}
const tdEb = (que, key, plu, cls = 'num') => `<td class="${cls}" data-eb="${esc([que, key, plu].join('|'))}">${celdaEb(que, key, plu)}</td>`;
function htmlInsumosChipsEb(p) {
  if (!p.componentes.length) return '<span class="text-gris text-xs">sin insumos</span>';
  const muestra = p.componentes.slice(0, 3).map(c => `<span class="eb-ins">${esc(c.nombre || c.plu)} <b>× ${esc(fmtNum(c.cantidad))}</b></span>`).join('');
  return muestra + (p.componentes.length > 3 ? `<span class="eb-ins eb-ins-mas">+${p.componentes.length - 3}</span>` : '');
}
function htmlFilaCodigoEb(v, p, i) {
  const k = `${v.key}|${p.plu}`, abierto = ebInsAbiertos.has(k), guardado = ebGuardado(v, p.plu);
  const listo = guardado && !ebEd.sucio;
  const nom = esc(p.nombre || p.plu);
  const c = (ebCosto[v.key] || {})[p.plu];
  const validar = listo && c && !(c.faltantes || []).length && c.estado !== 'ok'
    ? `<button type="button" class="eb-validar eb-link" data-key="${esc(v.key)}" data-plu="${esc(p.plu)}" title="Guarda el costo actual de este código">Validar</button>` : '';
  const precios = `<button type="button" class="eb-precios cfg-btn2" data-plu="${esc(p.plu)}"${listo ? '' : ' disabled title="Guardá los cambios para decidir el precio"'}>Precios</button>`;
  const fila = `<tr class="${abierto ? 'eb-fila-ab' : ''}"><td class="text-left whitespace-nowrap"><b class="tabular-nums">${esc(p.plu)}</b></td>
    <td class="text-left eb-td-nom">${nom}${p.aviso ? ` <span class="text-warn" title="${esc(p.aviso)}">⚠</span>` : ''}</td>
    <td class="num">${campoU(`<input type="number" min="0" step="any" class="eb-kg" data-key="${esc(v.key)}" data-i="${i}" value="${esc(p.kgPorUnidad ?? '')}" aria-label="Kg de granel por unidad de ${nom}">`, 'kg', { w: 'w-24' })}</td>
    <td class="text-left"><button type="button" class="eb-ins-abrir" data-k="${esc(k)}" aria-expanded="${abierto}" title="${abierto ? 'Cerrar' : 'Editar'} insumos${ebInfo.conDesglose ? ' y ver el desglose del costo' : ''}">
      <span class="eb-caret-s" aria-hidden="true">▸</span><span class="eb-ins-lista">${htmlInsumosChipsEb(p)}</span></button></td>
    <td class="num">${campoU(`<input type="number" min="0" step="any" class="eb-min" data-key="${esc(v.key)}" data-i="${i}" value="${esc(p.minutosPorUnidad ?? '')}" placeholder="0" aria-label="Minutos de mano de obra por unidad de ${nom}">`, 'min', { w: 'w-20' })}</td>
    ${tdEb('costo', v.key, p.plu)}${tdEb('sugerido', v.key, p.plu)}${tdEb('vigente', v.key, p.plu)}${tdEb('delta', v.key, p.plu)}${tdEb('estado', v.key, p.plu, '')}${tdEb('decision', v.key, p.plu, 'whitespace-nowrap')}
    <td class="text-right whitespace-nowrap">${precios} ${validar}<button type="button" class="eb-quitar btn-quitar ml-1" data-key="${esc(v.key)}" data-i="${i}" aria-label="Quitar ${nom} de la variedad">✕</button></td></tr>`;
  return fila + (abierto ? `<tr class="eb-fila-in"><td colspan="${COLS_EB}">${htmlInsumosEb(v, p, i)}</td></tr>` : '');
}
// Fila desplegada: aviso de la precarga, "a revisar", insumos editables (+ buscador, aplicar a todas) y, con el permiso,
// el desglose del costo en tres conceptos.
function htmlInsumosEb(v, p, i) {
  const c = (ebCosto[v.key] || {})[p.plu];
  const revisar = c && c.estado === 'cambio' && !ebEd.sucio && c.revisar ? `<p class="text-xs text-warn mb-2">Cambió desde la validación: ${esc(textoRevisar(c.revisar))}</p>` : '';
  const linea = plu => ((c && c.componentes) || []).find(l => String(l.plu) === String(plu)) || {};
  const filas = p.componentes.map((x, j) => `<tr><td class="tabular-nums">${esc(x.plu)}</td><td class="text-left">${esc(x.nombre || linea(x.plu).nombre || '')}</td>
      <td class="num">${campoU(`<input type="number" min="0" step="any" class="eb-cant" data-key="${esc(v.key)}" data-i="${i}" data-j="${j}" value="${esc(x.cantidad ?? '')}" aria-label="Cantidad de ${esc(x.nombre || x.plu)} por unidad">`, 'u', { w: 'w-24' })}</td>
      <td class="text-right"><button type="button" class="eb-quitar-ins btn-quitar" data-key="${esc(v.key)}" data-i="${i}" data-j="${j}" aria-label="Quitar ${esc(x.nombre || x.plu)}">✕</button></td></tr>`).join('')
    || '<tr><td colspan="4" class="eb-sin">Sin insumos.</td></tr>';
  const todas = v.presentaciones.length > 1 ? `<label class="text-xs text-gris flex items-center gap-1"><input type="checkbox" class="eb-a-todas accent-verde" data-k="${esc(v.key + '|' + p.plu)}"> aplicar a todos los códigos de la variedad</label>` : '';
  const desglose = ebInfo.conDesglose ? `<div class="eb-desg" data-eb="${esc(['desglose', v.key, p.plu].join('|'))}">${htmlDesgloseEb(c)}</div>` : '';
  return `<div class="eb-in">${p.aviso ? `<p class="text-xs text-warn mb-2">⚠ ${esc(p.aviso)}</p>` : ''}${revisar}
    <div class="eb-in-grid"><div><div class="lbl mb-1">Insumos por unidad</div>
      <table class="pr-tabla pr-tabla-in eb-tabla-in"><thead><tr><th>PLU</th><th class="text-left">Insumo</th><th class="num">Cantidad</th><th class="w-10"></th></tr></thead><tbody>${filas}</tbody></table>
      <div class="eb-agregar">${htmlBuscadorSiga('ebIns-' + v.key + '-' + p.plu, 'Agregar insumos (envase, tapa, etiqueta…), podés tildar varios…')}${todas}</div></div>${desglose}</div></div>`;
}

// ── Tab "Pack / Bulto" ──
function htmlPackBulto() {
  const grupos = filasPackBulto(ebEd.variedades, ebCosto);
  const donde = '<p class="eb-ayuda">Los vínculos de pack y bulto se administran en <b>Configuración › General › Pack/Bulto</b>. Los precios salen del costo de cada código con el margen de su canal.</p>';
  if (!grupos.length) return `<div class="eb-vacio">Ningún código tiene pack o bulto vinculado.</div>${donde}`;
  const pct = n => (n == null ? '<span class="text-gris">—</span>' : `${String(+(+n).toFixed(1)).replace('.', ',')} %`);
  const pesos = n => (n == null ? '<span class="text-gris">—</span>' : '$ ' + fmtMoney(n));
  const cuerpo = grupos.map(g => `<tr class="eb-pb-grupo"><td colspan="8"><b class="tabular-nums">${esc(g.plu)}</b> ${esc(g.nombre)} <span class="text-gris font-normal">· ${esc(g.variedad)}</span></td></tr>`
    + g.filas.map(r => `<tr><td class="text-left"><span class="eb-pb-tipo">${esc(TIPO_CANAL[r.tipo] || r.tipo)}</span> <b class="tabular-nums">${esc(r.plu)}</b></td><td class="text-left">${esc(r.nombre || '')}${r.faltante === 'unidades' ? ' <span class="md-warn">sin unidades</span>' : ''}</td>
      <td class="num">${r.unidades == null ? '—' : esc(fmtNum(r.unidades))}</td><td class="num">${pesos(r.neto)}</td><td class="num"><b>${pesos(r.conIva)}</b></td><td class="num">${pesos(r.vigente)}</td>
      <td class="num">${r.deltaPct == null ? '<span class="text-gris">—</span>' : `<span class="${claseDelta(r.estado)}">${fmtPct(r.deltaPct)}</span>`}</td>
      <td class="num" title="Precio sin IVA ÷ costo de mercadería − 1 (con IVA: ${r.margenIvaPct == null ? '—' : String(r.margenIvaPct).replace('.', ',') + ' %'})">${pct(r.margenNetoPct)}</td></tr>`).join('')).join('');
  return `${ebEd.sucio ? '<p class="eb-ayuda text-warn">Con cambios sin guardar: los precios son la vista previa.</p>' : ''}
    <table class="pr-tabla eb-tabla"><thead><tr><th class="text-left">Pack / Bulto</th><th class="text-left">Nombre</th><th class="num">Unidades</th><th class="num">Sugerido sin IVA</th>
      <th class="num">Sugerido con IVA</th><th class="num">Vigente</th><th class="num">Δ%</th><th class="num">Margen total</th></tr></thead><tbody>${cuerpo}</tbody></table>${donde}`;
}

function htmlPieBase() {
  const falta = faltaBase(ebEd);
  const err = Object.values(ebErr).find(Boolean);
  const msg = falta || err || '';
  const puede = !falta && ebEd.sucio;
  const guardado = ebEd.anterior != null;
  return `${guardado ? '<button type="button" id="ebEliminar" class="eb-eliminar">Eliminar producto base</button>' : ''}
    <span class="eb-pie-msg" role="status" aria-live="polite">${ebEd.sucio ? '<span class="eb-sucio">● Cambios sin guardar</span>' : ''}${msg ? `<span class="${err && !falta ? 'text-crit' : 'text-gris'}">${esc(msg)}</span>` : ''}</span>
    ${guardado ? `<button type="button" id="ebValidarTodo" class="cfg-btn2"${ebEd.sucio ? ' disabled title="Guardá los cambios antes de validar"' : ''}>Validar todos</button>` : ''}
    <button type="button" id="ebGuardar" class="cfg-btn"${puede ? '' : ' disabled'}>${guardado ? 'Guardar cambios' : 'Crear producto base'}</button>`;
}
function pintarPieBase() {
  document.getElementById('ebPie').innerHTML = htmlPieBase();
  document.getElementById('ebGuardar').onclick = e => guardarBase(e.currentTarget);
  const val = document.getElementById('ebValidarTodo'); if (val) val.onclick = e => validarCodigosBase(null, e.currentTarget);
  const del = document.getElementById('ebEliminar'); if (del) del.onclick = eliminarBase;
}
// Después de una vista previa o una decisión: sólo celdas de costo, chips y pie (los inputs no se repintan: no pierden el foco).
function pintarCeldasBase() {
  const caja = document.getElementById('ebCaja');
  if (!caja || !ebEd || !document.getElementById('ebNombre')) return; // cargando: todavía no se pintó
  caja.querySelectorAll('[data-eb]').forEach(td => { const [que, key, plu] = td.dataset.eb.split('|'); td.innerHTML = celdaEb(que, key, plu); });
  const chips = document.getElementById('ebChips'); if (chips) chips.innerHTML = htmlChipsBase();
  pintarPieBase();
}

// ── Edición ─────────────────────────────────────────────────────────────────────
// cambio(ebEd) → ebEd nuevo; key = variedad que cambió (vista previa); repintar = cambió la estructura.
function editarBase(cambio, { key = null, repintar = false } = {}) {
  ebEd = { ...cambio(ebEd), sucio: true };
  if (repintar) pintarBase(); else pintarCeldasBase();
  if (key) programarPreviewBase(key);
}
const editarVarEb = (key, fn, opts = {}) => editarBase(ed => ({ ...ed, variedades: ed.variedades.map(v => (v.key === key ? fn(v) : v)) }), { key, ...opts });
const editarCodEb = (key, i, fn, opts = {}) => editarVarEb(key, v => ({ ...v, presentaciones: v.presentaciones.map((p, k) => (k === i ? fn(p) : p)) }), opts);
function programarPreviewBase(key) { clearTimeout(ebTimers[key]); ebTimers[key] = setTimeout(() => pedirPreviewBase(key), EB_PREVIEW_MS); }
// Vista previa de UNA variedad con el precio de materia prima guardado (familia guardada: la nueva todavía no tiene precio).
async function pedirPreviewBase(key) {
  const v = ebEd && ebVariedad(key);
  if (!v) return;
  if (faltaObligatorioEnvasado(v) || !v.presentaciones.length) { ebErr = { ...ebErr, [key]: null }; pintarCeldasBase(); return; }
  const n = (ebSeq[key] = (ebSeq[key] || 0) + 1);
  try {
    const r = await pedirJson('POST', API_PROD + '/envasado/preview', bodyEnvasado({ ...v, familia: ebEd.anterior ?? ebEd.familia }));
    if (n === ebSeq[key] && ebEd) { ebCosto = { ...ebCosto, [key]: r }; ebErr = { ...ebErr, [key]: null }; }
  } catch (e) { if (n === ebSeq[key] && ebEd) ebErr = { ...ebErr, [key]: e.message }; }
  if (n === ebSeq[key] && ebEd) pintarCeldasBase();
}
// "+ Agregar códigos": cada uno precargado desde su fórmula de SIGA (en paralelo); si falla, igual entra vacío con el aviso.
async function agregarCodigosEb(key, items) {
  const libres = items.filter(it => !motivoCodigoOcupado(it.plu, ebEd, key, ebOpc.duenios));
  const v = ebVariedad(key);
  if (!libres.length || !v) return;
  avisoExito(`Precargando ${libres.length} código${libres.length === 1 ? '' : 's'} desde SIGA…`);
  const nuevos = await Promise.all(libres.map(it => getJson(`${API_PROD}/envasado/precarga/${encodeURIComponent(it.plu)}?granel=${encodeURIComponent(v.granelPlu)}`)
    .then(presentacionDesdePrecarga)
    .catch(e => ({ plu: String(it.plu), nombre: it.nombre, kgPorUnidad: null, minutosPorUnidad: null, componentes: [], aviso: e.message }))));
  if (!ebEd || !ebVariedad(key)) return; // se cerró o se quitó mientras precargaba
  const ocupado = p => motivoCodigoOcupado(p.plu, ebEd, key, ebOpc.duenios); // por si se agregó otro mientras tanto
  const sumar = nuevos.filter(p => !ocupado(p)).map(p => ({ ...p, componentes: p.componentes.filter(c => c.plu !== String(v.granelPlu) && c.plu !== p.plu) }));
  ebInsAbiertos = new Set([...ebInsAbiertos, ...sumar.filter(p => p.aviso).map(p => `${key}|${p.plu}`)]);
  editarVarEb(key, x => ({ ...x, presentaciones: [...x.presentaciones, ...sumar] }), { repintar: true });
}
async function quitarVariedadEb(key) {
  const v = ebVariedad(key);
  const n = v.presentaciones.length;
  if ((n || v.id) && !(await confirmar(`¿Quitar la variedad "${v.nombre || 'sin nombre'}"${n ? ` y sus ${n} código${n === 1 ? '' : 's'}` : ''}? Se aplica al guardar.`, { textoOk: 'Quitar' }))) return;
  editarBase(ed => ({ ...ed, variedades: ed.variedades.filter(x => x.key !== key) }), { repintar: true });
}

function conectarBase() {
  const caja = document.getElementById('ebCaja');
  document.getElementById('ebX').onclick = () => cerrarBase();
  const nom = document.getElementById('ebNombre');
  nom.addEventListener('input', () => editarBase(ed => ({ ...ed, familia: nom.value })));
  conectarMpBase();
  document.getElementById('ebTabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) { ebTab = b.dataset.tab; pintarBase(); document.getElementById('ebTab-' + ebTab).focus(); } };
  document.getElementById('ebTabs').onkeydown = e => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    ebTab = ebTab === 'codigos' ? 'pack' : 'codigos'; pintarBase(); document.getElementById('ebTab-' + ebTab).focus();
  };
  if (ebTab !== 'codigos') return;
  document.getElementById('ebNuevaVar').onclick = () => {
    const v = nuevaVariedadEb();
    ebAbiertas = new Set([...ebAbiertas, v.key]);
    editarBase(ed => ({ ...ed, variedades: [...ed.variedades, v] }), { repintar: true });
    caja.querySelector(`.eb-var-nombre[data-key="${CSS.escape(v.key)}"]`).focus();
  };
  ebEd.variedades.forEach(conectarVariedadEb);
  conectarCodigosEb(caja);
}
function conectarMpBase() {
  const ed = document.getElementById('ebMpEditar');
  if (ed) ed.onclick = () => { ebEditandoMp = true; document.getElementById('ebMp').innerHTML = htmlMpBase(); conectarMpBase(); document.getElementById('ebMpInput').focus(); };
  const can = document.getElementById('ebMpCancelar');
  if (can) can.onclick = () => { ebEditandoMp = false; document.getElementById('ebMp').innerHTML = htmlMpBase(); conectarMpBase(); };
  const gu = document.getElementById('ebMpGuardar');
  if (gu) gu.onclick = () => guardarMpBase(document.getElementById('ebMpInput').value, gu);
  const inp = document.getElementById('ebMpInput');
  if (inp) inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); guardarMpBase(inp.value, gu); } };
}
function conectarVariedadEb(v) {
  const caja = document.getElementById('ebCaja'), sel = `[data-key="${CSS.escape(v.key)}"]`;
  caja.querySelector('.eb-caret' + sel).onclick = () => {
    ebAbiertas = new Set(ebAbiertas.has(v.key) ? [...ebAbiertas].filter(k => k !== v.key) : [...ebAbiertas, v.key]);
    pintarBase();
    caja.querySelector('.eb-caret' + sel).focus();
  };
  const nom = caja.querySelector('.eb-var-nombre' + sel);
  nom.addEventListener('input', () => editarVarEb(v.key, x => ({ ...x, nombre: nom.value })));
  caja.querySelector('.eb-quitar-var' + sel).onclick = () => quitarVariedadEb(v.key);
  const cambiar = caja.querySelector('.eb-cambiar-granel' + sel);
  if (cambiar) cambiar.onclick = () => editarVarEb(v.key, x => ({ ...x, granelPlu: null, granelNombre: null }), { repintar: true });
  if (document.getElementById('ebGranel-' + v.key)) {
    conectarBuscadorSiga('ebGranel-' + v.key, ({ plu, nombre }) => editarVarEb(v.key, x => ({ ...x, granelPlu: String(plu), granelNombre: nombre }), { repintar: true }));
  }
  if (!ebAbiertas.has(v.key)) return;
  if (document.getElementById('ebAgregar-' + v.key)) {
    conectarBuscadorSiga('ebAgregar-' + v.key, items => agregarCodigosEb(v.key, items), { multiple: true, deshabilitado: plu => motivoCodigoOcupado(plu, ebEd, v.key, ebOpc.duenios) });
  }
  v.presentaciones.forEach(p => {
    const id = `ebIns-${v.key}-${p.plu}`;
    if (!document.getElementById(id)) return;
    conectarBuscadorSiga(id, items => {
      const todas = caja.querySelector(`.eb-a-todas[data-k="${CSS.escape(v.key + '|' + p.plu)}"]`);
      const actual = ebVariedad(v.key);
      editarVarEb(v.key, x => ({ ...x, presentaciones: conInsumos(x.presentaciones, todas && todas.checked ? null : p.plu, items, actual.granelPlu) }), { repintar: true });
    }, { multiple: true, deshabilitado: plu => (plu === String(v.granelPlu) ? 'es el granel' : plu === p.plu ? 'es este código'
      : ((ebVariedad(v.key).presentaciones.find(x => x.plu === p.plu) || p).componentes.some(c => String(c.plu) === plu) ? 'ya está' : null)) });
  });
}
// Delegado sobre las tablas de códigos (inputs y botones de cada fila).
function conectarCodigosEb(caja) {
  const cuerpo = document.getElementById('ebCuerpo');
  const ki = el => [el.dataset.key, Number(el.dataset.i)];
  cuerpo.oninput = e => {
    const t = e.target;
    if (t.classList.contains('eb-kg')) { const [k, i] = ki(t); editarCodEb(k, i, p => ({ ...p, kgPorUnidad: numOrNull(t.value) })); }
    else if (t.classList.contains('eb-min')) { const [k, i] = ki(t); editarCodEb(k, i, p => ({ ...p, minutosPorUnidad: numOrNull(t.value) })); }
    else if (t.classList.contains('eb-cant')) {
      const [k, i] = ki(t), j = Number(t.dataset.j);
      editarCodEb(k, i, p => ({ ...p, componentes: p.componentes.map((c, x) => (x === j ? { ...c, cantidad: numOrNull(t.value) } : c)) }));
    }
  };
  cuerpo.onchange = e => { const s = e.target.closest('.lst-decision'); if (s) cambiarDecisionLst('produccion', s); }; // precios_listados.js
  cuerpo.onclick = e => {
    const b = e.target.closest('button');
    if (!b || !cuerpo.contains(b)) return;
    if (b.classList.contains('eb-ins-abrir')) {
      const k = b.dataset.k;
      ebInsAbiertos = new Set(ebInsAbiertos.has(k) ? [...ebInsAbiertos].filter(x => x !== k) : [...ebInsAbiertos, k]);
      pintarBase();
      const otra = caja.querySelector(`.eb-ins-abrir[data-k="${CSS.escape(k)}"]`); if (otra) otra.focus();
    } else if (b.classList.contains('eb-quitar')) { const [k, i] = ki(b); editarVarEb(k, v => ({ ...v, presentaciones: v.presentaciones.filter((_, x) => x !== i) }), { repintar: true }); }
    else if (b.classList.contains('eb-quitar-ins')) { const [k, i] = ki(b); const j = Number(b.dataset.j); editarCodEb(k, i, p => ({ ...p, componentes: p.componentes.filter((_, x) => x !== j) }), { repintar: true }); }
    else if (b.classList.contains('eb-precios')) { // precios_modal_esquema.js (#mDet queda encima); el precio sale de lo guardado
      if (ebEd.sucio) avisar('Guardá los cambios antes de decidir el precio.'); else abrirModalEsquema('produccion', b.dataset.plu);
    }
    else if (b.classList.contains('eb-validar')) validarCodigosBase({ key: b.dataset.key, plu: b.dataset.plu }, b);
  };
}

// ── Guardar / precio de materia prima / validar / eliminar ──────────────────────
// Recarga lo guardado (GET), el listado de atrás y el toast "a revisar".
async function refrescarTrasGuardarBase(familia) {
  await recargarBase(familia);
  pintarBase();
  refrescarAlertasProduccion();
  cargarListado('produccion');
}
async function guardarBase(btn) {
  const falta = faltaBase(ebEd);
  if (falta) { avisar(falta); return; }
  btn.disabled = true;
  try {
    const nuevo = ebEd.anterior == null;
    const url = API_PROD + '/envasado/base' + (nuevo ? '' : `?familia=${encodeURIComponent(ebEd.anterior)}`);
    const r = await pedirJson(nuevo ? 'POST' : 'PUT', url, bodyBase(ebEd));
    const abiertas = new Set(ebEd.variedades.map((v, i) => (ebAbiertas.has(v.key) ? r.ids[i] : null)).filter(Boolean));
    await refrescarTrasGuardarBase(r.familia);
    ebAbiertas = abiertas; ebInsAbiertos = new Set();
    pintarBase();
    avisoExito(nuevo ? 'Producto base creado' : 'Guardado');
  } catch (e) { avisar(e.message); if (document.contains(btn)) btn.disabled = false; }
}
// PUT del precio de materia prima (vacío = borrar, vuelve al costo de cada granel): mismo route que antes del modal.
async function guardarMpBase(valor, btn) {
  btn.disabled = true;
  try {
    const r = await pedirJson('PUT', `${API_PROD}/familias/${encodeURIComponent(ebEd.anterior)}/costo`, { costoKg: numOrNull(valor) });
    ebEditandoMp = false;
    ebInfo = { ...ebInfo, costoKg: r.costoKg };
    if (ebEd.sucio) { document.getElementById('ebMp').innerHTML = htmlMpBase(); conectarMpBase(); ebEd.variedades.forEach(v => programarPreviewBase(v.key)); }
    else await refrescarTrasGuardarBase(ebEd.anterior);
    refrescarAlertasProduccion();
    cargarListado('produccion');
  } catch (e) { avisar(e.message); btn.disabled = false; }
}
// pedido null = "Validar todos" (cada variedad guardada); { key, plu } = un código.
async function validarCodigosBase(pedido, btn) {
  if (ebEd.sucio) { avisar('Guardá los cambios antes de validar el costo.'); return; }
  btn.disabled = true;
  const lotes = pedido ? [[ebVariedad(pedido.key).id, { tipo: 'presentacion', id: pedido.plu }]]
    : ebEd.variedades.filter(v => v.id && v.presentaciones.length).map(v => [v.id, { tipo: 'todo' }]);
  try {
    const rs = await Promise.all(lotes.map(([id, body]) => pedirJson('POST', urlProd(id, '/validar'), body)));
    const omitidos = rs.flatMap(r => r.omitidos || []);
    await refrescarTrasGuardarBase(ebEd.anterior);
    avisoExito('Costo validado');
    if (omitidos.length) avisar('No se validaron porque les faltan datos:\n' + omitidos.map(o => `• ${o.id}: ${o.faltantes.map(k => textoFaltante(k)).join('; ')}`).join('\n'));
  } catch (e) { avisar(e.message); if (document.contains(btn)) btn.disabled = false; }
}
async function eliminarBase() {
  const n = ebEd.ids.length, nombre = ebEd.anterior || SIN_BASE;
  if (!(await confirmar(`¿Eliminar el producto base "${nombre}" con sus ${n} variedad${n === 1 ? '' : 'es'} y todos sus códigos? No se puede deshacer.`, { textoOk: 'Eliminar' }))) return;
  try {
    await pedirJson('DELETE', `${API_PROD}/envasado/base?familia=${encodeURIComponent(ebEd.anterior)}`);
    await cerrarBase({ forzar: true });
    refrescarAlertasProduccion();
    cargarListado('produccion');
    avisoExito('Producto base eliminado');
  } catch (e) { avisar(e.message); }
}
