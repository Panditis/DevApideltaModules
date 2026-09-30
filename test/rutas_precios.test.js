'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { calcularFilaAlmacen, aplicarMarcados, markupsAlineadosConSiga, armarGruposFraccionado, MARKUP_FRACCIONADO_DEFAULT } = require('../routes/rutas_precios');
const { markupParaPrecio } = require('../lib/precios_costeo');

const CFG_BASE = {
  toleranciaPct: 10,
  costosVariosPctAlmacen: 3,
  bandasMarkup: { almacen: [
    { costoHastaARS: 1000, markupMaxPct: 40 },
    { costoHastaARS: null, markupMaxPct: 15 },
  ] },
  margenPorProducto: {},
};

// ── calcularFilaAlmacen ──────────────────────────────────────────────────────
// Pura: sin SQL, sin fs. Cubre lo que listado/detalle arman a partir de las dos
// queries (costo de mercadería + precio vigente) ya resueltas.

// Regla 2026-09-30: costo de SIGA tal cual y precio final = costo × (1 + markup), sin ×1,21.
test('calcularFilaAlmacen: banda por costo, sin IVA de venta; sugerido muy por encima del vigente → subir', () => {
  const fila = calcularFilaAlmacen({
    plu: '1', nombre: 'Arroz', costoSistema: 500, precioVigente: 500,
    costeoConfig: CFG_BASE,
  });
  // costoTotal = 500 * 1.03 = 515, precioNeto = 515*1.4 = 721, precioConIva = 721 → 700 (múltiplo de 50)
  assert.strictEqual(fila.costoTotal, 515);
  assert.strictEqual(fila.markupPct, 40);
  assert.strictEqual(fila.banda, 'hasta 1000');
  assert.strictEqual(fila.precioNeto, 721);
  assert.strictEqual(fila.precioConIva, 700);
  assert.strictEqual(fila.precioVigente, 500);
  assert.deepStrictEqual(fila.faltantes, []);
  // sugerido (700) 40% por encima del vigente (500): hay que subir el precio
  assert.strictEqual(fila.deltaPct, 40);
  assert.strictEqual(fila.semaforo, 'subir');
});

test('calcularFilaAlmacen: precioVigente alineado con precioConIva da ok', () => {
  const fila = calcularFilaAlmacen({
    plu: '2', nombre: 'Fideos', costoSistema: 500, precioVigente: 700, // sugerido 721 → 700
    costeoConfig: CFG_BASE,
  });
  assert.strictEqual(fila.deltaPct, 0);
  assert.strictEqual(fila.semaforo, 'ok');
});

