'use strict';
// Pantalla "Tickets de Desarrollo" (/tickets). Dos pestañas: alta de ticket y seguimiento (tabla + panel de
// detalle). Todo lo que viene del servidor o lo tipeó un usuario (tarea, descripción, área, notas, nombres) se pinta
// con textContent o pasa por esc() antes de ir a innerHTML. Sin alert/confirm: los errores van a #aviso (role=alert).
(() => {
  const $ = sel => document.querySelector(sel);
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const el = (tag, clase, texto) => {
    const n = document.createElement(tag);
    if (clase) n.className = clase;
    if (texto != null) n.textContent = texto;
    return n;
  };
  const OTRA = '__otra__'; // valor del select de área para "Otra" (texto libre)
  const MAX_TAREA = 150;
  const MAX_DESC = 5000;
  const MAX_NOTA = 2000; // tope de lib/tickets.js para notas
  const ACTIVOS = '__activos__'; // filtro de estado default: todo menos terminado y cancelado
  const TODOS = '';
  const CERRADOS = ['terminado', 'cancelado'];
  const COLOR_ESTADO = {
    pendiente: '#8a8d80', en_proceso: '#0958d9', falta_aprobacion: '#c99400', stand_by: '#6b3fa0', terminado: '#0e700e', cancelado: '#a4262c',
  };
  const FMT_FECHA = new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });

  const estado = {
    meta: null, tickets: [], cargando: false,
    orden: { col: null, dir: 1 }, // col null = orden default (prioridad desc, creadoEn asc)
    abierto: null, // id del ticket del panel de detalle
  };
  let selectorNuevo = null;
  let focoPrevio = null;

  // ── Utilidades ──────────────────────────────────────────────────────────────
  async function api(url, opciones) {
    let r;
    try {
      r = await fetch(url, opciones);
    } catch (_) {
      throw new Error('No se pudo conectar con el servidor. Revisá la red y probá de nuevo.');
    }
    const datos = await r.json().catch(() => null);
    if (r.status === 401) throw new Error('La sesión venció: volvé a iniciar sesión.');
    if (!r.ok) throw new Error((datos && datos.error) || `Error del servidor (${r.status}).`);
    return datos;
  }
  const enviarJSON = (metodo, url, cuerpo) => api(url, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });

  function mostrarAviso(tono, texto, destino = '#aviso') {
    const caja = $(destino);
    if (!caja) return;
    caja.className = `${tono === 'ok' ? 'ok' : 'error'} ${destino === '#aviso' ? 'mt-4' : 'mb-3'}`;
    caja.textContent = texto;
  }
  function ocultarAviso(destino = '#aviso') {
    const caja = $(destino);
    if (caja) { caja.className = 'hidden'; caja.textContent = ''; }
  }

  const fecha = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : FMT_FECHA.format(d); };
  function haceCuanto(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms)) return '—';
    const min = Math.round(ms / 60000);
    if (min < 1) return 'recién';
    if (min < 60) return `hace ${min} min`;
    const h = Math.round(min / 60);
    if (h < 24) return `hace ${h} h`;
    const d = Math.round(h / 24);
    return d < 7 ? `hace ${d} d` : fecha(iso);
  }

  const nombreDe = u => ((estado.meta.usuarios || []).find(x => x.usuario === u) || {}).nombre || u || '—';
  const etiqueta = (lista, valor) => ((estado.meta[lista] || []).find(x => x.valor === valor) || {}).etiqueta || valor || '—';
  const rango = (lista, valor) => (estado.meta[lista] || []).findIndex(x => x.valor === valor);
  const comoLista = v => (Array.isArray(v) ? v : (v ? [v] : []));

  // ── Selector de usuarios (alta y detalle): buscador + chips + lista con checkboxes ──
  // ponytail: la lista son solo los usuarios activos de meta; un destinatario ya inactivo queda como chip.
  function crearSelectorUsuarios(raiz, inicial, alCambiar) {
    let seleccion = [...inicial];
    const buscar = el('input', 'ctl w-full mb-2');
    buscar.type = 'search';
    buscar.placeholder = 'Buscar por nombre o usuario…';
    buscar.setAttribute('aria-label', 'Buscar destinatario');
    const chips = el('div', 'flex flex-wrap gap-1 mb-2 min-h-[24px]');
    const lista = el('div', 'lista-usuarios');
    lista.setAttribute('role', 'group');
    lista.setAttribute('aria-label', 'Usuarios del sistema');

    const cambiar = nueva => { seleccion = nueva; pintarChips(); pintarLista(); if (alCambiar) alCambiar(); };
    const alternar = u => cambiar(seleccion.includes(u) ? seleccion.filter(x => x !== u) : [...seleccion, u]);

    function pintarChips() {
      if (!seleccion.length) { chips.replaceChildren(el('span', 'ayuda', 'Ningún destinatario elegido.')); return; }
      chips.replaceChildren(...seleccion.map(u => {
        const chip = el('span', 'chip chip-user', nombreDe(u));
        const quitar = el('button', null, '✕');
        quitar.type = 'button';
        quitar.setAttribute('aria-label', `Quitar a ${nombreDe(u)}`);
        quitar.addEventListener('click', () => alternar(u));
        chip.append(quitar);
        return chip;
      }));
    }
    function pintarLista() {
      const q = buscar.value.trim().toLowerCase();
      const visibles = (estado.meta.usuarios || []).filter(x => !q || `${x.nombre} ${x.usuario}`.toLowerCase().includes(q));
      if (!visibles.length) { lista.replaceChildren(el('div', 'empty', 'Sin usuarios que coincidan.')); return; }
      lista.replaceChildren(...visibles.map(x => {
        const fila = el('label');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = seleccion.includes(x.usuario);
        cb.addEventListener('change', () => alternar(x.usuario));
        fila.append(cb, el('span', null, x.nombre || x.usuario), el('span', 'u', x.usuario));
        return fila;
      }));
    }

    buscar.addEventListener('input', pintarLista);
    raiz.replaceChildren(buscar, chips, lista);
    pintarChips();
    pintarLista();
    return {
      valor: () => [...seleccion],
      reiniciar: v => { buscar.value = ''; cambiar([...v]); },
      marcarError: hay => lista.setAttribute('aria-invalid', hay ? 'true' : 'false'),
    };
  }

  // ── Pestañas ────────────────────────────────────────────────────────────────
  function irA(tab) {
    document.querySelectorAll('[role=tab]').forEach(b => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $('#panel-nuevo').classList.toggle('hidden', tab !== 'nuevo');
    $('#panel-seguimiento').classList.toggle('hidden', tab !== 'seguimiento');
  }

  // ── Nuevo ticket ────────────────────────────────────────────────────────────
  function armarFormulario() {
    const m = estado.meta;
    $('#fPrioridad').replaceChildren(...m.prioridades.map(p => {
      const lab = el('label');
      const radio = el('input');
      radio.type = 'radio';
      radio.name = 'prioridad';
      radio.value = p.valor;
      radio.checked = p.valor === 'media';
      const txt = el('span', null, p.etiqueta);
      lab.append(radio, txt);
      return lab;
    }));
    pintarSegmento();
    // "Otra" la agrega la pantalla (texto libre): si la lista fija ya la trae, no se repite.
    const areas = m.areas.filter(a => String(a).trim().toLowerCase() !== 'otra').map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
    $('#fArea').innerHTML = `<option value="">Elegí un área…</option>${areas}<option value="${OTRA}">Otra…</option>`;
    selectorNuevo = crearSelectorUsuarios($('#fDest'), [], null);
  }

  // El segmento elegido toma el color de su prioridad; los demás quedan neutros.
  function pintarSegmento() {
    document.querySelectorAll('#fPrioridad input').forEach(r => {
      r.nextElementSibling.className = r.checked ? `pri-${r.value}` : '';
    });
  }

  function leerFormulario() {
    const area = $('#fArea').value === OTRA ? $('#fAreaOtra').value.trim() : $('#fArea').value;
    const prioridad = (document.querySelector('#fPrioridad input:checked') || {}).value || '';
    return {
      tarea: $('#fTarea').value.trim(), prioridad, area,
      descripcion: $('#fDesc').value.trim(), destinatarios: selectorNuevo.valor(),
    };
  }

  // Devuelve [{ campo, msg }]; campo es el control que se marca (null si no tiene uno solo).
  function validar(d) {
    const errores = [];
    if (!d.tarea) errores.push({ campo: '#fTarea', msg: 'Escribí la tarea.' });
    else if (d.tarea.length > MAX_TAREA) errores.push({ campo: '#fTarea', msg: `La tarea no puede pasar de ${MAX_TAREA} caracteres.` });
    if (!estado.meta.prioridades.some(p => p.valor === d.prioridad)) errores.push({ campo: null, msg: 'Elegí una prioridad.' });
    if ($('#fArea').value === OTRA && !d.area) errores.push({ campo: '#fAreaOtra', msg: 'Elegiste «Otra»: escribí el área de trabajo.' });
    else if (!d.area) errores.push({ campo: '#fArea', msg: 'Elegí el área de trabajo.' });
    if (d.descripcion.length > MAX_DESC) errores.push({ campo: '#fDesc', msg: `La descripción no puede pasar de ${MAX_DESC} caracteres.` });
    if (!d.destinatarios.length) errores.push({ campo: 'dest', msg: 'Elegí al menos un destinatario.' });
    return errores;
  }

  function mostrarErrores(errores) {
    ['#fTarea', '#fArea', '#fAreaOtra', '#fDesc'].forEach(s => $(s).setAttribute('aria-invalid', 'false'));
    selectorNuevo.marcarError(false);
    errores.forEach(e => { if (e.campo === 'dest') selectorNuevo.marcarError(true); else if (e.campo) $(e.campo).setAttribute('aria-invalid', 'true'); });
    const caja = $('#fErrores');
    caja.classList.toggle('hidden', !errores.length);
    const ul = el('ul', 'list-disc pl-5');
    ul.replaceChildren(...errores.map(e => el('li', null, e.msg)));
    caja.replaceChildren(...(errores.length ? [el('div', 'font-semibold mb-1', 'Revisá el formulario:'), ul] : []));
  }

  function limpiarFormulario() {
    $('#form').reset();
    document.querySelectorAll('#fPrioridad input').forEach(r => { r.checked = r.value === 'media'; });
    pintarSegmento();
    $('#fAreaOtra').classList.add('hidden');
    $('#fTareaCont').textContent = '0';
    $('#fDescCont').textContent = '0';
    selectorNuevo.reiniciar([]);
    mostrarErrores([]);
  }

  async function crearTicket(ev) {
    ev.preventDefault();
    const datos = leerFormulario();
    const errores = validar(datos);
    mostrarErrores(errores);
    if (errores.length) return;
    const btn = $('#fCrear');
    btn.disabled = true;
    btn.textContent = 'Creando…';
    try {
      const t = await enviarJSON('POST', '/api/tickets', datos);
      limpiarFormulario();
      mostrarAviso('ok', `Ticket #${t && t.id != null ? t.id : ''} creado: «${datos.tarea}».`);
      await cargarTickets();
    } catch (e) {
      mostrarAviso('error', `No se pudo crear el ticket: ${e.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Crear ticket';
    }
  }

  // ── Seguimiento: filtros ────────────────────────────────────────────────────
  const opciones = (items, todos) => [[TODOS, todos], ...items].map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');

  function armarFiltros() {
    const m = estado.meta;
    $('#flEstado').innerHTML = `<option value="${ACTIVOS}">Activos</option>${opciones(m.estados.map(e => [e.valor, e.etiqueta]), 'Todos')}`;
    $('#flPrioridad').innerHTML = opciones(m.prioridades.map(p => [p.valor, p.etiqueta]), 'Todas');
    $('#flDest').innerHTML = opciones(m.usuarios.map(u => [u.usuario, u.nombre || u.usuario]), 'Todos');
    $('#flMios').disabled = !m.yo;
    $('#flMios').title = m.yo ? '' : 'No se pudo identificar tu usuario';
    armarFiltroArea();
  }

  // Áreas fijas + las escritas a mano ("Otra") que aparezcan en los tickets.
  function armarFiltroArea() {
    const previo = $('#flArea').value;
    const areas = [...new Set([...estado.meta.areas, ...estado.tickets.map(t => t.area).filter(Boolean)])].sort((a, b) => a.localeCompare(b, 'es'));
    $('#flArea').innerHTML = opciones(areas.map(a => [a, a]), 'Todas');
    $('#flArea').value = areas.includes(previo) ? previo : TODOS;
  }

  function pasaFiltros(t) {
    const fe = $('#flEstado').value;
    if (fe === ACTIVOS && CERRADOS.includes(t.estado)) return false;
    if (fe !== ACTIVOS && fe !== TODOS && t.estado !== fe) return false;
    if ($('#flPrioridad').value && t.prioridad !== $('#flPrioridad').value) return false;
    if ($('#flArea').value && t.area !== $('#flArea').value) return false;
    const dest = comoLista(t.destinatarios);
    if ($('#flDest').value && !dest.includes($('#flDest').value)) return false;
    if ($('#flMios').checked && !dest.includes(estado.meta.yo)) return false;
    const q = $('#flBuscar').value.trim().toLowerCase();
    if (!q) return true;
    const id = q.replace(/^#/, '');
    return String(t.id) === id || `${t.tarea} ${t.descripcion || ''}`.toLowerCase().includes(q);
  }

  // ── Seguimiento: orden ──────────────────────────────────────────────────────
  const tiempo = iso => new Date(iso).getTime() || 0;
  function ordenDefault(a, b) {
    return (rango('prioridades', b.prioridad) - rango('prioridades', a.prioridad)) || (tiempo(a.creadoEn) - tiempo(b.creadoEn));
  }
  function valorOrden(t, col) {
    if (col === 'prioridad') return rango('prioridades', t.prioridad);
    if (col === 'estado') return rango('estados', t.estado);
    if (col === 'creadoEn' || col === 'actualizadoEn') return tiempo(t[col]);
    if (col === 'id') return Number(t.id) || 0;
    return String(t[col] || '').toLowerCase();
  }
  function ordenar(lista) {
    const { col, dir } = estado.orden;
    if (!col) return [...lista].sort(ordenDefault);
    return [...lista].sort((a, b) => {
      const va = valorOrden(a, col), vb = valorOrden(b, col);
      const c = typeof va === 'string' ? va.localeCompare(vb, 'es') : va - vb;
      return (c * dir) || ordenDefault(a, b);
    });
  }
  function pintarEncabezados() {
    document.querySelectorAll('th.sortable').forEach(th => {
      const activo = th.dataset.col === estado.orden.col;
      th.setAttribute('aria-sort', activo ? (estado.orden.dir > 0 ? 'ascending' : 'descending') : 'none');
      th.querySelector('.flecha')?.remove();
      if (activo) th.append(el('span', 'flecha', estado.orden.dir > 0 ? '▲' : '▼'));
    });
  }
  // Clic: asc → desc → vuelve al orden default.
  function cambiarOrden(col) {
    const o = estado.orden;
    estado.orden = o.col !== col ? { col, dir: 1 } : (o.dir > 0 ? { col, dir: -1 } : { col: null, dir: 1 });
    pintarSeguimiento();
  }

  // ── Seguimiento: KPIs y tabla ───────────────────────────────────────────────
  function pintarKpis() {
    const actual = $('#flEstado').value;
    const kpi = (valor, txt, n, color) => `<button type="button" class="kpi${actual === valor ? ' on' : ''}" data-kpi="${esc(valor)}"
      aria-pressed="${actual === valor}"><div class="l">${color ? `<span class="dot" style="background:${esc(color)}"></span>` : ''}${esc(txt)}</div>
      <div class="v text-verde">${n}</div></button>`;
    const activos = estado.tickets.filter(t => !CERRADOS.includes(t.estado)).length;
    $('#kpis').innerHTML = kpi(ACTIVOS, 'Activos', activos, null) + estado.meta.estados.map(e =>
      kpi(e.valor, e.etiqueta, estado.tickets.filter(t => t.estado === e.valor).length, COLOR_ESTADO[e.valor])).join('');
  }

  // Un mismo clic en el KPI activo vuelve a "Activos".
  function filtrarPorKpi(valor) {
    $('#flEstado').value = $('#flEstado').value === valor ? ACTIVOS : valor;
    pintarSeguimiento();
  }

  const badgePrioridad = p => `<span class="chip pri-${esc(p)}">${esc(etiqueta('prioridades', p))}</span>`;
  function selectEstado(t) {
    const ops = estado.meta.estados.map(e => `<option value="${esc(e.valor)}"${e.valor === t.estado ? ' selected' : ''}>${esc(e.etiqueta)}</option>`).join('');
    return `<select class="sel-estado est-${esc(t.estado)}" data-estado-id="${esc(t.id)}" aria-label="Estado del ticket #${esc(t.id)}">${ops}</select>`;
  }
  const chipsUsuarios = lista => comoLista(lista).map(u => `<span class="chip chip-user">${esc(nombreDe(u))}</span>`).join(' ') || '<span class="text-gris">—</span>';

  function filaTicket(t) {
    return `<tr data-id="${esc(t.id)}" tabindex="0" class="${t.estado === 'cancelado' ? 'cancelado' : ''}">
      <td class="num text-gris">${esc(t.id)}</td>
      <td class="font-semibold max-w-[360px] break-words">${esc(t.tarea)}</td>
      <td>${badgePrioridad(t.prioridad)}</td>
      <td>${esc(t.area)}</td>
      <td><div class="flex flex-wrap gap-1">${chipsUsuarios(t.destinatarios)}</div></td>
      <td>${selectEstado(t)}</td>
      <td>${esc(nombreDe(t.creadoPor))}<div class="text-xs text-gris">${esc(fecha(t.creadoEn))}</div></td>
      <td title="${esc(fecha(t.actualizadoEn))}">${esc(haceCuanto(t.actualizadoEn))}</td></tr>`;
  }

  function pintarTabla() {
    const visibles = ordenar(estado.tickets.filter(pasaFiltros));
    $('#conteo').textContent = `${visibles.length} de ${estado.tickets.length} tickets`;
    $('#cuerpo').innerHTML = visibles.map(filaTicket).join('')
      || `<tr><td colspan="8" class="empty">${estado.tickets.length ? 'Ningún ticket coincide con los filtros.' : 'Todavía no hay tickets cargados.'}</td></tr>`;
    pintarEncabezados();
  }

  function pintarSeguimiento() {
    pintarKpis();
    pintarTabla();
  }

  async function cargarTickets() {
    const btn = $('#btnRecargar');
    btn.disabled = true;
    try {
      const lista = await api('/api/tickets');
      estado.tickets = Array.isArray(lista) ? lista : [];
      armarFiltroArea();
      pintarSeguimiento();
      if (estado.abierto != null) pintarDetalle();
    } catch (e) {
      mostrarAviso('error', `No se pudieron cargar los tickets: ${e.message}`);
      $('#cuerpo').innerHTML = '<tr><td colspan="8" class="empty">No se pudo cargar el listado.</td></tr>';
    } finally {
      btn.disabled = false;
    }
  }

  // ── PATCH y reemplazo inmutable del ticket en el estado ─────────────────────
  async function actualizar(id, cambios) {
    const t = await enviarJSON('PATCH', `/api/tickets/${encodeURIComponent(id)}`, cambios);
    estado.tickets = estado.tickets.map(x => (String(x.id) === String(id) ? t : x));
    pintarSeguimiento();
    if (estado.abierto != null && String(estado.abierto) === String(id)) pintarDetalle();
    return t;
  }

  // Select de estado (tabla o detalle): si falla vuelve al valor anterior.
  async function cambiarEstado(sel) {
    const id = sel.dataset.estadoId;
    const previo = (buscarTicket(id) || {}).estado;
    sel.disabled = true;
    try {
      await actualizar(id, { estado: sel.value });
      ocultarAviso();
    } catch (e) {
      sel.value = previo;
      sel.className = `sel-estado est-${previo}`;
      sel.disabled = false;
      mostrarAviso('error', `No se pudo cambiar el estado del ticket #${id}: ${e.message}`, estado.abierto != null ? '#dAviso' : '#aviso');
    }
  }

  const buscarTicket = id => estado.tickets.find(t => String(t.id) === String(id)) || null;

  // ── Panel de detalle ────────────────────────────────────────────────────────
  function abrirDetalle(id) {
    focoPrevio = document.activeElement;
    estado.abierto = id;
    pintarDetalle();
    $('#velo').classList.remove('hidden');
    $('#panel').classList.remove('hidden');
    $('#panel').classList.add('flex');
    $('#dCerrar').focus();
  }
  function cerrarDetalle() {
    estado.abierto = null;
    $('#velo').classList.add('hidden');
    $('#panel').classList.add('hidden');
    $('#panel').classList.remove('flex');
    if (focoPrevio && document.contains(focoPrevio)) focoPrevio.focus();
  }

  function campo(etq, contenido) {
    const caja = el('div');
    caja.append(el('div', 'lbl', etq));
    if (typeof contenido === 'string') caja.append(el('div', null, contenido)); else caja.append(contenido);
    return caja;
  }

  function pintarDetalle() {
    const t = buscarTicket(estado.abierto);
    if (!t) { cerrarDetalle(); mostrarAviso('error', 'El ticket ya no está en el listado.'); return; }
    $('#dId').textContent = `Ticket #${t.id}`;
    $('#dTitulo').textContent = t.tarea;
    const aviso = el('div', 'hidden');
    aviso.id = 'dAviso';
    aviso.setAttribute('role', 'alert');
    $('#dCuerpo').replaceChildren(aviso, seccionDatos(t), seccionDescripcion(t), seccionDestinatarios(t), seccionNota(t), seccionHistorial(t));
  }

  function seccionDatos(t) {
    const grilla = el('div', 'grid grid-cols-2 gap-4 mb-5');
    const pri = el('div');
    pri.innerHTML = badgePrioridad(t.prioridad);
    const est = el('div');
    est.innerHTML = selectEstado(t);
    grilla.append(campo('Prioridad', pri), campo('Estado', est), campo('Área de trabajo', t.area || '—'),
      campo('Creado por', `${nombreDe(t.creadoPor)} · ${fecha(t.creadoEn)}`),
      campo('Última actualización', `${fecha(t.actualizadoEn)} (${haceCuanto(t.actualizadoEn)})`));
    return grilla;
  }

  function seccionDescripcion(t) {
    const caja = el('div', 'mb-5');
    caja.append(el('div', 'lbl', 'Descripción'),
      el('div', 'texto-libre bg-[#f7f9f4] border border-borde rounded-lg p-3', t.descripcion || 'Sin descripción.'));
    return caja;
  }

  function seccionDestinatarios(t) {
    const caja = el('div', 'mb-5');
    const raiz = el('div');
    const guardar = el('button', 'btn mt-2', 'Guardar destinatarios');
    guardar.type = 'button';
    guardar.disabled = true;
    const inicial = comoLista(t.destinatarios);
    const mismos = v => v.length === inicial.length && v.every(u => inicial.includes(u));
    const sel = crearSelectorUsuarios(raiz, inicial, () => { guardar.disabled = mismos(sel.valor()); });
    guardar.addEventListener('click', () => guardarDestinatarios(t.id, sel, guardar));
    caja.append(el('div', 'lbl', 'Destinatarios'), raiz, guardar);
    return caja;
  }

  async function guardarDestinatarios(id, sel, btn) {
    const destinatarios = sel.valor();
    if (!destinatarios.length) { mostrarAviso('error', 'Tiene que quedar al menos un destinatario.', '#dAviso'); return; }
    btn.disabled = true;
    btn.textContent = 'Guardando…';
    try {
      await actualizar(id, { destinatarios });
      mostrarAviso('ok', 'Destinatarios actualizados.', '#dAviso');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Guardar destinatarios';
      mostrarAviso('error', `No se pudieron guardar los destinatarios: ${e.message}`, '#dAviso');
    }
  }

  function seccionNota(t) {
    const caja = el('div', 'mb-5');
    const lab = el('label', 'lbl', 'Agregar nota de seguimiento');
    lab.htmlFor = 'dNota';
    const txt = el('textarea', 'ctl w-full');
    txt.id = 'dNota';
    txt.rows = 3;
    txt.maxLength = MAX_NOTA;
    txt.placeholder = 'Avance, pregunta, decisión…';
    const btn = el('button', 'btn btn-primario mt-2', 'Agregar nota');
    btn.type = 'button';
    btn.addEventListener('click', () => agregarNota(t.id, txt, btn));
    caja.append(lab, txt, btn);
    return caja;
  }

  async function agregarNota(id, txt, btn) {
    const nota = txt.value.trim();
    if (!nota) { txt.setAttribute('aria-invalid', 'true'); mostrarAviso('error', 'Escribí la nota antes de agregarla.', '#dAviso'); return; }
    btn.disabled = true;
    btn.textContent = 'Agregando…';
    try {
      await actualizar(id, { nota });
      mostrarAviso('ok', 'Nota agregada.', '#dAviso');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Agregar nota';
      mostrarAviso('error', `No se pudo agregar la nota: ${e.message}`, '#dAviso');
    }
  }

  // Texto legible de un evento del historial. Devuelve [frase, nota?].
  function describirEvento(h) {
    const quien = nombreDe(h.usuario);
    const nombres = v => comoLista(v).map(nombreDe).join(', ') || 'nadie';
    if (h.tipo === 'creado') return [`${quien} creó el ticket`];
    if (h.tipo === 'estado') return [`${quien} cambió estado: ${etiqueta('estados', h.de)} → ${etiqueta('estados', h.a)}`];
    if (h.tipo === 'nota') return [`${quien} agregó nota:`, h.nota || ''];
    if (h.tipo === 'destinatarios') return [`${quien} cambió destinatarios: ${nombres(h.de)} → ${nombres(h.a)}`];
    return [`${quien}: ${h.tipo || 'cambio'}`];
  }

  function seccionHistorial(t) {
    const caja = el('div');
    caja.append(el('div', 'lbl', 'Historial'));
    const eventos = [...(t.historial || [])].sort((a, b) => tiempo(b.fecha) - tiempo(a.fecha));
    if (!eventos.length) { caja.append(el('div', 'empty', 'Sin movimientos.')); return caja; }
    const ul = el('ul', 'hist ml-1 mt-2');
    ul.replaceChildren(...eventos.map(h => {
      const [frase, nota] = describirEvento(h);
      const li = el('li');
      li.append(el('div', 'text-xs text-gris', fecha(h.fecha)), el('div', null, frase));
      if (nota != null) li.append(el('div', 'texto-libre mt-1 bg-[#f7f9f4] border border-borde rounded-lg px-3 py-2', nota));
      return li;
    }));
    caja.append(ul);
    return caja;
  }

  // ── Eventos ─────────────────────────────────────────────────────────────────
  function enlazarFormulario() {
    $('#form').addEventListener('submit', crearTicket);
    $('#fLimpiar').addEventListener('click', () => { limpiarFormulario(); ocultarAviso(); });
    $('#fPrioridad').addEventListener('change', pintarSegmento);
    $('#fArea').addEventListener('change', () => {
      const otra = $('#fArea').value === OTRA;
      $('#fAreaOtra').classList.toggle('hidden', !otra);
      if (otra) $('#fAreaOtra').focus();
    });
    $('#fTarea').addEventListener('input', () => { $('#fTareaCont').textContent = String($('#fTarea').value.length); });
    $('#fDesc').addEventListener('input', () => { $('#fDescCont').textContent = String($('#fDesc').value.length); });
  }

  function enlazarSeguimiento() {
    ['#flEstado', '#flPrioridad', '#flArea', '#flDest', '#flMios'].forEach(s => $(s).addEventListener('change', pintarSeguimiento));
    $('#flBuscar').addEventListener('input', pintarTabla);
    $('#kpis').addEventListener('click', e => { const b = e.target.closest('[data-kpi]'); if (b) filtrarPorKpi(b.dataset.kpi); });
    document.querySelectorAll('th.sortable').forEach(th => th.addEventListener('click', () => cambiarOrden(th.dataset.col)));
    const cuerpo = $('#cuerpo');
    cuerpo.addEventListener('click', e => {
      if (e.target.closest('select')) return; // el select de estado no abre el detalle
      const tr = e.target.closest('tr[data-id]');
      if (tr) abrirDetalle(tr.dataset.id);
    });
    cuerpo.addEventListener('keydown', e => {
      const tr = e.target.closest('tr[data-id]');
      if (tr && e.target === tr && e.key === 'Enter') abrirDetalle(tr.dataset.id);
    });
  }

  function enlazarGenerales() {
    document.querySelectorAll('[role=tab]').forEach(b => b.addEventListener('click', () => irA(b.dataset.tab)));
    // Sin meta (falló el arranque) no hay con qué pintar: se recarga la página entera.
    $('#btnRecargar').addEventListener('click', () => { if (!estado.meta) { location.reload(); return; } ocultarAviso(); cargarTickets(); });
    // Selects de estado de la tabla y del panel: delegado en document.
    document.addEventListener('change', e => { if (e.target.matches('select[data-estado-id]')) cambiarEstado(e.target); });
    $('#dCerrar').addEventListener('click', cerrarDetalle);
    $('#velo').addEventListener('click', cerrarDetalle);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && estado.abierto != null) cerrarDetalle(); });
  }

  // ── Arranque ────────────────────────────────────────────────────────────────
  async function iniciar() {
    enlazarGenerales();
    try {
      const m = await api('/api/tickets/meta');
      estado.meta = { prioridades: [], estados: [], areas: [], usuarios: [], yo: null, ...m };
    } catch (e) {
      mostrarAviso('error', `No se pudo abrir el módulo: ${e.message}`);
      $('#fCrear').disabled = true;
      $('#cuerpo').innerHTML = '<tr><td colspan="8" class="empty">Sin datos.</td></tr>';
      return;
    }
    $('#yo').textContent = estado.meta.yo ? nombreDe(estado.meta.yo) : '';
    armarFormulario();
    armarFiltros();
    enlazarFormulario();
    enlazarSeguimiento();
    await cargarTickets();
  }

  iniciar();
})();
