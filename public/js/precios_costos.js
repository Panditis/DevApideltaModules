// ── Precios · Costos: resumen "Estructura de costos por tipo", IVA de venta y Departamentos + venta base ──
// Script clásico cargado después de precios_config_gastos.js: usa sus globales (fmtPctGastos) y los de los
// otros scripts de precios.html (esc, numOrNull, fmtPrecio, pedirJson, putJson, configCargada, cargarCostos,
// fraccCargado, refrescarAlertasProduccion, confirmar). Spec:
// docs/superpowers/specs/2026-10-02-precios-tab-costos-design.md. Espejo de lib/precios_costos.js:
// gastos%_T = variables% + Σ_d (costoMensual_d × imputacion_d,T / 100) ÷ ventaMensual_T × 100.
// Guardar = PUT /api/precios/config/departamentos; "Actualizar desde SIGA" = POST /api/precios/costos/venta-base/actualizar.
// IVA de venta (spec Parte D: se edita acá pero no es costo, va sobre el precio neto) = PUT /api/precios/config/iva-venta.

// ── Helpers puros (sin DOM; test/precios_costos_front.test.js) ──────────────────
const COSTOS_TIPOS = ['almacen', 'fraccionado', 'produccion'];
const COSTOS_NOMBRE_TIPO = { almacen: 'Reventa', fraccionado: 'Fraccionado', produccion: 'Producción' };
const r4Costos = n => Math.round(n * 1e4) / 1e4;
const numCostos = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// % que queda sin imputar a ningún tipo (negativo = la suma pasa de 100: error al guardar).
const noImputadoPct = imputacion => r4Costos(100 - COSTOS_TIPOS.reduce((s, t) => s + numCostos((imputacion || {})[t]), 0));

// $ mensual de departamentos que absorbe el tipo.
const costoImputadoCli = (deptos, tipo) => Math.round((deptos || [])
  .reduce((s, d) => s + numCostos(d && d.costoMensual) * numCostos(((d && d.imputacion) || {})[tipo]) / 100, 0) * 100) / 100;

// Venta mensual que se usa: manual ?? snapshot de SIGA ?? null (≤ 0 cuenta como faltante).
function ventaEfectivaCli(ventaBase, tipo) {
  const vb = ventaBase || {};
  const positivo = v => (typeof v === 'number' && v > 0 ? v : null);
  return positivo((vb.manual || {})[tipo]) ?? positivo(((vb.snapshot || {}).porTipo || {})[tipo]);
}

// Producción no absorbe departamentos con ventaBase.produccionSinDepartamentos (default true, spec Parte E.2).
const produccionSinDeptosCli = ventaBase => (ventaBase || {}).produccionSinDepartamentos !== false;

// % de departamentos sobre la venta del tipo: 0 sin costo imputado (o Producción con el flag), null si hay costo y falta la venta.
function deptosPctCli(deptos, ventaBase, tipo) {
  if (tipo === 'produccion' && produccionSinDeptosCli(ventaBase)) return 0;
  const costo = costoImputadoCli(deptos, tipo);
  if (costo === 0) return 0;
  const venta = ventaEfectivaCli(ventaBase, tipo);
  return venta == null ? null : r4Costos(costo / venta * 100);
}

// Body de PUT departamentos con lo editado (nombre recortado; vacíos → null, los valida el server).
function bodyDepartamentos(deptos, ventaBase, conservarPrecios) {
  return {
    items: (deptos || []).map(d => ({ ...(d.id ? { id: d.id } : {}), nombre: String(d.nombre || '').trim(),
      costoMensual: d.costoMensual ?? null,
      imputacion: Object.fromEntries(COSTOS_TIPOS.map(t => [t, ((d.imputacion || {})[t]) ?? null])) })),
    ventaBase: { meses: ventaBase.meses ?? null,
      manual: Object.fromEntries(COSTOS_TIPOS.map(t => [t, ((ventaBase.manual || {})[t]) ?? null])),
      ...(typeof ventaBase.produccionSinDepartamentos === 'boolean' ? { produccionSinDepartamentos: ventaBase.produccionSinDepartamentos } : {}) },
    conservarPrecios: conservarPrecios !== false,
  };
}

