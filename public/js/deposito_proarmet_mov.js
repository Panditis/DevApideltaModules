'use strict';
// Tabs "Ingresar mercadería" y "Devolver a central": un único componente parametrizado por preset.
// API: GET /api/proarmet/productos?origen=&destino=, POST /api/proarmet/movimiento ({ error } si falla).
(() => {
  const P = window.Proarmet;
  const { esc, fmt, norm, sk, api, toast } = P;
  const MAX_FILAS = 300;  // filas que pinta el modal: el catálogo de SIGA es largo, se afina con el filtro

  // def(ctl, central) -> [origen, destino] por defecto (ctl = depósito controlado).
  const PRESETS = [
    { key: 'ingreso', verbo: 'mover', ok: 'Confirmar ingreso', soloConStock: false, def: (ctl, central) => [central, ctl] },
    { key: 'devolver', verbo: 'devolver', ok: 'Confirmar devolución', soloConStock: true, def: (ctl, central) => [ctl, central] },
  ];

  // Usuarios responsables: se piden una sola vez y se comparten entre las dos tabs.
  const LS_USUARIO = 'proarmet_usuario';
  let usuariosP = null;
  const cargarUsuarios = () => usuariosP || (usuariosP = api('/api/proarmet/usuarios').then(r => r.usuarios || []));
  const leerUsuario = () => { try { return localStorage.getItem(LS_USUARIO) || ''; } catch (_) { return ''; } };
  const guardarUsuario = v => { try { localStorage.setItem(LS_USUARIO, v); } catch (_) { /* sin storage: sigue funcionando */ } };

  function crear(preset) {
    const k = preset.key;
    const root = P.$('panel-' + k);
    const q = id => root.querySelector('#' + k + '-' + id);
    const lista = new Map();    // idProducto -> cantidad (string); "Productos a mover", se conserva al cambiar origen/destino
    let ultimo = null;          // último producto agregado: a él vuelve el foco al cerrar el listado
    let catalogo = null, pedido = 0, enviando = false, iniciado = false, usuariosOk = false;

    root.innerHTML = `<form novalidate>
      <div class="flex flex-wrap items-end gap-3 mb-3">
        <div><label class="lbl" for="${k}-origen">Origen</label><select id="${k}-origen" class="ctl"></select></div>
        <div><label class="lbl" for="${k}-destino">Destino</label><select id="${k}-destino" class="ctl"></select></div>
      </div>
      <div class="mb-4">
        <button type="button" id="${k}-ver" class="btn" aria-haspopup="dialog" disabled>Ver lista de productos</button>
        <div id="${k}-estado" class="text-sm text-gris mt-1" aria-live="polite"></div>
      </div>
      <div class="flex items-center gap-3 mb-2">
        <h3 class="text-sm font-semibold">Productos a mover</h3>
        <span id="${k}-cargados" class="text-sm font-semibold text-verde tabular-nums ml-auto" aria-live="polite"></span>
      </div>
      <div class="scroll-tabla"><table class="tabla"><thead><tr>
        <th scope="col" class="num" style="width:90px">Código</th><th scope="col">Descripción</th>
        <th scope="col" class="num" style="width:120px">Stock origen</th><th scope="col" class="num" style="width:120px">Stock destino</th>
        <th scope="col" style="width:200px">Ubicación</th><th scope="col" class="num" style="width:130px">Cantidad</th><th scope="col" style="width:90px"><span class="sr-only">Quitar</span></th></tr></thead>
        <tbody id="${k}-cuerpo"></tbody></table></div>
      <div class="mt-3"><label class="lbl" for="${k}-usuario">Usuario responsable</label>
        <select id="${k}-usuario" class="ctl" required><option value="">Cargando usuarios…</option></select></div>
      <div class="mt-3"><label class="lbl" for="${k}-desc">Descripción del movimiento (obligatoria)</label>
        <input id="${k}-desc" type="text" class="ctl w-full" maxlength="120" autocomplete="off" required></div>
      <div id="${k}-error" class="error hidden mt-3" role="alert"></div>
      <div class="mt-3 flex items-center gap-3"><span id="${k}-faltan" class="text-sm text-gris" aria-live="polite"></span>
        <button type="submit" id="${k}-ok" class="btn btn-primario ml-auto" aria-describedby="${k}-faltan" disabled>${preset.ok}</button></div>
    </form>
    <dialog id="${k}-modal" class="modal-prod" aria-labelledby="${k}-mtit">
      <div class="mp-cab"><h3 id="${k}-mtit">Lista de productos</h3>
        <button type="button" class="btn-ico" data-cerrar aria-label="Cerrar lista de productos"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>
      <div class="mp-fil"><label class="lbl" for="${k}-filtro">Filtrar por código o descripción</label>
        <input id="${k}-filtro" type="text" class="ctl w-full" autocomplete="off">
        <div id="${k}-mtotal" class="text-sm text-gris mt-1" aria-live="polite"></div></div>
      <div class="mp-cuerpo"><table class="tabla"><thead><tr>
        <th scope="col" class="num" style="width:90px">Código</th><th scope="col">Producto</th>
        <th scope="col" class="num" style="width:110px">Stock origen</th><th scope="col" class="num" style="width:110px">Stock destino</th>
        <th scope="col" style="width:160px">Ubicación</th><th scope="col" style="width:180px"><span class="sr-only">Agregar</span></th></tr></thead>
        <tbody id="${k}-mcuerpo"></tbody></table></div>
    </dialog>`;

    let avisoUsuarios = ''; // aviso persistente si no hay usuarios: error('') no lo borra
    const error = t => { const m = t || avisoUsuarios; q('error').textContent = m; q('error').classList.toggle('hidden', !m); };
    const par = () => ({ origen: Number(q('origen').value) || null, destino: Number(q('destino').value) || null });
    const hallar = id => catalogo && catalogo.find(p => p.idProducto === id);
    const contar = () => {
      const n = lista.size;
      q('cargados').textContent = n ? `${n} producto${n === 1 ? '' : 's'} en el listado` : '';
    };

    // Listado "Productos a mover": stock siempre desde el catálogo vigente.
    function renderLista(foco) {
      q('cuerpo').innerHTML = lista.size ? [...lista].map(([id, c]) => {
        const p = hallar(id) || {};
        const tope = Math.max(0, Number(p.stockOrigen) || 0);
        return `<tr data-id="${esc(id)}"><td class="num">${esc(id)}</td><td>${esc(p.descripcion || '')}</td>
          <td class="num">${p.stockOrigen == null ? '—' : fmt(p.stockOrigen)}</td><td class="num">${p.stockDestino == null ? '—' : fmt(p.stockDestino)}</td>
          <td>${P.ubicaciones.html(id)}</td>
          <td class="num"><input type="number" class="ctl qty" data-qty min="0" max="${esc(tope)}" step="any" inputmode="decimal"
            aria-label="Cantidad a ${preset.verbo} de ${esc(p.descripcion || id)}" value="${esc(c)}"${Number(c) > tope ? ' aria-invalid="true"' : ''}></td>
          <td class="num"><button type="button" class="btn btn-rem" data-quitar aria-label="Quitar ${esc(p.descripcion || id)} del listado">Quitar</button></td></tr>`;
      }).join('')
        : '<tr><td colspan="7"><div class="vacio">Todavía no agregaste productos. Abrí la lista de productos y agregalos.</div></td></tr>';
      contar(); habilitar();
      if (foco != null) { const i = q('cuerpo').querySelector(`tr[data-id="${foco}"] [data-qty]`); if (i) i.focus(); }
    }

    // Listado completo del catálogo en un modal (<dialog>: foco atrapado, Esc y aria nativos).
    function pintarModal() {
      if (!catalogo) return;
      const t = norm(q('filtro').value.trim());
      const todos = t ? catalogo.filter(p => String(p.idProducto).includes(t) || norm(p.descripcion).includes(t)) : catalogo;
      const vis = todos.slice(0, MAX_FILAS);
      q('mtotal').textContent = !todos.length ? 'Sin coincidencias. Probá con otro filtro.'
        : `${todos.length} producto${todos.length === 1 ? '' : 's'}${todos.length > vis.length ? `, mostrando ${vis.length}: afiná el filtro` : ''}.`;
      q('mcuerpo').innerHTML = vis.map(p => {
        const ya = lista.has(p.idProducto), sin = !(Number(p.stockOrigen) > 0);
        const razon = ya ? 'Agregado' : sin ? 'Sin stock en origen' : '';
        return `<tr><td class="num">${esc(p.idProducto)}</td><td>${esc(p.descripcion)}</td>
          <td class="num">${fmt(p.stockOrigen)}</td><td class="num">${fmt(p.stockDestino)}</td><td>${P.ubicaciones.html(p.idProducto)}</td>
          <td class="num"><button type="button" class="btn btn-rem" data-id="${esc(p.idProducto)}"${razon ? ' disabled' : ''}
            aria-label="${razon ? razon + ': ' : 'Agregar '}${esc(p.descripcion)}">${razon || 'Agregar'}</button></td></tr>`;
      }).join('');
    }
    function abrirModal() {
      if (!catalogo) return;
      q('filtro').value = ''; pintarModal();
      q('modal').showModal();
    }
    function cerrarModal() {
      if (q('modal').open) q('modal').close();
    }
    function agregar(p) {
      if (!p || lista.has(p.idProducto) || !(Number(p.stockOrigen) > 0)) return;
      lista.set(p.idProducto, ''); ultimo = p.idProducto;
      q('estado').textContent = `Agregado: ${p.descripcion}. ${lista.size} en el listado.`;
      error('');
      renderLista();
      pintarModal();
      q('filtro').focus(); // el modal sigue abierto para agregar más; el foco a la cantidad se da al cerrar
    }

    // Qué falta para poder confirmar (misma regla que armar(), sin mostrar errores): [] = completo.
    function faltantes() {
      const { origen, destino } = par(), f = [];
      if (!origen || !destino) f.push('origen y destino');
      else if (origen === destino) f.push('origen y destino distintos');
      else if (!catalogo) f.push('stock del origen');
      if (!usuariosOk || !q('usuario').value) f.push('usuario');
      if (!q('desc').value.trim()) f.push('descripción');
      if (!lista.size) f.push('al menos un producto');
      else if (catalogo) {
        const malas = [...lista].filter(([id, c]) => { const p = hallar(id); return !p || !(Number(c) > 0) || Number(c) > Number(p.stockOrigen); }).length;
        if (malas) f.push(`cantidad válida en ${malas} producto${malas === 1 ? '' : 's'}`);
      }
      return f;
    }
    function habilitar() {
      const f = faltantes();
      q('ver').disabled = !catalogo;
      q('ok').disabled = enviando || f.length > 0;
      q('faltan').textContent = f.length ? 'Falta: ' + f.join(', ') : '';
    }

    cargarUsuarios().then(us => {
      q('usuario').innerHTML = '<option value="">Elegí un usuario…</option>'
        + us.map(u => `<option value="${esc(u.id)}">${esc(u.nombre)}</option>`).join('');
      const g = leerUsuario();
      if (g && us.some(u => String(u.id) === g)) q('usuario').value = g;
      usuariosOk = us.length > 0;
      if (!usuariosOk) { avisoUsuarios = 'No hay usuarios disponibles para asignar el movimiento.'; error(''); }
      habilitar();
    }).catch(e => {
      q('usuario').innerHTML = '<option value="">No se pudieron cargar</option>';
      avisoUsuarios = 'No se pudo cargar la lista de usuarios: ' + e.message + ' No se puede confirmar sin usuario responsable.'; error('');
      habilitar();
    });

    async function cargarCatalogo() {
      const { origen, destino } = par();
      error('');
      catalogo = null; cerrarModal(); habilitar(); q('estado').textContent = '';
      const mio = ++pedido;
      if (!origen || !destino) { renderLista(); return; }
      if (origen === destino) { renderLista(); error('El origen y el destino no pueden ser el mismo depósito.'); return; }
      q('cuerpo').innerHTML = `<tr><td colspan="7">${sk(2)}</td></tr>`;
      try {
        const r = await api(`/api/proarmet/productos?origen=${origen}&destino=${destino}`);
        if (mio !== pedido) return;
        catalogo = preset.soloConStock ? r.productos.filter(p => Number(p.stockOrigen) > 0) : r.productos;
        habilitar();
        renderLista();
        reevaluar();
      } catch (e) {
        if (mio !== pedido) return;
        renderLista(); error(e.message);
      }
    }

    // Con el stock nuevo: quita lo que ya no se puede mover y avisa de cantidades que superan el tope.
    function reevaluar() {
      const quitados = [], excede = [];
      for (const [id, c] of [...lista]) {
        const p = hallar(id);
        if (!p || (preset.soloConStock && !(Number(p.stockOrigen) > 0))) { lista.delete(id); quitados.push(id); renderLista(); continue; }
        if (Number(c) > Number(p.stockOrigen)) excede.push(id);
      }
      const m = [];
      if (quitados.length) m.push(`Se quitaron del listado productos que no están en el nuevo origen (${quitados.join(', ')}).`);
      if (excede.length) m.push(`Revisá la cantidad: supera el stock en origen en ${excede.join(', ')}.`);
      if (m.length) error(m.join(' '));
    }

    // Valida cantidades (tope = stock en origen) y descripción; devuelve el body o null tras mostrar el error.
    function armar() {
      const { origen, destino } = par();
      if (!origen || !destino || origen === destino) { error('Elegí un origen y un destino distintos.'); return null; }
      const lineas = [];
      for (const [id, c] of lista) {
        const cantidad = Number(c);
        const p = hallar(id);
        if (!p) continue;
        if (!(cantidad > 0)) { error(`Indicá una cantidad mayor a 0 para el producto ${id} o quitalo del listado.`); return null; }
        if (cantidad > Number(p.stockOrigen)) { error(`La cantidad del producto ${id} supera el stock en origen (${fmt(p.stockOrigen)}).`); return null; }
        lineas.push({ idProducto: id, cantidad });
      }
      if (!lineas.length) { error('Agregá al menos un producto al listado con cantidad mayor a 0.'); return null; }
      const descripcion = q('desc').value.trim();
      if (!descripcion) { error('La descripción es obligatoria.'); q('desc').setAttribute('aria-invalid', 'true'); q('desc').focus(); return null; }
      q('desc').removeAttribute('aria-invalid');
      const idUsuario = String(q('usuario').value || '').trim(); // Usuarios.Id puede no ser numérico
      if (!idUsuario) { error('Elegí el usuario responsable del movimiento.'); q('usuario').setAttribute('aria-invalid', 'true'); q('usuario').focus(); return null; }
      q('usuario').removeAttribute('aria-invalid');
      return { depOrigen: origen, depDestino: destino, descripcion, lineas, idUsuario };
    }

    async function confirmar(body) {
      if (enviando) return; // evita doble envío
      enviando = true;
      q('ok').disabled = true; q('ok').textContent = 'Enviando…';
      error('');
      try {
        guardarUsuario(String(body.idUsuario));
        const r = await api('/api/proarmet/movimiento', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        toast(`Movimiento ${r.numeroMovimiento} registrado (${body.lineas.length} producto${body.lineas.length === 1 ? '' : 's'}).`);
        const nomDep = id => P.nombreDep(id) || `Depósito ${id}`;
        const selU = q('usuario').selectedOptions[0];
        const remito = {
          numeroMovimiento: r.numeroMovimiento, fecha: new Date().toISOString(), sentido: preset.key === 'ingreso' ? 'ingreso' : 'salida', tipo: (P.getDeps() || {}).tipoMovimiento || '',
          depOrigenNombre: nomDep(body.depOrigen), depDestinoNombre: nomDep(body.depDestino),
          usuario: selU ? selU.textContent : '', descripcion: body.descripcion,
          lineas: body.lineas.map(l => ({ ...l, descripcion: (catalogo.find(p => p.idProducto === l.idProducto) || {}).descripcion || null })),
        };
        lista.clear(); renderLista(); q('desc').value = '';
        P.ubicaciones.cargar(true); // refresca el mapa vigente
        P.movimientoHecho();
        P.imprimirRemito(remito);
        cargarCatalogo(); // cambiaron los stocks de origen y destino
      } catch (e) {
        error(e.message); toast(e.message, true);
      } finally {
        enviando = false; q('ok').textContent = preset.ok; habilitar();
      }
    }

    // Se llama al abrir la tab: la primera vez (o tras cambiar el depósito controlado) arma los selects con los defaults.
    function mostrar() {
      const deps = P.getDeps();
      if (!deps) return;
      if (!iniciado) {
        iniciado = true;
        const ctl = P.idControlado() || (deps.depositos[0] || {}).idDeposito;
        const central = deps.defaultCentral != null ? deps.defaultCentral : (deps.depositos.find(d => d.idDeposito !== ctl) || {}).idDeposito;
        const opts = deps.depositos.map(d => `<option value="${esc(d.idDeposito)}">${esc(d.nombre)}</option>`).join('');
        q('origen').innerHTML = opts; q('destino').innerHTML = opts;
        const [o, d] = preset.def(ctl, central);
        q('origen').value = String(o); q('destino').value = String(d);
        q('desc').value = ''; lista.clear(); renderLista();
      }
      cargarCatalogo();
      P.ubicaciones.cargar().then(() => { renderLista(); if (q('modal').open) pintarModal(); });
    }
    const invalidar = () => { iniciado = false; catalogo = null; };

    q('origen').addEventListener('change', cargarCatalogo);
    q('destino').addEventListener('change', cargarCatalogo);
    q('ver').addEventListener('click', abrirModal);
    q('filtro').addEventListener('input', pintarModal);
    q('mcuerpo').addEventListener('click', e => {
      const b = e.target.closest('button[data-id]');
      if (b) agregar(hallar(b.dataset.id));
    });
    q('modal').addEventListener('click', e => { if (e.target === q('modal') || e.target.closest('[data-cerrar]')) cerrarModal(); });
    q('modal').addEventListener('close', () => {
      const i = ultimo != null && q('cuerpo').querySelector(`tr[data-id="${ultimo}"] [data-qty]`);
      (i || q('ver')).focus(); ultimo = null;
    });
    q('cuerpo').addEventListener('input', e => {
      const tr = e.target.closest('tr[data-id]');
      if (!tr || !e.target.matches('[data-qty]')) return;
      const id = tr.dataset.id, p = hallar(id); // idProducto es texto (PLU de SIGA): no convertir a número
      lista.set(id, e.target.value);
      if (p && Number(e.target.value) > Number(p.stockOrigen)) e.target.setAttribute('aria-invalid', 'true'); else e.target.removeAttribute('aria-invalid');
      habilitar();
    });
    q('desc').addEventListener('input', habilitar);
    q('usuario').addEventListener('change', habilitar);
    q('cuerpo').addEventListener('click', e => {
      const tr = e.target.closest('tr[data-id]');
      if (!tr || !e.target.closest('[data-quitar]')) return;
      lista.delete(tr.dataset.id); renderLista();
      q('estado').textContent = `Producto quitado. ${lista.size} en el listado.`;
      q('ver').focus();
    });
    root.querySelector('form').addEventListener('submit', e => {
      e.preventDefault();
      if (!catalogo || !usuariosOk) return;
      const body = armar();
      if (body) confirmar(body);
    });
    return { mostrar, invalidar };
  }

  for (const p of PRESETS) P.movs[p.key] = crear(p);
})();
