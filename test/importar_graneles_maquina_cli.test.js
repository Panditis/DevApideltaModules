'use strict';
// E/S del CLI scripts/importar_graneles_maquina.js sobre un costeo temporal (--costeo); nunca toca data/costeo.json.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const XLSX = require('xlsx');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'importar_graneles_maquina.js');

const dirs = [];
test.after(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));

function entorno(maquinas = [{ id: 'm1' }]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-graneles-'));
  dirs.push(dir);
  const costeo = path.join(dir, 'costeo.json');
  fs.writeFileSync(costeo, JSON.stringify({ fraccionado: { maquinas, porGranel: { 7: { maquinaId: 'm1' } } } }, null, 2));
  const xlsx = path.join(dir, 'p.xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ Codigo: '0010', Maquina: 's' }, { Codigo: '5', Maquina: 'x' }]), 'Graneles');
  XLSX.writeFile(wb, xlsx);
  return { dir, costeo, xlsx };
}
const correr = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8' });
const archivos = dir => fs.readdirSync(dir).sort();

test('sin --aplicar no escribe nada', () => {
  const e = entorno();
  const antes = fs.readFileSync(e.costeo, 'utf8');
  const r = correr(e.xlsx, '--costeo', e.costeo);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /VISTA PREVIA/);
  assert.strictEqual(fs.readFileSync(e.costeo, 'utf8'), antes);
  assert.deepStrictEqual(archivos(e.dir), ['costeo.json', 'p.xlsx']);
});

test('--aplicar crea backup, escribe, no deja .tmp; segunda corrida idempotente', () => {
  const e = entorno();
  const antes = fs.readFileSync(e.costeo, 'utf8');
  const r = correr(e.xlsx, '--aplicar', '--costeo', e.costeo);
  assert.strictEqual(r.status, 0, r.stderr);
  const baks = archivos(e.dir).filter(f => f.startsWith('costeo.json.bak-'));
  assert.strictEqual(baks.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(e.dir, baks[0]), 'utf8'), antes);
  assert.ok(!fs.existsSync(`${e.costeo}.tmp`));
  const c = JSON.parse(fs.readFileSync(e.costeo, 'utf8'));
  assert.deepStrictEqual(c.fraccionado.porGranel, { 10: { maquinaId: 'm1', envase: 'bobina' } });
  assert.deepStrictEqual(c.activoGranel, { 5: false });

  const despues = fs.readFileSync(e.costeo, 'utf8');
  const r2 = correr(e.xlsx, '--aplicar', '--costeo', e.costeo);
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /cambian: 0/);
  assert.match(r2.stdout, /sin cambios/);
  assert.strictEqual(fs.readFileSync(e.costeo, 'utf8'), despues);
  assert.strictEqual(archivos(e.dir).filter(f => f.includes('.bak-')).length, 1);
});

for (const [n, ms] of [[0, []], [2, [{ id: 'a' }, { id: 'b' }]]]) {
  test(`${n} máquinas → error claro, exit 1, no escribe`, () => {
    const e = entorno(ms);
    const antes = fs.readFileSync(e.costeo, 'utf8');
    const r = correr(e.xlsx, '--aplicar', '--costeo', e.costeo);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, new RegExp(`una sola máquina.*hay ${n}`));
    assert.strictEqual(fs.readFileSync(e.costeo, 'utf8'), antes);
    assert.deepStrictEqual(archivos(e.dir), ['costeo.json', 'p.xlsx']);
  });
}

test('xlsx inexistente → error claro, exit 1', () => {
  const e = entorno();
  const r = correr(path.join(e.dir, 'no.xlsx'), '--aplicar', '--costeo', e.costeo);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no existe la planilla/);
  const r2 = correr('--costeo', e.costeo);
  assert.match(r2.stderr, /falta la ruta/);
});
