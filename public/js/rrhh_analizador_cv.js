// ── rrhh_analizador_cv.js ────────────────────────────────────────────────────
// Front del Analizador de CV (RRHH). Filtros tipo ATS por reglas, sin IA.
// El servidor hace todo el análisis; acá sólo se arma el FormData, se pinta el
// resultado y se edita la lista de perfiles (PUT de la lista completa).
// No hay historial: el último FormData queda en memoria sólo para "Volver a analizar".
'use strict';

const API = '/api/rrhh/cv';
const ESTUDIOS = [
  { valor: '', etiqueta: 'Sin mínimo' },
  { valor: 'secundario', etiqueta: 'Secundario' },
  { valor: 'terciario', etiqueta: 'Terciario' },
  { valor: 'universitario', etiqueta: 'Universitario' },
];
const ETIQUETA_ESTUDIOS = Object.fromEntries(ESTUDIOS.map(e => [e.valor, e.etiqueta]));

let perfiles = [];
let archivo = null;          // File elegido (drag&drop o selector)
let ultimoEnvio = null;      // FormData del último análisis, para re-analizar

// ── Utilidades ───────────────────────────────────────────────────────────────
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const iconos = () => { if (window.lucide) lucide.createIcons(); };
// "excel|planilla de calculo" → "excel / planilla de calculo"
const alternativas = kw => String(kw ?? '').split('|').map(s => s.trim()).filter(Boolean).join(' / ');

function toast(mensaje, esError) {
  const t = document.createElement('div');
  t.className = 'toast' + (esError ? ' err' : '');
  t.textContent = mensaje;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

function mostrarError(sel, mensaje) {
  const caja = $(sel);
  caja.querySelector('span').textContent = mensaje || '';
  caja.classList.toggle('hidden', !mensaje);
}

// Si !res.ok se lanza con body.error. JSON sólo cuando el cuerpo no es FormData.
async function api(ruta, opciones = {}) {
  const headers = opciones.body && !(opciones.body instanceof FormData)
    ? { 'Content-Type': 'application/json' } : {};
  const r = await fetch(ruta, { ...opciones, headers });
  const cuerpo = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(cuerpo.error || `Error ${r.status}`);
  return cuerpo;
}

// ── Pestañas ─────────────────────────────────────────────────────────────────
function cambiarTab(nombre) {
  document.querySelectorAll('.tab').forEach(b => {
    const activa = b.dataset.tab === nombre;
    b.classList.toggle('activa', activa);
    b.setAttribute('aria-selected', String(activa));
  });
  $('#tab-analizar').classList.toggle('hidden', nombre !== 'analizar');
  $('#tab-perfiles').classList.toggle('hidden', nombre !== 'perfiles');
}
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => cambiarTab(b.dataset.tab)));

// ── Archivo: drag&drop + selector ───────────────────────────────────────────
function elegirArchivo(f) {
  archivo = f || null;
  const chip = $('#archivo-elegido');
  if (!archivo) { chip.classList.add('hidden'); chip.innerHTML = ''; $('#cv-archivo').value = ''; return; }
  chip.innerHTML = `<i data-lucide="file-text"></i>${esc(archivo.name)} · ${(archivo.size / 1024).toFixed(0)} KB
    <button type="button" id="quitar-archivo" title="Quitar archivo" aria-label="Quitar archivo"><i data-lucide="x"></i></button>`;
  chip.classList.remove('hidden');
  iconos();
}

const dz = $('#dropzone');
['dragenter', 'dragover'].forEach(t => dz.addEventListener(t, ev => { ev.preventDefault(); dz.classList.add('sobre'); }));
['dragleave', 'drop'].forEach(t => dz.addEventListener(t, ev => { ev.preventDefault(); dz.classList.remove('sobre'); }));
dz.addEventListener('drop', ev => elegirArchivo(ev.dataTransfer.files[0]));
// El botón "quitar" vive dentro del <label>: sin preventDefault abriría el selector.
dz.addEventListener('click', ev => {
  if (ev.target.closest('#quitar-archivo')) { ev.preventDefault(); elegirArchivo(null); }
});
$('#cv-archivo').addEventListener('change', ev => elegirArchivo(ev.target.files[0]));

