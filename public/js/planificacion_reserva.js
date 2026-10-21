
// ══════════════════ RESERVA DE MERCADERÍA ══════════════════════

let reservaCache     = null;   // último GET /api/plan/:fecha/reserva
let reservaReqTicket = 0;      // descarta respuestas viejas cuando se cambia de depósito

function reservaActiva() {
  const r = reservaCache?.reserva;
  return r && r.estado === 'activa' ? r : null;
}

// La reserva se anuló sola porque sus movimientos se revirtieron desde el historial
// (el servidor lo detecta comparando el plan contra el log de movimientos).
function reservaAnuladaPorLog() {
  const r = reservaCache?.reserva;
  const a = r && r.estado === 'anulada' ? r.anuladaPorLog : null;
  return (a && typeof a === 'object') ? a : null;
}

// La reserva sigue activa pero el log dice que en el depósito de reserva quedó otra cosa:
// se tocó desde el historial de movimientos y hay que revisarla antes de seguir operando.
function reservaDesincronizada() {
  const r = reservaActiva();
  const d = r && r.desincronizada;
  return (d && typeof d === 'object') ? d : null;
}

// La reserva activa del plan se hizo desde OTRA sucursal: se puede mirar, pero
// el servidor rechaza reservar, actualizar y devolver hasta cambiar de sucursal.
function sucursalDistintaReserva() {
  const s = reservaCache?.sucursalDistinta;
  return (s && typeof s === 'object') ? s : null;
}

function fmtCant(n) {
  const v = Number(n);
  if (!isFinite(v)) return '—';
  return String(Math.round(v * 10000) / 10000);
}

// La API vieja no manda firma/cambios/delta: se normaliza para no romper el render.
function firmaReserva() {
  const f = reservaCache?.firma;
  return (f && typeof f === 'object') ? f : { actual: null, reservada: null, hayCambios: false };
}

function cambiosReserva() {
  return Array.isArray(reservaCache?.cambios) ? reservaCache.cambios : [];
}

function deltaReserva() {
  return Array.isArray(reservaCache?.delta) ? reservaCache.delta : [];
}

// Hay reserva hecha y el plan del día cambió desde entonces.
function reservaDesactualizada() {
  return !!reservaActiva() && firmaReserva().hayCambios === true;
}

// POST que necesita leer el cuerpo aunque el servidor responda 4xx
// (la API devuelve { error, faltantes } cuando no alcanza el stock).
async function postReserva(ruta, body) {
  const res = await fetch(SERVER_URL + ruta, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify(body || {})
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!data) throw new Error(`${res.status}: respuesta inválida del servidor`);
  return data;
}

// Interruptor por equipo (no por usuario ni por servidor): si está apagado, esta PC no
// genera movimientos de stock en SiGA. Sólo bloquea la salida; lo ya reservado se sigue
// viendo y el resumen de reservas queda accesible para revertir.
const MOV_STOCK_LS_KEY = 'planif_mov_stock_on';
function movStockHabilitado() {
  // Apagado por default: hay que prenderlo a mano en cada equipo.
  try { return localStorage.getItem(MOV_STOCK_LS_KEY) === '1'; }
  catch (e) { return false; }
}

function aplicarEstadoBotonReserva() {
  const btn  = document.getElementById('btnReservaMerc');
  if (!btn) return;
  const items  = planCache?.items || [];
  const activa = reservaActiva();

  if (!movStockHabilitado()) {
    btn.textContent = '🚫 Carga a SiGA apagada';
    btn.disabled    = true;
    btn.title       = 'La carga por movimientos de stock está desactivada en este equipo: activala para poder reservar';
    aplicarChipReserva();
    return;
  }

  const desactualizada = reservaDesactualizada();
  const desincronizada = reservaDesincronizada();
  const otraSucursal   = sucursalDistintaReserva();

  // Reserva incremental: cada orden se sella con su propio movimiento al reservarse
  // (item.reservaMovimiento), así que el botón externo se habilita mientras queden
  // órdenes sin sellar, no según si el plan (como un todo) tuvo alguna vez una reserva.
  const itemReservado  = it => !!(it && it.reservaMovimiento && it.reservaMovimiento.numeroMovimiento != null);
  const haySinReservar = items.some(it => !itemReservado(it));
  const hayReservados  = items.some(itemReservado);

  if (activa && (otraSucursal || desincronizada)) {
    // Estados de excepción: la reserva vigente no se puede tocar desde acá hasta
    // resolverlos (cambiar de sucursal o revisar la desincronización en el modal).
    btn.textContent = `🔒 Reservado #${activa.numeroMovimiento}`;
    btn.disabled    = false;
    btn.title       = otraSucursal
      ? `La reserva #${activa.numeroMovimiento} es de la ${etiquetaSucursal(otraSucursal.deLaReserva)}: cambiá a esa sucursal para actualizarla o anularla`
      : `La reserva #${activa.numeroMovimiento} fue alterada desde el historial de movimientos: abrí el modal para revisarla`;
  } else if (items.length === 0) {
    btn.textContent = '🔒 Reservar mercadería';
    btn.disabled    = true;
    btn.title       = 'No hay ítems en el plan';
  } else if (!haySinReservar) {
    btn.textContent = '🔒 Todo reservado';
    btn.disabled    = true;
    btn.title       = activa
      ? `Todas las órdenes del plan ya están reservadas (último comprobante #${activa.numeroMovimiento}).`
      : 'Todas las órdenes del plan ya están reservadas.';
  } else {
    // Los depósitos se eligen dentro del modal, así que el config sólo aporta
    // la preselección: no hace falta bloquear el botón si no está configurado.
    btn.textContent = hayReservados ? '🔒 Reservar órdenes nuevas' : '🔒 Reservar mercadería';
    btn.disabled    = false;
    btn.title       = hayReservados
      ? 'Reservar los componentes de fórmula de las órdenes nuevas (las ya reservadas no se tocan)'
      : 'Reservar los componentes de fórmula del plan';
  }

  aplicarChipReserva();
}

