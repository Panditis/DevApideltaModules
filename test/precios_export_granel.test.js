'use strict';
// Export a SIGA: el granel de Fraccionado decidido sale como una fila más en minorista (Costo $/kg en pantalla, Venta $/kg).
const test = require('node:test');
const assert = require('node:assert');
const L = require('../lib/precios_listado_esquema');

const ENC = ['Codigo', 'Nombre', 'Costo', 'Venta'];
const sug = precio => ({ minorista: { precio }, mayoristas: [] });
const granel = (extra = {}) => ({
  plu: '100', nombre: 'Almendras', costoSistema: 1000, costoUltimaCompra: 1500, costoManual: null,
  sugeridos: { sistema: sug(1800), ultimaCompra: sug(2700) }, mayoristas: [],
  presentaciones: ['101', '102', '103'].map(plu => ({ plu, nombre: `Almendras ${plu}`, sugeridos: { sistema: sug(Number(plu) * 10) }, mayoristas: [] })),
  decision: { fuente: 'sistema' }, ...extra,
});
const exportar = fraccionado => {
  const { items, omitidos } = L.itemsDecididos({ fraccionado });
  return { listas: L.listasExport(items), omitidos };
};

test('granel con 3 presentaciones: 1 sola fila de granel, Codigo numérico, presentaciones iguales que antes', () => {
  const { listas, omitidos } = exportar([granel()]);
  assert.strictEqual(omitidos, 0);
  assert.deepStrictEqual(listas.minorista, [ENC,
    [101, 'Almendras 101', 1000, 1010], [102, 'Almendras 102', 1000, 1020], [103, 'Almendras 103', 1000, 1030],
    [100, 'Almendras', 1000, 1800]]);
  for (const l of L.LISTAS_EXPORT.filter(l => l !== 'minorista')) assert.deepStrictEqual(listas[l], [ENC]);
});

test('granel: Costo y Venta de la fuente decidida', () => {
  const { listas } = exportar([granel({ decision: { fuente: 'ultimaCompra' } })]);
  assert.deepStrictEqual(listas.minorista.find(f => f[0] === 100), [100, 'Almendras', 1500, 2700]);
});

test('granel sin PLU o sin sugerido con la fuente: no sale y cuenta como omitido', () => {
  const sinPlu = exportar([granel({ plu: null })]);
  assert.strictEqual(sinPlu.omitidos, 1);
  assert.strictEqual(sinPlu.listas.minorista.length, 4);
  const sinSug = exportar([granel({ sugeridos: {} })]);
  assert.strictEqual(sinSug.omitidos, 1);
  assert.ok(!sinSug.listas.minorista.some(f => f[0] === 100));
});

test('granel sin decisión no sale', () => {
  assert.deepStrictEqual(exportar([granel({ decision: null })]).listas.minorista, [ENC]);
});

test('PLU del granel repetido en la lista minorista: no se duplica', () => {
  const g = granel();
  const conPres100 = granel({ plu: '100', presentaciones: [{ ...g.presentaciones[0], plu: '100' }] });
  assert.strictEqual(exportar([conPres100]).listas.minorista.filter(f => f[0] === 100).length, 1);
  assert.strictEqual(exportar([granel(), granel()]).listas.minorista.filter(f => f[0] === 100).length, 1);
});
