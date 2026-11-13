'use strict';
// ── Cotizador mayorista · pestaña "Productos y secciones": estado, operaciones y guardado de la tabla ──
// GET/PUT /tabla. El orden del array es el orden del catálogo; las secciones van agrupadas por primera aparición.
// Las filas se reemplazan (nunca se mutan); cada una lleva un _id sólo del cliente que se saca al guardar.
// La vista de filas está en cotizador_mayorista_tabla_filas.js y el importador en cotizador_mayorista_importar.js.

const tp = { filas: [], base: '', puede: false, q: '', seccion: '', estado: 'todos', cargada: false, sig: 1, vinculos: null, nombres: {} };

const sinId = ({ _id, nueva, ...f }) => f; // nueva = fila agregada y aún sin guardar: solo UI, no viaja
const claveGuardable = filas => JSON.stringify(filas.map(filaParaGuardar));
const hayCambios = () => tp.cargada && claveGuardable(tp.filas) !== tp.base;
const filtrando = () => !!(tp.q.trim() || tp.estado !== 'todos');

// Misma regla que lib/cotizador_mayorista normalizarCantidad: lo que se ve acá es lo que se exporta.
function normalizarCantidad(t) {
  const s = String(t ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (s === '' || /^[—–-]+$/.test(s)) return { valor: '' };
  const m = s.match(/^(?:.*\bx ?)?(\d+(?:[.,]\d+)?) ?(u|kg)?$/);
  if (!m) return { valor: null, aviso: 'No se entiende la cantidad' };
  const n = m[1].replace(',', '.'), unidad = m[2] || 'u';
  if (unidad === 'u' && !/^\d+$/.test(n)) return { valor: null, aviso: 'Unidades con decimales' };
  if (!(Number(n) > 0)) return { valor: null, aviso: 'Cantidad en cero' };
  return { valor: `${Number(n)}${unidad}` };
}
// Pack de la fila: 'plu' (por defecto) | 'ninguno'.
const modoDe = f => (f.modoPack === 'ninguno' ? 'ninguno' : 'plu');
const cantidadInvalida = (f, c) => !(c === 'packQty' && modoDe(f) === 'ninguno') && normalizarCantidad(f[c]).valor === null;
// Cod de fila del sistema: sólo dígitos (1 a 12) y único en la tabla (el backend rechaza lo contrario al guardar).
function errorCod(f) {
  const cod = String(f.cod ?? '').trim();
  if (!/^\d{1,12}$/.test(cod)) return 'Solo números';
  return tp.filas.some(x => x._id !== f._id && String(x.cod ?? '').trim() === cod) ? 'Código repetido' : '';
}
const filaConAviso = f => ['packQty', 'bultoQty'].some(c => cantidadInvalida(f, c)) || !!errorCod(f);

// ── Operaciones (devuelven la lista nueva) ──
function agrupar(filas) {
  const grupos = new Map();
  filas.forEach(f => { if (!grupos.has(f.seccion)) grupos.set(f.seccion, []); grupos.get(f.seccion).push(f); });
  return [...grupos].map(([seccion, items]) => ({ seccion, filas: items }));
}
const aplanar = grupos => grupos.flatMap(g => g.filas);
const mover = (arr, i, dir) => {
  const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return arr;
  const c = [...arr];
  [c[i], c[j]] = [c[j], c[i]];
  return c;
};
const actualizarFila = (id, patch) => { tp.filas = tp.filas.map(f => (f._id === id ? { ...f, ...patch } : f)); };
function moverFila(id, dir) {
  const grupos = agrupar(tp.filas).map(g => {
    const i = g.filas.findIndex(f => f._id === id);
    return i < 0 ? g : { ...g, filas: mover(g.filas, i, dir) };
  });
  tp.filas = aplanar(grupos);
  pintarTabla();
}
function moverSeccion(nombre, dir) {
  const grupos = agrupar(tp.filas);
  tp.filas = aplanar(mover(grupos, grupos.findIndex(g => g.seccion === nombre), dir));
  pintarTabla();
}
function renombrarSeccion(viejo, nuevo) {
  const n = nuevo.trim();
  if (!n || n === viejo) return;
  tp.filas = tp.filas.map(f => (f.seccion === viejo ? { ...f, seccion: n } : f));
  if (tp.seccion === viejo) tp.seccion = n;
  pintarTabla();
}
function agregarFila() {
  const seccion = tp.seccion || (tp.filas[0] && tp.filas[0].seccion) || 'Otros';
  const fila = { _id: tp.sig++, cod: '', seccion, nombre: '', packQty: '', bultoQty: '', incluido: true, nueva: true, modoPack: 'plu' };
  tp.filas = [...tp.filas, fila];
  tp.q = '';
  tp.estado = 'todos';
  pintarTabla();
  const campo = document.querySelector(`[data-fila="${fila._id}"] input[data-campo="cod"]`);
  if (campo) { campo.scrollIntoView({ block: 'center' }); campo.focus(); }
}
const quitarFila = id => { tp.filas = tp.filas.filter(f => f._id !== id); pintarTabla(); };

// ── Filtros ──
function pasaFiltro(f) {
  if (tp.seccion && f.seccion !== tp.seccion) return false;
  const e = tp.estado;
  if ((e === 'incluidos' && !f.incluido) || (e === 'excluidos' && f.incluido) || (e === 'avisos' && !filaConAviso(f))) return false;
  const t = norm(tp.q.trim());
  return !t || norm(`${f.cod} ${f.nombre} ${f.seccion}`).includes(t);
}

// ── Carga y guardado ──
function adoptarFilas(filas) {
  tp.filas = aplanar(agrupar(filas.map(({ manual, ...f }) => ({ ...f, modoPack: modoDe(f), _id: tp.sig++ })))); // manual (legado) se descarta; agrupado = el orden en que se exporta
  tp.base = claveGuardable(tp.filas);
  tp.cargada = true;
  cargarVinculos();
}
async function cargarTabla() {
  cargandoTabla($('tablaCont'));
  try {
    const [t, puede] = await Promise.all([api('/tabla'), permisoEditar]);
    tp.puede = puede;
    adoptarFilas(t.filas || []);
    pintarTabla();
  } catch (err) {
    tp.cargada = false;
    estadoError($('tablaCont'), err);
    actualizarBarra();
  }
}
const filaParaGuardar = sinId;
async function guardarTabla() {
  const boton = $('btnGuardarTabla');
  const mala = tp.filas.find(errorCod);
  if (mala) {
    $('tablaMsg').textContent = `No se guardó: ${etiquetaFila(mala)}: ${errorCod(mala)}`;
    return;
  }
  $('tablaMsg').textContent = '';
  boton.disabled = true;
  boton.textContent = 'Guardando…';
  try {
    const r = await apiJson('/tabla', 'PUT', { filas: tp.filas.map(filaParaGuardar) });
    adoptarFilas(r.filas);
    pintarTabla();
    toast('Tabla guardada');
  } catch (err) {
    toast(`No se guardó: ${err.message}`, 'crit');
    $('tablaMsg').textContent = `No se guardó: ${err.message}`;
  } finally {
    boton.textContent = 'Guardar cambios';
    actualizarBarra();
  }
}
async function descartarCambios() {
  if (!hayCambios()) return;
  if (!(await apdConfirmar('Se pierden todos los cambios sin guardar de la tabla.', { titulo: '¿Descartar cambios?', aceptar: 'Descartar', peligro: true }))) return;
  cargarTabla();
}

// ── Barra de herramientas ──
function actualizarBarra() {
  const sucio = hayCambios();
  const motivo = tp.puede ? '' : TIP_SIN_PERMISO;
  $('btnGuardarTabla').disabled = !sucio || !tp.puede;
  $('btnGuardarTabla').title = motivo;
  $('btnDescartarTabla').disabled = !sucio;
  ['btnAgregarProducto', 'btnImportar'].forEach(i => { $(i).disabled = !tp.puede || !tp.cargada; $(i).title = motivo; });
  $('btnAutocompletar').disabled = !tp.puede || !tp.cargada || sucio;
  $('btnAutocompletar').title = tp.puede ? (sucio ? 'Guardá o descartá los cambios antes de autocompletar' : '') : motivo;
  $('btnDescargarCodigos').disabled = !tp.cargada;
  $('btnDescargarCodigos').title = sucio ? 'Incluye solo lo guardado; guardá antes para incluir tus cambios' : '';
  $('tablaSucio').classList.toggle('hidden', !sucio);
  if (!sucio) $('tablaMsg').textContent = '';
  const grupos = agrupar(tp.filas);
  $('tablaCuenta').textContent = tp.cargada
    ? `${fmtNum(tp.filas.length)} filas · ${fmtNum(grupos.length)} secciones · ${fmtNum(tp.filas.filter(f => f.incluido).length)} incluidas${tp.puede ? '' : ' · Solo lectura: no tenés el permiso de configuración de Precios'}` : '';
  actualizarFiltros();
}
// Filtro de estado segmentado: contadores por opción y estado activo; #tablaEstado queda oculto y sincronizado.
function actualizarFiltros() {
  const cuenta = {
    todos: tp.filas.length, incluidos: tp.filas.filter(f => f.incluido).length, excluidos: tp.filas.filter(f => !f.incluido).length,
    avisos: tp.filas.filter(filaConAviso).length,
  };
  $('tablaEstado').value = tp.estado;
  if ($('tablaBuscar').value !== tp.q) $('tablaBuscar').value = tp.q;
  document.querySelectorAll('#tablaEstadoSeg .seg-b').forEach(b => {
    const on = b.dataset.estado === tp.estado;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    const n = b.querySelector('.seg-n');
    n.textContent = tp.cargada ? fmtNum(cuenta[b.dataset.estado]) : '0';
    n.classList.toggle('hay', b.dataset.estado === 'avisos' && cuenta.avisos > 0);
  });
}
function llenarSecciones() {
  const sel = $('tablaSeccion');
  const nombres = agrupar(tp.filas).map(g => g.seccion);
  if (tp.seccion && !nombres.includes(tp.seccion)) tp.seccion = '';
  montar(sel, h('option', { value: '' }, 'Todas las secciones'), nombres.map(n => h('option', { value: n }, n)));
  sel.value = tp.seccion;
}
function pintarTabla() {
  llenarSecciones();
  pintarFilas();
  actualizarBarra();
}

function iniciarTabla() {
  $('tablaBuscar').addEventListener('input', e => { tp.q = e.target.value; pintarFilas(); });
  $('tablaSeccion').addEventListener('change', e => { tp.seccion = e.target.value; pintarFilas(); });
  $('tablaEstado').addEventListener('change', e => { tp.estado = e.target.value; pintarFilas(); actualizarFiltros(); });
  document.querySelectorAll('#tablaEstadoSeg .seg-b').forEach(b => b.addEventListener('click', () => {
    tp.estado = b.dataset.estado;
    pintarFilas();
    actualizarFiltros();
  }));
  $('btnGuardarTabla').addEventListener('click', guardarTabla);
  $('btnDescartarTabla').addEventListener('click', descartarCambios);
  $('btnAgregarProducto').addEventListener('click', agregarFila);
  iniciarImportar();
  window.addEventListener('beforeunload', e => { if (hayCambios()) e.preventDefault(); });
}