// El chip de reserva es informativo: se muestra igual con la carga a SiGA apagada, porque
// una reserva vieja del plan se sigue pudiendo revisar y revertir.
function aplicarChipReserva() {
  const chip = document.getElementById('chipReservaPlan');
  const activa = reservaActiva();
  const desactualizada = reservaDesactualizada();
  const desincronizada = reservaDesincronizada();
  const otraSucursal   = sucursalDistintaReserva();

  if (chip) {
    if (activa) {
      chip.style.display     = '';
      chip.dataset.estado    = (otraSucursal || desactualizada || desincronizada) ? 'pendiente' : 'listo';
      chip.textContent       = `🔒 Reserva #${activa.numeroMovimiento}`
        + (otraSucursal ? ` · sucursal ${otraSucursal.deLaReserva}`
          : desincronizada ? ' · desincronizada'
          : desactualizada ? ' · plan modificado' : '');
      chip.title             = otraSucursal
        ? `La reserva se hizo en la ${etiquetaSucursal(otraSucursal.deLaReserva)}: cambiá a esa sucursal para poder actualizarla o anularla`
        : desincronizada
          ? 'La reserva fue alterada desde el historial de movimientos: abrí el modal para revisarla'
          : desactualizada
            ? 'El plan cambió desde la reserva: abrí el modal para actualizarla'
            : 'Ver la reserva de mercadería';
    } else {
      chip.style.display  = 'none';
      chip.textContent    = '';
      chip.dataset.estado = 'listo';
      chip.title          = 'Ver la reserva de mercadería';
    }
  }
}

function setReservaCargando(activo) {
  const el = document.getElementById('reservaCargando');
  if (el) el.style.display = activo ? '' : 'none';
}

function setAvisoReserva(msg) {
  const el = document.getElementById('reservaAviso');
  if (!el) return;
  if (msg) { el.textContent = msg; el.style.display = ''; }
  else     { el.textContent = '';  el.style.display = 'none'; }
}

function errorEnBodyReserva(msg) {
  document.getElementById('reservaBody').innerHTML =
    `<div style="color:var(--red-text);font-size:13px">${escHtml(msg)}</div>`;
}

// GET del estado de la reserva para un par de depósitos.
// Devuelve true sólo si la respuesta sigue siendo la más reciente (las
// respuestas viejas se descartan para que no pisen el render).
async function cargarReserva(depOrigen, depDestino, mostrarCarga) {
  const ticket = ++reservaReqTicket;
  if (mostrarCarga) setReservaCargando(true);
  const params = [];
  if (depOrigen  != null && depOrigen  !== '') params.push('depOrigen='  + encodeURIComponent(depOrigen));
  if (depDestino != null && depDestino !== '') params.push('depDestino=' + encodeURIComponent(depDestino));
  const ruta = conSucursal(`/api/plan/${fechaPlanActual}/reserva` + (params.length ? '?' + params.join('&') : ''));
  try {
    const data = await api('GET', ruta);
    if (ticket !== reservaReqTicket) return false;
    reservaCache = data;
    return true;
  } finally {
    if (ticket === reservaReqTicket) setReservaCargando(false);
  }
}

async function refrescarEstadoReserva(silencioso) {
  if (!fechaPlanActual) { reservaCache = null; aplicarEstadoBotonReserva(); return; }
  try {
    await cargarReserva(null, null, false);
  } catch (e) {
    reservaCache = null;
    // En el refresco automático no se molesta al usuario: el detalle del error
    // se muestra al abrir el modal, que sí es una acción explícita.
    if (!silencioso) toast('Error al consultar la reserva: ' + e.message, true);
  }
  aplicarEstadoBotonReserva();
}

async function abrirModalReserva() {
  if (!fechaPlanActual) { toast('Seleccioná un día primero', true); return; }
  const overlay = document.getElementById('overlayReserva');
  document.getElementById('reservaTitulo').textContent =
    `🔒 Reserva de mercadería — ${formatFecha(fechaPlanActual)}`;
  document.getElementById('reservaBody').innerHTML =
    '<div style="color:var(--muted);font-size:13px">Cargando…</div>';
  document.getElementById('btnConfirmarReserva').disabled    = true;
  document.getElementById('btnConfirmarReserva').textContent = '🔒 Reservar';
  document.getElementById('btnAnularReserva').style.display = 'none';
  document.getElementById('btnAnularReserva').disabled      = false;
  setAvisoReserva('');
  overlay.classList.add('open');

  let vigente = false;
  try {
    vigente = await cargarReserva(null, null, true);
  } catch (e) {
    errorEnBodyReserva('Error al cargar la reserva: ' + e.message);
    toast('Error al cargar la reserva', true);
    return;
  }
  if (!vigente) return;
  renderReservaModal();
  aplicarEstadoBotonReserva();
}

// Cambio de depósito de origen o de destino: se recalcula todo contra el servidor,
// porque el stock y los faltantes dependen del par elegido.
async function onCambioDeposito() {
  if (!fechaPlanActual || reservaActiva()) return;
  const selO = document.getElementById('selDepOrigen');
  const selD = document.getElementById('selDepDestino');
  if (!selO || !selD) return;

  let vigente = false;
  try {
    vigente = await cargarReserva(selO.value, selD.value, true);
  } catch (e) {
    errorEnBodyReserva('Error al consultar el stock de los depósitos: ' + e.message);
    toast('Error al consultar el stock: ' + e.message, true);
    return;
  }
  if (!vigente) return;
  renderReservaModal();
}

function cerrarModalReserva() {
  document.getElementById('overlayReserva').classList.remove('open');
}

function depositosReserva() {
  return Array.isArray(reservaCache?.depositos) ? reservaCache.depositos : [];
}

function nombreDeposito(id) {
  const dep = depositosReserva().find(d => String(d.idDeposito) === String(id));
  return dep ? String(dep.nombre || '') : '';
}

// "dep 99 Reservado Casa Central" (sin escapar: escapa quien lo inserta en el HTML)
function etiquetaDeposito(id) {
  if (id == null || id === '') return '—';
  const nom = nombreDeposito(id);
  return `dep ${id}${nom ? ' ' + nom : ''}`;
}

