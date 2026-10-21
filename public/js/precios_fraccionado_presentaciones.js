// ── Precios · tab Fraccionado: facilidad, tiempo e insumos de cada presentación (spec 2026-10-21-precios-fraccionado-costeo-design §9.3) ──
// Script clásico después de precios_listados.js, que llama a celdasFP / htmlBarraFP / conectarFP / actualizarBarraFP. Los
// cambios quedan pendientes (pendFP, sobreviven a filtrar y a recargar) hasta "Guardar cambios": un PUT (en trozos si son muchos)
// /api/precios/fraccionado/presentaciones y se recarga el listado (los precios dependen de lo elegido). Lo usa cualquiera con
// acceso a Precios; los costos los ve sólo precios-config (modal). Globales: esc, numOrNull, pedirJson (precios_comun.js),
// lstDatos, renderListado, cargarListado (precios_listados.js), htmlBuscadorSiga, conectarBuscadorSiga (precios_produccion.js).
const ESC_FP = typeof module === 'object' && module.exports ? require('./precios_comun.js').esc : esc;
const FACILIDAD_FP = { facil: 'Fácil', normal: 'Normal', dificil: 'Difícil' };
const TIEMPO_FP = { rapido: 'Rápido', normal: 'Normal', lento: 'Lento' };
const API_FP = '/api/precios/fraccionado/presentaciones';
const MAX_CAMBIOS_FP = 500;    // = MAX_CAMBIOS de lib/precios_config_fraccionado.js
const MAX_BYTES_FP = 80000;    // el body de express.json tiene 100 kb: un lote con muchos insumos se parte antes

// ── Puros (test/precios_fraccionado_presentaciones.test.js) ──
// pend = { [plu]: { facilidad?, tiempo?, insumos? } } (null = sacar). Lo que se ve = lo guardado (p.fraccPresentacion) pisado por lo pendiente.
function valorFP(p, pend) {
  const g = p.fraccPresentacion || {}, x = pend[p.plu] || {};
  const de = k => (k in x ? x[k] : g[k] ?? null);
  return { facilidad: de('facilidad'), tiempo: de('tiempo'), insumos: de('insumos') || [] };
}
// El mismo cambio a varias presentaciones → pend nuevo. '' (opción "—" de un select) = sacar.
function conCambioFP(pend, plus, cambio) {
  const limpio = Object.fromEntries(Object.entries(cambio).map(([k, v]) => [k, v === '' ? null : v]));
  return plus.reduce((acc, plu) => ({ ...acc, [plu]: { ...(acc[plu] || {}), ...limpio } }), pend);
}
// Body del PUT ({ cambios }): un cambio por PLU, insumos sin el nombre.
const cambiosFP = pend => Object.entries(pend).map(([plu, x]) => ({ plu, ...x,
  ...('insumos' in x ? { insumos: x.insumos == null ? null : x.insumos.map(i => ({ plu: i.plu, cantidad: i.cantidad })) } : {}) }));
// Cambios en pedidos de a lo sumo `max` cambios y `maxBytes` de JSON (uno solo nunca se parte). El servidor rechaza un lote entero
// si algo falla, así que cada trozo es todo-o-nada.
function trozosFP(cambios, max = MAX_CAMBIOS_FP, maxBytes = MAX_BYTES_FP) {
  return cambios.reduce((trozos, c) => {
    const bytes = JSON.stringify(c).length, ultimo = trozos[trozos.length - 1];
    if (ultimo && ultimo.cambios.length < max && ultimo.bytes + bytes <= maxBytes) { ultimo.cambios.push(c); ultimo.bytes += bytes; } // ponytail: acumula el trozo en el lugar
    else trozos.push({ cambios: [c], bytes });
    return trozos;
  }, []).map(t => t.cambios);
}
// Elegidos del buscador SIGA a la lista de insumos: cantidad 1, sin repetir.
const conInsumosFP = (lista, elegidos) => [...lista,
  ...elegidos.filter(e => !lista.some(x => x.plu === String(e.plu))).map(e => ({ plu: String(e.plu), nombre: e.nombre, cantidad: 1 }))];
