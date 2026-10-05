// ── Precios · configuración general, tolerancia, alinear con SIGA, listeners, tabs y arranque ──
// Script clásico (no módulo) cargado después de precios_almacen.js y precios_detalle.js; comparte sus
// globales. El arranque va en DOMContentLoaded, así ya están cargados precios_fraccionado.js,
// precios_produccion*.js, etc. Al final: dialogoAviso (reemplazo de alert/confirm).

// ── Config: tab Configuración (general + pack/bulto) y tab Costos (márgenes) ──
let configCargada = null;   // config completa tal como vino del server

async function leerConfig(){
  const j = await (await fetch('/api/precios/config')).json();
  if (j.error) throw new Error(j.error);
  configCargada = j;
  pintarPipeline(); // "Cómo se forma el precio" sigue a la config guardada
  return j;
}

// Tab Configuración: costo hora, tolerancia y Pack / Bulto.
async function cargarConfiguracion(){
  const carga = document.getElementById('configCarga');
  const form = document.getElementById('configForm');
  form.classList.add('hidden');
  carga.classList.remove('hidden');
  carga.innerHTML = '<span class="spin"></span> Cargando…';
  try {
    const j = await leerConfig();
    document.getElementById('inCostoHora').value = j.costoHora;
    document.getElementById('inTolerancia').value = j.toleranciaPct;
    limpiarSucio(form.closest('[data-guardable]'));
    carga.classList.add('hidden');
    form.classList.remove('hidden');
    cargarConfigPB(); // precios_pack_bulto.js
  } catch (e) {
    carga.innerHTML = `<p class="text-crit">No se pudo cargar: ${esc(e.message)}</p>`;
  }
}

// Tab Costos: resumen, variables y departamentos (= costo real). La llaman también los guardados de gastos y
// departamentos para redibujar con lo guardado. Las curvas viven en la tab Ganancia (precios_ganancia.js).
async function cargarCostos(){
  const carga = document.getElementById('costosCarga');
  carga.className = 'text-sm text-ink/50 py-4';
  carga.innerHTML = '<span class="spin"></span> Cargando…';
  try {
    const j = await leerConfig();
    carga.className = 'hidden';
    renderResumenCostos(j); // precios_costos.js
    renderConfigGastos(j); // precios_config_gastos.js
    renderDepartamentos(j); // precios_costos.js
    renderIvaVenta(j); // precios_costos.js
  } catch (e) {
    carga.className = 'text-sm py-4';
    carga.innerHTML = `<p class="text-crit">No se pudo cargar: ${esc(e.message)}</p>`;
  }
}

