'use strict';

// ══════════════════ CARRITO DE PLANIFICACIÓN ══════════════════════
// El primer "+" pide la fecha; después se suman productos y al final se revisa MP y se envía
// todo junto a Producción del Día (POST /api/plan/:fecha/envio).
const CARRITO_KEY = 'planif_carrito_v1';
const CARRITO_VACIO = Object.freeze({ fecha: null, lineas: [], notas: '' });
let _lineaSeq = Date.now();
let carrito = CARRITO_VACIO;
let _enviandoCarrito = false; // envío en curso: evita el doble envío
let _lineaAbierta = null; // _id de la línea con el detalle desplegado (de a una): solo UI, en memoria

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
  guardarCarrito();
}
function toggleLineaCarrito(id) {
  _lineaAbierta = _lineaAbierta === id ? null : id;
  renderCarrito();
}
// Cantidad: sin redibujar (el foco queda en el input); nada más en pantalla depende de ella.
function setCantLinea(id, valor) {
  const v = Math.max(0, parseFloat(valor) || 0);
  editarLinea(id, 'cantConfirmada', v, false);
  const inp = document.getElementById(`cq-${id}`);
  if (inp) inp.value = v;
}
function cambiarCantLinea(id, delta) {
  const l = carrito.lineas.find(x => x._id === id);
  if (l) setCantLinea(id, Math.round(((l.cantConfirmada || 0) + delta) * 100) / 100);
}

// ── Render ───────────────────────────────────────────────────────
function selectPack(l, campo) {
  const pk = packagingCache[String(l.idProducto)] || {};
  const envOpts = opcionesPack(envasesReg, pk.envase);
  const opts = campo === 'envase' ? envOpts : tapasParaEnvase(envOpts, opcionesPack(tapasReg, pk.tapa), l.envase);
  return `<select class="cart-sel" onchange="editarLinea(${l._id},'${campo}',this.value)"${campo === 'tapa' && !l.envase ? ' disabled' : ''}>
    <option value="">—</option>
    ${opts.map(o => `<option value="${escHtml(String(o.codigo))}" ${String(o.codigo) === String(l[campo] || '') ? 'selected' : ''}>${escHtml(o.nombre || o.codigo)}</option>`).join('')}
  </select>`;
}
function selectCliente(l) {
  return `<select class="cart-sel" onchange="editarLinea(${l._id},'cliente',this.value)">
    <option value="">—</option>
    ${clientesReg.map(c => `<option value="${escHtml(String(c.id))}" ${String(c.id) === String(l.cliente || '') ? 'selected' : ''}>${escHtml(c.nombre)}</option>`).join('')}
  </select>`;
}

// Segunda línea de cada ítem: resumen de lo que tiene cargado (el detalle completo se edita al desplegar).
function resumenLinea(l) {
  const pk = packagingCache[String(l.idProducto)] || {};
  const resps = l.responsables || [];
  const partes = [resps.length ? escHtml(resps.join(', ')) : '<span class="cart-warn">⚠ sin responsable</span>'];
  if (!l.esGranel) {
    const pack = [nomOpc(opcionesPack(envasesReg, pk.envase), l.envase), nomOpc(opcionesPack(tapasReg, pk.tapa), l.tapa)].filter(Boolean).join(' / ');
    if (pack) partes.push(escHtml(pack));
  }
  const cli = clientesReg.find(c => String(c.id) === String(l.cliente || ''));
  if (cli) partes.push(escHtml(cli.nombre));
  if (esItemMiel(l) && l.tambor) partes.push(`Tambor ${escHtml(l.tambor)}`);
  if (l.granelPrevioDe) partes.push(`granel previo de ${escHtml(l.granelPrevioDe)}`);
  return partes.join(' · ');
}

function detalleLinea(l) {
  const campo = (titulo, html) => `<div class="cart-f"><span>${titulo}</span>${html}</div>`;
  return `<div class="cart-detail">
    ${campo('Responsables', renderRespMulti({ ...l, id: l._id }))}
    ${l.esGranel ? '' : campo('Envase', selectPack(l, 'envase')) + campo('Tapa', selectPack(l, 'tapa'))}
    ${campo('Cliente', selectCliente(l))}
    ${esItemMiel(l) ? campo('Tambor', `<input type="text" value="${escHtml(l.tambor || '')}" placeholder="—" onchange="editarLinea(${l._id},'tambor',this.value.trim())">`) : ''}
  </div>`;
}

