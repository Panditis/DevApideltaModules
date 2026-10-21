
// ══════════════════ TAB 2: PLAN DÍA ════════════════════════════

async function cargarPlan(fecha) {
  fechaPlanActual = fecha;
  document.getElementById('tituloPlan').textContent = formatFecha(fecha);
  document.getElementById('tablaPlan').innerHTML = '<div class="loading">Cargando plan…</div>';
  try {
    planCache = await api('GET', `/api/plan/${fecha}`);
    document.getElementById('notasPlan').value = planCache.notas || '';
    await prefetchPackaging();
    autofillPackaging();
    renderPlan();
    await refrescarEstadoReserva(true);
  } catch (e) {
    document.getElementById('tablaPlan').innerHTML =
      `<div class="loading" style="color:red">Error: ${escHtml(e.message)}</div>`;
  }
}

function renderPlan() {
  const items = planCache?.items || [];
  autofillPackaging();
  const listos = items.filter(i => i.estado === 'listo').length;
  document.getElementById('resumePlan').textContent =
    items.length ? `${listos}/${items.length} listos` : '';
  document.getElementById('btnEnviarProd').disabled   = items.length === 0;
  document.getElementById('btnResumenMP').disabled    = items.length === 0;
  aplicarEstadoBotonReserva();

  if (!items.length) {
    document.getElementById('tablaPlan').innerHTML = `
      <div class="empty-plan">
        <div class="big">📋</div>
        <p>No hay ítems en el plan de este día.</p>
        <p style="margin-top:8px;font-size:13px">Agregá productos manualmente con "+ Agregar producto".</p>
      </div>`;
    return;
  }

  const rows = items.map(it => {
    // normalizar: responsables[] (nuevo) o responsable (legado)
    if (!Array.isArray(it.responsables)) it.responsables = it.responsable ? [it.responsable] : [];
    const cantPU = it.cantPorUnidad || 0;
    const granelH = it.nombreGranel
      ? `<small class="${it.granelOk?'granel-ok':'granel-warn'}">${it.granelOk?'✓':'⚠'}</small>`
      : '';
    // Envase/tapa: la tapa se restringe a la marca del envase elegido (SILPLAST/MARPLAST).
    const _pk     = packagingCache[String(it.idProducto)] || {};
    const envOpts = opcionesPack(envasesReg, _pk.envase);
    const tapOpts = tapasParaEnvase(envOpts, opcionesPack(tapasReg, _pk.tapa), it.envase);

    // Ítem cerrado: ya se produjo y recepcionó como artículo final. Se atenúa y se le pone un
    // acento verde a la izquierda para que se vea que salió del circuito (si hace falta de
    // nuevo, se agrega como orden nueva, no se re-reserva este).
    const cerrado = !!(it && it.produccionMovimiento);
    // Orden reservada: el backend selló el ítem con un movimiento de SiGA (reserva
    // incremental) y rechaza (409) borrarla mientras esa reserva siga activa.
    const reservada = !!(it && it.reservaMovimiento && it.reservaMovimiento.numeroMovimiento != null);
    // Con la reserva sellada la orden queda congelada: cantidad, responsable, envase, tapa,
    // cliente y la reasignación de fecha se bloquean hasta anular la reserva, igual que el
    // botón de eliminar. El estado de tarea es la excepción a propósito: pasar el ítem a
    // "listo" es lo que dispara la devolución de su porción de la reserva.
    const bloqRes  = reservada ? ' disabled' : '';
    const tituloRes = 'Orden reservada: anulá la reserva para cambiarlo';
    return `<tr draggable="true" data-id="${it.id}" data-cant-pu="${cantPU}"${reservada && !cerrado ? ' class="orden-reservada"' : ''}${cerrado ? ' style="opacity:.62;border-left:3px solid #14532d"' : ''}>
      <td style="text-align:center;white-space:nowrap;padding:0">
        <button onclick="event.stopPropagation();moverPrioridad(${it.id},-1)" title="Subir prioridad" style="border:none;background:none;cursor:pointer;font-size:12px;line-height:1;padding:1px 4px;color:var(--muted)">▲</button>
        <button onclick="event.stopPropagation();moverPrioridad(${it.id},1)" title="Bajar prioridad" style="border:none;background:none;cursor:pointer;font-size:12px;line-height:1;padding:1px 4px;color:var(--muted)">▼</button>
        <span class="drag-handle" title="Arrastrar para reordenar" style="font-size:13px">⠿</span>
      </td>
      <td><button class="badge ${it.semaforo}" style="border:none;cursor:pointer" onclick="cambiarSemaforo(${it.id})" title="Click para cambiar prioridad: Urgente → Alto → Medio → Bajo">${semLabel(it.semaforo)}</button></td>
      <td class="nombre-col" title="${escHtml(it.producto)}">
        ${escHtml(it.producto)}<br>
        <span class="text-sm">${escHtml(it.rubro)}</span>
        ${esItemMiel(it) ? `
        <div style="margin-top:4px;display:flex;align-items:center;gap:4px">
          <span class="text-sm" style="color:var(--muted)">🛢 Tambor</span>
          <input type="text" inputmode="numeric" value="${escHtml(it.tambor||'')}" placeholder="—"
            onchange="actualizarItem(${it.id},'tambor',this.value)"
            style="width:62px;border:1px solid var(--border);border-radius:4px;padding:2px 6px;font-size:12px;font-family:system-ui,sans-serif;font-weight:700;text-align:center">
        </div>` : ''}
      </td>
      <td>
        <input class="qty-input" type="number" min="0" value="${it.cantConfirmada??it.cantSugerida??0}"${bloqRes}
          title="${reservada ? tituloRes : (it.esGranel ? '' : 'Sugerido: '+it.cantSugerida)}"
          data-id="${it.id}"
          onchange="actualizarItem(${it.id},'cantConfirmada',+this.value,this)">
        ${it.esGranel
          ? `<div class="text-sm" style="color:var(--muted)">${escHtml(it.unidadGranel||'Kg')}</div>`
          : `<div id="granel-${it.id}" class="text-sm">${renderGranelNec(it.cantConfirmada??it.cantSugerida??0, cantPU, it.granelDisponible)}</div>`
        }
      </td>
      <td onclick="event.stopPropagation()">
        ${renderRespMulti(it, reservada)}
      </td>
      <td onclick="event.stopPropagation()">
        <select onchange="actualizarItem(${it.id},'envase',this.value)"${bloqRes} title="${reservada ? tituloRes : 'Envase asignado'}"
          style="max-width:160px;border:1px solid var(--border);border-radius:4px;padding:4px 6px;font-size:12px;font-family:system-ui,sans-serif">
          <option value="">— Envase —</option>
          ${envOpts.map(e => `<option value="${escHtml(String(e.codigo))}" ${String(it.envase||'')===String(e.codigo)?'selected':''}>${escHtml(e.nombre || e.codigo)}</option>`).join('')}
        </select>
      </td>
      <td onclick="event.stopPropagation()">
        <select onchange="actualizarItem(${it.id},'tapa',this.value)" ${(it.envase && !reservada) ? '' : 'disabled'}
          title="${reservada ? tituloRes : (it.envase ? 'Tapa asignada' : 'Sin envase (granel): no aplica tapa')}"
          style="max-width:160px;border:1px solid var(--border);border-radius:4px;padding:4px 6px;font-size:12px;font-family:system-ui,sans-serif">
          <option value="">— Tapa —</option>
          ${tapOpts.map(e => `<option value="${escHtml(String(e.codigo))}" ${String(it.tapa||'')===String(e.codigo)?'selected':''}>${escHtml(e.nombre || e.codigo)}</option>`).join('')}
        </select>
      </td>
      <td onclick="event.stopPropagation()">
        <select onchange="actualizarItem(${it.id},'cliente',this.value)"${bloqRes} title="${reservada ? tituloRes : 'Cliente'}"
          style="max-width:160px;border:1px solid var(--border);border-radius:4px;padding:4px 6px;font-size:12px;font-family:system-ui,sans-serif">
          <option value="">— Cliente —</option>
          ${clientesReg.map(c => `<option value="${escHtml(String(c.id))}" ${String(it.cliente||'')===String(c.id)?'selected':''}>${escHtml(c.nombre)}</option>`).join('')}
        </select>
      </td>
      <td>
        <div class="estado-chips">
          ${['pendiente','en_proceso','listo'].map(e =>
            `<span class="estado-chip${it.estado===e?' active':''}" data-estado="${e}"
              onclick="setEstado(${it.id},'${e}',this)">${e==='pendiente'?'Pendiente':e==='en_proceso'?'En proceso':'Listo'}</span>`
          ).join('')}
        </div>
        ${chipMovimientoItem(it)}
      </td>
      <td class="text-center" style="white-space:nowrap">
        ${granelH}
        <button class="btn-formula" title="Ver materias primas"
          onclick="event.stopPropagation();mostrarMPResumen('📦 ${escHtml(it.producto).replace(/'/g,"\\'")} — ${escHtml(it.presentacion||'').replace(/'/g,"\\'")}', [{idProducto:${it.idProducto||0},cantConfirmada:${it.cantConfirmada??it.cantSugerida??0}}])">📦</button>
      </td>
      <td style="white-space:nowrap">
        <button class="btn btn-secondary btn-sm" onclick="moverItem(${it.id})"${bloqRes} title="${reservada ? tituloRes : 'Reasignar fecha'}">📅</button>
        <button class="btn btn-danger btn-sm" onclick="eliminarItem(${it.id})"${reservada ? ' disabled title="Orden reservada: anulá la reserva primero"' : ''}>✕</button>
      </td>
    </tr>`;
  }).join('');

  document.getElementById('tablaPlan').innerHTML = `
    <div style="overflow-x:auto">
    <table>
      <thead><tr>
        <th style="width:54px;text-align:center" title="Prioridad (▲▼ o arrastrar)">Prior.</th><th>Estado</th><th>Producto</th>
        <th>Cantidad</th><th>Responsable</th><th>Envase</th><th>Tapa</th><th>Cliente</th><th>Estado tarea</th>
        <th>MP</th><th></th>
      </tr></thead>
      <tbody id="tbodyPlan">${rows}</tbody>
    </table></div>`;

  initDragDrop();
  prefetchPackaging().then(changed => { if (changed) { autofillPackaging(); renderPlan(); } });
}

