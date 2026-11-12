const $ = id => document.getElementById(id);
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtMoney = n => '$' + Number(n).toLocaleString('es-AR', { maximumFractionDigits: 0 });
const fmtInt = n => Math.round(Number(n) || 0).toLocaleString('es-AR');
const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
const parseNum = s => Number(String(s).trim().replace(',', '.'));

const ESTADOS = {
  ok: { txt: 'Ok', chip: 'chip--ok' },
  desviada: { txt: 'Desviada', chip: 'chip--crit' },
  sin_vincular: { txt: 'Sin vincular', chip: 'chip--warn' },
  sin_carta: { txt: 'Sin carta', chip: 'chip--warn' },
  sin_margen: { txt: 'Sin margen', chip: 'chip--warn' },
  sin_precio: { txt: 'Sin precio', chip: 'chip--gris' },
};
const ENVIO = { gratis: 'Gratis', comprador: 'Comprador', sin: 'Sin envío', nd: '-' };
const CUOTAS = { no: 'No', agregar: 'Agregar', interes_bajo: 'Interés bajo' };

let datos = null; // respuesta de /control
let config = null; // respuesta de /config

function avisar(texto, tipo) {
  const el = $('aviso');
  if (!texto) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.className = tipo === 'error' ? 'error' : 'card fade-in';
  el.textContent = texto;
}

async function api(url, opts) {
  let r;
  try { r = await fetch(url, opts); } catch (_e) { throw new Error('No se pudo conectar con el servidor.'); }
  if (r.status === 401) throw new Error('La sesión venció. Recargá la página e iniciá sesión de nuevo.');
  if (r.status === 403) throw new Error('No tenés acceso a este módulo.');
  let cuerpo = null;
  try { cuerpo = await r.json(); } catch (_e) { /* sin JSON */ }
  if (!r.ok) throw new Error((cuerpo && cuerpo.error) || `Error ${r.status} del servidor.`);
  return cuerpo;
}

// ── KPIs ─────────────────────────────────────────────────────────────────────
function renderKpis() {
  const k = datos.kpis || {};
  const items = [
    { lbl: 'Activas', val: k.activas, sub: `${fmtInt(k.inactivas)} inactivas` },
    { lbl: 'Ok', val: k.ok, filtro: 'ok' },
    { lbl: 'Desviadas', val: k.desviadas, filtro: 'desviada' },
    { lbl: 'Sin vincular', val: k.sinVincular, filtro: 'sin_vincular' },
    { lbl: 'Sin carta', val: k.sinCarta, filtro: 'sin_carta' },
    { lbl: 'Sin margen', val: k.sinMargen, filtro: 'sin_margen' },
  ];
  const actual = $('f-estado').value;
  $('kpis').innerHTML = items.map(i => i.filtro
    ? `<button type="button" class="kpi click${actual === i.filtro ? ' on' : ''}" data-filtro="${i.filtro}" aria-pressed="${actual === i.filtro}"><div class="lbl">${i.lbl}</div><div class="val">${fmtInt(i.val)}</div></button>`
    : `<div class="kpi"><div class="lbl">${i.lbl}</div><div class="val">${fmtInt(i.val)}</div>${i.sub ? `<div class="sub">${escHtml(i.sub)}</div>` : ''}</div>`).join('');
}

// ── Tabla ────────────────────────────────────────────────────────────────────
function filtrar() {
  const q = $('f-buscar').value.trim().toLowerCase();
  const act = $('f-activa').value;
  const est = $('f-estado').value;
  const peso = f => f.estado === 'sin_vincular' ? Infinity : Math.abs(num(f.desvioPct) ?? -1);
  return (datos.filas || [])
    .filter(f => act === 'todas' || (act === 'activas') === !!f.activa)
    .filter(f => !est || f.estado === est)
    .filter(f => !q || `${f.id} ${f.titulo}`.toLowerCase().includes(q))
    .sort((a, b) => peso(b) - peso(a)); // sin vincular arriba, luego mayor |desvío|
}

function filaHtml(f) {
  const e = ESTADOS[f.estado] || { txt: f.estado, chip: 'chip--gris' };
  const d = num(f.desvioPct);
  const claseDesvio = f.estado === 'desviada' ? 't-crit' : f.estado === 'ok' ? 't-ok' : '';
  const id = escHtml(f.id);
  return `<tr data-id="${id}">
    <td class="nowrap">${id}</td>
    <td class="titulo-pub" title="${escHtml(f.titulo)}">${escHtml(f.titulo)}${f.activa ? '' : ' <span class="chip chip--gris">Inactiva</span>'}</td>
    <td><span class="chip ${e.chip}">${escHtml(e.txt)}</span></td>
    <td>${escHtml(ENVIO[f.envio] || '-')}</td>
    <td>${escHtml(CUOTAS[f.cuotas] || '-')}</td>
    <td class="num"><input class="celda-input v-codigo" inputmode="numeric" autocomplete="off" value="${escHtml(f.codigo ?? '')}" aria-label="Código SIGA de ${id}"></td>
    <td class="num"><input class="celda-input unid v-unidades" inputmode="numeric" autocomplete="off" value="${escHtml(f.unidades ?? 1)}" aria-label="Unidades de ${id}"></td>
    <td class="num">${num(f.carta) === null ? '-' : fmtMoney(f.carta)}</td>
    <td class="num">${num(f.esperado) === null ? '-' : fmtMoney(f.esperado)}</td>
    <td class="num">${num(f.precioMl) === null ? '-' : fmtMoney(f.precioMl)}</td>
    <td class="num ${claseDesvio}">${d === null ? '-' : (d > 0 ? '+' : '') + d.toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' %'}</td>
  </tr>`;
}

