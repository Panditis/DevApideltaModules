'use strict';
// ── TABLERO (pestaña principal) ───────────────────────────────────────────
// /api/plan/tablero: graneles base (desplegables en sus variedades), directos y fasón, todo en kg.
// "+" reparte los kg entre presentaciones (PlanReparto, lib/plan_reparto.js) y usa el carrito actual.
let tablero = null;
const tableroAbiertos = new Set(); // plu de graneles desplegados
// Lo tipeado en "Estimado" por id de fila. Sobrevive a los re-render (filtro, desplegar un granel)
// y se descarta al recargar el tablero, cuando los estimados cambian.
// Una variedad con 2+ graneles aparece bajo cada uno: su edición se guarda por productoRef (no por
// el id posicional) para que todas sus filas compartan el mismo valor.
const editadosTablero = new Map();
const claveEdicion = id => {
  const f = /^t\d+v\d+$/.test(id) ? filaPorId(id) : null;
  return f ? `v:${f.productoRef}` : id;
};
const valorEst = (id, porDefecto) => {
  const k = claveEdicion(id);
  return editadosTablero.has(k) ? editadosTablero.get(k) : porDefecto;
};
const SEMAFORO_DE_URGENCIA = { URGENTE: 'RED', PRONTO: 'YELLOW', OK: 'GREEN' };
const fmtKg = n => (n == null ? '—' : nfAR(n, 1));
// Filas sin peso (f.unidad === 'u'): los mismos campos *Kg vienen en unidades, se muestran con " u".
const esUnidades = f => f.unidad === 'u';
const fmtCantFila = (n, f) => (n == null ? '—' : `${nfAR(n, 1)}${esUnidades(f) ? ' u' : ''}`);
const fmtCob = c => (c == null ? '—' : `${nfAR(c, 1)} d`);
const fmtFechaTablero = f => (f ? formatFecha(f) : '—');

async function cargarTablero() {
  const cont = document.getElementById('tablaTablero');
  cont.innerHTML = '<div class="loading">Cargando datos desde Siga…</div>';
  try {
    tablero = await api('GET', '/api/plan/tablero');
    editadosTablero.clear();
    renderTablero();
  } catch (e) {
    tablero = null;
    document.getElementById('cardFason').hidden = true;
    document.getElementById('countTablero').textContent = '';
    cont.innerHTML = `<div style="color:var(--red-text);padding:12px">No se pudo cargar el tablero: ${escHtml(mensajeApiError(e))}
      <button class="btn btn-secondary btn-sm" style="margin-left:8px" onclick="cargarTablero()">Reintentar</button></div>`;
  }
}

// id de fila: t<i> (nivel superior), t<i>v<j> (variedad de un granel), f<c>x<k> (fasón)
function filaPorId(id) {
  if (!tablero) return null;
  let m = /^t(\d+)(?:v(\d+))?$/.exec(id);
  if (m) { const t = tablero.filas[+m[1]]; return m[2] == null ? t : (t && t.variedades[+m[2]]); }
  m = /^f(\d+)x(\d+)$/.exec(id);
  return m ? ((tablero.fason[+m[1]] || {}).filas || [])[+m[2]] : null;
}

const chipsResp = lista => ((lista || []).length
  ? lista.map(r => `<span class="resp-chip-sm">${escHtml(r)}</span>`).join('')
  : '<span style="color:var(--muted)">—</span>');

function avisosFila(f) {
  const a = [];
  if (f.estado === 'pausado') a.push(`<span class="aviso" title="Pausado">⏸ ${escHtml(f.motivo)}</span>`);
  if (esUnidades(f)) a.push('<span class="aviso" title="Sin peso: calculado en unidades">en unidades</span>');
  if ((f.sinPeso || []).length) a.push(`<span class="aviso" title="Sin peso: PLU ${escHtml(f.sinPeso.join(', '))}. No suman kg.">⚠ sin peso</span>`);
  if (f.granelSinConfigurar) a.push('<span class="aviso" title="Su granel no está en Graneles base del catálogo">⚠ granel sin configurar</span>');
  return a.join('');
}

function celdaEstimado(f, id) {
  if (f.estado === 'pausado') return '<td class="num">—</td>';
  return `<td class="num"><input type="number" min="0" step="0.1" id="est-${id}" value="${valorEst(id, f.estimadoKg ?? 0)}" style="width:80px;text-align:right"> ${esUnidades(f) ? 'u' : 'kg'}</td>`;
}
const celdaMas = (f, id) => (f.estado === 'pausado' ? '<td></td>'
  : `<td><button class="btn btn-primary btn-sm" title="Agregar al carrito" onclick="tableroAgregar('${id}')">+</button></td>`);

