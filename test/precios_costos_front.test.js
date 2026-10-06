'use strict';
// Helpers puros de la tab Costos (public/js/precios_costos.js) y gastos por tipo en el front
// (gastosTipoCli de public/js/precios_config_gastos.js), espejo de lib/precios_costos.js.
const test = require('node:test');
const assert = require('node:assert');
const ui = require('../public/js/precios_costos.js');
const gastosUi = require('../public/js/precios_config_gastos.js');
const lib = require('../lib/precios_costos.js');

const DEPTOS = [
  { id: 'admin', nombre: 'Admin', costoMensual: 1000000, imputacion: { almacen: 50, fraccionado: 30, produccion: 10 } },
  { id: 'logistica', nombre: 'Logística', costoMensual: 500000, imputacion: { almacen: 100, fraccionado: 0, produccion: 0 } },
];
// produccionSinDepartamentos false: Producción absorbe departamentos (el flag se prueba aparte).
const VENTA = { produccionSinDepartamentos: false, meses: 3, manual: { almacen: null, fraccionado: 2000000, produccion: null },
  snapshot: { fecha: '2026-10-01', meses: 3, porTipo: { almacen: 50000000, fraccionado: 9000000, produccion: 0 } } };

test('noImputadoPct: 100 − suma; vacíos cuentan 0; negativo si pasa de 100', () => {
  assert.strictEqual(ui.noImputadoPct({ almacen: 50, fraccionado: 30, produccion: 10 }), 10);
  assert.strictEqual(ui.noImputadoPct({ almacen: null }), 100);
  assert.strictEqual(ui.noImputadoPct(undefined), 100);
  assert.strictEqual(ui.noImputadoPct({ almacen: 60, fraccionado: 50, produccion: 0 }), -10);
  assert.strictEqual(ui.noImputadoPct({ almacen: 33.33, fraccionado: 33.33, produccion: 33.34 }), 0);
});

test('costoImputadoCli / ventaEfectivaCli: iguales al server', () => {
  for (const t of ui.COSTOS_TIPOS) {
    assert.strictEqual(ui.costoImputadoCli(DEPTOS, t), lib.costoImputado(DEPTOS, t));
    assert.strictEqual(ui.ventaEfectivaCli(VENTA, t), lib.ventaEfectiva(VENTA, t));
  }
  assert.strictEqual(ui.costoImputadoCli(DEPTOS, 'almacen'), 1000000);
  assert.strictEqual(ui.ventaEfectivaCli(VENTA, 'fraccionado'), 2000000); // manual gana
  assert.strictEqual(ui.ventaEfectivaCli(VENTA, 'produccion'), null);     // snapshot 0 = faltante
  assert.strictEqual(ui.ventaEfectivaCli({}, 'almacen'), null);
});

test('deptosPctCli: costo ÷ venta × 100 como el server; 0 sin costo; null si falta venta', () => {
  const cfg = { gastosVenta: [{ id: 'g', concepto: 'g', pct: 10, listas: ['sucursal'] }], departamentos: DEPTOS, ventaBase: VENTA };
  assert.strictEqual(ui.deptosPctCli(DEPTOS, VENTA, 'almacen'), 2);
  assert.strictEqual(ui.deptosPctCli(DEPTOS, VENTA, 'fraccionado'), 15);
  assert.strictEqual(ui.deptosPctCli(DEPTOS, VENTA, 'produccion'), null);
  assert.strictEqual(ui.deptosPctCli([], {}, 'almacen'), 0);
  for (const t of ['almacen', 'fraccionado']) {
    assert.strictEqual(10 + ui.deptosPctCli(DEPTOS, VENTA, t), lib.gastosVentaPctTipo(cfg, t));
  }
  assert.strictEqual(lib.gastosVentaPctTipo(cfg, 'produccion'), null);
});

test('bodyDepartamentos: recorta nombre, conserva id, vacíos → null, conservar default true', () => {
  const b = ui.bodyDepartamentos(
    [{ id: 'admin', nombre: '  Admin ', costoMensual: 10, imputacion: { almacen: 5 } }, { nombre: 'Nuevo', costoMensual: null, imputacion: {} }],
    { meses: 6, manual: { fraccionado: 100 } });
  assert.deepStrictEqual(b, {
    items: [
      { id: 'admin', nombre: 'Admin', costoMensual: 10, imputacion: { almacen: 5, fraccionado: null, produccion: null } },
      { nombre: 'Nuevo', costoMensual: null, imputacion: { almacen: null, fraccionado: null, produccion: null } },
    ],
    ventaBase: { meses: 6, manual: { almacen: null, fraccionado: 100, produccion: null } },
    conservarPrecios: true,
  });
  assert.strictEqual(ui.bodyDepartamentos([], { meses: 3 }, false).conservarPrecios, false);
  // Lo que arma el front lo acepta el validador del server.
  assert.doesNotThrow(() => lib.validarDepartamentos(ui.bodyDepartamentos(DEPTOS, VENTA).items));
  assert.doesNotThrow(() => lib.validarVentaBase(ui.bodyDepartamentos(DEPTOS, VENTA).ventaBase));
});

