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
  // Presentación sin minoristas: sin pluBase (el cálculo la saltea).
  assert.strictEqual(bases.get('1|2Kg').pluBase, null);
  assert.deepStrictEqual(bases.get('1|2Kg').plusVariantes, ['202']);
});

// ── Cálculo de sugerencias por grupo con el router real y SQL falso ─────────────────────────────
const CONFIG = {
  ventanaConsumoDias: 30, diasObjetivo: 30, rubrosGranel: [9], umbralRojo: 7, umbralAmarillo: 15,
  minDiasParaSugerir: 20, gruposGranel: [], gruposGranelEnKg: [],
};
// Por tipo de query, valor por PLU. Un PLU que no corresponde a la query (ej. un mayorista en la de
// minoristas) devolvería 999 y rompería las cuentas.
const VENTAS_MIN = { 101: 30, 102: 15, 103: 6, 201: 999, 202: 999, 301: 100, 303: 40, 305: 7, 302: 999, 304: 999 };
const VENTAS_MAY = { 201: 60, 202: 40, 101: 999, 102: 999, 103: 999, 302: 20, 304: 10, 301: 999, 303: 999, 305: 999 };
const STOCK = { 101: 10, 102: 5, 103: 3, 201: 1000, 202: 1000 };
// Solo para el grupo de pepas (los otros tests no los miran).
const STOCK_SUC = { 301: 10, 303: 20, 305: 4, 302: 999 };
const PEND = { 301: 5, 302: 10, 303: 2 };

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

function plusDe(sql) {
  const m = /IdProducto IN \(([^)]*)\)/.exec(sql);
  return m ? m[1].split(',').map(s => s.replace(/'/g, '').trim()) : [];
}

function montarPlan({ esGranel = false, ventaPorUnidad = false, catalogo = CATALOGO } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-pres-'));
  const leerJSON = (p, def) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : def);
  const guardarJSON = (p, d) => fs.writeFileSync(p, JSON.stringify(d));
  const CATALOGO_PATH = path.join(dir, 'catalogo.json');
  const CONFIG_PATH = path.join(dir, 'config.json');
  guardarJSON(CATALOGO_PATH, catalogo);
  guardarJSON(CONFIG_PATH, CONFIG);
  const sqls = [];
  const query = async sql => {
    sqls.push(sql);
    const fila = (tabla, col) => plusDe(sql).filter(p => p in tabla).map(p => ({ IdProducto: p, [col]: tabla[p], DiasConVenta: 10 }));
    const may = /'MAYORISTA'/.test(sql);
    if (/UnidVendidas/.test(sql)) return fila(may ? VENTAS_MAY : VENTAS_MIN, 'UnidVendidas');
    if (/TotalFacturado/.test(sql)) return fila(may ? VENTAS_MAY : VENTAS_MIN, 'TotalFacturado');
    if (/^STOCK_CENTRAL/.test(sql)) return fila(STOCK, 'StockActual');
    if (/SoyLaCentral=0/.test(sql)) return fila(STOCK_SUC, 'StockActual');
    if (/UnidPendientes/.test(sql)) return fila(PEND, 'UnidPendientes');
    return [];
  };
  const app = express();
  app.use(require('../routes/rutas_plan')({
    apiRoute: fn => async (req, res) => { try { res.json(await fn(req)); } catch (e) { res.status(500).json({ error: e.message }); } },
    leerJSON, guardarJSON, query, DATA_DIR: dir, CATALOGO_PATH, CONFIG_PATH,
    GRUPOS_CFG_PATH: path.join(dir, 'grupos_config.json'),
    sqlStockPorPlu: l => `STOCK_CENTRAL IdProducto IN (${l.join(',')})`,
    sqlStockGranel: () => 'GRANEL', sqlBOMGranel: (_r, extra) => `BOM${extra}`,
    buildCatalogoMaps, cfgActivo: () => true, cfgGranelPlu: () => '', cfgGranelPlus: () => [], cfgEsGranel: () => esGranel,
    cfgVentaPorUnidad: () => ventaPorUnidad,
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
    // 2Kg solo tiene mayoristas: no aparece (igual que antes una base sin código base).
    assert.deepStrictEqual(Object.keys(pres).sort(), ['1Kg', '500G']);
    const p500 = pres['500G'];
    assert.strictEqual(p500.ventasVentana, 30 + 15 + 60);         // minoristas + mayorista, 1 a 1
    assert.strictEqual(p500.facturacionMensual, 30 + 15 + 60);
    assert.strictEqual(p500.stockActual, 10 + 5);                 // el stock del mayorista no suma
    assert.deepStrictEqual(p500.plus, ['101', '102']);           // solo minoristas (modal de stock)
    assert.strictEqual(p500.plu, '101');
    assert.strictEqual(p500.baseNombre, 'Mix 500G');
    assert.strictEqual(pres['1Kg'].ventasVentana, 6);
    assert.strictEqual(pres['1Kg'].stockActual, 3);
  } finally { cerrar(ctx); }
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
    assert.deepStrictEqual(g.desglose.map(d => d.presentacion), ['1Kg', '500G']);
    const d500 = g.desglose.find(d => d.presentacion === '500G');
    assert.strictEqual(d500.ventasVentana, 30 + 15 + 60);
    assert.strictEqual(d500.ventaDiariaUrg, (30 + 15 + 60) / 30);
    assert.strictEqual(d500.facturacionMensual, 30 + 15 + 60);
    // Las presentaciones suman lo mismo que el grupo.
    assert.strictEqual(g.desglose.reduce((s, d) => s + d.ventasVentana, 0), g.ventasVentana);
    // Por kilo (sin "x unidad"): sin peso ni unidades en el desglose.
    assert.strictEqual(d500.pesoKg, null);
    assert.strictEqual(d500.unidadesVentana, null);
    assert.strictEqual(g.presentacionesSinPeso, undefined);
  } finally { cerrar(ctx); }
});

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
});

test('x unidad: sin el check los números del grupo granel quedan como antes', async () => {
  const { g, d } = await grupoPepas({ esGranel: true, ventaPorUnidad: false });
  assert.strictEqual(d['Pepas Batata'].ventasVentana, 120);
  assert.strictEqual(d['150G'].ventasVentana, 41.5);                   // regla vieja: mayorista ≤200g × peso
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

test('sugerencias por grupo: la query mayorista mira Casa Central a clientes MAYORISTA, sin anulados ni 6/8/11', async () => {
  const ctx = await montarPlan();
  try {
    await fetch(`${ctx.url}/api/plan/sugerencias-grupos`);
    const ventas = ctx.sqls.filter(s => /UnidVendidas|TotalFacturado/.test(s));
    const may = ventas.filter(s => /'MAYORISTA'/.test(s));
    const min = ventas.filter(s => !/'MAYORISTA'/.test(s));
    assert.strictEqual(may.length, 2);  // consumo + facturación
    assert.strictEqual(min.length, 2);
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