function renderGranelNec(cant, cantPU, disp) {
  if (!cantPU) return '';
  const nec = Math.round(cant * cantPU * 100) / 100;
  const ok  = disp == null || disp >= nec;
  return `<span style="color:${ok?'var(--grn-text)':'var(--red-text)'}">${nec}${ok?'':'⚠'}</span>`;
}

async function actualizarItem(id, campo, valor, el) {
  const item = planCache?.items.find(i => i.id == id);
  if (!item) return;
  item[campo] = valor;

  // Al cambiar el envase, la tapa debe seguir su marca: si la actual no es válida
  // (otra marca, o el envase pasó a granel) queda en blanco hasta elegir una nueva.
  if (campo === 'envase') {
    const pk      = packagingCache[String(item.idProducto)] || {};
    const validas = tapasParaEnvase(opcionesPack(envasesReg, pk.envase), opcionesPack(tapasReg, pk.tapa), valor);
    if (!validas.some(t => String(t.codigo) === String(item.tapa || ''))) item.tapa = '';
  }

  if (campo === 'cantConfirmada' && el) {
    const cantPU = parseFloat(el.closest('tr').dataset.cantPu) || 0;
    document.getElementById('granel-' + id).innerHTML =
      renderGranelNec(valor, cantPU, item.granelDisponible);
    item.granelNecesario = Math.round(valor * cantPU * 100) / 100;
    item.granelOk = !cantPU || item.granelDisponible == null || item.granelDisponible >= item.granelNecesario;
  }

  try {
    const resp = await api('PUT', `/api/plan/${fechaPlanActual}/item/${id}`, item);
    // El backend puede responder 200 con {error, yaProducido|yaReservado} en vez
    // de un status de error: si el ítem ya se trabajó en producción o está
    // reservado, se avisa y se descarta la edición optimista refrescando el plan.
    if (resp && resp.error) {
      toast(String(resp.error), true);
      await cargarPlan(fechaPlanActual);
      return;
    }
  } catch (e) {
    // La página pudo quedar desactualizada (ítem producido/reservado en otro
    // lado): se muestra el motivo real y se refresca para revertir el cambio
    // optimista y reflejar el estado verdadero del servidor.
    toast('Error al guardar: ' + mensajeApiError(e), true);
    await cargarPlan(fechaPlanActual);
    return;
  }

  // Refrescar la fila: las opciones de tapa dependen del envase elegido.
  if (campo === 'envase') renderPlan();
}

