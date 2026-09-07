const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// ── Componentes por elemento en el modal de carga de producción ───────────────
// Reemplaza al viejo produccion_granel_alta.test.js: el commit 194bf24 eliminó la carga
// "solo granel" y el apartado "Producción de granel" (el granel previo pasó a ser una orden
// más, generada desde planificación → ver planificacion_granel_previo.test.js). Lo que quedó
// acá es el recálculo de los componentes de la fórmula al tipear la cantidad producida.
//
// Las funciones viven inline en apidelta_produccion_dia.html (no hay módulo que requerir), así
// que se extraen por nombre y se evalúan contra un DOM mínimo: sólo se implementan los métodos
// que usan (querySelectorAll por clase y por [data-eidx], querySelector, dataset, value).

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'apidelta_produccion_dia.html'), 'utf8');

// Corta el fuente de una función balanceando llaves desde `function nombre(`. Sirve tanto para
// las de una línea como para las de varias (el viejo corte por salto + llave sólo cubría las
// segundas, y por eso el test quedó frágil).
function fuenteDe(nombre) {
  const ini = HTML.indexOf(`function ${nombre}(`);
  assert.notStrictEqual(ini, -1, `no se encontró function ${nombre}(`);
  let nivel = 0, visto = false;
  for (let i = ini; i < HTML.length; i++) {
    if (HTML[i] === '{') { nivel++; visto = true; }
    else if (HTML[i] === '}') { nivel--; if (visto && nivel === 0) return HTML.slice(ini, i + 1); }
  }
  assert.fail(`no se pudo cerrar function ${nombre}(`);
}

// Nodo mínimo: clases, dataset y value. `buscar` acepta '.clase' y '.clase[data-eidx="N"]'.
function nodo(clases, extra = {}) {
  return {
    clases: new Set(clases), dataset: {}, hijos: [], textContent: '', ...extra,
    querySelector(sel)    { return this.buscar(sel)[0] || null; },
    querySelectorAll(sel) { return this.buscar(sel); },
    buscar(sel) {
      const m = /^\.([\w-]+)(?:\[data-(\w+)="([^"]*)"\])?$/.exec(sel);
      assert.ok(m, `selector no soportado por el DOM de mentira: ${sel}`);
      const [, clase, attr, val] = m;
      return this.hijos.filter(h => h.clases.has(clase) && (!attr || h.dataset[attr] === val));
    },
  };
}

// Un elemento = una presentación de la orden: cantidad producida + un input por componente.
function elemento(eidx, cantidad, nComponentes) {
  const cantInp = nodo(['pf-elem-cant'], { value: String(cantidad) });
  cantInp.dataset.eidx = String(eidx);
  const el = nodo(['pf-elem']);
  el.dataset.eidx = String(eidx);
  el.hijos = [cantInp, ...Array.from({ length: nComponentes }, () => nodo(['pf-grn-cant'], { value: '0' }))];
  return el;
}

// Fila de la tabla "fórmula completa": su total es el factor por la suma de TODOS los elementos.
function totalFormula(factor, unidad) {
  const td = nodo(['pf-fc-total']);
  td.dataset.factor = String(factor);
  td.dataset.unit = unidad;
  return td;
}

function entorno({ elementos = [], totales = [], header = null, factoresPorElem = [] }) {
  // Los .pf-elem-cant y .pf-grn-cant cuelgan de su .pf-elem, pero el código los busca desde
  // document: se aplanan todos en una sola bolsa, que es lo que ve querySelectorAll real.
  const todos = [...elementos, ...totales, ...elementos.flatMap(e => e.hijos)];
  const bolsa = nodo([], { hijos: todos });
  const document = {
    querySelectorAll(sel) { return bolsa.buscar(sel); },
    querySelector(sel)    { return this.querySelectorAll(sel)[0] || null; },
    getElementById(id)    { return id === 'pfFormulaCantHeader' ? header : null; },
  };
  const src = [fuenteDe('_pfFactoresDe'), fuenteDe('_pfRecalcGraneles'),
               'return { _pfFactoresDe, _pfRecalcGraneles };'].join('\n');
  return new Function('document', '_pfFactoresPorElem', 'fmtN', src)(
    document, factoresPorElem, n => String(n));
}

