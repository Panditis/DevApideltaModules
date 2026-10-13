// ── Precios · Producción › Envasado Apidelta: editor de una VARIEDAD (alta y edición) ──
// Familia › Variedad › PLUs (ej. Miel › Pradera › 500 g, 1 kg, 28 kg). La variedad tiene su granel; cada PLU de venta, su
// kg de granel por unidad y sus insumos (envase, tapa, etiqueta…). Costo de cada PLU = granel $/kg × kg + Σ insumos. El
// costo SIEMPRE sale del server (POST /envasado/preview mientras se edita, GET del detalle después de guardar).
// Script clásico, cargado después de precios_produccion*.js: usa sus globales (prodDet, panelProd, getJson, urlProd, API_PROD,
// htmlBuscadorSiga, conectarBuscadorSiga, badgeEstadoProd, textoFaltante, textoRevisar, sugeridoProd, guardarProd,
// validarProd, htmlMargenEspecialProd, conectarMargenEspecialProd, fmtNum, btnPrim, campoCls, irAProduccion) y los de
// precios.html (esc, fmtMoney, fmtPrecio, fmtPct, claseDelta, campoU, chip, numOrNull, pedirJson, avisar, confirmar,
// refrescarAlertasProduccion).
// Rutas: #produccion/envasado/nuevo = alta · #produccion/<id>[/<plu>] de un envasado = edición (cargarDetalleProduccion).

// ── Helpers puros (test/precios_produccion_ui.test.js) ──────────────────────────
// Body del alta/edición/vista previa (id = variedad que se edita; la vista previa conserva sus validados).
function bodyEnvasado(ed) {
  return {
    ...(ed.id ? { id: ed.id } : {}), familia: String(ed.familia || '').trim(), nombre: String(ed.nombre || '').trim(), granelPlu: ed.granelPlu,
    presentaciones: Object.fromEntries((ed.presentaciones || []).map(p => [p.plu, {
      kgPorUnidad: p.kgPorUnidad, componentes: (p.componentes || []).map(c => ({ plu: String(c.plu), cantidad: c.cantidad })),
    }])),
  };
}
// Qué obligatorio falta ('' = se puede guardar y costear). Una variedad sin PLUs se puede crear.
function faltaObligatorioEnvasado(ed) {
  if (!String(ed.nombre || '').trim()) return 'Poné el nombre de la variedad (ej. Pradera).';
  if (!ed.granelPlu) return 'Elegí el granel de la variedad.';
  for (const p of ed.presentaciones || []) {
    const nom = p.nombre || p.plu;
    if (!(Number(p.kgPorUnidad) > 0)) return `Completá los kg de granel por unidad de ${nom} (ej. 0,5).`;
    const sin = (p.componentes || []).find(c => !(Number(c.cantidad) > 0));
    if (sin) return `Completá la cantidad de ${sin.nombre || sin.plu} en ${nom} (mayor a 0).`;
  }
  return '';
}
// Copia editable desde el detalle del server (nombres de PLUs e insumos del costeo).
function edicionEnvasado(det) {
  const d = det.definicion;
  const lineas = Object.values(det.presentaciones || {}).flatMap(p => p.componentes || []);
  const nombre = plu => (lineas.find(c => String(c.plu) === String(plu)) || {}).nombre || null;
  return {
    id: det.id, familia: d.familia || '', nombre: d.nombre, granelPlu: d.granelPlu, granelNombre: nombre(d.granelPlu),
    presentaciones: Object.entries(d.presentaciones || {}).map(([plu, p]) => ({
      plu, nombre: ((det.presentaciones || {})[plu] || {}).nombre || null, kgPorUnidad: p.kgPorUnidad,
      componentes: (p.componentes || []).map(c => ({ plu: c.plu, nombre: nombre(c.plu), cantidad: c.cantidad })),
    })),
  };
}
// PLU nuevo desde GET /envasado/precarga (kg = cantidad del granel en su fórmula SIGA, insumos = el resto). aviso = otro
// granel en la fórmula o sin fórmula/granel (se muestra en el PLU, no bloquea).
function presentacionDesdePrecarga(pre) {
  return {
    plu: String(pre.plu), nombre: pre.nombre || null, kgPorUnidad: pre.kgPorUnidad ?? null,
    componentes: (pre.componentes || []).map(c => ({ plu: String(c.plu), nombre: c.nombre || null, cantidad: c.cantidad })),
    aviso: pre.avisoGranel || pre.mensaje || null,
  };
}
// Insumos elegidos (cantidad 1) al PLU `destino` o, con destino null, a todos los PLUs de la variedad. Sin repetir ni el granel.
function conInsumos(presentaciones, destino, items, granelPlu) {
  return presentaciones.map(p => {
    if (destino != null && p.plu !== destino) return p;
    const ya = new Set([String(granelPlu), p.plu, ...p.componentes.map(c => String(c.plu))]);
    const nuevos = items.filter(it => !ya.has(String(it.plu))).map(it => ({ plu: String(it.plu), nombre: it.nombre || null, cantidad: 1 }));
    return nuevos.length ? { ...p, componentes: [...p.componentes, ...nuevos] } : p;
  });
}
// Por qué un PLU de venta no se puede agregar a la variedad (null = se puede). duenios = GET /envasado/opciones (lo guardado):
// un PLU de esta misma variedad quitado sin guardar se puede volver a agregar.
function motivoPluOcupado(plu, ed, duenios) {
  if ((ed.presentaciones || []).some(p => p.plu === String(plu))) return 'ya está en esta variedad';
  if (String(plu) === String(ed.granelPlu)) return 'es el granel';
  const d = (duenios || {})[plu];
  return d && d.productoId !== ed.id ? `ya está en ${d.nombre}` : null;
}

