// ── Precios · Configuración › Costeo Fraccionado (spec 2026-10-21-precios-fraccionado-costeo-design §9.3) ──
// Script clásico, después de precios_config_esquema.js y precios_produccion.js. Sub-tab sólo con el switch de Configuración en
// Fraccionado (mostrarCosteoFracc). Máquinas, escalas (factores de facilidad y de tiempo) y, por subrubro de SIGA, su máquina y
// sus minutos base según el peso. Cada tarjeta / subrubro guarda con su botón (PUT /api/precios/config/esquema/fraccionado/…)
// y se repinta sólo ella: lo que las otras tengan sin guardar queda. La facilidad, el tiempo y los insumos de cada presentación
// se eligen en la tab Fraccionado (precios_fraccionado_presentaciones.js); la máquina propia de un granel, en su modal.
// Globales: esc, numOrNull (precios_comun.js), campoU, marcarSucio, limpiarSucio (precios_config.js), pedirEsq, msgEsq,
// esFraccCfg (precios_config_esquema.js).
const API_FR = '/api/precios/config/esquema/fraccionado';
const ESCALAS_FR = { facilidad: [['facil', 'Fácil'], ['normal', 'Normal'], ['dificil', 'Difícil']], tiempo: [['rapido', 'Rápido'], ['normal', 'Normal'], ['lento', 'Lento']] };
const TRAMO_INICIAL_G = 250;
const PRODUCTOS_PARA_BUSCAR = 8; // desde acá la lista de productos de un subrubro trae buscador

// ── Puros (test/precios_config_fraccionado_ui.test.js) ──
// Tramo nuevo al final: el doble del último (o 250 g), minutos por cargar.
const conTramoFr = tramos => [...tramos, { hastaG: tramos.length ? tramos[tramos.length - 1].hastaG * 2 : TRAMO_INICIAL_G, minutos: null }];
// Lo que le falta a un subrubro para costear (conf = lo guardado): máquina y/o tramos.
const faltaSubrubroFr = conf => [...(conf && conf.maquinaId ? [] : ['máquina']), ...(conf && (conf.tramos || []).length ? [] : ['tramos'])];
function cuentaProductosFr(s) {
  const n = s.graneles.length, m = s.graneles.reduce((t, g) => t + g.presentaciones.length, 0);
  return `${n} producto${n === 1 ? '' : 's'} · ${m} presentaci${m === 1 ? 'ón' : 'ones'}`;
}
function resumenSubrubroFr(conf, maquinas) {
  const c = conf || {}, n = (c.tramos || []).length;
  const maq = (maquinas.find(m => m.id === c.maquinaId) || {}).nombre;
  return `${maq || 'sin máquina'} · ${n ? `${n} tramo${n === 1 ? '' : 's'}` : 'sin tramos'}`;
}
const textoUsosFr = u => [u.subrubros ? `${u.subrubros} subrubro${u.subrubros === 1 ? '' : 's'}` : '',
  u.graneles ? `${u.graneles} granel${u.graneles === 1 ? '' : 'es'}` : ''].filter(Boolean).join(' · ') || 'sin uso';
// Buscador de productos: todas las palabras del texto buscado están en el texto del producto, sin mayúsculas ni tildes.
const sinTildesFr = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const coincideFr = (texto, busqueda) => sinTildesFr(busqueda).split(/\s+/).filter(Boolean).every(p => sinTildesFr(texto).includes(p));
// Subrubros de SIGA + los que tienen configuración pero SIGA ya no trae: sin esa fila su máquina no se podría soltar y la
// máquina quedaría "en uso" para siempre.
const subrubrosListaFr = (siga, configurados) => [...siga, ...Object.keys(configurados || {}).filter(id => !siga.some(s => s.id === id))
  .map(id => ({ id, nombre: `Subrubro ${id} (ya no tiene productos en SIGA)`, graneles: [] }))];

if (typeof module === 'object' && module.exports) module.exports = { conTramoFr, faltaSubrubroFr, cuentaProductosFr, resumenSubrubroFr, textoUsosFr, coincideFr, subrubrosListaFr };

// ── DOM ──
let cfFr = null;              // GET /costeo: config (maquinas, escalas, subrubros, porGranel) + productos (subrubrosSiga, sinSubrubro)
const abiertosFr = new Set(); // ponytail: subrubros desplegados, estado de UI que se muta en el lugar

