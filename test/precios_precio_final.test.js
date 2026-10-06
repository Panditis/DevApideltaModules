'use strict';
// Parte D (spec 2026-10-02-precios-costo-neto-iva-curva): conceptos sobre precio final (gross-up después del IVA).
const test = require('node:test');
const assert = require('node:assert');
const pc = require('../lib/precios_costeo');
const produccion = require('../lib/precios_produccion');
const { calcularFilaAlmacen, markupsAlineadosConSiga, armarGruposFraccionado } = require('../routes/rutas_precios');

const PF = [{ id: 'ingresos-brutos', concepto: 'Ingresos brutos', pct: 5 }, { id: 'impuesto-deb-cred', concepto: 'Impuesto débitos y créditos', pct: 0.79 }];
const GASTOS = { variablesPct: 12.5, departamentosPct: 6.3 };
const CFG = {
  toleranciaPct: 10, gastosVenta: [{ id: 'tarjeta', concepto: 'Tarjeta', pct: 12.5, listas: ['sucursal'] }],
  conceptosGanancia: [{ id: 'reinv', concepto: 'Reinversión', pct: 2 }], ivaVentaPct: 21, conceptosPrecioFinal: PF,
  curvaGanancia: { almacen: { a: 120, b: 10, pisoPct: 20, techoPct: 80 }, fraccionado: { a: 150, b: 12, pisoPct: 25, techoPct: 90 } },
};

test('fórmula: final exacto = C(1 + m)(1 + IVA) ÷ (1 − F); con F = 0 es el precio de antes', () => {
  for (const [costo, markup, iva] of [[1000, 40, 21], [37.4, 112.3456, 21], [28750, 18.2, 10.5], [812.5, 63.1, 27]]) {
    const sin = pc.desglosePrecio({ costo, markupPct: markup, gastos: GASTOS, ivaPct: iva });
    const con = pc.desglosePrecio({ costo, markupPct: markup, gastos: GASTOS, ivaPct: iva, conceptosFinal: PF });
    assert.strictEqual(sin.precioFinalExacto, sin.precioConIvaBase); // F = 0: identidad
    assert.deepStrictEqual(sin.conceptosFinal, []);
    assert.strictEqual(con.precioConIvaBase, sin.precioFinalExacto);
    assert.strictEqual(con.precioFinalExacto, pc.redondear2(con.precioConIvaBase / (1 - 0.0579)));
    assert.ok(Math.abs(con.precioFinalExacto - costo * (1 + markup / 100) * (1 + iva / 100) / (1 - 0.0579)) < 0.02);
    assert.strictEqual(con.conceptosFinalPct, 5.79);
  }
});

test('desglose: base + Σ conceptos $ = final exacto, al centavo (el último absorbe el redondeo)', () => {
  const listas = [PF, [{ concepto: 'A', pct: 33.333 }], [{ concepto: 'A', pct: 1.111 }, { concepto: 'B', pct: 2.222 }, { concepto: 'C', pct: 3.333 }]];
  for (const lista of listas) {
    for (let costo = 13.37; costo < 60000; costo *= 1.73) {
      const d = pc.desglosePrecio({ costo, markupPct: 47.77, gastos: GASTOS, ivaPct: 21, conceptosFinal: lista });
      const suma = pc.redondear2(d.conceptosFinal.reduce((s, c) => s + c.importe, d.precioConIvaBase));
      assert.strictEqual(suma, d.precioFinalExacto, `${costo}`);
      assert.strictEqual(pc.redondear2(d.precioConIvaBase + d.conceptosFinalImporte), d.precioFinalExacto);
      assert.strictEqual(pc.redondear2(d.precioNeto + d.iva), d.precioConIvaBase);
      d.conceptosFinal.slice(0, -1).forEach(c => assert.strictEqual(c.importe, pc.redondear2(d.precioFinalExacto * c.pct / 100)));
    }
  }
});

test('costearAlmacen / Fraccionado / Producción: finalPct en la fila y precio con gross-up', () => {
  const a = pc.costearAlmacen({ costoMercaderia: 1000, markupPct: 40, gastos: GASTOS, conceptosFinal: PF });
  assert.strictEqual(a.finalPct, 5.79);
  assert.strictEqual(a.precioConIvaExacto, pc.redondear2(1694 / (1 - 0.0579)));
  assert.strictEqual(a.precioConIva, pc.redondearPrecioVenta(a.precioConIvaExacto));
  assert.strictEqual(pc.costearAlmacen({ costoMercaderia: null, markupPct: 40, conceptosFinal: PF }).finalPct, 5.79);
  assert.strictEqual(pc.costearFraccionado({ costoKg: 1000, markupPct: 40, gastos: GASTOS, conceptosFinal: PF }).precioConIvaExacto, a.precioConIvaExacto);
  const p = produccion.costearProducto({
    producto: { recetas: {}, presentaciones: { 100: { recetaId: 'x', kgPorUnidad: 1 } } }, costoDe: () => null,
    curva: { a: 30, b: 0, pisoPct: 30, techoPct: 30 }, conceptosFinal: PF,
  }).presentaciones[100];
  assert.strictEqual(p.finalPct, 5.79); // sin receta: faltante, pero la fila lleva F para la curva/alinear
});

