'use strict';
// Planificación nueva › Planificación: categorías desplegables con consumo de sucursales, stock en Casa Central y
// sugerido por presentación. "+ Planificar" agrega al carrito (plan_nueva_carrito.js). Usa `carrito` y
// agregarFilaAlCarrito de ese script (todos los plan_nueva_*.js comparten el global).

let tableroActual = null;    // { params: { diasConsumo, diasCubrir }, categorias: [{ id, nombre, presentaciones }] }
const abiertas = new Set();  // ids de categoría desplegadas: sobreviven al repintado (fuera de una búsqueda)

// ponytail: se recalcula en SIGA cada vez que se muestra la tab; cachear si se vuelve lento.
async function cargarTablero() {
  const caja = document.getElementById('tablero');
  caja.innerHTML = '<p class="text-gris"><span class="spin"></span> Calculando consumo y stock…</p>';
  try {
    tableroActual = await api('GET', '/api/plan-nueva/tablero');
  } catch (e) {
    tableroActual = null;
    caja.innerHTML = `<p role="alert" class="text-crit">No se pudo calcular el tablero: ${esc(e.message)}</p>`;
    throw e; // mostrarTab / aplicarParams además lo avisan con el toast
  }
  document.getElementById('pDiasConsumo').value = tableroActual.params.diasConsumo;
  document.getElementById('pDiasCubrir').value = tableroActual.params.diasCubrir;
  pintarTablero();
}
TABS.planificacion = { cargar: cargarTablero };

function filaTableroHtml(p, cat) {
  const accion = enCarrito(carrito, p.plu)
    ? `<span tabindex="-1" data-enplan="${esc(p.plu)}" class="text-xs text-ok">✓ En el carrito</span>`
    : `<button type="button" data-planificar="${esc(p.plu)}" data-cat="${esc(cat.id)}" class="px-2 py-1 rounded-lg bg-verde text-white text-xs hover:bg-verdeHover">+ Planificar</button>`;
  return `<tr class="border-t border-borde">
    <td class="p-2">${esc(p.nombre)} <span class="text-xs text-gris tabular-nums">${esc(p.plu)}</span></td>
    <td class="p-2 text-right tabular-nums">${fmtNum(p.consumoDia)}</td>
    <td class="p-2 text-right tabular-nums">${fmtNum(p.consumoMes)}</td>
    <td class="p-2 text-right tabular-nums">${fmtNum(p.stockCentral)}</td>
    <td class="p-2 text-right tabular-nums font-semibold ${p.sugerido > 0 ? 'text-verde' : 'text-gris'}">${fmtNum(p.sugerido)}</td>
    <td class="p-2 text-right w-36">${accion}</td></tr>`;
}

function categoriaTableroHtml(c, abierta, diasCubrir) {
  return `<details class="acordeon" data-id="${esc(c.id)}"${abierta ? ' open' : ''}>
    <summary><span class="caret">▶</span><span class="font-semibold">${esc(c.nombre)}</span>
      <span class="text-xs text-gris">${c.presentaciones.length} presentaciones</span></summary>
    <div class="cuerpo"><table class="w-full text-sm">
      <thead><tr class="text-gris text-xs"><th class="text-left p-2">Presentación</th><th class="text-right p-2">Consumo/día</th>
        <th class="text-right p-2">Consumo/mes</th><th class="text-right p-2">Stock C. Central</th>
        <th class="text-right p-2" title="consumo/día × ${esc(diasCubrir)} − stock, hacia arriba">Sugerido (${esc(diasCubrir)} d)</th><th class="p-2"></th></tr></thead>
      <tbody>${c.presentaciones.map(p => filaTableroHtml(p, c)).join('') || '<tr><td colspan="6" class="p-2 text-gris">Sin presentaciones.</td></tr>'}</tbody>
    </table></div></details>`;
}

function pintarTablero() {
  if (!tableroActual) return;
  const caja = document.getElementById('tablero');
  const q = document.getElementById('tabBuscar').value.trim();
  if (!tableroActual.categorias.length) {
    caja.innerHTML = '<p class="text-gris">No hay categorías. Cargalas en la pestaña Catálogo.</p>';
    return;
  }
  const cats = filtrarTablero(tableroActual.categorias, q);
  if (!cats.length) { caja.innerHTML = '<p class="text-gris">Nada coincide con la búsqueda.</p>'; return; }
  caja.innerHTML = cats.map(c => categoriaTableroHtml(c, Boolean(q) || abiertas.has(c.id), tableroActual.params.diasCubrir)).join('');
}

async function aplicarParams() {
  const body = {
    diasConsumo: Number(document.getElementById('pDiasConsumo').value),
    diasCubrir: Number(document.getElementById('pDiasCubrir').value),
  };
  const boton = document.getElementById('btnParams');
  if (boton.disabled) return; // ya hay un envío en curso (Enter repetido)
  boton.disabled = true;
  try {
    await api('PUT', '/api/plan-nueva/params', body);
    toast('Parámetros guardados');
    await cargarTablero();
  } catch (e) { toast(e.message, 'error'); }
  finally { boton.disabled = false; }
}

// 'toggle' no burbujea: se escucha en captura. Durante una búsqueda todo se abre solo y no se recuerda.
document.getElementById('tablero').addEventListener('toggle', e => {
  const d = e.target;
  if (!d.matches || !d.matches('details[data-id]') || document.getElementById('tabBuscar').value.trim()) return;
  if (d.open) abiertas.add(d.dataset.id); else abiertas.delete(d.dataset.id);
}, true);
document.getElementById('tablero').addEventListener('click', e => {
  const b = e.target.closest('[data-planificar]');
  if (!b || !tableroActual) return;
  const cat = tableroActual.categorias.find(c => c.id === b.dataset.cat);
  const fila = cat && cat.presentaciones.find(p => p.plu === b.dataset.planificar);
  if (!fila) return;
  agregarFilaAlCarrito(fila, cat.nombre);
  // El botón pulsado se reemplaza por "✓ En el carrito": el foco pasa a esa marca y no se pierde con el repintado.
  const marca = document.querySelector(`[data-enplan="${CSS.escape(fila.plu)}"]`);
  if (marca) marca.focus();
});
document.getElementById('tabBuscar').addEventListener('input', pintarTablero);
document.getElementById('btnParams').addEventListener('click', aplicarParams);
for (const id of ['pDiasConsumo', 'pDiasCubrir']) {
  document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') aplicarParams(); });
}
