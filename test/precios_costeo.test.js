'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { resolverBanda, markupDe, aplicarMarkup, conIva, configSanitizada, costearAlmacen, redondearPrecioVenta, compararConVigente, markupParaPrecio, markupStdFraccionado, validarMarkupFraccionado, costearFraccionado, elegirCosto, aplicarCostosExtra, validarCostosExtra } = require('../lib/precios_costeo');

test('redondearPrecioVenta: múltiplo de 50 más cercano, sin decimales', () => {
  assert.strictEqual(redondearPrecioVenta(1724.99), 1700);
  assert.strictEqual(redondearPrecioVenta(1725), 1750);
  assert.strictEqual(redondearPrecioVenta(1774.5), 1750);
  assert.strictEqual(redondearPrecioVenta(1750), 1750);
  assert.strictEqual(redondearPrecioVenta(0), 0);
});

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
  assert.strictEqual(out.precioConIva, 1750); // 1744.82 → múltiplo de 50 más cercano
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
  assert.strictEqual(out.precioConIva, 1650); // 1653.24 → múltiplo de 50 más cercano
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

test('costearAlmacen: precioConIvaExacto es el precio con IVA sin redondeo a $50', () => {
  const r = costearAlmacen({ costoMercaderia: 500, costosVariosPct: 3, markupPct: 40 });
  assert.strictEqual(r.precioConIvaExacto, 872.41); // 721 * 1.21
  assert.strictEqual(r.precioConIva, 850);
  assert.strictEqual(costearAlmacen({ costoMercaderia: null, markupPct: 40 }).precioConIvaExacto, null);
});

test('markupParaPrecio: markup que lleva el costo total al precio con IVA', () => {
  assert.strictEqual(markupParaPrecio(1000, 1210), 0);
  assert.strictEqual(markupParaPrecio(1000, 1452), 20);
  const m = markupParaPrecio(1030, 2470);
  const r = costearAlmacen({ costoMercaderia: 1030, markupPct: m });
  assert.ok(Math.abs(r.precioConIvaExacto - 2470) < 0.02);
  assert.ok(markupParaPrecio(1000, 1000) < 0); // vigente bajo el costo → negativo
});

test('markupParaPrecio: null con datos faltantes o no positivos', () => {
  for (const [c, p] of [[null, 100], [100, null], [0, 100], [100, 0], [-5, 100], [NaN, 100], [100, Infinity]]) {
    assert.strictEqual(markupParaPrecio(c, p), null);
  }
});

// ── Fase 2: Fraccionado (v2: costo del granel × margen por costo × presentación) ─

const MATRIZ_FRAC = {
  bandas: [9999, 19999, null],
  tramosG: [100, 200, 400, 500, 1000, 5000, 10000],
  markupPct: [[84.35, 76.33, 68.32, 68.32, 60.3, 53.89, 50.68],
              [87.33, 78.82, 73.71, 73.71, 70.3, 63.49, 60.08],
              [73.57, 70.26, 66.95, 66.95, 65.3, 58.69, 55.38]],
};

test('markupStdFraccionado: reproduce el Excel (Sem. Lino 500G y Garrapiñadas 150G)', () => {
  assert.deepStrictEqual(markupStdFraccionado(2297, 500, MATRIZ_FRAC), { markupPct: 68.32, fila: 0, col: 3 });
  assert.deepStrictEqual(markupStdFraccionado(11643.67, 150, MATRIZ_FRAC), { markupPct: 78.82, fila: 1, col: 1 });
});

test('markupStdFraccionado: bordes de banda y tramo, banda sin tope, más pesado que el último tramo', () => {
  assert.strictEqual(markupStdFraccionado(9999, 100, MATRIZ_FRAC).fila, 0);
  assert.strictEqual(markupStdFraccionado(10000, 100, MATRIZ_FRAC).fila, 1);
  assert.deepStrictEqual(markupStdFraccionado(50000, 101, MATRIZ_FRAC), { markupPct: 70.26, fila: 2, col: 1 });
  assert.strictEqual(markupStdFraccionado(100, 25000, MATRIZ_FRAC).col, 6);
});

test('markupStdFraccionado: sin peso → columna del tramo 1000; sin costo → null', () => {
  assert.deepStrictEqual(markupStdFraccionado(2297, null, MATRIZ_FRAC), { markupPct: 60.3, fila: 0, col: 4 });
  for (const c of [null, undefined, 0, -1, NaN]) {
    assert.deepStrictEqual(markupStdFraccionado(c, 500, MATRIZ_FRAC), { markupPct: null, fila: null, col: null });
  }
  assert.deepStrictEqual(markupStdFraccionado(100, 500, null), { markupPct: null, fila: null, col: null });
});

test('validarMarkupFraccionado: acepta la matriz default (no exige monotonía)', () => {
  assert.strictEqual(validarMarkupFraccionado(MATRIZ_FRAC), MATRIZ_FRAC);
});

