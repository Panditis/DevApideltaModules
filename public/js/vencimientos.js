'use strict';
// Control de vencimientos (Sucursales), Etapa 1. API: /api/vencimientos/*. Sin framework.
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = n => Number(n || 0).toLocaleString('es-AR');
const fmtFecha = iso => { const [y, m, d] = String(iso).split('-'); return d ? `${d}/${m}/${y}` : String(iso); };
const fmtFechaHora = iso => { const t = new Date(iso); return isNaN(t) ? String(iso) : t.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }); };

const SEMAFORO = { rojo: 'Rojo', amarillo: 'Amarillo', verde: 'Verde' };
const TIPO_MOV = { alta: 'Alta', correccion: 'Corrección', oferta: 'Oferta', vendido: 'Vendido', vencido: 'Vencido', 'oferta-sistema': 'A oferta', 'oferta-sistema-quitada': 'Quitado de oferta', 'oferta-confirmacion': 'Cantidades confirmadas', 'vencido-sistema': 'A vencido', 'vencido-sistema-quitada': 'Quitado de vencido', 'devuelto-central': 'Devuelto a Central' };
// Dos escalones con el mismo flujo: oferta (base = cargadas) y vencido (base = total en oferta).
const CLASES = {
  oferta: { sis: 'ofertasSistema', est: 'ofertaEstado', ruta: 'oferta', mov: 'movimientos-oferta', titulo: 'Pasar a oferta', hecho: 'Movimientos asignados a oferta', cmpAttr: 'data-cmp', vacio: d => `Sin movimientos PARA OFERTA en los últimos ${d} días. Hacelo primero en SIGA.` },
  vencido: { sis: 'vencidosSistema', est: 'vencidoEstado', ruta: 'vencido', mov: 'movimientos-vencido', titulo: 'Vencido', hecho: 'Movimientos asignados a vencido', cmpAttr: 'data-cmpv', vacio: d => `Sin movimientos ${esSinOferta() ? '' : 'OFERTA '}VENCIDO en los últimos ${d} días. Hacelo primero en SIGA.` },
};
const MIN_BUSQUEDA = 2;
const DEBOUNCE_MS = 300;

const estado = { datos: null, nombres: {}, miSucursal: null,loteAcc: null, productoElegido: null, tabActiva: 'mia', filtroLote: null, ventas: null, histAbiertos: new Set() };

async function api(url, opciones) {
  const init = opciones && opciones.body !== undefined
    ? { ...opciones, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opciones.body) } : opciones;
  const r = await fetch(url, init);
  let cuerpo = null;
  try { cuerpo = await r.json(); } catch (_) { /* respuesta sin JSON */ }
  if (!r.ok) throw new Error((cuerpo && cuerpo.error) || `Error ${r.status}`);
  return cuerpo;
}

// Sucursales sin ofertas (7, 9, 10): el server manda usuario.sinOferta; en lugar de oferta se cargan devoluciones a Central.
function esSinOferta() { return !!(estado.datos && estado.datos.usuario && estado.datos.usuario.sinOferta); }
const devueltoDe = c => Number(c.devuelto || 0);
const nombreSuc = id => estado.nombres[id] || `Suc. ${id}`;
const signo = n => (n > 0 ? '+' : '−') + fmtNum(Math.abs(n));
const movsDe = (c, k) => (Array.isArray(c[CLASES[k].sis]) ? c[CLASES[k].sis] : []);
const totalDe = (c, k) => movsDe(c, k).reduce((a, o) => a + Number(o.cantidad || 0), 0);
const ofertasDe = c => movsDe(c, 'oferta');
const totalOfertas = c => totalDe(c, 'oferta');
const vencidosDe = c => movsDe(c, 'vencido');
// Base contra la que se compara cada escalón: oferta vs. cargadas; vencido vs. total en oferta o, sin oferta, cargadas.
const baseVencido = c => (c.vencidoBase !== null && c.vencidoBase !== undefined && Number.isFinite(Number(c.vencidoBase)) ? Number(c.vencidoBase) : (ofertasDe(c).length ? totalOfertas(c) : Number(c.unidades || 0)));
const baseDe = (c, k) => (k === 'vencido' ? baseVencido(c) : Number(c.unidades || 0));
const rotuloBaseVencido = c => (ofertasDe(c).length ? 'En oferta' : 'Cargadas');
const pendienteDe = c => Math.max(0, Number(c.unidades || 0) - Number(c.vendido || 0) - Number(c.vencido || 0) - totalDe(c, 'vencido') - Number(c.devuelto || 0));
// Registro (lote + sucursal) cerrado: ya pasó a vencido o está todo vendido. No se lista; queda en el historial.
const estaCerrado = c => vencidosDe(c).length > 0 || pendienteDe(c) <= 0;
// Listas filtradas aparte: estado.datos.lotes queda completo (el historial resuelve PLU/producto contra él).
const activoEn = (l, suc) => !!l.sucursales[suc] && !estaCerrado(l.sucursales[suc]);
const clavesActivas = suc => new Set(estado.datos.lotes.filter(l => activoEn(l, suc)).map(l => l.id));
const textoDias = d => (d < 0 ? `vencido hace ${fmtNum(-d)} ${d === -1 ? 'día' : 'días'}` : d === 0 ? 'vence hoy' : `en ${fmtNum(d)} ${d === 1 ? 'día' : 'días'}`);
// Umbral de aviso: diasAviso de la config si el server lo manda; si no, el umbral rojo.
const diasAviso = () => { const d = estado.datos; const v = d.diasAviso ?? (d.config && d.config.diasAviso); return Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : d.umbrales.rojo; };
function validarConfigCliente(c) {
  for (const k of ['tipoOferta', 'tipoNoVendido', 'tipoOfertaVencida']) {
    if (c[k] === undefined) continue;
    if (!c[k].trim() || c[k].trim().length > 50) return 'Los tipos de movimiento no pueden estar vacíos ni pasar de 50 caracteres.';
  }
  if (c.depositoMovimientos !== undefined && !esEnteroPositivo(c.depositoMovimientos)) return 'El depósito tiene que ser un entero mayor a 0.';
  if (c.diasMaxOferta !== undefined && !(/^\d+$/.test(String(c.diasMaxOferta).trim()) && Number(c.diasMaxOferta) >= 1 && Number(c.diasMaxOferta) <= 365)) return 'Los días máximos para movimientos PARA OFERTA tienen que ser un entero entre 1 y 365.';
  if (c.diasMaxVencido !== undefined && !(/^\d+$/.test(String(c.diasMaxVencido).trim()) && Number(c.diasMaxVencido) >= 1 && Number(c.diasMaxVencido) <= 365)) return 'Los días máximos para movimientos de vencidos tienen que ser un entero entre 1 y 365.';
  if (c.diasAntesVencimientoOferta !== undefined && !(/^\d+$/.test(String(c.diasAntesVencimientoOferta).trim()) && Number(c.diasAntesVencimientoOferta) <= 60)) return 'Los días antes del vencimiento para cerrar la oferta tienen que ser un entero entre 0 y 60.';
  for (const k of ['diasAviso', 'margenDias']) if (c[k] !== undefined && !/^\d+$/.test(String(c[k]).trim())) return 'Los días de aviso y margen tienen que ser enteros mayores o iguales a 0.';
  return '';
}

// Punto de color simple; el texto accesible va oculto y en tooltip.
function pillSemaforo(lote) {
  const txt = lote.semaforo === 'rojo' && lote.dias < 0 ? 'Vencido' : SEMAFORO[lote.semaforo] || lote.semaforo;
  return `<span class="dot dot--${esc(lote.semaforo)}" title="${esc(txt)}" aria-hidden="true"></span><span class="sr-only">${esc(txt)}: </span>`;
}
const celdaPlu = v => `<td class="plu">${esc(v || '—')}</td>`;
// Ventas de la sucursal asignada al usuario (admin: la activa); null si no hay datos para el lote.
const ventasDe = idLote => (estado.ventas && estado.ventas[idLote]) || null;
const fmtDec = n => Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nombreProd = l => esc(l.nombre || `Producto ${l.idProducto}`);
const celdaProducto = l => nombreProd(l);
// Producto con el PLU en gris en la misma celda; los lotes cerrados lo dicen en texto oculto.
const celdaProductoPlu = (l, plu, cerrado) => `<div>${nombreProd(l)}${cerrado ? '<span class="sr-only"> (cerrado)</span>' : ''}</div><span class="plu">PLU ${esc(plu || '—')}</span>`;

function esEnteroPositivo(v) { return /^\d+$/.test(String(v).trim()) && Number(v) > 0; }
function validarUmbralesCliente(rojo, amarillo) {
  if (![rojo, amarillo].every(v => /^\d+$/.test(String(v).trim()))) return 'Los umbrales tienen que ser enteros mayores o iguales a 0.';
  if (Number(rojo) >= Number(amarillo)) return 'El umbral rojo debe ser menor que el amarillo.';
  return '';
}