// ── Analizar ─────────────────────────────────────────────────────────────────
async function analizar(fd) {
  const btn = $('#btn-analizar');
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader-2" class="spin"></i>Analizando…';
  iconos();
  mostrarError('#error-analizar', '');
  try {
    const res = await api(`${API}/analizar`, { method: 'POST', body: fd });
    ultimoEnvio = fd;
    renderResultado(res);
  } catch (err) {
    mostrarError('#error-analizar', err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="scan-search"></i>Analizar';
    iconos();
  }
}

$('#form-analizar').addEventListener('submit', ev => {
  ev.preventDefault();
  const texto = $('#cv-texto').value.trim();
  if (!archivo && !texto) { mostrarError('#error-analizar', 'Elegí un archivo o pegá el texto del CV.'); return; }
  const fd = new FormData();
  if (archivo) fd.append('archivo', archivo);
  else fd.append('texto', texto);
  analizar(fd);
});

$('#btn-limpiar').addEventListener('click', () => {
  elegirArchivo(null);
  $('#cv-texto').value = '';
  $('#resultado').innerHTML = '';
  mostrarError('#error-analizar', '');
  ultimoEnvio = null;
});

// ── Render del resultado ─────────────────────────────────────────────────────
function chips(lista, clase, icono) {
  if (!lista || !lista.length) return '<span class="chip-vacio">—</span>';
  return lista.map(k => `<span class="chip ${clase}">${icono ? `<i data-lucide="${icono}"></i>` : ''}${esc(alternativas(k))}</span>`).join('');
}

function dato(label, valor) {
  const vacio = valor === null || valor === undefined || valor === '';
  return `<div class="dato"><div class="dato-label">${label}</div>
    <div class="dato-valor ${vacio ? 'dato-vacio' : ''}">${vacio ? 'No detectado' : esc(valor)}</div></div>`;
}

function tarjetaPerfil(r, esMejor) {
  const puntaje = Math.max(0, Math.min(100, Number(r.puntaje) || 0));
  const color = r.cumple ? 'var(--ok)' : 'var(--err)';
  const req = r.requeridas || {};
  const des = r.deseables || {};
  return `
    <article class="res-card ${esMejor ? 'mejor' : ''}">
      <div class="res-head">
        <span class="res-nombre">${esc(r.nombre)}</span>
        ${esMejor ? '<span class="badge badge-mejor"><i data-lucide="star"></i>Sugerido</span>' : ''}
        ${r.cumple
          ? '<span class="badge badge-ok"><i data-lucide="check"></i>Cumple</span>'
          : '<span class="badge badge-err"><i data-lucide="x"></i>No cumple</span>'}
        <span class="res-puntaje" style="color:${color}">${puntaje}</span>
      </div>
      <div class="barra" role="img" aria-label="Puntaje ${puntaje} de 100"><span style="width:${puntaje}%;background:${color}"></span></div>
      <div>
        <div class="grupo-label">Requeridas</div>
        <div class="chips">
          ${chips(req.encontradas, 'chip-ok', 'check')}
          ${(req.faltantes || []).length ? chips(req.faltantes, 'chip-err', 'x') : ''}
        </div>
      </div>
      <div>
        <div class="grupo-label">Deseables</div>
        <div class="chips">
          ${chips(des.encontradas, 'chip-ok-suave', 'plus')}
          ${(des.faltantes || []).length ? chips(des.faltantes, 'chip-err-suave') : ''}
        </div>
      </div>
      ${(r.motivos || []).length ? `<ul class="motivos">${r.motivos.map(m => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
    </article>`;
}

function renderResultado(res) {
  const resultados = res.resultados || [];
  const mejor = resultados.find(r => r.perfilId === res.mejor);
  const cercano = [...resultados].sort((a, b) => (b.puntaje || 0) - (a.puntaje || 0))[0];
  const d = res.datos || {};

  const veredicto = mejor
    ? `<div class="veredicto veredicto-ok"><i data-lucide="badge-check"></i>
        <div><div class="v-titulo">Perfil sugerido: ${esc(mejor.nombre)} — puntaje ${esc(mejor.puntaje)}</div>
        <div class="sub" style="color:inherit">Cumple todos los requisitos excluyentes y supera el umbral del perfil.</div></div>`
    : `<div class="veredicto veredicto-warn"><i data-lucide="alert-triangle"></i>
        <div><div class="v-titulo">No cumple ningún perfil</div>
        <div class="sub" style="color:inherit">${cercano
          ? `Más cercano: <strong>${esc(cercano.nombre)}</strong> — puntaje ${esc(cercano.puntaje)}`
          : 'No hay perfiles cargados para comparar.'}</div></div>`;

  $('#resultado').innerHTML = `
    ${veredicto}
      <div class="acciones-v">
        <button type="button" class="btn btn-sm js-reanalizar"><i data-lucide="refresh-cw"></i>Volver a analizar</button>
      </div>
    </div>
    <p class="sub" style="margin-top:8px">
      ${res.archivo ? `Archivo: <strong>${esc(res.archivo)}</strong> · ` : 'Texto pegado · '}${esc(res.caracteres ?? 0)} caracteres leídos
    </p>
    <div class="datos">
      ${dato('Email', d.email)}
      ${dato('Teléfono', d.telefono)}
      ${dato('Años de experiencia', d.aniosExperiencia)}
      ${dato('Estudios', d.estudios ? (ETIQUETA_ESTUDIOS[d.estudios] || d.estudios) : '')}
    </div>
    <div class="perfiles-res">
      ${resultados.length ? resultados.map(r => tarjetaPerfil(r, r.perfilId === res.mejor)).join('')
        : '<div class="empty" style="grid-column:1/-1">No hay perfiles para comparar. Cargalos en la pestaña «Perfiles».</div>'}
    </div>
    <details class="texto-extraido">
      <summary>Ver texto extraído</summary>
      <pre>${esc(res.textoExtraido || '')}</pre>
    </details>`;
  iconos();
}

$('#resultado').addEventListener('click', ev => {
  if (ev.target.closest('.js-reanalizar') && ultimoEnvio) analizar(ultimoEnvio);
});

// ── Perfiles ─────────────────────────────────────────────────────────────────
function renderPerfiles() {
  $('#estado-perfiles').textContent = perfiles.length
    ? `Se compara contra ${perfiles.length} perfil${perfiles.length === 1 ? '' : 'es'}.`
    : 'No hay perfiles cargados: creá uno en la pestaña «Perfiles».';

  if (!perfiles.length) {
    $('#lista-perfiles').innerHTML = '<div class="empty"><i data-lucide="list-checks"></i><div>Todavía no hay perfiles de puesto. Creá el primero con «Nuevo perfil».</div></div>';
    iconos();
    return;
  }
  $('#lista-perfiles').innerHTML = perfiles.map((p, i) => `
    <div class="perfil-item">
      <div>
        <div class="res-nombre">${esc(p.nombre)}</div>
        ${p.descripcion ? `<div class="sub">${esc(p.descripcion)}</div>` : ''}
        <div class="perfil-meta">
          <span>Experiencia mínima: <strong>${esc(p.aniosMin || 0)} año${Number(p.aniosMin) === 1 ? '' : 's'}</strong></span>
          <span>Estudios mínimos: <strong>${esc(ETIQUETA_ESTUDIOS[p.estudiosMin || ''] || p.estudiosMin)}</strong></span>
          <span>Umbral: <strong>${esc(p.umbral)}</strong></span>
        </div>
      </div>
      <div class="perfil-acciones">
        <button class="btn btn-sm js-editar" data-i="${i}" type="button"><i data-lucide="pencil"></i>Editar</button>
        <button class="btn btn-sm btn-danger js-eliminar" data-i="${i}" type="button"><i data-lucide="trash-2"></i>Eliminar</button>
      </div>
      <div class="perfil-chips">
        <div><div class="grupo-label">Requeridas</div><div class="chips">${chips(p.requeridas, 'chip-ok')}</div></div>
        <div><div class="grupo-label">Deseables</div><div class="chips">${chips(p.deseables, 'chip-ok-suave')}</div></div>
      </div>
    </div>`).join('');
  iconos();
}

async function cargarPerfiles() {
  try {
    perfiles = (await api(`${API}/perfiles`)).perfiles || [];
    mostrarError('#error-perfiles', '');
  } catch (err) {
    mostrarError('#error-perfiles', err.message);
  }
  renderPerfiles();
}

// PUT de la lista completa; el server devuelve los perfiles normalizados.
async function guardarPerfiles(lista) {
  const res = await api(`${API}/perfiles`, { method: 'PUT', body: JSON.stringify({ perfiles: lista }) });
  perfiles = res.perfiles || [];
  renderPerfiles();
  if (ultimoEnvio) toast('Perfiles guardados. Usá «Volver a analizar» para recalcular el último CV.');
  else toast('Perfiles guardados.');
}

// ── Modales ──────────────────────────────────────────────────────────────────
function cerrarModal() { $('#modales').innerHTML = ''; }

function abrirModal(html) {
  $('#modales').innerHTML = `<div class="overlay" role="dialog" aria-modal="true">${html}</div>`;
  iconos();
  const overlay = $('#modales .overlay');
  overlay.addEventListener('mousedown', ev => { if (ev.target === overlay) cerrarModal(); });
  const foco = $('#modales [data-autofocus]');
  if (foco) foco.focus();
}
document.addEventListener('keydown', ev => { if (ev.key === 'Escape') cerrarModal(); });

const lineas = txt => txt.split('\n').map(s => s.trim()).filter(Boolean);

function modalPerfil(indice) {
  const esNuevo = indice === null;
  const p = esNuevo
    ? { nombre: '', descripcion: '', requeridas: [], deseables: [], aniosMin: 0, estudiosMin: '', umbral: 60 }
    : perfiles[indice];

  abrirModal(`
    <div class="modal">
      <div class="modal-head">
        <i data-lucide="${esNuevo ? 'plus' : 'pencil'}" style="width:20px;height:20px;color:var(--area)"></i>
        <h2>${esNuevo ? 'Nuevo perfil' : 'Editar perfil'}</h2>
      </div>
      <form id="form-perfil">
        <div class="modal-body">
          <div id="form-error" class="aviso aviso-err hidden"><i data-lucide="alert-triangle"></i><span></span></div>
          <div class="grid-form">
            <div class="field field-full">
              <label class="field-label" for="p-nombre">Nombre del puesto *</label>
              <input type="text" id="p-nombre" value="${esc(p.nombre)}" required data-autofocus autocomplete="off">
            </div>
            <div class="field field-full">
              <label class="field-label" for="p-desc">Descripción</label>
              <textarea id="p-desc" rows="2">${esc(p.descripcion)}</textarea>
            </div>
            <div class="dos">
              <div class="field">
                <label class="field-label" for="p-req">Requeridas (excluyentes)</label>
                <textarea id="p-req" rows="7" placeholder="excel|planilla de calculo&#10;atención al cliente">${esc((p.requeridas || []).join('\n'))}</textarea>
              </div>
              <div class="field">
                <label class="field-label" for="p-des">Deseables (suman puntaje)</label>
                <textarea id="p-des" rows="7" placeholder="autoelevador&#10;sap|erp">${esc((p.deseables || []).join('\n'))}</textarea>
              </div>
            </div>
            <p class="field-hint field-full">
              Una palabra clave por línea. Separá sinónimos con <code>|</code>: «excel|planilla de calculo» cuenta si aparece cualquiera de los dos.
              Si falta una requerida, el CV no cumple el perfil.
            </p>
            <div class="field">
              <label class="field-label" for="p-anios">Años mínimos de experiencia</label>
              <input type="number" id="p-anios" min="0" max="60" step="1" value="${esc(p.aniosMin ?? 0)}">
            </div>
            <div class="field">
              <label class="field-label" for="p-estudios">Estudios mínimos</label>
              <select id="p-estudios">
                ${ESTUDIOS.map(e => `<option value="${e.valor}"${e.valor === (p.estudiosMin || '') ? ' selected' : ''}>${e.etiqueta}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label class="field-label" for="p-umbral">Umbral para cumplir (0-100)</label>
              <input type="number" id="p-umbral" min="0" max="100" step="1" value="${esc(p.umbral ?? 60)}">
            </div>
          </div>
        </div>
        <div class="modal-foot">
          <button type="button" class="btn" id="cancelar">Cancelar</button>
          <button type="submit" class="btn btn-primary"><i data-lucide="check"></i>Guardar</button>
        </div>
      </form>
    </div>`);

  $('#cancelar').addEventListener('click', cerrarModal);
  $('#form-perfil').addEventListener('submit', async ev => {
    ev.preventDefault();
    const editado = {
      ...(esNuevo ? {} : { id: p.id }),
      nombre: $('#p-nombre').value.trim(),
      descripcion: $('#p-desc').value.trim(),
      requeridas: lineas($('#p-req').value),
      deseables: lineas($('#p-des').value),
      aniosMin: Number($('#p-anios').value) || 0,
      estudiosMin: $('#p-estudios').value,
      umbral: Number($('#p-umbral').value) || 0,
    };
    const lista = esNuevo ? [...perfiles, editado] : perfiles.map((x, i) => (i === indice ? editado : x));
    try {
      await guardarPerfiles(lista);
      cerrarModal();
    } catch (err) {
      mostrarError('#form-error', err.message);
      iconos();
    }
  });
}

// Confirmación propia (sin confirm()).
function modalEliminar(indice) {
  const p = perfiles[indice];
  abrirModal(`
    <div class="modal modal-sm">
      <div class="modal-head">
        <i data-lucide="trash-2" style="width:20px;height:20px;color:var(--err)"></i>
        <h2>Eliminar perfil</h2>
      </div>
      <div class="modal-body">
        <div id="form-error" class="aviso aviso-err hidden"><i data-lucide="alert-triangle"></i><span></span></div>
        <p>¿Eliminar el perfil <strong>${esc(p.nombre)}</strong>? Los próximos CV ya no se compararán contra él.</p>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn" id="cancelar" data-autofocus>Cancelar</button>
        <button type="button" class="btn btn-danger-solid" id="confirmar"><i data-lucide="trash-2"></i>Eliminar</button>
      </div>
    </div>`);
  $('#cancelar').addEventListener('click', cerrarModal);
  $('#confirmar').addEventListener('click', async () => {
    try {
      await guardarPerfiles(perfiles.filter((_, i) => i !== indice));
      cerrarModal();
    } catch (err) {
      mostrarError('#form-error', err.message);
      iconos();
    }
  });
}

$('#btn-nuevo-perfil').addEventListener('click', () => modalPerfil(null));
$('#lista-perfiles').addEventListener('click', ev => {
  const editar = ev.target.closest('.js-editar');
  if (editar) { modalPerfil(Number(editar.dataset.i)); return; }
  const eliminar = ev.target.closest('.js-eliminar');
  if (eliminar) modalEliminar(Number(eliminar.dataset.i));
});

// ── Arranque ─────────────────────────────────────────────────────────────────
fetch('/api/session').then(r => r.json()).then(s => {
  if (s && s.user) {
    document.getElementById('user-name').textContent = s.user.nombre || s.user.usuario;
    document.getElementById('user-chip').classList.remove('hidden');
  }
}).catch(() => {});

cargarPerfiles();
iconos();
