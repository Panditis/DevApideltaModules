'use strict';
// Control de vencimientos (Sucursales), Etapa 1. API: /api/vencimientos/*. Sin framework.
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = n => Number(n || 0).toLocaleString('es-AR');
const fmtFecha = iso => { const [y, m, d] = String(iso).split('-'); return d ? `${d}/${m}/${y}` : String(iso); };
const fmtFechaHora = iso => { const t = new Date(iso); return isNaN(t) ? String(iso) : t.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }); };

const SEMAFORO = { rojo: 'Rojo', amarillo: 'Amarillo', verde: 'Verde' };
const TIPO_MOV = { alta: 'Alta', correccion: 'Corrección', oferta: 'Oferta', vendido: 'Vendido' };
const MIN_BUSQUEDA = 2;
const DEBOUNCE_MS = 300;

const estado = { datos: null, nombres: {}, miSucursal: null, sucursalesLista: [], loteAcc: null, productoElegido: null, tabActiva: 'listado', cruce: null, filtroLote: null };

async function api(url, opciones) {
  const init = opciones && opciones.body !== undefined
    ? { ...opciones, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opciones.body) } : opciones;
  const r = await fetch(url, init);
  let cuerpo = null;
  try { cuerpo = await r.json(); } catch (_) { /* respuesta sin JSON */ }
  if (!r.ok) throw new Error((cuerpo && cuerpo.error) || `Error ${r.status}`);
  return cuerpo;
}

const nombreSuc = id => estado.nombres[id] || `Suc. ${id}`;
const cruceDe = (idLote, suc) => (estado.cruce && estado.cruce.cruce && estado.cruce.cruce[idLote] && estado.cruce.cruce[idLote][suc]) || null;
const estadoLoteSuc = (lote, suc) => { const x = cruceDe(lote.id, suc); return x && x.estadoLote ? x.estadoLote : lote.sucursales[suc].estado; };
const esCerrado = lote => Object.keys(lote.sucursales).every(s => estadoLoteSuc(lote, s) === 'cerrado');

// Cruce con SIGA: textos y clases (siempre con texto además del color).
const CRUCE_TXT = { ok: 'OK', diferencia: 'Diferencia', 'sin movimiento': 'Sin movimiento' };
const CRUCE_CLASE = { ok: 'verde', diferencia: 'amarillo', 'sin movimiento': 'gris' };
const LOTE_TXT = { cargado: 'Cargado', 'en oferta': 'En oferta', cerrado: 'Cerrado' };
function explicarDiferencia(x) {
  if (x.diferencia > 0) return 'se movió de más';
  if (x.diferencia < 0) return x.movidoOferta > 0 ? 'oferta parcial' : 'sin movimiento';
  return '';
}
const signo = n => (n > 0 ? '+' : '') + fmtNum(n);
function detalleCruce(x) {
  const ex = explicarDiferencia(x);
  return `Unidades del lote: ${fmtNum(x.unidades)} · Movido a oferta: ${fmtNum(x.movidoOferta)} · Movido vencido: ${fmtNum(x.movidoVencido)} · Diferencia: ${signo(x.diferencia)}${ex ? ` (${ex})` : ''}`;
}
function pillCruce(x) {
  const clase = CRUCE_CLASE[x.estadoCruce] || 'gris';
  return `<span class="pill pill--${clase}" title="${esc(detalleCruce(x))}">${esc(CRUCE_TXT[x.estadoCruce] || x.estadoCruce)}</span>`;
}
const rotuloVendido = x => (x.origenVendido === 'siga' ? 'SIGA' : 'manual');
const loteAlerta = l => Object.keys(l.sucursales).some(s => { const x = cruceDe(l.id, s); return x && (x.aviso || x.estadoCruce === 'diferencia'); });
function validarConfigCliente(c) {
  for (const k of ['tipoOferta', 'tipoNoVendido']) {
    if (c[k] === undefined) continue;
    if (!c[k].trim() || c[k].trim().length > 50) return 'Los tipos de movimiento no pueden estar vacíos ni pasar de 50 caracteres.';
  }
  if (c.depositoMovimientos !== undefined && !esEnteroPositivo(c.depositoMovimientos)) return 'El depósito tiene que ser un entero mayor a 0.';
  for (const k of ['diasAviso', 'margenDias']) if (c[k] !== undefined && !/^\d+$/.test(String(c[k]).trim())) return 'Los días de aviso y margen tienen que ser enteros mayores o iguales a 0.';
  return '';
}

