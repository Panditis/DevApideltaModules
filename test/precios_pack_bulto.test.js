'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const {
  PACK_BULTO_DEFAULT, tipoPorNombre, armarVinculos, precioPackBulto, configPackBultoSanitizada, crearPackBultoDe,
  descuentosAlineados,
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

// ── precioPackBulto ──────────────────────────────────────────────────────────
test('precioPackBulto: % global por tipo, redondeo a $50, sin volver a aplicar IVA', () => {
  // Defaults = medianas SIGA (vigente pack|bulto / vigente base): pack 9,7%, bulto 14,7%.
  // 2995 × (1 − 0,097) = 2704,5 → 2700 ; 2995 × (1 − 0,147) = 2554,7 → 2550
  assert.deepStrictEqual(precioPackBulto({ precioSugeridoBase: 2995, tipo: 'pack', cfg: {}, plu: '91031' }),
    { descPct: 9.7, descOverride: null, precioConIva: 2700, faltantes: [] });
  assert.strictEqual(precioPackBulto({ precioSugeridoBase: 2995, tipo: 'bulto', cfg: {}, plu: '91449' }).precioConIva, 2550);
  const cfg = { descPackPct: 10, descBultoPct: 30 };
  assert.strictEqual(precioPackBulto({ precioSugeridoBase: 1000, tipo: 'pack', cfg, plu: '1' }).precioConIva, 900);
  assert.strictEqual(precioPackBulto({ precioSugeridoBase: 1000, tipo: 'bulto', cfg, plu: '1' }).precioConIva, 700);
});

test('precioPackBulto: override por PLU gana sobre el global (incluido 0)', () => {
  const cfg = { descPackPct: 10, descPorProducto: { 91031: 4.7, 5: 0 } };
  assert.deepStrictEqual(precioPackBulto({ precioSugeridoBase: 2995, tipo: 'pack', cfg, plu: '91031' }),
    { descPct: 4.7, descOverride: 4.7, precioConIva: 2850, faltantes: [] });
  assert.strictEqual(precioPackBulto({ precioSugeridoBase: 1000, tipo: 'pack', cfg, plu: '5' }).precioConIva, 1000);
});

test('precioPackBulto: base sin precio sugerido → faltante base, sin precio', () => {
  for (const base of [null, undefined, 0, NaN]) {
    const r = precioPackBulto({ precioSugeridoBase: base, tipo: 'pack', cfg: {}, plu: '1' });
    assert.strictEqual(r.precioConIva, null);
    assert.deepStrictEqual(r.faltantes, ['base']);
    assert.strictEqual(r.descPct, 9.7);
  }
});

// ── configPackBultoSanitizada ────────────────────────────────────────────────
test('configPackBultoSanitizada: completa defaults y deja sólo claves conocidas', () => {
  assert.deepStrictEqual(configPackBultoSanitizada(undefined), PACK_BULTO_DEFAULT);
  const cfg = configPackBultoSanitizada({
    descPackPct: 12, basura: 1, descPorProducto: { 91031: 0 },
    vinculosManuales: { 91999: { basePlu: '6051', tipo: 'pack', extra: 'x' } },
  });
  assert.deepStrictEqual(cfg, {
    descPackPct: 12, descBultoPct: 14.7, descPorProducto: { 91031: 0 },
    vinculosManuales: { 91999: { basePlu: '6051', tipo: 'pack' } }, ventaPesable: {},
  });
});

test('configPackBultoSanitizada: rechaza %, PLUs y tipos inválidos', () => {
  const mal = [
    [{ descPackPct: 91 }, /descPackPct/], [{ descBultoPct: -1 }, /descBultoPct/], [{ descPackPct: '10' }, /descPackPct/],
    [{ descPorProducto: { abc: 10 } }, /PLU/], [{ descPorProducto: { 1: 95 } }, /descPorProducto/],
    [{ descPorProducto: { 1: -51 } }, /descPorProducto/], [{ descPackPct: -1 }, /descPackPct/],
    [{ vinculosManuales: { 1: { basePlu: 'x', tipo: 'pack' } } }, /basePlu/],
    [{ vinculosManuales: { 1: { basePlu: '2', tipo: 'caja' } } }, /tipo/],
    [{ vinculosManuales: { 1: { basePlu: '1', tipo: 'pack' } } }, /sí mismo/],
  ];
  for (const [body, re] of mal) assert.throws(() => configPackBultoSanitizada(body), re);
});

