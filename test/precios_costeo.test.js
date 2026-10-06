'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { aplicarMarkup, costearAlmacen, redondearPrecioVenta, compararConVigente, markupParaPrecio, costearFraccionado, elegirCosto, aplicarCostosExtra, validarCostosExtra } = require('../lib/precios_costeo');

test('redondearPrecioVenta: múltiplo de 50 más cercano, sin decimales', () => {
  assert.strictEqual(redondearPrecioVenta(1724.99), 1700);
  assert.strictEqual(redondearPrecioVenta(1725), 1750);
  assert.strictEqual(redondearPrecioVenta(1774.5), 1750);
  assert.strictEqual(redondearPrecioVenta(1750), 1750);
  assert.strictEqual(redondearPrecioVenta(0), 0);
});

// ── aplicarMarkup / conIva ───────────────────────────────────────────────────

test('aplicarMarkup: costo × (1 + markup/100)', () => {
  assert.strictEqual(aplicarMarkup(1030, 40), 1442);
  assert.strictEqual(aplicarMarkup(100, 0), 100);
});

// Regla 2026-10-02 (spec costo neto + IVA): costo neto × (1 + markup) = precio neto, + IVA del producto (21 % por defecto).

// ── costearAlmacen ───────────────────────────────────────────────────────────

test('costearAlmacen: caso feliz — cuenta exacta de costoTotal, precioNeto y precioConIva', () => {
  const out = costearAlmacen({ costoMercaderia: 1030, markupPct: 40, plu: '123' });
  assert.deepStrictEqual(out.faltantes, []);
  assert.strictEqual(out.plu, '123');
  assert.strictEqual(out.tipo, 'almacen');
  assert.strictEqual(out.costoTotal, 1030);
  assert.strictEqual(out.precioNeto, 1442);
  assert.strictEqual(out.precioConIvaExacto, 1744.82); // 1442 + IVA 21 % (302,82)
  assert.strictEqual(out.precioConIva, 1750); // → múltiplo de 50 más cercano
  assert.strictEqual(out.ivaPct, 21);
  assert.strictEqual(out.markupFinalPct, 69.9); // 1750 ÷ 1030 − 1
  assert.deepStrictEqual(out.componentes, [
    { concepto: 'Mercadería', detalle: 'costo neto', importe: 1030 },
  ]);
});

test('costearAlmacen: costoMercaderia faltante → faltantes no vacío, precios null', () => {
  const out = costearAlmacen({ markupPct: 40 });
  assert.ok(out.faltantes.includes('costoMercaderia'));
  assert.strictEqual(out.precioNeto, null);
  assert.strictEqual(out.precioConIva, null);
  assert.deepStrictEqual(out.componentes, []);
});

test('costearAlmacen: costoMercaderia no numérico → faltantes no vacío, precios null', () => {
  const out = costearAlmacen({ costoMercaderia: 'no es un número', markupPct: 40 });
  assert.ok(out.faltantes.includes('costoMercaderia'));
  assert.strictEqual(out.precioNeto, null);
  assert.strictEqual(out.precioConIva, null);
});

test('costearAlmacen: costoMercaderia cero es válido (no es "faltante")', () => {
  const out = costearAlmacen({ costoMercaderia: 0, markupPct: 40 });
  assert.deepStrictEqual(out.faltantes, []);
  assert.strictEqual(out.costoTotal, 0);
  assert.strictEqual(out.precioNeto, 0);
  assert.strictEqual(out.precioConIva, 0);
});

test('costearAlmacen: markupPct faltante también deja precios null sin optimismo', () => {
  const out = costearAlmacen({ costoMercaderia: 1000 });
  assert.ok(out.faltantes.includes('markupPct'));
  assert.strictEqual(out.precioNeto, null);
  assert.strictEqual(out.precioConIva, null);
});

test('costearAlmacen: propaga nombre/plu/banda sin tocarlos aunque no vengan', () => {
  const out = costearAlmacen({ costoMercaderia: 1000, markupPct: 40 });
  assert.strictEqual(out.plu, undefined);
  assert.strictEqual(out.nombre, undefined);
  assert.strictEqual(out.banda, null);
  const out2 = costearAlmacen({ costoMercaderia: 1000, markupPct: 40, plu: '9', nombre: 'X', banda: 'override' });
  assert.strictEqual(out2.plu, '9');
  assert.strictEqual(out2.nombre, 'X');
  assert.strictEqual(out2.banda, 'override');
});

