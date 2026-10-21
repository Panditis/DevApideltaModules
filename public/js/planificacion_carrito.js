'use strict';

// ══════════════════ CARRITO DE PLANIFICACIÓN ══════════════════════
// El primer "+" pide la fecha; después se suman productos y al final se revisa MP y se envía
// todo junto a Producción del Día (POST /api/plan/:fecha/envio).
const CARRITO_KEY = 'planif_carrito_v1';
const CARRITO_VACIO = Object.freeze({ fecha: null, lineas: [], notas: '' });
let _lineaSeq = Date.now();
let carrito = CARRITO_VACIO;
let _enviandoCarrito = false; // envío en curso: evita el doble envío
const _detalleAbierto = new Set(); // _id de las líneas con el ⚙ desplegado: solo UI, en memoria

// ── Día picker: pide la fecha del carrito ────────────────────────
let semDiaPicker   = lunesDeEstaFecha(HOY);
let diaPicCallback = null;

function abrirDiaPicker(titulo, callback) {
  if (diaPicCallback) diaPicCallback(null); // un picker anterior sin resolver cuenta como cancelado
  semDiaPicker   = lunesDeEstaFecha(carrito.fecha || HOY);
  diaPicCallback = callback;
  document.getElementById('diaPicTitulo').textContent = titulo;
  renderDiaPicker();
  document.getElementById('overlayDiaPicker').classList.add('open');
}

function renderDiaPicker() {
  const chips = document.getElementById('diaPickerChips');
  let html = '';
  for (let i = 0; i < 7; i++) {
    const fecha = addDias(semDiaPicker, i);
    const dd    = parseInt(fecha.split('-')[2]);
    const esHoy = fecha === HOY;
    const sel   = fecha === carrito.fecha;
    html += `<button class="dia-chip${esHoy?' hoy':''}${sel?' active':''}${i>=5?' fin-semana':''}"
        onclick="seleccionarDiaPicker('${fecha}')">
      <span class="dia-nom">${DIAS_NOM[i]}</span>
      <span class="dia-num">${dd}</span>
      ${esHoy ? '<span class="dia-hoy">HOY</span>' : ''}
    </button>`;
  }
  chips.innerHTML = html;
}

// El callback recibe 'YYYY-MM-DD', o null si se cerró el picker sin elegir.
function seleccionarDiaPicker(fecha) {
  document.getElementById('overlayDiaPicker').classList.remove('open');
  if (diaPicCallback) { const cb = diaPicCallback; diaPicCallback = null; cb(fecha); }
}
function cerrarDiaPicker() {
  document.getElementById('overlayDiaPicker').classList.remove('open');
  if (diaPicCallback) { const cb = diaPicCallback; diaPicCallback = null; cb(null); }
}

document.getElementById('btnDiaPicAnt').addEventListener('click', () => {
  semDiaPicker = addDias(semDiaPicker, -7); renderDiaPicker();
});
document.getElementById('btnDiaPicSig').addEventListener('click', () => {
  semDiaPicker = addDias(semDiaPicker, 7); renderDiaPicker();
});
document.getElementById('cerrarDiaPicker').addEventListener('click', cerrarDiaPicker);
document.getElementById('overlayDiaPicker').addEventListener('click', e => {
  if (e.target === e.currentTarget) cerrarDiaPicker();
});

// ── Estado y persistencia ────────────────────────────────────────
function cargarCarrito() {
  try {
    const c = JSON.parse(localStorage.getItem(CARRITO_KEY) || 'null');
    if (c && Array.isArray(c.lineas)) return { fecha: null, notas: '', ...c };
  } catch { /* storage bloqueado: el carrito vive en memoria */ }
  return CARRITO_VACIO;
}
function persistirCarrito() {
  try { localStorage.setItem(CARRITO_KEY, JSON.stringify(carrito)); } catch { /* idem */ }
}
function guardarCarrito() {
  persistirCarrito();
  renderCarrito();
}
// Orden del carrito (mostrado y enviado): prioridad del grupo en el Resumen; sin rankingPos al final,
// en orden de alta (el sort es estable).
const _posLinea = l => l.rankingPos || Number.MAX_SAFE_INTEGER;
const lineasOrdenadas = () => [...carrito.lineas].sort((a, b) => _posLinea(a) - _posLinea(b));
const claveLinea = it => `${it.esGranel ? 'G' : 'F'}|${it.idProducto ?? it.producto}`;
const pedirFechaCarrito = titulo => new Promise(res => abrirDiaPicker(titulo, res));