if (typeof module === 'object' && module.exports) {
  module.exports = { bodyEnvasado, faltaObligatorioEnvasado, edicionEnvasado, presentacionDesdePrecarga, conInsumos, motivoPluOcupado };
}

// ── Estado ──────────────────────────────────────────────────────────────────────
const ENV_PREVIEW_MS = 300;
let envEd = null;                     // copia editable (edicionEnvasado) + sucio
let envCosto = {};                    // plu → presentación costeada del server (detalle o vista previa)
let envError = null;                  // error de la última vista previa
let envAbiertos = new Set();          // PLUs desplegados (insumos)
let envOpc = { familias: [], duenios: {} }; // GET /envasado/opciones
let envTimer = null, envSeq = 0;

function cargarOpcionesEnv() {
  getJson(API_PROD + '/envasado/opciones').then(o => {
    envOpc = o;
    const dl = document.getElementById('envFamilias');
    if (dl) dl.innerHTML = htmlOpcionesFamilia();
  }).catch(() => { /* sin sugerencias: el server igual valida los PLUs */ });
}
function abrirEnvasadoNuevo() {
  prodDet = null;
  envEd = { id: null, familia: '', nombre: '', granelPlu: null, granelNombre: null, presentaciones: [], sucio: false };
  envCosto = {}; envError = null; envAbiertos = new Set();
  cargarOpcionesEnv();
  pintarEnvasado();
}
// cargarDetalleProduccion (precios_produccion.js) con un envasado: edición con lo guardado; abrirPlu = ese PLU desplegado.
function pintarDetalleEnvasado(abrirPlu = null) {
  const mismo = envEd && envEd.id === prodDet.id;
  envEd = { ...edicionEnvasado(prodDet), sucio: false };
  envCosto = prodDet.presentaciones || {}; envError = null;
  if (!mismo) envAbiertos = new Set();
  if (abrirPlu) {
    envAbiertos = new Set([...envAbiertos, abrirPlu]);
    history.replaceState(null, '', '#produccion/' + encodeURIComponent(prodDet.id));
  }
  cargarOpcionesEnv();
  pintarEnvasado();
}

// ── Pintado ─────────────────────────────────────────────────────────────────────
const plataEnv = v => (v == null ? '<span class="text-crit text-xs">sin costo</span>' : '$ ' + fmtMoney(v));
const lineaEnv = (plu, comp) => (((envCosto[plu] || {}).componentes) || []).find(c => String(c.plu) === String(comp)) || {};
const guardadoEnv = plu => !!(prodDet && prodDet.definicion && (prodDet.definicion.presentaciones || {})[plu]);
const htmlOpcionesFamilia = () => (envOpc.familias || []).map(f => `<option value="${esc(f)}"></option>`).join('');

