// ── Precios · tab Máquinas: alta, edición y baja de categorías de máquina de Producción ──
// Script clásico cargado después de precios_produccion.js: usa globales de precios.html (esc,
// numOrNull, avisar, confirmar), precios_fraccionado.js (pedirJson) y precios_produccion.js (getJson,
// API_PROD, pedirCampos, avisoExito, cargandoHtml, btnPrim, campoCls, idCategoriaNueva, refrescarAlertasProduccion).
// Datos: data/recetas_produccion.json → categoriasMaquina [{ id, nombre, costoHora }]. Cada receta elige
// una: suma costo/hora ÷ 60 × minutos de elaboración. El PUT manda la lista completa y el server rechaza
// quitar una categoría en uso. El id sale del nombre (no se le pide al usuario) y no cambia al renombrar.

// ── Helpers puros (sin DOM; test/precios_produccion_export.test.js) ─────────────
const textoUsosCategoria = usos => (usos || []).map(u => `${u.nombre} (${u.recetas.join(', ')})`).join(' · ');
// Body del PUT: sin `usos` (lo agrega el GET, no se guarda).
const listaParaGuardar = cats => (cats || []).map(({ id, nombre, costoHora }) => ({ id, nombre, costoHora }));
const conCambio = (cats, id, cambio) => cats.map(c => (c.id === id ? { ...c, ...cambio } : c));
const sinCategoria = (cats, id) => cats.filter(c => c.id !== id);

if (typeof module === 'object' && module.exports) {
  module.exports = { textoUsosCategoria, listaParaGuardar, conCambio, sinCategoria };
}

// ── Tab ─────────────────────────────────────────────────────────────────────────
let maqCats = [];
const panelMaq = () => document.getElementById('panel-maquinas');

// La llama activarTab (precios.html) al entrar a la tab.
async function cargarMaquinas() {
  panelMaq().innerHTML = cargandoHtml('Cargando categorías…');
  try {
    maqCats = (await getJson(API_PROD + '/categorias-maquina')).categoriasMaquina;
    pintarMaquinas();
  } catch (e) {
    panelMaq().innerHTML = `<p class="p-8 text-center text-crit">No se pudo cargar: ${esc(e.message)}</p>`;
  }
}

function htmlUsos(usos) {
  if (!usos.length) return '<span class="text-gris">sin uso</span>';
  return usos.map(u => `<a href="#produccion/${esc(encodeURIComponent(u.id))}" class="text-verde hover:underline">${esc(u.nombre)}</a>
    <span class="text-gris">(${esc(u.recetas.join(', '))})</span>`).join(' · ');
}
function htmlFilaMaquina(c) {
  return `<tr class="border-t border-borde" data-id="${esc(c.id)}">
    <td class="p-2"><input type="text" maxlength="60" class="mq-nombre ${campoCls} w-full" aria-label="Nombre de ${esc(c.nombre)}" value="${esc(c.nombre)}"></td>
    <td class="p-2 text-right whitespace-nowrap">${campoU(`<input type="number" min="0" step="any" class="mq-costo" aria-label="Costo por hora de ${esc(c.nombre)}" value="${esc(c.costoHora)}">`, '$', { pre: true, w: 'w-36' })}</td>
    <td class="p-2 text-xs">${htmlUsos(c.usos || [])}</td>
    <td class="p-2 text-center"><button type="button" class="mq-quitar w-7 h-7 rounded-lg text-gris hover:text-crit hover:bg-crit/10" aria-label="Borrar ${esc(c.nombre)}" title="Borrar">✕</button></td>
  </tr>`;
}
function pintarMaquinas() {
  const tabla = maqCats.length ? `<div class="overflow-x-auto rounded-xl border border-borde"><table class="w-full text-sm">
      <thead class="bg-verde/5 text-verde"><tr><th class="p-2 text-left">Nombre</th><th class="p-2 text-right">Costo por hora</th>
        <th class="p-2 text-left">Usada en</th><th class="p-2"></th></tr></thead>
      <tbody id="mqFilas">${maqCats.map(htmlFilaMaquina).join('')}</tbody></table></div>`
    : '<p class="text-sm text-gris">Todavía no hay categorías. Agregá las máquinas que usan las recetas (horno, mezcladora…).</p>';
  panelMaq().innerHTML = `<p class="cfg-cab"><b>Máquinas</b> — costo por hora de las máquinas que usan las recetas de Producción. Cada cambio se guarda al salir del campo.</p>
    <div class="cfg-card max-w-4xl">
    <h3 class="cfg-h">Categorías de máquina</h3>
    <p class="cfg-ayuda">Costo por hora de cada máquina, sin IVA. Cada receta de Producción elige una y suma
      costo/hora ÷ 60 × sus minutos de elaboración. Cambiar un costo mueve el costo de esas recetas y aparece como cambio a validar.
      Una categoría en uso no se puede borrar.</p>
    ${tabla}
    <button type="button" id="mqAgregar" class="${btnPrim} mt-4">+ Nueva categoría</button></div>`;
  conectarMaquinas();
}
function conectarMaquinas() {
  document.getElementById('mqAgregar').onclick = nuevaMaquina;
  document.querySelectorAll('#mqFilas tr[data-id]').forEach(tr => {
    const id = tr.dataset.id;
    tr.querySelector('.mq-nombre').addEventListener('change', e => guardarMaquinas(conCambio(maqCats, id, { nombre: e.target.value.trim() }), 'Categoría guardada'));
    tr.querySelector('.mq-costo').addEventListener('change', e => guardarMaquinas(conCambio(maqCats, id, { costoHora: numOrNull(e.target.value) }), 'Costo guardado'));
    tr.querySelector('.mq-quitar').onclick = () => borrarMaquina(id);
  });
}

// PUT de la lista completa; con error se avisa y la tabla vuelve a lo guardado.
async function guardarMaquinas(cats, msgOk) {
  try {
    maqCats = (await pedirJson('PUT', API_PROD + '/categorias-maquina', { categorias: listaParaGuardar(cats) })).categoriasMaquina;
    avisoExito(msgOk);
    refrescarAlertasProduccion(); // un cambio de costo/hora mueve costos de Producción → alertas
  } catch (e) { avisar(e.message); }
  pintarMaquinas();
}
async function nuevaMaquina() {
  const v = await pedirCampos('Nueva categoría de máquina', [
    { name: 'nombre', label: 'Nombre * (ej. Horno rotativo)', required: true },
    { name: 'costoHora', label: 'Costo por hora, sin IVA ($) *', type: 'number', required: true },
  ], 'Agregar');
  if (!v) return;
  const id = idCategoriaNueva(v.nombre, maqCats.map(c => c.id));
  guardarMaquinas([...maqCats, { id, nombre: v.nombre, costoHora: numOrNull(v.costoHora) }], 'Categoría agregada');
}
async function borrarMaquina(id) {
  const c = maqCats.find(x => x.id === id);
  if (!c) return;
  if ((c.usos || []).length) {
    avisar(`No se puede borrar "${c.nombre}": la usan ${textoUsosCategoria(c.usos)}.\nCambiá primero la máquina de esas recetas.`);
    return;
  }
  if (!(await confirmar(`¿Borrar la categoría "${c.nombre}"?`, { textoOk: 'Borrar' }))) return;
  guardarMaquinas(sinCategoria(maqCats, id), 'Categoría borrada');
}