function renderSelectsDeposito(activa) {
  const deps = depositosReserva();
  const sel  = reservaCache?.seleccion || {};
  const selO = document.getElementById('selDepOrigen');
  const selD = document.getElementById('selDepDestino');
  if (!selO || !selD) return;

  const valO = activa ? activa.depOrigen  : sel.depOrigen;
  const valD = activa ? activa.depDestino : sel.depDestino;

  const opciones = (valActual) => {
    const vacio = (valActual == null || valActual === '')
      ? '<option value="">— Elegir —</option>' : '';
    // Un depósito que ya no viene en la lista (p. ej. el de una reserva vieja)
    // igual tiene que poder mostrarse.
    const conocido = deps.some(d => String(d.idDeposito) === String(valActual));
    const extra = (!conocido && valActual != null && valActual !== '')
      ? `<option value="${escHtml(String(valActual))}">${escHtml(String(valActual))} — (depósito sin nombre)</option>`
      : '';
    const lista = deps.map(d => {
      const suf = d.disponibleVenta === true ? '' : ' (no vendible)';
      return `<option value="${escHtml(String(d.idDeposito))}">${escHtml(String(d.idDeposito))} — ${escHtml(d.nombre || '')}${suf}</option>`;
    }).join('');
    return vacio + extra + lista;
  };

  selO.innerHTML = opciones(valO);
  selD.innerHTML = opciones(valD);
  selO.value = (valO == null) ? '' : String(valO);
  selD.value = (valD == null) ? '' : String(valD);
  selO.disabled = !!activa;
  selD.disabled = !!activa;
  selO.title = activa
    ? 'La reserva ya está hecha: no se puede cambiar el depósito'
    : 'Depósito del que sale la mercadería';
  selD.title = activa
    ? 'La reserva ya está hecha: no se puede cambiar el depósito'
    : 'Depósito al que se reserva la mercadería';
}

// ── Sello del comprobante de SiGA por ítem ───────────────────────
// El backend marca cada ítem con el movimiento con el que se reservó
// (`reservaMovimiento`) y, si se devolvió, con el de la devolución
// (`reservaDevuelta`). Ambos son opcionales: los planes viejos y los ítems
// nunca reservados no los traen.
function selloMovItem(sello) {
  if (!sello || typeof sello !== 'object') return null;
  const numero = sello.numeroMovimiento;
  if (numero == null || numero === '') return null;
  return {
    numero:     String(numero),
    fecha:      sello.fecha ?? null,
    depOrigen:  sello.depOrigen,
    depDestino: sello.depDestino
  };
}

// "el 22/07 26 14:35 · dep 1 Depósito → dep 99 Reservado"
function textoSelloMov(sello) {
  return `el ${fmtFechaHoraMov(sello.fecha)} · ${etiquetaDeposito(sello.depOrigen)} → ${etiquetaDeposito(sello.depDestino)}`;
}

// Chip compacto con el número de movimiento de SiGA de un ítem del plan.
// Devuelve '' cuando el ítem nunca se reservó, para no ensuciar la fila.
function chipMovimientoItem(it) {
  // Es sólo informativo: pase lo que pase con los datos, la fila se tiene que dibujar.
  try {
    // Prioridad MÁXIMA: el ítem ya se produjo y recepcionó como artículo final. Este estado
    // es terminal (no se puede volver a reservar) y gana sobre reservado/devuelto.
    const producido = selloMovItem(it && it.produccionMovimiento);
    if (producido) {
      const title = `Producido y recepcionado con el movimiento #${producido.numero} el ${fmtFechaHoraMov(producido.fecha)}. No se puede volver a reservar.`;
      return `<span class="pres-chip mov-chip" title="${escHtml(title)}" style="background:#14532d;color:#fff;border-color:#14532d">✔ Producido #${escHtml(producido.numero)}</span>`;
    }
    const reserva  = selloMovItem(it && it.reservaMovimiento);
    const devuelto = selloMovItem(it && it.reservaDevuelta);
    if (!reserva && !devuelto) return '';

    if (devuelto) {
      const lineas = [`Devuelto con el movimiento #${devuelto.numero} ${textoSelloMov(devuelto)}`];
      if (reserva) lineas.push(`Se había reservado con el movimiento #${reserva.numero} ${textoSelloMov(reserva)}`);
      return `<span class="pres-chip MUTED mov-chip" title="${escHtml(lineas.join('\n'))}">↩ #${escHtml(devuelto.numero)}</span>`;
    }
    const title = `Reservado con el movimiento #${reserva.numero} ${textoSelloMov(reserva)}`;
    return `<span class="pres-chip GREEN mov-chip" title="${escHtml(title)}">🔒 #${escHtml(reserva.numero)}</span>`;
  } catch {
    return '';
  }
}

// "6333 Envase 500g Pet SILPLAST" (sin escapar: escapa quien lo inserta en el HTML)
function etiquetaComponente(c) {
  if (!c) return '—';
  const plu = (c.plu == null || c.plu === '') ? '' : String(c.plu);
  const nom = String(c.nombre ?? '').trim();
  return [plu, nom].filter(Boolean).join(' ') || '—';
}

// Tolera respuestas viejas de la API, que no traen el campo `origen`.
function origenComponente(c) {
  const o = c && c.origen;
  return (o === 'seleccion' || o === 'mixto') ? o : 'formula';
}

// Chip para los componentes que vienen del envase/tapa elegido en la planificación.
function chipOrigenComponente(c) {
  const origen = origenComponente(c);
  if (origen === 'formula') return '';
  const reemplaza = Array.isArray(c && c.reemplazaA) ? c.reemplazaA : [];
  const texto = origen === 'mixto' ? 'elegido en parte' : 'elegido';
  const title = reemplaza.length
    ? 'Reemplaza a: ' + reemplaza.map(r => etiquetaComponente(r)).join(', ')
    : 'Elegido en la planificación';
  return ` <span class="pres-chip INFO" title="${escHtml(title)}">${escHtml(texto)}</span>`;
}

// Bloque informativo con los envases y tapas que la planificación impuso sobre la fórmula.
function bloqueSustitucionesReserva(sustituciones) {
  if (!sustituciones.length) return '';
  const filas = sustituciones.map(s => {
    const tipo    = s.tipo === 'tapa' ? 'tapa' : 'envase';
    const elegido = `<strong>${escHtml(etiquetaComponente(s.elegido))}</strong>`;
    const detalle = s.deFormula
      ? `<span style="text-decoration:line-through;opacity:.6">${escHtml(etiquetaComponente(s.deFormula))}</span> → ${elegido}`
      : `agregado ${elegido} <span style="opacity:.75">(la fórmula no lo tenía)</span>`;
    return `<li style="margin-top:3px">${escHtml(String(s.producto ?? '—'))} · ${escHtml(tipo)}: ${detalle}</li>`;
  }).join('');
  return `<div style="margin-bottom:12px;padding:8px 10px;border:1px solid #bfdbfe;background:var(--md-info-container);color:var(--md-info);border-radius:var(--radius-sm);font-size:12px">
      <strong>📦 Envases y tapas según la planificación (${sustituciones.length})</strong>
      <div style="margin-top:2px;opacity:.85">Reemplazan a los que indica la fórmula del producto.</div>
      <ul style="margin:6px 0 0 18px">${filas}</ul>
    </div>`;
}

