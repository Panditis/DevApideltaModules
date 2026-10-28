// ── rrhh_relevamiento_ropa.js ────────────────────────────────────────────────
// Front del relevamiento de ropa de trabajo (RRHH). El servidor devuelve el
// documento completo (prendas + empleados + resumen) en cada operación, así que
// acá no hay estado parcial que reconciliar: se pisa `doc` y se re-renderiza.
'use strict';

const API = '/api/rrhh/ropa';

const ESTADOS = [
  { valor: 'si', etiqueta: 'Sí, la tiene' },
  { valor: 'no', etiqueta: 'No, le falta' },
  { valor: 'na', etiqueta: 'N/A — no aplica' },
  { valor: '',   etiqueta: 'Sin relevar' },
];
const ESTADO_CORTO = { si: 'Sí', no: 'Falta', na: 'N/A', '': '—' };

let doc = { prendas: [], empleados: [], resumen: null };

// ── Utilidades ───────────────────────────────────────────────────────────────
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const iconos = () => { if (window.lucide) lucide.createIcons(); };

function toast(mensaje, esError) {
  const t = document.createElement('div');
  t.className = 'toast' + (esError ? ' err' : '');
  t.textContent = mensaje;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

// Toda llamada devuelve el documento completo; los 400 traen { error } legible.
async function api(ruta, opciones) {
  const r = await fetch(ruta, {
    headers: { 'Content-Type': 'application/json' },
    ...opciones,
  });
  const cuerpo = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(cuerpo.error || `Error ${r.status}`);
  return cuerpo;
}

async function cargar(ruta, opciones, mensajeOk) {
  try {
    doc = await api(ruta, opciones);
    render();
    if (mensajeOk) toast(mensajeOk);
    return true;
  } catch (err) {
    toast(err.message, true);
    return false;
  }
}

// ── Filtros ──────────────────────────────────────────────────────────────────
function filtros() {
  return {
    texto: $('#f-buscar').value.trim().toLowerCase(),
    area: $('#f-area').value,
    ubicacion: $('#f-ubicacion').value,
    soloFaltantes: $('#f-faltantes').checked,
    soloSinRelevar: $('#f-sin-relevar').checked,
  };
}

function tieneEstado(empleado, estado) {
  return doc.prendas.some(p => (empleado.prendas[p.id] || {}).estado === estado);
}

function empleadosFiltrados() {
  const f = filtros();
  return doc.empleados.filter(e => {
    if (f.area && e.area !== f.area) return false;
    if (f.ubicacion && e.ubicacion !== f.ubicacion) return false;
    if (f.soloFaltantes && !tieneEstado(e, 'no')) return false;
    if (f.soloSinRelevar && !tieneEstado(e, '')) return false;
    if (f.texto) {
      const heno = `${e.nombre} ${e.puesto} ${e.observaciones} ${e.ubicacion}`.toLowerCase();
      if (!heno.includes(f.texto)) return false;
    }
    return true;
  });
}

// ── Render ───────────────────────────────────────────────────────────────────
function renderKpis() {
  const r = doc.resumen || { empleados: 0, prendas: 0, faltantes: 0, sinRelevar: 0, faltantesPorPrenda: {}, porArea: [] };
  const peor = Object.entries(r.faltantesPorPrenda || {})
    .sort((a, b) => b[1] - a[1])
    .find(([, n]) => n > 0);
  const nombrePeor = peor ? (doc.prendas.find(p => p.id === peor[0]) || {}).nombre : null;

  $('#kpis').innerHTML = `
    <div class="kpi">
      <div class="kpi-label">Empleados</div>
      <div class="kpi-value">${r.empleados}</div>
      <div class="kpi-hint">${r.prendas} prenda${r.prendas === 1 ? '' : 's'} en el catálogo</div>
    </div>
    <div class="kpi ${r.faltantes ? 'alert' : ''}">
      <div class="kpi-label">Prendas faltantes</div>
      <div class="kpi-value">${r.faltantes}</div>
      <div class="kpi-hint">${nombrePeor ? `Peor: ${esc(nombrePeor)} (${peor[1]})` : 'Nadie con faltantes'}</div>
    </div>
    <div class="kpi ${r.sinRelevar ? 'warn' : ''}">
      <div class="kpi-label">Sin relevar</div>
      <div class="kpi-value">${r.sinRelevar}</div>
      <div class="kpi-hint">Celdas sin dato cargado</div>
    </div>
    ${(r.porArea || []).slice(0, 2).map(a => `
    <div class="kpi">
      <div class="kpi-label">${esc(a.area)}</div>
      <div class="kpi-value">${a.empleados}</div>
      <div class="kpi-hint">${a.faltantes} faltante${a.faltantes === 1 ? '' : 's'}</div>
    </div>`).join('')}`;
}

// Los selects conservan lo elegido mientras la opción siga existiendo.
function renderSelectoresFiltro() {
  for (const [sel, campo] of [['#f-area', 'area'], ['#f-ubicacion', 'ubicacion']]) {
    const el = $(sel);
    const previo = el.value;
    const valores = [...new Set(doc.empleados.map(e => e[campo]).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'es'));
    el.innerHTML = '<option value="">Todas</option>' +
      valores.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    el.value = valores.includes(previo) ? previo : '';
  }
}

function celdaPrenda(empleado, prenda) {
  const v = empleado.prendas[prenda.id] || { talle: '', estado: '' };
  const talle = v.talle
    ? `<span class="talle">${esc(v.talle)}</span>`
    : '<span class="talle talle-vacio">—</span>';
  const clase = v.estado ? `est-${v.estado}` : 'est-vacio';
  return `<td class="prenda-cell">${talle}<span class="est ${clase}">${ESTADO_CORTO[v.estado]}</span></td>`;
}

function renderTabla() {
  const lista = empleadosFiltrados();

  $('#thead').innerHTML = `<tr>
    <th>Empleado</th>
    <th>Ubicación</th>
    ${doc.prendas.map(p => `<th class="prenda-col">${esc(p.nombre)}</th>`).join('')}
    <th>Observaciones</th>
    <th style="text-align:right">Acciones</th>
  </tr>`;

  const colspan = doc.prendas.length + 4;

  if (!lista.length) {
    $('#tbody').innerHTML = `<tr><td colspan="${colspan}">
      <div class="empty"><i data-lucide="search-x"></i>
        <div>${doc.empleados.length ? 'No hay empleados que cumplan con el filtro.' : 'Todavía no hay empleados cargados.'}</div>
      </div></td></tr>`;
    $('#pie-conteo').textContent = `0 de ${doc.empleados.length} empleados`;
    iconos();
    return;
  }

  // Agrupado por área, igual que la planilla original.
  const porArea = new Map();
  for (const e of lista) {
    if (!porArea.has(e.area)) porArea.set(e.area, []);
    porArea.get(e.area).push(e);
  }
  const areas = [...porArea.keys()].sort((a, b) => a.localeCompare(b, 'es'));

  $('#tbody').innerHTML = areas.map(area => {
    const gente = porArea.get(area).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    const obligatorio = gente.some(e => e.calzadoObligatorio);
    return `
      <tr class="row-area"><td colspan="${colspan}">
        ${esc(area)}<span class="cuenta">${gente.length}</span>
        ${obligatorio ? '<span class="cuenta">· calzado de seguridad obligatorio</span>' : ''}
      </td></tr>` +
      gente.map(e => `
      <tr class="js-fila${e.destacado ? ' destacada' : ''}" data-id="${esc(e.id)}" title="Click para resaltar la fila">
        <td>
          <div class="nombre">${esc(e.nombre)}</div>
          <div class="sub">${esc(e.puesto || 'Sin puesto')}</div>
        </td>
        <td class="sub">${esc(e.ubicacion || '—')}</td>
        ${doc.prendas.map(p => celdaPrenda(e, p)).join('')}
        <td class="obs">${esc(e.observaciones || '')}</td>
        <td>
          <div class="acciones">
            <button class="btn btn-icon js-editar" data-id="${esc(e.id)}" title="Editar" aria-label="Editar ${esc(e.nombre)}"><i data-lucide="pencil"></i></button>
            <button class="btn btn-icon btn-danger js-borrar" data-id="${esc(e.id)}" title="Eliminar" aria-label="Eliminar ${esc(e.nombre)}"><i data-lucide="trash-2"></i></button>
          </div>
        </td>
      </tr>`).join('');
  }).join('');

  $('#pie-conteo').textContent = `${lista.length} de ${doc.empleados.length} empleados`;
  iconos();
}

function render() {
  renderKpis();
  renderSelectoresFiltro();
  renderTabla();
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

function modalEmpleado(empleado) {
  const esNuevo = !empleado;
  const e = empleado || { nombre: '', area: '', puesto: '', ubicacion: '', observaciones: '', calzadoObligatorio: false, prendas: {} };
  const areas = [...new Set(doc.empleados.map(x => x.area).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));

  abrirModal(`
    <div class="modal">
      <div class="modal-head">
        <i data-lucide="${esNuevo ? 'user-plus' : 'pencil'}" style="width:20px;height:20px;color:var(--area)"></i>
        <h2>${esNuevo ? 'Nuevo empleado' : 'Editar empleado'}</h2>
      </div>
      <form id="form-empleado">
        <div class="modal-body">
          <div id="form-error" class="aviso aviso-err hidden"><i data-lucide="alert-triangle"></i><span></span></div>

          <div class="grid-form">
            <div class="field">
              <label class="field-label" for="e-nombre">Nombre completo *</label>
              <input type="text" id="e-nombre" value="${esc(e.nombre)}" required data-autofocus autocomplete="off">
            </div>
            <div class="field">
              <label class="field-label" for="e-area">Área</label>
              <input type="text" id="e-area" list="lista-areas" value="${esc(e.area)}" placeholder="Sin área asignada" autocomplete="off">
              <datalist id="lista-areas">${areas.map(a => `<option value="${esc(a)}">`).join('')}</datalist>
            </div>
            <div class="field">
              <label class="field-label" for="e-puesto">Puesto</label>
              <input type="text" id="e-puesto" value="${esc(e.puesto)}" autocomplete="off">
            </div>
            <div class="field">
              <label class="field-label" for="e-ubicacion">Ubicación</label>
              <input type="text" id="e-ubicacion" value="${esc(e.ubicacion)}" autocomplete="off">
            </div>
            <div class="field field-full">
              <label class="check">
                <input type="checkbox" id="e-calzado" ${e.calzadoObligatorio ? 'checked' : ''}>
                Calzado de seguridad obligatorio
              </label>
            </div>
            <div class="field field-full">
              <label class="field-label" for="e-obs">Observaciones</label>
              <textarea id="e-obs" rows="2">${esc(e.observaciones)}</textarea>
            </div>
          </div>

          <div>
            <div class="field-label" style="margin-bottom:8px">Indumentaria</div>
            ${doc.prendas.length ? `<div class="prendas-grid">
              ${doc.prendas.map(p => {
                const v = e.prendas[p.id] || { talle: '', estado: '' };
                return `<div class="prenda-box">
                  <div class="nom">${esc(p.nombre)}</div>
                  <div class="row">
                    <input type="text" data-talle="${esc(p.id)}" value="${esc(v.talle)}" placeholder="Talle" autocomplete="off" aria-label="Talle de ${esc(p.nombre)}">
                    <select data-estado="${esc(p.id)}" aria-label="Estado de ${esc(p.nombre)}">
                      ${ESTADOS.map(o => `<option value="${o.valor}"${o.valor === v.estado ? ' selected' : ''}>${o.etiqueta}</option>`).join('')}
                    </select>
                  </div>
                </div>`;
              }).join('')}
            </div>` : '<p class="sub">Todavía no hay prendas cargadas. Agregalas desde el botón «Indumentaria».</p>'}
          </div>
        </div>
        <div class="modal-foot">
          <button type="button" class="btn" id="cancelar">Cancelar</button>
          <button type="submit" class="btn btn-primary"><i data-lucide="check"></i>Guardar</button>
        </div>
      </form>
    </div>`);

  $('#cancelar').addEventListener('click', cerrarModal);
  $('#form-empleado').addEventListener('submit', async ev => {
    ev.preventDefault();
    const prendas = {};
    for (const p of doc.prendas) {
      prendas[p.id] = {
        talle: $(`[data-talle="${CSS.escape(p.id)}"]`).value,
        estado: $(`[data-estado="${CSS.escape(p.id)}"]`).value,
      };
    }
    const cuerpo = {
      nombre: $('#e-nombre').value,
      area: $('#e-area').value,
      puesto: $('#e-puesto').value,
      ubicacion: $('#e-ubicacion').value,
      calzadoObligatorio: $('#e-calzado').checked,
      observaciones: $('#e-obs').value,
      prendas,
    };
    const ruta = esNuevo ? `${API}/empleados` : `${API}/empleados/${encodeURIComponent(e.id)}`;
    try {
      doc = await api(ruta, { method: esNuevo ? 'POST' : 'PUT', body: JSON.stringify(cuerpo) });
      cerrarModal();
      render();
      toast(esNuevo ? 'Empleado agregado.' : 'Empleado actualizado.');
    } catch (err) {
      const caja = $('#form-error');
      caja.querySelector('span').textContent = err.message;
      caja.classList.remove('hidden');
      iconos();
    }
  });
}

function modalIndumentaria() {
  abrirModal(`
    <div class="modal modal-sm">
      <div class="modal-head">
        <i data-lucide="layers" style="width:20px;height:20px;color:var(--area)"></i>
        <h2>Indumentaria</h2>
      </div>
      <div class="modal-body">
        <p class="sub">
          Cada prenda es una columna del relevamiento. Al agregar una, todos los empleados
          la arrancan «sin relevar»; al borrarla se pierden sus talles.
        </p>
        <div id="lista-prendas">
          ${doc.prendas.length ? doc.prendas.map(p => `
            <div class="prenda-item">
              <span class="id">${esc(p.id)}</span>
              <input type="text" value="${esc(p.nombre)}" data-nombre="${esc(p.id)}" aria-label="Nombre de ${esc(p.nombre)}">
              <button class="btn btn-sm js-renombrar" data-id="${esc(p.id)}" type="button">Renombrar</button>
              <button class="btn btn-icon btn-danger js-borrar-prenda" data-id="${esc(p.id)}" type="button" title="Eliminar" aria-label="Eliminar ${esc(p.nombre)}"><i data-lucide="trash-2"></i></button>
            </div>`).join('') : '<p class="sub">Todavía no hay prendas cargadas.</p>'}
        </div>
        <form id="form-prenda" style="display:flex;gap:8px;align-items:flex-end;border-top:1px solid #eeeee8;padding-top:15px">
          <div class="field" style="flex:1">
            <label class="field-label" for="p-nombre">Nueva prenda</label>
            <input type="text" id="p-nombre" placeholder="Ej: Guantes de nitrilo" required data-autofocus autocomplete="off">
          </div>
          <button type="submit" class="btn btn-primary"><i data-lucide="plus"></i>Agregar</button>
        </form>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn" id="cerrar">Cerrar</button>
      </div>
    </div>`);

  $('#cerrar').addEventListener('click', cerrarModal);

  $('#form-prenda').addEventListener('submit', async ev => {
    ev.preventDefault();
    const nombre = $('#p-nombre').value;
    if (await cargar(`${API}/prendas`, { method: 'POST', body: JSON.stringify({ nombre }) }, 'Prenda agregada.')) {
      modalIndumentaria();
    }
  });

  $('#lista-prendas').addEventListener('click', async ev => {
    const renombrar = ev.target.closest('.js-renombrar');
    if (renombrar) {
      const id = renombrar.dataset.id;
      const nombre = $(`[data-nombre="${CSS.escape(id)}"]`).value;
      if (await cargar(`${API}/prendas/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ nombre }) }, 'Prenda renombrada.')) {
        modalIndumentaria();
      }
      return;
    }
    const borrar = ev.target.closest('.js-borrar-prenda');
    if (borrar) {
      const id = borrar.dataset.id;
      const prenda = doc.prendas.find(p => p.id === id);
      if (!(await apdConfirmar(`¿Eliminar "${prenda ? prenda.nombre : id}" del relevamiento? Se pierden los talles cargados de esa prenda.`,
        { titulo: 'Eliminar prenda', aceptar: 'Eliminar', peligro: true }))) return;
      if (await cargar(`${API}/prendas/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Prenda eliminada.')) {
        modalIndumentaria();
      }
    }
  });
}

// ── Eventos de página ────────────────────────────────────────────────────────
$('#btn-nuevo').addEventListener('click', () => modalEmpleado(null));
$('#btn-indumentaria').addEventListener('click', modalIndumentaria);

for (const sel of ['#f-buscar', '#f-area', '#f-ubicacion', '#f-faltantes', '#f-sin-relevar']) {
  $(sel).addEventListener('input', renderTabla);
}
$('#btn-limpiar').addEventListener('click', () => {
  $('#f-buscar').value = '';
  $('#f-area').value = '';
  $('#f-ubicacion').value = '';
  $('#f-faltantes').checked = false;
  $('#f-sin-relevar').checked = false;
  renderTabla();
});

$('#tbody').addEventListener('click', async ev => {
  const editar = ev.target.closest('.js-editar');
  if (editar) {
    const e = doc.empleados.find(x => x.id === editar.dataset.id);
    if (e) modalEmpleado(e);
    return;
  }
  const borrar = ev.target.closest('.js-borrar');
  if (borrar) {
    const e = doc.empleados.find(x => x.id === borrar.dataset.id);
    if (!e || !(await apdConfirmar(`¿Eliminar a ${e.nombre} del relevamiento?`, { titulo: 'Eliminar empleado', aceptar: 'Eliminar', peligro: true }))) return;
    await cargar(`${API}/empleados/${encodeURIComponent(e.id)}`, { method: 'DELETE' }, 'Empleado eliminado.');
    return;
  }
  // Click en cualquier otro lado de la fila: resalta / des-resalta para todos.
  const fila = ev.target.closest('.js-fila');
  if (fila) {
    const e = doc.empleados.find(x => x.id === fila.dataset.id);
    if (!e) return;
    fila.classList.toggle('destacada');           // feedback inmediato; render() lo confirma
    await cargar(`${API}/empleados/${encodeURIComponent(e.id)}/destacado`,
      { method: 'PATCH', body: JSON.stringify({ destacado: !e.destacado }) });
  }
});

fetch('/api/session').then(r => r.json()).then(s => {
  if (s && s.user) {
    document.getElementById('user-name').textContent = s.user.nombre || s.user.usuario;
    document.getElementById('user-chip').classList.remove('hidden');
  }
}).catch(() => {});

cargar(API);
iconos();

// Cambios de otras pestañas en vivo: el server manda el documento entero en cada
// escritura y acá se reemplaza la copia local. EventSource reconecta solo si se corta.
new EventSource(`${API}/stream`).onmessage = ev => {
  try { doc = JSON.parse(ev.data); render(); } catch { /* evento cortado: llega el siguiente */ }
};