// Los errores del server nombran items[i].campo: se muestran como "Fila i+1 · campo".
const CAMPOS_DEPTO = { nombre: 'nombre', costoMensual: 'costo mensual', imputacion: '%' };
const mensajeErrorDepto = msg => String(msg || '')
  .replace(/items\[(\d+)\](?:\.(\w+))?(?:\.(\w+))?/g, (_, i, campo, tipo) =>
    `Fila ${Number(i) + 1}${campo ? ' · ' + (tipo ? `% ${COSTOS_NOMBRE_TIPO[tipo] || tipo}` : CAMPOS_DEPTO[campo] || campo) : ''}`);

const fmtPesosCostos = n => (n == null ? '—' : '$ ' + new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 }).format(n));
const fmtFechaCostos = iso => (iso ? String(iso).split('-').reverse().join('/') : '');

if (typeof module === 'object' && module.exports) {
  module.exports = { COSTOS_TIPOS, produccionSinDeptosCli, noImputadoPct, costoImputadoCli, ventaEfectivaCli, deptosPctCli, bodyDepartamentos,
    mensajeErrorDepto, fmtPesosCostos };
}

// ── Resumen "Estructura de costos por tipo" ────────────────────────────────────
const tdNum = (txt, cls = '') => `<td class="px-3 py-1.5 text-right tabular-nums ${cls}">${txt}</td>`;

function htmlNoAbsorbido(deptos) {
  if (!deptos.length) return '';
  return `<h3 class="text-sm font-semibold mt-5 mb-1">Departamentos — costo no absorbido</h3>
    <p class="text-[11px] text-gris mb-2">Parte del costo mensual que no se imputa a ningún tipo: no entra en ningún precio.</p>
    <table class="w-full text-sm cfg-tabla">
      <thead><tr><th class="text-left pr-3">Departamento</th>
        <th class="text-right px-3">Costo mensual</th><th class="text-right px-3">Imputado</th>
        <th class="text-right px-3">No absorbido</th></tr></thead>
      <tbody>${deptos.map(d => `<tr class="border-t border-borde"><td class="pr-3 py-1.5">${esc(d.nombre)}</td>
        ${tdNum(esc(fmtPesosCostos(d.costoMensual)))}${tdNum(esc(fmtPctGastos(d.imputadoPct)))}
        ${tdNum(esc(fmtPesosCostos(d.costoNoAbsorbido)), d.costoNoAbsorbido > 0 ? 'text-warn font-semibold' : 'text-gris')}</tr>`).join('')}</tbody>
    </table>`;
}

