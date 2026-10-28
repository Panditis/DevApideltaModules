// ── Precios · Configuración › Costeo Fraccionado (specs 2026-10-21-precios-fraccionado-costeo-design §9.3 y
// 2026-10-23-precios-fraccionado-peso-subrubro-design §6) ──
// Script clásico, después de precios_config_esquema.js y precios_produccion.js. Sub-tab sólo con el switch de Configuración en
// Fraccionado (mostrarCosteoFracc). Arriba una barra de estado (qué falta: máquinas, subrubros, insumos) que lleva a cada tarjeta;
// después Máquinas, Escalas (factor de cada nivel de facilidad), los subrubros de SIGA (fila-tabla desplegable: su máquina, sus
// minutos según el peso y su facilidad, con sus productos al lado) y los insumos por peso de presentación
// (globales: valen para toda presentación de ese peso) y el ajuste por peso (puntos de margen de los tres canales según el peso de la
// presentación; se editaba en Márgenes). Cada tarjeta / subrubro guarda con su botón (PUT
// /api/precios/config/esquema/fraccionado/…) y se repinta sólo ella: lo que las otras tengan sin guardar queda. Los insumos de
// un peso se guardan al aceptar su diálogo (#dlgFP). La máquina propia de un granel, en su modal. Estilos: bloque
// "Costeo Fraccionado" de precios.html (.fr-*).
// Globales: esc, numOrNull, fmtMoney (precios_comun.js), campoU, marcarSucio, limpiarSucio (precios_config.js), pedirEsq,
// msgEsq, esFraccCfg (precios_config_esquema.js), htmlBuscadorSiga, conectarBuscadorSiga (precios_produccion.js), PreciosEsquema
// (/js/precios_esquema.js: generarAjustesPeso, AJUSTES_PESO_MAX).
const API_FR = '/api/precios/config/esquema/fraccionado';
const ESCALAS_FR = { facilidad: [['facil', 'Fácil'], ['normal', 'Normal'], ['dificil', 'Difícil']] };
// Qué significa la escala y cada opción (ayuda de Escalas y del select del subrubro).
const SIGNIFICADO_FR = {
  facilidad: { nombre: 'Facilidad', titulo: 'qué tan cómodo es manipular el producto al fraccionarlo',
    facil: 'fluye y se pesa sin ajustes', normal: 'pide algo de cuidado al pesar o cerrar',
    dificil: 'pegajoso, polvoriento o frágil: ajustes de peso, limpieza o cuidado extra' },
};
const TRAMO_INICIAL_G = 250;
const PRODUCTOS_PARA_BUSCAR = 8; // desde acá la lista de productos de un subrubro trae buscador

// ── Puros (test/precios_config_fraccionado_ui.test.js) ──
// Tramo nuevo al final: el doble del último (o 250 g), minutos por cargar.
const conTramoFr = tramos => [...tramos, { hastaG: tramos.length ? tramos[tramos.length - 1].hastaG * 2 : TRAMO_INICIAL_G, minutos: null }];
// Lo que le falta a un subrubro para costear (conf = lo guardado): máquina, tramos, facilidad.
const faltaSubrubroFr = conf => { const c = conf || {};
  return [[c.maquinaId, 'máquina'], [(c.tramos || []).length, 'tramos'], [c.facilidad, 'facilidad']].filter(([v]) => !v).map(([, t]) => t); };
