'use strict';
// Helpers puros de la UI de Pack / Bulto (public/precios_pack_bulto.js). El archivo es un script de
// browser: sin `document` no arranca nada, sólo exporta los helpers.
const test = require('node:test');
const assert = require('node:assert');
const ui = require('../public/precios_pack_bulto.js');

const item = (plu, extra = {}) => ({ plu, nombre: `N${plu}`, tipo: 'pack', descPct: 9.7, descOverride: null,
  precioSugerido: 1000, precioVigente: null, deltaPct: null, semaforo: null, faltantes: [], revisarUnidad: false, marcado: false, ...extra });

test('fmtDescPB: descuento con signo menos, recargo con más, coma decimal', () => {
  assert.strictEqual(ui.fmtDescPB(9.7), '−9,7%');
  assert.strictEqual(ui.fmtDescPB(4.6745), '−4,67%');
  assert.strictEqual(ui.fmtDescPB(-5), '+5%');
  assert.strictEqual(ui.fmtDescPB(0), '0%');
  assert.strictEqual(ui.fmtDescPB(null), '—');
});

test('precioPackBultoCli: espejo del backend (redondeo $50 y alineado exacto)', () => {
  assert.strictEqual(ui.precioPackBultoCli(2995, 9.7, null), 2700);
  assert.strictEqual(ui.precioPackBultoCli(2995, 4.6745, 2855), 2855);
  assert.strictEqual(ui.precioPackBultoCli(3100, 4.6745, 2855), 2950);
  assert.strictEqual(ui.precioPackBultoCli(null, 9.7, 2855), null);
  assert.strictEqual(ui.precioPackBultoCli(1000, -10, null), 1100);
});

test('recalcularItemPB: sugerido, Δ y semáforo en vivo con la tolerancia; sin base → faltante', () => {
  const it = item('1', { precioVigente: 1000 });
  assert.deepStrictEqual(ui.recalcularItemPB(it, 1200, 5), { ...it, precioSugerido: 1100, deltaPct: 10, semaforo: 'subir', faltantes: [] });
  assert.deepStrictEqual(ui.recalcularItemPB(it, 1100, 5), { ...it, precioSugerido: 1000, deltaPct: 0, semaforo: 'ok', faltantes: [] });
  assert.deepStrictEqual(ui.recalcularItemPB(it, null, 5), { ...it, precioSugerido: null, deltaPct: null, semaforo: null, faltantes: ['base'] });
});

test('aplicarMarcadosPB: marca según el set sin mutar', () => {
  const orig = [item('1'), item('2', { marcado: true })];
  const r = ui.aplicarMarcadosPB(orig, new Set(['1']));
  assert.deepStrictEqual(r.map(i => i.marcado), [true, false]);
  assert.strictEqual(orig[0].marcado, false);
  assert.deepStrictEqual(ui.aplicarMarcadosPB(undefined, new Set()), []);
});

test('filasPBMarcadas: exporta pack/bulto marcados con el costo de su base (Almacén y Fraccionado), sin repetir', () => {
  const almacen = [{ plu: '10', costoTotal: 500, packBulto: [item('1', { marcado: true }), item('2')] }];
  const fracc = [{ costoTotal: 800, presentaciones: [{ plu: '20', packBulto: [item('3', { marcado: true, precioSugerido: null, faltantes: ['base'] })] }] }];
  assert.deepStrictEqual(ui.filasPBMarcadas(almacen, fracc), [
    { plu: '1', nombre: 'N1', costoTotal: 500, precioConIva: 1000, faltantes: [] },
    { plu: '3', nombre: 'N3', costoTotal: 800, precioConIva: null, faltantes: ['base'] },
  ]);
  assert.deepStrictEqual(ui.filasPBMarcadas([...almacen, ...almacen], []).map(f => f.plu), ['1']);
});

test('conPB: sólo filas con pack/bulto (filtro "Con pack/bulto")', () => {
  assert.strictEqual(ui.conPB({ packBulto: [item('1')] }), true);
  assert.strictEqual(ui.conPB({ packBulto: [] }), false);
  assert.strictEqual(ui.conPB({}), false);
});

test('resumenPB: "Pack: $X (−Y%) · Bulto: $Z (−W%)"', () => {
  const r = ui.resumenPB([item('1', { precioSugerido: 2700 }), item('2', { tipo: 'bulto', descPct: 14.7, precioSugerido: null })]);
  assert.strictEqual(r, 'Pack: $ 2.700 (−9,7%) · Bulto: sin precio (−14,7%)');
  assert.strictEqual(ui.resumenPB([]), '');
});

test('textoAlinearPB: título y motivos agrupados', () => {
  const t = ui.textoAlinearPB({ alineados: 3, omitidos: [
    { motivo: 'sin precio vigente' }, { motivo: 'revisar unidad (vigente ×10 del base)' }, { motivo: 'revisar unidad (vigente ×0,3 del base)' },
  ] });
  assert.strictEqual(t.titulo, '3 alineados · 3 omitidos');
  assert.deepStrictEqual(t.motivos, ['revisar unidad: 2', 'sin precio vigente: 1']);
});
