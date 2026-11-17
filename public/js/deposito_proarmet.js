'use strict';
// Pantalla "Depósito Proarmet" (/deposito-proarmet): núcleo. Selector de depósito común + tabs (Stock, Historial);
// Ingresar y Devolver viven en deposito_proarmet_mov.js y se enganchan vía window.Proarmet.
// API: GET /api/proarmet/depositos, /stock?idDeposito=, /movimientos?idDeposito=&limit=. Todo texto del servidor pasa por esc().
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const fmt = n => Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: 3 });
  const norm = s => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const sk = cols => `<tr><td colspan="${cols}"><div class="sk"></div><div class="sk"></div><div class="sk"></div></td></tr>`;
  const HIST_LIMIT = 100;

  let deps = null;                       // respuesta de /depositos
  let stock = null;
  let hist = null;
  let tab = 'stock';
  let pedStock = 0, pedHist = 0;         // descartan respuestas viejas
  const cargada = {};                    // tab -> ya cargada para el depósito actual

  const msgFalla = (e, resp) => (e && e.error) || (resp ? `Error ${resp.status}` : 'No se pudo conectar con el servidor');
  async function api(url, opts) {
    let resp;
    try { resp = await fetch(url, opts); } catch (_) { throw new Error(msgFalla()); }
    const data = await resp.json().catch(() => null);
    if (!resp.ok || (data && data.error)) throw new Error(msgFalla(data, resp));
    return data;
  }
  function toast(texto, error) {
    const t = document.createElement('div');
    t.className = 'tst ' + (error ? 'tst-err' : 'tst-ok');
    t.textContent = texto;
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), error ? 9000 : 6000);
  }
  function aviso(texto) {
    $('aviso').textContent = texto || '';
    $('aviso').className = texto ? 'error mb-4' : 'hidden mb-4';
  }
  const idControlado = () => Number($('selControlado').value) || null;
  const nombreDep = id => ((deps && deps.depositos.find(d => d.idDeposito === id)) || {}).nombre || '';

  // ── Stock (solo consulta) ─────────────────────────────────────────────
  function renderStock() {
    if (!stock) return;
    const q = norm($('flBuscar').value.trim());
    const lista = stock.productos.filter(p => !q || String(p.idProducto).includes(q) || norm(p.descripcion).includes(q));
    $('conteo').textContent = `${lista.length} de ${stock.productos.length} productos`;
    $('cuerpo').innerHTML = lista.length ? lista.map(p => `<tr><td class="num">${esc(p.idProducto)}</td><td>${esc(p.descripcion)}</td><td class="num">${fmt(p.stock)}</td></tr>`).join('')
      : `<tr><td colspan="3"><div class="vacio"><b>${stock.productos.length ? 'Sin coincidencias' : 'No hay stock en este depósito'}</b>${stock.productos.length ? 'Probá con otra búsqueda.' : 'Usá "Ingresar mercadería" para cargar productos.'}</div></td></tr>`;
  }
  function vacioStock(texto) {
    stock = null;
    $('cuerpo').innerHTML = texto ? `<tr><td colspan="3"><div class="vacio"><b>${esc(texto)}</b></div></td></tr>` : '';
    $('conteo').textContent = '';
  }
  async function cargarStock() {
    const id = idControlado();
    if (!id) return vacioStock('Elegí un depósito');
    const mio = ++pedStock;
    $('cuerpo').innerHTML = sk(3);
    try {
      const r = await api(`/api/proarmet/stock?idDeposito=${id}`);
      if (mio !== pedStock) return;
      stock = r; cargada.stock = true;
      $('bajada').textContent = r.tipoMovimiento ? `Tipo de movimiento: ${r.tipoMovimiento}` : '';
      renderStock();
    } catch (e) {
      if (mio !== pedStock) return;
      vacioStock(''); aviso(e.message);
    }
  }

  // ── Historial ─────────────────────────────────────────────────────────
  const fechaHora = f => { const d = new Date(f); return isNaN(d) ? esc(f) : d.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }); };
  const depTxt = (id, nombre) => esc(nombre || nombreDep(id) || `Depósito ${id}`);
  function badgeEstado(m) {
    const e = String(m.estado || '').toLowerCase();
    if (m.revertidoPor || e.includes('revert')) return `<span class="badge b-rev">Revertido${m.revertidoPor ? ` (#${esc(m.revertidoPor)})` : ''}</span>`;
    if (e.includes('fall') || e.includes('error')) return '<span class="badge b-fail">Fallido</span>';
    return `<span class="badge">${esc(m.estado || '-')}</span>`;
  }
  function renderHist() {
    const cuerpo = $('histCuerpo');
    $('histConteo').textContent = hist ? `${hist.length} movimientos` : '';
    if (!hist || !hist.length) { cuerpo.innerHTML = '<tr><td colspan="7"><div class="vacio"><b>Sin movimientos</b>Todavía no hay movimientos de este depósito.</div></td></tr>'; return; }
    cuerpo.innerHTML = hist.map((m, i) => `<tr class="hist" data-i="${i}" tabindex="0" aria-expanded="false">
        <td>${fechaHora(m.fecha)}</td>
        <td><span class="badge ${m.tipo === 'ingreso' ? 'b-ing' : 'b-sal'}">${m.tipo === 'ingreso' ? 'Ingreso' : 'Salida'}</span></td>
        <td class="num">${esc(m.numeroMovimiento)}</td>
        <td>${depTxt(m.depOrigen, m.depOrigenNombre)} → ${depTxt(m.depDestino, m.depDestinoNombre)}</td>
        <td>${esc(m.usuario)}</td><td>${esc(m.descripcion)}</td><td>${badgeEstado(m)}</td></tr>`).join('');
  }
  function alternarDetalle(tr) {
    const sig = tr.nextElementSibling;
    if (sig && sig.classList.contains('det')) { sig.remove(); tr.setAttribute('aria-expanded', 'false'); return; }
    const m = hist[Number(tr.dataset.i)];
    const ls = (m && m.lineas) || [];
    const det = document.createElement('tr');
    det.className = 'det';
    det.innerHTML = `<td colspan="7">${ls.length ? `<table class="tabla"><tbody>${ls.map(l => `<tr><td class="num" style="width:90px">${esc(l.idProducto)}</td><td>${esc(l.descripcion || '')}</td><td class="num" style="width:110px">${fmt(l.cantidad)}</td></tr>`).join('')}</tbody></table>` : 'Sin líneas.'}</td>`;
    tr.after(det);
    tr.setAttribute('aria-expanded', 'true');
  }
  async function cargarHist() {
    const id = idControlado();
    if (!id) { hist = null; $('histCuerpo').innerHTML = '<tr><td colspan="7"><div class="vacio"><b>Elegí un depósito</b></div></td></tr>'; $('histConteo').textContent = ''; return; }
    const mio = ++pedHist;
    $('histCuerpo').innerHTML = sk(7);
    $('btnHist').disabled = true;
    try {
      const r = await api(`/api/proarmet/movimientos?idDeposito=${id}&limit=${HIST_LIMIT}`);
      if (mio !== pedHist) return;
      hist = r.movimientos || []; cargada.historial = true;
      renderHist();
    } catch (e) {
      if (mio !== pedHist) return;
      hist = null; $('histCuerpo').innerHTML = ''; $('histConteo').textContent = ''; aviso(e.message);
    } finally { if (mio === pedHist) $('btnHist').disabled = false; }
  }

  // ── Tabs (carga lazy) ─────────────────────────────────────────────────
  const cargadores = { stock: cargarStock, historial: cargarHist };
  function cargarTab(nombre) {
    aviso('');
    if (!deps) return;
    const mov = window.Proarmet.movs[nombre];
    if (mov) mov.mostrar(); else cargadores[nombre]();
  }
  function activarTab(nombre) {
    tab = nombre;
    document.querySelectorAll('.tab').forEach(b => {
      const on = b.dataset.tab === nombre;
      b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1;
      $('panel-' + b.dataset.tab).classList.toggle('hidden', !on);
    });
    if (!cargada[nombre]) cargarTab(nombre);
  }
  // Un movimiento confirmado deja viejos el stock y el historial: la tab activa se refresca ya, la otra al entrar.
  function movimientoHecho() {
    cargada.stock = false; cargada.historial = false;
    if (tab === 'stock' || tab === 'historial') cargarTab(tab);
  }
  function cambioDeposito() {
    for (const k of ['stock', 'historial']) cargada[k] = false;
    for (const m of Object.values(window.Proarmet.movs)) m.invalidar();
    $('titulo').textContent = (nombreDep(idControlado()) || 'Depósito Proarmet').toUpperCase();
    cargarTab(tab);
  }

  async function cargarDepositos() {
    aviso('');
    $('btnRecargar').disabled = true;
    try {
      deps = await api('/api/proarmet/depositos');
      const sel = $('selControlado');
      sel.innerHTML = '<option value="">Elegí un depósito…</option>' + deps.depositos.map(d => `<option value="${esc(d.idDeposito)}">${esc(d.nombre)}</option>`).join('');
      sel.disabled = false;
      if (deps.defaultControlado != null) sel.value = String(deps.defaultControlado);
    } catch (e) {
      deps = null; vacioStock('');
      aviso(`No se pudieron cargar los depósitos: ${e.message}`);
      $('btnRecargar').disabled = false;
      return;
    }
    $('btnRecargar').disabled = false;
    cambioDeposito();
  }

  window.Proarmet = {
    $, esc, fmt, norm, sk, api, toast, idControlado, movimientoHecho,
    getDeps: () => deps, movs: {},
  };

  document.querySelector('.tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) activarTab(b.dataset.tab); });
  document.querySelector('.tabs').addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const bs = [...document.querySelectorAll('.tab')];
    const n = bs[(bs.findIndex(b => b.dataset.tab === tab) + (e.key === 'ArrowRight' ? 1 : bs.length - 1)) % bs.length];
    activarTab(n.dataset.tab); n.focus();
  });
  $('flBuscar').addEventListener('input', renderStock);
  $('btnRecargar').addEventListener('click', cargarDepositos);
  $('btnHist').addEventListener('click', cargarHist);
  $('selControlado').addEventListener('change', cambioDeposito);
  $('histCuerpo').addEventListener('click', e => { const tr = e.target.closest('tr.hist'); if (tr) alternarDetalle(tr); });
  $('histCuerpo').addEventListener('keydown', e => {
    const tr = e.target.closest('tr.hist');
    if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); alternarDetalle(tr); }
  });

  // deposito_proarmet_mov.js registra sus tabs al cargar (después de este archivo): se arranca al terminar de parsear.
  window.addEventListener('DOMContentLoaded', cargarDepositos);
})();
