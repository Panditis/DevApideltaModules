'use strict';
// Tabs "Ingresar mercadería" y "Devolver a central": un único componente parametrizado por preset.
// API: GET /api/proarmet/productos?origen=&destino=, POST /api/proarmet/movimiento ({ error } si falla).
(() => {
  const P = window.Proarmet;
  const { esc, fmt, norm, sk, api, toast } = P;
  const MAX_RES = 15;     // resultados del buscador: el catálogo de SIGA es largo, se afina escribiendo
  const MIN_CHARS = 2, DEBOUNCE_MS = 150;

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
    let resultados = [], activo = 0, timer = null;
    let catalogo = null, pedido = 0, enviando = false, iniciado = false, usuariosOk = false;

    root.innerHTML = `<form novalidate>
      <div class="flex flex-wrap items-end gap-3 mb-3">
        <div><label class="lbl" for="${k}-origen">Origen</label><select id="${k}-origen" class="ctl"></select></div>
        <div><label class="lbl" for="${k}-destino">Destino</label><select id="${k}-destino" class="ctl"></select></div>
      </div>
      <div class="mb-4">
        <label class="lbl" for="${k}-buscar">Buscar producto (código o descripción)</label>
        <div class="buscar"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input id="${k}-buscar" type="text" class="ctl" role="combobox" aria-expanded="false" aria-controls="${k}-res" aria-autocomplete="list" autocomplete="off"
            placeholder="Escribí al menos ${MIN_CHARS} caracteres"></div>
        <div id="${k}-estado" class="text-sm text-gris mt-1" aria-live="polite"></div>
        <ul id="${k}-res" class="res hidden" role="listbox" aria-label="Resultados de la búsqueda"></ul>
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
      <div class="mt-3 flex"><button type="submit" id="${k}-ok" class="btn btn-primario ml-auto" disabled>${preset.ok}</button></div>
    </form>`;

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
        : '<tr><td colspan="7"><div class="vacio">Todavía no agregaste productos. Buscá arriba y agregalos.</div></td></tr>';
      contar();
      if (foco != null) { const i = q('cuerpo').querySelector(`tr[data-id="${foco}"] [data-qty]`); if (i) i.focus(); }
    }

    function cerrarRes() { resultados = []; q('res').classList.add('hidden'); q('res').innerHTML = ''; q('buscar').setAttribute('aria-expanded', 'false'); q('buscar').removeAttribute('aria-activedescendant'); }

    // Buscador: sin texto (o < MIN_CHARS) no se muestra nada; filtra en cliente sobre el catálogo cargado.
    function buscar() {
      const t = norm(q('buscar').value.trim());
      if (!catalogo || t.length < MIN_CHARS) { cerrarRes(); q('estado').textContent = ''; return; }
      const todos = catalogo.filter(p => String(p.idProducto).includes(t) || norm(p.descripcion).includes(t));
      resultados = todos.slice(0, MAX_RES); activo = 0;
      q('estado').textContent = !todos.length ? 'Sin coincidencias. Probá con otra búsqueda.'
        : `${todos.length} coincidencia${todos.length === 1 ? '' : 's'}${todos.length > resultados.length ? `, mostrando ${resultados.length}: afiná la búsqueda` : ''}.`;
      pintarRes();
    }
    function pintarRes() {
      const ul = q('res');
      ul.classList.toggle('hidden', !resultados.length);
      q('buscar').setAttribute('aria-expanded', String(resultados.length > 0));
      ul.innerHTML = resultados.map((p, i) => {
        const ya = lista.has(p.idProducto), sin = !(Number(p.stockOrigen) > 0);
        const razon = ya ? 'Agregado' : sin ? 'Sin stock en origen' : '';
        return `<li id="${k}-r${i}" role="option" class="res-it${i === activo ? ' act' : ''}" data-i="${i}" aria-selected="${i === activo}" aria-disabled="${!!razon}">
          <span class="num">${esc(p.idProducto)}</span><span class="grow">${esc(p.descripcion)}</span>
          <span class="st">Origen <b>${fmt(p.stockOrigen)}</b></span><span class="st">Destino <b>${fmt(p.stockDestino)}</b></span>
          <span class="st">Ubicación <b>${P.ubicaciones.html(p.idProducto)}</b></span>
          ${razon ? `<span class="btn btn-rem" aria-disabled="true" style="opacity:.55">${razon}</span>`
            : '<button type="button" class="btn btn-rem" data-agregar tabindex="-1">Agregar</button>'}</li>`;
      }).join('');
      if (resultados.length) q('buscar').setAttribute('aria-activedescendant', `${k}-r${activo}`);
    }
    function agregar(i) {
      const p = resultados[i];
      if (!p || lista.has(p.idProducto) || !(Number(p.stockOrigen) > 0)) return;
      lista.set(p.idProducto, '');
      q('buscar').value = ''; cerrarRes();
      q('estado').textContent = `Agregado: ${p.descripcion}. ${lista.size} en el listado.`;
      error('');
      renderLista(p.idProducto);
    }

    const habilitar = () => { q('ok').disabled = enviando || !catalogo || !usuariosOk; };

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
      catalogo = null; q('ok').disabled = true; cerrarRes(); q('estado').textContent = '';
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
        buscar();
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
        q('desc').value = ''; q('buscar').value = ''; lista.clear(); renderLista();
      }
      cargarCatalogo();
      P.ubicaciones.cargar().then(() => { renderLista(); if (resultados.length) pintarRes(); });
    }
    const invalidar = () => { iniciado = false; catalogo = null; };

    q('origen').addEventListener('change', cargarCatalogo);
    q('destino').addEventListener('change', cargarCatalogo);
    q('buscar').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(buscar, DEBOUNCE_MS); });
    q('buscar').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); buscar(); agregar(activo); return; }
      if (e.key === 'Escape') { cerrarRes(); return; }
      if (!resultados.length || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
      e.preventDefault();
      activo = (activo + (e.key === 'ArrowDown' ? 1 : resultados.length - 1)) % resultados.length;
      pintarRes();
      q('res').children[activo].scrollIntoView({ block: 'nearest' });
    });
    q('res').addEventListener('mousedown', e => e.preventDefault()); // no pierde foco el input
    q('res').addEventListener('click', e => {
      const li = e.target.closest('li[data-i]');
      if (li) agregar(Number(li.dataset.i));
    });
    q('cuerpo').addEventListener('input', e => {
      const tr = e.target.closest('tr[data-id]');
      if (!tr || !e.target.matches('[data-qty]')) return;
      const id = Number(tr.dataset.id), p = hallar(id);
      lista.set(id, e.target.value);
      if (p && Number(e.target.value) > Number(p.stockOrigen)) e.target.setAttribute('aria-invalid', 'true'); else e.target.removeAttribute('aria-invalid');
    });
    q('cuerpo').addEventListener('click', e => {
      const tr = e.target.closest('tr[data-id]');
      if (!tr || !e.target.closest('[data-quitar]')) return;
      lista.delete(Number(tr.dataset.id)); renderLista(); buscar();
      q('estado').textContent = `Producto quitado. ${lista.size} en el listado.`;
      q('buscar').focus();
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