// La llama activarSubConfig (precios_config.js), que corre al entrar a Configuración y cada vez que cambia el switch
// Reventa | Fraccionado: el sub-tab sólo existe con Fraccionado (si estaba abierto, activarSubConfig vuelve a Costos).
function mostrarCosteoFracc(tipo) {
  document.getElementById('tab-costeo-fracc').classList.toggle('hidden', tipo !== 'fraccionado');
}
// Sin migrar: el aviso de arriba de Configuración (#cfgFraccAviso, el mismo de Costos/Márgenes/Precio).
const avisoFr = migrado => document.getElementById('cfgFraccAviso').classList.toggle('hidden', !esFraccCfg() || migrado);

async function cargarCosteoFracc() {
  const panel = document.getElementById('panel-costeo-fracc');
  panel.innerHTML = '<div class="text-sm text-ink/50 py-4"><span class="spin"></span> Cargando…</div>';
  try {
    cfFr = await pedirEsq('GET', `${API_FR}/costeo`);
    avisoFr(cfFr.migrado);
    pintarCosteoFracc(panel);
  } catch (e) { panel.innerHTML = `<p class="text-sm text-crit py-4">No se pudo cargar: ${esc(e.message)}</p>`; }
}

// Guardar un bloque: la respuesta del PUT es la config nueva (sin los productos, que no cambian) y se mezcla en cfFr; después
// se repinta sólo lo guardado (repintar devuelve el bloque nuevo). Las otras tarjetas y su data-sucio quedan como están.
async function guardarFr(bloque, ruta, body, repintar) {
  const msg = bloque.querySelector('.esq-msg'), boton = bloque.querySelector('.fr-guardar');
  msgEsq(msg, 'Guardando…');
  boton.disabled = true; // un segundo click mientras se guarda mandaría el mismo PUT dos veces
  try {
    cfFr = { ...cfFr, ...(await pedirEsq('PUT', `${API_FR}${ruta}`, body)) };
    avisoFr(cfFr.migrado);
    limpiarSucio(bloque);
    const nuevo = repintar();
    msgEsq(nuevo && nuevo.querySelector('.esq-msg'), 'Guardado', 'text-ok');
    actualizarUsosMaquinasFr();
  } catch (e) { msgEsq(msg, e.message, 'text-crit'); } finally { boton.disabled = false; }
}
function repintarFr(id, html, conectar) {
  const viejo = document.getElementById(id);
  if (!viejo) return null; // mientras se guardaba, el panel se recargó entero
  viejo.outerHTML = html();
  const nuevo = document.getElementById(id);
  conectar(nuevo);
  return nuevo;
}
// La fila se saca antes de que el listener de data-edita (precios_config.js) la busque: se marca la tarjeta acá.
function quitarFilaFr(e, card) {
  const b = e.target.closest('.fr-quitar');
  if (!b || b.disabled) return;
  marcarSucio(card);
  b.closest('tr').remove();
}

const pieFr = txt => `<div class="cfg-pie"><span class="esq-msg text-sm" role="status" aria-live="polite"></span><button type="button" class="fr-guardar cfg-btn">${txt}</button></div>`;
function pintarCosteoFracc(panel) {
  panel.innerHTML = `<p class="cfg-cab"><b>Costeo de Fraccionado</b> — mano de obra, máquina e insumos de cada presentación, sumados al $/kg del granel.
      Minutos por unidad = minutos del tramo de peso del subrubro × factor del tiempo × factor de la facilidad de la presentación.
      Facilidad, tiempo e insumos de cada presentación se eligen en la tab Fraccionado; el costo hora de mano de obra está en Costos.</p>
    <div class="grid gap-4 xl:grid-cols-2">${htmlMaquinasFr()}${htmlEscalasFr()}</div>
    <div class="cfg-card min-w-0 mt-4"><h3 class="cfg-h">Subrubros</h3>
      <p class="cfg-ayuda">Por subrubro de SIGA (rubro Pesables Deposito): ① la máquina con la que se fraccionan sus productos (un granel puede tener otra desde su modal) y ② los minutos base por unidad según el peso de la presentación (el primer tramo que la cubre; más pesada que el último → el último). Cada subrubro se guarda por separado.</p>
      <div id="frSubrubros">${htmlSubrubrosFr()}</div></div>`;
  conectarMaquinasFr(panel.querySelector('#frMaquinas'));
  conectarEscalasFr(panel.querySelector('#frEscalas'));
  panel.querySelectorAll('#frSubrubros details[data-sub]').forEach(conectarSubrubroFr);
}

