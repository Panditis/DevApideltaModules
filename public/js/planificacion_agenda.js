'use strict';

// ── Agenda de bloques: carga y guardado ──────────────────────────
// Los bloques viven dentro del plan del día, así que la agenda se lee del mismo GET del plan.
// Los horarios NO se persisten calculados: se recalculan al abrir para que un cambio de
// inicio de jornada corra toda la cadena sin tener que reescribir cada bloque.
async function cargarAgenda() {
  const cont = document.getElementById('agGantt');
  if (!fechaPlanActual) {
    document.getElementById('agTitulo').textContent = 'Seleccioná un día en Plan del día';
    cont.innerHTML = '<div class="loading">Sin día elegido.</div>';
    document.getElementById('agTabla').innerHTML = '';
    return;
  }
  document.getElementById('agTitulo').textContent = `Agenda del ${fechaPlanActual}`;
  try {
    // Las plantillas cambian poco: se piden una sola vez por sesión.
    if (!plantillasTareas.length) plantillasTareas = await api('GET', '/api/plantillas-tareas') || [];
    const plan = await api('GET', `/api/plan/${fechaPlanActual}`);
    planCache = plan;
    document.getElementById('agJornada').value = plan.jornadaInicio || '08:00';
    bloquesDia = BT.recalcularHorarios(plan.bloques || [], plan.jornadaInicio || '08:00');
    renderAgenda();
  } catch (e) {
    cont.innerHTML = `<div class="loading">No se pudo cargar la agenda: ${e.message}</div>`;
  }
}

async function guardarAgenda() {
  if (!fechaPlanActual) return;
  const jornadaInicio = document.getElementById('agJornada').value || '08:00';
  try {
    await api('POST', `/api/plan/${fechaPlanActual}/bloques`, { jornadaInicio, bloques: bloquesDia });
  } catch (e) {
    toast('No se pudo guardar la agenda: ' + e.message, true);
  }
}


// ── Agenda de bloques: render ────────────────────────────────────
// Todo lo que va al innerHTML pasa por escHtml(): los nombres de tarea y de producto los
// escribe el usuario (el modal de plantillas, el plan del día), así que no son confiables.
const AG_PX_HORA = 132;   // ancho de una hora del Gantt, en px (11 px por cada 5 minutos)
// Un color por producto. La misma tarea ("Envasado") aparece en varios productos el mismo día:
// sin color no hay forma de saber de un vistazo cuál es cuál.
const AG_COLORES = ['#3b6ea5', '#7a4fa3', '#1f7a5c', '#a8552b', '#4a6b1f', '#a03b6a', '#2f6f7d', '#8a6a1f'];

// "3 h 20" en vez de "200 min": nadie planifica una jornada en minutos sueltos.
function agHoras(min) {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? `${h} h${m ? ' ' + m : ''}` : `${m} min`;
}

