// Pestaña Redistribución de Distribución (id interno "rotacion"): cuando la central no cubre lo
// que piden las sucursales, sugiere traslados sucursal -> sucursal (solo informa). Datos de
// GET /api/distribucion/redistribucion?dias=N. Se carga al final de distribucion.html; usa
// escHtml de ese archivo.
let rot = { rows: [], resumen: {}, totales: null, umbrales: null, rango: null, filtro: '', key: 'central', desc: true };
let rotNombres = {};          // idSucursal -> nombre
let rotAbiertos = new Set();  // PLU (String) con el detalle expandido
const ROT_SUC_FICTICIAS = new Set(['6', '8', '11']);  // no son sucursales reales: nunca se muestran
let rotInicializado = false;
const ROT_DIAS_DEFAULT = 30, ROT_DIAS_MIN = 7, ROT_DIAS_MAX = 365;

const rotNum = n => Math.round(n || 0).toLocaleString('es-AR');
const rotDec = n => Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const rotNorm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const rotCmp = (a, b) => (typeof a === 'number' && typeof b === 'number')
  ? a - b
  : String(a ?? '').localeCompare(String(b ?? ''), 'es', { numeric: true, sensitivity: 'base' });
const rotEl = id => document.getElementById(id);

// Pesables con un decimal (son kilos); el resto en unidades enteras.
const rotCant = (n, pesable) => pesable ? rotDec(n) : rotNum(n);
const rotUni = r => r.pesable ? 'kg' : 'u';
// Venta diaria: dos decimales para que 0,25 u/día no se vea como 0.
const rotDia = n => Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function rotMensaje(texto, tipo){
  rotEl('rotMsg').innerHTML = texto ? `<div class="rot-vacio${tipo === 'err' ? ' err' : ''}">${escHtml(texto)}</div>` : '';
}

function rotNombreSuc(id){
  return rotNombres[id] || `Suc. ${id}`;
}

// Nombre largo corto para columnas angostas: "Villa Ramallo" -> "V. Ramallo".
function rotAbrev(nombre){
  const p = String(nombre).trim().split(/\s+/);
  return nombre.length <= 10 || p.length < 2 ? nombre : `${p[0][0]}. ${p.slice(1).join(' ')}`;
}

// Los nombres son solo cosmética: si falla, se muestra "Suc. N".
async function rotCargarNombres(){
  try {
    const r = await fetch('/api/distribucion/sucursales');
    if (!r.ok) return;
    (await r.json()).forEach(s => { rotNombres[s.IdSucursal] = s.Nombre; });
  } catch (_) { /* sin nombres: queda "Suc. N" */ }
}

function rotIniciar(){
  rotEl('rotDias').value = ROT_DIAS_DEFAULT;
  rotEl('rotConsultar').onclick = rotConsultar;
  rotEl('rotDias').onkeydown = e => { if (e.key === 'Enter') rotConsultar(); };
  rotEl('rotBusc').oninput = e => { rot = { ...rot, filtro: e.target.value }; rotTabla(); };
  rotEl('rotTabla').onclick = e => {
    const th = e.target.closest('th[data-orden]');
    if (th) { rotOrdenar(th.dataset.orden); return; }
    const tr = e.target.closest('tr.rot-fila');
    if (tr) rotAlternar(tr.dataset.plu);
  };
  rotEl('rotTabla').onkeydown = e => {
    const tr = e.target.closest('tr.rot-fila');
    if (tr && e.target === tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); rotAlternar(tr.dataset.plu); }
  };
}

// Carga perezosa: la primera vez que se abre la pestaña arma los controles y consulta.
async function rotAbrir(){
  if (rotInicializado) return;
  rotInicializado = true;
  rotIniciar();
  await rotCargarNombres();
  rotConsultar();
}

function rotDiasValidos(){
  const d = Number(rotEl('rotDias').value);
  return Number.isInteger(d) && d >= ROT_DIAS_MIN && d <= ROT_DIAS_MAX ? d : null;
}