// ── Modales ───────────────────────────────────────────────────────────────────
let abridor = null;
function abrirModal(id, focoId) {
  abridor = document.activeElement;
  $(id).hidden = false;
  const foco = $(focoId); if (foco) foco.focus();
}
function cerrarModal(id) {
  $(id).hidden = true;
  if (abridor && abridor.isConnected && !abridor.closest('.velo[hidden]')) abridor.focus();
}
function mostrarError(id, msg) { const e = $(id); e.textContent = msg; e.hidden = !msg; }
document.querySelectorAll('.velo').forEach(v => {
  v.querySelectorAll('[data-cerrar]').forEach(b => b.addEventListener('click', () => cerrarModal(v.id)));
  v.addEventListener('mousedown', e => { if (e.target === v) cerrarModal(v.id); });
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const abierto = [...document.querySelectorAll('.velo')].filter(v => !v.hidden).pop();
  if (abierto) cerrarModal(abierto.id);
});

// Envía con el botón deshabilitado; muestra el error del server en el modal.
async function enviar(botonId, errorId, tarea) {
  const btn = $(botonId), txt = btn.textContent;
  btn.disabled = true; btn.textContent = 'Guardando…'; mostrarError(errorId, '');
  try { await tarea(); return true; } catch (e) { mostrarError(errorId, e.message); return false; }
  finally { btn.disabled = false; btn.textContent = txt; }
}

// ── Carga ─────────────────────────────────────────────────────────────────────
async function cargarSucursales() {
  try {
    const lista = await api('/api/sucursales');
    estado.nombres = Object.fromEntries((Array.isArray(lista) ? lista : []).map(s => [s.id, s.nombre]));
  } catch (_) { /* sin nombres: se muestra "Suc. N" */ }
}

// Ventas automáticas: no bloquea el render; si falla, las columnas muestran "—".
async function cargarVentas() {
  let aviso = '', texto = '';
  const esAdmin = estado.datos && estado.datos.usuario.esAdmin;
  if (esAdmin) resolverSucursal();
  const pedida = esAdmin ? estado.miSucursal : null; // usuario normal: el server usa la suya
  try {
    const v = await api(`/api/vencimientos/ventas${esAdmin && pedida ? `?idSucursal=${encodeURIComponent(pedida)}` : ''}`);
    if (esAdmin && pedida !== estado.miSucursal) return; // el admin cambió de sucursal mientras cargaba
    estado.ventas = v && v.ventasDisponible ? (v.ventas || {}) : null;
    if (!estado.ventas) { texto = 'Ventas no disponibles'; aviso = (v && v.mensaje) || ''; }
    else if (v.mensaje) texto = v.mensaje; // ej. 'Sin sucursal asignada': celdas en "—"
    if (estado.ventas && v.mensaje) estado.ventas = null;
  } catch (e) { estado.ventas = null; texto = 'Ventas no disponibles'; aviso = e.message; }
  $('ventasAviso').textContent = texto;
  $('ventasAviso').title = aviso;
  if (estado.datos && estado.tabActiva === 'mia') renderMia();
  if (estado.datos) renderOtras();
}

// Devuelve true si algún registro activo de la sucursal activa pasó a cerrado con esta recarga.
async function cargarLotes() {
  let antes = null;
  if (estado.datos) { resolverSucursal(); antes = clavesActivas(String(estado.miSucursal || '')); }
  $('listadoMsg').innerHTML = '<div class="msg-vacio"><span class="spin"></span> Cargando…</div>';
  try {
    estado.datos = await api('/api/vencimientos/lotes');
  } catch (e) {
    $('listadoMsg').innerHTML = `<div class="error-box" role="alert">${esc(e.message)}</div>`;
    return false;
  }
  $('listadoMsg').innerHTML = '';
  cerrarMenu(); // el registro del menú puede haber salido de la tabla
  const sucAct = String(estado.miSucursal || '');
  const seCerro = !!antes && estado.datos.lotes.some(l => antes.has(l.id) && l.sucursales[sucAct] && estaCerrado(l.sucursales[sucAct]));
  const { umbrales } = estado.datos;
  $('btnUmbrales').hidden = !estado.datos.usuario.esAdmin;
  $('umbralesTxt').textContent = `Rojo ≤ ${umbrales.rojo} d · Amarillo ≤ ${umbrales.amarillo} d · Verde > ${umbrales.amarillo} d`;
  renderCarga();
  renderAvisos();
  renderOtras();
  cargarVentas();
  if (estado.tabActiva === 'mia') renderMia();
  if (estado.tabActiva === 'hist') renderHist();
  return seCerro;
}

// ── Otras sucursales (sin cantidades) ─────────────────────────────────────────
function renderOtras() {
  if (!estado.datos) return;
  const { usuario, lotes } = estado.datos;
  const txt = $('fOtrasTexto').value.trim().toLowerCase();
  const propia = String(usuario.idSucursal || '');
  const filas = [];
  lotes.forEach(l => {
    if (txt && !`${l.nombre || ''} ${l.codigo || ''} ${l.idProducto}`.toLowerCase().includes(txt)) return;
    Object.keys(l.sucursales).forEach(suc => { if ((!propia || suc !== propia) && activoEn(l, suc)) filas.push({ l, suc }); });
  });
  filas.sort((x, y) => String(x.l.vencimiento).localeCompare(String(y.l.vencimiento)) || nombreSuc(x.suc).localeCompare(nombreSuc(y.suc)));
  if (!filas.length) {
    $('tablaOtras').innerHTML = '';
    $('otrasMsg').innerHTML = `<div class="msg-vacio">${txt ? 'Ningún lote de otras sucursales coincide.' : 'No hay vencimientos activos en otras sucursales.'}</div>`;
    return;
  }
  $('otrasMsg').innerHTML = '';
  $('tablaOtras').innerHTML = `<thead><tr><th>PLU</th><th>Producto</th><th>Sucursal</th><th>Vence</th><th class="num" title="Ventas promedio por mes del producto en tu sucursal, últimos 12 meses">Prom. mensual (12 m)</th></tr></thead><tbody>${filas.map(({ l, suc }) =>
    `<tr>${celdaPlu(l.idProducto)}<td>${celdaProducto(l)}</td><td>${esc(nombreSuc(suc))}</td><td class="whitespace-nowrap">${pillSemaforo(l)}${esc(fmtFecha(l.vencimiento))}</td>${celdaProm(l)}</tr>`).join('')}</tbody>`;
}
$('fOtrasTexto').addEventListener('input', renderOtras);

// ── Avisos y huérfanos ────────────────────────────────────────────────────────
// Lotes de la sucursal activa sin movimiento PARA OFERTA asignado, con pendiente y cerca de vencer (regla en el cliente).
function lotesSinOferta() {
  if (!estado.datos || esSinOferta()) return [];
  resolverSucursal();
  const suc = String(estado.miSucursal || ''), tope = diasAviso();
  return estado.datos.lotes.filter(l => { const c = l.sucursales[suc]; return activoEn(l, suc) && !ofertasDe(c).length && l.dias <= tope; })
    .sort((a, b) => String(a.vencimiento).localeCompare(String(b.vencimiento)));
}
const loteAlerta = l => lotesSinOferta().some(x => x.id === l.id);

function renderAvisos() {
  const banda = $('avisosBanda');
  const avisos = lotesSinOferta();
  if (!avisos.length) { banda.hidden = true; banda.innerHTML = ''; return; }
  const chips = avisos.map(l => `<button type="button" class="chip${estado.filtroLote === l.id ? ' on' : ''}" data-aviso="${esc(l.id)}" aria-pressed="${estado.filtroLote === l.id}" title="Vence ${esc(fmtFecha(l.vencimiento))}: falta pasar a oferta">${esc(l.nombre || l.idProducto)}</button>`).join(' · ');
  banda.hidden = false;
  banda.innerHTML = `<span class="font-medium text-ink">${avisos.length} ${avisos.length === 1 ? 'aviso' : 'avisos'}</span> sin pasar a oferta: ${chips}${estado.filtroLote ? ' <button type="button" class="chip" data-aviso="">Quitar filtro</button>' : ''}`;
}
$('avisosBanda').addEventListener('click', e => {
  const b = e.target.closest('[data-aviso]'); if (!b) return;
  const id = b.dataset.aviso;
  estado.filtroLote = id && id !== estado.filtroLote ? id : null;
  renderAvisos(); if (estado.tabActiva === 'mia') renderMisLotes();
});

// ── Alta ──────────────────────────────────────────────────────────────────────
let timerBusqueda = null, secBusqueda = 0;

// Sucursal de la carga: la del usuario (texto fijo).
function renderCarga() {
  const { usuario } = estado.datos;
  const sinSucursal = !usuario.idSucursal;
  $('cargaAviso').innerHTML = sinSucursal ? '<div class="error-box">Tu usuario no tiene sucursal asignada. Pedile al administrador que la configure.</div>' : '';
  $('formAlta').hidden = sinSucursal;
  if (sinSucursal) return;
  $('altaSucTxt').textContent = nombreSuc(usuario.idSucursal);
}

function limpiarAlta() {
  estado.productoElegido = null;
  ['altaBuscar', 'altaFecha', 'altaUnid'].forEach(id => { $(id).value = ''; });
  $('altaElegido').textContent = ''; $('altaOpciones').hidden = true;
}

