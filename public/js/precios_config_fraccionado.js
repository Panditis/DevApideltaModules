// ── Precios · Configuración › Costeo Fraccionado (spec 2026-10-21-precios-fraccionado-costeo-design §2.5) ──
// Script clásico, después de precios_config_esquema.js y precios_produccion.js. Sub-tab sólo con el switch de Configuración en
// Fraccionado (mostrarCosteoFracc). Máquinas, tiempos por peso + factores de facilidad e insumos por subrubro × tramo de peso;
// cada tarjeta guarda con su botón (PUT /api/precios/config/esquema/fraccionado/…). La facilidad y la máquina de cada granel y
// los insumos propios de una presentación se eligen en el modal (precios_modal_fraccionado.js).
// Globales: esc, fmtMoney, numOrNull (precios_comun.js), campoU, marcarSucio (precios_config.js), pedirEsq,
// guardarBloqueEsq (precios_config_esquema.js), htmlBuscadorSiga, conectarBuscadorSiga (precios_produccion.js).
const API_FR = '/api/precios/config/esquema/fraccionado';
const FACILIDADES_FR = [['facil', 'Fácil'], ['medio', 'Medio'], ['dificil', 'Difícil']];
const TRAMO_INICIAL_G = 250;

// ── Borrador de insumos por subrubro (puro; test/precios_config_fraccionado_ui.test.js) ──
// borrador = { [subrubroId]: [{ hastaG, insumos: [{ plu, cantidad }] }] }. Cada función devuelve uno nuevo.
const tramosFr = (b, sub) => b[sub] || [];
const conTramosFr = (b, sub, tramos) => ({ ...b, [sub]: tramos });
// Tramo nuevo al final: el doble del último (o 250 g), sin insumos.
function conTramoFr(b, sub) {
  const ts = tramosFr(b, sub);
  return conTramosFr(b, sub, [...ts, { hastaG: ts.length ? ts[ts.length - 1].hastaG * 2 : TRAMO_INICIAL_G, insumos: [] }]);
}
const sinTramoFr = (b, sub, i) => conTramosFr(b, sub, tramosFr(b, sub).filter((_, k) => k !== i));
// Elegidos del buscador ([{ plu }]) al tramo i, cantidad 1, sin repetir los que ya están.
function conInsumosFr(b, sub, i, elegidos) {
  return conTramosFr(b, sub, tramosFr(b, sub).map((t, k) => {
    if (k !== i) return t;
    const ya = new Set(t.insumos.map(x => x.plu));
    return { ...t, insumos: [...t.insumos, ...elegidos.map(e => String(e.plu)).filter(plu => !ya.has(plu)).map(plu => ({ plu, cantidad: 1 }))] };
  }));
}
const sinInsumoFr = (b, sub, i, plu) => conTramosFr(b, sub, tramosFr(b, sub).map((t, k) => (k === i ? { ...t, insumos: t.insumos.filter(x => x.plu !== plu) } : t)));

if (typeof module === 'object' && module.exports) module.exports = { conTramoFr, sinTramoFr, conInsumosFr, sinInsumoFr };

// ── DOM ──
let cfFr = null;              // última respuesta de GET /costeo
let insFr = {};               // borrador de insumos por subrubro (al cambiar su forma se repinta la tarjeta entera)
const abiertosFr = new Set(); // ponytail: subrubros desplegados, estado de UI que se muta en el lugar
const nombresFr = {};         // nombre de los insumos recién elegidos (su costo se ve después de guardar)

// La llama activarSubConfig (precios_config.js), que corre al entrar a Configuración y cada vez que cambia el switch
// Reventa | Fraccionado: el sub-tab sólo existe con Fraccionado (si estaba abierto, activarSubConfig vuelve a Costos).
function mostrarCosteoFracc(tipo) {
  document.getElementById('tab-costeo-fracc').classList.toggle('hidden', tipo !== 'fraccionado');
}

async function cargarCosteoFracc() {
  const panel = document.getElementById('panel-costeo-fracc');
  panel.innerHTML = '<div class="text-sm text-ink/50 py-4"><span class="spin"></span> Cargando…</div>';
  try {
    cfFr = await pedirEsq('GET', `${API_FR}/costeo`);
    insFr = structuredClone(cfFr.insumosSubrubro);
    pintarCosteoFracc(panel);
  } catch (e) { panel.innerHTML = `<p class="text-sm text-crit py-4">No se pudo cargar: ${esc(e.message)}</p>`; }
}

