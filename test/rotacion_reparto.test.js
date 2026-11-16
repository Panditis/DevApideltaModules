'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { esPocasVentas, objetivoFinal, repartirFaltante, emparejar, redistribuirProducto } = require('../lib/rotacion_reparto');

const cfg = { dias: 30, umbrales: { unidDia: 0.25, kgDia: 0.05 } };

test('esPocasVentas y objetivoFinal', () => {
  assert.strictEqual(esPocasVentas(7, 30, false, cfg.umbrales), true);
  assert.strictEqual(esPocasVentas(8, 30, false, cfg.umbrales), false);
  assert.strictEqual(objetivoFinal({ pocasVentas: true, presencia: 3, min: 5, S: 10 }), 3);
  assert.strictEqual(objetivoFinal({ pocasVentas: true, presencia: 0, min: 5, S: 10 }), 5);
  assert.strictEqual(objetivoFinal({ pocasVentas: false, presencia: 3, min: 5, S: 10 }), 10);
});

test('repartirFaltante: pool corto da piso a todas antes del extra, en múltiplos de caja', () => {
  const r = repartirFaltante({ faltante: 100, donantes: { 9: 12 }, unidad: 2,
    receptoras: { 5: { necesidad: 20, ventas: 90, piso: 4 }, 2: { necesidad: 20, ventas: 10, piso: 4 } } });
  assert.deepStrictEqual(r.sale, { 9: 12 });
  assert.ok(r.entra[2] >= 4 && r.entra[5] >= 4);
  assert.strictEqual(r.entra[2] + r.entra[5], 12);
  for (const v of Object.values(r.entra)) assert.strictEqual(v % 2, 0);
});

test('redistribuirProducto: sin faltante devuelve null; con faltante sale de la de pocas ventas', () => {
  const base = { plu: '1', nombre: 'X', rubro: 'Almacen', pesable: false, unidad: 1, minimo: 1 };
  const sucursales = {
    5: { stock: 0, necesidad: 10, min: 4, S: 10, presencia: 3, piso: 1 },
    9: { stock: 15, necesidad: 0, min: 4, S: 10, presencia: 3, piso: 1 },
    8: { stock: 50, necesidad: 0, min: 4, S: 10, presencia: 3, piso: 1 },
  };
  assert.strictEqual(redistribuirProducto({ ...base, central: 20, sucursales }, { 5: 100 }, cfg), null);
  const p = redistribuirProducto({ ...base, central: 0, sucursales }, { 5: 100, 9: 1 }, cfg);
  assert.deepStrictEqual(p.movimientos, [{ origen: 9, destino: 5, cantidad: 10 }]);
  assert.strictEqual(p.sucursales[9].stockFinal, 5);
  assert.strictEqual(p.sucursales[8], undefined);
  assert.strictEqual(p.cubierto, 1);
});

test('emparejar: mayor sobrante a mayor necesidad', () => {
  assert.deepStrictEqual(emparejar({ 9: 6, 3: 2 }, { 5: 8 }),
    [{ origen: 9, destino: 5, cantidad: 6 }, { origen: 3, destino: 5, cantidad: 2 }]);
});

// ── Casos de la spec (docs/specs/redistribucion_sucursales.md) ────────────────
const sucBase = { min: 4, S: 10, presencia: 2, piso: 0 };
const prod = (sucursales, extra = {}) => ({ plu: '7', nombre: 'P', rubro: 'R', pesable: false, central: 0,
  unidad: 1, minimo: 1, ...extra, sucursales: Object.fromEntries(Object.entries(sucursales).map(([k, v]) => [k, { ...sucBase, ...v }])) });
const totalMov = (p, campo, s) => p.movimientos.filter(m => String(m[campo]) === String(s)).reduce((a, m) => a + m.cantidad, 0);
function invariantes(p) {
  for (const [s, x] of Object.entries(p.sucursales)) {
    assert.ok(x.stockFinal >= 0, `stockFinal negativo en ${s}`);
    const delta = Math.round((x.stockFinal - x.stock) * 1000) / 1000;
    assert.strictEqual(delta, Math.round((totalMov(p, 'destino', s) - totalMov(p, 'origen', s)) * 1000) / 1000);
  }
  const sale = p.movimientos.reduce((a, m) => a + m.cantidad, 0);
  assert.strictEqual(Math.round(sale * 1000) / 1000, p.mover);
}

test('pool corto: mueve todo el sobrante y cubierto queda < 1', () => {
  const p = redistribuirProducto(prod({ 5: { stock: 0, necesidad: 10 }, 9: { stock: 6, necesidad: 0 } }), { 5: 100 }, cfg);
  assert.strictEqual(p.faltante, 10);
  assert.strictEqual(p.disponible, 4);
  assert.strictEqual(p.mover, 4);
  assert.strictEqual(p.cubierto, 0.4);
  invariantes(p);
});

test('pool sobrado: cubre el faltante entero (cubierto = 1) y no vacía de más al donante', () => {
  const p = redistribuirProducto(prod({ 5: { stock: 0, necesidad: 3 }, 9: { stock: 40, necesidad: 0 } }, { central: 1 }), { 5: 100 }, cfg);
  assert.strictEqual(p.faltante, 2);
  assert.strictEqual(p.mover, 2);
  assert.strictEqual(p.cubierto, 1);
  assert.strictEqual(p.sucursales[9].stockFinal, 38);
  invariantes(p);
});