test('costearAlmacen: montos no redondos salen redondeados a 2 decimales, sin ruido de float', () => {
  const out = costearAlmacen({
    costoMercaderia: 999.99, markupPct: 33.3, costosExtra: [{ concepto: 'Merma', tipo: 'pct', valor: 2.5 }],
  });
  assert.strictEqual(out.componentes[1].importe, 25); // 999.99 * 2.5% = 24.999750000000002 sin redondear
  assert.strictEqual(out.costoTotal, 1024.99);
  assert.strictEqual(out.precioNeto, 1366.31);
  assert.strictEqual(out.precioConIvaExacto, 1653.24); // 1366.31 + IVA 286,93
  assert.strictEqual(out.precioConIva, 1650);
});

test('compararConVigente: + cuando el sugerido supera al vigente (subir), − cuando es menor (bajar)', () => {
  assert.deepStrictEqual(compararConVigente(850, 500, 10), { deltaPct: 70, estado: 'subir' });
  assert.deepStrictEqual(compararConVigente(400, 500, 10), { deltaPct: -20, estado: 'bajar' });
});

test('compararConVigente: dentro de la tolerancia (incluido el borde) es ok', () => {
  assert.deepStrictEqual(compararConVigente(525, 500, 10), { deltaPct: 5, estado: 'ok' });
  assert.deepStrictEqual(compararConVigente(550, 500, 10), { deltaPct: 10, estado: 'ok' });
  assert.deepStrictEqual(compararConVigente(450, 500, 10), { deltaPct: -10, estado: 'ok' });
  assert.deepStrictEqual(compararConVigente(505, 500, undefined), { deltaPct: 1, estado: 'subir' });
});

test('compararConVigente: sin vigente, vigente 0 o sin sugerido → nulls', () => {
  const nulos = { deltaPct: null, estado: null };
  assert.deepStrictEqual(compararConVigente(850, null, 10), nulos);
  assert.deepStrictEqual(compararConVigente(850, 0, 10), nulos);
  assert.deepStrictEqual(compararConVigente(null, 500, 10), nulos);
});

test('costearAlmacen: precioConIvaExacto es el precio final sin redondeo a $50', () => {
  const r = costearAlmacen({ costoMercaderia: 515, markupPct: 40 });
  assert.strictEqual(r.precioNeto, 721); // 515 × 1,4
  assert.strictEqual(r.precioConIvaExacto, 872.41); // 721 + IVA 21 % (151,41)
  assert.strictEqual(r.precioConIva, 850); // → múltiplo de 50
  assert.strictEqual(costearAlmacen({ costoMercaderia: null, markupPct: 40 }).precioConIvaExacto, null);
});

test('markupParaPrecio: markup que lleva el costo total al precio final', () => {
  assert.strictEqual(markupParaPrecio(1000, 1210), 0); // 1210 ÷ 1,21 ÷ 1000 − 1
  assert.strictEqual(markupParaPrecio(1000, 1452), 20); // 1452 ÷ 1,21 = 1200
  assert.strictEqual(markupParaPrecio(1000, 1105, 10.5), 0); // alícuota del producto
  assert.strictEqual(markupParaPrecio(1000, 1210, 10.5), 9.502262);
  const m = markupParaPrecio(1030, 2470);
  const r = costearAlmacen({ costoMercaderia: 1030, markupPct: m });
  assert.ok(Math.abs(r.precioConIvaExacto - 2470) < 0.02);
  assert.ok(markupParaPrecio(1000, 1200) < 0); // vigente ÷ 1,21 bajo el costo neto → negativo
});

test('markupParaPrecio: null con datos faltantes o no positivos', () => {
  for (const [c, p] of [[null, 100], [100, null], [0, 100], [100, 0], [-5, 100], [NaN, 100], [100, Infinity]]) {
    assert.strictEqual(markupParaPrecio(c, p), null);
  }
});

// ── Fase 2: Fraccionado (v2: costo del granel × margen por costo × presentación) ─

