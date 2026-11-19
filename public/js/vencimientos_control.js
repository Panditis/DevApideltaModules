// Centro de control de vencimientos: dashboard de solo lectura con 6 tablas + modal de artículos por sucursal
// (clic en una fila de "Próximos vencimientos"; usa proximos.lotes filtrado por idSucursal en cliente).
// Fuente: GET /api/vencimientos/centro-control (ejemplo del contrato en public/js/vencimientos_control_mock.js).
// ?mock=1 usa ese mock local en vez del endpoint. Cada tarjeta se pinta aparte: si una falla, las demás siguen.
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = n => Number(n || 0).toLocaleString('es-AR');
const arr = v => (Array.isArray(v) ? v : []);
const nombreSuc = s => s.nombre || (s.idSucursal != null ? `Sucursal ${s.idSucursal}` : '—');
const fmtFecha = f => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(f || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : '—'; };
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MOCK = new URLSearchParams(location.search).get('mock') === '1';
const TOP_N = 10;
const DIAS_ANTES_DEFECTO = 3;
// Regla de cierre: N de reglaOferta.diasAntes (default 3 si falta o no es válido).
const diasAntesOferta = () => { const n = Number(DATA && DATA.reglaOferta && DATA.reglaOferta.diasAntes); return Number.isInteger(n) && n >= 0 ? n : DIAS_ANTES_DEFECTO; };
const textoCierre = () => { const n = diasAntesOferta(); return n === 0 ? 'el mismo día del vencimiento' : `${n} ${n === 1 ? 'día' : 'días'} antes del vencimiento`; };
const ayudaDias = () => `Días que lleva en oferta sobre el plazo total. La oferta debe cerrarse ${textoCierre()}.`;
const norm = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const SVG = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICO_ALERTA = SVG('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>');
const ICO_OK = SVG('<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>');

const ICO_RELOJ = SVG('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>');
const ICO_VENC = SVG('<path d="M8 2v4M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18M10 14l4 4m0-4-4 4"/>');
const ICO_CHEV =SVG('<path d="m9 18 6-6-6-6"/>');

let DATA = null;
let FILTRO_OFE = 'todos';
let FILTRO_DEV = 'todas';
const DEV_N = 20;
const SORT = {}; // id de tabla -> { k, d } (d: 1 asc, -1 desc)

// ---------- piezas comunes ----------
const msg = (titulo, detalle) => `<div class="msg"><strong>${esc(titulo)}</strong>${detalle ? esc(detalle) : ''}</div>`;
const skeleton = '<div class="skel"></div><div class="skel" style="width:85%"></div><div class="skel" style="width:70%"></div><div class="skel" style="width:80%"></div>';
const celdaProd = r => `${esc(r.producto || '—')}${r.plu ? `<span class="plu">PLU ${esc(r.plu)}</span>` : ''}`;
// Barra proporcional al máximo de la serie + número (tabular, a la derecha).
const celdaBarra = (v, max, tono = '') => `<span class="nb"><span class="bar"><i class="${tono}" style="width:${max > 0 ? Math.round((v / max) * 100) : 0}%"></i></span><span class="n">${nf(v)}</span></span>`;
const pill = (tono, ico, txt) => `<span class="pill pill--${tono}">${ico}${esc(txt)}</span>`;

