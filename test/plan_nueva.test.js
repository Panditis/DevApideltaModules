'use strict';
const test = require('node:test');
const assert = require('node:assert');
const pn = require('../lib/plan_nueva');

// ── Catálogo ────────────────────────────────────────────────────────────────────────────────
const CATS = [{ id: 'a', nombre: 'Almendras', plus: ['100', '101'], creado: '2026-10-01T00:00:00.000Z' }];
const CTX = { id: 'b', ahora: '2026-10-22T10:00:00.000Z' };
const es = status => e => e.status === status;

test('normalizar quita acentos, mayúsculas y espacios de los bordes', () => {
  assert.strictEqual(pn.normalizar('  Maní CROCANTE '), 'mani crocante');
  assert.strictEqual(pn.normalizar(null), '');
});

test('esPlu sólo acepta dígitos', () => {
  assert.strictEqual(pn.esPlu('2183'), true);
  assert.strictEqual(pn.esPlu(2183), true);
  assert.strictEqual(pn.esPlu('12a'), false);
  assert.strictEqual(pn.esPlu(''), false);
});

test('agregarCategoria: nombre recortado, PLU como texto sin repetir, lista nueva sin mutar', () => {
  const r = pn.agregarCategoria(CATS, { nombre: ' Nueces ', plus: ['200', 200, ' 201 '] }, CTX);
  assert.deepStrictEqual(r.categoria, { id: 'b', nombre: 'Nueces', plus: ['200', '201'], creado: CTX.ahora });
  assert.strictEqual(r.categorias.length, 2);
  assert.strictEqual(CATS.length, 1);
});

test('agregarCategoria: se permite una categoría sin presentaciones', () => {
  assert.deepStrictEqual(pn.agregarCategoria(CATS, { nombre: 'Pasas', plus: [] }, CTX).categoria.plus, []);
});

test('agregarCategoria: nombre vacío → 400', () => {
  assert.throws(() => pn.agregarCategoria(CATS, { nombre: '   ', plus: [] }, CTX), e => e.status === 400 && /vacío/.test(e.message));
  assert.throws(() => pn.agregarCategoria(CATS, undefined, CTX), es(400));
});

test('agregarCategoria: nombre repetido sin mayúsculas/acentos → 409', () => {
  assert.throws(() => pn.agregarCategoria([{ ...CATS[0], nombre: 'Maní' }], { nombre: 'MANI', plus: [] }, CTX), es(409));
});

test('agregarCategoria: plus que no es lista o PLU no numérico → 400', () => {
  assert.throws(() => pn.agregarCategoria(CATS, { nombre: 'Nueces', plus: '200' }, CTX), es(400));
  assert.throws(() => pn.agregarCategoria(CATS, { nombre: 'Nueces', plus: ['12a'] }, CTX), es(400));
  assert.throws(() => pn.agregarCategoria(CATS, { nombre: 'Nueces', plus: [''] }, CTX), es(400));
});

test('agregarCategoria: nombre de más de 80 caracteres o más de 200 presentaciones → 400', () => {
  assert.doesNotThrow(() => pn.agregarCategoria(CATS, { nombre: 'x'.repeat(80), plus: [] }, CTX));
  assert.throws(() => pn.agregarCategoria(CATS, { nombre: 'x'.repeat(81), plus: [] }, CTX), es(400));
  const plus = n => Array.from({ length: n }, (_, i) => String(1000 + i));
  assert.doesNotThrow(() => pn.agregarCategoria(CATS, { nombre: 'Nueces', plus: plus(200) }, CTX));
  assert.throws(() => pn.agregarCategoria(CATS, { nombre: 'Nueces', plus: plus(201) }, CTX), es(400));
});

test('normalizar: la regex de acentos usa escapes y quita cualquier diacrítico combinante', () => {
  assert.strictEqual(pn.normalizar('Ñandú ÁÉÍÓÚ ü'), 'nandu aeiou u');
});

test('agregarCategoria: PLU que ya está en otra categoría → 409 con su nombre', () => {
  assert.throws(() => pn.agregarCategoria(CATS, { nombre: 'Nueces', plus: ['101'] }, CTX), e => e.status === 409 && /Almendras/.test(e.message));
});

test('editarCategoria: renombra (puede repetir su propio nombre) y cambia PLU sin mutar', () => {
  const r = pn.editarCategoria(CATS, 'a', { nombre: 'ALMENDRAS', plus: ['101', '102'] });
  assert.deepStrictEqual(r.categoria, { id: 'a', nombre: 'ALMENDRAS', plus: ['101', '102'], creado: CATS[0].creado });
  assert.deepStrictEqual(r.categorias, [r.categoria]);
  assert.deepStrictEqual(CATS[0].plus, ['100', '101']);
});

test('editarCategoria: id inexistente → 404', () => {
  assert.throws(() => pn.editarCategoria(CATS, 'zz', { nombre: 'X', plus: [] }), es(404));
});

