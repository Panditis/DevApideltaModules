'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const {
  tipoPorNombre, armarVinculos, configPackBultoSanitizada,
} = require('../lib/precios_pack_bulto');

// ── tipoPorNombre ────────────────────────────────────────────────────────────
test('tipoPorNombre: Pack → pack; Bulto o Caja → bulto; ambos o ninguno → null', () => {
  assert.strictEqual(tipoPorNombre('PEPAS MEMBRILLO PACK X 3'), 'pack');
  assert.strictEqual(tipoPorNombre('Pepas membrillo bulto x 12'), 'bulto');
  assert.strictEqual(tipoPorNombre('ALFAJOR CAJA X 24'), 'bulto');
  assert.strictEqual(tipoPorNombre('PACK EN CAJA X 6'), null); // ambiguo
  assert.strictEqual(tipoPorNombre('GALLETITAS 200G'), null);
  assert.strictEqual(tipoPorNombre('PACKAGING X'), null); // palabra entera, no prefijo
  assert.strictEqual(tipoPorNombre(null), null);
});

// ── armarVinculos ────────────────────────────────────────────────────────────
const FILAS = [
  { plu: '91031', nombre: 'PEPAS MEMBRILLO PACK', basePlu: '6051', cantidad: 3 },
  { plu: '91449', nombre: 'PEPAS MEMBRILLO BULTO', basePlu: '6051', cantidad: 12 },
  { plu: '92000', nombre: 'COMBO BULTO', basePlu: '1', cantidad: 1 },
  { plu: '92000', nombre: 'COMBO BULTO', basePlu: '2', cantidad: 1 },
  { plu: '93000', nombre: 'SIN FORMULA BULTO', basePlu: null, cantidad: null },
  { plu: '94000', nombre: 'MAYORISTA X 10', basePlu: '7', cantidad: 10 },
];

test('armarVinculos: 1 componente + tipo por nombre → vínculo SIGA; el resto a sinVincular con motivo', () => {
  const { vinculos, sinVincular } = armarVinculos(FILAS, {});
  assert.deepStrictEqual(vinculos, [
    { plu: '91031', nombre: 'PEPAS MEMBRILLO PACK', basePlu: '6051', baseNombre: null, cantidad: 3, tipo: 'pack', origen: 'siga' },
    { plu: '91449', nombre: 'PEPAS MEMBRILLO BULTO', basePlu: '6051', baseNombre: null, cantidad: 12, tipo: 'bulto', origen: 'siga' },
  ]);
  assert.deepStrictEqual(sinVincular, [
    { plu: '92000', nombre: 'COMBO BULTO', motivo: 'fórmula con 2 componentes' },
    { plu: '93000', nombre: 'SIN FORMULA BULTO', motivo: 'sin fórmula activa' },
    { plu: '94000', nombre: 'MAYORISTA X 10', motivo: 'tipo ambiguo por nombre' },
  ]);
});

test('armarVinculos: el vínculo manual gana sobre SIGA y saca al producto de sinVincular', () => {
  const manuales = {
    91031: { basePlu: '6052', tipo: 'bulto' },
    92000: { basePlu: '1', tipo: 'bulto' },
    99999: { basePlu: '6051', tipo: 'pack' }, // no está en el rubro: se agrega igual
  };
  const { vinculos, sinVincular } = armarVinculos(FILAS, manuales);
  const por = Object.fromEntries(vinculos.map(v => [v.plu, v]));
  assert.deepStrictEqual(por['91031'], { plu: '91031', nombre: 'PEPAS MEMBRILLO PACK', basePlu: '6052', baseNombre: null, cantidad: null, tipo: 'bulto', origen: 'manual' });
  assert.strictEqual(por['92000'].origen, 'manual');
  assert.deepStrictEqual(por['99999'], { plu: '99999', nombre: null, basePlu: '6051', baseNombre: null, cantidad: null, tipo: 'pack', origen: 'manual' });
  assert.deepStrictEqual(sinVincular.map(s => s.plu), ['93000', '94000']);
});

// ── configPackBultoSanitizada ────────────────────────────────────────────────
test('configPackBultoSanitizada: sólo vinculosManuales y ventaPesable (los desc* viejos no salen)', () => {
  assert.deepStrictEqual(configPackBultoSanitizada(undefined), { vinculosManuales: {}, ventaPesable: {} });
  const cfg = configPackBultoSanitizada({
    descPackPct: 12, basura: 1, descPorProducto: { 91031: 0 },
    vinculosManuales: { 91999: { basePlu: '6051', tipo: 'pack', extra: 'x' } },
  });
  assert.deepStrictEqual(cfg, { vinculosManuales: { 91999: { basePlu: '6051', tipo: 'pack' } }, ventaPesable: {} });
});