const pieFr = txt => `<div class="cfg-pie"><span class="esq-msg text-sm" role="status" aria-live="polite"></span><button type="button" class="fr-guardar cfg-btn">${txt}</button></div>`;
function pintarCosteoFracc(panel) {
  panel.innerHTML = `<p class="cfg-cab"><b>Costeo de Fraccionado</b> — insumos, mano de obra y máquina de cada presentación, sumados al $/kg del granel.
      Minutos por unidad = tiempo del tramo de peso × factor de la facilidad del granel. La facilidad y la máquina de cada granel se eligen en su modal (Ver detalle).
      El costo hora de mano de obra está en Costos.</p>
    ${cfFr.migrado ? '' : '<p class="mb-4 p-3 rounded-lg bg-warn/10 text-warn text-sm">Fraccionado todavía usa la configuración de Reventa: corré <code>node scripts/migrar_config_fraccionado.js</code> para poder guardar.</p>'}
    <div class="grid gap-4 xl:grid-cols-2">${htmlMaquinasFr()}${htmlTiemposFr()}</div>
    <div class="mt-4" id="frInsumosCard">${htmlInsumosFr()}</div>`;
  conectarTablaFr(panel.querySelector('#frMaquinas'), htmlFilaMaqFr, card => guardarBloqueEsq(card, `${API_FR}/maquinas`, { maquinas: leerMaquinasFr(card) }, cargarCosteoFracc));
  conectarTablaFr(panel.querySelector('#frTiempos'), htmlFilaTiempoFr, card => guardarBloqueEsq(card, `${API_FR}/tiempos`, leerTiemposFr(card), cargarCosteoFracc));
  conectarInsumosFr();
}

// Tarjeta con tabla de filas: + Agregar, ✕ y Guardar.
function conectarTablaFr(card, htmlFila, guardar) {
  card.querySelector('.fr-agregar').onclick = () => card.querySelector('tbody').insertAdjacentHTML('beforeend', htmlFila());
  card.querySelector('tbody').onclick = e => { const b = e.target.closest('.fr-quitar'); if (b && !b.disabled) b.closest('tr').remove(); };
  card.querySelector('.fr-guardar').onclick = () => guardar(card);
}

// ── Máquinas ──
const htmlFilaMaqFr = (m = {}) => `<tr data-id="${esc(m.id || '')}">
  <td class="py-1 pr-2"><input class="num-in w-full text-left" data-k="nombre" maxlength="60" value="${esc(m.nombre || '')}" aria-label="Nombre de la máquina"></td>
  <td class="py-1 pr-2">${campoU(`<input type="number" min="0" step="any" data-k="costoHora" value="${esc(m.costoHora ?? '')}" aria-label="Costo por hora">`, '$/h', { w: 'w-32' })}</td>
  <td class="py-1 pr-2 text-xs text-gris">${m.usos ? `${m.usos} granel${m.usos === 1 ? '' : 'es'}` : 'sin uso'}</td>
  <td class="py-1"><button type="button" class="fr-quitar text-gris hover:text-crit disabled:opacity-30" data-edita aria-label="Quitar"${m.usos ? ' disabled title="En uso: asigná otra máquina a esos graneles antes de borrarla"' : ''}>✕</button></td></tr>`;
const htmlMaquinasFr = () => `<div class="cfg-card min-w-0" data-guardable data-nombre="Máquinas" id="frMaquinas">
    <h3 class="cfg-h">Máquinas</h3><p class="cfg-ayuda">Costo por hora de cada máquina (sin IVA). Por unidad suma minutos × costo hora ÷ 60. Una máquina en uso no se puede borrar.</p>
    <table class="cfg-tabla w-full mt-2"><thead><tr><th class="text-left">Nombre</th><th class="text-left">Costo hora</th><th class="text-left">Usada en</th><th></th></tr></thead>
      <tbody>${cfFr.maquinas.map(m => htmlFilaMaqFr(m)).join('')}</tbody></table>
    <button type="button" class="fr-agregar cfg-btn2 mt-2" data-edita>+ Agregar</button>${pieFr('Guardar')}</div>`;
const leerMaquinasFr = card => [...card.querySelectorAll('tbody tr')].map(tr => ({ ...(tr.dataset.id ? { id: tr.dataset.id } : {}),
  nombre: tr.querySelector('[data-k="nombre"]').value.trim(), costoHora: numOrNull(tr.querySelector('[data-k="costoHora"]').value) }));