// La llama cargarCostos (precios_config.js) y "Actualizar desde SIGA" con la estructura del server.
function renderResumenCostos(cfg) {
  const ec = cfg.estructuraCostos || { porTipo: {}, departamentos: [] };
  const filas = COSTOS_TIPOS.map(t => {
    const e = ec.porTipo[t] || {};
    const faltaVenta = e.departamentosPct == null && e.costoImputado > 0;
    // Producción sin departamentos (spec Parte E.2): G = sólo variables; venta e imputado no se usan.
    const sinDeptos = t === 'produccion' && produccionSinDeptosCli(cfg.ventaBase);
    const deptos = sinDeptos ? 'no absorbe' : faltaVenta ? 'falta venta' : esc(fmtPctGastos(e.departamentosPct));
    return `<tr class="border-t border-borde"><td class="pr-3 py-2 font-semibold">${esc(COSTOS_NOMBRE_TIPO[t])}</td>
      ${tdNum(esc(fmtPctGastos(e.variablesPct)))}
      ${tdNum(deptos, sinDeptos ? 'text-gris' : faltaVenta ? 'text-crit font-semibold' : '')}
      ${tdNum(esc(fmtPctGastos(e.totalPct)), 'text-[15px] font-bold text-verde bg-verde/5')}
      ${tdNum(esc(fmtPesosCostos(e.ventaMensual)), sinDeptos ? 'opacity-50' : '')}${tdNum(esc(fmtPesosCostos(e.costoImputado)), sinDeptos ? 'opacity-50' : '')}</tr>`;
  }).join('');
  document.getElementById('costosResumen').innerHTML = `
    <div class="cfg-card">
      <h3 class="cfg-h">Estructura de costos por tipo</h3>
      <p class="cfg-ayuda">Lo guardado: costos = variables sobre venta + departamentos (costo imputado ÷ venta mensual).
        Costo real = costo neto ÷ (1 − costos); la ganancia se aplica sobre el costo real.</p>
      <table class="w-full text-sm cfg-tabla">
        <thead><tr><th class="text-left pr-3">Tipo</th>
          <th class="text-right px-3">Variables</th><th class="text-right px-3">Departamentos</th>
          <th class="text-right px-3 text-verde">Costos %</th><th class="text-right px-3">Venta mensual</th>
          <th class="text-right px-3">Costo imputado</th></tr></thead>
        <tbody>${filas}</tbody>
      </table>
      ${htmlNoAbsorbido(ec.departamentos || [])}
    </div>`;
}

// ── Tarjeta IVA de venta ────────────────────────────────────────────────────────
// No es costo: se aplica sobre el precio neto (después de la ganancia) y antes de los conceptos sobre precio final.
// Guardar no reescala nada: cambian los precios sugeridos.
function renderIvaVenta(cfg) {
  const iva = Number.isFinite(cfg.ivaVentaPct) ? cfg.ivaVentaPct : 21;
  document.getElementById('costosIva').innerHTML = `
    <div class="cfg-card" data-guardable>
      <h3 class="cfg-h">IVA de venta</h3>
      <p class="cfg-ayuda">No es costo: se suma sobre el precio neto (costo real + ganancia); los conceptos sobre precio final se
        calculan después, sobre el precio con IVA (sub-tab Precio final). Guardar no reescala nada: los precios sugeridos cambian.</p>
      <div class="cfg-campo"><label for="ivIva">IVA de venta</label>
        ${campoU(`<input id="ivIva" type="number" min="0" max="100" step="any" inputmode="decimal" value="${esc(iva)}">`, '%')}</div>
      <div class="cfg-pie">
        <span id="ivMsg" class="text-sm" role="status" aria-live="polite"></span>
        <button type="button" id="ivGuardar" class="cfg-btn">Guardar</button>
      </div>
    </div>`;
  document.getElementById('ivGuardar').onclick = guardarIvaVenta;
}

async function guardarIvaVenta() {
  const btn = document.getElementById('ivGuardar'), msg = document.getElementById('ivMsg');
  btn.disabled = true; msg.className = 'text-sm text-ink/50'; msg.textContent = 'Guardando…';
  try {
    await putJson('/api/precios/config/iva-venta', { ivaVentaPct: numOrNull(document.getElementById('ivIva').value) });
    fraccCargado = false; // precios_fraccionado.js: el precio final cambia con el IVA
    refrescarAlertasProduccion(); // precios_produccion.js
    await cargarCostos(); // precios_config.js
    const m = document.getElementById('ivMsg'); m.className = 'text-sm text-ok'; m.textContent = 'Guardado.';
  } catch (e) {
    msg.className = 'text-sm text-crit'; msg.textContent = e.message; btn.disabled = false;
  }
}

// ── Tarjeta Departamentos + venta base ──────────────────────────────────────────
let deptosEdit = [];   // copia editable [{ id?, nombre, costoMensual, imputacion: { almacen, fraccionado, produccion } }]
let ventaBaseEdit = { meses: 3, manual: {}, snapshot: null, produccionSinDepartamentos: true }; // meses, manual y flag editables; snapshot = el guardado