test('costearFraccionado: Sem. Lino 500G — granel neto 2297 × 1.6832 + IVA, mismo shape que Almacén', () => {
  const r = costearFraccionado({ plu: '1', nombre: 'Sem. Lino 500G', costoKg: 2297, markupPct: 68.32 });
  assert.strictEqual(r.tipo, 'fraccionado');
  assert.strictEqual(r.plu, '1');
  assert.strictEqual(r.costoTotal, 2297);
  assert.deepStrictEqual(r.componentes, [{ concepto: 'Granel', detalle: 'costo neto por kg', importe: 2297 }]);
  assert.strictEqual(r.precioNeto, 3866.31);
  assert.strictEqual(r.precioConIvaExacto, 4678.24); // neto + IVA 21 %
  assert.strictEqual(r.precioConIva, 4700); // → múltiplo de 50
  assert.deepStrictEqual(r.faltantes, []);
});

test('costearFraccionado: sin costo de granel o sin markup → faltantes, sin precio', () => {
  for (const costoKg of [null, undefined, 0, -3, NaN]) {
    const r = costearFraccionado({ costoKg, markupPct: 50 });
    assert.deepStrictEqual(r.faltantes, ['costoGranel']);
    assert.strictEqual(r.costoTotal, null);
    assert.strictEqual(r.precioConIva, null);
    assert.deepStrictEqual(r.componentes, []);
  }
  const sinMarkup = costearFraccionado({ costoKg: 1000, markupPct: null });
  assert.deepStrictEqual(sinMarkup.faltantes, ['markupPct']);
  assert.strictEqual(sinMarkup.precioNeto, null);
  assert.strictEqual(sinMarkup.markupPct, null);
});

// ── elegirCosto (compartido Almacén / granel Fraccionado) ─────────────────────
test('elegirCosto: por defecto costo de sistema; fuenteCosto ultimaCompra; manual gana sobre todo', () => {
  const base = { plu: '7', costoUltimaCompra: 900, costoSistema: 1000 };
  assert.deepStrictEqual(elegirCosto({ ...base, cfg: {} }), { costoBase: 1000, costoFuente: 'sistema', costoOverride: null });
  assert.deepStrictEqual(elegirCosto({ ...base, cfg: { fuenteCosto: { 7: 'ultimaCompra' } } }),
    { costoBase: 900, costoFuente: 'ultimaCompra', costoOverride: null });
  assert.deepStrictEqual(elegirCosto({ ...base, cfg: { fuenteCosto: { 7: 'ultimaCompra' }, costoPorProducto: { 7: 1234 } } }),
    { costoBase: 1234, costoFuente: 'manual', costoOverride: 1234 });
});

test('elegirCosto: manual inválido se ignora; sin dato de la fuente elegida → costoBase null (nunca otra fuente)', () => {
  assert.strictEqual(elegirCosto({ plu: '7', costoUltimaCompra: 900, costoSistema: 1000, cfg: { costoPorProducto: { 7: 0 } } }).costoFuente, 'sistema');
  assert.strictEqual(elegirCosto({ plu: '7', costoUltimaCompra: 900, costoSistema: null, cfg: {} }).costoBase, null);
  assert.strictEqual(elegirCosto({ plu: '7', costoUltimaCompra: null, costoSistema: 1000, cfg: { fuenteCosto: { 7: 'ultimaCompra' } } }).costoBase, null);
  assert.deepStrictEqual(elegirCosto({ plu: null, costoSistema: null, cfg: null }), { costoBase: null, costoFuente: 'sistema', costoOverride: null });
});

// ── Costos extra Fraccionado (por granel) ─────────────────────────────────────
test('aplicarCostosExtra: $/kg fijo + % sobre el costo base, redondeo a 2 decimales', () => {
  const r = aplicarCostosExtra(1000, [
    { concepto: 'Envase', tipo: 'kg', valor: 150 },
    { concepto: 'Merma', tipo: 'pct', valor: 5 },
  ]);
  assert.strictEqual(r.costoTotal, 1200);
  assert.deepStrictEqual(r.componentes, [
    { concepto: 'Envase', detalle: '$/kg', importe: 150 },
    { concepto: 'Merma', detalle: '5%', importe: 50 },
  ]);
  // el % va sobre el costo base, no sobre base + otros extras (el orden no importa)
  assert.strictEqual(aplicarCostosExtra(1000, [{ concepto: 'M', tipo: 'pct', valor: 5 }, { concepto: 'E', tipo: 'kg', valor: 150 }]).costoTotal, 1200);
  assert.strictEqual(aplicarCostosExtra(2297, [{ concepto: 'x', tipo: 'pct', valor: 3.33 }]).costoTotal, 2373.49);
  assert.strictEqual(aplicarCostosExtra(2297, [{ concepto: 'x', tipo: 'pct', valor: 3.33 }]).componentes[0].importe, 76.49);
});

