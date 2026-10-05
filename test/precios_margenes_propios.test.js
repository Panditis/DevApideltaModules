'use strict';
const test = require('node:test');
const assert = require('node:assert');
const m = require('../lib/precios_margenes_propios');

// Curva plana g % para cualquier costo.
const plana = g => ({ a: g, b: 0, pisoPct: g, techoPct: g });
// Config con G 20 % (variables), IVA 21, F 5 %, conceptos de ganancia 2 %: el paso tiene que ser exacto con todo eso.
const COSTEO = {
  gastosVenta: [{ id: 'v', concepto: 'V', pct: 20, listas: ['sucursal'] }],
  conceptosGanancia: [{ id: 'k', concepto: 'K', pct: 2 }],
  conceptosPrecioFinal: [{ id: 'iibb', concepto: 'IIBB', pct: 5 }],
  curvaGanancia: { almacen: plana(18), fraccionado: plana(18), produccion: plana(18) }, // standard = 18 + 2 = 20 %
};
const ctx = m.contextoPorTipo(COSTEO).almacen;
const cerca = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

test('precioExacto: costo ÷ (1 − G) × (1 + g) × (1 + IVA) ÷ (1 − F), antes del redondeo a $50', () => {
  cerca(m.precioExacto(1000, 20, ctx), 1000 / 0.8 * 1.2 * 1.21 / 0.95);
});

test('pasoMargenPropio: dentro del tope → pasa al standard (ganancia null, precio standard)', () => {
  // propia 24 % vs standard 20 %: P_s/P_o = 1,20/1,24 → −3,2 % (≤ 5 %)
  const r = m.pasoMargenPropio({ costo: 1000, gananciaPropia: 24 }, ctx, 5);
  assert.strictEqual(r.accion, 'standard');
  assert.strictEqual(r.gananciaNueva, null);
  cerca(r.precioNuevo, r.precioStandard);
  cerca(r.deltaPct, (1.2 / 1.24 - 1) * 100);
});

test('pasoMargenPropio: fuera del tope → se mueve exacto tope % hacia el standard (para arriba y para abajo)', () => {
  const baja = m.pasoMargenPropio({ costo: 1000, gananciaPropia: 50 }, ctx, 5); // standard más barato
  assert.strictEqual(baja.accion, 'acercar');
  cerca(baja.precioNuevo, baja.precioActual * 0.95);
  cerca(baja.deltaPct, -5);
  cerca(baja.gananciaNueva, 1.5 * 0.95 * 100 - 100, 1e-3); // 1 + g' = 0,95 (1 + g): exacto con G, IVA y F
  const sube = m.pasoMargenPropio({ costo: 1000, gananciaPropia: 0 }, ctx, 5); // standard más caro
  cerca(sube.precioNuevo, sube.precioActual * 1.05);
  cerca(sube.deltaPct, 5);
  // Recalcular con la ganancia nueva da el precio nuevo (inversa exacta).
  cerca(m.precioExacto(1000, baja.gananciaNueva, ctx), baja.precioNuevo);
});

test('pasoMargenPropio: converge al standard en N pasos (ceil(ln(P_o/P_s) / ln(1/(1 − tope))) + el último)', () => {
  let g = 80, pasos = 0, r;
  do {
    r = m.pasoMargenPropio({ costo: 1000, gananciaPropia: g }, ctx, 5);
    pasos++;
    if (r.accion === 'acercar') g = r.gananciaNueva;
  } while (r.accion === 'acercar' && pasos < 50);
  assert.strictEqual(r.accion, 'standard');
  // P_s/P_o = 1,2/1,8 = 0,667: 0,95^7 = 0,698 > 0,667 > 0,95^8 → 8 pasos de 5 % y el 9º pasa al standard
  assert.strictEqual(pasos, 8);
  cerca(r.precioNuevo, m.precioExacto(1000, 20, ctx));
});

test('pasoMargenPropio: sin costo o sin standard calculable no se toca', () => {
  assert.strictEqual(m.pasoMargenPropio({ costo: null, gananciaPropia: 30 }, ctx, 5).accion, 'sinCosto');
  assert.strictEqual(m.pasoMargenPropio({ costo: 0, gananciaPropia: 30 }, ctx, 5).accion, 'sinCosto');
  assert.strictEqual(m.pasoMargenPropio({ costo: 1000, gananciaPropia: 30 }, { ...ctx, gastosPct: null }, 5).accion, 'sinStandard');
  assert.strictEqual(m.pasoMargenPropio({ costo: 1000, gananciaPropia: 30 }, { ...ctx, curva: null }, 5).accion, 'sinStandard');
});