// u = '$' (adelante) o '%' (atrás); w = ancho del contenedor.
const inCostos = (campo, valor, label, u, w, extra = '') => campoU(`<input type="number" min="0" step="any" inputmode="decimal"
  data-campo="${campo}" value="${esc(valor ?? '')}" aria-label="${esc(label)}" ${extra}>`, u, { pre: u === '$', w });

function htmlFilaDepto(d, i) {
  const imp = d.imputacion || {};
  return `<tr data-i="${i}">
    <td class="pr-3 py-1"><input type="text" maxlength="60" data-campo="nombre" value="${esc(d.nombre ?? '')}"
        aria-label="Departamento, fila ${i + 1}" class="campo-t"></td>
    <td class="pr-3 py-1 text-right">${inCostos('costoMensual', d.costoMensual, `Costo mensual, fila ${i + 1}`, '$', 'w-36')}</td>
    ${COSTOS_TIPOS.map(t => `<td class="pr-3 py-1 text-right">${inCostos('imp-' + t, imp[t], `% ${COSTOS_NOMBRE_TIPO[t]}, fila ${i + 1}`, '%', 'w-24', 'max="100"')}</td>`).join('')}
    <td class="dp-noimp pr-3 py-1 text-right tabular-nums"></td>
    <td class="text-right"><button type="button" class="dp-quitar btn-quitar" data-edita title="Quitar departamento" aria-label="Quitar departamento ${i + 1}">✕</button></td>
  </tr>`;
}

// Columna "no imputado" y pie ($ imputado por tipo), en vivo sin re-dibujar los inputs.
function pintarCalculosDeptos() {
  document.querySelectorAll('#dpFilas tr[data-i]').forEach(tr => {
    const n = noImputadoPct((deptosEdit[Number(tr.dataset.i)] || {}).imputacion);
    const td = tr.querySelector('.dp-noimp');
    td.textContent = fmtPctGastos(n);
    td.className = `dp-noimp pr-3 py-1 text-right tabular-nums ${n < 0 ? 'text-crit font-semibold' : n > 0 ? 'text-warn' : 'text-gris'}`;
    td.title = n < 0 ? 'La suma de los % pasa de 100' : n > 0 ? 'Este % del costo no entra en ningún precio' : '';
  });
  const total = deptosEdit.reduce((s, d) => s + numCostos(d.costoMensual), 0);
  document.getElementById('dpPie').innerHTML = `<td>Total / $ imputado</td>
    <td class="pr-3 text-right tabular-nums">${esc(fmtPesosCostos(total))}</td>
    ${COSTOS_TIPOS.map(t => `<td class="pr-3 text-right tabular-nums">${esc(fmtPesosCostos(costoImputadoCli(deptosEdit, t)))}</td>`).join('')}<td></td><td></td>`;
  pintarVentaBaseVivo();
}

function pintarDeptos() {
  document.getElementById('dpFilas').innerHTML = deptosEdit.map(htmlFilaDepto).join('')
    || '<tr><td colspan="7" class="text-ink/50 py-2">Sin departamentos: los gastos de cada tipo son sólo los variables</td></tr>';
  pintarCalculosDeptos();
}

