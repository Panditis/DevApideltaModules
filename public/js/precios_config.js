// ── Precios · configuración (sub-tabs), listeners de tabs y arranque; al final dialogoAviso ──
// Script clásico (no módulo) cargado después de precios_comun.js; comparte sus globales. El arranque va en
// DOMContentLoaded, así ya están cargados precios_produccion*.js, precios_listados.js, etc.

// Tab Configuración › General: sólo Pack / Bulto.
const cargarConfiguracion = () => cargarConfigPB(); // precios_pack_bulto.js

document.addEventListener('keydown', e => {
  if (e.key === 'Tab' && !document.getElementById('mDet').classList.contains('hidden')) atraparFocoModal(e);
  // Con el diálogo de aviso abierto, Escape lo cierra él solo (cancel nativo del <dialog>).
  if (e.key === 'Escape' && !document.getElementById('dlgAviso').open) cerrarDetalle();
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

// Botones/enlaces [data-ir] (Simulador): van al sub-tab, preguntando si hay cambios sin guardar.
async function irASubConfig(e){
  const b = e.target.closest('[data-ir]');
  if (b && (await puedeSalirConfig())) activarSubConfig(b.dataset.ir);
}

// Sub-tabs de Configuración (#subtabsConfig, role=tablist): cada uno muestra #panel-<sub> y llama a su carga. Orden del
// precio: Costos → Márgenes → Precio → Simulador; aparte General. Entrar a Configuración vuelve al último
// sub-tab usado en la sesión (sessionStorage); la primera vez (o si el guardado ya no existe, ej. 'ganancia'), Costos.
const CARGA_SUBCONFIG = {
  costos: () => cargarCostosEsq(),   // precios_config_esquema.js
  margenes: () => cargarMargenesEsq(), // precios_config_esquema.js
  precio: () => cargarPrecioEsq(),   // precios_config_esquema.js
  simulador: () => cargarSimulador(), // precios_simulador.js
  general: () => cargarConfiguracion(),
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
  // El switch Reventa | Fraccionado no aplica a General (pack/bulto). El aviso de Fraccionado: oculto en General y en Reventa;
  // en Fraccionado lo decide leerCfgEsq (precios_config_esquema.js) al cargar.
  document.getElementById('cfgTipo').classList.toggle('hidden', sub === 'general');
  if (sub === 'general' || !esFraccCfg()) document.getElementById('cfgFraccAviso').classList.add('hidden');
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
// desde su ruteo); ir a otra tab saca el hash de Producción. 'costos' | 'margenes' | 'precio' | 'simulador' | 'general'
// abren Configuración en ese sub-tab; 'configuracion' sola, en el último usado.
function activarTab(tipo){
  const sub = CARGA_SUBCONFIG[tipo] ? tipo : null;
  if (sub) tipo = 'configuracion';
  if (tipo === 'configuracion' && preciosSinConfig) tipo = 'almacen'; // sin el permiso no hay Configuración
  const b = document.querySelector(`#tabs .navtab[data-tipo="${tipo}"]`);
  document.querySelectorAll('#tabs .navtab').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('main .tab-panel').forEach(p => p.classList.add('hidden'));
  const panel = document.getElementById('panel-' + tipo);
  if (panel) panel.classList.remove('hidden');
  if (tipo === 'configuracion') activarSubConfig(sub || ultimoSubConfig());
  if (tipo === 'almacen' || tipo === 'fraccionado') cargarListado(tipo); // precios_listados.js
}
document.querySelectorAll('#tabs .navtab').forEach(b => b.onclick = async () => {
  // Salir de Configuración (o volver a entrar, que recarga el sub-tab) con cambios sin guardar pregunta primero.
  if (!document.getElementById('panel-configuracion').classList.contains('hidden') && !(await puedeSalirConfig())) return;
  if (b.dataset.tipo === 'produccion') { irAProduccion(''); return; } // precios_produccion.js
  salirDeProduccion(); // precios_produccion.js
  activarTab(b.dataset.tipo);
});

// Arranque: Reventa es el tab activo.
document.addEventListener('DOMContentLoaded', () => {
  cargarListado('almacen'); // precios_listados.js
  permisoConfigPrecios.then(aplicarPermisoConfig); // precios_comun.js
});

// Permiso de Configuración resuelto: body.con-config / body.sin-config muestran .solo-config / .solo-sin-config
// (precios.html). Sin él: la tolerancia es de sólo lectura (se cambia en Configuración) y los listados ya pintados se
// repintan con los rótulos de markup.
function aplicarPermisoConfig(puede){
  preciosSinConfig = !puede;
  document.body.classList.add(puede ? 'con-config' : 'sin-config');
  if (!puede && !document.getElementById('panel-configuracion').classList.contains('hidden')) activarTab('almacen');
}

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
