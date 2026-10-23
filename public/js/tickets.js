'use strict';
// Pantalla "Tickets de Desarrollo" (/tickets). Seguimiento en tablero (kanban por estado, con drag & drop) o lista;
// alta en un diálogo modal y detalle en un panel lateral (<dialog> nativo: foco atrapado, Esc y fondo inerte).
// Todo lo que viene del servidor o lo tipeó un usuario (tarea, descripción, área, notas, nombres) se pinta con
// textContent o pasa por esc() antes de ir a innerHTML. Sin alert/confirm: los errores van a #aviso (role=alert).
// La misma pantalla sirve a Mantenimiento de sucursales (/sucursales/mantenimiento): CFG sale de la URL y fija la
// api, los textos y el prefijo de las claves de localStorage (así cada instancia guarda lo suyo).
(() => {
  const $ = sel => document.querySelector(sel);
  const CONFIGS = {
    '/sucursales/mantenimiento': {
      api: '/api/sucursales/mantenimiento', titulo: 'Mantenimiento de Sucursales', tituloCorto: 'Mantenimiento',
      bajada: 'Pedidos de mantenimiento de las sucursales', permisoTitulo: 'Mantenimiento · Gestión', clave: 'mantenimiento',
      volver: '/sucursales', volverTexto: '← Sucursales',
    },
  };
  const CFG = CONFIGS[location.pathname.replace(/\/+$/, '').toLowerCase()] || {
    api: '/api/tickets', titulo: 'Tickets de Desarrollo', tituloCorto: 'Tickets', permisoTitulo: 'Tickets · Gestión', clave: 'tickets',
  };
  if (CFG.clave !== 'tickets') {
    // El html es el de tickets: se reescriben título, encabezado, aviso de permiso y el link de vuelta.
    document.title = `${CFG.titulo} · Apidelta`;
    $('h1').textContent = CFG.titulo.toUpperCase();
    $('#bajada').textContent = CFG.bajada;
    $('#avisoPermiso').textContent = `Solo lectura de estados · pedí el permiso ${CFG.permisoTitulo}`;
    $('#lnkVolver').href = CFG.volver;
    $('#lnkVolver').textContent = CFG.volverTexto;
  }
  // Puntero principal táctil (teléfono/tablet): ahí las tarjetas no se arrastran (compite con el scroll); el estado se cambia desde el detalle.
  const esTactil = () => window.matchMedia('(pointer: coarse)').matches;
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
  const CLAVE_VISTA = `${CFG.clave}.vista`;
  // Novedades (ver sondear): cada cuánto se consulta la lista, cuánto dura un aviso y cuántos se apilan.
  const SONDEO_MS = 15000; // pestaña visible
  const SONDEO_OCULTA_MS = 60000; // pestaña en segundo plano
  const AVISO_MS = 6000;
  const MAX_TOASTS = 3;
  const CLAVE_VISTOS = `${CFG.clave}.vistos`; // + login: { id: actualizadoEn } que ya vio
  const CLAVE_ESCRITORIO = `${CFG.clave}.avisosEscritorio`;
  const TITULO = document.title;
  const FMT_FECHA = new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  // ponytail: copia de lib/tickets.js, sólo para seguir mostrando tickets si /meta responde 503 (SIGA caído).
  const META_RESPALDO = {
    prioridades: [{ valor: 'baja', etiqueta: 'Baja' }, { valor: 'media', etiqueta: 'Media' }, { valor: 'alta', etiqueta: 'Alta' }, { valor: 'urgente', etiqueta: 'Urgente' }],
    estados: [{ valor: 'pendiente', etiqueta: 'Pendiente' }, { valor: 'en_proceso', etiqueta: 'En proceso' }, { valor: 'falta_aprobacion', etiqueta: 'Falta aprobación' },
      { valor: 'stand_by', etiqueta: 'Stand by' }, { valor: 'terminado', etiqueta: 'Terminado' }, { valor: 'cancelado', etiqueta: 'Cancelado' }],
    estadosEtapa: [{ valor: 'pendiente', etiqueta: 'Pendiente' }, { valor: 'en_proceso', etiqueta: 'En proceso' }, { valor: 'terminado', etiqueta: 'Terminado' }],
    areas: [], usuarios: [], yo: null, yoNombre: null, login: null, puedeGestionar: false,
  };
  const SIN_PERMISO = `Necesitás el permiso ${CFG.permisoTitulo}`;
  const SOLO_CREADOR_PRI = `La cambia quien creó el ticket o quien tenga el permiso ${CFG.permisoTitulo}`;
  const REQUIEREN_ETAPAS = ['falta_aprobacion', 'terminado']; // estados del ticket que piden todas las etapas terminadas
  const MAX_DEST = 20; // topes de lib/tickets.js
  const MAX_DEST_LARGO = 60;
  const MAX_ETAPA = 120;
  const EXTERNO = 'Externo (no es usuario de SIGA)';
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
    etapa: '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
    lapiz: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
    papelera: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
    externo: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    mas: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    bandera: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
    campana: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  };
  const ico = (nombre, clase = 'ico') => `<svg class="${clase}" viewBox="0 0 24 24" aria-hidden="true">${ICONOS[nombre]}</svg>`;

  const estado = {
    meta: META_RESPALDO, metaOk: false, tickets: [], cargado: false,
    vista: 'tablero',
    filtroEstado: ACTIVOS, filtroPrioridad: TODOS,
    orden: { col: null, dir: 1 }, // col null = orden default (prioridad desc, creadoEn asc)
    abierto: null, // id del ticket del panel de detalle
    // Edición sin guardar del detalle, sobrevive a los repintados:
    // { id, dest: [..] | null, nota, etapaNueva, etapaEdit: { id, valor } | null, etapaBorrar: id | null, etapaOcupada }
    borrador: null,
    focoDetalle: null, // id del control a enfocar en el próximo pintarDetalle (una sola vez)
    guardando: new Set(), // ids con un cambio de estado en vuelo
  };
  let selectorNuevo = null;
  let focoPrevio = null;
  // Sondeo: un cambio propio en vuelo (enVuelo) o que respondió durante un sondeo (versionLocal) deja vieja esa foto.
  let timerSondeo = null;
  let sondeando = false;
  let arrastrando = false;
  let sondeoPendiente = false; // tocaba sondear con un drag en curso: se consulta al soltar
  let enVuelo = 0;
  let versionLocal = 0;
  let vistos = null; // { id: actualizadoEn } que este usuario ya vio (localStorage)
  let prefEscritorio = false;

  // ── Utilidades ──────────────────────────────────────────────────────────────
  async function api(url, opciones) {
    let r;
    try {
      r = await fetch(url, opciones);
    } catch (_) {
      throw Object.assign(new Error('No se pudo conectar con el servidor. Revisá la red y probá de nuevo.'), { red: true });
    }
    const datos = await r.json().catch(() => null);
    if (r.status === 401) throw new Error('La sesión venció: volvé a iniciar sesión.');
    if (!r.ok) throw new Error((datos && datos.error) || `Error del servidor (${r.status}).`);
    return datos;
  }
  // Todo cambio propio pasa por acá: mientras hay uno en vuelo el sondeo no pisa la lista.
  async function enviarJSON(metodo, url, cuerpo) {
    enVuelo += 1;
    try {
      return await api(url, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
    } finally {
      enVuelo -= 1;
      versionLocal += 1;
    }
  }

  const ICONO_AVISO = { ok: 'check', info: 'historial', error: 'alerta' };
  function mostrarAviso(tono, texto, destino = '#aviso') {
    const caja = $(destino);
    if (!caja) return;
    const clase = ICONO_AVISO[tono] ? tono : 'error';
    caja.className = `${clase} ${destino === '#aviso' ? 'mb-4' : 'mx-6 mt-4'}`;
    caja.innerHTML = ico(ICONO_AVISO[clase], 'ico mt-0.5');
    caja.append(el('span', null, texto));
  }
  function ocultarAviso(destino = '#aviso') {
    const caja = $(destino);
    if (caja) { caja.className = 'hidden'; caja.textContent = ''; }
  }
  const avisoActual = () => (estado.abierto != null ? '#dAviso' : '#aviso');

  // Avisos apilados abajo a la derecha (máx. MAX_TOASTS, se van solos). Con `id` es un botón que abre el ticket.
  function agregarToast({ texto, icono = 'check', destacado = false, urgente = false, id = null, ms = TOAST_MS }) {
    const caja = $('#toasts');
    const t = el(id != null ? 'button' : 'div', `tst${destacado ? ' tst-mio' : ''}${urgente ? ' tst-urg' : ''}`);
    if (id != null) {
      t.type = 'button';
      t.title = 'Abrir el ticket';
      t.addEventListener('click', () => { t.remove(); abrirDesdeAviso(id); });
    }
    t.innerHTML = ico(icono);
    t.append(el('span', null, texto));
    caja.append(t);
    while (caja.children.length > MAX_TOASTS) caja.firstElementChild.remove();
    setTimeout(() => t.remove(), ms);
  }
  const mostrarToast = texto => agregarToast({ texto });

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
  const etapasDe = t => (Array.isArray(t.etapas) ? t.etapas : []);
  const abiertasDe = t => etapasDe(t).filter(e => e.estado !== 'terminado').length;
  const faltanTexto = n => (n === 1 ? 'falta 1 etapa' : `faltan ${n} etapas`);
  // Destinatario que no es usuario de SIGA (nombre libre). Sin meta (SIGA caído) no se sabe: no se marca.
  const esExterno = u => estado.metaOk && !usuarioMeta(u);
  // Espejo de lo que valida el server: estados sólo con 'tickets-gestion'; destinatarios y prioridad también el creador.
  const puedeGestionar = () => estado.meta.puedeGestionar === true;
  const puedeEditarTicket = t => puedeGestionar() || mismoUsuario(t.creadoPor, estado.meta.login);

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
    const ext = esExterno(u);
    const [bg, fg] = tono(u);
    const leyenda = ext ? `${nombre} (externo)` : nombre;
    const a11y = decorativo ? 'aria-hidden="true"' : `role="img" aria-label="${esc(leyenda)}" title="${esc(leyenda)}"`;
    return `<span class="av ${ext ? 'av-ext ' : ''}${clase}" style="background:${bg};color:${fg}" ${a11y}>${esc(iniciales(nombre))}</span>`;
  }
  function pilaAvatares(lista) {
    const dest = comoLista(lista);
    if (!dest.length) return '<span class="text-gris text-xs">Sin asignar</span>';
    const resto = dest.slice(MAX_AVATARES);
    const mas = resto.length
      ? `<span class="av av-mas" title="${esc(resto.map(nombreDe).join(', '))}" role="img" aria-label="y ${resto.length} más">+${resto.length}</span>` : '';
    return `<span class="pila">${dest.slice(0, MAX_AVATARES).map(u => avatar(u)).join('')}${mas}</span>`;
  }

  const badgePrioridad = (p, title = '') => `<span class="badge-p p-${esc(p)}"${title ? ` title="${esc(title)}"` : ''}>${esc(etiqueta('prioridades', p))}</span>`;
  const badgeEstado = (v, lista = 'estados') => `<span class="inline-flex items-center gap-1.5 font-semibold e-${esc(v)}" style="color:var(--e-fg)"><span class="dot"></span>${esc(etiqueta(lista, v))}</span>`;
  // Con etapas abiertas, Falta aprobación y Terminado no se eligen a mano (el server también lo rechaza).
  function selectEstado(t, id) {
    const faltan = abiertasDe(t);
    const ops = estado.meta.estados.map(e => {
      const bloq = faltan > 0 && REQUIEREN_ETAPAS.includes(e.valor) && e.valor !== t.estado;
      return `<option value="${esc(e.valor)}"${e.valor === t.estado ? ' selected' : ''}${bloq ? ' disabled' : ''}>${esc(e.etiqueta)}${bloq ? ` (${faltanTexto(faltan)})` : ''}</option>`;
    }).join('');
    const bloqueo = puedeGestionar() ? '' : ` disabled title="${esc(SIN_PERMISO)}" aria-description="${esc(SIN_PERMISO)}"`;
    return `<select class="sel-estado e-${esc(t.estado)}"${id ? ` id="${id}"` : ''} data-estado-id="${esc(t.id)}" aria-label="Estado del ticket #${esc(t.id)}"${bloqueo}>${ops}</select>`;
  }

  // Prioridad editable (detalle y lista) para el creador o quien gestiona; si no, el badge con el porqué en el title.
  function controlPrioridad(t, id) {
    if (!estado.metaOk) return badgePrioridad(t.prioridad);
    if (!puedeEditarTicket(t)) return badgePrioridad(t.prioridad, SOLO_CREADOR_PRI);
    const ops = estado.meta.prioridades.map(p => `<option value="${esc(p.valor)}"${p.valor === t.prioridad ? ' selected' : ''}>${esc(p.etiqueta)}</option>`).join('');
    return `<select class="sel-estado sel-pri p-${esc(t.prioridad)}"${id ? ` id="${id}"` : ''} data-prioridad-id="${esc(t.id)}" aria-label="Prioridad del ticket #${esc(t.id)}">${ops}</select>`;
  }

  // ── Selector de destinatarios (alta y detalle): chips + campo con autocompletado (combobox ARIA) ──
  // Tipeás → sugerencias de usuarios de SIGA (nombre o Id); lo que no es nadie de SIGA se agrega como persona
  // externa (nombre libre). Flechas/Enter eligen, Esc cierra la lista, Backspace con el campo vacío quita el último chip.
  // `id` fijo por pantalla: pintarDetalle devuelve el foco por id después de repintar.
  function chipDestinatario(u, alQuitar) {
    const ext = esExterno(u);
    const c = el('span', `chip-u${ext ? ' ext' : ''}`);
    c.innerHTML = ext ? `<span class="av av-ext-ico" aria-hidden="true">${ico('externo')}</span>` : avatar(u, '', true);
    c.append(el('span', null, nombreDe(u)));
    if (ext) { c.title = EXTERNO; c.append(el('span', 'sr-only', ' (externo, no es usuario de SIGA)')); }
    if (!alQuitar) return c;
    const quitar = el('button');
    quitar.type = 'button';
    quitar.innerHTML = ico('x');
    quitar.setAttribute('aria-label', `Quitar a ${nombreDe(u)}`);
    quitar.addEventListener('click', () => alQuitar(u));
    c.append(quitar);
    return c;
  }

  function crearSelectorUsuarios(raiz, { id = 'selU', seleccion: inicial = [], alCambiar = null, soloLectura = false } = {}) {
    let seleccion = [...inicial];
    let opciones = []; // [{ tipo: 'siga' | 'externo', valor, nombre }]
    let activa = -1;
    let abierta = false; // false tras Esc/blur/elegir: ni sugerencias ni "sin coincidencias"
    const caja = el('div', 'sel-u');
    const campo = el('div', 'cbx');
    const input = el('input', 'cbx-in');
    const lista = el('ul', 'cbx-lista hidden');
    lista.id = `${id}-lista`;
    lista.setAttribute('role', 'listbox');
    lista.setAttribute('aria-label', 'Sugerencias de destinatarios');
    Object.assign(input, { type: 'text', id: `${id}-campo`, maxLength: MAX_DEST_LARGO, autocomplete: 'off', spellcheck: false });
    [['role', 'combobox'], ['aria-autocomplete', 'list'], ['aria-expanded', 'false'], ['aria-controls', lista.id],
      ['aria-label', 'Agregar destinatario: usuario de SIGA o nombre de una persona externa']].forEach(([k, v]) => input.setAttribute(k, v));

    const yaEsta = v => seleccion.some(x => mismoUsuario(x, v));
    const cambiar = nueva => { seleccion = nueva; pintarChips(); if (alCambiar) alCambiar([...seleccion]); };
    function agregar(v) {
      if (!v || yaEsta(v) || seleccion.length >= MAX_DEST) return;
      input.value = '';
      cerrar();
      cambiar([...seleccion, v]);
    }
    const quitar = u => { cambiar(seleccion.filter(x => x !== u)); input.focus(); };

    // Usuarios de SIGA no elegidos que coinciden + "agregar como externo" si lo tipeado no es exactamente nadie de SIGA.
    function calcular() {
      const q = input.value.trim();
      const ql = q.toLowerCase();
      const usuarios = estado.meta.usuarios || [];
      const ops = usuarios.filter(u => !yaEsta(u.usuario) && (!ql || `${u.nombre} ${u.usuario}`.toLowerCase().includes(ql)))
        .map(u => ({ tipo: 'siga', valor: u.usuario, nombre: u.nombre || u.usuario }));
      const exacto = usuarios.some(u => mismoUsuario(u.usuario, q) || mismoUsuario(u.nombre, q));
      if (q && !exacto && !yaEsta(q)) ops.push({ tipo: 'externo', valor: q, nombre: q });
      return ops;
    }
    function abrir() {
      if (seleccion.length >= MAX_DEST) return;
      abierta = true;
      opciones = calcular();
      activa = opciones.length ? 0 : -1;
      pintarLista();
    }
    function cerrar() { abierta = false; opciones = []; activa = -1; pintarLista(); }
    function opcion(o, i) {
      const li = el('li', `cbx-op${o.tipo === 'externo' ? ' ext' : ''}`);
      li.id = `${id}-op${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === activa));
      if (o.tipo === 'siga') {
        li.innerHTML = avatar(o.valor, '', true);
        li.append(el('span', 'n', o.nombre), el('span', 'u', o.valor));
      } else {
        li.innerHTML = `<span class="av av-ext-ico" aria-hidden="true">${ico('mas')}</span>`;
        li.append(el('span', 'n', `Agregar «${o.valor}» como persona externa`));
      }
      li.addEventListener('mousedown', e => e.preventDefault()); // el foco se queda en el campo
      li.addEventListener('click', () => agregar(o.valor));
      return li;
    }
    function pintarLista() {
      const q = input.value.trim();
      const items = opciones.map(opcion);
      if (!items.length && q && abierta) {
        items.push(el('li', 'cbx-vacio', yaEsta(q) ? `«${q}» ya está en la lista.` : 'Sin coincidencias.'));
      }
      const recienAbierta = items.length > 0 && lista.classList.contains('hidden');
      lista.replaceChildren(...items);
      lista.classList.toggle('hidden', !items.length);
      if (recienAbierta) lista.scrollIntoView({ block: 'nearest' }); // dentro del form con scroll, que se vea entera
      input.setAttribute('aria-expanded', String(opciones.length > 0));
      if (activa >= 0) {
        input.setAttribute('aria-activedescendant', `${id}-op${activa}`);
        lista.children[activa].scrollIntoView({ block: 'nearest' });
      } else input.removeAttribute('aria-activedescendant');
    }
    function mover(paso) {
      if (!opciones.length) { abrir(); return; }
      activa = (activa + paso + opciones.length) % opciones.length;
      pintarLista();
    }

    input.addEventListener('input', abrir);
    input.addEventListener('blur', cerrar);
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); mover(e.key === 'ArrowDown' ? 1 : -1); }
      else if (e.key === 'Enter') { e.preventDefault(); if (activa >= 0) agregar(opciones[activa].valor); } // Enter nunca manda el form
      else if (e.key === 'Escape' && !lista.classList.contains('hidden')) { e.preventDefault(); e.stopPropagation(); cerrar(); }
      else if (e.key === 'Backspace' && !input.value && seleccion.length) cambiar(seleccion.slice(0, -1));
    });
    campo.addEventListener('click', e => { if (e.target === campo) input.focus(); });

    // Los chips van en su propio contenedor (display:contents) para no sacar del DOM al campo con foco.
    const chips = el('span', 'cbx-chips');
    function pintarChips() {
      const lista = seleccion.map(u => chipDestinatario(u, soloLectura ? null : quitar));
      chips.replaceChildren(...(lista.length || !soloLectura ? lista : [el('span', 'ayuda', 'Sin destinatarios.')]));
      if (soloLectura) return;
      const lleno = seleccion.length >= MAX_DEST;
      input.disabled = lleno;
      input.placeholder = lleno ? `Máximo ${MAX_DEST} destinatarios` : (seleccion.length ? 'Agregar otro…' : 'Escribí un nombre o usuario de SIGA…');
    }

    campo.append(chips);
    if (!soloLectura) campo.append(input);
    caja.append(campo);
    if (!soloLectura) caja.append(lista);
    raiz.replaceChildren(caja);
    pintarChips();
    return {
      valor: () => [...seleccion],
      reiniciar: v => { input.value = ''; cerrar(); cambiar([...v]); },
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
    selectorNuevo = crearSelectorUsuarios($('#fDest'), { id: 'fDest', alCambiar: revalidar });
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
      const t = await enviarJSON('POST', CFG.api, datos);
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

  // Áreas y destinatarios: los de meta + los que aparezcan en los tickets (áreas "Otra", externos, usuarios dados de baja).
  function armarFiltrosDinamicos() {
    const ordenar = v => [...new Set(v.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'es'));
    const areas = ordenar([...estado.meta.areas, ...estado.tickets.map(t => t.area)]);
    rellenarSelect('#flArea', areas.map(a => [a, a]), 'Todas las áreas');
    const conocidos = (estado.meta.usuarios || []).map(u => u.usuario);
    const extra = estado.tickets.flatMap(t => comoLista(t.destinatarios))
      .reduce((acc, u) => ([...conocidos, ...acc].some(c => mismoUsuario(c, u)) ? acc : [...acc, u]), []);
    const dest = [...conocidos, ...extra].map(u => [u, `${nombreDe(u)}${esExterno(u) ? ' (externo)' : ''}`])
      .sort((a, b) => a[1].localeCompare(b[1], 'es'));
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
    if ($('#flDest').value && !dest.some(u => mismoUsuario(u, $('#flDest').value))) return false;
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

  // Mini barra "2/4" de etapas terminadas (tarjeta y fila); vacío si el ticket no tiene etapas.
  function miniProgreso(t) {
    const total = etapasDe(t).length;
    if (!total) return '';
    const hechas = total - abiertasDe(t);
    const txt = `${hechas} de ${total} etapas terminadas`;
    return `<span class="mini-prog${hechas === total ? ' ok' : ''}" role="img" aria-label="${txt}" title="${txt}">`
      + `<span class="mp-barra" aria-hidden="true"><i style="width:${Math.round((hechas * 100) / total)}%"></i></span>`
      + `<span aria-hidden="true">${hechas}/${total}</span></span>`;
  }

  // ── Tablero ─────────────────────────────────────────────────────────────────
  function tarjeta(t) {
    const notas = notasDe(t);
    const mover = puedeGestionar() && !esTactil();
    const nl = noLeido(t);
    const clases = `tarjeta p-${esc(t.prioridad)} e-${esc(t.estado)}${estado.guardando.has(String(t.id)) ? ' guardando' : ''}${mover ? '' : ' fija'}${nl ? ' no-leido' : ''}`;
    return `<article class="${clases}" draggable="${mover}" tabindex="0" data-id="${esc(t.id)}"
      aria-label="${nl ? 'Con novedades. ' : ''}Ticket #${esc(t.id)}: ${esc(t.tarea)}. Prioridad ${esc(etiqueta('prioridades', t.prioridad))}, ${esc(etiqueta('estados', t.estado))}.">
      <div class="fila1">${nl ? '<span class="pto-nl" title="Novedades desde que lo viste"></span>' : ''}<span class="num">#${esc(t.id)}</span>${badgePrioridad(t.prioridad)}
        <span class="ml-auto" title="Creado el ${esc(fecha(t.creadoEn))}">${esc(haceCuanto(t.creadoEn))}</span></div>
      <div class="tit">${esc(t.tarea)}</div>
      <div class="fila3">${t.area ? `<span class="tag-area" title="${esc(t.area)}">${esc(t.area)}</span>` : ''}
        <div class="meta">${miniProgreso(t)}${notas ? `<span title="${notas} nota${notas === 1 ? '' : 's'}">${ico('msg')}${notas}</span>` : ''}${pilaAvatares(t.destinatarios)}</div></div>
    </article>`;
  }

  function columna(e, tickets) {
    const cuerpo = tickets.length ? tickets.map(tarjeta).join('') : `<div class="col-vacia">${puedeGestionar() && !esTactil() ? 'Soltá un ticket acá' : 'Sin tickets'}</div>`;
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
  // Una columna que pide etapas terminadas (con etapas abiertas en el ticket arrastrado) se pinta en rojo; si se suelta
  // igual, moverEstado avisa y no manda nada.
  function enlazarArrastre() {
    const tab = $('#tablero');
    let arrastrado = null;
    const limpiarSobre = () => tab.querySelectorAll('.col.sobre').forEach(c => c.classList.remove('sobre', 'sobre-no'));
    tab.addEventListener('dragstart', e => {
      const card = e.target.closest('.tarjeta');
      if (!card) return;
      if (!puedeGestionar()) { e.preventDefault(); return; }
      arrastrando = true;
      arrastrado = buscarTicket(card.dataset.id);
      e.dataTransfer.setData('text/plain', card.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      requestAnimationFrame(() => card.classList.add('arrastrando'));
    });
    tab.addEventListener('dragend', e => { e.target.closest('.tarjeta')?.classList.remove('arrastrando'); limpiarSobre(); arrastrado = null; finArrastre(); });
    tab.addEventListener('dragover', e => {
      const col = e.target.closest('.col');
      if (!col || !puedeGestionar()) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!col.classList.contains('sobre')) {
        limpiarSobre();
        const bloq = arrastrado && abiertasDe(arrastrado) > 0 && REQUIEREN_ETAPAS.includes(col.dataset.estado) && arrastrado.estado !== col.dataset.estado;
        col.classList.add('sobre', ...(bloq ? ['sobre-no'] : []));
      }
    });
    tab.addEventListener('dragleave', e => {
      const col = e.target.closest('.col');
      if (col && !col.contains(e.relatedTarget)) col.classList.remove('sobre', 'sobre-no');
    });
    tab.addEventListener('drop', e => {
      const col = e.target.closest('.col');
      if (!col || !puedeGestionar()) return;
      e.preventDefault();
      limpiarSobre();
      moverEstado(e.dataTransfer.getData('text/plain'), col.dataset.estado);
      finArrastre(); // moverEstado repinta: la tarjeta original sale del DOM y su dragend ya no llega al tablero
    });
  }
  function finArrastre() {
    arrastrando = false;
    if (sondeoPendiente) { sondeoPendiente = false; sondear(); }
  }

  // ── Lista ───────────────────────────────────────────────────────────────────
  function filaTicket(t) {
    const nl = noLeido(t);
    return `<tr data-id="${esc(t.id)}" tabindex="0" class="e-${esc(t.estado)}${nl ? ' no-leido' : ''}">
      <td class="num text-gris pri p-${esc(t.prioridad)}">${nl ? '<span class="pto-nl" title="Novedades desde que lo viste"></span><span class="sr-only">Con novedades: </span>' : ''}${esc(t.id)}</td>
      <td class="tit font-semibold max-w-[420px] break-words">${esc(t.tarea)}${etapasDe(t).length ? `<div class="mt-1 font-normal">${miniProgreso(t)}</div>` : ''}</td>
      <td>${controlPrioridad(t)}</td>
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
      const lista = await api(CFG.api);
      marcarConexion(null);
      aplicarLista(Array.isArray(lista) ? lista : []);
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
    const t = await enviarJSON('PATCH', `${CFG.api}/${encodeURIComponent(id)}`, cambios);
    reemplazarTicket(id, t);
    return t;
  }

  // Cambio optimista de un campo (estado, prioridad): se ve al instante y, si falla, vuelve atrás y avisa.
  // repintarConservando: la fila puede moverse (orden por prioridad) y el foco sigue en su select.
  const ocupado = t => !t || estado.guardando.has(String(t.id));
  async function cambiarCampo(t, campo, nuevo, { destino, ok, error }) {
    reemplazarTicket(t.id, { ...t, [campo]: nuevo });
    estado.guardando.add(String(t.id));
    repintarConservando();
    try {
      await actualizar(t.id, { [campo]: nuevo });
      ocultarAviso(destino);
      mostrarToast(ok);
    } catch (e) {
      const actual = buscarTicket(t.id);
      if (actual) reemplazarTicket(t.id, { ...actual, [campo]: t[campo] });
      mostrarAviso('error', `${error}: ${e.message}`, destino);
    } finally {
      estado.guardando.delete(String(t.id));
      repintarConservando();
    }
  }

  // Estado por drag & drop o select.
  function moverEstado(id, nuevo) {
    const t = buscarTicket(id);
    if (ocupado(t) || !nuevo || t.estado === nuevo) return;
    const destino = avisoActual();
    const faltan = abiertasDe(t);
    if (faltan && REQUIEREN_ETAPAS.includes(nuevo)) {
      mostrarAviso('error', `El ticket #${t.id} no puede pasar a ${etiqueta('estados', nuevo)}: ${faltanTexto(faltan)} por terminar.`, destino);
      return;
    }
    cambiarCampo(t, 'estado', nuevo, { destino, ok: `#${t.id} pasó a ${etiqueta('estados', nuevo)}.`, error: `No se pudo cambiar el estado del ticket #${t.id}` });
  }

  function cambiarPrioridad(id, nueva) {
    const t = buscarTicket(id);
    if (ocupado(t) || !nueva || t.prioridad === nueva) return;
    cambiarCampo(t, 'prioridad', nueva, {
      destino: avisoActual(),
      ok: `Prioridad actualizada: #${t.id} ahora es ${etiqueta('prioridades', nueva)}.`,
      error: `No se pudo cambiar la prioridad del ticket #${t.id}`,
    });
  }

  // ── Panel de detalle ────────────────────────────────────────────────────────
  function abrirDetalle(id) {
    if (!buscarTicket(id)) return;
    focoPrevio = document.activeElement;
    estado.abierto = id;
    estado.borrador = { id: String(id), dest: null, nota: '', etapaNueva: '', etapaEdit: null, etapaBorrar: null, etapaOcupada: false };
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
    marcarVisto(t);
    const focoId = estado.focoDetalle || ($('#dlgDetalle').contains(document.activeElement) ? document.activeElement.id : '');
    estado.focoDetalle = null;
    $('#dCab').innerHTML = `<span class="text-sm font-semibold text-gris tabular-nums">#${esc(t.id)}</span>${controlPrioridad(t, 'dPrioridad')}${selectEstado(t, 'dEstado')}`;
    $('#dTitulo').textContent = t.tarea;
    $('#dMeta').innerHTML = `${t.area ? `<span class="tag-area">${esc(t.area)}</span>` : ''}
      <span>Creado por <b class="text-ink font-semibold">${esc(nombreDe(t.creadoPor))}</b> · ${esc(fecha(t.creadoEn))}</span>
      <span class="inline-flex items-center gap-1">${ico('reloj', 'ico w-3.5 h-3.5')}Actualizado ${esc(haceCuanto(t.actualizadoEn))}</span>`;
    $('#dCuerpo').replaceChildren(seccionDescripcion(t), seccionEtapas(t), seccionDestinatarios(t), seccionNota(t), seccionHistorial(t));
    const foco = focoId ? document.getElementById(focoId) : null;
    if (foco) { foco.focus(); if (foco.dataset.seleccionar) foco.select(); }
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

  // ── Etapas (detalle) ────────────────────────────────────────────────────────
  // Solo con 'tickets-gestion' y ticket abierto se editan; si no, solo lectura. Renombrar y eliminar viven en
  // estado.borrador (etapaEdit / etapaBorrar) para sobrevivir a los repintados; confirmación en la UI, sin confirm().
  function seccionEtapas(t) {
    const caja = seccion('Etapas', 'etapa');
    const etapas = etapasDe(t);
    const cerrado = CERRADOS.includes(t.estado);
    const editable = puedeGestionar() && !cerrado;
    if (etapas.length) {
      const hechas = etapas.length - abiertasDe(t);
      const prog = el('div', 'et-prog');
      prog.innerHTML = `<span class="et-prog-txt"><b>${hechas} de ${etapas.length}</b> terminadas</span>
        <span class="et-prog-barra" role="progressbar" aria-label="Etapas terminadas" aria-valuemin="0" aria-valuemax="${etapas.length}"
          aria-valuenow="${hechas}" aria-valuetext="${hechas} de ${etapas.length}"><i style="width:${Math.round((hechas * 100) / etapas.length)}%"></i></span>`;
      const ul = el('ul', 'etapas');
      ul.setAttribute('aria-label', 'Etapas del ticket');
      ul.replaceChildren(...etapas.map(e => filaEtapa(t, e, editable)));
      caja.append(prog, ul);
    } else {
      caja.append(el('p', 'ayuda mb-2', editable ? 'Sin etapas. Dividí el trabajo en pasos para seguir el avance.' : 'Sin etapas.'));
    }
    if (editable) caja.append(altaEtapa(t));
    else if (cerrado && puedeGestionar()) caja.append(el('p', 'ayuda', `El ticket está ${etiqueta('estados', t.estado).toLowerCase()}: las etapas son de solo lectura.`));
    else if (!puedeGestionar() && estado.metaOk) caja.append(el('p', 'ayuda', `Las etapas las gestiona quien tenga el permiso ${CFG.permisoTitulo}.`));
    if (estado.borrador.etapaOcupada) caja.querySelectorAll('button, select, input').forEach(c => { c.disabled = true; });
    return caja;
  }

  function botonIco(icono, etiquetaA11y, id, alClic) {
    const b = el('button', 'btn-ico');
    b.type = 'button';
    b.id = id;
    b.innerHTML = ico(icono);
    b.title = etiquetaA11y;
    b.setAttribute('aria-label', etiquetaA11y);
    b.addEventListener('click', alClic);
    return b;
  }
  function boton(texto, clase, id, alClic) {
    const b = el('button', `btn btn-sm ${clase}`, texto);
    b.type = 'button';
    b.id = id;
    b.addEventListener('click', alClic);
    return b;
  }

  function filaEtapa(t, e, editable) {
    const li = el('li', `etapa e-${e.estado}`);
    const b = estado.borrador;
    if (editable) {
      const sel = el('select', `sel-estado e-${e.estado}`);
      sel.id = `dEtEst-${e.id}`;
      sel.setAttribute('aria-label', `Estado de la etapa ${e.nombre}`);
      sel.innerHTML = estado.meta.estadosEtapa.map(o => `<option value="${esc(o.valor)}"${o.valor === e.estado ? ' selected' : ''}>${esc(o.etiqueta)}</option>`).join('');
      sel.addEventListener('change', () => operarEtapa(t.id, 'PATCH', e.id, { estado: sel.value }, { foco: sel.id, ok: 'Etapa actualizada.' }));
      li.append(sel);
    } else {
      li.insertAdjacentHTML('beforeend', `<span class="et-badge e-${esc(e.estado)}">${esc(etiqueta('estadosEtapa', e.estado))}</span>`);
    }
    if (editable && b.etapaEdit && b.etapaEdit.id === e.id) { li.append(...edicionEtapa(t, e)); return li; }
    const nombre = el('span', 'et-nombre', e.nombre);
    li.append(nombre);
    if (!editable) return li;
    nombre.title = 'Doble clic para renombrar';
    nombre.addEventListener('dblclick', () => editarEtapa(e));
    const acc = el('span', 'et-acc');
    if (b.etapaBorrar === e.id) {
      acc.className = 'et-confirm';
      acc.setAttribute('role', 'group');
      acc.setAttribute('aria-label', `Confirmar eliminación de la etapa ${e.nombre}`);
      acc.append(el('span', null, '¿Eliminar?'),
        boton('Sí', 'btn-peligro', `dEtSi-${e.id}`, () => operarEtapa(t.id, 'DELETE', e.id, null,
          { foco: 'dEtNueva', ok: 'Etapa eliminada.', alOk: () => { estado.borrador.etapaBorrar = null; } })),
        boton('No', '', `dEtNo-${e.id}`, () => pedirBorrar(null, `dEtDel-${e.id}`)));
      acc.addEventListener('keydown', ev => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); pedirBorrar(null, `dEtDel-${e.id}`); } });
    } else {
      acc.append(botonIco('lapiz', `Renombrar etapa ${e.nombre}`, `dEtRen-${e.id}`, () => editarEtapa(e)),
        botonIco('papelera', `Eliminar etapa ${e.nombre}`, `dEtDel-${e.id}`, () => pedirBorrar(e.id, `dEtNo-${e.id}`)));
    }
    li.append(acc);
    return li;
  }

  // Campo de renombrar + Guardar/Cancelar (Enter guarda, Esc cancela sin cerrar el panel).
  function edicionEtapa(t, e) {
    const b = estado.borrador;
    const inp = el('input', 'ctl ctl-sm et-input');
    Object.assign(inp, { id: `dEtNombre-${e.id}`, maxLength: MAX_ETAPA, value: b.etapaEdit.valor });
    inp.dataset.seleccionar = '1';
    inp.setAttribute('aria-label', `Nuevo nombre de la etapa ${e.nombre}`);
    const cancelar = () => { b.etapaEdit = null; estado.focoDetalle = `dEtRen-${e.id}`; ocultarAviso('#dAviso'); pintarDetalle(); };
    const guardar = () => {
      const nombre = inp.value.trim();
      if (!nombre) { inp.setAttribute('aria-invalid', 'true'); mostrarAviso('error', 'El nombre de la etapa no puede quedar vacío.', '#dAviso'); inp.focus(); return; }
      if (nombre === e.nombre) { cancelar(); return; }
      operarEtapa(t.id, 'PATCH', e.id, { nombre }, { foco: `dEtRen-${e.id}`, ok: 'Etapa renombrada.', alOk: () => { estado.borrador.etapaEdit = null; } });
    };
    inp.addEventListener('input', () => { b.etapaEdit.valor = inp.value; inp.removeAttribute('aria-invalid'); });
    inp.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); guardar(); }
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cancelar(); }
    });
    const acc = el('span', 'flex gap-1.5');
    acc.append(boton('Guardar', 'btn-primario', `dEtGuardar-${e.id}`, guardar), boton('Cancelar', '', `dEtCancelar-${e.id}`, cancelar));
    return [inp, acc];
  }

  function editarEtapa(e) {
    Object.assign(estado.borrador, { etapaEdit: { id: e.id, valor: e.nombre }, etapaBorrar: null });
    estado.focoDetalle = `dEtNombre-${e.id}`;
    pintarDetalle();
  }
  function pedirBorrar(etapaId, foco) {
    Object.assign(estado.borrador, { etapaBorrar: etapaId, etapaEdit: null });
    estado.focoDetalle = foco;
    pintarDetalle();
  }

  function altaEtapa(t) {
    const fila = el('div', 'et-alta');
    const inp = el('input', 'ctl flex-1 min-w-0');
    Object.assign(inp, { id: 'dEtNueva', maxLength: MAX_ETAPA, placeholder: 'Nueva etapa (Enter para agregar)…', value: estado.borrador.etapaNueva });
    inp.setAttribute('aria-label', 'Nombre de la nueva etapa');
    const agregar = () => {
      const nombre = inp.value.trim();
      if (!nombre) { inp.setAttribute('aria-invalid', 'true'); mostrarAviso('error', 'Escribí el nombre de la etapa.', '#dAviso'); inp.focus(); return; }
      operarEtapa(t.id, 'POST', null, { nombre }, { foco: 'dEtNueva', ok: 'Etapa agregada.', alOk: () => { estado.borrador.etapaNueva = ''; } });
    };
    inp.addEventListener('input', () => { estado.borrador.etapaNueva = inp.value; inp.removeAttribute('aria-invalid'); });
    inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); agregar(); } });
    const btn = el('button', 'btn');
    btn.type = 'button';
    btn.id = 'dEtAgregar';
    btn.innerHTML = ico('mas');
    btn.append('Agregar etapa');
    btn.addEventListener('click', agregar);
    fila.append(inp, btn);
    return fila;
  }

  // Alta / cambio / baja de una etapa. El server responde el ticket entero; si cambió el estado general
  // (todas terminadas o se reabrió una), el toast lo cuenta en vez del mensaje de éxito.
  async function operarEtapa(id, metodo, etapaId, cuerpo, { foco = null, ok = '', alOk = null } = {}) {
    const antes = buscarTicket(id);
    const focoAntes = document.activeElement && document.activeElement.id;
    const url = `${CFG.api}/${encodeURIComponent(id)}/etapas${etapaId == null ? '' : `/${encodeURIComponent(etapaId)}`}`;
    estado.borrador.etapaOcupada = true;
    pintarDetalle();
    try {
      const t = await enviarJSON(metodo, url, cuerpo || undefined);
      reemplazarTicket(id, t);
      if (estado.borrador) { if (alOk) alOk(); estado.focoDetalle = foco; }
      ocultarAviso('#dAviso');
      if (antes && t.estado !== antes.estado) {
        mostrarToast(t.estado === 'falta_aprobacion' ? 'Todas las etapas terminadas: el ticket pasó a Falta aprobación'
          : `Se reabrió una etapa: el ticket volvió a ${etiqueta('estados', t.estado)}`);
      } else if (ok) mostrarToast(ok);
    } catch (e) {
      if (estado.borrador) estado.focoDetalle = focoAntes;
      mostrarAviso('error', `No se pudo guardar la etapa: ${e.message}`, '#dAviso');
    } finally {
      if (estado.borrador) estado.borrador.etapaOcupada = false;
      pintarTodo();
    }
  }

  function seccionDestinatarios(t) {
    const caja = seccion('Destinatarios', 'usuarios');
    const raiz = el('div');
    caja.append(raiz);
    const inicial = comoLista(t.destinatarios);
    const motivo = !estado.metaOk ? 'No se pueden editar ahora: no hay conexión con SIGA.'
      : (puedeEditarTicket(t) ? '' : `Los cambia quien creó el ticket o quien tenga el permiso ${CFG.permisoTitulo}.`);
    if (motivo) {
      crearSelectorUsuarios(raiz, { id: 'dDest', seleccion: inicial, soloLectura: true });
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
      id: 'dDest',
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
    if (h.tipo === 'estado' && h.auto) {
      return [`Estado actualizado por las etapas: ${badgeEstado(h.de)} <span class="text-gris">→</span> ${badgeEstado(h.a)}
        <span class="chip-auto" title="Lo cambió el sistema tras una acción de ${esc(nombreDe(h.usuario))}">automático</span>`];
    }
    if (h.tipo === 'estado') return [`${quien} cambió el estado: ${badgeEstado(h.de)} <span class="text-gris">→</span> ${badgeEstado(h.a)}`];
    if (h.tipo === 'etapa') {
      const n = `<b class="font-semibold">«${esc(h.etapa)}»</b>`;
      if (h.accion === 'agregada') return [`${quien} agregó la etapa ${n}`];
      if (h.accion === 'eliminada') return [`${quien} eliminó la etapa ${n}`];
      if (h.accion === 'renombrada') return [`${quien} renombró la etapa <span class="text-gris">«${esc(h.de)}»</span> → ${n}`];
      if (h.accion === 'estado') {
        return [`${quien} cambió la etapa ${n}: ${badgeEstado(h.de, 'estadosEtapa')} <span class="text-gris">→</span> ${badgeEstado(h.a, 'estadosEtapa')}`];
      }
    }
    if (h.tipo === 'prioridad') return [`${quien} cambió la prioridad: ${badgePrioridad(h.de)} <span class="text-gris">→</span> ${badgePrioridad(h.a)}`];
    if (h.tipo === 'nota') return [`${quien} agregó una nota`, h.nota || ''];
    if (h.tipo === 'destinatarios') return [`${quien} cambió los destinatarios: <span class="text-gris">${nombres(h.de)}</span> → ${nombres(h.a)}`];
    return [`${quien}: ${esc(h.tipo || 'cambio')}`];
  }
  const ICONO_EVENTO = { creado: 'creado', estado: 'estado', nota: 'msg', destinatarios: 'usuarios', etapa: 'etapa', prioridad: 'bandera' };

  function seccionHistorial(t) {
    const caja = seccion('Historial', 'historial');
    // reverse antes del sort (estable): con la misma fecha, lo último registrado (p. ej. el cambio automático) va arriba.
    const eventos = [...(t.historial || [])].reverse().sort((a, b) => tiempo(b.fecha) - tiempo(a.fecha));
    if (!eventos.length) { caja.append(el('div', 'ayuda', 'Sin movimientos.')); return caja; }
    const ul = el('ul', 'hist');
    ul.replaceChildren(...eventos.map(h => {
      const [frase, nota] = describirEvento(h);
      const li = el('li');
      const tipo = ICONO_EVENTO[h.tipo] ? h.tipo : 'creado';
      li.innerHTML = `<span class="hi h-${tipo}${h.auto ? ' h-auto' : ''}">${ico(ICONO_EVENTO[tipo])}</span>`;
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

  // ── Novedades: sondeo, marcas de no leído y avisos ──────────────────────────
  // Se compara la lista nueva con la anterior por id: nuevo (id no visto) o actualizado (otro actualizadoEn). El aviso
  // describe la última entrada del historial; lo hecho por mí (historial.usuario == login) no avisa ni marca.
  const ultimoEvento = t => { const h = t.historial || []; return h[h.length - 1] || {}; };
  const esMio = h => mismoUsuario(h.usuario, estado.meta.login);
  const soyYo = u => mismoUsuario(u, estado.meta.yo) || mismoUsuario(u, estado.meta.login);
  const meInvolucra = t => comoLista(t.destinatarios).some(soyYo) || soyYo(t.creadoPor);
  const noLeido = t => !!vistos && vistos[t.id] !== t.actualizadoEn && !esMio(ultimoEvento(t));
  const claveVistos = () => `${CLAVE_VISTOS}.${String(estado.meta.login || '').toLowerCase()}`;

  // Primera vez (sin nada guardado): todo cuenta como visto, para no inundar de marcas.
  function iniciarVistos() {
    try { const v = JSON.parse(localStorage.getItem(claveVistos())); if (v && typeof v === 'object') vistos = v; } catch (_) { /* sin storage */ }
    if (!vistos) vistos = Object.fromEntries(estado.tickets.map(t => [t.id, t.actualizadoEn]));
    guardarVistos();
  }
  function guardarVistos() {
    const ids = new Set(estado.tickets.map(t => String(t.id)));
    vistos = Object.fromEntries(Object.entries(vistos).filter(([id]) => ids.has(id)));
    try { localStorage.setItem(claveVistos(), JSON.stringify(vistos)); } catch (_) { /* sin storage: las marcas duran lo que la pestaña */ }
  }
  function marcarVisto(t) {
    if (!vistos || vistos[t.id] === t.actualizadoEn) return;
    vistos = { ...vistos, [t.id]: t.actualizadoEn };
    guardarVistos();
    pintarVista();
    actualizarTitulo();
  }
  function actualizarTitulo() {
    const n = estado.tickets.filter(noLeido).length;
    document.title = n ? `(${n}) ${TITULO}` : TITULO;
  }

  // Reemplaza la lista por la del server y avisa lo que cambiaron otros (la primera carga no avisa).
  function aplicarLista(lista) {
    const previos = new Map(estado.tickets.map(t => [String(t.id), t]));
    const cambiados = lista.filter(t => { const p = previos.get(String(t.id)); return !p || p.actualizadoEn !== t.actualizadoEn; });
    const primera = !estado.cargado;
    estado.tickets = lista;
    estado.cargado = true;
    if (!vistos) iniciarVistos();
    if (!primera && !cambiados.length) return;
    const ajenos = primera ? [] : cambiados.filter(t => !esMio(ultimoEvento(t)));
    const abierto = ajenos.find(t => String(t.id) === String(estado.abierto));
    repintarConservando();
    if (abierto && estado.abierto != null) mostrarAviso('info', `Este ticket se actualizó · por ${nombreDe(ultimoEvento(abierto).usuario)}`, '#dAviso');
    if (ajenos.length) avisarCambios(ajenos.map(t => describirCambio(t, previos.get(String(t.id)))));
  }

  // Repinta tablero/lista y detalle sin perder scroll de las columnas, foco ni texto a medio escribir.
  function repintarConservando() {
    const act = document.activeElement;
    const tipeando = act && /^(INPUT|TEXTAREA)$/.test(act.tagName) && act.id ? [act.id, act.value, act.selectionStart, act.selectionEnd] : null;
    const item = act && act.closest ? act.closest('#tablero [data-id], #cuerpo [data-id]') : null;
    const focoItem = item && `#${item.closest('#tablero, #cuerpo').id} [data-id="${CSS.escape(item.dataset.id)}"]${act.matches('select') ? (act.matches('[data-prioridad-id]') ? ' select[data-prioridad-id]' : ' select[data-estado-id]') : ''}`;
    const scrolls = [...document.querySelectorAll('#tablero .col')].map(c => [c.dataset.estado, c.querySelector('.col-cuerpo')?.scrollTop || 0]);
    const scrollDetalle = $('#dCuerpo').scrollTop;
    armarFiltrosDinamicos();
    pintarTodo();
    actualizarTitulo();
    scrolls.forEach(([e, top]) => {
      const c = document.querySelector(`#tablero .col[data-estado="${CSS.escape(e)}"] .col-cuerpo`);
      if (c) c.scrollTop = top;
    });
    $('#dCuerpo').scrollTop = scrollDetalle;
    if (focoItem) document.querySelector(focoItem)?.focus();
    const nuevo = tipeando && document.getElementById(tipeando[0]);
    if (nuevo && nuevo !== act) {
      nuevo.value = tipeando[1];
      nuevo.focus();
      try { nuevo.setSelectionRange(tipeando[2], tipeando[3]); } catch (_) { /* input sin selección de texto */ }
    }
  }

  function textoEtapa(h) {
    const e = `etapa «${h.etapa}»`;
    if (h.accion === 'estado') return h.a === 'terminado' ? `${e} terminada` : `${e} pasó a ${etiqueta('estadosEtapa', h.a)}`;
    return `${e} ${['agregada', 'eliminada', 'renombrada'].includes(h.accion) ? h.accion : 'actualizada'}`;
  }
  // { id, texto, mio } de un ticket nuevo/actualizado. ponytail: sólo la última entrada del historial;
  // si entre dos sondeos pasaron varias cosas, se cuenta la última (el detalle muestra todo).
  function describirCambio(t, previo) {
    const h = ultimoEvento(t);
    const quien = nombreDe(h.usuario);
    const n = `#${t.id}`;
    const asignado = previo ? h.tipo === 'destinatarios' && comoLista(h.a).some(soyYo) && !comoLista(h.de).some(soyYo)
      : comoLista(t.destinatarios).some(soyYo);
    let texto = `${n} se actualizó · ${quien}`;
    if (asignado) texto = `Te asignaron ${previo ? '' : 'un ticket nuevo: '}${n} «${t.tarea}» · por ${quien}`;
    else if (!previo) texto = `Nuevo ticket ${n} «${t.tarea}» · por ${quien}`;
    else if (h.tipo === 'estado' && h.auto) {
      texto = h.a === 'falta_aprobacion' ? `${n} pasó a ${etiqueta('estados', h.a)} (todas las etapas terminadas)`
        : `${n} volvió a ${etiqueta('estados', h.a)} (se reabrió una etapa)`;
    } else if (h.tipo === 'estado') texto = `${n} cambió a ${etiqueta('estados', h.a)} · ${quien}`;
    else if (h.tipo === 'prioridad') texto = `${n} prioridad: ${etiqueta('prioridades', h.de)} → ${etiqueta('prioridades', h.a)} · ${quien}`;
    else if (h.tipo === 'nota') texto = `${n} nueva nota · ${quien}`;
    else if (h.tipo === 'destinatarios') texto = `${n} destinatarios actualizados · ${quien}`;
    else if (h.tipo === 'etapa') texto = `${n} ${textoEtapa(h)} · ${quien}`;
    const mio = asignado || meInvolucra(t);
    // Subió a Urgente y me involucra: aviso en rojo, más que el destacado común.
    return { id: t.id, texto, mio, urgente: mio && !!previo && h.tipo === 'prioridad' && h.a === 'urgente' };
  }

  // Muchos cambios juntos → un solo aviso agrupado. Pestaña oculta + avisos de escritorio activos → notificación nativa.
  function avisarCambios(cambios) {
    const mios = cambios.filter(c => c.mio).length;
    const avisos = cambios.length <= MAX_TOASTS ? cambios : [{
      id: null, mio: mios > 0,
      texto: `${cambios.length} tickets actualizados${mios ? ` · ${mios === 1 ? '1 te involucra' : `${mios} te involucran`}` : ''}`,
    }];
    avisos.forEach(c => agregarToast({ texto: c.texto, icono: c.urgente ? 'alerta' : (c.mio ? 'campana' : 'historial'), destacado: c.mio, urgente: c.urgente, id: c.id, ms: AVISO_MS }));
    if (document.hidden && escritorioActivo()) avisos.forEach(notificar);
  }

  // No se pisa lo que el usuario está haciendo: con un diálogo abierto sólo se enfoca la pestaña.
  function abrirDesdeAviso(id) {
    if ($('#dlgNuevo').open || $('#dlgDetalle').open) return;
    abrirDetalle(id);
  }

  // ── Avisos de escritorio (Notification API): opcionales, el permiso se pide sólo al hacer clic ──
  const soportaEscritorio = () => 'Notification' in window;
  const escritorioActivo = () => prefEscritorio && soportaEscritorio() && Notification.permission === 'granted';
  function notificar(c) {
    try {
      const n = new Notification(c.urgente ? `${CFG.tituloCorto} · urgente` : (c.mio ? `${CFG.tituloCorto} · te involucra` : CFG.titulo),
        { body: c.texto, tag: c.id != null ? `${CFG.clave}-${c.id}` : CFG.clave, icon: '/favicon.png' });
      n.onclick = () => { window.focus(); n.close(); if (c.id != null) abrirDesdeAviso(c.id); };
    } catch (_) { /* navegador que sólo notifica vía service worker: quedan el toast y la marca */ }
  }
  function pintarBotonAvisos() {
    const b = $('#btnAvisos');
    const permiso = soportaEscritorio() ? Notification.permission : 'no';
    const activo = escritorioActivo();
    b.disabled = permiso === 'no' || permiso === 'denied';
    b.setAttribute('aria-pressed', String(activo));
    b.querySelector('.txt').textContent = { no: 'Avisos de escritorio: no disponibles', denied: 'Avisos de escritorio: bloqueados' }[permiso]
      || `Avisos de escritorio${activo ? ': sí' : ''}`;
    b.title = { no: 'Este navegador (o una conexión sin https) no permite avisos de escritorio.',
      denied: 'Los bloqueaste para este sitio: habilitalos desde el candado de la barra de direcciones.' }[permiso]
      || (activo ? 'Clic para desactivarlos.' : 'Aviso del sistema cuando cambia un ticket y estás en otra pestaña.');
  }
  async function alternarEscritorio() {
    if (!soportaEscritorio() || Notification.permission === 'denied') return;
    prefEscritorio = Notification.permission === 'granted' ? !prefEscritorio : (await Notification.requestPermission()) === 'granted';
    try { localStorage.setItem(CLAVE_ESCRITORIO, prefEscritorio ? '1' : '0'); } catch (_) { /* sin storage: dura la pestaña */ }
    pintarBotonAvisos();
  }

  // ── Sondeo ──
  // ponytail: polling de GET /api/tickets (JSON chico, un archivo). Techo: unas decenas de pestañas abiertas; con
  // muchos usuarios, pasar a SSE (el server empuja cada cambio) o a /api/tickets?desde=<actualizadoEn>.
  // window.__TICKETS_POLL_MS (si existe) acorta el intervalo para probar sin esperar.
  function programarSondeo() {
    clearTimeout(timerSondeo);
    timerSondeo = setTimeout(sondear, Number(window.__TICKETS_POLL_MS) || (document.hidden ? SONDEO_OCULTA_MS : SONDEO_MS));
  }
  async function sondear() {
    clearTimeout(timerSondeo);
    if (sondeando) return; // el que está en vuelo reprograma
    if (arrastrando) { sondeoPendiente = true; return; }
    sondeando = true;
    const version = versionLocal;
    try {
      const lista = await api(CFG.api);
      marcarConexion(null);
      // Un cambio propio en vuelo o que respondió mientras tanto deja vieja esta foto: se usa la próxima.
      if (!enVuelo && version === versionLocal && Array.isArray(lista)) aplicarLista(lista);
    } catch (e) {
      marcarConexion(e);
    } finally {
      sondeando = false;
      programarSondeo();
    }
  }
  // Discreto y sin apilar alertas: se va solo cuando un sondeo vuelve a andar.
  function marcarConexion(error) {
    const c = $('#conexion');
    c.classList.toggle('hidden', !error);
    c.textContent = !error ? '' : (error.red ? 'Sin conexión, reintentando…' : `${error.message} Reintentando…`);
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
    // Selects de estado y prioridad de la lista y del detalle: delegado en document.
    document.addEventListener('change', e => {
      if (e.target.matches('select[data-estado-id]')) moverEstado(e.target.dataset.estadoId, e.target.value);
      if (e.target.matches('select[data-prioridad-id]')) cambiarPrioridad(e.target.dataset.prioridadId, e.target.value);
    });
    enlazarDialogo($('#dlgDetalle'), alCerrarDetalle);
    $('#btnAvisos').addEventListener('click', alternarEscritorio);
    // Al volver a la pestaña se consulta en el momento; al irse, el próximo sondeo se espacia.
    document.addEventListener('visibilitychange', () => { if (document.hidden) programarSondeo(); else sondear(); });
  }

  function pintarYo() {
    const m = estado.meta;
    if (!m.yo && !m.yoNombre) return;
    $('#yo').innerHTML = `${m.yo ? avatar(m.yo, '', true) : ''}<span>${esc(m.yoNombre || nombreDe(m.yo))}</span>`;
  }

  // ── Arranque ────────────────────────────────────────────────────────────────
  async function cargarMeta() {
    try {
      const m = await api(`${CFG.api}/meta`);
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
    try {
      if (localStorage.getItem(CLAVE_VISTA) === 'lista') estado.vista = 'lista';
      prefEscritorio = localStorage.getItem(CLAVE_ESCRITORIO) === '1';
    } catch (_) { /* sin storage: vista default y sin avisos de escritorio */ }
    pintarBotonAvisos();
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
    programarSondeo();
  }

  iniciar();
})();
