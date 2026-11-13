const $ = id => document.getElementById(id);
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtMoney = n => '$' + Number(n).toLocaleString('es-AR', { maximumFractionDigits: 2 });
const fmtInt = n => Math.round(Number(n) || 0).toLocaleString('es-AR');
const fmtSigno = (n, dec) => (n > 0 ? '+' : n < 0 ? '-' : '') + Math.abs(n).toLocaleString('es-AR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
const parseNum = s => Number(String(s).trim().replace(',', '.'));
const esVisible = f => f.visible === true || ['Si', 'SI', 'Sí'].includes(f.visible);

const ESTADOS = {
  desviada: { txt: 'Desviada', badge: 'be-crit', kpi: 't-crit' },
  ok: { txt: 'Ok', badge: 'be-ok', kpi: 't-ok' },
  sin_codigo: { txt: 'Sin código', badge: 'be-warn', kpi: 't-warn' },
  sin_carta: { txt: 'Sin carta', badge: 'be-warn', kpi: 't-warn' },
  sin_precio: { txt: 'Sin precio', badge: 'be-gris', kpi: 't-gris' },
  sin_componentes: { txt: 'Sin componentes', badge: 'be-warn', kpi: 't-warn' },
};
// Estados que no aplican a cada pestaña (no se ofrecen como chip)
const ESTADOS_NO_APLICA = { productos: ['sin_componentes'], combos: ['sin_codigo'] };
const ESTADOS_ALERTA = ['desviada', 'sin_componentes'];
const CLAVE_PESTANA = 'tn_precios_pestana';

const SIN_PERMISO_EDITAR = 'No tenés permiso para editar (hace falta el permiso precios-config).';
const COLUMNAS = [
  { key: 'nombre', txt: 'Producto / variante' },
  { key: 'codigo', txt: 'Código SIGA', num: true },
  { key: 'stock', txt: 'Stock', num: true },
  { key: 'precioTn', txt: 'Precio TN', num: true },
  { key: 'esperado', txt: 'Esperado', num: true },
  { key: 'difAbs', txt: 'Dif. $', num: true },
  { key: 'desvioPct', txt: 'Dif. %', num: true },
  { key: 'estado', txt: 'Estado' },
];

let datos = null; // respuesta de /control
let config = null; // respuesta de /config
let filtroEstado = '';
let filtroLinea = '';
let orden = { key: null, dir: 'desc' };
let pestana = leerPestanaInicial(); // 'productos' | 'combos'
const abiertos = new Set(); // claves de combos expandidos
const borradores = new Map(); // clave -> [{ codigo, unidades }] (strings) de composiciones en edición
let infoCodigos = new Map(); // codigo -> { nombre, carta } conocido por los combos de la bajada

function leerPestanaInicial() {
  const valida = v => (v === 'combos' || v === 'productos') ? v : null;
  const deHash = valida(location.hash.replace('#', ''));
  if (deHash) return deHash;
  try { return valida(sessionStorage.getItem(CLAVE_PESTANA)) || 'productos'; } catch (_e) { return 'productos'; }
}
function guardarPestana() {
  try { sessionStorage.setItem(CLAVE_PESTANA, pestana); } catch (_e) { /* sin storage */ }
  try { history.replaceState(null, '', '#' + pestana); } catch (_e) { /* sin history */ }
}
const esCombo = f => f.esCombo === true;
const filasDePestana = () => (datos.filas || []).filter(f => esCombo(f) === (pestana === 'combos')); // key null = prioridad (sin código, luego mayor |desvío|)

function avisar(texto, tipo) {
  const el = $('aviso');
  if (!texto) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.className = tipo === 'error' ? 'error' : 'card fade-in';
  el.textContent = texto;
}

// msg403: texto para 403 (cada endpoint tiene un permiso distinto)
async function api(url, opts, msg403) {
  let r;
  try { r = await fetch(url, opts); } catch (_e) { throw new Error('No se pudo conectar con el servidor.'); }
  if (r.status === 401) throw new Error('La sesión venció. Recargá la página e iniciá sesión de nuevo.');
  if (r.status === 403) throw new Error(msg403 || 'No tenés acceso a este módulo.');
  let cuerpo = null;
  try { cuerpo = await r.json(); } catch (_e) { /* sin JSON */ }
  if (!r.ok) throw new Error((cuerpo && cuerpo.error) || `Error ${r.status} del servidor.`);
  return cuerpo;
}

// ── Cálculos derivados por fila ──────────────────────────────────────────────
function difAbs(f) {
  const tn = num(f.precioTn), esp = num(f.esperado);
  return tn === null || esp === null ? null : tn - esp;
}
const skuTn = f => f.skuOriginal ?? f.sku ?? '';
const textoFila = f => `${f.nombre} ${f.variante} ${skuTn(f)} ${f.codigo ?? ''} ${f.categorias ?? ''} ${f.url}`.toLowerCase();

// Filas que pasan los filtros salvo el de estado (para los conteos de los chips).
function filtrarSinEstado() {
  const q = $('f-buscar').value.trim().toLowerCase();
  const vis = $('f-visible').value;
  const stk = $('f-stock').value;
  const lin = pestana === 'productos' ? filtroLinea : '';
  return filasDePestana().filter(f => {
    if (lin && (lin === 'otra' ? !(f.linea === 'otra' || f.linea == null) : f.linea !== lin)) return false;
    if (vis && (vis === 'visible') !== esVisible(f)) return false;
    if (stk) {
      const s = num(f.stock);
      if (stk === 'con' ? !(s !== null && s > 0) : !(s !== null && s <= 0)) return false;
    }
    return !q || textoFila(f).includes(q);
  });
}

function ordenar(filas) {
  const peso = f => f.estado === 'sin_codigo' || f.estado === 'sin_componentes' ? Infinity : Math.abs(num(f.desvioPct) ?? -1);
  const valor = f => {
    switch (orden.key) {
      case 'nombre': return `${f.nombre || f.url} ${f.variante || ''}`.toLowerCase();
      case 'difAbs': return difAbs(f);
      case 'estado': return ESTADOS[f.estado]?.txt || f.estado;
      default: return num(f[orden.key]);
    }
  };
  if (!orden.key) return [...filas].sort((a, b) => peso(b) - peso(a));
  const dir = orden.dir === 'asc' ? 1 : -1;
  return [...filas].sort((a, b) => {
    const va = valor(a), vb = valor(b);
    if (va === null && vb === null) return 0;
    if (va === null) return 1; // vacíos siempre al final
    if (vb === null) return -1;
    return (typeof va === 'string' ? va.localeCompare(vb, 'es', { numeric: true }) : va - vb) * dir;
  });
}

// ── Cabecera de la bajada, KPIs y chips ──────────────────────────────────────
function renderBajada() {
  const filas = datos.filas || [];
  const box = $('bajada');
  if (!datos.importadoEn || !filas.length) { box.hidden = true; return; }
  const productos = new Set(filas.map(f => f.url)).size;
  const fecha = new Date(datos.importadoEn);
  const dias = Math.floor((Date.now() - fecha.getTime()) / 86400000);
  const antig = dias <= 0 ? 'de hoy' : `hace ${dias} ${dias === 1 ? 'día' : 'días'}`;
  box.hidden = false;
  box.innerHTML = `<dl>
    <div><dt>Bajada importada</dt><dd>${escHtml(fecha.toLocaleString('es-AR'))} <span class="t-muted" style="font-weight:500">(${antig})</span></dd></div>
    <div><dt>Filas</dt><dd>${fmtInt(filas.length)}</dd></div>
    <div><dt>Productos</dt><dd>${fmtInt(productos)}</dd></div>
  </dl>${dias >= 3 ? '<span class="badge-e be-warn">Bajada vieja: el export lleva el stock de ese momento</span>' : ''}`;
}

function renderKpis() {
  const k = datos.kpis || {};
  const total = (datos.filas || []).length;
  const item = (clave, lbl, val, tono, filtro) => filtro !== undefined
    ? `<button type="button" class="kpi ${tono}${filtroEstado === filtro ? ' on' : ''}" data-filtro="${filtro}" aria-pressed="${filtroEstado === filtro}"><div class="lbl">${lbl}</div><div class="val">${fmtInt(val)}</div></button>`
    : `<div class="kpi estatico ${tono}"><div class="lbl">${lbl}</div><div class="val">${fmtInt(val)}</div></div>`;
  $('kpis').innerHTML = [
    item('total', 'Filas', total, 't-gris'),
    item('desviada', 'Desviadas', k.desviadas, 't-crit', 'desviada'),
    item('ok', 'Ok', k.ok, 't-ok', 'ok'),
    item('sin_codigo', 'Sin código', k.sinCodigo, 't-warn', 'sin_codigo'),
    item('sin_carta', 'Sin carta', k.sinCarta, 't-warn', 'sin_carta'),
    item('sin_precio', 'Sin precio', k.sinPrecio, 't-gris', 'sin_precio'),
    item('sin_presentacion', 'Sin presentación', k.sinPresentacion ?? 0, 't-warn', 'sin_presentacion'),
    item('ocultas', 'Ocultas', k.ocultas, 't-gris'),
    item('combos', 'Combos', k.combos ?? 0, 't-gris'),
    item('combos_desv', 'Combos desviados', k.combosDesviadas ?? 0, 't-crit'),
  ].join('');
  $('exportar').disabled = !(k.desviadas > 0);
}

function renderChips() {
  const base = filtrarSinEstado();
  const cuenta = e => base.filter(f => f.estado === e).length;
  const chips = [{ val: '', txt: 'Todas', n: base.length }]
    .concat(Object.keys(ESTADOS).filter(e => !ESTADOS_NO_APLICA[pestana].includes(e)).map(e => ({ val: e, txt: ESTADOS[e].txt, n: cuenta(e) })));
  if (pestana === 'productos') chips.push({ val: 'sin_presentacion', txt: 'Sin presentación', n: base.filter(esSinPres).length });
  $('chips').innerHTML = chips.map(c =>
    `<button type="button" class="chipf" data-estado="${c.val}" aria-pressed="${filtroEstado === c.val}">${escHtml(c.txt)} <span class="n">${fmtInt(c.n)}</span></button>`).join('');
  $('f-linea-campo').hidden = pestana !== 'productos';
  const hayFiltro = filtroEstado || (pestana === 'productos' && filtroLinea) || $('f-buscar').value || $('f-visible').value || $('f-stock').value;
  $('f-limpiar').hidden = !hayFiltro;
}

// ── Tabla ────────────────────────────────────────────────────────────────────
const fmtKg = n => Number(n).toLocaleString('es-AR', { maximumFractionDigits: 3 });
const ORIGEN_PRES = { peso_tn: 'Peso TN', propiedad: 'valor de propiedad', nombre: 'nombre', vinculo: 'vínculo manual' };
// Solo Fraccionado sin peso detectado (en el resto el peso no se usa).
const esSinPres = f => !esCombo(f) && f.esFraccionado === true && num(f.presentacion?.kg) === null;
const MAX_KG = 1000;
const LINEAS = { fraccionado: 'Fraccionado', almacen: 'Almacén', otra: 'Otra línea' };
// Multiplicador automático: el peso de la presentación si se aplica (Fraccionado); si no, 1.
const kgAuto = f => (f.presentacion?.aplicada && num(f.presentacion.kg) !== null) ? num(f.presentacion.kg) : 1;
const coincideEstado = f => !filtroEstado || (filtroEstado === 'sin_presentacion' ? esSinPres(f) : f.estado === filtroEstado);

function presentacionHtml(f) {
  const p = f.presentacion;
  if (!p) return '';
  const kg = num(p.kg);
  if (!f.esFraccionado) {
    if (p.origen === 'sin_dato' || (!p.texto && kg === null)) return '';
    const det = p.texto ? `${escHtml(p.texto)}${kg === null ? '' : ` (${fmtKg(kg)} kg)`}` : `${fmtKg(kg)} kg`;
    const linea = LINEAS[f.linea] ? `línea ${escHtml(LINEAS[f.linea])}: ` : '';
    return `<div class="pres">Presentación detectada: ${det} · no se aplica, ${linea}x1</div>`;
  }
  if (p.origen === 'sin_dato') return '<div class="pres pres-aviso"><span class="pres-ico" aria-hidden="true">!</span>Sin presentación: se usa x1, revisalo</div>';
  const orig = f.origenUnidades === 'vinculo' ? ORIGEN_PRES.vinculo : (ORIGEN_PRES[p.origen] || p.origen);
  const base = p.texto ? `${escHtml(p.texto)}${kg === null ? '' : ` → ${fmtKg(kg)} kg`}` : (kg === null ? '-' : `${fmtKg(kg)} kg`);
  return `<div class="pres">Presentación: ${base} · fuente: ${escHtml(orig)}</div>`;
}

function vinculoHtml(f, etiqueta) {
  const manualUni = num(f.unidadesManual) !== null;
  const frac = f.esFraccionado === true;
  const lineaTag = LINEAS[f.linea] ? `<span class="tag-linea">${escHtml(LINEAS[f.linea])}</span>` : '';
  const usar = manualUni ? `<button type="button" class="link-btn" data-accion="usar-presentacion" aria-label="${frac ? 'Usar la presentación' : 'Volver a x1'} para ${etiqueta}" title="${frac ? 'Volver al peso de la presentación' : 'Volver al multiplicador x1'}">${frac ? 'usar presentación' : 'volver a x1'}</button>` : '';
  const nombre = f.nombreProducto ? `<div class="vinc-nombre" title="${escHtml(f.nombreProducto)}">${escHtml(f.nombreProducto)}</div>` : '';
  const sku = skuTn(f);
  const manual = f.vinculado
    ? `<span class="tag-manual">Vínculo manual</span><button type="button" class="link-btn" data-accion="quitar-vinculo" aria-label="Quitar vínculo manual de ${etiqueta} y volver al SKU">Quitar</button>`
    : '';
  return `<div class="vinc">
      <input class="celda-input v-codigo${f.vinculado ? ' manual' : ''}" inputmode="numeric" autocomplete="off" placeholder="código SIGA" value="${escHtml(f.codigo ?? '')}" aria-label="Código SIGA de ${etiqueta}">
      <span class="por" aria-hidden="true">x</span>
      <input class="celda-input unid v-unidades${manualUni ? '' : ' auto'}" inputmode="decimal" autocomplete="off" value="${escHtml(fmtKg(num(f.unidades) ?? 1))}" aria-label="Multiplicador en ${frac ? 'kg' : 'unidades'} de ${etiqueta}${manualUni ? '' : ' (automático)'}">${frac ? '\n      <span class="por" aria-hidden="true">kg</span>' : ''}
    </div>
    ${presentacionHtml(f)}
    <div class="vinc-meta">${lineaTag}<span>SKU TN: ${escHtml(sku || '(vacío)')}</span>${manual}${usar}</div>${nombre}`;
}

// "carta × 0,5 kg × 1,1": explica el esperado (antes del redondeo).
function calculoHtml(f) {
  const carta = num(f.carta), u = num(f.unidades);
  if (carta === null || u === null || !config) return '';
  const txt = `${fmtMoney(carta)} × ${fmtKg(u)}${f.esFraccionado ? ' kg' : ''} × ${fmtDec(recargoK())}`;
  return `<div class="calc" title="Carta × multiplicador × recargo, luego se redondea">${escHtml(txt)}</div>`;
}

function filaHtml(f) {
  const e = ESTADOS[f.estado] || { txt: f.estado, badge: 'be-gris' };
  const d = num(f.desvioPct);
  const da = difAbs(f);
  const tono = f.estado === 'desviada' ? 't-crit' : f.estado === 'ok' ? 't-ok' : 't-muted';
  const etiqueta = escHtml(`${f.nombre || f.url}${f.variante ? ' - ' + f.variante : ''}`);
  const stock = num(f.stock);
  return `<tr data-clave="${escHtml(f.clave)}" class="fila-${escHtml(f.estado)}">
    <td class="prod" title="${etiqueta}"><div class="n1">${escHtml(f.nombre || f.url)}${esVisible(f) ? '' : '<span class="tag-oculta">Oculta</span>'}</div>${f.variante ? `<div class="n2">${escHtml(f.variante)}</div>` : ''}</td>
    <td class="num">${vinculoHtml(f, etiqueta)}</td>
    <td class="num${stock !== null && stock <= 0 ? ' t-muted' : ''}">${stock === null ? '-' : fmtInt(stock)}</td>
    <td class="num">${num(f.precioTn) === null ? '-' : fmtMoney(f.precioTn)}</td>
    <td class="num">${num(f.esperado) === null ? '-' : fmtMoney(f.esperado)}${calculoHtml(f)}</td>
    <td class="num ${tono}">${da === null ? '-' : (da > 0 ? '+' : da < 0 ? '-' : '') + fmtMoney(Math.abs(da))}</td>
    <td class="num ${tono}">${d === null ? '-' : fmtSigno(d, 1) + ' %'}</td>
    <td><span class="badge-e ${e.badge}">${escHtml(e.txt)}</span></td>
  </tr>`;
}

function encabezadoHtml() {
  return `<thead><tr>${COLUMNAS.map(c => {
    const activo = orden.key === c.key;
    const sort = activo ? (orden.dir === 'asc' ? 'ascending' : 'descending') : 'none';
    return `<th scope="col" class="${c.num ? 'num' : ''}" aria-sort="${sort}"><button type="button" data-orden="${c.key}">${escHtml(c.txt)}</button></th>`;
  }).join('')}</tr></thead>`;
}

function mensajeVacio(total) {
  if (!total && datos?.filas?.length) return `<p class="empty">No hay ${pestana === 'combos' ? 'combos' : 'productos sin combo'} en la bajada actual.</p>`;
  if (total) return '<p class="empty">Ninguna fila coincide con los filtros. Probá limpiarlos.</p>';
  return `<div class="empty"><p style="font-weight:600;font-size:15px;color:#242423">Todavía no hay una bajada importada</p>
    <p style="margin:6px 0 14px">Descargá el CSV de productos desde Tienda Nube e importalo para controlar los precios.</p>
    <button type="button" class="btn btn-primario" data-accion="importar">Importar bajada de TN</button></div>`;
}

function renderTabla() {
  const wrap = $('tabla-wrap');
  const total = filasDePestana().length;
  const filas = ordenar(filtrarSinEstado().filter(coincideEstado));
  $('cuenta').textContent = `${fmtInt(filas.length)} de ${fmtInt(total)} ${pestana === 'combos' ? 'combos' : 'filas'}`;
  wrap.setAttribute('aria-label', pestana === 'combos' ? 'Lista de combos' : 'Tabla de productos');
  renderChips();
  if (!filas.length) { wrap.innerHTML = mensajeVacio(total); return; }
  wrap.innerHTML = pestana === 'combos'
    ? `<div class="combos">${filas.map(comboHtml).join('')}</div>`
    : `<table>${encabezadoHtml()}<tbody>${filas.map(filaHtml).join('')}</tbody></table>`;
}

// ── Pestañas ─────────────────────────────────────────────────────────────────
function renderTabs() {
  const filas = datos ? datos.filas || [] : [];
  const def = [['productos', 'Productos'], ['combos', 'Combos']];
  $('tabs').innerHTML = def.map(([id, txt]) => {
    const grupo = filas.filter(f => esCombo(f) === (id === 'combos'));
    const alerta = grupo.some(f => ESTADOS_ALERTA.includes(f.estado));
    return `<button type="button" role="tab" id="tab-${id}" class="tab" data-pestana="${id}" aria-selected="${pestana === id}" aria-controls="panel-tabla" tabindex="${pestana === id ? 0 : -1}">${txt} <span class="n">${fmtInt(grupo.length)}</span>${alerta ? '<span class="punto-alerta" aria-hidden="true" title="Hay filas desviadas o sin componentes"></span><span class="sr-only">(con alertas)</span>' : ''}</button>`;
  }).join('');
}
function cambiarPestana(id) {
  if (id === pestana) return;
  pestana = id;
  filtroEstado = '';
  $('panel-tabla').setAttribute('aria-labelledby', 'tab-' + id);
  guardarPestana();
  renderTabs();
  if (datos) { renderKpis(); renderTabla(); }
}
$('tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-pestana]');
  if (b) cambiarPestana(b.dataset.pestana);
});
$('tabs').addEventListener('keydown', e => {
  const id = { ArrowLeft: 'productos', ArrowRight: 'combos', Home: 'productos', End: 'combos' }[e.key];
  if (!id) return;
  e.preventDefault();
  cambiarPestana(id);
  $('tab-' + id).focus();
});
window.addEventListener('hashchange', () => {
  const v = location.hash.replace('#', '');
  if (v === 'combos' || v === 'productos') cambiarPestana(v);
});

