'use strict';
// ── Cotizador mayorista · pestaña Exportar, pasos 1 (vista previa) y 2 (generar versión) ──
// GET /preview, POST /exportar. Publicar por FTP: cotizador_mayorista_publicar.js; descarga y subida a mano: cotizador_mayorista_subida.js.

const exp = { previa: null, version: null, diff: null, revisar: null };

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONO = { // trazos (atributo d) de cada ícono
  prod: ['M21 8 12 3 3 8v8l9 5 9-5V8Z', 'm3 8 9 5 9-5M12 13v8'],
  ok: ['m5 12 5 5 9-10'],
  resp: ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5'],
  rev: ['M12 9v4M12 17h.01', 'M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z'],
};
function iconoSvg(clave) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
    .forEach(([k, v]) => svg.setAttribute(k, v));
  ICONO[clave].forEach(d => {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  });
  return svg;
}
const statCard = (clave, tono, etiqueta, valor, detalle) => h('div', { class: 'stat-card' },
  h('span', { class: `stat-ico t-${tono}`, 'aria-hidden': 'true' }, iconoSvg(clave)),
  h('div', { class: 'stat-body' }, h('span', { class: 'stat-lbl' }, etiqueta), h('span', { class: 'stat-val' }, fmtNum(valor)), detalle ? h('span', { class: 'stat-det' }, detalle) : null));

function resumenPrevia(p) {
  const filas = p.filas || [];
  const conOrigen = o => filas.filter(f => f.origen && (f.origen.pack === o || f.origen.bulto === o)).length;
  const conRespaldo = conOrigen('respaldo');
  const cods = new Set(filas.map(f => f.cod));
  const ausentes = (p.revisar || []).filter(r => !cods.has(r.cod)).length;
  return h('div', { class: 'stat-cards' },
    statCard('prod', 'info', 'Productos en el catálogo', p.productos, p.ultimaVersion != null ? `Última versión: v${p.ultimaVersion}` : 'Todavía no hay versiones'),
    statCard('ok', 'verde', 'Con precio de SIGA', conOrigen('siga'), 'Precio de SIGA, tal cual'),
    statCard('resp', 'warn', 'Con respaldo', conRespaldo, 'Usan el último precio publicado'),
    statCard('rev', (p.revisar || []).length ? 'crit' : 'verde', 'A revisar', (p.revisar || []).length, ausentes ? `${fmtNum(ausentes)} no salen en el catálogo` : 'Todos salen en el catálogo'));
}

function cajaLista(clase, titulo, items) {
  if (!items.length) return null;
  return h('div', { class: `${clase} text-sm`, role: clase === 'error' ? 'alert' : null },
    h('strong', null, titulo), h('ul', { class: 'lista-msg' }, items.map(t => h('li', null, t))));
}

function bloqueRevisar(revisar) {
  if (!revisar.length) return h('div', { class: 'empty' }, 'No hay nada para revisar: todos los productos tienen precio de SIGA.');
  const tabla = crearTabla({
    cols: [
      { key: 'cod', titulo: 'Cod', ancho: '90px', valor: f => f.cod },
      { key: 'nombre', titulo: 'Nombre', ancho: '34%', valor: f => f.nombre },
      { key: 'motivos', titulo: 'Motivos', ancho: 'auto', valor: f => f.motivos.join(' · '), celda: f => f.motivos.join(' · ') },
      { key: 'respaldo', titulo: 'Qué pasa', ancho: '210px', valor: f => (f.respaldo ? 0 : 1),
        celda: f => (f.respaldo ? chip('Usa el último precio publicado', 'warn') : chip('No sale en el catálogo', 'crit')) },
    ],
  });
  tabla.el.classList.add('max-h-[300px]');
  tabla.set(revisar);
  return h('details', { class: 'acordeon', open: true }, h('summary', { class: 'acordeon-sum' }, h('span', { class: 'caret', 'aria-hidden': 'true' }, '▶'), `A revisar (${fmtNum(revisar.length)})`), h('div', { class: 'p-3' }, tabla.el));
}

