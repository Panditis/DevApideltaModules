'use strict';
// Helpers puros compartidos del front de Precios (public/js/precios_comun.js): orden de tablas y fechas de precio.
const test = require('node:test');
const assert = require('node:assert');
const o = require('../public/js/precios_comun.js');

const plus = filas => filas.map(f => f.plu);

test('ordenarFilas con extractor: Δ% negativos como número, null al final en asc y desc', () => {
  const filas = [{ plu: 'a', d: -5 }, { plu: 'b', d: null }, { plu: 'c', d: 12.5 }, { plu: 'd', d: -20 }];
  const ext = (f) => f.d;
  assert.deepStrictEqual(plus(o.ordenarFilas(filas, 'delta', 'asc', ext)), ['d', 'a', 'c', 'b']);
  assert.deepStrictEqual(plus(o.ordenarFilas(filas, 'delta', 'desc', ext)), ['c', 'a', 'd', 'b']);
  assert.deepStrictEqual(plus(o.ordenarFilas(filas, 'delta', null, ext)), ['a', 'b', 'c', 'd']);
});

// ── Fecha de actualización del precio (HistorialPrecios) ──────────────────────
test('fmtFechaPrecio: YYYY-MM-DD → dd/mm/aaaa; null o basura → —', () => {
  assert.strictEqual(o.fmtFechaPrecio('2026-03-07'), '07/03/2026');
  assert.strictEqual(o.fmtFechaPrecio(null), '—');
  assert.strictEqual(o.fmtFechaPrecio(''), '—');
  assert.strictEqual(o.fmtFechaPrecio('x'), '—');
});

test('esPrecioViejo: más de DIAS_PRECIO_VIEJO días contra hoy; null no es viejo', () => {
  const hoy = new Date(2026, 8, 29); // 29/09/2026
  assert.strictEqual(o.DIAS_PRECIO_VIEJO, 90);
  assert.strictEqual(o.esPrecioViejo('2026-07-01', hoy), false); // 90 días justos
  assert.strictEqual(o.esPrecioViejo('2026-06-30', hoy), true);  // 91
  assert.strictEqual(o.esPrecioViejo('2026-09-29', hoy), false);
  assert.strictEqual(o.esPrecioViejo(null, hoy), false);
});

test('rangoFechas: más antigua y más reciente ignorando nulls; sin fechas → null', () => {
  assert.deepStrictEqual(o.rangoFechas(['2026-05-01', null, '2025-12-31', '2026-09-01']), { min: '2025-12-31', max: '2026-09-01' });
  assert.deepStrictEqual(o.rangoFechas(['2026-05-01']), { min: '2026-05-01', max: '2026-05-01' });
  assert.strictEqual(o.rangoFechas([null, undefined]), null);
  assert.strictEqual(o.rangoFechas([]), null);
});
