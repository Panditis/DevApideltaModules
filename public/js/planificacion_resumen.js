'use strict';

// ══════════════════ TAB 1: RESUMEN ══════════════════════════════

let gruposCache = [];
let gruposSorted = [];
// Orden fijo: prioridad (rankingPos, ver lib/plan_prioridad.js); sin dato al final.
function ordenarPorPrioridad(lista) {
  return [...lista].sort((a, b) => (a.rankingPos || Infinity) - (b.rankingPos || Infinity));
}

async function cargarSugerencias() {
  const q = document.getElementById('filtroQ').value.trim();
  let url = '/api/plan/sugerencias-grupos';
  if (q) url += `?q=${encodeURIComponent(q)}`;
  document.getElementById('tablaSugerencias').innerHTML = '<div class="loading">Calculando sugerencias…</div>';
  try {
    gruposCache = await api('GET', url);
    renderGrupos();
  } catch (e) {
    document.getElementById('tablaSugerencias').innerHTML =
      `<div class="loading" style="color:red">Error: ${escHtml(e.message)}</div>`;
    toast('Error al cargar sugerencias', true);
  }
}

function renderGrupos() {
  const grupos  = gruposCache;
  const conSugerido = grupos.filter(g => g.totalSugerido > 0).length;
  document.getElementById('countSugerencias').textContent = conSugerido + ' grupos para producir';

  if (!grupos.length) {
    document.getElementById('tablaSugerencias').innerHTML = '<div class="loading">Sin grupos que requieran producción.</div>';
    return;
  }

  const redondear = n => Math.round(n * 100) / 100;
  // Celda "Stock suc.": suma + 🔍 (abre el modal por sucursal) solo si hay stock que mostrar.
  const stockSucCell = (suma, gi) => suma > 0
    ? `${suma} <button class="btn-add btn-sm" title="Ver stock por sucursal" onclick="event.stopPropagation();abrirStockDetalle(${gi})">🔍</button>`
    : '—';

  gruposSorted = ordenarPorPrioridad(grupos);
  const rows = gruposSorted.map((g, gi) => {
    // ── MODO GRANEL: fila única, cantidad manual ─────────────────────────────
    if (g.esGranel) {
      return `<tr class="grupo-row granel-row">
        <td class="text-right text-sm" style="color:var(--muted)">${g.rankingPos || ''}</td>
        <td class="nombre-col font-bold">
          ${escHtml(g.productoRef)}
          <span style="display:inline-block;font-size:10px;font-weight:700;font-family:system-ui,sans-serif;padding:1px 7px;border-radius:var(--radius-full);background:#d1fae5;color:#065f46;margin-left:8px;vertical-align:middle">GRANEL</span>
        </td>
        <td class="text-right font-bold col-sug" style="color:var(--verde)">${g.totalSugerido||'—'}</td>
        <td class="text-right text-sm">${g.granelStockGrupo != null ? g.granelStockGrupo : '—'}</td>
        <td class="text-right text-sm" style="color:var(--muted);white-space:nowrap">${stockSucCell(g.stockSucGrupo, gi)}</td>
        <td style="white-space:nowrap"><button class="btn-add" onclick="abrirModalGranel(${gi})">+ Agregar</button></td>
      </tr>`;
    }

    // ── MODO FRACCIONADO: expandible por presentación ────────────────────────
    const _stockGrupo = redondear((g.presentaciones||[]).reduce((s,p)=>s+(p.stockActual||0),0));
    const _stockSucGrupo = redondear((g.presentaciones||[]).reduce((s,p)=>s+(p.stockSucursales||0),0));
    const grupoRow = `<tr class="grupo-row" data-gi="${gi}" style="cursor:pointer" onclick="toggleGrupo(${gi})">
      <td class="text-right text-sm" style="color:var(--muted)">${g.rankingPos || ''}</td>
      <td class="nombre-col font-bold"><span class="expand-btn" id="ebtn-${gi}">▶</span> ${escHtml(g.productoRef)}</td>
      <td class="text-right font-bold col-sug" style="color:var(--verde)">${g.totalSugerido||'—'}</td>
      <td class="text-right text-sm" title="Cuenta al 60% en el sugerido: ${redondear(_stockGrupo*0.6)}">${_stockGrupo>0?_stockGrupo:'—'}</td>
      <td class="text-right text-sm" style="color:var(--muted);white-space:nowrap">${stockSucCell(_stockSucGrupo, gi)}</td>
      <td onclick="event.stopPropagation()" style="white-space:nowrap">
        <button class="btn-add" onclick="agregarGrupoAlPlan(${gi})">+ Todo</button>
      </td>
    </tr>`;

    const headerRow = `<tr class="sub-${gi} sub-header" style="display:none;background:#dde8d8">
      <td></td>
      <td style="padding-left:28px;font-size:11px;font-weight:700;color:var(--muted);letter-spacing:0.4px">PRESENTACIÓN</td>
      <td class="text-right" style="font-size:11px;font-weight:700;color:var(--muted)">SUGERIDO</td>
      <td class="text-right" style="font-size:11px;font-weight:700;color:var(--muted)">STOCK CENTRAL</td>
      <td class="text-right" style="font-size:11px;font-weight:700;color:var(--muted)">STOCK SUC.</td>
      <td></td>
    </tr>`;

    const subRows = g.presentaciones.map((p, pi) => {
      const _pProm = p.promMes ?? Math.round((p.promDiario||0)*30*10)/10;
      const _dias = p.diasStock>=9999?'∞':(p.diasStock+'d');
      return `<tr class="sub-${gi}" style="display:none;background:#f7faf6">
        <td></td>
        <td class="nombre-col" style="padding-left:28px;font-size:13px">
          ${escHtml(p.presentacion)}
          <div style="font-size:11px;color:var(--muted);font-weight:400;margin-top:2px">cob: ${_dias}${_pProm?` · prom: ${_pProm}/mes`:''}</div>
        </td>
        <td class="text-right col-sug" style="white-space:nowrap"><input class="sug-input" id="sug-${gi}-${pi}" type="number" min="0" step="1" value="${p.cantSugerida||0}" title="Sugerido por el sistema: ${p.cantSugerida}"><button class="btn-formula" onclick="event.stopPropagation();abrirFormulaView('${p.plu}','${escHtml(p.baseNombre).replace(/'/g,"\\'")}',parseFloat(document.getElementById('sug-${gi}-${pi}').value)||0)" title="Ver fórmula">📋</button></td>
        <td class="text-right" title="Cuenta al 60% en el sugerido: ${p.stockEfectivo ?? Math.round((p.stockActual||0)*0.6*100)/100}">${p.stockActual||0}</td>
        <td class="text-right" style="color:var(--muted)">${p.stockSucursales||0}</td>
        <td onclick="event.stopPropagation()">
          <button class="btn-add btn-sm" onclick="agregarPresAlPlan(${gi},${pi})">+</button>
        </td>
      </tr>`;
    }).join('');

    return grupoRow + headerRow + subRows;
  }).join('');

  document.getElementById('tablaSugerencias').innerHTML = `
    <div style="overflow-x:auto"><table>
      <thead><tr>
        <th class="text-right" style="width:40px" title="Prioridad por facturación">#</th>
        <th>Producto</th>
        <th class="text-right col-sug">Sugerido</th>
        <th class="text-right" title="Stock de presentaciones en Casa Central (en planificación cuenta al 60%)" style="font-size:11px">STOCK CENTRAL</th>
        <th class="text-right" title="Stock en sucursales (todas menos Casa Central)" style="font-size:11px">STOCK SUC.</th>
        <th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function toggleGrupo(gi) {
  const subs = document.querySelectorAll(`.sub-${gi}`);
  const btn  = document.getElementById(`ebtn-${gi}`);
  const open = subs[0]?.style.display !== 'none';
  subs.forEach(r => r.style.display = open ? 'none' : 'table-row');
  if (btn) btn.textContent = open ? '▶' : '▼';
}

// ── STOCK POR SUCURSAL (modal 🔍) ─────────────────────────────────────────
async function abrirStockDetalle(gi) {
  const g = gruposSorted[gi];
  if (!g) return;
  const plus = (g.esGranel ? (g.plus || []) : (g.presentaciones || []).map(p => p.plu)).map(String);
  document.getElementById('stockDetTitulo').textContent = g.productoRef;
  document.getElementById('stockDetBody').innerHTML = '<div class="loading">Cargando…</div>';
  document.getElementById('overlayStockDet').classList.add('open');
  try {
    const data = await api('GET', `/api/plan/stock-detalle?plus=${encodeURIComponent(plus.join(','))}`);
    document.getElementById('stockDetBody').innerHTML = renderStockDetalle(data, g);
  } catch (e) {
    document.getElementById('stockDetBody').innerHTML = `<div style="color:var(--rojo);padding:10px">Error: ${escHtml(e.message)}</div>`;
  }
}

// Nombre corto de la columna: la presentación del catálogo; si no está, el nombre del producto sin el del grupo.
function nombreCortoPres(r, g) {
  const pres = (g.presentaciones || []).find(p => String(p.plu) === String(r.plu));
  if (pres && pres.presentacion) return pres.presentacion;
  const nom = String(r.nombre || r.plu), ref = String(g.productoRef || '');
  return nom.toLowerCase().startsWith(ref.toLowerCase()) ? (nom.slice(ref.length).trim() || nom) : nom;
}

// Filas = sucursales (sin Casa Central) con stock en alguna presentación; columnas = presentaciones + Total.
function renderStockDetalle(data, g) {
  const pres = data.presentaciones || [];
  const sucs = (data.sucursales || []).filter(s => !s.central && pres.some(r => r.porSuc[s.id] > 0));
  if (!sucs.length) return '<div style="padding:10px;color:var(--muted)">Sin stock en sucursales.</div>';
  const fmt = n => Math.round(n * 100) / 100;
  const num = 'text-align:right;white-space:nowrap;padding:5px 10px';
  const cell = v => v ? `<td style="${num}">${fmt(v)}</td>` : `<td style="${num};color:var(--border)">·</td>`;
  const th = 'font-size:11px;color:var(--muted);padding:4px 10px';
  const head = pres.map(r => `<th style="${th};text-align:right">${escHtml(nombreCortoPres(r, g))}</th>`).join('');
  const body = sucs.map(s => {
    const total = pres.reduce((t, r) => t + (r.porSuc[s.id] || 0), 0);
    return `<tr style="border-bottom:1px solid var(--md-outline-variant)"><td style="font-size:13px;padding:5px 10px;white-space:nowrap">${escHtml(s.nombre)}</td>${pres.map(r => cell(r.porSuc[s.id])).join('')}<td class="font-bold" style="${num}">${fmt(total)}</td></tr>`;
  }).join('');
  const totalesPres = pres.map(r => sucs.reduce((t, s) => t + (r.porSuc[s.id] || 0), 0));
  const pie = `<tr style="border-top:2px solid var(--md-outline-variant)"><td class="font-bold" style="font-size:13px;padding:5px 10px">Total</td>${totalesPres.map(t => `<td class="font-bold" style="${num}">${fmt(t)}</td>`).join('')}<td class="font-bold" style="${num}">${fmt(totalesPres.reduce((a, b) => a + b, 0))}</td></tr>`;
  return `<table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr style="border-bottom:2px solid var(--md-outline-variant)"><th style="${th};text-align:left">SUCURSAL</th>${head}<th style="${th};text-align:right">TOTAL</th></tr></thead>
    <tbody>${body}${pie}</tbody></table>`;
}

function presToItem(p, productoRef) {
  return { idProducto: p.plu, producto: p.baseNombre, presentacion: p.presentacion, rubro: productoRef,
    stockActual: p.stockActual, promDiario: p.promDiario, diasStock: p.diasStock,
    semaforo: p.semaforo, pendientes: p.pendientes, cantSugerida: p.cantSugerida,
    cantConfirmada: p.cantSugerida, idGranel: p.idGranel, nombreGranel: p.nombreGranel,
    cantPorUnidad: p.cantPorUnidad, granelNecesario: p.granelNecesario,
    granelDisponible: p.granelDisponible, granelOk: p.granelOk };
}

// Lee la cantidad editada en el Resumen (cae al sugerido si no hay input)
function leerCantSug(gi, pi, fallback) {
  const inp = document.getElementById(`sug-${gi}-${pi}`);
  if (!inp) return fallback;
  return Math.max(0, parseFloat(inp.value) || 0);
}

function agregarPresAlPlan(gi, pi) {
  const g = gruposSorted[gi], p = g.presentaciones[pi];
  const cant = leerCantSug(gi, pi, p.cantSugerida);
  if (cant <= 0) { toast('Ingresá una cantidad mayor a 0', true); return; }
  agregarGrupoItems(g.productoRef, [{ ...presToItem(p, g.productoRef), cantConfirmada: cant }]);
}

function agregarGrupoAlPlan(gi) {
  const g = gruposSorted[gi];
  const items = g.presentaciones
    .map((p, pi) => ({ ...presToItem(p, g.productoRef), cantConfirmada: leerCantSug(gi, pi, p.cantSugerida) }))
    .filter(it => it.cantConfirmada > 0);
  if (!items.length) { toast('No hay cantidades para agregar (escribí una cantidad > 0)', true); return; }
  agregarGrupoItems(g.productoRef, items);
}

// Granel previo: sus órdenes de granel entran al carrito junto con las presentaciones, que quedan
// marcadas (granelAparte): su granel se fabrica en la orden aparte, así que en Producción no vuelven
// a pedir el alta del granel (solo consumen).
async function agregarGrupoItems(productoRef, items) {
  const graneles = await itemGranelPrevio(productoRef, items);
  if (graneles === false) return;
  agregarAlCarrito([...graneles, ...items.map(it => (graneles.length ? { ...it, granelAparte: true } : it))]);
}

// ¿La referencia es una variedad de miel del catálogo? Usa el flag esMiel (default: nombre arranca con "Miel").
function esVariedadMiel(ref) {
  return cfgGetEsMiel(ref);
}

// ¿El ítem es una variedad de miel? (decide si pedir el número de tambor) — solo las del catálogo
function esItemMiel(it) {
  return esVariedadMiel(it.rubro) || esVariedadMiel(it.producto);
}

// Grupos marcados "granel previo": las presentaciones se hacen a partir de un granel
// (pepas → masa) que hay que fabricar primero.
const _nombrePluCache = {};
async function nombreDePlu(plu) {
  if (plu in _nombrePluCache) return _nombrePluCache[plu];
  let nom = '';
  try {
    const rows = await api('GET', '/api/siga/buscar?q=' + encodeURIComponent(plu));
    nom = (rows.find(r => String(r.plu) === String(plu)) || {}).producto || '';
  } catch { /* sin nombre: se muestra el PLU */ }
  _nombrePluCache[plu] = nom;
  return nom;
}

// El ref del grupo no siempre llega igual: desde el catálogo es la clave exacta, pero desde
// "Agregar producto" lo único que hay es el rubro de SiGA ("FRUTOS SECOS") o el nombre del
// artículo con su presentación, y ninguno matchea la clave del catálogo ("Apimani Clasico").
// Sin resolverlo, esas altas nunca disparaban el granel previo y la orden quedaba sin reservar.
function resolverRefGrupo(ref, items) {
  const claves = Object.keys(gruposCfgLocal);
  const base   = nombre => normalizarNombreJS(String(nombre || '')).replace(PRES_RE_JS, '').trim();
  const buscar = txt => {
    const t = String(txt || '').trim().toLowerCase();
    return t ? claves.find(k => String(k).trim().toLowerCase() === t) : undefined;
  };
  const candidatos = [ref, base(ref), ...(items || []).flatMap(it => [it.rubro, base(it.producto)])];
  for (const c of candidatos) { const k = buscar(c); if (k) return k; }
  return ref;
}

// Devuelve los ítems de las órdenes de granel (uno por granel del catálogo), [] si el grupo no
// los requiere, o false si el grupo está marcado pero no tiene graneles cargados (ya se avisó).
// No pide confirmación: los graneles entran al carrito como líneas editables.
async function itemGranelPrevio(productoRef, items) {
  await cargarGruposCfgSiVacio();
  productoRef = resolverRefGrupo(productoRef, items);
  if (!cfgGetReqGranel(productoRef)) return [];
  if (items.some(it => it.esGranel)) return []; // ya es la orden de granel
  // Los graneles a fabricar son los asignados al grupo en el catálogo (Ver/Editar → Graneles).
  // Solo si el grupo no tiene ninguno se cae al de la fórmula del ítem.
  const plusCat = cfgGetGranelPlus(productoRef);
  const conG    = items.find(it => it.idGranel) || {};
  const plus    = plusCat.length ? plusCat : (conG.idGranel ? [String(conG.idGranel)] : []);
  if (!plus.length) {
    toast(`"${productoRef}" está marcado como "granel previo" pero no tiene graneles cargados en el catálogo`, true);
    return false;
  }
  // Cantidad por granel: sale de la fórmula de las presentaciones (componente × cantidad), que
  // es lo único que sabe repartir cuando el producto lleva varios graneles (yogur batido =
  // yogur base + mermelada). El granelNecesario del ítem solo cubre UN granel por presentación.
  const mpLista = await calcularMPParaItems(items);
  const mpPorPlu = new Map(mpLista.map(r => [String(r.plu), r]));
  const necDe = plu => {
    const mp = mpPorPlu.get(String(plu));
    if (mp) return Math.round(mp.total * 100) / 100;
    // Sin fórmula para ese PLU: se cae al granel que traen los ítems (o al total si hay uno solo).
    const propio = items.filter(it => String(it.idGranel || '') === String(plu));
    const base = propio.length ? propio : (plus.length === 1 ? items : []);
    return Math.round(base.reduce((s, it) => s + (it.granelNecesario || 0), 0) * 100) / 100;
  };
  const graneles = [];
  for (const plu of plus) {
    const nombre = (mpPorPlu.get(String(plu))?.nombre || '').replace(/ DEPOSITO GRANEL.*/i, '').trim()
      || (await nombreDePlu(plu))
      || (String(conG.idGranel || '') === String(plu)
        ? (conG.nombreGranel || '').replace(/ DEPOSITO GRANEL.*/i, '').trim() : '')
      || `Granel PLU ${plu}`;
    graneles.push({ plu, nombre, cant: necDe(plu) });
  }
  return graneles.map(g => ({
    idProducto: g.plu, producto: g.nombre, rubro: 'Granel', esGranel: true,
    cantSugerida: 0, cantConfirmada: g.cant, unidadGranel: 'kg',
    semaforo: 'RED', pendientes: 0, promMes: 0,
    idGranel: g.plu, nombreGranel: g.nombre, cantPorUnidad: 0,
    granelNecesario: 0, granelDisponible: null, granelOk: true,
    granelPrevioDe: productoRef
  }));
}

document.getElementById('filtroQ').addEventListener('input', () => {
  clearTimeout(buscarDebounce); buscarDebounce = setTimeout(cargarSugerencias, 400);
});
document.getElementById('btnRecargar').addEventListener('click', cargarSugerencias);