// Fórmula de la presentación de 500g: el orden de los factores es el de los inputs .pf-grn-cant.
const FACTORES_500 = [
  { id: '6333',  nombre: 'Envase 500g Pet SILPLAST', factorPorUnidad: 1,    unidad: 'UN' },
  { id: '90739', nombre: 'Yogurt Natural Tipo Griego DEPOSITO GRANEL', factorPorUnidad: 0.43, unidad: 'kg' },
];
const FACTORES_1KG = [
  { id: '6340',  nombre: 'Envase 1Kg Pet SILPLAST', factorPorUnidad: 1,   unidad: 'UN' },
  { id: '90739', nombre: 'Yogurt Natural Tipo Griego DEPOSITO GRANEL', factorPorUnidad: 0.9, unidad: 'kg' },
];

test('_pfFactoresDe devuelve la fórmula del elemento y lista vacía fuera de rango', () => {
  const api = entorno({ factoresPorElem: [FACTORES_500, FACTORES_1KG] });
  assert.deepStrictEqual(api._pfFactoresDe(0), FACTORES_500);
  assert.deepStrictEqual(api._pfFactoresDe('1'), FACTORES_1KG);   // el dataset llega como string
  assert.deepStrictEqual(api._pfFactoresDe(9), []);
  assert.deepStrictEqual(api._pfFactoresDe(undefined), []);
});

test('la cantidad producida recalcula los componentes de ESE elemento', () => {
  const el = elemento(0, 500, 2);
  const api = entorno({ elementos: [el], factoresPorElem: [FACTORES_500] });

  api._pfRecalcGraneles(0);
  const comps = el.querySelectorAll('.pf-grn-cant');
  assert.strictEqual(comps[0].value, 500);    // envase: 1 por unidad
  assert.strictEqual(comps[1].value, 215);    // granel: 500 × 0.43
});

test('sin eidx se recalculan todos los elementos, cada uno con su fórmula', () => {
  const e0 = elemento(0, 500, 2), e1 = elemento(1, 300, 2);
  const api = entorno({ elementos: [e0, e1], factoresPorElem: [FACTORES_500, FACTORES_1KG] });

  api._pfRecalcGraneles();
  assert.strictEqual(e0.querySelectorAll('.pf-grn-cant')[1].value, 215);   // 500 × 0.43
  assert.strictEqual(e1.querySelectorAll('.pf-grn-cant')[1].value, 270);   // 300 × 0.9
});

test('recalcular un elemento no pisa los componentes de los otros', () => {
  const e0 = elemento(0, 500, 2), e1 = elemento(1, 300, 2);
  const api = entorno({ elementos: [e0, e1], factoresPorElem: [FACTORES_500, FACTORES_1KG] });

  api._pfRecalcGraneles(1);
  assert.strictEqual(e0.querySelectorAll('.pf-grn-cant')[1].value, '0');   // intacto
  assert.strictEqual(e1.querySelectorAll('.pf-grn-cant')[1].value, 270);
});

test('una cantidad vacía o no numérica deja los componentes en cero, no en NaN', () => {
  const el = elemento(0, '', 2);
  const api = entorno({ elementos: [el], factoresPorElem: [FACTORES_500] });

  api._pfRecalcGraneles(0);
  assert.deepStrictEqual(el.querySelectorAll('.pf-grn-cant').map(i => i.value), [0, 0]);
});

test('la fórmula completa suma las cantidades de todos los elementos', () => {
  const e0 = elemento(0, 500, 2), e1 = elemento(1, 300, 2);
  const leche = totalFormula(1.05, 'lt'), fermento = totalFormula(0.002, 'kg');
  const header = nodo([]);
  const api = entorno({ elementos: [e0, e1], totales: [leche, fermento], header,
                        factoresPorElem: [FACTORES_500, FACTORES_1KG] });

  api._pfRecalcGraneles();
  assert.strictEqual(leche.textContent, '840 lt');        // (500 + 300) × 1.05
  assert.strictEqual(fermento.textContent, '1.6 kg');     // (500 + 300) × 0.002
  assert.strictEqual(header.textContent, 'Para 800 u.');
});

test('un elemento sin fórmula cargada no rompe el recálculo', () => {
  const el = elemento(0, 500, 2);
  const api = entorno({ elementos: [el], factoresPorElem: [] });

  api._pfRecalcGraneles(0);
  assert.deepStrictEqual(el.querySelectorAll('.pf-grn-cant').map(i => i.value), ['0', '0']);
});