test('markupParaPrecio invierte el gross-up: precio × (1 − F) ÷ (1 + IVA) ÷ costo − 1', () => {
  const m = pc.markupParaPrecio(1000, 1798.11, 21, 5.79);
  assert.ok(Math.abs(m - (1798.11 * 0.9421 / 1.21 / 1000 - 1) * 100) < 1e-6);
  assert.strictEqual(pc.markupParaPrecio(1000, 1452, 21), 20); // sin F: como antes
  assert.strictEqual(pc.markupParaPrecio(1000, 1452, 21, 100), null);
  // Recalcular con ese markup reproduce el precio al centavo.
  for (const [costo, vigente] of [[1000, 1798.11], [37.4, 99.99], [28750, 52340]]) {
    const mk = pc.markupParaPrecio(costo, vigente, 21, 5.79);
    const c = pc.costearAlmacen({ costoMercaderia: costo, markupPct: mk, gastos: GASTOS, conceptosFinal: PF });
    assert.ok(Math.abs(c.precioConIvaExacto - vigente) <= 0.02, `${costo}: ${c.precioConIvaExacto} vs ${vigente}`);
  }
});

test('Alinear con SIGA con conceptos sobre precio final: la ganancia propia reproduce el vigente (alineado exacto)', () => {
  const vigentes = { 1: 1850, 2: 437.5, 3: 61200 };
  const costos = { 1: 1000, 2: 180.25, 3: 30111 };
  const filas = Object.keys(vigentes).map(plu => calcularFilaAlmacen({ plu, nombre: 'X', costoSistema: costos[plu], precioVigente: vigentes[plu], costeoConfig: CFG }));
  filas.forEach(f => assert.strictEqual(f.finalPct, 5.79));
  const { ganancias, alineados } = markupsAlineadosConSiga(filas);
  assert.strictEqual(alineados, 3);
  const alineado = { ...CFG, margenPorProducto: ganancias };
  for (const plu of Object.keys(vigentes)) {
    const f = calcularFilaAlmacen({ plu, nombre: 'X', costoSistema: costos[plu], precioVigente: vigentes[plu], costeoConfig: alineado });
    assert.strictEqual(f.precioConIva, vigentes[plu], plu);
    assert.strictEqual(f.deltaPct, 0);
  }
});

test('Fraccionado: presentaciones con F y alinear con su finalPct reproduce el vigente', () => {
  const grupos = armarGruposFraccionado({
    graneles: [{ plu: '10', nombre: 'Granel' }], presentaciones: [{ plu: '11', nombre: 'Granel 500G' }],
    formulas: { 11: { granel: '10' } }, costos: new Map([['10', { costoSistema: 2000 }]]), vigentes: new Map([['11', 7777]]),
    costeoConfig: CFG,
  });
  const p = grupos[0].presentaciones[0];
  assert.strictEqual(p.finalPct, 5.79);
  assert.strictEqual(p.desglose.conceptosFinal.length, 2);
  const { ganancias } = markupsAlineadosConSiga([{ plu: p.plu, costoTotal: p.costoKg, precioVigente: 7777, ivaPct: p.ivaPct, finalPct: p.finalPct,
    gastosVentaPct: 12.5 }]);
  const otra = armarGruposFraccionado({
    graneles: [{ plu: '10', nombre: 'Granel' }], presentaciones: [{ plu: '11', nombre: 'Granel 500G' }],
    formulas: { 11: { granel: '10' } }, costos: new Map([['10', { costoSistema: 2000 }]]), vigentes: new Map([['11', 7777]]),
    costeoConfig: { ...CFG, margenPorProducto: ganancias },
  });
  assert.strictEqual(otra[0].presentaciones[0].precioConIva, 7777);
});

test('propuestaCurva: la ganancia implícita descuenta F (puntos iguales a precios sin F × (1 − F))', () => {
  const filas = Array.from({ length: 30 }, (_, i) => ({ costoBase: 100 + i * 37, costoTotal: 100 + i * 37, precioVigente: (100 + i * 37) * 2.2, ivaPct: 21 }));
  const sinF = pc.propuestaCurva('almacen', filas, { gastosPct: 10 });
  const conF = pc.propuestaCurva('almacen', filas.map(f => ({ ...f, precioVigente: f.precioVigente / (1 - 0.0579), finalPct: 5.79 })), { gastosPct: 10 });
  assert.ok(Math.abs(sinF.a - conF.a) < 0.01 && Math.abs(sinF.b - conF.b) < 0.01);
});

