// Front del módulo de Análisis de Ventas. Una sola página con dos pestañas —Sucursales y
// Casa Central— que antes eran analisis_ventas.html y analisis_central.html: los KPIs, la
// tendencia, el top de productos y las familias se renderizaban dos veces con el mismo
// código. Acá viven una sola vez y cada pestaña sólo aporta lo suyo (la comparativa y los
// artículos por ticket en sucursales; el top de clientes en la central).
//
// Cada panel tiene sus propios nodos, sufijados con el prefijo de la pestaña (-suc / -cen),
// para que ambos puedan estar montados a la vez sin pisarse los ids.

// ── Constantes ───────────────────────────────────────────────────────────────
// Sucursales fijas del módulo (id -> nombre). La central (1) no se incluye: tiene su propia
// pestaña, con exclusiones que no aplican al resto (productos que no son venta real y el
// rubro de apicultura).
const SUCURSALES = [
  {id:2,nombre:'Urquiza'},{id:3,nombre:'Nación'},{id:4,nombre:'Chacabuco'},
  {id:5,nombre:'Rivadavia'},{id:7,nombre:'San Pedro'},{id:9,nombre:'Villa Ramallo'},
  {id:10,nombre:'Pergamino'},
];
const GREEN = '#405936', YELLOW = '#C98A00', MID = '#4E6B43';
// Rumbo de la línea de tendencia: verde sube, rojo baja, gris cuando queda plana.
const GREEN_UP = '#2E7D32', RED_DOWN = '#b3261e', MUTED = '#6B6B6B';
// Paleta de la torta de artículos/ticket: el primer bucket (1-3, los tickets más chicos)
// va en rojo porque es el que se quiere reducir; el resto escala de verde a amarillo a
// medida que crece el carrito.
const PALETA_ART = ['#C62828', '#2E7D32', '#6DA340', '#B7BE33', '#F2C200'];

const $ = id => document.getElementById(id);
const fmtMoney = n => '$' + Math.round(n).toLocaleString('es-AR');
const fmtNum   = n => Math.round(n).toLocaleString('es-AR');
const fmtDec   = n => Number(n || 0).toLocaleString('es-AR', {minimumFractionDigits:1, maximumFractionDigits:1});
// Cantidad vendida tal cual viene del renglón. No se redondea: lo que se vende por peso
// tiene decimales (3,5 kg de mix es 3,5, no 4) y fmtNum los perdía.
const fmtCant  = n => Number(n || 0).toLocaleString('es-AR', {maximumFractionDigits:3});

function escHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

// Búsqueda sin acentos ni mayúsculas y por términos sueltos: "miel 500" encuentra
// "MIEL PURA 500G" aunque las palabras no estén pegadas.
function normalizarBusqueda(s){
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

const charts = {};
function destroyChart(key){ if (charts[key]) { charts[key].destroy(); delete charts[key]; } }

function firstOfMonth(){ const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); }

function initFechas(){
  $('desde').value = firstOfMonth().toISOString().slice(0,10);
  $('hasta').value = new Date().toISOString().slice(0,10);
}

// ── Tabla ordenable genérica (artículos por sucursal) ────────────────────────
// Estado por tabla (elId): qué columna ordena y en qué sentido. Los datos y las columnas
// se guardan acá para poder repintar sin volver a consultar el endpoint.
const orden = {};

// Cada consulta nueva reinicia el orden al criterio inicial: los datos cambiaron, mantener
// el orden anterior confundiría más de lo que ayuda.
function tablaOrdenable(elId, headers, rows, inicial){
  orden[elId] = {
    headers, rows,
    key: (inicial && inicial.key) || headers[0].key,
    asc: !!(inicial && inicial.asc),
  };
  pintarOrdenable(elId);
}