// Gantt por persona: una fila por responsable, cada barra ubicada y dimensionada AL MINUTO
// (en px, no por celdas de media hora). Si la barra se redondeara a la celda, una tarea de 10'
// se vería de 30' y una que arranca 09:10 se dibujaría a las 09:00: el dibujo contradiría a la
// tabla de abajo, que es la que el operario lee para saber la hora real.
function renderGantt(bloques, idsSolapados) {
  const cont = document.getElementById('agGantt');
  if (!bloques.length) { cont.innerHTML = '<div class="loading">Sin bloques todavía. Usá "Generar bloques".</div>'; return; }
  const jornada = BT.minutosDeHora(document.getElementById('agJornada').value);
  // La grilla empieza en la hora en punto anterior al arranque, así las marcas caen redondas.
  const desde = Math.floor((jornada == null ? 480 : jornada) / 60) * 60;
  const finMax = bloques.reduce((max, b) => Math.max(max, BT.minutosDeHora(b.fin) || 0), desde + 60);
  const hasta = Math.ceil(finMax / 60) * 60;
  const pxMin = AG_PX_HORA / 60;
  const ancho = Math.round((hasta - desde) * pxMin);
  const solapes = new Set(idsSolapados);
  const enX = m => Math.round((m - desde) * pxMin);

  const productos = [...new Set(bloques.map(b => b.producto || 'Sin producto'))];
  const colorDe = p => AG_COLORES[productos.indexOf(p) % AG_COLORES.length];

  let marcas = '';
  for (let m = desde; m <= hasta; m += 30) marcas += `<div class="ag-marca${m % 60 ? ' media' : ''}" style="left:${enX(m)}px"></div>`;
  let horas = '';
  for (let m = desde; m <= hasta; m += 60) horas += `<div class="ag-hora" style="left:${enX(m) + 4}px">${BT.horaDeMinutos(m)}</div>`;

  // Línea de "ahora", sólo si la agenda abierta es la de hoy: en un plan de la semana que viene
  // una línea roja a las 11:20 no significa nada.
  let ahora = '';
  const h = new Date();
  const hoyISO = `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}-${String(h.getDate()).padStart(2, '0')}`;
  if (fechaPlanActual === hoyISO) {
    const min = h.getHours() * 60 + h.getMinutes();
    if (min >= desde && min <= hasta) ahora = `<div class="ag-ahora" style="left:${enX(min)}px" title="ahora"></div>`;
  }

  const filas = BT.carrilesPorResponsable(bloques).map((c, i) => {
    const total = c.bloques.reduce((s, b) => s + (Number(b.minutos) || 0), 0);
    // Ordenados por hora para poder medir el hueco hasta la barra siguiente: es el ancho del
    // que dispone una etiqueta que no entró adentro de su barra.
    const orden = c.bloques.slice().sort((a, b) => (BT.minutosDeHora(a.inicio) || 0) - (BT.minutosDeHora(b.inicio) || 0));
    const barras = orden.map((b, j) => {
      const ini = BT.minutosDeHora(b.inicio);
      const x = enX(ini == null ? desde : ini);
      const w = Math.max(12, Math.round((Number(b.minutos) || 0) * pxMin));   // 12px: una tarea de 2' se ve igual
      const cls = ['ag-barra', solapes.has(b.id) ? 'solape' : '', b.excedeDia ? 'excede' : ''].filter(Boolean).join(' ');
      const detalle = `${escHtml(b.producto)} · ${escHtml(b.tarea)} · ${escHtml(b.inicio)}–${escHtml(b.fin)} (${agHoras(Number(b.minutos) || 0)})`;
      const titulo = `title="${detalle}${solapes.has(b.id) ? ' · SE SOLAPA con otra tarea de esta persona' : ''}${b.excedeDia ? ' · se pasa del día' : ''}"`;
      const barra = `<div class="${cls}" style="left:${x}px;width:${w}px;background-color:${colorDe(b.producto || 'Sin producto')}" ${titulo}>`;

      // Ancho que necesita el texto, estimado a ojo de Roboto 12px (~6.4px por carácter) más
      // los 24px de padding. Medir de verdad obligaría a pintar y volver a leer el layout.
      const necesita = Math.round(String(b.tarea || '').length * 6.4) + 24;
      if (w >= necesita) {
        // Entra adentro: dos líneas, tarea arriba y el rango horario abajo.
        return `${barra}${escHtml(b.tarea)}<small>${escHtml(b.inicio)}–${escHtml(b.fin)}</small></div>`;
      }
      // No entra: la barra queda muda y el texto va a su derecha, sin pisar la barra siguiente.
      const sig = orden[j + 1];
      // Sin barra siguiente el tope es el borde de la pista: la grilla recorta lo que se pase.
      const xSig = sig ? enX(BT.minutosDeHora(sig.inicio) || desde) : ancho;
      const hueco = Math.max(56, xSig - (x + w) - 12);
      return `${barra}</div>
              <div class="ag-etiqueta" style="left:${x + w + 6}px;max-width:${hueco}px" ${titulo}
                   >${escHtml(b.tarea)}<small>${escHtml(b.inicio)}</small></div>`;
    }).join('');
    return `<div class="ag-nombre"><b>${escHtml(c.responsable || 'Sin asignar')}</b><small>${c.bloques.length} tareas · ${agHoras(total)}</small></div>
            <div class="ag-pista${i % 2 ? ' par' : ''}" style="width:${ancho}px">${marcas}${ahora}${barras}</div>`;
  }).join('');

  cont.innerHTML = `
    <div class="ag-leyenda">${productos.map(p => `<span><i style="background:${colorDe(p)}"></i>${escHtml(p)}</span>`).join('')}</div>
    <div class="ag-gantt">
      <div class="ag-grilla">
        <div class="ag-nombre cab"></div>
        <div class="ag-pista cab" style="width:${ancho}px">${marcas}${horas}</div>
        ${filas}
      </div>
    </div>`;
}