// Venta base: SIGA (snapshot) | manual | departamentos % y total gastos % con lo editado.
function htmlVentaBase() {
  const snap = ventaBaseEdit.snapshot;
  const fecha = snap ? `al ${fmtFechaCostos(snap.fecha)}, promedio de ${snap.meses} ${snap.meses === 1 ? 'mes' : 'meses'}` : 'sin actualizar';
  return `<div class="flex items-center gap-2 flex-wrap">
      <h4 class="text-sm font-bold text-ink mr-auto">Venta mensual base</h4>
      <label for="dpMeses" class="text-sm">Promedio de</label>
      ${campoU(`<input id="dpMeses" type="number" min="1" max="24" step="1" value="${esc(ventaBaseEdit.meses ?? '')}">`, 'meses', { w: 'w-24' })}
      <button type="button" id="dpActualizar" class="cfg-btn2">Actualizar desde SIGA</button>
    </div>
    <p class="cfg-nota mt-1">Venta SIGA ${esc(fecha)} (neta de impuestos, últimos meses × 30 días hasta ayer; si se tomó antes del
      02/10/2026 era con impuestos: actualizala). La venta manual, si se carga, reemplaza a la de SIGA.</p>
    <div id="dpVentaMsg" class="text-sm mt-1" role="status" aria-live="polite"></div>
    <table class="w-full text-sm mt-2 cfg-tabla">
      <thead><tr><th class="text-left pr-2">Tipo</th>
        <th class="text-right px-2">Venta SIGA</th>
        <th class="text-right px-2" title="Vacío = usa la venta de SIGA">Venta manual</th>
        <th class="text-right px-2">Deptos.</th><th class="text-right pl-2 text-verde">Costos %</th></tr></thead>
      <tbody>${COSTOS_TIPOS.map(t => `<tr class="border-t border-borde" data-tipo="${t}"><td class="pr-2 py-1 font-semibold">${esc(COSTOS_NOMBRE_TIPO[t])}</td>
        ${tdNum(esc(fmtPesosCostos(((snap || {}).porTipo || {})[t] ?? null)))}
        <td class="px-2 py-1 text-right">${campoU(`<input type="number" min="0" step="any" inputmode="decimal" data-manual="${t}" placeholder="usa SIGA"
          value="${esc((ventaBaseEdit.manual || {})[t] ?? '')}" aria-label="Venta manual ${esc(COSTOS_NOMBRE_TIPO[t])}">`, '$', { pre: true, w: 'w-36' })}</td>
        <td class="dp-pct px-2 py-1 text-right tabular-nums"></td><td class="dp-total pl-2 py-1 text-right tabular-nums text-[15px] font-bold text-verde"></td></tr>`).join('')}</tbody>
    </table>
    <label class="flex items-start gap-2 text-sm cursor-pointer mt-2"><input id="dpProdSinDeptos" type="checkbox" class="accent-verde mt-1"
        ${produccionSinDeptosCli(ventaBaseEdit) ? 'checked' : ''}>
      <span>Producción no absorbe departamentos por ahora <span class="cfg-nota">sus costos son sólo los variables: no usa la venta
        base y lo imputado a Producción no entra en ningún precio. Al guardar con "Mantener los precios actuales" se reescala la
        curva de Producción.</span></span></label>`;
}

function pintarVentaBaseVivo() {
  const ec = (configCargada || {}).estructuraCostos || { porTipo: {} };
  document.querySelectorAll('#dpVenta tr[data-tipo]').forEach(tr => {
    const t = tr.dataset.tipo;
    const sinDeptos = t === 'produccion' && produccionSinDeptosCli(ventaBaseEdit);
    tr.classList.toggle('opacity-50', sinDeptos);
    tr.title = sinDeptos ? 'Producción no absorbe departamentos por ahora' : '';
    const pct = deptosPctCli(deptosEdit, ventaBaseEdit, t);
    const variables = (ec.porTipo[t] || {}).variablesPct ?? 0;
    tr.querySelector('.dp-pct').textContent = pct == null ? 'falta venta' : fmtPctGastos(pct);
    tr.querySelector('.dp-pct').className = `dp-pct px-2 py-1 text-right tabular-nums ${pct == null ? 'text-crit' : ''}`;
    tr.querySelector('.dp-total').textContent = pct == null ? '—' : fmtPctGastos(r4Costos(variables + pct));
  });
}

function msgDeptos(id, txt, cls) {
  const el = document.getElementById(id);
  if (el) { el.className = `text-sm ${id === 'dpVentaMsg' ? 'mt-1 ' : ''}${cls}`; el.textContent = txt; }
}