// Detalle plegable con el comprobante de SiGA de cada ítem del plan y los
// componentes que se movieron por él. Va al pie del modal para no ensanchar la
// tabla de componentes, que está agregada por PLU (un mismo componente puede
// venir de varios ítems, así que no admite una única columna "Movimiento").
function bloquePorItemReserva(porItem) {
  const items = Array.isArray(porItem) ? porItem : [];
  const conSello = items.filter(i =>
    selloMovItem(i && i.reservaMovimiento) || selloMovItem(i && i.reservaDevuelta));
  if (!conSello.length) return '';

  const filas = items.map(i => {
    const chip  = chipMovimientoItem(i)
      || '<span class="pres-chip MUTED mov-chip" title="Este ítem no se movió a SiGA">sin movimiento</span>';
    const comps = Array.isArray(i && i.componentes) ? i.componentes : [];
    const lista = comps.length
      ? `<ul style="margin:3px 0 0 18px">${comps.map(c =>
          `<li>${escHtml(etiquetaComponente(c))} × <strong>${escHtml(fmtCant(c && c.cantidad))}</strong></li>`).join('')}</ul>`
      : '<div style="margin-top:3px;opacity:.75">Sin componentes de fórmula.</div>';
    return `<li style="margin-top:6px">
        <strong>${escHtml(String(i?.producto ?? '—'))}</strong> · ${chip}
        ${lista}
      </li>`;
  }).join('');

  return `<details style="margin-top:12px;border:1px solid var(--md-outline-variant);border-radius:var(--radius-sm);padding:8px 10px;font-size:12px">
      <summary style="cursor:pointer;font-weight:700">🧾 Detalle por ítem (${items.length})</summary>
      <div style="margin-top:2px;color:var(--muted)">Con qué movimiento de SiGA se reservó o se devolvió cada ítem.</div>
      <ul style="margin:6px 0 0 18px;list-style:none;padding-left:0">${filas}</ul>
    </details>`;
}

// Una línea legible por cada cambio detectado entre el plan reservado y el actual.
function textoCambioReserva(c) {
  const producto = String(c?.producto ?? '—');
  switch (c?.tipo) {
    case 'agregado':  return `${producto}: agregado al plan`;
    case 'quitado':   return `${producto}: quitado del plan`;
    case 'cantidad':  return `${producto}: cantidad ${fmtCant(c.antes)} → ${fmtCant(c.ahora)}`;
    case 'packaging': return `${producto}: envase o tapa modificados`;
    default:          return `${producto}: modificado`;
  }
}

const ESTILO_AVISO_AMBAR =
  'margin-bottom:12px;padding:10px 12px;border:1px solid var(--amb-border);background:var(--amb-bg);color:var(--amb-text);border-radius:var(--radius-sm);font-size:12px';

// Reserva hecha y plan sin cambios: no se puede volver a enviar.
function bloqueYaReservado(activa) {
  return `<div style="${ESTILO_AVISO_AMBAR}">
      <div style="font-weight:700;font-size:13px">ℹ Este plan ya fue reservado (comprobante #${escHtml(String(activa.numeroMovimiento ?? ''))}).</div>
      <div style="margin-top:3px">Para volver a enviarlo, modificá las órdenes del plan del día.</div>
    </div>`;
}

// Reserva hecha y plan modificado: sólo se mueve la diferencia.
function bloqueCambiosReserva(activa) {
  const cambios = cambiosReserva();
  const lista = cambios.length
    ? `<ul style="margin:6px 0 0 18px">${cambios.map(c => `<li style="margin-top:3px">${escHtml(textoCambioReserva(c))}</li>`).join('')}</ul>`
    : '<div style="margin-top:3px;opacity:.85">No se pudo detallar qué cambió en el plan.</div>';
  return `<div style="${ESTILO_AVISO_AMBAR}">
      <div style="font-weight:700;font-size:13px">⚠ El plan cambió desde la reserva #${escHtml(String(activa.numeroMovimiento ?? ''))}. Se va a mover solo la diferencia.</div>
      ${cambios.length ? `<div style="margin-top:3px;opacity:.85">${cambios.length} cambio${cambios.length !== 1 ? 's' : ''} detectado${cambios.length !== 1 ? 's' : ''}:</div>` : ''}
      ${lista}
    </div>`;
}

// Tabla de diferencias entre lo reservado y lo que necesita el plan actual.
function tablaDeltaReserva() {
  const filas = deltaReserva()
    .slice()
    .sort((a, b) => Math.abs(Number(b?.delta) || 0) - Math.abs(Number(a?.delta) || 0));

  if (!filas.length) {
    return `<div style="${ESTILO_AVISO_AMBAR}">
        No hay diferencias de materiales para mover: al actualizar sólo se sincroniza la reserva con el plan.
      </div>`;
  }

  const cuerpo = filas.map(f => {
    const d     = Number(f?.delta) || 0;
    const color = d > 0 ? 'var(--grn-text)' : d < 0 ? 'var(--red-text)' : 'var(--muted)';
    const txt   = d > 0 ? '+' + fmtCant(d) : fmtCant(d);
    return `<tr style="border-bottom:1px solid var(--md-outline-variant)">
        <td style="padding:6px 8px;font-size:11px;color:var(--muted)">${escHtml(String(f?.plu ?? ''))}</td>
        <td style="padding:6px 8px">${escHtml(String(f?.nombre ?? ''))}</td>
        <td style="text-align:right;padding:6px 8px">${escHtml(fmtCant(f?.reservado))}</td>
        <td style="text-align:right;padding:6px 8px">${escHtml(fmtCant(f?.objetivo))}</td>
        <td style="text-align:right;padding:6px 8px;font-weight:700;color:${color}">${escHtml(txt)}</td>
      </tr>`;
  }).join('');

  return `<div style="margin-bottom:12px">
      <div style="font-size:12px;font-weight:700;color:var(--amb-text);margin-bottom:4px">🔁 Diferencias a mover (${filas.length})</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="background:var(--md-surface-2)">
          <th style="text-align:left;padding:5px 8px;font-size:11px;color:var(--muted)">PLU</th>
          <th style="text-align:left;padding:5px 8px;font-size:11px;color:var(--muted)">Nombre</th>
          <th style="text-align:right;padding:5px 8px;font-size:11px;color:var(--muted)">Reservado</th>
          <th style="text-align:right;padding:5px 8px;font-size:11px;color:var(--muted)">Objetivo</th>
          <th style="text-align:right;padding:5px 8px;font-size:11px;color:var(--muted)">Diferencia</th>
        </tr></thead>
        <tbody>${cuerpo}</tbody>
      </table>
    </div>`;
}

