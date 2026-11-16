// Pestaña Redistribución de Distribución (id interno "rotacion"): cuando la central no cubre lo
// que piden las sucursales, sugiere traslados sucursal -> sucursal (solo informa). Datos de
// GET /api/distribucion/redistribucion?dias=N. Se carga al final de distribucion.html; usa
// escHtml de ese archivo.
let rot = { rows: [], resumen: {}, totales: null, umbrales: null, rango: null, filtro: '', key: 'mover', desc: true };
let rotNombres = {};          // idSucursal -> nombre
let rotAbiertos = new Set();  // PLU con el detalle expandido
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
    const b = e.target.closest('button[data-plu]');
    if (b) rotAlternar(b.dataset.plu);
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

function rotValor(r, key){
  return key === 'nombre' ? r.nombre : (r[key] || 0);
}

// Primer clic en una columna numérica ordena de más a menos; de nuevo sobre la misma, invierte.
function rotOrdenar(key){
  rot = { ...rot, desc: rot.key === key ? !rot.desc : key !== 'nombre', key };
  rotTabla();
}

function rotAlternar(plu){
  rotAbiertos.has(plu) ? rotAbiertos.delete(plu) : rotAbiertos.add(plu);
  rotTabla();
}

// Búsqueda (nombre o PLU) y orden vigentes.
function rotFilas(){
  const terminos = rotNorm(rot.filtro).split(/\s+/).filter(Boolean);
  const signo = rot.desc ? -1 : 1;
  return rot.rows
    .filter(r => terminos.every(t => rotNorm(`${r.nombre} ${r.plu}`).includes(t)))
    .sort((a, b) => signo * rotCmp(rotValor(a, rot.key), rotValor(b, rot.key)));
}

function rotTh(key, etiqueta, clase){
  const activa = rot.key === key;
  const flecha = activa ? (rot.desc ? ' ▼' : ' ▲') : '';
  return `<th class="${clase}" data-orden="${key}" title="Ordenar por ${escHtml(etiqueta)}"${activa ? ` aria-sort="${rot.desc ? 'descending' : 'ascending'}"` : ''}>${escHtml(etiqueta)}${flecha}</th>`;
}

function rotCubierto(v){
  const p = Math.round((v || 0) * 100);
  return `<span class="rot-cub${p >= 100 ? ' ok' : ''}" style="--p:${Math.min(p, 100)}%">${p}%</span>`;
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

function rotFila(r){
  const abierto = rotAbiertos.has(r.plu), q = n => rotCant(n, r.pesable), u = rotUni(r);
  const fila = `<tr class="rot-fila${abierto ? ' abierta' : ''}">
    <td class="rot-n"><button type="button" class="rot-exp" data-plu="${escHtml(r.plu)}" aria-expanded="${abierto}" aria-label="Ver movimientos de ${escHtml(r.nombre)}">${abierto ? '▾' : '▸'}</button></td>
    <td class="l nombre" title="${escHtml(`${r.nombre}${r.rubro ? `\nRubro: ${r.rubro}` : ''}\nPLU ${r.plu}`)}">${escHtml(r.nombre)}</td>
    <td>${q(r.central)}</td><td>${q(r.demanda)}</td><td><b>${q(r.faltante)}</b></td>
    <td><b class="rot-rep">${q(r.mover)}</b> <span class="rot-sin-dato">${u}</span></td>
    <td>${rotCubierto(r.cubierto)}</td>
    <td>${rotNum(r.movimientos.length)}</td></tr>`;
  return abierto ? `${fila}<tr class="rot-detalle"><td></td><td colspan="7">${rotDetalle(r)}</td></tr>` : fila;
}

function rotTabla(){
  const el = rotEl('rotTabla');
  const filas = rotFilas();
  if (!filas.length){
    el.innerHTML = `<div class="rot-vacio">${rot.filtro ? 'Ningún producto coincide con la búsqueda.' : 'No hay faltantes en central que se puedan cubrir con mercadería parada en sucursales.'}</div>`;
    return;
  }
  el.innerHTML = `<table class="rot-table"><colgroup><col class="c-n"><col><col class="c-u"><col class="c-u"><col class="c-u"><col class="c-u"><col class="c-p"><col class="c-m"></colgroup>
    <thead><tr><th></th>${rotTh('nombre', 'Producto', 'l')}${rotTh('central', 'Central', '')}${rotTh('demanda', 'Demanda', '')}
      ${rotTh('faltante', 'Faltante', '')}${rotTh('mover', 'A mover', '')}${rotTh('cubierto', 'Cubierto', '')}<th title="Cantidad de traslados">Mov.</th>
    </tr></thead><tbody>${filas.map(rotFila).join('')}</tbody></table>`;
}