// ── Máquinas ──
const enUsoFr = u => !!u && (u.graneles + u.subrubros) > 0;
const htmlQuitarMaqFr = usos => `<button type="button" class="fr-quitar text-gris hover:text-crit disabled:opacity-30" data-edita aria-label="Quitar"${enUsoFr(usos) ? ' disabled title="En uso: asigná otra máquina a esos subrubros y graneles antes de borrarla"' : ''}>✕</button>`;
const htmlFilaMaqFr = (m = {}) => `<tr data-id="${esc(m.id || '')}">
  <td class="py-1 pr-2"><input class="num-in w-full text-left" data-k="nombre" maxlength="60" value="${esc(m.nombre || '')}" aria-label="Nombre de la máquina"></td>
  <td class="py-1 pr-2">${campoU(`<input type="number" min="0" step="any" data-k="costoHora" value="${esc(m.costoHora ?? '')}" aria-label="Costo por hora">`, '$/h', { w: 'w-32' })}</td>
  <td class="fr-usos py-1 pr-2 text-xs text-gris">${esc(m.usos ? textoUsosFr(m.usos) : 'sin uso')}</td>
  <td class="fr-q py-1">${htmlQuitarMaqFr(m.usos)}</td></tr>`;
const htmlMaquinasFr = () => `<div class="cfg-card min-w-0" data-guardable data-nombre="Máquinas" id="frMaquinas">
    <h3 class="cfg-h">Máquinas</h3><p class="cfg-ayuda">Costo por hora de cada máquina (sin IVA). Por unidad suma minutos × costo hora ÷ 60. Una máquina en uso no se puede borrar.</p>
    <table class="cfg-tabla w-full mt-2"><thead><tr><th class="text-left">Nombre</th><th class="text-left">Costo hora</th><th class="text-left">Usada en</th><th></th></tr></thead>
      <tbody>${cfFr.maquinas.map(m => htmlFilaMaqFr(m)).join('')}</tbody></table>
    <button type="button" class="fr-agregar cfg-btn2 mt-2" data-edita>+ Agregar</button>${pieFr('Guardar máquinas')}</div>`;
const leerMaquinasFr = card => [...card.querySelectorAll('tbody tr')].map(tr => ({ ...(tr.dataset.id ? { id: tr.dataset.id } : {}),
  nombre: tr.querySelector('[data-k="nombre"]').value.trim(), costoHora: numOrNull(tr.querySelector('[data-k="costoHora"]').value) }));
function conectarMaquinasFr(card) {
  card.querySelector('.fr-agregar').onclick = () => card.querySelector('tbody').insertAdjacentHTML('beforeend', htmlFilaMaqFr());
  card.querySelector('tbody').onclick = e => quitarFilaFr(e, card);
  card.querySelector('.fr-guardar').onclick = () => guardarFr(card, '/maquinas', { maquinas: leerMaquinasFr(card) }, () => {
    actualizarSelectsMaquinaFr();
    return repintarFr('frMaquinas', htmlMaquinasFr, conectarMaquinasFr);
  });
}
// "Usada en" y el ✕ de cada máquina tras guardar un subrubro, sin repintar la tarjeta (no pisa lo que se esté tipeando ahí).
function actualizarUsosMaquinasFr() {
  const card = document.getElementById('frMaquinas');
  if (!card) return;
  cfFr.maquinas.forEach(m => {
    const tr = card.querySelector(`tbody tr[data-id="${CSS.escape(m.id)}"]`);
    if (!tr) return;
    tr.querySelector('.fr-usos').textContent = textoUsosFr(m.usos);
    tr.querySelector('.fr-q').innerHTML = htmlQuitarMaqFr(m.usos);
  });
}
const opcionesMaquinaFr = actual => `<option value="">Sin máquina</option>${cfFr.maquinas
  .map(m => `<option value="${esc(m.id)}"${m.id === actual ? ' selected' : ''}>${esc(m.nombre)}</option>`).join('')}`;
const textoResumenSubFr = id => `· ${resumenSubrubroFr(cfFr.subrubros[id], cfFr.maquinas)}`;
const textoPropiaFr = nombre => `· máquina propia: ${nombre}`;
// Máquinas nuevas o renombradas en los selects de los subrubros, en el resumen de cada subrubro y en las "máquina propia" de
// sus productos, sin tocar lo elegido (guardado o no) ni lo que se esté tipeando.
function actualizarSelectsMaquinaFr() {
  document.querySelectorAll('#frSubrubros .fr-sub-maquina').forEach(sel => {
    const v = sel.value;
    sel.innerHTML = opcionesMaquinaFr(v);
    sel.value = cfFr.maquinas.some(m => m.id === v) ? v : '';
  });
  document.querySelectorAll('#frSubrubros details[data-sub]').forEach(det => {
    det.querySelector('.fr-resumen').textContent = textoResumenSubFr(det.dataset.sub);
  });
  document.querySelectorAll('#frSubrubros .fr-propia').forEach(el => {
    const m = cfFr.maquinas.find(x => x.id === el.dataset.maq);
    if (m) el.textContent = textoPropiaFr(m.nombre);
  });
}

