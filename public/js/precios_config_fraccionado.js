// ── Precios · Configuración › Costeo Fraccionado (specs 2026-10-21-precios-fraccionado-costeo-design §9.3,
// 2026-10-23-precios-fraccionado-peso-subrubro-design §6 y 2026-10-29-precios-fraccionado-tiempos-historial-design) ──
// Script clásico, después de precios_config_esquema.js y precios_produccion.js. Sub-tab sólo con el switch de Configuración en
// Fraccionado (mostrarCosteoFracc). Minutos por unidad = (min/kg + ajuste del tramo) × kg de la presentación. Arriba una barra de
// estado (qué falta) que lleva a cada tarjeta; después "Ajuste por tramo de peso" (± min/kg global según el peso; el tramo que
// cubre 1 kg es la base y queda fija en 0), Máquinas (costo hora; cada producto elige la suya en su modal), los subrubros de SIGA
// (una fila por subrubro con su valor y, en su lista, un input de min/kg y un select de estado en el listado por producto; un solo Guardar
// atómico para toda la tarjeta, que sólo manda lo que cambió), el envase por
// peso de presentación (bolsa = PLU de SIGA, o bobina = peso de la bolsa × $/kg de bobina; global: vale para toda presentación de
// ese peso, y cada granel elige su modo en su modal) y el ajuste de margen por peso (puntos de margen de los tres canales según el
// peso de la presentación; se editaba en Márgenes). Cada tarjeta guarda con su botón (PUT /api/precios/config/esquema/fraccionado/…)
// y se repinta sólo ella: lo que las otras tengan sin guardar queda. El envase es otra tarjeta (/js/precios_config_envase.js)
// con su propio Guardar. El min/kg y la máquina propios de un granel, en su modal. Estilos: bloque
// "Costeo Fraccionado" de precios.html (.fr-*). El sugerido del historial (chips "Historial" + "Usar" en subrubros y tramos, "Ver
// distribución" con "Fijar") lo arma /js/precios_fraccionado_historial.js (.hf-*); acá sólo se lo conecta y se guarda lo que fija.
// Globales: esc, numOrNull, fmtMoney (precios_comun.js), campoU, marcarSucio, limpiarSucio (precios_config.js), pedirEsq,
// msgEsq, esFraccCfg (precios_config_esquema.js), PreciosEsquema
// (/js/precios_esquema.js: generarAjustesPeso, AJUSTES_PESO_MAX), del historial: cargarHistorialHf, invalidarHistorialHf, pintarEstadoHf,
// pintarSubrubrosHf, pintarTramosHf, conectarSubrubrosHf, conectarTramosHf, historialHf, htmlHistProductoHf, usarEnInputHf; de precios_config.js, confirmar.
const API_FR = '/api/precios/config/esquema/fraccionado';
// Espejo de los límites del servidor (lib/precios_config_fraccionado.js y lib/precios_fraccionado_costo.js): el servidor valida igual.
const MIN_KG_MAX_FR = 600;
const MAX_TRAMOS_FR = 20;
const BASE_G_FR = 1000; // el tramo que cubre 1 kg es la base de la tabla y vale 0
const TRAMO_INICIAL_G = 250;
const PRODUCTOS_PARA_BUSCAR = 8; // desde acá la lista de productos de un subrubro trae buscador
const MAX_GRANELES_FR = 1000;    // productos por PUT subrubros (espejo de MAX_GRANELES de lib/precios_config_fraccionado.js)
const PESO_MIN_MAYORISTA_MAX_FR = 1000000; // peso mínimo mayorista en g (espejo del servidor: entero 1..1.000.000)
const MAX_ACTIVOS_FR = 1000;     // estados por PUT subrubros (mismo tope en el servidor)

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
// Min/kg propio guardado de un producto (porGranel = { [plu]: { minKg?, maquinaId? } }); null = sin propio (hereda el del subrubro; 0 es un valor).
const minKgGranelFr = (porGranel, plu) => { const g = (porGranel || {})[plu]; return g && g.minKg != null ? g.minKg : null; };
// Filas leídas [{ plu, valor: número | null (vacío) | NaN (texto roto) }] contra lo guardado → sólo lo que cambió, { [plu]: número | null }.
const cambiosGranelesFr = (filas, porGranel) => Object.fromEntries(filas.filter(f => f.valor !== minKgGranelFr(porGranel, f.plu)).map(f => [f.plu, f.valor]));
// Espejo del PUT subrubros para los graneles (aplicarTiempos): null si son hasta MAX_GRANELES_FR y todos 0 a 600 (o null = sacar el propio);
// si no, el mensaje del primero que no (nombres = { [plu]: "Producto (Subrubro)" }).
function errorGranelesFr(cambios, nombres = {}) {
  const plus = Object.keys(cambios);
  if (plus.length > MAX_GRANELES_FR) return `Se guardan hasta ${MAX_GRANELES_FR} productos por vez: guardá en dos tandas`;
  const mal = plus.find(p => cambios[p] != null && !(cambios[p] >= 0 && cambios[p] <= MIN_KG_MAX_FR));
  return mal ? `${nombres[mal] || `Producto ${mal}`}: el min por kg es un número de 0 a ${MIN_KG_MAX_FR}` : null;
}
// Peso mínimo mayorista: texto del input ('' = sin umbral). null si está bien; si no, el mensaje (espejo del PUT mayorista).
function errorPesoMinMayoristaFr(texto) {
  const t = String(texto ?? '').trim();
  if (t === '') return null;
  const n = Number(t.replace(',', '.'));
  return Number.isInteger(n) && n >= 1 && n <= PESO_MIN_MAYORISTA_MAX_FR ? null : `El peso mínimo es un entero de 1 a ${PESO_MIN_MAYORISTA_MAX_FR.toLocaleString('es-AR')} gramos (vacío = sin umbral)`;
}
// Body del PUT mayorista: el umbral, o null si el texto está vacío (saca el umbral).
const cuerpoMayoristaFr = texto => ({ pesoMinG: String(texto ?? '').trim() === '' ? null : Number(String(texto).trim().replace(',', '.')) });
// porPlu = { [plu]: true | false }: "2 marcadas a mano (1 mayorista, 1 minorista)" o "ninguna marcada a mano".
function resumenMarcasMayoristaFr(porPlu) {
  const v = Object.values(porPlu || {}), may = v.filter(x => x === true).length, min = v.filter(x => x === false).length, n = may + min;
  return n ? `${n} marcada${n === 1 ? '' : 's'} a mano (${may} mayorista${may === 1 ? '' : 's'}, ${min} minorista${min === 1 ? '' : 's'})` : 'ninguna marcada a mano';
}