// El servidor exige cantidad > 0 en cada insumo: se avisa en el diálogo, no con el lote entero rechazado.
const errorInsumosFP = lista => {
  const malo = lista.find(x => !(x.cantidad > 0));
  return malo ? `Cantidad mayor que 0 en "${malo.nombre || malo.plu}"` : null;
};
const opcionesFP = (mapa, actual, vacio) => `<option value="">${vacio}</option>${Object.entries(mapa)
  .map(([k, t]) => `<option value="${k}"${k === actual ? ' selected' : ''}>${t}</option>`).join('')}`;
const chipsFP = insumos => (insumos.length
  ? insumos.map(i => `<span class="fp-chip">${ESC_FP(i.nombre || `PLU ${i.plu}`)} × ${ESC_FP(i.cantidad)}</span>`).join(' ')
  : '<span class="text-gris">sin insumos</span>');
// Celdas de una presentación: selección, facilidad, tiempo, insumos. Sin fraccPresentacion (Fraccionado sin migrar) → vacías.
function celdasFP(p, pend, seleccion) {
  if (!p.fraccPresentacion) return '<td></td><td></td><td></td><td></td>';
  const v = valorFP(p, pend), cls = p.plu in pend ? ' fp-pend' : '', nombre = ESC_FP(p.nombre), plu = ESC_FP(p.plu);
  const sel = (clase, mapa, actual, txt) => `<select class="${clase} num-in text-left" data-plu="${plu}" aria-label="${txt} de ${nombre}">${opcionesFP(mapa, actual, '—')}</select>`;
  return `<td class="p-2"><input type="checkbox" class="fp-sel" data-plu="${plu}"${seleccion.has(p.plu) ? ' checked' : ''} aria-label="Seleccionar ${nombre}"></td>
    <td class="p-2${cls}">${sel('fp-facilidad', FACILIDAD_FP, v.facilidad, 'Facilidad')}</td>
    <td class="p-2${cls}">${sel('fp-tiempo', TIEMPO_FP, v.tiempo, 'Tiempo')}</td>
    <td class="p-2${cls} text-xs">${chipsFP(v.insumos)} <button type="button" class="fp-editar text-verde underline underline-offset-2 ml-1" data-plu="${plu}" aria-label="Editar insumos de ${nombre}">Editar</button></td>`;
}

if (typeof module === 'object' && module.exports) module.exports = { valorFP, conCambioFP, cambiosFP, celdasFP, conInsumosFP, trozosFP, errorInsumosFP };

// ── DOM ──
let pendFP = {};         // cambios sin guardar por PLU de presentación
const selFP = new Set(); // ponytail: selección de UI, se muta en el lugar
const presentacionFP = plu => (lstDatos.fraccionado || []).flatMap(g => g.presentaciones || []).find(p => p.plu === plu);

