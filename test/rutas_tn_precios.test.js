'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const crearRutas = require('../routes/rutas_tn_precios');
const tn = require('../lib/tn_precios');
const auth = require('../lib/auth');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'tiendanube_muestra.csv'));
const URL_CAJU = 'castanas-caju-tostada-sin-sal-w4';

const leerJSON = (p, def) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; } };
const guardarJSON = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2), 'utf8');
const apiRoute = fn => async (req, res) => { try { res.json(await fn(req)); } catch (e) { res.status(500).json({ error: e.message }); } };
// permiso falso: header x-permiso: si → tiene precios-config.
const tienePermiso = (user, permiso) => !!user && user.permisos.includes(permiso);

function sqlFalso(productos) {
  const consultas = [];
  const query = async sql => {
    consultas.push(sql);
    if (!productos) throw new Error('ECONNREFUSED');
    const ids = [...sql.matchAll(/'(\d+)'/g)].map(m => Number(m[1]));
    return ids.filter(id => productos[id] !== undefined).map(id => ({ IdProducto: String(id), NombreProducto: `P${id}`, Precio: productos[id] }));
  };
  return { query, consultas };
}

async function conServidor(productos, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnp-'));
  const sql = sqlFalso(productos);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { permisos: req.get('x-permiso') === 'no' ? [] : ['precios-config'] } }; next(); });
  app.use(crearRutas({ apiRoute, query: sql.query, leerJSON, guardarJSON, DATA_DIR: dir, LISTA_PRECIOS_VENTA: 0, tienePermiso }));
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, dir, sql);
  } finally {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const subir = (base, buf, nombre = 'tn.csv') => {
  const fd = new FormData();
  fd.append('archivo', new Blob([buf]), nombre);
  return fetch(`${base}/api/tn-precios/importar`, { method: 'POST', body: fd });
};
const put = (url, body, permiso = 'si') => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-permiso': permiso }, body: JSON.stringify(body) });
const clave = v => encodeURIComponent(`${URL_CAJU}|${v}`);

test('importar fixture: 170/161/9/4 y guarda los bytes crudos', async () => {
  await conServidor({}, async (base, dir) => {
    const r = await subir(base, FIXTURE);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(await r.json(), { filas: 170, conSku: 161, sinSku: 9, skuRepetidos: 4, importadas: 170 });
    assert.ok(fs.readFileSync(path.join(dir, 'tn_bajada.csv')).equals(FIXTURE));
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['tn_bajada.csv', 'tn_bajada_meta.json']);
  });
});

test('importar no CSV, cabecera distinta o sin archivo: 400 sin escribir', async () => {
  await conServidor({}, async (base, dir) => {
    for (const buf of [Buffer.from('PK\x03\x04\x00\x00binario'), Buffer.from('Nombre;Precio;SKU\nx;1;2\n'), Buffer.alloc(0)]) {
      const r = await subir(base, buf);
      assert.strictEqual(r.status, 400);
      assert.ok((await r.json()).error);
    }
    const r = await fetch(`${base}/api/tn-precios/importar`, { method: 'POST', body: new FormData() });
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
  });
});

test('control: estados, combos sin SKU = sin_codigo, sin import = vacío', async () => {
  await conServidor({ 1206: 1000, 1208: 10100 }, async base => {
    const vacio = await (await fetch(`${base}/api/tn-precios/control`)).json();
    assert.deepStrictEqual(vacio.filas, []);
    await subir(base, FIXTURE);
    const j = await (await fetch(`${base}/api/tn-precios/control`)).json();
    const por = Object.fromEntries(j.filas.map(f => [f.clave, f]));
    assert.strictEqual(por[`${URL_CAJU}|100gr`].estado, 'desviada');
    assert.strictEqual(por[`${URL_CAJU}|100gr`].esperado, 1100);
    assert.strictEqual(por[`${URL_CAJU}|500 gr`].estado, 'ok');
    for (const f of j.filas.filter(x => x.nombre.startsWith('Combo'))) assert.deepStrictEqual([f.estado, f.esCombo], ['sin_componentes', true]);
    assert.strictEqual(j.kpis.combos, j.filas.filter(x => x.esCombo).length);
    assert.strictEqual(j.kpis.combosDesviadas, 0);
    // SKU 1206/1208 se repiten en c-caju-tostada-c-sal-w: 2 desviadas, 2 ok.
    assert.strictEqual(j.kpis.desviadas, 2);
    assert.strictEqual(j.kpis.ok, 2);
  });
});

test('control y exportar: 502 con query que falla', async () => {
  await conServidor(null, async base => {
    await subir(base, FIXTURE);
    assert.strictEqual((await fetch(`${base}/api/tn-precios/control`)).status, 502);
    assert.strictEqual((await fetch(`${base}/api/tn-precios/exportar`)).status, 502);
  });
});