async function cambiarSemaforo(id) {
  const item = planCache?.items.find(i => i.id == id);
  if (!item) return;
  const ciclo = { URGENT: 'RED', RED: 'YELLOW', YELLOW: 'GREEN', GREEN: 'URGENT' };
  item.semaforo = ciclo[item.semaforo] || 'RED';
  renderPlan();
  try { await api('PUT', `/api/plan/${fechaPlanActual}/item/${id}`, { semaforo: item.semaforo }); }
  catch (e) { toast('Error al actualizar', true); }
}

async function setEstado(id, estado, chipEl) {
  const item = planCache?.items.find(i => i.id == id);
  if (!item) return;
  item.estado = estado;
  chipEl.closest('.estado-chips').querySelectorAll('.estado-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.estado === estado);
  });
  try {
    const resp = await api('PUT', `/api/plan/${fechaPlanActual}/item/${id}`, { estado });
    const listos = planCache.items.filter(i => i.estado === 'listo').length;
    document.getElementById('resumePlan').textContent =
      `${listos}/${planCache.items.length} listos`;
    // El backend devuelve la reserva del ítem automáticamente al pasarlo a "listo".
    if (resp && resp.reservaDevuelta) {
      toast(`Reserva devuelta #${resp.reservaDevuelta.numeroMovimiento ?? ''}`.trim());
      refrescarEstadoReserva(true);
    } else if (resp && resp.reservaError) {
      toast(String(resp.reservaError), true);
      refrescarEstadoReserva(true);
    }
  } catch (e) { toast('Error al actualizar estado', true); }
}

