// ── Tab Costos: formulario agrupado, vista previa en vivo y un solo Guardar (PUT /config) ──
const MAX_EXTRAS = 20;
const MAX_TRAMOS = 30;
const MAX_CUOTAS = 12;
let costosSucio = false;

// id del input -> lectura desde la config.
const CAMPOS_CFG = {
  'c-envio-monto': c => c.envioMonto, 'c-umbral': c => c.envioGratisDesde, 'c-fijo': c => c.costoFijoMonto, 'c-comision': c => c.comisionPct,
  'c-impuestos': c => c.impuestosPct, 'c-tol': c => c.toleranciaPct, 'c-paso': c => c.redondeoPaso,
  'c-cuo-base': c => c.cuotasBasePct,
};

function mostrarErrorCfg(texto) {
  const e = $('cfg-error');
  e.hidden = !texto; e.textContent = texto || '';
  if (texto) e.scrollIntoView({ block: 'nearest' });
}

function marcarSucio(sucio) {
  costosSucio = sucio;
  $('cfg-estado').textContent = sucio ? 'Hay cambios sin guardar.' : 'Al guardar se recalcula Control.';
  $('cfg-estado').className = `text-sm ${sucio ? 't-warn font-semibold' : 'text-gris'}`;
}

// ── Extras ───────────────────────────────────────────────────────────────────
function extraFilaHtml(x, i) {
  const n = i + 1;
  return `<tr data-i="${i}">
    <td><input class="celda-input x-nombre" style="width:100%;min-width:180px;text-align:left" maxlength="60" autocomplete="off" placeholder="Ej: packaging" value="${escHtml(x.nombre ?? '')}" aria-label="Nombre del extra ${n}"></td>
    <td><select class="celda-input x-tipo" style="width:110px" aria-label="Tipo del extra ${n}">
      <option value="$"${x.tipo === '$' ? ' selected' : ''}>Monto ($)</option><option value="%"${x.tipo === '%' ? ' selected' : ''}>Porcentaje (%)</option></select></td>
    <td class="num"><input class="celda-input x-valor" style="width:100px" inputmode="decimal" autocomplete="off" value="${escHtml(x.valor ?? 0)}" aria-label="Valor del extra ${n}"></td>
    <td><button type="button" class="btn btn-peligro sm x-quitar" aria-label="Quitar extra ${n}">Quitar</button></td>
  </tr>`;
}

function pintarExtras(extras) {
  $('extras-wrap').innerHTML = extras.length
    ? `<table><thead><tr><th scope="col">Nombre</th><th scope="col">Tipo</th><th scope="col" class="num">Valor</th><th scope="col"><span class="sr-only">Acciones</span></th></tr></thead><tbody>${extras.map(extraFilaHtml).join('')}</tbody></table>`
    : '<p class="empty" style="text-align:left;padding-left:0">No hay extras. Agregá uno si tenés otro costo por venta.</p>';
  $('extra-agregar').disabled = extras.length >= MAX_EXTRAS;
}

// Lee la tabla tal cual está (sin validar) para poder agregar/quitar sin perder lo tipeado.
function extrasDelDom() {
  return [...document.querySelectorAll('#extras-wrap tbody tr')].map(tr => ({
    nombre: tr.querySelector('.x-nombre').value, tipo: tr.querySelector('.x-tipo').value, valor: tr.querySelector('.x-valor').value,
  }));
}

$('extra-agregar').addEventListener('click', () => {
  pintarExtras([...extrasDelDom(), { nombre: '', tipo: '$', valor: 0 }]);
  const filas = document.querySelectorAll('#extras-wrap .x-nombre');
  filas[filas.length - 1].focus();
  marcarSucio(true);
  renderPreview();
});
$('extras-wrap').addEventListener('click', e => {
  const b = e.target.closest('.x-quitar');
  if (!b) return;
  const i = Number(b.closest('tr').dataset.i);
  pintarExtras(extrasDelDom().filter((_x, j) => j !== i));
  $('extra-agregar').focus();
  marcarSucio(true);
  renderPreview();
});

