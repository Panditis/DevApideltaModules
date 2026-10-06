// ── Precios · helpers comunes + tab Almacén (listado, filtros, desplegable, marcados, exportación) ──
// Script clásico (no módulo): sus const/let/function top-level son globales compartidas con el resto
// de los precios*.js que carga precios.html (precios_detalle.js, precios_config.js, precios_fraccionado.js, ...).
// Se carga primero; no ejecuta nada al cargar salvo declarar (el arranque está en precios_config.js).

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const fmtMoney = n => n == null ? '—' : new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
// Precio sugerido: siempre múltiplo de 50 sin decimales (lo garantiza el backend).
const fmtPrecio = n => n == null ? '—' : new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 }).format(n);
const fmtPct = n => n == null ? '—' : (n > 0 ? '+' : '') + n.toFixed(1) + '%';
const pct1 = n => n == null ? '—' : +(+n).toFixed(1) + '%';

// Estado de la diferencia sugerido vs. SIGA (tokens ok/warn/crit). subir = el precio
// calculado supera al de SIGA más allá de la tolerancia: se está vendiendo por debajo de
// lo que corresponde. bajar = el calculado queda por debajo. ok = dentro de ±tolerancia.
const SEMAFORO_META = {
  ok:    { cls: 'bg-ok/15 text-ok',     txt: 'OK' },
  subir: { cls: 'bg-crit/15 text-crit', txt: 'Subir' },
  bajar: { cls: 'bg-warn/15 text-warn', txt: 'Bajar' },
};
// Color del número de diferencia: sólo se resalta fuera de tolerancia.
const DELTA_CLS = { subir: 'font-semibold text-crit', bajar: 'font-semibold text-warn' };
const claseDelta = sem => DELTA_CLS[sem] || 'text-gris';
function badgeSemaforo(sem){
  const m = SEMAFORO_META[sem];
  if (!m) return '<span class="text-ink/40 text-xs">—</span>';
  return `<span class="px-2 py-0.5 rounded-full text-xs font-semibold ${m.cls}">${m.txt}</span>`;
}

// ── Permiso de Configuración (ref precios-config) ──────────────────────────────
// GET /api/precios/config/publica dice si el usuario lo tiene (puedeConfig). Sin él (o si no se pudo saber) el server
// responde 403 a las rutas de configuración y calcula con la vista sin estructura: "ganancia" = markup s/ costo neto,
// gastos 0. La config que leen los modales sale de fetchConfigPrecios (la completa o la pública). La UI la ajusta
// aplicarPermisoConfig (precios_config.js); la seguridad es la del server.
let preciosSinConfig = false;
const permisoConfigPrecios = fetch('/api/precios/config/publica').then(r => r.json())
  .then(j => j && j.puedeConfig === true).catch(() => false);
const fetchConfigPrecios = async () => fetch((await permisoConfigPrecios) ? '/api/precios/config' : '/api/precios/config/publica');
// Texto según el permiso: (con Configuración, sin ella). Para lo que se arma al abrir un modal (permiso ya resuelto).
const segunPermiso = (con, sin) => (preciosSinConfig ? sin : con);

const BADGE_INGRESO_HOY = '<span class="px-2 py-0.5 rounded-full text-xs font-semibold bg-ok/15 text-ok">Ingreso hoy</span>';

// ── Almacén: listado ─────────────────────────────────────────────────────────
let almacenData = [];

