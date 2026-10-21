'use strict';

// ══════════════════ TAB 1: RESUMEN ══════════════════════════════

let gruposCache = [];
let gruposSorted = [];
let sortCol = 'urgencia', sortDir = -1; // -1=desc
function sortGrupos(lista) {
  const SEMORD = { URGENT:4, RED:3, YELLOW:2, GREEN:1 };
  return [...lista].sort((a,b) => {
    let va, vb;
    if (sortCol==='semaforo') { va=SEMORD[a.semaforo]||0; vb=SEMORD[b.semaforo]||0; }
    else if (sortCol==='nombre') { va=a.productoRef.toLowerCase(); vb=b.productoRef.toLowerCase(); return va<vb?-sortDir:va>vb?sortDir:0; }
    else if (sortCol==='sugerido') { va=a.totalSugerido||0; vb=b.totalSugerido||0; }
    else if (sortCol==='stock') { va=a.granelStockGrupo||0; vb=b.granelStockGrupo||0; }
    else if (sortCol==='prom') { va=a.totalPromMes||(a.presentaciones||[]).reduce((s,p)=>s+(p.promDiario||0),0)*30||0; vb=b.totalPromMes||(b.presentaciones||[]).reduce((s,p)=>s+(p.promDiario||0),0)*30||0; }
    else if (sortCol==='dias') {
      va = a.esGranel ? 9999 : Math.min(...((a.presentaciones||[]).length ? (a.presentaciones||[]).map(p=>p.diasStock||9999) : [9999]));
      vb = b.esGranel ? 9999 : Math.min(...((b.presentaciones||[]).length ? (b.presentaciones||[]).map(p=>p.diasStock||9999) : [9999]));
    } else if (sortCol==='ranking') { va=a.rankingScore||0; vb=b.rankingScore||0; }
    else { va=a.urgencia||0; vb=b.urgencia||0; }
    return (vb-va)*sortDir;
  });
}
function setSort(col) {
  if (sortCol===col) sortDir*=-1; else { sortCol=col; sortDir=(col==='nombre'?1:-1); }
  renderGrupos();
}
function sortArrow(col) { return sortCol===col?(sortDir<0?' ▼':' ▲'):' ⇅'; }
function rankBadge(pos, fact) {
  if (!pos) return '';
  const medals = {1:'🥇',2:'🥈',3:'🥉'};
  const factK = fact ? ` $${Math.round(fact/1000)}k` : '';
  if (medals[pos]) return `<span title="Ranking #${pos} por facturación+cantidad${factK}" style="margin-right:4px;font-size:14px">${medals[pos]}</span>`;
  if (pos <= 10) return `<span title="Ranking #${pos} por facturación+cantidad${factK}" style="margin-right:4px;font-size:11px;font-weight:700;color:var(--muted);background:#f1f5f9;border-radius:4px;padding:1px 5px">#${pos}</span>`;
  return `<span title="Ranking #${pos}${factK}" style="margin-right:4px;font-size:10px;color:var(--muted)">#${pos}</span>`;
}

async function cargarSugerencias() {
  const q       = document.getElementById('filtroQ').value.trim();
  const soloRed = document.getElementById('filtroSoloRojos').checked ? '1' : '0';
  let url       = `/api/plan/sugerencias-grupos?soloRojos=${soloRed}`;
  if (q) url   += `&q=${encodeURIComponent(q)}`;
  document.getElementById('tablaSugerencias').innerHTML = '<div class="loading">Calculando sugerencias…</div>';
  try {
    gruposCache = await api('GET', url);
    renderGrupos();
  } catch (e) {
    document.getElementById('tablaSugerencias').innerHTML =
      `<div class="loading" style="color:red">Error: ${escHtml(e.message)}</div>`;
    toast('Error al cargar sugerencias', true);
  }
  try { cargarEnvases(); } catch {}
}

