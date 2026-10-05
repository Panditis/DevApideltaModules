'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { calcularFilaAlmacen, aplicarMarcados, markupsAlineadosConSiga, armarGruposFraccionado } = require('../routes/rutas_precios');
const { markupParaPrecio, markupDesdeGanancia, gananciaPorCurva } = require('../lib/precios_costeo');

// Curvas de ganancia de prueba. Escalón: `alto` % por debajo de `corte` (costo neto), `bajo` % por encima
// (costos lejos del corte caen exactos en alto/bajo). Plana: g % para cualquier costo.
const curvaEscalon = (corte, alto, bajo) => ({ a: +(1000 * Math.log(corte) + (alto + bajo) / 2).toFixed(6), b: 1000, pisoPct: bajo, techoPct: alto });
const curvaPlana = g => ({ a: g, b: 0, pisoPct: g, techoPct: g });

const CFG_BASE = {
  toleranciaPct: 10,
  metodoGanancia: 'curva',
  curvaGanancia: { almacen: curvaEscalon(1000, 40, 15) }, // 40 % hasta costo neto 1000, 15 % arriba
  margenPorProducto: {},
};

// ── calcularFilaAlmacen ──────────────────────────────────────────────────────
// Pura: sin SQL, sin fs. Cubre lo que listado/detalle arman a partir de las dos
// queries (costo de mercadería + precio vigente) ya resueltas.

// Regla 2026-10-02: costo NETO; precio neto = costo × (1 + markup), + IVA del producto (sin alícuota → 21 % supuesto).
// La curva se busca con el costo NETO base (500 < 1000 → 40 %); la alícuota sólo afecta el IVA.
test('calcularFilaAlmacen: curva por costo neto, + IVA de venta; sugerido muy por encima del vigente → subir', () => {
  const fila = calcularFilaAlmacen({
    plu: '1', nombre: 'Arroz', costoSistema: 500, precioVigente: 500,
    costeoConfig: CFG_BASE,
  });
  // costoTotal = 500, precioNeto = 500*1.4 = 700, + IVA 147 = 847 → 850 (múltiplo de 50)
  assert.strictEqual(fila.costoTotal, 500);
  assert.ok(!Object.hasOwn(fila, 'costoBanda')); // campo eliminado
  assert.strictEqual(fila.markupPct, 40);
  assert.strictEqual(fila.gananciaBanda, 40);
  assert.strictEqual(fila.banda, 'curva');
  assert.strictEqual(fila.precioNeto, 700);
  assert.strictEqual(fila.precioConIvaExacto, 847);
  assert.strictEqual(fila.precioConIva, 850);
  assert.strictEqual(fila.ivaPct, 21); // IVA de venta de la config (default 21)
  assert.strictEqual('ivaSupuesto' in fila, false);
  assert.strictEqual(fila.markupFinalPct, 70); // 850 ÷ 500 − 1
  assert.strictEqual(fila.precioVigente, 500);
  assert.deepStrictEqual(fila.faltantes, []);
  // sugerido (850) 70% por encima del vigente (500): hay que subir el precio
  assert.strictEqual(fila.deltaPct, 70);
  assert.strictEqual(fila.semaforo, 'subir');
});

test('calcularFilaAlmacen: precioVigente alineado con precioConIva da ok', () => {
  const fila = calcularFilaAlmacen({
    plu: '2', nombre: 'Fideos', costoSistema: 500, precioVigente: 850, // sugerido 850
    costeoConfig: CFG_BASE,
  });
  assert.strictEqual(fila.deltaPct, 0);
  assert.strictEqual(fila.semaforo, 'ok');
});

test('calcularFilaAlmacen: margenPorProducto (override) gana sobre la curva por costo', () => {
  const cfg = { ...CFG_BASE, margenPorProducto: { '3': 20 } };
  const fila = calcularFilaAlmacen({
    plu: '3', nombre: 'Yerba', costoSistema: 500, precioVigente: null, costeoConfig: cfg,
  });
  assert.strictEqual(fila.markupPct, 20);
  assert.strictEqual(fila.banda, 'override');
  // el detalle necesita ambos: el override vigente y lo que daría la curva sin él
  assert.strictEqual(fila.markupOverride, 20);
  assert.strictEqual(fila.markupBanda, 40);
});

test('calcularFilaAlmacen: costoPorProducto (costo manual) reemplaza al costo de sistema en el cálculo', () => {
  const cfg = { ...CFG_BASE, costoPorProducto: { '7': 2000 } };
  const fila = calcularFilaAlmacen({
    plu: '7', nombre: 'Miel', costoMercaderia: 500, costoSistema: 600, precioVigente: null, costeoConfig: cfg,
  });
  assert.strictEqual(fila.costoOverride, 2000);
  assert.strictEqual(fila.costoBase, 2000);
  assert.strictEqual(fila.precioUltimaCompra, 500);
  // 2000 (> 1000 neto) → curva 15% → neto 2300 + IVA 483 = 2783 → 2800
  assert.strictEqual(fila.costoTotal, 2000);
  assert.strictEqual(fila.markupPct, 15);
  assert.strictEqual(fila.precioConIva, 2800);
});

test('calcularFilaAlmacen: fuenteCosto "ultimaCompra" usa la última compra y costoOverride es null', () => {
  const cfg = { ...CFG_BASE, fuenteCosto: { '8': 'ultimaCompra' } };
  const fila = calcularFilaAlmacen({
    plu: '8', nombre: 'Te', costoMercaderia: 500, costoSistema: 605, precioVigente: null, costeoConfig: cfg,
  });
  assert.strictEqual(fila.costoFuente, 'ultimaCompra');
  assert.strictEqual(fila.costoOverride, null);
  assert.strictEqual(fila.costoBase, 500);
  assert.strictEqual(fila.precioUltimaCompra, 500);
});

test('calcularFilaAlmacen: costo manual permite precio aunque no haya costo de SIGA ni última compra', () => {
  const cfg = { ...CFG_BASE, costoPorProducto: { '9': 800 } };
  const fila = calcularFilaAlmacen({
    plu: '9', nombre: 'Nuevo', costoMercaderia: null, precioVigente: null, costeoConfig: cfg,
  });
  assert.deepStrictEqual(fila.faltantes, []);
  assert.strictEqual(fila.precioUltimaCompra, null);
  assert.strictEqual(fila.costoBase, 800);
});

test('calcularFilaAlmacen: por defecto usa el costo de SIGA (neto, como lo arma filaCostos)', () => {
  const fila = calcularFilaAlmacen({
    plu: '10', nombre: 'Aceite', costoMercaderia: 500, costoSistema: 605, precioVigente: null, costeoConfig: CFG_BASE,
  });
  assert.strictEqual(fila.costoFuente, 'sistema');
  assert.strictEqual(fila.costoBase, 605);
  assert.strictEqual(fila.costoSistema, 605);
  assert.strictEqual(fila.precioUltimaCompra, 500);
});

test('calcularFilaAlmacen: manual gana sobre última compra y sistema', () => {
  const cfg = { ...CFG_BASE, fuenteCosto: { '11': 'ultimaCompra' }, costoPorProducto: { '11': 700 } };
  const man = calcularFilaAlmacen({
    plu: '11', nombre: 'A', costoMercaderia: 500, costoSistema: 605, precioVigente: null, costeoConfig: cfg,
  });
  assert.strictEqual(man.costoFuente, 'manual');
  assert.strictEqual(man.costoBase, 700);
});

test('calcularFilaAlmacen: fuente "sistema" sin PrecioCosto en SIGA → sin precio (nunca optimista)', () => {
  const fila = calcularFilaAlmacen({
    plu: '12', nombre: 'B', costoMercaderia: 500, costoSistema: null, precioVigente: null, costeoConfig: CFG_BASE,
  });
  assert.strictEqual(fila.costoBase, null);
  assert.strictEqual(fila.precioConIva, null);
  assert.ok(fila.faltantes.length > 0);
});

test('calcularFilaAlmacen: sin override, markupOverride es null y markupBanda es el de la curva', () => {
  const fila = calcularFilaAlmacen({
    plu: '6', nombre: 'Aceite', costoSistema: 500, precioVigente: null, costeoConfig: CFG_BASE,
  });
  assert.strictEqual(fila.markupOverride, null);
  assert.strictEqual(fila.markupBanda, 40);
});

test('calcularFilaAlmacen: sin costoMercaderia no hay precio optimista — precios null y faltantes marcado', () => {
  const fila = calcularFilaAlmacen({
    plu: '4', nombre: 'Sin costo', costoMercaderia: null, precioVigente: 1000, costeoConfig: CFG_BASE,
  });
  // Sin costo la curva tampoco da ganancia: también falta markupPct (con bandas sólo faltaba el costo).
  assert.deepStrictEqual(fila.faltantes, ['costoMercaderia']); // sin costo la curva no da margen: el faltante es sólo el costo
  assert.strictEqual(fila.precioNeto, null);
  assert.strictEqual(fila.precioConIva, null);
  // sin precio sugerido no hay contra qué comparar
  assert.strictEqual(fila.deltaPct, null);
  assert.strictEqual(fila.semaforo, null);
});

test('calcularFilaAlmacen: sin precioVigente (producto sin precio de mostrador) no rompe, delta/semaforo null', () => {
  const fila = calcularFilaAlmacen({
    plu: '5', nombre: 'Nuevo', costoSistema: 500, precioVigente: null, costeoConfig: CFG_BASE,
  });
  assert.strictEqual(fila.precioVigente, null);
  assert.strictEqual(fila.deltaPct, null);
  assert.strictEqual(fila.semaforo, null);
  // el costeo en sí no se ve afectado por la falta de precio vigente (847 → 850)
  assert.strictEqual(fila.precioConIva, 850);
});

test('calcularFilaAlmacen: diferencia negativa fuera de tolerancia → bajar; dentro → ok', () => {
  // sugerido 850 (847 → 850); vigente 1000: (850 − 1000) / 1000 = −15 %
  const bajar = calcularFilaAlmacen({ plu: '13', nombre: 'C', costoSistema: 500, precioVigente: 1000, costeoConfig: CFG_BASE });
  assert.strictEqual(bajar.deltaPct, -15);
  assert.strictEqual(bajar.semaforo, 'bajar');
  const ok = calcularFilaAlmacen({ plu: '13', nombre: 'C', costoSistema: 500, precioVigente: 1000, costeoConfig: { ...CFG_BASE, toleranciaPct: 15 } });
  assert.strictEqual(ok.semaforo, 'ok');
});

// ── aplicarMarcados ──────────────────────────────────────────────────────────
test('aplicarMarcados: agrega con fecha, quita, es idempotente y no muta la entrada', () => {
  const orig = { '1': '2026-09-01' };
  const agregado = aplicarMarcados(orig, ['2', '3'], true, '2026-09-23');
  assert.deepStrictEqual(agregado, { '1': '2026-09-01', '2': '2026-09-23', '3': '2026-09-23' });
  assert.deepStrictEqual(orig, { '1': '2026-09-01' });
  // re-marcar conserva la fecha original
  assert.deepStrictEqual(aplicarMarcados(agregado, ['1'], true, '2026-09-30'), agregado);
  const quitado = aplicarMarcados(agregado, ['1', '9'], false, '2026-09-23');
  assert.deepStrictEqual(quitado, { '2': '2026-09-23', '3': '2026-09-23' });
  assert.deepStrictEqual(aplicarMarcados(undefined, ['5'], true, 'x'), { '5': 'x' });
});

// ── Alineación con SIGA ──────────────────────────────────────────────────────
test('calcularFilaAlmacen: markup alineado respeta el vigente aunque no sea múltiplo de 50; si sube el costo, redondea y pide subir', () => {
  const markup = markupParaPrecio(1000, 2470); // costoTotal = costo base 1000
  const cfg = { ...CFG_BASE, margenPorProducto: { '20': markup } };
  const alineado = calcularFilaAlmacen({ plu: '20', nombre: 'A', costoSistema: 1000, precioVigente: 2470, costeoConfig: cfg });
  assert.strictEqual(alineado.precioConIva, 2470);
  assert.strictEqual(alineado.deltaPct, 0);
  assert.strictEqual(alineado.semaforo, 'ok');
  const subio = calcularFilaAlmacen({ plu: '20', nombre: 'A', costoSistema: 1100, precioVigente: 2470, costeoConfig: { ...cfg, toleranciaPct: 0 } });
  assert.strictEqual(subio.precioConIva % 50, 0);
  assert.strictEqual(subio.semaforo, 'subir');
});

test('markupsAlineadosConSiga: ganancia propia por plu (con los gastos de su tipo), cuenta sin datos y negativos', () => {
  const r = markupsAlineadosConSiga([
    { plu: '1', costoTotal: 1000, precioVigente: 1452 },
    { plu: '2', costoTotal: 1000, precioVigente: 900 },
    { plu: '3', costoTotal: null, precioVigente: 500 },
    { plu: '4', costoTotal: 500, precioVigente: null },
    { plu: '5', costoTotal: 500, precioVigente: 0 },
    { plu: '6', costoTotal: 1000, precioVigente: 1452, gastosVentaPct: 25 },
    { plu: '7', costoTotal: 1000, precioVigente: 1452, gastosVentaPct: null }, // falta venta base → sin datos
  ]);
  assert.deepStrictEqual(Object.keys(r.ganancias), ['1', '2', '6']);
  assert.strictEqual(r.ganancias['1'], 20); // 1452 ÷ 1,21 ÷ 1000 − 1 (sin gastos); '2': 900 ÷ 1,21 ÷ 1000 − 1 < 0
  assert.ok(r.ganancias['2'] < 0);
  assert.strictEqual(r.ganancias['6'], -10); // markup 20 % con G 25 % → 1,2 × 0,75 − 1
  assert.strictEqual(r.alineados, 3);
  assert.strictEqual(r.sinDatos, 4);
  assert.strictEqual(r.negativos, 1);
});

