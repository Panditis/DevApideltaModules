'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../lib/redistribucion_ocultos');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ocultos-'));

// ── Operaciones puras ─────────────────────────────────────────────────────────
test('ocultar en mapa vacío crea la sucursal y no muta la entrada', () => {
  const m = {};
  const r = lib.ocultar(m, 2, '1663', 'ana', 'F1');
  assert.deepStrictEqual(r, { 2: [{ plu: '1663', usuario: 'ana', fecha: 'F1' }] });
  assert.deepStrictEqual(m, {});
});

test('ocultar un PLU ya oculto no duplica ni cambia usuario/fecha', () => {
  const m = lib.ocultar({}, 2, '1663', 'ana', 'F1');
  const r = lib.ocultar(m, 2, '1663', 'beto', 'F2');
  assert.deepStrictEqual(r['2'], [{ plu: '1663', usuario: 'ana', fecha: 'F1' }]);
});

test('mostrar quita el PLU y borra la clave si queda vacía; no muta', () => {
  const m = { 2: [{ plu: 'a', usuario: null, fecha: 'F' }], 3: [{ plu: 'b', usuario: null, fecha: 'F' }] };
  const r = lib.mostrar(m, 2, 'a');
  assert.deepStrictEqual(r, { 3: m['3'] });
  assert.strictEqual(m['2'].length, 1);
});

test('mostrar un PLU inexistente no cambia el mapa', () => {
  const m = { 2: [{ plu: 'a', usuario: null, fecha: 'F' }] };
  assert.deepStrictEqual(lib.mostrar(m, 2, 'zz'), m);
  assert.deepStrictEqual(lib.mostrar(m, 5, 'a'), m);
});

test('restablecer vacía solo esa sucursal', () => {
  const m = { 2: [{ plu: 'a' }], 3: [{ plu: 'b' }] };
  assert.deepStrictEqual(lib.restablecer(m, 2), { 3: [{ plu: 'b' }] });
  assert.ok(m['2']);
});

test('validarSucursal acepta solo reales enteras', () => {
  for (const s of [2, 3, 4, 5, 7, 9, 10]) assert.strictEqual(lib.validarSucursal(s), null, String(s));
  for (const s of [6, 8, 11, '2', 2.5, null, 0, undefined]) assert.strictEqual(lib.validarSucursal(s), 'sucursal inválida', String(s));
});

test('validarPlu', () => {
  for (const p of ['1663', 'A-1_b.2', 'x'.repeat(40)]) assert.strictEqual(lib.validarPlu(p), null, p);
  for (const p of ['', 'x'.repeat(41), 'a b', 'a/b', 123, null, undefined]) assert.strictEqual(lib.validarPlu(p), 'plu inválido', String(p));
});

// ── Persistencia ─────────────────────────────────────────────────────────────
test('leer archivo inexistente → {}', async () => {
  assert.deepStrictEqual(await lib.leer(path.join(tmpDir(), 'no.json')), {});
});

test('leer archivo corrupto → {} y deja copia .corrupto', async (t) => {
  t.mock.method(console, 'error', () => {});
  const ruta = path.join(tmpDir(), 'o.json');
  for (const txt of ['{roto', '[1,2]', 'null']) {
    fs.writeFileSync(ruta, txt);
    assert.deepStrictEqual(await lib.leer(ruta), {}, txt);
    assert.strictEqual(fs.readFileSync(ruta + '.corrupto', 'utf8'), txt);
  }
});

test('modificar concurrentes con PLUs distintos → ambos quedan; sin .tmp', async () => {
  const dir = tmpDir();
  const ruta = path.join(dir, 'o.json');
  await Promise.all(['a', 'b', 'c'].map(p => lib.modificar(ruta, m => lib.ocultar(m, 2, p, null, 'F'))));
  const final = JSON.parse(fs.readFileSync(ruta, 'utf8'));
  assert.deepStrictEqual(final['2'].map(x => x.plu).sort(), ['a', 'b', 'c']);
  assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), []);
});

test('una operación que falla no rompe la cola para las siguientes', async () => {
  const ruta = path.join(tmpDir(), 'o.json');
  const mala = lib.modificar(ruta, () => { throw new Error('boom'); });
  const buena = lib.modificar(ruta, m => lib.ocultar(m, 3, 'x', null, 'F'));
  await assert.rejects(mala, /boom/);
  assert.deepStrictEqual(Object.keys(await buena), ['3']);
  // Fallo de escritura (directorio inexistente) tampoco bloquea.
  await assert.rejects(lib.modificar(path.join(tmpDir(), 'no', 'o.json'), m => m));
  assert.ok(await lib.modificar(ruta, m => m));
});