// Tabla con cabecera sticky y orden por clic. cols: { t, k (clave de orden, opcional), num, val(r), td(r, ctx) }.
function tabla(id, cols, filas, ctx = {}) {
  const st = SORT[id];
  const col = st && cols.find(c => c.k === st.k);
  const ord = col ? [...filas].sort((a, b) => {
    const x = col.val(a), y = col.val(b);
    const c = typeof x === 'string' || typeof y === 'string' ? String(x).localeCompare(String(y), 'es') : x - y;
    return c * st.d;
  }) : filas;
  const th = c => {
    if (!c.k) return `<th scope="col" class="${c.num ? 'num' : ''}"><span>${esc(c.t)}</span></th>`;
    const activo = col && col.k === c.k;
    const aria = activo ? (st.d === 1 ? 'ascending' : 'descending') : 'none';
    const tipId = `tip-${id}-${c.k}`;
    const ayuda = c.ayuda ? ` title="${esc(c.ayuda)}" aria-describedby="${tipId}"` : '';
    const tip = c.ayuda ? `<span class="tip" role="tooltip" id="${tipId}">${esc(c.ayuda)}</span>` : '';
    return `<th scope="col" class="${c.num ? 'num' : ''}${c.ayuda ? ' has-tip' : ''}" aria-sort="${aria}"><button type="button" class="th-btn" data-sort="${id}" data-k="${c.k}" data-num="${c.num ? 1 : 0}"${ayuda}>${esc(c.t)}<span class="ar">${activo && st.d === 1 ? '▲' : '▼'}</span></button>${tip}</th>`;
  };
  return `<table><thead><tr>${cols.map(th).join('')}</tr></thead><tbody>${ord.map(r => `<tr${ctx.row ? ctx.row(r) : ''}>${cols.map(c => `<td class="${c.num ? 'num' : ''} ${c.cls || ''}"${c.attr ? ` ${c.attr}` : ''}>${c.td(r, ctx)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

// Plural en español: termina en vocal → "s" (producto → productos); en consonante → "es" (sucursal → sucursales, mes → meses).
const plural = (palabra, n) => (n === 1 ? palabra : palabra + (/[aeiouáéíóú]$/i.test(palabra) ? 's' : 'es'));
const setCount = (id, n, unidad) => { $(id).textContent = n == null ? '' : `${nf(n)} ${plural(unidad, n)}`; };

// ---------- tarjetas ----------
const CARDS = {
  prox: {
    body: 'bProx',
    render(d) {
      const filas = arr((d.proximos || {}).porSucursal);
      setCount('cProx', filas.length, 'sucursal');
      if (!filas.length) return msg('Sin lotes por vencer', 'No hay lotes con pendiente en los próximos 30 días.');
      const g = (r, v, f) => Number((r[v] || {})[f]) || 0;
      // El back manda acumulados (v7 <= v15 <= v30); acá se convierten a rangos excluyentes sin cambiar el contrato.
      const RANGOS = [['7', 'v7', null, '0–7 d', 'crit'], ['15', 'v15', 'v7', '8–15 d', 'warn'], ['30', 'v30', 'v15', '16–30 d', '']];
      const enRango = (r, [, v, ant], f) => Math.max(0, g(r, v, f) - (ant ? g(r, ant, f) : 0));
      const max = {};
      for (const rg of RANGOS) max[rg[0]] = Math.max(0, ...filas.map(r => enRango(r, rg, 'lotes')));
      // Lotes a más de 30 días por sucursal, desde proximos.lotes (si falta, 0).
      const mas = {};
      for (const l of arr((d.proximos || {}).lotes)) if (num(l.dias) > 30) mas[l.idSucursal] = (mas[l.idSucursal] || 0) + 1;
      const nMas = r => mas[r.idSucursal] || 0;
      const maxMas = Math.max(0, ...filas.map(nMas));
      const btnSuc = r => (r.idSucursal == null ? esc(nombreSuc(r))
        : `<button type="button" class="row-btn" data-suc="${esc(r.idSucursal)}" aria-haspopup="dialog"><span>${esc(nombreSuc(r))}</span><span class="ver">Ver artículos${ICO_CHEV}</span></button>`);
      const cols = [{ t: 'Sucursal', k: 'suc', val: nombreSuc, td: btnSuc }];
      for (const rg of RANGOS) {
        const attr = `data-v="${rg[0]}"`;
        cols.push({ t: `${rg[3]} · lotes`, k: `v${rg[0]}l`, num: 1, attr, val: r => enRango(r, rg, 'lotes'), td: r => celdaBarra(enRango(r, rg, 'lotes'), max[rg[0]], rg[4]) });
      }
      cols.push({ t: '> 30 d · lotes', k: 'masl', num: 1, attr: 'data-v="mas"', val: nMas, td: r => celdaBarra(nMas(r), maxMas) });
      SORT.prox = SORT.prox || { k: 'v7l', d: -1 };
      return tabla('prox', cols, filas, { row: r => (r.idSucursal == null ? '' : ` data-suc="${esc(r.idSucursal)}"`) });
    },
  },

  cum: {
    body: 'bCum',
    render(d) {
      const c = d.cumplimiento || {};
      const filas = Array.isArray(d.cumplimiento) ? d.cumplimiento : arr(c.porSucursal);
      const lim = c.diasLimite || 7;
      $('sCum').textContent = `Alerta si pasan más de ${lim} días sin cargar.`;
      const alerta = r => r.diasSinActividad == null || r.diasSinActividad > lim;
      setCount('cCum', filas.filter(alerta).length, 'alerta');
      if (!filas.length) return msg('Sin datos de actividad', 'Todavía ninguna sucursal registró movimientos.');
      const dias = r => (r.diasSinActividad == null ? Infinity : r.diasSinActividad);
      const cols = [
        { t: 'Sucursal', k: 'suc', val: nombreSuc, td: r => esc(nombreSuc(r)) },
        { t: 'Última actividad', k: 'fec', val: r => r.ultimaActividad || '', td: r => (r.diasSinActividad == null ? 'Nunca' : fmtFecha(r.ultimaActividad)) },
        { t: 'Días', k: 'dias', num: 1, val: dias, td: r => (r.diasSinActividad == null ? '—' : nf(r.diasSinActividad)) },
        { t: 'Estado', td: r => (alerta(r) ? pill('crit', ICO_ALERTA, r.diasSinActividad == null ? 'Sin actividad' : 'Sin carga') : pill('ok', ICO_OK, 'Al día')) },
      ];
      SORT.cum = SORT.cum || { k: 'dias', d: -1 };
      return tabla('cum', cols, filas);
    },
  },

  rank: {
    body: 'bRank',
    render(d) {
      const base = [...arr(d.ranking)].sort((a, b) => (Number(b.unidadesVencidas) || 0) - (Number(a.unidadesVencidas) || 0));
      setCount('cRank', base.length, 'sucursal');
      if (!base.length) return msg('Sin vencidos', 'No se registraron vencidos en los últimos 90 días.');
      const filas = base.map((r, i) => ({ ...r, _pos: i + 1 }));
      const max = Math.max(0, ...filas.map(r => Number(r.unidadesVencidas) || 0));
      const cols = [
        { t: '#', k: 'pos', num: 1, val: r => r._pos, td: r => r._pos, cls: 'rank' },
        { t: 'Sucursal', k: 'suc', val: nombreSuc, td: r => esc(nombreSuc(r)) },
        { t: 'Unidades vencidas', k: 'uni', num: 1, val: r => Number(r.unidadesVencidas) || 0, td: r => celdaBarra(Number(r.unidadesVencidas) || 0, max, 'crit') },
        { t: 'Lotes sin resolver', k: 'lotes', num: 1, val: r => Number(r.lotesSinResolver) || 0, td: r => nf(r.lotesSinResolver) },
      ];
      SORT.rank = SORT.rank || { k: 'pos', d: 1 };
      return tabla('rank', cols, filas);
    },
  },

  top: {
    body: 'bTop',
    render(d) {
      const todos = arr(d.topProductos);
      const q = norm($('qTop').value.trim());
      const porUni = [...todos].sort((a, b) => (Number(b.unidades) || 0) - (Number(a.unidades) || 0));
      const filas = q ? porUni.filter(r => norm(r.producto).includes(q) || norm(r.plu).includes(q)) : porUni.slice(0, TOP_N);
      const max = Math.max(0, ...filas.map(r => Number(r.unidades) || 0));
      $('hintTop').textContent = q ? `${nf(filas.length)} de ${nf(todos.length)} productos coinciden.` : (todos.length > TOP_N ? `Top ${TOP_N} de ${nf(todos.length)}. Buscá para ver el resto.` : '');
      setCount('cTop', filas.length, 'producto');
      if (!todos.length) return msg('Sin vencidos registrados', 'Todavía no hay productos con vencidos.');
      if (!filas.length) return msg('Sin resultados', 'Probá con otra parte del nombre o con el PLU, o borrá la búsqueda para volver al top.');
      const cols = [
        { t: 'Producto', k: 'prod', val: r => r.producto || '', td: celdaProd },
        { t: 'Unidades vencidas', k: 'uni', num: 1, val: r => Number(r.unidades) || 0, td: r => celdaBarra(Number(r.unidades) || 0, max, 'warn') },
      ];
      SORT.top = SORT.top || { k: 'uni', d: -1 };
      return tabla('top', cols, filas);
    },
  },

  ofe: {
    body: 'bOfe',
    render(d) {
      const todos = arr(d.enOferta);
      const q = norm($('qOfe').value.trim());
      const est = FILTRO_OFE;
      const filas = todos.filter(r => (est === 'todos' || r.estado === est) && (!q || norm(r.producto).includes(q) || norm(r.plu).includes(q) || norm(nombreSuc(r)).includes(q)));
      setCount('cOfe', filas.length, 'producto');
      const nVenc = todos.filter(r => r.estado === 'vencida').length;
      if (nVenc) $('cOfe').textContent += ` · ${nf(nVenc)} vencida${nVenc === 1 ? '' : 's'}`;
      $('cOfe').classList.toggle('cnt--crit', nVenc > 0);
      $('hintOfe').textContent = filas.length !== todos.length ? `${nf(filas.length)} de ${nf(todos.length)} productos coinciden.` : '';
      if (!todos.length) return msg('Sin productos en oferta', 'Ninguna sucursal tiene productos en oferta por ahora.');
      if (!filas.length) return msg('Sin resultados', 'Probá con otro estado, otra parte del nombre, el PLU o la sucursal.');
      const maxPend = Math.max(0, ...filas.map(r => Number(r.pendiente) || 0));
      const ESTADO = { vencida: ['vencida', ICO_VENC, 'Vencida', 0], atrasada: ['crit', ICO_ALERTA, 'Atrasada', 1], 'por-vencer-plazo': ['warn', ICO_RELOJ, 'Por vencer plazo', 2], 'en-plazo': ['ok', ICO_OK, 'En plazo', 3] };
      const tono = r => (r.estado === 'vencida' ? 'crit' : (ESTADO[r.estado] || [''])[0] === 'ok' ? '' : (ESTADO[r.estado] || [''])[0]);
      const txtEstado = r => (r.estado === 'vencida' && Number(r.diasVencido) >= 1 ? `Vencida · ${nf(r.diasVencido)} d` : ESTADO[r.estado][2]);
      const dias = r => Number(r.diasEnOferta) || 0;
      const paraLimite = r => (r.diasParaLimite == null || Number.isNaN(Number(r.diasParaLimite)) ? 1e9 : Number(r.diasParaLimite)); // sin límite, al final
      const cols = [
        { t: 'Sucursal', k: 'suc', val: nombreSuc, td: r => esc(nombreSuc(r)) },
        { t: 'Producto', k: 'prod', val: r => r.producto || '', td: celdaProd },
        { t: 'En oferta desde', k: 'fec', val: r => r.fechaOferta || '', td: r => fmtFecha(r.fechaOferta) },
        { t: 'Vence', k: 'venc', val: r => r.vence || '', td: r => fmtFecha(r.vence) },
        { t: 'Cerrar antes del', k: 'lim', val: paraLimite, td: r => {
          const n = r.diasParaLimite == null ? null : Number(r.diasParaLimite);
          if (n == null || Number.isNaN(n)) return fmtFecha(r.limite);
          const [cls, txt] = n < 0 ? ['lim--crit', `pasó hace ${nf(-n)} d`] : n === 0 ? ['lim--warn', 'cierra hoy'] : [n <= 2 ? 'lim--warn' : '', `faltan ${nf(n)} d`];
          return `${fmtFecha(r.limite)}<span class="lim ${cls}">${txt}</span>`;
        } },
        { t: 'Días en oferta / plazo', k: 'dias', num: 1, ayuda: ayudaDias(), val: dias, td: r => {
          const mx = Number(r.diasMaxOferta) || 0;
          const pct = r.estado === 'vencida' ? 100 : mx > 0 ? Math.min(100, Math.round((dias(r) / mx) * 100)) : 0;
          return `<span class="nb"><span class="bar"><i class="${tono(r)}" style="width:${pct}%"></i></span><span class="n">${nf(dias(r))}${mx ? ` / ${nf(mx)}` : ''}</span></span>`;
        } },
        { t: 'Unidades en oferta', k: 'uni', num: 1, val: r => Number(r.unidadesOferta) || 0, td: r => nf(r.unidadesOferta) },
        { t: 'Pendiente', k: 'pend', num: 1, val: r => Number(r.pendiente) || 0, td: r => celdaBarra(Number(r.pendiente) || 0, maxPend, tono(r)) },
        { t: 'Estado', k: 'est', val: r => (ESTADO[r.estado] || [0, 0, 0, 9])[3], td: r => { const e = ESTADO[r.estado]; return e ? pill(e[0], e[1], txtEstado(r)) : '—'; } },
      ];
      return tabla('ofe', cols, filas, { row: r => (r.estado === 'vencida' ? ' class="row-venc"' : '') });
    },
  },

  // Devuelto a Central: sucursales sin oferta (devueltos). Sin `devueltos` o sin sucursales, la tarjeta se oculta.
  dev: {
    body: 'bDev',
    render(d) {
      const dv = d.devueltos;
      const suc = arr(dv && dv.porSucursal);
      $('secDev').hidden = !dv || !suc.length;
      if ($('secDev').hidden) return '';
      if (FILTRO_DEV !== 'todas' && !suc.some(s => String(s.idSucursal) === FILTRO_DEV)) FILTRO_DEV = 'todas';
      $('cDev').textContent = `${nf(dv.total)} ${num(dv.total) === 1 ? 'unidad devuelta' : 'unidades devueltas'}`;
      $('chipsDev').innerHTML = `<button type="button" class="chip" data-suc-dev="todas" aria-pressed="${FILTRO_DEV === 'todas'}">Todas</button>`
        + suc.map(s => `<button type="button" class="chip" data-suc-dev="${esc(s.idSucursal)}" aria-pressed="${FILTRO_DEV === String(s.idSucursal)}">${esc(nombreSuc(s))} · ${nf(s.unidades)} u · ${nf(s.movimientos)} mov.${s.ultimaFecha ? ` · últ. ${fmtFecha(s.ultimaFecha)}` : ''}</button>`).join('');
      const todos = arr(dv.recientes);
      const q = norm($('qDev').value.trim());
      const base = todos.filter(r => (FILTRO_DEV === 'todas' || String(r.idSucursal) === FILTRO_DEV) && (!q || norm(r.producto).includes(q) || norm(r.plu).includes(q) || norm(r.usuario).includes(q)));
      const filas = base.slice(0, DEV_N);
      $('hintDev').textContent = base.length > DEV_N ? `Últimas ${DEV_N} de ${nf(base.length)} devoluciones. Filtrá por sucursal o buscá para ver otras.` : '';
      if (!todos.length) return msg('Sin devoluciones a Central registradas.');
      if (!base.length) return msg('Sin resultados', 'Probá con otra sucursal, otra parte del nombre, el PLU o el usuario.');
      const cols = [
        { t: 'Fecha', k: 'fec', val: r => r.fecha || '', td: r => fmtFecha(r.fecha) },
        { t: 'Sucursal', k: 'suc', val: nombreSuc, td: r => esc(nombreSuc(r)) },
        { t: 'Producto', k: 'prod', val: r => r.producto || '', td: celdaProd },
        { t: 'Vence', k: 'venc', val: r => r.vencimiento || '', td: r => fmtFecha(r.vencimiento) },
        { t: 'Cantidad devuelta', k: 'can', num: 1, val: r => num(r.cantidad), td: r => `<strong>${nf(r.cantidad)}</strong>` },
        { t: 'Usuario', k: 'usu', val: r => r.usuario || '', td: r => esc(r.usuario || '—') },
        { t: 'Pendiente restante', k: 'pen', num: 1, val: r => num(r.pendiente), td: r => nf(r.pendiente) },
      ];
      SORT.dev = SORT.dev || { k: 'fec', d: -1 };
      return tabla('dev', cols, filas);
    },
  },

  ten: {
    body: 'bTen',
    render(d) {
      const serie = arr(d.tendencia);
      setCount('cTen', serie.length, 'mes');
      if (!serie.length) return msg('Sin vencidos', 'No hubo vencidos en los últimos 6 meses.');
      const max = Math.max(0, ...serie.map(s => Number(s.unidades) || 0));
      const cols = [
        { t: 'Mes', td: s => { const m = /^(\d{4})-(\d{2})/.exec(s.mes || ''); return m ? `${MESES[Number(m[2]) - 1] || m[2]} ${m[1]}` : esc(s.mes || '—'); } },
        { t: 'Unidades', num: 1, td: s => celdaBarra(Number(s.unidades) || 0, max, 'crit') },
      ];
      return tabla('ten', cols, serie);
    },
  },
};

function pintarCard(id) {
  const c = CARDS[id], el = $(c.body);
  try { el.innerHTML = c.render(DATA); } catch (_) {
    el.innerHTML = '<div class="err" role="alert">No se pudo mostrar esta tabla. <button type="button" class="btn" data-reintentar>Reintentar</button></div>';
  }
}

// ---------- carga ----------
let generadoMs = null;
function textoRelativo() {
  if (generadoMs == null) return '';
  const s = Math.max(0, Math.round((Date.now() - generadoMs) / 1000));
  if (s < 60) return 'Actualizado hace unos segundos';
  const m = Math.round(s / 60);
  if (m < 60) return `Actualizado hace ${m} min`;
  const h = Math.round(m / 60);
  return `Actualizado hace ${h} h`;
}
const pintarGenerado = () => {
  const t = generadoMs == null ? '' : new Date(generadoMs).toLocaleString('es-AR');
  $('generado').textContent = textoRelativo();
  $('generado').title = t ? `Datos generados el ${t}` : '';
};

function pintar(d) {
  DATA = d || {};
  const ms = Date.parse(DATA.generado);
  generadoMs = Number.isNaN(ms) ? Date.now() : ms;
  pintarGenerado();
  $('subOfe').textContent = `Tiempo en oferta frente al plazo (se cierra ${textoCierre()}) y unidades pendientes.`;
  Object.keys(CARDS).forEach(pintarCard);
  if (MODAL.id != null) pintarModal(); // modal abierto: refresca con datos nuevos (sucursal, ventana, búsqueda y orden se conservan)
}

function cargando() {
  for (const c of Object.values(CARDS)) $(c.body).innerHTML = skeleton;
  Object.keys(CARDS).forEach(id => { $(CARDS[id].body).setAttribute('aria-busy', 'true'); });
}

function errorGlobal(e) {
  for (const c of Object.values(CARDS)) {
    $(c.body).innerHTML = `<div class="err" role="alert">${esc(e.message)} <button type="button" class="btn" data-reintentar>Reintentar</button></div>`;
  }
  document.querySelectorAll('.cnt').forEach(el => { el.textContent = ''; });
}

async function pedir() {
  if (MOCK) {
    await new Promise((ok, no) => { const s = document.createElement('script'); s.src = '/js/vencimientos_control_mock.js'; s.onload = ok; s.onerror = () => no(new Error('Mock no encontrado')); document.head.appendChild(s); });
    return window.VENCIMIENTOS_CONTROL_MOCK;
  }
  const r = await fetch('/api/vencimientos/centro-control');
  let cuerpo = null;
  try { cuerpo = await r.json(); } catch (_) { /* sin JSON */ }
  if (r.status === 403) throw new Error('No tenés permiso para ver el centro de control.');
  if (!r.ok) throw new Error((cuerpo && cuerpo.error) || `Error ${r.status}`);
  return cuerpo;
}

async function cargar() {
  const btn = $('btnActualizar');
  btn.disabled = true; cargando();
  try { pintar(await pedir()); } catch (e) { errorGlobal(e); } finally {
    btn.disabled = false;
    document.querySelectorAll('[aria-busy]').forEach(el => el.removeAttribute('aria-busy'));
  }
}

// ---------- modal: artículos cargados por sucursal ----------
const MODAL = { id: null, nombre: '', win: 'todos', q: '' };
// Rangos excluyentes sobre l.dias: (desde, hasta]. Misma partición que las columnas de la tabla.
const VENTANAS = { todos: [-Infinity, Infinity], 7: [-Infinity, 7], 15: [7, 15], 30: [15, 30], mas: [30, Infinity] };
const ETIQ_WIN = { 7: '0–7 días', 15: '8–15 días', 30: '16–30 días', mas: 'más de 30 días' };
const pilDias = d => (d <= 7 ? pill('crit', ICO_ALERTA, `${nf(d)} d`) : d <= 15 ? pill('warn', ICO_RELOJ, `${nf(d)} d`) : pill('ok', ICO_OK, `${nf(d)} d`));
const num = v => Number(v) || 0;

function pintarModal() {
  const todos = arr((DATA.proximos || {}).lotes).filter(l => String(l.idSucursal) === MODAL.id);
  const [desde, hasta] = VENTANAS[MODAL.win] || VENTANAS.todos;
  const ventana = todos.filter(l => num(l.dias) > desde && num(l.dias) <= hasta);
  const q = norm(MODAL.q.trim());
  const filas = q ? ventana.filter(l => norm(l.producto).includes(q) || norm(l.plu).includes(q)) : ventana;
  const pend = ventana.reduce((a, l) => a + num(l.pendiente), 0);
  $('mTitulo').textContent = `Artículos cargados · ${MODAL.nombre}`;
  $('mSub').textContent = `${nf(ventana.length)} artículo${ventana.length === 1 ? '' : 's'} · ${nf(pend)} unidad${pend === 1 ? '' : 'es'} pendiente${pend === 1 ? '' : 's'}${ETIQ_WIN[MODAL.win] ? ` · vencen en ${ETIQ_WIN[MODAL.win]}` : ''}`;
  $('mCnt').textContent = `${nf(filas.length)} de ${nf(ventana.length)}`;
  document.querySelectorAll('#chipsMod .chip').forEach(c => c.setAttribute('aria-pressed', String(c.dataset.win === String(MODAL.win))));
  let html;
  if (!todos.length) html = msg('Sin artículos cargados', 'Esta sucursal no tiene lotes con unidades pendientes.');
  else if (!ventana.length) html = msg('Sin vencimientos en este rango', 'Probá con otro rango o elegí Todos.');
  else if (!filas.length) html = msg('Sin resultados', 'Probá con otra parte del nombre o con el PLU.');
  else {
    html = tabla('mod', [
      { t: 'Producto', k: 'prod', val: l => l.producto || '', td: celdaProd },
      { t: 'Vence', k: 'fec', val: l => l.fecha || '', td: l => fmtFecha(l.fecha) },
      { t: 'Días', k: 'dias', num: 1, val: l => num(l.dias), td: l => pilDias(num(l.dias)) },
      { t: 'Cargadas', k: 'car', num: 1, val: l => num(l.unidadesCargadas), td: l => nf(l.unidadesCargadas) },
      { t: 'Pendiente', k: 'pen', num: 1, val: l => num(l.pendiente), td: l => `<strong>${nf(l.pendiente)}</strong>` },
    ], filas);
  }
  $('bMod').innerHTML = html;
}

function abrirModal(id, nombre, win) {
  Object.assign(MODAL, { id: String(id), nombre, win, q: '' });
  SORT.mod = { k: 'fec', d: 1 };
  $('qMod').value = '';
  pintarModal();
  $('modal').hidden = false;
  document.body.style.overflow = 'hidden';
  $('qMod').focus();
}

function cerrarModal() {
  const op = document.querySelector(`.row-btn[data-suc="${CSS.escape(MODAL.id)}"]`);
  $('modal').hidden = true;
  document.body.style.overflow = '';
  MODAL.id = null;
  // El re-render puede haber reemplazado el botón: se busca de nuevo y, si no está, título de la tarjeta o Actualizar.
  if (op && op.isConnected) op.focus();
  else {
    const h = $('hProx');
    h.tabIndex = -1;
    h.focus();
    if (document.activeElement !== h) $('btnActualizar').focus();
  }
}

function abrirDesdeFila(tr, td) {
  const id = tr.dataset.suc;
  const r = arr((DATA.proximos || {}).porSucursal).find(x => String(x.idSucursal) === id) || {};
  abrirModal(id, nombreSuc(r), td ? td.dataset.v : 'todos');
}

// ---------- eventos ----------
document.addEventListener('click', ev => {
  if (ev.target.closest('[data-reintentar]')) { cargar(); return; }
  if (ev.target === $('modal') || ev.target.closest('[data-cerrar]')) { cerrarModal(); return; }
  const tr = ev.target.closest('tbody tr[data-suc]');
  if (tr && DATA) { abrirDesdeFila(tr, ev.target.closest('td[data-v]')); return; }
  const b = ev.target.closest('[data-sort]');
  if (!b || !DATA) return;
  const id = b.dataset.sort, k = b.dataset.k, cur = SORT[id];
  SORT[id] = cur && cur.k === k ? { k, d: -cur.d } : { k, d: b.dataset.num === '1' ? -1 : 1 };
  if (id === 'mod') pintarModal(); else pintarCard(id);
  const nuevo = document.querySelector(`[data-sort="${id}"][data-k="${k}"]`);
  if (nuevo) nuevo.focus();
});
document.addEventListener('keydown', ev => {
  if ($('modal').hidden) return;
  if (ev.key === 'Escape') { ev.preventDefault(); cerrarModal(); return; }
  if (ev.key !== 'Tab') return;
  const f = [...$('modal').querySelectorAll('button, input')].filter(e => !e.disabled && e.offsetParent !== null);
  if (!f.length) return;
  const i = f.indexOf(document.activeElement);
  if (ev.shiftKey && i <= 0) { ev.preventDefault(); f[f.length - 1].focus(); }
  else if (!ev.shiftKey && (i === -1 || i === f.length - 1)) { ev.preventDefault(); f[0].focus(); }
});
const debounce = (fn, ms = 150) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const pintarModalDeb = debounce(() => { if (MODAL.id != null) pintarModal(); });
$('qMod').addEventListener('input', ev => { MODAL.q = ev.target.value; pintarModalDeb(); });
$('chipsMod').addEventListener('click', ev => {
  const b = ev.target.closest('[data-win]');
  if (!b) return;
  MODAL.win = b.dataset.win;
  pintarModal();
});
$('qTop').addEventListener('input', debounce(() => { if (DATA) pintarCard('top'); }));
$('qOfe').addEventListener('input', debounce(() => { if (DATA) pintarCard('ofe'); }));
$('chipsOfe').addEventListener('click', ev => {
  const b = ev.target.closest('[data-estado]');
  if (!b) return;
  FILTRO_OFE = b.dataset.estado;
  document.querySelectorAll('#chipsOfe .chip').forEach(c => c.setAttribute('aria-pressed', String(c === b)));
  if (DATA) pintarCard('ofe');
});
$('qDev').addEventListener('input', debounce(() => { if (DATA) pintarCard('dev'); }));
$('chipsDev').addEventListener('click', ev => {
  const b = ev.target.closest('[data-suc-dev]');
  if (!b) return;
  FILTRO_DEV = b.dataset.sucDev;
  if (DATA) pintarCard('dev');
});
$('btnActualizar').addEventListener('click', cargar);
$('btnLogout').addEventListener('click', async () => {
  try { await fetch('/api/logout', { method: 'POST' }); } catch (_) { /* ignorar */ }
  location.href = '/login';
});
setInterval(pintarGenerado, 30000);
cargar();
