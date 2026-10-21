'use strict';

// ── Modal de confirmación genérico ───────────────────────────────
// Es el ÚNICO camino para pedir confirmación en esta pantalla: confirm() y alert() nativos
// rompen el estilo del módulo, no se pueden formatear y bloquean el hilo.
let confirmCallback = null;
let confirmCancelCallback = null;

function confirmarModal(titulo, mensajeHtml, textoOk, callback, peligro, onCancel) {
  document.getElementById('confirmTitulo').textContent = titulo;
  document.getElementById('confirmMsg').innerHTML = mensajeHtml;
  const btn = document.getElementById('btnConfirmOk');
  btn.textContent = textoOk;
  btn.className = 'btn ' + (peligro ? 'btn-danger' : 'btn-primary');
  document.getElementById('confirmHeader').style.background = peligro ? 'var(--red-text)' : 'var(--verde)';
  confirmCallback = callback;
  // onCancel es opcional: las llamadas viejas no lo pasan y se comportan igual que antes.
  confirmCancelCallback = onCancel || null;
  document.getElementById('overlayConfirm').classList.add('open');
}
function cerrarConfirmModal() {
  // Cerrar sin confirmar (✕, Cancelar o clic afuera) cuenta como cancelación, así que el
  // callback se dispara acá una sola vez y no en cada listener.
  const cancelar = confirmCancelCallback;
  document.getElementById('overlayConfirm').classList.remove('open');
  confirmCallback = null;
  confirmCancelCallback = null;
  if (cancelar) cancelar();
}
document.getElementById('btnConfirmOk').addEventListener('click', () => {
  const cb = confirmCallback;
  confirmCancelCallback = null;   // confirmar no debe disparar el callback de cancelación
  cerrarConfirmModal();
  if (cb) cb();
});

// Versión await-able del modal, para reemplazar a confirm() sin dar vuelta el flujo de las
// funciones async: resuelve true si se confirma y false si se cancela por cualquier vía.
function confirmarModalAsync(titulo, mensajeHtml, textoOk, peligro) {
  return new Promise(resolve => {
    confirmarModal(titulo, mensajeHtml, textoOk, () => resolve(true), peligro, () => resolve(false));
  });
}

// Cuerpo del modal que lista los componentes sin stock suficiente. Tope de 15 para que no se
// vuelva una pared de texto; el resto se resume en una línea.
function htmlFaltantesStock(faltantes, deposito, pregunta) {
  const filas = faltantes.slice(0, 15).map(f =>
    `<li style="margin-top:3px"><strong>${escHtml(String(f.nombre ?? ''))}</strong>
       <span style="opacity:.7">(PLU ${escHtml(String(f.plu ?? ''))})</span>:
       necesita ${escHtml(String(fmtCant(f.necesario)))},
       hay ${escHtml(String(fmtCant(f.stockOrigen ?? f.stockPrincipal)))} →
       faltan <strong style="color:var(--red-text)">${escHtml(String(fmtCant(f.faltante)))}</strong></li>`).join('');
  const extra = faltantes.length > 15
    ? `<div style="margin-top:6px;opacity:.8">… y ${faltantes.length - 15} más</div>` : '';
  return `<div>No alcanza el stock del depósito de origen
        (<strong>${escHtml(etiquetaDeposito(deposito))}</strong>):</div>
      <ul style="margin:8px 0 0 18px;padding:0;font-size:13px">${filas}</ul>${extra}
      <div style="margin-top:10px"><strong>${escHtml(pregunta)}</strong></div>`;
}
document.getElementById('btnConfirmCancel').addEventListener('click', cerrarConfirmModal);
document.getElementById('cerrarConfirm').addEventListener('click', cerrarConfirmModal);
document.getElementById('overlayConfirm').addEventListener('click', e => {
  if (e.target === e.currentTarget) cerrarConfirmModal();
});

