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

const { redondearABulto } = require('../compras_modulo');

test('redondearABulto redondea hacia arriba al múltiplo', () => {
  assert.strictEqual(redondearABulto(15, 12).cantidad, 24); // 2 bultos
  assert.strictEqual(redondearABulto(15, 12).bultos, 2);
});
test('redondearABulto múltiplo exacto no cambia', () => {
  assert.strictEqual(redondearABulto(24, 12).cantidad, 24);
  assert.strictEqual(redondearABulto(24, 12).bultos, 2);
});
test('redondearABulto sin bulto cargado devuelve la cantidad tal cual', () => {
  const r = redondearABulto(15, null);
  assert.strictEqual(r.cantidad, 15);
  assert.strictEqual(r.bultos, null);
  assert.strictEqual(r.sinBulto, true);
});
test('redondearABulto 1 unidad sobre múltiplo sube un bulto', () => {
  assert.strictEqual(redondearABulto(13, 12).cantidad, 24);
});

const { coberturaPorProveedor } = require('../compras_modulo');

test('coberturaPorProveedor agrupa items por proveedor con costo y cobertura', () => {
  const items = [
    { plu: '1', cantidad: 10, proveedor: 'ACME', costoUnit: 2 },
    { plu: '2', cantidad: 5,  proveedor: 'ACME', costoUnit: 4 },
    { plu: '3', cantidad: 3,  proveedor: 'BETA', costoUnit: 10 },
    { plu: '4', cantidad: 2,  proveedor: null,   costoUnit: 0 }, // sin proveedor
  ];
  const r = coberturaPorProveedor(items);
  const acme = r.find(p => p.proveedor === 'ACME');
  assert.strictEqual(acme.itemsCubiertos, 2);
  assert.strictEqual(acme.totalItems, 4);
  assert.strictEqual(acme.costoTotal, 10*2 + 5*4); // 40
  const beta = r.find(p => p.proveedor === 'BETA');
  assert.strictEqual(beta.itemsCubiertos, 1);
  assert.strictEqual(beta.costoTotal, 30);
  // ordenado por itemsCubiertos desc
  assert.strictEqual(r[0].proveedor, 'ACME');
});
