'use strict';
// Vista Calendario de /tickets (solo con meta.calendario): mes con los tickets por fecha + lista lateral de los
// que no tienen fecha. Con permiso de gestión se arrastra (HTML5 nativo): lista → día asigna, día → día mueve,
// día → lista quita la fecha. Sin red ni estado de tickets: tickets.js pasa los tickets y hace el POST (asignar).
// Los helpers puros (grillaMes, agruparPorDia, ordenSinFecha, formatoFecha) también se cargan desde Node para testearlos.
(() => {
  const DIAS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const CERRADOS = ['terminado', 'cancelado'];
  const RE_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;

  const pad = n => String(n).padStart(2, '0');
  const isoDe = (anio, mes0, dia) => `${anio}-${pad(mes0 + 1)}-${pad(dia)}`; // mes0: 0-11
  const hoyISO = (ahora = new Date()) => isoDe(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
  const formatoFecha = iso => { const m = RE_FECHA.exec(iso || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
  const tieneFecha = t => RE_FECHA.test(t.fecha || '');

  // Días a pintar del mes (lunes primero), en semanas completas: [{ iso, dia, delMes }].
  function grillaMes(anio, mes0) {
    const desfase = (new Date(anio, mes0, 1).getDay() + 6) % 7;
    const diasMes = new Date(anio, mes0 + 1, 0).getDate();
    return Array.from({ length: Math.ceil((desfase + diasMes) / 7) * 7 }, (_, i) => {
      const d = new Date(anio, mes0, 1 - desfase + i);
      return { iso: isoDe(d.getFullYear(), d.getMonth(), d.getDate()), dia: d.getDate(), delMes: d.getMonth() === mes0 };
    });
  }
  // Mes corrido `delta` meses (acepta pasarse de 0-11 en cualquier sentido).
  function moverMes(anio, mes0, delta) {
    const d = new Date(anio, mes0 + delta, 1);
    return { anio: d.getFullYear(), mes0: d.getMonth() };
  }
  // Prioridad alta primero; dentro, el orden manual (campo orden; sin orden va al final) y por último el id.
  const comparador = rango => (a, b) => {
    const ord = t => (typeof t.orden === 'number' ? t.orden : Infinity);
    return (rango(b.prioridad) - rango(a.prioridad)) || (ord(a) === ord(b) ? 0 : ord(a) < ord(b) ? -1 : 1) || (Number(a.id) - Number(b.id));
  };
  // Map iso → tickets de ese día (ya ordenados). Los cerrados con fecha también entran.
  function agruparPorDia(tickets, rango) {
    const dias = new Map();
    [...tickets].filter(tieneFecha).sort(comparador(rango)).forEach(t => dias.set(t.fecha, [...(dias.get(t.fecha) || []), t]));
    return dias;
  }
  // Lista lateral: sin fecha y sin cerrar.
  const ordenSinFecha = (tickets, rango) => tickets.filter(t => !tieneFecha(t) && !CERRADOS.includes(t.estado)).sort(comparador(rango));

  function crearUI({ raiz, el, ico, rango, etiquetaPrioridad, puedeGestionar, ocupado, abrir, asignar, alArrastre }) {
    const hoy = new Date();
    let vista = { anio: hoy.getFullYear(), mes0: hoy.getMonth() };
    let tickets = [];
    let arrastrado = null; // id del ticket que se arrastra

    const boton = (id, texto, aria, alClic) => {
      const b = el('button', 'btn btn-sm', texto);
      Object.assign(b, { type: 'button', id });
      b.setAttribute('aria-label', aria);
      b.addEventListener('click', alClic);
      return b;
    };
    const titulo = el('h2', 'cal-mes');
    titulo.setAttribute('aria-live', 'polite');
    const barra = el('div', 'cal-bar');
    barra.append(titulo,
      boton('calAnt', '‹', 'Mes anterior', () => ir(-1)),
      boton('calHoy', 'Hoy', 'Ir al mes actual', () => { const h = new Date(); vista = { anio: h.getFullYear(), mes0: h.getMonth() }; pintar(tickets); }),
      boton('calSig', '›', 'Mes siguiente', () => ir(1)));
    const semana = el('div', 'cal-sem');
    semana.setAttribute('aria-hidden', 'true');
    semana.append(...DIAS.map(d => el('div', 'cal-dow', d)));
    const grilla = el('div', 'cal-grid');
    const panel = el('aside', 'cal-panel');
    panel.dataset.sinfecha = '1';
    panel.setAttribute('aria-label', 'Tickets sin fecha');
    const principal = el('section', 'cal');
    principal.setAttribute('aria-label', 'Calendario de tickets');
    const centro = el('div', 'cal-main');
    centro.append(barra, semana, grilla);
    principal.append(panel, centro);
    raiz.replaceChildren(principal);

    function ir(delta) {
      vista = moverMes(vista.anio, vista.mes0, delta);
      pintar(tickets);
      document.getElementById(delta < 0 ? 'calAnt' : 'calSig')?.focus();
    }

    function chip(t) {
      const mover = puedeGestionar();
      const cerrado = CERRADOS.includes(t.estado);
      const b = el('button', `cal-tk p-${t.prioridad}${cerrado ? ' cerrado' : ''}${t.estado === 'cancelado' ? ' cancelado' : ''}${ocupado(t.id) ? ' guardando' : ''}`);
      b.type = 'button';
      b.draggable = mover;
      b.dataset.id = String(t.id);
      b.title = `#${t.id} ${t.tarea} · ${etiquetaPrioridad(t.prioridad)}${t.fecha ? ` · ${formatoFecha(t.fecha)}` : ''}`;
      b.append(el('span', 'n', `#${t.id}`), el('span', 't', t.tarea));
      return b;
    }

    function pintarPanel() {
      const lista = ordenSinFecha(tickets, rango);
      const cuerpo = el('div', 'cal-lista');
      if (lista.length) cuerpo.append(...lista.map(chip));
      else cuerpo.append(el('div', 'col-vacia', 'No hay tickets sin fecha'));
      panel.replaceChildren(el('h3', 'cal-panel-h', `Sin fecha (${lista.length})`),
        el('p', 'ayuda px-1 mb-2', puedeGestionar() ? 'Arrastrá un ticket a un día para asignarle fecha.' : 'Ordenados por prioridad.'), cuerpo);
    }

    function pintar(lista) {
      tickets = lista;
      titulo.textContent = `${MESES[vista.mes0]} ${vista.anio}`;
      const porDia = agruparPorDia(tickets, rango);
      const hoyIso = hoyISO();
      grilla.replaceChildren(...grillaMes(vista.anio, vista.mes0).map(d => {
        const celda = el('div', `cal-dia${d.delMes ? '' : ' fuera'}${d.iso === hoyIso ? ' hoy' : ''}`);
        celda.dataset.fecha = d.iso;
        const num = el('span', 'cal-num', String(d.dia));
        if (d.iso === hoyIso) num.append(el('span', 'sr-only', ' (hoy)'));
        celda.append(num, ...(porDia.get(d.iso) || []).map(chip));
        return celda;
      }));
      pintarPanel();
    }

    // ── Arrastre ──
    const limpiarSobre = () => raiz.querySelectorAll('.sobre').forEach(n => n.classList.remove('sobre'));
    const destinoDe = e => e.target.closest('[data-fecha], [data-sinfecha]');
    function terminar() { arrastrado = null; limpiarSobre(); raiz.querySelector('.arrastrando')?.classList.remove('arrastrando'); alArrastre(false); }

    raiz.addEventListener('dragstart', e => {
      const c = e.target.closest('.cal-tk');
      if (!c) return;
      if (!puedeGestionar()) { e.preventDefault(); return; }
      arrastrado = c.dataset.id;
      alArrastre(true);
      e.dataTransfer.setData('text/plain', arrastrado);
      e.dataTransfer.effectAllowed = 'move';
      requestAnimationFrame(() => c.classList.add('arrastrando'));
    });
    raiz.addEventListener('dragend', terminar);
    raiz.addEventListener('dragover', e => {
      const d = destinoDe(e);
      if (!d || arrastrado == null || !puedeGestionar()) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!d.classList.contains('sobre')) { limpiarSobre(); d.classList.add('sobre'); }
    });
    raiz.addEventListener('dragleave', e => {
      const d = destinoDe(e);
      if (d && !d.contains(e.relatedTarget)) d.classList.remove('sobre');
    });
    raiz.addEventListener('drop', e => {
      const d = destinoDe(e);
      const id = arrastrado;
      if (!d || id == null || !puedeGestionar()) return;
      e.preventDefault();
      terminar(); // asignar repinta: el chip original sale del DOM y su dragend ya no llega
      asignar(id, d.dataset.fecha || null);
    });
    raiz.addEventListener('click', e => {
      const c = e.target.closest('.cal-tk');
      if (c) abrir(c.dataset.id);
    });

    return { pintar };
  }

  // Evento del historial que el server agrega solo al llegar la fecha asignada (no lo hizo una persona).
  function esInicioPorFecha(h) {
    return !!h && h.tipo === 'estado' && h.auto === true && h.motivo === 'fecha';
  }

  const api = { grillaMes, moverMes, agruparPorDia, ordenSinFecha, formatoFecha, hoyISO, esInicioPorFecha, crearUI };
  if (typeof window !== 'undefined') window.TicketsCalendario = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
