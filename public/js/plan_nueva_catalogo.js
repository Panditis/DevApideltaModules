'use strict';
// Planificación nueva › Catálogo: categorías con sus presentaciones (PLU de SIGA). Busca con GET /api/siga/buscar
// (el mismo endpoint que usa /planificacion) y permite elegir varios resultados a la vez.

const CAT_BUSCAR_DEBOUNCE_MS = 300;
let catalogoActual = [];   // [{ id, nombre, plus, creado, presentaciones: [{ plu, nombre }] }]
let catEdicion = null;        // { id|null, presentaciones: [{ plu, nombre }] } mientras el diálogo está abierto
let catResultadosSiga = [];   // última respuesta del buscador: [{ plu, producto, rubro }]
let catBuscarTimer = null;
let catBuscarSeq = 0;

async function cargarCatalogo() {
  catalogoActual = (await api('GET', '/api/plan-nueva/catalogo')).categorias;
  pintarCatalogo();
}
TABS.catalogo = { cargar: cargarCatalogo };

function pintarCatalogo() {
  const caja = document.getElementById('catalogo');
  if (!catalogoActual.length) {
    caja.innerHTML = '<p class="text-gris">Todavía no hay categorías. Creá la primera con “+ Categoría”.</p>';
    return;
  }
  const ordenadas = [...catalogoActual].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  caja.innerHTML = `<div class="bg-card rounded-xl border border-borde shadow-fluent overflow-hidden"><table class="w-full text-sm">
    <thead><tr class="bg-verde/5 text-verde"><th class="text-left p-2 w-56">Categoría</th><th class="text-left p-2">Presentaciones</th><th class="p-2 w-40"></th></tr></thead>
    <tbody>${ordenadas.map(c => `<tr class="border-t border-borde align-top">
      <td class="p-2 font-medium">${esc(c.nombre)} <span class="text-xs text-gris">(${c.presentaciones.length})</span></td>
      <td class="p-2">${c.presentaciones.map(p => `<span class="inline-block mr-1 mb-1 px-2 py-0.5 rounded bg-bg text-xs"><b class="tabular-nums">${esc(p.plu)}</b> · ${esc(p.nombre)}</span>`).join('') || '<span class="text-gris">Sin presentaciones</span>'}</td>
      <td class="p-2 text-right whitespace-nowrap">
        <button type="button" data-editar="${esc(c.id)}" class="px-2 py-1 rounded border border-borde text-xs hover:bg-bg">Editar</button>
        <button type="button" data-borrar="${esc(c.id)}" class="px-2 py-1 rounded border border-borde text-xs text-crit hover:bg-bg">Borrar</button>
      </td></tr>`).join('')}</tbody></table></div>`;
}

// El toast queda detrás del <dialog> modal: los errores de guardado y de búsqueda se muestran dentro de él.
function catMostrarError(mensaje) {
  const el = document.getElementById('catError');
  el.textContent = mensaje;
  el.classList.toggle('hidden', !mensaje);
}

function abrirCategoria(id = null) {
  const c = catalogoActual.find(x => x.id === id);
  catEdicion = { id: c ? c.id : null, presentaciones: c ? [...c.presentaciones] : [] };
  document.getElementById('dlgCatTitulo').textContent = c ? `Editar “${c.nombre}”` : 'Nueva categoría';
  document.getElementById('catNombre').value = c ? c.nombre : '';
  document.getElementById('catBuscar').value = '';
  catCerrarResultados();
  catMostrarError('');
  catPintarPresentaciones();
  document.getElementById('dlgCategoria').showModal();
  document.getElementById('catNombre').focus();
}

function catPintarPresentaciones() {
  document.getElementById('catCuenta').textContent = catEdicion.presentaciones.length;
  document.getElementById('catPresentaciones').innerHTML = catEdicion.presentaciones.map(p => `<li class="flex items-center gap-2 px-3 py-1.5">
      <b class="tabular-nums">${esc(p.plu)}</b><span class="flex-1">${esc(p.nombre)}</span>
      <button type="button" data-quitar="${esc(p.plu)}" class="text-crit text-xs px-2" aria-label="Quitar ${esc(p.nombre)}">Quitar</button></li>`).join('')
    || '<li class="px-3 py-2 text-gris">Sin presentaciones todavía.</li>';
}

function catCerrarResultados() {
  clearTimeout(catBuscarTimer); // un timer pendiente o una respuesta en vuelo no pueden pintar resultados viejos
  catBuscarSeq++;
  catResultadosSiga = [];
  const caja = document.getElementById('catResultados');
  caja.classList.add('hidden');
  caja.innerHTML = '';
  catActualizarBotonAgregar();
}

// Por qué un PLU no se puede elegir (ya está en la edición o en otra categoría), o null.
function catMotivoNoElegible(plu) {
  if (catEdicion.presentaciones.some(p => p.plu === String(plu))) return 'ya agregado';
  const otra = duenioPlu(catalogoActual, plu, catEdicion.id);
  return otra ? `en “${otra}”` : null;
}