// Punto de entrada de todos los "+": Resumen, búsqueda manual y granel manual.
async function agregarAlCarrito(items) {
  if (!items.length) return;
  if (!carrito.fecha) {
    const fecha = await pedirFechaCarrito('¿Para qué día planificás?');
    if (!fecha) return;
    carrito = { ...carrito, fecha };
  }
  const lineas = [...carrito.lineas];
  for (const it of items) {
    const i = lineas.findIndex(l => claveLinea(l) === claveLinea(it));
    if (i >= 0) lineas[i] = { ...lineas[i], cantConfirmada: (lineas[i].cantConfirmada || 0) + (it.cantConfirmada || 0) };
    else lineas.push({ ...it, _id: ++_lineaSeq, responsables: it.responsables || [] });
  }
  carrito = { ...carrito, lineas };
  await prefetchPackagingCarrito();
  guardarCarrito();
  document.getElementById('carritoPanel').hidden = false;
  toast(`${items.length} producto${items.length !== 1 ? 's' : ''} al carrito · ${formatFecha(carrito.fecha)}`);
}

// Envase/tapa precargados de la fórmula, con la regla de marcas de planificacion_estado.js.
async function prefetchPackagingCarrito() {
  const faltan = [...new Set(carrito.lineas.map(l => l.idProducto).filter(x => x != null && x !== '').map(String))]
    .filter(p => !(p in packagingCache));
  if (faltan.length) {
    try { Object.assign(packagingCache, await api('GET', `/api/plan/packaging?plus=${encodeURIComponent(faltan.join(','))}`)); }
    catch { /* sin packaging: se elige a mano */ }
  }
  // Una sola vez por línea (_pkOk): lo que el usuario vacíe a propósito después no se vuelve a llenar.
  carrito = { ...carrito, lineas: carrito.lineas.map(l => {
    if (l._pkOk) return l;
    const pk = packagingCache[String(l.idProducto)];
    if (!pk || l.esGranel) return { ...l, _pkOk: true };
    const envase = l.envase || (pk.envase ? pk.envase.codigo : '');
    const validas = tapasParaEnvase(opcionesPack(envasesReg, pk.envase), opcionesPack(tapasReg, pk.tapa), envase);
    const tapa = l.tapa || (pk.tapa && validas.some(t => String(t.codigo) === String(pk.tapa.codigo)) ? pk.tapa.codigo : '');
    return { ...l, envase, tapa, _pkOk: true };
  }) };
}

function editarLinea(id, campo, valor, rerender = true) {
  carrito = { ...carrito, lineas: carrito.lineas.map(l => {
    if (l._id !== id) return l;
    const n = { ...l, [campo]: valor };
    if (campo === 'envase') {
      // La tapa sigue la marca del envase: si la actual ya no es válida, queda en blanco.
      const pk = packagingCache[String(l.idProducto)] || {};
      const validas = tapasParaEnvase(opcionesPack(envasesReg, pk.envase), opcionesPack(tapasReg, pk.tapa), valor);
      if (!validas.some(t => String(t.codigo) === String(n.tapa || ''))) n.tapa = '';
    }
    return n;
  }) };
  persistirCarrito();
  if (rerender) renderCarrito();
}
function quitarLinea(id) {
  carrito = { ...carrito, lineas: carrito.lineas.filter(l => l._id !== id) };
  _detalleAbierto.delete(id);
  guardarCarrito();
}
function toggleDetalleLinea(id) {
  if (!_detalleAbierto.delete(id)) _detalleAbierto.add(id);
  renderCarrito();
}

// ── Render ───────────────────────────────────────────────────────
const CARRITO_SEL_STYLE = 'max-width:160px;border:1px solid var(--border);border-radius:4px;padding:4px 6px;font-size:12px;font-family:system-ui,sans-serif';