async function buscarProductos() {
  const q = $('altaBuscar').value.trim();
  const caja = $('altaOpciones');
  const seq = ++secBusqueda;
  if (q.length < MIN_BUSQUEDA) { caja.hidden = true; return; }
  caja.hidden = false; caja.innerHTML = '<div class="msg-vacio"><span class="spin"></span> Buscando…</div>';
  try {
    const lista = await api(`/api/vencimientos/productos?q=${encodeURIComponent(q)}`);
    if (seq !== secBusqueda) return;
    estado.resultados = lista;
    caja.innerHTML = lista.length
      ? lista.map((p, i) => `<button type="button" class="opcion" data-i="${i}"><span class="plu">${esc(p.idProducto)}</span> ${esc(p.nombre)}<small>${esc(p.codigo || p.idProducto)}</small></button>`).join('')
      : '<div class="msg-vacio">Sin resultados.</div>';
  } catch (e) {
    if (seq === secBusqueda) caja.innerHTML = `<div class="error-box" role="alert">${esc(e.message)}</div>`;
  }
}

$('altaBuscar').addEventListener('input', () => {
  estado.productoElegido = null; $('altaElegido').textContent = '';
  clearTimeout(timerBusqueda); timerBusqueda = setTimeout(buscarProductos, DEBOUNCE_MS);
});
$('altaOpciones').addEventListener('click', e => {
  const b = e.target.closest('[data-i]'); if (!b) return;
  estado.productoElegido = estado.resultados[Number(b.dataset.i)];
  $('altaElegido').textContent = `Elegido: PLU ${estado.productoElegido.idProducto} · ${estado.productoElegido.nombre}`;
  $('altaBuscar').value = estado.productoElegido.nombre;
  $('altaOpciones').hidden = true;
  $('altaFecha').focus();
});

$('formAlta').addEventListener('submit', async e => {
  e.preventDefault();
  $('altaExito').hidden = true;
  const p = estado.productoElegido, fecha = $('altaFecha').value, unid = $('altaUnid').value;
  if (!p) return mostrarError('altaError', 'Elegí un producto de la lista.');
  if (!fecha) return mostrarError('altaError', 'Indicá la fecha de vencimiento.');
  if (!esEnteroPositivo(unid)) return mostrarError('altaError', 'Las unidades tienen que ser un entero mayor a 0.');
  const body = { idProducto: p.idProducto, nombre: p.nombre, codigo: p.codigo, vencimiento: fecha, unidades: Number(unid) };
  const { usuario } = estado.datos;
  if (usuario.esAdmin) body.idSucursal = Number(usuario.idSucursal);
  const ok = await enviar('altaOk', 'altaError', () => api('/api/vencimientos/lotes', { method: 'POST', body }));
  if (!ok) return;
  limpiarAlta();
  $('altaExito').textContent = `Vencimiento cargado: ${p.nombre} (vence ${fmtFecha(fecha)}, ${fmtNum(unid)} unidades).`;
  $('altaExito').hidden = false;
  $('altaBuscar').focus();
  await cargarLotes();
});

// ── Borrar (admin) ────────────────────────────────────────────────────────────
let loteBorrar = null;
const alBorrar = e => {
  const b = e.target.closest('[data-borrar]'); if (!b) return;
  loteBorrar = estado.datos.lotes.find(l => l.id === b.dataset.borrar); if (!loteBorrar) return;
  $('mDelTxt').textContent = `Se borra el lote de "${loteBorrar.nombre || loteBorrar.idProducto}" (vence ${fmtFecha(loteBorrar.vencimiento)}) con las unidades de todas las sucursales. No se puede deshacer.`;
  mostrarError('delError', ''); abrirModal('mDel', 'delOk');
  $('mDel').querySelector('[data-cerrar]').focus();
};
$('tablaMia').addEventListener('click', alBorrar);
$('menuFila').addEventListener('click', alBorrar);
$('mDel').querySelector('form').addEventListener('submit', async e => {
  e.preventDefault();
  const ok = await enviar('delOk', 'delError', () => api(`/api/vencimientos/lotes/${encodeURIComponent(loteBorrar.id)}`, { method: 'DELETE' }));
  if (ok) { cerrarModal('mDel'); await cargarLotes(); }
});

// ── Configuración (solo admin) ─────────────────────────────────────────────────────
const CAMPOS_CFG = { diasMaxOferta: 'cfgDiasMaxOferta', diasAntesVencimientoOferta: 'cfgDiasAntesOferta', diasMaxVencido: 'cfgDiasMaxVencido', tipoOfertaVencida: 'cfgOfertaVencida', tipoOferta: 'cfgOferta', tipoNoVendido: 'cfgNoVendido', depositoMovimientos: 'cfgDeposito', diasAviso: 'cfgDiasAviso', margenDias: 'cfgMargen' };
function avisoExito(msg) {
  const a = $('avisoGlobal'); a.textContent = msg; a.hidden = false;
  clearTimeout(avisoExito.t); avisoExito.t = setTimeout(() => { a.hidden = true; }, 5000);
}
$('btnUmbrales').addEventListener('click', async () => {
  if (!estado.datos.usuario.esAdmin) return;
  $('cfgMiSucNombre').textContent = nombreSuc(estado.datos.usuario.idSucursal);
  mostrarError('umbError', '');
  $('umbRojo').value = estado.datos.umbrales.rojo; $('umbAmarillo').value = estado.datos.umbrales.amarillo;
  Object.values(CAMPOS_CFG).forEach(id => { $(id).value = ''; });
  abrirModal('mUmb', 'umbRojo');
  try {
    const cfg = await api('/api/vencimientos/config');
    Object.entries(CAMPOS_CFG).forEach(([k, id]) => { if (cfg[k] !== undefined) $(id).value = cfg[k]; });
  } catch (e) { mostrarError('umbError', `No se pudo leer la configuración del cruce: ${e.message}`); }
});
$('mUmb').querySelector('form').addEventListener('submit', async e => {
  e.preventDefault();
  if (!estado.datos.usuario.esAdmin) return;
  const rojo = $('umbRojo').value, amarillo = $('umbAmarillo').value;
  const err = validarUmbralesCliente(rojo, amarillo);
  if (err) return mostrarError('umbError', err);
  const extra = {};
  Object.entries(CAMPOS_CFG).forEach(([k, id]) => { const v = $(id).value.trim(); if (v !== '') extra[k] = v; });
  const errCfg = validarConfigCliente(extra);
  if (errCfg) return mostrarError('umbError', errCfg);
  ['depositoMovimientos', 'diasAviso', 'margenDias', 'diasMaxOferta', 'diasMaxVencido', 'diasAntesVencimientoOferta'].forEach(k => { if (extra[k] !== undefined) extra[k] = Number(extra[k]); });
  const bodyCfg = { umbrales: { rojo: Number(rojo), amarillo: Number(amarillo) }, ...extra };
  const ok = await enviar('umbOk', 'umbError', () => api('/api/vencimientos/config', { method: 'PUT', body: bodyCfg }));
  if (!ok) return;
  cerrarModal('mUmb');
  await cargarLotes(); // refresca umbrales y re-renderiza
  avisoExito('Configuración guardada.');
});

// ── Mi sucursal ───────────────────────────────────────────────────────────────
function renderMia() {
  const { usuario } = estado.datos;
  const sinSucursal = !usuario.idSucursal;
  $('miaAviso').innerHTML = sinSucursal ? '<div class="error-box">Tu usuario no tiene sucursal asignada. Pedile al administrador que la configure.</div>' : '';
  $('miaContenido').hidden = sinSucursal;
  if (sinSucursal) return;
  resolverSucursal();
  $('miaTitulo').textContent = nombreSuc(estado.miSucursal);
  renderMisLotes();
}

// Sucursal activa: siempre la preferida del usuario (también admin; se asigna en Administración).
function resolverSucursal() {
  estado.miSucursal = Number(estado.datos.usuario.idSucursal) || null;
}

function renderHist() {
  resolverSucursal();
  if (!estado.miSucursal) { $('tablaHist').innerHTML = ''; $('histMsg').innerHTML = '<div class="msg-vacio">No hay sucursales para mostrar.</div>'; return; }
  $('histTitulo').textContent = nombreSuc(estado.miSucursal);
  cargarHistorial();
}

function celdasVentas(l) {
  const v = ventasDe(l.id);
  return v ? `<td class="num">${fmtNum(v.vendidoDesdeCarga)}</td><td class="num">${fmtDec(v.promMensual12)}</td>` : '<td class="num">—</td><td class="num">—</td>';
}
const celdaProm = l => { const v = ventasDe(l.id); return `<td class="num">${v ? fmtDec(v.promMensual12) : '—'}</td>`; };

// Con movimientos en oferta el valor vigente es el total del sistema: lo cargado se muestra tachado (solo presentación).
function celdaCargado(c) {
  const conOferta = ofertasDe(c).length > 0;
  if (!conOferta && !vencidosDe(c).length) return `<td class="num">${fmtNum(c.unidades)}</td>`;
  const dest = conOferta ? 'en oferta' : 'vencido';
  const tip = `Las unidades cargadas ya no rigen: el valor real es el total ${dest}`;
  return `<td class="num cel-off" aria-disabled="true" title="${esc(tip)}"><s><span class="sr-only">Cargadas originalmente: </span>${fmtNum(c.unidades)}<span class="sr-only"> (reemplazado por el total ${dest})</span></s></td>`;
}