function filaProductoHTML(f, id, sangria) {
  return `<tr class="${f.estado === 'pausado' ? 'fila-pausada' : ''}">
    <td>${f.rankingPos ?? ''}</td>
    <td>${f.estado === 'pausado' ? '' : chipUrgencia(f.urgencia)}</td>
    <td style="padding-left:${sangria ? 28 : 8}px">${escHtml(f.productoRef)}${avisosFila(f)}</td>
    <td class="num">${fmtCantFila(f.ventaDiaKg, f)}</td>
    <td class="num">${fmtCantFila(f.stockCentralKg, f)}</td>
    <td class="num">${fmtCantFila(f.stockLocalesKg, f)} <button class="btn-mini" title="Stock por sucursal" onclick="abrirStockTablero('${id}')">🔍</button></td>
    <td class="num">${sangria ? '—' : fmtKg(f.stockGranelKg)}</td>
    <td class="num">${fmtCob(f.coberturaDias)}</td>
    ${celdaEstimado(f, id)}
    <td>${fmtFechaTablero(f.proximaFecha)}</td>
    <td>${chipsResp(f.responsables)}</td>
    ${celdaMas(f, id)}
  </tr>`;
}

function filaGranelHTML(g, i) {
  const abierto = tableroAbiertos.has(g.plu);
  const cab = `<tr class="fila-granel${g.estado === 'pausado' ? ' fila-pausada' : ''}">
    <td>${g.rankingPos ?? ''}</td>
    <td>${g.estado === 'pausado' ? '' : chipUrgencia(g.urgencia)}</td>
    <td><button class="btn-mini" onclick="toggleGranelTablero(${i})">${abierto ? '▼' : '▶'}</button>
      🛢 ${escHtml(g.nombre)} <span style="font-weight:400;color:var(--muted);font-size:11px">${g.variedades.length} variedades</span>${avisosFila(g)}</td>
    <td class="num" title="kg de granel por día que consumen las variedades activas">${fmtKg(g.ventaDiaKg)}</td>
    <td class="num">—</td><td class="num">—</td>
    <td class="num" title="Stock del granel en los depósitos de la central">${fmtKg(g.stockGranelKg)}</td>
    <td class="num">${fmtCob(g.coberturaDias)}</td>
    ${celdaEstimado(g, `t${i}`)}
    <td>${fmtFechaTablero(g.proximaFecha)}</td>
    <td>${chipsResp(g.responsables)}</td>
    ${celdaMas(g, `t${i}`)}
  </tr>`;
  return cab + (abierto ? g.variedades.map((v, j) => filaProductoHTML(v, `t${i}v${j}`, true)).join('') : '');
}

function coincideTablero(f, q) {
  if (!q) return true;
  const t = s => String(s || '').toLowerCase().includes(q);
  return f.nivel === 'granel' ? t(f.nombre) || f.variedades.some(v => t(v.productoRef)) : t(f.productoRef);
}

const CABECERA_TABLERO = `<tr><th>#</th><th>Urgencia</th><th>Producto</th><th class="num">Venta/día (kg)</th>
  <th class="num">Stock central (kg)</th><th class="num">Stock locales (kg)</th><th class="num">Stock granel (kg)</th>
  <th class="num">Cobertura</th><th class="num">Estimado</th><th>Próx. producción</th><th>Responsables</th><th></th></tr>`;

function renderTablero() {
  if (!tablero) return;
  const q = document.getElementById('filtroTablero').value.trim().toLowerCase();
  const filas = tablero.filas.map((f, i) => (coincideTablero(f, q) ? (f.nivel === 'granel' ? filaGranelHTML(f, i) : filaProductoHTML(f, `t${i}`, false)) : '')).join('');
  document.getElementById('countTablero').textContent = `${tablero.filas.length} filas · cubrir ${tablero.dias} días · ventas de ${tablero.ventana} días sin Casa Central`;
  document.getElementById('tablaTablero').innerHTML = filas
    ? `<table class="tabla-tablero"><thead>${CABECERA_TABLERO}</thead><tbody>${filas}</tbody></table>`
    : '<div class="loading">Sin productos para mostrar.</div>';
  renderFason();
}