// La reserva se anuló sola: sus movimientos se revirtieron desde el historial.
function bloqueAnuladaPorLog(info) {
  return `<div style="margin-bottom:12px;padding:10px 12px;border:1px solid #bfdbfe;background:var(--md-info-container);color:var(--md-info);border-radius:var(--radius-sm);font-size:12px">
      <div style="font-weight:700;font-size:13px">ℹ Esta reserva fue anulada porque sus movimientos se revirtieron desde el historial (${escHtml(fmtFechaHoraMov(info.fecha))}).</div>
      <div style="margin-top:3px">El plan quedó sin reserva: podés volver a reservar cuando quieras.</div>
    </div>`;
}

// La reserva sigue activa pero el log dice otra cosa: hay que revisarla a mano.
function bloqueDesincronizadaReserva(activa, info) {
  const saldo = Array.isArray(info.saldoSegunLog) ? info.saldoSegunLog : [];
  const lista = saldo.length
    ? `<ul style="margin:6px 0 0 18px">${saldo.map(l =>
        `<li style="margin-top:3px">${escHtml(etiquetaComponente(l))} × <strong>${escHtml(fmtCant(l && l.cantidad))}</strong></li>`).join('')}</ul>`
    : '<div style="margin-top:3px;opacity:.85">El log no informa qué quedó reservado.</div>';
  return `<div style="${ESTILO_AVISO_AMBAR}">
      <div style="font-weight:700;font-size:13px">⚠ La reserva #${escHtml(String(activa.numeroMovimiento ?? ''))} fue alterada desde el historial de movimientos.</div>
      <div style="margin-top:3px">Según el log quedan reservados:</div>
      ${lista}
      <div style="margin-top:6px">Revisá y anulá la reserva antes de seguir.</div>
    </div>`;
}

// La reserva pertenece a otra sucursal: se puede consultar, pero no operar.
function bloqueSucursalDistinta(info) {
  const dela   = info.deLaReserva;
  const pedida = info.pedida;
  return `<div style="${ESTILO_AVISO_AMBAR}">
      <div style="font-weight:700;font-size:13px">⚠ La reserva activa de este plan se hizo en la ${escHtml(etiquetaSucursal(dela))}.</div>
      <div style="margin-top:3px">Estás trabajando en la <strong>${escHtml(etiquetaSucursal(pedida))}</strong>. Cambiá a esa sucursal para poder actualizarla o anularla.</div>
      <div style="margin-top:3px;opacity:.85">Los depósitos y el stock que se ven acá son los de la sucursal en la que estás trabajando.</div>
    </div>`;
}

// Aviso de cabecera del modal según el estado de la reserva frente al plan actual.
function bloqueEstadoReserva(activa) {
  const otraSucursal = sucursalDistintaReserva();
  const avisoSuc     = otraSucursal ? bloqueSucursalDistinta(otraSucursal) : '';

  if (!activa) {
    const anulada = reservaAnuladaPorLog();
    return avisoSuc + (anulada ? bloqueAnuladaPorLog(anulada) : '');
  }
  // La desincronización manda sobre todo lo demás: mientras no se resuelva no tiene
  // sentido ofrecer actualizar la reserva contra un saldo que no es el real.
  const desinc = reservaDesincronizada();
  if (desinc) return avisoSuc + bloqueDesincronizadaReserva(activa, desinc);
  if (!reservaDesactualizada()) return avisoSuc + bloqueYaReservado(activa);
  return avisoSuc + bloqueCambiosReserva(activa) + tablaDeltaReserva();
}