function htmlCabeceraEnv() {
  const guardado = !!envEd.id;
  const titulo = [envEd.familia, envEd.nombre].filter(s => String(s || '').trim()).join(' › ') || 'Nueva variedad';
  return `<nav class="pr-miga" aria-label="Ubicación"><a href="#produccion/envasado">Envasado Apidelta</a><span aria-hidden="true">›</span><span>${esc(titulo)}</span></nav>
    <div class="pr-cab">
      <div class="flex items-center gap-3 min-w-0">
        <a href="#produccion/envasado" class="pr-volver" title="Volver al listado" aria-label="Volver al listado de Envasado Apidelta">←</a>
        <h2 class="font-disp text-lg font-bold text-ink truncate">${esc(titulo)}</h2>
      </div>
      ${guardado ? `<span class="flex gap-2 shrink-0">
        ${envEd.presentaciones.length ? '<button id="envValidarTodo" class="cfg-btn2" title="Guarda el costo actual de cada PLU: desde ahí avisa si cambia el granel o algún insumo">Validar todos</button>' : ''}
        <button id="envEliminar" class="px-3 py-1.5 rounded-lg text-[12.5px] font-semibold text-crit hover:bg-crit/10">Eliminar variedad</button></span>` : ''}
    </div>`;
}
function htmlVariedadEnv() {
  const granel = envEd.granelPlu
    ? `<div class="text-sm py-1"><b class="tabular-nums">${esc(envEd.granelPlu)}</b> ${esc(envEd.granelNombre || '')}
        <button type="button" id="envCambiarGranel" class="ml-2 text-xs text-verde underline underline-offset-2">Cambiar</button></div>`
    : htmlBuscadorSiga('envGranel', 'Buscar el granel en SIGA (ej. MIEL PRADERA GRANEL)…');
  return `<section class="mt-4 rounded-xl border border-borde bg-card p-4"><h3 class="text-sm font-semibold text-ink mb-3">① Variedad</h3>
    <div class="flex flex-wrap items-start gap-x-6 gap-y-3">
      <label class="text-sm"><span class="block text-xs text-gris mb-1">Familia</span>
        <input id="envFamilia" list="envFamilias" maxlength="60" placeholder="ej. Miel" value="${esc(envEd.familia)}" class="${campoCls} w-48"></label>
      <datalist id="envFamilias">${htmlOpcionesFamilia()}</datalist>
      <label class="text-sm"><span class="block text-xs text-gris mb-1">Variedad</span>
        <input id="envNombre" maxlength="60" placeholder="ej. Pradera" value="${esc(envEd.nombre)}" class="${campoCls} w-48"></label>
      <div class="text-sm min-w-[18rem]"><span class="block text-xs text-gris mb-1">Granel (lo usan todos sus PLUs)</span>${granel}</div>
    </div></section>`;
}
// Celdas que la vista previa actualiza sin repintar los inputs (data-env = "<qué>|<plu>[|<insumo>]").
function celdaEnv(que, plu, comp = null) {
  const c = envCosto[plu];
  if (que === 'costo') return c ? plataEnv(c.costoUnidad) : '—';
  if (que === 'vigente') return c && c.precioVigente != null ? '$ ' + fmtPrecio(c.precioVigente) : '<span class="text-gris">—</span>';
  if (que === 'sugerido') {
    const s = c && c.costoUnidad != null ? sugeridoProd(c) : null;
    return s ? `<b>$ ${fmtPrecio(s.precio)}</b>${s.deltaPct != null ? ` <span class="text-xs ${claseDelta(s.estado)}">${fmtPct(s.deltaPct)}</span>` : ''}` : '<span class="text-gris">—</span>';
  }
  if (que === 'estado') return c && guardadoEnv(plu) && !envEd.sucio ? badgeEstadoProd(c, Object.fromEntries((c.componentes || []).map(l => [l.plu, l.nombre]))) : '';
  const l = lineaEnv(plu, comp);
  if (que === 'unit') return comp == null ? '—' : plataEnv(l.costoUnit ?? null) + (String(comp) === String(envEd.granelPlu) ? '<span class="pr-sub">por kg</span>' : '');
  return l.importe != null ? '$ ' + fmtMoney(l.importe) : '—'; // 'imp'
}
const tdEnv = (que, plu, comp = null, cls = 'num') => `<td class="${cls}" data-env="${esc([que, plu, comp].filter(x => x != null).join('|'))}">${celdaEnv(que, plu, comp)}</td>`;

