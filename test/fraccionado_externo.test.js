const test = require('node:test');
const assert = require('node:assert');
const {
  calcularCostoItem, construirItemPedido, siguienteNumero, construirPedido, anularPedido,
} = require('../lib/fraccionado_externo');

test('calcularCostoItem calcula costo unitario y total', () => {
  const r = calcularCostoItem({ minPorPaquete: 1, paquetes: 10, factorComplejidad: 1, valorHora: 6000 });
  assert.strictEqual(r.costoUnitario, 100); // 6000/60 * 1 * 1
  assert.strictEqual(r.costoTotal, 1000);
});

test('calcularCostoItem aplica el factor de complejidad como multiplicador', () => {
  const r = calcularCostoItem({ minPorPaquete: 1, paquetes: 10, factorComplejidad: 1.2, valorHora: 6000 });
  assert.strictEqual(r.costoUnitario, 120);
  assert.strictEqual(r.costoTotal, 1200);
});

test('calcularCostoItem rechaza valores no positivos o no numéricos', () => {
  const base = { minPorPaquete: 1, paquetes: 10, factorComplejidad: 1, valorHora: 6000 };
  assert.throws(() => calcularCostoItem({ ...base, minPorPaquete: 0 }), /minPorPaquete/);
  assert.throws(() => calcularCostoItem({ ...base, paquetes: -1 }), /paquetes/);
  assert.throws(() => calcularCostoItem({ ...base, factorComplejidad: 0 }), /factorComplejidad/);
  assert.throws(() => calcularCostoItem({ ...base, valorHora: NaN }), /valorHora/);
});

test('construirItemPedido arma el item con el costo calculado', () => {
  const item = construirItemPedido({
    plu: '1101', nombre: 'Oregano Premium 50G', presentacion: '50G',
    minPorPaquete: 0.31, origenTiempo: 'historial', paquetes: 400, factorComplejidad: 1.15, valorHora: 8100,
  });
  assert.strictEqual(item.plu, '1101');
  assert.strictEqual(item.origenTiempo, 'historial');
  assert.strictEqual(item.costoUnitario, Math.round((8100 / 60) * 0.31 * 1.15));
});

test('construirItemPedido rechaza origenTiempo inválido', () => {
  assert.throws(() => construirItemPedido({
    plu: '1', nombre: 'X', minPorPaquete: 1, origenTiempo: 'lo_que_sea', paquetes: 1, factorComplejidad: 1, valorHora: 8100,
  }), /origenTiempo/);
});

test('siguienteNumero arranca en FE-0001 con lista vacía', () => {
  assert.strictEqual(siguienteNumero([]), 'FE-0001');
});

test('siguienteNumero toma el máximo y suma uno, ignorando formatos raros', () => {
  const pedidos = [{ numero: 'FE-0003' }, { numero: 'FE-0001', estado: 'ANULADO' }, { numero: 'raro' }];
  assert.strictEqual(siguienteNumero(pedidos), 'FE-0004');
});

test('construirPedido arma el pedido con total y rechaza items vacíos o tercero ausente', () => {
  const items = [{
    plu: '1101', nombre: 'Oregano Premium 50G', presentacion: '50G',
    minPorPaquete: 0.31, origenTiempo: 'historial', paquetes: 400, factorComplejidad: 1.15,
  }];
  const pedido = construirPedido({
    numero: 'FE-0001', fechaISO: '2026-09-14', tercero: 'Fraccionadora Sur',
    valorHora: 8100, items, ts: '2026-09-14T10:00:00.000Z',
  });
  assert.strictEqual(pedido.estado, 'PENDIENTE');
  assert.strictEqual(pedido.items.length, 1);
  assert.strictEqual(pedido.total, pedido.items[0].costoTotal);
  assert.throws(() => construirPedido({ numero: 'FE-0002', fechaISO: '2026-09-14', tercero: 'X', valorHora: 8100, items: [] }), /no tiene items/);
  assert.throws(() => construirPedido({ numero: 'FE-0002', fechaISO: '2026-09-14', tercero: '', valorHora: 8100, items }), /tercero/);
});

test('anularPedido cambia el estado y agrega al historial, sin mutar el original', () => {
  const pedido = { numero: 'FE-0001', estado: 'PENDIENTE', historial: [{ ts: 't0', accion: 'creado' }] };
  const anulado = anularPedido(pedido, { ts: 't1', usuario: 'ana' });
  assert.strictEqual(anulado.estado, 'ANULADO');
  assert.strictEqual(anulado.historial.length, 2);
  assert.strictEqual(pedido.estado, 'PENDIENTE'); // original sin mutar
  assert.throws(() => anularPedido(anulado, { ts: 't2' }), /ya está anulado/);
});