function moverItem(id) {
  const it = (planCache?.items || []).find(i => i.id == id);
  if (!it) return;
  // Mover = alta en el día nuevo + baja en el viejo. Con la orden reservada el servidor rechaza
  // la baja (409) y quedaría duplicada en los dos días, así que se corta antes de abrir el
  // picker. El botón ya viene deshabilitado; esto cubre la página desactualizada (reserva hecha
  // desde otra pestaña).
  const numeroReserva = it?.reservaMovimiento?.numeroMovimiento;
  if (numeroReserva != null) {
    toast(`Orden reservada (#${numeroReserva}): anulá la reserva primero`, true);
    return;
  }
  abrirDiaPicker(`📅 Mover: ${escHtml(it.producto)}`, async nuevaFecha => {
    if (nuevaFecha === fechaPlanActual) { toast('Es el mismo día', true); return; }
    try {
      await api('POST', `/api/plan/${nuevaFecha}/item`, { ...it, fecha: nuevaFecha });
      await api('DELETE', `/api/plan/${fechaPlanActual}/item/${id}`);
      planCache.items = planCache.items.filter(i => i.id != id);
      renderPlan();
      toast(`"${it.producto}" → ${formatFecha(nuevaFecha)}`);
    } catch (e) { toast('Error al mover: ' + e.message, true); }
  });
}