// Total del sistema arriba; abajo el estado en texto (OK / Corregir / Confirmar). Detalle por movimiento en tooltip y texto oculto.
// atenuado: el escalón ya no rige (hay movimientos del siguiente): total tachado y estado sin botón.
function estadoCel(l, c, k, atenuado) {
  const e = c[CLASES[k].est], id = esc(l.id);
  if (e === 'ok') return '<span class="est est-ok">OK</span>';
  if (atenuado) return `<span class="est ${e === 'corregir' ? 'est-corr' : 'est-pend'}">${e === 'corregir' ? 'Corregir' : 'Confirmar'}</span>`;
  const btn = (cls, txt) => `<button type="button" class="lnk est ${cls}" ${CLASES[k].cmpAttr}="${id}" aria-label="${txt} cantidades de ${esc(l.nombre || l.idProducto)}">${txt}</button>`;
  return e === 'corregir' ? btn('est-corr', 'Corregir') : btn('est-pend', 'Confirmar');
}
function celdaSistema(l, c, k, atenuado, tip) {
  const det = movsDe(c, k).map(o => `Mov. N° ${o.numeroMovimiento} · ${fmtFecha(o.fecha)} · ${fmtNum(o.cantidad)} u.`);
  const total = fmtNum(totalDe(c, k));
  if (atenuado) return `<td class="cel-off" aria-disabled="true" title="${esc(`${tip}\n${det.join('\n')}`)}"><div class="cel-of"><s><span class="sr-only">En oferta: </span><strong class="cel-on">${total}</strong><span class="sr-only"> (reemplazado por el total vencido)</span></s><span class="est-dim">${estadoCel(l, c, k, true)}</span></div></td>`;
  return `<td title="${esc(det.join('\n'))}"><div class="cel-of"><strong class="cel-on">${total}</strong>${estadoCel(l, c, k)}</div><span class="sr-only">Total sistema. Movimientos: ${esc(det.join('; '))}</span></td>`;
}
function celdaDevuelto(c) {
  const d = devueltoDe(c);
  return d > 0 ? `<td class="num">${fmtNum(d)}</td>` : '<td class="text-gris">—</td>';
}
function celdaOferta(l, c) {
  if (!ofertasDe(c).length) return '<td class="text-gris">—</td>';
  return celdaSistema(l, c, 'oferta', vencidosDe(c).length > 0, 'La oferta ya no rige: el valor real es el total vencido');
}
function celdaVencido(l, c) {
  if (vencidosDe(c).length) return celdaSistema(l, c, 'vencido', false);
  const viejo = Number(c.vencido || 0); // valor manual histórico
  return viejo > 0 ? `<td class="num cel-off" title="Vencido cargado antes de usar movimientos de SIGA">${fmtNum(viejo)}</td>` : '<td class="text-gris">—</td>';
}

// Etapa actual del registro: vencido > oferta > cargado. Resalta su celda (con texto oculto y title, no solo color).
const etapaDe = c => (vencidosDe(c).length ? 'vencido' : esSinOferta() && devueltoDe(c) > 0 ? 'devuelto' : ofertasDe(c).length ? 'oferta' : 'cargado');
const NOMBRE_ETAPA = { cargado: 'Cargado', oferta: 'En oferta', devuelto: 'Devuelto a Central', vencido: 'Vencido' };
function conEtapa(html, c, etapa) {
  if (etapaDe(c) !== etapa) return html;
  const nombre = `Etapa actual: ${NOMBRE_ETAPA[etapa]}`;
  const abre = html.match(/^<td[^>]*>/)[0];
  let nueva = /class="/.test(abre) ? abre.replace('class="', 'class="etapa ') : abre.replace('<td', '<td class="etapa"');
  if (!/title=/.test(nueva)) nueva = nueva.replace('<td', `<td title="${nombre}"`);
  // La pastilla envuelve solo el número principal (el resto de la celda no se resalta).
  let cuerpo = html.slice(abre.length);
  cuerpo = cuerpo.includes('class="cel-on"') ? cuerpo.replace('class="cel-on"', 'class="cel-on etapa-num"') : cuerpo.replace(/^[^<]+/, '<span class="etapa-num">$&</span>');
  return nueva + cuerpo.replace(/<\/td>$/, `<span class="sr-only">${nombre}</span></td>`);
}

function celdaAcciones(l, c, pend) {
  const nom = esc(l.nombre || l.idProducto), id = esc(l.id), cerrado = pend === 0;
  const sinOferta = !ofertasDe(c).length, noOferta = esSinOferta();
  const sinPend = 'Sin unidades pendientes';
  const bt = (attr, cls, icono, txt, off, tipOk) => { const tip = off ? sinPend : tipOk; return `<button type="button" class="acc ${cls}" ${attr}="${id}" ${off ? 'disabled' : ''}${tip ? ` title="${esc(tip)}"` : ''} aria-label="${txt} de ${nom}${tip ? ` (${esc(tip)})` : ''}">${icono}<span>${txt}</span></button>`; };
  const svg = p => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  const iTag = svg('<path d="M2 8.5V2.5h6l6 6-5.5 5.5z"/><circle cx="5.2" cy="5.2" r=".9" fill="currentColor"/>');
  const iVenc = svg('<rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M6 9l4 3.5M10 9l-4 3.5"/>');
  const iOk = svg('<path d="M3 8.5l3.2 3.2L13 4.8"/>');
  return `<td><div class="acciones">${noOferta ? bt('data-devuelto', 'acc-of', iTag, 'Devuelto a Central', cerrado, 'Cargar unidades devueltas a Central') : bt('data-of', 'acc-of', iTag, sinOferta ? 'Pasar a oferta' : 'Agregar movimiento', cerrado)}${bt('data-vencido', 'acc-venc', iVenc, 'Vencido', cerrado, sinOferta && !noOferta ? 'Pasar directo a vencido, sin oferta' : '')}${bt('data-vendido', 'acc-vend', iOk, 'Vendido', cerrado, 'Marcar todo como vendido')}<button type="button" class="acc acc-mas" data-menu="${id}" aria-haspopup="menu" aria-expanded="false" aria-controls="menuFila" aria-label="Más acciones de ${nom}" title="Más acciones">⋯</button></div></td>`;
}

// Menú "⋯": una sola lista flotante (position fixed, no la recorta el scroll de la tabla).
let menuBtn = null;
function cerrarMenu(devolverFoco) {
  const m = $('menuFila');
  if (m.hidden) return;
  m.hidden = true;
  if (menuBtn) { menuBtn.setAttribute('aria-expanded', 'false'); if (devolverFoco) menuBtn.focus(); }
}
function abrirMenu(btn) {
  const m = $('menuFila'), id = esc(btn.dataset.menu), nom = esc((loteDe(btn.dataset.menu) || {}).nombre || '');
  menuBtn = btn;
  const item = (attr, txt, cls) => `<button type="button" role="menuitem" class="mitem${cls || ''}" ${attr}="${id}" aria-label="${txt} de ${nom}">${txt}</button>`;
  const conOferta = ofertasDe(colDe(loteDe(btn.dataset.menu) || { sucursales: {} }) || {}).length > 0;
  const corregir = conOferta
    ? `<button type="button" role="menuitem" class="mitem mitem--off" aria-disabled="true" title="Quitá los movimientos de oferta para corregir las unidades cargadas" aria-label="Corregir unidades de ${nom} (no disponible: quitá los movimientos de oferta)">Corregir unidades</button>`
    : item('data-corregir', 'Corregir unidades');
  m.innerHTML = corregir + (estado.datos.usuario.esAdmin ? item('data-borrar', 'Borrar lote', ' mitem--peligro') : '');
  m.hidden = false;
  const r = btn.getBoundingClientRect();
  m.style.top = `${Math.min(r.bottom + 2, window.innerHeight - m.offsetHeight - 8)}px`;
  m.style.left = `${Math.max(8, r.right - m.offsetWidth)}px`;
  btn.setAttribute('aria-expanded', 'true');
  m.querySelector('.mitem').focus();
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-menu]');
  if (b) { const abierto = !$('menuFila').hidden && menuBtn === b; cerrarMenu(); if (!abierto) abrirMenu(b); return; }
  if (!e.target.closest('#menuFila')) cerrarMenu();
});
// Al elegir un ítem se cierra antes (captura) para que el modal recuerde el botón "⋯" como abridor.
$('menuFila').addEventListener('click', () => cerrarMenu(true), true);
document.addEventListener('keydown', e => {
  if ($('menuFila').hidden) return;
  if (e.key === 'Escape') { e.stopImmediatePropagation(); cerrarMenu(true); return; }
  if (e.key === 'Tab') cerrarMenu();
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const items = [...$('menuFila').querySelectorAll('.mitem')], i = items.indexOf(document.activeElement);
  e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
}, true);
window.addEventListener('resize', () => cerrarMenu());
window.addEventListener('scroll', () => cerrarMenu(), true);

