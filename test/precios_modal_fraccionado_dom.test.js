'use strict';
// Modal del producto con los scripts del front cargados como en el navegador (scripts clásicos que comparten globales) sobre un
// DOM mínimo: las dos tarjetas de Fraccionado (izquierda #mDetBody con la configuración, derecha #mDetDerBody con los precios; con y sin
// precios-config), el costo manual cargado desde su tarjeta de decisión, los ids que conectan cada guardado, el ancho 'doble' de abrirModal
// y que Reventa / Producción siguen con la tabla por canal y "Ver detalle" y sin tarjeta derecha.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const L = require('../lib/precios_listado_esquema');
const { CFG } = require('./precios_esquema_fixture');
const { deltaPesosMd } = require('../public/js/precios_modal_fraccionado.js');

const clases = ini => {
  const s = new Set(ini);
  return { add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c), toggle: (c, on = !s.has(c)) => { if (on) s.add(c); else s.delete(c); return on; } };
};
// getElementById sólo encuentra los ids fijos de precios.html y los que haya en el HTML pintado en #mDetBody / #mDetDerBody (como el navegador).
function crearContexto() {
  const elementos = new Map();
  const el = id => {
    if (!elementos.has(id)) {
      elementos.set(id, { id, innerHTML: '', textContent: '', value: '', options: [], hidden: false, open: false,
        classList: clases(id === 'mDetCaja' ? ['max-w-2xl'] : id === 'mDet' || id === 'mDetDer' ? ['hidden'] : []),
        focus() {}, setAttribute() {}, removeAttribute() {}, addEventListener() {}, scrollIntoView() {}, insertAdjacentHTML() {},
        querySelector: () => el(`${id}>*`), querySelectorAll: () => [] });
    }
    return elementos.get(id);
  };
  const FIJOS = ['mDet', 'mDetPar', 'mDetCaja', 'mDetTitulo', 'mDetSub', 'mDetAct', 'mDetBody', 'mDetX', 'mDetDer', 'mDetDerTitulo', 'mDetDerSub', 'mDetDerBody'];
  const cuerpo = () => el('mDetBody').innerHTML;
  const cuerpoDer = () => el('mDetDerBody').innerHTML;
  const ids = () => [...(cuerpo() + cuerpoDer()).matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  const document = {
    activeElement: null,
    contains: () => true,
    getElementById: id => (FIJOS.includes(id) || ids().includes(id) ? el(id) : null),
    querySelector: sel => { const m = /^#mDetBody \.([\w-]+)$/.exec(sel); return m && cuerpo().includes(`class="${m[1]}`) ? el(`.${m[1]}`) : null; },
    querySelectorAll: () => [],
  };
  const llamadas = [];
  const ctx = vm.createContext({
    document, CSS: { escape: s => s }, console, Intl,
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    getJson: () => Promise.resolve({ maquinas: [] }), API_FR: '/api/precios/config/esquema/fraccionado',
    campoU: input => input, textoMotivosActividad: m => (m || []).join('; '),
    guardarDecision: (...a) => { llamadas.push(['guardarDecision', ...a]); return Promise.resolve(null); },
    ...(({ accionActividadLst, textoInactivoLst, conActividadLst, conMarcaMayoristaLst, accionesMayoristaLst }) => ({ accionActividadLst, textoInactivoLst, conActividadLst, conMarcaMayoristaLst, accionesMayoristaLst }))(require('../public/js/precios_listados.js')), // las del listado (globales en el navegador)
    guardarMarcaMayoristaLst: (...a) => { llamadas.push(['guardarMarcaMayoristaLst', ...a]); return Promise.resolve(700); },
    guardarActividadLst: (...a) => { llamadas.push(['guardarActividadLst', ...a]); return Promise.resolve(); },
    renderListado() {}, cargarListado() {}, refrescarAlertasProduccion() {}, salirDeProduccion() {}, activarTab() {},
    guardarTipoProveedor: () => Promise.resolve(),
  });
  ctx.self = ctx; // lib/precios_esquema.js (UMD, /js/precios_esquema.js en la página) publica self.PreciosEsquema
  for (const f of ['../../lib/precios_esquema.js', 'precios_comun.js', 'precios_modal_esquema.js', 'precios_fraccionado_historial.js', 'precios_modal_fraccionado.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js', f), 'utf8'), ctx, { filename: path.basename(f) });
  }
  const correr = src => vm.runInContext(src, ctx);
  return { ctx, el, ids, cuerpo, cuerpoDer, correr, llamadas };
}

// Granel con dos presentaciones (una con bulto pesable) tal como lo arma el server; conPermiso = fila entera + costeoGranel (pisable con costeoGranel).
function granel({ conPermiso, costeoGranel = {} }) {
  const vinculos = [{ plu: '201', nombre: 'Almendras Bulto x6', basePlu: '101', cantidad: 6, tipo: 'bulto' }];
  const v = new Map([['101', 1950], ['102', 1500], ['201', 9000]]);
  const [g] = L.listadoFraccionado({
    grupos: [{ plu: '100', nombre: 'Almendras', presentaciones: [{ plu: '101', nombre: 'Almendras 500G' }, { plu: '102', nombre: 'Almendras 1Kg' }] }],
    costos: new Map([['100', { costoSistema: 1000 }]]), vigentes: v,
    mayoristasDe: L.crearMayoristasDe({ vinculos, vigentes: v, ventaPesable: { 201: { modo: 'kg' } } }), costeo: {}, cfg: CFG,
  });
  if (!conPermiso) return L.filaPublica(g);
  return { ...g, costoManual: 1100, costeoGranel: { maquinaId: null, maquina: null, minKgPropio: null, minKgSubrubro: 2, minKgOrigen: 'subrubro', subrubroId: 7, subrubro: 'Frutos secos', ...costeoGranel } };
}
const abrir = (dom, tipo, fila, { sinConfig = false, detalle = false } = {}) => {
  dom.ctx.__fila = fila;
  dom.correr(`preciosSinConfig = ${sinConfig}; mdEsq = { tipo: ${JSON.stringify(tipo)}, fila: __fila }; mdFuente = 'sistema'; mdDetalle = ${detalle}; mdMpModo = 'fijo';`);
  dom.correr('pintarModalEsquema()');
};
const repetidos = ids => ids.filter((id, i) => ids.indexOf(id) !== i);

test('abrirModal: "doble" muestra la tarjeta derecha y el ancho de dos tarjetas; el siguiente modal sin "doble" vuelve al suyo y la oculta', () => {
  const dom = crearContexto();
  const caja = dom.el('mDetCaja').classList, der = dom.el('mDetDer').classList;
  const estado = () => [caja.contains('md-doble'), caja.contains('max-w-3xl'), caja.contains('max-w-2xl'), der.contains('hidden')];
  dom.correr("abrirModal('Fraccionado', 'doble')");
  assert.deepStrictEqual(estado(), [true, true, false, false]);
  assert.match(dom.cuerpoDer(), /Cargando/); // las dos tarjetas cargan a la vez: no salta el layout al pintar
  dom.correr("abrirModal('Reventa', true)");
  assert.deepStrictEqual(estado(), [false, true, false, true]);
  assert.strictEqual(dom.cuerpoDer(), '');
  dom.correr("abrirModal('Fraccionado', 'doble'); abrirModal('Angosto')");
  assert.deepStrictEqual(estado(), [false, false, true, true]);
});

