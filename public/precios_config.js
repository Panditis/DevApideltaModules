// ── Precios · configuración general, tolerancia, alinear con SIGA, listeners, tabs y arranque ──
// Script clásico (no módulo) cargado después de precios_almacen.js y precios_detalle.js; comparte sus
// globales. El arranque va en DOMContentLoaded, así ya están cargados precios_fraccionado.js,
// precios_produccion*.js, etc. Al final: dialogoAviso (reemplazo de alert/confirm).

// ── Configuración general (las bandas de markup: precios_config_bandas.js) ──
let configCargada = null;   // config completa tal como vino del server

async function cargarConfiguracion(){
  const carga = document.getElementById('configCarga');
  const form = document.getElementById('configForm');
  form.classList.add('hidden');
  carga.classList.remove('hidden');
  carga.innerHTML = '<span class="spin"></span> Cargando…';
  try {
    const r = await fetch('/api/precios/config');
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    configCargada = j;
    document.getElementById('inCostoHora').value = j.costoHora;
    document.getElementById('inTolerancia').value = j.toleranciaPct;
    document.getElementById('inCostosVariosAlmacen').value = j.costosVariosPctAlmacen;
    carga.classList.add('hidden');
    form.classList.remove('hidden');

    renderConfigBandas(j); // precios_config_bandas.js
    renderConfigFraccionado(j); // precios_config_fraccionado.js
    cargarConfigPB(); // precios_pack_bulto.js
  } catch (e) {
    carga.innerHTML = `<p class="text-crit">No se pudo cargar: ${esc(e.message)}</p>`;
    errorConfigBandas(e.message); // precios_config_bandas.js
  }
}

