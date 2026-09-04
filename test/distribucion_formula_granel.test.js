const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// ── Fórmula de Siga en el modal de registro de distribución ───────────────────
// La fórmula que trae /api/distribucion/pesables sale de la planilla importada: los productos
// que no están ahí (mixes, bandejas, altas nuevas — p. ej. 6171 "Bandeja Snack Saludable")
// llegan con granel null y fórmula 1, y el modal mostraba "–" y consumo sugerido = cantidad.
// Ahora en ese caso se consulta el BOM de Siga y, si tiene varios graneles, se guarda el
// detalle por granel en graneles[].
//
// Las funciones viven inline en distribucion.html (no hay módulo que requerir), así que se
// extraen por nombre y se evalúan juntas contra un `_mrGraneles` de mentira.

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'distribucion.html'), 'utf8');

function fuenteDe(nombre) {
  let ini = HTML.indexOf(`function ${nombre}(`);
  assert.notStrictEqual(ini, -1, `no se encontró function ${nombre}(`);
  if (HTML.slice(ini - 6, ini) === 'async ') ini -= 6;   // sin el async, el await no compila
  let nivel = 0, visto = false;
  for (let i = ini; i < HTML.length; i++) {
    if (HTML[i] === '{') { nivel++; visto = true; }
    else if (HTML[i] === '}') { nivel--; if (visto && nivel === 0) return HTML.slice(ini, i + 1); }
  }
  assert.fail(`no se pudo cerrar function ${nombre}(`);
}

// Ambas comparten el estado `_mrGraneles`, así que se evalúan en el mismo scope.
function cargar() {
  return new Function(`
    let _mrGraneles = [];
    ${fuenteDe('_mrAplicarGraneles')}
    ${fuenteDe('_mrGranelesRegistro')}
    return { _mrAplicarGraneles, _mrGranelesRegistro, graneles: () => _mrGraneles };
  `)();
}

const BASE = { plu: 6171, nombre: 'Bandeja Snack Saludable', granel: null, nombreGranel: '', cantFormula: 1 };

test('un solo granel: entra al campo granel y la fórmula es su cantidad por unidad', () => {
  const m = cargar();
  const r = m._mrAplicarGraneles(BASE, [{ granel: '7020', nombreGranel: 'Almendra GRANEL', factor: 0.25 }]);
  assert.strictEqual(r.granel, '7020');
  assert.strictEqual(r.nombreGranel, 'Almendra GRANEL');
  assert.strictEqual(r.cantFormula, 0.25);
  assert.deepStrictEqual(m.graneles(), []);           // nada que repartir
  assert.strictEqual(m._mrGranelesRegistro(10, 2.5), undefined);
});

test('varios graneles: sin código único, fórmula = suma de kg por unidad', () => {
  const m = cargar();
  const comps = [
    { granel: '7020', nombreGranel: 'Almendra GRANEL', factor: 0.087 },
    { granel: '7033', nombreGranel: 'Apimani GRANEL',  factor: 0.075 },
  ];
  const r = m._mrAplicarGraneles(BASE, comps);
  assert.strictEqual(r.granel, null);
  assert.strictEqual(r.nombreGranel, 'Almendra GRANEL + Apimani GRANEL');
  assert.strictEqual(r.cantFormula, 0.162);
  assert.strictEqual(m.graneles().length, 2);
});

test('el detalle por granel reparte el consumo cargado en proporción a la fórmula', () => {
  const m = cargar();
  m._mrAplicarGraneles(BASE, [
    { granel: '7020', nombreGranel: 'Almendra GRANEL', factor: 0.1 },
    { granel: '7033', nombreGranel: 'Apimani GRANEL',  factor: 0.3 },
  ]);
  // Consumo teórico de 10 unidades = 4 kg; el operario cargó 4 → sin corrección.
  assert.deepStrictEqual(m._mrGranelesRegistro(10, 4), [
    { granel: '7020', nombreGranel: 'Almendra GRANEL', granelConsumido: 1 },
    { granel: '7033', nombreGranel: 'Apimani GRANEL',  granelConsumido: 3 },
  ]);
  // Si corrige el total a 5 kg, cada granel escala igual y la suma sigue dando lo cargado.
  const corregido = m._mrGranelesRegistro(10, 5);
  assert.deepStrictEqual(corregido.map(g => g.granelConsumido), [1.25, 3.75]);
  assert.strictEqual(corregido.reduce((s, g) => s + g.granelConsumido, 0), 5);
});