function renderReservaModal() {
  const data       = reservaCache || {};
  const cfg        = data.config || {};
  const comps      = Array.isArray(data.componentes)     ? data.componentes     : [];
  const sinFormula = Array.isArray(data.itemsSinFormula) ? data.itemsSinFormula : [];
  const sustit     = Array.isArray(data.sustituciones)   ? data.sustituciones   : [];
  const activa     = reservaActiva();

  renderSelectsDeposito(activa);
  const origen  = document.getElementById('selDepOrigen').value;
  const destino = document.getElementById('selDepDestino').value;
  const mismoDeposito = origen !== '' && origen === destino;
  const completo      = origen !== '' && destino !== '' && !mismoDeposito;

  setAvisoReserva(mismoDeposito && !activa
    ? 'El depósito de origen y el de destino deben ser distintos'
    : '');

  // La sucursal elegida en la barra manda; el config del servidor sólo es el respaldo.
  const idSuc       = sucursalActual() ?? cfg.idSucursal;
  const sucursalTxt = ` · ${escHtml(etiquetaSucursal(idSuc))}`;
  const notaEnvases = '<div style="margin-top:2px;opacity:.85">El envase y la tapa elegidos en la planificación reemplazan a los de la fórmula.</div>';
  const info = document.getElementById('reservaInfo');
  if (completo) {
    info.style.background = 'var(--grn-bg)';
    info.style.color      = 'var(--grn-text)';
    info.innerHTML = `Movimiento: <strong>${escHtml(etiquetaDeposito(origen))} → ${escHtml(etiquetaDeposito(destino))}</strong>${sucursalTxt}` + notaEnvases;
  } else {
    info.style.background = 'var(--amb-bg)';
    info.style.color      = 'var(--amb-text)';
    info.innerHTML = 'Elegí el depósito de <strong>origen</strong> y el de <strong>destino</strong> del movimiento.' + sucursalTxt + notaEnvases;
  }

  const conFaltante = comps.filter(c => Number(c.faltante) > 0).length;

  const avisoSinFormula = sinFormula.length
    ? `<div style="margin-bottom:12px;padding:8px 10px;border:1px solid var(--amb-border);background:var(--amb-bg);color:var(--amb-text);border-radius:var(--radius-sm);font-size:12px">
        <strong>⚠ ${sinFormula.length} producto${sinFormula.length !== 1 ? 's' : ''} sin fórmula activa, no se reservan:</strong>
        <ul style="margin:6px 0 0 18px">
          ${sinFormula.map(i => `<li>${escHtml(i.producto)}${i.idProducto != null ? ` <span style="opacity:.7">(PLU ${escHtml(String(i.idProducto))})</span>` : ''}</li>`).join('')}
        </ul>
      </div>`
    : '';

  const bloqueReserva = activa
    ? `<div style="margin-bottom:12px;padding:10px 12px;border:1px solid var(--grn-border);background:var(--grn-bg);border-radius:var(--radius-sm);font-size:12px;color:var(--grn-text)">
        <div style="font-weight:700;font-size:13px">🔒 Reserva activa · comprobante #${escHtml(String(activa.numeroMovimiento ?? ''))}</div>
        <div style="margin-top:2px">Fecha: ${escHtml(String(activa.fecha ?? '—'))} · Usuario: ${escHtml(String(activa.usuario ?? '—'))}</div>
        <div style="margin-top:2px">Movido: <strong>${escHtml(etiquetaDeposito(activa.depOrigen))} → ${escHtml(etiquetaDeposito(activa.depDestino))}</strong></div>
        <div style="margin-top:8px;font-weight:600">Líneas reservadas (${(activa.lineas || []).length})</div>
        <ul style="margin:4px 0 0 18px">
          ${(activa.lineas || []).map(l => `<li>${escHtml(l.nombre)} <span style="opacity:.7">(PLU ${escHtml(String(l.plu))})</span>: <strong>${escHtml(fmtCant(l.cantidad))}</strong></li>`).join('')}
        </ul>
        ${(activa.devoluciones || []).length ? `
        <div style="margin-top:8px;font-weight:600">Devoluciones realizadas (${activa.devoluciones.length})</div>
        <ul style="margin:4px 0 0 18px">
          ${activa.devoluciones.map(d => `<li>#${escHtml(String(d.numeroMovimiento ?? ''))} · ${escHtml(String(d.fecha ?? '—'))}${d.itemId != null ? ` · ítem ${escHtml(String(d.itemId))}` : ''} · ${(d.lineas || []).length} línea${(d.lineas || []).length !== 1 ? 's' : ''}</li>`).join('')}
        </ul>` : ''}
      </div>`
    : '';

  const tabla = comps.length
    ? `<table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="background:var(--md-surface-2)">
          <th style="text-align:left;padding:5px 8px;font-size:11px;color:var(--muted)">PLU</th>
          <th style="text-align:left;padding:5px 8px;font-size:11px;color:var(--muted)">Componente</th>
          <th style="text-align:left;padding:5px 8px;font-size:11px;color:var(--muted)">Rubro</th>
          <th style="text-align:right;padding:5px 8px;font-size:11px;color:var(--muted)">Necesario</th>
          <th style="text-align:right;padding:5px 8px;font-size:11px;color:var(--muted)">Stock origen</th>
          <th style="text-align:right;padding:5px 8px;font-size:11px;color:var(--muted)">Stock destino</th>
          <th style="text-align:right;padding:5px 8px;font-size:11px;color:var(--muted)">Faltante</th>
        </tr></thead><tbody>
        ${comps.map(c => {
          const falta = Number(c.faltante) > 0;
          return `<tr style="border-bottom:1px solid var(--md-outline-variant)${falta ? ';background:var(--red-bg);color:var(--red-text)' : ''}">
            <td style="padding:6px 8px;font-size:11px;color:var(--muted)">${escHtml(String(c.plu ?? ''))}</td>
            <td style="padding:6px 8px${falta ? ';font-weight:600' : ''}">${falta ? '⚠ ' : ''}${escHtml(c.nombre)}${chipOrigenComponente(c)}</td>
            <td style="padding:6px 8px;font-size:12px">${escHtml(c.rubro || '')}</td>
            <td style="text-align:right;padding:6px 8px;font-family:system-ui,sans-serif;font-weight:700">${escHtml(fmtCant(c.necesario))}</td>
            <td style="text-align:right;padding:6px 8px">${escHtml(fmtCant(c.stockOrigen))}</td>
            <td style="text-align:right;padding:6px 8px">${escHtml(fmtCant(c.stockDestino))}</td>
            <td style="text-align:right;padding:6px 8px;font-weight:700;color:${falta ? 'var(--red-text)' : 'var(--grn-text)'}">${falta ? escHtml(fmtCant(c.faltante)) : '—'}</td>
          </tr>`;
        }).join('')}
        </tbody>
        <tfoot><tr style="background:var(--md-surface-2);font-size:12px">
          <td colspan="3" style="padding:6px 8px;font-weight:700">Totales</td>
          <td colspan="3" style="text-align:right;padding:6px 8px;color:var(--muted)">${comps.length} componente${comps.length !== 1 ? 's' : ''}</td>
          <td style="text-align:right;padding:6px 8px;font-weight:700;color:${conFaltante ? 'var(--red-text)' : 'var(--grn-text)'}">${conFaltante ? `${conFaltante} con faltante` : 'sin faltantes'}</td>
        </tr></tfoot></table>`
    : '<div style="color:var(--muted);font-size:13px;padding:8px 0">No hay componentes de fórmula para reservar en este plan.</div>';

  const resumen = comps.length
    ? `<div style="margin-bottom:8px;font-size:12px;color:${conFaltante ? 'var(--red-text)' : 'var(--muted)'}">
        ${comps.length} componente${comps.length !== 1 ? 's' : ''}${conFaltante ? ` · ${conFaltante} con faltante de stock` : ' · stock suficiente'}
      </div>`
    : '';

  // El bloque es informativo: si la respuesta trae algo inesperado, el modal
  // igual tiene que poder mostrar la tabla de componentes.
  let avisoSustituciones = '';
  try {
    avisoSustituciones = bloqueSustitucionesReserva(sustit);
  } catch (e) {
    toast('No se pudo mostrar el detalle de envases y tapas: ' + e.message, true);
  }

  // El aviso de estado es informativo: si la respuesta trae algo inesperado,
  // el modal igual tiene que poder mostrar la tabla de componentes.
  let avisoEstado = '';
  try {
    avisoEstado = bloqueEstadoReserva(activa);
  } catch (e) {
    toast('No se pudo mostrar el estado de la reserva: ' + e.message, true);
  }

  // Ídem: el detalle por ítem no puede impedir que se vean los componentes.
  let detallePorItem = '';
  try {
    detallePorItem = bloquePorItemReserva(data.porItem);
  } catch (e) {
    toast('No se pudo mostrar el detalle por ítem: ' + e.message, true);
  }

  document.getElementById('reservaBody').innerHTML =
    avisoEstado + bloqueReserva + avisoSinFormula + avisoSustituciones + resumen + tabla + detallePorItem;

  const btnOk  = document.getElementById('btnConfirmarReserva');
  const btnAnu = document.getElementById('btnAnularReserva');

  const desincronizada = reservaDesincronizada();

  if (desincronizada) {
    // Sólo queda anular: mover diferencias contra un saldo que no es el real
    // desajustaría todavía más el depósito de reserva.
    btnOk.textContent = '🔒 Reservar';
    btnOk.disabled    = true;
    btnOk.title       = 'La reserva fue alterada desde el historial de movimientos: anulala antes de volver a operar';
  } else if (reservaDesactualizada()) {
    btnOk.textContent = '🔄 Actualizar reserva';
    btnOk.disabled    = false;
    btnOk.title       = 'Mover solo la diferencia entre lo reservado y el plan actual';
  } else if (activa) {
    btnOk.textContent = '🔒 Reservar';
    btnOk.disabled    = true;
    btnOk.title       = `Este plan ya fue reservado (comprobante #${activa.numeroMovimiento ?? ''}). Para volver a enviarlo, modificá las órdenes del plan del día.`;
  } else {
    btnOk.textContent = '🔒 Reservar';
    btnOk.disabled    = !completo || comps.length === 0;
    btnOk.title       = mismoDeposito
      ? 'El depósito de origen y el de destino deben ser distintos'
      : (origen === '' || destino === '')
        ? 'Elegí el depósito de origen y el de destino'
        : comps.length === 0
          ? 'No hay componentes de fórmula para reservar'
          : 'Mover los componentes al depósito de destino';
  }

  btnAnu.style.display = activa ? '' : 'none';
  btnAnu.disabled      = false;
  btnAnu.title         = 'Devolver todo al depósito de origen';

  // Anular devuelve TODO el saldo al depósito de origen. Si alguna orden reservada ya se
  // produjo y recepcionó, sus componentes salieron del depósito de reserva al recepcionar el
  // artículo final: devolverlos escribiría en SiGA stock que no existe. El servidor también lo
  // rechaza, pero acá el botón directamente no se puede clickear.
  const bloqueoProd = bloqueoProduccionReservaActiva();
  if (activa && bloqueoProd) {
    btnAnu.disabled = true;
    btnAnu.title    = bloqueoProd;
  }

  // Reserva de otra sucursal: el servidor rechaza toda escritura, así que no se
  // ofrece el intento (el usuario no tiene que descubrirlo con un error).
  const otraSucursal = sucursalDistintaReserva();
  if (otraSucursal) {
    const motivo = `La reserva es de la ${etiquetaSucursal(otraSucursal.deLaReserva)}: cambiá a esa sucursal para operarla`;
    btnOk.disabled  = true;
    btnOk.title     = motivo;
    btnAnu.disabled = true;
    btnAnu.title    = motivo;
  }
}

