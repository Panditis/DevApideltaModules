// ── Precios · Producción › Envasado Apidelta: editor (alta y edición) ──
// Producto envasado (ej. mieles): un PLU de venta = granel × kg por unidad + empaque (envase, tapa, etiqueta…). El costo
// SIEMPRE sale del server (POST /envasado/preview mientras se edita, GET del detalle después de guardar).
// Script clásico, cargado después de precios_produccion*.js: usa sus globales (prodDet, panelProd, getJson, urlProd, API_PROD,
// htmlBuscadorSiga, conectarBuscadorSiga, badgeEstadoProd, textoFaltante, textoRevisar, sugeridoProd, guardarProd,
// validarProd, htmlMargenEspecialProd, conectarMargenEspecialProd, fmtNum, btnCls, btnPrim) y los de precios.html (esc,
// fmtMoney, fmtPrecio, fmtPct, claseDelta, campoU, pedirJson, avisar, confirmar, refrescarAlertasProduccion).
// Rutas: #produccion/envasado/nuevo = alta · #produccion/<id> de un envasado = edición (cargarDetalleProduccion).

// ── Helpers puros (test/precios_produccion_ui.test.js) ──────────────────────────
// Body del alta/edición/vista previa (id = producto que se edita; la vista previa conserva su validado).
function bodyEnvasado(ed) {
  return {
    ...(ed.id ? { id: ed.id } : {}), nombre: String(ed.nombre || '').trim(), plu: ed.plu, granelPlu: ed.granelPlu, kgPorUnidad: ed.kgPorUnidad,
    componentes: (ed.componentes || []).map(c => ({ plu: String(c.plu), cantidad: c.cantidad })),
  };
}
// Qué obligatorio falta ('' = se puede guardar y costear).
function faltaObligatorioEnvasado(ed) {
  if (!ed.plu) return 'Elegí el producto a la venta (PLU de SIGA).';
  if (!String(ed.nombre || '').trim()) return 'Poné el nombre del producto.';
  if (!ed.granelPlu) return 'Elegí el granel.';
  if (!(Number(ed.kgPorUnidad) > 0)) return 'Completá los kg de granel por unidad (ej. 0,5).';
  const sin = (ed.componentes || []).find(c => !(Number(c.cantidad) > 0));
  return sin ? `Completá la cantidad de ${sin.nombre || sin.plu} (mayor a 0).` : '';
}
// Copia editable desde el detalle del server (nombres de los componentes del costeo).
function edicionEnvasado(det) {
  const d = det.definicion;
  const comps = ((det.presentaciones[d.plu] || {}).componentes) || [];
  const nombre = plu => (comps.find(c => String(c.plu) === String(plu)) || {}).nombre || null;
  return {
    id: det.id, nombre: d.nombre, plu: d.plu, granelPlu: d.granelPlu, granelNombre: nombre(d.granelPlu), kgPorUnidad: d.kgPorUnidad,
    componentes: (d.componentes || []).map(c => ({ plu: c.plu, nombre: nombre(c.plu), cantidad: c.cantidad })),
  };
}

if (typeof module === 'object' && module.exports) module.exports = { bodyEnvasado, faltaObligatorioEnvasado, edicionEnvasado };

// ── Estado ──────────────────────────────────────────────────────────────────────
const ENV_PREVIEW_MS = 300;
let envEd = null;       // copia editable (edicionEnvasado) + sucio
let envCosto = null;    // presentación costeada del server (detalle o vista previa)
let envAviso = null;    // aviso de la precarga (sin fórmula, sin granel…)
let envTimer = null, envSeq = 0;

function abrirEnvasadoNuevo() {
  prodDet = null;
  envEd = { id: null, nombre: '', plu: null, granelPlu: null, granelNombre: null, kgPorUnidad: null, componentes: [], sucio: false };
  envCosto = null; envAviso = null;
  pintarEnvasado();
}
// cargarDetalleProduccion (precios_produccion.js) con un producto envasado: edición con lo guardado.
function pintarDetalleEnvasado() {
  envEd = { ...edicionEnvasado(prodDet), sucio: false };
  envCosto = prodDet.presentaciones[prodDet.definicion.plu] || null;
  envAviso = null;
  pintarEnvasado();
}

// ── Pintado ─────────────────────────────────────────────────────────────────────
const plataEnv = v => (v == null ? '<span class="text-crit text-xs">sin costo</span>' : '$ ' + fmtMoney(v));
const lineaEnv = plu => ((envCosto && envCosto.componentes) || []).find(c => String(c.plu) === String(plu)) || {};