test('aplicarCostosExtra: sin ítems → costoTotal = base; base null → costoTotal null', () => {
  assert.deepStrictEqual(aplicarCostosExtra(1000, []), { costoTotal: 1000, componentes: [] });
  assert.deepStrictEqual(aplicarCostosExtra(1000, undefined), { costoTotal: 1000, componentes: [] });
  assert.strictEqual(aplicarCostosExtra(null, [{ concepto: 'E', tipo: 'kg', valor: 150 }]).costoTotal, null);
  assert.strictEqual(aplicarCostosExtra(undefined, []).costoTotal, null);
});

test('validarCostosExtra: acepta ítems válidos (concepto recortado) y lista vacía', () => {
  assert.deepStrictEqual(validarCostosExtra([]), []);
  assert.deepStrictEqual(
    validarCostosExtra([{ concepto: '  Envase ', tipo: 'kg', valor: 0 }, { concepto: 'Merma', tipo: 'pct', valor: -100 }, { concepto: 'x', tipo: 'pct', valor: 1000 }, { concepto: 'y', tipo: 'kg', valor: 1e6 }]),
    [{ concepto: 'Envase', tipo: 'kg', valor: 0 }, { concepto: 'Merma', tipo: 'pct', valor: -100 }, { concepto: 'x', tipo: 'pct', valor: 1000 }, { concepto: 'y', tipo: 'kg', valor: 1e6 }]);
  // sólo conserva las claves conocidas
  assert.deepStrictEqual(validarCostosExtra([{ concepto: 'E', tipo: 'kg', valor: 1, hack: 1 }]), [{ concepto: 'E', tipo: 'kg', valor: 1 }]);
});

test('validarCostosExtra: rechaza estructura, concepto, tipo y valores fuera de rango', () => {
  const ok = { concepto: 'E', tipo: 'kg', valor: 1 };
  assert.throws(() => validarCostosExtra(null), /lista/);
  assert.throws(() => validarCostosExtra(Array(21).fill(ok)), /20/);
  assert.throws(() => validarCostosExtra([null]), /\[0\]/);
  assert.throws(() => validarCostosExtra([{ ...ok, concepto: '   ' }]), /concepto/);
  assert.throws(() => validarCostosExtra([{ ...ok, concepto: 'x'.repeat(61) }]), /concepto/);
  assert.throws(() => validarCostosExtra([{ ...ok, concepto: 5 }]), /concepto/);
  assert.throws(() => validarCostosExtra([{ ...ok, tipo: '$' }]), /tipo/);
  assert.throws(() => validarCostosExtra([{ ...ok, valor: '5' }]), /valor/);
  assert.throws(() => validarCostosExtra([{ ...ok, valor: NaN }]), /valor/);
  assert.throws(() => validarCostosExtra([{ ...ok, valor: -0.01 }]), /valor/);
  assert.throws(() => validarCostosExtra([{ ...ok, valor: 1e6 + 1 }]), /valor/);
  assert.throws(() => validarCostosExtra([ok, { concepto: 'P', tipo: 'pct', valor: -100.5 }]), /\[1\].*valor/);
  assert.throws(() => validarCostosExtra([{ concepto: 'P', tipo: 'pct', valor: 1000.1 }]), /valor/);
});

// ── Costos extra Almacén (por producto, misma clave/lógica que Fraccionado) ──
test('costearAlmacen: costos extra del producto ($ fijo + % del costo base) se suman al base', () => {
  const out = costearAlmacen({
    costoMercaderia: 1000, markupPct: 40,
    costosExtra: [{ concepto: 'Flete', tipo: 'kg', valor: 50 }, { concepto: 'Merma', tipo: 'pct', valor: 2 }],
  });
  assert.strictEqual(out.costoTotal, 1070); // 1000 + 50 + 20
  assert.strictEqual(out.precioNeto, 1498);
  assert.strictEqual(out.precioConIva, 1800); // 1498 + IVA 314,58 = 1812,58 → múltiplo de 50
  assert.deepStrictEqual(out.componentes, [
    { concepto: 'Mercadería', detalle: 'costo neto', importe: 1000 },
    { concepto: 'Flete', detalle: '$', importe: 50 },
    { concepto: 'Merma', detalle: '2%', importe: 20 },
  ]);
});