// Motivo por el que la reserva activa no se puede anular, o '' si se puede. Mira los ítems
// reservados que además tienen sello de producción recepcionada: son los que ya consumieron
// sus componentes. Es el mismo criterio que la guarda del servidor en ejecutarDevolucionReserva.
function bloqueoProduccionReservaActiva() {
  const items = (planCache && Array.isArray(planCache.items)) ? planCache.items : [];
  const producidas = items.filter(it =>
    it && it.reservaMovimiento && it.reservaMovimiento.numeroMovimiento != null &&
    it.produccionMovimiento && it.produccionMovimiento.numeroMovimiento != null);
  if (!producidas.length) return '';

  const una     = producidas.length === 1;
  const detalle = producidas
    .map(it => `"${it.producto || it.id}" (movimiento #${it.produccionMovimiento.numeroMovimiento})`)
    .join(', ');
  return `No se puede devolver la reserva: ${una ? 'la orden' : 'las órdenes'} ${detalle} ya `
       + `${una ? 'fue producida y recepcionada' : 'fueron producidas y recepcionadas'}. `
       + 'Los componentes ya se consumieron.';
}

// Vuelve a pedir el estado al servidor y repinta el modal (que sigue abierto).
async function refrescarModalReserva() {
  if (!fechaPlanActual) return;
  const selO = document.getElementById('selDepOrigen');
  const selD = document.getElementById('selDepDestino');
  let vigente = false;
  try {
    vigente = await cargarReserva(selO ? selO.value : null, selD ? selD.value : null, true);
  } catch (e) {
    toast('Error al actualizar el estado de la reserva: ' + e.message, true);
    return;
  }
  if (!vigente) return;
  renderReservaModal();
  aplicarEstadoBotonReserva();
}

// Se cambió de sucursal con el modal abierto: los ids de depósito son por sucursal,
// así que se descarta la selección anterior y se pide la preselección de la nueva.
async function recargarModalReservaPorSucursal() {
  if (!fechaPlanActual) return;
  const selO = document.getElementById('selDepOrigen');
  const selD = document.getElementById('selDepDestino');
  if (selO) selO.value = '';
  if (selD) selD.value = '';

  let vigente = false;
  try {
    vigente = await cargarReserva(null, null, true);
  } catch (e) {
    errorEnBodyReserva('Error al cargar la reserva de la sucursal: ' + e.message);
    toast('Error al cargar la reserva: ' + e.message, true);
    return;
  }
  if (!vigente) return;
  renderReservaModal();
  aplicarEstadoBotonReserva();
}

async function confirmarReserva(permitirFaltante) {
  if (!fechaPlanActual) return;
  // Guarda del lado de la salida: el modal se puede abrir desde el chip de una reserva vieja.
  if (!movStockHabilitado()) {
    toast('La carga por movimientos de stock está desactivada en este equipo', true);
    return;
  }
  const depOrigen  = document.getElementById('selDepOrigen').value;
  const depDestino = document.getElementById('selDepDestino').value;
  if (!depOrigen || !depDestino) {
    toast('Elegí el depósito de origen y el de destino', true);
    return;
  }
  if (depOrigen === depDestino) {
    setAvisoReserva('El depósito de origen y el de destino deben ser distintos');
    toast('El depósito de origen y el de destino deben ser distintos', true);
    return;
  }

  const btn = document.getElementById('btnConfirmarReserva');
  btn.disabled = true;

  let resp;
  try {
    resp = await postReserva(`/api/plan/${fechaPlanActual}/reservar`, bodyConSucursal({
      depOrigen, depDestino, permitirFaltante: !!permitirFaltante
    }));
  } catch (e) {
    toast('Error al reservar: ' + e.message, true);
    btn.disabled = false;
    return;
  }

  if (resp.error) {
    // El plan ya estaba reservado: se avisa y se repinta el modal para que
    // aparezca la alerta (y, si el plan cambió, el botón de actualizar).
    if (resp.yaReservado || resp.requiereActualizar) {
      toast(String(resp.error), true);
      btn.disabled = false;
      await refrescarModalReserva();
      return;
    }
    const faltantes = Array.isArray(resp.faltantes) ? resp.faltantes : [];
    if (faltantes.length && !permitirFaltante) {
      const ok = await confirmarModalAsync('Stock insuficiente',
        htmlFaltantesStock(faltantes, depOrigen, '¿Reservar igual lo disponible?'),
        'Reservar igual', true);
      if (ok) return confirmarReserva(true);
      btn.disabled = false;
      return;
    }
    toast(String(resp.error), true);
    btn.disabled = false;
    return;
  }

  toast(`Reserva #${resp.numeroMovimiento} creada`);
  cerrarModalReserva();
  try { await cargarPlan(fechaPlanActual); }
  catch (e) { toast('Error al refrescar el plan: ' + mensajeApiError(e), true); return; }
  // El plan ya está refrescado, así que los ítems traen su reservaMovimiento
  // nuevo: se puede ofrecer enviar a producción sólo lo recién reservado.
  ofrecerEnviarAProduccionTrasReserva(resp.numeroMovimiento);
}

