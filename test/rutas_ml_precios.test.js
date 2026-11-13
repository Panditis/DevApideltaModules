'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const crearRutas = require('../routes/rutas_ml_precios');
const auth = require('../lib/auth');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'ml_publicaciones_muestra.xlsx'));
// Bajada completa real (no versionada): se usa si está, con ML_BAJADA_REAL=ruta a una copia.
const BAJADA_REAL = process.env.ML_BAJADA_REAL;

const leerJSON = (p, def) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; } };
const guardarJSON = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2), 'utf8');
const apiRoute = fn => async (req, res) => { try { res.json(await fn(req)); } catch (e) { res.status(500).json({ error: e.message }); } };

// query falso: Productos existentes con su precio de lista; null = SQL caído.
function sqlFalso(productos) {
  const consultas = [];
  const query = async sql => {
    consultas.push(sql);
    if (!productos) throw new Error('ECONNREFUSED');
    const ids = [...sql.matchAll(/'(\d+)'/g)].map(m => Number(m[1]));
    return ids.filter(id => productos[id] != null).map(id => ({ IdProducto: String(id), NombreProducto: `P${id}`, Precio: productos[id] }));
  };
  return { query, consultas };
}

async function conServidor(productos, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlp-'));
  const sql = sqlFalso(productos);
  const app = express();
  app.use(express.json());
  app.use(crearRutas({ apiRoute, query: sql.query, leerJSON, guardarJSON, DATA_DIR: dir, LISTA_PRECIOS_VENTA: 0 }));
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, dir, sql);
  } finally {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const subir = (base, buf, nombre = 'pub.xlsx') => {
  const fd = new FormData();
  fd.append('archivo', new Blob([buf]), nombre);
  return fetch(`${base}/api/ml-precios/importar`, { method: 'POST', body: fd });
};
const put = (url, body) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('importar fixture: 23/6/17 y escribe solo data/ml_publicaciones.json', async () => {
  await conServidor({}, async (base, dir) => {
    const r = await subir(base, FIXTURE);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(await r.json(), { total: 23, importadas: 6, variantesIgnoradas: 17, nuevasSinVincular: 6 });
    assert.deepStrictEqual(fs.readdirSync(dir), ['ml_publicaciones.json']);
  });
});

test('importar bajada real completa: 314/171/143', { skip: !BAJADA_REAL && 'ML_BAJADA_REAL no definido' }, async () => {
  await conServidor({}, async base => {
    const j = await (await subir(base, fs.readFileSync(BAJADA_REAL))).json();
    assert.strictEqual(j.total, 314);
    assert.strictEqual(j.importadas, 171);
    assert.strictEqual(j.variantesIgnoradas, 143);
  });
});

test('importar archivo no xlsx o sin archivo: 400 sin escribir', async () => {
  await conServidor({}, async (base, dir) => {
    const r = await subir(base, Buffer.from('ITEM_ID,PRICE\nMLA1,10'), 'x.csv');
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error, /xlsx/);
    const r2 = await fetch(`${base}/api/ml-precios/importar`, { method: 'POST', body: new FormData() });
    assert.strictEqual(r2.status, 400);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
  });
});

test('vínculo sobrevive a un nuevo import y cuenta como ya vinculado', async () => {
  await conServidor({ 7: 1000 }, async (base, dir) => {
    await subir(base, FIXTURE);
    const v = await put(`${base}/api/ml-precios/vinculos/MLA681472431`, { codigo: 7, unidades: 2 });
    assert.strictEqual(v.status, 200);
    const j = await (await subir(base, FIXTURE)).json();
    assert.strictEqual(j.nuevasSinVincular, 0);
    assert.strictEqual(leerJSON(path.join(dir, 'ml_vinculos.json')).MLA681472431.codigo, 7);
    const c = await (await fetch(`${base}/api/ml-precios/control`)).json();
    const fila = c.filas.find(f => f.id === 'MLA681472431');
    assert.strictEqual(fila.codigo, 7);
    assert.strictEqual(fila.carta, 1000);
    assert.strictEqual(fila.nombreProducto, 'P7');
  });
});