// ── armarGruposFraccionado ───────────────────────────────────────────────────

const GRANELES = [
  { plu: '4409', nombre: 'Sem. Lino Granel' },
  { plu: '5000', nombre: 'Garrapiñadas Granel' },
  { plu: '6000', nombre: 'Anís Granel' }, // sin presentaciones
];
const PRESENTACIONES = [
  { plu: '11', nombre: 'Sem. Lino 500G' },
  { plu: '12', nombre: 'Sem. Lino 1Kg' },
  { plu: '21', nombre: 'Garrapiñadas 150G' },
  { plu: '31', nombre: 'Huérfano 100G' },          // sin fórmula
  { plu: '41', nombre: 'Granel Fantasma 200G' },   // granel inexistente
];
const FORMULAS = { 11: { granel: 4409 }, 12: { granel: 4409 }, 21: { granel: 5000 }, 41: { granel: 99999 } };
// Mismo shape que el universo Almacén (costoMercaderia = última compra neta; costoSistema neto).
const COSTOS = new Map([
  ['4409', { nombre: 'Sem. Lino Granel', costoMercaderia: 2500, costoSistema: 2297, costoSistemaConIva: 2297,
    ivaCompraPct: 21, ivaCompraSupuesto: false, proveedor: 'Prov', fechaUltimaCompra: '2026-09-01', ingresoHoy: true }],
  ['5000', { nombre: 'Garrapiñadas Granel', costoMercaderia: null, costoSistema: null, costoSistemaConIva: null,
    ivaCompraPct: 21, ivaCompraSupuesto: true, proveedor: null, fechaUltimaCompra: null, ingresoHoy: false }],
]);

// Curva Fraccionado: plana 60.3 + ajuste por tramo de peso (reproduce la fila 1 de la matriz vieja:
// 100G 84.35, 200G 76.33, 400/500G 68.32, 1KG 60.3, 5KG 53.89, 10KG 50.68).
const TRAMOS_G = [100, 200, 400, 500, 1000, 5000, 10000];
const CURVA_FRAC = { ...curvaPlana(60.3), ajustesPeso: { tramosG: TRAMOS_G, puntos: [24.05, 16.03, 8.02, 8.02, 0, -6.41, -9.62] } };
const CFG_FRAC = { toleranciaPct: 10, metodoGanancia: 'curva', curvaGanancia: { fraccionado: CURVA_FRAC } };

function armar(extra = {}) {
  return armarGruposFraccionado({
    graneles: GRANELES, presentaciones: PRESENTACIONES, formulas: FORMULAS, costos: COSTOS,
    // 11: vigente = final exacto de 500G (2297 × 1,6832 = 3866.31 + IVA 21 % = 4678.24) → alineado.
    vigentes: new Map([['11', 4678], ['12', 3000]]),
    costeoConfig: { ...CFG_FRAC, margenPorProducto: {}, ...extra },
  });
}
const grupo = (gs, plu) => gs.find(g => g.granelPlu === plu);

test('armarGruposFraccionado: agrupa presentaciones por granel; graneles sin presentaciones van vacíos', () => {
  const gs = armar();
  const lino = grupo(gs, '4409');
  assert.deepStrictEqual(lino.presentaciones.map(p => p.plu), ['11', '12']);
  assert.strictEqual(lino.costoBase, 2297);
  assert.strictEqual(lino.costoFuente, 'sistema');
  assert.strictEqual(lino.proveedor, 'Prov');
  assert.ok(!Object.hasOwn(lino, 'banda')); // la fila de matriz ya no existe
  assert.ok(!Object.hasOwn(lino, 'costoBanda'));
  assert.deepStrictEqual(grupo(gs, '6000').presentaciones, []);
  assert.deepStrictEqual(grupo(gs, '5000').presentaciones.map(p => p.plu), ['21']);
});

test('armarGruposFraccionado: sin fórmula o granel inexistente → grupo "Sin granel asignado" al final, faltante granel', () => {
  const gs = armar();
  const sin = gs[gs.length - 1];
  assert.strictEqual(sin.granelPlu, null);
  assert.strictEqual(sin.granelNombre, 'Sin granel asignado');
  assert.deepStrictEqual(sin.presentaciones.map(p => p.plu), ['31', '41']);
  for (const p of sin.presentaciones) {
    assert.deepStrictEqual(p.faltantes, ['granel']);
    assert.strictEqual(p.precioConIva, null);
  }
});

test('armarGruposFraccionado: margen standard por curva + ajuste por peso y precio por kg; alineado exacto respeta el vigente', () => {
  const [p500, p1k] = grupo(armar(), '4409').presentaciones;
  assert.strictEqual(p500.pesoG, 500);
  assert.strictEqual(p500.presentacion, '500G');
  assert.strictEqual(p500.markupStd, 68.32);
  assert.strictEqual(p500.markupOverride, null);
  assert.strictEqual(p500.markupPct, 68.32);
  assert.strictEqual(p500.precioNeto, 3866.31);
  assert.strictEqual(p500.precioConIva, 4678); // |4678.24 − 4678| < 0,5 → respeta el vigente
  assert.strictEqual(p500.markupFinalPct, 103.66); // 4678 ÷ 2297 − 1 (sobre el vigente respetado)
  assert.strictEqual(p500.ivaPct, 21); // IVA de venta de la config (default 21)
  assert.strictEqual(p500.precioVigente, 4678);
  assert.strictEqual(p500.semaforo, 'ok');
  assert.strictEqual(p1k.presentacion, '1KG');
  assert.strictEqual(p1k.markupStd, 60.3);
  assert.strictEqual(p1k.precioConIva, 4450); // 2297 × 1.603 = 3682.09 + IVA 773.24 = 4455.33 → 4450
  assert.strictEqual(p1k.semaforo, 'subir');   // vigente 3000
});

test('armarGruposFraccionado: override por presentación pisa el standard; curva propia de costeo.json', () => {
  const [p500] = grupo(armar({ margenPorProducto: { 11: 100 } }), '4409').presentaciones;
  assert.strictEqual(p500.markupStd, 68.32);
  assert.strictEqual(p500.markupOverride, 100);
  assert.strictEqual(p500.markupPct, 100);
  assert.strictEqual(p500.precioNeto, 4594);
  assert.strictEqual(p500.semaforo, 'subir');
  const [q] = grupo(armar({ curvaGanancia: { fraccionado: curvaPlana(10) } }), '4409').presentaciones;
  assert.strictEqual(q.markupStd, 10);
});

test('armarGruposFraccionado: granel sin costo → faltante costoGranel, sin precio ni margen standard', () => {
  const [p] = grupo(armar(), '5000').presentaciones;
  assert.deepStrictEqual(p.faltantes, ['costoGranel']);
  assert.strictEqual(p.markupStd, null);
  assert.strictEqual(p.precioConIva, null);
  assert.strictEqual(p.semaforo, null);
});

test('armarGruposFraccionado: costo del granel se elige igual que Almacén (sistema → ultimaCompra → manual por PLU del granel)', () => {
  const lino = grupo(armar(), '4409');
  assert.strictEqual(lino.costoBase, 2297);
  assert.strictEqual(lino.costoFuente, 'sistema');
  assert.strictEqual(lino.costoOverride, null);
  assert.strictEqual(lino.costoSistema, 2297);
  assert.strictEqual(lino.costoSistemaConIva, 2297);
  assert.strictEqual(lino.ivaCompraPct, 21);
  assert.strictEqual(lino.ivaCompraSupuesto, false);
  assert.strictEqual(lino.precioUltimaCompra, 2500);
  assert.strictEqual(lino.fechaUltimaCompra, '2026-09-01');
  assert.strictEqual(lino.ingresoHoy, true);

  const uc = grupo(armar({ fuenteCosto: { 4409: 'ultimaCompra' } }), '4409');
  assert.strictEqual(uc.costoBase, 2500);
  assert.strictEqual(uc.costoFuente, 'ultimaCompra');
  assert.strictEqual(uc.presentaciones[1].precioNeto, 4007.5); // 2500 × 1.603

  const man = grupo(armar({ fuenteCosto: { 4409: 'ultimaCompra' }, costoPorProducto: { 4409: 1000 } }), '4409');
  assert.strictEqual(man.costoBase, 1000);
  assert.strictEqual(man.costoFuente, 'manual');
  assert.strictEqual(man.costoOverride, 1000);
  assert.strictEqual(man.presentaciones[1].markupStd, 60.3); // curva plana, tramo 1KG
  assert.strictEqual(man.presentaciones[1].precioNeto, 1603);
});

test('armarGruposFraccionado: costo manual de un granel sin costos en SIGA habilita precio', () => {
  const g = grupo(armar({ costoPorProducto: { 5000: 12000 } }), '5000');
  assert.strictEqual(g.costoBase, 12000);
  assert.deepStrictEqual(g.presentaciones[0].faltantes, []);
  assert.strictEqual(g.presentaciones[0].markupStd, 76.33); // Garrapiñadas 150G → tramo 200: 60.3 + 16.03
});

test('armarGruposFraccionado: presentaciones traen marcado desde marcadosExportar', () => {
  const gs = armar({ marcadosExportar: { 11: '2026-09-24', 4409: '2026-09-24' } });
  const [p500, p1k] = grupo(gs, '4409').presentaciones;
  assert.strictEqual(p500.marcado, true);
  assert.strictEqual(p1k.marcado, false);
  assert.strictEqual(grupo(armar(), '4409').presentaciones[0].marcado, false);
});

// ── Costos extra por granel (costosExtraFraccionado) ─────────────────────────
const EXTRAS_LINO = { 4409: [{ concepto: 'Envase', tipo: 'kg', valor: 100 }, { concepto: 'Merma', tipo: 'pct', valor: 10 }] };

test('armarGruposFraccionado: sin costos extra → costoTotal = costoBase, extras vacíos', () => {
  const lino = grupo(armar(), '4409');
  assert.deepStrictEqual(lino.costosExtra, []);
  assert.strictEqual(lino.costoExtraTotal, 0);
  assert.strictEqual(lino.costoTotal, 2297);
});

test('armarGruposFraccionado: costos extra ($/kg + % sobre el costo base) suben el costo total y las presentaciones se costean sobre él', () => {
  const lino = grupo(armar({ costosExtraFraccionado: EXTRAS_LINO }), '4409');
  assert.deepStrictEqual(lino.costosExtra, EXTRAS_LINO[4409]);
  assert.strictEqual(lino.costoBase, 2297);
  assert.strictEqual(lino.costoExtraTotal, 329.7); // 100 + 10% de 2297
  assert.strictEqual(lino.costoTotal, 2626.7);
  const p1k = lino.presentaciones[1];
  assert.strictEqual(p1k.markupStd, 60.3);
  assert.strictEqual(p1k.precioNeto, 4210.6);   // 2626.7 × 1.603
  assert.strictEqual(p1k.precioConIva, 5100);   // 4210.6 + IVA 884.23 = 5094.83 → 5100
  // otros graneles no se ven afectados
  assert.strictEqual(grupo(armar({ costosExtraFraccionado: EXTRAS_LINO }), '6000').costoTotal, null);
});

test('armarGruposFraccionado: la curva del margen standard se busca con el costo base neto, no con base + extras', () => {
  const lino = grupo(armar({
    curvaGanancia: { fraccionado: curvaEscalon(9000, 60.3, 50) }, // 60.3 % hasta 9000 neto, 50 % arriba
    costoPorProducto: { 4409: 8000 }, costosExtraFraccionado: { 4409: [{ concepto: 'E', tipo: 'kg', valor: 2200 }] },
  }), '4409');
  assert.strictEqual(lino.costoTotal, 10200);
  assert.strictEqual(lino.costoBase, 8000);
  assert.strictEqual(lino.presentaciones[1].markupStd, 60.3); // 8000 < 9000, aunque el total (10200) pase el corte
  assert.strictEqual(lino.presentaciones[1].precioNeto, 16350.6);
});

test('armarGruposFraccionado: granel sin costo base con extras → costoTotal null y faltante costoGranel', () => {
  const g = grupo(armar({ costosExtraFraccionado: { 5000: [{ concepto: 'E', tipo: 'kg', valor: 200 }] } }), '5000');
  assert.strictEqual(g.costoTotal, null);
  assert.strictEqual(g.costoExtraTotal, null);
  assert.deepStrictEqual(g.presentaciones[0].faltantes, ['costoGranel']);
  assert.strictEqual(g.presentaciones[0].precioConIva, null);
});

// ── Costos extra Almacén (misma clave costosExtraFraccionado, por PLU del producto) ──
test('calcularFilaAlmacen: costos extra del producto suman al costoTotal; la curva sigue por costoBase', () => {
  const extras = [{ concepto: 'Flete', tipo: 'kg', valor: 35 }, { concepto: 'Merma', tipo: 'pct', valor: 10 }];
  const fila = calcularFilaAlmacen({
    plu: '1', nombre: 'Arroz', costoSistema: 500, precioVigente: 500,
    costeoConfig: { ...CFG_BASE, costosExtraFraccionado: { 1: extras } },
  });
  // 500 + flete 35 + merma 50 = 585
  assert.strictEqual(fila.costoTotal, 585);
  assert.strictEqual(fila.costoExtraTotal, 85);
  assert.deepStrictEqual(fila.costosExtra, extras);
  assert.strictEqual(fila.markupPct, 40);
  assert.strictEqual(fila.precioNeto, 819);
  assert.deepStrictEqual(fila.componentes.slice(1), [
    { concepto: 'Flete', detalle: '$', importe: 35 },
    { concepto: 'Merma', detalle: '10%', importe: 50 },
  ]);
  // costoBase 800 + 300 de extra supera el corte 1000, pero la curva se busca por costoBase (40 %)
  const alta = calcularFilaAlmacen({
    plu: '2', nombre: 'X', costoSistema: 800, precioVigente: null,
    costeoConfig: { ...CFG_BASE, costosExtraFraccionado: { 2: [{ concepto: 'E', tipo: 'kg', valor: 300 }] } },
  });
  assert.strictEqual(alta.banda, 'curva');
  assert.strictEqual(alta.gananciaBanda, 40);
  assert.strictEqual(alta.costoTotal, 1100);
});