// ── Alta de ítems ─────────────────────────────────────────────────────────────
// Los que no existen se agregan directo. Si alguno ya está en el día → modal preguntando;
// al confirmar, suma la cantidad nueva a la ya cargada (una sola fila). Clave: idProducto o nombre+presentación.
async function agregarItemsConCheck(fecha, items, labelOk) {
  const keyOf = it => (it.idProducto != null && String(it.idProducto) !== '')
    ? 'id:' + String(it.idProducto)
    : 'nom:' + (it.producto || '').trim().toLowerCase() + '|' + (it.presentacion || '').trim().toLowerCase();
  const cantOf = it => (it.cantConfirmada ?? it.cantSugerida ?? 0);

  const altaDirecta = async (lista) => {
    for (const it of lista) await api('POST', `/api/plan/${fecha}/item`, it);
  };

  let plan;
  try { plan = await api('GET', `/api/plan/${fecha}`); }
  catch {
    try { await altaDirecta(items); toast(labelOk); if (fecha === fechaPlanActual) await cargarPlan(fecha); }
    catch (e) { toast('Error: ' + e.message, true); }
    return;
  }

  // Mapa de ítems vigentes por clave → { id, cant }.
  const existMap = new Map();
  for (const ex of (plan.items || [])) existMap.set(keyOf(ex), { id: ex.id, cant: cantOf(ex) });

  // Partir en nuevos vs ya existentes.
  const nuevos = [], dups = [];
  for (const it of items) (existMap.has(keyOf(it)) ? dups : nuevos).push(it);

  const aplicar = async () => {
    try {
      for (const it of nuevos) {
        const creado = await api('POST', `/api/plan/${fecha}/item`, it);
        existMap.set(keyOf(it), { id: creado?.id, cant: cantOf(it) });
      }
      for (const it of dups) {
        const k = keyOf(it), ex = existMap.get(k);
        if (!ex) { const creado = await api('POST', `/api/plan/${fecha}/item`, it); existMap.set(k, { id: creado?.id, cant: cantOf(it) }); continue; }
        const nuevaCant = (ex.cant || 0) + cantOf(it);
        await api('PUT', `/api/plan/${fecha}/item/${ex.id}`, { cantConfirmada: nuevaCant });
        existMap.set(k, { id: ex.id, cant: nuevaCant }); // acumula si el lote repite el ítem
      }
      const extra = dups.length ? ` · ${dups.length} sumada${dups.length > 1 ? 's' : ''} a lo ya cargado` : '';
      toast(labelOk + extra);
      if (fecha === fechaPlanActual) await cargarPlan(fecha);
    } catch (e) { toast('Error: ' + e.message, true); }
  };

  if (!dups.length) { await aplicar(); return; }

  const nombres = [...new Set(dups.map(d => `${d.producto}${d.presentacion ? ' ' + d.presentacion : ''}`))]
    .map(n => `<li style="margin:2px 0">${escHtml(n)}</li>`).join('');
  const msg = `${dups.length === 1 ? 'Este producto ya está' : 'Estos productos ya están'} en el plan de <strong>${formatFecha(fecha)}</strong>:
    <ul style="margin:8px 0 0;padding-left:20px;color:var(--amb-text)">${nombres}</ul>
    <div style="margin-top:12px;color:var(--muted);font-size:13px">¿Agregar igual? Se sumará la cantidad nueva a la que ya está cargada.</div>`;
  confirmarModal('⚠ Producto ya en el plan', msg, 'Agregar y sumar', aplicar);
}

// ── Número de tambor (solo mieles) ───────────────────────────────
let tamborCallback = null;

function pedirTambor(nombreMiel, callback) {
  tamborCallback = callback;
  document.getElementById('tamborSub').textContent = nombreMiel || '';
  document.getElementById('inputTambor').value = '';
  document.getElementById('overlayTambor').classList.add('open');
  setTimeout(() => document.getElementById('inputTambor').focus(), 80);
}

function resolverTambor(valor) {
  document.getElementById('overlayTambor').classList.remove('open');
  if (tamborCallback) { const cb = tamborCallback; tamborCallback = null; cb(valor); }
}

