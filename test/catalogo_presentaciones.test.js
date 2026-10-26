'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { esMayorista, buildCatalogoMaps } = require('../lib/catalogo_presentaciones');

// ── Catálogo de planificación por presentaciones: códigos minoristas y mayoristas ──────────────
// Un grupo tiene presentaciones; cada una junta códigos minoristas (ventas de sucursales + stock)
// y mayoristas (ventas de Casa Central a clientes MAYORISTA, sin stock). El flag viejo esVariante
// se lee como mayorista mientras no haya esMayorista escrito.

test('esMayorista: esMayorista manda; sin él, esVariante (legado) cuenta como mayorista', () => {
  assert.strictEqual(esMayorista({ esMayorista: true }), true);
  assert.strictEqual(esMayorista({ esMayorista: false, esVariante: true }), false);
  assert.strictEqual(esMayorista({ esVariante: true }), true);
  assert.strictEqual(esMayorista({ esVariante: false }), false);
  assert.strictEqual(esMayorista({}), false);
  assert.strictEqual(esMayorista(null), false);
});

const CATALOGO = [
  { plu: 101, producto: 'Mix 500G', baseNombre: 'Mix 500G', presentacion: '500G', esMayorista: false, refId: 1, productoRef: 'Mix' },
  { plu: 102, producto: 'Mix Especial 500G', baseNombre: 'Mix Especial 500G', presentacion: '500G', esMayorista: false, refId: 1, productoRef: 'Mix' },
  { plu: 201, producto: 'Mix 500G Bulto', baseNombre: 'Mix 500G', presentacion: '500G', esVariante: true, refId: 1, productoRef: 'Mix' },
  { plu: 103, producto: 'Mix 1Kg', baseNombre: 'Mix 1Kg', presentacion: '1Kg', esMayorista: false, refId: 1, productoRef: 'Mix' },
  { plu: 202, producto: 'Solo Mayorista 2Kg', baseNombre: 'Solo Mayorista 2Kg', presentacion: '2Kg', esMayorista: true, refId: 1, productoRef: 'Mix' },
];

test('buildCatalogoMaps agrupa por presentación del grupo aunque los códigos tengan nombres distintos', () => {
  const { pluToBase, refMap } = buildCatalogoMaps(CATALOGO);
  assert.strictEqual(pluToBase.get('101'), '1|500G');
  assert.strictEqual(pluToBase.get('102'), '1|500G');
  assert.strictEqual(pluToBase.get('201'), '1|500G');
  const bases = refMap.get('1').bases;
  assert.deepStrictEqual([...bases.keys()], ['1|500G', '1|1Kg', '1|2Kg']);
  assert.deepStrictEqual(bases.get('1|500G'), {
    refId: '1', productoRef: 'Mix', presentacion: '500G', baseNombre: 'Mix 500G',
    pluBase: '101', plusBase: ['101', '102'], plusVariantes: ['201'],
  });
  // Presentación sin minoristas (presentación mayorista): toma el primer mayorista y se marca.
  assert.deepStrictEqual(bases.get('1|2Kg'), {
    refId: '1', productoRef: 'Mix', presentacion: '2Kg', baseNombre: 'Solo Mayorista 2Kg',
    pluBase: '202', plusBase: ['202'], plusVariantes: ['202'], esMayorista: true,
  });
});

test('buildCatalogoMaps: con un minorista después de los mayoristas la presentación sigue siendo mixta', () => {
  const { baseMap } = buildCatalogoMaps([
    { plu: 7, producto: 'X Bulto', baseNombre: 'X Bulto', presentacion: '1Kg', esMayorista: true, refId: 9, productoRef: 'X' },
    { plu: 8, producto: 'X 1Kg', baseNombre: 'X 1Kg', presentacion: '1Kg', esMayorista: false, refId: 9, productoRef: 'X' },
  ]);
  assert.deepStrictEqual(baseMap.get('9|1Kg'), {
    refId: '9', productoRef: 'X', presentacion: '1Kg', baseNombre: 'X 1Kg',
    pluBase: '8', plusBase: ['8'], plusVariantes: ['7'],
  });
});

// ── Cálculo de sugerencias por grupo con el router real y SQL falso ─────────────────────────────
const CONFIG = {
  ventanaConsumoDias: 30, diasObjetivo: 30, rubrosGranel: [9], umbralRojo: 7, umbralAmarillo: 15,
  minDiasParaSugerir: 20, gruposGranel: [], gruposGranelEnKg: [],
};
// Por tipo de query, valor por PLU. Un PLU que no corresponde a la query (ej. un mayorista en la de
// minoristas) devolvería 999 y rompería las cuentas.
const VENTAS_MIN = { 101: 30, 102: 15, 103: 6, 201: 999, 202: 999, 301: 100, 303: 40, 305: 7, 302: 999, 304: 999,
  401: 30, 403: 6, 405: 4, 407: 8, 409: 12, 412: 7, 402: 999, 404: 999, 406: 999, 408: 999, 410: 999,
  501: 30, 502: 999, 503: 999 };
