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
const SACAR_FP = 'sacar';      // opción "Sacar" de los selects del lote ("no cambiar" = valor vacío)
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
// Selects del lote → cambio: '' = no cambiar (no entra), 'sacar' = null (borra lo guardado), otro = ese valor.
const cambioLoteFP = (facilidad, tiempo) => Object.fromEntries([['facilidad', facilidad], ['tiempo', tiempo]]
  .filter(([, v]) => v).map(([k, v]) => [k, v === SACAR_FP ? null : v]));
// pend sin lo que ya se guardó (plus): sólo las entradas que siguen iguales a la foto con la que se armó el pedido; lo que se
// editó mientras se guardaba (o una presentación nueva) sigue pendiente.
const sinGuardadosFP = (pend, foto, plus) => {
  const hechos = new Set(plus);
  return Object.fromEntries(Object.entries(pend).filter(([plu, x]) => !(hechos.has(plu) && JSON.stringify(x) === JSON.stringify(foto[plu]))));
};
// El lote alcanza sólo a las seleccionadas que se ven (las que el filtro esconde no se tocan).
const soloVisiblesFP = (seleccion, visibles) => visibles.filter(plu => seleccion.has(plu));
const textoSelFP = n => `${n} seleccionada${n === 1 ? '' : 's'} visible${n === 1 ? '' : 's'}`;
const opcionesFP = (mapa, actual, vacio) => `<option value="">${vacio}</option>${Object.entries(mapa)
  .map(([k, t]) => `<option value="${k}"${k === actual ? ' selected' : ''}>${t}</option>`).join('')}`;
const chipsFP = insumos => (insumos.length
  ? insumos.map(i => `<span class="fp-chip">${ESC_FP(i.nombre || `PLU ${i.plu}`)} × ${ESC_FP(i.cantidad)}</span>`).join(' ')
  : '<span class="text-gris">sin insumos</span>');
// Celdas de una presentación: selección, facilidad, tiempo, insumos. Sin fraccPresentacion (Fraccionado sin migrar) → vacías.
// Las cuatro llevan fp-col: la tabla (.fp-sin-cols) las oculta juntas con sus encabezados si nada está migrado (precios.html).
const CELDAS_VACIAS_FP = '<td class="fp-col"></td>'.repeat(4);
function celdasFP(p, pend, seleccion) {
  if (!p.fraccPresentacion) return CELDAS_VACIAS_FP;
  const v = valorFP(p, pend), cls = p.plu in pend ? ' fp-pend' : '', nombre = ESC_FP(p.nombre), plu = ESC_FP(p.plu);
  const sel = (clase, mapa, actual, txt) => `<select class="${clase} num-in text-left" data-plu="${plu}" aria-label="${txt} de ${nombre}">${opcionesFP(mapa, actual, '—')}</select>`;
  return `<td class="p-2 fp-col"><input type="checkbox" class="fp-sel" data-plu="${plu}"${seleccion.has(p.plu) ? ' checked' : ''} aria-label="Seleccionar ${nombre}"></td>
    <td class="p-2 fp-col${cls}">${sel('fp-facilidad', FACILIDAD_FP, v.facilidad, 'Facilidad')}</td>
    <td class="p-2 fp-col${cls}">${sel('fp-tiempo', TIEMPO_FP, v.tiempo, 'Tiempo')}</td>
    <td class="p-2 fp-col${cls} text-xs">${chipsFP(v.insumos)} <button type="button" class="fp-editar text-verde underline underline-offset-2 ml-1" data-plu="${plu}" aria-label="Editar insumos de ${nombre}">Editar</button></td>`;
}

// Barra del lote. Contenedor externo sin display propio (hidden de Tailwind no le gana a flex): se oculta entero si nada está
// migrado. Los textos de los botones dicen a cuántas presentaciones aplican (actualizarBarraFP).
const opcionesLoteFP = mapa => `${opcionesFP(mapa, null, 'no cambiar')}<option value="${SACAR_FP}">Sacar</option>`;
function htmlBarraFP() {
  return `<div class="fp-barra hidden mb-3"><div class="flex items-center gap-2 flex-wrap p-2 rounded-lg border border-borde bg-card text-sm">
    <b>Por presentación:</b><span class="fp-nsel text-gris"></span>
    <button type="button" class="fp-todas cfg-btn2">Seleccionar visibles</button><button type="button" class="fp-ninguna cfg-btn2">Ninguna</button>
    <label>Facilidad <select class="fp-lote-facilidad num-in">${opcionesLoteFP(FACILIDAD_FP)}</select></label>
    <label>Tiempo <select class="fp-lote-tiempo num-in">${opcionesLoteFP(TIEMPO_FP)}</select></label>
    <button type="button" class="fp-lote-aplicar cfg-btn2">Aplicar a ${textoSelFP(0)}</button>
    <button type="button" class="fp-lote-insumos cfg-btn2">Insumos a ${textoSelFP(0)}…</button>
    <span class="fp-msg" role="status" aria-live="polite"></span>
    <span class="ml-auto fp-npend text-warn"></span>
    <button type="button" class="fp-descartar cfg-btn2 hidden">Descartar</button>
    <button type="button" class="fp-guardar cfg-btn hidden">Guardar cambios</button></div></div>`;
}