// Tras reservar con éxito, pregunta si las órdenes recién selladas con ese
// movimiento se envían directo a Producción del Día.
function ofrecerEnviarAProduccionTrasReserva(numeroMovimiento) {
  const ordenes = ordenesRecienReservadas(numeroMovimiento);
  if (!ordenes.length) return;
  confirmarModal(
    'Enviar a producción',
    `Reserva #${numeroMovimiento} hecha. ¿Enviar las órdenes recién reservadas a producción?`,
    'Enviar a producción',
    async () => {
      const aEnviar = ordenesRecienReservadas(numeroMovimiento);
      if (!aEnviar.length) { toast('No hay órdenes nuevas para enviar', true); return; }
      try { await postOrdenesProduccion(aEnviar); }
      catch (e) { toast('Error al enviar: ' + mensajeApiError(e), true); }
    });
}

// El plan cambió después de reservar: se mueve sólo la diferencia (puede generar
// un movimiento de reserva y otro de devolución).
async function actualizarReserva(permitirFaltante) {
  const activa = reservaActiva();
  if (!fechaPlanActual || !activa) return;

  const btn = document.getElementById('btnConfirmarReserva');
  btn.disabled = true;

  let resp;
  try {
    resp = await postReserva(`/api/plan/${fechaPlanActual}/reserva/actualizar`, bodyConSucursal({
      permitirFaltante: !!permitirFaltante
    }));
  } catch (e) {
    toast('Error al actualizar la reserva: ' + e.message, true);
    btn.disabled = false;
    return;
  }

  if (resp.error) {
    const faltantes = Array.isArray(resp.faltantes) ? resp.faltantes : [];
    if (faltantes.length && !permitirFaltante) {
      const ok = await confirmarModalAsync('Stock insuficiente',
        htmlFaltantesStock(faltantes, activa.depOrigen, '¿Mover igual lo disponible?'),
        'Mover igual', true);
      if (ok) return actualizarReserva(true);
      btn.disabled = false;
      return;
    }
    toast(String(resp.error), true);
    btn.disabled = false;
    await refrescarModalReserva();
    return;
  }

  const movs = Array.isArray(resp.movimientos) ? resp.movimientos : [];
  const detalleMovs = movs
    .map(m => `${m.sentido === 'devolucion' ? 'devolución' : 'reserva'} #${m.numeroMovimiento}`)
    .join(' · ');
  toast(detalleMovs ? `Reserva actualizada — ${detalleMovs}` : 'Reserva actualizada');
  cerrarModalReserva();
  try { await cargarPlan(fechaPlanActual); }
  catch (e) { toast('Error al refrescar el plan: ' + e.message, true); }
}

// El botón principal reserva o actualiza según el estado del plan.
function onClickBotonReserva() {
  if (reservaDesincronizada()) {
    toast('La reserva fue alterada desde el historial de movimientos: anulala antes de volver a operar', true);
    return;
  }
  if (reservaDesactualizada()) actualizarReserva(false);
  else confirmarReserva(false);
}

async function anularReserva() {
  const activa = reservaActiva();
  if (!activa || !fechaPlanActual) return;
  // El botón ya sale deshabilitado en este caso; esto cubre que se haya producido con el
  // modal abierto, para no llegar nunca al confirm.
  const bloqueoProd = bloqueoProduccionReservaActiva();
  if (bloqueoProd) { toast(bloqueoProd, true); return; }

  const okAnular = await confirmarModalAsync('Anular reserva',
    `¿Anular la reserva <strong>#${escHtml(String(activa.numeroMovimiento ?? ''))}</strong>?
     <div style="margin-top:6px">Todos los componentes vuelven a
       <strong>${escHtml(etiquetaDeposito(activa.depOrigen))}</strong>.</div>`,
    'Anular reserva', true);
  if (!okAnular) return;

  const btn = document.getElementById('btnAnularReserva');
  btn.disabled = true;

  let resp;
  try {
    resp = await postReserva(`/api/plan/${fechaPlanActual}/reserva/devolver`, bodyConSucursal({}));
  } catch (e) {
    toast('Error al anular: ' + e.message, true);
    btn.disabled = false;
    return;
  }

  if (resp.error) {
    toast(String(resp.error), true);
    btn.disabled = false;
    return;
  }

  toast(`Reserva anulada — devolución #${resp.numeroMovimiento}`);
  cerrarModalReserva();
  try { await cargarPlan(fechaPlanActual); }
  catch (e) { toast('Error al refrescar el plan: ' + e.message, true); }
}

document.getElementById('btnReservaMerc').addEventListener('click', abrirModalReserva);
document.getElementById('cerrarReserva').addEventListener('click', cerrarModalReserva);
document.getElementById('btnCerrarReservaFooter').addEventListener('click', cerrarModalReserva);
document.getElementById('btnConfirmarReserva').addEventListener('click', onClickBotonReserva);
document.getElementById('btnAnularReserva').addEventListener('click', anularReserva);
document.getElementById('selDepOrigen').addEventListener('change', onCambioDeposito);
document.getElementById('selDepDestino').addEventListener('change', onCambioDeposito);
document.getElementById('overlayReserva').addEventListener('click', e => {
  if (e.target === e.currentTarget) cerrarModalReserva();
});
