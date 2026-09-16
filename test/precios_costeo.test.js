'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { resolverBanda, markupDe, aplicarMarkup, conIva, configSanitizada, costearAlmacen } = require('../lib/precios_costeo');

const BANDAS = [
  { costoHastaARS: 1000, markupMaxPct: 40 },
  { costoHastaARS: 5000, markupMaxPct: 25 },
  { costoHastaARS: null, markupMaxPct: 15 },
];

// ── resolverBanda ────────────────────────────────────────────────────────────

test('resolverBanda: costo dentro de una banda con tope devuelve label "hasta X"', () => {
  assert.deepStrictEqual(resolverBanda(500, BANDAS), { markupPct: 40, banda: 'hasta 1000' });
});

test('resolverBanda: costo que cae en la banda sin tope devuelve label "sin tope"', () => {
  assert.deepStrictEqual(resolverBanda(999999, BANDAS), { markupPct: 15, banda: 'sin tope' });
});

test('resolverBanda: overridePct devuelve label "override"', () => {
  assert.deepStrictEqual(resolverBanda(500, BANDAS, 10), { markupPct: 10, banda: 'override' });
});

test('resolverBanda: sin bandas que matcheen devuelve markupPct y banda null', () => {
  assert.deepStrictEqual(resolverBanda(500, [{ costoHastaARS: 100, markupMaxPct: 40 }]), { markupPct: null, banda: null });
});

// ── markupDe ─────────────────────────────────────────────────────────────────

test('markupDe: costo dentro de la primera banda devuelve su markupMaxPct', () => {
  assert.strictEqual(markupDe(500, BANDAS), 40);
});

test('markupDe: costo que excede todas las bandas con tope cae en la banda sin tope', () => {
  assert.strictEqual(markupDe(999999, BANDAS), 15);
});

test('markupDe: overridePct gana sin importar costo/bandas', () => {
  assert.strictEqual(markupDe(500, BANDAS, 10), 10);
  assert.strictEqual(markupDe(999999, BANDAS, 10), 10);
});

test('markupDe: costo exactamente en el límite de una banda cae dentro de esa banda', () => {
  assert.strictEqual(markupDe(1000, BANDAS), 40);
});

test('markupDe: sin bandas que matcheen devuelve null', () => {
  assert.strictEqual(markupDe(500, [{ costoHastaARS: 100, markupMaxPct: 40 }]), null);
});

// ── aplicarMarkup / conIva ───────────────────────────────────────────────────

test('aplicarMarkup: costo × (1 + markup/100)', () => {
  assert.strictEqual(aplicarMarkup(1030, 40), 1442);
  assert.strictEqual(aplicarMarkup(100, 0), 100);
});

test('conIva: siempre multiplica por 1.21 exacto, no es configurable', () => {
  assert.strictEqual(conIva(100), 121);
  assert.strictEqual(conIva(1442), 1744.82);
});

// ── costearAlmacen ───────────────────────────────────────────────────────────

test('costearAlmacen: caso feliz — cuenta exacta de costoTotal, precioNeto y precioConIva', () => {
  const out = costearAlmacen({ costoMercaderia: 1000, costosVariosPct: 3, markupPct: 40, plu: '123' });
  assert.deepStrictEqual(out.faltantes, []);
  assert.strictEqual(out.plu, '123');
  assert.strictEqual(out.tipo, 'almacen');
  assert.strictEqual(out.costoTotal, 1030);
  assert.strictEqual(out.precioNeto, 1442);
  assert.strictEqual(out.precioConIva, 1744.82);
  assert.deepStrictEqual(out.componentes, [
    { concepto: 'Mercadería', detalle: 'costo base', importe: 1000 },
    { concepto: 'Costos varios', detalle: '3%', importe: 30 },
  ]);
});

test('costearAlmacen: costoMercaderia faltante → faltantes no vacío, precios null', () => {
  const out = costearAlmacen({ costosVariosPct: 3, markupPct: 40 });
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
  const out = costearAlmacen({ costoMercaderia: 999.99, costosVariosPct: 2.5, markupPct: 33.3 });
  assert.strictEqual(out.componentes[1].importe, 25); // 999.99 * 2.5% = 24.999750000000002 sin redondear
  assert.strictEqual(out.costoTotal, 1024.99);
  assert.strictEqual(out.precioNeto, 1366.31);
  assert.strictEqual(out.precioConIva, 1653.24);
});

// ── configSanitizada ─────────────────────────────────────────────────────────

test('configSanitizada: bandas bien ordenadas y no crecientes en markup pasan sin error', () => {
  const out = configSanitizada({ bandasMarkup: { almacen: BANDAS, fraccionado: [], produccion: [] } });
  assert.deepStrictEqual(out.bandasMarkup.almacen, BANDAS);
});

test('configSanitizada: config sin bandasMarkup no explota, devuelve arrays vacíos', () => {
  const out = configSanitizada({});
  assert.deepStrictEqual(out.bandasMarkup, { almacen: [], fraccionado: [], produccion: [] });
});

test('configSanitizada: markupMaxPct creciente con el costo se rechaza', () => {
  const bandasInvalidas = [
    { costoHastaARS: 1000, markupMaxPct: 20 },
    { costoHastaARS: 5000, markupMaxPct: 30 }, // mayor costo, markup MAYOR — inválido
  ];
  assert.throws(() => configSanitizada({ bandasMarkup: { almacen: bandasInvalidas, fraccionado: [], produccion: [] } }));
});

test('configSanitizada: bandas no ordenadas por costoHastaARS se rechazan', () => {
  const bandasDesordenadas = [
    { costoHastaARS: 5000, markupMaxPct: 20 },
    { costoHastaARS: 1000, markupMaxPct: 25 },
  ];
  assert.throws(() => configSanitizada({ bandasMarkup: { almacen: bandasDesordenadas, fraccionado: [], produccion: [] } }));
});

test('configSanitizada: costoHastaARS:null en una banda que no es la última se rechaza', () => {
  const bandasMalUbicadas = [
    { costoHastaARS: null, markupMaxPct: 20 },
    { costoHastaARS: 1000, markupMaxPct: 25 },
  ];
  assert.throws(() => configSanitizada({ bandasMarkup: { almacen: bandasMalUbicadas, fraccionado: [], produccion: [] } }));
});

test('configSanitizada: costoHastaARS no numérico ni null se rechaza', () => {
  const bandasInvalidas = [{ costoHastaARS: 'mil', markupMaxPct: 20 }];
  assert.throws(() => configSanitizada({ bandasMarkup: { almacen: bandasInvalidas, fraccionado: [], produccion: [] } }));
});

test('configSanitizada: markupMaxPct no numérico se rechaza', () => {
  const bandasInvalidas = [{ costoHastaARS: 1000, markupMaxPct: 'alto' }];
  assert.throws(() => configSanitizada({ bandasMarkup: { almacen: bandasInvalidas, fraccionado: [], produccion: [] } }));
});