// ── Rutas (bloque extraído de rutas_distribucion.js, patrón de rutas_distribucion_redistribucion.test.js) ──
const FUENTE = fs.readFileSync(path.join(__dirname, '..', 'routes', 'rutas_distribucion.js'), 'utf8');
const ini = FUENTE.indexOf('// Ocultos de Redistribución');
const fin = FUENTE.indexOf('// Export xlsx de la tab "Sin fraccionar"');
assert.ok(ini > 0 && fin > ini, 'no se encontró el bloque de ocultos');
const BLOQUE = FUENTE.slice(ini, fin);

function montar(DATA_DIR = tmpDir()) {
  const h = {};
  const router = { get: (r, fn) => { h['GET ' + r] = fn; }, post: (r, fn) => { h['POST ' + r] = fn; } };
  new Function('path', 'DATA_DIR', 'ocultosLib', 'router', BLOQUE)(path, DATA_DIR, lib, router);
  const base = '/api/distribucion/redistribucion/ocultos';
  const llamar = async (metodo, sufijo, body, session) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await h[`${metodo} ${base}${sufijo}`]({ body, session }, res);
    return res;
  };
  return { DATA_DIR, llamar };
}
const sesion = { user: { usuario: 'ana' } };

test('rutas: GET vacío, POST ocultar con usuario, POST mostrar, restablecer', async () => {
  const { llamar, DATA_DIR } = montar();
  assert.deepStrictEqual((await llamar('GET', '')).body, { ocultos: {} });

  const r1 = await llamar('POST', '', { sucursal: 2, plu: '1663', oculto: true }, sesion);
  assert.strictEqual(r1.code, 200);
  const [it] = r1.body.ocultos['2'];
  assert.strictEqual(it.plu, '1663');
  assert.strictEqual(it.usuario, 'ana');
  assert.ok(!Number.isNaN(Date.parse(it.fecha)));

  await llamar('POST', '', { sucursal: 2, plu: '99', oculto: true }); // sin sesión
  const g = await llamar('GET', '');
  assert.strictEqual(g.body.ocultos['2'].find(x => x.plu === '99').usuario, null);
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'redistribucion_ocultos.json')));

  const r2 = await llamar('POST', '', { sucursal: 2, plu: '1663', oculto: false }, sesion);
  assert.deepStrictEqual(r2.body.ocultos['2'].map(x => x.plu), ['99']);

  await llamar('POST', '', { sucursal: 3, plu: 'z', oculto: true }, sesion);
  const r3 = await llamar('POST', '/restablecer', { sucursal: 2 }, sesion);
  assert.strictEqual(r3.code, 200);
  assert.deepStrictEqual(Object.keys(r3.body.ocultos), ['3']);
});

test('rutas: validación → 400 con mensaje', async () => {
  const { llamar } = montar();
  const casos = [
    [{ sucursal: '2', plu: 'a', oculto: true }, 'sucursal inválida'],
    [{ sucursal: 6, plu: 'a', oculto: true }, 'sucursal inválida'],
    [{ sucursal: 2, plu: 'a b', oculto: true }, 'plu inválido'],
    [{ sucursal: 2, plu: 'a', oculto: 'true' }, 'oculto debe ser booleano'],
    [undefined, 'sucursal inválida'],
  ];
  for (const [body, error] of casos) {
    const r = await llamar('POST', '', body);
    assert.strictEqual(r.code, 400, JSON.stringify(body));
    assert.deepStrictEqual(r.body, { error });
  }
  assert.deepStrictEqual((await llamar('POST', '/restablecer', { sucursal: 8 })).body, { error: 'sucursal inválida' });
});

test('rutas: fallo de escritura/lectura → 500 genérico sin filtrar la ruta del disco', async (t) => {
  const logs = t.mock.method(console, 'error', () => {});
  const DATA_DIR = path.join(tmpDir(), 'no-existe');
  const { llamar } = montar(DATA_DIR);
  for (const [m, suf, body] of [['POST', '', { sucursal: 2, plu: 'a', oculto: true }], ['POST', '/restablecer', { sucursal: 2 }]]) {
    const r = await llamar(m, suf, body);
    assert.strictEqual(r.code, 500);
    assert.deepStrictEqual(r.body, { error: 'No se pudieron guardar/leer los ocultos.' });
    assert.ok(!JSON.stringify(r.body).includes(DATA_DIR));
  }
  assert.ok(logs.mock.callCount() >= 2);
  // Lectura que falla con algo distinto de ENOENT (el archivo es un directorio) → 500 en GET.
  const d2 = tmpDir();
  fs.mkdirSync(path.join(d2, 'redistribucion_ocultos.json'));
  const g = await montar(d2).llamar('GET', '');
  assert.strictEqual(g.code, 500);
  assert.deepStrictEqual(g.body, { error: 'No se pudieron guardar/leer los ocultos.' });
});