// ── Combos: tarjetas con composición editable ────────────────────────────────
const recargoK = () => 1 + (num(config?.recargoPct) ?? 0) / 100;
const compsDe = f => borradores.get(f.clave) || (f.componentes || []).map(c => ({ codigo: String(c.codigo ?? ''), unidades: String(c.unidades ?? 1) }));
const infoDe = codigo => infoCodigos.get(String(codigo).trim()) || null;
const fmtDec = n => n.toLocaleString('es-AR', { maximumFractionDigits: 4 });

function totalesCombo(comps) {
  let sub = 0, faltan = 0;
  for (const c of comps) {
    const carta = num(infoDe(c.codigo)?.carta), u = Number(c.unidades);
    if (carta === null || !(u >= 1)) { faltan++; continue; }
    sub += carta * u;
  }
  return { sub, faltan, total: sub * recargoK() };
}

function totalesHtml(comps) {
  const t = totalesCombo(comps);
  const pct = fmtDec(num(config?.recargoPct) ?? 0);
  const falta = t.faltan ? `<p class="t-muted" style="font-size:12px;margin:4px 0 0">${t.faltan} ${t.faltan === 1 ? 'componente sin carta conocida' : 'componentes sin carta conocida'}: se calcula al guardar.</p>` : '';
  return `<dl class="tot"><div><dt>Subtotal carta</dt><dd>${fmtMoney(t.sub)}</dd></div>
    <div><dt>Recargo aplicado</dt><dd>${pct} %</dd></div>
    <div><dt>Total esperado (estimado)</dt><dd>${fmtMoney(t.total)}</dd></div></dl>${falta}`;
}

