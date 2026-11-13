// Pestaña Rotación de Distribución: un puntaje 0..100 por producto que dice qué tan dispar
// se vende entre las sucursales tildadas, dónde se vende más y las unidades de cada
// sucursal, con la celda pintada según el peso del producto ahí. Se carga al final de
// distribucion.html; usa escHtml de ese archivo y apdAvisar de apd-dialogo.js.
let rot = { rows: [], sucursales: [], filtro: '', key: 'puntaje', desc: true };
let rotSucs = [];            // [{id, nombre}] elegibles
let rotSel = new Set();      // ids tildados
let rotInicializado = false;
let rotRango = { desde: '', hasta: '' };
// Umbral del KPI "muy dispares": a partir de acá la diferencia entre sucursales es marcada.
const ROT_PUNTAJE_ALTO = 50;
const ROT_DIAS_DEFAULT = 30;
// Sucursales ficticias: no son reales y no entran en ningún cálculo.
const ROT_SUC_FICTICIAS = new Set([6, 8, 11]);

const rotNum = n => Math.round(n || 0).toLocaleString('es-AR');
const rotDec = n => Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const rotMoney = n => '$' + rotNum(n);
const rotNorm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const rotCmp = (a, b) => (typeof a === 'number' && typeof b === 'number')
  ? a - b
  : String(a ?? '').localeCompare(String(b ?? ''), 'es', { numeric: true, sensitivity: 'base' });
const rotEl = id => document.getElementById(id);

