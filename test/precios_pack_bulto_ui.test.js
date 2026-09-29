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

test('vigenteKgPB: vigente del bulto del granel ÷ kg de la fórmula; sin vigente o sin kg → null', () => {
  assert.strictEqual(ui.vigenteKgPB({ precioVigente: 45000, cantidad: 10 }), 4500);
  assert.strictEqual(ui.vigenteKgPB({ precioVigente: 10000, cantidad: 3 }), 3333.33);
  assert.strictEqual(ui.vigenteKgPB({ precioVigente: null, cantidad: 10 }), null);
  assert.strictEqual(ui.vigenteKgPB({ precioVigente: 45000, cantidad: 0 }), null);
  assert.strictEqual(ui.vigenteKgPB({ precioVigente: 45000, cantidad: null }), null);
});

// ── Venta de pack/bulto pesables: por kg o por paquete ──────────────────────────
test('recalcularItemPB: modo paquete = precio /kg de la presentación × peso; sin peso → faltante peso', () => {
  const it = item('1', { modoVenta: 'paquete', pesoKg: 3, precioVigente: 13600 });
  // 4990 × 3 × 0,903 = 13517,91 → 13500; Δ vs 13600 = −0,7%.
  assert.deepStrictEqual(ui.recalcularItemPB(it, 4990, 5), { ...it, precioSugerido: 13500, deltaPct: -0.7, semaforo: 'ok', faltantes: [] });
  const sinPeso = item('1', { modoVenta: 'paquete', pesoKg: null });
  assert.deepStrictEqual(ui.recalcularItemPB(sinPeso, 4990, 5).faltantes, ['peso']);
  assert.strictEqual(ui.recalcularItemPB(sinPeso, 4990, 5).precioSugerido, null);
  assert.deepStrictEqual(ui.recalcularItemPB(sinPeso, null, 5).faltantes, ['base', 'peso']);
  // Modo kg: como antes (el peso no cuenta).
  assert.strictEqual(ui.recalcularItemPB(item('1', { modoVenta: 'kg', pesoKg: 3 }), 4990, 5).precioSugerido, 4500);
});

test('revisarUnidadPB: ratio vigente pack ÷ (vigente base × peso si es paquete) fuera de 0,5–1,2', () => {
  assert.strictEqual(ui.revisarUnidadPB({ precioVigente: 13500, modoVenta: 'kg' }, 5000), true); // ×2,7
  assert.strictEqual(ui.revisarUnidadPB({ precioVigente: 13500, modoVenta: 'paquete', pesoKg: 3 }, 5000), false); // ×0,9
  assert.strictEqual(ui.revisarUnidadPB({ precioVigente: 13500, modoVenta: 'paquete', pesoKg: null }, 5000), false);
  assert.strictEqual(ui.revisarUnidadPB({ precioVigente: 45000, granel: true }, 5000), false);
  assert.strictEqual(ui.revisarUnidadPB({ precioVigente: null }, 5000), false);
});

test('unidadPB: "/kg" o "paquete X kg" (sólo pesables)', () => {
  assert.strictEqual(ui.unidadPB({ modoVenta: 'kg' }), '/kg');
  assert.strictEqual(ui.unidadPB({ modoVenta: 'paquete', pesoKg: 2.5 }), 'paquete 2,5 kg');
  assert.strictEqual(ui.unidadPB({ modoVenta: 'paquete', pesoKg: null }), 'paquete');
  assert.strictEqual(ui.unidadPB({}), '');
});

test('vigenteKgPB: en modo paquete divide por el peso elegido', () => {
  assert.strictEqual(ui.vigenteKgPB({ precioVigente: 45000, cantidad: 10, modoVenta: 'paquete', pesoKg: 9 }), 5000);
  assert.strictEqual(ui.vigenteKgPB({ precioVigente: 45000, cantidad: 10, modoVenta: 'kg', pesoKg: 9 }), 4500);
  assert.strictEqual(ui.vigenteKgPB({ precioVigente: 45000, cantidad: 10, modoVenta: 'paquete', pesoKg: null }), null);
});

test('filasPBMarcadas: pack/bulto pesable por paquete exporta Costo = costo $/kg del base × peso', () => {
  const fracc = [{ costoTotal: 800.5, presentaciones: [{ plu: '20', packBulto: [
    item('3', { marcado: true, modoVenta: 'paquete', pesoKg: 3, precioSugerido: 13500 }),
    item('4', { marcado: true, modoVenta: 'kg', pesoKg: 3, precioSugerido: 4500 }),
  ] }] }];
  assert.deepStrictEqual(ui.filasPBMarcadas([], fracc).map(f => [f.plu, f.costoTotal, f.precioConIva]), [['3', 2401.5, 13500], ['4', 800.5, 4500]]);
});

