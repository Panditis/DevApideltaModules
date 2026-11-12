'use strict';
// ── Cotizador mayorista · bloque "Cambios respecto de la última versión" (informativo, sin confirmación ni umbral) ──
// crearDiff() → { el, set(diff) }; diff = { nuevos, quitados, cambiados } del backend (preview).

const DIFF_TIPOS = [
  { id: 'todos', txt: 'Todos' }, { id: 'nuevo', txt: 'Nuevos' }, { id: 'quitado', txt: 'Quitados' },
  { id: 'cambio', txt: 'Cambiados' }, { id: 'precio', txt: 'Solo precios' },
];
const DIFF_TIPO_CHIP = { nuevo: ['Nuevo', 'ok'], quitado: ['Quitado', 'crit'], cambio: ['Cambio', 'warn'] };

// Nuevo: una sola fila, "Después" resume los precios presentes (Pack / Bulto).
function diffPreciosNuevo(f) {
  return [['Pack', f.pack_price], ['Bulto', f.bulto_price]]
    .filter(([, v]) => v !== '' && v != null)
    .map(([t, v]) => `${t} ${fmtPrecio(v)}`).join(' · ');
}

function diffFilas(diff) {
  const d = diff || {};
  return [
    ...(d.nuevos || []).map(f => ({ tipo: 'nuevo', cod: f.cod, nombre: f.nombre, campo: '', antes: '', despues: diffPreciosNuevo(f), pct: null })),
    ...(d.quitados || []).map(f => ({ tipo: 'quitado', cod: f.cod, nombre: f.nombre, campo: '', antes: '', despues: '', pct: null })),
    ...(d.cambiados || []).map(f => ({ tipo: 'cambio', cod: f.cod, nombre: f.nombre, campo: f.campo, antes: f.antes, despues: f.despues, pct: f.pct })),
  ];
}
const diffValor = (f, v) => (esPrecio(f.campo) ? fmtPrecio(v) : (v === '' || v == null ? '—' : String(v)));
// Suba = rojo, baja = verde (el precio sube para el cliente), sin variación calculable = neutro.
const diffClasePct = pct => (pct == null || pct === 0 ? 'text-gris' : pct > 0 ? 'text-crit font-semibold' : 'text-ok font-semibold');

function diffColumnas() {
  return [
    { key: 'tipo', titulo: 'Tipo', ancho: '96px', valor: f => f.tipo, celda: f => chip(...DIFF_TIPO_CHIP[f.tipo]) },
    { key: 'cod', titulo: 'Cod', ancho: '90px', valor: f => f.cod },
    { key: 'nombre', titulo: 'Nombre', ancho: 'auto', valor: f => f.nombre },
    { key: 'campo', titulo: 'Campo', ancho: '130px', valor: f => (CAMPOS[f.campo] || f.campo), celda: f => CAMPOS[f.campo] || f.campo || '—' },
    { key: 'antes', titulo: 'Antes', ancho: '100px', num: true, valor: f => (esPrecio(f.campo) ? Number(f.antes) : f.antes), celda: f => (f.campo ? diffValor(f, f.antes) : '—') },
    { key: 'despues', titulo: 'Después', ancho: '190px', num: true, valor: f => (esPrecio(f.campo) ? Number(f.despues) : f.despues), celda: f => (f.campo ? diffValor(f, f.despues) : (f.despues || '—')) },
    { key: 'pct', titulo: '%', ancho: '80px', num: true, valor: f => f.pct, celda: f => h('span', { class: diffClasePct(f.pct) }, fmtPct(f.pct)) },
  ];
}

function crearDiff() {
  let todas = [], tipo = 'todos';
  const q = h('input', { type: 'search', id: 'diffBuscar', class: 'campo w-64', placeholder: 'Buscar cod o nombre', 'aria-label': 'Buscar en los cambios' });
  const botones = DIFF_TIPOS.map(t => h('button', { type: 'button', class: 'fbtn', 'aria-pressed': 'false', onclick: () => { tipo = t.id; filtrar(); } }, t.txt, ' ', h('span', { class: 'fbtn-n' })));
  const tabla = crearTabla({ cols: diffColumnas(), vacio: 'No hay cambios con este filtro' });
  tabla.el.classList.add('max-h-[360px]');
  const cuenta = h('p', { class: 'text-sm text-gris', 'aria-live': 'polite' });
  const vacioTotal = h('div', { class: 'empty hidden' }, 'Sin cambios respecto de la última versión.');
  const el = h('div', { class: 'space-y-2' }, h('div', { class: 'flex flex-wrap items-center gap-2' }, botones, h('span', { class: 'ml-auto' }, q)), cuenta, tabla.el, vacioTotal);

  const pasa = f => {
    if (tipo === 'precio' ? !(f.tipo === 'cambio' && esPrecio(f.campo)) : tipo !== 'todos' && f.tipo !== tipo) return false;
    const t = norm(q.value.trim());
    return !t || norm(`${f.cod} ${f.nombre}`).includes(t);
  };
  function filtrar() {
    DIFF_TIPOS.forEach((t, i) => {
      botones[i].classList.toggle('on', t.id === tipo);
      botones[i].setAttribute('aria-pressed', String(t.id === tipo));
      const n = t.id === 'todos' ? todas.length : todas.filter(f => (t.id === 'precio' ? f.tipo === 'cambio' && esPrecio(f.campo) : f.tipo === t.id)).length;
      botones[i].querySelector('.fbtn-n').textContent = fmtNum(n);
    });
    const vis = todas.filter(pasa);
    tabla.set(vis);
    cuenta.textContent = `${fmtNum(vis.length)} de ${fmtNum(todas.length)} cambios`;
    const sinNada = todas.length === 0;
    vacioTotal.classList.toggle('hidden', !sinNada);
    [tabla.el, cuenta, ...botones, q].forEach(n => n.classList.toggle('hidden', sinNada && n !== vacioTotal));
  }
  q.addEventListener('input', filtrar);
  return { el, set(diff) { todas = diffFilas(diff); tipo = 'todos'; q.value = ''; filtrar(); } };
}
