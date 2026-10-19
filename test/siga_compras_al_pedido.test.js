'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { aplicarGrabadoAPedido } = require('../lib/siga_compras/al_pedido');

const PEDIDO = {
  numero: 'P-0010', proveedor: 'PROV', estado: 'CERRADO', fechaRetiro: '2026-10-15', total: 1340,
  items: [
    { plu: '1001', nombre: 'Harina', unidad: 'KG', cantidad: 10, precioUnitario: 100, cantidadEntregada: 10, estado: 'entregado', obs: '' },
    { plu: '1002', nombre: 'Azúcar', unidad: 'KG', cantidad: 5, precioUnitario: 50, cantidadEntregada: 5, estado: 'entregado', obs: '' },
    { plu: '1003', nombre: 'Yerba', unidad: 'UN', cantidad: 4, precioUnitario: 30, cantidadEntregada: 0, estado: 'faltante', obs: '' },
    { plu: '1004', nombre: 'Yapa', unidad: 'UN', cantidad: 0, precioUnitario: 20, cantidadEntregada: 2, estado: 'extra', obs: '' },
    { plu: '1005', nombre: 'Té', unidad: 'UN', cantidad: 3, precioUnitario: 10, cantidadEntregada: 0, estado: 'sin_stock', obs: '' },
  ],
  historial: [{ ts: '2026-10-01T10:00:00.000Z', usuario: 'ana', accion: 'creado' }],
};
const OPC = { clave: '1|FACTCOM|A|5007|1071364', usuario: 'adriel', ts: '2026-10-19T13:00:00.000Z', nombres: { 2001: 'AZUCAR X 50' } };
const linea = (plu, cantidad, precio, orden = 1) => ({ orden, plu, cantidad, precio });
const item = (p, plu) => p.items.filter(it => it.plu === plu);
const conItems = items => ({ ...PEDIDO, items });

test('cantidad y precio editados: la línea queda entregada con lo grabado', () => {
  const p = aplicarGrabadoAPedido(PEDIDO, [linea('1001', 8, 95), linea('1002', 5, 50), linea('1004', 2, 20)], OPC);
  assert.deepStrictEqual(item(p, '1001'), [{ ...PEDIDO.items[0], cantidadEntregada: 8, precioUnitario: 95 }]);
  assert.deepStrictEqual(item(p, '1002'), [PEDIDO.items[1]]);
});

test('quitados al importar: entregado → faltante con 0, un extra se borra y los quiebres quedan igual', () => {
  const p = aplicarGrabadoAPedido(PEDIDO, [linea('1001', 10, 100)], OPC);
  assert.deepStrictEqual(item(p, '1002'), [{ ...PEDIDO.items[1], estado: 'faltante', cantidadEntregada: 0 }]);
  assert.deepStrictEqual(item(p, '1004'), []);
  assert.deepStrictEqual(item(p, '1003'), [PEDIDO.items[2]]);
  assert.deepStrictEqual(item(p, '1005'), [PEDIDO.items[4]]);
});

test('un extra grabado sigue extra con la cantidad y el precio grabados (sin tope: no tiene "lo pedido")', () => {
  const p = aplicarGrabadoAPedido(PEDIDO, [linea('1001', 10, 100), linea('1004', 7, 25)], OPC);
  assert.deepStrictEqual(item(p, '1004'), [{ ...PEDIDO.items[3], cantidadEntregada: 7, precioUnitario: 25 }]);
});

test('un quiebre que se grabó igual pasa a entregado', () => {
  const p = aplicarGrabadoAPedido(PEDIDO, [linea('1003', 3, 31)], OPC);
  assert.deepStrictEqual(item(p, '1003'), [{ ...PEDIDO.items[2], estado: 'entregado', cantidadEntregada: 3, precioUnitario: 31 }]);
});

test('PLU grabado que no estaba en el pedido: línea extra nueva con el nombre de SIGA (o el PLU) y unidad UN', () => {
  const p = aplicarGrabadoAPedido(PEDIDO, [linea('1001', 10, 100), linea('2001', 2, 50.5), linea('2002', 1, 9)], OPC);
  assert.deepStrictEqual(p.items.slice(-2), [
    { plu: '2001', nombre: 'AZUCAR X 50', unidad: 'UN', cantidad: 0, precioUnitario: 50.5, cantidadEntregada: 2, estado: 'extra', obs: '' },
    { plu: '2002', nombre: '2002', unidad: 'UN', cantidad: 0, precioUnitario: 9, cantidadEntregada: 1, estado: 'extra', obs: '' },
  ]);
});