const VENTAS_MAY = { 201: 60, 202: 40, 101: 999, 102: 999, 103: 999, 302: 20, 304: 10, 301: 999, 303: 999, 305: 999,
  402: 10, 404: 3, 406: 5, 408: 2, 410: 20, 401: 999, 403: 999, 405: 999, 407: 999, 409: 999, 412: 999,
  502: 20, 503: 10, 501: 999 };
const STOCK = { 101: 10, 102: 5, 103: 3, 201: 1000, 202: 1000, 301: 50, 304: 20, 501: 10, 502: 4, 503: 2 };
// Solo para los grupos de pepas y miel (los otros tests no los miran). El de los mayoristas no debe sumar.
const STOCK_SUC = { 301: 10, 303: 20, 305: 4, 302: 999, 501: 6, 502: 999, 503: 999 };
const PEND = { 301: 5, 302: 10, 303: 2, 402: 4 };
// Stock de los graneles cargados a mano en el catálogo (grupos_config.granelPlus).
const STOCK_GRANEL = { 901: 12, 902: 30 };

// Grupo granel "x unidad" (ej. pepas: la masa es por kilo, las presentaciones se venden por unidad).
//   · 'Pepas Batata': la presentación no dice el peso → sale del nombre del primer minorista (180G);
//     el Pack (mayorista) usa ese mismo peso, 1 a 1.
//   · '150G': peso en la presentación; su mayorista ≤200g es el caso de la regla vieja (×peso).
//   · 'Surtidas': sin peso en ningún lado → no se convierte y se avisa.
const PEPAS = [
  { plu: 301, producto: 'Pepas Batata 180G', baseNombre: 'Pepas Batata 180G', presentacion: 'Pepas Batata', esMayorista: false, refId: 2, productoRef: 'Pepas' },
  { plu: 302, producto: 'Pepas Batata Pack', baseNombre: 'Pepas Batata Pack', presentacion: 'Pepas Batata', esMayorista: true, refId: 2, productoRef: 'Pepas' },
  { plu: 303, producto: 'Pepas Membrillo 150G', baseNombre: 'Pepas Membrillo 150G', presentacion: '150G', esMayorista: false, refId: 2, productoRef: 'Pepas' },
  { plu: 304, producto: 'Pepas Membrillo 150G Bulto', baseNombre: 'Pepas Membrillo 150G Bulto', presentacion: '150G', esMayorista: true, refId: 2, productoRef: 'Pepas' },
  { plu: 305, producto: 'Pepas Surtidas', baseNombre: 'Pepas Surtidas', presentacion: 'Surtidas', esMayorista: false, refId: 2, productoRef: 'Pepas' },
];

// Grupo granel por kilo (un Mix: los minoristas se venden por kg) con códigos mayoristas que son
// bolsas cerradas vendidas por unidad (ventaPorUnidad en el código). Peso del código:
//   · 402: del nombre del código (500G); 404: de la presentación (1Kg); 406: del primer minorista (2Kg);
//   · 408: sin peso en ningún lado → no se convierte y se avisa;
//   · 410: mayorista ≤200g (regla vieja): se convierte una sola vez;
//   · 412: minorista con el check → se ignora.
const MIX_GRANEL = [
  { plu: 401, producto: 'Mix 500G', baseNombre: 'Mix 500G', presentacion: '500G', esMayorista: false, refId: 3, productoRef: 'Mix' },
  { plu: 402, producto: 'Mix 500G Bolsa', baseNombre: 'Mix 500G Bolsa', presentacion: '500G', esMayorista: true, ventaPorUnidad: true, refId: 3, productoRef: 'Mix' },
  { plu: 412, producto: 'Mix 500G Suelto', baseNombre: 'Mix 500G Suelto', presentacion: '500G', esMayorista: false, ventaPorUnidad: true, refId: 3, productoRef: 'Mix' },
  { plu: 403, producto: 'Mix 1Kg', baseNombre: 'Mix 1Kg', presentacion: '1Kg', esMayorista: false, refId: 3, productoRef: 'Mix' },
  { plu: 404, producto: 'Mix Bolsa Cerrada', baseNombre: 'Mix Bolsa Cerrada', presentacion: '1Kg', esMayorista: true, ventaPorUnidad: true, refId: 3, productoRef: 'Mix' },
  { plu: 405, producto: 'Mix Familiar 2Kg', baseNombre: 'Mix Familiar 2Kg', presentacion: 'Familiar', esMayorista: false, refId: 3, productoRef: 'Mix' },
  { plu: 406, producto: 'Mix Familiar Bolsa', baseNombre: 'Mix Familiar Bolsa', presentacion: 'Familiar', esMayorista: true, ventaPorUnidad: true, refId: 3, productoRef: 'Mix' },
  { plu: 407, producto: 'Mix Suelto', baseNombre: 'Mix Suelto', presentacion: 'Suelto', esMayorista: false, refId: 3, productoRef: 'Mix' },
  { plu: 408, producto: 'Mix Bolsa', baseNombre: 'Mix Bolsa', presentacion: 'Suelto', esMayorista: true, ventaPorUnidad: true, refId: 3, productoRef: 'Mix' },
  { plu: 409, producto: 'Mix 150G', baseNombre: 'Mix 150G', presentacion: '150G', esMayorista: false, refId: 3, productoRef: 'Mix' },
  { plu: 410, producto: 'Mix 150G Bulto', baseNombre: 'Mix 150G Bulto', presentacion: '150G', esMayorista: true, ventaPorUnidad: true, refId: 3, productoRef: 'Mix' },
];