function pillSemaforo(lote) {
  const txt = lote.semaforo === 'rojo' && lote.dias < 0 ? 'Vencido' : SEMAFORO[lote.semaforo] || lote.semaforo;
  return `<span class="pill pill--${esc(lote.semaforo)}">${esc(txt)}</span>`;
}
const celdaProducto = l => `<div class="font-semibold">${esc(l.nombre || `Producto ${l.idProducto}`)}</div><div class="text-xs text-gris">${esc(l.codigo || l.idProducto)}</div>`;

// Máximo que admite un movimiento: lo que falta para llegar a las unidades (el server valida igual).
function maxMovimiento(col, tipo) { return Math.max(0, col.unidades - col[tipo]); }
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
  if (abridor && abridor.isConnected) abridor.focus();
}
function mostrarError(id, msg) { const e = $(id); e.textContent = msg; e.hidden = !msg; }
document.querySelectorAll('.velo').forEach(v => {
  v.querySelectorAll('[data-cerrar]').forEach(b => b.addEventListener('click', () => cerrarModal(v.id)));
  v.addEventListener('mousedown', e => { if (e.target === v) cerrarModal(v.id); });
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const abierto = [...document.querySelectorAll('.velo')].find(v => !v.hidden);
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
    estado.sucursalesLista = Array.isArray(lista) ? lista : [];
    estado.nombres = Object.fromEntries(estado.sucursalesLista.map(s => [s.id, s.nombre]));
  } catch (_) { /* sin nombres: se muestra "Suc. N" */ }
}

async function cargarLotes() {
  $('listadoMsg').innerHTML = '<div class="msg-vacio"><span class="spin"></span> Cargando…</div>';
  try {
    const [datos, cruce] = await Promise.all([
      api('/api/vencimientos/lotes'),
      api('/api/vencimientos/cruce').catch(() => null),
    ]);
    estado.datos = datos;
    estado.cruce = cruce && cruce.cruceDisponible ? cruce : null;
    $('cruceAviso').textContent = estado.cruce ? '' : 'Cruce con SIGA no disponible';
    $('cruceAviso').title = !estado.cruce && cruce && cruce.mensaje ? cruce.mensaje : '';
  } catch (e) {
    $('listadoMsg').innerHTML = `<div class="error-box" role="alert">${esc(e.message)}</div>`;
    $('tablaListado').innerHTML = '';
    return;
  }
  $('listadoMsg').innerHTML = '';
  const { umbrales, usuario } = estado.datos;
  $('umbralesTxt').textContent = `Rojo ≤ ${umbrales.rojo} d · Amarillo ≤ ${umbrales.amarillo} d · Verde > ${umbrales.amarillo} d`;
  $('btnUmbrales').hidden = !usuario.esAdmin;
  renderAvisos();
  renderListado();
  if (estado.tabActiva === 'mia') renderMia();
}

// ── Listado ───────────────────────────────────────────────────────────────────
function lotesFiltrados() {
  const txt = $('fTexto').value.trim().toLowerCase();
  const sem = $('fSemaforo').value;
  const cerrados = $('fCerrados').checked;
  return estado.datos.lotes.filter(l =>
    (!estado.filtroLote || l.id === estado.filtroLote) && (cerrados || !esCerrado(l) || l.id === estado.filtroLote) && (!sem || l.semaforo === sem) &&
    (!txt || `${l.nombre || ''} ${l.codigo || ''} ${l.idProducto}`.toLowerCase().includes(txt)));
}

