'use strict';
// Planificación nueva › Carrito: panel lateral con lo que se va a producir. Vive en localStorage hasta generar la
// orden (POST /api/plan-nueva/ordenes). Visible desde cualquier tab con el botón del header.

// Con los datos del sitio bloqueados, tocar la propiedad localStorage ya tira: sin almacén el carrito dura la pestaña.
const almacen = (() => { try { return localStorage; } catch { return null; } })();
let carrito = leerCarrito(almacen, hoyISO());
let responsablesLista = null; // nombres de data/responsables.json; se piden la primera vez que se abre el panel
let carGenerando = false;     // POST en vuelo: el botón sigue apagado aunque se agreguen líneas mientras tanto

// Error del servidor (400/409/503…) dentro del panel: el toast solo quedaría tapado por las líneas.
function carMostrarError(mensaje) {
  const el = document.getElementById('carError');
  el.textContent = mensaje || '';
  el.classList.toggle('hidden', !mensaje);
}

// Guarda y actualiza el contador. repintar=false mientras se escribe en un campo (no pierde el foco).
function cambiarCarrito(nuevo, { repintar = true } = {}) {
  carrito = nuevo;
  guardarCarrito(almacen, carrito);
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
    <input data-campo="notas" value="${esc(l.notas)}" maxlength="500" placeholder="Notas de la línea" aria-label="Notas de ${esc(l.nombre)}" class="px-2 py-1 rounded border border-borde text-sm">
  </li>`;
}

function pintarCarrito() {
  document.getElementById('carFecha').value = carrito.fecha;
  document.getElementById('carNotas').value = carrito.notas;
  document.getElementById('carLineas').innerHTML = carrito.lineas.map(lineaCarritoHtml).join('')
    || '<li class="p-3 text-gris">Vacío. Agregá presentaciones con “+ Planificar”.</li>';
  document.getElementById('carGenerar').disabled = carGenerando || !carrito.lineas.length;
}

// El panel abierto tapa la derecha de la pantalla: body.con-carrito le deja ese lugar al contenido (ver el <style>).
function cerrarCarrito() {
  document.getElementById('carrito').classList.add('hidden');
  document.getElementById('btnCarrito').setAttribute('aria-expanded', 'false');
  document.body.classList.remove('con-carrito');
}

async function abrirCarrito() {
  document.getElementById('carrito').classList.remove('hidden');
  document.getElementById('btnCarrito').setAttribute('aria-expanded', 'true');
  document.body.classList.add('con-carrito');
  carMostrarError('');
  pintarCarrito();
  if (responsablesLista) return;
  try {
    responsablesLista = await api('GET', '/api/plan-nueva/responsables');
    pintarCarrito(); // ahora con las opciones de responsables
  } catch (e) { carMostrarError(`No se pudo cargar la lista de responsables: ${e.message}`); } // se reintenta al reabrir
}

const toggleCarrito = () => (document.getElementById('carrito').classList.contains('hidden') ? abrirCarrito() : cerrarCarrito());

async function generarOrden() {
  if (carGenerando) return;
  const enviada = payloadOrden(carrito); // foto de lo que viaja: lo agregado después no se pierde al terminar
  carGenerando = true;
  document.getElementById('carGenerar').disabled = true; // evita el doble envío
  carMostrarError('');
  try {
    const orden = await api('POST', '/api/plan-nueva/ordenes', enviada);
    cambiarCarrito(quitarEnviadas(carrito, enviada, hoyISO()));
    cerrarCarrito();
    toast(`Orden #${orden.numero} generada`);
    mostrarTab('ordenes');
    await ordAbrir(orden.id); // plan_nueva_ordenes.js: no tira, los errores quedan en la lista
  } catch (e) {
    carMostrarError(e.message);
    if (document.getElementById('carrito').classList.contains('hidden')) toast(e.message, 'error'); // cerrado durante el envío
  } finally {
    carGenerando = false;
    document.getElementById('carGenerar').disabled = !carrito.lineas.length;
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
document.getElementById('carCerrar').addEventListener('click', cerrarCarrito);
document.addEventListener('keydown', e => { // con un <dialog> abierto, Esc es de él
  if (e.key === 'Escape' && !document.querySelector('dialog[open]')) cerrarCarrito();
});
document.getElementById('carGenerar').addEventListener('click', generarOrden);
document.getElementById('carritoCuenta').textContent = carrito.lineas.length;