// Tabla editable agrupada por producto, en <details> como las reservas por cliente.
function renderTablaAgenda(bloques, idsSolapados) {
  const cont = document.getElementById('agTabla');
  const solapes = new Set(idsSolapados);
  const items = (planCache && planCache.items) || [];
  const porItem = new Map();
  for (const b of bloques) {
    const k = String(b.itemId);
    if (!porItem.has(k)) porItem.set(k, []);
    porItem.get(k).push(b);
  }
  if (!porItem.size) { cont.innerHTML = '<div class="loading">Sin bloques todavía.</div>'; return; }

  const grupos = [...porItem.entries()].map(([itemId, lista]) => {
    lista.sort((a, b) => a.orden - b.orden);
    const item = items.find(i => String(i.id) === itemId);
    const cantHoy = Number(item && item.cantConfirmada) || 0;
    const cantGen = Number(lista[0].cantGenerada) || 0;
    // La cantidad del plan cambió después de generar: los minutos que se ven ya no salen de ahí.
    const aviso = item && cantGen && cantHoy !== cantGen
      ? `<span class="ag-aviso">cantidad cambió (${cantGen} → ${cantHoy}): regenerá este producto</span>` : '';
    const filas = lista.map(b => `
      <tr data-id="${b.id}" class="${solapes.has(b.id) ? 'solape' : ''}">
        <td>${escHtml(b.tarea)}</td>
        <td>${(b.responsables || []).map(r => `<span class="ag-chip-resp" data-quitar="${escHtml(r)}">${escHtml(r)} ×</span>`).join('')}
            <select class="ag-add-resp"><option value="">+ persona…</option>
              ${responsablesCache.map(r => `<option value="${escHtml(r.corto)}">${escHtml(r.corto)}</option>`).join('')}
            </select></td>
        <td><input type="number" min="0" step="5" class="ag-min" value="${b.minutos}"></td>
        <td><input type="time" class="ag-ini" value="${b.manual ? escHtml(b.inicio) : ''}" placeholder="${escHtml(b.inicio)}"></td>
        <td>${escHtml(b.inicio)} → ${escHtml(b.fin)}${b.excedeDia ? ' <span class="ag-aviso">se pasa del día</span>' : ''}</td>
        <td class="no-print"><button class="btn btn-secondary btn-sm ag-sube">↑</button>
            <button class="btn btn-secondary btn-sm ag-baja">↓</button>
            <button class="btn btn-danger btn-sm ag-borra">🗑</button></td>
      </tr>`).join('');
    const total = lista.reduce((s, b) => s + (Number(b.minutos) || 0), 0);
    return `
      <details class="ag-grupo" open data-item="${escHtml(itemId)}">
        <summary>${escHtml(lista[0].producto)} · ${lista.length} bloques · ${Math.round(total / 6) / 10} h ${aviso}</summary>
        <table class="ag-tabla">
          <thead><tr><th>Tarea</th><th>Responsables</th><th>Min</th><th>Inicio fijo</th><th>Horario</th><th class="no-print"></th></tr></thead>
          <tbody>${filas}</tbody>
        </table>
        <div class="no-print" style="padding:6px 8px">
          <button class="btn btn-secondary btn-sm ag-nuevo">+ bloque</button>
          <button class="btn btn-secondary btn-sm ag-regen">↻ regenerar desde plantilla</button>
        </div>
      </details>`;
  });
  cont.innerHTML = grupos.join('');
}

function renderAgenda() {
  const solapados = BT.detectarSolapes(bloquesDia);
  renderGantt(bloquesDia, solapados);
  renderTablaAgenda(bloquesDia, solapados);
  const horas = bloquesDia.reduce((s, b) => s + (Number(b.minutos) || 0), 0) / 60;
  document.getElementById('agResumen').textContent =
    `${bloquesDia.length} bloques · ${Math.round(horas * 10) / 10} h`;
  document.getElementById('agSolapes').textContent =
    solapados.length ? `${solapados.length} bloques solapados` : '';
  // Los items del plan que no tienen ninguna plantilla que los cubra.
  const conBloques = new Set(bloquesDia.map(b => String(b.itemId)));
  const sin = ((planCache && planCache.items) || []).filter(i =>
    !conBloques.has(String(i.id)) && !BT.resolverPlantilla(plantillasTareas, i));
  document.getElementById('agSinPlantilla').innerHTML = sin.length
    ? `Sin plantilla: ${sin.map(i => escHtml(i.producto)).join(', ')} — cargala en 📋 Plantillas.` : '';
}