function renderListado() {
  if (!estado.datos) return;
  const { sucursales, usuario } = estado.datos;
  const filas = lotesFiltrados();
  if (!filas.length) {
    $('tablaListado').innerHTML = '';
    $('listadoMsg').innerHTML = `<div class="msg-vacio">${estado.datos.lotes.length ? 'Ningún lote coincide con los filtros.' : 'Todavía no hay vencimientos cargados.'}</div>`;
    return;
  }
  $('listadoMsg').innerHTML = '';
  const propia = id => id === usuario.idSucursal;
  const th = sucursales.map(s => `<th class="num${propia(s) ? ' propia' : ''}">${esc(nombreSuc(s))}${propia(s) ? ' (tuya)' : ''}</th>`).join('');
  const cuerpo = filas.map(l => {
    const celdas = sucursales.map(s => {
      const c = l.sucursales[s], x = cruceDe(l.id, s);
      const extra = x ? `<div class="mt-0.5">${pillCruce(x)}</div><div class="text-xs text-gris" title="${esc(detalleCruce(x))}">${esc(LOTE_TXT[x.estadoLote] || x.estadoLote)} · vendido ${fmtNum(x.vendido)} (${rotuloVendido(x)})${x.diferencia ? ` · dif ${signo(x.diferencia)}` : ''}</div>` : '';
      return `<td class="num${propia(s) ? ' propia' : ''}">${c ? fmtNum(c.unidades) + extra : '<span class="text-gris">–</span>'}</td>`;
    }).join('');
    const borrar = usuario.esAdmin ? `<td><button type="button" class="btn btn-mini" data-borrar="${esc(l.id)}" aria-label="Borrar lote de ${esc(l.nombre || l.idProducto)}">Borrar</button></td>` : '';
    return `<tr class="${esCerrado(l) ? 'cerrado' : ''}${loteAlerta(l) ? ' alerta' : ''}"><td>${pillSemaforo(l)}</td><td>${celdaProducto(l)}</td><td>${esc(fmtFecha(l.vencimiento))}</td>
      <td class="num">${fmtNum(l.dias)}</td>${celdas}<td class="num font-semibold">${fmtNum(l.totalUnidades)}</td>${borrar}</tr>`;
  }).join('');
  $('tablaListado').innerHTML = `<thead><tr><th>Estado</th><th>Producto</th><th>Vence</th><th class="num">Días</th>${th}<th class="num">Total</th>${usuario.esAdmin ? '<th></th>' : ''}</tr></thead><tbody>${cuerpo}</tbody>`;
}

['fTexto', 'fSemaforo', 'fCerrados'].forEach(id => $(id).addEventListener('input', renderListado));

// ── Avisos y huérfanos ────────────────────────────────────────────────────────
function renderAvisos() {
  const banda = $('avisosBanda'), btnH = $('btnHuerfanos');
  const cr = estado.cruce;
  const huer = cr && cr.huerfanos ? cr.huerfanos : [];
  btnH.hidden = !huer.length; btnH.textContent = `Movimientos sin lote (${huer.length})`;
  const propia = estado.datos.usuario.idSucursal;
  const avisos = (cr && cr.avisos ? cr.avisos : []).map(a => ({ ...a, lote: estado.datos.lotes.find(l => l.id === a.idLote) })).filter(a => a.lote);
  if (!avisos.length) { banda.hidden = true; banda.innerHTML = ''; return; }
  const grupos = new Map();
  avisos.forEach(a => { if (!grupos.has(a.idLote)) grupos.set(a.idLote, []); grupos.get(a.idLote).push(a); });
  const esPropio = g => g.some(a => String(a.idSucursal) === String(propia));
  const orden = [...grupos.entries()].sort((a, b) => Number(esPropio(b[1])) - Number(esPropio(a[1])));
  const chips = orden.map(([id, g]) => {
    const l = g[0].lote, sucs = g.map(a => nombreSuc(a.idSucursal) + (String(a.idSucursal) === String(propia) ? ' (tuya)' : '')).join(', ');
    return `<button type="button" class="chip${estado.filtroLote === id ? ' on' : ''}" data-aviso="${esc(id)}" aria-pressed="${estado.filtroLote === id}">${esc(l.nombre || l.idProducto)} · vence ${esc(fmtFecha(l.vencimiento))} · falta movimiento: ${esc(sucs)}</button>`;
  }).join('');
  banda.hidden = false;
  banda.innerHTML = `<div class="font-semibold mb-1">${avisos.length} ${avisos.length === 1 ? 'aviso' : 'avisos'}: lotes sin movimiento PARA OFERTA cerca de vencer${estado.filtroLote ? ' <button type="button" class="btn btn-mini ml-2" data-aviso="">Quitar filtro</button>' : ''}</div><div class="flex flex-wrap gap-2">${chips}</div>`;
}
$('avisosBanda').addEventListener('click', e => {
  const b = e.target.closest('[data-aviso]'); if (!b) return;
  const id = b.dataset.aviso;
  estado.filtroLote = id && id !== estado.filtroLote ? id : null;
  renderAvisos(); renderListado();
});