// Guarda config general (cualquier subconjunto de costoHora/toleranciaPct).
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
  msg.className = 'text-sm text-ink/50'; msg.innerHTML = '<span class="spin"></span> Guardando…';
  try {
    const j = await putConfigGeneral({
      costoHora: val('inCostoHora'), toleranciaPct: val('inTolerancia'),
    });
    configCargada = { ...configCargada, ...j };
    pintarPipeline(); // costo hora mueve el costo neto de Fraccionado (presentaciones con minutos propios)
    limpiarSucio(document.getElementById('configForm').closest('[data-guardable]'));
    ['fTolerancia', 'frTolerancia'].forEach(id => { document.getElementById(id).value = j.toleranciaPct; });
    fraccCargado = false; // el semáforo de Fraccionado depende de la tolerancia; su MO, de costoHora
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
  if (!(await confirmar('¿Alinear las ganancias con los precios vigentes de SIGA? Pisa las ganancias propias de esos productos.', { textoOk: 'Alinear' }))) return;
  const btn = document.getElementById('btnAlinearSiga');
  const msg = document.getElementById('alinearMsg');
  btn.disabled = true; msg.className = 'text-sm text-ink/50'; msg.innerHTML = '<span class="spin"></span> Alineando…';
  try {
    const j = await (await fetch('/api/precios/alinear-siga', { method: 'POST' })).json();
    if (j.error) throw new Error(j.error);
    msg.className = 'text-sm text-ok';
    msg.textContent = `${j.alineados} productos alineados · ${j.sinDatos} sin datos · ${j.negativos} con precio por debajo del costo`;
    cargarAlmacen();
    cargarFraccionado();
  } catch (e) {
    msg.className = 'text-sm text-crit'; msg.textContent = e.message;
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
  if (!(await confirmar('¿Desmarcar todos los productos marcados para actualizar (Reventa, Fraccionado y Producción)?', { textoOk: 'Desmarcar' }))) return;
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

// ── UI compartida de las tarjetas de Configuración ──────────────────────────────
// Input numérico con la unidad visible ($ adelante; %, min, g atrás). input = el <input> ya armado (sin bordes propios).
const campoU = (input, u, { pre = false, w = 'w-28' } = {}) =>
  `<span class="campo-u ${w}">${pre ? `<span class="u pre" aria-hidden="true">${u}</span>` : ''}${input}${pre ? '' : `<span class="u" aria-hidden="true">${u}</span>`}</span>`;

// Cambios sin guardar: editar dentro de un [data-guardable] lo marca (data-sucio) y el sub-tab muestra un punto. Las
// tarjetas que se re-dibujan al guardar quedan limpias solas; las que no, llaman a limpiarSucio.
const marcarSucio = el => { if (el) el.setAttribute('data-sucio', ''); };
const limpiarSucio = el => { if (el) el.removeAttribute('data-sucio'); };
// Punto en el sub-tab cuyo panel tiene algo sin guardar: se recalcula ante cualquier cambio del DOM de Configuración
// (marcar/limpiar o una tarjeta que se re-dibuja al guardar).
function pintarPuntosSucio(){
  document.querySelectorAll('#subtabsConfig .cfg-tab').forEach(t => {
    const panel = document.getElementById(t.getAttribute('aria-controls'));
    t.toggleAttribute('data-sucio', !!(panel && panel.querySelector('[data-guardable][data-sucio]')));
  });
}
const panelConfigActivo = () => document.querySelector('#panel-configuracion .cfg-panel:not(.hidden)');
// true si se puede salir del sub-tab visible: sin cambios, o el usuario acepta descartarlos.
async function puedeSalirConfig(){
  const panel = panelConfigActivo();
  const sucias = panel ? [...panel.querySelectorAll('[data-guardable][data-sucio]')] : [];
  if (!sucias.length) return true;
  const nombres = sucias.map(c => c.dataset.nombre || (c.querySelector('.cfg-h') || {}).textContent || 'una tarjeta').join(', ');
  if (!(await confirmar(`Hay cambios sin guardar en: ${nombres}.\n¿Salir igual? Se pierden.`, { textoOk: 'Salir sin guardar' }))) return false;
  sucias.forEach(limpiarSucio);
  return true;
}
const panelCfg = document.getElementById('panel-configuracion');
panelCfg.addEventListener('input', e => marcarSucio(e.target.closest('[data-guardable]')));
panelCfg.addEventListener('click', e => { if (e.target.closest('[data-edita]')) marcarSucio(e.target.closest('[data-guardable]')); });
new MutationObserver(pintarPuntosSucio).observe(panelCfg, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-sucio'] });
window.addEventListener('beforeunload', e => { if (panelCfg.querySelector('[data-guardable][data-sucio]')) e.preventDefault(); });

// ── Pipeline "Cómo se forma el precio" ──────────────────────────────────────────
// Un ejemplo por tipo con simularPrecio (precios_simulador.js) sobre la config cargada: las columnas de operación
// muestran el % guardado del tipo; las de resultado, el importe del ejemplo. Cada paso lleva a su sub-tab.
const PIPE_PASOS = [
  { k: 'neto', t: 'Costo neto', ir: 'simulador', title: 'Costo de compra sin IVA (Fraccionado: por kg, + mano de obra e insumos propios de cada presentación). Probalo en el Simulador.' },
  { k: 'costos', t: 'Costos', o: '÷ (1 − %)', c: 'c-costos', ir: 'costos', title: 'Variables sobre venta + departamentos del tipo' },
  { k: 'real', t: 'Costo real', ir: 'costos' },
  { k: 'ganancia', t: 'Ganancia', o: '× (1 + %)', c: 'c-ganancia', ir: 'ganancia', title: 'Curva del tipo para este costo + conceptos de ganancia' },
  { k: 'precioNeto', t: 'Precio neto', ir: 'ganancia' },
  { k: 'iva', t: 'IVA', o: '+ %', c: 'c-iva', ir: 'costos', title: 'IVA de venta (se edita en Costos)' },
  { k: 'final', t: 'Imp. s/ final', o: '÷ (1 − %)', c: 'c-final', ir: 'precioFinal', title: 'Conceptos sobre precio final' },
  { k: 'precio', t: 'Precio final', ir: 'precioFinal', title: 'Redondeado a $50' },
];
const PIPE_COSTO_DEFAULT = 1000;
let pipeCosto = PIPE_COSTO_DEFAULT;

function celdasPipe(r){
  const $ = v => esc('$ ' + fmtMoney(v)), d = r.d;
  return { neto: $(r.costoTotal), costos: esc(fmtPctGastos(r.gastosPct)), real: $(d.costoReal), ganancia: esc(fmtPctGastos(r.gananciaPct)),
    precioNeto: $(d.precioNeto), iva: esc(fmtPctGastos(d.ivaPct)), final: esc(fmtPctGastos(d.conceptosFinalPct)),
    precio: esc('$ ' + fmtPrecio(d.precioFinal)) };
}
function filaPipe(tipo, nombre){
  const r = simularPrecio(configCargada, { costo: pipeCosto, tipo }); // precios_simulador.js
  if (r.faltantes.length) {
    return `<tr><td class="pipe-tipo">${esc(nombre)}</td><td colspan="${PIPE_PASOS.length}" class="text-left text-crit">${esc(r.faltantes[0])}</td></tr>`;
  }
  const v = celdasPipe(r);
  return `<tr><td class="pipe-tipo">${esc(nombre)}</td>${PIPE_PASOS.map(p =>
    `<td class="${p.c ? 'op ' + p.c : p.k === 'precio' ? 'res-fin' : 'res'}">${v[p.k]}</td>`).join('')}</tr>`;
}
function pintarPipeline(){
  const cuerpo = document.getElementById('cfgPipeCuerpo');
  if (!cuerpo || !configCargada || typeof simularPrecio !== 'function') return;
  const sub = (document.querySelector('#subtabsConfig [aria-selected="true"]') || {}).dataset?.sub;
  const ths = PIPE_PASOS.map(p => `<th class="${p.c ? 'op ' + p.c : ''}"><button type="button" class="pipe-paso" data-ir="${p.ir}"
      ${p.ir === sub ? 'aria-current="step"' : ''} title="${esc(p.title || 'Ir a ' + p.t)}"><span class="o">${p.o || '&nbsp;'}</span><span class="t">${esc(p.t)}</span></button></th>`).join('');
  cuerpo.className = 'mt-3';
  cuerpo.innerHTML = `<table class="pipe"><thead><tr><th class="text-left align-bottom"><span class="text-xs text-gris font-normal">Tipo</span></th>${ths}</tr></thead>
    <tbody>${Object.entries(SIM_TIPOS).map(([t, n]) => filaPipe(t, n)).join('')}</tbody></table>
    <div class="flex items-center gap-2 mt-3 text-xs text-gris">
      <label for="pipeCosto">Ejemplo con costo neto de</label>
      ${campoU(`<input id="pipeCosto" type="number" min="0" step="any" inputmode="decimal" value="${esc(pipeCosto)}">`, '$', { pre: true, w: 'w-32' })}
      <span>· Fraccionado: por kg, presentación de 1 kg · la ganancia de la curva cambia con el costo.</span>
    </div>`;
}
// Botones/enlaces [data-ir] (pipeline, Simulador, IVA en Precio final): van al sub-tab, preguntando si hay cambios sin guardar.
async function irASubConfig(e){
  const b = e.target.closest('[data-ir]');
  if (b && (await puedeSalirConfig())) activarSubConfig(b.dataset.ir);
}
document.getElementById('cfgPipeCuerpo').addEventListener('click', irASubConfig);
document.getElementById('cfgPipeCuerpo').addEventListener('input', e => {
  if (e.target.id !== 'pipeCosto') return;
  const v = numOrNull(e.target.value);
  if (!(v > 0)) return;
  pipeCosto = v;
  document.querySelector('#cfgPipeCuerpo tbody').innerHTML = Object.entries(SIM_TIPOS).map(([t, n]) => filaPipe(t, n)).join('');
});

// Sub-tabs de Configuración (#subtabsConfig, role=tablist): cada uno muestra #panel-<sub> y llama a su carga. Orden del
// precio: Costos → Ganancia → Precio final → Simulador; aparte General y Máquinas. Entrar a Configuración vuelve al
// último sub-tab usado en la sesión (sessionStorage, si se puede); la primera vez, Costos.
const CARGA_SUBCONFIG = {
  costos: () => cargarCostos(),
  ganancia: () => cargarGanancia(), // precios_ganancia.js
  precioFinal: () => cargarPrecioFinal(), // precios_ganancia.js
  simulador: () => cargarSimulador(), // precios_simulador.js
  general: () => cargarConfiguracion(),
  maquinas: () => { cargarMaquinas(); if (!configCargada) leerConfig().catch(() => {}); }, // precios_maquinas.js; config = pipeline
};
const CLAVE_SUBCONFIG = 'precios.subConfig';
function ultimoSubConfig(){
  try { const s = sessionStorage.getItem(CLAVE_SUBCONFIG); return CARGA_SUBCONFIG[s] ? s : 'costos'; } catch { return 'costos'; }
}
function activarSubConfig(sub){
  document.querySelectorAll('#subtabsConfig .cfg-tab').forEach(x => {
    const on = x.dataset.sub === sub;
    x.setAttribute('aria-selected', String(on));
    x.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll('#panel-configuracion .cfg-panel').forEach(p => p.classList.toggle('hidden', p.id !== 'panel-' + sub));
  document.querySelectorAll('#cfgPipeCuerpo .pipe-paso').forEach(b => {
    if (b.dataset.ir === sub) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
  });
  try { sessionStorage.setItem(CLAVE_SUBCONFIG, sub); } catch { /* sin storage: queda Costos la próxima vez */ }
  CARGA_SUBCONFIG[sub]();
}
const tabsConfig = () => [...document.querySelectorAll('#subtabsConfig .cfg-tab')];
document.getElementById('subtabsConfig').addEventListener('click', async e => {
  const b = e.target.closest('.cfg-tab');
  if (!b || b.getAttribute('aria-selected') === 'true') return;
  if (await puedeSalirConfig()) activarSubConfig(b.dataset.sub);
});
// Teclado del tablist: ← → mueven el foco entre sub-tabs, Inicio/Fin al primero/último; Enter/Espacio activa (click).
document.getElementById('subtabsConfig').addEventListener('keydown', e => {
  const tabs = tabsConfig(), i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  const destino = { ArrowRight: (i + 1) % tabs.length, ArrowLeft: (i - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 }[e.key];
  if (destino === undefined) return;
  e.preventDefault();
  tabs[destino].focus();
});

// Cambio de tab. Producción la maneja el hash (precios_produccion.js llama a activarTab
// desde su ruteo); ir a otra tab saca el hash de Producción. 'costos' | 'ganancia' | 'maquinas' |
// 'general' abren Configuración en ese sub-tab; 'configuracion' sola, en el último usado.
function activarTab(tipo){
  const sub = CARGA_SUBCONFIG[tipo] ? tipo : null;
  if (sub) tipo = 'configuracion';
  const b = document.querySelector(`#tabs .navtab[data-tipo="${tipo}"]`);
  document.querySelectorAll('#tabs .navtab').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('main .tab-panel').forEach(p => p.classList.add('hidden'));
  const panel = document.getElementById('panel-' + tipo);
  if (panel) panel.classList.remove('hidden');
  if (tipo === 'configuracion') activarSubConfig(sub || ultimoSubConfig());
  if (tipo === 'almacen') { cargarToleranciaFiltro(); cargarAlmacen(); }
  if (tipo === 'fraccionado' && !fraccCargado) cargarFraccionado(); // precios_fraccionado.js
}
document.querySelectorAll('#tabs .navtab').forEach(b => b.onclick = async () => {
  // Salir de Configuración (o volver a entrar, que recarga el sub-tab) con cambios sin guardar pregunta primero.
  if (!document.getElementById('panel-configuracion').classList.contains('hidden') && !(await puedeSalirConfig())) return;
  if (b.dataset.tipo === 'produccion') { irAProduccion(''); return; } // precios_produccion.js
  salirDeProduccion(); // precios_produccion.js
  activarTab(b.dataset.tipo);
});

// Arranque después de precios_fraccionado.js (DOMContentLoaded corre cuando ya se ejecutaron los
// dos scripts): renderAlmacen usa presentacionesMarcadas() de ese archivo para la barra de marcados.
document.addEventListener('DOMContentLoaded', () => {
  cargarToleranciaFiltro();
  cargarAlmacen(); // Reventa (data-tipo almacen) es el tab activo por defecto al cargar la página.
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