// Estado de un producto en el listado de Fraccionado: activoGranel = { [plu]: true | false } (sólo los fijados a mano; ausente = automático).
const activoGuardadoFr = (activoGranel, plu) => { const a = (activoGranel || {})[plu]; return typeof a === 'boolean' ? a : null; };
const estadoDeActivoFr = a => (a === true ? 'activo' : a === false ? 'inactivo' : 'auto'); // valor del <select> de la fila
const activoDeEstadoFr = v => (v === 'activo' ? true : v === 'inactivo' ? false : null);
// Filas leídas [{ plu, valor: true | false | null (automático) }] contra lo guardado → sólo lo que cambió, { [plu]: true | false | null }.
const cambiosActivosFr = (filas, activoGranel) => Object.fromEntries(filas.filter(f => f.valor !== activoGuardadoFr(activoGranel, f.plu)).map(f => [f.plu, f.valor]));
// Espejo del tope del servidor: null si son hasta MAX_ACTIVOS_FR; si no, el mensaje.
const errorActivosFr = cambios => (Object.keys(cambios).length > MAX_ACTIVOS_FR ? `Se guardan hasta ${MAX_ACTIVOS_FR} estados por vez: guardá en dos tandas` : null);
// Body del PUT subrubros: sólo las partes con cambios (el servidor pide al menos una).
const cuerpoSubrubrosFr = (subrubros, graneles, activos = {}) => ({ ...(Object.keys(subrubros).length && { subrubros }),
  ...(Object.keys(graneles).length && { graneles }), ...(Object.keys(activos).length && { activos }) });
// Placeholder del input de un producto: lo que hereda si lo deja vacío ("8 · del subrubro"; el subrubro sin valor: "sin valor").
const textoHeredadoFr = minKgSubrubro => (minKgSubrubro == null ? 'sin valor' : `${String(minKgSubrubro).replace('.', ',')} · del subrubro`);
// "Usar en todos": cuántos productos tienen un valor propio GUARDADO distinto del que se va a poner (esos se pisan), y los textos del aviso.
const pisadosFr = (plus, porGranel, valor) => plus.filter(p => { const g = minKgGranelFr(porGranel, p); return g != null && g !== valor; }).length;
const textoPisarFr = (n, nombre, valor) => `${n} producto${n === 1 ? ' tiene' : 's tienen'} un min/kg propio guardado en ${nombre} y se ${n === 1 ? 'reemplaza' : 'reemplazan'} por ${String(valor).replace('.', ',')} min/kg (se aplica al guardar la tarjeta).\n¿Usar en todos?`;
const textoCompletadosFr = (n, valor) => `${n ? `Se completaron ${n} producto${n === 1 ? '' : 's'}` : 'Se completó el valor del subrubro'} con ${String(valor).replace('.', ',')} min/kg: revisá y guardá`;
function cuentaProductosFr(s) {
  const n = s.graneles.length, m = s.graneles.reduce((t, g) => t + g.presentaciones.length, 0);
  return `${n} producto${n === 1 ? '' : 's'} · ${m} presentaci${m === 1 ? 'ón' : 'ones'}`;
}
// Consumo eléctrico de las máquinas (spec 2026-11-03): kWh por hora de trabajo, 0 a CONSUMO_MAX_FR (espejo de lib/precios_config_fraccionado.js).
// Se multiplica por el valor de la energía de Costos; con consumo y sin valor el costo sale sin energía y se avisa.
const CONSUMO_MAX_FR = 1000;
const TXT_SIN_ENERGIA_FR = 'Hay máquinas con consumo y falta el valor de la energía ($/kWh): el costo no incluye la energía. Cargalo en Costos (Gastos variables) con el switch en Fraccionado.';
// '' si no hay nada que avisar; maquinas = [{ consumoKwhHora? }], valor = valorEnergiaKwh (null/undefined = sin cargar; 0 es un valor).
const avisoEnergiaFr = (maquinas, valor) => ((maquinas || []).some(m => m.consumoKwhHora > 0) && valor == null ? TXT_SIN_ENERGIA_FR : '');
// null si todos los consumos están vacíos o entre 0 y CONSUMO_MAX_FR; si no, el mensaje de la primera fila mala (NaN = texto roto).
function errorConsumoFr(maquinas) {
  const i = maquinas.findIndex(m => 'consumoKwhHora' in m && !(m.consumoKwhHora >= 0 && m.consumoKwhHora <= CONSUMO_MAX_FR));
  return i < 0 ? null : `${maquinas[i].nombre || `Máquina ${i + 1}`}: el consumo es un número de 0 a ${CONSUMO_MAX_FR} kWh por hora de trabajo (vacío = sin consumo)`;
}
// "Usada en" de una máquina (usos = { graneles }): una máquina en uso no se borra.
const textoUsosFr = u => (u && u.graneles ? `en uso por ${u.graneles} granel${u.graneles === 1 ? '' : 'es'}` : 'sin uso');
// Buscador de productos: todas las palabras del texto buscado están en el texto del producto, sin mayúsculas ni tildes.
const sinTildesFr = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const coincideFr = (texto, busqueda) => sinTildesFr(busqueda).split(/\s+/).filter(Boolean).every(p => sinTildesFr(texto).includes(p));
// Subrubros de SIGA + los que tienen configuración pero SIGA ya no trae: sin esa fila su valor no se podría sacar.
const subrubrosListaFr = (siga, configurados) => [...siga, ...Object.keys(configurados || {}).filter(id => !siga.some(s => s.id === id))
  .map(id => ({ id, nombre: `Subrubro ${id} (ya no tiene productos en SIGA)`, graneles: [] }))];
