// ── Precios · Configuración › Costeo Fraccionado (specs 2026-10-21-precios-fraccionado-costeo-design §9.3,
// 2026-10-23-precios-fraccionado-peso-subrubro-design §6 y 2026-10-29-precios-fraccionado-tiempos-historial-design) ──
// Script clásico, después de precios_config_esquema.js y precios_produccion.js. Sub-tab sólo con el switch de Configuración en
// Fraccionado (mostrarCosteoFracc). Minutos por unidad = (min/kg + ajuste del tramo) × kg de la presentación. Arriba una barra de
// estado (qué falta) que lleva a cada tarjeta; después "Ajuste por tramo de peso" (± min/kg global según el peso; el tramo que
// cubre 1 kg es la base y queda fija en 0), Máquinas (costo hora; cada producto elige la suya en su modal), los subrubros de SIGA
// (una fila por subrubro con su "Min por kg"; un solo Guardar para toda la tarjeta, que sólo manda lo que cambió), los insumos por
// peso de presentación (globales: valen para toda presentación de ese peso) y el ajuste de margen por peso (puntos de margen de
// los tres canales según el peso de la presentación; se editaba en Márgenes). Cada tarjeta guarda con su botón (PUT
// /api/precios/config/esquema/fraccionado/…) y se repinta sólo ella: lo que las otras tengan sin guardar queda. Los insumos de
// un peso se guardan al aceptar su diálogo (#dlgFP). El min/kg y la máquina propios de un granel, en su modal. Estilos: bloque
// "Costeo Fraccionado" de precios.html (.fr-*).
// Globales: esc, numOrNull, fmtMoney (precios_comun.js), campoU, marcarSucio, limpiarSucio (precios_config.js), pedirEsq,
// msgEsq, esFraccCfg (precios_config_esquema.js), htmlBuscadorSiga, conectarBuscadorSiga (precios_produccion.js), PreciosEsquema
// (/js/precios_esquema.js: generarAjustesPeso, AJUSTES_PESO_MAX).
const API_FR = '/api/precios/config/esquema/fraccionado';
// Espejo de los límites del servidor (lib/precios_config_fraccionado.js y lib/precios_fraccionado_costo.js): el servidor valida igual.
const MIN_KG_MAX_FR = 600;
const MAX_TRAMOS_FR = 20;
const BASE_G_FR = 1000; // el tramo que cubre 1 kg es la base de la tabla y vale 0
const TRAMO_INICIAL_G = 250;
const PRODUCTOS_PARA_BUSCAR = 8; // desde acá la lista de productos de un subrubro trae buscador

// ── Puros (test/precios_config_fraccionado_ui.test.js) ──
// Tramo nuevo al final: el doble del último (o 250 g), sin ajuste cargado.
const conTramoFr = tramos => [...tramos, { hastaG: tramos.length ? tramos[tramos.length - 1].hastaG * 2 : TRAMO_INICIAL_G, minKg: null }];
// Cuál es la base de la tabla (hastas = los "hasta" en orden): el primer tramo que cubre 1 kg, o el último si ninguno llega; -1 sin tramos.
const indiceBaseFr = hastas => { const i = hastas.findIndex(g => g >= BASE_G_FR); return i >= 0 ? i : hastas.length - 1; };
// Espejo de validarTramosTiempo (lib/precios_config_fraccionado.js). tramos = [{ hastaG, minKg }] leídos de la tabla (null = vacío).
// null si está bien; si no { fila (0 = primera, null = la tabla), campo, mensaje } para marcar dónde.
function errorTramosFr(tramos) {
  if (tramos.length > MAX_TRAMOS_FR) return { fila: null, campo: null, mensaje: `Máximo ${MAX_TRAMOS_FR} tramos` };
  let previo = 0;
  for (const [i, t] of tramos.entries()) {
    if (!Number.isInteger(t.hastaG) || t.hastaG <= previo) return { fila: i, campo: 'hastaG', mensaje: `Tramo ${i + 1}: "Hasta" tiene que ser un entero de gramos, mayor que el del tramo anterior` };
    previo = t.hastaG;
    if (typeof t.minKg !== 'number' || !(Math.abs(t.minKg) <= MIN_KG_MAX_FR)) return { fila: i, campo: 'minKg', mensaje: `Tramo ${i + 1}: el ajuste es un número de -${MIN_KG_MAX_FR} a ${MIN_KG_MAX_FR} min/kg (0 si no cambia)` };
  }
  const b = indiceBaseFr(tramos.map(t => t.hastaG));
  return b >= 0 && tramos[b].minKg !== 0 ? { fila: b, campo: 'minKg', mensaje: `El tramo de ${BASE_G_FR} g (hasta ${tramos[b].hastaG} g) es la base y tiene que valer 0` } : null;
}

// Min/kg guardado de un subrubro (guardados = { [id]: { minKg } }); null = sin valor (0 es un valor).
const minKgGuardadoFr = (guardados, id) => { const g = (guardados || {})[id]; return g && g.minKg != null ? g.minKg : null; };
const subrubrosSinMinKgFr = (lista, guardados) => lista.filter(s => minKgGuardadoFr(guardados, s.id) == null);
// Filas leídas [{ id, valor: número | null (vacío) }] contra lo guardado → sólo lo que cambió, { [id]: número | null } (null saca el valor).
const cambiosSubrubrosFr = (filas, guardados) => Object.fromEntries(filas.filter(f => f.valor !== minKgGuardadoFr(guardados, f.id)).map(f => [f.id, f.valor]));
// Espejo de aplicarSubrubros: null si todo está en 0 a 600 (o null = sacar); si no, el mensaje del primero que no (nombres = { [id]: nombre }).
function errorSubrubrosFr(cambios, nombres = {}) {
  const mal = Object.entries(cambios).find(([, v]) => v != null && !(v >= 0 && v <= MIN_KG_MAX_FR));
  return mal ? `${nombres[mal[0]] || `Subrubro ${mal[0]}`}: el min por kg es un número de 0 a ${MIN_KG_MAX_FR}` : null;
}
function cuentaProductosFr(s) {
  const n = s.graneles.length, m = s.graneles.reduce((t, g) => t + g.presentaciones.length, 0);
  return `${n} producto${n === 1 ? '' : 's'} · ${m} presentaci${m === 1 ? 'ón' : 'ones'}`;
}
// "Usada en" de una máquina (usos = { graneles }): una máquina en uso no se borra.
const textoUsosFr = u => (u && u.graneles ? `en uso por ${u.graneles} granel${u.graneles === 1 ? '' : 'es'}` : 'sin uso');
// Buscador de productos: todas las palabras del texto buscado están en el texto del producto, sin mayúsculas ni tildes.
const sinTildesFr = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const coincideFr = (texto, busqueda) => sinTildesFr(busqueda).split(/\s+/).filter(Boolean).every(p => sinTildesFr(texto).includes(p));
// Subrubros de SIGA + los que tienen configuración pero SIGA ya no trae: sin esa fila su valor no se podría sacar.
const subrubrosListaFr = (siga, configurados) => [...siga, ...Object.keys(configurados || {}).filter(id => !siga.some(s => s.id === id))
  .map(id => ({ id, nombre: `Subrubro ${id} (ya no tiene productos en SIGA)`, graneles: [] }))];
