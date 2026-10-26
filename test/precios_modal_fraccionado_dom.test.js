'use strict';
// Modal del producto con los scripts del front cargados como en el navegador (scripts clásicos que comparten globales) sobre un
// DOM mínimo: el layout a dos columnas de Fraccionado (con y sin precios-config), los ids que conectan cada guardado, el ancho
// 'doble' de abrirModal y que Reventa / Producción siguen con la tabla por canal y "Ver detalle".
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
// getElementById sólo encuentra los ids fijos de precios.html y los que haya en el HTML pintado en #mDetBody (como el navegador).
function crearContexto() {
  const elementos = new Map();
  const el = id => {
    if (!elementos.has(id)) {
      elementos.set(id, { id, innerHTML: '', textContent: '', value: '', options: [], hidden: false, open: false,
        classList: clases(id === 'mDetCaja' ? ['max-w-2xl'] : id === 'mDet' ? ['hidden'] : []),
        focus() {}, setAttribute() {}, addEventListener() {}, scrollIntoView() {}, insertAdjacentHTML() {},
        querySelector: () => el(`${id}>*`), querySelectorAll: () => [] });
    }
    return elementos.get(id);
  };
  const FIJOS = ['mDet', 'mDetCaja', 'mDetTitulo', 'mDetSub', 'mDetBody', 'mDetX'];
  const cuerpo = () => el('mDetBody').innerHTML;
  const ids = () => [...cuerpo().matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
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
  return { ctx, el, ids, cuerpo, correr, llamadas };
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

test('abrirModal: "doble" pone el ancho de dos columnas; el siguiente modal sin "doble" vuelve al suyo', () => {
  const dom = crearContexto();
  const caja = dom.el('mDetCaja').classList;
  dom.correr("abrirModal('Fraccionado', 'doble')");
  assert.deepStrictEqual([caja.contains('md-doble'), caja.contains('max-w-3xl'), caja.contains('max-w-2xl')], [true, true, false]);
  dom.correr("abrirModal('Reventa', true)");
  assert.deepStrictEqual([caja.contains('md-doble'), caja.contains('max-w-3xl'), caja.contains('max-w-2xl')], [false, true, false]);
  dom.correr("abrirModal('Fraccionado', 'doble'); abrirModal('Angosto')");
  assert.deepStrictEqual([caja.contains('md-doble'), caja.contains('max-w-3xl'), caja.contains('max-w-2xl')], [false, false, true]);
});

test('Fraccionado con precios-config: dos columnas con todos los bloques, ids únicos y cada guardado conectado', () => {
  const dom = crearContexto();
  abrir(dom, 'fraccionado', granel({ conPermiso: true }));
  const html = dom.cuerpo();
  assert.match(html, /^<div class="md-fr">/);
  assert.deepStrictEqual(repetidos(dom.ids()), []);
  // Izquierda en orden: tarjetas → costo del granel (máquina + costos) → cómo se conforma → margen → estado; derecha: precios.
  const pos = ['id="mdCostos"', 'id="mdFr"', 'id="mdManual"', 'id="mdExtras"', 'id="mdVentas"', 'id="mdDetCuerpo"', 'class="md-margen-prod"', 'id="mdAct"', 'class="md-fr-precios"']
    .map(t => { const i = html.indexOf(t); assert.ok(i >= 0, `falta ${t}`); return i; });
  assert.deepStrictEqual(pos, [...pos].sort((a, b) => a - b));
  assert.doesNotMatch(html, /id="mdVerDetalle"|Precios por canal/); // sin el botón ni la tabla por canal de Reventa/Producción
  const fn = (id, prop = 'onclick') => typeof dom.el(id)[prop];
  assert.deepStrictEqual([fn('mdCostos', 'onchange'), fn('mdFrGuardar'), fn('mdManualGuardar'), fn('mdManualQuitar'), fn('mdExtrasGuardar'),
    fn('mdExtraAgregar'), fn('mdVentas'), fn('mdVentas', 'onchange'), fn('mdMargenGuardar'), fn('mdMargenIgualar'), fn('mdActGuardar'), fn('mdDetCuerpo', 'ontoggle')],
  Array(12).fill('function'));
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
  for (const t of ['id="mdCostos"', 'id="mdAct"', 'id="mdActGuardar"', 'class="md-fr-precios"', 'Almendras 1Kg']) assert.ok(html.includes(t), `falta ${t}`);
  for (const t of ['id="mdFr"', 'id="mdManual"', 'id="mdExtras"', 'id="mdDetCuerpo"', 'md-margen-prod', 'Costo del granel']) assert.ok(!html.includes(t), `sobra ${t}`);
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
    assert.strictEqual(typeof dom.el('mdVerDetalle').onclick, 'function', tipo);
  }
});

// Vigente 0 en SIGA: el server lo toma como "sin vigente" (compararConVigente: Δ % null, estado null) y el resumen lo cuenta así,
// pero el Δ $ muestra el sugerido entero ("+$ 1.950").
test('deltaPesosMd: vigente 0 cuenta como sin vigente, igual que el Δ %', () => {
  assert.strictEqual(deltaPesosMd(0, 1950), null);
});