function selectPack(l, campo) {
  const pk = packagingCache[String(l.idProducto)] || {};
  const envOpts = opcionesPack(envasesReg, pk.envase);
  const opts = campo === 'envase' ? envOpts : tapasParaEnvase(envOpts, opcionesPack(tapasReg, pk.tapa), l.envase);
  return `<select style="${CARRITO_SEL_STYLE}" onchange="editarLinea(${l._id},'${campo}',this.value)"${campo === 'tapa' && !l.envase ? ' disabled' : ''}>
    <option value="">—</option>
    ${opts.map(o => `<option value="${escHtml(String(o.codigo))}" ${String(o.codigo) === String(l[campo] || '') ? 'selected' : ''}>${escHtml(o.nombre || o.codigo)}</option>`).join('')}
  </select>`;
}
function selectCliente(l) {
  return `<select style="${CARRITO_SEL_STYLE}" onchange="editarLinea(${l._id},'cliente',this.value)">
    <option value="">—</option>
    ${clientesReg.map(c => `<option value="${escHtml(String(c.id))}" ${String(c.id) === String(l.cliente || '') ? 'selected' : ''}>${escHtml(c.nombre)}</option>`).join('')}
  </select>`;
}

function renderCarrito() {
  document.getElementById('carritoBadge').textContent = carrito.lineas.length;
  document.getElementById('carritoFecha').textContent = carrito.fecha ? formatFecha(carrito.fecha) : 'sin fecha';
  const notasEl = document.getElementById('carritoNotas');
  if (document.activeElement !== notasEl) notasEl.value = carrito.notas || '';
  document.getElementById('btnCarritoEnviar').disabled = !carrito.lineas.length || _enviandoCarrito;
  const cont = document.getElementById('carritoTabla');
  if (!carrito.lineas.length) {
    cont.innerHTML = '<div class="loading">Vacío. Agregá productos desde el Resumen con "+".</div>';
    return;
  }
  const filaDetalle = l => `<tr style="background:var(--md-surface-1)">
      <td colspan="6" style="padding:6px 12px">
        <div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap;font-size:12px">
          ${l.esGranel ? '' : `<label>Envase ${selectPack(l, 'envase')}</label><label>Tapa ${selectPack(l, 'tapa')}</label>`}
          <label>Cliente ${selectCliente(l)}</label>
        </div>
      </td></tr>`;
  cont.innerHTML = `<table><thead><tr>
      <th>Producto</th><th>Cant.</th><th>Responsables</th><th>Tambor</th><th></th><th></th>
    </tr></thead><tbody>
    ${lineasOrdenadas().map(l => `<tr>
      <td>${escHtml(l.presentacion || l.producto)}${l.presentacion ? `<div class="text-sm">${escHtml(l.producto)}</div>` : ''}${l.granelPrevioDe ? `<div class="text-sm">granel previo de ${escHtml(l.granelPrevioDe)}</div>` : ''}</td>
      <td style="white-space:nowrap"><input type="number" min="0" step="any" value="${l.cantConfirmada || 0}" style="width:80px"
           onchange="editarLinea(${l._id},'cantConfirmada',Math.max(0,parseFloat(this.value)||0))"> ${l.esGranel ? escHtml(l.unidadGranel || 'kg') : ''}</td>
      <td>${renderRespMulti({ ...l, id: l._id })}</td>
      <td>${esItemMiel(l) ? `<input type="text" value="${escHtml(l.tambor || '')}" placeholder="—" style="width:70px" onchange="editarLinea(${l._id},'tambor',this.value.trim())">` : ''}</td>
      <td><button class="btn ${_detalleAbierto.has(l._id) ? 'btn-primary' : 'btn-secondary'} btn-sm" title="Envase, tapa y cliente" onclick="toggleDetalleLinea(${l._id})">⚙</button></td>
      <td><button class="btn btn-danger btn-sm" onclick="quitarLinea(${l._id})">✕</button></td>
    </tr>${_detalleAbierto.has(l._id) ? filaDetalle(l) : ''}`).join('')}
    </tbody></table>`;
}