function htmlFilaPluEnv(p, i) {
  const abierto = envAbiertos.has(p.plu);
  const validar = envEd.id && guardadoEnv(p.plu) ? `<button type="button" class="env-validar text-xs text-verde underline underline-offset-2" data-plu="${esc(p.plu)}" title="Guarda el costo actual de este PLU">Validar</button>` : '';
  // PLU ya guardado: modal de precios por canal (decisión "Aumentar"), el mismo del listado (precios_modal_esquema.js).
  const precios = envEd.id && guardadoEnv(p.plu) ? `<button type="button" class="env-precios cfg-btn2 mr-2" data-plu="${esc(p.plu)}">Precios</button>` : '';
  const fila = `<tr class="${abierto ? 'bg-verde/5' : ''}"><td class="text-left whitespace-nowrap">
      <button type="button" class="env-abrir mr-1 text-gris hover:text-verde" data-plu="${esc(p.plu)}" aria-expanded="${abierto}" aria-label="${abierto ? 'Cerrar' : 'Ver'} insumos de ${esc(p.nombre || p.plu)}">${abierto ? '▾' : '▸'}</button><b class="tabular-nums">${esc(p.plu)}</b></td>
    <td class="text-left">${esc(p.nombre || '')}${p.aviso ? ` <span class="text-warn" title="${esc(p.aviso)}">⚠</span>` : ''}</td>
    <td class="num">${campoU(`<input type="number" min="0" step="any" class="env-kg" data-i="${i}" value="${esc(p.kgPorUnidad ?? '')}" aria-label="Kg de granel por unidad de ${esc(p.nombre || p.plu)}">`, 'kg', { w: 'w-24' })}</td>
    ${tdEnv('costo', p.plu)}${tdEnv('vigente', p.plu)}${tdEnv('sugerido', p.plu)}${tdEnv('estado', p.plu, null, '')}
    <td class="text-right whitespace-nowrap">${precios}${validar}<button type="button" class="env-quitar-plu btn-quitar ml-2" data-i="${i}" aria-label="Quitar ${esc(p.nombre || p.plu)} de la variedad">✕</button></td></tr>`;
  return fila + (abierto ? `<tr><td colspan="8" class="!p-0">${htmlInsumosEnv(p, i)}</td></tr>` : '');
}
// Desplegado de un PLU: aviso de la precarga, "a revisar", granel × kg + insumos con su cantidad, buscador de insumos.
function htmlInsumosEnv(p, i) {
  const c = envCosto[p.plu];
  const revisar = c && c.estado === 'cambio' && !envEd.sucio ? `<p class="text-xs text-warn mb-2">Cambió desde la validación: ${esc(textoRevisar(c.revisar) || '')}</p>` : '';
  const filas = p.componentes.map((x, j) => `<tr><td class="tabular-nums">${esc(x.plu)}</td><td class="text-left">${esc(x.nombre || lineaEnv(p.plu, x.plu).nombre || '')}</td>
      <td class="num">${campoU(`<input type="number" min="0" step="any" class="env-cant" data-i="${i}" data-j="${j}" value="${esc(x.cantidad ?? '')}" aria-label="Cantidad de ${esc(x.nombre || x.plu)} por unidad">`, 'u', { w: 'w-24' })}</td>
      ${tdEnv('unit', p.plu, x.plu)}${tdEnv('imp', p.plu, x.plu)}
      <td class="text-right"><button type="button" class="env-quitar btn-quitar" data-i="${i}" data-j="${j}" aria-label="Quitar ${esc(x.nombre || x.plu)}">✕</button></td></tr>`).join('');
  return `<div class="px-4 py-3 bg-bg/40 border-t border-borde">
    ${p.aviso ? `<p class="text-xs text-warn mb-2">⚠ ${esc(p.aviso)}</p>` : ''}${revisar}
    <table class="pr-tabla pr-tabla-in"><thead><tr><th>PLU</th><th class="text-left">Insumo</th><th class="num">Cantidad</th><th class="num">Costo unit.</th><th class="num">Importe</th><th class="w-10"></th></tr></thead>
    <tbody><tr class="bg-verde/5"><td class="tabular-nums">${esc(envEd.granelPlu || '')}</td><td class="text-left"><span class="pr-sub">Granel</span>${esc(envEd.granelNombre || '')}</td>
      <td class="num">${esc(fmtNum(p.kgPorUnidad))} kg</td>${tdEnv('unit', p.plu, envEd.granelPlu)}${tdEnv('imp', p.plu, envEd.granelPlu)}<td></td></tr>${filas}</tbody></table>
    <div class="mt-3 flex flex-wrap items-center gap-2"><span class="text-sm text-gris">＋ Agregar insumos (envase, tapa, etiqueta…):</span>${htmlBuscadorSiga('envIns-' + p.plu, 'Buscar insumos en SIGA (podés tildar varios)…')}
      ${envEd.presentaciones.length > 1 ? `<label class="text-xs text-gris flex items-center gap-1"><input type="checkbox" class="env-a-todas accent-verde" data-plu="${esc(p.plu)}"> aplicar a todas las presentaciones de la variedad</label>` : ''}</div></div>`;
}
function htmlPlusEnv() {
  if (!envEd.granelPlu) return `<section class="mt-4 rounded-xl border border-borde bg-card p-4"><h3 class="text-sm font-semibold text-ink mb-1">② PLUs a la venta</h3>
    <p class="text-sm text-gris">Elegí el granel de la variedad para agregar sus PLUs.</p></section>`;
  const cuerpo = envEd.presentaciones.length ? envEd.presentaciones.map(htmlFilaPluEnv).join('')
    : '<tr><td colspan="8" class="p-6 text-center text-gris">Todavía no tiene PLUs: agregalos con el buscador de abajo.</td></tr>';
  return `<section class="mt-4 rounded-xl border border-borde bg-card p-4"><h3 class="text-sm font-semibold text-ink mb-2">② PLUs a la venta</h3>
    <table class="pr-tabla"><thead><tr><th class="text-left">PLU</th><th class="text-left">Producto</th><th class="num">Kg por unidad</th><th class="num">Costo</th><th class="num">Vigente</th><th class="num">Sugerido</th><th>Estado</th><th></th></tr></thead>
    <tbody>${cuerpo}</tbody></table>
    <div class="mt-3 flex flex-wrap items-center gap-2"><span class="text-sm text-gris">＋ Agregar PLUs:</span>${htmlBuscadorSiga('envAgregarPlus', 'Buscar en SIGA (ej. MIEL PRADERA) y tildar varios…')}
      <span class="text-xs text-gris">Se precargan desde su fórmula de SIGA (kg del granel e insumos).</span></div>
    <p class="text-xs text-gris mt-2">La decisión (Aumentar / No cambiar) y los precios por canal se toman en el listado, clic en el nombre.</p></section>`;
}
function htmlPieEnv() {
  const falta = faltaObligatorioEnvasado(envEd);
  const puede = !falta && (envEd.sucio || !envEd.id);
  const msg = falta || envError;
  return `<div class="mt-4 flex items-center gap-3"><button id="envGuardar" class="${btnPrim}"${puede ? '' : ' disabled'}>${envEd.id ? 'Guardar cambios' : 'Crear variedad'}</button>
    ${envEd.sucio ? chip('sin guardar', 'bg-amarillo/30 text-ink') : ''}${msg ? `<span class="text-sm ${envError && !falta ? 'text-crit' : 'text-gris'}">${esc(msg)}</span>` : ''}</div>`;
}
function pintarEnvasado() {
  panelProd().innerHTML = htmlCabeceraEnv() + htmlVariedadEnv() + htmlPlusEnv()
    + `<div id="envPie">${htmlPieEnv()}</div>` + (envEd.id && prodDet ? htmlMargenEspecialProd() : '');
  conectarEnvasado();
}
// Después de una vista previa: sólo las celdas de costo y el pie (los inputs no se repintan: no pierden el foco).
function pintarCostosEnv() {
  panelProd().querySelectorAll('[data-env]').forEach(td => { const [que, plu, comp] = td.dataset.env.split('|'); td.innerHTML = celdaEnv(que, plu, comp ?? null); });
  pintarPieEnv();
}
function pintarPieEnv() { document.getElementById('envPie').innerHTML = htmlPieEnv(); conectarPieEnv(); }

