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
      { ...cfg, tablaMargen: { ...cfg.tablaMargen, minPct: -100 } },
      { ...cfg, tablaMargen: { ...cfg.tablaMargen, maxPct: -150 } },
      { ...cfg, comisionPct: 100 },
      { ...cfg, comisionPct: 60, cuotasPct: { no: 0, agregar: 40, interes_bajo: 0 } },
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