// ── Revisar y enviar ─────────────────────────────────────────────
// Avisos que antes eran 6 confirms encadenados: se muestran todos juntos en el resumen de MP.
async function avisosCarrito(items) {
  const avisos = [];
  const nombre = it => escHtml(it.presentacion || it.producto);
  const sinResp = items.filter(it => !(it.responsables || []).length).map(nombre);
  if (sinResp.length) avisos.push(`Sin responsable: ${sinResp.join(', ')}`);
  const sinCod = items.filter(it => (it.esGranel ? !it.idGranel : it.idProducto == null)).map(nombre);
  if (sinCod.length) avisos.push(`Sin código: ${sinCod.join(', ')}`);
  const sinTambor = items.filter(it => esItemMiel(it) && !it.tambor).map(nombre);
  if (sinTambor.length) avisos.push(`Miel sin tambor: ${sinTambor.join(', ')}`);
  try {
    const plan = await api('GET', `/api/plan/${carrito.fecha}`);
    if ((plan.items || []).length) avisos.push(`Ya hay ${plan.items.length} producto(s) enviados para ese día: lo repetido se suma.`);
  } catch { /* sin plan previo */ }
  return `<div style="margin-bottom:10px">
      ${avisos.map(a => `<div style="color:var(--red-text);font-size:13px">⚠ ${a}</div>`).join('')}
      <label style="display:flex;gap:6px;align-items:center;font-size:13px;margin-top:6px;color:var(--muted)"
             title="Deshabilitado: la reserva de mercadería en SiGA está apagada">
        <input type="checkbox" disabled> Reservar mercadería en SiGA (deshabilitado)
      </label>
    </div>`;
}

// Guarda de re-entrada: cubre todo el trayecto (avisos, resumen MP, POST) hasta que termina o falla.
async function revisarYEnviarCarrito() {
  if (_enviandoCarrito || !carrito.fecha || !carrito.lineas.length) return;
  _enviandoCarrito = true;
  document.getElementById('btnCarritoEnviar').disabled = true;
  try { await enviarCarrito(); }
  finally { _enviandoCarrito = false; renderCarrito(); }
}

async function enviarCarrito() {
  await cargarGruposCfgSiVacio(); // esItemMiel (tambor) depende del catálogo de grupos
  const sinCant = carrito.lineas.filter(l => !(l.cantConfirmada > 0));
  if (sinCant.length) {
    toast(`Cantidad 0: ${sinCant.map(l => l.presentacion || l.producto).join(', ')}. Completala o quitá la línea.`, true);
    return;
  }
  // _id, _pkOk y rankingPos son del carrito (UI/orden): no viajan al servidor. prioridad = lugar en el orden mostrado.
  const items = lineasOrdenadas().map(({ _id, _pkOk, rankingPos, ...it }, i) => ({ ...it, prioridad: i + 1 }));
  const fecha = carrito.fecha;
  const ok = await mostrarMPResumen(`📤 Enviar a producción · ${formatFecha(fecha)}`, items, await avisosCarrito(items));
  if (!ok) return;
  try {
    const r = await api('POST', `/api/plan/${fecha}/envio`, { items, notas: carrito.notas || '' });
    carrito = CARRITO_VACIO;
    guardarCarrito();
    document.getElementById('carritoPanel').hidden = true;
    toast(`✓ Enviado a Producción del Día: ${r.nuevas} orden(es) nuevas, ${r.actualizadas} actualizadas`);
    if ((r.omitidos || []).length) toast(`No se enviaron (producción ya los tomó): ${r.omitidos.join(', ')}`, true);
    irAlDia(fecha);
  } catch (e) { toast('No se pudo enviar: ' + mensajeApiError(e), true); }
}

document.getElementById('btnCarrito').addEventListener('click', () => {
  const p = document.getElementById('carritoPanel');
  p.hidden = !p.hidden;
  // Responsables, envases y clientes cargan después del primer render: se redibuja al abrir.
  if (!p.hidden) renderCarrito();
});
document.getElementById('btnCarritoCerrar').addEventListener('click', () => { document.getElementById('carritoPanel').hidden = true; });
document.getElementById('btnCarritoVaciar').addEventListener('click', () => {
  confirmarModal('Vaciar carrito', 'Se descartan todas las líneas y las notas.', 'Vaciar', () => { carrito = CARRITO_VACIO; guardarCarrito(); }, true);
});
document.getElementById('carritoNotas').addEventListener('input', e => {
  carrito = { ...carrito, notas: e.target.value };
  persistirCarrito();
});
document.getElementById('btnCarritoFecha').addEventListener('click', async () => {
  const fecha = await pedirFechaCarrito('Cambiar día del carrito');
  if (fecha) { carrito = { ...carrito, fecha }; guardarCarrito(); }
});
document.getElementById('btnCarritoEnviar').addEventListener('click', revisarYEnviarCarrito);
carrito = cargarCarrito();
renderCarrito();
// esItemMiel lee el catálogo de grupos, que carga perezosamente: se redibuja cuando llega.
cargarGruposCfgSiVacio().then(renderCarrito).catch(() => {});