// ── Edición ─────────────────────────────────────────────────────────────────────
// cambio = campos nuevos; repintar = cambió la estructura (filas), si no sólo el pie. Siempre pide la vista previa.
function editarEnv(cambio, repintar = false) {
  envEd = { ...envEd, ...cambio, sucio: true };
  if (repintar) pintarEnvasado(); else pintarPieEnv();
  programarPreviewEnv();
}
const editarPluEnv = (i, fn, repintar = false) => editarEnv({ presentaciones: envEd.presentaciones.map((p, k) => (k === i ? fn(p) : p)) }, repintar);
function programarPreviewEnv() { clearTimeout(envTimer); envTimer = setTimeout(pedirPreviewEnv, ENV_PREVIEW_MS); }
async function pedirPreviewEnv() {
  if (faltaObligatorioEnvasado(envEd) || !envEd.presentaciones.length) { envError = null; if (document.getElementById('envPie')) pintarCostosEnv(); return; }
  const n = ++envSeq;
  try {
    const r = await pedirJson('POST', API_PROD + '/envasado/preview', bodyEnvasado(envEd));
    if (n === envSeq) { envCosto = r; envError = null; }
  } catch (e) { if (n === envSeq) envError = e.message; }
  if (n === envSeq && document.getElementById('envPie')) pintarCostosEnv();
}
// "+ Agregar PLUs": cada uno precargado desde su fórmula de SIGA (en paralelo); si falla, igual entra vacío con el aviso.
async function agregarPlusEnv(items) {
  const libres = items.filter(it => !motivoPluOcupado(it.plu, envEd, envOpc.duenios));
  if (!libres.length) return;
  avisoExito(`Precargando ${libres.length} PLU${libres.length === 1 ? '' : 's'} desde SIGA…`);
  const nuevos = await Promise.all(libres.map(it => getJson(`${API_PROD}/envasado/precarga/${encodeURIComponent(it.plu)}?granel=${encodeURIComponent(envEd.granelPlu)}`)
    .then(presentacionDesdePrecarga)
    .catch(e => ({ plu: String(it.plu), nombre: it.nombre, kgPorUnidad: null, componentes: [], aviso: e.message }))));
  const ya = new Set(envEd.presentaciones.map(p => p.plu)); // por si se agregó otro mientras precargaba
  const sumar = nuevos.filter(p => !ya.has(p.plu)).map(p => ({ ...p, componentes: p.componentes.filter(c => c.plu !== String(envEd.granelPlu) && c.plu !== p.plu) }));
  envAbiertos = new Set([...envAbiertos, ...sumar.map(p => p.plu)]);
  editarEnv({ presentaciones: [...envEd.presentaciones, ...sumar] }, true);
}
function conectarInsumosEnv(p) {
  const id = 'envIns-' + p.plu;
  if (!document.getElementById(id)) return;
  conectarBuscadorSiga(id, items => {
    const aTodas = panelProd().querySelector(`.env-a-todas[data-plu="${CSS.escape(p.plu)}"]`);
    editarEnv({ presentaciones: conInsumos(envEd.presentaciones, aTodas && aTodas.checked ? null : p.plu, items, envEd.granelPlu) }, true);
  }, {
    multiple: true,
    deshabilitado: plu => (plu === String(envEd.granelPlu) ? 'es el granel' : plu === p.plu ? 'es este PLU'
      : (envEd.presentaciones.find(x => x.plu === p.plu) || p).componentes.some(c => String(c.plu) === plu) ? 'ya está' : null),
  });
}
function conectarEnvasado() {
  const inNombre = document.getElementById('envNombre'), inFamilia = document.getElementById('envFamilia');
  inNombre.addEventListener('input', () => editarEnv({ nombre: inNombre.value }));
  inFamilia.addEventListener('input', () => editarEnv({ familia: inFamilia.value }));
  if (document.getElementById('envGranel')) conectarBuscadorSiga('envGranel', ({ plu, nombre }) => editarEnv({ granelPlu: String(plu), granelNombre: nombre }, true));
  if (document.getElementById('envAgregarPlus')) {
    conectarBuscadorSiga('envAgregarPlus', agregarPlusEnv, { multiple: true, deshabilitado: plu => motivoPluOcupado(plu, envEd, envOpc.duenios) });
  }
  const cambiarGranel = document.getElementById('envCambiarGranel');
  if (cambiarGranel) cambiarGranel.onclick = () => editarEnv({ granelPlu: null, granelNombre: null }, true);
  const panel = panelProd();
  panel.querySelectorAll('.env-abrir').forEach(b => b.onclick = () => {
    const plu = b.dataset.plu;
    envAbiertos = new Set(envAbiertos.has(plu) ? [...envAbiertos].filter(x => x !== plu) : [...envAbiertos, plu]);
    pintarEnvasado();
  });
  panel.querySelectorAll('.env-kg').forEach(inp => inp.addEventListener('input', () => editarPluEnv(Number(inp.dataset.i), p => ({ ...p, kgPorUnidad: numOrNull(inp.value) }))));
  panel.querySelectorAll('.env-cant').forEach(inp => inp.addEventListener('input', () => {
    const j = Number(inp.dataset.j);
    editarPluEnv(Number(inp.dataset.i), p => ({ ...p, componentes: p.componentes.map((c, k) => (k === j ? { ...c, cantidad: numOrNull(inp.value) } : c)) }));
  }));
  panel.querySelectorAll('.env-quitar').forEach(b => b.onclick = () => {
    const j = Number(b.dataset.j);
    editarPluEnv(Number(b.dataset.i), p => ({ ...p, componentes: p.componentes.filter((_, k) => k !== j) }), true);
  });
  panel.querySelectorAll('.env-quitar-plu').forEach(b => b.onclick = () => {
    const i = Number(b.dataset.i);
    editarEnv({ presentaciones: envEd.presentaciones.filter((_, k) => k !== i) }, true);
  });
  envEd.presentaciones.forEach(conectarInsumosEnv);
  panel.querySelectorAll('.env-precios').forEach(b => b.onclick = () => abrirModalEsquema('produccion', b.dataset.plu)); // precios_modal_esquema.js
  panel.querySelectorAll('.env-validar').forEach(b => b.onclick = e => validarEnv({ tipo: 'presentacion', id: b.dataset.plu }, e.currentTarget));
  const validarTodo = document.getElementById('envValidarTodo');
  if (validarTodo) validarTodo.onclick = e => validarEnv({ tipo: 'todo' }, e.currentTarget);
  const eliminar = document.getElementById('envEliminar');
  if (eliminar) eliminar.onclick = eliminarEnvasado;
  conectarPieEnv();
  if (envEd.id && prodDet) conectarMargenEspecialProd();
}
function conectarPieEnv() { document.getElementById('envGuardar').onclick = e => guardarEnvasado(e.currentTarget); }