function renderMisLotes() {
  const suc = String(estado.miSucursal), noOf = esSinOferta();
  const lotes = estado.datos.lotes.filter(l => activoEn(l, suc) && (!estado.filtroLote || l.id === estado.filtroLote));
  $('miaMsg').innerHTML = lotes.length ? '' : '<div class="msg-vacio">No hay vencimientos activos</div>';
  if (!lotes.length) { $('tablaMia').innerHTML = ''; return; }
  const filas = lotes.map(l => {
    const c = l.sucursales[suc], pend = pendienteDe(c), alerta = loteAlerta(l);
    return `<tr class="${alerta ? 'alerta' : ''}"${alerta ? ' title="Falta pasar a oferta"' : ''}><td>${celdaProductoPlu(l, l.idProducto)}</td>
      <td class="whitespace-nowrap">${pillSemaforo(l)}${esc(fmtFecha(l.vencimiento))}<span class="sub">${esc(textoDias(l.dias))}</span></td>
      ${conEtapa(celdaCargado(c), c, 'cargado')}${noOf ? conEtapa(celdaDevuelto(c), c, 'devuelto') : conEtapa(celdaOferta(l, c), c, 'oferta')}<td class="num">${fmtNum(c.vendido)}</td>${conEtapa(celdaVencido(l, c), c, 'vencido')}${celdasVentas(l)}${celdaAcciones(l, c, pend)}</tr>`;
  }).join('');
  $('tablaMia').innerHTML = `<thead><tr><th>Producto</th><th>Vence</th><th class="num" title="Unidades cargadas del lote en esta sucursal">Cargado</th>${noOf ? '<th class="num" title="Unidades devueltas a Central">Devuelto a Central</th>' : '<th title="Total de los movimientos PARA OFERTA de SIGA asignados a este registro">En oferta</th>'}<th class="num">Vendido</th><th title="Total de los movimientos ${noOf ? '' : 'OFERTA '}VENCIDO de SIGA asignados a este registro">Vencido</th><th class="num" title="Unidades vendidas del producto en esta sucursal desde que se cargó el lote (conteo automático de ventas)">Vendidas desde carga</th><th class="num" title="Ventas promedio por mes del producto en esta sucursal, últimos 12 meses">Prom. mensual (12 m)</th><th><span class="sr-only">Acciones</span></th></tr></thead><tbody>${filas}</tbody>`;
}

// Historial: un registro (idLote) por fila desplegable; la línea de tiempo lista todos sus movimientos.
const ETAPA_TXT = { cargado: 'Cargado', oferta: 'En oferta', devuelto: 'Devuelto a Central', vencido: 'Vencido', vendido: 'Vendido' };
// Movimientos que cambian de etapa -> clase de color.
const ETAPA_DE_TIPO = { 'devuelto-central': 'devuelto', 'oferta-sistema': 'oferta', oferta: 'oferta', 'vencido-sistema': 'vencido', vencido: 'vencido', vendido: 'vendido' };
const QUITADA = { 'oferta-sistema-quitada': 'oferta', 'vencido-sistema-quitada': 'vencido' };
const TIPOS_CON_MOV = ['oferta-sistema', 'oferta-sistema-quitada', 'vencido-sistema', 'vencido-sistema-quitada'];
const tiempo = m => { const t = new Date(m.fecha).getTime(); return isNaN(t) ? 0 : t; };
const nMovDe = m => m.numeroMovimiento ?? m.movimiento;
const esConfirmacion = m => m.tipo === 'oferta-confirmacion' || m.tipo === 'vencido-confirmacion';
const marcaCorregir = m => esConfirmacion(m) && (m.estado === 'corregir' || m.confirmacion === 'corregir');

// Etapa vigente: el último cambio de etapa (por fecha) que no fue revertido por un "quitado" del mismo movimiento.
function etapaRegistro(movs) {
  const vigente = new Map(); // `${etapa}:${nMov}` -> { etapa, t }
  for (const m of movs) { // ascendente
    const etapa = ETAPA_DE_TIPO[m.tipo] || QUITADA[m.tipo];
    if (!etapa) continue;
    const k = `${etapa}:${nMovDe(m) ?? ''}`;
    if (ETAPA_DE_TIPO[m.tipo]) vigente.set(k, { etapa, t: tiempo(m) }); else vigente.delete(k);
  }
  let r = { etapa: 'cargado', t: -1 };
  for (const v of vigente.values()) if (v.t >= r.t) r = v;
  return r.etapa;
}

function textoMov(m) {
  const n = nMovDe(m);
  if (esConfirmacion(m)) return marcaCorregir(m) ? 'Marcado para corregir' : 'Cantidades confirmadas';
  if (TIPOS_CON_MOV.includes(m.tipo) && n !== undefined) return `${TIPO_MOV[m.tipo]} (Mov. N° ${n})`;
  if (m.tipo === 'correccion' && m.anterior !== undefined) return `${TIPO_MOV.correccion} de unidades (antes ${fmtNum(m.anterior)})`;
  return TIPO_MOV[m.tipo] || m.tipo;
}

function filaEvento(m) {
  const cant = m.cantidad ?? m.cantidadSistema ?? m.unidades;
  const cls = ETAPA_DE_TIPO[m.tipo] ? `et et-${ETAPA_DE_TIPO[m.tipo]}` : marcaCorregir(m) ? 'et et-corregir' : '';
  return `<li class="hist-ev ${cls}"><span>${esc(fmtFechaHora(m.fecha))}</span><span>${esc(textoMov(m))}</span><span class="num">${cant === undefined || cant === null ? '—' : fmtNum(cant)}</span><span>${esc(m.usuario)}</span></li>`;
}

function htmlRegistro(id, movs) {
  const asc = [...movs].sort((a, b) => tiempo(a) - tiempo(b));
  const lote = estado.datos.lotes.find(l => l.id === id) || {};
  const plu = asc.map(m => m.idProducto).find(Boolean) || lote.idProducto || '';
  const nombre = asc.map(m => m.nombre).find(Boolean) || lote.nombre || `Producto ${plu}`;
  const venc = asc.map(m => m.vencimiento).find(Boolean) || lote.vencimiento;
  const etapa = etapaRegistro(asc);
  const abierto = estado.histAbiertos.has(id) ? ' open' : '';
  return `<details class="hist-reg" data-id="${esc(id)}"${abierto}><summary aria-label="${esc(`${nombre}, PLU ${plu}, ${ETAPA_TXT[etapa]}`)}"><span class="hist-chev" aria-hidden="true"></span><span class="plu">${esc(plu || '—')}</span><span class="hist-nom" title="${esc(nombre)}">${esc(nombre)}</span><span class="whitespace-nowrap">${venc ? esc(fmtFecha(venc)) : '—'}</span><span class="hist-etapa et-${etapa}">${ETAPA_TXT[etapa]}</span><button type="button" class="hist-del" data-eliminar-reg="${esc(id)}" data-nombre="${esc(nombre)}" data-plu="${esc(plu)}" data-venc="${venc ? esc(fmtFecha(venc)) : ''}" aria-label="${esc(`Eliminar registro de ${nombre} (PLU ${plu})`)}" title="Eliminar registro"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9h6.6l.7-9M6.5 6.5v4.5M9.5 6.5v4.5"/></svg></button></summary><ol class="hist-lin" aria-label="Movimientos del registro">${asc.map(filaEvento).join('')}</ol></details>`;
}

function htmlHistorial(movimientos) {
  const grupos = new Map();
  for (const m of movimientos) { const id = m.idLote || m.id; if (!grupos.has(id)) grupos.set(id, []); grupos.get(id).push(m); }
  const ult = g => Math.max(...g.map(tiempo));
  const reg = [...grupos].sort((a, b) => ult(b[1]) - ult(a[1]));
  return `<div class="hist-cab" aria-hidden="true"><span></span><span>PLU</span><span>Producto</span><span>Vencimiento</span><span>Etapa</span><span></span></div>${reg.map(([id, g]) => htmlRegistro(id, g)).join('')}`;
}

// Recuerda qué registros abrió el usuario para que la recarga no los cierre.
$('tablaHist').addEventListener('toggle', e => {
  const d = e.target.closest && e.target.closest('details.hist-reg');
  if (!d) return;
  if (d.open) estado.histAbiertos.add(d.dataset.id); else estado.histAbiertos.delete(d.dataset.id);
}, true);

// Eliminar registro: el botón vive en el summary pero no abre ni cierra el desplegable.
$('tablaHist').addEventListener('click', e => {
  const b = e.target.closest('[data-eliminar-reg]'); if (!b) return;
  e.preventDefault(); e.stopPropagation();
  abrirEliminarRegistro(b.dataset);
});

async function cargarHistorial() {
  $('histMsg').innerHTML = '<div class="msg-vacio"><span class="spin"></span> Cargando…</div>';
  const sucursal = estado.miSucursal;
  try {
    const q = estado.datos.usuario.esAdmin ? `?idSucursal=${encodeURIComponent(sucursal)}` : '';
    const { movimientos } = await api(`/api/vencimientos/historial${q}`);
    if (sucursal !== estado.miSucursal) return;
    $('histMsg').innerHTML = movimientos.length ? '' : '<div class="msg-vacio">Sin movimientos registrados.</div>';
    $('tablaHist').innerHTML = movimientos.length ? htmlHistorial(movimientos) : '';
  } catch (e) {
    $('tablaHist').innerHTML = '';
    $('histMsg').innerHTML = `<div class="error-box" role="alert">${esc(e.message)}</div>`;
  }
}


// Acciones por fila: corregir unidades (modal de cantidad), marcar vendido (confirmación en mQuit) y pasar a oferta/vencido (modal propio).
const ACCIONES = {
  unidades: { titulo: 'Corregir unidades', label: 'Unidades correctas', min: 0 },
  devuelto: { titulo: 'Devuelto a Central', label: 'Unidades devueltas', min: 1, ruta: 'devuelto-central', campo: 'cantidad', ok: 'Devuelto a Central registrado' },
};
const loteDe = id => estado.datos.lotes.find(l => l.id === id);
const colDe = lote => lote.sucursales[String(estado.miSucursal)];
const idSucursalAdmin = () => (estado.datos.usuario.esAdmin ? estado.miSucursal : undefined);