function compFilaHtml(c, i, etiqueta) {
  const info = infoDe(c.codigo);
  const carta = num(info?.carta), u = Number(c.unidades);
  return `<tr data-i="${i}">
    <td><input class="celda-input c-codigo" inputmode="numeric" autocomplete="off" placeholder="código SIGA" value="${escHtml(c.codigo)}" aria-label="Código del componente ${i + 1} de ${etiqueta}"></td>
    <td class="c-nombre">${info?.nombre ? escHtml(info.nombre) : '<span class="t-muted">-</span>'}</td>
    <td class="num"><input class="celda-input unid c-unidades" inputmode="numeric" autocomplete="off" value="${escHtml(c.unidades)}" aria-label="Unidades del componente ${i + 1} de ${etiqueta}"></td>
    <td class="num c-carta">${carta === null ? '<span class="t-muted">se calcula al guardar</span>' : fmtMoney(carta)}</td>
    <td class="num c-sub">${carta === null || !(u >= 1) ? '-' : fmtMoney(carta * u)}</td>
    <td class="num"><button type="button" class="btn btn-secundario btn-chico" data-accion="comp-quitar" aria-label="Quitar componente ${i + 1} de ${etiqueta}">Quitar</button></td>
  </tr>`;
}

function editorHtml(f) {
  const comps = compsDe(f);
  const etiqueta = escHtml(f.nombre || f.url);
  const tabla = comps.length
    ? `<table class="comp"><thead><tr><th scope="col">Código</th><th scope="col">Producto SIGA</th><th scope="col" class="num">Unidades</th><th scope="col" class="num">Carta</th><th scope="col" class="num">Subtotal</th><th scope="col"><span class="sr-only">Acciones</span></th></tr></thead>
       <tbody>${comps.map((c, i) => compFilaHtml(c, i, etiqueta)).join('')}</tbody></table>`
    : '<p class="empty" style="padding:12px">Este combo no tiene componentes. Agregá al menos uno.</p>';
  return `${tabla}
    <div class="tot-wrap" aria-live="polite">${totalesHtml(comps)}</div>
    <div class="combo-acciones"><button type="button" class="btn btn-secundario" data-accion="comp-agregar">Agregar componente</button>
      <button type="button" class="btn btn-primario" data-accion="comp-guardar">Guardar composición</button>
      <span class="combo-error error" role="alert" hidden></span></div>`;
}