document.getElementById('btnTamborOk').addEventListener('click', () => {
  const v = document.getElementById('inputTambor').value.trim();
  if (!v) { toast('Ingresá el número de tambor o tocá Omitir', true); return; }
  resolverTambor(v);
});
document.getElementById('btnTamborOmitir').addEventListener('click', () => resolverTambor(''));
document.getElementById('inputTambor').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btnTamborOk').click();
});
document.getElementById('cerrarTambor').addEventListener('click', () => {
  tamborCallback = null;
  document.getElementById('overlayTambor').classList.remove('open');
});
document.getElementById('overlayTambor').addEventListener('click', e => {
  if (e.target === e.currentTarget) { tamborCallback = null; e.currentTarget.classList.remove('open'); }
});

// ── Enviar a Producción del Día ──────────────────────────────────

const CRITICIDAD = { URGENT: 'Urgente', RED: 'Alta', YELLOW: 'Media', GREEN: 'Baja' };

// Todas las órdenes van a una única sección: producción no se categoriza por familia.
function seccionParaGrupo(_productoRef) {
  return 'PRODUCCIÓN';
}

// Código de catálogo del granel para una orden granel.
// Prioridad: campo del ítem → grupo del catálogo (por productoRef) → config granelPlu.
function codigoGranelItem(it) {
  if (it.idGranel) return String(it.idGranel);
  if (it.granelId) return String(it.granelId);
  const g = (gruposSorted || []).find(x => x.productoRef === it.producto)
         || (gruposCatCache || []).find(x => x.productoRef === it.producto);
  if (g && (g.granelId || g.granelPlu)) return String(g.granelId || g.granelPlu);
  const gp = cfgGetGranelPlu(it.producto);
  return gp ? String(gp) : '';
}

function construirOrdenes() {
  // Un ítem con produccionMovimiento ya se produjo Y se recepcionó como artículo final: cerró
  // su circuito. Volver a mandarlo a Producción del Día duplicaría la orden y, al conciliar de
  // nuevo, descontaría sus componentes en SiGA por segunda vez. Se filtra acá, en el origen,
  // así quedan cubiertos tanto el granel como el fraccionado agrupado por rubro.
  const items = (planCache?.items || []).filter(it => !(it && it.produccionMovimiento));
  if (!items.length) return [];

  const CRIT_ORDER = { URGENT: 4, RED: 3, YELLOW: 2, GREEN: 1 };
  const ordenes    = [];

  // ── Granel: cada ítem es 1 orden ──────────────────────────────
  for (const it of items.filter(i => i.esGranel)) {
    const cant = it.cantConfirmada ?? it.cantSugerida ?? 0;
    if (cant <= 0) continue;
    ordenes.push({
      id:           0,
      codigo:       codigoGranelItem(it),
      idProducto:   (it.idProducto ?? it.plu) ?? null,
      seccion:      seccionParaGrupo(it.producto),
      producto:     it.producto,
      presentacion: `${cant} ${it.unidadGranel || 'Kg'}${it.tambor ? ` · Tambor ${it.tambor}` : ''}`,
      cantidad:     cant,
      criticidad:   CRITICIDAD[it.semaforo] || 'Media',
      prioridad:    it.prioridad,
      envase:       it.envase || '',
      estado:       'pendiente',
      encargados:   it.responsables || (it.responsable ? [it.responsable] : []),
      encargado:    (it.responsables||[it.responsable||'']).filter(Boolean).join(' / '),
      tambor:       it.tambor || '',
      fecha:        fechaPlanActual,
      cliente:      clientesReg.find(c => String(c.id) === String(it.cliente))?.nombre || ''
    });
  }

  // ── Fraccionado: agrupar por rubro → 1 orden por familia ──────
  const byRubro = {};
  for (const it of items.filter(i => !i.esGranel)) {
    const key = it.rubro || it.producto;
    if (!byRubro[key]) byRubro[key] = [];
    byRubro[key].push(it);
  }

  for (const [rubro, its] of Object.entries(byRubro)) {
    const conCant = its.filter(it => (it.cantConfirmada ?? it.cantSugerida ?? 0) > 0);
    if (!conCant.length) continue;

    const totalCant = conCant.reduce((s, it) => s + (it.cantConfirmada ?? it.cantSugerida ?? 0), 0);
    const semaforo  = conCant.reduce((w, it) =>
      (CRIT_ORDER[it.semaforo] || 0) > (CRIT_ORDER[w] || 0) ? it.semaforo : w, 'GREEN');

    const presentaciones = conCant.map(it => {
      const cant = it.cantConfirmada ?? it.cantSugerida ?? 0;
      const pres = it.presentacion || it.producto || '';
      return { presentacion: pres, cantidad: cant, plu: (it.idProducto ?? it.plu) != null ? String(it.idProducto ?? it.plu) : '', envase: it.envase || '', tapa: it.tapa || '' };
    });
    const presStr  = presentaciones.map(p => `${p.presentacion}: ${p.cantidad}`).join(' / ');
    const tambores = [...new Set(conCant.map(it => it.tambor).filter(Boolean))].join(', ');

    ordenes.push({
      id:           0,
      codigo:       presentaciones.map(p => p.plu).filter(Boolean).join(', '),
      seccion:      seccionParaGrupo(rubro),
      producto:     rubro,
      // El granel del grupo va como orden propia: Producción no da de alta el granel acá.
      granelAparte: conCant.some(it => it.granelAparte) || cfgGetReqGranel(rubro),
      presentacion: presStr + (tambores ? ` · Tambor ${tambores}` : ''),
      presentaciones,
      cantidad:     totalCant,
      criticidad:   CRITICIDAD[semaforo] || 'Media',
      prioridad:    Math.min(...conCant.map(it => it.prioridad ?? 9999)),
      envase:       conCant.find(it => it.envase)?.envase || '',
      tapa:         conCant.find(it => it.tapa)?.tapa || '',
      estado:       'pendiente',
      encargados:   [...new Set(conCant.flatMap(it => it.responsables||[]))],
      encargado:    [...new Set(conCant.flatMap(it => it.responsables||[]))].join(' / '),
      tambor:       tambores,
      fecha:        fechaPlanActual,
      cliente:      clientesReg.find(c => String(c.id) === String(conCant.find(i => i.cliente)?.cliente))?.nombre || ''
    });
  }

  ordenes.forEach((o, i) => { o.id = Date.now() + i; });
  return ordenes;
}

