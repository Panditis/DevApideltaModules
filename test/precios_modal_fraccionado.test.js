'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { resumenCosteoFraccMd, conInsumosMd, opcionesMaquinaMd, formulaMinutosMd, textoSinTiempoMd } = require('../public/js/precios_modal_fraccionado.js');

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

test('resumenCosteoFraccMd: mercadería y costo real también por unidad (= $/kg × kg de la presentación, con la fuente del modal)', () => {
  const p = { pesoG: 500, costos: { sistema: 1415, ultimaCompra: 1615 }, costeoPresentacion: { porUnidad: 207.5, extraKg: 415 }, componentesCosto: [] };
  const r = resumenCosteoFraccMd(p, 'ultimaCompra', { sistema: 1000, ultimaCompra: 1200 });
  assert.deepStrictEqual([r.mercaderiaUnidad, r.costoUnidad], [600, 807.5]);
  // Fuente sin costo (o sin peso): nada por unidad, nunca 0
  assert.deepStrictEqual([resumenCosteoFraccMd(p, 'manual', { manual: null }).mercaderiaUnidad, resumenCosteoFraccMd(p, 'manual', {}).costoUnidad], [null, null]);
  assert.strictEqual(resumenCosteoFraccMd({ ...p, pesoG: null }, 'sistema', { sistema: 1000 }).costoUnidad, null);
});

test('formulaMinutosMd: "base × factor = minutos"; sin base (dato viejo) sólo los minutos', () => {
  assert.strictEqual(formulaMinutosMd({ minutosBase: 1, factor: 1.25 }, 1.25), '1 × 1,25 = 1,25 min');
  assert.strictEqual(formulaMinutosMd({ minutosBase: 0.5, factor: 1 }, 0.5), '0,5 × 1 = 0,5 min');
  assert.strictEqual(formulaMinutosMd({}, 2), '2 min');
});

test('textoSinTiempoMd: sin tiempos → "sin minutos" en MO y máquina; sin máquina asignada (con minutos) → "sin asignar"', () => {
  const sinTiempos = ['sinTiempos', 'sinMaquina'];
  assert.match(textoSinTiempoMd('mo', sinTiempos), /^Mano de obra — sin minutos \(cargá los tiempos en Configuración › Costeo Fraccionado\)$/);
  assert.match(textoSinTiempoMd('maquina', sinTiempos), /^Máquina — sin minutos \(cargá los tiempos/);
  assert.strictEqual(textoSinTiempoMd('maquina', ['sinMaquina']), 'Máquina — sin asignar');
  assert.match(textoSinTiempoMd('maquina', []), /sin minutos/); // máquina asignada pero minutos 0
});