// Recalcula la cadena entera y persiste. Todo cambio de la agenda pasa por acá: una sola
// función que guarda evita que una edición quede sólo en pantalla.
function aplicarCambioAgenda() {
  bloquesDia = BT.recalcularHorarios(bloquesDia, document.getElementById('agJornada').value);
  renderAgenda();
  guardarAgenda();
}

document.getElementById('agJornada').addEventListener('change', aplicarCambioAgenda);

document.getElementById('btnAgGenerar').addEventListener('click', () => {
  if (!fechaPlanActual) return toast('Elegí un día en Plan del día', true);
  const conBloques = new Set(bloquesDia.map(b => String(b.itemId)));
  let ts = Date.now(), nuevos = 0;
  for (const item of ((planCache && planCache.items) || [])) {
    if (conBloques.has(String(item.id))) continue;   // no se pisa lo ya editado
    const plantilla = BT.resolverPlantilla(plantillasTareas, item);
    if (!plantilla) continue;
    const bloques = BT.generarBloques(item, plantilla, ts);
    ts += bloques.length;
    bloquesDia = bloquesDia.concat(bloques);
    nuevos += bloques.length;
  }
  if (!nuevos) return toast('No hay productos nuevos con plantilla', true);
  aplicarCambioAgenda();
  toast(`${nuevos} bloques generados`);
});

document.getElementById('btnAgImprimir').addEventListener('click', () => {
  // Los <details> cerrados no se imprimen: se abren todos antes de mandar a la impresora.
  document.querySelectorAll('#tab-agenda details').forEach(d => { d.open = true; });
  window.print();
});

document.getElementById('agTabla').addEventListener('click', e => {
  const det = e.target.closest('details[data-item]');

  if (e.target.classList.contains('ag-regen') && det) {
    const item = ((planCache && planCache.items) || []).find(i => String(i.id) === det.dataset.item);
    const plantilla = item && BT.resolverPlantilla(plantillasTareas, item);
    if (!plantilla) return toast('Ese producto no tiene plantilla', true);
    bloquesDia = bloquesDia.filter(b => String(b.itemId) !== det.dataset.item)
      .concat(BT.generarBloques(item, plantilla, Date.now()));
    return aplicarCambioAgenda();
  }
  if (e.target.classList.contains('ag-nuevo') && det) {
    const item = ((planCache && planCache.items) || []).find(i => String(i.id) === det.dataset.item);
    const delItem = bloquesDia.filter(b => String(b.itemId) === det.dataset.item);
    bloquesDia.push({
      id: Date.now(), itemId: item ? item.id : det.dataset.item, producto: (item && item.producto) || '',
      tarea: 'Tarea nueva', responsables: [], minutos: 30, inicio: '', fin: '',
      orden: delItem.length + 1, manual: false, cantGenerada: Number(item && item.cantConfirmada) || 0,
    });
    return aplicarCambioAgenda();
  }

  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const id = Number(tr.dataset.id);
  const idx = bloquesDia.findIndex(b => b.id === id);
  if (idx < 0) return;

  if (e.target.classList.contains('ag-borra')) {
    bloquesDia = bloquesDia.filter(b => b.id !== id);
    return aplicarCambioAgenda();
  }
  if (e.target.classList.contains('ag-sube') || e.target.classList.contains('ag-baja')) {
    const paso = e.target.classList.contains('ag-sube') ? -1 : 1;
    const hermanos = bloquesDia.filter(b => String(b.itemId) === String(bloquesDia[idx].itemId))
                               .sort((a, b) => a.orden - b.orden);
    const pos = hermanos.findIndex(b => b.id === id);
    const otro = hermanos[pos + paso];
    if (!otro) return;
    const tmp = bloquesDia[idx].orden;
    bloquesDia[idx].orden = otro.orden;
    otro.orden = tmp;
    return aplicarCambioAgenda();
  }
  if (e.target.dataset.quitar) {
    bloquesDia[idx].responsables = bloquesDia[idx].responsables.filter(r => r !== e.target.dataset.quitar);
    return aplicarCambioAgenda();
  }
});