// ── crearPackBultoDe ─────────────────────────────────────────────────────────
test('crearPackBultoDe: sub-filas por base con vigente, semáforo y revisar unidad', () => {
  const { vinculos } = armarVinculos(FILAS, {});
  const vigentes = new Map([['6051', 3000], ['91031', 2855], ['91449', 30000]]);
  const fechas = new Map([['91031', '2026-04-02']]);
  const packBultoDe = crearPackBultoDe({ vinculos, vigentes, fechas, costeo: { toleranciaPct: 5, packBulto: { descPorProducto: { 91031: 4.7 } }, marcadosExportar: { 91031: '2026-09-25' } } });
  const filas = packBultoDe('6051', 2995);
  assert.deepStrictEqual(filas, [
    { plu: '91031', nombre: 'PEPAS MEMBRILLO PACK', tipo: 'pack', descPct: 4.7, descOverride: 4.7, precioSugerido: 2850,
      precioVigente: 2855, deltaPct: -0.2, semaforo: 'ok', faltantes: [], revisarUnidad: false, marcado: true, fechaPrecio: '2026-04-02' },
    { plu: '91449', nombre: 'PEPAS MEMBRILLO BULTO', tipo: 'bulto', descPct: 14.7, descOverride: null, precioSugerido: 2550,
      precioVigente: 30000, deltaPct: -91.5, semaforo: 'bajar', faltantes: [], revisarUnidad: true, marcado: false, fechaPrecio: null }, // 30000/3000 = 10 > 1,2
  ]);
  assert.deepStrictEqual(packBultoDe('7', 1000), []);
  const sinBase = packBultoDe('6051', null);
  assert.deepStrictEqual(sinBase.map(f => [f.precioSugerido, f.faltantes, f.semaforo]), [[null, ['base'], null], [null, ['base'], null]]);
  // Sin vigente del base (o del pack) no se puede juzgar la unidad.
  const sinVig = crearPackBultoDe({ vinculos, vigentes: new Map([['91031', 100]]), costeo: {} })('6051', 2995);
  assert.strictEqual(sinVig[0].revisarUnidad, false);
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

test('router pack/bulto: vínculos, % globales, overrides y vínculos manuales (inmutable, sólo packBulto)', async () => {
  const { server, dir, sqls, base } = await montarPackBulto();
  const pedir = async (metodo, url, body) => (await fetch(base + url, {
    method: metodo, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })).json();
  const archivo = () => JSON.parse(fs.readFileSync(path.join(dir, 'costeo.json'), 'utf8'));
  try {
    const v = await pedir('GET', '/pack-bulto/vinculos');
    assert.deepStrictEqual(v.config, { descPackPct: 9.7, descBultoPct: 14.7, descPorProducto: {} });
    assert.deepStrictEqual(v.vinculos, [{ plu: '91031', nombre: 'PEPAS MEMBRILLO PACK', basePlu: '6051', baseNombre: 'PEPAS MEMBRILLO', cantidad: 3, tipo: 'pack', origen: 'siga' }]);
    assert.deepStrictEqual(v.sinVincular, [{ plu: '93000', nombre: 'SIN FORMULA BULTO', motivo: 'sin fórmula activa' }]);
    assert.ok(sqls[0].includes('/*FORMULA_ACTIVA*/') && sqls[0].includes('/*SIN_GENERICO*/'));

    assert.deepStrictEqual(await pedir('PUT', '/config/pack-bulto', { descPackPct: 15 }), { descPackPct: 15, descBultoPct: 14.7 });
    assert.match((await pedir('PUT', '/config/pack-bulto', { descBultoPct: 95 })).error, /descBultoPct/);
    assert.match((await pedir('PUT', '/config/pack-bulto', {})).error, /descPackPct|descBultoPct/);

    assert.deepStrictEqual(await pedir('PUT', '/pack-bulto/descuento/91031', { descPct: 4.7 }), { plu: '91031', descPct: 4.7 });
    assert.match((await pedir('PUT', '/pack-bulto/descuento/abc', { descPct: 4 })).error, /PLU/);
    assert.match((await pedir('PUT', '/pack-bulto/descuento/91031', { descPct: 'x' })).error, /descPorProducto|descPct/);

    const m = await pedir('PUT', '/pack-bulto/vinculo/93000', { basePlu: '6051', tipo: 'bulto' });
    assert.deepStrictEqual(m, { plu: '93000', basePlu: '6051', tipo: 'bulto', baseNombre: 'PEPAS MEMBRILLO' });
    assert.match((await pedir('PUT', '/pack-bulto/vinculo/93000', { basePlu: '5555', tipo: 'bulto' })).error, /no existe en SIGA/);
    assert.match((await pedir('PUT', '/pack-bulto/vinculo/93000', { basePlu: '6051', tipo: 'x' })).error, /tipo/);

    const v2 = await pedir('GET', '/pack-bulto/vinculos');
    assert.deepStrictEqual(v2.sinVincular, []);
    assert.strictEqual(v2.vinculos.find(x => x.plu === '93000').origen, 'manual');
    assert.strictEqual(v2.vinculos.find(x => x.plu === '93000').baseNombre, 'PEPAS MEMBRILLO'); // manual: nombre desde SIGA
    assert.deepStrictEqual(archivo(), {
      toleranciaPct: 10, margenPorProducto: { 1: 5 },
      packBulto: { descPackPct: 15, descBultoPct: 14.7, descPorProducto: { 91031: 4.7 }, vinculosManuales: { 93000: { basePlu: '6051', tipo: 'bulto' } }, ventaPesable: {} },
    });

    assert.deepStrictEqual(await pedir('DELETE', '/pack-bulto/descuento/91031'), { plu: '91031', descPct: null });
    assert.deepStrictEqual(await pedir('DELETE', '/pack-bulto/vinculo/93000'), { plu: '93000', borrado: true });
    assert.deepStrictEqual(archivo().packBulto, { descPackPct: 15, descBultoPct: 14.7, descPorProducto: {}, vinculosManuales: {}, ventaPesable: {} });
    assert.deepStrictEqual(archivo().margenPorProducto, { 1: 5 });
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Fase 4 bis: override negativo, alineado exacto, granel, alinear con SIGA ──
test('precioPackBulto: override negativo (pack más caro que el base) está permitido', () => {
  const r = precioPackBulto({ precioSugeridoBase: 1000, tipo: 'pack', cfg: { descPorProducto: { 1: -10 } }, plu: '1' });
  assert.deepStrictEqual(r, { descPct: -10, descOverride: -10, precioConIva: 1100, faltantes: [] });
  assert.deepStrictEqual(configPackBultoSanitizada({ descPorProducto: { 1: -50 } }).descPorProducto, { 1: -50 });
});

test('precioPackBulto: alineado exacto — a menos de $0,50 del vigente usa el vigente (sin redondeo a $50)', () => {
  const cfg = { descPorProducto: { 91031: 4.6745 } }; // 2995 × (1 − 0,046745) = 2855,0
  assert.strictEqual(precioPackBulto({ precioSugeridoBase: 2995, tipo: 'pack', cfg, plu: '91031', precioVigente: 2855 }).precioConIva, 2855);
  // Si el base cambia, vuelve el redondeo a $50.
  assert.strictEqual(precioPackBulto({ precioSugeridoBase: 3100, tipo: 'pack', cfg, plu: '91031', precioVigente: 2855 }).precioConIva, 2950);
  // Sin vigente: redondeo normal.
  assert.strictEqual(precioPackBulto({ precioSugeridoBase: 2995, tipo: 'pack', cfg, plu: '91031' }).precioConIva, 2850);
});

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

test('crearPackBultoDe: vínculo granel → nunca precio sugerido (aunque venga base), vigente y kg a la vista', () => {
  const vinculos = [{ plu: '95000', nombre: 'PASAS BULTO 10KG', basePlu: '4409', cantidad: 10, tipo: 'bulto', origen: 'siga', granel: true }];
  const vigentes = new Map([['4409', 5000], ['95000', 45000]]);
  const de = crearPackBultoDe({ vinculos, vigentes, costeo: { marcadosExportar: { 95000: true } } });
  for (const base of [null, 5000]) {
    const [f] = de('4409', base);
    assert.strictEqual(f.precioSugerido, null);
    assert.strictEqual(f.precioVigente, 45000);
    assert.strictEqual(f.deltaPct, null);
    assert.strictEqual(f.granel, true);
    assert.strictEqual(f.cantidad, 10);
    assert.strictEqual(f.revisarUnidad, false); // $/bulto vs $/kg: el ratio no significa nada
  }
});

test('descuentosAlineados: los vínculos granel se omiten (sin precio sugerido)', () => {
  const vinculos = [{ plu: '95000', nombre: 'PASAS BULTO 10KG', basePlu: '4409', tipo: 'bulto', granel: true }];
  const vigentes = new Map([['4409', 5000], ['95000', 45000]]);
  assert.deepStrictEqual(descuentosAlineados({ vinculos, vigentes }), {
    descuentos: {}, omitidos: [{ plu: '95000', nombre: 'PASAS BULTO 10KG', motivo: 'granel sin precio sugerido' }],
  });
});

test('descuentosAlineados: % que reproduce el vigente; omite sin vigente o fuera de 0,5–1,2', () => {
  const vinculos = [
    { plu: '1', nombre: 'A PACK', basePlu: '10' }, { plu: '2', nombre: 'B BULTO', basePlu: '10' },
    { plu: '3', nombre: 'C PACK', basePlu: '10' }, { plu: '4', nombre: 'D PACK', basePlu: '20' },
    { plu: '5', nombre: 'E PACK', basePlu: '10' },
  ];
  const vigentes = new Map([['10', 3000], ['1', 2855], ['2', 3150], ['3', 30000], ['5', 0]]);
  const r = descuentosAlineados({ vinculos, vigentes });
  assert.deepStrictEqual(r.descuentos, { 1: 4.8333, 2: -5 });
  assert.deepStrictEqual(r.omitidos, [
    { plu: '3', nombre: 'C PACK', motivo: 'revisar unidad (vigente ×10 del base)' },
    { plu: '4', nombre: 'D PACK', motivo: 'base sin precio vigente' },
    { plu: '5', nombre: 'E PACK', motivo: 'sin precio vigente' },
  ]);
});

test('alinear + alineado exacto: un pack cuyo base está alineado da Δ 0%', () => {
  const vinculos = [{ plu: '91031', nombre: 'PACK', basePlu: '6051', tipo: 'pack' }];
  const vigentes = new Map([['6051', 2995], ['91031', 2855]]);
  const { descuentos } = descuentosAlineados({ vinculos, vigentes });
  const f = crearPackBultoDe({ vinculos, vigentes, costeo: { packBulto: { descPorProducto: descuentos } } })('6051', 2995)[0];
  assert.strictEqual(f.precioSugerido, 2855);
  assert.strictEqual(f.deltaPct, 0);
});

test('router pack/bulto: POST alinear-siga guarda los % en una sola escritura y devuelve omitidos', async () => {
  const { server, dir, base } = await montarPackBulto();
  try {
    const r = await (await fetch(base + '/pack-bulto/alinear-siga', { method: 'POST' })).json();
    // FILAS_SQL: 91031 (pack de 6051) con vigentes 2855 / 2995 → 4,6745%.
    assert.deepStrictEqual(r, { alineados: 1, omitidos: [] });
    const archivo = JSON.parse(fs.readFileSync(path.join(dir, 'costeo.json'), 'utf8'));
    assert.deepStrictEqual(archivo.packBulto.descPorProducto, { 91031: 4.6745 });
    assert.deepStrictEqual(archivo.margenPorProducto, { 1: 5 });
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Venta de pack/bulto pesables: por kg o por paquete (peso en kg) ───────────
test('precioPackBulto: modo paquete = sugerido $/kg × peso × (1 − desc), redondeo $50 y alineado exacto', () => {
  const cfg = { descPackPct: 9.7 };
  // 4990 $/kg × 3 kg × 0,903 = 13517,91 → 13500
  assert.deepStrictEqual(precioPackBulto({ precioSugeridoBase: 4990, tipo: 'pack', cfg, plu: '1', modo: 'paquete', pesoKg: 3 }),
    { descPct: 9.7, descOverride: null, precioConIva: 13500, faltantes: [] });
  // A menos de $0,50 del vigente del paquete → el vigente.
  assert.strictEqual(precioPackBulto({ precioSugeridoBase: 4990, tipo: 'pack', cfg, plu: '1', modo: 'paquete', pesoKg: 3, precioVigente: 13518 }).precioConIva, 13518);
  // Modo kg (default): igual que antes.
  assert.strictEqual(precioPackBulto({ precioSugeridoBase: 4990, tipo: 'pack', cfg, plu: '1', modo: 'kg', pesoKg: 3 }).precioConIva, 4500);
});

test('precioPackBulto: modo paquete sin peso válido → faltante peso, sin precio (nunca optimista)', () => {
  for (const pesoKg of [null, 0, -1, NaN, '3']) {
    assert.deepStrictEqual(precioPackBulto({ precioSugeridoBase: 4990, tipo: 'pack', cfg: {}, plu: '1', modo: 'paquete', pesoKg }),
      { descPct: 9.7, descOverride: null, precioConIva: null, faltantes: ['peso'] });
  }
  assert.deepStrictEqual(precioPackBulto({ precioSugeridoBase: null, tipo: 'pack', cfg: {}, plu: '1', modo: 'paquete' }).faltantes, ['base', 'peso']);
});

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

test('crearPackBultoDe: pesable → modoVenta/pesoKg (precarga = kg de la fórmula); paquete → precio del paquete y ratio × peso', () => {
  const vinculos = [
    { plu: '91011', nombre: 'LINO PACK 3KG', basePlu: '11', cantidad: 3, tipo: 'pack', origen: 'siga' },
    { plu: '91012', nombre: 'LINO BULTO', basePlu: '11', cantidad: null, tipo: 'bulto', origen: 'siga' },
  ];
  const vigentes = new Map([['11', 5000], ['91011', 13600], ['91012', 4300]]);
  const costeo = { toleranciaPct: 5, packBulto: { descPackPct: 9.7, ventaPesable: { 91011: { modo: 'paquete', pesoKg: 3 } } } };
  const de = crearPackBultoDe({ vinculos, vigentes, costeo });
  const [pack, bulto] = de('11', 4990, { pesable: true });
  // 4990 × 3 × 0,903 = 13517,91 → 13500; vs vigente 13600 → −0,7% ok; ratio 13600 / (5000 × 3) = 0,91 → sin revisar.
  assert.deepStrictEqual([pack.modoVenta, pack.pesoKg, pack.cantidad, pack.precioSugerido, pack.deltaPct, pack.semaforo, pack.revisarUnidad],
    ['paquete', 3, 3, 13500, -0.7, 'ok', false]);
  // Sin config → kg (como antes), sin kg de fórmula → pesoKg null.
  assert.deepStrictEqual([bulto.modoVenta, bulto.pesoKg, bulto.precioSugerido], ['kg', null, 4250]);
  // No pesable (Almacén / Producción): sin campos de venta, aunque haya config.
  const [alm] = de('11', 4990);
  assert.strictEqual('modoVenta' in alm, false);
  assert.strictEqual(alm.precioSugerido, 4500);
  // Paquete sin peso (config cruda sin pesoKg y sin kg de fórmula) → faltante peso.
  const sinPeso = crearPackBultoDe({ vinculos, vigentes, costeo: { packBulto: { ventaPesable: { 91012: { modo: 'paquete' } } } } })('11', 4990, { pesable: true })[1];
  assert.deepStrictEqual([sinPeso.precioSugerido, sinPeso.faltantes, sinPeso.revisarUnidad], [null, ['peso'], false]);
});

test('crearPackBultoDe: bulto de granel guarda modo/peso pero sigue sin sugerido', () => {
  const vinculos = [{ plu: '95000', nombre: 'PASAS BULTO 10KG', basePlu: '4409', cantidad: 10, tipo: 'bulto', origen: 'siga', granel: true }];
  const vigentes = new Map([['4409', 5000], ['95000', 45000]]);
  const [f] = crearPackBultoDe({ vinculos, vigentes, costeo: { packBulto: { ventaPesable: { 95000: { modo: 'paquete', pesoKg: 9 } } } } })('4409', null);
  assert.deepStrictEqual([f.modoVenta, f.pesoKg, f.cantidad, f.precioSugerido, f.faltantes, f.revisarUnidad], ['paquete', 9, 10, null, ['base'], false]);
  const [k] = crearPackBultoDe({ vinculos, vigentes, costeo: {} })('4409', null);
  assert.deepStrictEqual([k.modoVenta, k.pesoKg], ['kg', 10]);
});

test('descuentosAlineados: modo paquete compara el vigente del paquete contra vigente base × peso', () => {
  const vinculos = [{ plu: '91011', nombre: 'LINO PACK 3KG', basePlu: '11', cantidad: 3, tipo: 'pack' }];
  const vigentes = new Map([['11', 5000], ['91011', 13500]]);
  // Por kg: 13500 / 5000 = 2,7 → revisar unidad. Por paquete de 3 kg: 13500 / 15000 = 0,9 → 10%.
  assert.match(descuentosAlineados({ vinculos, vigentes }).omitidos[0].motivo, /revisar unidad/);
  const cfg = { ventaPesable: { 91011: { modo: 'paquete', pesoKg: 3 } } };
  const r = descuentosAlineados({ vinculos, vigentes, cfg });
  assert.deepStrictEqual(r, { descuentos: { 91011: 10 }, omitidos: [] });
  // Alinear y recalcular da Δ 0.
  const f = crearPackBultoDe({ vinculos, vigentes, costeo: { packBulto: { ...cfg, descPorProducto: r.descuentos } } })('11', 5000, { pesable: true })[0];
  assert.deepStrictEqual([f.precioSugerido, f.deltaPct], [13500, 0]);
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