test('borrarCategoria: devuelve la lista sin ella; inexistente → 404', () => {
  assert.deepStrictEqual(pn.borrarCategoria(CATS, 'a'), []);
  assert.strictEqual(CATS.length, 1);
  assert.throws(() => pn.borrarCategoria(CATS, 'zz'), es(404));
});

// ── Parámetros ──────────────────────────────────────────────────────────────────────────────
test('leerParams: defaults 120/30; valores fuera de rango en el archivo caen al default', () => {
  assert.deepStrictEqual(pn.leerParams(undefined), { diasConsumo: 120, diasCubrir: 30 });
  assert.deepStrictEqual(pn.leerParams({ diasConsumo: 90, diasCubrir: 500 }), { diasConsumo: 90, diasCubrir: 30 });
});

test('validarParams: enteros en rango (también como texto)', () => {
  assert.deepStrictEqual(pn.validarParams({ diasConsumo: '7', diasCubrir: 180 }), { diasConsumo: 7, diasCubrir: 180 });
  assert.deepStrictEqual(pn.validarParams({ diasConsumo: 365, diasCubrir: '1' }), { diasConsumo: 365, diasCubrir: 1 });
});

test('validarParams: fuera de rango, decimales o faltantes → 400', () => {
  const malos = [
    { diasConsumo: 6, diasCubrir: 30 }, { diasConsumo: 366, diasCubrir: 30 },
    { diasConsumo: 120, diasCubrir: 0 }, { diasConsumo: 120, diasCubrir: 181 },
    { diasConsumo: 120.5, diasCubrir: 30 }, { diasConsumo: '12a', diasCubrir: 30 }, {},
  ];
  for (const b of malos) assert.throws(() => pn.validarParams(b), es(400), JSON.stringify(b));
});

// ── Tablero ─────────────────────────────────────────────────────────────────────────────────
const P = { diasConsumo: 100, diasCubrir: 30 };

test('calcularFila: consumo/día = unidades ÷ N, /mes ×30, sugerido = ceil(consumoDia × D − stock)', () => {
  assert.deepStrictEqual(pn.calcularFila({ plu: '1', nombre: 'X', unidades: 250, stock: 40 }, P),
    { plu: '1', nombre: 'X', consumoDia: 2.5, consumoMes: 75, stockCentral: 40, sugerido: 35 });
});

test('calcularFila: redondea hacia arriba, nunca negativo y sin error de coma flotante', () => {
  const p = { diasConsumo: 120, diasCubrir: 30 };
  assert.strictEqual(pn.calcularFila({ plu: '1', nombre: 'X', unidades: 10, stock: 0 }, p).sugerido, 3); // 2,5 → 3
  assert.strictEqual(pn.calcularFila({ plu: '1', nombre: 'X', unidades: 10, stock: 100 }, p).sugerido, 0);
  // 9 ÷ 7 × 21 = 27 exacto, pero en coma flotante da 27.000000000000004
  assert.strictEqual(pn.calcularFila({ plu: '1', nombre: 'X', unidades: 9, stock: 0 }, { diasConsumo: 7, diasCubrir: 21 }).sugerido, 27);
});

test('calcularFila: sin ventas → consumo 0; stock sin dato → null y sugerido = consumo × D', () => {
  assert.deepStrictEqual(pn.calcularFila({ plu: '1', nombre: 'X', unidades: 0, stock: null }, P),
    { plu: '1', nombre: 'X', consumoDia: 0, consumoMes: 0, stockCentral: null, sugerido: 0 });
  const f = pn.calcularFila({ plu: '1', nombre: 'X', unidades: 60, stock: undefined }, { diasConsumo: 30, diasCubrir: 10 });
  assert.strictEqual(f.stockCentral, null);
  assert.strictEqual(f.sugerido, 20);
});

test('armarTablero: categorías por nombre, presentaciones en orden del catálogo, "PLU n" sin nombre', () => {
  const t = pn.armarTablero({
    categorias: [{ id: 'b', nombre: 'Nueces', plus: ['3'] }, { id: 'a', nombre: 'Almendras', plus: ['1', '2'] }],
    nombres: new Map([['1', 'ALMENDRA 500G']]),
    ventas: new Map([['1', 120]]),
    stock: new Map([['1', 10], ['3', 0]]),
  }, { diasConsumo: 120, diasCubrir: 30 });
  assert.deepStrictEqual(t.params, { diasConsumo: 120, diasCubrir: 30 });
  assert.deepStrictEqual(t.categorias.map(c => c.nombre), ['Almendras', 'Nueces']);
  assert.deepStrictEqual(t.categorias[0].presentaciones, [
    { plu: '1', nombre: 'ALMENDRA 500G', consumoDia: 1, consumoMes: 30, stockCentral: 10, sugerido: 20 },
    { plu: '2', nombre: 'PLU 2', consumoDia: 0, consumoMes: 0, stockCentral: null, sugerido: 0 },
  ]);
  assert.strictEqual(t.categorias[1].presentaciones[0].stockCentral, 0);
});