test('calcularFilaAlmacen: sin costos extra → costosExtra [] y costoExtraTotal 0; sin costo → null', () => {
  const fila = calcularFilaAlmacen({ plu: '1', nombre: 'A', costoSistema: 500, precioVigente: null, costeoConfig: CFG_BASE });
  assert.deepStrictEqual(fila.costosExtra, []);
  assert.strictEqual(fila.costoExtraTotal, 0);
  const sin = calcularFilaAlmacen({ plu: '1', nombre: 'A', costoSistema: null, precioVigente: null, costeoConfig: { ...CFG_BASE, costosExtraFraccionado: { 1: [{ concepto: 'E', tipo: 'kg', valor: 1 }] } } });
  assert.strictEqual(sin.costoExtraTotal, null);
});

test('alinear con SIGA en Almacén usa costoTotal con extras', () => {
  const fila = calcularFilaAlmacen({
    plu: '1', nombre: 'A', costoSistema: 500, precioVigente: 1000,
    costeoConfig: { ...CFG_BASE, costosExtraFraccionado: { 1: [{ concepto: 'E', tipo: 'kg', valor: 85 }] } },
  });
  const { ganancias } = markupsAlineadosConSiga([fila]);
  assert.strictEqual(ganancias['1'], markupParaPrecio(585, 1000)); // sin gastos: ganancia = markup
});

// ── Presentaciones temporales ────────────────────────────────────────────────
test('armarGruposFraccionado: temporales calculadas como una presentación real, sin vigente ni marcado', () => {
  const gs = armar({ presentacionesTemporales: { 4409: [
    { id: 't-b', pesoG: 1000, gananciaPct: 100, nombre: 'Bolsa grande' },
    { id: 't-a', pesoG: 500, gananciaPct: null },
  ] } });
  const lino = grupo(gs, '4409');
  assert.deepStrictEqual(lino.presentaciones.map(p => p.plu), ['11', '12']); // reales intactas
  const [t500, t1k] = lino.temporales;
  assert.strictEqual(t500.id, 't-a');
  assert.strictEqual(t500.temporal, true);
  assert.strictEqual(t500.presentacion, '500G');
  assert.strictEqual(t500.nombre, null);
  assert.strictEqual(t500.markupStd, 68.32);
  assert.strictEqual(t500.markupOverride, null);
  assert.strictEqual(t500.precioNeto, 3866.31); // igual que la real de 500G (11)
  assert.strictEqual(t500.precioConIva, 4700);  // 3866.31 + IVA = 4678.24 → múltiplo de 50 (no hay vigente que respetar)
  assert.strictEqual(t500.precioVigente, null);
  assert.strictEqual(t500.semaforo, null);
  assert.strictEqual(t500.deltaPct, null);
  assert.strictEqual(t500.marcado, false);
  assert.strictEqual(t1k.nombre, 'Bolsa grande');
  assert.strictEqual(t1k.markupOverride, 100);
  assert.strictEqual(t1k.precioNeto, 4594);
  assert.deepStrictEqual(t1k.faltantes, []);
  // sin temporales: lista vacía (también en el grupo "Sin granel asignado")
  assert.deepStrictEqual(grupo(gs, '6000').temporales, []);
  assert.deepStrictEqual(gs[gs.length - 1].temporales, []);
});

test('armarGruposFraccionado: temporal de un granel sin costo → faltante costoGranel, sin precio', () => {
  const [t] = grupo(armar({ presentacionesTemporales: { 5000: [{ id: 't-x', pesoG: 150, gananciaPct: null }] } }), '5000').temporales;
  assert.deepStrictEqual(t.faltantes, ['costoGranel']);
  assert.strictEqual(t.precioConIva, null);
  assert.strictEqual(t.markupStd, null);
});

test('alinear con SIGA / exportación: las temporales no entran (sólo presentaciones reales)', () => {
  const gs = armar({ presentacionesTemporales: { 4409: [{ id: 't-a', pesoG: 500, gananciaPct: null }] } });
  const filas = gs.flatMap(g => g.presentaciones.map(p => ({ plu: p.plu, costoTotal: g.costoTotal, precioVigente: p.precioVigente })));
  assert.ok(!filas.some(f => f.plu == null));
  assert.ok(!markupsAlineadosConSiga(filas).ganancias[undefined]);
});

test('aplicarTemporal: crear / editar / borrar sin mutar el mapa; límites y errores', () => {
  const { aplicarTemporal, TEMPORALES_MAX } = require('../routes/rutas_precios');
  const base = { 4409: [{ id: 't-1', pesoG: 250, gananciaPct: null }] };
  const c = aplicarTemporal(base, '4409', { op: 'crear', id: 't-2', datos: { pesoG: 500, gananciaPct: 40 } });
  assert.deepStrictEqual(c.item, { id: 't-2', pesoG: 500, gananciaPct: 40 });
  assert.strictEqual(c.mapa['4409'].length, 2);
  assert.strictEqual(base['4409'].length, 1); // no muta
  const n = aplicarTemporal({}, '77', { op: 'crear', id: 't-9', datos: { pesoG: 30, gananciaPct: null, nombre: 'Muestra' } });
  assert.deepStrictEqual(n.mapa, { 77: [{ id: 't-9', pesoG: 30, gananciaPct: null, nombre: 'Muestra' }] });

  const e = aplicarTemporal(c.mapa, '4409', { op: 'editar', id: 't-2', datos: { gananciaPct: null, nombre: 'X' } });
  assert.deepStrictEqual(e.item, { id: 't-2', pesoG: 500, gananciaPct: null, nombre: 'X' });
  const sinNombre = aplicarTemporal(e.mapa, '4409', { op: 'editar', id: 't-2', datos: { nombre: null } });
  assert.deepStrictEqual(sinNombre.item, { id: 't-2', pesoG: 500, gananciaPct: null });
  assert.strictEqual(e.mapa['4409'][1].nombre, 'X'); // no muta

  const b = aplicarTemporal(base, '4409', { op: 'borrar', id: 't-1' });
  assert.deepStrictEqual(b.mapa, {}); // la última borra la entrada del granel

  assert.match(aplicarTemporal(base, '4409', { op: 'editar', id: 't-nope', datos: { pesoG: 1 } }).error, /no encontrada/);
  assert.match(aplicarTemporal(base, '1', { op: 'borrar', id: 't-1' }).error, /no encontrada/);
  const lleno = { 1: Array.from({ length: TEMPORALES_MAX }, (_, i) => ({ id: 't-' + i, pesoG: 100, gananciaPct: null })) };
  assert.match(aplicarTemporal(lleno, '1', { op: 'crear', id: 't-z', datos: { pesoG: 1, gananciaPct: null } }).error, /máximo 30/);
});

test('endpoints presentaciones-temporales: POST crea (id del server), PUT edita, DELETE borra; validan PLU/id/body', async () => {
  const crearRutasPrecios = require('../routes/rutas_precios');
  let archivo = { metodoGanancia: 'curva', presentacionesTemporales: {}, margenPorProducto: { 11: 5 } };
  const router = crearRutasPrecios({
    apiRoute: fn => async (req, res) => res.json(await fn(req)),
    query: async () => [], leerJSON: () => archivo, guardarJSON: (_p, d) => { archivo = d; },
    DATA_DIR: '/tmp', LISTA_PRECIOS_VENTA: 1,
  });
  const llamar = (method, ruta, body) => {
    const layer = router.stack.find(l => l.route && l.route.methods[method] && l.match(ruta));
    return new Promise(resolve => layer.route.stack[0].handle({ params: layer.params, body, query: {} }, { json: resolve }));
  };
  const c = await llamar('post', '/api/precios/presentaciones-temporales/4409', { pesoG: 250, gananciaPct: null, nombre: 'Prueba' });
  assert.match(c.temporal.id, /^t-[a-z0-9]+$/);
  assert.deepStrictEqual(archivo.presentacionesTemporales['4409'], [c.temporal]);
  assert.deepStrictEqual(archivo.margenPorProducto, { 11: 5 }); // no toca otras claves
  const id = c.temporal.id;
  const e = await llamar('put', `/api/precios/presentaciones-temporales/4409/${id}`, { gananciaPct: 42, nombre: '' });
  assert.deepStrictEqual(e.temporal, { id, pesoG: 250, gananciaPct: 42 });
  assert.match((await llamar('put', `/api/precios/presentaciones-temporales/4409/${id}`, { pesoG: 0 })).error, /pesoG/);
  assert.match((await llamar('post', '/api/precios/presentaciones-temporales/4409', {})).error, /pesoG/);
  assert.match((await llamar('post', '/api/precios/presentaciones-temporales/a%20b', { pesoG: 1 })).error, /PLU inválido/);
  assert.match((await llamar('delete', '/api/precios/presentaciones-temporales/4409/..%2Fx', {})).error, /id/);
  const b = await llamar('delete', `/api/precios/presentaciones-temporales/4409/${id}`, {});
  assert.deepStrictEqual(b.temporales, []);
  assert.deepStrictEqual(archivo.presentacionesTemporales, {});
});

// ── Pack / Bulto enganchado en los listados (Fase 4) ─────────────────────────

test('armarGruposFraccionado: cada presentación trae packBulto calculado sobre su precioConIva (por kg)', () => {
  const llamadas = [];
  const packBultoDe = (plu, precio) => { llamadas.push([plu, precio]); return plu === '11' ? [{ plu: '91011', precioSugerido: 1 }] : []; };
  const gs = armarGruposFraccionado({
    graneles: GRANELES, presentaciones: PRESENTACIONES, formulas: FORMULAS, costos: COSTOS,
    vigentes: new Map(), costeoConfig: { toleranciaPct: 10 }, packBultoDe,
  });
  const lino = grupo(gs, '4409');
  assert.deepStrictEqual(lino.presentaciones[0].packBulto, [{ plu: '91011', precioSugerido: 1 }]);
  assert.deepStrictEqual(lino.presentaciones[1].packBulto, []);
  assert.deepStrictEqual(llamadas.find(([plu]) => plu === '11'), ['11', lino.presentaciones.find(p => p.plu === '11').precioConIva]);
  // Sin packBultoDe (tests viejos / otros usos) queda [].
  assert.deepStrictEqual(grupo(armar(), '4409').presentaciones[0].packBulto, []);
});

test('armarGruposFraccionado: el grupo del granel trae packBultoGranel (packBultoDe(granelPlu, null)); sin granel → []', () => {
  const llamadas = [];
  const packBultoDe = (plu, precio) => { llamadas.push([plu, precio]); return plu === '4409' ? [{ plu: '95000', granel: true, precioSugerido: null }] : []; };
  const gs = armarGruposFraccionado({
    graneles: GRANELES, presentaciones: PRESENTACIONES, formulas: FORMULAS, costos: COSTOS,
    vigentes: new Map(), costeoConfig: { toleranciaPct: 10 }, packBultoDe,
  });
  assert.deepStrictEqual(grupo(gs, '4409').packBultoGranel, [{ plu: '95000', granel: true, precioSugerido: null }]);
  assert.deepStrictEqual(llamadas.find(([plu]) => plu === '4409'), ['4409', null]);
  assert.deepStrictEqual(grupo(gs, null).packBultoGranel, []);
  assert.deepStrictEqual(grupo(armar(), '4409').packBultoGranel, []);
});