// ── Tablas editables (envío por peso, cuotas, cargo fijo por precio) ─────────
// ids: `${n}-wrap`, `${n}-error`, `${n}-agregar`; inputs con clase `t-<campo>`.
const TABLAS = {
  envio: { max: MAX_TRAMOS, vacio: 'Sin tramos: todas las publicaciones usan el envío por defecto.', k: 'topeKg', v: 'valor',
    bonif: true, cols: [['topeKg', 'Tope (kg)', 100, 'Tope en kg'], ['valor', 'Valor ($)', 120, 'Valor en pesos']],
    okK: n => n > 0, okV: n => n >= 0, msgK: 'el tope debe ser un número de kg mayor a 0', msgV: 'el valor debe ser un número de 0 o más', dup: 'el tope' },
  cuotas: { max: MAX_CUOTAS, vacio: 'Sin recargos: ninguna cantidad de cuotas suma recargo.', k: 'cuotas', v: 'recargoPct',
    cols: [['cuotas', 'Cuotas', 100, 'Cantidad de cuotas'], ['recargoPct', 'Recargo (%)', 120, 'Recargo en porcentaje']],
    okK: n => Number.isInteger(n) && n >= 1 && n <= 24, okV: n => n >= 0, msgK: 'las cuotas deben ser un entero de 1 a 24', msgV: 'el recargo debe ser un número de 0 o más', dup: 'la cantidad de cuotas' },
  fijo: { max: MAX_TRAMOS, vacio: 'Sin tramos: todas las publicaciones usan el cargo fijo sin tramo.', k: 'precioMax', v: 'valor',
    cols: [['precioMax', 'Precio máx ($)', 120, 'Precio máximo en pesos'], ['valor', 'Valor ($)', 120, 'Valor en pesos']],
    okK: n => n > 0, okV: n => n >= 0, msgK: 'el precio máx debe ser un número mayor a 0', msgV: 'el valor debe ser un número de 0 o más', dup: 'el precio máx' },
};
const wrapDe = n => document.querySelectorAll(`#${n}-wrap tbody tr`);

function tablaFilaHtml(n, t, i) {
  const celdas = TABLAS[n].cols.map(([k, , w, lab]) => `<td class="num"><input class="celda-input t-${k}" style="width:${w}px" inputmode="decimal" autocomplete="off" value="${escHtml(t[k] ?? '')}" aria-label="${lab} de la fila ${i + 1}"></td>`).join('');
  const bon = TABLAS[n].bonif ? '<td class="num t-bonif-cel" hidden></td>' : '';
  return `<tr data-i="${i}">${celdas}${bon}<td><button type="button" class="btn btn-peligro sm t-quitar" aria-label="Quitar fila ${i + 1}">Quitar</button></td></tr>`;
}

function pintarTabla(n, filas) {
  const d = TABLAS[n];
  $(`${n}-wrap`).innerHTML = filas.length
    ? `<table><thead><tr>${d.cols.map(([, t]) => `<th scope="col" class="num">${t}</th>`).join('')}${d.bonif ? '<th scope="col" class="num th-bonif" hidden>Con bonificación</th>' : ''}<th scope="col"><span class="sr-only">Acciones</span></th></tr></thead><tbody>${filas.map((t, i) => tablaFilaHtml(n, t, i)).join('')}</tbody></table>`
    : `<p class="empty" style="text-align:left;padding-left:0">${d.vacio}</p>`;
  $(`${n}-agregar`).disabled = filas.length >= d.max;
}

// Lee la tabla tal cual está (sin validar) para poder agregar/quitar sin perder lo tipeado.
const tablaDelDom = n => [...wrapDe(n)].map(tr => ({ [TABLAS[n].k]: tr.querySelector(`.t-${TABLAS[n].k}`).value, [TABLAS[n].v]: tr.querySelector(`.t-${TABLAS[n].v}`).value }));