test('sin fórmula en Siga el producto queda como estaba', () => {
  const m = cargar();
  assert.deepStrictEqual(m._mrAplicarGraneles(BASE, []), BASE);
  assert.deepStrictEqual(m.graneles(), []);
});

// ── CSV de producción ────────────────────────────────────────────────────────
// El CSV se importa en SiGA: la línea del producto suma y la de cada insumo resta. Con fórmulas
// de varios graneles tiene que salir una línea por componente, no el total contra un solo código.
function cargarCSV(nombresSiga) {
  const fetchFalso = async () => ({ json: async () => (nombresSiga || {}) });
  return new Function('fetch', `
    ${fuenteDe('_grnList')}
    ${fuenteDe('lineasCSVProduccion')}
    return { _grnList, lineasCSVProduccion };
  `)(fetchFalso);
}

const REG_MULTI = {
  id: 1, plu: 6171, nombre: 'Bandeja Snack', cantFraccionada: 10, granel: null,
  nombreGranel: 'Almendra + Apimani', granelConsumido: 4,
  graneles: [
    { granel: '7020', nombreGranel: 'Almendra', granelConsumido: 1 },
    { granel: '7033', nombreGranel: 'Apimani',  granelConsumido: 3 },
  ],
};

test('CSV: una línea por componente, cada una con su consumo en negativo', async () => {
  const m = cargarCSV();
  assert.deepStrictEqual(await m.lineasCSVProduccion([REG_MULTI]), [
    '1;6171;"Bandeja Snack";10;1;6171',
    '1;7020;"Almendra";-1;1;7020',
    '1;7033;"Apimani";-3;1;7033',
  ]);
});

test('CSV: el registro de un solo granel sigue saliendo en dos líneas', async () => {
  const m = cargarCSV();
  const reg = { id: 2, plu: 1015, nombre: 'Tutuca', cantFraccionada: 5, granel: '9001',
    nombreGranel: 'Tutuca granel', granelConsumido: 5.2 };
  assert.deepStrictEqual(await m.lineasCSVProduccion([reg]), [
    '1;1015;"Tutuca";5;1;1015',
    '1;9001;"Tutuca granel";-5.2;1;9001',
  ]);
});

test('CSV: los nombres de SiGA pisan a los tipeados al cargar, y las tareas extras no salen', async () => {
  const m = cargarCSV({ '6171': 'Bandeja Snack Saludable Apidelta', '7020': 'Almendra Non Pareil DEPOSITO GRANEL' });
  const lineas = await m.lineasCSVProduccion([REG_MULTI, { id: 3, plu: 'ACT', observacion: 'limpieza' }]);
  assert.strictEqual(lineas.length, 3);
  assert.strictEqual(lineas[0], '1;6171;"Bandeja Snack Saludable Apidelta";10;1;6171');
  assert.strictEqual(lineas[1], '1;7020;"Almendra Non Pareil DEPOSITO GRANEL";-1;1;7020');
  assert.strictEqual(lineas[2], '1;7033;"Apimani";-3;1;7033');   // sin nombre en SiGA: cae al guardado
});

test('_grnList: graneles[] manda; si no hay, el campo simple; si no hay nada, vacío', () => {
  const m = cargarCSV();
  assert.strictEqual(m._grnList(REG_MULTI).length, 2);
  assert.deepStrictEqual(m._grnList({ granel: '9001', nombreGranel: 'Tutuca granel', granelConsumido: 5 }),
    [{ granel: '9001', nombreGranel: 'Tutuca granel', granelConsumido: 5 }]);
  assert.deepStrictEqual(m._grnList({ plu: 'ACT' }), []);
});

test('cantidad en cero no divide por cero', () => {
  const m = cargar();
  m._mrAplicarGraneles(BASE, [
    { granel: '7020', nombreGranel: 'Almendra GRANEL', factor: 0.1 },
    { granel: '7033', nombreGranel: 'Apimani GRANEL',  factor: 0.3 },
  ]);
  assert.deepStrictEqual(m._mrGranelesRegistro(0, 5).map(g => g.granelConsumido), [0, 0]);
});
