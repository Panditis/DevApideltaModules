'use strict';
// ── Cotizador mayorista · pestaña "Comparación de códigos" (GET /comparacion-codigos) ──
// Diagnóstico: PLU de pack y bulto cargados en la tabla (catálogo) contra el vínculo del sistema.

const ccod = { detalle: [], estado: 'todos', q: '' };
const CCOD_ESTADOS = [['todos', 'Todos'], ['igual', 'Iguales'], ['distinto', 'Distintos'], ['solo catálogo', 'Solo catálogo'], ['solo sistema', 'Solo sistema'], ['sin dato', 'Sin dato']];
const CCOD_TONO = { igual: 'ok', distinto: 'crit', 'solo catálogo': 'warn', 'solo sistema': 'warn', 'sin dato': 'gris', 'no aplica': 'gris' };
const CCOD_TXT = { igual: 'Igual', distinto: 'Distinto', 'solo catálogo': 'Solo catálogo', 'solo sistema': 'Solo sistema', 'sin dato': 'Sin dato', 'no aplica': 'No aplica' };
const CCOD_ORIGEN = { sigaVinculo: 'SIGA', presentacion: 'Presentación' };
const CCOD_RANGO = { distinto: 0, 'solo sistema': 1, 'solo catálogo': 2 };
const CCOD_GRUPOS = [['Producto', 2, ''], ['PACK', 3, 'pack'], ['BULTO', 3, 'bulto']];
const CCOD_COLS = [['Cod', '90px', ''], ['Producto', 'auto', ''],
  ['PLU catálogo', '190px', 'pack'], ['PLU sistema', '210px', 'pack'], ['Estado', '130px', 'pack'],
  ['PLU catálogo', '190px', 'bulto'], ['PLU sistema', '210px', 'bulto'], ['Estado', '130px', 'bulto']];

const ccodRango = f => Math.min(CCOD_RANGO[f.pack.estado] ?? 3, CCOD_RANGO[f.bulto.estado] ?? 3);
// Con diferencias primero; Array.sort es estable, el resto queda en el orden del catálogo.
const ccodOrdenar = filas => [...filas].sort((a, b) => ccodRango(a) - ccodRango(b));

const ccodPasa = f => {
  if (ccod.estado !== 'todos' && f.pack.estado !== ccod.estado && f.bulto.estado !== ccod.estado) return false;
  const t = norm(ccod.q.trim());
  return !t || norm(`${f.cod} ${f.nombre}`).includes(t);
};
const ccodVisibles = () => ccodOrdenar(ccod.detalle.filter(ccodPasa));

const ccodPlu = (p, dif, origen) => h('td', { class: dif ? 'cel-dif' : '' },
  p ? [h('div', { class: 'cod-fijo' }, p.plu ?? '—'), h('div', { class: 'nota text-gris plu-nombre' }, p.nombre || ''),
    origen && p.origen ? chip(CCOD_ORIGEN[p.origen] || p.origen, 'gris') : null] : '—');

const ccodEstado = lado => h('td', null, chip(CCOD_TXT[lado.estado] || lado.estado, CCOD_TONO[lado.estado]),
  lado.sinCantidad ? h('span', { class: 'nota text-gris' }, 'sin cantidad') : null);

function ccodFila(f) {
  const celdas = lado => {
    const dif = lado.estado === 'distinto';
    return [ccodPlu(lado.catalogo, dif, false), ccodPlu(lado.sistema, dif, true), ccodEstado(lado)];
  };
  return h('tr', null, h('td', null, h('span', { class: 'cod-fijo' }, f.cod)),
    h('td', null, h('div', null, f.nombre), f.seccion ? h('span', { class: 'nota text-gris' }, f.seccion) : null),
    celdas(f.pack), celdas(f.bulto));
}