// ── Escalas ──
const htmlEscalasFr = () => `<div class="cfg-card min-w-0" data-guardable data-nombre="Escalas" id="frEscalas">
    <h3 class="cfg-h">Escalas</h3><p class="cfg-ayuda">Factores que multiplican los minutos base del tramo: el tiempo y la facilidad que se eligen para cada presentación en la tab Fraccionado. Sin elegir → × 1.</p>
    ${Object.entries(ESCALAS_FR).map(([tipo, ops]) => `<div class="mt-3"><div class="lbl">${tipo === 'facilidad' ? 'Facilidad' : 'Tiempo'}</div>
      <div class="flex flex-wrap gap-3 mt-1">${ops.map(([k, t]) => `<label class="text-sm">${t} ${campoU(`<input type="number" min="0" step="any" data-escala="${tipo}" data-k="${k}" value="${esc(cfFr.escalas[tipo][k])}" aria-label="Factor ${t} (${tipo})">`, '×', { w: 'w-24' })}</label>`).join('')}</div></div>`).join('')}
    ${pieFr('Guardar escalas')}</div>`;
const leerEscalasFr = card => ({ escalas: Object.fromEntries(Object.entries(ESCALAS_FR).map(([tipo, ops]) =>
  [tipo, Object.fromEntries(ops.map(([k]) => [k, numOrNull(card.querySelector(`[data-escala="${tipo}"][data-k="${k}"]`).value)]))])) });
function conectarEscalasFr(card) {
  card.querySelector('.fr-guardar').onclick = () => guardarFr(card, '/escalas', leerEscalasFr(card), () => repintarFr('frEscalas', htmlEscalasFr, conectarEscalasFr));
}

// ── Subrubros ──
const idDomFr = id => `frSub-${String(id).replace(/\W/g, '_')}`; // id de DOM: el subrubro viene de SIGA
const listaSubrubrosFr = () => subrubrosListaFr(cfFr.subrubrosSiga, cfFr.subrubros);
const htmlFilaTramoFr = (t = {}) => `<tr><td class="py-1 pr-2">${campoU(`<input type="number" min="1" step="1" data-k="hastaG" value="${esc(t.hastaG ?? '')}" aria-label="Hasta (g)">`, 'g', { w: 'w-28' })}</td>
  <td class="py-1 pr-2">${campoU(`<input type="number" min="0" step="any" data-k="minutos" value="${esc(t.minutos ?? '')}" aria-label="Minutos base por unidad">`, 'min', { w: 'w-28' })}</td>
  <td class="py-1"><button type="button" class="fr-quitar text-gris hover:text-crit" data-edita aria-label="Quitar">✕</button></td></tr>`;
const leerTramosFr = caja => [...caja.querySelectorAll('tbody tr')].map(tr => ({
  hastaG: numOrNull(tr.querySelector('[data-k="hastaG"]').value), minutos: numOrNull(tr.querySelector('[data-k="minutos"]').value) }));