// ── Tiempos y facilidad ──
const htmlFilaTiempoFr = (t = {}) => `<tr><td class="py-1 pr-2">${campoU(`<input type="number" min="1" step="1" data-k="hastaG" value="${esc(t.hastaG ?? '')}" aria-label="Hasta (g)">`, 'g', { w: 'w-28' })}</td>
  <td class="py-1 pr-2">${campoU(`<input type="number" min="0" step="any" data-k="minutos" value="${esc(t.minutos ?? '')}" aria-label="Minutos por unidad">`, 'min', { w: 'w-28' })}</td>
  <td class="py-1"><button type="button" class="fr-quitar text-gris hover:text-crit" data-edita aria-label="Quitar">✕</button></td></tr>`;
const htmlTiemposFr = () => `<div class="cfg-card min-w-0" data-guardable data-nombre="Tiempos y facilidad" id="frTiempos">
    <h3 class="cfg-h">Tiempos y facilidad</h3>
    <p class="cfg-ayuda">Minutos por unidad según el peso de la presentación: el primer tramo que la cubre (más pesada que el último → el último), × el factor de la facilidad del granel. Los usan la mano de obra y la máquina.</p>
    <table class="cfg-tabla w-full mt-2"><thead><tr><th class="text-left">Hasta</th><th class="text-left">Minutos por unidad</th><th></th></tr></thead>
      <tbody>${cfFr.tiempos.map(t => htmlFilaTiempoFr(t)).join('')}</tbody></table>
    <button type="button" class="fr-agregar cfg-btn2 mt-2" data-edita>+ Agregar tramo</button>
    <div class="flex flex-wrap gap-3 mt-4">${FACILIDADES_FR.map(([k, t]) => `<label class="text-sm">${t} ${campoU(`<input type="number" min="0" step="any" data-fac="${k}" value="${esc(cfFr.facilidades[k])}" aria-label="Factor ${t}">`, '×', { w: 'w-24' })}</label>`).join('')}</div>
    ${pieFr('Guardar')}</div>`;
const leerTiemposFr = card => ({
  tiempos: [...card.querySelectorAll('tbody tr')].map(tr => ({ hastaG: numOrNull(tr.querySelector('[data-k="hastaG"]').value), minutos: numOrNull(tr.querySelector('[data-k="minutos"]').value) })),
  facilidades: Object.fromEntries(FACILIDADES_FR.map(([k]) => [k, numOrNull(card.querySelector(`[data-fac="${k}"]`).value)])),
});

// ── Insumos por subrubro ──
const nombreInsumoFr = plu => (cfFr.insumos[plu] || {}).nombre || nombresFr[plu] || `PLU ${plu}`;
function costoInsumoFr(plu) {
  const x = cfFr.insumos[plu];
  if (!x) return '<span class="text-gris">al guardar</span>';
  return x.costo > 0 ? `$ ${fmtMoney(x.costo)}` : '<span class="text-crit">sin costo</span>';
}
const busIdFr = (sub, i) => `frBus-${String(sub).replace(/\W/g, '_')}-${i}`; // id de DOM: el subrubro viene de SIGA
const htmlInsumoFr = x => `<tr data-plu="${esc(x.plu)}"><td class="py-1 pr-2">${esc(nombreInsumoFr(x.plu))} <span class="text-gris text-xs">${esc(x.plu)}</span></td>
  <td class="py-1 pr-2">${campoU(`<input type="number" min="0" step="any" data-k="cantidad" value="${esc(x.cantidad ?? '')}" aria-label="Cantidad por unidad">`, 'u', { w: 'w-24' })}</td>
  <td class="py-1 pr-2 num">${costoInsumoFr(x.plu)}</td>
  <td class="py-1"><button type="button" class="fr-ins-quitar text-gris hover:text-crit" data-edita aria-label="Quitar insumo">✕</button></td></tr>`;
const htmlTramoInsFr = (sub, t, i) => `<div class="border border-borde rounded-lg p-2 mt-2" data-tramo="${i}">
    <div class="flex items-center gap-2 text-sm">Hasta ${campoU(`<input type="number" min="1" step="1" data-k="hastaG" value="${esc(t.hastaG ?? '')}" aria-label="Hasta (g)">`, 'g', { w: 'w-28' })}
      <button type="button" class="fr-tramo-quitar ml-auto text-xs text-gris hover:text-crit" data-edita>Quitar tramo</button></div>
    <table class="w-full text-sm mt-1"><tbody>${t.insumos.map(htmlInsumoFr).join('') || '<tr><td class="py-1 text-gris">Sin insumos en este tramo.</td></tr>'}</tbody></table>
    <div class="mt-1">${htmlBuscadorSiga(busIdFr(sub, i), 'Agregar insumos (nombre o PLU)')}</div></div>`;