test('calcularFilaAlmacen: margenPorProducto (override) gana sobre la banda por costo', () => {
  const cfg = { ...CFG_BASE, margenPorProducto: { '3': 20 } };
  const fila = calcularFilaAlmacen({
    plu: '3', nombre: 'Yerba', costoSistema: 500, precioVigente: null, costeoConfig: cfg,
  });
  assert.strictEqual(fila.markupPct, 20);
  assert.strictEqual(fila.banda, 'override');
  // el detalle necesita ambos: el override vigente y lo que daría la banda sin él
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
  // 2000 * 1.03 = 2060 → banda "sin tope" 15% → 2369 (sin ×1,21) → 2350
  assert.strictEqual(fila.costoTotal, 2060);
  assert.strictEqual(fila.markupPct, 15);
  assert.strictEqual(fila.precioConIva, 2350);
  assert.strictEqual(fila.costosVariosPct, 3);
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

test('calcularFilaAlmacen: por defecto usa el costo de SIGA (PrecioCosto tal cual)', () => {
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

test('calcularFilaAlmacen: sin override, markupOverride es null y markupBanda es el de la banda', () => {
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
  assert.deepStrictEqual(fila.faltantes, ['costoMercaderia']);
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
  // el costeo en sí no se ve afectado por la falta de precio vigente (721 → 700)
  assert.strictEqual(fila.precioConIva, 700);
});

test('calcularFilaAlmacen: diferencia negativa fuera de tolerancia → bajar; dentro → ok', () => {
  // sugerido 700 (721 → 700); vigente 820: (700 − 820) / 820 = −14,6 %
  const bajar = calcularFilaAlmacen({ plu: '13', nombre: 'C', costoSistema: 500, precioVigente: 820, costeoConfig: CFG_BASE });
  assert.strictEqual(bajar.deltaPct, -14.6);
  assert.strictEqual(bajar.semaforo, 'bajar');
  const ok = calcularFilaAlmacen({ plu: '13', nombre: 'C', costoSistema: 500, precioVigente: 820, costeoConfig: { ...CFG_BASE, toleranciaPct: 15 } });
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
  const markup = markupParaPrecio(1030, 2470); // costoTotal = 1000 * 1.03
  const cfg = { ...CFG_BASE, margenPorProducto: { '20': markup } };
  const alineado = calcularFilaAlmacen({ plu: '20', nombre: 'A', costoSistema: 1000, precioVigente: 2470, costeoConfig: cfg });
  assert.strictEqual(alineado.precioConIva, 2470);
  assert.strictEqual(alineado.deltaPct, 0);
  assert.strictEqual(alineado.semaforo, 'ok');
  const subio = calcularFilaAlmacen({ plu: '20', nombre: 'A', costoSistema: 1100, precioVigente: 2470, costeoConfig: { ...cfg, toleranciaPct: 0 } });
  assert.strictEqual(subio.precioConIva % 50, 0);
  assert.strictEqual(subio.semaforo, 'subir');
});

test('markupsAlineadosConSiga: markup por plu con datos, cuenta sin datos y negativos', () => {
  const r = markupsAlineadosConSiga([
    { plu: '1', costoTotal: 1000, precioVigente: 1452 },
    { plu: '2', costoTotal: 1000, precioVigente: 900 },
    { plu: '3', costoTotal: null, precioVigente: 500 },
    { plu: '4', costoTotal: 500, precioVigente: null },
    { plu: '5', costoTotal: 500, precioVigente: 0 },
  ]);
  assert.deepStrictEqual(Object.keys(r.markups), ['1', '2']);
  assert.strictEqual(r.markups['1'], 45.2); // 1452 / 1000 − 1 (sin /1,21); '2': 900 / 1000 − 1 = −10
  assert.ok(r.markups['2'] < 0);
  assert.strictEqual(r.alineados, 2);
  assert.strictEqual(r.sinDatos, 3);
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
// Mismo shape que el universo Almacén (costoMercaderia = última compra valorizada; costoSistema tal cual).
const COSTOS = new Map([
  ['4409', { nombre: 'Sem. Lino Granel', costoMercaderia: 2500, costoSistema: 2297, costoSistemaConIva: 2297,
    ivaCompraPct: 21, ivaCompraSupuesto: false, proveedor: 'Prov', fechaUltimaCompra: '2026-09-01', ingresoHoy: true }],
  ['5000', { nombre: 'Garrapiñadas Granel', costoMercaderia: null, costoSistema: null, costoSistemaConIva: null,
    ivaCompraPct: 21, ivaCompraSupuesto: true, proveedor: null, fechaUltimaCompra: null, ingresoHoy: false }],
]);

function armar(extra = {}) {
  return armarGruposFraccionado({
    graneles: GRANELES, presentaciones: PRESENTACIONES, formulas: FORMULAS, costos: COSTOS,
    // 11: vigente = neto exacto de 500G (2297 × 1,6832 = 3866.31, sin ×1,21) → alineado.
    vigentes: new Map([['11', 3866], ['12', 3000]]),
    costeoConfig: { toleranciaPct: 10, margenPorProducto: {}, ...extra },
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
  assert.strictEqual(lino.banda, 0);
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

test('armarGruposFraccionado: margen standard por costo × peso (Excel) y precio por kg; alineado exacto respeta el vigente', () => {
  const [p500, p1k] = grupo(armar(), '4409').presentaciones;
  assert.strictEqual(p500.pesoG, 500);
  assert.strictEqual(p500.presentacion, '500G');
  assert.strictEqual(p500.markupStd, 68.32);
  assert.strictEqual(p500.markupOverride, null);
  assert.strictEqual(p500.markupPct, 68.32);
  assert.strictEqual(p500.precioNeto, 3866.31);
  assert.strictEqual(p500.precioConIva, 3866); // |3866.31 − 3866| < 0,5 → respeta el vigente
  assert.strictEqual(p500.precioVigente, 3866);
  assert.strictEqual(p500.semaforo, 'ok');
  assert.strictEqual(p1k.presentacion, '1KG');
  assert.strictEqual(p1k.markupStd, 60.3);
  assert.strictEqual(p1k.precioConIva, 3700); // 2297 × 1.603 = 3682.09 (sin ×1,21) → 3700
  assert.strictEqual(p1k.semaforo, 'subir');   // vigente 3000
});

test('armarGruposFraccionado: override por presentación pisa el standard; matriz propia de costeo.json', () => {
  const [p500] = grupo(armar({ margenPorProducto: { 11: 100 } }), '4409').presentaciones;
  assert.strictEqual(p500.markupStd, 68.32);
  assert.strictEqual(p500.markupOverride, 100);
  assert.strictEqual(p500.markupPct, 100);
  assert.strictEqual(p500.precioNeto, 4594);
  assert.strictEqual(p500.semaforo, 'subir');
  const matriz = { bandas: [null], tramosG: [1000], markupPct: [[10]] };
  const [q] = grupo(armar({ markupFraccionado: matriz }), '4409').presentaciones;
  assert.strictEqual(q.markupStd, 10);
});

test('armarGruposFraccionado: granel sin costo → faltante costoGranel, sin precio ni margen standard', () => {
  const [p] = grupo(armar(), '5000').presentaciones;
  assert.deepStrictEqual(p.faltantes, ['costoGranel']);
  assert.strictEqual(p.markupStd, null);
  assert.strictEqual(p.precioConIva, null);
  assert.strictEqual(p.semaforo, null);
  assert.strictEqual(grupo(armar(), '5000').banda, null);
});

test('MARKUP_FRACCIONADO_DEFAULT: es válido y reproduce Garrapiñadas 150G (fila 1, tramo 200 → 78.82)', () => {
  const { validarMarkupFraccionado, markupStdFraccionado } = require('../lib/precios_costeo');
  assert.doesNotThrow(() => validarMarkupFraccionado(MARKUP_FRACCIONADO_DEFAULT));
  assert.strictEqual(markupStdFraccionado(11643.67, 150, MARKUP_FRACCIONADO_DEFAULT).markupPct, 78.82);
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
  assert.strictEqual(man.presentaciones[1].markupStd, 60.3); // banda 0 (≤ 9999)
  assert.strictEqual(man.presentaciones[1].precioNeto, 1603);
});

test('armarGruposFraccionado: costo manual de un granel sin costos en SIGA habilita precio', () => {
  const g = grupo(armar({ costoPorProducto: { 5000: 12000 } }), '5000');
  assert.strictEqual(g.costoBase, 12000);
  assert.strictEqual(g.banda, 1);
  assert.deepStrictEqual(g.presentaciones[0].faltantes, []);
  assert.strictEqual(g.presentaciones[0].markupStd, 78.82);
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
  assert.strictEqual(p1k.precioConIva, 4200);   // 4210.6 (sin ×1,21) → 4200
  // otros graneles no se ven afectados
  assert.strictEqual(grupo(armar({ costosExtraFraccionado: EXTRAS_LINO }), '6000').costoTotal, null);
});

test('armarGruposFraccionado: la banda del margen standard se busca con el costo base, no con base + extras', () => {
  const lino = grupo(armar({ costoPorProducto: { 4409: 9900 }, costosExtraFraccionado: { 4409: [{ concepto: 'E', tipo: 'kg', valor: 200 }] } }), '4409');
  assert.strictEqual(lino.costoTotal, 10100);
  assert.strictEqual(lino.banda, 0);                        // 9900 ≤ 9999, aunque el total pase el tope
  assert.strictEqual(lino.presentaciones[1].markupStd, 60.3);
  assert.strictEqual(lino.presentaciones[1].precioNeto, 16190.3);
});

test('armarGruposFraccionado: granel sin costo base con extras → costoTotal null y faltante costoGranel', () => {
  const g = grupo(armar({ costosExtraFraccionado: { 5000: [{ concepto: 'E', tipo: 'kg', valor: 200 }] } }), '5000');
  assert.strictEqual(g.costoTotal, null);
  assert.strictEqual(g.costoExtraTotal, null);
  assert.deepStrictEqual(g.presentaciones[0].faltantes, ['costoGranel']);
  assert.strictEqual(g.presentaciones[0].precioConIva, null);
});

// ── Costos extra Almacén (misma clave costosExtraFraccionado, por PLU del producto) ──
test('calcularFilaAlmacen: costos extra del producto suman al costoTotal; la banda sigue por costoBase', () => {
  const extras = [{ concepto: 'Flete', tipo: 'kg', valor: 35 }, { concepto: 'Merma', tipo: 'pct', valor: 10 }];
  const fila = calcularFilaAlmacen({
    plu: '1', nombre: 'Arroz', costoSistema: 500, precioVigente: 500,
    costeoConfig: { ...CFG_BASE, costosExtraFraccionado: { 1: extras } },
  });
  // 500 + varios 15 + flete 35 + merma 50 = 600
  assert.strictEqual(fila.costoTotal, 600);
  assert.strictEqual(fila.costoExtraTotal, 85);
  assert.deepStrictEqual(fila.costosExtra, extras);
  assert.strictEqual(fila.markupPct, 40);
  assert.strictEqual(fila.precioNeto, 840);
  assert.deepStrictEqual(fila.componentes.slice(2), [
    { concepto: 'Flete', detalle: '$', importe: 35 },
    { concepto: 'Merma', detalle: '10%', importe: 50 },
  ]);
  // costoBase 900 + 200 de extra supera 1000, pero la banda se busca por costoBase
  const alta = calcularFilaAlmacen({
    plu: '2', nombre: 'X', costoSistema: 900, precioVigente: null,
    costeoConfig: { ...CFG_BASE, costosExtraFraccionado: { 2: [{ concepto: 'E', tipo: 'kg', valor: 200 }] } },
  });
  assert.strictEqual(alta.banda, 'hasta 1000');
  assert.strictEqual(alta.costoTotal, 1127);
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
  const { markups } = markupsAlineadosConSiga([fila]);
  assert.strictEqual(markups['1'], markupParaPrecio(600, 1000));
});

// ── Presentaciones temporales ────────────────────────────────────────────────
test('armarGruposFraccionado: temporales calculadas como una presentación real, sin vigente ni marcado', () => {
  const gs = armar({ presentacionesTemporales: { 4409: [
    { id: 't-b', pesoG: 1000, markupPct: 100, nombre: 'Bolsa grande' },
    { id: 't-a', pesoG: 500, markupPct: null },
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
  assert.strictEqual(t500.precioConIva, 3850);  // 3866.31 → múltiplo de 50 (no hay vigente que respetar)
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
  const [t] = grupo(armar({ presentacionesTemporales: { 5000: [{ id: 't-x', pesoG: 150, markupPct: null }] } }), '5000').temporales;
  assert.deepStrictEqual(t.faltantes, ['costoGranel']);
  assert.strictEqual(t.precioConIva, null);
  assert.strictEqual(t.markupStd, null);
});

test('alinear con SIGA / exportación: las temporales no entran (sólo presentaciones reales)', () => {
  const gs = armar({ presentacionesTemporales: { 4409: [{ id: 't-a', pesoG: 500, markupPct: null }] } });
  const filas = gs.flatMap(g => g.presentaciones.map(p => ({ plu: p.plu, costoTotal: g.costoTotal, precioVigente: p.precioVigente })));
  assert.ok(!filas.some(f => f.plu == null));
  assert.ok(!markupsAlineadosConSiga(filas).markups[undefined]);
});

test('aplicarTemporal: crear / editar / borrar sin mutar el mapa; límites y errores', () => {
  const { aplicarTemporal, TEMPORALES_MAX } = require('../routes/rutas_precios');
  const base = { 4409: [{ id: 't-1', pesoG: 250, markupPct: null }] };
  const c = aplicarTemporal(base, '4409', { op: 'crear', id: 't-2', datos: { pesoG: 500, markupPct: 40 } });
  assert.deepStrictEqual(c.item, { id: 't-2', pesoG: 500, markupPct: 40 });
  assert.strictEqual(c.mapa['4409'].length, 2);
  assert.strictEqual(base['4409'].length, 1); // no muta
  const n = aplicarTemporal({}, '77', { op: 'crear', id: 't-9', datos: { pesoG: 30, markupPct: null, nombre: 'Muestra' } });
  assert.deepStrictEqual(n.mapa, { 77: [{ id: 't-9', pesoG: 30, markupPct: null, nombre: 'Muestra' }] });

  const e = aplicarTemporal(c.mapa, '4409', { op: 'editar', id: 't-2', datos: { markupPct: null, nombre: 'X' } });
  assert.deepStrictEqual(e.item, { id: 't-2', pesoG: 500, markupPct: null, nombre: 'X' });
  const sinNombre = aplicarTemporal(e.mapa, '4409', { op: 'editar', id: 't-2', datos: { nombre: null } });
  assert.deepStrictEqual(sinNombre.item, { id: 't-2', pesoG: 500, markupPct: null });
  assert.strictEqual(e.mapa['4409'][1].nombre, 'X'); // no muta

  const b = aplicarTemporal(base, '4409', { op: 'borrar', id: 't-1' });
  assert.deepStrictEqual(b.mapa, {}); // la última borra la entrada del granel

  assert.match(aplicarTemporal(base, '4409', { op: 'editar', id: 't-nope', datos: { pesoG: 1 } }).error, /no encontrada/);
  assert.match(aplicarTemporal(base, '1', { op: 'borrar', id: 't-1' }).error, /no encontrada/);
  const lleno = { 1: Array.from({ length: TEMPORALES_MAX }, (_, i) => ({ id: 't-' + i, pesoG: 100, markupPct: null })) };
  assert.match(aplicarTemporal(lleno, '1', { op: 'crear', id: 't-z', datos: { pesoG: 1, markupPct: null } }).error, /máximo 30/);
});

test('endpoints presentaciones-temporales: POST crea (id del server), PUT edita, DELETE borra; validan PLU/id/body', async () => {
  const crearRutasPrecios = require('../routes/rutas_precios');
  let archivo = { presentacionesTemporales: {}, margenPorProducto: { 11: 5 } };
  const router = crearRutasPrecios({
    apiRoute: fn => async (req, res) => res.json(await fn(req)),
    query: async () => [], leerJSON: () => archivo, guardarJSON: (_p, d) => { archivo = d; },
    DATA_DIR: '/tmp', LISTA_PRECIOS_VENTA: 1,
  });
  const llamar = (method, ruta, body) => {
    const layer = router.stack.find(l => l.route && l.route.methods[method] && l.match(ruta));
    return new Promise(resolve => layer.route.stack[0].handle({ params: layer.params, body, query: {} }, { json: resolve }));
  };
  const c = await llamar('post', '/api/precios/presentaciones-temporales/4409', { pesoG: 250, markupPct: null, nombre: 'Prueba' });
  assert.match(c.temporal.id, /^t-[a-z0-9]+$/);
  assert.deepStrictEqual(archivo.presentacionesTemporales['4409'], [c.temporal]);
  assert.deepStrictEqual(archivo.margenPorProducto, { 11: 5 }); // no toca otras claves
  const id = c.temporal.id;
  const e = await llamar('put', `/api/precios/presentaciones-temporales/4409/${id}`, { markupPct: 42, nombre: '' });
  assert.deepStrictEqual(e.temporal, { id, pesoG: 250, markupPct: 42 });
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
    leerJSON: () => ({ toleranciaPct: 10, bandasMarkup: { almacen: [{ costoHastaARS: null, markupMaxPct: 100 }] }, packBulto: { descBultoPct: 20 } }),
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
        // factura hoy: 1000 + 21 % = 1210; anterior por cotización: 1100 tal cual → Δ = 110 / 1100 = +10 %
        { IdProducto: '6051', PrecioNeto: 1000, PorcentajeIVA: 21, Tipo: 'FACTCOM', Proveedor: 'Prov SA', Letra: 'A',
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
    leerJSON: () => ({ toleranciaPct: 2, bandasMarkup: { almacen: [{ costoHastaARS: null, markupMaxPct: 100 }] } }),
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
  // Columnas fijas del listado: costo de sistema tal cual (PrecioCosto de SIGA) y última compra.
  assert.strictEqual(de('6051').costoSistema, 1210);
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
    costos, vigentes: new Map(), costeoConfig: { toleranciaPct: 10 },
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

test('armarGruposFraccionado: mano de obra de fraccionado (min × costoHora/60 ÷ kg) se suma al $/kg; override por presentación', () => {
  // costoHora 6000 → $100/min. Standard 2 min: 500G → $200/u = $400/kg; 1Kg → $200/kg. Override 12: 1Kg → 3 min = $300/kg.
  const gs = armar({ costoHora: 6000, minutosFraccionadoStd: 2, minutosFraccionado: { 12: 3 } });
  const [p500, p1k] = grupo(gs, '4409').presentaciones;
  assert.strictEqual(p500.minutosStd, 2);
  assert.strictEqual(p500.minutosOverride, null);
  assert.strictEqual(p500.costoMoKg, 400);
  assert.strictEqual(p500.costoKg, 2697);        // 2297 + 400
  assert.strictEqual(p500.precioNeto, 4539.59); // 2697 × 1.6832
  assert.strictEqual(p1k.minutosOverride, 3);
  assert.strictEqual(p1k.costoMoKg, 300);
  assert.strictEqual(p1k.costoKg, 2597);
  const sinMo = grupo(armar(), '4409').presentaciones[0];
  assert.strictEqual(sinMo.costoMoKg, 0);
  assert.strictEqual(sinMo.costoKg, 2297);
});

test('armarGruposFraccionado: MO sin peso en el nombre → faltante pesoMo; VD que es su propio granel no lleva MO', () => {
  const costos = new Map([...COSTOS, ['1580', { nombre: 'Mix 1Kg', costoMercaderia: null, costoSistema: 3000 }]]);
  const gs = armarGruposFraccionado({
    graneles: GRANELES,
    presentaciones: [{ plu: '11', nombre: 'Sem. Lino Suelto' }, { plu: '1580', nombre: 'Mix 1Kg', ventaDirecta: true }],
    formulas: FORMULAS, costos, vigentes: new Map(),
    costeoConfig: { toleranciaPct: 10, costoHora: 6000, minutosFraccionadoStd: 2 },
  });
  const suelto = grupo(gs, '4409').presentaciones[0];
  assert.deepStrictEqual(suelto.faltantes, ['pesoMo']);
  assert.strictEqual(suelto.precioConIva, null);
  const mix = grupo(gs, '1580').presentaciones[0];
  assert.strictEqual(mix.minutosStd, 0);
  assert.strictEqual(mix.costoKg, 3000);
});

test('armarGruposFraccionado: temporales llevan la MO standard según su peso', () => {
  const gs = armar({ costoHora: 6000, minutosFraccionadoStd: 1, presentacionesTemporales: { 4409: [{ id: 't1', pesoG: 50 }] } });
  const [t] = grupo(gs, '4409').temporales;
  assert.strictEqual(t.costoMoKg, 2000); // $100 / 0,05 kg
  assert.strictEqual(t.costoKg, 4297);
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

test('calcularFilaAlmacen: con gastos 26.09 la banda (ganancia 15) da markup 55.594642; expone gananciaBanda y gastosVentaPct', () => {
  const fila = calcularFilaAlmacen({
    plu: '1', nombre: 'Arroz', costoSistema: 2000, precioVigente: null,
    costeoConfig: { ...CFG_BASE, gastosVenta: GASTOS_2609 },
  });
  assert.strictEqual(fila.gananciaBanda, 15);
  assert.strictEqual(fila.gastosVentaPct, 26.09);
  assert.strictEqual(fila.markupBanda, 55.594642);
  assert.strictEqual(fila.markupPct, 55.594642);
  assert.strictEqual(fila.banda, 'sin tope');
  assert.strictEqual(fila.precioNeto, 3205.25); // 2060 × 1.55594642
});

test('calcularFilaAlmacen: el override por producto es markup total y no se convierte; sin gastos gananciaBanda = markupBanda', () => {
  const fila = calcularFilaAlmacen({
    plu: '1', nombre: 'Arroz', costoSistema: 2000, precioVigente: null,
    costeoConfig: { ...CFG_BASE, gastosVenta: GASTOS_2609, margenPorProducto: { 1: 40 } },
  });
  assert.strictEqual(fila.markupPct, 40);
  assert.strictEqual(fila.banda, 'override');
  assert.strictEqual(fila.markupBanda, 55.594642);
  const sin = calcularFilaAlmacen({ plu: '1', nombre: 'Arroz', costoSistema: 2000, precioVigente: null, costeoConfig: CFG_BASE });
  assert.strictEqual(sin.gastosVentaPct, 0);
  assert.strictEqual(sin.gananciaBanda, 15);
  assert.strictEqual(sin.markupBanda, 15);
});

test('armarGruposFraccionado: con gastos la celda de la matriz es ganancia (gananciaStd) y markupStd la convierte; override intacto', () => {
  const [p500] = grupo(armar({ gastosVenta: GASTOS_2609 }), '4409').presentaciones;
  assert.strictEqual(p500.gananciaStd, 68.32);
  assert.strictEqual(p500.markupStd, 127.736436);
  assert.strictEqual(p500.markupPct, 127.736436);
  assert.strictEqual(p500.precioNeto, 5231.11);
  const [ov] = grupo(armar({ gastosVenta: GASTOS_2609, margenPorProducto: { 11: 100 } }), '4409').presentaciones;
  assert.strictEqual(ov.markupPct, 100);
  const [sin] = grupo(armar(), '4409').presentaciones;
  assert.strictEqual(sin.gananciaStd, 68.32);
  assert.strictEqual(sin.markupStd, 68.32);
});

test('armarGruposFraccionado: temporales convierten la ganancia standard con los mismos gastos', () => {
  const gs = armar({ gastosVenta: GASTOS_2609, presentacionesTemporales: { 4409: [{ id: 't-a', pesoG: 500, markupPct: null }] } });
  const [t] = grupo(gs, '4409').temporales;
  assert.strictEqual(t.gananciaStd, 68.32);
  assert.strictEqual(t.markupStd, 127.736436);
  assert.strictEqual(t.precioNeto, 5231.11);
});

// ── Insumos básicos de Fraccionado ($ por unidad ÷ kg, mismo patrón que la MO) ──

test('armarGruposFraccionado: insumos $/u ÷ kg se suman al costoKg; override por presentación; junto con la MO', () => {
  const gs = armar({ insumosFraccionadoStd: 100, insumosFraccionado: { 12: 50 } });
  const [p500, p1k] = grupo(gs, '4409').presentaciones;
  assert.strictEqual(p500.insumosStd, 100);
  assert.strictEqual(p500.insumosOverride, null);
  assert.strictEqual(p500.insumos, 100);
  assert.strictEqual(p500.costoInsumosKg, 200); // $100 / 0,5 kg
  assert.strictEqual(p500.costoKg, 2497);
  assert.strictEqual(p1k.insumosOverride, 50);
  assert.strictEqual(p1k.insumos, 50);
  assert.strictEqual(p1k.costoInsumosKg, 50);
  assert.strictEqual(p1k.costoKg, 2347);
  const [conMo] = grupo(armar({ insumosFraccionadoStd: 100, costoHora: 6000, minutosFraccionadoStd: 2 }), '4409').presentaciones;
  assert.strictEqual(conMo.costoKg, 2897); // 2297 + 400 MO + 200 insumos
  const [sinIns] = grupo(armar(), '4409').presentaciones;
  assert.strictEqual(sinIns.costoInsumosKg, 0);
  assert.strictEqual(sinIns.insumosStd, 0);
});

test('armarGruposFraccionado: insumos sin peso en el nombre → faltante pesoMo; VD que es su propio granel no lleva insumos', () => {
  const costos = new Map([...COSTOS, ['1580', { nombre: 'Mix 1Kg', costoMercaderia: null, costoSistema: 3000 }]]);
  const gs = armarGruposFraccionado({
    graneles: GRANELES,
    presentaciones: [{ plu: '11', nombre: 'Sem. Lino Suelto' }, { plu: '1580', nombre: 'Mix 1Kg', ventaDirecta: true }],
    formulas: FORMULAS, costos, vigentes: new Map(),
    costeoConfig: { toleranciaPct: 10, insumosFraccionadoStd: 100 },
  });
  const suelto = grupo(gs, '4409').presentaciones[0];
  assert.strictEqual(suelto.costoInsumosKg, null);
  assert.deepStrictEqual(suelto.faltantes, ['pesoMo']);
  assert.strictEqual(suelto.precioConIva, null);
  const mix = grupo(gs, '1580').presentaciones[0];
  assert.strictEqual(mix.insumosStd, 0);
  assert.strictEqual(mix.costoInsumosKg, 0);
  assert.strictEqual(mix.costoKg, 3000);
});

test('armarGruposFraccionado: temporales llevan los insumos standard según su peso', () => {
  const gs = armar({ insumosFraccionadoStd: 10, insumosFraccionado: { 11: 99 }, presentacionesTemporales: { 4409: [{ id: 't1', pesoG: 50 }] } });
  const [t] = grupo(gs, '4409').temporales;
  assert.strictEqual(t.costoInsumosKg, 200); // $10 / 0,05 kg
  assert.strictEqual(t.costoKg, 2497);
});

// ── Endpoints: config de gastos sobre venta e insumos de fraccionado ─────────

function routerConArchivo(inicial) {
  const crearRutasPrecios = require('../routes/rutas_precios');
  const estado = { archivo: inicial };
  const router = crearRutasPrecios({
    apiRoute: fn => async (req, res) => res.json(await fn(req)),
    query: async () => [], leerJSON: () => estado.archivo, guardarJSON: (_p, d) => { estado.archivo = d; },
    DATA_DIR: '/tmp', LISTA_PRECIOS_VENTA: 1,
  });
  const llamar = (method, ruta, body) => {
    const layer = router.stack.find(l => l.route && l.route.methods[method] && l.match(ruta));
    return new Promise(resolve => layer.route.stack[0].handle({ params: layer.params, body, query: {} }, { json: resolve }));
  };
  return { estado, llamar };
}

const ARCHIVO_BANDAS = {
  toleranciaPct: 10, margenPorProducto: { 11: 5 },
  bandasMarkup: { almacen: [{ costoHastaARS: 1000, markupMaxPct: 40 }, { costoHastaARS: null, markupMaxPct: 15 }], fraccionado: [], produccion: [] },
};

test('GET config: expone gastosVenta, gastosVentaPct e insumosFraccionadoStd (defaults vacíos)', async () => {
  const { llamar } = routerConArchivo({ ...ARCHIVO_BANDAS });
  const c = await llamar('get', '/api/precios/config');
  assert.deepStrictEqual(c.gastosVenta, []);
  assert.strictEqual(c.gastosVentaPct, 0);
  assert.strictEqual(c.insumosFraccionadoStd, 0);
  const { llamar: l2 } = routerConArchivo({ ...ARCHIVO_BANDAS, gastosVenta: GASTOS_2609, insumosFraccionadoStd: 30 });
  const c2 = await l2('get', '/api/precios/config');
  assert.strictEqual(c2.gastosVentaPct, 26.09);
  assert.strictEqual(c2.insumosFraccionadoStd, 30);
});

test('PUT config/gastos-venta: conservando precios reescala bandas y matriz para que el markup total no cambie', async () => {
  const { markupDesdeGanancia } = require('../lib/precios_costeo');
  const { estado, llamar } = routerConArchivo({ ...ARCHIVO_BANDAS });
  const r = await llamar('put', '/api/precios/config/gastos-venta', { items: [{ concepto: 'GOA', pct: 15 }, { concepto: 'Resto', pct: 11.09 }] });
  assert.strictEqual(r.error, undefined);
  assert.strictEqual(r.gastosVentaPct, 26.09);
  assert.deepStrictEqual(r.gastosVenta.map(g => g.id), ['goa', 'resto']);
  assert.ok(Math.abs(markupDesdeGanancia(r.bandasMarkup.almacen[1].markupMaxPct, 26.09) - 15) < 0.001);
  // Sin matriz propia en costeo.json se reescala la default.
  assert.ok(Math.abs(markupDesdeGanancia(r.markupFraccionado.markupPct[0][0], 26.09) - MARKUP_FRACCIONADO_DEFAULT.markupPct[0][0]) < 0.001);
  assert.deepStrictEqual(estado.archivo.gastosVenta, r.gastosVenta);
  assert.deepStrictEqual(estado.archivo.bandasMarkup, r.bandasMarkup);
  assert.deepStrictEqual(estado.archivo.margenPorProducto, { 11: 5 }); // overrides intactos
});

test('PUT config/gastos-venta: conservarPrecios false guarda sólo los gastos; inválido no escribe', async () => {
  const { estado, llamar } = routerConArchivo({ ...ARCHIVO_BANDAS });
  const r = await llamar('put', '/api/precios/config/gastos-venta', { items: GASTOS_2609, conservarPrecios: false });
  assert.strictEqual(r.bandasMarkup.almacen[1].markupMaxPct, 15);
  assert.strictEqual(estado.archivo.gastosVentaPct, undefined); // el total no se persiste, se calcula
  assert.strictEqual(estado.archivo.gastosVenta.length, 2);
  const antes = estado.archivo;
  assert.match((await llamar('put', '/api/precios/config/gastos-venta', { items: [{ concepto: 'A', pct: 100 }] })).error, /pct|100/);
  assert.match((await llamar('put', '/api/precios/config/gastos-venta', {})).error, /lista/);
  assert.strictEqual(estado.archivo, antes);
});

test('PUT config/gastos-venta: si el reescalado deja la matriz fuera de rango, error y no escribe', async () => {
  const { estado, llamar } = routerConArchivo({ ...ARCHIVO_BANDAS });
  const r = await llamar('put', '/api/precios/config/gastos-venta', { items: [{ concepto: 'Mucho', pct: 99.5 }] }); // ganancias < −99 %
  assert.match(r.error, /markupFraccionado/);
  assert.strictEqual(estado.archivo.gastosVenta, undefined);
});

test('PUT insumos-fraccionado/:plu guarda $/u por presentación, null lo quita; valida rango y PLU', async () => {
  const { estado, llamar } = routerConArchivo({ ...ARCHIVO_BANDAS });
  assert.deepStrictEqual(await llamar('put', '/api/precios/insumos-fraccionado/12', { pesos: 35.5 }), { plu: '12', valor: 35.5 });
  assert.deepStrictEqual(estado.archivo.insumosFraccionado, { 12: 35.5 });
  assert.match((await llamar('put', '/api/precios/insumos-fraccionado/12', { pesos: -1 })).error, /inválido/);
  assert.match((await llamar('put', '/api/precios/insumos-fraccionado/12', { pesos: 10000001 })).error, /inválido/);
  assert.match((await llamar('put', '/api/precios/insumos-fraccionado/a%20b', { pesos: 1 })).error, /PLU/);
  await llamar('put', '/api/precios/insumos-fraccionado/12', { pesos: null });
  assert.deepStrictEqual(estado.archivo.insumosFraccionado, {});
});

test('PUT config/general acepta insumosFraccionadoStd (0 a 10.000.000) y lo devuelve', async () => {
  const { estado, llamar } = routerConArchivo({ ...ARCHIVO_BANDAS });
  const r = await llamar('put', '/api/precios/config/general', { insumosFraccionadoStd: 25 });
  assert.strictEqual(r.insumosFraccionadoStd, 25);
  assert.strictEqual(estado.archivo.insumosFraccionadoStd, 25);
  assert.match((await llamar('put', '/api/precios/config/general', { insumosFraccionadoStd: 10000001 })).error, /insumosFraccionadoStd/);
});