async function rotConsultar(){
  const dias = rotDiasValidos();
  if (!dias){ rotMensaje(`Los días tienen que ser un número entero entre ${ROT_DIAS_MIN} y ${ROT_DIAS_MAX}.`, 'err'); return; }
  const btn = rotEl('rotConsultar');
  btn.disabled = true;
  rotMensaje('Calculando redistribución… puede tardar unos segundos.');
  try {
    const r = await fetch(`/api/distribucion/redistribucion?dias=${dias}`);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
    rotMensaje('');
    rotPintar(d);
  } catch (e) {
    rotMensaje(`No se pudo consultar: ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

function rotPintar(d){
  rot = { ...rot, rows: d.productos || [], resumen: d.resumenSucursales || {}, totales: d.totales || null,
    umbrales: d.umbrales || null, rango: d.rango || null, filtro: '' };
  rotAbiertos = new Set();
  rotEl('rotBusc').value = '';
  rotKpis();
  rotResumen();
  rotTabla();
}

// Unidades y kilos no se mezclan: los totales de cantidad los muestran por separado.
function rotSumaMixta(filas, campo){
  const unid = filas.filter(r => !r.pesable), kg = filas.filter(r => r.pesable);
  const sumar = f => f.reduce((t, r) => t + (r[campo] || 0), 0);
  return [unid.length ? `${rotNum(sumar(unid))} u` : '', kg.length ? `${rotDec(sumar(kg))} kg` : ''].filter(Boolean).join(' + ') || '0';
}

function rotKpis(){
  const rows = rot.rows, t = rot.totales || {};
  const kpis = [
    ['Productos a redistribuir', rotNum(t.productos ?? rows.length)],
    ['Movimientos sugeridos', rotNum(t.movimientos ?? rows.reduce((n, r) => n + r.movimientos.length, 0))],
    ['Faltante en central', rotSumaMixta(rows, 'faltante')],
    ['A mover entre sucursales', rotSumaMixta(rows, 'mover')],
    ['Cubiertos al 100%', rotNum(rows.filter(r => r.cubierto >= 1).length)],
  ];
  rotEl('rotKpis').innerHTML = kpis.map(([l, v]) => `<div class="kpi"><div class="l">${escHtml(l)}</div><div class="v">${escHtml(v)}</div></div>`).join('');
}

// Resumen antes/después por sucursal (unidades y kilos sumados: es una vista de volumen).
function rotResumen(){
  const ids = Object.keys(rot.resumen);
  const el = rotEl('rotResumen');
  if (!ids.length){ el.innerHTML = ''; return; }
  const fila = id => {
    const s = rot.resumen[id];
    return `<tr><td class="l" title="${escHtml(rotNombreSuc(id))}">${escHtml(rotAbrev(rotNombreSuc(id)))}</td>
      <td>${rotNum(s.stockAntes)}</td>
      <td>${s.sale ? `<span class="rot-mover">−${rotNum(s.sale)}</span>` : '<span class="rot-sin-dato">—</span>'}</td>
      <td>${s.entra ? `<span class="rot-recibe">+${rotNum(s.entra)}</span>` : '<span class="rot-sin-dato">—</span>'}</td>
      <td><b>${rotNum(s.stockDespues)}</b></td></tr>`;
  };
  el.innerHTML = `<div class="rot-card"><div class="rot-head"><h3>Antes y después por sucursal</h3></div>
    <p class="rot-desc">Stock de los productos de esta lista, sumando unidades y kilos.</p>
    <table class="rot-table rot-res"><thead><tr><th class="l">Sucursal</th><th>Antes</th><th>Sale</th><th>Entra</th><th>Después</th></tr></thead>
    <tbody>${ids.map(fila).join('')}</tbody></table></div>`;
}

// Sucursales reales presentes en los datos, en orden de id.
function rotSucIds(){
  const ids = new Set(Object.keys(rot.resumen));
  rot.rows.forEach(r => Object.keys(r.sucursales || {}).forEach(id => ids.add(id)));
  return [...ids].filter(id => !ROT_SUC_FICTICIAS.has(String(id))).sort((a, b) => a - b);
}

function rotValor(r, key){
  if (key.startsWith('s:')) return r.sucursales?.[key.slice(2)]?.stock || 0;
  return key === 'nombre' || key === 'plu' ? r[key] : (r[key] || 0);
}

// Primer clic en una columna numérica ordena de más a menos; de nuevo sobre la misma, invierte.
function rotOrdenar(key){
  rot = { ...rot, desc: rot.key === key ? !rot.desc : key !== 'nombre' && key !== 'plu', key };
  rotTabla();
}

function rotAlternar(plu){
  plu = String(plu);  // dataset siempre es string; r.plu puede venir numérico
  rotAbiertos.has(plu) ? rotAbiertos.delete(plu) : rotAbiertos.add(plu);
  rotTabla();
  [...rotEl('rotTabla').querySelectorAll('tr.rot-fila')].find(tr => tr.dataset.plu === plu)?.focus();
}

// Búsqueda (nombre o PLU) y orden vigentes.
function rotFilas(){
  const terminos = rotNorm(rot.filtro).split(/\s+/).filter(Boolean);
  const signo = rot.desc ? -1 : 1;
  return rot.rows
    .filter(r => terminos.every(t => rotNorm(`${r.nombre} ${r.plu}`).includes(t)))
    .sort((a, b) => signo * rotCmp(rotValor(a, rot.key), rotValor(b, rot.key)));
}

function rotTh(key, etiqueta, clase, titulo){
  const activa = rot.key === key;
  const flecha = activa ? (rot.desc ? ' ▼' : ' ▲') : '';
  return `<th class="${clase}" data-orden="${key}" title="${escHtml(titulo || `Ordenar por ${etiqueta}`)}"${activa ? ` aria-sort="${rot.desc ? 'descending' : 'ascending'}"` : ''}>${escHtml(etiqueta)}${flecha}</th>`;
}

// Detalle expandido: movimientos origen -> destino y situación de cada sucursal.
function rotDetalle(r){
  const q = n => rotCant(n, r.pesable), u = rotUni(r);
  const movs = r.movimientos.map(m => `<tr><td class="l"><span class="rot-mover">sale</span> ${escHtml(rotNombreSuc(m.origen))}</td>
      <td class="rot-flecha" aria-hidden="true">→</td>
      <td class="l"><span class="rot-recibe">entra</span> ${escHtml(rotNombreSuc(m.destino))}</td>
      <td><b>${q(m.cantidad)} ${u}</b></td></tr>`).join('');
  const sucs = Object.entries(r.sucursales || {}).map(([id, s]) => {
    const marca = s.pocasVentas ? '<span class="rot-falta" title="Vende menos que el umbral: queda en presencia mínima">pocas ventas</span>' : '';
    return `<tr><td class="l">${escHtml(rotNombreSuc(id))} ${marca}</td><td>${q(s.stock)}</td><td>${rotDia(s.ventaDia)}</td>
      <td>${q(s.objetivo)}</td><td>${s.necesidad ? q(s.necesidad) : '—'}</td><td>${s.sobrante ? q(s.sobrante) : '—'}</td>
      <td><b>${q(s.stockFinal)}</b></td></tr>`;
  }).join('');
  return `<div class="rot-det"><div><h4>Movimientos sugeridos (${r.movimientos.length})</h4>
      <table class="rot-sub"><tbody>${movs}</tbody></table></div>
    <div><h4>Situación por sucursal (${r.pesable ? 'kg' : 'unidades'}, ventas por día)</h4>
      <table class="rot-sub"><thead><tr><th class="l">Sucursal</th><th>Stock</th><th>Vta/día</th><th>Objetivo</th><th>Necesita</th><th>Sobra</th><th>Final</th></tr></thead>
      <tbody>${sucs}</tbody></table></div></div>`;
}

// Celda de sucursal: stock + lo que sale (rojo) o entra (azul) según los movimientos sugeridos.
function rotCelda(r, id){
  const s = r.sucursales?.[id], q = n => rotCant(n, r.pesable);
  if (!s) return '<td class="rot-suc"><span class="rot-sin-dato">—</span></td>';
  const suma = campo => (r.movimientos || []).filter(m => String(m[campo]) === String(id)).reduce((t, m) => t + m.cantidad, 0);
  const sale = suma('origen'), entra = suma('destino'), u = rotUni(r);
  const marca = sale ? `<span class="rot-mover" role="img" aria-label="Sale ${q(sale)} ${u}">−${q(sale)}</span>`
    : entra ? `<span class="rot-recibe" role="img" aria-label="Entra ${q(entra)} ${u}">+${q(entra)}</span>` : '';
  const tip = [`Stock: ${q(s.stock)} ${u}`, `Ventas/día: ${rotDia(s.ventaDia)}`, s.pocasVentas ? 'Pocas ventas' : '',
    `Objetivo: ${q(s.objetivo)} ${u}`, sale ? `Sale: ${q(sale)} ${u}` : '', entra ? `Entra: ${q(entra)} ${u}` : ''].filter(Boolean).join('\n');
  return `<td class="rot-suc" title="${escHtml(tip)}"><b>${q(s.stock)}</b>${marca}</td>`;
}

function rotFila(r, ids){
  const plu = String(r.plu), abierto = rotAbiertos.has(plu);
  const tip = `${r.nombre}${r.rubro ? `\nRubro: ${r.rubro}` : ''}${r.pesable ? '\nPesable (kg)' : ''}`;
  const fila = `<tr class="rot-fila${abierto ? ' abierta' : ''}" data-plu="${escHtml(plu)}" tabindex="0" aria-expanded="${abierto}" aria-label="${escHtml(r.nombre)}: ver movimientos">
    <td class="l">${escHtml(plu)}</td>
    <td class="l nombre" title="${escHtml(tip)}">${escHtml(r.nombre)}</td>
    <td><b>${rotCant(r.central, r.pesable)}</b></td>${ids.map(id => rotCelda(r, id)).join('')}</tr>`;
  return abierto ? `${fila}<tr class="rot-detalle"><td colspan="${ids.length + 3}">${rotDetalle(r)}</td></tr>` : fila;
}

function rotTabla(){
  const el = rotEl('rotTabla');
  const filas = rotFilas();
  if (!filas.length){
    el.innerHTML = `<div class="rot-vacio">${rot.filtro ? 'Ningún producto coincide con la búsqueda.' : 'No hay faltantes en central que se puedan cubrir con mercadería parada en sucursales.'}</div>`;
    return;
  }
  const ids = rotSucIds();
  const ths = ids.map(id => rotTh(`s:${id}`, rotAbrev(rotNombreSuc(id)), 'rot-suc', `${rotNombreSuc(id)}: ordenar por stock`)).join('');
  el.innerHTML = `<table class="rot-table"><colgroup><col class="c-c"><col><col class="c-u">${ids.map(() => '<col class="c-s">').join('')}</colgroup>
    <thead><tr>${rotTh('plu', 'Código', 'l')}${rotTh('nombre', 'Producto', 'l')}${rotTh('central', 'Central', '')}${ths}</tr></thead>
    <tbody>${filas.map(r => rotFila(r, ids)).join('')}</tbody></table>`;
}