const diffVista = crearDiff();

function pintarPrevia(p) {
  const hayErrores = (p.errores || []).length > 0;
  montar($('previa'),
    resumenPrevia(p),
    cajaLista('error', 'Errores que impiden generar la versión', p.errores || []),
    cajaLista('aviso-amarillo', 'Avisos', p.avisos || []),
    h('div', { class: 'space-y-2' },
      h('h3', { class: 'subtitulo' }, 'Cambios respecto de la última versión', p.ultimaVersion != null ? ` (v${p.ultimaVersion})` : ''),
      h('p', { class: 'text-sm text-gris' }, 'Solo informativo: no hace falta confirmar nada. Sirve para detectar subas o bajas raras antes de subir.'),
      p.ultimaVersion == null ? h('div', { class: 'empty' }, 'Todavía no hay una versión publicada para comparar: todo va a figurar como nuevo.') : null,
      diffVista.el),
    bloqueRevisar(p.revisar || []));
  diffVista.set(p.diff);
  actualizarBotonGenerar(hayErrores, (p.filas || []).length);
}

let generando = false;
async function actualizarBotonGenerar(hayErrores, nFilas) {
  const boton = $('btnGenerar');
  const puede = await permisoEditar;
  const motivo = !puede ? TIP_SIN_PERMISO : hayErrores ? 'Corregí los errores de la vista previa antes de generar' : !nFilas ? 'No hay productos para exportar' : '';
  boton.disabled = !!motivo || generando;
  boton.title = motivo;
  $('motivoGenerar').textContent = motivo;
  pub.motivoGenerar = motivo;
  refrescarBotonesPublicar();
}

async function cargarPrevia() {
  const boton = $('btnPrevia');
  boton.disabled = true;
  estadoCarga($('previa'), 'Calculando la vista previa con los precios actuales…');
  try {
    exp.previa = await api('/preview');
    pintarPrevia(exp.previa);
  } catch (err) {
    exp.previa = null;
    estadoError($('previa'), err);
    actualizarBotonGenerar(true, 0);
  } finally {
    boton.disabled = false;
  }
}

function pintarResultado(r) {
  const d = r.diff || {};
  montar($('resultado'), h('div', { class: 'ok-box', role: 'status' },
    h('strong', null, `Versión v${r.version} generada`),
    h('dl', { class: 'datos' },
      h('dt', null, 'Fecha'), h('dd', null, fmtFecha(r.generado)),
      h('dt', null, 'Productos'), h('dd', null, fmtNum(r.productos)),
      h('dt', null, 'sha256'), h('dd', { title: r.sha256, class: 'mono' }, String(r.sha256 || '').slice(0, 12)),
      h('dt', null, 'Cambios'), h('dd', null, `${fmtNum((d.nuevos || []).length)} nuevos · ${fmtNum((d.quitados || []).length)} quitados · ${fmtNum((d.cambiados || []).length)} cambiados`))));
}

async function generarVersion() {
  generando = true;
  const boton = $('btnGenerar');
  boton.disabled = true;
  boton.textContent = 'Generando…';
  try {
    const r = await apiJson('/exportar', 'POST', {});
    exp.version = r.version;
    pintarResultado(r);
    toast(`Versión v${r.version} generada.`);
    renderDescarga(r.version);
    cargarPrevia();
    return r.version;
  } catch (err) {
    estadoError($('resultado'), err);
    return null;
  } finally {
    generando = false;
    boton.textContent = 'Generar versión';
    if (exp.previa) actualizarBotonGenerar((exp.previa.errores || []).length > 0, (exp.previa.filas || []).length);
  }
}

function iniciarExportar() {
  $('btnPrevia').addEventListener('click', cargarPrevia);
  $('btnGenerar').addEventListener('click', generarVersion);
  cargarPrevia().then(() => { if (exp.previa && exp.version == null) renderDescarga(exp.previa.ultimaVersion); });
  iniciarSubida();
  iniciarPublicar();
}