function comboHtml(f) {
  const e = ESTADOS[f.estado] || { txt: f.estado, badge: 'be-gris' };
  const da = difAbs(f), d = num(f.desvioPct);
  const tono = f.estado === 'desviada' ? 't-crit' : f.estado === 'ok' ? 't-ok' : 't-muted';
  const nombre = `${f.nombre || f.url}${f.variante ? ' - ' + f.variante : ''}`;
  const dif = da === null ? '-' : (da > 0 ? '+' : da < 0 ? '-' : '') + fmtMoney(Math.abs(da)) + (d === null ? '' : ` (${fmtSigno(d, 1)} %)`);
  return `<details class="combo combo-${escHtml(f.estado)}" data-clave="${escHtml(f.clave)}"${abiertos.has(f.clave) ? ' open' : ''}>
    <summary><span class="combo-tit"><span class="n1">${escHtml(nombre)}</span>${f.categorias ? `<span class="n2">${escHtml(f.categorias)}</span>` : ''}</span>
      <span class="combo-dato"><span class="lbl">Precio TN</span>${num(f.precioTn) === null ? '-' : fmtMoney(f.precioTn)}</span>
      <span class="combo-dato"><span class="lbl">Esperado</span>${num(f.esperado) === null ? '-' : fmtMoney(f.esperado)}</span>
      <span class="combo-dato ${tono}"><span class="lbl">Diferencia</span>${dif}</span>
      <span class="badge-e ${e.badge}">${escHtml(e.txt)}</span></summary>
    <div class="combo-cuerpo">${editorHtml(f)}</div></details>`;
}

