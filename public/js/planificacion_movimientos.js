
// ═════════════ HISTORIAL DE MOVIMIENTOS DE STOCK ════════════════
// Log persistente de todos los movimientos ejecutados contra SiGA, con
// reversión de emergencia. El camino normal para deshacer una reserva sigue
// siendo el botón "Anular reserva" del modal de reserva.

const MOV_STOCK_LIMITE  = 200;
// El usuario que firma los movimientos NO se define acá: lo pone el servidor desde
// config.json (reserva.usuario), para que se cambie en un solo lugar.

let movStockCache = [];   // último GET /api/stock/movimientos (más nuevo primero)

// Los colores salen de las variables ya definidas en el CSS del módulo.
const ESTADO_MOV_STOCK = {
  confirmado: { texto: 'Confirmado', bg: 'var(--grn-bg)',       color: 'var(--grn-text)', borde: 'var(--grn-border)',           extra: '' },
  pendiente : { texto: 'Pendiente',  bg: 'var(--amb-bg)',       color: 'var(--amb-text)', borde: 'var(--amb-border)',           extra: '' },
  fallido   : { texto: 'Fallido',    bg: 'var(--red-bg)',       color: 'var(--red-text)', borde: 'var(--red-border)',           extra: '' },
  revertido : { texto: 'Revertido',  bg: 'var(--md-surface-2)', color: 'var(--muted)',    borde: 'var(--md-outline-variant)',   extra: 'text-decoration:line-through' }
};

function estiloEstadoMovStock(estado) {
  return ESTADO_MOV_STOCK[estado] || {
    texto: String(estado || '—'), bg: 'var(--md-surface-2)', color: 'var(--muted)',
    borde: 'var(--md-outline-variant)', extra: ''
  };
}

// "22/07 26 14:35" a partir de un ISO-8601, en hora local.
function fmtFechaHoraMov(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getFullYear() % 100)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// "1 → 99", o sólo el depósito cuando el movimiento no tiene destino.
function depositosMovStock(m) {
  const o = (m?.depOrigen  == null || m.depOrigen  === '') ? '—' : String(m.depOrigen);
  const d = (m?.depDestino == null || m.depDestino === '') ? null : String(m.depDestino);
  return d === null ? o : `${o} → ${d}`;
}

// Detalle para el title de la celda de líneas: "6333 Envase 500g × 12"
function detalleLineasMovStock(m) {
  const lineas = Array.isArray(m?.lineas) ? m.lineas : [];
  if (!lineas.length) return 'Sin líneas registradas';
  return lineas
    .map(l => `${l?.plu ?? '—'} ${String(l?.nombre ?? '').trim()} × ${fmtCant(l?.cantidad)}`)
    .join('\n');
}

// Motivo por el que un registro no se puede revertir (null = sí se puede).
function motivoNoRevertibleMovStock(m) {
  if (!m) return 'Registro inválido';
  if (m.revertidoPor != null && m.revertidoPor !== '')
    return `Ya fue revertido por el movimiento #${m.revertidoPor}`;
  switch (m.estado) {
    case 'confirmado': return null;
    case 'pendiente' : return 'Quedó pendiente: hay que verificarlo en SiGA antes de tocarlo';
    case 'fallido'   : return 'No llegó a ejecutarse: no hay nada para revertir';
    case 'revertido' : return 'Este movimiento ya fue revertido';
    default          : return 'Sólo se pueden revertir los movimientos confirmados';
  }
}

// Caja ámbar persistente: no se usa toast porque estas advertencias importan.
function setAdvertenciaMovStock(msgs) {
  const el = document.getElementById('movStockAdvertencia');
  if (!el) return;
  const lista = (Array.isArray(msgs) ? msgs : [msgs]).filter(Boolean).map(String);
  if (!lista.length) { el.innerHTML = ''; el.style.display = 'none'; return; }
  el.innerHTML = '<strong>⚠ Advertencia del servidor</strong>'
    + `<ul style="margin:4px 0 0 18px">${lista.map(t => `<li style="margin-top:2px">${escHtml(t)}</li>`).join('')}</ul>`;
  el.style.display = '';
}

