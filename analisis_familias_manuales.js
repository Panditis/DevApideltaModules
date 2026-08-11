// Pestaña "Familias" del módulo de Análisis de Ventas: grupos de productos que arma el
// usuario a mano y la comparación de lo que vende cada grupo en cada sucursal.
//
// Se carga ANTES que analisis_front.js: ese archivo registra la pestaña en PANELES
// apuntando a las funciones de acá y corre su init() al final, así que lo de acá tiene que
// estar definido primero. Reusa los helpers globales del front ($, fmtMoney, tabla,
// charts, destroyChart, SUCURSALES, consultar).

// Un color por sucursal, estable entre gráficos: la barra de Urquiza siempre es del mismo
// verde. Escala del verde Apidelta al amarillo, que es la paleta del módulo.
const PALETA_SUC = ['#405936', '#4E6B43', '#6DA340', '#8FB53C', '#B7BE33', '#E0AE12', '#C98A00'];

// Definición viva de las familias (lo que se está editando en pantalla) y última respuesta
// del endpoint, para poder repintar al cambiar de métrica sin volver a consultar.
let famDef = [];
let famDatos = null;
let famMetrica = 'facturacion';
// Modo de las ventas de promoción: todas (venta normal + promo), sin (sólo mostrador) o
// solo (nada más las promos). Lo lee PANELES.familiasManuales.url al armar la consulta.
let famPromo = 'todas';
const MODOS_PROMO_UI = [
  { valor: 'todas', label: 'Todas' },
  { valor: 'sin', label: 'Sin promo' },
  { valor: 'solo', label: 'Solo promo' },
];
let famFiltro = '';
// Familia que mira el gráfico de productos. Vacío = la primera de la lista.
let famFamiliaDet = '';
let famEditorListo = false;

const famColorSuc = idx => PALETA_SUC[idx % PALETA_SUC.length];
const nombreSuc = id => (SUCURSALES.find(s => s.id === id) || {}).nombre || `Suc ${id}`;
const famValor = celda => Number((celda || {})[famMetrica] || 0);
const famFmt = v => (famMetrica === 'facturacion' ? fmtMoney(v) : fmtCant(v));

// ── Editor de familias ───────────────────────────────────────────────────────

function pintarEditor(){
  const cont = $('famEditor');
  if (!famDef.length){
    cont.innerHTML = '<div class="empty">Todavía no hay familias. Creá la primera arriba.</div>';
    return;
  }
  cont.innerHTML = famDef.map((f, i) => `
    <div class="fam-item">
      <div class="fam-item-head">
        <strong>${escHtml(f.nombre)}</strong>
        <span class="mini">${f.productos.length} producto${f.productos.length === 1 ? '' : 's'}</span>
        <span class="link-mini" onclick="famRenombrar(${i})">renombrar</span>
        <span class="link-mini" onclick="famBorrar(${i})">eliminar</span>
      </div>
      <div class="chips">${f.productos.map((p, j) => `
        <span class="chip">${escHtml(p.nombre || p.id)} <b class="fam-x"
          title="Quitar de la familia" onclick="famQuitarProducto(${i},${j})">×</b></span>`).join('')
        || '<span class="mini">Sin productos asignados.</span>'}</div>
      <div class="fam-buscador">
        <input type="search" class="buscador" placeholder="Buscar producto para agregar..."
          autocomplete="off" oninput="famBuscar(${i}, this.value)">
        <div class="fam-resultados" id="famRes-${i}"></div>
      </div>
    </div>`).join('');
}

function famCrear(){
  const input = $('famNueva');
  const nombre = input.value.trim();
  if (!nombre) return;
  if (famDef.some(f => f.nombre.toLowerCase() === nombre.toLowerCase())){
    famAviso('Ya existe una familia con ese nombre.');
    return;
  }
  famDef = [...famDef, { nombre, productos: [] }];
  input.value = '';
  pintarEditor();
  famAviso('');
}