test('configPackBultoSanitizada: rechaza PLUs y tipos inválidos', () => {
  const mal = [
    [{ vinculosManuales: { abc: { basePlu: '2', tipo: 'pack' } } }, /PLU/],
    [{ vinculosManuales: { 1: { basePlu: 'x', tipo: 'pack' } } }, /basePlu/],
    [{ vinculosManuales: { 1: { basePlu: '2', tipo: 'caja' } } }, /tipo/],
    [{ vinculosManuales: { 1: { basePlu: '1', tipo: 'pack' } } }, /sí mismo/],
  ];
  for (const [body, re] of mal) assert.throws(() => configPackBultoSanitizada(body), re);
});

// ── Router pack/bulto (express real, query falsa, DATA_DIR temporal) ──────────
const FILAS_SQL = [
  { plu: '91031', nombre: 'PEPAS MEMBRILLO PACK ', basePlu: '6051 ', cantidad: 3, baseNombre: 'PEPAS MEMBRILLO', baseRubro: 'Almacen' },
  { plu: '93000', nombre: 'SIN FORMULA BULTO', basePlu: null, cantidad: null },
];

function montarPackBulto() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precios-pb-'));
  fs.writeFileSync(path.join(dir, 'costeo.json'), JSON.stringify({ toleranciaPct: 10, margenPorProducto: { 1: 5 } }));
  const sqls = [];
  const query = async (sql) => {
    sqls.push(sql);
    if (sql.includes('Almacen Bultos/Cajas')) return FILAS_SQL;
    if (sql.includes('ProductosSucursalesPrecios')) return [{ IdProducto: '6051', Precio: 2995 }, { IdProducto: '91031', Precio: 2855 }];
    const ids = [...sql.matchAll(/'(\d+)'/g)].map(m => m[1]);
    return ids.filter(id => id === '6051').map(id => ({ IdProducto: id, NombreProducto: 'PEPAS MEMBRILLO' }));
  };
  const leerJSON = (p, def) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : def);
  const guardarJSON = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2));
  const apiRoute = fn => async (req, res) => { try { res.json(await fn(req)); } catch (err) { res.status(500).json({ error: err.message }); } };
  const app = express();
  app.use(express.json());
  app.use(require('../routes/rutas_precios_pack_bulto')({ apiRoute, query, leerJSON, guardarJSON, DATA_DIR: dir, LISTA_PRECIOS_VENTA: 0,
    FORMULA_ACTIVA_SQL: '/*FORMULA_ACTIVA*/1=1', SIN_FORMULA_GENERICO_SQL: '/*SIN_GENERICO*/1=1' }));
  return new Promise(ok => {
    const server = app.listen(0, () => ok({ server, dir, sqls, base: `http://127.0.0.1:${server.address().port}/api/precios` }));
  });
}

