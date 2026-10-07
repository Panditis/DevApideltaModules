'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { main } = require('../scripts/migrar_esquema_canales');

const VIEJO = { toleranciaPct: 3, gastosVenta: [{ id: 'flete', concepto: 'Flete', pct: 1, listas: ['sucursal'] }],
  marcadosExportar: { 7: '2026-10-01' } };

test('script: backup del original, escribe lo migrado y la segunda corrida no cambia nada', () => {
  const ruta = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'esq-mig-')), 'costeo.json');
  fs.writeFileSync(ruta, JSON.stringify(VIEJO));
  assert.match(main(ruta), /^migrado: /);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(`${ruta}.bak-esquema-canales`, 'utf8')), VIEJO);
  const migrado = JSON.parse(fs.readFileSync(ruta, 'utf8'));
  assert.ok(migrado.margenes && migrado.redondeo);
  assert.deepStrictEqual(migrado.decisiones, { 7: { fuente: 'sistema', fecha: '2026-10-01' } });
  assert.strictEqual(main(ruta), 'ya migrado: sin cambios');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(ruta, 'utf8')), migrado);
});

test('script: archivo inexistente o roto → error, no escribe nada', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esq-mig-'));
  assert.throws(() => main(path.join(dir, 'no.json')), /no existe/);
  const roto = path.join(dir, 'costeo.json');
  fs.writeFileSync(roto, '{ roto');
  assert.throws(() => main(roto));
  assert.strictEqual(fs.existsSync(`${roto}.bak-esquema-canales`), false);
  assert.strictEqual(fs.readFileSync(roto, 'utf8'), '{ roto');
});