function famRenombrar(i){
  const nombre = (prompt('Nuevo nombre de la familia:', famDef[i].nombre) || '').trim();
  if (!nombre) return;
  famDef = famDef.map((f, k) => (k === i ? { ...f, nombre } : f));
  pintarEditor();
}

function famBorrar(i){
  if (!confirm(`¿Eliminar la familia "${famDef[i].nombre}"?`)) return;
  famDef = famDef.filter((_f, k) => k !== i);
  pintarEditor();
}

function famQuitarProducto(i, j){
  famDef = famDef.map((f, k) => (k === i ? { ...f, productos: f.productos.filter((_p, m) => m !== j) } : f));
  pintarEditor();
}

function famAgregarProducto(i, prod){
  if (famDef[i].productos.some(p => p.id === prod.id)) return;
  famDef = famDef.map((f, k) => (k === i ? { ...f, productos: [...f.productos, prod] } : f));
  pintarEditor();
}

// Busca en SIGA con el mismo endpoint que el resto del sistema (mínimo 2 caracteres).
// Cada tecleo incrementa el contador: la respuesta vieja que llega tarde no puede pisar
// la lista de la búsqueda nueva.
let famBusquedaSeq = 0;
async function famBuscar(i, q){
  const caja = $(`famRes-${i}`);
  if (!caja) return;
  const seq = ++famBusquedaSeq;
  if (q.trim().length < 2){ caja.innerHTML = ''; return; }
  try {
    const r = await fetch(`/api/productos/buscar?q=${encodeURIComponent(q.trim())}`);
    const prods = await r.json();
    if (seq !== famBusquedaSeq) return;
    caja.innerHTML = (prods || []).map(p => {
      const dato = escHtml(JSON.stringify({ id: String(p.codigo), nombre: p.nombre || '' }));
      return `<div class="fam-res" onclick="famAgregarProducto(${i}, JSON.parse(this.dataset.prod))"
        data-prod="${dato}"><span class="mini">${escHtml(p.codigo)}</span> ${escHtml(p.nombre)}</div>`;
    }).join('') || '<div class="mini">Sin resultados.</div>';
  } catch(e){
    if (seq === famBusquedaSeq) caja.innerHTML = `<div class="error">Error buscando: ${escHtml(e.message)}</div>`;
  }
}

function famAviso(txt){
  $('famAviso').innerHTML = txt ? `<div class="error">${escHtml(txt)}</div>` : '';
}

