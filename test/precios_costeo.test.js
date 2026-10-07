'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { compararConVigente, aplicarCostosExtra, validarCostosExtra, validarGastosVenta } = require('../lib/precios_costeo');


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

// ── Costos extra por producto (Reventa y graneles de Fraccionado) ──────────────
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

test('aplicarCostosExtra: unidad del ítem fijo configurable ($ en Almacén, $/kg por defecto)', () => {
  const items = [{ concepto: 'F', tipo: 'kg', valor: 10 }];
  assert.strictEqual(aplicarCostosExtra(100, items).componentes[0].detalle, '$/kg');
  assert.strictEqual(aplicarCostosExtra(100, items, '$').componentes[0].detalle, '$');
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

// ── validarGastosVenta (Configuración › Costos) ─────────────────────────────
test('validarGastosVenta: devuelve la lista limpia; id por slug del concepto si falta; listas default sucursal', () => {
  const r = validarGastosVenta([
    { concepto: '  Ingresos Brutos ', pct: 5, basura: 1 },
    { id: 'goa', concepto: 'GOA', pct: 15, listas: ['sucursal'] },
    { concepto: 'Ingresos brutos', pct: 1 },
  ]);
  assert.deepStrictEqual(r, [
    { id: 'ingresos-brutos', concepto: 'Ingresos Brutos', pct: 5, listas: ['sucursal'] },
    { id: 'goa', concepto: 'GOA', pct: 15, listas: ['sucursal'] },
    { id: 'ingresos-brutos-2', concepto: 'Ingresos brutos', pct: 1, listas: ['sucursal'] },
  ]);
  assert.deepStrictEqual(validarGastosVenta([]), []);
});

test('validarGastosVenta: errores claros (lista, concepto, pct, listas, id, repetidos, máximo, total ≥ 100)', () => {
  assert.throws(() => validarGastosVenta('x'), /lista/);
  assert.throws(() => validarGastosVenta([null]), /items\[0\]/);
  assert.throws(() => validarGastosVenta([{ concepto: '', pct: 1 }]), /concepto/);
  assert.throws(() => validarGastosVenta([{ concepto: 'x'.repeat(61), pct: 1 }]), /concepto/);
  assert.throws(() => validarGastosVenta([{ concepto: 'A', pct: -1 }]), /pct/);
  assert.throws(() => validarGastosVenta([{ concepto: 'A', pct: 101 }]), /pct/);
  assert.throws(() => validarGastosVenta([{ concepto: 'A', pct: '5' }]), /pct/);
  assert.throws(() => validarGastosVenta([{ concepto: 'A', pct: 5, listas: ['mayorista'] }]), /listas/);
  assert.throws(() => validarGastosVenta([{ concepto: 'A', pct: 5, listas: [] }]), /listas/);
  assert.throws(() => validarGastosVenta([{ id: 'Con Espacios', concepto: 'A', pct: 5 }]), /id/);
  assert.throws(() => validarGastosVenta([{ id: 'a', concepto: 'A', pct: 5 }, { id: 'a', concepto: 'B', pct: 5 }]), /repetido/);
  assert.throws(() => validarGastosVenta(Array.from({ length: 41 }, (_, i) => ({ concepto: `G${i}`, pct: 0 }))), /máximo 40/);
  assert.throws(() => validarGastosVenta([{ concepto: 'A', pct: 60 }, { concepto: 'B', pct: 40 }]), /menor a 100/);
});