test('Fraccionado con precios-config: dos tarjetas con todos los bloques, ids únicos y cada guardado conectado', () => {
  const dom = crearContexto();
  abrir(dom, 'fraccionado', granel({ conPermiso: true }));
  const html = dom.cuerpo(), der = dom.cuerpoDer();
  assert.deepStrictEqual(repetidos(dom.ids()), []); // el costo manual está una sola vez (en su tarjeta), no también en "Costo del granel"
  // Izquierda (#mDetBody) en orden: resumen → tarjetas (con el costo manual adentro) → costo del granel (min/kg y máquina + costos) → margen → cómo se conforma (el estado en el listado se fija en Configuración › Subrubros).
  const pos = ['class="md-resumen"', 'id="mdCostos"', 'id="mdManual"', 'id="mdFr"', 'id="mdExtras"', 'id="mdVentas"', 'class="md-margen-prod md-paso"', 'id="mdDetCuerpo"']
    .map(t => { const i = html.indexOf(t); assert.ok(i >= 0, `falta ${t}`); return i; });
  assert.deepStrictEqual(pos, [...pos].sort((a, b) => a - b));
  assert.match(html, /<div class="md-fr-cols"><div class="md-fr-col"><section class="md-fr-sec md-paso"/); // debajo de las tarjetas: dos columnas
  assert.doesNotMatch(html, /id="mdVerDetalle"|Precios por canal|<table class="md-tabla md-fr-tabla/); // ni el botón ni la tabla por canal de Reventa/Producción, ni los precios (van a la derecha)
  // Derecha (#mDetDerBody): chips de variación y lista de presentaciones; el título y el subtítulo son del header de la tarjeta.
  assert.match(der, /^<div class="md-fr-chips">/);
  assert.match(der, /<ul class="md-fr-lista">/);
  assert.match(der, /Almendras 1Kg/);
  assert.doesNotMatch(html + der, /id="mdAct|md-activo|Estado en el listado/); // el estado se movió a Configuración › Subrubros
  assert.doesNotMatch(der, /id="mdCostos"|<h3|<table/); // (h4 sí: la tarjeta de los mayoristas del granel lleva su título)
  assert.strictEqual(dom.el('mDetDerSub').textContent, 'por kg · con costo sistema, para comparar');
  const fn = (id, prop = 'onclick') => typeof dom.el(id)[prop];
  assert.deepStrictEqual([fn('mdCostos', 'onchange'), fn('mdFrGuardar'), fn('mdManualGuardar'), fn('mdManualQuitar'), fn('mdExtrasGuardar'),
    fn('mdExtraAgregar'), fn('mdVentas'), fn('mdVentas', 'onchange'), fn('mdMargenGuardar'), fn('mdMargenIgualar'), fn('mdDetCuerpo', 'ontoggle')],
  Array(11).fill('function'));
});

// Modal didáctico (spec 2026-10-26): cada bloque es un paso con su título y una línea de para qué sirve; los números los pone un contador CSS
// (sin precios-config queda sólo el paso del costo), así que acá se prueba el orden y que cada encabezado traiga su propósito.
const pasos = html => [...html.matchAll(/<div class="md-paso-cab[^"]*">.*?<h4[^>]*>(.*?)<\/h4>.*?<p class="md-paso-para">(.*?)<\/p>/gs)].map(m => [m[1].replace(/<[^>]+>/g, '').trim(), m[2]]);

test('Fraccionado con precios-config: 3 pasos en orden, cada uno con título y para qué sirve; la tarjeta derecha es el resultado', () => {
  const dom = crearContexto();
  abrir(dom, 'fraccionado', granel({ conPermiso: true }));
  const p = pasos(dom.cuerpo());
  assert.deepStrictEqual(p.map(([t]) => t), ['¿Con qué costo calculo el precio nuevo?', 'Costo del granel · $/kg', 'Margen de este producto']);
  assert.ok(p.every(([, para]) => para.length > 20 && para.length < 140), 'una línea corta de para qué sirve en cada paso');
  assert.match(p[1][1], /costo elegido en el paso 1/);
  assert.match(dom.cuerpo(), /<fieldset class="md-dec md-paso"><legend class="sr-only">¿Con qué costo calculo el precio nuevo\?<\/legend>/); // el grupo de radios sigue con su leyenda
  assert.match(dom.cuerpo(), /<p class="md-guia">Seguí los pasos en orden\./);
  // Costo del granel: cada bloque con su subtítulo y su ayuda
  for (const t of ['>Tiempo, máquina y envase <span', '>Costos extra<', '>Venta de pack/bulto pesables<']) assert.ok(dom.cuerpo().includes(t), `falta ${t}`);
  assert.strictEqual((dom.cuerpo().match(/class="md-sb-ayuda/g) || []).length, 4); // tiempo y máquina (para qué sirve y qué se usa hoy), costos extra, venta de pack/bulto
  assert.match(dom.cuerpo(), /<label for="mdFrMinKg"[^>]*>Min por kg<\/label>/);
  assert.match(dom.cuerpo(), /<label for="mdFrMaquina"[^>]*>Máquina<\/label>/);
});

// Bloque "Tiempo y máquina" del granel (spec 2026-10-29): min/kg propio (vacío = hereda, se ve el heredado) y máquina con "Sin máquina" por defecto.
const bloqueTiempo = html => html.match(/<div class="md-edicion" id="mdFr">.*?<p id="mdFrMsg"[^>]*><\/p><\/div>/s)[0];
const bloque = costeoGranel => { const dom = crearContexto(); abrir(dom, 'fraccionado', granel({ conPermiso: true, costeoGranel })); return { dom, html: bloqueTiempo(dom.cuerpo()) }; };

test('Fraccionado con precios-config: "Tiempo y máquina" hereda del subrubro (input vacío, valor heredado visible) y no habla de facilidad ni de máquina del subrubro', () => {
  const { html } = bloque({});
  assert.match(html, /<input id="mdFrMinKg" type="number" min="0" max="600" step="any" value=""[^>]*aria-describedby="mdFrAyuda"/);
  assert.match(html, /por 1 kg/);                                             // el valor es por kilo
  assert.match(html, /ajuste[^<]*tramo[^<]*se suma encima/);                  // y el ajuste del tramo de cada presentación se suma encima
  assert.match(html, /<p id="mdFrAyuda" class="md-sb-ayuda[^"]*">Hoy se usa 2 min\/kg, del subrubro Frutos secos\. Vacío = hereda 2 min\/kg del subrubro Frutos secos\./);
  assert.match(html, /<option value="">Sin máquina<\/option>/);                 // sin máquina es lo normal: primera opción, elegida sin atributo
  assert.doesNotMatch(html.match(/<select id="mdFrMaquina".*?<\/select>/s)[0], /<option[^>]*selected/);
  assert.match(html, /<select id="mdFrEnvase"[^>]*><option value="bolsa" selected>Bolsa \(por defecto\)<\/option><option value="bobina">Bobina<\/option><\/select>/); // sin elegir = bolsa
  assert.doesNotMatch(html, /facilidad|Del subrubro \(|sin subrubro: no suma/i);
  assert.match(html, /<button type="button" id="mdFrGuardar"/);
  assert.match(html, /id="mdFrMsg"[^>]*role="status"[^>]*aria-live="polite"/);
});

test('Fraccionado con precios-config: min/kg propio (0 incluido) llena el input y la ayuda dice cuál manda; sin min/kg avisa que no suma MO', () => {
  assert.match(bloque({ minKgPropio: 4, minKgOrigen: 'granel' }).html, /value="4"[^>]*aria-describedby[\s\S]*Hoy se usa 4 min\/kg, propio de este producto\. Vacío = hereda 2 min\/kg del subrubro Frutos secos\./);
  assert.match(bloque({ minKgPropio: 0, minKgOrigen: 'granel' }).html, /value="0"[\s\S]*Hoy se usa 0 min\/kg, propio de este producto\./);   // 0 es un valor, no "vacío"
  const sin = bloque({ minKgSubrubro: null, minKgOrigen: null }).html;
  assert.match(sin, /value=""/);
  assert.match(sin, /Hoy no hay min\/kg: sin minutos no suma mano de obra ni máquina\. Vacío = hereda el del subrubro Frutos secos, que todavía no tiene min\/kg\./);
});

test('Fraccionado con precios-config: sin subrubro en SIGA el min/kg y la máquina siguen editables (ya no dependen del subrubro)', () => {
  const html = bloque({ subrubroId: null, subrubro: null, minKgSubrubro: null, minKgOrigen: null }).html;
  assert.match(html, /sin subrubro en SIGA/);
  assert.doesNotMatch(html, /<(input|select)[^>]*disabled/);
});

test('Fraccionado con precios-config: la máquina del granel viene seleccionada (escapada) y Guardar manda { minKg, maquinaId } con null para vacío', () => {
  const { dom, html } = bloque({ maquinaId: 'env', maquina: 'Envasadora <A>' });
  assert.match(html, /<option value="">Sin máquina<\/option><option value="env" selected>Envasadora &lt;A&gt;<\/option>/);
  const enviados = [];
  dom.correr('guardarCostoEsq = (...a) => { __llamadas.push(a); return Promise.resolve(true); }');
  dom.ctx.__llamadas = enviados;
  const guardar = (minKg, maquina) => { dom.el('mdFrMinKg').value = minKg; dom.el('mdFrMaquina').value = maquina; dom.el('mdFrGuardar').onclick(); };
  guardar('', '');
  guardar('1,5', 'env');
  guardar('0', '');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(enviados)), [ // JSON: los objetos nacen en el contexto vm (otro realm)
    ['/api/precios/config/esquema/fraccionado/granel/100', { minKg: null, maquinaId: null, envase: 'bolsa' }, 'PUT', 'mdFrMsg'],
    ['/api/precios/config/esquema/fraccionado/granel/100', { minKg: 1.5, maquinaId: 'env', envase: 'bolsa' }, 'PUT', 'mdFrMsg'],
    ['/api/precios/config/esquema/fraccionado/granel/100', { minKg: 0, maquinaId: null, envase: 'bolsa' }, 'PUT', 'mdFrMsg']]);
});

test('Fraccionado con precios-config: un min/kg inválido no se envía; el error queda en el aviso (aria-live) y el foco vuelve al campo', () => {
  const { dom } = bloque({});
  const enviados = [];
  dom.ctx.__llamadas = enviados;
  dom.correr('guardarCostoEsq = (...a) => { __llamadas.push(a); return Promise.resolve(true); }');
  let foco = false;
  dom.el('mdFrMinKg').focus = () => { foco = true; };
  dom.el('mdFrMinKg').value = '601';
  dom.el('mdFrGuardar').onclick();
  assert.deepStrictEqual(enviados, []);
  assert.strictEqual(dom.el('mdFrMsg').textContent, 'Min por kg: un número de 0 a 600 (vacío = hereda el del subrubro)');
  assert.match(dom.el('mdFrMsg').className, /text-crit/);
  assert.strictEqual(foco, true);
});

test('Fraccionado sin precios-config: un solo paso (el costo), sin estado en el listado', () => {
  const dom = crearContexto();
  abrir(dom, 'fraccionado', granel({ conPermiso: false }), { sinConfig: true });
  assert.deepStrictEqual(pasos(dom.cuerpo()).map(([t]) => t), ['¿Con qué costo calculo el precio nuevo?']);
  assert.doesNotMatch(dom.cuerpo(), /id="mdAct|Estado en el listado/);
  assert.doesNotMatch(dom.cuerpo(), /md-fr-cols|md-margen-prod/);
});

test('Fraccionado: cada tarjeta de costo lleva su acento, el cuándo conviene y el costo por kg; sólo la elegida dice "Elegida"', () => {
  const dom = crearContexto();
  abrir(dom, 'fraccionado', { ...granel({ conPermiso: true }), decision: { fuente: 'sistema' } });
  const tarjetas = [...dom.cuerpo().matchAll(/<label class="md-opc([^"]*)">((?:(?!<\/label>).)*)<\/label>/gs)].map(m => ({ clases: m[1], html: m[2] }));
  assert.deepStrictEqual(tarjetas.map(t => t.clases.trim().split(' ')[0]), ['md-f-ninguna', 'md-f-sistema', 'md-f-ultimaCompra', 'md-f-manual', 'md-f-precio']); // 5ta: Precio fijo (precioSiempre), acento propio
  for (const t of tarjetas) assert.match(t.html, /<span class="md-opc-cuando">Conviene si /);
  assert.match(tarjetas[1].html, /Costo <b class="tabular-nums">\$ 1\.000,00<\/b><span class="md-u">\/kg<\/span>/);
  assert.deepStrictEqual(tarjetas.map(t => /✓ Elegida/.test(t.html)), [false, true, false, false, false]);
  assert.match(tarjetas[1].clases, /\bsel\b/);
  assert.match(tarjetas[1].html, /Cambio promedio en 2 presentaciones/); // el chip no repite "prom." (lo dice la leyenda)
  assert.doesNotMatch(tarjetas[1].html, /prom\./);
  const una = crearContexto(), fila = granel({ conPermiso: true });
  abrir(una, 'fraccionado', { ...fila, presentaciones: fila.presentaciones.slice(0, 1) });
  assert.match(una.cuerpo(), /Cambio promedio en 1 presentación</); // singular
});

// El costo manual se carga y se elige desde la misma tarjeta de decisión (antes el campo estaba en "Costo del granel").
const tarjetaManual = html => html.match(/<label class="md-opc[^"]*">(?:(?!<\/label>).)*value="manual"(?:(?!<\/label>).)*<\/label>/s)[0];

test('Fraccionado con precios-config: la tarjeta "Costo manual" trae el campo y Guardar; Quitar sólo si ya hay costo manual', () => {
  const dom = crearContexto();
  abrir(dom, 'fraccionado', granel({ conPermiso: true })); // costoManual 1100
  let tj = tarjetaManual(dom.cuerpo());
  assert.match(tj, /<input id="mdManual" type="number"[^>]*value="1100"/);
  assert.match(tj, /id="mdManualGuardar"[^>]*>Guardar<\/button>/);
  assert.match(tj, /id="mdManualQuitar"/);
  assert.match(dom.cuerpo(), /id="mdCostos" class="md-opcs" style="--n:5"/);
  assert.strictEqual(typeof dom.el('mdManual').onkeydown, 'function'); // Enter guarda
  // Sin costo manual la tarjeta sigue estando (campo vacío para cargarlo), sin Quitar y sin poder elegirse todavía.
  const dom2 = crearContexto();
  abrir(dom2, 'fraccionado', { ...granel({ conPermiso: true }), costoManual: null });
  tj = tarjetaManual(dom2.cuerpo());
  assert.match(tj, /<input id="mdManual" type="number"[^>]*value=""/);
  assert.match(tj, /id="mdManualGuardar"/);
  assert.doesNotMatch(tj, /mdManualQuitar/);
  assert.match(tj, /<input type="radio" name="mdCosto" value="manual" disabled>/);
  assert.match(dom2.cuerpo(), /style="--n:5"/);
  assert.deepStrictEqual(repetidos(dom2.ids()), []);
  assert.strictEqual(typeof dom2.el('mdManualGuardar').onclick, 'function');
});

test('Fraccionado sin precios-config: la tarjeta "Costo manual" no trae el campo (sólo el valor si ya hay uno); sin costo manual no hay tarjeta', () => {
  const dom = crearContexto();
  abrir(dom, 'fraccionado', { ...granel({ conPermiso: false }), costoManual: 1100 }, { sinConfig: true });
  const tj = tarjetaManual(dom.cuerpo());
  assert.match(tj, /Costo <b class="tabular-nums">\$ 1\.100,00<\/b>/);
  assert.doesNotMatch(dom.cuerpo(), /id="mdManual|<input id="mdManual/);
  const sin = crearContexto();
  abrir(sin, 'fraccionado', granel({ conPermiso: false }), { sinConfig: true });
  assert.doesNotMatch(sin.cuerpo(), /value="manual"|id="mdManual/);
  assert.match(sin.cuerpo(), /style="--n:4"/);
});

test('Fraccionado: el acordeón respeta mdDetalle al repintar y lo actualiza al abrirse', () => {
  const dom = crearContexto();
  abrir(dom, 'fraccionado', granel({ conPermiso: true }), { detalle: true });
  assert.match(dom.cuerpo(), /<details id="mdDetCuerpo" class="acordeon md-fr-detalle" open>/);
  assert.match(dom.cuerpo(), /Costo real por presentación/);
  abrir(dom, 'fraccionado', granel({ conPermiso: true }));
  assert.doesNotMatch(dom.cuerpo(), /<details[^>]* open>/);
  const det = dom.el('mdDetCuerpo');
  det.open = true; det.ontoggle();
  assert.strictEqual(dom.correr('mdDetalle'), true);
});

test('Fraccionado sin precios-config: tarjetas y precios; sin bloques de configuración ni claves ocultas', () => {
  const dom = crearContexto();
  const fila = granel({ conPermiso: false });
  assert.ok(!('costeoGranel' in fila) && !('costosExtra' in fila));
  abrir(dom, 'fraccionado', fila, { sinConfig: true });
  const html = dom.cuerpo();
  for (const t of ['id="mdCostos"']) assert.ok(html.includes(t), `falta ${t}`);
  assert.ok(dom.cuerpoDer().includes('Almendras 1Kg'), 'faltan los precios en la tarjeta derecha');
  for (const t of ['id="mdFr"', 'id="mdManual"', 'id="mdExtras"', 'id="mdDetCuerpo"', 'md-margen-prod', 'Costo del granel', 'md-fr-cols', 'id="mdAct', 'Estado en el listado']) assert.ok(!html.includes(t), `sobra ${t}`);
  assert.strictEqual(typeof dom.el('mdCostos').onchange, 'function');
});

test('Fraccionado: elegir un costo en las tarjetas guarda la decisión del granel', async () => {
  const dom = crearContexto();
  abrir(dom, 'fraccionado', granel({ conPermiso: true }));
  dom.el('mdCostos').onchange({ target: { name: 'mdCosto', value: 'sistema' } });
  await new Promise(r => setImmediate(r));
  assert.deepStrictEqual(dom.llamadas[0], ['guardarDecision', '100', 'sistema']);
});

test('Reventa y Producción no cambian: tabla por canal con "Minorista", "Ver detalle" y sin columnas de Fraccionado', () => {
  const fila = { plu: '500', nombre: 'Yerba', vigente: 1000, costoSistema: 800, mayoristas: [],
    sugeridos: { sistema: { minorista: { precio: 1100, deltaPct: 10, estado: 'subir', margenTotalPct: 30 } } } };
  for (const tipo of ['almacen', 'produccion']) {
    const dom = crearContexto();
    abrir(dom, tipo, fila);
    const html = dom.cuerpo();
    assert.match(html, /Precios por canal/, tipo);
    assert.match(html, /<b>Minorista<\/b> <span class="md-sub">PLU 500<\/span>/, tipo);
    assert.match(html, /id="mdVerDetalle"/, tipo);
    assert.doesNotMatch(html, /md-fr|Granel ·|mdAct/, tipo);
    assert.doesNotMatch(html, /md-paso|md-f-|md-opc-cuando|md-guia|md-sb-|Elegida|sr-only/, tipo); // el modal didáctico es sólo de Fraccionado
    assert.match(html, /<fieldset class="md-dec"><legend class="md-h">/, tipo); // la decisión sigue con su leyenda visible
    assert.strictEqual(dom.cuerpoDer(), '', tipo); // sin tarjeta derecha
    assert.strictEqual(typeof dom.el('mdVerDetalle').onclick, 'function', tipo);
  }
});

// Vigente 0 en SIGA: el server lo toma como "sin vigente" (compararConVigente: Δ % null, estado null) y el resumen lo cuenta así,
// pero el Δ $ muestra el sugerido entero ("+$ 1.950").
test('deltaPesosMd: vigente 0 cuenta como sin vigente, igual que el Δ %', () => {
  assert.strictEqual(deltaPesosMd(0, 1950), null);
});

// Acordeón "Cómo se conforma el costo y el precio": panel con el lenguaje de los pasos (encabezado con su título, para qué sirve y la marca "Detalle") y dos
// apartados, A costo real y B precio, cada uno con su banda y una mini-tarjeta por presentación.
test('Fraccionado: el acordeón es un panel con dos apartados (A costo real, B precio) y una mini-tarjeta con su cuenta por presentación', () => {
  const dom = crearContexto();
  abrir(dom, 'fraccionado', granel({ conPermiso: true }), { detalle: true });
  const html = dom.cuerpo(), det = html.slice(html.indexOf('<details id="mdDetCuerpo"'));
  assert.match(det, /<summary><span class="caret" aria-hidden="true">▶<\/span><span class="md-det-tit"><span class="md-h">Cómo se conforma el costo y el precio<\/span>/);
  assert.match(det, /<span class="md-det-para">Sólo para revisar, no cambia nada: /);
  assert.match(det, /<span class="md-det-tag"><svg[^>]*aria-hidden="true">.*<\/svg>Detalle<\/span><\/summary>/);
  const aps = [...det.matchAll(/<section class="md-dt-sec" aria-labelledby="(\w+)"><div class="md-dt-sec-cab"><span class="md-dt-letra" aria-hidden="true">(\w)<\/span><h5 id="\1" class="md-h">(.*?)<\/h5><p class="md-dt-para">(.*?)<\/p>/g)];
  assert.deepStrictEqual(aps.map(m => [m[2], m[3]]), [['A', 'Costo real por presentación'], ['B', 'Cómo se calcula el precio']]);
  assert.ok(aps.every(m => m[4].length > 30 && m[4].length < 140), 'una línea corta de para qué sirve en cada apartado');
  const [a, b] = det.split('<section class="md-dt-sec"').slice(1);
  const tarjetas = h => [...h.matchAll(/<li class="md-dt-card[^"]*"><div class="md-dt-cab"><b>(.*?)<\/b>/g)].map(m => m[1]);
  assert.deepStrictEqual(tarjetas(a), ['Almendras 500G', 'Almendras 1Kg']);        // costo: una por presentación
  assert.deepStrictEqual(tarjetas(b), ['Almendras 500G', 'Almendras 1Kg']);        // precio: una por presentación (el bulto del fixture es de la 500G, no del granel)
  assert.match(a, /<div class="md-cu-f md-cu-tot"><span class="md-cu-op" aria-hidden="true">=<\/span><span class="md-cu-t">Costo real \$\/kg<\/span>/);
  assert.match(b, /<div class="md-cu-f md-cu-tot"><span class="md-cu-op" aria-hidden="true">=<\/span><span class="md-cu-t">Precio redondeado<\/span>/);
  assert.match(b, /<div class="md-dt-canal"><b>Bulto<\/b> <span class="md-sub">PLU 201 · × 1<\/span>/); // × unidades que vende el bulto (en el fixture, 1 por kg)
  assert.match(b, /Con IVA redondeado/);
  assert.doesNotMatch(det, /class="md-paso|<h4|<table|class="ec"/);               // no es un paso numerado (el contador CSS no lo cuenta) ni usa los renglones planos de antes
  assert.strictEqual(typeof dom.el('mdDetCuerpo').ontoggle, 'function');
});

test('Fraccionado: sin costeo del granel el acordeón sólo trae el precio (sin letra) y con otra fuente sin desglose lo avisa', () => {
  const dom = crearContexto();
  const fila = granel({ conPermiso: true });
  abrir(dom, 'fraccionado', { ...fila, costeoGranel: undefined }, { detalle: true });
  const det = dom.cuerpo().slice(dom.cuerpo().indexOf('<details id="mdDetCuerpo"'));
  assert.doesNotMatch(det, /Costo real por presentación|md-dt-letra/);
  assert.match(det, /<h5 id="mdDetPrecioH" class="md-h">Cómo se calcula el precio<\/h5>/);
  dom.correr("mdFuente = 'ultimaCompra'; pintarModalEsquema()");
  const sin = dom.cuerpo().slice(dom.cuerpo().indexOf('<details id="mdDetCuerpo"'));
  assert.match(sin, /<p class="md-dt-vacio">Sin desglose para esta fuente\.<\/p>/);
  assert.doesNotMatch(sin, /md-dt-card/);
});

test('Reventa y Producción: el "Ver detalle" sigue con sus bloques de pasos (Minorista, pack/bulto) y sin cuentas de Fraccionado', () => {
  const des = { error: null, costo: 800, gastosPct: 10, costoConGastos: 880, pack: null, bulto: null,
    minorista: { margenPct: 40, neto: 1232, extrasPct: 5, conExtras: 1293.6, ivaPct: 21, exacto: 1565.26, precio: 1550 },
    porVinculo: { 501: { margenPct: 30, netoUnidad: 1144, unidades: 6, exactoNeto: 6864, neto: 6850, exactoIva: 8288.5, conIva: 8300 } } };
  const fila = { plu: '500', nombre: 'Yerba', vigente: 1000, costoSistema: 800, mayoristas: [{ tipo: 'pack', plu: '501', nombre: 'Yerba x6', unidades: 6, vigente: 8000 }],
    sugeridos: { sistema: { minorista: { precio: 1550, deltaPct: 55, estado: 'subir', margenTotalPct: 40 },
      mayoristas: [{ plu: '501', neto: 6850, conIva: 8300, deltaPct: 5, estado: 'subir', margenTotalNetoPct: 30, margenTotalIvaPct: 35 }], desglose: des } } };
  for (const tipo of ['almacen', 'produccion']) {
    const dom = crearContexto();
    abrir(dom, tipo, fila);
    const cuerpo = dom.cuerpo(), bloque = t => cuerpo.match(new RegExp(`<div class="md-bloque"><div class="lbl mb-1">${t}</div>(.*?)</div></div>(?=<div class="md-bloque">|</div>)`, 's'));
    assert.match(cuerpo, /<div class="md-desglose">/, tipo);
    assert.deepStrictEqual([...cuerpo.matchAll(/<div class="lbl mb-1">(.*?)<\/div>/g)].map(m => m[1]).filter(t => !/Costos extra/.test(t)), ['Minorista', 'Pack 501 (× 6)'], tipo);
    assert.match(bloque('Minorista')[0], /Costo de mercadería.*Gastos variables 10 %.*Margen 40 %.*Extras minoristas 5 %.*IVA 21 %.*Precio redondeado/s, tipo);
    assert.match(bloque('Pack 501 \\(× 6\\)')[0], /Costo con gastos.*Margen 30 %.*6 unidades.*Sin IVA redondeado.*Con IVA redondeado/s, tipo);
    assert.doesNotMatch(cuerpo, /md-cu|md-dt-/, tipo);
  }
});

// "Margen de este producto": sólo Margen fijo y Ajuste ± en los tres tipos (el precio fijo de Reventa es la quinta card del selector de costo).
const reventaConDesglose = () => {
  const vig = new Map();
  return L.filaPublica(L.listadoReventa({ universo: [{ plu: '1', nombre: 'Arroz', costoSistema: 1000 }], vigentes: vig,
    mayoristasDe: L.crearMayoristasDe({ vinculos: [], vigentes: vig }), costeo: {}, cfg: CFG })[0], true);
};
const modosMargenProducto = html => [...html.matchAll(/class="seg-opt md-mp-modo" data-modo="(\w+)"/g)].map(m => m[1]);

test('Margen de este producto: Reventa, Fraccionado y Producción ofrecen sólo Margen fijo y Ajuste ±', () => {
  for (const [tipo, fila] of [['almacen', reventaConDesglose()], ['produccion', reventaConDesglose()], ['fraccionado', granel({ conPermiso: true })]]) {
    const dom = crearContexto();
    abrir(dom, tipo, fila);
    assert.deepStrictEqual(modosMargenProducto(dom.cuerpo()), ['fijo', 'ajuste'], tipo);
  }
});

test('Margen de este producto: campoU lleva la unidad al final (sin "$" antes del campo) y no hay aria-describedby de margen', () => {
  const casos = [['almacen', 'fijo', 'Margen %'], ['almacen', 'ajuste', '+ pts %'], ['fraccionado', 'ajuste', '+ pts %']];
  for (const [tipo, modo, unidad] of casos) {
    const dom = crearContexto();
    const llamadas = [];
    dom.ctx.campoU = (input, u, opc = {}) => { if (input.includes('md-mp-in')) llamadas.push([u, !!opc.pre]); return input; }; // sólo los campos del margen
    abrir(dom, tipo, tipo === 'fraccionado' ? granel({ conPermiso: true }) : reventaConDesglose());
    llamadas.length = 0;
    dom.correr(`mdMpModo = '${modo}'; pintarModalEsquema()`);
    assert.deepStrictEqual(llamadas, Array(3).fill([unidad, false]), `${tipo} ${modo}`);
    assert.ok(!dom.cuerpo().includes('aria-describedby="mdMpMargen-'), `${tipo} ${modo}`);
  }
});

// ── Chip del historial del producto, junto a su min/kg propio (spec 2026-10-29 E2): sólo con precios-config, una carga para todo el módulo ──
const historialDe = productos => ({ cargas: { total: 20, usadas: 12, descartes: {} }, minMuestras: 5, productos, subrubros: {}, tramos: [], distribucion: {} });
const ESPERAR = () => new Promise(res => setImmediate(res));
// getJson responde el historial en su URL (y lo de siempre en las demás); pedidos = las URLs que se pidieron.
function conHistorial(dom, respuesta) {
  const pedidos = [];
  dom.ctx.getJson = url => { pedidos.push(url); return url.endsWith('/historial') ? respuesta() : Promise.resolve({ maquinas: [] }); };
  dom.ctx.Event = Event;
  return pedidos;
}
const pedidosHistorial = p => p.filter(u => u.endsWith('/fraccionado/historial'));

test('Fraccionado con precios-config: junto al min/kg propio va el chip del historial de ESE producto, con su "Usar"', async () => {
  const dom = crearContexto();
  const pedidos = conHistorial(dom, () => Promise.resolve(historialDe({ 100: { n: 12, mediana: 6.4, p25: 5, p75: 8, subrubroId: '7', pocosDatos: false }, 999: { n: 30, mediana: 1, p25: 1, p75: 1, subrubroId: null, pocosDatos: false } })));
  abrir(dom, 'fraccionado', granel({ conPermiso: true }));
  assert.match(dom.cuerpo(), /<div id="mdFrHist" class="hf-modal"><\/div>/); // el lugar del chip, vacío hasta que llega
  assert.deepStrictEqual(repetidos(dom.ids()), []);
  await ESPERAR();
  const slot = dom.el('mdFrHist').innerHTML;
  assert.match(slot, /Historial: 6,4 por 1 kg · 12 cargas/);
  assert.doesNotMatch(slot, /30 cargas/); // el de otro producto, no
  assert.match(slot, /data-hf-valor="6\.4"/);
  assert.match(slot, /aria-label="Usar 6,4 min\/kg como min\/kg propio de este producto"/);
  assert.strictEqual(pedidosHistorial(pedidos).length, 1);
  assert.strictEqual(typeof dom.el('mdFrHist').onclick, 'function');
});

test('Fraccionado con precios-config: "Usar" rellena el Min por kg y avisa que falta Guardar; no guarda nada', async () => {
  const dom = crearContexto();
  const pedidos = conHistorial(dom, () => Promise.resolve(historialDe({ 100: { n: 12, mediana: 6.4, p25: 5, p75: 8, subrubroId: '7', pocosDatos: false } })));
  const eventos = [];
  dom.ctx.fetch = (url, opts) => { eventos.push([url, opts && opts.method]); return Promise.resolve({ json: () => Promise.resolve({}) }); };
  abrir(dom, 'fraccionado', granel({ conPermiso: true }));
  await ESPERAR();
  const input = dom.el('mdFrMinKg');
  input.dispatchEvent = e => eventos.push(['evento', e.type]);
  const usar = { dataset: { hfValor: '6.4' } };
  dom.el('mdFrHist').onclick({ target: { closest: s => (s === '.hf-usar' ? usar : null) } });
  assert.strictEqual(input.value, '6.4');
  assert.match(dom.el('mdFrMsg').textContent, /falta Guardar/);
  assert.deepStrictEqual(eventos, [['evento', 'input']]); // ni un solo pedido: se guarda con el Guardar del bloque
  assert.deepStrictEqual(pedidos.filter(u => u.includes('/granel/')), []);
});

test('Fraccionado con precios-config: con pocos datos el chip dice "pocos datos" sin "Usar"; sin entrada del producto no muestra nada', async () => {
  const poco = crearContexto();
  conHistorial(poco, () => Promise.resolve(historialDe({ 100: { n: 2, mediana: null, p25: null, p75: null, subrubroId: '7', pocosDatos: true } })));
  abrir(poco, 'fraccionado', granel({ conPermiso: true }));
  await ESPERAR();
  assert.match(poco.el('mdFrHist').innerHTML, />pocos datos</);
  assert.doesNotMatch(poco.el('mdFrHist').innerHTML, /hf-usar/);
  const sin = crearContexto();
  conHistorial(sin, () => Promise.resolve(historialDe({ 555: { n: 9, mediana: 2, p25: 1, p75: 3, subrubroId: null, pocosDatos: false } })));
  abrir(sin, 'fraccionado', granel({ conPermiso: true }));
  await ESPERAR();
  assert.strictEqual(sin.el('mdFrHist').innerHTML, '');
});

test('Fraccionado con precios-config: el historial se pide UNA vez para todo el módulo, aunque se abran varios modales', async () => {
  const dom = crearContexto();
  const pedidos = conHistorial(dom, () => Promise.resolve(historialDe({ 100: { n: 12, mediana: 6.4, p25: 5, p75: 8, subrubroId: '7', pocosDatos: false } })));
  abrir(dom, 'fraccionado', granel({ conPermiso: true }));
  abrir(dom, 'fraccionado', granel({ conPermiso: true })); // repintado con la primera carga todavía en vuelo
  await ESPERAR();
  abrir(dom, 'fraccionado', granel({ conPermiso: true })); // ya cargado: el chip sale en el mismo pintado, sin pedir
  assert.match(dom.el('mdFrHist').innerHTML, /Historial: 6,4 por 1 kg/);
  assert.strictEqual(pedidosHistorial(pedidos).length, 1);
});

test('Fraccionado con precios-config: si el historial falla el modal sigue andando, sin chip', async () => {
  const dom = crearContexto();
  conHistorial(dom, () => Promise.reject(new Error('Sin permiso para la configuración de precios')));
  abrir(dom, 'fraccionado', granel({ conPermiso: true }));
  await ESPERAR();
  assert.strictEqual(dom.el('mdFrHist').innerHTML, '');
  assert.match(dom.cuerpo(), /id="mdFrGuardar"/);
  assert.strictEqual(typeof dom.el('mdFrGuardar').onclick, 'function');
});

test('Fraccionado sin precios-config: ni chip ni botones ni pedido del historial', async () => {
  const dom = crearContexto();
  const pedidos = conHistorial(dom, () => Promise.resolve(historialDe({ 100: { n: 12, mediana: 6.4, p25: 5, p75: 8, subrubroId: '7', pocosDatos: false } })));
  abrir(dom, 'fraccionado', granel({ conPermiso: false }), { sinConfig: true });
  await ESPERAR();
  assert.doesNotMatch(dom.cuerpo() + dom.cuerpoDer(), /hf-|Historial|mdFrHist/); // 'Usar' suelto no: la card de precio fijo es pública (el del historial es .hf-usar, cubierto por hf-)
  assert.strictEqual(pedidosHistorial(pedidos).length, 0);
  assert.strictEqual(pedidos.length, 0);
});

test('Fraccionado con precios-config: granel en bobina → el select viene en Bobina y Guardar manda envase "bobina"', () => {
  // Arrange
  const { dom, html } = bloque({ envase: 'bobina' });
  const enviados = [];
  dom.ctx.__llamadas = enviados;
  dom.correr('guardarCostoEsq = (...a) => { __llamadas.push(a); return Promise.resolve(true); }');
  // Act
  dom.el('mdFrMinKg').value = ''; dom.el('mdFrMaquina').value = ''; dom.el('mdFrEnvase').value = 'bobina';
  dom.el('mdFrGuardar').onclick();
  // Assert
  assert.match(html, /<option value="bobina" selected>Bobina<\/option>/);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(enviados))[0][1], { minKg: null, maquinaId: null, envase: 'bobina' });
});

test('repintarModalCompletoFraccMd: repinta las dos tarjetas con el detalle nuevo, conserva el borrador sin guardar, el scroll y el foco en el botón elegido', () => {
  const dom = crearContexto();
  dom.ctx.Event = Event;
  const eventos = [];
  const campo = (id, value, defaultValue) => Object.assign(dom.el(id), { type: 'text', value, defaultValue, dispatchEvent: e => eventos.push([id, e.type]) });
  dom.el('mDetBody').innerHTML = '<input id="mdManual"><input id="mdIntacto">';
  const manual = campo('mdManual', '55', '10'), intacto = campo('mdIntacto', 'a', 'a'); // 55 sin guardar, el otro como vino
  dom.el('mDetBody').querySelectorAll = () => [manual, intacto];
  dom.el('mDetBody').scrollTop = 120; dom.el('mDetDerBody').scrollTop = 40;
  const boton = { focus() { this.enfocado = true; }, enfocado: false };
  dom.el('mDetDerBody').contains = () => true;
  dom.ctx.document.activeElement = { id: '' };
  const fila = { dataset: { plu: '101' }, querySelector: sel => (sel.startsWith('.md-may[data-valor') ? boton : null) };
  dom.ctx.document.querySelectorAll = sel => (sel === '#mDetDerBody .md-may-fila' ? [fila] : []);
  dom.el('mDetBody').contains = () => false;
  let repintados = 0;
  dom.ctx.pintarModalFraccionadoMd = () => { repintados++; Object.assign(manual, { value: '10' }); dom.el('mDetBody').scrollTop = 0; dom.el('mDetDerBody').scrollTop = 0; }; // detalle nuevo: el valor vuelve al del server
  dom.correr("repintarModalCompletoFraccMd('101', true)");
  assert.equal(repintados, 1);
  assert.equal(manual.value, '55');                                  // borrador conservado
  assert.equal(intacto.value, 'a');
  assert.deepEqual(eventos, [['mdManual', 'input']]);                // sólo el sucio se avisa
  assert.equal(dom.el('mDetBody').scrollTop, 120);
  assert.equal(dom.el('mDetDerBody').scrollTop, 40);
  assert.equal(boton.enfocado, true);                                // foco en el botón elegido
});

// ── Card "Precio fijo" (spec precios_fraccionado_precio_fijo_card): costeo.precioFijo[pluPresentación].minorista = bolsa con IVA ──
// Granel 100: 500G (101, precio fijo 1199,99 si conPf), 1Kg (102), sin peso (103) y mayorista marcada (104).
function granelPf({ conPermiso = true, conPf = true } = {}) {
  const v = new Map([['101', 1950], ['102', 1500], ['103', 900], ['104', 9000]]);
  const [g] = L.listadoFraccionado({
    grupos: [{ plu: '100', nombre: 'Almendras', presentaciones: [{ plu: '101', nombre: 'Almendras 500G' }, { plu: '102', nombre: 'Almendras 1Kg' },
      { plu: '103', nombre: 'Almendras suelta' }, { plu: '104', nombre: 'Almendras 10Kg' }] }],
    costos: new Map([['100', { costoSistema: 1000 }]]), vigentes: v, mayoristasDe: L.crearMayoristasDe({ vinculos: [], vigentes: v }),
    costeo: conPf ? { precioFijo: { 101: { minorista: 1199.99 } }, decisiones: { 100: { fuente: 'precio' } } } : {}, cfg: CFG,
  });
  const fila = { ...g, presentaciones: g.presentaciones.map(p => (p.plu === '104' ? { ...p, mayorista: true, mayoristaTipo: 'bulto' } : p)) };
  return conPermiso ? fila : L.filaPublica(fila);
}
const abrirPf = (dom, fila, op) => { abrir(dom, 'fraccionado', fila, op); dom.correr("mdFuente = 'precio'; pintarModalEsquema()"); };
// fetch que anota cada PUT y responde respuestas[url] (GET del detalle → la misma fila).
function conPuts(dom, respuestas = {}) {
  const puts = [];
  dom.ctx.fetch = (url, opts = {}) => {
    if (opts.method) puts.push([opts.method, url, JSON.parse(opts.body)]);
    return Promise.resolve({ json: () => Promise.resolve(respuestas[url] || (opts.method ? {} : dom.ctx.__fila)) });
  };
  dom.ctx.abrirModal = () => {};
  return puts;
}

test('Precio fijo Fraccionado: un campo por presentación no mayorista con peso; nada para granel, sin peso ni mayorista', () => {
  const dom = crearContexto();
  abrirPf(dom, granelPf());
  const html = dom.cuerpo();
  assert.match(html, /id="mdPf-101"[^>]*value="1199.99"/);
  assert.match(html, /id="mdPf-102"[^>]*value=""/);
  for (const plu of ['100', '103', '104']) assert.ok(!html.includes(`id="mdPf-${plu}"`), plu);
  assert.match(html, /id="mdPfUsar"/);
  assert.match(html, /id="mdPfQuitar"/);
  assert.deepStrictEqual(repetidos(dom.ids()), []);
});

test('Precio fijo Fraccionado: sin ninguno guardado la card igual está (precioSiempre) y sin Quitar', () => {
  const dom = crearContexto();
  abrir(dom, 'fraccionado', granelPf({ conPf: false }));
  assert.match(dom.cuerpo(), /id="mdPf-101"[^>]*value=""/);
  assert.ok(!dom.cuerpo().includes('mdPfQuitar'));
});

test('Precio fijo Fraccionado: la bolsa se muestra tal cual se tipeó; $/kg = bolsa × 1000 / g', () => {
  const dom = crearContexto();
  abrirPf(dom, granelPf());
  assert.match(dom.cuerpoDer(), /Precio fijo de la bolsa \(con IVA\): <b>\$ 1\.199,99<\/b>/);
  assert.strictEqual(granelPf().presentaciones.find(x => x.plu === '101').sugeridos.precio.minorista.precio, 2399.98);
});

test('Precio fijo Fraccionado: margen en vivo sólo con precios-config', () => {
  const con = crearContexto();
  abrirPf(con, granelPf());
  con.el('mdPf-101').value = '1199.99';
  con.correr('conectarModalFraccionadoMd()');
  assert.match(con.el('mdPfMargen-101').textContent, /^Margen /);
  con.el('mdPf-102').value = '2000';
  con.el('mdPf-102').oninput();
  assert.match(con.el('mdPfMargen-102').textContent, /^Margen /);
  const sin = crearContexto();
  abrirPf(sin, granelPf({ conPermiso: false }), { sinConfig: true });
  assert.match(sin.cuerpo(), /id="mdPf-101"/); // el campo es público
  assert.ok(!sin.cuerpo().includes('mdPfMargen'));
});

test('Precio fijo Fraccionado: Usar guarda sólo lo cambiado por PUT precio-fijo/<plu> y después la decisión precio del granel', async () => {
  const dom = crearContexto();
  const puts = conPuts(dom);
  abrirPf(dom, granelPf());
  dom.el('mdPf-101').value = '1199.99'; // el stub no lee el value del HTML
  dom.correr('conectarModalFraccionadoMd()');
  dom.el('mdPf-102').value = '2500';
  await dom.el('mdPfUsar').onclick();
  assert.deepStrictEqual(puts, [['PUT', '/api/precios/precio-fijo/102', { minorista: 2500 }]]);
  assert.deepStrictEqual(dom.llamadas.at(-1), ['guardarDecision', '100', 'precio']);
});

test('Precio fijo Fraccionado: vaciar un campo lo borra (null) después de los cargados; todo vacío no guarda nada', async () => {
  const dom = crearContexto();
  const puts = conPuts(dom);
  abrirPf(dom, granelPf());
  dom.el('mdPf-101').value = '1199.99'; // el stub no lee el value del HTML
  dom.correr('conectarModalFraccionadoMd()');
  dom.el('mdPf-101').value = '';
  dom.el('mdPf-102').value = '2500';
  await dom.el('mdPfUsar').onclick();
  assert.deepStrictEqual(puts.map(p => [p[1], p[2]]), [['/api/precios/precio-fijo/102', { minorista: 2500 }], ['/api/precios/precio-fijo/101', { minorista: null }]]);
  const vacio = crearContexto();
  const p2 = conPuts(vacio);
  abrirPf(vacio, granelPf());
  vacio.el('mdPf-101').value = '1199.99';
  vacio.correr('conectarModalFraccionadoMd()');
  vacio.el('mdPf-101').value = '';
  vacio.el('mdPfUsar').onclick();
  assert.deepStrictEqual(p2, []);
  assert.match(vacio.el('mdDecMsg').innerHTML, /Cargá al menos un precio/);
});

test('Precio fijo Fraccionado: Quitar manda { minorista: null } por cada guardado y no elige decisión', async () => {
  const dom = crearContexto();
  const puts = conPuts(dom);
  abrirPf(dom, granelPf());
  dom.el('mdPf-101').value = '1199.99'; // el stub no lee el value del HTML
  dom.correr('conectarModalFraccionadoMd()');
  await dom.el('mdPfQuitar').onclick();
  assert.deepStrictEqual(puts, [['PUT', '/api/precios/precio-fijo/101', { minorista: null }]]);
  assert.ok(!dom.llamadas.some(l => l[0] === 'guardarDecision'));
});

test('Precio fijo Fraccionado: el {error} del server queda en el mensaje y no se elige la decisión', async () => {
  const dom = crearContexto();
  conPuts(dom, { '/api/precios/precio-fijo/102': { error: 'Una presentación mayorista no admite precio fijo' } });
  abrirPf(dom, granelPf());
  dom.el('mdPf-101').value = '1199.99'; // el stub no lee el value del HTML
  dom.correr('conectarModalFraccionadoMd()');
  dom.el('mdPf-102').value = '2500';
  await dom.el('mdPfUsar').onclick();
  assert.match(dom.el('mdDecMsg').innerHTML, /No se pudo guardar: Una presentación mayorista no admite precio fijo/);
  assert.ok(!dom.llamadas.some(l => l[0] === 'guardarDecision'));
});

test('Listado: badge $= en la presentación con precio fijo y en el granel con decisión precio; nada sin precio fijo', () => {
  const dom = crearContexto();
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/precios_listados.js'), 'utf8'), dom.ctx, { filename: 'precios_listados.js' });
  const badge = f => { dom.ctx.__x = f; return dom.correr('badgePrecioFijo(__x)'); };
  const g = granelPf({ conPermiso: false });
  assert.match(badge(g), /\$=/);
  assert.match(badge(g.presentaciones.find(p => p.plu === '101')), /title="Precio fijo del producto: [^"]+">\$=/);
  assert.strictEqual(badge(g.presentaciones.find(p => p.plu === '102')), '');
  assert.strictEqual(badge(granelPf({ conPermiso: false, conPf: false })), '');
});

test('Fraccionado: decisionPrecioSinVigente muestra el aviso (decision null) y sin la marca no hay aviso', () => {
  const dom = crearContexto();
  abrir(dom, 'fraccionado', { ...granel({ conPermiso: true }), decision: null, decisionPrecioSinVigente: true });
  assert.match(dom.cuerpo(), /<div class="md-aviso" role="note">La decisión de precio fijo quedó sin presentación vigente/);
  abrir(dom, 'fraccionado', granel({ conPermiso: true }));
  assert.doesNotMatch(dom.cuerpo(), /sin presentación vigente/);
});