function renderTabla() {
  const wrap = $('tabla-wrap');
  const filas = filtrar();
  $('cuenta').textContent = `${fmtInt(filas.length)} de ${fmtInt((datos.filas || []).length)} publicaciones`;
  if (!filas.length) {
    wrap.innerHTML = `<p class="empty">${(datos.filas || []).length ? 'Ninguna publicación coincide con los filtros.' : 'Todavía no hay publicaciones. Importá la bajada de ML.'}</p>`;
    return;
  }
  wrap.innerHTML = `<table><thead><tr>
    <th scope="col">ID</th><th scope="col">Título</th><th scope="col">Control</th><th scope="col">Envío</th><th scope="col">Cuotas</th>
    <th scope="col" class="num">Código</th><th scope="col" class="num">Unid.</th><th scope="col" class="num">Carta</th>
    <th scope="col" class="num">Esperado</th><th scope="col" class="num">Precio ML</th><th scope="col" class="num">Desvío</th>
  </tr></thead><tbody>${filas.map(filaHtml).join('')}</tbody></table>`;
}

async function cargarControl() {
  try {
    datos = await api('/api/ml-precios/control');
  } catch (err) {
    $('kpis').innerHTML = '';
    $('cuenta').textContent = '';
    $('tabla-wrap').innerHTML = `<div class="error" role="alert">${escHtml(err.message)}</div>`;
    return;
  }
  $('importado').textContent = datos.importadoEn ? `Bajada importada: ${new Date(datos.importadoEn).toLocaleString('es-AR')}` : 'Sin bajada importada';
  renderKpis();
  renderTabla();
}

