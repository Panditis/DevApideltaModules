'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  validarDepartamentos, validarVentaBase, ventaBaseConDefault, ventaEfectiva, costoImputado,
  gastosVentaPctTipo, gastosPorTipo, estructuraCostos, validarEstructuraCostos,
  rangoVentaBase, snapshotVentaBase, sqlVentaPorTipo,
} = require('../lib/precios_costos');
const { reescalarGanancias, markupDesdeGanancia, gananciaPorCurva } = require('../lib/precios_costeo');

const GASTOS = [{ id: 'iibb', concepto: 'IIBB', pct: 10, listas: ['sucursal'] }];
const DEPTO = { id: 'adm', nombre: 'Administración', costoMensual: 1000000, imputacion: { almacen: 50, fraccionado: 30, produccion: 20 } };
const VENTA = { meses: 3, manual: { almacen: null, fraccionado: 6000000, produccion: null }, snapshot: { fecha: '2026-10-01', meses: 3, porTipo: { almacen: 10000000, fraccionado: 3000000, produccion: 0 } } };

// ── validarDepartamentos ─────────────────────────────────────────────────────

test('validarDepartamentos: limpia, recorta el nombre, genera id slug único y completa imputaciones faltantes con 0', () => {
  const r = validarDepartamentos([
    { nombre: '  Administración ', costoMensual: 100, imputacion: { almacen: 60 } },
    { nombre: 'Administración', costoMensual: 0, imputacion: { almacen: 10, fraccionado: 10, produccion: 80 }, extra: 'x' },
  ]);
  assert.deepStrictEqual(r, [
    { id: 'administracion', nombre: 'Administración', costoMensual: 100, imputacion: { almacen: 60, fraccionado: 0, produccion: 0 } },
    { id: 'administracion-2', nombre: 'Administración', costoMensual: 0, imputacion: { almacen: 10, fraccionado: 10, produccion: 80 } },
  ]);
});

test('validarDepartamentos: rechaza nombre, costo, imputación, suma > 100, id repetido y más de 40', () => {
  const ok = { nombre: 'A', costoMensual: 1, imputacion: {} };
  assert.throws(() => validarDepartamentos('x'), /lista/);
  assert.throws(() => validarDepartamentos([{ ...ok, nombre: '' }]), /nombre/);
  assert.throws(() => validarDepartamentos([{ ...ok, nombre: 'x'.repeat(61) }]), /nombre/);
  assert.throws(() => validarDepartamentos([{ ...ok, costoMensual: -1 }]), /costoMensual/);
  assert.throws(() => validarDepartamentos([{ ...ok, costoMensual: 2e12 }]), /costoMensual/);
  assert.throws(() => validarDepartamentos([{ ...ok, costoMensual: '5' }]), /costoMensual/);
  assert.throws(() => validarDepartamentos([{ ...ok, imputacion: { almacen: 101 } }]), /imputacion\.almacen/);
  assert.throws(() => validarDepartamentos([{ ...ok, imputacion: { produccion: -1 } }]), /imputacion\.produccion/);
  assert.throws(() => validarDepartamentos([{ ...ok, imputacion: { almacen: 60, fraccionado: 41 } }]), /100/);
  assert.throws(() => validarDepartamentos([{ ...ok, id: 'a' }, { ...ok, id: 'a' }]), /repetido/);
  assert.throws(() => validarDepartamentos([{ ...ok, id: 'Mal Id' }]), /id/);
  assert.throws(() => validarDepartamentos(Array.from({ length: 41 }, () => ok)), /40/);
  assert.deepStrictEqual(validarDepartamentos([]), []);
});

// ── venta base ───────────────────────────────────────────────────────────────

test('validarVentaBase: meses default 3 (1–24 entero); manual por tipo > 0 o null', () => {
  assert.deepStrictEqual(validarVentaBase({}), { meses: 3, manual: { almacen: null, fraccionado: null, produccion: null } });
  assert.deepStrictEqual(validarVentaBase({ meses: 6, manual: { almacen: 500, fraccionado: null } }),
    { meses: 6, manual: { almacen: 500, fraccionado: null, produccion: null } });
  assert.throws(() => validarVentaBase({ meses: 0 }), /meses/);
  assert.throws(() => validarVentaBase({ meses: 25 }), /meses/);
  assert.throws(() => validarVentaBase({ meses: 2.5 }), /meses/);
  assert.throws(() => validarVentaBase({ manual: { almacen: 0 } }), /manual\.almacen/);
  assert.throws(() => validarVentaBase({ manual: { fraccionado: '100' } }), /manual\.fraccionado/);
});

test('ventaEfectiva: manual ?? snapshot ?? null; ≤ 0 o ausente → null', () => {
  assert.strictEqual(ventaEfectiva(VENTA, 'almacen'), 10000000);
  assert.strictEqual(ventaEfectiva(VENTA, 'fraccionado'), 6000000);
  assert.strictEqual(ventaEfectiva(VENTA, 'produccion'), null);
  assert.strictEqual(ventaEfectiva(undefined, 'almacen'), null);
  assert.strictEqual(ventaEfectiva(ventaBaseConDefault(null), 'almacen'), null);
});