// ══════════════════ MULTI-RESPONSABLE WIDGET ══════════════════════

// it.id = id de la línea del carrito. bloqueado: se ven los responsables pero no se abre el desplegable.
function renderRespMulti(it, bloqueado) {
  const resps = Array.isArray(it.responsables) ? it.responsables : (it.responsable ? [it.responsable] : []);
  const chips = resps.length
    ? resps.map(r => `<span class="resp-chip-sm">${escHtml(r)}</span>`).join('')
    : `<span style="color:var(--muted);font-size:11px">Sin asignar</span>`;
  if (bloqueado) {
    return `<div class="resp-multi" onclick="event.stopPropagation()">
      <div class="resp-multi-display resp-multi-bloq" title="Orden reservada: anulá la reserva para cambiarlo">${chips}</div>
    </div>`;
  }
  const opts = responsablesCache.map(r => {
    const nom = respNombre(r);
    return `<label style="display:flex;align-items:center;gap:7px;padding:6px 10px;cursor:pointer;font-size:12px;border-bottom:1px solid #f0f0f0;hover:background:#f5f5f5">
      <input type="checkbox" ${resps.includes(nom)?'checked':''} style="accent-color:var(--md-primary)"
        onchange="toggleResp(${it.id},'${escHtml(nom).replace(/'/g,"\\'")}')">
      ${escHtml(nom)}
    </label>`;
  }).join('');
  return `<div class="resp-multi" onclick="event.stopPropagation()">
    <div class="resp-multi-display" id="rdsp-${it.id}" onclick="toggleRespDrop('rmd-${it.id}')">
      ${chips}<span class="rm-arrow">▾</span>
    </div>
    <div class="resp-dropdown" id="rmd-${it.id}" style="display:none">
      ${opts || '<div style="padding:8px 10px;color:var(--muted);font-size:12px">Sin responsables cargados.</div>'}
    </div>
  </div>`;
}

let _openRespDrop = null;
function toggleRespDrop(id) {
  if (_openRespDrop && _openRespDrop !== id) {
    const prev = document.getElementById(_openRespDrop);
    if (prev) prev.style.display = 'none';
  }
  const dd = document.getElementById(id);
  if (!dd) return;
  const show = dd.style.display === 'none';
  if (show) {
    const trigger = document.getElementById(id.replace('rmd-', 'rdsp-'));
    if (trigger) {
      const r = trigger.getBoundingClientRect();
      dd.style.top  = (r.bottom + 2) + 'px';
      dd.style.left = r.left + 'px';
      dd.style.minWidth = r.width + 'px';
    }
    dd.style.display = 'block';
  } else {
    dd.style.display = 'none';
  }
  _openRespDrop = show ? id : null;
}
document.addEventListener('click', () => {
  if (_openRespDrop) {
    const el = document.getElementById(_openRespDrop);
    if (el) el.style.display = 'none';
    _openRespDrop = null;
  }
});

function toggleResp(lineaId, nombre) {
  const l = carrito.lineas.find(x => x._id === lineaId);
  if (!l) return;
  const resps = l.responsables.includes(nombre) ? l.responsables.filter(r => r !== nombre) : [...l.responsables, nombre];
  editarLinea(lineaId, 'responsables', resps, false); // sin redibujar: el desplegable sigue abierto
  const dsp = document.getElementById(`rdsp-${lineaId}`);
  if (dsp) dsp.innerHTML = (resps.length ? resps.map(r => `<span class="resp-chip-sm">${escHtml(r)}</span>`).join('')
    : `<span style="color:var(--muted);font-size:11px">Sin asignar</span>`) + '<span class="rm-arrow">▾</span>';
}