$('btnHuerfanos').addEventListener('click', () => {
  const nombreProd = id => { const l = estado.datos.lotes.find(x => String(x.idProducto) === String(id)); return l && l.nombre ? l.nombre : `Producto ${id}`; };
  $('huerCuerpo').innerHTML = estado.cruce.huerfanos.map(h => `<tr><td>${esc(nombreSuc(h.idSucursal))}</td><td>${esc(nombreProd(h.idProducto))}<div class="text-xs text-gris">${esc(h.idProducto)}</div></td><td class="num">${fmtNum(h.movidoOferta)}</td><td class="num">${fmtNum(h.movidoVencido)}</td></tr>`).join('');
  abrirModal('mHuer', 'huerCerrar');
});

// ── Alta ──────────────────────────────────────────────────────────────────────
let timerBusqueda = null, secBusqueda = 0;

function abrirAlta() {
  estado.productoElegido = null;
  ['altaBuscar', 'altaFecha', 'altaUnid'].forEach(id => { $(id).value = ''; });
  $('altaElegido').textContent = ''; $('altaOpciones').hidden = true; mostrarError('altaError', '');
  const esAdmin = estado.datos && estado.datos.usuario.esAdmin;
  $('altaSucWrap').hidden = !esAdmin;
  if (esAdmin) $('altaSuc').innerHTML = opcionesSucursal(estado.datos.usuario.idSucursal);
  abrirModal('mAlta', 'altaBuscar');
}

function opcionesSucursal(seleccionada) {
  const ids = estado.sucursalesLista.length ? estado.sucursalesLista.map(s => s.id) : (estado.datos ? estado.datos.sucursales : []);
  return ids.map(id => `<option value="${esc(id)}"${Number(id) === Number(seleccionada) ? ' selected' : ''}>${esc(nombreSuc(id))}</option>`).join('');
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
      ? lista.map((p, i) => `<button type="button" class="opcion" data-i="${i}">${esc(p.nombre)}<small>${esc(p.codigo || p.idProducto)}</small></button>`).join('')
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
  $('altaElegido').textContent = `Elegido: ${estado.productoElegido.nombre}`;
  $('altaBuscar').value = estado.productoElegido.nombre;
  $('altaOpciones').hidden = true;
  $('altaFecha').focus();
});

$('mAlta').querySelector('form').addEventListener('submit', async e => {
  e.preventDefault();
  const p = estado.productoElegido, fecha = $('altaFecha').value, unid = $('altaUnid').value;
  if (!p) return mostrarError('altaError', 'Elegí un producto de la lista.');
  if (!fecha) return mostrarError('altaError', 'Indicá la fecha de vencimiento.');
  if (!esEnteroPositivo(unid)) return mostrarError('altaError', 'Las unidades tienen que ser un entero mayor a 0.');
  const body = { idProducto: p.idProducto, nombre: p.nombre, codigo: p.codigo, vencimiento: fecha, unidades: Number(unid) };
  if (!$('altaSucWrap').hidden) body.idSucursal = Number($('altaSuc').value);
  const ok = await enviar('altaOk', 'altaError', () => api('/api/vencimientos/lotes', { method: 'POST', body }));
  if (ok) { cerrarModal('mAlta'); await cargarLotes(); }
});
$('btnAlta').addEventListener('click', abrirAlta);