test('costearAlmacen: sin costo base los costos extra no inventan precio', () => {
  const out = costearAlmacen({ markupPct: 40, costosExtra: [{ concepto: 'F', tipo: 'kg', valor: 50 }] });
  assert.strictEqual(out.costoTotal, null);
  assert.deepStrictEqual(out.componentes, []);
});

test('aplicarCostosExtra: unidad del ítem fijo configurable ($ en Almacén, $/kg por defecto)', () => {
  const items = [{ concepto: 'F', tipo: 'kg', valor: 10 }];
  assert.strictEqual(aplicarCostosExtra(100, items).componentes[0].detalle, '$/kg');
  assert.strictEqual(aplicarCostosExtra(100, items, '$').componentes[0].detalle, '$');
});

// ── Presentaciones temporales (simulación en Fraccionado) ─────────────────────
test('validarPresentacionTemporal: alta completa, ganancia null = standard, nombre opcional recortado', () => {
  const { validarPresentacionTemporal } = require('../lib/precios_costeo');
  assert.deepStrictEqual(validarPresentacionTemporal({ pesoG: 250 }), { pesoG: 250, gananciaPct: null });
  assert.deepStrictEqual(validarPresentacionTemporal({ pesoG: 1000, gananciaPct: 45.5, nombre: '  Bolsa 1kg ', otro: 1 }),
    { pesoG: 1000, gananciaPct: 45.5, nombre: 'Bolsa 1kg' });
  assert.deepStrictEqual(validarPresentacionTemporal({ pesoG: 1, gananciaPct: -99, nombre: '' }), { pesoG: 1, gananciaPct: -99 });
  assert.deepStrictEqual(validarPresentacionTemporal({ pesoG: 100000, gananciaPct: 1000 }), { pesoG: 100000, gananciaPct: 1000 });
});

test('validarPresentacionTemporal: rechaza peso, ganancia y nombre fuera de rango', () => {
  const { validarPresentacionTemporal } = require('../lib/precios_costeo');
  for (const body of [null, {}, { pesoG: 0 }, { pesoG: 100001 }, { pesoG: '250' }, { pesoG: NaN },
    { pesoG: 250, gananciaPct: -100 }, { pesoG: 250, gananciaPct: 1001 }, { pesoG: 250, gananciaPct: '40' },
    { pesoG: 250, nombre: 'x'.repeat(61) }, { pesoG: 250, nombre: 5 }]) {
    assert.throws(() => validarPresentacionTemporal(body), Error, JSON.stringify(body));
  }
});

test('validarPresentacionTemporal parcial: sólo las claves presentes; nombre vacío/null = quitarlo; sin claves → error', () => {
  const { validarPresentacionTemporal } = require('../lib/precios_costeo');
  assert.deepStrictEqual(validarPresentacionTemporal({ gananciaPct: 30 }, { parcial: true }), { gananciaPct: 30 });
  assert.deepStrictEqual(validarPresentacionTemporal({ gananciaPct: null, nombre: '' }, { parcial: true }), { gananciaPct: null, nombre: null });
  assert.deepStrictEqual(validarPresentacionTemporal({ pesoG: 400 }, { parcial: true }), { pesoG: 400 });
  assert.throws(() => validarPresentacionTemporal({}, { parcial: true }), /nada/);
  assert.throws(() => validarPresentacionTemporal({ pesoG: -1 }, { parcial: true }));
});

test('tendenciaCompraHoy: sube/baja fuera de ±tolerancia, igual dentro (borde incluido), sin-anterior sin Δ', () => {
  const { tendenciaCompraHoy } = require('../lib/precios_costeo');
  assert.strictEqual(tendenciaCompraHoy(8.5, 2), 'sube');
  assert.strictEqual(tendenciaCompraHoy(-3, 2), 'baja');
  assert.strictEqual(tendenciaCompraHoy(2, 2), 'igual');
  assert.strictEqual(tendenciaCompraHoy(-2, 2), 'igual');
  assert.strictEqual(tendenciaCompraHoy(0, 0), 'igual');
  assert.strictEqual(tendenciaCompraHoy(0.1, undefined), 'sube'); // sin tolerancia configurada = 0
  assert.strictEqual(tendenciaCompraHoy(null, 2), 'sin-anterior');
  assert.strictEqual(tendenciaCompraHoy(undefined, 2), 'sin-anterior');
});