// Granel con sus presentaciones (y la máquina propia si su modal le puso una). data-q = el texto que busca el buscador.
function htmlProductoFr(g) {
  const pres = g.presentaciones.map(p => p.nombre).join(', ');
  const propia = (cfFr.porGranel[g.plu] || {}).maquinaId;
  const nombreMaq = propia && (cfFr.maquinas.find(m => m.id === propia) || {}).nombre;
  return `<li data-q="${esc(`${g.nombre} ${pres}`)}">${esc(g.nombre)}${pres ? ` <span class="text-gris">(${esc(pres)})</span>` : ''}${
    nombreMaq ? ` <span class="fr-propia text-xs text-gris" data-maq="${esc(propia)}">${esc(textoPropiaFr(nombreMaq))}</span>` : ''}</li>`;
}
function htmlProductosFr(s) {
  const buscador = s.graneles.length > PRODUCTOS_PARA_BUSCAR
    ? `<input type="search" class="fr-buscar num-in text-left w-64 mt-1" placeholder="Buscar producto…" aria-label="Buscar producto de ${esc(s.nombre)}">` : '';
  return `<div class="lbl mt-1">Productos del subrubro</div>${buscador}
    <ul class="text-sm max-h-48 overflow-y-auto mt-1 space-y-0.5">${s.graneles.map(htmlProductoFr).join('') || '<li class="text-gris">Sin productos.</li>'}</ul>
    <p class="fr-nada hidden text-sm text-gris mt-1">Ningún producto coincide.</p>`;
}
function htmlSubrubroFr(s) {
  const guardado = cfFr.subrubros[s.id];
  const conf = guardado || { maquinaId: null, tramos: [] };
  const falta = faltaSubrubroFr(guardado);
  const estado = falta.length ? `<span class="px-1.5 py-0.5 rounded text-[11px] font-semibold bg-warn/15 text-warn">⚠ falta ${esc(falta.join(' y '))}</span>`
    : '<span class="px-1.5 py-0.5 rounded text-[11px] font-semibold bg-ok/15 text-ok">✔ completo</span>';
  return `<details class="border border-borde rounded-lg mt-2" id="${idDomFr(s.id)}" data-sub="${esc(s.id)}" data-guardable data-nombre="Subrubro ${esc(s.nombre)}"${abiertosFr.has(s.id) ? ' open' : ''}>
    <summary class="cursor-pointer px-3 py-2 text-sm flex flex-wrap items-center gap-2"><b>${esc(s.nombre)}</b>
      <span class="text-gris">${esc(cuentaProductosFr(s))}</span><span class="fr-resumen text-gris">${esc(textoResumenSubFr(s.id))}</span>
      <span class="ml-auto">${estado}</span></summary>
    <div class="px-3 pb-3">
      ${htmlProductosFr(s)}
      <div class="lbl mt-3">① Máquina</div>
      <select class="fr-sub-maquina num-in text-left mt-1" aria-label="Máquina del subrubro ${esc(s.nombre)}">${opcionesMaquinaFr(conf.maquinaId)}</select>
      <div class="lbl mt-3">② Tiempos por peso (minutos base por unidad)</div>
      <table class="cfg-tabla mt-1"><thead><tr><th class="text-left">Hasta</th><th class="text-left">Minutos</th><th></th></tr></thead>
        <tbody>${conf.tramos.map(htmlFilaTramoFr).join('')}</tbody></table>
      <button type="button" class="fr-agregar cfg-btn2 mt-2" data-edita>+ Agregar tramo</button>
      ${pieFr(`Guardar ${esc(s.nombre)}`)}</div></details>`;
}
function htmlSubrubrosFr() {
  const lista = listaSubrubrosFr();
  const filas = lista.length ? lista.map(htmlSubrubroFr).join('')
    : '<p class="text-sm text-gris mt-2">SIGA no devolvió subrubros para los graneles (rubro Pesables Deposito).</p>';
  const sin = cfFr.sinSubrubro.length ? `<details class="mt-3 text-sm"><summary class="cursor-pointer text-warn">⚠ ${cfFr.sinSubrubro.length} producto${cfFr.sinSubrubro.length === 1 ? '' : 's'} sin subrubro en SIGA: no suman mano de obra ni máquina</summary>
      <ul class="mt-1 text-gris">${cfFr.sinSubrubro.map(g => `<li>${esc(g.nombre)}</li>`).join('')}</ul></details>` : '';
  return filas + sin;
}
function conectarSubrubroFr(det) {
  const id = det.dataset.sub;
  det.ontoggle = () => (det.open ? abiertosFr.add(id) : abiertosFr.delete(id));
  const buscar = det.querySelector('.fr-buscar');
  if (buscar) buscar.oninput = () => filtrarProductosFr(det, buscar.value);
  det.querySelector('.fr-agregar').onclick = () => {
    const validos = leerTramosFr(det).filter(t => t.hastaG > 0);
    det.querySelector('tbody').insertAdjacentHTML('beforeend', htmlFilaTramoFr(conTramoFr(validos).pop()));
  };
  det.querySelector('tbody').onclick = e => quitarFilaFr(e, det);
  det.querySelector('.fr-guardar').onclick = () => guardarFr(det, `/subrubros/${encodeURIComponent(id)}`,
    { maquinaId: det.querySelector('.fr-sub-maquina').value || null, tramos: leerTramosFr(det) },
    () => {
      const s = listaSubrubrosFr().find(x => x.id === id);
      if (s) return repintarFr(det.id, () => htmlSubrubroFr(s), conectarSubrubroFr);
      det.remove(); // un subrubro que SIGA ya no trae y quedó sin configuración
      return null;
    });
}
function filtrarProductosFr(det, texto) {
  const filas = [...det.querySelectorAll('li[data-q]')];
  filas.forEach(li => li.classList.toggle('hidden', !coincideFr(li.dataset.q, texto)));
  det.querySelector('.fr-nada').classList.toggle('hidden', !filas.length || filas.some(li => !li.classList.contains('hidden')));
}
