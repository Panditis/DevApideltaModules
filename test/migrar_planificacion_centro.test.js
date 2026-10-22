'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../scripts/migrar_planificacion_centro');

test('migra grupos_config, crea graneles_base, hace backup y es idempotente', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrar-centro-'));
  try {
    const cfgPath = path.join(dir, 'grupos_config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ A: { activo: true, granelPlu: '7', reqGranel: true }, B: false }));
    assert.match(main(dir), /migrado/);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.strictEqual(cfg.A.tipo, 'granel');
    assert.strictEqual(cfg.B.estado, 'discontinuado');
    assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'graneles_base.json'), 'utf8'))), ['7']);
    assert.ok(fs.existsSync(`${cfgPath}.bak-planificacion-centro`));
    assert.match(main(dir), /sin cambios/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sin grupos_config.json tira error claro', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrar-centro-'));
  try { assert.throws(() => main(dir), /no existe/); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