// La llama cargarCostos (precios_config.js) con la config recién leída.
function renderDepartamentos(cfg) {
  deptosEdit = (cfg.departamentos || []).map(d => ({ ...d, imputacion: { ...(d.imputacion || {}) } }));
  const vb = cfg.ventaBase || {};
  ventaBaseEdit = { meses: vb.meses ?? 3, manual: { ...(vb.manual || {}) }, snapshot: vb.snapshot || null,
    produccionSinDepartamentos: produccionSinDeptosCli(vb) };
  document.getElementById('costosDepartamentos').innerHTML = `
    <div class="cfg-card" data-guardable>
      <h3 class="cfg-h">Departamentos</h3>
      <p class="cfg-ayuda">Costo mensual de cada departamento y qué % se imputa a cada tipo. Para cada tipo:
        departamentos % = costo imputado ÷ venta mensual; se suma a los variables sobre venta.</p>
      <div class="grid gap-x-8 gap-y-6 items-start" style="grid-template-columns:minmax(0,7fr) minmax(0,5fr)">
        <div class="min-w-0">
          <table class="w-full text-sm cfg-tabla">
            <thead><tr><th class="text-left pr-3">Departamento</th>
              <th class="text-right pr-3">Costo mensual</th>
              ${COSTOS_TIPOS.map(t => `<th class="text-right pr-3">${esc(COSTOS_NOMBRE_TIPO[t])}</th>`).join('')}
              <th class="text-right pr-3" title="100 − la suma de los %: no entra en ningún precio">No imputado</th><th></th></tr></thead>
            <tbody id="dpFilas"></tbody>
            <tfoot><tr id="dpPie" class="border-t border-borde cfg-total"></tr></tfoot>
          </table>
          <button type="button" id="dpAgregar" class="cfg-btn2 mt-3" data-edita>+ Agregar departamento</button>
        </div>
        <div id="dpVenta" class="min-w-0">${htmlVentaBase()}</div>
      </div>
      <div class="cfg-pie">
        <span id="dpMsg" class="text-sm" role="status" aria-live="polite"></span>
        <label class="flex items-start gap-2 text-sm cursor-pointer"><input id="dpConservar" type="checkbox" class="accent-verde mt-1" checked>
          <span>Mantener los precios actuales <span class="cfg-nota">recalcula las curvas de ganancia para que el markup total no cambie</span></span></label>
        <button type="button" id="dpGuardar" class="cfg-btn">Guardar departamentos</button>
      </div>
    </div>`;
  pintarDeptos();
  conectarDeptos();
}

function conectarDeptos() {
  const filas = document.getElementById('dpFilas');
  // Editar actualiza deptosEdit sin re-dibujar (no se pierde el foco); agregar/quitar re-dibuja.
  filas.addEventListener('input', e => {
    const campo = e.target.dataset.campo, tr = e.target.closest('tr[data-i]');
    if (!campo || !tr) return;
    const i = Number(tr.dataset.i);
    deptosEdit = deptosEdit.map((d, k) => {
      if (k !== i) return d;
      if (campo === 'nombre') return { ...d, nombre: e.target.value };
      if (campo === 'costoMensual') return { ...d, costoMensual: numOrNull(e.target.value) };
      return { ...d, imputacion: { ...d.imputacion, [campo.slice(4)]: numOrNull(e.target.value) } }; // imp-<tipo>
    });
    pintarCalculosDeptos();
  });
  filas.addEventListener('click', e => {
    const tr = e.target.closest('.dp-quitar') && e.target.closest('tr[data-i]');
    if (tr) { deptosEdit = deptosEdit.filter((_, k) => k !== Number(tr.dataset.i)); pintarDeptos(); }
  });
  document.getElementById('dpAgregar').onclick = () => {
    deptosEdit = [...deptosEdit, { nombre: '', costoMensual: null, imputacion: { almacen: null, fraccionado: null, produccion: null } }];
    pintarDeptos();
    const inputs = filas.querySelectorAll('input[data-campo="nombre"]');
    inputs[inputs.length - 1].focus();
  };
  // #dpVenta persiste al re-dibujar su contenido (Actualizar desde SIGA): el listener va una sola vez.
  document.getElementById('dpVenta').addEventListener('input', e => {
    if (e.target.id === 'dpMeses') ventaBaseEdit = { ...ventaBaseEdit, meses: numOrNull(e.target.value) };
    if (e.target.id === 'dpProdSinDeptos') ventaBaseEdit = { ...ventaBaseEdit, produccionSinDepartamentos: e.target.checked };
    const t = e.target.dataset.manual;
    if (t) ventaBaseEdit = { ...ventaBaseEdit, manual: { ...ventaBaseEdit.manual, [t]: numOrNull(e.target.value) } };
    pintarVentaBaseVivo();
  });
  document.getElementById('dpActualizar').onclick = actualizarVentaBase;
  document.getElementById('dpGuardar').onclick = guardarDepartamentos;
}