test('desvincular con codigo null borra el vínculo', async () => {
  await conServidor({ 7: 1000 }, async (base, dir) => {
    await put(`${base}/api/ml-precios/vinculos/MLA1`, { codigo: 7, unidades: 1 });
    const r = await put(`${base}/api/ml-precios/vinculos/MLA1`, { codigo: null });
    assert.deepStrictEqual(await r.json(), { id: 'MLA1', vinculo: null });
    assert.deepStrictEqual(leerJSON(path.join(dir, 'ml_vinculos.json')), {});
  });
});

test('vínculo inválido: 400 sin escribir (código inexistente, unidades 0, código no entero, id raro)', async () => {
  await conServidor({ 7: 1000 }, async (base, dir) => {
    const casos = [
      ['MLA1', { codigo: 99, unidades: 1 }, /no existe/],
      ['MLA1', { codigo: 7, unidades: 0 }, /unidades/i],
      ['MLA1', { codigo: "7' OR 1=1--", unidades: 1 }, /entero/],
      ['MLA1', { codigo: 1.5, unidades: 1 }, /entero/],
      ['XYZ', { codigo: 7, unidades: 1 }, /ID/],
    ];
    for (const [id, body, msg] of casos) {
      const r = await put(`${base}/api/ml-precios/vinculos/${id}`, body);
      assert.strictEqual(r.status, 400, JSON.stringify(body));
      assert.match((await r.json()).error, msg);
    }
    assert.ok(!fs.existsSync(path.join(dir, 'ml_vinculos.json')));
  });
});

test('vínculo con SQL caído: 502 sin escribir', async () => {
  await conServidor(null, async (base, dir) => {
    const r = await put(`${base}/api/ml-precios/vinculos/MLA1`, { codigo: 7, unidades: 1 });
    assert.strictEqual(r.status, 502);
    assert.ok(!fs.existsSync(path.join(dir, 'ml_vinculos.json')));
  });
});

test('config: GET crea defaults; PUT inválido 400 sin escribir; PUT válido guarda', async () => {
  await conServidor({}, async (base, dir) => {
    const cfg = await (await fetch(`${base}/api/ml-precios/config`)).json();
    const archivo = path.join(dir, 'ml_config.json');
    const antes = fs.readFileSync(archivo, 'utf8');
    const malos = [
      { ...cfg, comisionPct: 100 },
      { ...cfg, comisionPct: 60, cuotasBasePct: 21 }, // 60 + 21 + 19 (máx recargo) = 100
      { ...cfg, redondeoPaso: -1 },
    ];
    for (const b of malos) {
      const r = await put(`${base}/api/ml-precios/config`, b);
      assert.strictEqual(r.status, 400, JSON.stringify(b));
    }
    assert.strictEqual(fs.readFileSync(archivo, 'utf8'), antes);
    const ok = await put(`${base}/api/ml-precios/config`, { ...cfg, comisionPct: 12, extra: 'x' });
    assert.strictEqual(ok.status, 200);
    const guardado = leerJSON(archivo);
    assert.strictEqual(guardado.comisionPct, 12);
    assert.ok(!('extra' in guardado));
  });
});

test('control: 502 con SQL caído; sin vínculos no consulta SQL', async () => {
  await conServidor(null, async (base, _dir, sql) => {
    await subir(base, FIXTURE);
    const vacio = await fetch(`${base}/api/ml-precios/control`);
    assert.strictEqual(vacio.status, 200);
    assert.strictEqual(sql.consultas.length, 0);
    assert.strictEqual((await vacio.json()).kpis.sinVincular, 6);
    fs.writeFileSync(path.join(_dir, 'ml_vinculos.json'), JSON.stringify({ MLA681472431: { codigo: 7, unidades: 1 } }));
    const r = await fetch(`${base}/api/ml-precios/control`);
    assert.strictEqual(r.status, 502);
  });
});

test('control sin import previo: 200 con filas vacías', async () => {
  await conServidor({}, async base => {
    const j = await (await fetch(`${base}/api/ml-precios/control`)).json();
    assert.deepStrictEqual(j.filas, []);
    assert.strictEqual(j.importadoEn, null);
  });
});

