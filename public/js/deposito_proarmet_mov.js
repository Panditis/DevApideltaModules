'use strict';
// Tabs "Ingresar mercadería" y "Devolver a central": un único componente parametrizado por preset.
// API: GET /api/proarmet/productos?origen=&destino=, POST /api/proarmet/movimiento ({ error } si falla).
(() => {
  const P = window.Proarmet;
  const { esc, fmt, norm, sk, api, toast } = P;
  const MAX_FILAS = 200; // el catálogo de SIGA es largo: se pintan las primeras coincidencias, el buscador afina

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
    const cant = new Map();     // idProducto -> cantidad (string); se conserva al cambiar origen/destino/filtro
    let catalogo = null, pedido = 0, enviando = false, iniciado = false, usuariosOk = false;

    root.innerHTML = `<form novalidate>
      <div class="flex flex-wrap items-end gap-3 mb-3">
        <div><label class="lbl" for="${k}-origen">Origen</label><select id="${k}-origen" class="ctl"></select></div>
        <div><label class="lbl" for="${k}-destino">Destino</label><select id="${k}-destino" class="ctl"></select></div>
        <div class="buscar"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input id="${k}-buscar" type="search" class="ctl" placeholder="Buscar producto" aria-label="Buscar producto"></div>
        <span id="${k}-conteo" class="text-sm text-gris tabular-nums"></span>
        <span id="${k}-cargados" class="text-sm font-semibold text-verde tabular-nums ml-auto"></span>
      </div>
      <div class="scroll-tabla"><table class="tabla"><thead><tr>
        <th scope="col" class="num" style="width:90px">Código</th><th scope="col">Descripción</th>
        <th scope="col" class="num" style="width:120px">Stock origen</th><th scope="col" class="num" style="width:120px">Stock destino</th>
        <th scope="col" class="num" style="width:130px">Cantidad</th></tr></thead><tbody id="${k}-cuerpo"></tbody></table></div>
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
    const contar = () => {
      const n = [...cant.values()].filter(v => Number(v) > 0).length;
      q('cargados').textContent = n ? `${n} producto${n === 1 ? '' : 's'} con cantidad` : '';
    };

    function render() {
      if (!catalogo) return;
      const t = norm(q('buscar').value.trim());
      const todos = catalogo.filter(p => !t || String(p.idProducto).includes(t) || norm(p.descripcion).includes(t));
      const lista = todos.slice(0, MAX_FILAS);
      q('conteo').textContent = todos.length > lista.length ? `Mostrando ${lista.length} de ${todos.length}: afiná la búsqueda` : `${todos.length} productos`;
      q('cuerpo').innerHTML = lista.length ? lista.map(p => `<tr data-id="${esc(p.idProducto)}">
          <td class="num">${esc(p.idProducto)}</td><td>${esc(p.descripcion)}</td>
          <td class="num">${fmt(p.stockOrigen)}</td><td class="num">${fmt(p.stockDestino)}</td>
          <td class="num"><input type="number" class="ctl qty" data-qty min="0" max="${esc(Math.max(0, Number(p.stockOrigen) || 0))}" step="any" inputmode="decimal"
            aria-label="Cantidad a ${preset.verbo} de ${esc(p.descripcion)}" value="${esc(cant.get(p.idProducto) || '')}"></td></tr>`).join('')
        : `<tr><td colspan="5"><div class="vacio"><b>${catalogo.length ? 'Sin coincidencias' : 'No hay productos para mostrar'}</b>${catalogo.length ? 'Probá con otra búsqueda.' : ''}</div></td></tr>`;
      contar();
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
      catalogo = null; q('ok').disabled = true;
      const mio = ++pedido;
      if (!origen || !destino) { q('cuerpo').innerHTML = ''; return; }
      if (origen === destino) { q('cuerpo').innerHTML = ''; error('El origen y el destino no pueden ser el mismo depósito.'); return; }
      q('cuerpo').innerHTML = sk(5);
      try {
        const r = await api(`/api/proarmet/productos?origen=${origen}&destino=${destino}`);
        if (mio !== pedido) return;
        catalogo = preset.soloConStock ? r.productos.filter(p => Number(p.stockOrigen) > 0) : r.productos;
        habilitar();
        render();
      } catch (e) {
        if (mio !== pedido) return;
        q('cuerpo').innerHTML = ''; error(e.message);
      }
    }

    // Valida cantidades (tope = stock en origen) y descripción; devuelve el body o null tras mostrar el error.
    function armar() {
      const { origen, destino } = par();
      if (!origen || !destino || origen === destino) { error('Elegí un origen y un destino distintos.'); return null; }
      const lineas = [];
      for (const [id, c] of cant) {
        const cantidad = Number(c);
        if (!(cantidad > 0)) continue;
        const p = catalogo.find(x => x.idProducto === id);
        if (!p) continue;
        if (cantidad > Number(p.stockOrigen)) { error(`La cantidad del producto ${id} supera el stock en origen (${fmt(p.stockOrigen)}).`); return null; }
        lineas.push({ idProducto: id, cantidad });
      }
      if (!lineas.length) { error('Cargá una cantidad mayor a 0 en al menos un producto.'); return null; }
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
          numeroMovimiento: r.numeroMovimiento, fecha: new Date().toISOString(), tipo: (P.getDeps() || {}).tipoMovimiento || '',
          depOrigenNombre: nomDep(body.depOrigen), depDestinoNombre: nomDep(body.depDestino),
          usuario: selU ? selU.textContent : '', descripcion: body.descripcion,
          lineas: body.lineas.map(l => ({ ...l, descripcion: (catalogo.find(p => p.idProducto === l.idProducto) || {}).descripcion || null })),
        };
        cant.clear(); q('desc').value = '';
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
        q('desc').value = ''; q('buscar').value = ''; cant.clear();
      }
      cargarCatalogo();
    }
    const invalidar = () => { iniciado = false; catalogo = null; };

    q('origen').addEventListener('change', cargarCatalogo);
    q('destino').addEventListener('change', cargarCatalogo);
    q('buscar').addEventListener('input', render);
    q('cuerpo').addEventListener('input', e => {
      const tr = e.target.closest('tr[data-id]');
      if (!tr || !e.target.matches('[data-qty]')) return;
      cant.set(Number(tr.dataset.id), e.target.value); contar();
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