function pintarOrdenable(elId){
  const st = orden[elId];
  if (!st) return;
  if (!st.rows.length){ $(elId).innerHTML = '<div class="empty">Sin datos en el rango.</div>'; return; }
  const filas = [...st.rows].sort((a, b) => cmpValores(a[st.key], b[st.key]) * (st.asc ? 1 : -1));
  const head = '<tr>' + st.headers.map(h => {
    const flecha = h.key === st.key ? (st.asc ? ' ▲' : ' ▼') : '';
    return `<th class="orden ${h.num?'num':''}" onclick="ordenarPor('${elId}','${h.key}')">${h.label}${flecha}</th>`;
  }).join('') + '</tr>';
  const body = filas.map(r => '<tr>' + st.headers.map(h =>
    `<td class="${h.num?'num':''}">${h.fmt ? h.fmt(r[h.key]) : escHtml(r[h.key])}</td>`
  ).join('') + '</tr>').join('');
  $(elId).innerHTML = `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

// Los textos se comparan con localeCompare (acentos) y los números como números; el
// primer clic sobre una columna nueva ordena descendente si es numérica.
function cmpValores(a, b){
  const na = typeof a === 'number', nb = typeof b === 'number';
  if (na && nb) return a - b;
  return String(a ?? '').localeCompare(String(b ?? ''), 'es', { numeric:true, sensitivity:'base' });
}

function ordenarPor(elId, key){
  const st = orden[elId];
  if (!st) return;
  if (st.key === key) st.asc = !st.asc;
  else { st.key = key; st.asc = typeof (st.rows[0] || {})[key] !== 'number'; }
  pintarOrdenable(elId);
}

function tabla(headers, rows){
  if (!rows.length) return '<div class="empty">Sin datos en el rango.</div>';
  const head = '<tr>' + headers.map(h => `<th class="${h.num?'num':''}">${h.label}</th>`).join('') + '</tr>';
  const body = rows.map(r => '<tr>' + headers.map(h =>
    `<td class="${h.num?'num':''}">${h.fmt ? h.fmt(r[h.key]) : escHtml(r[h.key])}</td>`
  ).join('') + '</tr>').join('');
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

// ── KPIs ─────────────────────────────────────────────────────────────────────
// Artículos/ticket sólo lo calcula el endpoint de sucursales, así que la tarjeta se agrega
// nada más cuando viene el dato: en la central no existe y un "0,0" se leería como un dato.
function renderKpis(k, pref){
  const tarjetas = [
    ['Facturación', fmtMoney(k.facturacion)],
    ['Tickets', fmtNum(k.tickets)],
    ['Ticket promedio', fmtMoney(k.ticketProm)],
  ];
  if (k.articulosProm !== undefined) tarjetas.push(['Artículos/ticket', fmtDec(k.articulosProm)]);
  $(`kpis-${pref}`).innerHTML = tarjetas
    .map(([lbl,val]) => `<div class="kpi"><div class="lbl">${lbl}</div><div class="val">${val}</div></div>`)
    .join('');
}

// ── Top productos: lista completa, ordenable, paginada y con buscador ────────
// El endpoint manda todos los productos del rango (no un top acotado), así que ordenar,
// filtrar y paginar se resuelve en memoria: sin viajes extra al servidor. Cada pestaña
// declara sus columnas: los quiebres sólo existen en sucursales, donde se sigue el stock.
const FILAS_POR_PAGINA = 25;

// El backend manda quiebres en null cuando el filtro tiene más de una sucursal: el cálculo
// reconstruye la serie diaria de stock y con varias sucursales tarda demasiado. Un "—" con
// la explicación es más honesto que un 0, que se leería como "no tuvo faltantes".
const AVISO_QUIEBRES = 'Los quiebres se calculan sólo con una sucursal seleccionada: reconstruir el stock día por día de varias sucursales hace muy lenta la consulta.';
const TITULO_QUIEBRES = `Días del rango que arrancaron con stock en el umbral o por debajo y no recibieron mercadería. No cuentan los domingos ni los días con reposición. Umbral: pesables 5% de la venta mensual; el resto, ese 5% con tope de 4 unidades. ${AVISO_QUIEBRES}`;

function celdaQuiebre(r){
  if (r.quiebres === null || r.quiebres === undefined){
    return `<td class="num sin-dato" title="${AVISO_QUIEBRES}">—</td>`;
  }
  const titulo = `${fmtNum(r.quiebres)} de ${fmtNum(r.quiebresBase || 0)} días evaluados (sin domingos)`;
  return `<td class="num ${r.quiebres ? 'quiebre' : ''}" title="${titulo}">${fmtNum(r.quiebres)}<span class="pct">${fmtDec(r.quiebresPorc || 0)}%</span></td>`;
}

// El nombre ordena alfabético (con locale es-AR, para que los acentos no queden al final);
// las columnas numéricas, por valor.
const COLUMNAS_TOP = {
  nombre:      { etiqueta:'Producto',    texto:true,  celda: r => `<td>${escHtml(r.nombre)}</td>` },
  facturacion: { etiqueta:'Facturación', clase:'num', celda: r => `<td class="num">${fmtMoney(r.facturacion)}</td>` },
  unidades:    { etiqueta:'Unid.',       clase:'num', celda: r => `<td class="num">${fmtNum(r.unidades)}</td>` },
  quiebres:    { etiqueta:'Quiebres',    clase:'num', titulo: TITULO_QUIEBRES, celda: celdaQuiebre },
};
const COLUMNAS_POR_PANEL = {
  suc: ['nombre', 'facturacion', 'unidades', 'quiebres'],
  cen: ['nombre', 'unidades', 'facturacion'],
  api: ['nombre', 'unidades', 'facturacion'],
};
const tops = {};

// El puesto se numera sobre la lista completa ya ordenada por la columna elegida, así al
// filtrar se sigue viendo en qué posición de ese ranking está cada producto.
function ordenarFilas(rows, criterio, desc){
  const esTexto = COLUMNAS_TOP[criterio] && COLUMNAS_TOP[criterio].texto;
  const signo = desc ? -1 : 1;
  return [...(rows || [])]
    .sort((a, b) => signo * (esTexto
      ? String(a[criterio] || '').localeCompare(String(b[criterio] || ''), 'es-AR')
      : (Number(a[criterio]) || 0) - (Number(b[criterio]) || 0)))
    .map((r, i) => ({ ...r, puesto: i + 1 }));
}

// Filtros de quiebres y rubro: sólo existen en sucursales (los selects están en el HTML de esa
// pestaña). Se leen del DOM al filtrar; sin select, no filtran. Un quiebre en null (varias
// sucursales, no se calculó) no entra ni en "sin" ni en "con": no se sabe.
function valorFiltro(id){
  const el = $(id);
  return el ? el.value : '';
}

function filasTop(pref){
  const st = tops[pref];
  const terminos = normalizarBusqueda(st.filtro).split(/\s+/).filter(Boolean);
  const quiebre = valorFiltro(`filtQuiebre-${pref}`);
  const rubro = valorFiltro(`filtRubro-${pref}`);
  return st.rows.filter(r => {
    if (quiebre === 'sin' && r.quiebres !== 0) return false;
    if (quiebre === 'con' && !(r.quiebres > 0)) return false;
    if (rubro && (r.rubro || '') !== rubro) return false;
    const nombre = normalizarBusqueda(r.nombre);
    return terminos.every(t => nombre.includes(t));
  });
}

// Opciones del select de rubro armadas con los rubros que trajo la consulta. Conserva la
// elección si el rubro sigue presente; si no, vuelve a "Todos".
function llenarRubros(pref, rows){
  const el = $(`filtRubro-${pref}`);
  if (!el) return;
  const previo = el.value;
  const rubros = [...new Set((rows || []).map(r => r.rubro).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'es-AR'));
  el.innerHTML = '<option value="">Todos los rubros</option>' + rubros
    .map(r => `<option value="${escHtml(r)}">${escHtml(r)}</option>`).join('');
  el.value = rubros.includes(previo) ? previo : '';
}

function renderTop(rows, pref){
  // Arranca por facturación descendente, que es el ranking que se espera ver de entrada; si
  // el usuario ya había elegido otra columna, la consulta nueva la respeta.
  const st = tops[pref];
  const criterio = st ? st.criterio : 'facturacion';
  const desc = st ? st.desc : true;
  tops[pref] = { origen: rows || [], rows: ordenarFilas(rows, criterio, desc), filtro:'', pagina:1, criterio, desc };
  $(`buscTop-${pref}`).value = '';
  llenarRubros(pref, rows);
  pintarTop(pref);
}

// Clic en un header: la primera vez ordena por esa columna (descendente en las numéricas,
// A→Z en el nombre); clic de nuevo sobre la misma, invierte. No vuelve a pedir datos ni
// pierde la búsqueda escrita, y devuelve a la página 1, que es donde está lo que se buscó.
function ordenarTop(pref, criterio){
  const st = tops[pref];
  if (!st || !COLUMNAS_TOP[criterio]) return;
  st.desc = st.criterio === criterio ? !st.desc : !COLUMNAS_TOP[criterio].texto;
  st.criterio = criterio;
  st.rows = ordenarFilas(st.origen, criterio, st.desc);
  st.pagina = 1;
  pintarTop(pref);
}

// Header clickeable con la flecha sólo en la columna activa: si todas la tuvieran, no se
// distinguiría cuál manda.
function thOrdenable(st, pref, clave){
  const col = COLUMNAS_TOP[clave];
  const activa = st.criterio === clave;
  const flecha = activa ? (st.desc ? ' ▼' : ' ▲') : '';
  const clases = ['orden', col.clase, activa ? 'activa' : ''].filter(Boolean).join(' ');
  const titulo = col.titulo || `Ordenar por ${col.etiqueta.toLowerCase()}`;
  return `<th class="${clases}" onclick="ordenarTop('${pref}','${clave}')"
    title="${escHtml(titulo)}">${col.etiqueta}${flecha}</th>`;
}

function pintarTop(pref){
  const st = tops[pref];
  const columnas = COLUMNAS_POR_PANEL[pref];
  const pagerEl = $(`pagTop-${pref}`);
  const filas = filasTop(pref);
  if (!filas.length){
    const filtrando = st.filtro || valorFiltro(`filtQuiebre-${pref}`) || valorFiltro(`filtRubro-${pref}`);
    $(`tblTop-${pref}`).innerHTML = `<div class="empty">${filtrando ? 'Ningún producto coincide con los filtros.' : 'Sin datos en el rango.'}</div>`;
    pagerEl.innerHTML = '';
    return;
  }
  const paginas = Math.ceil(filas.length / FILAS_POR_PAGINA);
  // La página se acota acá: filtrar puede dejar menos páginas que la que estaba abierta.
  st.pagina = Math.min(Math.max(1, st.pagina), paginas);
  const desde = (st.pagina - 1) * FILAS_POR_PAGINA;
  const visibles = filas.slice(desde, desde + FILAS_POR_PAGINA);
  const cuerpo = visibles.map(r =>
    `<tr><td class="num">${fmtNum(r.puesto)}</td>${columnas.map(c => COLUMNAS_TOP[c].celda(r)).join('')}</tr>`
  ).join('');
  $(`tblTop-${pref}`).innerHTML = `<table><thead><tr>
      <th class="num">#</th>
      ${columnas.map(c => thOrdenable(st, pref, c)).join('')}
    </tr></thead><tbody>${cuerpo}</tbody></table>`;
  const primera = st.pagina === 1, ultima = st.pagina === paginas;
  pagerEl.innerHTML = `<div class="pager">
      <span>${fmtNum(desde + 1)}–${fmtNum(desde + visibles.length)} de ${fmtNum(filas.length)} productos</span>
      <span class="pg-btns">
        <button onclick="irPaginaTop('${pref}',1)" ${primera ? 'disabled' : ''} title="Primera">«</button>
        <button onclick="irPaginaTop('${pref}',${st.pagina - 1})" ${primera ? 'disabled' : ''}>‹ Anterior</button>
        <span>Pág. ${fmtNum(st.pagina)} de ${fmtNum(paginas)}</span>
        <button onclick="irPaginaTop('${pref}',${st.pagina + 1})" ${ultima ? 'disabled' : ''}>Siguiente ›</button>
        <button onclick="irPaginaTop('${pref}',${paginas})" ${ultima ? 'disabled' : ''} title="Última">»</button>
      </span>
    </div>`;
}

function irPaginaTop(pref, n){
  tops[pref].pagina = n;
  pintarTop(pref);
}

// Exporta la lista completa (no sólo la página visible) con los filtros y el orden actuales.
// Números sin formatear para que Excel pueda sumarlos; quiebre sin calcular queda vacío.
function exportarTop(pref){
  const st = tops[pref];
  if (!st) return;
  const filas = filasTop(pref);
  if (!filas.length){ apdAvisar('No hay productos para exportar con los filtros actuales.'); return; }
  const encabezado = ['#', 'Código', 'Producto', 'Rubro', 'Facturación', 'Unidades', 'Quiebres (días)', 'Días evaluados', 'Quiebres %'];
  const vacioSiNull = v => (v === null || v === undefined ? '' : v);
  const cuerpo = filas.map(r => [
    r.puesto, r.idProd, r.nombre, r.rubro || '', r.facturacion, r.unidades,
    vacioSiNull(r.quiebres), vacioSiNull(r.quiebresBase), vacioSiNull(r.quiebresPorc),
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([encabezado, ...cuerpo]), 'Top productos');
  const rango = `${$('desde').value || ''}_${$('hasta').value || ''}`;
  XLSX.writeFile(wb, `top_productos_${rango}.xlsx`);
}

// Cada tecla vuelve a la página 1: filtrar y quedarse en la página 7 mostraría vacío.
function buscarEnTop(pref, texto){
  tops[pref].filtro = texto;
  tops[pref].pagina = 1;
  pintarTop(pref);
}

// ── Familias de producto ─────────────────────────────────────────────────────
// Magnitud real de una familia o presentación. Las unidades no son sumables entre
// presentaciones distintas (2 tambores de 28Kg y 12 frascos de 1Kg no son "14"); los
// kilos sí. Kilos y litros van separados: sumarlos sería la misma mentira de nuevo.
// Kilos que salieron por la familia. El bulto se pesa por su contenido (paquetes × peso
// declarado) y lo que se vende por peso ya viene en kilos: los dos entran al mismo total.
// Los litros van aparte, porque un litro no es un kilo.
function fmtEquivalente(o){
  const partes = [];
  if (o.kilos)  partes.push(fmtDec(o.kilos) + ' kg');
  if (o.litros) partes.push(fmtDec(o.litros) + ' L');
  if (partes.length) return partes.join(' + ');
  if (o.equivalenteAplica === false){
    return '<span title="La familia no tiene productos de Pesables Fraccionado ni de Almacen Bultos/Cajas: la cantidad de sus renglones no es un peso.">—</span>';
  }
  return '—';
}


// El ancho de la barra se escala contra la fila más grande para que se vea; el número que
// se muestra al lado es siempre la participación real sobre el total listado.
function fondoBarra(valor, maximo){
  const corte = (maximo > 0 ? (valor || 0) * 100 / maximo : 0).toFixed(2);
  return `linear-gradient(90deg, var(--barra-ini) 0%, var(--barra-fin) ${corte}%, transparent ${corte}%)`;
}

// Una familia: la fila clickeable con el total, seguida de una fila oculta por presentación.
// El índice `i` es el de la lista completa, no el de la página: así el detalle abierto sigue
// apuntando a su familia aunque se pagine.
function filaFamilia(f, i, pref, totalListado, maxFacturacion){
  // Las presentaciones son filas de ESTA tabla (no una tabla anidada) para que Unidades y
  // Facturación caigan bajo las mismas columnas que la fila de la familia.
  const detalle = f.presentaciones.map(p =>
    `<tr class="fam-det fd-${pref}-${i}" hidden>
      <td class="pres">· ${escHtml(p.nombre)}</td>
      <td></td>
      <td class="num">${fmtEquivalente(p)}</td>
      <td class="num">${fmtCant(p.unidades)}</td>
      <td class="num">${fmtMoney(p.facturacion)}</td>
      <td></td>
    </tr>`
  ).join('');
  const share = totalListado > 0 ? (f.facturacion || 0) * 100 / totalListado : 0;
  // La barra es el fondo de la fila entera (no una celda aparte): así el peso de cada
  // familia se lee de un vistazo sobre el propio registro.
  return `<tr class="fam" style="background-image:${fondoBarra(f.facturacion, maxFacturacion)}"
            onclick="toggleDetalle('fd-${pref}-${i}','cf-${pref}-${i}')"
            title="${fmtDec(share)}% de la facturación listada">
      <td><span class="caret" id="cf-${pref}-${i}">▶</span> ${escHtml(f.familia)}${f.esGrupo ? ' <span class="fam-propia">grupo</span>' : ''}</td>
      <td class="num">${fmtNum(f.presentaciones.length)}</td>
      <td class="num">${fmtEquivalente(f)}</td>
      <td class="num">${fmtCant(f.unidades)}</td>
      <td class="num">${fmtMoney(f.facturacion)}</td>
      <td class="num impacto">${fmtDec(share)}%</td>
    </tr>
    ${detalle}`;
}

function tablaFamilias(cuerpo){
  return `<table><thead><tr>
      <th>Familia</th><th class="num">Present.</th>
      <th class="num" title="Kilos que salieron por la familia. El bulto se vende por paquete cerrado, así que se pesa multiplicando el contenido del nombre por los paquetes vendidos; lo que se vende por peso ya viene en kilos y se suma tal cual. Los litros van aparte. Sólo se calcula en familias con Pesables Fraccionado o Almacen Bultos/Cajas.">Equivalente</th>
      <th class="num" title="Cantidad vendida tal cual la carga el comprobante: paquetes en los bultos y kilos en lo que se vende por peso. Sin conversión ni redondeo.">Unidades</th>
      <th class="num">Facturación</th>
      <th>Impacto s/ listado</th>
    </tr></thead><tbody>${cuerpo}</tbody></table>`;
}

function renderFamilias(rows, pref){
  const fams = rows || [];
  const el = $(`tblFamilias-${pref}`);
  if (!fams.length){ el.innerHTML = '<div class="empty">Sin datos en el rango.</div>'; return; }
  // El 100% es la facturación sumada de las familias listadas, no la del rango completo:
  // así la barra compara cada fila contra lo que el usuario está viendo. Los grupos entran
  // en la base: sus productos ya no aparecen como familia suelta, no hay doble conteo.
  const totalListado = fams.reduce((a, f) => a + (f.facturacion || 0), 0);
  const maxFacturacion = fams.reduce((a, f) => Math.max(a, f.facturacion || 0), 0);
  el.innerHTML = tablaFamilias(
    fams.map((f, i) => filaFamilia(f, i, pref, totalListado, maxFacturacion)).join('')
  );
}

// ── Familias consolidadas: la misma tabla, paginada ──────────────────────────
// Acá vienen TODAS las familias del rango (el endpoint no recorta al top 20), así que la
// tabla se pagina: pintar cientos de familias con su detalle desplegable cuelga la página.
// El porcentaje de impacto y la barra se miden contra el listado completo, no contra la
// página: si no, cada página se leería como si fuera el 100% del negocio.
const FAMILIAS_POR_PAGINA = 20;
let famPag = { origen: [], filtro: '', pagina: 1 };

function renderFamiliasPaginadas(rows){
  famPag = { origen: rows || [], filtro: '', pagina: 1 };
  $('buscTop-fam').value = '';
  pintarFamiliasPag();
}

// Se busca sobre el nombre de familia; el índice original se conserva para que el detalle
// desplegable no se cruce entre filas al filtrar.
function famFiltradas(){
  const terminos = normalizarBusqueda(famPag.filtro).split(/\s+/).filter(Boolean);
  const conIndice = famPag.origen.map((f, i) => ({ f, i }));
  if (!terminos.length) return conIndice;
  return conIndice.filter(({ f }) => {
    const nombre = normalizarBusqueda(f.familia);
    return terminos.every(t => nombre.includes(t));
  });
}

function pintarFamiliasPag(){
  const el = $('tblFamilias-fam'), pagerEl = $('pagTop-fam');
  const filas = famFiltradas();
  if (!filas.length){
    el.innerHTML = `<div class="empty">${famPag.filtro ? 'Ninguna familia coincide con la búsqueda.' : 'Sin datos en el rango.'}</div>`;
    pagerEl.innerHTML = '';
    return;
  }
  const totalListado = famPag.origen.reduce((a, f) => a + (f.facturacion || 0), 0);
  const maxFacturacion = famPag.origen.reduce((a, f) => Math.max(a, f.facturacion || 0), 0);
  const paginas = Math.ceil(filas.length / FAMILIAS_POR_PAGINA);
  famPag = { ...famPag, pagina: Math.min(Math.max(1, famPag.pagina), paginas) };
  const desde = (famPag.pagina - 1) * FAMILIAS_POR_PAGINA;
  const visibles = filas.slice(desde, desde + FAMILIAS_POR_PAGINA);
  el.innerHTML = tablaFamilias(
    visibles.map(({ f, i }) => filaFamilia(f, i, 'fam', totalListado, maxFacturacion)).join('')
  );
  const primera = famPag.pagina === 1, ultima = famPag.pagina === paginas;
  pagerEl.innerHTML = `<div class="pager">
      <span>${fmtNum(desde + 1)}–${fmtNum(desde + visibles.length)} de ${fmtNum(filas.length)} familias</span>
      <span class="pg-btns">
        <button onclick="irPaginaFam(1)" ${primera ? 'disabled' : ''} title="Primera">«</button>
        <button onclick="irPaginaFam(${famPag.pagina - 1})" ${primera ? 'disabled' : ''}>‹ Anterior</button>
        <span>Pág. ${fmtNum(famPag.pagina)} de ${fmtNum(paginas)}</span>
        <button onclick="irPaginaFam(${famPag.pagina + 1})" ${ultima ? 'disabled' : ''}>Siguiente ›</button>
        <button onclick="irPaginaFam(${paginas})" ${ultima ? 'disabled' : ''} title="Última">»</button>
      </span>
    </div>`;
}

function irPaginaFam(n){
  famPag = { ...famPag, pagina: n };
  pintarFamiliasPag();
}

function buscarEnFamilias(texto){
  famPag = { ...famPag, filtro: texto, pagina: 1 };
  pintarFamiliasPag();
}

// Abre o cierra el detalle de una fila (familias y clientes comparten el mecanismo): las
// filas del detalle llevan la clase `clase` y el triángulo vive en el nodo `caretId`.
function toggleDetalle(clase, caretId){
  const filas = document.querySelectorAll(`tr.${clase}`);
  if (!filas.length) return;
  const abrir = filas[0].hidden;
  filas.forEach(f => { f.hidden = !abrir; });
  $(caretId).textContent = abrir ? '▼' : '▶';
}

// ── Top clientes (sólo casa central) ─────────────────────────────────────────
// Cuántas líneas propias le trabaja el cliente. Los kilos/litros equivalentes no servían
// acá: un cliente que compra 200 kg de una sola familia parece más grande que uno que
// trabaja ocho líneas distintas, y para la fuerza de ventas lo que importa es lo segundo.
// El porcentaje de la compra que es marca propia va en el title, como dato de apoyo.
function fmtFamiliasPropias(c){
  const n = c.familiasPropias || 0;
  if (!n) return '<span title="No compró productos de marca propia en el rango.">—</span>';
  const share = c.facturacion > 0 ? (c.facturacionPropia || 0) * 100 / c.facturacion : 0;
  return `<span title="${fmtDec(share)}% de su compra es marca propia (${fmtMoney(c.facturacionPropia || 0)}).">${fmtNum(n)}</span>`;
}

// Mismo patrón que familias: fila clickeable con el total del cliente y, debajo, qué
// compró. Los productos del detalle son filas de esta misma tabla para que las columnas
// queden alineadas con el total de arriba.
function renderClientes(rows, pref = 'cen'){
  const cli = rows || [];
  if (!cli.length){ $(`tblClientes-${pref}`).innerHTML = '<div class="empty">Sin datos en el rango.</div>'; return; }
  const totalListado = cli.reduce((a, c) => a + (c.facturacion || 0), 0);
  const maxFacturacion = cli.reduce((a, c) => Math.max(a, c.facturacion || 0), 0);
  const cuerpo = cli.map((c, i) => {
    // Cada producto del desplegable muestra a qué familia pertenece; la de marca propia va
    // remarcada, porque son las que cuenta el número de la fila del cliente: así el total
    // se audita abriendo el detalle.
    const detalle = c.productos.map(p =>
      `<tr class="cli-det cd-${pref}-${i}${p.propio ? ' propio' : ''}" hidden>
        <td class="pres">· ${escHtml(p.nombre)}${p.propio ? '<span class="badge-propio">Apidelta</span>' : ''}</td>
        <td></td>
        <td class="num fam-cel"><span class="${p.propio ? 'fam-propia' : 'fam-otra'}">${escHtml(p.familia || '—')}</span></td>
        <td class="num">${fmtNum(p.unidades)}</td>
        <td class="num">${fmtMoney(p.facturacion)}</td>
        <td></td>
      </tr>`
    ).join('');
    const share = totalListado > 0 ? (c.facturacion || 0) * 100 / totalListado : 0;
    return `<tr class="fam" style="background-image:${fondoBarra(c.facturacion, maxFacturacion)}"
              onclick="toggleDetalle('cd-${pref}-${i}','cc-${pref}-${i}')"
              title="${fmtDec(share)}% de la facturación listada">
        <td><span class="caret" id="cc-${pref}-${i}">▶</span> ${escHtml(c.cliente)}</td>
        <td class="num">${fmtNum(c.productos.length)}</td>
        <td class="num">${fmtFamiliasPropias(c)}</td>
        <td class="num">${fmtNum(c.unidades)}</td>
        <td class="num">${fmtMoney(c.facturacion)}</td>
        <td class="num impacto">${fmtDec(share)}%</td>
      </tr>
      ${detalle}`;
  }).join('');
  $(`tblClientes-${pref}`).innerHTML = `<table><thead><tr>
      <th>Cliente</th><th class="num">Productos</th>
      <th class="num" title="Familias de marca propia (Apidelta y Pago De Los Arroyos) que le compra el cliente. Las presentaciones de una misma línea cuentan una sola vez.">Familias Apidelta</th>
      <th class="num" title="Suma cruda de unidades. Mezcla formatos distintos, así que sirve como referencia, no como cantidad real.">Unidades</th>
      <th class="num">Facturación</th>
      <th>Impacto s/ listado</th>
    </tr></thead><tbody>${cuerpo}</tbody></table>`;
}

// ── Artículos por ticket (sólo sucursales) ───────────────────────────────────
function renderArticulos(apt){
  const hist = (apt && apt.histograma) || [];
  const totalTickets = hist.reduce((a,r) => a + (r.tickets || 0), 0);
  destroyChart('artHist-suc');
  charts['artHist-suc'] = new Chart($('chArtHist-suc'), {
    type:'pie',
    data:{ labels: hist.map(r=>r.label),
      datasets:[{ label:'Tickets', data: hist.map(r=>r.tickets),
        backgroundColor: PALETA_ART, borderColor:'#fff', borderWidth:2 }] },
    options:{ plugins:{
      // Las etiquetas van dentro de cada porción (pluginPorcentajes), así que la leyenda
      // externa sólo repetiría información y le robaría ancho al gráfico.
      legend:{ display:false },
      tooltip:{ callbacks:{ label: c => {
        const v = c.parsed || 0;
        const pct = totalTickets > 0 ? v * 100 / totalTickets : 0;
        return `${c.label}: ${fmtNum(v)} tickets (${fmtDec(pct)}%)`;
      } } }
    } },
    plugins:[pluginPorcentajes]
  });
  tablaOrdenable('tblArtSuc-suc', [
    {key:'nombre',label:'Sucursal'},
    {key:'tickets',label:'Tickets',num:true,fmt:fmtNum},
    {key:'ticketsDia',label:'Tickets/día',num:true,fmt:fmtDec},
    {key:'articulos',label:'Artículos',num:true,fmt:fmtNum},
    {key:'promedio',label:'Art./ticket',num:true,fmt:fmtDec},
  ], (apt && apt.porSucursal) || [], { key:'promedio', asc:false });
}

// ── Tickets por monto (sólo sucursales) ──────────────────────────────────────
// Bloque con consulta propia: el monto se prueba muchas veces seguidas y correr todo el
// panel por cada intento no tiene sentido. El rango y las sucursales salen del filtro
// principal, así que al Aplicar general este bloque se repinta solo si ya tenía un monto.
const OP_MONTO_TXT = {
  desde: m => `de ${m} o más`,
  hasta: m => `de ${m} o menos`,
  exacto: m => `de exactamente ${m}`,
};

function renderMontos(d){
  const rows = d.porSucursal || [];
  const t = d.totales || { tickets:0, facturacion:0, ticketProm:0, porcTickets:0, porcFacturacion:0 };
  const texto = (OP_MONTO_TXT[d.op] || OP_MONTO_TXT.desde)(fmtMoney(d.monto));
  $('montoResumen').innerHTML = `Tickets ${texto}: <b>${fmtNum(t.tickets)}</b>
    (${fmtDec(t.porcTickets)}% de los ${fmtNum(t.ticketsTotales)} del rango) por
    <b>${fmtMoney(t.facturacion)}</b> (${fmtDec(t.porcFacturacion)}% de la facturación).
    Ticket promedio de ese grupo: <b>${fmtMoney(t.ticketProm)}</b>.`;
  destroyChart('montos-suc');
  charts['montos-suc'] = new Chart($('chMontos-suc'), {
    type:'bar',
    data:{ labels: rows.map(r=>r.nombre), datasets:[
      // Dos ejes: la cantidad de tickets y los pesos no comparten escala, en un solo eje
      // las barras de tickets quedarían pegadas al piso.
      { label:'Tickets', data: rows.map(r=>r.tickets), backgroundColor: GREEN, yAxisID:'y' },
      { label:'Monto total', data: rows.map(r=>r.facturacion), backgroundColor: YELLOW, yAxisID:'y1' },
    ]},
    options:{ plugins:{
      legend:{ display:true, position:'bottom', labels:{ boxWidth:14, font:{ size:11 } } },
      tooltip:{ callbacks:{ label: c => c.dataset.yAxisID === 'y'
        ? `Tickets: ${fmtNum(c.parsed.y)}` : `Monto total: ${fmtMoney(c.parsed.y)}` } } },
      scales:{
        y:{ position:'left', ticks:{ callback:v=>fmtNum(v) } },
        y1:{ position:'right', grid:{ drawOnChartArea:false }, ticks:{ callback:v=>fmtMoney(v) } },
      } }
  });
  tablaOrdenable('tblMontos-suc', [
    {key:'nombre',label:'Sucursal'},
    {key:'tickets',label:'Tickets',num:true,fmt:fmtNum},
    {key:'porcTickets',label:'% de sus tickets',num:true,fmt:v=>`${fmtDec(v)}%`},
    {key:'facturacion',label:'Monto total',num:true,fmt:fmtMoney},
    {key:'porcFacturacion',label:'% de su facturación',num:true,fmt:v=>`${fmtDec(v)}%`},
    {key:'ticketProm',label:'Ticket prom.',num:true,fmt:fmtMoney},
  ], rows, { key:'tickets', asc:false });
}

function limpiarMontos(){
  destroyChart('montos-suc');
  $('montoResumen').innerHTML = '';
  $('tblMontos-suc').innerHTML = '';
}

async function consultarMontos(){
  const msg = $('msgMonto');
  const monto = $('montoValor').value.trim();
  if (monto === '' || !(Number(monto) >= 0)){
    msg.innerHTML = '<div class="error">Ingresá un monto.</div>';
    limpiarMontos();
    return;
  }
  if (!sel.size){ msg.innerHTML = '<div class="error">Seleccioná al menos una sucursal.</div>'; return; }
  const btn = $('btnMonto'); btn.disabled = true;
  msg.innerHTML = '<div class="loading">Cargando datos...</div>';
  try {
    const r = await fetch(`/api/analisis-ventas/montos?desde=${$('desde').value}&hasta=${$('hasta').value}`
      + `&sucursales=${[...sel].join(',')}&monto=${encodeURIComponent(monto)}&op=${$('montoOp').value}`);
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    msg.innerHTML = '';
    renderMontos(d);
  } catch(e){
    limpiarMontos();
    msg.innerHTML = `<div class="error">Error: ${e.message}</div>`;
  } finally {
    btn.disabled = false;
  }
}

// Al repintar el panel de sucursales el bloque queda desactualizado: si el usuario ya
// había pedido un monto se vuelve a consultar con el filtro nuevo, y si no, se limpia.
function refrescarMontos(){
  if ($('montoValor').value.trim() === '') limpiarMontos();
  else consultarMontos();
}

// ── Top 40 Prioritarios ──────────────────────────────────────────────────────
// Acción independiente de las pestañas y del rango de fechas: dispara el cálculo en el
// servidor (rango fijo de 30 días) y sólo confirma que corrió. La lista la pinta Distribución.
async function generarPrioritarios(){
  const btn = $('btnGenerarPrioritarios');
  const msg = $('msgPrioritarios');
  btn.disabled = true;
  msg.innerHTML = '<div class="loading">Generando top 40 (puede tardar)...</div>';
  try {
    const r = await fetch('/api/analisis-ventas/prioritarios/generar', { method: 'POST' });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    const fecha = new Date(d.generadoEn).toLocaleString('es-AR');
    msg.innerHTML = `<div class="mini">Top 40 generado: <b>${fmtNum((d.productos || []).length)}</b> productos, el ${fecha}.</div>`;
  } catch(e){
    msg.innerHTML = `<div class="error">Error: ${e.message}</div>`;
  } finally {
    btn.disabled = false;
  }
}

// KPIs de la pestaña de familias. No hay tickets acá (el consolidado suma dos alcances con
// comprobantes distintos), así que se muestra lo que sí es sumable.
function renderKpisFamilias(d){
  $('kpis-fam').innerHTML = [
    ['Facturación', fmtMoney(d.totales.facturacion)],
    ['Familias', fmtNum((d.familias || []).length)],
    ['Productos', fmtNum(d.totales.productos)],
    ['Unidades', fmtNum(d.totales.unidades)],
  ].map(([lbl,val]) => `<div class="kpi"><div class="lbl">${lbl}</div><div class="val">${val}</div></div>`).join('');
}

// ── Pestañas ─────────────────────────────────────────────────────────────────
// Cada pestaña declara su prefijo de nodos, el módulo de permiso que la habilita, la URL
// que consulta y cómo pinta la respuesta. Agregar un alcance nuevo es agregar una entrada.
let sel = new Set(SUCURSALES.map(s => s.id));
// La central sólo se puede sacar desde la pestaña de familias, que es donde conviven los
// dos alcances; las otras dos pestañas tienen su alcance fijo por definición.
let centralIncluida = true;

const PANELES = {
  sucursales: {
    pref: 'suc', ref: 'analisis-ventas',
    url: (desde, hasta) => `/api/analisis-ventas?desde=${desde}&hasta=${hasta}&sucursales=${[...sel].join(',')}`,
    validar: () => sel.size ? '' : 'Seleccioná al menos una sucursal.',
    pintar: d => {
      renderKpis(d.kpis, 'suc');
      renderComparativa(d.comparativa);
      renderTendencia(d.tendencia, 'suc');
      renderDow(d.diaSemana, 'suc');
      renderHora(d.horas, 'suc');
      renderTop(d.topFacturacion, 'suc');
      renderFamilias(d.familias, 'suc');
      renderArticulos(d.articulosPorTicket);
      refrescarMontos();
    },
  },
  central: {
    pref: 'cen', ref: 'analisis-central',
    url: (desde, hasta) => `/api/analisis-central?desde=${desde}&hasta=${hasta}`,
    validar: () => '',
    pintar: d => {
      renderKpis(d.kpis, 'cen');
      renderTendencia(d.tendencia, 'cen', true);
      renderDow(d.diaSemana, 'cen');
      renderHora(d.horas, 'cen');
      renderTop(d.topProductos, 'cen');
      renderFamilias(d.familias, 'cen');
      renderClientes(d.clientes, 'cen');
    },
  },
  // La contracara de la central: mismo alcance fijo (casa central) pero sólo el rubro que
  // ahí se excluye. Mismo permiso (ref: analisis-central), el endpoint vive bajo su prefijo.
  apicultura: {
    pref: 'api', ref: 'analisis-central',
    url: (desde, hasta) => `/api/analisis-central/apicultura?desde=${desde}&hasta=${hasta}`,
    validar: () => '',
    pintar: d => {
      renderKpis(d.kpis, 'api');
      renderTendencia(d.tendencia, 'api', true);
      renderDow(d.diaSemana, 'api');
      renderHora(d.horas, 'api');
      renderTop(d.topProductos, 'api');
      renderFamilias(d.familias, 'api');
      renderClientes(d.clientes, 'api');
    },
  },
  // Consolidado: muestra ventas de la central, así que exige los dos permisos. El endpoint
  // lo verifica igual del lado del servidor (puedeVerFamilias).
  familias: {
    pref: 'fam', ref: 'analisis-ventas', refExtra: 'analisis-central',
    // sucursales= vacío es una elección válida (sólo central): por eso siempre se manda.
    url: (desde, hasta) => `/api/analisis-familias?desde=${desde}&hasta=${hasta}`
      + `&sucursales=${[...sel].join(',')}&central=${centralIncluida ? 1 : 0}`,
    validar: () => (sel.size || centralIncluida) ? '' : 'Seleccioná al menos una sucursal o la casa central.',
    pintar: d => {
      renderKpisFamilias(d);
      renderFamiliasPaginadas(d.familias);
    },
  },
  // Familias armadas a mano por el usuario. Todo su render vive en
  // analisis_familias_manuales.js (que se carga antes que este archivo): acá sólo se
  // declara la pestaña. Alcance sucursales, así que alcanza con el permiso de ventas.
  familiasManuales: {
    pref: 'fmn', ref: 'analisis-ventas',
    url: (desde, hasta) => `/api/familias-manuales/ventas?desde=${desde}&hasta=${hasta}`
      + `&sucursales=${[...sel].join(',')}&promo=${famPromo}`,
    validar: () => sel.size ? '' : 'Seleccioná al menos una sucursal.',
    // El editor y los filtros se montan al abrir la pestaña, no al llegar los datos: si la
    // consulta falla el usuario igual tiene que poder tocar los controles y reintentar.
    alMostrar: () => famInitEditor(),
    pintar: d => famPintar(d),
  },
  // Quiebres con todas las sucursales tildadas, una columna por cada una. Render en
  // analisis_quiebres.js; el endpoint cuelga de /api/analisis-ventas (mismo permiso).
  quiebres: {
    pref: 'qui', ref: 'analisis-ventas',
    url: (desde, hasta) => `/api/analisis-ventas/quiebres?desde=${desde}&hasta=${hasta}&sucursales=${[...sel].join(',')}`,
    validar: () => sel.size ? '' : 'Seleccioná al menos una sucursal.',
    pintar: d => quiPintar(d),
  },
};

const NOMBRE_POR_PREF = Object.fromEntries(Object.entries(PANELES).map(([k, p]) => [p.pref, k]));

// Qué pestaña se está viendo y con qué filtro quedaron cargados los datos de cada una.
// Cambiar de pestaña no vuelve a consultar si ya tiene los datos del filtro vigente: la
// consulta es pesada y el usuario suele ir y volver comparando.
let tabActivo = 'sucursales';
const cargado = { sucursales: '', central: '', familias: '', familiasManuales: '', quiebres: '' };

// El chip de la central entra en la clave: sacarlo cambia el consolidado y hay que
// reconsultar, aunque el rango y las sucursales sigan iguales.
function claveRango(){
  return `${$('desde').value}|${$('hasta').value}|${[...sel].sort().join(',')}|${centralIncluida ? 1 : 0}`;
}

// Qué pestañas usan el filtro de sucursales. La central tiene alcance fijo por definición.
const CON_CHIPS = ['sucursales', 'familias', 'familiasManuales', 'quiebres'];

function mostrarTab(nombre){
  if (!PANELES[nombre]) return;
  tabActivo = nombre;
  Object.entries(PANELES).forEach(([k, p]) => {
    const activa = k === nombre;
    const pane = $(`pane-${p.pref}`);
    if (pane) pane.hidden = !activa;
    const btn = $(`tab-${p.pref}`);
    if (btn) btn.classList.toggle('activa', activa);
  });
  $('filtroSucursales').hidden = !CON_CHIPS.includes(nombre);
  $('notaCentral').hidden = nombre !== 'central';
  $('notaApicultura').hidden = nombre !== 'apicultura';
  // El chip de la central sólo existe en la pestaña de familias, así que los chips se
  // vuelven a dibujar en cada cambio de pestaña.
  renderChips();
  // El hash deja la pestaña en la URL: recargar o compartir el link cae en la misma vista.
  if (location.hash !== `#${nombre}`) history.replaceState(null, '', `#${nombre}`);
  if (PANELES[nombre].alMostrar) PANELES[nombre].alMostrar();
  if (cargado[nombre] !== claveRango()) consultar();
}