// ── Desglose costo neto → costo real → precio neto → IVA → final (spec 2026-10-02 Partes A y C) ──
const { desglosePrecio, markupDesdeGanancia } = require('../lib/precios_costeo');

test('desglosePrecio: costoReal = C ÷ (1 − G), gastos partidos proporcional, ganancia s/ costo real = curva + conceptos', () => {
  const m = markupDesdeGanancia(30, 25); // g 30 %, G 25 % → markup 73,333333 %
  const d = desglosePrecio({ costo: 1000, markupPct: m, gastos: { variablesPct: 15, departamentosPct: 10 }, ivaPct: 21,
    conceptos: [{ id: 'riesgo', concepto: 'Riesgo', pct: 5 }] });
  assert.strictEqual(d.costoReal, 1333.33);    // 1000 ÷ 0,75
  assert.strictEqual(d.variables, 200);        // costo real × 15 %
  assert.strictEqual(d.departamentos, 133.33); // costo real × 10 % (resto exacto)
  assert.strictEqual(d.precioNeto, 1733.33);   // costo real × 1,3
  assert.strictEqual(d.ganancia, 400);         // g × costo real
  assert.strictEqual(d.gananciaPct, 30);
  assert.strictEqual(d.gananciaCurvaPct, 25);
  assert.strictEqual(d.gananciaCurva, 333.33);
  assert.deepStrictEqual(d.conceptos, [{ id: 'riesgo', concepto: 'Riesgo', pct: 5, importe: 66.67 }]);
  assert.strictEqual(d.conceptosPct, 5);
  assert.strictEqual(d.iva, 364);              // 21 % del neto
  assert.strictEqual(d.precioFinalExacto, 2097.33);
  assert.strictEqual(d.markupNetoPct, 73.33);
});

test('desglosePrecio: sumas exactas (costo + gastos = costo real; curva + conceptos = ganancia; costo real + ganancia = neto)', () => {
  const cent = n => Math.round(n * 100);
  const conceptos = [{ concepto: 'A', pct: 3.33 }, { concepto: 'B', pct: -1.7 }];
  for (const [costo, markup, v, dp] of [[999.99, 33.3, 12.5, 3.1234], [2297.45, 68.32, 7, 0], [13.07, 5, 0.33, 0.67], [123456.78, 81.9, 27.09, 5.74]]) {
    const d = desglosePrecio({ costo, markupPct: markup, gastos: { variablesPct: v, departamentosPct: dp }, ivaPct: 10.5, conceptos });
    assert.strictEqual(cent(d.costo + d.variables + d.departamentos), cent(d.costoReal), `${costo}`);
    assert.strictEqual(cent(d.gananciaCurva + d.conceptos.reduce((s, c) => s + c.importe, 0)), cent(d.ganancia), `${costo}`);
    assert.strictEqual(cent(d.costoReal + d.ganancia), cent(d.precioNeto), `${costo}`);
    assert.strictEqual(cent(d.precioNeto + d.iva), cent(d.precioFinalExacto));
  }
});

test('fórmula Parte C: precioNeto = C ÷ (1 − G) × (1 + curva + conceptos); precio monótono con el costo', () => {
  const { gananciaPorCurva, gananciaStandard, costearAlmacen } = require('../lib/precios_costeo');
  const curva = { a: 33.5557, b: 1.955, pisoPct: 12.2482, techoPct: 24.1428 };
  const G = 27.12, K = 2;
  let anterior = 0;
  for (let x = 50; x <= 200000; x *= 1.07) {
    const costo = Math.round(x * 100) / 100;
    const g = gananciaStandard(gananciaPorCurva(curva, costo), K);
    const r = costearAlmacen({ costoMercaderia: costo, markupPct: markupDesdeGanancia(g, G), gastos: { variablesPct: G, departamentosPct: 0 }, ivaPct: 21 });
    const esperado = Math.round(costo / (1 - G / 100) * (1 + g / 100) * 100) / 100;
    // ±2 centavos: el markup viaja a 6 decimales.
    assert.ok(Math.abs(r.precioNeto - esperado) <= 0.02, `${costo}`);
    assert.ok(r.precioConIvaExacto >= anterior, `monótono en ${costo}`);
    anterior = r.precioConIvaExacto;
  }
});