// Etiqueta de un valor de escala ('facil' → 'Fácil'); sin elegir o desconocido → undefined.
const etiquetaEscalaFr = (tipo, v) => (ESCALAS_FR[tipo].find(([k]) => k === v) || [])[1];
function cuentaProductosFr(s) {
  const n = s.graneles.length, m = s.graneles.reduce((t, g) => t + g.presentaciones.length, 0);
  return `${n} producto${n === 1 ? '' : 's'} · ${m} presentaci${m === 1 ? 'ón' : 'ones'}`;
}
// Celdas de la fila de un subrubro (conf = lo guardado): máquina, tramos, facilidad; falta = sin dato (se pinta en aviso).
function celdasSubrubroFr(conf, maquinas) {
  const c = conf || {}, n = (c.tramos || []).length;
  const maq = (maquinas.find(m => m.id === c.maquinaId) || {}).nombre;
  const fac = etiquetaEscalaFr('facilidad', c.facilidad);
  return [{ t: maq || 'sin máquina', falta: !maq }, { t: n ? `${n} tramo${n === 1 ? '' : 's'}` : 'sin tramos', falta: !n },
    { t: fac || 'sin facilidad', falta: !fac }];
}
// Subrubros de la lista a los que les falta algo para costear (configurados = lo guardado por id).
const subrubrosIncompletosFr = (lista, configurados) => lista.filter(s => faltaSubrubroFr((configurados || {})[s.id]).length);
const textoUsosFr = u => [u.subrubros ? `${u.subrubros} subrubro${u.subrubros === 1 ? '' : 's'}` : '',
  u.graneles ? `${u.graneles} granel${u.graneles === 1 ? '' : 'es'}` : ''].filter(Boolean).join(' · ') || 'sin uso';
// Buscador de productos: todas las palabras del texto buscado están en el texto del producto, sin mayúsculas ni tildes.
const sinTildesFr = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const coincideFr = (texto, busqueda) => sinTildesFr(busqueda).split(/\s+/).filter(Boolean).every(p => sinTildesFr(texto).includes(p));
// Subrubros de SIGA + los que tienen configuración pero SIGA ya no trae: sin esa fila su máquina no se podría soltar y la
// máquina quedaría "en uso" para siempre.
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
// Ajuste por peso ({ tramosG, puntos } | null): "2 tramos" o "sin ajuste".
const textoAjustesPesoFr = aj => { const n = aj && Array.isArray(aj.tramosG) ? aj.tramosG.length : 0; return n ? `${n} tramo${n === 1 ? '' : 's'}` : 'sin ajuste'; };
// Las cuatro partes de la barra de arriba: id de su tarjeta, texto y estado (ok | falta | info).
function estadoConfigFr(maquinas, lista, configurados, filas, ajustesPeso) {
  const faltan = subrubrosIncompletosFr(lista, configurados).length, p = estadoPesosFr(filas), s = lista.length;
  return [
    { id: 'frMaquinas', titulo: 'Máquinas', texto: maquinas.length ? `${maquinas.length} cargada${maquinas.length === 1 ? '' : 's'}` : 'ninguna cargada', estado: maquinas.length ? 'ok' : 'falta' },
    { id: 'frSubrubrosCard', titulo: 'Subrubros', texto: s ? `${s - faltan} de ${s} completos` : 'sin subrubros', estado: !s ? 'info' : faltan ? 'falta' : 'ok' },
    { id: 'frPesos', titulo: 'Insumos por peso', texto: !p.total ? 'sin pesos' : p.sinCosto ? `${p.sinCosto} sin costo` : `${p.conInsumos} de ${p.total} pesos con insumos`, estado: p.sinCosto ? 'falta' : 'info' },
    { id: 'frAjustes', titulo: 'Ajuste por peso', texto: textoAjustesPesoFr(ajustesPeso), estado: 'info' },
  ];
}

// Efecto de un factor sobre los minutos: 1.5 → '+50% minutos'; 0.75 → '−25% minutos'; 1 → 'sin cambio'; con el factor: '× 1,5 (+50% minutos)'.
const fmtFactorFr = n => new Intl.NumberFormat('es-AR', { maximumFractionDigits: 4 }).format(n);
function pctMinutosFr(f) {
  const pct = Math.round((f - 1) * 1000) / 10;
  return pct ? `${pct > 0 ? '+' : '−'}${fmtFactorFr(Math.abs(pct))}% minutos` : 'sin cambio';
}
const efectoFactorFr = f => `× ${fmtFactorFr(f)} (${pctMinutosFr(f)})`;
// Línea viva bajo el select de facilidad del subrubro: minutos del tramo × su factor. Sin elegir → × 1.
function textoEfectoSubFr(escalas, facilidad) {
  const f = (escalas.facilidad || {})[facilidad] || 1, nombre = (etiquetaEscalaFr('facilidad', facilidad) || 'sin elegir').toLowerCase();
  return `Minutos por unidad = minutos del tramo × ${fmtFactorFr(f)} (facilidad ${nombre}: ${pctMinutosFr(f)})`;
}
const NOTA_EFECTO_FR = 'Sube o baja la mano de obra y la máquina de cada unidad (no los insumos ni la mercadería), y con eso el costo y el precio.';