// ── Guardar / validar / eliminar ────────────────────────────────────────────────
// ponytail: salir con cambios sin guardar no pregunta (como el detalle de recetas); agregar el aviso si molesta.
async function guardarEnvasado(btn) {
  const falta = faltaObligatorioEnvasado(envEd);
  if (falta) { avisar(falta); return; }
  const { id: _id, ...body } = bodyEnvasado(envEd);
  if (envEd.id) { await guardarProd(() => pedirJson('PUT', urlProd(envEd.id, '/envasado'), body), btn, 'Guardado'); return; }
  btn.disabled = true;
  try {
    const j = await pedirJson('POST', API_PROD + '/envasado', body);
    refrescarAlertasProduccion();
    irAProduccion(j.id);
  } catch (e) { avisar(e.message); btn.disabled = false; }
}
function validarEnv(pedido, btn) {
  if (envEd.sucio) { avisar('Guardá los cambios antes de validar el costo.'); return; }
  validarProd(pedido, btn);
}
async function eliminarEnvasado() {
  const n = envEd.presentaciones.length;
  const nombre = [envEd.familia, envEd.nombre].filter(Boolean).join(' ');
  if (!(await confirmar(`¿Eliminar la variedad "${nombre}"${n ? ` y sus ${n} PLU${n === 1 ? '' : 's'}` : ''}? No se puede deshacer.`, { textoOk: 'Eliminar' }))) return;
  try {
    await pedirJson('DELETE', urlProd(envEd.id));
    refrescarAlertasProduccion();
    location.hash = '#produccion/envasado';
  } catch (e) { avisar(e.message); }
}
