const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// ── Alta del granel al registrar una presentación ─────────────────────────────
// Las funciones viven inline en apidelta_produccion_dia.html (no hay módulo que requerir), así
// que se extraen por nombre y se evalúan contra un DOM mínimo: sólo se implementan los métodos
// que las funciones usan (querySelectorAll por clase, querySelector, dataset, value, checked).

const HTML = fs.readFileSync(path.join(__dirname, '..', 'apidelta_produccion_dia.html'), 'utf8');

// Corta el fuente de una función desde `function nombre(` hasta la llave de cierre en columna 0.
function fuenteDe(nombre) {
  const ini = HTML.indexOf(`function ${nombre}(`);
  assert.notStrictEqual(ini, -1, `no se encontró function ${nombre}(`);
  const fin = HTML.indexOf('\n}', ini);
  return HTML.slice(ini, fin + 2);
}

// Nodo mínimo: clases, dataset y (para inputs) value/checked.
function nodo(clases, extra = {}) {
  return { clases: new Set(clases), dataset: {}, hijos: [], ...extra,
    querySelector(sel)    { return this.buscar(sel)[0] || null; },
    querySelectorAll(sel) { return this.buscar(sel); },
    buscar(sel)           { const c = sel.replace('.', ''); return this.hijos.filter(h => h.clases.has(c)); } };
}