// Contenedor externo sin display propio (hidden de Tailwind no le gana a flex): se oculta entero si no hay nada migrado.
function htmlBarraFP() {
  return `<div class="fp-barra hidden mb-3"><div class="flex items-center gap-2 flex-wrap p-2 rounded-lg border border-borde bg-card text-sm">
    <b>Por presentación:</b><span class="fp-nsel text-gris"></span>
    <button type="button" class="fp-todas cfg-btn2">Seleccionar visibles</button><button type="button" class="fp-ninguna cfg-btn2">Ninguna</button>
    <label>Facilidad <select class="fp-lote-facilidad num-in">${opcionesFP(FACILIDAD_FP, null, 'no cambiar')}</select></label>
    <label>Tiempo <select class="fp-lote-tiempo num-in">${opcionesFP(TIEMPO_FP, null, 'no cambiar')}</select></label>
    <button type="button" class="fp-lote-aplicar cfg-btn2">Aplicar a seleccionadas</button>
    <button type="button" class="fp-lote-insumos cfg-btn2">Insumos a seleccionadas…</button>
    <span class="fp-msg" role="status" aria-live="polite"></span>
    <span class="ml-auto fp-npend text-warn"></span>
    <button type="button" class="fp-descartar cfg-btn2 hidden">Descartar</button>
    <button type="button" class="fp-guardar cfg-btn hidden">Guardar cambios</button></div></div>`;
}
const migradoFP = () => (lstDatos.fraccionado || []).some(g => (g.presentaciones || []).some(p => p.fraccPresentacion));
function actualizarBarraFP(cont) {
  const n = Object.keys(pendFP).length;
  cont.querySelector('.fp-barra').classList.toggle('hidden', !migradoFP());
  cont.querySelector('.fp-nsel').textContent = `${selFP.size} seleccionada${selFP.size === 1 ? '' : 's'}`;
  cont.querySelector('.fp-npend').textContent = n ? `${n} presentaci${n === 1 ? 'ón' : 'ones'} con cambios sin guardar` : '';
  cont.querySelector('.fp-guardar').classList.toggle('hidden', !n);
  cont.querySelector('.fp-descartar').classList.toggle('hidden', !n);
}
const msgFP = (cont, txt, cls = '') => { const m = cont.querySelector('.fp-msg'); m.className = `fp-msg ${cls}`; m.textContent = txt; };
// Aplica el cambio y repinta; el repintado reemplaza los selects, así que el foco vuelve al control que se tocó.
const cambiarFP = (plus, cambio, foco = null) => {
  pendFP = conCambioFP(pendFP, plus, cambio);
  renderListado('fraccionado');
  const el = foco && document.querySelector(foco);
  if (el) el.focus();
};

function conectarFP(cont) {
  const q = s => cont.querySelector(s);
  const cuerpo = q('.lst-cuerpo');
  cuerpo.addEventListener('change', e => {
    const s = e.target.closest('.fp-facilidad, .fp-tiempo');
    if (s) {
      const clase = s.classList.contains('fp-facilidad') ? 'fp-facilidad' : 'fp-tiempo';
      cambiarFP([s.dataset.plu], { [clase === 'fp-facilidad' ? 'facilidad' : 'tiempo']: s.value }, `.${clase}[data-plu="${CSS.escape(s.dataset.plu)}"]`);
    }
    const c = e.target.closest('.fp-sel');
    if (c) { if (c.checked) selFP.add(c.dataset.plu); else selFP.delete(c.dataset.plu); actualizarBarraFP(cont); }
  });
  cuerpo.addEventListener('click', async e => {
    const b = e.target.closest('.fp-editar');
    if (!b) return;
    const p = presentacionFP(b.dataset.plu);
    const lista = await editarInsumosFP(valorFP(p, pendFP).insumos, `Insumos de ${p.nombre}`);
    if (lista) cambiarFP([p.plu], { insumos: lista }, `.fp-editar[data-plu="${CSS.escape(p.plu)}"]`);
  });
  q('.fp-todas').onclick = () => { cont.querySelectorAll('.fp-sel').forEach(c => selFP.add(c.dataset.plu)); renderListado('fraccionado'); };
  q('.fp-ninguna').onclick = () => { selFP.clear(); renderListado('fraccionado'); };
  q('.fp-lote-aplicar').onclick = () => {
    const cambio = Object.fromEntries([['facilidad', q('.fp-lote-facilidad').value], ['tiempo', q('.fp-lote-tiempo').value]].filter(([, v]) => v));
    if (!selFP.size || !Object.keys(cambio).length) { msgFP(cont, 'Elegí presentaciones y una facilidad o un tiempo', 'text-warn'); return; }
    cambiarFP([...selFP], cambio);
  };
  q('.fp-lote-insumos').onclick = async () => {
    if (!selFP.size) { msgFP(cont, 'Elegí presentaciones primero', 'text-warn'); return; }
    const lista = await editarInsumosFP([], `Insumos para ${selFP.size} presentaci${selFP.size === 1 ? 'ón' : 'ones'} (reemplazan los que tengan)`);
    if (lista) cambiarFP([...selFP], { insumos: lista });
  };
  q('.fp-descartar').onclick = () => { pendFP = {}; renderListado('fraccionado'); };
  q('.fp-guardar').onclick = () => guardarFP(cont);
}