test('ventaBaseConDefault: completa meses, manual y snapshot', () => {
  assert.deepStrictEqual(ventaBaseConDefault(undefined),
    { meses: 3, manual: { almacen: null, fraccionado: null, produccion: null }, snapshot: null });
  assert.deepStrictEqual(ventaBaseConDefault({ meses: 6, manual: { almacen: 5 } }).manual, { almacen: 5, fraccionado: null, produccion: null });
});

// ── gastos por tipo ──────────────────────────────────────────────────────────

test('gastosVentaPctTipo: sin departamentos = variables% para los tres tipos (idéntico a hoy)', () => {
  const cfg = { gastosVenta: GASTOS };
  for (const t of ['almacen', 'fraccionado', 'produccion']) assert.strictEqual(gastosVentaPctTipo(cfg, t), 10);
  assert.strictEqual(gastosVentaPctTipo({}, 'almacen'), 0);
  assert.deepStrictEqual(gastosPorTipo({ gastosVenta: GASTOS, departamentos: [] }), { almacen: 10, fraccionado: 10, produccion: 10 });
});

test('gastosVentaPctTipo: variables + Σ costo×imputación ÷ venta mensual', () => {
  const cfg = { gastosVenta: GASTOS, departamentos: [DEPTO], ventaBase: VENTA };
  assert.strictEqual(gastosVentaPctTipo(cfg, 'almacen'), 15); // 10 + 500000/10M
  assert.strictEqual(gastosVentaPctTipo(cfg, 'fraccionado'), 15); // 10 + 300000/6M (manual)
  // costo imputado a producción pero sin venta → null (nunca precio optimista)
  assert.strictEqual(gastosVentaPctTipo(cfg, 'produccion'), null);
  assert.strictEqual(markupDesdeGanancia(20, null), null);
  // tipo sin costo imputado no necesita venta
  const sinProd = { ...cfg, departamentos: [{ ...DEPTO, imputacion: { almacen: 50, fraccionado: 30, produccion: 0 } }] };
  assert.strictEqual(gastosVentaPctTipo(sinProd, 'produccion'), 10);
});

test('costoImputado: suma costo × imputación del tipo', () => {
  assert.strictEqual(costoImputado([DEPTO, { ...DEPTO, costoMensual: 200 }], 'almacen'), 500100);
  assert.strictEqual(costoImputado(undefined, 'almacen'), 0);
});

test('estructuraCostos: resumen por tipo y no absorbido por departamento', () => {
  const dep2 = { id: 'log', nombre: 'Logística', costoMensual: 400000, imputacion: { almacen: 25, fraccionado: 0, produccion: 0 } };
  const e = estructuraCostos({ gastosVenta: GASTOS, departamentos: [DEPTO, dep2], ventaBase: VENTA });
  assert.deepStrictEqual(e.porTipo.almacen, { variablesPct: 10, departamentosPct: 6, totalPct: 16, ventaMensual: 10000000, costoImputado: 600000 });
  assert.deepStrictEqual(e.porTipo.produccion, { variablesPct: 10, departamentosPct: null, totalPct: null, ventaMensual: null, costoImputado: 200000 });
  assert.deepStrictEqual(e.departamentos, [
    { id: 'adm', nombre: 'Administración', costoMensual: 1000000, imputadoPct: 100, costoNoAbsorbido: 0 },
    { id: 'log', nombre: 'Logística', costoMensual: 400000, imputadoPct: 25, costoNoAbsorbido: 300000 },
  ]);
});

test('validarEstructuraCostos: costo imputado sin venta o gastos ≥ 100 % → error', () => {
  const cfg = { gastosVenta: GASTOS, departamentos: [DEPTO], ventaBase: VENTA };
  assert.throws(() => validarEstructuraCostos(cfg), /Producción.*venta/);
  const conVenta = { ...cfg, ventaBase: { ...VENTA, manual: { ...VENTA.manual, produccion: 100 } } };
  assert.throws(() => validarEstructuraCostos(conVenta), /Producción.*100/);
  const ok = { ...cfg, ventaBase: { ...VENTA, manual: { ...VENTA.manual, produccion: 4000000 } } };
  assert.doesNotThrow(() => validarEstructuraCostos(ok));
  assert.doesNotThrow(() => validarEstructuraCostos({}));
});

// ── reescalado por tipo ──────────────────────────────────────────────────────