test('sin sesión: /api/ml-precios y /ml-precios piden login (módulo con requiereAuth)', () => {
  // ponytail: el 401 lo da el middleware inline de server.js (no requerible); se prueba lo que decide.
  for (const ruta of ['/api/ml-precios/control', '/API/ML-PRECIOS/config', '/ml-precios']) assert.strictEqual(auth.moduloDeRuta(ruta), 'ml-precios');
  const mod = auth.CATALOGO_MODULOS.find(m => m.ref === 'ml-precios');
  assert.strictEqual(mod.defaultRequiereAuth, true);
  assert.strictEqual(auth.puedeAcceder(null, 'ml-precios'), false);
});

test('config vieja sin campos nuevos: GET normaliza sin reescribir; PUT nuevo valida y guarda', async () => {
  await conServidor({}, async (base, dir) => {
    const archivo = path.join(dir, 'ml_config.json');
    const { envioMonto, costoFijoMonto, impuestosPct, extras, ...vieja } = require('../lib/ml_precios').CONFIG_DEFAULT;
    fs.writeFileSync(archivo, JSON.stringify(vieja));
    const cfg = await (await fetch(`${base}/api/ml-precios/config`)).json();
    assert.deepStrictEqual([cfg.envioMonto, cfg.costoFijoMonto, cfg.impuestosPct, cfg.extras], [0, 0, 0, []]);
    assert.strictEqual(fs.readFileSync(archivo, 'utf8'), JSON.stringify(vieja));
    for (const b of [{ ...cfg, envioMonto: -1 }, { ...cfg, extras: [{ nombre: 'a', tipo: 'x', valor: 1 }] }, { ...cfg, impuestosPct: 90 }]) {
      assert.strictEqual((await put(`${base}/api/ml-precios/config`, b)).status, 400, JSON.stringify(b));
    }
    const r = await put(`${base}/api/ml-precios/config`, { ...cfg, envioMonto: 500, extras: [{ nombre: ' Emb ', tipo: '$', valor: 10, otro: 1 }] });
    assert.strictEqual(r.status, 200);
    const g = leerJSON(archivo);
    assert.strictEqual(g.envioMonto, 500);
    assert.deepStrictEqual(g.extras, [{ nombre: 'Emb', tipo: '$', valor: 10 }]);
  });
});

test('GET /vinculos: huérfano con enBajada false; SIGA caído → 200 sin nombres', async () => {
  const vinc = { MLA681472431: { codigo: 7, unidades: 2 }, MLA999: { codigo: 8, unidades: 1 } };
  await conServidor({ 7: 1000, 8: 50 }, async (base, dir) => {
    await subir(base, FIXTURE);
    fs.writeFileSync(path.join(dir, 'ml_vinculos.json'), JSON.stringify(vinc));
    const j = await (await fetch(`${base}/api/ml-precios/vinculos`)).json();
    const porId = Object.fromEntries(j.vinculos.map(v => [v.id, v]));
    assert.strictEqual(porId.MLA681472431.enBajada, true);
    assert.ok(porId.MLA681472431.titulo);
    assert.strictEqual(porId.MLA681472431.nombreProducto, 'P7');
    assert.deepStrictEqual(porId.MLA999, { id: 'MLA999', codigo: 8, unidades: 1, pesoKg: null, cuotasQty: null, titulo: null, enBajada: false, nombreProducto: 'P8' });
  });
  await conServidor(null, async (base, dir) => {
    fs.writeFileSync(path.join(dir, 'ml_vinculos.json'), JSON.stringify(vinc));
    const r = await fetch(`${base}/api/ml-precios/vinculos`);
    assert.strictEqual(r.status, 200);
    assert.ok((await r.json()).vinculos.every(v => v.nombreProducto === null && v.enBajada === false));
  });
});

