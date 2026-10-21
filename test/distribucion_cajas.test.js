const test = require('node:test');
const assert = require('node:assert');
const { calcularFilaAlmacen, racionarPorCajas, presentacionDistribucion } = require('../lib/distribucion');

// Productos de almacén con presentación de compra (compras_presentaciones.json): el central manda
// cajas cerradas — floor(pide/caja) con mínimo 1; si no alcanza, cajas por urgencia y las sueltas
// a la más urgida que quedó corta.

const ORDEN = ['riv', 'urq', 'nacion', 'chaca', 'pergamino', 'sanpedro', 'sucu8', 'sucu9', 'sucu11'];
const PESOS = { riv: 0.5, chaca: 0.2, nacion: 0.12, urq: 0.08, pergamino: 0.06, sucu9: 0.03, sanpedro: 0.01, sucu8: 0, sucu11: 0 };
const S10 = Object.fromEntries(ORDEN.map(k => [k, 10]));
const pide = (o) => ({ ...Object.fromEntries(ORDEN.map(k => [k, 0])), ...o });

test('redondea hacia abajo a cajas con minimo 1 caja', () => {
  const r = racionarPorCajas(pide({ riv: 5, urq: 13, nacion: 23, chaca: 24 }), S10, 1000, PESOS, ORDEN, 12);
  assert.strictEqual(r.riv, 12);
  assert.strictEqual(r.urq, 12);
  assert.strictEqual(r.nacion, 12);
  assert.strictEqual(r.chaca, 24);
  assert.strictEqual(r.pergamino, 0);
});

test('escasez: una caja a cada una por urgencia y las sueltas a la mas urgida que quedo corta', () => {
  // 30 u, caja 12: riv (8/10) y urq (7/10) reciben caja; nacion (6/10) se lleva las 6 sueltas.
  const r = racionarPorCajas(pide({ riv: 8, urq: 7, nacion: 6 }), S10, 30, PESOS, ORDEN, 12);
  assert.deepStrictEqual([r.riv, r.urq, r.nacion], [12, 12, 6]);
});

test('escasez: la segunda caja se da recien cuando todas tienen una', () => {
  // riv quiere 2 cajas, urq 2 (pide 30 y 24). 40 u: 1 caja c/u (24), sobran 16 → 2da caja a riv
  // (más urgida); las 4 sueltas a urq, la que quedó corta.
  const r = racionarPorCajas(pide({ riv: 30, urq: 24 }), S10, 40, PESOS, ORDEN, 12);
  assert.deepStrictEqual([r.riv, r.urq], [24, 16]);
});

test('central con menos de una caja: las sueltas van a la mas urgida', () => {
  const r = racionarPorCajas(pide({ riv: 3, urq: 9 }), S10, 6, PESOS, ORDEN, 12);
  assert.deepStrictEqual([r.riv, r.urq], [0, 6]);
});

test('sin escasez las sueltas se quedan en el deposito', () => {
  const r = racionarPorCajas(pide({ riv: 13 }), S10, 30, PESOS, ORDEN, 12);
  assert.strictEqual(r.riv, 12);
});

// ── Integración con la fila: piso Micro y racionamiento quedan reemplazados ──
const LISTAS_VACIAS = { rivadavia: new Set(), urquiza: new Set(), nacion: new Set(),
  chacabuco: new Set(), pergamino: new Set(), sanPedro: new Set(), villaRamallo: new Set() };
// riv: pide 30 (stock 0). urq: min 19 / S 20 / stock 18 → pide 2, bajo el piso Micro (20% de 20 = 4).
const A = { minRiv: 4, SRiv: 30, minUrq: 19, SUrq: 20 };
const ST = { central: 100, riv: 0, urq: 18 };
const OPTS = { corregirBugs: true, umbralMicroEnvio: { tramos: [{ hastaS: null, pct: 0.2 }], pisoAbsoluto: 1 } };
const fila = (opts) => calcularFilaAlmacen(500, ST, A, {}, LISTAS_VACIAS, new Set(), 1, opts);

test('con caja, lo que salia Micro pasa a 1 caja y el resto se redondea abajo', () => {
  const sin = fila(OPTS);
  assert.strictEqual(sin.enviar.riv, 30);
  assert.strictEqual(sin.enviar.urq, 0);
  assert.ok(sin.enviarMicro.urq);
  const con = fila({ ...OPTS, cajaPorPlu: { 500: 12 } });
  assert.strictEqual(con.enviar.riv, 24);   // pide 30 → 2 cajas
  assert.strictEqual(con.enviar.urq, 12);   // pide 2 (Micro) → 1 caja
  assert.deepStrictEqual(con.enviarMicro, {});
});

test('presentacion para distribucion: hasta 20 queda, mas de 20 pasa a 10, sin tocar el original', () => {
  const p50 = { nombre: 'Caja', unidadesPorBulto: 50 };
  assert.deepStrictEqual(presentacionDistribucion(p50), { nombre: 'Caja', unidadesPorBulto: 10 });
  assert.strictEqual(p50.unidadesPorBulto, 50);
  assert.deepStrictEqual(presentacionDistribucion({ nombre: 'Pack', unidadesPorBulto: 18 }), { nombre: 'Pack', unidadesPorBulto: 18 });
  assert.deepStrictEqual(presentacionDistribucion({ nombre: 'Caja', unidadesPorBulto: 20 }), { nombre: 'Caja', unidadesPorBulto: 20 });
  assert.strictEqual(presentacionDistribucion(undefined), null);
});

test('caja de 1 o sin presentacion: comportamiento de siempre', () => {
  assert.deepStrictEqual(fila({ ...OPTS, cajaPorPlu: { 500: 1 } }).enviar, fila(OPTS).enviar);
});
