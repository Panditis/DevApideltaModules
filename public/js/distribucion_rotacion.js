// Pestaña Redistribución de Distribución (id interno "rotacion"): para los productos sin stock en
// central, sugiere traslados sucursal -> sucursal (solo informa). Datos de
// GET /api/distribucion/redistribucion?dias=N. Se carga al final de distribucion.html; usa
// escHtml de ese archivo.
let rot = { rows: [], rango: null, filtro: '', tipo: '', ceroGranel: false, ceroPres: true, suc: '', verOcultos: false, key: 'nombre', desc: false };
let rotNombres = {};          // idSucursal -> nombre
let rotAbiertos = new Set();  // PLU (String) con el detalle expandido
const ROT_SUC_FICTICIAS = new Set(['6', '8', '11']);  // no son sucursales reales: nunca se muestran
// Ocultos COMPARTIDOS (los guarda el servidor, por sucursal): idSucursal (String) -> Set de PLU (String);
// rotOcInfo: idSucursal -> Map PLU -> { usuario, fecha } para el tooltip. Ambos se reemplazan enteros, nunca se mutan.
let rotOcultos = new Map(), rotOcInfo = new Map();
let rotOcBusy = false;        // hay un cambio de ocultos en vuelo
let rotOcVersion = 0;         // sube con cada cambio local o respuesta de POST: un GET anterior queda obsoleto
let rotMsgOc = false;         // el aviso visible en #rotMsg es de ocultos (para limpiarlo sin pisar otros)
let rotInicializado = false;
const ROT_OC_URL = '/api/distribucion/redistribucion/ocultos';
const ROT_OC_REFRESCO_MS = 30000;
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

const rotSetOc = () => rotOcultos.get(String(rot.suc)) || new Set();
const rotInfoOc = plu => rotOcInfo.get(String(rot.suc))?.get(String(plu));

// Reemplaza el estado con el mapa del servidor { ocultos: { suc: [{ plu, usuario, fecha }] } }.
function rotAplicarOcultos(d){
  const oc = new Map(), info = new Map();
  Object.entries(d?.ocultos || {}).forEach(([suc, lista]) => {
    oc.set(suc, new Set(lista.map(o => String(o.plu))));
    info.set(suc, new Map(lista.map(o => [String(o.plu), { usuario: o.usuario ?? null, fecha: o.fecha ?? null }])));
  });
  rotOcultos = oc;
  rotOcInfo = info;
}

// Firma del conjunto de la sucursal activa: solo si cambia hace falta volver a pintar.
const rotFirmaOc = () => [...rotSetOc()].sort().join(',');

async function rotOcFetch(ruta, opciones){
  const r = await fetch(ROT_OC_URL + ruta, opciones);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
  return d;
}

// Avisos de ocultos en #rotMsg: se limpian solo si el aviso visible es de ocultos.
function rotAvisoOc(texto, tipo){
  if (texto) { rotMensaje(texto, tipo); rotMsgOc = true; }
  else if (rotMsgOc) { rotMensaje(''); rotMsgOc = false; }
}

// Lee los ocultos del servidor; repinta solo si cambió el conjunto de la sucursal activa.
async function rotRefrescarOcultos(){
  if (rotOcBusy) return;  // el cambio en vuelo ya trae el mapa completo al terminar
  const version = rotOcVersion;
  try {
    const antes = rotFirmaOc();
    const d = await rotOcFetch('', {});
    if (version !== rotOcVersion) return;  // hubo un cambio local mientras tanto: esta respuesta es vieja
    rotAplicarOcultos(d);
    rotAvisoOc('');
    if (rot.rows.length && rotFirmaOc() !== antes) rotTabla();
  } catch (_) {
    rotAvisoOc('No se pudieron cargar los ocultos compartidos');
  }
}

// Refresco en segundo plano: solo con la pestaña a la vista, el navegador visible y una sucursal elegida.
function rotRefrescoPeriodico(){
  if (rot.suc && !document.hidden && rotEl('panel-rotacion').classList.contains('on')) rotRefrescarOcultos();
}

function rotFocoX(idx){
  if (idx < 0 || document.activeElement !== document.body) return;
  const btns = rotEl('rotTabla').querySelectorAll('button.rot-x-btn');
  btns[Math.min(idx, btns.length - 1)]?.focus();
}