async function cargarAlmacen(){
  const tbody = document.getElementById('cuerpoAlmacen');
  tbody.innerHTML = '<tr><td colspan="12" class="p-10 text-center text-ink/50"><span class="spin"></span> Cargando…</td></tr>';
  try {
    const r = await fetch('/api/precios/listado?tipo=almacen');
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    almacenData = j;
    document.getElementById('almacenMeta').textContent = `${j.length} productos`;
    podarSeleccion();
    renderAlmacen();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="12" class="p-8 text-center text-crit">No se pudo cargar: ${esc(e.message)}</td></tr>`;
  }
}

// ── Almacén: filtros (client-side sobre almacenData) ─────────────────────────
const SIN_PROVEEDOR = '__sin__';
const normTxt = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const tieneFaltantes = f => Array.isArray(f.faltantes) && f.faltantes.length > 0;

// Selección vacía = sin filtro (todos). Con algo marcado, se muestran sólo esos.
const filtroSel = { proveedor: new Set(), estado: new Set() };
let soloIngresoHoy = false;
let soloMarcados = false;

const ESTADO_OPCIONES = [
  ['ok', 'OK'], ['subir', 'Subir precio'], ['bajar', 'Bajar precio'],
  ['sinPrecio', 'Sin precio'], ['sinVigente', 'Sin precio vigente'],
];
const proveedorDe = f => f.proveedor || SIN_PROVEEDOR;
const estadoDe = f => tieneFaltantes(f) ? 'sinPrecio' : f.precioVigente == null ? 'sinVigente' : f.semaforo;
const valorDe = { proveedor: proveedorDe, estado: estadoDe };

// Opciones [valor, texto, cantidad] del desplegable, contadas sobre todo el listado.
function opcionesFiltro(tipo, datos = almacenData, valores = valorDe){
  const cuenta = new Map();
  for (const f of datos) { const v = valores[tipo](f); cuenta.set(v, (cuenta.get(v) || 0) + 1); }
  if (tipo === 'estado') return ESTADO_OPCIONES.map(([v, t]) => [v, t, cuenta.get(v) || 0]);
  const nombres = [...cuenta.keys()].filter(v => v !== SIN_PROVEEDOR).sort((a, b) => a.localeCompare(b, 'es'));
  const ops = nombres.map(n => [n, n, cuenta.get(n)]);
  return cuenta.has(SIN_PROVEEDOR) ? [[SIN_PROVEEDOR, 'Sin proveedor', cuenta.get(SIN_PROVEEDOR)], ...ops] : ops;
}

// Descarta selecciones que ya no existen tras recargar (ej. proveedor sin productos).
function podarSeleccion(){
  const vigentes = new Set(opcionesFiltro('proveedor').map(o => o[0]));
  for (const v of [...filtroSel.proveedor]) if (!vigentes.has(v)) filtroSel.proveedor.delete(v);
  actualizarBotonesFiltro();
}

// Pinta los botones de filtro de un panel: contador de proveedor/estado + toggles [id, on].
function pintarBotonesFiltro(panelId, sel, toggles){
  for (const tipo of ['proveedor', 'estado']) {
    const btn = document.querySelector(`#${panelId} .fbtn[data-filtro="${tipo}"]`);
    const n = sel[tipo].size;
    btn.classList.toggle('on', n > 0);
    btn.querySelector('.fbtn-n').textContent = n ? String(n) : '';
  }
  for (const [id, on] of toggles) {
    const b = document.getElementById(id);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
}
function actualizarBotonesFiltro(){
  pintarBotonesFiltro('panel-almacen', filtroSel, [['fIngresoHoy', soloIngresoHoy], ['fSoloMarcados', soloMarcados], ['fConPB', soloConPB]]);
}

// ── Desplegable de filtro con buscador (uno solo, se reusa para proveedor y estado) ──
// Contexto por tab: { sel, opciones(tipo), aplicar() }. Fraccionado registra dropCtxs.fracc.
const dropCtxs = {
  almacen: { sel: filtroSel, opciones: tipo => opcionesFiltro(tipo), aplicar: () => { actualizarBotonesFiltro(); renderAlmacen(); } },
};
let dropTipo = null;
let dropCtx = dropCtxs.almacen;
function abrirDrop(tipo, btn, ctx = dropCtxs.almacen){
  const drop = document.getElementById('fDrop');
  if (!drop.classList.contains('hidden') && dropTipo === tipo && dropCtx === ctx) { cerrarDrop(); return; }
  dropTipo = tipo;
  dropCtx = ctx;
  const buscar = document.getElementById('fDropBuscar');
  buscar.value = '';
  buscar.placeholder = tipo === 'proveedor' ? 'Buscar proveedor…' : 'Buscar estado…';
  renderDropLista();
  drop.classList.remove('hidden');
  const r = btn.getBoundingClientRect();
  drop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - drop.offsetWidth - 8)) + 'px';
  drop.style.top = (r.bottom + 4) + 'px';
  setTimeout(() => buscar.focus(), 0);
}
function cerrarDrop(){ document.getElementById('fDrop').classList.add('hidden'); dropTipo = null; }

