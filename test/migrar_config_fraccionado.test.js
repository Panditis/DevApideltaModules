'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { main } = require('../scripts/migrar_config_fraccionado');

const TABLA = { minPct: 30, maxPct: 60, escalones: 4, rango: { desde: 100, hasta: 10000 } };
const COSTEO = { gastosVenta: [], extrasMinorista: [], margenes: { minorista: TABLA, pack: TABLA, bulto: TABLA }, decisiones: {} };

test('script: backup del original, agrega fraccionado y la segunda corrida no cambia nada', () => {
  const ruta = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-fracc-')), 'costeo.json');
  fs.writeFileSync(ruta, JSON.stringify(COSTEO));
  assert.match(main(ruta), /^migrado: fraccionado/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(`${ruta}.bak-config-fraccionado`, 'utf8')), COSTEO);
  const migrado = JSON.parse(fs.readFileSync(ruta, 'utf8'));
  assert.deepStrictEqual(migrado.fraccionado.margenes.minorista, TABLA);
  assert.strictEqual(main(ruta), 'ya migrado: sin cambios');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(ruta, 'utf8')), migrado);
});

test('script: archivo inexistente o sin esquema por canal → error, no escribe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-fracc-'));
  assert.throws(() => main(path.join(dir, 'no.json')), /no existe/);
  const ruta = path.join(dir, 'costeo.json');
  fs.writeFileSync(ruta, '{}');
  assert.throws(() => main(ruta), /migrar_esquema_canales/);
  assert.strictEqual(fs.readFileSync(ruta, 'utf8'), '{}');
  assert.ok(!fs.existsSync(`${ruta}.bak-config-fraccionado`));
});