// Un ítem = dos líneas (nombre + cantidad, resumen); al hacer click se despliega el detalle debajo.
function filaCarrito(l) {
  const id = l._id, abierta = id === _lineaAbierta;
  return `<div class="cart-line${abierta ? ' abierta' : ''}">
    <div class="cart-main" onclick="toggleLineaCarrito(${id})">
      <div class="cart-row1">
        <span class="cart-name" title="${escHtml(nombreLinea(l))}">${escHtml(nombreLinea(l))}</span>
        <span class="cart-qty" onclick="event.stopPropagation()">
          <button class="cart-step" title="Menos" onclick="cambiarCantLinea(${id},-1)">−</button>
          <input id="cq-${id}" type="number" min="0" step="any" value="${l.cantConfirmada || 0}" onchange="setCantLinea(${id},this.value)">
          <button class="cart-step" title="Más" onclick="cambiarCantLinea(${id},1)">+</button>
          ${l.esGranel ? escHtml(l.unidadGranel || 'kg') : ''}
        </span>
        <button class="cart-x" title="Quitar" onclick="event.stopPropagation();quitarLinea(${id})">✕</button>
      </div>
      <div class="cart-row2" id="csum-${id}">${resumenLinea(l)}</div>
    </div>
    ${abierta ? detalleLinea(l) : ''}
  </div>`;
}

function renderCarrito() {
  const n = carrito.lineas.length;
  if (!carrito.lineas.some(l => l._id === _lineaAbierta)) _lineaAbierta = null;
  document.getElementById('carritoBadge').textContent = n;
  document.getElementById('carritoFecha').textContent = carrito.fecha ? formatFecha(carrito.fecha) : 'sin fecha';
  const notasEl = document.getElementById('carritoNotas');
  if (document.activeElement !== notasEl) notasEl.value = carrito.notas || '';
  const btnEnviar = document.getElementById('btnCarritoEnviar');
  btnEnviar.disabled = !n || _enviandoCarrito;
  btnEnviar.textContent = n ? `Enviar ${n} producto${n !== 1 ? 's' : ''} →` : 'Enviar a producción';
  document.getElementById('btnCarritoVaciar').hidden = !n;
  document.getElementById('carritoTabla').innerHTML = n
    ? lineasOrdenadas().map(filaCarrito).join('')
    : '<div class="loading">Agregá productos desde el Tablero con +</div>';
}

// ── Revisar y enviar ─────────────────────────────────────────────
// Avisos que antes eran 6 confirms encadenados: se muestran todos juntos en el resumen de MP.
async function avisosCarrito(items) {
  const avisos = [];
  const nombre = it => escHtml(nombreLinea(it));
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
  return `<div class="mp-avisos">
      ${avisos.map(a => `<div class="mp-aviso">⚠ ${a}</div>`).join('')}
      <label class="mp-reserva" title="Deshabilitado: la reserva de mercadería en SiGA está apagada">
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
    toast(`Cantidad 0: ${sinCant.map(nombreLinea).join(', ')}. Completala o quitá la línea.`, true);
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
  // El índice (no el nombre) viaja en el handler: sin strings interpolados en el HTML.
  const opts = responsablesCache.map((r, i) => {
    const nom = respNombre(r);
    return `<label style="display:flex;align-items:center;gap:7px;padding:6px 10px;cursor:pointer;font-size:12px;border-bottom:1px solid #f0f0f0;hover:background:#f5f5f5">
      <input type="checkbox" ${resps.includes(nom)?'checked':''} style="accent-color:var(--md-primary)"
        onchange="toggleResp(${it.id},${i})">
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

function toggleResp(lineaId, idx) {
  const l = carrito.lineas.find(x => x._id === lineaId);
  const nombre = respNombre(responsablesCache[idx]);
  if (!l || !nombre) return;
  const resps = l.responsables.includes(nombre) ? l.responsables.filter(r => r !== nombre) : [...l.responsables, nombre];
  editarLinea(lineaId, 'responsables', resps, false); // sin redibujar: el desplegable sigue abierto
  const sum = document.getElementById(`csum-${lineaId}`);
  if (sum) sum.innerHTML = resumenLinea(carrito.lineas.find(x => x._id === lineaId));
  const dsp = document.getElementById(`rdsp-${lineaId}`);
  if (dsp) dsp.innerHTML = (resps.length ? resps.map(r => `<span class="resp-chip-sm">${escHtml(r)}</span>`).join('')
    : `<span style="color:var(--muted);font-size:11px">Sin asignar</span>`) + '<span class="rm-arrow">▾</span>';
}