test('listado Almacén: una sola query de vínculos; sub-filas pack/bulto sobre el sugerido del base', async () => {
  const crearRutasPrecios = require('../routes/rutas_precios');
  const sqls = [];
  const query = async (sql) => {
    sqls.push(sql);
    if (sql.includes('Almacen Bultos/Cajas')) {
      return [{ plu: '91031', nombre: 'PEPAS PACK', basePlu: '6051', cantidad: 3 }, { plu: '91449', nombre: 'PEPAS BULTO', basePlu: '6051', cantidad: 12 }];
    }
    if (sql.includes('ProductosSucursalesPrecios')) return [{ IdProducto: '6051', Precio: 2995 }, { IdProducto: '91031', Precio: 2855 }];
    if (sql.includes('HistorialPrecios')) return [{ IdProducto: '6051 ', Fecha: '2026-03-15' }, { IdProducto: '91031', Fecha: '2026-09-01' }];
    if (sql.includes("NombreRubro = 'Almacen'")) return [{ IdProducto: '6051', NombreProducto: 'PEPAS', CostoSistema: 1210, IvaCompraPct: 21 }];
    return [];
  };
  const router = crearRutasPrecios({
    apiRoute: fn => async (req, res) => res.json(await fn(req)), query,
    leerJSON: () => ({ toleranciaPct: 10, metodoGanancia: 'curva', curvaGanancia: { almacen: curvaPlana(100) }, packBulto: { descBultoPct: 20 } }),
    guardarJSON: () => {}, DATA_DIR: '/tmp', LISTA_PRECIOS_VENTA: 1,
    FORMULA_ACTIVA_SQL: '1=1', SIN_FORMULA_GENERICO_SQL: '1=1',
  });
  const layer = router.stack.find(l => l.route && l.route.methods.get && l.match('/api/precios/listado'));
  const filas = await new Promise(ok => layer.route.stack[0].handle({ params: {}, query: { tipo: 'almacen' } }, { json: ok }));
  assert.strictEqual(filas.length, 1);
  assert.strictEqual(filas[0].precioConIva, 2400); // PrecioCosto tal cual: 1210 × 2 = 2420 → 2400
  assert.deepStrictEqual(filas[0].packBulto.map(p => [p.plu, p.tipo, p.descPct, p.precioSugerido, p.precioVigente]), [
    ['91031', 'pack', 9.7, 2150, 2855], // 2400 × 0,903 = 2167,2 → 2150
    ['91449', 'bulto', 20, 1900, null], // 2400 × 0,8 = 1920 → 1900
  ]);
  assert.strictEqual(sqls.filter(s => s.includes('Almacen Bultos/Cajas')).length, 1);
  // Fecha del último cambio REAL de PrecioVenta (misma sucursal/lista que el vigente), una sola query.
  assert.strictEqual(filas[0].fechaPrecio, '2026-03-15');
  assert.deepStrictEqual(filas[0].packBulto.map(p => p.fechaPrecio), ['2026-09-01', null]);
  const hist = sqls.filter(s => s.includes('HistorialPrecios'));
  assert.strictEqual(hist.length, 1);
  assert.match(hist[0], /LAG\(PrecioVenta\) OVER \(PARTITION BY IdProducto ORDER BY FechaHora, IdHistorialPrecios\)/);
  assert.match(hist[0], /IdSucursal = 1 AND IdListaPrecios = 1 AND PrecioVenta IS NOT NULL/);
  assert.match(hist[0], /Anterior IS NULL OR PrecioVenta <> Anterior/);
});

test('armarGruposFraccionado: cada presentación trae la fecha de su último cambio de precio (null si no hay historial)', () => {
  const gs = armarGruposFraccionado({
    graneles: GRANELES, presentaciones: PRESENTACIONES, formulas: FORMULAS, costos: COSTOS,
    vigentes: new Map(), fechas: new Map([['11', '2026-01-20']]), costeoConfig: { toleranciaPct: 10 },
  });
  assert.deepStrictEqual(grupo(gs, '4409').presentaciones.map(p => [p.plu, p.fechaPrecio]), [['11', '2026-01-20'], ['12', null]]);
  // Sin mapa de fechas (llamadas viejas) → null.
  assert.strictEqual(grupo(armar(), '4409').presentaciones[0].fechaPrecio, null);
});

test('armarGruposFraccionado: las presentaciones piden sus pack/bulto como pesables (modo de venta kg/paquete)', () => {
  const opciones = [];
  const packBultoDe = (plu, precio, opts) => { opciones.push([plu, opts]); return []; };
  armarGruposFraccionado({
    graneles: GRANELES, presentaciones: PRESENTACIONES, formulas: FORMULAS, costos: COSTOS,
    vigentes: new Map(), costeoConfig: { toleranciaPct: 10 }, packBultoDe,
  });
  assert.deepStrictEqual(opciones.find(([plu]) => plu === '11'), ['11', { pesable: true }]);
});

// ── Compra cargada hoy vs. la anterior (aviso en la fila de "Ingreso hoy") ─────