test('IVA de venta y conceptos de ganancia: defaults, validación y total', () => {
  const { ivaVentaPctDe, validarIvaVentaPct, validarConceptosGanancia, totalConceptosGanancia, conceptosGananciaDe } = require('../lib/precios_costeo');
  assert.strictEqual(ivaVentaPctDe({}), 21);
  assert.strictEqual(ivaVentaPctDe({ ivaVentaPct: 10.5 }), 10.5);
  assert.strictEqual(ivaVentaPctDe({ ivaVentaPct: 0 }), 0);
  assert.strictEqual(ivaVentaPctDe({ ivaVentaPct: 101 }), 21);
  assert.strictEqual(validarIvaVentaPct(27), 27);
  for (const v of [-1, 100.5, '21', null, NaN]) assert.throws(() => validarIvaVentaPct(v), /ivaVentaPct/);
  const lista = validarConceptosGanancia([{ concepto: ' Riesgo ', pct: 2 }, { concepto: 'Riesgo', pct: -1.5 }, { id: 'reinv', concepto: 'Reinversión', pct: 300 }]);
  assert.deepStrictEqual(lista, [{ id: 'riesgo', concepto: 'Riesgo', pct: 2 }, { id: 'riesgo-2', concepto: 'Riesgo', pct: -1.5 },
    { id: 'reinv', concepto: 'Reinversión', pct: 300 }]);
  assert.strictEqual(totalConceptosGanancia(lista), 300.5);
  assert.deepStrictEqual(validarConceptosGanancia([]), []);
  for (const bad of [null, [{ concepto: '', pct: 1 }], [{ concepto: 'x', pct: 301 }], [{ concepto: 'x', pct: -101 }],
    [{ concepto: 'x'.repeat(61), pct: 1 }], [{ concepto: 'x', pct: '1' }], [{ id: 'A B', concepto: 'x', pct: 1 }],
    Array.from({ length: 41 }, (_, i) => ({ concepto: `c${i}`, pct: 1 }))]) {
    assert.throws(() => validarConceptosGanancia(bad), Error, JSON.stringify(bad).slice(0, 40));
  }
  assert.deepStrictEqual(conceptosGananciaDe({}), []);
  assert.strictEqual(totalConceptosGanancia(undefined), 0);
});

test('migrarMargenesAGanancia: markup total → ganancia con el G del tipo, temporales renombradas, idempotente', () => {
  const { migrarMargenesAGanancia, MARGEN_PROPIO_GANANCIA } = require('../lib/precios_costeo');
  const costeo = {
    margenPorProducto: { 1: 80, 2: 60, 3: 50, 4: 'x' },
    presentacionesTemporales: { 9: [{ id: 't-a', pesoG: 250, markupPct: 70 }, { id: 't-b', pesoG: 500, markupPct: null }] },
  };
  const tipo = plu => ({ 2: 'fraccionado', 3: 'produccion' })[plu] || 'almacen';
  const r = migrarMargenesAGanancia(costeo, { almacen: 25, fraccionado: 20, produccion: null }, tipo);
  assert.strictEqual(r.ajustados, 3);
  assert.strictEqual(r.costeo.margenPropio, MARGEN_PROPIO_GANANCIA);
  assert.strictEqual(r.costeo.margenPorProducto[1], 35);   // 1,8 × 0,75 − 1
  assert.strictEqual(r.costeo.margenPorProducto[2], 28);   // 1,6 × 0,8 − 1
  assert.strictEqual(r.costeo.margenPorProducto[3], 50);   // G null: queda igual
  assert.strictEqual(r.costeo.margenPorProducto[4], 'x');
  assert.deepStrictEqual(r.costeo.presentacionesTemporales[9], [{ id: 't-a', pesoG: 250, gananciaPct: 36 }, { id: 't-b', pesoG: 500, gananciaPct: null }]);
  assert.strictEqual(costeo.margenPorProducto[1], 80); // no muta
  assert.strictEqual(migrarMargenesAGanancia(r.costeo, { almacen: 25 }), null);
  // Mismo precio: C(1 + m) = C ÷ (1 − G) × (1 + g).
  assert.ok(Math.abs(1.8 - (1 + 0.35) / 0.75) < 1e-9);
});