test('exportar: 409 sin desviadas; con desviadas solo el producto afectado y la celda Precio', async () => {
  await conServidor({ 1208: 10100 }, async base => {
    await subir(base, FIXTURE);
    assert.strictEqual((await fetch(`${base}/api/tn-precios/exportar`)).status, 409);
  });
  await conServidor({ 1206: 1000, 1208: 10100 }, async base => {
    await subir(base, FIXTURE);
    const r = await fetch(`${base}/api/tn-precios/exportar`);
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /iso-8859-1/);
    const out = Buffer.from(await r.arrayBuffer());
    const filas = tn.parsearBajada(out).filas;
    assert.deepStrictEqual([...new Set(filas.map(f => f.url))].sort(), ['c-caju-tostada-c-sal-w', URL_CAJU]);
    assert.strictEqual(filas.length, 4);
    assert.strictEqual(filas.find(f => f.variante === '100gr').precioTn, 1100);
    assert.strictEqual(filas.find(f => f.variante === '500 gr').precioTn, 11100);
    assert.strictEqual(filas[0].nombre, 'Castañas Caju Tostada sin Sal W4');
  });
});

test('403 en PUT config y PUT vinculos sin precios-config, sin escribir', async () => {
  await conServidor({ 7: 1 }, async (base, dir) => {
    await subir(base, FIXTURE);
    assert.strictEqual((await put(`${base}/api/tn-precios/config`, { recargoPct: 5, toleranciaPct: 1, redondeoPaso: 0 }, 'no')).status, 403);
    assert.strictEqual((await put(`${base}/api/tn-precios/vinculos/${clave('100gr')}`, { codigo: 7, unidades: 1 }, 'no')).status, 403);
    assert.ok(!fs.existsSync(path.join(dir, 'tn_config.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'tn_vinculos.json')));
  });
});

test('vínculo: válido guarda y pisa SKU; null borra; inválidos 400 sin escribir; SQL caído 502', async () => {
  await conServidor({ 7: 500, 1206: 1000 }, async (base, dir) => {
    await subir(base, FIXTURE);
    const casos = [
      [clave('no-existe'), { codigo: 7, unidades: 1 }],
      [clave('100gr'), { codigo: 99, unidades: 1 }],
      [clave('100gr'), { codigo: 7, unidades: 0 }],
      [clave('100gr'), { codigo: "7' OR 1=1--", unidades: 1 }],
      [clave('100gr'), { codigo: 1.5, unidades: 1 }],
    ];
    for (const [k, body] of casos) assert.strictEqual((await put(`${base}/api/tn-precios/vinculos/${k}`, body)).status, 400, JSON.stringify(body));
    assert.ok(!fs.existsSync(path.join(dir, 'tn_vinculos.json')));
    const ok = await put(`${base}/api/tn-precios/vinculos/${clave('100gr')}`, { codigo: 7, unidades: 2 });
    assert.strictEqual(ok.status, 200);
    const c = await (await fetch(`${base}/api/tn-precios/control`)).json();
    const f = c.filas.find(x => x.clave === `${URL_CAJU}|100gr`);
    assert.deepStrictEqual([f.codigo, f.unidades, f.esperado], [7, 2, 1100]);
    const del = await put(`${base}/api/tn-precios/vinculos/${clave('100gr')}`, { codigo: null });
    assert.deepStrictEqual(await del.json(), { clave: `${URL_CAJU}|100gr`, vinculo: null });
    assert.deepStrictEqual(leerJSON(path.join(dir, 'tn_vinculos.json')), {});
  });
  await conServidor(null, async (base, dir) => {
    await subir(base, FIXTURE);
    assert.strictEqual((await put(`${base}/api/tn-precios/vinculos/${clave('100gr')}`, { codigo: 7, unidades: 1 })).status, 502);
    assert.ok(!fs.existsSync(path.join(dir, 'tn_vinculos.json')));
  });
});

test('vínculo sin bajada importada: 400', async () => {
  await conServidor({ 7: 1 }, async base => {
    assert.strictEqual((await put(`${base}/api/tn-precios/vinculos/${clave('100gr')}`, { codigo: 7, unidades: 1 })).status, 400);
  });
});

test('config: GET crea defaults; fuera de rango 400 sin escribir; válido guarda sin campos extra', async () => {
  await conServidor({}, async (base, dir) => {
    const cfg = await (await fetch(`${base}/api/tn-precios/config`)).json();
    assert.deepStrictEqual(cfg, { recargoPct: 10, toleranciaPct: 2, redondeoPaso: 0 });
    const archivo = path.join(dir, 'tn_config.json');
    const antes = fs.readFileSync(archivo, 'utf8');
    for (const b of [{ ...cfg, recargoPct: -1 }, { ...cfg, recargoPct: 1000 }, { ...cfg, toleranciaPct: 100 }, { ...cfg, redondeoPaso: -1 }, { ...cfg, toleranciaPct: '2' }]) {
      assert.strictEqual((await put(`${base}/api/tn-precios/config`, b)).status, 400, JSON.stringify(b));
    }
    assert.strictEqual(fs.readFileSync(archivo, 'utf8'), antes);
    const ok = await put(`${base}/api/tn-precios/config`, { ...cfg, recargoPct: 15, extra: 'x' });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(leerJSON(archivo), { recargoPct: 15, toleranciaPct: 2, redondeoPaso: 0 });
  });
});

const COMBO = 'combo-desayuno-matero';
const claveCombo = encodeURIComponent(`${COMBO}|`);

test('combos: PUT valida, guarda, control suma; PUT vinculos a combo 400; [] borra; 403; 502; export del combo desviado', async () => {
  await conServidor({ 1: 1000, 2: 500 }, async (base, dir) => {
    await subir(base, FIXTURE);
    const archivo = path.join(dir, 'tn_combos.json');
    const invalidos = [
      [encodeURIComponent('no-existe|'), [{ codigo: 1, unidades: 1 }]],
      [clave('100gr'), [{ codigo: 1, unidades: 1 }]], // no es combo
      [claveCombo, 'x'],
      [claveCombo, [{ codigo: 0, unidades: 1 }]],
      [claveCombo, [{ codigo: "1' OR 1=1--", unidades: 1 }]],
      [claveCombo, [{ codigo: 1, unidades: 0 }]],
      [claveCombo, [{ codigo: 1, unidades: 5000 }]],
      [claveCombo, [{ codigo: 1, unidades: '2' }]],
      [claveCombo, [{ codigo: 1, unidades: 1 }, { codigo: 1, unidades: 2 }]],
      [claveCombo, [{ codigo: 99, unidades: 1 }]],
      [claveCombo, Array.from({ length: 31 }, (_, i) => ({ codigo: i + 1, unidades: 1 }))],
    ];
    for (const [k, componentes] of invalidos) assert.strictEqual((await put(`${base}/api/tn-precios/combos/${k}`, { componentes })).status, 400, JSON.stringify(componentes).slice(0, 60));
    assert.strictEqual((await put(`${base}/api/tn-precios/vinculos/${claveCombo}`, { codigo: 1, unidades: 1 })).status, 400);
    assert.strictEqual((await put(`${base}/api/tn-precios/combos/${claveCombo}`, { componentes: [{ codigo: 1, unidades: 1 }] }, 'no')).status, 403);
    assert.ok(!fs.existsSync(archivo));
    // 54400 en TN vs (1000×2 + 500×1)×1.1 = 2750 → desviada
    const ok = await put(`${base}/api/tn-precios/combos/${claveCombo}`, { componentes: [{ codigo: 1, unidades: 2 }, { codigo: 2, unidades: 1, extra: 'x' }] });
    assert.deepStrictEqual(await ok.json(), { clave: `${COMBO}|`, componentes: [{ codigo: 1, unidades: 2 }, { codigo: 2, unidades: 1 }] });
    const j = await (await fetch(`${base}/api/tn-precios/control`)).json();
    const f = j.filas.find(x => x.clave === `${COMBO}|`);
    assert.deepStrictEqual([f.estado, f.esperado], ['desviada', 2750]);
    assert.deepStrictEqual(f.componentes, [{ codigo: 1, unidades: 2, nombre: 'P1', carta: 1000 }, { codigo: 2, unidades: 1, nombre: 'P2', carta: 500 }]);
    assert.strictEqual(j.kpis.combosDesviadas, 1);
    const out = tn.parsearBajada(Buffer.from(await (await fetch(`${base}/api/tn-precios/exportar`)).arrayBuffer())).filas;
    assert.deepStrictEqual(out.map(x => [x.url, x.precioTn]), [[COMBO, 2750]]);
    const del = await put(`${base}/api/tn-precios/combos/${claveCombo}`, { componentes: [] });
    assert.deepStrictEqual(await del.json(), { clave: `${COMBO}|`, componentes: [] });
    assert.deepStrictEqual(leerJSON(archivo), {});
  });
  await conServidor(null, async (base, dir) => {
    await subir(base, FIXTURE);
    assert.strictEqual((await put(`${base}/api/tn-precios/combos/${claveCombo}`, { componentes: [{ codigo: 1, unidades: 1 }] })).status, 502);
    assert.ok(!fs.existsSync(path.join(dir, 'tn_combos.json')));
  });
});

test('control fila no combo: skuOriginal, codigo efectivo y vinculado', async () => {
  await conServidor({ 7: 500, 1206: 1000 }, async base => {
    await subir(base, FIXTURE);
    await put(`${base}/api/tn-precios/vinculos/${clave('100gr')}`, { codigo: 7, unidades: 1 });
    const f = (await (await fetch(`${base}/api/tn-precios/control`)).json()).filas.find(x => x.clave === `${URL_CAJU}|100gr`);
    assert.deepStrictEqual([f.skuOriginal, f.codigo, f.vinculado, f.esCombo], ['1206', 7, true, false]);
  });
});

test('sin sesión: /api/tn-precios y /tn-precios piden login (módulo con requiereAuth)', () => {
  for (const ruta of ['/api/tn-precios/control', '/tn-precios']) assert.strictEqual(auth.moduloDeRuta(ruta), 'tn-precios');
  assert.strictEqual(auth.CATALOGO_MODULOS.find(m => m.ref === 'tn-precios').defaultRequiereAuth, true);
  assert.strictEqual(auth.puedeAcceder(null, 'tn-precios'), false);
});