if (typeof module === 'object' && module.exports) module.exports = { valorFP, conCambioFP, cambiosFP, celdasFP, conInsumosFP, trozosFP, errorInsumosFP,
  cambioLoteFP, sinGuardadosFP, soloVisiblesFP, textoSelFP, htmlBarraFP };

// ── DOM ──
let pendFP = {};         // cambios sin guardar por PLU de presentación
const selFP = new Set(); // ponytail: selección de UI, se muta en el lugar
let guardandoFP = false; // mientras guarda, seguir editando no borra el "Guardando…"
// Lo pendiente vive sólo en memoria: F5 o cerrar la pestaña lo pierde, así que el navegador pregunta (como Configuración).
if (typeof window !== 'undefined') window.addEventListener('beforeunload', e => { if (Object.keys(pendFP).length) e.preventDefault(); }); // typeof: el test lo carga en Node
const presentacionFP = plu => (lstDatos.fraccionado || []).flatMap(g => g.presentaciones || []).find(p => p.plu === plu);

const migradoFP = () => (lstDatos.fraccionado || []).some(g => (g.presentaciones || []).some(p => p.fraccPresentacion));
// Seleccionadas que se ven en la tabla ahora (el filtro del listado esconde filas, no las deselecciona).
const visiblesSelFP = cont => soloVisiblesFP(selFP, [...cont.querySelectorAll('.fp-sel')].map(c => c.dataset.plu));
function actualizarBarraFP(cont) {
  const n = Object.keys(pendFP).length, migrado = migradoFP(), visibles = visiblesSelFP(cont).length, ocultas = selFP.size - visibles;
  cont.querySelector('.fp-barra').classList.toggle('hidden', !migrado);
  cont.querySelector('table').classList.toggle('fp-sin-cols', !migrado); // columnas Selección/Facilidad/Tiempo/Insumos (precios.html)
  cont.querySelector('.fp-nsel').textContent = ocultas ? `(${ocultas} fuera del filtro, no se tocan)` : '';
  cont.querySelector('.fp-lote-aplicar').textContent = `Aplicar a ${textoSelFP(visibles)}`;
  cont.querySelector('.fp-lote-insumos').textContent = `Insumos a ${textoSelFP(visibles)}…`;
  cont.querySelector('.fp-npend').textContent = n ? `${n} presentaci${n === 1 ? 'ón' : 'ones'} con cambios sin guardar` : '';
  cont.querySelector('.fp-guardar').classList.toggle('hidden', !n);
  cont.querySelector('.fp-descartar').classList.toggle('hidden', !n);
}
const msgFP = (cont, txt, cls = '') => { const m = cont.querySelector('.fp-msg'); m.className = `fp-msg ${cls}`; m.textContent = txt; };
// Aplica el cambio y repinta; el repintado reemplaza los selects, así que el foco vuelve al control que se tocó.
const cambiarFP = (plus, cambio, foco = null) => {
  pendFP = conCambioFP(pendFP, plus, cambio);
  renderListado('fraccionado');
  if (!guardandoFP) msgFP(document.getElementById(LST_CONT.fraccionado), ''); // el "Guardado" o el aviso anterior ya no vale
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
    const plus = visiblesSelFP(cont), cambio = cambioLoteFP(q('.fp-lote-facilidad').value, q('.fp-lote-tiempo').value);
    if (!plus.length || !Object.keys(cambio).length) { msgFP(cont, 'Elegí presentaciones y una facilidad o un tiempo (o "Sacar")', 'text-warn'); return; }
    cambiarFP(plus, cambio);
  };
  q('.fp-lote-insumos').onclick = async () => {
    const plus = visiblesSelFP(cont);
    if (!plus.length) { msgFP(cont, 'Elegí presentaciones primero', 'text-warn'); return; }
    const lista = await editarInsumosFP([], `Insumos para ${plus.length} presentaci${plus.length === 1 ? 'ón' : 'ones'} (reemplazan los que tengan)`);
    if (lista) cambiarFP(plus, { insumos: lista });
  };
  q('.fp-descartar').onclick = () => { pendFP = {}; renderListado('fraccionado'); };
  q('.fp-guardar').onclick = () => guardarFP(cont);
}

// Un PUT por trozo, armados con una foto de lo pendiente: de pendFP sale sólo lo que se guardó y no cambió desde la foto (lo editado
// mientras se guardaba sigue pendiente). Si un trozo falla, lo anterior ya está guardado: se recarga igual y el error queda a la vista.
async function guardarFP(cont) {
  if (guardandoFP) return;
  const boton = cont.querySelector('.fp-guardar'), foto = pendFP;
  boton.disabled = guardandoFP = true; // un solo guardado a la vez (un doble clic repetiría el PUT)
  msgFP(cont, 'Guardando…');
  let error = null, guardo = false;
  for (const trozo of trozosFP(cambiosFP(foto))) {
    try {
      await pedirJson('PUT', API_FP, { cambios: trozo }); // precios_comun.js
      pendFP = sinGuardadosFP(pendFP, foto, trozo.map(c => c.plu));
      guardo = true;
    } catch (e) { error = e; break; }
  }
  if (guardo) { selFP.clear(); await cargarListado('fraccionado'); } // los precios dependen de lo elegido
  boton.disabled = guardandoFP = false;
  if (error) msgFP(cont, `No se pudo guardar${guardo ? ' todo (lo anterior sí se guardó)' : ''}: ${error.message}`, 'text-crit');
  else msgFP(cont, guardo ? 'Guardado' : '', 'text-ok');
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
