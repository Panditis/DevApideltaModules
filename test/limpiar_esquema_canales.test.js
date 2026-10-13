'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { main } = require('../scripts/limpiar_esquema_canales');
const { migrarEsquemaCanales } = require('../lib/precios_config_esquema');

// costeo ya migrado por completo (lo que deja migrar_esquema_canales.js) + claves extra
const MIGRADO = migrarEsquemaCanales({}).costeo;

const dirCon = archivos => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limpiar-esq-'));
  for (const [n, d] of Object.entries(archivos)) fs.writeFileSync(path.join(dir, n), JSON.stringify(d));
  return dir;
};
const leer = (dir, n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));

test('limpiar: backup una vez, saca lo muerto de los dos archivos y la segunda vez no toca nada', () => {
  const dir = dirCon({
    'costeo.json': { ...MIGRADO, costoHora: 4500, packBulto: { descPackPct: 9.7, vinculosManuales: {} } },
    'recetas_produccion.json': { insumosManuales: {}, productos: { 'p-a': { nombre: 'A', insumos: [], recetas: {}, presentaciones: {} } } },
  });
  const r1 = main(dir);
  assert.match(r1[0], /costeo\.json: limpio \(packBulto\.descPackPct\)/);
  assert.match(r1[1], /recetas_produccion\.json: limpio/);
  // costoHora volvió (mano de obra de Producción, 2026-10-13): se conserva
  assert.deepStrictEqual(leer(dir, 'costeo.json'), { ...MIGRADO, costoHora: 4500, packBulto: { vinculosManuales: {} } });
  assert.deepStrictEqual(leer(dir, 'recetas_produccion.json'), { productos: { 'p-a': { nombre: 'A', recetas: {}, presentaciones: {} } } });
  assert.strictEqual(leer(dir, 'costeo.json.bak-limpieza-esquema').costoHora, 4500);
  assert.deepStrictEqual(main(dir), ['costeo.json: ya limpio', 'recetas_produccion.json: ya limpio']);
  assert.ok(!fs.existsSync(path.join(dir, 'costeo.json.tmp')));
});

test('limpiar: costeo.json sin migrar → error sin tocar nada; archivo ausente → aviso', () => {
  const dir = dirCon({ 'costeo.json': { costoHora: 1 } });
  assert.throws(() => main(dir), /migrar_esquema_canales/);
  assert.strictEqual(leer(dir, 'costeo.json').costoHora, 1);
  const vacio = dirCon({ 'costeo.json': MIGRADO });
  assert.deepStrictEqual(main(vacio), ['costeo.json: ya limpio', 'recetas_produccion.json: no existe, nada que limpiar']);
});

test('limpiar: costeo.json a medio migrar (margenes de un tipo por la config) → error y nada se borra', () => {
  const parcial = { margenes: { almacen: {} }, curvaGanancia: {}, marcadosExportar: { 1: '2026-10-01' } };
  const dir = dirCon({ 'costeo.json': parcial });
  assert.throws(() => main(dir), /migrar_esquema_canales/);
  assert.deepStrictEqual(leer(dir, 'costeo.json'), parcial);
  assert.ok(!fs.existsSync(path.join(dir, 'costeo.json.bak-limpieza-esquema')));
});

test('limpiar: conserva lo que volvió el 2026-10-13 (costoHora, insumos y minutosPorUnidad de presentaciones y PLUs envasados)', () => {
  const recetas = { productos: {
    'p-a': { nombre: 'A', recetas: { base: { nombre: 'B', rendimientoKg: 1, materiasPrimas: [{ plu: '1', cantidad: 1 }] } },
      presentaciones: { 7: { recetaId: 'base', kgPorUnidad: 1, insumos: [{ plu: '9', cantidad: 1 }], minutosPorUnidad: 2 } } },
    'p-m': { tipo: 'envasado', familia: 'Miel', nombre: 'P', granelPlu: '5', presentaciones: { 8: { kgPorUnidad: 1, componentes: [], minutosPorUnidad: 1 } } },
  } };
  const dir = dirCon({ 'costeo.json': { ...MIGRADO, costoHora: 8268 }, 'recetas_produccion.json': recetas });
  assert.deepStrictEqual(main(dir), ['costeo.json: ya limpio', 'recetas_produccion.json: ya limpio']);
  assert.deepStrictEqual(leer(dir, 'recetas_produccion.json'), recetas);
  assert.strictEqual(leer(dir, 'costeo.json').costoHora, 8268);
});
