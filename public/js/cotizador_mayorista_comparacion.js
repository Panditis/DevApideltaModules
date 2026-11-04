'use strict';
// ── Cotizador mayorista · pestaña "Comparación con la planilla actual" (GET /comparacion) ──
// Diagnóstico: precio de la planilla (Excel) contra el del sistema (decisión o, si no hay, sugerido).

const cmp = { detalle: [], estado: 'todos', tipo: '', q: '' };
const CMP_ESTADOS = [['todos', 'Todos'], ['igual', 'Iguales'], ['difiere', 'Difieren'], ['sin dato', 'Sin dato']];
const CMP_TONO = { igual: 'ok', difiere: 'warn', 'sin dato': 'gris' };
const cmpTipoTxt = t => (t === 'pack' ? 'Pack' : 'Bulto');

const cmpTabla = crearTabla({
  vacio: 'Ninguna fila coincide con los filtros.',
  cols: [
    { key: 'cod', titulo: 'Cod', ancho: '90px', valor: f => f.cod },
    { key: 'nombre', titulo: 'Nombre', ancho: 'auto', valor: f => f.nombre },
    { key: 'tipo', titulo: 'Tipo', ancho: '76px', valor: f => f.tipo, celda: f => cmpTipoTxt(f.tipo) },
    { key: 'excel', titulo: 'Excel', ancho: '96px', num: true, valor: f => f.excel, celda: f => fmtPrecio(f.excel) },
    { key: 'sistema', titulo: 'Sistema', ancho: '96px', num: true, valor: f => f.sistema, celda: f => fmtPrecio(f.sistema) },
    { key: 'origen', titulo: 'Origen', ancho: '170px', valor: f => f.origen || '', celda: f => f.origen || '—' },
    { key: 'pct', titulo: '%', ancho: '80px', num: true, valor: f => f.pct, celda: f => h('span', { class: diffClasePct(f.pct) }, fmtPct(f.pct)) },
    { key: 'estado', titulo: 'Estado', ancho: '92px', valor: f => f.estado, celda: f => chip(f.estado === 'igual' ? 'Igual' : f.estado === 'difiere' ? 'Difiere' : 'Sin dato', CMP_TONO[f.estado]) },
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
    statCard('ok', 'verde', 'Iguales', r.iguales, 'Planilla y sistema coinciden'),
    statCard('rev', 'warn', 'Difieren', r.difieren, 'Hay que mirar cuál está bien'),
    statCard('resp', 'info', 'Sin dato', r.sinDato, 'Falta el precio de un lado'),
    statCard('prod', 'verde', 'Con decisión', r.conDecision, 'El sistema usa una decisión vigente'));
}

async function cargarComparacion() {
  const cont = $('cmpCont');
  estadoCarga(cont, 'Comparando con la planilla…');
  $('cmpResumen').replaceChildren();
  try {
    const r = await api('/comparacion');
    cmp.detalle = Array.isArray(r.detalle) ? r.detalle : [];
    montar($('cmpResumen'), resumenComparacion(r));
    if (!cmp.detalle.length) return estadoVacio(cont, 'No hay datos de la planilla para comparar. Importá el Excel en "Productos y secciones".');
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
  const lineas = [['cod', 'nombre', 'tipo', 'excel', 'sistema', 'origen', 'pct', 'estado'], ...filas.map(f => [f.cod, f.nombre, f.tipo, f.excel, f.sistema, f.origen, f.pct, f.estado])];
  descargarBlob('comparacion_planilla.csv', `﻿${lineas.map(l => l.map(csvCelda).join(';')).join('\r\n')}\r\n`, 'text/csv;charset=utf-8');
}

function iniciarComparacion() {
  $('btnComparar').addEventListener('click', cargarComparacion);
  $('btnCmpCsv').addEventListener('click', exportarComparacionCsv);
  $('cmpBuscar').addEventListener('input', e => { cmp.q = e.target.value; pintarComparacion(); });
  $('cmpTipo').addEventListener('change', e => { cmp.tipo = e.target.value; pintarComparacion(); });
  montar($('cmpEstados'), CMP_ESTADOS.map(([id, txt]) => h('button', { type: 'button', class: 'fbtn', 'data-estado': id, onclick: () => { cmp.estado = id; pintarComparacion(); } }, txt)));
}