const filaDeClave = clave => (datos?.filas || []).find(f => f.clave === clave);
const leerBorrador = det => [...det.querySelectorAll('tbody tr')].map(r => ({ codigo: r.querySelector('.c-codigo').value.trim(), unidades: r.querySelector('.c-unidades').value.trim() }));
function repintarCombo(det) {
  const f = filaDeClave(det.dataset.clave);
  if (f) det.querySelector('.combo-cuerpo').innerHTML = editorHtml(f);
}
// Recalcula nombre/carta/subtotal de la fila editada y los totales, sin rearmar los inputs.
function actualizarCalculoEnVivo(det, tr) {
  const f = filaDeClave(det.dataset.clave);
  if (!f) return;
  const comps = leerBorrador(det);
  borradores.set(det.dataset.clave, comps);
  if (tr) {
    const i = Number(tr.dataset.i);
    const tmp = document.createElement('table');
    tmp.innerHTML = `<tbody>${compFilaHtml(comps[i], i, escHtml(f.nombre || f.url))}</tbody>`;
    for (const k of ['.c-nombre', '.c-carta', '.c-sub']) tr.querySelector(k).innerHTML = tmp.querySelector(k).innerHTML;
  }
  det.querySelector('.tot-wrap').innerHTML = totalesHtml(comps);
}