function rotIso(d){
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function rotMensaje(texto, esError){
  rotEl('rotMsg').innerHTML = texto ? `<div class="rot-vacio${esError ? ' err' : ''}">${escHtml(texto)}</div>` : '';
}

function rotChips(){
  rotEl('rotChips').innerHTML = rotSucs.map(s =>
    `<button type="button" class="suc-tog${rotSel.has(s.id) ? ' on' : ''}" data-id="${s.id}" aria-pressed="${rotSel.has(s.id)}">${escHtml(s.nombre)}</button>`).join('');
}

async function rotCargarSucursales(){
  const r = await fetch('/api/distribucion/sucursales');
  if (!r.ok) throw new Error('No se pudo cargar la lista de sucursales');
  const filas = await r.json();
  rotSucs = filas
    .filter(s => !s.SoyLaCentral && !ROT_SUC_FICTICIAS.has(Number(s.IdSucursal)))
    .map(s => ({ id: Number(s.IdSucursal), nombre: s.Nombre }));
  rotSel = new Set(rotSucs.map(s => s.id));
  rotChips();
}

function rotIniciar(){
  const hoy = new Date();
  const desde = new Date(hoy); desde.setDate(desde.getDate() - ROT_DIAS_DEFAULT);
  rotEl('rotDesde').value = rotIso(desde);
  rotEl('rotHasta').value = rotIso(hoy);
  rotEl('rotChips').onclick = e => {
    const b = e.target.closest('.suc-tog'); if (!b) return;
    const id = Number(b.dataset.id);
    rotSel.has(id) ? rotSel.delete(id) : rotSel.add(id);
    rotChips();
  };
  rotEl('rotTodas').onclick = () => { rotSel = new Set(rotSucs.map(s => s.id)); rotChips(); };
  rotEl('rotNinguna').onclick = () => { rotSel.clear(); rotChips(); };
  rotEl('rotConsultar').onclick = rotConsultar;
  rotEl('rotBusc').oninput = e => rotBuscar(e.target.value);
  rotEl('rotExcel').onclick = rotExportar;
  rotEl('rotTabla').onclick = e => {
    const th = e.target.closest('th[data-orden]'); if (th) rotOrdenar(th.dataset.orden);
  };
}

// Carga perezosa: la primera vez que se abre la pestaña arma los controles y consulta.
async function rotAbrir(){
  if (rotInicializado) return;
  rotInicializado = true;
  rotIniciar();
  try {
    await rotCargarSucursales();
  } catch (e) {
    rotInicializado = false;
    rotMensaje(e.message, true);
    return;
  }
  rotConsultar();
}

async function rotConsultar(){
  const desde = rotEl('rotDesde').value, hasta = rotEl('rotHasta').value;
  if (!desde || !hasta || desde > hasta){ rotMensaje('Elegí un rango de fechas válido.', true); return; }
  if (rotSel.size < 2){ rotMensaje('Tildá al menos 2 sucursales para comparar.', true); return; }
  const btn = rotEl('rotConsultar');
  btn.disabled = true;
  rotMensaje('Consultando… con muchas sucursales tarda.');
  try {
    const r = await fetch(`/api/distribucion/rotacion?desde=${desde}&hasta=${hasta}&sucursales=${[...rotSel].join(',')}`);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
    rotMensaje('');
    rotRango = { desde, hasta };
    rotPintar(d);
  } catch (e) {
    rotMensaje(`No se pudo consultar: ${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

function rotPintar(d){
  rot = { ...rot, rows: d.productos || [], sucursales: d.sucursales || [], filtro: '' };
  rotEl('rotBusc').value = '';
  rotEl('rotKpis').innerHTML = [
    ['Productos analizados', rotNum(rot.rows.length)],
    [`Puntaje ≥ ${ROT_PUNTAJE_ALTO}`, rotNum(rot.rows.filter(r => r.puntaje >= ROT_PUNTAJE_ALTO).length)],
  ].map(([lbl, val]) => `<div class="kpi"><div class="l">${lbl}</div><div class="v">${val}</div></div>`).join('');
  rotTabla();
}

function rotNombreSuc(id){
  return (rotSucs.find(s => s.id === Number(id)) || {}).nombre || `Suc. ${id}`;
}

// Pesables con un decimal (son kilos); el resto en unidades enteras.
const rotCant = (n, pesable) => pesable ? rotDec(n) : rotNum(n);

function rotValor(r, key){
  if (key === 'nombre') return r.nombre;
  if (key === 'unidades') return r.unidades;
  return r.puntaje;
}

// Primer clic en una columna numérica ordena de más a menos; de nuevo sobre la misma, invierte.
function rotOrdenar(key){
  rot = { ...rot, desc: rot.key === key ? !rot.desc : key !== 'nombre', key };
  rotTabla();
}

function rotBuscar(texto){
  rot = { ...rot, filtro: texto };
  rotTabla();
}

// Búsqueda y orden vigentes. Lo usan la tabla y el Excel: se descarga lo que se ve.
function rotFilas(){
  const terminos = rotNorm(rot.filtro).split(/\s+/).filter(Boolean);
  const signo = rot.desc ? -1 : 1;
  return rot.rows
    .filter(r => terminos.every(t => rotNorm(r.nombre).includes(t)))
    .sort((a, b) => signo * rotCmp(rotValor(a, rot.key), rotValor(b, rot.key)));
}

function rotTh(key, etiqueta, clase){
  const activa = rot.key === key;
  const flecha = activa ? (rot.desc ? ' ▼' : ' ▲') : '';
  return `<th class="${clase}" data-orden="${key}">${escHtml(etiqueta)}${flecha}</th>`;
}

// Verde del theme (--verde, #405936) con más opacidad cuanto más alto el valor (0..1). El
// piso hace que hasta lo más bajo se distinga del blanco de una celda vacía.
const rotVerde = valor => `rgba(64,89,54,${(0.08 + 0.55 * valor).toFixed(2)})`;

function rotPill(puntaje){
  const v = (puntaje || 0) / 100;
  const texto = v > 0.55 ? '#fff' : 'var(--verde-dark)';
  return `<span class="rot-pill" style="background:${rotVerde(v)};color:${texto}">${rotNum(puntaje)}</span>`;
}

function rotCelda(c, pesable){
  if (!c || !c.unidades) return '<td class="rot-sin-dato">—</td>';
  const titulo = `Facturación: ${rotMoney(c.facturacion)}\nParticipación: ${rotDec(c.participacion * 100)}% de lo que factura la sucursal`;
  return `<td style="background:${rotVerde(c.intensidad)}" title="${escHtml(titulo)}">${rotCant(c.unidades, pesable)}</td>`;
}

function rotTabla(){
  const el = rotEl('rotTabla');
  if (rot.sucursales.length < 2){
    el.innerHTML = '<div class="rot-vacio">Tildá al menos 2 sucursales para comparar.</div>';
    return;
  }
  const filas = rotFilas();
  if (!filas.length){
    el.innerHTML = `<div class="rot-vacio">${rot.filtro ? 'Ningún producto coincide con la búsqueda.' : 'No hay productos con ventas suficientes en el rango.'}</div>`;
    return;
  }
  const cuerpo = filas.map((r, i) => `<tr>
      <td>${rotNum(i + 1)}</td>
      <td class="l nombre">${escHtml(r.nombre)}</td>
      <td>${rotPill(r.puntaje)}</td>
      <td class="l">${escHtml(rotNombreSuc(r.masVende.suc))} <span class="rot-porc">${rotNum(r.masVende.porc)}%</span></td>
      <td>${rotCant(r.unidades, r.pesable)}</td>
      ${rot.sucursales.map(s => rotCelda(r.porSucursal[s], r.pesable)).join('')}
    </tr>`).join('');
  el.innerHTML = `<table><thead><tr>
      <th>#</th>
      ${rotTh('nombre', 'Producto', 'l')}
      ${rotTh('puntaje', 'Puntaje', '')}
      <th class="l">Se vende más en</th>
      ${rotTh('unidades', 'Unidades', '')}
      ${rot.sucursales.map(s => `<th>${escHtml(rotNombreSuc(s))}</th>`).join('')}
    </tr></thead><tbody>${cuerpo}</tbody></table>`;
}

// Números sin formatear para que Excel pueda sumarlos.
function rotExportar(){
  const filas = rotFilas();
  if (!filas.length){ apdAvisar('No hay productos para exportar con la búsqueda actual.'); return; }
  const encabezado = ['Producto', 'Rubro', 'Puntaje', 'Se vende más en',
    ...rot.sucursales.map(s => `${rotNombreSuc(s)} unidades`)];
  const cuerpo = filas.map(r => [
    r.nombre, r.rubro, r.puntaje ?? '', rotNombreSuc(r.masVende.suc),
    ...rot.sucursales.map(s => (r.porSucursal[s] || {}).unidades || 0),
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([encabezado, ...cuerpo]), 'Rotación');
  XLSX.writeFile(wb, `rotacion_${rotRango.desde}_${rotRango.hasta}.xlsx`);
}
