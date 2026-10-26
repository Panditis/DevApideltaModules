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
        focus() {}, setAttribute() {}, addEventListener() {}, scrollIntoView() {}, insertAdjacentHTML() {},
        querySelector: () => el(`${id}>*`), querySelectorAll: () => [] });
    }
    return elementos.get(id);
  };
  const FIJOS = ['mDet', 'mDetPar', 'mDetCaja', 'mDetTitulo', 'mDetSub', 'mDetBody', 'mDetX', 'mDetDer', 'mDetDerTitulo', 'mDetDerSub', 'mDetDerBody'];
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
    renderListado() {}, cargarListado() {}, refrescarAlertasProduccion() {}, salirDeProduccion() {}, activarTab() {},
    guardarTipoProveedor: () => Promise.resolve(), guardarActivoManual: () => Promise.resolve(null), conActivoManual: (f, a) => ({ ...f, activoManual: a }),
  });
  ctx.self = ctx; // lib/precios_esquema.js (UMD, /js/precios_esquema.js en la página) publica self.PreciosEsquema
  for (const f of ['../../lib/precios_esquema.js', 'precios_comun.js', 'precios_modal_esquema.js', 'precios_modal_fraccionado.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js', f), 'utf8'), ctx, { filename: path.basename(f) });
  }
  const correr = src => vm.runInContext(src, ctx);
  return { ctx, el, ids, cuerpo, cuerpoDer, correr, llamadas };
}

// Granel con dos presentaciones (una con bulto pesable) tal como lo arma el server; conPermiso = fila entera + costeoGranel.
function granel({ conPermiso }) {
  const vinculos = [{ plu: '201', nombre: 'Almendras Bulto x6', basePlu: '101', cantidad: 6, tipo: 'bulto' }];
  const v = new Map([['101', 1950], ['102', 1500], ['201', 9000]]);
  const [g] = L.listadoFraccionado({
    grupos: [{ plu: '100', nombre: 'Almendras', presentaciones: [{ plu: '101', nombre: 'Almendras 500G' }, { plu: '102', nombre: 'Almendras 1Kg' }] }],
    costos: new Map([['100', { costoSistema: 1000 }]]), vigentes: v,
    mayoristasDe: L.crearMayoristasDe({ vinculos, vigentes: v, ventaPesable: { 201: { modo: 'kg' } } }), costeo: {}, cfg: CFG,
  });
  if (!conPermiso) return L.filaPublica(g);
  return { ...g, costoManual: 1100, costeoGranel: { maquinaId: null, maquina: null, maquinaOrigen: 'subrubro', maquinaSubrubro: 'Envasadora', subrubroId: 7, subrubro: 'Frutos secos' } };
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
  // Izquierda (#mDetBody) en orden: resumen → tarjetas (con el costo manual adentro) → costo del granel (máquina + costos) → margen → estado → cómo se conforma.
  const pos = ['class="md-resumen"', 'id="mdCostos"', 'id="mdManual"', 'id="mdFr"', 'id="mdExtras"', 'id="mdVentas"', 'class="md-margen-prod"', 'id="mdAct"', 'id="mdDetCuerpo"']
    .map(t => { const i = html.indexOf(t); assert.ok(i >= 0, `falta ${t}`); return i; });
  assert.deepStrictEqual(pos, [...pos].sort((a, b) => a - b));
  assert.match(html, /<div class="md-fr-cols"><div class="md-fr-col"><section class="md-fr-sec"/); // debajo de las tarjetas: dos columnas
  assert.doesNotMatch(html, /id="mdVerDetalle"|Precios por canal|<table class="md-tabla md-fr-tabla/); // ni el botón ni la tabla por canal de Reventa/Producción, ni los precios (van a la derecha)
  // Derecha (#mDetDerBody): chips de variación y lista de presentaciones; el título y el subtítulo son del header de la tarjeta.
  assert.match(der, /^<div class="md-fr-chips">/);
  assert.match(der, /<ul class="md-fr-lista">/);
  assert.match(der, /Almendras 1Kg/);
  assert.doesNotMatch(der, /id="mdCostos"|id="mdAct"|<h4|<table/);
  assert.strictEqual(dom.el('mDetDerSub').textContent, 'por kg · con costo sistema, para comparar');
  const fn = (id, prop = 'onclick') => typeof dom.el(id)[prop];
  assert.deepStrictEqual([fn('mdCostos', 'onchange'), fn('mdFrGuardar'), fn('mdManualGuardar'), fn('mdManualQuitar'), fn('mdExtrasGuardar'),
    fn('mdExtraAgregar'), fn('mdVentas'), fn('mdVentas', 'onchange'), fn('mdMargenGuardar'), fn('mdMargenIgualar'), fn('mdActGuardar'), fn('mdDetCuerpo', 'ontoggle')],
  Array(12).fill('function'));
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
  assert.match(dom.cuerpo(), /id="mdCostos" class="md-opcs" style="--n:4"/);
  assert.strictEqual(typeof dom.el('mdManual').onkeydown, 'function'); // Enter guarda
  // Sin costo manual la tarjeta sigue estando (campo vacío para cargarlo), sin Quitar y sin poder elegirse todavía.
  const dom2 = crearContexto();
  abrir(dom2, 'fraccionado', { ...granel({ conPermiso: true }), costoManual: null });
  tj = tarjetaManual(dom2.cuerpo());
  assert.match(tj, /<input id="mdManual" type="number"[^>]*value=""/);
  assert.match(tj, /id="mdManualGuardar"/);
  assert.doesNotMatch(tj, /mdManualQuitar/);
  assert.match(tj, /<input type="radio" name="mdCosto" value="manual" disabled>/);
  assert.match(dom2.cuerpo(), /style="--n:4"/);
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
  assert.match(sin.cuerpo(), /style="--n:3"/);
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

test('Fraccionado sin precios-config: tarjetas, estado y precios; sin bloques de configuración ni claves ocultas', () => {
  const dom = crearContexto();
  const fila = granel({ conPermiso: false });
  assert.ok(!('costeoGranel' in fila) && !('costosExtra' in fila));
  abrir(dom, 'fraccionado', fila, { sinConfig: true });
  const html = dom.cuerpo();
  for (const t of ['id="mdCostos"', 'id="mdAct"', 'id="mdActGuardar"']) assert.ok(html.includes(t), `falta ${t}`);
  assert.ok(dom.cuerpoDer().includes('Almendras 1Kg'), 'faltan los precios en la tarjeta derecha');
  for (const t of ['id="mdFr"', 'id="mdManual"', 'id="mdExtras"', 'id="mdDetCuerpo"', 'md-margen-prod', 'Costo del granel', 'md-fr-cols']) assert.ok(!html.includes(t), `sobra ${t}`);
  assert.deepStrictEqual([typeof dom.el('mdCostos').onchange, typeof dom.el('mdActGuardar').onclick], ['function', 'function']);
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
    assert.strictEqual(dom.cuerpoDer(), '', tipo); // sin tarjeta derecha
    assert.strictEqual(typeof dom.el('mdVerDetalle').onclick, 'function', tipo);
  }
});

// Vigente 0 en SIGA: el server lo toma como "sin vigente" (compararConVigente: Δ % null, estado null) y el resumen lo cuenta así,
// pero el Δ $ muestra el sugerido entero ("+$ 1.950").
test('deltaPesosMd: vigente 0 cuenta como sin vigente, igual que el Δ %', () => {
  assert.strictEqual(deltaPesosMd(0, 1950), null);
});
