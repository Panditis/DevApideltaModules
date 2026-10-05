'use strict';
// Simulador de precios (public/js/precios_simulador.js): con la misma config, un costo de compra da exactamente
// lo mismo que el costeo del server (calcularFilaAlmacen / armarGruposFraccionado / lib/precios_costeo).
const test = require('node:test');
const assert = require('node:assert');
const { simularPrecio } = require('../public/js/precios_simulador.js');
const preciosCosteo = require('../lib/precios_costeo.js');
const preciosCostos = require('../lib/precios_costos.js');
const { calcularFilaAlmacen, armarGruposFraccionado } = require('../routes/rutas_precios');

// costeo.json de ejemplo: curvas logarítmicas, variables + departamentos, conceptos de ganancia, IVA de venta 21.
// minutosFraccionadoStd / insumosFraccionadoStd son claves viejas (archivo sin limpiar): server y simulador las ignoran.
const COSTEO = {
  toleranciaPct: 10, costoHora: 4500, minutosFraccionadoStd: 2, insumosFraccionadoStd: 150,
  gastosVenta: [{ id: 'tarjeta', concepto: 'Tarjeta', pct: 3.5, listas: ['sucursal'] },
    { id: 'iibb', concepto: 'IIBB', pct: 4.25, listas: ['sucursal'] }],
  departamentos: [{ id: 'admin', nombre: 'Admin', costoMensual: 3000000, imputacion: { almacen: 50, fraccionado: 30, produccion: 20 } }],
  ventaBase: { meses: 3, manual: {}, snapshot: { fecha: '2026-10-01', meses: 3, porTipo: { almacen: 90000000, fraccionado: 20000000, produccion: 15000000 } } },
  conceptosGanancia: [{ id: 'reposicion', concepto: 'Reposición', pct: 5 }, { id: 'riesgo', concepto: 'Riesgo', pct: 2.5 }],
  ivaVentaPct: 21,
  conceptosPrecioFinal: [{ id: 'ingresos-brutos', concepto: 'Ingresos brutos', pct: 5 }, { id: 'impuesto-deb-cred', concepto: 'Impuesto débitos y créditos', pct: 0.79 }],
  curvaGanancia: {
    almacen: { a: 120, b: 10, pisoPct: 20, techoPct: 80 },
    fraccionado: { a: 150, b: 12, pisoPct: 25, techoPct: 90,
      ajustesPeso: { tramosG: [100, 200, 400, 500, 1000, 5000, 10000], puntos: [24.05, 16.03, 8.02, 8.02, 0, -6.41, -9.62] } },
    produccion: { a: 110, b: 9, pisoPct: 15, techoPct: 70 },
  },
};
// Lo que devuelve GET /api/precios/config (datosCostos + datosGanancia + curvas con default).
const conceptosGanancia = preciosCosteo.conceptosGananciaDe(COSTEO);
const CFG = {
  ...COSTEO, gastosVentaPct: preciosCosteo.totalGastosVenta(COSTEO.gastosVenta),
  gastosVentaPctPorTipo: preciosCostos.gastosPorTipo(COSTEO), estructuraCostos: preciosCostos.estructuraCostos(COSTEO),
  conceptosGanancia, conceptosGananciaPct: preciosCosteo.totalConceptosGanancia(conceptosGanancia),
  conceptosPrecioFinal: preciosCosteo.conceptosPrecioFinalDe(COSTEO),
  ivaVentaPct: preciosCosteo.ivaVentaPctDe(COSTEO), curvaGanancia: preciosCosteo.curvasGananciaConDefault(COSTEO.curvaGanancia),
};
const COSTOS = [37.4, 812.5, 1234.56, 4999.99, 28750];

const mismoDesglose = (sim, server) => {
  for (const k of ['costo', 'variables', 'departamentos', 'costoReal', 'gananciaPct', 'ganancia', 'gananciaCurva', 'precioNeto', 'iva',
    'precioConIvaBase', 'conceptosFinalPct', 'conceptosFinalImporte', 'precioFinalExacto']) {
    assert.strictEqual(sim.d[k], server.desglose[k], k);
  }
  assert.deepStrictEqual(sim.d.conceptos, server.desglose.conceptos);
  assert.deepStrictEqual(sim.d.conceptosFinal, server.desglose.conceptosFinal);
  assert.strictEqual(server.desglose.conceptosFinal.length, 2);
  assert.strictEqual(sim.d.precioFinal, server.precioConIva);
  assert.strictEqual(sim.d.markupFinalPct, server.markupFinalPct);
};

test('Reventa: igual que calcularFilaAlmacen con el costo neto como costo de sistema', () => {
  for (const costo of COSTOS) {
    const server = calcularFilaAlmacen({ plu: '1', nombre: 'X', costoSistema: costo, precioVigente: null, costeoConfig: COSTEO });
    const sim = simularPrecio(CFG, { costo });
    assert.deepStrictEqual(sim.faltantes, []);
    assert.strictEqual(sim.costoTotal, server.costoTotal);
    assert.strictEqual(sim.markup, server.markupPct);
    mismoDesglose(sim, server);
  }
});