function htmlInsumosFr() {
  const cuerpo = cfFr.subrubros.length ? cfFr.subrubros.map(s => {
    const ts = tramosFr(insFr, s.id);
    return `<details class="mt-2" data-sub="${esc(s.id)}"${abiertosFr.has(s.id) ? ' open' : ''}><summary class="cursor-pointer text-sm font-semibold">${esc(s.nombre)}
        <span class="text-gris font-normal">· ${s.graneles} granel${s.graneles === 1 ? '' : 'es'} · ${ts.length ? `${ts.length} tramo${ts.length === 1 ? '' : 's'}` : 'sin insumos'}</span></summary>
      ${ts.map((t, i) => htmlTramoInsFr(s.id, t, i)).join('')}
      <button type="button" class="fr-tramo-agregar cfg-btn2 mt-2" data-edita>+ Agregar tramo</button></details>`;
  }).join('') : '<p class="text-sm text-gris mt-2">SIGA no devolvió subrubros para los graneles (rubro Pesables Deposito).</p>';
  return `<div class="cfg-card min-w-0" data-guardable data-nombre="Insumos por subrubro">
    <h3 class="cfg-h">Insumos por subrubro</h3>
    <p class="cfg-ayuda">Insumos por unidad (bolsa, etiqueta…) según el subrubro del granel y el peso de la presentación (mismo criterio de tramos que los tiempos). Una presentación puede tener insumos propios desde su modal: esos reemplazan a la regla.</p>
    ${cuerpo}${pieFr('Guardar insumos')}</div>`;
}
// Lo tipeado (hasta g y cantidades) al borrador, antes de cambiarle la forma o de guardar.
function sincronizarInsumosFr(card) {
  card.querySelectorAll('details[data-sub]').forEach(d => {
    const sub = d.dataset.sub;
    insFr = conTramosFr(insFr, sub, tramosFr(insFr, sub).map((t, i) => {
      const caja = d.querySelector(`[data-tramo="${i}"]`);
      return { hastaG: numOrNull(caja.querySelector('[data-k="hastaG"]').value),
        insumos: t.insumos.map(x => ({ ...x, cantidad: numOrNull(caja.querySelector(`tr[data-plu="${CSS.escape(x.plu)}"] [data-k="cantidad"]`).value) })) };
    }));
  });
}
function conectarInsumosFr() {
  const caja = document.getElementById('frInsumosCard');
  const card = caja.firstElementChild;
  const repintar = cambio => {
    sincronizarInsumosFr(card);
    insFr = cambio(insFr);
    caja.innerHTML = htmlInsumosFr();
    marcarSucio(caja.firstElementChild);
    conectarInsumosFr();
  };
  card.querySelectorAll('details[data-sub]').forEach(d => {
    const sub = d.dataset.sub;
    d.ontoggle = () => (d.open ? abiertosFr.add(sub) : abiertosFr.delete(sub));
    d.querySelector('.fr-tramo-agregar').onclick = () => repintar(b => conTramoFr(b, sub));
    d.querySelectorAll('[data-tramo]').forEach(t => {
      const i = Number(t.dataset.tramo);
      t.querySelector('.fr-tramo-quitar').onclick = () => repintar(b => sinTramoFr(b, sub, i));
      t.querySelectorAll('.fr-ins-quitar').forEach(x => { x.onclick = () => repintar(b => sinInsumoFr(b, sub, i, x.closest('tr').dataset.plu)); });
      conectarBuscadorSiga(busIdFr(sub, i), elegidos => {
        elegidos.forEach(e => { nombresFr[e.plu] = e.nombre; });
        repintar(b => conInsumosFr(b, sub, i, elegidos));
      }, { multiple: true });
    });
  });
  card.querySelector('.fr-guardar').onclick = () => {
    sincronizarInsumosFr(card);
    guardarBloqueEsq(card, `${API_FR}/insumos-subrubro`, { insumosSubrubro: insFr }, cargarCosteoFracc);
  };
}