test('control de punta a punta con costos nuevos ≠ 0: esperado = precioEsperado con la config guardada', async () => {
  const ml = require('../lib/ml_precios');
  await conServidor({ 7: 1000 }, async (base) => {
    await subir(base, FIXTURE);
    await put(`${base}/api/ml-precios/vinculos/MLA681472431`, { codigo: 7, unidades: 2 });
    const antes = (await (await fetch(`${base}/api/ml-precios/control`)).json()).filas.find(f => f.id === 'MLA681472431');
    const cfg = await (await fetch(`${base}/api/ml-precios/config`)).json();
    const nueva = { ...cfg, tablaCostoFijo: [], envioMonto: 500, costoFijoMonto: 100, impuestosPct: 4,
      extras: [{ nombre: 'Emb', tipo: '$', valor: 50 }, { nombre: 'Pub', tipo: '%', valor: 3 }] };
    assert.strictEqual((await put(`${base}/api/ml-precios/config`, nueva)).status, 200);
    const fila = (await (await fetch(`${base}/api/ml-precios/control`)).json()).filas.find(f => f.id === 'MLA681472431');
    const calc = ml.precioEsperado(1000, 2, fila.envio, fila.cuotas, ml.normalizarConfig(nueva));
    assert.strictEqual(fila.esperado, calc.esperado);
    assert.strictEqual(fila.gastosFijos, calc.gastosFijos);
    assert.strictEqual(fila.gastosFijos, (fila.envio === 'gratis' ? 500 : 0) + 150);
    assert.notStrictEqual(fila.esperado, antes.esperado);
    assert.strictEqual(antes.gastosFijos, antes.costoFijoTabla); // default: solo cargo fijo del tramo
  });
});

test('PUT config: extras que no es lista, o extra con nombre vacío / solo espacios → 400 sin escribir', async () => {
  await conServidor({}, async (base, dir) => {
    const cfg = await (await fetch(`${base}/api/ml-precios/config`)).json();
    const archivo = path.join(dir, 'ml_config.json');
    const previo = fs.readFileSync(archivo, 'utf8');
    for (const extras of [{}, 'x', 5, [{ nombre: '', tipo: '$', valor: 1 }], [{ nombre: '   ', tipo: '%', valor: 1 }], [null]]) {
      const r = await put(`${base}/api/ml-precios/config`, { ...cfg, extras });
      assert.strictEqual(r.status, 400, JSON.stringify(extras));
      assert.ok((await r.json()).error);
    }
    assert.strictEqual(fs.readFileSync(archivo, 'utf8'), previo);
  });
});

test('GET producto/:codigo: 200 con nombre y carta, 404 si no existe', async () => {
  await conServidor({ 7: 1000 }, async base => {
    const r = await fetch(`${base}/api/ml-precios/producto/7`);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(await r.json(), { codigo: 7, nombre: 'P7', carta: 1000 });
    const r404 = await fetch(`${base}/api/ml-precios/producto/99`);
    assert.strictEqual(r404.status, 404);
    assert.ok((await r404.json()).error);
  });
});

test('GET producto/:codigo inválido: 400 sin tocar SQL', async () => {
  await conServidor({ 7: 1000 }, async (base, _dir, sql) => {
    for (const c of ["7' OR 1=1--", '1.5', '0']) {
      const r = await fetch(`${base}/api/ml-precios/producto/${encodeURIComponent(c)}`);
      assert.strictEqual(r.status, 400, c);
      assert.ok((await r.json()).error);
    }
    assert.strictEqual(sql.consultas.length, 0);
  });
});

test('GET producto/:codigo con SQL caído: 502', async () => {
  await conServidor(null, async base => {
    const r = await fetch(`${base}/api/ml-precios/producto/7`);
    assert.strictEqual(r.status, 502);
    assert.ok((await r.json()).error);
  });
});