test('mensajeErrorDepto: items[i].campo → "Fila i+1 · campo"', () => {
  assert.strictEqual(ui.mensajeErrorDepto('items[0].nombre: texto de 1 a 60 caracteres'), 'Fila 1 · nombre: texto de 1 a 60 caracteres');
  assert.strictEqual(ui.mensajeErrorDepto('items[2].imputacion.almacen: debe ser un número entre 0 y 100'),
    'Fila 3 · % Reventa: debe ser un número entre 0 y 100');
  assert.strictEqual(ui.mensajeErrorDepto('items[1].imputacion: la suma de los % no puede superar 100'),
    'Fila 2 · %: la suma de los % no puede superar 100');
  assert.strictEqual(ui.mensajeErrorDepto('items[0]: ítem inválido'), 'Fila 1: ítem inválido');
  assert.strictEqual(ui.mensajeErrorDepto('Reventa: falta venta'), 'Reventa: falta venta');
});

test('fmtPesosCostos: sin decimales, null → —', () => {
  assert.strictEqual(ui.fmtPesosCostos(null), '—');
  assert.match(ui.fmtPesosCostos(1234567.4), /^\$ 1\.234\.567$/);
});

test('gastosTipoCli: fila > tipo de la config > global; null se respeta', () => {
  const cfg = { gastosVentaPct: 10, gastosVentaPctPorTipo: { almacen: 12, fraccionado: null, produccion: 10 } };
  assert.strictEqual(gastosUi.gastosTipoCli(cfg, 'almacen'), 12);
  assert.strictEqual(gastosUi.gastosTipoCli(cfg, 'fraccionado'), null);
  assert.strictEqual(gastosUi.gastosTipoCli(cfg, 'almacen', { gastosVentaPct: 14 }), 14);
  assert.strictEqual(gastosUi.gastosTipoCli(cfg, 'almacen', { gastosVentaPct: null }), null);
  assert.strictEqual(gastosUi.gastosTipoCli(cfg, 'almacen', {}), 12);
  assert.strictEqual(gastosUi.gastosTipoCli({ gastosVentaPct: 7 }, 'produccion'), 7); // config vieja
  assert.strictEqual(gastosUi.gastosTipoCli(null, 'almacen'), 0);
});

test('gastos null (falta venta base) → markup/ganancia null y leyenda con —', () => {
  assert.strictEqual(gastosUi.markupDesdeGananciaCli(15, null), null);
  assert.strictEqual(gastosUi.gananciaDesdeMarkupCli(15, null), null);
  assert.strictEqual(gastosUi.textoMarkupTotal(15, null), '');
  assert.strictEqual(gastosUi.textoGananciaGastos(15, null), 'ganancia 15 % + gastos —');
  assert.strictEqual(gastosUi.markupDesdeGananciaCli(15, undefined), 15); // undefined sigue siendo 0
});

test('deptosPctCli: Producción sin departamentos (default true) → 0 como el server; bodyDepartamentos manda el flag', () => {
  const { produccionSinDepartamentos: _f, ...sinFlag } = VENTA;
  const cfg = { gastosVenta: [{ id: 'g', concepto: 'g', pct: 10, listas: ['sucursal'] }], departamentos: DEPTOS, ventaBase: sinFlag };
  assert.strictEqual(ui.produccionSinDeptosCli(sinFlag), true);
  assert.strictEqual(ui.deptosPctCli(DEPTOS, sinFlag, 'produccion'), 0);
  assert.strictEqual(10 + ui.deptosPctCli(DEPTOS, sinFlag, 'produccion'), lib.gastosVentaPctTipo(cfg, 'produccion'));
  assert.strictEqual(ui.deptosPctCli(DEPTOS, sinFlag, 'almacen'), ui.deptosPctCli(DEPTOS, VENTA, 'almacen'));
  assert.strictEqual(ui.bodyDepartamentos([], { ...sinFlag, produccionSinDepartamentos: false }).ventaBase.produccionSinDepartamentos, false);
});