test('validarTopePct: default 5, rango 0,5–50', () => {
  assert.strictEqual(m.validarTopePct(undefined), 5);
  assert.strictEqual(m.validarTopePct(0.5), 0.5);
  assert.throws(() => m.validarTopePct(0.4), /topePct/);
  assert.throws(() => m.validarTopePct(51), /topePct/);
  assert.throws(() => m.validarTopePct('5'), /topePct/);
});

test('planMargenesPropios + aplicar: Reventa, Fraccionado (presentación y temporal) y Producción; sin listado o sin costo no se tocan', () => {
  const costeo = {
    ...COSTEO,
    margenPorProducto: { 1: 24, 2: 50, 3: 50, 777: 0, 9: 30, 4: 30 },
    presentacionesTemporales: { 400: [{ id: 't-a', pesoG: 500, gananciaPct: 50 }, { id: 't-b', pesoG: 250, gananciaPct: null }] },
  };
  const items = m.itemsDesdeListados({
    filas: [{ plu: '1', nombre: 'A', costoTotal: 1000, costoBase: 1000 }, { plu: '2', nombre: 'B', costoTotal: 1000, costoBase: 1000 },
      { plu: '777', nombre: 'Prod en Almacen', costoTotal: 5, costoBase: 5 }, { plu: '4', nombre: 'Sin costo', costoTotal: null, costoBase: null }],
    grupos: [{ granelPlu: '400', granelNombre: 'Lino', costoBase: 1000,
      presentaciones: [{ plu: '3', nombre: 'Lino 500G', costoKg: 1000, pesoG: 500 }],
      temporales: [{ id: 't-a', presentacion: '500G', costoKg: 1000, pesoG: 500 }] }],
    produccion: [{ plu: '777', nombre: 'Pan', costoUnidad: 1000 }],
  });
  const plan = m.planMargenesPropios({ costeo, items, topePct: 5 });
  assert.deepStrictEqual(plan.totales, { standard: 1, acercar: 4, sinCambio: 2 });
  assert.deepStrictEqual(plan.motivosSinCambio, { sinCosto: 1, sinStandard: 0, sinListado: 1 });
  assert.deepStrictEqual(plan.porTipo.produccion, { standard: 0, acercar: 1, sinCambio: 0 }); // 777 se toma de Producción
  assert.deepStrictEqual(plan.porTipo.fraccionado, { standard: 0, acercar: 2, sinCambio: 0 });
  assert.strictEqual(plan.total, 7);
  assert.strictEqual(plan.top.length, 5);
  assert.ok(Math.abs(plan.top[0].deltaPct) >= Math.abs(plan.top[4].deltaPct));
  assert.strictEqual(plan.distribucion.reduce((s, r) => s + r.n, 0), 5);
  const r = m.aplicarPlanMargenes(costeo, plan.cambios);
  assert.strictEqual(r.aplicados, 5);
  assert.ok(!('1' in r.costeo.margenPorProducto)); // pasó al standard
  cerca(r.costeo.margenPorProducto[2], 1.5 * 0.95 * 100 - 100, 1e-3);
  cerca(r.costeo.margenPorProducto[777], 5, 1e-3); // 1,00 × 1,05
  assert.strictEqual(r.costeo.margenPorProducto[9], 30); // sin listado: intacto
  assert.strictEqual(r.costeo.margenPorProducto[4], 30); // sin costo: intacto
  cerca(r.costeo.presentacionesTemporales[400][0].gananciaPct, 1.5 * 0.95 * 100 - 100, 1e-3);
  assert.strictEqual(r.costeo.presentacionesTemporales[400][1].gananciaPct, null);
  assert.strictEqual(costeo.margenPorProducto[1], 24); // no muta
  // Un valor editado entre el cálculo y la escritura se respeta.
  const editado = m.aplicarPlanMargenes({ ...costeo, margenPorProducto: { ...costeo.margenPorProducto, 2: 10 } }, plan.cambios);
  assert.strictEqual(editado.costeo.margenPorProducto[2], 10);
  assert.strictEqual(editado.omitidos, 1);
});

test('contarMargenesPropios: por tipo con tipoDePlu; temporales en Fraccionado', () => {
  const r = m.contarMargenesPropios({ margenPorProducto: { 1: 5, 2: 5, 777: 5 }, presentacionesTemporales: { 4: [{ id: 't', gananciaPct: 1 }, { id: 'u', gananciaPct: null }] } },
    plu => (plu === '777' ? 'produccion' : plu === '2' ? 'fraccionado' : 'almacen'));
  assert.deepStrictEqual(r, { porTipo: { almacen: 1, fraccionado: 2, produccion: 1 }, total: 4 });
});

test('sufijoBackup: AAAAMMDD-HHMM', () => {
  assert.strictEqual(m.sufijoBackup(new Date(2026, 9, 5, 9, 7)), '20261005-0907');
});