test('PUT vínculo con pesoKg: guarda, GET lo devuelve, control lo usa; inválido 400 sin escribir', async () => {
  await conServidor({ 7: 1000 }, async (base, dir) => {
    await subir(base, FIXTURE);
    for (const pesoKg of [0, -1, '1', 1.2345]) {
      const r = await put(`${base}/api/ml-precios/vinculos/MLA681472431`, { codigo: 7, unidades: 2, pesoKg });
      assert.strictEqual(r.status, 400, String(pesoKg));
    }
    assert.ok(!fs.existsSync(path.join(dir, 'ml_vinculos.json')));
    const ok = await (await put(`${base}/api/ml-precios/vinculos/MLA681472431`, { codigo: 7, unidades: 2, pesoKg: 1.25 })).json();
    assert.strictEqual(ok.vinculo.pesoKg, 1.25);
    const v = (await (await fetch(`${base}/api/ml-precios/vinculos`)).json()).vinculos.find(x => x.id === 'MLA681472431');
    assert.strictEqual(v.pesoKg, 1.25);
    const fila = (await (await fetch(`${base}/api/ml-precios/control`)).json()).filas.find(f => f.id === 'MLA681472431');
    assert.strictEqual(fila.pesoKg, 1.25);
    assert.strictEqual(fila.envio, 'gratis');
    assert.deepStrictEqual([fila.envioMonto, fila.envioTopeKg, fila.envioOrigen, fila.envioPorUmbral], [7470, 2, 'tabla', false]);
    const sinPeso = await (await put(`${base}/api/ml-precios/vinculos/MLA681472431`, { codigo: 7, unidades: 2 })).json();
    assert.strictEqual(sinPeso.vinculo.pesoKg, null);
  });
});

test('PUT config: tablaEnvio desordenada se guarda ordenada; duplicada 400; envioGratisDesde se guarda', async () => {
  await conServidor({}, async (base) => {
    const cfg = await (await fetch(`${base}/api/ml-precios/config`)).json();
    assert.strictEqual(cfg.tablaEnvio.length, 10);
    assert.strictEqual(cfg.envioGratisDesde, 33000);
    const r = await put(`${base}/api/ml-precios/config`, { ...cfg, envioGratisDesde: 0, tablaEnvio: [{ topeKg: 2, valor: 300 }, { topeKg: 0.5, valor: 100 }] });
    assert.strictEqual(r.status, 200);
    const g = await (await fetch(`${base}/api/ml-precios/config`)).json();
    assert.deepStrictEqual(g.tablaEnvio, [{ topeKg: 0.5, valor: 100 }, { topeKg: 2, valor: 300 }]);
    assert.strictEqual(g.envioGratisDesde, 0);
    const dup = await put(`${base}/api/ml-precios/config`, { ...cfg, tablaEnvio: [{ topeKg: 1, valor: 1 }, { topeKg: 1, valor: 2 }] });
    assert.strictEqual(dup.status, 400);
  });
});

test('PUT vínculo: pesos válidos de 3 decimales con float inexacto (1.005, 1.015) se aceptan como en el front', async () => {
  await conServidor({ 7: 1000 }, async (base) => {
    await subir(base, FIXTURE);
    for (const pesoKg of [1.005, 1.015, 0.001, 29.9]) {
      const r = await put(`${base}/api/ml-precios/vinculos/MLA681472431`, { codigo: 7, unidades: 2, pesoKg });
      assert.strictEqual(r.status, 200, String(pesoKg));
    }
  });
});

test('PUT config: >30 tramos, tope <= 0, valor negativo, umbral negativo o string → 400', async () => {
  await conServidor({}, async (base) => {
    const cfg = await (await fetch(`${base}/api/ml-precios/config`)).json();
    const malos = [
      { tablaEnvio: Array.from({ length: 31 }, (_, i) => ({ topeKg: i + 1, valor: 1 })) },
      { tablaEnvio: [{ topeKg: 0, valor: 1 }] },
      { tablaEnvio: [{ topeKg: 1, valor: -1 }] },
      { tablaEnvio: [{ topeKg: '1', valor: 1 }] },
      { tablaEnvio: 'x' },
      { envioGratisDesde: -1 },
      { envioGratisDesde: '33000' },
    ];
    for (const m of malos) assert.strictEqual((await put(`${base}/api/ml-precios/config`, { ...cfg, ...m })).status, 400, JSON.stringify(m).slice(0, 60));
    assert.strictEqual((await put(`${base}/api/ml-precios/config`, { ...cfg, tablaEnvio: Array.from({ length: 30 }, (_, i) => ({ topeKg: i + 1, valor: 1 })) })).status, 200);
  });
});