// Insumos por peso: elegidos del buscador SIGA a la lista del diálogo, cantidad 1, sin repetir.
const conInsumosFr = (lista, elegidos) => [...lista,
  ...elegidos.filter(e => !lista.some(x => x.plu === String(e.plu))).map(e => ({ plu: String(e.plu), nombre: e.nombre, cantidad: 1 }))];
// El servidor exige cantidad > 0 en cada insumo: se avisa en el diálogo, no con el PUT rechazado.
const errorInsumosFr = lista => {
  const malo = lista.find(x => !(x.cantidad > 0));
  return malo ? `Cantidad mayor que 0 en "${malo.nombre || malo.plu}"` : null;
};
// Costo de los insumos por unidad = Σ cantidad × costo (de su tab); null si alguno no tiene costo.
const costoUnidadFr = insumos => ((insumos || []).some(i => i.costo == null) ? null
  : Math.round((insumos || []).reduce((s, i) => s + i.cantidad * i.costo, 0) * 100) / 100);
// Filas de la tarjeta: los pesos del universo (pesos del GET /costeo) + los configurados que ya no tienen presentaciones (0),
// ascendente, cada uno con sus insumos (insumosPorPeso: claves string).
const filasPesosFr = (pesos, insumosPorPeso) => {
  const ipp = insumosPorPeso || {}, n = new Map((pesos || []).map(p => [Number(p.pesoG), p.presentaciones]));
  return [...new Set([...n.keys(), ...Object.keys(ipp).map(Number)])].sort((a, b) => a - b)
    .map(pesoG => ({ pesoG, presentaciones: n.get(pesoG) || 0, insumos: ipp[pesoG] || [] }));
};
// "250 g" / "1 kg" (kilos enteros en kg), "34 presentaciones", y los dos juntos: "250 g · 34 presentaciones".
const pesoCortoFr = pesoG => (pesoG % 1000 ? `${pesoG} g` : `${pesoG / 1000} kg`);
const presentacionesFr = n => (n ? `${n} presentaci${n === 1 ? 'ón' : 'ones'}` : 'sin presentaciones');
const textoPesoFr = ({ pesoG, presentaciones: n }) => `${pesoCortoFr(pesoG)} · ${presentacionesFr(n)}`;
// Estado de los pesos (filas de filasPesosFr): cuántos tienen insumos y a cuántos les falta el costo de algún insumo.
const estadoPesosFr = filas => ({ total: filas.length, conInsumos: filas.filter(f => f.insumos.length).length,
  sinCosto: filas.filter(f => f.insumos.length && costoUnidadFr(f.insumos) == null).length });
// "2 tramos" o "sin ajuste": del ajuste de margen por peso ({ tramosG, puntos } | null) y de la tabla de tramos de tiempo ([{ hastaG, minKg }]).
const textoNTramosFr = n => (n ? `${n} tramo${n === 1 ? '' : 's'}` : 'sin ajuste');
const textoAjustesPesoFr = aj => textoNTramosFr(aj && Array.isArray(aj.tramosG) ? aj.tramosG.length : 0);
const textoTramosTiempoFr = tramos => textoNTramosFr((tramos || []).length);
// Las cinco partes de la barra de arriba: id de su tarjeta, texto y estado (ok | falta | info). Máquina y tramos son opcionales: no faltan.
function estadoConfigFr(maquinas, lista, configurados, filas, ajustesPeso, tramosTiempo) {
  const faltan = subrubrosSinMinKgFr(lista, configurados).length, p = estadoPesosFr(filas), s = lista.length;
  return [
    { id: 'frTramos', titulo: 'Tramos de peso', texto: textoTramosTiempoFr(tramosTiempo), estado: 'info' },
    { id: 'frMaquinas', titulo: 'Máquinas', texto: maquinas.length ? `${maquinas.length} cargada${maquinas.length === 1 ? '' : 's'}` : 'ninguna cargada', estado: maquinas.length ? 'ok' : 'info' },
    { id: 'frSubrubrosCard', titulo: 'Subrubros', texto: s ? `${s - faltan} de ${s} con min/kg` : 'sin subrubros', estado: !s ? 'info' : faltan ? 'falta' : 'ok' },
    { id: 'frPesos', titulo: 'Insumos por peso', texto: !p.total ? 'sin pesos' : p.sinCosto ? `${p.sinCosto} sin costo` : `${p.conInsumos} de ${p.total} pesos con insumos`, estado: p.sinCosto ? 'falta' : 'info' },
    { id: 'frAjustes', titulo: 'Margen por peso', texto: textoAjustesPesoFr(ajustesPeso), estado: 'info' },
  ];
}