// ── Cambios pendientes (% propio, modo/peso): se guardan con el pie del modal ─────
test('conPendientePB: fusiona el cambio sin mutar y lo descarta si vuelve al original', () => {
  const orig = item('1', { descOverride: null, descPct: 9.7, modoVenta: 'kg', pesoKg: 3 });
  const vacio = {};
  const p1 = ui.conPendientePB(vacio, orig, { descOverride: 5, descPct: 5 });
  assert.deepStrictEqual(p1, { 1: { descOverride: 5, descPct: 5 } });
  assert.deepStrictEqual(vacio, {});
  const p2 = ui.conPendientePB(p1, orig, { modoVenta: 'paquete', pesoKg: 3 });
  assert.deepStrictEqual(p2, { 1: { descOverride: 5, descPct: 5, modoVenta: 'paquete', pesoKg: 3 } });
  assert.deepStrictEqual(ui.conPendientePB(p2, orig, { descOverride: null, descPct: 9.7 }), { 1: { modoVenta: 'paquete', pesoKg: 3 } });
  assert.deepStrictEqual(ui.conPendientePB(p1, orig, { descOverride: null, descPct: 9.7 }), {});
  // Por kg el peso no cuenta: volver a kg desde paquete = sin cambio.
  assert.deepStrictEqual(ui.conPendientePB(p2, orig, { descOverride: null, modoVenta: 'kg', pesoKg: 7 }), {});
});

test('vistaPB: el ítem con las capas de cambios encima, sin mutar', () => {
  const it = item('1', { descOverride: null });
  assert.deepStrictEqual(ui.vistaPB(it, {}), it);
  assert.deepStrictEqual(ui.vistaPB(it, { 1: { descOverride: 2, descPct: 2 } }, { 1: { descOverride: 4, descPct: 4 } }), { ...it, descOverride: 4, descPct: 4 });
  assert.strictEqual(it.descOverride, null);
});

test('hayPendientesPB / pendientesValidosPB: por paquete exige peso > 0 y ≤ 1000', () => {
  assert.strictEqual(ui.hayPendientesPB({}), false);
  assert.strictEqual(ui.hayPendientesPB({ 1: { descOverride: 5 } }), true);
  assert.strictEqual(ui.pendientesValidosPB({ 1: { descOverride: 5 } }), true);
  assert.strictEqual(ui.pendientesValidosPB({ 1: { modoVenta: 'paquete', pesoKg: 2 } }), true);
  assert.strictEqual(ui.pendientesValidosPB({ 1: { modoVenta: 'paquete', pesoKg: null } }), false);
  assert.strictEqual(ui.pendientesValidosPB({ 1: { modoVenta: 'paquete', pesoKg: 1001 } }), false);
  assert.strictEqual(ui.pendientesValidosPB({ 1: { modoVenta: 'kg', pesoKg: null } }), true);
});

test('pedidosPB: PUT/DELETE del % y PUT de la venta, con la parte del cambio que guarda cada uno', () => {
  assert.deepStrictEqual(ui.pedidosPB({
    1: { descOverride: 5, descPct: 5, modoVenta: 'paquete', pesoKg: 2.5 },
    'a/b': { descOverride: null, descPct: 9.7 },
    3: { modoVenta: 'kg', pesoKg: null },
  }), [
    { plu: '1', metodo: 'PUT', url: '/api/precios/pack-bulto/descuento/1', body: { descPct: 5 }, cambio: { descOverride: 5, descPct: 5 } },
    { plu: '1', metodo: 'PUT', url: '/api/precios/pack-bulto/venta/1', body: { modo: 'paquete', pesoKg: 2.5 }, cambio: { modoVenta: 'paquete', pesoKg: 2.5 } },
    { plu: '3', metodo: 'PUT', url: '/api/precios/pack-bulto/venta/3', body: { modo: 'kg' }, cambio: { modoVenta: 'kg', pesoKg: null } },
    { plu: 'a/b', metodo: 'DELETE', url: '/api/precios/pack-bulto/descuento/a%2Fb', body: undefined, cambio: { descOverride: null, descPct: 9.7 } },
  ]);
  assert.deepStrictEqual(ui.pedidosPB({}), []);
});

test('agruparPB: vuelve a armar el mapa plu → cambio desde pedidos (los que fallaron quedan pendientes)', () => {
  const ped = ui.pedidosPB({ 1: { descOverride: 5, descPct: 5, modoVenta: 'paquete', pesoKg: 2 } });
  assert.deepStrictEqual(ui.agruparPB([ped[1]]), { 1: { modoVenta: 'paquete', pesoKg: 2 } });
  assert.deepStrictEqual(ui.agruparPB([ped[0]], { 2: { descOverride: 1 } }), { 2: { descOverride: 1 }, 1: { descOverride: 5, descPct: 5 } });
});