test('reescalarGanancias por tipo: cada curva con los gastos de su tipo; el markup total de cada una queda igual', () => {
  const plana = g => ({ a: g, b: 0, pisoPct: g, techoPct: g });
  const costeo = {
    curvaGanancia: { almacen: { a: 50, b: 2, pisoPct: 10, techoPct: 60 }, fraccionado: { a: 40, b: 1, pisoPct: 5, techoPct: 50 }, produccion: plana(40) },
  };
  const viejo = { almacen: 10, fraccionado: 10, produccion: 10 };
  const nuevo = { almacen: 20, fraccionado: 10, produccion: 15 };
  const r = reescalarGanancias(costeo, viejo, nuevo);
  const cerca = (a, b) => assert.ok(Math.abs(a - b) < 0.001, `${a} vs ${b}`);
  const g = (c, costo) => gananciaPorCurva(c, costo);
  cerca(markupDesdeGanancia(g(r.curvaGanancia.almacen, 3000), 20), markupDesdeGanancia(g(costeo.curvaGanancia.almacen, 3000), 10));
  cerca(markupDesdeGanancia(g(r.curvaGanancia.produccion, 3000), 15), markupDesdeGanancia(40, 10));
  // fraccionado sin cambio de gastos: curva intacta
  assert.strictEqual(r.curvaGanancia.fraccionado, costeo.curvaGanancia.fraccionado);
  // gastos null (desconocidos) en un tipo → no se toca
  const r2 = reescalarGanancias(costeo, viejo, { ...nuevo, almacen: null, produccion: 10 });
  assert.strictEqual(r2, costeo);
});

// ── venta base desde SIGA ────────────────────────────────────────────────────

test('rangoVentaBase: meses × 30 días hasta ayer, ambos inclusive', () => {
  assert.deepStrictEqual(rangoVentaBase(3, new Date(2026, 9, 2)), { desde: '2026-07-04', hasta: '2026-10-01' });
  assert.deepStrictEqual(rangoVentaBase(1, new Date(2026, 0, 1)), { desde: '2025-12-02', hasta: '2025-12-31' });
});

test('snapshotVentaBase: promedio mensual por tipo; tipo sin filas → 0', () => {
  const s = snapshotVentaBase([{ Tipo: 'almacen', Importe: 3000 }, { Tipo: 'fraccionado', Importe: 1500.5 }], 3, '2026-10-02');
  assert.deepStrictEqual(s, { fecha: '2026-10-02', meses: 3, porTipo: { almacen: 1000, fraccionado: 500.17, produccion: 0 } });
});

test('sqlVentaPorTipo: rubros constantes, PLUs de producción sólo numéricos; sin producción no hay IN vacío', () => {
  const sql = sqlVentaPorTipo({ desde: '2026-07-04', hasta: '2026-10-01', plusProduccion: ['123', "1'; DROP TABLE x--", '456'] });
  assert.match(sql, /IN \('123','456'\)/);
  assert.doesNotMatch(sql, /DROP/);
  assert.match(sql, /'Almacen Bultos\/Cajas'/);
  assert.match(sql, /'Pesables Venta Directa'/);
  assert.match(sql, /ImporteTotalNeto/);
  assert.match(sql, /2026-07-04 00:00:00/);
  const sinProd = sqlVentaPorTipo({ desde: '2026-07-04', hasta: '2026-10-01', plusProduccion: [] });
  assert.doesNotMatch(sinProd, /IN \(\)/);
  assert.throws(() => sqlVentaPorTipo({ desde: "x' OR 1=1", hasta: '2026-10-01', plusProduccion: [] }), /fecha/);
});

test('sqlVentaPorTipo: importe NETO de impuestos (ImporteTotalNeto, sin ImporteImpuesto): los gastos van sobre el precio neto', () => {
  const sql = sqlVentaPorTipo({ desde: '2026-07-04', hasta: '2026-10-01', plusProduccion: [] });
  assert.match(sql, /vp\.ImporteTotalNeto AS Importe/);
  assert.doesNotMatch(sql, /ImporteImpuesto/);
});

test('gastosDesglosePct: variables + departamentos del tipo (suman gastosVentaPctTipo); sin venta base → deptos null', () => {
  const { gastosDesglosePct, gastosVentaPctTipo } = require('../lib/precios_costos');
  const cfg = {
    gastosVenta: [{ id: 'goa', concepto: 'GOA', pct: 15, listas: ['sucursal'] }],
    departamentos: [{ id: 'adm', nombre: 'Adm', costoMensual: 100000, imputacion: { almacen: 50, fraccionado: 0, produccion: 50 } }],
    ventaBase: { meses: 3, manual: { almacen: 1000000, fraccionado: null, produccion: null } },
  };
  assert.deepStrictEqual(gastosDesglosePct(cfg, 'almacen'), { variablesPct: 15, departamentosPct: 5 });
  assert.strictEqual(gastosVentaPctTipo(cfg, 'almacen'), 20);
  assert.deepStrictEqual(gastosDesglosePct(cfg, 'fraccionado'), { variablesPct: 15, departamentosPct: 0 });
  assert.deepStrictEqual(gastosDesglosePct(cfg, 'produccion'), { variablesPct: 15, departamentosPct: null });
});

test('sqlVentaPorTipo: un PLU de Producción gana sobre su rubro (CASE evalúa producción primero); PLUs con espacios se recortan', () => {
  const sql = sqlVentaPorTipo({ desde: '2026-07-04', hasta: '2026-10-01', plusProduccion: [' 6050 ', 91438, '6050'] });
  assert.match(sql, /IN \('6050','91438'\)/);
  const iProd = sql.indexOf("THEN 'produccion'");
  assert.ok(iProd > 0 && iProd < sql.indexOf("THEN 'almacen'") && iProd < sql.indexOf("THEN 'fraccionado'"));
});