test('pesables: mueve en múltiplos de la bolsa y redondea a 0,1 kg', () => {
  const p = redistribuirProducto(prod({ 5: { stock: 0, necesidad: 2.4 }, 9: { stock: 3.2, necesidad: 0, presencia: 0.5 } },
    { pesable: true, unidad: 0.5, minimo: 1 }), { 5: 50 }, cfg);
  assert.strictEqual(p.unidad, 'kg');
  for (const m of p.movimientos) {
    assert.strictEqual(Math.round(m.cantidad * 10) / 10, m.cantidad);
    assert.strictEqual(Math.round(m.cantidad / 0.5 * 1000) % 1000, 0);
    assert.ok(m.cantidad >= 1);
  }
  assert.strictEqual(p.mover, 2);
  invariantes(p);
});

test('almacén: solo cajas enteras y nada por debajo del mínimo de movimiento', () => {
  const r = repartirFaltante({ faltante: 30, donantes: { 9: 13 }, unidad: 6, minimo: 6,
    receptoras: { 5: { necesidad: 30, ventas: 10 } } });
  assert.deepStrictEqual(r, { sale: { 9: 12 }, entra: { 5: 12 } });
  const chico = repartirFaltante({ faltante: 30, donantes: { 9: 5 }, unidad: 6, minimo: 6,
    receptoras: { 5: { necesidad: 30, ventas: 10 } } });
  assert.deepStrictEqual(chico, { sale: {}, entra: {} });
});

test('sin ventas en ninguna receptora: reparte proporcional a la necesidad', () => {
  const r = repartirFaltante({ faltante: 40, donantes: { 9: 8 }, unidad: 1,
    receptoras: { 5: { necesidad: 30, ventas: 0 }, 2: { necesidad: 10, ventas: 0 } } });
  assert.deepStrictEqual(r.entra, { 5: 6, 2: 2 });
});

test('sin clase ABC (presencia 0): el objetivo del donante es el min A8020', () => {
  const p = redistribuirProducto(prod({ 5: { stock: 0, necesidad: 20 }, 9: { stock: 10, necesidad: 0, presencia: 0, min: 7 } }), { 5: 100 }, cfg);
  assert.strictEqual(p.sucursales[9].objetivo, 7);
  assert.strictEqual(p.sucursales[9].stockFinal, 7);
});

test('solo dona la de pocas ventas sin necesidad: la que vende bien no dona', () => {
  const p = redistribuirProducto(prod({ 5: { stock: 0, necesidad: 5 }, 3: { stock: 50, necesidad: 0 }, 9: { stock: 4, necesidad: 0 } }),
    { 5: 100, 3: 300 }, cfg);
  assert.strictEqual(p.sucursales[3].sobrante, 0);
  assert.ok(p.movimientos.every(m => m.origen === 9));
});

test('pocas ventas CON necesidad: recibe pero no dona', () => {
  const p = redistribuirProducto(prod({ 5: { stock: 30, necesidad: 2 }, 9: { stock: 8, necesidad: 0 } }), {}, cfg);
  assert.strictEqual(p.sucursales[5].pocasVentas, true);
  assert.strictEqual(p.sucursales[5].sobrante, 0);
  assert.deepStrictEqual(p.movimientos, [{ origen: 9, destino: 5, cantidad: 2 }]);
});

test('sucursales 6, 8 y 11 nunca aparecen ni como origen ni destino', () => {
  const p = redistribuirProducto(prod({ 5: { stock: 0, necesidad: 5 }, 6: { stock: 90, necesidad: 0 }, 8: { stock: 0, necesidad: 9 },
    11: { stock: 90, necesidad: 0 }, 9: { stock: 9, necesidad: 0 } }), { 5: 100 }, cfg);
  for (const s of ['6', '8', '11']) assert.strictEqual(p.sucursales[s], undefined);
  assert.strictEqual(p.faltante, 5);
  assert.ok(p.movimientos.every(m => ![6, 8, 11].includes(m.origen) && ![6, 8, 11].includes(m.destino)));
});

test('faltante 0 o sin donantes devuelve null', () => {
  assert.strictEqual(redistribuirProducto(prod({ 5: { stock: 0, necesidad: 5 }, 9: { stock: 9, necesidad: 0 } }, { central: 5 }), {}, cfg), null);
  assert.strictEqual(redistribuirProducto(prod({ 5: { stock: 0, necesidad: 5 }, 9: { stock: 9, necesidad: 0 } }), { 5: 100, 9: 100 }, cfg), null);
});

test('invariantes en un caso con varias donantes y receptoras', () => {
  const p = redistribuirProducto(prod({ 5: { stock: 0, necesidad: 12, piso: 2 }, 2: { stock: 1, necesidad: 7, piso: 2 },
    9: { stock: 9, necesidad: 0 }, 3: { stock: 6, necesidad: 0 }, 10: { stock: 3, necesidad: 0 } }, { unidad: 2, minimo: 2 }),
  { 5: 90, 2: 40 }, cfg);
  invariantes(p);
  assert.ok(p.cubierto > 0 && p.cubierto <= 1);
});