// ── Borrar (admin) ────────────────────────────────────────────────────────────
let loteBorrar = null;
$('tablaListado').addEventListener('click', e => {
  const b = e.target.closest('[data-borrar]'); if (!b) return;
  loteBorrar = estado.datos.lotes.find(l => l.id === b.dataset.borrar); if (!loteBorrar) return;
  $('mDelTxt').textContent = `Se borra el lote de "${loteBorrar.nombre || loteBorrar.idProducto}" (vence ${fmtFecha(loteBorrar.vencimiento)}) con las unidades de todas las sucursales. No se puede deshacer.`;
  mostrarError('delError', ''); abrirModal('mDel', 'delOk');
  $('mDel').querySelector('[data-cerrar]').focus();
});
$('mDel').querySelector('form').addEventListener('submit', async e => {
  e.preventDefault();
  const ok = await enviar('delOk', 'delError', () => api(`/api/vencimientos/lotes/${encodeURIComponent(loteBorrar.id)}`, { method: 'DELETE' }));
  if (ok) { cerrarModal('mDel'); await cargarLotes(); }
});

// ── Configuración (admin) ─────────────────────────────────────────────────────
const CAMPOS_CFG = { tipoOferta: 'cfgOferta', tipoNoVendido: 'cfgNoVendido', depositoMovimientos: 'cfgDeposito', diasAviso: 'cfgDiasAviso', margenDias: 'cfgMargen' };
$('btnUmbrales').addEventListener('click', async () => {
  $('umbRojo').value = estado.datos.umbrales.rojo; $('umbAmarillo').value = estado.datos.umbrales.amarillo;
  Object.values(CAMPOS_CFG).forEach(id => { $(id).value = ''; });
  mostrarError('umbError', ''); abrirModal('mUmb', 'umbRojo');
  try {
    const cfg = await api('/api/vencimientos/config');
    Object.entries(CAMPOS_CFG).forEach(([k, id]) => { if (cfg[k] !== undefined) $(id).value = cfg[k]; });
  } catch (e) { mostrarError('umbError', `No se pudo leer la configuración del cruce: ${e.message}`); }
});
$('mUmb').querySelector('form').addEventListener('submit', async e => {
  e.preventDefault();
  const rojo = $('umbRojo').value, amarillo = $('umbAmarillo').value;
  const err = validarUmbralesCliente(rojo, amarillo);
  if (err) return mostrarError('umbError', err);
  const extra = {};
  Object.entries(CAMPOS_CFG).forEach(([k, id]) => { const v = $(id).value.trim(); if (v !== '') extra[k] = v; });
  const errCfg = validarConfigCliente(extra);
  if (errCfg) return mostrarError('umbError', errCfg);
  ['depositoMovimientos', 'diasAviso', 'margenDias'].forEach(k => { if (extra[k] !== undefined) extra[k] = Number(extra[k]); });
  const body = { umbrales: { rojo: Number(rojo), amarillo: Number(amarillo) }, ...extra };
  const ok = await enviar('umbOk', 'umbError', () => api('/api/vencimientos/config', { method: 'PUT', body }));
  if (ok) { cerrarModal('mUmb'); await cargarLotes(); }
});

// ── Mi sucursal ───────────────────────────────────────────────────────────────
function renderMia() {
  const { usuario } = estado.datos;
  const sinSucursal = !usuario.esAdmin && !usuario.idSucursal;
  $('miaAviso').innerHTML = sinSucursal ? '<div class="error-box">Tu usuario no tiene sucursal asignada. Pedile al administrador que la configure.</div>' : '';
  $('miaContenido').hidden = sinSucursal;
  if (sinSucursal) return;
  $('miaSelWrap').hidden = !usuario.esAdmin;
  if (usuario.esAdmin) {
    if (!estado.miSucursal) estado.miSucursal = Number(usuario.idSucursal || (estado.sucursalesLista[0] && estado.sucursalesLista[0].id) || estado.datos.sucursales[0]) || null;
    $('miaSucursal').innerHTML = opcionesSucursal(estado.miSucursal);
  } else estado.miSucursal = usuario.idSucursal;
  if (!estado.miSucursal) { $('miaMsg').innerHTML = '<div class="msg-vacio">No hay sucursales para mostrar.</div>'; return; }
  $('miaTitulo').textContent = nombreSuc(estado.miSucursal);
  renderMisLotes();
  cargarHistorial();
}