if (typeof module === 'object' && module.exports) module.exports = { conTramoFr, faltaSubrubroFr, cuentaProductosFr, celdasSubrubroFr, subrubrosIncompletosFr, textoUsosFr,
  coincideFr, subrubrosListaFr, conInsumosFr, errorInsumosFr, costoUnidadFr, filasPesosFr, textoPesoFr, pesoCortoFr, estadoPesosFr, estadoConfigFr, pctMinutosFr,
  efectoFactorFr, textoEfectoSubFr, textoAjustesPesoFr };

// ── DOM ──
let cfFr = null;              // GET /costeo: config (maquinas, escalas, subrubros, porGranel, insumosPorPeso con nombre y costo)
                              // + productos (subrubrosSiga, sinSubrubro, pesos)
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
// se repinta sólo lo guardado (repintar devuelve el bloque nuevo). Las otras tarjetas y su data-sucio quedan como están. Su
// insumosPorPeso viene crudo (sin nombre ni costo): queda el del GET /costeo.
async function guardarFr(bloque, ruta, body, repintar) {
  const msg = bloque.querySelector('.esq-msg'), boton = bloque.querySelector('.fr-guardar');
  msgEsq(msg, 'Guardando…');
  boton.disabled = true; // un segundo click mientras se guarda mandaría el mismo PUT dos veces
  try {
    const { insumosPorPeso: _crudo, ...vista } = await pedirEsq('PUT', `${API_FR}${ruta}`, body);
    cfFr = { ...cfFr, ...vista };
    avisoFr(cfFr.migrado);
    limpiarSucio(bloque);
    const nuevo = repintar();
    msgEsq(nuevo && nuevo.querySelector('.esq-msg'), 'Guardado', 'text-ok');
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
function pintarCosteoFracc(panel) {
  panel.innerHTML = `<p class="cfg-cab"><b>Costeo de Fraccionado</b> — mano de obra, máquina e insumos de cada presentación, sumados al $/kg del granel.
      Minutos por unidad = minutos del tramo de peso del subrubro × factor de facilidad; el costo hora de mano de obra está en Costos.</p>
    <div id="frEstado" class="fr-barra" role="group" aria-label="Estado de la configuración">${htmlEstadoFr()}</div>
    <div class="grid gap-4 xl:grid-cols-2">${htmlMaquinasFr()}${htmlEscalasFr()}</div>
    ${htmlSubrubrosCardFr()}
    ${htmlPesosFr()}
    ${htmlAjustesPesoFr()}`;
  panel.querySelector('#frEstado').onclick = e => { const b = e.target.closest('[data-ancla]'); if (b) irAnclaFr(b.dataset.ancla); };
  const solo = panel.querySelector('#frSoloFalta');
  solo.onchange = () => panel.querySelector('#frSubrubros').classList.toggle('solo-falta', solo.checked);
  conectarMaquinasFr(panel.querySelector('#frMaquinas'));
  conectarEscalasFr(panel.querySelector('#frEscalas'));
  panel.querySelectorAll('#frSubrubros details[data-sub]').forEach(conectarSubrubroFr);
  conectarPesosFr(panel.querySelector('#frPesos'));
  conectarAjustesPesoFr(panel.querySelector('#frAjustes'));
}

// ── Barra de estado: qué falta de cada parte; cada una lleva a su tarjeta ──
const ICONO_ESTADO_FR = { ok: '✔', falta: '⚠', info: '–' };
const estadoActualFr = () => estadoConfigFr(cfFr.maquinas, listaSubrubrosFr(), cfFr.subrubros, filasPesosFr(cfFr.pesos, cfFr.insumosPorPeso), cfFr.ajustesPeso);
const htmlEstadoFr = () => estadoActualFr().map(p => `<button type="button" class="fr-est" data-ancla="${p.id}" data-estado="${p.estado}">
  <span class="fr-est-ico" aria-hidden="true">${ICONO_ESTADO_FR[p.estado]}</span><span><b>${esc(p.titulo)}</b><span class="fr-est-txt">${esc(p.texto)}</span></span></button>`)
  .join('<span class="cfg-chev" aria-hidden="true">›</span>');
const faltanSubrubrosFr = () => subrubrosIncompletosFr(listaSubrubrosFr(), cfFr.subrubros).length;
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

// ── Máquinas ──
const enUsoFr = u => !!u && (u.graneles + u.subrubros) > 0;
const htmlQuitarMaqFr = usos => `<button type="button" class="fr-quitar btn-quitar disabled:opacity-30" data-edita aria-label="Quitar máquina"${enUsoFr(usos) ? ' disabled title="En uso: asigná otra máquina a esos subrubros y graneles antes de borrarla"' : ''}>✕</button>`;
const htmlFilaMaqFr = (m = {}) => `<tr data-id="${esc(m.id || '')}">
  <td class="py-1 pr-3"><input class="num-in w-full text-left" data-k="nombre" maxlength="60" value="${esc(m.nombre || '')}" aria-label="Nombre de la máquina"></td>
  <td class="py-1 pr-3">${campoU(`<input type="number" min="0" step="any" data-k="costoHora" value="${esc(m.costoHora ?? '')}" aria-label="Costo por hora">`, '$/h', { w: 'w-32' })}</td>
  <td class="fr-usos py-1 pr-3 text-xs text-gris">${esc(m.usos ? textoUsosFr(m.usos) : 'sin uso')}</td>
  <td class="fr-q py-1">${htmlQuitarMaqFr(m.usos)}</td></tr>`;
const htmlMaquinasFr = () => `<div class="cfg-card fr-card fr-ancla min-w-0" data-guardable data-nombre="Máquinas" id="frMaquinas"><div class="fr-cuerpo">
    <h3 class="cfg-h">Máquinas</h3><p class="cfg-ayuda">Costo por hora de cada máquina (sin IVA). Por unidad suma minutos × costo hora ÷ 60. Una máquina en uso no se puede borrar.</p>
    <table class="cfg-tabla w-full"><thead><tr><th class="text-left">Nombre</th><th class="text-left">Costo hora</th><th class="text-left">Usada en</th><th><span class="sr-only">Quitar</span></th></tr></thead>
      <tbody>${cfFr.maquinas.map(m => htmlFilaMaqFr(m)).join('')}</tbody></table>
    <p class="fr-vacio">Todavía no hay máquinas: agregá una para poder asignarla a los subrubros.</p>
    <button type="button" class="fr-agregar cfg-btn2 mt-2" data-edita>+ Agregar máquina</button></div>${pieFr('Guardar máquinas')}</div>`;
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
const textoPropiaFr = nombre => `máquina propia: ${nombre}`;
// Máquinas nuevas o renombradas en los selects de los subrubros, en el resumen de cada subrubro y en las "máquina propia" de
// sus productos, sin tocar lo elegido (guardado o no) ni lo que se esté tipeando.
function actualizarSelectsMaquinaFr() {
  document.querySelectorAll('#frSubrubros .fr-sub-maquina').forEach(sel => {
    const v = sel.value;
    sel.innerHTML = opcionesMaquinaFr(v);
    sel.value = cfFr.maquinas.some(m => m.id === v) ? v : '';
  });
  document.querySelectorAll('#frSubrubros details[data-sub]').forEach(det => {
    det.querySelector('.fr-resumen').innerHTML = htmlCeldasFr(det.dataset.sub);
  });
  document.querySelectorAll('#frSubrubros .fr-propia').forEach(el => {
    const m = cfFr.maquinas.find(x => x.id === el.dataset.maq);
    if (m) el.textContent = textoPropiaFr(m.nombre);
  });
}

// ── Escalas ──
// La tabla de la escala: el factor de cada opción, cuánto suma o resta a los minutos y qué significa. El % se actualiza al tipear.
const htmlEscalaFr = ([tipo, ops]) => {
  const sig = SIGNIFICADO_FR[tipo];
  return `<div class="fr-escala" role="group" aria-label="Factor de cada nivel de ${esc(sig.nombre.toLowerCase())}">
    <table class="cfg-tabla fr-filas w-full"><tbody>${ops.map(([k, t]) => `<tr><td class="w-20"><label for="frEsc-${tipo}-${k}" class="font-semibold">${t}</label></td>
      <td class="w-32">${campoU(`<input id="frEsc-${tipo}-${k}" type="number" min="0" step="any" data-escala="${tipo}" data-k="${k}" value="${esc(cfFr.escalas[tipo][k])}">`, '×', { w: 'w-24' })}</td>
      <td class="fr-esc-efecto w-40 whitespace-nowrap">${esc(pctMinutosFr(cfFr.escalas[tipo][k]))}</td>
      <td class="text-xs text-gris">${esc(sig[k])}</td></tr>`).join('')}</tbody></table></div>`;
};
const htmlEscalasFr = () => `<div class="cfg-card fr-card fr-ancla min-w-0" data-guardable data-nombre="Facilidad" id="frEscalas"><div class="fr-cuerpo">
    <h3 class="cfg-h">Facilidad</h3><p class="cfg-ayuda">Qué tan cómodo es manipular el producto al fraccionarlo. Cada nivel es un factor que multiplica los minutos del tramo; se elige en cada subrubro (sin elegir → × 1). Mayor que 1 suma minutos (más mano de obra y máquina por unidad, más costo y precio); menor que 1 los resta.</p>
    ${Object.entries(ESCALAS_FR).map(htmlEscalaFr).join('')}</div>${pieFr('Guardar facilidad')}</div>`;
const leerEscalasFr = card => ({ escalas: Object.fromEntries(Object.entries(ESCALAS_FR).map(([tipo, ops]) =>
  [tipo, Object.fromEntries(ops.map(([k]) => [k, numOrNull(card.querySelector(`[data-escala="${tipo}"][data-k="${k}"]`).value)]))])) });
function conectarEscalasFr(card) {
  card.oninput = e => {
    const f = e.target.closest('[data-escala]');
    if (!f) return;
    const v = numOrNull(f.value);
    f.closest('tr').querySelector('.fr-esc-efecto').textContent = v == null ? '—' : pctMinutosFr(v);
  };
  card.querySelector('.fr-guardar').onclick = () => guardarFr(card, '/escalas', leerEscalasFr(card), () => repintarFr('frEscalas', htmlEscalasFr, conectarEscalasFr));
}

// ── Subrubros ──
const idDomFr = id => `frSub-${String(id).replace(/\W/g, '_')}`; // id de DOM: el subrubro viene de SIGA
const listaSubrubrosFr = () => subrubrosListaFr(cfFr.subrubrosSiga, cfFr.subrubros);
const htmlFilaTramoFr = (t = {}) => `<tr><td class="py-1 pr-2">${campoU(`<input type="number" min="1" step="1" data-k="hastaG" value="${esc(t.hastaG ?? '')}" aria-label="Hasta (g)">`, 'g', { w: 'w-28' })}</td>
  <td class="py-1 pr-2">${campoU(`<input type="number" min="0" step="any" data-k="minutos" value="${esc(t.minutos ?? '')}" aria-label="Minutos base por unidad">`, 'min', { w: 'w-28' })}</td>
  <td class="py-1"><button type="button" class="fr-quitar btn-quitar" data-edita aria-label="Quitar tramo">✕</button></td></tr>`;
const leerTramosFr = caja => [...caja.querySelectorAll('tbody tr')].map(tr => ({
  hastaG: numOrNull(tr.querySelector('[data-k="hastaG"]').value), minutos: numOrNull(tr.querySelector('[data-k="minutos"]').value) }));

// Granel con sus presentaciones (y la máquina propia si su modal le puso una). data-q = el texto que busca el buscador.
function htmlProductoFr(g) {
  const pres = g.presentaciones.map(p => p.nombre).join(', ');
  const propia = (cfFr.porGranel[g.plu] || {}).maquinaId;
  const nombreMaq = propia && (cfFr.maquinas.find(m => m.id === propia) || {}).nombre;
  return `<li data-q="${esc(`${g.nombre} ${pres}`)}"><span class="fr-prod-nom">${esc(g.nombre)}</span>${
    nombreMaq ? `<span class="fr-propia" data-maq="${esc(propia)}">${esc(textoPropiaFr(nombreMaq))}</span>` : ''}${pres ? `<span class="fr-prod-pres">${esc(pres)}</span>` : ''}</li>`;
}
function htmlProductosFr(s) {
  const buscador = s.graneles.length > PRODUCTOS_PARA_BUSCAR
    ? `<input type="search" class="fr-buscar num-in text-left w-full mb-2" placeholder="Buscar producto…" aria-label="Buscar producto de ${esc(s.nombre)}">` : '';
  return `<div class="fr-paso"><div class="fr-paso-cab"><span>Productos del subrubro</span><span class="fr-prod-n">${s.graneles.length}</span></div>${buscador}
    <ul class="fr-prod">${s.graneles.map(htmlProductoFr).join('') || '<li class="text-gris">Sin productos.</li>'}</ul>
    <p class="fr-nada hidden text-sm text-gris mt-1">Ningún producto coincide.</p></div>`;
}
// Encabezado de un paso: número en círculo + etiqueta (de un control: label for; de un grupo: texto con id).
const cabPasoFr = (n, texto, { para, id } = {}) => `<div class="fr-paso-cab"><span class="fr-n" aria-hidden="true">${n}</span>${
  para ? `<label for="${para}">${texto}</label>` : `<span id="${id}">${texto}</span>`}</div>`;
// Opción con su factor: "Difícil · × 1,5 (+50% minutos)".
const opcionesEscalaFr = (tipo, actual) => `<option value="">— (× 1)</option>${ESCALAS_FR[tipo]
  .map(([k, t]) => `<option value="${k}"${k === actual ? ' selected' : ''}>${t} · ${esc(efectoFactorFr(cfFr.escalas[tipo][k]))}</option>`).join('')}`;
const textoSignificadoFr = (tipo, v) => (v ? SIGNIFICADO_FR[tipo][v] : SIGNIFICADO_FR[tipo].titulo);
const htmlEscalaSubFr = (tipo, n, conf, dom) => `<div class="fr-paso">${cabPasoFr(n, SIGNIFICADO_FR[tipo].nombre, { para: `${dom}-${tipo}` })}
  <select id="${dom}-${tipo}" class="fr-sub-${tipo} num-in text-left w-full">${opcionesEscalaFr(tipo, conf[tipo])}</select>
  <p class="fr-sub-sig-${tipo} fr-hint">${esc(textoSignificadoFr(tipo, conf[tipo]))}</p></div>`;
// Celdas de la fila (máquina, tramos, facilidad) de lo guardado; las que faltan, en aviso.
const htmlCeldasFr = id => celdasSubrubroFr(cfFr.subrubros[id], cfFr.maquinas)
  .map(c => `<span class="fr-cel"${c.falta ? ' data-falta' : ''} title="${esc(c.t)}">${esc(c.t)}</span>`).join('');
function htmlSubrubroFr(s) {
  const guardado = cfFr.subrubros[s.id];
  const conf = guardado || { maquinaId: null, tramos: [] };
  const falta = faltaSubrubroFr(guardado), dom = idDomFr(s.id);
  const estado = falta.length
    ? `<span class="fr-estado" data-falta title="Falta ${esc(new Intl.ListFormat('es').format(falta))}">⚠ ${falta.length === 1 ? 'Falta 1' : `Faltan ${falta.length}`}</span>`
    : '<span class="fr-estado" data-ok>✔ Completo</span>';
  return `<details class="fr-sub" id="${dom}" data-sub="${esc(s.id)}" data-guardable data-nombre="Subrubro ${esc(s.nombre)}"${falta.length ? '' : ' data-completo'}${abiertosFr.has(s.id) ? ' open' : ''}>
    <summary class="fr-cols"><span class="fr-chev" aria-hidden="true"></span><b class="fr-nom" title="${esc(s.nombre)}">${esc(s.nombre)}</b>
      <span class="fr-cel fr-cel-prod" title="${esc(cuentaProductosFr(s))}">${esc(cuentaProductosFr(s))}</span><span class="fr-resumen">${htmlCeldasFr(s.id)}</span>${estado}</summary>
    <div class="fr-sub-cuerpo">
      <div>
        <div class="fr-paso">${cabPasoFr(1, 'Máquina', { para: `${dom}-maq` })}
          <select id="${dom}-maq" class="fr-sub-maquina num-in text-left w-full">${opcionesMaquinaFr(conf.maquinaId)}</select>
          <p class="fr-hint">Con la que se fraccionan los productos del subrubro; un granel puede usar otra desde su modal.</p></div>
        <div class="fr-paso" role="group" aria-labelledby="${dom}-tr">${cabPasoFr(2, 'Minutos base por unidad, según el peso', { id: `${dom}-tr` })}
          <p class="fr-hint">Aplica el primer tramo que cubre el peso de la presentación; si es más pesada que el último, el último.</p>
          <table class="cfg-tabla mt-2"><thead><tr><th class="text-left">Hasta</th><th class="text-left">Minutos base</th><th><span class="sr-only">Quitar</span></th></tr></thead>
            <tbody>${conf.tramos.map(htmlFilaTramoFr).join('')}</tbody></table>
          <p class="fr-vacio">Sin tramos: agregá al menos uno para costear este subrubro.</p>
          <button type="button" class="fr-agregar cfg-btn2 mt-2" data-edita>+ Agregar tramo</button></div>
      </div>
      <div>${htmlEscalaSubFr('facilidad', 3, conf, dom)}
        <div class="fr-efecto"><div class="lbl">Efecto en los minutos</div><p class="fr-sub-efecto" aria-live="polite">${esc(textoEfectoSubFr(cfFr.escalas, conf.facilidad))}</p>
          <p class="fr-efecto-nota">${esc(NOTA_EFECTO_FR)}</p></div></div>
      <div>${htmlProductosFr(s)}</div>
    </div>
    ${pieFr(`Guardar ${esc(s.nombre)}`)}</details>`;
}
// Tarjeta: título, ayuda, filtro "solo los que faltan", encabezado de las columnas (las mismas de cada fila) y la lista.
function htmlSubrubrosCardFr() {
  const faltan = faltanSubrubrosFr();
  return `<div class="cfg-card fr-ancla min-w-0 mt-4" id="frSubrubrosCard">
    <div class="fr-card-cab"><div><h3 class="cfg-h">Subrubros</h3>
      <p class="cfg-ayuda">Cada subrubro de SIGA (rubro Pesables Deposito) se costea con su máquina, sus minutos según el peso de la presentación y su facilidad; sin elegir la facilidad, el factor es × 1. Se guarda subrubro por subrubro.</p></div>
      <label class="fr-filtro"><input type="checkbox" id="frSoloFalta"> Solo los que faltan <span id="frFaltan" class="fr-faltan" data-n="${faltan}">${faltan}</span></label></div>
    <div class="fr-cols fr-cols-cab" aria-hidden="true"><span></span><span>Subrubro</span><span>Productos</span><span>Máquina</span><span>Tramos</span><span>Facilidad</span><span>Estado</span></div>
    <div id="frSubrubros">${htmlSubrubrosFr()}</div></div>`;
}
function htmlSubrubrosFr() {
  const lista = listaSubrubrosFr();
  const filas = lista.length ? `${lista.map(htmlSubrubroFr).join('')}<p class="fr-todo-ok">Todos los subrubros están completos.</p>`
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
  const fac = det.querySelector('.fr-sub-facilidad');
  fac.onchange = () => {
    det.querySelector('.fr-sub-sig-facilidad').textContent = textoSignificadoFr('facilidad', fac.value);
    det.querySelector('.fr-sub-efecto').textContent = textoEfectoSubFr(cfFr.escalas, fac.value);
  };
  det.querySelector('.fr-guardar').onclick = () => guardarFr(det, `/subrubros/${encodeURIComponent(id)}`,
    { maquinaId: det.querySelector('.fr-sub-maquina').value || null, tramos: leerTramosFr(det),
      facilidad: det.querySelector('.fr-sub-facilidad').value || null },
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

// ── Ajuste por peso ──
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
  return `<div class="cfg-card fr-card fr-ancla min-w-0 mt-4" data-guardable data-nombre="Ajuste por peso" id="frAjustes"><div class="fr-cuerpo">
    <h3 class="cfg-h">Ajuste por peso</h3>
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