// Cambio optimista y POST; al responder se adopta el mapa del servidor, si falla se revierte.
async function rotOcEnviar(ruta, cuerpo, local, idx){
  if (rotOcBusy) return;
  const previo = [rotOcultos, rotOcInfo];
  local();
  rotOcVersion++;
  rotOcBusy = true;
  rotTabla(); rotFocoX(idx);
  try {
    const d = await rotOcFetch(ruta, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
    rotOcVersion++;
    rotAplicarOcultos(d);
    rotAvisoOc('');
  } catch (e) {
    [rotOcultos, rotOcInfo] = previo;
    rotOcVersion++;
    rotAvisoOc(`No se pudo guardar el cambio de ocultos: ${e.message}`, 'err');
  } finally {
    rotOcBusy = false;
    rotTabla(); rotFocoX(idx);
  }
}

// Copia del estado con un PLU ocultado o restaurado en la sucursal.
function rotLocalOculto(suc, plu, oculto){
  const set = new Set(rotOcultos.get(suc) || []), info = new Map(rotOcInfo.get(suc) || []);
  oculto ? (set.add(plu), info.set(plu, { usuario: null, fecha: null })) : (set.delete(plu), info.delete(plu));
  rotOcultos = new Map(rotOcultos).set(suc, set);
  rotOcInfo = new Map(rotOcInfo).set(suc, info);
}

function rotMensaje(texto, tipo){
  rotMsgOc = false;  // un mensaje directo reemplaza cualquier aviso de ocultos
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
  rotEl('rotTipo').onclick = e => {
    const b = e.target.closest('button[data-tipo]');
    if (b) { rot = { ...rot, tipo: b.dataset.tipo }; rotTabla(); }
  };
  rotEl('rotCeros').onclick = e => {
    const b = e.target.closest('button[data-cero]');
    if (b) { rot = { ...rot, [b.dataset.cero]: !rot[b.dataset.cero] }; rotTabla(); }
  };
  rotEl('rotSuc').onchange = e => {
    const suc = e.target.value;
    rot = { ...rot, suc, verOcultos: false, key: suc ? 'sale' : 'nombre', desc: !!suc };
    rotTabla();
    rotRefrescarOcultos();
  };
  rotEl('rotVerOc').onclick = () => { rot = { ...rot, verOcultos: !rot.verOcultos }; rotTabla(); };
  rotEl('rotResetOc').onclick = () => {
    const n = rotSetOc().size;
    if (!n || rotOcBusy || !confirm(`¿Volver a mostrar los ${n} productos ocultos de ${rotNombreSuc(rot.suc)}? Se restablecen para todos los usuarios.`)) return;
    const suc = String(rot.suc);
    rotOcEnviar('/restablecer', { sucursal: Number(suc) }, () => {
      rotOcultos = new Map(rotOcultos).set(suc, new Set());
      rotOcInfo = new Map(rotOcInfo).set(suc, new Map());
      rot = { ...rot, verOcultos: false };
    }, -1);
  };
  rotEl('rotPdf').onclick = rotImprimir;
  rotEl('rotTabla').onclick = e => {
    const x = e.target.closest('button.rot-x-btn');
    if (x) { rotAlternarOculto(x.dataset.plu, x.closest('tr')); return; }
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
  rotRefrescarOcultos();  // cada vez que se abre la pestaña se traen los ocultos de los demás usuarios
  if (rotInicializado) return;
  rotInicializado = true;
  rotIniciar();
  try { localStorage.removeItem('rot_ocultos_v1'); } catch (_) { /* clave vieja: sin storage no hay nada que borrar */ }
  setInterval(rotRefrescoPeriodico, ROT_OC_REFRESCO_MS);
  document.addEventListener('visibilitychange', rotRefrescoPeriodico);
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
    rotRefrescarOcultos();
  } catch (e) {
    rotMensaje(`No se pudo consultar: ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

function rotPintar(d){
  rot = { ...rot, rows: d.productos || [], rango: d.rango || null, filtro: '' };
  rotAbiertos = new Set();
  rotEl('rotBusc').value = '';
  rotOpcionesSuc();
  rotTabla();
}

// Opciones del selector de sucursal según los datos; si la elegida ya no existe vuelve a "Todas".
function rotOpcionesSuc(){
  const ids = rotSucIds().map(String);
  if (rot.suc && !ids.includes(String(rot.suc))) rot = { ...rot, suc: '', verOcultos: false, key: 'nombre', desc: false };
  rotEl('rotSuc').innerHTML = `<option value="">Todas</option>${ids.map(id => `<option value="${escHtml(id)}">${escHtml(rotNombreSuc(id))}</option>`).join('')}`;
  rotEl('rotSuc').value = rot.suc;
}

// Cantidad que sale de la sucursal (el valor rojo −N de su celda).
const rotSale = (r, id) => (r.movimientos || []).filter(m => String(m.origen) === String(id)).reduce((t, m) => t + m.cantidad, 0);

function rotAlternarOculto(plu, tr){
  if (rotOcBusy) return;
  const suc = String(rot.suc), oculto = !rotSetOc().has(String(plu));
  const idx = [...rotEl('rotTabla').querySelectorAll('tr.rot-fila')].indexOf(tr);
  rotOcEnviar('', { sucursal: Number(suc), plu: String(plu), oculto }, () => rotLocalOculto(suc, String(plu), oculto), idx);
}

// Sucursales reales presentes en los datos, en orden de id.
function rotSucIds(){
  const ids = new Set();
  rot.rows.forEach(r => Object.keys(r.sucursales || {}).forEach(id => ids.add(id)));
  return [...ids].filter(id => !ROT_SUC_FICTICIAS.has(String(id))).sort((a, b) => a - b);
}

function rotValor(r, key){
  if (key === 'sale') return rotSale(r, rot.suc);
  if (key === 'centralGranel') return r.centralGranel ?? null;  // almacén: sin granel, va al final
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

// Filtro de ceros de los pesables. Solo con tipo Pesables se aplican los toggles (ambos activos = AND, ninguno = todos).
// Con tipo Todos, los pesables siguen exigiendo central <= 0 (envasado), como antes. Las filas de almacén no se tocan.
// centralGranel null = sin dato: no cumple "0 en granel".
function rotPasaCeros(r){
  if (!r.pesable) return true;
  const sinEnvasado = !(r.central > 0), sinGranel = Number.isFinite(r.centralGranel) && r.centralGranel <= 0;
  if (rot.tipo !== 'pesable') return sinEnvasado;
  return (!rot.ceroPres || sinEnvasado) && (!rot.ceroGranel || sinGranel);
}

// Tipo, búsqueda y, con sucursal elegida, solo lo que esa sucursal cede (sin orden ni ocultos).
function rotBase(){
  const terminos = rotNorm(rot.filtro).split(/\s+/).filter(Boolean);
  return rot.rows
    .filter(r => !rot.tipo || (rot.tipo === 'pesable') === !!r.pesable)
    .filter(rotPasaCeros)
    .filter(r => !rot.suc || rotSale(r, rot.suc) > 0)
    .filter(r => terminos.every(t => rotNorm(`${r.nombre} ${r.plu}`).includes(t)));
}

// Base sin los ocultos (salvo "Ver ocultos"), con el orden vigente.
function rotFilas(){
  const oc = rotSetOc(), signo = rot.desc ? -1 : 1;
  return rotBase()
    .filter(r => rot.verOcultos || !oc.has(String(r.plu)))
    .sort((a, b) => {
      const va = rotValor(a, rot.key), vb = rotValor(b, rot.key);
      if (va === null || vb === null) return (va === null) - (vb === null);  // los sin dato siempre al final
      return signo * rotCmp(va, vb);
    });
}

function rotTh(key, etiqueta, clase, titulo){
  if (rot.suc && key === `s:${rot.suc}`) { key = 'sale'; titulo = `${rotNombreSuc(rot.suc)}: ordenar por lo que sale`; }
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
  const sel = rot.suc && String(id) === String(rot.suc) ? ' rot-sel' : '';
  if (!s) return `<td class="rot-suc${sel}"><span class="rot-sin-dato">—</span></td>`;
  const suma = campo => (r.movimientos || []).filter(m => String(m[campo]) === String(id)).reduce((t, m) => t + m.cantidad, 0);
  const sale = suma('origen'), entra = suma('destino'), u = rotUni(r);
  const marca = sale ? `<span class="rot-mover" role="img" aria-label="Sale ${q(sale)} ${u}">−${q(sale)}</span>`
    : entra ? `<span class="rot-recibe" role="img" aria-label="Entra ${q(entra)} ${u}">+${q(entra)}</span>` : '';
  const tip = [`Stock: ${q(s.stock)} ${u}`, `Ventas/día: ${rotDia(s.ventaDia)}`, s.pocasVentas ? 'Pocas ventas' : '',
    `Objetivo: ${q(s.objetivo)} ${u}`, sale ? `Sale: ${q(sale)} ${u}` : '', entra ? `Entra: ${q(entra)} ${u}` : ''].filter(Boolean).join('\n');
  return `<td class="rot-suc${sel}" title="${escHtml(tip)}"><b>${q(s.stock)}</b>${marca}</td>`;
}

function rotFila(r, ids){
  const plu = String(r.plu), abierto = rotAbiertos.has(plu), oculto = !!rot.suc && rotSetOc().has(plu);
  const tip = `${r.nombre}${r.rubro ? `\nRubro: ${r.rubro}` : ''}${r.pesable ? '\nPesable (kg)' : ''}`;
  const dis = rotOcBusy ? ' disabled' : '';
  const info = oculto ? rotInfoOc(plu) : null;
  const fecha = info?.fecha && !isNaN(new Date(info.fecha)) ? new Date(info.fecha).toLocaleString('es-AR') : '';
  const quien = info && (info.usuario || fecha) ? `Ocultado${info.usuario ? ` por ${info.usuario}` : ''}${fecha ? ` el ${fecha}` : ''}` : '';
  const btn = oculto
    ? `<button type="button" class="rot-x-btn" data-plu="${escHtml(plu)}"${dis} aria-label="Volver a mostrar ${escHtml(r.nombre)}" title="Volver a mostrar">↺</button>`
    : `<button type="button" class="rot-x-btn" data-plu="${escHtml(plu)}"${dis} aria-label="Ocultar ${escHtml(r.nombre)}" title="Ocultar de la lista">×</button>`;
  const fila = `<tr class="rot-fila${abierto ? ' abierta' : ''}${oculto ? ' rot-oculta' : ''}" data-plu="${escHtml(plu)}" tabindex="0" aria-expanded="${abierto}" aria-label="${escHtml(r.nombre)}: ver movimientos">
    ${rot.suc ? `<td class="rot-x">${btn}</td>` : ''}<td class="l">${escHtml(plu)}</td>
    <td class="l nombre" title="${escHtml(tip)}">${escHtml(r.nombre)}${oculto ? ` <span class="rot-oc-tag"${quien ? ` title="${escHtml(quien)}"` : ''}>oculto</span>` : ''}</td>
    <td>${r.centralGranel == null ? '<span class="rot-sin-dato">—</span>' : `${rotDec(r.centralGranel)} kg`}</td>
    <td>${rotCant(r.central, r.pesable)}${r.pesable ? ' kg' : ''}</td>
    ${ids.map(id => rotCelda(r, id)).join('')}${rot.suc ? `<td class="l rot-dest">${rotDestinos(r)}</td>` : ''}</tr>`;
  return abierto ? `${fila}<tr class="rot-detalle"><td colspan="${ids.length + 4 + (rot.suc ? 2 : 0)}">${rotDetalle(r)}</td></tr>` : fila;
}

// A qué sucursales va lo que sale de la filtrada: "Pergamino +14 · Ramallo +2".
function rotDestinos(r){
  const porDestino = new Map();
  (r.movimientos || []).filter(m => String(m.origen) === String(rot.suc))
    .forEach(m => porDestino.set(String(m.destino), (porDestino.get(String(m.destino)) || 0) + m.cantidad));
  return [...porDestino].sort((a, b) => b[1] - a[1])
    .map(([id, q]) => `${escHtml(rotAbrev(rotNombreSuc(id)))} +${rotCant(q, r.pesable)}${r.pesable ? ' kg' : ''}`).join(' · ');
}

// Texto del estado vacío según qué dejó la lista sin filas.
function rotTextoVacio(hayOcultos){
  if (rot.suc && hayOcultos) return 'Todos los productos están ocultos. Usá «Ver ocultos» o «Restablecer ocultos».';
  if (rot.suc) return 'Esta sucursal no tiene mercadería para ceder con los filtros actuales.';
  return rot.filtro || rot.tipo ? 'Ningún producto coincide con los filtros.' : 'No hay productos sin stock en central con mercadería para redistribuir.';
}

// Controles que dependen del estado: toggles de tipo, botones de ocultos (solo con sucursal) e imprimir.
function rotControles(filas, nOcultos){
  rotEl('rotTipo').querySelectorAll('button').forEach(b => {
    const on = b.dataset.tipo === rot.tipo;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on);
  });
  rotEl('rotCeros').hidden = rot.tipo !== 'pesable';
  rotEl('rotCeros').querySelectorAll('button').forEach(b => {
    b.classList.toggle('on', rot[b.dataset.cero]);
    b.setAttribute('aria-pressed', rot[b.dataset.cero]);
  });
  rotEl('rotOcBox').hidden = !rot.suc;
  rotEl('rotVerOc').textContent = `Ver ocultos (${nOcultos})`;
  rotEl('rotVerOc').disabled = !nOcultos;
  rotEl('rotVerOc').classList.toggle('on', rot.verOcultos);
  rotEl('rotVerOc').setAttribute('aria-pressed', rot.verOcultos);
  rotEl('rotResetOc').disabled = !rotSetOc().size || rotOcBusy;
  rotEl('rotPdf').disabled = !filas.length;
}

function rotTabla(){
  const el = rotEl('rotTabla');
  const nOcultos = rot.suc ? rotBase().filter(r => rotSetOc().has(String(r.plu))).length : 0;
  if (rot.verOcultos && !nOcultos) rot = { ...rot, verOcultos: false };
  const filas = rotFilas();
  rotControles(filas, nOcultos);
  if (!filas.length){
    el.innerHTML = `<div class="rot-vacio">${rotTextoVacio(nOcultos > 0)}</div>`;
    return;
  }
  const ids = rotSucIds();  // con sucursal elegida se ven todas; la elegida va resaltada
  const ths = ids.map(id => rotTh(`s:${id}`, rotAbrev(rotNombreSuc(id)), `rot-suc${rot.suc && String(id) === String(rot.suc) ? ' rot-sel' : ''}`, `${rotNombreSuc(id)}: ordenar por stock`)).join('');
  el.innerHTML = `<table class="rot-table"><colgroup>${rot.suc ? '<col class="c-x">' : ''}<col class="c-c"><col><col class="c-g"><col class="c-n">${ids.map(() => '<col class="c-s">').join('')}${rot.suc ? '<col class="c-d">' : ''}</colgroup>
    <thead><tr>${rot.suc ? '<th class="rot-x" aria-label="Ocultar"></th>' : ''}${rotTh('plu', 'Código', 'l')}${rotTh('nombre', 'Producto', 'l')}${rotTh('centralGranel', 'Stock / Granel', '', 'Stock / Granel: stock del producto a granel en casa central (kg)')}${rotTh('central', 'Envasado', '', 'Envasado: stock del producto envasado/fraccionado en casa central')}${ths}${rot.suc ? '<th class="l">Destino</th>' : ''}</tr></thead>
    ${filas.map(r => `<tbody class="rot-prod">${rotFila(r, ids)}</tbody>`).join('')}</table>`;
}

const ROT_TIPOS = { '': 'Todos', almacen: 'Almacén', pesable: 'Pesables' };

// Encabezado que solo se ve al imprimir: título, emisión, rango de ventas y filtros vigentes.
function rotTextoCeros(){
  if (rot.tipo !== 'pesable') return '';
  const t = [rot.ceroGranel && '0 en granel', rot.ceroPres && '0 en presentaciones'].filter(Boolean);
  return ` · ${t.length ? t.join(' + ') : 'sin filtro de ceros'}`;
}

function rotEncabezadoImpresion(){
  const col = rot.key === 'nombre' ? 'Producto' : rot.key === 'plu' ? 'Código' : rot.key === 'centralGranel' ? 'Stock / Granel' : rot.key === 'central' ? 'Envasado'
    : rot.key === 'sale' ? `Sale de ${rotNombreSuc(rot.suc)}` : rotNombreSuc(rot.key.slice(2));
  const nOc = rot.suc ? rotBase().filter(r => rotSetOc().has(String(r.plu))).length : 0;
  const oc = nOc ? `; Ocultos: ${nOc} (${rot.verOcultos ? 'incluidos' : 'no incluidos'})` : '';
  const g = rot.rango || {};
  const rango = g.desde ? `${escHtml(g.desde)} a ${escHtml(g.hasta)}${g.dias ? ` (${g.dias} días)` : ''}` : '—';
  const busq = rot.filtro.trim() ? `; Búsqueda: «${escHtml(rot.filtro.trim())}»` : '';
  rotEl('rotPrintHead').innerHTML = `<h1>Redistribución de stock entre sucursales</h1>
    <p>Emitido: ${new Date().toLocaleString('es-AR')} · Ventas: ${rango}</p>
    <p>Tipo: ${ROT_TIPOS[rot.tipo]}${rotTextoCeros()}; Sucursal: ${rot.suc ? escHtml(rotNombreSuc(rot.suc)) : 'Todas'}${busq}${oc}; Orden: ${escHtml(col)} ${rot.desc ? 'descendente' : 'ascendente'}</p>`;
}

function rotImprimir(){
  rotEncabezadoImpresion();
  window.print();
}
