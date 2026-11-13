'use strict';
// ── Cotizador mayorista · pestaña "Comparación con lo publicado" (GET /comparacion) ──
// Diagnóstico: precios de SIGA contra el último catalogo.csv exportado.

const cmp = { detalle: [], estado: 'todos', tipo: '', q: '' };
const CMP_ESTADOS = [['todos', 'Todos'], ['igual', 'Iguales'], ['cambió', 'Cambiaron'], ['nuevo', 'Nuevos'], ['quitado', 'Quitados'], ['sin dato', 'Sin dato']];
const CMP_TONO = { igual: 'ok', cambió: 'warn', nuevo: 'info', quitado: 'warn', 'sin dato': 'gris' };
const CMP_TXT = { igual: 'Igual', cambió: 'Cambió', nuevo: 'Nuevo', quitado: 'Quitado', 'sin dato': 'Sin dato' };
const cmpTipoTxt = t => (t === 'pack' ? 'Pack' : 'Bulto');

const cmpTabla = crearTabla({
  vacio: 'Ninguna fila coincide con los filtros.',
  cols: [
    { key: 'cod', titulo: 'Cod', ancho: '90px', valor: f => f.cod },
    { key: 'nombre', titulo: 'Nombre', ancho: 'auto', valor: f => f.nombre },
    { key: 'tipo', titulo: 'Tipo', ancho: '76px', valor: f => f.tipo, celda: f => cmpTipoTxt(f.tipo) },
    { key: 'publicado', titulo: 'Publicado', ancho: '110px', num: true, valor: f => f.publicado, celda: f => fmtPrecio(f.publicado) },
    { key: 'sistema', titulo: 'Sistema', ancho: '96px', num: true, valor: f => f.sistema, celda: f => fmtPrecio(f.sistema) },
    { key: 'origen', titulo: 'Origen', ancho: '170px', valor: f => f.origen || '', celda: f => (f.origen === 'siga' ? chip('SIGA', 'gris') : f.origen === 'respaldo' ? chip('Respaldo', 'warn') : '—') },
    { key: 'pct', titulo: '%', ancho: '80px', num: true, valor: f => f.pct, celda: f => h('span', { class: diffClasePct(f.pct) }, fmtPct(f.pct)) },
    { key: 'estado', titulo: 'Estado', ancho: '92px', valor: f => f.estado, celda: f => chip(CMP_TXT[f.estado] || f.estado, CMP_TONO[f.estado]) },
  ],
});
cmpTabla.el.classList.add('tabla-scroll--alta');

const cmpPasa = f => {
  if (cmp.estado !== 'todos' && f.estado !== cmp.estado) return false;
  if (cmp.tipo && f.tipo !== cmp.tipo) return false;
  const t = norm(cmp.q.trim());
  return !t || norm(`${f.cod} ${f.nombre}`).includes(t);
};
const cmpVisibles = () => cmp.detalle.filter(cmpPasa);

function pintarComparacion() {
  const vis = cmpVisibles();
  cmpTabla.set(vis);
  $('cmpCuenta').textContent = `${fmtNum(vis.length)} de ${fmtNum(cmp.detalle.length)} filas`;
  $('btnCmpCsv').disabled = vis.length === 0;
  document.querySelectorAll('#cmpEstados .fbtn').forEach(b => {
    b.classList.toggle('on', b.dataset.estado === cmp.estado);
    b.setAttribute('aria-pressed', String(b.dataset.estado === cmp.estado));
  });
}

function resumenComparacion(r) {
  return h('div', { class: 'stat-cards' },
    statCard('ok', 'verde', 'Iguales', r.iguales, 'Sistema y catálogo coinciden'),
    statCard('rev', 'warn', 'Cambiaron', r.cambiaron, 'El precio de SIGA ya no es el publicado'),
    statCard('resp', 'info', 'Nuevos', r.nuevos, 'Están en el sistema y no en el catálogo'),
    statCard('rev', 'warn', 'Quitados', r.quitados, 'Estaban en el catálogo y ya no'),
    statCard('resp', 'info', 'Sin dato', r.sinDato, 'Falta el precio de un lado'),
    statCard('prod', 'verde', 'Con precio de SIGA', r.conSiga || 0, 'El sistema usa el precio de SIGA tal cual'),
    statCard('resp', 'warn', 'Con respaldo', r.conRespaldo || 0, 'El sistema usa el último precio publicado'));
}

function encabezadoComparacion(r) {
  const ftp = !r.publicado ? 'no subida por FTP'
    : r.publicado.ok ? `subida por FTP el ${fmtFecha(r.publicado.fecha)}`
    : `falló la subida por FTP${r.publicado.error ? `: ${r.publicado.error}` : ''}`;
  return h('p', { class: 'text-sm text-gris' }, `Catálogo v${r.version} · generado ${fmtFecha(r.generado)} · ${ftp}`);
}

const avisoErrores = errores => h('div', { class: 'aviso-amarillo', role: 'alert' },
  h('strong', null, 'Hubo problemas al comparar'), h('ul', null, errores.map(e => h('li', null, e))));

async function cargarComparacion() {
  const cont = $('cmpCont');
  estadoCarga(cont, 'Comparando con lo publicado…');
  $('cmpResumen').replaceChildren();
  cmp.detalle = [];
  try {
    const r = await api('/comparacion');
    if (r.sinPublicaciones) return estadoVacio(cont, 'Todavía no hay catálogo exportado: exportá una versión para poder comparar');
    cmp.detalle = Array.isArray(r.detalle) ? r.detalle : [];
    const th = cmpTabla.el.querySelectorAll('thead th')[3].querySelector('button');
    if (th) th.firstChild.textContent = `Publicado v${r.version}`;
    montar($('cmpResumen'), encabezadoComparacion(r),
      Array.isArray(r.errores) && r.errores.length ? avisoErrores(r.errores) : null, resumenComparacion(r));
    if (!cmp.detalle.length) return estadoVacio(cont, 'No hay productos para comparar.');
    montar(cont, cmpTabla.el);
    return pintarComparacion();
  } catch (err) {
    return estadoError(cont, err);
  }
}

const csvCelda = v => { const s = v == null ? '' : String(v); return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
// ';' y BOM: así Excel en español lo abre con las columnas y las tildes bien.
function exportarComparacionCsv() {
  const filas = cmpVisibles();
  const lineas = [['cod', 'nombre', 'tipo', 'publicado', 'sistema', 'origen', 'pct', 'estado'], ...filas.map(f => [f.cod, f.nombre, f.tipo, f.publicado, f.sistema, f.origen, f.pct, f.estado])];
  descargarBlob('comparacion_publicado.csv', `﻿${lineas.map(l => l.map(csvCelda).join(';')).join('\r\n')}\r\n`, 'text/csv;charset=utf-8');
}

function iniciarComparacion() {
  $('btnComparar').addEventListener('click', cargarComparacion);
  $('btnCmpCsv').addEventListener('click', exportarComparacionCsv);
  $('cmpBuscar').addEventListener('input', e => { cmp.q = e.target.value; pintarComparacion(); });
  $('cmpTipo').addEventListener('change', e => { cmp.tipo = e.target.value; pintarComparacion(); });
  montar($('cmpEstados'), CMP_ESTADOS.map(([id, txt]) => h('button', { type: 'button', class: 'fbtn', 'data-estado': id, onclick: () => { cmp.estado = id; pintarComparacion(); } }, txt)));
}