async function guardarComposicion(det) {
  const clave = det.dataset.clave;
  const err = det.querySelector('.combo-error');
  const mostrar = txt => { err.hidden = !txt; err.textContent = txt || ''; };
  let primero = null;
  const lista = [...det.querySelectorAll('tbody tr')].map(r => {
    const cod = r.querySelector('.c-codigo'), uni = r.querySelector('.c-unidades');
    const codigo = Number(cod.value.trim()), unidades = Number(uni.value.trim() || 1);
    const malC = !(Number.isInteger(codigo) && codigo > 0), malU = !(Number.isInteger(unidades) && unidades >= 1);
    cod.setAttribute('aria-invalid', String(malC));
    uni.setAttribute('aria-invalid', String(malU));
    if ((malC || malU) && !primero) primero = malC ? cod : uni;
    return { codigo, unidades };
  });
  if (primero) { mostrar('Cada componente necesita un código entero positivo y unidades enteras de 1 o más.'); primero.focus(); return; }
  if (new Set(lista.map(c => c.codigo)).size !== lista.length) { mostrar('Hay códigos repetidos: sumá las unidades en una sola línea.'); return; }
  mostrar('');
  const btns = det.querySelectorAll('button');
  btns.forEach(b => { b.disabled = true; });
  try {
    await api(`/api/tn-precios/combos/${encodeURIComponent(clave)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ componentes: lista }),
    }, SIN_PERMISO_EDITAR);
    borradores.delete(clave);
    abiertos.add(clave);
    await cargarControl();
    avisar('Composición guardada y precio esperado recalculado.');
  } catch (e) {
    btns.forEach(b => { b.disabled = false; });
    mostrar(`No se guardó la composición: ${e.message}`);
  }
}

// Devuelve true si la acción era de combos.
function accionCombo(accion, target) {
  const det = target.closest('details.combo');
  if (!det) return false;
  const clave = det.dataset.clave;
  if (accion === 'comp-agregar') {
    borradores.set(clave, [...leerBorrador(det), { codigo: '', unidades: '1' }]);
    repintarCombo(det);
    const filas = det.querySelectorAll('tbody tr');
    filas[filas.length - 1]?.querySelector('.c-codigo').focus();
  } else if (accion === 'comp-quitar') {
    const i = Number(target.closest('tr[data-i]').dataset.i);
    borradores.set(clave, leerBorrador(det).filter((_c, k) => k !== i));
    repintarCombo(det);
    det.querySelector('[data-accion="comp-agregar"]').focus();
  } else if (accion === 'comp-guardar') guardarComposicion(det);
  else return false;
  return true;
}

function renderTodo() { renderBajada(); renderKpis(); renderTabs(); renderTabla(); }

async function cargarControl() {
  const wrap = $('tabla-wrap');
  const scrollTop = wrap.scrollTop;
  wrap.setAttribute('aria-busy', 'true');
  try {
    datos = await api('/api/tn-precios/control');
  } catch (err) {
    datos = null;
    $('kpis').innerHTML = '';
    $('bajada').hidden = true;
    $('cuenta').textContent = '';
    $('chips').innerHTML = '';
    renderTabs();
    $('exportar').disabled = true;
    $('importado').textContent = '';
    wrap.removeAttribute('aria-busy');
    wrap.innerHTML = `<div class="error m-4" role="alert"><p>${escHtml(err.message)}</p><button type="button" class="btn btn-secundario mt-3" data-accion="reintentar">Reintentar</button></div>`;
    return;
  }
  infoCodigos = new Map();
  for (const f of datos.filas || []) for (const c of f.componentes || []) infoCodigos.set(String(c.codigo), { nombre: c.nombre, carta: c.carta });
  $('importado').textContent = datos.importadoEn ? `Bajada: ${new Date(datos.importadoEn).toLocaleDateString('es-AR')}` : 'Sin bajada importada';
  renderTodo();
  wrap.removeAttribute('aria-busy');
  wrap.scrollTop = scrollTop;
}

// ── Edición inline de vínculo (sin rearmar la fila hasta que el server responde) ─
async function guardarVinculo(tr, campo) {
  const cod = tr.querySelector('.v-codigo');
  const uni = tr.querySelector('.v-unidades');
  const crudoCod = cod.value.trim();
  const clave = tr.dataset.clave;
  const previo = (datos.filas || []).find(f => f.clave === clave);
  const crudoUni = uni.value.trim();
  const n = crudoUni === '' ? null : parseNum(crudoUni);
  const codigo = crudoCod === '' ? null : Number(crudoCod);
  const malCod = codigo !== null && !(Number.isInteger(codigo) && codigo > 0);
  const malUni = n !== null && !(Number.isFinite(n) && n > 0 && n <= MAX_KG);
  cod.setAttribute('aria-invalid', String(malCod));
  uni.setAttribute('aria-invalid', String(malUni));
  if (malCod || malUni) { avisar(malCod ? 'El código debe ser un entero positivo.' : `El multiplicador debe ser un número mayor que 0 y hasta ${MAX_KG} kg.`, 'error'); return; }
  // Vacío o igual al automático: sin unidad manual (null, usa la presentación).
  const unidades = n === null || (previo && Math.abs(n - kgAuto(previo)) < 1e-9) ? null : n;
  const manualPrevio = previo ? num(previo.unidadesManual) : null;
  if (previo && (previo.codigo ?? null) === codigo && manualPrevio === unidades) {
    uni.value = fmtKg(num(previo.unidades) ?? 1);
    avisar('');
    return;
  }
  avisar('');
  cod.disabled = uni.disabled = true;
  tr.classList.add('guardando');
  try {
    await api(`/api/tn-precios/vinculos/${encodeURIComponent(clave)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(codigo === null ? { codigo: null } : { codigo, unidades: unidades ?? null }),
    }, SIN_PERMISO_EDITAR);
    await cargarControl();
    const nueva = [...$('tabla-wrap').querySelectorAll('tr[data-clave]')].find(t => t.dataset.clave === clave);
    nueva?.querySelector(campo === 'unidades' ? '.v-unidades' : '.v-codigo')?.focus({ preventScroll: true });
  } catch (err) {
    cod.disabled = uni.disabled = false;
    tr.classList.remove('guardando');
    (campo === 'unidades' ? uni : cod).setAttribute('aria-invalid', 'true');
    avisar(`No se guardó el vínculo: ${err.message}`, 'error');
  }
}