test('listado Almacén: compraHoy sale de UNA query agregada (comprobante de hoy vs anterior, valorizados) con tendencia por tolerancia', async () => {
  const crearRutasPrecios = require('../routes/rutas_precios');
  const sqls = [];
  const query = async (sql) => {
    sqls.push(sql);
    if (sql.includes('WITH hoy')) {
      return [
        // factura hoy: neto 1210 (sin sumar IVA); anterior por cotización: neto 1100 → Δ = 110 / 1100 = +10 %
        { IdProducto: '6051', PrecioNeto: 1210, PorcentajeIVA: 21, Tipo: 'FACTCOM', Proveedor: 'Prov SA', Letra: 'A',
          CentroEmisor: 3, NumeroComprobante: 12345,
          PrecioNetoAnterior: 1100, PorcentajeIVAAnterior: 21, TipoAnterior: 'COTIZACIONCOM', FechaAnterior: '2026-09-12' },
        // cotización hoy (ahora entra): 500 tal cual, sin anterior
        { IdProducto: '7000 ', PrecioNeto: 500, PorcentajeIVA: 21, Tipo: 'COTIZACIONCOM', Proveedor: null, Letra: 'B',
          CentroEmisor: 1, NumeroComprobante: 9, PrecioNetoAnterior: null, FechaAnterior: null },
      ];
    }
    if (sql.includes("NombreRubro = 'Almacen'")) {
      return [
        { IdProducto: '6051', NombreProducto: 'PEPAS', CostoSistema: 1210, IvaCompraPct: 21, IngresoHoy: 1 },
        { IdProducto: '7000', NombreProducto: 'NUEVO', CostoSistema: 1210, IvaCompraPct: 21, IngresoHoy: 1 },
        { IdProducto: '8000', NombreProducto: 'VIEJO', CostoSistema: 1210, IvaCompraPct: 21, IngresoHoy: 0 },
        // SIGA puede traer IdProducto con espacios (char): el Map de comprasHoy tiene claves trim.
        { IdProducto: '7000  ', NombreProducto: 'CON ESPACIOS', CostoSistema: 1210, IvaCompraPct: 21, IngresoHoy: 1 },
      ];
    }
    return [];
  };
  const router = crearRutasPrecios({
    apiRoute: fn => async (req, res) => res.json(await fn(req)), query,
    leerJSON: () => ({ toleranciaPct: 2, metodoGanancia: 'curva', curvaGanancia: { almacen: curvaPlana(100) } }),
    guardarJSON: () => {}, DATA_DIR: '/tmp', LISTA_PRECIOS_VENTA: 1,
    FORMULA_ACTIVA_SQL: '1=1', SIN_FORMULA_GENERICO_SQL: '1=1',
  });
  const llamar = (ruta, q) => {
    const layer = router.stack.find(l => l.route && l.route.methods.get && l.match(ruta));
    return new Promise(ok => layer.route.stack[0].handle({ params: layer.params, query: q }, { json: ok }));
  };
  const filas = await llamar('/api/precios/listado', { tipo: 'almacen' });
  const de = plu => filas.find(f => f.plu === plu);
  assert.deepStrictEqual(de('6051').compraHoy, {
    costo: 1210, tipoComprobante: 'factura', proveedor: 'Prov SA', comprobante: 'A-0003-00012345',
    costoAnterior: 1100, fechaAnterior: '2026-09-12', deltaPct: 10, tendencia: 'sube',
  });
  assert.deepStrictEqual(de('7000').compraHoy, {
    costo: 500, tipoComprobante: 'cotización', proveedor: null, comprobante: 'B-0001-00000009',
    costoAnterior: null, fechaAnterior: null, deltaPct: null, tendencia: 'sin-anterior',
  });
  assert.strictEqual(de('8000').compraHoy, null);
  assert.strictEqual(de('7000  ').compraHoy.costo, 500); // plu sin trim igual matchea
  // Columnas fijas del listado: costo de sistema neto (PrecioCosto 1210 ÷ 1,21) y con IVA; última compra.
  assert.strictEqual(de('6051').costoSistema, 1000);
  assert.strictEqual(de('6051').costoSistemaConIva, 1210);
  // Listado: costo real, ganancia, markup final e IVA del producto. Curva plana 100 % sin gastos → neto 2000, final 2420 → 2400.
  assert.strictEqual(de('8000').costoReal, 1000);
  assert.strictEqual(de('8000').gananciaPct, 100);
  assert.strictEqual(de('8000').precioConIva, 2400);
  assert.strictEqual(de('8000').markupFinalPct, 140);
  assert.strictEqual(de('8000').ivaPct, 21);
  assert.strictEqual('ivaSupuesto' in de('8000'), false);
  assert.ok(Object.hasOwn(de('6051'), 'precioUltimaCompra'));
  // El detalle trae el mismo dato.
  assert.deepStrictEqual((await llamar('/api/precios/detalle/6051', {})).compraHoy, de('6051').compraHoy);

  // Una sola query por request, con la forma acordada.
  const compras = sqls.filter(s => s.includes('WITH hoy'));
  assert.strictEqual(compras.length, 2); // listado + detalle
  const q = compras[0];
  assert.match(q, /c\.FechaActualizacion >= CAST\(GETDATE\(\) AS date\)/); // cargada hoy (no fecha de factura)
  assert.match(q, /ROW_NUMBER\(\) OVER \(PARTITION BY cp\.IdProducto ORDER BY c\.FechaActualizacion DESC/); // la última de hoy
  assert.match(q, /OUTER APPLY/); // anterior: sólo para los productos de hoy
  assert.match(q, /ISNULL\(c2\.FechaActualizacion, c2\.Fecha\) < CAST\(GETDATE\(\) AS date\)/);
  assert.match(q, /AND c\.IdProveedor=cp\.IdProveedor/); // PK de 6 columnas (ver rutas_compras.js)
  assert.match(q, /AND c2\.IdProveedor=cp2\.IdProveedor/);
  assert.match(q, /LTRIM\(RTRIM\(cp\.IdProducto\)\) <> '1'/);
  // Cotizaciones entran; notas de crédito no (hoy y anterior).
  assert.doesNotMatch(q, /COTIZACION%/);
  assert.match(q, /c\.IdTipoComprobante NOT IN \('NCREDCOM','COTIZACIONNCCOM'\)/);
  assert.match(q, /c2\.IdTipoComprobante NOT IN \('NCREDCOM','COTIZACIONNCCOM'\)/);

  // Última compra = último comprobante real (ComprasProductos), no ProductosProveedores.
  const uni = sqls.find(s => s.includes("NombreRubro = 'Almacen'"));
  assert.doesNotMatch(uni, /ProductosProveedores/);
  assert.match(uni, /OUTER APPLY \(\s*SELECT TOP 1 CAST\(cp\.PrecioNeto AS FLOAT\)/);
  assert.match(uni, /ORDER BY c\.Fecha DESC, c\.FechaActualizacion DESC, c\.NumeroComprobante DESC, cp\.Orden DESC/);
  assert.match(uni, /c\.IdTipoComprobante NOT IN \('NCREDCOM','COTIZACIONNCCOM'\)/);
  assert.match(uni, /AND c\.IdProveedor=cp\.IdProveedor/);
});

test('armarGruposFraccionado: el granel trae compraHoy con tendencia (null si no ingresó hoy)', () => {
  const comprasHoy = new Map([['4409', { costo: 2400, proveedor: 'Prov', comprobante: 'A-0001-00000001',
    costoAnterior: 2500, fechaAnterior: '2026-09-01', deltaPct: -4 }]]);
  const gs = armarGruposFraccionado({
    graneles: GRANELES, presentaciones: PRESENTACIONES, formulas: FORMULAS, costos: COSTOS,
    vigentes: new Map(), costeoConfig: { toleranciaPct: 10 }, comprasHoy,
  });
  assert.deepStrictEqual(grupo(gs, '4409').compraHoy, { ...comprasHoy.get('4409'), tendencia: 'igual' });
  assert.strictEqual(grupo(gs, '5000').compraHoy, null);
  assert.strictEqual(grupo(gs, null).compraHoy, null);
  assert.strictEqual(grupo(armar(), '4409').compraHoy, null); // sin mapa (llamadas viejas)
});

test('armarGruposFraccionado: venta directa con fórmula va bajo su granel; sin fórmula es su propio granel', () => {
  const costos = new Map([...COSTOS, ['1580', { nombre: 'Mix Frutos 1Kg', costoMercaderia: null, costoSistema: 3000,
    costoSistemaConIva: 3630, ivaCompraPct: 21, ivaCompraSupuesto: false, proveedor: 'Prov', fechaUltimaCompra: null, ingresoHoy: false }]]);
  const gs = armarGruposFraccionado({
    graneles: GRANELES,
    presentaciones: [
      ...PRESENTACIONES,
      { plu: '221', nombre: 'Sem. Lino 5Kg', ventaDirecta: true },   // fórmula → granel 4409
      { plu: '1580', nombre: 'Mix Frutos 1Kg', ventaDirecta: true }, // sin fórmula → su propio granel
      { plu: '1856', nombre: 'Mix Frutos 50G' },                     // fraccionado cuyo granel es el VD
    ],
    formulas: { ...FORMULAS, 221: { granel: 4409 }, 1856: { granel: 1580 } },
    costos, vigentes: new Map(), costeoConfig: CFG_FRAC,
  });
  const lino = grupo(gs, '4409');
  assert.deepStrictEqual(lino.presentaciones.map(p => p.plu), ['11', '12', '221']);
  assert.strictEqual(lino.presentaciones[2].ventaDirecta, true);
  assert.strictEqual(lino.presentaciones[0].ventaDirecta, false);
  const mix = grupo(gs, '1580');
  assert.strictEqual(mix.granelNombre, 'Mix Frutos 1Kg');
  assert.strictEqual(mix.costoBase, 3000);
  assert.deepStrictEqual(mix.presentaciones.map(p => p.plu), ['1856', '1580']); // por peso: 50G, 1KG
  assert.deepStrictEqual(mix.presentaciones[1].faltantes, []);
  assert.ok(!grupo(gs, null).presentaciones.some(p => p.plu === '1580'));
});

test('armarGruposFraccionado: venta directa sin fórmula local se une al granel de SIGA o, si no, al del mismo nombre', () => {
  const gs = armarGruposFraccionado({
    graneles: [...GRANELES, { plu: '7011', nombre: 'Albahaca DEPOSITO GRANEL' }, { plu: '7012', nombre: 'Alcachofa DEPOSITO GRANEL' }],
    presentaciones: [
      { plu: '1031', nombre: 'Albahaca 1Kg', ventaDirecta: true },                     // por nombre
      { plu: '1420', nombre: 'Alcachofa 1Kg', ventaDirecta: true, granelSiga: '4409' }, // fórmula SIGA gana al nombre
    ],
    formulas: {}, costos: COSTOS, vigentes: new Map(), costeoConfig: { toleranciaPct: 10 },
  });
  assert.deepStrictEqual(grupo(gs, '7011').presentaciones.map(p => p.plu), ['1031']);
  assert.deepStrictEqual(grupo(gs, '4409').presentaciones.map(p => p.plu), ['1420']);
  assert.deepStrictEqual(grupo(gs, '7012').presentaciones, []);
  assert.strictEqual(grupo(gs, '1031'), undefined);
});

test('armarGruposFraccionado: con minutos propios la MO (min × costoHora/60 ÷ kg) se suma al $/kg igual que antes', () => {
  // costoHora 6000 → $100/min. Propios: 500G 2 min → $200/u = $400/kg; 1Kg 3 min = $300/kg.
  const gs = armar({ costoHora: 6000, minutosFraccionado: { 11: 2, 12: 3 } });
  const [p500, p1k] = grupo(gs, '4409').presentaciones;
  assert.strictEqual(p500.minutosOverride, 2);
  assert.strictEqual(p500.costoMoKg, 400);
  assert.strictEqual(p500.costoKg, 2697);        // 2297 + 400
  assert.strictEqual(p500.precioNeto, 4539.59); // 2697 × 1.6832
  assert.strictEqual(p1k.minutosOverride, 3);
  assert.strictEqual(p1k.costoMoKg, 300);
  assert.strictEqual(p1k.costoKg, 2597);
  assert.ok(!('minutosStd' in p500));
});

test('armarGruposFraccionado: sin minutos ni insumos propios no suma MO ni insumos (el standard viejo del archivo se ignora)', () => {
  const gs = armar({ costoHora: 6000, minutosFraccionadoStd: 2, insumosFraccionadoStd: 100, minutosFraccionado: { 12: 3 } });
  const [p500, p1k] = grupo(gs, '4409').presentaciones;
  assert.strictEqual(p500.minutosOverride, null);
  assert.strictEqual(p500.minutos, 0);
  assert.strictEqual(p500.costoMoKg, 0);
  assert.strictEqual(p500.insumos, 0);
  assert.strictEqual(p500.costoInsumosKg, 0);
  assert.strictEqual(p500.costoKg, 2297);
  assert.strictEqual(p1k.costoMoKg, 300);      // con propios: igual que antes
  assert.strictEqual(p1k.costoInsumosKg, 0);   // sin insumos propios
  assert.strictEqual(p1k.costoKg, 2597);
});

test('armarGruposFraccionado: MO sin peso en el nombre → faltante pesoMo; sin minutos propios no hace falta el peso', () => {
  const costos = new Map([...COSTOS, ['1580', { nombre: 'Mix 1Kg', costoMercaderia: null, costoSistema: 3000 }]]);
  const armarSuelto = minutosFraccionado => armarGruposFraccionado({
    graneles: GRANELES,
    presentaciones: [{ plu: '11', nombre: 'Sem. Lino Suelto' }, { plu: '1580', nombre: 'Mix 1Kg', ventaDirecta: true }],
    formulas: FORMULAS, costos, vigentes: new Map(),
    costeoConfig: { toleranciaPct: 10, costoHora: 6000, minutosFraccionado },
  });
  const suelto = grupo(armarSuelto({ 11: 2 }), '4409').presentaciones[0];
  assert.deepStrictEqual(suelto.faltantes, ['pesoMo']);
  assert.strictEqual(suelto.precioConIva, null);
  const sueltoSin = grupo(armarSuelto({}), '4409').presentaciones[0];
  assert.strictEqual(sueltoSin.costoMoKg, 0);
  assert.ok(!sueltoSin.faltantes.includes('pesoMo'));
  const mix = grupo(armarSuelto({}), '1580').presentaciones[0];
  assert.strictEqual(mix.costoMoKg, 0);
  assert.strictEqual(mix.costoKg, 3000);
});

test('armarGruposFraccionado: temporales no llevan MO ni insumos (sin PLU no hay propios)', () => {
  const gs = armar({ costoHora: 6000, minutosFraccionadoStd: 1, insumosFraccionadoStd: 10,
    presentacionesTemporales: { 4409: [{ id: 't1', pesoG: 50 }] } });
  const [t] = grupo(gs, '4409').temporales;
  assert.strictEqual(t.costoMoKg, 0);
  assert.strictEqual(t.costoInsumosKg, 0);
  assert.strictEqual(t.costoKg, 2297);
});

test('armarGruposFraccionado: el nombre ignora calibre y "(Precio Por Kilo)" sólo si el granel es único', () => {
  const gs = armarGruposFraccionado({
    graneles: [
      { plu: '4304', nombre: 'Avellanas Chicas - 9/11 DEPOSITO GRANEL' },
      { plu: '7100', nombre: 'Almendras 23/25 DEPOSITO GRANEL' }, { plu: '7101', nombre: 'Almendras 27/30 DEPOSITO GRANEL' },
    ],
    presentaciones: [
      { plu: '4305', nombre: 'Avellanas Chicas 1Kg', ventaDirecta: true },
      { plu: '5726', nombre: 'Avellanas Chicas 5kg (Precio Por Kilo)', ventaDirecta: true },
      { plu: '8000', nombre: 'Almendras 27/30 1Kg', ventaDirecta: true }, // calibre exacto
      { plu: '8001', nombre: 'Almendras 1Kg', ventaDirecta: true },       // ambiguo → propio
    ],
    formulas: {}, costos: new Map(), vigentes: new Map(), costeoConfig: { toleranciaPct: 10 },
  });
  assert.deepStrictEqual(grupo(gs, '4304').presentaciones.map(p => p.plu), ['4305', '5726']);
  assert.deepStrictEqual(grupo(gs, '7101').presentaciones.map(p => p.plu), ['8000']);
  assert.deepStrictEqual(grupo(gs, '7100').presentaciones, []);
});

// ── Gastos sobre venta: el standard es ganancia, se convierte a markup total ──
// 26.09 % = total de los 8 conceptos del Excel viejo (lista sucursal).
const GASTOS_2609 = [
  { id: 'goa', concepto: 'GOA', pct: 15, listas: ['sucursal'] },
  { id: 'resto', concepto: 'Resto', pct: 11.09, listas: ['sucursal'] },
];

test('calcularFilaAlmacen: con gastos 26.09 la curva (ganancia 15) da markup 55.594642; expone gananciaBanda y gastosVentaPct', () => {
  const fila = calcularFilaAlmacen({
    plu: '1', nombre: 'Arroz', costoSistema: 2000, precioVigente: null,
    costeoConfig: { ...CFG_BASE, gastosVenta: GASTOS_2609 },
  });
  assert.strictEqual(fila.gananciaBanda, 15);
  assert.strictEqual(fila.gastosVentaPct, 26.09);
  assert.strictEqual(fila.markupBanda, 55.594642);
  assert.strictEqual(fila.markupPct, 55.594642);
  assert.strictEqual(fila.banda, 'curva');
  assert.strictEqual(fila.precioNeto, 3111.89); // 2000 × 1.55594642
});

test('calcularFilaAlmacen: la ganancia propia reemplaza curva + conceptos y se convierte con los gastos; sin gastos gananciaBanda = markupBanda', () => {
  const fila = calcularFilaAlmacen({
    plu: '1', nombre: 'Arroz', costoSistema: 2000, precioVigente: null,
    costeoConfig: { ...CFG_BASE, gastosVenta: GASTOS_2609, margenPorProducto: { 1: 40 }, conceptosGanancia: [{ id: 'r', concepto: 'R', pct: 3 }] },
  });
  assert.strictEqual(fila.gananciaOverride, 40);
  assert.strictEqual(fila.markupOverride, 89.419564); // 1,4 ÷ (1 − 0,2609) − 1
  assert.strictEqual(fila.markupPct, 89.419564);
  assert.strictEqual(fila.gananciaPct, 40);
  assert.deepStrictEqual(fila.desglose.conceptos, []); // la propia no suma conceptos
  assert.strictEqual(fila.banda, 'override');
  assert.strictEqual(fila.gananciaCurva, 15);
  assert.strictEqual(fila.gananciaBanda, 18); // standard = curva 15 + conceptos 3
  assert.strictEqual(fila.markupBanda, markupDesdeGanancia(18, 26.09));
  const sin = calcularFilaAlmacen({ plu: '1', nombre: 'Arroz', costoSistema: 2000, precioVigente: null, costeoConfig: CFG_BASE });
  assert.strictEqual(sin.gastosVentaPct, 0);
  assert.strictEqual(sin.gananciaBanda, 15);
  assert.strictEqual(sin.markupBanda, 15);
});

test('armarGruposFraccionado: con gastos la curva da ganancia (gananciaStd) y markupStd la convierte; la propia también', () => {
  const [p500] = grupo(armar({ gastosVenta: GASTOS_2609 }), '4409').presentaciones;
  assert.strictEqual(p500.gananciaStd, 68.32);
  assert.strictEqual(p500.markupStd, 127.736436);
  assert.strictEqual(p500.markupPct, 127.736436);
  assert.strictEqual(p500.precioNeto, 5231.11);
  // costo real = 2297 ÷ (1 − 0,2609) = 3107,83; × 1,6832 = 5231,11
  assert.strictEqual(p500.costoReal, 3107.83);
  const [ov] = grupo(armar({ gastosVenta: GASTOS_2609, margenPorProducto: { 11: 100 } }), '4409').presentaciones;
  assert.strictEqual(ov.gananciaOverride, 100);
  assert.strictEqual(ov.markupPct, 170.599378); // 2 ÷ 0,7391 − 1
  // Conceptos de ganancia: se suman al standard (no a la propia).
  const [cc] = grupo(armar({ conceptosGanancia: [{ id: 'r', concepto: 'R', pct: 1.68 }] }), '4409').presentaciones;
  assert.strictEqual(cc.gananciaStd, 70);
  assert.strictEqual(cc.desglose.conceptos[0].importe, 38.59); // 2297 × 1,68 %
  const [sin] = grupo(armar(), '4409').presentaciones;
  assert.strictEqual(sin.gananciaStd, 68.32);
  assert.strictEqual(sin.markupStd, 68.32);
});

test('armarGruposFraccionado: temporales convierten la ganancia standard con los mismos gastos', () => {
  const gs = armar({ gastosVenta: GASTOS_2609, presentacionesTemporales: { 4409: [{ id: 't-a', pesoG: 500, gananciaPct: null }] } });
  const [t] = grupo(gs, '4409').temporales;
  assert.strictEqual(t.gananciaStd, 68.32);
  assert.strictEqual(t.markupStd, 127.736436);
  assert.strictEqual(t.precioNeto, 5231.11);
});

// ── Insumos básicos de Fraccionado ($ por unidad ÷ kg, mismo patrón que la MO) ──

test('armarGruposFraccionado: con insumos propios $/u ÷ kg se suman al costoKg igual que antes; junto con la MO', () => {
  const gs = armar({ insumosFraccionado: { 11: 100, 12: 50 } });
  const [p500, p1k] = grupo(gs, '4409').presentaciones;
  assert.strictEqual(p500.insumosOverride, 100);
  assert.strictEqual(p500.insumos, 100);
  assert.strictEqual(p500.costoInsumosKg, 200); // $100 / 0,5 kg
  assert.strictEqual(p500.costoKg, 2497);
  assert.strictEqual(p1k.insumosOverride, 50);
  assert.strictEqual(p1k.insumos, 50);
  assert.strictEqual(p1k.costoInsumosKg, 50);
  assert.strictEqual(p1k.costoKg, 2347);
  assert.ok(!('insumosStd' in p500));
  const [conMo] = grupo(armar({ insumosFraccionado: { 11: 100 }, costoHora: 6000, minutosFraccionado: { 11: 2 } }), '4409').presentaciones;
  assert.strictEqual(conMo.costoKg, 2897); // 2297 + 400 MO + 200 insumos
});

test('armarGruposFraccionado: insumos propios sin peso en el nombre → faltante pesoMo; VD propio granel sin propios no lleva insumos', () => {
  const costos = new Map([...COSTOS, ['1580', { nombre: 'Mix 1Kg', costoMercaderia: null, costoSistema: 3000 }]]);
  const gs = armarGruposFraccionado({
    graneles: GRANELES,
    presentaciones: [{ plu: '11', nombre: 'Sem. Lino Suelto' }, { plu: '1580', nombre: 'Mix 1Kg', ventaDirecta: true }],
    formulas: FORMULAS, costos, vigentes: new Map(),
    costeoConfig: { toleranciaPct: 10, insumosFraccionado: { 11: 100 } },
  });
  const suelto = grupo(gs, '4409').presentaciones[0];
  assert.strictEqual(suelto.costoInsumosKg, null);
  assert.deepStrictEqual(suelto.faltantes, ['pesoMo']);
  assert.strictEqual(suelto.precioConIva, null);
  const mix = grupo(gs, '1580').presentaciones[0];
  assert.strictEqual(mix.costoInsumosKg, 0);
  assert.strictEqual(mix.costoKg, 3000);
});

// ── Endpoints: config de gastos sobre venta e insumos de fraccionado ─────────

function routerConArchivo(inicial, query = async () => []) {
  const crearRutasPrecios = require('../routes/rutas_precios');
  const estado = { archivo: inicial };
  const router = crearRutasPrecios({
    apiRoute: fn => async (req, res) => res.json(await fn(req)),
    query, leerJSON: () => estado.archivo, guardarJSON: (_p, d) => { estado.archivo = d; },
    DATA_DIR: '/tmp', LISTA_PRECIOS_VENTA: 1,
  });
  const llamar = (method, ruta, body) => {
    const layer = router.stack.find(l => l.route && l.route.methods[method] && l.match(ruta));
    return new Promise(resolve => layer.route.stack[0].handle({ params: layer.params, body, query: {} }, { json: resolve }));
  };
  return { estado, llamar };
}

const ARCHIVO_CURVAS = {
  toleranciaPct: 10, margenPorProducto: { 11: 5 }, metodoGanancia: 'curva', precioFinalConceptos: 'conceptos',
  curvaGanancia: { almacen: curvaEscalon(1000, 40, 15), fraccionado: CURVA_FRAC, produccion: curvaPlana(30) },
};

// Markup total que da la curva de un tipo con sus gastos (Fraccionado con peso).
const markupCurva = (curva, costo, gastosPct, pesoG = null) => markupDesdeGanancia(gananciaPorCurva(curva, costo, pesoG), gastosPct);
const casi = (a, b) => assert.ok(Math.abs(a - b) < 0.001, `${a} ≉ ${b}`);
// Reescalado exacto 1 + g' = k(1 + g) en a/piso/techo, b' = k·b, ajustes ×k (redondeo a 4 decimales).
function assertReescalada(nueva, vieja, k) {
  const nivel = g => ((1 + g / 100) * k - 1) * 100;
  for (const c of ['a', 'pisoPct', 'techoPct']) casi(nueva[c], nivel(vieja[c]));
  casi(nueva.b, k * vieja.b);
  if (vieja.ajustesPeso) vieja.ajustesPeso.puntos.forEach((v, i) => casi(nueva.ajustesPeso.puntos[i], k * v));
}

test('GET config: expone gastosVenta y gastosVentaPct (defaults vacíos); no expone los standard de fraccionado', async () => {
  const { llamar } = routerConArchivo({ ...ARCHIVO_CURVAS });
  const c = await llamar('get', '/api/precios/config');
  assert.deepStrictEqual(c.gastosVenta, []);
  assert.strictEqual(c.gastosVentaPct, 0);
  const { llamar: l2 } = routerConArchivo({ ...ARCHIVO_CURVAS, gastosVenta: GASTOS_2609, insumosFraccionadoStd: 30, minutosFraccionadoStd: 2 });
  const c2 = await l2('get', '/api/precios/config');
  assert.strictEqual(c2.gastosVentaPct, 26.09);
  assert.ok(!('insumosFraccionadoStd' in c2) && !('minutosFraccionadoStd' in c2));
});

test('PUT config/gastos-venta: conservando precios reescala las curvas para que el markup total no cambie', async () => {
  const { estado, llamar } = routerConArchivo({ ...ARCHIVO_CURVAS });
  const r = await llamar('put', '/api/precios/config/gastos-venta', { items: [{ concepto: 'GOA', pct: 15 }, { concepto: 'Resto', pct: 11.09 }] });
  assert.strictEqual(r.error, undefined);
  assert.strictEqual(r.gastosVentaPct, 26.09);
  assert.deepStrictEqual(r.gastosVenta.map(g => g.id), ['goa', 'resto']);
  assert.ok(!('bandasMarkup' in r) && !('markupFraccionado' in r));
  const k = 1 - 0.2609;
  for (const tipo of ['almacen', 'fraccionado', 'produccion']) assertReescalada(r.curvaGanancia[tipo], ARCHIVO_CURVAS.curvaGanancia[tipo], k);
  casi(markupCurva(r.curvaGanancia.almacen, 500, 26.09), 40);
  casi(markupCurva(r.curvaGanancia.almacen, 2000, 26.09), 15);
  casi(markupCurva(r.curvaGanancia.fraccionado, 2297, 26.09, 500), 68.32);
  casi(markupCurva(r.curvaGanancia.produccion, 2297, 26.09), 30);
  assert.deepStrictEqual(estado.archivo.gastosVenta, r.gastosVenta);
  assertReescalada(estado.archivo.curvaGanancia.almacen, ARCHIVO_CURVAS.curvaGanancia.almacen, k); // lo guardado = lo devuelto
  // Ganancias propias también reescaladas (1 + g′ = k(1 + g)): el markup total (y el precio) queda igual.
  assert.deepStrictEqual(estado.archivo.margenPorProducto, { 11: -22.3945 });
  casi(markupDesdeGanancia(estado.archivo.margenPorProducto[11], 26.09), 5);
});

test('PUT config/gastos-venta: conservarPrecios false guarda sólo los gastos; inválido no escribe', async () => {
  const { estado, llamar } = routerConArchivo({ ...ARCHIVO_CURVAS });
  const r = await llamar('put', '/api/precios/config/gastos-venta', { items: GASTOS_2609, conservarPrecios: false });
  assert.deepStrictEqual(estado.archivo.curvaGanancia, ARCHIVO_CURVAS.curvaGanancia);
  assert.strictEqual(r.curvaGanancia.almacen.pisoPct, 15);
  assert.strictEqual(r.curvaGanancia.almacen.techoPct, 40);
  assert.strictEqual(estado.archivo.gastosVentaPct, undefined); // el total no se persiste, se calcula
  assert.strictEqual(estado.archivo.gastosVenta.length, 2);
  const antes = estado.archivo;
  assert.match((await llamar('put', '/api/precios/config/gastos-venta', { items: [{ concepto: 'A', pct: 100 }] })).error, /pct|100/);
  assert.match((await llamar('put', '/api/precios/config/gastos-venta', {})).error, /lista/);
  assert.strictEqual(estado.archivo, antes);
});

test('PUT config/gastos-venta: si el reescalado deja una curva fuera de rango, error y no escribe', async () => {
  const { estado, llamar } = routerConArchivo({ ...ARCHIVO_CURVAS });
  const antes = estado.archivo;
  const r = await llamar('put', '/api/precios/config/gastos-venta', { items: [{ concepto: 'Mucho', pct: 99.5 }] }); // piso < −50 %
  assert.match(r.error, /curvaGanancia\.\w+\.(pisoPct|techoPct)/);
  assert.strictEqual(estado.archivo, antes);
  assert.strictEqual(estado.archivo.gastosVenta, undefined);
});

test('PUT insumos-fraccionado/:plu guarda $/u por presentación, null lo quita; valida rango y PLU', async () => {
  const { estado, llamar } = routerConArchivo({ ...ARCHIVO_CURVAS });
  assert.deepStrictEqual(await llamar('put', '/api/precios/insumos-fraccionado/12', { pesos: 35.5 }), { plu: '12', valor: 35.5 });
  assert.deepStrictEqual(estado.archivo.insumosFraccionado, { 12: 35.5 });
  assert.match((await llamar('put', '/api/precios/insumos-fraccionado/12', { pesos: -1 })).error, /inválido/);
  assert.match((await llamar('put', '/api/precios/insumos-fraccionado/12', { pesos: 10000001 })).error, /inválido/);
  assert.match((await llamar('put', '/api/precios/insumos-fraccionado/a%20b', { pesos: 1 })).error, /PLU/);
  await llamar('put', '/api/precios/insumos-fraccionado/12', { pesos: null });
  assert.deepStrictEqual(estado.archivo.insumosFraccionado, {});
});

test('PUT config/general: costoHora y tolerancia; los standard de fraccionado se ignoran como claves desconocidas', async () => {
  const { estado, llamar } = routerConArchivo({ ...ARCHIVO_CURVAS });
  const r = await llamar('put', '/api/precios/config/general',
    { costoHora: 5000, toleranciaPct: 8, insumosFraccionadoStd: 10000001, minutosFraccionadoStd: 2 });
  assert.deepStrictEqual(r, { costoHora: 5000, toleranciaPct: 8 });
  assert.strictEqual(estado.archivo.costoHora, 5000);
  assert.ok(!('insumosFraccionadoStd' in estado.archivo) && !('minutosFraccionadoStd' in estado.archivo));
  assert.match((await llamar('put', '/api/precios/config/general', { costoHora: -1 })).error, /costoHora/);
});

// ── Tab Costos: departamentos, venta base y gastos por tipo ──────────────────

const DEPTO_ADM = { nombre: 'Administración', costoMensual: 1000000, imputacion: { almacen: 50, fraccionado: 30, produccion: 20 } };
// produccionSinDepartamentos false: Producción absorbe departamentos como los otros tipos (el flag se prueba aparte).
const VENTA_MANUAL = { produccionSinDepartamentos: false, meses: 3, manual: { almacen: 10000000, fraccionado: 6000000, produccion: 4000000 } };

test('GET config: sin departamentos, gastos por tipo = variables y estructura vacía', async () => {
  const { llamar } = routerConArchivo({ ...ARCHIVO_CURVAS, gastosVenta: GASTOS_2609 });
  const c = await llamar('get', '/api/precios/config');
  assert.deepStrictEqual(c.departamentos, []);
  assert.deepStrictEqual(c.ventaBase, { meses: 3, manual: { almacen: null, fraccionado: null, produccion: null }, snapshot: null, produccionSinDepartamentos: true });
  assert.deepStrictEqual(c.gastosVentaPctPorTipo, { almacen: 26.09, fraccionado: 26.09, produccion: 26.09 });
  assert.strictEqual(c.gastosVentaPct, 26.09);
  assert.deepStrictEqual(c.estructuraCostos.porTipo.almacen, { variablesPct: 26.09, departamentosPct: 0, totalPct: 26.09, ventaMensual: null, costoImputado: 0 });
  assert.deepStrictEqual(c.estructuraCostos.departamentos, []);
});

test('PUT config/departamentos: guarda, reescala por tipo (markup total igual) y conserva el snapshot', async () => {
  const snapshot = { fecha: '2026-10-01', meses: 3, porTipo: { almacen: 1, fraccionado: 1, produccion: 1 } };
  const archivo = { ...ARCHIVO_CURVAS, ventaBase: { meses: 3, manual: {}, snapshot } };
  const { estado, llamar } = routerConArchivo(archivo);
  const r = await llamar('put', '/api/precios/config/departamentos', { items: [DEPTO_ADM], ventaBase: VENTA_MANUAL });
  assert.strictEqual(r.error, undefined);
  assert.deepStrictEqual(r.gastosVentaPctPorTipo, { almacen: 5, fraccionado: 5, produccion: 5 });
  assert.strictEqual(r.gastosVentaPct, 0); // variables (compat)
  for (const tipo of ['almacen', 'fraccionado', 'produccion']) assertReescalada(r.curvaGanancia[tipo], ARCHIVO_CURVAS.curvaGanancia[tipo], 0.95);
  casi(markupCurva(r.curvaGanancia.almacen, 2000, 5), 15);
  casi(markupCurva(r.curvaGanancia.produccion, 2000, 5), 30);
  casi(markupCurva(r.curvaGanancia.fraccionado, 2297, 5, 100), 84.35);
  for (const tipo of ['almacen', 'fraccionado', 'produccion']) assertReescalada(estado.archivo.curvaGanancia[tipo], ARCHIVO_CURVAS.curvaGanancia[tipo], 0.95);
  assert.strictEqual(estado.archivo.departamentos[0].id, 'administracion');
  assert.deepStrictEqual(estado.archivo.ventaBase, { ...VENTA_MANUAL, snapshot });
  assert.deepStrictEqual(estado.archivo.margenPorProducto, { 11: -0.25 }); // 1,05 × 0,95 − 1: mismo precio
});

test('PUT config/departamentos: costo imputado sin venta o gastos ≥ 100 → error y no escribe', async () => {
  const { estado, llamar } = routerConArchivo({ ...ARCHIVO_CURVAS });
  const antes = estado.archivo;
  assert.match((await llamar('put', '/api/precios/config/departamentos', { items: [DEPTO_ADM] })).error, /venta mensual/);
  assert.match((await llamar('put', '/api/precios/config/departamentos', { items: [DEPTO_ADM], ventaBase: { manual: { almacen: 1, fraccionado: 1, produccion: 1 } } })).error, /100/);
  assert.match((await llamar('put', '/api/precios/config/departamentos', { items: 'x' })).error, /lista/);
  assert.match((await llamar('put', '/api/precios/config/departamentos', { items: [], ventaBase: { meses: 30 } })).error, /meses/);
  assert.strictEqual(estado.archivo, antes);
});

test('PUT config/departamentos conservarPrecios false: no toca las ganancias', async () => {
  const { estado, llamar } = routerConArchivo({ ...ARCHIVO_CURVAS });
  const r = await llamar('put', '/api/precios/config/departamentos', { items: [DEPTO_ADM], ventaBase: VENTA_MANUAL, conservarPrecios: false });
  assert.strictEqual(r.curvaGanancia.almacen.pisoPct, 15);
  assert.strictEqual(r.curvaGanancia.almacen.techoPct, 40);
  assert.deepStrictEqual(estado.archivo.curvaGanancia, ARCHIVO_CURVAS.curvaGanancia);
});

test('PUT config/gastos-venta con departamentos: reescala cada tipo con sus gastos', async () => {
  const archivo = { ...ARCHIVO_CURVAS, departamentos: [{ id: 'adm', ...DEPTO_ADM, imputacion: { almacen: 50, fraccionado: 0, produccion: 0 } }], ventaBase: VENTA_MANUAL };
  const { llamar } = routerConArchivo(archivo);
  const r = await llamar('put', '/api/precios/config/gastos-venta', { items: [{ concepto: 'IIBB', pct: 10 }] });
  assert.deepStrictEqual(r.gastosVentaPctPorTipo, { almacen: 15, fraccionado: 10, produccion: 10 });
  // almacen pasa de 5 → 15 (k = 0,85 / 0,95); fraccionado y producción de 0 → 10 (k = 0,9)
  assertReescalada(r.curvaGanancia.almacen, ARCHIVO_CURVAS.curvaGanancia.almacen, 0.85 / 0.95);
  assertReescalada(r.curvaGanancia.fraccionado, ARCHIVO_CURVAS.curvaGanancia.fraccionado, 0.9);
  // markup total igual al de antes (ganancia 15 con gastos 5; 68.32 sin gastos)
  casi(markupCurva(r.curvaGanancia.almacen, 2000, 15), markupDesdeGanancia(15, 5));
  casi(markupCurva(r.curvaGanancia.fraccionado, 2297, 10, 500), 68.32);
  casi(markupCurva(r.curvaGanancia.produccion, 2297, 10), 30);
});

test('POST costos/venta-base/actualizar: consulta SIGA por tipo (presentaciones + su pack/bulto), guarda snapshot mensual y avisa faltantes', async () => {
  const sqls = [];
  // 1ª query: vínculos pack/bulto (OUTER APPLY); 2ª: venta por tipo.
  const VINCULOS = [{ plu: '91438', nombre: 'Pepas Bulto', basePlu: '777', cantidad: 12 }, { plu: '91449', nombre: 'Otra Bulto', basePlu: '999', cantidad: 12 }];
  const query = async sql => { sqls.push(sql); return /OUTER APPLY/.test(sql) ? VINCULOS : [{ Tipo: 'almacen', Importe: 30000000 }, { Tipo: 'fraccionado', Importe: 9000000 }]; };
  const archivo = { ...ARCHIVO_CURVAS, departamentos: [{ id: 'adm', ...DEPTO_ADM }], productos: { 'p-x': { presentaciones: { 777: {}, 'n-prov': {} } } },
    ventaBase: { produccionSinDepartamentos: false } };
  const { estado, llamar } = routerConArchivo(archivo, query);
  const r = await llamar('post', '/api/precios/costos/venta-base/actualizar', { meses: 3 });
  assert.strictEqual(sqls.length, 2);
  // PLUs de la tab Producción: presentación 777 + su bulto 91438 (leerJSON del mock devuelve este archivo); 91449 es de otro base
  assert.match(sqls[1], /IN \('777','91438'\)/);
  assert.doesNotMatch(sqls[1], /n-prov|91449/);
  assert.deepStrictEqual(estado.archivo.ventaBase.snapshot.porTipo, { almacen: 10000000, fraccionado: 3000000, produccion: 0 });
  assert.strictEqual(estado.archivo.ventaBase.meses, 3);
  assert.strictEqual(r.gastosVentaPctPorTipo.almacen, 5);
  assert.strictEqual(r.gastosVentaPctPorTipo.produccion, null);
  assert.match(r.aviso, /Producción/);
  assert.match((await llamar('post', '/api/precios/costos/venta-base/actualizar', { meses: 0 })).error, /meses/);
});

test('calcularFilaAlmacen: gastos del tipo desconocidos (sin venta base) → sin markup de banda, faltante', () => {
  const cfg = { ...CFG_BASE, departamentos: [{ id: 'a', nombre: 'A', costoMensual: 100, imputacion: { almacen: 100 } }] };
  const fila = calcularFilaAlmacen({ plu: '1', nombre: 'Arroz', costoSistema: 500, precioVigente: 500, costeoConfig: cfg });
  assert.strictEqual(fila.markupPct, null);
  assert.strictEqual(fila.precioConIva, null);
  assert.ok(fila.faltantes.includes('markupPct'));
});

// ── IVA de venta editable (spec 2026-10-02 Parte C) ──────────────────────────
test('calcularFilaAlmacen: IVA de venta de la config (10,5 %) al final; la curva sigue con el costo neto; desglose costo real', () => {
  const cfg = { ...CFG_BASE, gastosVenta: [{ id: 'v', concepto: 'V', pct: 20, listas: ['sucursal'] }], ivaVentaPct: 10.5 };
  const fila = calcularFilaAlmacen({ plu: '1', nombre: 'Arroz', costoSistema: 905, precioVigente: null, costeoConfig: cfg });
  // 905 neto < 1000 → 40 % (el IVA no entra en la curva)
  assert.ok(!Object.hasOwn(fila, 'costoBanda'));
  assert.strictEqual(fila.banda, 'curva');
  assert.strictEqual(fila.gananciaBanda, 40);
  assert.strictEqual(fila.ivaPct, 10.5);
  assert.strictEqual(fila.gananciaPct, 40);
  // costo real = 905 ÷ 0,8 = 1131,25; precio neto = 1131,25 × 1,4 = 1583,75; ganancia 452,5 (40 % del costo real)
  assert.strictEqual(fila.markupPct, 75);
  assert.strictEqual(fila.precioNeto, 1583.75);
  assert.strictEqual(fila.costoReal, 1131.25);
  assert.strictEqual(fila.desglose.variables, 226.25);
  assert.strictEqual(fila.desglose.ganancia, 452.5);
  assert.strictEqual(+(fila.costoReal + fila.desglose.ganancia).toFixed(2), fila.precioNeto);
  assert.strictEqual(fila.precioConIvaExacto, 1750.04); // + IVA 10,5 % (166,29)
  assert.strictEqual(fila.precioConIva, 1750);
  // misma fila con IVA 21 %: misma ganancia, sólo cambia el IVA
  const f21 = calcularFilaAlmacen({ plu: '1', nombre: 'Arroz', costoSistema: 905, precioVigente: null, costeoConfig: { ...cfg, ivaVentaPct: 21 } });
  assert.strictEqual(f21.gananciaBanda, 40);
  assert.strictEqual(f21.precioNeto, 1583.75);
  assert.strictEqual(f21.precioConIvaExacto, 1916.34);
});

test('armarGruposFraccionado: todas las presentaciones y temporales usan el IVA de venta de la config', () => {
  const gs = armarGruposFraccionado({
    graneles: GRANELES, presentaciones: [{ plu: '11', nombre: 'Sem. Lino 500G' }, { plu: '12', nombre: 'Sem. Lino 1Kg' }],
    formulas: FORMULAS, costos: COSTOS, vigentes: new Map(),
    costeoConfig: { ...CFG_FRAC, margenPorProducto: {}, ivaVentaPct: 10.5, presentacionesTemporales: { 4409: [{ id: 't-a', pesoG: 500 }] } },
  });
  const [p500, p1k] = grupo(gs, '4409').presentaciones;
  assert.strictEqual(p500.ivaPct, 10.5);
  assert.strictEqual(p500.precioConIvaExacto, undefined); // la fila no expone el exacto…
  assert.strictEqual(p500.desglose.precioFinalExacto, 4272.27); // …pero el desglose sí: 3866.31 × 1,105
  assert.strictEqual(p500.precioConIva, 4250);
  assert.strictEqual(p1k.ivaPct, 10.5);
  assert.strictEqual(grupo(gs, '4409').temporales[0].ivaPct, 10.5);
});

test('PUT config/ganancia: guarda conceptos de ganancia y sobre precio final (validados), no reescala; GET los devuelve', async () => {
  const { estado, llamar } = routerConArchivo({ ...ARCHIVO_CURVAS });
  const c0 = await llamar('get', '/api/precios/config');
  assert.deepStrictEqual(c0.conceptosGanancia, []);
  assert.deepStrictEqual(c0.conceptosPrecioFinal, []);
  assert.strictEqual(c0.ivaVentaPct, 21);
  const r = await llamar('put', '/api/precios/config/ganancia', {
    conceptos: [{ concepto: 'Reinversión', pct: 2.5 }], conceptosPrecioFinal: [{ concepto: 'Ingresos brutos', pct: 5 }] });
  assert.deepStrictEqual(r, { conceptosGanancia: [{ id: 'reinversion', concepto: 'Reinversión', pct: 2.5 }], conceptosGananciaPct: 2.5,
    conceptosPrecioFinal: [{ id: 'ingresos-brutos', concepto: 'Ingresos brutos', pct: 5 }], conceptosPrecioFinalPct: 5, ivaVentaPct: 21 });
  assert.deepStrictEqual(estado.archivo.curvaGanancia, ARCHIVO_CURVAS.curvaGanancia); // no reescala
  const c = await llamar('get', '/api/precios/config');
  assert.strictEqual(c.conceptosGananciaPct, 2.5);
  assert.strictEqual(c.conceptosPrecioFinalPct, 5);
  // Sin conceptosPrecioFinal en el body se conserva la guardada.
  await llamar('put', '/api/precios/config/ganancia', { conceptos: [] });
  assert.strictEqual(estado.archivo.conceptosPrecioFinal.length, 1);
  // Y sin conceptos se conservan los de ganancia (cada tarjeta guarda su lista).
  await llamar('put', '/api/precios/config/ganancia', { conceptos: [{ concepto: 'R', pct: 1 }] });
  await llamar('put', '/api/precios/config/ganancia', { conceptosPrecioFinal: [] });
  assert.deepStrictEqual(estado.archivo.conceptosGanancia, [{ id: 'r', concepto: 'R', pct: 1 }]);
  assert.deepStrictEqual(estado.archivo.conceptosPrecioFinal, []);
  const antes = estado.archivo;
  assert.match((await llamar('put', '/api/precios/config/ganancia', { conceptos: [{ concepto: 'x', pct: 400 }] })).error, /pct/);
  assert.match((await llamar('put', '/api/precios/config/ganancia', {})).error, /lista/);
  assert.match((await llamar('put', '/api/precios/config/ganancia', { conceptos: [], conceptosPrecioFinal: [{ concepto: 'x', pct: 100 }] })).error, /conceptosPrecioFinal\[0\]\.pct/);
  assert.match((await llamar('put', '/api/precios/config/ganancia', { conceptos: [], conceptosPrecioFinal: [{ concepto: 'a', pct: 60 }, { concepto: 'b', pct: 40 }] })).error, /total/);
  assert.match((await llamar('put', '/api/precios/config/ganancia', { conceptos: [], conceptosPrecioFinal: [{ concepto: 'a', pct: -1 }] })).error, /pct/);
  assert.match((await llamar('put', '/api/precios/config/ganancia', { conceptos: [], conceptosPrecioFinal: 'x' })).error, /lista/);
  assert.strictEqual(estado.archivo, antes);
});

test('PUT config/iva-venta: guarda el IVA de venta (0..100), no reescala; inválido no escribe', async () => {
  const { estado, llamar } = routerConArchivo({ ...ARCHIVO_CURVAS });
  const r = await llamar('put', '/api/precios/config/iva-venta', { ivaVentaPct: 10.5 });
  assert.strictEqual(r.ivaVentaPct, 10.5);
  assert.strictEqual(estado.archivo.ivaVentaPct, 10.5);
  assert.deepStrictEqual(estado.archivo.curvaGanancia, ARCHIVO_CURVAS.curvaGanancia);
  assert.strictEqual((await llamar('get', '/api/precios/config')).ivaVentaPct, 10.5);
  const antes = estado.archivo;
  assert.match((await llamar('put', '/api/precios/config/iva-venta', { ivaVentaPct: 101 })).error, /ivaVentaPct/);
  assert.match((await llamar('put', '/api/precios/config/iva-venta', {})).error, /ivaVentaPct/);
  assert.strictEqual(estado.archivo, antes);
});

test('PUT margen-producto: guarda la ganancia propia (gananciaPct); null la quita', async () => {
  const { estado, llamar } = routerConArchivo({ ...ARCHIVO_CURVAS });
  assert.deepStrictEqual(await llamar('put', '/api/precios/margen-producto/12', { gananciaPct: 22.5 }), { plu: '12', valor: 22.5 });
  assert.strictEqual(estado.archivo.margenPorProducto[12], 22.5);
  await llamar('put', '/api/precios/margen-producto/12', { gananciaPct: null });
  assert.strictEqual(estado.archivo.margenPorProducto[12], undefined);
  assert.match((await llamar('put', '/api/precios/margen-producto/12', { gananciaPct: 1001 })).error, /inválido/);
});

// ── Migración bandas/matriz → curva (spec 2026-10-02 Parte B) ────────────────
const ARCHIVO_LEGADO = {
  toleranciaPct: 10, margenPorProducto: { 11: 5 },
  bandasMarkup: { almacen: [{ costoHastaARS: 1000, markupMaxPct: 40 }, { costoHastaARS: null, markupMaxPct: 15 }] },
};

test('GET config con costeo.json legado (bandas, sin marcador): devuelve las tres curvas migradas y sin bandas/matriz', async () => {
  const crearRutasPrecios = require('../routes/rutas_precios');
  const router = crearRutasPrecios({
    apiRoute: fn => async (req, res) => res.json(await fn(req)),
    query: async () => [], leerJSON: () => ARCHIVO_LEGADO, guardarJSON: () => {}, DATA_DIR: '/tmp', LISTA_PRECIOS_VENTA: 1,
  });
  const layer = router.stack.find(l => l.route && l.route.methods.get && l.match('/api/precios/config'));
  const c = await new Promise(ok => layer.route.stack[0].handle({ params: {}, query: {} }, { json: ok }));
  assert.deepStrictEqual(Object.keys(c.curvaGanancia).sort(), ['almacen', 'fraccionado', 'produccion']);
  assert.ok(!('bandasMarkup' in c) && !('markupFraccionado' in c));
  // Reventa: ganancias de las bandas como piso/techo; a más costo, menos ganancia.
  assert.strictEqual(c.curvaGanancia.almacen.pisoPct, 15);
  assert.strictEqual(c.curvaGanancia.almacen.techoPct, 40);
  assert.ok(c.curvaGanancia.almacen.b > 0);
  assert.ok(c.curvaGanancia.fraccionado.ajustesPeso); // matriz de fábrica → curva + ajustes por peso
});

test('crear el router con costeo.json legado escribe backup + migrado; con el marcador no escribe', () => {
  const crearRutasPrecios = require('../routes/rutas_precios');
  const crear = archivo => {
    const escrituras = [];
    crearRutasPrecios({
      apiRoute: fn => fn, query: async () => [], leerJSON: () => archivo,
      guardarJSON: (p, d) => escrituras.push([p, d]), DATA_DIR: '/tmp', LISTA_PRECIOS_VENTA: 1,
    });
    return escrituras;
  };
  const costeoPath = path.join('/tmp', 'costeo.json');
  // El mock de leerJSON siempre devuelve el legado: después de la curva corre la migración de márgenes (Parte C).
  const [backup, migrado, backupGanancia, migradoGanancia, backupFinal, migradoFinal, ...resto] = crear(ARCHIVO_LEGADO);
  assert.deepStrictEqual(resto, []);
  assert.deepStrictEqual(backup, [`${costeoPath}.bak-antes-curva`, ARCHIVO_LEGADO]);
  assert.strictEqual(migrado[0], costeoPath);
  assert.strictEqual(migrado[1].metodoGanancia, 'curva');
  assert.ok(!('bandasMarkup' in migrado[1]));
  assert.deepStrictEqual(Object.keys(migrado[1].curvaGanancia).sort(), ['almacen', 'fraccionado', 'produccion']);
  assert.deepStrictEqual(migrado[1].margenPorProducto, { 11: 5 });
  assert.strictEqual(backupGanancia[0], `${costeoPath}.bak-antes-ganancia`);
  assert.strictEqual(migradoGanancia[1].margenPropio, 'ganancia');
  assert.strictEqual(backupFinal[0], `${costeoPath}.bak-antes-precio-final`);
  assert.strictEqual(migradoFinal[1].precioFinalConceptos, 'conceptos');
  assert.deepStrictEqual(crear({ ...ARCHIVO_CURVAS, margenPropio: 'ganancia' }), []);
});

test('migración de márgenes propios a ganancia al crear el router: backup, G del tipo de cada PLU, idempotente', () => {
  const crearRutasPrecios = require('../routes/rutas_precios');
  const DATOS = {
    costeo: { ...ARCHIVO_CURVAS, gastosVenta: [{ id: 'v', concepto: 'V', pct: 20, listas: ['sucursal'] }],
      margenPorProducto: { 1: 50, 11: 50, 777: 50 }, presentacionesTemporales: { 4409: [{ id: 't-a', pesoG: 250, markupPct: 25 }] } },
    pesables: { formulas: { 11: { granel: 4409 } } },
    recetas: { productos: { p: { presentaciones: { 777: {} } } } },
  };
  const escrituras = [];
  let archivo = DATOS.costeo;
  crearRutasPrecios({
    apiRoute: fn => fn, query: async () => [], DATA_DIR: '/tmp', LISTA_PRECIOS_VENTA: 1,
    leerJSON: p => (p.endsWith('pesables_listas.json') ? DATOS.pesables : p.endsWith('recetas_produccion.json') ? DATOS.recetas : archivo),
    guardarJSON: (p, d) => { escrituras.push([p, d]); if (p.endsWith('costeo.json')) archivo = d; },
  });
  assert.strictEqual(escrituras.length, 2);
  assert.match(escrituras[0][0], /costeo\.json\.bak-antes-ganancia$/);
  assert.deepStrictEqual(escrituras[0][1], DATOS.costeo);
  // G = 20 % para los tres tipos (sin departamentos): g = 1,5 × 0,8 − 1 = 20 %; temporal 1,25 × 0,8 − 1 = 0
  assert.deepStrictEqual(archivo.margenPorProducto, { 1: 20, 11: 20, 777: 20 });
  assert.deepStrictEqual(archivo.presentacionesTemporales, { 4409: [{ id: 't-a', pesoG: 250, gananciaPct: 0 }] });
  assert.strictEqual(archivo.margenPropio, 'ganancia');
  // Mismo precio que antes: precio neto = C(1 + m) = C ÷ (1 − G) × (1 + g).
  const fila = calcularFilaAlmacen({ plu: '1', nombre: 'X', costoSistema: 1000, precioVigente: null, costeoConfig: archivo });
  assert.strictEqual(fila.precioNeto, 1500);
  // Segunda vez: nada.
  escrituras.length = 0;
  crearRutasPrecios({ apiRoute: fn => fn, query: async () => [], DATA_DIR: '/tmp', LISTA_PRECIOS_VENTA: 1,
    leerJSON: p => (p.endsWith('costeo.json') ? archivo : {}), guardarJSON: (p, d) => escrituras.push([p, d]) });
  assert.deepStrictEqual(escrituras, []);
});

// ── Producción sin departamentos (spec Parte E.2) ────────────────────────────

test('venta-base/actualizar con Producción sin departamentos (default): Producción = variables y sin aviso', async () => {
  const query = async sql => (/OUTER APPLY/.test(sql) ? [] : [{ Tipo: 'almacen', Importe: 30000000 }, { Tipo: 'fraccionado', Importe: 9000000 }]);
  const { llamar } = routerConArchivo({ ...ARCHIVO_CURVAS, departamentos: [{ id: 'adm', ...DEPTO_ADM }] }, query);
  const r = await llamar('post', '/api/precios/costos/venta-base/actualizar', { meses: 3 });
  assert.strictEqual(r.gastosVentaPctPorTipo.produccion, 0);
  assert.strictEqual(r.aviso, null);
  assert.strictEqual(r.ventaBase.produccionSinDepartamentos, true);
});

test('PUT config/departamentos: activar Producción sin departamentos con mantener precios reescala sólo Producción; sin flag en el body se conserva', async () => {
  const archivo = { ...ARCHIVO_CURVAS, margenPropio: 'ganancia', departamentos: [{ id: 'adm', ...DEPTO_ADM }], ventaBase: VENTA_MANUAL, margenPorProducto: { 11: 5, 777: 30 } };
  const crearRutasPrecios = require('../routes/rutas_precios');
  const estado = { archivo };
  const router = crearRutasPrecios({
    apiRoute: fn => async (req, res) => res.json(await fn(req)), query: async () => [],
    leerJSON: p => (p.endsWith('recetas_produccion.json') ? { productos: { p: { presentaciones: { 777: {} } } } } : p.endsWith('costeo.json') ? estado.archivo : {}),
    guardarJSON: (p, d) => { if (p.endsWith('costeo.json')) estado.archivo = d; }, DATA_DIR: '/tmp', LISTA_PRECIOS_VENTA: 1,
  });
  const layer = router.stack.find(l => l.route && l.route.methods.put && l.match('/api/precios/config/departamentos'));
  const put = body => new Promise(ok => layer.route.stack[0].handle({ params: {}, body, query: {} }, { json: ok }));
  // Producción: 200000 / 4M = 5 % de departamentos → 0 con el flag.
  const r = await put({ items: [{ id: 'adm', ...DEPTO_ADM }], ventaBase: { ...VENTA_MANUAL, produccionSinDepartamentos: true } });
  assert.strictEqual(r.error, undefined);
  assert.deepStrictEqual(r.gastosVentaPctPorTipo, { almacen: 5, fraccionado: 5, produccion: 0 });
  assertReescalada(r.curvaGanancia.produccion, ARCHIVO_CURVAS.curvaGanancia.produccion, 1 / 0.95);
  assert.deepStrictEqual(estado.archivo.curvaGanancia.almacen, ARCHIVO_CURVAS.curvaGanancia.almacen);
  casi(markupCurva(r.curvaGanancia.produccion, 2000, 0), markupDesdeGanancia(30, 5)); // mismo precio
  casi(markupDesdeGanancia(estado.archivo.margenPorProducto[777], 0), markupDesdeGanancia(30, 5));
  assert.strictEqual(estado.archivo.margenPorProducto[11], 5);
  // Guardar sin el flag en el body lo conserva.
  const { produccionSinDepartamentos: _x, ...sinFlag } = VENTA_MANUAL;
  await put({ items: [{ id: 'adm', ...DEPTO_ADM }], ventaBase: sinFlag });
  assert.strictEqual(estado.archivo.ventaBase.produccionSinDepartamentos, true);
});

test('crear el router: archivo sin el flag con departamentos de Producción → migra manteniendo precios (backup); una sola vez', () => {
  const crearRutasPrecios = require('../routes/rutas_precios');
  const venta = { meses: 3, manual: { almacen: 10000000, fraccionado: 6000000, produccion: 4000000 } };
  let archivo = { ...ARCHIVO_CURVAS, margenPropio: 'ganancia', departamentos: [{ id: 'adm', ...DEPTO_ADM }], ventaBase: venta };
  const escrituras = [];
  const crear = () => crearRutasPrecios({ apiRoute: fn => fn, query: async () => [], DATA_DIR: '/tmp', LISTA_PRECIOS_VENTA: 1,
    leerJSON: p => (p.endsWith('costeo.json') ? archivo : {}),
    guardarJSON: (p, d) => { escrituras.push(p); if (p.endsWith('costeo.json')) archivo = d; } });
  crear();
  assert.deepStrictEqual(escrituras.map(p => path.basename(p)), ['costeo.json.bak-antes-prod-sin-deptos', 'costeo.json']);
  assert.strictEqual(archivo.ventaBase.produccionSinDepartamentos, true);
  assertReescalada(archivo.curvaGanancia.produccion, ARCHIVO_CURVAS.curvaGanancia.produccion, 1 / 0.95);
  escrituras.length = 0;
  crear();
  assert.deepStrictEqual(escrituras, []);
});

// ── Márgenes propios → curva (spec Parte E.1) ────────────────────────────────

test('margenes-propios: GET cuenta por tipo; previsualizar no escribe; aplicar acerca exacto el tope, backup y mismo resumen', async () => {
  // Reventa 6051: costo neto 1000 (1210 con IVA 21), curva plana 20 %; propia 50 % → standard 20 % baja 20 % > tope.
  const query = async sql => (sql.includes("NombreRubro = 'Almacen'") ? [{ IdProducto: '6051', NombreProducto: 'PEPAS', CostoSistema: 1210, IvaCompraPct: 21 }] : []);
  const archivo = { ...ARCHIVO_CURVAS, margenPropio: 'ganancia', curvaGanancia: { ...ARCHIVO_CURVAS.curvaGanancia, almacen: curvaPlana(20) },
    margenPorProducto: { 6051: 50, 999: 10 } };
  const crearRutasPrecios = require('../routes/rutas_precios');
  const estado = { archivo };
  const escrituras = [];
  const router = crearRutasPrecios({
    apiRoute: fn => async (req, res) => res.json(await fn(req)), query, DATA_DIR: '/tmp', LISTA_PRECIOS_VENTA: 1,
    FORMULA_ACTIVA_SQL: '1=1', SIN_FORMULA_GENERICO_SQL: '1=1',
    leerJSON: p => (p.endsWith('costeo.json') ? estado.archivo : {}),
    guardarJSON: (p, d) => { escrituras.push(path.basename(p)); if (p.endsWith('costeo.json')) estado.archivo = d; },
  });
  const llamar = (method, ruta, body) => {
    const layer = router.stack.find(l => l.route && l.route.methods[method] && l.match(ruta));
    return new Promise(ok => layer.route.stack[0].handle({ params: layer.params, body, query: {} }, { json: ok }));
  };
  const c = await llamar('get', '/api/precios/margenes-propios');
  assert.deepStrictEqual(c.porTipo, { almacen: 2, fraccionado: 0, produccion: 0 });
  assert.strictEqual(c.topeDefaultPct, 5);
  const p = await llamar('post', '/api/precios/margenes-propios/previsualizar', { topePct: 5 });
  assert.deepStrictEqual(p.totales, { standard: 0, acercar: 1, sinCambio: 1 });
  assert.strictEqual(p.motivosSinCambio.sinListado, 1); // 999 no está en ningún listado
  assert.strictEqual(p.cambios, undefined);
  assert.strictEqual(p.top[0].plu, '6051');
  assert.strictEqual(p.top[0].deltaPct, -5);
  assert.deepStrictEqual(escrituras, []); // previsualizar no escribe
  assert.match((await llamar('post', '/api/precios/margenes-propios/previsualizar', { topePct: 60 })).error, /topePct/);
  const a = await llamar('post', '/api/precios/margenes-propios/aplicar', {});
  assert.deepStrictEqual(a.totales, p.totales);
  assert.strictEqual(a.aplicados, 1);
  assert.match(escrituras[0], /^costeo\.json\.bak-margenes-\d{8}-\d{4}$/);
  casi(estado.archivo.margenPorProducto[6051], 42.5); // 1,5 × 0,95 − 1
  assert.strictEqual(estado.archivo.margenPorProducto[999], 10);
  // Repetir: sigue acercando hasta pasar al standard (borrar la propia).
  for (let i = 0; i < 6; i++) await llamar('post', '/api/precios/margenes-propios/aplicar', { topePct: 5 });
  assert.ok(!('6051' in estado.archivo.margenPorProducto));
});
