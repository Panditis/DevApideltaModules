'use strict';
// Pantalla "Depósito Proarmet" (/deposito-proarmet). Se elige el depósito a controlar; la tabla muestra su stock y un
// único modal mueve mercadería entre dos depósitos cualesquiera (ingreso o devolución: solo cambia el preset).
// API: GET /api/proarmet/depositos, /stock?idDeposito=, /productos?origen=&destino=, POST /movimiento ({ error } si falla).
// Todo texto que viene del servidor pasa por esc() antes de ir a innerHTML.
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const fmt = n => Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: 3 });
  const norm = s => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const MAX_FILAS = 200; // el catálogo de SIGA es largo: se pintan las primeras coincidencias, el buscador afina
  const SK = '<tr><td colspan="5"><div class="sk"></div><div class="sk"></div><div class="sk"></div></td></tr>';

  let deps = null;                // respuesta de /api/proarmet/depositos
  let stock = null;               // respuesta de /api/proarmet/stock del depósito controlado
  let catalogo = null;            // respuesta de /api/proarmet/productos para el par origen/destino del modal
  let pedidoCat = 0;              // descarta respuestas viejas del catálogo
  const aDevolver = new Map();    // idProducto -> cantidad (string), filas tildadas de la tabla
  const aMover = new Map();       // idProducto -> cantidad (string) del modal
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

  function aviso(texto) {
    $('aviso').textContent = texto || '';
    $('aviso').className = texto ? 'error mb-4' : 'hidden mb-4';
  }

  const idControlado = () => Number($('selControlado').value) || null;
  const nombreDep = id => ((deps && deps.depositos.find(d => d.idDeposito === id)) || {}).nombre || '';

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
      cuerpo.innerHTML = `<tr><td colspan="5"><div class="vacio"><b>${stock.productos.length ? 'Sin coincidencias' : 'No hay stock en este depósito'}</b>${stock.productos.length ? 'Probá con otra búsqueda.' : 'Usá "Ingresar mercadería" para cargar productos.'}</div></td></tr>`;
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

  // Ingresar y Devolver dependen solo de que haya depósitos cargados, no de que el stock se haya podido leer.
  function actualizarBotones() {
    const n = aDevolver.size;
    $('btnIda').disabled = !deps;
    $('btnVuelta').disabled = !deps || n === 0;
    $('btnVuelta').textContent = n ? `Devolver (${n})` : 'Devolver';
  }

  function marcar(id, on) {
    const p = stock.productos.find(x => x.idProducto === id);
    if (!p) return;
    if (on) aDevolver.set(id, String(p.stock)); else aDevolver.delete(id);
  }

  function sinStock(texto) {
    stock = null;
    $('cuerpo').innerHTML = texto ? `<tr><td colspan="5"><div class="vacio"><b>${esc(texto)}</b></div></td></tr>` : '';
    $('conteo').textContent = '';
    actualizarBotones();
  }

  async function cargarStock() {
    aviso('');
    const id = idControlado();
    $('titulo').textContent = (nombreDep(id) || 'Depósito Proarmet').toUpperCase();
    if (!deps) return;
    if (!id) { aDevolver.clear(); sinStock('Elegí un depósito'); return; }
    $('cuerpo').innerHTML = SK;
    $('btnRecargar').disabled = true;
    try {
      const r = await api(`/api/proarmet/stock?idDeposito=${id}`);
      if (id !== idControlado()) return; // se cambió de depósito mientras cargaba
      stock = r;
      const vigentes = new Set(stock.productos.map(p => p.idProducto));
      for (const k of [...aDevolver.keys()]) if (!vigentes.has(k)) aDevolver.delete(k);
      $('bajada').textContent = stock.tipoMovimiento ? `Tipo de movimiento: ${stock.tipoMovimiento}` : '';
      renderTabla();
    } catch (e) {
      sinStock('');
      aviso(e.message);
    } finally {
      $('btnRecargar').disabled = false;
    }
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
      actualizarBotones();
    } catch (e) {
      deps = null;
      sinStock('');
      aviso(`No se pudieron cargar los depósitos: ${e.message}`);
      $('btnRecargar').disabled = false;
      return;
    }
    await cargarStock();
  }

  // ── Modal de movimiento ───────────────────────────────────────────────
  function mostrarError(texto) {
    const n = $('mError');
    n.textContent = texto || '';
    n.classList.toggle('hidden', !texto);
  }

  const opcionesDep = sel => { $(sel).innerHTML = deps.depositos.map(d => `<option value="${esc(d.idDeposito)}">${esc(d.nombre)}</option>`).join(''); };
  const parMov = () => ({ origen: Number($('mOrigen').value) || null, destino: Number($('mDestino').value) || null });

  function renderCat() {
    if (!catalogo) return;
    const q = norm($('mBuscar').value.trim());
    const todos = catalogo.productos.filter(p => !q || String(p.idProducto).includes(q) || norm(p.descripcion).includes(q));
    const lista = todos.slice(0, MAX_FILAS);
    $('mConteo').textContent = todos.length > lista.length ? `Mostrando ${lista.length} de ${todos.length}: afiná la búsqueda` : `${todos.length} productos`;
    $('mCuerpo').innerHTML = lista.length ? lista.map(p => `<tr data-id="${esc(p.idProducto)}">
        <td class="num">${esc(p.idProducto)}</td><td>${esc(p.descripcion)}</td>
        <td class="num">${fmt(p.stockOrigen)}</td><td class="num">${fmt(p.stockDestino)}</td>
        <td class="num"><input type="number" class="ctl qty" data-qty min="0" max="${esc(Math.max(0, Number(p.stockOrigen) || 0))}" step="any" inputmode="decimal"
          aria-label="Cantidad a mover de ${esc(p.descripcion)}" value="${esc(aMover.get(p.idProducto) || '')}"></td></tr>`).join('')
      : '<tr><td colspan="5"><div class="vacio"><b>Sin coincidencias</b>Probá con otra búsqueda.</div></td></tr>';
    contarCargados();
  }

  function contarCargados() {
    const n = [...aMover.values()].filter(v => Number(v) > 0).length;
    $('mCargados').textContent = n ? `${n} producto${n === 1 ? '' : 's'} con cantidad` : '';
  }

  // Pide el catálogo del par origen/destino actual; las cantidades cargadas se conservan (están en aMover).
  async function cargarCatalogo() {
    const { origen, destino } = parMov();
    mostrarError('');
    catalogo = null;
    pedidoCat++;
    $('mOk').disabled = true;
    if (!origen || !destino) { $('mCuerpo').innerHTML = ''; return; }
    if (origen === destino) { $('mCuerpo').innerHTML = ''; mostrarError('El origen y el destino no pueden ser el mismo depósito.'); return; }
    const mio = pedidoCat;
    $('mCuerpo').innerHTML = SK;
    try {
      const r = await api(`/api/proarmet/productos?origen=${origen}&destino=${destino}`);
      if (mio !== pedidoCat) return;
      catalogo = r;
      $('mOk').disabled = false;
      renderCat();
    } catch (e) {
      if (mio !== pedidoCat) return;
      $('mCuerpo').innerHTML = '';
      mostrarError(e.message);
    }
  }

  // preset: 'ingreso' (origen = central, destino = controlado) o 'devolucion' (al revés, con las filas tildadas).
  function abrirMov(preset) {
    if (!deps) return;
    const devol = preset === 'devolucion';
    const ctl = idControlado() || (deps.depositos[0] || {}).idDeposito;
    const central = deps.defaultCentral != null ? deps.defaultCentral : (deps.depositos.find(d => d.idDeposito !== ctl) || {}).idDeposito;
    $('mTitulo').textContent = devol ? 'Devolver mercadería' : 'Ingresar mercadería';
    opcionesDep('mOrigen'); opcionesDep('mDestino');
    $('mOrigen').value = String(devol ? ctl : central);
    $('mDestino').value = String(devol ? central : ctl);
    $('mDesc').value = ''; $('mDesc').removeAttribute('aria-invalid');
    $('mBuscar').value = '';
    aMover.clear();
    if (devol) for (const [id, c] of aDevolver) aMover.set(id, c);
    $('dlgMov').showModal();
    cargarCatalogo().then(() => $('mBuscar').focus());
  }

  // Valida cantidades (tope = stock en origen) y descripción; devuelve el body o null tras mostrar el error.
  function armarMovimiento() {
    const { origen, destino } = parMov();
    if (!origen || !destino || origen === destino) { mostrarError('Elegí un origen y un destino distintos.'); return null; }
    const lineas = [];
    for (const [id, cant] of aMover) {
      const cantidad = Number(cant);
      if (!(cantidad > 0)) continue;
      const p = catalogo.productos.find(x => x.idProducto === id);
      if (!p) continue;
      if (cantidad > Number(p.stockOrigen)) { mostrarError(`La cantidad del producto ${id} supera el stock en origen (${fmt(p.stockOrigen)}).`); return null; }
      lineas.push({ idProducto: id, cantidad });
    }
    if (!lineas.length) { mostrarError('Cargá una cantidad mayor a 0 en al menos un producto.'); return null; }
    const descripcion = $('mDesc').value.trim();
    if (!descripcion) { mostrarError('La descripción es obligatoria.'); $('mDesc').setAttribute('aria-invalid', 'true'); $('mDesc').focus(); return null; }
    $('mDesc').removeAttribute('aria-invalid');
    return { depOrigen: origen, depDestino: destino, descripcion, lineas };
  }

  async function confirmar(body) {
    if (enviando) return; // evita doble envío
    enviando = true;
    const btn = $('mOk');
    const textoBtn = btn.textContent;
    btn.disabled = true; btn.textContent = 'Enviando…';
    mostrarError('');
    try {
      const r = await api('/api/proarmet/movimiento', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      $('dlgMov').close();
      toast(`Movimiento ${r.numeroMovimiento} registrado (${body.lineas.length} producto${body.lineas.length === 1 ? '' : 's'}).`);
      aMover.clear(); aDevolver.clear();
      await cargarStock();
    } catch (e) {
      mostrarError(e.message);
      toast(e.message, true);
    } finally {
      enviando = false;
      btn.disabled = !catalogo; btn.textContent = textoBtn;
    }
  }

  // ── Eventos ───────────────────────────────────────────────────────────
  const idDeFila = e => { const tr = e.target.closest('tr[data-id]'); return tr ? Number(tr.dataset.id) : null; };

  $('flBuscar').addEventListener('input', renderTabla);
  $('btnRecargar').addEventListener('click', cargarDepositos);
  $('selControlado').addEventListener('change', () => { aDevolver.clear(); cargarStock(); });
  $('btnIda').addEventListener('click', () => abrirMov('ingreso'));
  $('btnVuelta').addEventListener('click', () => abrirMov('devolucion'));

  $('cuerpo').addEventListener('change', e => {
    const id = idDeFila(e);
    if (id != null && e.target.matches('[data-chk]')) { marcar(id, e.target.checked); renderTabla(); }
  });
  $('cuerpo').addEventListener('input', e => {
    const id = idDeFila(e);
    if (id != null && e.target.matches('[data-qty]')) aDevolver.set(id, e.target.value);
  });
  $('selTodos').addEventListener('change', e => {
    if (!stock) return;
    for (const p of filtrados()) marcar(p.idProducto, e.target.checked);
    renderTabla();
  });

  $('mOrigen').addEventListener('change', cargarCatalogo);
  $('mDestino').addEventListener('change', cargarCatalogo);
  $('mBuscar').addEventListener('input', renderCat);
  $('mCuerpo').addEventListener('input', e => {
    const id = idDeFila(e);
    if (id == null || !e.target.matches('[data-qty]')) return;
    aMover.set(id, e.target.value);
    contarCargados();
  });
  $('formMov').addEventListener('submit', e => {
    e.preventDefault();
    if (!catalogo) return;
    const body = armarMovimiento();
    if (body) confirmar(body);
  });

  const dlg = $('dlgMov');
  dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('[data-cerrar]')) { if (!enviando) dlg.close(); } });
  dlg.addEventListener('cancel', e => { if (enviando) e.preventDefault(); }); // Esc no cierra mientras se envía

  cargarDepositos();
})();