test('validarConceptosPrecioFinal: 0 ≤ pct < 100, total < 100, máx 40, ids slug', () => {
  assert.deepStrictEqual(pc.validarConceptosPrecioFinal([{ concepto: ' Ingresos brutos ', pct: 5 }, { id: 'impuesto-deb-cred', concepto: 'Déb/créd', pct: 0.79 }]),
    [{ id: 'ingresos-brutos', concepto: 'Ingresos brutos', pct: 5 }, { id: 'impuesto-deb-cred', concepto: 'Déb/créd', pct: 0.79 }]);
  assert.deepStrictEqual(pc.validarConceptosPrecioFinal([]), []);
  for (const bad of [null, [{ concepto: 'x', pct: -1 }], [{ concepto: 'x', pct: 100 }], [{ concepto: 'a', pct: 50 }, { concepto: 'b', pct: 50 }],
    [{ concepto: '', pct: 1 }], [{ concepto: 'x'.repeat(61), pct: 1 }], [{ id: 'A B', concepto: 'x', pct: 1 }],
    Array.from({ length: 41 }, (_, i) => ({ concepto: `c${i}`, pct: 1 }))]) {
    assert.throws(() => pc.validarConceptosPrecioFinal(bad), /conceptosPrecioFinal/, JSON.stringify(bad).slice(0, 40));
  }
  assert.deepStrictEqual(pc.conceptosPrecioFinalDe({}), []);
});

test('migrarConceptosPrecioFinal: mueve IIBB y débitos/créditos de gastosVenta, sin reescalar; idempotente; no muta', () => {
  const costeo = {
    gastosVenta: [{ id: 'tarjeta', concepto: 'Tarjeta', pct: 3.5, listas: ['sucursal'] },
      { id: 'ingresos-brutos', concepto: 'Ingresos Brutos', pct: 5, listas: ['sucursal'] },
      { id: 'impuesto-deb-cred', concepto: 'Imp. Déb/Créd', pct: 0.79, listas: ['sucursal'] }],
    curvaGanancia: { almacen: { a: 50, b: 3, pisoPct: 10, techoPct: 60 } }, margenPorProducto: { 1: 30 },
  };
  const r = pc.migrarConceptosPrecioFinal(costeo);
  assert.strictEqual(r.movidos, 2);
  assert.deepStrictEqual(r.costeo.gastosVenta, [costeo.gastosVenta[0]]);
  assert.deepStrictEqual(r.costeo.conceptosPrecioFinal, [{ id: 'ingresos-brutos', concepto: 'Ingresos Brutos', pct: 5 },
    { id: 'impuesto-deb-cred', concepto: 'Imp. Déb/Créd', pct: 0.79 }]);
  assert.strictEqual(r.costeo.precioFinalConceptos, pc.PRECIO_FINAL_MIGRADO);
  assert.deepStrictEqual(r.costeo.curvaGanancia, costeo.curvaGanancia); // no reescala
  assert.deepStrictEqual(r.costeo.margenPorProducto, costeo.margenPorProducto);
  assert.strictEqual(costeo.gastosVenta.length, 3); // no muta
  assert.strictEqual(pc.migrarConceptosPrecioFinal(r.costeo), null); // idempotente
  // Sin esos ids: lista vacía, marcador puesto.
  const vacio = pc.migrarConceptosPrecioFinal({ gastosVenta: [costeo.gastosVenta[0]] });
  assert.deepStrictEqual(vacio.costeo.conceptosPrecioFinal, []);
  assert.strictEqual(vacio.movidos, 0);
  assert.deepStrictEqual(pc.migrarConceptosPrecioFinal({}).costeo.gastosVenta, []);
});

test('crear el router migra costeo.json una vez (backup bak-antes-precio-final) y la segunda vez no escribe', () => {
  const crearRutasPrecios = require('../routes/rutas_precios');
  let archivo = { metodoGanancia: 'curva', margenPropio: 'ganancia', curvaGanancia: CFG.curvaGanancia,
    gastosVenta: [{ id: 'ingresos-brutos', concepto: 'IIBB', pct: 5, listas: ['sucursal'] }] };
  const original = archivo;
  const escrituras = [];
  const crear = () => crearRutasPrecios({ apiRoute: fn => fn, query: async () => [], DATA_DIR: '/tmp', LISTA_PRECIOS_VENTA: 1,
    leerJSON: p => (p.endsWith('costeo.json') ? archivo : {}), guardarJSON: (p, d) => { escrituras.push([p, d]); if (p.endsWith('costeo.json')) archivo = d; } });
  crear();
  assert.strictEqual(escrituras.length, 2);
  assert.match(escrituras[0][0], /costeo\.json\.bak-antes-precio-final$/);
  assert.strictEqual(escrituras[0][1], original);
  assert.deepStrictEqual(archivo.gastosVenta, []);
  assert.deepStrictEqual(archivo.conceptosPrecioFinal, [{ id: 'ingresos-brutos', concepto: 'IIBB', pct: 5 }]);
  escrituras.length = 0;
  crear();
  assert.deepStrictEqual(escrituras, []);
});