// "2 tramos" o "sin ajuste": del ajuste de margen por peso ({ tramosG, puntos } | null) y de la tabla de tramos de tiempo ([{ hastaG, minKg }]).
const textoNTramosFr = n => (n ? `${n} tramo${n === 1 ? '' : 's'}` : 'sin ajuste');
const textoAjustesPesoFr = aj => textoNTramosFr(aj && Array.isArray(aj.tramosG) ? aj.tramosG.length : 0);
const textoTramosTiempoFr = tramos => textoNTramosFr((tramos || []).length);
// Las cinco partes de la barra de arriba: id de su tarjeta, texto y estado (ok | falta | info). Máquina y tramos son opcionales: no faltan.
// envase = el chip { texto, estado } de la tarjeta Envase (estadoEnvaseFr, en precios_config_envase.js).
function estadoConfigFr(maquinas, lista, configurados, envase, ajustesPeso, tramosTiempo) {
  const faltan = subrubrosSinMinKgFr(lista, configurados).length, s = lista.length;
  return [
    { id: 'frTramos', titulo: 'Tramos de peso', texto: textoTramosTiempoFr(tramosTiempo), estado: 'info' },
    { id: 'frMaquinas', titulo: 'Máquinas', texto: maquinas.length ? `${maquinas.length} cargada${maquinas.length === 1 ? '' : 's'}` : 'ninguna cargada', estado: maquinas.length ? 'ok' : 'info' },
    { id: 'frSubrubrosCard', titulo: 'Subrubros', texto: s ? `${s - faltan} de ${s} con min/kg` : 'sin subrubros', estado: !s ? 'info' : faltan ? 'falta' : 'ok' },
    { id: 'frPesos', titulo: 'Envase', ...envase },
    { id: 'frAjustes', titulo: 'Margen por peso', texto: textoAjustesPesoFr(ajustesPeso), estado: 'info' },
  ];
}

if (typeof module === 'object' && module.exports) module.exports = { conTramoFr, indiceBaseFr, errorTramosFr, subrubrosSinMinKgFr, cambiosSubrubrosFr,
  errorSubrubrosFr, cuentaProductosFr, textoUsosFr, coincideFr, subrubrosListaFr,
  estadoConfigFr, textoAjustesPesoFr, textoTramosTiempoFr };

