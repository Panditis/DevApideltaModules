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

  // ── Ubicaciones del depósito controlado: una sola carga compartida (tab Ubicaciones, Ingresar, Devolver, remito) ──
  // cargar(forzar) -> Promise<{ubicaciones:[...]}|null>; si falla resuelve null y el resto sigue sin ubicaciones.
  let ubicP = null, ubicId = null, ubicMapa = new Map();
  const ubicaciones = {
    cargar(forzar) {
      const id = idControlado();
      if (!id) { ubicP = null; ubicMapa = new Map(); return Promise.resolve(null); }
      if (!forzar && ubicP && ubicId === id) return ubicP;
      ubicId = id;
      const p = api(`/api/proarmet/ubicaciones?idDeposito=${id}`).then(r => {
        if (ubicP !== p) return r;
        const m = new Map();
        for (const u of (r && r.ubicaciones) || []) for (const pr of u.productos || []) {
          const k = String(pr.idProducto);
          if (!m.has(k)) m.set(k, []);
          m.get(k).push({ nombre: u.nombre });
        }
        ubicMapa = m;
        return r;
      }).catch(() => { if (ubicP === p) { ubicP = null; ubicMapa = new Map(); } return null; });
      ubicP = p;
      return p;
    },
    invalidar() { ubicP = null; ubicMapa = new Map(); },
    // Texto plano "Estante A, Pasillo 2" o '' si el producto no está en ninguna ubicación.
    texto: id => (ubicMapa.get(String(id)) || []).map(u => u.nombre).join(', '),
    html(id) { const t = this.texto(id); return t ? esc(t) : '<span class="text-gris">Sin ubicación</span>'; },
  };

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
    if (!hist || !hist.length) { cuerpo.innerHTML = '<tr><td colspan="8"><div class="vacio"><b>Sin movimientos</b>Todavía no hay movimientos de este depósito.</div></td></tr>'; return; }
    cuerpo.innerHTML = hist.map((m, i) => `<tr class="hist" data-i="${i}" tabindex="0" aria-expanded="false">
        <td>${fechaHora(m.fecha)}</td>
        <td><span class="badge ${m.tipo === 'ingreso' ? 'b-ing' : 'b-sal'}">${m.tipo === 'ingreso' ? 'Ingreso' : 'Salida'}</span></td>
        <td class="num">${esc(m.numeroMovimiento)}</td>
        <td>${depTxt(m.depOrigen, m.depOrigenNombre)} → ${depTxt(m.depDestino, m.depDestinoNombre)}</td>
        <td>${esc(m.usuario)}</td><td>${esc(m.descripcion)}</td><td>${badgeEstado(m)}</td>
        <td><button type="button" class="btn btn-rem" data-remito="${i}" aria-label="Imprimir remito del movimiento ${esc(m.numeroMovimiento)}">Remito</button></td></tr>`).join('');
  }
  function alternarDetalle(tr) {
    const sig = tr.nextElementSibling;
    if (sig && sig.classList.contains('det')) { sig.remove(); tr.setAttribute('aria-expanded', 'false'); return; }
    const m = hist[Number(tr.dataset.i)];
    const ls = (m && m.lineas) || [];
    const det = document.createElement('tr');
    det.className = 'det';
    det.innerHTML = `<td colspan="8">${ls.length ? `<table class="tabla"><tbody>${ls.map(l => `<tr><td class="num" style="width:90px">${esc(l.idProducto)}</td><td>${esc(l.descripcion || '')}</td><td class="num" style="width:110px">${fmt(l.cantidad)}</td></tr>`).join('')}</tbody></table>` : 'Sin líneas.'}</td>`;
    tr.after(det);
    tr.setAttribute('aria-expanded', 'true');
  }
  async function cargarHist() {
    const id = idControlado();
    if (!id) { hist = null; $('histCuerpo').innerHTML = '<tr><td colspan="8"><div class="vacio"><b>Elegí un depósito</b></div></td></tr>'; $('histConteo').textContent = ''; return; }
    const mio = ++pedHist;
    $('histCuerpo').innerHTML = sk(8);
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

  // ── Remito (window.print + @media print sobre #remito; el usuario elige "Guardar como PDF") ──
  // datos: { numeroMovimiento, fecha, tipo, depOrigenNombre, depDestinoNombre, usuario, descripcion, lineas:[{idProducto, descripcion, cantidad}] }
  function renderRemito(d) {
    const ls = d.lineas || [];
    const f = new Date(d.fecha);
    const fh = isNaN(f) ? esc(d.fecha) : f.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
    const firma = (tit, nombre) => `<div class="rm-firma"><h3>${tit}</h3><div class="rm-caja"><span>Firma</span></div>
      <div class="rm-linea"><span>Aclaración:</span>${esc(nombre)}</div><div class="rm-linea"><span>Fecha:</span></div></div>`;
    $('remito').innerHTML = `<h1>REMITO DE MOVIMIENTO INTERNO</h1>
      <table class="rm-datos"><tr><th>Movimiento Nº</th><td>${esc(d.numeroMovimiento)}</td><th>Fecha y hora</th><td>${fh}</td></tr>
        <tr><th>Tipo</th><td>${esc(d.tipo || '-')}</td><th>Responsable</th><td>${esc(d.usuario || '-')}</td></tr>
        <tr><th>Origen</th><td>${esc(d.depOrigenNombre)}</td><th>Destino</th><td>${esc(d.depDestinoNombre)}</td></tr>
        <tr><th>Descripción</th><td colspan="3">${esc(d.descripcion)}</td></tr></table>
      <table class="rm-items"><thead><tr><th style="width:90px">Código</th><th>Producto</th><th style="width:200px">${esc(d.ubicRotulo || 'Ubicación')}</th><th class="num" style="width:90px">Cantidad</th></tr></thead>
        <tbody>${ls.map(l => `<tr><td>${esc(l.idProducto)}</td><td>${esc(l.descripcion || '')}</td><td>${esc(ubicaciones.texto(l.idProducto) || 'Sin ubicación')}</td><td class="num">${fmt(l.cantidad)}</td></tr>`).join('')}</tbody></table>
      <div class="rm-cierre"><p class="rm-total">Movimiento Nº ${esc(d.numeroMovimiento)} · Total: ${ls.length} línea${ls.length === 1 ? '' : 's'}</p>
      <div class="rm-firmas">${firma('Entrega', d.usuario)}${firma('Recibe', '')}</div></div>`;
  }
  // Imprime después de pintar el DOM; un fallo de impresión no afecta al movimiento ya registrado.
  async function imprimirRemito(d) {
    try {
      await ubicaciones.cargar(); // cacheado; si falla, el remito sale sin ubicaciones
      renderRemito(d);
      document.body.classList.add('imprimiendo');
      window.addEventListener('afterprint', () => document.body.classList.remove('imprimiendo'), { once: true });
      requestAnimationFrame(() => setTimeout(() => {
        try { window.print(); } catch (_) { document.body.classList.remove('imprimiendo'); }
      }, 50));
    } catch (e) { document.body.classList.remove('imprimiendo'); toast('No se pudo generar el remito: ' + e.message, true); }
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
  // Un movimiento confirmado deja viejos el stock y el historial: se pasa al Historial (recargado); el stock se recarga al entrar.
  function movimientoHecho() {
    cargada.stock = false; cargada.historial = false;
    activarTab('historial');
  }
  function cambioDeposito() {
    for (const k of ['stock', 'historial']) cargada[k] = false;
    ubicaciones.invalidar();
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
    $, esc, fmt, norm, sk, api, toast, idControlado, ubicaciones, movimientoHecho, imprimirRemito, nombreDep,
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
  function remitoDeHist(i) {
    const m = hist && hist[i];
    if (!m) return;
    imprimirRemito({ ...m, tipo: m.tipoMovimiento || (deps && deps.tipoMovimiento) || '', depOrigenNombre: m.depOrigenNombre || nombreDep(m.depOrigen), depDestinoNombre: m.depDestinoNombre || nombreDep(m.depDestino), ubicRotulo: 'Ubicación actual' });
  }
  $('histCuerpo').addEventListener('click', e => {
    const b = e.target.closest('[data-remito]');
    if (b) { remitoDeHist(Number(b.dataset.remito)); return; }
    const tr = e.target.closest('tr.hist'); if (tr) alternarDetalle(tr);
  });
  $('histCuerpo').addEventListener('keydown', e => {
    if (e.target.closest('[data-remito]')) return; // Enter/Espacio sobre el botón lo activa el navegador
    const tr = e.target.closest('tr.hist');
    if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); alternarDetalle(tr); }
  });

  // deposito_proarmet_mov.js registra sus tabs al cargar (después de este archivo): se arranca al terminar de parsear.
  window.addEventListener('DOMContentLoaded', cargarDepositos);
})();