test('PUT vínculo con cuotasQty: válido guarda y llega a GET y control; 0, 25, 1.5, string → 400 sin escribir', async () => {
  await conServidor({ 7: 1000 }, async (base, dir) => {
    await subir(base, FIXTURE);
    for (const cuotasQty of [0, 25, 1.5, '3']) {
      const r = await put(`${base}/api/ml-precios/vinculos/MLA681472431`, { codigo: 7, unidades: 2, cuotasQty });
      assert.strictEqual(r.status, 400, String(cuotasQty));
    }
    assert.ok(!fs.existsSync(path.join(dir, 'ml_vinculos.json')));
    const ok = await (await put(`${base}/api/ml-precios/vinculos/MLA681472431`, { codigo: 7, unidades: 2, cuotasQty: 6 })).json();
    assert.strictEqual(ok.vinculo.cuotasQty, 6);
    const v = (await (await fetch(`${base}/api/ml-precios/vinculos`)).json()).vinculos.find(x => x.id === 'MLA681472431');
    assert.strictEqual(v.cuotasQty, 6);
    const fila = (await (await fetch(`${base}/api/ml-precios/control`)).json()).filas.find(f => f.id === 'MLA681472431');
    assert.deepStrictEqual([fila.cuotasQty, fila.cuotasPct], [6, 16]); // base 4 + recargo 12 (defaults)
    assert.strictEqual(fila.costoFijoOrigen, 'tabla');
    const sin = await (await put(`${base}/api/ml-precios/vinculos/MLA681472431`, { codigo: 7, unidades: 2 })).json();
    assert.strictEqual(sin.vinculo.cuotasQty, null);
  });
});

test('PUT config: tablaCuotas y tablaCostoFijo desordenadas se guardan ordenadas; sin cuotasPct; inválidas 400', async () => {
  await conServidor({}, async (base) => {
    const cfg = await (await fetch(`${base}/api/ml-precios/config`)).json();
    assert.ok(!('cuotasPct' in cfg));
    assert.deepStrictEqual([cfg.comisionPct, cfg.cuotasBasePct, cfg.tablaCuotas.length, cfg.tablaCostoFijo.length], [16, 4, 5, 3]);
    const r = await put(`${base}/api/ml-precios/config`, { ...cfg, cuotasPct: { no: 1 }, cuotasBasePct: 2,
      tablaCuotas: [{ cuotas: 6, recargoPct: 10 }, { cuotas: 1, recargoPct: 0 }],
      tablaCostoFijo: [{ precioMax: 9000, valor: 2 }, { precioMax: 100, valor: 1 }] });
    assert.strictEqual(r.status, 200);
    const g = await (await fetch(`${base}/api/ml-precios/config`)).json();
    assert.ok(!('cuotasPct' in g));
    assert.strictEqual(g.cuotasBasePct, 2);
    assert.deepStrictEqual(g.tablaCuotas, [{ cuotas: 1, recargoPct: 0 }, { cuotas: 6, recargoPct: 10 }]);
    assert.deepStrictEqual(g.tablaCostoFijo, [{ precioMax: 100, valor: 1 }, { precioMax: 9000, valor: 2 }]);
    for (const malo of [{ tablaCuotas: [{ cuotas: 3, recargoPct: 1 }, { cuotas: 3, recargoPct: 2 }] }, { tablaCostoFijo: [{ precioMax: 5, valor: 1 }, { precioMax: 5, valor: 2 }] }, { cuotasBasePct: -1 }]) {
      assert.strictEqual((await put(`${base}/api/ml-precios/config`, { ...cfg, ...malo })).status, 400, JSON.stringify(malo));
    }
  });
});

