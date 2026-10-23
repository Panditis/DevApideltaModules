'use strict';
// Planificación nueva › Órdenes: órdenes generadas desde el carrito, con detalle y anulación (no se borran).
// Prefijo ord* en todo lo global: los scripts de esta página comparten el scope.

let ordLista = [];      // GET /api/plan-nueva/ordenes, la más nueva primero
let ordAbierta = null;  // id de la orden que muestra el diálogo
let ordCargando = null; // carga en vuelo: mostrarTab y ordAbrir (al generar una orden) comparten un solo GET

// Si falla la carga, el error queda en la caja de la lista (la tab ya está visible) y se conserva lo último cargado.
function ordCargar() {
  if (!ordCargando) {
    ordCargando = api('GET', '/api/plan-nueva/ordenes')
      .then(lista => { ordLista = lista; ordPintarLista(); })
      .catch(e => {
        document.getElementById('ordenes').innerHTML =
          `<p role="alert" class="text-crit">No se pudieron cargar las órdenes: ${esc(e.message)}</p>`;
      })
      .finally(() => { ordCargando = null; });
  }
  return ordCargando;
}
TABS.ordenes = { cargar: ordCargar };

const ORD_CLASE_ESTADO = { activa: 'bg-verde/10 text-ok', anulada: 'bg-crit/10 text-crit' };
const ordChipEstado = estado => `<span class="px-2 py-0.5 rounded text-xs ${ORD_CLASE_ESTADO[estado] || ''}">${esc(estado)}</span>`;
const ordFecha = f => (f ? esc(String(f).split('-').reverse().join('/')) : '—');

function ordPintarLista() {
  const caja = document.getElementById('ordenes');
  if (!ordLista.length) {
    caja.innerHTML = '<p class="text-gris">Todavía no hay órdenes. Se generan desde el carrito.</p>';
    return;
  }
  caja.innerHTML = `<table class="w-full text-sm">
    <thead><tr class="text-verde"><th class="text-left p-2">N°</th><th class="text-left p-2">Fecha</th><th class="text-right p-2">Líneas</th>
      <th class="text-left p-2">Creada por</th><th class="text-left p-2">Estado</th><th class="p-2"></th></tr></thead>
    <tbody>${ordLista.map(o => `<tr class="border-t border-borde${o.estado === 'anulada' ? ' text-gris' : ''}">
      <td class="p-2 tabular-nums font-medium">#${esc(o.numero)}</td>
      <td class="p-2">${ordFecha(o.fecha)}</td>
      <td class="p-2 text-right tabular-nums">${esc(o.lineas.length)}</td>
      <td class="p-2">${esc(o.usuario)}</td>
      <td class="p-2">${ordChipEstado(o.estado)}</td>
      <td class="p-2 text-right"><button type="button" data-ver="${esc(o.id)}" class="px-2 py-1 rounded border border-borde text-xs hover:bg-bg">Ver</button></td>
    </tr>`).join('')}</tbody></table>`;
}

function ordMostrarError(mensaje) {
  const el = document.getElementById('ordError');
  el.textContent = mensaje;
  el.classList.toggle('hidden', !mensaje);
}

function ordPintarDetalle() {
  const o = ordLista.find(x => x.id === ordAbierta);
  if (!o) return;
  document.getElementById('dlgOrdTitulo').innerHTML = `Orden #${esc(o.numero)} · ${ordFecha(o.fecha)} ${ordChipEstado(o.estado)}`;
  document.getElementById('ordMeta').textContent = `Creada por ${o.usuario} el ${new Date(o.creado).toLocaleString('es-AR')}`;
  document.getElementById('ordNotas').textContent = o.notas || 'Sin notas.';
  document.getElementById('ordLineas').innerHTML = o.lineas.map(l => `<tr class="border-t border-borde">
    <td class="p-2">${esc(l.nombre)} <span class="text-xs text-gris">${esc(l.categoria)} · PLU ${esc(l.plu)}</span></td>
    <td class="p-2 text-right tabular-nums">${fmtNum(l.cantidad)}</td>
    <td class="p-2">${esc(l.responsables.join(', ')) || '—'}</td>
    <td class="p-2">${esc(l.notas) || '—'}</td></tr>`).join('');
  document.getElementById('ordAnular').classList.toggle('hidden', o.estado !== 'activa');
}

// Abre el detalle; si la orden todavía no está en la lista (recién generada) la recarga primero.
async function ordAbrir(id) {
  if (!ordLista.some(o => o.id === id)) await ordCargar();
  if (!ordLista.some(o => o.id === id)) return; // la carga falló: el motivo ya está en la lista
  ordAbierta = id;
  ordMostrarError('');
  ordPintarDetalle();
  const dlg = document.getElementById('dlgOrden');
  if (!dlg.open) dlg.showModal();
}

async function ordAnularAbierta() {
  const o = ordLista.find(x => x.id === ordAbierta);
  if (!o || !confirm(`¿Anular la orden #${o.numero}? Queda en la lista como anulada.`)) return;
  const boton = document.getElementById('ordAnular');
  boton.disabled = true;
  ordMostrarError('');
  try {
    await api('PUT', `/api/plan-nueva/ordenes/${encodeURIComponent(o.id)}/anular`);
    toast(`Orden #${o.numero} anulada`);
  } catch (e) { ordMostrarError(e.message); } // p. ej. 409 si otro usuario ya la anuló: abajo se refresca
  finally { boton.disabled = false; }
  await ordCargar();
  ordPintarDetalle();
}

document.getElementById('ordenes').addEventListener('click', e => {
  const b = e.target.closest('[data-ver]');
  if (b) ordAbrir(b.dataset.ver);
});
document.getElementById('ordAnular').addEventListener('click', ordAnularAbierta);
document.getElementById('ordCerrar').addEventListener('click', () => document.getElementById('dlgOrden').close());
