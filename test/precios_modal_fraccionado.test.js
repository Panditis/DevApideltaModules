'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { resumenCosteoFraccMd, conInsumosMd, opcionesMaquinaMd } = require('../public/js/precios_modal_fraccionado.js');

test('resumenCosteoFraccMd: insumos, MO y máquina por unidad, extra $/kg, mercadería y costo real de la fuente elegida', () => {
  const p = { costos: { sistema: 1415, ultimaCompra: 1615 }, costeoPresentacion: { porUnidad: 207.5, extraKg: 415, origenInsumos: 'regla' },
    componentesCosto: [{ plu: '900', rol: 'insumo', cantidad: 1, costoUnit: 20, importe: 20 }, { plu: '_manoObra', rol: 'mo', cantidad: 1.25, costoUnit: 6000, importe: 125 },
      { plu: '_maquina', rol: 'maquina', nombre: 'Envasadora', cantidad: 1.25, costoUnit: 3000, importe: 62.5 }] };
  const r = resumenCosteoFraccMd(p, 'ultimaCompra', { sistema: 1000, ultimaCompra: 1200 });
  assert.deepStrictEqual([r.insumos.length, r.subtotalInsumos, r.mo.importe, r.maquina.nombre, r.porUnidad, r.extraKg, r.mercaderiaKg, r.costoKg],
    [1, 20, 125, 'Envasadora', 207.5, 415, 1200, 1615]);
  const faltante = resumenCosteoFraccMd({ componentesCosto: [{ plu: '9', rol: 'insumo', importe: null }] }, 'sistema', {});
  assert.deepStrictEqual([faltante.subtotalInsumos, faltante.mo, faltante.costoKg], [null, null, null]);
});

test('conInsumosMd: agrega los elegidos con cantidad 1 sin repetir', () => {
  assert.deepStrictEqual(conInsumosMd([{ plu: '900', nombre: 'Bolsa', cantidad: 2 }], [{ plu: 900, nombre: 'Bolsa' }, { plu: '901', nombre: 'Etiqueta' }]),
    [{ plu: '900', nombre: 'Bolsa', cantidad: 2 }, { plu: '901', nombre: 'Etiqueta', cantidad: 1 }]);
});

test('opcionesMaquinaMd: "Sin máquina" + cada máquina, la del granel seleccionada y escapada', () => {
  const html = opcionesMaquinaMd([{ id: 'env', nombre: 'Envasadora <A>' }], 'env');
  assert.match(html, /<option value="">Sin máquina<\/option>/);
  assert.match(html, /<option value="env" selected>Envasadora &lt;A&gt;<\/option>/);
});