test('retrocompat: config con cuotasPct viejo y sin tablas + vínculo sin cuotasQty/pesoKg → GET config/vinculos/control 200 sin reescribir', async () => {
  const ml = require('../lib/ml_precios');
  const { cuotasBasePct, tablaCuotas, tablaCostoFijo, costoFijoMonto, ...resto } = ml.CONFIG_DEFAULT;
  const vieja = JSON.stringify({ ...resto, cuotasPct: { no: 0, agregar: 8, interes_bajo: 4 } });
  await conServidor({ 7: 1000 }, async (base, dir) => {
    await subir(base, FIXTURE);
    const archivo = path.join(dir, 'ml_config.json');
    fs.writeFileSync(archivo, vieja);
    fs.writeFileSync(path.join(dir, 'ml_vinculos.json'), JSON.stringify({ MLA681472431: { codigo: 7, unidades: 2 } }));
    const cfg = await (await fetch(`${base}/api/ml-precios/config`)).json();
    assert.strictEqual(cfg.cuotasPct, undefined);
    assert.strictEqual(cfg.cuotasBasePct, 4);
    assert.ok(Array.isArray(cfg.tablaCuotas) && Array.isArray(cfg.tablaCostoFijo));
    const v = (await (await fetch(`${base}/api/ml-precios/vinculos`)).json()).vinculos.find(x => x.id === 'MLA681472431');
    assert.deepStrictEqual([v.cuotasQty, v.pesoKg], [null, null]);
    const r = await fetch(`${base}/api/ml-precios/control`);
    assert.strictEqual(r.status, 200);
    const f = (await r.json()).filas.find(x => x.id === 'MLA681472431');
    const calc = ml.precioEsperado(1000, 2, f.envio, f.cuotas, ml.normalizarConfig(JSON.parse(vieja)));
    assert.strictEqual(f.esperado, calc.esperado);
    assert.strictEqual(f.cuotasPct, 4 + ml.recargoCuotas(cfg.tablaCuotas, 1));
    assert.strictEqual(fs.readFileSync(archivo, 'utf8'), vieja);
    assert.strictEqual((await put(`${base}/api/ml-precios/vinculos/MLA681472431`, { codigo: 7, unidades: 2, cuotasQty: null })).status, 200);
  });
});

test('config vieja con tablaMargen: GET la omite sin reescribir; PUT no la guarda; control sin margenPct ni sinMargen', async () => {
  const ml = require('../lib/ml_precios');
  await conServidor({ 7: 1000 }, async (base, dir) => {
    const archivo = path.join(dir, 'ml_config.json');
    const vieja = { ...ml.CONFIG_DEFAULT, tablaMargen: { minPct: 20, maxPct: 40, escalones: 5, rango: { desde: 1000, hasta: 100000 } } };
    fs.writeFileSync(archivo, JSON.stringify(vieja));
    const antes = fs.readFileSync(archivo, 'utf8');
    const cfg = await (await fetch(`${base}/api/ml-precios/config`)).json();
    assert.ok(!('tablaMargen' in cfg));
    assert.strictEqual(fs.readFileSync(archivo, 'utf8'), antes);
    assert.strictEqual((await put(`${base}/api/ml-precios/config`, { ...cfg, tablaMargen: vieja.tablaMargen })).status, 200);
    assert.ok(!('tablaMargen' in JSON.parse(fs.readFileSync(archivo, 'utf8'))));
    await subir(base, FIXTURE);
    await put(`${base}/api/ml-precios/vinculos/MLA681472431`, { codigo: 7, unidades: 2 });
    const j = await (await fetch(`${base}/api/ml-precios/control`)).json();
    assert.ok(!('sinMargen' in j.kpis));
    const fila = j.filas.find(f => f.id === 'MLA681472431');
    assert.ok(!('margenPct' in fila));
    assert.strictEqual(fila.base, 2000);
  });
});

test('PUT config envioBonificado: boolean se guarda; no boolean 400; sin la clave → false', async () => {
  await conServidor({}, async (base) => {
    const cfg = await (await fetch(`${base}/api/ml-precios/config`)).json();
    assert.strictEqual(cfg.envioBonificado, false);
    for (const v of ['true', 1, {}]) assert.strictEqual((await put(`${base}/api/ml-precios/config`, { ...cfg, envioBonificado: v })).status, 400, String(v));
    assert.strictEqual((await put(`${base}/api/ml-precios/config`, { ...cfg, envioBonificado: true })).status, 200);
    assert.strictEqual((await (await fetch(`${base}/api/ml-precios/config`)).json()).envioBonificado, true);
    const { envioBonificado, ...sin } = cfg;
    assert.strictEqual((await (await put(`${base}/api/ml-precios/config`, sin)).json()).envioBonificado, false);
  });
});