function htmlCabeceraEnv() {
  const guardado = !!envEd.id;
  return `<nav class="pr-miga" aria-label="Ubicación"><a href="#produccion/envasado">Envasado Apidelta</a><span aria-hidden="true">›</span><span>${esc(envEd.nombre || 'Nuevo')}</span></nav>
    <div class="pr-cab">
      <div class="flex items-center gap-3 min-w-0">
        <a href="#produccion/envasado" class="pr-volver" title="Volver al listado" aria-label="Volver al listado de Envasado Apidelta">←</a>
        <input id="envNombre" maxlength="60" aria-label="Nombre del producto" placeholder="Nombre (ej. Miel 500 g)" value="${esc(envEd.nombre)}" class="pr-nombre">
        ${guardado && envCosto ? badgeEstadoProd(envCosto) : ''}
      </div>
      ${guardado ? `<span class="flex gap-2 shrink-0">
        <button id="envValidar" class="cfg-btn2" title="Guarda el costo actual: desde ahí avisa si cambia el granel o algún empaque">Validar costo</button>
        <button id="envEliminar" class="px-3 py-1.5 rounded-lg text-[12.5px] font-semibold text-crit hover:bg-crit/10">Eliminar</button></span>` : ''}
    </div>`;
}
// "A revisar": qué componente cambió desde la validación.
function htmlRevisarEnv() {
  if (!envCosto || envCosto.estado !== 'cambio' || envEd.sucio) return '';
  return `<div class="pr-alertas"><section class="pr-alerta a-cambio"><h3>Costos que cambiaron desde la validación</h3>
    <ul><li><span class="tabular-nums font-semibold text-warn">${esc(textoRevisar(envCosto.revisar) || '')}</span></li></ul></section></div>`;
}
function htmlVentaEnv() {
  const cuerpo = envEd.plu
    ? `<div class="text-sm"><b class="tabular-nums">${esc(envEd.plu)}</b>${envEd.id ? '' : ' <button type="button" id="envCambiarPlu" class="ml-2 text-xs text-verde underline underline-offset-2">Cambiar</button>'}</div>`
    : `<p class="text-xs text-gris mb-1">Si tiene fórmula en SIGA se precargan el granel y el empaque (después se pueden editar).</p>${htmlBuscadorSiga('envPlu', 'Buscar el producto a la venta en SIGA…')}`;
  return `<section class="mt-4 rounded-xl border border-borde bg-card p-4"><h3 class="text-sm font-semibold text-ink mb-2">① Producto a la venta (PLU de SIGA)</h3>${cuerpo}
    ${envAviso ? `<p class="mt-2 text-xs text-warn">${esc(envAviso)}</p>` : ''}</section>`;
}
function htmlFilaEmpaqueEnv(c, i) {
  const l = lineaEnv(c.plu);
  return `<tr data-i="${i}"><td class="tabular-nums">${esc(c.plu)}</td><td class="text-left">${esc(c.nombre || l.nombre || '')}</td>
    <td class="num">${campoU(`<input type="number" min="0" step="any" class="env-cant" data-i="${i}" value="${esc(c.cantidad ?? '')}" aria-label="Cantidad de ${esc(c.nombre || c.plu)} por unidad">`, 'u', { w: 'w-24' })}</td>
    <td class="num" data-unit="${esc(c.plu)}">${plataEnv(l.costoUnit ?? null)}</td><td class="num" data-imp="${esc(c.plu)}">${l.importe != null ? '$ ' + fmtMoney(l.importe) : '—'}</td>
    <td class="text-right"><button type="button" class="env-quitar btn-quitar" data-i="${i}" aria-label="Quitar ${esc(c.nombre || c.plu)}">✕</button></td></tr>`;
}
function htmlComposicionEnv() {
  if (!envEd.plu) return '';
  const g = lineaEnv(envEd.granelPlu);
  const granel = envEd.granelPlu
    ? `<b class="tabular-nums">${esc(envEd.granelPlu)}</b> ${esc(envEd.granelNombre || g.nombre || '')} <button type="button" id="envCambiarGranel" class="ml-1 text-xs text-verde underline underline-offset-2">Cambiar</button>`
    : htmlBuscadorSiga('envGranel', 'Buscar el granel en SIGA…');
  return `<section class="mt-4 rounded-xl border border-borde bg-card p-4"><h3 class="text-sm font-semibold text-ink mb-2">② Composición de una unidad</h3>
    <table class="pr-tabla pr-tabla-in"><thead><tr><th>PLU</th><th class="text-left">Componente</th><th class="num">Cantidad</th><th class="num">Costo unit.</th><th class="num">Importe</th><th class="w-10"></th></tr></thead>
    <tbody><tr class="bg-verde/5"><td colspan="2" class="text-left"><span class="pr-sub">Granel</span>${granel}</td>
      <td class="num">${campoU(`<input type="number" min="0" step="any" id="envKg" value="${esc(envEd.kgPorUnidad ?? '')}" aria-label="Kg de granel por unidad">`, 'kg', { w: 'w-24' })}</td>
      <td class="num" data-unit="${esc(envEd.granelPlu || '')}">${envEd.granelPlu ? plataEnv(g.costoUnit ?? null) + '<span class="pr-sub">por kg</span>' : '—'}</td>
      <td class="num" data-imp="${esc(envEd.granelPlu || '')}">${g.importe != null ? '$ ' + fmtMoney(g.importe) : '—'}</td><td></td></tr>
      ${envEd.componentes.map(htmlFilaEmpaqueEnv).join('')}</tbody>
    <tfoot><tr class="pr-total"><td colspan="4" class="text-left">Costo por unidad</td><td class="num" id="envTotal">${htmlTotalEnv()}</td><td></td></tr></tfoot></table>
    <div class="mt-3 flex items-center gap-2"><span class="text-sm text-gris">＋ Agregar empaque (envase, tapa, etiqueta…):</span>${htmlBuscadorSiga('envAgregar', 'Buscar PLU en SIGA…')}</div></section>`;
}
const htmlTotalEnv = () => (envCosto && envCosto.costoUnidad != null ? '$ ' + fmtMoney(envCosto.costoUnidad) : '—');
// Costo, vigente y sugerido (motor del esquema) o lo que falta para calcularlo.
function htmlPrecioEnv() {
  const falta = faltaObligatorioEnvasado(envEd);
  if (falta) return `<p class="text-sm text-gris">${esc(falta)}</p>`;
  if (!envCosto) return '<p class="text-sm text-gris"><span class="spin"></span> Calculando…</p>';
  if (envCosto.error) return `<p class="text-sm text-crit">${esc(envCosto.error)}</p>`;
  if ((envCosto.faltantes || []).length) {
    const nombres = Object.fromEntries((envCosto.componentes || []).map(c => [c.plu, c.nombre]));
    return `<p class="text-sm text-crit">Para calcular el costo falta: ${esc(envCosto.faltantes.map(k => textoFaltante(k, nombres)).join('; '))}</p>`;
  }
  const s = sugeridoProd(envCosto);
  const vig = envCosto.precioVigente;
  return `<div class="flex flex-wrap gap-x-8 gap-y-2 text-sm">
    <span>Costo <b class="tabular-nums">$ ${fmtMoney(envCosto.costoUnidad)}</b></span>
    <span>Vigente <b class="tabular-nums">${vig == null ? '—' : '$ ' + fmtPrecio(vig)}</b></span>
    <span>Sugerido minorista <b class="tabular-nums">${s ? '$ ' + fmtPrecio(s.precio) : '—'}</b>${s && s.deltaPct != null ? ` <span class="text-xs ${claseDelta(s.estado)}">${fmtPct(s.deltaPct)}</span>` : ''}</span></div>
    <p class="text-xs text-gris mt-1">La decisión (Aumentar / No cambiar) y los precios por canal se toman en el listado, clic en el nombre.</p>`;
}
function htmlPieEnv() {
  const falta = faltaObligatorioEnvasado(envEd);
  const puede = !falta && (envEd.sucio || !envEd.id);
  return `<div class="mt-4 flex items-center gap-3"><button id="envGuardar" class="${btnPrim}"${puede ? '' : ' disabled'}>${envEd.id ? 'Guardar cambios' : 'Crear producto'}</button>
    ${envEd.sucio ? chip('sin guardar', 'bg-amarillo/30 text-ink') : ''}</div>`;
}
function pintarEnvasado() {
  panelProd().innerHTML = htmlCabeceraEnv() + htmlRevisarEnv() + htmlVentaEnv() + htmlComposicionEnv()
    + `<section class="mt-4 rounded-xl border border-borde bg-card p-4"><h3 class="text-sm font-semibold text-ink mb-2">③ Precio</h3><div id="envPrecio">${htmlPrecioEnv()}</div></section>`
    + `<div id="envPie">${htmlPieEnv()}</div>` + (envEd.id && prodDet ? htmlMargenEspecialProd() : '');
  conectarEnvasado();
}
// Después de una vista previa: sólo costos, total, precio y pie (los inputs no se repintan: no pierden el foco).
function pintarCostosEnv() {
  panelProd().querySelectorAll('[data-unit]').forEach(td => {
    const l = lineaEnv(td.dataset.unit);
    td.innerHTML = td.dataset.unit ? plataEnv(l.costoUnit ?? null) + (td.dataset.unit === String(envEd.granelPlu) ? '<span class="pr-sub">por kg</span>' : '') : '—';
  });
  panelProd().querySelectorAll('[data-imp]').forEach(td => { const l = lineaEnv(td.dataset.imp); td.innerHTML = l.importe != null ? '$ ' + fmtMoney(l.importe) : '—'; });
  const t = document.getElementById('envTotal'); if (t) t.innerHTML = htmlTotalEnv();
  document.getElementById('envPrecio').innerHTML = htmlPrecioEnv();
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
function programarPreviewEnv() { clearTimeout(envTimer); envTimer = setTimeout(pedirPreviewEnv, ENV_PREVIEW_MS); }
async function pedirPreviewEnv() {
  if (faltaObligatorioEnvasado(envEd)) { document.getElementById('envPrecio').innerHTML = htmlPrecioEnv(); return; }
  const n = ++envSeq;
  try {
    const r = await pedirJson('POST', API_PROD + '/envasado/preview', bodyEnvasado(envEd));
    if (n === envSeq) envCosto = r;
  } catch (e) { if (n === envSeq) envCosto = { error: e.message }; }
  if (n === envSeq && document.getElementById('envPrecio')) pintarCostosEnv();
}
async function elegirPluVentaEnv({ plu, nombre }) {
  try {
    const pre = await getJson(API_PROD + '/envasado/precarga/' + encodeURIComponent(plu));
    envAviso = pre.mensaje || null;
    editarEnv({
      plu, nombre: envEd.nombre || pre.nombre || nombre, granelPlu: pre.granelPlu, granelNombre: pre.granelNombre, kgPorUnidad: pre.kgPorUnidad,
      componentes: pre.componentes.map(c => ({ plu: c.plu, nombre: c.nombre, cantidad: c.cantidad })),
    }, true);
  } catch (e) { avisar(e.message); }
}
function agregarEmpaqueEnv({ plu, nombre }) {
  if (String(plu) === String(envEd.granelPlu) || envEd.componentes.some(c => String(c.plu) === String(plu))) { avisar(`El PLU ${plu} ya está en la composición.`); return; }
  editarEnv({ componentes: [...envEd.componentes, { plu: String(plu), nombre, cantidad: 1 }] }, true);
}
function conectarEnvasado() {
  const inNombre = document.getElementById('envNombre');
  inNombre.addEventListener('input', () => editarEnv({ nombre: inNombre.value }));
  if (document.getElementById('envPlu')) conectarBuscadorSiga('envPlu', elegirPluVentaEnv);
  if (document.getElementById('envGranel')) conectarBuscadorSiga('envGranel', ({ plu, nombre }) => editarEnv({ granelPlu: String(plu), granelNombre: nombre }, true));
  if (document.getElementById('envAgregar')) conectarBuscadorSiga('envAgregar', agregarEmpaqueEnv);
  const cambiarPlu = document.getElementById('envCambiarPlu');
  if (cambiarPlu) cambiarPlu.onclick = () => { envEd = { ...envEd, plu: null }; envCosto = null; envAviso = null; pintarEnvasado(); };
  const cambiarGranel = document.getElementById('envCambiarGranel');
  if (cambiarGranel) cambiarGranel.onclick = () => editarEnv({ granelPlu: null, granelNombre: null }, true);
  const kg = document.getElementById('envKg');
  if (kg) kg.addEventListener('input', () => editarEnv({ kgPorUnidad: numOrNull(kg.value) }));
  panelProd().querySelectorAll('.env-cant').forEach(inp => inp.addEventListener('input', () => {
    const i = Number(inp.dataset.i);
    editarEnv({ componentes: envEd.componentes.map((c, j) => (j === i ? { ...c, cantidad: numOrNull(inp.value) } : c)) });
  }));
  panelProd().querySelectorAll('.env-quitar').forEach(b => b.onclick = () => {
    const i = Number(b.dataset.i);
    editarEnv({ componentes: envEd.componentes.filter((_, j) => j !== i) }, true);
  });
  const validar = document.getElementById('envValidar');
  if (validar) validar.onclick = e => (envEd.sucio ? avisar('Guardá los cambios antes de validar el costo.') : validarProd({ tipo: 'todo' }, e.currentTarget));
  const eliminar = document.getElementById('envEliminar');
  if (eliminar) eliminar.onclick = eliminarEnvasado;
  conectarPieEnv();
  if (envEd.id && prodDet) conectarMargenEspecialProd();
}
function conectarPieEnv() { document.getElementById('envGuardar').onclick = e => guardarEnvasado(e.currentTarget); }

// ── Guardar / eliminar ──────────────────────────────────────────────────────────
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
async function eliminarEnvasado() {
  if (!(await confirmar(`¿Eliminar "${envEd.nombre}"? No se puede deshacer.`, { textoOk: 'Eliminar' }))) return;
  try {
    await pedirJson('DELETE', urlProd(envEd.id));
    refrescarAlertasProduccion();
    location.hash = '#produccion/envasado';
  } catch (e) { avisar(e.message); }
}