// Guarda la lista entera y vuelve a consultar: cambió qué se agrupa, así que los números
// en pantalla dejaron de corresponder a lo que se está viendo.
async function famGuardar(){
  const btn = $('famGuardar');
  btn.disabled = true; btn.textContent = 'Guardando...';
  try {
    const r = await fetch('/api/familias-manuales', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(famDef),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    famDef = d;
    pintarEditor();
    famAviso('');
    consultar();
  } catch(e){
    famAviso(`No se pudo guardar: ${e.message}`);
  } finally {
    btn.disabled = false; btn.textContent = 'Guardar familias';
  }
}

async function famCargarDefinicion(){
  try {
    const r = await fetch('/api/familias-manuales');
    const d = await r.json();
    famDef = Array.isArray(d) ? d : [];
  } catch(e){
    famDef = [];
    famAviso(`No se pudo leer las familias: ${e.message}`);
  }
  pintarEditor();
}

// Cambiar el modo de promo cambia la consulta (el filtro es del WHERE, no del render), así
// que invalida el cacheado de la pestaña y vuelve a pedir. La métrica, en cambio, sólo
// repinta: los dos valores ya vinieron en la misma respuesta.
function famSetPromo(valor){
  if (famPromo === valor) return;
  famPromo = valor;
  famPintarChipsPromo();
  cargado.familiasManuales = '';
  consultar();
}

function famPintarChipsPromo(){
  const wrap = $('famPromo');
  wrap.innerHTML = '';
  MODOS_PROMO_UI.forEach(m => {
    const c = document.createElement('span');
    c.className = 'chip' + (famPromo === m.valor ? ' active' : '');
    c.textContent = m.label;
    c.onclick = () => famSetPromo(m.valor);
    wrap.appendChild(c);
  });
}

function famInitEditor(){
  if (famEditorListo) return;
  famEditorListo = true;
  $('famCrear').onclick = famCrear;
  $('famNueva').onkeydown = e => { if (e.key === 'Enter') famCrear(); };
  $('famGuardar').onclick = famGuardar;
  $('famMetrica').onchange = e => { famMetrica = e.target.value; famPintarDatos(); };
  $('famFamiliaDet').onchange = e => { famFamiliaDet = e.target.value; famPintarDatos(); };
  famPintarChipsPromo();
  famCargarDefinicion();
}

// ── Gráfico y tabla ──────────────────────────────────────────────────────────

// Barras agrupadas: una barra por sucursal dentro de cada familia. Comparar sucursales
// dentro de la familia es la pregunta del tablero, y agrupado así quedan una al lado de la
// otra en vez de repartidas por el eje.
function famRenderGrafico(familias, sucursales){
  destroyChart('fam-manual');
  charts['fam-manual'] = new Chart($('chFamManual'), {
    type: 'bar',
    data: {
      labels: familias.map(f => f.nombre),
      datasets: sucursales.map((id, i) => ({
        label: nombreSuc(id),
        data: familias.map(f => famValor(f.porSucursal[id])),
        backgroundColor: famColorSuc(i),
      })),
    },
    options: {
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${famFmt(c.parsed.y)}` } },
      },
      scales: { y: { ticks: { callback: v => famFmt(v) } } },
    },
  });
}

function famRenderTabla(familias, sucursales, porSucursal){
  if (!familias.length){
    $('tblFamManual').innerHTML = '<div class="empty">Sin familias para mostrar.</div>';
    return;
  }
  const head = '<tr><th>Familia</th>'
    + sucursales.map(id => `<th class="num">${escHtml(nombreSuc(id))}</th>`).join('')
    + '<th class="num">Total</th></tr>';
  const body = familias.map(f => '<tr>'
    + `<td>${escHtml(f.nombre)} <span class="mini">(${f.productos.length})</span></td>`
    + sucursales.map(id => `<td class="num">${famFmt(famValor(f.porSucursal[id]))}</td>`).join('')
    + `<td class="num"><b>${famFmt(famValor(f.total))}</b></td></tr>`).join('');
  // Fila de cierre: el total por sucursal de todas las familias juntas. Sale del endpoint
  // (no de las filas visibles) porque el buscador puede estar filtrando la tabla.
  const totalGeneral = porSucursal.reduce((a, s) => a + Number(s[famMetrica] || 0), 0);
  const pie = '<tr><td><b>Total (todas las familias)</b></td>'
    + sucursales.map(id => {
      const s = porSucursal.find(x => x.idSucursal === id) || {};
      return `<td class="num"><b>${famFmt(Number(s[famMetrica] || 0))}</b></td>`;
    }).join('')
    + `<td class="num"><b>${famFmt(totalGeneral)}</b></td></tr>`;
  $('tblFamManual').innerHTML = `<table><thead>${head}</thead><tbody>${body}${pie}</tbody></table>`;
}

// ── Productos por sucursal ───────────────────────────────────────────────────
// Un nivel más abajo que el gráfico de familias: dentro de la familia elegida, qué vende
// cada código en cada sucursal. Es lo que contesta "esta familia vende poco en Pergamino,
// ¿por cuál de sus productos?".

// El desplegable se rearma con las familias que hay, conservando la elegida si sigue
// existiendo. Vacío = la primera (la de mayor facturación, que es como vienen ordenadas).
function famPintarSelectorDetalle(familias){
  const sel = $('famFamiliaDet');
  if (!familias.some(f => f.nombre === famFamiliaDet)) famFamiliaDet = (familias[0] || {}).nombre || '';
  sel.innerHTML = familias.map(f =>
    `<option value="${escHtml(f.nombre)}"${f.nombre === famFamiliaDet ? ' selected' : ''}>${escHtml(f.nombre)}</option>`
  ).join('');
  sel.disabled = !familias.length;
}

function famRenderProductos(familias, sucursales){
  famPintarSelectorDetalle(familias);
  const familia = familias.find(f => f.nombre === famFamiliaDet);
  // Un producto sin ventas en el rango no aporta ninguna barra: ensucia el eje y no dice
  // nada que la tabla de la familia no diga ya.
  const productos = (familia ? familia.productos : []).filter(p => p.facturacion || p.unidades);
  destroyChart('prod-suc');
  if (!productos.length){
    $('tblProdSuc').innerHTML = '<div class="empty">La familia no registra ventas en el rango.</div>';
    return;
  }
  charts['prod-suc'] = new Chart($('chProdSuc'), {
    type: 'bar',
    data: {
      labels: productos.map(p => p.nombre || p.id),
      datasets: sucursales.map((id, i) => ({
        label: nombreSuc(id),
        data: productos.map(p => famValor(p.porSucursal[id])),
        backgroundColor: famColorSuc(i),
      })),
    },
    options: {
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${famFmt(c.parsed.y)}` } },
      },
      scales: { y: { ticks: { callback: v => famFmt(v) } } },
    },
  });
  famRenderTablaProductos(productos, sucursales);
}

