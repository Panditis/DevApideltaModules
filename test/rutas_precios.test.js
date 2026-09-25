'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { calcularFilaAlmacen, costoSistemaSinIva, aplicarMarcados, markupsAlineadosConSiga, armarGruposFraccionado, MARKUP_FRACCIONADO_DEFAULT } = require('../routes/rutas_precios');
const { markupParaPrecio } = require('../lib/precios_costeo');

test('costoSistemaSinIva: saca el IVA con la alícuota del producto (Productos.Alicuota)', () => {
  assert.deepStrictEqual(costoSistemaSinIva(1210, 21), { costo: 1000, ivaPct: 21, ivaSupuesto: false });
  assert.deepStrictEqual(costoSistemaSinIva(1105, 10.5), { costo: 1000, ivaPct: 10.5, ivaSupuesto: false });
  // alícuota 0%: el costo de sistema ya es sin IVA
  assert.deepStrictEqual(costoSistemaSinIva(1000, 0), { costo: 1000, ivaPct: 0, ivaSupuesto: false });
});

test('costoSistemaSinIva: sin alícuota cargada en SIGA asume 21% y lo marca', () => {
  assert.deepStrictEqual(costoSistemaSinIva(1210, null), { costo: 1000, ivaPct: 21, ivaSupuesto: true });
});

test('costoSistemaSinIva: sin PrecioCosto (o 0) no hay costo de sistema', () => {
  assert.strictEqual(costoSistemaSinIva(null, 21).costo, null);
  assert.strictEqual(costoSistemaSinIva(0, 21).costo, null);
});

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

test('calcularFilaAlmacen: banda por costo + IVA; sugerido muy por encima del vigente → subir', () => {
  const fila = calcularFilaAlmacen({
    plu: '1', nombre: 'Arroz', costoSistema: 500, precioVigente: 500,
    costeoConfig: CFG_BASE,
  });
  // costoTotal = 500 * 1.03 = 515, precioNeto = 515*1.4 = 721, precioConIva = 721*1.21 = 850
  assert.strictEqual(fila.costoTotal, 515);
  assert.strictEqual(fila.markupPct, 40);
  assert.strictEqual(fila.banda, 'hasta 1000');
  assert.strictEqual(fila.precioNeto, 721);
  assert.strictEqual(fila.precioConIva, 850);
  assert.strictEqual(fila.precioVigente, 500);
  assert.deepStrictEqual(fila.faltantes, []);
  // sugerido (850) 70% por encima del vigente (500): hay que subir el precio
  assert.strictEqual(fila.deltaPct, 70);
  assert.strictEqual(fila.semaforo, 'subir');
});

test('calcularFilaAlmacen: precioVigente alineado con precioConIva da ok', () => {
  const fila = calcularFilaAlmacen({
    plu: '2', nombre: 'Fideos', costoSistema: 500, precioVigente: 850,
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
  // 2000 * 1.03 = 2060 → banda "sin tope" 15% → 2369 neto → 2866.49 c/IVA → 2850
  assert.strictEqual(fila.costoTotal, 2060);
  assert.strictEqual(fila.markupPct, 15);
  assert.strictEqual(fila.precioConIva, 2850);
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

test('calcularFilaAlmacen: por defecto usa el costo de SIGA (PrecioCosto sin IVA)', () => {
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
  // el costeo en sí no se ve afectado por la falta de precio vigente
  assert.strictEqual(fila.precioConIva, 850);
});

test('calcularFilaAlmacen: diferencia negativa fuera de tolerancia → bajar; dentro → ok', () => {
  // sugerido 850
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
    { plu: '2', costoTotal: 1000, precioVigente: 1000 },
    { plu: '3', costoTotal: null, precioVigente: 500 },
    { plu: '4', costoTotal: 500, precioVigente: null },
    { plu: '5', costoTotal: 500, precioVigente: 0 },
  ]);
  assert.deepStrictEqual(Object.keys(r.markups), ['1', '2']);
  assert.strictEqual(r.markups['1'], 20);
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
// Mismo shape que el universo Almacén (costoMercaderia = última compra neta; costoSistema sin IVA).
const COSTOS = new Map([
  ['4409', { nombre: 'Sem. Lino Granel', costoMercaderia: 2500, costoSistema: 2297, costoSistemaConIva: 2779.37,
    ivaCompraPct: 21, ivaCompraSupuesto: false, proveedor: 'Prov', fechaUltimaCompra: '2026-09-01', ingresoHoy: true }],
  ['5000', { nombre: 'Garrapiñadas Granel', costoMercaderia: null, costoSistema: null, costoSistemaConIva: null,
    ivaCompraPct: 21, ivaCompraSupuesto: true, proveedor: null, fechaUltimaCompra: null, ingresoHoy: false }],
]);

function armar(extra = {}) {
  return armarGruposFraccionado({
    graneles: GRANELES, presentaciones: PRESENTACIONES, formulas: FORMULAS, costos: COSTOS,
    vigentes: new Map([['11', 4700], ['12', 3000]]),
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
  assert.strictEqual(p500.precioConIva, 4700);
  assert.strictEqual(p500.precioVigente, 4700);
  assert.strictEqual(p500.semaforo, 'ok');
  assert.strictEqual(p1k.presentacion, '1KG');
  assert.strictEqual(p1k.markupStd, 60.3);
  assert.strictEqual(p1k.precioConIva, 4450); // 2297 × 1.603 × 1.21 = 4455.4 → 4450
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
  assert.strictEqual(lino.costoSistemaConIva, 2779.37);
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
  assert.strictEqual(p1k.precioConIva, 5100);   // 5094.83 → 5100
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
  assert.strictEqual(t500.precioConIva, 4700);  // 4678.24 → múltiplo de 50 (no hay vigente que respetar)
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

test('listado Almacén: una sola query de vínculos; sub-filas pack/bulto sobre el sugerido del base', async () => {
  const crearRutasPrecios = require('../routes/rutas_precios');
  const sqls = [];
  const query = async (sql) => {
    sqls.push(sql);
    if (sql.includes('Almacen Bultos/Cajas')) {
      return [{ plu: '91031', nombre: 'PEPAS PACK', basePlu: '6051', cantidad: 3 }, { plu: '91449', nombre: 'PEPAS BULTO', basePlu: '6051', cantidad: 12 }];
    }
    if (sql.includes('ProductosSucursalesPrecios')) return [{ IdProducto: '6051', Precio: 2995 }, { IdProducto: '91031', Precio: 2855 }];
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
  assert.strictEqual(filas[0].precioConIva, 2400); // 1000 × 2 × 1,21 = 2420 → 2400
  assert.deepStrictEqual(filas[0].packBulto.map(p => [p.plu, p.tipo, p.descPct, p.precioSugerido, p.precioVigente]), [
    ['91031', 'pack', 9.7, 2150, 2855], // 2400 × 0,903 = 2167,2 → 2150
    ['91449', 'bulto', 20, 1900, null], // 2400 × 0,8 = 1920 → 1900
  ]);
  assert.strictEqual(sqls.filter(s => s.includes('Almacen Bultos/Cajas')).length, 1);
});
