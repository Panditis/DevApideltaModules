'use strict';

// ══════════════════ PLAN DEL DÍA = REGISTRO DE ENVÍOS ══════════════════════
// Solo lectura: lo que se mandó a Producción del Día, agrupado por envío. Única acción: anular.
let ordenesDiaCache = [];

async function cargarPlan(fecha) {
  fechaPlanActual = fecha;
  document.getElementById('tituloPlan').textContent = `Enviado a producción · ${formatFecha(fecha)}`;
  document.getElementById('tablaPlan').innerHTML = '<div class="loading">Cargando…</div>';
  try {
    const [plan, ordenes] = await Promise.all([api('GET', `/api/plan/${fecha}`), api('GET', '/api/ordenes')]);
    if (fecha !== fechaPlanActual) return; // se eligió otro día mientras cargaba
    planCache = plan;
    ordenesDiaCache = (Array.isArray(ordenes) ? ordenes : []).filter(o => o.fecha === fecha);
  } catch (e) {
    document.getElementById('tablaPlan').innerHTML =
      `<div class="loading" style="color:red">Error: ${escHtml(mensajeApiError(e))}</div>`;
    return;
  }
  document.getElementById('notasPlan').value = planCache.notas || '';
  document.getElementById('planFooter').style.display = '';
  renderPlan();
}

// Estado visible: producido (recepcionado en SiGA) > estado de la orden en Producción del Día.
function estadoItemRegistro(it) {
  if (it.produccionMovimiento && it.produccionMovimiento.numeroMovimiento != null) return 'producido';
  const clave = String((it.esGranel ? it.producto : (it.rubro || it.producto)) || '').trim().toLowerCase();
  const o = ordenesDiaCache.find(x => String(x.producto || '').trim().toLowerCase() === clave
    && Array.isArray(x.presentaciones) === !it.esGranel);
  if (!o) return 'sin orden';
  return o.terminado ? 'listo' : (o.estado || 'pendiente');
}

// Color del chip: reutiliza los estados con estilo (listo verde, pendiente ámbar, en_proceso azul).
const ESTADO_REG_CHIP = { producido: 'listo', 'sin orden': 'pendiente' };

function renderPlan() {
  if (!planCache) return;
  const items = planCache.items || [];
  document.getElementById('resumePlan').textContent = `${items.length} producto${items.length !== 1 ? 's' : ''}`;
  const cont = document.getElementById('tablaPlan');
  if (!items.length) { cont.innerHTML = '<div class="loading">Nada enviado a producción para este día.</div>'; return; }
  // Un ítem puede tener varios envíos: se lista en cada uno con la cantidad de ese envío.
  const grupos = new Map();
  for (const it of items) {
    const envios = Array.isArray(it.envios) && it.envios.length ? it.envios : [{ id: null, cantidad: it.cantConfirmada ?? it.cantSugerida ?? 0 }];
    for (const e of envios) {
      const k = e.id == null ? 'anterior' : String(e.id);
      if (!grupos.has(k)) grupos.set(k, { envio: e, filas: [] });
      grupos.get(k).filas.push({ it, cantidad: e.cantidad });
    }
  }
  const orden = [...grupos.values()].sort((a, b) => (a.envio.id ?? 0) - (b.envio.id ?? 0));
  cont.innerHTML = orden.map(({ envio, filas }) => `
    <div class="card-header" style="font-size:13px">${envio.id == null ? 'Envíos anteriores' : `Envío ${escHtml(envio.hora || '')} · ${escHtml(envio.usuario || '')}`}</div>
    <table><thead><tr>
      <th>Producto</th><th>Cant.</th><th>Total día</th><th>Responsables</th><th>Envase / Tapa</th><th>Cliente</th><th>Estado</th><th></th>
    </tr></thead><tbody>
    ${filas.map(({ it, cantidad }) => {
      const estado = estadoItemRegistro(it);
      const cliente = clientesReg.find(c => String(c.id) === String(it.cliente))?.nombre || '';
      const pack = [nomOpc(envasesReg, it.envase), nomOpc(tapasReg, it.tapa)].filter(Boolean).join(' / ');
      return `<tr>
        <td>${escHtml(it.presentacion || it.producto)}${it.presentacion ? `<div class="text-sm">${escHtml(it.producto)}</div>` : ''}${it.tambor ? `<div class="text-sm">Tambor ${escHtml(it.tambor)}</div>` : ''}</td>
        <td>${cantidad}</td>
        <td>${it.cantConfirmada ?? it.cantSugerida ?? 0}</td>
        <td>${(it.responsables || []).map(escHtml).join(', ') || '—'}</td>
        <td>${escHtml(pack) || '—'}</td>
        <td>${escHtml(cliente) || '—'}</td>
        <td><span class="estado-chip active" data-estado="${escHtml(ESTADO_REG_CHIP[estado] || estado)}">${escHtml(estado.replace('_', ' '))}</span></td>
        <td>${estado === 'pendiente' || estado === 'sin orden'
          ? `<button class="btn btn-danger btn-sm" onclick="anularItem(${it.id})">Anular</button>` : ''}</td>
      </tr>`;
    }).join('')}
    </tbody></table>`).join('');
}

function anularItem(id) {
  const it = (planCache?.items || []).find(x => String(x.id) === String(id));
  if (!it) return;
  confirmarModal('Anular', `Se saca <strong>${escHtml(it.presentacion || it.producto)}</strong> (todo el día) del plan y de Producción del Día. Para corregir, anulá y volvé a enviar.`,
    'Anular', async () => {
      try { await api('DELETE', `/api/plan/${fechaPlanActual}/item/${id}`); toast('Anulado'); }
      catch (e) { toast('No se pudo anular: ' + mensajeApiError(e), true); }
      cargarPlan(fechaPlanActual);
    }, true);
}

// Notas del día: único dato editable del registro (PUT solo de notas; no toca los ítems).
async function guardarNotasPlan() {
  clearTimeout(notasDebounce);
  if (!fechaPlanActual) return;
  const notas = document.getElementById('notasPlan').value;
  if (planCache && planCache.notas === notas) return;
  try {
    await api('PUT', `/api/plan/${fechaPlanActual}/notas`, { notas });
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
  // keepalive: un fetch normal se cancela al descargar la página.
  fetch(`${SERVER_URL}/api/plan/${fechaPlanActual}/notas`, {
    method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notas }),
  }).catch(() => {});
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
  document.getElementById('planFooter').style.display = '';
  cargarPlan(fecha);
}

document.getElementById('btnSemPlanAnt').addEventListener('click', () => {
  semPlanBase = addDias(semPlanBase, -7); renderDiaSelector();
});
document.getElementById('btnSemPlanSig').addEventListener('click', () => {
  semPlanBase = addDias(semPlanBase, 7); renderDiaSelector();
});

// ── Modal buscar ─────────────────────────────────────────────────
document.getElementById('btnCarritoBuscar').addEventListener('click', () => {
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

// Búsqueda manual: el producto elegido va al carrito (que pide la fecha si todavía no tiene).
function agregarDesdeModal(sug) {
  document.getElementById('overlayBuscar').classList.remove('open');
  agregarGrupoItems(sug.rubro || sug.producto, [sugToItem(sug)]);
}