if (typeof module === 'object' && module.exports) module.exports = { conTramoFr, indiceBaseFr, errorTramosFr, subrubrosSinMinKgFr, cambiosSubrubrosFr,
  errorSubrubrosFr, cuentaProductosFr, textoUsosFr, coincideFr, subrubrosListaFr, conInsumosFr, errorInsumosFr, costoUnidadFr, filasPesosFr,
  textoPesoFr, pesoCortoFr, estadoPesosFr, estadoConfigFr, textoAjustesPesoFr, textoTramosTiempoFr };

// ── DOM ──
let cfFr = null;              // GET /costeo: config (maquinas, tramosTiempo, subrubros, porGranel, insumosPorPeso con nombre y costo)
                              // + productos (subrubrosSiga, sinSubrubro, pesos)
const abiertosFr = new Set(); // ponytail: subrubros con la lista de productos abierta, estado de UI que se muta en el lugar
let soloFaltaFr = false;      // ponytail: filtro "solo los que faltan" de la tarjeta de subrubros; se conserva al repintarla

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
// se repinta sólo lo guardado (repintar devuelve el bloque nuevo). Las otras tarjetas y su data-sucio quedan como están. Su
// insumosPorPeso viene crudo (sin nombre ni costo): queda el del GET /costeo.
async function guardarFr(bloque, ruta, body, repintar) {
  const msg = bloque.querySelector('.esq-msg'), boton = bloque.querySelector('.fr-guardar');
  const teniaFoco = document.activeElement === boton; // el bloque se repinta: sin esto el foco del teclado se pierde
  msgEsq(msg, 'Guardando…');
  boton.disabled = true; // un segundo click mientras se guarda mandaría el mismo PUT dos veces
  try {
    const { insumosPorPeso: _crudo, ...vista } = await pedirEsq('PUT', `${API_FR}${ruta}`, body);
    cfFr = { ...cfFr, ...vista };
    avisoFr(cfFr.migrado);
    limpiarSucio(bloque);
    const nuevo = repintar();
    msgEsq(nuevo && nuevo.querySelector('.esq-msg'), 'Guardado', 'text-ok');
    if (teniaFoco && nuevo) nuevo.querySelector('.fr-guardar').focus();
    actualizarUsosMaquinasFr();
    actualizarEstadoFr();
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
const CABECERA_FR = `<p class="cfg-cab"><b>Costeo de Fraccionado</b> — mano de obra, máquina e insumos de cada presentación, sumados al $/kg del granel.
    Minutos por unidad = (min/kg + ajuste del tramo) × kg de la presentación; el costo hora de mano de obra está en Costos.</p>
  <p class="cfg-cab">Orden de uso sugerido: primero la tabla de tramos, después los min/kg de los subrubros y, sólo para un producto puntual, pisar su min/kg
    desde el listado (el del producto reemplaza al del subrubro; el ajuste del tramo se suma igual).</p>`;
function pintarCosteoFracc(panel) {
  panel.innerHTML = `${CABECERA_FR}
    <div id="frEstado" class="fr-barra flex-wrap" role="group" aria-label="Estado de la configuración">${htmlEstadoFr()}</div>
    <div class="grid gap-4 xl:grid-cols-2">${htmlTramosFr()}${htmlMaquinasFr()}</div>
    ${htmlSubrubrosCardFr()}
    ${htmlPesosFr()}
    ${htmlAjustesPesoFr()}`;
  panel.querySelector('#frEstado').onclick = e => { const b = e.target.closest('[data-ancla]'); if (b) irAnclaFr(b.dataset.ancla); };
  conectarTramosFr(panel.querySelector('#frTramos'));
  conectarMaquinasFr(panel.querySelector('#frMaquinas'));
  conectarSubrubrosFr(panel.querySelector('#frSubrubrosCard'));
  conectarPesosFr(panel.querySelector('#frPesos'));
  conectarAjustesPesoFr(panel.querySelector('#frAjustes'));
}

// ── Barra de estado: qué falta de cada parte; cada una lleva a su tarjeta ──
const ICONO_ESTADO_FR = { ok: '✔', falta: '⚠', info: '–' };
const listaSubrubrosFr = () => subrubrosListaFr(cfFr.subrubrosSiga, cfFr.subrubros);
const estadoActualFr = () => estadoConfigFr(cfFr.maquinas, listaSubrubrosFr(), cfFr.subrubros, filasPesosFr(cfFr.pesos, cfFr.insumosPorPeso), cfFr.ajustesPeso, cfFr.tramosTiempo);
const htmlEstadoFr = () => estadoActualFr().map(p => `<button type="button" class="fr-est" data-ancla="${p.id}" data-estado="${p.estado}">
  <span class="fr-est-ico" aria-hidden="true">${ICONO_ESTADO_FR[p.estado]}</span><span><b>${esc(p.titulo)}</b><span class="fr-est-txt">${esc(p.texto)}</span></span></button>`)
  .join('<span class="cfg-chev" aria-hidden="true">›</span>');
const faltanSubrubrosFr = () => subrubrosSinMinKgFr(listaSubrubrosFr(), cfFr.subrubros).length;
// Tras guardar algo: la barra y el contador del filtro de subrubros, sin repintar las tarjetas.
function actualizarEstadoFr() {
  const barra = document.getElementById('frEstado'), n = document.getElementById('frFaltan');
  if (!barra) return;
  barra.innerHTML = htmlEstadoFr();
  n.textContent = n.dataset.n = faltanSubrubrosFr();
}
function irAnclaFr(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

// ── Ajuste por tramo de peso ──
// Tabla global hastaG → ± min/kg (puede ser negativo): se suma al min/kg del subrubro o del producto, por kilo. La base (el primer tramo
// que cubre 1 kg) va fija en 0 y sin editar; al tipear un "hasta", agregar o quitar un tramo la base se recalcula (actualizarBaseFr).
// Guarda con PUT /tramos-tiempo { tramos: [{ hastaG, minKg }] } ([] vacía la tabla).
const htmlAjusteTramoFr = (minKg, esBase) => `${campoU(`<input type="number" min="-${MIN_KG_MAX_FR}" max="${MIN_KG_MAX_FR}" step="any" data-k="minKg" value="${esBase ? 0 : esc(minKg ?? '')}"${esBase ? ' disabled' : ''} aria-label="Ajuste en minutos por kilo${esBase ? ' (base, siempre 0)' : ''}">`, 'min/kg', { w: 'w-32' })}${
  esBase ? '<span class="fp-chip ml-2">base</span>' : ''}`;
const htmlFilaTramoFr = (t = {}, esBase = false) => `<tr data-base="${esBase}"><td class="py-1 pr-2">${campoU(`<input type="number" min="1" step="1" data-k="hastaG" value="${esc(t.hastaG ?? '')}" aria-label="Hasta (g)">`, 'g', { w: 'w-28' })}</td>
  <td class="fr-t-ajuste py-1 pr-2">${htmlAjusteTramoFr(t.minKg, esBase)}</td>
  <td class="py-1"><button type="button" class="fr-quitar btn-quitar" data-edita aria-label="Quitar tramo">✕</button></td></tr>`;
function htmlTramosFr() {
  const tramos = cfFr.tramosTiempo || [], base = indiceBaseFr(tramos.map(t => t.hastaG));
  return `<div class="cfg-card fr-card fr-ancla min-w-0" data-guardable data-nombre="Ajuste por tramo de peso" id="frTramos"><div class="fr-cuerpo">
    <h3 class="cfg-h">Ajuste por tramo de peso</h3>
    <p class="cfg-ayuda">Minutos por kilo que se suman (o se restan, con signo −) al min/kg según el peso de la presentación: minutos por unidad = (min/kg + ajuste del tramo) × kg de la presentación.
      El ajuste es por kilo: con +3 en el tramo de 250 g, fraccionar 1 kg en bolsas de 250 g tarda +3 min en total. Se usa el primer tramo cuyo "hasta" alcanza al peso;
      más pesado que el último usa el último.</p>
    <p class="cfg-ayuda">El tramo que cubre 1 kg es la base: vale 0 y los demás se miden contra él. Sin tramos = sin ajuste.
      Cambiar la tabla cambia los minutos de todas las presentaciones: cargala antes que los subrubros.</p>
    <table class="cfg-tabla fr-filas w-full"><thead><tr><th scope="col" class="text-left">Hasta</th><th scope="col" class="text-left">± min/kg</th><th scope="col"><span class="sr-only">Quitar</span></th></tr></thead>
      <tbody>${tramos.map((t, i) => htmlFilaTramoFr(t, i === base)).join('')}</tbody></table>
    <p class="fr-vacio">Sin tramos: el tiempo no se ajusta por peso.</p>
    <button type="button" class="fr-agregar cfg-btn2 mt-2" data-edita>+ Agregar tramo</button></div>${pieFr('Guardar tramos')}</div>`;
}
const leerTramosFr = card => [...card.querySelectorAll('tbody tr')].map(tr => ({
  hastaG: numOrNull(tr.querySelector('[data-k="hastaG"]').value), minKg: numOrNull(tr.querySelector('[data-k="minKg"]').value) }));
// Marca la base (el primer tramo que cubre 1 kg): su ajuste pasa a 0 fijo y sin editar; el que deja de serlo se vuelve editable.
function actualizarBaseFr(card) {
  const filas = [...card.querySelectorAll('tbody tr')];
  const base = indiceBaseFr(filas.map(tr => numOrNull(tr.querySelector('[data-k="hastaG"]').value) ?? 0));
  filas.forEach((tr, i) => {
    if (tr.dataset.base === String(i === base)) return;
    tr.dataset.base = String(i === base);
    tr.querySelector('.fr-t-ajuste').innerHTML = htmlAjusteTramoFr(numOrNull(tr.querySelector('[data-k="minKg"]').value), i === base);
  });
}
function guardarTramosFr(card) {
  const tramos = leerTramosFr(card), error = errorTramosFr(tramos);
  if (error) return avisarErrorTramosFr(card, error);
  return guardarFr(card, '/tramos-tiempo', { tramos }, () => repintarFr('frTramos', htmlTramosFr, conectarTramosFr));
}
// El error del cliente va al mensaje de la tarjeta y el foco al campo que hay que corregir.
function avisarErrorTramosFr(card, { fila, campo, mensaje }) {
  msgEsq(card.querySelector('.esq-msg'), mensaje, 'text-crit');
  const tr = fila == null ? null : card.querySelectorAll('tbody tr')[fila];
  if (tr) tr.querySelector(`[data-k="${campo}"]`).focus();
}
function conectarTramosFr(card) {
  const tbody = card.querySelector('tbody');
  card.querySelector('.fr-agregar').onclick = () => {
    if (tbody.children.length >= MAX_TRAMOS_FR) return msgEsq(card.querySelector('.esq-msg'), `Máximo ${MAX_TRAMOS_FR} tramos`, 'text-crit');
    tbody.insertAdjacentHTML('beforeend', htmlFilaTramoFr(conTramoFr(leerTramosFr(card).filter(t => t.hastaG > 0)).pop()));
    actualizarBaseFr(card);
  };
  tbody.oninput = e => { if (e.target.matches('[data-k="hastaG"]')) actualizarBaseFr(card); };
  tbody.onclick = e => { quitarFilaFr(e, card); actualizarBaseFr(card); };
  card.querySelector('.fr-guardar').onclick = () => guardarTramosFr(card);
}

// ── Máquinas ──
const enUsoFr = u => !!u && u.graneles > 0;
const htmlQuitarMaqFr = usos => `<button type="button" class="fr-quitar btn-quitar disabled:opacity-30" data-edita aria-label="Quitar máquina"${enUsoFr(usos) ? ' disabled title="En uso: asigná otra máquina a esos productos antes de borrarla"' : ''}>✕</button>`;
const htmlFilaMaqFr = (m = {}) => `<tr data-id="${esc(m.id || '')}">
  <td class="py-1 pr-3"><input class="num-in w-full text-left" data-k="nombre" maxlength="60" value="${esc(m.nombre || '')}" aria-label="Nombre de la máquina"></td>
  <td class="py-1 pr-3">${campoU(`<input type="number" min="0" step="any" data-k="costoHora" value="${esc(m.costoHora ?? '')}" aria-label="Costo por hora">`, '$/h', { w: 'w-32' })}</td>
  <td class="fr-usos py-1 pr-3 text-xs text-gris">${esc(textoUsosFr(m.usos))}</td>
  <td class="fr-q py-1">${htmlQuitarMaqFr(m.usos)}</td></tr>`;
const htmlMaquinasFr = () => `<div class="cfg-card fr-card fr-ancla min-w-0" data-guardable data-nombre="Máquinas" id="frMaquinas"><div class="fr-cuerpo">
    <h3 class="cfg-h">Máquinas</h3><p class="cfg-ayuda">Costo por hora de cada máquina (sin IVA). Cada producto elige la suya (o ninguna) desde su modal; por unidad suma minutos × costo hora ÷ 60, con los mismos minutos que la mano de obra. Una máquina en uso no se puede borrar.</p>
    <table class="cfg-tabla w-full"><thead><tr><th scope="col" class="text-left">Nombre</th><th scope="col" class="text-left">Costo hora</th><th scope="col" class="text-left">Usada en</th><th scope="col"><span class="sr-only">Quitar</span></th></tr></thead>
      <tbody>${cfFr.maquinas.map(m => htmlFilaMaqFr(m)).join('')}</tbody></table>
    <p class="fr-vacio">Todavía no hay máquinas: agregá una para poder asignarla a los productos.</p>
    <button type="button" class="fr-agregar cfg-btn2 mt-2" data-edita>+ Agregar máquina</button></div>${pieFr('Guardar máquinas')}</div>`;
const leerMaquinasFr = card => [...card.querySelectorAll('tbody tr')].map(tr => ({ ...(tr.dataset.id ? { id: tr.dataset.id } : {}),
  nombre: tr.querySelector('[data-k="nombre"]').value.trim(), costoHora: numOrNull(tr.querySelector('[data-k="costoHora"]').value) }));
function conectarMaquinasFr(card) {
  card.querySelector('.fr-agregar').onclick = () => card.querySelector('tbody').insertAdjacentHTML('beforeend', htmlFilaMaqFr());
  card.querySelector('tbody').onclick = e => quitarFilaFr(e, card);
  card.querySelector('.fr-guardar').onclick = () => guardarFr(card, '/maquinas', { maquinas: leerMaquinasFr(card) }, () => {
    actualizarMaquinasPropiasFr();
    return repintarFr('frMaquinas', htmlMaquinasFr, conectarMaquinasFr);
  });
}
// "Usada en" y el ✕ de cada máquina tras guardar otra tarjeta, sin repintar la de máquinas (no pisa lo que se esté tipeando ahí).
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
const textoPropiaFr = nombre => `máquina propia: ${nombre}`;
// Máquinas renombradas en las "máquina propia" de los productos de los subrubros, sin tocar lo que se esté tipeando.
function actualizarMaquinasPropiasFr() {
  document.querySelectorAll('#frSubrubros .fr-propia').forEach(el => {
    const m = cfFr.maquinas.find(x => x.id === el.dataset.maq);
    if (m) el.textContent = textoPropiaFr(m.nombre);
  });
}

// ── Subrubros ──
// Una fila por subrubro de SIGA con UN input "Min por kg" (vacío = sin valor) y la lista de sus productos (los que pisan el min/kg o
// la máquina lo muestran). Un Guardar para toda la tarjeta: PUT /subrubros { subrubros: { [id]: número | null } } sólo con los ids que
// cambiaron (vaciar un campo con valor manda null). Repintar la tarjeta conserva el filtro y las listas abiertas.
// Granel con sus presentaciones, su min/kg propio y la máquina propia si su modal le puso. data-q = el texto que busca el buscador.
function htmlProductoFr(g) {
  const pres = g.presentaciones.map(p => p.nombre).join(', ');
  const { maquinaId: propia, minKg } = cfFr.porGranel[g.plu] || {};
  const nombreMaq = propia && (cfFr.maquinas.find(m => m.id === propia) || {}).nombre;
  return `<li data-q="${esc(`${g.nombre} ${pres}`)}"><span class="fr-prod-nom">${esc(g.nombre)}</span>${
    minKg != null ? `<span class="fp-chip ml-2 text-[11px]">propio: ${esc(String(minKg).replace('.', ','))} min/kg</span>` : ''}${
    nombreMaq ? `<span class="fr-propia" data-maq="${esc(propia)}">${esc(textoPropiaFr(nombreMaq))}</span>` : ''}${pres ? `<span class="fr-prod-pres">${esc(pres)}</span>` : ''}</li>`;
}
function htmlProductosFr(s) {
  const buscador = s.graneles.length > PRODUCTOS_PARA_BUSCAR
    ? `<input type="search" class="fr-buscar num-in text-left w-full mb-2" placeholder="Buscar producto…" aria-label="Buscar producto de ${esc(s.nombre)}">` : '';
  return `${buscador}<ul class="fr-prod">${s.graneles.map(htmlProductoFr).join('')}</ul>
    <p class="fr-nada hidden text-sm text-gris mt-1">Ningún producto coincide.</p>`;
}
const htmlListaProductosFr = s => (s.graneles.length
  ? `<details class="max-w-[32rem]" data-prods="${esc(s.id)}"${abiertosFr.has(s.id) ? ' open' : ''}><summary class="cursor-pointer text-gris">${esc(cuentaProductosFr(s))}</summary>
      <div class="mt-2">${htmlProductosFr(s)}</div></details>`
  : `<span class="text-gris">${esc(cuentaProductosFr(s))}</span>`);
function htmlSubrubroFr(s) {
  const minKg = minKgGuardadoFr(cfFr.subrubros, s.id), tiene = minKg != null;
  return `<tr data-falta="${tiene ? 0 : 1}"${soloFaltaFr && tiene ? ' class="hidden"' : ''}>
    <td class="font-semibold">${esc(s.nombre)}</td><td>${htmlListaProductosFr(s)}</td>
    <td>${campoU(`<input type="number" min="0" max="${MIN_KG_MAX_FR}" step="any" data-id="${esc(s.id)}" value="${esc(minKg ?? '')}" aria-label="Min por kg de ${esc(s.nombre)}">`, 'min/kg', { w: 'w-32' })}</td>
    <td class="whitespace-nowrap text-xs ${tiene ? 'text-ok' : 'text-warn font-semibold'}">${tiene ? '✔ con valor' : '⚠ sin valor'}</td></tr>`;
}
function htmlSubrubrosFr() {
  const lista = listaSubrubrosFr();
  const tabla = lista.length ? `<table class="cfg-tabla fr-filas w-full"><thead><tr><th scope="col" class="text-left">Subrubro</th><th scope="col" class="text-left">Productos</th>
      <th scope="col" class="text-left">Min por kg</th><th scope="col" class="text-left">Estado</th></tr></thead><tbody>${lista.map(htmlSubrubroFr).join('')}</tbody></table>
    <p class="fr-sin-faltan hidden mt-2 text-sm font-semibold text-ok" role="status">Todos los subrubros tienen min/kg.</p>`
    : '<p class="text-sm text-gris mt-2">SIGA no devolvió subrubros para los graneles (rubro Pesables Deposito).</p>';
  const sin = cfFr.sinSubrubro.length ? `<details class="mt-3 text-sm"><summary class="cursor-pointer text-warn">⚠ ${cfFr.sinSubrubro.length} producto${cfFr.sinSubrubro.length === 1 ? '' : 's'} sin subrubro en SIGA: sólo suman mano de obra y máquina si tienen su propio min/kg</summary>
      <ul class="mt-1 text-gris">${cfFr.sinSubrubro.map(g => `<li>${esc(g.nombre)}</li>`).join('')}</ul></details>` : '';
  return tabla + sin;
}
// Tarjeta: título, ayuda, filtro "solo los que faltan" y la tabla.
function htmlSubrubrosCardFr() {
  const faltan = faltanSubrubrosFr();
  return `<div class="cfg-card fr-card fr-ancla min-w-0 mt-4" data-guardable data-nombre="Subrubros" id="frSubrubrosCard"><div class="fr-cuerpo">
    <div class="fr-card-cab"><div><h3 class="cfg-h">Subrubros</h3>
      <p class="cfg-ayuda">Minutos por kilo de cada subrubro de SIGA (rubro Pesables Deposito); a cada presentación se le suma el ajuste de su tramo de peso.
        Un subrubro sin valor no suma mano de obra ni máquina, salvo en los productos que tengan su propio min/kg (se pisa desde el listado).
        Se guardan todos juntos con un solo botón: sólo viaja lo que cambiaste, y vaciar un campo le saca el valor.</p></div>
      <label class="fr-filtro"><input type="checkbox" id="frSoloFalta"${soloFaltaFr ? ' checked' : ''}> Solo los que faltan <span id="frFaltan" class="fr-faltan" data-n="${faltan}">${faltan}</span></label></div>
    <div id="frSubrubros">${htmlSubrubrosFr()}</div></div>${pieFr('Guardar subrubros')}</div>`;
}
function conectarSubrubrosFr(card) {
  card.querySelectorAll('details[data-prods]').forEach(conectarProductosFr);
  const solo = card.querySelector('#frSoloFalta');
  solo.oninput = e => e.stopPropagation(); // el filtro no es un dato: sin esto el listener de Configuración marcaría la tarjeta "sin guardar"
  solo.onchange = () => { soloFaltaFr = solo.checked; filtrarFaltanFr(card); };
  filtrarFaltanFr(card);
  card.querySelector('.fr-guardar').onclick = () => guardarSubrubrosFr(card);
}
function conectarProductosFr(det) {
  const id = det.dataset.prods;
  det.ontoggle = () => (det.open ? abiertosFr.add(id) : abiertosFr.delete(id));
  const buscar = det.querySelector('.fr-buscar');
  if (buscar) buscar.oninput = () => filtrarProductosFr(det, buscar.value);
}
// "Solo los que faltan" mira lo guardado (data-falta), no lo tipeado: la fila que se está editando no desaparece sola.
function filtrarFaltanFr(card) {
  const filas = [...card.querySelectorAll('#frSubrubros tbody tr')];
  filas.forEach(tr => tr.classList.toggle('hidden', soloFaltaFr && tr.dataset.falta === '0'));
  const todos = soloFaltaFr && filas.length > 0 && filas.every(tr => tr.dataset.falta === '0');
  const aviso = card.querySelector('.fr-sin-faltan');
  if (aviso) aviso.classList.toggle('hidden', !todos);
}
function guardarSubrubrosFr(card) {
  const msg = card.querySelector('.esq-msg');
  const entradas = [...card.querySelectorAll('input[data-id]')];
  const cambios = cambiosSubrubrosFr(entradas.map(i => ({ id: i.dataset.id, valor: numOrNull(i.value) })), cfFr.subrubros);
  const nombres = Object.fromEntries(listaSubrubrosFr().map(s => [s.id, s.nombre]));
  const error = errorSubrubrosFr(cambios, nombres);
  if (error) return msgEsq(msg, error, 'text-crit');
  if (!Object.keys(cambios).length) { limpiarSucio(card); return msgEsq(msg, 'No hay cambios para guardar'); }
  return guardarFr(card, '/subrubros', { subrubros: cambios }, () => repintarFr('frSubrubrosCard', htmlSubrubrosCardFr, conectarSubrubrosFr));
}
function filtrarProductosFr(det, texto) {
  const filas = [...det.querySelectorAll('li[data-q]')];
  filas.forEach(li => li.classList.toggle('hidden', !coincideFr(li.dataset.q, texto)));
  det.querySelector('.fr-nada').classList.toggle('hidden', !filas.length || filas.some(li => !li.classList.contains('hidden')));
}

// ── Insumos por peso ──
// Una fila por peso: "250 g · 34 presentaciones", sus insumos y el costo por unidad. Editar abre el diálogo (#dlgFP) y al
// aceptar guarda ese peso (PUT /insumos-peso/:pesoG). La respuesta del PUT es la vista sin nombres ni costos: se recargan
// pesos e insumosPorPeso del GET /costeo (los costos de los insumos nuevos salen de su tab) y se repinta sólo esta tarjeta.
const chipsInsumosFr = insumos => (insumos.length
  ? insumos.map(i => `<span class="fp-chip">${esc(i.nombre || `PLU ${i.plu}`)} <b>× ${esc(i.cantidad)}</b></span>`).join(' ') : '<span class="text-gris">sin insumos</span>');
function htmlFilaPesoFr(f) {
  const costo = costoUnidadFr(f.insumos), txt = textoPesoFr(f), hay = f.insumos.length > 0;
  return `<tr data-peso="${f.pesoG}"><td class="fr-peso${f.presentaciones ? '' : ' fr-peso-vacio'}"><b>${esc(pesoCortoFr(f.pesoG))}</b><span>${esc(presentacionesFr(f.presentaciones))}</span></td>
    <td class="text-xs">${chipsInsumosFr(f.insumos)}</td>
    <td class="text-right whitespace-nowrap tabular-nums">${!hay ? '<span class="text-gris">—</span>' : costo == null ? '<span class="text-crit font-semibold">⚠ falta costo</span>' : `<b>$ ${fmtMoney(costo)}</b>`}</td>
    <td class="text-right"><button type="button" class="fr-peso-editar cfg-btn2" data-peso="${f.pesoG}" aria-label="${hay ? 'Editar' : 'Cargar'} los insumos de ${esc(txt)}">${hay ? 'Editar' : '+ Cargar insumos'}</button></td></tr>`;
}
function htmlPesosFr() {
  const filas = filasPesosFr(cfFr.pesos, cfFr.insumosPorPeso);
  return `<div class="cfg-card fr-ancla min-w-0 mt-4" id="frPesos"><h3 class="cfg-h">Insumos por peso</h3>
    <p class="cfg-ayuda">Insumos por unidad (bolsa, etiqueta…) según el peso de la presentación: valen para todas las presentaciones de Fraccionado de ese peso. El costo de cada insumo es el de su tab; costo por unidad = Σ cantidad × costo.</p>
    ${filas.length ? `<table class="cfg-tabla fr-filas w-full"><thead><tr><th class="text-left">Peso</th><th class="text-left">Insumos por unidad</th><th class="text-right">Costo por unidad</th><th><span class="sr-only">Acción</span></th></tr></thead>
      <tbody>${filas.map(htmlFilaPesoFr).join('')}</tbody></table>` : '<p class="text-sm text-gris mt-2">Ninguna presentación tiene peso en el nombre.</p>'}
    <div class="cfg-pie"><span class="esq-msg text-sm" role="status" aria-live="polite"></span></div></div>`;
}
function conectarPesosFr(card) {
  card.onclick = e => { const b = e.target.closest('.fr-peso-editar'); if (b) editarPesoFr(card, Number(b.dataset.peso)); };
}
async function editarPesoFr(card, pesoG) {
  const fila = filasPesosFr(cfFr.pesos, cfFr.insumosPorPeso).find(f => f.pesoG === pesoG);
  const lista = await editarInsumosFr(fila.insumos, `Insumos de las presentaciones de ${textoPesoFr(fila)}`);
  if (!lista) return;
  const msg = card.querySelector('.esq-msg');
  msgEsq(msg, 'Guardando…');
  try {
    await pedirEsq('PUT', `${API_FR}/insumos-peso/${pesoG}`, { insumos: lista.map(({ plu, cantidad }) => ({ plu, cantidad })) });
  } catch (e) { msgEsq(msg, e.message, 'text-crit'); return; }
  try {
    const { pesos, insumosPorPeso } = await pedirEsq('GET', `${API_FR}/costeo`);
    cfFr = { ...cfFr, pesos, insumosPorPeso };
  } catch (e) { msgEsq(msg, `Guardado, pero no se pudo recargar: ${e.message}`, 'text-warn'); return; }
  const nuevo = repintarFr('frPesos', htmlPesosFr, conectarPesosFr);
  msgEsq(nuevo && nuevo.querySelector('.esq-msg'), 'Guardado', 'text-ok');
  actualizarEstadoFr();
}

// Diálogo de insumos por unidad (#dlgFP en precios.html) → Promise de la lista elegida o null (Cancelar / Esc).
function editarInsumosFr(insumos, titulo) {
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
  conectarBuscadorSiga('fpDlgBus', elegidos => { leer(); lista = conInsumosFr(lista, elegidos); pintar(); },
    { multiple: true, deshabilitado: plu => (lista.some(x => x.plu === String(plu)) ? 'ya está' : null) });
  filas.onclick = e => { const b = e.target.closest('.fp-dlg-quitar'); if (b) { leer(); lista = lista.filter(x => x.plu !== b.closest('tr').dataset.plu); pintar(); } };
  d.querySelector('.fp-dlg-vaciar').onclick = () => { lista = []; pintar(); };
  d.querySelector('.fp-dlg-ok').onclick = () => {
    leer();
    const falla = errorInsumosFr(lista);
    if (falla) { msg.textContent = falla; return; }
    d.close('ok');
  };
  d.querySelector('.fp-dlg-cancelar').onclick = () => d.close('');
  pintar();
  d.returnValue = '';
  d.showModal();
  return new Promise(res => d.addEventListener('close', () => res(d.returnValue === 'ok' ? lista : null), { once: true }));
}

// ── Ajuste de margen por peso ──
// Puntos de margen que se suman a los tres canales según el peso de la presentación (antes se editaba en Márgenes). Tabla editable
// (siempre visible, vacía = sin ajuste) + generador de tramos que sólo llena la tabla. Guarda con PUT /ajustes-peso
// { ajustesPeso: { tramosG, puntos } | null }; la respuesta trae ajustesPeso y guardarFr lo mezcla en cfFr.
const htmlFilaAjusteFr = (g = '', p = '') => `<tr class="fr-tramo">
    <td class="py-1 pr-2">${campoU(`<input type="number" step="any" min="1" data-k="g" value="${esc(g)}" aria-label="Hasta (g)">`, 'g', { w: 'w-24' })}</td>
    <td class="py-1 pr-2">${campoU(`<input type="number" step="any" min="-100" max="100" data-k="p" value="${esc(p)}" aria-label="Ajuste en puntos de margen">`, 'pts', { w: 'w-24' })}</td>
    <td class="py-1"><button type="button" class="fr-quitar-tramo btn-quitar" data-edita aria-label="Quitar tramo">✕</button></td></tr>`;
const campoGenFr = (k, v, u, extra = '') => `<label class="flex flex-col gap-1 text-xs text-gris">${k}
    ${campoU(`<input type="number" step="any" data-gen="${k}" value="${v}" ${extra}>`, u, { w: 'w-24' })}</label>`;
function htmlAjustesPesoFr() {
  const aj = cfFr.ajustesPeso, tramos = aj && Array.isArray(aj.tramosG) ? aj.tramosG : [];
  return `<div class="cfg-card fr-card fr-ancla min-w-0 mt-4" data-guardable data-nombre="Ajuste de margen por peso" id="frAjustes"><div class="fr-cuerpo">
    <h3 class="cfg-h">Ajuste de margen por peso</h3>
    <p class="cfg-ayuda">Puntos de margen que se suman a los tres canales según el peso de la presentación. Se usa el primer tramo cuyo "hasta" es mayor o igual al peso;
      más pesado que el último usa el último; una presentación sin peso cuenta como 1000 g. Sin tramos = sin ajuste.</p>
    <div class="flex gap-10 items-start flex-wrap mt-2">
      <div><table class="cfg-tabla"><thead><tr><th class="text-left">Hasta (g)</th><th class="text-left">Ajuste</th><th><span class="sr-only">Quitar</span></th></tr></thead>
        <tbody>${tramos.map((g, i) => htmlFilaAjusteFr(g, aj.puntos[i])).join('')}</tbody></table>
        <p class="fr-vacio">Sin tramos: no se ajusta el margen por peso.</p>
        <button type="button" class="fr-agregar-tramo cfg-btn2 mt-2" data-edita>+ Agregar tramo</button></div>
      <div class="fr-generador"><h4 class="font-semibold text-sm mb-1">Generar tramos</h4>
        <p class="fr-hint mb-2">Cortes en escala logarítmica; el ajuste baja lineal del más liviano al más pesado. Llena la tabla: se aplica al guardar.</p>
        <div class="flex gap-3 flex-wrap items-end">
          ${campoGenFr('Desde', 100, 'g', 'min="1"')}${campoGenFr('Hasta', 5000, 'g', 'min="1"')}
          ${campoGenFr('Tramos', 6, '#', `min="2" max="${PreciosEsquema.AJUSTES_PESO_MAX}" step="1"`)}
          ${campoGenFr('Más liviano', 15, 'pts', 'min="-100" max="100"')}${campoGenFr('Más pesado', -10, 'pts', 'min="-100" max="100"')}
          <button type="button" class="fr-generar cfg-btn2">Generar</button></div>
        <p class="fr-gen-msg text-xs text-crit mt-1" role="status" aria-live="polite"></p></div>
    </div></div>${pieFr('Guardar ajuste por peso')}</div>`;
}
// Tabla vacía → null (sin ajuste). Ordenada por gramos; lo inválido (repetidos, vacíos, fuera de rango) lo rechaza el server.
function leerAjustesPesoFr(card) {
  const filas = [...card.querySelectorAll('.fr-tramo')].map(tr => ({ g: numOrNull(tr.querySelector('[data-k="g"]').value), p: numOrNull(tr.querySelector('[data-k="p"]').value) }))
    .sort((a, b) => (a.g ?? 0) - (b.g ?? 0));
  return filas.length ? { tramosG: filas.map(f => f.g), puntos: filas.map(f => f.p) } : null;
}
async function generarAjustesFr(card) {
  const v = k => numOrNull(card.querySelector(`[data-gen="${k}"]`).value);
  const gen = PreciosEsquema.generarAjustesPeso({ desdeG: v('Desde'), hastaG: v('Hasta'), tramos: v('Tramos'), livianoPct: v('Más liviano'), pesadoPct: v('Más pesado') });
  const msg = card.querySelector('.fr-gen-msg');
  msg.textContent = gen ? '' : `Revisá los datos: desde > 0, hasta > desde, de 2 a ${PreciosEsquema.AJUSTES_PESO_MAX} tramos (enteros) y ajustes entre −100 y 100.`;
  if (!gen) return;
  const tbody = card.querySelector('tbody');
  if (tbody.children.length && !(await confirmar('¿Reemplazar los tramos actuales por los generados?', { textoOk: 'Reemplazar' }))) return; // precios_config.js
  tbody.innerHTML = gen.tramosG.map((g, i) => htmlFilaAjusteFr(g, gen.puntos[i])).join('');
  marcarSucio(card);
}
function conectarAjustesPesoFr(card) {
  card.onclick = e => { // onclick, no addEventListener: la tarjeta se repinta al guardar
    if (e.target.closest('.fr-agregar-tramo')) card.querySelector('tbody').insertAdjacentHTML('beforeend', htmlFilaAjusteFr());
    else if (e.target.closest('.fr-quitar-tramo')) { e.target.closest('tr').remove(); marcarSucio(card); } // ya sacada: el listener de data-edita no encuentra la tarjeta
    else if (e.target.closest('.fr-generar')) generarAjustesFr(card);
  };
  card.querySelector('.fr-guardar').onclick = () => guardarFr(card, '/ajustes-peso', { ajustesPeso: leerAjustesPesoFr(card) },
    () => repintarFr('frAjustes', htmlAjustesPesoFr, conectarAjustesPesoFr));
}