test('validarMarkupFraccionado: rechaza bandas/tramos/matriz mal formados con mensaje claro', () => {
  const con = cambios => ({ ...MATRIZ_FRAC, ...cambios });
  assert.throws(() => validarMarkupFraccionado(null), /markupFraccionado/);
  assert.throws(() => validarMarkupFraccionado(con({ bandas: [] })), /bandas/);
  assert.throws(() => validarMarkupFraccionado(con({ bandas: [9999, null, 19999] })), /sin tope/);
  assert.throws(() => validarMarkupFraccionado(con({ bandas: [19999, 9999, null] })), /ascendente/);
  assert.throws(() => validarMarkupFraccionado(con({ bandas: [-5, 9999, null] })), /bandas\[0\]/);
  assert.throws(() => validarMarkupFraccionado(con({ tramosG: [100, 100, 400, 500, 1000, 5000, 10000] })), /tramosG\[1\]/);
  assert.throws(() => validarMarkupFraccionado(con({ tramosG: [0, 200, 400, 500, 1000, 5000, 10000] })), /tramosG\[0\]/);
  assert.throws(() => validarMarkupFraccionado(con({ markupPct: MATRIZ_FRAC.markupPct.slice(0, 2) })), /3 filas/);
  assert.throws(() => validarMarkupFraccionado(con({ markupPct: [[1], ...MATRIZ_FRAC.markupPct.slice(1)] })), /markupPct\[0\]/);
  const fueraDeRango = MATRIZ_FRAC.markupPct.map((f, i) => (i === 2 ? [...f.slice(0, 6), 1001] : f));
  assert.throws(() => validarMarkupFraccionado(con({ markupPct: fueraDeRango })), /markupPct\[2\]\[6\]/);
  const noNumero = MATRIZ_FRAC.markupPct.map((f, i) => (i === 0 ? ['5', ...f.slice(1)] : f));
  assert.throws(() => validarMarkupFraccionado(con({ markupPct: noNumero })), /markupPct\[0\]\[0\]/);
});

test('costearFraccionado: Sem. Lino 500G — granel 2297 × 1.6832 × 1.21, mismo shape que Almacén', () => {
  const r = costearFraccionado({ plu: '1', nombre: 'Sem. Lino 500G', costoKg: 2297, markupPct: 68.32 });
  assert.strictEqual(r.tipo, 'fraccionado');
  assert.strictEqual(r.plu, '1');
  assert.strictEqual(r.costoTotal, 2297);
  assert.deepStrictEqual(r.componentes, [{ concepto: 'Granel', detalle: 'costo por kg', importe: 2297 }]);
  assert.strictEqual(r.precioNeto, 3866.31);
  assert.strictEqual(r.precioConIvaExacto, 4678.24);
  assert.strictEqual(r.precioConIva, 4700);
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
test('costearAlmacen: costos extra del producto ($ fijo + % del costo base) se suman a base + varios', () => {
  const out = costearAlmacen({
    costoMercaderia: 1000, costosVariosPct: 3, markupPct: 40,
    costosExtra: [{ concepto: 'Flete', tipo: 'kg', valor: 50 }, { concepto: 'Merma', tipo: 'pct', valor: 2 }],
  });
  assert.strictEqual(out.costoTotal, 1100); // 1000 + 30 + 50 + 20
  assert.strictEqual(out.precioNeto, 1540);
  assert.strictEqual(out.precioConIva, 1850); // 1863.4 → múltiplo de 50
  assert.deepStrictEqual(out.componentes, [
    { concepto: 'Mercadería', detalle: 'costo base', importe: 1000 },
    { concepto: 'Costos varios', detalle: '3%', importe: 30 },
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
test('validarPresentacionTemporal: alta completa, markup null = standard, nombre opcional recortado', () => {
  const { validarPresentacionTemporal } = require('../lib/precios_costeo');
  assert.deepStrictEqual(validarPresentacionTemporal({ pesoG: 250 }), { pesoG: 250, markupPct: null });
  assert.deepStrictEqual(validarPresentacionTemporal({ pesoG: 1000, markupPct: 45.5, nombre: '  Bolsa 1kg ', otro: 1 }),
    { pesoG: 1000, markupPct: 45.5, nombre: 'Bolsa 1kg' });
  assert.deepStrictEqual(validarPresentacionTemporal({ pesoG: 1, markupPct: -99, nombre: '' }), { pesoG: 1, markupPct: -99 });
  assert.deepStrictEqual(validarPresentacionTemporal({ pesoG: 100000, markupPct: 1000 }), { pesoG: 100000, markupPct: 1000 });
});

test('validarPresentacionTemporal: rechaza peso, margen y nombre fuera de rango', () => {
  const { validarPresentacionTemporal } = require('../lib/precios_costeo');
  for (const body of [null, {}, { pesoG: 0 }, { pesoG: 100001 }, { pesoG: '250' }, { pesoG: NaN },
    { pesoG: 250, markupPct: -100 }, { pesoG: 250, markupPct: 1001 }, { pesoG: 250, markupPct: '40' },
    { pesoG: 250, nombre: 'x'.repeat(61) }, { pesoG: 250, nombre: 5 }]) {
    assert.throws(() => validarPresentacionTemporal(body), Error, JSON.stringify(body));
  }
});

test('validarPresentacionTemporal parcial: sólo las claves presentes; nombre vacío/null = quitarlo; sin claves → error', () => {
  const { validarPresentacionTemporal } = require('../lib/precios_costeo');
  assert.deepStrictEqual(validarPresentacionTemporal({ markupPct: 30 }, { parcial: true }), { markupPct: 30 });
  assert.deepStrictEqual(validarPresentacionTemporal({ markupPct: null, nombre: '' }, { parcial: true }), { markupPct: null, nombre: null });
  assert.deepStrictEqual(validarPresentacionTemporal({ pesoG: 400 }, { parcial: true }), { pesoG: 400 });
  assert.throws(() => validarPresentacionTemporal({}, { parcial: true }), /nada/);
  assert.throws(() => validarPresentacionTemporal({ pesoG: -1 }, { parcial: true }));
});
