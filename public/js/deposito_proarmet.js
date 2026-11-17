'use strict';
// Pantalla "Depósito Proarmet" (/deposito-proarmet). Tabla con el stock del depósito, devolución a Casa central
// (selección de filas + cantidad) y envío desde Casa central (modal con todos los productos de SIGA).
// API: GET /api/proarmet/stock, GET /api/proarmet/productos, POST /api/proarmet/movimiento ({ error } si falla).
// Todo texto que viene del servidor pasa por esc() antes de ir a innerHTML.
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const fmt = n => Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: 3 });
  const norm = s => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const MAX_FILAS_IDA = 200; // el catálogo de SIGA es largo: se pintan las primeras coincidencias, el buscador afina

  let stock = null;               // respuesta de /api/proarmet/stock
  let catalogo = null;            // respuesta de /api/proarmet/productos (se pide al abrir el modal de ida)
  const aDevolver = new Map();    // idProducto -> cantidad (string del input), solo filas tildadas
  const aEnviar = new Map();      // idProducto -> cantidad (string del input) del modal de ida
  let enviando = false;

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

  // ── Tabla principal ───────────────────────────────────────────────────
  const filtrados = () => {
    const q = norm($('flBuscar').value.trim());
    return stock.productos.filter(p => !q || String(p.idProducto).includes(q) || norm(p.descripcion).includes(q));
  };

  function renderTabla() {
    const cuerpo = $('cuerpo');
    if (!stock) return;
    const lista = filtrados();
    $('conteo').textContent = `${lista.length} de ${stock.productos.length} productos`;
    if (!lista.length) {
      cuerpo.innerHTML = `<tr><td colspan="5"><div class="vacio"><b>${stock.productos.length ? 'Sin coincidencias' : 'No hay stock en Proarmet'}</b>${stock.productos.length ? 'Probá con otra búsqueda.' : 'Usá "Mover a Proarmet" para cargar productos.'}</div></td></tr>`;
    } else {
      cuerpo.innerHTML = lista.map(p => {
        const on = aDevolver.has(p.idProducto);
        return `<tr class="${on ? 'sel' : ''}" data-id="${esc(p.idProducto)}">
          <td><input type="checkbox" data-chk aria-label="Seleccionar ${esc(p.descripcion)}" ${on ? 'checked' : ''}></td>
          <td class="num">${esc(p.idProducto)}</td><td>${esc(p.descripcion)}</td><td class="num">${fmt(p.stock)}</td>
          <td class="num"><input type="number" class="ctl qty" data-qty min="0" max="${esc(p.stock)}" step="any" inputmode="decimal"
            aria-label="Cantidad a devolver de ${esc(p.descripcion)}" value="${on ? esc(aDevolver.get(p.idProducto)) : ''}" ${on ? '' : 'disabled'}></td></tr>`;
      }).join('');
    }
    $('selTodos').checked = lista.length > 0 && lista.every(p => aDevolver.has(p.idProducto));
    actualizarBotones();
  }

  function actualizarBotones() {
    const n = aDevolver.size;
    $('btnVuelta').disabled = n === 0;
    $('btnVuelta').textContent = n ? `Devolver a Casa central (${n})` : 'Devolver a Casa central';
    $('btnIda').disabled = !stock;
  }

  function marcar(id, on) {
    const p = stock.productos.find(x => x.idProducto === id);
    if (!p) return;
    if (on) aDevolver.set(id, String(p.stock)); else aDevolver.delete(id);
  }

  async function cargarStock() {
    $('aviso').classList.add('hidden');
    $('cuerpo').innerHTML = '<tr><td colspan="5"><div class="sk"></div><div class="sk"></div><div class="sk"></div></td></tr>';
    $('btnRecargar').disabled = true;
    try {
      stock = await api('/api/proarmet/stock');
      catalogo = null; // el stock cambió: el catálogo del modal de ida se vuelve a pedir
      const vigentes = new Set(stock.productos.map(p => p.idProducto));
      for (const id of [...aDevolver.keys()]) if (!vigentes.has(id)) aDevolver.delete(id);
      const d = stock.deposito || {};
      $('titulo').textContent = String(d.nombre || 'Depósito Proarmet').toUpperCase();
      $('bajada').textContent = stock.tipoMovimiento ? `Tipo de movimiento: ${stock.tipoMovimiento}` : '';
      renderTabla();
    } catch (e) {
      stock = null;
      $('cuerpo').innerHTML = '';
      $('conteo').textContent = '';
      $('aviso').textContent = e.message;
      $('aviso').className = 'error mb-4';
      actualizarBotones();
    } finally {
      $('btnRecargar').disabled = false;
    }
  }

  // ── Diálogos ──────────────────────────────────────────────────────────
  function mostrarError(id, texto) {
    const n = $(id);
    n.textContent = texto || '';
    n.classList.toggle('hidden', !texto);
  }

  function abrir(dlg) {
    dlg.querySelectorAll('.error').forEach(n => n.classList.add('hidden'));
    dlg.showModal();
  }

  const nombreSitio = s => (s && s.nombre) || '—';
  const ruta = (a, b) => `${nombreSitio(a)} → ${nombreSitio(b)}`;

  // Valida cantidades y descripción; devuelve { lineas } o muestra el error y devuelve null.
  function armarLineas(items, descId, errId, max) {
    const descripcion = $(descId).value.trim();
    const lineas = [];
    for (const [id, cant] of items) {
      const cantidad = Number(cant);
      if (!(cantidad > 0)) continue;
      const tope = max && max(id);
      if (tope != null && cantidad > tope) { mostrarError(errId, `La cantidad del producto ${id} supera el stock (${fmt(tope)}).`); return null; }
      lineas.push({ idProducto: id, cantidad });
    }
    if (!lineas.length) { mostrarError(errId, 'Cargá una cantidad mayor a 0 en al menos un producto.'); return null; }
    if (!descripcion) { mostrarError(errId, 'La descripción es obligatoria.'); $(descId).setAttribute('aria-invalid', 'true'); $(descId).focus(); return null; }
    $(descId).removeAttribute('aria-invalid');
    return { descripcion, lineas };
  }

  async function confirmar(sentido, payload, dlg, errId, btnId) {
    if (enviando) return; // evita doble envío
    enviando = true;
    const btn = $(btnId);
    const textoBtn = btn.textContent;
    btn.disabled = true; btn.textContent = 'Enviando…';
    mostrarError(errId, '');
    try {
      const r = await api('/api/proarmet/movimiento', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sentido, descripcion: payload.descripcion, lineas: payload.lineas }),
      });
      dlg.close();
      toast(`Movimiento ${r.numeroMovimiento} registrado (${payload.lineas.length} producto${payload.lineas.length === 1 ? '' : 's'}).`);
      if (sentido === 'ida') aEnviar.clear(); else aDevolver.clear();
      await cargarStock();
    } catch (e) {
      mostrarError(errId, e.message);
      toast(e.message, true);
    } finally {
      enviando = false;
      btn.disabled = false; btn.textContent = textoBtn;
    }
  }

  // ── Ida: Casa central -> Proarmet ─────────────────────────────────────
  function renderIda() {
    if (!catalogo) return;
    const q = norm($('iBuscar').value.trim());
    const todos = catalogo.productos.filter(p => !q || String(p.idProducto).includes(q) || norm(p.descripcion).includes(q));
    const lista = todos.slice(0, MAX_FILAS_IDA);
    $('iConteo').textContent = todos.length > lista.length ? `Mostrando ${lista.length} de ${todos.length}: afiná la búsqueda` : `${todos.length} productos`;
    $('iCuerpo').innerHTML = lista.length ? lista.map(p => `<tr data-id="${esc(p.idProducto)}">
        <td class="num">${esc(p.idProducto)}</td><td>${esc(p.descripcion)}</td>
        <td class="num">${fmt(p.stockCentral)}</td><td class="num">${fmt(p.stockDeposito)}</td>
        <td class="num"><input type="number" class="ctl qty" data-qty min="0" step="any" inputmode="decimal"
          aria-label="Cantidad a mover de ${esc(p.descripcion)}" value="${esc(aEnviar.get(p.idProducto) || '')}"></td></tr>`).join('')
      : '<tr><td colspan="5"><div class="vacio"><b>Sin coincidencias</b>Probá con otra búsqueda.</div></td></tr>';
    contarCargados();
  }

  function contarCargados() {
    const n = [...aEnviar.values()].filter(v => Number(v) > 0).length;
    $('iCargados').textContent = n ? `${n} producto${n === 1 ? '' : 's'} con cantidad` : '';
  }

  async function abrirIda() {
    $('iRuta').textContent = ruta(stock.central, stock.deposito);
    $('iDesc').value = '';
    $('iBuscar').value = '';
    $('iOk').disabled = true;
    $('iCuerpo').innerHTML = '<tr><td colspan="5"><div class="sk"></div><div class="sk"></div><div class="sk"></div></td></tr>';
    aEnviar.clear();
    abrir($('dlgIda'));
    try {
      if (!catalogo) catalogo = await api('/api/proarmet/productos');
      $('iOk').disabled = false;
      renderIda();
      $('iBuscar').focus();
    } catch (e) {
      $('iCuerpo').innerHTML = '';
      mostrarError('iError', e.message);
    }
  }

  // ── Vuelta: Proarmet -> Casa central ──────────────────────────────────
  function abrirVuelta() {
    const items = stock.productos.filter(p => aDevolver.has(p.idProducto));
    $('vRuta').textContent = ruta(stock.deposito, stock.central);
    $('vDesc').value = '';
    $('vCuerpo').innerHTML = items.map(p => `<tr data-id="${esc(p.idProducto)}">
        <td class="num">${esc(p.idProducto)}</td><td>${esc(p.descripcion)}</td><td class="num">${fmt(p.stock)}</td>
        <td class="num"><input type="number" class="ctl qty" data-qty min="0" max="${esc(p.stock)}" step="any" inputmode="decimal"
          aria-label="Cantidad a devolver de ${esc(p.descripcion)}" value="${esc(aDevolver.get(p.idProducto))}"></td></tr>`).join('');
    abrir($('dlgVuelta'));
    $('vDesc').focus();
  }

  // ── Eventos ───────────────────────────────────────────────────────────
  const idDeFila = e => { const tr = e.target.closest('tr[data-id]'); return tr ? Number(tr.dataset.id) : null; };

  $('flBuscar').addEventListener('input', renderTabla);
  $('btnRecargar').addEventListener('click', cargarStock);
  $('btnIda').addEventListener('click', abrirIda);
  $('btnVuelta').addEventListener('click', abrirVuelta);

  $('cuerpo').addEventListener('change', e => {
    const id = idDeFila(e);
    if (id == null) return;
    if (e.target.matches('[data-chk]')) { marcar(id, e.target.checked); renderTabla(); }
  });
  $('cuerpo').addEventListener('input', e => {
    const id = idDeFila(e);
    if (id != null && e.target.matches('[data-qty]')) aDevolver.set(id, e.target.value);
  });
  $('selTodos').addEventListener('change', e => {
    for (const p of filtrados()) marcar(p.idProducto, e.target.checked);
    renderTabla();
  });

  $('iBuscar').addEventListener('input', renderIda);
  $('iCuerpo').addEventListener('input', e => {
    const id = idDeFila(e);
    if (id == null || !e.target.matches('[data-qty]')) return;
    aEnviar.set(id, e.target.value);
    contarCargados();
  });
  $('vCuerpo').addEventListener('input', e => {
    const id = idDeFila(e);
    if (id != null && e.target.matches('[data-qty]')) aDevolver.set(id, e.target.value);
  });

  $('formIda').addEventListener('submit', e => {
    e.preventDefault();
    if (!catalogo) return;
    const p = armarLineas(aEnviar, 'iDesc', 'iError');
    if (p) confirmar('ida', p, $('dlgIda'), 'iError', 'iOk');
  });
  $('formVuelta').addEventListener('submit', e => {
    e.preventDefault();
    const p = armarLineas(aDevolver, 'vDesc', 'vError', id => (stock.productos.find(x => x.idProducto === id) || {}).stock);
    if (p) confirmar('vuelta', p, $('dlgVuelta'), 'vError', 'vOk');
  });

  document.querySelectorAll('dialog').forEach(d => {
    d.addEventListener('click', e => { if (e.target === d || e.target.closest('[data-cerrar]')) { if (!enviando) d.close(); } });
    d.addEventListener('cancel', e => { if (enviando) e.preventDefault(); }); // Esc no cierra mientras se envía
  });

  cargarStock();
})();