// POST compartido a Producción: lo usa tanto el botón "Enviar a producción"
// como el modal que ofrece enviar las órdenes recién reservadas, para que el
// toast de éxito y el manejo de errores sean consistentes en ambos flujos.
async function postOrdenesProduccion(ordenes, modo) {
  const resp = await api('POST', '/api/enviar-produccion', modo ? { ordenes, modo } : ordenes);
  // El servidor descarta las órdenes ya recepcionadas en SiGA. Normalmente construirOrdenes()
  // ya las filtró, así que si vuelve alguna es porque el plan en pantalla quedó viejo: se avisa
  // en vez de dejar creer que se enviaron.
  const omitidas = Array.isArray(resp?.recepcionadasOmitidas) ? resp.recepcionadasOmitidas : [];
  const enviadas = ordenes.length - omitidas.length;
  if (enviadas > 0) {
    const reempl = resp?.reemplazadas > 0 ? ` (se eliminaron ${resp.reemplazadas} del día)` : '';
    toast(`✓ ${enviadas} orden${enviadas !== 1 ? 'es' : ''} enviadas a Producción del Día${reempl}`);
  }
  if (omitidas.length) {
    const detalle = omitidas.map(o => `${o.producto} (mov #${o.numeroMovimiento})`).join(', ');
    toast(`${omitidas.length} orden${omitidas.length !== 1 ? 'es' : ''} ya producida${omitidas.length !== 1 ? 's' : ''} y recepcionada${omitidas.length !== 1 ? 's' : ''}, no se reenvió: ${detalle}`, true);
  }
}

// Órdenes de construirOrdenes() que corresponden a ítems sellados con el
// movimiento de reserva recién creado. Granel: 1 orden por ítem (match por
// producto). Fraccionado: 1 orden por rubro (match por rubro||producto).
function ordenesRecienReservadas(numeroMovimiento) {
  if (numeroMovimiento == null) return [];
  const items = planCache?.items || [];
  const reservados = items.filter(it => it.reservaMovimiento?.numeroMovimiento === numeroMovimiento);
  if (!reservados.length) return [];
  const claves = new Set(reservados.map(it => it.esGranel ? it.producto : (it.rubro || it.producto)));
  return construirOrdenes().filter(o => claves.has(o.producto));
}