// ── DOM ──
let cfFr = null;              // GET /costeo: config (maquinas, tramosTiempo, subrubros, porGranel, envasePorPeso con nombre y costo de la bolsa,
                              // costoBobinaKg) + productos (subrubrosSiga, sinSubrubro, pesos)
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
// envasePorPeso viene crudo (sin el nombre ni el costo de la bolsa): queda el del GET /costeo. costoBobinaKg viene crudo y es el dato.
async function guardarFr(bloque, ruta, body, repintar) {
  const msg = bloque.querySelector('.esq-msg'), boton = bloque.querySelector('.fr-guardar');
  const teniaFoco = document.activeElement === boton; // el bloque se repinta: sin esto el foco del teclado se pierde
  msgEsq(msg, 'Guardando…');
  boton.disabled = true; // un segundo click mientras se guarda mandaría el mismo PUT dos veces
  try {
    const { envasePorPeso: _crudo, ...vista } = await pedirEsq('PUT', `${API_FR}${ruta}`, body);
    cfFr = { ...cfFr, ...vista };
    avisoFr(cfFr.migrado);
    limpiarSucio(bloque);
    const nuevo = await repintar(); // puede ser async (Envase recarga los nombres y costos de las bolsas antes de repintar)
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
const CABECERA_FR = `<p class="cfg-cab"><b>Costeo de Fraccionado</b> — mano de obra, máquina y envase de cada presentación, sumados al $/kg del granel.
    Minutos por unidad = (min/kg + ajuste del tramo) × kg de la presentación; el costo hora de mano de obra está en Costos.</p>
  <p class="cfg-cab">Orden de uso sugerido: primero la tabla de tramos, después los min/kg de los subrubros y, sólo para un producto puntual, pisar su min/kg
    desde el listado (el del producto reemplaza al del subrubro; el ajuste del tramo se suma igual).</p>`;
function pintarCosteoFracc(panel) {
  panel.innerHTML = `${CABECERA_FR}
    <div id="frHistorial" class="hf-estado"></div>
    <div id="frEstado" class="fr-barra flex-wrap" role="group" aria-label="Estado de la configuración">${htmlEstadoFr()}</div>
    <div class="grid gap-4 xl:grid-cols-2">${htmlTramosFr()}${htmlMaquinasFr()}</div>
    ${htmlSubrubrosCardFr()}
    ${htmlPesosFr()}
    ${htmlAjustesPesoFr()}
    ${htmlMayoristaFr()}`;
  panel.querySelector('#frEstado').onclick = e => { const b = e.target.closest('[data-ancla]'); if (b) irAnclaFr(b.dataset.ancla); };
  conectarTramosFr(panel.querySelector('#frTramos'));
  conectarMaquinasFr(panel.querySelector('#frMaquinas'));
  conectarSubrubrosFr(panel.querySelector('#frSubrubrosCard'));
  conectarPesosFr(panel.querySelector('#frPesos'));
  conectarAjustesPesoFr(panel.querySelector('#frAjustes'));
  conectarMayoristaFr(panel.querySelector('#frMayorista'));
  cargarHistorialFr();
}

// ── Barra de estado: qué falta de cada parte; cada una lleva a su tarjeta ──
const ICONO_ESTADO_FR = { ok: '✔', falta: '⚠', info: '–' };
const listaSubrubrosFr = () => subrubrosListaFr(cfFr.subrubrosSiga, cfFr.subrubros);
const estadoActualFr = () => estadoConfigFr(cfFr.maquinas, listaSubrubrosFr(), cfFr.subrubros, estadoEnvaseActualFr(), cfFr.ajustesPeso, cfFr.tramosTiempo); // estadoEnvaseActualFr: precios_config_envase.js
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
  <td class="hf-col py-1 pr-2" data-hf-tramo></td>
  <td class="py-1"><button type="button" class="fr-quitar btn-quitar" data-edita aria-label="Quitar tramo">✕</button></td></tr>`;
function htmlTramosFr() {
  const tramos = cfFr.tramosTiempo || [], base = indiceBaseFr(tramos.map(t => t.hastaG));
  return `<div class="cfg-card fr-card fr-ancla min-w-0 hf-sin" data-guardable data-nombre="Ajuste por tramo de peso" id="frTramos"><div class="fr-cuerpo">
    <h3 class="cfg-h">Ajuste por tramo de peso</h3>
    <p class="cfg-ayuda">Minutos por kilo que se suman (o se restan, con signo −) al min/kg según el peso de la presentación: minutos por unidad = (min/kg + ajuste del tramo) × kg de la presentación.
      El ajuste es por kilo: con +3 en el tramo de 250 g, fraccionar 1 kg en bolsas de 250 g tarda +3 min en total. Se usa el primer tramo cuyo "hasta" alcanza al peso;
      más pesado que el último usa el último.</p>
    <p class="cfg-ayuda">El tramo que cubre 1 kg es la base: vale 0 y los demás se miden contra él. Sin tramos = sin ajuste.
      Cambiar la tabla cambia los minutos de todas las presentaciones: cargala antes que los subrubros.</p>
    <table class="cfg-tabla fr-filas w-full"><thead><tr><th scope="col" class="text-left">Hasta</th><th scope="col" class="text-left">± min/kg</th><th scope="col" class="hf-col text-left">Historial</th><th scope="col"><span class="sr-only">Quitar</span></th></tr></thead>
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
  return guardarFr(card, '/tramos-tiempo', { tramos }, () => {
    invalidarHistorialHf(); // los sugeridos de producto y subrubro restan el ajuste de la tabla guardada: se piden de nuevo
    const nuevo = repintarFr('frTramos', htmlTramosFr, conectarTramosFr);
    cargarHistorialFr();
    return nuevo;
  });
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
  tbody.oninput = e => { if (e.target.matches('[data-k="hastaG"]')) { actualizarBaseFr(card); pintarTramosHf(card); } };
  tbody.onclick = e => { quitarFilaFr(e, card); actualizarBaseFr(card); };
  card.querySelector('.fr-guardar').onclick = () => guardarTramosFr(card);
  conectarTramosHf(card);
}

// ── Máquinas ──
const enUsoFr = u => !!u && u.graneles > 0;
const htmlQuitarMaqFr = usos => `<button type="button" class="fr-quitar btn-quitar disabled:opacity-30" data-edita aria-label="Quitar máquina"${enUsoFr(usos) ? ' disabled title="En uso: asigná otra máquina a esos productos antes de borrarla"' : ''}>✕</button>`;
const htmlFilaMaqFr = (m = {}) => `<tr data-id="${esc(m.id || '')}">
  <td class="py-1 pr-3"><input class="num-in w-full text-left" data-k="nombre" maxlength="60" value="${esc(m.nombre || '')}" aria-label="Nombre de la máquina"></td>
  <td class="py-1 pr-3">${campoU(`<input type="number" min="0" step="any" data-k="costoHora" value="${esc(m.costoHora ?? '')}" aria-label="Costo por hora">`, '$/h', { w: 'w-32' })}</td>
  <td class="py-1 pr-3">${campoU(`<input type="number" min="0" max="${CONSUMO_MAX_FR}" step="any" data-k="consumoKwhHora" value="${esc(m.consumoKwhHora ?? '')}" aria-label="Consumo en kilovatios hora por hora de trabajo (vacío = sin consumo)">`, 'kWh/h', { w: 'w-32' })}</td>
  <td class="fr-usos py-1 pr-3 text-xs text-gris">${esc(textoUsosFr(m.usos))}</td>
  <td class="fr-q py-1">${htmlQuitarMaqFr(m.usos)}</td></tr>`;
const htmlMaquinasFr = () => `<div class="cfg-card fr-card fr-ancla min-w-0" data-guardable data-nombre="Máquinas" id="frMaquinas"><div class="fr-cuerpo">
    <h3 class="cfg-h">Máquinas</h3><p class="cfg-ayuda">Costo por hora de cada máquina (sin IVA) y, si querés, su consumo eléctrico en kWh por hora de trabajo: se multiplica por el valor de la energía de Costos (Gastos variables). Cada producto elige la suya (o ninguna) desde su modal; por unidad suma minutos × costo hora ÷ 60, con los mismos minutos que la mano de obra. Una máquina en uso no se puede borrar.</p>
    <table class="cfg-tabla w-full"><thead><tr><th scope="col" class="text-left">Nombre</th><th scope="col" class="text-left">Costo hora</th><th scope="col" class="text-left">Consumo</th><th scope="col" class="text-left">Usada en</th><th scope="col"><span class="sr-only">Quitar</span></th></tr></thead>
      <tbody>${cfFr.maquinas.map(m => htmlFilaMaqFr(m)).join('')}</tbody></table>
    <p class="fr-aviso-energia text-sm text-warn font-semibold mt-2" role="status" aria-live="polite">${esc(avisoEnergiaFr(cfFr.maquinas, cfFr.valorEnergiaKwh))}</p>
    <p class="fr-vacio">Todavía no hay máquinas: agregá una para poder asignarla a los productos.</p>
    <button type="button" class="fr-agregar cfg-btn2 mt-2" data-edita>+ Agregar máquina</button></div>${pieFr('Guardar máquinas')}</div>`;
const leerMaquinasFr = card => [...card.querySelectorAll('tbody tr')].map(tr => ({ ...(tr.dataset.id ? { id: tr.dataset.id } : {}),
  nombre: tr.querySelector('[data-k="nombre"]').value.trim(), costoHora: numOrNull(tr.querySelector('[data-k="costoHora"]').value),
  ...consumoDeFr(tr.querySelector('[data-k="consumoKwhHora"]')) }));
// Consumo de una fila: { consumoKwhHora } con número, nada si está vacío (se guarda sin el campo), NaN si el texto es inválido (lo rechaza el server).
const consumoDeFr = i => (i.validity && i.validity.badInput ? { consumoKwhHora: NaN } : numOrNull(i.value) == null ? {} : { consumoKwhHora: numOrNull(i.value) });
// Leyenda de la tarjeta (con lo tipeado) y el valor de energía que trajo el GET: se pinta sola al cambiar un consumo y al volver del guardado.
function pintarAvisoEnergiaFr(card) {
  card.querySelector('.fr-aviso-energia').textContent = avisoEnergiaFr(leerMaquinasFr(card), cfFr.valorEnergiaKwh);
}
function conectarMaquinasFr(card) {
  card.querySelector('.fr-agregar').onclick = () => card.querySelector('tbody').insertAdjacentHTML('beforeend', htmlFilaMaqFr());
  card.querySelector('tbody').onclick = e => quitarFilaFr(e, card);
  card.querySelector('tbody').oninput = e => { if (e.target.matches('[data-k="consumoKwhHora"]')) pintarAvisoEnergiaFr(card); };
  card.querySelector('.fr-guardar').onclick = () => {
    const maquinas = leerMaquinasFr(card), error = errorConsumoFr(maquinas);
    if (error) return msgEsq(card.querySelector('.esq-msg'), error, 'text-crit');
    return guardarFr(card, '/maquinas', { maquinas }, () => {
      actualizarMaquinasPropiasFr();
      return repintarFr('frMaquinas', htmlMaquinasFr, conectarMaquinasFr);
    });
  };
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
// Una fila por subrubro de SIGA con su "Valor del subrubro" (min por kg; lo usan los productos sin valor propio) y la lista de sus
// productos, cada uno con su input "min/kg" (vacío = hereda el del subrubro, que el placeholder muestra; con valor se ve resaltado) y su
// select "Estado" en el listado de Fraccionado (Automático | Activo | Inactivo; los fijados a mano se ven resaltados).
// Un Guardar para toda la tarjeta: UN PUT /subrubros { subrubros: { [id]: número | null }, graneles: { [plu]: número | null },
// activos: { [plu]: true | false | null } } sólo con lo que cambió (vaciar un campo con valor guardado manda null; Automático = null).
// "Usar en todos" (historial) completa los inputs sin guardar y no toca el estado. Repintar la tarjeta conserva el filtro y las listas abiertas.
const OPCIONES_ESTADO_FR = [['auto', 'Automático'], ['activo', 'Activo'], ['inactivo', 'Inactivo']];
const TITULO_ESTADO_FR = 'Automático: lo decide el sistema. El producto queda activo si alguna presentación tuvo movimientos de stock en el último año, o si alguna presentación tiene stock en alguna sucursal (menos 6, 8 y 11). Activo e Inactivo lo fijan a mano.';
// Select del estado de un producto en el listado (estado = 'auto' | 'activo' | 'inactivo'); data-plu lo lee guardarSubrubrosFr.
const htmlSelectEstadoFr = (plu, nombre, estado) => `<select class="fr-act num-in text-left" data-plu="${esc(plu)}" aria-label="${esc(`Estado de ${nombre} en el listado`)}" title="${esc(TITULO_ESTADO_FR)}">${
  OPCIONES_ESTADO_FR.map(([v, t]) => `<option value="${v}"${v === estado ? ' selected' : ''}>${t}</option>`).join('')}</select>`;
// Granel con sus presentaciones, su input de min/kg propio (heredado = el min/kg que tiene el subrubro ahora), la máquina propia si su
// modal le puso, su historial gris y el estado en el listado (el guardado, o el que se le pase: fijarProductoFr conserva el sin guardar).
// data-q = el texto que busca el buscador; data-act = el estado, para resaltar la fila.
function htmlProductoFr(g, s, heredado, estado = estadoDeActivoFr(activoGuardadoFr(cfFr.activoGranel, g.plu))) {
  const pres = g.presentaciones.map(p => p.nombre).join(', ');
  const { maquinaId: propia, minKg } = cfFr.porGranel[g.plu] || {};
  const nombreMaq = propia && (cfFr.maquinas.find(m => m.id === propia) || {}).nombre;
  const input = `<input type="number" min="0" max="${MIN_KG_MAX_FR}" step="any" data-plu="${esc(g.plu)}" value="${esc(minKg ?? '')}" placeholder="${esc(textoHeredadoFr(heredado))}"
    aria-label="${esc(`Min por kg de ${g.nombre} (subrubro ${s.nombre}); vacío usa el del subrubro`)}">`;
  return `<li data-plu="${esc(g.plu)}" data-act="${esc(estado)}" data-q="${esc(`${g.nombre} ${pres}`)}"><div class="fr-prod-info"><span class="fr-prod-nom">${esc(g.nombre)}</span>${
    nombreMaq ? `<span class="fr-propia" data-maq="${esc(propia)}">${esc(textoPropiaFr(nombreMaq))}</span>` : ''}${pres ? `<span class="fr-prod-pres">${esc(pres)}</span>` : ''}</div>${
    campoU(input, 'min/kg', { w: 'w-40' })}${htmlHistProductoHf(historialHf(), g.plu)}${htmlSelectEstadoFr(g.plu, g.nombre, estado)}</li>`;
}
function htmlProductosFr(s) {
  const heredado = minKgGuardadoFr(cfFr.subrubros, s.id);
  const buscador = s.graneles.length > PRODUCTOS_PARA_BUSCAR
    ? `<input type="search" class="fr-buscar num-in text-left w-full mb-2" placeholder="Buscar producto…" aria-label="Buscar producto de ${esc(s.nombre)}">` : '';
  return `${buscador}<ul class="fr-prod">${s.graneles.map(g => htmlProductoFr(g, s, heredado)).join('')}</ul>
    <p class="fr-nada hidden text-sm text-gris mt-1">Ningún producto coincide.</p>`;
}
const htmlListaProductosFr = s => (s.graneles.length
  ? `<details class="max-w-[54rem]" data-prods="${esc(s.id)}"${abiertosFr.has(s.id) ? ' open' : ''}><summary class="cursor-pointer text-gris">${esc(cuentaProductosFr(s))}</summary>
      <div class="mt-2">${htmlProductosFr(s)}</div></details>`
  : `<span class="text-gris">${esc(cuentaProductosFr(s))}</span>`);
function htmlSubrubroFr(s) {
  const minKg = minKgGuardadoFr(cfFr.subrubros, s.id), tiene = minKg != null;
  return `<tr data-falta="${tiene ? 0 : 1}"${soloFaltaFr && tiene ? ' class="hidden"' : ''}>
    <td class="font-semibold">${esc(s.nombre)}</td><td>${htmlListaProductosFr(s)}<p class="fr-aviso" role="status" aria-live="polite"></p></td>
    <td>${campoU(`<input type="number" min="0" max="${MIN_KG_MAX_FR}" step="any" data-id="${esc(s.id)}" value="${esc(minKg ?? '')}" aria-label="Valor del subrubro ${esc(s.nombre)} en min por kg: lo usan los productos sin valor propio">`, 'min/kg', { w: 'w-32' })}</td>
    <td class="hf-col" data-hf-sub="${esc(s.id)}" data-hf-nombre="${esc(s.nombre)}" data-hf-n="${s.graneles.length}"></td>
    <td class="whitespace-nowrap text-xs ${tiene ? 'text-ok' : 'text-warn font-semibold'}">${tiene ? '✔ con valor' : '⚠ sin valor'}</td></tr>`;
}
function htmlSubrubrosFr() {
  const lista = listaSubrubrosFr();
  const tabla = lista.length ? `<table class="cfg-tabla fr-filas w-full"><thead><tr><th scope="col" class="text-left">Subrubro</th><th scope="col" class="text-left">Productos</th>
      <th scope="col" class="text-left">Valor del subrubro<span class="fr-th-sub">lo usan los productos sin valor propio</span></th><th scope="col" class="hf-col text-left">Historial (por 1 kg)</th><th scope="col" class="text-left">Estado</th></tr></thead><tbody>${lista.map(htmlSubrubroFr).join('')}</tbody></table>
    <p class="fr-sin-faltan hidden mt-2 text-sm font-semibold text-ok" role="status">Todos los subrubros tienen min/kg.</p>`
    : '<p class="text-sm text-gris mt-2">SIGA no devolvió subrubros para los graneles (rubro Pesables Deposito).</p>';
  const sin = cfFr.sinSubrubro.length ? `<details class="mt-3 text-sm"><summary class="cursor-pointer text-warn">⚠ ${cfFr.sinSubrubro.length} producto${cfFr.sinSubrubro.length === 1 ? '' : 's'} sin subrubro en SIGA: sólo suman mano de obra y máquina si tienen su propio min/kg</summary>
      <ul class="mt-1 text-gris">${cfFr.sinSubrubro.map(g => `<li>${esc(g.nombre)}</li>`).join('')}</ul></details>` : '';
  return tabla + sin;
}
// Tarjeta: título, ayuda, filtro "solo los que faltan" y la tabla.
function htmlSubrubrosCardFr() {
  const faltan = faltanSubrubrosFr();
  return `<div class="cfg-card fr-card fr-ancla min-w-0 mt-4 hf-sin" data-guardable data-nombre="Subrubros" id="frSubrubrosCard"><div class="fr-cuerpo">
    <div class="fr-card-cab"><div><h3 class="cfg-h">Subrubros</h3>
      <p class="cfg-ayuda">Minutos por kilo de cada producto de SIGA (rubro Pesables Deposito); a cada presentación se le suma el ajuste de su tramo de peso.
        Cada producto usa su propio valor y, si lo dejás vacío, el del subrubro (que también usan los productos nuevos de SIGA). Un producto sin valor propio
        en un subrubro sin valor no suma mano de obra ni máquina. "Usar en todos" copia el valor del historial a todos los productos del subrubro.
        Se guarda todo junto con un solo botón: sólo viaja lo que cambiaste, y vaciar un campo le saca el valor.</p>
      <p class="cfg-ayuda"><b>Estado</b> de cada producto en el listado de Fraccionado: <b>Automático</b> lo decide el sistema: el producto queda activo si alguna presentación tuvo movimientos de stock en el último
        año, o si alguna presentación tiene stock en alguna sucursal (menos 6, 8 y 11); <b>Activo</b> lo muestra siempre; <b>Inactivo</b> lo oculta. No cambia ningún precio: sólo define si el producto aparece en el listado. Los inactivos se ven
        con "Ver inactivos"; los que tienen REEFER en el nombre se ocultan del listado salvo con "Ver REEFER", sea cual sea su estado.</p></div>
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
  card.oninput = e => {
    if (e.target.matches('input[data-id]')) actualizarHeredadoFr(e.target);
    else if (e.target.matches('select.fr-act')) e.target.closest('li').dataset.act = e.target.value; // resalta la fila con el estado elegido
  };
  conectarSubrubrosHf(card, { actual: id => minKgGuardadoFr(cfFr.subrubros, id), fijar: fijarProductoFr, usarEnTodos: (id, valor, nombre) => usarEnTodosFr(card, id, valor, nombre) });
}
// Escribir el valor del subrubro cambia lo que heredan sus productos sin valor propio: sólo se reescribe su placeholder (nada se repinta).
function actualizarHeredadoFr(inputSubrubro) {
  const ph = textoHeredadoFr(numOrNull(inputSubrubro.value));
  inputSubrubro.closest('tr').querySelectorAll('input[data-plu]').forEach(i => { i.placeholder = ph; });
}
// Lo que hay escrito en un input de min/kg: número, null (vacío) o NaN (texto roto, que el navegador deja en value = '': no es "vaciar").
const valorInputFr = i => (i.validity && i.validity.badInput ? NaN : numOrNull(i.value));
// "Usar en todos" del historial del subrubro: su valor en el input de CADA producto y en el del subrubro, sin guardar (se guarda con el
// Guardar de la tarjeta). Si pisa valores propios ya guardados, pide confirmar con el conteo. Deja la lista abierta y con todos los productos a la vista.
async function usarEnTodosFr(card, id, valor, nombre) {
  const sub = card.querySelector(`input[data-id="${CSS.escape(id)}"]`), tr = sub.closest('tr');
  const inputs = [...tr.querySelectorAll('input[data-plu]')];
  const pisados = pisadosFr(inputs.map(i => i.dataset.plu), cfFr.porGranel, valor);
  if (pisados && !(await confirmar(textoPisarFr(pisados, nombre, valor), { textoOk: 'Usar en todos' }))) return;
  inputs.forEach(i => { i.value = String(valor); });
  const det = tr.querySelector('details[data-prods]'), buscar = tr.querySelector('.fr-buscar');
  if (det) { abiertosFr.add(id); det.open = true; }
  if (buscar && buscar.value) { buscar.value = ''; filtrarProductosFr(det, ''); }
  tr.querySelector('.fr-aviso').textContent = textoCompletadosFr(inputs.length, valor);
  usarEnInputHf(sub, valor); // avisa como si se hubiera tipeado: marca la tarjeta "sin guardar"
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
// Un solo PUT atómico con lo que cambió del subrubro, de sus productos y de su estado en el listado. Validado acá con los mismos límites
// que el servidor. La respuesta trae activoGranel (lo guardado): guardarFr lo mezcla en cfFr y la tarjeta se repinta con eso.
function guardarSubrubrosFr(card) {
  const msg = card.querySelector('.esq-msg');
  const leer = (selector, clave) => [...card.querySelectorAll(selector)].map(i => ({ [clave]: i.dataset[clave], valor: valorInputFr(i) }));
  const subrubros = cambiosSubrubrosFr(leer('input[data-id]', 'id'), cfFr.subrubros);
  const graneles = cambiosGranelesFr(leer('input[data-plu]', 'plu'), cfFr.porGranel);
  const activos = cambiosActivosFr([...card.querySelectorAll('select[data-plu]')].map(s => ({ plu: s.dataset.plu, valor: activoDeEstadoFr(s.value) })), cfFr.activoGranel);
  const nombresSub = Object.fromEntries(listaSubrubrosFr().map(s => [s.id, s.nombre]));
  const nombresProd = Object.fromEntries(cfFr.subrubrosSiga.flatMap(s => s.graneles.map(g => [g.plu, `${g.nombre} (${s.nombre})`])));
  const error = errorSubrubrosFr(subrubros, nombresSub) || errorGranelesFr(graneles, nombresProd) || errorActivosFr(activos);
  if (error) return msgEsq(msg, error, 'text-crit');
  const cuerpo = cuerpoSubrubrosFr(subrubros, graneles, activos);
  if (!Object.keys(cuerpo).length) { limpiarSucio(card); return msgEsq(msg, 'No hay cambios para guardar'); }
  return guardarFr(card, '/subrubros', cuerpo, () => repintarFr('frSubrubrosCard', htmlSubrubrosCardFr, conectarSubrubrosFr));
}
function filtrarProductosFr(det, texto) {
  const filas = [...det.querySelectorAll('li[data-q]')];
  filas.forEach(li => li.classList.toggle('hidden', !coincideFr(li.dataset.q, texto)));
  det.querySelector('.fr-nada').classList.toggle('hidden', !filas.length || filas.some(li => !li.classList.contains('hidden')));
}

// Helpers puros de Subrubros para test: aparte del module.exports de arriba (otra tarjeta lo edita al mismo tiempo).
if (typeof module === 'object' && module.exports) Object.assign(module.exports, { minKgGranelFr, cambiosGranelesFr, errorGranelesFr, cuerpoSubrubrosFr,
  textoHeredadoFr, pisadosFr, textoPisarFr, textoCompletadosFr, activoGuardadoFr, estadoDeActivoFr, activoDeEstadoFr, cambiosActivosFr, errorActivosFr });

// Helpers puros de Mayoristas (peso mínimo) para test.
if (typeof module === 'object' && module.exports) Object.assign(module.exports, { errorPesoMinMayoristaFr, cuerpoMayoristaFr, resumenMarcasMayoristaFr, PESO_MIN_MAYORISTA_MAX_FR });

// Helpers puros de Máquinas (consumo de energía) para test.
if (typeof module === 'object' && module.exports) Object.assign(module.exports, { avisoEnergiaFr, errorConsumoFr, CONSUMO_MAX_FR, TXT_SIN_ENERGIA_FR });

// ── Sugerido del historial (precios_fraccionado_historial.js) ──
// Se pide aparte de la configuración: si falla, la configuración sigue andando sin chips (el aviso queda en #frHistorial). Cada cambio de
// estado (leyendo / listo / error) repinta sólo el aviso y los chips, sin tocar lo que se esté tipeando.
const cargarHistorialFr = () => cargarHistorialHf(pintarHistorialFr);
function pintarHistorialFr() {
  pintarEstadoHf(document.getElementById('frHistorial'), () => { invalidarHistorialHf(); cargarHistorialFr(); });
  pintarSubrubrosHf(document.getElementById('frSubrubrosCard'));
  pintarTramosHf(document.getElementById('frTramos'));
}
// "Fijar" del histograma: pisa el min/kg propio del producto (PUT granel/:plu { minKg }, sin tocar su máquina) y lo refleja en su renglón.
// El estado del renglón queda como estaba (con lo tipeado y sin guardar): el renglón se pinta de nuevo y fijar no lo toca.
async function fijarProductoFr(plu, minKg) {
  const { envasePorPeso: _crudo, ...vista } = await pedirEsq('PUT', `${API_FR}/granel/${encodeURIComponent(plu)}`, { minKg });
  cfFr = { ...cfFr, ...vista };
  const s = cfFr.subrubrosSiga.find(x => x.graneles.some(g => g.plu === plu));
  const li = document.querySelector(`#frSubrubros li[data-plu="${CSS.escape(plu)}"]`);
  const estado = document.querySelector(`#frSubrubros select[data-plu="${CSS.escape(plu)}"]`);
  if (s && li) li.outerHTML = htmlProductoFr(s.graneles.find(g => g.plu === plu), s, numOrNull(li.closest('tr').querySelector('input[data-id]').value), estado ? estado.value : undefined);
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

// ── Presentaciones mayoristas ──
// Peso mínimo (g): las presentaciones de ese peso o más cuentan como mayoristas; vacío = ninguna lo es por peso. Las marcas a mano por
// presentación (Mayorista / Minorista / automático) se hacen desde el listado y ganan sobre el peso. Hoy sólo clasifica y muestra: el precio
// se calcula igual. Guarda con PUT /mayorista { pesoMinG: entero | null }; la respuesta trae mayorista y guardarFr lo mezcla en cfFr.
function htmlMayoristaFr() {
  const m = cfFr.mayorista || { pesoMinG: null, porPlu: {} };
  return `<div class="cfg-card fr-card fr-ancla min-w-0 mt-4" data-guardable data-nombre="Presentaciones mayoristas" id="frMayorista"><div class="fr-cuerpo">
    <h3 class="cfg-h">Presentaciones mayoristas</h3>
    <p class="cfg-ayuda">Presentaciones de este peso o más se tratan como mayoristas. Vacío: ninguna lo es por peso. Una presentación sin peso en el nombre nunca es mayorista por peso.
      Hoy sólo se clasifica y se muestra (badge en el listado y columna en el export): el precio se calcula igual que antes.
      Si un granel tiene 2 presentaciones mayoristas, la de menor peso es pack y la mayor es bulto (salvo que marques el tipo a mano).</p>
    <label class="flex flex-col gap-1 text-xs text-gris w-fit">Peso mínimo mayorista
      ${campoU(`<input type="number" min="1" max="${PESO_MIN_MAYORISTA_MAX_FR}" step="1" data-k="pesoMinG" value="${esc(m.pesoMinG ?? '')}" placeholder="sin umbral" aria-describedby="frMayoristaErr">`, 'g', { w: 'w-40' })}</label>
    <p id="frMayoristaErr" class="fr-may-err text-xs text-crit mt-1" role="status" aria-live="polite"></p>
    <p class="text-sm text-gris mt-2">Marcas a mano (se cambian desde el listado, con el botón de cada presentación): <b>${esc(resumenMarcasMayoristaFr(m.porPlu))}</b>. La marca a mano gana sobre el peso.</p>
    </div>${pieFr('Guardar peso mínimo')}</div>`;
}
function conectarMayoristaFr(card) {
  const input = card.querySelector('[data-k="pesoMinG"]'), err = card.querySelector('.fr-may-err');
  const validar = () => { const e = errorPesoMinMayoristaFr(input.value) || (input.validity && input.validity.badInput ? 'Número no válido' : null); err.textContent = e || ''; input.setAttribute('aria-invalid', String(!!e)); return e; };
  input.oninput = validar;
  card.querySelector('.fr-guardar').onclick = () => {
    if (validar()) return input.focus();
    return guardarFr(card, '/mayorista', cuerpoMayoristaFr(input.value), () => repintarFr('frMayorista', htmlMayoristaFr, conectarMayoristaFr));
  };
}
