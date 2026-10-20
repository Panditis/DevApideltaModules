'use strict';
// Pantalla "Tickets de Desarrollo" (/tickets). Seguimiento en tablero (kanban por estado, con drag & drop) o lista;
// alta en un diálogo modal y detalle en un panel lateral (<dialog> nativo: foco atrapado, Esc y fondo inerte).
// Todo lo que viene del servidor o lo tipeó un usuario (tarea, descripción, área, notas, nombres) se pinta con
// textContent o pasa por esc() antes de ir a innerHTML. Sin alert/confirm: los errores van a #aviso (role=alert).
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
  const MAX_AVATARES = 3;
  const TOAST_MS = 3500;
  const CLAVE_VISTA = 'tickets.vista';
  const FMT_FECHA = new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  // ponytail: copia de lib/tickets.js, sólo para seguir mostrando tickets si /meta responde 503 (SIGA caído).
  const META_RESPALDO = {
    prioridades: [{ valor: 'baja', etiqueta: 'Baja' }, { valor: 'media', etiqueta: 'Media' }, { valor: 'alta', etiqueta: 'Alta' }, { valor: 'urgente', etiqueta: 'Urgente' }],
    estados: [{ valor: 'pendiente', etiqueta: 'Pendiente' }, { valor: 'en_proceso', etiqueta: 'En proceso' }, { valor: 'falta_aprobacion', etiqueta: 'Falta aprobación' },
      { valor: 'stand_by', etiqueta: 'Stand by' }, { valor: 'terminado', etiqueta: 'Terminado' }, { valor: 'cancelado', etiqueta: 'Cancelado' }],
    areas: [], usuarios: [], yo: null, yoNombre: null, login: null, puedeGestionar: false,
  };
  const SIN_PERMISO = 'Necesitás el permiso Tickets · Gestión';
  const AVATAR_TONOS = [['#e3ecda', '#2e4027'], ['#e0ecf8', '#0b4f9c'], ['#fbecd0', '#7a5200'], ['#efe4f7', '#5b3391'],
    ['#fde4e1', '#9c2b2b'], ['#dcf0ec', '#1d6157'], ['#ece9e2', '#4d4a40'], ['#e6e9f8', '#3a4699']];
  // Íconos (trazos de lucide, ISC) inline: constantes, nunca datos de usuario.
  const ICONOS = {
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    msg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    reloj: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    usuarios: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    estado: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
    creado: '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>',
    vacio: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    texto: '<path d="M17 6.1H3"/><path d="M21 12.1H3"/><path d="M15.1 18H3"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    alerta: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    candado: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    historial: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  };
  const ico = (nombre, clase = 'ico') => `<svg class="${clase}" viewBox="0 0 24 24" aria-hidden="true">${ICONOS[nombre]}</svg>`;

  const estado = {
    meta: META_RESPALDO, metaOk: false, tickets: [], cargado: false,
    vista: 'tablero',
    filtroEstado: ACTIVOS, filtroPrioridad: TODOS,
    orden: { col: null, dir: 1 }, // col null = orden default (prioridad desc, creadoEn asc)
    abierto: null, // id del ticket del panel de detalle
    borrador: null, // { id, dest: [..] | null, nota } — edición sin guardar del detalle, sobrevive a los repintados
    guardando: new Set(), // ids con un cambio de estado en vuelo
  };
  let selectorNuevo = null;
  let focoPrevio = null;
  let timerToast = null;

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
    caja.className = `${tono === 'ok' ? 'ok' : 'error'} ${destino === '#aviso' ? 'mb-4' : 'mx-6 mt-4'}`;
    caja.innerHTML = ico(tono === 'ok' ? 'check' : 'alerta', 'ico mt-0.5');
    caja.append(el('span', null, texto));
  }
  function ocultarAviso(destino = '#aviso') {
    const caja = $(destino);
    if (caja) { caja.className = 'hidden'; caja.textContent = ''; }
  }
  const avisoActual = () => (estado.abierto != null ? '#dAviso' : '#aviso');

  function mostrarToast(texto) {
    const t = $('#toast');
    t.innerHTML = ico('check');
    t.append(el('span', null, texto));
    t.classList.remove('hidden');
    clearTimeout(timerToast);
    timerToast = setTimeout(() => t.classList.add('hidden'), TOAST_MS);
  }

  const tiempo = iso => new Date(iso).getTime() || 0;
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
    return d < 30 ? `hace ${d} d` : fecha(iso).slice(0, 8);
  }

  // Los destinatarios son Id SIGA; creadoPor/historial son logins del sistema: se cruzan sin distinguir mayúsculas.
  const mismoUsuario = (a, b) => a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase();
  const usuarioMeta = u => (estado.meta.usuarios || []).find(x => mismoUsuario(x.usuario, u)) || null;
  const nombreDe = u => (usuarioMeta(u) || {}).nombre || u || '—';
  const etiqueta = (lista, valor) => ((estado.meta[lista] || []).find(x => x.valor === valor) || {}).etiqueta || valor || '—';
  const rango = (lista, valor) => (estado.meta[lista] || []).findIndex(x => x.valor === valor);
  const comoLista = v => (Array.isArray(v) ? v : (v ? [v] : []));
  const buscarTicket = id => estado.tickets.find(t => String(t.id) === String(id)) || null;
  const reemplazarTicket = (id, nuevo) => { estado.tickets = estado.tickets.map(x => (String(x.id) === String(id) ? nuevo : x)); };
  const notasDe = t => (t.historial || []).filter(h => h.tipo === 'nota').length;
  // Espejo de lo que valida el server: estados sólo con 'tickets-gestion'; destinatarios también el creador.
  const puedeGestionar = () => estado.meta.puedeGestionar === true;
  const puedeEditarDest = t => puedeGestionar() || mismoUsuario(t.creadoPor, estado.meta.login);

  // ── Avatares ────────────────────────────────────────────────────────────────
  function iniciales(nombre) {
    const partes = String(nombre).replace(/<[^>]*>/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (!partes.length) return '?';
    return (partes.length === 1 ? partes[0].slice(0, 2) : partes[0][0] + partes[1][0]).toUpperCase();
  }
  function tono(clave) {
    let h = 0;
    for (const c of String(clave).toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return AVATAR_TONOS[h % AVATAR_TONOS.length];
  }
  // Color inline (no variables): dentro del navbar, `header.acrylic span` pisaría el color de la clase.
  // decorativo: el nombre ya está escrito al lado, el avatar no se lee dos veces.
  function avatar(u, clase = '', decorativo = false) {
    const nombre = nombreDe(u);
    const [bg, fg] = tono(u);
    const a11y = decorativo ? 'aria-hidden="true"' : `role="img" aria-label="${esc(nombre)}" title="${esc(nombre)}"`;
    return `<span class="av ${clase}" style="background:${bg};color:${fg}" ${a11y}>${esc(iniciales(nombre))}</span>`;
  }
  function pilaAvatares(lista) {
    const dest = comoLista(lista);
    if (!dest.length) return '<span class="text-gris text-xs">Sin asignar</span>';
    const resto = dest.slice(MAX_AVATARES);
    const mas = resto.length
      ? `<span class="av av-mas" title="${esc(resto.map(nombreDe).join(', '))}" role="img" aria-label="y ${resto.length} más">+${resto.length}</span>` : '';
    return `<span class="pila">${dest.slice(0, MAX_AVATARES).map(u => avatar(u)).join('')}${mas}</span>`;
  }

  const badgePrioridad = p => `<span class="badge-p p-${esc(p)}">${esc(etiqueta('prioridades', p))}</span>`;
  const badgeEstado = v => `<span class="inline-flex items-center gap-1.5 font-semibold e-${esc(v)}" style="color:var(--e-fg)"><span class="dot"></span>${esc(etiqueta('estados', v))}</span>`;
  function selectEstado(t, id) {
    const ops = estado.meta.estados.map(e => `<option value="${esc(e.valor)}"${e.valor === t.estado ? ' selected' : ''}>${esc(e.etiqueta)}</option>`).join('');
    const bloqueo = puedeGestionar() ? '' : ` disabled title="${esc(SIN_PERMISO)}" aria-description="${esc(SIN_PERMISO)}"`;
    return `<select class="sel-estado e-${esc(t.estado)}"${id ? ` id="${id}"` : ''} data-estado-id="${esc(t.id)}" aria-label="Estado del ticket #${esc(t.id)}"${bloqueo}>${ops}</select>`;
  }

  // ── Selector de usuarios (alta y detalle): chips con avatar + buscador + lista con checkboxes ──
  // ponytail: la lista son sólo los usuarios activos de meta; un destinatario dado de baja queda como chip con su Id.
  function crearSelectorUsuarios(raiz, { seleccion: inicial = [], alCambiar = null, soloLectura = false } = {}) {
    let seleccion = [...inicial];
    const caja = el('div', 'sel-u');
    const chips = el('div', 'chips');
    const buscador = el('div', 'buscar');
    const buscar = el('input', 'ctl');
    buscar.type = 'search';
    buscar.placeholder = 'Buscar por nombre o usuario…';
    buscar.setAttribute('aria-label', 'Buscar destinatario');
    buscador.innerHTML = ico('usuarios');
    buscador.append(buscar);
    const lista = el('div', 'lista');
    lista.setAttribute('role', 'group');
    lista.setAttribute('aria-label', 'Usuarios de SIGA');

    const cambiar = nueva => { seleccion = nueva; pintarChips(); pintarLista(); if (alCambiar) alCambiar([...seleccion]); };
    const alternar = u => cambiar(seleccion.includes(u) ? seleccion.filter(x => x !== u) : [...seleccion, u]);

    function chip(u) {
      const c = el('span', 'chip-u');
      c.innerHTML = avatar(u, '', true);
      c.append(el('span', null, nombreDe(u)));
      if (soloLectura) return c;
      const quitar = el('button');
      quitar.type = 'button';
      quitar.innerHTML = ico('x');
      quitar.setAttribute('aria-label', `Quitar a ${nombreDe(u)}`);
      quitar.addEventListener('click', () => alternar(u));
      c.append(quitar);
      return c;
    }
    function pintarChips() {
      chips.replaceChildren(...(seleccion.length ? seleccion.map(chip) : [el('span', 'ayuda', 'Ningún destinatario elegido.')]));
    }
    function pintarLista() {
      const q = buscar.value.trim().toLowerCase();
      const visibles = (estado.meta.usuarios || []).filter(x => !q || `${x.nombre} ${x.usuario}`.toLowerCase().includes(q));
      if (!visibles.length) { lista.replaceChildren(el('div', 'ayuda p-3 text-center', 'Sin usuarios que coincidan.')); return; }
      lista.replaceChildren(...visibles.map(x => {
        const fila = el('label');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = seleccion.includes(x.usuario);
        cb.addEventListener('change', () => alternar(x.usuario));
        const av = el('span');
        av.innerHTML = avatar(x.usuario, '', true);
        fila.append(cb, av.firstChild, el('span', null, x.nombre || x.usuario), el('span', 'u', x.usuario));
        return fila;
      }));
    }

    // Enter en el buscador no tiene que mandar el formulario de alta.
    buscar.addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
    buscar.addEventListener('input', pintarLista);
    caja.append(chips);
    if (!soloLectura) caja.append(buscador, lista);
    raiz.replaceChildren(caja);
    pintarChips();
    if (!soloLectura) pintarLista();
    return {
      valor: () => [...seleccion],
      reiniciar: v => { buscar.value = ''; cambiar([...v]); },
      marcarError: hay => caja.setAttribute('aria-invalid', hay ? 'true' : 'false'),
    };
  }

  // ── Nuevo ticket (diálogo) ──────────────────────────────────────────────────
  function armarFormulario() {
    const m = estado.meta;
    $('#fPrioridad').replaceChildren(...m.prioridades.map(p => {
      const lab = el('label', `p-${p.valor}`);
      const radio = el('input');
      radio.type = 'radio';
      radio.name = 'prioridad';
      radio.value = p.valor;
      radio.checked = p.valor === 'media';
      lab.append(radio, el('span', null, p.etiqueta));
      return lab;
    }));
    // "Otra" la agrega la pantalla (texto libre): si la lista fija ya la trae, no se repite.
    const areas = m.areas.filter(a => String(a).trim().toLowerCase() !== 'otra').map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
    $('#fArea').innerHTML = `<option value="">Elegí un área…</option>${areas}<option value="${OTRA}">Otra…</option>`;
    selectorNuevo = crearSelectorUsuarios($('#fDest'), { alCambiar: revalidar });
  }

  function abrirNuevo() {
    focoPrevio = document.activeElement;
    $('#dlgNuevo').showModal();
    $('#fTarea').focus();
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

  function mostrarErrores(errores, titulo = 'Revisá el formulario:') {
    ['#fTarea', '#fArea', '#fAreaOtra', '#fDesc'].forEach(s => $(s).setAttribute('aria-invalid', 'false'));
    selectorNuevo.marcarError(false);
    errores.forEach(e => { if (e.campo === 'dest') selectorNuevo.marcarError(true); else if (e.campo) $(e.campo).setAttribute('aria-invalid', 'true'); });
    const caja = $('#fErrores');
    caja.classList.toggle('hidden', !errores.length);
    if (!errores.length) { caja.replaceChildren(); return; }
    const cuerpo = el('div');
    const ul = el('ul', 'list-disc pl-5');
    ul.replaceChildren(...errores.map(e => el('li', null, e.msg)));
    cuerpo.append(el('div', 'font-semibold mb-1', titulo), ul);
    caja.innerHTML = ico('alerta', 'ico mt-0.5');
    caja.append(cuerpo);
  }

  // Con errores a la vista, cada cambio vuelve a validar: la marca roja se va apenas se corrige el campo.
  function revalidar() {
    if (!$('#fErrores').classList.contains('hidden')) mostrarErrores(validar(leerFormulario()));
  }

  function limpiarFormulario() {
    $('#form').reset();
    document.querySelectorAll('#fPrioridad input').forEach(r => { r.checked = r.value === 'media'; });
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
      if (t && t.id != null) estado.tickets = [...estado.tickets, t];
      limpiarFormulario();
      $('#dlgNuevo').close();
      armarFiltrosDinamicos();
      pintarSeguimiento();
      mostrarToast(`Ticket #${t && t.id != null ? t.id : ''} creado.`);
    } catch (e) {
      mostrarErrores([{ campo: null, msg: e.message }], 'No se pudo crear el ticket:');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Crear ticket';
    }
  }

  // ── Filtros ─────────────────────────────────────────────────────────────────
  const opciones = (items, todos) => [[TODOS, todos], ...items].map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');

  function armarFiltros() {
    const m = estado.meta;
    $('#flPrioridad').innerHTML = [[TODOS, 'Todas', ''], ...m.prioridades.map(p => [p.valor, p.etiqueta, `p-${p.valor}`])]
      .map(([v, t, c]) => `<button type="button" class="pill ${esc(c)}" data-prioridad="${esc(v)}" aria-pressed="false">${c ? '<span class="sw"></span>' : ''}${esc(t)}</button>`).join('');
    $('#flMios').disabled = !m.yo;
    $('#flMios').closest('label').title = m.yo ? '' : 'No se pudo identificar tu usuario de SIGA';
    armarFiltrosDinamicos();
  }

  // Áreas y destinatarios: los de meta + los que aparezcan en los tickets (áreas "Otra", usuarios dados de baja).
  function armarFiltrosDinamicos() {
    const ordenar = v => [...new Set(v.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'es'));
    const areas = ordenar([...estado.meta.areas, ...estado.tickets.map(t => t.area)]);
    rellenarSelect('#flArea', areas.map(a => [a, a]), 'Todas las áreas');
    const conocidos = (estado.meta.usuarios || []).map(u => u.usuario);
    const extra = estado.tickets.flatMap(t => comoLista(t.destinatarios)).filter(u => !conocidos.some(c => mismoUsuario(c, u)));
    const dest = [...conocidos, ...new Set(extra)].map(u => [u, nombreDe(u)]).sort((a, b) => a[1].localeCompare(b[1], 'es'));
    rellenarSelect('#flDest', dest, 'Todos los destinatarios');
  }
  function rellenarSelect(sel, items, todos) {
    const previo = $(sel).value;
    $(sel).innerHTML = opciones(items, todos);
    $(sel).value = items.some(([v]) => v === previo) ? previo : TODOS;
  }

  // Todos los filtros menos el de estado (el tablero reparte por estado en columnas).
  function pasaFiltrosBase(t) {
    if (estado.filtroPrioridad && t.prioridad !== estado.filtroPrioridad) return false;
    if ($('#flArea').value && t.area !== $('#flArea').value) return false;
    const dest = comoLista(t.destinatarios);
    if ($('#flDest').value && !dest.includes($('#flDest').value)) return false;
    if ($('#flMios').checked && !dest.some(u => mismoUsuario(u, estado.meta.yo))) return false;
    const q = $('#flBuscar').value.trim().toLowerCase();
    if (!q) return true;
    return String(t.id) === q.replace(/^#/, '') || `${t.tarea} ${t.descripcion || ''}`.toLowerCase().includes(q);
  }
  function pasaEstado(t) {
    const fe = estado.filtroEstado;
    if (fe === ACTIVOS) return !CERRADOS.includes(t.estado);
    return fe === TODOS || t.estado === fe;
  }
  function estadosVisibles() {
    const fe = estado.filtroEstado;
    if (fe === ACTIVOS) return estado.meta.estados.filter(e => !CERRADOS.includes(e.valor));
    return fe === TODOS ? estado.meta.estados : estado.meta.estados.filter(e => e.valor === fe);
  }

  function limpiarFiltros() {
    estado.filtroEstado = ACTIVOS;
    estado.filtroPrioridad = TODOS;
    ['#flBuscar', '#flArea', '#flDest'].forEach(s => { $(s).value = TODOS; });
    $('#flMios').checked = false;
    pintarSeguimiento();
  }

  // ── Orden ───────────────────────────────────────────────────────────────────
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
    pintarVista();
  }

  // ── Barra de estados (conteos = filtro de estado) ───────────────────────────
  function pintarEstados() {
    const base = estado.tickets.filter(pasaFiltrosBase);
    const boton = (valor, txt, n, clase) => `<button type="button" class="est-btn ${clase}" data-filtro-estado="${esc(valor)}"
      aria-pressed="${estado.filtroEstado === valor}"><span class="l">${clase ? '<span class="dot"></span>' : ''}${esc(txt)}</span>
      <span class="v">${n}</span></button>`;
    const activos = base.filter(t => !CERRADOS.includes(t.estado)).length;
    $('#estados').innerHTML = boton(ACTIVOS, 'Activos', activos, '') + boton(TODOS, 'Todos', base.length, '')
      + '<span class="est-sep" aria-hidden="true"></span>'
      + estado.meta.estados.map(e => boton(e.valor, e.etiqueta, base.filter(t => t.estado === e.valor).length, `e-${e.valor}`)).join('');
    document.querySelectorAll('#flPrioridad [data-prioridad]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.prioridad === estado.filtroPrioridad)));
  }

  // Un clic en el estado ya elegido vuelve a "Activos".
  function filtrarPorEstado(valor) {
    estado.filtroEstado = estado.filtroEstado === valor ? ACTIVOS : valor;
    pintarSeguimiento();
  }

  // ── Tablero ─────────────────────────────────────────────────────────────────
  function tarjeta(t) {
    const notas = notasDe(t);
    const mover = puedeGestionar();
    const clases = `tarjeta p-${esc(t.prioridad)} e-${esc(t.estado)}${estado.guardando.has(String(t.id)) ? ' guardando' : ''}${mover ? '' : ' fija'}`;
    return `<article class="${clases}" draggable="${mover}" tabindex="0" data-id="${esc(t.id)}"
      aria-label="Ticket #${esc(t.id)}: ${esc(t.tarea)}. Prioridad ${esc(etiqueta('prioridades', t.prioridad))}, ${esc(etiqueta('estados', t.estado))}.">
      <div class="fila1"><span class="num">#${esc(t.id)}</span>${badgePrioridad(t.prioridad)}
        <span class="ml-auto" title="Creado el ${esc(fecha(t.creadoEn))}">${esc(haceCuanto(t.creadoEn))}</span></div>
      <div class="tit">${esc(t.tarea)}</div>
      <div class="fila3">${t.area ? `<span class="tag-area" title="${esc(t.area)}">${esc(t.area)}</span>` : ''}
        <div class="meta">${notas ? `<span title="${notas} nota${notas === 1 ? '' : 's'}">${ico('msg')}${notas}</span>` : ''}${pilaAvatares(t.destinatarios)}</div></div>
    </article>`;
  }

  function columna(e, tickets) {
    const cuerpo = tickets.length ? tickets.map(tarjeta).join('') : `<div class="col-vacia">${puedeGestionar() ? 'Soltá un ticket acá' : 'Sin tickets'}</div>`;
    return `<section class="col e-${esc(e.valor)}" data-estado="${esc(e.valor)}" aria-label="${esc(e.etiqueta)}: ${tickets.length} tickets">
      <div class="col-cab"><span class="dot"></span>${esc(e.etiqueta)}<span class="n">${tickets.length}</span></div>
      <div class="col-cuerpo">${cuerpo}</div></section>`;
  }

  function pintarTablero(visibles) {
    const cols = estadosVisibles();
    const tab = $('#tablero');
    tab.removeAttribute('aria-busy');
    tab.style.gridTemplateColumns = `repeat(${cols.length}, minmax(${cols.length > 4 ? 236 : 260}px, ${cols.length === 1 ? '420px' : '1fr'}))`;
    if (!visibles.some(pasaEstado)) { tab.style.gridTemplateColumns = '1fr'; tab.innerHTML = vacioHTML(!estado.tickets.length); return; }
    tab.innerHTML = cols.map(e => columna(e, visibles.filter(t => t.estado === e.valor))).join('');
  }

  function vacioHTML(sinTickets) {
    return sinTickets
      ? `<div class="vacio bg-card rounded-xl border border-borde"><span class="circ">${ico('vacio')}</span><b>Todavía no hay tickets</b>
          <span>Cuando alguien pida un cambio al sistema, va a aparecer acá.</span>
          <button type="button" class="btn btn-primario mt-3" data-accion="nuevo"${estado.metaOk ? '' : ' disabled'}>Crear el primero</button></div>`
      : `<div class="vacio"><span class="circ">${ico('vacio')}</span><b>Ningún ticket coincide con los filtros</b>
          <button type="button" class="btn mt-3" data-accion="limpiar-filtros">Limpiar filtros</button></div>`;
  }

  // Drag & drop nativo: soltar en una columna cambia el estado. Alternativa por teclado: el select del detalle.
  // Sin permiso de gestión las tarjetas no son draggable y las columnas no aceptan drop (dragover sin preventDefault).
  function enlazarArrastre() {
    const tab = $('#tablero');
    const limpiarSobre = () => tab.querySelectorAll('.col.sobre').forEach(c => c.classList.remove('sobre'));
    tab.addEventListener('dragstart', e => {
      const card = e.target.closest('.tarjeta');
      if (!card) return;
      if (!puedeGestionar()) { e.preventDefault(); return; }
      e.dataTransfer.setData('text/plain', card.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      requestAnimationFrame(() => card.classList.add('arrastrando'));
    });
    tab.addEventListener('dragend', e => { e.target.closest('.tarjeta')?.classList.remove('arrastrando'); limpiarSobre(); });
    tab.addEventListener('dragover', e => {
      const col = e.target.closest('.col');
      if (!col || !puedeGestionar()) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!col.classList.contains('sobre')) { limpiarSobre(); col.classList.add('sobre'); }
    });
    tab.addEventListener('dragleave', e => {
      const col = e.target.closest('.col');
      if (col && !col.contains(e.relatedTarget)) col.classList.remove('sobre');
    });
    tab.addEventListener('drop', e => {
      const col = e.target.closest('.col');
      if (!col || !puedeGestionar()) return;
      e.preventDefault();
      limpiarSobre();
      moverEstado(e.dataTransfer.getData('text/plain'), col.dataset.estado);
    });
  }

  // ── Lista ───────────────────────────────────────────────────────────────────
  function filaTicket(t) {
    return `<tr data-id="${esc(t.id)}" tabindex="0" class="e-${esc(t.estado)}">
      <td class="num text-gris pri p-${esc(t.prioridad)}">${esc(t.id)}</td>
      <td class="tit font-semibold max-w-[420px] break-words">${esc(t.tarea)}</td>
      <td>${badgePrioridad(t.prioridad)}</td>
      <td>${t.area ? `<span class="tag-area">${esc(t.area)}</span>` : '—'}</td>
      <td>${pilaAvatares(t.destinatarios)}</td>
      <td>${selectEstado(t)}</td>
      <td>${esc(nombreDe(t.creadoPor))}<div class="text-xs text-gris">${esc(fecha(t.creadoEn))}</div></td>
      <td class="text-gris whitespace-nowrap" title="${esc(fecha(t.actualizadoEn))}">${esc(haceCuanto(t.actualizadoEn))}</td></tr>`;
  }

  function pintarLista(visibles) {
    const filtrados = visibles.filter(pasaEstado);
    $('#cuerpo').innerHTML = filtrados.map(filaTicket).join('')
      || `<tr><td colspan="8">${vacioHTML(!estado.tickets.length)}</td></tr>`;
    pintarEncabezados();
  }

  // ── Repintado ───────────────────────────────────────────────────────────────
  function pintarVista() {
    if (!estado.cargado) return;
    const visibles = ordenar(estado.tickets.filter(pasaFiltrosBase));
    const enVista = visibles.filter(pasaEstado).length;
    $('#conteo').textContent = `${enVista} de ${estado.tickets.length}`;
    if (estado.vista === 'lista') pintarLista(visibles); else pintarTablero(visibles);
  }
  function pintarSeguimiento() { pintarEstados(); pintarVista(); }
  function pintarTodo() { pintarSeguimiento(); if (estado.abierto != null) pintarDetalle(); }

  function cambiarVista(v) {
    estado.vista = v === 'lista' ? 'lista' : 'tablero';
    try { localStorage.setItem(CLAVE_VISTA, estado.vista); } catch (_) { /* sin storage: la vista no se recuerda */ }
    document.querySelectorAll('[data-vista]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.vista === estado.vista)));
    $('#vistaTablero').classList.toggle('hidden', estado.vista !== 'tablero');
    $('#vistaLista').classList.toggle('hidden', estado.vista !== 'lista');
    pintarVista();
  }

  function pintarCargando() {
    const sk = h => `<div class="sk" style="height:${h}px"></div>`;
    $('#tablero').style.gridTemplateColumns = 'repeat(4, minmax(260px, 1fr))';
    $('#tablero').innerHTML = [0, 1, 2, 3].map(i => `<div class="col"><div class="col-cab"><span class="sk" style="width:90px;height:14px"></span></div>
      <div class="col-cuerpo">${[96, 118, 96].slice(0, 3 - (i % 2)).map(sk).join('')}</div></div>`).join('');
    $('#cuerpo').innerHTML = '<tr><td colspan="8" class="py-10 text-center text-gris"><span class="spin"></span> Cargando tickets…</td></tr>';
  }

  async function cargarTickets() {
    const btn = $('#btnRecargar');
    btn.disabled = true;
    try {
      const lista = await api('/api/tickets');
      estado.tickets = Array.isArray(lista) ? lista : [];
      estado.cargado = true;
      armarFiltrosDinamicos();
      pintarTodo();
    } catch (e) {
      mostrarAviso('error', `No se pudieron cargar los tickets: ${e.message}`);
      if (!estado.cargado) {
        $('#tablero').style.gridTemplateColumns = '1fr';
        $('#tablero').innerHTML = '<div class="vacio">No se pudo cargar el listado.</div>';
        $('#cuerpo').innerHTML = '<tr><td colspan="8"><div class="vacio">No se pudo cargar el listado.</div></td></tr>';
      }
    } finally {
      btn.disabled = false;
    }
  }

  // ── Cambios (PATCH) ─────────────────────────────────────────────────────────
  // Manda el cambio y reemplaza el ticket en el estado con lo que devuelve el server. No repinta.
  async function actualizar(id, cambios) {
    const t = await enviarJSON('PATCH', `/api/tickets/${encodeURIComponent(id)}`, cambios);
    reemplazarTicket(id, t);
    return t;
  }

  // Cambio de estado optimista (drag & drop o select): se ve al instante y, si falla, vuelve atrás y avisa.
  async function moverEstado(id, nuevo) {
    const t = buscarTicket(id);
    if (!t || !nuevo || t.estado === nuevo || estado.guardando.has(String(t.id))) return;
    const destino = avisoActual();
    reemplazarTicket(id, { ...t, estado: nuevo });
    estado.guardando.add(String(t.id));
    pintarTodo();
    try {
      await actualizar(id, { estado: nuevo });
      ocultarAviso(destino);
      mostrarToast(`#${t.id} pasó a ${etiqueta('estados', nuevo)}.`);
    } catch (e) {
      const actual = buscarTicket(id);
      if (actual) reemplazarTicket(id, { ...actual, estado: t.estado });
      mostrarAviso('error', `No se pudo cambiar el estado del ticket #${t.id}: ${e.message}`, destino);
    } finally {
      estado.guardando.delete(String(t.id));
      pintarTodo();
    }
  }

  // ── Panel de detalle ────────────────────────────────────────────────────────
  function abrirDetalle(id) {
    if (!buscarTicket(id)) return;
    focoPrevio = document.activeElement;
    estado.abierto = id;
    estado.borrador = { id: String(id), dest: null, nota: '' };
    ocultarAviso('#dAviso');
    pintarDetalle();
    $('#dlgDetalle').showModal();
    $('#dlgDetalle [data-cerrar]').focus();
  }

  // Al cerrar: el foco vuelve a donde estaba o, si esa tarjeta/fila se repintó, a la nueva del mismo ticket.
  function alCerrarDetalle() {
    const id = estado.abierto;
    estado.abierto = null;
    estado.borrador = null;
    devolverFoco(id);
  }
  function devolverFoco(id) {
    if (focoPrevio && focoPrevio.isConnected) { focoPrevio.focus(); return; }
    const vista = estado.vista === 'lista' ? '#cuerpo' : '#tablero';
    if (id != null) document.querySelector(`${vista} [data-id="${CSS.escape(String(id))}"]`)?.focus();
  }

  function pintarDetalle() {
    const t = buscarTicket(estado.abierto);
    if (!t) { $('#dlgDetalle').close(); mostrarAviso('error', 'El ticket ya no está en el listado.'); return; }
    const focoId = $('#dlgDetalle').contains(document.activeElement) ? document.activeElement.id : '';
    $('#dCab').innerHTML = `<span class="text-sm font-semibold text-gris tabular-nums">#${esc(t.id)}</span>${badgePrioridad(t.prioridad)}${selectEstado(t, 'dEstado')}`;
    $('#dTitulo').textContent = t.tarea;
    $('#dMeta').innerHTML = `${t.area ? `<span class="tag-area">${esc(t.area)}</span>` : ''}
      <span>Creado por <b class="text-ink font-semibold">${esc(nombreDe(t.creadoPor))}</b> · ${esc(fecha(t.creadoEn))}</span>
      <span class="inline-flex items-center gap-1">${ico('reloj', 'ico w-3.5 h-3.5')}Actualizado ${esc(haceCuanto(t.actualizadoEn))}</span>`;
    $('#dCuerpo').replaceChildren(seccionDescripcion(t), seccionDestinatarios(t), seccionNota(t), seccionHistorial(t));
    if (focoId) document.getElementById(focoId)?.focus();
  }

  function seccion(titulo, icono) {
    const caja = el('section', 'det-sec');
    const h = el('h3', 'det-h');
    h.innerHTML = ico(icono);
    h.append(titulo);
    caja.append(h);
    return caja;
  }

  function seccionDescripcion(t) {
    const caja = seccion('Descripción', 'texto');
    caja.append(el('div', `texto-libre leading-relaxed ${t.descripcion ? '' : 'text-gris italic'}`, t.descripcion || 'Sin descripción.'));
    return caja;
  }

  function seccionDestinatarios(t) {
    const caja = seccion('Destinatarios', 'usuarios');
    const raiz = el('div');
    caja.append(raiz);
    const inicial = comoLista(t.destinatarios);
    const motivo = !estado.metaOk ? 'No se pueden editar ahora: no hay conexión con SIGA.'
      : (puedeEditarDest(t) ? '' : 'Los cambia quien creó el ticket o quien tenga el permiso Tickets · Gestión.');
    if (motivo) {
      crearSelectorUsuarios(raiz, { seleccion: inicial, soloLectura: true });
      caja.append(el('p', 'ayuda mt-2', motivo));
      return caja;
    }
    const mismos = v => v.length === inicial.length && v.every(u => inicial.includes(u));
    const guardar = el('button', 'btn btn-primario', 'Guardar destinatarios');
    guardar.type = 'button';
    guardar.id = 'dGuardarDest';
    const borrador = estado.borrador.dest;
    guardar.disabled = !borrador;
    const sel = crearSelectorUsuarios(raiz, {
      seleccion: borrador || inicial,
      alCambiar: v => { estado.borrador.dest = mismos(v) ? null : v; guardar.disabled = !estado.borrador.dest; },
    });
    guardar.addEventListener('click', () => guardarDestinatarios(t.id, sel, guardar));
    const pie = el('div', 'flex items-center gap-3 mt-3');
    pie.append(guardar);
    if (borrador) pie.append(el('span', 'ayuda', 'Cambios sin guardar.'));
    caja.append(pie);
    return caja;
  }

  async function guardarDestinatarios(id, sel, btn) {
    const destinatarios = sel.valor();
    if (!destinatarios.length) { mostrarAviso('error', 'Tiene que quedar al menos un destinatario.', '#dAviso'); return; }
    btn.disabled = true;
    btn.textContent = 'Guardando…';
    try {
      await actualizar(id, { destinatarios });
      estado.borrador.dest = null;
      ocultarAviso('#dAviso');
      pintarTodo();
      mostrarToast('Destinatarios actualizados.');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Guardar destinatarios';
      mostrarAviso('error', `No se pudieron guardar los destinatarios: ${e.message}`, '#dAviso');
    }
  }

  function seccionNota(t) {
    const caja = seccion('Agregar nota', 'msg');
    const fila = el('div', 'nota-caja');
    fila.innerHTML = estado.meta.yo ? avatar(estado.meta.yo, 'av-lg', true) : '';
    const cmp = el('div', 'cmp');
    const txt = el('textarea');
    txt.id = 'dNota';
    txt.rows = 2;
    txt.maxLength = MAX_NOTA;
    txt.placeholder = 'Avance, pregunta, decisión…';
    txt.setAttribute('aria-label', 'Nota de seguimiento');
    txt.value = estado.borrador.nota;
    const barra = el('div', 'barra');
    const cont = el('span', 'ayuda tabular-nums', `${txt.value.length}/${MAX_NOTA}`);
    const btn = el('button', 'btn btn-primario ml-auto', 'Agregar nota');
    btn.type = 'button';
    btn.id = 'dAgregarNota';
    txt.addEventListener('input', () => {
      estado.borrador.nota = txt.value;
      cont.textContent = `${txt.value.length}/${MAX_NOTA}`;
      txt.removeAttribute('aria-invalid');
    });
    // Ctrl+Enter agrega la nota sin ir al botón.
    txt.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) agregarNota(t.id, txt, btn); });
    btn.addEventListener('click', () => agregarNota(t.id, txt, btn));
    barra.append(cont, el('span', 'ayuda', '· Ctrl+Enter para enviar'), btn);
    cmp.append(txt, barra);
    fila.append(cmp);
    caja.append(fila);
    return caja;
  }

  async function agregarNota(id, txt, btn) {
    const nota = txt.value.trim();
    if (!nota) { txt.setAttribute('aria-invalid', 'true'); mostrarAviso('error', 'Escribí la nota antes de agregarla.', '#dAviso'); txt.focus(); return; }
    btn.disabled = true;
    btn.textContent = 'Agregando…';
    try {
      await actualizar(id, { nota });
      estado.borrador.nota = '';
      ocultarAviso('#dAviso');
      pintarTodo();
      mostrarToast('Nota agregada.');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Agregar nota';
      mostrarAviso('error', `No se pudo agregar la nota: ${e.message}`, '#dAviso');
    }
  }

  // HTML (ya escapado) de un evento del historial + texto de nota si tiene.
  function describirEvento(h) {
    const quien = `<b class="font-semibold">${esc(nombreDe(h.usuario))}</b>`;
    const nombres = v => esc(comoLista(v).map(nombreDe).join(', ') || 'nadie');
    if (h.tipo === 'creado') return [`${quien} creó el ticket`];
    if (h.tipo === 'estado') return [`${quien} cambió el estado: ${badgeEstado(h.de)} <span class="text-gris">→</span> ${badgeEstado(h.a)}`];
    if (h.tipo === 'nota') return [`${quien} agregó una nota`, h.nota || ''];
    if (h.tipo === 'destinatarios') return [`${quien} cambió los destinatarios: <span class="text-gris">${nombres(h.de)}</span> → ${nombres(h.a)}`];
    return [`${quien}: ${esc(h.tipo || 'cambio')}`];
  }
  const ICONO_EVENTO = { creado: 'creado', estado: 'estado', nota: 'msg', destinatarios: 'usuarios' };

  function seccionHistorial(t) {
    const caja = seccion('Historial', 'historial');
    const eventos = [...(t.historial || [])].sort((a, b) => tiempo(b.fecha) - tiempo(a.fecha));
    if (!eventos.length) { caja.append(el('div', 'ayuda', 'Sin movimientos.')); return caja; }
    const ul = el('ul', 'hist');
    ul.replaceChildren(...eventos.map(h => {
      const [frase, nota] = describirEvento(h);
      const li = el('li');
      const tipo = ICONO_EVENTO[h.tipo] ? h.tipo : 'creado';
      li.innerHTML = `<span class="hi h-${tipo}">${ico(ICONO_EVENTO[tipo])}</span>`;
      const cuerpo = el('div', 'min-w-0 flex-1 pt-1');
      const linea = el('div', 'leading-snug');
      linea.innerHTML = frase;
      cuerpo.append(linea, el('div', 'cuando', `${fecha(h.fecha)} · ${haceCuanto(h.fecha)}`));
      if (nota != null) cuerpo.append(el('div', 'burbuja texto-libre', nota));
      li.append(cuerpo);
      return li;
    }));
    caja.append(ul);
    return caja;
  }

  // ── Eventos ─────────────────────────────────────────────────────────────────
  function enlazarDialogo(dlg, alCerrar) {
    dlg.querySelectorAll('[data-cerrar]').forEach(b => b.addEventListener('click', () => dlg.close()));
    // Clic en el fondo (fuera del contenido): el target es el propio <dialog>.
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener('close', alCerrar);
  }

  function enlazarFormulario() {
    $('#form').addEventListener('submit', crearTicket);
    ['input', 'change'].forEach(tipo => $('#form').addEventListener(tipo, revalidar));
    $('#fLimpiar').addEventListener('click', limpiarFormulario);
    $('#fArea').addEventListener('change', () => {
      const otra = $('#fArea').value === OTRA;
      $('#fAreaOtra').classList.toggle('hidden', !otra);
      if (otra) $('#fAreaOtra').focus();
    });
    $('#fTarea').addEventListener('input', () => { $('#fTareaCont').textContent = String($('#fTarea').value.length); });
    $('#fDesc').addEventListener('input', () => { $('#fDescCont').textContent = String($('#fDesc').value.length); });
    // Cerrar sin crear conserva lo tipeado: al reabrir sigue ahí.
    enlazarDialogo($('#dlgNuevo'), () => devolverFoco(null));
  }

  function enlazarSeguimiento() {
    ['#flArea', '#flDest', '#flMios'].forEach(s => $(s).addEventListener('change', pintarSeguimiento));
    $('#flBuscar').addEventListener('input', pintarSeguimiento);
    $('#estados').addEventListener('click', e => { const b = e.target.closest('[data-filtro-estado]'); if (b) filtrarPorEstado(b.dataset.filtroEstado); });
    $('#flPrioridad').addEventListener('click', e => {
      const b = e.target.closest('[data-prioridad]');
      if (b) { estado.filtroPrioridad = b.dataset.prioridad; pintarSeguimiento(); }
    });
    document.querySelectorAll('[data-vista]').forEach(b => b.addEventListener('click', () => cambiarVista(b.dataset.vista)));
    document.querySelectorAll('th.sortable').forEach(th => th.addEventListener('click', () => cambiarOrden(th.dataset.col)));
    // Abrir detalle: clic o Enter/Espacio en una tarjeta o fila (el select de estado no abre el detalle).
    ['#tablero', '#cuerpo'].forEach(s => {
      $(s).addEventListener('click', e => {
        if (e.target.closest('select')) return;
        const item = e.target.closest('[data-id]');
        if (item) abrirDetalle(item.dataset.id);
      });
      $(s).addEventListener('keydown', e => {
        const item = e.target.closest('[data-id]');
        if (item && e.target === item && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); abrirDetalle(item.dataset.id); }
      });
    });
    enlazarArrastre();
  }

  function enlazarGenerales() {
    // Sin tickets cargados (falló el arranque) se recarga la página entera.
    $('#btnRecargar').addEventListener('click', () => { if (!estado.cargado) { location.reload(); return; } ocultarAviso(); cargarTickets(); });
    $('#btnNuevo').addEventListener('click', abrirNuevo);
    document.addEventListener('click', e => {
      const b = e.target.closest('[data-accion]');
      if (b && b.dataset.accion === 'nuevo') abrirNuevo();
      if (b && b.dataset.accion === 'limpiar-filtros') limpiarFiltros();
    });
    // Selects de estado de la lista y del detalle: delegado en document.
    document.addEventListener('change', e => { if (e.target.matches('select[data-estado-id]')) moverEstado(e.target.dataset.estadoId, e.target.value); });
    enlazarDialogo($('#dlgDetalle'), alCerrarDetalle);
  }

  function pintarYo() {
    const m = estado.meta;
    if (!m.yo && !m.yoNombre) return;
    $('#yo').innerHTML = `${m.yo ? avatar(m.yo, '', true) : ''}<span>${esc(m.yoNombre || nombreDe(m.yo))}</span>`;
  }

  // ── Arranque ────────────────────────────────────────────────────────────────
  async function cargarMeta() {
    try {
      const m = await api('/api/tickets/meta');
      estado.meta = { ...META_RESPALDO, ...m };
      estado.metaOk = true;
    } catch (e) {
      mostrarAviso('error', `${e.message} Se muestran los tickets, pero no se pueden crear ni cambiar destinatarios hasta que vuelva la conexión.`);
      $('#btnNuevo').disabled = true;
      $('#btnNuevo').title = 'No disponible: no se pudieron traer los usuarios de SIGA';
    }
    // Sin SIGA no se sabe el permiso: el aviso de error ya explica qué no se puede hacer.
    $('#avisoPermiso').classList.toggle('hidden', !estado.metaOk || puedeGestionar());
    $('#avisoPermiso').insertAdjacentHTML('afterbegin', ico('candado', 'ico w-3.5 h-3.5'));
  }

  async function iniciar() {
    try { if (localStorage.getItem(CLAVE_VISTA) === 'lista') estado.vista = 'lista'; } catch (_) { /* sin storage: vista default */ }
    cambiarVista(estado.vista);
    pintarCargando();
    enlazarGenerales();
    await cargarMeta();
    pintarYo();
    armarFormulario();
    armarFiltros();
    enlazarFormulario();
    enlazarSeguimiento();
    await cargarTickets();
  }

  iniciar();
})();