const ccodCuerpo = h('tbody');
const ccodVacio = h('div', { class: 'empty hidden' }, 'Ninguna fila coincide con los filtros.');
const ccodTabla = h('div', { class: 'tabla-scroll tabla-scroll--alta' },
  h('table', { class: 'tabla-fija tabla-edit tabla-codigos' },
    h('colgroup', null, CCOD_COLS.map(([, w]) => h('col', { style: `width:${w}` }))),
    h('thead', null,
      h('tr', null, CCOD_GRUPOS.map(([t, n, g]) => h('th', { colspan: String(n), class: g ? `gh-${g}` : '', scope: n > 1 ? 'colgroup' : 'col' }, t))),
      h('tr', null, CCOD_COLS.map(([t, , g]) => h('th', { scope: 'col', class: g ? `g-${g}` : '', 'aria-label': g ? `${t} ${g}` : null }, t)))),
    ccodCuerpo), ccodVacio);

function pintarCodigos() {
  const vis = ccodVisibles();
  montar(ccodCuerpo, vis.map(ccodFila));
  ccodVacio.classList.toggle('hidden', vis.length > 0);
  $('ccodCuenta').textContent = `${fmtNum(vis.length)} de ${fmtNum(ccod.detalle.length)} filas`;
  $('btnCcodCsv').disabled = vis.length === 0;
  document.querySelectorAll('#ccodEstados .fbtn').forEach(b => {
    b.classList.toggle('on', b.dataset.estado === ccod.estado);
    b.setAttribute('aria-pressed', String(b.dataset.estado === ccod.estado));
  });
}

const resumenCodigos = r => h('div', { class: 'stat-cards' },
  statCard('ok', 'verde', 'Iguales', r.iguales, 'El PLU del catálogo es el del sistema'),
  statCard('rev', 'crit', 'Distintos', r.distintos, 'Ambos tienen PLU y no coinciden'),
  statCard('resp', 'warn', 'Solo catálogo', r.soloCatalogo, 'El sistema no tiene vínculo'),
  statCard('resp', 'warn', 'Solo sistema', r.soloSistema, 'La tabla no tiene el PLU cargado'),
  statCard('resp', 'info', 'Sin dato', r.sinDato, 'Falta el PLU en ambos lados'));

async function cargarCodigos() {
  const cont = $('ccodCont');
  estadoCarga(cont, 'Comparando códigos…');
  $('ccodResumen').replaceChildren();
  ccod.detalle = [];
  try {
    const r = await api('/comparacion-codigos');
    ccod.detalle = Array.isArray(r.detalle) ? r.detalle : [];
    montar($('ccodResumen'), resumenCodigos(r));
    if (!ccod.detalle.length) return estadoVacio(cont, 'No hay productos para comparar.');
    montar(cont, ccodTabla);
    return pintarCodigos();
  } catch (err) {
    return estadoError(cont, err);
  }
}

const ccodPluCsv = p => (p ? [p.plu, p.nombre] : ['', '']);
function exportarCodigosCsv() {
  const lado = l => [...ccodPluCsv(l.catalogo), ...ccodPluCsv(l.sistema), l.sistema ? l.sistema.origen : '', l.estado];
  const cab = t => ['plu_catalogo', 'nombre_catalogo', 'plu_sistema', 'nombre_sistema', 'origen', 'estado'].map(c => `${t}_${c}`);
  const lineas = [['cod', 'nombre', 'seccion', ...cab('pack'), ...cab('bulto')],
    ...ccodVisibles().map(f => [f.cod, f.nombre, f.seccion, ...lado(f.pack), ...lado(f.bulto)])];
  descargarBlob('comparacion_codigos.csv', `﻿${lineas.map(l => l.map(csvCelda).join(';')).join('\r\n')}\r\n`, 'text/csv;charset=utf-8');
}

function iniciarCodigos() {
  $('btnCodigos').addEventListener('click', cargarCodigos);
  $('btnCcodCsv').addEventListener('click', exportarCodigosCsv);
  $('ccodBuscar').addEventListener('input', e => { ccod.q = e.target.value; pintarCodigos(); });
  montar($('ccodEstados'), CCOD_ESTADOS.map(([id, txt]) => h('button', { type: 'button', class: 'fbtn', 'data-estado': id, onclick: () => { ccod.estado = id; pintarCodigos(); } }, txt)));
}