function renderGrupos() {
  const grupos  = gruposCache;
  const allPres = grupos.flatMap(g => g.presentaciones);
  document.getElementById('mRed').textContent    = grupos.filter(g => g.semaforo === 'RED').length;
  document.getElementById('mAmb').textContent    = grupos.filter(g => g.semaforo === 'YELLOW').length;
  document.getElementById('mGranel').textContent = allPres.filter(p => !p.granelOk).length;
  document.getElementById('mPend').textContent   = Math.round(allPres.reduce((s,p)=>s+(p.pendientes||0),0));
  const conSugerido = grupos.filter(g => g.totalSugerido > 0).length;
  document.getElementById('countSugerencias').textContent = conSugerido + ' grupos para producir';

  if (!grupos.length) {
    document.getElementById('tablaSugerencias').innerHTML = '<div class="loading">Sin grupos que requieran producción.</div>';
    return;
  }

  // STOCK GRANEL: uno o más códigos (ej. Yogurt Batido tiene 2 graneles previos) — se muestran todos,
  // cada uno con su propio stock, en vez de sumarlos (son materias primas distintas).
  function granelStockCell(g) {
    const lista = (g.graneles && g.graneles.length) ? g.graneles
      : (g.granelStockGrupo !== null ? [{ id: g.granelId, nombre: g.nombreGranelGrupo, stock: g.granelStockGrupo }] : []);
    if (!lista.length) return '—';
    return lista.map(gr => `<span class="${gr.stock > 0 ? 'granel-ok' : 'granel-warn'}" title="${escHtml(gr.nombre)}">${gr.stock}</span>`).join('<br>');
  }

  const grupos_sorted = sortGrupos(grupos);
  gruposSorted = grupos_sorted;
  const rows = grupos_sorted.map((g, gi) => {
    // ── MODO GRANEL: fila única, cantidad manual ─────────────────────────────
    if (g.esGranel) {
      return `<tr class="grupo-row granel-row">
        <td style="width:28px;text-align:center"><span style="color:var(--muted);font-size:12px">⚙</span></td>
        <td><span class="badge ${g.semaforo}">${semLabel(g.semaforo)}</span></td>
        <td class="nombre-col font-bold">
          ${rankBadge(g.rankingPos, g.facturacionMensual)}${escHtml(g.productoRef)}
          <span style="display:inline-block;font-size:10px;font-weight:700;font-family:system-ui,sans-serif;padding:1px 7px;border-radius:var(--radius-full);background:#d1fae5;color:#065f46;margin-left:8px;vertical-align:middle">GRANEL</span>
        </td>
        <td class="text-right font-bold col-sug" style="color:var(--verde)">${g.totalSugerido||'—'}</td>
        <td class="text-right text-sm" style="color:var(--muted)">—</td>
        <td class="text-right text-sm" style="color:var(--muted)">${g.stockSucGrupo>0?g.stockSucGrupo:'—'}</td>
        <td class="text-right">${granelStockCell(g)}</td>
        <td style="white-space:nowrap"><button class="btn-add btn-sm" title="Ver detalle de stock" onclick="event.stopPropagation();abrirStockDetalle(${gi})">📊</button> <button class="btn-add" onclick="abrirModalGranel(${gi})">+ Agregar</button></td>
      </tr>`;
    }

    // ── MODO FRACCIONADO: expandible por presentación ────────────────────────
    const granelWarn = g.presentaciones.some(p => !p.granelOk);
    const resumen    = g.presentaciones.filter(p => p.cantSugerida > 0)
      .map(p => `<span class="pres-chip ${p.semaforo}">${escHtml(p.presentacion)}: <strong>${p.cantSugerida}</strong></span>`).join(' ');

    const _pend = (g.presentaciones||[]).reduce((s,p)=>s+(p.pendientes||0),0);
    const _stockGrupo = Math.round((g.presentaciones||[]).reduce((s,p)=>s+(p.stockActual||0),0)*100)/100;
    const _stockSucGrupo = Math.round((g.presentaciones||[]).reduce((s,p)=>s+(p.stockSucursales||0),0)*100)/100;
    const grupoRow = `<tr class="grupo-row" data-gi="${gi}" style="cursor:pointer" onclick="toggleGrupo(${gi})">
      <td style="width:28px;text-align:center"><span class="expand-btn" id="ebtn-${gi}">▶</span></td>
      <td><span class="badge ${g.semaforo}">${semLabel(g.semaforo)}</span></td>
      <td class="nombre-col font-bold">${rankBadge(g.rankingPos, g.facturacionMensual)}${escHtml(g.productoRef)}</td>
      <td class="text-right font-bold col-sug" style="color:var(--verde)">${g.totalSugerido||'—'}</td>
      <td class="text-right text-sm" title="Cuenta al 60% en el sugerido: ${Math.round(_stockGrupo*0.6*100)/100}">${_stockGrupo>0?_stockGrupo:'—'}</td>
      <td class="text-right text-sm" style="color:var(--muted)">${_stockSucGrupo>0?_stockSucGrupo:'—'}</td>
      <td class="text-right">${granelStockCell(g)}</td>
      <td onclick="event.stopPropagation()" style="white-space:nowrap">
        <button class="btn-add btn-sm" title="Ver detalle de stock" onclick="abrirStockDetalle(${gi})">📊</button>
        <button class="btn-add" onclick="agregarGrupoAlPlan(${gi})">+ Todo</button>
      </td>
    </tr>`;

    const headerRow = `<tr class="sub-${gi} sub-header" style="display:none;background:#dde8d8">
      <td></td><td></td>
      <td style="padding-left:28px;font-size:11px;font-weight:700;color:var(--muted);letter-spacing:0.4px">PRESENTACIÓN</td>
      <td class="text-right" style="font-size:11px;font-weight:700;color:var(--muted)">SUGERIDO</td>
      <td class="text-right" style="font-size:11px;font-weight:700;color:var(--muted)">STOCK</td>
      <td class="text-right" style="font-size:11px;font-weight:700;color:var(--muted)">STOCK SUC</td>
      <td class="text-right" style="font-size:11px;font-weight:700;color:var(--muted)">GRANEL</td>
      <td></td>
    </tr>`;

    const subRows = g.presentaciones.map((p, pi) => {
      const granelH = p.nombreGranel?`<span class="${p.granelOk?'granel-ok':'granel-warn'}" title="${escHtml(p.nombreGranel.replace(/ DEPOSITO GRANEL.*/i,'').trim())}">${p.granelOk?'✓':'⚠'}</span>`:'';
      const _pProm = p.promMes ?? Math.round((p.promDiario||0)*30*10)/10;
      const _dias = p.diasStock>=9999?'∞':(p.diasStock+'d');
      return `<tr class="sub-${gi}" style="display:none;background:#f7faf6">
        <td></td>
        <td><span class="badge ${p.semaforo}" style="font-size:10px">${semLabel(p.semaforo)}</span></td>
        <td class="nombre-col" style="padding-left:28px;font-size:13px">
          ${escHtml(p.presentacion)}
          <div style="font-size:11px;color:var(--muted);font-weight:400;margin-top:2px">cob: ${_dias}${_pProm?` · prom: ${_pProm}/mes`:''}</div>
        </td>
        <td class="text-right col-sug" style="white-space:nowrap"><input class="sug-input" id="sug-${gi}-${pi}" type="number" min="0" step="1" value="${p.cantSugerida||0}" title="Sugerido por el sistema: ${p.cantSugerida}"><button class="btn-formula" onclick="event.stopPropagation();abrirFormulaView('${p.plu}','${escHtml(p.baseNombre).replace(/'/g,"\\'")}',parseFloat(document.getElementById('sug-${gi}-${pi}').value)||0)" title="Ver fórmula">📋</button></td>
        <td class="text-right" title="Cuenta al 60% en el sugerido: ${p.stockEfectivo ?? Math.round((p.stockActual||0)*0.6*100)/100}">${p.stockActual||0}</td>
        <td class="text-right" style="color:var(--muted)">${p.stockSucursales||0}</td>
        <td class="text-center">${granelH}</td>
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
        <th style="width:28px"></th>
        <th class="sort-th" onclick="setSort('semaforo')" title="Ordenar por estado">Estado${sortArrow('semaforo')}</th>
        <th class="sort-th" onclick="setSort('nombre')" title="Ordenar por nombre">Producto${sortArrow('nombre')}</th>
        <th class="sort-th text-right col-sug" onclick="setSort('sugerido')" title="Ordenar por sugerido">Sugerido${sortArrow('sugerido')}</th>
        <th class="text-right" title="Stock de presentaciones en Casa Central (en planificación cuenta al 60%)" style="font-size:11px">STOCK</th>
        <th class="text-right" title="Stock en sucursales (todas menos Casa Central)" style="font-size:11px">STOCK SUC</th>
        <th class="sort-th text-right" onclick="setSort('stock')" title="Ordenar por stock granel" style="font-size:11px">STOCK GRANEL${sortArrow('stock')}</th>
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

// ── DETALLE DE STOCK (granel + por sucursal por presentación) ──────────────
async function abrirStockDetalle(gi) {
  const g = gruposSorted[gi];
  if (!g) return;
  let plus = [], graneles = [];
  if (g.esGranel) {
    plus = (g.plus || []).map(String);
    graneles = (g.graneles && g.graneles.length) ? g.graneles.map(gr => String(gr.id)) : (g.granelId ? [String(g.granelId)] : []);
  } else {
    plus = (g.presentaciones || []).map(p => String(p.plu));
    // g.graneles sale siempre de grupos_config (catálogo), nunca de la fórmula (BOM) — así que esto
    // ya respeta "solo si está cargado como granel": vacío para productos sin granel (ej. Miel Canela).
    graneles = (g.graneles || []).map(gr => String(gr.id));
  }
  document.getElementById('stockDetTitulo').textContent = g.productoRef;
  document.getElementById('stockDetBody').innerHTML = '<div class="loading">Cargando…</div>';
  document.getElementById('overlayStockDet').classList.add('open');
  try {
    const qs = `plus=${encodeURIComponent(plus.join(','))}&graneles=${encodeURIComponent(graneles.join(','))}`;
    const data = await api('GET', `/api/plan/stock-detalle?${qs}`);
    document.getElementById('stockDetBody').innerHTML = renderStockDetalle(data);
  } catch (e) {
    document.getElementById('stockDetBody').innerHTML = `<div style="color:var(--rojo);padding:10px">Error: ${escHtml(e.message)}</div>`;
  }
}

function renderStockDetalle(data) {
  const sucs = data.sucursales || [];
  const fmt = n => (n || n === 0) ? Math.round(n * 100) / 100 : '';
  const cell = v => v ? `<td class="text-right">${fmt(v)}</td>` : `<td class="text-right" style="color:var(--border)">·</td>`;
  const matrix = (titulo, rows, sucsCols) => {
    if (!rows || !rows.length) return '';
    const cols = sucsCols || sucs;
    const head = cols.map(s => `<th class="text-right" style="font-size:11px;padding:4px 8px;${s.central ? 'color:var(--md-primary);font-weight:700' : 'color:var(--muted)'}">${escHtml(s.nombre)}</th>`).join('');
    const body = rows.map(r => {
      const tds = cols.map(s => cell(r.porSuc[s.id])).join('');
      return `<tr style="border-bottom:1px solid var(--md-outline-variant)"><td style="font-size:13px;padding:5px 8px">${escHtml(r.nombre)}</td>${tds}<td class="text-right font-bold" style="padding:5px 8px">${fmt(r.total)}</td></tr>`;
    }).join('');
    return `<div style="margin-bottom:18px">
      <div style="font-weight:700;font-family:system-ui,sans-serif;font-size:14px;margin-bottom:6px;color:var(--md-primary)">${titulo}</div>
      <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="border-bottom:2px solid var(--md-outline-variant)"><th style="text-align:left;font-size:11px;color:var(--muted);padding:4px 8px">PRODUCTO</th>${head}<th class="text-right" style="font-size:11px;padding:4px 8px">TOTAL</th></tr></thead>
        <tbody>${body}</tbody>
      </table></div></div>`;
  };
  const granelM = matrix('🌾 Granel (depósitos granel)', data.graneles, sucs.filter(s => s.central));
  const presM   = matrix('📦 Presentaciones (stock de venta)', data.presentaciones);
  if (!granelM && !presM) return '<div style="padding:10px;color:var(--muted)">Sin datos de stock.</div>';
  return granelM + presM;
}

function renderPanelGranel(granel) {
  const necMap = {};
  for (const g of gruposCache)
    for (const p of g.presentaciones)
      if (p.idGranel && p.cantSugerida > 0)
        necMap[p.idGranel] = (necMap[p.idGranel]||0) + (p.granelNecesario||0);

  const html = granel.map(g => {
    const nec  = necMap[String(g.IdProducto)] || 0;
    const warn = nec > 0 && g.StockGranel < nec;
    const nom  = g.NombreProducto.replace(/ DEPOSITO GRANEL.*/i,'').trim();
    return `<div class="granel-row${warn?' warn':''}">
      <div class="g-nombre">${warn?'⚠ ':''}${escHtml(nom)}</div>
      <div class="g-stock">Stock: <strong>${g.StockGranel}</strong>${nec>0?` | Nec: <strong>${nec.toFixed(1)}</strong>`:''}</div>
    </div>`;
  }).join('');
  document.getElementById('panelGranel').innerHTML = html || '<div class="loading">Sin datos.</div>';
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
document.getElementById('filtroSoloRojos').addEventListener('change', cargarSugerencias);
document.getElementById('btnRecargar').addEventListener('click', cargarSugerencias);