function renderFason() {
  document.getElementById('cardFason').hidden = !tablero.fason.length;
  document.getElementById('tablaFason').innerHTML = tablero.fason.map((g, c) => `
    <div style="padding:8px 10px;font-weight:600">${escHtml(g.cliente)}</div>
    <table class="tabla-tablero"><thead><tr><th>Producto</th><th class="num">Stock central (kg)</th><th>Próx. producción</th><th>Responsables</th><th class="num">Cantidad (kg / u)</th><th></th></tr></thead><tbody>
    ${g.filas.map((f, k) => `<tr class="${f.estado === 'pausado' ? 'fila-pausada' : ''}">
      <td>${escHtml(f.productoRef)}${avisosFila(f)}</td><td class="num">${fmtCantFila(f.stockCentralKg, f)}</td>
      <td>${fmtFechaTablero(f.proximaFecha)}</td><td>${chipsResp(f.responsables)}</td>
      ${f.estado === 'pausado' ? '<td class="num">—</td><td></td>'
        : `<td class="num"><input type="number" min="0" step="0.1" id="est-f${c}x${k}" value="${valorEst(`f${c}x${k}`, '')}" placeholder="0" style="width:80px;text-align:right"> ${esUnidades(f) ? 'u' : 'kg'}</td>
           <td><button class="btn btn-primary btn-sm" onclick="tableroAgregar('f${c}x${k}')">+</button></td>`}
    </tr>`).join('')}</tbody></table>`).join('');
}

function toggleGranelTablero(i) {
  const plu = tablero.filas[i].plu;
  if (tableroAbiertos.has(plu)) tableroAbiertos.delete(plu); else tableroAbiertos.add(plu);
  renderTablero();
}