document.getElementById('agTabla').addEventListener('change', e => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const idx = bloquesDia.findIndex(b => b.id === Number(tr.dataset.id));
  if (idx < 0) return;

  if (e.target.classList.contains('ag-min')) {
    bloquesDia[idx].minutos = Math.max(0, Math.round(Number(e.target.value) || 0));
    return aplicarCambioAgenda();
  }
  if (e.target.classList.contains('ag-ini')) {
    // Poner una hora a mano ancla el bloque: deja de seguir al anterior y los que vienen
    // después arrancan desde él. Vaciar el campo lo devuelve a la cadena.
    const v = e.target.value;
    bloquesDia[idx].manual = !!v;
    bloquesDia[idx].inicio = v || '';
    return aplicarCambioAgenda();
  }
  if (e.target.classList.contains('ag-add-resp') && e.target.value) {
    const r = e.target.value;
    if (!bloquesDia[idx].responsables.includes(r)) bloquesDia[idx].responsables.push(r);
    return aplicarCambioAgenda();
  }
});

// ── Agenda: ABM de plantillas de tareas ──────────────────────────
// Todo el texto de la plantilla lo escribe el usuario, así que cada dato pasa por escHtml()
// antes de entrar al innerHTML.
function renderPlantillas() {
  // Una plantilla cargada a mano en el JSON puede venir sin tareas: normalizar acá evita
  // tener que guardar contra null en cada handler de más abajo.
  plantillasTareas.forEach(p => { if (!Array.isArray(p.tareas)) p.tareas = []; });
  document.getElementById('plLista').innerHTML = plantillasTareas.map((p, i) => `
    <details class="ag-grupo" data-pl="${i}">
      <summary>${escHtml(p.nombre || p.clave)} · ${escHtml(p.alcance)} ${escHtml(p.clave)} · ${p.tareas.length} tareas</summary>
      <div style="padding:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <select class="pl-alcance">
          <option value="producto" ${p.alcance === 'producto' ? 'selected' : ''}>Producto (idProducto)</option>
          <option value="rubro"    ${p.alcance === 'rubro'    ? 'selected' : ''}>Rubro</option>
        </select>
        <input class="pl-clave"  value="${escHtml(p.clave)}"  placeholder="4039 o Miel acacia" style="width:180px">
        <input class="pl-nombre" value="${escHtml(p.nombre)}" placeholder="Nombre visible" style="width:200px">
        <button class="btn btn-secondary btn-sm pl-duplicar">Duplicar</button>
        <button class="btn btn-danger btn-sm pl-borrar">🗑 Plantilla</button>
      </div>
      <table class="ag-tabla">
        <thead><tr><th>Tarea</th><th>Min fijos</th><th>Min × cantidad</th><th>Base</th><th>Responsables</th><th></th></tr></thead>
        <tbody>${p.tareas.map((t, j) => `
          <tr data-t="${j}">
            <td><input class="pl-t-nombre" value="${escHtml(t.nombre)}" style="width:180px"></td>
            <td><input type="number" min="0" step="5"   class="pl-t-fijos" value="${Number(t.minFijos) || 0}"></td>
            <td><input type="number" min="0" step="0.1" class="pl-t-var"   value="${Number(t.minVar) || 0}"></td>
            <td><select class="pl-t-base">
                  <option value="unidad" ${t.base === 'unidad' ? 'selected' : ''}>por unidad</option>
                  <option value="kg"     ${t.base === 'kg'     ? 'selected' : ''}>por kg de granel</option>
                </select></td>
            <td><input class="pl-t-resp" value="${escHtml((t.responsables || []).join(', '))}" placeholder="MICA, JUAN" style="width:140px"></td>
            <td style="white-space:nowrap">
                <button class="btn btn-secondary btn-sm pl-t-sube">↑</button>
                <button class="btn btn-secondary btn-sm pl-t-baja">↓</button>
                <button class="btn btn-danger btn-sm pl-t-borra">🗑</button></td>
          </tr>`).join('')}</tbody>
      </table>
      <div style="padding:6px 8px"><button class="btn btn-secondary btn-sm pl-t-nueva">+ tarea</button></div>
    </details>`).join('') || '<div class="loading">Sin plantillas. Creá la primera.</div>';
}

