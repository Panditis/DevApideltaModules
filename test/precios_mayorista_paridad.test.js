'use strict';
// Paridad: el front reclasifica local (conMarcaMayoristaLst) lo mismo que el server (esMayoristaPresentacion). Si una cambia, esto falla.
// Además: export a SIGA con Almacén + Fraccionado mantiene encabezado y orden (Almacén, presentaciones, granel al final).
const test = require('node:test');
const assert = require('node:assert');
const { esMayoristaPresentacion } = require('../lib/precios_fraccionado_costo');
const { conMarcaMayoristaLst } = require('../public/js/precios_listados.js');
const L = require('../lib/precios_listado_esquema');

test('paridad front/back: misma clasificación para pesos, umbrales y marcas', () => {
  for (const pesoG of [null, 0, 1, 499, 500, 501, 5000])
    for (const pesoMinG of [null, 1, 500, 5000])
      for (const marca of [undefined, true, false]) {
        const porPlu = marca === undefined ? {} : { 7: marca };
        const back = esMayoristaPresentacion(pesoG, '7', { pesoMinG, porPlu });
        const front = conMarcaMayoristaLst({ plu: '7', pesoG }, marca === undefined ? null : marca, pesoMinG);
        assert.deepStrictEqual({ mayorista: front.mayorista, origen: front.mayoristaOrigen }, back, JSON.stringify({ pesoG, pesoMinG, marca }));
      }
});

test('una sola regla: el back re-exporta la de precios_esquema (la que usa el front)', () => {
  assert.strictEqual(esMayoristaPresentacion, require('../lib/precios_esquema').esMayoristaPresentacion);
});

test('export SIGA: encabezado Codigo|Nombre|Costo|Venta y orden almacén → presentaciones → granel', () => {
  const sug = precio => ({ minorista: { precio }, mayoristas: [] });
  const almacen = [{ plu: '50', nombre: 'Yerba', costoSistema: 10, sugeridos: { sistema: sug(20) }, mayoristas: [], decision: { fuente: 'sistema' } }];
  const fraccionado = [{ plu: '100', nombre: 'Nuez', costoSistema: 1000, sugeridos: { sistema: sug(1800) }, mayoristas: [], decision: { fuente: 'sistema' },
    presentaciones: [{ plu: '101', nombre: 'Nuez 100G', sugeridos: { sistema: sug(250) }, mayoristas: [], mayorista: true }] }];
  const { items } = L.itemsDecididos({ almacen, fraccionado });
  assert.deepStrictEqual(L.listasExport(items).minorista,
    [['Codigo', 'Nombre', 'Costo', 'Venta'], [50, 'Yerba', 10, 20], [101, 'Nuez 100G', 1000, 250], [100, 'Nuez', 1000, 1800]]);
});
