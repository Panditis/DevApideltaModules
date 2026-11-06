'use strict';
// ── Cotizador mayorista · helpers compartidos del front ──
// Script clásico cargado primero: sus const/function top-level son globales para los demás cotizador_mayorista_*.js.
// Todo texto de usuario o servidor entra al DOM con textContent (h() nunca usa innerHTML).

const API = '/api/cotizador-mayorista';
const $ = id => document.getElementById(id);

// h('div', { class: 'x', onclick: fn, disabled: true }, 'texto', nodo, [más])
function h(tag, props, ...hijos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  const poner = x => {
    if (x == null || x === false) return;
    if (Array.isArray(x)) x.forEach(poner);
    else el.appendChild(x instanceof Node ? x : document.createTextNode(String(x)));
  };
  hijos.forEach(poner);
  return el;
}
const vaciar = el => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
const montar = (el, ...hijos) => { vaciar(el).append(...hijos.flat().filter(Boolean)); return el; };

// ── Formato es-AR ──
const NF0 = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
const NF1 = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtNum = n => (n == null || n === '' || !Number.isFinite(Number(n)) ? '—' : NF0.format(Number(n)));
const fmtPrecio = n => (n == null || n === '' || !Number.isFinite(Number(n)) ? '—' : `$${NF0.format(Number(n))}`);
const fmtPct = n => (n == null ? '—' : `${n > 0 ? '+' : ''}${NF1.format(n)}%`);
function fmtFecha(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso ?? '—')
    : d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const CAMPOS = { pack_price: 'Precio pack', bulto_price: 'Precio bulto', pack_qty: 'Cantidad pack', bulto_qty: 'Cantidad bulto', nombre: 'Nombre', seccion: 'Sección' };
const esPrecio = campo => String(campo).endsWith('_price');

// ── API: los errores del backend vienen como { error } (200 en validación, 403 sin permiso, 500 interno) ──
async function api(ruta, opciones) {
  let res;
  try { res = await fetch(API + ruta, opciones); } catch { throw new Error('No se pudo conectar con el servidor'); }
  const json = await res.json().catch(() => null);
  if (json && json.error) throw new Error(json.error);
  if (!res.ok || json == null) throw new Error(`Respuesta inesperada del servidor (${res.status})`);
  return json;
}
const apiJson = (ruta, metodo, cuerpo) => api(ruta, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });

// ── Permiso de edición/exportación (precios-config) ──
const TIP_SIN_PERMISO = 'Necesitás el permiso de configuración de Precios para hacer esto';
const permisoEditar = fetch('/api/precios/config/publica').then(r => r.json()).then(j => !!(j && j.puedeConfig === true)).catch(() => false);

// ── Estados de carga / vacío / error ──
const estadoCarga = (el, txt = 'Cargando…') => montar(el, h('div', { class: 'loading', role: 'status' }, txt));
const estadoVacio = (el, txt) => montar(el, h('div', { class: 'empty' }, txt));
const estadoError = (el, err) => montar(el, h('div', { class: 'error', role: 'alert' }, err instanceof Error ? err.message : String(err)));

const chip = (txt, tono = '') => h('span', { class: `chip ${tono ? `chip--${tono}` : 'chip--gris'}` }, txt);

function toast(msg, tono = 'ok') {
  const t = h('div', { class: `toast toast--${tono}`, role: tono === 'crit' ? 'alert' : 'status' }, h('span', { class: 'toast-ico', 'aria-hidden': 'true' }, tono === 'crit' ? '✖' : '✔'), msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4500);
}

// Copia al portapapeles; si el navegador no deja (http sin contexto seguro) cae a un textarea temporal.
async function copiarTexto(txt) {
  try { await navigator.clipboard.writeText(txt); return true; } catch { /* sigue al plan B */ }
  const ta = h('textarea', { style: 'position:fixed;opacity:0' });
  ta.value = txt;
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  return ok;
}

// ── Tabla con encabezado sticky, columnas de ancho fijo y orden por clic ──
// cols: [{ key, titulo, ancho, num, valor(f), celda(f) }]; devuelve { el, set(filas), filas() }.
function crearTabla({ cols, vacio = 'Sin resultados', claseFila, onVacio }) {
  let datos = [], orden = null;
  const cuerpo = h('tbody');
  const ths = cols.map(c => h('th', { class: c.num ? 'num' : '', scope: 'col', 'aria-sort': 'none' },
    c.valor ? h('button', { type: 'button', class: 'th-orden', onclick: () => ordenarPor(c) }, c.titulo, h('span', { class: 'flecha', 'aria-hidden': 'true' })) : c.titulo));
  const tabla = h('table', { class: 'tabla-fija' }, h('colgroup', null, cols.map(c => h('col', { style: `width:${c.ancho}` }))),
    h('thead', null, h('tr', null, ths)), cuerpo);
  const aviso = h('div', { class: 'empty hidden' }, vacio);
  const el = h('div', { class: 'tabla-scroll' }, tabla, aviso);

  function ordenarPor(c) {
    orden = orden && orden.key === c.key ? { key: c.key, dir: -orden.dir } : { key: c.key, dir: 1 };
    pintar();
  }
  function pintar() {
    const filas = orden ? ordenadas() : datos;
    cols.forEach((c, i) => ths[i].setAttribute('aria-sort', orden && orden.key === c.key ? (orden.dir > 0 ? 'ascending' : 'descending') : 'none'));
    montar(cuerpo, filas.map(f => h('tr', { class: claseFila ? claseFila(f) : '' }, cols.map(c =>
      h('td', { class: c.num ? 'num' : '' }, c.celda ? c.celda(f) : (c.valor ? c.valor(f) : ''))))));
    aviso.classList.toggle('hidden', filas.length > 0);
    if (onVacio) onVacio(filas.length);
  }
  function ordenadas() {
    const col = cols.find(c => c.key === orden.key);
    const cmp = (a, b) => {
      const x = col.valor(a), y = col.valor(b);
      if (x == null || x === '') return (y == null || y === '') ? 0 : 1; // vacíos siempre al final
      if (y == null || y === '') return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'es', { numeric: true })) * orden.dir;
    };
    return [...datos].sort(cmp);
  }
  return { el, set(filas) { datos = filas; pintar(); }, filas: () => datos };
}

// Descarga de un blob generado en el cliente (CSV de la comparación).
function descargarBlob(nombre, contenido, tipo) {
  const url = URL.createObjectURL(new Blob([contenido], { type: tipo }));
  const a = h('a', { href: url, download: nombre });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