// ── Edición inline de vínculo ────────────────────────────────────────────────
async function guardarVinculo(tr) {
  const cod = tr.querySelector('.v-codigo');
  const uni = tr.querySelector('.v-unidades');
  const crudoCod = cod.value.trim();
  const unidades = Number(uni.value.trim() || 1);
  const codigo = crudoCod === '' ? null : Number(crudoCod);
  const malCod = codigo !== null && !(Number.isInteger(codigo) && codigo > 0);
  const malUni = !(Number.isInteger(unidades) && unidades >= 1);
  cod.setAttribute('aria-invalid', String(malCod));
  uni.setAttribute('aria-invalid', String(malUni));
  if (malCod || malUni) { avisar(malCod ? 'El código debe ser un entero positivo.' : 'Las unidades deben ser un entero de 1 o más.', 'error'); return; }
  const id = tr.dataset.id;
  const previo = (datos.filas || []).find(f => String(f.id) === id);
  if (previo && (previo.codigo ?? null) === codigo && Number(previo.unidades ?? 1) === unidades) return; // sin cambios
  avisar('');
  cod.disabled = uni.disabled = true;
  try {
    await api(`/api/ml-precios/vinculos/${encodeURIComponent(id)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codigo, unidades }),
    });
    await cargarControl();
  } catch (err) {
    cod.disabled = uni.disabled = false;
    cod.setAttribute('aria-invalid', 'true');
    avisar(`No se guardó ${id}: ${err.message}`, 'error');
  }
}

$('tabla-wrap').addEventListener('change', e => {
  const tr = e.target.closest('tr[data-id]');
  if (tr && e.target.classList.contains('celda-input')) guardarVinculo(tr);
});
$('tabla-wrap').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.classList.contains('celda-input')) e.target.blur();
});

// ── Filtros y KPIs clickeables ───────────────────────────────────────────────
for (const id of ['f-buscar', 'f-activa', 'f-estado']) {
  $(id).addEventListener('input', () => { if (datos) { renderKpis(); renderTabla(); } });
}
$('kpis').addEventListener('click', e => {
  const b = e.target.closest('[data-filtro]');
  if (!b || !datos) return;
  $('f-estado').value = $('f-estado').value === b.dataset.filtro ? '' : b.dataset.filtro;
  renderKpis();
  renderTabla();
});

// ── Importar ─────────────────────────────────────────────────────────────────
const MAX_BYTES = 10 * 1024 * 1024;
$('importar').addEventListener('click', () => $('archivo').click());
$('archivo').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!/\.xlsx$/i.test(file.name)) { avisar(`"${file.name}" no es un archivo .xlsx.`, 'error'); return; }
  if (file.size > MAX_BYTES) { avisar('El archivo supera los 10 MB.', 'error'); return; }
  const btn = $('importar');
  btn.disabled = true;
  btn.textContent = 'Importando...';
  avisar('');
  try {
    const datosForm = new FormData();
    datosForm.append('archivo', file);
    const r = await api('/api/ml-precios/importar', { method: 'POST', body: datosForm });
    avisar(`Se importaron ${fmtInt(r.importadas)} publicaciones (${fmtInt(r.variantesIgnoradas)} variantes ignoradas). ${fmtInt(r.nuevasSinVincular)} nuevas sin vincular.`);
    $('f-estado').value = r.nuevasSinVincular > 0 ? 'sin_vincular' : '';
    await cargarControl();
  } catch (err) {
    avisar(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Importar bajada de ML';
  }
});

// ── Configuración ────────────────────────────────────────────────────────────
const CAMPOS_CFG = {
  'c-comision': c => c.comisionPct, 'c-envio': c => c.envioGratisPct, 'c-tol': c => c.toleranciaPct, 'c-paso': c => c.redondeoPaso,
  'c-cuo-no': c => c.cuotasPct && c.cuotasPct.no, 'c-cuo-agregar': c => c.cuotasPct && c.cuotasPct.agregar,
  'c-cuo-bajo': c => c.cuotasPct && c.cuotasPct.interes_bajo,
  'c-min': c => c.tablaMargen && c.tablaMargen.minPct, 'c-max': c => c.tablaMargen && c.tablaMargen.maxPct,
  'c-esc': c => c.tablaMargen && c.tablaMargen.escalones,
  'c-desde': c => c.tablaMargen && c.tablaMargen.rango && c.tablaMargen.rango.desde,
  'c-hasta': c => c.tablaMargen && c.tablaMargen.rango && c.tablaMargen.rango.hasta,
};

function pintarConfig() {
  for (const [id, get] of Object.entries(CAMPOS_CFG)) $(id).value = get(config) ?? '';
  $('cfg-filas').hidden = !(config.tablaMargen && Array.isArray(config.tablaMargen.filas) && config.tablaMargen.filas.length);
}

async function cargarConfig() {
  try {
    config = await api('/api/ml-precios/config');
    pintarConfig();
  } catch (err) {
    $('cfg-error').hidden = false;
    $('cfg-error').textContent = `No se pudo leer la configuración: ${err.message}`;
  }
}

function leerConfig() {
  const v = {};
  for (const id of Object.keys(CAMPOS_CFG)) {
    const crudo = $(id).value.trim();
    const n = parseNum(crudo);
    const mal = crudo === '' || !Number.isFinite(n);
    $(id).setAttribute('aria-invalid', String(mal));
    if (mal) return { error: 'Completá todos los campos con números válidos.', foco: id };
    v[id] = n;
  }
  const tm = { ...(config.tablaMargen || {}), minPct: v['c-min'], maxPct: v['c-max'], escalones: v['c-esc'], rango: { desde: v['c-desde'], hasta: v['c-hasta'] } };
  return { cfg: {
    ...config, comisionPct: v['c-comision'], envioGratisPct: v['c-envio'], toleranciaPct: v['c-tol'], redondeoPaso: v['c-paso'],
    cuotasPct: { no: v['c-cuo-no'], agregar: v['c-cuo-agregar'], interes_bajo: v['c-cuo-bajo'] }, tablaMargen: tm,
  } };
}

async function guardarConfig(cfg) {
  const btn = $('cfg-guardar');
  btn.disabled = true;
  btn.textContent = 'Guardando...';
  $('cfg-error').hidden = true;
  try {
    config = await api('/api/ml-precios/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) }) || cfg;
    pintarConfig();
    avisar('Configuración guardada.');
    await cargarControl();
  } catch (err) {
    $('cfg-error').hidden = false;
    $('cfg-error').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar configuración';
  }
}

$('cfg-form').addEventListener('submit', e => {
  e.preventDefault();
  if (!config) return;
  const r = leerConfig();
  if (r.error) { $('cfg-error').hidden = false; $('cfg-error').textContent = r.error; $(r.foco).focus(); return; }
  guardarConfig(r.cfg);
});

// Quita las filas manuales y guarda: vuelve a usar min/max/escalones/rango.
$('cfg-auto').addEventListener('click', () => {
  if (!config) return;
  const r = leerConfig();
  if (r.error) { $('cfg-error').hidden = false; $('cfg-error').textContent = r.error; $(r.foco).focus(); return; }
  const { filas, ...tm } = r.cfg.tablaMargen; // eslint-disable-line no-unused-vars
  guardarConfig({ ...r.cfg, tablaMargen: tm });
});

cargarConfig();
cargarControl();
