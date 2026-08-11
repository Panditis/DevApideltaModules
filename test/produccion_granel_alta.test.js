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
  };
  const src = [fuenteDe('_pfFactoresDe'), fuenteDe('_pfGpConsumido'),
               fuenteDe('_pfRecalcGranelProd'), fuenteDe('_pfGranelesAProducir')].join('\n');
  const fn = new Function('document', '_pfGranelesProd', '_pfFactoresPorElem',
    `${src}\n return { _pfGpConsumido, _pfRecalcGranelProd, _pfGranelesAProducir };`);
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

function bloqueGranel(gi, def, { cant = 0, checked = true, touched = false, comps = [] } = {}) {
  const blk = nodo(['pf-gp']);
  blk.dataset.gi = String(gi);
  blk.dataset.plu = def.plu;
  blk.dataset.touched = touched ? '1' : '0';
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