function eTabSwitch(tab) {
  const isOrdenes = tab === 'ordenes';
  document.getElementById('enviarLista').style.display = isOrdenes ? 'flex' : 'none';
  document.getElementById('enviarMP').style.display    = isOrdenes ? 'none' : 'block';
  const btnO = document.getElementById('eTabBtnOrdenes');
  const btnM = document.getElementById('eTabBtnMP');
  btnO.style.borderBottomColor = isOrdenes ? '#1e40af' : 'transparent';
  btnO.style.color = isOrdenes ? '#1e40af' : 'var(--muted)';
  btnM.style.borderBottomColor = isOrdenes ? 'transparent' : '#1e40af';
  btnM.style.color = isOrdenes ? 'var(--muted)' : '#1e40af';
}

async function calcularYRenderizarMP() {
  const items = planCache?.items || [];
  const mpMap = {};
  for (const it of items) {
    const cant = it.cantConfirmada ?? it.cantSugerida ?? 0;
    if (cant <= 0) continue;
    const plu = String(it.idProducto);
    // intentar cargar fórmula si no está en cache
    if (!formulasAllCache[plu]) {
      try {
        const bom = await api('GET', `/api/bom/producto/${plu}`);
        if (bom.length) formulasAllCache[plu] = bom.map(c => ({ ...c, _fromSiga: true }));
      } catch(e) {}
    }
    const formula = formulasAllCache[plu] || [];
    for (const c of formula) {
      const k = String(c.plu);
      if (!mpMap[k]) mpMap[k] = { nombre: c.nombre, total: 0 };
      mpMap[k].total = Math.round((mpMap[k].total + c.cantPorUnidad * cant) * 10000) / 10000;
    }
  }
  const mpList = Object.entries(mpMap).map(([plu, v]) => ({ plu, ...v }));
  const body = document.getElementById('enviarMPBody');
  if (!mpList.length) {
    body.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px 0">Sin fórmulas definidas para las presentaciones del plan.</div>';
    return;
  }
  body.innerHTML = '<div style="color:var(--muted);font-size:11px;margin-bottom:6px">Cargando stock…</div>';
  const stockMap = new Map();
  try {
    const rows = await api('GET', `/api/stock/plus?ids=${mpList.map(r=>r.plu).join(',')}`);
    for (const r of rows) stockMap.set(String(r.IdProducto), parseFloat(r.StockActual));
  } catch(e) {}
  body.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr style="background:#f1f5f9">
      <th style="text-align:left;padding:5px 8px;font-size:11px;color:var(--muted)">Componente</th>
      <th style="text-align:right;padding:5px 8px;font-size:11px;color:var(--muted)">Necesario</th>
      <th style="text-align:right;padding:5px 8px;font-size:11px;color:var(--muted)">Stock</th>
      <th style="text-align:right;padding:5px 8px;font-size:11px;color:var(--muted)">Diferencia</th>
    </tr></thead><tbody>
    ${mpList.map(r => {
      const stock = stockMap.has(r.plu) ? stockMap.get(r.plu) : null;
      const diff  = stock !== null ? Math.round((stock - r.total) * 10000) / 10000 : null;
      const falta = diff !== null && diff < 0;
      return `<tr style="border-bottom:1px solid var(--md-outline-variant)${falta?';background:#fff5f5':''}">
        <td style="padding:6px 8px${falta?';font-weight:600':''}">
          ${falta?'<span style="color:var(--red-text);margin-right:4px">⚠</span>':''}${escHtml(r.nombre)}
          <span style="font-size:10px;color:var(--muted);margin-left:4px">PLU ${escHtml(String(r.plu))}</span>
        </td>
        <td style="text-align:right;padding:6px 8px;font-family:system-ui,sans-serif;font-weight:700">${r.total}</td>
        <td style="text-align:right;padding:6px 8px;color:${stock===null?'var(--muted)':falta?'var(--red-text)':'var(--verde)'}">${stock!==null?stock:'—'}</td>
        <td style="text-align:right;padding:6px 8px;font-weight:700;color:${diff===null?'var(--muted)':falta?'var(--red-text)':'var(--verde)'}">
          ${diff!==null?(diff>=0?'+':'')+diff:'—'}
        </td>
      </tr>`;
    }).join('')}
    </tbody></table>`;
}

async function abrirModalEnviar() {
  try {
  const ordenes = construirOrdenes();
  if (!ordenes.length) { toast('Sin grupos con cantidad sugerida', true); return; }

  eTabSwitch('ordenes');
  const CRIT_COLOR = { Urgente: '#FF1744', Alta: 'var(--red-text)', Media: 'var(--amb-text)', Baja: 'var(--grn-text)' };
  const html = ordenes.map(o => `
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px 14px;display:flex;align-items:flex-start;gap:10px">
      <div style="flex:1">
        <div style="font-weight:700;font-size:14px">${escHtml(o.producto)}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:2px">${escHtml(o.presentacion)}</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-size:11px;font-weight:700;color:${CRIT_COLOR[o.criticidad]||'#555'}">${o.criticidad}</div>
        <div style="font-size:11px;color:var(--muted)">${o.seccion}</div>
      </div>
    </div>`).join('');

  document.getElementById('enviarLista').innerHTML = html;
  document.getElementById('enviarCount').textContent = `${ordenes.length} orden${ordenes.length !== 1 ? 'es' : ''} a crear`;
  document.getElementById('enviarMPBody').innerHTML = '<div style="color:var(--muted);font-size:13px">Calculando…</div>';
  document.getElementById('overlayEnviar').classList.add('open');
  calcularYRenderizarMP(); // async, no await — se llena en background
  } catch(err) { toast('Error abriendo modal: ' + err.message, true); console.error(err); }
}

async function confirmarEnviarProduccion() {
  const ordenes = construirOrdenes();
  if (!ordenes.length) return;

  // Enviar a Producción sin reservar deja las órdenes sin stock apartado: al conciliar no hay
  // reserva contra la cual descontar el consumo. Se avisa y se ofrece reservar primero; si el
  // operador elige seguir sin reservar, el envío continúa como antes.
  const itemSinReservar = it => (it.cantConfirmada ?? it.cantSugerida ?? 0) > 0
    && !(it.reservaMovimiento && it.reservaMovimiento.numeroMovimiento != null);
  // Con la carga a SiGA apagada nunca va a haber reserva: el aviso sería un cartel fijo.
  const sinReservar = movStockHabilitado() ? (planCache?.items || []).filter(itemSinReservar) : [];
  if (sinReservar.length) {
    const nombres = sinReservar.map(it => it.producto).join('\n· ');
    const plural  = sinReservar.length > 1;
    const reservar = await showConfirm(
      '⚠ Sin reservar',
      `${sinReservar.length} orden${plural ? 'es' : ''} se ${plural ? 'van' : 'va'} a enviar a Producción `
      + 'sin haber reservado la mercadería, así que su consumo no se podrá conciliar contra ninguna reserva:'
      + `\n\n· ${nombres}\n\n¿Reservar ahora?`,
      '🔒 Reservar ahora'
    );
    if (reservar) {
      document.getElementById('overlayEnviar').classList.remove('open');
      await abrirModalReserva();
      return;
    }
    // El botón de cancelar del modal de confirmación dice "Cancelar" y también se dispara con
    // ✕ o clic afuera: no se puede leer como "enviar sin reservar" sin preguntarlo explícito.
    const igual = await showConfirm(
      '⚠ Enviar sin reservar',
      `Se ${plural ? 'envían' : 'envía'} ${sinReservar.length} orden${plural ? 'es' : ''} sin reserva. `
      + 'La mercadería no queda apartada y el consumo se resolverá contra el depósito de recepción.'
      + '\n\n¿Enviar igual?',
      'Enviar sin reservar'
    );
    if (!igual) return;
  }

  const sinResp = ordenes.filter(o => !o.encargados?.length);
  if (sinResp.length) {
    const nombres = sinResp.map(o => o.producto).join('\n· ');
    const ok = await showConfirm(
      '⚠ Órdenes sin responsable',
      `${sinResp.length} orden${sinResp.length>1?'es':''} no tienen responsable asignado:\n\n· ${nombres}\n\n¿Enviar igual?`,
      'Enviar igual'
    );
    if (!ok) return;
  }
  // Validación: presentaciones sin código (PLU) → no se podrían identificar en Producción
  const sinCodigo = [];
  for (const o of ordenes) {
    if (Array.isArray(o.presentaciones) && o.presentaciones.length) {
      const faltan = o.presentaciones.filter(p => !p.plu);
      if (faltan.length) sinCodigo.push(`${o.producto} (${faltan.map(p => p.presentacion).join(', ')})`);
    } else if (!o.codigo) {
      sinCodigo.push(o.producto);
    }
  }
  if (sinCodigo.length) {
    const nombres = sinCodigo.join('\n· ');
    const ok = await showConfirm(
      '⚠ Presentaciones sin código',
      `${sinCodigo.length} ${sinCodigo.length>1?'productos no tienen':'producto no tiene'} código (PLU) y no se ${sinCodigo.length>1?'podrán':'podrá'} identificar en Producción:\n\n· ${nombres}\n\n¿Enviar igual?`,
      'Enviar igual'
    );
    if (!ok) return;
  }
  // Ya hay pedidos cargados ese día: preguntar cómo resolverlo. 'reemplazar' vacía el día
  // (menos lo protegido: completo o ya trabajado en producción, igual que el servidor) y deja
  // sólo los nuevos; 'sumar' suma cantidad a la orden existente en vez de pisarla. Sin
  // pedidos previos ese día, se envía directo (comportamiento de siempre).
  let modo = null;
  try {
    const existentes = (await api('GET', '/api/ordenes-produccion')) || [];
    const delDia = existentes.filter(o => o.fecha === fechaPlanActual);
    if (delDia.length) {
      const n = delDia.length;
      const reemplazar = await showConfirm(
        '⚠ Ya hay pedidos cargados hoy',
        `Ya hay ${n} pedido${n>1?'s':''} de producción cargado${n>1?'s':''} para hoy.\n\n`
        + '¿Eliminar los existentes y dejar sólo los nuevos?\n\n'
        + '(Los ya terminados o trabajados en producción no se borran.)',
        'Eliminar y dejar los nuevos'
      );
      if (reemplazar) {
        modo = 'reemplazar';
      } else {
        const sumar = await showConfirm(
          '¿Sumar a lo existente?',
          'Se va a sumar la cantidad nueva a la orden ya cargada del mismo producto, en vez de pisarla.\n\n¿Continuar?',
          'Sumar cantidades'
        );
        if (!sumar) return;
        modo = 'sumar';
      }
    }
  } catch (e) { /* si la consulta falla, continúa el envío normal */ }
  const btn = document.getElementById('btnConfirmarEnviar');
  btn.disabled = true; btn.textContent = 'Enviando…';
  try {
    await postOrdenesProduccion(ordenes, modo);
    document.getElementById('overlayEnviar').classList.remove('open');
  } catch (e) {
    toast('Error al enviar: ' + mensajeApiError(e), true);
  } finally {
    btn.disabled = false; btn.textContent = '✓ Confirmar y enviar';
  }
}

document.getElementById('btnEnviarProd').addEventListener('click', abrirModalEnviar);
document.getElementById('btnResumenMP').addEventListener('click', () => {
  const items = planCache?.items || [];
  if (!items.length) return;
  mostrarMPResumen(`📦 Materia Prima — ${fechaPlanActual || 'plan'}`, items);
});
document.getElementById('cerrarEnviar').addEventListener('click', () =>
  document.getElementById('overlayEnviar').classList.remove('open'));
document.getElementById('btnConfirmarEnviar').addEventListener('click', confirmarEnviarProduccion);
document.getElementById('overlayEnviar').addEventListener('click', e => {
  if (e.target === document.getElementById('overlayEnviar'))
    document.getElementById('overlayEnviar').classList.remove('open');
});
