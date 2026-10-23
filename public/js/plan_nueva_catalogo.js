'use strict';
// Planificación nueva › Catálogo: categorías con sus presentaciones (PLU de SIGA). Busca con GET /api/siga/buscar
// (el mismo endpoint que usa /planificacion) y permite elegir varios resultados a la vez.

const BUSCAR_DEBOUNCE_MS = 300;
let catalogoActual = [];   // [{ id, nombre, plus, creado, presentaciones: [{ plu, nombre }] }]
let edicion = null;        // { id|null, presentaciones: [{ plu, nombre }] } mientras el diálogo está abierto
let resultadosSiga = [];   // última respuesta del buscador: [{ plu, producto, rubro }]
let buscarTimer = null;
let buscarSeq = 0;

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

function abrirCategoria(id = null) {
  const c = catalogoActual.find(x => x.id === id);
  edicion = { id: c ? c.id : null, presentaciones: c ? [...c.presentaciones] : [] };
  document.getElementById('dlgCatTitulo').textContent = c ? `Editar “${c.nombre}”` : 'Nueva categoría';
  document.getElementById('catNombre').value = c ? c.nombre : '';
  document.getElementById('catBuscar').value = '';
  cerrarResultados();
  pintarPresentacionesEdicion();
  document.getElementById('dlgCategoria').showModal();
  document.getElementById('catNombre').focus();
}

function pintarPresentacionesEdicion() {
  document.getElementById('catCuenta').textContent = edicion.presentaciones.length;
  document.getElementById('catPresentaciones').innerHTML = edicion.presentaciones.map(p => `<li class="flex items-center gap-2 px-3 py-1.5">
      <b class="tabular-nums">${esc(p.plu)}</b><span class="flex-1">${esc(p.nombre)}</span>
      <button type="button" data-quitar="${esc(p.plu)}" class="text-crit text-xs px-2" aria-label="Quitar ${esc(p.nombre)}">Quitar</button></li>`).join('')
    || '<li class="px-3 py-2 text-gris">Sin presentaciones todavía.</li>';
}

function cerrarResultados() {
  resultadosSiga = [];
  const caja = document.getElementById('catResultados');
  caja.classList.add('hidden');
  caja.innerHTML = '';
  actualizarBotonAgregar();
}

// Por qué un PLU no se puede elegir (ya está en la edición o en otra categoría), o null.
function motivoNoElegible(plu) {
  if (edicion.presentaciones.some(p => p.plu === String(plu))) return 'ya agregado';
  const otra = duenioPlu(catalogoActual, plu, edicion.id);
  return otra ? `en “${otra}”` : null;
}

function pintarResultadosSiga() {
  const caja = document.getElementById('catResultados');
  caja.classList.remove('hidden');
  caja.innerHTML = resultadosSiga.map(r => {
    const motivo = motivoNoElegible(r.plu);
    return `<label class="flex items-start gap-2 px-3 py-1.5 text-sm ${motivo ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-verde/10'}">
      <input type="checkbox" class="mt-0.5 accent-verde" data-plu="${esc(r.plu)}" data-nombre="${esc(r.producto)}"${motivo ? ' disabled' : ''}>
      <span><b class="tabular-nums">${esc(r.plu)}</b> · ${esc(r.producto)} <span class="text-xs text-gris">${esc(r.rubro)}</span>${motivo ? ` <span class="text-xs text-warn">${esc(motivo)}</span>` : ''}</span></label>`;
  }).join('') || '<div class="px-3 py-2 text-gris text-sm">Sin resultados.</div>';
  actualizarBotonAgregar();
}

const seleccionadosSiga = () => [...document.querySelectorAll('#catResultados input[data-plu]:checked')];
function actualizarBotonAgregar() {
  const n = seleccionadosSiga().length;
  const boton = document.getElementById('catAgregar');
  boton.disabled = !n;
  boton.textContent = n ? `Agregar ${n}` : 'Agregar seleccionados';
}

function buscarSiga(texto) {
  clearTimeout(buscarTimer);
  const q = texto.trim();
  if (q.length < 2) { cerrarResultados(); return; }
  buscarTimer = setTimeout(async () => {
    const n = ++buscarSeq;
    try {
      const rows = await api('GET', '/api/siga/buscar?q=' + encodeURIComponent(q));
      if (n === buscarSeq) { resultadosSiga = rows; pintarResultadosSiga(); }
    } catch (e) { if (n === buscarSeq) toast(e.message, 'error'); }
  }, BUSCAR_DEBOUNCE_MS);
}

function agregarSeleccionados() {
  const nuevos = seleccionadosSiga().map(c => ({ plu: c.dataset.plu, nombre: c.dataset.nombre }));
  edicion = { ...edicion, presentaciones: [...edicion.presentaciones, ...nuevos] };
  pintarPresentacionesEdicion();
  pintarResultadosSiga(); // los recién agregados quedan marcados "ya agregado"
}

async function guardarCategoria(ev) {
  ev.preventDefault();
  const boton = document.getElementById('catGuardar');
  const body = { nombre: document.getElementById('catNombre').value, plus: edicion.presentaciones.map(p => p.plu) };
  boton.disabled = true;
  try {
    if (edicion.id) await api('PUT', '/api/plan-nueva/catalogo/' + encodeURIComponent(edicion.id), body);
    else await api('POST', '/api/plan-nueva/catalogo', body);
    document.getElementById('dlgCategoria').close();
    toast('Categoría guardada');
    await cargarCatalogo();
  } catch (e) { toast(e.message, 'error'); }
  finally { boton.disabled = false; }
}

async function confirmarBorrarCategoria(id) {
  const c = catalogoActual.find(x => x.id === id);
  if (!c || !confirm(`¿Borrar la categoría “${c.nombre}”? Sus presentaciones dejan de planificarse.`)) return;
  try {
    await api('DELETE', '/api/plan-nueva/catalogo/' + encodeURIComponent(id));
    toast('Categoría borrada');
    await cargarCatalogo();
  } catch (e) { toast(e.message, 'error'); }
}

document.getElementById('btnNuevaCategoria').addEventListener('click', () => abrirCategoria());
document.getElementById('catalogo').addEventListener('click', e => {
  const editar = e.target.closest('[data-editar]');
  const borrar = e.target.closest('[data-borrar]');
  if (editar) abrirCategoria(editar.dataset.editar);
  if (borrar) confirmarBorrarCategoria(borrar.dataset.borrar);
});
document.getElementById('catBuscar').addEventListener('input', e => buscarSiga(e.target.value));
document.getElementById('catBuscar').addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); }); // no envía el form
document.getElementById('catResultados').addEventListener('change', actualizarBotonAgregar);
document.getElementById('catAgregar').addEventListener('click', agregarSeleccionados);
document.getElementById('catPresentaciones').addEventListener('click', e => {
  const b = e.target.closest('[data-quitar]');
  if (!b) return;
  edicion = { ...edicion, presentaciones: edicion.presentaciones.filter(p => p.plu !== b.dataset.quitar) };
  pintarPresentacionesEdicion();
  if (resultadosSiga.length) pintarResultadosSiga();
});
document.getElementById('catCancelar').addEventListener('click', () => document.getElementById('dlgCategoria').close());
document.getElementById('formCategoria').addEventListener('submit', guardarCategoria);