test('PLU repetido en lo grabado: cantidad sumada; precio igual se respeta, distinto → promedio ponderado a 2', () => {
  const de = lineas => item(aplicarGrabadoAPedido(PEDIDO, lineas, OPC), '1001')[0];
  assert.deepStrictEqual([de([linea('1001', 3, 100), linea('1001', 1, 90, 2)])].map(l => [l.cantidadEntregada, l.precioUnitario]), [[4, 97.5]]);
  assert.strictEqual(de([linea('1001', 3, 10.333), linea('1001', 2, 10.333, 2)]).precioUnitario, 10.333);
  assert.strictEqual(de([linea('1001', 1, 10), linea('1001', 2, 10.01, 2)]).precioUnitario, 10.01);
  assert.strictEqual(de([linea('1001', 0.1, 5), linea('1001', 0.2, 5, 2)]).cantidadEntregada, 0.3);
});

test('excedente: la entrega se acota a lo pedido (como lib/compras.js) y queda anotado en el historial', () => {
  const p = aplicarGrabadoAPedido(PEDIDO, [linea('1001', 12, 100)], OPC);
  assert.strictEqual(item(p, '1001')[0].cantidadEntregada, 10);
  assert.ok(p.historial.at(-1).cambios.includes('1001: se grabaron 2 más de lo pedido (no se registran como entrega)'), p.historial.at(-1).cambios.join('\n'));
});

test('PLU repetido en el pedido: se reparte en orden hasta lo pedido; la que no recibe nada queda faltante; el resto va al extra', () => {
  const a = { plu: '1001', nombre: 'Harina', cantidad: 5, precioUnitario: 100, cantidadEntregada: 5, estado: 'entregado', obs: '' };
  const b = { ...a, obs: 'segunda' };
  const reparto = (items, cant) => item(aplicarGrabadoAPedido(conItems(items), [linea('1001', cant, 90)], OPC), '1001')
    .map(l => [l.estado, l.cantidadEntregada, l.precioUnitario]);
  assert.deepStrictEqual(reparto([a, b], 7), [['entregado', 5, 90], ['entregado', 2, 90]]);
  assert.deepStrictEqual(reparto([a, b], 3), [['entregado', 3, 90], ['faltante', 0, 90]]);
  const extra = { ...a, cantidad: 0, cantidadEntregada: 1, estado: 'extra' };
  assert.deepStrictEqual(reparto([extra, a], 8), [['extra', 3, 90], ['entregado', 5, 90]]);
  assert.deepStrictEqual(reparto([a, extra], 4), [['entregado', 4, 90]]);
});

test('no cambia estado, fecha de retiro ni cabecera y recalcula el total como lib/compras.js', () => {
  const p = aplicarGrabadoAPedido(PEDIDO, [linea('1001', 8, 95), linea('1002', 5, 50), linea('1004', 2, 20)], OPC);
  assert.deepStrictEqual([p.numero, p.proveedor, p.estado, p.fechaRetiro], ['P-0010', 'PROV', 'CERRADO', '2026-10-15']);
  // 10×95 + 5×50 + 4×30 + 0×20 (extra) + 3×10
  assert.strictEqual(p.total, 1350);
  const sinPrecios = conItems([{ ...PEDIDO.items[2], precioUnitario: null }]);
  assert.strictEqual(aplicarGrabadoAPedido(sinPrecios, [linea('1001', 1, 0)], OPC).total, null);
});

test('historial: agrega "importado a SIGA" con el comprobante y el resumen por PLU, sin tocar lo anterior', () => {
  const p = aplicarGrabadoAPedido(PEDIDO, [linea('1001', 8, 95), linea('1003', 4, 30), linea('2001', 2, 50.5)], OPC);
  assert.deepStrictEqual(p.historial.slice(0, -1), PEDIDO.historial);
  assert.deepStrictEqual(p.historial.at(-1), {
    ts: OPC.ts, usuario: 'adriel', accion: 'importado a SIGA', comprobante: OPC.clave,
    cambios: ['1001: 10 a $100 → 8 a $95', '1002: 5 a $50 → faltante', '1003: faltante → 4 a $30', '1004: 2 a $20 → quitado', '2001: no estaba → 2 a $50.5'],
  });
});

test('no muta el pedido ni las líneas recibidas', () => {
  const congelar = o => { Object.values(o).forEach(v => { if (v && typeof v === 'object') congelar(v); }); return Object.freeze(o); };
  const pedido = congelar(structuredClone(PEDIDO));
  const lineas = congelar([linea('1001', 12, 95), linea('2001', 2, 50.5)]);
  const antes = JSON.stringify(pedido);
  const p = aplicarGrabadoAPedido(pedido, lineas, OPC);
  assert.strictEqual(JSON.stringify(pedido), antes);
  assert.notStrictEqual(p, pedido);
  assert.notStrictEqual(p.items, pedido.items);
  assert.notStrictEqual(p.historial, pedido.historial);
});
