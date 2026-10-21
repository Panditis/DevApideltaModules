'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { conTramoFr, sinTramoFr, conInsumosFr, sinInsumoFr } = require('../public/js/precios_config_fraccionado.js');

test('borrador de insumos por subrubro: tramos nuevos (250 g, después el doble), insumos sin repetir y quitar', () => {
  let b = conTramoFr({}, '7');
  assert.deepStrictEqual(b, { 7: [{ hastaG: 250, insumos: [] }] });
  b = conTramoFr(b, '7');
  assert.strictEqual(b[7][1].hastaG, 500);
  b = conInsumosFr(b, '7', 0, [{ plu: 900 }, { plu: '901' }]);
  b = conInsumosFr(b, '7', 0, [{ plu: '900' }]);
  assert.deepStrictEqual(b[7][0].insumos, [{ plu: '900', cantidad: 1 }, { plu: '901', cantidad: 1 }]);
  assert.deepStrictEqual(sinInsumoFr(b, '7', 0, '900')[7][0].insumos, [{ plu: '901', cantidad: 1 }]);
  assert.deepStrictEqual(sinTramoFr(b, '7', 0)[7].map(t => t.hastaG), [500]);
  assert.deepStrictEqual(b[7][1].insumos, []); // no muta el tramo de al lado
});