function opcionesVisibles(){
  const q = normTxt(document.getElementById('fDropBuscar').value.trim());
  return dropCtx.opciones(dropTipo).filter(([, t]) => !q || normTxt(t).includes(q));
}
function renderDropLista(){
  const sel = dropCtx.sel[dropTipo];
  const ops = opcionesVisibles();
  const lista = document.getElementById('fDropLista');
  lista.innerHTML = ops.length
    ? ops.map(([v, t, n]) => `<label class="fopt"><input type="checkbox" data-v="${esc(v)}" ${sel.has(v) ? 'checked' : ''}><span>${esc(t)}</span><b>${n}</b></label>`).join('')
    : '<div class="px-3 py-4 text-sm text-gris text-center">Sin resultados</div>';
  lista.querySelectorAll('input[data-v]').forEach(cb => cb.onchange = () => {
    if (cb.checked) sel.add(cb.dataset.v); else sel.delete(cb.dataset.v);
    dropCtx.aplicar();
  });
}

function filtrarAlmacen(){
  const q = normTxt(document.getElementById('fBuscar').value.trim());
  const { proveedor, estado } = filtroSel;
  return almacenData.filter(f => {
    if (q && !String(f.plu).includes(q) && !normTxt(f.nombre).includes(q)) return false;
    if (proveedor.size && !proveedor.has(proveedorDe(f))) return false;
    if (estado.size && !estado.has(estadoDe(f))) return false;
    if (soloIngresoHoy && !f.ingresoHoy) return false;
    if (soloMarcados && !f.marcado) return false;
    if (soloConPB && !conPB(f)) return false; // precios_pack_bulto.js
    return true;
  });
}