const tablaWrap = $('tabla-wrap');
tablaWrap.addEventListener('input', e => {
  const t = e.target;
  if (!t.classList.contains('c-codigo') && !t.classList.contains('c-unidades')) return;
  t.removeAttribute('aria-invalid');
  actualizarCalculoEnVivo(t.closest('details.combo'), t.closest('tr'));
});
tablaWrap.addEventListener('toggle', e => {
  const det = e.target;
  if (!det.matches || !det.matches('details.combo')) return;
  if (det.open) abiertos.add(det.dataset.clave); else abiertos.delete(det.dataset.clave);
}, true);
tablaWrap.addEventListener('change', e => {
  const tr = e.target.closest('tr[data-clave]');
  if (tr && e.target.classList.contains('celda-input')) guardarVinculo(tr, e.target.classList.contains('v-unidades') ? 'unidades' : 'codigo');
});
tablaWrap.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !e.target.classList.contains('celda-input')) return;
  if (e.target.classList.contains('c-codigo') || e.target.classList.contains('c-unidades')) return;
  e.target.blur();
});
tablaWrap.addEventListener('click', e => {
  const th = e.target.closest('[data-orden]');
  if (th && datos) {
    const key = th.dataset.orden;
    // asc -> desc -> prioridad por defecto
    if (orden.key !== key) orden = { key, dir: 'asc' };
    else if (orden.dir === 'asc') orden = { key, dir: 'desc' };
    else orden = { key: null, dir: 'desc' };
    renderTabla();
    return;
  }
  const accion = e.target.closest('[data-accion]')?.dataset.accion;
  if (accion && accionCombo(accion, e.target)) return;
  if (accion === 'quitar-vinculo') {
    const tr = e.target.closest('tr[data-clave]');
    if (tr) { tr.querySelector('.v-codigo').value = ''; guardarVinculo(tr, 'codigo'); }
  }
  if (accion === 'usar-presentacion') {
    const tr = e.target.closest('tr[data-clave]');
    if (tr) { tr.querySelector('.v-unidades').value = ''; guardarVinculo(tr, 'unidades'); }
  }
  if (accion === 'importar') $('archivo').click();
  if (accion === 'reintentar') cargarControl();
});

// ── Filtros, chips y KPIs clickeables ────────────────────────────────────────
function refrescarVista() { if (datos) { renderKpis(); renderTabla(); } }
for (const id of ['f-buscar', 'f-visible', 'f-stock']) $(id).addEventListener('input', refrescarVista);
$('f-linea').addEventListener('change', e => { filtroLinea = e.target.value; refrescarVista(); });
function alternarEstado(valor) {
  filtroEstado = filtroEstado === valor ? '' : valor;
  refrescarVista();
}
$('kpis').addEventListener('click', e => {
  const b = e.target.closest('[data-filtro]');
  if (b && datos) alternarEstado(b.dataset.filtro);
});
$('chips').addEventListener('click', e => {
  const b = e.target.closest('[data-estado]');
  if (!b || !datos) return;
  filtroEstado = b.dataset.estado;
  refrescarVista();
});
$('f-limpiar').addEventListener('click', () => {
  filtroEstado = '';
  filtroLinea = ''; $('f-linea').value = '';
  $('f-buscar').value = ''; $('f-visible').value = ''; $('f-stock').value = '';
  refrescarVista();
  $('f-buscar').focus();
});

// ── Importar ─────────────────────────────────────────────────────────────────
const MAX_BYTES = 10 * 1024 * 1024;
$('importar').addEventListener('click', () => $('archivo').click());
$('archivo').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!/\.csv$/i.test(file.name)) { avisar(`"${file.name}" no es un archivo .csv.`, 'error'); return; }
  if (file.size > MAX_BYTES) { avisar('El archivo supera los 10 MB.', 'error'); return; }
  const btn = $('importar');
  btn.disabled = true;
  btn.textContent = 'Importando...';
  avisar('');
  try {
    const datosForm = new FormData();
    datosForm.append('archivo', file);
    const r = await api('/api/tn-precios/importar', { method: 'POST', body: datosForm });
    const rep = r.skuRepetidos > 0 ? ` Hay ${fmtInt(r.skuRepetidos)} SKU repetidos: cada fila se controla igual, revisalos.` : '';
    filtroEstado = '';
    await cargarControl();
    avisar(`Se importaron ${fmtInt(r.importadas)} filas (${fmtInt(r.conSku)} con SKU, ${fmtInt(r.sinSku)} sin SKU).${rep}`);
  } catch (err) {
    avisar(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Importar bajada de TN';
  }
});

