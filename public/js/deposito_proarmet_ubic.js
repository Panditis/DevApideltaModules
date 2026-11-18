'use strict';
// Tab "Ubicaciones": listado de PLUs (sin cantidades) de cada lugar del depósito. No depende del stock: se puede agregar cualquier producto activo.
// API: GET /api/proarmet/ubicaciones?idDeposito=, POST /ubicacion, PUT|DELETE /ubicacion/:id[?forzar=1], PUT /ubicacion/:id/producto {idProducto}, DELETE /ubicacion/:id/producto/:idProducto; catálogo: GET /productos?origen=N&destino=N (se ignora el stock).
(() => {
  const P = window.Proarmet;
  const { esc, fmt, norm, api, toast } = P;
  const root = P.$('panel-ubicaciones');
  const MAX_RES = 15, MIN_CHARS = 2, NOMBRE_MAX = 40;

  let datos = null, pedido = 0, editando = null, catalogo = null, catId = null; // catalogo: productos activos del depósito (cache por tab) // editando: null | 'nueva' | id
  const abiertas = new Set();                    // ids de ubicaciones expandidas (sobreviven a las recargas)

  root.innerHTML = `
    <div class="flex flex-wrap items-center gap-3 mb-3">
      <button type="button" id="ub-nueva" class="btn btn-primario">Nueva ubicación</button>
      <span id="ub-conteo" class="text-sm text-gris tabular-nums" aria-live="polite"></span>
    </div>
    <form id="ub-form" class="hidden rounded-xl border border-borde bg-card p-4 mb-4" novalidate>
      <h3 id="ub-form-tit" class="text-sm font-semibold mb-3"></h3>
      <div class="flex flex-wrap items-end gap-3">
        <div><label class="lbl" for="ub-nombre">Nombre (máx. ${NOMBRE_MAX})</label><input id="ub-nombre" class="ctl" maxlength="${NOMBRE_MAX}" autocomplete="off" required></div>
        <div class="grow"><label class="lbl" for="ub-desc">Descripción</label><input id="ub-desc" class="ctl w-full" maxlength="200" autocomplete="off"></div>
        <button type="submit" class="btn btn-primario">Guardar</button>
        <button type="button" id="ub-cancelar" class="btn">Cancelar</button>
      </div>
      <div id="ub-form-err" class="error hidden mt-3" role="alert"></div>
    </form>
    <div id="ub-error" class="error hidden mb-3" role="alert"></div>
    <div id="ub-lista" aria-live="polite"></div>`;
  const $ = id => root.querySelector('#' + id);

  const ubicaciones = () => (datos && datos.ubicaciones) || [];
  const mensaje = (el, t) => { el.textContent = t || ''; el.classList.toggle('hidden', !t); };
  const aviso = t => mensaje($('ub-error'), t);

  // ── Render ────────────────────────────────────────────────────────────
  function cabeceraProductos(extra) {
    return `<thead><tr><th scope="col" class="num" style="width:90px">PLU</th><th scope="col">Descripción</th>${extra}</tr></thead>`;
  }

  function filaAsignado(p) {
    return `<tr data-prod="${esc(p.idProducto)}"><td class="num">${esc(p.idProducto)}</td><td>${esc(p.descripcion)}</td>
      <td class="num"><button type="button" class="btn btn-rem" data-quitar aria-label="Quitar ${esc(p.descripcion)} de la ubicación">Quitar</button></td></tr>`;
  }

  function renderUbicacion(u) {
    const abierta = abiertas.has(u.id);
    const prods = u.productos || [];
    return `<div class="rounded-xl border border-borde shadow-fluent bg-card mb-3" data-ub="${esc(u.id)}">
      <div class="flex items-center gap-3 p-3">
        <button type="button" class="btn-ico" data-alternar aria-expanded="${abierta}" aria-controls="ub-det-${esc(u.id)}" aria-label="${abierta ? 'Contraer' : 'Expandir'} ${esc(u.nombre)}">${abierta ? '▾' : '▸'}</button>
        <div class="grow min-w-0"><div class="font-semibold">${esc(u.nombre)}</div>
          <div class="text-sm text-gris">${esc(u.descripcion) || 'Sin descripción'}</div></div>
        <span class="text-sm text-gris tabular-nums">${fmt(u.totalProductos)} producto${u.totalProductos === 1 ? '' : 's'}</span>
        <button type="button" class="btn btn-rem" data-editar>Editar</button>
        <button type="button" class="btn btn-rem" data-eliminar aria-label="Eliminar ${esc(u.nombre)}">Eliminar</button>
      </div>
      <div id="ub-det-${esc(u.id)}" class="${abierta ? '' : 'hidden'} p-3 border-t border-borde">
        ${prods.length ? `<table class="tabla mb-3">${cabeceraProductos('<th scope="col" style="width:100px"><span class="sr-only">Acciones</span></th>')}<tbody>${prods.map(filaAsignado).join('')}</tbody></table>`
          : '<div class="vacio" style="padding:16px"><b>Sin productos asignados</b>Buscá abajo un producto para agregarlo.</div>'}
        <label class="lbl" for="ub-b-${esc(u.id)}">Agregar producto (PLU o descripción, mínimo ${MIN_CHARS} caracteres)</label>
        <input id="ub-b-${esc(u.id)}" type="search" class="ctl" style="width:320px" data-buscar autocomplete="off" placeholder="Buscar en el catálogo">
        <ul class="res hidden" data-res aria-label="Productos disponibles"></ul>
      </div></div>`;
  }

  function render() {
    if (!datos) return;
    const us = ubicaciones();
    $('ub-conteo').textContent = `${us.length} ${us.length === 1 ? "ubicación" : "ubicaciones"}`;
    $('ub-lista').innerHTML = us.length ? us.map(renderUbicacion).join('')
      : '<div class="vacio"><b>Todavía no hay ubicaciones</b>Creá una con "Nueva ubicación" para ordenar el depósito.</div>';
  }

  // ── Carga ─────────────────────────────────────────────────────────────
  async function mostrar() {
    const id = P.idControlado();
    aviso('');
    if (!id) { datos = null; $('ub-lista').innerHTML = '<div class="vacio"><b>Elegí un depósito</b></div>'; return; }
    const mio = ++pedido;
    if (!datos) $('ub-lista').innerHTML = '<div class="sk"></div><div class="sk"></div><div class="sk"></div>';
    try {
      const r = await api(`/api/proarmet/ubicaciones?idDeposito=${id}`);
      if (mio !== pedido) return;
      datos = r; P.ubicaciones.invalidar(); render(); cargarCatalogo();
    } catch (e) {
      if (mio !== pedido) return;
      datos = null; $('ub-lista').innerHTML = ''; aviso(e.message);
    }
  }
  const invalidar = () => { datos = null; catalogo = null; pedido++; cerrarForm(); };
  // Catálogo completo de productos activos, una vez por tab y depósito; si falla, el buscador avisa al usarlo.
  async function cargarCatalogo() {
    const id = P.idControlado();
    if (catalogo && catId === id) return;
    catId = id;
    try { catalogo = (await api(`/api/proarmet/productos?origen=${id}&destino=${id}`)).productos || []; }
    catch (e) { catalogo = null; aviso('No se pudo cargar el catálogo de productos: ' + e.message); }
  }
  P.movs.ubicaciones = { mostrar, invalidar };

  // Ejecuta una escritura, avisa el error del backend y recarga la tab.
  async function escribir(url, metodo, body, okMsg) {
    try {
      const r = await api(url, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      if (okMsg) toast(okMsg);
      await mostrar();
      return r;
    } catch (e) { toast(e.message, true); aviso(e.message); return null; }
  }
  const agregar = (idUb, idProducto, msg) => escribir(`/api/proarmet/ubicacion/${idUb}/producto`, 'PUT', { idProducto }, msg);
  const quitar = (idUb, idProducto, msg) => escribir(`/api/proarmet/ubicacion/${idUb}/producto/${encodeURIComponent(idProducto)}`, 'DELETE', null, msg);

  // ── Alta / edición ────────────────────────────────────────────────────
  function abrirForm(u) {
    editando = u ? u.id : 'nueva';
    $('ub-form-tit').textContent = u ? `Editar ubicación "${u.nombre}"` : 'Nueva ubicación';
    $('ub-nombre').value = u ? u.nombre : ''; $('ub-desc').value = u ? (u.descripcion || '') : '';
    mensaje($('ub-form-err'), ''); $('ub-form').classList.remove('hidden'); $('ub-nombre').focus();
  }
  function cerrarForm() { editando = null; $('ub-form').classList.add('hidden'); }
  $('ub-nueva').addEventListener('click', () => abrirForm(null));
  $('ub-cancelar').addEventListener('click', () => { cerrarForm(); $('ub-nueva').focus(); });
  $('ub-form').addEventListener('submit', async e => {
    e.preventDefault();
    const nombre = $('ub-nombre').value.trim(), descripcion = $('ub-desc').value.trim();
    if (!nombre) { mensaje($('ub-form-err'), 'El nombre es obligatorio.'); $('ub-nombre').setAttribute('aria-invalid', 'true'); return; }
    $('ub-nombre').removeAttribute('aria-invalid');
    try {
      if (editando === 'nueva') await api('/api/proarmet/ubicacion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idDeposito: P.idControlado(), nombre, descripcion }) });
      else await api(`/api/proarmet/ubicacion/${editando}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre, descripcion }) });
    } catch (err) { mensaje($('ub-form-err'), err.message); return; }
    toast(editando === 'nueva' ? 'Ubicación creada' : 'Ubicación actualizada');
    cerrarForm(); $('ub-nueva').focus(); mostrar();
  });

  // ── Eliminar ──────────────────────────────────────────────────────────
  async function eliminar(u) {
    const n = (u.productos || []).length;
    if (!confirm(`¿Eliminar la ubicación "${u.nombre}"?`)) return;
    if (n && !confirm(`"${u.nombre}" tiene ${n} producto${n === 1 ? '' : 's'} asignado${n === 1 ? '' : 's'}. Se van a quitar de la ubicación (el stock no cambia). ¿Eliminar igual?`)) return;
    abiertas.delete(u.id);
    escribir(`/api/proarmet/ubicacion/${u.id}${n ? '?forzar=1' : ''}`, 'DELETE', null, 'Ubicación eliminada');
  }

  // ── Buscador dentro de cada ubicación ─────────────────────────────────
  function resultados(card, q) {
    const ul = card.querySelector('[data-res]');
    const t = norm(q.trim());
    if (t.length < MIN_CHARS) { ul.classList.add('hidden'); ul.innerHTML = ''; return; }
    ul.classList.remove('hidden');
    if (!catalogo) { ul.innerHTML = '<li class="res-it" aria-disabled="true">Catálogo no disponible. Recargá la pestaña.</li>'; return; }
    const ub = ubicaciones().find(x => String(x.id) === card.dataset.ub);
    const ya = new Set(((ub && ub.productos) || []).map(p => String(p.idProducto)));
    const todos = catalogo.filter(p => String(p.idProducto).includes(t) || norm(p.descripcion).includes(t));
    ul.innerHTML = todos.length ? todos.slice(0, MAX_RES).map(p => `<li class="res-it" data-prod="${esc(p.idProducto)}"><span class="num">${esc(p.idProducto)}</span><span class="grow">${esc(p.descripcion)}</span>
      ${ya.has(String(p.idProducto)) ? '<span class="text-sm text-gris">Agregado</span>' : '<button type="button" class="btn btn-rem" data-agregar>Agregar</button>'}</li>`).join('') + (todos.length > MAX_RES ? `<li class="res-it" aria-disabled="true">Mostrando ${MAX_RES} de ${todos.length}: afiná la búsqueda</li>` : '')
      : '<li class="res-it" aria-disabled="true">Sin coincidencias</li>';
  }

  const enCatalogo = id => (catalogo || []).find(p => String(p.idProducto) === String(id));

  // ── Eventos ───────────────────────────────────────────────────────────
  root.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b || !datos) return;
    const card = b.closest('[data-ub]'), fila = b.closest('[data-prod]');
    const u = card && ubicaciones().find(x => String(x.id) === card.dataset.ub);
    if (b.hasAttribute('data-alternar')) { abiertas.has(u.id) ? abiertas.delete(u.id) : abiertas.add(u.id); render(); const nb = root.querySelector(`[data-ub="${u.id}"] [data-alternar]`); if (nb) nb.focus(); }
    else if (b.hasAttribute('data-editar')) abrirForm(u);
    else if (b.hasAttribute('data-eliminar')) eliminar(u);
    else if (b.hasAttribute('data-quitar')) quitar(u.id, fila.dataset.prod, 'Producto quitado de la ubicación');
    else if (b.hasAttribute('data-agregar')) {
      const p = enCatalogo(fila.dataset.prod); if (!p) return;
      abiertas.add(u.id);
      agregar(u.id, p.idProducto, 'Producto agregado a la ubicación');
    }
  });
  root.addEventListener('input', e => {
    if (e.target.matches('[data-buscar]') && datos) resultados(e.target.closest('[data-ub]'), e.target.value);
  });
  root.addEventListener('keydown', e => {
    if (e.key === 'Escape' && e.target.matches('[data-buscar]')) { e.target.value = ''; resultados(e.target.closest('[data-ub]'), ''); }
  });
})();