// Guarda config general (cualquier subconjunto de costoHora/toleranciaPct/costosVariosPctAlmacen).
async function putConfigGeneral(body){
  const r = await fetch('/api/precios/config/general', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j;
}

async function guardarGeneral(){
  const msg = document.getElementById('generalMsg');
  const val = id => numOrNull(document.getElementById(id).value);
  msg.className = 'text-sm text-ink/50'; msg.textContent = 'Guardando…';
  try {
    const j = await putConfigGeneral({
      costoHora: val('inCostoHora'), toleranciaPct: val('inTolerancia'), costosVariosPctAlmacen: val('inCostosVariosAlmacen'),
    });
    configCargada = { ...configCargada, ...j };
    ['fTolerancia', 'frTolerancia'].forEach(id => { document.getElementById(id).value = j.toleranciaPct; });
    fraccCargado = false; // el semáforo de Fraccionado depende de la tolerancia
    refrescarAlertasProduccion(); // precios_produccion.js: costoHora y tolerancia mueven los costos/alertas de Producción
    msg.className = 'text-sm text-ok'; msg.textContent = 'Guardado.';
  } catch (e) {
    msg.className = 'text-sm text-crit'; msg.textContent = e.message;
  }
}

// Tolerancia en la barra de filtros de Almacén: se lee de la config y al cambiarla se guarda
// y se recarga el listado (el estado ok/subir/bajar lo calcula el server con esa tolerancia).
async function cargarToleranciaFiltro(){
  try {
    const j = await (await fetch('/api/precios/config')).json();
    if (!j.error) ['fTolerancia', 'frTolerancia'].forEach(id => { document.getElementById(id).value = j.toleranciaPct; });
    if (!j.error && almacenData.length) renderAlmacen(); // la columna "Costo última compra" usa la tolerancia
  } catch { /* sin config: el input queda vacío, el listado igual carga */ }
}
['fTolerancia', 'frTolerancia'].forEach(id => document.getElementById(id).addEventListener('change', async e => {
  const input = e.target;
  try {
    const j = await putConfigGeneral({ toleranciaPct: numOrNull(input.value) });
    input.classList.remove('border-crit'); input.title = '';
    ['fTolerancia', 'frTolerancia'].forEach(x => { document.getElementById(x).value = j.toleranciaPct; });
    cargarAlmacen();
    cargarFraccionado(); // precios_fraccionado.js
    refrescarAlertasProduccion(); // precios_produccion.js: la tolerancia decide qué cambio alerta
  } catch (err) {
    input.classList.add('border-crit'); input.title = err.message;
  }
}));
document.getElementById('btnGuardarGeneral').onclick = guardarGeneral;

async function alinearConSiga(){
  if (!(await confirmar('¿Alinear los markups con los precios vigentes de SIGA? Pisa los markups propios de esos productos.', { textoOk: 'Alinear' }))) return;
  const btn = document.getElementById('btnAlinearSiga');
  const msg = document.getElementById('alinearMsg');
  btn.disabled = true; msg.className = 'text-sm mt-2 text-ink/50'; msg.innerHTML = '<span class="spin"></span> Alineando…';
  try {
    const j = await (await fetch('/api/precios/alinear-siga', { method: 'POST' })).json();
    if (j.error) throw new Error(j.error);
    msg.className = 'text-sm mt-2 text-ok';
    msg.textContent = `${j.alineados} productos alineados · ${j.sinDatos} sin datos · ${j.negativos} con precio por debajo del costo`;
    cargarAlmacen();
    cargarFraccionado();
  } catch (e) {
    msg.className = 'text-sm mt-2 text-crit'; msg.textContent = e.message;
  } finally { btn.disabled = false; }
}
document.getElementById('btnAlinearSiga').onclick = alinearConSiga;

document.getElementById('btnRecargarAlmacen').onclick = cargarAlmacen;
document.getElementById('fBuscar').addEventListener('input', renderAlmacen);
document.querySelectorAll('.fbtn[data-filtro]').forEach(b =>
  b.onclick = e => { e.stopPropagation(); abrirDrop(b.dataset.filtro, b, dropCtxs[b.dataset.ctx || 'almacen']); });
document.getElementById('fIngresoHoy').onclick = () => {
  soloIngresoHoy = !soloIngresoHoy; actualizarBotonesFiltro(); renderAlmacen();
};
document.getElementById('fSoloMarcados').onclick = () => {
  soloMarcados = !soloMarcados; actualizarBotonesFiltro(); renderAlmacen();
};
document.getElementById('chkTodos').onchange = async e => {
  // Sólo los productos visibles: pack/bulto se marcan desde el detalle.
  const plus = filtrarAlmacen().filter(f => !tieneFaltantes(f)).map(f => f.plu);
  if (!plus.length) { renderAlmacen(); return; }
  try { await marcarPlus(plus, e.target.checked); } catch (err) { avisar(err.message); renderAlmacen(); }
};
document.querySelectorAll('.js-marc-exportar').forEach(b => { b.onclick = exportarMarcados; });
document.querySelectorAll('.js-marc-desmarcar').forEach(b => b.onclick = async () => {
  if (!(await confirmar('¿Desmarcar todos los productos marcados para actualizar (Almacén, Fraccionado y Producción)?', { textoOk: 'Desmarcar' }))) return;
  try {
    const j = await (await fetch('/api/precios/marcados', { method: 'DELETE' })).json();
    if (j.error) throw new Error(j.error);
    aplicarMarcadosLocal(j.marcados); renderListados();
  } catch (err) { avisar(err.message); }
});
document.getElementById('fLimpiar').onclick = () => {
  filtroSel.proveedor.clear(); filtroSel.estado.clear(); soloIngresoHoy = false; soloMarcados = false; soloConPB = false;
  document.getElementById('fBuscar').value = '';
  cerrarDrop(); actualizarBotonesFiltro(); renderAlmacen();
};
document.getElementById('fDropBuscar').addEventListener('input', renderDropLista);
document.getElementById('fDropTodos').onclick = () => {
  opcionesVisibles().forEach(([v]) => dropCtx.sel[dropTipo].add(v));
  renderDropLista(); dropCtx.aplicar();
};
document.getElementById('fDropLimpiar').onclick = () => {
  dropCtx.sel[dropTipo].clear();
  renderDropLista(); dropCtx.aplicar();
};
document.addEventListener('click', e => {
  const drop = document.getElementById('fDrop');
  if (!drop.classList.contains('hidden') && !drop.contains(e.target) && !e.target.closest('.fbtn[data-filtro]')) cerrarDrop();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Tab' && !document.getElementById('mDet').classList.contains('hidden')) atraparFocoModal(e);
  // Con el diálogo de aviso abierto, Escape lo cierra él solo (cancel nativo del <dialog>).
  if (e.key !== 'Escape' || document.getElementById('dlgAviso').open) return;
  if (!document.getElementById('fDrop').classList.contains('hidden')) cerrarDrop(); else cerrarDetalle();
});

// Cambio de tab. Producción la maneja el hash (precios_produccion.js llama a activarTab
// desde su ruteo); ir a otra tab saca el hash de Producción.
function activarTab(tipo){
  const b = document.querySelector(`#tabs .navtab[data-tipo="${tipo}"]`);
  document.querySelectorAll('#tabs .navtab').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('main .tab-panel').forEach(p => p.classList.add('hidden'));
  const panel = document.getElementById('panel-' + tipo);
  if (panel) panel.classList.remove('hidden');
  if (tipo === 'configuracion') cargarConfiguracion();
  if (tipo === 'maquinas') cargarMaquinas(); // precios_maquinas.js
  if (tipo === 'almacen') { cargarToleranciaFiltro(); cargarAlmacen(); }
  if (tipo === 'fraccionado' && !fraccCargado) cargarFraccionado(); // precios_fraccionado.js
}
document.querySelectorAll('#tabs .navtab').forEach(b => b.onclick = () => {
  if (b.dataset.tipo === 'produccion') { irAProduccion(''); return; } // precios_produccion.js
  salirDeProduccion(); // precios_produccion.js
  activarTab(b.dataset.tipo);
});

// Arranque después de precios_fraccionado.js (DOMContentLoaded corre cuando ya se ejecutaron los
// dos scripts): renderAlmacen usa presentacionesMarcadas() de ese archivo para la barra de marcados.
document.addEventListener('DOMContentLoaded', () => {
  cargarToleranciaFiltro();
  cargarAlmacen(); // Almacén es el tab activo por defecto al cargar la página.
});

// Reemplazo de alert()/confirm() nativos: <dialog> modal del theme. showModal() lo pone en el top
// layer, así que queda encima de #mDet; Escape o Cancelar = false. Devuelve Promise<boolean>.
function dialogoAviso(msg, { cancelar = false, textoOk = 'Aceptar' } = {}){
  const d = document.getElementById('dlgAviso');
  document.getElementById('dlgAvisoMsg').textContent = msg;
  document.getElementById('dlgAvisoOk').textContent = textoOk;
  document.getElementById('dlgAvisoCancelar').classList.toggle('hidden', !cancelar);
  d.returnValue = '';
  d.showModal();
  document.getElementById('dlgAvisoOk').focus();
  return new Promise(res => d.addEventListener('close', () => res(d.returnValue === 'ok'), { once: true }));
}
const avisar = msg => dialogoAviso(msg);
const confirmar = (msg, opts) => dialogoAviso(msg, { ...opts, cancelar: true });