function entorno({ elementos = [], graneles = [] }) {
  const todos = [...elementos, ...graneles];
  const document = {
    querySelectorAll(sel) {
      const c = sel.replace('.', '');
      return todos.filter(n => n.clases.has(c));
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
  };
  const src = [fuenteDe('_pfFactoresDe'), fuenteDe('_pfGpConsumido'), fuenteDe('_pfRecalcGranelProd'),
               fuenteDe('_pfGranelesAProducir'), fuenteDe('_pfGranelYaCargado'), fuenteDe('_pfGranelesFaltantes'),
               fuenteDe('_pfEsGranel'), fuenteDe('_pfSeleccionarGraneles')].join('\n');
  const fn = new Function('document', '_pfGranelesProd', '_pfFactoresPorElem',
    `${src}\n return { _pfGpConsumido, _pfRecalcGranelProd, _pfGranelesAProducir, _pfGranelYaCargado, _pfGranelesFaltantes, _pfSeleccionarGraneles };`);
  return fn(document, graneles.map(g => g.def), elementos.map(e => e.factores));
}

// Elemento de carga: cantidad producida + un input por componente de su fórmula.
function elemento(eidx, factores, cantsComponentes) {
  const el = nodo(['pf-elem']);
  el.dataset.eidx = String(eidx);
  el.hijos = cantsComponentes.map(v => nodo(['pf-grn-cant'], { value: String(v) }));
  el.factores = factores;
  return el;
}

function bloqueGranel(gi, def, { cant = 0, checked = true, touched = false, comps = [], yaCargado = 0 } = {}) {
  const blk = nodo(['pf-gp']);
  blk.dataset.gi = String(gi);
  blk.dataset.plu = def.plu;
  blk.dataset.touched = touched ? '1' : '0';
  blk.dataset.yacargado = String(yaCargado);
  blk.hijos = [
    nodo(['pf-gp-on'], { checked }),
    nodo(['pf-gp-cant'], { value: String(cant) }),
    ...comps.map(v => nodo(['pf-gp-comp'], { value: String(v) })),
  ];
  blk.def = def;
  return blk;
}

const GRANEL_YOGURT = { plu: '90739', nombre: 'Yogurt Natural Tipo Griego DEPOSITO GRANEL', unidad: 'kg',
  comps: [{ id: '9001', nombre: 'Leche Entera', factorPorUnidad: 1.05, unidad: 'lt' },
          { id: '9002', nombre: 'Fermento YF-L812', factorPorUnidad: 0.002, unidad: 'kg' }] };

// Fórmula de la presentación: el orden de los factores es el orden de los inputs .pf-grn-cant.
const FACTORES_430 = [
  { id: '6333',  nombre: 'Envase 500g Pet SILPLAST', factorPorUnidad: 1, unidad: 'UN' },
  { id: '90739', nombre: 'Yogurt Natural Tipo Griego DEPOSITO GRANEL', factorPorUnidad: 0.43, unidad: 'kg' },
];

// Componentes tal como los devuelve /api/formula para el yogur batido y las pepas: los
// elaborados en la sala tienen fórmula propia, los insumos comprados no.
test('se listan todos los graneles elaborados de la fórmula, no sólo el que se llama "granel"', () => {
  const { _pfSeleccionarGraneles } = entorno({});
  const comp = (n) => Array.from({ length: n }, (_, i) => ({ id: String(9000 + i), nombre: 'x', factorPorUnidad: 1, unidad: 'kg' }));

  // Yogur batido: yogur griego granel + mermelada (elaborada acá, sin "granel" en el nombre).
  const batido = _pfSeleccionarGraneles([
    { plu: '90739', nombre: 'Yogurt Natural Tipo Griego DEPOSITO GRANEL', comps: comp(5) },
    { plu: '90631', nombre: 'Mermelada Frutillas Produccion Yogur',       comps: comp(4) },
    { plu: '91400', nombre: 'Fermento Yogurt Chr Hansen YF-L812 x peso',  comps: [] },   // comprado
  ]);
  assert.deepStrictEqual(batido.map(g => g.plu), ['90739', '90631']);

  // Pepas: la masa es el único granel de la fórmula.
  const pepas = _pfSeleccionarGraneles([
    { plu: '8104', nombre: 'Pepas Apidelta Integrales Membrillo y Batata DEPOSITO GRANEL', comps: comp(21) },
  ]);
  assert.deepStrictEqual(pepas.map(g => g.plu), ['8104']);

  // Yogur griego normal: sólo el granel, y se lista aunque no tenga la fórmula cargada.
  const griego = _pfSeleccionarGraneles([
    { plu: '90739', nombre: 'Yogurt Natural Tipo Griego DEPOSITO GRANEL', comps: [] },
    { plu: '1801',  nombre: 'Antihongos Conservante Para Yogurt 100G',    comps: [] },
  ]);
  assert.deepStrictEqual(griego.map(g => g.plu), ['90739']);
});

test('la cantidad de granel sugerida es el consumo declarado de todas las presentaciones', () => {
  const els = [elemento(0, FACTORES_430, [500, 215]), elemento(1, FACTORES_430, [300, 129])];
  const gp  = bloqueGranel(0, GRANEL_YOGURT, { comps: [0, 0] });
  const api = entorno({ elementos: els, graneles: [gp] });

  assert.strictEqual(api._pfGpConsumido('90739'), 344);   // 215 + 129 kg
  api._pfRecalcGranelProd();
  assert.strictEqual(gp.querySelector('.pf-gp-cant').value, 344);
  const comps = gp.querySelectorAll('.pf-gp-comp');
  assert.strictEqual(comps[0].value, +(344 * 1.05).toFixed(3));    // leche
  assert.strictEqual(comps[1].value, +(344 * 0.002).toFixed(3));   // fermento
});

test('si el operario edita la cantidad elaborada, el recálculo no la pisa', () => {
  const els = [elemento(0, FACTORES_430, [500, 215])];
  const gp  = bloqueGranel(0, GRANEL_YOGURT, { cant: 240, touched: true, comps: [0, 0] });
  const api = entorno({ elementos: els, graneles: [gp] });

  api._pfRecalcGranelProd();
  assert.strictEqual(parseFloat(gp.querySelector('.pf-gp-cant').value), 240);   // batch real, no el consumo
  assert.strictEqual(gp.querySelectorAll('.pf-gp-comp')[0].value, 252);   // 240 × 1.05
});

test('el granel tildado sale con sus componentes; destildado o en cero no sale', () => {
  const tildado = bloqueGranel(0, GRANEL_YOGURT, { cant: 215, comps: [225.75, 0.43] });
  assert.deepStrictEqual(entorno({ graneles: [tildado] })._pfGranelesAProducir(), [{
    plu: '90739', nombre: GRANEL_YOGURT.nombre, cantidad: 215,
    comps: [{ granel: '9001', nombreGranel: 'Leche Entera', granelConsumido: 225.75 },
            { granel: '9002', nombreGranel: 'Fermento YF-L812', granelConsumido: 0.43 }],
  }]);

  const destildado = bloqueGranel(0, GRANEL_YOGURT, { cant: 215, checked: false, comps: [225.75, 0.43] });
  assert.deepStrictEqual(entorno({ graneles: [destildado] })._pfGranelesAProducir(), []);

  const enCero = bloqueGranel(0, GRANEL_YOGURT, { cant: 0, comps: [0, 0] });
  assert.deepStrictEqual(entorno({ graneles: [enCero] })._pfGranelesAProducir(), []);
});

test('en la carga independiente (sin presentaciones en pantalla) sugiere lo planificado', () => {
  const gp  = bloqueGranel(0, { ...GRANEL_YOGURT, sugerido: 215 }, { comps: [0, 0] });
  const api = entorno({ elementos: [], graneles: [gp] });   // botón 🛢️ Granel: no hay .pf-elem

  api._pfRecalcGranelProd();
  assert.strictEqual(gp.querySelector('.pf-gp-cant').value, 215);        // fórmula × lo planificado
  assert.strictEqual(gp.querySelectorAll('.pf-gp-comp')[0].value, +(215 * 1.05).toFixed(3));
});

test('el granel cargado aparte ese día se detecta por PLU y fecha', () => {
  const api = entorno({});
  const registros = [
    { fecha: '2026-08-11', plu: '90739', cantFraccionada: 215 },      // granel cargado aparte
    { fecha: '2026-08-11', plu: '90739', cantFraccionada: 60 },       // segunda tanda del mismo día
    { fecha: '2026-08-10', plu: '90739', cantFraccionada: 400 },      // otro día: no cuenta
    { fecha: '2026-08-11', plu: '1968',  cantFraccionada: 500 },      // la presentación, no el granel
    { fecha: '2026-08-11', plu: 'ACT',   cantFraccionada: 1 },        // tarea extra
  ];
  assert.strictEqual(api._pfGranelYaCargado(registros, '90739', '2026-08-11', 7), 275);
  assert.strictEqual(api._pfGranelYaCargado(registros, '90739', '2026-08-09', 7), 0);
  assert.strictEqual(api._pfGranelYaCargado([], '90739', '2026-08-11', 7), 0);
});

test('el granel de otra orden no cuenta como cargado; el de la propia orden y el manual sí', () => {
  const api = entorno({});
  // Mismo granel (yogur griego) usado por la orden de griego (7) y la de batido (9).
  const registros = [
    { fecha: '2026-08-11', plu: '90739', cantFraccionada: 400, granelOrdenId: 7 },   // tanda del griego
    { fecha: '2026-08-11', plu: '90739', cantFraccionada: 50 },                      // carga manual suelta
  ];
  assert.strictEqual(api._pfGranelYaCargado(registros, '90739', '2026-08-11', 7), 450);  // propia + manual
  assert.strictEqual(api._pfGranelYaCargado(registros, '90739', '2026-08-11', 9), 50);   // sólo la manual
});

test('se reclama el granel sólo si no se cargó aparte ni se está cargando acá', () => {
  const sinCargar = bloqueGranel(0, GRANEL_YOGURT, { cant: 0, comps: [0, 0] });
  assert.deepStrictEqual(entorno({ graneles: [sinCargar] })._pfGranelesFaltantes(), [GRANEL_YOGURT.nombre]);

  const destildado = bloqueGranel(0, GRANEL_YOGURT, { cant: 215, checked: false, comps: [225.75, 0.43] });
  assert.deepStrictEqual(entorno({ graneles: [destildado] })._pfGranelesFaltantes(), [GRANEL_YOGURT.nombre]);

  const yaAparte = bloqueGranel(0, GRANEL_YOGURT, { cant: 0, checked: false, yaCargado: 275, comps: [0, 0] });
  assert.deepStrictEqual(entorno({ graneles: [yaAparte] })._pfGranelesFaltantes(), []);

  const seCargaAca = bloqueGranel(0, GRANEL_YOGURT, { cant: 215, comps: [225.75, 0.43] });
  assert.deepStrictEqual(entorno({ graneles: [seCargaAca] })._pfGranelesFaltantes(), []);
});
