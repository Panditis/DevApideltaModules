// ── rrhh_ausencias_front.js ──────────────────────────────────────────────────
// Front del módulo de Ausencias (RRHH). El dashboard es UNO solo: se arma con
// `dashHTML(vista)` y se rellena con `pintarDash(vista)`. El apartado "Histórico"
// lo apunta a todos los registros y el de "Al día" al período que se está
// cargando, así los dos miden exactamente igual. Toda la agregación sale de
// rrhh_ausencias.js, el mismo módulo que usa el server.
'use strict';

(function () {
const A = window.RRHHAusencias;
const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const PALETA = ['#65684C', '#FFCC00', '#4a4f7d', '#8a9b5b', '#c98f3e', '#7d6a9b', '#4f8a8b', '#b3554f', '#9aa07a', '#5b7fa6'];
const VISTAS = ['historico', 'aldia'];

// ── Estado ───────────────────────────────────────────────────────────────────
let DOC = { registros: [], importaciones: [], mapeo: {}, tipos: [] };
const filtros = {
  historico: { desde: '', hasta: '', fuente: '', tipo: '', q: '' },
  aldia:     { desde: '', hasta: '', fuente: '', tipo: '', q: '' },
};
const charts = {};          // canvas id → instancia de Chart, para destruir antes de repintar
let vistaActual = 'historico';

// Importación en curso (nada de esto se guarda hasta confirmar).
let archivoActual = null;   // File
let preview = null;         // respuesta de /importar; es TODO lo que mide la pestaña "Al día"
let guardada = false;       // la bajada del preview ya pasó al histórico
let mapeoBorrador = {};     // código → tipo ('' = ignorar, sin clave = sin clasificar)

// ── Utilidades ───────────────────────────────────────────────────────────────
function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function nf(n) { return (Number(n) || 0).toLocaleString('es-AR'); }
function fechaLinda(iso) {
  if (!iso) return '—';
  const p = String(iso).split('-');
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : String(iso);
}
function rango(p) {
  return p && p.desde ? `${fechaLinda(p.desde)} → ${fechaLinda(p.hasta)}` : 'sin datos';
}
function iconos() { if (window.lucide) lucide.createIcons(); }

async function api(url, opts) {
  const r = await fetch(url, opts);
  let data = null;
  try { data = await r.json(); } catch { /* respuesta sin cuerpo */ }
  if (!r.ok) throw new Error((data && data.error) || `Error ${r.status}`);
  return data;
}

function descargarCSV(nombre, filas) {
  // BOM para que Excel en Windows respete los acentos.
  const csv = filas.map(f => f.map(c => {
    const s = String(c === null || c === undefined ? '' : c);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url; a.download = nombre;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Dashboard (idéntico para las dos vistas) ─────────────────────────────────
function dashHTML(v) {
  return `
  <div class="card mb-5">
    <div class="card-title"><span>Filtros</span>
      <button class="btn" data-limpiar="${v}"><i data-lucide="eraser"></i>Limpiar</button>
    </div>
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <label class="f">Desde<input type="date" id="f-desde-${v}"></label>
      <label class="f">Hasta<input type="date" id="f-hasta-${v}"></label>
      <label class="f">Fuente<select id="f-fuente-${v}" data-todos="Todas"></select></label>
      <label class="f">Tipo<select id="f-tipo-${v}" data-todos="Todos"></select></label>
      <label class="f">Buscar<input type="text" id="f-q-${v}" placeholder="persona, obs, código…"></label>
    </div>
  </div>

  <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-5" id="kpis-${v}"></div>

  <div class="grid gap-4 lg:grid-cols-3 mb-5">
    <div class="card lg:col-span-2">
      <div class="card-title"><span>Ausencias por mes</span></div>
      <div class="chart-box alto"><canvas id="ch-mes-${v}"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title"><span>Por tipo</span></div>
      <div class="chart-box alto"><canvas id="ch-tipo-${v}"></canvas></div>
    </div>
  </div>

  <div class="card mb-5">
    <div class="card-title"><span>Por día de la semana</span></div>
    <div class="chart-box"><canvas id="ch-dow-${v}"></canvas></div>
  </div>

  <div class="card mb-5">
    <div class="card-title"><span>Por persona</span>
      <button class="btn" data-csv-personas="${v}"><i data-lucide="download"></i>CSV</button>
    </div>
    <div class="tabla-wrap"><table id="tb-personas-${v}"></table></div>
  </div>

  <div class="card">
    <div class="card-title"><span>Detalle</span>
      <button class="btn" data-csv-detalle="${v}"><i data-lucide="download"></i>CSV</button>
    </div>
    <div class="tabla-wrap"><table id="tb-detalle-${v}"></table></div>
  </div>`;
}

// Chart.js no permite dos gráficos sobre el mismo canvas: se destruye el previo.
function pintar(id, config) {
  const el = document.getElementById(id);
  if (!el) return;
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(el, config);
}

const SIN_LEYENDA = { legend: { display: false } };
const EJE_ENTEROS = { beginAtZero: true, ticks: { precision: 0 } };

function barras(id, datos, color) {
  pintar(id, {
    type: 'bar',
    data: {
      labels: datos.map(d => d.clave),
      datasets: [{ label: 'Ausencias', data: datos.map(d => d.cantidad), backgroundColor: color, borderRadius: 5, maxBarThickness: 46 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: SIN_LEYENDA,
      scales: { y: EJE_ENTEROS, x: { grid: { display: false } } },
    },
  });
}

function dona(id, datos) {
  pintar(id, {
    type: 'doughnut',
    data: {
      labels: datos.map(d => d.clave),
      datasets: [{ data: datos.map(d => d.cantidad), backgroundColor: datos.map((_, i) => PALETA[i % PALETA.length]), borderWidth: 2, borderColor: '#fff' }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '58%',
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } },
    },
  });
}

// El histórico mide todo lo guardado; "Al día" mide SÓLO la planilla que se
// acaba de subir. Nunca se mezclan: el apartado al día es la foto de la bajada
// en curso, no una ventana sobre el histórico.
function universo(v) {
  if (v !== 'aldia') return DOC.registros;
  if (!preview) return [];
  // Los códigos todavía sin clasificar entran como "Sin clasificar" para que se
  // vean en el gráfico en vez de desaparecer de los totales.
  return preview.registros.map((r, i) => A.normalizarRegistro(r, i));
}

function registrosDe(v) {
  const f = filtros[v];
  return A.filtrar(universo(v), {
    desde: f.desde, hasta: f.hasta, q: f.q,
    fuentes: f.fuente ? [f.fuente] : [],
    tipos:   f.tipo   ? [f.tipo]   : [],
  });
}

function kpisHTML(R) {
  const top = R.porTipo[0];
  const mesPico = R.porMes.slice().sort((a, b) => b.cantidad - a.cantidad)[0];
  return [
    { label: 'Ausencias', valor: nf(R.total), sub: rango(R.periodo), color: '#65684C' },
    { label: 'Personas', valor: nf(R.personas), sub: `${nf(R.meses)} ${R.meses === 1 ? 'mes' : 'meses'} con registros`, color: '#4a4f7d' },
    { label: 'Promedio mensual', valor: nf(R.promedioMes), sub: mesPico ? `pico: ${esc(mesPico.clave)} (${nf(mesPico.cantidad)})` : '—', color: '#FFCC00' },
    { label: 'Tipo más frecuente', valor: top ? nf(top.cantidad) : '0', sub: top ? esc(top.clave) : '—', color: '#8a9b5b' },
  ].map(k => `
    <div class="kpi" style="--kpi:${k.color}">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value">${k.valor}</div>
      <div class="kpi-sub">${k.sub}</div>
    </div>`).join('');
}

function pillFuente(f) {
  const cls = f === 'RELOJ' ? 'pill-reloj' : f === 'CLOVER' ? 'pill-clover' : '';
  return `<span class="pill ${cls}">${esc(f)}</span>`;
}

function tablaPersonas(R) {
  const tipos = R.porPersona.tipos;
  const cab = `<thead><tr><th>Persona</th><th>Fuente</th><th class="num">Total</th>${tipos.map(t => `<th class="num">${esc(t)}</th>`).join('')}</tr></thead>`;
  const cuerpo = R.porPersona.filas.map(f => `
    <tr>
      <td>${esc(f.persona)}</td>
      <td>${pillFuente(f.fuente)}</td>
      <td class="num"><strong>${nf(f.total)}</strong></td>
      ${tipos.map(t => {
        const n = f.porTipo[t] || 0;
        return `<td class="num${n ? '' : ' cero'}">${n || '·'}</td>`;
      }).join('')}
    </tr>`).join('');
  return cab + `<tbody>${cuerpo || `<tr><td colspan="${tipos.length + 3}" style="color:#8a8c78">Sin datos para el filtro actual.</td></tr>`}</tbody>`;
}

// El detalle puede tener miles de filas: se muestran las primeras 400 y el CSV
// se lleva todo, que es para lo que sirve.
const TOPE_DETALLE = 400;
function tablaDetalle(regs) {
  const vis = regs.slice().sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0)).slice(0, TOPE_DETALLE);
  const cab = '<thead><tr><th>Fecha</th><th>Día</th><th>Fuente</th><th>Persona</th><th>Tipo</th><th>Código</th><th>Observación</th></tr></thead>';
  const cuerpo = vis.map(r => `
    <tr>
      <td>${fechaLinda(r.fecha)}</td>
      <td>${esc(A.diaSemana(r.fecha))}</td>
      <td>${pillFuente(r.fuente)}</td>
      <td>${esc(r.persona)}</td>
      <td>${esc(r.tipo)}</td>
      <td>${r.codigo ? `<span class="pill">${esc(r.codigo)}</span>` : ''}</td>
      <td style="white-space:normal">${esc(r.obs)}</td>
    </tr>`).join('');
  const pie = regs.length > TOPE_DETALLE
    ? `<tr><td colspan="7" style="color:#8a8c78">Se muestran ${TOPE_DETALLE} de ${nf(regs.length)} registros. Descargá el CSV para verlos todos.</td></tr>`
    : '';
  return cab + `<tbody>${cuerpo || '<tr><td colspan="7" style="color:#8a8c78">Sin datos para el filtro actual.</td></tr>'}${pie}</tbody>`;
}

function pintarDash(v) {
  const regs = registrosDe(v);
  const R = A.resumen(regs);
  $(`#kpis-${v}`).innerHTML = kpisHTML(R);
  barras(`ch-mes-${v}`, R.porMes, '#65684C');
  dona(`ch-tipo-${v}`, R.porTipo);
  barras(`ch-dow-${v}`, R.porDiaSem, '#4a4f7d');
  $(`#tb-personas-${v}`).innerHTML = tablaPersonas(R);
  $(`#tb-detalle-${v}`).innerHTML = tablaDetalle(regs);
  $(`#badge-${v}`).textContent = nf(regs.length);
  iconos();
}

// ── Filtros ──────────────────────────────────────────────────────────────────
function opciones(sel, valores, actual) {
  const el = $(sel);
  if (!el) return;
  el.innerHTML = `<option value="">${el.dataset.todos || 'Todos'}</option>` +
    valores.map(x => `<option value="${esc(x)}"${x === actual ? ' selected' : ''}>${esc(x)}</option>`).join('');
}

function refrescarOpciones(v) {
  const R = A.resumen(universo(v));
  opciones(`#f-fuente-${v}`, R.porFuente.map(f => f.clave), filtros[v].fuente);
  opciones(`#f-tipo-${v}`, R.porTipo.map(t => t.clave), filtros[v].tipo);
}

const CAMPOS_FILTRO = ['desde', 'hasta', 'fuente', 'tipo', 'q'];

function conectarFiltros(v) {
  for (const k of CAMPOS_FILTRO) {
    const el = $(`#f-${k}-${v}`);
    if (!el) continue;
    el.value = filtros[v][k];
    el.addEventListener(k === 'q' ? 'input' : 'change', () => {
      filtros[v][k] = el.value;
      pintarDash(v);
    });
  }
  const limpiar = $(`[data-limpiar="${v}"]`);
  if (limpiar) limpiar.addEventListener('click', () => {
    filtros[v] = { desde: '', hasta: '', fuente: '', tipo: '', q: '' };
    for (const k of CAMPOS_FILTRO) { const el = $(`#f-${k}-${v}`); if (el) el.value = ''; }
    pintarDash(v);
  });

  const csvDet = $(`[data-csv-detalle="${v}"]`);
  if (csvDet) csvDet.addEventListener('click', () => {
    const regs = registrosDe(v).slice().sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
    descargarCSV(`ausencias_${v}_detalle.csv`, [
      ['Fecha', 'DiaSem', 'Fuente', 'Persona', 'Legajo', 'Grupo', 'Tipo', 'Codigo', 'Observacion'],
      ...regs.map(r => [r.fecha, A.diaSemana(r.fecha), r.fuente, r.persona, r.legajo, r.grupo, r.tipo, r.codigo, r.obs]),
    ]);
  });

  const csvPer = $(`[data-csv-personas="${v}"]`);
  if (csvPer) csvPer.addEventListener('click', () => {
    const p = A.resumen(registrosDe(v)).porPersona;
    descargarCSV(`ausencias_${v}_por_persona.csv`, [
      ['Persona', 'Fuente', 'Total', ...p.tipos],
      ...p.filas.map(f => [f.persona, f.fuente, f.total, ...p.tipos.map(t => f.porTipo[t] || 0)]),
    ]);
  });
}

// ── Pestañas ─────────────────────────────────────────────────────────────────
function mostrarVista(v) {
  vistaActual = v;
  for (const otra of VISTAS) {
    $(`#tab-${otra}`).setAttribute('aria-selected', String(otra === v));
    $(`#panel-${otra}`).classList.toggle('hidden', otra !== v);
  }
  // Chart.js mide mal los canvas ocultos: se repinta al mostrar la pestaña.
  if (v === 'aldia') refrescarAlDia(); else pintarDash(v);
}

// ── Importación de la bajada de fichajes ─────────────────────────────────────
function avisoHTML(clase, icono, texto) {
  return `<div class="aviso ${clase}"><i data-lucide="${icono}"></i><span>${texto}</span></div>`;
}

// El dashboard "Al día" vive del preview, así que se repinta cada vez que la
// bajada cambia: al elegir el archivo, al reclasificar un código y al descartar.
function refrescarAlDia() {
  // Se muestra el dashboard antes de pintarlo: Chart.js mide 0 en un contenedor
  // oculto y los gráficos saldrían aplastados.
  $('#aldia-vacio').classList.toggle('hidden', !!preview);
  $('#dash-aldia').classList.toggle('hidden', !preview);
  refrescarOpciones('aldia');
  pintarDash('aldia');
}

function limpiarImportacion() {
  archivoActual = null;
  preview = null;
  guardada = false;
  mapeoBorrador = { ...DOC.mapeo };
  filtros.aldia = { desde: '', hasta: '', fuente: '', tipo: '', q: '' };
  for (const k of CAMPOS_FILTRO) { const el = $(`#f-${k}-aldia`); if (el) el.value = ''; }
  $('#import-estado').innerHTML = '';
  $('#import-codigos').innerHTML = '';
  $('#import-preview').innerHTML = '';
  $('#dropzone-sub').textContent = 'Ej.: Apidelta_Fichajes_182026a2682026.xlsx';
  $('#btn-reprocesar').disabled = true;
  $('#file').value = '';
  refrescarAlDia();
}

async function procesarArchivo() {
  if (!archivoActual) return;
  guardada = false;   // reprocesar con otro año o mapeo es otra bajada
  $('#import-estado').innerHTML = `<div class="aviso aviso-info"><span class="spinner"></span><span>Leyendo ${esc(archivoActual.name)}…</span></div>`;
  $('#import-codigos').innerHTML = '';
  $('#import-preview').innerHTML = '';
  try {
    const fd = new FormData();
    fd.append('archivo', archivoActual);
    fd.append('mapeo', JSON.stringify(mapeoBorrador));
    const anio = $('#anio').value;
    if (anio) fd.append('anio', anio);
    preview = await api('/api/rrhh/ausencias/importar', { method: 'POST', body: fd });
    if (!$('#anio').value && preview.anio) $('#anio').value = preview.anio;
    renderImportacion();
  } catch (err) {
    preview = null;
    $('#import-estado').innerHTML = avisoHTML('aviso-err', 'alert-triangle', esc(err.message));
    refrescarAlDia();
    iconos();
  }
}

function renderImportacion() {
  if (!preview) return;
  const nuevos = preview.registros.filter(r => !r.duplicado);
  const ignorados = Object.values(preview.ignorados || {}).reduce((a, b) => a + b, 0);

  $('#import-estado').innerHTML = avisoHTML('aviso-ok', 'check-circle-2',
    `<strong>${esc(preview.archivo)}</strong> · período ${rango(preview.periodo)} · ` +
    `${nf(preview.registros.length)} ausencias detectadas` +
    (preview.duplicados ? ` · ${nf(preview.duplicados)} ya estaban en el histórico` : '') +
    (ignorados ? ` · ${nf(ignorados)} descartadas por clasificación` : ''));

  // El reloj exporta códigos ('ESC-5', 'VA5'...), no el tipo de licencia. Sin
  // clasificarlos todos no se puede guardar: quedarían registros que después no
  // se pueden contar por tipo en ningún dashboard.
  const sugerencias = [...new Set([...(DOC.tipos || []), ...Object.values(DOC.mapeo || {})])].filter(Boolean);
  const filas = (preview.codigos || []).map(c => {
    const tieneMapeo = Object.prototype.hasOwnProperty.call(mapeoBorrador, c.codigo);
    const valor = tieneMapeo ? mapeoBorrador[c.codigo] : '';
    const ignorar = tieneMapeo && valor === '';
    return `
      <tr>
        <td><span class="pill">${esc(c.codigo)}</span></td>
        <td class="num">${nf(c.cantidad)}</td>
        <td style="width:100%">
          <input type="text" list="tipos-sugeridos" data-cod="${esc(c.codigo)}" value="${esc(valor)}"
                 placeholder="${ignorar ? 'No se importa' : 'Clasificar como…'}" style="width:100%"${ignorar ? ' disabled' : ''}>
        </td>
        <td>
          <label style="display:inline-flex;align-items:center;gap:6px;font-size:.8rem;color:#6b6e59;cursor:pointer">
            <input type="checkbox" data-ign="${esc(c.codigo)}"${ignorar ? ' checked' : ''}> No es ausencia
          </label>
        </td>
        <td>${tieneMapeo ? '' : '<span class="pill pill-warn">sin clasificar</span>'}</td>
      </tr>`;
  }).join('');

  $('#import-codigos').innerHTML = `
    <div class="card-title" style="margin-bottom:8px"><span>Códigos del reloj</span></div>
    ${preview.sinMapear.length
      ? avisoHTML('aviso-warn', 'alert-triangle', `Faltan clasificar ${preview.sinMapear.length} código(s): <strong>${preview.sinMapear.map(esc).join(', ')}</strong>. Asigná el tipo de licencia (o marcalos como “no es ausencia”) para poder guardar.`)
      : avisoHTML('aviso-ok', 'check-circle-2', 'Todos los códigos de esta bajada están clasificados.')}
    <div class="tabla-wrap" style="max-height:320px;margin-top:10px">
      <table>
        <thead><tr><th>Código</th><th class="num">Veces</th><th>Tipo de licencia</th><th>Ignorar</th><th>Estado</th></tr></thead>
        <tbody>${filas || '<tr><td colspan="5" style="color:#8a8c78">La bajada no trae ninguna ausencia.</td></tr>'}</tbody>
      </table>
    </div>
    <datalist id="tipos-sugeridos">${sugerencias.map(t => `<option value="${esc(t)}"></option>`).join('')}</datalist>`;

  const puedeGuardar = !preview.sinMapear.length && nuevos.length > 0 && !guardada;
  $('#import-preview').innerHTML = `
    <div class="flex flex-wrap items-center gap-3">
      <button class="btn btn-primary" id="btn-guardar"${puedeGuardar ? '' : ' disabled'}>
        <i data-lucide="${guardada ? 'check' : 'save'}"></i>${guardada ? 'Ya pasó al histórico' : `Pasar ${nf(nuevos.length)} ausencia(s) al histórico`}
      </button>
      <button class="btn" id="btn-descartar"><i data-lucide="x"></i>${guardada ? 'Cerrar' : 'Descartar'}</button>
      <span class="text-[#8a8c78] text-[.82rem]">
        ${preview.duplicados ? `${nf(preview.duplicados)} repetida(s) no se vuelven a cargar.` : 'Ninguna repetida.'}
      </span>
    </div>
    ${nuevos.length ? `
      <div class="tabla-wrap" style="max-height:300px;margin-top:12px">
        <table>
          <thead><tr><th>Fecha</th><th>Día</th><th>Legajo</th><th>Persona</th><th>Código</th><th>Tipo</th></tr></thead>
          <tbody>${nuevos.slice(0, TOPE_DETALLE).map(r => `
            <tr>
              <td>${fechaLinda(r.fecha)}</td>
              <td>${esc(A.diaSemana(r.fecha))}</td>
              <td>${esc(r.legajo)}</td>
              <td>${esc(r.persona)}</td>
              <td><span class="pill">${esc(r.codigo)}</span></td>
              <td>${r.tipo ? esc(r.tipo) : '<span class="pill pill-warn">sin clasificar</span>'}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>` : ''}`;

  // Editar la clasificación vuelve a parsear la planilla con el mapeo nuevo: el
  // parser es el único lugar donde se decide qué entra y qué se descarta.
  $$('#import-codigos input[data-cod]').forEach(el => {
    el.addEventListener('change', () => {
      const cod = el.dataset.cod, val = el.value.trim();
      if (val) mapeoBorrador[cod] = val; else delete mapeoBorrador[cod];
      procesarArchivo();
    });
  });
  $$('#import-codigos input[data-ign]').forEach(el => {
    el.addEventListener('change', () => {
      const cod = el.dataset.ign;
      if (el.checked) mapeoBorrador[cod] = '';
      else delete mapeoBorrador[cod];
      procesarArchivo();
    });
  });

  const guardar = $('#btn-guardar');
  if (guardar) guardar.addEventListener('click', confirmarImportacion);
  $('#btn-descartar').addEventListener('click', limpiarImportacion);
  refrescarAlDia();
  iconos();
}

// Guardar vuelve a subir la misma planilla: el server la re-parsea con el mismo
// mapeo, así lo que queda en el histórico es exactamente lo que se previsualizó
// y el navegador nunca dicta el contenido de un registro.
async function confirmarImportacion() {
  if (!preview || !archivoActual) return;
  const nuevos = preview.registros.filter(r => !r.duplicado);
  const periodo = preview.periodo;
  const btn = $('#btn-guardar');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Guardando…';
  try {
    const fd = new FormData();
    fd.append('archivo', archivoActual);
    fd.append('mapeo', JSON.stringify(mapeoBorrador));
    if ($('#anio').value) fd.append('anio', $('#anio').value);
    DOC = await api('/api/rrhh/ausencias/importaciones', { method: 'POST', body: fd });
    // La bajada sigue a la vista después de guardarla: el apartado "Al día" es la
    // foto de esta planilla, y recién se vacía cuando se sube otra o se cierra.
    guardada = true;
    renderImportacion();
    renderImportaciones();
    $('#import-estado').innerHTML = avisoHTML('aviso-ok', 'check-circle-2',
      `Listo: ${nf(nuevos.length)} ausencia(s) del período ${rango(periodo)} pasaron al histórico.`);
    iconos();
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="save"></i>Reintentar';
    $('#import-estado').innerHTML = avisoHTML('aviso-err', 'alert-triangle', esc(err.message));
    iconos();
  }
}

// ── Bitácora de importaciones ────────────────────────────────────────────────
function renderImportaciones() {
  const lista = DOC.importaciones.slice().reverse();
  if (!lista.length) {
    $('#importaciones').innerHTML = '<p class="text-[#8a8c78] text-[.85rem]">Todavía no se importó ninguna bajada.</p>';
    return;
  }
  $('#importaciones').innerHTML = `
    <div class="tabla-wrap" style="max-height:260px">
      <table>
        <thead><tr><th>Archivo</th><th>Período</th><th class="num">Registros</th><th>Cargado</th><th>Por</th><th></th></tr></thead>
        <tbody>${lista.map(i => `
          <tr>
            <td>${esc(i.archivo)}</td>
            <td>${rango(i.periodo)}</td>
            <td class="num">${nf(i.cantidad)}</td>
            <td>${i.fecha ? fechaLinda(i.fecha.slice(0, 10)) : '—'}</td>
            <td>${esc(i.usuario) || '—'}</td>
            <td>${i.id === 'historico'
              ? '<span class="pill">planilla original</span>'
              : `<button class="btn btn-danger" data-borrar="${esc(i.id)}"><i data-lucide="undo-2"></i>Deshacer</button>`}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>`;

  $$('#importaciones [data-borrar]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.borrar;
      const imp = DOC.importaciones.find(x => x.id === id);
      if (!confirm(`¿Deshacer la importación de "${imp ? imp.archivo : id}"?\nSe borran del histórico sus ${imp ? imp.cantidad : ''} registros.`)) return;
      btn.disabled = true;
      try {
        DOC = await api(`/api/rrhh/ausencias/importaciones/${encodeURIComponent(id)}`, { method: 'DELETE' });
        refrescarTodo();
      } catch (err) {
        btn.disabled = false;
        alert(err.message);
      }
    });
  });
  iconos();
}

// ── Arranque ─────────────────────────────────────────────────────────────────
function refrescarTodo() {
  renderImportaciones();
  // Sólo se repinta la pestaña visible: los canvas ocultos miden 0 y Chart.js
  // los dibuja mal. La otra se repinta cuando se la abre.
  refrescarOpciones(vistaActual);
  if (vistaActual === 'aldia') refrescarAlDia(); else pintarDash(vistaActual);
}

function tomarArchivo(f) {
  archivoActual = f;
  $('#dropzone-sub').textContent = f.name;
  $('#btn-reprocesar').disabled = false;
  // El año sale del nombre del archivo nuevo; el server lo vuelve a deducir si queda vacío.
  $('#anio').value = A.anioDesdeNombre(f.name) || '';
  procesarArchivo();
}

async function init() {
  try {
    DOC = await api('/api/rrhh/ausencias');
  } catch (err) {
    $('#carga-inicial').classList.add('hidden');
    $('#error-inicial').classList.remove('hidden');
    $('#error-inicial-txt').textContent = `No se pudieron cargar las ausencias: ${err.message}`;
    iconos();
    return;
  }
  mapeoBorrador = { ...DOC.mapeo };

  $('#dash-historico').innerHTML = dashHTML('historico');
  $('#dash-aldia').innerHTML = dashHTML('aldia');
  for (const v of VISTAS) conectarFiltros(v);

  $('#carga-inicial').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $$('.tab').forEach(t => t.addEventListener('click', () => mostrarVista(t.dataset.vista)));

  // Selector de archivo: clic, teclado y arrastrar-soltar sobre la misma zona.
  const dz = $('#dropzone'), file = $('#file');
  dz.addEventListener('click', () => file.click());
  dz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } });
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', e => { if (e.dataTransfer.files[0]) tomarArchivo(e.dataTransfer.files[0]); });
  file.addEventListener('change', () => { if (file.files[0]) tomarArchivo(file.files[0]); });
  $('#btn-reprocesar').addEventListener('click', procesarArchivo);
  $('#anio').addEventListener('change', () => { if (archivoActual) procesarArchivo(); });

  refrescarTodo();
  mostrarVista('historico');
  // El contador de la pestaña que no está a la vista igual tiene que ser real.
  $('#badge-aldia').textContent = nf(registrosDe('aldia').length);

  fetch('/api/session').then(r => r.json()).then(s => {
    if (s && s.user) {
      $('#user-name').textContent = s.user.nombre || s.user.usuario;
      $('#user-chip').classList.remove('hidden');
    }
  }).catch(() => {});

  iconos();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