// Presentación mayorista (todos sus códigos mayoristas, ej. Miel 28Kg que sale de Casa Central): se
// planifica con sus ventas mayoristas y el stock central de sus códigos; el de sucursales no cuenta.
const MIEL = [
  { plu: 501, producto: 'Miel 1Kg', baseNombre: 'Miel 1Kg', presentacion: '1Kg', esMayorista: false, refId: 5, productoRef: 'Miel' },
  { plu: 502, producto: 'Miel 28Kg', baseNombre: 'Miel 28Kg', presentacion: '28Kg', esMayorista: true, refId: 5, productoRef: 'Miel' },
  { plu: 503, producto: 'Miel Balde 28Kg', baseNombre: 'Miel Balde 28Kg', presentacion: '28Kg', esMayorista: true, refId: 5, productoRef: 'Miel' },
];

function plusDe(sql) {
  const m = /IdProducto IN \(([^)]*)\)/.exec(sql);
  return m ? m[1].split(',').map(s => s.replace(/'/g, '').trim()) : [];
}

function montarPlan({ esGranel = false, ventaPorUnidad = false, catalogo = CATALOGO, gruposCfg = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-pres-'));
  const leerJSON = (p, def) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : def);
  const guardarJSON = (p, d) => fs.writeFileSync(p, JSON.stringify(d));
  const CATALOGO_PATH = path.join(dir, 'catalogo.json');
  const CONFIG_PATH = path.join(dir, 'config.json');
  guardarJSON(CATALOGO_PATH, catalogo);
  guardarJSON(CONFIG_PATH, CONFIG);
  guardarJSON(path.join(dir, 'grupos_config.json'), gruposCfg);
  const sqls = [];
  const query = async sql => {
    sqls.push(sql);
    const fila = (tabla, col) => plusDe(sql).filter(p => p in tabla).map(p => ({ IdProducto: p, [col]: tabla[p], DiasConVenta: 10 }));
    const may = /'MAYORISTA'/.test(sql);
    if (/UnidVendidas/.test(sql)) return fila(may ? VENTAS_MAY : VENTAS_MIN, 'UnidVendidas').map(r => ({ ...r, TotalFacturado: r.UnidVendidas }));
    if (/^STOCK_CENTRAL/.test(sql)) return fila(STOCK, 'StockActual');
    if (/SoyLaCentral=0/.test(sql)) return fila(STOCK_SUC, 'StockActual');
    if (/UnidPendientes/.test(sql)) return fila(PEND, 'UnidPendientes');
    if (/SoyLaCentral=1/.test(sql)) return fila(STOCK_GRANEL, 'StockActual');
    return [];
  };
  const app = express();
  app.use(require('../routes/rutas_plan')({
    apiRoute: fn => async (req, res) => { try { res.json(await fn(req)); } catch (e) { res.status(500).json({ error: e.message }); } },
    leerJSON, guardarJSON, query, DATA_DIR: dir, CATALOGO_PATH, CONFIG_PATH,
    GRUPOS_CFG_PATH: path.join(dir, 'grupos_config.json'),
    sqlStockPorPlu: l => `STOCK_CENTRAL IdProducto IN (${l.join(',')})`,
    sqlStockGranel: () => 'GRANEL', sqlBOMGranel: (_r, extra) => `BOM${extra}`,
    buildCatalogoMaps, cfgActivo: () => true, cfgGranelPlu: () => '', cfgGranelPlus: (cfg, ref) => (cfg[ref] || {}).granelPlus || [], cfgEsGranel: () => esGranel,
    cfgVentaPorUnidad: () => ventaPorUnidad, cfgGranelesUnidad: (cfg, ref) => (cfg[ref] || {}).granelesUnidad || [],
  }));
  return new Promise(ok => {
    const server = app.listen(0, () => ok({ server, dir, sqls, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function cerrar({ server, dir }) {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

test('sugerencias por grupo: las ventas mayoristas suman a su presentación y su stock no', async () => {
  const ctx = await montarPlan();
  try {
    const r = await fetch(`${ctx.url}/api/plan/sugerencias-grupos`);
    const grupos = await r.json();
    assert.strictEqual(r.status, 200, JSON.stringify(grupos));
    assert.strictEqual(grupos.length, 1);
    const pres = Object.fromEntries(grupos[0].presentaciones.map(p => [p.presentacion, p]));
    // 2Kg solo tiene mayoristas: es una presentación mayorista y se muestra.
    assert.deepStrictEqual(Object.keys(pres).sort(), ['1Kg', '2Kg', '500G']);
    assert.strictEqual(pres['2Kg'].esMayorista, true);
    assert.strictEqual(pres['500G'].esMayorista, undefined);       // mixta: igual que antes
    const p500 = pres['500G'];
    assert.strictEqual(p500.ventasVentana, 30 + 15 + 60);         // minoristas + mayorista, 1 a 1
    assert.strictEqual(p500.facturacionMensual, 30 + 15 + 60);
    assert.strictEqual(p500.stockActual, 10 + 5);                 // el stock del mayorista no suma
    assert.deepStrictEqual(p500.plus, ['101', '102']);           // solo minoristas (modal de stock)
    assert.strictEqual(p500.plu, '101');
    assert.strictEqual(p500.baseNombre, 'Mix 500G');
    assert.strictEqual(pres['1Kg'].ventasVentana, 6);
    assert.strictEqual(pres['1Kg'].stockActual, 3);
    // Venta mayorista: la parte del total que vino de Casa Central a clientes MAYORISTA.
    assert.strictEqual(p500.ventasMayoristaVentana, 60);
    assert.strictEqual(p500.ventaDiariaMayorista, 2);
    assert.strictEqual(pres['1Kg'].ventasMayoristaVentana, 0);
    assert.strictEqual(pres['1Kg'].ventaDiariaMayorista, 0);
  } finally { cerrar(ctx); }
});

test('presentación mayorista: se planifica con el stock central de sus códigos, sin el de sucursales', async () => {
  const { g, d } = await grupoPepas({ catalogo: MIEL });
  const p = d['28Kg'];
  assert.strictEqual(p.esMayorista, true);
  assert.strictEqual(p.plu, '502');
  assert.strictEqual(p.baseNombre, 'Miel 28Kg');
  assert.deepStrictEqual(p.plus, ['502', '503']);
  assert.strictEqual(p.ventasVentana, 30);                          // solo sus ventas mayoristas
  assert.strictEqual(p.ventasMayoristaVentana, 30);
  assert.strictEqual(p.ventaDiariaUrg, 1);
  assert.strictEqual(p.ventaDiariaMayorista, 1);
  assert.strictEqual(p.stockActual, 4 + 2);                         // stock de Casa Central de sus códigos
  assert.strictEqual(p.stockSucursales, 0);                         // el de sucursales no cuenta
  assert.strictEqual(p.coberturaDias, 6);                           // 6 ÷ 1, solo con el central
  // Sin granel: promedio ÷ días con venta (3/día); 2 días de stock → sugerido = 3 × 30 − 6.
  assert.strictEqual(p.promDiario, 3);
  assert.strictEqual(p.cantSugerida, 84);
  // El minorista del mismo grupo, como siempre.
  assert.strictEqual(d['1Kg'].esMayorista, undefined);
  assert.strictEqual(d['1Kg'].stockSucursales, 6);
  assert.strictEqual(d['1Kg'].ventasMayoristaVentana, 0);
  assert.strictEqual(g.totalSugerido, d['1Kg'].cantSugerida + 84);
});

test('presentación mayorista ≤200g (regla vieja): ventas y stock pasan a kg con el mismo peso', async () => {
  const { d } = await grupoPepas({ catalogo: [PEPAS[2], { ...PEPAS[3], presentacion: 'Bulto 150G' }] });
  const p = d['Bulto 150G'];
  assert.strictEqual(p.esMayorista, true);
  assert.strictEqual(p.ventasVentana, 1.5);                         // 10 u × 0.15
  assert.strictEqual(p.ventasMayoristaVentana, 1.5);
  assert.strictEqual(p.stockActual, 3);                             // 20 u × 0.15: misma unidad que las ventas
  assert.strictEqual(p.stockSucursales, 0);
});

test('presentación mayorista en un grupo granel: entra al desglose y al total, sin stock de sucursales', async () => {
  const { g, d } = await grupoPepas({ catalogo: MIEL, esGranel: true });
  assert.deepStrictEqual(Object.keys(d).sort(), ['1Kg', '28Kg']);
  assert.strictEqual(d['28Kg'].esMayorista, true);
  assert.strictEqual(d['28Kg'].ventasVentana, 30);
  assert.strictEqual(d['28Kg'].ventasMayoristaVentana, 30);
  assert.strictEqual(d['28Kg'].ventaDiariaMayorista, 1);
  assert.strictEqual(d['28Kg'].stockCentral, 6);
  assert.strictEqual(d['1Kg'].esMayorista, undefined);
  assert.strictEqual(g.ventasVentana, 30 + 30);
  assert.strictEqual(g.ventasMayoristaVentana, 30);
  assert.strictEqual(g.ventaDiariaMayorista, 1);
  assert.strictEqual(g.totalPromMes, (30 / 10 + 30 / 10) * 30);     // sin granel: ÷ días con venta
  assert.strictEqual(g.stockSucGrupo, 6);                           // solo el minorista
  assert.deepStrictEqual(g.plus, ['501']);                          // modal 🔍 de sucursales sin los mayoristas
});

test('sugerencias por grupo: un grupo granel lista el consumo de cada presentación en desglose', async () => {
  const ctx = await montarPlan({ esGranel: true });
  try {
    const r = await fetch(`${ctx.url}/api/plan/sugerencias-grupos`);
    const grupos = await r.json();
    assert.strictEqual(r.status, 200, JSON.stringify(grupos));
    const g = grupos[0];
    assert.strictEqual(g.esGranel, true);
    assert.deepStrictEqual(g.presentaciones, []);              // el granel se sigue planificando como grupo
    assert.strictEqual(g.diasObjetivo, 30);                    // días a cubrir: stock mínimo del modal
    assert.strictEqual(g.minDiasParaSugerir, CONFIG.minDiasParaSugerir); // regla del sugerido, para el modal
    assert.strictEqual(typeof g.promPorDiasConVenta, "boolean");
    assert.strictEqual(g.desglose.find(d => d.presentacion === "500G").stockCentral, 10 + 5); // stock central de la presentación (solo minoristas)
    assert.deepStrictEqual(g.desglose.map(d => d.presentacion), ['1Kg', '2Kg', '500G']);
    const d500 = g.desglose.find(d => d.presentacion === '500G');
    assert.strictEqual(d500.ventasVentana, 30 + 15 + 60);
    assert.strictEqual(d500.ventaDiariaUrg, (30 + 15 + 60) / 30);
    assert.strictEqual(d500.facturacionMensual, 30 + 15 + 60);
    assert.strictEqual(d500.ventasMayoristaVentana, 60);
    assert.strictEqual(d500.ventaDiariaMayorista, 2);
    // Las presentaciones suman lo mismo que el grupo.
    assert.strictEqual(g.desglose.reduce((s, d) => s + d.ventasVentana, 0), g.ventasVentana);
    // Por kilo (sin "x unidad"): sin peso ni unidades en el desglose.
    assert.strictEqual(d500.pesoKg, null);
    assert.strictEqual(d500.unidadesVentana, null);
    assert.strictEqual(g.presentacionesSinPeso, undefined);
  } finally { cerrar(ctx); }
});

// Graneles en unidades: solo marca enUnidades/granelEnUnidades; ningún número cambia.
async function grupoMix(opts) {
  const ctx = await montarPlan(opts);
  try {
    const r = await fetch(`${ctx.url}/api/plan/sugerencias-grupos`);
    const grupos = await r.json();
    assert.strictEqual(r.status, 200, JSON.stringify(grupos));
    return grupos[0];
  } finally { cerrar(ctx); }
}
const sinMarcasDeUnidad = g => JSON.parse(JSON.stringify({ ...g, granelEnUnidades: undefined,
  graneles: g.graneles.map(({ enUnidades, ...x }) => x) }));

for (const esGranel of [true, false]) {
  test(`graneles en unidades (${esGranel ? 'grupo granel' : 'granel previo'}): marca cada granel y el grupo toma el del primero, sin cambiar números`, async () => {
    const cfg = granelesUnidad => ({ Mix: { activo: true, granelPlu: '901', granelPlus: ['901', '902'], ...(granelesUnidad ? { granelesUnidad } : {}) } });
    const base = await grupoMix({ esGranel, gruposCfg: cfg() });
    const segundo = await grupoMix({ esGranel, gruposCfg: cfg(['902']) });
    const primero = await grupoMix({ esGranel, gruposCfg: cfg(['901']) });
    assert.deepStrictEqual(base.graneles, [
      { id: '901', nombre: '901', stock: 12, enUnidades: false }, { id: '902', nombre: '902', stock: 30, enUnidades: false }]);
    assert.strictEqual(base.granelEnUnidades, false);
    assert.deepStrictEqual(segundo.graneles.map(x => x.enUnidades), [false, true]);
    assert.strictEqual(segundo.granelEnUnidades, false);
    assert.deepStrictEqual(primero.graneles.map(x => x.enUnidades), [true, false]);
    assert.strictEqual(primero.granelEnUnidades, true);
    assert.strictEqual(primero.granelStockGrupo, 12);
    assert.deepStrictEqual(sinMarcasDeUnidad(segundo), sinMarcasDeUnidad(base));
    assert.deepStrictEqual(sinMarcasDeUnidad(primero), sinMarcasDeUnidad(base));
  });
}

async function grupoPepas(opts) {
  const ctx = await montarPlan({ catalogo: PEPAS, ...opts });
  try {
    const r = await fetch(`${ctx.url}/api/plan/sugerencias-grupos`);
    const grupos = await r.json();
    assert.strictEqual(r.status, 200, JSON.stringify(grupos));
    const g = grupos[0];
    return { g, d: Object.fromEntries((g.esGranel ? g.desglose : g.presentaciones).map(x => [x.presentacion, x])) };
  } finally { cerrar(ctx); }
}

test('x unidad: un grupo granel pasa ventas, pendientes y stock a kg con el peso de cada presentación', async () => {
  const { g, d } = await grupoPepas({ esGranel: true, ventaPorUnidad: true });
  // Batata: peso del nombre del primer minorista (180G); el Pack usa el mismo peso.
  assert.strictEqual(d['Pepas Batata'].pesoKg, 0.18);
  assert.strictEqual(d['Pepas Batata'].unidadesVentana, 100 + 20);
  assert.strictEqual(d['Pepas Batata'].ventasVentana, 21.6);           // 120 u × 0.18
  // 150G: el mayorista ≤200g se convierte una sola vez (no también por la regla vieja).
  assert.strictEqual(d['150G'].pesoKg, 0.15);
  assert.strictEqual(d['150G'].unidadesVentana, 40 + 10);
  assert.strictEqual(d['150G'].ventasVentana, 7.5);                    // 50 u × 0.15
  // Sin peso: no se convierte y se avisa.
  assert.strictEqual(d.Surtidas.pesoKg, null);
  assert.strictEqual(d.Surtidas.unidadesVentana, 7);
  assert.strictEqual(d.Surtidas.ventasVentana, 7);
  assert.deepStrictEqual(g.presentacionesSinPeso, ['Surtidas']);
  assert.strictEqual(g.ventasVentana, 36.1);
  assert.strictEqual(g.ventaDiariaUrg, Math.round(36.1 / 30 * 10000) / 10000);
  // Stock en sucursales (el del mayorista no suma) y pendientes (también los del mayorista), en kg.
  assert.strictEqual(g.stockSucGrupo, 8.8);                            // 10×0.18 + 20×0.15 + 4
  assert.strictEqual(g.totalPend, 3);                                  // (5+10)×0.18 + 2×0.15
  assert.strictEqual(d['150G'].facturacionMensual, 40 + 10);           // facturación ($) no se toca
  // Modal de stock central: la presentación va en unidades (como en SIGA) y aparte su equivalente en kg.
  assert.strictEqual(d['Pepas Batata'].stockCentral, 50);
  assert.ok(Math.abs(d['Pepas Batata'].stockCentralKg - 50 * 0.18) < 1e-9);
  assert.strictEqual(d.Surtidas.stockCentralKg, null);                 // sin peso: no hay equivalente en kg
  // Venta mayorista, en la misma unidad que ventasVentana (ya en kg).
  assert.strictEqual(d['Pepas Batata'].ventasMayoristaVentana, 3.6);  // 20 u × 0.18
  assert.strictEqual(d['150G'].ventasMayoristaVentana, 1.5);          // 10 u × 0.15
  assert.strictEqual(d.Surtidas.ventasMayoristaVentana, 0);
  assert.strictEqual(g.ventasMayoristaVentana, 5.1);
});

test('x unidad: sin el check los números del grupo granel quedan como antes', async () => {
  const { g, d } = await grupoPepas({ esGranel: true, ventaPorUnidad: false });
  assert.strictEqual(d['Pepas Batata'].ventasVentana, 120);
  assert.strictEqual(d['150G'].ventasVentana, 41.5);                   // regla vieja: mayorista ≤200g × peso
  assert.strictEqual(d['Pepas Batata'].ventasMayoristaVentana, 20);    // sin conversión
  assert.strictEqual(d['150G'].ventasMayoristaVentana, 1.5);
  assert.strictEqual(d.Surtidas.ventasVentana, 7);
  assert.strictEqual(d['150G'].pesoKg, null);
  assert.strictEqual(d['150G'].unidadesVentana, null);
  assert.strictEqual(g.presentacionesSinPeso, undefined);
  assert.strictEqual(g.stockSucGrupo, 34);
  assert.strictEqual(g.totalPend, 17);
});

test('x unidad: en un grupo que no es granel el check no cambia nada', async () => {
  const { d } = await grupoPepas({ esGranel: false, ventaPorUnidad: true });
  assert.strictEqual(d['Pepas Batata'].ventasVentana, 120);
  assert.strictEqual(d['150G'].ventasVentana, 41.5);
  assert.strictEqual(d['150G'].stockSucursales, 20);
});

test('mayorista x unidad: en un grupo granel por kilo sus ventas y pendientes pasan a kg con su peso', async () => {
  const { g, d } = await grupoPepas({ catalogo: MIX_GRANEL, esGranel: true });
  assert.strictEqual(d['500G'].ventasVentana, 30 + 10 * 0.5 + 7);    // peso del nombre del código; el minorista 412 no se toca
  assert.deepStrictEqual(d['500G'].mayoristasUnidad, [{ plu: '402', unidadesVentana: 10, pesoKg: 0.5 }]);
  assert.strictEqual(d['1Kg'].ventasVentana, 6 + 3);                   // peso de la presentación (1Kg)
  assert.deepStrictEqual(d['1Kg'].mayoristasUnidad, [{ plu: '404', unidadesVentana: 3, pesoKg: 1 }]);
  assert.strictEqual(d.Familiar.ventasVentana, 4 + 5 * 2);             // peso del primer minorista (2Kg)
  assert.strictEqual(d['150G'].ventasVentana, 12 + 20 * 0.15);         // ≤200g: una sola conversión
  // Sin peso: no se convierte y se avisa.
  assert.strictEqual(d.Suelto.ventasVentana, 8 + 2);
  assert.deepStrictEqual(d.Suelto.mayoristasUnidad, [{ plu: '408', unidadesVentana: 2, pesoKg: null }]);
  assert.deepStrictEqual(g.presentacionesSinPeso, ['Suelto']);
  assert.strictEqual(g.totalPend, 4 * 0.5);                            // pendientes del mayorista, en kg
  assert.strictEqual(d['500G'].facturacionMensual, 30 + 10 + 7);       // facturación ($) no se toca
  assert.strictEqual(d['500G'].ventasMayoristaVentana, 10 * 0.5);     // mayorista x unidad, ya en kg
  assert.strictEqual(d['150G'].ventasMayoristaVentana, 20 * 0.15);    // una sola conversión
  // Grupo por kilo: sin peso ni unidades de la presentación.
  assert.strictEqual(d['500G'].pesoKg, null);
  assert.strictEqual(d['500G'].unidadesVentana, null);
});

test('mayorista x unidad: en un grupo que no es granel el check no cambia nada', async () => {
  const { d } = await grupoPepas({ catalogo: MIX_GRANEL, esGranel: false });
  assert.strictEqual(d['500G'].ventasVentana, 30 + 10 + 7);
  assert.strictEqual(d.Familiar.ventasVentana, 4 + 5);
  assert.strictEqual(d['150G'].ventasVentana, 12 + 20 * 0.15);         // la regla vieja ≤200g, igual que hoy
});

test('mayorista x unidad: en un grupo x unidad manda el peso del grupo y el del código no se aplica', async () => {
  const { g, d } = await grupoPepas({ catalogo: MIX_GRANEL, esGranel: true, ventaPorUnidad: true });
  assert.strictEqual(d['500G'].ventasVentana, (30 + 10 + 7) * 0.5);
  assert.strictEqual(d.Familiar.ventasVentana, (4 + 5) * 2);
  assert.deepStrictEqual(d['500G'].mayoristasUnidad, []);
  assert.deepStrictEqual(g.presentacionesSinPeso, ['Suelto']);         // el aviso de siempre del grupo x unidad
});

test('sugerencias por grupo: las ventas se cachean en el día (la segunda carga no vuelve a consultarlas)', async () => {
  const ctx = await montarPlan();
  try {
    const r1 = await (await fetch(`${ctx.url}/api/plan/sugerencias-grupos`)).json();
    const r2 = await (await fetch(`${ctx.url}/api/plan/sugerencias-grupos`)).json();
    assert.deepStrictEqual(r2, r1);
    assert.strictEqual(ctx.sqls.filter(s => /UnidVendidas/.test(s)).length, 2);   // minorista + mayorista, una vez
    assert.ok(ctx.sqls.filter(s => /^STOCK_CENTRAL/.test(s)).length >= 2);        // el stock sí se consulta en cada carga
  } finally { cerrar(ctx); }
});

test('sugerencias por grupo: la query mayorista mira Casa Central a clientes MAYORISTA, sin anulados ni 6/8/11', async () => {
  const ctx = await montarPlan();
  try {
    await fetch(`${ctx.url}/api/plan/sugerencias-grupos`);
    const ventas = ctx.sqls.filter(s => /UnidVendidas|TotalFacturado/.test(s));
    const may = ventas.filter(s => /'MAYORISTA'/.test(s));
    const min = ventas.filter(s => !/'MAYORISTA'/.test(s));
    assert.strictEqual(may.length, 1);  // unidades, días y facturación en una sola query por canal
    assert.strictEqual(min.length, 1);
    assert.match(may[0], /TotalFacturado/);
    for (const s of may) {
      assert.match(s, /v\.IdSucursal IN \(SELECT IdSucursal FROM Sucursales WHERE SoyLaCentral=1\)/);
      assert.match(s, /UPPER\(ISNULL\(cat\.NombreCategoria,''\)\) = 'MAYORISTA'/);
      assert.match(s, /v\.IdSucursal NOT IN \(6,8,11\)/);
      assert.match(s, /!= 'ANULADO'/);
      assert.deepStrictEqual(plusDe(s).sort(), ['201', '202']);
    }
    for (const s of min) {
      assert.match(s, /v\.IdSucursal NOT IN \(SELECT IdSucursal FROM Sucursales WHERE SoyLaCentral=1\)/);
      assert.match(s, /!= 'SUCURSAL'/);
      assert.deepStrictEqual(plusDe(s).sort(), ['101', '102', '103']);
    }
  } finally { cerrar(ctx); }
});

// ── PUT /api/catalogo/grupo/:ref: validación ───────────────────────────────────────────────────
function montarCatalogo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-put-'));
  const leerJSON = (p, def) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : def);
  const guardarJSON = (p, d) => fs.writeFileSync(p, JSON.stringify(d));
  const CATALOGO_PATH = path.join(dir, 'catalogo.json');
  guardarJSON(CATALOGO_PATH, CATALOGO);
  const app = express();
  app.use(express.json());
  app.use(require('../routes/rutas_catalogo')({ leerJSON, guardarJSON, CATALOGO_PATH, GRUPOS_CFG_PATH: path.join(dir, 'g.json') }));
  return new Promise(ok => {
    const server = app.listen(0, () => ok({
      server, dir, catalogo: () => leerJSON(CATALOGO_PATH, []), grupos: () => leerJSON(path.join(dir, 'g.json'), null),
      put: async (ref, body) => {
        const r = await fetch(`http://127.0.0.1:${server.address().port}/api/catalogo/grupo/${encodeURIComponent(ref)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        return { status: r.status, data: await r.json() };
      },
    }));
  });
}

test('POST grupos-config: conserva ventaPorUnidad y compacta el grupo que no lo tiene', async () => {
  const ctx = await montarCatalogo();
  try {
    const r = await fetch(`http://127.0.0.1:${ctx.server.address().port}/api/catalogo/grupos-config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Pepas: { activo: true, granelDirecto: true, ventaPorUnidad: true }, Mix: { activo: true, ventaPorUnidad: false }, Solo: { activo: true, ventaPorUnidad: true } }),
    });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(ctx.grupos(), {
      Pepas: { activo: true, granelDirecto: true, ventaPorUnidad: true },
      Mix: true,
      Solo: { activo: true, ventaPorUnidad: true },
    });
  } finally { cerrar(ctx); }
});

test('POST grupos-config: granelesUnidad queda solo con los graneles del grupo, sin vacíos ni repetidos', async () => {
  const ctx = await montarCatalogo();
  try {
    const r = await fetch(`http://127.0.0.1:${ctx.server.address().port}/api/catalogo/grupos-config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Mix: { activo: true, granelPlu: '901', granelPlus: ['901', '902'], granelesUnidad: ['902', ' 902 ', '', null, '999'] },
        Uno: { activo: true, granelPlu: '901', granelesUnidad: ['901'] },
        Nada: { activo: true, granelPlu: '901', granelesUnidad: ['999'] },
        Sin: { activo: true, granelesUnidad: ['901'] },
      }),
    });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(ctx.grupos(), {
      Mix: { activo: true, granelPlu: '901', granelPlus: ['901', '902'], granelesUnidad: ['902'] },
      Uno: { activo: true, granelPlu: '901', granelesUnidad: ['901'] },
      Nada: { activo: true, granelPlu: '901' },
      Sin: true,
    });
  } finally { cerrar(ctx); }
});

test('PUT grupo: rechaza PLU inválido, presentación vacía o PLU repetido sin tocar el catálogo', async () => {
  const ctx = await montarCatalogo();
  try {
    const ok = { plu: 101, producto: 'Mix 500G', presentacion: '500G', esMayorista: false };
    const casos = [
      [[{ ...ok, plu: 0 }], /PLU/],
      [[{ ...ok, plu: 'abc' }], /PLU/],
      [[{ ...ok, plu: 1.5 }], /PLU/],
      [[{ ...ok, presentacion: '  ' }], /presentación/i],
      [[ok, { ...ok, presentacion: '1Kg' }], /101.*repetido|repetido.*101/],
      [[null], /PLU/],
    ];
    for (const [body, re] of casos) {
      const r = await ctx.put('Mix', body);
      assert.strictEqual(r.status, 400, JSON.stringify(body));
      assert.match(r.data.error, re);
    }
    assert.deepStrictEqual(ctx.catalogo(), CATALOGO);
  } finally { cerrar(ctx); }
});

test('PUT grupo: conserva ventaPorUnidad (true) solo en los códigos mayoristas', async () => {
  const ctx = await montarCatalogo();
  try {
    const r = await ctx.put('Mix', [
      { plu: 101, producto: 'Mix 500G', presentacion: '500G', esMayorista: false, ventaPorUnidad: true },
      { plu: 201, producto: 'Mix 500G Bolsa', presentacion: '500G', esMayorista: true, ventaPorUnidad: true },
      { plu: 202, producto: 'Mix 2Kg Bolsa', presentacion: '2Kg', esMayorista: true, ventaPorUnidad: 'si' },
      { plu: 203, producto: 'Mix 2Kg Bulto', presentacion: '2Kg', esMayorista: true, ventaPorUnidad: false },
    ]);
    assert.strictEqual(r.status, 200);
    const mix = ctx.catalogo().filter(i => i.productoRef === 'Mix');
    assert.deepStrictEqual(mix.map(i => [i.plu, 'ventaPorUnidad' in i]), [[101, false], [201, true], [202, false], [203, false]]);
    assert.strictEqual(mix.find(i => i.plu === 201).ventaPorUnidad, true);
  } finally { cerrar(ctx); }
});

test('PUT grupo: guarda los válidos con el refId del grupo y la presentación sin espacios', async () => {
  const ctx = await montarCatalogo();
  try {
    const r = await ctx.put('Mix', [
      { plu: 101, producto: 'Mix 500G', presentacion: ' 500G ', esMayorista: false, refId: 77 },
      { plu: '201', producto: 'Mix 500G Bulto', presentacion: '500G', esMayorista: true },
    ]);
    assert.strictEqual(r.status, 200);
    const mix = ctx.catalogo().filter(i => i.productoRef === 'Mix');
    assert.deepStrictEqual(mix.map(i => [i.plu, i.presentacion, i.refId, i.esMayorista]), [[101, '500G', 1, false], [201, '500G', 1, true]]);
  } finally { cerrar(ctx); }
});