// Lee del DOM al modelo antes de cualquier acción que redibuje: si no, lo tipeado se pierde.
function leerPlantillasDelDom() {
  document.querySelectorAll('#plLista details[data-pl]').forEach(det => {
    const p = plantillasTareas[Number(det.dataset.pl)];
    if (!p) return;
    p.alcance = det.querySelector('.pl-alcance').value;
    p.clave   = det.querySelector('.pl-clave').value.trim();
    p.nombre  = det.querySelector('.pl-nombre').value.trim();
    det.querySelectorAll('tr[data-t]').forEach(tr => {
      const t = p.tareas[Number(tr.dataset.t)];
      if (!t) return;
      t.nombre   = tr.querySelector('.pl-t-nombre').value.trim();
      t.minFijos = Number(tr.querySelector('.pl-t-fijos').value) || 0;
      t.minVar   = Number(tr.querySelector('.pl-t-var').value) || 0;
      t.base     = tr.querySelector('.pl-t-base').value;
      t.responsables = tr.querySelector('.pl-t-resp').value.split(',').map(s => s.trim()).filter(Boolean);
    });
  });
}

document.getElementById('btnAgPlantillas').addEventListener('click', async () => {
  // Se relee del server en cada apertura: otra pestaña pudo haber tocado las plantillas.
  try { plantillasTareas = await api('GET', '/api/plantillas-tareas') || []; }
  catch (e) { toast('No se pudieron cargar las plantillas: ' + e.message, true); }
  renderPlantillas();
  document.getElementById('overlayPlantillas').classList.add('open');
});
document.getElementById('btnPlCerrar').addEventListener('click', () =>
  document.getElementById('overlayPlantillas').classList.remove('open'));
document.getElementById('overlayPlantillas').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
});

document.getElementById('btnPlNueva').addEventListener('click', () => {
  leerPlantillasDelDom();
  plantillasTareas.push({ id: Date.now(), alcance: 'rubro', clave: '', nombre: 'Plantilla nueva',
    tareas: [{ nombre: 'Envasado', minFijos: 10, minVar: 0.5, base: 'unidad', responsables: [] }] });
  renderPlantillas();
});

document.getElementById('plLista').addEventListener('click', e => {
  const det = e.target.closest('details[data-pl]');
  if (!det) return;
  const i = Number(det.dataset.pl);
  const tr = e.target.closest('tr[data-t]');
  const j = tr ? Number(tr.dataset.t) : -1;
  leerPlantillasDelDom();

  if (e.target.classList.contains('pl-borrar')) { plantillasTareas.splice(i, 1); return renderPlantillas(); }
  if (e.target.classList.contains('pl-duplicar')) {
    // La copia arranca sin clave para que no compita con la original al resolver la plantilla.
    const copia = JSON.parse(JSON.stringify(plantillasTareas[i]));
    copia.id = Date.now(); copia.clave = ''; copia.nombre = (copia.nombre || '') + ' (copia)';
    plantillasTareas.splice(i + 1, 0, copia);
    return renderPlantillas();
  }
  if (e.target.classList.contains('pl-t-nueva')) {
    plantillasTareas[i].tareas.push({ nombre: 'Tarea nueva', minFijos: 0, minVar: 0, base: 'unidad', responsables: [] });
    return renderPlantillas();
  }
  if (j < 0) return;
  const ts = plantillasTareas[i].tareas;
  if (e.target.classList.contains('pl-t-borra')) { ts.splice(j, 1); return renderPlantillas(); }
  if (e.target.classList.contains('pl-t-sube') && j > 0) {
    [ts[j - 1], ts[j]] = [ts[j], ts[j - 1]];
    return renderPlantillas();
  }
  if (e.target.classList.contains('pl-t-baja') && j < ts.length - 1) {
    [ts[j + 1], ts[j]] = [ts[j], ts[j + 1]];
    return renderPlantillas();
  }
});

document.getElementById('btnPlGuardar').addEventListener('click', async () => {
  leerPlantillasDelDom();
  const errores = BT.validarPlantillas(plantillasTareas);
  if (errores.length) return toast(errores[0], true);
  try {
    plantillasTareas = await api('POST', '/api/plantillas-tareas', plantillasTareas);
    renderPlantillas();
    toast('Plantillas guardadas');
    // La agenda muestra qué items quedaron sin plantilla: hay que refrescarla con las nuevas.
    if (fechaPlanActual) renderAgenda();
  } catch (e) {
    toast('No se pudieron guardar: ' + e.message, true);
  }
});