// Valida y ordena por la clave. Devuelve { filas, error, malIdx } (malIdx = índice en el orden del DOM).
function validarTabla(n, crudas) {
  const d = TABLAS[n];
  const mal = (i, error) => ({ filas: [], error, malIdx: i });
  if (crudas.length > d.max) return mal(-1, `Máximo ${d.max} filas.`);
  const filas = crudas.map((t, i) => ({ i, k: parseNum(t[d.k]), v: parseNum(t[d.v]), vacioK: String(t[d.k]).trim() === '', vacioV: String(t[d.v]).trim() === '' }));
  for (const f of filas) {
    if (f.vacioK || !Number.isFinite(f.k) || !d.okK(f.k)) return mal(f.i, `Fila ${f.i + 1}: ${d.msgK}.`);
    if (f.vacioV || !Number.isFinite(f.v) || !d.okV(f.v)) return mal(f.i, `Fila ${f.i + 1}: ${d.msgV}.`);
  }
  const orden = [...filas].sort((a, b) => a.k - b.k);
  for (let j = 1; j < orden.length; j++) {
    if (orden[j].k === orden[j - 1].k) return mal(orden[j].i, `Fila ${orden[j].i + 1}: ${d.dup} ${orden[j].k} está repetido; cada uno debe ser distinto.`);
  }
  return { filas: orden.map(f => ({ [d.k]: f.k, [d.v]: f.v })), error: '', malIdx: -2 };
}

// Para la vista previa: ignora filas incompletas o inválidas y ordena por la clave.
function tablaTolerante(n) {
  const d = TABLAS[n];
  return tablaDelDom(n).map(t => ({ [d.k]: parseNum(t[d.k]), [d.v]: parseNum(t[d.v]) }))
    .filter(t => Number.isFinite(t[d.k]) && d.okK(t[d.k]) && Number.isFinite(t[d.v]) && d.okV(t[d.v]))
    .sort((a, b) => a[d.k] - b[d.k]);
}

// Columna de solo lectura "Con bonificación" (valor x 0,5) mientras el check está activo.
function refrescarBonif() {
  const on = $('c-envio-bonif').checked;
  document.querySelectorAll('#envio-wrap .th-bonif, #envio-wrap .t-bonif-cel').forEach(el => { el.hidden = !on; });
  if (!on) return;
  wrapDe('envio').forEach(tr => {
    const v = parseNum(tr.querySelector('.t-valor').value);
    tr.querySelector('.t-bonif-cel').textContent = Number.isFinite(v) && tr.querySelector('.t-valor').value.trim() !== '' ? fmtMoney2(PreciosEsquema.r2(v * 0.5)) : '';
  });
}

function mostrarTablasEstado() {
  refrescarBonif();
  for (const n of Object.keys(TABLAS)) {
    const r = validarTabla(n, tablaDelDom(n));
    wrapDe(n).forEach((tr, i) => tr.querySelectorAll('input').forEach(inp => inp.setAttribute('aria-invalid', String(r.malIdx === i))));
    const e = $(`${n}-error`);
    e.hidden = !r.error; e.textContent = r.error;
  }
}

for (const n of Object.keys(TABLAS)) {
  const d = TABLAS[n];
  $(`${n}-agregar`).addEventListener('click', () => {
    const act = tablaDelDom(n);
    const ult = act.length ? parseNum(act[act.length - 1][d.k]) : 0;
    const sig = Number.isFinite(ult) ? (n === 'cuotas' ? ult + 1 : ult) : '';
    pintarTabla(n, [...act, { [d.k]: sig, [d.v]: '' }]);
    const ins = document.querySelectorAll(`#${n}-wrap .t-${d.k}`);
    ins[ins.length - 1].focus();
    ins[ins.length - 1].select();
    marcarSucio(true);
    renderPreview();
  });
  $(`${n}-wrap`).addEventListener('click', e => {
    const b = e.target.closest('.t-quitar');
    if (!b) return;
    const i = Number(b.closest('tr').dataset.i);
    pintarTabla(n, tablaDelDom(n).filter((_t, j) => j !== i));
    $(`${n}-agregar`).focus();
    marcarSucio(true);
    renderPreview();
  });
}

