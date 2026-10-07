'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { main } = require('../scripts/limpiar_esquema_canales');

const dirCon = archivos => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limpiar-esq-'));
  for (const [n, d] of Object.entries(archivos)) fs.writeFileSync(path.join(dir, n), JSON.stringify(d));
  return dir;
};
const leer = (dir, n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));

test('limpiar: backup una vez, saca lo muerto de los dos archivos y la segunda vez no toca nada', () => {
  const dir = dirCon({
    'costeo.json': { margenes: {}, costoHora: 4500, packBulto: { descPackPct: 9.7, vinculosManuales: {} } },
    'recetas_produccion.json': { insumosManuales: {}, productos: { 'p-a': { nombre: 'A', insumos: [], recetas: {}, presentaciones: {} } } },
  });
  const r1 = main(dir);
  assert.match(r1[0], /costeo\.json: limpio \(costoHora, packBulto\.descPackPct\)/);
  assert.match(r1[1], /recetas_produccion\.json: limpio/);
  assert.deepStrictEqual(leer(dir, 'costeo.json'), { margenes: {}, packBulto: { vinculosManuales: {} } });
  assert.deepStrictEqual(leer(dir, 'recetas_produccion.json'), { productos: { 'p-a': { nombre: 'A', recetas: {}, presentaciones: {} } } });
  assert.strictEqual(leer(dir, 'costeo.json.bak-limpieza-esquema').costoHora, 4500);
  assert.deepStrictEqual(main(dir), ['costeo.json: ya limpio', 'recetas_produccion.json: ya limpio']);
  assert.ok(!fs.existsSync(path.join(dir, 'costeo.json.tmp')));
});

test('limpiar: costeo.json sin migrar → error sin tocar nada; archivo ausente → aviso', () => {
  const dir = dirCon({ 'costeo.json': { costoHora: 1 } });
  assert.throws(() => main(dir), /migrar_esquema_canales/);
  assert.strictEqual(leer(dir, 'costeo.json').costoHora, 1);
  const vacio = dirCon({ 'costeo.json': { margenes: {} } });
  assert.deepStrictEqual(main(vacio), ['costeo.json: ya limpio', 'recetas_produccion.json: no existe, nada que limpiar']);
});