// ── Endurecimiento: sanear, reintento de rename, .corrupto, orden de la cola ──
test('sanear: descarta no-listas, null, no-objetos, plu inválido y listas vacías; no muta; loguea', (t) => {
  const logs = t.mock.method(console, 'error', () => {});
  const entrada = {
    2: [{ plu: 'a' }, null, 'x', { plu: 'a b' }, { plu: 7 }],
    3: 'no-lista',
    4: [],
    5: [null],
    7: [{ plu: 'ok', usuario: 'ana' }],
  };
  const copia = JSON.parse(JSON.stringify(entrada));
  const r = lib.sanear(entrada, 'o.json');
  assert.deepStrictEqual(r, { 2: [{ plu: 'a' }], 7: [{ plu: 'ok', usuario: 'ana' }] });
  assert.deepStrictEqual(entrada, copia);
  assert.strictEqual(logs.mock.callCount(), 3); // 2 inválidos, 3 no-lista, 5 inválido
  assert.ok(logs.mock.calls.every(c => String(c.arguments[0]).includes('o.json')));
});

test('leer aplica sanear al archivo', async (t) => {
  t.mock.method(console, 'error', () => {});
  const ruta = path.join(tmpDir(), 'o.json');
  fs.writeFileSync(ruta, JSON.stringify({ 2: [{ plu: 'a' }, null], 3: 5 }));
  assert.deepStrictEqual(await lib.leer(ruta), { 2: [{ plu: 'a' }] });
});

test('rename: reintenta ante EPERM y termina escribiendo', async (t) => {
  const fsp = require('fs/promises');
  const real = fsp.rename;
  let n = 0;
  t.mock.method(fsp, 'rename', async (a, b) => {
    if (++n < 3) throw Object.assign(new Error('bloqueado'), { code: 'EPERM' });
    return real(a, b);
  });
  const dir = tmpDir();
  const ruta = path.join(dir, 'o.json');
  await lib.modificar(ruta, m => lib.ocultar(m, 2, 'a', null, 'F'));
  assert.strictEqual(n, 3);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(ruta, 'utf8'))['2'][0].plu, 'a');
  assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), []);
});

test('rename: tras 3 EBUSY falla, borra el .tmp; error no reintentable falla al primer intento', async (t) => {
  const fsp = require('fs/promises');
  let n = 0;
  let code = 'EBUSY';
  t.mock.method(fsp, 'rename', async () => { n++; throw Object.assign(new Error('x'), { code }); });
  const dir = tmpDir();
  const ruta = path.join(dir, 'o.json');
  await assert.rejects(lib.modificar(ruta, m => m), { code: 'EBUSY' });
  assert.strictEqual(n, 3);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  n = 0; code = 'ENOSPC';
  await assert.rejects(lib.modificar(ruta, m => m), { code: 'ENOSPC' });
  assert.strictEqual(n, 1);
});

test('.corrupto: no se reescribe si el contenido es igual; sí si cambia', async (t) => {
  t.mock.method(console, 'error', () => {});
  const fsp = require('fs/promises');
  const ruta = path.join(tmpDir(), 'o.json');
  fs.writeFileSync(ruta, '{roto');
  await lib.leer(ruta);
  const escrituras = t.mock.method(fsp, 'writeFile');
  await lib.leer(ruta);
  assert.strictEqual(escrituras.mock.calls.filter(c => String(c.arguments[0]).endsWith('.corrupto')).length, 0);
  fs.writeFileSync(ruta, '{otro');
  await lib.leer(ruta);
  assert.strictEqual(escrituras.mock.calls.filter(c => String(c.arguments[0]).endsWith('.corrupto')).length, 1);
  assert.strictEqual(fs.readFileSync(ruta + '.corrupto', 'utf8'), '{otro');
});

test('cola: leer lanzado junto a modificar espera su turno (orden determinístico)', async () => {
  const ruta = path.join(tmpDir(), 'o.json');
  const orden = [];
  const m1 = lib.modificar(ruta, m => lib.ocultar(m, 2, 'a', null, 'F')).then(() => orden.push('m1'));
  const l1 = lib.leer(ruta).then(r => { orden.push('l1'); return r; });
  const m2 = lib.modificar(ruta, m => lib.ocultar(m, 2, 'b', null, 'F')).then(() => orden.push('m2'));
  const l2 = lib.leer(ruta);
  const [, r1, , r2] = await Promise.all([m1, l1, m2, l2]);
  assert.deepStrictEqual(orden, ['m1', 'l1', 'm2']);
  assert.deepStrictEqual(r1['2'].map(x => x.plu), ['a']);
  assert.deepStrictEqual(r2['2'].map(x => x.plu), ['a', 'b']);
});