// ── Vista previa ─────────────────────────────────────────────────────────────
// Config "tolerante" desde el formulario (lo vacío o inválido vale 0): solo para la vista previa, no valida ni guarda.
function cfgTolerante() {
  const n = id => { const v = parseNum($(id).value); return Number.isFinite(v) ? v : 0; };
  return {
    ...config,
    envioMonto: n('c-envio-monto'), costoFijoMonto: n('c-fijo'), comisionPct: n('c-comision'), impuestosPct: n('c-impuestos'),
    toleranciaPct: n('c-tol'), redondeoPaso: n('c-paso'),
    cuotasBasePct: n('c-cuo-base'), tablaCuotas: tablaTolerante('cuotas'), tablaCostoFijo: tablaTolerante('fijo'),
    tablaEnvio: tablaTolerante('envio'), envioGratisDesde: n('c-umbral'), envioBonificado: $('c-envio-bonif').checked,
    extras: extrasDelDom().map(x => ({ nombre: x.nombre.trim(), tipo: x.tipo, valor: Math.max(0, parseNum(x.valor) || 0) })),
  };
}

function renderPreview() {
  if (!config) return;
  const real = cfgTolerante();
  const cfg = { ...real, envioBonificado: $('p-bonif').checked }; // el check del simulador pisa solo el cálculo del ejemplo
  $('p-bonif-nota').hidden = cfg.envioBonificado === real.envioBonificado;
  mostrarTablasEstado();
  const carta = parseNum($('p-carta').value), unid = parseNum($('p-unid').value);
  const wrap = $('prev-wrap');
  if (!(carta > 0) || !(Number.isInteger(unid) && unid >= 1)) { wrap.innerHTML = '<p class="empty">Escribí un precio de carta y unidades válidos para ver el ejemplo.</p>'; return; }
  const porKg = $('p-porkg').checked;
  const peso = $('p-peso').value.trim() === '' ? null : parseNum($('p-peso').value);
  if (porKg && !(peso > 0)) { wrap.innerHTML = '<p class="empty">Falta el peso (kg): con precio por kg el esperado se calcula como carta &times; peso.</p>'; return; }
  let f;
  try { f = calcularEsperado(carta, unid, $('p-envio').value, 'no', cfg, peso, $('p-cuotas').value.trim() === '' ? null : parseNum($('p-cuotas').value), porKg); } catch (_e) { f = null; }
  if (!f || !Number.isFinite(f.gastosPct) || f.esperado == null) { wrap.innerHTML = '<p class="empty">Los porcentajes de gastos suman 100 % o más: con esos números no se puede calcular.</p>'; return; }
  wrap.innerHTML = desgloseHtml(f, cfg, true);
}

// ── Pintar / leer ────────────────────────────────────────────────────────────
function pintarConfig() {
  for (const [id, get] of Object.entries(CAMPOS_CFG)) { $(id).value = get(config) ?? 0; $(id).removeAttribute('aria-invalid'); }
  pintarExtras(Array.isArray(config.extras) ? config.extras : []);
  $('c-envio-bonif').checked = !!config.envioBonificado;
  $('p-bonif').checked = !!config.envioBonificado;
  for (const [n, campo] of [['envio', 'tablaEnvio'], ['cuotas', 'tablaCuotas'], ['fijo', 'tablaCostoFijo']]) pintarTabla(n, Array.isArray(config[campo]) ? config[campo] : []);
  const her = num(config.envioGratisPct);
  $('c-heredado').hidden = !(her > 0);
  $('c-heredado').textContent = her > 0
    ? `Hay un envío gratis de ${her} % heredado de una versión anterior; se sigue sumando a los gastos. Pasalo a pesos en "Envío gratis" (Costos fijos) y dejalo en 0.`
    : '';
  marcarSucio(false);
  renderPreview();
}

async function cargarConfig() {
  try {
    config = await api('/api/ml-precios/config');
    mostrarErrorCfg('');
    pintarConfig();
  } catch (err) {
    mostrarErrorCfg(`No se pudo leer la configuración: ${err.message}`);
  }
}