function eliminarItem(id) {
  const it = (planCache?.items || []).find(i => i.id == id);
  // La recepción va primero: es el estado terminal y gana sobre "reservada", igual que en el
  // chip de la fila. El servidor también lo rechaza, pero sin esta guarda se abría el modal,
  // el usuario confirmaba y recién ahí veía el error.
  const numeroRecepcion = it?.produccionMovimiento?.numeroMovimiento;
  if (numeroRecepcion != null) {
    toast(`Orden ya producida y recepcionada (#${numeroRecepcion}): no se puede eliminar`, true);
    return;
  }
  const numeroReserva = it?.reservaMovimiento?.numeroMovimiento;
  if (numeroReserva != null) {
    toast(`Orden reservada (#${numeroReserva}): anulá la reserva primero`, true);
    return;
  }
  const nombre = it ? it.producto : 'este ítem';
  confirmarModal('Eliminar ítem',
    `¿Eliminar <strong>${escHtml(nombre)}</strong> del plan de ${formatFecha(fechaPlanActual)}?`,
    'Eliminar',
    async () => {
      // La página puede estar desactualizada (el ítem pudo pasar a producción o
      // quedar reservado desde otra pestaña): se refresca el plan justo antes de
      // borrar para no operar sobre datos viejos.
      try { await cargarPlan(fechaPlanActual); }
      catch (e) { toast('Error al refrescar el plan: ' + mensajeApiError(e), true); return; }

      const fresh = planCache?.items.find(i => i.id == id);
      if (!fresh) { toast('El ítem ya no está en el plan', true); return; }
      const numeroReservaFresh = fresh.reservaMovimiento?.numeroMovimiento;
      if (numeroReservaFresh != null) {
        toast('Orden reservada (#' + numeroReservaFresh + '): anulá la reserva primero', true);
        return;
      }

      try {
        await api('DELETE', `/api/plan/${fechaPlanActual}/item/${id}`);
        planCache.items = planCache.items.filter(i => i.id != id);
        renderPlan();
        toast('Ítem eliminado');
      } catch (e) {
        // 409 u otro rechazo del backend (ya producido/reservado): se muestra
        // el motivo real y se refresca para que la vista quede consistente.
        toast('Error al eliminar: ' + mensajeApiError(e), true);
        await cargarPlan(fechaPlanActual);
      }
    }, true);
}

// Solo se manda `notas`: el servidor conserva los ítems que ya tiene. Mandar el cache local
// pisaba los sellos de reserva/producción si el plan había cambiado desde otra pestaña.
async function guardarNotasPlan() {
  clearTimeout(notasDebounce);
  if (!fechaPlanActual) return;
  const notas = document.getElementById('notasPlan').value;
  if (planCache && planCache.notas === notas) return;
  try {
    const resp = await api('POST', `/api/plan/${fechaPlanActual}`, { notas });
    // Red de seguridad: un servidor viejo (todavía sin reiniciar) toma la ausencia de `items`
    // como lista vacía y borra el plan. Si la respuesta vuelve sin ítems y el cache sí los
    // tenía, se reponen en el acto para no perder el plan del día.
    if (resp && Array.isArray(resp.items) && !resp.items.length && planCache?.items?.length) {
      await api('POST', `/api/plan/${fechaPlanActual}`, { notas, items: planCache.items });
    }
    if (planCache) planCache.notas = notas;
  } catch (e) { toast('No se pudieron guardar las notas: ' + mensajeApiError(e), true); }
}

document.getElementById('notasPlan').addEventListener('input', () => {
  clearTimeout(notasDebounce);
  notasDebounce = setTimeout(guardarNotasPlan, 800);
});
// Flush al salir del campo y al cerrar/recargar: con solo el debounce de 800ms, editar y
// recargar enseguida perdía el cambio y volvía el texto anterior.
document.getElementById('notasPlan').addEventListener('blur', guardarNotasPlan);
window.addEventListener('beforeunload', () => {
  clearTimeout(notasDebounce);
  const notas = document.getElementById('notasPlan').value;
  if (!fechaPlanActual || !planCache || planCache.notas === notas) return;
  // sendBeacon: un fetch normal se cancela al descargar la página. Acá no se puede leer la
  // respuesta para reparar, así que los ítems viajan siempre: es la única forma de que un
  // servidor viejo no deje el plan vacío.
  const cuerpo = { notas, ...(planCache.items?.length ? { items: planCache.items } : {}) };
  navigator.sendBeacon?.(`/api/plan/${fechaPlanActual}`,
    new Blob([JSON.stringify(cuerpo)], { type: 'application/json' }));
});

// ── Selector de día (semana) ─────────────────────────────────────
const DIAS_NOM = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];

