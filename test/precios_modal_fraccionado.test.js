'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { resumenCosteoFraccMd, opcionesMaquinaMd, formulaMinutosMd, textoSinTiempoMd, textoElegidoMd } = require('../public/js/precios_modal_fraccionado.js');

test('resumenCosteoFraccMd: insumos, MO y máquina por unidad, extra $/kg, mercadería y costo real de la fuente elegida', () => {
  const p = { costos: { sistema: 1415, ultimaCompra: 1615 }, costeoPresentacion: { porUnidad: 207.5, extraKg: 415 },
    componentesCosto: [{ plu: '900', rol: 'insumo', cantidad: 1, costoUnit: 20, importe: 20 }, { plu: '_manoObra', rol: 'mo', cantidad: 1.25, costoUnit: 6000, importe: 125 },
      { plu: '_maquina', rol: 'maquina', nombre: 'Envasadora', cantidad: 1.25, costoUnit: 3000, importe: 62.5 }] };
  const r = resumenCosteoFraccMd(p, 'ultimaCompra', { sistema: 1000, ultimaCompra: 1200 });
  assert.deepStrictEqual([r.insumos.length, r.subtotalInsumos, r.mo.importe, r.maquina.nombre, r.porUnidad, r.extraKg, r.mercaderiaKg, r.costoKg],
    [1, 20, 125, 'Envasadora', 207.5, 415, 1200, 1615]);
  const faltante = resumenCosteoFraccMd({ componentesCosto: [{ plu: '9', rol: 'insumo', importe: null }] }, 'sistema', {});
  assert.deepStrictEqual([faltante.subtotalInsumos, faltante.mo, faltante.costoKg], [null, null, null]);
});

test('resumenCosteoFraccMd: mercadería y costo real también por unidad (= $/kg × kg de la presentación, con la fuente del modal)', () => {
  const p = { pesoG: 500, costos: { sistema: 1415, ultimaCompra: 1615 }, costeoPresentacion: { porUnidad: 207.5, extraKg: 415 }, componentesCosto: [] };
  const r = resumenCosteoFraccMd(p, 'ultimaCompra', { sistema: 1000, ultimaCompra: 1200 });
  assert.deepStrictEqual([r.mercaderiaUnidad, r.costoUnidad], [600, 807.5]);
  // Fuente sin costo (o sin peso): nada por unidad, nunca 0
  assert.deepStrictEqual([resumenCosteoFraccMd(p, 'manual', { manual: null }).mercaderiaUnidad, resumenCosteoFraccMd(p, 'manual', {}).costoUnidad], [null, null]);
  assert.strictEqual(resumenCosteoFraccMd({ ...p, pesoG: null }, 'sistema', { sistema: 1000 }).costoUnidad, null);
});

test('opcionesMaquinaMd: "Del subrubro (X)" + cada máquina como excepción, la del granel seleccionada y escapada', () => {
  const html = opcionesMaquinaMd([{ id: 'env', nombre: 'Envasadora <A>' }], 'env', 'Selladora');
  assert.match(html, /<option value="">Del subrubro \(Selladora\)<\/option>/);
  assert.match(html, /<option value="env" selected>Envasadora &lt;A&gt;<\/option>/);
  assert.match(opcionesMaquinaMd([], null, null), /Del subrubro \(sin máquina\)/);
});

test('formulaMinutosMd: "base × tiempo × facilidad = minutos"; sin base (dato viejo) sólo los minutos', () => {
  assert.strictEqual(formulaMinutosMd({ minutosBase: 1, factorTiempo: 1.5, factorFacilidad: 1.25 }, 1.875), '1 × 1,5 (tiempo) × 1,25 (facilidad) = 1,875 min');
  assert.strictEqual(formulaMinutosMd({}, 2), '2 min');
});

test('textoSinTiempoMd: sin subrubro / sin tramos → sin minutos; con minutos y sin máquina → sin asignar', () => {
  assert.match(textoSinTiempoMd('mo', ['sinTramos']), /^Mano de obra — sin minutos \(cargá los tiempos por peso del subrubro en Configuración › Costeo Fraccionado\)$/);
  assert.strictEqual(textoSinTiempoMd('maquina', ['sinSubrubro', 'sinMaquina']), 'Máquina — sin minutos: el granel no tiene subrubro en SIGA');
  assert.strictEqual(textoSinTiempoMd('maquina', ['sinMaquina']), 'Máquina — sin asignar (ni del subrubro ni del granel)');
});

test('textoElegidoMd: facilidad y tiempo elegidos en la tab Fraccionado', () => {
  assert.strictEqual(textoElegidoMd({ facilidad: 'normal', tiempo: 'lento' }), 'Normal · Lento');
  assert.strictEqual(textoElegidoMd(undefined), 'sin facilidad · sin tiempo');
});