function abrirAccion(lote, accion) {
  estado.loteAcc = { lote, accion };
  const col = colDe(lote), a = ACCIONES[accion], input = $('accCant');
  $('mAccT').textContent = a.titulo;
  $('accLbl').textContent = a.label;
  input.min = a.min;
  if (accion === 'devuelto') {
    const pend = pendienteDe(col);
    input.value = ''; input.max = pend;
    $('mAccSub').textContent = `${lote.nombre || lote.idProducto} · pendiente ${fmtNum(pend)} unidades`;
  } else {
    input.value = col.unidades; $('mAccSub').textContent = `${lote.nombre || lote.idProducto} · hoy ${fmtNum(col.unidades)} unidades`; input.removeAttribute('max');
  }
  mostrarError('accError', ''); abrirModal('mAcc', 'accCant'); input.select();
}

const alAccionar = e => {
  const b = e.target.closest('button'); if (!b || b.disabled) return;
  const dato = ['of', 'devuelto', 'vendido', 'vencido', 'corregir', 'quitar', 'cmp', 'cmpv'].find(k => b.dataset[k] !== undefined);
  if (!dato) return;
  const lote = loteDe(b.dataset[dato]); if (!lote) return;
  if (dato === 'of' || dato === 'vencido') return abrirOferta(lote, dato === 'of' ? 'oferta' : 'vencido');
  if (dato === 'cmp' || dato === 'cmpv') return abrirCmp(lote, [], dato === 'cmp' ? 'oferta' : 'vencido');
  if (dato === 'quitar') return abrirQuitar(lote, b.dataset.mov, 'oferta');
  if (dato === 'vendido') return abrirVendido(lote);
  abrirAccion(lote, dato === 'devuelto' ? 'devuelto' : 'unidades');
};
$('tablaMia').addEventListener('click', alAccionar);
$('menuFila').addEventListener('click', alAccionar);

$('mAcc').querySelector('form').addEventListener('submit', async e => {
  e.preventDefault();
  const { lote, accion } = estado.loteAcc, a = ACCIONES[accion], raw = $('accCant').value.trim();
  if (!/^\d+$/.test(raw) || Number(raw) < a.min) return mostrarError('accError', a.min ? 'Ingresá un entero mayor a 0.' : 'Ingresá un entero mayor o igual a 0.');
  const idSucursal = idSucursalAdmin(), base = `/api/vencimientos/lotes/${encodeURIComponent(lote.id)}`;
  if (a.ruta) {
    const pend = pendienteDe(colDe(lote));
    if (Number(raw) > pend) return mostrarError('accError', `Ingresá un entero entre 1 y ${fmtNum(pend)}.`);
    const okD = await enviar('accOk', 'accError', () => api(`${base}/${a.ruta}`, { method: 'POST', body: { [a.campo]: Number(raw), idSucursal } }));
    if (okD) { cerrarModal('mAcc'); avisoExito((await cargarLotes()) ? 'Pasó al historial' : a.ok); }
    return;
  }
  const ok = await enviar('accOk', 'accError', () => api(`${base}/unidades`, { method: 'PUT', body: { unidades: Number(raw), idSucursal } }));
  if (ok) { cerrarModal('mAcc'); if (await cargarLotes()) avisoExito('Pasó al historial'); }
});

// ── Pasar a oferta / a vencido: selección múltiple de movimientos de SIGA + confirmación final ──
// Un solo modal (mOf) para las dos clases; estado.ofClase = 'oferta' | 'vencido'.
let secOferta = 0;
const sumaSel = () => (estado.ofMovs || []).filter(m => estado.ofSel.has(String(m.numeroMovimiento))).reduce((a, m) => a + Number(m.cantidad || 0), 0);
function abrirOferta(lote, clase) {
  estado.loteOferta = lote; estado.ofClase = clase; estado.ofMovs = []; estado.ofSel = new Set();
  $('mOfT').textContent = CLASES[clase].titulo;
  $('mOfSub').textContent = `${lote.nombre || `Producto ${lote.idProducto}`} · PLU ${lote.idProducto}`;
  $('ofInfo').hidden = true;
  mostrarError('ofError', '');
  abrirModal('mOf', 'ofCerrar');
  return cargarOferta();
}
// Movimiento asimétrico (+entra ≠ −cantidad): solo avisa; si el backend no manda los campos, no muestra nada.
const ICONO_ASIM = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.8 15 14H1L8 1.8z"/><path d="M8 6.5v3.2M8 11.8v.1"/></svg>';
const esAsim = m => !esSinOferta() && !!m && m.asimetrico === true && Number.isFinite(Number(m.entra));
const textoAsim = m => `+${fmtNum(m.entra)} / −${fmtNum(m.cantidad)}`;
const marcaAsim = (m, corto) => esAsim(m) ? `<span class="asim" title="${esc(`El movimiento tiene líneas positivas y negativas distintas. Se toma solo lo negativo (${fmtNum(m.cantidad)}).`)}">${ICONO_ASIM}${corto ? 'Asimétrico' : `Asimétrico: ${esc(textoAsim(m))}`}</span>` : '';
const asimPorNumero = n => (estado.ofMovs || []).find(m => String(m.numeroMovimiento) === String(n));
function actualizarAvisoAsim() {
  const el = $('ofAsim');
  const lista = estado.ofClase === 'vencido' ? (estado.ofMovs || []).filter(m => esAsim(m) && (estado.ofSel.has(String(m.numeroMovimiento)) || (m.asignadoA && m.asignadoA.idLote === estado.loteOferta.id))) : [];
  el.hidden = !lista.length;
  el.textContent = lista.length ? `Hay movimientos asimétricos seleccionados: ${lista.map(m => `N° ${m.numeroMovimiento} (${textoAsim(m)})`).join(', ')}. Se toma solo lo negativo. Revisalos antes de confirmar.` : '';
}
function actualizarResumenOferta() {
  actualizarAvisoAsim();
  const col = colDe(estado.loteOferta), k = estado.ofClase;
  $('ofResumen').innerHTML = k === 'vencido'
    ? `<span class="cel-off">${rotuloBaseVencido(col)}: ${fmtNum(baseDe(col, k))}</span> · Vencido: <strong class="cel-on">${fmtNum(totalDe(col, k) + sumaSel())}</strong>`
    : `<span class="cel-off">Cargadas: ${fmtNum(col.unidades)}</span> · En oferta: <strong class="cel-on">${fmtNum(totalOfertas(col) + sumaSel())}</strong>`;
  $('ofOk').disabled = !estado.ofSel.size;
}
async function cargarOferta() {
  const lote = estado.loteOferta, k = estado.ofClase, seq = ++secOferta;
  actualizarResumenOferta();
  $('ofCuerpo').innerHTML = '<div class="msg-vacio"><span class="spin"></span> Cargando…</div>';
  const q = `idProducto=${encodeURIComponent(lote.idProducto)}${estado.datos.usuario.esAdmin ? `&idSucursal=${encodeURIComponent(estado.miSucursal)}` : ''}`;
  try {
    const r = await api(`/api/vencimientos/${CLASES[k].mov}?${q}`);
    if (seq !== secOferta) return;
    const movs = Array.isArray(r.movimientos) ? r.movimientos : [];
    estado.ofMovs = movs;
    estado.ofSel = new Set([...estado.ofSel].filter(n => movs.some(m => String(m.numeroMovimiento) === n && !m.asignadoA)));
    if (k === 'vencido') { $('ofInfo').textContent = `Movimientos ${esSinOferta() ? '' : 'OFERTA '}VENCIDO de tu sucursal en los últimos ${fmtNum(r.diasMax)} días`; $('ofInfo').hidden = false; }
    actualizarResumenOferta();
    if (!movs.length) { $('ofCuerpo').innerHTML = `<div class="msg-vacio">${esc(CLASES[k].vacio(fmtNum(r.diasMax)))}</div>`; return; }
    $('ofCuerpo').innerHTML = `<table><thead><tr><th><span class="sr-only">Seleccionar</span></th><th>Mov. N°</th><th>Fecha</th><th class="num">Cantidad (sistema)</th><th>Estado</th><th></th></tr></thead><tbody>${movs.map(m => {
      const n = esc(m.numeroMovimiento), aqui = !!m.asignadoA && m.asignadoA.idLote === lote.id, otro = !!m.asignadoA && !aqui;
      const sit = aqui ? '<span class="pill pill--amarillo">Asignado aquí</span>' : otro ? '<span class="text-xs text-gris">Asignado a otro registro</span>' : '';
      const sel = aqui || otro ? '' : `<input type="checkbox" data-sel="${n}" aria-label="Seleccionar movimiento N° ${n}"${estado.ofSel.has(String(m.numeroMovimiento)) ? ' checked' : ''}>`;
      const accion = aqui ? `<button type="button" class="btn btn-mini" data-quitar-mov="${n}" aria-label="Quitar movimiento ${n}">Quitar</button>` : '';
      return `<tr class="${otro ? 'cerrado' : ''}${aqui ? ' alerta' : ''}"><td>${sel}</td><td>${n}</td><td class="whitespace-nowrap">${esc(fmtFecha(m.fecha))}</td><td class="num">${fmtNum(m.cantidad)}${k === 'vencido' ? marcaAsim(m) : ''}</td><td>${sit}</td><td class="whitespace-nowrap">${accion}</td></tr>`;
    }).join('')}</tbody></table>`;
  } catch (err) {
    if (seq !== secOferta) return;
    $('ofCuerpo').innerHTML = `<div class="error-box" role="alert">${esc(/SIGA|502/.test(err.message) ? 'No se pudieron leer los movimientos de SIGA, probá de nuevo.' : err.message)}</div>`;
  }
}
// Recarga lotes de fondo y, si el modal sigue abierto, su lista.
async function refrescarOferta() {
  const id = estado.loteOferta.id;
  await cargarLotes();
  const nuevo = loteDe(id);
  if ($('mOf').hidden) return;
  const col = nuevo && colDe(nuevo);
  if (!col || estaCerrado(col)) { cerrarModal('mOf'); return; } // el registro salió de la tabla
  estado.loteOferta = nuevo;
  await cargarOferta();
}
$('ofCuerpo').addEventListener('click', e => {
  const q = e.target.closest('[data-quitar-mov]');
  if (q) abrirQuitar(estado.loteOferta, q.dataset.quitarMov, estado.ofClase);
});
$('ofCuerpo').addEventListener('change', e => {
  const c = e.target.closest('[data-sel]'); if (!c) return;
  if (c.checked) estado.ofSel.add(c.dataset.sel); else estado.ofSel.delete(c.dataset.sel);
  actualizarResumenOferta();
});
const postClase = (clase, lote, nuevos, confirmacion) => api(`/api/vencimientos/lotes/${encodeURIComponent(lote.id)}/${CLASES[clase].ruta}`, { method: 'POST', body: { numerosMovimiento: nuevos.map(x => Number(x.n)), confirmacion, idSucursal: idSucursalAdmin() } });
async function terminarOferta(lote, msg) {
  ['mCmp', 'mOf'].forEach(id => { if (!$(id).hidden) cerrarModal(id); });
  const seCerro = await cargarLotes();
  avisoExito(seCerro ? 'Pasó al historial' : `${msg}: ${lote.nombre || lote.idProducto}.`);
}
// OK: si el total coincide con la base se asigna directo; si no, se pide confirmar las cantidades.
$('ofOk').addEventListener('click', async () => {
  const lote = estado.loteOferta, col = colDe(lote), k = estado.ofClase;
  const nuevos = estado.ofMovs.filter(m => estado.ofSel.has(String(m.numeroMovimiento))).map(m => ({ n: m.numeroMovimiento, cantidad: Number(m.cantidad || 0) }));
  if (!nuevos.length) return;
  if (totalDe(col, k) + sumaSel() !== baseDe(col, k)) return abrirCmp(lote, nuevos, k);
  const ok = await enviar('ofOk', 'ofError', () => postClase(k, lote, nuevos));
  if (ok) await terminarOferta(lote, CLASES[k].hecho);
});