test('desglosePrecio: departamentos desconocidos (sin venta base) → sin costo real ni ganancia, el precio igual', () => {
  const d = desglosePrecio({ costo: 1000, markupPct: 40, gastos: { variablesPct: 10, departamentosPct: null }, ivaPct: 21 });
  assert.strictEqual(d.precioNeto, 1400);
  assert.strictEqual(d.costoReal, null);
  assert.strictEqual(d.ganancia, null);
  assert.strictEqual(d.gananciaPct, null);
  assert.strictEqual(d.precioFinalExacto, 1694);
});

test('costearAlmacen: IVA de venta 10,5 % → IVA al final; markup final sobre el precio redondeado', () => {
  const r = costearAlmacen({ costoMercaderia: 1000, markupPct: 40, ivaPct: 10.5, gastos: { variablesPct: 0, departamentosPct: 0 } });
  assert.strictEqual(r.precioNeto, 1400);
  assert.strictEqual(r.precioConIvaExacto, 1547); // 1400 + 147
  assert.strictEqual(r.precioConIva, 1550);
  assert.strictEqual(r.ivaPct, 10.5);
  assert.strictEqual(r.ivaSupuesto, undefined);
  assert.strictEqual(r.markupFinalPct, 55);
  assert.strictEqual(r.costoReal, 1000);
  assert.strictEqual(r.desglose.iva, 147);
});

test('reescalarGanancias con conceptos: el precio se mantiene exacto para todo costo (sólo cambia la curva)', () => {
  const { reescalarGanancias, gananciaPorCurva, gananciaStandard } = require('../lib/precios_costeo');
  const costeo = {
    conceptosGanancia: [{ id: 'r', concepto: 'R', pct: 4 }],
    curvaGanancia: { almacen: { a: 33.5557, b: 1.955, pisoPct: 12.2482, techoPct: 24.1428 },
      fraccionado: { a: 36.8, b: 1.03, pisoPct: 23.7, techoPct: 30.7, ajustesPeso: { tramosG: [100, 1000], puntos: [5, -6.9] } } },
  };
  const viejo = { almacen: 27.1236, fraccionado: 27.1149, produccion: 32.83 };
  const nuevo = { almacen: 35, fraccionado: 30, produccion: 32.83 };
  const r = reescalarGanancias(costeo, viejo, nuevo);
  assert.deepStrictEqual(r.conceptosGanancia, costeo.conceptosGanancia);
  for (const tipo of ['almacen', 'fraccionado']) {
    for (const [costo, pesoG] of [[100, 50], [1500, 1000], [8000, null], [90000, 5000]]) {
      const precio = (cg, G) => (1 + gananciaStandard(gananciaPorCurva(cg[tipo], costo, pesoG), 4) / 100) / (1 - G / 100);
      assert.ok(Math.abs(precio(r.curvaGanancia, nuevo[tipo]) / precio(costeo.curvaGanancia, viejo[tipo]) - 1) < 1e-5, `${tipo} ${costo}`);
    }
  }
});

test('reescalarGananciasPropias: 1 + g′ = k(1 + g) por el tipo de cada PLU; temporales con Fraccionado', () => {
  const { reescalarGananciasPropias } = require('../lib/precios_costeo');
  const costeo = { margenPorProducto: { 1: 20, 2: 10 }, presentacionesTemporales: { 9: [{ id: 't-a', pesoG: 1, gananciaPct: 10 }, { id: 't-b', pesoG: 1, gananciaPct: null }] } };
  const r = reescalarGananciasPropias(costeo, { almacen: 20, fraccionado: 20, produccion: 20 }, { almacen: 40, fraccionado: 20, produccion: 20 },
    plu => (plu === '2' ? 'fraccionado' : 'almacen'));
  assert.strictEqual(r.margenPorProducto[1], -10); // 1,2 × 0,6/0,8 − 1
  assert.strictEqual(r.margenPorProducto[2], 10);  // Fraccionado sin cambio de gastos
  assert.deepStrictEqual(r.presentacionesTemporales[9], costeo.presentacionesTemporales[9]);
});