test('Reventa con IVA: costo ÷ (1 + alícuota) como el costo de sistema neto del server', () => {
  for (const [costo, ali] of [[1210, 21], [999.99, 21], [5000, 10.5]]) {
    const neto = preciosCosteo.redondear2(costo / (1 + ali / 100)); // costoSistemaNeto (lib/precios_consultas.js)
    const server = calcularFilaAlmacen({ plu: '1', nombre: 'X', costoSistema: neto, precioVigente: null, costeoConfig: COSTEO });
    const sim = simularPrecio(CFG, { costo, conIva: true, ivaCompraPct: ali });
    assert.strictEqual(sim.costoNeto, neto);
    assert.strictEqual(sim.ivaCompra, preciosCosteo.redondear2(costo - neto));
    mismoDesglose(sim, server);
  }
});

test('Fraccionado con peso: igual que la presentación de armarGruposFraccionado (curva + ajuste; sin propios no suma MO ni insumos)', () => {
  for (const costo of COSTOS) {
    for (const [nombre, pesoG] of [['X 100G', 100], ['X 500G', 500], ['X 1Kg', 1000], ['X 5Kg', 5000]]) {
      const [grupo] = armarGruposFraccionado({
        graneles: [{ plu: 'G', nombre: 'X Granel' }], presentaciones: [{ plu: 'P', nombre }], formulas: { P: { granel: 'G' } },
        costos: new Map([['G', { nombre: 'X Granel', costoMercaderia: null, costoSistema: costo }]]),
        vigentes: new Map(), costeoConfig: COSTEO,
      });
      const server = grupo.presentaciones[0];
      const sim = simularPrecio(CFG, { costo, tipo: 'fraccionado', pesoG });
      assert.deepStrictEqual(sim.faltantes, []);
      assert.strictEqual(server.costoMoKg, 0, `MO ${pesoG}`);
      assert.strictEqual(server.costoInsumosKg, 0, `insumos ${pesoG}`);
      assert.strictEqual(sim.costoTotal, server.costoKg, `costo ${pesoG}`);
      assert.strictEqual(sim.markup, server.markupPct, `markup ${pesoG}`);
      mismoDesglose(sim, server);
    }
  }
});

test('Producción: curva de Producción + conceptos con los gastos de Producción (precioDe de lib/precios_produccion)', () => {
  for (const costo of COSTOS) {
    const ganancia = preciosCosteo.gananciaStandard(preciosCosteo.gananciaPorCurva(CFG.curvaGanancia.produccion, costo),
      preciosCosteo.totalConceptosGanancia(conceptosGanancia));
    const markupPct = preciosCosteo.markupDesdeGanancia(ganancia, preciosCostos.gastosVentaPctTipo(COSTEO, 'produccion'));
    const server = preciosCosteo.camposPrecio(preciosCosteo.desglosePrecio({ costo, markupPct,
      gastos: preciosCostos.gastosDesglosePct(COSTEO, 'produccion'), ivaPct: 21, conceptos: conceptosGanancia,
      conceptosFinal: preciosCosteo.conceptosPrecioFinalDe(COSTEO) }));
    mismoDesglose(simularPrecio(CFG, { costo, tipo: 'produccion' }), server);
  }
});

test('resumen: margen de costos, ganancia final sobre el precio redondeado', () => {
  const r = simularPrecio(CFG, { costo: 1000 });
  const G = CFG.gastosVentaPctPorTipo.almacen;
  assert.strictEqual(r.resumen.margenCostosPctNeto, G);
  assert.strictEqual(r.resumen.margenCostosPctCosto, Math.round(G / (100 - G) * 1e4) / 100);
  assert.strictEqual(r.resumen.gastos, preciosCosteo.redondear2(r.d.costoReal - r.d.costo));
  const netoFinal = preciosCosteo.redondear2(r.d.precioFinal * (1 - 0.0579) / 1.21);
  assert.strictEqual(r.resumen.netoFinal, netoFinal);
  assert.strictEqual(r.resumen.gananciaFinal, preciosCosteo.redondear2(netoFinal - r.d.costoReal));
  assert.ok(r.resumen.gananciaFinalPctFinal < r.resumen.gananciaFinalPctNeto);
});

test('faltantes: sin costo, gastos desconocidos o curva inválida → mensaje, nunca un precio', () => {
  assert.strictEqual(simularPrecio(CFG, { costo: null }).faltantes.length, 1);
  assert.strictEqual(simularPrecio(CFG, { costo: 0 }).d, undefined);
  assert.match(simularPrecio(CFG, { costo: 100, tipo: 'fraccionado', pesoG: null }).faltantes[0], /peso/);
  const sinVenta = { ...CFG, gastosVentaPctPorTipo: { ...CFG.gastosVentaPctPorTipo, almacen: null } };
  const r = simularPrecio(sinVenta, { costo: 100 });
  assert.match(r.faltantes[0], /Faltan los gastos de Reventa/);
  assert.strictEqual(r.d, undefined);
  const sinCurva = { ...CFG, curvaGanancia: { ...CFG.curvaGanancia, almacen: { a: 1, b: 0, pisoPct: 5, techoPct: 1 } } };
  assert.match(simularPrecio(sinCurva, { costo: 100 }).faltantes[0], /curva/);
});