function renderDiaSelector() {
  const chips = document.getElementById('diaChips');
  let html = '';
  for (let i = 0; i < 7; i++) {
    const fecha  = addDias(semPlanBase, i);
    const dd     = parseInt(fecha.split('-')[2]);
    const esHoy  = fecha === HOY;
    const active = fecha === fechaPlanActual;
    const finde  = i >= 5 ? ' fin-semana' : '';
    html += `<button class="dia-chip${active?' active':''}${esHoy?' hoy':''}${finde}"
        onclick="seleccionarDia('${fecha}')">
      <span class="dia-nom">${DIAS_NOM[i]}</span>
      <span class="dia-num">${dd}</span>
      ${esHoy ? '<span class="dia-hoy">HOY</span>' : ''}
    </button>`;
  }
  chips.innerHTML = html;
}

function seleccionarDia(fecha) {
  fechaPlanActual = fecha;
  renderDiaSelector();
  document.getElementById('btnAgregarProducto').disabled = false;
  document.getElementById('btnBorrarPlan').disabled = false;
  document.getElementById('planFooter').style.display = '';
  cargarPlan(fecha);
}

document.getElementById('btnSemPlanAnt').addEventListener('click', () => {
  semPlanBase = addDias(semPlanBase, -7); renderDiaSelector();
});
document.getElementById('btnSemPlanSig').addEventListener('click', () => {
  semPlanBase = addDias(semPlanBase, 7); renderDiaSelector();
});

document.getElementById('btnBorrarPlan').addEventListener('click', () => {
  const n = planCache?.items?.length || 0;
  if (!n) { toast('El plan ya está vacío'); return; }
  confirmarModal('Borrar todo el plan',
    `¿Borrar <strong>${n === 1 ? 'el ítem' : 'los ' + n + ' ítems'}</strong> del plan de ${formatFecha(fechaPlanActual)}? Esta acción no se puede deshacer.`,
    'Borrar todo',
    async () => {
      try {
        const res = await api('DELETE', `/api/plan/${fechaPlanActual}`);
        // Las órdenes reservadas se conservan: se recarga el plan para mostrarlas con su badge.
        await cargarPlan(fechaPlanActual);
        toast(res && res.conservadas ? res.aviso : 'Plan borrado', !!(res && res.conservadas));
      } catch (e) { toast('Error: ' + e.message, true); }
    }, true);
});


// ── Drag & Drop ──────────────────────────────────────────────────
function initDragDrop() {
  const tbody = document.getElementById('tbodyPlan');
  if (!tbody) return;
  tbody.querySelectorAll('tr').forEach(row => {
    row.addEventListener('dragstart', e => {
      dragSrcRow = row;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
      dragSrcRow = null;
      tbody.querySelectorAll('tr').forEach(r => r.classList.remove('dragging','drag-over'));
      guardarOrden();
    });
    row.addEventListener('dragover', e => {
      e.preventDefault();
      tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over'));
      if (row !== dragSrcRow) row.classList.add('drag-over');
    });
    row.addEventListener('drop', e => {
      e.preventDefault();
      if (dragSrcRow && dragSrcRow !== row) {
        const rows = [...tbody.querySelectorAll('tr')];
        if (rows.indexOf(dragSrcRow) < rows.indexOf(row)) row.after(dragSrcRow);
        else row.before(dragSrcRow);
      }
    });
  });
}

async function moverPrioridad(id, dir) {
  if (!planCache || !Array.isArray(planCache.items)) return;
  const items = planCache.items;
  const i = items.findIndex(x => x.id == id); if (i < 0) return;
  const j = i + dir; if (j < 0 || j >= items.length) return;
  [items[i], items[j]] = [items[j], items[i]];
  items.forEach((x, k) => { x.prioridad = k + 1; });
  renderPlan();
  try { await api('POST', `/api/plan/${fechaPlanActual}`, planCache); }
  catch (e) { toast('Error al guardar orden: ' + e.message, true); }
}