test('router pack/bulto: vínculos y vínculos manuales (inmutable, sólo packBulto)', async () => {
  const { server, dir, sqls, base } = await montarPackBulto();
  const pedir = async (metodo, url, body) => (await fetch(base + url, {
    method: metodo, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })).json();
  const archivo = () => JSON.parse(fs.readFileSync(path.join(dir, 'costeo.json'), 'utf8'));
  try {
    const v = await pedir('GET', '/pack-bulto/vinculos');
    assert.deepStrictEqual(Object.keys(v).sort(), ['sinVincular', 'vinculos']);
    assert.deepStrictEqual(v.vinculos, [{ plu: '91031', nombre: 'PEPAS MEMBRILLO PACK', basePlu: '6051', baseNombre: 'PEPAS MEMBRILLO', cantidad: 3, tipo: 'pack', origen: 'siga' }]);
    assert.deepStrictEqual(v.sinVincular, [{ plu: '93000', nombre: 'SIN FORMULA BULTO', motivo: 'sin fórmula activa' }]);
    assert.ok(sqls[0].includes('/*FORMULA_ACTIVA*/') && sqls[0].includes('/*SIN_GENERICO*/'));

    const m = await pedir('PUT', '/pack-bulto/vinculo/93000', { basePlu: '6051', tipo: 'bulto' });
    assert.deepStrictEqual(m, { plu: '93000', basePlu: '6051', tipo: 'bulto', baseNombre: 'PEPAS MEMBRILLO' });
    assert.match((await pedir('PUT', '/pack-bulto/vinculo/93000', { basePlu: '5555', tipo: 'bulto' })).error, /no existe en SIGA/);
    assert.match((await pedir('PUT', '/pack-bulto/vinculo/93000', { basePlu: '6051', tipo: 'x' })).error, /tipo/);

    const v2 = await pedir('GET', '/pack-bulto/vinculos');
    assert.deepStrictEqual(v2.sinVincular, []);
    assert.strictEqual(v2.vinculos.find(x => x.plu === '93000').origen, 'manual');
    assert.strictEqual(v2.vinculos.find(x => x.plu === '93000').baseNombre, 'PEPAS MEMBRILLO'); // manual: nombre desde SIGA
    assert.deepStrictEqual(archivo().packBulto.vinculosManuales, { 93000: { basePlu: '6051', tipo: 'bulto' } });

    assert.deepStrictEqual(await pedir('DELETE', '/pack-bulto/vinculo/93000'), { plu: '93000', borrado: true });
    assert.deepStrictEqual(archivo().packBulto.vinculosManuales, {});
    assert.deepStrictEqual(archivo().margenPorProducto, { 1: 5 });
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Vínculos con granel ──
test('armarVinculos: componente granel (Pesables Deposito) → vínculo SIGA marcado granel con sus kg', () => {
  const { vinculos, sinVincular } = armarVinculos([
    { plu: '95000', nombre: 'PASAS BULTO 10KG', basePlu: '4409', cantidad: 10, baseRubro: 'Pesables Deposito', baseNombre: 'PASAS GRANEL' },
    { plu: '95001', nombre: 'PASAS PACK', basePlu: '4410', cantidad: 3, baseRubro: 'Almacen', baseNombre: 'PASAS 200G ' },
    { plu: '95002', nombre: 'NUEZ X 25KG', basePlu: '4411', cantidad: 25, baseRubro: 'Pesables Deposito' }, // nombre ambiguo → bulto
  ], {});
  assert.deepStrictEqual(sinVincular, []);
  const por = Object.fromEntries(vinculos.map(v => [v.plu, v]));
  assert.deepStrictEqual(por['95000'], {
    plu: '95000', nombre: 'PASAS BULTO 10KG', basePlu: '4409', baseNombre: 'PASAS GRANEL', cantidad: 10, tipo: 'bulto', origen: 'siga', granel: true,
  });
  assert.strictEqual(por['95002'].tipo, 'bulto');
  assert.strictEqual(por['95002'].granel, true);
  assert.strictEqual(por['95001'].baseNombre, 'PASAS 200G');
  assert.strictEqual('granel' in por['95001'], false);
});

// ── Venta de pack/bulto pesables: por kg o por paquete (peso en kg) ───────────

test('configPackBultoSanitizada: ventaPesable { plu: { modo, pesoKg } } validado', () => {
  assert.deepStrictEqual(configPackBultoSanitizada({}).ventaPesable, {});
  const cfg = configPackBultoSanitizada({ ventaPesable: { 91011: { modo: 'paquete', pesoKg: 3, x: 1 }, 91012: { modo: 'kg' }, 91013: { modo: 'kg', pesoKg: 0.5 } } });
  assert.deepStrictEqual(cfg.ventaPesable, { 91011: { modo: 'paquete', pesoKg: 3 }, 91012: { modo: 'kg' }, 91013: { modo: 'kg', pesoKg: 0.5 } });
  const mal = [
    [{ ventaPesable: { abc: { modo: 'kg' } } }, /PLU/],
    [{ ventaPesable: { 1: { modo: 'caja' } } }, /modo/],
    [{ ventaPesable: { 1: { modo: 'paquete' } } }, /pesoKg/],
    [{ ventaPesable: { 1: { modo: 'paquete', pesoKg: 0 } } }, /pesoKg/],
    [{ ventaPesable: { 1: { modo: 'paquete', pesoKg: '3' } } }, /pesoKg/],
    [{ ventaPesable: { 1: { modo: 'kg', pesoKg: 5000 } } }, /pesoKg/],
  ];
  for (const [body, re] of mal) assert.throws(() => configPackBultoSanitizada(body), re);
});

test('router pack/bulto: PUT/DELETE venta/:plu guarda modo y peso (sólo packBulto.ventaPesable)', async () => {
  const { server, dir, base } = await montarPackBulto();
  const pedir = async (metodo, url, body) => (await fetch(base + url, {
    method: metodo, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })).json();
  const archivo = () => JSON.parse(fs.readFileSync(path.join(dir, 'costeo.json'), 'utf8'));
  try {
    assert.deepStrictEqual(await pedir('PUT', '/pack-bulto/venta/91031', { modo: 'paquete', pesoKg: 2.5 }), { plu: '91031', modo: 'paquete', pesoKg: 2.5 });
    assert.deepStrictEqual(await pedir('PUT', '/pack-bulto/venta/91032', { modo: 'kg' }), { plu: '91032', modo: 'kg', pesoKg: null });
    assert.match((await pedir('PUT', '/pack-bulto/venta/91033', { modo: 'paquete' })).error, /pesoKg/);
    assert.match((await pedir('PUT', '/pack-bulto/venta/91033', { modo: 'x', pesoKg: 1 })).error, /modo/);
    assert.match((await pedir('PUT', '/pack-bulto/venta/abc', { modo: 'kg' })).error, /PLU/);
    assert.deepStrictEqual(archivo().packBulto.ventaPesable, { 91031: { modo: 'paquete', pesoKg: 2.5 }, 91032: { modo: 'kg' } });
    assert.deepStrictEqual(await pedir('DELETE', '/pack-bulto/venta/91032'), { plu: '91032', modo: null });
    assert.deepStrictEqual(archivo().packBulto.ventaPesable, { 91031: { modo: 'paquete', pesoKg: 2.5 } });
    assert.deepStrictEqual(archivo().margenPorProducto, { 1: 5 });
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