// Un movimiento en "pendiente" pudo haberse escrito en SiGA sin llegar a confirmarse.
function renderPendientesMovStock(registros) {
  const el = document.getElementById('movStockPendientes');
  if (!el) return;
  const pend = registros.filter(m => m?.estado === 'pendiente');
  if (!pend.length) { el.innerHTML = ''; el.style.display = 'none'; return; }

  const items = pend.slice(0, 10).map(m => {
    const nl = Array.isArray(m?.lineas) ? m.lineas.length : 0;
    return `<li style="margin-top:2px">${escHtml(fmtFechaHoraMov(m?.fechaHora))} · ${escHtml(String(m?.origen ?? '—'))} · ${escHtml(depositosMovStock(m))} · ${nl} línea${nl !== 1 ? 's' : ''}</li>`;
  }).join('');
  const extra = pend.length > 10 ? `<li style="margin-top:2px">… y ${pend.length - 10} más</li>` : '';

  el.innerHTML = `<div style="font-weight:700;font-size:13px">🛑 ${pend.length} movimiento${pend.length !== 1 ? 's' : ''} quedó sin confirmar</div>
      <div style="margin-top:3px">El proceso pudo haber muerto <strong>después</strong> de escribir en SiGA, así que el stock puede haberse movido igual aunque acá figure como pendiente.</div>
      <div style="margin-top:3px"><strong>Verificalo a mano en SiGA antes de reservar, revertir o volver a mover nada.</strong></div>
      <ul style="margin:6px 0 0 18px">${items}${extra}</ul>`;
  el.style.display = '';
}

// Fila expandible: datos del movimiento, observación, error y líneas.
function detalleMovStock(m) {
  const lineas = Array.isArray(m?.lineas) ? m.lineas : [];
  const items = lineas.length
    ? `<ul style="margin:4px 0 0 18px">${lineas.map(l =>
        `<li style="margin-top:2px">${escHtml(String(l?.plu ?? '—'))} ${escHtml(String(l?.nombre ?? ''))} · <strong>${escHtml(fmtCant(l?.cantidad))}</strong></li>`).join('')}</ul>`
    : '<div style="opacity:.8;margin-top:4px">Sin líneas registradas.</div>';

  const datos = [
    ['Plan',          m?.plan],
    ['Ítem',          m?.itemId],
    ['Sucursal',      m?.idSucursal],
    ['Tipo mov.',     m?.idTipoMovimiento],
    ['Usuario',       m?.usuario],
    ['Revierte a',    m?.revierteA],
    ['Revertido por', m?.revertidoPor]
  ].filter(par => par[1] != null && par[1] !== '')
   .map(par => `<span style="margin-right:12px;white-space:nowrap"><span style="color:var(--muted)">${escHtml(par[0])}:</span> ${escHtml(String(par[1]))}</span>`)
   .join('');

  const obs = String(m?.observacion ?? '').trim();
  const err = String(m?.error ?? '').trim();

  return `<div style="display:flex;flex-wrap:wrap;row-gap:3px">${datos}</div>`
    + (obs ? `<div style="margin-top:4px"><span style="color:var(--muted)">Observación:</span> ${escHtml(obs)}</div>` : '')
    + (err ? `<div style="margin-top:4px;color:var(--red-text)"><span style="color:var(--muted)">Error:</span> ${escHtml(err)}</div>` : '')
    + `<div style="margin-top:6px;font-weight:600">Líneas (${lineas.length})</div>${items}`;
}

function toggleDetalleMovStock(i) {
  const tr  = document.getElementById('movStockDet' + i);
  const btn = document.getElementById('movStockExp' + i);
  if (!tr) return;
  const abierto = tr.style.display !== 'none';
  tr.style.display = abierto ? 'none' : '';
  if (btn) {
    btn.textContent = abierto ? '▸' : '▾';
    btn.title       = abierto ? 'Ver el detalle del movimiento' : 'Ocultar el detalle';
  }
}