// ── Comparación de cantidades (mCmp): movimientos vs. base ──
// nuevos = movimientos recién seleccionados (POST); vacío = reabierto desde la celda (PUT).
const fmtConSigno = n => (n < 0 ? `−${fmtNum(-n)}` : fmtNum(n));
function abrirCmp(lote, nuevos, clase) {
  estado.cmp = { lote, nuevos, clase };
  const col = colDe(lote), asignados = movsDe(col, clase), base = baseDe(col, clase);
  const total = totalDe(col, clase) + nuevos.reduce((a, x) => a + x.cantidad, 0), dif = total - base;
  const asim = n => clase === 'vencido' ? asimPorNumero(n) : null;
  const fila = (n, cant, etiqueta) => `<li>Mov. N° ${esc(n)} · ${fmtNum(cant)} u. <span class="text-gris">(${etiqueta})</span>${marcaAsim(asim(n), true)}</li>`;
  $('cmpAsim').hidden = ![...asignados.map(o => o.numeroMovimiento), ...nuevos.map(x => x.n)].some(n => esAsim(asim(n)));
  const filas = clase === 'vencido'
    ? `<dt>${rotuloBaseVencido(col)}</dt><dd>${fmtNum(base)}</dd><dt>Vencido${nuevos.length ? ' (seleccionado)' : ''}</dt><dd><strong class="cel-on">${fmtNum(total)}</strong></dd>`
    : `<dt>Cargadas en la tabla</dt><dd>${fmtNum(base)}</dd><dt>Movimientos${nuevos.length ? ' seleccionados' : ''}</dt><dd><strong class="cel-on">${fmtNum(total)}</strong></dd>`;
  const vendido = clase === 'vencido' ? `<dt class="text-gris">Vendido (${ofertasDe(col).length ? 'oferta' : 'cargadas'} − vencido)</dt><dd class="text-gris">${fmtConSigno(base - total)}</dd>` : '';
  $('cmpSub').textContent = lote.nombre || `Producto ${lote.idProducto}`;
  $('cmpCuerpo').innerHTML = `<dl class="cmp-dl">${filas}<dt>Diferencia</dt><dd class="${dif ? 'est-corr' : 'est-ok'}">${dif ? esc(signo(dif)) : '0'}</dd>${vendido}</dl>`
    + `<ul class="cmp-ul">${asignados.map(o => fila(o.numeroMovimiento, o.cantidad, 'ya asignado')).join('')}${nuevos.map(x => fila(x.n, x.cantidad, 'nuevo')).join('')}</ul>`;
  mostrarError('cmpError', '');
  abrirModal('mCmp', 'cmpOk');
}
async function decidirCmp(confirmacion) {
  const { lote, nuevos, clase } = estado.cmp, base = `/api/vencimientos/lotes/${encodeURIComponent(lote.id)}`;
  const btns = [$('cmpOk'), $('cmpCorr')]; btns.forEach(b => { b.disabled = true; }); mostrarError('cmpError', '');
  try {
    if (nuevos.length) await postClase(clase, lote, nuevos, confirmacion);
    else await api(`${base}/${CLASES[clase].ruta}/confirmacion`, { method: 'PUT', body: { confirmacion, idSucursal: idSucursalAdmin() } });
  } catch (e) { btns.forEach(b => { b.disabled = false; }); return mostrarError('cmpError', e.message); }
  btns.forEach(b => { b.disabled = false; });
  await terminarOferta(lote, confirmacion === 'ok' ? 'Cantidades confirmadas' : 'Marcado para corregir');
}
$('cmpOk').addEventListener('click', () => decidirCmp('ok'));
$('cmpCorr').addEventListener('click', () => decidirCmp('corregir'));

// Quitar un movimiento puntual (confirmación en modal propio).
function abrirQuitar(lote, numeroMovimiento, clase) {
  estado.quitar = { lote, numeroMovimiento, clase };
  $('mQuitT').textContent = 'Quitar movimiento';
  $('mQuitTxt').textContent = `Quitar el movimiento N° ${numeroMovimiento} de ${lote.nombre || lote.idProducto}. Queda libre para otro registro.`;
  $('quitOk').textContent = 'Quitar'; $('quitOk').className = 'btn btn-prim';
  mostrarError('quitError', ''); abrirModal('mQuit', 'quitOk');
}
// Marcar todo el pendiente como vendido: reusa mQuit (clase 'vendido'); el registro se cierra y pasa al historial.
function abrirVendido(lote) {
  const pend = pendienteDe(colDe(lote));
  estado.quitar = { lote, clase: 'vendido', pend };
  $('mQuitT').textContent = 'Marcar como vendido';
  $('mQuitTxt').textContent = `Se registra todo el pendiente (${fmtNum(pend)}) como vendido y el producto pasa al historial.`;
  $('quitOk').textContent = 'Confirmar'; $('quitOk').className = 'btn btn-prim';
  mostrarError('quitError', ''); abrirModal('mQuit', 'quitOk');
}
// Eliminar un registro del historial (lote + sucursal): reusa mQuit (clase 'registro'), foco inicial en Cancelar.
function abrirEliminarRegistro(d) {
  estado.quitar = { clase: 'registro', idLote: d.eliminarReg };
  $('mQuitT').textContent = 'Eliminar registro';
  $('mQuitTxt').textContent = `Se elimina el registro de ${d.nombre} (PLU ${d.plu}${d.venc ? `, vence ${d.venc}` : ''}) con todo su historial. Los movimientos de SIGA que tenía asignados quedan disponibles para otros registros. Esta acción no se puede deshacer.`;
  $('quitOk').textContent = 'Eliminar'; $('quitOk').className = 'btn btn-peligro';
  mostrarError('quitError', ''); abrirModal('mQuit', 'quitCancel');
}
$('mQuit').querySelector('form').addEventListener('submit', async e => {
  e.preventDefault();
  if (estado.quitar.clase === 'registro') {
    const { idLote } = estado.quitar, suc = idSucursalAdmin();
    const ok = await enviar('quitOk', 'quitError', () => api(`/api/vencimientos/lotes/${encodeURIComponent(idLote)}/registro${suc ? `?idSucursal=${encodeURIComponent(suc)}` : ''}`, { method: 'DELETE' }));
    if (!ok) return;
    cerrarModal('mQuit');
    ['mCmp', 'mOf'].forEach(id => { if (!$(id).hidden) cerrarModal(id); });
    estado.histAbiertos.delete(idLote);
    await cargarLotes();
    avisoExito('Registro eliminado');
    return;
  }
  if (estado.quitar.clase === 'vendido') {
    const { lote, pend } = estado.quitar;
    const ok = await enviar('quitOk', 'quitError', () => api(`/api/vencimientos/lotes/${encodeURIComponent(lote.id)}/movimientos`, { method: 'POST', body: { tipo: 'vendido', cantidad: pend, idSucursal: idSucursalAdmin() } }));
    if (!ok) return;
    cerrarModal('mQuit');
    if (await cargarLotes()) avisoExito('Pasó al historial');
    return;
  }
  const { lote, numeroMovimiento, clase } = estado.quitar, suc = idSucursalAdmin();
  const qs = `?${suc ? `idSucursal=${encodeURIComponent(suc)}&` : ''}numeroMovimiento=${encodeURIComponent(numeroMovimiento)}`;
  const ok = await enviar('quitOk', 'quitError', () => api(`/api/vencimientos/lotes/${encodeURIComponent(lote.id)}/${CLASES[clase].ruta}${qs}`, { method: 'DELETE' }));
  if (!ok) return;
  cerrarModal('mQuit');
  if (!$('mOf').hidden) { estado.loteOferta = lote; await refrescarOferta(); } else await cargarLotes();
  avisoExito(`Movimiento N° ${numeroMovimiento} quitado.`);
});