// Un PUT por trozo; lo que ya se guardó sale de pendFP aunque un trozo posterior falle (se recarga igual y el error queda a la vista).
async function guardarFP(cont) {
  const boton = cont.querySelector('.fp-guardar');
  boton.disabled = true; // un solo guardado a la vez (un doble clic repetiría el PUT)
  msgFP(cont, 'Guardando…');
  let error = null, guardo = false;
  for (const trozo of trozosFP(cambiosFP(pendFP))) {
    try {
      await pedirJson('PUT', API_FP, { cambios: trozo }); // precios_comun.js
      pendFP = Object.fromEntries(Object.entries(pendFP).filter(([plu]) => !trozo.some(c => c.plu === plu)));
      guardo = true;
    } catch (e) { error = e; break; }
  }
  if (guardo) { selFP.clear(); await cargarListado('fraccionado'); } // los precios dependen de lo elegido
  boton.disabled = false;
  if (error) msgFP(cont, `No se pudo guardar${guardo ? ' todo (lo anterior sí se guardó)' : ''}: ${error.message}`, 'text-crit');
}

// Diálogo de insumos por unidad (#dlgFP en precios.html) → Promise de la lista elegida o null (Cancelar / Esc).
function editarInsumosFP(insumos, titulo) {
  const d = document.getElementById('dlgFP');
  const filas = d.querySelector('.fp-dlg-filas'), msg = d.querySelector('.fp-dlg-msg');
  let lista = insumos.map(x => ({ ...x }));
  const pintar = () => {
    filas.innerHTML = lista.length ? lista.map(x => `<tr data-plu="${esc(x.plu)}"><td class="py-1 pr-2">${esc(x.nombre || x.plu)} <span class="text-gris text-xs">${esc(x.plu)}</span></td>
      <td class="py-1 pr-2"><input type="number" min="0" step="any" class="num-in w-20" value="${esc(x.cantidad ?? '')}" aria-label="Cantidad por unidad de ${esc(x.nombre || x.plu)}"></td>
      <td class="py-1"><button type="button" class="fp-dlg-quitar text-gris hover:text-crit" aria-label="Quitar ${esc(x.nombre || x.plu)}">✕</button></td></tr>`).join('')
      : '<tr><td class="text-gris py-1">Sin insumos.</td></tr>';
  };
  const leer = () => { lista = lista.map(x => ({ ...x, cantidad: numOrNull(filas.querySelector(`tr[data-plu="${CSS.escape(x.plu)}"] input`).value) })); };
  d.querySelector('.fp-dlg-titulo').textContent = titulo;
  msg.textContent = '';
  // El buscador se pinta de nuevo en cada apertura: conectarBuscadorSiga engancha con addEventListener (no se duplica así).
  d.querySelector('.fp-dlg-bus').innerHTML = htmlBuscadorSiga('fpDlgBus', 'Agregar insumos (nombre o PLU)');
  conectarBuscadorSiga('fpDlgBus', elegidos => { leer(); lista = conInsumosFP(lista, elegidos); pintar(); },
    { multiple: true, deshabilitado: plu => (lista.some(x => x.plu === String(plu)) ? 'ya está' : null) });
  filas.onclick = e => { const b = e.target.closest('.fp-dlg-quitar'); if (b) { leer(); lista = lista.filter(x => x.plu !== b.closest('tr').dataset.plu); pintar(); } };
  d.querySelector('.fp-dlg-vaciar').onclick = () => { lista = []; pintar(); };
  d.querySelector('.fp-dlg-ok').onclick = () => {
    leer();
    const falla = errorInsumosFP(lista);
    if (falla) { msg.textContent = falla; return; }
    d.close('ok');
  };
  d.querySelector('.fp-dlg-cancelar').onclick = () => d.close('');
  pintar();
  d.returnValue = '';
  d.showModal();
  return new Promise(res => d.addEventListener('close', () => res(d.returnValue === 'ok' ? lista : null), { once: true }));
}