function renderAlmacen(){
  const tbody = document.getElementById('cuerpoAlmacen');
  actualizarBarraMarcados();
  const chkTodos = document.getElementById('chkTodos');
  chkTodos.checked = false; chkTodos.indeterminate = false;
  if (!almacenData.length) {
    document.getElementById('almacenConteo').textContent = '';
    tbody.innerHTML = '<tr><td colspan="12" class="p-10 text-center text-ink/50">Sin productos</td></tr>';
    return;
  }
  const filas = ordenarAlmacen(filtrarAlmacen()); // precios_orden.js: orden por header sobre lo filtrado
  document.getElementById('almacenConteo').textContent = `${filas.length} de ${almacenData.length} productos`;
  if (!filas.length) {
    tbody.innerHTML = '<tr><td colspan="12" class="p-10 text-center text-ink/50">Ningún producto coincide con los filtros</td></tr>';
    return;
  }
  const marcables = filas.filter(f => !tieneFaltantes(f));
  const nMarc = marcables.filter(f => f.marcado).length;
  chkTodos.checked = marcables.length > 0 && nMarc === marcables.length;
  chkTodos.indeterminate = nMarc > 0 && nMarc < marcables.length;
  const tol = Number(document.getElementById('fTolerancia').value) || 0; // toleranciaPct global
  tbody.innerHTML = filas.map(f => {
    const sinPrecio = tieneFaltantes(f);
    const filaCls = (sinPrecio ? 'opacity-50' : 'hover:bg-verde/5') + (f.marcado ? ' bg-amarillo/10' : '');
    const tooltip = sinPrecio ? ` title="Sin precio: falta ${esc(f.faltantes.join(', '))}"` : '';
    // Ganancia % (s/ costo real: curva + conceptos, o la propia) · markup final % (precio final con IVA ÷ costo
    // neto − 1); curva y markup total (s/ neto) van en el title.
    const gyf = `${pct1(f.gananciaPct)} · <span class="text-gris">${pct1(f.markupFinalPct)}</span>`;
    // Sin el permiso de Configuración gananciaPct ya es el markup s/ neto (vista sin estructura del server).
    const tipMk = segunPermiso(`ganancia s/ costo real · markup s/ neto ${pct1(f.markupPct)}`, 'markup s/ costo neto') + ` · IVA ${f.ivaPct ?? '—'} %`;
    const banda = f.gananciaOverride != null
      ? `<span class="px-1.5 py-0.5 rounded text-xs font-semibold bg-amarillo/30 text-ink" title="${segunPermiso('Ganancia propia', 'Markup propio')} del producto (standard: ${pct1(f.gananciaBanda)})">propio</span> <span title="${esc(tipMk)}">${gyf}</span>`
      : f.banda ? `<span title="${esc(segunPermiso(`curva ${pct1(f.gananciaCurva)} + conceptos · `, 'standard · ') + tipMk)}">${gyf}</span>` : '—';
    const tipCompra = `Proveedor: ${f.proveedor || '—'} · Última compra: ${f.fechaUltimaCompra || '—'}`;
    const badgeHoy = f.ingresoHoy ? ' ' + BADGE_INGRESO_HOY : '';
    const hayExtras = (f.costosExtra || []).length > 0 && f.costoTotal != null;
    const tipCosto = hayExtras ? tipCostoExtras(f, '$') : '';
    return `<tr class="border-t border-borde cursor-pointer ${filaCls}" data-plu="${esc(f.plu)}"${tooltip}>
      <td class="p-2 text-center"><input type="checkbox" class="chk-marca accent-verde" data-plu="${esc(f.plu)}"${f.marcado ? ' checked' : ''}${sinPrecio ? ' disabled title="Sin precio sugerido"' : ''}></td>
      <td class="p-2">${esc(f.plu)}</td>
      <td class="p-2" title="${esc(tipCompra)}">${esc(f.nombre)}${badgeHoy}</td>
      <td class="p-2 text-right whitespace-nowrap"${tipCosto ? ` title="${esc(tipCosto)}"` : ''}>${chipFuenteCosto(f.costoFuente)}${fmtMoney(f.costoTotal)}${hayExtras ? ' <span class="text-[10px] text-gris">+extras</span>' : ''}</td>
      <td class="p-2 text-right whitespace-nowrap tabular-nums solo-config" title="Costo real = costo neto ÷ (1 − gastos variables − departamentos)">${fmtMoney(f.costoReal)}</td>
      ${htmlCeldaCostoSistema(f)}${htmlCeldaUltimaCompra(f, tol)}
      <td class="p-2 text-center whitespace-nowrap">${banda}</td>
      <td class="p-2 text-right">${fmtMoney(f.precioVigente)}</td>
      ${htmlFechaPrecio(f.fechaPrecio)}
      <td class="p-2 text-right ${claseDelta(f.semaforo)}">${fmtPct(f.deltaPct)}</td>
      <td class="p-2 text-center">${badgeSemaforo(f.semaforo)}</td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('tr[data-plu]').forEach(tr => tr.onclick = () => abrirDetalle(tr.dataset.plu));
  tbody.querySelectorAll('.chk-marca').forEach(cb => {
    // La celda entera frena el clic para no abrir el modal (el checkbox deshabilitado no dispara eventos).
    cb.parentElement.onclick = e => e.stopPropagation();
    cb.onchange = () => marcarPlus([cb.dataset.plu], cb.checked).catch(err => { avisar(err.message); renderAlmacen(); });
  });
}

// ── Almacén: marcados para actualizar en SIGA ───────────────────────────────
// Se guardan en el server (costeo.json → marcadosExportar), compartidos entre PCs.
function aplicarMarcadosLocal(marcados){
  const set = new Set(marcados);
  almacenData = almacenData.map(f => ({ ...f, marcado: set.has(f.plu), packBulto: aplicarMarcadosPB(f.packBulto, set) }));
  aplicarMarcadosFracc(set); // precios_fraccionado.js
  aplicarMarcadosDetPB(set); // precios_pack_bulto.js: sub-filas del modal abierto
  aplicarMarcadosProdLocal(set); // precios_produccion_export.js
}
function renderListados(){
  renderAlmacen();
  if (fraccCargado) renderFraccionado(); // precios_fraccionado.js
  renderMarcasProd(); // precios_produccion_export.js
}
async function marcarPlus(plus, marcado){
  const r = await fetch('/api/precios/marcados', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plus, marcado }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  aplicarMarcadosLocal(j.marcados);
  renderListados();
  return j;
}
// Barra compartida por los tabs (misma cuenta: Almacén + Fraccionado + pack/bulto + Producción, un PLU una vez).
function actualizarBarraMarcados(){
  const n = filasMarcadasTodas().length; // precios_produccion_export.js
  document.querySelectorAll('.js-marc-conteo').forEach(el => { el.textContent = `Marcados: ${n}`; });
  document.querySelectorAll('.js-marc-exportar').forEach(btn => { btn.textContent = `Exportar marcados (${n})`; btn.disabled = n === 0; });
  document.querySelectorAll('.js-marc-desmarcar').forEach(btn => { btn.disabled = n === 0; });
}

// FORMATO DE EXPORTACIÓN para importar en SIGA: encabezados en la fila 4 (A-D: Codigo,
// Nombre, Costo, Venta) y productos desde la fila 5. Costo = costo total sobre el que se calcula el precio
// (Almacén: base elegido + costos extra del producto; Fraccionado, por cada presentación marcada: costo $/kg;
// Producción: costo total por unidad de la presentación) CON IVA (× (1 + alícuota), 21 si no viene), porque
// PrecioCosto de SIGA se guarda con IVA y Precios lo vuelve a leer ÷ (1 + alícuota). Venta = precio final (/kg en Fraccionado).
const HOJA_EXPORTACION = 'Precios';
const FILA_ENCABEZADOS = 4;
const costoConIvaExport = f => (f.costoTotal == null ? null : Math.round(f.costoTotal * (1 + (f.ivaPct ?? 21) / 100) * 100) / 100);
function filasExportacion(productos){
  return [
    ['Codigo', 'Nombre', 'Costo', 'Venta'],
    ...productos.map(f => [f.plu, f.nombre, costoConIvaExport(f), f.precioConIva]),
  ];
}

// Exporta TODOS los marcados (no sólo los visibles) de los tabs, con los valores calculados actuales.
async function exportarMarcados(){
  if (!fraccCargado) await cargarFraccionado(); // precios_fraccionado.js
  if (!(await refrescarExportProd())) return; // precios_produccion_export.js: costos de Producción al día
  // Pack/bulto marcados: Costo = costo total de su producto normal, Venta = su precio sugerido.
  const marcados = filasMarcadasTodas();
  const validos = marcados.filter(f => !tieneFaltantes(f) && f.precioConIva != null);
  const omitidos = marcados.length - validos.length;
  if (!validos.length) { avisar('Ningún producto marcado tiene precio sugerido para exportar.'); return; }
  if (omitidos) avisar(`${omitidos} producto(s) marcado(s) sin precio sugerido quedaron fuera del archivo.`);
  const ws = XLSX.utils.aoa_to_sheet([]);
  XLSX.utils.sheet_add_aoa(ws, filasExportacion(validos), { origin: `A${FILA_ENCABEZADOS}` });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, HOJA_EXPORTACION);
  const d = new Date();
  const fecha = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  // SIGA importa Excel 97-2003 (.xls, BIFF8), no .xlsx.
  XLSX.writeFile(wb, `precios_actualizar_${fecha}.xls`, { bookType: 'biff8' });
}