// Una tarjeta por reserva: comprobante, estado, órdenes que la componen y líneas movidas.
function reservaResumenCard(r, i) {
  const activa = r?.estado === 'activa';
  const est = activa
    ? { texto: 'Activa',  bg: 'var(--grn-bg)',       color: 'var(--grn-text)', borde: 'var(--grn-border)' }
    : { texto: 'Anulada', bg: 'var(--md-surface-2)', color: 'var(--muted)',    borde: 'var(--md-outline-variant)' };

  const ordenes = Array.isArray(r?.ordenes) ? r.ordenes : [];
  const ordenesHtml = ordenes.length
    ? `<ul style="margin:4px 0 0 18px;padding:0">${ordenes.map(o => {
        // La orden ya producida y recepcionada es la que bloquea el revertir: se marca en la
        // lista para que se vea de dónde sale el bloqueo sin tener que abrir el tooltip.
        const prod = o?.produccionMovimiento;
        const chip = prod == null ? ''
          : ` <span class="pres-chip" title="Producida y recepcionada: sus componentes ya se consumieron" style="background:#14532d;color:#fff;border-color:#14532d">✔ Producida #${escHtml(String(prod))}</span>`;
        return `<li style="margin-top:2px">${escHtml(String(o?.producto || o?.id || '—'))}${chip}</li>`;
      }).join('')}</ul>`
    : '<div style="opacity:.8;margin-top:4px">Sin órdenes asociadas.</div>';

  const productos = Array.isArray(r?.productos) ? r.productos : [];
  const productosHtml = productos.length
    ? `<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:4px">
        <thead><tr style="background:var(--md-surface-2)">
          <th style="text-align:left;padding:4px 6px;font-size:11px;color:var(--muted)">Producto</th>
          <th style="text-align:right;padding:4px 6px;font-size:11px;color:var(--muted)">Cantidad</th>
        </tr></thead>
        <tbody>${productos.map(p => `<tr style="border-bottom:1px solid var(--md-outline-variant)">
            <td style="padding:4px 6px">${escHtml(String(p?.plu ?? '—'))} ${escHtml(String(p?.nombre ?? ''))}</td>
            <td style="padding:4px 6px;text-align:right">${escHtml(fmtCant(p?.cantidad))}</td>
          </tr>`).join('')}</tbody>
      </table>`
    : '<div style="opacity:.8;margin-top:4px">Sin líneas registradas.</div>';

  // El servidor manda el motivo cuando la reserva tiene órdenes ya producidas y recepcionadas.
  // En ese caso el botón sale deshabilitado: revertir devolvería al depósito de origen
  // componentes que ya se consumieron, dejando stock inventado en SiGA.
  const bloqueo = typeof r?.bloqueoProduccion === 'string' ? r.bloqueoProduccion.trim() : '';
  const puedeRevertir = activa && r?.idRegistro != null && r.idRegistro !== '';
  const btnRev = !puedeRevertir
    ? ''
    : bloqueo
    ? `<button class="btn btn-danger btn-sm" disabled title="${escHtml(bloqueo)}" style="opacity:.45;cursor:not-allowed">↩ Revertir</button>`
    : `<button class="btn btn-danger btn-sm" id="movStockRev${i}" onclick="revertirMovStock(${i})" title="Generar el movimiento inverso en SiGA">↩ Revertir</button>`;

  const avisoBloqueo = (puedeRevertir && bloqueo)
    ? `<div style="margin-top:8px;padding:6px 8px;border:1px solid var(--md-outline-variant);background:var(--md-surface-2);border-radius:var(--radius-sm);font-size:12px;color:var(--muted)">🔒 ${escHtml(bloqueo)}</div>`
    : '';

  return `<div style="border:1px solid var(--md-outline-variant);border-radius:8px;padding:10px 12px;margin-bottom:10px;${activa ? '' : 'opacity:.6'}">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="font-family:system-ui,sans-serif;font-weight:700;font-size:16px">#${escHtml(String(r?.numeroMovimiento ?? '—'))}</span>
        <span class="pres-chip" style="background:${est.bg};color:${est.color};border:1px solid ${est.borde}">${est.texto}</span>
        ${r?.origen === 'ajuste' ? '<span class="pres-chip" title="Ajuste de una reserva ya hecha: revertirlo devuelve lo que movió y libera sus órdenes">Ajuste</span>' : ''}
        <span style="font-size:12px;color:var(--muted)">${escHtml(fmtFechaHoraMov(r?.fechaPlanificacion))}</span>
        <span style="margin-left:auto">${btnRev}</span>
      </div>
      ${avisoBloqueo}
      <div style="margin-top:8px;font-size:12px"><strong>Órdenes</strong>${ordenesHtml}</div>
      <div style="margin-top:8px;font-size:12px"><strong>Productos</strong>${productosHtml}</div>
    </div>`;
}

function renderMovStock(reservas) {
  const body = document.getElementById('movStockBody');
  if (!body) return;

  if (!reservas.length) {
    body.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px 0">Sin reservas registradas para este plan.</div>';
    return;
  }

  body.innerHTML = reservas.map((r, i) => reservaResumenCard(r, i)).join('');
}

async function cargarMovStock() {
  const body = document.getElementById('movStockBody');
  const info = document.getElementById('movStockFiltroInfo');

  if (body) body.innerHTML = '<div style="color:var(--muted);font-size:13px">Cargando…</div>';
  if (info) info.textContent = 'Consultando…';

  if (!fechaPlanActual) {
    movStockCache = [];
    renderMovStock(movStockCache);
    if (info) info.textContent = 'No hay un día seleccionado';
    return;
  }

  let data;
  try {
    data = await api('GET', conSucursal(`/api/plan/${encodeURIComponent(fechaPlanActual)}/reservas-resumen`));
  } catch (e) {
    movStockCache = [];
    if (body) body.innerHTML = `<div style="color:var(--red-text);font-size:13px">Error al cargar el resumen: ${escHtml(e.message)}</div>`;
    if (info) info.textContent = '';
    toast('Error al cargar el resumen de reservas: ' + e.message, true);
    return;
  }

  movStockCache = Array.isArray(data?.reservas) ? data.reservas : [];

  if (info) {
    const n = movStockCache.length;
    info.textContent = `${n} reserva${n !== 1 ? 's' : ''} · plan del ${formatFecha(fechaPlanActual)}`;
  }

  renderMovStock(movStockCache);
}

function abrirModalMovStock() {
  const overlay = document.getElementById('overlayMovStock');
  const titulo  = document.getElementById('movStockTitulo');
  if (titulo) {
    titulo.textContent = '🧾 Resumen de reservas del plan'
      + (fechaPlanActual ? ` — ${formatFecha(fechaPlanActual)}` : '');
  }
  setAdvertenciaMovStock('');
  overlay.classList.add('open');
  cargarMovStock().catch(e => toast('Error al cargar el resumen de reservas: ' + e.message, true));
}

function cerrarModalMovStock() {
  document.getElementById('overlayMovStock').classList.remove('open');
}

// Salida de emergencia: genera el movimiento inverso de la reserva elegida.
// Recibe el índice en movStockCache para no interpolar datos del servidor en el onclick.
async function revertirMovStock(idx) {
  const r = movStockCache[idx];
  if (!r) { toast('No se encontró la reserva', true); return; }

  if (r.estado !== 'activa' || r.idRegistro == null || r.idRegistro === '') {
    toast('Esta reserva no se puede revertir', true);
    return;
  }

  // El botón ya sale deshabilitado en este caso; esto cubre un cache viejo (la orden se
  // produjo con el modal abierto) para no llegar nunca al confirm.
  if (r.bloqueoProduccion) {
    toast(String(r.bloqueoProduccion), true);
    return;
  }

  const comp = (r.numeroMovimiento == null || r.numeroMovimiento === '')
    ? '(sin comprobante)' : '#' + String(r.numeroMovimiento);
  const nl = Array.isArray(r.productos) ? r.productos.length : 0;

  const ok = await confirmarModalAsync('Revertir movimiento',
    `<div>¿Revertir la reserva <strong>${escHtml(comp)}</strong>?</div>
     <ul style="margin:8px 0 0 18px;padding:0;font-size:13px">
       <li>Líneas: <strong>${nl}</strong></li>
       <li>Planificado: ${escHtml(String(fmtFechaHoraMov(r.fechaPlanificacion)))}</li>
     </ul>
     <div style="margin-top:10px">Se genera un movimiento inverso en SiGA. Esta es la
       <strong>salida de emergencia</strong>: para deshacer una reserva, el camino normal
       es "Anular reserva".</div>`,
    'Revertir', true);
  if (!ok) return;

  const btn = document.getElementById('movStockRev' + idx);
  if (btn) btn.disabled = true;

  let resp;
  try {
    resp = await postReserva(
      `/api/stock/movimientos/${encodeURIComponent(String(r.idRegistro))}/revertir`,
      bodyConSucursal({})
    );
  } catch (e) {
    toast('Error al revertir: ' + e.message, true);
    if (btn) btn.disabled = false;
    return;
  }

  if (resp.error) {
    toast(String(resp.error), true);
    if (btn) btn.disabled = false;
    return;
  }

  const avisos = [];
  if (resp.advertencia) avisos.push(String(resp.advertencia));
  if (resp.logError) {
    avisos.push('El movimiento inverso se ejecutó, pero no se pudo escribir en el log: '
      + String(resp.logError) + ' — verificalo en SiGA.');
  }
  setAdvertenciaMovStock(avisos);

  if (resp.logError) toast(`Revertido con el movimiento #${resp.numeroMovimiento}, pero falló el registro en el log`, true);
  else               toast(`Revertido con el movimiento #${resp.numeroMovimiento}`);

  // El servidor pone el plan al día contra el log: acá sólo se informa el resultado.
  if (resp.planSincronizado === 'anulada')      toast('La reserva del plan quedó anulada');
  else if (resp.planSincronizado === 'parcial') toast('Atención: la reserva quedó con saldo parcial', true);

  try { await cargarMovStock(); }
  catch (e) { toast('Error al recargar el resumen: ' + e.message, true); }

  // Se refresca el plan entero (no sólo el estado de la reserva) para que el chip del día
  // y los sellos de cada ítem reflejen la reversión. cargarPlan ya refresca la reserva.
  try {
    if (fechaPlanActual) await cargarPlan(fechaPlanActual);
    else await refrescarEstadoReserva(true);
  } catch (e) { toast('Error al refrescar el plan: ' + e.message, true); }
}