test('nombresResponsables: acepta {nombre} y textos, sin repetidos ni vacíos', () => {
  assert.deepStrictEqual(pn.nombresResponsables([{ nombre: 'Ana', corto: 'ANA' }, 'Beto', { nombre: 'Ana' }, null, {}]), ['Ana', 'Beto']);
  assert.deepStrictEqual(pn.nombresResponsables(undefined), []);
});

// ── Órdenes ─────────────────────────────────────────────────────────────────────────────────
const CTXO = { categorias: [{ id: 'a', nombre: 'Almendras', plus: ['1', '2'] }], responsables: [{ nombre: 'Ana', corto: 'ANA' }, 'Beto'] };
const linea = (x = {}) => ({ plu: '1', nombre: 'ALMENDRA 500G', cantidad: 5, responsables: ['Ana'], notas: '', ...x });
const orden = (x = {}) => ({ fecha: '2026-10-22', notas: ' urgente ', lineas: [linea()], ...x });

test('validarOrden: fecha, notas recortadas y líneas con la categoría del catálogo (no la del cliente)', () => {
  const body = orden({ lineas: [linea({ categoria: 'trucha', responsables: ['Ana', 'Beto', 'Ana'], notas: ' tostar ' })] });
  assert.deepStrictEqual(pn.validarOrden(body, CTXO), {
    fecha: '2026-10-22', notas: 'urgente',
    lineas: [{ plu: '1', nombre: 'ALMENDRA 500G', categoria: 'Almendras', cantidad: 5, responsables: ['Ana', 'Beto'], notas: 'tostar' }],
  });
});

test('validarOrden: nombre vacío → "PLU n"; responsables vacíos permitidos', () => {
  const [l] = pn.validarOrden(orden({ lineas: [linea({ nombre: '', responsables: [] })] }), CTXO).lineas;
  assert.strictEqual(l.nombre, 'PLU 1');
  assert.deepStrictEqual(l.responsables, []);
});

test('validarOrden: datos inválidos → 400', () => {
  const casos = {
    'fecha inexistente': orden({ fecha: '2026-02-30' }),
    'fecha con otro formato': orden({ fecha: '22/10/2026' }),
    'sin fecha': orden({ fecha: undefined }),
    'sin líneas': orden({ lineas: [] }),
    'líneas no lista': orden({ lineas: 'x' }),
    'más de 200 líneas': orden({ lineas: Array.from({ length: 201 }, () => linea()) }),
    'PLU fuera del catálogo': orden({ lineas: [linea({ plu: '9' })] }),
    'PLU repetido': orden({ lineas: [linea(), linea()] }),
    'cantidad 0': orden({ lineas: [linea({ cantidad: 0 })] }),
    'cantidad decimal': orden({ lineas: [linea({ cantidad: 1.5 })] }),
    'cantidad texto': orden({ lineas: [linea({ cantidad: '5' })] }),
    'cantidad null': orden({ lineas: [linea({ cantidad: null })] }),
    'responsable inexistente': orden({ lineas: [linea({ responsables: ['Zoe'] })] }),
    'responsables no lista': orden({ lineas: [linea({ responsables: 'Ana' })] }),
    'notas de la orden largas': orden({ notas: 'x'.repeat(501) }),
    'notas de línea largas': orden({ lineas: [linea({ notas: 'x'.repeat(501) })] }),
  };
  for (const [caso, body] of Object.entries(casos)) assert.throws(() => pn.validarOrden(body, CTXO), es(400), caso);
});

test('crearOrden: número correlativo, estado activa, usuario y sin mutar', () => {
  const previas = [{ id: 'x', numero: 7, estado: 'anulada' }];
  const datos = pn.validarOrden(orden(), CTXO);
  const r = pn.crearOrden(previas, datos, { id: 'o1', ahora: '2026-10-22T12:00:00.000Z', usuario: 'adriel' });
  assert.deepStrictEqual(r.orden, { id: 'o1', numero: 8, ...datos, creado: '2026-10-22T12:00:00.000Z', usuario: 'adriel', estado: 'activa' });
  assert.strictEqual(r.ordenes.length, 2);
  assert.strictEqual(previas.length, 1);
  assert.strictEqual(pn.crearOrden([], datos, { id: 'o2', ahora: 'x', usuario: 'u' }).orden.numero, 1);
});

test('ordenesRecientes: la de número más alto primero, sin mutar', () => {
  const lista = [{ numero: 1 }, { numero: 3 }, { numero: 2 }];
  assert.deepStrictEqual(pn.ordenesRecientes(lista).map(o => o.numero), [3, 2, 1]);
  assert.deepStrictEqual(lista.map(o => o.numero), [1, 3, 2]);
});

test('calcularFila: stock negativo en SIGA se muestra real pero no infla el sugerido', () => {
  const f = pn.calcularFila({ plu: '1', nombre: 'X', unidades: 60, stock: -5 }, { diasConsumo: 30, diasCubrir: 10 });
  assert.strictEqual(f.stockCentral, -5);
  assert.strictEqual(f.sugerido, 20); // 2/día × 10 − max(0, −5), no 25
});