// ── "+" al carrito ──────────────────────────────────────────────────────
function kgDeFila(id, porDefecto) {
  const n = parseFloat(valorEst(id, porDefecto));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function itemsDeProducto(f, kg) {
  if (f.granelDirecto && f.tipo === 'directo') return [itemDeGranelDirecto(f, kg)];
  return PlanReparto.repartirEnPresentaciones(kg, f.presentaciones).map(r => ({
    idProducto: r.plu, producto: r.nombre, presentacion: r.presentacion, rubro: f.productoRef, rankingPos: f.rankingPos,
    semaforo: SEMAFORO_DE_URGENCIA[f.urgencia] || 'YELLOW', pendientes: 0,
    cantSugerida: r.unidades, cantConfirmada: r.unidades,
    idGranel: (f.granelPlus || [])[0] || '', nombreGranel: '', cantPorUnidad: 0,
    granelNecesario: 0, granelDisponible: null, granelOk: true,
    responsables: [...(f.responsables || [])],
    ...(f.clienteId != null ? { cliente: f.clienteId } : {}),
    ...(f.tipo === 'granel' ? { granelAparte: true } : {}),
  }));
}

function itemDeGranel(g, kg) {
  const cant = Math.round(kg * 100) / 100;
  return {
    idProducto: g.plu, producto: g.nombre, rubro: 'Granel', esGranel: true, rankingPos: g.rankingPos,
    cantSugerida: cant, cantConfirmada: cant, unidadGranel: 'kg',
    semaforo: SEMAFORO_DE_URGENCIA[g.urgencia] || 'YELLOW', pendientes: 0, promMes: 0,
    idGranel: g.plu, nombreGranel: g.nombre, cantPorUnidad: 0,
    granelNecesario: 0, granelDisponible: null, granelOk: true,
    responsables: [...(g.responsables || [])],
  };
}

// Grupo que se produce como granel (granelDirecto, ej. Mix Europeo): UNA orden de granel en kg al PLU granel del
// grupo, como el viejo "+ Agregar" granel del Resumen. producto = productoRef y sin idProducto: así la línea del
// carrito (claveLinea) y la clave del plan (claveItemPlan, G|producto) coinciden con las que dejaba el Resumen.
function itemDeGranelDirecto(f, kg) {
  const g = { plu: f.granelDirecto, nombre: f.productoRef, urgencia: f.urgencia, rankingPos: f.rankingPos, responsables: f.responsables };
  return { ...itemDeGranel(g, kg), idProducto: null, ...(f.clienteId != null ? { cliente: f.clienteId } : {}) };
}

function itemsDeTablero(id) {
  const f = filaPorId(id);
  if (!f || f.estado === 'pausado') return [];
  const kg = kgDeFila(id, f.estimadoKg || 0);
  if (!kg) return [];
  return f.nivel === 'granel' ? [itemDeGranel(f, kg)] : itemsDeProducto(f, kg);
}

function tableroAgregar(id) {
  const items = itemsDeTablero(id);
  if (!items.length) { toast('Nada para agregar: la cantidad es 0 o el producto no tiene presentaciones con peso', true); return; }
  agregarAlCarrito(items);
}

function tableroAgregarTodo() {
  if (!tablero) return;
  // Una variedad de 2+ graneles viene repetida (el JSON del servidor la copia en cada granel): una sola vez.
  const vistas = new Set();
  const unica = id => {
    const f = filaPorId(id), k = f.nivel === 'granel' ? `g:${f.plu}` : `p:${f.productoRef}`;
    return !vistas.has(k) && !!vistas.add(k);
  };
  const ids = tablero.filas.flatMap((f, i) => [`t${i}`, ...(f.nivel === 'granel' ? f.variedades.map((_, j) => `t${i}v${j}`) : [])]).filter(unica);
  const items = ids.flatMap(itemsDeTablero);
  if (!items.length) { toast('No hay estimados mayores a 0 para agregar', true); return; }
  agregarAlCarrito(items);
}

// ── Stock por sucursal (modal 🔍 existente, renderStockDetalle de planificacion_resumen.js) ──
async function abrirStockTablero(id) {
  const f = filaPorId(id);
  if (!f) return;
  const g = { productoRef: f.productoRef, presentaciones: f.presentaciones.map(p => ({ plu: p.plu, plus: p.plus || [p.plu], presentacion: p.presentacion, baseNombre: p.nombre })) };
  if (!g.presentaciones.length) { toast('Este producto no tiene presentaciones con peso para consultar', true); return; }
  document.getElementById('stockDetTitulo').textContent = f.productoRef;
  document.getElementById('stockDetBody').innerHTML = '<div class="loading">Cargando…</div>';
  document.getElementById('overlayStockDet').classList.add('open');
  try {
    const data = await api('GET', `/api/plan/stock-detalle?plus=${encodeURIComponent([...new Set(g.presentaciones.flatMap(p => p.plus))].join(','))}`);
    document.getElementById('stockDetBody').innerHTML = renderStockDetalle(data, g);
  } catch (e) {
    document.getElementById('stockDetBody').innerHTML = `<div style="color:var(--red-text);padding:10px">Error: ${escHtml(mensajeApiError(e))}</div>`;
  }
}

// ── Días a cubrir (parámetro compartido; /api/plan/params) ───────────────
let _diasTablero = null;
async function cargarDiasTablero() {
  try {
    const r = await api('GET', '/api/plan/params');
    _diasTablero = r.diasObjetivo;
    document.getElementById('inputDiasTablero').value = r.diasObjetivo;
  } catch { /* sin valor a la vista: el servidor igual usa el suyo */ }
}
document.getElementById('inputDiasTablero').addEventListener('change', async e => {
  const inp = e.target, n = Number(inp.value);
  const restaurar = () => { inp.value = _diasTablero ?? ''; };
  if (!Number.isInteger(n) || n < 1 || n > 180) { toast('Días a cubrir: un número entero de 1 a 180', true); restaurar(); return; }
  if (n === _diasTablero) return;
  try {
    await api('PUT', '/api/plan/params', { diasObjetivo: n });
    _diasTablero = n;
    toast(`Días a cubrir: ${n}`);
    cargarTablero();
  } catch (err) { toast('No se pudo guardar los días a cubrir: ' + mensajeApiError(err), true); restaurar(); }
});
document.getElementById('tab-tablero').addEventListener('input', e => {
  if (!e.target.id || !e.target.id.startsWith('est-')) return;
  const k = claveEdicion(e.target.id.slice(4));
  editadosTablero.set(k, e.target.value);
  // Misma variedad bajo otro granel desplegado: se ve el mismo valor sin esperar un re-render.
  document.querySelectorAll('#tab-tablero input[id^="est-"]').forEach(inp => {
    if (inp !== e.target && claveEdicion(inp.id.slice(4)) === k) inp.value = e.target.value;
  });
});
document.getElementById('filtroTablero').addEventListener('input', renderTablero);
document.getElementById('btnRecargarTablero').addEventListener('click', cargarTablero);
document.getElementById('btnTableroTodo').addEventListener('click', tableroAgregarTodo);
cargarDiasTablero();