function chip(texto, activo, onclick){
  const c = document.createElement('span');
  c.className = 'chip' + (activo ? ' active' : '');
  c.textContent = texto;
  c.onclick = () => { onclick(); c.classList.toggle('active'); };
  return c;
}

function renderChips(){
  const wrap = $('chips'); wrap.innerHTML = '';
  // En familias la central es un chip más: es el único lugar donde conviven los alcances.
  if (tabActivo === 'familias'){
    wrap.appendChild(chip('Casa Central', centralIncluida, () => { centralIncluida = !centralIncluida; }));
  }
  SUCURSALES.forEach(s => {
    wrap.appendChild(chip(s.nombre, sel.has(s.id), () => {
      sel.has(s.id) ? sel.delete(s.id) : sel.add(s.id);
    }));
  });
}

async function consultar(){
  const panel = PANELES[tabActivo];
  const msg = $(`msg-${panel.pref}`);
  const aviso = panel.validar();
  if (aviso){ msg.innerHTML = `<div class="error">${aviso}</div>`; return; }
  const btn = $('btnAplicar'); btn.disabled = true; btn.textContent = 'Consultando...';
  msg.innerHTML = '<div class="loading">Cargando datos...</div>';
  const rango = claveRango();
  const pestania = tabActivo;
  try {
    const r = await fetch(panel.url($('desde').value, $('hasta').value));
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    msg.innerHTML = '';
    panel.pintar(d);
    cargado[pestania] = rango;
  } catch(e){
    // El filtro no se marca como cargado: al volver a la pestaña se reintenta solo.
    cargado[pestania] = '';
    msg.innerHTML = `<div class="error">Error: ${e.message}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = 'Aplicar';
  }
}

// Aplicar consulta la pestaña visible e invalida la otra: el rango cambió para las dos,
// pero recalcular la que nadie está mirando sería una consulta pesada al pedo.
function aplicar(){
  Object.keys(cargado).forEach(k => { if (k !== tabActivo) cargado[k] = ''; });
  consultar();
}

// Qué pestaña abrir: la del hash o la del path (/analisis-central entra en la central),
// y si el usuario no tiene permiso a esa, la primera que sí.
function tabInicial(permitidas){
  const pedida = (location.hash || '').replace('#', '')
    || (location.pathname.includes('central') ? 'central' : 'sucursales');
  return permitidas.includes(pedida) ? pedida : permitidas[0];
}

// Las pestañas se dibujan según los módulos que el usuario tiene habilitados: sucursales y
// central siguen siendo dos permisos distintos, y familias exige los dos porque muestra
// ventas de la central mezcladas con las de sucursales. Con una sola pestaña la barra no se
// muestra. Un módulo apagado ni siquiera aparece en la respuesta, así que no estar en la
// lista es tan excluyente como no tener permiso.
// Si /api/modulos falla se ofrecen todas: el guard del servidor igual bloquea la API que no
// corresponda y el error se ve en pantalla; esconder todo dejaría la página muerta.
async function permisos(){
  try {
    const r = await fetch('/api/modulos');
    if (!r.ok) return Object.keys(PANELES);
    const mods = await r.json();
    const tiene = ref => mods.some(m => m.ref === ref && m.permitido);
    const habilitados = Object.entries(PANELES)
      .filter(([, p]) => tiene(p.ref) && (!p.refExtra || tiene(p.refExtra)))
      .map(([k]) => k);
    return habilitados.length ? habilitados : Object.keys(PANELES);
  } catch(e){
    return Object.keys(PANELES);
  }
}

async function init(){
  initFechas();
  renderChips();
  $('btnAplicar').onclick = aplicar;
  $('btnMonto').onclick = consultarMontos;
  $('btnGenerarPrioritarios').onclick = generarPrioritarios;
  $('montoValor').onkeydown = e => { if (e.key === 'Enter') consultarMontos(); };
  $('montoOp').onchange = () => { if ($('montoValor').value.trim() !== '') consultarMontos(); };
  $('selAll').onclick  = () => { sel = new Set(SUCURSALES.map(s=>s.id)); renderChips(); };
  $('selNone').onclick = () => { sel.clear(); renderChips(); };
  Object.values(PANELES).forEach(p => {
    // En las dos pestañas de familias el buscador filtra familias, no productos: la
    // tabla es otra y cada una la pinta su propio módulo.
    const BUSCADOR = {
      fam: e => buscarEnFamilias(e.target.value),
      fmn: e => famBuscarEnLista(e.target.value),
      qui: e => quiBuscar(e.target.value),
    };
    $(`buscTop-${p.pref}`).oninput = BUSCADOR[p.pref] || (e => buscarEnTop(p.pref, e.target.value));
    [`filtQuiebre-${p.pref}`, `filtRubro-${p.pref}`].forEach(id => {
      if ($(id)) $(id).onchange = () => { if (tops[p.pref]) { tops[p.pref].pagina = 1; pintarTop(p.pref); } };
    });
    $(`tab-${p.pref}`).onclick = () => mostrarTab(NOMBRE_POR_PREF[p.pref]);
  });
  const permitidas = await permisos();
  Object.entries(PANELES).forEach(([k, p]) => {
    const visible = permitidas.includes(k);
    $(`tab-${p.pref}`).hidden = !visible;
    // El panel sin permiso se saca del DOM: así ningún render lo alcanza por error.
    if (!visible) $(`pane-${p.pref}`).remove();
  });
  $('tabs').hidden = permitidas.length < 2;
  mostrarTab(tabInicial(permitidas));
}

init();
