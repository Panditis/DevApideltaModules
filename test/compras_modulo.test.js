const test = require('node:test');
const assert = require('node:assert');
const { sugeridoCompra } = require('../compras_modulo');

test('sugeridoCompra suma las tres señales', () => {
  const r = sugeridoCompra({
    pideTotal: 50, central: 30,
    enviarMicro: { riv: { qty: 4 }, urq: { qty: 2 } },
    tramos: [{ hastaS: null, pct: 0.25 }], pisoAbsoluto: 3,
  });
  // deficitReposicion = max(50-30,0) = 20
  // deficitMicro = 4+2 = 6
  // faltanteReal = max(pisoMinimo(50,[.25],3) - 30,0) = max(round(12.5)-30,0)=max(13-30,0)=0
  assert.strictEqual(r.deficitReposicion, 20);
  assert.strictEqual(r.deficitMicro, 6);
  assert.strictEqual(r.faltanteReal, 0);
  assert.strictEqual(r.sugerido, 26);
});

test('sugeridoCompra faltanteReal cuando central bajo piso', () => {
  const r = sugeridoCompra({
    pideTotal: 100, central: 5,
    enviarMicro: {},
    tramos: [{ hastaS: null, pct: 0.25 }], pisoAbsoluto: 3,
  });
  // deficitReposicion = 95 ; deficitMicro = 0
  // faltanteReal = max(pisoMinimo(100,[.25],3) - 5,0) = max(25-5,0)=20
  assert.strictEqual(r.faltanteReal, 20);
  assert.strictEqual(r.sugerido, 115);
});

test('sugeridoCompra clampa a 0 y tolera entradas vacías', () => {
  const r = sugeridoCompra({ pideTotal: 0, central: 100, enviarMicro: {}, tramos: [], pisoAbsoluto: 0 });
  assert.strictEqual(r.sugerido, 0);
});