// Columnas Cruce / Oferta SIGA / Vencido SIGA / Vendido. Sin cruce: solo el vendido manual.
function celdasSiga(l, suc, c) {
  const x = cruceDe(l.id, suc);
  if (!x) return `<td class="num">${fmtNum(c.vendido)}</td>`;
  const ex = explicarDiferencia(x);
  const ref = x.origenVendido === 'siga' ? `<div class="text-xs text-gris">manual: ${fmtNum(x.vendidoManual)}</div>` : '';
  return `<td>${pillCruce(x)}${x.diferencia ? `<div class="text-xs text-gris">${signo(x.diferencia)}${ex ? ` · ${esc(ex)}` : ''}</div>` : ''}</td>
      <td class="num">${fmtNum(x.movidoOferta)}</td><td class="num">${fmtNum(x.movidoVencido)}</td>
      <td class="num">${fmtNum(x.vendido)}<div class="text-xs text-gris">${rotuloVendido(x)}</div>${ref}</td>`;
}

function renderMisLotes() {
  const suc = String(estado.miSucursal);
  const lotes = estado.datos.lotes.filter(l => l.sucursales[suc]);
  $('miaMsg').innerHTML = lotes.length ? '' : '<div class="msg-vacio">Esta sucursal todavía no cargó vencimientos.</div>';
  if (!lotes.length) { $('tablaMia').innerHTML = ''; return; }
  const filas = lotes.map(l => {
    const c = l.sucursales[suc], cerrado = estadoLoteSuc(l, suc) === 'cerrado';
    const bt = (accion, txt) => `<button type="button" class="btn btn-mini" data-acc="${accion}" data-lote="${esc(l.id)}" aria-label="${esc(txt)} de ${esc(l.nombre || l.idProducto)}">${txt}</button>`;
    return `<tr class="${cerrado ? 'cerrado' : ''}${loteAlerta(l) ? ' alerta' : ''}"><td>${pillSemaforo(l)}</td><td>${celdaProducto(l)}</td><td>${esc(fmtFecha(l.vencimiento))}</td><td class="num">${fmtNum(l.dias)}</td>
      <td class="num">${fmtNum(c.unidades)}</td><td class="num">${fmtNum(c.oferta)}</td>${celdasSiga(l, suc, c)}<td class="num font-semibold">${fmtNum(c.pendiente)}</td>
      <td><span class="pill ${cerrado ? 'pill--gris' : 'pill--verde'}">${esc(LOTE_TXT[estadoLoteSuc(l, suc)] || (cerrado ? 'Cerrado' : 'Cargado'))}</span></td>
      <td class="whitespace-nowrap">${bt('unidades', 'Corregir')} ${bt('oferta', 'Oferta')} ${bt('vendido', 'Vendido')}</td></tr>`;
  }).join('');
  $('tablaMia').innerHTML = `<thead><tr><th>Semáforo</th><th>Producto</th><th>Vence</th><th class="num">Días</th><th class="num">Unidades</th><th class="num">Oferta</th>${estado.cruce ? '<th>Cruce</th><th class="num">Oferta SIGA</th><th class="num">Vencido SIGA</th>' : ''}<th class="num">Vendido</th><th class="num">Pendiente</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>${filas}</tbody>`;
}

async function cargarHistorial() {
  $('histMsg').innerHTML = '<div class="msg-vacio"><span class="spin"></span> Cargando…</div>';
  const sucursal = estado.miSucursal;
  try {
    const q = estado.datos.usuario.esAdmin ? `?idSucursal=${encodeURIComponent(sucursal)}` : '';
    const { movimientos } = await api(`/api/vencimientos/historial${q}`);
    if (sucursal !== estado.miSucursal) return;
    $('histMsg').innerHTML = movimientos.length ? '' : '<div class="msg-vacio">Sin movimientos registrados.</div>';
    $('tablaHist').innerHTML = movimientos.length ? `<thead><tr><th>Fecha</th><th>Tipo</th><th>Producto</th><th>Vence</th><th class="num">Cantidad</th><th>Usuario</th></tr></thead><tbody>${
      movimientos.map(m => {
        const cant = m.cantidad ?? m.unidades;
        const extra = m.tipo === 'correccion' && m.anterior !== undefined ? ` <span class="text-xs text-gris">(antes ${fmtNum(m.anterior)})</span>` : '';
        return `<tr><td class="whitespace-nowrap">${esc(fmtFechaHora(m.fecha))}</td><td>${esc(TIPO_MOV[m.tipo] || m.tipo)}</td><td>${celdaProducto(m)}</td><td>${esc(fmtFecha(m.vencimiento))}</td><td class="num">${fmtNum(cant)}${extra}</td><td>${esc(m.usuario)}</td></tr>`;
      }).join('')}</tbody>` : '';
  } catch (e) {
    $('tablaHist').innerHTML = '';
    $('histMsg').innerHTML = `<div class="error-box" role="alert">${esc(e.message)}</div>`;
  }
}

