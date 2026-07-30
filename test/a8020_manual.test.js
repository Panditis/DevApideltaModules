const test = require('node:test');
const assert = require('node:assert');
const { aplicarManualA8020, asegurarBrechaMinS } = require('../a8020');

// Caché mínimo: 1 PLU con dos sucursales calculadas.
const cacheBase = () => ({
  abc: { '1770': 'A' },
  mins:    { '1770': { riv: 5, urq: 4 } },
  sLevels: { '1770': { riv: 9, urq: 7 } },
  detalle: { '1770': { riv: { mu: 0.62, sigma: 0.9, S: 9, min: 5 },
                       urq: { mu: 0.35, sigma: 0.6, S: 7, min: 4 } } },
});

test('sin ajustes manuales deja mins/sLevels iguales al calculado', () => {
  const c = aplicarManualA8020(cacheBase(), {});
  assert.deepStrictEqual(c.sLevels['1770'], { riv: 9, urq: 7 });
  assert.deepStrictEqual(c.mins['1770'], { riv: 5, urq: 4 });
  assert.strictEqual(c.detalle['1770'].riv.manual, undefined);
});

test('fija S y min en una sucursal sin tocar las otras ni el calculado', () => {
  const c = aplicarManualA8020(cacheBase(), { '1770': { riv: { S: 24, min: 8 } } });
  assert.strictEqual(c.sLevels['1770'].riv, 24);
  assert.strictEqual(c.mins['1770'].riv, 8);
  assert.strictEqual(c.sLevels['1770'].urq, 7, 'urquiza queda con el calculado');
  assert.strictEqual(c.detalle['1770'].riv.S, 9, 'el calculado sigue visible en detalle');
  assert.strictEqual(c.detalle['1770'].riv.min, 5);
  assert.strictEqual(c.detalle['1770'].riv.manual, true);
});

test('la observación del fijo viaja al caché y se limpia al quitarlo', () => {
  const c = aplicarManualA8020(cacheBase(),
    { '1770': { riv: { S: 24, min: 8, nota: 'Pedido especial del local', ts: '2026-07-29T13:00:00.000Z' } } });
  assert.strictEqual(c.detalle['1770'].riv.manualNota, 'Pedido especial del local');
  assert.strictEqual(c.detalle['1770'].riv.manualTs, '2026-07-29T13:00:00.000Z');
  const limpio = aplicarManualA8020(c, {});
  assert.strictEqual(limpio.detalle['1770'].riv.manualNota, undefined);
  assert.strictEqual(limpio.detalle['1770'].riv.manualTs, undefined);
});

test('fijar sólo S deja el min calculado', () => {
  const c = aplicarManualA8020(cacheBase(), { '1770': { riv: { S: 24 } } });
  assert.strictEqual(c.sLevels['1770'].riv, 24);
  assert.strictEqual(c.mins['1770'].riv, 5);
});

test('un recálculo posterior no pisa el fijo', () => {
  const manual = { '1770': { riv: { S: 24, min: 8 } } };
  // Recálculo: el motor produjo otros valores; el manual se reaplica encima.
  const recalculado = cacheBase();
  recalculado.detalle['1770'].riv = { mu: 1.2, sigma: 1.1, S: 14, min: 7 };
  recalculado.sLevels['1770'].riv = 14; recalculado.mins['1770'].riv = 7;
  const c = aplicarManualA8020(recalculado, manual);
  assert.strictEqual(c.sLevels['1770'].riv, 24);
  assert.strictEqual(c.mins['1770'].riv, 8);
  assert.strictEqual(c.detalle['1770'].riv.S, 14, 'detalle muestra el nuevo calculado');
});

test('reaplicar dos veces da el mismo resultado', () => {
  const manual = { '1770': { riv: { S: 24, min: 8 } } };
  const uno = aplicarManualA8020(cacheBase(), manual);
  const dos = aplicarManualA8020(aplicarManualA8020(cacheBase(), manual), manual);
  assert.deepStrictEqual(dos.sLevels, uno.sLevels);
  assert.deepStrictEqual(dos.mins, uno.mins);
});

test('quitar el fijo devuelve el valor calculado y limpia la marca', () => {
  const c = aplicarManualA8020(cacheBase(), { '1770': { riv: { S: 24, min: 8 } } });
  const limpio = aplicarManualA8020(c, {});
  assert.strictEqual(limpio.sLevels['1770'].riv, 9);
  assert.strictEqual(limpio.mins['1770'].riv, 5);
  assert.strictEqual(limpio.detalle['1770'].riv.manual, undefined);
});

test('fijo sobre un par (plu, sucursal) que el cálculo no produjo crea la fila', () => {
  const c = aplicarManualA8020(cacheBase(), { '1770': { nacion: { S: 6, min: 3 } } });
  assert.strictEqual(c.sLevels['1770'].nacion, 6);
  assert.strictEqual(c.mins['1770'].nacion, 3);
  assert.strictEqual(c.detalle['1770'].nacion.soloManual, true);
  assert.strictEqual(c.detalle['1770'].nacion.S, 0, 'calculado 0: no había fila');
});

// ── Brecha obligatoria min < S ────────────────────────────────────────────────
test('S igual al min sube a min + 1 unidad', () => {
  assert.deepStrictEqual(asegurarBrechaMinS(1, 1, 0), { min: 1, S: 2 });
  assert.deepStrictEqual(asegurarBrechaMinS(8, 8, 0), { min: 8, S: 9 });
});