function leerExtras() {
  const extras = [];
  for (const tr of document.querySelectorAll('#extras-wrap tbody tr')) {
    const nom = tr.querySelector('.x-nombre'), val = tr.querySelector('.x-valor');
    const nombre = nom.value.trim();
    const valor = parseNum(val.value);
    const malNom = nombre === '' || nombre.length > 60;
    const malVal = val.value.trim() === '' || !Number.isFinite(valor) || valor < 0;
    nom.setAttribute('aria-invalid', String(malNom));
    val.setAttribute('aria-invalid', String(malVal));
    if (malNom) return { error: 'Cada extra necesita un nombre de hasta 60 caracteres.', foco: nom };
    if (malVal) return { error: 'El valor de cada extra debe ser un número de 0 o más.', foco: val };
    extras.push({ nombre, tipo: tr.querySelector('.x-tipo').value, valor });
  }
  return { extras };
}

function leerConfig() {
  const v = {};
  for (const id of Object.keys(CAMPOS_CFG)) {
    const crudo = $(id).value.trim();
    const n = parseNum(crudo);
    const mal = crudo === '' || !Number.isFinite(n) || n < 0;
    $(id).setAttribute('aria-invalid', String(mal));
    if (mal) return { error: `Completá "${(document.querySelector(`label[for="${id}"]`) || {}).textContent || id}" con un número de 0 o más.`, foco: $(id) };
    v[id] = n;
  }
  const ex = leerExtras();
  if (ex.error) return ex;
  const tablas = {};
  for (const n of Object.keys(TABLAS)) {
    const r = validarTabla(n, tablaDelDom(n));
    if (r.error) return { error: r.error, foco: wrapDe(n)[Math.max(r.malIdx, 0)]?.querySelector('input') || $(`${n}-agregar`) };
    tablas[n] = r.filas;
  }
  const sumaExtrasPct = ex.extras.filter(x => x.tipo === '%').reduce((a, x) => a + x.valor, 0);
  const maxCuota = v['c-cuo-base'] + Math.max(0, ...tablas.cuotas.map(t => t.recargoPct));
  if (v['c-comision'] + maxCuota + v['c-impuestos'] + sumaExtrasPct + (num(config.envioGratisPct) || 0) >= 100) {
    return { error: 'Los porcentajes (comisión, cuotas, impuestos y extras en %) suman 100 o más: no habría precio posible.', foco: $('c-comision') };
  }
  return { cfg: {
    ...config, envioMonto: v['c-envio-monto'], envioGratisDesde: v['c-umbral'], envioBonificado: $('c-envio-bonif').checked, tablaEnvio: tablas.envio, tablaCuotas: tablas.cuotas, tablaCostoFijo: tablas.fijo, costoFijoMonto: v['c-fijo'], comisionPct: v['c-comision'], impuestosPct: v['c-impuestos'],
    toleranciaPct: v['c-tol'], redondeoPaso: v['c-paso'],
    cuotasBasePct: v['c-cuo-base'], extras: ex.extras,
  } };
}

async function guardarConfig(cfg) {
  const btn = $('cfg-guardar');
  btn.disabled = true;
  btn.textContent = 'Guardando...';
  mostrarErrorCfg('');
  try {
    config = await api('/api/ml-precios/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) }) || cfg;
    pintarConfig();
    await cargarControl();
    avisar('Cambios guardados. Control ya usa los nuevos costos.');
  } catch (err) {
    mostrarErrorCfg(`No se guardó: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar cambios';
  }
}

function enviarConfig(transformar) {
  if (!config) { mostrarErrorCfg('La configuración no está cargada. Recargá la página.'); return; }
  const r = leerConfig();
  if (r.error) { mostrarErrorCfg(r.error); r.foco.focus(); return; }
  guardarConfig(transformar ? transformar(r.cfg) : r.cfg);
}

$('cfg-form').addEventListener('submit', e => { e.preventDefault(); enviarConfig(); });
$('cfg-form').addEventListener('input', e => {
  if (e.target.id === 'c-envio-bonif') $('p-bonif').checked = e.target.checked; // el simulador sigue al check general
  if (e.target.closest('.preview')) { renderPreview(); return; } // el ejemplo no es config
  marcarSucio(true);
  renderPreview();
});
$('cfg-form').addEventListener('change', e => { if (e.target.closest('.preview')) renderPreview(); });
window.addEventListener('beforeunload', e => { if (costosSucio) { e.preventDefault(); e.returnValue = ''; } });
