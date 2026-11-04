'use strict';
// Export a SIGA con una presentación mayorista de Fraccionado: el pack/bulto vinculado sale con el precio por descuento
// (spec precios_fraccionado_mayorista_activar), y el de una presentación minorista con el de la tabla de márgenes.
const test = require('node:test');
const assert = require('node:assert');
const L = require('../lib/precios_listado_esquema');

// Ejemplo de control: costo 1000, margen 40 %, extras 0, IVA 21 %, redondeo 50, desc 10/10.
const T40 = { minPct: 40, maxPct: 40, escalones: 1, rango: { desde: 1, hasta: 2 } };
const CFG = { ivaVentaPct: 21, toleranciaPct: 5, modoGastos: 'costo', gastosVenta: [], extrasMinorista: [],
  margenes: { minorista: T40, pack: T40, bulto: T40 }, redondeo: { minorista: 50, packNeto: 50, packIva: 50, bultoNeto: 50, bultoIva: 50 } };
const VINC = [{ tipo: 'pack', plu: '201', nombre: 'Pack 201', unidades: 25, vigente: null }, { tipo: 'bulto', plu: '202', nombre: 'Bulto 202', unidades: 25, vigente: null }];

const presentacion = variante => ({ ...L.filaProducto({ plu: '101', nombre: 'Almendras 25Kg', tipo: 'fraccionado',
  costos: { sistema: 1000, ultimaCompra: null, manual: null }, pesoG: 25000, mayoristas: VINC, cfg: CFG, variante }), mayorista: variante === 'mayorista' });
const exportar = variante => {
  const granel = { plu: '100', nombre: 'Almendras', costoSistema: 1000, sugeridos: {}, mayoristas: [], presentaciones: [presentacion(variante)], decision: { fuente: 'sistema' } };
  return L.listasExport(L.itemsDecididos({ fraccionado: [granel] }).items);
};
const venta = (lista, plu) => (lista.find(f => String(f[0]) === plu) || [])[3];

test('export: presentación mayorista → pack/bulto vinculados con el precio por descuento (31500/38100 y 28350/34300)', () => {
  const l = exportar('mayorista');
  assert.deepStrictEqual([venta(l.packNeto, '201'), venta(l.packIva, '201')], [31500, 38100]);
  assert.deepStrictEqual([venta(l.bultoNeto, '202'), venta(l.bultoIva, '202')], [28350, 34300]);
});

test('export: la misma presentación minorista → pack/bulto con la tabla (margen 40 %), minorista igual en ambas', () => {
  const min = exportar('minorista'), may = exportar('mayorista');
  assert.strictEqual(venta(min.packNeto, '201'), 35000); // 1400 × 25
  assert.strictEqual(venta(min.bultoNeto, '202'), 35000);
  assert.deepStrictEqual(min.minorista, may.minorista);
});