// Las dos métricas juntas en cada celda: el gráfico muestra una por vez, pero la pregunta
// "cuánto facturó y cuántas unidades movió" se contesta de una sola mirada acá.
function famCelda(c){
  const celda = c || {};
  return `${fmtMoney(celda.facturacion || 0)}<span class="pct">${fmtCant(celda.unidades || 0)} u</span>`;
}

function famRenderTablaProductos(productos, sucursales){
  const head = '<tr><th>Producto</th><th>Código</th>'
    + sucursales.map(id => `<th class="num">${escHtml(nombreSuc(id))}</th>`).join('')
    + '<th class="num">Total</th></tr>';
  const body = productos.map(p => '<tr>'
    + `<td>${escHtml(p.nombre || p.id)}</td><td>${escHtml(p.id)}</td>`
    + sucursales.map(id => `<td class="num">${famCelda(p.porSucursal[id])}</td>`).join('')
    + `<td class="num"><b>${famCelda(p)}</b></td></tr>`).join('');
  $('tblProdSuc').innerHTML = `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function famRenderKpis(d, familias){
  const sinProductos = famDef.filter(f => !f.productos.length).length;
  const tarjetas = [
    ['Facturación', fmtMoney(d.totales.facturacion)],
    ['Unidades', fmtCant(d.totales.unidades)],
    ['Familias', fmtNum(familias.length)],
    ['Productos agrupados', fmtNum(d.totales.productos)],
  ];
  // Sólo aparece cuando hay algo que avisar: una familia sin códigos no sale en el gráfico.
  if (sinProductos) tarjetas.push(['Familias sin productos', fmtNum(sinProductos)]);
  $('kpis-fmn').innerHTML = tarjetas
    .map(([lbl, val]) => `<div class="kpi"><div class="lbl">${lbl}</div><div class="val">${val}</div></div>`)
    .join('');
}

// Repinta con lo último que trajo el endpoint: lo llaman el cambio de métrica y el
// buscador, que no necesitan volver al servidor.
function famPintarDatos(){
  if (!famDatos) return;
  const filtro = normalizarBusqueda(famFiltro);
  const familias = filtro
    ? famDatos.familias.filter(f => normalizarBusqueda(f.nombre).includes(filtro))
    : famDatos.familias;
  famRenderKpis(famDatos, familias);
  famRenderGrafico(familias, famDatos.sucursales);
  famRenderTabla(familias, famDatos.sucursales, famDatos.porSucursal);
  famRenderProductos(familias, famDatos.sucursales);
}

// Entrada desde PANELES: llega la respuesta del endpoint y, la primera vez, se engancha
// el editor (que carga su definición aparte, porque no depende del rango de fechas).
function famPintar(d){
  famDatos = d;
  famInitEditor();
  famPintarDatos();
}

function famBuscarEnLista(txt){
  famFiltro = txt;
  famPintarDatos();
}