$('miaSucursal').addEventListener('change', () => { estado.miSucursal = Number($('miaSucursal').value); renderMia(); });

// Acciones por fila: corregir unidades / anotar oferta / anotar vendido.
const ACCIONES = {
  unidades: { titulo: 'Corregir unidades', label: 'Unidades correctas', min: 0 },
  oferta: { titulo: 'Anotar oferta', label: 'Unidades a oferta', min: 1 },
  vendido: { titulo: 'Anotar vendido', label: 'Unidades vendidas', min: 1 },
};
$('tablaMia').addEventListener('click', e => {
  const b = e.target.closest('[data-acc]'); if (!b) return;
  const lote = estado.datos.lotes.find(l => l.id === b.dataset.lote); if (!lote) return;
  estado.loteAcc = { lote, accion: b.dataset.acc };
  const col = lote.sucursales[String(estado.miSucursal)], a = ACCIONES[b.dataset.acc];
  $('mAccT').textContent = a.titulo;
  $('accLbl').textContent = a.label;
  const input = $('accCant'); input.min = a.min;
  if (b.dataset.acc === 'unidades') { input.value = col.unidades; $('mAccSub').textContent = `${lote.nombre || lote.idProducto} · hoy ${fmtNum(col.unidades)} unidades`; input.removeAttribute('max'); }
  else { const max = maxMovimiento(col, b.dataset.acc); input.value = ''; input.max = max; $('mAccSub').textContent = `${lote.nombre || lote.idProducto} · podés anotar hasta ${fmtNum(max)}`; }
  mostrarError('accError', ''); abrirModal('mAcc', 'accCant'); input.select();
});

$('mAcc').querySelector('form').addEventListener('submit', async e => {
  e.preventDefault();
  const { lote, accion } = estado.loteAcc, a = ACCIONES[accion], raw = $('accCant').value.trim();
  if (!/^\d+$/.test(raw) || Number(raw) < a.min) return mostrarError('accError', a.min ? 'Ingresá un entero mayor a 0.' : 'Ingresá un entero mayor o igual a 0.');
  const col = lote.sucursales[String(estado.miSucursal)];
  if (accion !== 'unidades' && Number(raw) > maxMovimiento(col, accion)) return mostrarError('accError', `No puede pasar de ${fmtNum(maxMovimiento(col, accion))} (las unidades del lote).`);
  const base = `/api/vencimientos/lotes/${encodeURIComponent(lote.id)}`;
  const idSucursal = estado.datos.usuario.esAdmin ? estado.miSucursal : undefined;
  const tarea = accion === 'unidades'
    ? () => api(`${base}/unidades`, { method: 'PUT', body: { unidades: Number(raw), idSucursal } })
    : () => api(`${base}/movimientos`, { method: 'POST', body: { tipo: accion, cantidad: Number(raw), idSucursal } });
  const ok = await enviar('accOk', 'accError', tarea);
  if (ok) { cerrarModal('mAcc'); await cargarLotes(); }
});

// ── Tabs y sesión ─────────────────────────────────────────────────────────────
function activarTab(tab) {
  estado.tabActiva = tab;
  document.querySelectorAll('.navtab').forEach(b => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('on', on); b.setAttribute('aria-selected', on);
  });
  $('panelListado').hidden = tab !== 'listado';
  $('panelMia').hidden = tab !== 'mia';
  if (tab === 'mia' && estado.datos) renderMia();
}
document.querySelectorAll('.navtab').forEach(b => b.addEventListener('click', () => activarTab(b.dataset.tab)));

$('btnLogout').addEventListener('click', async () => {
  try { await fetch('/api/logout', { method: 'POST' }); } catch (_) { /* ignorar */ }
  location.href = '/login';
});

cargarSucursales().then(cargarLotes);