// ── Sin lote: movimientos de SIGA sin registro; "Dar de alta" crea el registro con su vencimiento ──
const TIPO_SL = { oferta: { txt: 'Oferta', cls: 'acc-of', color: '#0f5ea8' }, vencido: { txt: 'Vencido', cls: 'acc-venc', color: '#a4262c' } };
let secSL = 0;
async function cargarSinLote() {
  resolverSucursal();
  const seq = ++secSL, suc = estado.miSucursal, esAdmin = estado.datos.usuario.esAdmin;
  $('slMsg').innerHTML = '<div class="msg-vacio"><span class="spin"></span> Cargando…</div>';
  $('tablaSL').innerHTML = '';
  try {
    const r = await api(`/api/vencimientos/sin-lote${esAdmin && suc ? `?idSucursal=${encodeURIComponent(suc)}` : ''}`);
    if (seq !== secSL) return;
    estado.sinLote = Array.isArray(r.movimientos) ? r.movimientos : [];
    $('slSub').textContent = `Movimientos de tu sucursal (últimos ${fmtNum(r.diasMaxOferta)} días en oferta, ${fmtNum(r.diasMaxVencido)} en vencidos) que todavía no están en ningún registro.`;
    renderSinLote();
  } catch (e) {
    if (seq !== secSL) return;
    estado.sinLote = [];
    $('slMsg').innerHTML = `<div class="error-box" role="alert">${esc(/SIGA|502/.test(e.message) ? 'No se pudieron leer los movimientos de SIGA, probá de nuevo' : e.message)}</div>`;
  }
}
function renderSinLote() {
  const txt = $('fSLTexto').value.trim().toLowerCase();
  const todos = estado.sinLote || [];
  const lista = todos.filter(m => !txt || `${m.nombre || ''} ${m.codigo || ''} ${m.idProducto}`.toLowerCase().includes(txt));
  if (!lista.length) { $('tablaSL').innerHTML = ''; $('slMsg').innerHTML = `<div class="msg-vacio">${txt && todos.length ? 'Ningún movimiento coincide.' : 'No hay movimientos sin lote.'}</div>`; return; }
  $('slMsg').innerHTML = '';
  $('tablaSL').innerHTML = `<thead><tr><th>Fecha</th><th>Mov. N°</th><th>Tipo</th><th>PLU</th><th>Producto</th><th class="num">Cantidad</th><th><span class="sr-only">Acción</span></th></tr></thead><tbody>${lista.map(m => {
    const t = TIPO_SL[m.clase] || TIPO_SL.oferta, nom = m.nombre || `Producto ${m.idProducto}`;
    const asim = m.clase === 'vencido' ? marcaAsim(m) : '';
    return `<tr><td class="whitespace-nowrap">${esc(fmtFecha(m.fecha))}</td><td>${esc(m.numeroMovimiento)}</td><td class="whitespace-nowrap" style="color:${t.color}"><span class="dot" style="background:${t.color}" aria-hidden="true"></span>${esc(t.txt)}</td>${celdaPlu(m.idProducto)}<td>${esc(nom)}</td><td class="num">${fmtNum(m.cantidad)}${asim}</td><td><button type="button" class="acc ${t.cls}" data-alta-sl="${esc(m.numeroMovimiento)}" data-clase="${esc(m.clase)}" title="${esc(m.clase === 'vencido' ? 'Registra el vencido y lo pasa directo al historial' : 'Pide fecha de vencimiento y cantidades puestas en oferta para seguir el recorrido normal')}" aria-label="${esc(`${m.clase === 'vencido' ? 'Pasar al historial' : 'Dar de alta'} el movimiento ${m.numeroMovimiento} de ${nom}`)}">${m.clase === 'vencido' ? 'Pasar al historial' : 'Dar de alta'}</button></td></tr>`;
  }).join('')}</tbody>`;
}
$('fSLTexto').addEventListener('input', renderSinLote);
$('tablaSL').addEventListener('click', e => {
  const b = e.target.closest('[data-alta-sl]'); if (!b) return;
  const m = (estado.sinLote || []).find(x => String(x.numeroMovimiento) === b.dataset.altaSl && x.clase === b.dataset.clase); if (!m) return;
  estado.altaSL = m;
  const venc = m.clase === 'vencido', nom = m.nombre || `Producto ${m.idProducto}`;
  $('mAltaSLT').textContent = venc ? 'Pasar al historial' : 'Dar de alta en oferta';
  $('altaSLSub').textContent = `${nom} · PLU ${m.idProducto} · Movimiento N° ${m.numeroMovimiento} · ${venc ? `vencido: ${fmtNum(m.cantidad)}` : `el sistema registró ${fmtNum(m.cantidad)}`}`;
  $('altaSLCampos').hidden = venc;
  $('altaSLAsim').hidden = !(venc && esAsim(m));
  $('altaSLAsim').innerHTML = esAsim(m) ? `<span class="asim" style="margin-left:0;white-space:normal">${ICONO_ASIM}Asimétrico: ${esc(textoAsim(m))}. Se toma solo lo negativo.</span>` : '';
  $('altaSLTxt').textContent = venc ? 'Queda registrado como vencido y pasa directo al historial.' : 'Con esto el producto sigue el recorrido normal. Si la cantidad no coincide con la del sistema, la confirmás desde la tabla.';
  $('altaSLOk').textContent = venc ? 'Pasar al historial' : 'Dar de alta';
  $('altaSLFecha').value = '';
  $('altaSLUnid').value = !venc && Number.isInteger(Number(m.cantidad)) && Number(m.cantidad) > 0 ? String(Number(m.cantidad)) : '';
  mostrarError('altaSLError', '');
  abrirModal('mAltaSL', venc ? 'altaSLOk' : 'altaSLFecha');
});
$('mAltaSL').querySelector('form').addEventListener('submit', async e => {
  e.preventDefault();
  const m = estado.altaSL, venc = m.clase === 'vencido';
  const body = { clase: m.clase, numeroMovimiento: m.numeroMovimiento, idProducto: m.idProducto, idSucursal: idSucursalAdmin() };
  let unidades = null;
  if (!venc) {
    const fecha = $('altaSLFecha').value, txtU = $('altaSLUnid').value.trim();
    if (!fecha) return mostrarError('altaSLError', 'Indicá la fecha de vencimiento.');
    unidades = Number(txtU);
    if (!txtU) return mostrarError('altaSLError', 'Indicá las cantidades puestas en oferta.');
    if (!Number.isInteger(unidades) || unidades <= 0) return mostrarError('altaSLError', 'La cantidad debe ser un entero mayor a 0.');
    body.vencimiento = fecha; body.unidades = unidades;
  }
  const ok = await enviar('altaSLOk', 'altaSLError', () => api('/api/vencimientos/sin-lote/alta', { method: 'POST', body }));
  if (!ok) return;
  cerrarModal('mAltaSL');
  await Promise.all([cargarLotes(), cargarSinLote()]);
  avisoExito(venc ? 'Pasó al historial' : `Dado de alta: sigue en Mi sucursal${unidades !== Number(m.cantidad) ? ' · Confirmá las cantidades en la columna En oferta' : ''}`);
});

// ── Tabs y sesión ─────────────────────────────────────────────────────────────
function activarTab(tab) {
  estado.tabActiva = tab;
  document.querySelectorAll('.navtab').forEach(b => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('on', on); b.setAttribute('aria-selected', on);
  });
  $('panelCarga').hidden = tab !== 'carga';
  $('panelMia').hidden = tab !== 'mia';
  $('panelOtras').hidden = tab !== 'otras';
  $('panelHist').hidden = tab !== 'hist';
  $('panelSL').hidden = tab !== 'sl';
  if (tab === 'sl' && estado.datos) cargarSinLote();
  if (tab === 'mia' && estado.datos) renderMia();
  if (tab === 'hist' && estado.datos) renderHist();
}
document.querySelectorAll('.navtab').forEach(b => b.addEventListener('click', () => activarTab(b.dataset.tab)));

$('btnLogout').addEventListener('click', async () => {
  try { await fetch('/api/logout', { method: 'POST' }); } catch (_) { /* ignorar */ }
  location.href = '/login';
});

cargarSucursales().then(cargarLotes);
