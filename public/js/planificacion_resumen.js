'use strict';

// ══════════════════ TAB 1: RESUMEN ══════════════════════════════

let gruposCache = [];
let gruposSorted = [];
// El orden (urgencia y, dentro de cada nivel, rankingPos) lo da el servidor: gruposSorted lo conserva
// porque los botones identifican el grupo por su posición (gi).
const URGENCIA_CHIP = { URGENTE: ['RED', '🔴 Urgente'], PRONTO: ['YELLOW', '🟡 Pronto'], OK: ['GREEN', '🟢 OK'] };
const textoCobertura = c => (Number.isFinite(c) ? `${c} d` : '—');
// Fila de un grupo con presentaciones: el % de su facturación que está en falta (el que decidió el nivel);
// OK no muestra nada. Grupo granel: su cobertura en días.
function textoUrgenciaGrupo(g) {
  if (!Number.isFinite(g.pesoUrgente)) return textoCobertura(g.coberturaDias);
  const peso = g.urgencia === 'URGENTE' ? g.pesoUrgente : g.urgencia === 'PRONTO' ? g.pesoUrgentePronto : null;
  return peso === null ? '—' : `${Math.round(peso * 100)}% en falta`;
}
// gi/pi (índices; pi -1 = fila del grupo): el chip abre el modal con el cálculo (abrirUrgenciaDetalle).
function urgenciaCell(urgencia, texto, gi, pi) {
  const [clase, txt] = URGENCIA_CHIP[urgencia] || URGENCIA_CHIP.OK;
  return `<span class="urg-click" title="Ver cómo se calcula la urgencia" onclick="event.stopPropagation();abrirUrgenciaDetalle(${gi},${pi})"><span class="badge ${clase}">${txt}</span> <span class="text-sm" style="white-space:nowrap">${texto}</span></span>`;
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

  gruposSorted = grupos;
  const rows = gruposSorted.map((g, gi) => {
    // ── MODO GRANEL: fila única, cantidad manual ─────────────────────────────
    if (g.esGranel) {
      return `<tr class="grupo-row granel-row">
        <td class="text-right text-sm" style="color:var(--muted)">${g.rankingPos || ''}</td>
        <td style="white-space:nowrap">${urgenciaCell(g.urgencia, textoUrgenciaGrupo(g), gi, -1)}</td>
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
      <td style="white-space:nowrap">${urgenciaCell(g.urgencia, textoUrgenciaGrupo(g), gi, -1)}</td>
      <td class="nombre-col font-bold"><span class="expand-btn" id="ebtn-${gi}">▶</span> ${escHtml(g.productoRef)}</td>
      <td class="text-right font-bold col-sug" style="color:var(--verde)">${g.totalSugerido||'—'}</td>
      <td class="text-right text-sm" title="Cuenta al 60% en el sugerido: ${redondear(_stockGrupo*0.6)}">${_stockGrupo>0?_stockGrupo:'—'}</td>
      <td class="text-right text-sm" style="color:var(--muted);white-space:nowrap">${stockSucCell(_stockSucGrupo, gi)}</td>
      <td onclick="event.stopPropagation()" style="white-space:nowrap">
        <button class="btn-add" onclick="agregarGrupoAlPlan(${gi})">+ Todo</button>
      </td>
    </tr>`;

    const headerRow = `<tr class="sub-${gi} sub-header" style="display:none;background:#dde8d8">
      <td></td><td></td>
      <td style="padding-left:28px;font-size:11px;font-weight:700;color:var(--muted);letter-spacing:0.4px">PRESENTACIÓN</td>
      <td class="text-right" style="font-size:11px;font-weight:700;color:var(--muted)">SUGERIDO</td>
      <td class="text-right" style="font-size:11px;font-weight:700;color:var(--muted)">STOCK CENTRAL</td>
      <td class="text-right" style="font-size:11px;font-weight:700;color:var(--muted)">STOCK SUC.</td>
      <td></td>
    </tr>`;

    const subRows = g.presentaciones.map((p, pi) => {
      const _pProm = p.promMes ?? Math.round((p.promDiario||0)*30*10)/10;
      return `<tr class="sub-${gi}" style="display:none;background:#f7faf6">
        <td></td>
        <td style="white-space:nowrap">${urgenciaCell(p.urgencia, textoCobertura(p.coberturaDias), gi, pi)}</td>
        <td class="nombre-col" style="padding-left:28px;font-size:13px">
          ${escHtml(p.presentacion)}
          ${_pProm ? `<div style="font-size:11px;color:var(--muted);font-weight:400;margin-top:2px">prom: ${_pProm}/mes</div>` : ''}
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
        <th title="Cobertura en días (stock central + sucursales ÷ venta diaria); el umbral depende de la clase del grupo">Urgencia</th>
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
  const plus = [...new Set((g.esGranel ? (g.plus || []) : (g.presentaciones || []).flatMap(p => p.plus || [p.plu])).map(String))];
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

// Columnas del modal. Grupo con presentaciones: una por presentación, sumando el stock de todos sus
// PLUs (p.plus: las bases fusionadas), igual que la columna "Stock suc.". Granel: una por PLU, con el
// nombre del producto sin el del grupo.
function columnasStock(data, g) {
  const filas = data.presentaciones || [];
  if ((g.presentaciones || []).length) {
    return g.presentaciones.map(p => {
      const plus = (p.plus || [p.plu]).map(String), porSuc = {};
      for (const r of filas.filter(f => plus.includes(String(f.plu))))
        for (const [id, v] of Object.entries(r.porSuc)) porSuc[id] = (porSuc[id] || 0) + v;
      return { nombre: p.presentacion || p.baseNombre, porSuc };
    });
  }
  const ref = String(g.productoRef || '');
  return filas.map(r => {
    const nom = String(r.nombre || r.plu);
    return { nombre: nom.toLowerCase().startsWith(ref.toLowerCase()) ? (nom.slice(ref.length).trim() || nom) : nom, porSuc: r.porSuc };
  });
}

// Filas = sucursales (sin Casa Central) con stock en alguna presentación; columnas = presentaciones + Total.
function renderStockDetalle(data, g) {
  const pres = columnasStock(data, g);
  const sucs = (data.sucursales || []).filter(s => !s.central && pres.some(r => r.porSuc[s.id] > 0));
  if (!sucs.length) return '<div style="padding:10px;color:var(--muted)">Sin stock en sucursales.</div>';
  const fmt = n => Math.round(n * 100) / 100;
  const num = 'text-align:right;white-space:nowrap;padding:5px 10px';
  const cell = v => v ? `<td style="${num}">${fmt(v)}</td>` : `<td style="${num};color:var(--border)">·</td>`;
  const th = 'font-size:11px;color:var(--muted);padding:4px 10px';
  const head = pres.map(r => `<th style="${th};text-align:right">${escHtml(r.nombre)}</th>`).join('');
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

function presToItem(p, productoRef, rankingPos) {
  return { idProducto: p.plu, producto: p.baseNombre, presentacion: p.presentacion, rubro: productoRef, rankingPos,
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
  agregarGrupoItems(g.productoRef, [{ ...presToItem(p, g.productoRef, g.rankingPos), cantConfirmada: cant }]);
}

function agregarGrupoAlPlan(gi) {
  const g = gruposSorted[gi];
  const items = g.presentaciones
    .map((p, pi) => ({ ...presToItem(p, g.productoRef, g.rankingPos), cantConfirmada: leerCantSug(gi, pi, p.cantSugerida) }))
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
  // Los graneles previos heredan la prioridad del grupo (el carrito se ordena por rankingPos).
  const rankingPos = items[0]?.rankingPos;
  agregarAlCarrito([...graneles.map(gr => ({ ...gr, rankingPos })), ...items.map(it => (graneles.length ? { ...it, granelAparte: true } : it))]);
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

// ── CÁLCULO DE LA URGENCIA (modal al hacer click en el chip) ──────────────
const nfAR = (n, dec = 1) => Number(n).toLocaleString('es-AR', { maximumFractionDigits: dec });
const listaY = arr => (arr.length > 1 ? arr.slice(0, -1).join(', ') + ' y ' + arr[arr.length - 1] : arr.join(''));
const chipUrgencia = nivel => { const [clase, txt] = URGENCIA_CHIP[nivel] || URGENCIA_CHIP.OK; return `<span class="badge ${clase}">${txt}</span>`; };

// Cobertura en días con 1 decimal; si el redondeo cae justo en un corte (7 → "7" cuando era 6,96) usa 2.
function fmtDias(c, ...cortes) {
  const r1 = Math.round(c * 10) / 10;
  return nfAR(c, cortes.includes(r1) && r1 !== c ? 2 : 1);
}

// Valores del cálculo de una presentación, o del grupo entero si es granel (p = null).
function datosUrgencia(g, p) {
  const central = p ? (p.stockActual || 0) : (g.granelStockGrupo || 0);
  const suc = p ? (p.stockSucursales || 0) : (g.stockSucGrupo || 0);
  const diaria = (p ? p.ventaDiariaUrg : g.ventaDiariaUrg) || 0;
  return {
    ventas: (p ? p.ventasVentana : g.ventasVentana) || 0, diaria, central, suc, total: central + suc,
    cobertura: diaria > 0 ? Math.max(0, (central + suc) / diaria) : null,
    nivel: p ? p.urgencia : g.urgencia,
  };
}

// "4,2 < 7 → Urgente": la comparación con el umbral de la clase, escrita.
function textoResultado(cobertura, umbral, nivel) {
  const nombre = (URGENCIA_CHIP[nivel] || URGENCIA_CHIP.OK)[1].replace(/^\S+\s/, '');
  if (cobertura === null) return `Sin ventas en la ventana → sin urgencia (${nombre})`;
  const c = fmtDias(cobertura, umbral, 2 * umbral);
  if (cobertura < umbral) return `${c} < ${umbral} → ${nombre}`;
  if (cobertura < 2 * umbral) return `${umbral} ≤ ${c} < ${2 * umbral} → ${nombre}`;
  return `${c} ≥ ${2 * umbral} → ${nombre}`;
}

// Qué ventas no cuentan: lo hecho por Casa Central, las sucursales no reales y las ventas internas a sucursales.
function textoExclusiones(g, mayuscula) {
  const partes = [];
  if (g.excluyeCentral) partes.push('ventas de Casa Central');
  if ((g.sucursalesExcluidas || []).length) partes.push(`sucursales ${listaY(g.sucursalesExcluidas.map(String))}`);
  partes.push('ventas internas a sucursales');
  return `${mayuscula ? 'Excluye' : 'excluye'} ${listaY(partes)}`;
}

function lineaImportancia(g) {
  return `puesto #${escHtml(String(g.rankingPos ?? '—'))} · clase ${escHtml(String(g.claseABC))} <span class="text-sm">(Pareto de facturación: A = primer 80 %, B = siguiente 15 %, C = resto)</span>`;
}
function lineaUmbral(g) {
  const u = g.umbralUrgencia;
  return `urgente &lt; ${nfAR(u)} días · pronto &lt; ${nfAR(2 * u)} días`;
}

function htmlCalculoPresentacion(g, p) {
  const d = datosUrgencia(g, p), unidad = g.esGranel ? 'kg' : 'u';
  const excluye = textoExclusiones(g);
  const fila = (etq, valor) => `<tr><td>${etq}</td><td>${valor}</td></tr>`;
  const filas = [
    fila('Ventas en la ventana', `${nfAR(d.ventas, 2)} ${unidad} en ${nfAR(g.ventanaDias, 0)} días <span class="text-sm">(${excluye})</span>`),
    fila('Venta diaria', `${nfAR(d.ventas, 2)} ÷ ${nfAR(g.ventanaDias, 0)} = <strong>${nfAR(d.diaria, 2)} ${unidad}/día</strong>`),
    fila('Stock', `central ${nfAR(d.central, 2)} + sucursales ${nfAR(d.suc, 2)} = <strong>${nfAR(d.total, 2)} ${unidad}</strong>`),
  ];
  if (d.cobertura !== null) filas.push(fila('Cobertura', `${nfAR(d.total, 2)} ÷ ${nfAR(d.diaria, 2)} = <strong>${fmtDias(d.cobertura)} días</strong>`));
  filas.push(
    fila('Importancia', lineaImportancia(g)),
    fila(`Umbral clase ${escHtml(String(g.claseABC))}`, lineaUmbral(g)),
    fila('Resultado', `<strong>${escHtml(textoResultado(d.cobertura, g.umbralUrgencia, d.nivel))}</strong> ${chipUrgencia(d.nivel)}`),
  );
  return `<table class="urg-tabla"><tbody>${filas.join('')}</tbody></table>`;
}

function htmlCalculoGrupo(g) {
  const unidad = g.esGranel ? 'kg' : 'u';
  const conPeso = Number.isFinite(g.pesoUrgente) && Number.isFinite(g.umbralPeso);
  // Peso de cada presentación en el grupo: por facturación; si el grupo no factura, por unidades vendidas.
  const presentaciones = g.presentaciones || [];
  const positivo = x => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : 0);
  const usarFact = presentaciones.some(p => positivo(p.facturacionMensual) > 0);
  const baseDe = p => positivo(usarFact ? p.facturacionMensual : p.ventasVentana);
  const totalBase = presentaciones.reduce((t, p) => t + baseDe(p), 0);
  const lineas = g.esGranel
    ? [{ nombre: 'Grupo granel', detalle: `granel central ${nfAR(g.granelStockGrupo || 0, 2)} + sucursales ${nfAR(g.stockSucGrupo || 0, 2)}`, d: datosUrgencia(g, null) }]
    : presentaciones.map(p => ({ nombre: p.presentacion || p.baseNombre, detalle: '', d: datosUrgencia(g, p), peso: totalBase > 0 ? baseDe(p) / totalBase : null }));
  // Resaltadas: las que cuentan para el nivel del grupo (urgentes si es Urgente; urgentes y pronto si es Pronto).
  // Granel (una sola fila): la de menor cobertura, como antes.
  const cuenta = l => (g.urgencia === 'URGENTE' ? l.d.nivel === 'URGENTE' : g.urgencia === 'PRONTO' && (l.d.nivel === 'URGENTE' || l.d.nivel === 'PRONTO'));
  const conCob = lineas.filter(l => l.d.cobertura !== null);
  const peor = conCob.length ? conCob.reduce((a, b) => (b.d.cobertura < a.d.cobertura ? b : a)) : null;
  const resaltar = l => (conPeso ? cuenta(l) : l === peor);
  const pct = x => nfAR(Math.round(x * 100), 0);
  const cuerpo = lineas.map(l => `<tr${resaltar(l) ? ' class="urg-peor"' : ''}>
      <td>${escHtml(l.nombre)}${l.detalle ? `<div class="text-sm">${escHtml(l.detalle)}</div>` : ''}</td>
      ${conPeso ? `<td class="num">${l.peso === null ? '—' : pct(l.peso) + ' %'}</td>` : ''}
      <td class="num">${nfAR(l.d.ventas, 2)} ${unidad}</td><td class="num">${nfAR(l.d.diaria, 2)} ${unidad}/día</td>
      <td class="num">${nfAR(l.d.total, 2)} ${unidad}</td>
      <td class="num">${l.d.cobertura === null ? '—' : fmtDias(l.d.cobertura) + ' d'}</td><td>${chipUrgencia(l.d.nivel)}</td></tr>`).join('');
  const sino = cond => (cond ? 'sí' : 'no');
  const regla = conPeso
    ? `El grupo es <strong>Urgente</strong> si lo urgente suma ≥ ${pct(g.umbralPeso)} % de su ${usarFact ? 'facturación' : 'venta en unidades (sin facturación)'} (acá: ${pct(g.pesoUrgente)} % → ${sino(g.urgencia === 'URGENTE')}). Es <strong>Pronto</strong> si lo urgente y lo pronto suman ≥ ${pct(g.umbralPeso)} % (acá: ${pct(g.pesoUrgentePronto)} % → ${sino(g.urgencia !== 'OK')}).`
    : (peor ? 'El grupo toma la peor: la presentación resaltada.' : 'Sin ventas en la ventana: el grupo no tiene urgencia.');
  return `<div class="urg-nota">Importancia: ${lineaImportancia(g)}<br>Umbral clase ${escHtml(String(g.claseABC))}: ${lineaUmbral(g)} · ventana de ${nfAR(g.ventanaDias, 0)} días</div>
    <table class="urg-tabla urg-grupo"><thead><tr><th>${g.esGranel ? 'Grupo' : 'Presentación'}</th>${conPeso ? `<th class="num">${usarFact ? '% facturación' : '% unidades'}</th>` : ''}<th class="num">Ventas ventana</th><th class="num">Venta diaria</th><th class="num">Stock total</th><th class="num">Cobertura</th><th>Nivel</th></tr></thead>
    <tbody>${cuerpo}</tbody></table>
    <div class="urg-nota text-sm">${regla} Venta diaria = ventas ÷ días de la ventana; cobertura = stock total ÷ venta diaria. ${escHtml(textoExclusiones(g, true))}.</div>`;
}

// pi = índice de la presentación dentro del grupo, o -1 para la fila del grupo.
function abrirUrgenciaDetalle(gi, pi) {
  const g = gruposSorted[gi];
  if (!g) return;
  const p = pi >= 0 ? (g.presentaciones || [])[pi] : null;
  if (pi >= 0 && !p) return;
  const ok = Number.isFinite(g.umbralUrgencia) && Number.isFinite(g.ventanaDias);
  const nivel = p ? p.urgencia : g.urgencia;
  document.getElementById('urgenciaTitulo').innerHTML = `${escHtml(p ? (p.baseNombre || g.productoRef) : g.productoRef)} · ${chipUrgencia(nivel)}`;
  document.getElementById('urgenciaBody').innerHTML = !ok
    ? '<div style="padding:10px;color:var(--muted)">Faltan datos del cálculo: recargá la página (y reiniciá el servidor si acaba de actualizarse).</div>'
    : (p ? htmlCalculoPresentacion(g, p) : htmlCalculoGrupo(g));
  document.getElementById('overlayUrgencia').classList.add('open');
}
document.getElementById('cerrarUrgencia').addEventListener('click', () => document.getElementById('overlayUrgencia').classList.remove('open'));
document.getElementById('overlayUrgencia').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
});

document.getElementById('filtroQ').addEventListener('input', () => {
  clearTimeout(buscarDebounce); buscarDebounce = setTimeout(cargarSugerencias, 400);
});
document.getElementById('btnRecargar').addEventListener('click', cargarSugerencias);

// Días a cubrir: parámetro compartido (lo guarda el servidor); cambiarlo recalcula los sugeridos.
let _diasCubrirActual = null;
async function cargarDiasCubrir() {
  try {
    const r = await api('GET', '/api/plan/params');
    _diasCubrirActual = r.diasObjetivo;
    document.getElementById('inputDiasCubrir').value = r.diasObjetivo;
  } catch { /* sin valor a la vista: el servidor igual usa el suyo para calcular */ }
}
document.getElementById('inputDiasCubrir').addEventListener('change', async e => {
  const inp = e.target, n = Number(inp.value);
  const restaurar = () => { inp.value = _diasCubrirActual ?? ''; };
  if (!Number.isInteger(n) || n < 1 || n > 180) { toast('Días a cubrir: un número entero de 1 a 180', true); restaurar(); return; }
  if (n === _diasCubrirActual) return;
  try {
    await api('PUT', '/api/plan/params', { diasObjetivo: n });
    _diasCubrirActual = n;
    toast(`Días a cubrir: ${n}`);
    cargarSugerencias();
  } catch (err) { toast('No se pudo guardar los días a cubrir: ' + mensajeApiError(err), true); restaurar(); }
});
cargarDiasCubrir();