// Guarda departamentos + meses + venta manual y recarga la tab (con "mantener precios" el server reescala).
async function guardarDepartamentos() {
  const btn = document.getElementById('dpGuardar');
  btn.disabled = true;
  msgDeptos('dpMsg', 'Guardando…', 'text-ink/50');
  try {
    await putJson('/api/precios/config/departamentos',
      bodyDepartamentos(deptosEdit, ventaBaseEdit, document.getElementById('dpConservar').checked));
    fraccCargado = false; // precios_fraccionado.js: el standard cambia con los gastos de Fraccionado
    refrescarAlertasProduccion(); // precios_produccion.js: la curva de Producción también
    await cargarCostos(); // precios_config.js: resumen y esta tarjeta con lo guardado (las curvas reescaladas se ven en Ganancia)
    msgDeptos('dpMsg', 'Guardado.', 'text-ok');
  } catch (e) {
    msgDeptos('dpMsg', mensajeErrorDepto(e.message), 'text-crit');
    btn.disabled = false;
  }
}

// Trae la venta de SIGA y la guarda (snapshot). No reescala: si hay costo imputado los precios se mueven.
// Lo editado y sin guardar de la tabla de departamentos se conserva; meses y manual quedan como están.
async function actualizarVentaBase() {
  const hayCosto = COSTOS_TIPOS.some(t => costoImputadoCli((configCargada || {}).departamentos, t) > 0);
  if (hayCosto && !(await confirmar('¿Actualizar la venta base desde SIGA? Cambia el % de departamentos de cada tipo y con eso los precios sugeridos (las ganancias no se reescalan).', { textoOk: 'Actualizar' }))) return;
  const btn = document.getElementById('dpActualizar');
  btn.disabled = true;
  document.getElementById('dpVentaMsg').innerHTML = '<span class="spin"></span> Consultando la venta en SIGA… puede tardar unos segundos';
  try {
    const j = await pedirJson('POST', '/api/precios/costos/venta-base/actualizar',
      ventaBaseEdit.meses != null ? { meses: ventaBaseEdit.meses } : {});
    configCargada = { ...configCargada, ...j };
    ventaBaseEdit = { ...ventaBaseEdit, meses: j.ventaBase.meses, snapshot: j.ventaBase.snapshot };
    document.getElementById('dpVenta').innerHTML = htmlVentaBase();
    document.getElementById('dpActualizar').onclick = actualizarVentaBase;
    pintarVentaBaseVivo();
    renderResumenCostos(configCargada);
    fraccCargado = false;
    refrescarAlertasProduccion();
    if (j.aviso) msgDeptos('dpVentaMsg', j.aviso, 'text-warn');
    else msgDeptos('dpVentaMsg', 'Venta actualizada.', 'text-ok');
  } catch (e) {
    msgDeptos('dpVentaMsg', e.message, 'text-crit');
    btn.disabled = false;
  }
}