test('S por debajo del min también se corrige', () => {
  assert.deepStrictEqual(asegurarBrechaMinS(5, 3, 0), { min: 5, S: 6 });
});

test('S ya mayor que el min queda intacto', () => {
  assert.deepStrictEqual(asegurarBrechaMinS(4, 8, 0), { min: 4, S: 8 });
});

test('en pesables el paso de la brecha es 0.1 kg', () => {
  assert.deepStrictEqual(asegurarBrechaMinS(1.5, 1.5, 1), { min: 1.5, S: 1.6 });
});

test('min y S en 0 (sin reposición) no inventan brecha', () => {
  assert.deepStrictEqual(asegurarBrechaMinS(0, 0, 0), { min: 0, S: 0 });
});

test('un fijo manual que empata min y S se corrige al aplicarlo', () => {
  const c = aplicarManualA8020(cacheBase(), { '1770': { riv: { S: 8, min: 8 } } });
  assert.strictEqual(c.mins['1770'].riv, 8);
  assert.strictEqual(c.sLevels['1770'].riv, 9, 'S sube una unidad sobre el min fijado');
});

test('fijar sólo el min por encima del S calculado mantiene la brecha', () => {
  const c = aplicarManualA8020(cacheBase(), { '1770': { urq: { min: 7 } } });   // S calculado = 7
  assert.strictEqual(c.mins['1770'].urq, 7);
  assert.strictEqual(c.sLevels['1770'].urq, 8);
});

test('acepta un caché vacío sin romper', () => {
  const c = aplicarManualA8020({}, { '99': { riv: { S: 2, min: 1 } } });
  assert.strictEqual(c.sLevels['99'].riv, 2);
  assert.strictEqual(c.mins['99'].riv, 1);
});

// ── Redondeo obligatorio: almacén en enteros, pesables con 1 decimal ──────────
// Un min/S fraccionado en un producto de almacén no existe físicamente (no se envía
// 0.8 de un pote) y además desactiva el gatillo: con min 0.8 un stock de 1 nunca pide.

const cacheDecimal = () => ({
  abc: { '2891': 'B', '5000': 'A' },
  rubros: { '2891': 'Almacen', '5000': 'Pesables Fraccionado' },
  mins:    { '2891': { urq: 0.8 }, '5000': { urq: 1.24 } },
  sLevels: { '2891': { urq: 2.6 }, '5000': { urq: 3.87 } },
  detalle: { '2891': { urq: { mu: 0.128, sigma: 0.449, S: 2.6, min: 0.8 } },
             '5000': { urq: { mu: 0.9,   sigma: 0.5,   S: 3.87, min: 1.24 } } },
});

test('almacen: el calculado decimal se redondea a entero en mins/sLevels', () => {
  const c = aplicarManualA8020(cacheDecimal(), {}, new Set([5000]));
  assert.strictEqual(c.mins['2891'].urq, 1, 'min 0.8 → 1');
  assert.strictEqual(c.sLevels['2891'].urq, 3, 'S 2.6 → 3');
});

test('pesables: conservan un decimal', () => {
  const c = aplicarManualA8020(cacheDecimal(), {}, new Set([5000]));
  assert.strictEqual(c.mins['5000'].urq, 1.2);
  assert.strictEqual(c.sLevels['5000'].urq, 3.9);
});

test('sin pesablesSet, el rubro del cache decide el redondeo', () => {
  const c = aplicarManualA8020(cacheDecimal(), {});
  assert.strictEqual(c.mins['2891'].urq, 1, 'Almacen → entero');
  assert.strictEqual(c.sLevels['2891'].urq, 3);
  assert.strictEqual(c.mins['5000'].urq, 1.2, 'Pesables Fraccionado → 1 decimal');
});

test('un fijo manual decimal en almacen tambien se redondea', () => {
  const c = aplicarManualA8020(cacheDecimal(), { '2891': { urq: { S: 4.4, min: 1.7 } } }, new Set([5000]));
  assert.strictEqual(c.mins['2891'].urq, 2, 'min manual 1.7 → 2');
  assert.strictEqual(c.sLevels['2891'].urq, 4, 'S manual 4.4 → 4');
});

test('el redondeo no puede dejar S pegado al min', () => {
  // min 1.6 → 2 y S 2.2 → 2: redondear por separado los empata y el envio queda en 0.
  const cache = {
    abc: { '77': 'B' }, rubros: { '77': 'Almacen' },
    mins: { '77': { urq: 1.6 } }, sLevels: { '77': { urq: 2.2 } },
    detalle: { '77': { urq: { S: 2.2, min: 1.6 } } },
  };
  const c = aplicarManualA8020(cache, {}, new Set());
  assert.ok(c.sLevels['77'].urq > c.mins['77'].urq,
    `S (${c.sLevels['77'].urq}) tiene que quedar por encima del min (${c.mins['77'].urq})`);
  assert.strictEqual(c.mins['77'].urq, 2);
  assert.strictEqual(c.sLevels['77'].urq, 3);
});

test('el redondeo respeta los valores ya enteros', () => {
  const c = aplicarManualA8020(cacheBase(), {}, new Set());
  assert.deepStrictEqual(c.mins['1770'], { riv: 5, urq: 4 });
  assert.deepStrictEqual(c.sLevels['1770'], { riv: 9, urq: 7 });
});
