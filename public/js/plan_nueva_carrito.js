'use strict';
// Planificación nueva › Carrito: panel lateral con lo que se va a producir. Vive en localStorage hasta generar la
// orden (POST /api/plan-nueva/ordenes). Visible desde cualquier tab con el botón del header.

let carrito = leerCarrito(localStorage, hoyISO());
let responsablesLista = null; // nombres de data/responsables.json; se piden la primera vez que se abre el panel

// Error del servidor (400/409/503…) dentro del panel: el toast solo quedaría tapado por las líneas.
function carMostrarError(mensaje) {
  const el = document.getElementById('carError');
  el.textContent = mensaje || '';
  el.classList.toggle('hidden', !mensaje);
}

// Guarda y actualiza el contador. repintar=false mientras se escribe en un campo (no pierde el foco).
function cambiarCarrito(nuevo, { repintar = true } = {}) {
  carrito = nuevo;
  guardarCarrito(localStorage, carrito);
  document.getElementById('carritoCuenta').textContent = carrito.lineas.length;
  carMostrarError('');
  if (!repintar) return;
  pintarCarrito();
  pintarTablero();
}

function agregarFilaAlCarrito(fila, categoria) {
  cambiarCarrito(agregarAlCarrito(carrito, fila, categoria));
  toast(`“${fila.nombre}” agregado al carrito`);
}

function lineaCarritoHtml(l) {
  const opciones = (responsablesLista || [])
    .map(n => `<option value="${esc(n)}"${l.responsables.includes(n) ? ' selected' : ''}>${esc(n)}</option>`).join('');
  const cantidad = Number.isInteger(l.cantidad) ? l.cantidad : ''; // campo vaciado → NaN → null en el storage
  return `<li class="p-3 flex flex-col gap-2" data-plu="${esc(l.plu)}">
    <div class="flex items-start gap-2">
      <div class="flex-1"><div class="font-medium">${esc(l.nombre)}</div><div class="text-xs text-gris">${esc(l.categoria)} · PLU ${esc(l.plu)}</div></div>
      <button type="button" data-quitar class="text-crit text-xs px-2" aria-label="Quitar ${esc(l.nombre)}">Quitar</button>
    </div>
    <div class="flex gap-2 items-start">
      <label class="text-xs text-gris">Cantidad
        <input type="number" min="1" step="1" data-campo="cantidad" value="${esc(cantidad)}" class="block w-24 mt-1 px-2 py-1 rounded border border-borde text-ink text-sm"></label>
      <label class="text-xs text-gris flex-1">Responsables
        <select multiple size="3" data-campo="responsables" class="block w-full mt-1 rounded border border-borde text-ink text-sm">${opciones}</select></label>
    </div>
    <input data-campo="notas" value="${esc(l.notas)}" maxlength="500" placeholder="Notas de la línea" class="px-2 py-1 rounded border border-borde text-sm">
  </li>`;
}

function pintarCarrito() {
  document.getElementById('carFecha').value = carrito.fecha;
  document.getElementById('carNotas').value = carrito.notas;
  document.getElementById('carLineas').innerHTML = carrito.lineas.map(lineaCarritoHtml).join('')
    || '<li class="p-3 text-gris">Vacío. Agregá presentaciones con “+ Planificar”.</li>';
  document.getElementById('carGenerar').disabled = !carrito.lineas.length;
}

async function toggleCarrito() {
  const panel = document.getElementById('carrito');
  const abrir = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !abrir);
  document.getElementById('btnCarrito').setAttribute('aria-expanded', String(abrir));
  if (!abrir) return;
  carMostrarError('');
  pintarCarrito();
  if (responsablesLista) return;
  try {
    responsablesLista = await api('GET', '/api/plan-nueva/responsables');
    pintarCarrito(); // ahora con las opciones de responsables
  } catch (e) { carMostrarError(`No se pudo cargar la lista de responsables: ${e.message}`); } // se reintenta al reabrir
}

async function generarOrden() {
  const boton = document.getElementById('carGenerar');
  boton.disabled = true; // evita el doble envío
  carMostrarError('');
  try {
    const orden = await api('POST', '/api/plan-nueva/ordenes', payloadOrden(carrito));
    cambiarCarrito(carritoVacio(hoyISO()));
    await toggleCarrito(); // estaba abierto: lo cierra
    toast(`Orden #${orden.numero} generada`);
  } catch (e) {
    carMostrarError(e.message);
    boton.disabled = !carrito.lineas.length;
  }
}

document.getElementById('carLineas').addEventListener('input', e => {
  const li = e.target.closest('li[data-plu]');
  const campo = e.target.dataset.campo;
  if (!li || !campo) return;
  const valor = campo === 'cantidad' ? parseInt(e.target.value, 10)
    : campo === 'responsables' ? [...e.target.selectedOptions].map(o => o.value)
      : e.target.value;
  cambiarCarrito(editarLinea(carrito, li.dataset.plu, { [campo]: valor }), { repintar: false });
});
document.getElementById('carLineas').addEventListener('click', e => {
  const b = e.target.closest('[data-quitar]');
  if (b) cambiarCarrito(quitarDelCarrito(carrito, b.closest('li[data-plu]').dataset.plu));
});
document.getElementById('carFecha').addEventListener('input', e => cambiarCarrito({ ...carrito, fecha: e.target.value }, { repintar: false }));
document.getElementById('carNotas').addEventListener('input', e => cambiarCarrito({ ...carrito, notas: e.target.value }, { repintar: false }));
document.getElementById('carVaciar').addEventListener('click', () => {
  if (carrito.lineas.length && confirm('¿Vaciar el carrito?')) cambiarCarrito(carritoVacio(hoyISO()));
});
document.getElementById('btnCarrito').addEventListener('click', toggleCarrito);
document.getElementById('carCerrar').addEventListener('click', toggleCarrito);
document.getElementById('carGenerar').addEventListener('click', generarOrden);
document.getElementById('carritoCuenta').textContent = carrito.lineas.length;