function catPintarResultados() {
  const caja = document.getElementById('catResultados');
  caja.classList.remove('hidden');
  caja.innerHTML = catResultadosSiga.map(r => {
    const motivo = catMotivoNoElegible(r.plu);
    return `<label class="flex items-start gap-2 px-3 py-1.5 text-sm ${motivo ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-verde/10'}">
      <input type="checkbox" class="mt-0.5 accent-verde" data-plu="${esc(r.plu)}" data-nombre="${esc(r.producto)}"${motivo ? ' disabled' : ''}>
      <span><b class="tabular-nums">${esc(r.plu)}</b> · ${esc(r.producto)} <span class="text-xs text-gris">${esc(r.rubro)}</span>${motivo ? ` <span class="text-xs text-warn">${esc(motivo)}</span>` : ''}</span></label>`;
  }).join('') || '<div class="px-3 py-2 text-gris text-sm">Sin resultados.</div>';
  catActualizarBotonAgregar();
}

const catSeleccionados = () => [...document.querySelectorAll('#catResultados input[data-plu]:checked')];
function catActualizarBotonAgregar() {
  const n = catSeleccionados().length;
  const boton = document.getElementById('catAgregar');
  boton.disabled = !n;
  boton.textContent = n ? `Agregar ${n}` : 'Agregar seleccionados';
}

function catBuscarSiga(texto) {
  clearTimeout(catBuscarTimer);
  const q = texto.trim();
  if (q.length < 2) { catCerrarResultados(); return; }
  catBuscarTimer = setTimeout(async () => {
    const n = ++catBuscarSeq;
    try {
      const rows = await api('GET', '/api/siga/buscar?q=' + encodeURIComponent(q));
      if (n === catBuscarSeq) { catMostrarError(''); catResultadosSiga = rows; catPintarResultados(); }
    } catch (e) { if (n === catBuscarSeq) catMostrarError(e.message); }
  }, CAT_BUSCAR_DEBOUNCE_MS);
}

function catAgregarSeleccionados() {
  const nuevos = catSeleccionados().map(c => ({ plu: c.dataset.plu, nombre: c.dataset.nombre }));
  catEdicion = { ...catEdicion, presentaciones: [...catEdicion.presentaciones, ...nuevos] };
  catPintarPresentaciones();
  catPintarResultados(); // los recién agregados quedan marcados "ya agregado"
  document.getElementById('catBuscar').focus(); // el botón Agregar queda deshabilitado: el foco no se pierde
}

async function guardarCategoria(ev) {
  ev.preventDefault();
  const boton = document.getElementById('catGuardar');
  const body = { nombre: document.getElementById('catNombre').value, plus: catEdicion.presentaciones.map(p => p.plu) };
  let guardada = false;
  catMostrarError('');
  boton.disabled = true;
  try {
    if (catEdicion.id) await api('PUT', '/api/plan-nueva/catalogo/' + encodeURIComponent(catEdicion.id), body);
    else await api('POST', '/api/plan-nueva/catalogo', body);
    guardada = true;
  } catch (e) { catMostrarError(e.message); }
  finally { boton.disabled = false; }
  if (!guardada) return;
  document.getElementById('dlgCategoria').close();
  await catRecargarTrasCambio('Categoría guardada', 'Guardado');
}

// El cambio ya está hecho en el servidor: si sólo falla la recarga, no se informa como error del cambio.
async function catRecargarTrasCambio(textoOk, textoHecho) {
  try {
    await cargarCatalogo();
    toast(textoOk);
  } catch (e) { toast(`${textoHecho}, pero no se pudo recargar: ${e.message}`, 'error'); }
}

async function confirmarBorrarCategoria(id) {
  const c = catalogoActual.find(x => x.id === id);
  if (!c || !confirm(`¿Borrar la categoría “${c.nombre}”? Sus presentaciones dejan de planificarse.`)) return;
  try {
    await api('DELETE', '/api/plan-nueva/catalogo/' + encodeURIComponent(id));
  } catch (e) { toast(e.message, 'error'); return; }
  await catRecargarTrasCambio('Categoría borrada', 'Borrada');
}

document.getElementById('btnNuevaCategoria').addEventListener('click', () => abrirCategoria());
document.getElementById('catalogo').addEventListener('click', e => {
  const editar = e.target.closest('[data-editar]');
  const borrar = e.target.closest('[data-borrar]');
  if (editar) abrirCategoria(editar.dataset.editar);
  if (borrar) confirmarBorrarCategoria(borrar.dataset.borrar);
});
document.getElementById('catBuscar').addEventListener('input', e => catBuscarSiga(e.target.value));
document.getElementById('catBuscar').addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); }); // no envía el form
document.getElementById('catResultados').addEventListener('change', catActualizarBotonAgregar);
document.getElementById('catAgregar').addEventListener('click', catAgregarSeleccionados);
document.getElementById('catPresentaciones').addEventListener('click', e => {
  const b = e.target.closest('[data-quitar]');
  if (!b) return;
  catEdicion = { ...catEdicion, presentaciones: catEdicion.presentaciones.filter(p => p.plu !== b.dataset.quitar) };
  catPintarPresentaciones();
  if (catResultadosSiga.length) catPintarResultados();
  document.getElementById('catBuscar').focus(); // el botón Quitar se borró del DOM
});
document.getElementById('catCancelar').addEventListener('click', () => document.getElementById('dlgCategoria').close());
document.getElementById('formCategoria').addEventListener('submit', guardarCategoria);