const chkMovStockOn = document.getElementById('chkMovStockOn');
if (chkMovStockOn) chkMovStockOn.checked = movStockHabilitado();
chkMovStockOn?.addEventListener('change', () => {
  try { localStorage.setItem(MOV_STOCK_LS_KEY, chkMovStockOn.checked ? '1' : '0'); } catch (e) {}
  aplicarEstadoBotonReserva();
  toast(chkMovStockOn.checked
    ? 'Carga a SiGA activada en este equipo'
    : 'Carga a SiGA desactivada en este equipo: no se van a generar movimientos de stock');
});

document.getElementById('btnMovStock').addEventListener('click', abrirModalMovStock);
document.getElementById('cerrarMovStock').addEventListener('click', cerrarModalMovStock);
document.getElementById('btnCerrarMovStockFooter').addEventListener('click', cerrarModalMovStock);
document.getElementById('btnRecargarMovStock').addEventListener('click', () => {
  cargarMovStock().catch(e => toast('Error al cargar los movimientos: ' + e.message, true));
});
document.getElementById('chkMovStockTodos').addEventListener('change', () => {
  cargarMovStock().catch(e => toast('Error al cargar los movimientos: ' + e.message, true));
});
document.getElementById('overlayMovStock').addEventListener('click', e => {
  if (e.target === e.currentTarget) cerrarModalMovStock();
});

// showConfirm — variante de confirmarModalAsync que recibe TEXTO PLANO en vez de HTML.
// Delega en el mismo helper: antes parcheaba el onclick del botón Cancelar, así que cerrar
// con ✕ o con clic afuera dejaba la promesa colgada para siempre.
function showConfirm(titulo, mensajeTexto, btnSiLabel = 'Confirmar') {
  const html = String(mensajeTexto ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');
  return confirmarModalAsync(titulo, html, btnSiLabel);
}