// ── Exportar (con confirmación) ──────────────────────────────────────────────
const dlgExport = $('dlg-export');
$('exportar').addEventListener('click', () => {
  const filas = datos?.filas || [];
  const urls = new Set(filas.filter(f => f.estado === 'desviada').map(f => f.url));
  if (!urls.size) return;
  const cuantas = filas.filter(f => urls.has(f.url)).length;
  const desv = filas.filter(f => f.estado === 'desviada').length;
  $('dlg-resumen').innerHTML = `Se exportan <strong>${fmtInt(urls.size)}</strong> ${urls.size === 1 ? 'producto' : 'productos'} con precios desviados, `
    + `<strong>${fmtInt(cuantas)}</strong> filas en total (padre y variantes); de ellas <strong>${fmtInt(desv)}</strong> cambian de precio.`;
  dlgExport.showModal();
});
$('dlg-cancelar').addEventListener('click', () => dlgExport.close());

async function descargarCsv() {
  const btn = $('dlg-confirmar');
  btn.disabled = true;
  avisar('');
  try {
    let r;
    try { r = await fetch('/api/tn-precios/exportar'); } catch (_e) { throw new Error('No se pudo conectar con el servidor.'); }
    if (r.status === 401) throw new Error('La sesión venció. Recargá la página e iniciá sesión de nuevo.');
    if (r.status === 403) throw new Error('No tenés acceso a este módulo.');
    if (r.status === 409) throw new Error('No hay filas desviadas: no hay nada para exportar.');
    if (!r.ok) {
      let msg = `Error ${r.status} del servidor.`;
      try { msg = (await r.json()).error || msg; } catch (_e) { /* sin JSON */ }
      throw new Error(msg);
    }
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tiendanube_precios_corregidos.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    dlgExport.close();
    avisar('CSV exportado. Probá la reimportación en TN con un solo producto antes de subir todo.');
  } catch (err) {
    dlgExport.close();
    avisar(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}
$('dlg-confirmar').addEventListener('click', descargarCsv);

// ── Configuración ────────────────────────────────────────────────────────────
const CAMPOS_CFG = { 'c-recargo': 'recargoPct', 'c-tol': 'toleranciaPct', 'c-paso': 'redondeoPaso' };
// Vista previa de la fórmula con lo que hay escrito (aunque no esté guardado).
function previewFormula() {
  const v = id => parseNum($(id).value);
  const r = v('c-recargo'), t = v('c-tol'), p = v('c-paso');
  if (![r, t, p].every(Number.isFinite)) { $('cfg-formula').textContent = 'Completá los tres campos para ver la fórmula.'; return; }
  const k = 1 + r / 100;
  $('cfg-formula').innerHTML = `Esperado = carta × unidades × <b>${fmtDec(k)}</b>`
    + `${p > 0 ? `, redondeado a múltiplos de <b>${fmtMoney(p)}</b>` : ', sin redondeo'}. `
    + `Se marca <b>ok</b> hasta <b>±${fmtDec(t)} %</b> de desvío. Ej.: carta $1.000 → <b>${fmtMoney(1000 * k)}</b>${p > 0 ? ' antes de redondear' : ''}.`;
}

function pintarConfig() {
  for (const [id, k] of Object.entries(CAMPOS_CFG)) $(id).value = config[k] ?? '';
  $('cfg-resumen').textContent = `carta × ${fmtDec(1 + (num(config.recargoPct) ?? 0) / 100)} · tolerancia ±${fmtDec(num(config.toleranciaPct) ?? 0)} %`;
  previewFormula();
}

async function cargarConfig() {
  try {
    config = await api('/api/tn-precios/config');
    pintarConfig();
  } catch (err) {
    $('cfg-error').hidden = false;
    $('cfg-error').textContent = `No se pudo leer la configuración: ${err.message}`;
  }
}

function leerConfig() {
  const cfg = {};
  for (const [id, k] of Object.entries(CAMPOS_CFG)) {
    const crudo = $(id).value.trim();
    const n = parseNum(crudo);
    const mal = crudo === '' || !Number.isFinite(n) || n < 0;
    $(id).setAttribute('aria-invalid', String(mal));
    if (mal) return { error: 'Completá todos los campos con números válidos (0 o más).', foco: id };
    cfg[k] = n;
  }
  return { cfg };
}

async function guardarConfig(cfg) {
  const btn = $('cfg-guardar');
  btn.disabled = true;
  btn.textContent = 'Guardando...';
  $('cfg-error').hidden = true;
  try {
    config = await api('/api/tn-precios/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg),
    }, 'No tenés permiso para cambiar la configuración (hace falta el permiso precios-config).') || cfg;
    pintarConfig();
    await cargarControl();
    avisar('Configuración guardada y tabla recalculada.');
  } catch (err) {
    $('cfg-error').hidden = false;
    $('cfg-error').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar configuración';
  }
}

for (const id of Object.keys(CAMPOS_CFG)) $(id).addEventListener('input', previewFormula);
$('cfg-form').addEventListener('submit', e => {
  e.preventDefault();
  if (!config) return;
  const r = leerConfig();
  if (r.error) { $('cfg-error').hidden = false; $('cfg-error').textContent = r.error; $(r.foco).focus(); return; }
  guardarConfig(r.cfg);
});

renderTabs();
cargarConfig();
cargarControl();