async function guardarOrden() {
  const tbody = document.getElementById('tbodyPlan');
  if (!tbody || !planCache) return;
  const ids    = [...tbody.querySelectorAll('tr')].map(r => parseInt(r.dataset.id));
  const mapa   = new Map(planCache.items.map(i => [i.id, i]));
  planCache.items = ids.map((id, i) => { const it = mapa.get(id); if (it) it.prioridad = i+1; return it; }).filter(Boolean);
  try { await api('POST', `/api/plan/${fechaPlanActual}`, planCache); } catch {}
}

// ── Modal buscar ─────────────────────────────────────────────────
document.getElementById('btnAgregarProducto').addEventListener('click', () => {
  document.getElementById('overlayBuscar').classList.add('open');
  document.getElementById('inputBuscar').value = '';
  document.getElementById('resultadosBuscar').innerHTML = BUSCAR_VACIO_HTML;
  setTimeout(() => document.getElementById('inputBuscar').focus(), 80);
});
document.getElementById('cerrarBuscar').addEventListener('click', () =>
  document.getElementById('overlayBuscar').classList.remove('open'));
document.getElementById('overlayBuscar').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
});

document.getElementById('inputBuscar').addEventListener('input', e => {
  clearTimeout(buscarProdDebounce);
  buscarProdDebounce = setTimeout(() => buscarProductos(e.target.value), 350);
});

const BUSCAR_VACIO_HTML =
  '<div class="buscar-empty"><span class="be-icon">🔎</span>Escribí para buscar un producto.</div>';
const BUSCAR_SIN_RESULTADOS_HTML =
  '<div class="buscar-empty"><span class="be-icon">🫙</span>Sin resultados para esa búsqueda.</div>';

async function buscarProductos(q) {
  if (q.length < 2) { document.getElementById('resultadosBuscar').innerHTML = BUSCAR_VACIO_HTML; return; }
  try {
    const res = await api('GET', `/api/plan/sugerencias?q=${encodeURIComponent(q)}`);
    const html = res.slice(0, 20).map(r => `
      <div class="search-result" onclick='agregarDesdeModal(${JSON.stringify(r)})'>
        <span class="badge ${r.semaforo}" style="flex-shrink:0">${semLabel(r.semaforo)}</span>
        <span class="prod-name">${escHtml(r.producto)}</span>
        <span class="prod-rubro">${escHtml(r.rubro)}</span>
        ${r.cantSugerida > 0 ? `<span class="prod-sug">Sug: ${r.cantSugerida}</span>` : ''}
      </div>`).join('') || BUSCAR_SIN_RESULTADOS_HTML;
    document.getElementById('resultadosBuscar').innerHTML = html;
  } catch {}
}

function sugToItem(s) {
  const _norm = normalizarNombreJS(s.producto || '');
  const _rubro = _norm.replace(PRES_RE_JS, '').trim().toLowerCase() || s.rubro || '';
  return {
    idProducto:    s.idProducto ?? s.plu ?? null,
    producto:      s.producto,
    rubro:         _rubro,
    stockActual:   s.stockActual ?? 0,
    promDiario:    s.promDiario ?? 0,
    promMes:       s.promMes ?? Math.round((s.promDiario || 0) * 30 * 10) / 10,
    diasStock:     s.diasStock ?? 0,
    semaforo:      s.semaforo || 'GREEN',
    pendientes:    s.pendientes ?? 0,
    cantSugerida:  s.cantSugerida ?? 0,
    cantConfirmada: s.cantSugerida ?? 0,
    idGranel:      s.idGranel ?? '', nombreGranel: s.nombreGranel ?? '',
    cantPorUnidad: s.cantPorUnidad ?? 0, granelNecesario: s.granelNecesario ?? 0,
    granelDisponible: s.granelDisponible ?? null, granelOk: s.granelOk ?? true
  };
}

async function agregarDesdeModal(sug) {
  document.getElementById('overlayBuscar').classList.remove('open');
  if (!fechaPlanActual) { toast('Seleccioná un día primero', true); return; }
  const items = [sugToItem(sug)];
  const graneles = await itemGranelPrevio(sug.rubro || sug.producto, items);
  if (graneles === false) return;
  await agregarItemsConCheck(fechaPlanActual, [...graneles, ...items],
    `"${sug.producto}" agregado al plan`);
}

